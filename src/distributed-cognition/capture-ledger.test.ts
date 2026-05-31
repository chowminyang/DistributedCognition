import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from '../db/schema.js';
import { buildCaptureLedger, renderCaptureLedgerMarkdown, writeCaptureLedger } from './capture-ledger.js';
import { appendProvenanceEvent } from './provenance.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-capture-ledger-'));
  fs.mkdirSync(path.join(tmp, 'inbox-whatsapp'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'daily-reflections'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'approved-updates'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Distributed Cognition capture ledger', () => {
  it('ties capture, classification, coaching, deadline, and Mnemon promotion events together', () => {
    fs.writeFileSync(path.join(tmp, 'inbox-whatsapp', '17-05-26-0815-cortex.md'), '# Raw\n');
    fs.writeFileSync(path.join(tmp, 'daily-reflections', '17-05-26-0815-cortex.md'), '# Reflection\n');
    fs.writeFileSync(path.join(tmp, 'approved-updates', '17-05-26-0816-memory-cortex.md'), '# Memory\n');

    appendProvenanceEvent(tmp, {
      id: '17-05-26-0815-cortex',
      timestamp: '17-05-26, 08:15',
      kind: 'capture',
      title: 'Captured reflection',
      summary: 'Captured raw and processed Markdown.',
      sourcePaths: [],
      outputPaths: [
        'inbox-whatsapp/17-05-26-0815-cortex.md',
        'daily-reflections/17-05-26-0815-cortex.md',
        'open-questions/deadline-watch.md',
      ],
      metadata: {
        messageType: 'reflection',
        importance: 'high',
        durability: 'durable',
        actionability: 'possible',
        timeSensitivity: 'deadline',
        projectSignals: ['CORTEX'],
      },
    });
    appendProvenanceEvent(tmp, {
      id: '17-05-26-0815-cortex-classification',
      timestamp: '17-05-26, 08:15',
      kind: 'classification',
      title: 'Classified as reflection',
      sourcePaths: ['inbox-whatsapp/17-05-26-0815-cortex.md'],
      outputPaths: ['daily-reflections/17-05-26-0815-cortex.md'],
      metadata: {},
    });
    appendProvenanceEvent(tmp, {
      id: '17-05-26-0815-cortex-coaching',
      timestamp: '17-05-26, 08:16',
      kind: 'coaching_prompt',
      title: 'Reflection coaching prompt',
      sourcePaths: ['daily-reflections/17-05-26-0815-cortex.md'],
      outputPaths: [],
      metadata: {},
    });
    appendProvenanceEvent(tmp, {
      id: 'memory-cortex-framing',
      timestamp: '17-05-26, 08:16',
      kind: 'memory_promotion',
      title: 'CORTEX framing',
      summary: 'Durable project pivot.',
      sourcePaths: ['daily-reflections/17-05-26-0815-cortex.md'],
      outputPaths: ['approved-updates/17-05-26-0816-memory-cortex.md'],
      metadata: {},
    });

    const ledger = buildCaptureLedger(tmp, { now: new Date('2026-05-17T00:20:00+08:00') });

    expect(ledger.generatedAt).toBe('17-05-26, 00:20');
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]).toMatchObject({
      id: '17-05-26-0815-cortex',
      messageType: 'reflection',
      status: 'memory_promoted',
      rawPath: 'inbox-whatsapp/17-05-26-0815-cortex.md',
      processedPath: 'daily-reflections/17-05-26-0815-cortex.md',
      deadlineWatchPath: 'open-questions/deadline-watch.md',
      classified: true,
      coached: true,
      projectSignals: ['CORTEX'],
    });
    expect(ledger.entries[0].memoryPromotions[0]).toMatchObject({
      id: 'memory-cortex-framing',
      title: 'CORTEX framing',
      auditPath: 'approved-updates/17-05-26-0816-memory-cortex.md',
    });
    expect(ledger.totals.memory_promoted).toBe(1);

    const markdown = renderCaptureLedgerMarkdown(ledger);
    expect(markdown).toContain('# Capture Ledger - 17-05-26, 00:20');
    expect(markdown).toContain('[[daily-reflections/17-05-26-0815-cortex]]');
    expect(markdown).toContain('[[approved-updates/17-05-26-0816-memory-cortex|CORTEX framing]]');
  });

  it('marks incomplete capture provenance as needing processing and writes dashboard artifacts', () => {
    appendProvenanceEvent(tmp, {
      id: '17-05-26-0915-incomplete',
      timestamp: '17-05-26, 09:15',
      kind: 'capture',
      title: 'Captured reflection',
      sourcePaths: [],
      outputPaths: ['inbox-whatsapp/17-05-26-0915-incomplete.md'],
      metadata: { messageType: 'reflection' },
    });

    const written = writeCaptureLedger(tmp, { now: new Date('2026-05-17T00:30:00+08:00') });
    const json = JSON.parse(fs.readFileSync(written.jsonPath, 'utf-8'));
    const markdown = fs.readFileSync(written.markdownPath, 'utf-8');

    expect(json.entries[0].status).toBe('needs_processing');
    expect(json.totals.needs_processing).toBe(1);
    expect(markdown).toContain('Processed: missing');
    const realRoot = fs.realpathSync(tmp);
    expect(written.jsonPath).toBe(path.join(realRoot, '.dc-index', 'capture-ledger.json'));
    expect(written.markdownPath).toBe(path.join(realRoot, 'project-wikis', 'capture-ledger.md'));
  });

  it('reports possible accepted WhatsApp inbound rows that have no source-linked raw capture', () => {
    const dataDir = path.join(tmp, 'data');
    const sessionDir = path.join(dataDir, 'v2-sessions', 'ag-dc', 'sess-dc');
    fs.mkdirSync(sessionDir, { recursive: true });

    const inDb = new Database(path.join(sessionDir, 'inbound.db'));
    const outDb = new Database(path.join(sessionDir, 'outbound.db'));
    try {
      inDb.exec(INBOUND_SCHEMA);
      outDb.exec(OUTBOUND_SCHEMA);
      inDb
        .prepare(
          `INSERT INTO messages_in (id, seq, kind, timestamp, status, channel_type, content)
           VALUES (?, ?, 'chat', ?, 'pending', 'whatsapp', ?)`,
        )
        .run('in-linked', 2, '2026-05-16T23:14:39.000Z', JSON.stringify({ text: 'do not leak linked body' }));
      inDb
        .prepare(
          `INSERT INTO messages_in (id, seq, kind, timestamp, status, channel_type, content)
           VALUES (?, ?, 'chat', ?, 'pending', 'whatsapp', ?)`,
        )
        .run('in-linked-text', 4, '2026-05-16T23:16:39.000Z', JSON.stringify({ text: 'do not leak text body' }));
      inDb
        .prepare(
          `INSERT INTO messages_in (id, seq, kind, timestamp, status, channel_type, content)
           VALUES (?, ?, 'chat', ?, 'pending', 'whatsapp', ?)`,
        )
        .run('in-missing', 6, '2026-05-16T23:18:39.000Z', JSON.stringify({ text: 'do not leak missing body' }));
      outDb
        .prepare('INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)')
        .run('in-linked', 'completed', '2026-05-16T23:15:10.000Z');
      outDb
        .prepare('INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)')
        .run('in-linked-text', 'completed', '2026-05-16T23:17:10.000Z');
      outDb
        .prepare('INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)')
        .run('in-missing', 'completed', '2026-05-16T23:19:10.000Z');
    } finally {
      inDb.close();
      outDb.close();
    }

    fs.writeFileSync(
      path.join(tmp, 'inbox-whatsapp', '17-05-26-0714-linked.md'),
      [
        '# Raw',
        '',
        '## Audio source path',
        '/workspace/inbox/in-linked/audio.ogg',
        '',
        'This raw body is local but should not appear in the coverage gap listing.',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(tmp, 'inbox-whatsapp', '17-05-26-0716-linked-text.md'),
      [
        '# Raw',
        '',
        '## WhatsApp source message id',
        'in-linked-text',
        '',
        '## Capture status',
        'Host-level receipt; pending agent processing.',
        '',
        'This text body is local but should not appear in the coverage gap listing.',
      ].join('\n'),
    );
    appendProvenanceEvent(tmp, {
      id: '17-05-26-0714-linked',
      timestamp: '17-05-26, 07:14',
      kind: 'capture',
      title: 'Captured reflection',
      summary: 'Captured raw source-linked Markdown.',
      sourcePaths: [],
      outputPaths: ['inbox-whatsapp/17-05-26-0714-linked.md'],
      metadata: { messageType: 'reflection' },
    });

    const ledger = buildCaptureLedger(tmp, {
      dataDir,
      now: new Date('2026-05-17T00:30:00+08:00'),
    });
    const markdown = renderCaptureLedgerMarkdown(ledger);

    expect(ledger.coverage.status).toBe('possible_gap');
    expect(ledger.coverage.sessionsScanned).toBe(1);
    expect(ledger.coverage.whatsappInboundRows).toBe(3);
    expect(ledger.coverage.whatsappInboundCompleted).toBe(3);
    expect(ledger.coverage.hostIngressReceipts).toBe(1);
    expect(ledger.coverage.sourceLinkedRawCaptures).toBe(2);
    expect(ledger.coverage.possibleUnlinkedWhatsAppInbound).toBe(1);
    expect(ledger.coverage.recentUnlinkedWhatsAppInbound).toEqual([
      {
        id: 'in-missing',
        timestamp: '17-05-26, 07:18',
        status: 'completed',
        sessionId: 'sess-dc',
        agentGroupId: 'ag-dc',
      },
    ]);
    expect(markdown).toContain('## WhatsApp Capture Coverage');
    expect(markdown).toContain('- Host ingress receipts: 1');
    expect(markdown).toContain('- Possible unlinked WhatsApp inbound: 1');
    expect(markdown).toContain('in-missing');
    expect(markdown).not.toContain('do not leak linked body');
    expect(markdown).not.toContain('do not leak text body');
    expect(markdown).not.toContain('do not leak missing body');
  });
});
