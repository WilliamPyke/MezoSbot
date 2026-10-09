// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title HotPayout
/// @notice Holds a small withdrawal float. The operator (hot key) pays users inside per-token
///         caps, at most once per withdrawal ref. The guardian can pause and tighten caps. The
///         vault is the only account that can loosen caps, unpause, change roles or allowlist,
///         and the only destination for recovered funds. Native BTC is token address(0).
///
///         Daily cap: spending decays linearly at dailyCap per WINDOW, and a payment must keep
///         decayed spending within dailyCap. So a burst can never exceed dailyCap, a full
///         allowance returns one WINDOW after the last payment, and no WINDOW-long period can
///         pay out more than 2 x dailyCap.
contract HotPayout is ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    /// @notice Mezo also exposes native BTC as an ERC-20 at this precompile. Paying it as a token
    ///         would bypass the native caps, so it can never be allowlisted.
    address public constant BTC_TOKEN = 0x7b7C000000000000000000000000000000000000;
    uint256 public constant WINDOW = 1 days;
    /// @dev Bounds dailyCap * elapsed in _spent() far below uint256 overflow.
    uint256 public constant MAX_CAP = type(uint128).max;

    struct Usage {
        uint256 spent;
        uint256 updatedAt;
    }

    address public immutable vault;
    address public operator;
    address public guardian;

    mapping(bytes32 => bool) public paid;
    mapping(address => bool) public allowedToken;
    mapping(address => uint256) public perTxCap;
    mapping(address => uint256) public dailyCap;
    mapping(address => Usage) private _usage;

    event Paid(bytes32 indexed ref, address indexed token, address indexed to, uint256 amount);
    event TokenAllowed(address indexed token, bool allowed);
    event CapsSet(address indexed token, uint256 perTxCap, uint256 dailyCap);
    event OperatorSet(address indexed previous, address indexed operator);
    event GuardianSet(address indexed previous, address indexed guardian);
    event Recovered(address indexed token, uint256 amount);

    error InvalidRoles();
    error LengthMismatch();
    error InvalidToken();
    error DuplicateToken();
    error InvalidCaps();
    error NotOperator();
    error NotGuardian();
    error NotVault();
    error InvalidRef();
    error AlreadyPaid();
    error BadRecipient();
    error TokenNotAllowed();
    error CapsNotSet();
    error ZeroAmount();
    error PerTxCapExceeded();
    error DailyCapExceeded();
    error CapsNotTightened();
    error InsufficientFloat();
    error PayFailed();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian();
        _;
    }

    modifier onlyVault() {
        if (msg.sender != vault) revert NotVault();
        _;
    }

    /// @param tokens Payout tokens to allowlist, address(0) for native BTC, each with its caps.
    constructor(
        address vault_,
        address operator_,
        address guardian_,
        address[] memory tokens,
        uint256[] memory perTxCaps,
        uint256[] memory dailyCaps
    ) {
        _checkRoles(vault_, operator_, guardian_);
        if (tokens.length != perTxCaps.length || tokens.length != dailyCaps.length) revert LengthMismatch();
        vault = vault_;
        operator = operator_;
        guardian = guardian_;
        emit OperatorSet(address(0), operator_);
        emit GuardianSet(address(0), guardian_);
        for (uint256 i = 0; i < tokens.length; ++i) {
            if (allowedToken[tokens[i]]) revert DuplicateToken();
            _setTokenAllowed(tokens[i], true);
            _checkCaps(perTxCaps[i], dailyCaps[i]);
            _setCaps(tokens[i], perTxCaps[i], dailyCaps[i]);
        }
    }

    receive() external payable {}

    // ---- operator ----

    function payNative(bytes32 ref, address to, uint256 amount) external onlyOperator whenNotPaused nonReentrant {
        _record(ref, address(0), to, amount);
        if (address(this).balance < amount) revert InsufficientFloat();
        bool ok;
        // No return data is copied, so a recipient cannot grief the operator with a return bomb.
        assembly ("memory-safe") {
            ok := call(gas(), to, amount, 0, 0, 0, 0)
        }
        if (!ok) revert PayFailed();
    }

    function payToken(
        bytes32 ref,
        address token,
        address to,
        uint256 amount
    ) external onlyOperator whenNotPaused nonReentrant {
        if (token == address(0)) revert InvalidToken();
        _record(ref, token, to, amount);
        if (IERC20(token).balanceOf(address(this)) < amount) revert InsufficientFloat();
        IERC20(token).safeTransfer(to, amount);
    }

    // ---- guardian ----

    /// @notice Guardian or vault. Idempotent so an emergency script never fails on it.
    function pause() external {
        if (msg.sender != guardian && msg.sender != vault) revert NotGuardian();
        if (!paused()) _pause();
    }

    /// @notice Lowers caps (each value must be <= the current one). (0, 0) stops a token.
    function tightenCaps(address token, uint256 perTx, uint256 daily) external onlyGuardian {
        if (perTx > perTxCap[token] || daily > dailyCap[token]) revert CapsNotTightened();
        _setCaps(token, perTx, daily);
    }

    // ---- vault ----

    function unpause() external onlyVault {
        _unpause();
    }

    function setOperator(address next) external onlyVault {
        _checkRoles(vault, next, guardian);
        emit OperatorSet(operator, next);
        operator = next;
    }

    function setGuardian(address next) external onlyVault {
        _checkRoles(vault, operator, next);
        emit GuardianSet(guardian, next);
        guardian = next;
    }

    function setTokenAllowed(address token, bool allowed) external onlyVault {
        _setTokenAllowed(token, allowed);
    }

    /// @notice Sets caps in either direction. Spending already recorded still counts, so raising
    ///         dailyCap frees only the difference.
    function setCaps(address token, uint256 perTx, uint256 daily) external onlyVault {
        _checkCaps(perTx, daily);
        _setCaps(token, perTx, daily);
    }

    /// @notice Sends float back to the vault. There is no other destination.
    function recover(address token, uint256 amount) external onlyVault nonReentrant {
        if (token == address(0)) {
            if (address(this).balance < amount) revert InsufficientFloat();
            (bool ok, ) = vault.call{value: amount}("");
            if (!ok) revert PayFailed();
        } else {
            IERC20(token).safeTransfer(vault, amount);
        }
        emit Recovered(token, amount);
    }

    // ---- views ----

    /// @notice What the daily cap still allows right now. Ignores pause, allowlist and float.
    function remainingDaily(address token) external view returns (uint256) {
        uint256 cap = dailyCap[token];
        uint256 spent = _spent(token);
        return spent >= cap ? 0 : cap - spent;
    }

    // ---- internals ----

    function _record(bytes32 ref, address token, address to, uint256 amount) private {
        if (ref == bytes32(0)) revert InvalidRef();
        if (paid[ref]) revert AlreadyPaid();
        if (
            to == address(0) ||
            to == address(this) ||
            to == vault ||
            to == operator ||
            to == guardian ||
            to == token
        ) revert BadRecipient();
        if (!allowedToken[token]) revert TokenNotAllowed();
        uint256 txCap = perTxCap[token];
        uint256 cap = dailyCap[token];
        if (txCap == 0 || cap == 0) revert CapsNotSet();
        if (amount == 0) revert ZeroAmount();
        if (amount > txCap) revert PerTxCapExceeded();
        uint256 spent = _spent(token) + amount;
        if (spent > cap) revert DailyCapExceeded();

        paid[ref] = true;
        _usage[token] = Usage(spent, block.timestamp);
        emit Paid(ref, token, to, amount);
    }

    /// @dev Recorded spending, decayed at the current dailyCap per WINDOW since the last update.
    function _spent(address token) private view returns (uint256) {
        Usage storage usage = _usage[token];
        uint256 decay = (dailyCap[token] * (block.timestamp - usage.updatedAt)) / WINDOW;
        return usage.spent > decay ? usage.spent - decay : 0;
    }

    function _setCaps(address token, uint256 perTx, uint256 daily) private {
        // Settle decay at the old rate before the rate changes.
        _usage[token] = Usage(_spent(token), block.timestamp);
        perTxCap[token] = perTx;
        dailyCap[token] = daily;
        emit CapsSet(token, perTx, daily);
    }

    function _setTokenAllowed(address token, bool allowed) private {
        if (token == BTC_TOKEN) revert InvalidToken();
        allowedToken[token] = allowed;
        emit TokenAllowed(token, allowed);
    }

    function _checkCaps(uint256 perTx, uint256 daily) private pure {
        if (perTx > daily || daily > MAX_CAP) revert InvalidCaps();
    }

    function _checkRoles(address vault_, address operator_, address guardian_) private pure {
        if (
            vault_ == address(0) ||
            operator_ == address(0) ||
            guardian_ == address(0) ||
            vault_ == operator_ ||
            vault_ == guardian_ ||
            operator_ == guardian_
        ) revert InvalidRoles();
    }
}
