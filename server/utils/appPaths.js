/**
 * Resolve where OpenHamClock reads bundled files from and where it writes.
 *
 * In a normal checkout both are the repo root. Inside a single-file
 * executable built with @yao-pkg/pkg, the code and bundled assets live in
 * pkg's read-only virtual filesystem (/snapshot/... or C:\snapshot\...), so
 * everything the server writes — .env, config.json, data/ — has to go to a
 * real directory instead. That is the folder containing the executable, or
 * OPENHAMCLOCK_HOME when set.
 */

const path = require('path');

/**
 * @param {object} opts
 * @param {string} opts.moduleDir - __dirname of the module that owns the repo root (server/)
 * @param {boolean} [opts.packaged] - true when running inside a pkg executable (process.pkg)
 * @param {string} [opts.execPath] - process.execPath
 * @param {object} [opts.env] - process.env
 * @returns {{ ASSET_DIR: string, ROOT_DIR: string, IS_PACKAGED: boolean }}
 *   ASSET_DIR — bundled, read-only files (dist/, public/, package.json, .env.example)
 *   ROOT_DIR  — writable home (.env, config.json, data/); equals ASSET_DIR when not packaged
 */
function resolveAppDirs({ moduleDir, packaged = false, execPath = '', env = {} }) {
  const ASSET_DIR = path.join(moduleDir, '..');
  if (!packaged) {
    return { ASSET_DIR, ROOT_DIR: ASSET_DIR, IS_PACKAGED: false };
  }
  const home = (env.OPENHAMCLOCK_HOME || '').trim();
  const ROOT_DIR = home ? path.resolve(home) : path.dirname(execPath);
  return { ASSET_DIR, ROOT_DIR, IS_PACKAGED: true };
}

module.exports = { resolveAppDirs };
