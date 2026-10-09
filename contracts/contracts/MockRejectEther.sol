// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Test helper with no receive or fallback, so every native transfer to it reverts.
contract MockRejectEther {}
