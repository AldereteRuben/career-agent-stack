'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale } from '@/lib/i18n';
import { ApiError, api, errorMessage } from '@/lib/api';
import { Button, Card, Notice } from '@/components/ui';

type Notes = { business: string; model: string; news: string; culture: string; questions: string };
const emptyNotes: Notes = { business: '', model: '', news: '', culture: '', questions: '' };

export function CompanyResearchGuide({ jobId, company }: { jobId: string; company: string }) {
  const { locale } = useLocale();
  const c = (es: string, en: string) => locale === 'en' ? en : es;
  const [notes, setNotes] = useState<Notes>(emptyNotes);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [revision, setRevision] = useState<number | null>(null);
  const requestVersion = useRef(0);

  useEffect(() => {
    const version = ++requestVersion.current;
    setNotes(emptyNotes); setRevision(null); setLoading(true); setBusy(false); setError(''); setSaved(false);
    void api<{ notes: Notes; revision: number | null }>(`/jobs/${jobId}/research-notes`).then((result) => {
      if (version === requestVersion.current) { setNotes({ ...emptyNotes, ...result.notes }); setRevision(result.revision); }
    }).catch((err: unknown) => {
      if (version === requestVersion.current) setError(errorMessage(err));
    }).finally(() => { if (version === requestVersion.current) setLoading(false); });
    return () => { requestVersion.current += 1; };
  }, [jobId]);

  const update = useCallback((field: keyof Notes, value: string) => {
    setNotes((current) => ({ ...current, [field]: value }));
    setSaved(false);
  }, []);

  const save = async () => {
    if (busy) return;
    const version = requestVersion.current;
    setBusy(true); setError(''); setSaved(false);
    try {
      const isEmpty = Object.values(notes).every((value) => !value.trim());
      const result = isEmpty
        ? await api<{ revision: number | null }>(`/jobs/${jobId}/research-notes`, { method: 'DELETE', body: JSON.stringify({ expectedRevision: revision }) })
        : await api<{ revision: number }>(`/jobs/${jobId}/research-notes`, { method: 'PUT', body: JSON.stringify({ notes, expectedRevision: revision }) });
      if (version === requestVersion.current) { setRevision(result.revision); setSaved(true); }
    } catch (err) {
      if (version === requestVersion.current) setError(err instanceof ApiError && err.status === 409 ? c('Las notas cambiaron en otra pestaña. Conservé aquí tus cambios; recarga antes de volver a guardarlos.', 'These notes changed in another tab. Your edits are still here; reload before saving again.') : errorMessage(err));
    }
    finally { if (version === requestVersion.current) setBusy(false); }
  };

  const companyQuery = encodeURIComponent(company);
  const searchUrl = (query: string) => `https://www.google.com/search?q=${encodeURIComponent(`${company} ${query}`)}`;

  return <Card className="form-card" aria-labelledby="company-research-heading">
    <div className="panel-heading"><div><div className="eyebrow"><span className="eyebrow-mark"/> {c('INVESTIGACIÓN MANUAL', 'MANUAL RESEARCH')}</div><h2 id="company-research-heading">{c('Investiga la empresa', 'Research the company')}</h2></div></div>
    <p>{c('Usa estas preguntas para preparar tu candidatura. Los enlaces solo abren búsquedas que tú eliges; Career Stack no visita sitios ni importa su contenido.', 'Use these prompts to prepare your application. Links only open searches you choose; Career Stack does not visit sites or import their content.')}</p>
    <p className="job-detail-meta">{c('Tus notas se guardan en esta instalación y no se envían a servicios de IA.', 'Your notes are stored in this installation and are not sent to AI services.')}</p>
    <p>
      <a href={`https://www.google.com/search?q=${companyQuery}`} target="_blank" rel="noopener noreferrer">{c(`Buscar ${company}`, `Search ${company}`)}<span className="sr-only"> {c('(se abre en una pestaña nueva)', '(opens in a new tab)')}</span></a>
      {' · '}
      <a href={searchUrl('news')} target="_blank" rel="noopener noreferrer">{c('Buscar noticias recientes', 'Search recent news')}<span className="sr-only"> {c('(se abre en una pestaña nueva)', '(opens in a new tab)')}</span></a>
    </p>
    {error && <Notice tone="error">{error}</Notice>}
    {loading ? <Notice>{c('Cargando tus notas…', 'Loading your notes…')}</Notice> : <div className="form-stack">
      <label>{c('¿Qué hace la empresa?', 'What does the company do?')}<textarea rows={3} maxLength={4_000} value={notes.business} onChange={(event) => update('business', event.target.value)} /></label>
      <label>{c('¿Cómo gana dinero o crea valor?', 'How does it make money or create value?')}<textarea rows={3} maxLength={4_000} value={notes.model} onChange={(event) => update('model', event.target.value)} /></label>
      <label>{c('Noticias recientes que conviene revisar', 'Recent news worth reviewing')}<textarea rows={3} maxLength={4_000} value={notes.news} onChange={(event) => update('news', event.target.value)} /></label>
      <label>{c('Cultura y forma de trabajar', 'Culture and ways of working')}<textarea rows={3} maxLength={4_000} value={notes.culture} onChange={(event) => update('culture', event.target.value)} /></label>
      <label>{c('¿Qué preguntarías en una entrevista?', 'What would you ask in an interview?')}<textarea rows={3} maxLength={4_000} value={notes.questions} onChange={(event) => update('questions', event.target.value)} /></label>
      <div className="button-row"><Button onClick={() => void save()} disabled={busy}>{busy ? c('Guardando…', 'Saving…') : c('Guardar notas', 'Save notes')}</Button>{saved && <span role="status">{c('Guardado', 'Saved')}</span>}</div>
    </div>}
  </Card>;
}
