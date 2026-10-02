'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AppShell, PageHeader, WorkspaceGate } from '@/components/shell';
import { Button, Card, Empty, Field, Icon, Notice, Tag } from '@/components/ui';
import { api, ApiError, errorMessage, formatDate } from '@/lib/api';
import { getOfficialDomain, parseJobBoardUrl } from '@/lib/board-url';
import { useLocale } from '@/lib/i18n';
import { copy, labelFor, timeUntil } from '@/lib/labels';

type Board = { id: string; provider: string; tenant: string; region: string; companyName: string; companyDomain: string; careersUrl: string; associationStatus: string; permissionStatus: string; enabled: boolean; reviewedAt: string | null; reviewDueAt: string | null; lastSuccessfulRefreshAt: string | null };
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
  const [companyName, setCompanyName] = useState(''); const [careersUrl, setCareersUrl] = useState(''); const [boardUrl, setBoardUrl] = useState('');
  const [checks, setChecks] = useState<Record<string, ReviewChecks>>({});
  const [busy, setBusy] = useState(''); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(false); const [now, setNow] = useState(() => Date.now());
  const source = parseJobBoardUrl(boardUrl); const careersDomain = getOfficialDomain(careersUrl); const provider = source ? providers[source.provider] : null;

  const load = useCallback(async () => {
    try { setBoards(await api<Board[]>('/boards')); setLoadState('ready'); setNow(Date.now()); }
    catch (err) { setError(errorMessage(err)); setLoadState((current) => current === 'ready' ? 'ready' : 'error'); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  // Keeps the cooldown countdown honest without polling the API.
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 60_000); return () => window.clearInterval(timer); }, []);

  const begin = (key: string) => { setBusy(key); setError(''); setMessage(''); setCardErrors((current) => { const next = { ...current }; delete next[key]; return next; }); };
  const cardFail = (id: string, err: unknown) => setCardErrors((current) => ({ ...current, [id]: errorMessage(err) }));

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!source || !careersDomain) { setError(c('Añade la página de empleo de la empresa y un enlace compatible.', 'Add the company careers page and a supported job board link.')); return; }
    begin('add');
    try {
      const created = await api<Board>('/boards', { method: 'POST', body: JSON.stringify({ provider: source.provider, tenant: source.companyKey, region: source.region, companyName: companyName.trim(), companyDomain: careersDomain, careersUrl: careersUrl.trim(), associationStatus: 'UNVERIFIED', permissionStatus: 'UNKNOWN', enabled: false }) });
      setMessage(c('Fuente añadida. Confírmala abajo para empezar a buscar vacantes.', 'Source added. Confirm it below to start finding jobs.'));
      setChecks((current) => ({ ...current, [created.id]: noChecks }));
      setCompanyName(''); setCareersUrl(''); setBoardUrl(''); setOpen(false); await load();
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(''); }
  };

  const review = async (board: Board) => {
    begin(board.id);
    try {
      await api(`/boards/${board.id}/review`, { method: 'POST', body: JSON.stringify({ officialAssociationConfirmed: true, publicReadReviewed: true, referenceUrl: providers[board.provider]?.reference, notes: 'Owner confirmed the official company link and reviewed the provider read-only access.' }) });
      setChecks((current) => ({ ...current, [board.id]: noChecks }));
      setMessage(c(`${board.companyName}: búsqueda activada. Ya puedes buscar vacantes.`, `${board.companyName}: job search turned on. You can now look for jobs.`)); await load();
    } catch (err) { cardFail(board.id, err); } finally { setBusy(''); }
  };

  const refresh = async (board: Board) => {
    begin(board.id);
    try {
      const result = await api<{ added: number; updated: number; coverage: string }>(`/boards/${board.id}/refresh`, { method: 'POST', body: '{}' });
      setMessage(result.added + result.updated === 0
        ? c(`${board.companyName} no tiene vacantes públicas ahora mismo.`, `${board.companyName} has no public jobs right now.`)
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
    try { await api(`/boards/${board.id}/disable`, { method: 'POST', body: '{}' }); setMessage(c(`${board.companyName}: búsqueda desactivada. Las vacantes guardadas se mantienen.`, `${board.companyName}: job search turned off. Saved jobs are kept.`)); await load(); }
    catch (err) { cardFail(board.id, err); } finally { setBusy(''); }
  };

  const changeCheck = (id: string, key: keyof ReviewChecks, checked: boolean) => setChecks((current) => ({ ...current, [id]: { ...(current[id] ?? noChecks), [key]: checked } }));
  const activeCount = boards.filter((board) => boardStatus(board, now) === 'active').length;

  const statusTag: Record<BoardStatus, { tone: 'green' | 'amber' | 'red' | 'neutral'; text: string }> = {
    active: { tone: 'green', text: c('BUSCANDO', 'SEARCHING') },
    'needs-confirmation': { tone: 'amber', text: c('FALTA TU CONFIRMACIÓN', 'NEEDS YOUR CONFIRMATION') },
    expired: { tone: 'red', text: c('CONFIRMACIÓN CADUCADA', 'CONFIRMATION EXPIRED') },
    off: { tone: 'neutral', text: c('DESACTIVADA', 'TURNED OFF') },
  };

  return <WorkspaceGate><AppShell>
    <PageHeader eyebrow={c('FUENTES DE EMPLEO', 'JOB SOURCES')} title={c('Elige dónde buscar.', 'Choose where to search.')} description={c('Añade la página de empleo de una empresa y su tablero público. Solo leemos vacantes publicadas; nunca rellenamos ni enviamos candidaturas.', 'Add a company careers page and its public job board. We only read published jobs; we never fill in or submit applications.')}/>
    {error && <Notice tone="error">{error}</Notice>}{message && <Notice tone="success">{message} {activeCount > 0 && <Link href="/jobs">{c('Ver vacantes', 'See jobs')}</Link>}</Notice>}
    <div className="source-policy-banner"><span className="source-policy-icon"><Icon name="shield" size={19}/></span><div><strong>{c('Solo lectura', 'Read-only')}</strong><p>{c('Añadir una fuente nunca permite a esta app rellenar o enviar formularios.', 'Adding a source never lets this app fill in or submit forms.')}</p></div><Tag tone="green">{c('SIN ENVÍOS', 'NO SUBMISSIONS')}</Tag></div>
    <div className="boards-layout"><div className="boards-list">
      <div className="section-heading compact"><div><div className="eyebrow"><span className="eyebrow-mark"/> {c('TUS FUENTES', 'YOUR SOURCES')}</div><h2>{c('Fuentes de empleo', 'Job sources')}</h2></div><span className="muted-label">{c(`${activeCount} de ${boards.length} buscando`, `${activeCount} of ${boards.length} searching`)}</span></div>
      {loadState === 'loading' && <Notice>{c('Cargando fuentes…', 'Loading sources…')}</Notice>}
      {loadState === 'error' && <Notice tone="warning">{c('No pudimos cargar tus fuentes.', 'We could not load your sources.')} <Button variant="quiet" onClick={() => { setError(''); setLoadState('loading'); void load(); }}>{c('Reintentar', 'Try again')}</Button></Notice>}
      {boards.map((board) => {
        const status = boardStatus(board, now); const confirmed = checks[board.id] ?? noChecks; const boardProvider = providers[board.provider];
        const canReview = confirmed.officialLink && confirmed.readOnlyAccess; const working = busy === board.id;
        const nextRefresh = board.lastSuccessfulRefreshAt ? new Date(board.lastSuccessfulRefreshAt).getTime() + COOLDOWN_MS : 0; const coolingDown = nextRefresh > now;
        return <Card className="board-card" key={board.id}>
          <div className="board-card-head"><div className="board-brand">{boardProvider?.label.slice(0, 1) ?? '?'}</div><div className="board-company"><strong>{board.companyName}</strong><small>{boardProvider?.label ?? board.provider}{board.region === 'eu' ? ` · ${labelFor.region(board.region, locale)}` : ''} · {board.companyDomain}</small></div><Tag tone={statusTag[status].tone}>{statusTag[status].text}</Tag></div>
          <div className="board-details">
            <div><span>{c('Enlace de la empresa', 'Company link')}</span><strong>{board.associationStatus === 'VERIFIED' ? c('Confirmado por ti', 'Confirmed by you') : c('Sin confirmar', 'Not confirmed')}</strong></div>
            <div><span>{c('Confirmación válida hasta', 'Confirmation valid until')}</span><strong>{board.reviewDueAt ? formatDate(board.reviewDueAt) : '—'}</strong></div>
            <div><span>{c('Última búsqueda', 'Last search')}</span><strong>{board.lastSuccessfulRefreshAt ? formatDate(board.lastSuccessfulRefreshAt) : c('Nunca', 'Never')}</strong></div>
          </div>
          {cardErrors[board.id] && <Notice tone="error">{cardErrors[board.id]}</Notice>}
          {status === 'active' ? <div className="board-actions">
            <Button variant="secondary" onClick={() => void refresh(board)} disabled={working || busy !== '' || coolingDown}><Icon name="search" size={15}/>{working ? c('Buscando…', 'Searching…') : coolingDown ? c(`Disponible en ${timeUntil(new Date(nextRefresh))}`, `Available in ${timeUntil(new Date(nextRefresh))}`) : c('Buscar vacantes nuevas', 'Find new jobs')}</Button>
            <Button variant="quiet" onClick={() => void disable(board)} disabled={busy !== ''}>{c('Desactivar', 'Turn off')}</Button>
          </div> : <div className="board-review-box">
            <p>{status === 'expired' ? c('Las confirmaciones caducan a los 90 días. Vuelve a comprobar que el enlace sigue siendo de la empresa.', 'Confirmations expire after 90 days. Check again that the link still belongs to the company.')
              : status === 'off' ? c('Desactivaste esta fuente. Confirma de nuevo para reanudar la búsqueda.', 'You turned this source off. Confirm again to resume searching.')
              : c('Antes de buscar, comprueba que este tablero es el oficial de la empresa.', 'Before searching, check that this job board is the company’s official one.')}</p>
            <p>{c('Página de empleo de la empresa:', 'Company careers page:')} <a href={board.careersUrl} target="_blank" rel="noopener noreferrer">{board.careersUrl}</a></p>
            <label className="checkbox-line"><input type="checkbox" checked={confirmed.officialLink} onChange={(event) => changeCheck(board.id, 'officialLink', event.target.checked)}/><span>{c('La página de empleo de la empresa enlaza a este tablero.', 'The company careers page links to this job board.')}</span></label>
            <label className="checkbox-line"><input type="checkbox" checked={confirmed.readOnlyAccess} onChange={(event) => changeCheck(board.id, 'readOnlyAccess', event.target.checked)}/><span>{c('Entiendo que la app solo lee vacantes públicas y no enviará candidaturas.', 'I understand the app only reads public jobs and will not submit applications.')}</span></label>
            {boardProvider && <a className="documentation-link" href={boardProvider.reference} target="_blank" rel="noopener noreferrer">{c(`Cómo funciona el tablero público de ${boardProvider.label}`, `How the ${boardProvider.label} public job board works`)} <Icon name="arrow" size={13}/></a>}
            <Button onClick={() => void review(board)} disabled={busy !== '' || !canReview}>{working ? c('Guardando…', 'Saving…') : status === 'needs-confirmation' ? c('Confirmar y activar búsqueda', 'Confirm and turn on search') : c('Confirmar y reactivar', 'Confirm and turn back on')}</Button>
          </div>}
        </Card>;
      })}
      {loadState === 'ready' && !boards.length && <Card className="jobs-empty"><Empty title={c('Aún no hay fuentes', 'No job sources yet')} detail={c('Añade la página de empleo de una empresa y su tablero. No buscamos nada hasta que lo confirmes.', 'Add a company careers page and its job board. Nothing is searched until you confirm it.')}/></Card>}
      <div className="refresh-policy">{c('Cada fuente puede consultarse una vez cada seis horas. Si una búsqueda falla, no se cierra ninguna vacante.', 'Each source can be checked once every six hours. If a search fails, no jobs are closed.')}</div>
    </div>
    <aside className="add-board-aside">
      <Card className="form-card"><div className="form-heading"><div><span className="step-badge">＋</span><div><h2>{c('Añadir una fuente', 'Add a job source')}</h2><p>{c('Pega los enlaces que ya usas; nosotros detectamos el resto.', 'Paste the links you already use; we work out the rest.')}</p></div></div></div>
        {!open ? <Button onClick={() => setOpen(true)}><Icon name="plus" size={15}/>{c('Añadir fuente', 'Add source')}</Button> : <form onSubmit={(event) => void add(event)} className="form-stack" aria-busy={busy === 'add'}>
          <Field label={c('Nombre de la empresa', 'Company name')} value={companyName} onChange={(event) => setCompanyName(event.target.value)} placeholder={c('Ejemplo: Northwind', 'Example: Northwind')} required/>
          <Field label={c('Página de empleo de la empresa', 'Company careers page')} type="url" value={careersUrl} onChange={(event) => setCareersUrl(event.target.value)} placeholder="https://company.com/careers" required hint={c('La página donde la empresa publica sus vacantes.', 'The page where the company lists its jobs.')}/>
          {careersUrl && !careersDomain && <div className="notice notice-warning">{c('Ese enlace no parece una dirección web válida.', 'That link does not look like a valid web address.')}</div>}
          <Field label={c('Enlace a una vacante o al tablero', 'Link to a job or the job board')} type="url" value={boardUrl} onChange={(event) => setBoardUrl(event.target.value)} placeholder="https://jobs.lever.co/company" required hint={c('Abre una vacante desde la página de empleo y copia la dirección del navegador.', 'Open a job from the careers page and copy the address from your browser.')}/>
          {source && provider ? <div className="source-detected"><span className="status-dot status-ready"/><span>{c(`Tablero de ${provider.label} detectado`, `${provider.label} job board detected`)}{source.region === 'eu' ? ` · ${labelFor.region(source.region, locale)}` : ''}</span></div>
            : boardUrl ? <div className="notice notice-warning">{c('No reconocemos ese enlace. Admitimos tableros de Greenhouse, Lever y Ashby.', 'We do not recognise that link. Greenhouse, Lever, and Ashby job boards are supported.')}</div>
            : <details className="source-help"><summary>{c('¿Dónde encuentro estos enlaces?', 'Where can I find these links?')}</summary><p>{c('Abre la página oficial de empleo de la empresa y copia su dirección. Luego abre una vacante y copia también ese enlace.', 'Open the company’s official careers page and copy its address. Then open a listed job and copy that address too.')}</p><small>Greenhouse · boards.greenhouse.io/company<br/>Lever · jobs.lever.co/company<br/>Ashby · jobs.ashbyhq.com/company</small></details>}
          <div className="form-submit"><Button type="submit" disabled={busy !== '' || !source || !careersDomain || !companyName.trim()}>{busy === 'add' ? c('Guardando…', 'Saving…') : c('Añadir fuente', 'Add source')}</Button><Button type="button" variant="quiet" onClick={() => setOpen(false)}>{c('Cancelar', 'Cancel')}</Button></div>
        </form>}
      </Card>
      <Card className="add-board-note"><div className="card-icon peach"><Icon name="shield" size={17}/></div><h3>{c('Tú mantienes el control', 'You stay in control')}</h3><p>{c('Solo consultamos las vacantes públicas del tablero que indiques, y solo después de que confirmes que pertenece a la empresa.', 'We only check the public jobs on the board you provide, and only after you confirm it belongs to the company.')}</p></Card>
    </aside></div>
  </AppShell></WorkspaceGate>;
}
