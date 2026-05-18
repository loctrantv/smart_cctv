const { verifyToken } = require('../utils/auth');

/**
 * Express middleware to enforce authentication
 */
module.exports = function authMiddleware(req, res, next) {
  try {
    // 1. Get token from Authorization header or from query string (for media stream / snapshots)
    let token = null;
    
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    } else if (req.query && req.query.token) {
      token = req.query.token;
    }
    
    if (!token) {
      return res.status(401).json({ error: 'Access denied. No token provided.' });
    }
    
    // 2. Verify token
    const decoded = verifyToken(token);
    if (!decoded) {
      return res.status(401).json({ error: 'Access denied. Invalid or expired token.' });
    }
    
    // 3. Attach user payload to request
    req.user = decoded;
    next();
  } catch (err) {
    res.status(500).json({ error: 'Internal server authentication error' });
  }
};
