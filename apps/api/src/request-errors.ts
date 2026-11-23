import type { FastifyRequest } from 'fastify';

/** Domain conflicts thrown as plain `Error(code)` from inside transactions. */
export const CONFLICT_CODES = ['ASSIST_ACTIVE_ATTEMPT', 'INVALID_STATE_TRANSITION', 'CONFIRMATION_EVIDENCE_REQUIRED', 'RECRUITMENT_STAGE_CANNOT_REGRESS', 'STALE_APPLICATION_VERSION'] as const;
export type ConflictCode = typeof CONFLICT_CODES[number];
export const isConflictCode = (value: unknown): value is ConflictCode => typeof value === 'string' && (CONFLICT_CODES as readonly string[]).includes(value);

export type ErrorResponse = { status: number; code: string };

const domainCode = /^[A-Z][A-Z0-9_]{2,60}$/u;

/**
 * The SQLSTATE of a failed query. The query builder wraps the driver's error and keeps it as `cause`, so the code is
 * read from the error itself or from what caused it.
 */
function databaseErrorCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/u.test(code)) return code;
    current = cause;
  }
  return undefined;
}

/**
 * Maps an error that escaped a route to the `{ error: CODE }` contract the dashboard translates.
 *
 * A mistake in the request (malformed JSON, a body over the limit, an identifier that is not a UUID) is answered as a
 * 4xx the person can act on; only failures of the service itself are reported, and logged, as INTERNAL_ERROR.
 */
export function errorResponse(error: unknown): ErrorResponse {
  const { statusCode, code, message } = (error ?? {}) as { statusCode?: unknown; code?: unknown; message?: unknown };
  if (statusCode === 429) return { status: 429, code: 'RATE_LIMIT_EXCEEDED' };
  if (isConflictCode(message)) return { status: 409, code: message };
  // PostgreSQL: unique violation, and text that cannot be read as the column type (a path id that is not a UUID).
  const sqlState = databaseErrorCode(error);
  if (sqlState === '23505') return { status: 409, code: 'DUPLICATE_RECORD' };
  if (sqlState === '22P02') return { status: 400, code: 'INVALID_INPUT' };
  if (typeof statusCode === 'number' && Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500) {
    if (statusCode === 404) return { status: 404, code: 'NOT_FOUND' };
    // Fastify's own parser and validation errors (FST_ERR_…) are not part of the dashboard's vocabulary.
    const known = typeof code === 'string' && domainCode.test(code) && !code.startsWith('FST_');
    return { status: statusCode, code: known ? code : 'INVALID_INPUT' };
  }
  return { status: 500, code: 'INTERNAL_ERROR' };
}

export const READ_LIMIT_PER_MINUTE = 1200;
export const WRITE_LIMIT_PER_MINUTE = 120;
const isRead = (method: string) => method === 'GET' || method === 'HEAD' || method === 'OPTIONS';

/**
 * Reads and writes are counted separately. One screen opens with a dozen reads and several panels poll while they are
 * visible, so a single shared budget made ordinary use of a one-person local app answer "too many actions". Writes,
 * which include every sign-in attempt, keep the original budget.
 */
export const rateLimitOptions = {
  timeWindow: '1 minute',
  keyGenerator: (request: Pick<FastifyRequest, 'ip' | 'method'>) => `${request.ip}:${isRead(request.method) ? 'read' : 'write'}`,
  max: (request: Pick<FastifyRequest, 'method'>) => (isRead(request.method) ? READ_LIMIT_PER_MINUTE : WRITE_LIMIT_PER_MINUTE),
};
