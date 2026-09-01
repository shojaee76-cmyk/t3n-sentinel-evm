// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title SentinelPayment
 * @notice ERC20/ETH micropayment rail for t3n-sentinel (EVM port).
 *
 * Every `probeWithPayment` call can atomically transfer a USDC (or any ERC20)
 * micropayment to the provider's payout address. Providers can opt into a
 * "paywalled" mode where a probe is only recorded after the transfer
 * succeeds — the invariant "no probe without payment when provider is
 * paywalled" holds by construction (the transfer happens BEFORE the receipt is
 * appended).
 *
 * Architecture: this contract extends the sentinel-vault flow with a payment
 * leg. The vault authority configures per-provider:
 *   - `payout`: the address that receives the micropayment,
 *   - `price`:  the per-probe price in token base units (USDC = 6 decimals),
 *               0 = free,
 *   - `paywalled`: whether payment is REQUIRED for a probe to be recorded.
 *
 * SECURITY MODEL
 * ==============
 * 1. Only the registered `teeWorker` may trigger a paid probe.
 * 2. Payment is ATOMIC with the probe: if the transfer fails (insufficient
 *    balance, token error), the receipt is NOT appended and the call reverts.
 * 3. The TEE worker pays from its own balance (same as the Aptos port — the
 *    caller funds the rail; the contract never holds funds).
 * 4. `probeWithPayment` NEVER returns the API key — only the verdict.
 */
contract SentinelPayment {
    uint256 public constant HISTORY_MAX = 16;

    string[] public providers = ["github", "groq", "openrouter", "openai"];

    struct ProviderConfig {
        string provider;
        address payout;
        uint256 price;
        bool paywalled;
    }

    struct ProbeReceipt {
        string provider;
        string verdict;
        uint256 httpCode;
        string detail;
        uint256 checkedAt;
        uint256 paid;
    }

    address public authority;
    address public teeWorker;
    bool public initialized;
    address public token; // ERC20 (USDC) — address(0) means native ETH
    mapping(string => ProviderConfig) private configs;
    ProbeReceipt[] private _history;

    event PaymentInitialized(address indexed authority, address indexed teeWorker, address token);
    event ProviderConfigured(string indexed provider, address payout, uint256 price, bool paywalled);
    event PaidProbeRecorded(string indexed provider, string verdict, uint256 httpCode, uint256 paid);

    error NotInitialized();
    error AlreadyInitialized();
    error NotAuthority();
    error NotTeeWorker();
    error UnknownProvider(string provider);
    error PaymentMismatch(uint256 expected, uint256 got);
    error PaywallRequired();

    /// Create the payment rail. `_token` = ERC20 address (USDC) or address(0)
    /// for native ETH.
    function init(address _authority, address _teeWorker, address _token) external {
        if (initialized) revert AlreadyInitialized();
        authority = _authority;
        teeWorker = _teeWorker;
        token = _token;
        initialized = true;
        emit PaymentInitialized(_authority, _teeWorker, _token);
    }

    /// Set (or update) the payment config for a known provider. Only the
    /// authority may call.
    function configureProvider(
        string calldata provider,
        address payout,
        uint256 price,
        bool paywalled
    ) external {
        _requireInitialized();
        if (msg.sender != authority) revert NotAuthority();
        _requireKnownProvider(provider);
        configs[provider] = ProviderConfig(provider, payout, price, paywalled);
        emit ProviderConfigured(provider, payout, price, paywalled);
    }

    /// The TEE worker records a probe; if the provider is paywalled (or
    /// priced), the payment is transferred FIRST, atomically, then the receipt
    /// is appended. Reverts if the transfer fails.
    /// `paid` must equal the configured price when paywalled; the worker
    /// approves the token to this contract OR sends native ETH with the call.
    function probeWithPayment(
        string calldata provider,
        uint256 httpCode,
        string calldata detail,
        uint256 paid
    ) external payable returns (string memory verdictOut) {
        _requireInitialized();
        if (msg.sender != teeWorker) revert NotTeeWorker();
        _requireKnownProvider(provider);

        ProviderConfig storage cfg = configs[provider];
        if (cfg.paywalled) {
            if (paid == 0) revert PaywallRequired();
            if (paid != cfg.price) revert PaymentMismatch(cfg.price, paid);
            _transferTo(cfg.payout, paid);
        }

        (string memory verdict, string memory defaultDetail) = classify(httpCode);
        string memory detailFinal = bytes(detail).length == 0 ? defaultDetail : detail;
        ProbeReceipt memory receipt = ProbeReceipt(provider, verdict, httpCode, detailFinal, block.timestamp, paid);

        if (_history.length >= HISTORY_MAX) {
            for (uint256 i = 1; i < _history.length; i++) {
                _history[i - 1] = _history[i];
            }
            _history.pop();
        }
        _history.push(receipt);
        emit PaidProbeRecorded(provider, verdict, httpCode, paid);
        return verdict;
    }

    /// History of paid probes, newest first (mirrors the vault).
    function history() external view returns (ProbeReceipt[] memory) {
        _requireInitialized();
        ProbeReceipt[] memory out = new ProbeReceipt[](_history.length);
        for (uint256 i = 0; i < _history.length; i++) {
            out[i] = _history[_history.length - 1 - i];
        }
        return out;
    }

    /// Read a provider's payment config.
    function providerConfig(string calldata provider) external view returns (ProviderConfig memory) {
        _requireInitialized();
        return configs[provider];
    }

    /// The configured payout address for a provider.
    function payoutFor(string calldata provider) external view returns (address) {
        _requireInitialized();
        return configs[provider].payout;
    }

    /// Map an HTTP status to a verdict. Same shape as the vault port.
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

    function _transferTo(address payout, uint256 amount) internal {
        if (token == address(0)) {
            // Native ETH — require msg.value == amount.
            require(msg.value == amount, "eth amount mismatch");
            (bool ok, ) = payout.call{value: amount}("");
            require(ok, "eth transfer failed");
        } else {
            // ERC20 — pull from the worker's approved balance.
            require(msg.value == 0, "no eth expected");
            (bool ok, ) = token.call(
                abi.encodeWithSignature("transferFrom(address,address,uint256)", msg.sender, payout, amount)
            );
            require(ok, "token transferFrom failed");
        }
    }

    function _requireInitialized() internal view {
        if (!initialized) revert NotInitialized();
    }

    function _requireKnownProvider(string calldata provider) internal view {
        for (uint256 i = 0; i < providers.length; i++) {
            if (keccak256(bytes(providers[i])) == keccak256(bytes(provider))) return;
        }
        revert UnknownProvider(provider);
    }
}
