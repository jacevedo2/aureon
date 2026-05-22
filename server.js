// ── Process-level crash guards (must be first) ────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});

import express from 'express';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { existsSync } from 'fs';

import { validate }     from './assistant/validate.js';
import { buildContext } from './assistant/context.js';
import { buildPrompt }  from './assistant/prompt.js';
import { callModel }    from './assistant/model.js';
import { etfState, refreshEtfData } from './etf-loader.js';
import authRoutes       from './auth/routes.js';
import userRoutes       from './user/routes.js';
import portfolioRouter  from './portfolio/routes.js';
import alertsRouter          from './alerts/routes.js';
import conversationsRouter   from './conversations/routes.js';
import predictRouter         from './predict/routes.js';

// ── Startup diagnostics ───────────────────────────────────────────────────────
const apiKeyPresent = !!process.env.ANTHROPIC_API_KEY;
console.log('[startup] ANTHROPIC_API_KEY present:', apiKeyPresent);
if (!apiKeyPresent) console.error('[startup] ⚠️  ANTHROPIC_API_KEY missing — /api/assistant will return fallback on every call');
console.log('[startup] JWT_SECRET present:        ', !!process.env.JWT_SECRET);
console.log('[startup] DATABASE_PATH:             ', process.env.DATABASE_PATH || '(not set — using local aureon.db)');
console.log('[startup] EMAIL_FROM:                ', process.env.EMAIL_FROM    || '(not set — using Aureon <onboarding@resend.dev>)');
console.log('[startup] RESEND_API_KEY present:    ', !!process.env.RESEND_API_KEY);
if (!process.env.RESEND_API_KEY && process.env.RENDER) {
  console.error('[startup] ❌ RESEND_API_KEY missing on Render — verification emails will NOT be sent. Add it in Render → Environment.');
}
if (process.env.RESEND_API_KEY && !process.env.EMAIL_FROM) {
  console.warn('[startup] ⚠️  EMAIL_FROM not set — using onboarding@resend.dev (Resend sandbox domain). Set EMAIL_FROM to a verified custom domain for production delivery.');
}
console.log('[startup] ETF data source:           ', etfState.source);
console.log('[startup] ETF lastUpdated:           ', etfState.payload?.lastUpdated);
console.log('[startup] COINGLASS_API_KEY present: ', !!process.env.COINGLASS_API_KEY);
if (!process.env.COINGLASS_API_KEY) {
  console.warn('[startup] ⚠️  COINGLASS_API_KEY missing — ETF data will NOT be live (serving committed file).');
  console.warn('[startup]    Add COINGLASS_API_KEY to Render env vars to enable live institutional flow data.');
}
console.log('[startup] ETF_DATA_URL:              ', process.env.ETF_DATA_URL || '(not set)');

// Refresh ETF data every 4 hours so lastUpdated never goes stale between deploys
const ETF_REFRESH_MS = 4 * 60 * 60 * 1000;
setInterval(async () => {
  console.log('[ETF scheduler] running scheduled refresh');
  await refreshEtfData();
}, ETF_REFRESH_MS).unref(); // .unref() so the interval never blocks process exit

// Rate-limit tracker for POST /api/etf/refresh — avoids hammering CoinGlass
let lastForceRefreshMs = 0;
const FORCE_REFRESH_RATE_LIMIT_MS = 5 * 60 * 1000; // 5 minutes

// Load .env for local development only.
// On Railway/Render, env vars are injected natively — no .env file exists there.
const envFile = new URL('.env', import.meta.url).pathname;
if (existsSync(envFile)) {
  const { config } = await import('dotenv');
  config({ path: envFile });
}

const app = express();
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/portfolio', portfolioRouter);
app.use('/api/alerts', alertsRouter);
app.use('/api/conversations', conversationsRouter);
app.use('/api/predict', predictRouter);

// Shared helper — builds the /api/etf response body from current etfState.
function buildEtfResponse(extra = {}) {
  const { payload, source } = etfState;
  const ageMs   = payload.lastUpdated ? Date.now() - new Date(payload.lastUpdated).getTime() : null;
  const ageDays = ageMs != null ? Math.floor(ageMs / 86_400_000) : null;
  const isStale = ageDays != null && ageDays > 3;
  const staleReason = (source === 'coinglass-live' || source === 'remote-url')
    ? null
    : source === 'latest-file'
      ? 'Serving committed file — update latest-etf-data.json and git push, or set COINGLASS_API_KEY for live data'
      : 'Serving hardcoded fallback — no live source or committed file is current';

  return {
    ...payload,
    _meta: {
      source,
      isStale,
      ageDays,
      staleReason: isStale ? staleReason : null,
      servedAt: new Date().toISOString(),
      ...extra,
    },
  };
}

// GET /api/etf — ETF flow data served to the iOS app.
// Returns cached state from the last successful refreshEtfData() call.
// To trigger a server-side re-fetch, use POST /api/etf/refresh instead.
app.get('/api/etf', (req, res) => {
  const body = buildEtfResponse();
  console.log(`[/api/etf GET] source: ${body._meta.source}, lastUpdated: ${etfState.payload.lastUpdated}, ageDays: ${body._meta.ageDays ?? '?'}, isStale: ${body._meta.isStale}`);
  res.json(body);
});

// POST /api/etf/refresh — forces server-side ETF data reload from the live source chain.
// Rate-limited to once every 5 minutes to avoid hammering CoinGlass.
// Returns same shape as GET /api/etf plus refreshResult metadata.
app.post('/api/etf/refresh', async (req, res) => {
  const now = Date.now();
  const msSinceLastRefresh = now - lastForceRefreshMs;

  if (msSinceLastRefresh < FORCE_REFRESH_RATE_LIMIT_MS) {
    const retrySec = Math.ceil((FORCE_REFRESH_RATE_LIMIT_MS - msSinceLastRefresh) / 1000);
    console.log(`[/api/etf/refresh] rate-limited — retry in ${retrySec}s`);
    return res.json(buildEtfResponse({ refreshResult: 'rate-limited', retryAfterSeconds: retrySec }));
  }

  lastForceRefreshMs = now;
  const prevLastUpdated = etfState.payload?.lastUpdated;
  console.log(`[/api/etf/refresh] force-refresh triggered — prevLastUpdated: ${prevLastUpdated}`);

  await refreshEtfData();

  const newLastUpdated = etfState.payload?.lastUpdated;
  const dataChanged    = newLastUpdated !== prevLastUpdated;
  const refreshResult  = dataChanged ? 'updated' : 'unchanged';
  console.log(`[/api/etf/refresh] complete — source: ${etfState.source}, lastUpdated: ${newLastUpdated}, result: ${refreshResult}`);

  res.json(buildEtfResponse({ refreshResult, prevLastUpdated, dataChanged }));
});

// iOS Safari requires this exact MIME type for the web manifest
app.get('/site.webmanifest', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.sendFile(new URL('./site.webmanifest', import.meta.url).pathname);
});

app.use(express.static(dirname(fileURLToPath(import.meta.url))));

app.post('/api/assistant', async (req, res) => {
  const t0 = Date.now();
  console.log('[api/assistant] HIT — request received');
  const question = req.body?.question ?? '(no question)';
  console.log('[api/assistant] question:', question.slice(0, 120));

  const fallback = 'Market data is available, but AI response is temporarily unavailable.';

  try {
    const validationError = validate(req.body);
    if (validationError) {
      console.warn('[api/assistant] validation error:', validationError);
      return res.json({ response: 'Invalid request: ' + validationError, message: 'Invalid request: ' + validationError });
    }

    const ctx          = buildContext(req.body);
    const systemPrompt = buildPrompt(ctx);

    console.log('[api/assistant] calling AI — promptChars:', systemPrompt.length, 'turns:', ctx.history.length);
    const { text, model } = await callModel({ systemPrompt, messages: ctx.history, market: ctx.market, mode: ctx.mode });
    const response = text || fallback;
    console.log(`[api/assistant] AI success — ${Date.now() - t0}ms, model: ${model}`);
    console.log('[api/assistant] returning:', response.slice(0, 120));

    res.json({
      response,
      message: response,
      debug: { model, promptChars: systemPrompt.length, turns: ctx.history.length, ms: Date.now() - t0 },
    });
  } catch (err) {
    console.error(`[api/assistant] AI call failed after ${Date.now() - t0}ms —`, err?.message ?? err);
    console.log('[api/assistant] returning fallback');
    res.json({ response: fallback, message: fallback });
  }
});

app.get('/privacy', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Aureon Privacy Policy</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0a0a0a; color: #e5e5e5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.7; }
  .container { max-width: 760px; margin: 0 auto; padding: 60px 24px; }
  .logo { display: flex; align-items: center; gap: 12px; margin-bottom: 48px; }
  .logo-a { font-size: 32px; font-weight: 900; color: #C9A84C; font-style: italic; }
  .logo-text { font-size: 20px; font-weight: 700; color: #C9A84C; letter-spacing: 4px; }
  h1 { font-size: 28px; font-weight: 700; color: #ffffff; margin-bottom: 8px; }
  .updated { font-size: 13px; color: #666; margin-bottom: 48px; }
  h2 { font-size: 17px; font-weight: 600; color: #C9A84C; margin: 36px 0 12px; }
  p { font-size: 15px; color: #b0b0b0; margin-bottom: 12px; }
  ul { padding-left: 20px; margin-bottom: 12px; }
  li { font-size: 15px; color: #b0b0b0; margin-bottom: 6px; }
  a { color: #C9A84C; text-decoration: none; }
  .divider { border: none; border-top: 1px solid #1e1e1e; margin: 48px 0; }
  .footer { font-size: 13px; color: #555; text-align: center; margin-top: 60px; }
</style>
</head>
<body>
<div class="container">
  <div class="logo">
    <img src="/AureonLogo.png" alt="Aureon" style="height: 60px; width: auto;" />
  </div>
  <h1>Privacy Policy</h1>
  <p class="updated">Last updated: April 3, 2026</p>

  <p>Aureon ("we", "us", or "our") is committed to protecting your privacy. This Privacy Policy explains how we collect, use, and safeguard your information when you use the Aureon mobile application.</p>

  <h2>Information We Collect</h2>
  <p>We collect the following information when you create an account:</p>
  <ul>
    <li>Email address (for account creation and verification)</li>
    <li>Password (stored securely using industry-standard hashing)</li>
  </ul>
  <p>We also collect the following information automatically when you use the app:</p>
  <ul>
    <li>Cryptocurrency assets you view or add to favorites (stored locally on your device)</li>
    <li>AI chat messages you send to Aureon AI (processed to generate responses, not stored permanently)</li>
    <li>Basic usage data to improve app performance</li>
  </ul>

  <h2>How We Use Your Information</h2>
  <ul>
    <li>To create and manage your Aureon account</li>
    <li>To send account verification and password reset emails</li>
    <li>To provide personalized AI-powered crypto market analysis</li>
    <li>To improve the app experience over time</li>
  </ul>

  <h2>Data Storage and Security</h2>
  <p>Your account data is stored securely on our servers hosted by Railway. Passwords are hashed and never stored in plain text. Favorites and preferences are stored locally on your device using iOS UserDefaults.</p>

  <h2>Third-Party Services</h2>
  <p>Aureon uses the following third-party services:</p>
  <ul>
    <li><strong>CoinGecko</strong> — for cryptocurrency market data (no personal data shared)</li>
    <li><strong>Anthropic Claude API</strong> — to power Aureon AI responses (messages are processed but not retained)</li>
    <li><strong>Kraken API</strong> — for live order book data (no personal data shared)</li>
    <li><strong>TradingView</strong> — for candlestick chart rendering (no personal data shared)</li>
    <li><strong>Resend</strong> — for transactional emails such as verification and password reset</li>
  </ul>

  <h2>Financial Disclaimer</h2>
  <p>Aureon is an informational and analysis tool only. Nothing in this app constitutes financial advice, investment advice, or a recommendation to buy or sell any cryptocurrency. Always do your own research and consult a qualified financial advisor before making investment decisions.</p>

  <h2>Data Retention</h2>
  <p>We retain your account information for as long as your account is active. You may request deletion of your account and associated data at any time by contacting us.</p>

  <h2>Children's Privacy</h2>
  <p>Aureon is not intended for use by anyone under the age of 13. We do not knowingly collect personal information from children under 13.</p>

  <h2>Your Rights</h2>
  <p>You have the right to access, correct, or delete your personal information at any time. To exercise these rights, please contact us at the email below.</p>

  <h2>Changes to This Policy</h2>
  <p>We may update this Privacy Policy from time to time. We will notify you of any significant changes via email or through the app.</p>

  <h2>Contact Us</h2>
  <p>If you have any questions about this Privacy Policy, please contact us at: <a href="mailto:privacy@aureonapp.com">privacy@aureonapp.com</a></p>

  <hr class="divider">
  <p class="footer">© 2026 Aureon. All rights reserved.</p>
</div>
</body>
</html>`);
});

app.get('/terms', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Aureon Terms of Service</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0a0a0a; color: #e5e5e5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.7; }
  .container { max-width: 760px; margin: 0 auto; padding: 60px 24px; }
  .logo { display: flex; align-items: center; gap: 12px; margin-bottom: 48px; }
  .logo-a { font-size: 32px; font-weight: 900; color: #C9A84C; font-style: italic; }
  .logo-text { font-size: 20px; font-weight: 700; color: #C9A84C; letter-spacing: 4px; }
  h1 { font-size: 28px; font-weight: 700; color: #ffffff; margin-bottom: 8px; }
  .updated { font-size: 13px; color: #666; margin-bottom: 48px; }
  h2 { font-size: 17px; font-weight: 600; color: #C9A84C; margin: 36px 0 12px; }
  p { font-size: 15px; color: #b0b0b0; margin-bottom: 12px; }
  ul { padding-left: 20px; margin-bottom: 12px; }
  li { font-size: 15px; color: #b0b0b0; margin-bottom: 6px; }
  a { color: #C9A84C; text-decoration: none; }
  .divider { border: none; border-top: 1px solid #1e1e1e; margin: 48px 0; }
  .footer { font-size: 13px; color: #555; text-align: center; margin-top: 60px; }
</style>
</head>
<body>
<div class="container">
  <div class="logo">
    <img src="/AureonLogo.png" alt="Aureon" style="height: 60px; width: auto;" />
  </div>
  <h1>Terms of Service</h1>
  <p class="updated">Last updated: April 3, 2026</p>

  <p>By downloading or using Aureon, you agree to these Terms of Service. Please read them carefully.</p>

  <h2>Use of the App</h2>
  <p>Aureon is a cryptocurrency market analysis and AI assistant app. You agree to use it only for lawful purposes and in accordance with these terms.</p>

  <h2>Not Financial Advice</h2>
  <p>All content provided by Aureon, including AI-generated analysis, market data, and any other information, is for informational purposes only and does not constitute financial advice. We are not responsible for any financial decisions you make based on information provided by Aureon.</p>

  <h2>Account Responsibilities</h2>
  <ul>
    <li>You are responsible for maintaining the confidentiality of your account credentials</li>
    <li>You must provide accurate information when creating your account</li>
    <li>You must be at least 13 years of age to use Aureon</li>
  </ul>

  <h2>Intellectual Property</h2>
  <p>The Aureon name, logo, and all related content are the property of Aureon. You may not reproduce, distribute, or create derivative works without our written permission.</p>

  <h2>Limitation of Liability</h2>
  <p>Aureon is provided "as is" without warranties of any kind. We are not liable for any damages arising from your use of the app, including but not limited to financial losses.</p>

  <h2>Termination</h2>
  <p>We reserve the right to terminate or suspend your account at any time for violations of these terms.</p>

  <h2>Changes to Terms</h2>
  <p>We may update these terms at any time. Continued use of the app after changes constitutes acceptance of the new terms.</p>

  <h2>Contact</h2>
  <p>Questions? Contact us at <a href="mailto:support@aureonapp.com">support@aureonapp.com</a></p>

  <hr class="divider">
  <p class="footer">© 2026 Aureon. All rights reserved.</p>
</div>
</body>
</html>`);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`Aureon → listening on 0.0.0.0:${PORT}`));
