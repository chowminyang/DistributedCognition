import fs from 'fs';
import path from 'path';

import { detectProjectSignals } from './notes.js';
import { appendProvenanceEvent } from './provenance.js';

interface OntologyNode {
  name: string;
  type: 'project' | 'theme' | 'workflow';
  aliases: string[];
  sources: string[];
}

export interface ProjectOntology {
  generatedAt: string;
  nodes: OntologyNode[];
}

const CANONICAL_NODES: Array<Omit<OntologyNode, 'sources'>> = [
  { name: 'AIME', type: 'project', aliases: ['Office of AI-enhanced Medical Education'] },
  { name: 'p(AI)tient', type: 'project', aliases: ['AI communication simulation'] },
  { name: 'CORTEX', type: 'project', aliases: ['tool-mediated judgement'] },
  { name: 'CREATE Hackathon', type: 'project', aliases: ['CREATE'] },
  { name: 'grants', type: 'workflow', aliases: ['funding', 'proposals'] },
  { name: 'papers and manuscripts', type: 'workflow', aliases: ['publications', 'reviewer responses'] },
  { name: 'workshops and talks', type: 'workflow', aliases: ['decks', 'presentations'] },
  { name: 'AI-enhanced assessment', type: 'theme', aliases: ['assessment', 'OSCE', 'MCQ'] },
  { name: 'productive struggle', type: 'theme', aliases: ['productive struggle'] },
  { name: 'discernment', type: 'theme', aliases: ['discernment'] },
  { name: 'uncertainty tolerance', type: 'theme', aliases: ['adaptive expertise'] },
  { name: 'wisdom', type: 'theme', aliases: ['wisdom'] },
  { name: 'education strategy and governance', type: 'theme', aliases: ['strategy', 'governance'] },
];

const SCAN_FOLDERS = [
  'daily-reflections',
  'processed-notes',
  'pending-review',
  'weekly-reviews',
  'decision-log',
] as const;

function sgtTimestamp(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Singapore',
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, part) => {
      if (part.type !== 'literal') acc[part.type] = part.value;
      return acc;
    }, {});
  return `${parts.day}-${parts.month}-${parts.year}, ${parts.hour}:${parts.minute}`;
}

function requireRoot(root: string): string {
  const real = fs.realpathSync(root);
  if (!fs.statSync(real).isDirectory()) throw new Error(`Second-brain root is not a directory: ${root}`);
  return real;
}

export function buildProjectOntology(root: string): ProjectOntology {
  const real = requireRoot(root);
  const nodeMap = new Map<string, OntologyNode>(CANONICAL_NODES.map((node) => [node.name, { ...node, sources: [] }]));

  for (const folder of SCAN_FOLDERS) {
    const dir = path.join(real, folder);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.md'))) {
      const relativePath = `${folder}/${file}`;
      const content = fs.readFileSync(path.join(dir, file), 'utf-8');
      for (const signal of detectProjectSignals(content)) {
        const node =
          nodeMap.get(signal) ??
          ({
            name: signal,
            type: 'theme',
            aliases: [],
            sources: [],
          } satisfies OntologyNode);
        if (!node.sources.includes(relativePath)) node.sources.push(relativePath);
        nodeMap.set(signal, node);
      }
    }
  }

  return {
    generatedAt: sgtTimestamp(),
    nodes: [...nodeMap.values()].sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name)),
  };
}

export function renderProjectOntology(ontology: ProjectOntology): string {
  const groups = {
    project: ontology.nodes.filter((node) => node.type === 'project'),
    theme: ontology.nodes.filter((node) => node.type === 'theme'),
    workflow: ontology.nodes.filter((node) => node.type === 'workflow'),
  };
  const renderGroup = (label: string, nodes: OntologyNode[]) => [
    `## ${label}`,
    ...nodes.map((node) => {
      const aliases = node.aliases.length > 0 ? ` aliases: ${node.aliases.join(', ')}.` : '';
      const sourceText =
        node.sources.length > 0
          ? ` sources: ${node.sources
              .slice(0, 5)
              .map((source) => `[[${source}]]`)
              .join(', ')}.`
          : ' sources: not yet observed in notes.';
      return `- **${node.name}**.${aliases}${sourceText}`;
    }),
    '',
  ];

  return [
    '---',
    'type: project_ontology',
    'system: distributed-cognition',
    `generated: "${ontology.generatedAt}"`,
    'tags:',
    '  - distributed-cognition/ontology',
    '---',
    '',
    `# Project Ontology - ${ontology.generatedAt}`,
    '',
    'This page keeps stable names for projects, themes, and workflows so Mnemon stores concise pivots while the wiki stores readable synthesis.',
    '',
    ...renderGroup('Projects', groups.project),
    ...renderGroup('Themes', groups.theme),
    ...renderGroup('Workflows', groups.workflow),
    '## Usage Rule',
    '- Promote only durable pivots, decisions, preferences, corrections, and stable project constraints into Mnemon.',
    '- Keep noisy meeting context, raw transcripts, and transient logistics in Markdown.',
    '',
  ].join('\n');
}

export function writeProjectOntology(root: string): string {
  const real = requireRoot(root);
  const wikiDir = path.join(real, 'project-wikis');
  fs.mkdirSync(wikiDir, { recursive: true });
  const ontology = buildProjectOntology(real);
  const target = path.join(wikiDir, 'project-ontology.md');
  fs.writeFileSync(target, renderProjectOntology(ontology));
  appendProvenanceEvent(real, {
    id: `ontology-${Date.now()}`,
    kind: 'project_ontology',
    title: 'Project ontology refreshed',
    summary: `Refreshed ${ontology.nodes.length} ontology nodes.`,
    sourcePaths: ontology.nodes.flatMap((node) => node.sources).slice(0, 30),
    outputPaths: ['project-wikis/project-ontology.md'],
    metadata: {
      nodeCount: ontology.nodes.length,
      observedNodes: ontology.nodes.filter((node) => node.sources.length > 0).map((node) => node.name),
    },
  });
  return target;
}
