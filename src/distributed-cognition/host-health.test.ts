import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildHostHealthReport,
  renderHostHealthMarkdown,
  resolveDefaultSecondBrainRoot,
  writeHostHealth,
  type CommandRunner,
} from './host-health.js';

let tmp: string;
let root: string;
let cwd: string;
let dataDir: string;
let logsDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-host-health-'));
  root = path.join(tmp, 'Distributed-Cognition');
  cwd = path.join(tmp, 'repo');
  dataDir = path.join(cwd, 'data');
  logsDir = path.join(cwd, 'logs');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function fakeCommands(
  overrides: Record<string, { status: number; stdout?: string; stderr?: string }> = {},
): CommandRunner {
  return (command, args) => {
    const key = `${command} ${args.join(' ')}`;
    const override = overrides[key];
    if (override) return { status: override.status, stdout: override.stdout ?? '', stderr: override.stderr ?? '' };
    if (key === 'pnpm ncl sessions list --json') return { status: 0, stdout: '{"ok":true,"sessions":[]}', stderr: '' };
    if (key === 'pgrep -fl node .*dist/index.js|tsx src/index.ts') {
      return { status: 0, stdout: '123 node dist/index.js\n', stderr: '' };
    }
    if (key === 'docker ps --format {{.Names}}\t{{.Status}}') {
      return { status: 0, stdout: 'nanoclaw-agent-v2-test\tUp 2 minutes\n', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'unexpected command' };
  };
}

function writeSessionDbs(pending = false): void {
  const sessionDir = path.join(dataDir, 'v2-sessions', 'ag-test', 'sess-test');
  fs.mkdirSync(sessionDir, { recursive: true });
  const inbound = new Database(path.join(sessionDir, 'inbound.db'));
  const outbound = new Database(path.join(sessionDir, 'outbound.db'));
  try {
    inbound.exec(
      "CREATE TABLE delivered (message_out_id TEXT PRIMARY KEY, platform_message_id TEXT, status TEXT NOT NULL DEFAULT 'delivered', delivered_at TEXT NOT NULL)",
    );
    outbound.exec(
      'CREATE TABLE messages_out (id TEXT PRIMARY KEY, seq INTEGER UNIQUE, in_reply_to TEXT, timestamp TEXT NOT NULL, deliver_after TEXT, recurrence TEXT, kind TEXT NOT NULL, platform_id TEXT, channel_type TEXT, thread_id TEXT, content TEXT NOT NULL)',
    );
    outbound
      .prepare(
        "INSERT INTO messages_out (id, seq, timestamp, kind, platform_id, channel_type, content) VALUES (?, 2, datetime('now'), 'chat', '6500000000@s.whatsapp.net', 'whatsapp', ?)",
      )
      .run('out-1', JSON.stringify({ text: 'secret message that must not appear' }));
    if (!pending) {
      inbound
        .prepare(
          "INSERT INTO delivered (message_out_id, platform_message_id, status, delivered_at) VALUES ('out-1', 'wa-1', 'delivered', datetime('now'))",
        )
        .run();
    }
  } finally {
    inbound.close();
    outbound.close();
  }
}

function writeHappyLogs(): void {
  fs.writeFileSync(
    path.join(logsDir, 'nanoclaw.screen.log'),
    [
      '[10:00:00.000] INFO Connected to WhatsApp',
      '[10:01:00.000] INFO Message routed channelType="whatsapp" platformId="6500000000@s.whatsapp.net" content="do not leak this"',
      '[10:02:00.000] INFO Message delivered channelType="whatsapp" platformId="6500000000@s.whatsapp.net" content="do not leak reply"',
    ].join('\n'),
  );
}

function writeLogsWithoutDeliveredReply(): void {
  fs.writeFileSync(
    path.join(logsDir, 'nanoclaw.screen.log'),
    [
      '[10:00:00.000] INFO Connected to WhatsApp',
      '[10:01:00.000] INFO Message routed channelType="whatsapp" platformId="6500000000@s.whatsapp.net" content="do not leak this"',
    ].join('\n'),
  );
}

describe('Distributed Cognition host health', () => {
  it('builds and writes a host-visible health report without leaking message content', () => {
    writeSessionDbs(false);
    writeHappyLogs();
    const mnemonPath = path.join(tmp, 'memory.db');
    fs.writeFileSync(mnemonPath, '');

    const report = buildHostHealthReport({
      root,
      cwd,
      dataDir,
      logsDir,
      mnemonDbPaths: [mnemonPath],
      runCommand: fakeCommands(),
      now: new Date('2026-05-17T00:00:00+08:00'),
    });
    const markdown = renderHostHealthMarkdown(report);
    const written = writeHostHealth(root, report);

    expect(report.overall).toBe('ok');
    expect(report.checkedAt).toBe('17-05-26, 00:00');
    expect(report.items.some((item) => item.label === 'whatsapp connection' && item.status === 'ok')).toBe(true);
    expect(report.items.some((item) => item.label === 'pending outbound messages' && item.status === 'ok')).toBe(true);
    expect(markdown).toContain('# System Health - 17-05-26, 00:00');
    expect(markdown).not.toContain('secret message');
    expect(markdown).not.toContain('6500000000@s.whatsapp.net');
    expect(fs.existsSync(written.jsonPath)).toBe(true);
    expect(fs.existsSync(written.markdownPath)).toBe(true);
  });

  it('uses session DB delivery state when logs do not contain the final WhatsApp reply line', () => {
    writeSessionDbs(false);
    writeLogsWithoutDeliveredReply();
    const mnemonPath = path.join(tmp, 'memory.db');
    fs.writeFileSync(mnemonPath, '');

    const report = buildHostHealthReport({
      root,
      cwd,
      dataDir,
      logsDir,
      mnemonDbPaths: [mnemonPath],
      runCommand: fakeCommands(),
      now: new Date('2026-05-17T00:00:00+08:00'),
    });
    const markdown = renderHostHealthMarkdown(report);
    const replyItem = report.items.find((item) => item.label === 'last WhatsApp reply');

    expect(report.overall).toBe('ok');
    expect(replyItem?.status).toBe('ok');
    expect(replyItem?.detail).toContain('Session DB marks a WhatsApp reply delivered');
    expect(markdown).not.toContain('secret message');
    expect(markdown).not.toContain('6500000000@s.whatsapp.net');
    expect(JSON.stringify(report)).not.toContain('secret message');
    expect(JSON.stringify(report)).not.toContain('6500000000@s.whatsapp.net');
  });

  it('surfaces host socket failures and pending outbound messages', () => {
    writeSessionDbs(true);
    writeHappyLogs();
    const report = buildHostHealthReport({
      root,
      cwd,
      dataDir,
      logsDir,
      mnemonDbPaths: [],
      runCommand: fakeCommands({
        'pnpm ncl sessions list --json': {
          status: 1,
          stderr: 'ECONNREFUSED /Users/minyangchow/Documents/NanoClaw/data/ncl.sock',
        },
      }),
      now: new Date('2026-05-17T00:00:00+08:00'),
    });

    expect(report.overall).toBe('error');
    expect(report.items.find((item) => item.label === 'nanoclaw host socket')?.status).toBe('error');
    expect(report.items.find((item) => item.label === 'pending outbound messages')?.status).toBe('warning');
    expect(JSON.stringify(report)).not.toContain('/Users/minyangchow');
  });

  it('treats reachable Docker with no current agent container as idle and healthy', () => {
    writeSessionDbs(false);
    writeHappyLogs();
    const mnemonPath = path.join(tmp, 'memory.db');
    fs.writeFileSync(mnemonPath, '');

    const report = buildHostHealthReport({
      root,
      cwd,
      dataDir,
      logsDir,
      mnemonDbPaths: [mnemonPath],
      runCommand: fakeCommands({
        'docker ps --format {{.Names}}\t{{.Status}}': {
          status: 0,
          stdout: 'postgres\tUp 2 minutes\n',
        },
      }),
      now: new Date('2026-05-17T00:00:00+08:00'),
    });

    expect(report.overall).toBe('ok');
    expect(report.items.find((item) => item.label === 'docker agent containers')?.status).toBe('ok');
    expect(report.items.find((item) => item.label === 'docker agent containers')?.detail).toContain(
      'normal while idle',
    );
  });

  it('resolves the root from DC_SECOND_BRAIN_ROOT', () => {
    const old = process.env.DC_SECOND_BRAIN_ROOT;
    process.env.DC_SECOND_BRAIN_ROOT = root;
    try {
      expect(resolveDefaultSecondBrainRoot()).toBe(root);
    } finally {
      if (old === undefined) delete process.env.DC_SECOND_BRAIN_ROOT;
      else process.env.DC_SECOND_BRAIN_ROOT = old;
    }
  });
});
