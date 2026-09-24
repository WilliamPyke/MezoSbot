import { DurableObject } from "cloudflare:workers";

type RoomMessage = { type: string; [key: string]: unknown };

/** Close codes that must never be sent on the wire (RFC 6455 §7.4.1). */
const RESERVED_CLOSE_CODES = new Set([1004, 1005, 1006, 1015]);

export function safeCloseCode(code: number): number {
  if (!Number.isInteger(code) || RESERVED_CLOSE_CODES.has(code)) return 1000;
  if (code === 1000 || (code >= 1001 && code <= 1014) || (code >= 3000 && code <= 4999)) return code;
  return 1000;
}

export class ArcadeRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Answered by the runtime without waking the hibernated object.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "room.connected", connections: this.ctx.getWebSockets().length }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async broadcast(message: RoomMessage): Promise<number> {
    const encoded = JSON.stringify(message);
    let delivered = 0;
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(encoded);
        delivered += 1;
      } catch {
        try { socket.close(1011, "broadcast failed"); } catch { /* already closed */ }
      }
    }
    return delivered;
  }

  async webSocketMessage(): Promise<void> {
    // Clients only listen; ping/pong is handled by the auto-response above.
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    try {
      socket.close(safeCloseCode(code), reason.slice(0, 120));
    } catch {
      // The runtime may already have completed the close handshake.
    }
  }
}
