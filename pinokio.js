// Lazycow Studio in Pinokio (https://pinokio.computer): Install, Start, Update from Pinokio's menu.
// EXPERIMENTAL (13 Nov 2026): written from Pinokio's docs and examples, not yet run inside Pinokio. The double-click
// setup (Start Lazycow.cmd / .command, README.TXT) is the tested way.
const path = require("path")
module.exports = {
  version: "4.0",
  title: "Lazycow Studio",
  description: "Your own footage, made into short videos and trip videos on your own computer. You only review.",
  icon: "server/brand/icon-512.png",
  menu: async (kernel, info) => {
    const installed = info.exists("env") && info.exists("node_modules")
    const running = info.running("start.js")
    if (!installed) return [{ default: true, icon: "fa-solid fa-plug", text: "Install", href: "install.js" }]
    if (running) {
      const local = info.local("start.js")
      return [
        local && local.url ? { default: true, icon: "fa-solid fa-rocket", text: "Open Lazycow Studio", href: local.url } : { icon: "fa-solid fa-spinner", text: "Starting…", href: "start.js" },
        { icon: "fa-solid fa-terminal", text: "Terminal", href: "start.js" },
      ]
    }
    return [
      { default: true, icon: "fa-solid fa-power-off", text: "Start", href: "start.js" },
      { icon: "fa-solid fa-rotate", text: "Update", href: "update.js" },
      { icon: "fa-solid fa-plug", text: "Install again", href: "install.js" },
    ]
  },
}
