import { describe, it, expect } from 'vitest';
import path from 'path';
import { resolveAppDirs } from './appPaths.js';

const moduleDir = path.join('/repo', 'server');

describe('resolveAppDirs', () => {
  it('uses the repo root for both assets and data in a normal checkout', () => {
    const dirs = resolveAppDirs({ moduleDir });
    expect(dirs.IS_PACKAGED).toBe(false);
    expect(dirs.ASSET_DIR).toBe(path.join('/repo'));
    expect(dirs.ROOT_DIR).toBe(dirs.ASSET_DIR);
  });

  it('keeps assets in the snapshot and writes next to the executable when packaged', () => {
    const dirs = resolveAppDirs({
      moduleDir: path.join('/snapshot', 'openhamclock', 'server'),
      packaged: true,
      execPath: path.join('/home', 'pi', 'ohc', 'openhamclock'),
      env: {},
    });
    expect(dirs.IS_PACKAGED).toBe(true);
    expect(dirs.ASSET_DIR).toBe(path.join('/snapshot', 'openhamclock'));
    expect(dirs.ROOT_DIR).toBe(path.join('/home', 'pi', 'ohc'));
  });

  it('honours OPENHAMCLOCK_HOME for the writable folder when packaged', () => {
    const dirs = resolveAppDirs({
      moduleDir: path.join('/snapshot', 'openhamclock', 'server'),
      packaged: true,
      execPath: path.join('/usr', 'local', 'bin', 'openhamclock'),
      env: { OPENHAMCLOCK_HOME: ' /var/lib/openhamclock ' },
    });
    expect(dirs.ROOT_DIR).toBe(path.resolve('/var/lib/openhamclock'));
    expect(dirs.ASSET_DIR).toBe(path.join('/snapshot', 'openhamclock'));
  });

  it('ignores OPENHAMCLOCK_HOME when not packaged', () => {
    const dirs = resolveAppDirs({ moduleDir, env: { OPENHAMCLOCK_HOME: '/elsewhere' } });
    expect(dirs.ROOT_DIR).toBe(path.join('/repo'));
  });
});
