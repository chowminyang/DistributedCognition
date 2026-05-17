import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

type MountSpec = {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
  allowReadWrite: boolean;
  description: string;
};

type MountAllowlist = {
  allowedRoots?: Array<{ path: string; allowReadWrite: boolean; description?: string }>;
  blockedPatterns?: string[];
};

type AgentGroupRow = {
  id: string;
  name: string;
  folder: string;
};

type ContainerConfigRow = {
  agent_group_id: string;
  additional_mounts: string;
};

type Args = {
  groupIds: string[];
  groupName: string;
  secondBrainRoot?: string;
  codexProjectsRoot: string;
  codexMemoryRoot?: string;
  dryRun: boolean;
};

function usage(): never {
  console.error(
    [
      'Usage: pnpm run dc:ensure-docker-access -- [options]',
      '',
      'Options:',
      '  --group-id <id>              Agent group id to update. Repeatable. Defaults to all groups named Distributed Cognition.',
      '  --group-name <name>          Group name to update when --group-id is omitted. Default: Distributed Cognition.',
      '  --second-brain-root <path>   Writable selected Dropbox second-brain folder.',
      '  --codex-projects-root <path> Read-only Codex projects parent folder. Default: ~/Documents/Codex.',
      '  --codex-memory-root <path>   Read-only Codex memory summaries folder. Default: ~/.codex/memories if present.',
      '  --dry-run                   Show what would change without writing.',
    ].join('\n'),
  );
  process.exit(2);
}

function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

function resolvePath(input: string): string {
  return path.resolve(expandHome(input));
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    groupIds: [],
    groupName: 'Distributed Cognition',
    codexProjectsRoot: path.join(os.homedir(), 'Documents', 'Codex'),
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--group-id') {
      const value = argv[++i];
      if (!value) usage();
      args.groupIds.push(value);
    } else if (arg === '--group-name') {
      const value = argv[++i];
      if (!value) usage();
      args.groupName = value;
    } else if (arg === '--second-brain-root') {
      const value = argv[++i];
      if (!value) usage();
      args.secondBrainRoot = resolvePath(value);
    } else if (arg === '--codex-projects-root') {
      const value = argv[++i];
      if (!value) usage();
      args.codexProjectsRoot = resolvePath(value);
    } else if (arg === '--codex-memory-root') {
      const value = argv[++i];
      if (!value) usage();
      args.codexMemoryRoot = resolvePath(value);
    } else {
      usage();
    }
  }

  args.codexProjectsRoot = resolvePath(args.codexProjectsRoot);
  if (args.secondBrainRoot) args.secondBrainRoot = resolvePath(args.secondBrainRoot);
  if (args.codexMemoryRoot) args.codexMemoryRoot = resolvePath(args.codexMemoryRoot);
  return args;
}

function discoverSecondBrainRoot(): string | undefined {
  const candidates = [
    process.env.DISTRIBUTED_COGNITION_SECOND_BRAIN_ROOT,
    path.join(os.homedir(), 'Library', 'CloudStorage', 'Dropbox', 'Distributed-Cognition'),
    path.join(os.homedir(), 'Dropbox', 'Distributed-Cognition'),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.map(resolvePath).find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isDirectory());
}

function defaultCodexMemoryRoot(): string | undefined {
  const candidate = path.join(os.homedir(), '.codex', 'memories');
  return fs.existsSync(candidate) && fs.statSync(candidate).isDirectory() ? candidate : undefined;
}

function existingDirectory(label: string, dir: string, required = true): boolean {
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return true;
  const message = `${label} does not exist or is not a directory: ${dir}`;
  if (required) throw new Error(message);
  console.warn(`Skipping optional mount: ${message}`);
  return false;
}

function buildMountSpecs(args: Args): MountSpec[] {
  const secondBrainRoot = args.secondBrainRoot ?? discoverSecondBrainRoot();
  const codexMemoryRoot = args.codexMemoryRoot ?? defaultCodexMemoryRoot();
  const specs: MountSpec[] = [];

  if (secondBrainRoot && existingDirectory('second-brain root', secondBrainRoot, false)) {
    specs.push({
      hostPath: secondBrainRoot,
      containerPath: 'second-brain',
      readonly: false,
      allowReadWrite: true,
      description: 'Distributed Cognition selected Dropbox folder',
    });
  }

  existingDirectory('Codex projects root', args.codexProjectsRoot, true);
  specs.push({
    hostPath: args.codexProjectsRoot,
    containerPath: 'codex-projects',
    readonly: true,
    allowReadWrite: false,
    description: 'Distributed Cognition read-only Codex projects parent folder',
  });

  if (codexMemoryRoot && existingDirectory('Codex memory root', codexMemoryRoot, false)) {
    specs.push({
      hostPath: codexMemoryRoot,
      containerPath: 'codex-memory',
      readonly: true,
      allowReadWrite: false,
      description: 'Distributed Cognition read-only curated Codex memory summaries',
    });
  }

  return specs;
}

function upsertAllowlist(specs: MountSpec[], dryRun: boolean): string {
  const configDir = path.join(os.homedir(), '.config', 'nanoclaw');
  const allowlistPath = path.join(configDir, 'mount-allowlist.json');
  const existing = fs.existsSync(allowlistPath)
    ? (JSON.parse(fs.readFileSync(allowlistPath, 'utf-8')) as MountAllowlist)
    : {};
  const allowedRoots = Array.isArray(existing.allowedRoots) ? existing.allowedRoots : [];
  for (const spec of specs) {
    const index = allowedRoots.findIndex((root) => resolvePath(root.path) === spec.hostPath);
    const entry = {
      path: spec.hostPath,
      allowReadWrite: spec.allowReadWrite,
      description: spec.description,
    };
    if (index >= 0) allowedRoots[index] = { ...allowedRoots[index], ...entry };
    else allowedRoots.push(entry);
  }

  const next: MountAllowlist = {
    ...existing,
    allowedRoots,
    blockedPatterns: Array.isArray(existing.blockedPatterns) ? existing.blockedPatterns : [],
  };

  if (!dryRun) {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(allowlistPath, `${JSON.stringify(next, null, 2)}\n`);
  }
  return allowlistPath;
}

function selectGroups(db: Database.Database, args: Args): AgentGroupRow[] {
  if (args.groupIds.length > 0) {
    const stmt = db.prepare('SELECT id, name, folder FROM agent_groups WHERE id = ?');
    const rows = args.groupIds.map((id) => stmt.get(id)).filter(Boolean) as AgentGroupRow[];
    const found = new Set(rows.map((row) => row.id));
    const missing = args.groupIds.filter((id) => !found.has(id));
    if (missing.length > 0) throw new Error(`Agent group id not found: ${missing.join(', ')}`);
    return rows;
  }
  return db
    .prepare('SELECT id, name, folder FROM agent_groups WHERE name = ? ORDER BY created_at')
    .all(args.groupName) as AgentGroupRow[];
}

function upsertGroupMounts(specs: MountSpec[], args: Args, dryRun: boolean): AgentGroupRow[] {
  const dbPath = path.join(process.cwd(), 'data', 'v2.db');
  if (!fs.existsSync(dbPath)) throw new Error(`NanoClaw database not found: ${dbPath}`);
  const db = new Database(dbPath);
  try {
    const groups = selectGroups(db, args);
    if (groups.length === 0) throw new Error(`No agent groups found for name: ${args.groupName}`);
    const configStmt = db.prepare('SELECT agent_group_id, additional_mounts FROM container_configs WHERE agent_group_id = ?');
    const updateStmt = db.prepare(
      'UPDATE container_configs SET additional_mounts = ?, updated_at = ? WHERE agent_group_id = ?',
    );
    for (const group of groups) {
      const row = configStmt.get(group.id) as ContainerConfigRow | undefined;
      if (!row) throw new Error(`No container config for agent group: ${group.id}`);
      const current = JSON.parse(row.additional_mounts) as Array<{
        hostPath: string;
        containerPath: string;
        readonly?: boolean;
      }>;
      const next = current.filter(
        (mount) =>
          !specs.some((spec) => mount.containerPath === spec.containerPath || resolvePath(mount.hostPath) === spec.hostPath),
      );
      for (const spec of specs) {
        next.push({ hostPath: spec.hostPath, containerPath: spec.containerPath, readonly: spec.readonly });
      }
      if (!dryRun) updateStmt.run(JSON.stringify(next), new Date().toISOString(), group.id);
    }
    return groups;
  } finally {
    db.close();
  }
}

const args = parseArgs(process.argv.slice(2));
const specs = buildMountSpecs(args);
const allowlistPath = upsertAllowlist(specs, args.dryRun);
const groups = upsertGroupMounts(specs, args, args.dryRun);

console.log(`${args.dryRun ? 'Would configure' : 'Configured'} Docker access for Distributed Cognition.`);
console.log(`Allowlist: ${allowlistPath}`);
console.log(`Groups: ${groups.map((group) => `${group.name} (${group.id}, ${group.folder})`).join('; ')}`);
for (const spec of specs) {
  console.log(
    `- ${spec.readonly ? 'read-only' : 'read-write'} ${spec.hostPath} -> /workspace/extra/${spec.containerPath}`,
  );
}
console.log('Restart affected group containers for existing Docker containers to receive the new mounts.');
