'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || '/data/specimen-finder-pro.db';

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function openDb(dbPath = DB_PATH) {
  ensureDir(dbPath);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT 'free' CHECK(plan IN ('free', 'pro')),
      stripe_customer_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS searches (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      query TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      scientific_name TEXT,
      gbif_taxon_key INTEGER,
      last_fetch_json TEXT,
      last_fetch_count INTEGER,
      last_fetch_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS annotations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      search_id TEXT NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
      gbif_key TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(search_id, gbif_key)
    );

    CREATE INDEX IF NOT EXISTS idx_searches_user ON searches(user_id);
    CREATE INDEX IF NOT EXISTS idx_annotations_search ON annotations(search_id);
    CREATE INDEX IF NOT EXISTS idx_users_stripe ON users(stripe_customer_id);
  `);

  return db;
}

module.exports = { openDb, DB_PATH };
