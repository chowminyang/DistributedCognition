import path from 'path';

import {
  buildHostHealthReport,
  renderHostHealthMarkdown,
  resolveDefaultSecondBrainRoot,
  writeHostHealth,
} from '../src/distributed-cognition/host-health.js';

type Args = {
  root?: string;
  json?: boolean;
};

function usage(): never {
  console.error(
    [
      'Usage: pnpm run dc:health -- [options]',
      '',
      'Options:',
      '  --root <path>   Distributed Cognition second-brain root.',
      '  --json          Print JSON instead of Markdown.',
      '',
      'You can also set DC_SECOND_BRAIN_ROOT.',
    ].join('\n'),
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--root') {
      const value = argv[++i];
      if (!value) usage();
      args.root = path.resolve(value);
    } else if (arg === '--json') {
      args.json = true;
    } else {
      usage();
    }
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const root = resolveDefaultSecondBrainRoot(args.root);
  const report = buildHostHealthReport({ root, cwd: process.cwd() });
  const written = writeHostHealth(root, report);
  if (args.json) {
    console.log(JSON.stringify({ report, written }, null, 2));
  } else {
    console.log(renderHostHealthMarkdown(report));
    console.log(`Wrote ${written.markdownPath}`);
    console.log(`Wrote ${written.jsonPath}`);
  }
  if (report.overall === 'error') process.exitCode = 1;
}

main();
