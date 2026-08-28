import { describe, expect, it } from 'vitest';
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
});
