// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title MallardGameEscrow
/// @notice Two-player game escrow for Mezo native BTC and allowlisted ERC-20 assets.
contract MallardGameEscrow is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant SETTLER_ROLE = keccak256("SETTLER_ROLE");
    address public constant NATIVE_BTC = address(0);
    uint256 public constant MAX_FEE_BPS = 2500;

    enum Status {
        None,
        Created,
        Joined,
        Settled,
        Refunded,
        Cancelled
    }

    struct Session {
        address playerA;
        address playerB;
        address invitedPlayer;
        address asset;
        uint256 stakeAmount;
        uint64 joinDeadline;
        uint64 playDeadline;
        Status status;
    }

    address public treasury;
    uint16 public platformFeeBps;

    mapping(address => bool) public allowedAssets;
    mapping(bytes32 => Session) public sessions;

    event SessionCreated(
        bytes32 indexed sessionId,
        address indexed playerA,
        address indexed invitedPlayer,
        address asset,
        uint256 stakeAmount,
        uint64 joinDeadline,
        uint64 playDeadline
    );
    event SessionJoined(bytes32 indexed sessionId, address indexed playerB);
    event SessionSettled(
        bytes32 indexed sessionId,
        address indexed winner,
        address asset,
        uint256 winnerPayout,
        uint256 treasuryFee,
        bytes32 resultHash
    );
    event SessionRefunded(bytes32 indexed sessionId, bytes32 reasonHash);
    event SessionCancelled(bytes32 indexed sessionId);
    event TreasuryUpdated(address indexed treasury);
    event AssetAllowlistUpdated(address indexed asset, bool allowed);
    event FeeUpdated(uint16 platformFeeBps);

    error BadTreasury();
    error BadFee();
    error BadDeadline();
    error BadStake();
    error AssetNotAllowed();
    error SessionExists();
    error SessionNotFound();
    error InvalidStatus();
    error NotInvited();
    error SelfJoin();
    error UnauthorizedPlayer();
    error WrongNativeValue();
    error BadWinner();
    error DeadlineNotReached();

    constructor(address initialTreasury, uint16 initialPlatformFeeBps, address initialAdmin) {
        if (initialTreasury == address(0)) revert BadTreasury();
        if (initialAdmin == address(0)) revert BadTreasury();
        if (initialPlatformFeeBps > MAX_FEE_BPS) revert BadFee();

        treasury = initialTreasury;
        platformFeeBps = initialPlatformFeeBps;
        allowedAssets[NATIVE_BTC] = true;

        _grantRole(DEFAULT_ADMIN_ROLE, initialAdmin);
        _grantRole(SETTLER_ROLE, initialAdmin);

        emit TreasuryUpdated(initialTreasury);
        emit FeeUpdated(initialPlatformFeeBps);
        emit AssetAllowlistUpdated(NATIVE_BTC, true);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    function setTreasury(address newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newTreasury == address(0)) revert BadTreasury();
        treasury = newTreasury;
        emit TreasuryUpdated(newTreasury);
    }

    function setPlatformFeeBps(uint16 newPlatformFeeBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newPlatformFeeBps > MAX_FEE_BPS) revert BadFee();
        platformFeeBps = newPlatformFeeBps;
        emit FeeUpdated(newPlatformFeeBps);
    }

    function setAssetAllowed(address asset, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        allowedAssets[asset] = allowed;
        emit AssetAllowlistUpdated(asset, allowed);
    }

    function createSession(
        bytes32 sessionId,
        address invitedPlayer,
        address asset,
        uint256 stakeAmount,
        uint64 joinDeadline,
        uint64 playDeadline
    ) external payable nonReentrant whenNotPaused {
        if (sessions[sessionId].status != Status.None) revert SessionExists();
        if (!allowedAssets[asset]) revert AssetNotAllowed();
        if (stakeAmount == 0) revert BadStake();
        if (joinDeadline <= block.timestamp || playDeadline <= joinDeadline) revert BadDeadline();

        _collectStake(asset, msg.sender, stakeAmount);

        sessions[sessionId] = Session({
            playerA: msg.sender,
            playerB: address(0),
            invitedPlayer: invitedPlayer,
            asset: asset,
            stakeAmount: stakeAmount,
            joinDeadline: joinDeadline,
            playDeadline: playDeadline,
            status: Status.Created
        });

        emit SessionCreated(
            sessionId,
            msg.sender,
            invitedPlayer,
            asset,
            stakeAmount,
            joinDeadline,
            playDeadline
        );
    }

    function joinSession(bytes32 sessionId) external payable nonReentrant whenNotPaused {
        Session storage session = sessions[sessionId];
        if (session.status == Status.None) revert SessionNotFound();
        if (session.status != Status.Created) revert InvalidStatus();
        if (block.timestamp > session.joinDeadline) revert BadDeadline();
        if (session.playerA == msg.sender) revert SelfJoin();
        if (session.invitedPlayer != address(0) && session.invitedPlayer != msg.sender) {
            revert NotInvited();
        }

        _collectStake(session.asset, msg.sender, session.stakeAmount);

        session.playerB = msg.sender;
        session.status = Status.Joined;

        emit SessionJoined(sessionId, msg.sender);
    }

    function settleSession(
        bytes32 sessionId,
        address winner,
        bytes32 resultHash
    ) external nonReentrant whenNotPaused onlyRole(SETTLER_ROLE) {
        Session storage session = sessions[sessionId];
        if (session.status == Status.None) revert SessionNotFound();
        if (session.status != Status.Joined) revert InvalidStatus();
        if (winner != session.playerA && winner != session.playerB) revert BadWinner();

        session.status = Status.Settled;

        uint256 pot = session.stakeAmount * 2;
        uint256 fee = (pot * platformFeeBps) / 10_000;
        uint256 payout = pot - fee;

        if (fee > 0) _sendAsset(session.asset, treasury, fee);
        _sendAsset(session.asset, winner, payout);

        emit SessionSettled(sessionId, winner, session.asset, payout, fee, resultHash);
    }

    function refundSession(
        bytes32 sessionId,
        bytes32 reasonHash
    ) external nonReentrant whenNotPaused onlyRole(SETTLER_ROLE) {
        Session storage session = sessions[sessionId];
        if (session.status == Status.None) revert SessionNotFound();
        if (session.status != Status.Created && session.status != Status.Joined) revert InvalidStatus();

        Status previousStatus = session.status;
        session.status = Status.Refunded;

        _sendAsset(session.asset, session.playerA, session.stakeAmount);
        if (previousStatus == Status.Joined) {
            _sendAsset(session.asset, session.playerB, session.stakeAmount);
        }

        emit SessionRefunded(sessionId, reasonHash);
    }

    function cancelUnjoinedSession(bytes32 sessionId) external nonReentrant whenNotPaused {
        Session storage session = sessions[sessionId];
        if (session.status == Status.None) revert SessionNotFound();
        if (session.status != Status.Created) revert InvalidStatus();
        if (session.playerA != msg.sender) revert UnauthorizedPlayer();
        if (block.timestamp <= session.joinDeadline) revert DeadlineNotReached();

        session.status = Status.Cancelled;
        _sendAsset(session.asset, session.playerA, session.stakeAmount);

        emit SessionCancelled(sessionId);
    }

    function _collectStake(address asset, address from, uint256 amount) internal {
        if (asset == NATIVE_BTC) {
            if (msg.value != amount) revert WrongNativeValue();
            return;
        }

        if (msg.value != 0) revert WrongNativeValue();
        IERC20(asset).safeTransferFrom(from, address(this), amount);
    }

    function _sendAsset(address asset, address to, uint256 amount) internal {
        if (amount == 0) return;

        if (asset == NATIVE_BTC) {
            (bool ok, ) = to.call{value: amount}("");
            require(ok, "NATIVE_TRANSFER_FAILED");
            return;
        }

        IERC20(asset).safeTransfer(to, amount);
    }
}
