'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { AppShell, PageHeader, WorkspaceGate } from '@/components/shell';
import { Button, Card, Empty, Notice } from '@/components/ui';
import { SearchCard } from '@/components/search-card';
import { SearchForm } from '@/components/search-form';
import { SearchEmptyState, SearchProgress } from '@/components/search-progress';
import { SearchResultCard } from '@/components/search-result-card';
import { searchInFlight, type ProviderId, type Search, type SearchDraft, type SearchJob, type SearchSort, type SearchView } from '@/components/search-types';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useErrorFocus } from '@/lib/disclosure-focus';
import { useLocalRefresh } from '@/lib/local-refresh';
import { useSessionDraft } from '@/lib/session-draft';
import { useLocale } from '@/lib/i18n';
import styles from './searches.module.css';

const successMessages = {
  searchSaved: ['Búsqueda guardada. Puedes revisar las ofertas mientras continúa la consulta.', 'Search saved. You can review jobs while the search continues.'],
  refresh: ['Actualización solicitada. Las fuentes pueden devolver datos en caché.', 'Refresh requested. Sources may return cached results.'],
  saved: ['Oferta guardada.', 'Job saved.'],
  archived: ['Oferta archivada. Puedes restaurarla en Archivadas.', 'Job archived. You can restore it from Archived.'],
  restored: ['Oferta restaurada.', 'Job restored.'],
  reviewed: ['Marcada como revisada.', 'Marked as reviewed.'],
} as const;

const defaultProviders: ProviderId[] = ['remotive', 'arbeitnow', 'himalayas'];
const emptyDraft = (): SearchDraft => ({ role: '', company: '', location: '', workMode: 'any', frequencyHours: 24, enabled: true, autoPrepare: false, providerIds: defaultProviders, matcherVersion: 2, includeRelated: false, improveMatching: false });
type FormState = { draft: SearchDraft; editing: string; open: boolean; idempotencyKey: string };
const initialForm = (): FormState => ({ draft: emptyDraft(), editing: '', open: false, idempotencyKey: '' });
function readForm(payload: string): FormState {
  try {
    const value = JSON.parse(payload) as Partial<FormState>;
    const d = value.draft as Partial<SearchDraft> | undefined;
    if (typeof value.editing === 'string' && typeof value.open === 'boolean' && d &&
      ['role', 'company', 'location'].every((key) => typeof d[key as 'role'] === 'string') &&
      ['any', 'remote', 'hybrid', 'onsite'].includes(d.workMode ?? '') && [6, 12, 24].includes(d.frequencyHours ?? -1) &&
      typeof d.enabled === 'boolean' && typeof d.autoPrepare === 'boolean') {
      return { ...value as FormState, idempotencyKey: typeof value.idempotencyKey === 'string' ? value.idempotencyKey : '', draft: { ...emptyDraft(), ...d, providerIds: Array.isArray(d.providerIds) ? d.providerIds : defaultProviders } };
    }
  } catch { /* Ignore malformed draft data. */ }
  return initialForm();
}
const views: SearchView[] = ['new', 'all', 'saved', 'archived'];
const sorts: SearchSort[] = ['relevance', 'recent'];
const searchInProgress = (search: Search) => searchInFlight(search);
const contextKey = 'career:draft:v1:saved-search-view';
const pageOffset = (value: unknown) => { const n = Number(value); return Number.isFinite(n) ? Math.min(100_000, Math.max(0, Math.floor(n / 20) * 20)) : 0; };
function contextHref(search: string, view: SearchView, sort: SearchSort, offset: number) {
  return `/searches?${new URLSearchParams({ search: search || 'all', view, sort, offset: String(offset) })}`;
}
function readContext() {
  try {
    const params = new URLSearchParams(window.location.search);
    const remembered = JSON.parse(sessionStorage.getItem(contextKey) ?? '{}') as { search?: string; view?: SearchView; sort?: SearchSort; offset?: number };
    return {
      search: params.get('search') === 'all' ? '' : params.get('search') ?? remembered.search ?? '',
      view: views.includes(params.get('view') as SearchView) ? params.get('view') as SearchView : views.includes(remembered.view as SearchView) ? remembered.view! : 'new',
      sort: sorts.includes(params.get('sort') as SearchSort) ? params.get('sort') as SearchSort : sorts.includes(remembered.sort as SearchSort) ? remembered.sort! : 'relevance',
      offset: params.has('offset') ? pageOffset(params.get('offset')) : pageOffset(remembered.offset),
    };
  } catch { return { search: '', view: 'new' as SearchView, sort: 'relevance' as SearchSort, offset: 0 }; }
}
type ResultsPayload = { items: SearchJob[]; total: number; resultVersion?: string | number; latestRun?: Search['latestRun'] };

export default function SearchesPage() {
  const { locale } = useLocale(); const es = locale === 'es';
  const t = (spanish: string, english: string) => es ? spanish : english;
  const [searches, setSearches] = useState<Search[]>([]); const [results, setResults] = useState<SearchJob[]>([]);
  const [selectedId, setSelectedId] = useState(''); const [view, setView] = useState<SearchView>('new'); const [sort, setSort] = useState<SearchSort>('relevance');
  const formDraft = useSessionDraft('saved-search-form', { payload: '' }, (value): value is { payload: string } => Boolean(value && typeof value === 'object' && 'payload' in value && typeof value.payload === 'string'));
  const formState = readForm(formDraft.value.payload); const { draft, editing, open: formOpen } = formState;
  const editSearch = searches.find((search) => search.id === editing);
  const setFormState = (next: FormState) => formDraft.update({ payload: JSON.stringify(next) });
  const setDraft = (next: SearchDraft) => setFormState({ ...readForm(formDraft.value.payload), draft: next, open: true });
  const [formError, setFormError] = useState(''); const [criteriaMissing, setCriteriaMissing] = useState(false); const [invalidField, setInvalidField] = useState<string | null>(null);
  const [loading, setLoading] = useState(true); const [listFailed, setListFailed] = useState(false); const [resultLoading, setResultLoading] = useState(false); const [resultsError, setResultsError] = useState(false);
  const [total, setTotal] = useState(0); const [offset, setOffset] = useState(0); const [busy, setBusy] = useState(''); const [error, setError] = useState(''); const [message, setMessage] = useState<keyof typeof successMessages | ''>(''); const [loadError, setLoadError] = useState('');
  const [pendingArrivals, setPendingArrivals] = useState(false); const [latestRun, setLatestRun] = useState<Search['latestRun']>(null);
  const titleRef = useRef<HTMLHeadingElement>(null); const resultsTitle = useRef<HTMLHeadingElement>(null); const focusForm = useRef(false);
  const selectedRef = useRef(''); const viewRef = useRef<SearchView>('new'); const sortRef = useRef<SearchSort>('relevance'); const offsetRef = useRef(0); const listRequest = useRef(0); const resultRequest = useRef(0); const initialized = useRef(false);
  const searchesRef = useRef<Search[]>([]); const resultVersionRef = useRef<string | number | undefined>(undefined); const totalRef = useRef(0); const resultItemsRef = useRef<SearchJob[]>([]); const resultViewRef = useRef('');
  const errorFocus = useErrorFocus(error);
  const selectedSearch = searches.find((search) => search.id === selectedId);
  const anyRunning = searches.some(searchInProgress);
  const sourceError = (search: Search) => search.latestRun?.status === 'FAILED' || search.lastRunStatus === 'FAILED' || (search.latestRun?.status === 'PARTIAL' && Boolean(search.latestRun.finishedAt)) || Boolean(search.latestRun?.sources.some((source) => ['FAILED', 'ERROR'].includes(source.status.toUpperCase())));
  const saveContext = (searchId = selectedRef.current, nextView = viewRef.current, nextSort = sortRef.current, nextOffset = offsetRef.current, replace = true) => {
    const href = contextHref(searchId, nextView, nextSort, nextOffset);
    window.history[replace ? 'replaceState' : 'pushState'](null, '', href);
    try { sessionStorage.setItem(contextKey, JSON.stringify({ search: searchId, view: nextView, sort: nextSort, offset: nextOffset })); } catch { /* URL continues to preserve this tab's context. */ }
  };
  const sourceName = (id: string) => ({ remotive: 'Remotive', arbeitnow: 'Arbeitnow', himalayas: 'Himalayas', boards: t('Empresas seguidas', 'Followed companies') } as Record<string, string>)[id] ?? id;
  const dateTime = (value: string) => new Intl.DateTimeFormat(es ? 'es-ES' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
  const modeLabel = (mode: Search['workMode']) => ({ any: t('Cualquier modalidad', 'Any work mode'), remote: t('En remoto', 'Remote'), hybrid: t('Híbrida', 'Hybrid'), onsite: t('Presencial', 'On-site') })[mode];
  const viewPath = (search: string) => `${search ? `/job-searches/${encodeURIComponent(search)}/results` : '/job-searches/results'}`;

  const loadResults = useCallback(async (search: string, nextView: SearchView, nextSort: SearchSort, start: number, background = false) => {
    const ticket = ++resultRequest.current;
    if (!background) { setResultLoading(true); setResultsError(false); }
    const viewKey = `${search}|${nextView}|${nextSort}`;
    const query = new URLSearchParams({ view: nextView, sort: nextSort, offset: String(start), limit: '20' });
    try {
      let payload = await api<ResultsPayload>(`${viewPath(search)}?${query}`);
      if (payload.total > 0 && start >= payload.total) {
        start = Math.floor((payload.total - 1) / 20) * 20; query.set('offset', String(start));
        payload = await api<ResultsPayload>(`${viewPath(search)}?${query}`);
      }
      if (ticket !== resultRequest.current) return false;
      setResultsError(false); setLoadError(''); setLatestRun(payload.latestRun ?? searchesRef.current.find((item) => item.id === search)?.latestRun ?? null);
      const sameView = viewKey === resultViewRef.current;
      const changedItems = payload.total !== totalRef.current || payload.items.map((item) => item.groupId ?? item.id).join('|') !== resultItemsRef.current.map((item) => item.groupId ?? item.id).join('|');
      if (background && sameView && changedItems && resultItemsRef.current.length > 0) { setPendingArrivals(true); return; }
      setPendingArrivals(false); resultViewRef.current = viewKey; resultItemsRef.current = payload.items; totalRef.current = payload.total; setResults(payload.items); setTotal(payload.total); setOffset(start); offsetRef.current = start;
      if (payload.resultVersion !== undefined) resultVersionRef.current = payload.resultVersion;
      saveContext(search, nextView, nextSort, start);
      return true;
    } catch (cause) {
      if (ticket === resultRequest.current) {
        if (!background) { setResultsError(true); setLoadError(errorMessage(cause)); }
      }
      return false;
    } finally { if (ticket === resultRequest.current && !background) setResultLoading(false); }
  }, []);

  const load = useCallback(async (background = false, restoreContext?: ReturnType<typeof readContext>) => {
    const ticket = ++listRequest.current;
    try {
      const response = await api<{ searches: Search[] }>('/job-searches');
      if (ticket !== listRequest.current) return;
      searchesRef.current = response.searches;
      setSearches(response.searches); setListFailed(false); setLoadError('');
      const context = restoreContext ?? { search: selectedRef.current, view: viewRef.current, sort: sortRef.current, offset: offsetRef.current };
      const id = context.search && response.searches.some((search) => search.id === context.search) ? context.search : '';
      selectedRef.current = id; setSelectedId(id); viewRef.current = context.view; setView(context.view); sortRef.current = context.sort; setSort(context.sort); offsetRef.current = context.offset;
      if (!initialized.current && !context.search && !window.location.search) { viewRef.current = 'new'; setView('new'); }
      initialized.current = true;
      await loadResults(id, context.view, context.sort, context.offset, background);
    } catch (cause) {
      if (ticket === listRequest.current && !background) { setListFailed(true); setLoadError(errorMessage(cause)); }
    } finally { if (ticket === listRequest.current) setLoading(false); }
  }, [loadResults]);

  useEffect(() => {
    const restore = () => { const context = readContext(); void load(false, context); };
    restore(); window.addEventListener('popstate', restore);
    return () => { listRequest.current++; resultRequest.current++; window.removeEventListener('popstate', restore); };
  }, [load]);
  useEffect(() => { if (formOpen && focusForm.current) { titleRef.current?.focus(); focusForm.current = false; } }, [formOpen, editing]);
  useEffect(() => {
    if (!formError) return;
    document.getElementById(invalidField ? `search-${invalidField}` : criteriaMissing ? 'search-role' : 'search-form-error')?.focus();
  }, [formError, criteriaMissing, invalidField]);
  useLocalRefresh(() => load(true), { paused: loading || Boolean(busy) || resultLoading, interval: anyRunning ? 3000 : 30000 });

  const choose = async (id: string, nextView = view, nextSort = sort, start = 0, push = true) => {
    selectedRef.current = id; setSelectedId(id); viewRef.current = nextView; setView(nextView); sortRef.current = nextSort; setSort(nextSort); offsetRef.current = start; setOffset(start);
    saveContext(id, nextView, nextSort, start, !push); await loadResults(id, nextView, nextSort, start); resultsTitle.current?.focus();
  };
  const openNew = () => {
    if (formOpen && (draft.role || draft.company || draft.location) && !window.confirm(t('¿Descartar este borrador y crear otra búsqueda?', 'Discard this draft and create another search?'))) return;
    focusForm.current = true; setFormState({ draft: emptyDraft(), editing: '', open: true, idempotencyKey: crypto.randomUUID() });
  };
  const beginEdit = (search: Search) => {
    if (formOpen && (draft.role || draft.company || draft.location) && !window.confirm(t('¿Descartar este borrador para editar otra búsqueda?', 'Discard this draft to edit another search?'))) return;
    const legacy = search.matcherVersion === 1;
    focusForm.current = true;
    setFormState({ editing: search.id, open: true, idempotencyKey: '', draft: { role: search.role ?? '', company: search.company ?? '', location: search.location ?? '', workMode: search.workMode, frequencyHours: search.frequencyHours, enabled: search.enabled, autoPrepare: search.autoPrepare, providerIds: search.providerIds ?? defaultProviders, matcherVersion: search.matcherVersion ?? 1, includeRelated: search.includeRelated ?? false, improveMatching: !legacy } });
  };
  const closeDraft = () => {
    if (!window.confirm(t('¿Descartar este borrador sin guardar?', 'Discard this unsaved draft?'))) return;
    setFormError(''); setCriteriaMissing(false); formDraft.update({ payload: '' });
  };
  const problem = (cause: unknown) => {
    if (cause instanceof ApiError && cause.status === 409) return t('Esta búsqueda cambió en otra pestaña. Actualiza la lista y vuelve a aplicar tus cambios.', 'This search changed in another tab. Reload the list and apply your changes again.');
    return cause instanceof ApiError && cause.code === 'SEARCH_REFRESH_ALREADY_RUNNING' ? t('La consulta sigue en curso. Conservamos las ofertas visibles.', 'The search is still running. Visible jobs are preserved.') : errorMessage(cause);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(''); setFormError(''); setCriteriaMissing(false); setInvalidField(null); setMessage('');
    if (!draft.role.trim() && !draft.company.trim()) { setCriteriaMissing(true); setFormError(t('Indica un puesto, una empresa o ambos.', 'Enter a role, a company, or both.')); document.getElementById('search-role')?.focus(); return; }
    const tooLong = (['role', 'company', 'location'] as const).find((field) => draft[field].trim().length > 200);
    if (tooLong) { setInvalidField(tooLong); setFormError(t('Usa un máximo de 200 caracteres en cada campo.', 'Use at most 200 characters in each field.')); document.getElementById(`search-${tooLong}`)?.focus(); return; }
    if (!draft.providerIds.length) { setFormError(t('Elige al menos una fuente de ofertas.', 'Choose at least one job source.')); return; }
    setBusy(editing || 'create');
    const body: Record<string, unknown> = { role: draft.role.trim() || null, company: draft.company.trim() || null, location: draft.location.trim() || null, workMode: draft.workMode, frequencyHours: draft.frequencyHours, enabled: draft.enabled, autoPrepare: draft.autoPrepare, language: locale };
    if (!editing || !editSearch || editSearch.matcherVersion === 2 || draft.improveMatching) {
      body.matcherVersion = draft.improveMatching || !editing ? 2 : draft.matcherVersion;
      body.providerIds = draft.providerIds; body.includeRelated = draft.includeRelated;
    }
    if (editing && editSearch) body.expectedRevision = editSearch.revision;
    if (!editing) {
      const idempotencyKey = formState.idempotencyKey || crypto.randomUUID();
      if (!formState.idempotencyKey) setFormState({ ...formState, idempotencyKey });
      body.idempotencyKey = idempotencyKey;
    }
    try {
      const response = await api<{ search: Search; runId?: string; refresh: null }>(editing ? `/job-searches/${editing}` : '/job-searches', { method: editing ? 'PATCH' : 'POST', body: JSON.stringify(body) });
      const id = response.search.id; formDraft.update({ payload: '' }); setMessage('searchSaved');
      await load(false, { search: id, view: 'new', sort: 'relevance', offset: 0 }); resultsTitle.current?.focus();
    } catch (cause) { setFormError(problem(cause)); } finally { setBusy(''); }
  };
  const runAction = async (search: Search, action: 'refresh' | 'toggle') => {
    setBusy(search.id); setError(''); setMessage('');
    try {
      if (action === 'refresh') {
        await api<{ runId: string }>(`/job-searches/${search.id}/refresh`, { method: 'POST', body: '{}' });
        setMessage('refresh');
      } else await api(`/job-searches/${search.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !search.enabled, expectedRevision: search.revision }) });
      await load(false);
    } catch (cause) { setError(problem(cause)); } finally { setBusy(''); }
  };
  const updateReview = async (job: SearchJob, decision: 'SHORTLISTED' | 'ARCHIVED' | 'UNREVIEWED' | 'SKIPPED') => {
    setBusy(job.id); setError(''); setMessage('');
    try {
      await api(`/jobs/${job.id}/shortlist`, { method: 'POST', body: JSON.stringify({ decision }) });
      setMessage(decision === 'SHORTLISTED' ? 'saved' : decision === 'ARCHIVED' ? 'archived' : 'restored');
      await loadResults(selectedId, view, sort, offset);
    } catch (cause) { setError(problem(cause)); } finally { setBusy(''); }
  };
  const markReviewed = async (job: SearchJob) => {
    setBusy(job.id); setError('');
    try {
      const ids = selectedId ? [selectedId] : job.searchIds ?? [];
      await Promise.all(ids.map((id) => api(`/job-searches/${id}/results/${job.id}/review`, { method: 'POST', body: '{}' })));
      await loadResults(selectedId, view, sort, offset);
      setMessage('reviewed');
    } catch (cause) { setError(problem(cause)); } finally { setBusy(''); }
  };
  const showArrivals = async () => { if (await loadResults(selectedId, view, sort, offset)) resultsTitle.current?.focus(); };
  const changeView = (next: SearchView) => { void choose(selectedId, next, sort, 0); };
  const changeSort = (next: SearchSort) => { void choose(selectedId, view, next, 0); };

  const filterTabs: Array<{ id: SearchView; es: string; en: string }> = [
    { id: 'new', es: 'Nuevas', en: 'New' }, { id: 'all', es: 'Todas', en: 'All' }, { id: 'saved', es: 'Guardadas', en: 'Saved' }, { id: 'archived', es: 'Archivadas', en: 'Archived' },
  ];
  const pageCount = Math.ceil(total / 20);
  const resultsReturn = contextHref(selectedId, view, sort, offset);
  const progressSearches = selectedId ? (selectedSearch ? [selectedSearch] : []) : searches.filter((search) => {
    return searchInProgress(search) || sourceError(search) || Boolean(search.latestRun?.error || search.lastError);
  });

  return <WorkspaceGate><AppShell>
    <PageHeader eyebrow={t('BÚSQUEDA AUTOMÁTICA', 'AUTOMATIC JOB SEARCH')} title={t('Buscar empleo', 'Find jobs')} description={t('Guarda lo que buscas y vuelve a una lista de ofertas nuevas, explicadas y sin saltos cuando llegan más resultados.', 'Save what you are looking for and return to a clear, useful list as new jobs arrive.')} action={<div className={styles.actions}>{!formOpen && searches.length > 0 && <Button disabled={busy !== '' || !formDraft.ready} onClick={openNew}>{t('Nueva búsqueda', 'New search')}</Button>}<a href="/jobs" className="button button-secondary">{t('Ver ofertas guardadas', 'Open saved jobs')}</a></div>} />
    {busy && <Notice>{busy === 'create' ? t('Guardando la búsqueda…', 'Saving your search…') : t('Guardando cambios…', 'Saving changes…')}</Notice>}
    {loadError && <Notice tone={listFailed ? 'error' : 'warning'} actions={listFailed ? <Button variant="secondary" onClick={() => void load()}>{t('Reintentar', 'Try again')}</Button> : undefined}>{loadError}</Notice>}
    {error && <div ref={errorFocus} tabIndex={-1} className="action-error"><Notice tone="error">{error}</Notice></div>}
    {message && <Notice tone="success">{t(successMessages[message][0], successMessages[message][1])}</Notice>}
    {pendingArrivals && <Notice tone="info" actions={<Button variant="secondary" onClick={showArrivals}>{t('Mostrar nuevas ofertas', 'Show new jobs')}</Button>}>{t('Hay ofertas nuevas. Tu página y posición siguen como estaban.', 'New jobs are available. Your page and position are unchanged.')}</Notice>}
    <div className={styles.layout}>
      {(formOpen || (!loading && !listFailed && searches.length === 0)) && <SearchForm draft={draft} editing={editing} existingSearch={editSearch} busy={Boolean(busy)} ready={formDraft.ready} storageFailed={formDraft.storageFailed} formError={formError} criteriaMissing={criteriaMissing} invalidField={invalidField} titleRef={titleRef} onDraftChange={setDraft} onSubmit={(event) => void submit(event)} onDismissDraft={closeDraft} hasSearches={searches.length > 0} t={t} />}
      <section className={styles.listColumn} aria-labelledby="saved-searches-title">
        <div className={styles.sectionHead}><div><h2 id="saved-searches-title">{t('Todas las búsquedas', 'All searches')}</h2><p>{t(`${searches.length} búsqueda${searches.length === 1 ? '' : 's'} guardada${searches.length === 1 ? '' : 's'}`, `${searches.length} saved search${searches.length === 1 ? '' : 'es'}`)}</p></div><Button variant="quiet" disabled={loading || resultLoading || busy !== ''} onClick={() => void load()}>{t('Actualizar', 'Reload')}</Button></div>
        {loading && <Notice>{t('Cargando búsquedas…', 'Loading searches…')}</Notice>}
        {listFailed && <Card><Empty title={t('No pudimos cargar las búsquedas', 'Could not load searches')} detail={t('Reintenta para recuperar la lista.', 'Try again to recover the list.')} /><Button variant="secondary" onClick={() => void load()}>{t('Reintentar', 'Try again')}</Button></Card>}
        {!loading && !listFailed && searches.length === 0 && <Card><Empty title={t('Todavía no tienes búsquedas', 'No saved searches yet')} detail={t('Empieza con un puesto o una empresa. No necesitas un CV.', 'Start with a role or company. You do not need a resume.')} /></Card>}
        {searches.length > 0 && <div className={styles.searchList} role="list" aria-label={t('Búsquedas guardadas', 'Saved searches')}>
          <div role="listitem"><Card className={`${styles.searchCard} ${!selectedId ? styles.searchCardSelected : ''}`}><div className={styles.cardHead}><div><h3><button type="button" className={styles.searchTitleButton} aria-pressed={!selectedId} aria-controls="search-results" onClick={() => void choose('', view, sort, 0)}>{t('Todas las búsquedas', 'All searches')}</button></h3><p>{searches.length} {searches.length === 1 ? t('búsqueda guardada', 'saved search') : t('búsquedas guardadas', 'saved searches')}</p></div><span className={styles.searchCardMeta}>{searches.reduce((sum, search) => sum + (search.lastNewCount || 0), 0)} {t('nuevas', 'new')}</span></div></Card></div>
          {searches.map((search) => <div role="listitem" key={search.id}><SearchCard search={search} selected={selectedId === search.id} disabled={Boolean(busy) || resultLoading} onSelect={() => void choose(search.id, view, sort, 0)} onEdit={() => beginEdit(search)} onToggle={() => void runAction(search, 'toggle')} onRefresh={() => void runAction(search, 'refresh')} t={t} modeLabel={modeLabel} dateTime={dateTime} /></div>)}
        </div>}
      </section>
      <section className={styles.results} id="search-results" aria-labelledby="search-results-title">
        <div className={styles.resultsHead}><h2 id="search-results-title" ref={resultsTitle} tabIndex={-1}>{t('Ofertas encontradas', 'Matching jobs')}{selectedSearch ? ` · ${[selectedSearch.role, selectedSearch.company].filter(Boolean).join(' · ')}` : ''}</h2><div className={styles.sortControl}><label htmlFor="search-sort">{t('Ordenar', 'Sort')}</label><select id="search-sort" value={sort} onChange={(event) => changeSort(event.target.value as SearchSort)}><option value="relevance">{t('Coincidencia', 'Relevance')}</option><option value="recent">{t('Más recientes', 'Most recent')}</option></select></div></div>
        <div className={styles.filterTabs} role="tablist" aria-label={t('Filtrar ofertas', 'Filter jobs')}>{filterTabs.map((tab) => <button key={tab.id} type="button" role="tab" aria-selected={view === tab.id} onClick={() => changeView(tab.id)}>{t(tab.es, tab.en)}</button>)}</div>
        {progressSearches.map((search) => <SearchProgress key={search.id} search={search} t={t} sourceName={sourceName} dateTime={dateTime} />)}
        <p className={styles.resultCount}>{total} {total === 1 ? t('oferta', 'job') : t('ofertas', 'jobs')}</p>
        {resultLoading ? <Notice>{t('Cargando resultados…', 'Loading results…')}</Notice> : results.length > 0 ? <div className={styles.resultList}>{results.map((job) => <SearchResultCard key={job.id} job={job} returnTo={resultsReturn} view={view} latestRun={latestRun} busy={Boolean(busy)} t={t} sourceName={sourceName} onSave={() => void updateReview(job, 'SHORTLISTED')} onArchive={() => void updateReview(job, job.shortlistDecision === 'ARCHIVED' ? 'UNREVIEWED' : 'ARCHIVED')} onReview={() => void markReviewed(job)} />)}</div> : !loading && (selectedId ? <SearchEmptyState search={selectedSearch} view={view} caughtUp={Boolean(selectedSearch?.latestRun?.finishedAt || selectedSearch?.lastRunAt)} error={resultsError} inProgress={Boolean(selectedSearch && searchInProgress(selectedSearch))} paused={Boolean(selectedSearch && !selectedSearch.enabled)} sourceError={Boolean(selectedSearch && sourceError(selectedSearch))} onRetry={() => void loadResults(selectedId, view, sort, offset)} onEdit={() => selectedSearch && beginEdit(selectedSearch)} onResume={() => selectedSearch && void runAction(selectedSearch, 'toggle')} t={t} /> : searches.length > 0 ? <SearchEmptyState view={view} caughtUp={searches.every((search) => Boolean(search.latestRun?.finishedAt || search.lastRunAt))} error={resultsError} inProgress={progressSearches.length > 0} paused={searches.every((search) => !search.enabled)} sourceError={searches.some(sourceError)} onRetry={() => void loadResults('', view, sort, offset)} onEdit={searches.some((search) => search.enabled) ? openNew : undefined} t={t} /> : null)}
        {pageCount > 1 && <nav className={styles.pagination} aria-label={t('Páginas de resultados', 'Result pages')}><Button variant="secondary" disabled={offset === 0 || resultLoading} onClick={() => void choose(selectedId, view, sort, Math.max(0, offset - 20))}>{t('Anterior', 'Previous')}</Button><span>{Math.floor(offset / 20) + 1} / {pageCount}</span><Button variant="secondary" disabled={offset + 20 >= total || resultLoading} onClick={() => void choose(selectedId, view, sort, offset + 20)}>{t('Siguiente', 'Next')}</Button></nav>}
      </section>
    </div>
    <details className={styles.coverage}><summary>{t('Fuentes y datos enviados', 'Sources and data shared')}</summary><p>{t('Remotive, Arbeitnow e Himalayas pueden buscar ofertas según las fuentes activadas. Cuando eliges Himalayas, compartimos únicamente los criterios de búsqueda que escribes (puesto, empresa o país), nunca tu CV ni datos de contacto. Las empresas seguidas aparecen solo si las incluyes.', 'Remotive, Arbeitnow and Himalayas can find jobs when enabled. If you choose Himalayas, we share only the search criteria you enter (role, company or country), never your resume or contact details. Followed company boards appear only when selected.')}</p><p><a href="https://github.com/remotive-com/remote-jobs-api" target="_blank" rel="noopener noreferrer">Remotive</a> · <a href="https://www.arbeitnow.com/blog/job-board-api" target="_blank" rel="noopener noreferrer">Arbeitnow</a> · <a href="https://himalayas.app/docs/remote-jobs-api" target="_blank" rel="noopener noreferrer">Himalayas</a></p></details>
  </AppShell></WorkspaceGate>;
}
