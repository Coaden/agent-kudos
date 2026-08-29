import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createAgentKudosMcpServer } from '../src/mcp/index.js';
import { tempHome, testClient } from './helpers.js';

async function setupRuntime(home: string) {
  const setup = await testClient(home);
  await setup.agents.create({ id: 'gracie', displayName: 'Gracie' });
  await setup.agents.create({ id: 'codex', displayName: 'Codex' });
  await setup.close();
  return connectRuntime(home, { kind: 'agent', id: 'gracie', displayName: 'Gracie' });
}

async function connectRuntime(
  home: string,
  actor: { kind: 'agent'; id: string; displayName: string },
) {
  const runtime = await createAgentKudosMcpServer({
    home,
    actor,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const protocolClient = new Client({ name: 'agent-kudos-test', version: '1.0.0' });
  await Promise.all([
    runtime.server.connect(serverTransport),
    protocolClient.connect(clientTransport),
  ]);
  return { runtime, protocolClient };
}

describe('MCP protocol integration', () => {
  it('advertises precise tools, resources, and prompts through the protocol', async () => {
    const home = tempHome();
    const { runtime, protocolClient } = await setupRuntime(home);
    const tools = await protocolClient.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'kudos_give',
        'kudos_list',
        'kudos_changes',
        'kudos_get',
        'kudos_acknowledge',
        'kudos_revoke',
        'kudos_stats',
        'kudos_agent_create',
        'kudos_agent_list',
        'kudos_rebuild',
        'kudos_doctor',
      ]),
    );
    expect(tools.tools.find((tool) => tool.name === 'kudos_list')?.annotations?.readOnlyHint).toBe(
      true,
    );
    expect(
      tools.tools.find((tool) => tool.name === 'kudos_revoke')?.annotations?.destructiveHint,
    ).toBe(true);
    const giveSchema = tools.tools.find((tool) => tool.name === 'kudos_give')?.inputSchema as {
      type?: string;
      required?: string[];
      properties?: { tags?: { items?: { pattern?: string } } };
    };
    expect(giveSchema.type).toBe('object');
    expect(giveSchema.required).toEqual(
      expect.arrayContaining(['recipientAgentId', 'title', 'reason']),
    );
    expect(giveSchema.properties?.tags?.items?.pattern).toBeTruthy();
    const templates = await protocolClient.listResourceTemplates();
    expect(templates.resourceTemplates.map((resource) => resource.uriTemplate)).toContain(
      'kudos://agents/{agentId}/inbox',
    );
    const prompts = await protocolClient.listPrompts();
    expect(prompts.prompts.map((prompt) => prompt.name)).toEqual(
      expect.arrayContaining([
        'recognize_contribution',
        'review_kudos_inbox',
        'summarize_agent_wins',
      ]),
    );
    await protocolClient.close();
    await runtime.client.close();
  });

  it('binds the actor, returns structured content, enforces policy, and exposes resources', async () => {
    const home = tempHome();
    const { runtime, protocolClient } = await setupRuntime(home);
    const result = await protocolClient.callTool({
      name: 'kudos_give',
      arguments: {
        recipientAgentId: 'codex',
        title: 'Caught a continuity contradiction',
        reason: 'Found conflicting requirements before implementation.',
        idempotencyKey: 'mcp-e17',
      },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: true,
      actor: { kind: 'agent', id: 'gracie' },
      data: { created: true, deduplicated: false },
    });
    const kudosId = (
      result.structuredContent as {
        data: { record: { event: { id: string } } };
      }
    ).data.record.event.id;

    const retry = await protocolClient.callTool({
      name: 'kudos_give',
      arguments: {
        recipientAgentId: 'codex',
        title: 'Retry',
        reason: 'A retry with the same stable key.',
        idempotencyKey: 'mcp-e17',
      },
    });
    expect(retry.structuredContent).toMatchObject({ data: { deduplicated: true } });

    const list = await protocolClient.callTool({ name: 'kudos_list', arguments: {} });
    const listData = (list.structuredContent as { data: { items: unknown[]; limit: number } }).data;
    expect(listData.limit).toBe(10);
    expect(listData.items).toHaveLength(1);
    expect(listData.items[0]).toMatchObject({
      id: kudosId,
      title: 'Caught a continuity contradiction',
    });
    expect(listData.items[0]).not.toHaveProperty('event');
    expect(listData.items[0]).not.toHaveProperty('reason');

    const changes = await protocolClient.callTool({ name: 'kudos_changes', arguments: {} });
    expect(changes.structuredContent).toMatchObject({
      data: { limit: 20, items: [{ type: 'kudos.given', kudosId }] },
    });

    const selfAward = await protocolClient.callTool({
      name: 'kudos_give',
      arguments: {
        recipientAgentId: 'gracie',
        title: 'Self praise',
        reason: 'This should be rejected.',
      },
    });
    expect(selfAward.isError).toBe(true);
    expect(selfAward.structuredContent).toMatchObject({ errorCode: 'SELF_AWARD_FORBIDDEN' });

    const acknowledgeOther = await protocolClient.callTool({
      name: 'kudos_acknowledge',
      arguments: { kudosId },
    });
    expect(acknowledgeOther.structuredContent).toMatchObject({
      errorCode: 'ACKNOWLEDGMENT_FORBIDDEN',
    });

    const administrativeRevoke = await protocolClient.callTool({
      name: 'kudos_revoke',
      arguments: { kudosId, reason: 'Agent requested admin power.', administrative: true },
    });
    expect(administrativeRevoke.structuredContent).toMatchObject({ errorCode: 'POLICY_FORBIDDEN' });

    const createAgent = await protocolClient.callTool({
      name: 'kudos_agent_create',
      arguments: { id: 'mycroft', displayName: 'Mycroft' },
    });
    expect(createAgent.structuredContent).toMatchObject({ errorCode: 'POLICY_FORBIDDEN' });

    const rebuild = await protocolClient.callTool({ name: 'kudos_rebuild', arguments: {} });
    expect(rebuild.structuredContent).toMatchObject({ errorCode: 'POLICY_FORBIDDEN' });

    const inbox = await protocolClient.readResource({ uri: 'kudos://agents/gracie/inbox' });
    expect(inbox.contents).toHaveLength(1);
    await expect(
      protocolClient.readResource({ uri: 'kudos://agents/codex/inbox' }),
    ).rejects.toThrow();

    await protocolClient.close();
    await runtime.client.close();
  });

  it('enforces private visibility through tools and resources', async () => {
    const home = tempHome();
    const setup = await testClient(home);
    await setup.agents.create({ id: 'gracie', displayName: 'Gracie' });
    await setup.agents.create({ id: 'codex', displayName: 'Codex' });
    await setup.agents.create({ id: 'mycroft', displayName: 'Mycroft' });
    await setup.close();

    const giver = await testClient(home, { kind: 'agent', id: 'gracie' });
    const privateKudos = await giver.kudos.give({
      recipientAgentId: 'codex',
      title: 'Private recognition',
      reason: 'This detail is intended only for participants.',
      visibility: 'private',
    });
    await giver.close();

    const mycroft = await connectRuntime(home, {
      kind: 'agent',
      id: 'mycroft',
      displayName: 'Mycroft',
    });
    const hidden = await mycroft.protocolClient.callTool({
      name: 'kudos_get',
      arguments: { kudosId: privateKudos.record.event.id },
    });
    expect(hidden.structuredContent).toMatchObject({ errorCode: 'POLICY_FORBIDDEN' });
    const list = await mycroft.protocolClient.callTool({
      name: 'kudos_list',
      arguments: { limit: 50, offset: 0 },
    });
    expect(list.structuredContent).toMatchObject({ data: { total: 0, items: [] } });
    await expect(
      mycroft.protocolClient.readResource({
        uri: `kudos://events/${privateKudos.record.event.id}`,
      }),
    ).rejects.toThrow();
    await mycroft.protocolClient.close();
    await mycroft.runtime.client.close();

    const codex = await connectRuntime(home, {
      kind: 'agent',
      id: 'codex',
      displayName: 'Codex',
    });
    const visible = await codex.protocolClient.callTool({
      name: 'kudos_get',
      arguments: { kudosId: privateKudos.record.event.id },
    });
    expect(visible.isError).not.toBe(true);
    await codex.protocolClient.close();
    await codex.runtime.client.close();
  });
});
