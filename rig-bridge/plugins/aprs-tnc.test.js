/**
 * APRS TNC plugin — station identity must follow the live config (#1213).
 * The settings page saves `config.aprs` as a fresh object without restarting
 * the plugin; a source call captured at create() kept transmitting under the
 * old SSID. No TNC is connected here — we only read what the plugin would
 * put in the source address, via getStatus().
 */
import { describe, it, expect } from 'vitest';
import plugin from './aprs-tnc.js';

const make = (aprs) => {
  const config = { aprs: { enabled: true, protocol: 'kiss-tcp', ...aprs } };
  const inst = plugin.create(config, {});
  return { config, call: () => inst.getStatus().callsign };
};

describe('aprs-tnc station identity', () => {
  it('reads callsign and SSID from the live config after a settings save', () => {
    const { config, call } = make({ callsign: 'KE8PLM', ssid: 1 });
    expect(call()).toBe('KE8PLM-1');
    config.aprs = { ...config.aprs, ssid: 0 }; // what POST /api/config does
    expect(call()).toBe('KE8PLM');
    config.aprs = { ...config.aprs, callsign: 'n8tag', ssid: 7 };
    expect(call()).toBe('N8TAG-7');
  });

  it('treats an empty, non-numeric or out-of-range SSID as none', () => {
    for (const ssid of ['', null, undefined, 'abc', 16, -1, 0, '0']) {
      const { call } = make({ callsign: 'KE8PLM', ssid });
      expect(call(), `ssid=${JSON.stringify(ssid)}`).toBe('KE8PLM');
    }
    expect(make({ callsign: 'KE8PLM', ssid: '15' }).call()).toBe('KE8PLM-15');
  });
});
