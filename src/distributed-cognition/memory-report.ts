import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

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
  byImportanceBand: Record<string, number>;
  graph: MnemonMemoryGraph;
}

export interface MnemonMemoryGraphNode {
  id: string;
  kind: 'system' | 'layer' | 'entity' | 'memory' | 'source';
  label: string;
  importance?: number;
}

export interface MnemonMemoryGraphEdge {
  from: string;
  to: string;
  label?: string;
}

export interface MnemonMemoryGraph {
  nodes: MnemonMemoryGraphNode[];
  edges: MnemonMemoryGraphEdge[];
}

export interface MnemonMemoryCanvasNode {
  id: string;
  type: 'text';
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  text: string;
}

export interface MnemonMemoryCanvasEdge {
  id: string;
  fromNode: string;
  fromSide: 'right';
  toNode: string;
  toSide: 'left';
  color?: string;
  label?: string;
}

export interface MnemonMemoryCanvas {
  nodes: MnemonMemoryCanvasNode[];
  edges: MnemonMemoryCanvasEdge[];
}

export interface WriteMnemonMemoryReportResult {
  markdownPath: string;
  jsonPath: string;
  graphJsonPath: string;
  canvasPath: string;
  report: MnemonMemoryReport;
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

function emptyReport(generatedAt: string, dbPath: string): MnemonMemoryReport {
  return {
    generatedAt,
    dbPath: scrubPrivateText(dbPath),
    total: 0,
    rows: [],
    byLayer: {},
    byEntityType: {},
    byImportanceBand: {},
    graph: buildMnemonMemoryGraph([]),
  };
}

function importanceBand(row: MnemonMemoryRow): string {
  if (row.importance >= 0.85) return 'key_or_pivot';
  if (row.importance >= 0.65) return 'useful_context';
  if (row.importance >= 0.45) return 'background';
  return 'low_signal';
}

function graphId(prefix: string, value: string): string {
  const hash = createHash('sha1').update(value).digest('hex').slice(0, 10);
  return `${prefix}_${hash}`;
}

function compactLabel(value: string, max = 80): string {
  const clean = scrubPrivateText(value).replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 3)}...`;
}

function addGraphNode(nodes: Map<string, MnemonMemoryGraphNode>, node: MnemonMemoryGraphNode): MnemonMemoryGraphNode {
  const existing = nodes.get(node.id);
  if (existing) return existing;
  nodes.set(node.id, node);
  return node;
}

function addGraphEdge(edges: Map<string, MnemonMemoryGraphEdge>, edge: MnemonMemoryGraphEdge): void {
  const key = `${edge.from}->${edge.to}:${edge.label ?? ''}`;
  if (!edges.has(key)) edges.set(key, edge);
}

function buildMnemonMemoryGraph(rows: MnemonMemoryRow[]): MnemonMemoryGraph {
  const nodes = new Map<string, MnemonMemoryGraphNode>();
  const edges = new Map<string, MnemonMemoryGraphEdge>();

  addGraphNode(nodes, { id: 'dc', kind: 'system', label: 'Distributed Cognition' });
  for (const row of rows) {
    const layerId = graphId('layer', row.layer);
    const entityType = row.entityType || 'unspecified';
    const entityName = row.entityName || 'unspecified';
    const entityId = graphId('entity', `${entityType}:${entityName}`);
    const memoryId = graphId('memory', row.id);

    addGraphNode(nodes, { id: layerId, kind: 'layer', label: `layer: ${row.layer}` });
    addGraphNode(nodes, {
      id: entityId,
      kind: 'entity',
      label: `${entityType}: ${compactLabel(entityName, 64)}`,
    });
    addGraphNode(nodes, {
      id: memoryId,
      kind: 'memory',
      label: `${compactLabel(row.title || row.id, 56)}\\nimportance ${row.importance.toFixed(2)}`,
      importance: row.importance,
    });

    addGraphEdge(edges, { from: 'dc', to: layerId });
    addGraphEdge(edges, { from: layerId, to: entityId });
    addGraphEdge(edges, { from: entityId, to: memoryId });

    if (row.sourceFile) {
      const sourceId = graphId('source', row.sourceFile);
      addGraphNode(nodes, { id: sourceId, kind: 'source', label: compactLabel(row.sourceFile, 72) });
      addGraphEdge(edges, { from: memoryId, to: sourceId, label: 'source' });
    }
  }

  return { nodes: Array.from(nodes.values()), edges: Array.from(edges.values()) };
}

function formatMemoryTimestamp(value: string): string {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return scrubPrivateText(value);
  return formatDistributedTimestamp(parsed);
}

export function readMnemonMemoryReport(dbPath: string, options: { limit?: number } = {}): MnemonMemoryReport {
  const generatedAt = formatDistributedTimestamp(new Date());
  if (!fs.existsSync(dbPath)) {
    return emptyReport(generatedAt, dbPath);
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    if (!tableExists(db, 'memories')) {
      return emptyReport(generatedAt, dbPath);
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
      createdAt: formatMemoryTimestamp(row.createdAt),
      entityName: row.entityName ? scrubPrivateText(row.entityName) : undefined,
    }));
    return {
      generatedAt,
      dbPath: scrubPrivateText(dbPath),
      total,
      rows: cleanRows,
      byLayer: countBy(cleanRows, (row) => row.layer),
      byEntityType: countBy(cleanRows, (row) => row.entityType),
      byImportanceBand: countBy(cleanRows, importanceBand),
      graph: buildMnemonMemoryGraph(cleanRows),
    };
  } finally {
    db.close();
  }
}

function countsMarkdown(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return entries.length > 0 ? entries.map(([key, value]) => `- ${key}: ${value}`).join('\n') : '- None';
}

function mermaidLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '<br/>');
}

function renderGraphNode(node: MnemonMemoryGraphNode): string {
  return `  ${node.id}["${mermaidLabel(node.label)}"]`;
}

function renderGraphEdge(edge: MnemonMemoryGraphEdge): string {
  const label = edge.label ? `|${mermaidLabel(edge.label)}|` : '';
  return `  ${edge.from} -->${label} ${edge.to}`;
}

function renderMnemonGraph(graph: MnemonMemoryGraph): string {
  if (graph.nodes.length <= 1) return 'No Mnemon graph nodes found.';
  return [
    '```mermaid',
    'flowchart LR',
    ...graph.nodes.map(renderGraphNode),
    ...graph.edges.map(renderGraphEdge),
    '```',
  ].join('\n');
}

function canvasColumn(kind: MnemonMemoryGraphNode['kind']): number {
  switch (kind) {
    case 'system':
      return 0;
    case 'layer':
      return 1;
    case 'entity':
      return 2;
    case 'memory':
      return 3;
    case 'source':
      return 4;
  }
}

function canvasColor(node: MnemonMemoryGraphNode): string {
  if (node.kind === 'system') return '#2563eb';
  if (node.kind === 'layer') return '#0891b2';
  if (node.kind === 'entity') return '#7c3aed';
  if (node.kind === 'source') return '#64748b';
  if ((node.importance ?? 0) >= 0.85) return '#dc2626';
  if ((node.importance ?? 0) >= 0.65) return '#ea580c';
  if ((node.importance ?? 0) >= 0.45) return '#ca8a04';
  return '#475569';
}

function canvasTitle(kind: MnemonMemoryGraphNode['kind']): string {
  switch (kind) {
    case 'system':
      return 'System';
    case 'layer':
      return 'Layer';
    case 'entity':
      return 'Entity';
    case 'memory':
      return 'Memory';
    case 'source':
      return 'Source';
  }
}

function canvasText(node: MnemonMemoryGraphNode): string {
  const importance =
    node.kind === 'memory' && typeof node.importance === 'number'
      ? `\n\nimportance: ${node.importance.toFixed(2)}`
      : '';
  return `**${canvasTitle(node.kind)}**\n${node.label}${importance}`;
}

export function buildMnemonMemoryCanvas(graph: MnemonMemoryGraph): MnemonMemoryCanvas {
  const columnCounters = new Map<number, number>();
  const sortedNodes = [...graph.nodes].sort((a, b) => {
    const columnDelta = canvasColumn(a.kind) - canvasColumn(b.kind);
    return columnDelta || a.label.localeCompare(b.label);
  });
  const nodes = sortedNodes.map((node) => {
    const column = canvasColumn(node.kind);
    const index = columnCounters.get(column) ?? 0;
    columnCounters.set(column, index + 1);
    return {
      id: node.id,
      type: 'text' as const,
      x: column * 420,
      y: index * 210,
      width: node.kind === 'memory' ? 340 : 300,
      height: node.kind === 'memory' ? 170 : 140,
      color: canvasColor(node),
      text: canvasText(node),
    };
  });
  const edges = graph.edges.map((edge) => ({
    id: graphId('edge', `${edge.from}->${edge.to}:${edge.label ?? ''}`),
    fromNode: edge.from,
    fromSide: 'right' as const,
    toNode: edge.to,
    toSide: 'left' as const,
    color: '#94a3b8',
    ...(edge.label ? { label: edge.label } : {}),
  }));
  return { nodes, edges };
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
    '---',
    'type: mnemon_memory_report',
    'system: distributed-cognition',
    `generated: "${report.generatedAt}"`,
    'tags:',
    '  - distributed-cognition/mnemon',
    '  - distributed-cognition/memory-graph',
    '---',
    '',
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
    '## By Importance Band',
    countsMarkdown(report.byImportanceBand),
    '',
    '## Mnemon Graph',
    'This graph shows the report window only. It is meant for Obsidian browsing: durable keys and pivots should be easy to distinguish from background context.',
    '',
    'For a visual board, open [[mnemon-memory-graph.canvas|Mnemon Memory Graph Canvas]] in Obsidian.',
    '',
    renderMnemonGraph(report.graph),
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

function requireSecondBrainRoot(root: string): string {
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

function safeMarkdownOutputPath(root: string, output?: string): string {
  const target = output ?? path.join(root, 'project-wikis', 'mnemon-memory-report.md');
  const resolved = path.resolve(target);
  assertInsideRoot(root, resolved);
  return resolved;
}

export function writeMnemonMemoryReport(
  root: string,
  options: { mnemonDb: string; output?: string; limit?: number },
): WriteMnemonMemoryReportResult {
  const real = requireSecondBrainRoot(root);
  const report = readMnemonMemoryReport(options.mnemonDb, { limit: options.limit });
  const markdownPath = safeMarkdownOutputPath(real, options.output);
  const indexDir = path.join(real, '.dc-index');
  const jsonPath = path.join(indexDir, 'mnemon-memory-report.json');
  const graphJsonPath = path.join(indexDir, 'mnemon-memory-graph.json');
  const canvasPath = path.join(path.dirname(markdownPath), 'mnemon-memory-graph.canvas');
  assertInsideRoot(real, jsonPath);
  assertInsideRoot(real, graphJsonPath);
  assertInsideRoot(real, canvasPath);
  fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
  fs.mkdirSync(indexDir, { recursive: true });
  fs.writeFileSync(markdownPath, renderMnemonMemoryReport(report));
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(graphJsonPath, JSON.stringify(report.graph, null, 2));
  fs.writeFileSync(canvasPath, JSON.stringify(buildMnemonMemoryCanvas(report.graph), null, 2));
  return { markdownPath, jsonPath, graphJsonPath, canvasPath, report };
}
