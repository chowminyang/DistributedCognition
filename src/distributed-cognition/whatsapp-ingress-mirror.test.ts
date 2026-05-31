import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mirrorWhatsAppIngressToSecondBrain } from './whatsapp-ingress-mirror.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-whatsapp-ingress-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('WhatsApp ingress mirror', () => {
  it('writes a source-linked host receipt for Distributed Cognition text messages', () => {
    const result = mirrorWhatsAppIngressToSecondBrain({
      root: tmp,
      agentGroupId: 'ag-dc',
      agentGroupName: 'Distributed Cognition',
      sessionId: 'sess-dc',
      messageId: 'wa-message-1:ag-dc',
      timestamp: '2026-05-17T01:23:00.000Z',
      content: JSON.stringify({ text: 'Today I realised the office is about judgement.' }),
      wake: true,
    });

    expect(result.written).toBe(true);
    if (!result.written) throw new Error('expected write');

    const relative = path.relative(fs.realpathSync(tmp), result.path);
    expect(relative).toMatch(/^inbox-whatsapp\/17-05-26-0923-whatsapp-ingress-[a-f0-9]{8}\.md$/);
    const markdown = fs.readFileSync(result.path, 'utf-8');
    expect(markdown).toContain('# Raw WhatsApp Ingress - 17-05-26, 09:23');
    expect(markdown).toContain('## Capture status\nHost-level receipt; pending agent processing.');
    expect(markdown).toContain('## WhatsApp source message id\nwa-message-1:ag-dc');
    expect(markdown).toContain('## Inferred message type\nreflection');
    expect(markdown).toContain('Today I realised the office is about judgement.');
  });

  it('does not mirror non-Distributed-Cognition or bot messages', () => {
    const other = mirrorWhatsAppIngressToSecondBrain({
      root: tmp,
      agentGroupId: 'ag-other',
      agentGroupName: 'Other Agent',
      sessionId: 'sess-other',
      messageId: 'wa-message-2:ag-other',
      timestamp: '2026-05-17T01:23:00.000Z',
      content: JSON.stringify({ text: 'hello' }),
      wake: true,
    });
    const bot = mirrorWhatsAppIngressToSecondBrain({
      root: tmp,
      agentGroupId: 'ag-dc',
      agentGroupName: 'Distributed Cognition',
      sessionId: 'sess-dc',
      messageId: 'wa-message-3:ag-dc',
      timestamp: '2026-05-17T01:23:00.000Z',
      content: JSON.stringify({ text: 'DC: hello', isBotMessage: true }),
      wake: true,
    });

    expect(other).toEqual({ written: false, reason: 'not_distributed_cognition' });
    expect(bot).toEqual({ written: false, reason: 'bot_message' });
    expect(fs.existsSync(path.join(tmp, 'inbox-whatsapp'))).toBe(false);
  });

  it('redacts explicit sensitive-data cues instead of mirroring the body', () => {
    const result = mirrorWhatsAppIngressToSecondBrain({
      root: tmp,
      agentGroupId: 'ag-dc',
      agentGroupName: 'Distributed Cognition',
      sessionId: 'sess-dc',
      messageId: 'wa-message-sensitive:ag-dc',
      timestamp: '2026-05-17T01:23:00.000Z',
      content: JSON.stringify({ text: 'This contains patient-identifiable information: do not store details.' }),
      wake: true,
    });

    expect(result.written).toBe(true);
    if (!result.written) throw new Error('expected write');
    const markdown = fs.readFileSync(result.path, 'utf-8');
    expect(markdown).toContain('Sensitive-content cue detected by host receipt.');
    expect(markdown).not.toContain('do not store details');
  });

  it('uses deterministic filenames and skips duplicate source receipts', () => {
    const input = {
      root: tmp,
      agentGroupId: 'ag-dc',
      agentGroupName: 'Distributed Cognition',
      sessionId: 'sess-dc',
      messageId: 'wa-message-repeat:ag-dc',
      timestamp: '2026-05-17T01:23:00.000Z',
      content: JSON.stringify({ text: 'repeatable' }),
      wake: true,
    };

    const first = mirrorWhatsAppIngressToSecondBrain(input);
    const second = mirrorWhatsAppIngressToSecondBrain(input);

    expect(first.written).toBe(true);
    expect(second).toEqual({ written: false, reason: 'already_exists' });
  });
});
