import { describe, expect, it } from 'vitest';

import { capabilityCatalogueMarkdown, classifyDistributedCapability } from './capabilities.js';

describe('Distributed Cognition capabilities', () => {
  it('routes voice notes to audio processing', () => {
    const route = classifyDistributedCapability('voice note reflection about CORTEX', { hasAudioAttachment: true });
    expect(route.capability.id).toBe('process_audio');
    expect(route.suggestedTools).toContain('distributed_cognition_capture_audio');
  });

  it('routes repo work to local Codex handoff', () => {
    const route = classifyDistributedCapability('Ask Codex to fix the p(AI)tient tests in the repo.');
    expect(route.capability.id).toBe('queue_codex_handoff');
    expect(route.hostBridge).toBe('codex');
  });

  it('routes PowerPoint and research work to action requests', () => {
    const route = classifyDistributedCapability('Create a PowerPoint deck from this reflection.');
    expect(route.capability.id).toBe('queue_action_request');
    expect(route.hostBridge).toBe('action');
  });

  it('routes current public information to web search', () => {
    const route = classifyDistributedCapability('Look up the latest public source on AI assessment.');
    expect(route.capability.id).toBe('web_search');
  });

  it('routes status checks to queue/status reporting', () => {
    const route = classifyDistributedCapability('DC, what is queued right now?');
    expect(route.capability.id).toBe('report_status');
  });

  it('routes attention, ontology, memory hygiene, and provenance requests', () => {
    expect(classifyDistributedCapability('DC, run attention calibration.').capability.id).toBe('calibrate_attention');
    expect(classifyDistributedCapability('Refresh the project ontology.').capability.id).toBe(
      'refresh_project_ontology',
    );
    expect(classifyDistributedCapability('Run memory hygiene for changed my mind notes.').capability.id).toBe(
      'refresh_memory_hygiene',
    );
    expect(classifyDistributedCapability('Show me the provenance ledger.').capability.id).toBe('show_provenance');
  });

  it('keeps ordinary reflections as capture work', () => {
    const route = classifyDistributedCapability('Today I realised the office is really about transformation.');
    expect(route.capability.id).toBe('capture_reflection');
  });

  it('renders a capability catalogue for the agent prompt/docs', () => {
    const markdown = capabilityCatalogueMarkdown();
    expect(markdown).toContain('## Queue Codex handoff');
    expect(markdown).toContain('distributed_cognition_create_action_request');
  });
});
