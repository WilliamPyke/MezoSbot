export const escrowAbi = [
  {
    type: "function",
    name: "createSession",
    stateMutability: "payable",
    inputs: [
      { name: "sessionId", type: "bytes32" },
      { name: "invitedPlayer", type: "address" },
      { name: "asset", type: "address" },
      { name: "stakeAmount", type: "uint256" },
      { name: "joinDeadline", type: "uint64" },
      { name: "playDeadline", type: "uint64" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "joinSession",
    stateMutability: "payable",
    inputs: [{ name: "sessionId", type: "bytes32" }],
    outputs: [],
  },
] as const;

export const erc20Abi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;
