import fs from 'fs';
import path from 'path';

import { appendProvenanceEvent } from './provenance.js';

export const SECOND_BRAIN_FOLDERS = [
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

export type SecondBrainFolder = (typeof SECOND_BRAIN_FOLDERS)[number];

export type DistributedMessageType =
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

const DISTRIBUTED_MESSAGE_TYPES: readonly DistributedMessageType[] = [
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

export interface WriteDistributedNoteInput {
  root: string;
  rawText: string;
  messageType?: DistributedMessageType;
  now?: Date;
  timezone?: string;
  slug?: string;
  source?: 'whatsapp-text' | 'whatsapp-audio' | 'manual';
  transcript?: string;
  audioPath?: string;
  processedMarkdown?: string;
}

export interface WriteDistributedNoteResult {
  messageType: DistributedMessageType;
  timestamp: string;
  filename: string;
  rawPath: string;
  processedPath: string;
  deadlineWatchPath?: string;
  coachingPrompt?: string;
}

export interface TemporalMetadata {
  capturedAt: string;
  mentionedDates: string[];
  deadlineCandidates: string[];
  decisionDate: string;
  reviewAfter: string;
  stalenessStatus: string;
}

export type AttentionImportance = 'low' | 'medium' | 'high';
export type AttentionDurability = 'transient' | 'useful' | 'durable' | 'blocked';
export type AttentionActionability = 'none' | 'possible' | 'clear_action';
export type AttentionTimeSensitivity = 'none' | 'soon' | 'deadline';

export interface AttentionMetadata {
  importance: AttentionImportance;
  durability: AttentionDurability;
  actionability: AttentionActionability;
  timeSensitivity: AttentionTimeSensitivity;
  projectSignals: string[];
  rationale: string;
}

const DEFAULT_TIMEZONE = 'Asia/Singapore';
const SENSITIVE_RE =
  /\b(patient-identifiable|patient identifiable|learner-identifiable|learner identifiable|hr material|exam material|confidential institutional|nric|medical record number|mrn)\b/i;

function partsInTimezone(
  date: Date,
  timezone: string,
): { day: string; month: string; year: string; hour: string; minute: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return {
    day: get('day'),
    month: get('month'),
    year: get('year'),
    hour: get('hour'),
    minute: get('minute'),
  };
}

export function formatDistributedTimestamp(date: Date, timezone = DEFAULT_TIMEZONE): string {
  const p = partsInTimezone(date, timezone);
  return `${p.day}-${p.month}-${p.year}, ${p.hour}:${p.minute}`;
}

export function formatDistributedFilename(date: Date, rawSlug: string, timezone = DEFAULT_TIMEZONE): string {
  const p = partsInTimezone(date, timezone);
  const slug = safeSlug(rawSlug);
  return `${p.day}-${p.month}-${p.year}-${p.hour}${p.minute}-${slug}.md`;
}

export function safeSlug(input: string): string {
  const slug = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .replace(/_/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
    .replace(/-$/g, '');
  return slug || 'note';
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

export function detectProjectSignals(text: string): string[] {
  const signals: string[] = [];
  for (const { label, pattern } of PROJECT_SIGNAL_PATTERNS) {
    if (pattern.test(text) && !signals.includes(label)) signals.push(label);
  }
  return signals;
}

export function classifyDistributedMessage(text: string): DistributedMessageType {
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
  ) {
    return 'weekly_synthesis_request';
  }
  if (/^\s*(draft|write|prepare|turn this into|make this into)\b/i.test(t)) return 'action_request';
  if (/\?$/.test(t) || /^\s*(what|why|how|when|where|which|who|list|show)\b/i.test(t)) return 'question';
  if (
    /\b(today|this morning|this afternoon|this evening|i realised|i realized|i noticed|i think|i wonder|i am starting to think)\b/i.test(
      t,
    )
  ) {
    return 'reflection';
  }

  return 'general_note';
}

export function normalizeDistributedMessageType(input: unknown, text: string): DistributedMessageType {
  return DISTRIBUTED_MESSAGE_TYPES.includes(input as DistributedMessageType)
    ? (input as DistributedMessageType)
    : classifyDistributedMessage(text);
}

export function ensureSecondBrainStructure(root: string): void {
  const realRoot = requireExistingRoot(root);
  for (const folder of SECOND_BRAIN_FOLDERS) {
    fs.mkdirSync(path.join(realRoot, folder), { recursive: true });
  }
}

export function resolveSecondBrainPath(root: string, folder: SecondBrainFolder, filename: string): string {
  if (!SECOND_BRAIN_FOLDERS.includes(folder)) {
    throw new Error(`Unsupported second-brain folder: ${folder}`);
  }
  if (!filename || filename !== path.basename(filename) || filename.includes('/') || filename.includes('\\')) {
    throw new Error(`Unsafe Markdown filename: ${filename}`);
  }
  if (!/^\d{2}-\d{2}-\d{2}-\d{4}-[a-z0-9-]+\.md$/.test(filename)) {
    throw new Error(`Markdown filename must follow DD-MM-YY-HHMM-short-slug.md: ${filename}`);
  }

  const realRoot = requireExistingRoot(root);
  const folderPath = path.join(realRoot, folder);
  fs.mkdirSync(folderPath, { recursive: true });
  const target = path.resolve(folderPath, filename);
  const rel = path.relative(realRoot, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Refusing to write outside second-brain root: ${target}`);
  }
  return target;
}

export function writeDistributedNote(input: WriteDistributedNoteInput): WriteDistributedNoteResult {
  const now = input.now ?? new Date();
  const timezone = input.timezone ?? DEFAULT_TIMEZONE;
  const body = input.transcript ?? input.rawText;
  const messageType = normalizeDistributedMessageType(input.messageType, body);
  const timestamp = formatDistributedTimestamp(now, timezone);
  const filename = formatDistributedFilename(now, input.slug ?? slugSource(body, messageType), timezone);
  const temporalMetadata = extractTemporalMetadata(body, now, timezone, messageType);
  const attentionMetadata = scoreAttention(body, messageType, temporalMetadata);
  const coachingPrompt = reflectionCoachingPrompt(body, messageType, attentionMetadata);

  ensureSecondBrainStructure(input.root);

  const rawPath = resolveSecondBrainPath(input.root, 'inbox-whatsapp', filename);
  const processedFolder = processedFolderFor(messageType);
  const processedPath = resolveSecondBrainPath(input.root, processedFolder, filename);

  writeNewMarkdown(rawPath, rawMarkdown({ ...input, messageType, timestamp, temporalMetadata, attentionMetadata }));
  writeNewMarkdown(
    processedPath,
    processedMarkdown({ ...input, messageType, timestamp, temporalMetadata, attentionMetadata, coachingPrompt }),
  );

  const deadlineWatchPath = appendDeadlineWatch(
    input.root,
    temporalMetadata,
    path.join('inbox-whatsapp', path.basename(rawPath)),
  );
  appendCaptureProvenance(input.root, {
    timestamp,
    filename,
    messageType,
    rawPath,
    processedPath,
    deadlineWatchPath,
    attentionMetadata,
    coachingPrompt,
  });

  return { messageType, timestamp, filename, rawPath, processedPath, deadlineWatchPath, coachingPrompt };
}

function requireExistingRoot(root: string): string {
  const realRoot = fs.realpathSync(root);
  const stat = fs.statSync(realRoot);
  if (!stat.isDirectory()) throw new Error(`Second-brain root is not a directory: ${root}`);
  return realRoot;
}

function writeNewMarkdown(filePath: string, content: string): void {
  try {
    fs.writeFileSync(filePath, content, { flag: 'wx' });
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'EEXIST') throw err;
    const ext = path.extname(filePath);
    const base = filePath.slice(0, -ext.length);
    for (let i = 2; i < 100; i++) {
      const candidate = `${base}-${i}${ext}`;
      try {
        fs.writeFileSync(candidate, content, { flag: 'wx' });
        return;
      } catch (inner: unknown) {
        if ((inner as NodeJS.ErrnoException).code !== 'EEXIST') throw inner;
      }
    }
    throw new Error(`Could not create a unique note path for ${filePath}`, { cause: err });
  }
}

function processedFolderFor(messageType: DistributedMessageType): SecondBrainFolder {
  if (messageType === 'reflection') return 'daily-reflections';
  if (messageType === 'weekly_synthesis_request') return 'weekly-reviews';
  if (messageType === 'durable_memory_candidate' || messageType === 'forget_or_correction_request')
    return 'pending-review';
  return 'processed-notes';
}

function slugSource(text: string, messageType: DistributedMessageType): string {
  const firstWords = text.split(/\s+/).slice(0, 7).join(' ');
  return firstWords || messageType;
}

const MONTH_PATTERN =
  'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|sept|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';

export function extractTemporalMetadata(
  text: string,
  now = new Date(),
  timezone = DEFAULT_TIMEZONE,
  messageType: DistributedMessageType = classifyDistributedMessage(text),
): TemporalMetadata {
  const capturedAt = formatDistributedTimestamp(now, timezone);
  const mentionedDates = extractMentionedDates(text, now, timezone);
  const hasDeadlineCue =
    /\b(deadline|due|by|before|after|decide by|submit by|meeting|meet|planned|upcoming|starts?|starting|appointment|transition|launch|milestone|review by)\b/i.test(
      text,
    );
  const deadlineCandidates = hasDeadlineCue ? mentionedDates : [];
  const decisionDate = messageType === 'decision' ? capturedAt : 'None detected';
  const defaultDecisionReview = `${formatDateWithUnspecifiedTime(addDays(now, 30), timezone)} (default decision review)`;
  const reviewAfter = deadlineCandidates[0] ?? (messageType === 'decision' ? defaultDecisionReview : 'None detected');
  const stalenessStatus =
    deadlineCandidates.length > 0
      ? 'Has dated follow-up candidates; review before the earliest relevant date.'
      : messageType === 'decision'
        ? 'Fresh decision; review if context changes or by the review date.'
        : 'No review date detected.';

  return {
    capturedAt,
    mentionedDates,
    deadlineCandidates,
    decisionDate,
    reviewAfter,
    stalenessStatus,
  };
}

function extractMentionedDates(text: string, now: Date, timezone: string): string[] {
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

  if (/\btomorrow\b/i.test(text)) {
    add(`${formatDateWithUnspecifiedTime(addDays(now, 1), timezone)} (relative: tomorrow)`);
  }
  if (/\bnext week\b/i.test(text)) {
    add(`${formatDateWithUnspecifiedTime(addDays(now, 7), timezone)} (relative: next week)`);
  }
  if (/\bnext month\b/i.test(text)) {
    add(`${formatDateWithUnspecifiedTime(addDays(now, 30), timezone)} (relative: next month)`);
  }

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

function formatDateWithUnspecifiedTime(date: Date, timezone: string): string {
  const p = partsInTimezone(date, timezone);
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

function hasClearActionSignal(text: string, messageType: DistributedMessageType): boolean {
  return (
    messageType === 'action_request' ||
    /\b(next action|todo|to do|please|draft|write|prepare|create|make|queue|handoff|follow up|send to codex|research|turn this into)\b/i.test(
      text,
    )
  );
}

export function scoreAttention(
  text: string,
  messageType: DistributedMessageType,
  temporalMetadata?: TemporalMetadata,
): AttentionMetadata {
  if (SENSITIVE_RE.test(text) || messageType === 'sensitive_data_warning') {
    return {
      importance: 'low',
      durability: 'blocked',
      actionability: 'none',
      timeSensitivity: 'none',
      projectSignals: [],
      rationale: 'Blocked from promotion because the content appears to contain prohibited sensitive material.',
    };
  }

  const signals = detectProjectSignals(text);
  const reasons: string[] = [];
  let score = 0;
  if (messageType === 'decision') {
    score += 3;
    reasons.push('decision');
  }
  if (
    messageType === 'durable_memory_candidate' ||
    /\b(remember|important to remember|standing rule|from now on)\b/i.test(text)
  ) {
    score += 3;
    reasons.push('durable-memory signal');
  }
  if (messageType === 'forget_or_correction_request' || /\b(changed my mind|obsolete|correction)\b/i.test(text)) {
    score += 2;
    reasons.push('correction signal');
  }
  if (messageType === 'weekly_synthesis_request') {
    score += 2;
    reasons.push('synthesis request');
  }
  if (hasClearActionSignal(text, messageType)) {
    score += 1;
    reasons.push('actionable request');
  }
  if (
    (temporalMetadata?.deadlineCandidates.length ?? 0) > 0 ||
    /\b(deadline|due|submit by|decide by|review by)\b/i.test(text)
  ) {
    score += 2;
    reasons.push('deadline or dated follow-up');
  } else if (
    (temporalMetadata?.mentionedDates.length ?? 0) > 0 ||
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
    messageType === 'decision' ||
    messageType === 'durable_memory_candidate' ||
    messageType === 'forget_or_correction_request' ||
    /\b(always|never|preference|prefer|default|standing rule|from now on|remember that|changed my mind)\b/i.test(text)
      ? 'durable'
      : signals.length > 0 || messageType === 'reflection' || messageType === 'weekly_synthesis_request'
        ? 'useful'
        : 'transient';
  const actionability: AttentionActionability = hasClearActionSignal(text, messageType)
    ? 'clear_action'
    : /\b(open question|risk|should|need to|follow up)\b/i.test(text) ||
        (temporalMetadata?.deadlineCandidates.length ?? 0) > 0
      ? 'possible'
      : 'none';
  const timeSensitivity: AttentionTimeSensitivity =
    (temporalMetadata?.deadlineCandidates.length ?? 0) > 0 ||
    /\b(deadline|due|submit by|decide by|review by)\b/i.test(text)
      ? 'deadline'
      : (temporalMetadata?.mentionedDates.length ?? 0) > 0 ||
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

export function reflectionCoachingPrompt(
  text: string,
  messageType: DistributedMessageType,
  attentionMetadata = scoreAttention(text, messageType),
): string | undefined {
  if (messageType === 'sensitive_data_warning') return 'Please resend a redacted version before I process this.';
  if (messageType === 'decision') return 'What evidence or change would make you revisit this decision?';
  if (messageType === 'action_request')
    return 'What would a good finished output look like, and where should Codex or the action bridge work?';
  if (messageType === 'forget_or_correction_request')
    return 'What old belief or memory should this supersede, and what should replace it?';
  if (attentionMetadata.actionability === 'possible') {
    return 'Is there a concrete next action here, or should I keep this as thinking material for now?';
  }
  if (attentionMetadata.durability === 'useful' && attentionMetadata.importance !== 'high') {
    return 'Is this a durable pivot I should remember, or just a useful reflection to keep in Markdown?';
  }
  if (messageType === 'reflection' && !/[?]/.test(text)) {
    return 'What is the decision, tension, or open question at the heart of this reflection?';
  }
  return undefined;
}

function appendCaptureProvenance(
  root: string,
  input: {
    timestamp: string;
    filename: string;
    messageType: DistributedMessageType;
    rawPath: string;
    processedPath: string;
    deadlineWatchPath?: string;
    attentionMetadata: AttentionMetadata;
    coachingPrompt?: string;
  },
): void {
  const realRoot = requireExistingRoot(root);
  const outputPaths = [input.rawPath, input.processedPath, input.deadlineWatchPath]
    .filter((value): value is string => Boolean(value))
    .map((filePath) => path.relative(realRoot, filePath).split(path.sep).join('/'));
  appendProvenanceEvent(realRoot, {
    id: input.filename.replace(/\.md$/, ''),
    kind: 'capture',
    title: `Captured ${input.messageType}`,
    summary: `Captured raw and processed Markdown at ${input.timestamp}.`,
    sourcePaths: [],
    outputPaths,
    metadata: {
      messageType: input.messageType,
      importance: input.attentionMetadata.importance,
      durability: input.attentionMetadata.durability,
      actionability: input.attentionMetadata.actionability,
      timeSensitivity: input.attentionMetadata.timeSensitivity,
      projectSignals: input.attentionMetadata.projectSignals,
    },
  });
  appendProvenanceEvent(realRoot, {
    id: `${input.filename.replace(/\.md$/, '')}-classification`,
    kind: 'classification',
    title: `Classified as ${input.messageType}`,
    summary: input.attentionMetadata.rationale,
    sourcePaths: outputPaths.slice(0, 1),
    outputPaths: outputPaths.slice(1, 2),
    metadata: {
      messageType: input.messageType,
      importance: input.attentionMetadata.importance,
      durability: input.attentionMetadata.durability,
    },
  });
  if (input.coachingPrompt) {
    appendProvenanceEvent(realRoot, {
      id: `${input.filename.replace(/\.md$/, '')}-coaching`,
      kind: 'coaching_prompt',
      title: 'Reflection coaching prompt',
      summary: input.coachingPrompt,
      sourcePaths: outputPaths,
      outputPaths: [],
      metadata: { messageType: input.messageType },
    });
  }
}

function ensureCaptureMetadataMarkdown(
  markdown: string,
  temporalMetadata: TemporalMetadata,
  attentionMetadata: AttentionMetadata,
): string {
  return ensureAttentionMarkdown(ensureTemporalMarkdown(markdown, temporalMetadata), attentionMetadata);
}

function appendDeadlineWatch(root: string, metadata: TemporalMetadata, sourceRelativePath: string): string | undefined {
  if (metadata.deadlineCandidates.length === 0) return undefined;
  const realRoot = requireExistingRoot(root);
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

function rawMarkdown(
  input: WriteDistributedNoteInput & {
    messageType: DistributedMessageType;
    timestamp: string;
    temporalMetadata: TemporalMetadata;
    attentionMetadata: AttentionMetadata;
  },
): string {
  const source = input.source ?? 'whatsapp-text';
  const body = input.transcript ?? input.rawText;
  const lines = [`# Raw WhatsApp Note — ${input.timestamp}`, '', '## Source', source, ''];
  if (source === 'whatsapp-audio' && input.audioPath) {
    lines.push('## Audio source path', input.audioPath, '');
  }
  lines.push(
    '## Inferred message type',
    input.messageType,
    '',
    ...temporalMarkdownLines(input.temporalMetadata),
    '',
    ...attentionMarkdownLines(input.attentionMetadata),
    '',
    '## Raw note',
    body,
    '',
  );
  return lines.join('\n');
}

function processedMarkdown(
  input: WriteDistributedNoteInput & {
    messageType: DistributedMessageType;
    timestamp: string;
    temporalMetadata: TemporalMetadata;
    attentionMetadata: AttentionMetadata;
    coachingPrompt?: string;
  },
): string {
  if (typeof input.processedMarkdown === 'string' && input.processedMarkdown.trim()) {
    return ensureCaptureMetadataMarkdown(input.processedMarkdown, input.temporalMetadata, input.attentionMetadata);
  }
  const markdown =
    input.messageType === 'decision'
      ? decisionMarkdown(input)
      : input.messageType === 'weekly_synthesis_request'
        ? synthesisMarkdown(input)
        : reflectionMarkdown(input);
  return ensureCaptureMetadataMarkdown(markdown, input.temporalMetadata, input.attentionMetadata);
}

function reflectionMarkdown(
  input: WriteDistributedNoteInput & {
    messageType: DistributedMessageType;
    timestamp: string;
    coachingPrompt?: string;
  },
): string {
  const triage = mnemonTriage(input.transcript ?? input.rawText, input.messageType);
  return [
    `# Reflection — ${input.timestamp}`,
    '',
    '## Raw reflection',
    input.transcript ?? input.rawText,
    '',
    '## Inferred message type',
    input.messageType,
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
    input.coachingPrompt ?? 'No follow-up needed.',
    '',
  ].join('\n');
}

function decisionMarkdown(
  input: WriteDistributedNoteInput & {
    messageType: DistributedMessageType;
    timestamp: string;
    coachingPrompt?: string;
  },
): string {
  const triage = mnemonTriage(input.transcript ?? input.rawText, input.messageType);
  return [
    `# Decision — ${input.timestamp}`,
    '',
    '## Raw decision statement',
    input.transcript ?? input.rawText,
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
    input.coachingPrompt ?? 'No follow-up needed.',
    '',
  ].join('\n');
}

function synthesisMarkdown(
  input: WriteDistributedNoteInput & { messageType: DistributedMessageType; timestamp: string },
): string {
  const triage = mnemonTriage(input.transcript ?? input.rawText, input.messageType);
  return [
    `# Synthesis — ${input.timestamp}`,
    '',
    '## Trigger',
    input.transcript ?? input.rawText,
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
}

export function mnemonTriage(
  text: string,
  messageType: DistributedMessageType,
): { recommendation: string; reason: string } {
  if (SENSITIVE_RE.test(text) || messageType === 'sensitive_data_warning') {
    return {
      recommendation: 'Do not store in Mnemon',
      reason: 'The content appears to involve prohibited sensitive data.',
    };
  }
  if (messageType === 'durable_memory_candidate' && /^\s*\/?remember\b/i.test(text)) {
    return {
      recommendation: 'Confirmed Mnemon candidate',
      reason: 'the owner explicitly asked Distributed Cognition to remember it.',
    };
  }
  if (messageType === 'decision') {
    return {
      recommendation: 'Propose for Mnemon after review',
      reason: 'Decisions and durable decision leanings are high-signal if safe and stable.',
    };
  }
  if (messageType === 'forget_or_correction_request') {
    return {
      recommendation: 'Create auditable correction',
      reason: 'Correction and forget requests should supersede old memory rather than silently overwrite it.',
    };
  }
  if (/\b(always|never|preference|prefer|default|standing rule|from now on|remember that)\b/i.test(text)) {
    return {
      recommendation: 'Ask before Mnemon',
      reason: 'This may affect future behaviour, so confirmation is needed unless explicitly marked remember.',
    };
  }
  if (messageType === 'weekly_synthesis_request') {
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
