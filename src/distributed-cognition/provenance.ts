import fs from 'fs';
import path from 'path';

export type ProvenanceEventKind =
  | 'capture'
  | 'classification'
  | 'attention_score'
  | 'coaching_prompt'
  | 'memory_promotion'
  | 'memory_hygiene'
  | 'memory_graph'
  | 'project_ontology'
  | 'project_status'
  | 'wiki_update'
  | 'queue_created'
  | 'queue_progress'
  | 'bridge_execution'
  | 'delivery_event'
  | 'dashboard'
  | 'context_index';

export interface ProvenanceEvent {
  version: 1;
  id: string;
  timestamp: string;
  kind: ProvenanceEventKind;
  title: string;
  summary?: string;
  sourcePaths: string[];
  outputPaths: string[];
  metadata: Record<string, string | number | boolean | string[] | undefined>;
}

export interface ProvenanceSummary {
  generatedAt: string;
  total: number;
  byKind: Record<string, number>;
  recent: ProvenanceEvent[];
}

function scrubPrivateText(input: string): string {
  return input
    .replace(/\b\d{8,15}@s\.whatsapp\.net\b/gi, '[REDACTED_WHATSAPP_JID]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
    .replace(/\b(?:sk|sk-proj)-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_API_KEY]')
    .replace(/\b(?:OPENAI_API_KEY|API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|PASSWORD)\s*=\s*['"]?[^'"\s]+/gi, (match) => {
      const key = match.split('=')[0]?.trim() || 'SECRET';
      return `${key}=[REDACTED_SECRET]`;
    })
    .replace(/\+\d{1,3}(?:[\s-]?\d){6,14}\b/g, '[REDACTED_PHONE]')
    .replace(/\/Users\/[^/\s)]+/g, '/Users/<username>');
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

function requireRoot(root: string): string {
  const real = fs.realpathSync(root);
  if (!fs.statSync(real).isDirectory()) throw new Error(`Second-brain root is not a directory: ${root}`);
  return real;
}

function assertInsideRoot(root: string, target: string): void {
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Refusing to write outside second-brain root: ${target}`);
  }
}

function indexDir(root: string): string {
  const real = requireRoot(root);
  const dir = path.resolve(real, '.dc-index');
  assertInsideRoot(real, dir);
  return dir;
}

export function provenanceLogPath(root: string): string {
  return path.join(indexDir(root), 'events.jsonl');
}

function normalizePathList(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => scrubPrivateText(value.replace(/\\/g, '/'))).filter(Boolean);
}

function normalizeMetadata(
  metadata: Record<string, string | number | boolean | string[] | undefined> | undefined,
): ProvenanceEvent['metadata'] {
  const cleaned: ProvenanceEvent['metadata'] = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (Array.isArray(value)) cleaned[key] = value.map((item) => scrubPrivateText(item));
    else if (typeof value === 'string') cleaned[key] = scrubPrivateText(value);
    else cleaned[key] = value;
  }
  return cleaned;
}

export function appendProvenanceEvent(
  root: string,
  event: Omit<ProvenanceEvent, 'version' | 'timestamp'> & { timestamp?: string },
): ProvenanceEvent {
  const entry: ProvenanceEvent = {
    version: 1,
    timestamp: event.timestamp ?? sgtTimestamp(),
    id: scrubPrivateText(event.id),
    kind: event.kind,
    title: scrubPrivateText(event.title),
    summary: event.summary ? scrubPrivateText(event.summary) : undefined,
    sourcePaths: normalizePathList(event.sourcePaths),
    outputPaths: normalizePathList(event.outputPaths),
    metadata: normalizeMetadata(event.metadata),
  };
  const filePath = provenanceLogPath(root);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`);
  return entry;
}

export function readProvenanceEvents(root: string, options: { limit?: number } = {}): ProvenanceEvent[] {
  const filePath = provenanceLogPath(root);
  if (!fs.existsSync(filePath)) return [];
  const limit = Math.max(1, Math.min(1_000, options.limit ?? 200));
  return fs
    .readFileSync(filePath, 'utf-8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line): ProvenanceEvent | undefined => {
      try {
        const parsed = JSON.parse(line) as ProvenanceEvent;
        if (parsed.version !== 1 || !parsed.id || !parsed.kind || !parsed.timestamp) return undefined;
        return parsed;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        return undefined;
      }
    })
    .filter((event): event is ProvenanceEvent => Boolean(event))
    .slice(-limit);
}

export function summarizeProvenance(root: string, options: { limit?: number } = {}): ProvenanceSummary {
  const events = readProvenanceEvents(root, options);
  const byKind: Record<string, number> = {};
  for (const event of events) byKind[event.kind] = (byKind[event.kind] ?? 0) + 1;
  return {
    generatedAt: sgtTimestamp(),
    total: events.length,
    byKind,
    recent: events.slice(-12).reverse(),
  };
}

function countLines(counts: Record<string, number>): string[] {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return entries.length > 0 ? entries.map(([kind, count]) => `- ${kind}: ${count}`) : ['- None recorded'];
}

export function renderProvenanceMarkdown(summary: ProvenanceSummary): string {
  return [
    '---',
    'type: provenance_ledger',
    'system: distributed-cognition',
    `generated: "${summary.generatedAt}"`,
    'tags:',
    '  - distributed-cognition/provenance',
    '---',
    '',
    `# Provenance Ledger - ${summary.generatedAt}`,
    '',
    '## What This Tracks',
    'Every capture, classification, attention score, memory promotion, wiki update, queue item, and bridge progress event should leave a small auditable breadcrumb here.',
    '',
    '## Counts',
    `- Events in report window: ${summary.total}`,
    ...countLines(summary.byKind),
    '',
    '## Recent Events',
    summary.recent.length > 0
      ? summary.recent
          .map((event) =>
            [
              `### ${event.timestamp} - ${event.kind} - ${event.title}`,
              event.summary ? event.summary : undefined,
              event.sourcePaths.length > 0 ? `- Sources: ${event.sourcePaths.join('; ')}` : undefined,
              event.outputPaths.length > 0 ? `- Outputs: ${event.outputPaths.join('; ')}` : undefined,
            ]
              .filter((line): line is string => typeof line === 'string')
              .join('\n'),
          )
          .join('\n\n')
      : 'No provenance events recorded yet.',
    '',
  ].join('\n');
}

export function writeProvenanceMarkdown(root: string): string {
  const real = requireRoot(root);
  const wikiDir = path.join(real, 'project-wikis');
  fs.mkdirSync(wikiDir, { recursive: true });
  const target = path.join(wikiDir, 'provenance-ledger.md');
  fs.writeFileSync(target, renderProvenanceMarkdown(summarizeProvenance(real)));
  return target;
}
