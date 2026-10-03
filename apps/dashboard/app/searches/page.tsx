'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { AppShell, PageHeader, WorkspaceGate } from '@/components/shell';
import { Button, Card, Empty, Field, Notice, SelectField, Tag } from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useLocale } from '@/lib/i18n';
import styles from './searches.module.css';

type Search = { id: string; role: string | null; company: string | null; location: string | null; workMode: 'any' | 'remote' | 'hybrid' | 'onsite'; frequencyHours: 6 | 12 | 24; enabled: boolean; autoPrepare: boolean; language: 'en' | 'es'; lastRunAt: string | null; nextRunAt: string | null; lastRunStatus: string | null; lastResultCount: number; lastNewCount: number; lastError: string | null };
type SearchJob = { id: string; company: string; title: string; location: string | null; canonicalUrl: string | null; seenAt: string | null; shortlistDecision: string; matchedAt: string; unknownLocation: boolean; autoPreparedAt?: string | null; autoPrepareError?: string | null; sources: Array<{ provider: string; url: string; postedAt: string | null }> };
type Draft = { role: string; company: string; location: string; workMode: Search['workMode']; frequencyHours: Search['frequencyHours']; enabled: boolean; autoPrepare: boolean };
const emptyDraft = (): Draft => ({ role: '', company: '', location: '', workMode: 'any', frequencyHours: 12, enabled: true, autoPrepare: false });

export default function SearchesPage() {
  const { locale } = useLocale(); const es = locale === 'es';
  const [searches, setSearches] = useState<Search[]>([]); const [results, setResults] = useState<SearchJob[]>([]); const [selectedId, setSelectedId] = useState('');
  const [formOpen, setFormOpen] = useState(false); const [resultLoading, setResultLoading] = useState(false);
  const [total, setTotal] = useState(0); const [offset, setOffset] = useState(0);
  const formTitle = useRef<HTMLHeadingElement>(null); const resultsTitle = useRef<HTMLHeadingElement>(null);
  const selectedRef = useRef(''); const requestVersion = useRef(0); const focusForm = useRef(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft); const [editing, setEditing] = useState('');
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(''); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const t = (spanish: string, english: string) => es ? spanish : english;
  const problem = (cause: unknown) => {
    const codes: Record<string, [string, string]> = {
      SEARCH_REFRESH_COOLDOWN: ['Esta búsqueda ya está actualizada. La próxima consulta aparece en su tarjeta.', 'This search is up to date. Its next check is shown on the card.'],
      SEARCH_REFRESH_ALREADY_RUNNING: ['Ya estamos consultando esta búsqueda. Revisa los resultados en unos momentos.', 'This search is already running. Check its results in a moment.'],
      SEARCH_DISABLED: ['Reanuda la búsqueda para volver a consultar las fuentes.', 'Resume the search to check the sources again.'],
      SEARCH_REFRESH_FAILED: ['No pudimos consultar las fuentes. Conservamos las ofertas guardadas y lo intentaremos después.', 'We could not check the sources. Saved jobs are preserved and we will try again later.'],
      INVALID_INPUT: ['Revisa los datos de la búsqueda e indica un puesto o una empresa.', 'Check the search details and enter a role or company.'],
    };
    return cause instanceof ApiError && codes[cause.code] ? codes[cause.code]![es ? 0 : 1] : errorMessage(cause);
  };
  const loadResults = useCallback(async (id: string, start = 0) => {
    const version = ++requestVersion.current; setResultLoading(true);
    try {
      const result = await api<{ items: SearchJob[]; total: number }>(`/job-searches/${id}/results?limit=20&offset=${start}`);
      if (version !== requestVersion.current) return;
      setResults(result.items); setTotal(result.total); setOffset(start);
    } catch (cause) { if (version === requestVersion.current) { setResults([]); setTotal(0); setError(errorMessage(cause)); } }
    finally { if (version === requestVersion.current) setResultLoading(false); }
  }, []);
  const load = useCallback(async (selected?: string) => {
    setError('');
    try {
      const response = await api<{ searches: Search[] }>('/job-searches');
      setSearches(response.searches);
      const active = response.searches.find((item) => item.id === (selected ?? selectedRef.current)) ?? response.searches[0];
      selectedRef.current = active?.id ?? ''; setSelectedId(active?.id ?? '');
      if (active) await loadResults(active.id);
      else { setResults([]); setTotal(0); setFormOpen(true); }
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setLoading(false); }
  }, [loadResults]);
  useEffect(() => { void load(); return () => { requestVersion.current++; }; }, [load]);
  useEffect(() => { if (formOpen && focusForm.current) { formTitle.current?.focus(); focusForm.current = false; } }, [formOpen, editing]);
  const openNew = () => { setEditing(''); setDraft(emptyDraft()); focusForm.current = true; setFormOpen(true); if (formOpen) formTitle.current?.focus(); };
  const selectedSearch = searches.find((search) => search.id === selectedId);
  const dateTime = (value: string) => new Intl.DateTimeFormat(es ? 'es-ES' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
  const modeLabel = (mode: Search['workMode']) => ({ any: t('Cualquier modalidad', 'Any work mode'), remote: t('En remoto', 'Remote'), hybrid: t('Híbrida', 'Hybrid'), onsite: t('Presencial', 'On-site') })[mode];

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(''); setMessage('');
    if (!draft.role.trim() && !draft.company.trim()) { setError(t('Indica un puesto, una empresa o ambos.', 'Enter a role, a company, or both.')); return; }
    setBusy(editing || 'create');
    const body = { role: draft.role.trim() || null, company: draft.company.trim() || null, location: draft.location.trim() || null, workMode: draft.workMode, frequencyHours: draft.frequencyHours, enabled: draft.enabled, autoPrepare: draft.autoPrepare, language: locale };
    try {
      const saved = await api<{ search: Search }>(editing ? `/job-searches/${editing}` : '/job-searches', { method: editing ? 'PATCH' : 'POST', body: JSON.stringify(body) });
      setDraft(emptyDraft()); setEditing(''); setFormOpen(false); setMessage(t('Búsqueda guardada. Aquí puedes revisar las ofertas y su próxima actualización.', 'Search saved. Review its jobs and next update below.'));
      await load(saved.search.id); resultsTitle.current?.focus();
    } catch (cause) { setError(problem(cause)); } finally { setBusy(''); }
  };
  const editSearch = (search: Search) => { setEditing(search.id); setDraft({ role: search.role ?? '', company: search.company ?? '', location: search.location ?? '', workMode: search.workMode, frequencyHours: search.frequencyHours, enabled: search.enabled, autoPrepare: search.autoPrepare }); focusForm.current = true; setFormOpen(true); if (formOpen) formTitle.current?.focus(); };
  const runAction = async (search: Search, action: 'refresh' | 'toggle') => {
    setBusy(search.id); setError(''); setMessage('');
    try {
      if (action === 'refresh') {
        const refreshed = await api<{ matched: number; coverage: string }>(`/job-searches/${search.id}/refresh`, { method: 'POST', body: '{}' });
        setMessage(refreshed.coverage === 'EMPTY' ? t('No hay ofertas que coincidan en las fuentes públicas ahora mismo.', 'No matching jobs are available from the public feeds right now.') : t('Búsqueda actualizada.', 'Search refreshed.'));
      } else await api(`/job-searches/${search.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !search.enabled }) });
      await load(search.id);
    } catch (cause) { setError(problem(cause)); } finally { setBusy(''); }
  };
  const choose = async (id: string, start = 0) => { setError(''); selectedRef.current = id; setSelectedId(id); await loadResults(id, start); resultsTitle.current?.focus(); };

  return <WorkspaceGate><AppShell>
    <PageHeader eyebrow={t('BÚSQUEDA AUTOMÁTICA', 'AUTOMATIC JOB SEARCH')} title={t('Búsquedas guardadas', 'Saved searches')} description={t('Busca puestos o empresas sin configurar enlaces de empleo. Guardamos y filtramos las ofertas de las fuentes disponibles cada 6, 12 o 24 horas mientras el servicio local esté encendido. Puedes pausar cualquier búsqueda.', 'Find roles or companies without setting up employer links. We save and filter jobs from available sources every 6, 12 or 24 hours while the local service is running. You can pause any search.')} action={<div className={styles.actions}><Button disabled={busy !== ''} onClick={openNew}>{t('Nueva búsqueda', 'New search')}</Button><Link href="/jobs" className="button button-secondary">{t('Ver ofertas guardadas', 'Open saved jobs')}</Link></div>}/>
    <p><Link href="/preparations">{t('Revisar candidaturas preparadas', 'Review prepared applications')}</Link></p>
    {error && <Notice tone="error">{error}</Notice>}{message && <Notice tone="success">{message}</Notice>}
    <div className={styles.layout}>
      {formOpen && <section className={styles.formColumn} aria-labelledby="search-form-title">
        <Card className={styles.formCard}>
          <h2 id="search-form-title" ref={formTitle} tabIndex={-1}>{t(editing ? 'Editar búsqueda' : 'Crear una búsqueda', editing ? 'Edit search' : 'Create a search')}</h2>
          <p className={styles.intro}>{t('Puedes indicar un puesto, una empresa o ambos. Solo consultamos ofertas públicas; no enviamos solicitudes.', 'Enter a role, a company, or both. We read public listings; this search never submits applications.')}</p>
          <form onSubmit={(event) => void submit(event)} className={styles.form}>
            <Field disabled={busy !== ''} label={t('Puesto o palabras clave', 'Role or keywords')} value={draft.role} onChange={(event) => setDraft({ ...draft, role: event.target.value })} placeholder={t('Ej.: Product Designer', 'e.g. product designer')} hint={t('Se buscan estas palabras en el título. Prueba también el puesto en inglés.', 'These words are matched in job titles. Try the title used in the listings.')}/>
            <Field disabled={busy !== ''} label={t('Empresa (opcional)', 'Company (optional)')} value={draft.company} onChange={(event) => setDraft({ ...draft, company: event.target.value })} placeholder={t('Ej.: Northwind', 'e.g. Northwind')}/>
            <Field disabled={busy !== ''} label={t('Ubicación (opcional)', 'Location (optional)')} value={draft.location} onChange={(event) => setDraft({ ...draft, location: event.target.value })} placeholder={t('Ej.: Berlín o España', 'e.g. Berlin or Spain')} hint={t('Si una oferta no indica ubicación, la mostramos con una nota para que la revises.', 'If a listing omits its location, we show it with a note for you to review.')}/>
            <SelectField disabled={busy !== ''} label={t('Modalidad', 'Work mode')} value={draft.workMode} onChange={(event) => setDraft({ ...draft, workMode: event.target.value as Draft['workMode'] })}><option value="any">{t('Cualquiera', 'Any')}</option><option value="remote">{t('En remoto', 'Remote')}</option><option value="hybrid">{t('Híbrida', 'Hybrid')}</option><option value="onsite">{t('Presencial', 'On-site')}</option></SelectField>
            <SelectField disabled={busy !== ''} label={t('Frecuencia de actualización', 'Refresh frequency')} value={draft.frequencyHours} onChange={(event) => setDraft({ ...draft, frequencyHours: Number(event.target.value) as Draft['frequencyHours'] })}><option value={6}>{t('Cada 6 horas', 'Every 6 hours')}</option><option value={12}>{t('Cada 12 horas', 'Every 12 hours')}</option><option value={24}>{t('Cada 24 horas', 'Every 24 hours')}</option></SelectField>
            <label className={styles.check}><input type="checkbox" disabled={busy !== ''} checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}/><span>{t('Actualizar esta búsqueda automáticamente', 'Refresh this search automatically')}</span></label>
            <label className={styles.check}><input type="checkbox" disabled={busy !== ''} checked={draft.autoPrepare} onChange={(event) => setDraft({ ...draft, autoPrepare: event.target.checked })}/><span>{t('Preparar candidaturas para las coincidencias', 'Prepare applications for matches')} <small>{t('Crea un CV con tu experiencia confirmada para que lo revises. No autoriza envíos.', 'Creates a resume from confirmed experience for your review. Does not authorize submission.')}</small></span></label>
            <div className={styles.actions}><Button type="submit" disabled={busy !== ''}>{busy ? t('Guardando…', 'Saving…') : t(editing ? 'Guardar cambios' : 'Guardar búsqueda', editing ? 'Save changes' : 'Save search')}</Button>{searches.length > 0 && <Button type="button" variant="quiet" disabled={busy !== ''} onClick={() => { setEditing(''); setDraft(emptyDraft()); setFormOpen(false); }}>{t('Cancelar', 'Cancel')}</Button>}</div>
          </form>
        </Card>

      </section>}
      <section className={styles.listColumn} aria-labelledby="saved-searches-title">
        <div className={styles.sectionHead}><div><h2 id="saved-searches-title">{t('Tus búsquedas', 'Your searches')}</h2><p>{t(`${searches.length} búsqueda${searches.length === 1 ? '' : 's'} guardada${searches.length === 1 ? '' : 's'}`, `${searches.length} saved search${searches.length === 1 ? '' : 'es'}`)}</p></div><Button variant="quiet" disabled={loading || resultLoading} onClick={() => void load()}>{t('Comprobar novedades', 'Check for updates')}</Button></div>
        {loading ? <Notice>{t('Cargando búsquedas…', 'Loading searches…')}</Notice> : searches.length === 0 ? <Card><Empty title={t('Todavía no tienes búsquedas', 'No saved searches yet')} detail={t('Guarda una búsqueda para descubrir nuevas ofertas sin añadir enlaces de empresas.', 'Save a search to find public jobs without adding employer links.')}/></Card> : <div className={styles.searchList}>{searches.map((search) => <Card className={styles.searchCard} key={search.id}>
          <div className={styles.cardHead}><div><h3>{search.role || t('Cualquier puesto', 'Any role')}{search.company ? ` · ${search.company}` : ''}</h3><p>{[search.location, modeLabel(search.workMode), `${search.frequencyHours} h`].filter(Boolean).join(' · ')}</p></div><Tag tone={search.enabled ? 'green' : 'neutral'}>{search.enabled ? t('ACTIVA', 'ACTIVE') : t('PAUSADA', 'PAUSED')}</Tag></div>
          <div className={styles.status}>{search.lastRunStatus === 'FAILED' || search.lastRunStatus === 'PARTIAL' || search.lastRunStatus === 'STALE' ? <span className={styles.warning}>{search.lastRunStatus === 'PARTIAL' ? t('Cobertura limitada: puede haber más ofertas en las fuentes.', 'Limited coverage: the sources may contain more jobs.') : t('Algunos datos pueden estar desactualizados', 'Some results may be stale')}</span> : search.lastRunStatus === 'EMPTY' ? t('Sin coincidencias todavía', 'No matches yet') : search.lastRunAt ? t(`Última búsqueda: ${dateTime(search.lastRunAt)}`, `Last checked: ${dateTime(search.lastRunAt)}`) : t('Aún no se ha actualizado', 'Not refreshed yet')}<span>{search.lastResultCount} {search.lastResultCount === 1 ? t('coincidencia', 'match') : t('coincidencias', 'matches')}</span></div>
          {search.enabled && search.nextRunAt && <p className={styles.schedule}>{t('Próxima consulta: ', 'Next check: ')}{dateTime(search.nextRunAt)}</p>}
          <div className={styles.cardActions}><Button variant="secondary" onClick={() => void choose(search.id)} aria-pressed={selectedId === search.id}>{t('Ver resultados', 'View results')}</Button><Button variant="quiet" disabled={busy !== '' || !search.enabled || Boolean(search.nextRunAt && Date.parse(search.nextRunAt) > Date.now())} onClick={() => void runAction(search, 'refresh')}>{busy === search.id ? t('Buscando…', 'Searching…') : t('Actualizar ahora', 'Refresh now')}</Button><Button variant="quiet" disabled={busy !== ''} onClick={() => void runAction(search, 'toggle')}>{search.enabled ? t('Pausar', 'Pause') : t('Reanudar', 'Resume')}</Button><Button variant="quiet" disabled={busy !== ''} onClick={() => editSearch(search)}>{t('Editar', 'Edit')}</Button></div>
        </Card>)}</div>}
        {selectedId && <div className={styles.results} aria-live="polite"><h2 ref={resultsTitle} tabIndex={-1}>{t('Resultados de la búsqueda', 'Search results')}</h2><p>{total} {total === 1 ? t('oferta', 'job') : t('ofertas', 'jobs')}</p>{resultLoading ? <Notice>{t('Cargando resultados…', 'Loading results…')}</Notice> : results.length ? <div className={styles.resultList}>{results.map((job) => <Card className={styles.resultCard} key={job.id}><div><h3><Link href={`/jobs/${job.id}`}>{job.title}</Link></h3><p>{job.company} · {job.location || t('Ubicación sin indicar', 'Location not listed')}</p>{selectedSearch?.autoPrepare && !job.autoPreparedAt && <small className={styles.preparationStatus}>{!selectedSearch.enabled ? t('Preparación pausada con esta búsqueda.', 'Preparation is paused with this search.') : job.autoPrepareError === 'PREPARATION_FAILED' ? t('No se pudo preparar el CV. Volveremos a intentarlo; también puedes abrir la oferta para prepararlo.', 'Could not prepare the resume. We will retry; you can also open the job to prepare it.') : t('Candidatura pendiente de preparación.', 'Application waiting to be prepared.')}</small>}{job.unknownLocation && <small className={styles.warning}>{t('La fuente no indica la ubicación; compruébala en la oferta.', 'The feed omits a location; check the job listing.')}</small>}</div><div className={styles.sources}>{job.sources.map((source) => <a key={`${source.provider}:${source.url}`} href={source.url} target="_blank" rel="noopener noreferrer">{source.provider === 'remotive' ? 'Remotive' : 'Arbeitnow'}</a>)}</div></Card>)}</div> : <Card><Empty title={t('No hay resultados guardados', 'No saved results')} detail={t('Actualiza esta búsqueda para comprobar las ofertas públicas disponibles.', 'Refresh this search to check the available public listings.')}/></Card>}{total > 20 && <nav className={styles.actions} aria-label={t('Páginas de resultados', 'Result pages')}><Button variant="secondary" disabled={offset === 0 || resultLoading} onClick={() => void choose(selectedId, Math.max(0, offset - 20))}>{t('Anterior', 'Previous')}</Button><span>{Math.floor(offset / 20) + 1} / {Math.ceil(total / 20)}</span><Button variant="secondary" disabled={offset + 20 >= total || resultLoading} onClick={() => void choose(selectedId, offset + 20)}>{t('Siguiente', 'Next')}</Button></nav>}</div>}
      </section>
    </div>
        <details className={styles.coverage}>
          <summary>{t('Cobertura y fuentes', 'Coverage and sources')}</summary>
          <p>{t('Consultamos Remotive (ofertas remotas; pueden publicarse con 24 horas de retraso) y Arbeitnow (Europa, incluida Alemania). No necesitas claves ni enlaces de empresas. Los resultados dependen de lo que publiquen estos dos servicios.', 'We check Remotive (remote jobs; listings may be delayed by 24 hours) and Arbeitnow (Europe, including Germany). No API keys or employer links are needed. Results depend on what these two services publish.')}</p>
          <p><a href="https://github.com/remotive-com/remote-jobs-api" target="_blank" rel="noopener noreferrer">Remotive API</a> · <a href="https://www.arbeitnow.com/blog/job-board-api" target="_blank" rel="noopener noreferrer">Arbeitnow API</a></p>
          <small>{t('Cada fuente se consulta como máximo una vez cada 6 horas para evitar consultas repetidas. Si una fuente falla, mostramos los datos guardados indicando que pueden estar desactualizados.', 'Each feed is fetched at most once every 6 hours to avoid repeat requests. If a feed fails, saved data remains visible with a stale status.')}</small>
        </details>
  </AppShell></WorkspaceGate>;
}
