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
| **EVM (Base)** | **Solidity** | **42/42 tests, Base Sepolia LIVE** | **this repo** |

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

## Live deployment — Base Sepolia (mainnet-class L2)

Deployed 2026-09-01 from the proven x402-demo deploy path (solc + ethers +
`OPERATOR_KEY`):

- **SentinelVault**: [`0xc5B32919e70f0182d224632b113a1A3d9320859A`](https://base-sepolia.blockscout.com/address/0xc5B32919e70f0182d224632b113a1A3d9320859A) — deploy tx `0x9ef55715...`
- **SentinelOracle**: [`0xDA0751D82FD843F93e0027D4fD23400F054d564D`](https://base-sepolia.blockscout.com/address/0xDA0751D82FD843F93e0027D4fD23400F054d564D) — deploy tx `0x2bda1ef5...`
- **SentinelPayment**: [`0x610020338cC90240415E3CCb48bb3D950484e4E8`](https://base-sepolia.blockscout.com/address/0x610020338cC90240415E3CCb48bb3D950484e4E8) — deploy tx `0xb1b9b8c8...`
- Deployer / authority / teeWorker: `0xeD6533dB264c72c7Fe2E08bA7Ce554ABBE70F811`
- USDC (Base Sepolia): `0x036CbD53842c5426634e7929541eC2318f3dCF7e`

### On-chain verified flow (all real txs on Base Sepolia)

```
1. vault.init(authority, worker)        → success
2. vault.seal("github", "sk-test-123")  → tx 0x4ab3743697... / 0xb4d5a66f...
3. vault.recordProbe("github", 200)     → tx 0x5c5abef552... / 0x5be3f7f1...
4. vault.listProviders()                → github: isSealed=true, verdict=VALID
                                         groq/openrouter/openai: isSealed=false
5. vault.history()                      → [github, VALID, http=200,
                                          detail="key accepted by provider"]
6. vault.vaultInfo()                    → (0xeD6533..., 0xeD6533..., 1)
7. oracle.init → submitAttestation(github, tdx, digest-abc123, epoch 0)
   → isVerified(github) = true
8. oracle.probe(github, 200)            → tx 0x05811594... ; on-chain event
   ProbeFired { provider: "github", httpCode: 200, epoch: 0, verdict: "VALID" }
   (log at 0xDA0751...: topic0 0x463b537b..., data decodes to github/200/0/VALID)
9. payment.init → configureProvider(github, payout, 100, paywalled=true)
10. USDC approve 100 → probeWithPayment(github, 200, "paid-probe-ok", 100)
    → tx 0x9df99370... ; payment history[0] = {github, VALID, paid=100}
    payout USDC balance 508,479,837 → 508,480,037 (+100)
11. ACL negative: recordProbe("nope") → reverted (UnknownProvider)
```

## Reproduce

```bash
# 1. env: copy OPERATOR_KEY (Base Sepolia funded) + RPC from x402-demo/.env
cp ../x402-demo/.env .env

# 2. deploy
npm run deploy          # deploys all 3, writes deployed.json

# 3. verify the full flow on-chain
node scripts/verify.js  # idempotent — safe to re-run
```

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
  deploy.js               # solc+ethers deploy to Base Sepolia
  verify.js               # idempotent on-chain verification
```

## License

MIT
