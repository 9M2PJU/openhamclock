/**
 * aprsMessageSend — the one client-side path for transmitting an APRS
 * message through the local TNC.
 *
 * POST /api/aprs/message → server → rig-bridge APRS TNC plugin. The server
 * enforces the 67-character limit and answers 503 when no TNC is reachable.
 * Shared by the EmComm layout's MSG composer and the ICS 213 composer so
 * there is exactly one place that knows the endpoint and payload.
 */
import { APRS_MSG_MAX } from './icsForms.js';

/**
 * Send one APRS message.
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function sendAprsMessage({ to, message }, fetchImpl = globalThis.fetch) {
  const addressee = String(to || '')
    .trim()
    .toUpperCase();
  const text = String(message || '').trim();
  if (!addressee || !text) return { ok: false, error: 'Missing addressee or message' };
  if (text.length > APRS_MSG_MAX) return { ok: false, error: `Message exceeds ${APRS_MSG_MAX} characters` };
  try {
    const res = await fetchImpl('/api/aprs/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: addressee, message: text }),
    });
    if (res?.ok) return { ok: true };
    let error = `HTTP ${res?.status ?? '?'}`;
    try {
      const body = await res.json();
      if (body?.error) error = body.error;
    } catch {
      /* non-JSON error body */
    }
    return { ok: false, error };
  } catch (e) {
    return { ok: false, error: e?.message || 'Network error' };
  }
}

/**
 * Send several parts in order (e.g. a split ICS 213), stopping at the first
 * failure so a half-sent message is never silently reported as complete.
 * @returns {Promise<{ sent: number, total: number, error?: string }>}
 */
export async function sendAprsParts(to, parts, fetchImpl = globalThis.fetch) {
  const list = Array.isArray(parts) ? parts : [];
  let sent = 0;
  for (const part of list) {
    const r = await sendAprsMessage({ to, message: part }, fetchImpl);
    if (!r.ok) return { sent, total: list.length, error: r.error };
    sent++;
  }
  return { sent, total: list.length };
}
