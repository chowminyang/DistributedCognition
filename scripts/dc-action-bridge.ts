import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';

import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import { appendProgressEvent, type DistributedQueueStatus } from '../src/distributed-cognition/queue-status.js';

const DEFAULT_SECOND_BRAIN_ROOT = path.join(os.homedir(), 'Library/CloudStorage/Dropbox/Distributed-Cognition');
const CONFIG_VERSION = 1;
const MAX_LOCAL_ARTIFACT_CHARS = 80_000;
const ACTION_TYPES = ['web_research', 'word_document', 'powerpoint', 'codex_handoff', 'manual_review'] as const;

type ActionType = (typeof ACTION_TYPES)[number];
type ActionTarget = 'local' | 'codex-local' | 'codex-cloud' | 'queue-only';

const require = createRequire(import.meta.url);

interface Args {
  command: 'process' | 'init';
  root: string;
  configPath?: string;
  execute: boolean;
  limit: number;
}

interface ActionConfig {
  enabled: boolean;
  target: ActionTarget;
  cloudEnv?: string;
}

interface ActionBridgeConfig {
  version: typeof CONFIG_VERSION;
  outputRoot: string;
  codexLocal?: {
    enabled?: boolean;
    workingRoot?: string;
    model?: string;
    sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
    approvalPolicy?: 'never' | 'on-request' | 'untrusted';
    webSearch?: boolean;
    timeoutMs?: number;
    openApp?: boolean;
  };
  actions: Record<ActionType, ActionConfig>;
}

interface ActionRequestRecord {
  version: number;
  id: string;
  createdAt: string;
  status: string;
  actionType: ActionType;
  title: string;
  brief: string;
  contentMarkdown?: string;
  outputName?: string;
  target?: ActionTarget;
  priority?: string;
  sourceNotePaths?: string[];
  notePath?: string;
}

interface SubmitResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
  cloudUrl?: string;
  cloudTaskId?: string;
  lastMessagePath?: string;
}

interface ArtifactResult {
  outputPath: string;
  outputRelativePath: string;
}

function usage(): never {
  console.error(
    [
      'Usage: pnpm run dc:action-bridge -- [process|init] [options]',
      '',
      'Options:',
      '  --execute        Execute queued action requests locally on this host. Omit for dry-run.',
      '  --root <path>    Distributed Cognition second-brain root.',
      '  --config <path>  Action bridge config path.',
      '  --limit <n>      Maximum queued actions to process. Default: 5.',
    ].join('\n'),
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: 'process',
    root: DEFAULT_SECOND_BRAIN_ROOT,
    execute: false,
    limit: 5,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      continue;
    } else if (arg === 'process' || arg === 'init') {
      args.command = arg;
    } else if (arg === '--execute') {
      args.execute = true;
    } else if (arg === '--root') {
      const value = argv[++i];
      if (!value) usage();
      args.root = path.resolve(value);
    } else if (arg === '--config') {
      const value = argv[++i];
      if (!value) usage();
      args.configPath = path.resolve(value);
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

function filenameTimestamp(date = new Date()): string {
  const [datePart, timePart] = sgtTimestamp(date).split(', ');
  return `${datePart}-${timePart.replace(':', '')}`;
}

function slug(input: string): string {
  return (
    input
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .replace(/_/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60)
      .replace(/-$/g, '') || 'action'
  );
}

function safeJoin(root: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('\0')) {
    throw new Error(`Unsafe relative path: ${relativePath}`);
  }
  const resolved = path.resolve(root, relativePath);
  const rootResolved = path.resolve(root);
  const rel = path.relative(rootResolved, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Path escapes root: ${relativePath}`);
  return resolved;
}

function indexDir(root: string): string {
  return path.join(root, '.dc-index');
}

function defaultConfigPath(root: string): string {
  return path.join(indexDir(root), 'action-bridge.config.json');
}

function actionDirs(root: string): { queued: string; completed: string; failed: string } {
  const base = path.join(indexDir(root), 'action-requests');
  return {
    queued: path.join(base, 'queued'),
    completed: path.join(base, 'completed'),
    failed: path.join(base, 'failed'),
  };
}

function defaultConfig(): ActionBridgeConfig {
  return {
    version: CONFIG_VERSION,
    outputRoot: 'action-outputs',
    codexLocal: {
      enabled: true,
      workingRoot: '.',
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
      webSearch: true,
      timeoutMs: 600_000,
      openApp: false,
    },
    actions: {
      word_document: { enabled: true, target: 'codex-local' },
      powerpoint: { enabled: true, target: 'codex-local' },
      web_research: { enabled: true, target: 'codex-local' },
      codex_handoff: { enabled: false, target: 'queue-only' },
      manual_review: { enabled: false, target: 'queue-only' },
    },
  };
}

function writeTemplateConfig(configPath: string): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(defaultConfig(), null, 2)}\n`, { flag: 'wx' });
}

function loadConfig(configPath: string): ActionBridgeConfig {
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as ActionBridgeConfig;
  if (parsed.version !== CONFIG_VERSION || !parsed.actions || typeof parsed.actions !== 'object') {
    throw new Error(`Unsupported action bridge config at ${configPath}`);
  }
  const defaults = defaultConfig();
  return {
    ...defaults,
    ...parsed,
    outputRoot: parsed.outputRoot || defaults.outputRoot,
    codexLocal: { ...defaults.codexLocal, ...(parsed.codexLocal ?? {}) },
    actions: { ...defaults.actions, ...parsed.actions },
  };
}

function readQueued(root: string, limit: number): Array<{ filePath: string; record: ActionRequestRecord }> {
  const dirs = actionDirs(root);
  if (!fs.existsSync(dirs.queued)) return [];
  return fs
    .readdirSync(dirs.queued)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .slice(0, limit)
    .map((file) => {
      const filePath = path.join(dirs.queued, file);
      return {
        filePath,
        record: JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ActionRequestRecord,
      };
    });
}

function validateRecord(record: ActionRequestRecord): void {
  if (!record.id || !/^[a-z0-9-]+$/i.test(record.id)) throw new Error('Queued action has unsafe or missing id.');
  if (!ACTION_TYPES.includes(record.actionType)) throw new Error(`Unsupported action type: ${record.actionType}`);
  if (!record.title || !record.brief) throw new Error('Queued action is missing title or brief.');
  const combined = `${record.title}\n${record.brief}\n${record.contentMarkdown ?? ''}`;
  if (combined.length > MAX_LOCAL_ARTIFACT_CHARS) throw new Error('Queued action content is too long.');
  if (/patient-identifiable|learner-identifiable|\bHR\b|exam material|answer[- ]?key|confidential/i.test(combined)) {
    throw new Error('Queued action appears to include prohibited sensitive content.');
  }
}

function markdownForArtifact(record: ActionRequestRecord): string {
  return (record.contentMarkdown?.trim() || [`# ${record.title}`, '', record.brief].join('\n')).slice(
    0,
    MAX_LOCAL_ARTIFACT_CHARS,
  );
}

function markdownBlocks(
  markdown: string,
): Array<{ type: 'heading' | 'bullet' | 'paragraph'; level: number; text: string }> {
  const blocks: Array<{ type: 'heading' | 'bullet' | 'paragraph'; level: number; text: string }> = [];
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() });
      continue;
    }
    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      blocks.push({ type: 'bullet', level: 0, text: bullet[1].trim() });
      continue;
    }
    blocks.push({ type: 'paragraph', level: 0, text: trimmed });
  }
  return blocks.length > 0
    ? blocks
    : [{ type: 'paragraph', level: 0, text: markdown.trim() || 'No content supplied.' }];
}

function outputPath(
  root: string,
  config: ActionBridgeConfig,
  record: ActionRequestRecord,
  extension: string,
): ArtifactResult {
  const relativeDir = config.outputRoot || 'action-outputs';
  const outputDir = safeJoin(root, relativeDir);
  fs.mkdirSync(outputDir, { recursive: true });
  const base = `${filenameTimestamp()}-${slug(record.outputName || record.title)}.${extension}`;
  const out = path.join(outputDir, base);
  return {
    outputPath: out,
    outputRelativePath: path.relative(root, out).split(path.sep).join('/'),
  };
}

async function createDocx(
  root: string,
  config: ActionBridgeConfig,
  record: ActionRequestRecord,
): Promise<ArtifactResult> {
  const result = outputPath(root, config, record, 'docx');
  const children = markdownBlocks(markdownForArtifact(record)).map((block) => {
    if (block.type === 'heading') {
      const heading =
        block.level <= 1 ? HeadingLevel.HEADING_1 : block.level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3;
      return new Paragraph({ text: block.text, heading });
    }
    if (block.type === 'bullet') return new Paragraph({ text: block.text, bullet: { level: 0 } });
    return new Paragraph({ children: [new TextRun(block.text)] });
  });
  const doc = new Document({
    creator: 'Distributed Cognition',
    title: record.title,
    description: record.brief,
    sections: [{ properties: {}, children }],
  });
  fs.writeFileSync(result.outputPath, await Packer.toBuffer(doc));
  return result;
}

function splitSlides(markdown: string, fallbackTitle: string): Array<{ title: string; bullets: string[] }> {
  const sections: Array<{ title: string; bullets: string[] }> = [];
  let current: { title: string; bullets: string[] } | undefined;
  for (const block of markdownBlocks(markdown)) {
    if (block.type === 'heading' && block.level <= 2) {
      if (current) sections.push(current);
      current = { title: block.text, bullets: [] };
    } else {
      current ??= { title: fallbackTitle, bullets: [] };
      current.bullets.push(block.text);
    }
  }
  if (current) sections.push(current);
  return sections.length > 0 ? sections.slice(0, 20) : [{ title: fallbackTitle, bullets: ['No content supplied.'] }];
}

async function createPptx(
  root: string,
  config: ActionBridgeConfig,
  record: ActionRequestRecord,
): Promise<ArtifactResult> {
  const result = outputPath(root, config, record, 'pptx');
  const PptxGenCtor = require('pptxgenjs') as { new (): any };
  const pptx = new PptxGenCtor();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'Distributed Cognition';
  pptx.subject = record.brief;
  pptx.title = record.title;
  pptx.company = 'Distributed Cognition';

  for (const item of splitSlides(markdownForArtifact(record), record.title)) {
    const slide = pptx.addSlide();
    slide.background = { color: 'F8FAFC' };
    slide.addText(item.title, {
      x: 0.55,
      y: 0.35,
      w: 12.2,
      h: 0.75,
      fontFace: 'Aptos Display',
      fontSize: 30,
      bold: true,
      color: '111827',
    });
    const bulletText = item.bullets
      .slice(0, 8)
      .map((bullet) => `• ${bullet}`)
      .join('\n');
    slide.addText(bulletText || ' ', {
      x: 0.75,
      y: 1.35,
      w: 11.6,
      h: 5.5,
      fontFace: 'Aptos',
      fontSize: 20,
      color: '1F2937',
      breakLine: false,
      fit: 'shrink',
    });
    slide.addShape(pptx.ShapeType.line, { x: 0.55, y: 1.12, w: 12.2, h: 0, line: { color: 'CBD5E1', width: 1 } });
  }

  await pptx.writeFile({ fileName: result.outputPath });
  return result;
}

function codexPrompt(record: ActionRequestRecord): string {
  const requestedOutput =
    record.actionType === 'word_document'
      ? 'Create a polished .docx artifact under action-outputs/ unless the brief explicitly asks for a different safe path.'
      : record.actionType === 'powerpoint'
        ? 'Create a polished .pptx artifact under action-outputs/ unless the brief explicitly asks for a different safe path.'
        : record.actionType === 'web_research'
          ? 'Produce a source-grounded Markdown research note under action-outputs/ with dated source URLs.'
          : 'Produce the requested local output under action-outputs/ when an artifact is needed.';
  return [
    'Task requested via Distributed Cognition WhatsApp.',
    '',
    'Role:',
    'You are a local Codex agent executing a heavier action request for Distributed Cognition. Convert the owner request into a concrete local artifact or research output while keeping all outputs inside the configured folder.',
    '',
    `Action type: ${record.actionType}`,
    `Title: ${record.title}`,
    `Queued at: ${record.createdAt}`,
    record.notePath ? `Action note: ${record.notePath}` : 'Action note: not supplied',
    '',
    'Brief:',
    record.brief,
    '',
    record.contentMarkdown ? `Draft/context Markdown:\n${record.contentMarkdown}` : '',
    '',
    'Requested local output:',
    requestedOutput,
    '',
    'Execution style:',
    '- Inspect any supplied source notes or draft content before writing.',
    '- Keep the output practical, polished, and locally saved.',
    '- Cite source URLs with access dates for web research.',
    '- For documents and decks, create the actual file rather than only describing it.',
    '',
    'Boundaries:',
    "- This is local Codex work on the owner's Mac, not Codex Cloud.",
    '- Do not print, request, or commit secrets.',
    '- Do not process patient-identifiable, learner-identifiable, HR, exam, or confidential institutional data.',
    '- If this is web research, provide concise findings with dated sources and uncertainty notes.',
    '- Keep generated files inside the Distributed Cognition folder, preferably under action-outputs/.',
    '- Report created output paths, verification, and residual risks in the final response.',
  ].join('\n');
}

function progressTitle(record: ActionRequestRecord): string {
  return `${record.actionType}: ${record.title}`;
}

function recordProgress(
  root: string,
  record: ActionRequestRecord,
  status: DistributedQueueStatus,
  detail: string,
): void {
  appendProgressEvent(root, {
    kind: 'action_request',
    id: record.id,
    status,
    title: progressTitle(record),
    target: record.target,
    detail,
  });
}

function codexLocalWorkingRoot(root: string, config: ActionBridgeConfig): string {
  const configured = config.codexLocal?.workingRoot?.trim() || '.';
  if (path.isAbsolute(configured)) {
    const rootResolved = path.resolve(root);
    const resolved = path.resolve(configured);
    const rel = path.relative(rootResolved, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`codexLocal.workingRoot must stay inside the Distributed Cognition root: ${configured}`);
    }
    return resolved;
  }
  return safeJoin(root, configured);
}

function codexLocalOutputDir(root: string, config: ActionBridgeConfig): string {
  const outputDir = safeJoin(root, config.outputRoot || 'action-outputs');
  fs.mkdirSync(outputDir, { recursive: true });
  return outputDir;
}

function runLocalCodexAction(root: string, config: ActionBridgeConfig, record: ActionRequestRecord): SubmitResult {
  if (config.codexLocal?.enabled === false)
    throw new Error('Local Codex execution is disabled in action bridge config.');
  const workingRoot = codexLocalWorkingRoot(root, config);
  const outputDir = codexLocalOutputDir(root, config);
  const localOutputDir = safeJoin(root, '.dc-index/action-requests/local-codex-output');
  fs.mkdirSync(localOutputDir, { recursive: true });
  const lastMessagePath = path.join(localOutputDir, `${record.id}-last-message.md`);
  const prompt = [
    codexPrompt(record),
    '',
    `Distributed Cognition root: ${root}`,
    `Required output folder: ${outputDir}`,
    `Last-message report path: ${lastMessagePath}`,
  ].join('\n');
  const args = ['--ask-for-approval', config.codexLocal?.approvalPolicy ?? 'never'];
  if (config.codexLocal?.webSearch !== false) args.push('--search');
  args.push(
    'exec',
    '--skip-git-repo-check',
    '--cd',
    workingRoot,
    '--sandbox',
    config.codexLocal?.sandbox ?? 'danger-full-access',
    '--output-last-message',
    lastMessagePath,
  );
  if (config.codexLocal?.model) args.push('--model', config.codexLocal.model);
  args.push('-');

  const result = spawnSync('codex', args, {
    cwd: workingRoot,
    input: prompt,
    encoding: 'utf-8',
    timeout: config.codexLocal?.timeoutMs ?? 600_000,
    maxBuffer: 4_000_000,
  });
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  if (config.codexLocal?.openApp) {
    spawnSync('codex', ['app', workingRoot], { encoding: 'utf-8', timeout: 15_000, maxBuffer: 250_000 });
  }
  return {
    ok: result.status === 0,
    status: result.status,
    stdout,
    stderr,
    lastMessagePath: path.relative(root, lastMessagePath).split(path.sep).join('/'),
  };
}

function submitCodexAction(record: ActionRequestRecord, cloudEnv: string): SubmitResult {
  const result = spawnSync('codex', ['cloud', 'exec', '--env', cloudEnv, codexPrompt(record)], {
    cwd: process.cwd(),
    encoding: 'utf-8',
    timeout: 120_000,
    maxBuffer: 2_000_000,
  });
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const cloudUrl = stdout.match(/https:\/\/chatgpt\.com\/codex\/tasks\/[^\s)]+/)?.[0];
  const cloudTaskId = stdout.match(/\btask_[A-Za-z0-9_]+\b/)?.[0] ?? cloudUrl?.split('/').pop();
  return {
    ok: result.status === 0 && Boolean(cloudUrl),
    status: result.status,
    stdout,
    stderr,
    cloudUrl,
    cloudTaskId,
  };
}

function updateNote(
  root: string,
  record: ActionRequestRecord,
  status: 'completed' | 'failed',
  details: string[],
): void {
  if (!record.notePath) return;
  const notePath = safeJoin(root, record.notePath);
  if (!fs.existsSync(notePath)) return;
  let text = fs.readFileSync(notePath, 'utf-8');
  text = text.replace(/(## Status\n)queued/, `$1${status}`);
  const heading = status === 'completed' ? '## Action Output' : '## Bridge Failure';
  if (!text.includes(heading)) text += `\n${heading}\n${details.join('\n')}\n`;
  fs.writeFileSync(notePath, text);
}

function moveRecord(
  root: string,
  queuedPath: string,
  record: ActionRequestRecord,
  status: 'completed' | 'failed',
  extra: Record<string, unknown>,
): void {
  const dirs = actionDirs(root);
  fs.mkdirSync(dirs.completed, { recursive: true });
  fs.mkdirSync(dirs.failed, { recursive: true });
  const destination = path.join(status === 'completed' ? dirs.completed : dirs.failed, `${record.id}.json`);
  fs.writeFileSync(
    destination,
    `${JSON.stringify(
      {
        ...record,
        status,
        [`${status}At`]: sgtTimestamp(),
        ...extra,
      },
      null,
      2,
    )}\n`,
    { flag: 'wx' },
  );
  fs.unlinkSync(queuedPath);
}

async function processQueue(args: Args, configPath: string): Promise<void> {
  if (!fs.existsSync(configPath)) {
    writeTemplateConfig(configPath);
    console.log(`Created action bridge config template: ${configPath}`);
    console.log('Review enabled action types, then rerun with --execute.');
    return;
  }

  const config = loadConfig(configPath);
  const queued = readQueued(args.root, args.limit);
  if (queued.length === 0) {
    console.log('No queued Distributed Cognition action requests.');
    return;
  }

  let completed = 0;
  let skipped = 0;
  let failed = 0;
  for (const item of queued) {
    try {
      const { record } = item;
      validateRecord(record);
      const action = config.actions[record.actionType];
      if (!action || !action.enabled) {
        recordProgress(args.root, record, 'blocked', 'Action type is not enabled in host config.');
        console.log(`Action type ${record.actionType} is not enabled; leaving ${record.id} queued.`);
        skipped += 1;
        continue;
      }
      if (record.target && record.target !== action.target) {
        recordProgress(args.root, record, 'blocked', 'Requested target did not match host action allowlist.');
        console.log(`Rejected ${record.id}: requested target does not match host allowlist for ${record.actionType}.`);
        skipped += 1;
        continue;
      }
      if (!args.execute) {
        recordProgress(args.root, record, 'dry_run', 'Dry-run only; action not executed.');
        console.log(`Dry-run: would execute ${record.id} (${record.actionType}) via ${action.target}.`);
        skipped += 1;
        continue;
      }

      if (action.target === 'codex-local') {
        recordProgress(args.root, record, 'running', 'Local Codex action execution started on this host.');
        const local = runLocalCodexAction(args.root, config, record);
        if (!local.ok) {
          moveRecord(args.root, item.filePath, record, 'failed', {
            exitStatus: local.status,
            stdout: local.stdout,
            stderr: local.stderr,
            lastMessagePath: local.lastMessagePath,
          });
          updateNote(args.root, record, 'failed', [
            `- Failed at: ${sgtTimestamp()}`,
            `- Local Codex exit status: ${local.status ?? 'unknown'}`,
            local.lastMessagePath ? `- Last message: ${local.lastMessagePath}` : '- Last message: not written',
            '- See `.dc-index/action-requests/failed/` for stdout/stderr.',
          ]);
          recordProgress(args.root, record, 'failed', 'Local Codex action execution failed.');
          console.log(`Failed local Codex action ${record.id}.`);
          failed += 1;
          continue;
        }
        moveRecord(args.root, item.filePath, record, 'completed', {
          target: 'codex-local',
          stdout: local.stdout,
          stderr: local.stderr,
          lastMessagePath: local.lastMessagePath,
        });
        updateNote(args.root, record, 'completed', [
          `- Completed at: ${sgtTimestamp()}`,
          '- Executor: local Codex on this host',
          local.lastMessagePath ? `- Last message: ${local.lastMessagePath}` : '- Last message: not written',
          `- Output folder: ${config.outputRoot || 'action-outputs'}`,
        ]);
        recordProgress(args.root, record, 'completed', 'Local Codex action execution completed.');
        console.log(`Completed local Codex action ${record.id}.`);
        completed += 1;
        continue;
      }

      if (action.target === 'local' && record.actionType === 'word_document') {
        recordProgress(args.root, record, 'running', 'Local DOCX generation started.');
        const artifact = await createDocx(args.root, config, record);
        moveRecord(args.root, item.filePath, record, 'completed', { outputPath: artifact.outputRelativePath });
        updateNote(args.root, record, 'completed', [
          `- Completed at: ${sgtTimestamp()}`,
          `- Output: ${artifact.outputRelativePath}`,
        ]);
        recordProgress(args.root, record, 'completed', `Created DOCX at ${artifact.outputRelativePath}.`);
        console.log(`Created DOCX for ${record.id}: ${artifact.outputPath}`);
        completed += 1;
        continue;
      }

      if (action.target === 'local' && record.actionType === 'powerpoint') {
        recordProgress(args.root, record, 'running', 'Local PPTX generation started.');
        const artifact = await createPptx(args.root, config, record);
        moveRecord(args.root, item.filePath, record, 'completed', { outputPath: artifact.outputRelativePath });
        updateNote(args.root, record, 'completed', [
          `- Completed at: ${sgtTimestamp()}`,
          `- Output: ${artifact.outputRelativePath}`,
        ]);
        recordProgress(args.root, record, 'completed', `Created PPTX at ${artifact.outputRelativePath}.`);
        console.log(`Created PPTX for ${record.id}: ${artifact.outputPath}`);
        completed += 1;
        continue;
      }

      if (action.target === 'codex-cloud') {
        if (!action.cloudEnv) {
          recordProgress(args.root, record, 'blocked', 'Missing Codex Cloud environment mapping.');
          console.log(`Missing cloudEnv for ${record.actionType}; leaving ${record.id} queued.`);
          skipped += 1;
          continue;
        }
        recordProgress(args.root, record, 'running', 'Codex Cloud action submission started.');
        const submitted = submitCodexAction(record, action.cloudEnv);
        if (!submitted.ok) {
          moveRecord(args.root, item.filePath, record, 'failed', {
            exitStatus: submitted.status,
            stdout: submitted.stdout,
            stderr: submitted.stderr,
          });
          updateNote(args.root, record, 'failed', [
            `- Failed at: ${sgtTimestamp()}`,
            `- Exit status: ${submitted.status ?? 'unknown'}`,
            '- See `.dc-index/action-requests/failed/` for stdout/stderr.',
          ]);
          recordProgress(args.root, record, 'failed', 'Codex Cloud action submission failed.');
          console.log(`Failed to submit ${record.id} to Codex Cloud.`);
          failed += 1;
          continue;
        }
        moveRecord(args.root, item.filePath, record, 'completed', {
          cloudEnv: action.cloudEnv,
          cloudUrl: submitted.cloudUrl,
          cloudTaskId: submitted.cloudTaskId,
          stdout: submitted.stdout,
        });
        updateNote(args.root, record, 'completed', [
          `- Submitted at: ${sgtTimestamp()}`,
          `- Codex task: ${submitted.cloudUrl}`,
          submitted.cloudTaskId ? `- Task id: ${submitted.cloudTaskId}` : '- Task id: not parsed',
        ]);
        recordProgress(args.root, record, 'submitted', 'Submitted action to Codex Cloud.');
        console.log(`Submitted ${record.id} to Codex Cloud: ${submitted.cloudUrl}`);
        completed += 1;
        continue;
      }

      recordProgress(args.root, record, 'skipped', `No local executor for ${record.actionType}/${action.target}.`);
      console.log(`No local executor for ${record.id} (${record.actionType}/${action.target}); leaving queued.`);
      skipped += 1;
    } catch (e) {
      console.log(`Failed to process ${path.basename(item.filePath)}: ${e instanceof Error ? e.message : String(e)}`);
      failed += 1;
    }
  }

  console.log(`Done. completed=${completed} skipped=${skipped} failed=${failed}`);
  if (failed > 0) process.exitCode = 1;
}

const args = parseArgs(process.argv.slice(2));
const configPath = args.configPath ?? defaultConfigPath(args.root);
if (args.command === 'init') {
  if (fs.existsSync(configPath)) {
    console.log(`Action bridge config already exists: ${configPath}`);
  } else {
    writeTemplateConfig(configPath);
    console.log(`Created action bridge config template: ${configPath}`);
  }
} else {
  await processQueue(args, configPath);
}
