// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title BalanceScan
/// @notice Never deployed. The bot places this contract's runtime code at an address for the
///         length of one eth_call (a state override) and calls it, so one request reads the
///         balances of many deposit forwarders in place of one request per forwarder per asset
///         (src/custody/balanceScan.ts). It is written to keep that request small.
///
///         Calldata, packed: one byte holding the number of tokens, then each token address
///         (20 bytes), then each holder address (20 bytes).
///         Returns one 32-byte word per value: for each holder in order, its native balance
///         followed by its balanceOf for each token in order.
///         Reverts with no data when a token's balanceOf fails or returns less than one word.
contract BalanceScan {
    fallback() external {
        assembly {
            let holdersAt := add(1, mul(byte(0, calldataload(0)), 20))
            let out := 0x80
            // balanceOf(address) call data lives at memory 0..36: selector, then the holder.
            mstore(0, 0x70a0823100000000000000000000000000000000000000000000000000000000)
            for { let h := holdersAt } lt(h, calldatasize()) { h := add(h, 20) } {
                let holder := shr(96, calldataload(h))
                mstore(out, balance(holder))
                out := add(out, 32)
                mstore(4, holder)
                for { let t := 1 } lt(t, holdersAt) { t := add(t, 20) } {
                    // The token writes its answer straight into the next output word.
                    let ok := staticcall(gas(), shr(96, calldataload(t)), 0, 36, out, 32)
                    if iszero(and(ok, gt(returndatasize(), 31))) { revert(0, 0) }
                    out := add(out, 32)
                }
            }
            return(0x80, sub(out, 0x80))
        }
    }
}
