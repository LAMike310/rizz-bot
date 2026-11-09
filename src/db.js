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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contacts (
        chat_id TEXT PRIMARY KEY,
        phone TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 0,
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
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','notified','stale','failed')),
        model TEXT,
        usage_json TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        notified_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_drafts_chat_id ON drafts(chat_id,id);
    `);
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
  enableTestContact(chatId, phone) {
    if (!chatId || !phone) throw new Error('Invalid test contact');
    this.transaction(() => {
      this.db.prepare('UPDATE contacts SET enabled=0 WHERE chat_id<>?').run(chatId);
      this.db.prepare(`INSERT INTO contacts(chat_id, phone, enabled)
        VALUES(?,?,1) ON CONFLICT(chat_id) DO UPDATE SET phone=excluded.phone,enabled=1`).run(chatId, phone);
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
      this.db.prepare(`UPDATE drafts SET status='stale' WHERE chat_id=? AND status IN ('pending','notified')`).run(chatId);
      return this.revision(chatId);
    });
  }
  history(chatId, limit) {
    const newest = this.db.prepare(`SELECT whatsapp_id,direction,body,message_timestamp FROM messages
      WHERE chat_id=? ORDER BY id DESC LIMIT ?`).all(chatId, limit);
    return newest.reverse();
  }
  saveDraft({chatId, revision, reply_es, translation_en, reason, model, usage}) {
    return this.transaction(() => {
      if (!this.isEnabled(chatId) || this.revision(chatId) !== revision) return null;
      const row = this.db.prepare(`INSERT INTO drafts(chat_id,revision,reply_es,translation_en,reason,model,usage_json)
        VALUES(?,?,?,?,?,?,?)`).run(chatId,revision,reply_es,translation_en,reason,model || null, usage ? JSON.stringify(usage) : null);
      return this.draft(Number(row.lastInsertRowid));
    });
  }
  draft(id) { return this.db.prepare('SELECT * FROM drafts WHERE id=?').get(id) || null; }
  updateDraft(id, status) {
    if (!['notified','failed','stale'].includes(status)) throw new Error('Invalid draft status');
    if (status === 'notified') {
      return this.db.prepare(`UPDATE drafts SET status='notified',notified_at=CURRENT_TIMESTAMP
        WHERE id=? AND status='pending' AND EXISTS (
          SELECT 1 FROM contacts c WHERE c.chat_id=drafts.chat_id
          AND c.enabled=1 AND c.revision=drafts.revision)`).run(id).changes === 1;
    }
    return this.db.prepare('UPDATE drafts SET status=? WHERE id=? AND status=?')
      .run(status,id,'pending').changes === 1;
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
