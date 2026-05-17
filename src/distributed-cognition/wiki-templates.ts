import { formatDistributedTimestamp } from './notes.js';

export interface ObsidianTemplateOptions {
  now?: Date;
  project?: string;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

export function frontmatter(fields: Record<string, string | string[] | undefined>): string {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${item}`);
    } else {
      lines.push(`${key}: ${yamlString(value)}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

export function projectWikiTemplate(project: string, now = new Date()): string {
  const ts = formatDistributedTimestamp(now);
  return [
    frontmatter({
      type: 'project_wiki',
      project,
      status: 'active',
      last_reviewed: ts,
      review_after: 'None scheduled',
      mnemon_importance: 'medium',
      tags: ['distributed-cognition/project'],
    }),
    '',
    `# ${project}`,
    '',
    '## Current State',
    'Needs review',
    '',
    '## Timeline',
    '',
    '## Decisions',
    '',
    '## Open Questions',
    '',
    '## Risks',
    '',
    '## Next Actions',
    '',
    '## Sources',
    '',
    '## Mnemon Candidates',
    'Store only concise, high-signal project facts or pivots in Mnemon. Keep raw transcripts as linked source notes.',
    '',
    '## Update Log',
    `- ${ts}: Page created or refreshed by Distributed Cognition.`,
    '',
  ].join('\n');
}

export function obsidianTemplates(options: ObsidianTemplateOptions = {}): Record<string, string> {
  const now = options.now ?? new Date();
  const ts = formatDistributedTimestamp(now);
  const project = options.project ?? '{{project}}';
  return {
    'project-wiki.md': projectWikiTemplate(project, now),
    'home-dashboard.md': [
      frontmatter({
        type: 'dashboard',
        created: ts,
        tags: ['distributed-cognition/dashboard'],
      }),
      '',
      `# Distributed Cognition Home - ${ts}`,
      '',
      '## Today',
      '- [[project-wikis/current-projects|Current Projects]]',
      '- [[open-questions/deadline-watch|Deadline Watch]]',
      '- [[project-wikis/work-queue|Work Queue]]',
      '',
      '## Thinking System',
      '- [[project-wikis/project-ontology|Project Ontology]]',
      '- [[project-wikis/attention-calibration|Attention Calibration]]',
      '- [[project-wikis/memory-hygiene|Memory Hygiene]]',
      '- [[project-wikis/provenance-ledger|Provenance Ledger]]',
      '',
    ].join('\n'),
    'reflection.md': [
      frontmatter({
        type: 'reflection',
        created: ts,
        message_type: 'reflection',
        mnemon_importance: 'low',
        tags: ['distributed-cognition/reflection'],
      }),
      '',
      `# Reflection - ${ts}`,
      '',
      '## Raw Reflection',
      '',
      '## New Insight',
      '',
      '## Decision Made Or Leaning',
      '',
      '## Open Questions',
      '',
      '## Suggested Next Actions',
      '',
      '## Long-Term Memory Candidate',
      'Unsure',
      '',
    ].join('\n'),
    'decision.md': [
      frontmatter({
        type: 'decision',
        created: ts,
        decision_type: 'leaning',
        mnemon_importance: 'high',
        tags: ['distributed-cognition/decision'],
      }),
      '',
      `# Decision - ${ts}`,
      '',
      '## Raw Decision Statement',
      '',
      '## Decision Type',
      'confirmed / leaning / deferred',
      '',
      '## Rationale',
      '',
      '## Implications',
      '',
      '## Risks',
      '',
      '## What Would Change This Decision',
      '',
      '## Add To Decision Log?',
      'Needs review',
      '',
    ].join('\n'),
    'memory-audit.md': [
      frontmatter({
        type: 'memory_audit',
        created: ts,
        status: 'auto_stored',
        mnemon_importance: 'high',
        tags: ['distributed-cognition/memory'],
      }),
      '',
      `# Durable Memory Upgrade - ${ts}`,
      '',
      '## Mnemon',
      '',
      '## Memory',
      '',
      '## Rationale',
      '',
      '## Source Notes',
      '',
      '## Safety',
      '- Raw transcript content was not stored in Mnemon.',
      '',
    ].join('\n'),
    'attention-calibration.md': [
      frontmatter({
        type: 'attention_calibration',
        created: ts,
        tags: ['distributed-cognition/attention'],
      }),
      '',
      `# Attention Calibration - ${ts}`,
      '',
      '## Summary',
      '',
      '## Promoted To Mnemon',
      '',
      '## Kept In Markdown',
      '',
      '## Feedback',
      '',
    ].join('\n'),
    'memory-hygiene.md': [
      frontmatter({
        type: 'memory_hygiene',
        created: ts,
        tags: ['distributed-cognition/memory-hygiene'],
      }),
      '',
      `# Memory Hygiene - ${ts}`,
      '',
      '## Current Memories',
      '',
      '## Changed-My-Mind Notes',
      '',
      '## Superseded Or Obsolete',
      '',
      '## Review Prompts',
      '',
    ].join('\n'),
    'project-ontology.md': [
      frontmatter({
        type: 'project_ontology',
        created: ts,
        tags: ['distributed-cognition/ontology'],
      }),
      '',
      `# Project Ontology - ${ts}`,
      '',
      '## Projects',
      '',
      '## Themes',
      '',
      '## Workflows',
      '',
    ].join('\n'),
    'provenance-ledger.md': [
      frontmatter({
        type: 'provenance_ledger',
        created: ts,
        tags: ['distributed-cognition/provenance'],
      }),
      '',
      `# Provenance Ledger - ${ts}`,
      '',
      '## Recent Events',
      '',
    ].join('\n'),
    'codex-handoff.md': [
      frontmatter({
        type: 'codex_handoff',
        created: ts,
        target: 'codex-local',
        status: 'queued',
        tags: ['distributed-cognition/codex-handoff'],
      }),
      '',
      `# Codex Handoff - ${project} - ${ts}`,
      '',
      '## Task',
      '',
      '## Proposed Plan',
      '',
      '## Acceptance Criteria',
      '',
      '## Source Notes',
      '',
      '## Safety Boundaries',
      '',
    ].join('\n'),
    'action-request.md': [
      frontmatter({
        type: 'action_request',
        created: ts,
        target: 'codex-local',
        status: 'queued',
        tags: ['distributed-cognition/action'],
      }),
      '',
      `# Action Request - ${ts}`,
      '',
      '## Action Type',
      '',
      '## Brief',
      '',
      '## Draft Content',
      '',
      '## Source Notes',
      '',
    ].join('\n'),
    'weekly-review.md': [
      frontmatter({
        type: 'weekly_review',
        created: ts,
        tags: ['distributed-cognition/weekly-review'],
      }),
      '',
      `# Weekly Review - ${ts}`,
      '',
      '## Stored Facts',
      '',
      '## Extracted Facts',
      '',
      '## Inferred Themes',
      '',
      '## Decisions',
      '',
      '## Open Questions',
      '',
      '## Suggested Actions',
      '',
    ].join('\n'),
    'queue-status.md': [
      frontmatter({
        type: 'queue_status',
        generated: ts,
        tags: ['distributed-cognition/queue'],
      }),
      '',
      `# Work Queue - ${ts}`,
      '',
      '## Summary',
      '',
      '## Recent Items',
      '',
      '## Recent Progress Events',
      '',
    ].join('\n'),
  };
}
