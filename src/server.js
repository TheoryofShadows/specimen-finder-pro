'use strict';

require('dotenv').config();

const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const { openDb } = require('./db');
const { authMiddleware } = require('./auth');
const { createRouter, createWebhookHandler } = require('./routes');

const PORT = Number(process.env.PORT || 3000);

function securityHeaders(_req, res, next) {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data: https:",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "connect-src 'self'",
  ].join('; '));
  next();
}

function createApp(options = {}) {
  const db = options.db || openDb(options.dbPath);
  let stripe = null;
  if (process.env.STRIPE_SECRET_KEY) {
    const Stripe = require('stripe');
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  }

  const app = express();
  app.use(securityHeaders);

  app.post(
    '/webhooks/stripe',
    express.raw({ type: 'application/json' }),
    createWebhookHandler(db, stripe)
  );

  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use(cookieParser());
  app.use(authMiddleware(db));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use(createRouter(db, stripe));

  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return { app, db, stripe };
}

if (require.main === module) {
  const { app } = createApp();
  const server = app.listen(PORT, () => {
    console.log(`Specimen Finder Pro listening on :${PORT}`);
  });
  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createApp };
