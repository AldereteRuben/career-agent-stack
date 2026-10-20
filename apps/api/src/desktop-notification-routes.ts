import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, desktopNotificationEvents, desktopNotificationSettings } from '@career/db';
import { checkNativeNotificationAvailability, sendNativeAlert } from './native-notifications.js';

const SettingsSchema = z.object({ enabled: z.boolean(), language: z.enum(['en', 'es']) }).strict();
type Dependencies = { available?: typeof checkNativeNotificationAvailability; send?: typeof sendNativeAlert };

export function registerDesktopNotificationRoutes(app: FastifyInstance, workspace: (request: FastifyRequest) => string, dependencies: Dependencies = {}) {
  const available = dependencies.available ?? checkNativeNotificationAvailability;
  const send = dependencies.send ?? sendNativeAlert;

  app.get('/api/v1/notifications', async (request) => {
    const workspaceId = workspace(request);
    const row = (await db.select().from(desktopNotificationSettings).where(eq(desktopNotificationSettings.workspaceId, workspaceId)).limit(1))[0];
    const nativeAvailable = await available();
    return { enabled: row?.enabled ?? false, language: row?.language ?? 'en', status: nativeAvailable ? row?.lastStatus ?? 'NOT_TESTED' : 'UNAVAILABLE', available: nativeAvailable };
  });

  app.put('/api/v1/notifications', async (request, reply) => {
    const parsed = SettingsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_NOTIFICATION_SETTINGS' });
    const workspaceId = workspace(request);
    const nativeAvailable = await available();
    const lastStatus = nativeAvailable ? 'NOT_TESTED' : 'UNAVAILABLE';
    await db.transaction(async (tx) => {
      if (!parsed.data.enabled) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'desktop-notifications:' + workspaceId}, 0))`);
      await tx.insert(desktopNotificationSettings).values({ workspaceId, ...parsed.data, lastStatus })
        .onConflictDoUpdate({ target: desktopNotificationSettings.workspaceId, set: { ...parsed.data, lastStatus, updatedAt: new Date() } });
      if (!parsed.data.enabled) await tx.update(desktopNotificationEvents).set({ status: 'DISABLED', leaseUntil: null, lastError: null })
        .where(and(eq(desktopNotificationEvents.workspaceId, workspaceId), inArray(desktopNotificationEvents.status, ['PENDING','SENDING'])));
    });
    return { ...parsed.data, status: lastStatus, available: nativeAvailable };
  });

  app.post('/api/v1/notifications/test', async (request, reply) => {
    const workspaceId = workspace(request);
    const row = (await db.select().from(desktopNotificationSettings).where(eq(desktopNotificationSettings.workspaceId, workspaceId)).limit(1))[0];
    const language: 'en' | 'es' = row?.language === 'es' ? 'es' : 'en';
    const nativeAvailable = await available();
    if (!nativeAvailable) {
      await db.insert(desktopNotificationSettings).values({ workspaceId, enabled: row?.enabled ?? false, language, lastStatus: 'UNAVAILABLE', lastAttemptAt: new Date() })
        .onConflictDoUpdate({ target: desktopNotificationSettings.workspaceId, set: { lastStatus: 'UNAVAILABLE', lastAttemptAt: new Date(), updatedAt: new Date() } });
      return reply.code(503).send({ error: 'NATIVE_NOTIFICATIONS_UNAVAILABLE', status: 'UNAVAILABLE' });
    }
    try {
      await send({ title: language === 'es' ? 'Career Stack' : 'Career Stack', message: language === 'es' ? 'Esta es una notificación de prueba.' : 'This is a test notification.', language });
      await db.insert(desktopNotificationSettings).values({ workspaceId, enabled: row?.enabled ?? false, language, lastStatus: 'ACCEPTED', lastAttemptAt: new Date() })
        .onConflictDoUpdate({ target: desktopNotificationSettings.workspaceId, set: { lastStatus: 'ACCEPTED', lastAttemptAt: new Date(), updatedAt: new Date() } });
      return { status: 'ACCEPTED' };
    } catch {
      await db.insert(desktopNotificationSettings).values({ workspaceId, enabled: row?.enabled ?? false, language, lastStatus: 'FAILED', lastAttemptAt: new Date() })
        .onConflictDoUpdate({ target: desktopNotificationSettings.workspaceId, set: { lastStatus: 'FAILED', lastAttemptAt: new Date(), updatedAt: new Date() } });
      return reply.code(503).send({ error: 'NATIVE_NOTIFICATION_FAILED', status: 'FAILED' });
    }
  });
}
