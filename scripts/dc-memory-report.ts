import fs from 'fs';
import os from 'os';
import path from 'path';

import { renderMnemonMemoryReport, writeMnemonMemoryReport } from '../src/distributed-cognition/memory-report.js';

const DEFAULT_GROUP_CONFIG = path.join(process.cwd(), 'groups/dm-with-minyangchow/container.json');
const DEFAULT_MNEMON_DB = path.join(process.cwd(), 'groups/dm-with-minyangchow/.mnemon/memory.db');
const DEFAULT_SECOND_BRAIN_ROOT = path.join(os.homedir(), 'Library/CloudStorage/Dropbox/Distributed-Cognition');

interface Args {
  root: string;
  mnemonDb: string;
  output?: string;
  limit: number;
}

function usage(): never {
  console.error(
    [
      'Usage: pnpm run dc:memory-report -- [options]',
      '',
      'Options:',
      '  --root <path>          Distributed Cognition second-brain root.',
      '  --mnemon-db <path>     Mnemon SQLite database path.',
      '  --output <path>        Optional Markdown output path. Defaults to project-wikis/mnemon-memory-report.md.',
      '  --limit <n>            Maximum memories to display. Default: 40.',
    ].join('\n'),
  );
  process.exit(2);
}

function detectMountedSecondBrainRoot(): string | undefined {
  try {
    if (!fs.existsSync(DEFAULT_GROUP_CONFIG)) return undefined;
    const parsed = JSON.parse(fs.readFileSync(DEFAULT_GROUP_CONFIG, 'utf-8')) as {
      additionalMounts?: Array<{ hostPath?: string; containerPath?: string; readonly?: boolean }>;
    };
    const mount = parsed.additionalMounts?.find(
      (item) => item.containerPath === 'second-brain' && item.readonly === false && item.hostPath,
    );
    return mount?.hostPath ? path.resolve(mount.hostPath) : undefined;
  } catch {
    return undefined;
  }
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    root: process.env.DC_SECOND_BRAIN_ROOT || detectMountedSecondBrainRoot() || DEFAULT_SECOND_BRAIN_ROOT,
    mnemonDb: process.env.DC_MNEMON_DB || process.env.MNEMON_DB_PATH || DEFAULT_MNEMON_DB,
    limit: 40,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--root') {
      const value = argv[++i];
      if (!value) usage();
      args.root = path.resolve(value);
    } else if (arg === '--mnemon-db') {
      const value = argv[++i];
      if (!value) usage();
      args.mnemonDb = path.resolve(value);
    } else if (arg === '--output') {
      const value = argv[++i];
      if (!value) usage();
      args.output = path.resolve(value);
    } else if (arg === '--limit') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1) usage();
      args.limit = value;
    } else {
      usage();
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
try {
  if (!fs.existsSync(args.root)) throw new Error(`Second-brain root does not exist: ${args.root}`);
  const written = writeMnemonMemoryReport(args.root, {
    mnemonDb: args.mnemonDb,
    output: args.output,
    limit: args.limit,
  });
  console.log(renderMnemonMemoryReport(written.report));
  console.log(`\nWrote ${written.markdownPath}`);
  console.log(`Wrote ${written.jsonPath}`);
  console.log(`Wrote ${written.graphJsonPath}`);
  console.log(`Wrote ${written.canvasPath}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
