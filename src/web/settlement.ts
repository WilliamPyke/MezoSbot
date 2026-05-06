import { ethers } from "ethers";
import { config } from "../config.js";
import { mallardGameEscrowAbi } from "./abi.js";
import { recordSettlementAttempt, type WebArcadeSessionRow } from "./db.js";
import { chainConfigForId } from "./chains.js";

export async function settleOrRefundOnChain(input: {
  session: WebArcadeSessionRow;
  action: "settle" | "refund";
  resultHash: string;
  winner?: string;
  reasonHash?: string;
}): Promise<string | null> {
  const chain = chainConfigForId(input.session.chain_id);
  const escrowContractAddress = input.session.escrow_contract_address || chain.escrowContractAddress;
  if (!escrowContractAddress || !config.web.escrowSettlerPrivateKey) {
    await recordSettlementAttempt({
      sessionId: input.session.id,
      action: input.action,
      resultHash: input.resultHash,
      status: "skipped",
      error: "Escrow contract or settler private key is not configured",
    });
    return null;
  }

  try {
    await recordSettlementAttempt({
      sessionId: input.session.id,
      action: input.action,
      resultHash: input.resultHash,
      status: "pending",
    });

    const provider = new ethers.JsonRpcProvider(chain.rpcUrl, {
      chainId: chain.chainId,
      name: chain.network === "mainnet" ? "mezo" : "mezo-testnet",
    }, {
      staticNetwork: true,
      batchMaxCount: 1,
    });
    const signer = new ethers.Wallet(config.web.escrowSettlerPrivateKey, provider);
    const contract = new ethers.Contract(escrowContractAddress, mallardGameEscrowAbi, signer);
    const tx =
      input.action === "settle"
        ? await contract.settleSession(input.session.id, input.winner, input.resultHash)
        : await contract.refundSession(input.session.id, input.reasonHash ?? input.resultHash);

    await recordSettlementAttempt({
      sessionId: input.session.id,
      action: input.action,
      resultHash: input.resultHash,
      txHash: tx.hash,
      status: "submitted",
    });
    return tx.hash as string;
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    await recordSettlementAttempt({
      sessionId: input.session.id,
      action: input.action,
      resultHash: input.resultHash,
      status: "failed",
      error: message,
    });
    throw new Error(`On-chain ${input.action} failed: ${message}`);
  }
}
