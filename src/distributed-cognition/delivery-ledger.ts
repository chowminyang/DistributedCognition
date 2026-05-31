import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { formatDistributedTimestamp, scrubPrivateText } from './notes.js';
import { readProvenanceEvents, type ProvenanceEvent } from './provenance.js';

export type InboundDeliveryStatus = 'accepted' | 'processing' | 'completed' | 'failed' | 'skipped';
export type OutboundDeliveryStatus = 'delivered' | 'failed' | 'due_undelivered' | 'scheduled' | 'internal';

export interface DeliveryInboundEntry {
  id: string;
  sessionId: string;
  agentGroupId: string;
  timestamp: string;
  channelType: string | null;
  platformId: string | null;
  status: InboundDeliveryStatus;
  processingChangedAt?: string;
}

export interface DeliveryOutboundEntry {
  id: string;
  sessionId: string;
  agentGroupId: string;
  timestamp: string;
  channelType: string | null;
  platformId: string | null;
  kind: string;
  contentKind: string;
  inReplyTo: string | null;
  status: OutboundDeliveryStatus;
  deliveredAt?: string;
  platformMessageId?: string | null;
  userFacing: boolean;
}

export interface DeliveryLedger {
  version: 1;
  generatedAt: string;
  dataDir: string;
  sessionsScanned: number;
  inboundTotals: Record<InboundDeliveryStatus, number>;
  outboundTotals: Record<OutboundDeliveryStatus, number>;
  latestWhatsAppReply?: DeliveryOutboundEntry;
  inbound: DeliveryInboundEntry[];
  outbound: DeliveryOutboundEntry[];
  recentAuditEvents: ProvenanceEvent[];
}

export interface DeliveryLedgerOptions {
  root: string;
  dataDir?: string;
  cwd?: string;
  limit?: number;
  now?: Date;
}

export interface WrittenDeliveryLedger {
  jsonPath: string;
  markdownPath: string;
}

interface InboundRow {
  id: string;
  timestamp: string;
  status: string | null;
  platform_id: string | null;
  channel_type: string | null;
}

interface ProcessingAckRow {
  message_id: string;
  status: string;
  status_changed: string;
}

interface OutboundRow {
  id: string;
  timestamp: string;
  deliver_after: string | null;
  kind: string;
  platform_id: string | null;
  channel_type: string | null;
  in_reply_to: string | null;
  content: string;
}

interface DeliveredRow {
  message_out_id: string;
  platform_message_id: string | null;
  status: string;
  delivered_at: string;
}

const EMPTY_INBOUND_TOTALS: Record<InboundDeliveryStatus, number> = {
  accepted: 0,
  processing: 0,
  completed: 0,
  failed: 0,
  skipped: 0,
};

const EMPTY_OUTBOUND_TOTALS: Record<OutboundDeliveryStatus, number> = {
  delivered: 0,
  failed: 0,
  due_undelivered: 0,
  scheduled: 0,
  internal: 0,
};

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

function safeId(input: string | null | undefined): string | null {
  if (!input) return null;
  return scrubPrivateText(input);
}

function timestampRank(value: string | undefined): number {
  if (!value) return 0;
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function formatDeliveryTimestamp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const zoned = /[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}Z`;
  const parsed = new Date(zoned);
  return Number.isNaN(parsed.getTime()) ? value : formatDistributedTimestamp(parsed);
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

function classifyInboundStatus(row: InboundRow, ack?: ProcessingAckRow): InboundDeliveryStatus {
  if (ack?.status === 'processing') return 'processing';
  if (ack?.status === 'completed') return 'completed';
  if (ack?.status === 'failed') return 'failed';
  if (row.status === 'failed') return 'failed';
  if (row.status === 'completed') return 'completed';
  if (row.status === 'skipped') return 'skipped';
  return 'accepted';
}

function contentKind(content: string): string {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (typeof parsed.type === 'string') return parsed.type;
    if (typeof parsed.action === 'string') return `system:${parsed.action}`;
    if (typeof parsed.operation === 'string') return `operation:${parsed.operation}`;
    if (typeof parsed.markdown === 'string') return 'markdown';
    if (typeof parsed.text === 'string') return 'text';
    if (Array.isArray(parsed.files)) return 'files';
    const firstKey = Object.keys(parsed).sort()[0];
    return firstKey ? `json:${firstKey}` : 'json';
  } catch {
    return 'unparsed';
  }
}

function isScheduled(deliverAfter: string | null, now: Date): boolean {
  if (!deliverAfter) return false;
  const rank = timestampRank(deliverAfter);
  return rank > now.getTime();
}

function classifyOutboundStatus(
  row: OutboundRow,
  delivered: DeliveredRow | undefined,
  now: Date,
): OutboundDeliveryStatus {
  if (delivered?.status === 'failed') return 'failed';
  if (delivered?.status === 'delivered') return row.kind === 'system' ? 'internal' : 'delivered';
  if (row.kind === 'system') return 'internal';
  if (isScheduled(row.deliver_after, now)) return 'scheduled';
  return 'due_undelivered';
}

function cloneInboundTotals(): Record<InboundDeliveryStatus, number> {
  return { ...EMPTY_INBOUND_TOTALS };
}

function cloneOutboundTotals(): Record<OutboundDeliveryStatus, number> {
  return { ...EMPTY_OUTBOUND_TOTALS };
}

function sortNewest<T extends { timestamp: string }>(entries: T[], limit: number): T[] {
  return entries.sort((a, b) => timestampRank(b.timestamp) - timestampRank(a.timestamp)).slice(0, limit);
}

function latestEntry<T extends { timestamp: string; deliveredAt?: string }>(
  entries: T[],
  predicate: (entry: T) => boolean,
): T | undefined {
  return entries
    .filter(predicate)
    .sort((a, b) => timestampRank(b.deliveredAt ?? b.timestamp) - timestampRank(a.deliveredAt ?? a.timestamp))[0];
}

function collectSessionEntries(
  entry: { agentGroupId: string; sessionId: string; dir: string },
  now: Date,
): { inbound: DeliveryInboundEntry[]; outbound: DeliveryOutboundEntry[] } | undefined {
  const inboundPath = path.join(entry.dir, 'inbound.db');
  const outboundPath = path.join(entry.dir, 'outbound.db');
  if (!fs.existsSync(inboundPath) || !fs.existsSync(outboundPath)) return undefined;

  const inDb = new Database(inboundPath, { readonly: true, fileMustExist: true });
  const outDb = new Database(outboundPath, { readonly: true, fileMustExist: true });
  try {
    if (!tableExists(outDb, 'messages_out')) return undefined;

    const ackRows = tableExists(outDb, 'processing_ack')
      ? (outDb.prepare('SELECT message_id, status, status_changed FROM processing_ack').all() as ProcessingAckRow[])
      : [];
    const ackByMessage = new Map(ackRows.map((row) => [row.message_id, row]));

    const deliveredRows = tableExists(inDb, 'delivered')
      ? (inDb
          .prepare('SELECT message_out_id, platform_message_id, status, delivered_at FROM delivered')
          .all() as DeliveredRow[])
      : [];
    const deliveredByMessage = new Map(deliveredRows.map((row) => [row.message_out_id, row]));

    const inboundRows = tableExists(inDb, 'messages_in')
      ? (inDb.prepare('SELECT id, timestamp, status, platform_id, channel_type FROM messages_in').all() as InboundRow[])
      : [];
    const outboundRows = outDb
      .prepare(
        'SELECT id, timestamp, deliver_after, kind, platform_id, channel_type, in_reply_to, content FROM messages_out',
      )
      .all() as OutboundRow[];

    return {
      inbound: inboundRows.map((row) => {
        const ack = ackByMessage.get(row.id);
        return {
          id: scrubPrivateText(row.id),
          sessionId: scrubPrivateText(entry.sessionId),
          agentGroupId: scrubPrivateText(entry.agentGroupId),
          timestamp: row.timestamp,
          channelType: row.channel_type,
          platformId: safeId(row.platform_id),
          status: classifyInboundStatus(row, ack),
          processingChangedAt: ack?.status_changed,
        };
      }),
      outbound: outboundRows.map((row) => {
        const delivered = deliveredByMessage.get(row.id);
        const status = classifyOutboundStatus(row, delivered, now);
        return {
          id: scrubPrivateText(row.id),
          sessionId: scrubPrivateText(entry.sessionId),
          agentGroupId: scrubPrivateText(entry.agentGroupId),
          timestamp: row.timestamp,
          channelType: row.channel_type,
          platformId: safeId(row.platform_id),
          kind: row.kind,
          contentKind: contentKind(row.content),
          inReplyTo: safeId(row.in_reply_to),
          status,
          deliveredAt: delivered?.delivered_at,
          platformMessageId: safeId(delivered?.platform_message_id),
          userFacing: row.kind !== 'system' && row.channel_type !== 'agent',
        };
      }),
    };
  } finally {
    inDb.close();
    outDb.close();
  }
}

export function buildDeliveryLedger(options: DeliveryLedgerOptions): DeliveryLedger {
  const root = requireRoot(options.root);
  const now = options.now ?? new Date();
  const dataDir = path.resolve(options.dataDir ?? path.join(options.cwd ?? process.cwd(), 'data'));
  const limit = Math.max(1, Math.min(250, options.limit ?? 80));
  const inboundTotals = cloneInboundTotals();
  const outboundTotals = cloneOutboundTotals();
  const inbound: DeliveryInboundEntry[] = [];
  const outbound: DeliveryOutboundEntry[] = [];
  let sessionsScanned = 0;

  for (const session of sessionDirs(dataDir)) {
    const collected = collectSessionEntries(session, now);
    if (!collected) continue;
    sessionsScanned += 1;
    inbound.push(...collected.inbound);
    outbound.push(...collected.outbound);
  }

  for (const entry of inbound) inboundTotals[entry.status] += 1;
  for (const entry of outbound) outboundTotals[entry.status] += 1;

  const latestWhatsAppReply = latestEntry(
    outbound,
    (entry) => entry.channelType === 'whatsapp' && entry.userFacing && entry.status === 'delivered',
  );

  const recentAuditEvents = readProvenanceEvents(root, { limit: 200 })
    .filter((event) => event.kind === 'delivery_event')
    .slice(-12)
    .reverse();

  return {
    version: 1,
    generatedAt: formatDistributedTimestamp(now),
    dataDir: scrubPrivateText(dataDir),
    sessionsScanned,
    inboundTotals,
    outboundTotals,
    latestWhatsAppReply,
    inbound: sortNewest(inbound, limit),
    outbound: sortNewest(outbound, limit),
    recentAuditEvents,
  };
}

function renderInbound(entry: DeliveryInboundEntry): string {
  return [
    `### ${formatDeliveryTimestamp(entry.timestamp) ?? entry.timestamp} - inbound - ${entry.status}`,
    `- Session: ${entry.agentGroupId}/${entry.sessionId}`,
    `- Channel: ${entry.channelType ?? 'unknown'}`,
    entry.processingChangedAt
      ? `- Processing changed: ${formatDeliveryTimestamp(entry.processingChangedAt)}`
      : undefined,
  ]
    .filter((line): line is string => typeof line === 'string')
    .join('\n');
}

function renderOutbound(entry: DeliveryOutboundEntry): string {
  return [
    `### ${formatDeliveryTimestamp(entry.timestamp) ?? entry.timestamp} - outbound - ${entry.status}`,
    `- Session: ${entry.agentGroupId}/${entry.sessionId}`,
    `- Channel: ${entry.channelType ?? 'unknown'}`,
    `- Kind: ${entry.kind} / ${entry.contentKind}`,
    `- User-facing: ${entry.userFacing ? 'yes' : 'no'}`,
    entry.deliveredAt ? `- Delivered at: ${formatDeliveryTimestamp(entry.deliveredAt)}` : undefined,
    entry.inReplyTo ? `- In reply to: ${entry.inReplyTo}` : undefined,
  ]
    .filter((line): line is string => typeof line === 'string')
    .join('\n');
}

function renderAuditEvent(event: ProvenanceEvent): string {
  const phase = typeof event.metadata.phase === 'string' ? event.metadata.phase : 'unknown';
  const status = typeof event.metadata.status === 'string' ? event.metadata.status : 'unknown';
  return [
    `### ${event.timestamp} - ${phase} - ${status}`,
    event.summary,
    typeof event.metadata.sessionId === 'string' ? `- Session: ${event.metadata.sessionId}` : undefined,
    typeof event.metadata.channelType === 'string' ? `- Channel: ${event.metadata.channelType}` : undefined,
  ]
    .filter((line): line is string => typeof line === 'string')
    .join('\n');
}

export function renderDeliveryLedgerMarkdown(ledger: DeliveryLedger): string {
  const userFacingDelivered = ledger.outbound.filter(
    (entry) => entry.userFacing && entry.status === 'delivered',
  ).length;
  const userFacingMissing = ledger.outbound.filter(
    (entry) => entry.userFacing && entry.status === 'due_undelivered',
  ).length;
  const latestWhatsAppReply =
    formatDeliveryTimestamp(ledger.latestWhatsAppReply?.deliveredAt ?? ledger.latestWhatsAppReply?.timestamp) ??
    'none recorded';
  return [
    '---',
    'type: delivery_ledger',
    'system: distributed-cognition',
    `generated: "${ledger.generatedAt}"`,
    'tags:',
    '  - distributed-cognition/delivery',
    '---',
    '',
    `# Delivery Ledger - ${ledger.generatedAt}`,
    '',
    '## What This Tracks',
    'This ledger is built from NanoClaw session databases and Distributed Cognition delivery audit events. It tracks accepted inbound messages, container processing acknowledgements, outbound replies, delivered/failure markers, and direct visible work-status sends.',
    '',
    '## Summary',
    `- Session DB pairs scanned: ${ledger.sessionsScanned}`,
    `- Data dir: ${ledger.dataDir}`,
    `- User-facing delivered replies in window: ${userFacingDelivered}`,
    `- User-facing due undelivered replies in window: ${userFacingMissing}`,
    `- Latest WhatsApp reply: ${latestWhatsAppReply}`,
    `- Inbound: accepted ${ledger.inboundTotals.accepted}, processing ${ledger.inboundTotals.processing}, completed ${ledger.inboundTotals.completed}, failed ${ledger.inboundTotals.failed}, skipped ${ledger.inboundTotals.skipped}`,
    `- Outbound: delivered ${ledger.outboundTotals.delivered}, due undelivered ${ledger.outboundTotals.due_undelivered}, failed ${ledger.outboundTotals.failed}, scheduled ${ledger.outboundTotals.scheduled}, internal ${ledger.outboundTotals.internal}`,
    '',
    '## Recent Inbound Processing',
    ledger.inbound.length > 0 ? ledger.inbound.slice(0, 20).map(renderInbound).join('\n\n') : 'No inbound rows found.',
    '',
    '## Recent Outbound Delivery',
    ledger.outbound.length > 0
      ? ledger.outbound.slice(0, 20).map(renderOutbound).join('\n\n')
      : 'No outbound rows found.',
    '',
    '## Recent Direct Delivery Events',
    ledger.recentAuditEvents.length > 0
      ? ledger.recentAuditEvents.map(renderAuditEvent).join('\n\n')
      : 'No direct delivery audit events recorded yet.',
    '',
  ].join('\n');
}

export function writeDeliveryLedger(
  root: string,
  options: Omit<DeliveryLedgerOptions, 'root'> = {},
): WrittenDeliveryLedger {
  const real = requireRoot(root);
  const indexDir = path.join(real, '.dc-index');
  const wikiDir = path.join(real, 'project-wikis');
  assertInsideRoot(real, indexDir);
  assertInsideRoot(real, wikiDir);
  fs.mkdirSync(indexDir, { recursive: true });
  fs.mkdirSync(wikiDir, { recursive: true });
  const ledger = buildDeliveryLedger({ ...options, root: real });
  const jsonPath = path.join(indexDir, 'delivery-ledger.json');
  const markdownPath = path.join(wikiDir, 'delivery-ledger.md');
  fs.writeFileSync(jsonPath, `${JSON.stringify(ledger, null, 2)}\n`);
  fs.writeFileSync(markdownPath, renderDeliveryLedgerMarkdown(ledger));
  return { jsonPath, markdownPath };
}
