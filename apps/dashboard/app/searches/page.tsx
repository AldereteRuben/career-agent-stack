'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { AppShell, PageHeader, WorkspaceGate } from '@/components/shell';
import { Button, Card, Empty, Notice, TextareaField } from '@/components/ui';
import { AiDraftAction, useAiAvailable } from '@/components/ai/draft-action';
import type { AiArtifact } from '@/components/ai/result-view';
import { SearchCard } from '@/components/search-card';
import { SearchForm } from '@/components/search-form';
import { SearchEmptyState, SearchStatus } from '@/components/search-progress';
import { SearchResultCard } from '@/components/search-result-card';
import { type ProviderId, type Search, type SearchDraft, type SearchJob, type SearchSort, type SearchView } from '@/components/search-types';
import { emptyKind, nextCheckLabel, searchName, summarize } from '@/components/lib/search-status';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useErrorFocus } from '@/lib/disclosure-focus';
import { useLocalRefresh } from '@/lib/local-refresh';
import { useSessionDraft } from '@/lib/session-draft';
import { useLocale } from '@/lib/i18n';
import styles from './searches.module.css';

const successMessages = {
  searchSaved: ['Búsqueda guardada.', 'Search saved.'],
  refresh: ['Consulta solicitada. Algunos portales pueden devolver datos recientes guardados.', 'Check requested. Some portals may return recently saved results.'],
} as const;
const actionMessages = {
  saved: ['Oferta guardada.', 'Job saved.'],
  unsaved: ['Oferta quitada de guardadas.', 'Job removed from saved.'],
  archived: ['Oferta archivada. Puedes recuperarla en Archivadas.', 'Job archived. You can restore it from Archived.'],
  restored: ['Oferta recuperada.', 'Job restored.'],
  reviewed: ['Marcada como revisada.', 'Marked as reviewed.'],
} as const;

const defaultProviders: ProviderId[] = ['remotive', 'arbeitnow', 'himalayas'];
const emptyDraft = (): SearchDraft => ({ role: '', company: '', location: '', workMode: 'any', frequencyHours: 24, enabled: true, autoPrepare: false, providerIds: defaultProviders, matcherVersion: 2, includeRelated: false, improveMatching: false });
type FormState = { draft: SearchDraft; editing: string; open: boolean; idempotencyKey: string; aiArtifactId?: string };
const initialForm = (): FormState => ({ draft: emptyDraft(), editing: '', open: false, idempotencyKey: '' });
function readForm(payload: string): FormState {
  try {
    const value = JSON.parse(payload) as Partial<FormState>;
    const d = value.draft as Partial<SearchDraft> | undefined;
    if (typeof value.editing === 'string' && typeof value.open === 'boolean' && d &&
      ['role', 'company', 'location'].every((key) => typeof d[key as 'role'] === 'string') &&
      ['any', 'remote', 'hybrid', 'onsite'].includes(d.workMode ?? '') && [6, 12, 24].includes(d.frequencyHours ?? -1) &&
      typeof d.enabled === 'boolean' && typeof d.autoPrepare === 'boolean') {
      return { draft: { ...emptyDraft(), ...d, providerIds: Array.isArray(d.providerIds) ? d.providerIds : defaultProviders }, editing: value.editing, open: value.open, idempotencyKey: typeof value.idempotencyKey === 'string' ? value.idempotencyKey : '', ...(typeof value.aiArtifactId === 'string' && /^[a-f0-9-]{36}$/i.test(value.aiArtifactId) ? { aiArtifactId: value.aiArtifactId } : {}) };
    }
  } catch { /* Ignore malformed draft data. */ }
  return initialForm();
}
const views: SearchView[] = ['new', 'all', 'saved', 'archived'];
const sorts: SearchSort[] = ['relevance', 'recent'];
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
/** `quiet` applies fresh results without a loading state (after a card action); `poll` never moves a list the person is reading. */
type LoadMode = 'foreground' | 'poll' | 'quiet';
const viewPath = (search: string) => search ? `/job-searches/${encodeURIComponent(search)}/results` : '/job-searches/results';
/** Opens every closed disclosure around a field before focusing it, so focus never lands on a hidden control. */
function revealAndFocus(id: string) {
  const element = document.getElementById(id); if (!element) return false;
  for (let details = element.parentElement?.closest('details'); details; details = details.parentElement?.closest('details')) details.open = true;
  element.focus(); return document.activeElement === element;
}
const fieldElementId = (field: string) => field === 'providers' ? 'search-provider-remotive' : `search-${field}`;

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
  const [actionMessage, setActionMessage] = useState<keyof typeof actionMessages | ''>('');
  const [pendingArrivals, setPendingArrivals] = useState(false);
  /** Deduplicated unread total across all searches (never a sum of per-search counts). */
  const [unreadTotal, setUnreadTotal] = useState<number | null>(null);
  /** Current matches in the selected scope before the New filter; tells "no matches yet" from "all seen". */
  const [matchesTotal, setMatchesTotal] = useState<number | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const aiAvailable = useAiAvailable();
  const [aiOpen, setAiOpen] = useState(false);
  const [aiSearchRequest, setAiSearchRequest] = useState('');
  const [aiSearchProposal, setAiSearchProposal] = useState<AiArtifact | null>(null);
  const [aiProposalError, setAiProposalError] = useState('');
  const [aiProposalRetry, setAiProposalRetry] = useState(0);
  const titleRef = useRef<HTMLHeadingElement>(null); const resultsTitle = useRef<HTMLHeadingElement>(null); const focusForm = useRef(false);
  const manageButton = useRef<HTMLButtonElement>(null); const resultList = useRef<HTMLDivElement>(null); const pendingFocus = useRef<{ id: string; index: number } | null>(null);
  const selectedRef = useRef(''); const viewRef = useRef<SearchView>('new'); const sortRef = useRef<SearchSort>('relevance'); const offsetRef = useRef(0); const listRequest = useRef(0); const resultRequest = useRef(0); const initialized = useRef(false);
  const searchesRef = useRef<Search[]>([]); const resultVersionRef = useRef<string | number | undefined>(undefined); const totalRef = useRef(0); const resultItemsRef = useRef<SearchJob[]>([]); const resultViewRef = useRef('');
  const errorFocus = useErrorFocus(error);
  const selectedSearch = searches.find((search) => search.id === selectedId);
  /** With exactly one saved search there is nothing to choose between; its controls sit by the results. */
  const sole = searches.length === 1 ? searches[0] : undefined;
  const current = selectedSearch ?? sole;
  const scope = selectedSearch ? [selectedSearch] : searches;
  const summary = summarize(searches);
  const anyRunning = summary.active.length > 0;
  const saveContext = (searchId = selectedRef.current, nextView = viewRef.current, nextSort = sortRef.current, nextOffset = offsetRef.current, replace = true) => {
    const href = contextHref(searchId, nextView, nextSort, nextOffset);
    window.history[replace ? 'replaceState' : 'pushState'](null, '', href);
    try { sessionStorage.setItem(contextKey, JSON.stringify({ search: searchId, view: nextView, sort: nextSort, offset: nextOffset })); } catch { /* URL continues to preserve this tab's context. */ }
  };
  const sourceName = (id: string) => ({ remotive: 'Remotive', arbeitnow: 'Arbeitnow', himalayas: 'Himalayas', boards: t('Empresas que sigues', 'Companies you follow') } as Record<string, string>)[id] ?? id;
  const dateTime = (value: string) => new Intl.DateTimeFormat(es ? 'es-ES' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
  const modeLabel = (mode: Search['workMode']) => ({ any: t('Cualquier modalidad', 'Any work mode'), remote: t('En remoto', 'Remote'), hybrid: t('Híbrida', 'Hybrid'), onsite: t('Presencial', 'On-site') })[mode];
  const anyRole = t('Cualquier puesto', 'Any role');

  const loadResults = useCallback(async (search: string, nextView: SearchView, nextSort: SearchSort, start: number, mode: LoadMode = 'foreground') => {
    const ticket = ++resultRequest.current;
    const foreground = mode === 'foreground';
    if (foreground) { setResultLoading(true); setResultsError(false); }
    const viewKey = `${search}|${nextView}|${nextSort}`;
    const query = new URLSearchParams({ view: nextView, sort: nextSort, offset: String(start), limit: '20' });
    try {
      let payload = await api<ResultsPayload>(`${viewPath(search)}?${query}`);
      if (payload.total > 0 && start >= payload.total) {
        start = Math.floor((payload.total - 1) / 20) * 20; query.set('offset', String(start));
        payload = await api<ResultsPayload>(`${viewPath(search)}?${query}`);
      }
      // An empty New list needs the scope's match count to explain itself truthfully (U04).
      let matches: number | null = nextView === 'all' ? payload.total : null;
      if (nextView === 'new' && payload.total === 0) {
        matches = await api<ResultsPayload>(`${viewPath(search)}?${new URLSearchParams({ view: 'all', limit: '1' })}`).then((all) => all.total, () => null);
      }
      if (ticket !== resultRequest.current) return false;
      setResultsError(false); setLoadError(''); setMatchesTotal(matches);
      const sameView = viewKey === resultViewRef.current;
      const changedItems = payload.total !== totalRef.current || payload.items.map((item) => item.groupId ?? item.id).join('|') !== resultItemsRef.current.map((item) => item.groupId ?? item.id).join('|');
      if (mode === 'poll' && sameView && changedItems && resultItemsRef.current.length > 0) { setPendingArrivals(true); return false; }
      setPendingArrivals(false); resultViewRef.current = viewKey; resultItemsRef.current = payload.items; totalRef.current = payload.total; setResults(payload.items); setTotal(payload.total); setOffset(start); offsetRef.current = start;
      if (payload.resultVersion !== undefined) resultVersionRef.current = payload.resultVersion;
      saveContext(search, nextView, nextSort, start);
      return true;
    } catch (cause) {
      if (ticket === resultRequest.current && foreground) { setResultsError(true); setLoadError(errorMessage(cause)); }
      return false;
    } finally { if (ticket === resultRequest.current && foreground) setResultLoading(false); }
  }, []);

  /** Saved searches plus the deduplicated unread total; both come from local data and never start a portal check. */
  const fetchSearches = useCallback(async () => {
    const [response, inbox] = await Promise.all([
      api<{ searches: Search[] }>('/job-searches'),
      api<ResultsPayload>(`/job-searches/results?${new URLSearchParams({ view: 'new', limit: '1' })}`).catch(() => null),
    ]);
    return { searches: response.searches, unread: inbox ? inbox.total : null };
  }, []);

  const load = useCallback(async (background = false, restoreContext?: ReturnType<typeof readContext>) => {
    const ticket = ++listRequest.current;
    try {
      const response = await fetchSearches();
      if (ticket !== listRequest.current) return;
      searchesRef.current = response.searches;
      setSearches(response.searches); setUnreadTotal(response.unread); setListFailed(false); setLoadError('');
      const context = restoreContext ?? { search: selectedRef.current, view: viewRef.current, sort: sortRef.current, offset: offsetRef.current };
      const id = context.search && response.searches.some((search) => search.id === context.search) ? context.search : '';
      selectedRef.current = id; setSelectedId(id); viewRef.current = context.view; setView(context.view); sortRef.current = context.sort; setSort(context.sort); offsetRef.current = context.offset;
      if (!initialized.current && !context.search && !window.location.search) { viewRef.current = 'new'; setView('new'); }
      initialized.current = true;
      if (response.searches.length) await loadResults(id, viewRef.current, context.sort, context.offset, background ? 'poll' : 'foreground');
    } catch (cause) {
      if (ticket === listRequest.current && !background) { setListFailed(true); setLoadError(errorMessage(cause)); }
    } finally { if (ticket === listRequest.current) setLoading(false); }
  }, [fetchSearches, loadResults]);

  /** Counters follow a card action immediately instead of waiting for the next poll (U03). */
  const refreshCounts = async () => {
    const ticket = ++listRequest.current;
    try {
      const response = await fetchSearches();
      if (ticket !== listRequest.current) return;
      searchesRef.current = response.searches; setSearches(response.searches); setUnreadTotal(response.unread);
    } catch { /* The next poll retries; the action itself already succeeded. */ }
  };

  useEffect(() => {
    const restore = () => { const context = readContext(); void load(false, context); };
    restore(); window.addEventListener('popstate', restore);
    return () => { listRequest.current++; resultRequest.current++; window.removeEventListener('popstate', restore); };
  }, [load]);
  useEffect(() => {
    const artifactId = formState.aiArtifactId;
    if (!formDraft.ready || !artifactId || aiSearchProposal?.id === artifactId) return;
    const controller = new AbortController();
    setAiProposalError('');
    void api<AiArtifact>(`/ai/artifacts/${encodeURIComponent(artifactId)}`, { signal: controller.signal }).then(artifact => {
      if (controller.signal.aborted) return;
      if (artifact.output.operation !== 'SEARCH_DRAFT') throw new Error('invalid saved search suggestion');
      setAiSearchProposal(artifact);
      if (artifact.sources.searchRequest) setAiSearchRequest(artifact.sources.searchRequest);
    }).catch(cause => { if (!controller.signal.aborted) setAiProposalError(errorMessage(cause)); });
    return () => controller.abort();
  }, [formDraft.ready, formState.aiArtifactId, aiSearchProposal?.id, aiProposalRetry]);
  useEffect(() => { if (formOpen && focusForm.current) { titleRef.current?.focus(); focusForm.current = false; } }, [formOpen, editing]);
  useEffect(() => {
    if (!formError) return;
    if (!revealAndFocus(invalidField ? fieldElementId(invalidField) : criteriaMissing ? 'search-role' : 'search-form-error')) document.getElementById('search-form-error')?.focus();
  }, [formError, criteriaMissing, invalidField]);
  // After a card action, keep keyboard focus on the same job, or on the job that took its place.
  useEffect(() => {
    const target = pendingFocus.current; if (!target) return;
    pendingFocus.current = null;
    const links = [...(resultList.current?.querySelectorAll<HTMLElement>('[data-result-id]') ?? [])];
    (links.find((link) => link.dataset.resultId === target.id) ?? links[Math.min(target.index, links.length - 1)] ?? resultsTitle.current)?.focus();
  }, [results]);
  useLocalRefresh(() => load(true), { paused: loading || Boolean(busy) || resultLoading, interval: anyRunning ? 3000 : 30000 });

  const choose = async (id: string, nextView = view, nextSort = sort, start = 0, push = true, moveFocus = true) => {
    selectedRef.current = id; setSelectedId(id); viewRef.current = nextView; setView(nextView); sortRef.current = nextSort; setSort(nextSort); offsetRef.current = start; setOffset(start); setActionMessage('');
    saveContext(id, nextView, nextSort, start, !push); await loadResults(id, nextView, nextSort, start); if (moveFocus) resultsTitle.current?.focus();
  };
  const dirtyDraft = formOpen && Boolean(draft.role || draft.company || draft.location);
  const openNew = () => {
    if (dirtyDraft && !window.confirm(t('¿Descartar este borrador y crear otra búsqueda?', 'Discard this draft and create another search?'))) return;
    setAiSearchProposal(null); focusForm.current = true; setFormState({ draft: emptyDraft(), editing: '', open: true, idempotencyKey: crypto.randomUUID() });
  };
  const reviewAiSearch = (artifact: AiArtifact) => {
    if (artifact.output.operation !== 'SEARCH_DRAFT' || !formDraft.ready || busy !== '') return;
    if (dirtyDraft && !window.confirm(t('¿Sustituir los campos de este borrador por la propuesta? Todavía podrás editarlos antes de buscar.', 'Replace this draft’s fields with the suggestion? You can still edit them before searching.'))) return;
    const criteria = artifact.output.criteria;
    setFormState({ draft: { ...emptyDraft(), role: criteria.role ?? '', company: criteria.company ?? '', location: criteria.location ?? '', workMode: criteria.workMode }, editing: '', open: true, idempotencyKey: crypto.randomUUID(), aiArtifactId: artifact.id });
    setAiSearchProposal(artifact); setAiProposalError(''); setAiOpen(false); setFormError(''); setCriteriaMissing(false); setInvalidField(null);
    requestAnimationFrame(() => titleRef.current?.focus());
  };
  const beginEdit = (search: Search) => {
    if (formOpen && editing === search.id) { titleRef.current?.focus(); return; }
    if (dirtyDraft && !window.confirm(t('¿Descartar este borrador para editar otra búsqueda?', 'Discard this draft to edit another search?'))) return;
    setAiSearchProposal(null); const legacy = search.matcherVersion === 1;
    focusForm.current = true;
    setFormState({ editing: search.id, open: true, idempotencyKey: '', draft: { role: search.role ?? '', company: search.company ?? '', location: search.location ?? '', workMode: search.workMode, frequencyHours: search.frequencyHours, enabled: search.enabled, autoPrepare: search.autoPrepare, providerIds: search.providerIds ?? defaultProviders, matcherVersion: search.matcherVersion ?? 1, includeRelated: search.includeRelated ?? false, improveMatching: !legacy } });
  };
  const closeDraft = () => {
    if (dirtyDraft && !window.confirm(editing ? t('¿Cancelar la edición sin guardar los cambios?', 'Cancel editing without saving changes?') : t('¿Descartar este borrador sin guardar?', 'Discard this unsaved draft?'))) return;
    setAiSearchProposal(null); setFormError(''); setCriteriaMissing(false); formDraft.update({ payload: '' });
  };
  /** With several searches, "adjust" first asks which one; it never opens a create form (U05). */
  const openManage = () => { setManageOpen(true); requestAnimationFrame(() => manageButton.current?.focus()); };
  const problem = (cause: unknown, search?: Search) => {
    if (cause instanceof ApiError && cause.code === 'SEARCH_REFRESH_ALREADY_RUNNING') return t('La consulta sigue en curso. Conservamos las ofertas visibles.', 'The check is still running. Visible jobs are kept.');
    if (cause instanceof ApiError && cause.code === 'SEARCH_REFRESH_COOLDOWN') {
      const next = nextCheckLabel(search?.nextRunAt ?? null, locale);
      return next
        ? t(`Podrás volver a consultar ${next}. Mientras tanto, puedes revisar las ofertas ya encontradas.`, `You can check again ${next}. Meanwhile, you can review jobs already found.`)
        : t('Aún no se puede repetir esta consulta. Puedes revisar las ofertas encontradas mientras llega la próxima consulta automática.', 'This check cannot be repeated yet. You can review jobs already found while waiting for the next automatic check.');
    }
    if (cause instanceof ApiError && cause.status === 409) return t('Esta búsqueda cambió en otra pestaña. Actualiza la lista y vuelve a aplicar tus cambios.', 'This search changed in another tab. Reload the list and apply your changes again.');
    return errorMessage(cause);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(''); setFormError(''); setCriteriaMissing(false); setInvalidField(null); setMessage('');
    if (formState.aiArtifactId && aiSearchProposal?.id !== formState.aiArtifactId) { setFormError(t('Espera a recuperar la propuesta de IA para revisar las condiciones que no se usan como filtros.', 'Wait for the AI suggestion to load so you can review conditions that are not used as filters.')); return; }
    if (!draft.role.trim() && !draft.company.trim()) { setCriteriaMissing(true); setFormError(t('Escribe un puesto o, en «Añadir empresa o modalidad», una empresa.', 'Enter a role or, under “Add company or work mode”, a company.')); revealAndFocus('search-role'); return; }
    const tooLong = (['role', 'company', 'location'] as const).find((field) => draft[field].trim().length > 200);
    if (tooLong) { setInvalidField(tooLong); setFormError(t('Usa un máximo de 200 caracteres en cada campo.', 'Use at most 200 characters in each field.')); revealAndFocus(`search-${tooLong}`); return; }
    if (!draft.providerIds.length) { setInvalidField('providers'); setFormError(t('Elige al menos un portal de empleo.', 'Choose at least one job portal.')); revealAndFocus(fieldElementId('providers')); return; }
    setBusy('form');
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
      const id = response.search.id; setMessage('searchSaved');
      // Land on this search's jobs (U07): offers first, management stays secondary. The draft is cleared after the
      // list arrives so a first search never flashes an empty form; a retry before then reuses the idempotency key.
      await load(false, { search: id, view: 'new', sort: 'relevance', offset: 0 }); formDraft.update({ payload: '' }); setAiSearchProposal(null); resultsTitle.current?.focus();
    } catch (cause) { setFormError(problem(cause)); } finally { setBusy(''); }
  };
  const runAction = async (search: Search, action: 'refresh' | 'toggle') => {
    setBusy(search.id); setError(''); setMessage('');
    try {
      if (action === 'refresh') {
        await api<{ runId: string }>(`/job-searches/${search.id}/refresh`, { method: 'POST', body: '{}' });
        setMessage('refresh');
      } else await api(`/job-searches/${search.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !search.enabled, expectedRevision: search.revision }) });
      await load(true);
    } catch (cause) { setError(problem(cause, search)); } finally { setBusy(''); }
  };
  const afterCardAction = async (job: SearchJob, done: keyof typeof actionMessages) => {
    pendingFocus.current = { id: job.id, index: Math.max(0, results.findIndex((item) => item.id === job.id)) };
    setActionMessage(done);
    await Promise.all([loadResults(selectedId, view, sort, offset, 'quiet'), refreshCounts()]);
  };
  const updateReview = async (job: SearchJob, decision: 'SHORTLISTED' | 'ARCHIVED' | 'UNREVIEWED') => {
    setBusy(job.id); setError(''); setMessage(''); setActionMessage('');
    try {
      await api(`/jobs/${job.id}/shortlist`, { method: 'POST', body: JSON.stringify({ decision }) });
      await afterCardAction(job, decision === 'SHORTLISTED' ? 'saved' : decision === 'ARCHIVED' ? 'archived' : job.shortlistDecision === 'SHORTLISTED' ? 'unsaved' : 'restored');
    } catch (cause) { setError(problem(cause)); } finally { setBusy(''); }
  };
  const markReviewed = async (job: SearchJob) => {
    setBusy(job.id); setError(''); setActionMessage('');
    try {
      // Seen once means seen everywhere: the same job may have been found by several searches.
      await api(`/job-searches/all/results/${job.id}/review`, { method: 'POST', body: '{}' });
      await afterCardAction(job, 'reviewed');
    } catch (cause) { setError(problem(cause)); } finally { setBusy(''); }
  };
  const showArrivals = async () => { if (await loadResults(selectedId, view, sort, offset)) resultsTitle.current?.focus(); };
  // Filters and sort keep focus on the control that was used.
  const changeView = (next: SearchView) => { void choose(selectedId, next, sort, 0, true, false); };
  const changeSort = (next: SearchSort) => { void choose(selectedId, view, next, 0, true, false); };

  const filters: Array<{ id: SearchView; es: string; en: string }> = [
    { id: 'new', es: 'Nuevas', en: 'New' }, { id: 'all', es: 'Todas', en: 'All' }, { id: 'saved', es: 'Guardadas', en: 'Saved' }, { id: 'archived', es: 'Archivadas', en: 'Archived' },
  ];
  const scopeUnread = selectedSearch ? selectedSearch.lastNewCount : unreadTotal;
  const pageCount = Math.ceil(total / 20);
  const resultsReturn = contextHref(selectedId, view, sort, offset);
  const firstUse = !loading && !listFailed && searches.length === 0;
  const nextScope = nextCheckLabel(summarize(scope).nextRunAt, locale);
  const edit = selectedSearch ? { label: t('Editar esta búsqueda', 'Edit this search'), onClick: () => beginEdit(selectedSearch) }
    : searches.length === 1 ? { label: t('Editar búsqueda', 'Edit search'), onClick: () => beginEdit(searches[0]) }
    : { label: t('Elegir búsqueda para ajustar', 'Choose a search to adjust'), onClick: openManage };
  const count = (n: number, one: [string, string], many: [string, string]) => `${n} ${n === 1 ? t(...one) : t(...many)}`;

  return <WorkspaceGate><AppShell>
    <PageHeader eyebrow={t('BÚSQUEDA AUTOMÁTICA', 'AUTOMATIC JOB SEARCH')} title={t('Buscar empleo', 'Find jobs')} action={searches.length > 0 && !formOpen ? <div className={styles.actions}><Button variant="secondary" disabled={busy !== '' || !formDraft.ready} onClick={openNew}>{t('Nueva búsqueda', 'New search')}</Button></div> : undefined} />
    {busy === 'form' && <Notice>{editing ? t('Guardando cambios…', 'Saving changes…') : t('Guardando la búsqueda y empezando a buscar…', 'Saving your search and starting to look…')}</Notice>}
    {loadError && <Notice tone={listFailed ? 'error' : 'warning'} actions={listFailed ? <Button variant="secondary" onClick={() => void load()}>{t('Reintentar', 'Try again')}</Button> : undefined}>{loadError}</Notice>}
    {error && <div ref={errorFocus} tabIndex={-1} className="action-error"><Notice tone="error">{error}</Notice></div>}
    {message && <Notice tone="success">{t(successMessages[message][0], successMessages[message][1])}</Notice>}
    <div className={styles.layout}>
      {(formOpen || firstUse) && <div className={styles.formColumn}>
        {aiAvailable && !editing && <details className={`card ${styles.formCard}`} open={aiOpen} onToggle={event => setAiOpen(event.currentTarget.open)}><summary>{t('Describir lo que busco con ayuda de IA · opcional', 'Describe what I want with AI help · optional')}</summary><div className={styles.form}>
          <p className={styles.intro}>{t('Cuéntalo con tus palabras. Codex propondrá los filtros; tú los revisarás antes de guardar y empezar la búsqueda.', 'Describe it in your own words. Codex will suggest filters for you to review before saving and starting the search.')}</p>
          <TextareaField label={t('¿Qué trabajo te gustaría encontrar?', 'What job would you like to find?')} value={aiSearchRequest} maxLength={2000} rows={3} onChange={event => setAiSearchRequest(event.target.value)} placeholder={t('Por ejemplo: busco diseño de producto en remoto desde España.', 'For example: I am looking for a remote product design job based in Spain.')}/>
          {aiSearchRequest.trim() ? <AiDraftAction visible={aiOpen} request={{ operation: 'SEARCH_DRAFT', locale, searchRequest: aiSearchRequest.trim() }} label={t('Preparar los filtros con Codex', 'Prepare filters with Codex')} onReview={reviewAiSearch}/> : <small>{t('Describe lo que buscas para revisar los datos que compartirás.', 'Describe what you are looking for to review the data you will share.')}</small>}
        </div></details>}
        {aiSearchProposal?.output.operation === 'SEARCH_DRAFT' && <Notice role={null}><div className="form-stack"><p>{t('Propuesta de IA en los campos de abajo. Revísalos y pulsa Buscar ofertas cuando quieras empezar.', 'The AI suggestion is in the fields below. Review them and choose Find jobs when you want to start.')}</p>{aiSearchProposal.output.unsupportedConstraints.length > 0 && <><strong>{t('Recuerda comprobar estas condiciones en cada oferta; no se usan como filtros:', 'Remember to check these conditions in each posting; they are not used as filters:')}</strong><ul>{aiSearchProposal.output.unsupportedConstraints.map((item, index) => <li key={index}>«{item.requestQuote}» — {item.explanation}</li>)}</ul></>}{aiSearchProposal.output.clarifications.length > 0 && <ul>{aiSearchProposal.output.clarifications.map((item, index) => <li key={index}>{item.question}</li>)}</ul>}</div></Notice>}
        {formState.aiArtifactId && aiSearchProposal?.id !== formState.aiArtifactId && <Notice tone={aiProposalError ? 'warning' : 'info'} actions={aiProposalError ? <><Button type="button" variant="secondary" onClick={() => setAiProposalRetry(value => value + 1)}>{t('Recuperar la propuesta', 'Retrieve the suggestion')}</Button><Button type="button" variant="quiet" onClick={() => { if (window.confirm(t('¿Descartar esta propuesta y sus campos para empezar una búsqueda nueva?', 'Discard this suggestion and its fields to start a new search?'))) { setAiSearchProposal(null); setFormState({ ...initialForm(), open: true }); setFormError(''); } }}>{t('Descartar esta propuesta', 'Discard this suggestion')}</Button></> : undefined}>{aiProposalError ? t('No pudimos recuperar las notas de esta propuesta. Consérvalas antes de buscar para no perder las condiciones que requieren revisión manual.', 'We could not retrieve the notes for this suggestion. Recover them before searching so conditions requiring a manual check are not lost.') : t('Recuperando la propuesta y las condiciones que debes revisar…', 'Retrieving the suggestion and the conditions you need to check…')}</Notice>}
        <SearchForm key={`${editing || 'new'}-${aiSearchProposal?.id ?? 'manual'}`} defaultProviders={defaultProviders} draft={draft} editing={editing} existingSearch={editSearch} busy={busy === 'form'} ready={formDraft.ready} storageFailed={formDraft.storageFailed} formError={formError} criteriaMissing={criteriaMissing} invalidField={invalidField} titleRef={titleRef} onDraftChange={setDraft} onSubmit={(event) => void submit(event)} onDismissDraft={closeDraft} hasSearches={searches.length > 0} t={t}/>
      </div>}
      {loading && <Notice>{t('Cargando tus búsquedas…', 'Loading your searches…')}</Notice>}
      {listFailed && <Card className={styles.emptyResults}><Empty title={t('No pudimos cargar tus búsquedas', 'Could not load your searches')} detail={t('Reintenta para recuperar la lista. Esto no inicia otra consulta a los portales.', 'Try again to recover the list. This does not start a new portal check.')} action={<Button variant="secondary" onClick={() => void load()}>{t('Reintentar', 'Try again')}</Button>} /></Card>}
      {searches.length > 0 && <section className={styles.results} id="search-results" aria-labelledby="search-results-title">
        {searches.length > 1 && <div className={styles.scopeBar}>
          <div className={styles.scopeField}>
            <span id="search-scope-label">{t('Tus búsquedas', 'Your searches')}</span>
            <div className={styles.scopeChoices} role="group" aria-labelledby="search-scope-label">
              <button type="button" aria-pressed={!selectedId} onClick={() => void choose('', view, sort, 0, true, false)}>{t('Todas mis búsquedas', 'All my searches')}{unreadTotal ? ` (${unreadTotal})` : ''}</button>
              {searches.map((search) => <button key={search.id} type="button" aria-pressed={selectedId === search.id} onClick={() => void choose(search.id, view, sort, 0, true, false)}>{searchName(search, anyRole)}{search.lastNewCount ? ` (${search.lastNewCount})` : ''}{search.enabled ? '' : t(' · en pausa', ' · paused')}</button>)}
            </div>
          </div>
          <div className={styles.actions}>
            {selectedSearch && <><Button variant="quiet" disabled={busy !== ''} onClick={() => beginEdit(selectedSearch)}>{t('Editar', 'Edit')}</Button><Button variant="quiet" disabled={busy !== ''} onClick={() => void runAction(selectedSearch, 'toggle')}>{selectedSearch.enabled ? t('Pausar', 'Pause') : t('Reanudar', 'Resume')}</Button></>}
            <button ref={manageButton} type="button" className="button button-quiet" aria-expanded={manageOpen} aria-controls="manage-searches" onClick={() => setManageOpen(!manageOpen)}>{t(`Gestionar búsquedas (${searches.length})`, `Manage searches (${searches.length})`)}</button>
          </div>
        </div>}
        {manageOpen && searches.length > 1 && <div id="manage-searches" className={styles.managePanel}>
          <h2 className="sr-only">{t('Tus búsquedas', 'Your searches')}</h2>
          <ul className={styles.manageList}>{searches.map((search) => <SearchCard key={search.id} search={search} selected={selectedId === search.id} disabled={busy !== '' || resultLoading} locale={locale} onSelect={() => void choose(search.id, view, sort, 0)} onEdit={() => beginEdit(search)} onToggle={() => void runAction(search, 'toggle')} onRefresh={() => void runAction(search, 'refresh')} t={t} modeLabel={modeLabel} />)}</ul>
        </div>}
        <div className={styles.resultsHead}>
          <h2 id="search-results-title" ref={resultsTitle} tabIndex={-1}>{current ? searchName(current, anyRole) : t('Ofertas para ti', 'Jobs for you')}</h2>
          <div className={styles.sortControl}><label htmlFor="search-sort">{t('Ordenar', 'Sort')}</label><select id="search-sort" value={sort} onChange={(event) => changeSort(event.target.value as SearchSort)}><option value="relevance">{t('Mejor coincidencia', 'Best match')}</option><option value="recent">{t('Más recientes', 'Most recent')}</option></select></div>
        </div>
        {sole && <div className={styles.soleActions} data-search-actions="single">
          {/* One saved search: no selector to choose between, but it stays editable and pausable here. */}
          <Button variant="quiet" disabled={busy !== ''} aria-describedby="search-results-title" onClick={() => beginEdit(sole)}>{t('Editar', 'Edit')}</Button>
          <Button variant="quiet" disabled={busy !== ''} aria-describedby="search-results-title" onClick={() => void runAction(sole, 'toggle')}>{sole.enabled ? t('Pausar', 'Pause') : t('Reanudar', 'Resume')}</Button>
        </div>}
        <div className={styles.filterTabs} role="group" aria-label={t('Mostrar ofertas', 'Show jobs')}>{filters.map((filter) => <button key={filter.id} type="button" aria-pressed={view === filter.id} aria-controls="search-result-list" onClick={() => changeView(filter.id)}>{t(filter.es, filter.en)}{filter.id === 'new' && scopeUnread ? <span className={styles.filterCount}> {scopeUnread}</span> : null}</button>)}</div>
        <SearchStatus scope={scope} single={Boolean(selectedSearch) || searches.length === 1} locale={locale} t={t} sourceName={sourceName} dateTime={dateTime} busy={busy !== ''} onRetry={(search) => void runAction(search, 'refresh')} />
        {pendingArrivals && <Notice tone="info" actions={<Button variant="secondary" onClick={showArrivals}>{t('Mostrar nuevas ofertas', 'Show new jobs')}</Button>}>{t('Hay ofertas nuevas. Tu página y posición siguen como estaban.', 'New jobs are available. Your page and position are unchanged.')}</Notice>}
        <p className={styles.resultCount} role="status">{resultLoading ? t('Cargando ofertas…', 'Loading jobs…') : count(total, ['oferta', 'job'], ['ofertas', 'jobs'])}{!resultLoading && actionMessage ? ` · ${t(actionMessages[actionMessage][0], actionMessages[actionMessage][1])}` : ''}</p>
        <div id="search-result-list" ref={resultList} className={styles.resultList} aria-busy={resultLoading}>
          {!resultLoading && results.map((job) => <SearchResultCard key={job.id} job={job} returnTo={resultsReturn} view={view} busy={busy !== ''} t={t} sourceName={sourceName} onSave={() => void updateReview(job, 'SHORTLISTED')} onUnsave={() => void updateReview(job, 'UNREVIEWED')} onArchive={() => void updateReview(job, job.shortlistDecision === 'ARCHIVED' ? 'UNREVIEWED' : 'ARCHIVED')} onReview={() => void markReviewed(job)} />)}
          {!resultLoading && results.length === 0 && <SearchEmptyState kind={emptyKind({ view, error: resultsError, scope, matchesTotal })} matchesTotal={matchesTotal} nextCheck={nextScope} busy={busy !== ''} t={t}
            onRetry={() => void loadResults(selectedId, view, sort, offset)} onShowAll={() => changeView('all')}
            onResume={selectedSearch ? () => void runAction(selectedSearch, 'toggle') : searches.length === 1 ? () => void runAction(searches[0], 'toggle') : undefined}
            onRefresh={selectedSearch ? () => void runAction(selectedSearch, 'refresh') : searches.length === 1 ? () => void runAction(searches[0], 'refresh') : undefined}
            edit={edit} />}
        </div>
        {pageCount > 1 && <nav className={styles.pagination} aria-label={t('Páginas de resultados', 'Result pages')}><Button variant="secondary" disabled={offset === 0 || resultLoading} onClick={() => void choose(selectedId, view, sort, Math.max(0, offset - 20))}>{t('Anterior', 'Previous')}</Button><span>{Math.floor(offset / 20) + 1} / {pageCount}</span><Button variant="secondary" disabled={offset + 20 >= total || resultLoading} onClick={() => void choose(selectedId, view, sort, offset + 20)}>{t('Siguiente', 'Next')}</Button></nav>}
      </section>}
    </div>
    <details className={styles.coverage}><summary>{t('Portales donde buscamos y datos que compartimos', 'Job portals we search and data we share')}</summary><p>{t('Buscamos ofertas públicas en los portales de empleo Remotive, Arbeitnow e Himalayas (portal de empleo en remoto), según los que elijas en cada búsqueda. Himalayas recibe solo los criterios que escribes (puesto, empresa o país); nunca tu CV ni tus datos de contacto. Las empresas que sigues aparecen solo si las incluyes.', 'We look for public listings on the job portals Remotive, Arbeitnow and Himalayas (a remote-jobs portal), as chosen for each search. Himalayas receives only the criteria you enter (role, company or country); never your resume or contact details. Companies you follow appear only when selected.')}</p><p><a href="https://github.com/remotive-com/remote-jobs-api" target="_blank" rel="noopener noreferrer">Remotive</a> · <a href="https://www.arbeitnow.com/blog/job-board-api" target="_blank" rel="noopener noreferrer">Arbeitnow</a> · <a href="https://himalayas.app/docs/remote-jobs-api" target="_blank" rel="noopener noreferrer">Himalayas</a></p></details>
  </AppShell></WorkspaceGate>;
}
