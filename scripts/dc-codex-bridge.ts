import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { appendProgressEvent, type DistributedQueueStatus } from '../src/distributed-cognition/queue-status.js';
import {
  attachCodexAutoApproval,
  killCodexAppServer,
  sendCodexRequest,
  spawnCodexAppServer,
  type AppServer,
  type JsonRpcNotification,
} from '../container/agent-runner/src/providers/codex-app-server.ts';

const DEFAULT_SECOND_BRAIN_ROOT = path.join(os.homedir(), 'Library/CloudStorage/Dropbox/Distributed-Cognition');
const DEFAULT_PROJECTS_ROOT = path.join(os.homedir(), 'Documents/Codex');
const CONFIG_VERSION = 1;
const MAX_PROMPT_CHARS = 12_000;

interface Args {
  command: 'process' | 'init';
  root: string;
  projectsRoot: string;
  configPath?: string;
  execute: boolean;
  submit: boolean;
  limit: number;
}

interface BridgeProjectConfig {
  relativePath: string;
  cloudEnv?: string;
  branch?: string;
  enabled?: boolean;
  localEnabled?: boolean;
  aliases?: string[];
}

interface BridgeConfig {
  version: typeof CONFIG_VERSION;
  projectsRoot: string;
  defaultBranch?: string;
  localCodex?: {
    enabled?: boolean;
    launchMode?: 'app-server' | 'exec';
    model?: string;
    effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
    sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
    approvalPolicy?: 'never' | 'on-request' | 'untrusted';
    webSearch?: boolean;
    timeoutMs?: number;
    openApp?: boolean;
  };
  projects: Record<string, BridgeProjectConfig>;
}

interface CodexHandoffRecord {
  version: number;
  id: string;
  createdAt: string;
  status: string;
  target: 'codex-local' | 'codex-cloud' | 'queue-only';
  projectName: string;
  relativeProjectPath: string;
  task: string;
  planMarkdown?: string;
  acceptanceCriteria?: string[];
  cloudEnv?: string;
  branch?: string;
  model?: string;
  priority?: string;
  sourceNotePaths?: string[];
  notePath?: string;
}

interface SubmissionResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
  cloudUrl?: string;
  cloudTaskId?: string;
  lastMessagePath?: string;
  threadId?: string;
  turnId?: string;
}

function usage(): never {
  console.error(
    [
      'Usage: pnpm run dc:codex-bridge -- [process|init] [options]',
      '',
      'Options:',
      '  --execute                Execute queued codex-local handoffs on this Mac. Omit for dry-run.',
      '  --submit                 Submit queued codex-cloud handoffs to Codex Cloud. Non-default.',
      '  --root <path>            Distributed Cognition second-brain root.',
      '  --projects-root <path>   Local Codex projects root.',
      '  --config <path>          Bridge config path.',
      '  --limit <n>              Maximum queued handoffs to process. Default: 5.',
    ].join('\n'),
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: 'process',
    root: DEFAULT_SECOND_BRAIN_ROOT,
    projectsRoot: DEFAULT_PROJECTS_ROOT,
    execute: false,
    submit: false,
    limit: 5,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      continue;
    } else if (arg === 'process' || arg === 'init') {
      args.command = arg;
    } else if (arg === '--submit') {
      args.submit = true;
    } else if (arg === '--execute') {
      args.execute = true;
    } else if (arg === '--root') {
      const value = argv[++i];
      if (!value) usage();
      args.root = path.resolve(value);
    } else if (arg === '--projects-root') {
      const value = argv[++i];
      if (!value) usage();
      args.projectsRoot = path.resolve(value);
    } else if (arg === '--config') {
      const value = argv[++i];
      if (!value) usage();
      args.configPath = path.resolve(value);
    } else if (arg === '--limit') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1) usage();
      args.limit = value;
    } else {
      usage();
    }
  }
  return args;
}

function sgtTimestamp(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Singapore',
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, part) => {
      if (part.type !== 'literal') acc[part.type] = part.value;
      return acc;
    }, {});
  return `${parts.day}-${parts.month}-${parts.year}, ${parts.hour}:${parts.minute}`;
}

function safeJoin(root: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('\0')) {
    throw new Error(`Unsafe relative path: ${relativePath}`);
  }
  const resolved = path.resolve(root, relativePath);
  const rootResolved = path.resolve(root);
  const rel = path.relative(rootResolved, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Path escapes root: ${relativePath}`);
  return resolved;
}

function indexDir(root: string): string {
  return path.join(root, '.dc-index');
}

function handoffDirs(root: string): { queued: string; completed: string; submitted: string; failed: string } {
  const base = path.join(indexDir(root), 'codex-handoffs');
  return {
    queued: path.join(base, 'queued'),
    completed: path.join(base, 'completed'),
    submitted: path.join(base, 'submitted'),
    failed: path.join(base, 'failed'),
  };
}

function defaultConfigPath(root: string): string {
  return path.join(indexDir(root), 'codex-bridge.config.json');
}

function hasProjectSignal(projectPath: string): boolean {
  return (
    fs.existsSync(path.join(projectPath, '.git')) ||
    fs.existsSync(path.join(projectPath, 'package.json')) ||
    fs.existsSync(path.join(projectPath, 'README.md')) ||
    fs.existsSync(path.join(projectPath, 'pyproject.toml'))
  );
}

function discoverProjects(projectsRoot: string): Record<string, BridgeProjectConfig> {
  if (!fs.existsSync(projectsRoot)) return {};
  const projects: Record<string, BridgeProjectConfig> = {};
  for (const entry of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || /backup/i.test(entry.name)) continue;
    const projectPath = path.join(projectsRoot, entry.name);
    if (!hasProjectSignal(projectPath)) continue;
    projects[entry.name] = {
      relativePath: entry.name,
      localEnabled: true,
      cloudEnv: '',
    };
  }
  return projects;
}

function defaultBridgeConfig(projectsRoot: string): BridgeConfig {
  return {
    version: CONFIG_VERSION,
    projectsRoot,
    defaultBranch: '',
    localCodex: {
      enabled: true,
      launchMode: 'app-server',
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
      webSearch: true,
      timeoutMs: 900_000,
      openApp: false,
    },
    projects: discoverProjects(projectsRoot),
  };
}

function writeTemplateConfig(configPath: string, projectsRoot: string): void {
  const template = defaultBridgeConfig(projectsRoot);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(template, null, 2)}\n`, { flag: 'wx' });
}

function loadConfig(configPath: string): BridgeConfig {
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as BridgeConfig;
  if (parsed.version !== CONFIG_VERSION || !parsed.projects || typeof parsed.projects !== 'object') {
    throw new Error(`Unsupported bridge config at ${configPath}`);
  }
  const defaults = defaultBridgeConfig(parsed.projectsRoot || DEFAULT_PROJECTS_ROOT);
  return {
    ...defaults,
    ...parsed,
    localCodex: { ...defaults.localCodex, ...(parsed.localCodex ?? {}) },
    projects: Object.fromEntries(
      Object.entries({ ...defaults.projects, ...parsed.projects }).map(([name, project]) => [
        name,
        { localEnabled: true, ...project },
      ]),
    ),
  };
}

function resolveProjectConfig(config: BridgeConfig, record: CodexHandoffRecord): BridgeProjectConfig | undefined {
  const direct = config.projects[record.projectName];
  if (direct) return direct;
  const wantedName = record.projectName.toLowerCase();
  const wantedRel = record.relativeProjectPath.toLowerCase();
  for (const [name, project] of Object.entries(config.projects)) {
    const aliases = project.aliases ?? [];
    const values = [name, project.relativePath, ...aliases].map((value) => value.toLowerCase());
    if (values.includes(wantedName) || values.includes(wantedRel)) return project;
  }
  return undefined;
}

function readQueuedHandoffs(root: string, limit: number): Array<{ filePath: string; record: CodexHandoffRecord }> {
  const dirs = handoffDirs(root);
  if (!fs.existsSync(dirs.queued)) return [];
  return fs
    .readdirSync(dirs.queued)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .slice(0, limit)
    .map((file) => {
      const filePath = path.join(dirs.queued, file);
      return {
        filePath,
        record: JSON.parse(fs.readFileSync(filePath, 'utf-8')) as CodexHandoffRecord,
      };
    });
}

function validateRecord(record: CodexHandoffRecord): void {
  if (!record.id || !/^[a-z0-9-]+$/i.test(record.id)) throw new Error('Queued handoff has unsafe or missing id.');
  if (record.target !== 'codex-local' && record.target !== 'codex-cloud' && record.target !== 'queue-only')
    throw new Error(`Unsupported handoff target: ${record.target}`);
  if (
    !record.projectName ||
    record.projectName.includes('/') ||
    record.projectName.includes('\\') ||
    record.projectName.includes('\0')
  ) {
    throw new Error(`Unsafe project name: ${record.projectName}`);
  }
  if (!record.task || record.task.length > MAX_PROMPT_CHARS)
    throw new Error('Queued handoff task is empty or too long.');
  if (/patient-identifiable|learner-identifiable|\bHR\b|exam material|answer[- ]?key|confidential/i.test(record.task)) {
    throw new Error('Queued handoff appears to include prohibited sensitive content.');
  }
}

function cloudPrompt(record: CodexHandoffRecord, projectPath: string): string {
  const sourceNotes = record.sourceNotePaths?.length ? record.sourceNotePaths.join('\n') : 'No source note supplied.';
  return [
    'Task requested via Distributed Cognition WhatsApp.',
    '',
    'Role:',
    'You are a Codex agent receiving a delegated brief from Distributed Cognition. Treat the handoff as a scoped implementation plan, verify it against the repo, then work only within the requested project.',
    '',
    `Project: ${record.projectName}`,
    `Local project reference path on submitting Mac: ${projectPath}`,
    `Queued at: ${record.createdAt}`,
    record.notePath ? `Handoff note: ${record.notePath}` : 'Handoff note: not supplied',
    '',
    'Source notes:',
    sourceNotes,
    '',
    'Task:',
    record.task,
    '',
    'Proposed plan from Distributed Cognition:',
    record.planMarkdown?.trim() ||
      'No explicit plan supplied. Inspect the repo, make a short plan, then proceed with scoped implementation.',
    '',
    'Expected execution style:',
    '- Inspect the relevant files and existing conventions first.',
    '- Preserve unrelated user changes.',
    '- Keep changes tightly scoped to the task.',
    '- Prefer the project test/build commands already present in the repo.',
    '',
    'Acceptance criteria:',
    record.acceptanceCriteria?.length
      ? record.acceptanceCriteria.map((criterion) => `- ${criterion}`).join('\n')
      : '- Use project-appropriate verification and report changed files, tests, and residual risk.',
    '',
    'Boundaries:',
    '- Respect the repository conventions and existing user changes.',
    '- Do not print, request, or commit secrets.',
    '- Do not process patient-identifiable, learner-identifiable, HR, exam, or confidential institutional data.',
    '- Keep changes scoped to the requested project.',
    '- Verify the change with the project-appropriate tests or checks when feasible.',
    '- Report the final changed files, verification, and any residual risk in the Codex task.',
  ].join('\n');
}

function localCodexPrompt(record: CodexHandoffRecord, projectPath: string): string {
  const sourceNotes = record.sourceNotePaths?.length ? record.sourceNotePaths.join('\n') : 'No source note supplied.';
  return [
    'Task requested via Distributed Cognition WhatsApp.',
    '',
    'Role:',
    'You are a local Codex agent receiving a delegated task from Distributed Cognition. Treat the handoff as a planning brief, then verify it against the repository before editing.',
    '',
    `Project: ${record.projectName}`,
    `Local project path: ${projectPath}`,
    `Queued at: ${record.createdAt}`,
    record.notePath ? `Handoff note: ${record.notePath}` : 'Handoff note: not supplied',
    '',
    'Source notes:',
    sourceNotes,
    '',
    'Task:',
    record.task,
    '',
    'Proposed plan from Distributed Cognition:',
    record.planMarkdown?.trim() ||
      'No explicit plan supplied. Inspect the repo, make a short plan, then proceed with scoped implementation.',
    '',
    'Expected execution style:',
    '- First inspect the relevant files and existing conventions.',
    '- Keep changes tightly scoped to the task.',
    '- Prefer the project test/build commands already present in the repo.',
    '- If the task is ambiguous, make the smallest useful progress and state the assumption.',
    '',
    'Acceptance criteria:',
    record.acceptanceCriteria?.length
      ? record.acceptanceCriteria.map((criterion) => `- ${criterion}`).join('\n')
      : '- Use project-appropriate verification and report changed files, tests, and residual risk.',
    '',
    'Boundaries:',
    "- This is local Codex work on the owner's Mac, not Codex Cloud.",
    '- Respect the repository conventions and existing user changes.',
    '- Do not print, request, or commit secrets.',
    '- Do not process patient-identifiable, learner-identifiable, HR, exam, or confidential institutional data.',
    '- Keep changes scoped to the requested project.',
    '- Verify the change with the project-appropriate tests or checks when feasible.',
    '- Report changed files, verification, and residual risk in the final response.',
  ].join('\n');
}

function progressTitle(record: CodexHandoffRecord): string {
  return `${record.projectName}: ${record.task}`;
}

function recordProgress(
  root: string,
  record: CodexHandoffRecord,
  status: DistributedQueueStatus,
  detail: string,
): void {
  appendProgressEvent(root, {
    kind: 'codex_handoff',
    id: record.id,
    status,
    title: progressTitle(record),
    target: record.target,
    detail,
  });
}

function writeLastMessage(root: string, record: CodexHandoffRecord, text: string): string {
  const lastMessageDir = safeJoin(root, '.dc-index/codex-handoffs/local-codex-output');
  fs.mkdirSync(lastMessageDir, { recursive: true });
  const lastMessagePath = path.join(lastMessageDir, `${record.id}-last-message.md`);
  fs.writeFileSync(lastMessagePath, text.endsWith('\n') ? text : `${text}\n`);
  return path.relative(root, lastMessagePath).split(path.sep).join('/');
}

function createTurnCompletionWaiter(
  server: AppServer,
  threadId: string,
  timeoutMs: number,
): { promise: Promise<{ turnId?: string; finalMessage: string }>; cancel: () => void } {
  let turnId: string | undefined;
  let finalMessage = '';
  let cleanup: () => void = () => undefined;

  const promise = new Promise<{ turnId?: string; finalMessage: string }>((resolve, reject) => {
    cleanup = (): void => {
      const index = server.notificationHandlers.indexOf(handler);
      if (index >= 0) server.notificationHandlers.splice(index, 1);
      clearTimeout(timer);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout waiting for Codex app-server turn completion (${timeoutMs}ms)`));
    }, timeoutMs);

    const handler = (notification: JsonRpcNotification): void => {
      const params = notification.params as {
        threadId?: string;
        turnId?: string;
        delta?: string;
        turn?: { id?: string; status?: string; error?: { message?: string } | null };
        item?: { type?: string; text?: string };
        error?: { message?: string };
      };
      if (params.threadId && params.threadId !== threadId) return;

      switch (notification.method) {
        case 'turn/started':
          turnId = params.turn?.id ?? params.turnId ?? turnId;
          break;
        case 'item/agentMessage/delta':
          if (typeof params.delta === 'string') finalMessage += params.delta;
          break;
        case 'item/completed':
          if (params.item?.type === 'agentMessage' && typeof params.item.text === 'string') {
            finalMessage = params.item.text;
          }
          break;
        case 'turn/completed':
          turnId = params.turn?.id ?? params.turnId ?? turnId;
          cleanup();
          resolve({ turnId, finalMessage });
          break;
        case 'error':
        case 'turn/failed':
          cleanup();
          reject(new Error(params.error?.message || params.turn?.error?.message || 'Codex app-server turn failed'));
          break;
        default:
          break;
      }
    };

    server.notificationHandlers.push(handler);
  });

  return { promise, cancel: cleanup };
}

async function initializeBridgeAppServer(server: AppServer): Promise<void> {
  const response = await sendCodexRequest(
    server,
    'initialize',
    {
      clientInfo: { name: 'distributed-cognition-bridge', title: 'Distributed Cognition Bridge', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    },
    30_000,
  );
  if (response.error) throw new Error(`Initialize failed: ${response.error.message}`);
}

async function runLocalCodexAppServer(
  root: string,
  record: CodexHandoffRecord,
  projectPath: string,
  config: BridgeConfig,
): Promise<SubmissionResult> {
  const server = spawnCodexAppServer();
  attachCodexAutoApproval(server);
  const timeoutMs = config.localCodex?.timeoutMs ?? 900_000;
  try {
    await initializeBridgeAppServer(server);
    const threadResponse = await sendCodexRequest(
      server,
      'thread/start',
      {
        model: config.localCodex?.model ?? record.model ?? 'gpt-5.4-mini',
        cwd: projectPath,
        approvalPolicy: config.localCodex?.approvalPolicy ?? 'never',
        sandbox: config.localCodex?.sandbox ?? 'danger-full-access',
        sessionStartSource: 'startup',
        experimentalRawEvents: false,
        persistExtendedHistory: true,
      },
      120_000,
    );
    if (threadResponse.error) throw new Error(`thread/start failed: ${threadResponse.error.message}`);
    const threadId = (threadResponse.result as { thread?: { id?: string } } | undefined)?.thread?.id;
    if (!threadId) throw new Error('thread/start response missing thread id');

    const completed = createTurnCompletionWaiter(server, threadId, timeoutMs);
    const turnResponse = await sendCodexRequest(
      server,
      'turn/start',
      {
        threadId,
        input: [{ type: 'text', text: localCodexPrompt(record, projectPath), text_elements: [] }],
        cwd: projectPath,
        approvalPolicy: config.localCodex?.approvalPolicy ?? 'never',
        model: config.localCodex?.model ?? record.model ?? 'gpt-5.4-mini',
        effort: config.localCodex?.effort ?? 'low',
      },
      120_000,
    );
    if (turnResponse.error) {
      completed.cancel();
      throw new Error(`turn/start failed: ${turnResponse.error.message}`);
    }
    const turnId = (turnResponse.result as { turn?: { id?: string } } | undefined)?.turn?.id;
    const result = await completed.promise;
    const lastMessagePath = writeLastMessage(
      root,
      record,
      result.finalMessage || `Codex app-server turn completed for thread ${threadId}.`,
    );

    if (config.localCodex?.openApp) {
      spawnSync('codex', ['app', projectPath], { encoding: 'utf-8', timeout: 15_000, maxBuffer: 250_000 });
    }

    return {
      ok: true,
      status: 0,
      stdout: `Codex app-server thread ${threadId} completed.`,
      stderr: '',
      lastMessagePath,
      threadId,
      turnId: result.turnId ?? turnId,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  } finally {
    killCodexAppServer(server);
  }
}

function runLocalCodexExec(
  root: string,
  record: CodexHandoffRecord,
  projectPath: string,
  config: BridgeConfig,
): SubmissionResult {
  if (config.localCodex?.enabled === false) throw new Error('Local Codex execution is disabled in bridge config.');
  const lastMessageDir = safeJoin(root, '.dc-index/codex-handoffs/local-codex-output');
  fs.mkdirSync(lastMessageDir, { recursive: true });
  const lastMessagePath = path.join(lastMessageDir, `${record.id}-last-message.md`);
  const args = ['--ask-for-approval', config.localCodex?.approvalPolicy ?? 'never'];
  if (config.localCodex?.webSearch !== false) args.push('--search');
  args.push(
    'exec',
    '--skip-git-repo-check',
    '--cd',
    projectPath,
    '--sandbox',
    config.localCodex?.sandbox ?? 'danger-full-access',
    '--output-last-message',
    lastMessagePath,
  );
  if (config.localCodex?.model) args.push('--model', config.localCodex.model);
  args.push('-');
  const result = spawnSync('codex', args, {
    cwd: projectPath,
    input: localCodexPrompt(record, projectPath),
    encoding: 'utf-8',
    timeout: config.localCodex?.timeoutMs ?? 900_000,
    maxBuffer: 4_000_000,
  });
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  if (config.localCodex?.openApp) {
    spawnSync('codex', ['app', projectPath], { encoding: 'utf-8', timeout: 15_000, maxBuffer: 250_000 });
  }
  return {
    ok: result.status === 0,
    status: result.status,
    stdout,
    stderr,
    lastMessagePath: path.relative(root, lastMessagePath).split(path.sep).join('/'),
  };
}

async function runLocalCodex(
  root: string,
  record: CodexHandoffRecord,
  projectPath: string,
  config: BridgeConfig,
): Promise<SubmissionResult> {
  if (config.localCodex?.enabled === false) throw new Error('Local Codex execution is disabled in bridge config.');
  if ((config.localCodex?.launchMode ?? 'app-server') === 'exec') {
    return runLocalCodexExec(root, record, projectPath, config);
  }
  return runLocalCodexAppServer(root, record, projectPath, config);
}

function submitToCodexCloud(
  record: CodexHandoffRecord,
  projectPath: string,
  cloudEnv: string,
  branch?: string,
): SubmissionResult {
  const prompt = cloudPrompt(record, projectPath);
  const args = ['cloud', 'exec', '--env', cloudEnv];
  if (branch) args.push('--branch', branch);
  args.push(prompt);
  const result = spawnSync('codex', args, {
    cwd: projectPath,
    encoding: 'utf-8',
    timeout: 120_000,
    maxBuffer: 2_000_000,
  });
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const cloudUrl = stdout.match(/https:\/\/chatgpt\.com\/codex\/tasks\/[^\s)]+/)?.[0];
  const cloudTaskId = stdout.match(/\btask_[A-Za-z0-9_]+\b/)?.[0] ?? cloudUrl?.split('/').pop();
  return {
    ok: result.status === 0 && Boolean(cloudUrl),
    status: result.status,
    stdout,
    stderr,
    cloudUrl,
    cloudTaskId,
  };
}

function updateNote(
  root: string,
  record: CodexHandoffRecord,
  status: 'completed' | 'submitted' | 'failed',
  details: string[],
): void {
  if (!record.notePath) return;
  const notePath = safeJoin(root, record.notePath);
  if (!fs.existsSync(notePath)) return;
  let text = fs.readFileSync(notePath, 'utf-8');
  text = text.replace(/(## Status\n)queued/, `$1${status}`);
  const heading = status === 'failed' ? '## Bridge Failure' : '## Codex Bridge';
  if (!text.includes(heading)) {
    text += `\n${heading}\n${details.join('\n')}\n`;
  }
  fs.writeFileSync(notePath, text);
}

function moveRecord(
  root: string,
  queuedPath: string,
  record: CodexHandoffRecord,
  status: 'completed' | 'submitted' | 'failed',
  extra: Record<string, unknown>,
): void {
  const dirs = handoffDirs(root);
  fs.mkdirSync(dirs.completed, { recursive: true });
  fs.mkdirSync(dirs.submitted, { recursive: true });
  fs.mkdirSync(dirs.failed, { recursive: true });
  const destination = path.join(
    status === 'completed' ? dirs.completed : status === 'submitted' ? dirs.submitted : dirs.failed,
    `${record.id}.json`,
  );
  if (fs.existsSync(destination)) {
    const existing = JSON.parse(fs.readFileSync(destination, 'utf-8')) as Partial<CodexHandoffRecord>;
    if (existing.id === record.id && existing.status === status) {
      if (fs.existsSync(queuedPath)) fs.unlinkSync(queuedPath);
      return;
    }
    throw new Error(`Terminal handoff record already exists with a different status: ${destination}`);
  }
  fs.writeFileSync(
    destination,
    `${JSON.stringify(
      {
        ...record,
        status,
        [`${status}At`]: sgtTimestamp(),
        ...extra,
      },
      null,
      2,
    )}\n`,
    { flag: 'wx' },
  );
  fs.unlinkSync(queuedPath);
}

function terminalRecordPath(root: string, record: CodexHandoffRecord): string | undefined {
  const dirs = handoffDirs(root);
  for (const dir of [dirs.completed, dirs.submitted]) {
    const candidate = path.join(dir, `${record.id}.json`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

async function processQueue(args: Args, configPath: string): Promise<void> {
  if (!fs.existsSync(configPath)) {
    writeTemplateConfig(configPath, args.projectsRoot);
    console.log(`Created bridge config template: ${configPath}`);
    console.log('Review the local project allowlist, then rerun with --execute for local Codex.');
    return;
  }

  const config = loadConfig(configPath);
  const queued = readQueuedHandoffs(args.root, args.limit);
  if (queued.length === 0) {
    console.log('No queued Distributed Cognition -> Codex handoffs.');
    return;
  }

  let processed = 0;
  let skipped = 0;
  let failed = 0;
  for (const item of queued) {
    try {
      const { record } = item;
      validateRecord(record);
      const terminalPath = terminalRecordPath(args.root, record);
      if (terminalPath) {
        if (fs.existsSync(item.filePath)) fs.unlinkSync(item.filePath);
        recordProgress(args.root, record, 'skipped', 'Terminal record already exists.');
        console.log(`Skipping already processed handoff ${record.id}; terminal record exists.`);
        skipped += 1;
        continue;
      }
      if (record.target === 'queue-only') {
        recordProgress(args.root, record, 'skipped', 'Queue-only handoff left for manual review.');
        console.log(`Skipping queue-only handoff ${record.id} for ${record.projectName}.`);
        skipped += 1;
        continue;
      }

      const projectConfig = resolveProjectConfig(config, record);
      if (!projectConfig || projectConfig.enabled === false) {
        recordProgress(args.root, record, 'blocked', 'Missing enabled project mapping.');
        console.log(`Missing enabled project mapping for ${record.projectName}; leaving ${record.id} queued.`);
        skipped += 1;
        continue;
      }

      const projectsRoot = path.resolve(config.projectsRoot || args.projectsRoot);
      const projectPath = safeJoin(projectsRoot, projectConfig.relativePath);
      if (record.target === 'codex-local') {
        if (projectConfig.localEnabled === false || config.localCodex?.enabled === false) {
          recordProgress(args.root, record, 'blocked', 'Local Codex not enabled for this mapping.');
          console.log(`Local Codex is not enabled for ${record.projectName}; leaving ${record.id} queued.`);
          skipped += 1;
          continue;
        }
        if (!args.execute) {
          recordProgress(args.root, record, 'dry_run', 'Dry-run only; local Codex not started.');
          console.log(`Dry-run: would execute ${record.id} (${record.projectName}) with local Codex.`);
          skipped += 1;
          continue;
        }
        recordProgress(args.root, record, 'running', 'Local Codex execution started on this Mac.');
        const result = await runLocalCodex(args.root, record, projectPath, config);
        if (!result.ok) {
          moveRecord(args.root, item.filePath, record, 'failed', {
            exitStatus: result.status,
            stdout: result.stdout,
            stderr: result.stderr,
            lastMessagePath: result.lastMessagePath,
          });
          updateNote(args.root, record, 'failed', [
            `- Failed at: ${sgtTimestamp()}`,
            `- Local Codex exit status: ${result.status ?? 'unknown'}`,
            result.lastMessagePath ? `- Last message: ${result.lastMessagePath}` : '- Last message: not written',
            '- See the failed JSON record under `.dc-index/codex-handoffs/failed/` for stdout/stderr.',
          ]);
          recordProgress(args.root, record, 'failed', 'Local Codex execution failed.');
          console.log(`Failed local Codex handoff ${record.id} for ${record.projectName}.`);
          failed += 1;
          continue;
        }

        moveRecord(args.root, item.filePath, record, 'completed', {
          target: 'codex-local',
          branch: record.branch || projectConfig.branch || config.defaultBranch || undefined,
          stdout: result.stdout,
          stderr: result.stderr,
          lastMessagePath: result.lastMessagePath,
          codexThreadId: result.threadId,
          codexTurnId: result.turnId,
        });
        updateNote(args.root, record, 'completed', [
          `- Completed at: ${sgtTimestamp()}`,
          '- Executor: local Codex on this Mac',
          result.threadId ? `- Codex thread: ${result.threadId}` : '- Codex thread: not reported',
          result.lastMessagePath ? `- Last message: ${result.lastMessagePath}` : '- Last message: not written',
        ]);
        recordProgress(args.root, record, 'completed', 'Local Codex execution completed.');
        console.log(`Completed local Codex handoff ${record.id} for ${record.projectName}.`);
        processed += 1;
        continue;
      }

      const cloudEnv = projectConfig.cloudEnv;
      if (!cloudEnv) {
        recordProgress(args.root, record, 'blocked', 'Missing Codex Cloud environment mapping.');
        console.log(`Missing cloudEnv for ${record.projectName} in ${configPath}; leaving ${record.id} queued.`);
        skipped += 1;
        continue;
      }
      if (record.cloudEnv && record.cloudEnv !== cloudEnv) {
        recordProgress(args.root, record, 'blocked', 'Requested Codex Cloud environment did not match host allowlist.');
        console.log(
          `Rejected ${record.id}: requested cloudEnv does not match host allowlist for ${record.projectName}.`,
        );
        skipped += 1;
        continue;
      }
      const branch = record.branch || projectConfig.branch || config.defaultBranch || undefined;
      if (!args.submit) {
        recordProgress(args.root, record, 'dry_run', 'Dry-run only; Codex Cloud not submitted.');
        console.log(`Dry-run: would submit ${record.id} (${record.projectName}) to Codex Cloud env ${cloudEnv}.`);
        skipped += 1;
        continue;
      }

      recordProgress(args.root, record, 'running', 'Codex Cloud submission started.');
      const result = submitToCodexCloud(record, projectPath, cloudEnv, branch);
      if (!result.ok) {
        moveRecord(args.root, item.filePath, record, 'failed', {
          exitStatus: result.status,
          stdout: result.stdout,
          stderr: result.stderr,
        });
        updateNote(args.root, record, 'failed', [
          `- Failed at: ${sgtTimestamp()}`,
          `- Exit status: ${result.status ?? 'unknown'}`,
          '- See the failed JSON record under `.dc-index/codex-handoffs/failed/` for stdout/stderr.',
        ]);
        recordProgress(args.root, record, 'failed', 'Codex Cloud submission failed.');
        console.log(`Failed to submit ${record.id} for ${record.projectName}.`);
        failed += 1;
        continue;
      }

      moveRecord(args.root, item.filePath, record, 'submitted', {
        cloudEnv,
        branch,
        cloudUrl: result.cloudUrl,
        cloudTaskId: result.cloudTaskId,
        stdout: result.stdout,
      });
      updateNote(args.root, record, 'submitted', [
        `- Submitted at: ${sgtTimestamp()}`,
        `- Codex task: ${result.cloudUrl}`,
        result.cloudTaskId ? `- Task id: ${result.cloudTaskId}` : '- Task id: not parsed',
      ]);
      recordProgress(args.root, record, 'submitted', 'Submitted to Codex Cloud.');
      console.log(`Submitted ${record.id} for ${record.projectName}: ${result.cloudUrl}`);
      processed += 1;
    } catch (e) {
      console.log(`Failed to process ${path.basename(item.filePath)}: ${e instanceof Error ? e.message : String(e)}`);
      failed += 1;
    }
  }

  console.log(`Done. processed=${processed} skipped=${skipped} failed=${failed}`);
  if (failed > 0) process.exitCode = 1;
}

const args = parseArgs(process.argv.slice(2));
const configPath = args.configPath ?? defaultConfigPath(args.root);
if (args.command === 'init') {
  if (fs.existsSync(configPath)) {
    console.log(`Bridge config already exists: ${configPath}`);
  } else {
    writeTemplateConfig(configPath, args.projectsRoot);
    console.log(`Created bridge config template: ${configPath}`);
  }
} else {
  processQueue(args, configPath).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
