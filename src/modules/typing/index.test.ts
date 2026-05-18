import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type TypingModule = typeof import('./index.js');

let typing: TypingModule | null = null;

async function loadTypingModule(): Promise<TypingModule> {
  vi.resetModules();
  vi.stubEnv('NANOCLAW_VISIBLE_WORK_STATUS_DELAY_MS', '7000');
  vi.stubEnv('NANOCLAW_VISIBLE_WORK_STATUS_CHANNELS', 'whatsapp');
  typing = await import('./index.js');
  return typing;
}

describe('typing refresh visible work status', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    for (const sessionId of ['sess-visible', 'sess-cancel', 'sess-telegram']) {
      typing?.stopTypingRefresh(sessionId);
    }
    typing = null;
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('sends one delayed visible status for WhatsApp while the agent is still working', async () => {
    const mod = await loadTypingModule();
    const delivered: Array<[string, string, string | null, string, string]> = [];

    mod.setTypingAdapter({
      async setTyping() {},
      async deliver(channelType, platformId, threadId, kind, content) {
        delivered.push([channelType, platformId, threadId, kind, content]);
        return 'status-platform-id';
      },
    });

    mod.startTypingRefresh('sess-visible', 'ag-1', 'whatsapp', 'allowed@s.whatsapp.net', null);

    await vi.advanceTimersByTimeAsync(6999);
    expect(delivered).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(delivered).toHaveLength(1);
    expect(delivered[0][0]).toBe('whatsapp');
    expect(delivered[0][1]).toBe('allowed@s.whatsapp.net');
    expect(delivered[0][3]).toBe('chat');
    expect(JSON.parse(delivered[0][4])).toEqual({
      text: "Working on this. I'll reply here when it's ready.",
    });
  });

  it('cancels the visible status when a user-facing reply is delivered first', async () => {
    const mod = await loadTypingModule();
    const delivered: string[] = [];

    mod.setTypingAdapter({
      async setTyping() {},
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        delivered.push(content);
        return 'status-platform-id';
      },
    });

    mod.startTypingRefresh('sess-cancel', 'ag-1', 'whatsapp', 'allowed@s.whatsapp.net', null);
    mod.pauseTypingRefreshAfterDelivery('sess-cancel');

    await vi.advanceTimersByTimeAsync(10_000);
    expect(delivered).toHaveLength(0);
  });

  it('does not send visible status messages on non-WhatsApp channels by default', async () => {
    const mod = await loadTypingModule();
    const delivered: string[] = [];

    mod.setTypingAdapter({
      async setTyping() {},
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        delivered.push(content);
        return 'status-platform-id';
      },
    });

    mod.startTypingRefresh('sess-telegram', 'ag-1', 'telegram', 'telegram:123', null);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(delivered).toHaveLength(0);
  });
});
