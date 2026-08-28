import { describe, expect, it } from 'vitest';
import { agentIdSchema, evidenceSchema, escapeMarkdown } from '../src/index.js';

describe('validation and escaping', () => {
  it.each(['codex', 'gracie-p-tienamme', 'agent-42'])('accepts agent ID %s', (id) => {
    expect(agentIdSchema.parse(id)).toBe(id);
  });

  it.each(['', '..', '../codex', 'Codex', 'co/dex', 'co\\dex', 'kudos', 'con', '-codex', 'codex-'])(
    'rejects unsafe or reserved agent ID %s',
    (id) => {
      expect(() => agentIdSchema.parse(id)).toThrow();
    },
  );

  it('validates URL and repository-relative file evidence', () => {
    expect(
      evidenceSchema.parse({ kind: 'url', value: 'https://example.com/task/17' }),
    ).toBeTruthy();
    expect(evidenceSchema.parse({ kind: 'file', value: 'src/client.ts' })).toBeTruthy();
    expect(() => evidenceSchema.parse({ kind: 'url', value: 'file:///etc/passwd' })).toThrow();
    expect(() => evidenceSchema.parse({ kind: 'file', value: '../../secret.env' })).toThrow();
    expect(() => evidenceSchema.parse({ kind: 'file', value: '/etc/passwd' })).toThrow();
  });

  it('escapes untrusted Markdown and HTML', () => {
    expect(escapeMarkdown('# <script>*boom*</script>')).toBe(
      '\\# &lt;script&gt;\\*boom\\*&lt;/script&gt;',
    );
  });
});
