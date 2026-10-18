import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { applications, applicationContacts, db, workspaceContacts } from '@career/db';

const addContactSchema = z.object({
  contactId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(160).optional(),
  profileUrl: z.string().trim().max(2048).nullable().optional(),
  role: z.string().trim().min(1).max(120),
  note: z.string().trim().max(3000).optional().default(''),
}).strict().superRefine((value, context) => {
  if (value.contactId && (value.name !== undefined || value.profileUrl !== undefined)) context.addIssue({ code: 'custom', message: 'Choose an existing contact or enter new contact details, not both.' });
  if (!value.contactId && !value.name) context.addIssue({ code: 'custom', message: 'A contact name is required.' });
});

const updateContactSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  profileUrl: z.string().trim().max(2048).nullable().optional(),
  role: z.string().trim().min(1).max(120).optional(),
  note: z.string().trim().max(3000).optional(),
}).strict().refine((value) => Object.keys(value).length > 0);

export function normalizeProfessionalProfileUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  let url: URL;
  try { url = new URL(trimmed); } catch { throw new Error('INVALID_PROFILE_URL'); }
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error('INVALID_PROFILE_URL');
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

type ContactLink = { id: string; contactId: string; name: string; profileUrl: string | null; role: string; note: string; createdAt: Date; updatedAt: Date };
type ContactDatabase = typeof db;

export function registerApplicationContactRoutes(app: FastifyInstance, workspace: (request: FastifyRequest) => string, database: ContactDatabase = db) {
  const linkedContacts = (workspaceId: string, applicationId: string) => database.select({
    id: applicationContacts.id, contactId: workspaceContacts.id, name: workspaceContacts.name,
    profileUrl: workspaceContacts.profileUrl, role: applicationContacts.role, note: applicationContacts.note,
    createdAt: applicationContacts.createdAt, updatedAt: applicationContacts.updatedAt,
  }).from(applicationContacts).innerJoin(workspaceContacts, and(eq(workspaceContacts.workspaceId, applicationContacts.workspaceId), eq(workspaceContacts.id, applicationContacts.contactId)))
    .where(and(eq(applicationContacts.workspaceId, workspaceId), eq(applicationContacts.applicationId, applicationId))).orderBy(asc(workspaceContacts.name), asc(applicationContacts.createdAt));

  app.get('/api/v1/applications/:id/contacts', async (request, reply) => {
    const workspaceId = workspace(request); const { id: applicationId } = request.params as { id: string };
    const exists = (await database.select({ id: applications.id }).from(applications).where(and(eq(applications.workspaceId, workspaceId), eq(applications.id, applicationId))).limit(1))[0];
    if (!exists) return reply.code(404).send({ error: 'NOT_FOUND' });
    const [links, contacts] = await Promise.all([
      linkedContacts(workspaceId, applicationId),
      database.select({ id: workspaceContacts.id, name: workspaceContacts.name, profileUrl: workspaceContacts.profileUrl })
        .from(workspaceContacts).where(eq(workspaceContacts.workspaceId, workspaceId)).orderBy(asc(workspaceContacts.name)),
    ]);
    return { links: links satisfies ContactLink[], contacts };
  });

  app.post('/api/v1/applications/:id/contacts', async (request, reply) => {
    const parsed = addContactSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    let profileUrl: string | null;
    try { profileUrl = normalizeProfessionalProfileUrl(parsed.data.profileUrl); }
    catch { return reply.code(400).send({ error: 'INVALID_PROFILE_URL' }); }
    const workspaceId = workspace(request); const { id: applicationId } = request.params as { id: string };
    const result = await database.transaction(async (tx) => {
      const application = (await tx.select({ id: applications.id }).from(applications).where(and(eq(applications.workspaceId, workspaceId), eq(applications.id, applicationId))).limit(1))[0];
      if (!application) return null;
      let contactId = parsed.data.contactId;
      if (contactId) {
        const contact = (await tx.select({ id: workspaceContacts.id }).from(workspaceContacts).where(and(eq(workspaceContacts.workspaceId, workspaceId), eq(workspaceContacts.id, contactId))).limit(1))[0];
        if (!contact) return null;
      } else {
        contactId = (await tx.insert(workspaceContacts).values({ workspaceId, name: parsed.data.name!, profileUrl }).returning({ id: workspaceContacts.id }))[0]!.id;
      }
      const link = (await tx.insert(applicationContacts).values({ workspaceId, applicationId, contactId, role: parsed.data.role, note: parsed.data.note }).returning())[0]!;
      const contact = (await tx.select({ name: workspaceContacts.name, profileUrl: workspaceContacts.profileUrl }).from(workspaceContacts).where(and(eq(workspaceContacts.workspaceId, workspaceId), eq(workspaceContacts.id, contactId))).limit(1))[0]!;
      return { id: link.id, contactId, ...contact, role: link.role, note: link.note, createdAt: link.createdAt, updatedAt: link.updatedAt } satisfies ContactLink;
    });
    if (!result) return reply.code(404).send({ error: 'NOT_FOUND' });
    return reply.code(201).send(result);
  });

  app.patch('/api/v1/applications/:id/contacts/:linkId', async (request, reply) => {
    const parsed = updateContactSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    let profileUrl: string | null | undefined;
    if (parsed.data.profileUrl !== undefined) {
      try { profileUrl = normalizeProfessionalProfileUrl(parsed.data.profileUrl); }
      catch { return reply.code(400).send({ error: 'INVALID_PROFILE_URL' }); }
    }
    const workspaceId = workspace(request); const { id: applicationId, linkId } = request.params as { id: string; linkId: string };
    const result = await database.transaction(async (tx) => {
      const current = (await tx.select({ contactId: applicationContacts.contactId }).from(applicationContacts)
        .where(and(eq(applicationContacts.workspaceId, workspaceId), eq(applicationContacts.applicationId, applicationId), eq(applicationContacts.id, linkId))).limit(1))[0];
      if (!current) return null;
      const contactChanges = { ...(parsed.data.name === undefined ? {} : { name: parsed.data.name }), ...(profileUrl === undefined ? {} : { profileUrl }), updatedAt: new Date() };
      if (Object.keys(contactChanges).length > 1) await tx.update(workspaceContacts).set(contactChanges).where(and(eq(workspaceContacts.workspaceId, workspaceId), eq(workspaceContacts.id, current.contactId)));
      const linkChanges = { ...(parsed.data.role === undefined ? {} : { role: parsed.data.role }), ...(parsed.data.note === undefined ? {} : { note: parsed.data.note }), updatedAt: new Date() };
      if (Object.keys(linkChanges).length > 1) await tx.update(applicationContacts).set(linkChanges).where(and(eq(applicationContacts.workspaceId, workspaceId), eq(applicationContacts.applicationId, applicationId), eq(applicationContacts.id, linkId)));
      return (await tx.select({ id: applicationContacts.id, contactId: workspaceContacts.id, name: workspaceContacts.name, profileUrl: workspaceContacts.profileUrl, role: applicationContacts.role, note: applicationContacts.note, createdAt: applicationContacts.createdAt, updatedAt: applicationContacts.updatedAt })
        .from(applicationContacts).innerJoin(workspaceContacts, and(eq(workspaceContacts.workspaceId, applicationContacts.workspaceId), eq(workspaceContacts.id, applicationContacts.contactId)))
        .where(and(eq(applicationContacts.workspaceId, workspaceId), eq(applicationContacts.applicationId, applicationId), eq(applicationContacts.id, linkId))).limit(1))[0] ?? null;
    });
    if (!result) return reply.code(404).send({ error: 'NOT_FOUND' });
    return result;
  });

  app.delete('/api/v1/applications/:id/contacts/:linkId', async (request, reply) => {
    const workspaceId = workspace(request); const { id: applicationId, linkId } = request.params as { id: string; linkId: string };
    const removed = await database.delete(applicationContacts).where(and(eq(applicationContacts.workspaceId, workspaceId), eq(applicationContacts.applicationId, applicationId), eq(applicationContacts.id, linkId))).returning({ id: applicationContacts.id });
    if (!removed.length) return reply.code(404).send({ error: 'NOT_FOUND' });
    return reply.code(204).send();
  });

  app.delete('/api/v1/contacts/:id', async (request, reply) => {
    const workspaceId = workspace(request); const { id } = request.params as { id: string };
    const removed = await database.delete(workspaceContacts).where(and(eq(workspaceContacts.workspaceId, workspaceId), eq(workspaceContacts.id, id))).returning({ id: workspaceContacts.id });
    if (!removed.length) return reply.code(404).send({ error: 'NOT_FOUND' });
    return reply.code(204).send();
  });
}
