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

    /// @dev Only clones take deposits. The factory never sweeps the implementation itself, so
    ///      native sent straight to it would be stuck.
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
}

/// @title DepositFactory
/// @notice One CREATE2 deposit address per user salt. Anyone may sweep; funds only ever reach
///         the vault, which is fixed at deploy. The clone is deployed by the first sweep that
///         finds a balance, so deposits can arrive before it exists.
contract DepositFactory is ReentrancyGuard {
    /// @notice Mezo also exposes native BTC as an ERC-20 at this precompile. The native sweep
    ///         already moves that balance, so allowlisting it would double count deposits.
    address public constant BTC_TOKEN = 0x7b7C000000000000000000000000000000000000;

    address public immutable vault;
    address public immutable implementation;

    mapping(address => bool) public allowedToken;

    event Swept(bytes32 indexed salt, address indexed token, uint256 amount, address indexed vault);
    event TokenAllowed(address indexed token, bool allowed);

    error ZeroAddress();
    error OnlyVault();
    error InvalidToken();
    error TokenNotAllowed();

    constructor(address vault_, address[] memory tokens) {
        if (vault_ == address(0)) revert ZeroAddress();
        vault = vault_;
        implementation = address(new DepositForwarder(vault_));
        for (uint256 i = 0; i < tokens.length; ++i) {
            _setTokenAllowed(tokens[i], true);
        }
    }

    function predict(bytes32 salt) public view returns (address) {
        return Clones.predictDeterministicAddress(implementation, salt);
    }

    function setTokenAllowed(address token, bool allowed) external {
        if (msg.sender != vault) revert OnlyVault();
        _setTokenAllowed(token, allowed);
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

    function _deployIfMissing(address forwarder, bytes32 salt) private {
        if (forwarder.code.length == 0) Clones.cloneDeterministic(implementation, salt);
    }

    function _setTokenAllowed(address token, bool allowed) private {
        if (token == address(0) || token == BTC_TOKEN) revert InvalidToken();
        allowedToken[token] = allowed;
        emit TokenAllowed(token, allowed);
    }
}
