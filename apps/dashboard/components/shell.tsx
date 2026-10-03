'use client';

import Link from 'next/link';
import { clearSessionDrafts } from '@/lib/session-draft';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { useLocale } from '@/lib/i18n';
import { Icon } from './ui';

const links = [
  { href: '/', label: 'Inicio', icon: 'home', hint: 'Qué hacer ahora' },
  { href: '/profile', label: 'Mi perfil', icon: 'user', hint: 'Tus datos y experiencia' },
  { href: '/jobs', label: 'Ofertas guardadas', icon: 'search', hint: 'Empleos que te interesan' },
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
  const { t } = useLocale();
  const router = useRouter(); const [state, setState] = useState<'loading' | 'ready'>('loading');
  useEffect(() => { api<{ authenticated: boolean }>('/session').then((session) => { if (!session.authenticated) router.replace('/login'); else setState('ready'); }).catch(() => router.replace('/login')); }, [router]);
  if (state === 'loading') return <div className="loading-screen" role="status"><span className="brand-mark" aria-hidden="true">{t("c")}</span><p>{t("Abriendo tu espacio privado…")}</p></div>;
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
  const signOut = async () => { clearSessionDrafts(); await api('/session', { method: 'DELETE' }).catch(() => undefined); router.replace('/login'); };

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

  const current = links.find((link) => isActive(link.href, pathname)) ?? links[0]!;
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
        <Link href="/" className="brand"><span className="brand-mark" aria-hidden="true">{t("c")}</span><span>{t("career")}<span className="brand-light">{t("stack")}</span><small>{t("tu espacio de carrera")}</small></span></Link>
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
      <button type="button" className="profile-chip" onClick={signOut}><span className="avatar" aria-hidden="true">{t("T")}</span><span><strong>{t("Tu espacio")}</strong><small>{t("Sesión local")}</small></span><span className="signout">{t("Salir")}</span></button>
    </aside>
    {drawerOpen && <div className="mobile-scrim" aria-hidden="true" onClick={closeMenu}/>}
    <div className="main-column" inert={drawerOpen}>
      <header className="topbar">
        <button ref={menuButtonRef} type="button" className="mobile-menu" aria-expanded={drawerOpen} aria-controls="app-sidebar" onClick={() => setMenuOpen(true)}><Icon name="menu" size={22}/><span className="sr-only">{t("Abrir menú")}</span></button>
        <div className="breadcrumbs"><span className="crumb-root">{t("Tu espacio")}</span><span className="crumb-slash" aria-hidden="true">/</span><span className="crumb-current">{t(current.label)}</span></div>
        <div className="topbar-right"><span className="local-indicator"><Icon name="shield" size={16}/><span>{t("Local y privado")}</span></span><LanguageSwitch/></div>
      </header>
      <main id="main-content" className="page-wrap" tabIndex={-1}>{children}</main>
      <footer className="app-footer"><span>{t("Career Stack")} <span className="footer-version">{"v0.3.1"}</span></span><Link href="/settings">{t("Privacidad y control")} <Icon name="arrow" size={16}/></Link></footer>
    </div>
  </div>;
}

export function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: ReactNode; description: string; action?: ReactNode }) {
  return <div className="page-header"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>{action && <div className="page-header-action">{action}</div>}</div>;
}
