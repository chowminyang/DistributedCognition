import fs from 'fs';
import os from 'os';
import path from 'path';

import { writeAttentionCalibrationReport } from '../src/distributed-cognition/attention-report.js';
import { writeCaptureLedger } from '../src/distributed-cognition/capture-ledger.js';
import { formatDeliveryTimestamp, writeDeliveryLedger } from '../src/distributed-cognition/delivery-ledger.js';
import { writeMemoryHygieneReport } from '../src/distributed-cognition/memory-hygiene.js';
import { writeMnemonMemoryReport } from '../src/distributed-cognition/memory-report.js';
import { writeProjectOntology } from '../src/distributed-cognition/ontology.js';
import { appendProvenanceEvent, writeProvenanceMarkdown } from '../src/distributed-cognition/provenance.js';
import { readUnifiedQueueStatus, writeUnifiedQueueStatus } from '../src/distributed-cognition/queue-status.js';
import { obsidianTemplates } from '../src/distributed-cognition/wiki-templates.js';

const DEFAULT_ROOT_CANDIDATES = [
  path.join(os.homedir(), 'Library/CloudStorage/Dropbox/Distributed-Cognition'),
  path.join(os.homedir(), 'Dropbox/Distributed-Cognition'),
];
const DEFAULT_MNEMON_DB = path.join(process.cwd(), 'groups/dm-with-minyangchow/.mnemon/memory.db');

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

type CaptureLedger = {
  generatedAt?: string;
  totals?: {
    complete?: number;
    needs_processing?: number;
    needs_review?: number;
    memory_promoted?: number;
  };
  coverage?: {
    status?: string;
    sessionsScanned?: number;
    whatsappInboundRows?: number;
    whatsappInboundCompleted?: number;
    whatsappInboundOpen?: number;
    hostIngressReceipts?: number;
    sourceLinkedRawCaptures?: number;
    possibleUnlinkedWhatsAppInbound?: number;
  };
  entries?: Array<{
    capturedAt?: string;
    messageType?: string;
    status?: string;
    rawPath?: string;
    processedPath?: string;
  }>;
};

type DeliveryLedger = {
  generatedAt?: string;
  sessionsScanned?: number;
  latestWhatsAppReply?: {
    timestamp?: string;
    deliveredAt?: string;
    status?: string;
    channelType?: string | null;
  };
  inboundTotals?: {
    accepted?: number;
    processing?: number;
    completed?: number;
    failed?: number;
    skipped?: number;
  };
  outboundTotals?: {
    delivered?: number;
    failed?: number;
    due_undelivered?: number;
    scheduled?: number;
    internal?: number;
  };
};

type MemoryReport = {
  generatedAt?: string;
  total?: number;
  byImportanceBand?: Record<string, number>;
  graph?: {
    nodes?: unknown[];
    edges?: unknown[];
  };
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
  const captureLedger = readJson<CaptureLedger>(path.join(root, '.dc-index', 'capture-ledger.json'));
  const deliveryLedger = readJson<DeliveryLedger>(path.join(root, '.dc-index', 'delivery-ledger.json'));
  const memoryReport = readJson<MemoryReport>(path.join(root, '.dc-index', 'mnemon-memory-report.json'));
  const codex = readJson<CodexStatus>(path.join(root, '.dc-index', 'codex-status.json'));
  const manifest = readJson<ContextManifest>(path.join(root, '.dc-index', 'context-index-manifest.json'));
  const indexedCount = Array.isArray(manifest?.entries) ? manifest.entries.length : (manifest?.entries ?? 0);
  const handoffs = queueCounts(root, 'codex-handoffs');
  const actions = queueCounts(root, 'action-requests');
  const unifiedQueue = readUnifiedQueueStatus(root, { recentLimit: 6 });
  const healthItems = health?.items ?? [];
  const healthWarnings = healthItems.filter((item) => item.status === 'warning').length;
  const healthErrors = healthItems.filter((item) => item.status === 'error').length;
  const latestCapture = captureLedger?.entries?.[0];
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
    `- Capture ledger: ${captureLedger?.generatedAt ?? 'not run'}`,
    `- Capture status: complete ${captureLedger?.totals?.complete ?? 0}, needs processing ${captureLedger?.totals?.needs_processing ?? 0}, needs review ${captureLedger?.totals?.needs_review ?? 0}, promoted ${captureLedger?.totals?.memory_promoted ?? 0}`,
    `- Capture coverage: ${captureLedger?.coverage?.status ?? 'unknown'}; WhatsApp inbound ${captureLedger?.coverage?.whatsappInboundRows ?? 0}, completed ${captureLedger?.coverage?.whatsappInboundCompleted ?? 0}, open ${captureLedger?.coverage?.whatsappInboundOpen ?? 0}, host receipts ${captureLedger?.coverage?.hostIngressReceipts ?? 0}, source-linked raw ${captureLedger?.coverage?.sourceLinkedRawCaptures ?? 0}, possible unlinked ${captureLedger?.coverage?.possibleUnlinkedWhatsAppInbound ?? 0}`,
    `- Delivery ledger: ${deliveryLedger?.generatedAt ?? 'not run'} (${deliveryLedger?.sessionsScanned ?? 0} session DB pair${deliveryLedger?.sessionsScanned === 1 ? '' : 's'})`,
    `- Delivery status: inbound completed ${deliveryLedger?.inboundTotals?.completed ?? 0}, processing ${deliveryLedger?.inboundTotals?.processing ?? 0}; outbound delivered ${deliveryLedger?.outboundTotals?.delivered ?? 0}, due undelivered ${deliveryLedger?.outboundTotals?.due_undelivered ?? 0}, failed ${deliveryLedger?.outboundTotals?.failed ?? 0}`,
    `- Last WhatsApp reply: ${formatDeliveryTimestamp(deliveryLedger?.latestWhatsAppReply?.deliveredAt ?? deliveryLedger?.latestWhatsAppReply?.timestamp) ?? 'none recorded'}`,
    `- Mnemon memories: ${memoryReport?.total ?? 0} (${memoryReport?.byImportanceBand?.key_or_pivot ?? 0} key/pivot, ${memoryReport?.byImportanceBand?.useful_context ?? 0} useful context, ${memoryReport?.byImportanceBand?.background ?? 0} background, ${memoryReport?.byImportanceBand?.low_signal ?? 0} low signal)`,
    `- Mnemon graph: ${memoryReport?.graph?.nodes?.length ?? 0} nodes, ${memoryReport?.graph?.edges?.length ?? 0} edges`,
    latestCapture
      ? `- Latest capture: ${latestCapture.capturedAt ?? 'unknown time'} ${latestCapture.messageType ?? 'unknown'} (${latestCapture.status ?? 'unknown'})`
      : '- Latest capture: none recorded',
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
    '- [[project-wikis/mnemon-memory-graph.canvas|Mnemon Memory Graph Canvas]]',
    '- [[project-wikis/system-health|System Health]]',
    '- [[project-wikis/delivery-ledger|Delivery Ledger]]',
    '- [[project-wikis/retrieval-eval-report|Retrieval Eval Report]]',
    '- [[project-wikis/provenance-ledger|Provenance Ledger]]',
    '- [[project-wikis/capture-ledger|Capture Ledger]]',
    '- [[project-wikis/attention-calibration|Attention Calibration]]',
    '- [[project-wikis/memory-hygiene|Memory Hygiene]]',
    '- [[project-wikis/project-ontology|Project Ontology]]',
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
  writeProvenanceMarkdown(root);
  writeCaptureLedger(root);
  writeDeliveryLedger(root);
  writeAttentionCalibrationReport(root);
  writeMemoryHygieneReport(root);
  writeMnemonMemoryReport(root, {
    mnemonDb: process.env.DC_MNEMON_DB || process.env.MNEMON_DB_PATH || DEFAULT_MNEMON_DB,
  });
  writeProjectOntology(root);
  const dashboardPath = path.join(wikiDir, 'distributed-cognition-dashboard.md');
  fs.writeFileSync(dashboardPath, renderDashboard(root));
  appendProvenanceEvent(root, {
    id: `dashboard-${Date.now()}`,
    kind: 'dashboard',
    title: 'Dashboard refreshed',
    summary: 'Refreshed dashboard, queue status, provenance, attention, memory hygiene, and ontology pages.',
    sourcePaths: [],
    outputPaths: [
      'project-wikis/distributed-cognition-dashboard.md',
      'project-wikis/work-queue.md',
      'project-wikis/provenance-ledger.md',
      'project-wikis/delivery-ledger.md',
      'project-wikis/mnemon-memory-report.md',
      'project-wikis/mnemon-memory-graph.canvas',
      'project-wikis/attention-calibration.md',
      'project-wikis/memory-hygiene.md',
      'project-wikis/project-ontology.md',
    ],
    metadata: {},
  });
  console.log(`Wrote ${dashboardPath}`);
}

main();
