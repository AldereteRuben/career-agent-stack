'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { AppShell, PageHeader, WorkspaceGate } from '@/components/shell';
import { Button, Card, Empty, Field, Notice, SelectField, Tag } from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useErrorFocus } from '@/lib/disclosure-focus';
import { useLocalRefresh } from '@/lib/local-refresh';
import { useSessionDraft } from '@/lib/session-draft';
import { useLocale } from '@/lib/i18n';
import styles from './searches.module.css';

type Search = { id: string; role: string | null; company: string | null; location: string | null; workMode: 'any' | 'remote' | 'hybrid' | 'onsite'; frequencyHours: 6 | 12 | 24; enabled: boolean; autoPrepare: boolean; language: 'en' | 'es'; lastRunAt: string | null; nextRunAt: string | null; lastRunStatus: string | null; lastResultCount: number; lastNewCount: number; lastError: string | null };
type SearchJob = { id: string; company: string; title: string; location: string | null; canonicalUrl: string | null; seenAt: string | null; shortlistDecision: string; matchedAt: string; unknownLocation: boolean; autoPreparedAt?: string | null; autoPrepareError?: string | null; sources: Array<{ provider: string; url: string; postedAt: string | null }> };
type Feed = { provider: string; listings: number; coverage: string; fetchedAt: string | null; lastError: string | null };
type Draft = { role: string; company: string; location: string; workMode: Search['workMode']; frequencyHours: Search['frequencyHours']; enabled: boolean; autoPrepare: boolean };
const emptyDraft = (): Draft => ({ role: '', company: '', location: '', workMode: 'any', frequencyHours: 12, enabled: true, autoPrepare: false });

type SearchFormState = { draft: Draft; editing: string; open: boolean };
const initialForm = (): SearchFormState => ({ draft: emptyDraft(), editing: '', open: false });
function readForm(payload: string): SearchFormState {
  try {
    const value = JSON.parse(payload) as SearchFormState;
    const d = value.draft;
    if (typeof value.editing === 'string' && typeof value.open === 'boolean' && d &&
      ['role', 'company', 'location'].every((key) => typeof d[key as 'role'] === 'string') &&
      ['any', 'remote', 'hybrid', 'onsite'].includes(d.workMode) && [6, 12, 24].includes(d.frequencyHours) &&
      typeof d.enabled === 'boolean' && typeof d.autoPrepare === 'boolean') return value;
  } catch { /* An invalid draft is not restored. */ }
  return initialForm();
}
const contextHref = (id: string, offset: number) => `/searches?${new URLSearchParams({ search: id, offset: String(offset) })}`;
// Navigation context is per tab and uses the same logout-cleared namespace as drafts.
const searchContextKey = 'career:draft:v1:saved-search-view';
const pageOffset = (value: unknown) => { const n = Number(value); return Number.isFinite(n) ? Math.min(100_000, Math.max(0, Math.floor(n / 20) * 20)) : 0; };
function rememberedContext() {
  try { const value = JSON.parse(sessionStorage.getItem(searchContextKey) ?? '{}'); return { search: typeof value.search === 'string' ? value.search : '', offset: pageOffset(value.offset) }; }
  catch { return { search: '', offset: 0 }; }
}


export default function SearchesPage() {
  const { locale } = useLocale(); const es = locale === 'es';
  const [searches, setSearches] = useState<Search[]>([]); const [results, setResults] = useState<SearchJob[]>([]); const [selectedId, setSelectedId] = useState('');
  const formDraft = useSessionDraft('saved-search-form', { payload: '' }, (value): value is { payload: string } => Boolean(value && typeof value === 'object' && 'payload' in value && typeof value.payload === 'string'));
  const { draft, editing, open: formOpen } = readForm(formDraft.value.payload);
  const setDraft = (draft: Draft) => formDraft.update((stored) => ({ payload: JSON.stringify({ ...readForm(stored.payload), draft, open: true }) }));
  const setEditing = (editing: string) => formDraft.update((stored) => ({ payload: JSON.stringify({ ...readForm(stored.payload), editing }) }));
  const setFormOpen = (open: boolean) => formDraft.update((stored) => ({ payload: JSON.stringify({ ...readForm(stored.payload), open }) }));
  const [formError, setFormError] = useState(''); const [criteriaMissing, setCriteriaMissing] = useState(false);
  const [refreshError, setRefreshError] = useState(false); const [loadError, setLoadError] = useState('');
  useEffect(() => { if (formError) document.getElementById(criteriaMissing ? 'search-role' : 'search-form-error')?.focus(); }, [formError, criteriaMissing]);
  const [resultLoading, setResultLoading] = useState(false);
  const [feeds, setFeeds] = useState<Feed[]>([]); const [resultsError, setResultsError] = useState(false);
  const [total, setTotal] = useState(0); const [offset, setOffset] = useState(0);
  const formTitle = useRef<HTMLHeadingElement>(null); const resultsTitle = useRef<HTMLHeadingElement>(null);
  const offsetRef = useRef(0); const listVersion = useRef(0);
  const selectedRef = useRef(''); const requestVersion = useRef(0); const focusForm = useRef(false);
  const [loading, setLoading] = useState(true); const [listFailed, setListFailed] = useState(false); const [busy, setBusy] = useState(''); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const errorFocus = useErrorFocus(error);
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
  const loadResults = useCallback(async (id: string, start = 0, background = false) => {
    const version = ++requestVersion.current; if (!background) { setResultLoading(true); setResultsError(false); }
    try {
      let result = await api<{ items: SearchJob[]; total: number }>(`/job-searches/${id}/results?limit=20&offset=${start}`);
      if (result.total > 0 && start >= result.total) {
        start = Math.floor((result.total - 1) / 20) * 20;
        result = await api<{ items: SearchJob[]; total: number }>(`/job-searches/${id}/results?limit=20&offset=${start}`);
      }
      if (version !== requestVersion.current) return;
      if (window.location.pathname === '/searches') window.history.replaceState(null, '', contextHref(id, start));
      setResults(result.items); setResultsError(false); setRefreshError(false); setLoadError(''); setTotal(result.total); setOffset(start); offsetRef.current = start;
      try { sessionStorage.setItem(searchContextKey, JSON.stringify({ search: id, offset: start })); } catch { /* The URL still preserves this view when storage is unavailable. */ }
    } catch (cause) { if (version === requestVersion.current) { if (background) setRefreshError(true); else { setResults([]); setTotal(0); setResultsError(true); setLoadError(errorMessage(cause)); } } }
    finally { if (version === requestVersion.current) setResultLoading(false); }
  }, []);
  const load = useCallback(async (selected?: string, start?: number, background = false) => {
    const ticket = ++listVersion.current;
    try {
      const response = await api<{ searches: Search[]; coverage: { feeds?: Feed[] } }>('/job-searches');
      if (ticket !== listVersion.current) return;
      setListFailed(false); setLoadError(''); setSearches(response.searches); setFeeds(response.coverage.feeds ?? []);
      const requestedId = selected ?? selectedRef.current;
      const active = response.searches.find((item) => item.id === requestedId) ?? response.searches[0];
      selectedRef.current = active?.id ?? ''; setSelectedId(active?.id ?? '');
      if (active) {
        const pageOffset = active.id === requestedId ? start ?? offsetRef.current : 0;
        if (window.location.pathname === '/searches') window.history.replaceState(null, '', contextHref(active.id, pageOffset));
        await loadResults(active.id, pageOffset, background);
      } else { setResults([]); setTotal(0); }
    } catch (cause) { if (ticket === listVersion.current) { if (background) setRefreshError(true); else { setListFailed(true); setLoadError(errorMessage(cause)); } } }
    finally { if (ticket === listVersion.current) setLoading(false); }
  }, [loadResults]);
  useEffect(() => {
    const restore = () => {
      const params = new URLSearchParams(window.location.search);
      const remembered = rememberedContext();
      selectedRef.current = params.get('search') ?? remembered.search;
      offsetRef.current = params.has('search') ? pageOffset(params.get('offset')) : remembered.offset;
      void load(selectedRef.current, offsetRef.current);
    };
    restore(); window.addEventListener('popstate', restore);
    return () => { requestVersion.current++; listVersion.current++; window.removeEventListener('popstate', restore); };
  }, [load]);
  useEffect(() => { if (formOpen && focusForm.current) { formTitle.current?.focus(); focusForm.current = false; } }, [formOpen, editing]);
  const openNew = () => { if (formOpen && (draft.role || draft.company || draft.location) && !window.confirm(t('¿Descartar este borrador y crear otra búsqueda?', 'Discard this draft and create another search?'))) return; setEditing(''); setDraft(emptyDraft()); focusForm.current = true; setFormOpen(true); if (formOpen) formTitle.current?.focus(); };
  const selectedSearch = searches.find((search) => search.id === selectedId);
  const running = searches.some((search) => search.lastRunStatus === 'RUNNING');
  useLocalRefresh(() => load(undefined, undefined, true), { paused: loading || Boolean(busy) || resultLoading, interval: running ? 3000 : 30000 });
  const dateTime = (value: string) => new Intl.DateTimeFormat(es ? 'es-ES' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
  const modeLabel = (mode: Search['workMode']) => ({ any: t('Cualquier modalidad', 'Any work mode'), remote: t('En remoto', 'Remote'), hybrid: t('Híbrida', 'Hybrid'), onsite: t('Presencial', 'On-site') })[mode];

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(''); setFormError(''); setCriteriaMissing(false); setMessage('');
    if (!draft.role.trim() && !draft.company.trim()) { setCriteriaMissing(true); setFormError(t('Indica un puesto, una empresa o ambos.', 'Enter a role, a company, or both.')); document.getElementById('search-role')?.focus(); return; }
    setBusy(editing || 'create');
    const body = { role: draft.role.trim() || null, company: draft.company.trim() || null, location: draft.location.trim() || null, workMode: draft.workMode, frequencyHours: draft.frequencyHours, enabled: draft.enabled, autoPrepare: draft.autoPrepare, language: locale };
    try {
      const saved = await api<{ search: Search }>(editing ? `/job-searches/${editing}` : '/job-searches', { method: editing ? 'PATCH' : 'POST', body: JSON.stringify(body) });
      formDraft.update({ payload: '' }); setMessage(t('Búsqueda guardada. Revisa el resultado de la consulta abajo.', 'Search saved. Check the outcome below.'));
      await load(saved.search.id, 0); resultsTitle.current?.focus();
    } catch (cause) { setFormError(problem(cause)); } finally { setBusy(''); }
  };
  const editSearch = (search: Search) => { if (formOpen && (draft.role || draft.company || draft.location) && !window.confirm(t('¿Descartar este borrador para editar otra búsqueda?', 'Discard this draft to edit another search?'))) return; setEditing(search.id); setDraft({ role: search.role ?? '', company: search.company ?? '', location: search.location ?? '', workMode: search.workMode, frequencyHours: search.frequencyHours, enabled: search.enabled, autoPrepare: search.autoPrepare }); focusForm.current = true; setFormOpen(true); if (formOpen) formTitle.current?.focus(); };
  const runAction = async (search: Search, action: 'refresh' | 'toggle') => {
    setBusy(search.id); setError(''); setMessage('');
    try {
      if (action === 'refresh') {
        const refreshed = await api<{ matched: number; coverage: string }>(`/job-searches/${search.id}/refresh`, { method: 'POST', body: '{}' });
        setMessage(refreshed.matched === 0 ? t('No hay ofertas que coincidan en las fuentes públicas ahora mismo.', 'No matching jobs are available from the public feeds right now.') : t('Búsqueda actualizada.', 'Search refreshed.'));
      } else await api(`/job-searches/${search.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !search.enabled }) });
      await load(search.id);
    } catch (cause) { setError(problem(cause)); } finally { setBusy(''); }
  };
  const choose = async (id: string, start = 0) => { listVersion.current++; setError(''); selectedRef.current = id; offsetRef.current = start; setSelectedId(id); window.history.pushState(null, '', contextHref(id, start)); await loadResults(id, start); resultsTitle.current?.focus(); };

  return <WorkspaceGate><AppShell>
    <PageHeader eyebrow={t('BÚSQUEDA AUTOMÁTICA', 'AUTOMATIC JOB SEARCH')} title={t('Buscar empleo', 'Find jobs')} description={t('Dinos qué buscas. Guardaremos las ofertas que coincidan y volveremos a buscar por ti.', 'Tell us what you are looking for. We save matching jobs and keep searching for you.')} action={<div className={styles.actions}>{!formOpen && searches.length > 0 && <Button disabled={busy !== '' || !formDraft.ready} onClick={openNew}>{t('Nueva búsqueda', 'New search')}</Button>}<Link href="/jobs" className="button button-secondary">{t('Ver ofertas guardadas', 'Open saved jobs')}</Link></div>}/>

    {formOpen && (draft.role || draft.company || draft.location) && <Notice tone={formDraft.storageFailed ? 'warning' : 'info'}>{formDraft.storageFailed ? t('No se pudo conservar el borrador. Guárdalo antes de salir.', 'The draft could not be kept. Save it before leaving.') : t('Borrador conservado en esta pestaña hasta que cierres sesión.', 'Draft kept in this tab until you sign out.')}</Notice>}
    {busy && <Notice>{t('Guardando los cambios y comprobando las ofertas disponibles… Puede tardar unos segundos.', 'Saving changes and checking available jobs… This may take a few seconds.')}</Notice>}
    {refreshError && <Notice tone="warning" actions={<Button variant="quiet" onClick={() => void load(undefined, undefined, true)}>{t('Reintentar actualización', 'Retry update')}</Button>}>{t('No pudimos actualizar la lista. Conservamos los últimos resultados; volveremos a intentarlo.', 'Could not update the list. Your last results are kept; we will try again.')}</Notice>}
    {loadError && <Notice tone="error">{loadError}</Notice>}{error && <div ref={errorFocus} tabIndex={-1} className="action-error"><Notice tone="error">{error}</Notice></div>}{message && <Notice tone="success">{message}</Notice>}
    <div className={styles.layout}>
      {(formOpen || (!loading && !listFailed && searches.length === 0)) && <section className={styles.formColumn} aria-labelledby="search-form-title">
        <Card className={styles.formCard}>
          <h2 id="search-form-title" ref={formTitle} tabIndex={-1}>{t(editing ? 'Editar búsqueda' : '¿Qué trabajo buscas?', editing ? 'Edit search' : 'What job are you looking for?')}</h2>
          <p className={styles.intro}>{t('Indica un puesto, una empresa o ambos. No necesitas completar tu perfil.', 'Enter a role, a company, or both. You do not need to complete your profile.')}</p>
          <form onSubmit={(event) => void submit(event)} className={styles.form}>
            {formError && <div id="search-form-error" tabIndex={-1} className={styles.formError}><Notice tone="error">{formError}</Notice></div>}
            <Field disabled={busy !== '' || !formDraft.ready} id="search-role" name="role" aria-invalid={criteriaMissing || undefined} aria-describedby={formError ? 'search-form-error' : undefined} label={t('Puesto o palabras clave', 'Role or keywords')} value={draft.role} onChange={(event) => { setCriteriaMissing(false); setFormError(''); setDraft({ ...draft, role: event.target.value }); }} placeholder={t('Ej.: Product Designer', 'e.g. product designer')} hint={t('Se buscan estas palabras en el título. Prueba también el puesto en inglés.', 'These words are matched in job titles. Try the title used in the listings.')}/>
            <Field disabled={busy !== '' || !formDraft.ready} label={t('Empresa (opcional)', 'Company (optional)')} value={draft.company} onChange={(event) => { setCriteriaMissing(false); setFormError(''); setDraft({ ...draft, company: event.target.value }); }} placeholder={t('Ej.: Northwind', 'e.g. Northwind')}/>
            <Field disabled={busy !== '' || !formDraft.ready} label={t('Ubicación (opcional)', 'Location (optional)')} value={draft.location} onChange={(event) => setDraft({ ...draft, location: event.target.value })} placeholder={t('Ej.: Berlín o España', 'e.g. Berlin or Spain')}/>
            <details className={styles.moreOptions} key={editing || 'new'} open={editing ? true : undefined}><summary>{t('Más opciones: modalidad y automatización', 'More options: work mode and automation')}</summary><div className={styles.form}>
            <SelectField disabled={busy !== '' || !formDraft.ready} label={t('Modalidad', 'Work mode')} value={draft.workMode} onChange={(event) => setDraft({ ...draft, workMode: event.target.value as Draft['workMode'] })}><option value="any">{t('Cualquiera', 'Any')}</option><option value="remote">{t('En remoto', 'Remote')}</option><option value="hybrid">{t('Híbrida', 'Hybrid')}</option><option value="onsite">{t('Presencial', 'On-site')}</option></SelectField>
            <SelectField disabled={busy !== '' || !formDraft.ready} label={t('Frecuencia de actualización', 'Refresh frequency')} value={draft.frequencyHours} onChange={(event) => setDraft({ ...draft, frequencyHours: Number(event.target.value) as Draft['frequencyHours'] })}><option value={6}>{t('Cada 6 horas', 'Every 6 hours')}</option><option value={12}>{t('Cada 12 horas', 'Every 12 hours')}</option><option value={24}>{t('Cada 24 horas', 'Every 24 hours')}</option></SelectField>
            <label className={styles.check}><input type="checkbox" disabled={busy !== '' || !formDraft.ready} checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}/><span>{t('Actualizar esta búsqueda automáticamente', 'Refresh this search automatically')}</span></label>
            <label className={styles.check}><input type="checkbox" disabled={busy !== '' || !formDraft.ready} checked={draft.autoPrepare} onChange={(event) => setDraft({ ...draft, autoPrepare: event.target.checked })}/><span>{t('Preparar también un CV para cada coincidencia', 'Also prepare a resume for each match')} <small>{t('Usa tu perfil confirmado. Si faltan datos, te pediremos completarlos en Mis solicitudes. Siempre revisarás el CV antes de enviarlo.', 'Uses your confirmed profile. Missing details appear in My applications. You always review the resume before submitting it.')}</small></span></label>
            </div></details>
            <div className={styles.actions}><Button type="submit" disabled={busy !== '' || !formDraft.ready}>{busy ? t('Guardando…', 'Saving…') : t(editing ? 'Guardar cambios' : 'Buscar y guardar', editing ? 'Save changes' : 'Search and save')}</Button>{searches.length > 0 && <Button type="button" variant="quiet" disabled={busy !== '' || !formDraft.ready} onClick={() => { if (window.confirm(t('¿Descartar este borrador?', 'Discard this draft?'))) { setFormError(''); setCriteriaMissing(false); formDraft.update({ payload: '' }); } }}>{t('Descartar borrador', 'Discard draft')}</Button>}</div>
            <p className={styles.automationHint}>{draft.enabled ? t(`Buscaremos ahora y después cada ${draft.frequencyHours} horas mientras la app esté funcionando en tu equipo. Puedes cerrar esta pestaña.`, `We will search now and then every ${draft.frequencyHours} hours while the app is running on your computer. You can close this tab.`) : t('Esta búsqueda se guardará en pausa. Reanúdala cuando quieras recibir ofertas.', 'This search will be saved paused. Resume it when you want to find jobs.')}</p>
            <small className={styles.automationHint}>{t('Fuentes: Remotive y Arbeitnow, con ofertas remotas y de Europa. No cubrimos todos los portales.', 'Sources: Remotive and Arbeitnow, with remote and European jobs. We do not cover every job board.')}</small>
          </form>
        </Card>

      </section>}
      <section className={styles.listColumn} aria-labelledby="saved-searches-title">
        <div className={styles.sectionHead}><div><h2 id="saved-searches-title">{t('Tus búsquedas', 'Your searches')}</h2><p>{t(`${searches.length} búsqueda${searches.length === 1 ? '' : 's'} guardada${searches.length === 1 ? '' : 's'}`, `${searches.length} saved search${searches.length === 1 ? '' : 'es'}`)}</p></div><Button variant="quiet" disabled={loading || resultLoading || busy !== ''} onClick={() => void load()}>{t('Actualizar resultados', 'Reload results')}</Button></div>
        {searches.length > 0 && <ul className={styles.savedSearchGrid} aria-label={t('Búsquedas guardadas', 'Saved searches')}>
          {searches.map((search) => <li key={search.id}>
            <button type="button" className={styles.savedSearchButton} aria-pressed={search.id === selectedId} aria-controls="search-results" disabled={busy !== '' || resultLoading} onClick={() => void choose(search.id)}>
              <span className={styles.savedSearchTitle}>{search.role || search.company || t('Cualquier puesto', 'Any role')}</span>
              <span className={styles.savedSearchMeta}>{[search.role ? search.company : null, search.location, modeLabel(search.workMode)].filter(Boolean).join(' · ')}</span>
              <span className={styles.savedSearchMeta}>{search.enabled ? t('Activa', 'Active') : t('Pausada', 'Paused')} · {search.lastRunStatus === 'RUNNING' ? t('Buscando…', 'Searching…') : search.lastRunStatus === 'FAILED' ? t('Error en la última consulta', 'Last check failed') : !search.lastRunAt ? t('Primera consulta pendiente', 'First check pending') : t(`${search.lastResultCount} oferta${search.lastResultCount === 1 ? '' : 's'} en la última consulta`, `${search.lastResultCount} job${search.lastResultCount === 1 ? '' : 's'} at last check`)}</span>
              <span className={styles.savedSearchAction}>{search.id === selectedId ? t('✓ Viendo esta búsqueda', '✓ Viewing this search') : t('Ver resultados →', 'View results →')}</span>
            </button>
          </li>)}
        </ul>}
        {loading ? <Notice>{t('Cargando búsquedas…', 'Loading searches…')}</Notice> : listFailed && searches.length === 0 ? <Notice actions={<Button variant="secondary" onClick={() => void load()}>{t('Reintentar', 'Try again')}</Button>}>{t('No pudimos cargar tus búsquedas. Reintenta para recuperar la lista.', 'We could not load your searches. Try again to recover the list.')}</Notice> : searches.length === 0 ? <Card><Empty title={t('Todavía no tienes búsquedas', 'No saved searches yet')} detail={t('Guarda una búsqueda para descubrir nuevas ofertas sin añadir enlaces de empresas.', 'Save a search to find public jobs without adding employer links.')}/></Card> : <div className={styles.searchList}>{searches.filter((search) => search.id === selectedId).map((search) => <details className={styles.searchCard} key={search.id}><summary>{t('Ajustes y actividad de esta búsqueda', 'Settings and activity for this search')} · {search.enabled ? t('Activa', 'Active') : t('Pausada', 'Paused')}</summary>
          <div className={styles.cardHead}><div><h3>{search.role || t('Cualquier puesto', 'Any role')}{search.company ? ` · ${search.company}` : ''}</h3><p>{[search.location, modeLabel(search.workMode), `${search.frequencyHours} h`].filter(Boolean).join(' · ')}</p></div><Tag tone={search.enabled ? 'green' : 'neutral'}>{search.enabled ? t('ACTIVA', 'ACTIVE') : t('PAUSADA', 'PAUSED')}</Tag></div>
          <div className={styles.status}>{search.lastRunStatus === 'FAILED' || search.lastRunStatus === 'PARTIAL' || search.lastRunStatus === 'STALE' || search.lastRunStatus === 'BOUNDED' ? <span className={styles.warning}>{search.lastRunStatus === 'PARTIAL' || search.lastRunStatus === 'BOUNDED' ? t('Cobertura limitada: puede haber más ofertas en las fuentes.', 'Limited coverage: the sources may contain more jobs.') : t('Algunos datos pueden estar desactualizados', 'Some results may be stale')}</span> : search.lastRunStatus === 'RUNNING' ? t('Buscando ofertas…', 'Searching for jobs…') : search.lastRunStatus === 'EMPTY' ? t('Sin coincidencias todavía', 'No matches yet') : search.lastRunAt ? t(`Última búsqueda: ${dateTime(search.lastRunAt)}`, `Last checked: ${dateTime(search.lastRunAt)}`) : t('Aún no se ha actualizado', 'Not refreshed yet')}<span>{search.lastResultCount} {search.lastResultCount === 1 ? t('coincidencia', 'match') : t('coincidencias', 'matches')}</span></div>
          {search.enabled && search.nextRunAt && <p className={styles.schedule}>{t('Próxima consulta: ', 'Next check: ')}{dateTime(search.nextRunAt)}</p>}
          <div className={styles.cardActions}><Button variant="quiet" disabled={busy !== '' || !search.enabled || search.lastRunStatus === 'RUNNING' || Boolean(search.nextRunAt && Date.parse(search.nextRunAt) > Date.now())} onClick={() => void runAction(search, 'refresh')}>{busy === search.id ? t('Buscando…', 'Searching…') : t('Actualizar ahora', 'Refresh now')}</Button><Button variant="quiet" disabled={busy !== '' || !formDraft.ready} onClick={() => void runAction(search, 'toggle')}>{search.enabled ? t('Pausar', 'Pause') : t('Reanudar', 'Resume')}</Button><Button variant="quiet" disabled={busy !== '' || !formDraft.ready} onClick={() => editSearch(search)}>{t('Editar', 'Edit')}</Button></div>
        </details>)}</div>}
        {selectedId && <div id="search-results" className={styles.results} aria-live="polite"><h2 ref={resultsTitle} tabIndex={-1}>{t('Resultados de la búsqueda', 'Search results')}{selectedSearch && `: ${[selectedSearch.role, selectedSearch.company].filter(Boolean).join(' · ')}`}</h2>{total > 0 && !resultLoading && <p className={styles.intro}>{t('Abre una oferta que te interese y pulsa Preparar mi solicitud. Te guiaremos con los datos que falten.', 'Open a job that interests you and choose Prepare my application. We will guide you through any missing details.')}</p>}<p>{total} {total === 1 ? t('oferta', 'job') : t('ofertas', 'jobs')}</p><details className={styles.feedSummary}><summary>{t('Fuentes consultadas', 'Sources checked')}</summary><p>{['remotive', 'arbeitnow'].map((provider, index) => { const feed = feeds.find((item) => item.provider === provider); return <span key={provider}>{index > 0 ? ' · ' : ''}{provider === 'remotive' ? 'Remotive' : 'Arbeitnow'}: {!feed?.fetchedAt ? t('sin datos todavía', 'no data yet') : `${feed.listings} ${t('ofertas en la última lectura', 'listings at last fetch')}${feed.coverage === 'BOUNDED' ? t(' (cobertura parcial)', ' (partial coverage)') : ''}${feed.lastError ? t(' (sin actualizar por un error)', ' (not updated due to an error)') : ''}`}</span>; })}</p></details>{resultLoading ? <Notice>{t('Cargando resultados…', 'Loading results…')}</Notice> : results.length ? <div className={styles.resultList}>{results.map((job) => <Card className={styles.resultCard} key={job.id}><div><h3><Link href={`/jobs/${job.id}?returnTo=${encodeURIComponent(contextHref(selectedId, offset))}`}>{job.title}</Link></h3><p>{job.company} · {job.location || t('Ubicación sin indicar', 'Location not listed')}</p>{selectedSearch?.autoPrepare && !job.autoPreparedAt && <small className={styles.preparationStatus}>{!selectedSearch.enabled ? t('Preparación pausada con esta búsqueda.', 'Preparation is paused with this search.') : job.autoPrepareError === 'PREPARATION_FAILED' ? t('No se pudo preparar el CV. Volveremos a intentarlo; también puedes abrir la oferta para prepararlo.', 'Could not prepare the resume. We will retry; you can also open the job to prepare it.') : t('Candidatura pendiente de preparación.', 'Application waiting to be prepared.')}</small>}{selectedSearch?.autoPrepare && job.autoPreparedAt && <Link href="/applications?view=review">{t('Continuar con la solicitud', 'Continue with the application')}</Link>}{job.unknownLocation && <small className={styles.warning}>{t('La ubicación es amplia o no está indicada; comprueba dónde puedes trabajar.', 'The location is broad or unspecified; check where you can work.')}</small>}</div><div className={styles.sources}>{job.sources.map((source) => <a key={`${source.provider}:${source.url}`} href={source.url} target="_blank" rel="noopener noreferrer">{source.provider === 'remotive' ? 'Remotive' : 'Arbeitnow'}</a>)}</div></Card>)}</div> : <Card className={styles.emptyResults}>
          <Empty title={resultsError ? t('No pudimos cargar los resultados', 'Could not load results') : selectedSearch?.lastRunStatus === 'RUNNING' ? t('Estamos buscando ofertas', 'Searching for jobs') : !selectedSearch?.lastRunAt ? t(selectedSearch?.enabled ? 'Tu primera consulta está pendiente' : 'Esta búsqueda está pausada', selectedSearch?.enabled ? 'Your first search is pending' : 'This search is paused') : selectedSearch.lastRunStatus === 'FAILED' ? t('No pudimos completar la búsqueda', 'Could not complete the search') : t('No encontramos coincidencias en estas fuentes', 'No matches in these sources')}
            detail={resultsError ? t('Reintenta cargar la lista. Esto no inicia otra consulta a las fuentes.', 'Retry loading the list. This does not start a new source request.') : selectedSearch?.lastRunStatus === 'RUNNING' ? t('Los resultados aparecerán aquí cuando termine la consulta.', 'Results will appear here when the search finishes.') : !selectedSearch?.lastRunAt ? t(selectedSearch?.enabled ? 'La búsqueda se ejecutará con el servicio local encendido.' : 'Reanúdala para consultar las ofertas disponibles.', selectedSearch?.enabled ? 'The search will run while the local service is on.' : 'Resume it to check available jobs.') : selectedSearch.lastRunStatus === 'FAILED' ? t('Las fuentes no respondieron correctamente. Volveremos a intentarlo; cero resultados no significa que no haya ofertas.', 'The sources did not respond correctly. We will retry; zero results does not mean there are no jobs.') : t('Se consultaron las ofertas disponibles, pero ninguna coincide con tus filtros. Esto no significa que no existan vacantes en otros portales.', 'Available listings were checked, but none match your filters. Other job boards may still have vacancies.')}/>
          {!resultsError && selectedSearch?.lastRunAt && !['RUNNING', 'FAILED'].includes(selectedSearch.lastRunStatus ?? '') && <>
            <p>{t('Revisa la escritura del puesto, prueba palabras más amplias o el título en inglés. Todas las palabras deben aparecer en el título; las siglas no se amplían automáticamente.', 'Check the spelling, try broader keywords or the English job title. All words must appear in the title; acronyms are not expanded automatically.')}</p>
            <p>{t('Puedes editar los filtros ahora: comprobamos las ofertas ya disponibles sin esperar a la próxima actualización.', 'You can edit the filters now: we check already available listings without waiting for the next update.')}</p>
          </>}
          <div className={styles.actions}>{resultsError ? <Button variant="secondary" onClick={() => void loadResults(selectedId)}>{t('Reintentar', 'Try again')}</Button> : selectedSearch && <><Button disabled={busy !== '' || !formDraft.ready} onClick={() => editSearch(selectedSearch)}>{t('Ajustar esta búsqueda', 'Adjust this search')}</Button>{!selectedSearch.enabled && <Button variant="secondary" disabled={busy !== '' || !formDraft.ready} onClick={() => void runAction(selectedSearch, 'toggle')}>{t('Reanudar búsqueda', 'Resume search')}</Button>}</>}</div>
        </Card>}{total > 20 && <nav className={styles.actions} aria-label={t('Páginas de resultados', 'Result pages')}><Button variant="secondary" disabled={offset === 0 || resultLoading} onClick={() => void choose(selectedId, Math.max(0, offset - 20))}>{t('Anterior', 'Previous')}</Button><span>{Math.floor(offset / 20) + 1} / {Math.ceil(total / 20)}</span><Button variant="secondary" disabled={offset + 20 >= total || resultLoading} onClick={() => void choose(selectedId, offset + 20)}>{t('Siguiente', 'Next')}</Button></nav>}</div>}
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
