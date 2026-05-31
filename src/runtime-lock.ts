import fs from 'fs';
import os from 'os';
import path from 'path';

export const MAC_RUNTIME_LOCK_RELATIVE_PATH = path.join('logs', 'pi-cutover', 'mac-runtime-disabled.lock');
export const MAC_RUNTIME_LOCK_OVERRIDE_ENV = 'NANOCLAW_ALLOW_MAC_RUNTIME_AFTER_PI_EXPORT';

export type MacRuntimeLockCheck = {
  blocked: boolean;
  path: string;
  reason: 'missing' | 'blocked' | 'foreign-host' | 'override';
  sourceHost?: string;
};

function normalizeHost(host: string | undefined): string {
  return (host || '').trim().toLowerCase();
}

function parseLockContent(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 1) continue;
    values[trimmed.slice(0, index)] = trimmed.slice(index + 1);
  }
  return values;
}

export function macRuntimeLockPath(projectRoot = process.cwd()): string {
  return path.join(projectRoot, MAC_RUNTIME_LOCK_RELATIVE_PATH);
}

export function checkMacRuntimeLock(
  options: {
    projectRoot?: string;
    env?: NodeJS.ProcessEnv;
    hostname?: string;
  } = {},
): MacRuntimeLockCheck {
  const projectRoot = options.projectRoot ?? process.cwd();
  const env = options.env ?? process.env;
  const hostname = normalizeHost(options.hostname ?? os.hostname());
  const lockPath = macRuntimeLockPath(projectRoot);

  if (!fs.existsSync(lockPath)) {
    return { blocked: false, path: lockPath, reason: 'missing' };
  }

  if (env[MAC_RUNTIME_LOCK_OVERRIDE_ENV] === 'true') {
    return { blocked: false, path: lockPath, reason: 'override' };
  }

  const values = parseLockContent(fs.readFileSync(lockPath, 'utf8'));
  const sourceHost = values.source_host;
  if (sourceHost && normalizeHost(sourceHost) !== hostname) {
    return { blocked: false, path: lockPath, reason: 'foreign-host', sourceHost };
  }

  return { blocked: true, path: lockPath, reason: 'blocked', sourceHost };
}
