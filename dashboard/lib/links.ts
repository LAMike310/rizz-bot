import {CONTACT_PAGE, MESSAGE_PAGE} from './limits';

export function inboxHref(contactLimit: number): string {
  const params = new URLSearchParams();
  params.set('view', 'list');
  if (contactLimit !== CONTACT_PAGE) params.set('contactLimit', String(contactLimit));
  return `/?${params.toString()}`;
}

export function threadHref(key: string, contactLimit: number): string {
  if (contactLimit === CONTACT_PAGE) return `/inbox/${key}`;
  return `/inbox/${key}?contactLimit=${contactLimit}`;
}

export function olderMessagesHref(key: string, contactLimit: number, messageLimit: number): string {
  const params = new URLSearchParams();
  if (contactLimit !== CONTACT_PAGE) params.set('contactLimit', String(contactLimit));
  if (messageLimit !== MESSAGE_PAGE) params.set('messageLimit', String(messageLimit));
  const query = params.toString();
  return query ? `/inbox/${key}?${query}` : `/inbox/${key}`;
}

export function moreContactsHref(key: string | null, contactLimit: number, messageLimit: number): string {
  const params = new URLSearchParams();
  params.set('contactLimit', String(contactLimit));
  if (key && messageLimit !== MESSAGE_PAGE) params.set('messageLimit', String(messageLimit));
  const path = key ? `/inbox/${key}` : '/';
  return `${path}?${params.toString()}`;
}
