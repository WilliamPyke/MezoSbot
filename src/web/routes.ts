import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import { ethers } from "ethers";
import { renderArcadePlayPage } from "../arcade/web.js";
import {
  clearSessionCookie,
  createNonce,
  readSession,
  setSessionCookie,
  verifyLogin,
} from "./auth.js";
import {
  cancelWebRematch,
  createSessionDraft,
  getWebSession,
  markCreated,
  markJoined,
  requestWebRematch,
  type WebArcadeSessionRow,
} from "./db.js";
import { applyWebMove, buildGameState, buildWalletArcadePlayState, submitWebScore } from "./game.js";
import { chainConfigForId, webChainsConfig } from "./chains.js";
import {
  enqueueWallet,
  getMyQueueEntry,
  leaveQueue,
} from "../arcade/matchmaking.js";
import type { Move } from "../arcade/types.js";

const MAX_BODY_BYTES = 128 * 1024;

export async function handleWalletWebRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  if (url.pathname.startsWith("/web/play/") && (req.method ?? "GET").toUpperCase() === "GET") {
    const sessionId = normalizeSessionId(url.pathname.split("/").filter(Boolean)[2] ?? "");
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(renderArcadePlayPage({
      requiresToken: false,
      missingAccessHtml: '<div class="wrap"><h2>Sign in required.</h2><p>Return to the arcade lobby and sign in with your wallet.</p></div>',
      statePath: `/api/web/play/${sessionId}/state`,
      movePath: `/api/web/play/${sessionId}/move`,
      submitPath: `/api/web/play/${sessionId}/submit`,
      doneMessage: "You can close this tab — escrow settlement is recorded on-chain.",
    }));
    return true;
  }

  if (!url.pathname.startsWith("/api/web")) return false;

  try {
    const method = (req.method ?? "GET").toUpperCase();
    const parts = url.pathname.split("/").filter(Boolean);

    if (method === "GET" && url.pathname === "/api/web/config") {
      return sendJson(res, 200, {
        ...webChainsConfig(),
        escrowAbi: "MallardGameEscrow",
      });
    }

    if (method === "GET" && url.pathname === "/api/web/me") {
      return sendJson(res, 200, { session: readSession(req) });
    }

    if (method === "POST" && url.pathname === "/api/web/auth/nonce") {
      const body = await readJsonBody(req);
      const address = stringField(body, "address");
      const chainId = numberField(body, "chainId");
      return sendJson(res, 200, await createNonce(address, chainId));
    }

    if (method === "POST" && url.pathname === "/api/web/auth/verify") {
      const body = await readJsonBody(req);
      const result = await verifyLogin({
        address: stringField(body, "address"),
        chainId: numberField(body, "chainId"),
        nonce: stringField(body, "nonce"),
        signature: stringField(body, "signature"),
      });
      if (!result.ok) return sendJson(res, 401, { error: result.error });
      setSessionCookie(res, result.session);
      return sendJson(res, 200, { session: result.session });
    }

    if (method === "POST" && url.pathname === "/api/web/auth/logout") {
      clearSessionCookie(res);
      return sendJson(res, 200, { ok: true });
    }

    if (method === "POST" && url.pathname === "/api/web/sessions") {
      const session = requireSession(req);
      const body = await readJsonBody(req);
      const chainId = numberField(body, "chainId");
      if (session.chainId !== chainId) throw new Error("Sign in on the selected network before creating a session");
      const draft = await createSessionDraft({
        playerA: session.address,
        invitedPlayer: optionalStringField(body, "invitedPlayer"),
        assetAddress: stringField(body, "assetAddress"),
        stakeAmountUnits: stringField(body, "stakeAmountUnits"),
        chainId,
      });
      return sendJson(res, 200, { session: withContractArgs(draft) });
    }

    if (parts[2] === "sessions" && parts[3]) {
      const sessionId = normalizeSessionId(parts[3]);

      if (method === "GET" && parts.length === 4) {
        const row = await getWebSession(sessionId);
        if (!row) return sendJson(res, 404, { error: "Session not found" });
        const wallet = readSession(req);
        const state = wallet ? await buildGameState(sessionId, wallet.address) : null;
        return sendJson(res, 200, { session: withContractArgs(row), game: state });
      }

      if (method === "POST" && parts[4] === "created") {
        const wallet = requireSession(req);
        const row = await getWebSession(sessionId);
        if (!row) return sendJson(res, 404, { error: "Session not found" });
        if (wallet.chainId !== row.chain_id) throw new Error("Sign in on this session's network before updating it");
        const body = await readJsonBody(req);
        return sendJson(res, 200, { session: withContractArgs(await markCreated(sessionId, wallet.address, stringField(body, "txHash"))) });
      }

      if (method === "POST" && parts[4] === "joined") {
        const wallet = requireSession(req);
        const row = await getWebSession(sessionId);
        if (!row) return sendJson(res, 404, { error: "Session not found" });
        if (wallet.chainId !== row.chain_id) throw new Error("Sign in on this session's network before joining");
        const body = await readJsonBody(req);
        return sendJson(res, 200, { session: withContractArgs(await markJoined(sessionId, wallet.address, stringField(body, "txHash"))) });
      }

      if (method === "GET" && parts[4] === "state") {
        const wallet = requireSession(req);
        return sendJson(res, 200, await buildGameState(sessionId, wallet.address));
      }

      if (method === "POST" && parts[4] === "move") {
        const wallet = requireSession(req);
        const body = await readJsonBody(req);
        const move = readWalletMove(body);
        return sendJson(res, 200, await applyWebMove(sessionId, wallet.address, move));
      }

      if (method === "POST" && parts[4] === "submit") {
        const wallet = requireSession(req);
        return sendJson(res, 200, await submitWebScore(sessionId, wallet.address));
      }
    }

    if (parts[2] === "queue") {
      if (method === "POST" && parts.length === 3) {
        const session = requireSession(req);
        const body = await readJsonBody(req);
        const chainId = numberField(body, "chainId");
        if (session.chainId !== chainId) {
          throw new Error("Sign in on the selected network before joining the queue");
        }
        const result = await enqueueWallet({
          walletAddress: session.address,
          chainId,
          assetAddress: stringField(body, "assetAddress"),
          stakeAmountUnits: stringField(body, "stakeAmountUnits"),
        });
        if (!result.ok) return sendJson(res, 400, { error: result.error });
        if (result.status === "paired") {
          return sendJson(res, 200, {
            status: "paired",
            session: withContractArgs(result.session),
            opponent: result.opponent,
            role: result.role,
          });
        }
        return sendJson(res, 200, { status: "waiting", entry: result.entry });
      }

      if (method === "GET" && parts.length === 3) {
        const session = requireSession(req);
        const entry = await getMyQueueEntry("wallet", session.address);
        if (!entry) return sendJson(res, 200, { status: "idle" });
        if (entry.status === "paired" && entry.session_id) {
          const row = await getWebSession(entry.session_id);
          if (row) {
            return sendJson(res, 200, {
              status: "paired",
              session: withContractArgs(row),
              opponent: entry.paired_with,
              // The waiter (player A on the resulting session) is the
              // creator; the joiner is invited.
              role: row.player_a_address.toLowerCase() === session.address.toLowerCase()
                ? "creator"
                : "joiner",
            });
          }
        }
        return sendJson(res, 200, { status: entry.status, entry });
      }

      if (method === "DELETE" && parts.length === 3) {
        const session = requireSession(req);
        const left = await leaveQueue("wallet", session.address);
        return sendJson(res, 200, { ok: true, left });
      }
    }

    if (parts[2] === "play" && parts[3]) {
      const sessionId = normalizeSessionId(parts[3]);

      if (method === "GET" && parts[4] === "state") {
        const wallet = requireSession(req);
        return sendJson(res, 200, await buildWalletArcadePlayState(sessionId, wallet.address));
      }

      if (method === "POST" && parts[4] === "move") {
        const wallet = requireSession(req);
        const body = await readJsonBody(req);
        const move = readWalletMove(body);
        await applyWebMove(sessionId, wallet.address, move);
        return sendJson(res, 200, await buildWalletArcadePlayState(sessionId, wallet.address));
      }

      if (method === "POST" && parts[4] === "submit") {
        const wallet = requireSession(req);
        await submitWebScore(sessionId, wallet.address);
        return sendJson(res, 200, await buildWalletArcadePlayState(sessionId, wallet.address));
      }

      if (method === "POST" && parts[4] === "rematch" && parts[5] === "cancel") {
        const wallet = requireSession(req);
        const result = await cancelWebRematch(sessionId, wallet.address);
        if (!result.ok) return sendJson(res, 400, { error: result.error ?? "Cancel failed" });
        return sendJson(res, 200, { ok: true });
      }

      if (method === "POST" && parts[4] === "rematch" && parts.length === 5) {
        const wallet = requireSession(req);
        const result = await requestWebRematch(sessionId, wallet.address);
        if (result.status === "error") return sendJson(res, 400, { error: result.error });
        const body: Record<string, unknown> = { status: result.status };
        if (result.status === "created") {
          body.nextSessionId = result.nextSessionId;
          body.redirect = `/session/${result.nextSessionId}`;
        }
        return sendJson(res, 200, body);
      }
    }

    return sendJson(res, 404, { error: "not_found" });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    const status = message.includes("Unauthorized") ? 401 : message.includes("not found") ? 404 : 400;
    return sendJson(res, status, { error: message });
  }
}

function withContractArgs(session: WebArcadeSessionRow) {
  const chain = chainConfigForId(session.chain_id);
  return {
    ...session,
    chain: {
      network: chain.network,
      chainId: chain.chainId,
      chainName: chain.chainName,
      explorerUrl: chain.explorerUrl,
      escrowContractAddress: session.escrow_contract_address,
    },
    contractArgs: {
      sessionId: session.id,
      invitedPlayer: session.invited_player_address ?? ethers.ZeroAddress,
      asset: ethers.getAddress(session.asset_address),
      stakeAmount: session.stake_amount_units,
      joinDeadline: Math.floor(Date.parse(session.join_deadline) / 1000),
      playDeadline: Math.floor(Date.parse(session.play_deadline) / 1000),
    },
  };
}

function requireSession(req: IncomingMessage) {
  const session = readSession(req);
  if (!session) throw new Error("Unauthorized");
  return session;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk instanceof Buffer ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error("Body too large");
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`Bad field: ${key}`);
  return value.trim();
}

function optionalStringField(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new Error(`Bad field: ${key}`);
  return value.trim() || null;
}

function numberField(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Bad field: ${key}`);
  return Math.trunc(value);
}

function readWalletMove(body: Record<string, unknown>): Move {
  const kind = typeof body.kind === "string" ? body.kind : "place";
  if (kind === "bank") {
    return {
      kind: "bank",
      level: numberField(body, "level"),
      pieceIndex: numberField(body, "pieceIndex"),
    };
  }
  return {
    level: numberField(body, "level"),
    pieceIndex: numberField(body, "pieceIndex"),
    rotation: (numberField(body, "rotation") % 4) as 0 | 1 | 2 | 3,
    row: numberField(body, "row"),
    col: numberField(body, "col"),
  };
}

function normalizeSessionId(raw: string): string {
  const value = decodeURIComponent(raw);
  if (!/^0x[a-fA-F0-9]{64}$/.test(value)) throw new Error("Bad session id");
  return value.toLowerCase();
}

function sendJson(res: ServerResponse, status: number, payload: unknown): true {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
  return true;
}
