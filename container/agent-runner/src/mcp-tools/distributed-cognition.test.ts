import fs from 'fs';
import os from 'os';
import path from 'path';

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

import {
  applyPromotion,
  attentionCalibration,
  autoUpgradeMemory,
  buildCodexStatus,
  buildContextIndex,
  captureNote,
  captureAudioTranscriptForTest,
  createActionRequest,
  createCodexHandoff,
  formatReply,
  healthCheck,
  memoryHygiene,
  mnemonGraph,
  preparePromotion,
  projectOntology,
  provenanceLedger,
  readContext,
  readWebPage,
  resolveOpenAIApiKeyForTranscription,
  searchContext,
  updateProjectStatus,
  webSearch,
} from './distributed-cognition.js';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dc-index-'));
}

function toolText(result: Awaited<ReturnType<typeof buildContextIndex.handler>>): string {
  return result.content.map((item) => item.text).join('\n');
}

async function withTempMnemonDb<T>(fn: (dbPath: string) => Promise<T> | T): Promise<T> {
  const previous = process.env.MNEMON_DB_PATH;
  const root = tempRoot();
  const dbPath = path.join(root, '.mnemon', 'memory.db');
  process.env.MNEMON_DB_PATH = dbPath;
  try {
    return await fn(dbPath);
  } finally {
    if (previous === undefined) {
      delete process.env.MNEMON_DB_PATH;
    } else {
      process.env.MNEMON_DB_PATH = previous;
    }
  }
}

describe('Distributed Cognition context index', () => {
  test('builds a lightweight index and searches it without direct folder mounts', async () => {
    const root = tempRoot();
    fs.writeFileSync(
      path.join(root, 'project-map.md'),
      [
        '# Productive Struggle',
        '',
        'This file links productive struggle, uncertainty tolerance, and AI-enhanced assessment.',
        '',
      ].join('\n'),
    );

    const build = await buildContextIndex.handler({ root, indexRoot: root });
    expect(toolText(build)).toContain('Built Distributed Cognition context index with 1 file');
    expect(fs.existsSync(path.join(root, '.dc-index', 'context-index.jsonl'))).toBe(true);

    const search = await searchContext.handler({ query: 'productive struggle', indexRoot: root });
    const text = toolText(search);
    expect(text).toContain('indexed context hit');
    expect(text).toContain('custom:project-map.md');
    expect(text).toContain('uncertainty tolerance');
  });

  test('does not index blocked or sensitive context previews', async () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, 'secret-token.md'), 'productive struggle token should not be indexed');
    fs.writeFileSync(path.join(root, 'reflection.md'), 'This contains patient-identifiable information.');

    const build = await buildContextIndex.handler({ root, indexRoot: root });
    const text = toolText(build);
    expect(text).toContain('Built Distributed Cognition context index with 0 files');
    expect(text).toContain('Skipped: 1 file');

    const search = await searchContext.handler({ query: 'productive struggle', indexRoot: root });
    expect(toolText(search)).toContain('No context hits');
  });

  test('reads labeled custom context paths and blocks traversal', async () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, 'note.txt'), 'CORTEX is about tool-mediated judgement.');

    const read = await readContext.handler({ path: 'custom:note.txt', root });
    expect(toolText(read)).toContain('tool-mediated judgement');

    const traversal = await readContext.handler({ path: '../note.txt', root });
    expect(traversal.isError).toBe(true);
    expect(toolText(traversal)).toContain('Refusing to read outside');
  });

  test('normalizes invalid capture classifications and writes reflection folders', async () => {
    const root = tempRoot();
    const result = await captureNote.handler({
      root,
      rawText: 'Today I realised this belongs in daily reflections.',
      messageType: 'reflection / project portfolio update',
      slug: 'daily-reflection',
      sourceMessageId: 'whatsapp-session-row-1',
    });

    expect(toolText(result)).toContain('Captured reflection');
    const rawFiles = fs.readdirSync(path.join(root, 'inbox-whatsapp'));
    const raw = fs.readFileSync(path.join(root, 'inbox-whatsapp', rawFiles[0]), 'utf-8');
    expect(raw).toContain('## WhatsApp source message id\nwhatsapp-session-row-1');
    const dailyFiles = fs.readdirSync(path.join(root, 'daily-reflections'));
    expect(dailyFiles.some((file) => file.endsWith('daily-reflection.md'))).toBe(true);
    const processed = fs.readFileSync(path.join(root, 'daily-reflections', dailyFiles[0]), 'utf-8');
    expect(processed).toContain('## Attention metadata');
    expect(processed).toContain('Durability: useful');
    expect(processed).toContain('## Reflection coaching');
    const events = fs.readFileSync(path.join(root, '.dc-index', 'events.jsonl'), 'utf-8');
    expect(events).toContain('"kind":"capture"');
    expect(events).toContain('"kind":"coaching_prompt"');
  });

  test('writes attention, ontology, memory hygiene, and provenance pages', async () => {
    const root = tempRoot();
    await captureNote.handler({
      root,
      rawText: 'Decision: CORTEX should foreground uncertainty tolerance and tool-mediated judgement.',
      slug: 'cortex-decision',
    });
    fs.mkdirSync(path.join(root, 'approved-updates'), { recursive: true });
    fs.writeFileSync(path.join(root, 'approved-updates', '17-05-26-0815-memory-cortex.md'), '# Durable Memory Upgrade');
    fs.writeFileSync(
      path.join(root, 'pending-review', '17-05-26-0816-changed-my-mind.md'),
      'I changed my mind; this supersedes the old plan.',
    );

    expect(toolText(await attentionCalibration.handler({ root }))).toContain('attention calibration');
    expect(toolText(await projectOntology.handler({ root }))).toContain('project ontology');
    expect(toolText(await memoryHygiene.handler({ root }))).toContain('memory hygiene');
    expect(toolText(await provenanceLedger.handler({ root }))).toContain('provenance ledger');

    expect(fs.readFileSync(path.join(root, 'project-wikis', 'attention-calibration.md'), 'utf-8')).toContain(
      'Calibration Feedback',
    );
    expect(fs.readFileSync(path.join(root, 'project-wikis', 'project-ontology.md'), 'utf-8')).toContain('CORTEX');
    expect(fs.readFileSync(path.join(root, 'project-wikis', 'memory-hygiene.md'), 'utf-8')).toContain(
      'Changed-My-Mind',
    );
    expect(fs.readFileSync(path.join(root, 'project-wikis', 'provenance-ledger.md'), 'utf-8')).toContain(
      'Captured decision',
    );
  });

  test('resolves OpenAI transcription key from env before mounted second-brain .env fallback', () => {
    const root = tempRoot();
    const envFile = path.join(root, '.env');
    fs.writeFileSync(envFile, 'OPENAI_API_KEY="dummy-mounted-key"\n');

    expect(resolveOpenAIApiKeyForTranscription({ OPENAI_API_KEY: 'dummy-process-key' }, [envFile])).toBe(
      'dummy-process-key',
    );
    expect(resolveOpenAIApiKeyForTranscription({}, [envFile])).toBe('dummy-mounted-key');
  });

  test('captures a transcribed audio note as raw and processed Markdown by default', () => {
    const root = tempRoot();
    const result = captureAudioTranscriptForTest(
      '/workspace/inbox/msg/audio.opus',
      'Today I realised Distributed Cognition needs to turn audio reflections into processed notes.',
      { root, slug: 'audio-reflection' },
    );

    expect(result).toContain('Captured audio as reflection');
    const rawFiles = fs.readdirSync(path.join(root, 'inbox-whatsapp'));
    const processedFiles = fs.readdirSync(path.join(root, 'daily-reflections'));
    expect(rawFiles.some((file) => file.endsWith('audio-reflection.md'))).toBe(true);
    expect(processedFiles.some((file) => file.endsWith('audio-reflection.md'))).toBe(true);

    const raw = fs.readFileSync(
      path.join(root, 'inbox-whatsapp', rawFiles.find((file) => file.endsWith('audio-reflection.md'))!),
      'utf-8',
    );
    const processed = fs.readFileSync(
      path.join(root, 'daily-reflections', processedFiles.find((file) => file.endsWith('audio-reflection.md'))!),
      'utf-8',
    );
    expect(raw).toContain('## Source\nwhatsapp-audio');
    expect(raw).toContain('## Audio source path\n/workspace/inbox/msg/audio.opus');
    expect(processed).toContain('## Raw reflection');
    expect(processed).toContain('Today I realised Distributed Cognition');
  });

  test('redacts sensitive transcribed audio instead of writing verbatim content', () => {
    const root = tempRoot();
    const result = captureAudioTranscriptForTest(
      '/workspace/inbox/msg/audio.opus',
      'This audio contains patient identifiable information and should not be stored.',
      { root, slug: 'audio-sensitive' },
    );

    expect(result).toContain('Wrote redacted audit markers only');
    const rawFiles = fs.readdirSync(path.join(root, 'inbox-whatsapp'));
    const reviewFiles = fs.readdirSync(path.join(root, 'pending-review'));
    const raw = fs.readFileSync(path.join(root, 'inbox-whatsapp', rawFiles[0]), 'utf-8');
    const review = fs.readFileSync(path.join(root, 'pending-review', reviewFiles[0]), 'utf-8');
    expect(raw).not.toContain('patient identifiable information');
    expect(review).not.toContain('patient identifiable information');
    expect(raw).toContain('Transcript withheld');
  });

  test('appends temporal metadata to custom processed notes and writes deadline watch', async () => {
    const root = tempRoot();
    const result = await captureNote.handler({
      root,
      rawText: 'Meeting is due by 18-05-26, 17:00.',
      slug: 'meeting-follow-up',
      processedMarkdown: '# Custom Processed Note\n\n## Suggested next action\nPrepare the brief.\n',
    });

    const text = toolText(result);
    expect(text).toContain('deadline watch:');
    const processedFile = fs
      .readdirSync(path.join(root, 'processed-notes'))
      .find((file) => file.endsWith('meeting-follow-up.md'));
    expect(processedFile).toBeTruthy();
    const processed = fs.readFileSync(path.join(root, 'processed-notes', processedFile!), 'utf-8');
    expect(processed).toContain('## Temporal metadata');
    expect(processed).toContain('## Attention metadata');
    expect(processed).toContain('18-05-26, 17:00');
    expect(processed).toContain('Time sensitivity: deadline');

    const watch = fs.readFileSync(path.join(root, 'open-questions', 'deadline-watch.md'), 'utf-8');
    expect(watch).toContain('# Deadline Watch');
    expect(watch).toContain('18-05-26, 17:00');
  });

  test('prepares and applies approved Obsidian wiki promotions without writing Mnemon directly', async () => {
    const root = tempRoot();
    for (const folder of ['inbox-whatsapp', 'pending-review', 'project-wikis', 'approved-updates']) {
      fs.mkdirSync(path.join(root, folder), { recursive: true });
    }
    fs.writeFileSync(
      path.join(root, 'inbox-whatsapp', '17-05-26-0714-raw-audio-transcript.md'),
      [
        '# Raw WhatsApp Audio Transcript — 17-05-26, 07:14',
        '',
        'Captured at: 17-05-26, 07:14',
        '',
        '## Raw transcript',
        'p(AI)tient needs enterprise hosting and CORTEX needs reviewer-informed reframing.',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(root, 'pending-review', '17-05-26-0714-cortex-patient-grants.md'),
      [
        '# Reflection — 17-05-26, 07:14',
        '',
        'Captured at: 17-05-26, 07:14',
        '',
        '## Suggested next actions',
        'Prepare a one-page p(AI)tient enterprise brief.',
        '',
      ].join('\n'),
    );

    const prepare = await preparePromotion.handler({
      root,
      projectName: 'p(AI)tient',
      sourcePaths: [
        'pending-review/17-05-26-0714-cortex-patient-grants.md',
        'inbox-whatsapp/17-05-26-0714-raw-audio-transcript.md',
      ],
      proposedWikiMarkdown: [
        '### Current State',
        'p(AI)tient is moving from prototype toward enterprise simulation infrastructure.',
        '',
        '### Decisions',
        '- Leaning: pursue enterprise/vendor hosting if scaling beyond prototype use.',
        '',
        '### Open Questions',
        '- What is the minimum enterprise-ready version?',
        '',
        '### Next Actions',
        '- Prepare the enterprise brief.',
        '',
      ].join('\n'),
      mnemonCandidates: ['p(AI)tient is an AI communication simulation platform moving toward enterprise scaling.'],
    });

    const prepareText = toolText(prepare);
    expect(prepareText).toContain('Prepared promotion proposal');
    const proposalFile = fs
      .readdirSync(path.join(root, 'pending-review'))
      .find((file) => file.includes('promotion-patient'));
    expect(proposalFile).toBeTruthy();
    const proposalPath = path.join(root, 'pending-review', proposalFile!);
    const proposal = fs.readFileSync(proposalPath, 'utf-8');
    expect(proposal.indexOf('inbox-whatsapp/17-05-26-0714-raw-audio-transcript.md')).toBeLessThan(
      proposal.indexOf('pending-review/17-05-26-0714-cortex-patient-grants.md'),
    );
    expect(proposal).toContain('Proposed, not stored');

    const blocked = await applyPromotion.handler({
      root,
      proposalPath: `pending-review/${proposalFile}`,
      approved: false,
    });
    expect(blocked.isError).toBe(true);
    expect(toolText(blocked)).toContain('approved must be true');

    const applied = await applyPromotion.handler({
      root,
      proposalPath: `pending-review/${proposalFile}`,
      approved: true,
    });
    expect(toolText(applied)).toContain('Mnemon: no direct write performed');
    const wikiPath = path.join(root, 'project-wikis', 'patient.md');
    expect(fs.existsSync(wikiPath)).toBe(true);
    const wiki = fs.readFileSync(wikiPath, 'utf-8');
    expect(wiki).toContain('# p(AI)tient');
    expect(wiki).toContain('p(AI)tient is moving from prototype toward enterprise simulation infrastructure.');
    expect(wiki).toContain('[[inbox-whatsapp/17-05-26-0714-raw-audio-transcript|Raw WhatsApp Audio Transcript');
    expect(wiki).toContain(
      'Store only concise, high-signal, safe extracts via distributed_cognition_auto_upgrade_memory',
    );
    expect(fs.readdirSync(path.join(root, 'approved-updates')).some((file) => file.endsWith('.md'))).toBe(true);
  });

  test('automatically stores explicit durable memory in Mnemon with an audit note', async () => {
    await withTempMnemonDb(async (dbPath) => {
      const root = tempRoot();
      fs.mkdirSync(path.join(root, 'inbox-whatsapp'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'inbox-whatsapp', '17-05-26-0815-raw-note.md'),
        [
          '# Raw WhatsApp Note — 17-05-26, 08:15',
          '',
          'Captured at: 17-05-26, 08:15',
          '',
          '## Raw note',
          'Remember that CORTEX is about tool-mediated judgement, not just AI OSCEs.',
          '',
        ].join('\n'),
      );

      const result = await autoUpgradeMemory.handler({
        root,
        memory: 'CORTEX is about tool-mediated judgement, not just AI OSCEs.',
        title: 'CORTEX framing',
        messageType: 'durable_memory_candidate',
        layer: 'semantic',
        entityType: 'project',
        entityName: 'CORTEX',
        sourcePaths: ['inbox-whatsapp/17-05-26-0815-raw-note.md'],
        rationale: 'the owner explicitly asked Distributed Cognition to remember this CORTEX framing.',
      });

      const text = toolText(result);
      expect(text).toContain('Stored durable memory in Mnemon');
      const db = new Database(dbPath);
      try {
        const row = db
          .query('SELECT content, layer, entity_type, entity_name, source_file FROM memories LIMIT 1')
          .get() as Record<string, string>;
        expect(row.content).toBe('CORTEX is about tool-mediated judgement, not just AI OSCEs.');
        expect(row.layer).toBe('semantic');
        expect(row.entity_type).toBe('project');
        expect(row.entity_name).toBe('CORTEX');
        expect(row.source_file).toBe('inbox-whatsapp/17-05-26-0815-raw-note.md');
        const fts = db.query('SELECT content FROM memories_fts LIMIT 1').get() as Record<string, string>;
        expect(fts.content).toContain('tool-mediated judgement');
      } finally {
        db.close();
      }

      const audits = fs.readdirSync(path.join(root, 'approved-updates'));
      expect(audits.some((file) => /^\d{2}-\d{2}-\d{2}-\d{4}-memory-cortex-framing\.md$/.test(file))).toBe(true);
      const audit = fs.readFileSync(path.join(root, 'approved-updates', audits[0]), 'utf-8');
      expect(audit).toContain('## Status\nauto_stored');
      expect(audit).toContain('Raw transcript content was not stored in Mnemon');
    });
  });

  test('writes a Mnemon report and Obsidian Canvas graph for durable memory', async () => {
    await withTempMnemonDb(async () => {
      const root = tempRoot();
      const stored = await autoUpgradeMemory.handler({
        root,
        memory: 'Distributed Cognition should keep raw transcripts in Markdown and only promote durable pivots.',
        title: 'Durable memory filter',
        messageType: 'durable_memory_candidate',
        layer: 'procedural',
        entityType: 'rule',
        entityName: 'Mnemon filter',
        importance: 0.95,
        confidence: 0.93,
      });
      expect(toolText(stored)).toContain('Stored durable memory in Mnemon');

      const result = await mnemonGraph.handler({ root });
      const text = toolText(result);
      expect(text).toContain('Wrote Mnemon memory graph.');
      expect(text).toContain('memories: 1');
      const report = fs.readFileSync(path.join(root, 'project-wikis', 'mnemon-memory-report.md'), 'utf-8');
      expect(report).toContain('Durable memory filter');
      expect(report).toContain('[[mnemon-memory-graph.canvas|Mnemon Memory Graph Canvas]]');
      const canvas = JSON.parse(
        fs.readFileSync(path.join(root, 'project-wikis', 'mnemon-memory-graph.canvas'), 'utf-8'),
      ) as {
        nodes: Array<{ text?: string; color?: string }>;
        edges: unknown[];
      };
      expect(
        canvas.nodes.some((node) => node.text?.includes('Durable memory filter') && node.color === '#dc2626'),
      ).toBe(true);
      expect(canvas.edges.length).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(root, '.dc-index', 'mnemon-memory-graph.json'))).toBe(true);
    });
  });

  test('does not store low-signal ordinary notes in Mnemon', async () => {
    await withTempMnemonDb(async (dbPath) => {
      const root = tempRoot();
      const result = await autoUpgradeMemory.handler({
        root,
        memory: 'Had coffee before starting work.',
        messageType: 'general_note',
      });

      expect(toolText(result)).toContain('Memory not stored');
      expect(fs.existsSync(dbPath)).toBe(false);
    });
  });

  test('blocks sensitive or raw-dump Mnemon writes', async () => {
    await withTempMnemonDb(async () => {
      const root = tempRoot();
      const sensitive = await autoUpgradeMemory.handler({
        root,
        memory: 'Remember this patient-identifiable clinical detail.',
        messageType: 'durable_memory_candidate',
      });
      expect(sensitive.isError).toBe(true);
      expect(toolText(sensitive)).toContain('prohibited sensitive');

      const rawDump = await autoUpgradeMemory.handler({
        root,
        memory: ['# Raw Transcript', '', 'line 1', 'line 2'].join('\n'),
        messageType: 'durable_memory_candidate',
      });
      expect(rawDump.isError).toBe(true);
      expect(toolText(rawDump)).toContain('raw transcript');
    });
  });

  test('builds a Codex Workbench status page from mounted project folders', async () => {
    const root = tempRoot();
    const projectsRoot = tempRoot();
    const patient = path.join(projectsRoot, 'p(AI)tient');
    const e3 = path.join(projectsRoot, 'E3-Navigator Improved');
    fs.mkdirSync(patient, { recursive: true });
    fs.mkdirSync(e3, { recursive: true });
    fs.writeFileSync(
      path.join(patient, 'package.json'),
      JSON.stringify({
        dependencies: { next: '1.0.0', react: '1.0.0' },
        scripts: { dev: 'next dev', build: 'next build' },
      }),
    );
    fs.writeFileSync(path.join(e3, 'README.md'), '# E3 Navigator\n');

    const result = await buildCodexStatus.handler({ root, projectsRoot });

    const text = toolText(result);
    expect(text).toContain('Built Codex Workbench status for 2 projects');
    const wiki = fs.readFileSync(path.join(root, 'project-wikis', 'codex-workbench.md'), 'utf-8');
    expect(wiki).toContain('# Codex Workbench');
    expect(wiki).toContain('p(AI)tient');
    expect(wiki).toContain('E3-Navigator Improved');
    expect(wiki).toContain('next, node, react');
    expect(wiki).toContain('### Codex Handoffs');
    expect(wiki).toContain('### Action Requests');
    const index = JSON.parse(fs.readFileSync(path.join(root, '.dc-index', 'codex-status.json'), 'utf-8'));
    expect(index.projects).toHaveLength(2);
    expect(index.handoffSummary.queued).toBe(0);
  });

  test('updates project status pages and current-projects index safely', async () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, 'daily-reflections'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'daily-reflections', '17-05-26-0815-patient-reflection.md'),
      '# Reflection — 17-05-26, 08:15\n\np(AI)tient needs a production readiness map.\n',
    );

    const result = await updateProjectStatus.handler({
      root,
      projectName: 'p(AI)tient',
      status: 'active',
      currentState: 'Moving toward production readiness.',
      decisions: ['Prioritise production readiness before voice.'],
      openQuestions: ['What is the minimum safe launch surface?'],
      nextActions: ['Draft production readiness checklist.'],
      risks: ['Scope creep.'],
      reviewAfter: '18-05-26, 17:00',
      sourcePaths: ['daily-reflections/17-05-26-0815-patient-reflection.md'],
    });

    const text = toolText(result);
    expect(text).toContain('Updated project status');
    const wiki = fs.readFileSync(path.join(root, 'project-wikis', 'patient.md'), 'utf-8');
    expect(wiki).toContain('# Project — p(AI)tient');
    expect(wiki).toContain('Prioritise production readiness before voice.');
    expect(wiki).toContain('[[daily-reflections/17-05-26-0815-patient-reflection]]');
    const current = fs.readFileSync(path.join(root, 'project-wikis', 'current-projects.md'), 'utf-8');
    expect(current).toContain('[[project-wikis/patient|p(AI)tient]]');
    const index = JSON.parse(fs.readFileSync(path.join(root, '.dc-index', 'project-status.json'), 'utf-8'));
    expect(index.projects[0].status).toBe('active');

    const traversal = await updateProjectStatus.handler({
      root,
      projectName: 'CORTEX',
      sourcePaths: ['../outside.md'],
    });
    expect(traversal.isError).toBe(true);
    expect(toolText(traversal)).toContain('Refusing to read outside second-brain root');
  });

  test('formats DC replies and scrubs obvious private values', async () => {
    const fakeApiKey = 'sk-' + 'proj-' + 'abcdefghijklmnopqrstuvwxyz1234567890';
    const result = await formatReply.handler({
      message: `Distributed Cognition: Use OPENAI_API_KEY=${fakeApiKey} and call +65 8123 4567 from /Users/example/Dropbox.`,
    });
    const text = toolText(result);
    expect(text.startsWith('DC: ')).toBe(true);
    expect(text).toContain('OPENAI_API_KEY=[REDACTED_SECRET]');
    expect(text).toContain('[REDACTED_PHONE]');
    expect(text).toContain('/Users/<username>/Dropbox');
    expect(text).not.toContain('8123 4567');
  });

  test('writes a Distributed Cognition health report', async () => {
    const root = tempRoot();
    fs.mkdirSync(root, { recursive: true });
    const result = await healthCheck.handler({ root });
    const text = toolText(result);
    expect(text).toContain('Distributed Cognition health:');
    expect(fs.existsSync(path.join(root, 'project-wikis', 'system-health.md'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.dc-index', 'system-health.json'))).toBe(true);
    const report = JSON.parse(fs.readFileSync(path.join(root, '.dc-index', 'system-health.json'), 'utf-8'));
    expect(report.items.some((item: { label: string }) => item.label === 'second-brain root')).toBe(true);
  });

  test('queues a Codex handoff and blocks unsafe project/task inputs', async () => {
    const root = tempRoot();
    const projectsRoot = tempRoot();
    const patient = path.join(projectsRoot, 'p(AI)tient');
    fs.mkdirSync(patient, { recursive: true });
    fs.writeFileSync(path.join(patient, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
    await buildCodexStatus.handler({ root, projectsRoot });

    const result = await createCodexHandoff.handler({
      root,
      project: 'p(AI)tient',
      task: 'Fix the production readiness checklist and add tests for the new path.',
      target: 'codex-cloud',
      branch: 'main',
    });

    const text = toolText(result);
    expect(text).toContain('Queued Codex handoff');
    const notes = fs.readdirSync(path.join(root, 'pending-review'));
    expect(notes.some((file) => file.includes('codex-handoff-paitient'))).toBe(true);
    const queueDir = path.join(root, '.dc-index', 'codex-handoffs', 'queued');
    const queueFiles = fs.readdirSync(queueDir);
    expect(queueFiles).toHaveLength(1);
    const queued = JSON.parse(fs.readFileSync(path.join(queueDir, queueFiles[0]), 'utf-8'));
    expect(queued.projectName).toBe('p(AI)tient');
    expect(queued.relativeProjectPath).toBe('p(AI)tient');
    expect(queued.target).toBe('codex-cloud');

    const traversal = await createCodexHandoff.handler({
      root,
      project: '../p(AI)tient',
      task: 'Do this.',
    });
    expect(traversal.isError).toBe(true);
    expect(toolText(traversal)).toContain('Unsafe Codex project name');

    const sensitive = await createCodexHandoff.handler({
      root,
      project: 'p(AI)tient',
      task: 'Process this patient-identifiable case in the app.',
    });
    expect(sensitive.isError).toBe(true);
    expect(toolText(sensitive)).toContain('prohibited sensitive');
  });

  test('queues action requests for host bridge execution and blocks sensitive content', async () => {
    const root = tempRoot();
    fs.mkdirSync(root, { recursive: true });

    const result = await createActionRequest.handler({
      root,
      actionType: 'word_document',
      title: 'Leadership update',
      brief: 'Create a short Word document from the supplied Markdown.',
      contentMarkdown: '# Leadership update\n\n- AIME office setup\n- p(AI)tient production readiness',
      outputName: 'leadership-update',
    });

    const text = toolText(result);
    expect(text).toContain('Queued action request');
    expect(text).toContain('type: word_document');
    const notes = fs.readdirSync(path.join(root, 'pending-review'));
    expect(notes.some((file) => file.includes('action-word-document-leadership-update'))).toBe(true);
    const queueDir = path.join(root, '.dc-index', 'action-requests', 'queued');
    const queueFiles = fs.readdirSync(queueDir);
    expect(queueFiles).toHaveLength(1);
    const queued = JSON.parse(fs.readFileSync(path.join(queueDir, queueFiles[0]), 'utf-8'));
    expect(queued.actionType).toBe('word_document');
    expect(queued.contentMarkdown).toContain('AIME office setup');

    const sensitive = await createActionRequest.handler({
      root,
      actionType: 'powerpoint',
      title: 'Exam deck',
      brief: 'Create a deck from this exam material.',
    });
    expect(sensitive.isError).toBe(true);
    expect(toolText(sensitive)).toContain('prohibited sensitive');
  });

  test('validates direct web tools without touching private hosts or sensitive queries', async () => {
    const missingQuery = await webSearch.handler({ query: '' });
    expect(missingQuery.isError).toBe(true);
    expect(toolText(missingQuery)).toContain('query is required');

    const sensitiveQuery = await webSearch.handler({ query: 'patient-identifiable case example' });
    expect(sensitiveQuery.isError).toBe(true);
    expect(toolText(sensitiveQuery)).toContain('prohibited sensitive');

    const localhost = await readWebPage.handler({ url: 'http://127.0.0.1:3000/private' });
    expect(localhost.isError).toBe(true);
    expect(toolText(localhost)).toContain('Refusing private or local URL host');

    const credentialUrl = await readWebPage.handler({ url: 'https://user:pass@example.com/' });
    expect(credentialUrl.isError).toBe(true);
    expect(toolText(credentialUrl)).toContain('embedded credentials');

    const tokenUrl = await readWebPage.handler({ url: 'https://example.com/?access_token=secret' });
    expect(tokenUrl.isError).toBe(true);
    expect(toolText(tokenUrl)).toContain('secret-bearing query parameter');
  });

  test('blocks promotion source path traversal', async () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, 'pending-review'), { recursive: true });
    const result = await preparePromotion.handler({
      root,
      projectName: 'CORTEX',
      sourcePaths: ['../outside.md'],
    });

    expect(result.isError).toBe(true);
    expect(toolText(result)).toContain('Refusing to read outside second-brain root');
  });
});
