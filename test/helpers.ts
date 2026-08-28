import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { KudosClient } from '../src/index.js';
import type { ActorIdentity, KudosClientOptions } from '../src/types.js';

const temporaryHomes: string[] = [];

export function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'agent-kudos-test-'));
  temporaryHomes.push(home);
  return home;
}

export async function testClient(
  home: string,
  actor: ActorIdentity = { kind: 'human', id: 'troy', displayName: 'Troy' },
  options: Omit<KudosClientOptions, 'home' | 'actor'> = {},
): Promise<KudosClient> {
  const client = new KudosClient({ home, actor, ...options });
  await client.init();
  return client;
}

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});
