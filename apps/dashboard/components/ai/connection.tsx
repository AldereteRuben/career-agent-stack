'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { AiUsageSnapshot } from '@career/domain';
import { Button, Notice, Tag } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { localizedError, useLocale, type Locale } from '@/lib/i18n';
import { copy } from '@/lib/labels';
import type { AiConnectionResponse, AiLoginAttempt, AiSessionObservation } from './types';
import styles from './connection.module.css';

type Action = 'inspect' | 'authorize' | 'login' | 'cancel' | 'disconnect';
type Feedback = 'checked' | 'connected' | 'disconnected' | 'login-completed' | 'login-cancelled' | 'login-expired' | 'login-failed' | null;
const INSTALL_URL = 'https://developers.openai.com/codex/cli';

/** Provider identifiers are not customer-facing subscription names. */
function planLabel(plan: string, locale: Locale): string {
  const plans: Record<string, string> = {
    free: 'ChatGPT Free', go: 'ChatGPT Go', plus: 'ChatGPT Plus',
    pro: 'ChatGPT Pro', prolite: 'ChatGPT Pro', promax: 'ChatGPT Pro',
    team: 'ChatGPT Business', business: 'ChatGPT Business',
    self_serve_business_prolite: 'ChatGPT Business', self_serve_business_usage_based: 'ChatGPT Business',
    enterprise: 'ChatGPT Enterprise', ent26: 'ChatGPT Enterprise',
    enterprise_cbp_automation: 'ChatGPT Enterprise', enterprise_cbp_usage_based: 'ChatGPT Enterprise',
    edu: 'ChatGPT Edu', edu_plus: 'ChatGPT Edu', edu_pro: 'ChatGPT Edu',
  };
  return plans[plan] ?? copy(locale)('Detalle no disponible', 'Details unavailable');
}

function errorCode(error: unknown): string {
  return error instanceof ApiError ? error.code : error instanceof TypeError ? 'NETWORK_UNAVAILABLE' : 'UNKNOWN';
}

function connectionError(code: string, locale: Locale): string {
  const c = copy(locale);
  const messages: Record<string, string> = {
    AI_DISABLED: c('La ayuda con IA no está activa en esta instalación.', 'AI assistance is not active on this installation.'),
    AI_UNAVAILABLE: c('Codex no está disponible ahora. Comprueba que esté instalado y vuelve a intentarlo.', 'Codex is unavailable right now. Check that it is installed and try again.'),
    AI_NOT_INSTALLED: c('Instala Codex en este equipo y vuelve a comprobar la conexión.', 'Install Codex on this device and check the connection again.'),
    AI_OBSERVATION_EXPIRED: c('La comprobación de la cuenta ha caducado. Pulsa Actualizar conexión antes de conectarla.', 'The account check expired. Choose Refresh connection before connecting it.'),
    AI_CHECK_ACCOUNT: c('Comprueba de nuevo la cuenta de Codex antes de conectarla. La comprobación anterior ya no está disponible.', 'Check your Codex account again before connecting it. The previous check is no longer available.'),
    AI_ACCOUNT_CHANGED: c('La cuenta de Codex cambió. Compruébala de nuevo y elige la cuenta que quieras usar.', 'The Codex account changed. Check it again and choose the account you want to use.'),
    AI_CONNECTION_CONFLICT: c('La conexión cambió mientras la estabas revisando. Pulsa Actualizar conexión y revisa la cuenta actual.', 'The connection changed while you were reviewing it. Choose Refresh connection and review the current account.'),
    AI_CONNECTION_NOT_FOUND: c('Esa conexión ya no está disponible. Pulsa Actualizar conexión para ver el estado actual.', 'That connection is no longer available. Choose Refresh connection to see its current status.'),
    AI_AUTH_REQUIRED: c('Inicia sesión en Codex y vuelve a comprobar la conexión.', 'Sign in to Codex and check the connection again.'),
    AI_LOGIN_UNAVAILABLE: c('No pudimos iniciar la conexión. Inicia sesión desde la aplicación oficial de Codex y vuelve a comprobarla aquí.', 'We could not start sign-in. Sign in using the official Codex application, then check again here.'),
    LOGIN_UNAVAILABLE: c('No pudimos iniciar la conexión. Inicia sesión desde la aplicación oficial de Codex y vuelve a comprobarla aquí.', 'We could not start sign-in. Sign in using the official Codex application, then check again here.'),
    LOGIN_BUSY: c('Ya hay un inicio de sesión en curso en este equipo. Termínalo o cancélalo antes de empezar otro.', 'A sign-in is already in progress on this device. Finish or cancel it before starting another.'),
    LOGIN_NOT_FOUND: c('Este intento de inicio de sesión ya no está disponible. Puedes empezar uno nuevo.', 'This sign-in attempt is no longer available. You can start a new one.'),
    AI_LOGIN_URL_INVALID: c('No se pudo abrir un enlace oficial de inicio de sesión. Cancela este intento y vuelve a intentarlo.', 'An official sign-in link could not be opened. Cancel this attempt and try again.'),
    AI_LOGIN_POLL_FAILED: c('No pudimos comprobar el inicio de sesión. Reintenta la comprobación; no hace falta abrir otro inicio de sesión.', 'We could not check sign-in progress. Retry the check; you do not need to start another sign-in.'),
  };
  return messages[code] ?? localizedError(code, locale);
}

/** Never make a provider-returned URL an unrestricted navigation target. */
function officialLoginUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['auth.openai.com', 'chatgpt.com'].includes(url.hostname) && !url.port && !url.username && !url.password && !url.hash ? url.href : null;
  } catch { return null; }
}

function displayDate(value: string | null | undefined, locale: Locale): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Intl.DateTimeFormat(locale === 'es' ? 'es-ES' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function UsageDetails({ usage, locale }: { usage: AiUsageSnapshot | null; locale: Locale }) {
  const c = copy(locale);
  const hasWindows = usage && usage.availability !== 'UNAVAILABLE' && usage.windows.length > 0;
  const observedAt = displayDate(usage?.observedAt, locale);
  return <details className={styles.disclosure}>
    <summary>{c('Consultar el consumo de mi cuenta', 'View my account usage')}</summary>
    <div className={styles.detailsBody}>
      <p className={styles.hint}>{c('Son datos de tu cuenta de Codex y pueden incluir uso en otras aplicaciones. Los porcentajes indican lo que ya has consumido.', 'These are figures for your Codex account and may include use in other applications. Percentages show how much you have already used.')}</p>
      {!hasWindows ? <p>{c('Codex no ha facilitado la cuota disponible. No podemos estimar cuántas tareas te quedan.', 'Codex has not provided available quota. We cannot estimate how many tasks you have left.')}</p> : <>
        {usage.availability === 'STALE' && <p>{c('Estos datos pueden haber cambiado. Pulsa Actualizar conexión para actualizarlos.', 'These figures may have changed. Choose Refresh connection to update them.')}</p>}
        {usage.anyLimitReached === true && <Notice tone="warning" role={null}>{c('Codex indica que has alcanzado un límite. Espera a que se restablezca antes de iniciar otra tarea.', 'Codex reports that you have reached a limit. Wait for it to reset before starting another task.')}</Notice>}
        <ul className={styles.usageList}>{usage.windows.map((window, index) => {
          const used = typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent) ? Math.max(0, Math.min(100, window.usedPercent)) : null;
          const label = window.label || c(`Periodo ${index + 1}`, `Period ${index + 1}`);
          const resetsAt = displayDate(window.resetsAt, locale);
          const formatted = used === null ? null : new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(used);
          return <li className={styles.usageItem} key={`${window.windowId}-${index}`}>
            <div className={styles.usageLabel}><strong>{label}</strong><span>{formatted === null ? c('Consumo no disponible', 'Usage unavailable') : c(`${formatted}% consumido`, `${formatted}% used`)}</span></div>
            {used !== null && <meter min={0} max={100} value={used} aria-label={c(`Consumo de ${label}`, `Usage for ${label}`)}>{formatted}%</meter>}
            {resetsAt && <small className={styles.hint}>{c('Se restablece:', 'Resets:')} <time dateTime={window.resetsAt!}>{resetsAt}</time></small>}
          </li>;
        })}</ul>
      </>}
      {observedAt && <p className={styles.hint}>{c('Última consulta:', 'Last checked:')} <time dateTime={usage!.observedAt!}>{observedAt}</time></p>}
      <p className={styles.hint}>{c('La cuota puede cambiar entre consultas. Career Stack no calcula costes ni garantiza tareas disponibles a partir de estos porcentajes.', 'Quota may change between checks. Career Stack does not calculate costs or guarantee available tasks from these percentages.')}</p>
    </div>
  </details>;
}

/** Pass visible=false when the parent disclosure/tab is hidden; network polling then pauses. */
export function AiConnectionPanel({ visible = true, onConnectionChange }: { visible?: boolean; onConnectionChange?: (state: AiConnectionResponse) => void }) {
  const { locale } = useLocale();
  const c = copy(locale);
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(false);
  const generation = useRef(0);
  const loadedRevision = useRef<number | null>(null);
  const changeHandler = useRef(onConnectionChange);
  useEffect(() => { changeHandler.current = onConnectionChange; }, [onConnectionChange]);
  const [state, setState] = useState<AiConnectionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [login, setLogin] = useState<AiLoginAttempt | null>(null);
  const [reload, setReload] = useState(0);
  const [pollRetry, setPollRetry] = useState(0);
  const [pageVisible, setPageVisible] = useState(true);
  const [pollFailed, setPollFailed] = useState(false);

  useEffect(() => {
    mounted.current = true;
    const update = () => setPageVisible(document.visibilityState === 'visible');
    update();
    document.addEventListener('visibilitychange', update);
    return () => { mounted.current = false; generation.current += 1; document.removeEventListener('visibilitychange', update); };
  }, []);

  useEffect(() => {
    if (!visible || loadedRevision.current === reload) return;
    const controller = new AbortController();
    const ticket = generation.current;
    setLoading(true);
    void api<AiConnectionResponse>('/ai/connections', { signal: controller.signal }).then((next) => {
      if (controller.signal.aborted || generation.current !== ticket) return;
      loadedRevision.current = reload;
      setState(next); setError(null); changeHandler.current?.(next);
    }).catch((failure) => {
      if (!controller.signal.aborted && generation.current === ticket) setError(failure instanceof ApiError && failure.status === 404 ? 'AI_DISABLED' : errorCode(failure));
    }).finally(() => {
      if (!controller.signal.aborted && generation.current === ticket) setLoading(false);
    });
    return () => controller.abort();
  }, [visible, reload]);

  const waitingId = login?.state === 'WAITING' ? login.id : null;
  useEffect(() => {
    if (!visible || !pageVisible || !waitingId || action) return;
    const controller = new AbortController();
    const ticket = generation.current;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const attempt = await api<AiLoginAttempt>(`/ai/login-attempts/${encodeURIComponent(waitingId)}`, { signal: controller.signal });
        if (controller.signal.aborted || generation.current !== ticket) return;
        setPollFailed(false);
        if (attempt.state === 'WAITING') {
          setLogin((current) => current?.id === attempt.id ? { ...current, ...attempt } : current);
          timer = window.setTimeout(() => void poll(), 2500); return;
        }
        if (attempt.state === 'COMPLETED') {
          try {
            const next = await api<AiConnectionResponse>('/ai/connections/codex/inspect', { method: 'POST', signal: controller.signal });
            if (!controller.signal.aborted && generation.current === ticket) { setState(next); setError(null); changeHandler.current?.(next); }
          } catch (failure) {
            if (!controller.signal.aborted && generation.current === ticket) setError(errorCode(failure));
          }
        }
        if (controller.signal.aborted || generation.current !== ticket) return;
        const outcomes: Record<Exclude<AiLoginAttempt['state'], 'WAITING'>, Feedback> = { COMPLETED: 'login-completed', CANCELLED: 'login-cancelled', EXPIRED: 'login-expired', FAILED: 'login-failed' };
        setLogin((current) => current?.id === attempt.id ? { ...current, ...attempt } : current);
        setFeedback(outcomes[attempt.state]);
      } catch (failure) {
        if (!controller.signal.aborted && generation.current === ticket) {
          if (failure instanceof ApiError && failure.code === 'LOGIN_NOT_FOUND') {
            setLogin(null); setError('LOGIN_NOT_FOUND'); setPollFailed(false);
          } else setPollFailed(true);
        }
      }
    };
    void poll();
    // Leaving this panel cancels only our polling, never the official login attempt.
    return () => { controller.abort(); if (timer !== undefined) window.clearTimeout(timer); };
  }, [visible, pageVisible, waitingId, action, pollRetry]);

  const perform = async (kind: Action) => {
    if (action || !state || (!state.enabled && kind !== 'disconnect')) return;
    const ticket = ++generation.current;
    setAction(kind); setError(null); setFeedback(null); setPollFailed(false);
    try {
      if (kind === 'login') {
        const attempt = await api<AiLoginAttempt>('/ai/connections/codex/login', { method: 'POST' });
        if (!mounted.current || generation.current !== ticket) return;
        setLogin(attempt);
        if (!officialLoginUrl(attempt.url)) setError('AI_LOGIN_URL_INVALID');
      } else if (kind === 'cancel' && login) {
        const attempt = await api<AiLoginAttempt>(`/ai/login-attempts/${encodeURIComponent(login.id)}/cancel`, { method: 'POST' });
        if (!mounted.current || generation.current !== ticket) return;
        setLogin(attempt);
        setFeedback(attempt.state === 'COMPLETED' ? 'login-completed' : attempt.state === 'EXPIRED' ? 'login-expired' : attempt.state === 'FAILED' ? 'login-failed' : attempt.state === 'CANCELLED' ? 'login-cancelled' : null);
        if (attempt.state === 'COMPLETED') {
          const next = await api<AiConnectionResponse>('/ai/connections/codex/inspect', { method: 'POST' });
          if (!mounted.current || generation.current !== ticket) return;
          setState(next); changeHandler.current?.(next);
        }
        heading.current?.focus({ preventScroll: true });
      } else {
        const endpoint = kind === 'inspect' ? '/ai/connections/codex/inspect' : kind === 'authorize' ? '/ai/connections/codex/authorize' : `/ai/connections/${encodeURIComponent(state.connection?.id ?? '')}/disconnect`;
        if ((kind === 'authorize' && !state.observation) || (kind === 'disconnect' && !state.connection)) return;
        const next = await api<AiConnectionResponse>(endpoint, { method: 'POST', ...(kind === 'authorize' ? { body: JSON.stringify({ observationId: state.observation!.id }) } : {}) });
        if (!mounted.current || generation.current !== ticket) return;
        setState(next); changeHandler.current?.(next);
        if (kind === 'inspect') setFeedback('checked');
        if (kind === 'authorize' || kind === 'disconnect') {
          if (kind === 'authorize' && next.connection?.authorized && next.connection.sessionState === 'SIGNED_IN') setFeedback('connected');
          else if (kind === 'disconnect' && !next.connection?.authorized) setFeedback('disconnected');
          heading.current?.focus({ preventScroll: true });
        }
      }
    } catch (failure) {
      if (mounted.current && generation.current === ticket) setError(errorCode(failure));
    } finally {
      if (mounted.current && generation.current === ticket) setAction(null);
    }
  };

  const connected = state?.connection?.authorized === true && state.connection.sessionState === 'SIGNED_IN';
  const observed: AiSessionObservation | null = state?.observation ?? state?.connection ?? null;
  const loginUrl = officialLoginUrl(login?.url);
  const busy = loading || action !== null;
  const canAuthorize = !connected && state?.observation?.sessionState === 'SIGNED_IN';
  const unavailable = state?.enabled === false || error === 'NOT_FOUND' || error === 'AI_DISABLED';
  const feedbackMessages: Record<NonNullable<Feedback>, string> = {
    checked: c('Conexión actualizada. Esta comprobación consulta la sesión y el consumo; no ejecuta tareas de IA.', 'Connection refreshed. This check reads the session and usage; it does not run AI tasks.'),
    connected: c('Cuenta conectada. Podrás elegir qué tarea hacer y qué información compartir.', 'Account connected. You can choose which task to run and which information to share.'),
    disconnected: c('Codex se desconectó de Career Stack. Tu sesión de Codex sigue abierta fuera de esta app.', 'Codex was disconnected from Career Stack. Your Codex session remains signed in outside this app.'),
    'login-completed': c('Has iniciado sesión. Revisa la cuenta y elige Usar esta cuenta para conectarla a Career Stack.', 'You are signed in. Review the account and choose Use this account to connect it to Career Stack.'),
    'login-cancelled': c('Inicio de sesión cancelado.', 'Sign-in cancelled.'),
    'login-expired': c('El inicio de sesión caducó. Puedes empezar de nuevo cuando quieras.', 'Sign-in expired. You can start again when you are ready.'),
    'login-failed': c('No se pudo completar el inicio de sesión. Inténtalo de nuevo.', 'Sign-in could not be completed. Try again.'),
  };

  return <section className={styles.panel} aria-labelledby={headingId} hidden={!visible}>
    <div className={styles.header}>
      <h2 id={headingId} tabIndex={-1} ref={heading}>{c('Ayuda con IA', 'AI assistance')}</h2>
      <Tag tone={connected && !unavailable ? 'green' : 'neutral'}>{connected && !unavailable ? c('Codex conectado', 'Codex connected') : c('Opcional', 'Optional')}</Tag>
    </div>
    <p className={styles.intro}>{c('Usa tu cuenta de Codex cuando quieras ayuda con una búsqueda o una candidatura. Puedes seguir usando Career Stack sin conectarla.', 'Use your Codex account when you want help with a search or application. You can keep using Career Stack without connecting it.')}</p>
    {loading && <p className={styles.loading} role="status">{c('Consultando la conexión…', 'Checking the connection…')}</p>}
    {unavailable ? <>
      <p>{c('La ayuda con IA no está activa en esta instalación. Tus búsquedas automáticas y las demás funciones siguen disponibles.', 'AI assistance is not active on this installation. Your automatic searches and other features remain available.')}</p>
      {state?.connection?.authorized && <div className={styles.state}>
        <p>{c('Hay una autorización de cuenta guardada. Puedes retirarla aunque la ayuda con IA esté desactivada.', 'An account permission is saved. You can remove it while AI assistance is turned off.')}</p>
        <div className={styles.actions}><Button variant="secondary" disabled={busy} onClick={() => void perform('disconnect')}>{action === 'disconnect' ? c('Desconectando…', 'Disconnecting…') : c('Desconectar de Career Stack', 'Disconnect from Career Stack')}</Button></div>
        {error && error !== 'AI_DISABLED' && error !== 'NOT_FOUND' && <Notice tone="error">{connectionError(error, locale)}</Notice>}
      </div>}
      {feedback === 'disconnected' && <Notice tone="success">{feedbackMessages.disconnected}</Notice>}
    </> : <>
      {error && <Notice tone="error" actions={!state ? <Button variant="secondary" disabled={busy} onClick={() => setReload((value) => value + 1)}>{c('Reintentar', 'Try again')}</Button> : undefined}>{connectionError(error, locale)}</Notice>}
      {feedback && <Notice tone={feedback === 'login-failed' || feedback === 'login-expired' ? 'warning' : 'success'}>{feedbackMessages[feedback]}</Notice>}
      {state && <>
        <div className={styles.state}>
          <h3>{connected ? c('Tu cuenta está lista', 'Your account is ready') : waitingId ? c('Continúa en la página oficial', 'Continue on the official website') : observed?.sessionState === 'SIGNED_IN' ? c('Cuenta detectada · falta conectarla', 'Account detected · not connected yet') : c('Conecta Codex', 'Connect Codex')}</h3>
          {observed?.sessionState === 'NOT_INSTALLED' && <p>{c('Para conectar tu cuenta, primero instala la aplicación oficial de Codex en este equipo. Después vuelve aquí.', 'To connect your account, first install the official Codex application on this device. Then come back here.')} <a href={INSTALL_URL} target="_blank" rel="noopener noreferrer">{c('Ver cómo instalar Codex (abre otra pestaña)', 'See how to install Codex (opens a new tab)')}</a></p>}
          {observed?.sessionState === 'UNSUPPORTED' && <p>{c('La configuración de Codex no es compatible. Inicia sesión con tu cuenta de ChatGPT en la aplicación oficial y actualiza Codex si es necesario. Después vuelve a comprobar la conexión.', 'This Codex setup is not supported. Sign in with your ChatGPT account in the official application and update Codex if needed. Then check the connection again.')} <a href={INSTALL_URL} target="_blank" rel="noopener noreferrer">{c('Consultar las instrucciones oficiales', 'View official instructions')}</a></p>}
          {observed?.sessionState === 'UNAVAILABLE' && <p>{c('No pudimos consultar Codex en este equipo. Comprueba que esté instalado y vuelve a intentarlo.', 'We could not check Codex on this device. Check that it is installed and try again.')}</p>}
          {observed?.sessionState === 'SIGNED_OUT' && !waitingId && <p>{c('Codex está instalado. Inicia sesión con tu cuenta para continuar.', 'Codex is installed. Sign in with your account to continue.')}</p>}
          {!observed && !waitingId && <p>{c('Comprueba si Codex está instalado y qué cuenta tiene abierta en este equipo.', 'Check whether Codex is installed and which account is signed in on this device.')}</p>}
          {observed?.sessionState === 'SIGNED_IN' && <dl className={styles.account}>
            <div><dt>{c('Cuenta de Codex', 'Codex account')}</dt><dd>{observed.maskedIdentity || c('Sesión iniciada · identidad no disponible', 'Signed in · identity unavailable')}</dd></div>
            <div><dt>{c('Plan', 'Plan')}</dt><dd>{observed.plan ? planLabel(observed.plan, locale) : c('Actualiza la conexión para consultarlo', 'Refresh the connection to check')}</dd></div>
          </dl>}
          {waitingId ? <>
            <p>{c('Abre el enlace e inicia sesión. Esta página comprobará el resultado mientras permanezca abierta.', 'Open the link and sign in. This page will check the result while it remains open.')}</p>
            <div className={styles.actions}>
              {loginUrl && <a className="button button-primary" href={loginUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{c('Abrir inicio de sesión de Codex', 'Open Codex sign-in')}</a>}
              <Button variant="secondary" disabled={busy} onClick={() => void perform('cancel')}>{action === 'cancel' ? c('Cancelando…', 'Cancelling…') : c('Cancelar inicio de sesión', 'Cancel sign-in')}</Button>
            </div>
            <p className={styles.hint}>{c('El enlace se abre en otra pestaña. Al terminar, vuelve aquí para autorizar la cuenta.', 'The link opens in a new tab. When you finish, return here to authorize the account.')}</p>
            {pollFailed && <Notice tone="warning" actions={<Button variant="secondary" onClick={() => { setPollFailed(false); setPollRetry((value) => value + 1); }}>{c('Comprobar inicio de sesión', 'Check sign-in')}</Button>}>{connectionError('AI_LOGIN_POLL_FAILED', locale)}</Notice>}
          </> : <div className={styles.actions}>
            {canAuthorize && <Button disabled={busy} onClick={() => void perform('authorize')}>{action === 'authorize' ? c('Conectando…', 'Connecting…') : c('Usar esta cuenta', 'Use this account')}</Button>}
            {observed?.sessionState === 'SIGNED_OUT' && <Button disabled={busy} onClick={() => void perform('login')}>{action === 'login' ? c('Preparando inicio de sesión…', 'Preparing sign-in…') : c('Iniciar sesión en Codex', 'Sign in to Codex')}</Button>}
            <Button variant={observed ? 'secondary' : 'primary'} disabled={busy} onClick={() => void perform('inspect')}>{action === 'inspect' ? c('Actualizando conexión…', 'Refreshing connection…') : observed ? c('Actualizar conexión', 'Refresh connection') : c('Comprobar Codex', 'Check Codex')}</Button>
            {state.connection?.authorized && <Button variant="quiet" disabled={busy} onClick={() => void perform('disconnect')}>{action === 'disconnect' ? c('Desconectando…', 'Disconnecting…') : c('Desconectar de Career Stack', 'Disconnect from Career Stack')}</Button>}
          </div>}
          {observed && !waitingId && <p className={styles.hint}>{c('Actualizar conexión vuelve a consultar la cuenta abierta en Codex y su consumo. Úsalo si cambiaste de cuenta o quieres ver datos recientes.', 'Refresh connection checks the account signed in to Codex and its usage again. Use it after switching accounts or to see updated information.')}</p>}
          {!connected && <p className={styles.hint}>{c('Conectar la cuenta no envía tu perfil ni inicia tareas. Podrás revisar los datos antes de usar la IA; el análisis automático requiere una autorización aparte.', 'Connecting your account does not send your profile or start tasks. You can review the data before using AI; automatic analysis requires separate permission.')}</p>}
          {connected && <p className={styles.hint}>{c('Cada tarea puede consumir cuota de tu plan. Conectar la cuenta no activa el análisis automático ni envía solicitudes.', 'Each task may use your plan’s quota. Connecting the account does not turn on automatic analysis or submit applications.')}</p>}
        </div>
        {observed?.sessionState === 'SIGNED_IN' && <UsageDetails usage={observed.usage} locale={locale}/>}
      </>}
    </>}
    <details className={styles.disclosure}>
      <summary>{c('Qué datos se comparten', 'Which data is shared')}</summary>
      <div className={styles.detailsBody}>
        <ul className={styles.privacy}>
          <li>{c('Tu espacio se guarda en este equipo. Cuando autorizas una tarea de IA, los datos necesarios se envían a OpenAI para procesarla.', 'Your workspace is stored on this device. When you authorize an AI task, the necessary data is sent to OpenAI for processing.')}</li>
          <li>{c('El inicio de sesión lo gestiona Codex. Career Stack no te pide tu contraseña ni guarda una copia de sus credenciales.', 'Codex manages sign-in. Career Stack does not ask for your password or keep a copy of its credentials.')}</li>
          <li>{c('Desconectar detiene el uso de esa cuenta en Career Stack. No cierra la sesión de Codex en otras aplicaciones.', 'Disconnecting stops use of that account in Career Stack. It does not sign you out of Codex in other applications.')}</li>
          <li>{c('La IA prepara sugerencias que tú revisas. La autorización para enviar solicitudes se gestiona por separado.', 'AI prepares suggestions for you to review. Permission to submit applications is managed separately.')}</li>
        </ul>
        {observed?.version && <p className={styles.hint}>{c('Versión de Codex detectada:', 'Detected Codex version:')} {observed.version}</p>}
      </div>
    </details>
  </section>;
}
