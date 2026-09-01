// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title SentinelVault
 * @notice Private API-key vault & health sentinel for AI agents (EVM port).
 *
 * This contract is the EVM (Solidity) port of the T3N TEE WASM contract of the
 * same name (t3n-sentinel, contract id 741 on T3N testnet), and mirrors the
 * Solana Anchor, Starknet Cairo, Stellar Soroban and Aptos Move ports. The API
 * shape is identical (init / seal / record_probe / list_providers / rotate /
 * history / get_secret / vault_info); the storage model moves from a host-bound
 * KV map to EVM contract storage.
 *
 * SECURITY MODEL
 * ==============
 * 1. Key material (the encrypted blob) is stored per (vault, provider) in the
 *    `secrets` mapping. The actual key material is held by a TEE worker
 *    registered in the contract; the contract holds the access policy and the
 *    audit log.
 * 2. A `teeWorker` address is the ONLY caller authorized to invoke
 *    `recordProbe` (the off-chain TEE adapter that does the HTTP probe).
 * 3. `history` is an append-only ring buffer (HISTORY_MAX = 16 entries).
 * 4. The probe functions NEVER return the API key — only the verdict
 *    (VALID | INVALID | RATE_LIMITED | UNEXPECTED), matching the T3N egress
 *    shape exactly.
 *
 * MAINTENANCE CONTRACT
 * ====================
 * Adding a new provider = appending ONE entry to `providers`.
 * No schema migration, no client update. (Same as the other five ports.)
 */
contract SentinelVault {
    /// Ring-buffer capacity — matches HISTORY_MAX in all other ports (16).
    uint256 public constant HISTORY_MAX = 16;

    /// Known providers. Endpoints are informational registry data (the actual
    /// HTTP probing happens inside the TEE worker off-chain).
    string[] public providers = ["github", "groq", "openrouter", "openai"];

    struct SecretEntry {
        string provider;
        string secretBlob;
        uint256 sealedAt;
    }

    struct ProbeReceipt {
        string provider;
        string verdict; // VALID | INVALID | RATE_LIMITED | UNEXPECTED
        uint256 httpCode;
        string detail;
        uint256 checkedAt;
    }

    struct ProviderRow {
        string provider;
        bool isSealed;
        ProbeReceipt lastVerdict;
        bool hasVerdict;
    }

    address public authority;
    address public teeWorker;
    bool public initialized;
    mapping(string => SecretEntry) private secrets;
    ProbeReceipt[] private _history;
    uint256 private historyCount;

    event Sealed(string indexed provider, uint256 sealedAt);
    event ProbeRecorded(string indexed provider, string verdict, uint256 httpCode, uint256 checkedAt);
    event VaultInitialized(address indexed authority, address indexed teeWorker);

    error NotInitialized();
    error AlreadyInitialized();
    error NotAuthority();
    error NotTeeWorker();
    error UnknownProvider(string provider);
    error EmptySecret();
    error NotSealed(string provider);

    /// One-time vault setup. Registers the vault authority and the off-chain
    /// TEE worker that is authorized to write probe receipts.
    function init(address _authority, address _teeWorker) external {
        if (initialized) revert AlreadyInitialized();
        authority = _authority;
        teeWorker = _teeWorker;
        initialized = true;
        emit VaultInitialized(_authority, _teeWorker);
    }

    /// Write a new API key (encrypted blob) into the vault under `provider`.
    /// Only the vault authority may seal. Reverts on unknown provider or empty
    /// key.
    function seal(string calldata provider, string calldata secretBlob) external {
        _requireInitialized();
        _requireAuthority();
        _requireKnownProvider(provider);
        if (bytes(secretBlob).length == 0) revert EmptySecret();
        secrets[provider] = SecretEntry(provider, secretBlob, block.timestamp);
        emit Sealed(provider, block.timestamp);
    }

    /// Called by the registered TEE worker after running the authenticated
    /// HTTP probe off-chain. Classifies the HTTP status and appends a
    /// ProbeReceipt into the history ring buffer.
    function recordProbe(string calldata provider, uint256 httpCode, string calldata detail) external {
        _requireInitialized();
        if (msg.sender != teeWorker) revert NotTeeWorker();
        _requireKnownProvider(provider);

        (string memory verdict, string memory defaultDetail) = classify(httpCode);
        string memory detailFinal = bytes(detail).length == 0 ? defaultDetail : detail;
        ProbeReceipt memory receipt = ProbeReceipt(provider, verdict, httpCode, detailFinal, block.timestamp);

        if (_history.length >= HISTORY_MAX) {
            // drop oldest (front)
            for (uint256 i = 1; i < _history.length; i++) {
                _history[i - 1] = _history[i];
            }
            _history.pop();
        }
        _history.push(receipt);
        historyCount = _history.length;
        emit ProbeRecorded(provider, verdict, httpCode, block.timestamp);
    }

    /// Snapshot of which providers are sealed, plus the last verdict for each.
    function listProviders() external view returns (ProviderRow[] memory) {
        _requireInitialized();
        ProviderRow[] memory rows = new ProviderRow[](providers.length);
        for (uint256 i = 0; i < providers.length; i++) {
            string memory name = providers[i];
            SecretEntry storage s = secrets[name];
            bool isSealed = bytes(s.secretBlob).length > 0;
            (ProbeReceipt memory last, bool has) = _lastVerdict(name);
            rows[i] = ProviderRow(name, isSealed, last, has);        }
        return rows;
    }

    /// Seal a new blob over an existing provider entry. Same ACL as `seal`.
    function rotate(string calldata provider, string calldata newBlob) external {
        _requireInitialized();
        _requireAuthority();
        _requireKnownProvider(provider);
        if (bytes(newBlob).length == 0) revert EmptySecret();
        if (bytes(secrets[provider].secretBlob).length == 0) revert NotSealed(provider);
        secrets[provider] = SecretEntry(provider, newBlob, block.timestamp);
        emit Sealed(provider, block.timestamp);
    }

    /// Return the ring buffer's entries, newest first.
    function history() external view returns (ProbeReceipt[] memory) {
        _requireInitialized();
        ProbeReceipt[] memory out = new ProbeReceipt[](_history.length);
        for (uint256 i = 0; i < _history.length; i++) {
            out[i] = _history[_history.length - 1 - i];
        }
        return out;
    }

    /// Fetch the encrypted blob for a provider. Only the registered TEE worker
    /// may read blobs.
    function getSecret(string calldata provider) external view returns (string memory) {
        _requireInitialized();
        if (msg.sender != teeWorker) revert NotTeeWorker();
        _requireKnownProvider(provider);
        if (bytes(secrets[provider].secretBlob).length == 0) revert NotSealed(provider);
        return secrets[provider].secretBlob;
    }

    /// authority + teeWorker + sealed count (read-only).
    function vaultInfo() external view returns (address, address, uint256) {
        _requireInitialized();
        uint256 count = 0;
        for (uint256 i = 0; i < providers.length; i++) {
            if (bytes(secrets[providers[i]].secretBlob).length > 0) count++;
        }
        return (authority, teeWorker, count);
    }

    /// Map an HTTP status to a verdict. Same shape as the other ports.
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

    /// Is this provider in the registry?
    function isKnownProvider(string calldata provider) external view returns (bool) {
        for (uint256 i = 0; i < providers.length; i++) {
            if (keccak256(bytes(providers[i])) == keccak256(bytes(provider))) return true;
        }
        return false;
    }

    /// Number of probe receipts in the ring buffer.
    function historyLength() external view returns (uint256) {
        return _history.length;
    }

    // --- internal ---

    function _requireInitialized() internal view {
        if (!initialized) revert NotInitialized();
    }

    function _requireAuthority() internal view {
        if (msg.sender != authority) revert NotAuthority();
    }

    function _requireKnownProvider(string calldata provider) internal view {
        for (uint256 i = 0; i < providers.length; i++) {
            if (keccak256(bytes(providers[i])) == keccak256(bytes(provider))) return;
        }
        revert UnknownProvider(provider);
    }

    function _lastVerdict(string memory provider) internal view returns (ProbeReceipt memory, bool) {
        for (uint256 i = _history.length; i > 0; i--) {
            ProbeReceipt storage r = _history[i - 1];
            if (keccak256(bytes(r.provider)) == keccak256(bytes(provider))) {
                return (r, true);
            }
        }
        return (ProbeReceipt("", "", 0, "", 0), false);
    }
}
