import fs from 'fs';
import path from 'path';

import { scrubPrivateText } from './notes.js';
import { appendProvenanceEvent } from './provenance.js';

export type DistributedQueueKind = 'codex_handoff' | 'action_request';
export type DistributedQueueStatus =
  | 'queued'
  | 'running'
  | 'submitted'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'dry_run'
  | 'blocked';

export interface DistributedProgressEvent {
  version: 1;
  id: string;
  kind: DistributedQueueKind;
  status: DistributedQueueStatus;
  timestamp: string;
  title?: string;
  detail?: string;
  target?: string;
}

export interface DistributedQueueItem {
  id: string;
  kind: DistributedQueueKind;
  status: DistributedQueueStatus;
  title: string;
  createdAt?: string;
  target?: string;
  notePath?: string;
  lastProgress?: DistributedProgressEvent;
}

export interface DistributedQueueSummary {
  generatedAt: string;
  totals: Record<DistributedQueueStatus, number>;
  byKind: Record<DistributedQueueKind, Record<DistributedQueueStatus, number>>;
  recent: DistributedQueueItem[];
  progress: DistributedProgressEvent[];
}

const QUEUE_DIRS: Record<DistributedQueueKind, string> = {
  codex_handoff: 'codex-handoffs',
  action_request: 'action-requests',
};

const FOLDER_STATUS: Record<string, DistributedQueueStatus> = {
  queued: 'queued',
  running: 'running',
  submitted: 'submitted',
  completed: 'completed',
  failed: 'failed',
};

function parts(date = new Date()): Record<string, string> {
  return new Intl.DateTimeFormat('en-GB', {
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
}

export function sgtTimestamp(date = new Date()): string {
  const value = parts(date);
  return `${value.day}-${value.month}-${value.year}, ${value.hour}:${value.minute}`;
}

function indexDir(root: string): string {
  return path.join(root, '.dc-index');
}

function operationsLogPath(root: string): string {
  return path.join(indexDir(root), 'operations-log.jsonl');
}

function queueBase(root: string, kind: DistributedQueueKind): string {
  return path.join(indexDir(root), QUEUE_DIRS[kind]);
}

function emptyCounts(): Record<DistributedQueueStatus, number> {
  return {
    queued: 0,
    running: 0,
    submitted: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    dry_run: 0,
    blocked: 0,
  };
}

function safeTitle(record: Record<string, unknown>, fallback: string): string {
  const value =
    typeof record.projectName === 'string'
      ? `${record.projectName}: ${typeof record.task === 'string' ? record.task : 'Codex handoff'}`
      : typeof record.title === 'string'
        ? record.title
        : typeof record.brief === 'string'
          ? record.brief
          : fallback;
  return scrubPrivateText(value.replace(/\s+/g, ' ').trim()).slice(0, 180) || fallback;
}

function readJsonRecord(filePath: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function readProgressEvents(root: string, limit = 500): DistributedProgressEvent[] {
  const filePath = operationsLogPath(root);
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf-8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line): DistributedProgressEvent | undefined => {
      try {
        const parsed = JSON.parse(line) as DistributedProgressEvent;
        if (parsed.version !== 1 || !parsed.id || !parsed.kind || !parsed.status) return undefined;
        return {
          ...parsed,
          title: parsed.title ? scrubPrivateText(parsed.title) : undefined,
          detail: parsed.detail ? scrubPrivateText(parsed.detail) : undefined,
          target: parsed.target ? scrubPrivateText(parsed.target) : undefined,
        };
      } catch {
        return undefined;
      }
    })
    .filter((event): event is DistributedProgressEvent => Boolean(event))
    .slice(-limit);
}

function newestProgressById(events: DistributedProgressEvent[]): Map<string, DistributedProgressEvent> {
  const map = new Map<string, DistributedProgressEvent>();
  for (const event of events) map.set(`${event.kind}:${event.id}`, event);
  return map;
}

function readQueueItems(root: string, events: DistributedProgressEvent[]): DistributedQueueItem[] {
  const progress = newestProgressById(events);
  const items: DistributedQueueItem[] = [];
  for (const kind of Object.keys(QUEUE_DIRS) as DistributedQueueKind[]) {
    const base = queueBase(root, kind);
    for (const [folder, status] of Object.entries(FOLDER_STATUS)) {
      const dir = path.join(base, folder);
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.json'))) {
        const idFallback = path.basename(file, '.json');
        const record = readJsonRecord(path.join(dir, file));
        const id = typeof record?.id === 'string' ? record.id : idFallback;
        const lastProgress = progress.get(`${kind}:${id}`);
        const effectiveStatus = lastProgress?.status === 'running' && status === 'queued' ? 'running' : status;
        items.push({
          id: scrubPrivateText(id),
          kind,
          status: effectiveStatus,
          title: record ? safeTitle(record, idFallback) : 'Unreadable queue item',
          createdAt: typeof record?.createdAt === 'string' ? record.createdAt : undefined,
          target: typeof record?.target === 'string' ? scrubPrivateText(record.target) : undefined,
          notePath: typeof record?.notePath === 'string' ? scrubPrivateText(record.notePath) : undefined,
          lastProgress,
        });
      }
    }
  }
  return items.sort((a, b) => {
    const progressCompare = (b.lastProgress?.timestamp ?? '').localeCompare(a.lastProgress?.timestamp ?? '');
    if (progressCompare !== 0) return progressCompare;
    return (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || a.id.localeCompare(b.id);
  });
}

export function readUnifiedQueueStatus(root: string, options: { recentLimit?: number } = {}): DistributedQueueSummary {
  const events = readProgressEvents(root);
  const items = readQueueItems(root, events);
  const totals = emptyCounts();
  const byKind: DistributedQueueSummary['byKind'] = {
    codex_handoff: emptyCounts(),
    action_request: emptyCounts(),
  };
  for (const item of items) {
    totals[item.status] += 1;
    byKind[item.kind][item.status] += 1;
  }
  return {
    generatedAt: sgtTimestamp(),
    totals,
    byKind,
    recent: items.slice(0, options.recentLimit ?? 8),
    progress: events.slice(-12).reverse(),
  };
}

export function appendProgressEvent(
  root: string,
  event: Omit<DistributedProgressEvent, 'version' | 'timestamp'> & { timestamp?: string },
): DistributedProgressEvent {
  const entry: DistributedProgressEvent = {
    version: 1,
    timestamp: event.timestamp ?? sgtTimestamp(),
    id: scrubPrivateText(event.id),
    kind: event.kind,
    status: event.status,
    title: event.title ? scrubPrivateText(event.title) : undefined,
    detail: event.detail ? scrubPrivateText(event.detail) : undefined,
    target: event.target ? scrubPrivateText(event.target) : undefined,
  };
  fs.mkdirSync(indexDir(root), { recursive: true });
  fs.appendFileSync(operationsLogPath(root), `${JSON.stringify(entry)}\n`);
  appendProvenanceEvent(root, {
    id: `${entry.kind}-${entry.id}-${entry.status}`,
    timestamp: entry.timestamp,
    kind: entry.status === 'queued' ? 'queue_created' : 'queue_progress',
    title: `${kindLabel(entry.kind)} ${entry.status}`,
    summary: entry.detail,
    sourcePaths: [],
    outputPaths: ['.dc-index/operations-log.jsonl'],
    metadata: {
      queueId: entry.id,
      queueKind: entry.kind,
      status: entry.status,
      target: entry.target,
    },
  });
  return entry;
}

function countLine(label: string, counts: Record<DistributedQueueStatus, number>): string {
  return `- ${label}: queued ${counts.queued}, running ${counts.running}, submitted ${counts.submitted}, completed ${counts.completed}, failed ${counts.failed}`;
}

function kindLabel(kind: DistributedQueueKind): string {
  return kind === 'codex_handoff' ? 'Codex handoff' : 'Action request';
}

export function renderUnifiedQueueStatusMarkdown(summary: DistributedQueueSummary): string {
  return [
    `# Distributed Cognition Work Queue - ${summary.generatedAt}`,
    '',
    '## Summary',
    countLine('All work', summary.totals),
    countLine('Codex handoffs', summary.byKind.codex_handoff),
    countLine('Action requests', summary.byKind.action_request),
    '',
    '## Recent Items',
    summary.recent.length > 0
      ? summary.recent
          .map(
            (item) =>
              `- ${item.status}: ${kindLabel(item.kind)} ${item.id} - ${item.title}${item.target ? ` (target ${item.target})` : ''}`,
          )
          .join('\n')
      : 'No queued or recently processed work items found.',
    '',
    '## Recent Progress Events',
    summary.progress.length > 0
      ? summary.progress
          .map(
            (event) =>
              `- ${event.timestamp}: ${event.status} ${kindLabel(event.kind)} ${event.id}${event.detail ? ` - ${event.detail}` : ''}`,
          )
          .join('\n')
      : 'No progress events recorded yet.',
    '',
  ].join('\n');
}

export function writeUnifiedQueueStatus(root: string): {
  markdownPath: string;
  jsonPath: string;
  summary: DistributedQueueSummary;
} {
  const summary = readUnifiedQueueStatus(root);
  const index = indexDir(root);
  const wikiDir = path.join(root, 'project-wikis');
  fs.mkdirSync(index, { recursive: true });
  fs.mkdirSync(wikiDir, { recursive: true });
  const jsonPath = path.join(index, 'work-queue-status.json');
  const markdownPath = path.join(wikiDir, 'work-queue.md');
  fs.writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`);
  fs.writeFileSync(markdownPath, renderUnifiedQueueStatusMarkdown(summary));
  return { markdownPath, jsonPath, summary };
}

export function queueStatusReply(summary: DistributedQueueSummary): string {
  const active = summary.totals.queued + summary.totals.running + summary.totals.submitted;
  const failed = summary.totals.failed;
  const recent = summary.recent[0];
  const parts = [
    `Queue has ${active} active item${active === 1 ? '' : 's'} and ${failed} failed item${failed === 1 ? '' : 's'}.`,
  ];
  if (recent) parts.push(`Most recent: ${recent.status} ${kindLabel(recent.kind)} ${recent.id}.`);
  return parts.join(' ');
}
