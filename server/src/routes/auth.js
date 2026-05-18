const express = require('express');
const router = express.Router();
const { generateToken } = require('../utils/auth');
const authMiddleware = require('../middleware/auth');

// Get credentials from environment variables
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

/**
 * POST /api/auth/login
 * Authenticate admin user and return a signed JWT token
 */
router.post('/login', (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    
    // Check credentials
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
      const token = generateToken(username);
      return res.json({
        token,
        user: { username }
      });
    }
    
    // Invalid credentials
    res.status(401).json({ error: 'Tên đăng nhập hoặc mật khẩu không chính xác' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/auth/verify
 * Check if the active token is still valid
 */
router.get('/verify', authMiddleware, (req, res) => {
  res.json({
    status: 'ok',
    user: req.user
  });
});

module.exports = router;
