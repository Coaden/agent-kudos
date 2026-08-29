import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { KudosClient } from '../src/client.js';
import { runCli, type CliIo } from '../src/cli.js';
import { tempHome } from './helpers.js';

function capture(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) },
    stdout,
    stderr,
  };
}

describe('CLI', () => {
  it('provides useful help', async () => {
    const captured = capture();
    expect(await runCli(['node', 'kudos', '--help'], captured.io)).toBe(0);
    expect(captured.stdout.join('')).toContain('Local-first recognition');
    expect(captured.stdout.join('')).toContain('give');
    expect(captured.stdout.join('')).toContain('skill');
  });

  it('rejects unsupported skill runtimes', async () => {
    const captured = capture();
    expect(
      await runCli(
        ['node', 'kudos', 'skill', 'install', '--runtime', 'unverified-runtime'],
        captured.io,
      ),
    ).toBe(2);
    expect(captured.stderr.join('')).toContain('Unsupported skill runtime');
  });

  it('emits human and JSON output and stable exit codes', async () => {
    const home = tempHome();
    let captured = capture();
    expect(await runCli(['node', 'kudos', '--home', home, 'init'], captured.io)).toBe(0);
    expect(captured.stdout.join('')).toContain('Initialized Agent Kudos');

    captured = capture();
    expect(
      await runCli(
        ['node', 'kudos', '--home', home, 'agent', 'create', 'codex', '--name', 'Codex', '--json'],
        captured.io,
      ),
    ).toBe(0);
    expect(JSON.parse(captured.stdout.join(''))).toMatchObject({
      id: 'codex',
      displayName: 'Codex',
    });

    captured = capture();
    expect(
      await runCli(
        [
          'node',
          'kudos',
          '--home',
          home,
          'give',
          'missing',
          '--from',
          'troy',
          '--actor-kind',
          'human',
          '--title',
          'No recipient',
          '--reason',
          'This identity does not exist.',
          '--json',
        ],
        captured.io,
      ),
    ).toBe(3);
    expect(JSON.parse(captured.stderr.join(''))).toMatchObject({
      error: { code: 'AGENT_NOT_FOUND' },
    });
  });

  it('does not leak a prior process exit code into a successful invocation', async () => {
    const prior = process.exitCode;
    process.exitCode = 5;
    try {
      const captured = capture();
      expect(await runCli(['node', 'kudos', '--help'], captured.io)).toBe(0);
    } finally {
      process.exitCode = prior;
    }
  });

  it('keeps doctor failure status local to that invocation', async () => {
    const home = tempHome();
    const client = new KudosClient({ home, actor: { kind: 'human', id: 'troy' } });
    await client.init();
    await client.agents.create({ id: 'codex', displayName: 'Codex' });
    client.storage
      .db()
      .prepare(
        `INSERT INTO events(id, schema_version, type, created_at, actor_kind, actor_id, payload, sequence)
         VALUES (?, 1, 'future', ?, 'system', 'future', ?,
           (SELECT COALESCE(MAX(sequence), 0) + 1 FROM events))`,
      )
      .run(
        '01ARZ3NDEKTSV4RRFFQ69G5FAB',
        new Date().toISOString(),
        JSON.stringify({ schemaVersion: 1, type: 'future' }),
      );
    await client.close();

    let captured = capture();
    expect(await runCli(['node', 'kudos', '--home', home, 'doctor'], captured.io)).toBe(5);
    captured = capture();
    expect(await runCli(['node', 'kudos', '--home', home, 'agent', 'list'], captured.io)).toBe(0);
    expect(captured.stdout.join('')).toContain('codex');
  });

  it('returns a useful error when WINS.md generation is disabled', async () => {
    const home = tempHome();
    const client = new KudosClient({
      home,
      actor: { kind: 'human', id: 'troy' },
      config: { projection: { writeWinsMarkdown: false } },
    });
    await client.init();
    await client.agents.create({ id: 'codex', displayName: 'Codex' });
    await client.close();

    const captured = capture();
    expect(
      await runCli(['node', 'kudos', '--home', home, 'wins', 'codex', '--print'], captured.io),
    ).toBe(2);
    expect(captured.stderr.join('')).toContain('Enable projection.writeWinsMarkdown');
    expect(captured.stderr.join('')).not.toContain(`${home}/codex/WINS.md`);
  });

  it('exercises the complete local administration and recognition workflow', async () => {
    const home = tempHome();
    const invoke = async (args: string[]) => {
      const captured = capture();
      const code = await runCli(['node', 'kudos', '--home', home, ...args], captured.io);
      expect(code, captured.stderr.join('')).toBe(0);
      return captured.stdout.join('');
    };

    await invoke(['init']);
    await invoke(['agent', 'create', 'codex', '--name', 'Codex', '--alias', 'reviewer']);
    await invoke(['agent', 'create', 'gracie', '--name', 'Gracie']);
    expect(await invoke(['agent', 'list'])).toContain('codex');
    expect(await invoke(['agent', 'show', 'reviewer'])).toContain('Codex');
    await invoke(['agent', 'update', 'codex', '--description', 'Careful reviewer']);

    const given = JSON.parse(
      await invoke([
        'give',
        'codex',
        '--from',
        'gracie',
        '--actor-kind',
        'agent',
        '--title',
        'Complete review',
        '--reason',
        'Found and explained a release-blocking problem.',
        '--tag',
        'review',
        '--evidence',
        'task:review-1',
        '--idempotency-key',
        'cli-flow-1',
        '--json',
      ]),
    ) as { record: { event: { id: string } } };
    const id = given.record.event.id;
    expect(await invoke(['inbox', 'codex'])).toContain(id);
    expect(await invoke(['list', '--tag', 'review'])).toContain(id);
    const compact = JSON.parse(await invoke(['list', '--tag', 'review', '--json'])) as {
      items: Array<Record<string, unknown>>;
      limit: number;
    };
    expect(compact.limit).toBe(10);
    expect(compact.items[0]).not.toHaveProperty('reason');
    expect(await invoke(['changes'])).toContain('kudos.given');
    expect(await invoke(['show', id])).toContain('Complete review');
    expect(await invoke(['wins', 'codex', '--print'])).toContain(id);
    await invoke(['acknowledge', id, '--as', 'codex', '--note', 'Reviewed.']);
    expect(await invoke(['stats'])).toContain('Acknowledged: 1');
    await invoke([
      'revoke',
      id,
      '--as',
      'gracie',
      '--actor-kind',
      'agent',
      '--reason',
      'Corrected.',
    ]);
    await invoke(['rebuild']);
    expect(await invoke(['doctor'])).toContain('EVENTS_VALID');

    const output = join(tempHome(), 'events.jsonl');
    await invoke(['export', '--format', 'jsonl', '--output', output]);
    const backup = join(tempHome(), 'backup.sqlite3');
    await invoke(['backup', backup]);
  });
});
