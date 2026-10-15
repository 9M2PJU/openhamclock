/**
 * Generate rig-bridge/lib/lightning-guard-logic.js (CommonJS) from the single
 * source of the lightning guard logic, src/utils/lightningGuard.js (ESM).
 *
 * Rig Bridge is packaged on its own (pkg binaries, standalone installs), so it
 * cannot require files from src/, and Vite cannot serve a CommonJS source file
 * to the browser — so the bridge gets a mechanically generated copy instead of
 * a hand-maintained duplicate. rig-bridge/lib/lightning-guard-logic.test.js
 * regenerates in memory and fails when the committed copy is stale.
 *
 *   npm run lightning:sync      write the copy
 *   npm run lightning:sync -- --check   exit 1 when it is stale
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCE = path.join(ROOT, 'src/utils/lightningGuard.js');
export const TARGET = path.join(ROOT, 'rig-bridge/lib/lightning-guard-logic.js');

const HEADER = `'use strict';
/**
 * lightning-guard-logic.js — GENERATED from src/utils/lightningGuard.js by
 * scripts/lightning-guard-cjs.mjs. Do not edit: change the source and run
 * \`npm run lightning:sync\`. The parity test next to this file fails when
 * the two drift.
 */
`;

/** ESM source → CommonJS text (unformatted). Throws on constructs it can't convert. */
export function toCommonJs(source) {
  if (/^\s*import\s/m.test(source))
    throw new Error('lightningGuard.js must not import anything (shared with Rig Bridge)');
  if (/^\s*export\s+(default|\{|\*)/m.test(source)) {
    throw new Error('lightningGuard.js: use `export const|function|class` only (shared with Rig Bridge)');
  }
  const names = [];
  const body = source.replace(/^export\s+(const|let|function|class)\s+([A-Za-z_$][\w$]*)/gm, (m, kind, name) => {
    names.push(name);
    return `${kind} ${name}`;
  });
  return `${HEADER}\n${body.trimEnd()}\n\nmodule.exports = {\n${names.map((n) => `  ${n},`).join('\n')}\n};\n`;
}

/** The exact text the generated file should contain (prettier-formatted). */
export async function generate() {
  const cjs = toCommonJs(fs.readFileSync(SOURCE, 'utf8'));
  const options = (await prettier.resolveConfig(TARGET)) || {};
  return prettier.format(cjs, { ...options, filepath: TARGET });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const text = await generate();
  const current = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, 'utf8') : '';
  if (process.argv.includes('--check')) {
    if (current !== text) {
      console.error('❌ rig-bridge/lib/lightning-guard-logic.js is stale — run `npm run lightning:sync`');
      process.exit(1);
    }
    console.log('✅ rig-bridge/lib/lightning-guard-logic.js is up to date');
  } else if (current !== text) {
    fs.writeFileSync(TARGET, text);
    console.log('Wrote rig-bridge/lib/lightning-guard-logic.js');
  } else {
    console.log('rig-bridge/lib/lightning-guard-logic.js already up to date');
  }
}
