/**
 * kiwiAudioClient.js — where the Decoder panel gets KiwiSDR audio from.
 *
 *   direct:  <bridge>/api/kiwi-audio/stream   (Rig Bridge on the LAN / localhost; API token header)
 *   relay:   /api/rig-bridge/relay/audio       (hosted site via the Rig Bridge Cloud Relay,
 *                                               opt-in on the bridge: cloudRelay.relayAudio)
 *
 * Pure request builders, so the routing is unit-tested without a network.
 */

/** Modes the Kiwi relay understands; FT8 listens in USB. */
export const KIWI_MODES = ['cw', 'usb', 'lsb', 'am'];

/** Default CW pitch the bridge tunes for (rig-bridge/plugins/kiwi-audio.js KIWI_CW_PITCH_HZ). */
export const KIWI_CW_PITCH_HZ = 600;

/**
 * @param {{ bridgeUrl?: string|null, token?: string, relaySession?: string|null, freqKhz: number, mode?: string }} o
 * @returns {{ url: string, headers: object, via: 'direct'|'relay' } | null}  null when neither path exists
 */
export function kiwiStreamRequest({ bridgeUrl, token, relaySession, freqKhz, mode = 'cw' }) {
  const q = `freq=${encodeURIComponent(freqKhz)}&mode=${encodeURIComponent(mode)}`;
  if (relaySession) {
    return {
      url: `/api/rig-bridge/relay/audio?session=${encodeURIComponent(relaySession)}&${q}`,
      headers: {},
      via: 'relay',
    };
  }
  if (bridgeUrl) {
    return {
      url: `${bridgeUrl.replace(/\/$/, '')}/api/kiwi-audio/stream?${q}`,
      headers: token ? { 'X-RigBridge-Token': token } : {},
      via: 'direct',
    };
  }
  return null;
}

/**
 * Retune a live stream.
 * @returns {{ url: string, init: RequestInit } | null}
 */
export function kiwiTuneRequest({ bridgeUrl, token, relaySession, freqKhz, mode = 'cw' }) {
  if (relaySession) {
    return {
      url: `/api/rig-bridge/relay/command?session=${encodeURIComponent(relaySession)}`,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'kiwiAudioTune', payload: { freqKHz: freqKhz, mode } }),
      },
    };
  }
  if (bridgeUrl) {
    return {
      url: `${bridgeUrl.replace(/\/$/, '')}/api/kiwi-audio/tune`,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { 'X-RigBridge-Token': token } : {}) },
        body: JSON.stringify({ freqKHz: freqKhz, mode }),
      },
    };
  }
  return null;
}
