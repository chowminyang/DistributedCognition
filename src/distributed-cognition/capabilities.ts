import { classifyDistributedMessage, type DistributedMessageType } from './notes.js';

export type DistributedCapabilityId =
  | 'capture_reflection'
  | 'capture_decision'
  | 'capture_general_note'
  | 'process_audio'
  | 'promote_durable_memory'
  | 'correct_or_forget_memory'
  | 'answer_question'
  | 'search_context'
  | 'synthesize_review'
  | 'update_project_wiki'
  | 'report_status'
  | 'web_search'
  | 'queue_codex_handoff'
  | 'queue_action_request'
  | 'refuse_sensitive_data'
  | 'clarify';

export interface DistributedCapability {
  id: DistributedCapabilityId;
  label: string;
  description: string;
  defaultTools: string[];
  requiresHostBridge: boolean;
  risk: 'low' | 'medium' | 'high' | 'blocked';
}

export interface CapabilityRoute {
  capability: DistributedCapability;
  messageType: DistributedMessageType;
  confidence: 'low' | 'medium' | 'high';
  reasons: string[];
  suggestedTools: string[];
  hostBridge?: 'codex' | 'action';
}

export const DISTRIBUTED_CAPABILITIES: Record<DistributedCapabilityId, DistributedCapability> = {
  capture_reflection: {
    id: 'capture_reflection',
    label: 'Capture reflection',
    description: 'Store raw and processed reflective notes in the second-brain folder.',
    defaultTools: ['distributed_cognition_capture_note'],
    requiresHostBridge: false,
    risk: 'low',
  },
  capture_decision: {
    id: 'capture_decision',
    label: 'Capture decision',
    description: 'Store a dated decision note and consider durable memory promotion.',
    defaultTools: ['distributed_cognition_capture_note', 'distributed_cognition_auto_upgrade_memory'],
    requiresHostBridge: false,
    risk: 'medium',
  },
  capture_general_note: {
    id: 'capture_general_note',
    label: 'Capture note',
    description: 'Store a general note without forcing durable memory.',
    defaultTools: ['distributed_cognition_capture_note'],
    requiresHostBridge: false,
    risk: 'low',
  },
  process_audio: {
    id: 'process_audio',
    label: 'Process audio',
    description: 'Transcribe owner-sent WhatsApp audio and then capture the transcript as raw and processed Markdown.',
    defaultTools: ['distributed_cognition_capture_audio'],
    requiresHostBridge: false,
    risk: 'medium',
  },
  promote_durable_memory: {
    id: 'promote_durable_memory',
    label: 'Promote durable memory',
    description: 'Store only concise, high-signal, safe memories in Mnemon with an audit trail.',
    defaultTools: ['distributed_cognition_auto_upgrade_memory'],
    requiresHostBridge: false,
    risk: 'medium',
  },
  correct_or_forget_memory: {
    id: 'correct_or_forget_memory',
    label: 'Correct memory',
    description: 'Create an auditable correction or supersession rather than silently deleting memory.',
    defaultTools: ['distributed_cognition_capture_note', 'distributed_cognition_auto_upgrade_memory'],
    requiresHostBridge: false,
    risk: 'medium',
  },
  answer_question: {
    id: 'answer_question',
    label: 'Answer question',
    description: 'Answer from available second-brain, context index, Mnemon, or stated uncertainty.',
    defaultTools: ['distributed_cognition_search_context', 'distributed_cognition_read_context'],
    requiresHostBridge: false,
    risk: 'low',
  },
  search_context: {
    id: 'search_context',
    label: 'Search local context',
    description: 'Search mounted Dropbox context and second-brain notes without broad filesystem access.',
    defaultTools: ['distributed_cognition_search_context', 'distributed_cognition_read_context'],
    requiresHostBridge: false,
    risk: 'low',
  },
  synthesize_review: {
    id: 'synthesize_review',
    label: 'Synthesize review',
    description: 'Produce weekly, project, or portfolio synthesis from stored local context.',
    defaultTools: ['distributed_cognition_search_context', 'distributed_cognition_update_project_status'],
    requiresHostBridge: false,
    risk: 'medium',
  },
  update_project_wiki: {
    id: 'update_project_wiki',
    label: 'Update project wiki',
    description: 'Refresh Obsidian-friendly project state, decisions, risks, open questions, and next actions.',
    defaultTools: ['distributed_cognition_update_project_status'],
    requiresHostBridge: false,
    risk: 'medium',
  },
  report_status: {
    id: 'report_status',
    label: 'Report status',
    description: 'Report health, queues, project workbench, and recent operations.',
    defaultTools: ['distributed_cognition_health_check', 'distributed_cognition_queue_status'],
    requiresHostBridge: false,
    risk: 'low',
  },
  web_search: {
    id: 'web_search',
    label: 'Search public web',
    description: 'Use bounded public web tools for current information and source leads.',
    defaultTools: ['distributed_cognition_web_search', 'distributed_cognition_read_web_page'],
    requiresHostBridge: false,
    risk: 'medium',
  },
  queue_codex_handoff: {
    id: 'queue_codex_handoff',
    label: 'Queue Codex handoff',
    description: 'Compose a self-contained local Codex task for an allowlisted project.',
    defaultTools: ['distributed_cognition_build_codex_status', 'distributed_cognition_create_codex_handoff'],
    requiresHostBridge: true,
    risk: 'high',
  },
  queue_action_request: {
    id: 'queue_action_request',
    label: 'Queue action request',
    description: 'Queue heavier local work such as web research, Word documents, or PowerPoint decks.',
    defaultTools: ['distributed_cognition_create_action_request'],
    requiresHostBridge: true,
    risk: 'high',
  },
  refuse_sensitive_data: {
    id: 'refuse_sensitive_data',
    label: 'Refuse sensitive data',
    description: 'Refuse to process prohibited sensitive material and ask for redaction.',
    defaultTools: ['distributed_cognition_format_reply'],
    requiresHostBridge: false,
    risk: 'blocked',
  },
  clarify: {
    id: 'clarify',
    label: 'Clarify',
    description: 'Ask a concise clarifying question before durable memory, permanent wiki edits, or external action.',
    defaultTools: ['distributed_cognition_format_reply'],
    requiresHostBridge: false,
    risk: 'low',
  },
};

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function route(
  id: DistributedCapabilityId,
  messageType: DistributedMessageType,
  confidence: CapabilityRoute['confidence'],
  reasons: string[],
): CapabilityRoute {
  const capability = DISTRIBUTED_CAPABILITIES[id];
  const hostBridge = id === 'queue_codex_handoff' ? 'codex' : id === 'queue_action_request' ? 'action' : undefined;
  return {
    capability,
    messageType,
    confidence,
    reasons,
    suggestedTools: capability.defaultTools,
    hostBridge,
  };
}

export function classifyDistributedCapability(
  text: string,
  options: { messageType?: DistributedMessageType; hasAudioAttachment?: boolean } = {},
): CapabilityRoute {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  const messageType = options.messageType ?? classifyDistributedMessage(trimmed);
  const reasons: string[] = [];

  if (messageType === 'sensitive_data_warning') {
    return route('refuse_sensitive_data', messageType, 'high', ['message classified as sensitive_data_warning']);
  }

  if (options.hasAudioAttachment || hasAny(lower, [/\b(audio|voice note|voice recording|opus|ogg|m4a)\b/])) {
    return route('process_audio', messageType, 'high', ['audio or voice-note signal detected']);
  }

  if (
    hasAny(lower, [
      /\b(codex|repo|repository|codebase|implement|fix|debug|test this|run tests|create a branch|commit|push)\b/,
      /\b(hand\s?off|send this to codex|ask codex|local agent|agent team)\b/,
    ])
  ) {
    return route('queue_codex_handoff', messageType, 'high', ['local Codex work signal detected']);
  }

  if (
    hasAny(lower, [
      /\b(powerpoint|pptx|slide deck|slides|word document|docx|long research|research task|create a document)\b/,
      /\b(make|create|draft|prepare|turn this into)\s+(a\s+)?(deck|presentation|document|report|brief)\b/,
    ])
  ) {
    return route('queue_action_request', messageType, 'high', ['artifact or long-running action signal detected']);
  }

  if (hasAny(lower, [/\b(latest|current|today's|news|web search|search the web|look up|source url|public web)\b/])) {
    return route('web_search', messageType, 'high', ['current-information or public-web signal detected']);
  }

  if (hasAny(lower, [/\b(health check|are you alive|queue status|what is queued|dashboard|workbench|status)\b/])) {
    return route('report_status', messageType, 'high', ['status or queue visibility signal detected']);
  }

  if (
    messageType === 'weekly_synthesis_request' ||
    hasAny(lower, [/\b(summarise|summarize|synthesise|synthesize|review my week|portfolio map|project map)\b/])
  ) {
    return route('synthesize_review', messageType, 'high', ['synthesis or review signal detected']);
  }

  if (
    hasAny(lower, [
      /\b(update|refresh|write to|add to)\s+(the\s+)?(project wiki|wiki|decision log|open questions|argument bank)\b/,
      /\b(project status|current state|next actions|open questions|risks)\b/,
    ])
  ) {
    return route('update_project_wiki', messageType, 'medium', ['project-memory update signal detected']);
  }

  if (messageType === 'forget_or_correction_request') {
    return route('correct_or_forget_memory', messageType, 'high', ['forget or correction message type']);
  }

  if (
    messageType === 'durable_memory_candidate' ||
    hasAny(lower, [/\b(remember|durable memory|from now on|standing rule|always|never|prefer|default)\b/])
  ) {
    return route('promote_durable_memory', messageType, 'high', ['durable-memory signal detected']);
  }

  if (
    hasAny(lower, [
      /\b(search|find|look in|dropbox|context folder|second brain|second-brain|mnemon|what do you know)\b/,
    ])
  ) {
    return route('search_context', messageType, 'medium', ['local-context retrieval signal detected']);
  }

  if (messageType === 'question') {
    return route('answer_question', messageType, 'medium', ['question message type']);
  }

  if (messageType === 'decision') {
    return route('capture_decision', messageType, 'high', ['decision message type']);
  }

  if (messageType === 'reflection') {
    return route('capture_reflection', messageType, 'medium', ['reflection message type']);
  }

  if (messageType === 'unclear') {
    return route('clarify', messageType, 'low', ['empty or unclear message']);
  }

  reasons.push('default general note capture');
  return route('capture_general_note', messageType, 'medium', reasons);
}

export function capabilityCatalogueMarkdown(): string {
  return Object.values(DISTRIBUTED_CAPABILITIES)
    .map((capability) =>
      [
        `## ${capability.label}`,
        `id: ${capability.id}`,
        `risk: ${capability.risk}`,
        `host bridge: ${capability.requiresHostBridge ? 'yes' : 'no'}`,
        `tools: ${capability.defaultTools.join(', ') || 'none'}`,
        '',
        capability.description,
      ].join('\n'),
    )
    .join('\n\n');
}
