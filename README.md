# t3n-sentinel-evm

**EVM (Solidity) port of t3n-sentinel — the "one architecture, N chains" agent key
vault & health sentinel.** Chain #6 in the portfolio:

| Chain | Language | Status | Repo |
|---|---|---|---|
| T3N (TEE) | WASM | **LIVE** (contract id 741) | `t3n-sentinel` |
| Solana | Anchor (Rust) | 20/20 tests, SBF built, local-validator verified | `t3n-sentinel-solana` |
| Starknet | Cairo | 43/43 tests, Sepolia live | `t3n-sentinel-starknet` |
| Stellar | Soroban | 51/51 tests, testnet live | `t3n-sentinel-soroban` |
| Aptos | Move | 42/42 tests, localnet verified | `t3n-sentinel-aptos` |
| **EVM (Base)** | **Solidity** | **42/42 tests, Base mainnet + Sepolia LIVE** | **this repo** |

---

## What it is

A private API-key vault & health sentinel for AI agents. The T3N reference
implementation runs inside a TEE (contract id 741 on T3N testnet) and holds an
agent's API keys; this port reproduces the exact same contract surface in EVM
Solidity:

- **`SentinelVault`** — ACL'd vault (authority seals/rotates keys, a registered
  TEE worker records probe results), append-only ring-buffer history (16 entries),
  HTTP-status classifier, and a `listProviders` snapshot.
- **`SentinelOracle`** — operator-gated TEE attestation oracle. The off-chain
  verifier (Phala / Nillion / TDX / SGX) submits a validated attestation digest;
  the contract enforces a **per-epoch replay guard** and emits a `ProbeFired`
  event only for verified providers.
- **`SentinelPayment`** — USDC/ERC20 (or native ETH) micropayment rail.
  Per-provider payout address + price (base units) + paywalled flag. When
  paywalled, the probe is only recorded **after** the transfer succeeds —
  "no probe without payment when paywalled" holds by construction.

## Security model

1. Key material (the encrypted blob) is stored per (vault, provider). The real
   key lives inside the TEE worker; the contract holds the access policy + audit log.
2. The registered `teeWorker` is the ONLY caller authorized to `recordProbe`
   (verified on-chain: non-worker calls revert with `NotTeeWorker`).
3. `history` is an append-only ring buffer capped at 16 (matches all ports).
4. Probe functions NEVER return the API key — only the verdict
   (`VALID | INVALID | RATE_LIMITED | UNEXPECTED`).

## Test suite

```bash
npm install
npx hardhat test
```

```
42 passing (844ms)
```

| Module | Tests | Coverage |
|---|---|---|
| `SentinelVault` | 20 | init/ACL, seal (authority-gated, unknown-provider, empty-secret reverts), recordProbe (classify 200/401/429/500, custom detail, worker-only, unknown-provider), ring-buffer cap 16, listProviders, rotate, getSecret, classify units |
| `SentinelOracle` | 11 | init, submitAttestation (operator-gated, stale-epoch, replay, unknown-type reverts), probe (verified emits ProbeFired / unverified reverts), rotateEpoch invalidation, isVerified, attestationDigest |
| `SentinelPayment` | 11 | init, configureProvider (authority-gated, unknown-provider), free probe, paywalled probe (without payment reverts PaywallRequired, wrong amount reverts PaymentMismatch, exact USDC payment succeeds + transfers) |

## Live deployment

**Base mainnet (LIVE, 2026-09-01)** — deployed from the proven x402-demo deploy
path (solc + ethers + `OPERATOR_KEY`):

- **SentinelVault**: [`0x21CD456267da9e0836b8F8bbD68FfB93fe0da146`](https://base.blockscout.com/address/0x21CD456267da9e0836b8F8bbD68FfB93fe0da146) — deploy tx `0x420731db...`
- **SentinelOracle**: [`0x4fA2b93121479D2D7C1eD68da3cbB9D16E51c99B`](https://base.blockscout.com/address/0x4fA2b93121479D2D7C1eD68da3cbB9D16E51c99B) — deploy tx `0xf0aaf5cb...`
- **SentinelPayment**: [`0x40B98Ae8268270645081C5Fd738948869f27f826`](https://base.blockscout.com/address/0x40B98Ae8268270645081C5Fd738948869f27f826) — deploy tx `0xbe58c219...`
- Deployer / authority / teeWorker: `0xeD6533dB264c72c7Fe2E08bA7Ce554ABBE70F811`
- USDC (Base mainnet, Circle): `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- Payment rail on mainnet initialized with **native ETH** (token = address(0)) —
  a real value-transfer micropayment probe was verified on-chain.

**Base Sepolia (testnet, 2026-09-01)** — original deploy:

- **SentinelVault**: [`0xc5B32919e70f0182d224632b113a1A3d9320859A`](https://base-sepolia.blockscout.com/address/0xc5B32919e70f0182d224632b113a1A3d9320859A) — deploy tx `0x9ef55715...`
- **SentinelOracle**: [`0xDA0751D82FD843F93e0027D4fD23400F054d564D`](https://base-sepolia.blockscout.com/address/0xDA0751D82FD843F93e0027D4fD23400F054d564D) — deploy tx `0x2bda1ef5...`
- **SentinelPayment**: [`0x610020338cC90240415E3CCb48bb3D950484e4E8`](https://base-sepolia.blockscout.com/address/0x610020338cC90240415E3CCb48bb3D950484e4E8) — deploy tx `0xb1b9b8c8...`
- USDC (Base Sepolia): `0x036CbD53842c5426634e7929541eC2318f3dCF7e`

### On-chain verified flow (all real txs)

**Base mainnet** (2026-09-01):

```
1. vault.init(authority, worker)        → tx 0xca4bd274...
2. vault.seal("github", sk-mainnet-*)   → tx 0x3b3ba871...
3. vault.recordProbe("github", 200)     → tx 0x1677f93b... (block 50757427)
4. vault.listProviders()                → github: isSealed=true, verdict=VALID
5. vault.history()                      → [github, VALID, http=200,
                                          detail="key accepted by provider"]
6. oracle.init → submitAttestation(github, tdx, digest-*, epoch 0)
   → isVerified(github) = true
7. oracle.probe(github, 200)            → tx 0x951a1e17... (block 50757433)
   → ProbeFired { provider: github, httpCode: 200, epoch: 0, verdict: "VALID" }
   (log at 0x4fA2b9...: topic0 0x463b537b...)
8. payment.init(…, token=0x0)           → native-ETH rail (mainnet)
9. payment.configureProvider(github, payout, 0.0001 ETH, paywalled=true)
10. probeWithPayment(github, 200, "paid-probe-ok-mainnet", 0.0001 ETH, {value})
    → tx 0x9f5b15f8... (block 50757446) ; payment history[0] = {github, VALID,
    paid=100000000000000} ; payout ETH balance 0 → 0.0001 (+0.0001 ETH verified)
11. ACL negative: recordProbe("nope")   → reverted (UnknownProvider)
```

**Base Sepolia** (2026-09-01, original): the same flow with USDC — see
`deployed.sepolia.json` + the verify transcript in the commit history.

## Reproduce

```bash
# 1. env: copy OPERATOR_KEY (funded) + RPC from x402-demo/.env
cp ../x402-demo/.env .env

# 2. choose chain: Sepolia (default) or mainnet
#    RPC_URL=https://mainnet.base.org  → mainnet (chainId 8453, mainnet USDC)
#    RPC_URL=https://sepolia.base.org  → Sepolia (chainId 84532)

# 3. deploy
npm run deploy          # deploys all 3, writes deployed.json

# 4. verify the full flow on-chain
node scripts/verify.js  # idempotent — safe to re-run
```

The deploy/verify scripts auto-detect the chain from `RPC_URL`: mainnet uses
Circle USDC + native-ETH payment rail; Sepolia uses the test USDC. Reads wait
for the receipt block to settle ~3 blocks behind `latest` (public RPC read
nodes lag the miner node — a naive `latest` read right after a tx can miss
it).

See `scripts/deploy.js` + `scripts/verify.js` for the complete sequence.

## Layout

```
contracts/
  SentinelVault.sol       # ACL'd vault, ring-buffer history
  SentinelOracle.sol      # operator-gated attestation oracle + ProbeFired event
  SentinelPayment.sol     # USDC/ETH micropayment rail
  mocks/MockUSDC.sol      # test token (6 decimals)
test/
  SentinelVault.test.js   # 20 tests
  SentinelOracle.test.js  # 11 tests
  SentinelPayment.test.js # 11 tests
scripts/
  deploy.js               # solc+ethers deploy (chain auto-detect)
  verify.js               # idempotent on-chain verification
deployed.json             # current chain (mainnet) addresses
deployed.sepolia.json     # Base Sepolia addresses (preserved)
```

## License

MIT
