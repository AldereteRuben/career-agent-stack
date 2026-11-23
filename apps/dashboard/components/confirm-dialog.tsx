'use client';

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { useLocale } from '@/lib/i18n';
import { Button } from './ui';

export type ConfirmRequest = {
  /** The question. Say what happens and what is kept, as the native dialogs did. */
  message: string;
  /** Short visible heading; defaults to a generic "Confirm" in the current language. */
  title?: string;
  /** Label of the button that goes ahead, e.g. "Archive". Defaults to "Continue". */
  confirmLabel?: string;
  /** Label of the button that keeps things as they are. Defaults to "Cancel". */
  cancelLabel?: string;
  /** `danger` for deleting or discarding: the button is red and keyboard focus starts on the safe choice. */
  tone?: 'default' | 'danger';
};

type Pending = ConfirmRequest & { resolve: (accepted: boolean) => void; id: number };

const ConfirmContext = createContext<((request: ConfirmRequest) => Promise<boolean>) | null>(null);

/**
 * Asks before an action with an accessible modal instead of `window.confirm`: it follows the interface language and
 * style, keeps focus inside while open (native `<dialog>` modal), closes with Escape as a cancellation, and returns
 * focus to the control that opened it. Resolves true only when the person chooses the confirm button.
 *
 * Synchronous guards (leaving a page with unsaved work) still use the browser's dialog, because the browser needs the
 * answer before it continues.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  // The open request is queue[0]; later requests wait their turn. Kept in a ref so resolving never runs inside a
  // state updater (StrictMode calls updaters twice).
  const queue = useRef<Pending[]>([]);
  const [current, setCurrent] = useState<Pending | null>(null);
  const nextId = useRef(0);
  const confirm = useCallback((request: ConfirmRequest) => new Promise<boolean>((resolve) => {
    queue.current.push({ ...request, resolve, id: ++nextId.current });
    setCurrent(queue.current[0]!);
  }), []);
  const settle = useCallback((accepted: boolean) => {
    queue.current.shift()?.resolve(accepted);
    setCurrent(queue.current[0] ?? null);
  }, []);
  // A question belongs to the page that asked it: leaving that page (Back, a link) answers "no" to everything open.
  const pathname = usePathname();
  useEffect(() => () => {
    const open = queue.current.splice(0);
    for (const request of open) request.resolve(false);
    setCurrent(null);
  }, [pathname]);
  return <ConfirmContext.Provider value={confirm}>{children}{current && <ConfirmDialog key={current.id} request={current} onSettle={settle}/>}</ConfirmContext.Provider>;
}

export function useConfirm() {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error('useConfirm must be used within ConfirmProvider');
  return confirm;
}

function ConfirmDialog({ request, onSettle }: { request: ConfirmRequest; onSettle: (accepted: boolean) => void }) {
  const { locale } = useLocale(); const c = (es: string, en: string) => locale === 'es' ? es : en;
  const dialog = useRef<HTMLDialogElement>(null); const cancelButton = useRef<HTMLButtonElement>(null); const confirmButton = useRef<HTMLButtonElement>(null);
  const titleId = useId(); const messageId = useId();
  const answered = useRef(false);
  const danger = request.tone === 'danger';
  const answer = (accepted: boolean) => { if (answered.current) return; answered.current = true; dialog.current?.close(); onSettle(accepted); };
  useEffect(() => {
    const element = dialog.current; if (!element) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!element.open) element.showModal();
    (danger ? cancelButton : confirmButton).current?.focus();
    return () => { if (element.open) element.close(); if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, [danger]);
  // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- backdrop click; Escape is the keyboard equivalent
  return <dialog ref={dialog} className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={messageId}
    // Escape fires `cancel`; treat it as choosing the safe option.
    onCancel={(event) => { event.preventDefault(); answer(false); }}
    // A click on the backdrop lands on the dialog element itself. Its keyboard equivalent is Escape (onCancel above).
    onClick={(event) => { if (event.target === event.currentTarget) answer(false); }}>
    <div className="confirm-dialog-body">
      <h2 id={titleId}>{request.title ?? c('Confirmar', 'Confirm')}</h2>
      <p id={messageId}>{request.message}</p>
      <div className="confirm-dialog-actions">
        <Button ref={cancelButton} type="button" variant="secondary" onClick={() => answer(false)}>{request.cancelLabel ?? c('Cancelar', 'Cancel')}</Button>
        <Button ref={confirmButton} type="button" variant={danger ? 'danger' : 'primary'} onClick={() => answer(true)}>{request.confirmLabel ?? c('Continuar', 'Continue')}</Button>
      </div>
    </div>
  </dialog>;
}
