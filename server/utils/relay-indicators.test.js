import { describe, it, expect } from 'vitest';

const { sanitizeRelayIndicators, queueRelayCommand, MAX_QUEUED_COMMANDS } = require('./relay-indicators.js');

describe('cloud relay indicators', () => {
  it('whitelists the indicator fields, including the lightning relay', () => {
    expect(
      sanitizeRelayIndicators({
        satVisible: true,
        countdown: 'running',
        lightning: 'alarm',
        lightningRelay: true,
        lightningAllClearMin: 999,
        lightningOverride: 'off',
        displayId: 'abc_123',
        evil: '<script>',
      }),
    ).toEqual({
      satVisible: true,
      satAosInSec: null,
      satLosInSec: null,
      alarm: false,
      countdown: 'running',
      lightning: 'alarm',
      lightningRelay: true,
      lightningAllClearMin: 240,
      lightningOverride: 'off',
      displayId: 'abc_123',
    });
    const plain = sanitizeRelayIndicators({ lightningRelay: 'yes', displayId: 'bad id!' });
    expect(plain).not.toHaveProperty('lightningRelay');
    expect(plain).not.toHaveProperty('displayId');
    expect(sanitizeRelayIndicators(null)).toBeNull();
    expect(sanitizeRelayIndicators([1])).toBeNull();
  });

  it('keeps only the newest indicators command queued; other commands append', () => {
    let q = queueRelayCommand([], 'setFreq', { freq: 14074000 }, 1);
    q = queueRelayCommand(q, 'indicators', { lightningRelay: true }, 2);
    q = queueRelayCommand(q, 'indicators', { lightningRelay: false }, 3);
    q = queueRelayCommand(q, 'indicators', 'garbage', 4);
    expect(q.map((c) => c.type)).toEqual(['setFreq', 'indicators']);
    expect(q[1].payload.lightningRelay).toBe(false);
    for (let i = 0; i < 80; i++) q = queueRelayCommand(q, 'setPTT', { ptt: false }, 10 + i);
    expect(q).toHaveLength(MAX_QUEUED_COMMANDS);
  });
});
