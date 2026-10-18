'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocale } from '@/lib/i18n';
import { api, errorMessage } from '@/lib/api';
import { Button, Field, Notice, SelectField, TextareaField } from '@/components/ui';
import { copy } from '@/lib/labels';

type Contact = { id: string; name: string; profileUrl: string | null };
type ContactLink = Contact & { contactId: string; role: string; note: string; createdAt: string; updatedAt: string };
type ContactResponse = { links: ContactLink[]; contacts: Contact[] };
type ContactDraft = { name: string; profileUrl: string; role: string; note: string };

export function ApplicationContacts({ applicationId }: { applicationId: string }) {
  const { locale } = useLocale(); const c = copy(locale);
  const [links, setLinks] = useState<ContactLink[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [existingId, setExistingId] = useState('');
  const [newDraft, setNewDraft] = useState<ContactDraft>({ name: '', profileUrl: '', role: '', note: '' });
  const [drafts, setDrafts] = useState<Record<string, ContactDraft>>({});
  const requestId = useRef(0);
  const load = useCallback(async () => {
    const ticket = ++requestId.current;
    try {
      const result = await api<ContactResponse>(`/applications/${applicationId}/contacts`);
      if (ticket === requestId.current) { setLinks(result.links); setContacts(result.contacts); setLoading(false); }
    } catch (err) {
      if (ticket === requestId.current) { setError(errorMessage(err)); setLoading(false); }
    }
  }, [applicationId]);
  useEffect(() => { setLoading(true); void load(); return () => { requestId.current++; }; }, [load]);

  const add = async (event: FormEvent) => {
    event.preventDefault(); setBusy('add'); setError(''); setMessage('');
    try {
      const payload = existingId
        ? { contactId: existingId, role: newDraft.role, note: newDraft.note }
        : { name: newDraft.name, profileUrl: newDraft.profileUrl || null, role: newDraft.role, note: newDraft.note };
      await api(`/applications/${applicationId}/contacts`, { method: 'POST', body: JSON.stringify(payload) });
      setNewDraft({ name: '', profileUrl: '', role: '', note: '' }); setExistingId('');
      setMessage(c('Contacto vinculado.', 'Contact linked.')); await load();
    } catch (err) { setError(errorMessage(err)); }
    finally { setBusy(null); }
  };

  const save = async (link: ContactLink) => {
    const draft = drafts[link.id]; if (!draft) return;
    setBusy(link.id); setError(''); setMessage('');
    try {
      await api(`/applications/${applicationId}/contacts/${link.id}`, { method: 'PATCH', body: JSON.stringify({ name: draft.name, profileUrl: draft.profileUrl || null, role: draft.role, note: draft.note }) });
      setDrafts((current) => { const next = { ...current }; delete next[link.id]; return next; });
      setMessage(c('Contacto actualizado.', 'Contact updated.')); await load();
    } catch (err) { setError(errorMessage(err)); }
    finally { setBusy(null); }
  };

  const unlink = async (link: ContactLink) => {
    setBusy(link.id); setError(''); setMessage('');
    try {
      await api(`/applications/${applicationId}/contacts/${link.id}`, { method: 'DELETE' });
      setMessage(c('Contacto desvinculado de esta solicitud.', 'Contact unlinked from this application.')); await load();
    } catch (err) { setError(errorMessage(err)); }
    finally { setBusy(null); }
  };

  const removeEverywhere = async (link: ContactLink) => {
    if (!window.confirm(c(`¿Eliminar a ${link.name} de todos tus contactos y solicitudes?`, `Delete ${link.name} from all contacts and applications?`))) return;
    setBusy(link.id); setError(''); setMessage('');
    try {
      await api(`/contacts/${link.contactId}`, { method: 'DELETE' });
      setMessage(c('Contacto eliminado de todas las solicitudes.', 'Contact deleted from all applications.')); await load();
    } catch (err) { setError(errorMessage(err)); }
    finally { setBusy(null); }
  };

  const deleteContact = async (contact: Contact) => {
    if (!window.confirm(c(`¿Eliminar a ${contact.name} de todos tus contactos y solicitudes?`, `Delete ${contact.name} from all contacts and applications?`))) return;
    setBusy(contact.id); setError(''); setMessage('');
    try {
      await api(`/contacts/${contact.id}`, { method: 'DELETE' });
      setMessage(c('Contacto eliminado de todas las solicitudes.', 'Contact deleted from all applications.')); await load();
    } catch (err) { setError(errorMessage(err)); }
    finally { setBusy(null); }
  };

  const editValue = (link: ContactLink): ContactDraft => drafts[link.id] ?? { name: link.name, profileUrl: link.profileUrl ?? '', role: link.role, note: link.note };
  const change = (link: ContactLink, key: keyof ContactDraft, value: string) => setDrafts((current) => ({ ...current, [link.id]: { ...editValue(link), [key]: value } }));
  const linkedContactIds = new Set(links.map((link) => link.contactId));

  return <section className="application-contacts" aria-labelledby={`application-contacts-${applicationId}`}>
    <h3 id={`application-contacts-${applicationId}`}>{c('Contactos de esta solicitud', 'Contacts for this application')}</h3>
    <p>{c('Guarda manualmente a quién conociste y qué papel tuvo. No se importa ni se contacta a nadie automáticamente.', 'Manually record who you met and their role. No one is imported or contacted automatically.')}</p>
    {error && <Notice tone="warning" role="alert">{error}</Notice>}
    {message && <Notice role="status">{message}</Notice>}
    {loading ? <p role="status">{c('Cargando contactos…', 'Loading contacts…')}</p> : links.length === 0 ? <p>{c('Todavía no hay contactos vinculados.', 'No contacts are linked yet.')}</p> : <ul className="application-contact-list">
      {links.map((link) => { const draft = editValue(link); return <li key={link.id} className="application-contact-item">
        <div className="tracker-controls">
          <Field label={c('Nombre', 'Name')} value={draft.name} maxLength={160} disabled={busy !== null} onChange={(event) => change(link, 'name', event.target.value)}/>
          <Field label={c('Perfil profesional (opcional)', 'Professional profile (optional)')} type="url" value={draft.profileUrl} maxLength={2048} disabled={busy !== null} onChange={(event) => change(link, 'profileUrl', event.target.value)} placeholder="https://…"/>
          <Field label={c('Papel en esta solicitud', 'Role in this application')} value={draft.role} maxLength={120} disabled={busy !== null} onChange={(event) => change(link, 'role', event.target.value)}/>
          <TextareaField label={c('Nota (opcional)', 'Note (optional)')} rows={2} value={draft.note} maxLength={3000} disabled={busy !== null} onChange={(event) => change(link, 'note', event.target.value)}/>
        </div>
        <div className="button-row">
          {link.profileUrl && <a className="button button-quiet" href={link.profileUrl} target="_blank" rel="noopener noreferrer">{c('Abrir perfil', 'Open profile')}</a>}
          <Button variant="secondary" disabled={busy !== null || !draft.name.trim() || !draft.role.trim()} onClick={() => void save(link)}>{busy === link.id ? c('Guardando…', 'Saving…') : c('Guardar cambios', 'Save changes')}</Button>
          <Button variant="quiet" disabled={busy !== null} onClick={() => void unlink(link)}>{c('Desvincular', 'Unlink')}</Button>
          <Button variant="quiet" disabled={busy !== null} onClick={() => void removeEverywhere(link)}>{c('Eliminar de todas', 'Delete everywhere')}</Button>
        </div>
      </li>; })}
    </ul>}
    {!loading && contacts.some((contact) => !linkedContactIds.has(contact.id)) && <div className="application-contact-saved">
      <h4>{c('Contactos guardados sin vincular', 'Saved contacts not linked here')}</h4>
      <ul>{contacts.filter((contact) => !linkedContactIds.has(contact.id)).map((contact) => <li key={contact.id}>
        <span>{contact.name}{contact.profileUrl && <> · <a href={contact.profileUrl} target="_blank" rel="noopener noreferrer">{c('Perfil', 'Profile')}</a></>}</span>
        <Button variant="quiet" disabled={busy !== null} onClick={() => void deleteContact(contact)}>{busy === contact.id ? c('Eliminando…', 'Deleting…') : c('Eliminar contacto', 'Delete contact')}</Button>
      </li>)}</ul>
    </div>}
    <form className="tracker-controls" onSubmit={(event) => void add(event)}>
      <h4>{c('Vincular contacto', 'Link a contact')}</h4>
      <SelectField label={c('Contacto existente', 'Existing contact')} value={existingId} disabled={busy !== null} onChange={(event) => setExistingId(event.target.value)}>
        <option value="">{c('Crear un contacto nuevo', 'Create a new contact')}</option>
        {contacts.filter((contact) => !linkedContactIds.has(contact.id)).map((contact) => <option key={contact.id} value={contact.id}>{contact.name}</option>)}
      </SelectField>
      {!existingId && <>
        <Field label={c('Nombre', 'Name')} value={newDraft.name} maxLength={160} disabled={busy !== null} onChange={(event) => setNewDraft((current) => ({ ...current, name: event.target.value }))}/>
        <Field label={c('Perfil profesional (opcional)', 'Professional profile (optional)')} type="url" value={newDraft.profileUrl} maxLength={2048} disabled={busy !== null} onChange={(event) => setNewDraft((current) => ({ ...current, profileUrl: event.target.value }))} placeholder="https://…"/>
      </>}
      <Field label={c('Papel en esta solicitud', 'Role in this application')} value={newDraft.role} maxLength={120} disabled={busy !== null} onChange={(event) => setNewDraft((current) => ({ ...current, role: event.target.value }))} placeholder={c('Ej.: reclutador, entrevistadora, referente', 'For example: recruiter, interviewer, referrer')}/>
      <TextareaField label={c('Nota (opcional)', 'Note (optional)')} rows={2} value={newDraft.note} maxLength={3000} disabled={busy !== null} onChange={(event) => setNewDraft((current) => ({ ...current, note: event.target.value }))}/>
      <Button type="submit" variant="secondary" disabled={busy !== null || !newDraft.role.trim() || (!existingId && !newDraft.name.trim())}>{busy === 'add' ? c('Guardando…', 'Saving…') : c('Vincular contacto', 'Link contact')}</Button>
    </form>
  </section>;
}
