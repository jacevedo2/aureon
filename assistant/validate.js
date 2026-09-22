/**
 * validate.js
 * Validates the POST /api/assistant request body.
 * Returns an error string on failure, or null if valid.
 */

const VALID_MODES = ['quick', 'detailed', 'watch', 'chart'];

// Multimodal chart-image field (Iteration 3.2). Anthropic's Messages API accepts
// image/jpeg, image/png, image/gif, image/webp — Aureon only ever produces the
// first two (native chart snapshot, in-memory PNG or JPEG), so only those two
// are accepted here; anything else is rejected rather than silently forwarded.
const VALID_CHART_IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png'];

// Base64-character ceiling for chartImage.data — well under the raised Express
// JSON body limit (see server.js), so an oversized single image field always
// fails here with a specific, attributable message rather than only ever
// surfacing as a generic body-too-large error at the transport layer.
// ~4,500,000 base64 chars ≈ ~3.375MB raw image bytes — comfortably above any
// realistic encoded size for the chart dimensions Iteration 3.1 produced
// (1206×1080 at 3x), while still bounded.
const MAX_CHART_IMAGE_BASE64_CHARS = 4_500_000;

export function validate(body) {
  if (!body || typeof body !== 'object') return 'Request body must be JSON.';
  if (typeof body.question !== 'string' || !body.question.trim()) {
    return 'question is required and must be a non-empty string.';
  }
  if (body.question.trim().length > 2500) {
    return 'question must be 2500 characters or fewer.';
  }
  if (body.history !== undefined && !Array.isArray(body.history)) {
    return 'history must be an array.';
  }
  if (body.mode !== undefined && !VALID_MODES.includes(body.mode)) {
    return `mode must be one of: ${VALID_MODES.join(', ')}.`;
  }
  if (body.market !== undefined) {
    const m = body.market;
    if (typeof m !== 'object') return 'market must be an object.';
    if (m.rsi !== undefined && typeof m.rsi !== 'object') return 'market.rsi must be an object.';
    if (m.zones !== undefined && typeof m.zones !== 'object') return 'market.zones must be an object.';
    if (m.mtf !== undefined && !Array.isArray(m.mtf)) return 'market.mtf must be an array.';
    if (m.news !== undefined && !Array.isArray(m.news)) return 'market.news must be an array.';
  }
  // chartImage is entirely optional — every existing text-only request (no
  // field present at all) skips this block unchanged.
  if (body.chartImage !== undefined) {
    const ci = body.chartImage;
    if (typeof ci !== 'object' || ci === null || Array.isArray(ci)) {
      return 'chartImage must be an object.';
    }
    if (typeof ci.data !== 'string' || !ci.data.trim()) {
      return 'chartImage.data must be a non-empty string.';
    }
    if (!VALID_CHART_IMAGE_MEDIA_TYPES.includes(ci.mediaType)) {
      return `chartImage.mediaType must be one of: ${VALID_CHART_IMAGE_MEDIA_TYPES.join(', ')}.`;
    }
    if (ci.data.length > MAX_CHART_IMAGE_BASE64_CHARS) {
      return `chartImage.data exceeds maximum allowed size (${MAX_CHART_IMAGE_BASE64_CHARS} base64 characters).`;
    }
  }
  return null;
}
