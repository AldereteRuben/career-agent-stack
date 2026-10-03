'use client';

import { useDisclosureFocus } from '@/lib/disclosure-focus';

import Link from 'next/link';
import { DiscoveryPanel } from '@/components/discovery-panel';
import { useSessionDraft, stringDraft } from '@/lib/session-draft';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { AppShell, PageHeader, WorkspaceGate } from '@/components/shell';
import { Button, Card, Empty, Field, Icon, Notice, Tag } from '@/components/ui';
import { api, ApiError, errorMessage, formatDate } from '@/lib/api';
import { getOfficialDomain, parseJobBoardUrl } from '@/lib/board-url';
import { useLocale } from '@/lib/i18n';
import { copy, labelFor, timeUntil } from '@/lib/labels';

type Board = { id: string; provider: string; tenant: string; region: string; companyName: string; companyDomain: string; careersUrl: string; associationStatus: string; permissionStatus: string; enabled: boolean; reviewedAt: string | null; reviewDueAt: string | null; lastSuccessfulRefreshAt: string | null; nextRunAt: string | null };
type BoardStatus = 'active' | 'needs-confirmation' | 'expired' | 'off';
const providers: Record<string, { label: string; reference: string }> = {
  greenhouse: { label: 'Greenhouse', reference: 'https://docs.greenhouse.io/job-board.html' },
  lever: { label: 'Lever', reference: 'https://github.com/lever/postings-api' },
  ashby: { label: 'Ashby', reference: 'https://developers.ashbyhq.com/docs/public-job-posting-api' },
};
const COOLDOWN_MS = 6 * 60 * 60 * 1000;
type ReviewChecks = { officialLink: boolean; readOnlyAccess: boolean };
const noChecks: ReviewChecks = { officialLink: false, readOnlyAccess: false };

function boardStatus(board: Board, now: number): BoardStatus {
  if (board.reviewDueAt && new Date(board.reviewDueAt).getTime() < now) return 'expired';
  if (board.enabled) return 'active';
  return board.associationStatus === 'VERIFIED' ? 'off' : 'needs-confirmation';
}

export default function BoardsPage() {
  const { locale } = useLocale(); const c = copy(locale);
  const [boards, setBoards] = useState<Board[]>([]); const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const draft = useSessionDraft('company', { companyName: '', careersUrl: '', boardUrl: '' }, (value): value is { companyName: string; careersUrl: string; boardUrl: string } => stringDraft(value) && ['companyName', 'careersUrl', 'boardUrl'].every((key) => typeof value[key] === 'string'));
  const { companyName, careersUrl, boardUrl } = draft.value;
  const setCompanyName = (companyName: string) => draft.update((value) => ({ ...value, companyName }));
  const setCareersUrl = (careersUrl: string) => draft.update((value) => ({ ...value, careersUrl }));
  const setBoardUrl = (boardUrl: string) => draft.update((value) => ({ ...value, boardUrl }));
  const [checks, setChecks] = useState<Record<string, ReviewChecks>>({});
  const [busy, setBusy] = useState(''); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(false);
  const formHeading = useDisclosureFocus(open); const [now, setNow] = useState(() => Date.now());
  const focusNameOnOpen = useRef(false);
  const focusCompanyName = () => {
    const input = document.getElementById('company-name');
    if (!input || input.matches(':disabled')) return false;
    input.focus({ preventScroll: true });
    input.scrollIntoView({ block: 'center', inline: 'nearest' });
    return true;
  };
  const startCompany = () => {
    if (open && draft.ready) focusCompanyName();
    else { focusNameOnOpen.current = true; setOpen(true); }
  };
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('add') === '1') { focusNameOnOpen.current = true; setOpen(true); }
  }, []);
  useEffect(() => {
    if (!open || !draft.ready || !focusNameOnOpen.current) return;
    // A direct link can open the form before WorkspaceGate has mounted its children.
    const focusWhenMounted = () => { if (focusCompanyName()) { focusNameOnOpen.current = false; observer.disconnect(); } };
    const observer = new MutationObserver(focusWhenMounted);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
    focusWhenMounted();
    return () => observer.disconnect();
  }, [open, draft.ready]);

  const source = parseJobBoardUrl(boardUrl); const careersDomain = getOfficialDomain(careersUrl); const provider = source ? providers[source.provider] : null;

  const load = useCallback(async () => {
    try { setBoards(await api<Board[]>('/boards')); setLoadState('ready'); setNow(Date.now()); }
    catch (err) { setError(errorMessage(err)); setLoadState((current) => current === 'ready' ? 'ready' : 'error'); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  // Automatic runs can finish while this page is open; refresh their persisted cooldown too.
  useEffect(() => { const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 30_000); return () => window.clearInterval(timer); }, [load]);

  const begin = (key: string) => { setBusy(key); setError(''); setMessage(''); setCardErrors((current) => { const next = { ...current }; delete next[key]; return next; }); };
  const cardFail = (id: string, err: unknown) => setCardErrors((current) => ({ ...current, [id]: errorMessage(err) }));

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!source || !careersDomain) { setError(c('Añade la página de empleo de la empresa y un enlace compatible.', 'Add the company careers page and a supported job board link.')); return; }
    begin('add');
    try {
      const created = await api<Board>('/boards', { method: 'POST', body: JSON.stringify({ provider: source.provider, tenant: source.companyKey, region: source.region, companyName: companyName.trim(), companyDomain: careersDomain, careersUrl: careersUrl.trim(), associationStatus: 'UNVERIFIED', permissionStatus: 'UNKNOWN', enabled: false }) });
      setMessage(c('Empresa añadida. Confirma su enlace en la lista para consultar sus ofertas.', 'Company added. Confirm its link in the list to check its jobs.'));
      setChecks((current) => ({ ...current, [created.id]: noChecks }));
      setCompanyName(''); setCareersUrl(''); setBoardUrl(''); setOpen(false); await load();
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(''); }
  };

  const review = async (board: Board) => {
    begin(board.id);
    try {
      await api(`/boards/${board.id}/review`, { method: 'POST', body: JSON.stringify({ officialAssociationConfirmed: true, publicReadReviewed: true, referenceUrl: providers[board.provider]?.reference, notes: 'Owner confirmed the official company link and reviewed the provider read-only access.' }) });
      setChecks((current) => ({ ...current, [board.id]: noChecks }));
      setMessage(c(`${board.companyName}: búsqueda activada. Ya puedes buscar ofertas.`, `${board.companyName}: job search turned on. You can now look for jobs.`)); await load();
    } catch (err) { cardFail(board.id, err); } finally { setBusy(''); }
  };

  const refresh = async (board: Board) => {
    begin(board.id);
    try {
      const result = await api<{ added: number; updated: number; coverage: string; skipped?: number }>(`/boards/${board.id}/refresh`, { method: 'POST', body: '{}' });
      setMessage(result.coverage === 'PARTIAL'
        ? c(`${board.companyName}: ${result.added} nuevas y ${result.updated} actualizadas. No pudimos leer ${result.skipped ?? 0} registros; consulta la web de la empresa para ver la lista completa.`, `${board.companyName}: ${result.added} new and ${result.updated} updated. We could not read ${result.skipped ?? 0} records; check the company website for the complete list.`)
        : result.added + result.updated === 0
        ? c(`${board.companyName} no tiene ofertas públicas ahora mismo.`, `${board.companyName} has no public jobs right now.`)
        : c(`${board.companyName}: ${result.added} nuevas y ${result.updated} actualizadas.`, `${board.companyName}: ${result.added} new and ${result.updated} updated.`));
      await load();
    } catch (err) {
      cardFail(board.id, err);
      // The server is the source of truth for cooldowns and approvals; re-read so the card shows the real state.
      if (err instanceof ApiError && ['BOARD_REFRESH_COOLDOWN', 'BOARD_NOT_APPROVED_FOR_DISCOVERY', 'NOT_FOUND'].includes(err.code)) await load();
    } finally { setBusy(''); }
  };

  const disable = async (board: Board) => {
    begin(board.id);
    try { await api(`/boards/${board.id}/disable`, { method: 'POST', body: '{}' }); setMessage(c(`${board.companyName}: búsqueda desactivada. Las ofertas guardadas se mantienen.`, `${board.companyName}: job search turned off. Saved jobs are kept.`)); await load(); }
    catch (err) { cardFail(board.id, err); } finally { setBusy(''); }
  };

  const changeCheck = (id: string, key: keyof ReviewChecks, checked: boolean) => setChecks((current) => ({ ...current, [id]: { ...(current[id] ?? noChecks), [key]: checked } }));
  const activeCount = boards.filter((board) => boardStatus(board, now) === 'active').length;

  const statusTag: Record<BoardStatus, { tone: 'green' | 'amber' | 'red' | 'neutral'; text: string }> = {
    active: { tone: 'green', text: c('LISTA PARA CONSULTAR', 'READY TO CHECK') },
    'needs-confirmation': { tone: 'amber', text: c('FALTA TU CONFIRMACIÓN', 'NEEDS YOUR CONFIRMATION') },
    expired: { tone: 'red', text: c('CONFIRMACIÓN CADUCADA', 'CONFIRMATION EXPIRED') },
    off: { tone: 'neutral', text: c('DESACTIVADA', 'TURNED OFF') },
  };

  return <WorkspaceGate><AppShell>
    <PageHeader eyebrow={c('CONSULTA OPCIONAL', 'OPTIONAL JOB SEARCH')} title={c('Empresas que sigo', 'Companies I follow')} description={c('Opcional: conecta la página de empleo de una empresa para consultar sus ofertas. También puedes guardar una oferta directamente en Ofertas guardadas.', 'Optional: connect a company careers page to check its jobs. You can also add a job directly in Saved jobs.')}/>
    {draft.storageFailed && <Notice tone="warning">{c('No pudimos conservar este formulario. Añade la empresa antes de salir para no perderlo.', 'We could not preserve this form. Add the company before leaving to keep it.')}</Notice>}
    {error && <Notice tone="error">{error}</Notice>}{message && <Notice tone="success">{message} {activeCount > 0 && <Link href="/jobs">{c('Ver ofertas', 'See jobs')}</Link>}</Notice>}
    <DiscoveryPanel revision={JSON.stringify(boards)} onAddCompany={startCompany}/><div className="source-policy-banner"><span className="source-policy-icon"><Icon name="shield" size={19}/></span><div><strong>{c('Solo lectura', 'Read-only')}</strong><p>{c('Seguir una empresa nunca permite a esta app rellenar o enviar formularios.', 'Adding a source never lets this app fill in or submit forms.')}</p></div><Tag tone="green">{c('SIN ENVÍOS', 'NO SUBMISSIONS')}</Tag></div>
    <div className="boards-layout"><div className="boards-list board-collection card">
      <div className="section-heading compact"><div><h2 id="saved-companies" tabIndex={-1}>{c('Empresas guardadas', 'Saved companies')}</h2></div><span className="muted-label">{c(`${activeCount} de ${boards.length} listas para consultar`, `${activeCount} of ${boards.length} ready to check`)}</span></div>
      {loadState === 'loading' && <Notice>{c('Cargando empresas…', 'Loading companies…')}</Notice>}
      {loadState === 'error' && <Notice tone="warning" actions={<Button variant="quiet" onClick={() => { setError(''); setLoadState('loading'); void load(); }}>{c('Reintentar', 'Try again')}</Button>}>{c('No pudimos cargar tus empresas.', 'We could not load your companies.')}</Notice>}
      {boards.map((board) => {
        const status = boardStatus(board, now); const confirmed = checks[board.id] ?? noChecks; const boardProvider = providers[board.provider];
        const canReview = confirmed.officialLink && confirmed.readOnlyAccess; const working = busy === board.id;
        const nextRefresh = Math.max(board.nextRunAt ? new Date(board.nextRunAt).getTime() : 0, board.lastSuccessfulRefreshAt ? new Date(board.lastSuccessfulRefreshAt).getTime() + COOLDOWN_MS : 0); const coolingDown = nextRefresh > now;
        return <Card className="board-card" key={board.id}>
          <div className="board-card-head"><div className="board-brand">{boardProvider?.label.slice(0, 1) ?? '?'}</div><div className="board-company"><strong>{board.companyName}</strong><small>{boardProvider?.label ?? board.provider}{board.region === 'eu' ? ` · ${labelFor.region(board.region, locale)}` : ''} · {board.companyDomain}</small></div><Tag tone={statusTag[status].tone}>{statusTag[status].text}</Tag></div>
          <div className="board-details">
            <div><span>{c('Enlace de la empresa', 'Company link')}</span><strong>{board.associationStatus === 'VERIFIED' ? c('Confirmado por ti', 'Confirmed by you') : c('Sin confirmar', 'Not confirmed')}</strong></div>
            <div><span>{c('Confirmación válida hasta', 'Confirmation valid until')}</span><strong>{board.reviewDueAt ? formatDate(board.reviewDueAt) : '—'}</strong></div>
            <div><span>{c('Última búsqueda', 'Last search')}</span><strong>{board.lastSuccessfulRefreshAt ? formatDate(board.lastSuccessfulRefreshAt) : c('Nunca', 'Never')}</strong></div>
          </div>
          {cardErrors[board.id] && <Notice tone="error">{cardErrors[board.id]}</Notice>}
          {status === 'active' ? <div className="board-actions">
            <Button variant="secondary" onClick={() => void refresh(board)} disabled={working || busy !== '' || coolingDown}><Icon name="search" size={15}/>{working ? c('Buscando…', 'Searching…') : coolingDown ? c(`Disponible en ${timeUntil(new Date(nextRefresh))}`, `Available in ${timeUntil(new Date(nextRefresh))}`) : c('Buscar ofertas nuevas', 'Find new jobs')}</Button>
            <Button variant="quiet" onClick={() => void disable(board)} disabled={busy !== ''}>{c('Desactivar', 'Turn off')}</Button>
          </div> : <div className="board-review-box">
            <p>{status === 'expired' ? c('Las confirmaciones caducan a los 90 días. Vuelve a comprobar que el enlace sigue siendo de la empresa.', 'Confirmations expire after 90 days. Check again that the link still belongs to the company.')
              : status === 'off' ? c('Desactivaste esta fuente. Confirma de nuevo para reanudar la búsqueda.', 'You turned this source off. Confirm again to resume searching.')
              : c('Antes de buscar, comprueba que este tablero es el oficial de la empresa.', 'Before searching, check that this job board is the company’s official one.')}</p>
            <p>{c('Página de empleo de la empresa:', 'Company careers page:')} <a href={board.careersUrl} target="_blank" rel="noopener noreferrer">{board.careersUrl}</a></p>
            <label className="checkbox-line"><input type="checkbox" checked={confirmed.officialLink} onChange={(event) => changeCheck(board.id, 'officialLink', event.target.checked)}/><span>{c('La página de empleo de la empresa enlaza a este tablero.', 'The company careers page links to this job board.')}</span></label>
            <label className="checkbox-line"><input type="checkbox" checked={confirmed.readOnlyAccess} onChange={(event) => changeCheck(board.id, 'readOnlyAccess', event.target.checked)}/><span>{c('Entiendo que la app solo lee ofertas públicas y no enviará solicitudes.', 'I understand the app only reads public jobs and will not submit applications.')}</span></label>
            {boardProvider && <a className="documentation-link" href={boardProvider.reference} target="_blank" rel="noopener noreferrer">{c(`Cómo funciona el tablero público de ${boardProvider.label}`, `How the ${boardProvider.label} public job board works`)} <Icon name="arrow" size={13}/></a>}
            <Button onClick={() => void review(board)} disabled={busy !== '' || !canReview}>{working ? c('Guardando…', 'Saving…') : status === 'needs-confirmation' ? c('Confirmar y activar búsqueda', 'Confirm and turn on search') : c('Confirmar y reactivar', 'Confirm and turn back on')}</Button>
          </div>}
        </Card>;
      })}
      {loadState === 'ready' && !boards.length && <Card className="jobs-empty"><Empty title={c('Aún no sigues empresas', 'No followed companies yet')} detail={c('Añade una empresa para consultar sus ofertas cuando quieras. También puedes guardar una oferta directamente en Ofertas guardadas.', 'Add a company to check its jobs when you choose. You can also add a job directly in Saved jobs.')}/></Card>}
      <div className="refresh-policy">{c('Puedes consultar manualmente cada empresa o activar la búsqueda automática arriba. Dejamos al menos seis horas entre consultas; los reintentos pueden tardar más.', 'Check each company manually or turn on automatic search above. Checks are at least six hours apart; retries may take longer.')}</div>
    </div>
    <aside className="add-board-aside">
      <Card className="form-card"><div className="form-heading"><div><span className="step-badge">＋</span><div><h2 id="follow-company-heading" ref={formHeading} tabIndex={-1}>{c('Seguir una empresa', 'Follow a company')}</h2><p>{c('Necesitas dos enlaces: la página de empleo de la empresa y una oferta publicada desde ella.', 'You need two links: the company careers page and a job listed on it.')}</p></div></div></div>
        {!open && <p className="muted-label">{companyName || careersUrl || boardUrl ? c('Tienes una empresa por terminar de añadir.', 'You have an unfinished company form.') : c('Compatible con Greenhouse, Lever y Ashby.', 'Supports Greenhouse, Lever, and Ashby.')}</p>}
        {!open ? <Button onClick={() => setOpen(true)}><Icon name="plus" size={15}/>{c('Añadir empresa', 'Add company')}</Button> : <form onSubmit={(event) => void add(event)} className="form-stack" aria-busy={busy === 'add'}><fieldset className="entry-fields" disabled={!draft.ready || busy !== ''}>
          <Field id="company-name" label={c('Nombre de la empresa', 'Company name')} value={companyName} onChange={(event) => setCompanyName(event.target.value)} placeholder={c('Ejemplo: Northwind', 'Example: Northwind')} required/>
          <Field label={c('Página de empleo de la empresa', 'Company careers page')} type="url" value={careersUrl} onChange={(event) => setCareersUrl(event.target.value)} placeholder="https://company.com/careers" required hint={c('La página donde la empresa publica sus ofertas.', 'The page where the company lists its jobs.')}/>
          {careersUrl && !careersDomain && <div className="notice notice-warning">{c('Ese enlace no parece una dirección web válida.', 'That link does not look like a valid web address.')}</div>}
          <Field label={c('Enlace a una oferta de esa empresa', 'Link to a job at this company')} type="url" value={boardUrl} onChange={(event) => setBoardUrl(event.target.value)} placeholder="https://jobs.lever.co/company" required hint={c('Abre una oferta desde la página de empleo y copia la dirección del navegador.', 'Open a job from the careers page and copy the address from your browser.')}/>
          {source && provider ? <div className="source-detected"><span className="status-dot status-ready"/><span>{c(`Enlace compatible con ${provider.label}`, `Link supported by ${provider.label}`)}{source.region === 'eu' ? ` · ${labelFor.region(source.region, locale)}` : ''}</span></div>
            : boardUrl ? <div className="notice notice-warning">{c('Este enlace no es compatible. Puedes guardar la oferta directamente en Ofertas guardadas.', 'This link is not supported. You can add the job directly in Saved jobs.')}</div>
            : <details className="source-help"><summary>{c('¿Dónde encuentro estos enlaces?', 'Where can I find these links?')}</summary><p>{c('Abre la página oficial de empleo de la empresa y copia su dirección. Luego abre una oferta y copia también ese enlace.', 'Open the company’s official careers page and copy its address. Then open a listed job and copy that address too.')}</p><small>Greenhouse · boards.greenhouse.io/company<br/>Lever · jobs.lever.co/company<br/>Ashby · jobs.ashbyhq.com/company</small></details>}
          <div className="form-submit"><Button type="submit" disabled={busy !== '' || !source || !careersDomain || !companyName.trim()}>{busy === 'add' ? c('Guardando…', 'Saving…') : c('Añadir empresa', 'Add company')}</Button><Button type="button" variant="quiet" onClick={() => setOpen(false)}>{c('Cerrar y continuar después', 'Close and continue later')}</Button></div>
        </fieldset></form>}
      </Card>
      <Card className="add-board-note"><div className="card-icon peach"><Icon name="shield" size={17}/></div><h3>{c('Tú mantienes el control', 'You stay in control')}</h3><p>{c('Solo consultamos las ofertas públicas del tablero que indiques, y solo después de que confirmes que pertenece a la empresa.', 'We only check the public jobs on the board you provide, and only after you confirm it belongs to the company.')}</p></Card>
    </aside></div>
  </AppShell></WorkspaceGate>;
}
