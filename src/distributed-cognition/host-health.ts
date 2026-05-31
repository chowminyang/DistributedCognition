import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import Database from 'better-sqlite3';

import {
  buildDeliveryLedger,
  formatDeliveryTimestamp,
  type DeliveryLedger,
  type DeliveryOutboundEntry,
} from './delivery-ledger.js';
import { formatDistributedTimestamp, scrubPrivateText, SECOND_BRAIN_FOLDERS } from './notes.js';
import { readUnifiedQueueStatus } from './queue-status.js';

export type HostHealthStatus = 'ok' | 'warning' | 'error';

export interface HostHealthItem {
  label: string;
  status: HostHealthStatus;
  detail: string;
}

export interface HostHealthReport {
  version: 1;
  checkedAt: string;
  overall: HostHealthStatus;
  items: HostHealthItem[];
}

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
) => CommandResult;

export interface HostHealthOptions {
  root: string;
  cwd?: string;
  now?: Date;
  runCommand?: CommandRunner;
  dataDir?: string;
  logsDir?: string;
  mnemonDbPaths?: string[];
}

export interface WrittenHostHealth {
  jsonPath: string;
  markdownPath: string;
}

const DEFAULT_ROOT_CANDIDATES = [
  path.join(os.homedir(), 'Library/CloudStorage/Dropbox/Distributed-Cognition'),
  path.join(os.homedir(), 'Dropbox/Distributed-Cognition'),
];

function defaultRunCommand(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
): CommandResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf-8',
    timeout: options.timeoutMs,
    maxBuffer: 2_000_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
}

function clean(input: string): string {
  return scrubPrivateText(input.replace(/\s+/g, ' ').trim());
}

function statusFromItems(items: HostHealthItem[]): HostHealthStatus {
  if (items.some((item) => item.status === 'error')) return 'error';
  if (items.some((item) => item.status === 'warning')) return 'warning';
  return 'ok';
}

function addItem(items: HostHealthItem[], label: string, status: HostHealthStatus, detail: string): void {
  items.push({ label, status, detail: clean(detail) });
}

function requireRoot(root: string): string {
  if (!fs.existsSync(root)) throw new Error(`Second-brain root does not exist: ${root}`);
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

function ensureWritableFolder(root: string, folder: string): HostHealthItem {
  const dir = path.join(root, folder);
  try {
    fs.mkdirSync(dir, { recursive: true });
    assertInsideRoot(root, dir);
    const probe = path.join(dir, `.dc-health-${process.pid}-${Date.now()}.tmp`);
    fs.writeFileSync(probe, 'ok\n');
    fs.rmSync(probe, { force: true });
    return { label: `second-brain/${folder}`, status: 'ok', detail: 'Folder exists and is writable.' };
  } catch (error) {
    return {
      label: `second-brain/${folder}`,
      status: 'error',
      detail: `Folder is not writable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function recentLines(filePath: string, maxBytes = 1_500_000): string[] {
  if (!fs.existsSync(filePath)) return [];
  const stat = fs.statSync(filePath);
  const start = Math.max(0, stat.size - maxBytes);
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString('utf-8').split(/\r?\n/).filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

function lastMatchingLine(
  lines: string[],
  predicate: (line: string) => boolean,
): { line: string; index: number } | undefined {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (predicate(lines[i])) return { line: lines[i], index: i };
  }
  return undefined;
}

function lineClock(line: string): string | undefined {
  return line.match(/\[(\d{2}:\d{2}:\d{2}(?:\.\d{3})?)\]/)?.[1];
}

function logHealthItems(logsDir: string, latestDbWhatsAppReply?: DeliveryOutboundEntry): HostHealthItem[] {
  const items: HostHealthItem[] = [];
  const logCandidates = [
    path.join(logsDir, 'nanoclaw.screen.log'),
    path.join(logsDir, 'nanoclaw.manual.log'),
    path.join(logsDir, 'nanoclaw.log'),
  ].filter((candidate) => fs.existsSync(candidate));

  if (logCandidates.length === 0) {
    addItem(items, 'whatsapp connection', 'warning', 'No NanoClaw log files were found.');
    addItem(items, 'last WhatsApp route', 'warning', 'No NanoClaw log files were found.');
    if (latestDbWhatsAppReply) {
      addItem(
        items,
        'last WhatsApp reply',
        'ok',
        `Session DB marks a WhatsApp reply delivered at ${formatDeliveryTimestamp(latestDbWhatsAppReply.deliveredAt ?? latestDbWhatsAppReply.timestamp)}.`,
      );
    } else addItem(items, 'last WhatsApp reply', 'warning', 'No NanoClaw log files were found.');
    return items;
  }

  const newestLog = logCandidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  const lines = recentLines(newestLog).map((line) => `${path.basename(newestLog)} ${line}`);
  const connected = lastMatchingLine(lines, (line) => line.includes('Connected to WhatsApp'));
  const closed = lastMatchingLine(
    lines,
    (line) => line.includes('WhatsApp connection closed') || line.includes('Shutdown signal received'),
  );
  if (!connected) {
    addItem(items, 'whatsapp connection', 'warning', 'No recent "Connected to WhatsApp" line was found.');
  } else if (closed && closed.index > connected.index) {
    addItem(
      items,
      'whatsapp connection',
      'error',
      `Latest WhatsApp close/shutdown log appears after the last connection log (${lineClock(closed.line) ?? 'unknown time'}).`,
    );
  } else {
    addItem(
      items,
      'whatsapp connection',
      'ok',
      `Last connected log at ${lineClock(connected.line) ?? 'unknown time'}.`,
    );
  }

  const routed = lastMatchingLine(
    lines,
    (line) =>
      line.includes('Message routed') && (line.includes('whatsapp:') || line.includes('channelType="whatsapp"')),
  );
  const delivered = lastMatchingLine(
    lines,
    (line) => line.includes('Message delivered') && line.includes('channelType="whatsapp"'),
  );
  const blocked = lastMatchingLine(lines, (line) => line.includes('WhatsApp private-mode safety blocked message'));

  if (routed)
    addItem(
      items,
      'last WhatsApp route',
      'ok',
      `Last routed message log at ${lineClock(routed.line) ?? 'unknown time'}.`,
    );
  else if (blocked) {
    addItem(
      items,
      'last WhatsApp route',
      'warning',
      `No routed WhatsApp message found recently; latest safety block was at ${lineClock(blocked.line) ?? 'unknown time'}.`,
    );
  } else addItem(items, 'last WhatsApp route', 'warning', 'No recent routed WhatsApp message was found.');

  if (delivered) {
    addItem(
      items,
      'last WhatsApp reply',
      'ok',
      `Last delivered WhatsApp reply log at ${lineClock(delivered.line) ?? 'unknown time'}.`,
    );
  } else if (latestDbWhatsAppReply) {
    addItem(
      items,
      'last WhatsApp reply',
      'ok',
      `Session DB marks a WhatsApp reply delivered at ${formatDeliveryTimestamp(latestDbWhatsAppReply.deliveredAt ?? latestDbWhatsAppReply.timestamp)}.`,
    );
  } else {
    addItem(items, 'last WhatsApp reply', 'warning', 'No recent delivered WhatsApp reply was found.');
  }

  return items;
}

function commandSummary(result: CommandResult): string {
  if (result.error) return result.error.message;
  const output = clean(`${result.stdout} ${result.stderr}`).slice(0, 240);
  return output || `exit ${result.status ?? 'unknown'}`;
}

function cliHealthItem(cwd: string, runCommand: CommandRunner): HostHealthItem {
  const result = runCommand('pnpm', ['ncl', 'sessions', 'list', '--json'], { cwd, timeoutMs: 10_000 });
  if (result.status === 0 && /"ok"\s*:\s*true/.test(result.stdout)) {
    return { label: 'nanoclaw host socket', status: 'ok', detail: 'CLI reached the NanoClaw host socket.' };
  }
  return {
    label: 'nanoclaw host socket',
    status: 'error',
    detail: `CLI could not reach the NanoClaw host socket: ${commandSummary(result)}`,
  };
}

function processHealthItem(cwd: string, runCommand: CommandRunner): HostHealthItem {
  const result = runCommand('pgrep', ['-fl', 'node .*dist/index.js|tsx src/index.ts'], { cwd, timeoutMs: 5_000 });
  if (result.status === 0 && result.stdout.trim()) {
    return { label: 'nanoclaw host process', status: 'ok', detail: 'NanoClaw host process is running.' };
  }
  return {
    label: 'nanoclaw host process',
    status: 'warning',
    detail: `No obvious NanoClaw host process was found: ${commandSummary(result)}`,
  };
}

function dockerHealthItem(cwd: string, runCommand: CommandRunner): HostHealthItem {
  const result = runCommand('docker', ['ps', '--format', '{{.Names}}\t{{.Status}}'], { cwd, timeoutMs: 10_000 });
  if (result.status !== 0) {
    return {
      label: 'docker agent containers',
      status: 'warning',
      detail: `Docker status could not be read: ${commandSummary(result)}`,
    };
  }
  const agentLines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes('nanoclaw') || line.includes('agent'));
  if (agentLines.length === 0) {
    return {
      label: 'docker agent containers',
      status: 'ok',
      detail: 'Docker is reachable; no NanoClaw agent container is currently running, which is normal while idle.',
    };
  }
  return {
    label: 'docker agent containers',
    status: 'ok',
    detail: `${agentLines.length} likely NanoClaw agent container(s) are running.`,
  };
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name) as
    | { name: string }
    | undefined;
  return Boolean(row);
}

function countPendingOutboundForSession(sessionDir: string): number | undefined {
  const outboundPath = path.join(sessionDir, 'outbound.db');
  const inboundPath = path.join(sessionDir, 'inbound.db');
  if (!fs.existsSync(outboundPath) || !fs.existsSync(inboundPath)) return undefined;
  const outDb = new Database(outboundPath, { readonly: true, fileMustExist: true });
  const inDb = new Database(inboundPath, { readonly: true, fileMustExist: true });
  try {
    if (!tableExists(outDb, 'messages_out') || !tableExists(inDb, 'delivered')) return undefined;
    const outRows = outDb
      .prepare(
        `SELECT id
         FROM messages_out
         WHERE (deliver_after IS NULL OR deliver_after <= datetime('now'))`,
      )
      .all() as Array<{ id: string }>;
    const deliveredRows = inDb.prepare('SELECT message_out_id FROM delivered').all() as Array<{
      message_out_id: string;
    }>;
    const delivered = new Set(deliveredRows.map((entry) => entry.message_out_id));
    return outRows.filter((row) => !delivered.has(row.id)).length;
  } finally {
    outDb.close();
    inDb.close();
  }
}

function sessionDirs(dataDir: string): string[] {
  const root = path.join(dataDir, 'v2-sessions');
  if (!fs.existsSync(root)) return [];
  const dirs: string[] = [];
  for (const agentGroup of fs.readdirSync(root)) {
    const groupDir = path.join(root, agentGroup);
    if (!fs.statSync(groupDir).isDirectory()) continue;
    for (const session of fs.readdirSync(groupDir)) {
      const sessionDir = path.join(groupDir, session);
      if (fs.statSync(sessionDir).isDirectory()) dirs.push(sessionDir);
    }
  }
  return dirs;
}

function pendingOutboundItem(dataDir: string): HostHealthItem {
  try {
    const dirs = sessionDirs(dataDir);
    let pending = 0;
    let readable = 0;
    for (const dir of dirs) {
      const count = countPendingOutboundForSession(dir);
      if (typeof count === 'number') {
        pending += count;
        readable += 1;
      }
    }
    if (readable === 0)
      return { label: 'pending outbound messages', status: 'warning', detail: 'No readable session DB pairs found.' };
    if (pending > 0) {
      return {
        label: 'pending outbound messages',
        status: 'warning',
        detail: `${pending} due outbound message(s) are not marked delivered across ${readable} session(s).`,
      };
    }
    return {
      label: 'pending outbound messages',
      status: 'ok',
      detail: `No due undelivered outbound messages across ${readable} session(s).`,
    };
  } catch (error) {
    return {
      label: 'pending outbound messages',
      status: 'warning',
      detail: `Could not inspect outbound DBs: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function readDeliveryLedgerForHealth(root: string, dataDir: string): DeliveryLedger | Error {
  try {
    return buildDeliveryLedger({ root, dataDir, limit: 80 });
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function deliveryLedgerItem(ledgerOrError: DeliveryLedger | Error): HostHealthItem {
  if (ledgerOrError instanceof Error) {
    return {
      label: 'delivery ledger',
      status: 'warning',
      detail: `Delivery ledger could not be built: ${ledgerOrError.message}`,
    };
  }
  const ledger = ledgerOrError;
  try {
    if (ledger.sessionsScanned === 0) {
      return {
        label: 'delivery ledger',
        status: 'warning',
        detail: 'No readable session DB pairs found for delivery-ledger generation.',
      };
    }
    const due = ledger.outboundTotals.due_undelivered;
    const failed = ledger.outboundTotals.failed;
    if (failed > 0 || due > 0) {
      return {
        label: 'delivery ledger',
        status: 'warning',
        detail: `${due} due undelivered outbound message(s), ${failed} failed outbound message(s), ${ledger.inboundTotals.processing} inbound item(s) still processing.`,
      };
    }
    return {
      label: 'delivery ledger',
      status: 'ok',
      detail: `Delivery ledger can read ${ledger.sessionsScanned} session DB pair(s); no due undelivered or failed outbound messages in the report window.`,
    };
  } catch (error) {
    return {
      label: 'delivery ledger',
      status: 'warning',
      detail: `Delivery ledger could not be built: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function queueHealthItem(root: string): HostHealthItem {
  try {
    const summary = readUnifiedQueueStatus(root, { recentLimit: 1 });
    const active = summary.totals.queued + summary.totals.running + summary.totals.submitted;
    if (summary.totals.failed > 0) {
      return {
        label: 'distributed cognition queues',
        status: 'warning',
        detail: `${active} active item(s), ${summary.totals.failed} failed item(s).`,
      };
    }
    if (active > 0) {
      return {
        label: 'distributed cognition queues',
        status: 'warning',
        detail: `${active} queued/running/submitted item(s) need host bridge attention.`,
      };
    }
    return {
      label: 'distributed cognition queues',
      status: 'ok',
      detail: 'No active queued Codex or action bridge work.',
    };
  } catch (error) {
    return {
      label: 'distributed cognition queues',
      status: 'warning',
      detail: `Queue status could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function mnemonHealthItem(paths: string[]): HostHealthItem {
  const existing = paths.filter((candidate) => fs.existsSync(candidate));
  if (existing.length === 0) {
    return {
      label: 'mnemon database',
      status: 'warning',
      detail: 'No Mnemon database found in the known local group paths.',
    };
  }
  return { label: 'mnemon database', status: 'ok', detail: `${existing.length} Mnemon database path(s) found.` };
}

function defaultMnemonPaths(cwd: string): string[] {
  return [
    path.join(cwd, 'groups', 'dm-with-minyangchow', '.mnemon', 'memory.db'),
    path.join(cwd, 'groups', 'cli-with-minyangchow', '.mnemon', 'memory.db'),
  ];
}

export function resolveDefaultSecondBrainRoot(explicitRoot?: string): string {
  if (explicitRoot) return path.resolve(explicitRoot);
  if (process.env.DC_SECOND_BRAIN_ROOT) return path.resolve(process.env.DC_SECOND_BRAIN_ROOT);
  const existing = DEFAULT_ROOT_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  if (existing) return existing;
  throw new Error('Second-brain root not configured. Pass --root <path> or set DC_SECOND_BRAIN_ROOT.');
}

export function buildHostHealthReport(options: HostHealthOptions): HostHealthReport {
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const root = requireRoot(options.root);
  const dataDir = options.dataDir ? path.resolve(options.dataDir) : path.join(cwd, 'data');
  const logsDir = options.logsDir ? path.resolve(options.logsDir) : path.join(cwd, 'logs');
  const runCommand = options.runCommand ?? defaultRunCommand;
  const now = options.now ?? new Date();
  const items: HostHealthItem[] = [];
  const deliveryLedger = readDeliveryLedgerForHealth(root, dataDir);

  addItem(items, 'second-brain root', 'ok', `Using ${root}.`);
  for (const folder of SECOND_BRAIN_FOLDERS) items.push(ensureWritableFolder(root, folder));
  items.push(cliHealthItem(cwd, runCommand));
  items.push(processHealthItem(cwd, runCommand));
  items.push(dockerHealthItem(cwd, runCommand));
  items.push(
    ...logHealthItems(logsDir, deliveryLedger instanceof Error ? undefined : deliveryLedger.latestWhatsAppReply),
  );
  items.push(pendingOutboundItem(dataDir));
  items.push(deliveryLedgerItem(deliveryLedger));
  items.push(queueHealthItem(root));
  items.push(mnemonHealthItem(options.mnemonDbPaths ?? defaultMnemonPaths(cwd)));

  return {
    version: 1,
    checkedAt: formatDistributedTimestamp(now),
    overall: statusFromItems(items),
    items,
  };
}

export function renderHostHealthMarkdown(report: HostHealthReport): string {
  return [
    '---',
    'type: system_health',
    'system: distributed-cognition',
    `generated: "${report.checkedAt}"`,
    'tags:',
    '  - distributed-cognition/health',
    '---',
    '',
    `# System Health - ${report.checkedAt}`,
    '',
    `Overall: ${report.overall}`,
    '',
    '## Checks',
    ...report.items.map((item) => `- ${item.status.toUpperCase()} - ${item.label}: ${item.detail}`),
    '',
  ].join('\n');
}

export function writeHostHealth(root: string, report: HostHealthReport): WrittenHostHealth {
  const realRoot = requireRoot(root);
  const indexDir = path.join(realRoot, '.dc-index');
  const wikiDir = path.join(realRoot, 'project-wikis');
  assertInsideRoot(realRoot, indexDir);
  assertInsideRoot(realRoot, wikiDir);
  fs.mkdirSync(indexDir, { recursive: true });
  fs.mkdirSync(wikiDir, { recursive: true });
  const jsonPath = path.join(indexDir, 'system-health.json');
  const markdownPath = path.join(wikiDir, 'system-health.md');
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(markdownPath, renderHostHealthMarkdown(report));
  return { jsonPath, markdownPath };
}
