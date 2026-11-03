// Requests the bot's /healthz every 10 minutes so Render's free service never reaches its
// 15-minute idle spin-down.
export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      fetch(`${env.RENDER_URL}/healthz`, { headers: { "user-agent": "mezosbot-keepalive" } }).then(
        (res) => console.log(`healthz ${res.status}`),
        (err) => console.error(`healthz failed: ${err.message}`),
      ),
    );
  },
};
