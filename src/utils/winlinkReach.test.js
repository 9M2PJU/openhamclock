import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RANGE_KM,
  MAX_PREDICTIONS_PER_REFRESH,
  PACKET_RANGE_KM,
  STATUS_COLORS,
  aggregateGateways,
  bestChannel,
  buildPredictionParams,
  buildReachSnapshot,
  cacheKey,
  cachePut,
  classifyStatus,
  dialFrequencyHz,
  freqHzToBand,
  hourKeyFor,
  isHfChannel,
  isVhfChannel,
  losHint,
  passesReachFilter,
  patConnectUrl,
  rankGateways,
  restFallbackMode,
  rigModeForChannel,
  runBatched,
  scoreChannels,
  selectCandidates,
  summarizeGateway,
  winlinkRequiredSNR,
} from './winlinkReach.js';
import { P533_REF_SNR_DB } from './propagationAdjust.js';

// Mode codes (winlinkModes.js): 0 Packet 1200, 16 Pactor 3, 30 Robust Packet,
// 41 ARDOP 500, 43 ARDOP 2000, 50 VARA, 51 VARA FM, 53 VARA 500.
const DE = { lat: 39.75, lon: -104.99 }; // Denver, DM79

const row = (over = {}) => ({
  callsign: 'W1AW-10',
  gridsquare: 'FN31',
  frequency: 7101200,
  mode: 50,
  serviceCode: 'PUBLIC',
  ...over,
});

describe('classifyStatus', () => {
  it('maps reliability to Good / Marginal / Closed', () => {
    expect(classifyStatus(80)).toBe('good');
    expect(classifyStatus(50)).toBe('good');
    expect(classifyStatus(49)).toBe('marginal');
    expect(classifyStatus(20)).toBe('marginal');
    expect(classifyStatus(19)).toBe('closed');
    expect(classifyStatus(0)).toBe('closed');
  });

  it('lets a near-miss SNR margin rescue a low-reliability path to Marginal', () => {
    expect(classifyStatus(5, -3)).toBe('marginal');
    expect(classifyStatus(5, -6)).toBe('marginal');
    expect(classifyStatus(5, -6.1)).toBe('closed');
    expect(classifyStatus(5, null)).toBe('closed');
  });

  it('is unknown without a prediction', () => {
    expect(classifyStatus(null)).toBe('unknown');
    expect(classifyStatus(undefined, 10)).toBe('unknown');
    expect(classifyStatus(NaN)).toBe('unknown');
  });
});

describe('winlinkRequiredSNR / restFallbackMode', () => {
  it('needs less SNR than SSB for the ARQ data modes', () => {
    expect(winlinkRequiredSNR(16)).toBeLessThan(P533_REF_SNR_DB); // Pactor 3
    expect(winlinkRequiredSNR(50)).toBeLessThan(P533_REF_SNR_DB); // VARA
    expect(winlinkRequiredSNR(0)).toBe(P533_REF_SNR_DB); // packet: no advantage
    expect(winlinkRequiredSNR(999)).toBe(P533_REF_SNR_DB); // unknown code
  });

  it('gives narrow variants a few dB more than their wide siblings', () => {
    expect(winlinkRequiredSNR(41)).toBeLessThan(winlinkRequiredSNR(43)); // ARDOP 500 vs 2000
    expect(winlinkRequiredSNR(53)).toBeLessThan(winlinkRequiredSNR(50)); // VARA 500 vs VARA
  });

  it('treats Robust Packet as a robust HF mode, not AX.25', () => {
    expect(winlinkRequiredSNR(30)).toBeLessThan(winlinkRequiredSNR(0));
  });

  it('maps families onto the server mode table for the REST fallback', () => {
    expect(restFallbackMode(50)).toBe('PSK31');
    expect(restFallbackMode(43)).toBe('PSK31');
    expect(restFallbackMode(16)).toBe('CW');
    expect(restFallbackMode(30)).toBe('CW');
    expect(restFallbackMode(0)).toBe('SSB');
    expect(restFallbackMode(999)).toBe('SSB');
  });
});

describe('channel classification', () => {
  it('splits HF (engine) from VHF/UHF (distance only)', () => {
    expect(isHfChannel({ frequency: 7101200, mode: 50 })).toBe(true);
    expect(isHfChannel({ frequency: 10145000, mode: 30 })).toBe(true); // Robust Packet on 30 m
    expect(isHfChannel({ frequency: 145050000, mode: 0 })).toBe(false);
    expect(isVhfChannel({ frequency: 145050000, mode: 0 })).toBe(true);
    expect(isVhfChannel({ frequency: 7101200, mode: 50 })).toBe(false);
    expect(isHfChannel(null)).toBe(false);
  });

  it('labels amateur bands and leaves out-of-band (MARS) channels unlabelled', () => {
    expect(freqHzToBand(3585000)).toBe('80m');
    expect(freqHzToBand(7101200)).toBe('40m');
    expect(freqHzToBand(14108500)).toBe('20m');
    expect(freqHzToBand(145050000)).toBe('2m');
    expect(freqHzToBand(4000000 + 500000)).toBe(null);
  });
});

describe('dial frequency, rig mode and Pat URLs', () => {
  it('puts the HF dial 1.5 kHz below the published centre; FM stays put', () => {
    expect(dialFrequencyHz({ frequency: 7101200, mode: 50 })).toBe(7099700);
    expect(dialFrequencyHz({ frequency: 145050000, mode: 0 })).toBe(145050000);
    expect(dialFrequencyHz({ frequency: 145070000, mode: 51 })).toBe(145070000);
    expect(dialFrequencyHz({ frequency: NaN })).toBe(null);
  });

  it('asks the rig for upper-sideband data on every HF band (even 40 m)', () => {
    expect(rigModeForChannel({ frequency: 7101200, mode: 43 })).toBe('DATA-USB');
    expect(rigModeForChannel({ frequency: 3585000, mode: 16 })).toBe('DATA-USB');
    expect(rigModeForChannel({ frequency: 145050000, mode: 0 })).toBe('FM');
  });

  it('builds Pat connect URLs in the transport:///CALL?freq=<dial kHz> form', () => {
    expect(patConnectUrl('w1aw-10', { frequency: 7101200, mode: 43 })).toBe('ardop:///W1AW-10?freq=7099.7');
    expect(patConnectUrl('W1AW-10', { frequency: 14108500, mode: 50 })).toBe('varahf:///W1AW-10?freq=14107.0');
    expect(patConnectUrl('W1AW-10', { frequency: 3585000, mode: 16 })).toBe('pactor:///W1AW-10?freq=3583.5');
    expect(patConnectUrl('W1AW-10', { frequency: 145050000, mode: 0 })).toBe('ax25:///W1AW-10');
    expect(patConnectUrl('W1AW-10', { frequency: 145070000, mode: 51 })).toBe('varafm:///W1AW-10');
  });

  it('returns null where Pat has no transport', () => {
    expect(patConnectUrl('W1AW-10', { frequency: 7101200, mode: 22 })).toBe(null); // WINMOR
    expect(patConnectUrl('W1AW-10', { frequency: 10145000, mode: 30 })).toBe(null); // Robust Packet
    expect(patConnectUrl('W1AW-10', { frequency: 7101200, mode: 999 })).toBe(null);
    expect(patConnectUrl('', { frequency: 7101200, mode: 50 })).toBe(null);
  });
});

describe('losHint', () => {
  it('grades distance for VHF/UHF', () => {
    expect(losHint(20)).toBe('los');
    expect(losHint(80)).toBe('extended');
    expect(losHint(250)).toBe('beyond');
    expect(losHint(NaN)).toBe('unknown');
  });
});

describe('aggregateGateways', () => {
  it('groups channels per callsign from either field casing and drops undecodable grids', () => {
    const gws = aggregateGateways([
      row(),
      row({ frequency: 3585000, mode: 16 }),
      { Callsign: 'K0ABC', Gridsquare: 'DM79', Frequency: 14108500, Mode: 43, ServiceCode: 'EMCOMM' },
      row({ callsign: 'BAD', gridsquare: 'ZZ99' }),
      row({ callsign: '' }),
      null,
    ]);
    expect(gws.map((g) => g.callsign).sort()).toEqual(['K0ABC', 'W1AW-10']);
    const w1 = gws.find((g) => g.callsign === 'W1AW-10');
    expect(w1.channels).toHaveLength(2);
    const k0 = gws.find((g) => g.callsign === 'K0ABC');
    expect(k0.channels[0]).toMatchObject({ frequency: 14108500, mode: 43, serviceCode: 'EMCOMM' });
    expect(Number.isFinite(k0.lat)).toBe(true);
  });
});

describe('selectCandidates', () => {
  const gateways = aggregateGateways([
    // Local (DM79), HF VARA + Pactor on two bands, plus a 2 m packet port
    row({ callsign: 'K0NEAR', gridsquare: 'DM79', frequency: 7101200, mode: 50 }),
    row({ callsign: 'K0NEAR', gridsquare: 'DM79', frequency: 14108500, mode: 50 }),
    row({ callsign: 'K0NEAR', gridsquare: 'DM79', frequency: 3585000, mode: 16 }),
    row({ callsign: 'K0NEAR', gridsquare: 'DM79', frequency: 145050000, mode: 0 }),
    // ~2,500 km (FN31) HF
    row({ callsign: 'W1AW-10', gridsquare: 'FN31', frequency: 7101200, mode: 43 }),
    // ~8,000 km — out of default range
    row({ callsign: 'JA1XYZ', gridsquare: 'PM95', frequency: 7101200, mode: 50 }),
    // VHF-only, far away — not listed
    row({ callsign: 'W1VHF', gridsquare: 'FN31', frequency: 145050000, mode: 0 }),
  ]);

  it('keeps HF gateways in range, nearest first, and VHF ones within packet range', () => {
    const sel = selectCandidates(gateways, DE);
    expect(sel.hf.map((c) => c.callsign)).toEqual(['K0NEAR', 'W1AW-10']);
    expect(sel.packet.map((c) => c.callsign)).toEqual(['K0NEAR']);
    expect(sel.packet[0].los).toBe('los');
    expect(sel.truncated).toBe(0);
    expect(sel.hf[1].distanceKm).toBeLessThan(DEFAULT_RANGE_KM);
    expect(sel.hf[1].bearing).toBeGreaterThan(45);
    expect(sel.hf[1].bearing).toBeLessThan(90);
  });

  it('splits a gateway into one job per required SNR, with sorted frequency lists', () => {
    const near = selectCandidates(gateways, DE).hf[0];
    expect(near.jobs).toHaveLength(2); // VARA + Pactor
    const vara = near.jobs.find((j) => j.requiredSNR === winlinkRequiredSNR(50));
    expect(vara.freqsMHz).toEqual([7.101, 14.109]);
    expect(near.channels).toHaveLength(3); // the 2 m port is not an HF channel
  });

  it('honours the range and the per-refresh job cap', () => {
    expect(selectCandidates(gateways, DE, { rangeKm: 500 }).hf.map((c) => c.callsign)).toEqual(['K0NEAR']);
    const capped = selectCandidates(gateways, DE, { maxPredictions: 2 });
    expect(capped.hf.map((c) => c.callsign)).toEqual(['K0NEAR']);
    expect(capped.totalJobs).toBe(2);
    expect(capped.truncated).toBe(1);
    expect(selectCandidates(gateways, DE, { maxPredictions: 1 }).hf).toEqual([]);
  });

  it('returns nothing without a station location', () => {
    expect(selectCandidates(gateways, null).hf).toEqual([]);
    expect(selectCandidates(gateways, { lat: NaN, lon: 0 }).packet).toEqual([]);
  });

  it('has sane defaults', () => {
    expect(DEFAULT_RANGE_KM).toBe(3000);
    expect(MAX_PREDICTIONS_PER_REFRESH).toBeGreaterThan(0);
    expect(PACKET_RANGE_KM).toBeLessThan(DEFAULT_RANGE_KM);
  });
});

describe('cacheKey / hourKeyFor', () => {
  const base = {
    callsign: 'W1AW-10',
    freqsMHz: [7.101, 14.109],
    requiredSNR: 3,
    deLat: 39.75,
    deLon: -104.99,
    hour: 14,
    month: 10,
    year: 2026,
    ssn: 123,
    power: 100,
    antenna: 'dipole',
  };

  it('is stable under tiny DE / SSN jitter', () => {
    expect(cacheKey({ ...base, deLat: 39.7501, ssn: 121 })).toBe(cacheKey(base));
  });

  it('changes with hour, station settings, frequencies, mode threshold and DE', () => {
    const k = cacheKey(base);
    expect(cacheKey({ ...base, hour: 15 })).not.toBe(k);
    expect(cacheKey({ ...base, power: 500 })).not.toBe(k);
    expect(cacheKey({ ...base, antenna: 'yagi3' })).not.toBe(k);
    expect(cacheKey({ ...base, freqsMHz: [7.101] })).not.toBe(k);
    expect(cacheKey({ ...base, requiredSNR: 5 })).not.toBe(k);
    expect(cacheKey({ ...base, deLat: 41 })).not.toBe(k);
    expect(cacheKey({ ...base, ssn: 160 })).not.toBe(k);
  });

  it('rolls over once per UTC hour', () => {
    const a = hourKeyFor(new Date('2026-10-15T14:05:00Z'));
    expect(hourKeyFor(new Date('2026-10-15T14:59:59Z'))).toBe(a);
    expect(hourKeyFor(new Date('2026-10-15T15:00:00Z'))).not.toBe(a);
  });
});

describe('buildPredictionParams', () => {
  it('passes the gateway frequencies and the job threshold to the engine', () => {
    const cand = { gateway: { lat: 41.5, lon: -72.5 } };
    const job = { requiredSNR: 3, freqsMHz: [7.101] };
    const p = buildPredictionParams(cand, job, DE, {
      hour: 14,
      month: 10,
      year: 2026,
      ssn: 120,
      power: '50',
      txGain: 2.15,
    });
    expect(p).toMatchObject({
      txLat: DE.lat,
      rxLat: 41.5,
      rxLon: -72.5,
      hour: 14,
      month: 10,
      year: 2026,
      ssn: 120,
      txPower: 50,
      txGain: 2.15,
      requiredSNR: 3,
      frequencies: [7.101],
    });
  });
});

describe('scoring and ranking', () => {
  const channels = [
    { frequency: 7101200, mode: 50, modeLabel: 'VARA' },
    { frequency: 14108500, mode: 50, modeLabel: 'VARA' },
    { frequency: 21100000, mode: 50, modeLabel: 'VARA' },
  ];
  const engineOut = [
    { freq: 7.101, snr: 9.5, reliability: 72.4 },
    { freq: 14.109, snr: -1, reliability: 12 },
  ];

  it('attaches reliability, SNR margin and status per channel', () => {
    const scored = scoreChannels(channels, engineOut, 3);
    expect(scored[0]).toMatchObject({ band: '40m', reliability: 72, snr: 9.5, snrMargin: 6.5, status: 'good' });
    expect(scored[0].dialHz).toBe(7099700);
    expect(scored[1]).toMatchObject({ reliability: 12, snrMargin: -4, status: 'marginal' });
    expect(scored[2]).toMatchObject({ reliability: null, status: 'unknown' }); // not in engine output
  });

  it('clamps reliability to 0..99', () => {
    const [c] = scoreChannels([channels[0]], [{ freq: 7.101, snr: 30, reliability: 100 }], 3);
    expect(c.reliability).toBe(99);
  });

  it('picks the best channel by reliability, then SNR margin', () => {
    const best = bestChannel([
      { reliability: 40, snrMargin: 1 },
      { reliability: 60, snrMargin: -2 },
      { reliability: 60, snrMargin: 4 },
      { reliability: null, snrMargin: null },
    ]);
    expect(best).toMatchObject({ reliability: 60, snrMargin: 4 });
    expect(bestChannel([])).toBe(null);
  });

  it('summarizes a gateway and ranks Good before Marginal before Closed', () => {
    const cand = (callsign, distanceKm) => ({
      callsign,
      distanceKm,
      bearing: 90,
      gateway: { lat: 0, lon: 0, gridsquare: 'JJ00' },
    });
    const mk = (callsign, distanceKm, rel, margin) =>
      summarizeGateway(
        cand(callsign, distanceKm),
        [{ reliability: rel, snrMargin: margin, status: classifyStatus(rel, margin) }],
        {
          updatedAt: 1,
        },
      );
    const rows = rankGateways([
      mk('CLOSED', 100, 2, -20),
      mk('MARG', 900, 30, -2),
      mk('GOOD-FAR', 2000, 70, 5),
      mk('GOOD-NEAR', 300, 70, 5),
      mk('GOOD-BEST', 2500, 90, 9),
      summarizeGateway(cand('UNKNOWN', 50), []),
    ]);
    expect(rows.map((r) => r.callsign)).toEqual(['GOOD-BEST', 'GOOD-NEAR', 'GOOD-FAR', 'MARG', 'CLOSED', 'UNKNOWN']);
    expect(rows[0]).toMatchObject({ status: 'good', reliability: 90, snrMargin: 9, updatedAt: 1 });
    expect(rows[5].status).toBe('unknown');
  });
});

describe('snapshot + map filter', () => {
  const rows = [
    { callsign: 'A', status: 'good', reliability: 80, snrMargin: 5, best: { band: '40m', frequency: 7101200 } },
    { callsign: 'B', status: 'marginal', reliability: 30, snrMargin: -1, best: null },
    { callsign: 'C', status: 'closed', reliability: 1, snrMargin: -20, best: null },
  ];
  const packet = [
    { callsign: 'P1', los: 'los', distanceKm: 10 },
    { callsign: 'P2', los: 'extended', distanceKm: 90 },
    { callsign: 'P3', los: 'beyond', distanceKm: 250 },
    { callsign: 'A', los: 'los', distanceKm: 5 }, // HF prediction wins
  ];
  const snap = buildReachSnapshot(rows, packet);

  it('indexes HF predictions and VHF line-of-sight hints by callsign', () => {
    expect(snap.A).toMatchObject({ kind: 'hf', status: 'good', band: '40m', freqHz: 7101200 });
    expect(snap.P1).toMatchObject({ kind: 'packet', los: 'los' });
    expect(Object.keys(snap)).toHaveLength(6);
  });

  it('filters reachable / good-only', () => {
    const pass = (f) => Object.keys(snap).filter((k) => passesReachFilter(snap[k], f));
    expect(pass('all').sort()).toEqual(['A', 'B', 'C', 'P1', 'P2', 'P3']);
    expect(pass('reachable').sort()).toEqual(['A', 'B', 'P1', 'P2']);
    expect(pass('good').sort()).toEqual(['A', 'P1']);
    expect(passesReachFilter(undefined, 'reachable')).toBe(false);
    expect(passesReachFilter(undefined, 'all')).toBe(true);
  });

  it('has a colour for every status', () => {
    for (const s of ['good', 'marginal', 'closed', 'unknown']) expect(STATUS_COLORS[s]).toMatch(/^#/);
  });
});

describe('runBatched', () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  it('never exceeds the concurrency limit and keeps result order', async () => {
    let inFlight = 0;
    let peak = 0;
    const progress = [];
    const results = await runBatched(
      [30, 5, 20, 1, 10],
      async (ms, i) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await sleep(ms);
        inFlight--;
        return i * 10;
      },
      { concurrency: 2, onProgress: (d, t) => progress.push([d, t]) },
    );
    expect(peak).toBe(2);
    expect(results.map((r) => r.value)).toEqual([0, 10, 20, 30, 40]);
    expect(progress.at(-1)).toEqual([5, 5]);
  });

  it('captures failures per item instead of rejecting', async () => {
    const results = await runBatched([1, 2, 3], async (x) => {
      if (x === 2) throw new Error('boom');
      return x;
    });
    expect(results[0]).toEqual({ ok: true, value: 1 });
    expect(results[1].ok).toBe(false);
    expect(results[1].error.message).toBe('boom');
    expect(results[2]).toEqual({ ok: true, value: 3 });
  });

  it('stops scheduling when cancelled', async () => {
    let calls = 0;
    let cancelled = false;
    await runBatched(
      [1, 2, 3, 4, 5],
      async () => {
        calls++;
        if (calls === 2) cancelled = true;
        await sleep(1);
      },
      { concurrency: 1, isCancelled: () => cancelled },
    );
    expect(calls).toBe(2);
  });

  it('handles an empty list', async () => {
    expect(await runBatched([], async () => 1)).toEqual([]);
  });
});

describe('cachePut', () => {
  it('evicts the oldest insertion past the bound and refreshes re-inserted keys', () => {
    const m = new Map();
    cachePut(m, 'a', 1, 2);
    cachePut(m, 'b', 2, 2);
    cachePut(m, 'a', 3, 2); // refresh a
    cachePut(m, 'c', 4, 2); // evicts b
    expect([...m.keys()]).toEqual(['a', 'c']);
    expect(m.get('a')).toBe(3);
  });
});
