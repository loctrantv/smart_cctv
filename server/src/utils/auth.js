const crypto = require('crypto');

const INSECURE_SECRETS = new Set([
  'smart_cctv_secure_signing_key_2026',
  'your_custom_jwt_signing_key_here',
  'your_random_secret_key',
  'replace_with_a_secure_random_64_char_hex_string_before_deploying',
]);

let runtimeSecret = process.env.JWT_SECRET;

if (!runtimeSecret || INSECURE_SECRETS.has(runtimeSecret) || runtimeSecret.length < 16) {
  if (process.env.NODE_ENV === 'production' && !runtimeSecret) {
    console.warn(
      '[SECURITY WARNING] JWT_SECRET is not set or uses an example placeholder. ' +
      'Generated an ephemeral random 256-bit secret for this process. ' +
      'Set a strong JWT_SECRET in .env so sessions persist across PM2 restarts!'
    );
  }
  if (!runtimeSecret || INSECURE_SECRETS.has(runtimeSecret)) {
    runtimeSecret = crypto.randomBytes(32).toString('hex');
  }
}

/**
 * Hash a plaintext password using native Node.js scrypt with a random 16-byte salt
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derivedKey}`;
}

/**
 * Verify a plaintext password against a stored scrypt hash using timingSafeEqual
 */
function verifyPassword(password, storedHash) {
  try {
    if (!password || !storedHash) return false;
    const parts = storedHash.split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const [, salt, keyHex] = parts;
    const keyBuffer = Buffer.from(keyHex, 'hex');
    const derivedBuffer = crypto.scryptSync(password, salt, 64);
    if (keyBuffer.length !== derivedBuffer.length) return false;
    return crypto.timingSafeEqual(keyBuffer, derivedBuffer);
  } catch {
    return false;
  }
}

/**
 * Generate a signed JWT token using HMAC-SHA256
 * @param {string} username
 * @param {number} tokenVersion - increments on password change to invalidate older tokens
 * @param {number} ttlMs - default 24 hours
 */
function generateToken(username, tokenVersion = 1, ttlMs = 24 * 60 * 60 * 1000) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      username,
      v: tokenVersion,
      iat: Date.now(),
      exp: Date.now() + ttlMs,
    })
  ).toString('base64url');

  const signature = crypto
    .createHmac('sha256', runtimeSecret)
    .update(`${header}.${payload}`)
    .digest('base64url');

  return `${header}.${payload}.${signature}`;
}

/**
 * Verify JWT token using constant-time signature comparison
 */
function verifyToken(token) {
  try {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [header, payload, signature] = parts;
    const expectedSignature = crypto
      .createHmac('sha256', runtimeSecret)
      .update(`${header}.${payload}`)
      .digest('base64url');

    const sigBuf = Buffer.from(signature, 'utf8');
    const expBuf = Buffer.from(expectedSignature, 'utf8');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return null;
    }

    const decodedPayload = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!decodedPayload.exp || decodedPayload.exp < Date.now()) {
      return null;
    }

    return decodedPayload;
  } catch {
    return null;
  }
}

/**
 * Parse Cookie header into key-value object
 */
function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach((cookie) => {
    const idx = cookie.indexOf('=');
    if (idx === -1) return;
    const name = cookie.slice(0, idx).trim();
    const val = cookie.slice(idx + 1).trim();
    if (name) {
      try {
        list[name] = decodeURIComponent(val);
      } catch {
        list[name] = val;
      }
    }
  });
  return list;
}

module.exports = {
  hashPassword,
  verifyPassword,
  generateToken,
  verifyToken,
  parseCookies,
};
