import type {ConversationEvent} from './types';

type DraftEvent = Extract<ConversationEvent, {kind: 'draft'}>;

export type ThreadRow =
  | {type: 'event'; event: ConversationEvent}
  | {type: 'stack'; id: string; drafts: DraftEvent[]};

export function threadRows(events: ConversationEvent[]): ThreadRow[] {
  const lastDraft = [...events].reverse().find((event) => event.kind === 'draft');
  const lastId = lastDraft?.kind === 'draft' ? lastDraft.id : null;
  const rows: ThreadRow[] = [];
  let index = 0;
  while (index < events.length) {
    const event = events[index];
    if (event.kind === 'draft' && event.statusLabel === 'Stale' && event.id !== lastId) {
      const group: DraftEvent[] = [];
      while (index < events.length) {
        const next = events[index];
        if (next.kind !== 'draft' || next.statusLabel !== 'Stale' || next.id === lastId) break;
        group.push(next);
        index += 1;
      }
      if (group.length > 1) rows.push({type: 'stack', id: group[0].id, drafts: group});
      else rows.push({type: 'event', event: group[0]});
      continue;
    }
    rows.push({type: 'event', event});
    index += 1;
  }
  return rows;
}
