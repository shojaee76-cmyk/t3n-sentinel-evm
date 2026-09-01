// Deploy SentinelVault + SentinelOracle + SentinelPayment to Base Sepolia.
// Reuses the x402-demo proven path: solc + ethers + OPERATOR_KEY from .env.
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { JsonRpcProvider, Wallet, ContractFactory } = require("ethers");
const solc = require("solc");

const RPC_URL = process.env.RPC_URL || "https://sepolia.base.org";
const USDC = process.env.USDC_ADDRESS || "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // Base Sepolia USDC

function compile(contractName) {
  const src = fs.readFileSync(path.join(__dirname, "..", "contracts", `${contractName}.sol`), "utf8");
  const input = {
    language: "Solidity",
    sources: { [`${contractName}.sol`]: { content: src } },
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  if (out.errors && out.errors.some((e) => e.severity === "error")) {
    throw new Error("Compile errors: " + JSON.stringify(out.errors.filter((e) => e.severity === "error")));
  }
  return out.contracts[`${contractName}.sol`][contractName];
}

async function main() {
  const key = process.env.OPERATOR_KEY;
  if (!key) throw new Error("OPERATOR_KEY missing in .env — copy from x402-demo/.env");
  const provider = new JsonRpcProvider(RPC_URL);
  const op = new Wallet(key, provider);
  const bal = await provider.getBalance(op.address);
  console.log(`operator ${op.address} — ETH ${Number(bal) / 1e18}`);
  if (bal < 1000000000000000n) throw new Error("operator has no gas on Base Sepolia");

  const results = {};
  const order = ["SentinelVault", "SentinelOracle", "SentinelPayment"];

  for (const name of order) {
    const art = compile(name);
    const factory = new ContractFactory(art.abi, "0x" + art.evm.bytecode.object, op);
    console.log(`deploying ${name}...`);
    const c = await factory.deploy();
    const rc = await c.deploymentTransaction().wait();
    results[name] = { address: rc.contractAddress, tx: rc.hash, block: Number(rc.blockNumber) };
    console.log(`  ✅ ${name}: ${rc.contractAddress} (tx ${rc.hash} block ${rc.blockNumber})`);
  }

  // persist
  fs.writeFileSync(
    path.join(__dirname, "..", "deployed.json"),
    JSON.stringify({ chainId: Number((await provider.getNetwork()).chainId), deployer: op.address, usdc: USDC, at: new Date().toISOString(), ...results }, null, 2)
  );
  console.log("\nsaved deployed.json");
  console.log("vault:   https://base-sepolia.blockscout.com/address/" + results.SentinelVault.address);
  console.log("oracle:  https://base-sepolia.blockscout.com/address/" + results.SentinelOracle.address);
  console.log("payment: https://base-sepolia.blockscout.com/address/" + results.SentinelPayment.address);
}

main().catch((e) => { console.error("✗", e.message || e); process.exit(1); });
