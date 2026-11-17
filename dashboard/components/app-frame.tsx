'use client';

import {useEffect, useState, type ReactNode} from 'react';

function relativeUpdate(ms: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 10) return 'Updated just now';
  if (seconds < 60) return `Updated ${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Updated ${minutes}m ago`;
  return `Updated ${new Intl.DateTimeFormat('en-US', {hour: 'numeric', minute: '2-digit'}).format(ms)}`;
}

export function AppFrame({children}: {children: ReactNode}) {
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [breath, setBreath] = useState(false);
  const [, setClock] = useState(0);

  useEffect(() => {
    const clock = window.setInterval(() => setClock((value) => value + 1), 1000);
    return () => window.clearInterval(clock);
  }, []);

  useEffect(() => {
    const onSync = (event: Event) => {
      const ok = Boolean((event as CustomEvent<{ok?: boolean}>).detail?.ok);
      if (ok) {
        setFailed(false);
        setUpdatedAt(Date.now());
      } else {
        setFailed(true);
      }
    };
    window.addEventListener('inbox-sync', onSync);
    return () => window.removeEventListener('inbox-sync', onSync);
  }, []);

  useEffect(() => {
    let timer = 0;
    const onDraft = () => {
      setBreath(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setBreath(false), 1200);
    };
    window.addEventListener('inbox-draft', onDraft);
    return () => {
      window.removeEventListener('inbox-draft', onDraft);
      window.clearTimeout(timer);
    };
  }, []);

  const updated = updatedAt ? relativeUpdate(updatedAt) : 'Waiting for first refresh';

  return (
    <>
      <a className="skip-link" href="#content">Skip to content</a>
      <div className="app-frame">
      <header className="app-header">
        <p className="brand-lockup">
          <span className="mark" aria-hidden="true">//</span>
          <span className="brand">RizzBot</span>
        </p>
        <span className="header-rule" aria-hidden="true" />
        <p className="inbox-tab">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16v12H4z" fill="none" stroke="currentColor" strokeWidth="1.8"/><path d="M4 7l8 6 8-6" fill="none" stroke="currentColor" strokeWidth="1.8"/></svg>
          Conversations
        </p>
        <p className={breath ? 'local-pill pill-breath' : 'local-pill'}><span className="local-dot" aria-hidden="true" />Read-only · approve in WhatsApp</p>
        <p className="updated">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="1.8"/><path d="M12 8v5l3 2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
          {failed ? 'Refresh failed' : updated}
        </p>
      </header>
      <p className="refresh-status" role="status">{failed ? 'Temporarily unavailable. The last attempt to refresh failed.' : ''}</p>
      {children}
      </div>
    </>
  );
}
