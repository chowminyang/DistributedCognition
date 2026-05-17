export interface WhatsAppPrivateModeConfig {
  enabled: boolean;
  allowedJid?: string;
  allowSelfChat?: boolean;
}

export type WhatsAppSafetyDecision = { allowed: true } | { allowed: false; reason: WhatsAppSafetyRejectReason };

export type WhatsAppSafetyRejectReason =
  | 'allowlist_not_configured'
  | 'empty_jid'
  | 'from_me'
  | 'group_chat'
  | 'status_broadcast'
  | 'broadcast'
  | 'newsletter'
  | 'not_allowlisted';

export class WhatsAppSafetyError extends Error {
  readonly reason: WhatsAppSafetyRejectReason;
  readonly jid?: string;

  constructor(reason: WhatsAppSafetyRejectReason, jid?: string) {
    super(`WhatsApp private-mode safety blocked ${jid ?? 'unknown jid'}: ${reason}`);
    this.name = 'WhatsAppSafetyError';
    this.reason = reason;
    this.jid = jid;
  }
}

function truthy(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export function normalizeWhatsAppJid(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;

  if (trimmed.includes('@')) {
    const [rawUser, rawHost] = trimmed.toLowerCase().split('@');
    if (!rawUser || !rawHost) return undefined;
    const user = rawUser.split(':')[0];
    return `${user}@${rawHost}`;
  }

  const digits = trimmed.replace(/[^\d]/g, '');
  if (/^\d{8,15}$/.test(digits)) {
    return `${digits}@s.whatsapp.net`;
  }

  return undefined;
}

export function loadWhatsAppPrivateModeConfig(env: Record<string, string | undefined>): WhatsAppPrivateModeConfig {
  const allowedJid = normalizeWhatsAppJid(
    env.WHATSAPP_ALLOWED_JID ?? env.WHATSAPP_ALLOWLIST_JID ?? env.DISTRIBUTED_COGNITION_WHATSAPP_JID,
  );
  return {
    enabled: truthy(env.WHATSAPP_PRIVATE_MODE) || Boolean(allowedJid),
    allowedJid,
    allowSelfChat: truthy(env.WHATSAPP_ALLOW_SELF_CHAT),
  };
}

function jidHost(jid: string | undefined): string {
  const normalized = normalizeWhatsAppJid(jid) ?? jid?.trim().toLowerCase() ?? '';
  return normalized.includes('@') ? normalized.split('@').slice(1).join('@') : '';
}

function isLidJid(jid: string | undefined): boolean {
  return jidHost(jid) === 'lid';
}

function rejectReasonForJid(jid: string | undefined): WhatsAppSafetyRejectReason | null {
  const normalized = normalizeWhatsAppJid(jid) ?? jid?.trim().toLowerCase();
  if (!normalized) return 'empty_jid';
  if (normalized === 'status@broadcast') return 'status_broadcast';
  const host = jidHost(normalized);
  if (host === 'g.us') return 'group_chat';
  if (host === 'broadcast' || normalized.endsWith('@broadcast')) return 'broadcast';
  if (host === 'newsletter' || normalized.endsWith('@newsletter')) return 'newsletter';
  return null;
}

export function evaluateWhatsAppInbound(
  config: WhatsAppPrivateModeConfig,
  input: {
    remoteJid?: string;
    chatJid?: string;
    senderJid?: string;
    fromMe?: boolean;
  },
): WhatsAppSafetyDecision {
  if (!config.enabled) return { allowed: true };
  if (!config.allowedJid) return { allowed: false, reason: 'allowlist_not_configured' };

  for (const jid of [input.remoteJid, input.chatJid, input.senderJid]) {
    const reason = rejectReasonForJid(jid);
    if (reason) return { allowed: false, reason };
  }

  const chatJid = normalizeWhatsAppJid(input.chatJid);
  const senderJid = normalizeWhatsAppJid(input.senderJid);
  const remoteJid = normalizeWhatsAppJid(input.remoteJid);

  if (chatJid !== config.allowedJid) return { allowed: false, reason: 'not_allowlisted' };
  if (senderJid && senderJid !== config.allowedJid) return { allowed: false, reason: 'not_allowlisted' };
  // Baileys v7 may surface the raw WhatsApp LID as remoteJid while also
  // providing a translated phone JID as chatJid/senderJid. Trust the
  // translated allowlisted IDs, but never accept an unresolved LID chat.
  if (remoteJid && remoteJid !== config.allowedJid && !isLidJid(remoteJid)) {
    return { allowed: false, reason: 'not_allowlisted' };
  }
  if (input.fromMe && !config.allowSelfChat) return { allowed: false, reason: 'from_me' };

  return { allowed: true };
}

export function evaluateWhatsAppOutbound(
  config: WhatsAppPrivateModeConfig,
  jid: string | undefined,
): WhatsAppSafetyDecision {
  if (!config.enabled) return { allowed: true };
  if (!config.allowedJid) return { allowed: false, reason: 'allowlist_not_configured' };

  const rejected = rejectReasonForJid(jid);
  if (rejected) return { allowed: false, reason: rejected };

  const normalized = normalizeWhatsAppJid(jid);
  if (normalized !== config.allowedJid) return { allowed: false, reason: 'not_allowlisted' };
  return { allowed: true };
}

export function assertCanSendWhatsAppMessage(config: WhatsAppPrivateModeConfig, jid: string | undefined): void {
  const decision = evaluateWhatsAppOutbound(config, jid);
  if (!decision.allowed) {
    throw new WhatsAppSafetyError(decision.reason, jid);
  }
}

export async function safeSendWhatsAppMessage<TPayload, TResult>(
  config: WhatsAppPrivateModeConfig,
  send: (jid: string, payload: TPayload) => Promise<TResult>,
  jid: string,
  payload: TPayload,
): Promise<TResult> {
  assertCanSendWhatsAppMessage(config, jid);
  return send(jid, payload);
}

export function whatsappSafetyLogFields(
  phase: 'inbound' | 'outbound' | 'typing',
  reason: WhatsAppSafetyRejectReason,
  ids: { remoteJid?: string; chatJid?: string; senderJid?: string; targetJid?: string },
): Record<string, string | undefined> {
  return {
    phase,
    reason,
    remoteJid: ids.remoteJid,
    chatJid: ids.chatJid,
    senderJid: ids.senderJid,
    targetJid: ids.targetJid,
  };
}
