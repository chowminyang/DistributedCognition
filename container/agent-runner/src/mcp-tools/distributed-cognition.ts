import fs from 'fs';
import path from 'path';
import { createHash, randomBytes } from 'crypto';
import { spawnSync } from 'child_process';
import { lookup } from 'dns/promises';
import { isIP } from 'net';

import { Database } from 'bun:sqlite';
import fg from 'fast-glob';
import { getEncoding, type Tiktoken } from 'js-tiktoken';
import mammoth from 'mammoth';
import { parseOffice } from 'officeparser';
import OpenAI, { toFile } from 'openai';

import { getMessageIdBySeq } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

type MessageType =
  | 'reflection'
  | 'decision'
  | 'general_note'
  | 'durable_memory_candidate'
  | 'forget_or_correction_request'
  | 'question'
  | 'weekly_synthesis_request'
  | 'action_request'
  | 'sensitive_data_warning'
  | 'unclear';

const MESSAGE_TYPES: readonly MessageType[] = [
  'reflection',
  'decision',
  'general_note',
  'durable_memory_candidate',
  'forget_or_correction_request',
  'question',
  'weekly_synthesis_request',
  'action_request',
  'sensitive_data_warning',
  'unclear',
];

const SECOND_BRAIN_FOLDERS = [
  'inbox-whatsapp',
  'daily-reflections',
  'processed-notes',
  'pending-review',
  'approved-updates',
  'project-wikis',
  'decision-log',
  'open-questions',
  'argument-bank',
  'weekly-reviews',
] as const;

type SecondBrainFolder = (typeof SECOND_BRAIN_FOLDERS)[number];

interface TemporalMetadata {
  capturedAt: string;
  mentionedDates: string[];
  deadlineCandidates: string[];
  decisionDate: string;
  reviewAfter: string;
  stalenessStatus: string;
}

type AttentionImportance = 'low' | 'medium' | 'high';
type AttentionDurability = 'transient' | 'useful' | 'durable' | 'blocked';
type AttentionActionability = 'none' | 'possible' | 'clear_action';
type AttentionTimeSensitivity = 'none' | 'soon' | 'deadline';

interface AttentionMetadata {
  importance: AttentionImportance;
  durability: AttentionDurability;
  actionability: AttentionActionability;
  timeSensitivity: AttentionTimeSensitivity;
  projectSignals: string[];
  rationale: string;
}

const ROOT_CANDIDATES = ['/workspace/extra/second-brain', '/workspace/agent/second-brain'];
const SOURCE_CONTEXT_ROOTS = [
  { label: 'presentations', path: '/workspace/extra/context-presentations' },
  { label: 'publications', path: '/workspace/extra/context-publications' },
  { label: 'lkc-office-of-aime', path: '/workspace/extra/context-lkc-office-of-aime' },
  { label: 'vibe-coding-101', path: '/workspace/extra/context-vibe-coding-101' },
] as const;
const CONTEXT_TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.mdx', '.txt', '.csv', '.json', '.yaml', '.yml']);
const CONTEXT_EXTRACT_EXTENSIONS = new Set(['.docx', '.pptx', '.xlsx', '.pdf']);
const CONTEXT_READ_EXTENSIONS = new Set([...CONTEXT_TEXT_EXTENSIONS, ...CONTEXT_EXTRACT_EXTENSIONS]);
const SKIPPED_CONTEXT_DIRS = new Set([
  '.git',
  '.dc-index',
  '.next',
  '.venv',
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'vendor',
]);
const BLOCKED_CONTEXT_PATH_PATTERNS = [
  '.env',
  '.npmrc',
  '.netrc',
  'answer key',
  'answer-key',
  'credential',
  'exam package',
  'job description',
  'password',
  'private_key',
  'question bank',
  'secret',
  'salary range',
  'token',
];
const BLOCKED_CONTEXT_PATH_REGEXES = [/(^|\/)jd(\/|$)/i, /\bjob[-_\s]?description\b/i, /\bsalary[-_\s]?range\b/i];
const MAX_CONTEXT_FILE_BYTES = 1_000_000;
const MAX_CONTEXT_EXTRACT_BYTES = 25_000_000;
const MAX_CONTEXT_FILES = 500;
const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 20;
const MAX_SNIPPET_CHARS = 600;
const DEFAULT_READ_CHARS = 12_000;
const MAX_READ_CHARS = 50_000;
const CONTEXT_INDEX_DIR = '.dc-index';
const CONTEXT_INDEX_FILE = 'context-index.jsonl';
const CONTEXT_INDEX_MANIFEST = 'context-index-manifest.json';
const CONTEXT_INDEX_VERSION = 1;
const DEFAULT_INDEX_LIMIT = 350;
const MAX_INDEX_LIMIT = 1000;
const DEFAULT_INDEX_PREVIEW_CHARS = 4_000;
const MAX_INDEX_PREVIEW_CHARS = 20_000;
const SENSITIVE_RE =
  /\b(patient-identifiable|patient identifiable|learner-identifiable|learner identifiable|hr material|exam material|confidential institutional|nric|medical record number|mrn)\b/i;
const PROHIBITED_CONTEXT_RE =
  /\b(patient-identifiable|patient identifiable|learner-identifiable|learner identifiable|hr material|exam material|confidential institutional|nric|medical record number|mrn|job title for posting|salary range|appointment grade|position id)\b/i;
const PROMOTION_SOURCE_FOLDERS: readonly SecondBrainFolder[] = [
  'inbox-whatsapp',
  'daily-reflections',
  'processed-notes',
  'pending-review',
  'weekly-reviews',
  'decision-log',
  'open-questions',
  'argument-bank',
  'approved-updates',
];
const PROMOTION_FOLDER_RANK = new Map<SecondBrainFolder, number>(
  PROMOTION_SOURCE_FOLDERS.map((folder, index) => [folder, index]),
);
const WIKI_PROMOTION_SECTIONS = [
  'Current State',
  'Timeline',
  'Decisions',
  'Open Questions',
  'Risks',
  'Next Actions',
  'Sources',
  'Mnemon Candidates',
  'Update Log',
] as const;
const MNEMON_DB_CANDIDATES = ['/workspace/agent/.mnemon/memory.db'];
const MEMORY_LAYERS = ['episodic', 'semantic', 'procedural', 'resource'] as const;
const MEMORY_ENTITY_TYPES = ['user', 'project', 'person', 'concept', 'file', 'rule', 'tool'] as const;
const MAX_MEMORY_CHARS = 1_500;
const CODEX_PROJECTS_ROOT_CANDIDATES = ['/workspace/extra/codex-projects'];
const CODEX_MEMORY_ROOT_CANDIDATES = ['/workspace/extra/codex-memory'];
const CODEX_STATUS_VERSION = 1;
const CODEX_HANDOFF_VERSION = 1;
const PROJECT_STATUS_VERSION = 1;
const SYSTEM_HEALTH_VERSION = 1;
const MAX_CODEX_PROJECTS = 80;
const MAX_CODEX_TASK_CHARS = 8_000;
const CODEX_STATUS_INDEX_FILE = 'codex-status.json';
const CODEX_HANDOFF_DIR = 'codex-handoffs';
const PROJECT_STATUS_INDEX_FILE = 'project-status.json';
const SYSTEM_HEALTH_FILE = 'system-health.json';
const ACTION_REQUEST_VERSION = 1;
const ACTION_REQUEST_DIR = 'action-requests';
const MAX_ACTION_BRIEF_CHARS = 12_000;
const MAX_ACTION_CONTENT_CHARS = 60_000;
const ACTION_TYPES = ['web_research', 'word_document', 'powerpoint', 'codex_handoff', 'manual_review'] as const;
const DEFAULT_WEB_SEARCH_RESULTS = 5;
const MAX_WEB_SEARCH_RESULTS = 8;
const WEB_FETCH_TIMEOUT_MS = 12_000;
const MAX_WEB_RESPONSE_CHARS = 500_000;
const DEFAULT_WEB_READ_CHARS = 12_000;
const MAX_WEB_READ_CHARS = 40_000;
const WEB_USER_AGENT = 'Distributed-Cognition-NanoClaw/1.0';

type ActionType = (typeof ACTION_TYPES)[number];

type WikiPromotionSection = (typeof WIKI_PROMOTION_SECTIONS)[number];
type MemoryLayer = (typeof MEMORY_LAYERS)[number];
type MemoryEntityType = (typeof MEMORY_ENTITY_TYPES)[number];

const PROJECT_STATUS_VALUES = ['active', 'stale', 'blocked', 'paused', 'watching', 'done'] as const;
type ProjectLifecycleStatus = (typeof PROJECT_STATUS_VALUES)[number];

interface QueueSummary {
  queued: number;
  submitted: number;
  completed: number;
  failed: number;
  recent: Array<{ id: string; title: string; status: string; createdAt?: string; target?: string }>;
}

interface ContextIndexEntry {
  version: typeof CONTEXT_INDEX_VERSION;
  label: string;
  path: string;
  title: string;
  extension: string;
  bytes: number;
  modified: string;
  mtimeMs: number;
  tokenEstimate: number;
  headings: string[];
  preview: string;
  extracted: boolean;
}

interface ContextIndexManifest {
  version: typeof CONTEXT_INDEX_VERSION;
  generatedAt: string;
  generatedAtMs: number;
  roots: Array<{ label: string; root: string }>;
  entries: number;
  skipped: Array<{ label: string; path: string; reason: string }>;
}

interface PromotionSource {
  relativePath: string;
  filePath: string;
  folder: SecondBrainFolder;
  title: string;
  capturedAt: string;
  sortKey: number;
  content: string;
}

interface DurableMemoryInput {
  memory: string;
  title?: string;
  layer?: MemoryLayer;
  entityType?: MemoryEntityType;
  entityName?: string;
  messageType?: MessageType;
  sourcePaths?: string[];
  rationale?: string;
  importance?: number;
  confidence?: number;
  eventAt?: string;
  validFrom?: string;
  validUntil?: string;
  scope?: string;
  approvalMode?: 'automatic' | 'explicit_user_request' | 'reviewed_approval';
}

interface StoredMemoryResult {
  id: string;
  auditPath: string;
  dbPath: string;
  layer: MemoryLayer;
  sourceRelativePath?: string;
}

interface CodexProjectStatus {
  name: string;
  relativePath: string;
  branch: string;
  dirtyCount: number;
  statusLine: string;
  recentCommits: string[];
  stack: string[];
  scripts: string[];
  hasGit: boolean;
  modified: string;
}

interface CodexStatusIndex {
  version: typeof CODEX_STATUS_VERSION;
  generatedAt: string;
  projectsRoot: string;
  projects: CodexProjectStatus[];
  memoryRoot?: string;
  memorySignals: string[];
  handoffSummary: QueueSummary;
  actionSummary: QueueSummary;
  skipped: Array<{ path: string; reason: string }>;
}

interface ProjectStatusRecord {
  version: typeof PROJECT_STATUS_VERSION;
  slug: string;
  name: string;
  status: ProjectLifecycleStatus;
  updatedAt: string;
  currentState: string;
  nextActions: string[];
  openQuestions: string[];
  decisions: string[];
  risks: string[];
  sourcePaths: string[];
  reviewAfter: string;
  wikiPath: string;
}

interface ProjectStatusIndex {
  version: typeof PROJECT_STATUS_VERSION;
  updatedAt: string;
  projects: ProjectStatusRecord[];
}

interface HealthCheckItem {
  label: string;
  status: 'ok' | 'warning' | 'error';
  detail: string;
}

interface SystemHealthReport {
  version: typeof SYSTEM_HEALTH_VERSION;
  checkedAt: string;
  overall: 'ok' | 'warning' | 'error';
  items: HealthCheckItem[];
}

interface CodexHandoffRecord {
  version: typeof CODEX_HANDOFF_VERSION;
  id: string;
  createdAt: string;
  status: 'queued';
  target: 'codex-local' | 'codex-cloud' | 'queue-only';
  projectName: string;
  relativeProjectPath: string;
  task: string;
  planMarkdown?: string;
  acceptanceCriteria?: string[];
  cloudEnv?: string;
  branch?: string;
  model?: string;
  priority?: string;
  sourceNotePaths: string[];
  notePath: string;
}

interface ActionRequestRecord {
  version: typeof ACTION_REQUEST_VERSION;
  id: string;
  createdAt: string;
  status: 'queued';
  actionType: ActionType;
  title: string;
  brief: string;
  contentMarkdown?: string;
  outputName?: string;
  target?: 'local' | 'codex-local' | 'codex-cloud' | 'queue-only';
  priority?: string;
  sourceNotePaths: string[];
  notePath: string;
}

interface MnemonGraphMemoryRow {
  id: string;
  layer: string;
  title?: string;
  content: string;
  sourceFile?: string;
  createdAt: string;
  confidence: number;
  importance: number;
  entityType?: string;
  entityName?: string;
}

interface MnemonGraphNode {
  id: string;
  kind: 'system' | 'layer' | 'entity' | 'memory' | 'source';
  label: string;
  importance?: number;
}

interface MnemonGraphEdge {
  from: string;
  to: string;
  label?: string;
}

interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

type ProvenanceEventKind =
  | 'capture'
  | 'classification'
  | 'attention_score'
  | 'coaching_prompt'
  | 'memory_promotion'
  | 'memory_hygiene'
  | 'memory_graph'
  | 'project_ontology'
  | 'project_status'
  | 'wiki_update'
  | 'queue_created'
  | 'queue_progress'
  | 'bridge_execution'
  | 'dashboard'
  | 'context_index';

interface ProvenanceEventInput {
  id: string;
  kind: ProvenanceEventKind;
  title: string;
  summary?: string;
  sourcePaths?: string[];
  outputPaths?: string[];
  metadata?: Record<string, string | number | boolean | string[] | undefined>;
}

let tokenEncoder: Tiktoken | undefined;

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function parts(date: Date): { day: string; month: string; year: string; hour: string; minute: string } {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Singapore',
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => fmt.find((p) => p.type === type)?.value ?? '00';
  return { day: get('day'), month: get('month'), year: get('year'), hour: get('hour'), minute: get('minute') };
}

function timestamp(date = new Date()): string {
  const p = parts(date);
  return `${p.day}-${p.month}-${p.year}, ${p.hour}:${p.minute}`;
}

function indexTimestamp(date = new Date()): string {
  return timestamp(date);
}

function slug(input: string): string {
  const s = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .replace(/_/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
    .replace(/-$/g, '');
  return s || 'note';
}

function filename(date: Date, rawSlug: string): string {
  const p = parts(date);
  return `${p.day}-${p.month}-${p.year}-${p.hour}${p.minute}-${slug(rawSlug)}.md`;
}

function truncateText(text: string, maxChars: number): string {
  const compact = text
    .replace(/\u0000/g, '')
    .replace(/\r\n/g, '\n')
    .trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function scrubPrivateText(input: string): string {
  return input
    .replace(/\b\d{8,15}@s\.whatsapp\.net\b/gi, '[REDACTED_WHATSAPP_JID]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
    .replace(/\b(?:sk|sk-proj)-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_API_KEY]')
    .replace(/\b(?:OPENAI_API_KEY|API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|PASSWORD)\s*=\s*['"]?[^'"\s]+/gi, (match) => {
      const key = match.split('=')[0]?.trim() || 'SECRET';
      return `${key}=[REDACTED_SECRET]`;
    })
    .replace(/\+\d{1,3}(?:[\s-]?\d){6,14}\b/g, '[REDACTED_PHONE]')
    .replace(/\/Users\/[^/\s)]+/g, '/Users/<username>');
}

const PROJECT_SIGNAL_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'AIME', pattern: /\b(?:aime|office of ai-enhanced medical education|ai-enhanced medical education)\b/i },
  { label: 'p(AI)tient', pattern: /\bp\s*\(\s*ai\s*\)\s*tient\b|\bpai\s*tient\b/i },
  { label: 'CORTEX', pattern: /\bcortex\b/i },
  { label: 'CREATE Hackathon', pattern: /\bcreate\s+hackathon\b/i },
  { label: 'grants', pattern: /\bgrant|funding|proposal\b/i },
  { label: 'papers and manuscripts', pattern: /\bpaper|manuscript|publication|reviewer|revision\b/i },
  { label: 'workshops and talks', pattern: /\bworkshop|talk|presentation|deck|lecture\b/i },
  { label: 'AI-enhanced assessment', pattern: /\bassessment|exam|osce|mcq|psychometric\b/i },
  { label: 'productive struggle', pattern: /\bproductive struggle\b/i },
  { label: 'discernment', pattern: /\bdiscernment\b/i },
  { label: 'uncertainty tolerance', pattern: /\buncertainty tolerance|adaptive expertise\b/i },
  { label: 'wisdom', pattern: /\bwisdom\b/i },
  { label: 'education strategy and governance', pattern: /\bgovernance|strategy|transformation office\b/i },
];

function projectSignals(text: string): string[] {
  const signals: string[] = [];
  for (const { label, pattern } of PROJECT_SIGNAL_PATTERNS) {
    if (pattern.test(text) && !signals.includes(label)) signals.push(label);
  }
  return signals;
}

function attentionMarkdownLines(metadata: AttentionMetadata): string[] {
  return [
    '## Attention metadata',
    `Importance: ${metadata.importance}`,
    `Durability: ${metadata.durability}`,
    `Actionability: ${metadata.actionability}`,
    `Time sensitivity: ${metadata.timeSensitivity}`,
    `Project signals: ${metadata.projectSignals.length > 0 ? metadata.projectSignals.join('; ') : 'None detected'}`,
    `Rationale: ${metadata.rationale}`,
  ];
}

function ensureAttentionMarkdown(markdown: string, metadata: AttentionMetadata): string {
  const trimmed = markdown.trimEnd();
  if (/^## Attention metadata\b/m.test(trimmed)) return `${trimmed}\n`;
  return `${trimmed}\n\n${attentionMarkdownLines(metadata).join('\n')}\n`;
}

function hasClearActionSignal(text: string, type: MessageType): boolean {
  return (
    type === 'action_request' ||
    /\b(next action|todo|to do|please|draft|write|prepare|create|make|queue|handoff|follow up|send to codex|research|turn this into)\b/i.test(
      text,
    )
  );
}

export function scoreAttention(text: string, type: MessageType, temporal?: TemporalMetadata): AttentionMetadata {
  if (SENSITIVE_RE.test(text) || PROHIBITED_CONTEXT_RE.test(text) || type === 'sensitive_data_warning') {
    return {
      importance: 'low',
      durability: 'blocked',
      actionability: 'none',
      timeSensitivity: 'none',
      projectSignals: [],
      rationale: 'Blocked from promotion because the content appears to contain prohibited sensitive material.',
    };
  }

  const signals = projectSignals(text);
  const reasons: string[] = [];
  let score = 0;
  if (type === 'decision') {
    score += 3;
    reasons.push('decision');
  }
  if (
    type === 'durable_memory_candidate' ||
    /\b(remember|important to remember|standing rule|from now on)\b/i.test(text)
  ) {
    score += 3;
    reasons.push('durable-memory signal');
  }
  if (type === 'forget_or_correction_request' || /\b(changed my mind|obsolete|correction)\b/i.test(text)) {
    score += 2;
    reasons.push('correction signal');
  }
  if (type === 'weekly_synthesis_request') {
    score += 2;
    reasons.push('synthesis request');
  }
  if (hasClearActionSignal(text, type)) {
    score += 1;
    reasons.push('actionable request');
  }
  if (
    (temporal?.deadlineCandidates.length ?? 0) > 0 ||
    /\b(deadline|due|submit by|decide by|review by)\b/i.test(text)
  ) {
    score += 2;
    reasons.push('deadline or dated follow-up');
  } else if (
    (temporal?.mentionedDates.length ?? 0) > 0 ||
    /\b(upcoming|meeting|milestone|launch|starts?|starting)\b/i.test(text)
  ) {
    score += 1;
    reasons.push('time signal');
  }
  if (signals.length > 0) {
    score += 1;
    reasons.push(`project signal: ${signals.slice(0, 3).join(', ')}`);
  }

  const durability: AttentionDurability =
    type === 'decision' ||
    type === 'durable_memory_candidate' ||
    type === 'forget_or_correction_request' ||
    /\b(always|never|preference|prefer|default|standing rule|from now on|remember that|changed my mind)\b/i.test(text)
      ? 'durable'
      : signals.length > 0 || type === 'reflection' || type === 'weekly_synthesis_request'
        ? 'useful'
        : 'transient';
  const actionability: AttentionActionability = hasClearActionSignal(text, type)
    ? 'clear_action'
    : /\b(open question|risk|should|need to|follow up)\b/i.test(text) || (temporal?.deadlineCandidates.length ?? 0) > 0
      ? 'possible'
      : 'none';
  const timeSensitivity: AttentionTimeSensitivity =
    (temporal?.deadlineCandidates.length ?? 0) > 0 || /\b(deadline|due|submit by|decide by|review by)\b/i.test(text)
      ? 'deadline'
      : (temporal?.mentionedDates.length ?? 0) > 0 ||
          /\b(upcoming|meeting|milestone|launch|starts?|starting)\b/i.test(text)
        ? 'soon'
        : 'none';
  const importance: AttentionImportance = score >= 4 ? 'high' : score >= 2 ? 'medium' : 'low';

  return {
    importance,
    durability,
    actionability,
    timeSensitivity,
    projectSignals: signals,
    rationale: reasons.length > 0 ? reasons.join('; ') : 'ordinary capture with no durable or urgent signal detected',
  };
}

function reflectionCoachingPrompt(
  text: string,
  type: MessageType,
  attention = scoreAttention(text, type),
): string | undefined {
  if (type === 'sensitive_data_warning') return 'Please resend a redacted version before I process this.';
  if (type === 'decision') return 'What evidence or change would make you revisit this decision?';
  if (type === 'action_request')
    return 'What would a good finished output look like, and where should Codex or the action bridge work?';
  if (type === 'forget_or_correction_request')
    return 'What old belief or memory should this supersede, and what should replace it?';
  if (attention.actionability === 'possible') {
    return 'Is there a concrete next action here, or should I keep this as thinking material for now?';
  }
  if (attention.durability === 'useful' && attention.importance !== 'high') {
    return 'Is this a durable pivot I should remember, or just a useful reflection to keep in Markdown?';
  }
  if (type === 'reflection' && !/[?]/.test(text)) {
    return 'What is the decision, tension, or open question at the heart of this reflection?';
  }
  return undefined;
}

function ensureCaptureMetadataMarkdown(
  markdown: string,
  temporal: TemporalMetadata,
  attention: AttentionMetadata,
): string {
  return ensureAttentionMarkdown(ensureTemporalMarkdown(markdown, temporal), attention);
}

function decodeHtmlEntities(input: string): string {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };
  return input
    .replace(/&#x([0-9a-f]+);/gi, (match, value: string) => {
      const codePoint = parseInt(value, 16);
      return Number.isFinite(codePoint) && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
    })
    .replace(/&#(\d+);/g, (match, value: string) => {
      const codePoint = parseInt(value, 10);
      return Number.isFinite(codePoint) && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
    })
    .replace(/&([a-z]+);/gi, (match, value: string) => named[value.toLowerCase()] ?? match);
}

function stripHtml(input: string): string {
  return decodeHtmlEntities(
    input
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeHostnameForPolicy(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '');
}

function isPrivateIPv4(address: string): boolean {
  const octets = address.split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

function isPrivateIPv6(address: string): boolean {
  const lower = normalizeHostnameForPolicy(address);
  const mappedV4 = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mappedV4) return isPrivateIPv4(mappedV4);
  return (
    lower === '::' || lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || /^fe[89ab]/.test(lower)
  );
}

function isBlockedHostname(hostname: string): boolean {
  const host = normalizeHostnameForPolicy(hostname);
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host === 'host.docker.internal' ||
    host === 'metadata.google.internal'
  );
}

function isPrivateAddress(address: string): boolean {
  const host = normalizeHostnameForPolicy(address);
  const version = isIP(host);
  if (version === 4) return isPrivateIPv4(host);
  if (version === 6) return isPrivateIPv6(host);
  return false;
}

function hasSecretLikeQuery(url: URL): boolean {
  for (const key of url.searchParams.keys()) {
    if (/\b(api[_-]?key|access[_-]?token|auth[_-]?token|password|secret|session[_-]?token)\b/i.test(key)) {
      return true;
    }
  }
  return false;
}

async function assertPublicHttpUrl(input: string): Promise<URL> {
  const raw = decodeHtmlEntities(input).trim();
  if (!raw) throw new Error('URL is required');
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Only public http(s) URLs are supported: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error('Refusing URL with embedded credentials');
  }
  if (hasSecretLikeQuery(url)) {
    throw new Error('Refusing URL that appears to contain a secret-bearing query parameter');
  }
  const hostname = normalizeHostnameForPolicy(url.hostname);
  if (isBlockedHostname(hostname) || isPrivateAddress(hostname)) {
    throw new Error(`Refusing private or local URL host: ${hostname}`);
  }
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error(`Could not resolve public URL host: ${hostname}`);
  const blocked = addresses.find((address) => isPrivateAddress(address.address));
  if (blocked) {
    throw new Error(`Refusing URL host that resolves to a private or local address: ${hostname}`);
  }
  return url;
}

async function fetchText(
  url: string | URL,
  maxChars = MAX_WEB_RESPONSE_CHARS,
): Promise<{ text: string; status: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEB_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url.toString(), {
      headers: { 'User-Agent': WEB_USER_AGENT, Accept: 'text/html,text/plain,application/xhtml+xml,*/*;q=0.8' },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} while fetching ${url.toString()}`);
    if (!response.body) {
      return { text: truncateText(await response.text(), maxChars), status: response.status };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length > maxChars) {
        await reader.cancel();
        text = text.slice(0, maxChars);
        break;
      }
    }
    text += decoder.decode();
    return { text: text.trim(), status: response.status };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeDuckDuckGoHref(href: string): string | undefined {
  try {
    const decoded = decodeHtmlEntities(href).trim();
    if (!decoded) return undefined;
    const withProtocol = decoded.startsWith('//') ? `https:${decoded}` : decoded;
    const url = new URL(withProtocol, 'https://duckduckgo.com');
    const host = normalizeHostnameForPolicy(url.hostname);
    if (host === 'duckduckgo.com' || host.endsWith('.duckduckgo.com')) {
      const redirected = url.searchParams.get('uddg');
      return redirected ? decodeHtmlEntities(redirected) : undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function isLikelyAdOrTrackingUrl(input: string): boolean {
  try {
    const url = new URL(input);
    const host = normalizeHostnameForPolicy(url.hostname);
    return (
      host === 'duckduckgo.com' ||
      host.endsWith('.duckduckgo.com') ||
      (host.endsWith('bing.com') && url.pathname.includes('/aclick')) ||
      url.searchParams.has('ad_domain')
    );
  } catch {
    return true;
  }
}

function parseDuckDuckGoResults(html: string): WebSearchResult[] {
  const anchorRe = /<a\b[^>]*class=["'][^"']*\bresult__a\b[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const anchors = Array.from(html.matchAll(anchorRe));
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < anchors.length; i++) {
    const match = anchors[i];
    const href = normalizeDuckDuckGoHref(match[1]);
    if (!href || isLikelyAdOrTrackingUrl(href) || seen.has(href)) continue;
    const title = stripHtml(match[2]);
    if (!title) continue;
    const end = (match.index ?? 0) + match[0].length;
    const next = anchors[i + 1]?.index ?? end + 2_500;
    const segment = html.slice(end, Math.min(next, end + 2_500));
    const snippetMatch = segment.match(
      /<[^>]*class=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div|span)>/i,
    );
    const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : '';
    seen.add(href);
    results.push({ title, url: href, snippet });
  }
  return results;
}

function jinaReaderUrl(url: URL): string {
  if (url.protocol === 'http:') return `https://r.jina.ai/http://${url.host}${url.pathname}${url.search}`;
  return `https://r.jina.ai/http://${url.toString()}`;
}

function extractWebTitle(text: string, fallbackUrl: URL): string {
  const fromReader = text.match(/^Title:\s*(.+)$/m)?.[1]?.trim();
  if (fromReader) return fromReader;
  const fromHeading = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (fromHeading) return fromHeading;
  return fallbackUrl.hostname;
}

async function publicWebSearch(query: string, limit: number): Promise<WebSearchResult[]> {
  const searchUrl = new URL('https://html.duckduckgo.com/html/');
  searchUrl.searchParams.set('q', query);
  const { text } = await fetchText(searchUrl, MAX_WEB_RESPONSE_CHARS);
  const candidates = parseDuckDuckGoResults(text);
  const results: WebSearchResult[] = [];
  for (const candidate of candidates) {
    if (results.length >= limit) break;
    try {
      const url = await assertPublicHttpUrl(candidate.url);
      results.push({ ...candidate, url: url.toString() });
    } catch {
      // Skip non-public, malformed, or blocked results.
    }
  }
  return results;
}

async function readPublicWebPage(
  input: string,
  maxChars: number,
): Promise<{ title: string; url: string; text: string }> {
  const target = await assertPublicHttpUrl(input);
  try {
    const reader = jinaReaderUrl(target);
    const { text } = await fetchText(reader, Math.min(MAX_WEB_RESPONSE_CHARS, maxChars + 8_000));
    const clean = truncateText(text, maxChars);
    if (clean) return { title: extractWebTitle(clean, target), url: target.toString(), text: clean };
  } catch {
    // Fall back to direct HTML/text fetching when the reader endpoint cannot parse a page.
  }

  const { text } = await fetchText(target, Math.min(MAX_WEB_RESPONSE_CHARS, maxChars + 8_000));
  const htmlTitle = decodeHtmlEntities(text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim();
  const clean = truncateText(stripHtml(text), maxChars);
  return { title: htmlTitle || extractWebTitle(clean, target), url: target.toString(), text: clean };
}

function estimateTokens(text: string): number {
  try {
    tokenEncoder ??= getEncoding('cl100k_base');
    return tokenEncoder.encode(text).length;
  } catch {
    return Math.ceil(text.length / 4);
  }
}

function extractHeadings(text: string): string[] {
  const headings: string[] = [];
  for (const line of text.split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const markdownHeading = trimmed.match(/^#{1,6}\s+(.+)$/);
    const candidate = markdownHeading ? markdownHeading[1].trim() : trimmed;
    if (candidate.length < 4 || candidate.length > 160) continue;
    if (!headings.includes(candidate)) headings.push(candidate);
    if (headings.length >= 8) break;
  }
  return headings;
}

function classify(text: string): MessageType {
  const t = text.trim();
  const lower = t.toLowerCase();
  if (!t) return 'unclear';
  if (lower.startsWith('/reflect')) return 'reflection';
  if (lower.startsWith('/decision')) return 'decision';
  if (lower.startsWith('/note')) return 'general_note';
  if (lower.startsWith('/remember')) return 'durable_memory_candidate';
  if (lower.startsWith('/forget')) return 'forget_or_correction_request';
  if (lower.startsWith('/weekly')) return 'weekly_synthesis_request';
  if (lower.startsWith('/ask')) return 'question';
  if (SENSITIVE_RE.test(t)) return 'sensitive_data_warning';
  if (/^(decision|decided)\s*:/i.test(t) || /\b(i|we)\s+(have\s+)?decided\b/i.test(t)) return 'decision';
  if (/^\s*(remember|please remember)\b/i.test(t)) return 'durable_memory_candidate';
  if (/^\s*(forget|correct|correction)\b/i.test(t)) return 'forget_or_correction_request';
  if (
    /\b(summarise|summarize)\s+my\s+week\b/i.test(t) ||
    /\b(?:weekly|monthly)\s+(review|synthesis|summary)\b/i.test(t) ||
    /\b(stale open questions|changed my mind|decision log review)\b/i.test(t)
  )
    return 'weekly_synthesis_request';
  if (/^\s*(draft|write|prepare|turn this into|make this into)\b/i.test(t)) return 'action_request';
  if (/\?$/.test(t) || /^\s*(what|why|how|when|where|which|who|list|show)\b/i.test(t)) return 'question';
  if (
    /\b(today|this morning|this afternoon|this evening|i realised|i realized|i noticed|i think|i wonder|i am starting to think)\b/i.test(
      t,
    )
  )
    return 'reflection';
  return 'general_note';
}

function normalizeMessageType(input: unknown, text: string): MessageType {
  return MESSAGE_TYPES.includes(input as MessageType) ? (input as MessageType) : classify(text);
}

function rootPath(explicit?: unknown): string {
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  for (const candidate of ROOT_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Second-brain root is not mounted. Mount the selected Dropbox folder at ${ROOT_CANDIDATES[0]} or ${ROOT_CANDIDATES[1]}.`,
  );
}

function sourceContextRoots(): Array<{ label: string; root: string }> {
  return SOURCE_CONTEXT_ROOTS.filter((candidate) => fs.existsSync(candidate.path)).map((candidate) => ({
    label: candidate.label,
    root: requireRoot(candidate.path),
  }));
}

function searchRoots(explicit?: unknown): Array<{ label: string; root: string }> {
  if (typeof explicit === 'string' && explicit.trim()) {
    return [{ label: 'custom', root: requireRoot(explicit.trim()) }];
  }

  const roots: Array<{ label: string; root: string }> = [];
  try {
    roots.push({ label: 'second-brain', root: requireRoot(rootPath()) });
  } catch {
    // Source context can still be searched if the writable folder is absent.
  }
  roots.push(...sourceContextRoots());
  if (roots.length === 0) {
    throw new Error(
      `No Distributed Cognition context roots are mounted. Mount the second-brain folder at ${ROOT_CANDIDATES[0]} or selected context folders under /workspace/extra/context-*.`,
    );
  }
  return roots;
}

function requireRoot(root: string): string {
  const real = fs.realpathSync(root);
  if (!fs.statSync(real).isDirectory()) throw new Error(`Second-brain root is not a directory: ${root}`);
  return real;
}

function ensureFolders(root: string): void {
  const real = requireRoot(root);
  for (const folder of SECOND_BRAIN_FOLDERS) fs.mkdirSync(path.join(real, folder), { recursive: true });
}

function resolveNotePath(root: string, folder: SecondBrainFolder, file: string): string {
  if (!SECOND_BRAIN_FOLDERS.includes(folder)) throw new Error(`Unsupported folder: ${folder}`);
  if (!file || file !== path.basename(file) || file.includes('/') || file.includes('\\')) {
    throw new Error(`Unsafe filename: ${file}`);
  }
  if (!/^\d{2}-\d{2}-\d{2}-\d{4}-[a-z0-9-]+\.md$/.test(file)) {
    throw new Error(`Filename must follow DD-MM-YY-HHMM-short-slug.md: ${file}`);
  }
  const real = requireRoot(root);
  const target = path.resolve(real, folder, file);
  const rel = path.relative(real, target);
  if (rel.startsWith('..') || path.isAbsolute(rel))
    throw new Error(`Refusing to write outside second-brain root: ${target}`);
  return target;
}

function toRelativeDisplayPath(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join('/');
}

function assertInsideRoot(root: string, target: string): void {
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Refusing to read outside second-brain root: ${target}`);
  }
}

function isBlockedContextPath(filePath: string): boolean {
  const normalized = filePath.split(path.sep).join('/').toLowerCase();
  return (
    BLOCKED_CONTEXT_PATH_PATTERNS.some((pattern) => normalized.includes(pattern)) ||
    BLOCKED_CONTEXT_PATH_REGEXES.some((pattern) => pattern.test(normalized))
  );
}

function isReadableContextExtension(filePath: string): boolean {
  return CONTEXT_READ_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isTextContextExtension(filePath: string): boolean {
  return CONTEXT_TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isExtractableContextExtension(filePath: string): boolean {
  return CONTEXT_EXTRACT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function resolveContextPath(root: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('\0')) {
    throw new Error(`Unsafe context path: ${relativePath}`);
  }
  const realRoot = requireRoot(root);
  const target = path.resolve(realRoot, relativePath);
  assertInsideRoot(realRoot, target);
  const realTarget = fs.realpathSync(target);
  assertInsideRoot(realRoot, realTarget);
  if (!fs.statSync(realTarget).isFile()) throw new Error(`Context path is not a file: ${relativePath}`);
  if (isBlockedContextPath(realTarget)) throw new Error(`Context path is blocked by safety policy: ${relativePath}`);
  if (!isReadableContextExtension(realTarget)) {
    throw new Error(`Unsupported context file type: ${relativePath}`);
  }
  return realTarget;
}

function resolveContextReference(relativePath: string, explicitRoot?: unknown): { root: string; filePath: string } {
  if (typeof explicitRoot === 'string' && explicitRoot.trim()) {
    const root = requireRoot(explicitRoot.trim());
    const labeled = relativePath.match(/^([a-z0-9-]+):(.*)$/i);
    return { root, filePath: resolveContextPath(root, labeled ? labeled[2] : relativePath) };
  }

  const labeled = relativePath.match(/^([a-z0-9-]+):(.*)$/i);
  if (labeled) {
    const [, label, rest] = labeled;
    const match = searchRoots().find((candidate) => candidate.label === label);
    if (!match) throw new Error(`Unknown context root label: ${label}`);
    return { root: match.root, filePath: resolveContextPath(match.root, rest) };
  }

  const root = requireRoot(rootPath());
  return { root, filePath: resolveContextPath(root, relativePath) };
}

function normalizeFolders(input: unknown): string[] {
  if (!Array.isArray(input)) return ['.'];
  const folders = input.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean);
  return folders.length > 0 ? folders : ['.'];
}

function resolveSearchFolders(root: string, input: unknown): string[] {
  const realRoot = requireRoot(root);
  return normalizeFolders(input).map((folder) => {
    if (path.isAbsolute(folder) || folder.includes('\0')) throw new Error(`Unsafe context folder: ${folder}`);
    const target = path.resolve(realRoot, folder);
    assertInsideRoot(realRoot, target);
    const realTarget = fs.realpathSync(target);
    assertInsideRoot(realRoot, realTarget);
    if (!fs.statSync(realTarget).isDirectory()) throw new Error(`Context folder is not a directory: ${folder}`);
    return realTarget;
  });
}

function walkTextFiles(root: string, folders: string[]): string[] {
  const realRoot = requireRoot(root);
  const files: string[] = [];
  const stack = [...folders];
  while (stack.length > 0 && files.length < MAX_CONTEXT_FILES) {
    const current = stack.pop()!;
    assertInsideRoot(realRoot, current);
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const entryPath = path.join(current, entry.name);
      assertInsideRoot(realRoot, entryPath);
      if (isBlockedContextPath(entryPath)) continue;
      if (entry.isDirectory()) {
        if (SKIPPED_CONTEXT_DIRS.has(entry.name.toLowerCase())) continue;
        stack.push(entryPath);
      } else if (entry.isFile() && CONTEXT_TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        const size = fs.statSync(entryPath).size;
        if (size > 0 && size <= MAX_CONTEXT_FILE_BYTES) files.push(entryPath);
      }
      if (files.length >= MAX_CONTEXT_FILES) break;
    }
  }
  return files;
}

async function globContextFiles(root: string, folders: string[], maxFiles: number): Promise<string[]> {
  const realRoot = requireRoot(root);
  const patterns = folders.map((folder) => {
    assertInsideRoot(realRoot, folder);
    const rel = toRelativeDisplayPath(realRoot, folder);
    return rel === '' || rel === '.' ? '**/*' : `${fg.escapePath(rel)}/**/*`;
  });
  const entries = await fg(patterns, {
    cwd: realRoot,
    absolute: true,
    onlyFiles: true,
    dot: false,
    followSymbolicLinks: false,
    unique: true,
    suppressErrors: true,
    ignore: ['**/.*/**', ...Array.from(SKIPPED_CONTEXT_DIRS).map((dir) => `**/${dir}/**`)],
  });
  return entries
    .map((entry) => path.resolve(entry))
    .filter((entry) => {
      assertInsideRoot(realRoot, entry);
      return !isBlockedContextPath(entry) && isReadableContextExtension(entry);
    })
    .slice(0, maxFiles);
}

function readFileStartUtf8(filePath: string, maxBytes: number): string {
  const stat = fs.statSync(filePath);
  const length = Math.min(stat.size, maxBytes);
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buffer, 0, length, 0);
    return buffer.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

async function extractOfficeText(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.docx') {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  }

  const ast = await parseOffice(filePath, {
    extractAttachments: false,
    ocr: false,
    ignoreNotes: true,
    includeRawContent: false,
  });
  const converted = await ast.to('text');
  const value = converted?.value;
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  if (typeof ast.toText === 'function') return ast.toText();
  return '';
}

async function readContextFileText(
  filePath: string,
  maxBytes = MAX_CONTEXT_EXTRACT_BYTES,
): Promise<{ text: string; extracted: boolean }> {
  const stat = fs.statSync(filePath);
  if (stat.size > maxBytes) {
    throw new Error(`Context file is too large to extract safely (${stat.size} bytes): ${path.basename(filePath)}`);
  }
  let result: { text: string; extracted: boolean };
  if (isTextContextExtension(filePath)) {
    result = {
      text: readFileStartUtf8(filePath, Math.min(maxBytes, Math.max(MAX_CONTEXT_FILE_BYTES, maxBytes))),
      extracted: false,
    };
  } else if (isExtractableContextExtension(filePath)) {
    result = { text: await extractOfficeText(filePath), extracted: true };
  } else {
    throw new Error(`Unsupported context file type: ${filePath}`);
  }
  if (PROHIBITED_CONTEXT_RE.test(result.text)) {
    throw new Error('Context file appears to contain prohibited sensitive, HR, exam, or confidential content.');
  }
  return result;
}

function contextIndexPaths(indexRoot: string): { dir: string; entries: string; manifest: string } {
  const realRoot = requireRoot(indexRoot);
  const dir = path.resolve(realRoot, CONTEXT_INDEX_DIR);
  assertInsideRoot(realRoot, dir);
  return {
    dir,
    entries: path.join(dir, CONTEXT_INDEX_FILE),
    manifest: path.join(dir, CONTEXT_INDEX_MANIFEST),
  };
}

function provenanceLogPath(root: string): string {
  return path.join(contextIndexPaths(root).dir, 'events.jsonl');
}

function appendProvenanceEvent(root: string, event: ProvenanceEventInput): void {
  const realRoot = requireRoot(root);
  const paths = contextIndexPaths(realRoot);
  fs.mkdirSync(paths.dir, { recursive: true });
  const cleanMetadata: Record<string, string | number | boolean | string[] | undefined> = {};
  for (const [key, value] of Object.entries(event.metadata ?? {})) {
    cleanMetadata[key] = Array.isArray(value)
      ? value.map((item) => scrubPrivateText(item))
      : typeof value === 'string'
        ? scrubPrivateText(value)
        : value;
  }
  fs.appendFileSync(
    provenanceLogPath(realRoot),
    `${JSON.stringify({
      version: 1,
      timestamp: timestamp(new Date()),
      id: scrubPrivateText(event.id),
      kind: event.kind,
      title: scrubPrivateText(event.title),
      summary: event.summary ? scrubPrivateText(event.summary) : undefined,
      sourcePaths: (event.sourcePaths ?? []).map((item) => scrubPrivateText(item.replace(/\\/g, '/'))),
      outputPaths: (event.outputPaths ?? []).map((item) => scrubPrivateText(item.replace(/\\/g, '/'))),
      metadata: cleanMetadata,
    })}\n`,
  );
}

function readProvenanceEvents(
  root: string,
  limit = 200,
): Array<{
  timestamp?: string;
  kind?: string;
  title?: string;
  summary?: string;
  sourcePaths?: string[];
  outputPaths?: string[];
}> {
  const filePath = provenanceLogPath(root);
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf-8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-Math.max(1, Math.min(1_000, limit)))
    .map((line) => {
      try {
        return JSON.parse(line) as {
          timestamp?: string;
          kind?: string;
          title?: string;
          summary?: string;
          sourcePaths?: string[];
          outputPaths?: string[];
        };
      } catch {
        return { title: 'Unreadable provenance event' };
      }
    });
}

function resolveIndexRoot(explicit?: unknown): string {
  if (typeof explicit === 'string' && explicit.trim()) return requireRoot(explicit.trim());
  return requireRoot(rootPath());
}

function loadContextIndex(
  indexRoot?: unknown,
): { entries: ContextIndexEntry[]; manifest?: ContextIndexManifest } | undefined {
  const root = resolveIndexRoot(indexRoot);
  const paths = contextIndexPaths(root);
  if (!fs.existsSync(paths.entries)) return undefined;
  const entries = fs
    .readFileSync(paths.entries, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ContextIndexEntry)
    .filter((entry) => entry.version === CONTEXT_INDEX_VERSION);
  const manifest = fs.existsSync(paths.manifest)
    ? (JSON.parse(fs.readFileSync(paths.manifest, 'utf8')) as ContextIndexManifest)
    : undefined;
  return { entries, manifest };
}

async function buildContextIndexData(args: {
  folders?: unknown;
  root?: unknown;
  indexRoot?: unknown;
  maxFiles?: unknown;
  maxPreviewChars?: unknown;
}): Promise<{
  entries: ContextIndexEntry[];
  manifest: ContextIndexManifest;
  paths: { dir: string; entries: string; manifest: string };
}> {
  const maxFiles = Math.min(
    MAX_INDEX_LIMIT,
    Math.max(
      1,
      typeof args.maxFiles === 'number' && Number.isFinite(args.maxFiles)
        ? Math.floor(args.maxFiles)
        : DEFAULT_INDEX_LIMIT,
    ),
  );
  const maxPreviewChars = Math.min(
    MAX_INDEX_PREVIEW_CHARS,
    Math.max(
      500,
      typeof args.maxPreviewChars === 'number' && Number.isFinite(args.maxPreviewChars)
        ? Math.floor(args.maxPreviewChars)
        : DEFAULT_INDEX_PREVIEW_CHARS,
    ),
  );
  const indexRoot = resolveIndexRoot(args.indexRoot);
  const paths = contextIndexPaths(indexRoot);
  const roots = searchRoots(args.root);
  const entries: ContextIndexEntry[] = [];
  const skipped: ContextIndexManifest['skipped'] = [];

  for (const searchRoot of roots) {
    const folders = resolveSearchFolders(searchRoot.root, args.folders);
    const remaining = maxFiles - entries.length;
    if (remaining <= 0) break;
    const filePaths = await globContextFiles(searchRoot.root, folders, remaining);
    for (const filePath of filePaths) {
      if (entries.length >= maxFiles) break;
      const relative = toRelativeDisplayPath(searchRoot.root, filePath);
      try {
        const stat = fs.statSync(filePath);
        const { text, extracted } = await readContextFileText(filePath, MAX_CONTEXT_EXTRACT_BYTES);
        const preview = truncateText(text, maxPreviewChars);
        if (!preview) {
          skipped.push({ label: searchRoot.label, path: relative, reason: 'empty extracted text' });
          continue;
        }
        if (PROHIBITED_CONTEXT_RE.test(preview)) {
          skipped.push({
            label: searchRoot.label,
            path: relative,
            reason: 'prohibited sensitive/HR/exam warning in extracted preview',
          });
          continue;
        }
        entries.push({
          version: CONTEXT_INDEX_VERSION,
          label: searchRoot.label,
          path: relative,
          title: path.basename(filePath),
          extension: path.extname(filePath).toLowerCase(),
          bytes: stat.size,
          modified: indexTimestamp(stat.mtime),
          mtimeMs: stat.mtimeMs,
          tokenEstimate: estimateTokens(preview),
          headings: extractHeadings(preview),
          preview,
          extracted,
        });
      } catch (e) {
        skipped.push({
          label: searchRoot.label,
          path: relative,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  const now = new Date();
  const manifest: ContextIndexManifest = {
    version: CONTEXT_INDEX_VERSION,
    generatedAt: indexTimestamp(now),
    generatedAtMs: now.getTime(),
    roots,
    entries: entries.length,
    skipped,
  };
  return { entries, manifest, paths };
}

function writeContextIndex(
  entries: ContextIndexEntry[],
  manifest: ContextIndexManifest,
  paths: { dir: string; entries: string; manifest: string },
): void {
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.entries, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  fs.writeFileSync(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
}

function bestPreviewSnippet(text: string, terms: string[]): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  const lower = compact.toLowerCase();
  const positions = terms.map((term) => lower.indexOf(term)).filter((position) => position >= 0);
  if (positions.length === 0) return excerpt(compact);
  const start = Math.max(0, Math.min(...positions) - 140);
  return excerpt(compact.slice(start, start + MAX_SNIPPET_CHARS));
}

function scoreIndexEntry(entry: ContextIndexEntry, query: string, terms: string[]): number {
  const pathText = `${entry.label}:${entry.path} ${entry.title}`.toLowerCase();
  const headingText = entry.headings.join(' ').toLowerCase();
  const previewText = entry.preview.toLowerCase();
  let score = pathText.includes(query) ? 12 : 0;
  if (headingText.includes(query)) score += 8;
  if (previewText.includes(query)) score += 5;
  for (const term of terms) {
    if (pathText.includes(term)) score += 4;
    if (headingText.includes(term)) score += 3;
    if (previewText.includes(term)) score += 1;
  }
  return score;
}

function searchContextIndex(args: {
  query: string;
  terms: string[];
  limit: number;
  folders?: unknown;
  indexRoot?: unknown;
}): { text: string; hitCount: number } | undefined {
  const loaded = loadContextIndex(args.indexRoot);
  if (!loaded) return undefined;
  const requestedFolders = normalizeFolders(args.folders).filter((folder) => folder !== '.');
  const hits = loaded.entries
    .map((entry) => ({ entry, score: scoreIndexEntry(entry, args.query, args.terms) }))
    .filter(({ entry, score }) => {
      if (score <= 0) return false;
      if (requestedFolders.length === 0) return true;
      return requestedFolders.some(
        (folder) => entry.path === folder || entry.path.startsWith(`${folder.replace(/\/+$/g, '')}/`),
      );
    })
    .sort((a, b) => b.score - a.score || b.entry.mtimeMs - a.entry.mtimeMs || a.entry.path.localeCompare(b.entry.path))
    .slice(0, args.limit);
  if (hits.length === 0) {
    const generated = loaded.manifest?.generatedAt ? ` Index generated ${loaded.manifest.generatedAt}.` : '';
    return {
      hitCount: 0,
      text: `No context hits for "${args.query}" in the Distributed Cognition context index.${generated} Rebuild the index if the mounted Dropbox folders changed recently.`,
    };
  }
  const generated = loaded.manifest?.generatedAt ? ` Index generated ${loaded.manifest.generatedAt}.` : '';
  return {
    hitCount: hits.length,
    text: [
      `Found ${hits.length} indexed context hit${hits.length === 1 ? '' : 's'} for "${args.query}".${generated}`,
      ...hits.map(({ entry }) =>
        [
          `- ${entry.label}:${entry.path}`,
          `  modified ${entry.modified}; approx ${entry.tokenEstimate} preview tokens; ${entry.extracted ? 'extracted text' : 'text file'}`,
          entry.headings.length > 0 ? `  headings: ${entry.headings.slice(0, 3).join(' | ')}` : undefined,
          `  ${bestPreviewSnippet(entry.preview, args.terms)}`,
        ]
          .filter(Boolean)
          .join('\n'),
      ),
    ].join('\n'),
  };
}

function excerpt(line: string): string {
  const compact = line.replace(/\s+/g, ' ').trim();
  if (compact.length <= MAX_SNIPPET_CHARS) return compact;
  return `${compact.slice(0, MAX_SNIPPET_CHARS - 1)}…`;
}

function scoreLine(line: string, query: string, terms: string[]): number {
  const lower = line.toLowerCase();
  let score = lower.includes(query) ? 5 : 0;
  for (const term of terms) {
    if (lower.includes(term)) score += 1;
  }
  return score;
}

function writeNew(filePath: string, content: string): string {
  try {
    fs.writeFileSync(filePath, content, { flag: 'wx' });
    return filePath;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  const ext = path.extname(filePath);
  const base = filePath.slice(0, -ext.length);
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}${ext}`;
    try {
      fs.writeFileSync(candidate, content, { flag: 'wx' });
      return candidate;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
  throw new Error(`Could not create unique note path for ${filePath}`);
}

function relativeSecondBrainPath(root: string, filePath: string): string {
  return toRelativeDisplayPath(requireRoot(root), filePath);
}

function appendCaptureProvenance(
  root: string,
  input: {
    id: string;
    type: MessageType;
    rawPath: string;
    processedPath: string;
    deadlineWatchPath?: string;
    attention: AttentionMetadata;
    coaching?: string;
  },
): void {
  const outputPaths = [input.rawPath, input.processedPath, input.deadlineWatchPath]
    .filter((value): value is string => Boolean(value))
    .map((filePath) => relativeSecondBrainPath(root, filePath));
  appendProvenanceEvent(root, {
    id: input.id,
    kind: 'capture',
    title: `Captured ${input.type}`,
    summary: 'Captured raw and processed Markdown from WhatsApp.',
    outputPaths,
    metadata: {
      messageType: input.type,
      importance: input.attention.importance,
      durability: input.attention.durability,
      actionability: input.attention.actionability,
      timeSensitivity: input.attention.timeSensitivity,
      projectSignals: input.attention.projectSignals,
    },
  });
  appendProvenanceEvent(root, {
    id: `${input.id}-classification`,
    kind: 'classification',
    title: `Classified as ${input.type}`,
    summary: input.attention.rationale,
    sourcePaths: outputPaths.slice(0, 1),
    outputPaths: outputPaths.slice(1, 2),
    metadata: {
      messageType: input.type,
      importance: input.attention.importance,
      durability: input.attention.durability,
    },
  });
  if (input.coaching) {
    appendProvenanceEvent(root, {
      id: `${input.id}-coaching`,
      kind: 'coaching_prompt',
      title: 'Reflection coaching prompt',
      summary: input.coaching,
      sourcePaths: outputPaths,
      metadata: { messageType: input.type },
    });
  }
}

function processedFolder(type: MessageType): SecondBrainFolder {
  if (type === 'reflection') return 'daily-reflections';
  if (type === 'weekly_synthesis_request') return 'weekly-reviews';
  if (type === 'durable_memory_candidate' || type === 'forget_or_correction_request') return 'pending-review';
  return 'processed-notes';
}

const MONTH_PATTERN =
  'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|sept|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';

function extractTemporalMetadata(text: string, now: Date, type: MessageType): TemporalMetadata {
  const capturedAt = timestamp(now);
  const mentionedDates = extractMentionedDates(text, now);
  const hasDeadlineCue =
    /\b(deadline|due|by|before|after|decide by|submit by|meeting|meet|planned|upcoming|starts?|starting|appointment|transition|launch|milestone|review by)\b/i.test(
      text,
    );
  const deadlineCandidates = hasDeadlineCue ? mentionedDates : [];
  const decisionDate = type === 'decision' ? capturedAt : 'None detected';
  const defaultDecisionReview = `${formatDateWithUnspecifiedTime(addDays(now, 30))} (default decision review)`;
  const reviewAfter = deadlineCandidates[0] ?? (type === 'decision' ? defaultDecisionReview : 'None detected');
  const stalenessStatus =
    deadlineCandidates.length > 0
      ? 'Has dated follow-up candidates; review before the earliest relevant date.'
      : type === 'decision'
        ? 'Fresh decision; review if context changes or by the review date.'
        : 'No review date detected.';

  return { capturedAt, mentionedDates, deadlineCandidates, decisionDate, reviewAfter, stalenessStatus };
}

function extractMentionedDates(text: string, now: Date): string[] {
  const dates: string[] = [];
  const seen = new Set<string>();
  const add = (value: string) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    dates.push(value);
  };

  const exactDate = /\b(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})(?:[,\s]+(?:at\s*)?(\d{1,2}):(\d{2}))?\b/g;
  for (const match of text.matchAll(exactDate)) {
    const day = match[1].padStart(2, '0');
    const month = match[2].padStart(2, '0');
    const year = match[3].slice(-2).padStart(2, '0');
    const time =
      match[4] && match[5] ? `${match[4].padStart(2, '0')}:${match[5].padStart(2, '0')}` : '00:00 (time unspecified)';
    add(`${day}-${month}-${year}, ${time}`);
  }

  const monthPair = new RegExp(`\\b(${MONTH_PATTERN})\\s+and\\s+(${MONTH_PATTERN})\\s+(\\d{4})\\b`, 'gi');
  for (const match of text.matchAll(monthPair)) {
    add(`${normaliseMonthName(match[1])} ${match[3]} (month only; no exact DD-MM-YY, HH:MM supplied)`);
    add(`${normaliseMonthName(match[2])} ${match[3]} (month only; no exact DD-MM-YY, HH:MM supplied)`);
  }

  const monthYear = new RegExp(`\\b(${MONTH_PATTERN})\\s+(\\d{4})\\b`, 'gi');
  for (const match of text.matchAll(monthYear)) {
    add(`${normaliseMonthName(match[1])} ${match[2]} (month only; no exact DD-MM-YY, HH:MM supplied)`);
  }

  if (/\btomorrow\b/i.test(text)) add(`${formatDateWithUnspecifiedTime(addDays(now, 1))} (relative: tomorrow)`);
  if (/\bnext week\b/i.test(text)) add(`${formatDateWithUnspecifiedTime(addDays(now, 7))} (relative: next week)`);
  if (/\bnext month\b/i.test(text)) add(`${formatDateWithUnspecifiedTime(addDays(now, 30))} (relative: next month)`);

  return dates;
}

function normaliseMonthName(input: string): string {
  const lower = input.toLowerCase();
  const map: Record<string, string> = {
    jan: 'January',
    january: 'January',
    feb: 'February',
    february: 'February',
    mar: 'March',
    march: 'March',
    apr: 'April',
    april: 'April',
    may: 'May',
    jun: 'June',
    june: 'June',
    jul: 'July',
    july: 'July',
    aug: 'August',
    august: 'August',
    sep: 'September',
    sept: 'September',
    september: 'September',
    oct: 'October',
    october: 'October',
    nov: 'November',
    november: 'November',
    dec: 'December',
    december: 'December',
  };
  return map[lower] ?? input;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function formatDateWithUnspecifiedTime(date: Date): string {
  const p = parts(date);
  return `${p.day}-${p.month}-${p.year}, 00:00 (time unspecified)`;
}

function temporalMarkdownLines(metadata: TemporalMetadata): string[] {
  return [
    '## Temporal metadata',
    `Captured at: ${metadata.capturedAt}`,
    `Mentioned dates: ${formatTemporalList(metadata.mentionedDates)}`,
    `Deadline candidates: ${formatTemporalList(metadata.deadlineCandidates)}`,
    `Decision date: ${metadata.decisionDate}`,
    `Review after: ${metadata.reviewAfter}`,
    `Staleness status: ${metadata.stalenessStatus}`,
  ];
}

function ensureTemporalMarkdown(markdown: string, metadata: TemporalMetadata): string {
  const trimmed = markdown.trimEnd();
  if (/^## Temporal metadata\b/m.test(trimmed)) return `${trimmed}\n`;
  return `${trimmed}\n\n${temporalMarkdownLines(metadata).join('\n')}\n`;
}

function formatTemporalList(values: string[]): string {
  return values.length > 0 ? values.join('; ') : 'None detected';
}

function appendDeadlineWatch(root: string, metadata: TemporalMetadata, sourceRelativePath: string): string | undefined {
  if (metadata.deadlineCandidates.length === 0) return undefined;
  const realRoot = fs.realpathSync(root);
  const folder = path.join(realRoot, 'open-questions');
  fs.mkdirSync(folder, { recursive: true });
  const watchPath = path.resolve(folder, 'deadline-watch.md');
  const rel = path.relative(realRoot, watchPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Refusing to write outside second-brain root: ${watchPath}`);
  }
  if (!fs.existsSync(watchPath)) {
    fs.writeFileSync(watchPath, '# Deadline Watch\n\n');
  }
  const source = sourceRelativePath.split(path.sep).join('/');
  const title = path.basename(sourceRelativePath, '.md');
  const entry = [
    `## ${metadata.capturedAt} - ${title}`,
    '- Type: deadline candidate',
    `- Due / date mentioned: ${metadata.deadlineCandidates.join('; ')}`,
    `- Source note: ${source}`,
    '- Status: pending review',
    '',
  ].join('\n');
  fs.appendFileSync(watchPath, entry);
  return watchPath;
}

function rawTemplate(
  type: MessageType,
  ts: string,
  body: string,
  source: string,
  temporal: TemporalMetadata,
  attention: AttentionMetadata,
  audioPath?: string,
  sourceMessageId?: string,
): string {
  const lines = [`# Raw WhatsApp Note — ${ts}`, '', '## Source', source, ''];
  if (sourceMessageId) {
    lines.push('## WhatsApp source message id', scrubPrivateText(sourceMessageId), '');
  }
  if (source === 'whatsapp-audio' && audioPath) {
    lines.push('## Audio source path', audioPath, '');
  }
  lines.push(
    '## Inferred message type',
    type,
    '',
    ...temporalMarkdownLines(temporal),
    '',
    ...attentionMarkdownLines(attention),
    '',
    '## Raw note',
    body,
    '',
  );
  return lines.join('\n');
}

function sourceMessageIdFromAudioPath(inputPath: string | undefined): string | undefined {
  const match = inputPath?.match(/\/workspace\/inbox\/([^/\s)]+)\//);
  return match?.[1] ? scrubPrivateText(match[1]) : undefined;
}

function sourceMessageIdFromArgs(args: Record<string, unknown>, inputPath?: string): string | undefined {
  const direct = typeof args.sourceMessageId === 'string' ? args.sourceMessageId.trim() : '';
  if (direct) return scrubPrivateText(direct);

  const seqValue = args.sourceMessageSeq;
  const seq = typeof seqValue === 'number' ? seqValue : typeof seqValue === 'string' ? Number(seqValue) : NaN;
  if (Number.isInteger(seq) && seq > 0) {
    try {
      const resolved = getMessageIdBySeq(seq);
      if (resolved) return scrubPrivateText(resolved);
    } catch {
      // Capture should still work in tests or offline tooling that lacks an open session DB.
    }
  }

  return sourceMessageIdFromAudioPath(inputPath);
}

function template(
  type: MessageType,
  ts: string,
  body: string,
  temporal: TemporalMetadata,
  attention: AttentionMetadata,
): string {
  const triage = mnemonTriage(body, type);
  const coaching = reflectionCoachingPrompt(body, type, attention);
  let markdown: string;
  if (type === 'decision') {
    markdown = [
      `# Decision — ${ts}`,
      '',
      '## Raw decision statement',
      body,
      '',
      '## Decision type',
      'Needs review',
      '',
      '## Project links',
      'Needs review',
      '',
      '## Rationale',
      'Needs review',
      '',
      '## Implications',
      'Needs review',
      '',
      '## Risks',
      'Needs review',
      '',
      '## What would change this decision',
      'Needs review',
      '',
      '## Add to decision log?',
      'Needs review',
      '',
      '## Mnemon triage',
      `Recommendation: ${triage.recommendation}`,
      `Reason: ${triage.reason}`,
      '',
      '## Reflection coaching',
      coaching ?? 'No follow-up needed.',
      '',
    ].join('\n');
  } else if (type === 'weekly_synthesis_request') {
    markdown = [
      `# Synthesis — ${ts}`,
      '',
      '## Trigger',
      body,
      '',
      '## Scope',
      'Needs review',
      '',
      '## Stored facts',
      'Needs review',
      '',
      '## Extracted facts',
      'Needs review',
      '',
      '## Inferred themes',
      'Needs review',
      '',
      '## Decisions or changed-mind notes',
      'Needs review',
      '',
      '## Open questions',
      'Needs review',
      '',
      '## Stale items to revisit',
      'Needs review',
      '',
      '## Suggested next actions',
      'Needs review',
      '',
      '## Candidate permanent updates',
      'Pending review',
      '',
      '## Mnemon triage',
      `Recommendation: ${triage.recommendation}`,
      `Reason: ${triage.reason}`,
      '',
    ].join('\n');
  } else {
    markdown = [
      `# Reflection — ${ts}`,
      '',
      '## Raw reflection',
      body,
      '',
      '## Inferred message type',
      type,
      '',
      '## Project links',
      'Needs review',
      '',
      '## New insight',
      'Needs review',
      '',
      '## Decision made or leaning',
      'Needs review',
      '',
      '## Open questions',
      'Needs review',
      '',
      '## Risks',
      'Needs review',
      '',
      '## Suggested next actions',
      'Needs review',
      '',
      '## Possible paper / grant / talk ideas',
      'Needs review',
      '',
      '## Long-term memory candidate',
      'Unsure',
      '',
      '## Mnemon triage',
      `Recommendation: ${triage.recommendation}`,
      `Reason: ${triage.reason}`,
      '',
      '## Reflection coaching',
      coaching ?? 'No follow-up needed.',
      '',
    ].join('\n');
  }
  return ensureCaptureMetadataMarkdown(markdown, temporal, attention);
}

function mnemonTriage(text: string, type: MessageType): { recommendation: string; reason: string } {
  if (SENSITIVE_RE.test(text) || type === 'sensitive_data_warning') {
    return {
      recommendation: 'Do not store in Mnemon',
      reason: 'The content appears to involve prohibited sensitive data.',
    };
  }
  if (type === 'durable_memory_candidate' && /^\s*\/?remember\b/i.test(text)) {
    return {
      recommendation: 'Auto-store concise Mnemon memory if safe',
      reason: 'the owner explicitly asked Distributed Cognition to remember it.',
    };
  }
  if (type === 'decision') {
    return {
      recommendation: 'Auto-store concise durable decision if safe',
      reason: 'Decisions and durable decision leanings are high-signal if safe and stable.',
    };
  }
  if (type === 'forget_or_correction_request') {
    return {
      recommendation: 'Create auditable correction',
      reason: 'Correction and forget requests should supersede old memory rather than silently overwrite it.',
    };
  }
  if (/\b(always|never|preference|prefer|default|standing rule|from now on|remember that)\b/i.test(text)) {
    return {
      recommendation: 'Auto-store concise standing preference if safe',
      reason: 'This appears to be a durable preference or workflow rule that should affect future behaviour.',
    };
  }
  if (type === 'weekly_synthesis_request') {
    return {
      recommendation: 'Markdown synthesis first',
      reason: 'Promote only stable synthesis outcomes, not the whole review transcript.',
    };
  }
  return {
    recommendation: 'Markdown only',
    reason: 'Keep ordinary reflections and loose thoughts in Dropbox notes unless they become durable.',
  };
}

function normalizeSecondBrainRelativePath(input: string): string {
  const trimmed = input
    .trim()
    .replace(/^second-brain:/, '')
    .replace(/\\/g, '/');
  if (!trimmed || path.isAbsolute(trimmed) || trimmed.includes('\0')) {
    throw new Error(`Unsafe second-brain path: ${input}`);
  }
  const normalized = path.posix.normalize(trimmed);
  if (normalized.startsWith('../') || normalized === '..' || normalized.startsWith('/')) {
    throw new Error(`Refusing to read outside second-brain root: ${input}`);
  }
  return normalized;
}

function firstPathSegment(relativePath: string): string {
  return relativePath.split('/')[0] ?? '';
}

function resolveSecondBrainMarkdown(
  root: string,
  relativePath: string,
  allowedFolders: readonly SecondBrainFolder[] = SECOND_BRAIN_FOLDERS,
): string {
  const normalized = normalizeSecondBrainRelativePath(relativePath);
  const folder = firstPathSegment(normalized);
  if (!allowedFolders.includes(folder as SecondBrainFolder)) {
    throw new Error(`Unsupported second-brain source folder: ${folder}`);
  }
  if (!normalized.endsWith('.md')) throw new Error(`Only Markdown files can be promoted: ${relativePath}`);
  const realRoot = requireRoot(root);
  const target = path.resolve(realRoot, normalized);
  assertInsideRoot(realRoot, target);
  const realTarget = fs.realpathSync(target);
  assertInsideRoot(realRoot, realTarget);
  if (!fs.statSync(realTarget).isFile()) throw new Error(`Second-brain path is not a file: ${relativePath}`);
  return realTarget;
}

function resolvePromotionSource(root: string, relativePath: string): PromotionSource {
  const normalized = normalizeSecondBrainRelativePath(relativePath);
  const folder = firstPathSegment(normalized) as SecondBrainFolder;
  if (!PROMOTION_SOURCE_FOLDERS.includes(folder)) {
    throw new Error(`Unsupported promotion source folder: ${folder}`);
  }
  const filePath = resolveSecondBrainMarkdown(root, normalized, PROMOTION_SOURCE_FOLDERS);
  const content = fs.readFileSync(filePath, 'utf-8');
  if (PROHIBITED_CONTEXT_RE.test(content)) {
    throw new Error(
      `Promotion source appears to contain prohibited sensitive, HR, exam, or confidential content: ${normalized}`,
    );
  }
  return {
    relativePath: normalized,
    filePath,
    folder,
    title: titleFromMarkdown(content, normalized),
    capturedAt: capturedAtFromMarkdown(content, normalized),
    sortKey: sortKeyFromSource(content, normalized, folder),
    content,
  };
}

function readPromotionSources(root: string, sourcePaths: unknown): PromotionSource[] {
  if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) {
    throw new Error('sourcePaths must include at least one second-brain Markdown note');
  }
  const seen = new Set<string>();
  const sources = sourcePaths.map((item) => {
    if (typeof item !== 'string' || !item.trim()) throw new Error('sourcePaths must contain relative Markdown paths');
    const source = resolvePromotionSource(root, item);
    if (seen.has(source.relativePath)) throw new Error(`Duplicate promotion source: ${source.relativePath}`);
    seen.add(source.relativePath);
    return source;
  });
  return sources.sort(
    (a, b) =>
      a.sortKey - b.sortKey ||
      (PROMOTION_FOLDER_RANK.get(a.folder) ?? 99) - (PROMOTION_FOLDER_RANK.get(b.folder) ?? 99) ||
      a.relativePath.localeCompare(b.relativePath),
  );
}

function titleFromMarkdown(markdown: string, fallbackPath: string): string {
  const heading = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || path.basename(fallbackPath, '.md');
}

function capturedAtFromMarkdown(markdown: string, fallbackPath: string): string {
  const explicit = markdown.match(/^Captured at:\s*(.+)$/m)?.[1]?.trim();
  if (explicit) return explicit;
  const fileTs = timestampFromDatedFilename(path.basename(fallbackPath));
  return fileTs ?? 'Unknown';
}

function timestampFromDatedFilename(filenameValue: string): string | undefined {
  const match = filenameValue.match(/^(\d{2})-(\d{2})-(\d{2})-(\d{2})(\d{2})-/);
  if (!match) return undefined;
  return `${match[1]}-${match[2]}-${match[3]}, ${match[4]}:${match[5]}`;
}

function sortKeyFromSource(markdown: string, relativePath: string, folder: SecondBrainFolder): number {
  const fromMetadata = markdown.match(/^Captured at:\s*(\d{2})-(\d{2})-(\d{2}),\s*(\d{2}):(\d{2})/m);
  const fromName = path.basename(relativePath).match(/^(\d{2})-(\d{2})-(\d{2})-(\d{2})(\d{2})-/);
  const partsMatch = fromMetadata
    ? [fromMetadata[3], fromMetadata[2], fromMetadata[1], fromMetadata[4], fromMetadata[5]]
    : fromName
      ? [fromName[3], fromName[2], fromName[1], fromName[4], fromName[5]]
      : undefined;
  const folderRank = PROMOTION_FOLDER_RANK.get(folder) ?? 99;
  if (!partsMatch) return 9_999_999_999 + folderRank;
  const [yy, mm, dd, hh, min] = partsMatch;
  return Number(`20${yy}${mm}${dd}${hh}${min}${String(folderRank).padStart(2, '0')}`);
}

function wikiPageFilename(projectName: string): string {
  return `${wikiSlug(projectName)}.md`;
}

function wikiSlug(projectName: string): string {
  const normalized = projectName
    .replace(/p\s*\(\s*ai\s*\)\s*tient/gi, 'patient')
    .replace(/p\s*ai\s*tient/gi, 'patient');
  return slug(normalized);
}

function resolveProjectWikiPath(
  root: string,
  projectName: string,
  explicitTarget?: unknown,
): { relativePath: string; filePath: string } {
  const realRoot = requireRoot(root);
  const targetRelative =
    typeof explicitTarget === 'string' && explicitTarget.trim()
      ? normalizeSecondBrainRelativePath(explicitTarget.trim())
      : `project-wikis/${wikiPageFilename(projectName)}`;
  if (!targetRelative.startsWith('project-wikis/')) {
    throw new Error(`Project wiki target must live under project-wikis/: ${targetRelative}`);
  }
  const file = targetRelative.slice('project-wikis/'.length);
  if (!file || file.includes('/') || file.includes('\\') || file !== path.basename(file)) {
    throw new Error(`Project wiki target must be a single stable Markdown page: ${targetRelative}`);
  }
  if (!/^[a-z0-9-]+\.md$/.test(file)) {
    throw new Error(`Project wiki filename must be a stable safe slug, e.g. patient.md: ${targetRelative}`);
  }
  const wikiDir = path.join(realRoot, 'project-wikis');
  fs.mkdirSync(wikiDir, { recursive: true });
  const filePath = path.resolve(realRoot, targetRelative);
  assertInsideRoot(realRoot, filePath);
  return { relativePath: targetRelative, filePath };
}

function obsidianLink(relativePath: string, label?: string): string {
  const withoutExt = relativePath.replace(/\.md$/i, '');
  return label ? `[[${withoutExt}|${label}]]` : `[[${withoutExt}]]`;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean);
}

function bulletList(items: string[], empty = 'Needs review'): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : empty;
}

function promotionSectionMarkdown(args: Record<string, unknown>, sourceLinks: string[]): string {
  const proposed = typeof args.proposedWikiMarkdown === 'string' ? args.proposedWikiMarkdown.trim() : '';
  if (proposed) return proposed;
  return [
    '### Current State',
    typeof args.currentState === 'string' && args.currentState.trim() ? args.currentState.trim() : 'Needs review',
    '',
    '### Timeline',
    bulletList(asStringList(args.timeline)),
    '',
    '### Decisions',
    bulletList(asStringList(args.decisions)),
    '',
    '### Open Questions',
    bulletList(asStringList(args.openQuestions)),
    '',
    '### Risks',
    bulletList(asStringList(args.risks)),
    '',
    '### Next Actions',
    bulletList(asStringList(args.nextActions)),
    '',
    '### Sources',
    sourceLinks.map((link) => `- ${link}`).join('\n'),
  ].join('\n');
}

function proposalPathFor(root: string, now: Date, projectName: string): string {
  return resolveNotePath(root, 'pending-review', filename(now, `promotion-${wikiSlug(projectName)}`));
}

function promotionProposalMarkdown(
  args: Record<string, unknown>,
  root: string,
  now: Date,
): { markdown: string; proposalPath: string } {
  const projectName = typeof args.projectName === 'string' ? args.projectName.trim() : '';
  if (!projectName) throw new Error('projectName is required');
  const sources = readPromotionSources(root, args.sourcePaths);
  const target = resolveProjectWikiPath(root, projectName, args.targetWikiPath);
  const ts = timestamp(now);
  const sourceLinks = sources.map((source) => obsidianLink(source.relativePath, source.title));
  const promotionType =
    typeof args.promotionType === 'string' && args.promotionType.trim() ? args.promotionType.trim() : 'wiki_update';
  const mnemonCandidates = asStringList(args.mnemonCandidates);
  const markdown = [
    `# Promotion Proposal — ${projectName} — ${ts}`,
    '',
    '## Status',
    'pending_review',
    '',
    '## Target',
    `- Promotion type: ${promotionType}`,
    `- Project wiki: ${obsidianLink(target.relativePath, projectName)}`,
    `- Target path: ${target.relativePath}`,
    '',
    '## Source Notes',
    ...sources.map(
      (source) =>
        `- ${obsidianLink(source.relativePath, source.title)} — ${source.folder}; captured ${source.capturedAt}; path: ${source.relativePath}`,
    ),
    '',
    '## Source Sorting',
    'Sources are sorted by captured timestamp, then raw/processed/review folder priority, then path. Raw transcripts stay linked as sources; they are not copied into Mnemon or the wiki body.',
    '',
    '## Proposed Wiki Update',
    promotionSectionMarkdown(args, sourceLinks),
    '',
    '## Proposed Mnemon Candidates',
    mnemonCandidates.length > 0
      ? mnemonCandidates.map((candidate) => `- Proposed, not stored: ${candidate}`).join('\n')
      : '- None proposed.',
    '',
    '## Review Checklist',
    '- [ ] Source notes are safe to promote.',
    '- [ ] Private operational/vendor/institutional critique has been redacted or kept out of the wiki body.',
    '- [ ] Decisions are labelled as confirmed, leaning, or deferred.',
    '- [ ] Open questions and next actions are still current.',
    '- [ ] Mnemon candidates are durable and high-signal.',
    '- [ ] The owner explicitly approved applying this proposal.',
    '',
  ].join('\n');
  return { markdown, proposalPath: proposalPathFor(root, now, projectName) };
}

function extractMarkdownSection(markdown: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^## ${escaped}\\s*\\n([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, 'm');
  return markdown.match(pattern)?.[1]?.trim() ?? '';
}

function extractMarkdownSubsection(markdown: string, heading: WikiPromotionSection): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^### ${escaped}\\s*\\n([\\s\\S]*?)(?=^###\\s|^##\\s|(?![\\s\\S]))`, 'm');
  return markdown.match(pattern)?.[1]?.trim() ?? '';
}

function ensureWikiSection(markdown: string, heading: WikiPromotionSection): string {
  if (new RegExp(`^## ${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'm').test(markdown)) return markdown;
  return `${markdown.trimEnd()}\n\n## ${heading}\n`;
}

function appendToWikiSection(markdown: string, heading: WikiPromotionSection, body: string): string {
  if (!body.trim()) return markdown;
  let updated = ensureWikiSection(markdown, heading);
  const sectionHeading = `## ${heading}`;
  const idx = updated.indexOf(sectionHeading);
  const nextIdx = updated.slice(idx + sectionHeading.length).search(/\n##\s/);
  const insertAt = nextIdx === -1 ? updated.length : idx + sectionHeading.length + nextIdx;
  return `${updated.slice(0, insertAt).trimEnd()}\n\n${body.trim()}\n${updated.slice(insertAt)}`.trimEnd() + '\n';
}

function replaceWikiSection(markdown: string, heading: WikiPromotionSection, body: string): string {
  let updated = ensureWikiSection(markdown, heading);
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const replacement = `## ${heading}\n${body.trim() || 'Needs review'}\n`;
  const pattern = new RegExp(`^## ${escaped}\\s*\\n[\\s\\S]*?(?=^##\\s|(?![\\s\\S]))`, 'm');
  return updated.replace(pattern, replacement).trimEnd() + '\n';
}

function frontmatterBlock(fields: Record<string, string | string[]>): string[] {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${item}`);
    } else {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    }
  }
  lines.push('---');
  return lines;
}

function wikiTemplate(projectName: string, ts: string): string {
  return [
    ...frontmatterBlock({
      type: 'project_wiki',
      project: projectName,
      status: 'active',
      last_reviewed: ts,
      review_after: 'None scheduled',
      mnemon_importance: 'medium',
      tags: ['distributed-cognition/project'],
    }),
    '',
    `# ${projectName}`,
    '',
    '## Wiki Metadata',
    `Last reviewed: ${ts}`,
    'Status: active',
    '',
    '## Current State',
    'Needs review',
    '',
    '## Timeline',
    '',
    '## Decisions',
    '',
    '## Open Questions',
    '',
    '## Risks',
    '',
    '## Next Actions',
    '',
    '## Sources',
    '',
    '## Mnemon Candidates',
    'Pending candidates only. Do not treat this section as stored Mnemon memory.',
    '',
    '## Update Log',
    '',
  ].join('\n');
}

function updateWikiMetadata(markdown: string, ts: string): string {
  if (/^Last reviewed:/m.test(markdown)) {
    return markdown.replace(/^Last reviewed:.*$/m, `Last reviewed: ${ts}`);
  }
  return markdown.replace(/^## Wiki Metadata\s*$/m, `## Wiki Metadata\nLast reviewed: ${ts}`);
}

function normalizeProjectLifecycleStatus(input: unknown): ProjectLifecycleStatus {
  if (PROJECT_STATUS_VALUES.includes(input as ProjectLifecycleStatus)) return input as ProjectLifecycleStatus;
  return 'active';
}

function projectStatusIndexPaths(root: string): { dir: string; json: string; currentProjects: string } {
  const realRoot = requireRoot(root);
  const paths = contextIndexPaths(realRoot);
  return {
    dir: paths.dir,
    json: path.join(paths.dir, PROJECT_STATUS_INDEX_FILE),
    currentProjects: path.join(realRoot, 'project-wikis', 'current-projects.md'),
  };
}

function loadProjectStatusIndex(root: string): ProjectStatusIndex {
  const paths = projectStatusIndexPaths(root);
  if (!fs.existsSync(paths.json)) {
    return { version: PROJECT_STATUS_VERSION, updatedAt: timestamp(new Date(0)), projects: [] };
  }
  const parsed = JSON.parse(fs.readFileSync(paths.json, 'utf-8')) as ProjectStatusIndex;
  if (parsed.version !== PROJECT_STATUS_VERSION) {
    return { version: PROJECT_STATUS_VERSION, updatedAt: timestamp(new Date(0)), projects: [] };
  }
  return parsed;
}

function scrubbedList(value: unknown): string[] {
  return asStringList(value).map((item) => scrubPrivateText(item));
}

function normalizeProjectSources(sourcePaths: unknown): string[] {
  if (!Array.isArray(sourcePaths)) return [];
  return sourcePaths.map((item) => {
    if (typeof item !== 'string' || !item.trim()) throw new Error('sourcePaths must contain relative Markdown paths');
    const normalized = normalizeSecondBrainRelativePath(item);
    const folder = firstPathSegment(normalized);
    if (!SECOND_BRAIN_FOLDERS.includes(folder as SecondBrainFolder)) {
      throw new Error(`Unsupported project status source folder: ${folder}`);
    }
    if (!normalized.endsWith('.md')) throw new Error(`Project status source must be Markdown: ${normalized}`);
    return scrubPrivateText(normalized);
  });
}

function statusListMarkdown(items: string[], empty = 'None recorded'): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : empty;
}

function projectStatusMarkdown(record: ProjectStatusRecord): string {
  const sources =
    record.sourcePaths.length > 0
      ? record.sourcePaths.map((source) => `- ${obsidianLink(source)}`).join('\n')
      : 'None recorded';
  return [
    ...frontmatterBlock({
      type: 'project_status',
      project: record.name,
      status: record.status,
      last_reviewed: record.updatedAt,
      review_after: record.reviewAfter,
      mnemon_importance: 'medium',
      tags: ['distributed-cognition/project'],
    }),
    '',
    `# Project — ${record.name}`,
    '',
    '## Wiki Metadata',
    `Last reviewed: ${record.updatedAt}`,
    `Status: ${record.status}`,
    `Review after: ${record.reviewAfter}`,
    '',
    '## Current State',
    record.currentState,
    '',
    '## Decisions',
    statusListMarkdown(record.decisions),
    '',
    '## Open Questions',
    statusListMarkdown(record.openQuestions),
    '',
    '## Risks',
    statusListMarkdown(record.risks),
    '',
    '## Next Actions',
    statusListMarkdown(record.nextActions),
    '',
    '## Sources',
    sources,
    '',
    '## Mnemon Candidates',
    'Store only concise, high-signal project facts or pivots in Mnemon. Keep raw transcripts as linked source notes.',
    '',
    '## Update Log',
    `- ${record.updatedAt}: Project status refreshed through distributed_cognition_update_project_status.`,
    '',
  ].join('\n');
}

function currentProjectsMarkdown(index: ProjectStatusIndex): string {
  const activeish = index.projects.filter((project) => project.status !== 'done');
  const table = index.projects.map((project) =>
    [
      obsidianLink(project.wikiPath, project.name),
      project.status,
      project.reviewAfter,
      project.nextActions[0] ?? 'None recorded',
      project.openQuestions[0] ?? 'None recorded',
    ].join(' | '),
  );
  return [
    ...frontmatterBlock({
      type: 'portfolio_status',
      generated: index.updatedAt,
      tags: ['distributed-cognition/portfolio'],
    }),
    '',
    `# Current Projects — ${index.updatedAt}`,
    '',
    '## Portfolio Pulse',
    `Active / watch / blocked / paused / stale projects: ${activeish.length}`,
    `Last updated: ${index.updatedAt}`,
    '',
    '## Project Status Table',
    'Project | Status | Review after | Next action | Open question',
    '--- | --- | --- | --- | ---',
    ...table,
    '',
    '## Notes',
    '- This is a curated working map, not a full transcript dump.',
    '- Promote only durable pivots, decisions, deadlines, risks, and open questions into project pages.',
    '- Raw reflections remain linked in inbox-whatsapp/, daily-reflections/, or processed-notes/.',
    '',
  ].join('\n');
}

function upsertProjectStatus(root: string, args: Record<string, unknown>): ProjectStatusRecord {
  const name = typeof args.projectName === 'string' ? scrubPrivateText(args.projectName.trim()) : '';
  if (!name) throw new Error('projectName is required');
  const now = new Date();
  const updatedAt = timestamp(now);
  const wiki = resolveProjectWikiPath(root, name);
  const index = loadProjectStatusIndex(root);
  const existing = index.projects.find((project) => project.slug === wikiSlug(name));
  const record: ProjectStatusRecord = {
    version: PROJECT_STATUS_VERSION,
    slug: wikiSlug(name),
    name,
    status: normalizeProjectLifecycleStatus(args.status ?? existing?.status),
    updatedAt,
    currentState:
      typeof args.currentState === 'string' && args.currentState.trim()
        ? scrubPrivateText(args.currentState.trim())
        : existing?.currentState || 'Needs review',
    nextActions:
      scrubbedList(args.nextActions).length > 0 ? scrubbedList(args.nextActions) : existing?.nextActions || [],
    openQuestions:
      scrubbedList(args.openQuestions).length > 0 ? scrubbedList(args.openQuestions) : existing?.openQuestions || [],
    decisions: scrubbedList(args.decisions).length > 0 ? scrubbedList(args.decisions) : existing?.decisions || [],
    risks: scrubbedList(args.risks).length > 0 ? scrubbedList(args.risks) : existing?.risks || [],
    sourcePaths:
      normalizeProjectSources(args.sourcePaths).length > 0
        ? normalizeProjectSources(args.sourcePaths)
        : existing?.sourcePaths || [],
    reviewAfter:
      typeof args.reviewAfter === 'string' && args.reviewAfter.trim()
        ? scrubPrivateText(args.reviewAfter.trim())
        : existing?.reviewAfter || 'None scheduled',
    wikiPath: wiki.relativePath,
  };

  const nextIndex: ProjectStatusIndex = {
    version: PROJECT_STATUS_VERSION,
    updatedAt,
    projects: [record, ...index.projects.filter((project) => project.slug !== record.slug)].sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
  };
  const paths = projectStatusIndexPaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.mkdirSync(path.dirname(paths.currentProjects), { recursive: true });
  fs.writeFileSync(paths.json, `${JSON.stringify(nextIndex, null, 2)}\n`);
  fs.writeFileSync(wiki.filePath, projectStatusMarkdown(record));
  fs.writeFileSync(paths.currentProjects, currentProjectsMarkdown(nextIndex));
  return record;
}

function healthStatus(items: HealthCheckItem[]): SystemHealthReport['overall'] {
  if (items.some((item) => item.status === 'error')) return 'error';
  if (items.some((item) => item.status === 'warning')) return 'warning';
  return 'ok';
}

function pathHealth(
  label: string,
  target: string,
  options: { required?: boolean; writable?: boolean } = {},
): HealthCheckItem {
  try {
    if (!fs.existsSync(target)) {
      return {
        label,
        status: options.required ? 'error' : 'warning',
        detail: `${scrubPrivateText(target)} is not mounted or does not exist`,
      };
    }
    const stat = fs.statSync(target);
    if (!stat.isDirectory() && !stat.isFile()) {
      return { label, status: 'warning', detail: `${scrubPrivateText(target)} exists but is not a file or directory` };
    }
    if (options.writable) fs.accessSync(target, fs.constants.W_OK);
    return {
      label,
      status: 'ok',
      detail: `${scrubPrivateText(target)} is ${stat.isDirectory() ? 'available as a directory' : 'available as a file'}`,
    };
  } catch (e) {
    return {
      label,
      status: options.required ? 'error' : 'warning',
      detail: e instanceof Error ? scrubPrivateText(e.message) : scrubPrivateText(String(e)),
    };
  }
}

function systemHealthMarkdown(report: SystemHealthReport): string {
  return [
    ...frontmatterBlock({
      type: 'system_health',
      generated: report.checkedAt,
      status: report.overall,
      tags: ['distributed-cognition/health'],
    }),
    '',
    `# Distributed Cognition System Health — ${report.checkedAt}`,
    '',
    '## Overall',
    report.overall,
    '',
    '## Checks',
    ...report.items.map((item) => `- ${item.status.toUpperCase()}: ${item.label} — ${item.detail}`),
    '',
    '## Interpretation',
    '- OK means the required mounted folder or queue is visible.',
    '- Warning means an optional capability is unavailable or has not been initialised.',
    '- Error means Distributed Cognition should not assume that capability is safe to use.',
    '',
  ].join('\n');
}

function buildSystemHealth(root: string): { report: SystemHealthReport; wikiPath: string; jsonPath: string } {
  const realRoot = requireRoot(root);
  ensureFolders(realRoot);
  const items: HealthCheckItem[] = [
    pathHealth('second-brain root', realRoot, { required: true, writable: true }),
    ...SECOND_BRAIN_FOLDERS.map((folder) =>
      pathHealth(`second-brain/${folder}`, path.join(realRoot, folder), { required: true, writable: true }),
    ),
    ...SOURCE_CONTEXT_ROOTS.map((candidate) => pathHealth(`context/${candidate.label}`, candidate.path)),
    pathHealth('codex projects mount', CODEX_PROJECTS_ROOT_CANDIDATES[0]),
    pathHealth('codex memory mount', CODEX_MEMORY_ROOT_CANDIDATES[0]),
  ];

  const mnemon =
    process.env.MNEMON_DB_PATH?.trim() || MNEMON_DB_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  items.push(
    mnemon
      ? pathHealth('mnemon database', mnemon)
      : {
          label: 'mnemon database',
          status: 'warning',
          detail: `No Mnemon database detected yet. Default candidate is ${MNEMON_DB_CANDIDATES[0]}.`,
        },
  );

  const indexPaths = contextIndexPaths(realRoot);
  items.push(pathHealth('context index directory', indexPaths.dir));
  for (const dir of [
    path.join(indexPaths.dir, CODEX_HANDOFF_DIR, 'queued'),
    path.join(indexPaths.dir, ACTION_REQUEST_DIR, 'queued'),
  ]) {
    items.push(pathHealth(`queue/${path.basename(path.dirname(dir))}/queued`, dir));
  }

  const checkedAt = timestamp(new Date());
  const report: SystemHealthReport = {
    version: SYSTEM_HEALTH_VERSION,
    checkedAt,
    overall: healthStatus(items),
    items,
  };
  fs.mkdirSync(indexPaths.dir, { recursive: true });
  const jsonPath = path.join(indexPaths.dir, SYSTEM_HEALTH_FILE);
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  const wiki = resolveProjectWikiPath(realRoot, 'System Health', 'project-wikis/system-health.md');
  fs.writeFileSync(wiki.filePath, systemHealthMarkdown(report));
  return { report, wikiPath: wiki.filePath, jsonPath };
}

function formatDcReply(message: string, options: { includeTimestamp?: boolean; maxChars?: number } = {}): string {
  const cleaned = scrubPrivateText(message)
    .replace(/^\s*(?:distributed cognition|dc)\s*:\s*/i, '')
    .replace(/\s+\n/g, '\n')
    .trim();
  const maxChars =
    typeof options.maxChars === 'number' && Number.isFinite(options.maxChars)
      ? Math.min(4_000, Math.max(40, Math.floor(options.maxChars)))
      : 1_200;
  const body = truncateText(cleaned || 'Noted.', maxChars);
  const prefix = options.includeTimestamp ? `DC: ${timestamp(new Date())} -` : 'DC:';
  return `${prefix} ${body}`;
}

function capabilityRoute(
  text: string,
  hasAudioAttachment = false,
): {
  capability: string;
  messageType: MessageType;
  confidence: string;
  tools: string[];
  reason: string;
  hostBridge?: string;
} {
  const messageType = classify(text);
  const lower = text.toLowerCase();
  if (messageType === 'sensitive_data_warning') {
    return {
      capability: 'refuse_sensitive_data',
      messageType,
      confidence: 'high',
      tools: ['distributed_cognition_format_reply'],
      reason: 'message classified as sensitive_data_warning',
    };
  }
  if (hasAudioAttachment || /\b(audio|voice note|voice recording|opus|ogg|m4a)\b/i.test(lower)) {
    return {
      capability: 'process_audio',
      messageType,
      confidence: 'high',
      tools: ['distributed_cognition_capture_audio'],
      reason: 'audio or voice-note signal detected',
    };
  }
  if (/\b(codex|repo|repository|codebase|implement|fix|debug|run tests|handoff|send this to codex)\b/i.test(lower)) {
    return {
      capability: 'queue_codex_handoff',
      messageType,
      confidence: 'high',
      tools: ['distributed_cognition_build_codex_status', 'distributed_cognition_create_codex_handoff'],
      reason: 'local Codex work signal detected',
      hostBridge: 'codex',
    };
  }
  if (
    /\b(powerpoint|pptx|slide deck|slides|word document|docx|long research|research task|deck|presentation)\b/i.test(
      lower,
    )
  ) {
    return {
      capability: 'queue_action_request',
      messageType,
      confidence: 'high',
      tools: ['distributed_cognition_create_action_request'],
      reason: 'artifact or long-running action signal detected',
      hostBridge: 'action',
    };
  }
  if (/\b(latest|current|news|web search|search the web|look up|source url|public web)\b/i.test(lower)) {
    return {
      capability: 'web_search',
      messageType,
      confidence: 'high',
      tools: ['distributed_cognition_web_search', 'distributed_cognition_read_web_page'],
      reason: 'current-information or public-web signal detected',
    };
  }
  if (/\b(attention calibration|promote more|remember fewer|ignore logistics|challenge me more)\b/i.test(lower)) {
    return {
      capability: 'calibrate_attention',
      messageType,
      confidence: 'high',
      tools: ['distributed_cognition_attention_calibration'],
      reason: 'attention calibration signal detected',
    };
  }
  if (/\b(memory hygiene|changed my mind|obsolete memories|superseded memories|memory audit)\b/i.test(lower)) {
    return {
      capability: 'refresh_memory_hygiene',
      messageType,
      confidence: 'high',
      tools: ['distributed_cognition_memory_hygiene', 'distributed_cognition_auto_upgrade_memory'],
      reason: 'memory hygiene signal detected',
    };
  }
  if (
    /\b(mnemon graph|memory graph|mnemon canvas|memory canvas)\b/i.test(lower) ||
    /\b(visuali[sz]e|show|draw|map)\b.*\b(mnemon|durable memor(?:y|ies)|memory graph)\b/i.test(lower)
  ) {
    return {
      capability: 'visualize_memory',
      messageType,
      confidence: 'high',
      tools: ['distributed_cognition_mnemon_graph'],
      reason: 'Mnemon graph visualization signal detected',
    };
  }
  if (/\b(project ontology|ontology|concept map|project graph)\b/i.test(lower)) {
    return {
      capability: 'refresh_project_ontology',
      messageType,
      confidence: 'high',
      tools: ['distributed_cognition_project_ontology'],
      reason: 'project ontology signal detected',
    };
  }
  if (/\b(provenance|why do you think|source trail|audit trail)\b/i.test(lower)) {
    return {
      capability: 'show_provenance',
      messageType,
      confidence: 'high',
      tools: ['distributed_cognition_provenance_ledger'],
      reason: 'provenance or source-trail signal detected',
    };
  }
  if (/\b(health check|are you alive|queue status|what is queued|dashboard|workbench|status)\b/i.test(lower)) {
    return {
      capability: 'report_status',
      messageType,
      confidence: 'high',
      tools: [
        'distributed_cognition_health_check',
        'distributed_cognition_queue_status',
        'distributed_cognition_attention_calibration',
        'distributed_cognition_memory_hygiene',
        'distributed_cognition_project_ontology',
      ],
      reason: 'status or queue visibility signal detected',
    };
  }
  if (messageType === 'weekly_synthesis_request') {
    return {
      capability: 'synthesize_review',
      messageType,
      confidence: 'high',
      tools: ['distributed_cognition_search_context', 'distributed_cognition_update_project_status'],
      reason: 'synthesis request detected',
    };
  }
  if (messageType === 'durable_memory_candidate') {
    return {
      capability: 'promote_durable_memory',
      messageType,
      confidence: 'high',
      tools: ['distributed_cognition_auto_upgrade_memory'],
      reason: 'durable-memory candidate detected',
    };
  }
  if (messageType === 'forget_or_correction_request') {
    return {
      capability: 'correct_or_forget_memory',
      messageType,
      confidence: 'high',
      tools: ['distributed_cognition_capture_note', 'distributed_cognition_auto_upgrade_memory'],
      reason: 'forget or correction request detected',
    };
  }
  if (/\b(search|find|dropbox|context folder|second brain|mnemon|what do you know)\b/i.test(lower)) {
    return {
      capability: 'search_context',
      messageType,
      confidence: 'medium',
      tools: ['distributed_cognition_search_context', 'distributed_cognition_read_context'],
      reason: 'local-context retrieval signal detected',
    };
  }
  if (messageType === 'decision') {
    return {
      capability: 'capture_decision',
      messageType,
      confidence: 'high',
      tools: ['distributed_cognition_capture_note', 'distributed_cognition_auto_upgrade_memory'],
      reason: 'decision message type',
    };
  }
  if (messageType === 'question') {
    return {
      capability: 'answer_question',
      messageType,
      confidence: 'medium',
      tools: ['distributed_cognition_search_context', 'distributed_cognition_read_context'],
      reason: 'question message type',
    };
  }
  return {
    capability: messageType === 'reflection' ? 'capture_reflection' : 'capture_general_note',
    messageType,
    confidence: 'medium',
    tools: ['distributed_cognition_capture_note'],
    reason: messageType === 'reflection' ? 'reflection message type' : 'default general note capture',
  };
}

function parseProjectNameFromProposal(markdown: string): string {
  const match = markdown.match(/^# Promotion Proposal — (.+?) — \d{2}-\d{2}-\d{2},\s*\d{2}:\d{2}\s*$/m);
  if (match?.[1]?.trim()) return match[1].trim();
  throw new Error('Could not determine project name from promotion proposal');
}

function parseTargetPathFromProposal(markdown: string, projectName: string): string {
  const match = markdown.match(/^- Target path:\s*(project-wikis\/[a-z0-9-]+\.md)\s*$/m);
  return match?.[1]?.trim() || `project-wikis/${wikiPageFilename(projectName)}`;
}

function sourceNotesFromProposal(markdown: string): string {
  return extractMarkdownSection(markdown, 'Source Notes');
}

function proposalIsPending(markdown: string): boolean {
  return /^## Status\s*\npending_review\s*$/m.test(markdown);
}

function memoryId(): string {
  return randomBytes(16).toString('hex');
}

function normalizeMemoryLayer(input: unknown, memory: string): MemoryLayer {
  if (MEMORY_LAYERS.includes(input as MemoryLayer)) return input as MemoryLayer;
  if (/\b(always|never|preference|prefer|default|standing rule|from now on|workflow|must|should)\b/i.test(memory)) {
    return 'procedural';
  }
  if (/\b(file|folder|path|document|deck|paper|manuscript|source)\b/i.test(memory)) return 'resource';
  if (/\b(on|at|during|after)\s+\d{2}-\d{2}-\d{2}\b/i.test(memory)) return 'episodic';
  return 'semantic';
}

function normalizeMemoryEntityType(input: unknown): MemoryEntityType | undefined {
  return MEMORY_ENTITY_TYPES.includes(input as MemoryEntityType) ? (input as MemoryEntityType) : undefined;
}

function clampMemoryScore(input: unknown, fallback: number): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) return fallback;
  return Math.min(1, Math.max(0, input));
}

function normalizeMemoryMessageType(input: unknown): MessageType | undefined {
  return MESSAGE_TYPES.includes(input as MessageType) ? (input as MessageType) : undefined;
}

function resolveMnemonDbPath(): string {
  const direct = process.env.MNEMON_DB_PATH?.trim();
  if (direct) {
    fs.mkdirSync(path.dirname(direct), { recursive: true });
    return direct;
  }

  for (const candidate of MNEMON_DB_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) return candidate;
      const parent = path.dirname(candidate);
      if (fs.existsSync(parent)) return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  const fallback = MNEMON_DB_CANDIDATES[0];
  fs.mkdirSync(path.dirname(fallback), { recursive: true });
  return fallback;
}

function ensureMnemonSchema(db: Database): void {
  db.run('PRAGMA foreign_keys = ON');
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      client     TEXT NOT NULL,
      project    TEXT,
      started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      ended_at   TEXT,
      summary    TEXT,
      meta       TEXT NOT NULL DEFAULT '{}'
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS memories (
      id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      layer         TEXT NOT NULL CHECK (layer IN ('episodic', 'semantic', 'procedural', 'resource')),
      content       TEXT NOT NULL,
      title         TEXT,
      source        TEXT NOT NULL,
      source_file   TEXT,
      session_id    TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      event_at      TEXT,
      expires_at    TEXT,
      confidence    REAL NOT NULL DEFAULT 0.8 CHECK (confidence BETWEEN 0.0 AND 1.0),
      importance    REAL NOT NULL DEFAULT 0.5 CHECK (importance BETWEEN 0.0 AND 1.0),
      access_count  INTEGER NOT NULL DEFAULT 0,
      last_accessed TEXT,
      superseded_by TEXT REFERENCES memories(id) ON DELETE SET NULL,
      supersedes    TEXT REFERENCES memories(id) ON DELETE SET NULL,
      entity_type   TEXT CHECK (entity_type IN ('user','project','person','concept','file','rule','tool') OR entity_type IS NULL),
      entity_name   TEXT,
      scope         TEXT NOT NULL DEFAULT 'global',
      meta          TEXT NOT NULL DEFAULT '{}',
      stemmed_content TEXT,
      stemmed_title TEXT,
      valid_from TEXT,
      valid_until TEXT,
      embedding_model TEXT
    )
  `);
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      id UNINDEXED,
      title,
      content,
      entity_name,
      tokenize='unicode61 remove_diacritics 2'
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS event_log (
      id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      memory_id   TEXT NOT NULL,
      event_type  TEXT NOT NULL CHECK (event_type IN ('created', 'updated', 'superseded', 'deleted')),
      actor       TEXT NOT NULL DEFAULT 'api',
      old_content TEXT,
      new_content TEXT,
      diff_meta   TEXT NOT NULL DEFAULT '{}',
      occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_memories_layer ON memories(layer) WHERE superseded_by IS NULL');
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_memories_entity ON memories(entity_type, entity_name) WHERE superseded_by IS NULL',
  );
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_memories_rank ON memories(importance DESC, confidence DESC) WHERE superseded_by IS NULL',
  );
  db.run('CREATE INDEX IF NOT EXISTS idx_memories_source_file ON memories(source_file) WHERE source_file IS NOT NULL');
  db.run('CREATE INDEX IF NOT EXISTS idx_event_log_memory ON event_log(memory_id)');
  db.run(`
    CREATE TRIGGER IF NOT EXISTS memories_fts_insert
    AFTER INSERT ON memories
    BEGIN
      INSERT INTO memories_fts(id, title, content, entity_name)
      VALUES (
        NEW.id,
        COALESCE(NEW.stemmed_title, NEW.title),
        COALESCE(NEW.stemmed_content, NEW.content),
        NEW.entity_name
      );
    END
  `);
  db.run(`
    CREATE TRIGGER IF NOT EXISTS memories_fts_update
    AFTER UPDATE ON memories
    WHEN OLD.content != NEW.content
      OR OLD.title IS NOT NEW.title
      OR OLD.entity_name IS NOT NEW.entity_name
      OR OLD.stemmed_content IS NOT NEW.stemmed_content
      OR OLD.stemmed_title IS NOT NEW.stemmed_title
    BEGIN
      UPDATE memories_fts
      SET title       = COALESCE(NEW.stemmed_title, NEW.title),
          content     = COALESCE(NEW.stemmed_content, NEW.content),
          entity_name = NEW.entity_name
      WHERE id = NEW.id;
    END
  `);
  db.run(`
    CREATE TRIGGER IF NOT EXISTS memories_fts_delete
    AFTER DELETE ON memories
    BEGIN
      DELETE FROM memories_fts WHERE id = OLD.id;
    END
  `);
}

function normalizeMemoryContent(input: string): string {
  return input
    .replace(/\u0000/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeRawDump(input: string): boolean {
  const trimmed = input.trim();
  if (/^#{1,6}\s+(raw|reflection|transcript|decision)\b/im.test(trimmed)) return true;
  if (/^\s*(raw transcript|raw reflection|full transcript|verbatim transcript)\s*[:—-]/i.test(trimmed)) return true;
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 8;
}

function memorySignal(input: DurableMemoryInput): { allowed: boolean; reason: string; messageType?: MessageType } {
  const original = input.memory;
  const memory = normalizeMemoryContent(original);
  const messageType = normalizeMemoryMessageType(input.messageType);
  if (!memory) return { allowed: false, reason: 'memory is required', messageType };
  if (memory.length > MAX_MEMORY_CHARS) {
    return {
      allowed: false,
      reason: `memory is too long for Mnemon (${memory.length} characters; max ${MAX_MEMORY_CHARS}). Store the raw material in Markdown and extract a concise memory.`,
      messageType,
    };
  }
  if (looksLikeRawDump(original)) {
    return {
      allowed: false,
      reason: 'memory appears to be a raw transcript or multi-section dump. Store a concise extracted memory instead.',
      messageType,
    };
  }
  if (SENSITIVE_RE.test(memory) || PROHIBITED_CONTEXT_RE.test(memory) || messageType === 'sensitive_data_warning') {
    return {
      allowed: false,
      reason: 'memory appears to contain prohibited sensitive, HR, exam, or confidential content.',
      messageType,
    };
  }
  if (messageType === 'durable_memory_candidate') {
    return { allowed: true, reason: 'classified as a durable memory candidate', messageType };
  }
  if (messageType === 'decision') {
    return { allowed: true, reason: 'classified as a decision or durable decision leaning', messageType };
  }
  if (messageType === 'forget_or_correction_request') {
    return { allowed: true, reason: 'classified as a durable correction or forget request', messageType };
  }
  if (
    /\b(remember|remember that|from now on|always|never|standing rule|preference|prefer|default|durable memory|store this|important to remember|this is important|changed my mind)\b/i.test(
      memory,
    )
  ) {
    return { allowed: true, reason: 'contains explicit durable-memory or standing-preference signal', messageType };
  }
  return {
    allowed: false,
    reason:
      'not enough durable-memory signal; keep this in Markdown unless a concise stable fact, decision, preference, correction, or project constraint is extracted',
    messageType,
  };
}

function readOptionalMemorySources(root: string, sourcePaths: unknown): PromotionSource[] {
  if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) return [];
  return readPromotionSources(root, sourcePaths);
}

function memoryAuditMarkdown(
  input: DurableMemoryInput,
  result: StoredMemoryResult,
  sources: PromotionSource[],
  ts: string,
): string {
  const sourceLinks = sources.map(
    (source) =>
      `- ${obsidianLink(source.relativePath, source.title)} — captured ${source.capturedAt}; path: ${source.relativePath}`,
  );
  return [
    `# Durable Memory Upgrade — ${ts}`,
    '',
    '## Status',
    'auto_stored',
    '',
    '## Mnemon',
    `- Memory id: ${result.id}`,
    `- Layer: ${result.layer}`,
    `- Entity type: ${input.entityType ?? 'unspecified'}`,
    `- Entity name: ${input.entityName ?? 'unspecified'}`,
    `- Importance: ${clampMemoryScore(input.importance, 0.8).toFixed(2)}`,
    `- Confidence: ${clampMemoryScore(input.confidence, 0.85).toFixed(2)}`,
    `- Scope: ${input.scope?.trim() || 'distributed-cognition'}`,
    '',
    '## Memory',
    normalizeMemoryContent(input.memory),
    '',
    '## Rationale',
    input.rationale?.trim() || 'Automatically stored because the extracted memory was concise, safe, and high-signal.',
    '',
    '## Source Notes',
    sourceLinks.length > 0
      ? sourceLinks.join('\n')
      : '- No second-brain source note supplied; source is the current conversation or agent extraction.',
    '',
    '## Safety',
    '- Raw transcript content was not stored in Mnemon.',
    '- Patient-identifiable, learner-identifiable, HR, exam, and confidential institutional content are blocked.',
    '- This audit note preserves the source trail for later correction or supersession.',
    '',
  ].join('\n');
}

function storeDurableMemory(root: string, input: DurableMemoryInput, signalReason: string): StoredMemoryResult {
  const memory = normalizeMemoryContent(input.memory);
  const now = new Date();
  const ts = timestamp(now);
  const sources = readOptionalMemorySources(root, input.sourcePaths);
  const dbPath = resolveMnemonDbPath();
  const id = memoryId();
  const title =
    typeof input.title === 'string' && input.title.trim()
      ? input.title.trim()
      : memory.split(/\s+/).slice(0, 9).join(' ');
  const layer = normalizeMemoryLayer(input.layer, memory);
  const entityType = normalizeMemoryEntityType(input.entityType);
  const entityName =
    typeof input.entityName === 'string' && input.entityName.trim() ? input.entityName.trim() : undefined;
  const sourceRelativePath = sources[0]?.relativePath;
  const auditPath = resolveNotePath(root, 'approved-updates', filename(now, `memory-${title}`));
  const meta = {
    workflow: 'distributed-cognition-auto-upgrade',
    approvalMode: input.approvalMode ?? 'automatic',
    signalReason,
    sourcePaths: sources.map((source) => source.relativePath),
    auditPath: toRelativeDisplayPath(requireRoot(root), auditPath),
  };

  const db = new Database(dbPath);
  try {
    ensureMnemonSchema(db);
    const createdAt = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
    db.run(
      `
        INSERT INTO memories (
          id,
          layer,
          content,
          title,
          source,
          source_file,
          created_at,
          updated_at,
          event_at,
          confidence,
          importance,
          entity_type,
          entity_name,
          scope,
          meta,
          valid_from,
          valid_until
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        id,
        layer,
        memory,
        title,
        'distributed-cognition',
        sourceRelativePath ?? null,
        createdAt,
        createdAt,
        input.eventAt?.trim() || null,
        clampMemoryScore(input.confidence, 0.85),
        clampMemoryScore(input.importance, 0.8),
        entityType ?? null,
        entityName ?? null,
        input.scope?.trim() || 'distributed-cognition',
        JSON.stringify(meta),
        input.validFrom?.trim() || null,
        input.validUntil?.trim() || null,
      ],
    );
    db.run('INSERT INTO event_log (memory_id, event_type, actor, new_content, diff_meta) VALUES (?, ?, ?, ?, ?)', [
      id,
      'created',
      'distributed-cognition',
      memory,
      JSON.stringify({ ...meta, title, layer, entityType, entityName }),
    ]);
  } finally {
    db.close();
  }

  const result: StoredMemoryResult = { id, auditPath, dbPath, layer, sourceRelativePath };
  const audit = memoryAuditMarkdown(input, result, sources, ts);
  const writtenAuditPath = writeNew(auditPath, audit);
  result.auditPath = writtenAuditPath;
  appendProvenanceEvent(root, {
    id,
    kind: 'memory_promotion',
    title: title,
    summary: signalReason,
    sourcePaths: sources.map((source) => source.relativePath),
    outputPaths: [relativeSecondBrainPath(root, writtenAuditPath)],
    metadata: {
      layer,
      entityType: entityType ?? undefined,
      entityName: entityName ?? undefined,
      importance: clampMemoryScore(input.importance, 0.8),
      confidence: clampMemoryScore(input.confidence, 0.85),
      status: 'current',
    },
  });
  return result;
}

function graphId(prefix: string, value: string): string {
  return `${prefix}_${createHash('sha1').update(value).digest('hex').slice(0, 10)}`;
}

function compactGraphLabel(value: string, max = 80): string {
  const clean = scrubPrivateText(value).replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 3)}...`;
}

function readMnemonGraphRows(limitInput: unknown): { dbPath: string; rows: MnemonGraphMemoryRow[] } {
  const dbPath = resolveMnemonDbPath();
  if (!fs.existsSync(dbPath)) return { dbPath, rows: [] };
  const limit = Math.min(200, Math.max(1, Number.isFinite(Number(limitInput)) ? Math.floor(Number(limitInput)) : 40));
  const db = new Database(dbPath, { readonly: true });
  try {
    const hasMemories = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name = 'memories'").get() as
      | { name?: string }
      | undefined;
    if (!hasMemories?.name) return { dbPath, rows: [] };
    const rows = db
      .query(
        `
          SELECT
            id,
            layer,
            title,
            content,
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
      .all(limit) as Array<Record<string, unknown>>;
    return {
      dbPath,
      rows: rows.map((row) => ({
        id: String(row.id ?? ''),
        layer: String(row.layer ?? 'unspecified'),
        title: typeof row.title === 'string' ? scrubPrivateText(row.title) : undefined,
        content: scrubPrivateText(String(row.content ?? '')),
        sourceFile: typeof row.sourceFile === 'string' ? scrubPrivateText(row.sourceFile) : undefined,
        createdAt: typeof row.createdAt === 'string' ? row.createdAt : '',
        confidence: Number(row.confidence ?? 0),
        importance: Number(row.importance ?? 0),
        entityType: typeof row.entityType === 'string' ? scrubPrivateText(row.entityType) : undefined,
        entityName: typeof row.entityName === 'string' ? scrubPrivateText(row.entityName) : undefined,
      })),
    };
  } finally {
    db.close();
  }
}

function buildMnemonGraph(rows: MnemonGraphMemoryRow[]): { nodes: MnemonGraphNode[]; edges: MnemonGraphEdge[] } {
  const nodes = new Map<string, MnemonGraphNode>();
  const edges = new Map<string, MnemonGraphEdge>();
  const addNode = (node: MnemonGraphNode) => {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
  };
  const addEdge = (edge: MnemonGraphEdge) => {
    const key = `${edge.from}->${edge.to}:${edge.label ?? ''}`;
    if (!edges.has(key)) edges.set(key, edge);
  };
  addNode({ id: 'dc', kind: 'system', label: 'Distributed Cognition' });
  for (const row of rows) {
    const layerId = graphId('layer', row.layer);
    const entityType = row.entityType || 'unspecified';
    const entityName = row.entityName || 'unspecified';
    const entityId = graphId('entity', `${entityType}:${entityName}`);
    const memoryId = graphId('memory', row.id);
    addNode({ id: layerId, kind: 'layer', label: `layer: ${row.layer}` });
    addNode({ id: entityId, kind: 'entity', label: `${entityType}: ${compactGraphLabel(entityName, 64)}` });
    addNode({
      id: memoryId,
      kind: 'memory',
      label: `${compactGraphLabel(row.title || row.id, 56)}\\nimportance ${row.importance.toFixed(2)}`,
      importance: row.importance,
    });
    addEdge({ from: 'dc', to: layerId });
    addEdge({ from: layerId, to: entityId });
    addEdge({ from: entityId, to: memoryId });
    if (row.sourceFile) {
      const sourceId = graphId('source', row.sourceFile);
      addNode({ id: sourceId, kind: 'source', label: compactGraphLabel(row.sourceFile, 72) });
      addEdge({ from: memoryId, to: sourceId, label: 'source' });
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

function canvasColumn(kind: MnemonGraphNode['kind']): number {
  if (kind === 'system') return 0;
  if (kind === 'layer') return 1;
  if (kind === 'entity') return 2;
  if (kind === 'memory') return 3;
  return 4;
}

function canvasColor(node: MnemonGraphNode): string {
  if (node.kind === 'system') return '#2563eb';
  if (node.kind === 'layer') return '#0891b2';
  if (node.kind === 'entity') return '#7c3aed';
  if (node.kind === 'source') return '#64748b';
  if ((node.importance ?? 0) >= 0.85) return '#dc2626';
  if ((node.importance ?? 0) >= 0.65) return '#ea580c';
  if ((node.importance ?? 0) >= 0.45) return '#ca8a04';
  return '#475569';
}

function canvasTitle(kind: MnemonGraphNode['kind']): string {
  if (kind === 'system') return 'System';
  if (kind === 'layer') return 'Layer';
  if (kind === 'entity') return 'Entity';
  if (kind === 'memory') return 'Memory';
  return 'Source';
}

function mnemonGraphCanvas(graph: { nodes: MnemonGraphNode[]; edges: MnemonGraphEdge[] }): {
  nodes: Array<Record<string, string | number>>;
  edges: Array<Record<string, string>>;
} {
  const counters = new Map<number, number>();
  const nodes = [...graph.nodes]
    .sort((a, b) => canvasColumn(a.kind) - canvasColumn(b.kind) || a.label.localeCompare(b.label))
    .map((node) => {
      const column = canvasColumn(node.kind);
      const index = counters.get(column) ?? 0;
      counters.set(column, index + 1);
      const importance =
        node.kind === 'memory' && typeof node.importance === 'number'
          ? `\n\nimportance: ${node.importance.toFixed(2)}`
          : '';
      return {
        id: node.id,
        type: 'text',
        x: column * 420,
        y: index * 210,
        width: node.kind === 'memory' ? 340 : 300,
        height: node.kind === 'memory' ? 170 : 140,
        color: canvasColor(node),
        text: `**${canvasTitle(node.kind)}**\n${node.label}${importance}`,
      };
    });
  const edges = graph.edges.map((edge) => ({
    id: graphId('edge', `${edge.from}->${edge.to}:${edge.label ?? ''}`),
    fromNode: edge.from,
    fromSide: 'right',
    toNode: edge.to,
    toSide: 'left',
    color: '#94a3b8',
    ...(edge.label ? { label: edge.label } : {}),
  }));
  return { nodes, edges };
}

function mermaidLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '<br/>');
}

function renderMnemonMermaid(graph: { nodes: MnemonGraphNode[]; edges: MnemonGraphEdge[] }): string {
  if (graph.nodes.length <= 1) return 'No Mnemon graph nodes found.';
  return [
    '```mermaid',
    'flowchart LR',
    ...graph.nodes.map((node) => `  ${node.id}["${mermaidLabel(node.label)}"]`),
    ...graph.edges.map((edge) => `  ${edge.from} -->${edge.label ? `|${mermaidLabel(edge.label)}|` : ''} ${edge.to}`),
    '```',
  ].join('\n');
}

function formatMemoryTime(value: string): string {
  const parsed = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}Z` : value);
  if (Number.isNaN(parsed.getTime())) return scrubPrivateText(value);
  return timestamp(parsed);
}

function importanceBand(row: MnemonGraphMemoryRow): string {
  if (row.importance >= 0.85) return 'key_or_pivot';
  if (row.importance >= 0.65) return 'useful_context';
  if (row.importance >= 0.45) return 'background';
  return 'low_signal';
}

function countRows(rows: MnemonGraphMemoryRow[], key: (row: MnemonGraphMemoryRow) => string | undefined): string[] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(key(row) || 'unspecified', (counts.get(key(row) || 'unspecified') ?? 0) + 1);
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return entries.length > 0 ? entries.map(([label, count]) => `- ${label}: ${count}`) : ['- None'];
}

function mnemonGraphMarkdown(
  rows: MnemonGraphMemoryRow[],
  graph: { nodes: MnemonGraphNode[]; edges: MnemonGraphEdge[] },
  dbPath: string,
): string {
  const now = timestamp(new Date());
  return [
    ...frontmatterBlock({
      type: 'mnemon_memory_report',
      generated: now,
      tags: ['distributed-cognition/mnemon', 'distributed-cognition/memory-graph'],
    }),
    '',
    `# Mnemon Memory Report — ${now}`,
    '',
    '## Scope',
    `- Database: ${scrubPrivateText(dbPath)}`,
    `- Distributed Cognition memories in view: ${rows.length}`,
    '',
    '## By Layer',
    ...countRows(rows, (row) => row.layer),
    '',
    '## By Entity Type',
    ...countRows(rows, (row) => row.entityType),
    '',
    '## By Importance Band',
    ...countRows(rows, importanceBand),
    '',
    '## Mnemon Graph',
    'Open [[mnemon-memory-graph.canvas|Mnemon Memory Graph Canvas]] in Obsidian for the visual board.',
    '',
    renderMnemonMermaid(graph),
    '',
    '## Attention Notes',
    '- Mnemon should hold durable keys, pivots, decisions, preferences, corrections, and stable project constraints.',
    '- Raw transcripts and ordinary meeting clutter should remain in Markdown notes.',
    '- Key/pivot memories are the first place to look when deciding what matters.',
    '',
    '## Recent / High-Signal Memories',
    rows.length > 0
      ? rows
          .map((row) =>
            [
              `### ${row.title || row.id}`,
              `- id: ${row.id}`,
              `- layer: ${row.layer}; importance ${row.importance.toFixed(2)}; confidence ${row.confidence.toFixed(2)}${row.entityName ? `; entity ${row.entityName}` : ''}${row.sourceFile ? `; source ${row.sourceFile}` : ''}`,
              `- created: ${formatMemoryTime(row.createdAt)}`,
              '',
              row.content,
            ].join('\n'),
          )
          .join('\n\n')
      : 'No Distributed Cognition memories found.',
    '',
  ].join('\n');
}

function writeMnemonGraph(
  root: string,
  limit?: unknown,
): {
  markdownPath: string;
  canvasPath: string;
  graphJsonPath: string;
  memoryCount: number;
  nodeCount: number;
  edgeCount: number;
} {
  const realRoot = requireRoot(root);
  ensureFolders(realRoot);
  const { dbPath, rows } = readMnemonGraphRows(limit);
  const graph = buildMnemonGraph(rows);
  const report = resolveProjectWikiPath(realRoot, 'Mnemon Memory Report', 'project-wikis/mnemon-memory-report.md');
  const wikiDir = path.join(realRoot, 'project-wikis');
  const canvasPath = path.join(wikiDir, 'mnemon-memory-graph.canvas');
  const graphJsonPath = path.join(contextIndexPaths(realRoot).dir, 'mnemon-memory-graph.json');
  assertInsideRoot(realRoot, canvasPath);
  assertInsideRoot(realRoot, graphJsonPath);
  fs.mkdirSync(wikiDir, { recursive: true });
  fs.mkdirSync(path.dirname(graphJsonPath), { recursive: true });
  fs.writeFileSync(report.filePath, mnemonGraphMarkdown(rows, graph, dbPath));
  fs.writeFileSync(graphJsonPath, JSON.stringify(graph, null, 2));
  fs.writeFileSync(canvasPath, JSON.stringify(mnemonGraphCanvas(graph), null, 2));
  appendProvenanceEvent(realRoot, {
    id: `mnemon-graph-${Date.now()}`,
    kind: 'memory_graph',
    title: 'Mnemon memory graph refreshed',
    summary: `Wrote ${rows.length} memories into the Mnemon report and Obsidian Canvas graph.`,
    outputPaths: [
      report.relativePath,
      relativeSecondBrainPath(realRoot, canvasPath),
      relativeSecondBrainPath(realRoot, graphJsonPath),
    ],
    metadata: {
      memoryCount: rows.length,
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
    },
  });
  return {
    markdownPath: report.filePath,
    canvasPath,
    graphJsonPath,
    memoryCount: rows.length,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
  };
}

function resolveOptionalRoot(candidates: readonly string[], explicit?: unknown): string | undefined {
  if (typeof explicit === 'string' && explicit.trim()) return requireRoot(explicit.trim());
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return requireRoot(candidate);
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

function resolveCodexProjectsRoot(explicit?: unknown): string {
  const root = resolveOptionalRoot(CODEX_PROJECTS_ROOT_CANDIDATES, explicit);
  if (root) return root;
  throw new Error(
    `Codex projects root is not mounted. Mount your selected Codex projects folder read-only at ${CODEX_PROJECTS_ROOT_CANDIDATES[0]}.`,
  );
}

function commandOutput(command: string, args: string[], cwd: string): { ok: boolean; stdout: string } {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf-8',
    timeout: 10_000,
    maxBuffer: 256_000,
  });
  return {
    ok: result.status === 0,
    stdout: (result.stdout || '').trim(),
  };
}

function readJsonObject(filePath: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function detectProjectStack(projectPath: string): { stack: string[]; scripts: string[] } {
  const stack = new Set<string>();
  const scripts: string[] = [];
  const packageJson = readJsonObject(path.join(projectPath, 'package.json'));
  if (packageJson) {
    stack.add('node');
    const deps = {
      ...(typeof packageJson.dependencies === 'object' && packageJson.dependencies ? packageJson.dependencies : {}),
      ...(typeof packageJson.devDependencies === 'object' && packageJson.devDependencies
        ? packageJson.devDependencies
        : {}),
    } as Record<string, unknown>;
    if ('next' in deps) stack.add('next');
    if ('vite' in deps) stack.add('vite');
    if ('react' in deps) stack.add('react');
    if ('typescript' in deps) stack.add('typescript');
    const packageScripts = packageJson.scripts;
    if (typeof packageScripts === 'object' && packageScripts) {
      for (const key of Object.keys(packageScripts).slice(0, 8)) scripts.push(key);
    }
  }
  if (
    fs.existsSync(path.join(projectPath, 'pyproject.toml')) ||
    fs.existsSync(path.join(projectPath, 'requirements.txt'))
  ) {
    stack.add('python');
  }
  if (
    fs.existsSync(path.join(projectPath, 'Dockerfile')) ||
    fs.existsSync(path.join(projectPath, 'docker-compose.yml'))
  ) {
    stack.add('docker');
  }
  if (fs.existsSync(path.join(projectPath, 'vercel.json'))) stack.add('vercel');
  if (fs.existsSync(path.join(projectPath, 'supabase'))) stack.add('supabase');
  return { stack: [...stack].sort(), scripts };
}

function scanCodexProject(projectsRoot: string, projectPath: string): CodexProjectStatus {
  const name = path.basename(projectPath);
  const relativePath = toRelativeDisplayPath(projectsRoot, projectPath);
  const stat = fs.statSync(projectPath);
  const hasGit = fs.existsSync(path.join(projectPath, '.git'));
  let branch = 'not a git repo';
  let dirtyCount = 0;
  let statusLine = 'No git status available';
  let recentCommits: string[] = [];
  if (hasGit) {
    const branchOutput = commandOutput('git', ['rev-parse', '--abbrev-ref', 'HEAD'], projectPath);
    if (branchOutput.ok && branchOutput.stdout) branch = branchOutput.stdout.split(/\r?\n/)[0] ?? 'unknown';
    const statusOutput = commandOutput('git', ['status', '--short', '--branch'], projectPath);
    if (statusOutput.ok) {
      const lines = statusOutput.stdout.split(/\r?\n/).filter(Boolean);
      statusLine = lines[0] ?? `## ${branch}`;
      dirtyCount = lines.filter((line) => !line.startsWith('##')).length;
    }
    const logOutput = commandOutput('git', ['log', '--oneline', '--decorate=short', '-3'], projectPath);
    if (logOutput.ok) recentCommits = logOutput.stdout.split(/\r?\n/).filter(Boolean);
  }
  const { stack, scripts } = detectProjectStack(projectPath);
  return {
    name,
    relativePath,
    branch,
    dirtyCount,
    statusLine,
    recentCommits,
    stack,
    scripts,
    hasGit,
    modified: timestamp(stat.mtime),
  };
}

function discoverCodexProjects(
  projectsRoot: string,
  maxProjects: number,
): { projects: CodexProjectStatus[]; skipped: CodexStatusIndex['skipped'] } {
  const skipped: CodexStatusIndex['skipped'] = [];
  const entries = fs
    .readdirSync(projectsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !/backup/i.test(entry.name))
    .slice(0, maxProjects);
  const projects: CodexProjectStatus[] = [];
  for (const entry of entries) {
    const projectPath = path.join(projectsRoot, entry.name);
    try {
      const hasSignals =
        fs.existsSync(path.join(projectPath, '.git')) ||
        fs.existsSync(path.join(projectPath, 'package.json')) ||
        fs.existsSync(path.join(projectPath, 'README.md')) ||
        fs.existsSync(path.join(projectPath, 'pyproject.toml'));
      if (!hasSignals) {
        skipped.push({ path: entry.name, reason: 'no git/package/readme project signal' });
        continue;
      }
      projects.push(scanCodexProject(projectsRoot, projectPath));
    } catch (e) {
      skipped.push({ path: entry.name, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return {
    projects: projects.sort((a, b) => b.dirtyCount - a.dirtyCount || a.name.localeCompare(b.name)),
    skipped,
  };
}

function readCodexMemorySignals(explicit?: unknown): { root?: string; signals: string[] } {
  const memoryRoot = resolveOptionalRoot(CODEX_MEMORY_ROOT_CANDIDATES, explicit);
  if (!memoryRoot) return { signals: [] };
  const signals: string[] = [];
  const summaryPath = path.join(memoryRoot, 'memory_summary.md');
  if (fs.existsSync(summaryPath)) {
    const summary = fs.readFileSync(summaryPath, 'utf-8');
    const projectLines = summary
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(
        (line) =>
          /^- .*cwd=\/Users\/[^/]+\/Documents\/Codex\//.test(line) ||
          /^#### \/Users\/[^/]+\/Documents\/Codex\//.test(line) ||
          /^- .*cwd=\/workspace\/extra\/codex-projects\//.test(line) ||
          /^#### \/workspace\/extra\/codex-projects\//.test(line),
      )
      .slice(0, 30);
    signals.push(...projectLines);
  }
  const rolloutDir = path.join(memoryRoot, 'rollout_summaries');
  if (fs.existsSync(rolloutDir)) {
    const recent = fs
      .readdirSync(rolloutDir)
      .filter((file) => file.endsWith('.md'))
      .map((file) => ({ file, stat: fs.statSync(path.join(rolloutDir, file)) }))
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
      .slice(0, 12)
      .map(({ file }) => `- ${file.replace(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/, '').replace(/\.md$/, '')}`);
    signals.push(...recent);
  }
  return { root: memoryRoot, signals: signals.slice(0, 40) };
}

function codexStatusIndexPaths(root: string): { dir: string; json: string } {
  const realRoot = requireRoot(root);
  const paths = contextIndexPaths(realRoot);
  return { dir: paths.dir, json: path.join(paths.dir, CODEX_STATUS_INDEX_FILE) };
}

function readQueueRecords(dir: string, status: string): QueueSummary['recent'] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => {
      try {
        const record = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')) as Record<string, unknown>;
        const id = typeof record.id === 'string' ? record.id : path.basename(file, '.json');
        const title =
          typeof record.projectName === 'string'
            ? `${record.projectName}: ${typeof record.task === 'string' ? record.task : 'Codex handoff'}`
            : typeof record.title === 'string'
              ? record.title
              : typeof record.brief === 'string'
                ? record.brief
                : id;
        return {
          id: scrubPrivateText(id),
          title: scrubPrivateText(truncateText(title, 160)),
          status,
          createdAt: typeof record.createdAt === 'string' ? record.createdAt : undefined,
          target: typeof record.target === 'string' ? scrubPrivateText(record.target) : undefined,
        };
      } catch {
        return {
          id: scrubPrivateText(path.basename(file, '.json')),
          title: 'Unreadable queue item',
          status,
        };
      }
    });
}

function queueSummary(root: string, queueDirName: string): QueueSummary {
  const realRoot = requireRoot(root);
  const paths = contextIndexPaths(realRoot);
  const base = path.join(paths.dir, queueDirName);
  const dirs = {
    queued: path.join(base, 'queued'),
    submitted: path.join(base, 'submitted'),
    completed: path.join(base, 'completed'),
    failed: path.join(base, 'failed'),
  };
  const records = [
    ...readQueueRecords(dirs.queued, 'queued'),
    ...readQueueRecords(dirs.submitted, 'submitted'),
    ...readQueueRecords(dirs.completed, 'completed'),
    ...readQueueRecords(dirs.failed, 'failed'),
  ].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || a.id.localeCompare(b.id));
  return {
    queued: fs.existsSync(dirs.queued)
      ? fs.readdirSync(dirs.queued).filter((file) => file.endsWith('.json')).length
      : 0,
    submitted: fs.existsSync(dirs.submitted)
      ? fs.readdirSync(dirs.submitted).filter((file) => file.endsWith('.json')).length
      : 0,
    completed: fs.existsSync(dirs.completed)
      ? fs.readdirSync(dirs.completed).filter((file) => file.endsWith('.json')).length
      : 0,
    failed: fs.existsSync(dirs.failed)
      ? fs.readdirSync(dirs.failed).filter((file) => file.endsWith('.json')).length
      : 0,
    recent: records.slice(0, 5),
  };
}

function queueSummaryMarkdown(title: string, summary: QueueSummary): string[] {
  return [
    `### ${title}`,
    `Queued: ${summary.queued}`,
    `Submitted: ${summary.submitted}`,
    `Completed: ${summary.completed}`,
    `Failed: ${summary.failed}`,
    '',
    summary.recent.length > 0
      ? summary.recent
          .map(
            (item) =>
              `- ${item.status}: ${item.title} (${item.id}${item.target ? `; target ${item.target}` : ''}${item.createdAt ? `; ${item.createdAt}` : ''})`,
          )
          .join('\n')
      : 'No queued or recently processed items detected.',
  ];
}

function operationLogPath(root: string): string {
  return path.join(contextIndexPaths(root).dir, 'operations-log.jsonl');
}

function appendOperationEvent(
  root: string,
  event: {
    kind: 'codex_handoff' | 'action_request';
    id: string;
    status: 'queued' | 'running' | 'submitted' | 'completed' | 'failed' | 'skipped' | 'dry_run' | 'blocked';
    title: string;
    detail?: string;
    target?: string;
  },
): void {
  const realRoot = requireRoot(root);
  const paths = contextIndexPaths(realRoot);
  fs.mkdirSync(paths.dir, { recursive: true });
  const eventTimestamp = timestamp(new Date());
  fs.appendFileSync(
    operationLogPath(realRoot),
    `${JSON.stringify({
      version: 1,
      timestamp: eventTimestamp,
      id: scrubPrivateText(event.id),
      kind: event.kind,
      status: event.status,
      title: scrubPrivateText(event.title),
      detail: event.detail ? scrubPrivateText(event.detail) : undefined,
      target: event.target ? scrubPrivateText(event.target) : undefined,
    })}\n`,
  );
  appendProvenanceEvent(realRoot, {
    id: `${event.kind}-${event.id}-${event.status}`,
    kind: event.status === 'queued' ? 'queue_created' : 'queue_progress',
    title: `${event.kind} ${event.status}`,
    summary: event.detail,
    outputPaths: ['.dc-index/operations-log.jsonl'],
    metadata: {
      queueId: event.id,
      queueKind: event.kind,
      status: event.status,
      target: event.target,
      eventTimestamp,
    },
  });
}

function readOperationEvents(root: string, limit = 12): string[] {
  const filePath = operationLogPath(root);
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf-8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-limit)
    .reverse()
    .map((line) => {
      try {
        const event = JSON.parse(line) as {
          timestamp?: string;
          status?: string;
          kind?: string;
          id?: string;
          detail?: string;
        };
        return `- ${event.timestamp ?? 'unknown'}: ${event.status ?? 'unknown'} ${event.kind ?? 'work'} ${event.id ?? 'unknown'}${event.detail ? ` - ${event.detail}` : ''}`;
      } catch {
        return '- Unreadable progress event';
      }
    });
}

function unifiedQueueStatusMarkdown(root: string): string {
  const handoffs = queueSummary(root, CODEX_HANDOFF_DIR);
  const actions = queueSummary(root, ACTION_REQUEST_DIR);
  const active = handoffs.queued + handoffs.submitted + actions.queued + actions.submitted;
  return [
    `# Distributed Cognition Work Queue — ${timestamp(new Date())}`,
    '',
    '## Summary',
    `- Active work items: ${active}`,
    `- Failed work items: ${handoffs.failed + actions.failed}`,
    '',
    ...queueSummaryMarkdown('Codex Handoffs', handoffs),
    '',
    ...queueSummaryMarkdown('Action Requests', actions),
    '',
    '## Recent Progress Events',
    ...(readOperationEvents(root).length > 0 ? readOperationEvents(root) : ['No progress events recorded yet.']),
    '',
  ].join('\n');
}

function markdownFiles(root: string, folders: readonly string[]): Array<{ relativePath: string; content: string }> {
  const realRoot = requireRoot(root);
  const files: Array<{ relativePath: string; content: string }> = [];
  for (const folder of folders) {
    const dir = path.join(realRoot, folder);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.md'))) {
      files.push({ relativePath: `${folder}/${file}`, content: fs.readFileSync(path.join(dir, file), 'utf-8') });
    }
  }
  return files;
}

function markdownField(markdown: string, label: string): string {
  const match = markdown.match(new RegExp(`^${label}:\\s*(.+)$`, 'im'));
  return match?.[1]?.trim() || 'unspecified';
}

function attentionCalibrationMarkdown(root: string): string {
  const notes = markdownFiles(root, [
    'daily-reflections',
    'processed-notes',
    'pending-review',
    'weekly-reviews',
    'decision-log',
    'open-questions',
  ]);
  const scored = notes
    .filter((note) => /^## Attention metadata\b/m.test(note.content))
    .map((note) => ({
      path: note.relativePath,
      importance: markdownField(note.content, 'Importance'),
      durability: markdownField(note.content, 'Durability'),
      actionability: markdownField(note.content, 'Actionability'),
      timeSensitivity: markdownField(note.content, 'Time sensitivity'),
      rationale: markdownField(note.content, 'Rationale'),
    }));
  const count = (field: keyof (typeof scored)[number], value: string) =>
    scored.filter((item) => item[field] === value).length;
  const promotions = readProvenanceEvents(root, 1_000).filter((event) => event.kind === 'memory_promotion').length;
  const coaching = readProvenanceEvents(root, 1_000).filter((event) => event.kind === 'coaching_prompt').length;
  return [
    ...frontmatterBlock({
      type: 'attention_calibration',
      generated: timestamp(new Date()),
      tags: ['distributed-cognition/attention'],
    }),
    '',
    `# Attention Calibration — ${timestamp(new Date())}`,
    '',
    '## Summary',
    `- Captures scored: ${scored.length}`,
    `- Durable memories promoted: ${promotions}`,
    `- Coaching prompts generated: ${coaching}`,
    `- High importance: ${count('importance', 'high')}`,
    `- Medium importance: ${count('importance', 'medium')}`,
    `- Low importance: ${count('importance', 'low')}`,
    `- Durable: ${count('durability', 'durable')}`,
    `- Useful but not durable: ${count('durability', 'useful')}`,
    `- Transient: ${count('durability', 'transient')}`,
    '',
    '## Calibration Feedback',
    '- Say "DC, promote more decisions" if important choices are staying as loose notes.',
    '- Say "DC, ignore logistics" if low-value meeting clutter is being over-scored.',
    '- Say "DC, challenge me more" if reflections are being filed without useful follow-up questions.',
    '- Say "DC, remember fewer things" if Mnemon starts feeling noisy.',
    '',
    '## Recent Attention Decisions',
    scored.length > 0
      ? scored
          .slice(-12)
          .reverse()
          .map(
            (item) =>
              `- [[${item.path}]] — ${item.importance}, ${item.durability}, ${item.actionability}, ${item.timeSensitivity}; ${item.rationale}`,
          )
          .join('\n')
      : 'No scored captures found yet.',
    '',
  ].join('\n');
}

function memoryHygieneMarkdown(root: string): string {
  const approved = markdownFiles(root, ['approved-updates']);
  const review = markdownFiles(root, ['pending-review', 'decision-log', 'weekly-reviews']);
  const auditNotes = approved.filter((note) => /\bDurable Memory Upgrade\b|## Mnemon\b/i.test(note.content));
  const changedMind = review.filter((note) => /\bchanged my mind|obsolete|superseded|supersedes\b/i.test(note.content));
  const corrections = review.filter((note) => /\bforget_or_correction_request|correction|forget\b/i.test(note.content));
  const stale = review.filter((note) => /\bReview after:\s*(?!None detected)/i.test(note.content));
  const links = (items: Array<{ relativePath: string }>) =>
    items.length > 0 ? items.slice(0, 20).map((item) => `- [[${item.relativePath}]]`) : ['- None found'];
  return [
    ...frontmatterBlock({
      type: 'memory_hygiene',
      generated: timestamp(new Date()),
      tags: ['distributed-cognition/memory-hygiene'],
    }),
    '',
    `# Memory Hygiene — ${timestamp(new Date())}`,
    '',
    '## Current Rules',
    '- Mnemon should contain durable keys, pivots, decisions, preferences, corrections, and stable project constraints.',
    '- Raw transcripts, ordinary meeting clutter, and tentative mood should stay in Markdown.',
    '- Changed thinking should create a dated changed-my-mind or supersession note instead of silently overwriting memory.',
    '',
    '## Durable Memory Audit Notes',
    ...links(auditNotes),
    '',
    '## Changed-My-Mind / Supersession Candidates',
    ...links(changedMind),
    '',
    '## Correction / Forget Candidates',
    ...links(corrections),
    '',
    '## Decisions With Review Windows',
    ...links(stale),
    '',
  ].join('\n');
}

function projectOntologyMarkdown(root: string): string {
  const notes = markdownFiles(root, [
    'daily-reflections',
    'processed-notes',
    'pending-review',
    'weekly-reviews',
    'decision-log',
  ]);
  const sourcesBySignal = new Map<string, string[]>();
  for (const note of notes) {
    for (const signal of projectSignals(note.content)) {
      const sources = sourcesBySignal.get(signal) ?? [];
      if (!sources.includes(note.relativePath)) sources.push(note.relativePath);
      sourcesBySignal.set(signal, sources);
    }
  }
  const node = (label: string) => {
    const sources = sourcesBySignal.get(label) ?? [];
    return `- **${label}** — ${
      sources.length > 0
        ? sources
            .slice(0, 5)
            .map((source) => `[[${source}]]`)
            .join(', ')
        : 'not yet observed in notes'
    }`;
  };
  return [
    ...frontmatterBlock({
      type: 'project_ontology',
      generated: timestamp(new Date()),
      tags: ['distributed-cognition/ontology'],
    }),
    '',
    `# Project Ontology — ${timestamp(new Date())}`,
    '',
    '## Projects',
    ...['AIME', 'p(AI)tient', 'CORTEX', 'CREATE Hackathon'].map(node),
    '',
    '## Themes',
    ...[
      'AI-enhanced assessment',
      'productive struggle',
      'discernment',
      'uncertainty tolerance',
      'wisdom',
      'education strategy and governance',
    ].map(node),
    '',
    '## Workflows',
    ...['grants', 'papers and manuscripts', 'workshops and talks'].map(node),
    '',
    '## Usage Rule',
    '- Mnemon stores concise pivots; wiki pages store readable synthesis; raw transcripts stay raw.',
    '',
  ].join('\n');
}

function provenanceMarkdown(root: string): string {
  const events = readProvenanceEvents(root, 200);
  const counts = new Map<string, number>();
  for (const event of events) counts.set(event.kind ?? 'unknown', (counts.get(event.kind ?? 'unknown') ?? 0) + 1);
  return [
    ...frontmatterBlock({
      type: 'provenance_ledger',
      generated: timestamp(new Date()),
      tags: ['distributed-cognition/provenance'],
    }),
    '',
    `# Provenance Ledger — ${timestamp(new Date())}`,
    '',
    '## Counts',
    events.length > 0
      ? [...counts.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([kind, count]) => `- ${kind}: ${count}`)
          .join('\n')
      : '- None recorded',
    '',
    '## Recent Events',
    events.length > 0
      ? events
          .slice(-20)
          .reverse()
          .map((event) => `- ${event.timestamp ?? 'unknown'}: ${event.kind ?? 'event'} — ${event.title ?? 'untitled'}`)
          .join('\n')
      : 'No provenance events recorded yet.',
    '',
  ].join('\n');
}

function codexStatusMarkdown(index: CodexStatusIndex): string {
  const dirty = index.projects.filter((project) => project.dirtyCount > 0);
  const tableRows = index.projects.map((project) =>
    [
      project.name,
      project.hasGit ? project.branch : 'no git',
      project.dirtyCount > 0 ? String(project.dirtyCount) : 'clean',
      project.stack.join(', ') || 'unknown',
      project.recentCommits[0] || 'No recent commit available',
      `codex-projects/${project.relativePath}`,
    ].join(' | '),
  );
  return [
    ...frontmatterBlock({
      type: 'codex_workbench',
      generated: index.generatedAt,
      tags: ['distributed-cognition/codex'],
    }),
    '',
    `# Codex Workbench — ${index.generatedAt}`,
    '',
    '## Status',
    `Generated: ${index.generatedAt}`,
    `Projects root: ${index.projectsRoot}`,
    index.memoryRoot ? `Codex memory summaries: ${index.memoryRoot}` : 'Codex memory summaries: not mounted',
    '',
    '## Project Index',
    'Project | Branch | Dirty files | Stack | Recent commit | Mounted path',
    '--- | --- | ---: | --- | --- | ---',
    ...tableRows,
    '',
    '## Dirty Or Active-Looking Projects',
    dirty.length > 0
      ? dirty
          .map((project) => `- ${project.name}: ${project.dirtyCount} changed file(s); ${project.statusLine}`)
          .join('\n')
      : 'No dirty git worktrees detected in the mounted Codex projects.',
    '',
    '## Recent Codex Memory Signals',
    index.memorySignals.length > 0 ? index.memorySignals.join('\n') : 'No Codex memory summary mount is available.',
    '',
    '## Handoff Queue',
    'WhatsApp-to-Codex requests are queued under `.dc-index/codex-handoffs/queued/` and mirrored as Markdown notes in `pending-review/`.',
    '',
    ...queueSummaryMarkdown('Codex Handoffs', index.handoffSummary),
    '',
    ...queueSummaryMarkdown('Action Requests', index.actionSummary),
    '',
    '## Safety Notes',
    '- This page is an index, not a raw transcript dump.',
    '- Do not include secrets, patient-identifiable, learner-identifiable, HR, exam, or confidential institutional data in Codex handoffs.',
    '- Local Codex execution requires a host-side allowlisted project mapping.',
    '- Codex Cloud submission is non-default and requires an explicit host-side environment mapping.',
    '',
  ].join('\n');
}

function writeCodexStatusIndex(root: string, index: CodexStatusIndex): { wikiPath: string; jsonPath: string } {
  const paths = codexStatusIndexPaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.json, `${JSON.stringify(index, null, 2)}\n`);
  const wiki = resolveProjectWikiPath(root, 'Codex Workbench', 'project-wikis/codex-workbench.md');
  fs.writeFileSync(wiki.filePath, codexStatusMarkdown(index));
  return { wikiPath: wiki.filePath, jsonPath: paths.json };
}

function loadCodexStatusIndex(root: string): CodexStatusIndex | undefined {
  const pathInfo = codexStatusIndexPaths(root);
  if (!fs.existsSync(pathInfo.json)) return undefined;
  const parsed = JSON.parse(fs.readFileSync(pathInfo.json, 'utf-8')) as CodexStatusIndex;
  return parsed.version === CODEX_STATUS_VERSION ? parsed : undefined;
}

function matchCodexProject(root: string, projectName: string, projectsRoot?: unknown): CodexProjectStatus {
  const requested = projectName.trim();
  if (
    !requested ||
    requested.includes('\0') ||
    requested.includes('/') ||
    requested.includes('\\') ||
    requested === '..'
  ) {
    throw new Error(`Unsafe Codex project name: ${projectName}`);
  }
  let projects = loadCodexStatusIndex(root)?.projects;
  if (!projects || projects.length === 0) {
    const scanRoot = resolveCodexProjectsRoot(projectsRoot);
    projects = discoverCodexProjects(scanRoot, MAX_CODEX_PROJECTS).projects;
  }
  const requestedSlug = slug(requested);
  const lower = requested.toLowerCase();
  const matches = projects.filter(
    (project) =>
      project.name.toLowerCase() === lower ||
      slug(project.name) === requestedSlug ||
      project.relativePath.toLowerCase() === lower,
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous Codex project "${projectName}". Matches: ${matches.map((project) => project.name).join(', ')}`,
    );
  }
  throw new Error(
    `Codex project "${projectName}" was not found in the latest Codex status index. Rebuild the status index or use the exact folder name.`,
  );
}

function codexHandoffDirs(root: string): { base: string; queued: string; submitted: string; failed: string } {
  const realRoot = requireRoot(root);
  const paths = contextIndexPaths(realRoot);
  const base = path.join(paths.dir, CODEX_HANDOFF_DIR);
  return {
    base,
    queued: path.join(base, 'queued'),
    submitted: path.join(base, 'submitted'),
    failed: path.join(base, 'failed'),
  };
}

function writeCodexHandoff(
  root: string,
  record: CodexHandoffRecord,
  markdown: string,
): { notePath: string; queuePath: string } {
  const noteFile = filename(new Date(), `codex-handoff-${record.projectName}`);
  const notePath = writeNew(resolveNotePath(root, 'pending-review', noteFile), markdown);
  record.notePath = toRelativeDisplayPath(requireRoot(root), notePath);
  const dirs = codexHandoffDirs(root);
  fs.mkdirSync(dirs.queued, { recursive: true });
  fs.mkdirSync(dirs.submitted, { recursive: true });
  fs.mkdirSync(dirs.failed, { recursive: true });
  const queuePath = path.join(dirs.queued, `${record.id}.json`);
  fs.writeFileSync(queuePath, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
  appendOperationEvent(root, {
    kind: 'codex_handoff',
    id: record.id,
    status: 'queued',
    title: `${record.projectName}: ${record.task}`,
    target: record.target,
    detail: 'Queued by WhatsApp Distributed Cognition.',
  });
  return { notePath, queuePath };
}

function codexHandoffMarkdown(record: CodexHandoffRecord, project: CodexProjectStatus): string {
  const sourceNotes =
    record.sourceNotePaths.length > 0
      ? record.sourceNotePaths.map((source) => `- ${source}`).join('\n')
      : '- Current WhatsApp conversation / no source note supplied.';
  return [
    ...frontmatterBlock({
      type: 'codex_handoff',
      created: record.createdAt,
      status: record.status,
      target: record.target,
      project: project.name,
      tags: ['distributed-cognition/codex-handoff'],
    }),
    '',
    `# Codex Handoff — ${project.name} — ${record.createdAt}`,
    '',
    '## Status',
    'queued',
    '',
    '## Lifecycle',
    '- drafted: DC composed the task, plan, and acceptance criteria.',
    '- queued: machine-readable handoff is waiting under `.dc-index/codex-handoffs/queued/`.',
    '- executing: host Codex bridge has started local or cloud execution.',
    '- blocked: host bridge needs configuration, allowlist, credentials, or clarification.',
    '- completed: bridge moved the record to completed and updated this note.',
    '- needs review: Minyang reviews changed files, tests, and residual risk.',
    '',
    '## Project',
    `- Name: ${project.name}`,
    `- Relative path: ${project.relativePath}`,
    `- Branch: ${record.branch || project.branch}`,
    `- Current dirty files at queue time: ${project.dirtyCount}`,
    `- Target: ${record.target}`,
    record.cloudEnv
      ? `- Requested Codex Cloud env: ${record.cloudEnv}`
      : '- Requested Codex Cloud env: none / host bridge mapping only if explicitly using codex-cloud',
    '',
    '## Task',
    record.task,
    '',
    '## Proposed Plan',
    record.planMarkdown?.trim() ||
      'No explicit plan supplied. Local Codex should inspect the repo and create a short plan before editing.',
    '',
    '## Acceptance Criteria',
    record.acceptanceCriteria?.length
      ? record.acceptanceCriteria.map((criterion) => `- ${criterion}`).join('\n')
      : '- Use project-appropriate verification and report changed files, tests, and residual risk.',
    '',
    '## Source Notes',
    sourceNotes,
    '',
    '## Host Bridge',
    'A host-side bridge should execute this queued item locally with Codex by default. Codex Cloud may be used only if the handoff explicitly targets codex-cloud and the host config allowlists an environment id.',
    '',
    '## Safety',
    '- Do not include secrets or prohibited sensitive data in this handoff.',
    '- The WhatsApp agent queues the request; host-side execution is handled by the Codex bridge with an allowlisted project/environment map.',
    '',
  ].join('\n');
}

function normalizeActionType(input: unknown): ActionType {
  if (typeof input !== 'string') return 'manual_review';
  const value = input
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '_');
  return ACTION_TYPES.includes(value as ActionType) ? (value as ActionType) : 'manual_review';
}

function actionRequestDirs(root: string): { base: string; queued: string; completed: string; failed: string } {
  const realRoot = requireRoot(root);
  const paths = contextIndexPaths(realRoot);
  const base = path.join(paths.dir, ACTION_REQUEST_DIR);
  return {
    base,
    queued: path.join(base, 'queued'),
    completed: path.join(base, 'completed'),
    failed: path.join(base, 'failed'),
  };
}

function actionRequestMarkdown(record: ActionRequestRecord): string {
  const sourceNotes =
    record.sourceNotePaths.length > 0
      ? record.sourceNotePaths.map((source) => `- ${source}`).join('\n')
      : '- Current WhatsApp conversation / no source note supplied.';
  return [
    ...frontmatterBlock({
      type: 'action_request',
      created: record.createdAt,
      status: record.status,
      target: record.target ?? 'host bridge default',
      action_type: record.actionType,
      tags: ['distributed-cognition/action'],
    }),
    '',
    `# Action Request — ${record.title} — ${record.createdAt}`,
    '',
    '## Status',
    'queued',
    '',
    '## Lifecycle',
    '- drafted: DC composed the artifact/research request.',
    '- queued: machine-readable request is waiting under `.dc-index/action-requests/queued/`.',
    '- executing: host action bridge has started local work.',
    '- blocked: bridge needs missing config, an allowlisted action, or clarification.',
    '- completed: artifact or local handoff output is available.',
    '- needs review: Minyang checks the result before reuse or sharing.',
    '',
    '## Action Type',
    record.actionType,
    '',
    '## Target',
    record.target ?? 'host bridge default',
    '',
    '## Brief',
    record.brief,
    '',
    record.outputName ? `## Requested Output Name\n${record.outputName}\n` : undefined,
    record.contentMarkdown ? `## Draft Content\n${record.contentMarkdown}\n` : undefined,
    '## Source Notes',
    sourceNotes,
    '',
    '## Host Bridge',
    'A host-side bridge may execute this request only if the action type is allowlisted. Coding/repo work should be routed to Codex handoffs; local artifact work may produce files under `action-outputs/`.',
    '',
    '## Safety',
    '- Do not include secrets or prohibited sensitive data in this action.',
    '- Do not send external communications without explicit confirmation.',
    '- Local file outputs must stay inside the configured Distributed Cognition output folder.',
    '',
  ]
    .filter((line): line is string => typeof line === 'string')
    .join('\n');
}

function writeActionRequest(
  root: string,
  record: ActionRequestRecord,
  markdown: string,
): { notePath: string; queuePath: string } {
  const noteFile = filename(new Date(), `action-${record.actionType}-${record.title}`);
  const notePath = writeNew(resolveNotePath(root, 'pending-review', noteFile), markdown);
  record.notePath = toRelativeDisplayPath(requireRoot(root), notePath);
  const dirs = actionRequestDirs(root);
  fs.mkdirSync(dirs.queued, { recursive: true });
  fs.mkdirSync(dirs.completed, { recursive: true });
  fs.mkdirSync(dirs.failed, { recursive: true });
  const queuePath = path.join(dirs.queued, `${record.id}.json`);
  fs.writeFileSync(queuePath, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
  appendOperationEvent(root, {
    kind: 'action_request',
    id: record.id,
    status: 'queued',
    title: `${record.actionType}: ${record.title}`,
    target: record.target,
    detail: 'Queued by WhatsApp Distributed Cognition.',
  });
  return { notePath, queuePath };
}

function resolveWorkspaceFile(filePath: string): string {
  const resolved = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve('/workspace/agent', filePath);
  const workspace = fs.realpathSync('/workspace');
  const real = fs.realpathSync(resolved);
  const rel = path.relative(workspace, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Refusing to read outside /workspace: ${filePath}`);
  }
  return real;
}

function readEnvValueFromText(content: string, key: string): string | undefined {
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const envKey = trimmed.slice(0, eqIdx).trim();
    if (envKey !== key) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    return value.trim() || undefined;
  }
  return undefined;
}

export function resolveOpenAIApiKeyForTranscription(
  env: Record<string, string | undefined> = process.env,
  envFiles = ROOT_CANDIDATES.map((root) => path.join(root, '.env')),
): string | undefined {
  const direct = env.OPENAI_API_KEY?.trim();
  if (direct) return direct;

  for (const envFile of envFiles) {
    try {
      const value = readEnvValueFromText(fs.readFileSync(envFile, 'utf-8'), 'OPENAI_API_KEY');
      if (value) return value;
    } catch {
      // Missing or unreadable fallback env files are expected on many installs.
    }
  }

  return undefined;
}

async function transcribeAudioFile(
  inputPath: string,
  options: { prompt?: string; language?: string } = {},
): Promise<string> {
  const apiKey = resolveOpenAIApiKeyForTranscription();
  if (!apiKey)
    throw new Error('OPENAI_API_KEY is not available in the container environment or mounted second-brain .env');
  if (!inputPath) throw new Error('path is required');
  const realPath = resolveWorkspaceFile(inputPath);
  const data = fs.readFileSync(realPath);
  const client = new OpenAI({ apiKey });
  const text = await client.audio.transcriptions.create({
    model: 'gpt-4o-mini-transcribe',
    file: await toFile(data, path.basename(realPath)),
    prompt: options.prompt?.trim() || undefined,
    language: options.language?.trim() || undefined,
    response_format: 'text',
  });
  return text.trim();
}

function captureAudioTranscript(inputPath: string, transcript: string, args: Record<string, unknown> = {}): string {
  const cleanTranscript = transcript.trim();
  if (!cleanTranscript) throw new Error('Audio transcription returned empty text');
  const type = classify(cleanTranscript);
  if (type === 'sensitive_data_warning') {
    const root = rootPath(args.root);
    ensureFolders(root);
    const now = new Date();
    const ts = timestamp(now);
    const temporal = extractTemporalMetadata(
      'Audio transcript withheld because prohibited sensitive content was detected.',
      now,
      type,
    );
    const attention = scoreAttention(
      'Audio transcript withheld because prohibited sensitive content was detected.',
      type,
      temporal,
    );
    const file = filename(now, (args.slug as string | undefined) ?? 'redacted-audio-sensitive-warning');
    const sourceMessageId = sourceMessageIdFromArgs(args, inputPath);
    const rawPath = writeNew(
      resolveNotePath(root, 'inbox-whatsapp', file),
      rawTemplate(
        type,
        ts,
        'Transcript withheld because prohibited sensitive content was detected. Ask the owner to resend a redacted version before processing.',
        'whatsapp-audio',
        temporal,
        attention,
        inputPath,
        sourceMessageId,
      ),
    );
    const processedPath = writeNew(
      resolveNotePath(root, 'pending-review', file),
      ensureCaptureMetadataMarkdown(
        [
          `# Sensitive Audio Warning — ${ts}`,
          '',
          '## Source',
          'WhatsApp audio from the owner.',
          '',
          '## Raw note status',
          'Transcript withheld because prohibited sensitive content was detected.',
          '',
          '## Suggested next action',
          'Ask the owner to resend a redacted version before processing.',
          '',
        ].join('\n'),
        temporal,
        attention,
      ),
    );
    appendCaptureProvenance(root, {
      id: file.replace(/\.md$/, ''),
      type,
      rawPath,
      processedPath,
      attention,
      coaching: reflectionCoachingPrompt(
        'Audio transcript withheld because prohibited sensitive content was detected.',
        type,
        attention,
      ),
    });
    return `Audio transcript appears to contain prohibited sensitive data. Wrote redacted audit markers only.\nraw: ${rawPath}\nprocessed: ${processedPath}`;
  }

  const root = rootPath(args.root);
  ensureFolders(root);
  const now = new Date();
  const ts = timestamp(now);
  const temporal = extractTemporalMetadata(cleanTranscript, now, type);
  const attention = scoreAttention(cleanTranscript, type, temporal);
  const file = filename(now, (args.slug as string | undefined) ?? cleanTranscript.split(/\s+/).slice(0, 7).join(' '));
  const sourceMessageId = sourceMessageIdFromArgs(args, inputPath);
  const rawPath = writeNew(
    resolveNotePath(root, 'inbox-whatsapp', file),
    rawTemplate(type, ts, cleanTranscript, 'whatsapp-audio', temporal, attention, inputPath, sourceMessageId),
  );
  const processedMarkdown =
    typeof args.processedMarkdown === 'string' && args.processedMarkdown.trim()
      ? ensureCaptureMetadataMarkdown(args.processedMarkdown, temporal, attention)
      : template(type, ts, cleanTranscript, temporal, attention);
  const processedPath = writeNew(resolveNotePath(root, processedFolder(type), file), processedMarkdown);
  const deadlineWatchPath = appendDeadlineWatch(root, temporal, path.join('inbox-whatsapp', path.basename(rawPath)));
  appendCaptureProvenance(root, {
    id: file.replace(/\.md$/, ''),
    type,
    rawPath,
    processedPath,
    deadlineWatchPath,
    attention,
    coaching: reflectionCoachingPrompt(cleanTranscript, type, attention),
  });

  return [
    `Captured audio as ${type}`,
    `raw: ${rawPath}`,
    `processed: ${processedPath}`,
    deadlineWatchPath ? `deadline watch: ${deadlineWatchPath}` : undefined,
    '',
    'Transcript:',
    cleanTranscript,
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}

export function captureAudioTranscriptForTest(
  inputPath: string,
  transcript: string,
  args: Record<string, unknown> = {},
): string {
  return captureAudioTranscript(inputPath, transcript, args);
}

export const captureNote: McpToolDefinition = {
  tool: {
    name: 'distributed_cognition_capture_note',
    description:
      'Safely write a Distributed Cognition WhatsApp capture into the mounted second-brain folder. Use this after classifying text or transcribed audio.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        rawText: { type: 'string', description: 'Original message text or audio transcript to preserve.' },
        messageType: {
          type: 'string',
          description: 'Optional classification. If omitted, a local classifier is used.',
        },
        slug: { type: 'string', description: 'Optional short filename slug.' },
        source: { type: 'string', description: 'whatsapp-text, whatsapp-audio, or manual.' },
        sourceMessageSeq: {
          type: 'number',
          description:
            'Optional numeric id from the incoming <message id="...">. Use this so text captures can be audited against the WhatsApp session row.',
        },
        sourceMessageId: {
          type: 'string',
          description:
            'Optional advanced session message id if already known. Usually prefer sourceMessageSeq from the prompt.',
        },
        audioPath: { type: 'string', description: 'Optional original audio path when source is whatsapp-audio.' },
        processedMarkdown: {
          type: 'string',
          description:
            'Optional fully processed Markdown note written by the agent. Use this to save actual synthesis instead of a placeholder template.',
        },
        root: { type: 'string', description: 'Optional second-brain root. Defaults to the mounted path.' },
      },
      required: ['rawText'],
    },
  },
  async handler(args) {
    try {
      const rawText = args.rawText as string;
      if (!rawText) return err('rawText is required');
      const root = rootPath(args.root);
      ensureFolders(root);
      const type = normalizeMessageType(args.messageType, rawText);
      const now = new Date();
      const ts = timestamp(now);
      const temporal = extractTemporalMetadata(rawText, now, type);
      const attention = scoreAttention(rawText, type, temporal);
      const file = filename(now, (args.slug as string | undefined) ?? rawText.split(/\s+/).slice(0, 7).join(' '));
      const sourceMessageId = sourceMessageIdFromArgs(args, args.audioPath as string | undefined);
      const rawPath = writeNew(
        resolveNotePath(root, 'inbox-whatsapp', file),
        rawTemplate(
          type,
          ts,
          rawText,
          (args.source as string) || 'whatsapp-text',
          temporal,
          attention,
          args.audioPath as string | undefined,
          sourceMessageId,
        ),
      );
      const processedMarkdown =
        typeof args.processedMarkdown === 'string' && args.processedMarkdown.trim()
          ? ensureCaptureMetadataMarkdown(args.processedMarkdown, temporal, attention)
          : template(type, ts, rawText, temporal, attention);
      const processedPath = writeNew(resolveNotePath(root, processedFolder(type), file), processedMarkdown);
      const deadlineWatchPath = appendDeadlineWatch(
        root,
        temporal,
        path.join('inbox-whatsapp', path.basename(rawPath)),
      );
      appendCaptureProvenance(root, {
        id: file.replace(/\.md$/, ''),
        type,
        rawPath,
        processedPath,
        deadlineWatchPath,
        attention,
        coaching: reflectionCoachingPrompt(rawText, type, attention),
      });
      return ok(
        [
          `Captured ${type}`,
          `raw: ${rawPath}`,
          `processed: ${processedPath}`,
          deadlineWatchPath ? `deadline watch: ${deadlineWatchPath}` : undefined,
        ]
          .filter(Boolean)
          .join('\n'),
      );
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

export const transcribeAudio: McpToolDefinition = {
  tool: {
    name: 'distributed_cognition_transcribe_audio',
    description:
      'Transcribe a WhatsApp audio recording saved under /workspace using OpenAI audio transcription. By default, also writes raw plus processed Markdown capture; set capture=false only for transcript preview.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Path to the audio file, usually /workspace/inbox/<message-id>/<file>.ogg.',
        },
        prompt: { type: 'string', description: 'Optional transcription prompt.' },
        language: { type: 'string', description: 'Optional ISO language hint.' },
        capture: {
          type: 'boolean',
          description:
            'Defaults to true. Set false only for preview; normal WhatsApp audio should be captured into second-brain.',
        },
        slug: { type: 'string', description: 'Optional short filename slug when capture is true.' },
        sourceMessageSeq: {
          type: 'number',
          description:
            'Optional numeric id from the incoming <message id="...">. Use this so the raw capture can be audited against the WhatsApp session row.',
        },
        sourceMessageId: {
          type: 'string',
          description:
            'Optional advanced session message id if already known. Usually prefer sourceMessageSeq from the prompt.',
        },
        processedMarkdown: {
          type: 'string',
          description: 'Optional fully processed Markdown note written when capture is true.',
        },
        root: { type: 'string', description: 'Optional second-brain root. Defaults to the mounted path.' },
      },
      required: ['path'],
    },
  },
  async handler(args) {
    try {
      const inputPath = args.path as string;
      const text = await transcribeAudioFile(inputPath, {
        prompt: typeof args.prompt === 'string' ? args.prompt : undefined,
        language: typeof args.language === 'string' ? args.language : undefined,
      });
      if (!text) return err('Audio transcription returned empty text');
      if (args.capture === false) {
        if (classify(text) === 'sensitive_data_warning') {
          return ok(
            'Transcript appears to contain prohibited sensitive data. No transcript was returned. Use distributed_cognition_capture_audio to write redacted audit markers only.',
          );
        }
        return ok(
          [
            'Transcript only; no second-brain files written. For WhatsApp audio reflections, call distributed_cognition_capture_note before replying.',
            '',
            text,
          ].join('\n'),
        );
      }
      return ok(captureAudioTranscript(inputPath, text, args));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

export const captureAudio: McpToolDefinition = {
  tool: {
    name: 'distributed_cognition_capture_audio',
    description:
      'Transcribe a WhatsApp audio recording, classify the transcript, and safely write raw plus processed Markdown notes into the mounted second-brain folder.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Path to the audio file, usually /workspace/inbox/<message-id>/<file>.ogg.',
        },
        prompt: { type: 'string', description: 'Optional transcription prompt.' },
        language: { type: 'string', description: 'Optional ISO language hint.' },
        slug: { type: 'string', description: 'Optional short filename slug.' },
        sourceMessageSeq: {
          type: 'number',
          description:
            'Optional numeric id from the incoming <message id="...">. Use this so the raw capture can be audited against the WhatsApp session row.',
        },
        sourceMessageId: {
          type: 'string',
          description:
            'Optional advanced session message id if already known. Usually prefer sourceMessageSeq from the prompt.',
        },
        processedMarkdown: {
          type: 'string',
          description: 'Optional fully processed Markdown note written by the agent after reading the transcript.',
        },
        root: { type: 'string', description: 'Optional second-brain root. Defaults to the mounted path.' },
      },
      required: ['path'],
    },
  },
  async handler(args) {
    try {
      const inputPath = args.path as string;
      const transcript = await transcribeAudioFile(inputPath, {
        prompt: typeof args.prompt === 'string' ? args.prompt : undefined,
        language: typeof args.language === 'string' ? args.language : undefined,
      });
      return ok(captureAudioTranscript(inputPath, transcript, args));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

export const preparePromotion: McpToolDefinition = {
  tool: {
    name: 'distributed_cognition_prepare_promotion',
    description:
      'Create a reviewed promotion proposal from raw/processed second-brain notes into an Obsidian-style project wiki update, with optional Mnemon candidates kept pending.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectName: { type: 'string', description: 'Human project name, e.g. p(AI)tient or CORTEX-OSCE.' },
        sourcePaths: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Relative second-brain Markdown paths to promote, e.g. inbox-whatsapp/17-05-26-0714-raw-audio-transcript.md.',
        },
        targetWikiPath: {
          type: 'string',
          description:
            'Optional target under project-wikis/, e.g. project-wikis/patient.md. Defaults to a stable project slug.',
        },
        promotionType: {
          type: 'string',
          description: 'Optional label such as wiki_update, decision_update, or argument_bank_update.',
        },
        proposedWikiMarkdown: {
          type: 'string',
          description:
            'Optional structured Markdown using ### Current State, ### Timeline, ### Decisions, ### Open Questions, ### Risks, ### Next Actions, ### Sources.',
        },
        currentState: {
          type: 'string',
          description: 'Optional current-state summary if proposedWikiMarkdown is not supplied.',
        },
        timeline: { type: 'array', items: { type: 'string' }, description: 'Optional timeline bullets.' },
        decisions: { type: 'array', items: { type: 'string' }, description: 'Optional decision bullets.' },
        openQuestions: { type: 'array', items: { type: 'string' }, description: 'Optional open-question bullets.' },
        risks: { type: 'array', items: { type: 'string' }, description: 'Optional risk bullets.' },
        nextActions: { type: 'array', items: { type: 'string' }, description: 'Optional next-action bullets.' },
        mnemonCandidates: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional durable-memory candidates. These are written as pending candidates, not stored in Mnemon.',
        },
        root: { type: 'string', description: 'Optional second-brain root. Defaults to the mounted path.' },
      },
      required: ['projectName', 'sourcePaths'],
    },
  },
  async handler(args) {
    try {
      const root = rootPath(args.root);
      ensureFolders(root);
      const now = new Date();
      const { markdown, proposalPath } = promotionProposalMarkdown(args, root, now);
      const written = writeNew(proposalPath, markdown);
      return ok(
        [
          'Prepared promotion proposal.',
          `proposal: ${written}`,
          'Status: pending_review',
          'No project wiki or Mnemon memory was updated yet. Apply only after the owner explicitly approves.',
        ].join('\n'),
      );
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

export const applyPromotion: McpToolDefinition = {
  tool: {
    name: 'distributed_cognition_apply_promotion',
    description:
      'Apply an explicitly approved promotion proposal into a stable Obsidian-style project wiki page and copy the approved proposal to approved-updates. Does not write directly to Mnemon.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        proposalPath: {
          type: 'string',
          description: 'Relative pending-review proposal path, e.g. pending-review/17-05-26-0800-promotion-patient.md.',
        },
        approved: {
          type: 'boolean',
          description: 'Must be true. This is the code-level approval guard before writing project-wikis/.',
        },
        root: { type: 'string', description: 'Optional second-brain root. Defaults to the mounted path.' },
      },
      required: ['proposalPath', 'approved'],
    },
  },
  async handler(args) {
    try {
      if (args.approved !== true) {
        return err('approved must be true before applying a promotion into project-wikis/');
      }
      const root = rootPath(args.root);
      ensureFolders(root);
      const relativeProposal = normalizeSecondBrainRelativePath(args.proposalPath as string);
      if (!relativeProposal.startsWith('pending-review/')) {
        throw new Error('proposalPath must point to a pending-review Markdown proposal');
      }
      const proposalPath = resolveSecondBrainMarkdown(root, relativeProposal, ['pending-review'] as const);
      const proposal = fs.readFileSync(proposalPath, 'utf-8');
      if (!proposalIsPending(proposal)) {
        throw new Error('Promotion proposal is not pending_review or has already been applied');
      }

      const now = new Date();
      const ts = timestamp(now);
      const projectName = parseProjectNameFromProposal(proposal);
      const targetPath = parseTargetPathFromProposal(proposal, projectName);
      const wikiTarget = resolveProjectWikiPath(root, projectName, targetPath);
      const proposed = extractMarkdownSection(proposal, 'Proposed Wiki Update');
      const mnemonCandidates = extractMarkdownSection(proposal, 'Proposed Mnemon Candidates');
      const sourceNotes = sourceNotesFromProposal(proposal);
      const proposalLink = obsidianLink(relativeProposal, `promotion proposal ${ts}`);

      let wiki = fs.existsSync(wikiTarget.filePath)
        ? fs.readFileSync(wikiTarget.filePath, 'utf-8')
        : wikiTemplate(projectName, ts);
      wiki = updateWikiMetadata(wiki, ts);

      const currentState = extractMarkdownSubsection(proposed, 'Current State');
      if (currentState) {
        wiki = replaceWikiSection(
          wiki,
          'Current State',
          [`Updated: ${ts}`, `Source: ${proposalLink}`, '', currentState].join('\n'),
        );
      }

      const appendDated = (heading: WikiPromotionSection, body: string) => {
        if (!body.trim()) return;
        wiki = appendToWikiSection(wiki, heading, [`### ${ts}`, `Source: ${proposalLink}`, '', body].join('\n'));
      };

      appendDated('Timeline', extractMarkdownSubsection(proposed, 'Timeline'));
      appendDated('Decisions', extractMarkdownSubsection(proposed, 'Decisions'));
      appendDated('Open Questions', extractMarkdownSubsection(proposed, 'Open Questions'));
      appendDated('Risks', extractMarkdownSubsection(proposed, 'Risks'));
      appendDated('Next Actions', extractMarkdownSubsection(proposed, 'Next Actions'));
      appendDated('Sources', sourceNotes);
      appendDated(
        'Mnemon Candidates',
        mnemonCandidates && !/^- None proposed\.\s*$/m.test(mnemonCandidates)
          ? `${mnemonCandidates}\n\nThese remain pending here. Store only concise, high-signal, safe extracts via distributed_cognition_auto_upgrade_memory; never store raw transcript text in Mnemon.`
          : '',
      );
      appendDated('Sources', `Applied proposal: ${proposalLink}`);
      appendDated('Sources', `Target wiki: ${obsidianLink(wikiTarget.relativePath, projectName)}`);
      appendDated('Next Actions', 'Review whether any pending Mnemon candidates should be stored as durable memory.');
      wiki = appendToWikiSection(
        wiki,
        'Update Log',
        `- ${ts}: Applied ${proposalLink} to ${obsidianLink(wikiTarget.relativePath, projectName)}.`,
      );

      fs.writeFileSync(wikiTarget.filePath, wiki);

      const appliedProposal = `${proposal.replace(/^## Status\s*\npending_review\s*$/m, '## Status\napproved')}\n## Applied\nApplied at: ${ts}\nApplied to: ${wikiTarget.relativePath}\n\n`;
      fs.writeFileSync(proposalPath, appliedProposal);
      const approvedPath = writeNew(
        resolveNotePath(root, 'approved-updates', filename(now, `approved-${projectName}`)),
        appliedProposal,
      );

      return ok(
        [
          'Applied approved promotion.',
          `wiki: ${wikiTarget.filePath}`,
          `proposal: ${proposalPath}`,
          `approved copy: ${approvedPath}`,
          'Mnemon: no direct write performed by wiki promotion; use distributed_cognition_auto_upgrade_memory separately for concise high-signal safe memories.',
        ].join('\n'),
      );
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

export const autoUpgradeMemory: McpToolDefinition = {
  tool: {
    name: 'distributed_cognition_auto_upgrade_memory',
    description:
      'Automatically store a concise, high-signal Distributed Cognition memory in Mnemon with an approved-updates audit trail. Use for safe durable facts, decisions, standing preferences, corrections, and project constraints; do not use for raw transcript dumps or low-value details.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        memory: {
          type: 'string',
          description: 'Concise extracted durable memory to store. Do not pass raw transcript text.',
        },
        title: { type: 'string', description: 'Short memory title.' },
        messageType: {
          type: 'string',
          description:
            'Classification of the source message, e.g. durable_memory_candidate, decision, forget_or_correction_request, reflection, or general_note.',
        },
        layer: {
          type: 'string',
          description: 'Optional Mnemon layer: semantic, procedural, episodic, or resource.',
        },
        entityType: {
          type: 'string',
          description: 'Optional entity type: user, project, person, concept, file, rule, or tool.',
        },
        entityName: {
          type: 'string',
          description: 'Optional entity name, e.g. p(AI)tient, CORTEX, or Distributed Cognition.',
        },
        sourcePaths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional relative second-brain Markdown sources that justify the memory.',
        },
        rationale: { type: 'string', description: 'Why this memory is durable and useful later.' },
        importance: { type: 'number', description: '0 to 1 importance score. Defaults to 0.8.' },
        confidence: { type: 'number', description: '0 to 1 confidence score. Defaults to 0.85.' },
        eventAt: { type: 'string', description: 'Optional event timestamp for episodic memories.' },
        validFrom: { type: 'string', description: 'Optional validity start timestamp.' },
        validUntil: { type: 'string', description: 'Optional validity end timestamp.' },
        scope: { type: 'string', description: 'Optional memory scope. Defaults to distributed-cognition.' },
        root: { type: 'string', description: 'Optional second-brain root. Defaults to the mounted path.' },
      },
      required: ['memory'],
    },
  },
  async handler(args) {
    try {
      const memory = typeof args.memory === 'string' ? args.memory.trim() : '';
      const entityType = normalizeMemoryEntityType(args.entityType);
      const layer = MEMORY_LAYERS.includes(args.layer as MemoryLayer) ? (args.layer as MemoryLayer) : undefined;
      const messageType = normalizeMemoryMessageType(args.messageType);
      const input: DurableMemoryInput = {
        memory,
        title: typeof args.title === 'string' ? args.title : undefined,
        layer,
        entityType,
        entityName: typeof args.entityName === 'string' ? args.entityName : undefined,
        messageType,
        sourcePaths: Array.isArray(args.sourcePaths)
          ? args.sourcePaths.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
          : undefined,
        rationale: typeof args.rationale === 'string' ? args.rationale : undefined,
        importance: typeof args.importance === 'number' ? args.importance : undefined,
        confidence: typeof args.confidence === 'number' ? args.confidence : undefined,
        eventAt: typeof args.eventAt === 'string' ? args.eventAt : undefined,
        validFrom: typeof args.validFrom === 'string' ? args.validFrom : undefined,
        validUntil: typeof args.validUntil === 'string' ? args.validUntil : undefined,
        scope: typeof args.scope === 'string' ? args.scope : undefined,
        approvalMode: 'automatic',
      };
      const signal = memorySignal(input);
      if (!signal.allowed) {
        if (
          signal.reason.includes('prohibited') ||
          signal.reason.includes('too long') ||
          signal.reason.includes('raw transcript') ||
          signal.reason.includes('memory is required')
        ) {
          return err(signal.reason);
        }
        return ok(`Memory not stored: ${signal.reason}`);
      }

      const root = rootPath(args.root);
      ensureFolders(root);
      const result = storeDurableMemory(root, input, signal.reason);
      return ok(
        [
          'Stored durable memory in Mnemon.',
          `id: ${result.id}`,
          `layer: ${result.layer}`,
          result.sourceRelativePath
            ? `source: ${result.sourceRelativePath}`
            : 'source: current conversation or extracted note',
          `audit: ${result.auditPath}`,
          `mnemon db: ${result.dbPath}`,
        ].join('\n'),
      );
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

export const updateProjectStatus: McpToolDefinition = {
  tool: {
    name: 'distributed_cognition_update_project_status',
    description:
      'Create or refresh a stable Obsidian-style project status page plus project-wikis/current-projects.md. Use for durable pivots, status, deadlines, decisions, open questions, risks, and next actions; do not copy raw transcripts.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectName: { type: 'string', description: 'Human project name, e.g. p(AI)tient, CORTEX, or AIME.' },
        status: { type: 'string', description: 'active, stale, blocked, paused, watching, or done.' },
        currentState: { type: 'string', description: 'Concise current project state.' },
        nextActions: { type: 'array', items: { type: 'string' }, description: 'Concrete next actions.' },
        openQuestions: { type: 'array', items: { type: 'string' }, description: 'Open questions to revisit.' },
        decisions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Confirmed decisions or decision leanings.',
        },
        risks: { type: 'array', items: { type: 'string' }, description: 'Project risks.' },
        sourcePaths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional relative second-brain Markdown source notes.',
        },
        reviewAfter: { type: 'string', description: 'Optional DD-MM-YY, HH:MM review point.' },
        root: { type: 'string', description: 'Optional second-brain root. Defaults to the mounted path.' },
      },
      required: ['projectName'],
    },
  },
  async handler(args) {
    try {
      const root = rootPath(args.root);
      ensureFolders(root);
      const record = upsertProjectStatus(root, args);
      return ok(
        [
          'Updated project status.',
          `project: ${record.name}`,
          `status: ${record.status}`,
          `wiki: ${path.join(requireRoot(root), record.wikiPath)}`,
          `current projects: ${path.join(requireRoot(root), 'project-wikis', 'current-projects.md')}`,
        ].join('\n'),
      );
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

export const healthCheck: McpToolDefinition = {
  tool: {
    name: 'distributed_cognition_health_check',
    description:
      'Check Distributed Cognition mounts, second-brain folders, optional Codex/Mnemon mounts, and queue directories. Writes project-wikis/system-health.md plus .dc-index/system-health.json.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        root: { type: 'string', description: 'Optional second-brain root. Defaults to the mounted path.' },
      },
    },
  },
  async handler(args) {
    try {
      const root = rootPath(args.root);
      const { report, wikiPath, jsonPath } = buildSystemHealth(root);
      return ok(
        [
          `Distributed Cognition health: ${report.overall}`,
          `checked: ${report.checkedAt}`,
          `wiki: ${wikiPath}`,
          `json: ${jsonPath}`,
          '',
          ...report.items.map((item) => `- ${item.status}: ${item.label} — ${item.detail}`),
        ].join('\n'),
      );
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

export const formatReply: McpToolDefinition = {
  tool: {
    name: 'distributed_cognition_format_reply',
    description:
      'Format a WhatsApp reply with the required DC tag and a privacy scrub for public-ish operational strings. Use immediately before sending a WhatsApp reply.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        message: { type: 'string', description: 'Reply body to tag as DC.' },
        includeTimestamp: { type: 'boolean', description: 'Include DD-MM-YY, HH:MM in the DC prefix.' },
        maxChars: { type: 'number', description: 'Maximum reply characters after the DC prefix.' },
      },
      required: ['message'],
    },
  },
  async handler(args) {
    try {
      const message = typeof args.message === 'string' ? args.message : '';
      if (!message.trim()) return err('message is required');
      return ok(
        formatDcReply(message, {
          includeTimestamp: args.includeTimestamp === true,
          maxChars: typeof args.maxChars === 'number' ? args.maxChars : undefined,
        }),
      );
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

export const routeRequest: McpToolDefinition = {
  tool: {
    name: 'distributed_cognition_route_request',
    description:
      'Classify an owner WhatsApp message into the next Distributed Cognition capability: capture, memory, context search, web search, queue status, Codex handoff, or action request.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        message: { type: 'string', description: 'Owner message text to route.' },
        hasAudioAttachment: { type: 'boolean', description: 'Set true when the message includes an audio attachment.' },
      },
      required: ['message'],
    },
  },
  async handler(args) {
    try {
      const message = typeof args.message === 'string' ? args.message : '';
      if (!message.trim()) return err('message is required');
      const route = capabilityRoute(message, args.hasAudioAttachment === true);
      return ok(
        [
          `capability: ${route.capability}`,
          `messageType: ${route.messageType}`,
          `confidence: ${route.confidence}`,
          route.hostBridge ? `hostBridge: ${route.hostBridge}` : 'hostBridge: none',
          `reason: ${route.reason}`,
          `suggestedTools: ${route.tools.join(', ')}`,
        ].join('\n'),
      );
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

export const queueStatus: McpToolDefinition = {
  tool: {
    name: 'distributed_cognition_queue_status',
    description:
      'Report the unified Distributed Cognition work queue across Codex handoffs and action requests. Writes project-wikis/work-queue.md.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        root: { type: 'string', description: 'Optional second-brain root. Defaults to the mounted path.' },
      },
    },
  },
  async handler(args) {
    try {
      const root = rootPath(args.root);
      ensureFolders(root);
      const markdown = unifiedQueueStatusMarkdown(root);
      const wiki = resolveProjectWikiPath(root, 'Work Queue', 'project-wikis/work-queue.md');
      fs.writeFileSync(wiki.filePath, markdown);
      return ok([markdown, `wiki: ${wiki.filePath}`].join('\n'));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

export const attentionCalibration: McpToolDefinition = {
  tool: {
    name: 'distributed_cognition_attention_calibration',
    description:
      'Write an Obsidian-friendly attention calibration report showing what was promoted, kept in Markdown, and where DC may be over- or under-attending.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        root: { type: 'string', description: 'Optional second-brain root. Defaults to the mounted path.' },
      },
    },
  },
  async handler(args) {
    try {
      const root = rootPath(args.root);
      ensureFolders(root);
      const wiki = resolveProjectWikiPath(root, 'Attention Calibration', 'project-wikis/attention-calibration.md');
      fs.writeFileSync(wiki.filePath, attentionCalibrationMarkdown(root));
      appendProvenanceEvent(root, {
        id: `attention-${Date.now()}`,
        kind: 'attention_score',
        title: 'Attention calibration refreshed',
        outputPaths: [wiki.relativePath],
      });
      return ok(`Wrote attention calibration report.\nwiki: ${wiki.filePath}`);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

export const memoryHygiene: McpToolDefinition = {
  tool: {
    name: 'distributed_cognition_memory_hygiene',
    description:
      'Write an Obsidian-friendly memory hygiene report for durable memory audit notes, changed-my-mind candidates, corrections, and stale decision review windows.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        root: { type: 'string', description: 'Optional second-brain root. Defaults to the mounted path.' },
      },
    },
  },
  async handler(args) {
    try {
      const root = rootPath(args.root);
      ensureFolders(root);
      const wiki = resolveProjectWikiPath(root, 'Memory Hygiene', 'project-wikis/memory-hygiene.md');
      fs.writeFileSync(wiki.filePath, memoryHygieneMarkdown(root));
      appendProvenanceEvent(root, {
        id: `memory-hygiene-${Date.now()}`,
        kind: 'memory_hygiene',
        title: 'Memory hygiene refreshed',
        outputPaths: [wiki.relativePath],
      });
      return ok(`Wrote memory hygiene report.\nwiki: ${wiki.filePath}`);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

export const mnemonGraph: McpToolDefinition = {
  tool: {
    name: 'distributed_cognition_mnemon_graph',
    description:
      'Write an Obsidian-friendly Mnemon memory report plus a .canvas graph so durable keys, pivots, entities, and source notes can be visually inspected.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        root: { type: 'string', description: 'Optional second-brain root. Defaults to the mounted path.' },
        limit: { type: 'number', description: 'Maximum memories to include. Default 40, max 200.' },
      },
    },
  },
  async handler(args) {
    try {
      const root = rootPath(args.root);
      const written = writeMnemonGraph(root, args.limit);
      return ok(
        [
          'Wrote Mnemon memory graph.',
          `memories: ${written.memoryCount}`,
          `nodes: ${written.nodeCount}`,
          `edges: ${written.edgeCount}`,
          `report: ${written.markdownPath}`,
          `canvas: ${written.canvasPath}`,
          `graph json: ${written.graphJsonPath}`,
        ].join('\n'),
      );
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

export const projectOntology: McpToolDefinition = {
  tool: {
    name: 'distributed_cognition_project_ontology',
    description:
      'Write a stable project/theme/workflow ontology page so Mnemon stores concise pivots while Obsidian stores readable synthesis.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        root: { type: 'string', description: 'Optional second-brain root. Defaults to the mounted path.' },
      },
    },
  },
  async handler(args) {
    try {
      const root = rootPath(args.root);
      ensureFolders(root);
      const wiki = resolveProjectWikiPath(root, 'Project Ontology', 'project-wikis/project-ontology.md');
      fs.writeFileSync(wiki.filePath, projectOntologyMarkdown(root));
      appendProvenanceEvent(root, {
        id: `ontology-${Date.now()}`,
        kind: 'project_ontology',
        title: 'Project ontology refreshed',
        outputPaths: [wiki.relativePath],
      });
      return ok(`Wrote project ontology.\nwiki: ${wiki.filePath}`);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

export const provenanceLedger: McpToolDefinition = {
  tool: {
    name: 'distributed_cognition_provenance_ledger',
    description: 'Write a provenance ledger page from the append-only Distributed Cognition events log.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        root: { type: 'string', description: 'Optional second-brain root. Defaults to the mounted path.' },
      },
    },
  },
  async handler(args) {
    try {
      const root = rootPath(args.root);
      ensureFolders(root);
      const wiki = resolveProjectWikiPath(root, 'Provenance Ledger', 'project-wikis/provenance-ledger.md');
      fs.writeFileSync(wiki.filePath, provenanceMarkdown(root));
      return ok(`Wrote provenance ledger.\nwiki: ${wiki.filePath}`);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

export const buildCodexStatus: McpToolDefinition = {
  tool: {
    name: 'distributed_cognition_build_codex_status',
    description:
      'Build a safe Codex Workbench status page from the mounted read-only Codex projects folder and optional Codex memory summaries. Writes project-wikis/codex-workbench.md plus .dc-index/codex-status.json.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectsRoot: {
          type: 'string',
          description: `Optional mounted Codex projects root. Defaults to ${CODEX_PROJECTS_ROOT_CANDIDATES[0]}.`,
        },
        memoryRoot: {
          type: 'string',
          description: `Optional mounted Codex memory summaries root. Defaults to ${CODEX_MEMORY_ROOT_CANDIDATES[0]} if present.`,
        },
        maxProjects: {
          type: 'number',
          description: `Maximum projects to scan. Defaults to ${MAX_CODEX_PROJECTS}.`,
        },
        root: { type: 'string', description: 'Optional second-brain root. Defaults to the mounted path.' },
      },
    },
  },
  async handler(args) {
    try {
      const root = rootPath(args.root);
      ensureFolders(root);
      const projectsRoot = resolveCodexProjectsRoot(args.projectsRoot);
      const maxProjects = Math.min(
        MAX_CODEX_PROJECTS,
        Math.max(
          1,
          typeof args.maxProjects === 'number' && Number.isFinite(args.maxProjects)
            ? Math.floor(args.maxProjects)
            : MAX_CODEX_PROJECTS,
        ),
      );
      const { projects, skipped } = discoverCodexProjects(projectsRoot, maxProjects);
      const memory = readCodexMemorySignals(args.memoryRoot);
      const handoffSummary = queueSummary(root, CODEX_HANDOFF_DIR);
      const actionSummary = queueSummary(root, ACTION_REQUEST_DIR);
      const index: CodexStatusIndex = {
        version: CODEX_STATUS_VERSION,
        generatedAt: timestamp(new Date()),
        projectsRoot,
        projects,
        memoryRoot: memory.root,
        memorySignals: memory.signals,
        handoffSummary,
        actionSummary,
        skipped,
      };
      const written = writeCodexStatusIndex(root, index);
      return ok(
        [
          `Built Codex Workbench status for ${projects.length} project${projects.length === 1 ? '' : 's'}.`,
          `wiki: ${written.wikiPath}`,
          `index: ${written.jsonPath}`,
          memory.root ? `codex memory summaries: ${memory.root}` : 'codex memory summaries: not mounted',
          skipped.length > 0 ? `skipped: ${skipped.length}` : 'skipped: 0',
        ].join('\n'),
      );
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

export const createCodexHandoff: McpToolDefinition = {
  tool: {
    name: 'distributed_cognition_create_codex_handoff',
    description:
      'Queue a WhatsApp-requested coding task for a specific allowlisted Codex project. Writes a Markdown handoff in pending-review and a machine-readable queue item for the host Codex bridge. Defaults to local Codex on the Mac; does not run shell commands inside WhatsApp.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        project: {
          type: 'string',
          description: 'Exact Codex project folder name, e.g. p(AI)tient, E3-Navigator Improved, or SIMTAC AI.',
        },
        task: {
          type: 'string',
          description:
            'The concrete coding task to hand off to Codex. Do not include secrets or prohibited sensitive data.',
        },
        target: {
          type: 'string',
          description: 'codex-local, codex-cloud, or queue-only. Defaults to codex-local.',
        },
        planMarkdown: {
          type: 'string',
          description:
            'Optional DC-composed implementation plan for Codex, including likely files/areas, steps, verification, and constraints.',
        },
        acceptanceCriteria: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional concrete checks Codex should satisfy before finishing.',
        },
        cloudEnv: {
          type: 'string',
          description:
            'Optional Codex Cloud environment id or accepted label. Used only when target=codex-cloud; the host bridge still validates this against its allowlisted mapping.',
        },
        branch: { type: 'string', description: 'Optional branch hint for Codex local or Codex Cloud.' },
        model: { type: 'string', description: 'Optional model preference for the handoff.' },
        priority: { type: 'string', description: 'Optional priority label.' },
        sourceNotePaths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional second-brain Markdown source notes for context.',
        },
        projectsRoot: {
          type: 'string',
          description: `Optional mounted Codex projects root. Defaults to ${CODEX_PROJECTS_ROOT_CANDIDATES[0]}.`,
        },
        root: { type: 'string', description: 'Optional second-brain root. Defaults to the mounted path.' },
      },
      required: ['project', 'task'],
    },
  },
  async handler(args) {
    try {
      const projectName = typeof args.project === 'string' ? args.project.trim() : '';
      const task = typeof args.task === 'string' ? args.task.trim() : '';
      if (!projectName) return err('project is required');
      if (!task) return err('task is required');
      if (task.length > MAX_CODEX_TASK_CHARS)
        return err(`task is too long for a Codex handoff (${task.length} characters; max ${MAX_CODEX_TASK_CHARS})`);
      if (SENSITIVE_RE.test(task) || PROHIBITED_CONTEXT_RE.test(task)) {
        return err('Codex handoff appears to contain prohibited sensitive, HR, exam, or confidential content.');
      }
      const root = rootPath(args.root);
      ensureFolders(root);
      const project = matchCodexProject(root, projectName, args.projectsRoot);
      const targetRaw = typeof args.target === 'string' ? args.target.trim().toLowerCase() : 'codex-local';
      const target =
        targetRaw === 'queue-only' || targetRaw === 'codex-cloud' || targetRaw === 'codex-local'
          ? targetRaw
          : 'codex-local';
      const sourceNotePaths = Array.isArray(args.sourceNotePaths)
        ? args.sourceNotePaths.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : [];
      if (sourceNotePaths.length > 0) readOptionalMemorySources(root, sourceNotePaths);
      const now = new Date();
      const record: CodexHandoffRecord = {
        version: CODEX_HANDOFF_VERSION,
        id: `codex-${parts(now).day}${parts(now).month}${parts(now).year}-${parts(now).hour}${parts(now).minute}-${randomBytes(4).toString('hex')}`,
        createdAt: timestamp(now),
        status: 'queued',
        target,
        projectName: project.name,
        relativeProjectPath: project.relativePath,
        task,
        planMarkdown:
          typeof args.planMarkdown === 'string' && args.planMarkdown.trim() ? args.planMarkdown.trim() : undefined,
        acceptanceCriteria: Array.isArray(args.acceptanceCriteria)
          ? args.acceptanceCriteria
              .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
              .map((item) => item.trim())
          : undefined,
        cloudEnv: typeof args.cloudEnv === 'string' && args.cloudEnv.trim() ? args.cloudEnv.trim() : undefined,
        branch: typeof args.branch === 'string' && args.branch.trim() ? args.branch.trim() : undefined,
        model: typeof args.model === 'string' && args.model.trim() ? args.model.trim() : undefined,
        priority: typeof args.priority === 'string' && args.priority.trim() ? args.priority.trim() : undefined,
        sourceNotePaths,
        notePath: '',
      };
      const markdown = codexHandoffMarkdown(record, project);
      const written = writeCodexHandoff(root, record, markdown);
      return ok(
        [
          'Queued Codex handoff.',
          `id: ${record.id}`,
          `project: ${record.projectName}`,
          `target: ${record.target}`,
          `note: ${written.notePath}`,
          `queue: ${written.queuePath}`,
          record.target === 'codex-cloud'
            ? 'Host bridge can submit it to Codex Cloud only after validating the allowlisted project/environment mapping.'
            : 'Host bridge can execute it with local Codex on the Mac after validating the allowlisted project mapping.',
        ].join('\n'),
      );
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

export const createActionRequest: McpToolDefinition = {
  tool: {
    name: 'distributed_cognition_create_action_request',
    description:
      'Queue a safe non-code action request from WhatsApp, such as web research, Word document generation, or PowerPoint generation. Writes a Markdown note in pending-review and a machine-readable queue item for the host action bridge. Does not run shell commands inside WhatsApp.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        actionType: {
          type: 'string',
          description: 'web_research, word_document, powerpoint, codex_handoff, or manual_review.',
        },
        title: {
          type: 'string',
          description: 'Short human-readable title for the action.',
        },
        brief: {
          type: 'string',
          description: 'Concrete action brief. Do not include secrets or prohibited sensitive data.',
        },
        contentMarkdown: {
          type: 'string',
          description: 'Optional drafted Markdown content to convert into a DOCX/PPTX or use as research context.',
        },
        outputName: {
          type: 'string',
          description: 'Optional safe output base name or requested artifact title.',
        },
        target: {
          type: 'string',
          description: 'local, codex-local, codex-cloud, or queue-only. Defaults depend on the host bridge allowlist.',
        },
        priority: { type: 'string', description: 'Optional priority label.' },
        sourceNotePaths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional second-brain Markdown source notes for context.',
        },
        root: { type: 'string', description: 'Optional second-brain root. Defaults to the mounted path.' },
      },
      required: ['actionType', 'title', 'brief'],
    },
  },
  async handler(args) {
    try {
      const actionType = normalizeActionType(args.actionType);
      const title = typeof args.title === 'string' ? args.title.trim() : '';
      const brief = typeof args.brief === 'string' ? args.brief.trim() : '';
      const contentMarkdown = typeof args.contentMarkdown === 'string' ? args.contentMarkdown.trim() : '';
      if (!title) return err('title is required');
      if (!brief) return err('brief is required');
      if (brief.length > MAX_ACTION_BRIEF_CHARS)
        return err(
          `brief is too long for an action request (${brief.length} characters; max ${MAX_ACTION_BRIEF_CHARS})`,
        );
      if (contentMarkdown.length > MAX_ACTION_CONTENT_CHARS) {
        return err(
          `contentMarkdown is too long for an action request (${contentMarkdown.length} characters; max ${MAX_ACTION_CONTENT_CHARS})`,
        );
      }
      const combined = `${title}\n${brief}\n${contentMarkdown}`;
      if (SENSITIVE_RE.test(combined) || PROHIBITED_CONTEXT_RE.test(combined)) {
        return err('Action request appears to contain prohibited sensitive, HR, exam, or confidential content.');
      }
      const root = rootPath(args.root);
      ensureFolders(root);
      const sourceNotePaths = Array.isArray(args.sourceNotePaths)
        ? args.sourceNotePaths.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : [];
      if (sourceNotePaths.length > 0) readOptionalMemorySources(root, sourceNotePaths);
      const targetRaw = typeof args.target === 'string' ? args.target.trim().toLowerCase() : undefined;
      const target =
        targetRaw === 'local' ||
        targetRaw === 'codex-local' ||
        targetRaw === 'codex-cloud' ||
        targetRaw === 'queue-only'
          ? targetRaw
          : undefined;
      const now = new Date();
      const record: ActionRequestRecord = {
        version: ACTION_REQUEST_VERSION,
        id: `action-${parts(now).day}${parts(now).month}${parts(now).year}-${parts(now).hour}${parts(now).minute}-${randomBytes(4).toString('hex')}`,
        createdAt: timestamp(now),
        status: 'queued',
        actionType,
        title,
        brief,
        contentMarkdown: contentMarkdown || undefined,
        outputName: typeof args.outputName === 'string' && args.outputName.trim() ? args.outputName.trim() : undefined,
        target,
        priority: typeof args.priority === 'string' && args.priority.trim() ? args.priority.trim() : undefined,
        sourceNotePaths,
        notePath: '',
      };
      const markdown = actionRequestMarkdown(record);
      const written = writeActionRequest(root, record, markdown);
      return ok(
        [
          'Queued action request.',
          `id: ${record.id}`,
          `type: ${record.actionType}`,
          `target: ${record.target ?? 'host bridge default'}`,
          `note: ${written.notePath}`,
          `queue: ${written.queuePath}`,
          'Host action bridge can execute it only if the action type is allowlisted.',
        ].join('\n'),
      );
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

export const webSearch: McpToolDefinition = {
  tool: {
    name: 'distributed_cognition_web_search',
    description:
      'Search the public web from Distributed Cognition. Use for current/public information and cite returned source URLs. Does not write to the second-brain folder.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Public web search query. Do not include secrets or prohibited sensitive content.',
        },
        limit: {
          type: 'number',
          description: `Maximum result count. Defaults to ${DEFAULT_WEB_SEARCH_RESULTS}; max ${MAX_WEB_SEARCH_RESULTS}.`,
        },
      },
      required: ['query'],
    },
  },
  async handler(args) {
    try {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) return err('query is required');
      if (SENSITIVE_RE.test(query) || PROHIBITED_CONTEXT_RE.test(query)) {
        return err('Web search query appears to contain prohibited sensitive, HR, exam, or confidential content.');
      }
      const limit = Math.min(
        MAX_WEB_SEARCH_RESULTS,
        Math.max(
          1,
          typeof args.limit === 'number' && Number.isFinite(args.limit)
            ? Math.floor(args.limit)
            : DEFAULT_WEB_SEARCH_RESULTS,
        ),
      );
      const results = await publicWebSearch(query, limit);
      if (results.length === 0) return ok(`No public web results found for "${query}" at ${timestamp(new Date())}.`);
      return ok(
        [
          `Public web search for "${query}" at ${timestamp(new Date())}.`,
          'Use these as source leads; read specific pages before relying on details.',
          '',
          ...results.map((result, index) =>
            [
              `${index + 1}. ${result.title}`,
              `   URL: ${result.url}`,
              result.snippet ? `   Snippet: ${result.snippet}` : undefined,
            ]
              .filter((line): line is string => typeof line === 'string')
              .join('\n'),
          ),
        ].join('\n'),
      );
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

export const readWebPage: McpToolDefinition = {
  tool: {
    name: 'distributed_cognition_read_web_page',
    description:
      'Read a specific public http(s) web page into bounded text for source-grounded answers. Blocks local/private network URLs and does not write to the second-brain folder.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description:
            'Public http(s) URL to read. Localhost, private IPs, credential URLs, and secret query tokens are blocked.',
        },
        maxChars: {
          type: 'number',
          description: `Maximum returned characters. Defaults to ${DEFAULT_WEB_READ_CHARS}; max ${MAX_WEB_READ_CHARS}.`,
        },
      },
      required: ['url'],
    },
  },
  async handler(args) {
    try {
      const url = typeof args.url === 'string' ? args.url.trim() : '';
      if (!url) return err('url is required');
      if (SENSITIVE_RE.test(url) || PROHIBITED_CONTEXT_RE.test(url)) {
        return err('Web page URL appears to contain prohibited sensitive, HR, exam, or confidential content.');
      }
      const maxChars = Math.min(
        MAX_WEB_READ_CHARS,
        Math.max(
          1,
          typeof args.maxChars === 'number' && Number.isFinite(args.maxChars)
            ? Math.floor(args.maxChars)
            : DEFAULT_WEB_READ_CHARS,
        ),
      );
      const page = await readPublicWebPage(url, maxChars);
      return ok(
        [
          `Web page: ${page.title}`,
          `URL: ${page.url}`,
          `Fetched: ${timestamp(new Date())}`,
          page.text.length >= maxChars
            ? `Showing first ${maxChars} characters.`
            : `Showing ${page.text.length} characters.`,
          '',
          page.text,
        ].join('\n'),
      );
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

export const buildContextIndex: McpToolDefinition = {
  tool: {
    name: 'distributed_cognition_build_context_index',
    description:
      'Build a lightweight searchable context map for the mounted Distributed Cognition Dropbox folders. Stores only bounded previews and metadata in .dc-index under the writable second-brain root.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        folders: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional relative folders under each context root to index.',
        },
        maxFiles: {
          type: 'number',
          description: `Maximum readable files to index. Defaults to ${DEFAULT_INDEX_LIMIT}; max ${MAX_INDEX_LIMIT}.`,
        },
        maxPreviewChars: {
          type: 'number',
          description: `Maximum extracted preview characters per file. Defaults to ${DEFAULT_INDEX_PREVIEW_CHARS}; max ${MAX_INDEX_PREVIEW_CHARS}.`,
        },
        root: {
          type: 'string',
          description: 'Optional single context root override. Defaults to all mounted DC context roots.',
        },
        indexRoot: {
          type: 'string',
          description: 'Optional writable root for .dc-index. Defaults to the mounted second-brain root.',
        },
        write: { type: 'boolean', description: 'Write the index files. Defaults to true.' },
      },
    },
  },
  async handler(args) {
    try {
      const { entries, manifest, paths } = await buildContextIndexData({
        folders: args.folders,
        root: args.root,
        indexRoot: args.indexRoot,
        maxFiles: args.maxFiles,
        maxPreviewChars: args.maxPreviewChars,
      });
      if (args.write !== false) writeContextIndex(entries, manifest, paths);
      const byRoot = new Map<string, number>();
      for (const entry of entries) byRoot.set(entry.label, (byRoot.get(entry.label) ?? 0) + 1);
      const samples = entries
        .slice()
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, 8)
        .map((entry) => `- ${entry.label}:${entry.path} (${entry.modified}; ${entry.extension || 'no extension'})`);
      return ok(
        [
          `Built Distributed Cognition context index with ${entries.length} file${entries.length === 1 ? '' : 's'}.`,
          `Generated: ${manifest.generatedAt}`,
          args.write === false ? 'Write mode: preview only; no index file was written.' : `Index: ${paths.entries}`,
          manifest.skipped.length > 0
            ? `Skipped: ${manifest.skipped.length} file${manifest.skipped.length === 1 ? '' : 's'} by size, safety, type, or extraction limits.`
            : 'Skipped: 0 files.',
          '',
          'Indexed roots:',
          ...Array.from(byRoot.entries()).map(([label, count]) => `- ${label}: ${count}`),
          samples.length > 0 ? '' : undefined,
          samples.length > 0 ? 'Recent indexed files:' : undefined,
          ...samples,
        ]
          .filter((line): line is string => typeof line === 'string')
          .join('\n'),
      );
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

export const searchContext: McpToolDefinition = {
  tool: {
    name: 'distributed_cognition_search_context',
    description:
      'Search the mounted Distributed Cognition second-brain folder and selected read-only Dropbox context folders. Uses the lightweight context index when available, with a bounded direct scan fallback.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query or topic.' },
        folders: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional relative folders under each context root to search.',
        },
        limit: { type: 'number', description: 'Maximum number of hits to return. Defaults to 8; max 20.' },
        root: {
          type: 'string',
          description: 'Optional single root override. Defaults to second-brain plus selected context roots.',
        },
        indexRoot: {
          type: 'string',
          description: 'Optional root containing .dc-index. Defaults to the mounted second-brain root.',
        },
        useIndex: { type: 'boolean', description: 'Use the lightweight context index first. Defaults to true.' },
      },
      required: ['query'],
    },
  },
  async handler(args) {
    try {
      const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
      if (!query) return err('query is required');
      const limit = Math.min(
        MAX_SEARCH_LIMIT,
        Math.max(
          1,
          typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.floor(args.limit) : DEFAULT_SEARCH_LIMIT,
        ),
      );
      const terms = query.split(/\s+/).filter((term) => term.length >= 2);
      const hits: Array<{ score: number; file: string; line: number; text: string }> = [];

      if (args.useIndex !== false && !args.root) {
        try {
          const indexed = searchContextIndex({
            query,
            terms,
            limit,
            folders: args.folders,
            indexRoot: args.indexRoot,
          });
          if (indexed) return ok(indexed.text);
        } catch {
          // Fall back to a bounded direct scan if the index is absent or stale.
        }
      }

      for (const searchRoot of searchRoots(args.root)) {
        const folders = resolveSearchFolders(searchRoot.root, args.folders);
        for (const filePath of await globContextFiles(searchRoot.root, folders, MAX_CONTEXT_FILES)) {
          let text = '';
          try {
            text = (await readContextFileText(filePath, MAX_CONTEXT_EXTRACT_BYTES)).text;
          } catch {
            continue;
          }
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            const score = scoreLine(lines[i], query, terms);
            if (score > 0) {
              hits.push({
                score,
                file: `${searchRoot.label}:${toRelativeDisplayPath(searchRoot.root, filePath)}`,
                line: i + 1,
                text: excerpt(lines[i]),
              });
            }
          }
        }
      }

      const selected = hits
        .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line)
        .slice(0, limit);
      if (selected.length === 0)
        return ok(`No context hits for "${query}" in the mounted Distributed Cognition context roots.`);

      return ok(
        [
          `Found ${selected.length} context hit${selected.length === 1 ? '' : 's'} for "${query}".`,
          ...selected.map((hit) => `- ${hit.file}:${hit.line}\n  ${hit.text}`),
        ].join('\n'),
      );
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

export const readContext: McpToolDefinition = {
  tool: {
    name: 'distributed_cognition_read_context',
    description:
      'Read or extract a specific context file inside mounted Distributed Cognition context roots. Supports text/Markdown plus bounded DOCX/PPTX/XLSX/PDF extraction. Use paths returned by distributed_cognition_search_context.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Labeled path returned by search_context, or a relative path under second-brain.',
        },
        maxChars: { type: 'number', description: 'Maximum characters to return. Defaults to 12000; max 50000.' },
        root: { type: 'string', description: 'Optional second-brain root. Defaults to the mounted path.' },
      },
      required: ['path'],
    },
  },
  async handler(args) {
    try {
      const relativePath = typeof args.path === 'string' ? args.path.trim() : '';
      if (!relativePath) return err('path is required');
      const { root: realRoot, filePath } = resolveContextReference(relativePath, args.root);
      const maxChars = Math.min(
        MAX_READ_CHARS,
        Math.max(
          1,
          typeof args.maxChars === 'number' && Number.isFinite(args.maxChars)
            ? Math.floor(args.maxChars)
            : DEFAULT_READ_CHARS,
        ),
      );
      const { text, extracted } = await readContextFileText(filePath, MAX_CONTEXT_EXTRACT_BYTES);
      const truncated = text.length > maxChars;
      return ok(
        [
          `Context file: ${toRelativeDisplayPath(realRoot, filePath)}`,
          extracted ? 'Source type: extracted text.' : 'Source type: text file.',
          truncated ? `Showing first ${maxChars} of ${text.length} characters.` : `Showing ${text.length} characters.`,
          '',
          text.slice(0, maxChars),
        ].join('\n'),
      );
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

registerTools([
  captureNote,
  transcribeAudio,
  captureAudio,
  preparePromotion,
  applyPromotion,
  autoUpgradeMemory,
  updateProjectStatus,
  healthCheck,
  formatReply,
  routeRequest,
  queueStatus,
  attentionCalibration,
  memoryHygiene,
  mnemonGraph,
  projectOntology,
  provenanceLedger,
  buildCodexStatus,
  createCodexHandoff,
  createActionRequest,
  webSearch,
  readWebPage,
  buildContextIndex,
  searchContext,
  readContext,
]);
