const fs = require('fs');
const path = require('path');

// Automatically prefer the compiled Rust AI NVR binary if built (`cargo build --release`),
// otherwise seamlessly fallback to the Node.js server (`server/src/index.js`).
const isWin = process.platform === 'win32';
const rustBinaryName = isWin ? 'smart-cctv-server.exe' : 'smart-cctv-server';
const rustBinaryPath = path.join(__dirname, 'target', 'release', rustBinaryName);
const useRust = fs.existsSync(rustBinaryPath);

module.exports = {
  apps: [
    useRust
      ? {
          name: 'smart-cctv',
          cwd: __dirname,
          script: rustBinaryPath,
          interpreter: 'none',
          instances: 1,
          exec_mode: 'fork',
          autorestart: true,
          watch: false,
          max_memory_restart: '1536M',
          env: {
            NODE_ENV: 'production',
            PORT: 3001,
            RUST_LOG: 'info',
          },
        }
      : {
          name: 'smart-cctv',
          cwd: path.join(__dirname, 'server'),
          script: 'src/index.js',
          instances: 1,
          exec_mode: 'fork',
          autorestart: true,
          watch: false,
          max_memory_restart: '1536M',
          env: {
            NODE_ENV: 'production',
            PORT: 3001,
          },
        },
  ],
};
