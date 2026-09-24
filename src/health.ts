import http from "node:http";

export async function startBotHealth(port: number, status: () => Record<string, unknown>): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    // Lean bot role only (all games remote). Any other combination runs the
    // legacy stream.ts HTTP server, which serves /healthz plus the legacy
    // /arcade, /satscape and stream routes a local feature needs.
    const path = (request.url ?? "/").split("?")[0];
    if (path !== "/healthz" && path !== "/metrics") {
      response.writeHead(404).end("Not found");
      return;
    }
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    let body: string;
    try {
      body = JSON.stringify({ service: "bot", ...status() });
    } catch (error) {
      response.statusCode = 500;
      body = JSON.stringify({ service: "bot", status: "error", error: error instanceof Error ? error.message : String(error) });
    }
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => resolve());
  });
  console.log(`[Bot] Health server listening on :${port}`);
  return server;
}
