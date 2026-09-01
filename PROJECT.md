# t3n-sentinel-evm — PROJECT.md

**What it is:** EVM (Solidity) port of t3n-sentinel — the private API-key vault &
health sentinel for AI agents. Chain #6 of the "one architecture, N chains"
portfolio (T3N WASM → Solana Anchor → Starknet Cairo → Stellar Soroban → Aptos
Move → **EVM/Base**).

**Repo:** https://github.com/shojaee76-cmyk/t3n-sentinel-evm (public, MIT)

## Status: M1+M2 COMPLETE — 42/42 tests, Base mainnet LIVE + Sepolia LIVE, on-chain verified

## Contracts
- `SentinelVault` — ACL'd vault, 16-entry ring-buffer history, classifier
- `SentinelOracle` — operator-gated attestation oracle, per-epoch replay guard,
  `ProbeFired` event
- `SentinelPayment` — USDC/ETH micropayment rail (payout/price/paywalled),
  atomic transfer-before-receipt
- `mocks/MockUSDC` — test token (6 decimals)

## Verification evidence
- **42/42 hardhat tests green** (vault 20, oracle 11, payment 11)
- **Base mainnet deployed** (2026-09-01, solc+ethers, operator 0xeD6533dB...):
  - Vault: `0x21CD456267da9e0836b8F8bbD68FfB93fe0da146` (tx 0x420731db...)
  - Oracle: `0x4fA2b93121479D2D7C1eD68da3cbB9D16E51c99B` (tx 0xf0aaf5cb...)
  - Payment: `0x40B98Ae8268270645081C5Fd738948869f27f826` (tx 0xbe58c219...)
  - USDC: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (Circle, mainnet)
  - Payment rail on mainnet = **native ETH** (token = address(0))
- **Base Sepolia deployed** (2026-09-01, solc+ethers, operator 0xeD6533dB...):
  - Vault: `0xc5B32919e70f0182d224632b113a1A3d9320859A` (tx 0x9ef55715...)
  - Oracle: `0xDA0751D82FD843F93e0027D4fD23400F054d564D` (tx 0x2bda1ef5...)
  - Payment: `0x610020338cC90240415E3CCb48bb3D950484e4E8` (tx 0xb1b9b8c8...)
  - USDC: `0x036CbD53842c5426634e7929541eC2318f3dCF7e`
- **On-chain verified flow** (real txs, blockscout links in README):
  - `seal(github, sk-mainnet-*)` → `recordProbe(github, 200)` →
    `listProviders` github isSealed=true verdict=VALID →
    `history[0]` {github, VALID, 200, "key accepted by provider"}
  - oracle: `submitAttestation` → `isVerified=true` → `probe` → **ProbeFired
    event** (log topic 0x463b537b..., decodes github/200/0/VALID)
  - payment (mainnet, native ETH): `configureProvider` (paywalled, 0.0001 ETH)
    → `probeWithPayment` {value: 0.0001 ETH} → payment history paid=0.0001 ETH,
    payout ETH balance 0 → 0.0001 (+0.0001 ETH verified)
  - ACL negative: `recordProbe(nope)` reverted (UnknownProvider)

## Deploy path
- Proven x402-demo path: **solc + ethers + OPERATOR_KEY** from x402-demo/.env
  (0.048 ETH on Base Sepolia). No faucet walls — the wallet was funded via the
  x402-demo flow.
- `npm run deploy` (scripts/deploy.js) → `node scripts/verify.js` (idempotent).
- Chain auto-detected from `RPC_URL`: `https://mainnet.base.org` (8453) or
  `https://sepolia.base.org` (84532). Mainnet USDC = Circle
  `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.
- Hardhat for tests only; deploy uses solc directly.

## Grant
- Base Builder Grant draft: `bounty-lab/drafts/base-builder-grant-t3n-sentinel-evm.md`
  ($1-5k ETH, retroactive, NOT submitted — user opens the form)
- Arbitrum / Circle drafts can reuse the same EVM evidence

## Progress log
- 2026-09-01 — **M2 COMPLETE — BASE MAINNET DEPLOY + FULL ON-CHAIN VERIFY**.
  Redeployed all 3 contracts to **Base mainnet** (chainId 8453) via the same
  solc+ethers path (RPC_URL=https://mainnet.base.org): vault
  `0x21CD456267da9e0836b8F8bbD68FfB93fe0da146`, oracle
  `0x4fA2b93121479D2D7C1eD68da3cbB9D16E51c99B`, payment
  `0x40B98Ae8268270645081C5Fd738948869f27f826`. Operator already held 0.0005
  ETH on mainnet → no bridge needed; total deploy+verify cost ≈ 0.00014 ETH.
  Full flow verified with real txs: vault seal→recordProbe(200)→listProviders
  (github VALID)→history; oracle submitAttestation→isVerified=true→probe→
  **ProbeFired event** (topic0 0x463b537b..., httpCode 200, epoch 0); payment
  rail initialized with **native ETH** (token=address(0)) → paywalled
  probeWithPayment with real 0.0001 ETH value transfer, payout balance 0→0.0001;
  ACL negative recordProbe(nope) reverted. Deploy+verify scripts now
  chain-generic (RPC auto-detect, mainnet USDC, native-ETH rail, read-at-settled-
  block to dodge public-RPC read lag). README + PROJECT.md updated with mainnet
  addresses; deployed.json = mainnet, deployed.sepolia.json preserved.
- 2026-09-01 — **M1 COMPLETE**. EVM port written (3 contracts + MockUSDC).
  Debugged: `sealed` is a reserved Solidity keyword (field + local var → isSealed),
  `history` state var clashes with `history()` function → `_history`. 42/42
  hardhat tests green. Deployed all 3 to Base Sepolia via solc+ethers (x402-demo
  path). Full on-chain verification: vault flow (seal→probe→list→history),
  oracle (attestation→isVerified→ProbeFired event confirmed from receipt logs),
  payment (paywalled USDC probe, payout balance +100), ACL negative revert.
  README + LICENSE + deploy/verify scripts. Repo pushed public via Contents API
  (14 files). Base Builder Grant draft written.
