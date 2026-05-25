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
    console.error('[db] ❌ Cannot create directory for DATABASE_PATH:', dirname(dbPath), '—', e.message);
    console.error('[db]    This usually means DATABASE_PATH is set but no Render Disk is provisioned.');
    console.error('[db]    Fix: either remove DATABASE_PATH env var, or add a Render Disk mounted at', dirname(dbPath));
    console.warn('[db] Falling back to ephemeral local path:', defaultPath);
    dbPath = defaultPath;
  }
}

if (dbPath === defaultPath && (process.env.RENDER || process.env.RAILWAY_ENVIRONMENT)) {
  const platform = process.env.RENDER ? 'Render' : 'Railway';
  console.warn(`[db] ⚠️  Using ephemeral local path on ${platform} — database WILL be wiped on every redeploy.`);
  console.warn('[db]    All sessions become stale after a redeploy. Users must sign in again.');
  if (process.env.RENDER) {
    console.warn('[db]    To persist data: add a Render Disk and set DATABASE_PATH to its mount path.');
  } else {
    console.warn('[db]    To persist data: add a Railway Volume mounted at /data and set DATABASE_PATH=/data/aureon.db');
  }
}

const db = new Database(dbPath);
console.log('[db] opened:', dbPath);

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

// ── Portfolio holdings FK migration ───────────────────────────────────────────
// If the production DB was created with an older schema that had coin_id referencing
// a coins/assets table that no longer exists, every INSERT fails with FOREIGN KEY
// constraint failed. SQLite cannot drop constraints via ALTER TABLE — the only fix
// is to recreate the table. This runs once at startup and exits immediately when
// the schema is already correct (no non-user FKs present).
{
  const fks = db.prepare("PRAGMA foreign_key_list('portfolio_holdings')").all();
  const stale = fks.filter(fk => fk.table !== 'users');
  if (stale.length > 0) {
    console.log('[db] 🔧 portfolio_holdings has stale FK constraint(s):', stale.map(f => `${f.from}→${f.table}`).join(', '));
    console.log('[db] 🔧 Recreating table to remove invalid FK — existing data will be preserved.');

    const existingCols = db.prepare("PRAGMA table_info('portfolio_holdings')").all().map(c => c.name);
    const allCols = ['id', 'user_id', 'coin_id', 'amount', 'avg_buy_price', 'note', 'created_at', 'coin_name', 'coin_symbol', 'entry_price'];
    const selectCols = allCols.map(c => existingCols.includes(c) ? c : `NULL AS ${c}`).join(', ');

    db.pragma('foreign_keys = OFF');
    try {
      db.exec(`
        DROP TABLE IF EXISTS _ph_migrate;
        CREATE TABLE _ph_migrate (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          coin_id       TEXT NOT NULL,
          amount        REAL NOT NULL,
          avg_buy_price REAL,
          note          TEXT,
          created_at    INTEGER NOT NULL,
          coin_name     TEXT,
          coin_symbol   TEXT,
          entry_price   REAL
        );
        INSERT INTO _ph_migrate (id, user_id, coin_id, amount, avg_buy_price, note, created_at, coin_name, coin_symbol, entry_price)
          SELECT ${selectCols} FROM portfolio_holdings;
        DROP TABLE portfolio_holdings;
        ALTER TABLE _ph_migrate RENAME TO portfolio_holdings;
      `);
      console.log('[db] ✅ portfolio_holdings migration complete — stale FK constraint removed.');
    } catch (e) {
      console.error('[db] ❌ portfolio_holdings migration FAILED:', e.message);
      console.error('[db]    The _ph_migrate table may be partially created. Drop it via sqlite3 and restart.');
    } finally {
      db.pragma('foreign_keys = ON');
    }
  }
}

export { dbPath };
export default db;
