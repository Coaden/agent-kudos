#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Command, CommanderError, Option } from 'commander';
import { KudosClient } from './client.js';
import { asKudosError, KudosError, type KudosErrorCode } from './errors.js';
import { atomicWriteFile } from './fs-utils.js';
import { startMcpServer } from './mcp/index.js';
import {
  formatSkillResult,
  installSkill,
  skillStatus,
  uninstallSkill,
  type SkillRuntime,
} from './skill-install.js';
import type {
  ActorIdentity,
  EvidenceReference,
  KudosListInput,
  KudosRecord,
  KudosSummary,
} from './types.js';
import { packageVersion } from './version.js';

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const defaultIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

const cliExitCodes = new WeakMap<Command, number>();

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function skillRuntimes(values: string[]): SkillRuntime[] | undefined {
  const invalid = values.find(
    (value) => value !== 'codex' && value !== 'claude' && value !== 'all',
  );
  if (invalid) {
    throw new KudosError('INVALID_INPUT', `Unsupported skill runtime: ${invalid}.`);
  }
  if (!values.length || values.includes('all')) return undefined;
  return values as SkillRuntime[];
}

function parseEvidence(value: string): EvidenceReference {
  const separator = value.indexOf(':');
  if (separator < 1 || separator === value.length - 1) {
    throw new KudosError('INVALID_INPUT', 'Evidence must use kind:value syntax.');
  }
  return {
    kind: value.slice(0, separator) as EvidenceReference['kind'],
    value: value.slice(separator + 1),
  };
}

function actor(kind: string, id: string, displayName?: string): ActorIdentity {
  return {
    kind: kind as ActorIdentity['kind'],
    id,
    ...(displayName ? { displayName } : {}),
  };
}

function exitCode(code: KudosErrorCode): number {
  if (code === 'AGENT_NOT_FOUND' || code === 'KUDOS_NOT_FOUND') return 3;
  if (code.endsWith('_FORBIDDEN') || code === 'READ_ONLY') return 4;
  if (code.startsWith('DATABASE_') || code === 'UNSUPPORTED_SCHEMA' || code === 'UNSUPPORTED_EVENT')
    return 5;
  if (code === 'INTERNAL_ERROR') return 1;
  return 2;
}

function lineForSummary(record: KudosSummary): string {
  const state =
    record.revocationStatus === 'revoked'
      ? 'revoked'
      : record.status === 'acknowledged'
        ? 'acknowledged'
        : 'new';
  return `${record.id}  ${record.createdAt.slice(0, 10)}  ${record.recipientAgentId}  [${state}]  ${record.title}`;
}

function showRecord(record: KudosRecord): string {
  const event = record.event;
  const evidence = event.evidence?.map((item) => `  - ${item.kind}: ${item.value}`).join('\n');
  return [
    event.title,
    `ID: ${event.id}`,
    `Recipient: ${event.recipientDisplayName} (${event.recipientAgentId})`,
    `From: ${event.actor.displayName ?? event.actor.id} (${event.actor.kind}:${event.actor.id})`,
    `Date: ${event.createdAt}`,
    `Visibility: ${event.visibility}`,
    `Status: ${record.status}`,
    `Revocation: ${record.revocationStatus}`,
    event.tags?.length ? `Tags: ${event.tags.join(', ')}` : undefined,
    '',
    event.reason,
    evidence ? `\nEvidence:\n${evidence}` : undefined,
    record.acknowledgment?.note ? `\nAcknowledgment: ${record.acknowledgment.note}` : undefined,
    record.revocation ? `\nRevoked: ${record.revocation.reason}` : undefined,
  ]
    .filter((value) => value !== undefined)
    .join('\n');
}

function output(io: CliIo, json: boolean, value: unknown, human: string): void {
  io.stdout(json ? `${JSON.stringify(value, null, 2)}\n` : `${human}\n`);
}

function globals(command: Command): { home?: string; json: boolean } {
  return command.optsWithGlobals<{ home?: string; json: boolean }>();
}

async function withClient<T>(
  home: string | undefined,
  configuredActor: ActorIdentity,
  operation: (client: KudosClient) => Promise<T>,
): Promise<T> {
  const client = new KudosClient({ ...(home ? { home } : {}), actor: configuredActor });
  await client.init();
  try {
    return await operation(client);
  } finally {
    await client.close();
  }
}

function addListOptions(command: Command): Command {
  return command
    .option('--recipient <agent>')
    .option('--actor <id>')
    .option('--actor-kind <kind>', 'human, agent, or system')
    .option('--tag <tag>')
    .option('--status <status>', 'acknowledged or unacknowledged')
    .option('--visibility <visibility>', 'private, local, or public')
    .addOption(
      new Option('--revoked <state>').choices(['include', 'only', 'exclude']).default('include'),
    )
    .option('--from-date <iso>')
    .option('--to-date <iso>')
    .option('--limit <number>', 'maximum results (default 10, maximum 50)', '10')
    .option('--cursor <cursor>', 'opaque cursor returned by the previous page')
    .option('--offset <number>', 'pagination offset', '0');
}

function listInput(options: Record<string, string>): KudosListInput {
  return {
    ...(options.recipient ? { recipientAgentId: options.recipient } : {}),
    ...(options.actor ? { actorId: options.actor } : {}),
    ...(options.actorKind ? { actorKind: options.actorKind as KudosListInput['actorKind'] } : {}),
    ...(options.tag ? { tag: options.tag } : {}),
    ...(options.status ? { status: options.status as KudosListInput['status'] } : {}),
    ...(options.visibility
      ? { visibility: options.visibility as KudosListInput['visibility'] }
      : {}),
    ...(options.revoked === 'only' ? { revoked: true } : {}),
    ...(options.revoked === 'exclude' ? { revoked: false } : {}),
    ...(options.fromDate ? { from: options.fromDate } : {}),
    ...(options.toDate ? { to: options.toDate } : {}),
    ...(options.cursor ? { cursor: options.cursor } : {}),
    limit: Number(options.limit),
    offset: Number(options.offset),
  };
}

export function createCli(io: CliIo = defaultIo): Command {
  const program = new Command();
  cliExitCodes.set(program, 0);
  program
    .name('kudos')
    .description('Local-first recognition and accomplishment infrastructure for AI agents')
    .version(packageVersion())
    .option('--home <path>', 'storage root (defaults to AGENT_KUDOS_HOME or ~/.agents)')
    .option('--json', 'emit stable machine-readable JSON', false)
    .showSuggestionAfterError()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr });

  program
    .command('init')
    .description('Initialize the local Agent Kudos database')
    .action(async (_options, command: Command) => {
      const options = globals(command);
      await withClient(options.home, actor('system', 'cli'), (client) => {
        output(
          io,
          options.json,
          { home: client.home, database: client.storage.databasePath },
          `Initialized Agent Kudos at ${client.home}`,
        );
        return Promise.resolve();
      });
    });

  const agentCommand = program
    .command('agent')
    .description('Create and inspect stable agent identities');
  agentCommand
    .command('create <id>')
    .description('Create a stable agent profile')
    .requiredOption('--name <display-name>', 'display name')
    .option('--alias <id>', 'alias (repeatable)', collect, [])
    .option('--description <text>')
    .action(
      async (
        id: string,
        options: { name: string; alias: string[]; description?: string },
        command: Command,
      ) => {
        const global = globals(command);
        const profile = await withClient(global.home, actor('system', 'cli'), (client) =>
          client.agents.create({
            id,
            displayName: options.name,
            ...(options.alias.length ? { aliases: options.alias } : {}),
            ...(options.description ? { description: options.description } : {}),
          }),
        );
        output(io, global.json, profile, `Created ${profile.displayName} (${profile.id})`);
      },
    );

  const skillCommand = program
    .command('skill')
    .description('Install and maintain the packaged agent skill');

  skillCommand
    .command('install')
    .description('Plan or install the skill for detected agent runtimes')
    .option('--runtime <runtime>', 'codex, claude, or all (repeatable)', collect, [])
    .option('--yes', 'apply the displayed plan', false)
    .option('--force', 'replace a conflicting agent-kudos directory', false)
    .option('--link', 'symlink to the packaged skill instead of copying it', false)
    .option('--actor-id <id>', 'print actor-bound MCP registration commands')
    .option('--actor-name <name>', 'display name used in MCP registration commands')
    .action(
      (
        options: {
          runtime: string[];
          yes: boolean;
          force: boolean;
          link: boolean;
          actorId?: string;
          actorName?: string;
        },
        command: Command,
      ) => {
        const global = globals(command);
        const result = installSkill({
          runtimes: skillRuntimes(options.runtime),
          apply: options.yes,
          force: options.force,
          link: options.link,
          actorId: options.actorId,
          actorName: options.actorName,
        });
        output(io, global.json, result, formatSkillResult(result, 'install'));
      },
    );

  skillCommand
    .command('status')
    .description('Show installed, stale, missing, or conflicting skill copies')
    .option('--runtime <runtime>', 'codex, claude, or all (repeatable)', collect, [])
    .option('--actor-id <id>', 'print actor-bound MCP registration commands')
    .option('--actor-name <name>', 'display name used in MCP registration commands')
    .action(
      (options: { runtime: string[]; actorId?: string; actorName?: string }, command: Command) => {
        const global = globals(command);
        const result = skillStatus({
          runtimes: skillRuntimes(options.runtime),
          actorId: options.actorId,
          actorName: options.actorName,
        });
        output(io, global.json, result, formatSkillResult(result, 'status'));
      },
    );

  skillCommand
    .command('uninstall')
    .description('Plan or remove Agent Kudos-owned skill installations')
    .option('--runtime <runtime>', 'codex, claude, or all (repeatable)', collect, [])
    .option('--yes', 'apply the displayed plan', false)
    .option('--force', 'remove a conflicting agent-kudos directory', false)
    .action((options: { runtime: string[]; yes: boolean; force: boolean }, command: Command) => {
      const global = globals(command);
      const result = uninstallSkill({
        runtimes: skillRuntimes(options.runtime),
        apply: options.yes,
        force: options.force,
      });
      output(io, global.json, result, formatSkillResult(result, 'uninstall'));
    });

  agentCommand
    .command('list')
    .description('List known agent identities')
    .action(async (_options, command: Command) => {
      const global = globals(command);
      const agents = await withClient(global.home, actor('system', 'cli'), (client) =>
        client.agents.list(),
      );
      const human = agents.length
        ? agents
            .map(
              (profile) =>
                `${profile.id}  ${profile.displayName}${profile.aliases?.length ? `  aliases: ${profile.aliases.join(', ')}` : ''}`,
            )
            .join('\n')
        : 'No agents configured.';
      output(io, global.json, { agents }, human);
    });

  agentCommand
    .command('show <id>')
    .description('Show one agent profile, resolving aliases')
    .action(async (id: string, _options, command: Command) => {
      const global = globals(command);
      const profile = await withClient(global.home, actor('system', 'cli'), (client) =>
        client.agents.get(id),
      );
      output(
        io,
        global.json,
        profile,
        `${profile.displayName} (${profile.id})\n${profile.description ?? 'No description.'}`,
      );
    });

  agentCommand
    .command('update <id>')
    .description('Update an agent profile without rewriting history')
    .option('--name <display-name>')
    .option('--alias <id>', 'replace aliases (repeatable)', collect, [])
    .option('--clear-aliases', 'remove every alias', false)
    .option('--description <text>')
    .action(
      async (
        id: string,
        options: { name?: string; alias: string[]; clearAliases: boolean; description?: string },
        command: Command,
      ) => {
        const global = globals(command);
        const hasAliases = options.clearAliases || options.alias.length > 0;
        const profile = await withClient(global.home, actor('system', 'cli'), (client) =>
          client.agents.update(id, {
            ...(options.name ? { displayName: options.name } : {}),
            ...(hasAliases ? { aliases: options.clearAliases ? [] : options.alias } : {}),
            ...(options.description !== undefined ? { description: options.description } : {}),
          }),
        );
        output(io, global.json, profile, `Updated ${profile.displayName} (${profile.id})`);
      },
    );

  program
    .command('give <recipient>')
    .description('Give specific, evidence-based kudos to an agent')
    .requiredOption('--from <actor-id>', 'stable ID of the giver')
    .requiredOption('--actor-kind <kind>', 'human, agent, or system')
    .option('--actor-name <display-name>')
    .requiredOption('--title <title>')
    .requiredOption('--reason <reason>')
    .option('--tag <tag>', 'tag (repeatable)', collect, [])
    .option('--evidence <kind:value>', 'sanitized evidence (repeatable)', collect, [])
    .option('--visibility <visibility>', 'private, local, or public', 'local')
    .option('--idempotency-key <key>')
    .action(
      async (
        recipient: string,
        options: {
          from: string;
          actorKind: string;
          actorName?: string;
          title: string;
          reason: string;
          tag: string[];
          evidence: string[];
          visibility: 'private' | 'local' | 'public';
          idempotencyKey?: string;
        },
        command: Command,
      ) => {
        const global = globals(command);
        const result = await withClient(
          global.home,
          actor(options.actorKind, options.from, options.actorName),
          (client) =>
            client.kudos.give({
              recipientAgentId: recipient,
              title: options.title,
              reason: options.reason,
              visibility: options.visibility,
              ...(options.tag.length ? { tags: options.tag } : {}),
              ...(options.evidence.length ? { evidence: options.evidence.map(parseEvidence) } : {}),
              ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
            }),
        );
        const event = result.record.event;
        output(
          io,
          global.json,
          result,
          `${result.deduplicated ? 'Found existing' : 'Created'} kudos for ${event.recipientDisplayName}\nTitle: ${event.title}\nDate: ${event.createdAt}\nID: ${event.id}`,
        );
      },
    );

  program
    .command('inbox [agent]')
    .description('Show unacknowledged, active kudos for an agent')
    .option('--as <agent-id>', 'defaults to the positional agent')
    .option('--limit <number>', 'maximum results (default 10, maximum 50)', '10')
    .option('--cursor <cursor>', 'opaque cursor returned by the previous page')
    .action(
      async (
        agentId: string | undefined,
        options: { as?: string; limit: string; cursor?: string },
        command: Command,
      ) => {
        const global = globals(command);
        const recipient = agentId ?? options.as;
        if (!recipient) throw new KudosError('INVALID_INPUT', 'Specify an agent inbox.');
        const page = await withClient(
          global.home,
          actor('agent', options.as ?? recipient),
          (client) =>
            client.kudos.list({
              recipientAgentId: recipient,
              status: 'unacknowledged',
              revoked: false,
              limit: Number(options.limit),
              ...(options.cursor ? { cursor: options.cursor } : {}),
            }),
        );
        output(
          io,
          global.json,
          page,
          page.items.length
            ? `${page.items.map(lineForSummary).join('\n')}${page.hasMore ? `\nNext cursor: ${page.nextCursor}` : ''}`
            : 'Inbox is clear.',
        );
      },
    );

  addListOptions(program.command('list').description('List and filter kudos')).action(
    async (options: Record<string, string>, command: Command) => {
      const global = globals(command);
      const page = await withClient(global.home, actor('human', 'local-cli'), (client) =>
        client.kudos.list(listInput(options)),
      );
      output(
        io,
        global.json,
        page,
        page.items.length
          ? `${page.items.map(lineForSummary).join('\n')}${page.hasMore ? `\nNext cursor: ${page.nextCursor}` : ''}`
          : 'No kudos found.',
      );
    },
  );

  program
    .command('changes')
    .description('List compact kudos changes after an opaque watermark')
    .option('--after <watermark>', 'watermark or change cursor from a previous response')
    .option('--limit <number>', 'maximum changes (default 20, maximum 100)', '20')
    .action(async (options: { after?: string; limit: string }, command: Command) => {
      const global = globals(command);
      const page = await withClient(global.home, actor('human', 'local-cli'), (client) =>
        client.kudos.changes({
          limit: Number(options.limit),
          ...(options.after ? { after: options.after } : {}),
        }),
      );
      const human = page.items.length
        ? `${page.items
            .map(
              (change) =>
                `${change.sequence}  ${change.createdAt}  ${change.type}  ${change.kudosId ?? '-'}`,
            )
            .join('\n')}\nWatermark: ${page.nextCursor}`
        : `No new kudos changes. Watermark: ${page.watermark}`;
      output(io, global.json, page, human);
    });

  program
    .command('show <kudos-id>')
    .description('Show one kudos item and its current state')
    .action(async (id: string, _options, command: Command) => {
      const global = globals(command);
      const record = await withClient(global.home, actor('system', 'cli'), (client) =>
        client.kudos.get(id),
      );
      output(io, global.json, record, showRecord(record));
    });

  program
    .command('acknowledge <kudos-id>')
    .description('Record that a recipient reviewed kudos')
    .requiredOption('--as <agent-id>', 'recipient agent identity')
    .option('--actor-kind <kind>', 'agent, human, or system', 'agent')
    .option('--name <display-name>')
    .option('--note <text>')
    .action(
      async (
        id: string,
        options: { as: string; actorKind: string; name?: string; note?: string },
        command: Command,
      ) => {
        const global = globals(command);
        const record = await withClient(
          global.home,
          actor(options.actorKind, options.as, options.name),
          (client) =>
            client.kudos.acknowledge({
              kudosId: id,
              ...(options.note ? { note: options.note } : {}),
            }),
        );
        output(io, global.json, record, `Acknowledged ${id} as ${options.as}.`);
      },
    );

  program
    .command('revoke <kudos-id>')
    .description('Record a revocation while preserving history')
    .requiredOption('--as <actor-id>')
    .option('--actor-kind <kind>', 'human, agent, or system', 'human')
    .requiredOption('--reason <reason>')
    .option('--administrative', 'mark as an administrative revocation', false)
    .action(
      async (
        id: string,
        options: { as: string; actorKind: string; reason: string; administrative: boolean },
        command: Command,
      ) => {
        const global = globals(command);
        const record = await withClient(
          global.home,
          actor(options.actorKind, options.as),
          (client) =>
            client.kudos.revoke({
              kudosId: id,
              reason: options.reason,
              administrative: options.administrative,
            }),
        );
        output(io, global.json, record, `Revoked ${id}; the audit trail was preserved.`);
      },
    );

  program
    .command('wins [agent]')
    .description('Print the generated WINS.md path or content')
    .option('--open', 'open WINS.md in the system GUI', false)
    .option('--print', 'print Markdown content', false)
    .action(
      async (
        agentId: string | undefined,
        options: { open: boolean; print: boolean },
        command: Command,
      ) => {
        const global = globals(command);
        if (!agentId) throw new KudosError('INVALID_INPUT', 'Specify an agent.');
        const details = await withClient(global.home, actor('system', 'cli'), async (client) => {
          const profile = await client.agents.get(agentId);
          const path = join(client.home, profile.id, 'WINS.md');
          if (!existsSync(path)) {
            const hint = client.storage.config.projection.writeWinsMarkdown
              ? 'Run `kudos rebuild` to generate it.'
              : 'Enable projection.writeWinsMarkdown and run `kudos rebuild`.';
            throw new KudosError(
              'INVALID_INPUT',
              `No generated WINS.md exists for ${profile.id}. ${hint}`,
            );
          }
          return { profile, path, content: readFileSync(path, 'utf8') };
        });
        if (options.open) {
          const commandName =
            process.platform === 'darwin'
              ? 'open'
              : process.platform === 'win32'
                ? 'cmd'
                : 'xdg-open';
          const args =
            process.platform === 'win32' ? ['/c', 'start', '', details.path] : [details.path];
          spawn(commandName, args, { detached: true, stdio: 'ignore' }).unref();
        }
        output(io, global.json, details, options.print ? details.content.trimEnd() : details.path);
      },
    );

  addListOptions(program.command('stats').description('Show aggregate kudos statistics')).action(
    async (options: Record<string, string>, command: Command) => {
      const global = globals(command);
      const stats = await withClient(global.home, actor('system', 'cli'), (client) =>
        client.stats(listInput(options)),
      );
      output(
        io,
        global.json,
        stats,
        `Total: ${stats.total}\nActive: ${stats.active}\nAcknowledged: ${stats.acknowledged}\nRevoked: ${stats.revoked}`,
      );
    },
  );

  program
    .command('rebuild')
    .description('Regenerate current-state and filesystem projections from canonical events')
    .action(async (_options, command: Command) => {
      const global = globals(command);
      const result = await withClient(global.home, actor('system', 'cli'), (client) =>
        Promise.resolve(client.projections.rebuild()),
      );
      output(
        io,
        global.json,
        result,
        `Rebuilt ${result.generated.length} file(s); removed ${result.removed.length} stale file(s).`,
      );
    });

  program
    .command('backup <destination>')
    .description('Create a transactionally consistent SQLite backup')
    .action(async (destination: string, _options, command: Command) => {
      const global = globals(command);
      const path = await withClient(global.home, actor('system', 'cli'), (client) =>
        client.backup(destination),
      );
      output(io, global.json, { path }, `Created backup at ${path}`);
    });

  program
    .command('export')
    .description('Export canonical events for portability')
    .addOption(
      new Option('--format <format>').choices(['json', 'jsonl', 'markdown']).default('json'),
    )
    .option('--output <path>', 'write to an explicit destination instead of stdout')
    .action(
      async (
        options: { format: 'json' | 'jsonl' | 'markdown'; output?: string },
        command: Command,
      ) => {
        const global = globals(command);
        const content = await withClient(global.home, actor('system', 'cli'), (client) =>
          client.export(options.format),
        );
        if (options.output) {
          const destination = resolve(options.output);
          atomicWriteFile(destination, content, 0o600);
          output(
            io,
            global.json,
            { path: destination, format: options.format },
            `Exported ${options.format} to ${destination}`,
          );
        } else {
          io.stdout(content);
        }
      },
    );

  program
    .command('doctor')
    .description('Run safe diagnostics')
    .action(async (_options, command: Command) => {
      const global = globals(command);
      const result = await withClient(global.home, actor('system', 'cli'), (client) =>
        client.doctor(),
      );
      const human = result.diagnostics
        .map((item) => `${item.level.toUpperCase().padEnd(7)} ${item.code}: ${item.message}`)
        .join('\n');
      output(io, global.json, result, human);
      if (!result.healthy) cliExitCodes.set(program, 5);
    });

  program
    .command('mcp')
    .description('Run the actor-bound MCP server over stdio')
    .requiredOption('--actor-id <id>')
    .requiredOption('--actor-kind <kind>', 'human, agent, or system')
    .option('--actor-name <display-name>')
    .action(
      async (
        options: { actorId: string; actorKind: string; actorName?: string },
        command: Command,
      ) => {
        const global = globals(command);
        await startMcpServer({
          ...(global.home ? { home: global.home } : {}),
          actor: actor(options.actorKind, options.actorId, options.actorName),
        });
      },
    );

  return program;
}

export async function runCli(argv = process.argv, io: CliIo = defaultIo): Promise<number> {
  const program = createCli(io);
  program.exitOverride();
  try {
    await program.parseAsync(argv);
    return cliExitCodes.get(program) ?? 0;
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return 0;
    if (error instanceof CommanderError) {
      if (!error.message.startsWith('error:')) io.stderr(`${error.message}\n`);
      return 2;
    }
    const kudosError = asKudosError(error);
    const json = argv.includes('--json');
    io.stderr(
      json
        ? `${JSON.stringify({ ok: false, error: { code: kudosError.code, message: kudosError.message } })}\n`
        : `Error [${kudosError.code}]: ${kudosError.message}\n`,
    );
    return exitCode(kudosError.code);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await runCli();
}
