import type { FastifyInstance, FastifyRequest } from 'fastify';

const safeId = (value: unknown) => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  ? value
  : undefined;

/** Document request failures must never serialize source text, request bodies, or filesystem errors. */
export function logRequestFailure(app: FastifyInstance, error: unknown, request: FastifyRequest) {
  const route = request.routeOptions.url ?? '';
  if (!/\/(?:documents?|document-drafts|resume|cover-letter)(?:[-/]|$)/u.test(route)) {
    app.log.error({ err: error }, 'Request failed');
    return;
  }
  const params = request.params as Record<string, unknown>;
  const rawCode = (error as { code?: unknown } | null)?.code;
  const code = typeof rawCode === 'string' && /^[A-Z0-9_]{1,50}$/u.test(rawCode) ? rawCode : 'INTERNAL_ERROR';
  const applicationRoute = route.startsWith('/api/v1/applications/');
  const legacyDocumentRoute = route.startsWith('/api/v1/documents/');
  app.log.error({
    code,
    applicationId: safeId(params.applicationId) ?? (applicationRoute ? safeId(params.id) : undefined),
    documentId: safeId(params.documentId) ?? (legacyDocumentRoute ? safeId(params.id) : undefined),
    revisionId: safeId(params.revisionId),
  }, 'Application document request failed');
}
