import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

const project = process.cwd();
const temporary = mkdtempSync(join(tmpdir(), 'agent-kudos-pack-'));

try {
  const packJson = JSON.parse(
    run('npm', ['pack', '--json', '--pack-destination', temporary], project),
  );
  const packed = packJson[0];
  if (!packed?.filename || !Array.isArray(packed.files))
    throw new Error('npm pack returned no file manifest.');
  const names = packed.files.map((file) => file.path);
  for (const required of [
    'package.json',
    'README.md',
    'AGENTS.md',
    'ARCHITECTURE.md',
    'LICENSE',
    'docs/recovery.md',
    'dist/index.js',
    'dist/cli.js',
    'dist/mcp-server.js',
  ]) {
    if (!names.includes(required)) throw new Error(`Tarball is missing ${required}.`);
  }
  const forbidden = names.filter(
    (name) => name.startsWith('test/') || name.includes('.agents/') || name.endsWith('.sqlite3'),
  );
  if (forbidden.length)
    throw new Error(`Tarball contains forbidden files: ${forbidden.join(', ')}`);

  const consumer = join(temporary, 'consumer');
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, 'package.json'),
    '{"name":"agent-kudos-smoke","private":true,"type":"module"}\n',
  );
  const tarball = join(temporary, packed.filename);
  if (!existsSync(tarball)) throw new Error('Tarball was not created.');
  run('npm', ['install', '--ignore-scripts', tarball], consumer);
  const packageJson = JSON.parse(
    readFileSync(join(consumer, 'node_modules', 'agent-kudos', 'package.json'), 'utf8'),
  );
  if (packageJson.name !== 'agent-kudos')
    throw new Error('Installed package metadata is incorrect.');
  const kudosBin = join(consumer, 'node_modules', '.bin', 'kudos');
  const mcpBin = join(consumer, 'node_modules', '.bin', 'agent-kudos-mcp');
  run(kudosBin, ['--help'], consumer);
  run(mcpBin, ['--help'], consumer);
  if (run(kudosBin, ['--version'], consumer).trim() !== packageJson.version)
    throw new Error('CLI version does not match package.json.');
  if (run(mcpBin, ['--version'], consumer).trim() !== packageJson.version)
    throw new Error('MCP binary version does not match package.json.');
  run(
    'node',
    [
      '--input-type=module',
      '--eval',
      "import { KudosClient } from 'agent-kudos'; if (!KudosClient) process.exit(1)",
    ],
    consumer,
  );
  run(
    'node',
    [
      '--input-type=module',
      '--eval',
      "import { createAgentKudosMcpServer } from 'agent-kudos/mcp'; if (!createAgentKudosMcpServer) process.exit(1)",
    ],
    consumer,
  );

  const acceptanceHome = join(temporary, 'acceptance', '.agents');
  const acceptanceEnv = { ...process.env, AGENT_KUDOS_HOME: acceptanceHome };
  run(kudosBin, ['init'], consumer, acceptanceEnv);
  run(
    kudosBin,
    ['agent', 'create', 'gracie', '--name', 'Gracie P. Tienammè'],
    consumer,
    acceptanceEnv,
  );
  run(kudosBin, ['agent', 'create', 'codex', '--name', 'Codex'], consumer, acceptanceEnv);
  const giveArgs = [
    'give',
    'codex',
    '--from',
    'gracie',
    '--actor-kind',
    'agent',
    '--title',
    'Caught a continuity contradiction',
    '--reason',
    'Found conflicting E17 requirements before implementation, preventing work against the wrong assumption.',
    '--tag',
    'review',
    '--tag',
    'continuity',
    '--evidence',
    'task:E17',
    '--visibility',
    'local',
    '--idempotency-key',
    'acceptance-gracie-codex-e17',
    '--json',
  ];
  const given = JSON.parse(run(kudosBin, giveArgs, consumer, acceptanceEnv));
  const kudosId = given.record?.event?.id;
  if (!kudosId || given.deduplicated) throw new Error('Acceptance kudos was not created.');
  if (!run(kudosBin, ['inbox', 'codex'], consumer, acceptanceEnv).includes(kudosId)) {
    throw new Error('Acceptance inbox did not contain the new kudos.');
  }
  if (!run(kudosBin, ['wins', 'codex', '--print'], consumer, acceptanceEnv).includes(kudosId)) {
    throw new Error('Acceptance WINS.md did not contain the new kudos.');
  }
  run(
    kudosBin,
    ['acknowledge', kudosId, '--as', 'codex', '--actor-kind', 'agent'],
    consumer,
    acceptanceEnv,
  );
  run(kudosBin, ['show', kudosId, '--json'], consumer, acceptanceEnv);
  run(kudosBin, ['stats', '--json'], consumer, acceptanceEnv);
  run(kudosBin, ['doctor'], consumer, acceptanceEnv);
  run(kudosBin, ['rebuild'], consumer, acceptanceEnv);
  run(kudosBin, ['export', '--format', 'jsonl'], consumer, acceptanceEnv);
  const retry = JSON.parse(run(kudosBin, giveArgs, consumer, acceptanceEnv));
  if (!retry.deduplicated || retry.record?.event?.id !== kudosId) {
    throw new Error('Acceptance retry did not return the original kudos.');
  }
  if (!existsSync(join(acceptanceHome, 'kudos', 'agent-kudos.sqlite3'))) {
    throw new Error('Acceptance database is missing.');
  }
  if (!readFileSync(join(acceptanceHome, 'codex', 'WINS.md'), 'utf8').includes(kudosId)) {
    throw new Error('Acceptance projection is missing.');
  }
  process.stdout.write(`Package smoke test passed: ${packed.filename} (${names.length} files)\n`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
