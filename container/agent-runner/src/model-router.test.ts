import { describe, expect, test } from 'bun:test';

import type { MessageInRow } from './db/messages-in.js';
import { selectModelRoute } from './model-router.js';

function msg(text: string, overrides: Partial<MessageInRow> = {}): MessageInRow {
  return {
    id: 'm1',
    seq: null,
    kind: 'chat',
    timestamp: '2026-05-17T00:00:00Z',
    status: 'pending',
    process_after: null,
    recurrence: null,
    tries: 0,
    trigger: 1,
    platform_id: null,
    channel_type: null,
    thread_id: null,
    content: JSON.stringify({ sender: 'Owner', text }),
    ...overrides,
  };
}

const codexConfig = {
  providerName: 'codex',
  env: {},
};

describe('selectModelRoute', () => {
  test('uses fast mini route for ordinary short messages', () => {
    const route = selectModelRoute([msg('hello, how are you?')], codexConfig);
    expect(route.profile).toBe('chat');
    expect(route.tier).toBe('fast');
    expect(route.model).toBe('gpt-5.4-mini');
    expect(route.effort).toBe('low');
  });

  test('uses deep route for strategic synthesis requests', () => {
    const route = selectModelRoute(
      [msg('based on all the Dropbox context, synthesize my publication strategy')],
      codexConfig,
    );
    expect(route.profile).toBe('synthesis');
    expect(route.tier).toBe('deep');
    expect(route.model).toBe('gpt-5.5');
    expect(route.effort).toBe('high');
  });

  test('honors explicit gpt-5.5 requests', () => {
    const route = selectModelRoute([msg('use gpt-5.5 and think deeply about this decision')], codexConfig);
    expect(route.profile).toBe('decision');
    expect(route.tier).toBe('deep');
    expect(route.model).toBe('gpt-5.5');
  });

  test('honors explicit fast route requests', () => {
    const route = selectModelRoute([msg('quick answer with the fast model please')], codexConfig);
    expect(route.profile).toBe('chat');
    expect(route.tier).toBe('fast');
    expect(route.model).toBe('gpt-5.4-mini');
  });

  test('uses xhigh effort when explicitly requested', () => {
    const route = selectModelRoute([msg('use deep model with xhigh reasoning')], codexConfig);
    expect(route.tier).toBe('deep');
    expect(route.effort).toBe('xhigh');
  });

  test('routes audio attachments to deep model', () => {
    const route = selectModelRoute(
      [
        msg('', {
          content: JSON.stringify({
            sender: 'Owner',
            text: '',
            attachments: [{ type: 'audio', filename: 'reflection.ogg', mimeType: 'audio/ogg' }],
          }),
        }),
      ],
      codexConfig,
    );
    expect(route.profile).toBe('capture');
    expect(route.tier).toBe('deep');
  });

  test('uses configured model overrides', () => {
    const route = selectModelRoute([msg('use deep model')], {
      providerName: 'codex',
      env: {
        CODEX_MODEL_FAST: 'fast-model',
        CODEX_MODEL_DEEP: 'deep-model',
        CODEX_EFFORT_DEEP: 'xhigh',
      },
    });
    expect(route.model).toBe('deep-model');
    expect(route.effort).toBe('xhigh');
  });

  test('uses retrieval profile for Dropbox context questions', () => {
    const route = selectModelRoute([msg('tell me what you know based on the Dropbox folders')], codexConfig);
    expect(route.profile).toBe('retrieve');
    expect(route.tier).toBe('deep');
  });

  test('uses writing profile for drafting tasks', () => {
    const route = selectModelRoute([msg('draft a leadership update from this')], codexConfig);
    expect(route.profile).toBe('writing');
    expect(route.tier).toBe('deep');
  });

  test('routes decision wording ahead of generic capture wording', () => {
    const route = selectModelRoute(
      [msg('Today I decided that p(AI)tient should prioritise production readiness')],
      codexConfig,
    );
    expect(route.profile).toBe('decision');
    expect(route.tier).toBe('deep');
  });

  test('supports per-profile overrides', () => {
    const route = selectModelRoute([msg('draft a leadership update from this')], {
      providerName: 'codex',
      env: {
        CODEX_MODEL_WRITING: 'writing-model',
        CODEX_EFFORT_WRITING: 'medium',
      },
    });
    expect(route.profile).toBe('writing');
    expect(route.model).toBe('writing-model');
    expect(route.effort).toBe('medium');
  });

  test('leaves non-Codex providers on their configured model', () => {
    const route = selectModelRoute([msg('use gpt-5.5')], {
      providerName: 'claude',
      defaultModel: 'sonnet',
      defaultEffort: 'medium',
      env: {},
    });
    expect(route.profile).toBe('default');
    expect(route.tier).toBe('default');
    expect(route.model).toBe('sonnet');
    expect(route.effort).toBe('medium');
  });
});
