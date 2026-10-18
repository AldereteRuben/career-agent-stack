'use client';

import { useEffect, useState } from 'react';
import { Button, Notice, TextareaField } from '@/components/ui';
import { api } from '@/lib/api';
import { useLocale } from '@/lib/i18n';

type Preferences = { excludedCompanies: string[]; requiredTerms: string[]; excludedTerms: string[] };
const empty: Preferences = { excludedCompanies: [], requiredTerms: [], excludedTerms: [] };
const lines = (items: string[]) => items.join('\n');
const parseLines = (value: string) => value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);

/** Explicit filters stay separate from provider query criteria and are never inferred from activity. */
export function JobFilterEditor({ onSaved }: { onSaved: () => void }) {
  const { locale } = useLocale(); const es = locale === 'es';
  const t = (spanish: string, english: string) => es ? spanish : english;
  const [value, setValue] = useState<Preferences>(empty); const [draft, setDraft] = useState({ excludedCompanies: '', requiredTerms: '', excludedTerms: '' });
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  useEffect(() => { let active = true; void api<Preferences>('/job-filters').then((next) => { if (active) { setValue(next); setDraft({ excludedCompanies: lines(next.excludedCompanies), requiredTerms: lines(next.requiredTerms), excludedTerms: lines(next.excludedTerms) }); } }).catch(() => { if (active) setError(t('No se pudieron cargar las preferencias.', 'Could not load preferences.')); }); return () => { active = false; }; }, []);
  const save = async () => {
    setBusy(true); setError(''); setMessage('');
    const next = { excludedCompanies: parseLines(draft.excludedCompanies), requiredTerms: parseLines(draft.requiredTerms), excludedTerms: parseLines(draft.excludedTerms) };
    try { const saved = await api<Preferences>('/job-filters', { method: 'PUT', body: JSON.stringify({ preferences: next }) }); setValue(saved); setDraft({ excludedCompanies: lines(saved.excludedCompanies), requiredTerms: lines(saved.requiredTerms), excludedTerms: lines(saved.excludedTerms) }); setMessage(t('Preferencias guardadas. Se actualizaron las ofertas.', 'Preferences saved. The job list was refreshed.')); onSaved(); }
    catch { setError(t('No se pudieron guardar las preferencias. Revisa que cada lista tenga hasta 50 líneas de 100 caracteres.', 'Could not save preferences. Each list supports up to 50 lines of 100 characters.')); }
    finally { setBusy(false); }
  };
  const changed = (['excludedCompanies', 'requiredTerms', 'excludedTerms'] as const).some((key) => parseLines(draft[key]).join('\n') !== lines(value[key]));
  return <details className="card">
    <summary>{t('Preferencias para filtrar ofertas', 'Job filtering preferences')}</summary>
    <p>{t('Las reglas solo ocultan ofertas de la lista normal; puedes encontrarlas y restaurarlas en «Excluidas por preferencias». No se infieren preferencias ni se borran ofertas.', 'Rules only hide jobs from the usual list; find and restore them in “Filtered by preferences”. Preferences are never inferred and jobs are never deleted.')}</p>
    <div className="form-grid">
      <TextareaField label={t('Empresas excluidas (una por línea)', 'Excluded companies (one per line)')} value={draft.excludedCompanies} onChange={(e) => setDraft({ ...draft, excludedCompanies: e.target.value })} rows={3} />
      <TextareaField label={t('Términos que deben aparecer todos', 'Terms that must all appear')} hint={t('Se buscan en título, empresa y descripción; si falta alguno, la oferta queda excluida.', 'Searched in title, company and description; a job is filtered when any term is missing.')} value={draft.requiredTerms} onChange={(e) => setDraft({ ...draft, requiredTerms: e.target.value })} rows={3} />
      <TextareaField label={t('Términos excluidos (cualquiera basta)', 'Excluded terms (any one is enough)')} value={draft.excludedTerms} onChange={(e) => setDraft({ ...draft, excludedTerms: e.target.value })} rows={3} />
    </div>
    {error && <Notice tone="error">{error}</Notice>}{message && <Notice tone="success">{message}</Notice>}
    <Button disabled={busy || !changed} onClick={() => void save()}>{busy ? t('Guardando…', 'Saving…') : t('Guardar preferencias', 'Save preferences')}</Button>
  </details>;
}
