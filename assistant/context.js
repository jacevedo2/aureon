/**
 * context.js
 * Builds a clean, normalized context object from the validated request body.
 * Everything downstream (prompt.js, model.js) works from this shape.
 */

export function buildContext(body) {
  const { question, history = [], market = null, mode = 'detailed', macro = null } = body;

  // Normalize conversation history.
  // Drop any leading assistant turn (the greeting) so messages start with user.
  let msgs = history
    .filter(m => m && typeof m.role === 'string' && typeof m.text === 'string')
    .map(m => ({ role: m.role, content: m.text.trim() }));

  while (msgs.length && msgs[0].role !== 'user') msgs.shift();

  // Avoid duplicating the current question if it's already the last entry.
  const q = question.trim();
  const lastIsQ = msgs.length > 0 &&
    msgs.at(-1).role === 'user' &&
    msgs.at(-1).content === q;
  if (!lastIsQ) msgs.push({ role: 'user', content: q });

  // Normalize market data (all fields are optional).
  const coin = market?.coin ?? null;
  const rsi  = market?.rsi  ?? null;
  const zones = market?.zones ?? null;

  // Optional macro context: { btc: { price, change }, eth: { price, change } }
  // Sent by the iOS app when BTC/ETH data is available alongside the selected coin.
  const normMacro = macro && typeof macro === 'object' ? {
    btc: macro.btc ? { price: macro.btc.price ?? null, change: macro.btc.change ?? null } : null,
    eth: macro.eth ? { price: macro.eth.price ?? null, change: macro.eth.change ?? null } : null,
  } : null;

  return {
    question: q,
    history: msgs,
    mode,
    macro: normMacro,
    market: market ? {
      coin:       coin ? { id: coin.id, symbol: coin.symbol, name: coin.name } : null,
      price:      market.price      ?? null,
      timeframe:  market.timeframe  ?? null,
      signal:     market.signal     ?? null,
      confidence: market.confidence ?? null,
      momentum:   market.momentum   ?? null,
      rsi: rsi ? {
        value: rsi.value ?? null,
        state: rsi.state ?? null,
      } : null,
      zones: zones ? {
        current:    zones.current    ?? null,
        support:    Array.isArray(zones.support)    ? zones.support    : [],
        resistance: Array.isArray(zones.resistance) ? zones.resistance : [],
      } : null,
      mtf:     Array.isArray(market.mtf)  ? market.mtf  : [],
      insight: market.insight ?? null,
      news:    Array.isArray(market.news) ? market.news.slice(0, 5) : [],
    } : null,
  };
}
