import { describe, expect, it, vi } from 'vitest';

import {
  evaluateWhatsAppInbound,
  evaluateWhatsAppOutbound,
  loadWhatsAppPrivateModeConfig,
  normalizeWhatsAppJid,
  safeSendWhatsAppMessage,
  whatsappSafetyLogFields,
  WhatsAppSafetyError,
  type WhatsAppPrivateModeConfig,
} from './whatsapp-safety.js';

const config: WhatsAppPrivateModeConfig = {
  enabled: true,
  allowedJid: '6500000000@s.whatsapp.net',
  allowSelfChat: false,
};

describe('WhatsApp private-mode safety', () => {
  it('normalizes phone numbers to WhatsApp JIDs', () => {
    expect(normalizeWhatsAppJid('+65 0000 0000')).toBe('6500000000@s.whatsapp.net');
    expect(normalizeWhatsAppJid('6500000000:12@s.whatsapp.net')).toBe('6500000000@s.whatsapp.net');
  });

  it('enables private mode when an allowlisted JID is configured', () => {
    expect(loadWhatsAppPrivateModeConfig({ WHATSAPP_ALLOWED_JID: '+65 0000 0000' })).toEqual(config);
  });

  it('enables self-chat mode only when explicitly configured', () => {
    expect(
      loadWhatsAppPrivateModeConfig({ WHATSAPP_ALLOWED_JID: '+65 0000 0000', WHATSAPP_ALLOW_SELF_CHAT: 'true' }),
    ).toEqual({
      ...config,
      allowSelfChat: true,
    });
  });

  it('processes the allowed WhatsApp identity', () => {
    expect(
      evaluateWhatsAppInbound(config, {
        remoteJid: '6500000000@s.whatsapp.net',
        chatJid: '6500000000@s.whatsapp.net',
        senderJid: '6500000000@s.whatsapp.net',
        fromMe: false,
      }),
    ).toEqual({ allowed: true });
  });

  it('ignores unknown WhatsApp identities', () => {
    expect(
      evaluateWhatsAppInbound(config, {
        remoteJid: '6599999999@s.whatsapp.net',
        chatJid: '6599999999@s.whatsapp.net',
        senderJid: '6599999999@s.whatsapp.net',
      }),
    ).toEqual({ allowed: false, reason: 'not_allowlisted' });
  });

  it('blocks own-account messages by default', () => {
    expect(
      evaluateWhatsAppInbound(config, {
        remoteJid: '6500000000@s.whatsapp.net',
        chatJid: '6500000000@s.whatsapp.net',
        senderJid: '6500000000@s.whatsapp.net',
        fromMe: true,
      }),
    ).toEqual({ allowed: false, reason: 'from_me' });
  });

  it('allows own-account self-chat only for the configured identity', () => {
    expect(
      evaluateWhatsAppInbound(
        { ...config, allowSelfChat: true },
        {
          remoteJid: '6500000000@s.whatsapp.net',
          chatJid: '6500000000@s.whatsapp.net',
          senderJid: '6500000000@s.whatsapp.net',
          fromMe: true,
        },
      ),
    ).toEqual({ allowed: true });
    expect(
      evaluateWhatsAppInbound(
        { ...config, allowSelfChat: true },
        {
          remoteJid: '6599999999@s.whatsapp.net',
          chatJid: '6599999999@s.whatsapp.net',
          senderJid: '6599999999@s.whatsapp.net',
          fromMe: true,
        },
      ),
    ).toEqual({ allowed: false, reason: 'not_allowlisted' });
  });

  it('allows Baileys LID remote IDs only when the resolved chat and sender match the allowlist', () => {
    expect(
      evaluateWhatsAppInbound(
        { ...config, allowSelfChat: true },
        {
          remoteJid: '24966728818848@lid',
          chatJid: '6500000000@s.whatsapp.net',
          senderJid: '6500000000@s.whatsapp.net',
          fromMe: true,
        },
      ),
    ).toEqual({ allowed: true });

    expect(
      evaluateWhatsAppInbound(
        { ...config, allowSelfChat: true },
        {
          remoteJid: '24966728818848@lid',
          chatJid: '6599999999@s.whatsapp.net',
          senderJid: '6599999999@s.whatsapp.net',
          fromMe: true,
        },
      ),
    ).toEqual({ allowed: false, reason: 'not_allowlisted' });
  });

  it('ignores group JIDs', () => {
    expect(
      evaluateWhatsAppInbound(config, {
        remoteJid: '12345@g.us',
        chatJid: '12345@g.us',
        senderJid: '6500000000@s.whatsapp.net',
      }),
    ).toEqual({ allowed: false, reason: 'group_chat' });
  });

  it('ignores status broadcasts', () => {
    expect(evaluateWhatsAppInbound(config, { remoteJid: 'status@broadcast', chatJid: 'status@broadcast' })).toEqual({
      allowed: false,
      reason: 'status_broadcast',
    });
  });

  it('fails safely when private mode is enabled without an allowlist', () => {
    expect(evaluateWhatsAppInbound({ enabled: true }, { remoteJid: '6500000000@s.whatsapp.net' })).toEqual({
      allowed: false,
      reason: 'allowlist_not_configured',
    });
  });

  it('allows outbound messages only to the configured identity', async () => {
    const send = vi.fn(async () => 'sent');
    await expect(safeSendWhatsAppMessage(config, send, '6500000000@s.whatsapp.net', { text: 'hello' })).resolves.toBe(
      'sent',
    );
    expect(send).toHaveBeenCalledOnce();
  });

  it('throws on outbound messages to non-allowlisted identities', async () => {
    const send = vi.fn(async () => 'sent');
    await expect(
      safeSendWhatsAppMessage(config, send, '6599999999@s.whatsapp.net', { text: 'nope' }),
    ).rejects.toBeInstanceOf(WhatsAppSafetyError);
    expect(send).not.toHaveBeenCalled();
  });

  it('returns outbound safety decisions without sending', () => {
    expect(evaluateWhatsAppOutbound(config, '123@g.us')).toEqual({ allowed: false, reason: 'group_chat' });
    expect(evaluateWhatsAppOutbound(config, '6500000000@s.whatsapp.net')).toEqual({ allowed: true });
  });

  it('rejected-message log fields do not include message content', () => {
    const fields = whatsappSafetyLogFields('inbound', 'not_allowlisted', {
      remoteJid: '6599999999@s.whatsapp.net',
      chatJid: '6599999999@s.whatsapp.net',
      senderJid: '6599999999@s.whatsapp.net',
    });
    expect(Object.keys(fields)).not.toContain('text');
    expect(Object.keys(fields)).not.toContain('content');
  });
});
