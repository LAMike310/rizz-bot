import type {Metadata} from 'next';
import {InboxPage} from '../../../components/inbox-page';

export const metadata: Metadata = {title: 'Conversation · Agent Inbox'};

export default async function Page({
  params,
  searchParams
}: {
  params: Promise<{contactKey: string}>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const {contactKey} = await params;
  return <InboxPage contactKey={contactKey} searchParams={await searchParams} />;
}
