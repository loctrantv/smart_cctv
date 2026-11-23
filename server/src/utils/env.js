const fs = require('fs');
const path = require('path');

/**
 * Load environment variables from a .env file without requiring external dependencies.
 * Does not overwrite existing environment variables.
 */
function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

/**
 * Initialize environment from root .env or server/.env
 */
function initEnv() {
  const rootEnv = path.resolve(__dirname, '..', '..', '..', '.env');
  const serverEnv = path.resolve(__dirname, '..', '..', '.env');
  loadEnvFile(rootEnv);
  loadEnvFile(serverEnv);
}

module.exports = { initEnv, loadEnvFile };
