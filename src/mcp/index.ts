import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { KudosClient } from '../client.js';
import { KudosError, asKudosError } from '../errors.js';
import {
  actorSchema,
  agentIdSchema,
  changesInputSchema,
  giveKudosMcpSchema,
  listInputSchema,
} from '../schemas.js';
import { packageVersion } from '../version.js';
import type { ActorIdentity, KudosClientOptions, KudosRecord } from '../types.js';

export interface AgentKudosMcpOptions extends Omit<KudosClientOptions, 'actor'> {
  actor: ActorIdentity;
}

const outputSchema = z.object({
  ok: z.boolean(),
  actor: actorSchema,
  message: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
  errorCode: z.string().optional(),
});

function dataRecord(value: unknown): Record<string, unknown> {
  const normalized = JSON.parse(JSON.stringify(value)) as unknown;
  return typeof normalized === 'object' && normalized !== null && !Array.isArray(normalized)
    ? (normalized as Record<string, unknown>)
    : { value: normalized };
}

function success(actor: ActorIdentity, message: string, data: unknown): CallToolResult {
  const structuredContent = { ok: true, actor, message, data: dataRecord(data) };
  return {
    content: [{ type: 'text', text: message }],
    structuredContent,
  };
}

function failure(actor: ActorIdentity, error: unknown): CallToolResult {
  const kudosError = asKudosError(error);
  const structuredContent = {
    ok: false,
    actor,
    message: kudosError.message,
    errorCode: kudosError.code,
  };
  return {
    content: [{ type: 'text', text: `${kudosError.code}: ${kudosError.message}` }],
    structuredContent,
    isError: true,
  };
}

function canView(actor: ActorIdentity, record: KudosRecord): boolean {
  if (record.event.visibility !== 'private') return true;
  return (
    actor.kind === 'human' ||
    record.event.recipientAgentId === actor.id ||
    (record.event.actor.kind === actor.kind && record.event.actor.id === actor.id)
  );
}

function describeRecord(record: KudosRecord): string {
  return `${record.event.recipientDisplayName} received “${record.event.title}” on ${record.event.createdAt.slice(0, 10)} (ID ${record.event.id}).`;
}

export interface AgentKudosMcpRuntime {
  server: McpServer;
  client: KudosClient;
  close(): Promise<void>;
}

export async function createAgentKudosMcpServer(
  options: AgentKudosMcpOptions,
): Promise<AgentKudosMcpRuntime> {
  const actor = actorSchema.parse(options.actor);
  const client = new KudosClient({ ...options, actor });
  await client.init();
  const server = new McpServer(
    { name: 'agent-kudos', version: packageVersion() },
    {
      instructions:
        'Record concrete, observed contributions. Do not award routine completion, generic politeness, invented accomplishments, secrets, or self-kudos. The server binds every write to its configured actor.',
    },
  );

  server.registerTool(
    'kudos_give',
    {
      title: 'Give kudos',
      description:
        'Use when a human explicitly requests recognition or a peer agent made a concrete, unusually useful contribution. State what the recipient did and why it mattered. Do not use for routine completion, generic politeness, self-congratulation, invented work, secrets, or raw sensitive tool output.',
      inputSchema: giveKudosMcpSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input) => {
      try {
        const result = await client.kudos.give(input);
        return success(
          actor,
          `${describeRecord(result.record)} ${result.deduplicated ? 'Deduplicated; the original event was returned.' : `Recorded by ${actor.displayName ?? actor.id}.`}`,
          result,
        );
      } catch (error) {
        return failure(actor, error);
      }
    },
  );

  server.registerTool(
    'kudos_list',
    {
      title: 'List kudos',
      description:
        'Return a context-safe page of compact kudos summaries, newest first. The default is 10 and maximum is 50. Use nextCursor for another page and kudos_get only for records whose full reason or evidence is needed.',
      inputSchema: listInputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (input) => {
      try {
        const page = await client.kudos.list(input);
        return success(
          actor,
          `Returned ${page.items.length} of ${page.total} visible kudos summaries${page.hasMore ? '; use nextCursor to continue' : ''}.`,
          page,
        );
      } catch (error) {
        return failure(actor, error);
      }
    },
  );

  server.registerTool(
    'kudos_changes',
    {
      title: 'Get kudos changes',
      description:
        'Return compact kudos changes after an opaque watermark. Persist nextCursor (or watermark when empty) and pass it as after on the next poll. The default is 20 and maximum is 100.',
      inputSchema: changesInputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (input) => {
      try {
        const page = await client.kudos.changes(input);
        return success(
          actor,
          `Returned ${page.items.length} visible kudos change(s)${page.hasMore ? '; use nextCursor to continue' : ''}.`,
          page,
        );
      } catch (error) {
        return failure(actor, error);
      }
    },
  );

  server.registerTool(
    'kudos_get',
    {
      title: 'Get kudos',
      description: 'Use to inspect one kudos item and its acknowledgment or revocation state.',
      inputSchema: z.object({ kudosId: z.string().length(26) }),
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ kudosId }) => {
      try {
        const record = await client.kudos.get(kudosId);
        if (!canView(actor, record))
          throw new KudosError(
            'POLICY_FORBIDDEN',
            'This private kudos item is not visible to the configured actor.',
          );
        return success(actor, describeRecord(record), { record });
      } catch (error) {
        return failure(actor, error);
      }
    },
  );

  server.registerTool(
    'kudos_acknowledge',
    {
      title: 'Acknowledge kudos',
      description:
        'Use when the configured recipient has reviewed received kudos. Acknowledgment records receipt and does not imply agreement with every detail.',
      inputSchema: z.object({
        kudosId: z.string().length(26),
        note: z.string().trim().min(1).max(2000).optional(),
      }),
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (input) => {
      try {
        const record = await client.kudos.acknowledge(input);
        return success(
          actor,
          `Acknowledged kudos ${record.event.id} as ${actor.displayName ?? actor.id}.`,
          {
            record,
          },
        );
      } catch (error) {
        return failure(actor, error);
      }
    },
  );

  server.registerTool(
    'kudos_revoke',
    {
      title: 'Revoke kudos',
      description:
        'Use to record a revocation with a concrete reason. This preserves history and does not delete the original kudos.',
      inputSchema: z.object({
        kudosId: z.string().length(26),
        reason: z.string().trim().min(1).max(2000),
        administrative: z.boolean().default(false),
      }),
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async (input) => {
      try {
        if (input.administrative && actor.kind !== 'human') {
          throw new KudosError(
            'POLICY_FORBIDDEN',
            'Only human actors can request administrative revocation.',
          );
        }
        const record = await client.kudos.revoke(input);
        return success(actor, `Revoked kudos ${record.event.id}; history was preserved.`, {
          record,
        });
      } catch (error) {
        return failure(actor, error);
      }
    },
  );

  server.registerTool(
    'kudos_stats',
    {
      title: 'Kudos statistics',
      description: 'Return aggregate recognition counts without exposing private message content.',
      inputSchema: listInputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (input) => {
      try {
        const stats = await client.stats(input);
        return success(actor, `Computed statistics for ${stats.total} kudos item(s).`, { stats });
      } catch (error) {
        return failure(actor, error);
      }
    },
  );

  server.registerTool(
    'kudos_agent_create',
    {
      title: 'Create agent identity',
      description:
        'Administrative tool for creating a stable agent identity. Disabled by default so runtime agents cannot silently create identities.',
      inputSchema: z.object({
        id: agentIdSchema,
        displayName: z.string().trim().min(1).max(200),
        aliases: z.array(agentIdSchema).max(50).optional(),
        description: z.string().trim().max(2000).optional(),
      }),
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input) => {
      try {
        if (!client.storage.config.allowAgentCreationViaMcp) {
          throw new KudosError(
            'POLICY_FORBIDDEN',
            'Agent creation via MCP is disabled by configuration.',
          );
        }
        const profile = await client.agents.create(input);
        return success(actor, `Created agent ${profile.displayName} (${profile.id}).`, { profile });
      } catch (error) {
        return failure(actor, error);
      }
    },
  );

  server.registerTool(
    'kudos_agent_list',
    {
      title: 'List agent identities',
      description: 'List known stable agent identities and aliases. This is read-only.',
      inputSchema: z.object({}),
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () => {
      try {
        const agents = await client.agents.list();
        return success(actor, `Found ${agents.length} agent identity or identities.`, { agents });
      } catch (error) {
        return failure(actor, error);
      }
    },
  );

  server.registerTool(
    'kudos_rebuild',
    {
      title: 'Rebuild projections',
      description:
        'Administrative operation that deterministically regenerates the SQLite current-state index, WINS.md, and inbox projections.',
      inputSchema: z.object({}),
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    () => {
      try {
        if (!client.storage.config.allowRebuildViaMcp) {
          throw new KudosError(
            'POLICY_FORBIDDEN',
            'Projection rebuild via MCP is disabled by configuration.',
          );
        }
        const result = client.projections.rebuild();
        return success(actor, `Rebuilt ${result.generated.length} generated file(s).`, result);
      } catch (error) {
        return failure(actor, error);
      }
    },
  );

  server.registerTool(
    'kudos_doctor',
    {
      title: 'Run Agent Kudos diagnostics',
      description: 'Run safe, read-only database, projection, permission, and path diagnostics.',
      inputSchema: z.object({}),
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () => {
      try {
        const result = await client.doctor();
        return success(
          actor,
          result.healthy ? 'Agent Kudos is healthy.' : 'Agent Kudos found problems.',
          {
            result,
          },
        );
      } catch (error) {
        return failure(actor, error);
      }
    },
  );

  server.registerResource(
    'agents',
    'kudos://agents',
    {
      title: 'Agent identities',
      description: 'Known Agent Kudos identities',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(await client.agents.list(), null, 2),
        },
      ],
    }),
  );

  server.registerResource(
    'agent-profile',
    new ResourceTemplate('kudos://agents/{agentId}/profile', { list: undefined }),
    {
      title: 'Agent profile',
      description: 'One stable agent profile',
      mimeType: 'application/json',
    },
    async (uri, { agentId }) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(await client.agents.get(String(agentId)), null, 2),
        },
      ],
    }),
  );

  server.registerResource(
    'agent-wins',
    new ResourceTemplate('kudos://agents/{agentId}/wins', { list: undefined }),
    {
      title: 'Agent wins',
      description: 'Ten most recent visible, active kudos summaries for one agent',
      mimeType: 'application/json',
    },
    async (uri, { agentId }) => {
      const page = await client.kudos.list({
        recipientAgentId: String(agentId),
        revoked: false,
        limit: 10,
      });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(page, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    'agent-inbox',
    new ResourceTemplate('kudos://agents/{agentId}/inbox', { list: undefined }),
    {
      title: 'Agent inbox',
      description: 'Ten most recent visible, unacknowledged kudos summaries for one agent',
      mimeType: 'application/json',
    },
    async (uri, { agentId }) => {
      const requested = String(agentId);
      const profile = await client.agents.get(requested);
      if (actor.kind === 'agent' && profile.id !== actor.id) {
        throw new KudosError('POLICY_FORBIDDEN', 'An agent may read only its own inbox resource.');
      }
      const page = await client.kudos.list({
        recipientAgentId: profile.id,
        status: 'unacknowledged',
        revoked: false,
        limit: 10,
      });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(page, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    'event',
    new ResourceTemplate('kudos://events/{eventId}', { list: undefined }),
    {
      title: 'Kudos event',
      description: 'One visible canonical event',
      mimeType: 'application/json',
    },
    async (uri, { eventId }) => {
      const event = client.storage.getEvent(String(eventId));
      if (!event) throw new KudosError('KUDOS_NOT_FOUND', `Unknown event: ${String(eventId)}`);
      if (event.type === 'kudos.given') {
        const record = await client.kudos.get(event.id);
        if (!canView(actor, record))
          throw new KudosError('POLICY_FORBIDDEN', 'This event is private.');
      }
      return {
        contents: [
          { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(event, null, 2) },
        ],
      };
    },
  );

  server.registerPrompt(
    'recognize_contribution',
    {
      title: 'Recognize a contribution',
      description: 'Draft concrete, evidence-based kudos without inventing accomplishments.',
      argsSchema: {
        recipient: z.string().describe('Known agent ID'),
        contribution: z.string().describe('Observed contribution and why it mattered'),
      },
    },
    ({ recipient, contribution }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Prepare specific kudos for ${recipient}. Describe what the agent did, why it mattered, and only evidence actually observed: ${contribution}. Do not invent details or include secrets.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'review_kudos_inbox',
    {
      title: 'Review kudos inbox',
      description:
        'Review the configured agent’s unacknowledged kudos before acknowledging any item.',
    },
    () => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Review the kudos inbox for ${actor.displayName ?? actor.id}. Summarize each concrete contribution. Acknowledge only after it has been reviewed; acknowledgment records receipt, not blanket agreement.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'summarize_agent_wins',
    {
      title: 'Summarize agent wins',
      description: 'Summarize supported recognition without embellishment.',
      argsSchema: { agentId: agentIdSchema },
    },
    ({ agentId }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Summarize active, visible wins for ${agentId}. Stay factual, distinguish acknowledgment state, and do not infer accomplishments absent from the records.`,
          },
        },
      ],
    }),
  );

  return {
    server,
    client,
    async close() {
      await server.close();
      await client.close();
    },
  };
}

export async function startMcpServer(options: AgentKudosMcpOptions): Promise<AgentKudosMcpRuntime> {
  const runtime = await createAgentKudosMcpServer(options);
  const transport = new StdioServerTransport();
  await runtime.server.connect(transport);
  return runtime;
}
