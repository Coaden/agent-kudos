import { afterEach, describe, expect, it, vi } from 'vitest';
import { KudosClient, defaultConfig } from '../src/index.js';
import { mergeConfig } from '../src/config.js';
import { tempHome, testClient } from './helpers.js';

afterEach(() => vi.unstubAllEnvs());

describe('configuration and cancellation', () => {
  it('applies explicit options over environment, file values, and defaults', () => {
    vi.stubEnv('AGENT_KUDOS_DEFAULT_VISIBILITY', 'private');
    vi.stubEnv('AGENT_KUDOS_ALLOW_SELF_AWARDS', 'true');
    const config = mergeConfig(
      { ...defaultConfig, defaultVisibility: 'public', allowSelfAwards: false },
      { defaultVisibility: 'local' },
    );
    expect(config.defaultVisibility).toBe('local');
    expect(config.allowSelfAwards).toBe(true);
  });

  it('rejects malformed environment policy values', () => {
    vi.stubEnv('AGENT_KUDOS_ALLOW_SELF_AWARDS', '{"yes":true}');
    expect(() => mergeConfig(undefined)).toThrowError(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    );
  });

  it('returns stable typed errors for invalid public API input', async () => {
    const client = await testClient(tempHome());
    await expect(
      client.agents.create({ id: '../codex', displayName: 'Codex' }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await client.close();
  });

  it('honors an AbortSignal before filesystem work', async () => {
    const controller = new AbortController();
    controller.abort(new Error('Cancelled by test'));
    const client = new KudosClient({ home: tempHome(), signal: controller.signal });
    await expect(client.init()).rejects.toThrow('Cancelled by test');
  });
});
