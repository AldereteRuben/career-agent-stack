'use client';

import { Brand, BrandMark } from '@/components/brand';
import { RELEASE_VERSION } from '@career/domain';


import Link from 'next/link';
import { clearSessionDrafts } from '@/lib/session-draft';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useLocale } from '@/lib/i18n';
import { Button, Icon, Notice } from './ui';

const links = [
  { href: '/', label: 'Inicio', icon: 'home', hint: 'Qué hacer ahora' },
  { href: '/searches', label: 'Buscar empleo', icon: 'search', hint: 'Búsquedas automáticas' },
  { href: '/profile', label: 'Mi perfil', icon: 'user', hint: 'Tus datos y experiencia' },
  { href: '/jobs', label: 'Ofertas encontradas', icon: 'search', hint: 'Todas tus ofertas' },
  { href: '/documents', label: 'Mis CV', icon: 'file', hint: 'Preparar y descargar PDF' },
  { href: '/applications', label: 'Mis solicitudes', icon: 'briefcase', hint: 'Preparar, enviar y dar seguimiento' },
  { href: '/boards', label: 'Empresas que sigo', icon: 'building', hint: 'Consultar sus ofertas · opcional' },
  { href: '/settings', label: 'Ajustes y privacidad', icon: 'settings', hint: 'Tus datos y configuración' },
];

/** Keep in sync with the drawer breakpoint in globals.css. */
const DRAWER_QUERY = '(max-width: 850px)';

const isActive = (href: string, pathname: string) => pathname === href || (href !== '/' && pathname.startsWith(`${href}/`));

function useMediaQuery(query: string) {
  const subscribe = useCallback((onChange: () => void) => {
    const list = window.matchMedia(query);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
}

const focusableSelector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

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
    const items = Array.from(sidebarRef.current.querySelectorAll<HTMLElement>(focusableSelector));
    if (!items.length) return;
    const first = items[0]!; const last = items[items.length - 1]!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  const current = pathname === '/preparations' ? { label: locale === 'es' ? 'Candidaturas preparadas' : 'Prepared applications' } : pathname === '/start' ? { label: locale === 'es' ? 'Primeros pasos' : 'Getting started' } : links.find((link) => isActive(link.href, pathname)) ?? links[0]!;
  const drawerLabel = locale === 'en' ? 'Main menu' : 'Menú principal';

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
        <Link href="/" className="brand"><Brand/></Link>
        <button type="button" className="drawer-close" onClick={closeMenu}><Icon name="close" size={20}/><span className="sr-only">{t("Cerrar menú")}</span></button>
      </div>
      <nav className="main-nav" aria-label={t("Navegación principal")}>
        {links.map((link) => {
          const active = isActive(link.href, pathname);
          return <Link key={link.href} href={link.href} onClick={closeMenu} aria-current={active ? 'page' : undefined} className={`nav-link ${active ? 'nav-active' : ''}`}><Icon name={link.icon} size={20}/><span className="nav-copy"><span>{t(link.label)}</span><small>{t(link.hint)}</small></span></Link>;
        })}
      </nav>
      <div className="sidebar-spacer"/>
      <div className="local-card"><Icon name="shield" size={18}/><div><strong>{t("Solo en este equipo")}</strong><p>{t("Tú decides cuándo compartir datos.")}</p></div></div>
      <div className="profile-chip"><span className="avatar" aria-hidden="true">{t("T")}</span><span><strong>{t("Tu espacio")}</strong><small>{t("Sesión local")}</small></span><button type="button" className="signout" disabled={signingOut} onClick={() => void signOut()}>{signingOut ? (locale === 'es' ? 'Saliendo…' : 'Signing out…') : t("Salir")}</button></div>{sessionError && <Notice tone="error">{sessionError}</Notice>}
    </aside>
    {drawerOpen && <div className="mobile-scrim" aria-hidden="true" onClick={closeMenu}/>}
    <div className="main-column" inert={drawerOpen}>
      <header className="topbar">
        <button ref={menuButtonRef} type="button" className="mobile-menu" aria-expanded={drawerOpen} aria-controls="app-sidebar" onClick={() => setMenuOpen(true)}><Icon name="menu" size={22}/><span className="sr-only">{t("Abrir menú")}</span></button>
        <div className="breadcrumbs"><span className="crumb-root">{t("Tu espacio")}</span><span className="crumb-slash" aria-hidden="true">/</span><span className="crumb-current">{t(current.label)}</span></div>
        <div className="topbar-right"><span className="local-indicator"><Icon name="shield" size={16}/><span>{t("Local y privado")}</span></span><LanguageSwitch/></div>
      </header>
      <main id="main-content" className="page-wrap" tabIndex={-1}>{children}</main>
      <footer className="app-footer"><span>{t("Career Stack")} <span className="footer-version">{RELEASE_VERSION}</span></span><Link href="/settings">{t("Privacidad y control")} <Icon name="arrow" size={16}/></Link></footer>
    </div>
  </div>;
}

export function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: ReactNode; description?: string; action?: ReactNode }) {
  return <div className="page-header"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1>{description && <p>{description}</p>}</div>{action && <div className="page-header-action">{action}</div>}</div>;
}
