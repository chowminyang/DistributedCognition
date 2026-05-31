import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { scrubPrivateText } from './notes.js';
import { readProvenanceEvents, type ProvenanceEvent } from './provenance.js';

export type CaptureLedgerStatus = 'complete' | 'needs_processing' | 'needs_review' | 'memory_promoted';
export type CaptureCoverageStatus = 'ok' | 'possible_gap' | 'unavailable';

export interface CaptureLedgerEntry {
  id: string;
  capturedAt: string;
  messageType: string;
  status: CaptureLedgerStatus;
  rawPath?: string;
  processedPath?: string;
  deadlineWatchPath?: string;
  importance?: string;
  durability?: string;
  actionability?: string;
  timeSensitivity?: string;
  projectSignals: string[];
  classified: boolean;
  coached: boolean;
  memoryPromotions: Array<{ id: string; title: string; auditPath?: string }>;
}

export interface CaptureCoverageGap {
  id: string;
  timestamp: string;
  status: string;
  sessionId: string;
  agentGroupId: string;
}

export interface CaptureCoverage {
  status: CaptureCoverageStatus;
  dataDir: string;
  sessionsScanned: number;
  whatsappInboundRows: number;
  whatsappInboundCompleted: number;
  whatsappInboundOpen: number;
  rawMarkdownFiles: number;
  captureProvenanceEvents: number;
  hostIngressReceipts: number;
  sourceLinkedRawCaptures: number;
  possibleUnlinkedWhatsAppInbound: number;
  latestWhatsAppInbound?: string;
  latestCapture?: string;
  recentUnlinkedWhatsAppInbound: CaptureCoverageGap[];
}

export interface CaptureLedger {
  version: 1;
  generatedAt: string;
  totals: Record<CaptureLedgerStatus, number>;
  coverage: CaptureCoverage;
  entries: CaptureLedgerEntry[];
}

export interface WrittenCaptureLedger {
  jsonPath: string;
  markdownPath: string;
}

interface CaptureLedgerOptions {
  limit?: number;
  now?: Date;
  dataDir?: string;
  cwd?: string;
}

interface InboundRow {
  id: string;
  timestamp: string;
  status: string | null;
  channel_type: string | null;
}

interface ProcessingAckRow {
  message_id: string;
  status: string;
  status_changed: string;
}

interface SessionInboundEntry {
  id: string;
  timestamp: string;
  status: string;
  sessionId: string;
  agentGroupId: string;
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

function tableExists(db: Database.Database, name: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name) as
    | { name: string }
    | undefined;
  return Boolean(row);
}

function safeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? scrubPrivateText(value.trim()) : undefined;
}

function safeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => scrubPrivateText(item.trim()));
}

function normalizedPath(value: string): string {
  return scrubPrivateText(value.replace(/\\/g, '/').replace(/^\.?\//, ''));
}

function pathStem(value: string): string {
  return path.basename(value, path.extname(value));
}

function sourceMatchesCapture(sourcePath: string, entry: CaptureLedgerEntry): boolean {
  const source = normalizedPath(sourcePath);
  const sourceStem = pathStem(source);
  return [entry.rawPath, entry.processedPath]
    .filter((value): value is string => Boolean(value))
    .some((candidate) => {
      const normalized = normalizedPath(candidate);
      return normalized === source || pathStem(normalized) === sourceStem;
    });
}

function outputByFolder(outputs: string[], folder: string): string | undefined {
  return outputs.find((output) => normalizedPath(output).startsWith(`${folder}/`));
}

function statusForEntry(entry: CaptureLedgerEntry): CaptureLedgerStatus {
  if (entry.memoryPromotions.length > 0) return 'memory_promoted';
  if (!entry.rawPath || !entry.processedPath || !entry.classified) return 'needs_processing';
  if (entry.durability === 'durable' || entry.importance === 'high' || entry.actionability === 'clear_action') {
    return 'needs_review';
  }
  return 'complete';
}

function timestampRank(value: string): number {
  const match = value.match(/^(\d{2})-(\d{2})-(\d{2}),\s*(\d{2}):(\d{2})$/);
  if (!match) return 0;
  const [, day, month, year, hour, minute] = match;
  return Number(`${year}${month}${day}${hour}${minute}`);
}

function absoluteTimestampRank(value: string | undefined): number {
  if (!value) return 0;
  const distributed = value.match(/^(\d{2})-(\d{2})-(\d{2}),\s*(\d{2}):(\d{2})$/);
  if (distributed) {
    const [, day, month, year, hour, minute] = distributed;
    return Date.parse(`20${year}-${month}-${day}T${hour}:${minute}:00+08:00`);
  }
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const zoned = /[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}Z`;
  const parsed = Date.parse(zoned);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function formatSessionTimestamp(value: string): string {
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const zoned = /[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}Z`;
  const parsed = new Date(zoned);
  return Number.isNaN(parsed.getTime()) ? scrubPrivateText(value) : sgtTimestamp(parsed);
}

function compareTimestampDesc(a: string, b: string): number {
  return timestampRank(b) - timestampRank(a) || b.localeCompare(a);
}

function compareAbsoluteTimestampDesc(a: string, b: string): number {
  return absoluteTimestampRank(b) - absoluteTimestampRank(a) || b.localeCompare(a);
}

function emptyTotals(): CaptureLedger['totals'] {
  return {
    complete: 0,
    needs_processing: 0,
    needs_review: 0,
    memory_promoted: 0,
  };
}

function captureEntryFromEvent(event: ProvenanceEvent): CaptureLedgerEntry {
  const outputs = event.outputPaths.map(normalizedPath);
  const rawPath = outputByFolder(outputs, 'inbox-whatsapp');
  const processedPath =
    outputs.find(
      (output) =>
        !output.startsWith('inbox-whatsapp/') &&
        output.endsWith('.md') &&
        !output.startsWith('open-questions/deadline-watch'),
    ) ?? undefined;
  const inferredType = safeString(event.metadata.messageType) ?? event.title.replace(/^Captured\s+/i, '').trim();
  const messageType = inferredType || 'unknown';
  return {
    id: scrubPrivateText(event.id),
    capturedAt: event.timestamp,
    messageType,
    status: 'needs_processing',
    rawPath,
    processedPath,
    deadlineWatchPath: outputByFolder(outputs, 'open-questions'),
    importance: safeString(event.metadata.importance),
    durability: safeString(event.metadata.durability),
    actionability: safeString(event.metadata.actionability),
    timeSensitivity: safeString(event.metadata.timeSensitivity),
    projectSignals: safeStringArray(event.metadata.projectSignals),
    classified: false,
    coached: false,
    memoryPromotions: [],
  };
}

function sessionDirs(dataDir: string): Array<{ agentGroupId: string; sessionId: string; dir: string }> {
  const root = path.join(dataDir, 'v2-sessions');
  if (!fs.existsSync(root)) return [];
  const dirs: Array<{ agentGroupId: string; sessionId: string; dir: string }> = [];
  for (const agentGroupId of fs.readdirSync(root)) {
    const groupDir = path.join(root, agentGroupId);
    if (!fs.statSync(groupDir).isDirectory()) continue;
    for (const sessionId of fs.readdirSync(groupDir)) {
      const dir = path.join(groupDir, sessionId);
      if (fs.statSync(dir).isDirectory()) dirs.push({ agentGroupId, sessionId, dir });
    }
  }
  return dirs;
}

function classifyInboundStatus(row: InboundRow, ack?: ProcessingAckRow): string {
  if (ack?.status === 'processing') return 'processing';
  if (ack?.status === 'completed') return 'completed';
  if (ack?.status === 'failed') return 'failed';
  if (row.status === 'failed') return 'failed';
  if (row.status === 'completed') return 'completed';
  if (row.status === 'skipped') return 'skipped';
  return 'accepted';
}

function collectSessionInbound(entry: {
  agentGroupId: string;
  sessionId: string;
  dir: string;
}): SessionInboundEntry[] | undefined {
  const inboundPath = path.join(entry.dir, 'inbound.db');
  if (!fs.existsSync(inboundPath)) return undefined;

  let ackByMessage = new Map<string, ProcessingAckRow>();
  const outboundPath = path.join(entry.dir, 'outbound.db');
  if (fs.existsSync(outboundPath)) {
    const outDb = new Database(outboundPath, { readonly: true, fileMustExist: true });
    try {
      if (tableExists(outDb, 'processing_ack')) {
        const ackRows = outDb
          .prepare('SELECT message_id, status, status_changed FROM processing_ack')
          .all() as ProcessingAckRow[];
        ackByMessage = new Map(ackRows.map((row) => [row.message_id, row]));
      }
    } finally {
      outDb.close();
    }
  }

  const inDb = new Database(inboundPath, { readonly: true, fileMustExist: true });
  try {
    if (!tableExists(inDb, 'messages_in')) return undefined;
    const inboundRows = inDb
      .prepare('SELECT id, timestamp, status, channel_type FROM messages_in WHERE channel_type = ?')
      .all('whatsapp') as InboundRow[];
    return inboundRows.map((row) => ({
      id: scrubPrivateText(row.id),
      timestamp: row.timestamp,
      status: classifyInboundStatus(row, ackByMessage.get(row.id)),
      sessionId: scrubPrivateText(entry.sessionId),
      agentGroupId: scrubPrivateText(entry.agentGroupId),
    }));
  } finally {
    inDb.close();
  }
}

function countMarkdownFiles(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((name) => name.endsWith('.md') && fs.statSync(path.join(dir, name)).isFile())
    .length;
}

function sourceLinkedRawCaptureSummary(root: string): { ids: Set<string>; hostIngressReceipts: number } {
  const ids = new Set<string>();
  let hostIngressReceipts = 0;
  const inboxDir = path.join(root, 'inbox-whatsapp');
  if (!fs.existsSync(inboxDir)) return { ids, hostIngressReceipts };
  const sourceRe = /\/workspace\/inbox\/([^/\s)]+)\//g;
  const sourceIdRe = /## WhatsApp source message id\s*\r?\n([^\r\n]+)/gi;
  for (const name of fs.readdirSync(inboxDir)) {
    if (!name.endsWith('.md')) continue;
    const filePath = path.join(inboxDir, name);
    if (!fs.statSync(filePath).isFile()) continue;
    const content = fs.readFileSync(filePath, 'utf-8');
    if (/## Capture status\s*\r?\nHost-level receipt; pending agent processing\./i.test(content)) {
      hostIngressReceipts += 1;
    }
    for (const match of content.matchAll(sourceRe)) ids.add(scrubPrivateText(match[1]));
    for (const match of content.matchAll(sourceIdRe)) {
      const id = match[1]?.trim();
      if (id) ids.add(scrubPrivateText(id));
    }
  }
  return { ids, hostIngressReceipts };
}

function buildCaptureCoverage(
  root: string,
  captureEvents: ProvenanceEvent[],
  entries: CaptureLedgerEntry[],
  options: CaptureLedgerOptions,
): CaptureCoverage {
  const dataDir = path.resolve(options.dataDir ?? path.join(options.cwd ?? process.cwd(), 'data'));
  const sessions = sessionDirs(dataDir);
  const inbound: SessionInboundEntry[] = [];
  let sessionsScanned = 0;
  for (const session of sessions) {
    const collected = collectSessionInbound(session);
    if (!collected) continue;
    sessionsScanned += 1;
    inbound.push(...collected);
  }

  const rawSummary = sourceLinkedRawCaptureSummary(root);
  const rawIds = rawSummary.ids;
  const countable = inbound.filter((entry) => entry.status !== 'failed' && entry.status !== 'skipped');
  const completed = inbound.filter((entry) => entry.status === 'completed').length;
  const open = inbound.filter((entry) => entry.status === 'accepted' || entry.status === 'processing').length;
  const unlinked = countable
    .filter((entry) => !rawIds.has(entry.id))
    .sort((a, b) => compareAbsoluteTimestampDesc(a.timestamp, b.timestamp));
  const latestInbound = inbound.sort((a, b) => compareAbsoluteTimestampDesc(a.timestamp, b.timestamp))[0];
  const latestCapture = entries.sort((a, b) => compareTimestampDesc(a.capturedAt, b.capturedAt))[0];
  const status: CaptureCoverageStatus =
    sessionsScanned === 0 ? 'unavailable' : unlinked.length > 0 ? 'possible_gap' : 'ok';

  return {
    status,
    dataDir: scrubPrivateText(dataDir),
    sessionsScanned,
    whatsappInboundRows: inbound.length,
    whatsappInboundCompleted: completed,
    whatsappInboundOpen: open,
    rawMarkdownFiles: countMarkdownFiles(path.join(root, 'inbox-whatsapp')),
    captureProvenanceEvents: captureEvents.length,
    hostIngressReceipts: rawSummary.hostIngressReceipts,
    sourceLinkedRawCaptures: rawIds.size,
    possibleUnlinkedWhatsAppInbound: unlinked.length,
    latestWhatsAppInbound: latestInbound ? formatSessionTimestamp(latestInbound.timestamp) : undefined,
    latestCapture: latestCapture?.capturedAt,
    recentUnlinkedWhatsAppInbound: unlinked.slice(0, 12).map((entry) => ({
      id: entry.id,
      timestamp: formatSessionTimestamp(entry.timestamp),
      status: entry.status,
      sessionId: entry.sessionId,
      agentGroupId: entry.agentGroupId,
    })),
  };
}

export function buildCaptureLedger(root: string, options: CaptureLedgerOptions = {}): CaptureLedger {
  const real = requireRoot(root);
  const events = readProvenanceEvents(real, { limit: Math.max(options.limit ?? 1_000, 1) });
  const entriesById = new Map<string, CaptureLedgerEntry>();
  const captureEvents = events.filter((event) => event.kind === 'capture');

  for (const event of captureEvents) {
    entriesById.set(event.id, captureEntryFromEvent(event));
  }

  for (const event of events) {
    if (event.kind === 'classification') {
      const captureId = event.id.replace(/-classification$/, '');
      const entry = entriesById.get(captureId);
      if (entry) entry.classified = true;
    } else if (event.kind === 'coaching_prompt') {
      const captureId = event.id.replace(/-coaching$/, '');
      const entry = entriesById.get(captureId);
      if (entry) entry.coached = true;
    } else if (event.kind === 'memory_promotion') {
      for (const entry of entriesById.values()) {
        if (event.sourcePaths.some((source) => sourceMatchesCapture(source, entry))) {
          entry.memoryPromotions.push({
            id: scrubPrivateText(event.id),
            title: scrubPrivateText(event.title),
            auditPath: event.outputPaths[0] ? normalizedPath(event.outputPaths[0]) : undefined,
          });
        }
      }
    }
  }

  const entries = Array.from(entriesById.values()).map((entry) => ({
    ...entry,
    status: statusForEntry(entry),
  }));
  entries.sort((a, b) => compareTimestampDesc(a.capturedAt, b.capturedAt));

  const totals = emptyTotals();
  for (const entry of entries) totals[entry.status] += 1;
  const coverage = buildCaptureCoverage(real, captureEvents, entries, options);

  return {
    version: 1,
    generatedAt: sgtTimestamp(options.now),
    totals,
    coverage,
    entries,
  };
}

function renderEntry(entry: CaptureLedgerEntry): string {
  const signals = entry.projectSignals.length > 0 ? entry.projectSignals.join('; ') : 'None detected';
  const promotions =
    entry.memoryPromotions.length > 0
      ? entry.memoryPromotions
          .map((promotion) =>
            promotion.auditPath
              ? `[[${promotion.auditPath.replace(/\.md$/, '')}|${promotion.title}]]`
              : promotion.title,
          )
          .join('; ')
      : 'None';
  return [
    `### ${entry.capturedAt} - ${entry.messageType} - ${entry.status}`,
    `- Raw: ${entry.rawPath ? `[[${entry.rawPath.replace(/\.md$/, '')}]]` : 'missing'}`,
    `- Processed: ${entry.processedPath ? `[[${entry.processedPath.replace(/\.md$/, '')}]]` : 'missing'}`,
    `- Classified: ${entry.classified ? 'yes' : 'no'}`,
    `- Coaching prompt: ${entry.coached ? 'yes' : 'no'}`,
    `- Attention: importance ${entry.importance ?? 'unknown'}, durability ${entry.durability ?? 'unknown'}, actionability ${entry.actionability ?? 'unknown'}, time ${entry.timeSensitivity ?? 'unknown'}`,
    `- Project signals: ${signals}`,
    `- Mnemon promotions: ${promotions}`,
    entry.deadlineWatchPath ? `- Deadline watch: [[${entry.deadlineWatchPath.replace(/\.md$/, '')}]]` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}

function countLine(label: string, count: number): string {
  return `- ${label}: ${count}`;
}

function renderCoverageGap(gap: CaptureCoverageGap): string {
  return [
    `### ${gap.timestamp} - possible unlinked inbound - ${gap.status}`,
    `- Session: ${gap.agentGroupId}/${gap.sessionId}`,
    `- Message id: ${gap.id}`,
  ].join('\n');
}

function renderCoverage(coverage: CaptureCoverage): string {
  const recent =
    coverage.recentUnlinkedWhatsAppInbound.length > 0
      ? coverage.recentUnlinkedWhatsAppInbound.map(renderCoverageGap).join('\n\n')
      : 'No possible unlinked WhatsApp inbound rows found.';
  return [
    '## WhatsApp Capture Coverage',
    `- Coverage status: ${coverage.status}`,
    `- Session DB pairs scanned: ${coverage.sessionsScanned}`,
    `- Data dir: ${coverage.dataDir}`,
    `- WhatsApp inbound rows: ${coverage.whatsappInboundRows}`,
    `- WhatsApp inbound completed: ${coverage.whatsappInboundCompleted}`,
    `- WhatsApp inbound still open: ${coverage.whatsappInboundOpen}`,
    `- Raw inbox Markdown files: ${coverage.rawMarkdownFiles}`,
    `- Capture provenance events: ${coverage.captureProvenanceEvents}`,
    `- Host ingress receipts: ${coverage.hostIngressReceipts}`,
    `- Source-linked raw captures: ${coverage.sourceLinkedRawCaptures}`,
    `- Possible unlinked WhatsApp inbound: ${coverage.possibleUnlinkedWhatsAppInbound}`,
    `- Latest WhatsApp inbound: ${coverage.latestWhatsAppInbound ?? 'none recorded'}`,
    `- Latest capture provenance: ${coverage.latestCapture ?? 'none recorded'}`,
    '',
    'This reconciles accepted WhatsApp session rows against raw inbox notes that contain local source links. It does not print message body text; unlinked rows are possible capture gaps or older/casual messages that were intentionally handled without a raw-note capture.',
    '',
    '### Recent Possible Gaps',
    recent,
  ].join('\n');
}

export function renderCaptureLedgerMarkdown(ledger: CaptureLedger): string {
  const recent = ledger.entries.slice(0, 20);
  return [
    '---',
    'type: capture_ledger',
    'system: distributed-cognition',
    `generated: "${ledger.generatedAt}"`,
    'tags:',
    '  - distributed-cognition/captures',
    '---',
    '',
    `# Capture Ledger - ${ledger.generatedAt}`,
    '',
    '## Summary',
    countLine('Complete captures', ledger.totals.complete),
    countLine('Needs processing', ledger.totals.needs_processing),
    countLine('Needs review', ledger.totals.needs_review),
    countLine('Promoted to Mnemon', ledger.totals.memory_promoted),
    '',
    '## How To Read This',
    'This ledger is built from Distributed Cognition provenance events. It tells you whether accepted captures have raw notes, processed notes, classification, coaching prompts, deadline-watch links, and Mnemon promotions.',
    '',
    'Per-message final WhatsApp delivery is still checked by the host health report rather than this ledger.',
    '',
    renderCoverage(ledger.coverage),
    '',
    '## Recent Captures',
    recent.length > 0 ? recent.map(renderEntry).join('\n\n') : 'No capture provenance events recorded yet.',
    '',
  ].join('\n');
}

export function writeCaptureLedger(root: string, options: CaptureLedgerOptions = {}): WrittenCaptureLedger {
  const real = requireRoot(root);
  const indexDir = path.join(real, '.dc-index');
  const wikiDir = path.join(real, 'project-wikis');
  fs.mkdirSync(indexDir, { recursive: true });
  fs.mkdirSync(wikiDir, { recursive: true });
  const jsonPath = path.join(indexDir, 'capture-ledger.json');
  const markdownPath = path.join(wikiDir, 'capture-ledger.md');
  assertInsideRoot(real, jsonPath);
  assertInsideRoot(real, markdownPath);
  const ledger = buildCaptureLedger(real, options);
  fs.writeFileSync(jsonPath, `${JSON.stringify(ledger, null, 2)}\n`);
  fs.writeFileSync(markdownPath, renderCaptureLedgerMarkdown(ledger));
  return { jsonPath, markdownPath };
}
