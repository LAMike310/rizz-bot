'use client';

import Link from 'next/link';
import {useMemo, useState} from 'react';
import {Avatar} from './avatar';
import {moreContactsHref, threadHref} from '../lib/links';
import {CONTACT_MAX, CONTACT_PAGE} from '../lib/limits';
import type {InboxContact} from '../lib/types';

function draftTone(status: string): string {
  if (status === 'Draft ready') return 'draft-ready';
  if (status === 'Expired' || status === 'Stale' || status === 'Failed' || status === 'Uncertain') return 'draft-attention';
  if (status === 'No active draft') return 'draft-quiet';
  return '';
}

export function ContactList({
  contacts,
  total,
  hasMoreContacts,
  contactLimit,
  messageLimit,
  selectedKey
}: {
  contacts: InboxContact[];
  total: number;
  enabled: number;
  paused: number;
  removed: number;
  hasMoreContacts: boolean;
  contactLimit: number;
  messageLimit: number;
  selectedKey: string | null;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'ready' | 'enabled' | 'paused'>('all');
  const nextLimit = Math.min(contactLimit + CONTACT_PAGE, CONTACT_MAX);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return contacts.filter((contact) => {
      if (filter === 'ready' && !contact.hasActionableDraft) return false;
      if (filter === 'enabled' && contact.contactStatus !== 'Enabled') return false;
      if (filter === 'paused' && contact.contactStatus !== 'Paused') return false;
      if (!needle) return true;
      return contact.displayName.toLowerCase().includes(needle)
        || (contact.phoneNumber || '').toLowerCase().includes(needle);
    });
  }, [contacts, query, filter]);

  return (
    <aside className="contact-column" aria-label="Contacts">
      <div className="column-head">
        <h2>Conversations</h2>
      </div>
      <div className="search-wrap">
        <label className="search-field">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6" fill="none" stroke="currentColor" strokeWidth="1.8"/><path d="M16 16l4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
          <input
            type="search"
            aria-label="Search contacts"
            placeholder="Search contacts..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <details className="filter">
          <summary aria-label="Filter loaded contacts">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16l-6.2 7.2V19l-3.6 2v-8.8z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/></svg>
          </summary>
          <div className="filter-menu" role="group" aria-label="Filter loaded contacts">
            {(['all', 'ready', 'enabled', 'paused'] as const).map((value) => (
              <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>
                {value === 'all' ? 'All' : value === 'ready' ? 'Draft ready' : value === 'enabled' ? 'Enabled' : 'Paused'}
              </button>
            ))}
          </div>
        </details>
      </div>
      {visible.length === 0 ? (
        <p className="empty">{contacts.length === 0 ? 'No contacts are stored yet.' : 'No contacts match that search.'}</p>
      ) : (
        <ul className="contact-list" role="list">
          {visible.map((contact) => {
            const current = contact.key === selectedKey;
            return (
              <li key={contact.key}>
                <Link
                  href={threadHref(contact.key, contactLimit)}
                  aria-current={current ? 'page' : undefined}
                  className={current ? 'contact current' : 'contact'}
                >
                  <Avatar name={contact.displayName} size={44} />
                  <span className="contact-copy">
                    <span className="contact-line">
                      <span className="contact-name">{contact.displayName}</span>
                      {contact.lastActivityLabel ? <span className="contact-time">{contact.lastActivityLabel}</span> : null}
                    </span>
                    <span className="contact-status">
                      {contact.contactStatus === 'Paused' ? (
                        <svg className="status-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"/></svg>
                      ) : contact.draftStatus === 'Sent' ? (
                        <svg className="status-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                      ) : (
                        <span className={`dot dot-${contact.contactStatus.toLowerCase()}`} aria-hidden="true" />
                      )}
                      <span>{contact.contactStatus}</span>
                      <span aria-hidden="true"> · </span>
                      <span className={draftTone(contact.draftStatus)}>{contact.draftStatus}</span>
                      {contact.actionableDraftId ? <span className="draft-badge">#{contact.actionableDraftId}</span> : null}
                    </span>
                    <span className="contact-preview">{contact.lastMessagePreview ?? 'No messages yet'}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {hasMoreContacts && nextLimit > contactLimit ? (
        <p className="more">
          <Link href={moreContactsHref(selectedKey, nextLimit, messageLimit)}>Show older contacts</Link>
        </p>
      ) : null}
      <p className="column-foot">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 18V13M9 18V8M14 18V11M19 18V5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"/></svg>
        {total} {total === 1 ? 'conversation' : 'conversations'} (total)
      </p>
    </aside>
  );
}
