import fs from 'fs';
import os from 'os';
import path from 'path';

import { scrubPrivateText } from './notes.js';
import { appendProvenanceEvent } from './provenance.js';

export type DeliveryAuditStatus = 'sent' | 'failed' | 'blocked' | 'queued';

export type DeliveryAuditPhase =
  | 'visible_work_status'
  | 'outbound_final_reply'
  | 'outbound_system_action'
  | 'outbound_channel_message';

export interface DeliveryAuditInput {
  phase: DeliveryAuditPhase;
  status: DeliveryAuditStatus;
  sessionId?: string;
  messageOutId?: string;
  channelType?: string | null;
  platformId?: string | null;
  platformMessageId?: string | null;
  reason?: string;
  timestamp?: string;
}

const DEFAULT_ROOT_CANDIDATES = [
  path.join(os.homedir(), 'Library/CloudStorage/Dropbox/Distributed-Cognition'),
  path.join(os.homedir(), 'Dropbox/Distributed-Cognition'),
];

function resolveAuditRoot(): string | undefined {
  const explicit = process.env.DC_SECOND_BRAIN_ROOT;
  const candidates = explicit ? [explicit, ...DEFAULT_ROOT_CANDIDATES] : DEFAULT_ROOT_CANDIDATES;
  for (const candidate of candidates) {
    try {
      const real = fs.realpathSync(candidate);
      if (fs.statSync(real).isDirectory()) return real;
    } catch {
      // Optional audit sink: if the second-brain root is unavailable, leave
      // message delivery itself untouched.
    }
  }
  return undefined;
}

function titleFor(input: DeliveryAuditInput): string {
  if (input.phase === 'visible_work_status') return `Visible work status ${input.status}`;
  if (input.phase === 'outbound_final_reply') return `Final reply ${input.status}`;
  if (input.phase === 'outbound_system_action') return `System action ${input.status}`;
  return `Channel message ${input.status}`;
}

export function recordDeliveryAuditEvent(input: DeliveryAuditInput): void {
  const root = resolveAuditRoot();
  if (!root) return;

  try {
    appendProvenanceEvent(root, {
      id: `delivery-${input.phase}-${input.messageOutId ?? input.platformMessageId ?? Date.now()}`,
      kind: 'delivery_event',
      title: titleFor(input),
      summary: scrubPrivateText(
        `${input.phase} ${input.status}${input.reason ? ` (${input.reason})` : ''}`.replace(/\s+/g, ' ').trim(),
      ),
      sourcePaths: [],
      outputPaths: [],
      timestamp: input.timestamp,
      metadata: {
        phase: input.phase,
        status: input.status,
        sessionId: input.sessionId,
        messageOutId: input.messageOutId,
        channelType: input.channelType ?? undefined,
        platformId: input.platformId ?? undefined,
        platformMessageId: input.platformMessageId ?? undefined,
        reason: input.reason,
      },
    });
  } catch {
    // Delivery audit is best-effort. Never let Dropbox/provenance file issues
    // interfere with sending or retrying a user-facing message.
  }
}
