import Link from 'next/link';
import {Avatar} from './avatar';
import {ContactList} from './contact-list';
import {Timeline} from './timeline';
import {inboxHref, olderMessagesHref} from '../lib/links';
import {MESSAGE_MAX, MESSAGE_STEP} from '../lib/limits';
import type {InboxContact, Thread} from '../lib/types';

export function InboxShell({
  contacts,
  total,
  enabled,
  paused,
  removed,
  hasMoreContacts,
  contactLimit,
  messageLimit,
  thread
}: {
  contacts: InboxContact[];
  total: number;
  enabled: number;
  paused: number;
  removed: number;
  hasMoreContacts: boolean;
  contactLimit: number;
  messageLimit: number;
  thread: Thread | null;
}) {
  const nextMessages = Math.min(messageLimit + MESSAGE_STEP, MESSAGE_MAX);
  return (
    <div className="workspace">
      <nav className="rail" aria-label="Inbox">
        <span className="rail-item" aria-current="page">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16v12H4z" fill="none" stroke="currentColor" strokeWidth="1.8"/><path d="M4 7l8 6 8-6" fill="none" stroke="currentColor" strokeWidth="1.8"/></svg>
          <span>Conversations</span>
          <span className="rail-count"><span className="visually-hidden">Conversation count </span>{total}</span>
        </span>
      </nav>
    <main id="content" tabIndex={-1} className="shell" data-pane={thread ? 'thread' : 'list'}>
      <ContactList
        contacts={contacts}
        total={total}
        enabled={enabled}
        paused={paused}
        removed={removed}
        hasMoreContacts={hasMoreContacts}
        contactLimit={contactLimit}
        messageLimit={messageLimit}
        selectedKey={thread?.contact.key ?? null}
      />
      <section className="thread-column" aria-label={thread ? thread.contact.displayName : 'Conversation'}>
        {thread ? (
          <>
            <div className="thread-head">
              <p className="back"><Link href={inboxHref(contactLimit)}>Back</Link></p>
              <Avatar name={thread.contact.displayName} avatarJpeg={thread.contact.avatarJpeg} size={48} />
              <div className="thread-id">
                <h1>{thread.contact.displayName}</h1>
                {thread.contact.phoneNumber ? <p className="thread-phone">{thread.contact.phoneNumber}</p> : null}
              </div>
              <p className={`status-pill pill-${thread.contact.contactStatus.toLowerCase()}`}>
                <span className={`dot dot-${thread.contact.contactStatus.toLowerCase()}`} aria-hidden="true" />
                {thread.contact.contactStatus}
              </p>
            </div>
            <Timeline
              contactKey={thread.contact.key}
              contactName={thread.contact.displayName}
              avatarJpeg={thread.contact.avatarJpeg}
              events={thread.events}
              hasEarlier={thread.hasEarlier}
              olderHref={thread.hasEarlier && nextMessages > messageLimit ? olderMessagesHref(thread.contact.key, contactLimit, nextMessages) : null}
              atCap={thread.hasEarlier && messageLimit >= MESSAGE_MAX}
            />
          </>
        ) : (
          <div className="thread-empty">
            <h1>Select a conversation</h1>
            <p>Messages and drafts for the contact you open will show here.</p>
          </div>
        )}
      </section>
    </main>
    </div>
  );
}
