import fs from 'fs';
import path from 'path';

import { appendProvenanceEvent } from './provenance.js';

export interface MemoryHygieneReport {
  generatedAt: string;
  auditNotes: string[];
  changedMindNotes: string[];
  correctionNotes: string[];
  staleDecisionNotes: string[];
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

function requireRoot(root: string): string {
  const real = fs.realpathSync(root);
  if (!fs.statSync(real).isDirectory()) throw new Error(`Second-brain root is not a directory: ${root}`);
  return real;
}

function markdownFiles(root: string, folder: string): Array<{ relativePath: string; content: string }> {
  const dir = path.join(root, folder);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .map((name) => ({
      relativePath: `${folder}/${name}`,
      content: fs.readFileSync(path.join(dir, name), 'utf-8'),
    }));
}

export function buildMemoryHygieneReport(root: string): MemoryHygieneReport {
  const real = requireRoot(root);
  const approved = markdownFiles(real, 'approved-updates');
  const review = [
    ...markdownFiles(real, 'pending-review'),
    ...markdownFiles(real, 'decision-log'),
    ...markdownFiles(real, 'weekly-reviews'),
  ];

  return {
    generatedAt: sgtTimestamp(),
    auditNotes: approved
      .filter((note) => /\bDurable Memory Upgrade\b|## Mnemon\b/i.test(note.content))
      .map((note) => note.relativePath),
    changedMindNotes: review
      .filter((note) => /\bchanged my mind|obsolete|superseded|supersedes\b/i.test(note.content))
      .map((note) => note.relativePath),
    correctionNotes: review
      .filter((note) => /\bforget_or_correction_request|correction|forget\b/i.test(note.content))
      .map((note) => note.relativePath),
    staleDecisionNotes: review
      .filter((note) => /\bReview after:\s*(?!None detected)/i.test(note.content))
      .map((note) => note.relativePath),
  };
}

function listLinks(paths: string[]): string[] {
  return paths.length > 0 ? paths.slice(0, 20).map((item) => `- [[${item}]]`) : ['- None found'];
}

export function renderMemoryHygieneReport(report: MemoryHygieneReport): string {
  return [
    '---',
    'type: memory_hygiene',
    'system: distributed-cognition',
    `generated: "${report.generatedAt}"`,
    'tags:',
    '  - distributed-cognition/memory-hygiene',
    '---',
    '',
    `# Memory Hygiene - ${report.generatedAt}`,
    '',
    '## Current Rules',
    '- Mnemon should contain durable keys, pivots, decisions, preferences, corrections, and stable project constraints.',
    '- Raw transcripts, ordinary meeting clutter, and tentative mood should stay in Markdown.',
    '- Changed thinking should create a dated changed-my-mind or supersession note instead of silently overwriting memory.',
    '',
    '## Durable Memory Audit Notes',
    ...listLinks(report.auditNotes),
    '',
    '## Changed-My-Mind / Supersession Candidates',
    ...listLinks(report.changedMindNotes),
    '',
    '## Correction / Forget Candidates',
    ...listLinks(report.correctionNotes),
    '',
    '## Decisions With Review Windows',
    ...listLinks(report.staleDecisionNotes),
    '',
    '## Maintenance Prompts',
    '- Which of these memories should become obsolete?',
    '- Which decisions have changed enough to deserve a dated changed-my-mind note?',
    '- Which high-importance memories are still useful, and which are noise?',
    '',
  ].join('\n');
}

export function writeMemoryHygieneReport(root: string): string {
  const real = requireRoot(root);
  const wikiDir = path.join(real, 'project-wikis');
  fs.mkdirSync(wikiDir, { recursive: true });
  const report = buildMemoryHygieneReport(real);
  const target = path.join(wikiDir, 'memory-hygiene.md');
  fs.writeFileSync(target, renderMemoryHygieneReport(report));
  appendProvenanceEvent(real, {
    id: `memory-hygiene-${Date.now()}`,
    kind: 'memory_hygiene',
    title: 'Memory hygiene refreshed',
    summary: `Found ${report.auditNotes.length} durable audit notes and ${report.changedMindNotes.length} changed-mind candidates.`,
    sourcePaths: [...report.auditNotes, ...report.changedMindNotes, ...report.correctionNotes].slice(0, 30),
    outputPaths: ['project-wikis/memory-hygiene.md'],
    metadata: {
      auditNotes: report.auditNotes.length,
      changedMindNotes: report.changedMindNotes.length,
      correctionNotes: report.correctionNotes.length,
      staleDecisionNotes: report.staleDecisionNotes.length,
    },
  });
  return target;
}
