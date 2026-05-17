import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildAttentionCalibrationReport, renderAttentionCalibrationReport } from './attention-report.js';
import { buildMemoryHygieneReport, renderMemoryHygieneReport } from './memory-hygiene.js';
import { buildProjectOntology, renderProjectOntology } from './ontology.js';
import { appendProvenanceEvent, renderProvenanceMarkdown, summarizeProvenance } from './provenance.js';
import { writeDistributedNote } from './notes.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-hermes-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Distributed Cognition Hermes-inspired improvements', () => {
  const fixed = new Date('2026-05-16T14:45:00.000Z');

  it('builds an attention calibration report from scored captures and provenance', () => {
    writeDistributedNote({
      root: tmp,
      now: fixed,
      rawText: 'Decision: p(AI)tient should prioritise production readiness before voice.',
    });
    appendProvenanceEvent(tmp, {
      id: 'mem-1',
      kind: 'memory_promotion',
      title: 'p(AI)tient production readiness',
      sourcePaths: ['daily-reflections/16-05-26-2245-production-readiness.md'],
      outputPaths: ['approved-updates/16-05-26-2245-memory.md'],
      metadata: { status: 'current' },
    });

    const report = buildAttentionCalibrationReport(tmp);
    expect(report.captures.length).toBeGreaterThan(0);
    expect(report.promotedCount).toBe(1);
    expect(report.counts.importance.high).toBe(1);
    expect(renderAttentionCalibrationReport(report)).toContain('Calibration Feedback');
  });

  it('builds a project ontology from captured notes', () => {
    writeDistributedNote({
      root: tmp,
      now: fixed,
      rawText: 'Today I realised CORTEX is about tool-mediated judgement and uncertainty tolerance.',
    });

    const ontology = buildProjectOntology(tmp);
    const cortex = ontology.nodes.find((node) => node.name === 'CORTEX');
    expect(cortex?.sources.length).toBeGreaterThan(0);
    expect(renderProjectOntology(ontology)).toContain('## Themes');
    expect(renderProjectOntology(ontology)).toContain('uncertainty tolerance');
  });

  it('builds a memory hygiene report for changed-mind and correction notes', () => {
    fs.mkdirSync(path.join(tmp, 'approved-updates'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'pending-review'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'approved-updates', '16-05-26-2245-memory-demo.md'), '# Durable Memory Upgrade');
    fs.writeFileSync(
      path.join(tmp, 'pending-review', '16-05-26-2245-changed-my-mind.md'),
      'I changed my mind. This supersedes the earlier voice-first plan.',
    );

    const report = buildMemoryHygieneReport(tmp);
    expect(report.auditNotes).toHaveLength(1);
    expect(report.changedMindNotes).toHaveLength(1);
    expect(renderMemoryHygieneReport(report)).toContain('Changed-My-Mind');
  });

  it('renders a provenance ledger without leaking raw event details', () => {
    appendProvenanceEvent(tmp, {
      id: 'queue-1',
      kind: 'queue_created',
      title: 'Queued handoff',
      summary: 'Ask Codex to run tests.',
      sourcePaths: ['pending-review/16-05-26-2245-note.md'],
      outputPaths: ['.dc-index/codex-handoffs/queued/queue-1.json'],
      metadata: { target: 'codex-local' },
    });

    const summary = summarizeProvenance(tmp);
    expect(summary.byKind.queue_created).toBe(1);
    const markdown = renderProvenanceMarkdown(summary);
    expect(markdown).toContain('Provenance Ledger');
    expect(markdown).toContain('Queued handoff');
  });
});
