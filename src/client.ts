import { accessSync, constants as fsConstants, existsSync, lstatSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { ulid } from 'ulid';
import { resolveHome } from './config.js';
import { asKudosError, KudosError } from './errors.js';
import { assertNoSymlinkEscape } from './fs-utils.js';
import { escapeMarkdown, ProjectionManager, recordsFromEvents } from './projections.js';
import {
  actorSchema,
  agentIdSchema,
  createAgentSchema,
  giveKudosSchema,
  listInputSchema,
  updateAgentSchema,
} from './schemas.js';
import { KudosStorage } from './storage.js';
import type {
  ActorIdentity,
  AgentProfile,
  CreateAgentInput,
  Diagnostic,
  DoctorResult,
  GiveKudosInput,
  GiveKudosResult,
  KudosAcknowledgedEvent,
  KudosClientOptions,
  KudosEvent,
  KudosGivenEvent,
  KudosListInput,
  KudosRecord,
  KudosRevokedEvent,
  KudosStats,
  Page,
  UpdateAgentInput,
} from './types.js';

export class KudosClient {
  readonly home: string;
  readonly actor: ActorIdentity;
  readonly storage: KudosStorage;
  readonly projections: ProjectionManager;
  private readonly clock: () => Date;
  private readonly idGenerator: () => string;
  private readonly signal?: AbortSignal;
  private initialized = false;

  readonly agents = {
    create: (input: CreateAgentInput) => this.createAgent(input),
    update: (id: string, changes: UpdateAgentInput) => this.updateAgent(id, changes),
    get: (idOrAlias: string) => this.getAgent(idOrAlias),
    list: () => this.listAgents(),
  };

  readonly kudos = {
    give: (input: GiveKudosInput) => this.giveKudos(input),
    list: (input: KudosListInput = {}) => this.listKudos(input),
    get: (id: string) => this.getKudos(id),
    acknowledge: (input: { kudosId: string; note?: string }) => this.acknowledgeKudos(input),
    revoke: (input: { kudosId: string; reason: string; administrative?: boolean }) =>
      this.revokeKudos(input),
  };

  constructor(options: KudosClientOptions = {}) {
    this.home = resolveHome(options.home);
    try {
      this.actor = actorSchema.parse(options.actor ?? { kind: 'system', id: 'local' });
    } catch (error) {
      throw asKudosError(error);
    }
    this.clock = options.clock ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? (() => ulid(this.clock().getTime()));
    this.signal = options.signal;
    this.storage = new KudosStorage({
      home: this.home,
      readOnly: options.readOnly ?? false,
      ...(options.config ? { config: options.config } : {}),
    });
    this.projections = new ProjectionManager(this.storage);
  }

  async init(): Promise<void> {
    this.checkAbort();
    if (this.initialized) return;
    this.storage.init();
    this.initialized = true;
  }

  async close(): Promise<void> {
    this.storage.close();
    this.initialized = false;
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private nextId(): string {
    return this.idGenerator();
  }

  private checkAbort(): void {
    this.signal?.throwIfAborted();
  }

  private validate<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      throw asKudosError(error);
    }
  }

  private async createAgent(input: CreateAgentInput): Promise<AgentProfile> {
    this.checkAbort();
    const parsed = this.validate(() => createAgentSchema.parse(input));
    if (this.storage.getAgent(parsed.id)) {
      throw new KudosError('AGENT_EXISTS', `Agent or alias already exists: ${parsed.id}`);
    }
    const aliases = [...new Set(parsed.aliases ?? [])].sort();
    if (aliases.includes(parsed.id)) {
      throw new KudosError('ALIAS_CONFLICT', 'An agent cannot use its own ID as an alias.');
    }
    for (const alias of aliases) {
      if (this.storage.getAgent(alias)) {
        throw new KudosError('ALIAS_CONFLICT', `Alias already belongs to an agent: ${alias}`);
      }
    }
    const profile: AgentProfile = {
      id: parsed.id,
      displayName: parsed.displayName,
      ...(aliases.length ? { aliases } : {}),
      ...(parsed.description !== undefined ? { description: parsed.description } : {}),
      createdAt: this.now(),
      ...(parsed.metadata !== undefined ? { metadata: parsed.metadata } : {}),
    };
    const event: KudosEvent = {
      schemaVersion: 1,
      id: this.nextId(),
      type: 'agent.created',
      createdAt: this.now(),
      actor: this.actor,
      agent: profile,
    };
    this.storage.transaction(() => {
      this.storage.insertAgent(profile);
      this.storage.insertEvent(event);
    });
    this.projections.rebuild();
    return profile;
  }

  private async updateAgent(idOrAlias: string, changes: UpdateAgentInput): Promise<AgentProfile> {
    this.checkAbort();
    this.validate(() => agentIdSchema.parse(idOrAlias));
    const parsed = this.validate(() => updateAgentSchema.parse(changes));
    const existing = this.storage.getAgent(idOrAlias);
    if (!existing) throw new KudosError('AGENT_NOT_FOUND', `Unknown agent: ${idOrAlias}`);
    const aliases = parsed.aliases ? [...new Set(parsed.aliases)].sort() : existing.aliases;
    if (aliases?.includes(existing.id)) {
      throw new KudosError('ALIAS_CONFLICT', 'An agent cannot use its own ID as an alias.');
    }
    for (const alias of aliases ?? []) {
      const owner = this.storage.getAgent(alias);
      if (owner && owner.id !== existing.id) {
        throw new KudosError('ALIAS_CONFLICT', `Alias already belongs to ${owner.id}: ${alias}`);
      }
    }
    const updated: AgentProfile = {
      ...existing,
      ...parsed,
      ...(aliases?.length ? { aliases } : { aliases: undefined }),
    };
    const changesForEvent = { ...parsed, ...(parsed.aliases ? { aliases } : {}) };
    const event: KudosEvent = {
      schemaVersion: 1,
      id: this.nextId(),
      type: 'agent.updated',
      createdAt: this.now(),
      actor: this.actor,
      agentId: existing.id,
      changes: changesForEvent,
    };
    this.storage.transaction(() => {
      this.storage.updateAgent(updated, event.createdAt);
      this.storage.insertEvent(event);
    });
    this.projections.rebuild();
    return updated;
  }

  private async getAgent(idOrAlias: string): Promise<AgentProfile> {
    this.checkAbort();
    this.validate(() => agentIdSchema.parse(idOrAlias));
    const profile = this.storage.getAgent(idOrAlias);
    if (!profile) throw new KudosError('AGENT_NOT_FOUND', `Unknown agent: ${idOrAlias}`);
    return profile;
  }

  private async listAgents(): Promise<AgentProfile[]> {
    this.checkAbort();
    return this.storage.listAgents();
  }

  private async giveKudos(input: GiveKudosInput): Promise<GiveKudosResult> {
    this.checkAbort();
    const parsed = this.validate(() =>
      giveKudosSchema.parse({
        ...input,
        visibility: input.visibility ?? this.storage.config.defaultVisibility,
      }),
    );
    const recipient = this.storage.getAgent(parsed.recipientAgentId);
    if (!recipient) {
      throw new KudosError('AGENT_NOT_FOUND', `Unknown recipient: ${parsed.recipientAgentId}`);
    }
    if (
      !this.storage.config.allowSelfAwards &&
      this.actor.kind === 'agent' &&
      this.actor.id === recipient.id
    ) {
      throw new KudosError('SELF_AWARD_FORBIDDEN', 'Agents cannot award kudos to themselves.');
    }

    const outcome = this.storage.transaction(() => {
      if (parsed.idempotencyKey) {
        const prior = this.storage.getEventByIdempotency(
          this.actor.kind,
          this.actor.id,
          parsed.idempotencyKey,
        );
        if (prior?.type === 'kudos.given') return { event: prior, created: false };
      }
      const event: KudosGivenEvent = {
        schemaVersion: 1,
        id: this.nextId(),
        type: 'kudos.given',
        createdAt: this.now(),
        actor: this.actor,
        recipientAgentId: recipient.id,
        recipientDisplayName: recipient.displayName,
        title: parsed.title,
        reason: parsed.reason,
        visibility: parsed.visibility,
        ...(parsed.evidence ? { evidence: parsed.evidence } : {}),
        ...(parsed.tags ? { tags: [...new Set(parsed.tags)].sort() } : {}),
        ...(parsed.idempotencyKey ? { idempotencyKey: parsed.idempotencyKey } : {}),
        ...(parsed.source ? { source: parsed.source } : {}),
        ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
      };
      this.storage.insertEvent(event);
      return { event, created: true };
    });
    if (outcome.created) this.projections.rebuild();
    const record = this.getKudosRecord(outcome.event.id);
    return { record, created: outcome.created, deduplicated: !outcome.created };
  }

  private getKudosRecord(id: string): KudosRecord {
    const record = recordsFromEvents(this.storage.getEvents()).find((item) => item.event.id === id);
    if (!record) throw new KudosError('KUDOS_NOT_FOUND', `Unknown kudos: ${id}`);
    return record;
  }

  private async getKudos(id: string): Promise<KudosRecord> {
    this.checkAbort();
    return this.getKudosRecord(id);
  }

  private async listKudos(input: KudosListInput): Promise<Page<KudosRecord>> {
    this.checkAbort();
    const filters = this.validate(() => listInputSchema.parse(input));
    const recipient = filters.recipientAgentId
      ? this.storage.getAgent(filters.recipientAgentId)
      : undefined;
    let records = recordsFromEvents(this.storage.getEvents());
    records = records.filter((record) => {
      const event = record.event;
      return (
        (!filters.recipientAgentId || event.recipientAgentId === recipient?.id) &&
        (!filters.actorId || event.actor.id === filters.actorId) &&
        (!filters.actorKind || event.actor.kind === filters.actorKind) &&
        (!filters.tag || event.tags?.includes(filters.tag)) &&
        (!filters.status || record.status === filters.status) &&
        (!filters.visibility || event.visibility === filters.visibility) &&
        (filters.revoked === undefined ||
          (record.revocationStatus === 'revoked') === filters.revoked) &&
        (!filters.from || event.createdAt >= filters.from) &&
        (!filters.to || event.createdAt <= filters.to)
      );
    });
    return {
      items: records.slice(filters.offset, filters.offset + filters.limit),
      total: records.length,
      limit: filters.limit,
      offset: filters.offset,
    };
  }

  private async acknowledgeKudos(input: { kudosId: string; note?: string }): Promise<KudosRecord> {
    this.checkAbort();
    if (input.note !== undefined && (input.note.trim().length < 1 || input.note.length > 2000)) {
      throw new KudosError('INVALID_INPUT', 'Acknowledgment notes must be 1–2000 characters.');
    }
    const record = this.getKudosRecord(input.kudosId);
    if (record.acknowledgment) return record;
    if (record.revocation)
      throw new KudosError('INVALID_INPUT', 'Revoked kudos cannot be acknowledged.');
    if (this.actor.kind === 'agent' && this.actor.id !== record.event.recipientAgentId) {
      throw new KudosError(
        'ACKNOWLEDGMENT_FORBIDDEN',
        'An agent may acknowledge only kudos addressed to itself.',
      );
    }
    const event: KudosAcknowledgedEvent = {
      schemaVersion: 1,
      id: this.nextId(),
      type: 'kudos.acknowledged',
      createdAt: this.now(),
      actor: this.actor,
      kudosId: record.event.id,
      recipientAgentId: record.event.recipientAgentId,
      ...(input.note ? { note: input.note.trim() } : {}),
    };
    this.storage.transaction(() => this.storage.insertEvent(event));
    this.projections.rebuild();
    return this.getKudosRecord(input.kudosId);
  }

  private async revokeKudos(input: {
    kudosId: string;
    reason: string;
    administrative?: boolean;
  }): Promise<KudosRecord> {
    this.checkAbort();
    const reason = input.reason.trim();
    if (!reason || reason.length > 2000) {
      throw new KudosError('INVALID_INPUT', 'Revocation reasons must be 1–2000 characters.');
    }
    const record = this.getKudosRecord(input.kudosId);
    if (record.revocation) return record;
    const isOriginalActor =
      record.event.actor.kind === this.actor.kind && record.event.actor.id === this.actor.id;
    const administrative = input.administrative === true || this.actor.kind === 'human';
    if (!isOriginalActor && !administrative && this.actor.kind !== 'system') {
      throw new KudosError(
        'REVOCATION_FORBIDDEN',
        'Only the original actor or an administrator may revoke kudos.',
      );
    }
    const event: KudosRevokedEvent = {
      schemaVersion: 1,
      id: this.nextId(),
      type: 'kudos.revoked',
      createdAt: this.now(),
      actor: this.actor,
      kudosId: record.event.id,
      reason,
      mode: administrative && !isOriginalActor ? 'administrative' : 'actor-requested',
    };
    this.storage.transaction(() => this.storage.insertEvent(event));
    this.projections.rebuild();
    return this.getKudosRecord(input.kudosId);
  }

  async stats(input: KudosListInput = {}): Promise<KudosStats> {
    this.checkAbort();
    const records: KudosRecord[] = [];
    let offset = 0;
    let total = 0;
    do {
      const page = await this.listKudos({ ...input, limit: 200, offset });
      records.push(...page.items);
      total = page.total;
      if (page.items.length === 0) break;
      offset += page.items.length;
    } while (offset < total);
    let includedRecords = records;
    if (!this.storage.config.includePrivateInStats) {
      includedRecords = records.filter((record) => record.event.visibility !== 'private');
    }
    const stats: KudosStats = {
      total: includedRecords.length,
      active: includedRecords.filter((record) => !record.revocation).length,
      acknowledged: includedRecords.filter((record) => record.acknowledgment && !record.revocation)
        .length,
      revoked: includedRecords.filter((record) => record.revocation).length,
      byAgent: {},
      byActor: {},
      byTag: {},
    };
    for (const record of includedRecords) {
      stats.byAgent[record.event.recipientAgentId] =
        (stats.byAgent[record.event.recipientAgentId] ?? 0) + 1;
      const actor = `${record.event.actor.kind}:${record.event.actor.id}`;
      stats.byActor[actor] = (stats.byActor[actor] ?? 0) + 1;
      for (const tag of record.event.tags ?? []) stats.byTag[tag] = (stats.byTag[tag] ?? 0) + 1;
    }
    return stats;
  }

  async doctor(): Promise<DoctorResult> {
    this.checkAbort();
    const diagnostics: Diagnostic[] = [];
    try {
      try {
        accessSync(this.home, fsConstants.R_OK | (this.storage.readOnly ? 0 : fsConstants.W_OK));
        diagnostics.push({
          level: 'ok',
          code: 'HOME_PERMISSIONS_OK',
          message: `Storage home is ${this.storage.readOnly ? 'readable' : 'readable and writable'}.`,
        });
      } catch {
        diagnostics.push({
          level: 'error',
          code: 'HOME_PERMISSIONS_FAILED',
          message: 'Storage home permissions do not permit the configured access mode.',
          path: this.home,
        });
      }
      const integrity = this.storage.integrityCheck();
      if (integrity.length === 1 && integrity[0] === 'ok') {
        diagnostics.push({
          level: 'ok',
          code: 'SQLITE_INTEGRITY_OK',
          message: 'SQLite integrity check passed.',
        });
      } else {
        diagnostics.push({
          level: 'error',
          code: 'SQLITE_INTEGRITY_FAILED',
          message: integrity.join('; '),
        });
      }
      const journal = this.storage.journalMode();
      diagnostics.push({
        level: journal === 'wal' || this.storage.readOnly ? 'ok' : 'warning',
        code: 'SQLITE_JOURNAL_MODE',
        message: `SQLite journal mode is ${journal}.`,
      });
      const events = this.storage.getEvents();
      diagnostics.push({
        level: 'ok',
        code: 'EVENTS_VALID',
        message: `${events.length} canonical event${events.length === 1 ? '' : 's'} validated.`,
      });
      const expected = this.projections.expectedPaths();
      const manifest = this.storage.projectionManifest().sort();
      const stale = JSON.stringify(expected) === JSON.stringify(manifest) ? [] : expected;
      diagnostics.push({
        level: stale.length ? 'warning' : 'ok',
        code: stale.length ? 'PROJECTIONS_STALE' : 'PROJECTIONS_CURRENT',
        message: stale.length
          ? 'Generated projections need rebuilding.'
          : 'Projection manifest is current.',
      });
      for (const profile of this.storage.listAgents()) {
        const directory = join(this.home, profile.id);
        try {
          assertNoSymlinkEscape(this.home, directory);
          if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) {
            throw new KudosError('UNSAFE_PATH', 'Agent directory is a symbolic link.');
          }
        } catch (error) {
          diagnostics.push({
            level: 'error',
            code: 'UNSAFE_SYMLINK',
            message: error instanceof Error ? error.message : String(error),
            path: relative(this.home, directory),
          });
        }
      }
    } catch (error) {
      diagnostics.push({
        level: 'error',
        code: error instanceof KudosError ? error.code : 'DOCTOR_FAILED',
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return { healthy: !diagnostics.some((item) => item.level === 'error'), diagnostics };
  }

  async export(format: 'json' | 'jsonl' | 'markdown'): Promise<string> {
    this.checkAbort();
    const events = this.storage.getEvents();
    if (format === 'json') return `${JSON.stringify(events, null, 2)}\n`;
    if (format === 'jsonl') return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
    const records = recordsFromEvents(events);
    return `${records
      .map(
        (record) =>
          `## ${escapeMarkdown(record.event.title)}\n\n${escapeMarkdown(record.event.reason)}\n\nStatus: ${record.revocationStatus === 'revoked' ? 'Revoked' : record.status === 'acknowledged' ? 'Acknowledged' : 'Unacknowledged'}\n\nKudos ID: \`${record.event.id}\``,
      )
      .join('\n\n')}\n`;
  }

  async backup(destination: string): Promise<string> {
    this.checkAbort();
    return this.storage.backup(resolve(destination));
  }
}
