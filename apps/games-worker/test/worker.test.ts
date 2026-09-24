import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("games worker", () => {
  it("exposes a cheap health endpoint", async () => {
    const response = await SELF.fetch("https://arcade.mallard.sh/healthz");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "ok", service: "games-worker" });
  });

  it("rejects unsigned internal commands", async () => {
    const response = await SELF.fetch("https://arcade.mallard.sh/internal/v1/arcade/command", { method: "POST", body: "{}" });
    expect(response.status).toBe(401);
  });

  it("hibernates and reconnects ArcadeRoom spectators", async () => {
    const room = env.ARCADE_ROOMS.getByName("test-match");
    const first = await room.fetch("https://room.test", { headers: { upgrade: "websocket" } });
    expect(first.status).toBe(101);
    expect(first.webSocket).not.toBeNull();
    first.webSocket!.accept();

    const second = await room.fetch("https://room.test", { headers: { upgrade: "websocket" } });
    expect(second.status).toBe(101);
    second.webSocket!.accept();

    const message = new Promise<string>((resolve) => {
      second.webSocket!.addEventListener("message", (event) => {
        const value = String(event.data);
        if (value.includes('"type":"score"')) resolve(value);
      });
    });
    expect(await room.broadcast({ type: "score", value: 42 })).toBe(2);
    await expect(message).resolves.toContain('"value":42');

    first.webSocket!.close(1000, "test complete");
    second.webSocket!.close(1000, "test complete");
  });
});
