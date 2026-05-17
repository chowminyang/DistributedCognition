import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendProgressEvent,
  queueStatusReply,
  readUnifiedQueueStatus,
  renderUnifiedQueueStatusMarkdown,
  writeUnifiedQueueStatus,
} from './queue-status.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-queue-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeQueueRecord(kindDir: string, statusDir: string, id: string, record: Record<string, unknown>): void {
  const dir = path.join(tmp, '.dc-index', kindDir, statusDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), `${JSON.stringify({ id, ...record }, null, 2)}\n`);
}

describe('Distributed Cognition queue status', () => {
  it('summarises Codex and action queues together', () => {
    writeQueueRecord('codex-handoffs', 'queued', 'codex-1', {
      createdAt: '17-05-26, 10:00',
      projectName: 'Demo',
      task: 'Fix tests',
      target: 'codex-local',
    });
    writeQueueRecord('action-requests', 'completed', 'action-1', {
      createdAt: '17-05-26, 09:00',
      title: 'Deck',
      brief: 'Create slides',
      target: 'codex-local',
    });

    const summary = readUnifiedQueueStatus(tmp);
    expect(summary.totals.queued).toBe(1);
    expect(summary.totals.completed).toBe(1);
    expect(summary.byKind.codex_handoff.queued).toBe(1);
    expect(summary.byKind.action_request.completed).toBe(1);
    expect(renderUnifiedQueueStatusMarkdown(summary)).toContain('Codex handoff codex-1');
  });

  it('uses progress events to show running queued items', () => {
    writeQueueRecord('codex-handoffs', 'queued', 'codex-2', {
      createdAt: '17-05-26, 10:00',
      projectName: 'Demo',
      task: 'Run build',
    });
    appendProgressEvent(tmp, {
      id: 'codex-2',
      kind: 'codex_handoff',
      status: 'running',
      title: 'Demo: Run build',
      detail: 'Local Codex started.',
    });

    const summary = readUnifiedQueueStatus(tmp);
    expect(summary.totals.running).toBe(1);
    expect(summary.totals.queued).toBe(0);
    expect(queueStatusReply(summary)).toContain('1 active item');
  });

  it('writes Markdown and JSON status files', () => {
    const written = writeUnifiedQueueStatus(tmp);
    expect(fs.existsSync(written.markdownPath)).toBe(true);
    expect(fs.existsSync(written.jsonPath)).toBe(true);
    expect(fs.readFileSync(written.markdownPath, 'utf-8')).toContain('# Distributed Cognition Work Queue');
  });
});
