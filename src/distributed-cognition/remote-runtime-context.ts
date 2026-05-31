export interface RemoteRuntimeConfig {
  enabled?: boolean;
  label?: string;
  host?: string;
  user?: string;
  projectRoot?: string;
  secondBrainRoot?: string;
  codexProjectsRoot?: string;
  expectedCommit?: string;
  operatorRepo?: string;
  adminCommand?: string;
}

export function defaultRemoteRuntimeConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  operatorRepo = process.cwd(),
): RemoteRuntimeConfig {
  const host = env.NANOCLAW_PI_HOST || env.PI_HOST || '';
  const user = env.NANOCLAW_PI_USER || env.PI_USER || '';
  const projectRoot = env.NANOCLAW_PI_PROJECT_ROOT || '';
  return {
    enabled: Boolean(host && user && projectRoot),
    label: 'Distributed Cognition Raspberry Pi runtime',
    host,
    user,
    projectRoot,
    secondBrainRoot: env.NANOCLAW_PI_SECOND_BRAIN_ROOT || env.DC_SECOND_BRAIN_ROOT || '',
    codexProjectsRoot: env.NANOCLAW_PI_CODEX_PROJECTS_ROOT || '',
    expectedCommit: env.NANOCLAW_PI_EXPECTED_COMMIT || '',
    operatorRepo,
    adminCommand: 'pnpm run pi:ssh-admin --',
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function commandOption(name: string, value?: string): string[] {
  return value ? [`--${name}`, shellQuote(value)] : [];
}

function normalizedAdminCommand(command?: string): string {
  const base = (command || 'pnpm run pi:ssh-admin --').trim();
  return base === 'pnpm run pi:ssh-admin' ? `${base} --` : base;
}

function adminCommand(
  config: RemoteRuntimeConfig,
  action: string,
  options: { includeSecondBrain?: boolean; includeCodexProjects?: boolean; bridgeExecuteMode?: 'memory' | 'all' } = {},
): string {
  const parts = [
    normalizedAdminCommand(config.adminCommand),
    action,
    ...commandOption('host', config.host),
    ...commandOption('user', config.user),
    ...commandOption('path', config.projectRoot),
  ];
  if (options.includeSecondBrain) parts.push(...commandOption('second-brain-root', config.secondBrainRoot));
  if (options.includeCodexProjects) parts.push(...commandOption('codex-projects-root', config.codexProjectsRoot));
  if (options.bridgeExecuteMode === 'memory') parts.push('--bridge-execute-mode', 'memory');
  if (options.bridgeExecuteMode === 'all') parts.push('--execute-bridges');
  if (config.expectedCommit && (action === 'status' || action === 'doctor')) {
    parts.push(...commandOption('expected-commit', config.expectedCommit));
  }
  return parts.join(' ');
}

export function renderRemoteRuntimeContext(config?: RemoteRuntimeConfig): string {
  if (!config?.enabled) return '';

  const target = config.host ? `${config.user ? `${config.user}@` : ''}${config.host}` : 'not configured';
  const lines = [
    'Remote Distributed Cognition runtime context:',
    '- Distributed Cognition and WhatsApp/Baileys are expected to run on the Raspberry Pi.',
    '- This Codex task may run on the Mac as the SSH control plane for the Pi runtime.',
    '- Do not start or restart the Mac NanoClaw/WhatsApp host unless the owner explicitly asks to roll back.',
    '- Use SSH/admin checks before touching Pi runtime state.',
    `- Runtime label: ${config.label || 'Distributed Cognition Raspberry Pi runtime'}`,
    `- SSH target: ${target}`,
  ];

  if (config.projectRoot) lines.push(`- Pi NanoClaw path: ${config.projectRoot}`);
  if (config.secondBrainRoot) lines.push(`- Pi second-brain path: ${config.secondBrainRoot}`);
  if (config.codexProjectsRoot) lines.push(`- Pi Codex projects path: ${config.codexProjectsRoot}`);
  if (config.expectedCommit) lines.push(`- Expected Pi commit: ${config.expectedCommit}`);
  if (config.operatorRepo) lines.push(`- Mac operator repo: ${config.operatorRepo}`);

  lines.push('', 'Useful Mac control-plane commands:');
  if (config.operatorRepo) lines.push(`- cd ${shellQuote(config.operatorRepo)}`);
  lines.push(`- ${adminCommand(config, 'status')}`);
  lines.push(`- ${adminCommand(config, 'doctor', { includeSecondBrain: true })}`);
  lines.push(`- ${adminCommand(config, 'bridge-timers')}`);
  if (config.secondBrainRoot && config.codexProjectsRoot) {
    lines.push(
      '- For bridge work, use dry-run first; use memory mode for Pi-side Mnemon promotion while keeping Codex/action handoffs reviewable from Mac Codex.',
    );
    lines.push(
      `- ${adminCommand(config, 'process-bridges', {
        includeSecondBrain: true,
        includeCodexProjects: true,
      })}`,
    );
    lines.push(
      `- ${adminCommand(config, 'process-bridges', {
        includeSecondBrain: true,
        includeCodexProjects: true,
        bridgeExecuteMode: 'memory',
      })}`,
    );
    lines.push(
      `- ${adminCommand(config, 'process-bridges', {
        includeSecondBrain: true,
        includeCodexProjects: true,
        bridgeExecuteMode: 'all',
      })}`,
    );
  }
  lines.push(`- ${adminCommand(config, 'logs')}`);

  return lines.join('\n');
}
