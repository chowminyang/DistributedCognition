import fs from 'fs';

import Database from 'better-sqlite3';

import { formatDistributedTimestamp, scrubPrivateText } from './notes.js';

export interface MnemonMemoryRow {
  id: string;
  layer: string;
  title?: string;
  content: string;
  source: string;
  sourceFile?: string;
  createdAt: string;
  confidence: number;
  importance: number;
  entityType?: string;
  entityName?: string;
}

export interface MnemonMemoryReport {
  generatedAt: string;
  dbPath: string;
  total: number;
  rows: MnemonMemoryRow[];
  byLayer: Record<string, number>;
  byEntityType: Record<string, number>;
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name) as
    | { name?: string }
    | undefined;
  return row?.name === name;
}

function countBy(rows: MnemonMemoryRow[], key: (row: MnemonMemoryRow) => string | undefined): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const value = key(row) || 'unspecified';
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

export function readMnemonMemoryReport(dbPath: string, options: { limit?: number } = {}): MnemonMemoryReport {
  const generatedAt = formatDistributedTimestamp(new Date());
  if (!fs.existsSync(dbPath)) {
    return { generatedAt, dbPath, total: 0, rows: [], byLayer: {}, byEntityType: {} };
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    if (!tableExists(db, 'memories')) {
      return { generatedAt, dbPath, total: 0, rows: [], byLayer: {}, byEntityType: {} };
    }
    const limit = Math.min(200, Math.max(1, options.limit ?? 40));
    const rows = db
      .prepare(
        `
          SELECT
            id,
            layer,
            title,
            content,
            source,
            source_file AS sourceFile,
            created_at AS createdAt,
            confidence,
            importance,
            entity_type AS entityType,
            entity_name AS entityName
          FROM memories
          WHERE superseded_by IS NULL
            AND (
              source LIKE 'distributed-cognition%'
              OR scope = 'distributed-cognition'
              OR source_file IS NOT NULL
            )
          ORDER BY importance DESC, confidence DESC, created_at DESC
          LIMIT ?
        `,
      )
      .all(limit) as MnemonMemoryRow[];
    const total = (
      db
        .prepare(
          `
            SELECT COUNT(*) AS count
            FROM memories
            WHERE superseded_by IS NULL
              AND (
                source LIKE 'distributed-cognition%'
                OR scope = 'distributed-cognition'
                OR source_file IS NOT NULL
              )
          `,
        )
        .get() as { count: number }
    ).count;
    const cleanRows = rows.map((row) => ({
      ...row,
      title: row.title ? scrubPrivateText(row.title) : undefined,
      content: scrubPrivateText(row.content),
      sourceFile: row.sourceFile ? scrubPrivateText(row.sourceFile) : undefined,
      entityName: row.entityName ? scrubPrivateText(row.entityName) : undefined,
    }));
    return {
      generatedAt,
      dbPath: scrubPrivateText(dbPath),
      total,
      rows: cleanRows,
      byLayer: countBy(cleanRows, (row) => row.layer),
      byEntityType: countBy(cleanRows, (row) => row.entityType),
    };
  } finally {
    db.close();
  }
}

function countsMarkdown(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return entries.length > 0 ? entries.map(([key, value]) => `- ${key}: ${value}`).join('\n') : '- None';
}

function memoryRowMarkdown(row: MnemonMemoryRow): string {
  const source = row.sourceFile ? `; source ${row.sourceFile}` : '';
  const entity = row.entityName ? `; entity ${row.entityName}` : '';
  return [
    `### ${row.title || row.id}`,
    `- id: ${row.id}`,
    `- layer: ${row.layer}; importance ${row.importance.toFixed(2)}; confidence ${row.confidence.toFixed(2)}${entity}${source}`,
    `- created: ${row.createdAt}`,
    '',
    row.content,
  ].join('\n');
}

export function renderMnemonMemoryReport(report: MnemonMemoryReport): string {
  return [
    `# Mnemon Memory Report - ${report.generatedAt}`,
    '',
    '## Scope',
    `- Database: ${report.dbPath}`,
    `- Distributed Cognition memories: ${report.total}`,
    '',
    '## By Layer',
    countsMarkdown(report.byLayer),
    '',
    '## By Entity Type',
    countsMarkdown(report.byEntityType),
    '',
    '## Attention Notes',
    '- Mnemon should hold durable keys, pivots, decisions, preferences, corrections, and stable project constraints.',
    '- Raw transcripts and ordinary meeting clutter should remain in Markdown notes.',
    '- Review high-importance procedural and semantic memories first when DC starts behaving oddly.',
    '',
    '## Recent / High-Signal Memories',
    report.rows.length > 0
      ? report.rows.map(memoryRowMarkdown).join('\n\n')
      : 'No Distributed Cognition memories found.',
    '',
  ].join('\n');
}
