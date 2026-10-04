'use client';

import { Brand, BrandMark } from '@/components/brand';
import { RELEASE_VERSION } from '@career/domain';


import Link from 'next/link';
import { clearSessionDrafts } from '@/lib/session-draft';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useLocale } from '@/lib/i18n';
import { Button, Icon, Notice } from './ui';

type Copy = { es: string; en: string };
type NavLink = { key: string; href: string; label: Copy; icon: string; hint?: Copy };

/** The three everyday destinations. Everything else lives under "Profile and tools". */
const primaryLinks: NavLink[] = [
  { key: 'searches', href: '/searches', label: { es: 'Buscar empleo', en: 'Find jobs' }, icon: 'search', hint: { es: 'Búsquedas automáticas', en: 'Automatic searches' } },
  { key: 'saved', href: '/jobs?scope=favorites', label: { es: 'Guardadas', en: 'Saved jobs' }, icon: 'check', hint: { es: 'Ofertas que te interesan', en: 'Jobs you want to keep' } },
  { key: 'applications', href: '/applications', label: { es: 'Mis solicitudes', en: 'My applications' }, icon: 'briefcase', hint: { es: 'Preparar, enviar y dar seguimiento', en: 'Prepare, apply, and track' } },
];

const secondaryLinks: NavLink[] = [
  { key: 'profile', href: '/profile', label: { es: 'Mi perfil', en: 'My profile' }, icon: 'user' },
  { key: 'documents', href: '/documents', label: { es: 'Mis CV', en: 'My resumes' }, icon: 'file' },
  { key: 'jobs', href: '/jobs', label: { es: 'Todas las ofertas', en: 'All jobs' }, icon: 'search' },
  { key: 'boards', href: '/boards', label: { es: 'Empresas que sigo', en: 'Companies I follow' }, icon: 'building' },
  { key: 'settings', href: '/settings', label: { es: 'Ajustes y privacidad', en: 'Settings and privacy' }, icon: 'settings' },
  { key: 'overview', href: '/overview', label: { es: 'Resumen', en: 'Overview' }, icon: 'home' },
];

const toolsLabel: Copy = { es: 'Perfil y herramientas', en: 'Profile and tools' };
const jobDetailLabel: Copy = { es: 'Detalle de la oferta', en: 'Job details' };

type Route = { active: string | null; crumbs: Copy[] };

const within = (pathname: string, base: string) => pathname === base || pathname.startsWith(`${base}/`);
const linkLabel = (key: string) => [...primaryLinks, ...secondaryLinks].find((link) => link.key === key)!.label;

/** Which jobs list a /jobs URL shows: saved jobs are their own destination, every other scope is "All jobs". */
const jobsListKey = (search: URLSearchParams | null) => search?.get('scope') === 'favorites' ? 'saved' : 'jobs';

/** Section a job detail page was opened from, read from its bounded same-origin `returnTo`. */
function jobOrigin(search: URLSearchParams | null): string | null {
  const returnTo = search?.get('returnTo');
  if (!returnTo || !returnTo.startsWith('/') || returnTo.startsWith('//')) return null;
  try {
    const url = new URL(returnTo, 'http://career.local');
    if (within(url.pathname, '/searches')) return 'searches';
    if (url.pathname === '/jobs') return jobsListKey(url.searchParams);
  } catch { /* An unreadable origin selects nothing. */ }
  return null;
}

/** Resolve the highlighted destination and breadcrumb from the path and, when available, the query. */
function resolveRoute(pathname: string, search: URLSearchParams | null): Route {
  // Before the query is read, /jobs could be saved or all jobs: select neither.
  if (pathname === '/jobs' && !search) return { active: null, crumbs: [{ es: 'Ofertas', en: 'Jobs' }] };
  if (pathname === '/jobs') { const key = jobsListKey(search); return { active: key, crumbs: [linkLabel(key)] }; }
  if (pathname.startsWith('/jobs/')) { const origin = jobOrigin(search); return { active: origin, crumbs: origin ? [linkLabel(origin), jobDetailLabel] : [jobDetailLabel] }; }
  if (pathname === '/preparations') return { active: null, crumbs: [{ es: 'Candidaturas preparadas', en: 'Prepared applications' }] };
  if (pathname === '/start') return { active: null, crumbs: [{ es: 'Primeros pasos', en: 'Getting started' }] };
  const primary = primaryLinks.find((link) => link.key !== 'saved' && within(pathname, link.href));
  if (primary) return { active: primary.key, crumbs: [primary.label] };
  const secondary = secondaryLinks.find((link) => link.key !== 'jobs' && within(pathname, link.href));
  if (secondary) return { active: secondary.key, crumbs: [toolsLabel, secondary.label] };
  return { active: null, crumbs: [primaryLinks[0]!.label] };
}

/** Keep in sync with the drawer breakpoint in globals.css. */
const DRAWER_QUERY = '(max-width: 850px)';

function useMediaQuery(query: string) {
  const subscribe = useCallback((onChange: () => void) => {
    const list = window.matchMedia(query);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
}

const focusableSelector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Focusable controls a keyboard user can actually reach: skips collapsed, hidden and inert descendants. */
function reachableItems(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector)).filter((item) => {
    if (item.tabIndex < 0 || item.closest('[inert], [hidden]')) return false;
    return typeof item.checkVisibility === 'function' ? item.checkVisibility({ visibilityProperty: true }) : item.getClientRects().length > 0;
  });
}

export function WorkspaceGate({ children }: { children: ReactNode }) {
  const { t, locale } = useLocale();
  const router = useRouter(); const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    api<{ authenticated: boolean }>('/session', { signal: controller.signal }).then((session) => {
      if (controller.signal.aborted) return;
      if (!session.authenticated) router.replace('/login'); else setState('ready');
    }).catch((err) => {
      if (controller.signal.aborted) return;
      if (err instanceof ApiError && err.status === 401) router.replace('/login'); else setState('error');
    });
    return () => controller.abort();
  }, [router, attempt]);
  if (state === 'error') return <div className="loading-screen"><BrandMark/><p role="alert">{locale === 'es' ? 'No pudimos conectar con tu espacio. Comprueba que el servicio local esté encendido y vuelve a intentarlo.' : 'We could not connect to your workspace. Check that the local service is running and try again.'}</p><Button onClick={() => { setState('loading'); setAttempt((value) => value + 1); }}>{locale === 'es' ? 'Reintentar conexión' : 'Retry connection'}</Button></div>;
  if (state === 'loading') return <div className="loading-screen" role="status"><BrandMark/><p>{t("Abriendo tu espacio privado…")}</p></div>;
  return <>{children}</>;
}

/**
 * Language switch whose accessible name is its visible text (WCAG 2.5.3 Label in Name).
 * The button names the language it switches to, in that language.
 */
export function LanguageSwitch({ className = '' }: { className?: string }) {
  const { locale, setLocale } = useLocale();
  const next = locale === 'es' ? 'en' : 'es';
  return <button type="button" className={`language-toggle ${className}`} lang={next} onClick={() => setLocale(next)}>{next === 'en' ? 'English' : 'Español'}</button>;
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname(); const router = useRouter(); const { t, locale } = useLocale();
  const [menuOpen, setMenuOpen] = useState(false);
  const isDrawer = useMediaQuery(DRAWER_QUERY);
  const drawerOpen = isDrawer && menuOpen;
  const sidebarRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  const closeMenu = useCallback(() => setMenuOpen(false), []);
  // Start expanded on a secondary page so the current destination is visible from the first render.
  // /jobs depends on its query (saved or all jobs), so it is revealed after the query is read.
  const [toolsOpen, setToolsOpen] = useState(() => pathname !== '/jobs' && secondaryLinks.some((link) => link.key === resolveRoute(pathname, null).active));
  const revealTools = useCallback(() => setToolsOpen(true), []);
  const [signingOut, setSigningOut] = useState(false);
  const [sessionError, setSessionError] = useState('');
  const signOut = async () => {
    if (signingOut || !window.confirm(locale === 'es' ? '¿Cerrar sesión? Los borradores sin guardar de esta pestaña se perderán. Tus datos guardados se conservan.' : 'Sign out? Unsaved drafts in this tab will be lost. Your saved data is kept.')) return;
    setSigningOut(true); setSessionError('');
    try { await api('/session', { method: 'DELETE' }); clearSessionDrafts(); router.replace('/login'); }
    catch (err) { setSessionError(errorMessage(err)); setSigningOut(false); }
  };

  // Close the drawer on navigation and when the viewport grows past the drawer breakpoint.
  useEffect(() => { setMenuOpen(false); }, [pathname]);
  useEffect(() => { if (!isDrawer) setMenuOpen(false); }, [isDrawer]);

  // Move focus into the drawer when it opens; return it to the menu button when it closes.
  useEffect(() => {
    if (drawerOpen) {
      wasOpen.current = true;
      sidebarRef.current?.querySelector<HTMLElement>('.drawer-close')?.focus();
    } else if (wasOpen.current) {
      wasOpen.current = false;
      // Only return focus while the menu button is visible; after resizing to the
      // desktop layout the button is display:none and the sidebar is inline again.
      if (isDrawer) menuButtonRef.current?.focus();
      else {
        // The drawer close button is hidden on desktop; don't leave focus stranded on it or on <body>.
        const active = document.activeElement;
        if (!active || active === document.body || active.classList.contains('drawer-close')) sidebarRef.current?.querySelector<HTMLElement>('[aria-current="page"]')?.focus();
      }
    }
  }, [drawerOpen, isDrawer]);

  // Lock background scroll while the modal drawer is open.
  useEffect(() => {
    if (!drawerOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [drawerOpen]);

  const onDrawerKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!drawerOpen) return;
    if (event.key === 'Escape') { event.preventDefault(); closeMenu(); return; }
    if (event.key !== 'Tab' || !sidebarRef.current) return;
    const items = reachableItems(sidebarRef.current);
    if (!items.length) return;
    const first = items[0]!; const last = items[items.length - 1]!;
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.shiftKey && index <= 0) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (index === -1 || index === items.length - 1)) { event.preventDefault(); first.focus(); }
  };

  const drawerLabel = locale === 'en' ? 'Main menu' : 'Menú principal';
  const navProps = { pathname, locale, toolsOpen, onToggleTools: () => setToolsOpen((open) => !open), onRevealTools: revealTools, onNavigate: closeMenu };

  return <div className="app-layout">
    <a className="skip-link" href="#main-content" inert={drawerOpen}>{t('Saltar al contenido principal')}</a>
    <aside
      id="app-sidebar"
      ref={sidebarRef}
      className={`sidebar ${drawerOpen ? 'sidebar-open' : ''}`}
      inert={isDrawer && !menuOpen}
      onKeyDown={onDrawerKeyDown}
      {...(drawerOpen ? { role: 'dialog', 'aria-modal': true, 'aria-label': drawerLabel } : {})}
    >
      <div className="sidebar-top">
        <Link href="/searches" className="brand" onClick={closeMenu}><Brand/></Link>
        <button type="button" className="drawer-close" onClick={closeMenu}><Icon name="close" size={20}/><span className="sr-only">{t("Cerrar menú")}</span></button>
      </div>
      <Suspense fallback={<MainNav {...navProps} route={resolveRoute(pathname, null)}/>}><QueryAwareNav {...navProps}/></Suspense>
      <div className="sidebar-spacer"/>
      <div className="local-card"><Icon name="shield" size={18}/><div><strong>{t("Solo en este equipo")}</strong><p>{t("Tú decides cuándo compartir datos.")}</p></div></div>
      <div className="profile-chip"><span className="avatar" aria-hidden="true">{t("T")}</span><span><strong>{t("Tu espacio")}</strong><small>{t("Sesión local")}</small></span><button type="button" className="signout" disabled={signingOut} onClick={() => void signOut()}>{signingOut ? (locale === 'es' ? 'Saliendo…' : 'Signing out…') : t("Salir")}</button></div>{sessionError && <Notice tone="error">{sessionError}</Notice>}
    </aside>
    {drawerOpen && <div className="mobile-scrim" aria-hidden="true" onClick={closeMenu}/>}
    <div className="main-column" inert={drawerOpen}>
      <header className="topbar">
        <button ref={menuButtonRef} type="button" className="mobile-menu" aria-expanded={drawerOpen} aria-controls="app-sidebar" onClick={() => setMenuOpen(true)}><Icon name="menu" size={22}/><span className="sr-only">{t("Abrir menú")}</span></button>
        <Suspense fallback={<Breadcrumbs locale={locale} route={resolveRoute(pathname, null)}/>}><QueryAwareBreadcrumbs pathname={pathname} locale={locale}/></Suspense>
        <div className="topbar-right"><span className="local-indicator"><Icon name="shield" size={16}/><span>{t("Local y privado")}</span></span><LanguageSwitch/></div>
      </header>
      <main id="main-content" className="page-wrap" tabIndex={-1}>{children}</main>
      <footer className="app-footer"><span>{t("Career Stack")} <span className="footer-version">{RELEASE_VERSION}</span></span><Link href="/settings">{t("Privacidad y control")} <Icon name="arrow" size={16}/></Link></footer>
    </div>
  </div>;
}

type NavProps = { pathname: string; locale: string; toolsOpen: boolean; onToggleTools: () => void; onRevealTools: () => void; onNavigate: () => void };

/** Reads the query in its own Suspense boundary so pages without one still build and render. */
function QueryAwareNav(props: NavProps) {
  const search = useSearchParams(); const query = search.toString(); const { onNavigate } = props;
  // Query-only navigation (for example all jobs -> saved jobs) keeps the pathname, so close the drawer here too.
  const firstQuery = useRef(query);
  useEffect(() => { if (query !== firstQuery.current) { firstQuery.current = query; onNavigate(); } }, [query, onNavigate]);
  return <MainNav {...props} route={resolveRoute(props.pathname, search)}/>;
}

function QueryAwareBreadcrumbs({ pathname, locale }: { pathname: string; locale: string }) {
  const search = useSearchParams();
  return <Breadcrumbs locale={locale} route={resolveRoute(pathname, search)}/>;
}

function Breadcrumbs({ locale, route }: { locale: string; route: Route }) {
  const { t } = useLocale(); const say = (copy: Copy) => locale === 'en' ? copy.en : copy.es;
  return <div className="breadcrumbs"><span className="crumb-root">{t("Tu espacio")}</span>{route.crumbs.map((crumb, index) => <span key={crumb.es} className="crumb-part"><span className="crumb-slash" aria-hidden="true">/</span><span className={index === route.crumbs.length - 1 ? 'crumb-current' : 'crumb-root'}>{say(crumb)}</span></span>)}</div>;
}

function MainNav({ locale, route, toolsOpen, onToggleTools, onRevealTools, onNavigate }: NavProps & { route: Route }) {
  const { t } = useLocale(); const say = (copy: Copy) => locale === 'en' ? copy.en : copy.es;
  const toolsId = useId(); const toolsActive = secondaryLinks.some((link) => link.key === route.active);
  // Expose the current secondary destination instead of hiding it inside a collapsed group.
  useEffect(() => { if (toolsActive) onRevealTools(); }, [toolsActive, route.active, onRevealTools]);
  const item = (link: NavLink, compact = false) => {
    const active = route.active === link.key;
    return <Link key={link.key} href={link.href} onClick={onNavigate} aria-current={active ? 'page' : undefined} className={`nav-link ${compact ? 'nav-link-compact' : ''} ${active ? 'nav-active' : ''}`}><Icon name={link.icon} size={20}/><span className="nav-copy"><span>{say(link.label)}</span>{link.hint && <small>{say(link.hint)}</small>}</span></Link>;
  };
  return <><nav className="main-nav" aria-label={t("Navegación principal")}>
    {primaryLinks.map((link) => item(link))}
    </nav>
    <div className="nav-tools">
      <button type="button" className={`nav-tools-toggle ${toolsActive ? 'nav-tools-current' : ''}`} aria-expanded={toolsOpen} aria-controls={toolsId} onClick={onToggleTools}>
        <Icon name="settings" size={20}/><span className="nav-copy"><span>{say(toolsLabel)}</span></span><span className="nav-tools-chevron" aria-hidden="true"><Icon name="arrow" size={16}/></span>
      </button>
      <div id={toolsId} role="group" aria-label={say(toolsLabel)} className="nav-tools-list" hidden={!toolsOpen}>
        {secondaryLinks.map((link) => item(link, true))}
      </div>
    </div>
  </>;
}

export function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: ReactNode; description?: string; action?: ReactNode }) {
  return <div className="page-header"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1>{description && <p>{description}</p>}</div>{action && <div className="page-header-action">{action}</div>}</div>;
}
