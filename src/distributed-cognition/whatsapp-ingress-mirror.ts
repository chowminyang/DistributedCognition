import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import {
  classifyDistributedMessage,
  ensureSecondBrainStructure,
  formatDistributedFilename,
  formatDistributedTimestamp,
  scrubPrivateText,
} from './notes.js';

const DISTRIBUTED_COGNITION_NAME = 'distributed cognition';
const SENSITIVE_RE =
  /\b(patient-identifiable|patient identifiable|learner-identifiable|learner identifiable|hr material|exam material|confidential institutional|nric|medical record number|mrn|answer[- ]?key|exam answer|marking key)\b/i;

interface AdditionalMount {
  hostPath?: string;
  containerPath?: string;
  readonly?: boolean;
}

interface ParsedInboundContent {
  text: string;
  isBotMessage: boolean;
  attachments: Array<{ type: string; name: string; size?: number }>;
}

export interface WhatsAppIngressMirrorInput {
  root?: string;
  cwd?: string;
  agentGroupId: string;
  agentGroupName: string;
  sessionId: string;
  messageId: string;
  timestamp: string;
  content: string;
  wake: boolean;
}

export type WhatsAppIngressMirrorResult =
  | { written: true; path: string; sourceMessageId: string }
  | {
      written: false;
      reason: 'not_distributed_cognition' | 'root_unavailable' | 'bot_message' | 'empty_message' | 'already_exists';
    };

const rootCache = new Map<string, string | undefined>();

function parseInboundContent(content: string): ParsedInboundContent {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const attachments = Array.isArray(parsed.attachments)
      ? parsed.attachments
          .filter(
            (attachment): attachment is Record<string, unknown> =>
              attachment !== null && typeof attachment === 'object',
          )
          .map((attachment) => ({
            type: typeof attachment.type === 'string' ? attachment.type : 'file',
            name: typeof attachment.name === 'string' ? attachment.name : 'attachment',
            size: typeof attachment.size === 'number' ? attachment.size : undefined,
          }))
      : [];
    return {
      text: typeof parsed.text === 'string' ? parsed.text : '',
      isBotMessage: parsed.isBotMessage === true,
      attachments,
    };
  } catch {
    return { text: content, isBotMessage: false, attachments: [] };
  }
}

function dateFromTimestamp(value: string): Date {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function isInsideRoot(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function resolveConfiguredSecondBrainRoot(agentGroupId: string, cwd = process.cwd()): string | undefined {
  const envRoot = process.env.DC_SECOND_BRAIN_ROOT || process.env.DISTRIBUTED_COGNITION_SECOND_BRAIN_ROOT;
  if (envRoot && fs.existsSync(envRoot)) return path.resolve(envRoot);

  const cached = rootCache.get(agentGroupId);
  if (cached !== undefined) return cached;

  const dbPath = path.join(cwd, 'data', 'v2.db');
  if (!fs.existsSync(dbPath)) {
    rootCache.set(agentGroupId, undefined);
    return undefined;
  }

  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db
        .prepare('SELECT additional_mounts FROM container_configs WHERE agent_group_id = ?')
        .get(agentGroupId) as { additional_mounts?: string } | undefined;
      const mounts = row?.additional_mounts ? (JSON.parse(row.additional_mounts) as AdditionalMount[]) : [];
      const secondBrain = mounts.find(
        (mount) => mount.containerPath === 'second-brain' && mount.readonly !== true && mount.hostPath,
      );
      const resolved =
        secondBrain?.hostPath && fs.existsSync(secondBrain.hostPath) ? path.resolve(secondBrain.hostPath) : undefined;
      rootCache.set(agentGroupId, resolved);
      return resolved;
    } finally {
      db.close();
    }
  } catch {
    rootCache.set(agentGroupId, undefined);
    return undefined;
  }
}

function ingressMarkdown(input: WhatsAppIngressMirrorInput, parsed: ParsedInboundContent, timestamp: string): string {
  const hasAudio = parsed.attachments.some((attachment) => attachment.type === 'audio');
  const source = hasAudio ? 'whatsapp-audio' : 'whatsapp-text';
  const body = parsed.text.trim();
  const sensitive = SENSITIVE_RE.test(body);
  const storedBody = sensitive
    ? '[Sensitive-content cue detected by host receipt. Raw text was not mirrored; resend a redacted version for processing.]'
    : scrubPrivateText(
        body || '[No text body. Attachment receipt only; agent transcription or processing is pending.]',
      );
  const messageType = classifyDistributedMessage(storedBody);
  const attachments =
    parsed.attachments.length > 0
      ? parsed.attachments.map((attachment) => {
          const size = typeof attachment.size === 'number' ? ` (${attachment.size} bytes)` : '';
          return `- ${scrubPrivateText(attachment.type)}: ${scrubPrivateText(attachment.name)}${size}`;
        })
      : ['None'];

  return [
    `# Raw WhatsApp Ingress - ${timestamp}`,
    '',
    '## Source',
    source,
    '',
    '## Capture status',
    'Host-level receipt; pending agent processing.',
    '',
    '## WhatsApp source message id',
    scrubPrivateText(input.messageId),
    '',
    '## Session',
    `- Agent group: ${scrubPrivateText(input.agentGroupName)}`,
    `- Session: ${scrubPrivateText(input.sessionId)}`,
    `- Wake requested: ${input.wake ? 'yes' : 'no'}`,
    '',
    '## Inferred message type',
    messageType,
    '',
    '## Attachments',
    ...attachments,
    '',
    '## Raw note',
    storedBody,
    '',
  ].join('\n');
}

export function mirrorWhatsAppIngressToSecondBrain(input: WhatsAppIngressMirrorInput): WhatsAppIngressMirrorResult {
  if (input.agentGroupName.trim().toLowerCase() !== DISTRIBUTED_COGNITION_NAME) {
    return { written: false, reason: 'not_distributed_cognition' };
  }

  const root = input.root
    ? path.resolve(input.root)
    : resolveConfiguredSecondBrainRoot(input.agentGroupId, input.cwd ?? process.cwd());
  if (!root || !fs.existsSync(root)) return { written: false, reason: 'root_unavailable' };

  const parsed = parseInboundContent(input.content);
  if (parsed.isBotMessage) return { written: false, reason: 'bot_message' };
  if (!parsed.text.trim() && parsed.attachments.length === 0) return { written: false, reason: 'empty_message' };

  const realRoot = fs.realpathSync(root);
  ensureSecondBrainStructure(realRoot);

  const date = dateFromTimestamp(input.timestamp);
  const timestamp = formatDistributedTimestamp(date);
  const digest = crypto.createHash('sha256').update(input.messageId).digest('hex').slice(0, 8);
  const filename = formatDistributedFilename(date, `whatsapp-ingress-${digest}`);
  const inboxDir = path.join(realRoot, 'inbox-whatsapp');
  const target = path.resolve(inboxDir, filename);
  if (!isInsideRoot(realRoot, target)) throw new Error(`Refusing to write outside second-brain root: ${target}`);

  try {
    fs.writeFileSync(target, ingressMarkdown(input, parsed, timestamp), { flag: 'wx' });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { written: false, reason: 'already_exists' };
    throw error;
  }

  return { written: true, path: target, sourceMessageId: input.messageId };
}

export function clearWhatsAppIngressMirrorCache(): void {
  rootCache.clear();
}
