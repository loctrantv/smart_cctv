const path = require('path');

module.exports = {
  apps: [
    {
      name: 'smart-cctv',
      cwd: path.join(__dirname, 'server'),
      script: 'src/index.js',
      instances: 1, // Keep at 1 because SQLite WAL + FFmpeg child processes are managed in-process
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
      },
    },
  ],
};
