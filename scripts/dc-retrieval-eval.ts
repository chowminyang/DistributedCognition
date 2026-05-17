import fs from 'fs';
import os from 'os';
import path from 'path';

const DEFAULT_ROOT_CANDIDATES = [
  path.join(os.homedir(), 'Library/CloudStorage/Dropbox/Distributed-Cognition'),
  path.join(os.homedir(), 'Dropbox/Distributed-Cognition'),
];

type Args = {
  root?: string;
};

type ContextEntry = {
  label?: string;
  path?: string;
  title?: string;
  headings?: string[];
  preview?: string;
  tokenEstimate?: number;
};

type ContextManifest = {
  generatedAt?: string;
  entries?: unknown[];
  skipped?: Array<{ label?: string; path?: string; reason?: string }>;
};

type EvalQuery = {
  name: string;
  terms: string[];
};

const QUERIES: EvalQuery[] = [
  { name: 'AIME office and governance', terms: ['aime', 'office', 'governance', 'strategy'] },
  { name: 'p(AI)tient simulator', terms: ['patient', 'communication simulator', 'scenario', 'coaching'] },
  { name: 'CORTEX and OSCE', terms: ['cortex', 'osce', 'clinical reasoning'] },
  { name: 'productive struggle and uncertainty', terms: ['productive struggle', 'uncertainty', 'adaptive expertise'] },
  { name: 'assessment and exams', terms: ['assessment', 'exam', 'mcq', 'psychometric'] },
  { name: 'grants and funding', terms: ['grant', 'funding', 'proposal'] },
  { name: 'talks and workshops', terms: ['talk', 'workshop', 'presentation', 'deck'] },
  { name: 'publications and manuscripts', terms: ['publication', 'paper', 'manuscript', 'reviewer'] },
];

function usage(): never {
  console.error(
    [
      'Usage: pnpm run dc:retrieval-eval -- [options]',
      '',
      'Options:',
      '  --root <path>   Distributed Cognition second-brain root.',
      '',
      'You can also set DC_SECOND_BRAIN_ROOT.',
    ].join('\n'),
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--root') {
      const value = argv[++i];
      if (!value) usage();
      args.root = path.resolve(value);
    } else {
      usage();
    }
  }
  return args;
}

function resolveRoot(explicitRoot: string | undefined): string {
  if (explicitRoot) return path.resolve(explicitRoot);
  if (process.env.DC_SECOND_BRAIN_ROOT) return path.resolve(process.env.DC_SECOND_BRAIN_ROOT);
  const existingCandidate = DEFAULT_ROOT_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  if (existingCandidate) return existingCandidate;
  throw new Error('Second-brain root not configured. Pass --root <path> or set DC_SECOND_BRAIN_ROOT.');
}

function sgtTimestamp(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
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
  return `${parts.day}-${parts.month}-${parts.year}, ${parts.hour}:${parts.minute}`;
}

function scrub(input: string): string {
  return input
    .replace(/\b\d{8,15}@s\.whatsapp\.net\b/gi, '[REDACTED_WHATSAPP_JID]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
    .replace(/\+\d{1,3}(?:[\s-]?\d){6,14}\b/g, '[REDACTED_PHONE]')
    .replace(/\/Users\/[^/\s)]+/g, '/Users/<username>');
}

function readEntries(indexPath: string): ContextEntry[] {
  if (!fs.existsSync(indexPath)) return [];
  return fs
    .readFileSync(indexPath, 'utf-8')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ContextEntry);
}

function scoreEntry(entry: ContextEntry, query: EvalQuery): number {
  const haystack = [entry.label, entry.path, entry.title, ...(entry.headings ?? []), entry.preview]
    .join('\n')
    .toLowerCase();
  let score = 0;
  for (const term of query.terms) {
    const needle = term.toLowerCase();
    if (haystack.includes(needle)) score += needle.includes(' ') ? 3 : 1;
  }
  if ((entry.tokenEstimate ?? 0) > 4000) score -= 1;
  return score;
}

function topHits(entries: ContextEntry[], query: EvalQuery): Array<ContextEntry & { score: number }> {
  return entries
    .map((entry) => ({ ...entry, score: scoreEntry(entry, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

function reasonCounts(skipped: ContextManifest['skipped'] = []): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of skipped) {
    const reason = item.reason ?? 'unknown';
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
}

function labelCounts(entries: ContextEntry[]): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of entries) {
    const label = item.label ?? 'unknown';
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
}

function renderReport(entries: ContextEntry[], manifest: ContextManifest): { markdown: string; json: unknown } {
  const now = sgtTimestamp();
  const evaluations = QUERIES.map((query) => ({ query, hits: topHits(entries, query) }));
  const skippedReasons = reasonCounts(manifest.skipped);
  const labels = labelCounts(entries);
  const json = {
    generatedAt: now,
    contextGeneratedAt: manifest.generatedAt,
    indexed: entries.length,
    skipped: manifest.skipped?.length ?? 0,
    labels,
    skippedReasons,
    evaluations: evaluations.map(({ query, hits }) => ({
      name: query.name,
      hitCount: hits.length,
      topHits: hits.map((hit) => ({ label: hit.label, path: scrub(hit.path ?? ''), score: hit.score })),
    })),
  };
  const lines = [
    '---',
    'type: retrieval_eval_report',
    'system: distributed-cognition',
    `generated: "${now}"`,
    'tags:',
    '  - distributed-cognition/retrieval-eval',
    '---',
    '',
    `# Retrieval Eval Report - ${now}`,
    '',
    '## Index Summary',
    `- Context generated: ${manifest.generatedAt ?? 'unknown'}`,
    `- Indexed files: ${entries.length}`,
    `- Skipped files: ${manifest.skipped?.length ?? 0}`,
    '',
    '## Indexed Source Mix',
    ...labels.map((item) => `- ${item.label}: ${item.count}`),
    '',
    '## Query Coverage',
  ];
  for (const { query, hits } of evaluations) {
    lines.push('', `### ${query.name}`);
    if (hits.length === 0) {
      lines.push('- No indexed hits. This may need better source labels or more explicit project pages.');
    } else {
      for (const hit of hits) {
        lines.push(`- ${hit.label ?? 'unknown'} / ${scrub(hit.path ?? 'unknown')} (score ${hit.score})`);
      }
    }
  }
  lines.push(
    '',
    '## What To Promote',
    '- Promote stable project definitions, decisions, pivots, recurring themes, named open questions, and dated commitments.',
    '- Promote source-backed summaries into project wiki pages only after the raw note and processed note agree.',
    '- Use Mnemon for durable keys and rules, not raw transcripts or every meeting detail.',
    '',
    '## What To Ignore Or Keep As Markdown',
    '- Keep low-signal meeting clutter, transient phrasing, draft fragments, and raw transcript detail in Markdown.',
    '- Keep parser failures and skipped files out of Mnemon unless a human extracts a stable point manually.',
    '- Do not promote anything marked sensitive, exam-like, HR-related, learner-identifiable, patient-identifiable, or confidential.',
    '',
    '## Top Skip Reasons',
    ...(skippedReasons.length > 0
      ? skippedReasons.slice(0, 10).map((item) => `- ${scrub(item.reason)}: ${item.count}`)
      : ['- No skipped files recorded.']),
    '',
  );
  return { markdown: lines.join('\n'), json };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const root = resolveRoot(args.root);
  const indexPath = path.join(root, '.dc-index', 'context-index.jsonl');
  const manifestPath = path.join(root, '.dc-index', 'context-index-manifest.json');
  const manifest = fs.existsSync(manifestPath)
    ? (JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as ContextManifest)
    : {};
  const entries = readEntries(indexPath);
  const { markdown, json } = renderReport(entries, manifest);
  const wikiDir = path.join(root, 'project-wikis');
  fs.mkdirSync(wikiDir, { recursive: true });
  fs.mkdirSync(path.join(root, '.dc-index'), { recursive: true });
  const markdownPath = path.join(wikiDir, 'retrieval-eval-report.md');
  const jsonPath = path.join(root, '.dc-index', 'retrieval-eval-report.json');
  fs.writeFileSync(markdownPath, markdown);
  fs.writeFileSync(jsonPath, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`Wrote ${markdownPath}`);
  console.log(`Wrote ${jsonPath}`);
}

main();
