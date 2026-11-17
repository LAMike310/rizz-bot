import {cookies} from 'next/headers';
import {connection} from 'next/server';
import {notFound, redirect} from 'next/navigation';
import {LiveInbox} from './live-inbox';
import {threadHref} from '../lib/links';
import {isContactKey} from '../lib/keys';
import {CONTACT_MAX, CONTACT_PAGE, MESSAGE_MAX, MESSAGE_PAGE, firstParam, pageLimit} from '../lib/limits';
import {InboxError} from '../lib/open-db';
import {sendControlMode} from '../lib/owner-auth';
import {loadInbox, loadThread, resolveChatId} from '../lib/queries';
import {database} from '../lib/session';
import {inboxStamp} from '../lib/stamp';

export async function InboxPage({
  contactKey,
  searchParams
}: {
  contactKey?: string;
  searchParams: Record<string, string | string[] | undefined>;
}) {
  await connection();
  const jar = await cookies();
  const sendControls = sendControlMode(jar.get('inbox_owner')?.value);
  if (contactKey && !isContactKey(contactKey)) notFound();
  const contactLimit = pageLimit(firstParam(searchParams.contactLimit), CONTACT_PAGE, CONTACT_MAX);
  const messageLimit = pageLimit(firstParam(searchParams.messageLimit), MESSAGE_PAGE, MESSAGE_MAX);
  const listView = firstParam(searchParams.view) === 'list';
  let missing = false;
  let openFirst: string | null = null;
  try {
    const db = database();
    const inbox = loadInbox(db, contactLimit);
    let thread = null;
    if (contactKey) {
      const chatId = resolveChatId(db, contactKey);
      if (!chatId) missing = true;
      else {
        thread = loadThread(db, chatId, messageLimit);
        if (!thread) missing = true;
      }
    }
    if (missing) notFound();
    if (!contactKey && !listView && inbox.contacts[0]) {
      openFirst = threadHref(inbox.contacts[0].key, contactLimit);
    } else {
      return (
        <LiveInbox
          contactKey={contactKey}
          contactLimit={contactLimit}
          messageLimit={messageLimit}
          initial={{
            revision: inboxStamp(db),
            contacts: inbox.contacts,
            total: inbox.total,
            enabled: inbox.enabled,
            paused: inbox.paused,
            removed: inbox.removed,
            hasMoreContacts: inbox.hasMoreContacts,
            contactLimit,
            messageLimit,
            thread
          }}
          sendControls={sendControls}
        />
      );
    }
  } catch (error) {
    if (isNotFound(error)) throw error;
    if (error instanceof InboxError && error.code === 'config') return <ConfigNotice message={error.message} />;
    return <Unavailable />;
  }
  redirect(openFirst || '/');
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'digest' in error && String((error as {digest?: string}).digest).includes('404'));
}

function ConfigNotice({message}: {message: string}) {
  return (
    <main id="content" tabIndex={-1} className="notice">
      <h1>Database is not configured</h1>
      <p>{message}</p>
    </main>
  );
}

function Unavailable() {
  return (
    <main id="content" tabIndex={-1} className="notice">
      <h1>Temporarily unavailable</h1>
      <p>The inbox could not read the database. It will try again on the next refresh. Nothing was written.</p>
    </main>
  );
}
