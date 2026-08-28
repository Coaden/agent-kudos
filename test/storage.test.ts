import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
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

  it('reports malformed rows and unsupported schema versions', async () => {
    const home = tempHome();
    const client = await testClient(home);
    client.storage
      .db()
      .prepare(
        `INSERT INTO events(id, schema_version, type, created_at, actor_kind, actor_id, payload)
         VALUES (?, 1, 'unknown', ?, 'system', 'test', ?)`,
      )
      .run('01ARZ3NDEKTSV4RRFFQ69G5FAV', new Date().toISOString(), '{"schemaVersion":1}');
    const doctor = await client.doctor();
    expect(doctor.healthy).toBe(false);
    expect(doctor.diagnostics.some((item) => item.code === 'INVALID_EVENT')).toBe(true);
    await client.close();

    const otherHome = tempHome();
    const initialized = await testClient(otherHome);
    const dbPath = initialized.storage.databasePath;
    await initialized.close();
    const raw = new DatabaseSync(dbPath);
    raw.exec('PRAGMA user_version = 2');
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
    const page = await inspect.kudos.list({ limit: 200 });
    expect(page.total).toBe(32);
    expect(new Set(page.items.map((item) => item.event.id)).size).toBe(32);
    await inspect.close();
  });
});
