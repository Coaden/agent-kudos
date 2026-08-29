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
import { eventSchema, profileSchema } from './schemas.js';
import type {
  AgentKudosConfig,
  AgentKudosConfigOverrides,
  AgentProfile,
  KudosEvent,
} from './types.js';

interface EventRow {
  id: string;
  payload: string;
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
    if (version > 1) {
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
  }

  private assertSchemaSupported(): void {
    const version = Number(
      (this.db().prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    );
    if (version !== 1) {
      throw new KudosError(
        'UNSUPPORTED_SCHEMA',
        `Expected database schema version 1; found ${version}.`,
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
    this.db()
      .prepare(
        `INSERT INTO events(
          id, schema_version, type, created_at, actor_kind, actor_id,
          recipient_agent_id, kudos_id, visibility, idempotency_key, payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    const invalid = this.scanEvents().invalid;
    if (!invalid.length) return;
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
