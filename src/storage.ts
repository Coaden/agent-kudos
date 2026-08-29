import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { defaultConfig, mergeConfig } from './config.js';
import { asKudosError, KudosError } from './errors.js';
import {
  assertNoSymlinkEscape,
  atomicWriteFile,
  ensureDirectory,
  readJsonFile,
} from './fs-utils.js';
import { actorSchema, eventSchema, profileSchema } from './schemas.js';
import type {
  ActorIdentity,
  AgentKudosConfig,
  AgentKudosConfigOverrides,
  AgentProfile,
  ChangePage,
  KudosChange,
  KudosEvent,
  KudosListInput,
  KudosSummary,
  Page,
} from './types.js';

interface EventRow {
  id: string;
  payload: string;
  sequence?: number;
}

interface CurrentRow {
  kudos_id: string;
  given_sequence: number;
  created_at: string;
  recipient_agent_id: string;
  recipient_display_name: string;
  actor_kind: ActorIdentity['kind'];
  actor_id: string;
  actor_display_name: string | null;
  title: string;
  tags_json: string;
  visibility: KudosSummary['visibility'];
  status: KudosSummary['status'];
  revocation_status: KudosSummary['revocationStatus'];
  updated_sequence: number;
}

export interface EventScan {
  events: KudosEvent[];
  invalid: Array<{ id: string; error: KudosError }>;
}

interface ProfileRow {
  profile_json: string;
}

const migrationV1 = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  profile_json TEXT NOT NULL CHECK (json_valid(profile_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS aliases (
  alias TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  recipient_agent_id TEXT,
  kudos_id TEXT,
  visibility TEXT,
  idempotency_key TEXT,
  payload TEXT NOT NULL CHECK (json_valid(payload))
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS events_actor_idempotency
ON events(actor_kind, actor_id, idempotency_key)
WHERE type = 'kudos.given' AND idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS events_type_created ON events(type, created_at, id);
CREATE INDEX IF NOT EXISTS events_recipient ON events(recipient_agent_id, created_at, id);
CREATE INDEX IF NOT EXISTS events_kudos_id ON events(kudos_id, created_at, id);

CREATE TABLE IF NOT EXISTS projection_manifest (
  path TEXT PRIMARY KEY,
  generated_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER IF NOT EXISTS events_append_only_update
BEFORE UPDATE ON events BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS events_append_only_delete
BEFORE DELETE ON events BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;
`;

const migrationV2 = `
DROP TRIGGER IF EXISTS events_append_only_update;
ALTER TABLE events ADD COLUMN sequence INTEGER;
UPDATE events SET sequence = rowid;
CREATE UNIQUE INDEX events_sequence ON events(sequence);
CREATE TRIGGER events_sequence_required
BEFORE INSERT ON events WHEN NEW.sequence IS NULL BEGIN
  SELECT RAISE(ABORT, 'events require an ingestion sequence');
END;
CREATE TRIGGER events_append_only_update
BEFORE UPDATE ON events BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TABLE kudos_current (
  kudos_id TEXT PRIMARY KEY,
  given_sequence INTEGER NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  recipient_agent_id TEXT NOT NULL,
  recipient_display_name TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_display_name TEXT,
  title TEXT NOT NULL,
  tags_json TEXT NOT NULL CHECK (json_valid(tags_json)),
  visibility TEXT NOT NULL,
  status TEXT NOT NULL,
  revocation_status TEXT NOT NULL,
  updated_sequence INTEGER NOT NULL
) STRICT;
CREATE INDEX kudos_current_recipient ON kudos_current(recipient_agent_id, given_sequence DESC);
CREATE INDEX kudos_current_actor ON kudos_current(actor_kind, actor_id, given_sequence DESC);
CREATE INDEX kudos_current_status ON kudos_current(status, revocation_status, given_sequence DESC);
`;

const CONTEXT_BUDGET_BYTES = 24_576;

function encodeCursor(kind: 'list' | 'change', sequence: number): string {
  return Buffer.from(JSON.stringify({ v: 1, kind, sequence }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string, kind: 'list' | 'change'): number {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      v?: unknown;
      kind?: unknown;
      sequence?: unknown;
    };
    if (
      value.v !== 1 ||
      value.kind !== kind ||
      typeof value.sequence !== 'number' ||
      !Number.isSafeInteger(value.sequence) ||
      value.sequence < 0
    ) {
      throw new Error('invalid cursor');
    }
    return value.sequence;
  } catch {
    throw new KudosError('INVALID_INPUT', `Invalid ${kind} cursor.`);
  }
}

function summaryFromRow(row: CurrentRow): KudosSummary {
  return {
    id: row.kudos_id,
    createdAt: row.created_at,
    recipientAgentId: row.recipient_agent_id,
    recipientDisplayName: row.recipient_display_name,
    actor: {
      kind: row.actor_kind,
      id: row.actor_id,
      ...(row.actor_display_name ? { displayName: row.actor_display_name } : {}),
    },
    title: row.title,
    tags: JSON.parse(row.tags_json) as string[],
    visibility: row.visibility,
    status: row.status,
    revocationStatus: row.revocation_status,
  };
}

export interface StorageOptions {
  home: string;
  readOnly: boolean;
  config?: AgentKudosConfigOverrides;
}

export class KudosStorage {
  readonly home: string;
  readonly kudosDirectory: string;
  readonly databasePath: string;
  readonly configPath: string;
  readonly readOnly: boolean;
  config: AgentKudosConfig = defaultConfig;
  private database?: DatabaseSync;
  private readonly configOverrides?: AgentKudosConfigOverrides;
  private validatedEventSequence = 0;

  constructor(options: StorageOptions) {
    this.home = resolve(options.home);
    this.kudosDirectory = join(this.home, 'kudos');
    this.databasePath = join(this.kudosDirectory, 'agent-kudos.sqlite3');
    this.configPath = join(this.kudosDirectory, 'config.json');
    this.readOnly = options.readOnly;
    this.configOverrides = options.config;
  }

  init(): void {
    try {
      if (this.readOnly && !existsSync(this.databasePath)) {
        throw new KudosError(
          'READ_ONLY',
          'The Agent Kudos database does not exist in read-only mode.',
        );
      }
      if (!existsSync(this.home)) {
        if (this.readOnly) throw new KudosError('READ_ONLY', 'Storage home does not exist.');
        mkdirSync(this.home, { recursive: true, mode: 0o700 });
      }
      if (lstatSync(this.home).isSymbolicLink()) {
        throw new KudosError(
          'UNSAFE_PATH',
          'The configured Agent Kudos home cannot be a symbolic link.',
        );
      }
      if (!this.readOnly) ensureDirectory(this.kudosDirectory);
      assertNoSymlinkEscape(this.home, this.kudosDirectory);
      if (!this.readOnly) {
        chmodSync(this.kudosDirectory, 0o700);
        if (!existsSync(this.databasePath)) closeSync(openSync(this.databasePath, 'wx', 0o600));
      }

      const fileConfig = existsSync(this.configPath) ? readJsonFile(this.configPath) : undefined;
      this.config = mergeConfig(fileConfig, this.configOverrides);
      if (!this.readOnly && !existsSync(this.configPath)) {
        atomicWriteFile(this.configPath, `${JSON.stringify(this.config, null, 2)}\n`);
      }

      this.database = new DatabaseSync(this.databasePath, {
        readOnly: this.readOnly,
        enableForeignKeyConstraints: true,
      });
      this.database.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
      if (!this.readOnly) {
        this.database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
        this.migrate();
        this.restrictDatabaseFiles();
      } else {
        this.assertSchemaSupported();
      }
    } catch (error) {
      this.close();
      if (error instanceof KudosError) throw error;
      if (error instanceof SyntaxError) {
        throw new KudosError('CONFIG_INVALID', 'Could not parse kudos/config.json.');
      }
      throw asKudosError(error);
    }
  }

  private migrate(): void {
    const db = this.db();
    const version = Number(
      (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    );
    if (version > 2) {
      throw new KudosError(
        'UNSUPPORTED_SCHEMA',
        `Database schema version ${version} is newer than this package supports.`,
      );
    }
    if (version === 0) {
      this.transaction(() => {
        db.exec(migrationV1);
        db.prepare(
          'INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)',
        ).run(1, new Date().toISOString());
        db.exec('PRAGMA user_version = 1');
      });
    }
    const currentVersion = Number(
      (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    );
    if (currentVersion === 1) {
      this.transaction(() => {
        db.exec(migrationV2);
        this.rebuildKudosCurrentIndex();
        db.prepare(
          'INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)',
        ).run(2, new Date().toISOString());
        db.exec('PRAGMA user_version = 2');
      });
    }
  }

  private assertSchemaSupported(): void {
    const version = Number(
      (this.db().prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    );
    if (version !== 2) {
      if (version === 1) {
        throw new KudosError(
          'UNSUPPORTED_SCHEMA',
          'Database schema version 1 requires migration. Open this home once with readOnly: false, then retry the read-only client.',
        );
      }
      throw new KudosError(
        'UNSUPPORTED_SCHEMA',
        `Expected database schema version 2; found ${version}.`,
      );
    }
  }

  db(): DatabaseSync {
    if (!this.database)
      throw new KudosError('INTERNAL_ERROR', 'KudosClient.init() has not completed.');
    return this.database;
  }

  assertWritable(): void {
    if (this.readOnly) throw new KudosError('READ_ONLY', 'This Agent Kudos client is read-only.');
  }

  transaction<T>(operation: () => T): T {
    this.assertWritable();
    const db = this.db();
    let began = false;
    try {
      db.exec('BEGIN IMMEDIATE');
      began = true;
      const result = operation();
      db.exec('COMMIT');
      began = false;
      this.restrictDatabaseFiles();
      return result;
    } catch (error) {
      if (began) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // Preserve the original failure.
        }
      }
      throw asKudosError(error);
    }
  }

  insertEvent(event: KudosEvent): void {
    const parsed = eventSchema.parse(event);
    const recipientAgentId =
      parsed.type === 'kudos.given' || parsed.type === 'kudos.acknowledged'
        ? parsed.recipientAgentId
        : null;
    const kudosId =
      parsed.type === 'kudos.acknowledged' || parsed.type === 'kudos.revoked'
        ? parsed.kudosId
        : null;
    const visibility = parsed.type === 'kudos.given' ? parsed.visibility : null;
    const idempotencyKey = parsed.type === 'kudos.given' ? (parsed.idempotencyKey ?? null) : null;
    const sequence = Number(
      (
        this.db().prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM events').get() as {
          next: number;
        }
      ).next,
    );
    this.db()
      .prepare(
        `INSERT INTO events(
          id, schema_version, type, created_at, actor_kind, actor_id,
          recipient_agent_id, kudos_id, visibility, idempotency_key, payload, sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.id,
        parsed.schemaVersion,
        parsed.type,
        parsed.createdAt,
        parsed.actor.kind,
        parsed.actor.id,
        recipientAgentId,
        kudosId,
        visibility,
        idempotencyKey,
        JSON.stringify(parsed),
        sequence,
      );
    this.applyEventToCurrent(parsed, sequence);
  }

  private applyEventToCurrent(event: KudosEvent, sequence: number): void {
    if (event.type === 'kudos.given') {
      this.db()
        .prepare(
          `INSERT INTO kudos_current(
            kudos_id, given_sequence, created_at, recipient_agent_id, recipient_display_name,
            actor_kind, actor_id, actor_display_name, title, tags_json, visibility,
            status, revocation_status, updated_sequence
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unacknowledged', 'active', ?)`,
        )
        .run(
          event.id,
          sequence,
          event.createdAt,
          event.recipientAgentId,
          event.recipientDisplayName,
          event.actor.kind,
          event.actor.id,
          event.actor.displayName ?? null,
          event.title,
          JSON.stringify(event.tags ?? []),
          event.visibility,
          sequence,
        );
    } else if (event.type === 'kudos.acknowledged') {
      this.db()
        .prepare(
          "UPDATE kudos_current SET status = 'acknowledged', updated_sequence = ? WHERE kudos_id = ?",
        )
        .run(sequence, event.kudosId);
    } else if (event.type === 'kudos.revoked') {
      this.db()
        .prepare(
          "UPDATE kudos_current SET revocation_status = 'revoked', updated_sequence = ? WHERE kudos_id = ?",
        )
        .run(sequence, event.kudosId);
    }
  }

  rebuildKudosCurrentIndex(): void {
    this.db().prepare('DELETE FROM kudos_current').run();
    const rows = this.db()
      .prepare('SELECT id, payload, sequence FROM events ORDER BY sequence ASC')
      .all() as unknown as Array<EventRow & { sequence: number }>;
    for (const row of rows) {
      try {
        this.applyEventToCurrent(this.parseEvent(row), row.sequence);
      } catch (error) {
        if (!(error instanceof KudosError)) throw error;
      }
    }
  }

  listKudosSummaries(
    input: Required<Pick<KudosListInput, 'limit' | 'offset'>> & KudosListInput,
    viewer: ActorIdentity,
  ): Page<KudosSummary> {
    const where: string[] = [];
    const parameters: Array<string | number> = [];
    const add = (clause: string, ...values: Array<string | number>): void => {
      where.push(clause);
      parameters.push(...values);
    };

    if (input.recipientAgentId) add('recipient_agent_id = ?', input.recipientAgentId);
    if (input.actorId) add('actor_id = ?', input.actorId);
    if (input.actorKind) add('actor_kind = ?', input.actorKind);
    if (input.tag) add('EXISTS (SELECT 1 FROM json_each(tags_json) WHERE value = ?)', input.tag);
    if (input.status) add('status = ?', input.status);
    if (input.visibility) add('visibility = ?', input.visibility);
    if (input.revoked !== undefined) {
      add('revocation_status = ?', input.revoked ? 'revoked' : 'active');
    }
    if (input.from) add('created_at >= ?', input.from);
    if (input.to) add('created_at <= ?', input.to);
    if (viewer.kind !== 'human') {
      add(
        `(visibility != 'private' OR recipient_agent_id = ? OR (actor_kind = ? AND actor_id = ?))`,
        viewer.id,
        viewer.kind,
        viewer.id,
      );
    }

    const baseWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number(
      (
        this.db()
          .prepare(`SELECT COUNT(*) AS count FROM kudos_current ${baseWhere}`)
          .get(...parameters) as { count: number }
      ).count,
    );
    const cursorSequence = input.cursor ? decodeCursor(input.cursor, 'list') : undefined;
    const pageWhere = [...where];
    const pageParameters = [...parameters];
    if (cursorSequence !== undefined) {
      pageWhere.push('given_sequence < ?');
      pageParameters.push(cursorSequence);
    }
    const sqlWhere = pageWhere.length ? `WHERE ${pageWhere.join(' AND ')}` : '';
    const offset = cursorSequence === undefined ? input.offset : 0;
    const rows = this.db()
      .prepare(
        `SELECT * FROM kudos_current ${sqlWhere}
         ORDER BY given_sequence DESC LIMIT ? OFFSET ?`,
      )
      .all(...pageParameters, input.limit + 1, offset) as unknown as CurrentRow[];

    const items: KudosSummary[] = [];
    let bytes = 2;
    let contextLimited = false;
    for (const row of rows.slice(0, input.limit)) {
      const item = summaryFromRow(row);
      const itemBytes = Buffer.byteLength(JSON.stringify(item), 'utf8') + 1;
      if (items.length > 0 && bytes + itemBytes > CONTEXT_BUDGET_BYTES) {
        contextLimited = true;
        break;
      }
      items.push(item);
      bytes += itemBytes;
    }
    const hasMore = contextLimited || rows.length > items.length;
    const last = items.at(-1);
    const lastRow = last ? rows[items.length - 1] : undefined;
    const watermark = encodeCursor('change', this.maxEventSequence());
    return {
      items,
      total,
      limit: input.limit,
      offset,
      ...(hasMore && lastRow ? { nextCursor: encodeCursor('list', lastRow.given_sequence) } : {}),
      hasMore,
      watermark,
      contextLimited,
    };
  }

  listKudosChanges(after: string | undefined, limit: number, viewer: ActorIdentity): ChangePage {
    const afterSequence = after ? decodeCursor(after, 'change') : 0;
    const highWatermark = this.maxEventSequence();
    const privacy =
      viewer.kind === 'human'
        ? ''
        : `AND (k.visibility != 'private' OR k.recipient_agent_id = ? OR
            (k.actor_kind = ? AND k.actor_id = ?))`;
    const parameters: Array<string | number> = [afterSequence, highWatermark];
    if (viewer.kind !== 'human') parameters.push(viewer.id, viewer.kind, viewer.id);
    parameters.push(limit + 1);
    const rows = this.db()
      .prepare(
        `SELECT e.id AS event_id, e.sequence, e.type, e.created_at AS event_created_at, e.payload, k.*
         FROM events e
         JOIN kudos_current k ON k.kudos_id = CASE
           WHEN e.type = 'kudos.given' THEN e.id ELSE e.kudos_id END
         WHERE e.sequence > ? AND e.sequence <= ?
           AND e.type IN ('kudos.given', 'kudos.acknowledged', 'kudos.revoked')
           ${privacy}
         ORDER BY e.sequence ASC LIMIT ?`,
      )
      .all(...parameters) as unknown as Array<
      CurrentRow &
        EventRow & {
          event_id: string;
          event_created_at: string;
          type: KudosChange['type'];
        }
    >;

    const items: KudosChange[] = [];
    let bytes = 2;
    let contextLimited = false;
    let consumed = 0;
    let lastConsumedSequence = afterSequence;
    for (const row of rows.slice(0, limit)) {
      const sequence = Number(row.sequence);
      let actor: ActorIdentity;
      try {
        const payload = JSON.parse(row.payload) as { actor: ActorIdentity };
        actor = actorSchema.parse(payload.actor);
      } catch {
        consumed += 1;
        lastConsumedSequence = sequence;
        continue;
      }
      const item: KudosChange = {
        cursor: encodeCursor('change', sequence),
        sequence,
        eventId: row.event_id,
        type: row.type,
        createdAt: row.event_created_at,
        actor,
        kudosId: row.kudos_id,
        recipientAgentId: row.recipient_agent_id,
        summary: summaryFromRow(row),
      };
      const itemBytes = Buffer.byteLength(JSON.stringify(item), 'utf8') + 1;
      if (items.length > 0 && bytes + itemBytes > CONTEXT_BUDGET_BYTES) {
        contextLimited = true;
        break;
      }
      items.push(item);
      bytes += itemBytes;
      consumed += 1;
      lastConsumedSequence = sequence;
    }
    const hasMore = contextLimited || rows.length > consumed;
    const nextCursor = encodeCursor('change', hasMore ? lastConsumedSequence : highWatermark);
    return {
      items,
      limit,
      nextCursor,
      hasMore,
      watermark: encodeCursor('change', highWatermark),
      contextLimited,
    };
  }

  currentIndexHealth(): { given: number; indexed: number; stateMismatches: number } {
    const given = Number(
      (
        this.db()
          .prepare("SELECT COUNT(*) AS count FROM events WHERE type = 'kudos.given'")
          .get() as { count: number }
      ).count,
    );
    const indexed = Number(
      (this.db().prepare('SELECT COUNT(*) AS count FROM kudos_current').get() as { count: number })
        .count,
    );
    const stateMismatches = Number(
      (
        this.db()
          .prepare(
            `SELECT COUNT(*) AS count
             FROM kudos_current k
             WHERE k.status != CASE WHEN EXISTS (
               SELECT 1 FROM events e
               WHERE e.type = 'kudos.acknowledged' AND e.kudos_id = k.kudos_id
             ) THEN 'acknowledged' ELSE 'unacknowledged' END
             OR k.revocation_status != CASE WHEN EXISTS (
               SELECT 1 FROM events e
               WHERE e.type = 'kudos.revoked' AND e.kudos_id = k.kudos_id
             ) THEN 'revoked' ELSE 'active' END`,
          )
          .get() as { count: number }
      ).count,
    );
    return { given, indexed, stateMismatches };
  }

  migrationState(): { schemaVersion: number; appliedVersions: number[] } {
    const schemaVersion = Number(
      (this.db().prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    );
    const appliedVersions = (
      this.db()
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all() as unknown as Array<{
        version: number;
      }>
    ).map((row) => Number(row.version));
    return { schemaVersion, appliedVersions };
  }

  aliasIdentityConflicts(): Array<{ alias: string; agentId: string }> {
    return this.db()
      .prepare(
        `SELECT x.alias, x.agent_id AS agentId
         FROM aliases x JOIN agents a ON a.id = x.alias
         ORDER BY x.alias`,
      )
      .all() as unknown as Array<{ alias: string; agentId: string }>;
  }

  private maxEventSequence(): number {
    return Number(
      (
        this.db().prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events').get() as {
          sequence: number;
        }
      ).sequence,
    );
  }

  getEvent(id: string): KudosEvent | undefined {
    const row = this.db().prepare('SELECT id, payload FROM events WHERE id = ?').get(id) as
      EventRow | undefined;
    return row ? this.parseEvent(row) : undefined;
  }

  getEventByIdempotency(actorKind: string, actorId: string, key: string): KudosEvent | undefined {
    const row = this.db()
      .prepare(
        `SELECT id, payload FROM events
         WHERE type = 'kudos.given' AND actor_kind = ? AND actor_id = ? AND idempotency_key = ?`,
      )
      .get(actorKind, actorId, key) as EventRow | undefined;
    return row ? this.parseEvent(row) : undefined;
  }

  getEvents(): KudosEvent[] {
    const scan = this.scanEvents();
    if (scan.invalid[0]) throw scan.invalid[0].error;
    return scan.events;
  }

  getReadableEvents(): KudosEvent[] {
    return this.scanEvents().events;
  }

  getReadableKudosEvents(kudosId: string): KudosEvent[] {
    const rows = this.db()
      .prepare(
        `SELECT id, payload FROM events
         WHERE (type = 'kudos.given' AND id = ?) OR kudos_id = ?
         ORDER BY sequence ASC`,
      )
      .all(kudosId, kudosId) as unknown as EventRow[];
    const events: KudosEvent[] = [];
    for (const row of rows) {
      try {
        events.push(this.parseEvent(row));
      } catch {
        // Detail reads remain available when an unrelated or newer row is unreadable.
      }
    }
    return events;
  }

  scanEvents(): EventScan {
    const rows = this.rawEventRows();
    const events: KudosEvent[] = [];
    const invalid: EventScan['invalid'] = [];
    for (const row of rows) {
      try {
        events.push(this.parseEvent(row));
      } catch (error) {
        const parsed = asKudosError(error);
        invalid.push({ id: row.id, error: parsed });
      }
    }
    return { events, invalid };
  }

  assertEventCompatibility(): void {
    const rows = this.db()
      .prepare('SELECT id, payload, sequence FROM events WHERE sequence > ? ORDER BY sequence ASC')
      .all(this.validatedEventSequence) as unknown as Array<EventRow & { sequence: number }>;
    const invalid: EventScan['invalid'] = [];
    for (const row of rows) {
      try {
        this.parseEvent(row);
      } catch (error) {
        invalid.push({ id: row.id, error: asKudosError(error) });
      }
    }
    if (!invalid.length) {
      this.validatedEventSequence = rows.at(-1)?.sequence ?? this.validatedEventSequence;
      return;
    }
    const first = invalid[0]!;
    throw new KudosError(
      first.error.code,
      `Cannot write while canonical event ${first.id} is unsupported or malformed; upgrade Agent Kudos or inspect with kudos doctor and export.`,
      { eventIds: invalid.map((item) => item.id) },
    );
  }

  rawEventRows(): EventRow[] {
    return this.db()
      .prepare('SELECT id, payload FROM events ORDER BY created_at ASC, id ASC')
      .all() as unknown as EventRow[];
  }

  private parseEvent(row: EventRow): KudosEvent {
    try {
      const value = JSON.parse(row.payload) as unknown;
      if (typeof value === 'object' && value !== null) {
        const candidate = value as { schemaVersion?: unknown; type?: unknown };
        const supportedTypes = new Set([
          'agent.created',
          'agent.updated',
          'kudos.given',
          'kudos.acknowledged',
          'kudos.revoked',
        ]);
        if (
          (typeof candidate.schemaVersion === 'number' && candidate.schemaVersion > 1) ||
          (typeof candidate.type === 'string' && !supportedTypes.has(candidate.type))
        ) {
          throw new KudosError(
            'UNSUPPORTED_EVENT',
            `Event ${row.id} was written by a newer or incompatible Agent Kudos version.`,
          );
        }
      }
      return eventSchema.parse(value);
    } catch (error) {
      if (error instanceof KudosError) throw error;
      throw new KudosError(
        'INVALID_EVENT',
        `Unsupported or malformed event ${row.id} in canonical storage.`,
        {
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  insertAgent(profile: AgentProfile): void {
    const parsed = profileSchema.parse(profile);
    this.db()
      .prepare(
        'INSERT INTO agents(id, display_name, profile_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        parsed.id,
        parsed.displayName,
        JSON.stringify(parsed),
        parsed.createdAt,
        parsed.createdAt,
      );
    for (const alias of parsed.aliases ?? []) {
      this.db().prepare('INSERT INTO aliases(alias, agent_id) VALUES (?, ?)').run(alias, parsed.id);
    }
  }

  updateAgent(profile: AgentProfile, updatedAt: string): void {
    const parsed = profileSchema.parse(profile);
    this.db()
      .prepare('UPDATE agents SET display_name = ?, profile_json = ?, updated_at = ? WHERE id = ?')
      .run(parsed.displayName, JSON.stringify(parsed), updatedAt, parsed.id);
    this.db().prepare('DELETE FROM aliases WHERE agent_id = ?').run(parsed.id);
    for (const alias of parsed.aliases ?? []) {
      this.db().prepare('INSERT INTO aliases(alias, agent_id) VALUES (?, ?)').run(alias, parsed.id);
    }
  }

  getAgent(idOrAlias: string): AgentProfile | undefined {
    const direct = this.db()
      .prepare('SELECT profile_json FROM agents WHERE id = ?')
      .get(idOrAlias) as ProfileRow | undefined;
    if (direct) return profileSchema.parse(JSON.parse(direct.profile_json));
    const alias = this.db()
      .prepare(
        'SELECT a.profile_json FROM agents a JOIN aliases x ON x.agent_id = a.id WHERE x.alias = ?',
      )
      .get(idOrAlias) as ProfileRow | undefined;
    return alias ? profileSchema.parse(JSON.parse(alias.profile_json)) : undefined;
  }

  listAgents(): AgentProfile[] {
    const rows = this.db()
      .prepare('SELECT profile_json FROM agents ORDER BY id ASC')
      .all() as unknown as ProfileRow[];
    return rows.map((row) => profileSchema.parse(JSON.parse(row.profile_json)));
  }

  replaceProjectionManifest(paths: string[], generatedAt: string): void {
    this.transaction(() => {
      this.db().prepare('DELETE FROM projection_manifest').run();
      const insert = this.db().prepare(
        'INSERT INTO projection_manifest(path, generated_at) VALUES (?, ?)',
      );
      for (const path of paths) insert.run(path, generatedAt);
    });
  }

  replaceAgentProjectionManifest(agentId: string, paths: string[], generatedAt: string): void {
    this.transaction(() => {
      this.db()
        .prepare('DELETE FROM projection_manifest WHERE path LIKE ? OR path LIKE ?')
        .run(`${agentId}/%`, `${agentId}\\%`);
      const insert = this.db().prepare(
        'INSERT INTO projection_manifest(path, generated_at) VALUES (?, ?)',
      );
      for (const path of paths) insert.run(path, generatedAt);
    });
  }

  projectionManifest(): string[] {
    return (
      this.db().prepare('SELECT path FROM projection_manifest ORDER BY path').all() as unknown as {
        path: string;
      }[]
    ).map((row) => row.path);
  }

  integrityCheck(): string[] {
    const rows = this.db().prepare('PRAGMA integrity_check').all() as unknown as Record<
      string,
      string
    >[];
    return rows.map((row) => Object.values(row)[0] ?? 'unknown');
  }

  journalMode(): string {
    const row = this.db().prepare('PRAGMA journal_mode').get() as Record<string, string>;
    return Object.values(row)[0] ?? 'unknown';
  }

  async backup(destination: string): Promise<string> {
    this.assertWritable();
    const output = resolve(destination);
    if (existsSync(output)) {
      throw new KudosError(
        'INVALID_INPUT',
        `Backup destination already exists: ${basename(output)}`,
      );
    }
    ensureDirectory(dirname(output));
    const temporaryDirectory = mkdtempSync(join(dirname(output), '.agent-kudos-backup-'));
    chmodSync(temporaryDirectory, 0o700);
    const temporaryOutput = join(temporaryDirectory, basename(output));
    try {
      const escaped = temporaryOutput.replaceAll("'", "''");
      this.db().exec(`VACUUM INTO '${escaped}'`);
      chmodSync(temporaryOutput, 0o600);
      linkSync(temporaryOutput, output);
      unlinkSync(temporaryOutput);
      return output;
    } finally {
      if (existsSync(temporaryOutput)) unlinkSync(temporaryOutput);
      rmdirSync(temporaryDirectory);
    }
  }

  private restrictDatabaseFiles(): void {
    if (this.readOnly) return;
    for (const path of [
      this.databasePath,
      `${this.databasePath}-wal`,
      `${this.databasePath}-shm`,
    ]) {
      if (existsSync(path)) chmodSync(path, 0o600);
    }
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
  }
}
