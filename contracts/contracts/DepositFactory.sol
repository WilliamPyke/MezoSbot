// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title DepositForwarder
/// @notice Implementation behind every per-user EIP-1167 clone. `factory` and `vault` are
///         immutables in this contract's code, so every clone shares them and a clone has no
///         storage, no initializer and no owner. A clone accepts native BTC and can only push
///         its whole balance to the vault, and only when the factory asks.
contract DepositForwarder {
    using SafeERC20 for IERC20;

    address public immutable factory;
    address public immutable vault;
    address private immutable self;

    error OnlyFactory();
    error VaultRejected();
    error NotAClone();

    constructor(address vault_) {
        factory = msg.sender;
        vault = vault_;
        self = address(this);
    }

    /// @dev Only clones take deposits. Native sent to the implementation by other means (the BTC
    ///      precompile runs no code here) is moved by DepositFactory.sweepStray.
    receive() external payable {
        if (address(this) == self) revert NotAClone();
    }

    /// @return amount Native balance forwarded to the vault.
    function sweepNative() external returns (uint256 amount) {
        if (msg.sender != factory) revert OnlyFactory();
        amount = address(this).balance;
        if (amount == 0) return 0;
        (bool ok, ) = vault.call{value: amount}("");
        if (!ok) revert VaultRejected();
    }

    /// @return amount Token balance forwarded to the vault.
    function sweepToken(address token) external returns (uint256 amount) {
        if (msg.sender != factory) revert OnlyFactory();
        amount = IERC20(token).balanceOf(address(this));
        if (amount == 0) return 0;
        IERC20(token).safeTransfer(vault, amount);
    }

    /// @notice Hands a token the factory never sweeps to `to`. The factory only asks for tokens
    ///         that are not on its allowlist, so deposit tokens can never leave this way.
    /// @return amount Token balance moved.
    function rescueToken(address token, address to) external returns (uint256 amount) {
        if (msg.sender != factory) revert OnlyFactory();
        amount = IERC20(token).balanceOf(address(this));
        if (amount == 0) return 0;
        IERC20(token).safeTransfer(to, amount);
    }
}

/// @title DepositFactory
/// @notice One CREATE2 deposit address per user salt. Anyone may sweep; funds only ever reach
///         the vault, which is fixed at deploy. The clone is deployed by the first sweep that
///         finds a balance, so deposits can arrive before it exists.
///
///         The admin is the vault itself, or, when the vault is a contract that reports its own
///         admin through `vault()` (HotPayout), that admin. It can add tokens to the allowlist
///         (never remove them) and hand tokens that are not allowlisted, sent to a deposit address
///         by mistake, to itself. It can never move native BTC or an allowlisted token.
contract DepositFactory is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Mezo also exposes native BTC as an ERC-20 at this precompile. The native sweep
    ///         already moves that balance, so allowlisting it would double count deposits.
    address public constant BTC_TOKEN = 0x7b7C000000000000000000000000000000000000;

    address public immutable vault;
    address public immutable implementation;

    mapping(address => bool) public allowedToken;

    event Swept(bytes32 indexed salt, address indexed token, uint256 amount, address indexed vault);
    event TokenAllowed(address indexed token, bool allowed);
    event Rescued(bytes32 indexed salt, address indexed token, address indexed to, uint256 amount);
    /// @notice Funds that reached the factory or the implementation, moved to the vault. Never a deposit.
    event StraySwept(address indexed from, address indexed token, uint256 amount);

    error ZeroAddress();
    error NotAdmin();
    error InvalidToken();
    error TokenNotAllowed();
    error TokenAllowlisted();
    error VaultRejected();

    constructor(address vault_, address[] memory tokens) {
        if (vault_ == address(0)) revert ZeroAddress();
        vault = vault_;
        implementation = address(new DepositForwarder(vault_));
        for (uint256 i = 0; i < tokens.length; ++i) {
            _allowToken(tokens[i]);
        }
    }

    function predict(bytes32 salt) public view returns (address) {
        return Clones.predictDeterministicAddress(implementation, salt);
    }

    /// @notice The vault, or the admin a contract vault reports through `vault()`.
    function admin() public view returns (address) {
        if (vault.code.length == 0) return vault;
        (bool ok, bytes memory data) = vault.staticcall(abi.encodeWithSignature("vault()"));
        if (!ok || data.length != 32) return vault;
        address reported = abi.decode(data, (address));
        return reported == address(0) ? vault : reported;
    }

    /// @return amount Native BTC moved to the vault; 0 (no clone deployed, no event) if empty.
    function sweepNative(bytes32 salt) external nonReentrant returns (uint256 amount) {
        address forwarder = predict(salt);
        if (forwarder.balance == 0) return 0;
        _deployIfMissing(forwarder, salt);
        amount = DepositForwarder(payable(forwarder)).sweepNative();
        if (amount != 0) emit Swept(salt, address(0), amount, vault);
    }

    /// @return amount Tokens moved to the vault; 0 (no clone deployed, no event) if empty.
    function sweepToken(bytes32 salt, address token) external nonReentrant returns (uint256 amount) {
        if (!allowedToken[token]) revert TokenNotAllowed();
        address forwarder = predict(salt);
        if (IERC20(token).balanceOf(forwarder) == 0) return 0;
        _deployIfMissing(forwarder, salt);
        amount = DepositForwarder(payable(forwarder)).sweepToken(token);
        if (amount != 0) emit Swept(salt, token, amount, vault);
    }

    /// @notice Adds a token to the sweep allowlist. There is no way to remove one.
    function allowToken(address token) external {
        if (msg.sender != admin()) revert NotAdmin();
        _allowToken(token);
    }

    /// @notice Hands a token that is not allowlisted, sent to a deposit address by mistake, to the admin.
    function rescueToken(bytes32 salt, address token) external nonReentrant returns (uint256 amount) {
        address to = admin();
        if (msg.sender != to) revert NotAdmin();
        if (token == address(0) || token == BTC_TOKEN) revert InvalidToken();
        if (allowedToken[token]) revert TokenAllowlisted();
        address forwarder = predict(salt);
        if (IERC20(token).balanceOf(forwarder) == 0) return 0;
        _deployIfMissing(forwarder, salt);
        amount = DepositForwarder(payable(forwarder)).rescueToken(token, to);
        if (amount != 0) emit Rescued(salt, token, to, amount);
    }

    /// @notice Moves native (token address(0)) or a token that reached this factory or the
    ///         implementation to the vault. Anyone may call it; it is never credited as a deposit.
    function sweepStray(address token) external nonReentrant {
        if (token == BTC_TOKEN) revert InvalidToken();
        uint256 own;
        uint256 fromImplementation;
        if (token == address(0)) {
            own = address(this).balance;
            if (own != 0) {
                (bool ok, ) = vault.call{value: own}("");
                if (!ok) revert VaultRejected();
            }
            fromImplementation = DepositForwarder(payable(implementation)).sweepNative();
        } else {
            own = IERC20(token).balanceOf(address(this));
            if (own != 0) IERC20(token).safeTransfer(vault, own);
            fromImplementation = DepositForwarder(payable(implementation)).sweepToken(token);
        }
        if (own != 0) emit StraySwept(address(this), token, own);
        if (fromImplementation != 0) emit StraySwept(implementation, token, fromImplementation);
    }

    function _deployIfMissing(address forwarder, bytes32 salt) private {
        if (forwarder.code.length == 0) Clones.cloneDeterministic(implementation, salt);
    }

    function _allowToken(address token) private {
        if (token == address(0) || token == BTC_TOKEN) revert InvalidToken();
        allowedToken[token] = true;
        emit TokenAllowed(token, true);
    }
}
