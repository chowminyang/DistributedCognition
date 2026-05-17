import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readMnemonMemoryReport, renderMnemonMemoryReport } from './memory-report.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-memory-report-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Distributed Cognition memory report', () => {
  it('reports Distributed Cognition Mnemon memories without raw dumps', () => {
    const dbPath = path.join(tmp, 'memory.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        layer TEXT NOT NULL,
        title TEXT,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        source_file TEXT,
        created_at TEXT NOT NULL,
        confidence REAL NOT NULL,
        importance REAL NOT NULL,
        superseded_by TEXT,
        entity_type TEXT,
        entity_name TEXT,
        scope TEXT
      );
    `);
    db.prepare(
      `
        INSERT INTO memories (
          id, layer, title, content, source, source_file, created_at,
          confidence, importance, superseded_by, entity_type, entity_name, scope
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      'mem-1',
      'semantic',
      'Durable pivot',
      'Distributed Cognition should promote only durable pivots into Mnemon.',
      'distributed-cognition-memory-bridge',
      'processed-notes/17-05-26-1000-pivot.md',
      '2026-05-17T02:00:00Z',
      0.9,
      0.95,
      null,
      'project',
      'Distributed Cognition',
      'distributed-cognition',
    );
    db.close();

    const report = readMnemonMemoryReport(dbPath);
    expect(report.total).toBe(1);
    expect(report.byLayer.semantic).toBe(1);
    const markdown = renderMnemonMemoryReport(report);
    expect(markdown).toContain('Durable pivot');
    expect(markdown).toContain('processed-notes/17-05-26-1000-pivot.md');
  });

  it('handles a missing Mnemon database gracefully', () => {
    const report = readMnemonMemoryReport(path.join(tmp, 'missing.db'));
    expect(report.total).toBe(0);
    expect(renderMnemonMemoryReport(report)).toContain('No Distributed Cognition memories found.');
  });
});
