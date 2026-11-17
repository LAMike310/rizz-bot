'use client';

import Link from 'next/link';
import {useLayoutEffect, useRef, useState} from 'react';
import {DraftPanel} from './draft-panel';
import {MessageItem} from './message-item';
import {threadRows, type ThreadRow} from '../lib/rows';
import {draftOpensOnLoad} from '../lib/status';
import {dayText} from '../lib/time';
import type {ConversationEvent} from '../lib/types';

const memory = new Map<string, {distance: number; following: boolean}>();

function rowStamp(row: ThreadRow): string {
  return row.type === 'stack' ? row.drafts[0].timestamp : row.event.timestamp;
}

export function Timeline({
  contactKey,
  contactName,
  avatarJpeg = null,
  events,
  hasEarlier,
  olderHref,
  atCap,
  sendControls = 'off',
  recipientIdentity = ''
}: {
  contactKey: string;
  contactName: string;
  avatarJpeg?: string | null;
  events: ConversationEvent[];
  hasEarlier: boolean;
  olderHref: string | null;
  atCap: boolean;
  sendControls?: 'off' | 'unconfigured' | 'locked' | 'ready';
  recipientIdentity?: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const contactSeen = useRef(contactKey);
  const adjusting = useRef(false);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [openStacks, setOpenStacks] = useState<Record<string, boolean>>({});
  const [away, setAway] = useState(false);
  const rows = threadRows(events);
  let latestDraftId: string | null = null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind === 'draft') {
      latestDraftId = event.id;
      break;
    }
  }

  function placeLatest() {
    const el = scroller.current;
    if (!el) return;
    const latest = el.querySelector<HTMLElement>('.draft-latest');
    adjusting.current = true;
    if (latest) latest.scrollIntoView({block: 'start', behavior: 'instant'});
    else el.scrollTop = el.scrollHeight;
    adjusting.current = false;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    memory.set(contactKey, {distance, following: true});
    setAway(distance >= 64);
  }

  function expanded(id: string, sendable: boolean) {
    if (id in overrides) return overrides[id];
    return draftOpensOnLoad(sendable);
  }

  function remember() {
    if (adjusting.current) return;
    const el = scroller.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const following = distance < 64;
    memory.set(contactKey, {distance, following});
    setAway(!following);
  }

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const switched = contactSeen.current !== contactKey;
    contactSeen.current = contactKey;
    const state = memory.get(contactKey);
    if (!switched && state && !state.following) {
      el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - state.distance);
      setAway(state.distance >= 64);
      return;
    }
    placeLatest();
    const frame = requestAnimationFrame(() => {
      const current = memory.get(contactKey);
      if (current?.following) placeLatest();
    });
    return () => cancelAnimationFrame(frame);
  }, [contactKey, events]);

  return (
    <div className="thread-scroll" ref={scroller} onScroll={remember}>
      {hasEarlier && olderHref ? (
        <p className="more"><Link href={olderHref}>Load earlier messages</Link></p>
      ) : null}
      {atCap && hasEarlier ? <p className="warning">Earlier messages stay in the database. This view stops at the recent page limit.</p> : null}
      {events.length === 0 ? <p className="empty">No messages or drafts are stored for this contact.</p> : null}
      <ol className="timeline" role="list">
        {rows.map((row, index) => {
          const day = dayText(rowStamp(row));
          const previous = index > 0 ? dayText(rowStamp(rows[index - 1])) : '';
          const prior = row.type === 'event' ? rows[index - 1] : null;
          const priorEvent = prior?.type === 'event' ? prior.event : null;
          const grouped = row.type === 'event' && row.event.kind === 'message' && priorEvent?.kind === 'message' && priorEvent.direction === row.event.direction;
          return (
            <li key={row.type === 'stack' ? `stack-${row.id}` : row.event.kind === 'message' ? row.event.id : `d${row.event.id}`}>
              {day !== previous ? (
                <p className="day-chip">
                  <span>{day}</span>
                </p>
              ) : null}
              {row.type === 'stack' ? (
                <div className={`draft-stack${openStacks[row.id] ? ' open' : ''}`}>
                  <button
                    type="button"
                    aria-expanded={Boolean(openStacks[row.id])}
                    onClick={() => setOpenStacks((current) => ({...current, [row.id]: !current[row.id]}))}
                  >
                    <span className="draft-mark" aria-hidden="true" />
                    <span>{row.drafts.length} earlier drafts</span>
                    <svg className="chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 10l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </button>
                  <div className="draft-reveal" inert={openStacks[row.id] ? undefined : true}>
                    <div className="draft-reveal-inner">
                      {row.drafts.map((draft) => (
                        <DraftPanel
                          key={draft.id}
                          draft={draft}
                          latest={draft.id === latestDraftId}
                          open={expanded(draft.id, draft.sendable)}
                          onToggle={(id, open) => setOverrides((current) => ({...current, [id]: open}))}
                          sendControls={sendControls}
                          recipientName={contactName}
                          recipientIdentity={recipientIdentity}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              ) : row.event.kind === 'message' ? (
                <MessageItem message={row.event} contactName={contactName} avatarJpeg={avatarJpeg} showAvatar={row.event.direction !== 'outgoing' && !grouped} />
              ) : (
                <DraftPanel
                  draft={row.event}
                  latest={row.event.id === latestDraftId}
                  open={expanded(row.event.id, row.event.sendable)}
                  onToggle={(id, open) => setOverrides((current) => ({...current, [id]: open}))}
                  sendControls={sendControls}
                  recipientName={contactName}
                  recipientIdentity={recipientIdentity}
                />
              )}
            </li>
          );
        })}
      </ol>
      {away ? (
        <button
          type="button"
          className="latest"
          onClick={() => {
            const el = scroller.current;
            if (!el) return;
            placeLatest();
          }}
        >
          Latest
        </button>
      ) : null}
    </div>
  );
}
