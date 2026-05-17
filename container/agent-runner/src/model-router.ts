import type { MessageInRow } from './db/messages-in.js';

export type ModelRouteProfile = 'default' | 'capture' | 'chat' | 'retrieve' | 'synthesis' | 'decision' | 'writing';
export type ModelRouteTier = 'default' | 'fast' | 'deep';

export interface ModelRoute {
  profile: ModelRouteProfile;
  tier: ModelRouteTier;
  model?: string;
  effort?: string;
  reason: string;
}

export interface ModelRouteConfig {
  providerName: string;
  defaultModel?: string;
  defaultEffort?: string;
  env?: Record<string, string | undefined>;
}

const CODEX_DEFAULT_FAST_MODEL = 'gpt-5.4-mini';
const CODEX_DEFAULT_DEEP_MODEL = 'gpt-5.5';
const CODEX_DEFAULT_FAST_EFFORT = 'low';
const CODEX_DEFAULT_DEEP_EFFORT = 'high';

const EXPLICIT_FAST_RE =
  /\b(?:use\s+)?(?:fast|quick|mini|cheap|speedy)\s+(?:model|mode|reply|answer)?\b|\bgpt-?5\.4-?mini\b|\b5\.4-?mini\b/i;

const EXPLICIT_DEEP_RE =
  /\b(?:use\s+)?(?:deep|strong|best|frontier|serious|heavy)\s+(?:model|mode|reasoning|thinking)?\b|\bgpt-?5\.5\b|\b5\.5\b|\bthink\s+(?:hard|harder|deeply|carefully)\b|\bxhigh\b/i;

const CAPTURE_TASK_RE =
  /\b(?:\/reflect|\/note|capture|record|log this|file this|save this|voice note|audio note|today|this morning|this afternoon|this evening|i realised|i realized|i noticed|i wonder|i am starting to think)\b/i;

const DECISION_TASK_RE =
  /\b(?:\/decision|decision|decided|decide|decision analysis|trade-?off|tradeoff|pros and cons|what should i do|should i|choose between|risks? of|what would change this)\b/i;

const SYNTHESIS_TASK_RE =
  /\b(?:synthesi[sz]e|weekly\s+(?:review|synthesis|summary)|monthly\s+(?:review|synthesis|summary)|review my week|summari[sz]e my week|strategy|strategic|argument map|map\s+(?:those|this|out)|theme(?:s)?|storyline|narrative|all\s+(?:my\s+)?projects|what\s+(?:have\s+i|i\s+have)\s+been\s+up\s+to|stale open questions|changed my mind|decision log review)\b/i;

const WRITING_TASK_RE =
  /\b(?:draft|write|prepare|turn this into|make this into|polish|revise|manuscript|publication|paper|grant|abstract|talk|slides?|deck|leadership update|one-pager|table)\b/i;

const RETRIEVE_TASK_RE =
  /\b(?:\/ask|search|find|look up|read|show me|list|tell me what you know|what do you know|based on\s+(?:all|what|the)\s+(?:files|folders|context|dropbox)|dropbox|presentations|publications|second-brain|context folders?|source context)\b/i;

function envFirst(env: Record<string, string | undefined>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function parseContent(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

function contentText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];

  for (const key of ['text', 'prompt', 'source', 'event']) {
    const v = obj[key];
    if (typeof v === 'string') parts.push(v);
  }

  const attachments = obj.attachments;
  if (Array.isArray(attachments)) {
    for (const attachment of attachments) {
      if (!attachment || typeof attachment !== 'object') continue;
      const a = attachment as Record<string, unknown>;
      for (const key of ['type', 'name', 'filename', 'mimeType']) {
        const v = a[key];
        if (typeof v === 'string') parts.push(v);
      }
    }
  }

  return parts.join('\n');
}

function batchText(messages: MessageInRow[]): string {
  return messages.map((m) => contentText(parseContent(m.content))).join('\n\n');
}

function hasAudioAttachment(messages: MessageInRow[]): boolean {
  return messages.some((m) => {
    const parsed = parseContent(m.content);
    if (!parsed || typeof parsed !== 'object') return false;
    const attachments = (parsed as Record<string, unknown>).attachments;
    if (!Array.isArray(attachments)) return false;
    return attachments.some((attachment) => {
      if (!attachment || typeof attachment !== 'object') return false;
      const a = attachment as Record<string, unknown>;
      const joined = [a.type, a.name, a.filename, a.mimeType]
        .filter((v): v is string => typeof v === 'string')
        .join(' ')
        .toLowerCase();
      return /\b(audio|voice|ogg|opus|m4a|mp3|wav|aac)\b/.test(joined);
    });
  });
}

export function selectModelRoute(messages: MessageInRow[], config: ModelRouteConfig): ModelRoute {
  const env = config.env ?? process.env;
  if (config.providerName.toLowerCase() !== 'codex') {
    return {
      profile: 'default',
      tier: 'default',
      model: config.defaultModel,
      effort: config.defaultEffort,
      reason: 'provider-default',
    };
  }

  const fastModel =
    envFirst(env, ['CODEX_MODEL_FAST', 'NANOCLAW_MODEL_FAST']) ??
    config.defaultModel ??
    envFirst(env, ['CODEX_MODEL']) ??
    CODEX_DEFAULT_FAST_MODEL;
  const deepModel = envFirst(env, ['CODEX_MODEL_DEEP', 'NANOCLAW_MODEL_DEEP']) ?? CODEX_DEFAULT_DEEP_MODEL;
  const fastEffort =
    envFirst(env, ['CODEX_EFFORT_FAST', 'CODEX_MODEL_EFFORT_FAST', 'NANOCLAW_MODEL_EFFORT_FAST']) ??
    CODEX_DEFAULT_FAST_EFFORT;
  const deepEffort =
    envFirst(env, ['CODEX_EFFORT_DEEP', 'CODEX_MODEL_EFFORT_DEEP', 'NANOCLAW_MODEL_EFFORT_DEEP']) ??
    CODEX_DEFAULT_DEEP_EFFORT;

  const text = batchText(messages);
  const hasAudio = hasAudioAttachment(messages);
  const explicitFast = EXPLICIT_FAST_RE.test(text);
  const explicitDeep = EXPLICIT_DEEP_RE.test(text);
  const profile = selectProfile(text, hasAudio);

  let tier = defaultTier(profile, text, hasAudio);
  let reason = defaultReason(profile, tier, text, hasAudio);

  if (explicitFast && !hasAudio) {
    tier = 'fast';
    reason = 'explicit-fast-request';
  }

  if (explicitDeep) {
    tier = 'deep';
    reason = 'explicit-deep-request';
  }

  const profileModel = envFirst(env, [
    `CODEX_MODEL_${profile.toUpperCase()}`,
    `NANOCLAW_MODEL_${profile.toUpperCase()}`,
  ]);
  const profileEffort = envFirst(env, [
    `CODEX_EFFORT_${profile.toUpperCase()}`,
    `CODEX_MODEL_EFFORT_${profile.toUpperCase()}`,
    `NANOCLAW_MODEL_EFFORT_${profile.toUpperCase()}`,
  ]);

  const effort =
    /\bxhigh\b|\bthink\s+(?:very\s+)?hard(?:er)?\b/i.test(text)
      ? 'xhigh'
      : profileEffort ?? (tier === 'deep' ? deepEffort : fastEffort);

  return {
    profile,
    tier,
    model: profileModel ?? (tier === 'deep' ? deepModel : fastModel),
    effort,
    reason,
  };
}

function selectProfile(text: string, hasAudio: boolean): ModelRouteProfile {
  if (hasAudio) return 'capture';
  if (SYNTHESIS_TASK_RE.test(text)) return 'synthesis';
  if (DECISION_TASK_RE.test(text)) return 'decision';
  if (WRITING_TASK_RE.test(text)) return 'writing';
  if (RETRIEVE_TASK_RE.test(text)) return 'retrieve';
  if (CAPTURE_TASK_RE.test(text)) return 'capture';
  return 'chat';
}

function defaultTier(profile: ModelRouteProfile, text: string, hasAudio: boolean): ModelRouteTier {
  if (hasAudio || text.length > 1800) return 'deep';
  if (profile === 'chat' || profile === 'capture') return 'fast';
  return 'deep';
}

function defaultReason(profile: ModelRouteProfile, tier: ModelRouteTier, text: string, hasAudio: boolean): string {
  if (hasAudio) return 'audio-input';
  if (text.length > 1800) return 'long-input';
  if (profile !== 'chat') return `${profile}-task-pattern`;
  if (tier === 'fast') return 'default-fast-chat';
  return 'default-route';
}
