const express = require('express');
const router = express.Router();
const { generateToken, verifyPassword, hashPassword } = require('../utils/auth');
const authMiddleware = require('../middleware/auth');

// ============================================
// Brute-force Protection (In-Memory Rate Limiter)
// Max 5 failed login attempts per IP within 15 minutes
// ============================================
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 5;
const loginAttempts = new Map(); // ip -> { count, resetAt }

function getClientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry) return { allowed: true };
  if (now > entry.resetAt) {
    loginAttempts.delete(ip);
    return { allowed: true };
  }
  if (entry.count >= MAX_FAILED_ATTEMPTS) {
    const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000);
    return { allowed: false, retryAfterSec };
  }
  return { allowed: true };
}

function recordFailedAttempt(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

function clearFailedAttempts(ip) {
  loginAttempts.delete(ip);
}

// Periodically purge expired rate-limit entries
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts.entries()) {
    if (now > entry.resetAt) loginAttempts.delete(ip);
  }
}, 5 * 60 * 1000).unref();

function setSessionCookie(req, res, token) {
  const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const maxAgeSec = 24 * 60 * 60; // 24 hours
  const parts = [
    `smart_cctv_session=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ];
  if (isSecure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader(
    'Set-Cookie',
    'smart_cctv_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'
  );
}

/**
 * POST /api/auth/login
 * Authenticate admin user, set HttpOnly session cookie, and return JWT token
 */
router.post('/login', (req, res) => {
  try {
    const ip = getClientIp(req);
    const rate = checkRateLimit(ip);
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(rate.retryAfterSec));
      return res.status(429).json({
        error: `Quá nhiều lần đăng nhập sai. Vui lòng thử lại sau ${Math.ceil(rate.retryAfterSec / 60)} phút.`,
      });
    }

    const { username, password } = req.body || {};

    if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'Vui lòng nhập tên đăng nhập và mật khẩu' });
    }

    const user = req.db
      .prepare('SELECT * FROM users WHERE username = ?')
      .get(username.trim());

    if (!user || !verifyPassword(password, user.password_hash)) {
      recordFailedAttempt(ip);
      return res.status(401).json({ error: 'Tên đăng nhập hoặc mật khẩu không chính xác' });
    }

    clearFailedAttempts(ip);
    const token = generateToken(user.username, user.token_version);
    setSessionCookie(req, res, token);

    return res.json({
      token,
      user: { username: user.username },
    });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi máy chủ khi đăng nhập' });
  }
});

/**
 * POST /api/auth/logout
 * Clear HttpOnly session cookie
 */
router.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ message: 'Đã đăng xuất' });
});

/**
 * GET /api/auth/verify
 * Check if the active token / cookie is still valid
 */
router.get('/verify', authMiddleware, (req, res) => {
  res.json({
    status: 'ok',
    user: { username: req.user.username },
  });
});

/**
 * PUT /api/auth/password
 * Change password and increment token_version to revoke older sessions
 */
router.put('/password', authMiddleware, (req, res) => {
  try {
    const { currentPassword, newPassword, newUsername } = req.body || {};

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Vui lòng nhập mật khẩu hiện tại và mật khẩu mới' });
    }

    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      return res.status(400).json({ error: 'Mật khẩu mới phải có ít nhất 8 ký tự' });
    }

    const user = req.db
      .prepare('SELECT * FROM users WHERE username = ?')
      .get(req.user.username);

    if (!user || !verifyPassword(currentPassword, user.password_hash)) {
      return res.status(401).json({ error: 'Mật khẩu hiện tại không chính xác' });
    }

    const updatedUsername =
      newUsername && typeof newUsername === 'string' && newUsername.trim().length >= 3
        ? newUsername.trim()
        : user.username;

    const nextVersion = (user.token_version || 1) + 1;
    const newHash = hashPassword(newPassword);

    req.db
      .prepare(`
        UPDATE users
        SET username = ?, password_hash = ?, token_version = ?, updated_at = datetime('now')
        WHERE id = ?
      `)
      .run(updatedUsername, newHash, nextVersion, user.id);

    const newToken = generateToken(updatedUsername, nextVersion);
    setSessionCookie(req, res, newToken);

    res.json({
      message: 'Đổi mật khẩu thành công',
      token: newToken,
      user: { username: updatedUsername },
    });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Tên đăng nhập đã tồn tại' });
    }
    res.status(500).json({ error: 'Không thể cập nhật mật khẩu' });
  }
});

module.exports = router;
