import Link from 'next/link';
import { useId, type ComponentProps, type ReactNode, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger';

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) { return <section className={`card ${className}`}>{children}</section>; }

export function Button({ children, variant = 'primary', className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) { return <button className={`button button-${variant} ${className}`} {...props}>{children}</button>; }

/** A navigation link styled as a button. Use instead of wrapping <Button> in <Link> (nested interactive elements). */
export function ButtonLink({ variant = 'primary', className = '', ...props }: ComponentProps<typeof Link> & { variant?: ButtonVariant }) { return <Link className={`button button-${variant} ${className}`} {...props}/>; }

/**
 * Shared label + control + optional hint wiring. The hint is linked with
 * aria-describedby so it is announced as a description, not folded into the
 * accessible name as it was when the label wrapped the whole field.
 */
function useFieldIds(id: string | undefined, describedBy: string | undefined, hint: string | undefined) {
  const generated = useId();
  const controlId = id ?? `field-${generated}`;
  const hintId = hint ? `${controlId}-hint` : undefined;
  return { controlId, hintId, describedBy: [describedBy, hintId].filter(Boolean).join(' ') || undefined };
}

export function Field({ label, hint, id, className = '', 'aria-describedby': ariaDescribedBy, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  const ids = useFieldIds(id, ariaDescribedBy, hint);
  return <div className={`field ${className}`}><label htmlFor={ids.controlId}>{label}</label><input id={ids.controlId} aria-describedby={ids.describedBy} {...props}/>{hint && <small id={ids.hintId}>{hint}</small>}</div>;
}

export function SelectField({ label, hint, id, className = '', children, 'aria-describedby': ariaDescribedBy, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { label: string; hint?: string; children: ReactNode }) {
  const ids = useFieldIds(id, ariaDescribedBy, hint);
  return <div className={`field ${className}`}><label htmlFor={ids.controlId}>{label}</label><select id={ids.controlId} aria-describedby={ids.describedBy} {...props}>{children}</select>{hint && <small id={ids.hintId}>{hint}</small>}</div>;
}

export function TextareaField({ label, hint, id, className = '', 'aria-describedby': ariaDescribedBy, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; hint?: string }) {
  const ids = useFieldIds(id, ariaDescribedBy, hint);
  return <div className={`field ${className}`}><label htmlFor={ids.controlId}>{label}</label><textarea id={ids.controlId} aria-describedby={ids.describedBy} {...props}/>{hint && <small id={ids.hintId}>{hint}</small>}</div>;
}

export function Tag({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'green' | 'amber' | 'red' | 'blue' }) { return <span className={`tag tag-${tone}`}>{children}</span>; }

/**
 * Message box with an optional row of actions. The message and actions share one content column next to the icon, so
 * buttons wrap below the text on narrow screens instead of becoming side-by-side flex columns. Reading and tab order
 * stay message first, then actions. `role` defaults to alert for errors and status otherwise; pass null for static text.
 */
export function Notice({ children, tone = 'info', actions, role }: { children: ReactNode; tone?: 'info' | 'success' | 'warning' | 'error'; actions?: ReactNode; role?: 'alert' | 'status' | null }) {
  const liveRole = role === undefined ? (tone === 'error' ? 'alert' : 'status') : role ?? undefined;
  return <div className={`notice notice-${tone}`} role={liveRole}><div className="notice-content"><div className="notice-message">{children}</div>{actions && <div className="notice-actions">{actions}</div>}</div></div>;
}

export function Empty({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) { return <div className="empty"><div className="empty-orbit" aria-hidden="true"><Icon name="sparkle" size={18}/></div><h3>{title}</h3><p>{detail}</p>{action}</div>; }

export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    home: <><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="5" rx="1.5"/><rect x="13" y="10" width="8" height="11" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/></>,
    briefcase: <><rect x="3" y="7" width="18" height="14" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18M10 12v2h4v-2"/></>,
    file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h8"/></>,
    user: <><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></>,
    building: <><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 7h1m4 0h1m-6 4h1m4 0h1m-6 4h1m4 0h1M10 21v-3h4v3"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="m19.4 15 .1.1 1.2 1-1.4 2.4-1.5-.6a8 8 0 0 1-1.7 1l-.3 1.6h-2.8l-.3-1.6a8 8 0 0 1-1.7-1l-1.5.6-1.4-2.4 1.2-1a7 7 0 0 1 0-2l-1.2-1 1.4-2.4 1.5.6a8 8 0 0 1 1.7-1l.3-1.6h2.8l.3 1.6a8 8 0 0 1 1.7 1l1.5-.6 1.4 2.4-1.2 1a7 7 0 0 1-.1 1.9Z"/></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
    arrow: <><path d="M5 12h14M13 6l6 6-6 6"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    close: <><path d="m18 6-12 12M6 6l12 12"/></>,
    plus: <><path d="M12 5v14M5 12h14"/></>,
    menu: <><path d="M4 6h16M4 12h16M4 18h16"/></>,
    sparkle: <><path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z"/><path d="m19 16 .8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16Z"/></>,
    shield: <><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z"/><path d="m9 12 2 2 4-4"/></>,
    download: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[name] ?? paths.sparkle}</svg>;
}
