import { ethers } from "ethers";

/**
 * Domain-separated CREATE2 salt for a user's deposit forwarder. No secret is
 * an input: anyone can compute a user's deposit address, and nobody holds a
 * key for it. Funds there can only move to the factory's vault.
 */
export function depositSalt(discordId: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(`mezosbot-deposit-v2:${discordId}`));
}

/**
 * EIP-1167 init code used by OpenZeppelin Clones.cloneDeterministic:
 * 20-byte prefix, 20-byte implementation, 15-byte suffix.
 */
export function cloneInitCode(implementation: string): string {
  const address = ethers.getAddress(implementation).slice(2).toLowerCase();
  return `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${address}5af43d82803e903d91602b57fd5bf3`;
}

export function predictForwarder(factory: string, implementation: string, salt: string): string {
  const initCodeHash = ethers.keccak256(cloneInitCode(implementation));
  return ethers.getCreate2Address(ethers.getAddress(factory), salt, initCodeHash);
}

/** Bytes32 reference for a withdrawal row, used as HotPayout's replay key. */
export function withdrawalRef(withdrawalId: number | bigint): string {
  return ethers.keccak256(ethers.toUtf8Bytes(`mezosbot-withdrawal-v2:${withdrawalId.toString()}`));
}
