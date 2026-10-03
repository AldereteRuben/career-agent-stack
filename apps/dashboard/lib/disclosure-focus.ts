'use client';

import { useEffect, useRef } from 'react';

/** Announce an opened inline form and return focus to its trigger when it closes. */
export function useDisclosureFocus(open: boolean) {
  const heading = useRef<HTMLHeadingElement>(null);
  const previous = useRef(false);
  const trigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open && !previous.current) {
      trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      heading.current?.focus();
    } else if (!open && previous.current) {
      if (trigger.current?.isConnected) trigger.current.focus();
      else heading.current?.focus();
    }
    previous.current = open;
  }, [open]);
  return heading;
}
