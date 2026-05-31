import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { MAC_RUNTIME_LOCK_OVERRIDE_ENV, checkMacRuntimeLock, macRuntimeLockPath } from './runtime-lock.js';

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-runtime-lock-'));
  tempRoots.push(root);
  return root;
}

function writeLock(projectRoot: string, content: string): string {
  const lockPath = macRuntimeLockPath(projectRoot);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, content);
  return lockPath;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Mac runtime cutover lock', () => {
  it('allows startup when the lock is absent', () => {
    const projectRoot = makeTempRoot();

    expect(checkMacRuntimeLock({ projectRoot, hostname: 'minyang-mac' })).toMatchObject({
      blocked: false,
      reason: 'missing',
    });
  });

  it('blocks startup on the same host after Pi state export', () => {
    const projectRoot = makeTempRoot();
    const lockPath = writeLock(projectRoot, 'source_host=minyang-mac\nreason=pi_state_export_completed\n');

    expect(checkMacRuntimeLock({ projectRoot, hostname: 'minyang-mac' })).toMatchObject({
      blocked: true,
      path: lockPath,
      reason: 'blocked',
      sourceHost: 'minyang-mac',
    });
  });

  it('does not block a different host if the local lock is accidentally copied', () => {
    const projectRoot = makeTempRoot();
    writeLock(projectRoot, 'source_host=minyang-mac\nreason=pi_state_export_completed\n');

    expect(checkMacRuntimeLock({ projectRoot, hostname: 'nanoclaw-pi' })).toMatchObject({
      blocked: false,
      reason: 'foreign-host',
      sourceHost: 'minyang-mac',
    });
  });

  it('can be deliberately overridden for rollback', () => {
    const projectRoot = makeTempRoot();
    writeLock(projectRoot, 'source_host=minyang-mac\nreason=pi_state_export_completed\n');

    expect(
      checkMacRuntimeLock({
        projectRoot,
        hostname: 'minyang-mac',
        env: { [MAC_RUNTIME_LOCK_OVERRIDE_ENV]: 'true' },
      }),
    ).toMatchObject({
      blocked: false,
      reason: 'override',
    });
  });
});
