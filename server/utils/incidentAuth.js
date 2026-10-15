/**
 * incidentAuth — ids, join keys and key verification for shared incidents.
 *
 * An incident is addressed by a short random id and guarded by a join key
 * that is handed out exactly once, at creation. The server keeps only a
 * salted SHA-256 of the key, so the persisted incidents file never contains
 * anything that lets a reader join. Verification hashes the presented key
 * with the stored salt and compares digests with crypto.timingSafeEqual, so
 * a wrong key costs the same time whatever its first differing character.
 *
 * Alphabet: 31 symbols without the I/L/O/0/1 lookalikes, because ids and
 * keys get read over a radio and typed on a phone.
 */

const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ID_LENGTH = 8; // 31^8 ≈ 8.5e11
const KEY_LENGTH = 16; // 31^16 ≈ 7.3e23
const SALT_BYTES = 16;

/** Uniform random string over ALPHABET (rejection-sampled, no modulo bias). */
function randomToken(length) {
  const limit = 256 - (256 % ALPHABET.length);
  let out = '';
  while (out.length < length) {
    for (const byte of crypto.randomBytes(length)) {
      if (byte < limit && out.length < length) out += ALPHABET[byte % ALPHABET.length];
    }
  }
  return out;
}

const makeIncidentId = () => randomToken(ID_LENGTH);
const makeJoinKey = () => randomToken(KEY_LENGTH);

/** Normalise user input: trim, upper-case, drop separators people add for readability. */
function normaliseToken(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

const isValidIncidentId = (id) => typeof id === 'string' && new RegExp(`^[${ALPHABET}]{${ID_LENGTH}}$`).test(id);

/** @returns {{ salt: string, hash: string }} hex-encoded */
function hashJoinKey(key, salt = crypto.randomBytes(SALT_BYTES).toString('hex')) {
  const hash = crypto
    .createHash('sha256')
    .update(`${salt}:${normaliseToken(key)}`)
    .digest('hex');
  return { salt, hash };
}

/** Constant-time check of a presented key against a stored salt + hash. */
function verifyJoinKey(presented, salt, hash) {
  if (typeof salt !== 'string' || typeof hash !== 'string' || !presented) return false;
  const candidate = hashJoinKey(presented, salt).hash;
  const a = Buffer.from(candidate, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  ALPHABET,
  ID_LENGTH,
  KEY_LENGTH,
  randomToken,
  makeIncidentId,
  makeJoinKey,
  normaliseToken,
  isValidIncidentId,
  hashJoinKey,
  verifyJoinKey,
};
