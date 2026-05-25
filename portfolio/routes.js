import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import db from '../auth/db.js';

// Schema is owned by auth/db.js — coin_name, coin_symbol, entry_price columns
// are added there via ALTER TABLE migrations on startup.

const router = Router();

router.get('/', requireAuth, (req, res) => {
  try {
    const holdings = db.prepare(
      'SELECT id, user_id, coin_id, coin_name, coin_symbol, amount, entry_price, created_at FROM portfolio_holdings WHERE user_id = ? ORDER BY created_at DESC'
    ).all(req.userId);
    console.log('[portfolio GET] userId:', req.userId, '— rows:', holdings.length);
    res.json({ holdings });
  } catch (err) {
    console.error('[portfolio GET] db error:', err.message);
    res.status(500).json({ error: 'Failed to load holdings' });
  }
});

router.post('/', requireAuth, (req, res) => {
  console.log('[portfolio POST] route version=FK_DIAGNOSTIC_V1');
  console.log('[portfolio POST] incoming body:', JSON.stringify(req.body));
  const { coinId: rawCoinId, coinName, coinSymbol, amount, entryPrice } = req.body;

  // Normalize coinId — lowercase + trim to prevent casing mismatches
  const coinId = typeof rawCoinId === 'string' ? rawCoinId.trim().toLowerCase() : rawCoinId;

  console.log('[portfolio POST] received — coinId:', coinId, '| coinName:', coinName, '| coinSymbol:', coinSymbol, '| amount:', amount, '| entryPrice:', entryPrice);

  const missing = [];
  if (!coinId)     missing.push('coinId');
  if (!coinName)   missing.push('coinName');
  if (!coinSymbol) missing.push('coinSymbol');
  if (!amount)     missing.push('amount');
  if (!entryPrice) missing.push('entryPrice');
  if (missing.length > 0) {
    const resp = { error: 'Missing required fields', missing };
    console.warn('[portfolio POST] validation failed — missing:', missing.join(', '));
    return res.status(400).json(resp);
  }

  const amountNum     = Number(amount);
  const entryPriceNum = Number(entryPrice);
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    console.warn('[portfolio POST] validation failed — amount invalid:', amount);
    return res.status(400).json({ error: 'amount must be a positive number', received: String(amount) });
  }
  if (!Number.isFinite(entryPriceNum) || entryPriceNum <= 0) {
    console.warn('[portfolio POST] validation failed — entryPrice invalid:', entryPrice);
    return res.status(400).json({ error: 'entryPrice must be a positive number', received: String(entryPrice) });
  }

  // Confirm user exists — belt-and-suspenders even though requireAuth already checks
  const userRow = db.prepare('SELECT id, email FROM users WHERE id = ?').get(req.userId);
  console.log('[portfolio POST] user exists:', !!userRow, '| userId:', req.userId, userRow ? `(${userRow.email})` : '(NOT FOUND)');
  if (!userRow) {
    return res.status(401).json({ error: 'Session expired. Please sign in again.' });
  }

  const now          = Date.now();
  const insertSql    = 'INSERT INTO portfolio_holdings (user_id, coin_id, coin_name, coin_symbol, amount, entry_price, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)';
  const insertParams = [req.userId, coinId, coinName, coinSymbol, amountNum, entryPriceNum, now];
  console.log('[portfolio POST] insert target — userId:', req.userId, '| coinId:', coinId);
  try {
    const result = db.prepare(insertSql).run(...insertParams);
    const holding = db.prepare(
      'SELECT id, user_id, coin_id, coin_name, coin_symbol, amount, entry_price, created_at FROM portfolio_holdings WHERE id = ?'
    ).get(result.lastInsertRowid);
    console.log('[portfolio POST] insert OK — rowid:', result.lastInsertRowid, '| holding:', JSON.stringify(holding));
    res.json({ holding });
  } catch (err) {
    console.error('[portfolio POST] db insert FAILED — message:', err.message, '| code:', err.code);
    if (err.message?.includes('FOREIGN KEY')) {
      // Identify which FK is failing to pinpoint the root cause
      const userCheck = db.prepare('SELECT 1 FROM users WHERE id = ?').get(req.userId);
      const activeFks = db.prepare("PRAGMA foreign_key_list('portfolio_holdings')").all();
      console.error('[portfolio POST] FK diagnosis — user exists:', !!userCheck, '| userId:', req.userId);
      console.error('[portfolio POST] FK diagnosis — active FKs:', JSON.stringify(activeFks));
      const source = !userCheck ? 'users table (user_id not found)' : 'unknown — check FK list above';
      console.error('[portfolio POST] FK failure source:', source);
    }
    res.status(500).json({ error: 'Failed to save holding', detail: err.message, code: err.code ?? null });
  }
});

router.delete('/:id', requireAuth, (req, res) => {
  try {
    const holding = db.prepare(
      'SELECT * FROM portfolio_holdings WHERE id = ? AND user_id = ?'
    ).get(req.params.id, req.userId);
    if (!holding) return res.status(404).json({ error: 'Holding not found' });
    db.prepare('DELETE FROM portfolio_holdings WHERE id = ?').run(req.params.id);
    console.log('[portfolio DELETE] deleted id:', req.params.id, 'for user:', req.userId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[portfolio DELETE] db error:', err.message);
    res.status(500).json({ error: 'Failed to delete holding' });
  }
});

export default router;
