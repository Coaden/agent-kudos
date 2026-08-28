export const errorCodes = [
  'INVALID_INPUT',
  'INVALID_AGENT_ID',
  'INVALID_EVENT',
  'AGENT_NOT_FOUND',
  'AGENT_EXISTS',
  'ALIAS_CONFLICT',
  'KUDOS_NOT_FOUND',
  'SELF_AWARD_FORBIDDEN',
  'ACKNOWLEDGMENT_FORBIDDEN',
  'REVOCATION_FORBIDDEN',
  'READ_ONLY',
  'DATABASE_BUSY',
  'DATABASE_CORRUPT',
  'UNSUPPORTED_SCHEMA',
  'UNSAFE_PATH',
  'POLICY_FORBIDDEN',
  'CONFIG_INVALID',
  'INTERNAL_ERROR',
] as const;

export type KudosErrorCode = (typeof errorCodes)[number];

export class KudosError extends Error {
  readonly code: KudosErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: KudosErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'KudosError';
    this.code = code;
    this.details = details;
  }
}

export function asKudosError(error: unknown): KudosError {
  if (error instanceof KudosError) return error;
  if (error instanceof ZodError) {
    return new KudosError('INVALID_INPUT', 'Input validation failed.', { issues: error.issues });
  }
  const message = error instanceof Error ? error.message : 'Unexpected Agent Kudos error';
  if (/SQLITE_BUSY|database is locked/i.test(message)) {
    return new KudosError('DATABASE_BUSY', 'The kudos database is busy; retry shortly.');
  }
  if (/malformed|not a database|database disk image/i.test(message)) {
    return new KudosError('DATABASE_CORRUPT', 'The kudos database failed an integrity check.');
  }
  return new KudosError('INTERNAL_ERROR', message);
}
import { ZodError } from 'zod';
