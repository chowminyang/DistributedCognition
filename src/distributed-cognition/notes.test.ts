import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  classifyDistributedMessage,
  extractTemporalMetadata,
  formatDistributedFilename,
  formatDistributedTimestamp,
  mnemonTriage,
  normalizeDistributedMessageType,
  resolveSecondBrainPath,
  writeDistributedNote,
} from './notes.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-notes-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Distributed Cognition notes', () => {
  const fixed = new Date('2026-05-16T14:45:00.000Z');

  it('formats displayed timestamps as DD-MM-YY, HH:MM in Singapore time', () => {
    expect(formatDistributedTimestamp(fixed, 'Asia/Singapore')).toBe('16-05-26, 22:45');
  });

  it('formats filenames as DD-MM-YY-HHMM-short-slug.md', () => {
    expect(formatDistributedFilename(fixed, 'Production readiness!', 'Asia/Singapore')).toBe(
      '16-05-26-2245-production-readiness.md',
    );
  });

  it('blocks path traversal in Markdown writes', () => {
    expect(() => resolveSecondBrainPath(tmp, 'inbox-whatsapp', '../evil.md')).toThrow(/Unsafe Markdown filename/);
  });

  it('classifies natural-language decisions as decision', () => {
    expect(
      classifyDistributedMessage('Decision: p(AI)tient should prioritise production readiness before voice.'),
    ).toBe('decision');
  });

  it('defaults ordinary no-command reflections to reflection', () => {
    expect(classifyDistributedMessage('Today I realised the Office is not a tools office.')).toBe('reflection');
  });

  it('creates raw and processed Markdown files for a natural-language reflection', () => {
    const result = writeDistributedNote({
      root: tmp,
      now: fixed,
      timezone: 'Asia/Singapore',
      rawText: 'Today I realised the Office is an education transformation office.',
    });

    expect(result.messageType).toBe('reflection');
    expect(result.filename).toMatch(/^\d{2}-\d{2}-\d{2}-\d{4}-[a-z0-9-]+\.md$/);
    expect(fs.existsSync(result.rawPath)).toBe(true);
    expect(fs.existsSync(result.processedPath)).toBe(true);
    expect(result.rawPath).toContain(`${path.sep}inbox-whatsapp${path.sep}`);
    expect(result.processedPath).toContain(`${path.sep}daily-reflections${path.sep}`);

    const processed = fs.readFileSync(result.processedPath, 'utf-8');
    expect(processed).toContain('# Reflection — 16-05-26, 22:45');
    expect(processed).toContain('## Raw reflection');
    expect(processed).toContain('## Temporal metadata');
    expect(processed).toContain('Captured at: 16-05-26, 22:45');
    expect(processed).toContain('## Mnemon triage');
    expect(processed).toContain('Recommendation: Markdown only');
  });

  it('uses a synthesis template for periodic review requests', () => {
    const result = writeDistributedNote({
      root: tmp,
      now: fixed,
      timezone: 'Asia/Singapore',
      rawText: 'Summarise my week and flag stale open questions.',
    });

    expect(result.messageType).toBe('weekly_synthesis_request');
    expect(result.processedPath).toContain(`${path.sep}weekly-reviews${path.sep}`);
    const processed = fs.readFileSync(result.processedPath, 'utf-8');
    expect(processed).toContain('# Synthesis — 16-05-26, 22:45');
    expect(processed).toContain('## Stale items to revisit');
  });

  it('preserves audio source path and transcript separately', () => {
    const result = writeDistributedNote({
      root: tmp,
      now: fixed,
      timezone: 'Asia/Singapore',
      rawText: 'voice note',
      transcript: 'Today I realised voice notes are my best capture surface.',
      source: 'whatsapp-audio',
      audioPath: '/workspace/inbox/msg-1/audio.ogg',
    });

    const raw = fs.readFileSync(result.rawPath, 'utf-8');
    expect(raw).toContain('## Audio source path');
    expect(raw).toContain('/workspace/inbox/msg-1/audio.ogg');
    expect(raw).toContain('Today I realised voice notes are my best capture surface.');
  });

  it('allows an agent-written processed Markdown note', () => {
    const result = writeDistributedNote({
      root: tmp,
      now: fixed,
      timezone: 'Asia/Singapore',
      rawText: 'Today I realised the Office is an education transformation office.',
      processedMarkdown: '# Custom Processed Note\n\n## New insight\nSpecific synthesis.\n',
    });

    const processed = fs.readFileSync(result.processedPath, 'utf-8');
    expect(processed).toContain('# Custom Processed Note\n\n## New insight\nSpecific synthesis.');
    expect(processed).toContain('## Temporal metadata');
  });

  it('normalizes invalid message type strings back through the classifier', () => {
    expect(
      normalizeDistributedMessageType('reflection / project portfolio update', 'Today I realised something.'),
    ).toBe('reflection');
  });

  it('extracts temporal metadata and writes deadline-watch entries for dated follow-ups', () => {
    const metadata = extractTemporalMetadata(
      'Meeting is due by 18-05-26, 17:00. We will run sessions in August and September 2026.',
      fixed,
      'Asia/Singapore',
      'reflection',
    );

    expect(metadata.deadlineCandidates).toContain('18-05-26, 17:00');
    expect(metadata.mentionedDates).toContain('August 2026 (month only; no exact DD-MM-YY, HH:MM supplied)');

    const result = writeDistributedNote({
      root: tmp,
      now: fixed,
      timezone: 'Asia/Singapore',
      rawText: 'Meeting is due by 18-05-26, 17:00.',
      slug: 'meeting-follow-up',
    });

    expect(result.deadlineWatchPath).toBeTruthy();
    const watch = fs.readFileSync(path.join(tmp, 'open-questions', 'deadline-watch.md'), 'utf-8');
    expect(watch).toContain('# Deadline Watch');
    expect(watch).toContain('18-05-26, 17:00');
    expect(watch).toContain('Source note: inbox-whatsapp/16-05-26-2245-meeting-follow-up.md');
  });

  it('triages explicit remember requests as confirmed Mnemon candidates', () => {
    const triage = mnemonTriage('Remember that CORTEX is about tool-mediated judgement.', 'durable_memory_candidate');
    expect(triage.recommendation).toBe('Confirmed Mnemon candidate');
  });
});
