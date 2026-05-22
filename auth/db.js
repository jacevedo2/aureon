import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const dir         = dirname(fileURLToPath(import.meta.url));
const defaultPath = join(dir, '..', 'aureon.db');
let   dbPath      = process.env.DATABASE_PATH || defaultPath;

// Ensure the parent directory exists (needed when DATABASE_PATH points at a volume mount).
// If the directory can't be created (e.g. /data on Render Free without a Disk provisioned),
// fall back to the project-root default so the server keeps running.
if (dbPath !== defaultPath) {
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
  } catch (e) {
    console.warn('[db] Cannot create directory for DATABASE_PATH:', dirname(dbPath), '—', e.message);
    console.warn('[db] Falling back to default path:', defaultPath);
    dbPath = defaultPath;
  }
}

const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt          TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_data (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, key)
  );

  CREATE TABLE IF NOT EXISTS portfolio_holdings (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    coin_id       TEXT NOT NULL,
    amount        REAL NOT NULL,
    avg_buy_price REAL,
    note          TEXT,
    created_at    INTEGER NOT NULL
  );
`);

// ── Safe column migrations ─────────────────────────────────────────────────────
// Runs AFTER CREATE TABLE so the table always exists first.
// Each ALTER TABLE is silently ignored if the column already exists.
for (const sql of [
  'ALTER TABLE users ADD COLUMN verified          INTEGER DEFAULT 0',
  'ALTER TABLE users ADD COLUMN verified_at       INTEGER',
  'ALTER TABLE users ADD COLUMN verification_token TEXT',
  'ALTER TABLE users ADD COLUMN verification_token_expires INTEGER',
  // portfolio/routes.js needs these three columns — the original schema predates that route
  'ALTER TABLE portfolio_holdings ADD COLUMN coin_name   TEXT',
  'ALTER TABLE portfolio_holdings ADD COLUMN coin_symbol TEXT',
  'ALTER TABLE portfolio_holdings ADD COLUMN entry_price REAL',
]) {
  try { db.exec(sql); } catch (e) { /* column already exists — safe to ignore */ }
}

export default db;
