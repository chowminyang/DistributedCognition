import fs from 'fs';
import path from 'path';

import { readProvenanceEvents } from './provenance.js';

export interface AttentionCapture {
  relativePath: string;
  importance: string;
  durability: string;
  actionability: string;
  timeSensitivity: string;
  projectSignals: string[];
  rationale: string;
}

export interface AttentionCalibrationReport {
  generatedAt: string;
  captures: AttentionCapture[];
  counts: Record<string, Record<string, number>>;
  promotedCount: number;
  keptInMarkdownCount: number;
  coachingPromptCount: number;
}

const NOTE_FOLDERS = [
  'daily-reflections',
  'processed-notes',
  'pending-review',
  'weekly-reviews',
  'decision-log',
  'open-questions',
] as const;

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

function requireRoot(root: string): string {
  const real = fs.realpathSync(root);
  if (!fs.statSync(real).isDirectory()) throw new Error(`Second-brain root is not a directory: ${root}`);
  return real;
}

function readField(markdown: string, label: string): string {
  const match = markdown.match(new RegExp(`^${label}:\\s*(.+)$`, 'im'));
  return match?.[1]?.trim() || 'unspecified';
}

function parseAttention(relativePath: string, markdown: string): AttentionCapture | undefined {
  if (!/^## Attention metadata\b/m.test(markdown)) return undefined;
  return {
    relativePath,
    importance: readField(markdown, 'Importance'),
    durability: readField(markdown, 'Durability'),
    actionability: readField(markdown, 'Actionability'),
    timeSensitivity: readField(markdown, 'Time sensitivity'),
    projectSignals: readField(markdown, 'Project signals')
      .split(';')
      .map((item) => item.trim())
      .filter((item) => item && item !== 'None detected'),
    rationale: readField(markdown, 'Rationale'),
  };
}

function readAttentionCaptures(root: string): AttentionCapture[] {
  const real = requireRoot(root);
  const captures: AttentionCapture[] = [];
  for (const folder of NOTE_FOLDERS) {
    const dir = path.join(real, folder);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.md'))) {
      const relativePath = `${folder}/${file}`;
      const parsed = parseAttention(relativePath, fs.readFileSync(path.join(dir, file), 'utf-8'));
      if (parsed) captures.push(parsed);
    }
  }
  return captures.sort((a, b) => b.relativePath.localeCompare(a.relativePath));
}

function bump(counts: Record<string, Record<string, number>>, group: string, key: string): void {
  counts[group] ??= {};
  counts[group][key] = (counts[group][key] ?? 0) + 1;
}

export function buildAttentionCalibrationReport(root: string): AttentionCalibrationReport {
  const captures = readAttentionCaptures(root);
  const counts: Record<string, Record<string, number>> = {};
  for (const capture of captures) {
    bump(counts, 'importance', capture.importance);
    bump(counts, 'durability', capture.durability);
    bump(counts, 'actionability', capture.actionability);
    bump(counts, 'time_sensitivity', capture.timeSensitivity);
  }
  const events = readProvenanceEvents(root, { limit: 1_000 });
  return {
    generatedAt: sgtTimestamp(),
    captures,
    counts,
    promotedCount: events.filter((event) => event.kind === 'memory_promotion').length,
    keptInMarkdownCount: captures.filter(
      (capture) => capture.durability === 'transient' || capture.importance === 'low',
    ).length,
    coachingPromptCount: events.filter((event) => event.kind === 'coaching_prompt').length,
  };
}

function countsMarkdown(counts: Record<string, number> | undefined): string[] {
  const entries = Object.entries(counts ?? {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return entries.length > 0 ? entries.map(([key, value]) => `- ${key}: ${value}`) : ['- None'];
}

export function renderAttentionCalibrationReport(report: AttentionCalibrationReport): string {
  const recent = report.captures.slice(0, 12);
  return [
    '---',
    'type: attention_calibration',
    'system: distributed-cognition',
    `generated: "${report.generatedAt}"`,
    'tags:',
    '  - distributed-cognition/attention',
    '---',
    '',
    `# Attention Calibration - ${report.generatedAt}`,
    '',
    '## Summary',
    `- Captures scored: ${report.captures.length}`,
    `- Durable memories promoted: ${report.promotedCount}`,
    `- Kept in Markdown / low-signal: ${report.keptInMarkdownCount}`,
    `- Coaching prompts generated: ${report.coachingPromptCount}`,
    '',
    '## Importance',
    ...countsMarkdown(report.counts.importance),
    '',
    '## Durability',
    ...countsMarkdown(report.counts.durability),
    '',
    '## Actionability',
    ...countsMarkdown(report.counts.actionability),
    '',
    '## Time Sensitivity',
    ...countsMarkdown(report.counts.time_sensitivity),
    '',
    '## Calibration Feedback',
    '- Say "DC, promote more decisions" if important choices are staying as loose notes.',
    '- Say "DC, ignore logistics" if low-value meeting clutter is being over-scored.',
    '- Say "DC, challenge me more" if reflections are being filed without useful follow-up questions.',
    '- Say "DC, remember fewer things" if Mnemon starts feeling noisy.',
    '',
    '## Recent Attention Decisions',
    recent.length > 0
      ? recent
          .map(
            (capture) =>
              `- [[${capture.relativePath}]] — ${capture.importance}, ${capture.durability}, ${capture.actionability}, ${capture.timeSensitivity}; ${capture.rationale}`,
          )
          .join('\n')
      : 'No scored captures found yet.',
    '',
  ].join('\n');
}

export function writeAttentionCalibrationReport(root: string): string {
  const real = requireRoot(root);
  const wikiDir = path.join(real, 'project-wikis');
  fs.mkdirSync(wikiDir, { recursive: true });
  const target = path.join(wikiDir, 'attention-calibration.md');
  fs.writeFileSync(target, renderAttentionCalibrationReport(buildAttentionCalibrationReport(real)));
  return target;
}
