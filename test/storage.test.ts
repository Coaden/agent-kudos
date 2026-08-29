import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { KudosClient } from '../src/index.js';
import { tempHome, testClient } from './helpers.js';

describe('SQLite storage and projections', () => {
  it('enforces append-only canonical events at the database layer', async () => {
    const home = tempHome();
    const client = await testClient(home);
    await client.agents.create({ id: 'codex', displayName: 'Codex' });
    expect(() => client.storage.db().prepare("UPDATE events SET type = 'changed'").run()).toThrow(
      /append-only/,
    );
    expect(() => client.storage.db().prepare('DELETE FROM events').run()).toThrow(/append-only/);
    await client.close();
  });

  it('builds escaped deterministic projections and preserves human-owned files', async () => {
    const home = tempHome();
    const client = await testClient(home);
    await client.agents.create({ id: 'codex', displayName: 'Codex <Prime>' });
    const notesPath = join(home, 'codex', 'NOTES.md');
    writeFileSync(notesPath, 'Troy owns this.\n');
    const given = await client.kudos.give({
      recipientAgentId: 'codex',
      title: '# Review *win*',
      reason: '<script>alert(1)</script> caught before merge.',
      evidence: [{ kind: 'file', value: 'src/client.ts' }],
    });
    const inboxPath = join(home, 'codex', 'inbox', `${given.record.event.id}.md`);
    expect(readFileSync(join(home, 'codex', 'WINS.md'), 'utf8')).toContain('\\# Review \\*win\\*');
    expect(readFileSync(join(home, 'codex', 'WINS.md'), 'utf8')).toContain('&lt;script&gt;');
    expect(readFileSync(notesPath, 'utf8')).toBe('Troy owns this.\n');
    expect(existsSync(inboxPath)).toBe(true);

    const unrelated = join(home, 'codex', 'inbox', 'human-note.md');
    writeFileSync(unrelated, 'Never delete me.\n');
    await client.kudos.acknowledge({ kudosId: given.record.event.id });
    expect(existsSync(inboxPath)).toBe(false);
    expect(readFileSync(unrelated, 'utf8')).toBe('Never delete me.\n');
    const first = readFileSync(join(home, 'codex', 'WINS.md'), 'utf8');
    client.projections.rebuild();
    expect(readFileSync(join(home, 'codex', 'WINS.md'), 'utf8')).toBe(first);
    await client.close();
  });

  it('renders legacy multiline titles once without allowing heading injection', async () => {
    const home = tempHome();
    const client = await testClient(home);
    await client.agents.create({ id: 'codex', displayName: 'Codex' });
    const id = '01ARZ3NDEKTSV4RRFFQ69G5FAA';
    client.storage.transaction(() =>
      client.storage.insertEvent({
        schemaVersion: 1,
        id,
        type: 'kudos.given',
        createdAt: new Date().toISOString(),
        actor: { kind: 'human', id: 'troy' },
        recipientAgentId: 'codex',
        recipientDisplayName: 'Codex',
        title: 'First line\n# Injected heading',
        reason: 'Legacy event created before titles became single-line input.',
        visibility: 'local',
      }),
    );
    client.projections.rebuild();
    const inbox = readFileSync(join(home, 'codex', 'inbox', `${id}.md`), 'utf8');
    expect(inbox.match(/First line/g)).toHaveLength(1);
    expect(inbox.match(/Injected heading/g)).toHaveLength(1);
    expect(inbox).toContain('\\# Injected heading');
    await client.close();
  });

  it('rejects symlink traversal outside the configured home', async () => {
    const home = tempHome();
    const outside = tempHome();
    const client = await testClient(home);
    symlinkSync(outside, join(home, 'codex'));
    await expect(client.agents.create({ id: 'codex', displayName: 'Codex' })).rejects.toMatchObject(
      {
        code: 'UNSAFE_PATH',
      },
    );
    await client.close();
  });

  it('isolates unsupported rows for reads and raw export while failing closed on writes', async () => {
    const home = tempHome();
    const client = await testClient(home);
    await client.agents.create({ id: 'codex', displayName: 'Codex' });
    const unsupportedId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    client.storage
      .db()
      .prepare(
        `INSERT INTO events(id, schema_version, type, created_at, actor_kind, actor_id, payload, sequence)
         VALUES (?, 1, 'unknown', ?, 'system', 'test', ?,
           (SELECT COALESCE(MAX(sequence), 0) + 1 FROM events))`,
      )
      .run(
        unsupportedId,
        new Date().toISOString(),
        JSON.stringify({
          schemaVersion: 1,
          id: unsupportedId,
          type: 'kudos.future',
          createdAt: new Date().toISOString(),
          actor: { kind: 'system', id: 'future' },
        }),
      );
    const doctor = await client.doctor();
    expect(doctor.healthy).toBe(false);
    expect(
      doctor.diagnostics.some(
        (item) => item.code === 'UNSUPPORTED_EVENT' && item.message.includes(unsupportedId),
      ),
    ).toBe(true);
    expect((await client.kudos.list()).total).toBe(0);
    expect(await client.export('jsonl')).toContain('kudos.future');
    expect(await client.export('json')).toContain(unsupportedId);
    await expect(
      client.kudos.give({
        recipientAgentId: 'codex',
        title: 'Unsafe write',
        reason: 'Must not write across an event stream with unknown semantics.',
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_EVENT' });
    await client.close();

    const otherHome = tempHome();
    const initialized = await testClient(otherHome);
    const dbPath = initialized.storage.databasePath;
    await initialized.close();
    const raw = new DatabaseSync(dbPath);
    raw.exec('PRAGMA user_version = 3');
    raw.close();
    const unsupported = new KudosClient({ home: otherHome, readOnly: true });
    await expect(unsupported.init()).rejects.toMatchObject({ code: 'UNSUPPORTED_SCHEMA' });
  });

  it('creates a consistent independent backup', async () => {
    const home = tempHome();
    const client = await testClient(home);
    await client.agents.create({ id: 'codex', displayName: 'Codex' });
    const backup = join(tempHome(), 'kudos-backup.sqlite3');
    await client.backup(backup);
    await client.close();
    const database = new DatabaseSync(backup, { readOnly: true });
    const count = database.prepare('SELECT COUNT(*) AS count FROM events').get() as {
      count: number;
    };
    expect(count.count).toBe(1);
    expect(
      (database.prepare('PRAGMA integrity_check').get() as { integrity_check: string })
        .integrity_check,
    ).toBe('ok');
    database.close();
    if (process.platform !== 'win32') {
      expect(statSync(backup).mode & 0o777).toBe(0o600);
    }
  });

  it('keeps live SQLite files private to the filesystem owner', async () => {
    const home = tempHome();
    const client = await testClient(home);
    await client.agents.create({ id: 'codex', displayName: 'Codex' });
    if (process.platform !== 'win32') {
      const files = readdirSync(join(home, 'kudos')).filter((name) => name.includes('sqlite3'));
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        expect(statSync(join(home, 'kudos', file)).mode & 0o777).toBe(0o600);
      }
    }
    await client.close();
  });

  it('rolls back all writes when a transaction fails', async () => {
    const client = await testClient(tempHome());
    expect(() =>
      client.storage.transaction(() => {
        client.storage.insertAgent({
          id: 'rollback',
          displayName: 'Rollback',
          createdAt: new Date().toISOString(),
        });
        throw new Error('force rollback');
      }),
    ).toThrow('force rollback');
    expect(client.storage.getAgent('rollback')).toBeUndefined();
    await client.close();
  });

  it('migrates an empty version-zero database transactionally', async () => {
    const home = tempHome();
    const kudosDirectory = join(home, 'kudos');
    mkdirSync(kudosDirectory);
    const path = join(kudosDirectory, 'agent-kudos.sqlite3');
    new DatabaseSync(path).close();
    const client = await testClient(home);
    expect(
      (client.storage.db().prepare('PRAGMA user_version').get() as { user_version: number })
        .user_version,
    ).toBe(2);
    expect(
      (
        client.storage.db().prepare('SELECT COUNT(*) AS count FROM schema_migrations').get() as {
          count: number;
        }
      ).count,
    ).toBe(2);
    await client.close();
  });

  it('migrates version one events into the sequence and current-state index', async () => {
    const home = tempHome();
    const initial = await testClient(home);
    await initial.agents.create({ id: 'codex', displayName: 'Codex' });
    const given = await initial.kudos.give({
      recipientAgentId: 'codex',
      title: 'Pre-index recognition',
      reason: 'Represents a record created under database schema version one.',
    });
    const path = initial.storage.databasePath;
    await initial.close();

    const legacy = new DatabaseSync(path);
    legacy.exec(`
      DROP TRIGGER events_sequence_required;
      DROP INDEX events_sequence;
      DROP TABLE kudos_current;
      ALTER TABLE events DROP COLUMN sequence;
      DELETE FROM schema_migrations WHERE version = 2;
      PRAGMA user_version = 1;
    `);
    legacy.close();

    const migrated = await testClient(home);
    expect(
      (migrated.storage.db().prepare('PRAGMA user_version').get() as { user_version: number })
        .user_version,
    ).toBe(2);
    expect((await migrated.kudos.list()).items[0]?.id).toBe(given.record.event.id);
    expect(migrated.storage.currentIndexCounts()).toEqual({ given: 1, indexed: 1 });
    await migrated.close();
  });

  it('diagnoses and rebuilds a missing current-state index row', async () => {
    const client = await testClient(tempHome());
    await client.agents.create({ id: 'codex', displayName: 'Codex' });
    await client.kudos.give({
      recipientAgentId: 'codex',
      title: 'Recoverable recognition',
      reason: 'Canonical history can recreate a damaged derived query index.',
    });
    client.storage.db().prepare('DELETE FROM kudos_current').run();
    expect(await client.doctor()).toMatchObject({ healthy: false });
    client.projections.rebuild();
    expect((await client.kudos.list()).total).toBe(1);
    expect(await client.doctor()).toMatchObject({ healthy: true });
    await client.close();
  });

  it('keeps give latency practical with a realistic pending inbox', async () => {
    const client = await testClient(tempHome());
    await client.agents.create({ id: 'codex', displayName: 'Codex' });
    const started = performance.now();
    for (let index = 0; index < 100; index += 1) {
      await client.kudos.give({
        recipientAgentId: 'codex',
        title: `Scale contribution ${index}`,
        reason: 'Exercises incremental projection maintenance with pending recognition.',
      });
    }
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(10_000);
    expect(readdirSync(join(client.home, 'codex', 'inbox'))).toHaveLength(100);
    await client.close();
  }, 15_000);

  it('keeps discovery responses bounded with five thousand kudos', async () => {
    const client = await testClient(
      tempHome(),
      { kind: 'human', id: 'scale-test' },
      {
        config: { projection: { writeWinsMarkdown: false, writeInboxEntries: false } },
      },
    );
    await client.agents.create({ id: 'codex', displayName: 'Codex' });
    client.storage.transaction(() => {
      for (let index = 0; index < 5_000; index += 1) {
        client.storage.insertEvent({
          schemaVersion: 1,
          id: ulid(1_700_000_000_000 + index),
          type: 'kudos.given',
          createdAt: new Date(1_700_000_000_000 + index).toISOString(),
          actor: { kind: 'human', id: 'scale-test' },
          recipientAgentId: 'codex',
          recipientDisplayName: 'Codex',
          title: `Bounded discovery ${index}`,
          reason: 'This full detail must not appear in compact list responses.',
          tags: ['scale'],
          visibility: 'local',
        });
      }
    });

    const first = await client.kudos.list();
    expect(first.total).toBe(5_000);
    expect(first.items).toHaveLength(10);
    expect(first.hasMore).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(first), 'utf8')).toBeLessThan(26_000);
    expect(first.items[0]).not.toHaveProperty('reason');
    const second = await client.kudos.list({ cursor: first.nextCursor! });
    expect(second.items).toHaveLength(10);
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    await client.close();
  });

  it('shortens unusually wide summary pages at the byte budget', async () => {
    const client = await testClient(tempHome(), {
      kind: 'human',
      id: 'wide-test',
      displayName: 'W'.repeat(200),
    });
    await client.agents.create({ id: 'codex', displayName: 'C'.repeat(200) });
    const tags = Array.from({ length: 20 }, (_, index) => `tag-${index}-${'x'.repeat(50)}`);
    client.storage.transaction(() => {
      for (let index = 0; index < 50; index += 1) {
        client.storage.insertEvent({
          schemaVersion: 1,
          id: ulid(1_800_000_000_000 + index),
          type: 'kudos.given',
          createdAt: new Date(1_800_000_000_000 + index).toISOString(),
          actor: client.actor,
          recipientAgentId: 'codex',
          recipientDisplayName: 'C'.repeat(200),
          title: `Wide ${index} ${'T'.repeat(180)}`,
          reason: 'The summary excludes this detail.',
          tags,
          visibility: 'local',
        });
      }
    });

    const page = await client.kudos.list({ limit: 50 });
    expect(page.contextLimited).toBe(true);
    expect(page.hasMore).toBe(true);
    expect(page.items.length).toBeLessThan(50);
    expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThan(26_000);
    expect(page.nextCursor).toBeDefined();
    await client.close();
  });

  it('handles concurrent writers without lost or duplicate events', async () => {
    const home = tempHome();
    const setup = await testClient(home);
    await setup.agents.create({ id: 'codex', displayName: 'Codex' });
    await setup.close();
    const moduleUrl = pathToFileURL(join(process.cwd(), 'dist', 'index.js')).href;
    const workerSource = `
      import { parentPort, workerData } from 'node:worker_threads';
      const { KudosClient } = await import(workerData.moduleUrl);
      try {
        const client = new KudosClient({
          home: workerData.home,
          actor: { kind: 'agent', id: workerData.actor }
        });
        await client.init();
        for (let i = 0; i < 8; i++) {
          await client.kudos.give({
            recipientAgentId: 'codex',
            title: 'Concurrent contribution ' + workerData.actor + '-' + i,
            reason: 'Recorded during a concurrent writer stress test.',
            idempotencyKey: workerData.actor + '-' + i
          });
        }
        await client.close();
        parentPort.postMessage({ ok: true });
      } catch (error) {
        parentPort.postMessage({ ok: false, error: error?.stack ?? String(error) });
      }
    `;
    const results = await Promise.all(
      ['one', 'two', 'three', 'four'].map(
        (actorId) =>
          new Promise<{ ok: boolean; error?: string }>((resolveWorker, rejectWorker) => {
            const worker = new Worker(
              new URL(`data:text/javascript,${encodeURIComponent(workerSource)}`),
              { workerData: { home, moduleUrl, actor: actorId } },
            );
            worker.once('message', resolveWorker);
            worker.once('error', rejectWorker);
          }),
      ),
    );
    expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }, { ok: true }]);
    const inspect = await testClient(home, { kind: 'system', id: 'inspect' });
    const page = await inspect.kudos.list({ limit: 50 });
    expect(page.total).toBe(32);
    expect(new Set(page.items.map((item) => item.id)).size).toBe(32);
    await inspect.close();
  });

  it('waits for a bounded interval and reports a busy database', async () => {
    const home = tempHome();
    const setup = await testClient(home);
    await setup.agents.create({ id: 'codex', displayName: 'Codex' });
    const databasePath = setup.storage.databasePath;
    await setup.close();

    const lock = new DatabaseSync(databasePath);
    lock.exec('PRAGMA journal_mode = WAL; BEGIN IMMEDIATE');
    const contender = await testClient(home, { kind: 'human', id: 'contender' });
    try {
      contender.storage.db().exec('PRAGMA busy_timeout = 50');
      const started = performance.now();
      await expect(
        contender.kudos.give({
          recipientAgentId: 'codex',
          title: 'Contended write',
          reason: 'Verifies bounded SQLite busy handling.',
        }),
      ).rejects.toMatchObject({ code: 'DATABASE_BUSY' });
      expect(performance.now() - started).toBeLessThan(1_000);
    } finally {
      await contender.close();
      lock.exec('ROLLBACK');
      lock.close();
    }
  });
});
