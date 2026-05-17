import { describe, expect, it } from 'vitest';

import { frontmatter, obsidianTemplates, projectWikiTemplate } from './wiki-templates.js';

describe('Distributed Cognition Obsidian templates', () => {
  const fixed = new Date('2026-05-16T14:45:00.000Z');

  it('renders YAML frontmatter with arrays', () => {
    expect(frontmatter({ type: 'project', tags: ['a', 'b'] })).toContain('tags:\n  - a\n  - b');
  });

  it('renders project wiki pages with frontmatter and status sections', () => {
    const markdown = projectWikiTemplate('CORTEX', fixed);
    expect(markdown).toContain('type: "project_wiki"');
    expect(markdown).toContain('last_reviewed: "16-05-26, 22:45"');
    expect(markdown).toContain('## Open Questions');
  });

  it('includes queue and memory templates', () => {
    const templates = obsidianTemplates({ now: fixed });
    expect(templates['memory-audit.md']).toContain('type: "memory_audit"');
    expect(templates['queue-status.md']).toContain('type: "queue_status"');
  });
});
