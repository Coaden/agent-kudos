import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';
import { KudosError } from './errors.js';
import type { AgentKudosConfig, AgentKudosConfigOverrides } from './types.js';

export const defaultConfig: AgentKudosConfig = {
  schemaVersion: 1,
  defaultVisibility: 'local',
  allowSelfAwards: false,
  allowAgentCreationViaMcp: false,
  allowRebuildViaMcp: false,
  includePrivateInStats: false,
  projection: {
    writeWinsMarkdown: true,
    writeInboxEntries: true,
  },
};

export const configSchema = z.object({
  schemaVersion: z.literal(1),
  defaultVisibility: z.enum(['private', 'local', 'public']),
  allowSelfAwards: z.boolean(),
  allowAgentCreationViaMcp: z.boolean(),
  allowRebuildViaMcp: z.boolean(),
  includePrivateInStats: z.boolean(),
  projection: z.object({
    writeWinsMarkdown: z.boolean(),
    writeInboxEntries: z.boolean(),
  }),
});

export function resolveHome(explicitHome?: string): string {
  const candidate = explicitHome ?? process.env.AGENT_KUDOS_HOME ?? resolve(homedir(), '.agents');
  if (candidate.includes('\0')) throw new KudosError('UNSAFE_PATH', 'Storage home contains NUL.');
  return resolve(candidate);
}

export function mergeConfig(
  fileConfig: unknown,
  explicit?: AgentKudosConfigOverrides,
): AgentKudosConfig {
  const parsedFile =
    fileConfig === undefined
      ? { success: true as const, data: defaultConfig }
      : configSchema.safeParse(fileConfig);
  if (!parsedFile.success) {
    throw new KudosError('CONFIG_INVALID', 'Agent Kudos configuration file is invalid.', {
      issues: parsedFile.error.issues,
    });
  }
  const fromFile = parsedFile.data;
  const fromEnvironment = environmentConfig();
  const merged: AgentKudosConfig = {
    ...fromFile,
    ...fromEnvironment,
    ...explicit,
    projection: {
      ...fromFile.projection,
      ...fromEnvironment.projection,
      ...explicit?.projection,
    },
    schemaVersion: 1,
  };
  const result = configSchema.safeParse(merged);
  if (!result.success) {
    throw new KudosError('CONFIG_INVALID', 'Agent Kudos configuration is invalid.', {
      issues: result.error.issues,
    });
  }
  return result.data;
}

function optionalBoolean(name: string): boolean | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new KudosError('CONFIG_INVALID', `${name} must be true or false.`);
}

function environmentConfig(): AgentKudosConfigOverrides {
  const visibility = process.env.AGENT_KUDOS_DEFAULT_VISIBILITY;
  if (visibility && !['private', 'local', 'public'].includes(visibility)) {
    throw new KudosError(
      'CONFIG_INVALID',
      'AGENT_KUDOS_DEFAULT_VISIBILITY must be private, local, or public.',
    );
  }

  const writeWinsMarkdown = optionalBoolean('AGENT_KUDOS_WRITE_WINS_MARKDOWN');
  const writeInboxEntries = optionalBoolean('AGENT_KUDOS_WRITE_INBOX_ENTRIES');
  const allowSelfAwards = optionalBoolean('AGENT_KUDOS_ALLOW_SELF_AWARDS');
  const allowAgentCreationViaMcp = optionalBoolean('AGENT_KUDOS_ALLOW_AGENT_CREATION_VIA_MCP');
  const allowRebuildViaMcp = optionalBoolean('AGENT_KUDOS_ALLOW_REBUILD_VIA_MCP');
  const includePrivateInStats = optionalBoolean('AGENT_KUDOS_INCLUDE_PRIVATE_IN_STATS');
  const projection = {
    ...(writeWinsMarkdown !== undefined ? { writeWinsMarkdown } : {}),
    ...(writeInboxEntries !== undefined ? { writeInboxEntries } : {}),
  };

  return {
    ...(visibility
      ? { defaultVisibility: visibility as AgentKudosConfig['defaultVisibility'] }
      : {}),
    ...(allowSelfAwards !== undefined ? { allowSelfAwards } : {}),
    ...(allowAgentCreationViaMcp !== undefined ? { allowAgentCreationViaMcp } : {}),
    ...(allowRebuildViaMcp !== undefined ? { allowRebuildViaMcp } : {}),
    ...(includePrivateInStats !== undefined ? { includePrivateInStats } : {}),
    ...(Object.keys(projection).length ? { projection } : {}),
  };
}
