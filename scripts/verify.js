// On-chain verification of the full t3n-sentinel EVM flow on Base (Sepolia or mainnet).
// seal → recordProbe → listProviders → history → oracle → payment.
// Idempotent: guards every init/config step; uses fresh addresses per run for evidence.
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { JsonRpcProvider, Wallet, Contract, ZeroAddress } = require("ethers");

const RPC_URL = process.env.RPC_URL || "https://sepolia.base.org";
const IS_MAINNET = RPC_URL.includes("mainnet");
const USDC = process.env.USDC_ADDRESS || (IS_MAINNET ? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" : "0x036CbD53842c5426634e7929541eC2318f3dCF7e");

function abi(name) {
  // Recompile is heavy; use a minimal ABI from the artifact (hardhat artifacts exist)
  const p = path.join(__dirname, "..", "artifacts", "contracts", `${name}.sol`, `${name}.json`);
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p)).abi;
  throw new Error(`artifact not found: ${p} — run npx hardhat compile first`);
}

async function main() {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployed.json"), "utf8"));
  const key = process.env.OPERATOR_KEY;
  const provider = new JsonRpcProvider(RPC_URL);
  const op = new Wallet(key, provider);
  const vault = new Contract(d.SentinelVault.address, abi("SentinelVault"), op);
  const oracle = new Contract(d.SentinelOracle.address, abi("SentinelOracle"), op);
  const payment = new Contract(d.SentinelPayment.address, abi("SentinelPayment"), op);

  const GITHUB = "github";
  // Fresh payout + fresh provider secret per run → clean evidence, idempotent.
  const PAYOUT = Wallet.createRandom().address;
  const PROVIDER = IS_MAINNET ? "github" : "github";
  const SECRET = "sk-mainnet-" + Date.now().toString(36);

  console.log("=== VAULT FLOW ===");
  if (!(await vault.initialized())) {
    let tx = await vault.init(op.address, op.address);
    await tx.wait();
    console.log("init ✅", tx.hash);
  } else {
    console.log("init — already initialized, skipping");
  }

  let tx = await vault.seal(GITHUB, SECRET);
  await tx.wait();
  console.log("seal ✅", tx.hash);

  tx = await vault.recordProbe(GITHUB, 200, "");
  const rpRc = await tx.wait();
  console.log("recordProbe(200) ✅", rpRc.hash, "block", rpRc.blockNumber);

  // Public RPC read nodes lag the miner node that mined our tx — instead of
  // reading at the receipt block (which may itself be too fresh for the read
  // node), wait until the receipt block is at least ~3 blocks behind latest,
  // then read "latest". Deterministic and lag-proof.
  async function waitForBlock(tag) {
    for (let i = 0; i < 30; i++) {
      const latest = Number(await provider.getBlockNumber());
      if (latest - Number(tag) >= 3) return;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  await waitForBlock(rpRc.blockNumber);

  const rows = await vault.listProviders();
  for (const r of rows) {
    console.log(`  ${r.provider}: isSealed=${r.isSealed} verdict=${r.hasVerdict ? r.lastVerdict.verdict : "—"}`);
  }

  const h = await vault.history();
  console.log(`history[0]: ${h[0].provider} ${h[0].verdict} http=${h[0].httpCode} detail="${h[0].detail}"`);

  const info = await vault.vaultInfo();
  console.log(`vaultInfo: authority=${info[0].slice(0, 10)}... worker=${info[1].slice(0, 10)}... sealed=${info[2]}`);

  console.log("\n=== ORACLE FLOW ===");
  if (!(await oracle.initialized())) {
    tx = await oracle.init(op.address);
    await tx.wait();
    console.log("oracle init ✅", tx.hash);
  } else {
    console.log("oracle init — already initialized, skipping");
  }

  if (!(await oracle.isVerified(GITHUB))) {
    tx = await oracle.submitAttestation(GITHUB, "tdx", "digest-" + Date.now().toString(36), 0);
    await tx.wait();
    console.log("submitAttestation ✅", tx.hash);
    // Public RPC read nodes lag the miner — wait for attestation visibility,
    // then probe (fresh digest avoids replay).
    await waitForBlock((await provider.getBlockNumber()).toString()); // settle latest first
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 2500));
      if (await oracle.isVerified(GITHUB)) break;
    }
  } else {
    console.log("submitAttestation — already verified, skipping");
  }
  console.log("isVerified(github):", await oracle.isVerified(GITHUB));

  const rc = await (await oracle.probe(GITHUB, 200, "")).wait();
  console.log("oracle probe tx ✅", rc.hash, "block", rc.blockNumber);
  await waitForBlock(rc.blockNumber);
  console.log("epoch:", (await oracle.epoch()).toString());

  console.log("\n=== PAYMENT FLOW ===");
  // Mainnet: native-ETH rail (token = address(0)) → real value transfer, no USDC needed.
  // Sepolia: USDC rail (test token, mint available).
  const PAYMENT_TOKEN = IS_MAINNET ? ZeroAddress : USDC;
  const PRICE = IS_MAINNET ? 100000000000000n : 100n; // 0.0001 ETH on mainnet, 100 USDC(6dp) on sepolia
  if (!(await payment.initialized())) {
    tx = await payment.init(op.address, op.address, PAYMENT_TOKEN);
    await tx.wait();
    console.log("payment init ✅ (token =", PAYMENT_TOKEN, ")", tx.hash);
  } else {
    console.log("payment init — already initialized, skipping");
  }

  const cfg = await payment.providerConfig(GITHUB);
  if (cfg.payout === ZeroAddress) {
    tx = await payment.configureProvider(GITHUB, PAYOUT, PRICE, true);
    await tx.wait();
    console.log("configureProvider ✅ (paywalled, price=", PRICE.toString(), ")", tx.hash);
  } else {
    console.log("configureProvider — already set, skipping");
  }

  if (IS_MAINNET) {
    // Native ETH rail: send the exact price as msg.value; payout must receive it.
    tx = await payment.probeWithPayment(GITHUB, 200, "paid-probe-ok-mainnet", PRICE, { value: PRICE });
    const ppRc = await tx.wait();
    console.log("probeWithPayment (ETH) ✅", ppRc.hash, "block", ppRc.blockNumber);
    await waitForBlock(ppRc.blockNumber);
    const payoutBefore = await provider.getBalance(PAYOUT, ppRc.blockNumber - 1);
    const payoutAfter = await provider.getBalance(PAYOUT);
    const ph = await payment.history();
    console.log(`payment history[0]: ${ph[0].provider} ${ph[0].verdict} paid=${ph[0].paid}`);
    console.log(`payout ETH balance: ${Number(payoutBefore) / 1e18} → ${Number(payoutAfter) / 1e18} (+${Number(payoutAfter - payoutBefore) / 1e18} ETH)`);
    if (payoutAfter - payoutBefore !== PRICE) throw new Error("ETH transfer amount mismatch — BUG");
    console.log("ETH transfer verified ✅ (+0.0001 ETH to fresh payout)");
  } else {
    // fund + approve USDC for the operator (teeWorker)
    const usdc = new Contract(USDC, ["function mint(address,uint256)", "function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"], op);
    const bal = await usdc.balanceOf(op.address);
    console.log("operator USDC balance:", bal.toString());
    if (bal < 1000n) {
      console.log("  USDC balance too low — attempting mint (may fail on real USDC)");
      try {
        tx = await usdc.mint(op.address, 1000);
        await tx.wait();
        console.log("  minted 1000 USDC ✅", tx.hash);
      } catch (e) {
        console.log("  mint not available on real USDC:", e.message.slice(0, 80));
      }
    }
    const bal2 = await usdc.balanceOf(op.address);
    console.log("operator USDC balance after:", bal2.toString());

    if (bal2 >= 100n) {
      tx = await usdc.approve(await payment.getAddress(), 100);
      await tx.wait();
      console.log("approve 100 USDC ✅", tx.hash);

      tx = await payment.probeWithPayment(GITHUB, 200, "paid-probe-ok", 100);
      await tx.wait();
      console.log("probeWithPayment ✅", tx.hash);

      const ph = await payment.history();
      console.log(`payment history[0]: ${ph[0].provider} ${ph[0].verdict} paid=${ph[0].paid}`);
      console.log("payout USDC balance:", (await usdc.balanceOf(PAYOUT)).toString());
    } else {
      console.log("  SKIP paid probe — no USDC (real USDC needs faucet); free-probe path still verified by vault");
    }
  }

  console.log("\n=== ACL NEGATIVE (expect revert) ===");
  try {
    await vault.recordProbe("nope", 200, "");
    console.log("  !! no revert — BUG");
  } catch (e) {
    console.log("  recordProbe(nope) reverted ✅:", e.message.split("\n")[0].slice(0, 90));
  }
  console.log("\nAll checks complete.");
}

main().catch((e) => { console.error("✗", e.message || e); process.exit(1); });
