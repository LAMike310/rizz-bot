import type Database from 'better-sqlite3';
import {guardRead} from './open-db';

type DraftSig = {
  id: number;
  status: string | null;
  selected_option: number | null;
  sent_at: string | null;
  approved_at: string | null;
  expires_at: string | null;
  options_len: number;
};

/** Compact fingerprint of rows the inbox renders. Changes when a message, draft, or contact changes. */
export function inboxStamp(db: Database.Database): string {
  return guardRead(() => {
    const columns = db.prepare('PRAGMA table_info(contacts)').all() as {name: string}[];
    const avatar = columns.some((column) => column.name === 'avatar_jpeg')
      ? "COALESCE(SUM(length(COALESCE(avatar_jpeg, ''))), 0)"
      : '0';
    const messages = db.prepare(`
      SELECT COALESCE(MAX(id), 0) AS maxId,
        COUNT(*) AS n,
        COALESCE(SUM(length(COALESCE(body, ''))), 0) AS body,
        COALESCE(SUM(length(COALESCE(transcription_status, ''))), 0) AS transcript
      FROM messages
    `).get() as {maxId: number; n: number; body: number; transcript: number};
    const drafts = db.prepare(`
      SELECT id, status, selected_option, sent_at, approved_at, expires_at,
        length(COALESCE(options_json, '')) AS options_len
      FROM drafts
      ORDER BY id
    `).all() as DraftSig[];
    const contacts = db.prepare(`
      SELECT COUNT(*) AS n,
        COALESCE(SUM(revision), 0) AS rev,
        COALESCE(SUM(enabled), 0) AS enabled,
        COALESCE(SUM(archived), 0) AS archived,
        COALESCE(SUM(length(COALESCE(display_name, ''))), 0) AS names,
        ${avatar} AS avatars
      FROM contacts
    `).get() as {n: number; rev: number; enabled: number; archived: number; names: number; avatars: number};
    const draftSig = drafts.map((row) => [
      row.id,
      row.status || '',
      row.selected_option ?? '',
      row.sent_at || '',
      row.approved_at || '',
      row.expires_at || '',
      row.options_len
    ].join(':')).join(',');
    return [
      `m${messages.maxId}.${messages.n}.${messages.body}.${messages.transcript}`,
      `d${draftSig}`,
      `c${contacts.n}.${contacts.rev}.${contacts.enabled}.${contacts.archived}.${contacts.names}.${contacts.avatars}`
    ].join('|');
  });
}
