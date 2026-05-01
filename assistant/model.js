// model.js — calls the Claude API using ANTHROPIC_API_KEY from env.
// Key must be set in Railway Variables dashboard; never hard-coded here.

const MODEL = 'claude-sonnet-4-6';

async function callOnce({ systemPrompt, messages }) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env automatically

  const response = await client.messages.create({
    model:      MODEL,
    max_tokens: 1024,
    system:     systemPrompt,
    messages,
  });

  const text = response?.content?.[0]?.text ?? '';
  return { text: text || 'No content returned.', model: MODEL };
}

// Exported: one automatic retry on any error, with timing logs.
export async function callModel({ systemPrompt, messages }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.error('[model.js] ANTHROPIC_API_KEY is not set — aborting call');
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  const t0 = Date.now();

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await callOnce({ systemPrompt, messages });
      console.log(`[model.js] success on attempt ${attempt} — ${Date.now() - t0}ms, ${result.text.length} chars`);
      return result;
    } catch (err) {
      const elapsed = Date.now() - t0;
      console.error(`[model.js] attempt ${attempt} failed after ${elapsed}ms — ${err?.status ?? ''} ${err?.message ?? err}`);
      if (attempt === 1) {
        console.log('[model.js] retrying in 1s…');
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  throw new Error('Claude API unavailable after 2 attempts');
}
