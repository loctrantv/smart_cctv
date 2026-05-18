const crypto = require('crypto');

// Use static secret from environment or generate a secure one that stays active during server lifetime
const SECRET = process.env.JWT_SECRET || 'smart_cctv_secure_signing_key_2026';

/**
 * Generate a lightweight JWT token using native crypto
 */
function generateToken(username) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    username,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000 // 7 days expiration
  })).toString('base64url');
  
  const signature = crypto
    .createHmac('sha256', SECRET)
    .update(`${header}.${payload}`)
    .digest('base64url');
    
  return `${header}.${payload}.${signature}`;
}

/**
 * Verify token and return payload if valid, otherwise null
 */
function verifyToken(token) {
  try {
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    
    const [header, payload, signature] = parts;
    const expectedSignature = crypto
      .createHmac('sha256', SECRET)
      .update(`${header}.${payload}`)
      .digest('base64url');
      
    if (signature !== expectedSignature) return null;
    
    const decodedPayload = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (decodedPayload.exp < Date.now()) {
      return null; // Token expired
    }
    
    return decodedPayload;
  } catch (err) {
    return null;
  }
}

module.exports = {
  generateToken,
  verifyToken
};
