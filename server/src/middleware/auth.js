const { verifyToken, parseCookies, generateToken } = require('../utils/auth');

/**
 * Extract token from HttpOnly Cookie, Authorization Bearer header, or query token
 */
function extractRequestToken(req) {
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    return req.headers.authorization.slice(7).trim();
  }
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.smart_cctv_session) {
    return cookies.smart_cctv_session;
  }
  if (req.query && req.query.token) {
    return req.query.token;
  }
  return null;
}

/**
 * Express middleware to enforce authentication and validate user token_version
 */
module.exports = function authMiddleware(req, res, next) {
  try {
    const token = extractRequestToken(req);

    if (!token) {
      return res.status(401).json({ error: 'Truy cập bị từ chối. Vui lòng đăng nhập.' });
    }

    const decoded = verifyToken(token);
    if (!decoded) {
      return res.status(401).json({ error: 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn.' });
    }

    // Verify user still exists and token_version matches (invalidates tokens when password changes)
    if (req.db) {
      const user = req.db
        .prepare('SELECT id, username, token_version FROM users WHERE username = ?')
        .get(decoded.username);
      if (!user || (decoded.v !== undefined && decoded.v !== user.token_version)) {
        return res.status(401).json({ error: 'Phiên đăng nhập đã hết hiệu lực. Vui lòng đăng nhập lại.' });
      }
      req.user = { id: user.id, username: user.username, token_version: user.token_version };

      // Auto-heal missing HttpOnly session cookie if client authenticated via Bearer header
      const cookies = parseCookies(req.headers.cookie);
      if (!cookies.smart_cctv_session && !res.headersSent) {
        const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
        const freshToken = generateToken(user.username, user.token_version);
        const parts = [
          `smart_cctv_session=${encodeURIComponent(freshToken)}`,
          'Path=/',
          'HttpOnly',
          'SameSite=Lax',
          `Max-Age=${24 * 60 * 60}`,
        ];
        if (isSecure) parts.push('Secure');
        res.setHeader('Set-Cookie', parts.join('; '));
      }
    } else {
      req.user = decoded;
    }

    next();
  } catch (err) {
    res.status(500).json({ error: 'Lỗi xác thực máy chủ' });
  }
};

module.exports.extractRequestToken = extractRequestToken;
