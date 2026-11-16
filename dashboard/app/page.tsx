import type {Metadata} from 'next';
import {InboxPage} from '../components/inbox-page';

export const metadata: Metadata = {title: 'Agent Inbox'};

export default async function Page({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <InboxPage searchParams={await searchParams} />;
}
