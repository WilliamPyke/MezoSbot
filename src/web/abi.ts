export const mallardGameEscrowAbi = [
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
  {
    type: "function",
    name: "settleSession",
    stateMutability: "nonpayable",
    inputs: [
      { name: "sessionId", type: "bytes32" },
      { name: "winner", type: "address" },
      { name: "resultHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "refundSession",
    stateMutability: "nonpayable",
    inputs: [
      { name: "sessionId", type: "bytes32" },
      { name: "reasonHash", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;
