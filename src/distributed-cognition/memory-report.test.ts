import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildMnemonMemoryCanvas,
  readMnemonMemoryReport,
  renderMnemonMemoryReport,
  writeMnemonMemoryReport,
} from './memory-report.js';

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
    expect(report.byImportanceBand.key_or_pivot).toBe(1);
    expect(report.graph.nodes.some((node) => node.kind === 'memory')).toBe(true);
    const markdown = renderMnemonMemoryReport(report);
    expect(markdown).toContain('Durable pivot');
    expect(markdown).toContain('## Mnemon Graph');
    expect(markdown).toContain('[[mnemon-memory-graph.canvas|Mnemon Memory Graph Canvas]]');
    expect(markdown).toContain('```mermaid');
    expect(markdown).toContain('17-05-26, 10:00');
    expect(markdown).toContain('processed-notes/17-05-26-1000-pivot.md');
    const canvas = buildMnemonMemoryCanvas(report.graph);
    expect(canvas.nodes.some((node) => node.text.includes('Durable pivot') && node.color === '#dc2626')).toBe(true);
    expect(canvas.edges.some((edge) => edge.fromNode.startsWith('memory_') && edge.label === 'source')).toBe(true);
  });

  it('handles a missing Mnemon database gracefully', () => {
    const report = readMnemonMemoryReport(path.join(tmp, 'missing.db'));
    expect(report.total).toBe(0);
    expect(renderMnemonMemoryReport(report)).toContain('No Distributed Cognition memories found.');
  });

  it('writes Obsidian report and JSON inside the second-brain root only', () => {
    const root = path.join(tmp, 'second-brain');
    fs.mkdirSync(root);
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
      'mem-2',
      'procedural',
      'Memory hygiene rule',
      'Keep casual noise out of Mnemon.',
      'distributed-cognition-memory-bridge',
      'approved-updates/17-05-26-1010-memory-hygiene.md',
      '2026-05-17T02:10:00Z',
      0.95,
      0.9,
      null,
      'rule',
      'Mnemon hygiene',
      'distributed-cognition',
    );
    db.close();

    const written = writeMnemonMemoryReport(root, { mnemonDb: dbPath });
    const realRoot = fs.realpathSync(root);
    expect(written.markdownPath).toBe(path.join(realRoot, 'project-wikis', 'mnemon-memory-report.md'));
    expect(written.jsonPath).toBe(path.join(realRoot, '.dc-index', 'mnemon-memory-report.json'));
    expect(written.graphJsonPath).toBe(path.join(realRoot, '.dc-index', 'mnemon-memory-graph.json'));
    expect(written.canvasPath).toBe(path.join(realRoot, 'project-wikis', 'mnemon-memory-graph.canvas'));
    expect(fs.readFileSync(written.markdownPath, 'utf-8')).toContain('Memory hygiene rule');
    expect(JSON.parse(fs.readFileSync(written.jsonPath, 'utf-8')).total).toBe(1);
    expect(JSON.parse(fs.readFileSync(written.graphJsonPath, 'utf-8')).nodes.length).toBeGreaterThan(1);
    const canvas = JSON.parse(fs.readFileSync(written.canvasPath, 'utf-8')) as { nodes: unknown[]; edges: unknown[] };
    expect(canvas.nodes.length).toBeGreaterThan(1);
    expect(canvas.edges.length).toBeGreaterThan(0);
    expect(() =>
      writeMnemonMemoryReport(root, {
        mnemonDb: dbPath,
        output: path.join(tmp, 'outside.md'),
      }),
    ).toThrow(/outside second-brain root/);
  });
});
