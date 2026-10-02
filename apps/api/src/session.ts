import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { config } from './config.js';

const cookieName = 'career_session';
const mac = (value: string) => createHmac('sha256', config.APP_SESSION_SECRET).update(value).digest('base64url');
const trustedHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

export function enforceLocalRequest(request: FastifyRequest, reply: FastifyReply) {
  const host = request.headers.host?.split(':')[0]?.toLowerCase();
  if (!host || !trustedHosts.has(host)) return reply.code(403).send({ error: 'HOST_NOT_ALLOWED' });
  const remote = request.ip.replace(/^::ffff:/, '');
  if (!['127.0.0.1', '::1'].includes(remote)) return reply.code(403).send({ error: 'LOCAL_ONLY' });
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
    const origin = request.headers.origin;
    if (!origin) return reply.code(403).send({ error: 'ORIGIN_REQUIRED' });
    try { if (new URL(origin).origin !== config.WEB_ORIGIN) return reply.code(403).send({ error: 'ORIGIN_NOT_ALLOWED' }); }
    catch { return reply.code(403).send({ error: 'ORIGIN_NOT_ALLOWED' }); }
  }
}

export function issueSession(workspaceId: string) {
  const payload = Buffer.from(JSON.stringify({ workspaceId, exp: Date.now() + 1000 * 60 * 60 * 24 * 14 })).toString('base64url');
  return `${payload}.${mac(payload)}`;
}

export function workspaceFromRequest(request: FastifyRequest): string | null {
  const raw = request.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  if (!raw) return null;
  const [payload, signature] = raw.split('.');
  if (!payload || !signature) return null;
  const expected = Buffer.from(mac(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { workspaceId: string; exp: number };
    return value.exp > Date.now() ? value.workspaceId : null;
  } catch { return null; }
}

export function sessionCookie(value: string) { return `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=1209600`; }
export function expiredSessionCookie() { return `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`; }
