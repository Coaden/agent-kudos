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
  changesInputSchema,
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
  KudosChangesInput,
  KudosAcknowledgedEvent,
  KudosClientOptions,
  KudosEvent,
  KudosGivenEvent,
  KudosListInput,
  KudosRecord,
  KudosRevokedEvent,
  KudosStats,
  KudosSummary,
  ChangePage,
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
    changes: (input: KudosChangesInput = {}) => this.listKudosChanges(input),
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
    this.storage.assertEventCompatibility();
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
    this.projections.syncAgent(profile.id);
    return profile;
  }

  private async updateAgent(idOrAlias: string, changes: UpdateAgentInput): Promise<AgentProfile> {
    this.checkAbort();
    this.storage.assertEventCompatibility();
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
    this.projections.syncAgent(updated.id);
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
    this.storage.assertEventCompatibility();
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
      this.actor.kind !== 'human' &&
      this.actor.id === recipient.id
    ) {
      throw new KudosError(
        'SELF_AWARD_FORBIDDEN',
        'Non-human actors cannot award kudos to a matching agent identity.',
      );
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
    if (outcome.created) this.projections.syncAgent(recipient.id);
    const record = this.getKudosRecord(outcome.event.id);
    return { record, created: outcome.created, deduplicated: !outcome.created };
  }

  private getKudosRecord(id: string): KudosRecord {
    const record = recordsFromEvents(this.storage.getReadableKudosEvents(id))[0];
    if (!record) throw new KudosError('KUDOS_NOT_FOUND', `Unknown kudos: ${id}`);
    return record;
  }

  private async getKudos(id: string): Promise<KudosRecord> {
    this.checkAbort();
    return this.getKudosRecord(id);
  }

  private async listKudos(input: KudosListInput): Promise<Page<KudosSummary>> {
    this.checkAbort();
    const filters = this.validate(() => listInputSchema.parse(input));
    const recipient = filters.recipientAgentId
      ? this.storage.getAgent(filters.recipientAgentId)
      : undefined;
    if (filters.recipientAgentId && !recipient) {
      throw new KudosError('AGENT_NOT_FOUND', `Unknown agent: ${filters.recipientAgentId}`);
    }
    return this.storage.listKudosSummaries(
      {
        ...filters,
        ...(recipient ? { recipientAgentId: recipient.id } : {}),
      },
      this.actor,
    );
  }

  private async listKudosChanges(input: KudosChangesInput): Promise<ChangePage> {
    this.checkAbort();
    const parsed = this.validate(() => changesInputSchema.parse(input));
    return this.storage.listKudosChanges(parsed.after, parsed.limit, this.actor);
  }

  private async acknowledgeKudos(input: { kudosId: string; note?: string }): Promise<KudosRecord> {
    this.checkAbort();
    this.storage.assertEventCompatibility();
    if (input.note !== undefined && (input.note.trim().length < 1 || input.note.length > 2000)) {
      throw new KudosError('INVALID_INPUT', 'Acknowledgment notes must be 1–2000 characters.');
    }
    const record = this.getKudosRecord(input.kudosId);
    if (record.acknowledgment) return record;
    if (record.revocation)
      throw new KudosError('INVALID_INPUT', 'Revoked kudos cannot be acknowledged.');
    const isRecipient =
      this.actor.kind === 'agent' && this.actor.id === record.event.recipientAgentId;
    if (this.actor.kind !== 'human' && !isRecipient) {
      throw new KudosError(
        'ACKNOWLEDGMENT_FORBIDDEN',
        'Only the recipient agent or a human administrator may acknowledge kudos.',
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
    this.projections.syncAgent(record.event.recipientAgentId);
    return this.getKudosRecord(input.kudosId);
  }

  private async revokeKudos(input: {
    kudosId: string;
    reason: string;
    administrative?: boolean;
  }): Promise<KudosRecord> {
    this.checkAbort();
    this.storage.assertEventCompatibility();
    const reason = input.reason.trim();
    if (!reason || reason.length > 2000) {
      throw new KudosError('INVALID_INPUT', 'Revocation reasons must be 1–2000 characters.');
    }
    const record = this.getKudosRecord(input.kudosId);
    if (record.revocation) return record;
    const isOriginalActor =
      record.event.actor.kind === this.actor.kind && record.event.actor.id === this.actor.id;
    if (input.administrative === true && this.actor.kind !== 'human') {
      throw new KudosError(
        'REVOCATION_FORBIDDEN',
        'Only a human actor may request an administrative revocation.',
      );
    }
    const administrative = this.actor.kind === 'human' && !isOriginalActor;
    if (!isOriginalActor && this.actor.kind !== 'human') {
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
    this.projections.syncAgent(record.event.recipientAgentId);
    return this.getKudosRecord(input.kudosId);
  }

  async stats(input: KudosListInput = {}): Promise<KudosStats> {
    this.checkAbort();
    const parsed = this.validate(() => listInputSchema.parse(input));
    const { cursor: _cursor, limit: _limit, offset: _offset, ...filters } = parsed;
    void _cursor;
    void _limit;
    void _offset;
    const recipient = filters.recipientAgentId
      ? this.storage.getAgent(filters.recipientAgentId)
      : undefined;
    if (filters.recipientAgentId && !recipient) {
      throw new KudosError('AGENT_NOT_FOUND', `Unknown agent: ${filters.recipientAgentId}`);
    }
    const records: KudosSummary[] = [];
    let cursor: string | undefined;
    const viewer = this.actor;
    let hasMore = true;
    while (hasMore) {
      const page = this.storage.listKudosSummaries(
        {
          ...filters,
          ...(recipient ? { recipientAgentId: recipient.id } : {}),
          limit: 50,
          offset: 0,
          ...(cursor ? { cursor } : {}),
        },
        viewer,
      );
      records.push(...page.items);
      cursor = page.nextCursor;
      hasMore = page.hasMore && Boolean(cursor) && page.items.length > 0;
    }
    const includedRecords = this.storage.config.includePrivateInStats
      ? records
      : records.filter((record) => record.visibility !== 'private');
    const stats: KudosStats = {
      total: includedRecords.length,
      active: includedRecords.filter((record) => record.revocationStatus === 'active').length,
      acknowledged: includedRecords.filter(
        (record) => record.status === 'acknowledged' && record.revocationStatus === 'active',
      ).length,
      revoked: includedRecords.filter((record) => record.revocationStatus === 'revoked').length,
      byAgent: {},
      byActor: {},
      byTag: {},
    };
    for (const record of includedRecords) {
      stats.byAgent[record.recipientAgentId] = (stats.byAgent[record.recipientAgentId] ?? 0) + 1;
      const actor = `${record.actor.kind}:${record.actor.id}`;
      stats.byActor[actor] = (stats.byActor[actor] ?? 0) + 1;
      for (const tag of record.tags) stats.byTag[tag] = (stats.byTag[tag] ?? 0) + 1;
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
      const eventScan = this.storage.scanEvents();
      if (eventScan.invalid.length) {
        for (const invalid of eventScan.invalid) {
          diagnostics.push({
            level: 'error',
            code: invalid.error.code,
            message: invalid.error.message,
          });
        }
      } else {
        diagnostics.push({
          level: 'ok',
          code: 'EVENTS_VALID',
          message: `${eventScan.events.length} canonical event${eventScan.events.length === 1 ? '' : 's'} validated.`,
        });
      }
      const indexHealth = this.storage.currentIndexHealth();
      const indexValid =
        indexHealth.given === indexHealth.indexed && indexHealth.stateMismatches === 0;
      diagnostics.push({
        level: indexValid ? 'ok' : 'error',
        code: indexValid ? 'CURRENT_INDEX_VALID' : 'CURRENT_INDEX_INCONSISTENT',
        message: `${indexHealth.indexed} of ${indexHealth.given} kudos are present in the current-state index; ${indexHealth.stateMismatches} state mismatch${indexHealth.stateMismatches === 1 ? '' : 'es'} detected.`,
      });
      const migrationState = this.storage.migrationState();
      const migrationsValid =
        migrationState.schemaVersion === 2 &&
        JSON.stringify(migrationState.appliedVersions) === JSON.stringify([1, 2]);
      diagnostics.push({
        level: migrationsValid ? 'ok' : 'error',
        code: migrationsValid ? 'MIGRATIONS_VALID' : 'MIGRATIONS_INCONSISTENT',
        message: `Database schema version is ${migrationState.schemaVersion}; recorded migrations: ${migrationState.appliedVersions.join(', ') || 'none'}.`,
      });
      const aliasConflicts = this.storage.aliasIdentityConflicts();
      diagnostics.push({
        level: aliasConflicts.length ? 'error' : 'ok',
        code: aliasConflicts.length ? 'ALIAS_CONFLICTS_FOUND' : 'ALIASES_VALID',
        message: aliasConflicts.length
          ? `Aliases collide with direct agent identities: ${aliasConflicts.map((item) => `${item.alias}→${item.agentId}`).join(', ')}.`
          : 'No aliases collide with direct agent identities.',
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
    const rows = this.storage.rawEventRows();
    if (format === 'jsonl') return `${rows.map((row) => row.payload).join('\n')}\n`;
    const exported = rows.map((row) => {
      try {
        return JSON.parse(row.payload) as unknown;
      } catch {
        return { _agentKudosUnreadableEvent: { id: row.id, rawPayload: row.payload } };
      }
    });
    if (format === 'json') return `${JSON.stringify(exported, null, 2)}\n`;
    const scan = this.storage.scanEvents();
    const events = scan.events;
    const records = recordsFromEvents(events);
    const warning = scan.invalid.length
      ? `> Warning: ${scan.invalid.length} unsupported or malformed event(s) omitted from this Markdown view: ${scan.invalid.map((item) => item.id).join(', ')}\n\n`
      : '';
    return `${warning}${records
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
