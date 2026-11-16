'use client';

import Link from 'next/link';
import {useLayoutEffect, useRef, useState} from 'react';
import {DraftPanel} from './draft-panel';
import {MessageItem} from './message-item';
import {draftOpensOnLoad} from '../lib/status';
import {dayText} from '../lib/time';
import type {ConversationEvent} from '../lib/types';

const memory = new Map<string, {distance: number; stick: boolean; ready: boolean}>();

export function Timeline({
  contactKey,
  contactName,
  events,
  hasEarlier,
  olderHref,
  atCap
}: {
  contactKey: string;
  contactName: string;
  events: ConversationEvent[];
  hasEarlier: boolean;
  olderHref: string | null;
  atCap: boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [away, setAway] = useState(false);

  function expanded(id: string, sendable: boolean) {
    if (id in overrides) return overrides[id];
    return draftOpensOnLoad(sendable);
  }

  function remember() {
    const el = scroller.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const stick = distance < 64;
    memory.set(contactKey, {distance, stick, ready: true});
    setAway(!stick);
  }

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const state = memory.get(contactKey);
    if (!state?.ready) {
      el.scrollTop = el.scrollHeight;
      memory.set(contactKey, {distance: 0, stick: true, ready: true});
      setAway(false);
      return;
    }
    if (state.stick) {
      el.scrollTop = el.scrollHeight;
      setAway(false);
    } else {
      el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - state.distance);
      setAway(true);
    }
  }, [contactKey, events]);

  return (
    <div className="thread-scroll" ref={scroller} onScroll={remember}>
      {hasEarlier && olderHref ? (
        <p className="more"><Link href={olderHref}>Load earlier messages</Link></p>
      ) : null}
      {atCap && hasEarlier ? <p className="warning">Earlier messages stay in the database. This view stops at the recent page limit.</p> : null}
      {events.length === 0 ? <p className="empty">No messages or drafts are stored for this contact.</p> : null}
      <ol className="timeline" role="list">
        {events.map((event, index) => {
          const day = dayText(event.timestamp);
          const previous = index > 0 ? dayText(events[index - 1].timestamp) : '';
          const prior = events[index - 1];
          const grouped = event.kind === 'message' && prior?.kind === 'message' && prior.direction === event.direction;
          return (
            <li key={event.kind === 'message' ? event.id : `d${event.id}`}>
              {day !== previous ? <p className="day-chip"><span>{day}</span></p> : null}
              {event.kind === 'message' ? (
                <MessageItem message={event} contactName={contactName} showAvatar={event.direction !== 'outgoing' && !grouped} />
              ) : (
                <DraftPanel
                  draft={event}
                  open={expanded(event.id, event.sendable)}
                  onToggle={(id, open) => setOverrides((current) => ({...current, [id]: open}))}
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
            el.scrollTop = el.scrollHeight;
            memory.set(contactKey, {distance: 0, stick: true, ready: true});
            setAway(false);
          }}
        >
          Latest
        </button>
      ) : null}
    </div>
  );
}
