import fs from 'fs';
import os from 'os';
import path from 'path';

import { readUnifiedQueueStatus, writeUnifiedQueueStatus } from '../src/distributed-cognition/queue-status.js';
import { obsidianTemplates } from '../src/distributed-cognition/wiki-templates.js';

const DEFAULT_ROOT_CANDIDATES = [
  path.join(os.homedir(), 'Library/CloudStorage/Dropbox/Distributed-Cognition'),
  path.join(os.homedir(), 'Dropbox/Distributed-Cognition'),
];

type Args = {
  root?: string;
};

type QueueSummary = {
  queued?: number;
  submitted?: number;
  completed?: number;
  failed?: number;
};

type CodexStatus = {
  generatedAt?: string;
  projects?: unknown[];
  skipped?: unknown[];
  handoffSummary?: QueueSummary;
  actionSummary?: QueueSummary;
};

type ContextManifest = {
  entries?: number | unknown[];
  skipped?: unknown[];
  generatedAt?: string;
};

type HealthReport = {
  checkedAt?: string;
  overall?: string;
  items?: Array<{ status?: string }>;
};

function usage(): never {
  console.error(
    [
      'Usage: pnpm run dc:dashboard -- [options]',
      '',
      'Options:',
      '  --root <path>   Distributed Cognition second-brain root.',
      '',
      'You can also set DC_SECOND_BRAIN_ROOT.',
    ].join('\n'),
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--root') {
      const value = argv[++i];
      if (!value) usage();
      args.root = path.resolve(value);
    } else {
      usage();
    }
  }
  return args;
}

function resolveRoot(explicitRoot: string | undefined): string {
  if (explicitRoot) return path.resolve(explicitRoot);
  if (process.env.DC_SECOND_BRAIN_ROOT) return path.resolve(process.env.DC_SECOND_BRAIN_ROOT);
  const existingCandidate = DEFAULT_ROOT_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  if (existingCandidate) return existingCandidate;
  throw new Error('Second-brain root not configured. Pass --root <path> or set DC_SECOND_BRAIN_ROOT.');
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

function readJson<T>(filePath: string): T | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function countFiles(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((name) => fs.statSync(path.join(dir, name)).isFile()).length;
}

function newestFiles(root: string, relativeDir: string, limit = 5): string[] {
  const dir = path.join(root, relativeDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((name) => ({ name, stat: fs.statSync(path.join(dir, name)) }))
    .filter((entry) => entry.stat.isFile() && entry.name.endsWith('.md'))
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    .slice(0, limit)
    .map((entry) => `${relativeDir}/${entry.name}`);
}

function queueCounts(root: string, queueName: 'codex-handoffs' | 'action-requests'): Required<QueueSummary> {
  const base = path.join(root, '.dc-index', queueName);
  return {
    queued: countFiles(path.join(base, 'queued')),
    submitted: countFiles(path.join(base, 'submitted')),
    completed: countFiles(path.join(base, 'completed')),
    failed: countFiles(path.join(base, 'failed')),
  };
}

function renderQueue(label: string, counts: QueueSummary | undefined, fallback: Required<QueueSummary>): string[] {
  const q = counts?.queued ?? fallback.queued;
  const submitted = counts?.submitted ?? fallback.submitted;
  const completed = counts?.completed ?? fallback.completed;
  const failed = counts?.failed ?? fallback.failed;
  return [`- ${label}: queued ${q}, submitted ${submitted}, completed ${completed}, failed ${failed}`];
}

function ensureTemplates(root: string): void {
  const dir = path.join(root, '_templates');
  ensureDir(dir);
  const templates = obsidianTemplates();
  for (const [name, content] of Object.entries(templates)) {
    const target = path.join(dir, name);
    if (!fs.existsSync(target)) fs.writeFileSync(target, content);
  }
}

function renderDashboard(root: string): string {
  const now = sgtTimestamp();
  const health = readJson<HealthReport>(path.join(root, '.dc-index', 'system-health.json'));
  const codex = readJson<CodexStatus>(path.join(root, '.dc-index', 'codex-status.json'));
  const manifest = readJson<ContextManifest>(path.join(root, '.dc-index', 'context-index-manifest.json'));
  const indexedCount = Array.isArray(manifest?.entries) ? manifest.entries.length : (manifest?.entries ?? 0);
  const handoffs = queueCounts(root, 'codex-handoffs');
  const actions = queueCounts(root, 'action-requests');
  const unifiedQueue = readUnifiedQueueStatus(root, { recentLimit: 6 });
  const healthItems = health?.items ?? [];
  const healthWarnings = healthItems.filter((item) => item.status === 'warning').length;
  const healthErrors = healthItems.filter((item) => item.status === 'error').length;
  const recent = [
    ...newestFiles(root, 'inbox-whatsapp', 3),
    ...newestFiles(root, 'pending-review', 5),
    ...newestFiles(root, 'daily-reflections', 3),
  ];

  return [
    '---',
    'type: dashboard',
    'system: distributed-cognition',
    `generated: "${now}"`,
    'tags:',
    '  - distributed-cognition/dashboard',
    '---',
    '',
    `# Distributed Cognition Dashboard - ${now}`,
    '',
    '## Runtime',
    `- Health: ${health?.overall ?? 'unknown'} (${healthErrors} error, ${healthWarnings} warning)`,
    `- Last health check: ${health?.checkedAt ?? 'not run'}`,
    `- Context index: ${indexedCount} indexed, ${manifest?.skipped?.length ?? 0} skipped`,
    `- Context generated: ${manifest?.generatedAt ?? 'not run'}`,
    `- Codex projects visible: ${codex?.projects?.length ?? 0}`,
    `- Codex status generated: ${codex?.generatedAt ?? 'not run'}`,
    '',
    '## Queues',
    ...renderQueue('Codex handoffs', codex?.handoffSummary, handoffs),
    ...renderQueue('Action requests', codex?.actionSummary, actions),
    `- Unified active work: ${unifiedQueue.totals.queued + unifiedQueue.totals.running + unifiedQueue.totals.submitted}`,
    unifiedQueue.recent.length > 0
      ? `- Most recent work item: ${unifiedQueue.recent[0].status} ${unifiedQueue.recent[0].id}`
      : '- Most recent work item: none',
    '',
    '## Working Areas',
    '- [[project-wikis/codex-workbench|Codex Workbench]]',
    '- [[project-wikis/work-queue|Work Queue]]',
    '- [[project-wikis/mnemon-memory-report|Mnemon Memory Report]]',
    '- [[project-wikis/system-health|System Health]]',
    '- [[project-wikis/retrieval-eval-report|Retrieval Eval Report]]',
    '- [[open-questions/deadline-watch|Deadline Watch]]',
    '',
    '## Recent Captures And Reviews',
    ...(recent.length > 0 ? recent.map((file) => `- [[${file}]]`) : ['- No recent Markdown captures found.']),
    '',
    '## Operating Notes',
    '- Raw capture stays in inbox folders.',
    '- Durable keys, pivots, decisions, recurring themes, and open questions may be promoted.',
    '- Low-signal meeting clutter stays in Markdown and should not enter Mnemon.',
    '- Codex and action bridges execute only queued, allowlisted local work.',
    '',
  ].join('\n');
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const root = resolveRoot(args.root);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Second-brain root does not exist: ${root}`);
  }
  ensureTemplates(root);
  const wikiDir = path.join(root, 'project-wikis');
  ensureDir(wikiDir);
  writeUnifiedQueueStatus(root);
  const dashboardPath = path.join(wikiDir, 'distributed-cognition-dashboard.md');
  fs.writeFileSync(dashboardPath, renderDashboard(root));
  console.log(`Wrote ${dashboardPath}`);
}

main();
