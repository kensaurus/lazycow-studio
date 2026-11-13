// Pinokio: update Lazycow Studio to the newest code, then reinstall what changed (EXPERIMENTAL, see pinokio.js).
module.exports = {
  run: [
    { method: "shell.run", params: { message: ["git pull"] } },
    { method: "script.start", params: { uri: "install.js" } },
  ],
}
