import { describe, expect, it } from 'vitest';
import { defaultRemoteRuntimeConfigFromEnv, renderRemoteRuntimeContext } from './remote-runtime-context.js';

describe('remote runtime context', () => {
  it('is disabled until the Pi SSH target and project path are configured', () => {
    const config = defaultRemoteRuntimeConfigFromEnv({}, '/Users/minyangchow/Documents/NanoClaw');

    expect(config.enabled).toBe(false);
    expect(renderRemoteRuntimeContext(config)).toBe('');
  });

  it('renders Mac-control-plane guidance for Pi-hosted DC runtime', () => {
    const config = defaultRemoteRuntimeConfigFromEnv(
      {
        NANOCLAW_PI_HOST: 'nanoclaw-pi.local',
        NANOCLAW_PI_USER: 'pi',
        NANOCLAW_PI_PROJECT_ROOT: '/home/pi/NanoClaw',
        NANOCLAW_PI_SECOND_BRAIN_ROOT: '/home/pi/Distributed-Cognition',
        NANOCLAW_PI_CODEX_PROJECTS_ROOT: '/home/pi/Codex',
        NANOCLAW_PI_EXPECTED_COMMIT: 'abc123',
      },
      '/Users/minyangchow/Documents/NanoClaw',
    );

    const markdown = renderRemoteRuntimeContext(config);

    expect(config.enabled).toBe(true);
    expect(markdown).toContain('Distributed Cognition and WhatsApp/Baileys are expected to run on the Raspberry Pi');
    expect(markdown).toContain('Mac as the SSH control plane');
    expect(markdown).toContain('Do not start or restart the Mac NanoClaw/WhatsApp host');
    expect(markdown).toContain("cd '/Users/minyangchow/Documents/NanoClaw'");
    expect(markdown).toContain("pnpm run pi:ssh-admin -- status --host 'nanoclaw-pi.local'");
    expect(markdown).toContain("pnpm run pi:ssh-admin -- bridge-timers --host 'nanoclaw-pi.local'");
    expect(markdown).toContain(
      "pnpm run pi:ssh-admin -- process-bridges --host 'nanoclaw-pi.local' --user 'pi' --path '/home/pi/NanoClaw' --second-brain-root '/home/pi/Distributed-Cognition' --codex-projects-root '/home/pi/Codex'",
    );
    expect(markdown).toContain('--execute-bridges');
    expect(markdown).toContain("--expected-commit 'abc123'");
  });

  it('normalizes older persisted pnpm admin commands without the separator', () => {
    const markdown = renderRemoteRuntimeContext({
      enabled: true,
      host: 'nanoclaw-pi.local',
      user: 'pi',
      projectRoot: '/home/pi/NanoClaw',
      adminCommand: 'pnpm run pi:ssh-admin',
    });

    expect(markdown).toContain("pnpm run pi:ssh-admin -- status --host 'nanoclaw-pi.local'");
  });
});
