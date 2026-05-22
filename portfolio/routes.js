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
  const { coinId, coinName, coinSymbol, amount, entryPrice } = req.body;

  const missing = [];
  if (!coinId)     missing.push('coinId');
  if (!coinName)   missing.push('coinName');
  if (!coinSymbol) missing.push('coinSymbol');
  if (!amount)     missing.push('amount');
  if (!entryPrice) missing.push('entryPrice');
  if (missing.length > 0) {
    console.warn('[portfolio POST] validation failed — missing fields:', missing.join(', '));
    return res.status(400).json({ error: 'Missing required fields', missing });
  }

  const amountNum     = Number(amount);
  const entryPriceNum = Number(entryPrice);
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }
  if (!Number.isFinite(entryPriceNum) || entryPriceNum <= 0) {
    return res.status(400).json({ error: 'entryPrice must be a positive number' });
  }

  console.log('[portfolio POST] validation passed — inserting for user', req.userId);
  try {
    const now    = new Date().toISOString();
    const result = db.prepare(
      'INSERT INTO portfolio_holdings (user_id, coin_id, coin_name, coin_symbol, amount, entry_price, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(req.userId, coinId, coinName, coinSymbol, amountNum, entryPriceNum, now);
    const holding = db.prepare(
      'SELECT id, user_id, coin_id, coin_name, coin_symbol, amount, entry_price, created_at FROM portfolio_holdings WHERE id = ?'
    ).get(result.lastInsertRowid);
    console.log('[portfolio POST] insert OK — rowid:', result.lastInsertRowid);
    res.json({ holding });
  } catch (err) {
    console.error('[portfolio POST] db error:', err.message, err.stack);
    res.status(500).json({ error: 'Failed to save holding', detail: err.message });
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
