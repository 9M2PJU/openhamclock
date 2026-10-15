/**
 * flmsg-format — parser/serialiser round-trips, WRAP envelope + CRC-16, and
 * conversion to EmComm field-report records. Fixtures in fixtures/flmsg are
 * byte-exact flmsg files (explicit field lengths, multi-line values).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import fmt from './flmsg-format.js';

const {
  lineout,
  parseFlmsg,
  serializeFlmsg,
  buildIcs213,
  fieldsToFriendly,
  crc16,
  wrapFlmsg,
  unwrapFlmsg,
  findLocation,
  parseHeaderStamp,
  parseFormDateTime,
  formToFieldReport,
} = fmt;

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'flmsg', name), 'utf8');

describe('lineout', () => {
  it('writes tag, byte length, one space, value, newline — and nothing for empty values', () => {
    expect(lineout('to', 'EOC')).toBe(':to:3 EOC\n');
    expect(lineout('mg', 'a\nb')).toBe(':mg:3 a\nb\n');
    expect(lineout('mg', 'café')).toBe(':mg:5 café\n'); // bytes, not characters
    expect(lineout('to', '')).toBe('');
    expect(lineout('to', null)).toBe('');
  });
});

describe('parseFlmsg', () => {
  it('reads the ICS-213 fixture: version, header, form and multi-line message', () => {
    const doc = parseFlmsg(fixture('shelter-cots.213'));
    expect(doc.version).toBe('4.0.23');
    expect(doc.form).toBe('ics213');
    expect(doc.header.hdr_fm).toBe('KE8PLM 20261015143200');
    expect(doc.fields.to).toBe('Logistics Section Chief');
    expect(doc.fields.sb).toBe('Cots required');
    expect(doc.fields.mg.split('\n')).toHaveLength(3);
    expect(doc.fields.mg).toMatch(/^Need 40 cots/);
    expect(doc.fields.p3).toBe('Shelter Manager');
  });

  it('keeps a value that itself contains a line starting with ":xx:"', () => {
    const text = `<flmsg>4.0.23\n<ics213>\n${lineout('mg', 'line one\n:to:3 not a field\nend')}${lineout('to', 'EOC')}`;
    const doc = parseFlmsg(text);
    expect(doc.fields.mg).toBe('line one\n:to:3 not a field\nend');
    expect(doc.fields.to).toBe('EOC');
  });

  it('tolerates wrong lengths, CRLF line endings and a BOM', () => {
    const text = '\uFEFF<flmsg>4.0.23\r\n<ics213>\r\n:to:99 EOC\r\n:sb:2 Cots required\r\n:mg:4 hello\r\nworld\r\n';
    const doc = parseFlmsg(text);
    expect(doc.form).toBe('ics213');
    expect(doc.fields.to).toBe('EOC');
    expect(doc.fields.sb).toBe('Cots required');
    expect(doc.fields.mg).toBe('hello\nworld');
  });

  it('returns an empty document for non-flmsg input', () => {
    expect(parseFlmsg('hello world').form).toBeNull();
    expect(parseFlmsg(undefined).form).toBeNull();
  });
});

describe('serialise ↔ parse round-trip', () => {
  it('buildIcs213 → parseFlmsg gives back every field', () => {
    const input = {
      incident: 'Spring Flood 2026',
      to: 'Logistics Section Chief',
      toPosition: 'EOC',
      from: 'Shelter 3 Manager',
      fromPosition: 'Lincoln HS',
      subject: 'Cots required',
      date: '2026-10-15',
      time: '1432Z',
      message: 'Need 40 cots.\nCensus 112.\n\nThanks — J.',
      approvedBy: 'J. Smith',
      approvedPosition: 'Shelter Manager',
    };
    const text = buildIcs213(input, { call: 'ke8plm', when: Date.UTC(2026, 9, 15, 14, 32, 0) });
    expect(text.startsWith('<flmsg>')).toBe(true);
    expect(text).toContain(':hdr_fm:21 KE8PLM 20261015143200\n');
    expect(text).toContain('<ics213>\n');
    const doc = parseFlmsg(text);
    expect(fieldsToFriendly(doc.form, doc.fields)).toEqual(input);
  });

  it('fills date and time (UTC) when they are not given and omits empty fields', () => {
    const text = buildIcs213({ to: 'EOC', message: 'hi', subject: '' }, { when: Date.UTC(2026, 0, 2, 3, 4) });
    const doc = parseFlmsg(text);
    expect(doc.fields).toEqual({ to: 'EOC', d1: '2026-01-02', t1: '0304Z', mg: 'hi' });
  });

  it('re-serialising a parsed fixture reproduces it byte for byte', () => {
    const original = fixture('shelter-cots.213');
    const doc = parseFlmsg(original);
    const again =
      `<flmsg>${doc.version}\n` +
      lineout('hdr_fm', doc.header.hdr_fm) +
      lineout('hdr_ed', doc.header.hdr_ed) +
      `<${doc.form}>\n` +
      Object.entries(doc.fields)
        .map(([k, v]) => lineout(k, v))
        .join('');
    expect(again).toBe(original);
  });

  it('serializeFlmsg writes arbitrary forms', () => {
    const text = serializeFlmsg({ form: 'plaintext', fields: { tt: 'Title', mg: 'Body' }, call: 'N0CALL', when: 0 });
    expect(text).toBe(
      '<flmsg>4.0.23\n:hdr_fm:21 N0CALL 19700101000000\n:hdr_ed:21 N0CALL 19700101000000\n<plaintext>\n:tt:5 Title\n:mg:4 Body\n',
    );
  });
});

describe('WRAP envelope', () => {
  it('crc16 matches the CRC-16/MODBUS check value', () => {
    expect(crc16('123456789')).toBe('4B37');
    expect(crc16('')).toBe('FFFF');
  });

  it('wrap → unwrap returns the content, filename and a passing checksum', () => {
    const content = fixture('shelter-cots.213');
    const wrapped = wrapFlmsg(content, 'shelter-cots.213');
    expect(wrapped.startsWith('[WRAP:beg][WRAP:lf][WRAP:fn shelter-cots.213]<flmsg>')).toBe(true);
    expect(wrapped).toMatch(/\[WRAP:chksum [0-9A-F]{4}\]\[WRAP:end\]$/);
    const u = unwrapFlmsg(`\nnoise before\n${wrapped}\nnoise after`);
    expect(u).toMatchObject({ filename: 'shelter-cots.213', content, checksumOk: true, compressed: false });
  });

  it('flags a corrupted transfer', () => {
    const wrapped = wrapFlmsg(fixture('shelter-cots.213'), 'x.213').replace('40 cots', '41 cots');
    expect(unwrapFlmsg(wrapped).checksumOk).toBe(false);
  });

  it('returns null for text without an envelope', () => {
    expect(unwrapFlmsg('<flmsg>4.0.23')).toBeNull();
  });
});

describe('helpers', () => {
  it('findLocation recognises lat/lon, grids and decimal pairs', () => {
    expect(findLocation('LAT 39.0997 LON -94.5786')).toMatchObject({ lat: 39.0997, lon: -94.5786 });
    expect(findLocation('Lat: 39.1N, Long: 94.6W')).toMatchObject({ lat: 39.1, lon: -94.6 });
    const g = findLocation('position GRID EM29qb');
    expect(g.source).toBe('grid');
    expect(g.lat).toBeCloseTo(39.06, 1);
    expect(findLocation('at 39.0997, -94.5786 now')).toMatchObject({ lat: 39.0997, lon: -94.5786 });
    expect(findLocation('need 40 cots by 1800')).toBeNull();
  });

  it('parseHeaderStamp splits call and UTC time', () => {
    expect(parseHeaderStamp('KE8PLM 20261015143200')).toEqual({ call: 'KE8PLM', time: Date.UTC(2026, 9, 15, 14, 32) });
    expect(parseHeaderStamp('')).toEqual({ call: '', time: null });
  });

  it('parseFormDateTime handles ISO and US dates, Z and local times', () => {
    expect(parseFormDateTime('2026-10-15', '1432Z')).toBe(Date.UTC(2026, 9, 15, 14, 32));
    expect(parseFormDateTime('10/15/26', '14:32Z')).toBe(Date.UTC(2026, 9, 15, 14, 32));
    expect(parseFormDateTime('2026-10-15', '1432L')).toBe(new Date(2026, 9, 15, 14, 32).getTime());
    expect(parseFormDateTime('', '1432')).toBeNull();
    expect(parseFormDateTime('2026-13-40', '')).toBeNull();
  });
});

describe('formToFieldReport', () => {
  it('turns the ICS-213 fixture into a located field report', () => {
    const r = formToFieldReport(fixture('shelter-cots.213'), { file: '/x/NBEMS.files/ICS/messages/shelter-cots.213' });
    expect(r).toMatchObject({
      callsign: 'KE8PLM',
      formType: 'ICS-213 (NBEMS)',
      form: 'ics213',
      timestamp: Date.UTC(2026, 9, 15, 14, 32),
    });
    expect(r.id).toMatch(/^[0-9a-f]{40}$/);
    expect(r.text).toMatch(/^Cots required — Need 40 cots/);
    expect(r.lat).toBeCloseTo(39.06, 1);
    expect(r.lon).toBeCloseTo(-94.62, 1);
    expect(r.extra).toMatchObject({
      incident: 'Spring Flood 2026',
      to: 'Logistics Section Chief',
      from: 'Shelter 3 Manager',
      file: 'shelter-cots.213',
    });
  });

  it('gives the same id for the plain file and its wrapped transfer, and records the checksum', () => {
    const plain = fixture('shelter-cots.213');
    const a = formToFieldReport(plain);
    const b = formToFieldReport(wrapFlmsg(plain, 'shelter-cots.213'));
    expect(b.id).toBe(a.id);
    expect(b.extra.checksum).toBe('OK');
  });

  it('reads a radiogram', () => {
    const r = formToFieldReport(fixture('welfare.m2s'));
    expect(r).toMatchObject({ callsign: 'N8TAG', formType: 'Radiogram (NBEMS)', lat: null, lon: null });
    expect(r.text).toMatch(/^SHELTER AT LINCOLN HS/);
    expect(r.extra).toMatchObject({ number: '42', precedence: 'PRIORITY', check: '12', placeOfOrigin: 'Columbus OH' });
  });

  it('falls back to a generic record for other forms', () => {
    const text = serializeFlmsg({ form: 'ics214', fields: { sb: 'Unit log', mg: 'All quiet' }, call: 'W1AW', when: 0 });
    expect(formToFieldReport(text)).toMatchObject({ formType: 'ICS-214 (NBEMS)', text: 'Unit log — All quiet' });
  });

  it('returns null for non-forms and an error marker for compressed transfers', () => {
    expect(formToFieldReport('just some text')).toBeNull();
    expect(formToFieldReport(wrapFlmsg('[b64:start]XQAAgA[b64:end]', 'c.213'))).toEqual({
      error: 'compressed',
      filename: 'c.213',
    });
  });
});
