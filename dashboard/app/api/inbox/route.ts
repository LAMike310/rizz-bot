import {NextResponse} from 'next/server';
import {isContactKey} from '../../../lib/keys';
import {CONTACT_MAX, CONTACT_PAGE, MESSAGE_MAX, MESSAGE_PAGE, pageLimit} from '../../../lib/limits';
import {InboxError} from '../../../lib/open-db';
import {loadInbox, loadThread, resolveChatId} from '../../../lib/queries';
import {database} from '../../../lib/session';
import {inboxStamp} from '../../../lib/stamp';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const noStore = {'Cache-Control': 'no-store'};

export async function GET(request: Request) {
  const url = new URL(request.url);
  try {
    const db = database();
    const revision = inboxStamp(db);
    if (url.searchParams.get('probe') === '1') {
      return NextResponse.json({revision}, {headers: noStore});
    }
    const contact = url.searchParams.get('contact') || '';
    if (contact && !isContactKey(contact)) {
      return NextResponse.json({error: 'not-found'}, {status: 404, headers: noStore});
    }
    const contactLimit = pageLimit(url.searchParams.get('contactLimit') || undefined, CONTACT_PAGE, CONTACT_MAX);
    const messageLimit = pageLimit(url.searchParams.get('messageLimit') || undefined, MESSAGE_PAGE, MESSAGE_MAX);
    const inbox = loadInbox(db, contactLimit);
    let thread = null;
    if (contact) {
      const chatId = resolveChatId(db, contact);
      if (!chatId) return NextResponse.json({error: 'not-found'}, {status: 404, headers: noStore});
      thread = loadThread(db, chatId, messageLimit);
      if (!thread) return NextResponse.json({error: 'not-found'}, {status: 404, headers: noStore});
    }
    return NextResponse.json({
      revision,
      contacts: inbox.contacts,
      total: inbox.total,
      enabled: inbox.enabled,
      paused: inbox.paused,
      removed: inbox.removed,
      hasMoreContacts: inbox.hasMoreContacts,
      contactLimit,
      messageLimit,
      thread
    }, {headers: noStore});
  } catch (error) {
    const status = error instanceof InboxError && error.code === 'config' ? 500 : 503;
    return NextResponse.json({error: 'unavailable'}, {status, headers: noStore});
  }
}
