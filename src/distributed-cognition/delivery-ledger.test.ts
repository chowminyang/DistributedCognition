import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from '../db/schema.js';
import { recordDeliveryAuditEvent } from './delivery-audit.js';
import { buildDeliveryLedger, renderDeliveryLedgerMarkdown, writeDeliveryLedger } from './delivery-ledger.js';

let tmp: string;
let root: string;
let dataDir: string;
let sessionDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-delivery-ledger-'));
  root = path.join(tmp, 'Distributed-Cognition');
  dataDir = path.join(tmp, 'repo', 'data');
  sessionDir = path.join(dataDir, 'v2-sessions', 'ag-test', 'sess-test');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function seedDbs(options: { delivered: boolean; failed?: boolean; processing?: boolean }): void {
  const inbound = new Database(path.join(sessionDir, 'inbound.db'));
  const outbound = new Database(path.join(sessionDir, 'outbound.db'));
  try {
    inbound.exec(INBOUND_SCHEMA);
    outbound.exec(OUTBOUND_SCHEMA);
    inbound
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, platform_id, channel_type, content)
         VALUES ('in-1', 2, 'chat', '2026-05-17T00:03:00.000Z', 'pending', '6500000000@s.whatsapp.net', 'whatsapp', ?)`,
      )
      .run(JSON.stringify({ text: 'secret inbound content must not leak' }));
    outbound
      .prepare(
        `INSERT INTO messages_out (id, seq, in_reply_to, timestamp, kind, platform_id, channel_type, content)
         VALUES ('out-1', 3, 'in-1', '2026-05-17T00:04:00.000Z', 'chat', '6500000000@s.whatsapp.net', 'whatsapp', ?)`,
      )
      .run(JSON.stringify({ text: 'secret outbound content must not leak' }));
    if (options.processing) {
      outbound
        .prepare(
          "INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('in-1', 'processing', '2026-05-17T00:03:10.000Z')",
        )
        .run();
    } else {
      outbound
        .prepare(
          "INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('in-1', 'completed', '2026-05-17T00:04:10.000Z')",
        )
        .run();
    }
    if (options.delivered || options.failed) {
      inbound
        .prepare(
          'INSERT INTO delivered (message_out_id, platform_message_id, status, delivered_at) VALUES (?, ?, ?, ?)',
        )
        .run(
          'out-1',
          options.failed ? null : 'wamid-test-6500000000',
          options.failed ? 'failed' : 'delivered',
          '2026-05-17T00:04:20.000Z',
        );
    }
  } finally {
    inbound.close();
    outbound.close();
  }
}

describe('Distributed Cognition delivery ledger', () => {
  it('ties inbound processing, final outbound delivery, and direct audit events without leaking content', () => {
    seedDbs({ delivered: true });
    const oldRoot = process.env.DC_SECOND_BRAIN_ROOT;
    process.env.DC_SECOND_BRAIN_ROOT = root;
    try {
      recordDeliveryAuditEvent({
        phase: 'visible_work_status',
        status: 'sent',
        sessionId: 'sess-test',
        channelType: 'whatsapp',
        platformId: '6500000000@s.whatsapp.net',
        platformMessageId: 'wa-visible-1',
        timestamp: '17-05-26, 00:03',
      });
    } finally {
      if (oldRoot === undefined) delete process.env.DC_SECOND_BRAIN_ROOT;
      else process.env.DC_SECOND_BRAIN_ROOT = oldRoot;
    }

    const ledger = buildDeliveryLedger({
      root,
      dataDir,
      now: new Date('2026-05-17T00:05:00+08:00'),
    });
    const markdown = renderDeliveryLedgerMarkdown(ledger);
    const written = writeDeliveryLedger(root, { dataDir, now: new Date('2026-05-17T00:05:00+08:00') });
    const json = fs.readFileSync(written.jsonPath, 'utf-8');

    expect(ledger.sessionsScanned).toBe(1);
    expect(ledger.inboundTotals.completed).toBe(1);
    expect(ledger.outboundTotals.delivered).toBe(1);
    expect(ledger.latestWhatsAppReply?.status).toBe('delivered');
    expect(ledger.latestWhatsAppReply?.deliveredAt).toBe('2026-05-17T00:04:20.000Z');
    expect(ledger.outbound[0].contentKind).toBe('text');
    expect(ledger.recentAuditEvents[0].metadata.phase).toBe('visible_work_status');
    expect(markdown).toContain('# Delivery Ledger - 17-05-26, 00:05');
    expect(markdown).toContain('Latest WhatsApp reply: 17-05-26, 08:04');
    expect(markdown).toContain('Delivered at: 17-05-26, 08:04');
    expect(markdown).toContain('visible_work_status');
    expect(fs.existsSync(written.markdownPath)).toBe(true);
    expect(json).not.toContain('secret inbound content');
    expect(json).not.toContain('secret outbound content');
    expect(json).not.toContain('6500000000@s.whatsapp.net');
  });

  it('marks user-facing outbound rows as due undelivered when no delivered marker exists', () => {
    seedDbs({ delivered: false, processing: true });
    const ledger = buildDeliveryLedger({
      root,
      dataDir,
      now: new Date('2026-05-17T00:05:00+08:00'),
    });

    expect(ledger.inboundTotals.processing).toBe(1);
    expect(ledger.outboundTotals.due_undelivered).toBe(1);
    expect(ledger.outbound[0].status).toBe('due_undelivered');
    expect(ledger.outbound[0].userFacing).toBe(true);
  });
});
