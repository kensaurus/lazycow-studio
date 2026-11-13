// Pinokio: install Lazycow Studio (EXPERIMENTAL, see pinokio.js). Pinokio provides Node, Python, uv and ffmpeg.
module.exports = {
  run: [
    { method: "shell.run", params: { message: ["npm ci --omit=dev --no-audit --no-fund"] } },
    {
      method: "shell.run",
      params: {
        venv: "env",
        message: [
          "{{platform === 'win32' ? 'uv pip install --require-hashes --torch-backend cpu -r py/requirements-win.lock' : 'uv pip install --require-hashes -r py/requirements-mac.lock'}}",
        ],
      },
    },
    { method: "shell.run", params: { message: ["conda install -y -c conda-forge ffmpeg"] } },
    {
      method: "shell.run",
      params: {
        env: { STUDIO_PY: "{{path.resolve(cwd, 'env', platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')}}" },
        message: ["node scripts/setup.mjs --data data"],
      },
    },
    { method: "notify", params: { html: "Lazycow Studio is installed. Press Start. Lazy Kenji is waiting on the bean bag." } },
  ],
}
