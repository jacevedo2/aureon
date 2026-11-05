// GET /api/xrp/wallets — read-only, unauthenticated (public ledger data), served from the service cache.
// There is deliberately no POST/refresh endpoint: clients cannot trigger upstream scans.
import { Router } from 'express';

export function createXrpRouter(service) {
  const router = Router();
  router.get('/wallets', (req, res) => {
    res.set('Cache-Control', 'public, max-age=60');
    res.json(service.getResponse());
  });
  return router;
}
