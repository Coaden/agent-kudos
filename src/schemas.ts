import { isAbsolute, normalize } from 'node:path';
import { z } from 'zod';
import type { JsonValue } from './types.js';

const reservedIds = new Set([
  '.',
  '..',
  'kudos',
  'exports',
  'inbox',
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'lpt1',
]);

export const agentIdSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase ASCII letters, digits, and hyphens')
  .refine((id) => !reservedIds.has(id), 'Reserved agent ID');

export const actorSchema = z.object({
  kind: z.enum(['human', 'agent', 'system']),
  id: agentIdSchema,
  displayName: z.string().trim().min(1).max(200).optional(),
});

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const metadataSchema = z.record(z.string().max(200), jsonValueSchema);

export const sourceSchema = z.object({
  runtime: z.string().trim().min(1).max(200).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  sessionId: z.string().trim().min(1).max(500).optional(),
  repository: z.string().trim().min(1).max(1000).optional(),
  commit: z.string().trim().min(1).max(200).optional(),
  workingDirectory: z.string().trim().min(1).max(2000).optional(),
});

function isSafeFileEvidence(value: string): boolean {
  const normalized = normalize(value);
  return (
    !isAbsolute(value) &&
    normalized !== '..' &&
    !normalized.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  );
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

export const evidenceSchema = z
  .object({
    kind: z.enum(['tool-call', 'commit', 'file', 'url', 'task', 'note']),
    label: z.string().trim().min(1).max(200).optional(),
    value: z.string().trim().min(1).max(2000),
  })
  .superRefine((evidence, context) => {
    if (evidence.kind === 'url' && !isHttpUrl(evidence.value)) {
      context.addIssue({ code: 'custom', message: 'URL evidence must use http or https' });
    }
    if (evidence.kind === 'file' && !isSafeFileEvidence(evidence.value)) {
      context.addIssue({ code: 'custom', message: 'File evidence must be a safe relative path' });
    }
  });

export const profileSchema = z.object({
  id: agentIdSchema,
  displayName: z.string().trim().min(1).max(200),
  aliases: z.array(agentIdSchema).max(50).optional(),
  description: z.string().trim().max(2000).optional(),
  createdAt: z.string().datetime({ offset: true }),
  metadata: metadataSchema.optional(),
});

export const createAgentSchema = profileSchema.omit({ createdAt: true });
export const updateAgentSchema = createAgentSchema.omit({ id: true }).partial();

const baseEventSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  createdAt: z.string().datetime({ offset: true }),
  actor: actorSchema,
  source: sourceSchema.optional(),
  metadata: metadataSchema.optional(),
});

export const kudosTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^\r\n]+$/, 'Kudos titles must be a single line');

export const kudosTagSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u);

const kudosGivenSchema = baseEventSchema.extend({
  type: z.literal('kudos.given'),
  recipientAgentId: agentIdSchema,
  recipientDisplayName: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(5000),
  evidence: z.array(evidenceSchema).max(50).optional(),
  tags: z.array(kudosTagSchema).max(50).optional(),
  visibility: z.enum(['private', 'local', 'public']),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
});

const acknowledgedSchema = baseEventSchema.extend({
  type: z.literal('kudos.acknowledged'),
  kudosId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  recipientAgentId: agentIdSchema,
  note: z.string().trim().min(1).max(2000).optional(),
});

const revokedSchema = baseEventSchema.extend({
  type: z.literal('kudos.revoked'),
  kudosId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  reason: z.string().trim().min(1).max(2000),
  mode: z.enum(['actor-requested', 'administrative']),
});

const agentCreatedSchema = baseEventSchema.extend({
  type: z.literal('agent.created'),
  agent: profileSchema,
});

const agentUpdatedSchema = baseEventSchema.extend({
  type: z.literal('agent.updated'),
  agentId: agentIdSchema,
  changes: updateAgentSchema,
});

export const eventSchema = z.discriminatedUnion('type', [
  kudosGivenSchema,
  acknowledgedSchema,
  revokedSchema,
  agentCreatedSchema,
  agentUpdatedSchema,
]);

export const giveKudosSchema = kudosGivenSchema
  .omit({
    schemaVersion: true,
    id: true,
    type: true,
    createdAt: true,
    actor: true,
    recipientDisplayName: true,
  })
  .extend({ title: kudosTitleSchema });

export const listInputSchema = z.object({
  recipientAgentId: agentIdSchema.optional(),
  actorId: agentIdSchema.optional(),
  actorKind: z.enum(['human', 'agent', 'system']).optional(),
  tag: z.string().trim().min(1).max(64).optional(),
  status: z.enum(['acknowledged', 'unacknowledged']).optional(),
  visibility: z.enum(['private', 'local', 'public']).optional(),
  revoked: z.boolean().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});
