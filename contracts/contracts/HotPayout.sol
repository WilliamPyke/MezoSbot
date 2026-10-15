// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

interface IDepositFactoryInfo {
    function vault() external view returns (address);
    function implementation() external view returns (address);
}

/// @title HotPayout
/// @notice Holds the withdrawal float. The operator (hot key) pays users inside per-token caps, at
///         most once per withdrawal ref. The guardian can pause, tighten caps and cancel queued
///         vault actions. The vault (admin) can pause, unpause and tighten at once; everything that
///         loosens control (higher caps, new operator, guardian or vault, moving float out) is
///         queued and can only be applied from its delay (VAULT_DELAY for a handover, GUARDIAN_DELAY
///         for a new guardian, DELAY otherwise) until GRACE after that, so a watcher has time to
///         cancel it. Native BTC is token address(0).
///
///         Queued actions are keyed by their full content, so several can be pending at once and a
///         cancel removes exactly one. A vault handover drops every action queued before it, and a
///         tighten or disallow drops every cap raise queued for that token before it.
///
///         Daily cap: spending decays linearly at dailyCap per WINDOW, and a payment must keep
///         decayed spending within dailyCap. So a burst can never exceed dailyCap, a full allowance
///         returns one WINDOW after the last payment, and no WINDOW-long period can pay out more
///         than 2 x dailyCap. Spending is kept scaled by WINDOW, so decay is exact.
contract HotPayout is ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    /// @notice Mezo also exposes native BTC as an ERC-20 at this precompile. Paying it as a token
    ///         would bypass the native caps, so it can never be allowlisted or recovered as a token.
    address public constant BTC_TOKEN = 0x7b7C000000000000000000000000000000000000;
    uint256 public constant WINDOW = 1 days;
    /// @notice Wait between queueing and applying a recovery, a cap raise or a new operator. At least
    ///         WINDOW, so a cap change can never refill the daily allowance faster than decay would.
    uint256 public constant DELAY = 3 days;
    /// @notice Wait for a vault handover, shorter than DELAY: a handover queued before an unwanted
    ///         guardian takes office lands before anything that guardian's vault queues afterwards.
    uint256 public constant VAULT_DELAY = 2 days;
    /// @notice Wait for a new guardian, longer than a vault handover: a handover queued within this
    ///         time of an unwanted guardian proposal lands first and drops it.
    uint256 public constant GUARDIAN_DELAY = 4 days;
    /// @notice How long after DELAY a queued action can still be applied before it lapses.
    uint256 public constant GRACE = 7 days;
    /// @dev Bounds dailyCap * elapsed and amount * WINDOW far below uint256 overflow.
    uint256 public constant MAX_CAP = type(uint128).max;
    bytes32 public constant PROPOSE_VAULT_TYPEHASH =
        keccak256("ProposeVault(address next,uint256 vaultEpoch,uint256 deadline)");
    // EIP-712 domain, built here because OpenZeppelin's EIP712 needs opcodes newer than paris.
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("MezoSbot HotPayout");
    bytes32 private constant VERSION_HASH = keccak256("1");

    enum Action {
        Vault,
        Operator,
        Guardian,
        Caps,
        Recover
    }

    struct Usage {
        /// @dev Spending times WINDOW, so decay (dailyCap per second) needs no division.
        uint256 spentScaled;
        uint256 updatedAt;
    }

    address public vault;
    address public operator;
    address public guardian;
    /// @notice The guardian in office when each vault handover was queued; only it can cancel that
    ///         handover, however many guardian changes follow.
    mapping(bytes32 => address) public handoverGuardian;

    /// @notice Deposit factory whose implementation and forwarder clones never receive payouts;
    ///         address(0) when none was given.
    address public immutable factory;
    address public immutable forwarderImplementation;
    /// @notice Runtime code hash of every forwarder clone (EIP-1167 proxy of the implementation).
    bytes32 public immutable forwarderCodeHash;

    mapping(bytes32 => bool) public paid;
    mapping(address => bool) public allowedToken;
    mapping(address => uint256) public perTxCap;
    mapping(address => uint256) public dailyCap;
    mapping(address => Usage) private _usage;

    /// @notice Earliest apply time of each queued action id; 0 when none is queued.
    mapping(bytes32 => uint256) public queuedEta;
    /// @notice Bumped by every vault handover; part of every action id.
    uint256 public vaultEpoch;
    /// @notice Bumped by every tighten or disallow of a token; part of its cap-raise ids.
    mapping(address => uint256) public capsEpoch;
    /// @notice ProposeVault signatures already used (by EIP-712 digest); each works once.
    mapping(bytes32 => bool) public usedSignatures;

    event Paid(bytes32 indexed ref, address indexed token, address indexed to, uint256 amount);
    event TokenAllowed(address indexed token, bool allowed);
    event CapsSet(address indexed token, uint256 perTxCap, uint256 dailyCap);
    event VaultSet(address indexed previous, address indexed vault);
    event OperatorSet(address indexed previous, address indexed operator);
    event GuardianSet(address indexed previous, address indexed guardian);
    event Recovered(address indexed token, uint256 amount);
    /// @param subject New vault/operator/guardian, or the token for Caps and Recover.
    /// @param value1 perTx for Caps, amount for Recover, otherwise 0.
    /// @param value2 daily for Caps, otherwise 0.
    event ActionQueued(
        bytes32 indexed id,
        Action indexed action,
        address indexed subject,
        uint256 value1,
        uint256 value2,
        uint256 eta
    );
    event ActionCancelled(bytes32 indexed id, Action indexed action, address indexed by);
    event ActionApplied(bytes32 indexed id, Action indexed action);
    /// @notice A vault handover dropped every action queued before it.
    event QueueDropped(uint256 vaultEpoch);
    /// @notice A cap cut or disallow dropped every raise queued for the token before it.
    event CapRaisesDropped(address indexed token, uint256 capsEpoch);

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
    error ActionPending();
    error NothingPending();
    error TooEarly();
    error Expired();
    error NotFactory();
    error BadSignature();
    error QueuedBeforeGuardian();

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

    /// @param factory_ Deposit factory whose clones must never be paid (its vault must be this
    ///        contract or vault_), or address(0).
    /// @param tokens Payout tokens to allowlist, address(0) for native BTC, each with its caps.
    constructor(
        address vault_,
        address operator_,
        address guardian_,
        address factory_,
        address[] memory tokens,
        uint256[] memory perTxCaps,
        uint256[] memory dailyCaps
    ) {
        _checkRoles(vault_, operator_, guardian_);
        if (tokens.length != perTxCaps.length || tokens.length != dailyCaps.length) revert LengthMismatch();
        vault = vault_;
        operator = operator_;
        guardian = guardian_;
        emit VaultSet(address(0), vault_);
        emit OperatorSet(address(0), operator_);
        emit GuardianSet(address(0), guardian_);

        address implementation;
        bytes32 codeHash;
        if (factory_ != address(0)) {
            if (factory_.code.length == 0) revert NotFactory();
            address target = IDepositFactoryInfo(factory_).vault();
            if (target != address(this) && target != vault_) revert NotFactory();
            implementation = IDepositFactoryInfo(factory_).implementation();
            if (implementation.code.length == 0) revert NotFactory();
            codeHash = keccak256(
                abi.encodePacked(hex"363d3d373d3d3d363d73", implementation, hex"5af43d82803e903d91602b57fd5bf3")
            );
        }
        factory = factory_;
        forwarderImplementation = implementation;
        forwarderCodeHash = codeHash;

        for (uint256 i = 0; i < tokens.length; ++i) {
            if (allowedToken[tokens[i]]) revert DuplicateToken();
            _checkCaps(perTxCaps[i], dailyCaps[i]);
            _setTokenAllowed(tokens[i], true);
            _setCaps(tokens[i], perTxCaps[i], dailyCaps[i]);
        }
    }

    receive() external payable {}

    // ---- operator ----

    function payNative(bytes32 ref, address to, uint256 amount) external nonReentrant onlyOperator whenNotPaused {
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
    ) external nonReentrant onlyOperator whenNotPaused {
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

    /// @notice Lowers caps (each value must be <= the current one). A per-tx cap above the daily cap
    ///         is lowered to it, and a zero in either stops the token: (0, 0). Drops queued raises.
    function tightenCaps(address token, uint256 perTx, uint256 daily) external onlyGuardian {
        _tighten(token, perTx, daily);
    }

    /// @notice Cancels one queued vault action. The guardian cancels everything except a new
    ///         guardian, which only the vault can cancel, so neither role can block its own
    ///         replacement. A vault handover can only be cancelled by the guardian that was in office
    ///         when it was queued (handoverGuardian), so a guardian installed later by whoever held the
    ///         vault key cannot stop the handover that replaces that key, and a handover the guardian
    ///         of the day should have stopped stays stoppable by it.
    function cancel(Action action, address subject, uint256 value1, uint256 value2) external {
        bytes32 id = actionId(action, subject, value1, value2);
        uint256 eta = queuedEta[id];
        if (action == Action.Guardian) {
            if (msg.sender != vault) revert NotVault();
        } else if (action == Action.Vault && eta != 0) {
            if (msg.sender != handoverGuardian[id]) revert QueuedBeforeGuardian();
        } else if (msg.sender != guardian) {
            revert NotGuardian();
        }
        if (eta == 0) revert NothingPending();
        delete queuedEta[id];
        emit ActionCancelled(id, action, msg.sender);
    }

    // ---- vault: immediate ----

    function unpause() external onlyVault {
        _unpause();
    }

    /// @notice Allowing a token takes effect at once but pays nothing until caps are set, and raising
    ///         caps is queued. Disallowing also zeroes its caps and drops its queued raises.
    function setTokenAllowed(address token, bool allowed) external onlyVault {
        if (!allowed) {
            bool stopped = perTxCap[token] == 0 && dailyCap[token] == 0;
            _setCaps(token, 0, 0);
            if (stopped) _dropCapRaises(token);
        }
        _setTokenAllowed(token, allowed);
    }

    /// @notice Tightening applies at once (same rules as tightenCaps). A raise of either value with the
    ///         other no lower is queued and applied with applyCaps. Lowering one value while raising
    ///         the other is refused: tighten first, then queue the raise.
    function setCaps(address token, uint256 perTx, uint256 daily) external onlyVault {
        _checkCaps(perTx, daily);
        if (perTx <= perTxCap[token] && daily <= dailyCap[token]) {
            _tighten(token, perTx, daily);
        } else if (perTx >= perTxCap[token] && daily >= dailyCap[token]) {
            _queue(Action.Caps, token, perTx, daily);
        } else {
            revert InvalidCaps();
        }
    }

    // ---- vault: queued ----

    function proposeVault(address next) external onlyVault {
        _checkRoles(next, operator, guardian);
        _queue(Action.Vault, next, 0, 0);
    }

    /// @notice Queues a vault handover signed by an EOA vault (EIP-712 ProposeVault). Anyone may submit
    ///         it, so a handover gets through even when the vault wallet cannot send transactions
    ///         itself (a contract vault such as a Safe always can, and uses proposeVault).
    function proposeVaultWithSig(address next, uint256 deadline, bytes calldata signature) external {
        if (block.timestamp > deadline) revert Expired();
        bytes32 structHash = keccak256(abi.encode(PROPOSE_VAULT_TYPEHASH, next, vaultEpoch, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
        (address signer, ECDSA.RecoverError err, ) = ECDSA.tryRecoverCalldata(digest, signature);
        if (err != ECDSA.RecoverError.NoError || signer != vault || usedSignatures[digest]) revert BadSignature();
        usedSignatures[digest] = true;
        _checkRoles(next, operator, guardian);
        _queue(Action.Vault, next, 0, 0);
    }

    function proposeOperator(address next) external onlyVault {
        _checkRoles(vault, next, guardian);
        _queue(Action.Operator, next, 0, 0);
    }

    function proposeGuardian(address next) external onlyVault {
        _checkRoles(vault, operator, next);
        _queue(Action.Guardian, next, 0, 0);
    }

    /// @notice Queues moving float to the vault. There is no other destination.
    function proposeRecover(address token, uint256 amount) external onlyVault {
        if (token == BTC_TOKEN) revert InvalidToken();
        if (amount == 0) revert ZeroAmount();
        _queue(Action.Recover, token, amount, 0);
    }

    /// @notice The proposed vault accepts, which also proves it can sign. Drops every other queued action.
    function acceptVault() external {
        _take(Action.Vault, msg.sender, 0, 0);
        _checkRoles(msg.sender, operator, guardian);
        emit VaultSet(vault, msg.sender);
        vault = msg.sender;
        emit QueueDropped(++vaultEpoch);
    }

    function applyOperator(address next) external onlyVault {
        _take(Action.Operator, next, 0, 0);
        _checkRoles(vault, next, guardian);
        emit OperatorSet(operator, next);
        operator = next;
    }

    function applyGuardian(address next) external onlyVault {
        _take(Action.Guardian, next, 0, 0);
        _checkRoles(vault, operator, next);
        emit GuardianSet(guardian, next);
        guardian = next;
    }

    function applyCaps(address token, uint256 perTx, uint256 daily) external onlyVault {
        _take(Action.Caps, token, perTx, daily);
        _setCaps(token, perTx, daily);
    }

    function applyRecover(address token, uint256 amount) external nonReentrant onlyVault {
        _take(Action.Recover, token, amount, 0);
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

    /// @notice Id of a queued action under the current vault (and, for Caps, the token's cap epoch).
    function actionId(Action action, address subject, uint256 value1, uint256 value2) public view returns (bytes32) {
        uint256 capsNonce = action == Action.Caps ? capsEpoch[subject] : 0;
        return keccak256(abi.encode(vaultEpoch, capsNonce, action, subject, value1, value2));
    }

    /// @notice EIP-712 domain separator (name "MezoSbot HotPayout", version "1", this chain and contract).
    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    /// @notice When a queued action can be applied, or 0 when it is not queued, was dropped or has lapsed.
    function pendingEta(Action action, address subject, uint256 value1, uint256 value2) external view returns (uint256) {
        uint256 eta = queuedEta[actionId(action, subject, value1, value2)];
        return eta != 0 && block.timestamp <= eta + GRACE ? eta : 0;
    }

    /// @notice What the daily cap still allows right now. Ignores pause, allowlist and float.
    function remainingDaily(address token) external view returns (uint256) {
        if (perTxCap[token] == 0) return 0;
        uint256 capScaled = dailyCap[token] * WINDOW;
        uint256 spentScaled = _spentScaled(token);
        return spentScaled >= capScaled ? 0 : (capScaled - spentScaled) / WINDOW;
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
            to == token ||
            (factory != address(0) &&
                (to == factory || to == forwarderImplementation || to.codehash == forwarderCodeHash))
        ) revert BadRecipient();
        if (!allowedToken[token]) revert TokenNotAllowed();
        uint256 txCap = perTxCap[token];
        uint256 cap = dailyCap[token];
        if (txCap == 0 || cap == 0) revert CapsNotSet();
        if (amount == 0) revert ZeroAmount();
        if (amount > txCap) revert PerTxCapExceeded();
        uint256 spentScaled = _spentScaled(token) + amount * WINDOW;
        if (spentScaled > cap * WINDOW) revert DailyCapExceeded();

        paid[ref] = true;
        _usage[token] = Usage(spentScaled, block.timestamp);
        emit Paid(ref, token, to, amount);
    }

    /// @dev Recorded spending (scaled by WINDOW), decayed at the current dailyCap per second.
    function _spentScaled(address token) private view returns (uint256) {
        Usage storage usage = _usage[token];
        uint256 decay = dailyCap[token] * (block.timestamp - usage.updatedAt);
        return usage.spentScaled > decay ? usage.spentScaled - decay : 0;
    }

    function _tighten(address token, uint256 perTx, uint256 daily) private {
        if (perTx > perTxCap[token] || daily > dailyCap[token]) revert CapsNotTightened();
        if (perTx > daily) perTx = daily;
        if (perTx == 0 || daily == 0) (perTx, daily) = (0, 0);
        bool unchanged = perTx == perTxCap[token] && daily == dailyCap[token];
        _setCaps(token, perTx, daily);
        // A cut already dropped queued raises in _setCaps; an unchanged tighten drops them too.
        if (unchanged) _dropCapRaises(token);
    }

    /// @dev Settles decay at the old rate, then keeps spending within the new daily cap, so a stop
    ///      followed by a (queued) restore starts from a clean allowance. Any cut, including a queued
    ///      change applied over a higher cap, drops the raises queued before it, so no earlier raise
    ///      can land on spending the cut just lowered.
    function _setCaps(address token, uint256 perTx, uint256 daily) private {
        if (perTx < perTxCap[token] || daily < dailyCap[token]) _dropCapRaises(token);
        uint256 spentScaled = _spentScaled(token);
        uint256 capScaled = daily * WINDOW;
        if (spentScaled > capScaled) spentScaled = capScaled;
        _usage[token] = Usage(spentScaled, block.timestamp);
        perTxCap[token] = perTx;
        dailyCap[token] = daily;
        emit CapsSet(token, perTx, daily);
    }

    function _dropCapRaises(address token) private {
        emit CapRaisesDropped(token, ++capsEpoch[token]);
    }

    function _setTokenAllowed(address token, bool allowed) private {
        if (token == BTC_TOKEN) revert InvalidToken();
        allowedToken[token] = allowed;
        emit TokenAllowed(token, allowed);
    }

    function _queue(Action action, address subject, uint256 value1, uint256 value2) private {
        bytes32 id = actionId(action, subject, value1, value2);
        uint256 queued = queuedEta[id];
        if (queued != 0 && block.timestamp <= queued + GRACE) revert ActionPending();
        uint256 eta = block.timestamp +
            (action == Action.Guardian ? GUARDIAN_DELAY : action == Action.Vault ? VAULT_DELAY : DELAY);
        queuedEta[id] = eta;
        if (action == Action.Vault) handoverGuardian[id] = guardian;
        emit ActionQueued(id, action, subject, value1, value2, eta);
    }

    function _take(Action action, address subject, uint256 value1, uint256 value2) private {
        bytes32 id = actionId(action, subject, value1, value2);
        uint256 eta = queuedEta[id];
        if (eta == 0) revert NothingPending();
        if (block.timestamp < eta) revert TooEarly();
        if (block.timestamp > eta + GRACE) revert Expired();
        delete queuedEta[id];
        emit ActionApplied(id, action);
    }

    /// @dev Caps are both zero (token stopped) or a positive per-tx cap within the daily cap.
    function _checkCaps(uint256 perTx, uint256 daily) private pure {
        if ((perTx == 0) != (daily == 0) || perTx > daily || daily > MAX_CAP) revert InvalidCaps();
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
