// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title SentinelOracle
 * @notice TEE oracle adapter for t3n-sentinel (EVM port).
 *
 * The contract verifies a TEE attestation and emits a `ProbeFired` event only
 * when the attestation is valid. Pluggable for Phala, Nillion, and a generic
 * TDX/SGX attestation.
 *
 * This is the EVM mirror of the `sentinel_oracle` module of the T3N TEE
 * reference impl (contract id 741 on T3N testnet) and of the Solana/Starknet/
 * Soroban/Aptos ports. On-chain we do not verify the raw TEE quote (that
 * requires a verifier service); instead the contract:
 *   1. records the operator (who runs the off-chain verifier),
 *   2. accepts a submitted attestation payload and checks its structural
 *      validity (nonce replay guard, attestation format marker, expiry),
 *   3. keeps a per-epoch nonce/attestation registry so an attestation can
 *      never be replayed,
 *   4. emits `ProbeFired` only for valid attestations.
 */
contract SentinelOracle {
    struct ProviderState {
        string provider;
        bool verified;
        string attestationDigest;
        uint256 epoch;
    }

    address public operator;
    uint256 public epoch;
    bool public initialized;
    mapping(string => bool) private usedAttestations;
    mapping(string => ProviderState) private providerStates;
    string[] private knownTypes = ["phala", "nillion", "tdx", "sgx"];

    event OracleInitialized(address indexed operator);
    event AttestationAccepted(string indexed provider, string attestationType, string digest, uint256 epoch);
    event ProbeFired(string indexed provider, string verdict, uint256 httpCode, uint256 epoch);
    event EpochRotated(uint256 indexed newEpoch);

    error NotInitialized();
    error AlreadyInitialized();
    error NotOperator();
    error StaleEpoch(uint256 expected, uint256 got);
    error AttestationReplay(string digest);
    error UnknownAttestationType(string attestationType);
    error NotVerified(string provider);

    /// Create the oracle with `_operator` as the off-chain verifier address.
    function init(address _operator) external {
        if (initialized) revert AlreadyInitialized();
        operator = _operator;
        epoch = 0;
        initialized = true;
        emit OracleInitialized(_operator);
    }

    /// Operator submits a validated TEE attestation digest for a provider.
    /// Sets the provider's oracle state to verified for the current epoch.
    function submitAttestation(
        string calldata provider,
        string calldata attestationType,
        string calldata digest,
        uint256 _epoch
    ) external {
        _requireInitialized();
        if (msg.sender != operator) revert NotOperator();
        if (_epoch != epoch) revert StaleEpoch(epoch, _epoch);
        _requireKnownType(attestationType);
        if (usedAttestations[digest]) revert AttestationReplay(digest);
        usedAttestations[digest] = true;
        providerStates[provider] = ProviderState(provider, true, digest, _epoch);
        emit AttestationAccepted(provider, attestationType, digest, _epoch);
    }

    /// Called by the provider's TEE worker (or an agent acting on the
    /// provider's behalf) after a real HTTP probe. Emits `ProbeFired` only
    /// when the provider has a valid attestation for the current epoch.
    function probe(string calldata provider, uint256 httpCode, string calldata detail)
        external
        returns (string memory verdictOut)
    {
        _requireInitialized();
        ProviderState storage state = providerStates[provider];
        if (!state.verified || state.epoch != epoch) revert NotVerified(provider);

        (string memory verdict, string memory defaultDetail) = classify(httpCode);
        string memory detailFinal = bytes(detail).length == 0 ? defaultDetail : detail;
        emit ProbeFired(provider, verdict, httpCode, epoch);
        // Keep detail available to the caller (unused var is fine — it's the
        // human-readable description the off-chain verifier logs).
        if (bytes(detailFinal).length == 0) {} // noop — detail is informational
        return verdict;
    }

    /// Operator advances the epoch, invalidating all prior attestations.
    function rotateEpoch() external {
        _requireInitialized();
        if (msg.sender != operator) revert NotOperator();
        epoch += 1;
        emit EpochRotated(epoch);
        // Note: usedAttestations is NOT cleared (digests stay spent forever —
        // a replay guard that survives epoch rotation, strictly stronger than
        // the other ports which reset per-epoch).
    }

    /// Read-only: is the provider's TEE worker verified for the current epoch?
    function isVerified(string calldata provider) external view returns (bool) {
        _requireInitialized();
        ProviderState storage s = providerStates[provider];
        return s.verified && s.epoch == epoch;
    }

    /// The attestation digest accepted for a provider in the current epoch.
    function attestationDigest(string calldata provider) external view returns (string memory) {
        _requireInitialized();
        ProviderState storage s = providerStates[provider];
        if (s.verified && s.epoch == epoch) return s.attestationDigest;
        return "";
    }

    /// Map an HTTP status to a verdict. Same shape as the vault's classifier.
    function classify(uint256 code) public pure returns (string memory verdict, string memory detail) {
        if (code >= 200 && code <= 299) {
            return ("VALID", "key accepted by provider");
        } else if (code == 401 || code == 403) {
            return ("INVALID", "credentials rejected by provider");
        } else if (code == 429) {
            return ("RATE_LIMITED", "quota exhausted");
        } else {
            return ("UNEXPECTED", "unclassified status code");
        }
    }

    // --- internal ---

    function _requireInitialized() internal view {
        if (!initialized) revert NotInitialized();
    }

    function _requireKnownType(string calldata t) internal view {
        for (uint256 i = 0; i < knownTypes.length; i++) {
            if (keccak256(bytes(knownTypes[i])) == keccak256(bytes(t))) return;
        }
        revert UnknownAttestationType(t);
    }
}
