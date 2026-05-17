import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

const DEFAULT_SECOND_BRAIN_ROOT = path.join(os.homedir(), 'Library/CloudStorage/Dropbox/Distributed-Cognition');
const DEFAULT_MNEMON_DB = path.join(process.cwd(), 'groups/dm-with-minyangchow/.mnemon/memory.db');
const DEFAULT_GROUP_CONFIG = path.join(process.cwd(), 'groups/dm-with-minyangchow/container.json');
const SCAN_FOLDERS = ['processed-notes', 'daily-reflections'] as const;
const MAX_MEMORY_CHARS = 1500;
const SENSITIVE_RE =
  /\b(patient-identifiable|patient identifiable|learner-identifiable|learner identifiable|hr material|exam material|confidential institutional|nric|medical record number|mrn|answer[- ]?key)\b/i;

type Command = 'process';
type MemoryLayer = 'episodic' | 'semantic' | 'procedural' | 'resource';

interface Args {
  command: Command;
  root: string;
  mnemonDb: string;
  execute: boolean;
  limit: number;
}

interface Candidate {
  filePath: string;
  relativePath: string;
  title: string;
  memory: string;
  messageType: string;
  layer: MemoryLayer;
  entityType: 'project' | 'concept' | 'rule';
  entityName: string;
  rationale: string;
  importance: number;
  confidence: number;
}

function usage(): never {
  console.error(
    [
      'Usage: pnpm run dc:memory-bridge -- process [options]',
      '',
      'Options:',
      '  --execute              Store eligible memories in Mnemon. Omit for dry-run.',
      '  --root <path>          Distributed Cognition second-brain root.',
      '  --mnemon-db <path>     Mnemon SQLite database path.',
      '  --limit <n>            Maximum files to scan. Default: 200.',
    ].join('\n'),
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: 'process',
    root: process.env.DC_SECOND_BRAIN_ROOT || detectMountedSecondBrainRoot() || DEFAULT_SECOND_BRAIN_ROOT,
    mnemonDb: process.env.DC_MNEMON_DB || process.env.MNEMON_DB_PATH || DEFAULT_MNEMON_DB,
    execute: false,
    limit: 200,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === 'process') {
      args.command = arg;
    } else if (arg === '--execute') {
      args.execute = true;
    } else if (arg === '--root') {
      const value = argv[++i];
      if (!value) usage();
      args.root = path.resolve(value);
    } else if (arg === '--mnemon-db') {
      const value = argv[++i];
      if (!value) usage();
      args.mnemonDb = path.resolve(value);
    } else if (arg === '--limit') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1) usage();
      args.limit = value;
    } else {
      usage();
    }
  }

  return args;
}

function detectMountedSecondBrainRoot(): string | undefined {
  try {
    if (!fs.existsSync(DEFAULT_GROUP_CONFIG)) return undefined;
    const parsed = JSON.parse(fs.readFileSync(DEFAULT_GROUP_CONFIG, 'utf-8')) as {
      additionalMounts?: Array<{ hostPath?: string; containerPath?: string; readonly?: boolean }>;
    };
    const mount = parsed.additionalMounts?.find(
      (item) => item.containerPath === 'second-brain' && item.readonly === false && item.hostPath,
    );
    return mount?.hostPath ? path.resolve(mount.hostPath) : undefined;
  } catch {
    return undefined;
  }
}

function sgtParts(date = new Date()): Record<string, string> {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Singapore',
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, part) => {
      if (part.type !== 'literal') acc[part.type] = part.value;
      return acc;
    }, {});
}

function sgtTimestamp(date = new Date()): string {
  const parts = sgtParts(date);
  return `${parts.day}-${parts.month}-${parts.year}, ${parts.hour}:${parts.minute}`;
}

function filenameTimestamp(date = new Date()): string {
  const parts = sgtParts(date);
  return `${parts.day}-${parts.month}-${parts.year}-${parts.hour}${parts.minute}`;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

function normalizeText(input: string): string {
  return input.replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
}

function extractSections(markdown: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = markdown.split(/\r?\n/);
  let current: string | undefined;
  let body: string[] = [];

  const flush = (): void => {
    if (!current) return;
    sections.set(current.toLowerCase(), body.join('\n').trim());
  };

  for (const line of lines) {
    const match = line.match(/^##\s+(.+?)\s*$/);
    if (match) {
      flush();
      current = match[1].trim();
      body = [];
      continue;
    }
    if (current) body.push(line);
  }
  flush();
  return sections;
}

function firstHeading(markdown: string): string | undefined {
  return markdown.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim();
}

function classifyLayer(memory: string, classification: string): MemoryLayer {
  if (/resource|file|read this|reference/i.test(classification)) return 'resource';
  if (/decided|decision|today|yesterday|meeting|captured|realised/i.test(memory) && !/\bshould\b/i.test(memory)) {
    return 'episodic';
  }
  if (/\b(should|must|default|prefer|standing|always|never|prioritise|prioritize|workflow|rule)\b/i.test(memory)) {
    return 'procedural';
  }
  return 'semantic';
}

function entityFor(memory: string): Pick<Candidate, 'entityType' | 'entityName'> {
  if (/distributed cognition|dc\b/i.test(memory)) {
    return { entityType: 'project', entityName: 'Distributed Cognition' };
  }
  return { entityType: 'concept', entityName: 'Distributed Cognition' };
}

function messageTypeFrom(classification: string): string {
  if (/durable_memory_candidate/i.test(classification)) return 'durable_memory_candidate';
  if (/\bdecision\b/i.test(classification)) return 'decision';
  if (/forget|correction/i.test(classification)) return 'forget_or_correction_request';
  if (/reflection/i.test(classification)) return 'reflection';
  return 'general_note';
}

function isRawDump(input: string): boolean {
  if (/^#{1,6}\s+(raw|reflection|transcript|decision)\b/im.test(input)) return true;
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean).length > 8;
}

function candidateFromFile(root: string, filePath: string): Candidate | undefined {
  const markdown = fs.readFileSync(filePath, 'utf-8');
  const sections = extractSections(markdown);
  const memory = normalizeText(sections.get('durable memory') || sections.get('long-term memory') || '');
  const triage = sections.get('mnemon triage') || '';
  const classification = sections.get('classification') || '';

  if (!memory || memory.length < 40) return undefined;
  if (memory.length > MAX_MEMORY_CHARS || isRawDump(memory)) return undefined;
  if (SENSITIVE_RE.test(markdown) || SENSITIVE_RE.test(memory)) return undefined;
  const highSignal =
    /confirmed durable memory|safe and high-signal|auto-store|store/i.test(triage) ||
    /durable_memory_candidate|decision/i.test(classification);
  if (!highSignal) return undefined;

  const relativePath = path.relative(root, filePath).split(path.sep).join('/');
  const heading = firstHeading(markdown);
  const headingTitle = heading?.replace(/\s+[—-]\s+\d{2}-\d{2}-\d{2}.*$/, '').trim();
  const inferredTitle = memory.split(/\s+/).slice(0, 8).join(' ');
  const title =
    headingTitle && !/^(processed note|reflection|daily reflection|decision)$/i.test(headingTitle)
      ? headingTitle
      : inferredTitle || slugify(relativePath);
  const messageType = messageTypeFrom(classification);
  const layer = classifyLayer(memory, classification);
  const entity = entityFor(memory);

  return {
    filePath,
    relativePath,
    title,
    memory,
    messageType,
    layer,
    ...entity,
    rationale: `Processed note marked this as ${triage || classification || 'a high-signal durable memory candidate'}.`,
    importance: 0.9,
    confidence: 0.9,
  };
}

function listMarkdownFiles(root: string, limit: number): string[] {
  const files: string[] = [];
  for (const folder of SCAN_FOLDERS) {
    const dir = path.join(root, folder);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) files.push(path.join(dir, entry.name));
    }
  }
  return files
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    .slice(0, limit);
}

function ensureMnemonSchema(db: Database.Database): void {
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      client TEXT NOT NULL,
      project TEXT,
      started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      ended_at TEXT,
      summary TEXT,
      meta TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      layer TEXT NOT NULL CHECK (layer IN ('episodic', 'semantic', 'procedural', 'resource')),
      content TEXT NOT NULL,
      title TEXT,
      source TEXT NOT NULL,
      source_file TEXT,
      session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      event_at TEXT,
      expires_at TEXT,
      confidence REAL NOT NULL DEFAULT 0.8 CHECK (confidence BETWEEN 0.0 AND 1.0),
      importance REAL NOT NULL DEFAULT 0.5 CHECK (importance BETWEEN 0.0 AND 1.0),
      access_count INTEGER NOT NULL DEFAULT 0,
      last_accessed TEXT,
      superseded_by TEXT REFERENCES memories(id) ON DELETE SET NULL,
      supersedes TEXT REFERENCES memories(id) ON DELETE SET NULL,
      entity_type TEXT CHECK (entity_type IN ('user','project','person','concept','file','rule','tool') OR entity_type IS NULL),
      entity_name TEXT,
      scope TEXT NOT NULL DEFAULT 'global',
      meta TEXT NOT NULL DEFAULT '{}',
      stemmed_content TEXT,
      stemmed_title TEXT,
      valid_from TEXT,
      valid_until TEXT,
      embedding_model TEXT
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      id UNINDEXED,
      title,
      content,
      entity_name,
      tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TABLE IF NOT EXISTS event_log (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      memory_id TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK (event_type IN ('created', 'updated', 'superseded', 'deleted')),
      actor TEXT NOT NULL DEFAULT 'api',
      old_content TEXT,
      new_content TEXT,
      diff_meta TEXT NOT NULL DEFAULT '{}',
      occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_memories_layer ON memories(layer) WHERE superseded_by IS NULL;
    CREATE INDEX IF NOT EXISTS idx_memories_entity ON memories(entity_type, entity_name) WHERE superseded_by IS NULL;
    CREATE INDEX IF NOT EXISTS idx_memories_rank ON memories(importance DESC, confidence DESC) WHERE superseded_by IS NULL;
    CREATE INDEX IF NOT EXISTS idx_memories_source_file ON memories(source_file) WHERE source_file IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_event_log_memory ON event_log(memory_id);
    CREATE TRIGGER IF NOT EXISTS memories_fts_insert
    AFTER INSERT ON memories
    BEGIN
      INSERT INTO memories_fts(id, title, content, entity_name)
      VALUES (NEW.id, COALESCE(NEW.stemmed_title, NEW.title), COALESCE(NEW.stemmed_content, NEW.content), NEW.entity_name);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_fts_update
    AFTER UPDATE ON memories
    WHEN OLD.content != NEW.content
      OR OLD.title IS NOT NEW.title
      OR OLD.entity_name IS NOT NEW.entity_name
      OR OLD.stemmed_content IS NOT NEW.stemmed_content
      OR OLD.stemmed_title IS NOT NEW.stemmed_title
    BEGIN
      UPDATE memories_fts
      SET title = COALESCE(NEW.stemmed_title, NEW.title),
          content = COALESCE(NEW.stemmed_content, NEW.content),
          entity_name = NEW.entity_name
      WHERE id = NEW.id;
    END;
    CREATE TRIGGER IF NOT EXISTS memories_fts_delete
    AFTER DELETE ON memories
    BEGIN
      DELETE FROM memories_fts WHERE id = OLD.id;
    END;
  `);
}

function existingMemoryId(db: Database.Database, candidate: Candidate): string | undefined {
  const row = db
    .prepare(
      'SELECT id FROM memories WHERE superseded_by IS NULL AND (source_file = ? OR content = ?) ORDER BY created_at DESC LIMIT 1',
    )
    .get(candidate.relativePath, candidate.memory) as { id?: string } | undefined;
  return row?.id;
}

function auditMarkdown(candidate: Candidate, id: string, ts: string): string {
  return [
    `# Durable Memory Upgrade - ${ts}`,
    '',
    '## Status',
    'auto_stored',
    '',
    '## Mnemon',
    `- Memory id: ${id}`,
    `- Layer: ${candidate.layer}`,
    `- Entity type: ${candidate.entityType}`,
    `- Entity name: ${candidate.entityName}`,
    '- Importance: 0.90',
    '- Confidence: 0.90',
    '- Scope: distributed-cognition',
    '',
    '## Memory',
    candidate.memory,
    '',
    '## Rationale',
    candidate.rationale,
    '',
    '## Source Notes',
    `- ${candidate.relativePath}`,
    '',
    '## Safety',
    '- Raw transcript content was not stored in Mnemon.',
    '- Prohibited sensitive content is blocked before storage.',
    '- This audit note preserves the source trail for later correction or supersession.',
    '',
  ].join('\n');
}

function writeNewAudit(root: string, candidate: Candidate, id: string): string {
  const dir = path.join(root, 'approved-updates');
  fs.mkdirSync(dir, { recursive: true });
  const base = `${filenameTimestamp()}-memory-${slugify(candidate.title || candidate.entityName)}.md`;
  let filePath = path.join(dir, base);
  let index = 2;
  while (fs.existsSync(filePath)) {
    filePath = path.join(dir, base.replace(/\.md$/, `-${index}.md`));
    index += 1;
  }
  fs.writeFileSync(filePath, auditMarkdown(candidate, id, sgtTimestamp()), { flag: 'wx' });
  return path.relative(root, filePath).split(path.sep).join('/');
}

function storeMemory(db: Database.Database, root: string, candidate: Candidate): { id: string; auditPath: string } {
  const id = crypto.randomBytes(16).toString('hex');
  const createdAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const auditPath = writeNewAudit(root, candidate, id);
  const meta = JSON.stringify({
    workflow: 'distributed-cognition-memory-bridge',
    approvalMode: 'automatic',
    messageType: candidate.messageType,
    auditPath,
  });

  db.prepare(
    `
      INSERT INTO memories (
        id, layer, content, title, source, source_file, created_at, updated_at,
        confidence, importance, entity_type, entity_name, scope, meta
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    id,
    candidate.layer,
    candidate.memory,
    candidate.title,
    'distributed-cognition-memory-bridge',
    candidate.relativePath,
    createdAt,
    createdAt,
    candidate.confidence,
    candidate.importance,
    candidate.entityType,
    candidate.entityName,
    'distributed-cognition',
    meta,
  );
  db.prepare('INSERT INTO event_log (memory_id, event_type, actor, new_content, diff_meta) VALUES (?, ?, ?, ?, ?)').run(
    id,
    'created',
    'distributed-cognition-memory-bridge',
    candidate.memory,
    JSON.stringify({ sourceFile: candidate.relativePath, auditPath }),
  );
  return { id, auditPath };
}

function processBridge(args: Args): void {
  if (!fs.existsSync(args.root)) throw new Error(`Second-brain root does not exist: ${args.root}`);
  fs.mkdirSync(path.dirname(args.mnemonDb), { recursive: true });

  const candidates = listMarkdownFiles(args.root, args.limit)
    .map((filePath) => candidateFromFile(args.root, filePath))
    .filter((candidate): candidate is Candidate => Boolean(candidate));

  if (candidates.length === 0) {
    console.log('No eligible Distributed Cognition memory candidates found.');
    return;
  }

  const db = new Database(args.mnemonDb);
  try {
    ensureMnemonSchema(db);
    let stored = 0;
    let skipped = 0;
    for (const candidate of candidates) {
      const existing = existingMemoryId(db, candidate);
      if (existing) {
        console.log(`Skip existing memory ${existing}: ${candidate.relativePath}`);
        skipped += 1;
        continue;
      }
      if (!args.execute) {
        console.log(`Dry-run: would store "${candidate.title}" from ${candidate.relativePath}`);
        skipped += 1;
        continue;
      }
      const result = storeMemory(db, args.root, candidate);
      console.log(`Stored ${result.id}: ${candidate.relativePath} -> ${result.auditPath}`);
      stored += 1;
    }
    console.log(`Done. candidates=${candidates.length} stored=${stored} skipped=${skipped}`);
  } finally {
    db.close();
  }
}

const args = parseArgs(process.argv.slice(2));
try {
  processBridge(args);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
