// Pinokio: start Lazycow Studio (EXPERIMENTAL, see pinokio.js). The server prints "review http://127.0.0.1:4317/ …".
module.exports = {
  daemon: true,
  run: [
    {
      method: "shell.run",
      params: {
        message: ["node server/review.mjs"],
        on: [{ event: "/review (http:\\/\\/[0-9.:]+\\/)/", done: true }],
      },
    },
    { method: "local.set", params: { url: "{{input.event[1]}}" } },
  ],
}
