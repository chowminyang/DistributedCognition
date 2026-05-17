import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { resolveProviderName, writeDockerEnvFile } from './container-runner.js';

describe('resolveProviderName', () => {
  it('prefers session over container config', () => {
    expect(resolveProviderName('codex', 'claude')).toBe('codex');
  });

  it('falls back to container config when session is null', () => {
    expect(resolveProviderName(null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null)).toBe('codex');
    expect(resolveProviderName(null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'opencode')).toBe('opencode');
    expect(resolveProviderName(null, '')).toBe('claude');
  });
});

describe('writeDockerEnvFile', () => {
  it('writes secret env values to a private env-file instead of argv-shaped args', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-env-test-'));
    const envFile = writeDockerEnvFile(tmp, 'provider', {
      OPENAI_API_KEY: 'sk-test-secret',
      CODEX_MODEL: 'gpt-5.4-mini',
    });

    expect(envFile).toBe(path.join(tmp, '.container-env', 'provider.env'));
    expect(fs.statSync(envFile!).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(envFile!, 'utf8')).toBe('OPENAI_API_KEY=sk-test-secret\nCODEX_MODEL=gpt-5.4-mini\n');
  });

  it('rejects unsafe env keys and newline-bearing values', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-env-test-'));

    expect(() => writeDockerEnvFile(tmp, 'provider', { 'BAD-KEY': 'value' })).toThrow(/Unsafe Docker env key/);
    expect(() => writeDockerEnvFile(tmp, 'provider', { OPENAI_API_KEY: 'line1\nline2' })).toThrow(
      /Unsafe Docker env value/,
    );
  });
});
