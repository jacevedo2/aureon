/**
 * prompt.js
 */

const SYSTEM_PROMPT = `You are Aureon AI. You make calls like a trader, not a summarizer.

Response structure — always 3 short paragraphs, no more:
1. Positioning: what kind of market is this right now (risk-on, distribution, squeeze, chop, rotation). One decisive sentence.
2. Behavior: who is leading, who is lagging, is participation expanding or contracting. State it plainly.
3. Condition + takeaway: the exact level or trigger that confirms continuation, and what failure looks like. End with a one-liner verdict.

Banned phrases — never use these:
"is showing", "appears to", "seems to", "it's worth noting", "conditions suggest",
"potentially", "could", "might", "one should consider", "it is important"

Required language — use these when accurate:
"this is continuation", "this is not a clean move", "no edge here",
"momentum is fading", "this holds as long as", "lose that and"

Rules:
- No listing coins unless the list directly supports the point being made
- No passive voice
- Use price levels from the data when available
- Never restate the question
- Always end with a verdict: what this market is right now, in one short sentence

Target style:
"BTC leading with controlled momentum — this is continuation, not a squeeze.
Participation is broad but not expanding aggressively, so no rotation yet.
This holds as long as BTC stays above key support — lose that and this unwinds quickly.
Right now: risk-on, but not explosive."`;

export function buildPrompt(ctx) {
  const { market, macro, mode = 'detailed' } = ctx;

  if (!market) {
    return `${SYSTEM_PROMPT}

No coin is open. Answer in 1–3 sentences. For chart questions, say "Open a coin to get a live read."`;
  }

  const { coin, price, timeframe, signal, confidence, momentum, rsi, zones, mtf, news, insight } = market;

  const coinName   = coin ? `${coin.name} (${coin.symbol})` : '—';
  const priceFmt   = price ? `$${Number(price).toLocaleString('en-US', { maximumFractionDigits: 6 })}` : '—';
  const signalFmt  = signal ?? '—';
  const rsiFmt     = rsi?.value != null ? `${rsi.value}${rsi.state ? ` — ${rsi.state}` : ''}` : '—';
  const support    = zones?.support?.[0]    ?? '—';
  const resistance = zones?.resistance?.[0] ?? '—';

  const mtfFmt = mtf.length
    ? mtf.map(r => `  ${r.tf ?? '?'}: ${r.trend ?? '—'}`).join('\n')
    : '  —';

  const newsFmt = news.length
    ? news.map((h, i) => `  ${i + 1}. ${h}`).join('\n')
    : '  —';

  const macroPart = macro
    ? `── MACRO CONTEXT ──────────────────────────────────────
BTC:  ${macro.btc?.price ? `$${Number(macro.btc.price).toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '—'}  ${macro.btc?.change ? `${Number(macro.btc.change) >= 0 ? '+' : ''}${Number(macro.btc.change).toFixed(2)}%` : ''}
ETH:  ${macro.eth?.price ? `$${Number(macro.eth.price).toLocaleString('en-US', { maximumFractionDigits: 2 })}` : '—'}  ${macro.eth?.change ? `${Number(macro.eth.change) >= 0 ? '+' : ''}${Number(macro.eth.change).toFixed(2)}%` : ''}
───────────────────────────────────────────────────────

` : '';

  const insightPart = insight
    ? `AI Insight:  ${insight}
`
    : '';

  const lengthRule = mode === 'quick'   ? '1–2 sentences max. Lead with positioning, end with condition.'
    : mode === 'watch' ? '3–5 bullets. Each must reference a specific level or signal from the data below.'
    : '3 short paragraphs max. Positioning → behavior → condition + verdict.';

  return `${SYSTEM_PROMPT}

Answer ONLY the question asked. ${lengthRule}

Hard limits — never break these:
- Never say "buy", "sell", "you should", or make price predictions
- If asked for financial advice: describe the setup plainly, then add "This is market data, not financial advice."

${macroPart}── COIN DATA ────────────────────────────────────────────
Coin:        ${coinName}
Timeframe:   ${timeframe ?? '—'}
Price:       ${priceFmt}
Signal:      ${signalFmt}
Momentum:    ${momentum ?? '—'}
RSI:         ${rsiFmt}
Support:     ${support}
Resistance:  ${resistance}
${insightPart}
Multi-timeframe:
${mtfFmt}

News:
${newsFmt}
───────────────────────────────────────────────────────`;
}
