'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Prefer better-sqlite3 on the Mac. Built-in Node SQLite provides an offline-test
// fallback on Node >=22.13; Node 22 may display an ExperimentalWarning.
function openDriver(file, driver = 'auto') {
  if (driver !== 'builtin') {
    try {
      const BetterSqlite3 = require('better-sqlite3');
      return {handle: new BetterSqlite3(file), kind: 'better-sqlite3'};
    } catch (error) {
      if (driver === 'better') throw error;
    }
  }
  const {DatabaseSync} = require('node:sqlite');
  return {handle: new DatabaseSync(file), kind: 'node:sqlite'};
}

class Store {
  constructor(file, {driver = 'auto'} = {}) {
    fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
    if (file !== ':memory:' && !fs.existsSync(file)) fs.closeSync(fs.openSync(file, 'wx', 0o600));
    const opened = openDriver(file, driver);
    this.db = opened.handle;
    this.kind = opened.kind;
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;');
    this.migrate(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contacts (
        chat_id TEXT PRIMARY KEY,
        phone TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 0,
        display_name TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        whatsapp_id TEXT UNIQUE NOT NULL,
        chat_id TEXT NOT NULL REFERENCES contacts(chat_id),
        direction TEXT NOT NULL CHECK(direction IN ('incoming','outgoing')),
        body TEXT NOT NULL,
        message_timestamp INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id,id);
      CREATE TABLE IF NOT EXISTS drafts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL REFERENCES contacts(chat_id),
        revision INTEGER NOT NULL,
        reply_es TEXT NOT NULL,
        translation_en TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','stale','sending','sent','uncertain','failed','expired')),
        model TEXT,
        usage_json TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        notified_at TEXT,
        options_json TEXT,
        notification_whatsapp_id TEXT UNIQUE,
        selected_option INTEGER,
        approval_whatsapp_id TEXT UNIQUE,
        sent_whatsapp_id TEXT,
        expires_at TEXT,
        approved_at TEXT,
        sent_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_drafts_chat_id ON drafts(chat_id,id);
    `);
    this.ensureContactName();
    this.ensureVoiceColumns();
    this.settleInterruptedSends();
  }
  migrate(file) {
    const columns = this.db.prepare('PRAGMA table_info(drafts)').all();
    if (!columns.length || columns.some(column => column.name === 'options_json')) return;
    if (file && file !== ':memory:' && fs.existsSync(file)) {
      const backup = `${file}.bak-v21`;
      if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
    }
    this.db.exec('ALTER TABLE drafts RENAME TO drafts_v1;');
    this.db.exec(`
      CREATE TABLE drafts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL REFERENCES contacts(chat_id),
        revision INTEGER NOT NULL,
        reply_es TEXT NOT NULL,
        translation_en TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','stale','sending','sent','uncertain','failed','expired')),
        model TEXT,
        usage_json TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        notified_at TEXT,
        options_json TEXT,
        notification_whatsapp_id TEXT UNIQUE,
        selected_option INTEGER,
        approval_whatsapp_id TEXT UNIQUE,
        sent_whatsapp_id TEXT,
        expires_at TEXT,
        approved_at TEXT,
        sent_at TEXT
      );
      INSERT INTO drafts(id,chat_id,revision,reply_es,translation_en,reason,status,model,usage_json,created_at,notified_at,options_json)
      SELECT id,chat_id,revision,reply_es,translation_en,reason,
        CASE status WHEN 'notified' THEN 'active' ELSE status END,
        model,usage_json,created_at,notified_at,
        json_array(json_object('style','natural','reply_es',reply_es,'translation_en',translation_en))
      FROM drafts_v1;
    `);
  }
  ensureContactName() {
    const columns = this.db.prepare('PRAGMA table_info(contacts)').all();
    if (columns.length && !columns.some(column => column.name === 'display_name')) {
      this.db.exec(`ALTER TABLE contacts ADD COLUMN display_name TEXT NOT NULL DEFAULT ''`);
    }
  }
  ensureVoiceColumns() {
    const columns = this.db.prepare('PRAGMA table_info(messages)').all();
    if (!columns.length) return;
    const names = new Set(columns.map(column => column.name));
    if (!names.has('source_type')) this.db.exec(`ALTER TABLE messages ADD COLUMN source_type TEXT NOT NULL DEFAULT 'text'`);
    if (!names.has('transcription_status')) this.db.exec(`ALTER TABLE messages ADD COLUMN transcription_status TEXT`);
    if (!names.has('transcription_model')) this.db.exec(`ALTER TABLE messages ADD COLUMN transcription_model TEXT`);
    if (!names.has('transcription_language')) this.db.exec(`ALTER TABLE messages ADD COLUMN transcription_language TEXT`);
  }
  settleInterruptedSends() {
    this.db.prepare(`UPDATE drafts SET status='uncertain' WHERE status='sending'`).run();
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  enableTestContact(chatId, phone, displayName = '') {
    if (!chatId || !phone) throw new Error('Invalid test contact');
    const name = String(displayName || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    this.transaction(() => {
      this.db.prepare('UPDATE contacts SET enabled=0 WHERE chat_id<>?').run(chatId);
      this.db.prepare(`INSERT INTO contacts(chat_id, phone, enabled, display_name)
        VALUES(?,?,1,?) ON CONFLICT(chat_id) DO UPDATE SET phone=excluded.phone,enabled=1,
        display_name=CASE WHEN excluded.display_name<>'' THEN excluded.display_name ELSE contacts.display_name END`)
        .run(chatId, phone, name);
    });
  }
  contact(chatId) {
    return this.db.prepare('SELECT * FROM contacts WHERE chat_id=?').get(chatId) || null;
  }
  isEnabled(chatId) { return this.contact(chatId)?.enabled === 1; }
  revision(chatId) { return this.contact(chatId)?.revision ?? null; }
  saveEvent({whatsappId, chatId, direction, body, timestamp}) {
    if (!whatsappId || !chatId || !['incoming','outgoing'].includes(direction) || !body?.trim()) return null;
    return this.transaction(() => {
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO messages
        (whatsapp_id,chat_id,direction,body,message_timestamp) VALUES(?,?,?,?,?)`)
        .run(whatsappId,chatId,direction,body, Number.isFinite(timestamp) ? timestamp : null);
      if (!inserted.changes) return null;
      this.db.prepare('UPDATE contacts SET revision=revision+1 WHERE chat_id=? AND enabled=1').run(chatId);
      this.db.prepare(`UPDATE drafts SET status='stale' WHERE chat_id=? AND status IN ('pending','active')`).run(chatId);
      return this.revision(chatId);
    });
  }
  saveIncomingVoice({whatsappId, chatId, timestamp}) {
    if (!whatsappId || !chatId) return null;
    return this.transaction(() => {
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO messages
        (whatsapp_id,chat_id,direction,body,message_timestamp,source_type,transcription_status)
        VALUES(?,?, 'incoming','',?, 'voice','pending')`)
        .run(whatsappId, chatId, Number.isFinite(timestamp) ? timestamp : null);
      if (!inserted.changes) return null;
      this.db.prepare('UPDATE contacts SET revision=revision+1 WHERE chat_id=? AND enabled=1').run(chatId);
      this.db.prepare(`UPDATE drafts SET status='stale' WHERE chat_id=? AND status IN ('pending','active')`).run(chatId);
      return {revision: this.revision(chatId), id: Number(inserted.lastInsertRowid)};
    });
  }
  completeVoice(whatsappId, {text, model, language}) {
    const body = typeof text === 'string' ? text.trim() : '';
    if (!whatsappId || !body) return null;
    const updated = this.db.prepare(`UPDATE messages SET body=?, transcription_status='complete',
      transcription_model=?, transcription_language=?
      WHERE whatsapp_id=? AND transcription_status='pending'`).run(body, model || null, language || null, whatsappId);
    if (!updated.changes) return null;
    return this.db.prepare(`SELECT id, chat_id, body, message_timestamp, source_type, transcription_status
      FROM messages WHERE whatsapp_id=?`).get(whatsappId);
  }
  failVoice(whatsappId, marker = 'Voice note (could not be transcribed).') {
    if (!whatsappId) return null;
    const updated = this.db.prepare(`UPDATE messages SET transcription_status='failed',
      body=CASE WHEN trim(body)='' THEN ? ELSE body END
      WHERE whatsapp_id=? AND transcription_status='pending'`).run(marker, whatsappId);
    if (!updated.changes) return null;
    return this.db.prepare('SELECT id, chat_id, body, transcription_status FROM messages WHERE whatsapp_id=?').get(whatsappId);
  }
  abandonPendingTranscriptions() {
    return this.db.prepare(`UPDATE messages SET transcription_status='failed',
      body=CASE WHEN trim(body)='' THEN 'Voice note unavailable after restart.' ELSE body END
      WHERE transcription_status='pending'`).run().changes;
  }
  pendingVoiceCount(chatId) {
    return this.db.prepare(`SELECT COUNT(*) AS n FROM messages
      WHERE chat_id=? AND transcription_status='pending'`).get(chatId).n;
  }
  voiceFailureSince(chatId, afterId = 0) {
    return this.db.prepare(`SELECT COUNT(*) AS n FROM messages
      WHERE chat_id=? AND source_type='voice' AND transcription_status='failed' AND id>?`).get(chatId, afterId).n > 0;
  }
  maxMessageId(chatId) {
    return this.db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM messages WHERE chat_id=?').get(chatId).id;
  }
  maxMessageRowId() {
    return this.db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM messages').get().id;
  }
  messageByWhatsappId(whatsappId) {
    return this.db.prepare(`SELECT id, whatsapp_id, chat_id, direction, body, message_timestamp, source_type, transcription_status
      FROM messages WHERE whatsapp_id=?`).get(whatsappId) || null;
  }
  history(chatId, limit) {
    const newest = this.db.prepare(`SELECT whatsapp_id,direction,body,message_timestamp,source_type,transcription_status FROM messages
      WHERE chat_id=? AND (transcription_status IS NULL OR transcription_status!='pending')
      ORDER BY COALESCE(message_timestamp, id) DESC, id DESC LIMIT ?`).all(chatId, limit);
    return newest.reverse();
  }
  saveDraft({chatId, revision, options, model, usage, expiresAt}) {
    return this.transaction(() => {
      if (!this.isEnabled(chatId) || this.revision(chatId) !== revision) return null;
      if (!Array.isArray(options) || options.length !== 3) return null;
      const row = this.db.prepare(`INSERT INTO drafts(
        chat_id,revision,reply_es,translation_en,reason,model,usage_json,options_json,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(
        chatId, revision, options[0].reply_es, options[0].translation_en, 'three-option draft',
        model || null, usage ? JSON.stringify(usage) : null, JSON.stringify(options), expiresAt || null);
      return this.draft(Number(row.lastInsertRowid));
    });
  }
  draft(id) { return this.db.prepare('SELECT * FROM drafts WHERE id=?').get(id) || null; }
  bindNotification(id, notificationWhatsappId) {
    if (!notificationWhatsappId) return false;
    return this.db.prepare(`UPDATE drafts SET status='active', notification_whatsapp_id=?, notified_at=CURRENT_TIMESTAMP
      WHERE id=? AND status IN ('pending','failed') AND notification_whatsapp_id IS NULL AND EXISTS (
        SELECT 1 FROM contacts c WHERE c.chat_id=drafts.chat_id
        AND c.enabled=1 AND c.revision=drafts.revision)`).run(notificationWhatsappId, id).changes === 1;
  }
  latestActiveDraft() {
    return this.db.prepare(`SELECT * FROM drafts WHERE status='active' ORDER BY id DESC LIMIT 1`).get() || null;
  }
  draftByNotification(notificationWhatsappId) {
    if (!notificationWhatsappId) return null;
    const exact = this.db.prepare('SELECT * FROM drafts WHERE notification_whatsapp_id=?').get(notificationWhatsappId);
    if (exact) return exact;
    const local = String(notificationWhatsappId).split('_').pop();
    if (!local || local === notificationWhatsappId) {
      const rows = this.db.prepare(`SELECT * FROM drafts WHERE notification_whatsapp_id IS NOT NULL ORDER BY id DESC LIMIT 50`).all();
      return rows.find((row) => String(row.notification_whatsapp_id).endsWith(`_${local}`)) || null;
    }
    const rows = this.db.prepare(`SELECT * FROM drafts WHERE notification_whatsapp_id IS NOT NULL ORDER BY id DESC LIMIT 50`).all();
    return rows.find((row) => row.notification_whatsapp_id === local || String(row.notification_whatsapp_id).endsWith(`_${local}`)) || null;
  }
  updateDraft(id, status) {
    if (!['failed','stale'].includes(status)) throw new Error('Invalid draft status');
    return this.db.prepare('UPDATE drafts SET status=? WHERE id=? AND status=?')
      .run(status, id, 'pending').changes === 1;
  }
  activateDraft(id, notificationWhatsappId, expiresAt) {
    if (!notificationWhatsappId) return false;
    return this.db.prepare(`UPDATE drafts SET status='active', notification_whatsapp_id=?, notified_at=CURRENT_TIMESTAMP, expires_at=COALESCE(?, expires_at)
      WHERE id=? AND status='pending' AND notification_whatsapp_id IS NULL AND EXISTS (
        SELECT 1 FROM contacts c WHERE c.chat_id=drafts.chat_id
        AND c.enabled=1 AND c.revision=drafts.revision)`).run(notificationWhatsappId, expiresAt || null, id).changes === 1;
  }
  claimApproval({notificationWhatsappId, approvalWhatsappId, option, now, dryRun = false}) {
    return this.transaction(() => {
      const duplicate = this.db.prepare('SELECT * FROM drafts WHERE approval_whatsapp_id=?').get(approvalWhatsappId);
      if (duplicate) return {ok: false, code: 'duplicate-approval', draft: duplicate};
      const draft = this.db.prepare('SELECT * FROM drafts WHERE notification_whatsapp_id=?').get(notificationWhatsappId);
      if (!draft) return {ok: false, code: 'unknown-notification'};
      if (draft.status !== 'active') return {ok: false, code: draft.status, draft};
      const contact = this.contact(draft.chat_id);
      if (!contact?.enabled || contact.revision !== draft.revision) {
        this.db.prepare(`UPDATE drafts SET status='stale' WHERE id=? AND status='active'`).run(draft.id);
        return {ok: false, code: 'stale', draft: this.draft(draft.id)};
      }
      if (draft.expires_at && draft.expires_at <= now) {
        this.db.prepare(`UPDATE drafts SET status='expired' WHERE id=? AND status='active'`).run(draft.id);
        return {ok: false, code: 'expired', draft: this.draft(draft.id)};
      }
      const options = JSON.parse(draft.options_json || '[]');
      const selected = options[option - 1];
      if (!selected?.reply_es) return {ok: false, code: 'missing-option', draft};
      if (dryRun) return {ok: true, dryRun: true, draft, text: selected.reply_es, chatId: draft.chat_id};
      const claimed = this.db.prepare(`UPDATE drafts SET status='sending', selected_option=?, approval_whatsapp_id=?, approved_at=?
        WHERE id=? AND status='active'`).run(option, approvalWhatsappId, now, draft.id);
      if (!claimed.changes) return {ok: false, code: 'lost-race', draft: this.draft(draft.id)};
      return {ok: true, draft: this.draft(draft.id), text: selected.reply_es, chatId: draft.chat_id};
    });
  }
  markSent(id, sentWhatsappId, now) {
    return this.db.prepare(`UPDATE drafts SET status='sent', sent_whatsapp_id=?, sent_at=? WHERE id=? AND status='sending'`)
      .run(sentWhatsappId || null, now, id).changes === 1;
  }
  markUncertain(id) {
    return this.db.prepare(`UPDATE drafts SET status='uncertain' WHERE id=? AND status='sending'`).run(id).changes === 1;
  }
  countMessages(chatId) {
    return this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id=?').get(chatId).n;
  }
  draftsFor(chatId) {
    return this.db.prepare('SELECT * FROM drafts WHERE chat_id=? ORDER BY id').all(chatId);
  }
  close() { this.db.close(); }
}
module.exports = {Store};
