/**
 * Typing indicator refresh — default module.
 *
 * Most platforms expire a typing indicator after 5–10s, so a one-shot
 * call on message arrival goes stale long before the agent finishes
 * thinking. This module keeps it alive by re-firing `setTyping` on a
 * short interval — but only while the agent is actually WORKING, gated
 * on the heartbeat file's mtime after an initial grace period.
 *
 * After delivering a user-facing message, the refresh is paused for
 * POST_DELIVERY_PAUSE_MS so the client-side indicator can visually
 * clear.
 *
 * Default module status:
 *   - Lives in src/modules/ for signaling (not really core), but ships
 *     on main and is imported directly by core. No registry, no hook.
 *   - Removing requires editing src/router.ts, src/delivery.ts, and
 *     src/container-runner.ts to drop the calls.
 */
import fs from 'fs';

import { heartbeatPath } from '../../session-manager.js';
import { log } from '../../log.js';

const TYPING_REFRESH_MS = 4000;
const VISIBLE_WORK_STATUS_DELAY_MS = Math.max(
  0,
  parseInt(process.env.NANOCLAW_VISIBLE_WORK_STATUS_DELAY_MS || '7000', 10) || 0,
);
const VISIBLE_WORK_STATUS_CHANNELS = new Set(
  (process.env.NANOCLAW_VISIBLE_WORK_STATUS_CHANNELS || 'whatsapp')
    .split(',')
    .map((channel) => channel.trim())
    .filter(Boolean),
);
const VISIBLE_WORK_STATUS_TEXT =
  process.env.NANOCLAW_VISIBLE_WORK_STATUS_TEXT || "Working on this. I'll reply here when it's ready.";
/**
 * Grace window from startTypingRefresh: fire typing unconditionally
 * for this long regardless of heartbeat state. Covers container
 * spawn/wake latency (5–12s on cold start before first heartbeat).
 */
const TYPING_GRACE_MS = 15000;
/**
 * After the grace window, a heartbeat must be mtimed within this
 * many ms of now to count as "agent is working." Heartbeats land
 * every few hundred ms during active work, so 6s is well above
 * the working floor and small enough to stop typing quickly when
 * the agent goes idle.
 */
const HEARTBEAT_FRESH_MS = 6000;
/**
 * After we deliver a user-facing message, pause typing for this
 * long so the client-side indicator has time to visually clear.
 * Tuned for the longest common expiry (Discord ~10s). The interval
 * stays running; ticks inside the pause just skip the setTyping call.
 */
const POST_DELIVERY_PAUSE_MS = 10000;

interface TypingAdapter {
  setTyping?(channelType: string, platformId: string, threadId: string | null): Promise<void>;
  deliver?(
    channelType: string,
    platformId: string,
    threadId: string | null,
    kind: string,
    content: string,
  ): Promise<string | undefined>;
}

interface TypingTarget {
  agentGroupId: string;
  channelType: string;
  platformId: string;
  threadId: string | null;
  interval: NodeJS.Timeout;
  visibleStatusTimer: NodeJS.Timeout | null;
  visibleStatusSent: boolean;
  startedAt: number;
  pausedUntil: number; // epoch ms; 0 = not paused
}

let adapter: TypingAdapter | null = null;
const typingRefreshers = new Map<string, TypingTarget>();

/**
 * Bind the typing module to the channel delivery adapter so it can
 * call `setTyping`. Called once by `src/delivery.ts` inside
 * `setDeliveryAdapter`. Passing a fresh adapter replaces the prior
 * binding and leaves active refreshers in place (they'll use the
 * new adapter on their next tick).
 */
export function setTypingAdapter(a: TypingAdapter): void {
  adapter = a;
}

async function triggerTyping(channelType: string, platformId: string, threadId: string | null): Promise<void> {
  try {
    await adapter?.setTyping?.(channelType, platformId, threadId);
  } catch {
    // Typing is best-effort — don't let it fail delivery or routing.
  }
}

function shouldSendVisibleWorkStatus(channelType: string): boolean {
  return VISIBLE_WORK_STATUS_DELAY_MS > 0 && VISIBLE_WORK_STATUS_CHANNELS.has(channelType);
}

function clearVisibleWorkStatusTimer(entry: TypingTarget): void {
  if (!entry.visibleStatusTimer) return;
  clearTimeout(entry.visibleStatusTimer);
  entry.visibleStatusTimer = null;
}

function scheduleVisibleWorkStatus(sessionId: string, entry: TypingTarget): void {
  clearVisibleWorkStatusTimer(entry);
  entry.visibleStatusSent = false;

  if (!shouldSendVisibleWorkStatus(entry.channelType)) return;

  const timer = setTimeout(() => {
    const current = typingRefreshers.get(sessionId);
    if (!current || current !== entry || current.visibleStatusSent) return;

    current.visibleStatusTimer = null;
    current.visibleStatusSent = true;

    adapter
      ?.deliver?.(
        current.channelType,
        current.platformId,
        current.threadId,
        'chat',
        JSON.stringify({ text: VISIBLE_WORK_STATUS_TEXT }),
      )
      .then(() => {
        current.pausedUntil = Date.now() + POST_DELIVERY_PAUSE_MS;
        log.debug('Visible work-status message delivered', {
          sessionId,
          channelType: current.channelType,
        });
      })
      .catch((err) => {
        log.debug('Visible work-status message failed', {
          sessionId,
          channelType: current.channelType,
          err,
        });
      });
  }, VISIBLE_WORK_STATUS_DELAY_MS);
  timer.unref();
  entry.visibleStatusTimer = timer;
}

function isHeartbeatFresh(agentGroupId: string, sessionId: string): boolean {
  const hbPath = heartbeatPath(agentGroupId, sessionId);
  try {
    const stat = fs.statSync(hbPath);
    return Date.now() - stat.mtimeMs < HEARTBEAT_FRESH_MS;
  } catch {
    return false;
  }
}

export function startTypingRefresh(
  sessionId: string,
  agentGroupId: string,
  channelType: string,
  platformId: string,
  threadId: string | null,
): void {
  const existing = typingRefreshers.get(sessionId);
  if (existing) {
    // Already refreshing. Fire an immediate tick for the new inbound
    // event and reset the grace window — the new message restarts
    // the container-wake latency budget. Also clear any lingering
    // post-delivery pause: a new inbound means the user expects
    // typing to show immediately.
    triggerTyping(channelType, platformId, threadId).catch(() => {});
    existing.channelType = channelType;
    existing.platformId = platformId;
    existing.threadId = threadId;
    existing.startedAt = Date.now();
    existing.pausedUntil = 0;
    scheduleVisibleWorkStatus(sessionId, existing);
    return;
  }

  // Immediate tick + periodic refresh.
  triggerTyping(channelType, platformId, threadId).catch(() => {});
  const startedAt = Date.now();
  const interval = setInterval(() => {
    const entry = typingRefreshers.get(sessionId);
    if (!entry) return; // stopped externally since this tick was scheduled

    // Inside a post-delivery pause: skip setTyping but keep the
    // interval running so we resume automatically once the pause
    // expires.
    if (entry.pausedUntil > Date.now()) return;

    const withinGrace = Date.now() - entry.startedAt < TYPING_GRACE_MS;
    if (withinGrace || isHeartbeatFresh(entry.agentGroupId, sessionId)) {
      triggerTyping(entry.channelType, entry.platformId, entry.threadId).catch(() => {});
      return;
    }

    // Out of grace AND heartbeat stale — agent is idle, stop refreshing.
    clearInterval(entry.interval);
    typingRefreshers.delete(sessionId);
  }, TYPING_REFRESH_MS);
  // unref so a stale refresher can't hold the event loop alive.
  interval.unref();
  typingRefreshers.set(sessionId, {
    agentGroupId,
    channelType,
    platformId,
    threadId,
    interval,
    visibleStatusTimer: null,
    visibleStatusSent: false,
    startedAt,
    pausedUntil: 0,
  });
  const entry = typingRefreshers.get(sessionId);
  if (entry) scheduleVisibleWorkStatus(sessionId, entry);
}

/**
 * Pause the typing refresh for POST_DELIVERY_PAUSE_MS. Called after
 * a user-facing message is delivered so the client-side indicator
 * has a chance to visually clear before the agent's next SDK event
 * pushes it back on. No-op if no refresh is active for this session.
 */
export function pauseTypingRefreshAfterDelivery(sessionId: string): void {
  const entry = typingRefreshers.get(sessionId);
  if (!entry) return;
  clearVisibleWorkStatusTimer(entry);
  entry.pausedUntil = Date.now() + POST_DELIVERY_PAUSE_MS;
}

export function stopTypingRefresh(sessionId: string): void {
  const entry = typingRefreshers.get(sessionId);
  if (!entry) return;
  clearInterval(entry.interval);
  clearVisibleWorkStatusTimer(entry);
  typingRefreshers.delete(sessionId);
}
