'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-change-me';
const JWT_COOKIE = 'sfp_token';
const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

function verifyPassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, plan: user.plan },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function setAuthCookie(res, token) {
  res.cookie(JWT_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: COOKIE_MAX_AGE_MS,
  });
}

function clearAuthCookie(res) {
  res.clearCookie(JWT_COOKIE);
}

function authMiddleware(db) {
  return (req, _res, next) => {
    const header = req.headers.authorization;
    const bearer = header && header.startsWith('Bearer ') ? header.slice(7) : null;
    const token = bearer || req.cookies?.[JWT_COOKIE];
    if (!token) {
      req.user = null;
      return next();
    }
    const payload = verifyToken(token);
    if (!payload) {
      req.user = null;
      return next();
    }
    const user = db
      .prepare('SELECT id, email, plan, stripe_customer_id FROM users WHERE id = ?')
      .get(payload.sub);
    req.user = user || null;
    next();
  };
}

function requireAuth(req, res, next) {
  if (!req.user) {
    if (req.accepts('html') && !req.path.startsWith('/api')) {
      return res.redirect('/login');
    }
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

module.exports = {
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  setAuthCookie,
  clearAuthCookie,
  authMiddleware,
  requireAuth,
  JWT_COOKIE,
  JWT_SECRET,
};
