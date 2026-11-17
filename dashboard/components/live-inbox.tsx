'use client';

import {useEffect, useRef, useState} from 'react';
import type {InboxPayload} from '../lib/types';
import {InboxShell} from './inbox-shell';

export function LiveInbox({
  contactKey,
  contactLimit,
  messageLimit,
  initial,
  sendControls = 'off'
}: {
  contactKey?: string;
  contactLimit: number;
  messageLimit: number;
  initial: InboxPayload;
  sendControls?: 'off' | 'unconfigured' | 'locked' | 'ready';
}) {
  const [data, setData] = useState(initial);
  const revision = useRef(initial.revision);
  const viewKey = `${contactKey || ''}|${contactLimit}|${messageLimit}`;
  const opened = useRef(viewKey);

  useEffect(() => {
    if (opened.current === viewKey) return;
    opened.current = viewKey;
    revision.current = initial.revision;
    setData(initial);
  }, [viewKey, initial]);

  useEffect(() => {
    let stopped = false;
    let pending = false;
    const params = new URLSearchParams();
    if (contactKey) params.set('contact', contactKey);
    params.set('contactLimit', String(contactLimit));
    params.set('messageLimit', String(messageLimit));
    const query = params.toString();

    async function pull() {
      if (stopped || pending || document.visibilityState === 'hidden') return;
      pending = true;
      try {
        const probe = await fetch('/api/inbox?probe=1', {cache: 'no-store'});
        if (!probe.ok) throw new Error('probe');
        const probed = await probe.json() as {revision?: string};
        if (!probed.revision) throw new Error('probe');
        if (probed.revision !== revision.current) {
          const full = await fetch(`/api/inbox?${query}`, {cache: 'no-store'});
          if (!full.ok) throw new Error('inbox');
          const next = await full.json() as InboxPayload;
          if (!stopped && next.revision) {
            revision.current = next.revision;
            setData(next);
          }
        }
        if (!stopped) window.dispatchEvent(new CustomEvent('inbox-sync', {detail: {ok: true}}));
      } catch {
        if (!stopped) window.dispatchEvent(new CustomEvent('inbox-sync', {detail: {ok: false}}));
      } finally {
        pending = false;
      }
    }

    const timer = window.setInterval(() => { void pull(); }, 2000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void pull();
    };
    document.addEventListener('visibilitychange', onVisible);
    const onRefresh = () => { void pull(); };
    window.addEventListener('inbox-refresh', onRefresh);
    void pull();
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('inbox-refresh', onRefresh);
    };
  }, [contactKey, contactLimit, messageLimit]);

  return (
    <InboxShell
      contacts={data.contacts}
      total={data.total}
      enabled={data.enabled}
      paused={data.paused}
      removed={data.removed}
      hasMoreContacts={data.hasMoreContacts}
      contactLimit={data.contactLimit}
      messageLimit={data.messageLimit}
      thread={data.thread}
      sendControls={sendControls}
    />
  );
}
