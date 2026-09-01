# t3n-sentinel-evm — PROJECT.md

**What it is:** EVM (Solidity) port of t3n-sentinel — the private API-key vault &
health sentinel for AI agents. Chain #6 of the "one architecture, N chains"
portfolio (T3N WASM → Solana Anchor → Starknet Cairo → Stellar Soroban → Aptos
Move → **EVM/Base**).

**Repo:** https://github.com/shojaee76-cmyk/t3n-sentinel-evm (public, MIT)

## Status: M1 COMPLETE — 42/42 tests, Base Sepolia LIVE + on-chain verified

## Contracts
- `SentinelVault` — ACL'd vault, 16-entry ring-buffer history, classifier
- `SentinelOracle` — operator-gated attestation oracle, per-epoch replay guard,
  `ProbeFired` event
- `SentinelPayment` — USDC/ETH micropayment rail (payout/price/paywalled),
  atomic transfer-before-receipt
- `mocks/MockUSDC` — test token (6 decimals)

## Verification evidence
- **42/42 hardhat tests green** (vault 20, oracle 11, payment 11)
- **Base Sepolia deployed** (2026-09-01, solc+ethers, operator 0xeD6533dB...):
  - Vault: `0xc5B32919e70f0182d224632b113a1A3d9320859A` (tx 0x9ef55715...)
  - Oracle: `0xDA0751D82FD843F93e0027D4fD23400F054d564D` (tx 0x2bda1ef5...)
  - Payment: `0x610020338cC90240415E3CCb48bb3D950484e4E8` (tx 0xb1b9b8c8...)
  - USDC: `0x036CbD53842c5426634e7929541eC2318f3dCF7e`
- **On-chain verified flow** (real txs, blockscout links in README):
  - `seal(github, sk-test-123)` → `recordProbe(github, 200)` →
    `listProviders` github isSealed=true verdict=VALID →
    `history[0]` {github, VALID, 200, "key accepted by provider"}
  - oracle: `submitAttestation` → `isVerified=true` → `probe` → **ProbeFired
    event** (log topic 0x463b537b..., decodes github/200/0/VALID)
  - payment: `configureProvider` (paywalled, 100) → USDC approve →
    `probeWithPayment` → payment history paid=100, payout balance +100
  - ACL negative: `recordProbe(nope)` reverted (UnknownProvider)

## Deploy path
- Proven x402-demo path: **solc + ethers + OPERATOR_KEY** from x402-demo/.env
  (0.048 ETH on Base Sepolia). No faucet walls — the wallet was funded via the
  x402-demo flow.
- `npm run deploy` (scripts/deploy.js) → `node scripts/verify.js` (idempotent).
- Hardhat for tests only; deploy uses solc directly.

## Grant
- Base Builder Grant draft: `bounty-lab/drafts/base-builder-grant-t3n-sentinel-evm.md`
  ($1-5k ETH, retroactive, NOT submitted — user opens the form)
- Arbitrum / Circle drafts can reuse the same EVM evidence

## Progress log
- 2026-09-01 — **M1 COMPLETE**. EVM port written (3 contracts + MockUSDC).
  Debugged: `sealed` is a reserved Solidity keyword (field + local var → isSealed),
  `history` state var clashes with `history()` function → `_history`. 42/42
  hardhat tests green. Deployed all 3 to Base Sepolia via solc+ethers (x402-demo
  path). Full on-chain verification: vault flow (seal→probe→list→history),
  oracle (attestation→isVerified→ProbeFired event confirmed from receipt logs),
  payment (paywalled USDC probe, payout balance +100), ACL negative revert.
  README + LICENSE + deploy/verify scripts. Repo pushed public via Contents API
  (14 files). Base Builder Grant draft written.
