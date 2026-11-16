import type Database from 'better-sqlite3';
import {contactKey} from './keys';
import {guardRead} from './open-db';
import {parseOptions} from './options';
import {formatPhone} from './phone';
import {draftBadgeLabel, isActionableDraft, listDraftStatus} from './status';
import {epochMs, formatClock, formatHour, formatWhen, sqliteTimeMs} from './time';
import type {ConversationEvent, InboxContact, Thread} from './types';

type ContactRow = {
  chat_id: string;
  phone: string;
  enabled: number;
  archived: number;
  display_name: string;
  revision: number;
  created_at: string;
  message_id: number | null;
  body: string | null;
  direction: string | null;
  message_timestamp: number | null;
  source_type: string | null;
  transcription_status: string | null;
  message_created_at: string | null;
};

type ActiveDraftRow = {
  chat_id: string;
  id: number;
  revision: number;
  expires_at: string | null;
  status: string;
};

type MessageRow = {
  id: number;
  whatsapp_id: string;
  direction: string;
  body: string;
  message_timestamp: number | null;
  created_at: string;
  source_type: string | null;
  transcription_status: string | null;
  transcription_language: string | null;
  confirmed_send: number;
};

type DraftRow = {
  id: number;
  revision: number;
  status: string;
  created_at: string;
  options_json: string | null;
  selected_option: number | null;
  approved_at: string | null;
  sent_at: string | null;
  expires_at: string | null;
  has_send_id: number;
};

export function loadInbox(db: Database.Database, limit: number, now = Date.now()): {
  contacts: InboxContact[];
  total: number;
  enabled: number;
  paused: number;
  removed: number;
  hasMoreContacts: boolean;
} {
  return guardRead(() => {
    const contacts = db.prepare(`
      SELECT c.chat_id, c.phone, c.enabled, c.archived, c.display_name, c.revision, c.created_at,
        m.id AS message_id, m.body, m.direction, m.message_timestamp, m.source_type,
        m.transcription_status, m.created_at AS message_created_at
      FROM contacts c
      LEFT JOIN messages m ON m.id = (
        SELECT id FROM messages
        WHERE chat_id = c.chat_id
        ORDER BY
          CASE
            WHEN message_timestamp IS NULL THEN CAST(strftime('%s', created_at) AS INTEGER)
            WHEN message_timestamp > 1000000000000 THEN message_timestamp / 1000
            ELSE message_timestamp
          END DESC,
          id DESC
        LIMIT 1
      )
    `).all() as ContactRow[];
    const latest = db.prepare(`
      SELECT d.chat_id, d.id, d.status, d.revision, d.expires_at
      FROM drafts d
      INNER JOIN (SELECT chat_id, MAX(id) AS id FROM drafts GROUP BY chat_id) newest ON newest.id = d.id
    `).all() as ActiveDraftRow[];
    const active = db.prepare(`
      SELECT chat_id, id, revision, expires_at, status
      FROM drafts
      WHERE status = 'active'
    `).all() as ActiveDraftRow[];
    const latestByChat = new Map(latest.map((row) => [row.chat_id, row]));
    const actionableId = new Map<string, number>();
    for (const draft of active) {
      const contact = contacts.find((row) => row.chat_id === draft.chat_id);
      if (!contact || !isActionableDraft(draft, contact, now)) continue;
      const previous = actionableId.get(draft.chat_id) ?? 0;
      if (draft.id > previous) actionableId.set(draft.chat_id, draft.id);
    }
    const mapped = contacts.map((row) => {
      const latestRow = latestByChat.get(row.chat_id);
      return toContact(row, {
        actionableId: actionableId.get(row.chat_id) ?? null,
        latestStatus: latestRow?.status ?? null,
        latestExpiresAt: latestRow?.expires_at ?? null
      }, now);
    });
    mapped.sort((a, b) => {
      const left = a.lastActivityAt ? Date.parse(a.lastActivityAt) : null;
      const right = b.lastActivityAt ? Date.parse(b.lastActivityAt) : null;
      if (left == null && right == null) return a.displayName.localeCompare(b.displayName);
      if (left == null) return 1;
      if (right == null) return -1;
      if (right !== left) return right - left;
      return a.displayName.localeCompare(b.displayName);
    });
    return {
      contacts: mapped.slice(0, limit),
      total: mapped.length,
      enabled: mapped.filter((row) => row.contactStatus === 'Enabled').length,
      paused: mapped.filter((row) => row.contactStatus === 'Paused').length,
      removed: mapped.filter((row) => row.contactStatus === 'Removed').length,
      hasMoreContacts: mapped.length > limit
    };
  });
}

export function resolveChatId(db: Database.Database, key: string): string | null {
  return guardRead(() => {
    const rows = db.prepare('SELECT chat_id FROM contacts').all() as {chat_id: string}[];
    const matches = rows.filter((row) => contactKey(row.chat_id) === key);
    return matches.length === 1 ? matches[0].chat_id : null;
  });
}

export function loadThread(db: Database.Database, chatId: string, limit: number, now = Date.now()): Thread | null {
  return guardRead(() => {
    const contact = db.prepare(`
      SELECT c.chat_id, c.phone, c.enabled, c.archived, c.display_name, c.revision, c.created_at,
        m.id AS message_id, m.body, m.direction, m.message_timestamp, m.source_type,
        m.transcription_status, m.created_at AS message_created_at
      FROM contacts c
      LEFT JOIN messages m ON m.id = (
        SELECT id FROM messages
        WHERE chat_id = c.chat_id
        ORDER BY
          CASE
            WHEN message_timestamp IS NULL THEN CAST(strftime('%s', created_at) AS INTEGER)
            WHEN message_timestamp > 1000000000000 THEN message_timestamp / 1000
            ELSE message_timestamp
          END DESC,
          id DESC
        LIMIT 1
      )
      WHERE c.chat_id = ?
    `).get(chatId) as ContactRow | undefined;
    if (!contact) return null;
    const active = db.prepare(`
      SELECT chat_id, id, revision, expires_at, status
      FROM drafts
      WHERE chat_id = ? AND status = 'active'
    `).all(chatId) as ActiveDraftRow[];
    const actionableDraft = active.reduce<ActiveDraftRow | null>((best, draft) => {
      if (!isActionableDraft(draft, contact, now)) return best;
      return !best || draft.id > best.id ? draft : best;
    }, null);
    const sentIds = new Set((db.prepare(`
      SELECT sent_whatsapp_id FROM drafts
      WHERE chat_id = ? AND sent_whatsapp_id IS NOT NULL AND sent_whatsapp_id <> ''
    `).all(chatId) as {sent_whatsapp_id: string}[]).map((row) => row.sent_whatsapp_id));
    const fetched = (db.prepare(`
      SELECT id, whatsapp_id, direction, body, message_timestamp, created_at, source_type,
        transcription_status, transcription_language
      FROM messages
      WHERE chat_id = ?
      ORDER BY
        CASE
          WHEN message_timestamp IS NULL THEN CAST(strftime('%s', created_at) AS INTEGER)
          WHEN message_timestamp > 1000000000000 THEN message_timestamp / 1000
          ELSE message_timestamp
        END DESC,
        id DESC
      LIMIT ?
    `).all(chatId, limit + 1) as Omit<MessageRow, 'confirmed_send'>[]).map((row) => ({
      ...row,
      confirmed_send: sentIds.has(row.whatsapp_id) ? 1 : 0
    }));
    const hasEarlier = fetched.length > limit;
    const page = (hasEarlier ? fetched.slice(0, limit) : fetched).slice().reverse();
    const drafts = db.prepare(`
      SELECT id, revision, status, created_at, options_json, selected_option,
        approved_at, sent_at, expires_at,
        CASE WHEN sent_whatsapp_id IS NOT NULL AND sent_whatsapp_id <> '' THEN 1 ELSE 0 END AS has_send_id
      FROM drafts
      WHERE chat_id = ?
      ORDER BY id ASC
    `).all(chatId) as DraftRow[];
    const oldest = page[0] ? messageMs(page[0]) : null;
    const visibleDrafts = !hasEarlier || oldest == null
      ? drafts
      : drafts.filter((draft) => {
          const ms = sqliteTimeMs(draft.created_at);
          return ms == null || ms >= oldest;
        });
    const events = mergeEvents(page, visibleDrafts, contact, now);
    const latestDraft = drafts[drafts.length - 1];
    return {
      contact: toContact(contact, {
        actionableId: actionableDraft?.id ?? null,
        latestStatus: latestDraft?.status ?? null,
        latestExpiresAt: latestDraft?.expires_at ?? null
      }, now),
      events,
      hasEarlier,
      messageLimit: limit
    };
  });
}

function toContact(row: ContactRow, draft: {
  actionableId: number | null;
  latestStatus: string | null;
  latestExpiresAt: string | null;
}, now: number): InboxContact {
  const activity = row.message_id == null ? null : epochMs(row.message_timestamp, row.message_created_at);
  const name = row.display_name.trim();
  const phone = formatPhone(row.phone);
  const actionable = draft.actionableId != null;
  return {
    key: contactKey(row.chat_id),
    displayName: name || phone || 'Unnamed contact',
    phoneNumber: phone,
    enabled: row.archived === 1 ? false : row.enabled === 1,
    archived: row.archived === 1,
    contactStatus: row.archived === 1 ? 'Removed' : row.enabled === 1 ? 'Enabled' : 'Paused',
    lastActivityAt: activity == null ? null : new Date(activity).toISOString(),
    lastActivityLabel: activity == null ? null : formatWhen(activity, now),
    lastMessagePreview: row.message_id == null ? null : preview(row),
    hasActionableDraft: actionable,
    actionableDraftId: actionable ? String(draft.actionableId) : null,
    draftStatus: listDraftStatus(actionable, draft.latestStatus, draft.latestExpiresAt, now)
  };
}

function preview(row: ContactRow): string {
  const type = row.source_type || 'text';
  if (type === 'voice') {
    if (row.transcription_status === 'complete' && row.body?.trim()) return clip(row.body.trim());
    return 'Voice note · Transcript unavailable';
  }
  if (type !== 'text') return clip(placeholderFor(type));
  if (!row.body?.trim()) return 'No text';
  return clip(row.body.trim());
}

function clip(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > 180 ? `${clean.slice(0, 179).trimEnd()}…` : clean;
}

function messageMs(row: MessageRow): number {
  return epochMs(row.message_timestamp, row.created_at) ?? row.id;
}

function mergeEvents(messages: MessageRow[], drafts: DraftRow[], contact: ContactRow, now: number): ConversationEvent[] {
  const events: {sort: number; id: number; kind: number; event: ConversationEvent}[] = [];
  for (const row of messages) {
    const ms = messageMs(row);
    events.push({sort: ms, id: row.id, kind: 0, event: toMessage(row, ms)});
  }
  for (const row of drafts) {
    const ms = sqliteTimeMs(row.created_at) ?? 0;
    events.push({sort: ms, id: row.id, kind: 1, event: toDraft(row, ms, contact, now)});
  }
  events.sort((a, b) => a.sort - b.sort || a.kind - b.kind || a.id - b.id);
  return events.map((item) => item.event);
}

function toMessage(row: MessageRow, ms: number): ConversationEvent {
  const direction = row.direction === 'incoming' || row.direction === 'outgoing' ? row.direction : 'unknown';
  const type = row.source_type || 'text';
  const language = /^[a-z]{2}$/.test(row.transcription_language || '') ? row.transcription_language : null;
  if (type === 'voice') {
    const ready = row.transcription_status === 'complete' && Boolean(row.body?.trim());
    return {
      kind: 'message',
      id: `m${row.id}`,
      timestamp: new Date(ms).toISOString(),
      timeLabel: formatHour(ms),
      direction,
      messageType: 'voice',
      text: ready ? row.body : null,
      language,
      placeholder: ready ? null : 'Voice note · Transcript unavailable',
      confirmedSend: row.confirmed_send === 1
    };
  }
  if (type !== 'text') {
    return {
      kind: 'message',
      id: `m${row.id}`,
      timestamp: new Date(ms).toISOString(),
      timeLabel: formatHour(ms),
      direction,
      messageType: type,
      text: null,
      language: null,
      placeholder: placeholderFor(type),
      confirmedSend: row.confirmed_send === 1
    };
  }
  const text = row.body?.trim() ? row.body : null;
  return {
    kind: 'message',
    id: `m${row.id}`,
    timestamp: new Date(ms).toISOString(),
    timeLabel: formatHour(ms),
    direction,
    messageType: 'text',
    text,
    language: null,
    placeholder: text ? null : 'No text',
    confirmedSend: row.confirmed_send === 1
  };
}

function placeholderFor(type: string): string {
  if (type === 'image' || type === 'sticker') return 'Image received';
  if (type === 'audio' || type === 'ptt') return 'Audio message';
  if (type === 'document') return 'Document attached';
  return 'Attachment';
}

function toDraft(row: DraftRow, ms: number, contact: ContactRow, now: number): ConversationEvent {
  const parsed = parseOptions(row.options_json);
  const selected = Number.isInteger(row.selected_option) ? row.selected_option : null;
  const sendable = isActionableDraft(row, contact, now);
  return {
    kind: 'draft',
    id: String(row.id),
    timestamp: new Date(ms).toISOString(),
    timeLabel: formatHour(ms),
    status: row.status,
    statusLabel: draftBadgeLabel(row.status, row.expires_at, now),
    sendable,
    options: parsed.options,
    selectedOption: selected,
    relatedMessageId: null,
    previousDraftId: null,
    approvedAt: row.approved_at ? clockOrRaw(row.approved_at) : null,
    sentAt: row.sent_at ? clockOrRaw(row.sent_at) : null,
    expiresAt: row.expires_at ? clockOrRaw(row.expires_at) : null,
    hasSendId: row.has_send_id === 1,
    warning: parsed.warning
  };
}

function clockOrRaw(value: string): string {
  const ms = sqliteTimeMs(value);
  return ms == null ? value : formatClock(ms);
}
