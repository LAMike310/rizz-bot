import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {renderToStaticMarkup} from 'react-dom/server';
import {createElement} from 'react';
import {Avatar} from '../components/avatar';
import {DraftPanel} from '../components/draft-panel';
import {Timeline} from '../components/timeline';
import {MessageItem} from '../components/message-item';
import {isAllowedInboxHost, isLocalHost} from '../lib/host';
import {contactKey, isContactKey} from '../lib/keys';
import {InboxError, openReadonly} from '../lib/open-db';
import {parseOptions} from '../lib/options';
import {loadInbox, loadThread} from '../lib/queries';
import {threadRows} from '../lib/rows';
import {draftBadgeLabel, draftOpensOnLoad, isActionableDraft, listDraftStatus, statusLabel} from '../lib/status';

const SCHEMA = `
  CREATE TABLE contacts (
    chat_id TEXT PRIMARY KEY,
    phone TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 0,
    display_name TEXT NOT NULL DEFAULT '',
    archived INTEGER NOT NULL DEFAULT 0,
    avatar_jpeg TEXT,
    avatar_fetched_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    whatsapp_id TEXT UNIQUE NOT NULL,
    chat_id TEXT NOT NULL REFERENCES contacts(chat_id),
    direction TEXT NOT NULL CHECK(direction IN ('incoming','outgoing')),
    body TEXT NOT NULL,
    message_timestamp INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    source_type TEXT NOT NULL DEFAULT 'text',
    transcription_status TEXT,
    transcription_model TEXT,
    transcription_language TEXT
  );
  CREATE INDEX idx_messages_chat_id ON messages(chat_id, id);
  CREATE TABLE drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL REFERENCES contacts(chat_id),
    revision INTEGER NOT NULL,
    reply_es TEXT NOT NULL,
    translation_en TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
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
  CREATE INDEX idx_drafts_chat_id ON drafts(chat_id, id);
  CREATE TABLE contact_aliases (
    alias TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES contacts(chat_id)
  );
  CREATE INDEX idx_contact_aliases_chat_id ON contact_aliases(chat_id);
`;

const OPTIONS = JSON.stringify([
  {style: 'natural', label: 'Friday drink', reply_es: 'El viernes podemos tomar algo.', translation_en: 'We can get a drink on Friday.'},
  {style: 'playful', reply_es: 'Depende, te portas bien?', translation_en: 'Depends, do you behave yourself?'},
  {style: 'direct', reply_es: 'Vamos por un café el viernes?', translation_en: 'Shall we get coffee on Friday?'}
]);

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'inbox-'));
  const file = path.join(dir, 'whatsapp.db');
  const writer = new Database(file);
  writer.pragma('journal_mode = WAL');
  writer.exec(SCHEMA);
  return {
    dir,
    file,
    writer,
    close() {
      writer.close();
      rmSync(dir, {recursive: true, force: true});
    }
  };
}

function fingerprint(file: string) {
  const db = new Database(file, {readonly: true, fileMustExist: true});
  const rows = {
    contacts: db.prepare('SELECT * FROM contacts ORDER BY chat_id').all(),
    messages: db.prepare('SELECT * FROM messages ORDER BY id').all(),
    drafts: db.prepare('SELECT * FROM drafts ORDER BY id').all(),
    aliases: db.prepare('SELECT * FROM contact_aliases ORDER BY alias').all()
  };
  db.close();
  return JSON.stringify(rows);
}

test('localhost host check accepts loopback names only', () => {
  assert.equal(isLocalHost('127.0.0.1:3000'), true);
  assert.equal(isLocalHost('localhost'), true);
  assert.equal(isLocalHost('[::1]:3000'), true);
  assert.equal(isLocalHost('192.168.1.8:3000'), false);
  assert.equal(isLocalHost('evil.com'), false);
  assert.equal(isLocalHost(null), false);
});

test('inbox host check allows Tailscale MagicDNS and rejects other hosts', () => {
  assert.equal(isAllowedInboxHost('mikes-macbook-air.tail544626.ts.net'), true);
  assert.equal(isAllowedInboxHost('mikes-macbook-air.tail544626.ts.net:443'), true);
  assert.equal(isAllowedInboxHost('127.0.0.1:3000'), true);
  assert.equal(isAllowedInboxHost('evil.ts.net.example.com'), false);
  assert.equal(isAllowedInboxHost('ts.net'), false);
  assert.equal(isAllowedInboxHost('192.168.1.8:3000'), false);
});

test('contact keys are stable, url-safe, and hide the phone number', () => {
  const key = contactKey('573104489921@c.us');
  assert.equal(isContactKey(key), true);
  assert.equal(key.includes('57310'), false);
  assert.equal(contactKey('573104489921@c.us'), key);
});

test('missing database is not created', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'inbox-missing-'));
  const file = path.join(dir, 'missing.db');
  assert.throws(() => openReadonly(file), (error: unknown) => error instanceof InboxError && error.code === 'config');
  assert.equal(existsSync(file), false);
  rmSync(dir, {recursive: true, force: true});
});

test('readonly handle rejects writes and does not change application rows', () => {
  const fx = fixture();
  try {
    fx.writer.prepare(`INSERT INTO contacts(chat_id, phone, enabled, display_name) VALUES(?,?,1,?)`)
      .run('15550001@c.us', '15550001', 'Camila');
    fx.writer.prepare(`INSERT INTO contact_aliases(alias, chat_id) VALUES(?,?)`).run('15550001@lid', '15550001@c.us');
    fx.writer.prepare(`INSERT INTO messages(whatsapp_id, chat_id, direction, body, message_timestamp, source_type)
      VALUES(?,?,?,?,?,?)`).run('m1', '15550001@c.us', 'incoming', 'Hola', 1_700_000_000, 'text');
    const before = fingerprint(fx.file);
    const reader = openReadonly(fx.file);
    assert.equal(reader.pragma('query_only', {simple: true}), 1);
    assert.throws(() => reader.prepare(`INSERT INTO messages(whatsapp_id, chat_id, direction, body) VALUES('x','15550001@c.us','incoming','no')`).run());
    const inbox = loadInbox(reader, 50, 1_700_000_100_000);
    assert.equal(inbox.total, 1);
    assert.equal(inbox.contacts[0].displayName, 'Camila');
    assert.equal(inbox.contacts[0].phoneNumber, '+15550001');
    assert.equal(inbox.contacts[0].key.includes('1555'), false);
    reader.close();
    assert.equal(fingerprint(fx.file), before);
  } finally {
    fx.close();
  }
});

test('aliases do not duplicate a contact, and threads stay isolated', () => {
  const fx = fixture();
  try {
    const now = Date.parse('2026-11-14T20:00:00Z');
    fx.writer.prepare(`INSERT INTO contacts(chat_id, phone, enabled, revision, display_name) VALUES(?,?,1,2,?)`)
      .run('a@c.us', '15551111', 'Camila');
    fx.writer.prepare(`INSERT INTO contacts(chat_id, phone, enabled, revision, display_name) VALUES(?,?,0,1,?)`)
      .run('b@c.us', '15552222', 'Laura');
    fx.writer.prepare(`INSERT INTO contact_aliases(alias, chat_id) VALUES(?,?)`).run('a@c.us', 'a@c.us');
    fx.writer.prepare(`INSERT INTO contact_aliases(alias, chat_id) VALUES(?,?)`).run('lid-a@lid', 'a@c.us');
    fx.writer.prepare(`INSERT INTO messages(whatsapp_id, chat_id, direction, body, message_timestamp) VALUES(?,?,?,?,?)`)
      .run('a1', 'a@c.us', 'incoming', 'Camila message', 1_700_000_200);
    fx.writer.prepare(`INSERT INTO messages(whatsapp_id, chat_id, direction, body, message_timestamp) VALUES(?,?,?,?,?)`)
      .run('b1', 'b@c.us', 'incoming', 'Laura message', 1_700_000_100);
    fx.writer.prepare(`INSERT INTO drafts(chat_id, revision, reply_es, translation_en, reason, status, options_json, created_at)
      VALUES(?,?,?,?,?,'active',?,?)`).run('a@c.us', 2, 'Hola', 'Hi', 'three-option draft', OPTIONS, '2026-11-14 20:14:00');
    fx.writer.prepare(`INSERT INTO drafts(chat_id, revision, reply_es, translation_en, reason, status, options_json, selected_option, approved_at, sent_at, sent_whatsapp_id, created_at)
      VALUES(?,?,?,?,?,'sent',?,2,?,?,?,?)`).run(
      'b@c.us', 1, 'Bien', 'Good', 'three-option draft', OPTIONS,
      '2026-11-14T19:00:00.000Z', '2026-11-14T19:01:00.000Z', 'true_b@c.us_ABC', '2026-11-14 19:00:00'
    );
    const reader = openReadonly(fx.file);
    const inbox = loadInbox(reader, 50, now);
    assert.equal(inbox.total, 2);
    assert.equal(inbox.contacts[0].displayName, 'Camila');
    assert.equal(inbox.contacts[0].draftStatus, 'Draft ready');
    assert.equal(inbox.contacts[0].readyPreview, 'El viernes podemos tomar algo.');
    assert.equal(inbox.contacts[0].actionableDraftId, '1');
    assert.equal(inbox.contacts[0].contactStatus, 'Enabled');
    assert.equal(inbox.contacts[1].displayName, 'Laura');
    assert.equal(inbox.contacts[1].draftStatus, 'Sent');
    assert.equal(inbox.contacts[1].contactStatus, 'Paused');
    const camila = loadThread(reader, 'a@c.us', 80, now);
    const laura = loadThread(reader, 'b@c.us', 80, now);
    assert.ok(camila && laura);
    assert.equal(camila.events.some((event) => event.kind === 'message' && event.text === 'Laura message'), false);
    assert.equal(laura.events.some((event) => event.kind === 'message' && event.text === 'Camila message'), false);
    const lauraDraft = laura.events.find((event) => event.kind === 'draft');
    assert.ok(lauraDraft && lauraDraft.kind === 'draft');
    assert.equal(lauraDraft.selectedOption, 2);
    assert.equal(lauraDraft.statusLabel, 'Sent');
    assert.equal(lauraDraft.hasSendId, true);
    assert.equal(JSON.stringify(lauraDraft).includes('true_b@c.us_ABC'), false);
    assert.equal(lauraDraft.previousDraftId, null);
    assert.equal(lauraDraft.relatedMessageId, null);
    reader.close();
  } finally {
    fx.close();
  }
});

test('message order is stable, voice notes are not invented, and pagination does not duplicate', () => {
  const fx = fixture();
  try {
    fx.writer.prepare(`INSERT INTO contacts(chat_id, phone, enabled, display_name) VALUES(?,?,1,?)`)
      .run('a@c.us', '15553333', 'Sofia');
    const insert = fx.writer.prepare(`INSERT INTO messages(whatsapp_id, chat_id, direction, body, message_timestamp, source_type, transcription_status, transcription_language)
      VALUES(?,?,?,?,?,?,?,?)`);
    insert.run('t1', 'a@c.us', 'incoming', 'first', 100, 'text', null, null);
    insert.run('t2', 'a@c.us', 'outgoing', 'second-same-time', 100, 'text', null, null);
    insert.run('t3', 'a@c.us', 'incoming', '', 200, 'voice', 'pending', 'es');
    insert.run('t4', 'a@c.us', 'incoming', '<img src=x onerror=alert(1)>', 300, 'text', null, null);
    const reader = openReadonly(fx.file);
    const page = loadThread(reader, 'a@c.us', 2, 300_000);
    assert.ok(page);
    assert.equal(page.hasEarlier, true);
    const texts = page.events.filter((event) => event.kind === 'message').map((event) => event.kind === 'message' ? event.text ?? event.placeholder : '');
    assert.deepEqual(texts, ['Voice note · Transcript unavailable', '<img src=x onerror=alert(1)>']);
    const full = loadThread(reader, 'a@c.us', 10, 300_000);
    assert.ok(full);
    const fullTexts = full.events.filter((event) => event.kind === 'message').map((event) => event.kind === 'message' ? event.id : '');
    assert.deepEqual(fullTexts, ['m1', 'm2', 'm3', 'm4']);
    const voice = full.events.find((event) => event.kind === 'message' && event.messageType === 'voice');
    assert.ok(voice && voice.kind === 'message');
    assert.equal(voice.text, null);
    assert.equal(voice.language, 'es');
    reader.close();
  } finally {
    fx.close();
  }
});

test('draft status follows persisted rows, including stale and malformed options', () => {
  const now = Date.parse('2026-11-14T21:00:00Z');
  assert.equal(isActionableDraft({status: 'active', revision: 3, expires_at: null}, {enabled: 1, archived: 0, revision: 3}, now), true);
  assert.equal(isActionableDraft({status: 'active', revision: 2, expires_at: null}, {enabled: 1, archived: 0, revision: 3}, now), false);
  assert.equal(isActionableDraft({status: 'stale', revision: 3, expires_at: null}, {enabled: 1, archived: 0, revision: 3}, now), false);
  assert.equal(isActionableDraft({status: 'active', revision: 3, expires_at: '2026-11-14T20:00:00.000Z'}, {enabled: 1, archived: 0, revision: 3}, now), false);
  assert.equal(statusLabel('sending'), 'Submitted');
  assert.equal(statusLabel('sent'), 'Sent');
  assert.equal(statusLabel('delivered'), 'delivered');
  const later = Date.parse('2026-11-16T17:40:00Z');
  assert.equal(listDraftStatus(false, 'active', '2026-11-16T03:31:38Z', later), 'Expired');
  assert.equal(listDraftStatus(true, 'active', '2026-11-16T18:00:00Z', later), 'Draft ready');
  assert.equal(listDraftStatus(false, 'active', null, later), 'No active draft');
  assert.equal(listDraftStatus(false, 'stale', null, later), 'Stale');
  assert.equal(draftBadgeLabel('active', '2026-11-16T03:31:38Z', later), 'Expired');
  assert.equal(draftBadgeLabel('active', null, later), 'Ready');
  assert.equal(draftOpensOnLoad(true), true);
  assert.equal(draftOpensOnLoad(false), false);
  const broken = parseOptions('{');
  assert.equal(broken.options.length, 0);
  assert.ok(broken.warning);
  const partial = parseOptions(JSON.stringify([{style: 'natural', reply_es: 'Hola'}]));
  assert.equal(partial.options.length, 1);
  assert.equal(partial.options[0].translationEn, null);
});

test('a live writer commit is visible to the open reader', () => {
  const fx = fixture();
  try {
    fx.writer.prepare(`INSERT INTO contacts(chat_id, phone, enabled, display_name) VALUES(?,?,1,?)`)
      .run('a@c.us', '15554444', 'Paula');
    const reader = openReadonly(fx.file);
    assert.equal(loadInbox(reader, 50).total, 1);
    fx.writer.prepare(`INSERT INTO messages(whatsapp_id, chat_id, direction, body, message_timestamp) VALUES(?,?,?,?,?)`)
      .run('new', 'a@c.us', 'incoming', 'arrived live', 1_800_000_000);
    const thread = loadThread(reader, 'a@c.us', 80, 1_800_000_100_000);
    assert.equal(thread?.events.some((event) => event.kind === 'message' && event.text === 'arrived live'), true);
    reader.close();
  } finally {
    fx.close();
  }
});

test('chat text is escaped and Spanish draft copy keeps its language', () => {
  const html = renderToStaticMarkup(createElement(MessageItem, {
    contactName: 'Camila',
    message: {
      kind: 'message',
      id: 'm1',
      timestamp: '2026-11-14T20:00:00.000Z',
      timeLabel: 'Nov 14, 3:00 PM',
      direction: 'incoming',
      messageType: 'text',
      text: '<img src=x onerror=alert(1)>',
      language: null,
      placeholder: null,
      confirmedSend: false
    }
  }));
  assert.equal(html.includes('<img'), false);
  assert.ok(html.includes('&lt;img'));
  const draftHtml = renderToStaticMarkup(createElement(DraftPanel, {
    open: true,
    onToggle() {},
    draft: {
      kind: 'draft',
      id: '42',
      timestamp: '2026-11-14T20:14:00.000Z',
      timeLabel: 'Nov 14, 3:14 PM',
      status: 'active',
      statusLabel: 'Ready',
      sendable: false,
      options: [{style: 'natural', label: null, replyEs: 'El viernes', translationEn: 'On Friday'}],
      selectedOption: 1,
      relatedMessageId: null,
      previousDraftId: null,
      approvedAt: null,
      sentAt: null,
      expiresAt: null,
      hasSendId: false,
      warning: null
    }
  }));
  assert.match(draftHtml, /lang="es"/);
  assert.match(draftHtml, /Selected/);
  assert.equal(draftHtml.includes('To send, reply 1, 2, or 3'), false);
  assert.equal(draftHtml.includes('<button type="submit"'), false);
  const sendableHtml = renderToStaticMarkup(createElement(DraftPanel, {
    open: true,
    onToggle() {},
    draft: {
      kind: 'draft',
      id: '86',
      timestamp: '2026-11-16T18:00:00.000Z',
      timeLabel: '1:00 PM',
      status: 'active',
      statusLabel: 'Ready',
      sendable: true,
      options: [{style: 'natural', label: null, replyEs: 'El viernes', translationEn: 'On Friday'}],
      selectedOption: null,
      relatedMessageId: null,
      previousDraftId: null,
      approvedAt: null,
      sentAt: null,
      expiresAt: null,
      hasSendId: false,
      warning: null
    }
  }));
  assert.match(sendableHtml, /To send, reply 1, 2, or 3 to the draft notification in WhatsApp\./);
  assert.equal(sendableHtml.includes('<button type="submit"'), false);
  const expiredHtml = renderToStaticMarkup(createElement(DraftPanel, {
    open: true,
    onToggle() {},
    draft: {
      kind: 'draft',
      id: '85',
      timestamp: '2026-11-16T01:31:00.000Z',
      timeLabel: '8:31 PM',
      status: 'active',
      statusLabel: 'Expired',
      sendable: false,
      options: [{style: 'playful', label: null, replyEs: 'Jaja', translationEn: 'Haha'}],
      selectedOption: null,
      relatedMessageId: null,
      previousDraftId: null,
      approvedAt: null,
      sentAt: null,
      expiresAt: 'Nov 15, 10:31 PM',
      hasSendId: false,
      warning: null
    }
  }));
  assert.match(expiredHtml, /Expired/);
  assert.match(expiredHtml, /Expired Nov 15, 10:31 PM/);
  assert.equal(expiredHtml.includes('To send, reply'), false);
});

test('consecutive stale drafts collapse and the latest card stays outside', () => {
  const draft = (id: string, statusLabel: string): Extract<import('../lib/types').ConversationEvent, {kind: 'draft'}> => ({
    kind: 'draft', id, timestamp: '2026-11-15T20:00:00.000Z', timeLabel: '3:00 PM', status: statusLabel === 'Stale' ? 'stale' : 'active',
    statusLabel, sendable: false, options: [], selectedOption: null, relatedMessageId: null, previousDraftId: null,
    approvedAt: null, sentAt: null, expiresAt: null, hasSendId: false, warning: null
  });
  const message: import('../lib/types').ConversationEvent = {
    kind: 'message', id: 'm', timestamp: '2026-11-15T20:05:00.000Z', timeLabel: '3:05 PM', direction: 'incoming',
    messageType: 'text', text: 'hola', language: null, placeholder: null, confirmedSend: false
  };
  const rows = threadRows([draft('1', 'Stale'), draft('2', 'Stale'), message, draft('3', 'Stale')]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].type, 'stack');
  assert.equal(rows[0].type === 'stack' && rows[0].drafts.length, 2);
  assert.equal(rows[2].type === 'event' && rows[2].event.kind === 'draft' && rows[2].event.id, '3');
  const html = renderToStaticMarkup(createElement(Timeline, {
    contactKey: 'c',
    contactName: 'Camila',
    events: [draft('1', 'Stale'), message, draft('9', 'Expired')],
    hasEarlier: false,
    olderHref: null,
    atCap: false
  }));
  assert.equal(html.match(/draft-latest/g)?.length, 1);
  assert.match(html, /Draft #9[\s\S]*draft-latest|draft-latest[\s\S]*Draft #9/);
});

test('stored active past expires_at is Expired in the list and on the card', () => {
  const fx = fixture();
  try {
    const now = Date.parse('2026-11-16T17:40:00Z');
    fx.writer.prepare(`INSERT INTO contacts(chat_id, phone, enabled, revision, display_name) VALUES(?,?,1,4,?)`)
      .run('oscar@c.us', '573152165571', 'Oscar');
    fx.writer.prepare(`INSERT INTO contacts(chat_id, phone, enabled, revision, display_name) VALUES(?,?,1,2,?)`)
      .run('live@c.us', '15550099', 'Camila');
    fx.writer.prepare(`INSERT INTO drafts(chat_id, revision, reply_es, translation_en, reason, status, options_json, expires_at, created_at)
      VALUES(?,?,?,?,?,'stale',?,?,?)`).run('oscar@c.us', 3, 'Antes', 'Before', 'three-option draft', OPTIONS, null, '2026-11-15 18:00:00');
    fx.writer.prepare(`INSERT INTO drafts(chat_id, revision, reply_es, translation_en, reason, status, options_json, expires_at, created_at)
      VALUES(?,?,?,?,?,'active',?,?,?)`).run(
      'oscar@c.us', 4, 'Sí', 'Yes', 'three-option draft', OPTIONS, '2026-11-16T03:31:38Z', '2026-11-16 01:31:00'
    );
    fx.writer.prepare(`INSERT INTO drafts(chat_id, revision, reply_es, translation_en, reason, status, options_json, expires_at, created_at)
      VALUES(?,?,?,?,?,'active',?,?,?)`).run(
      'live@c.us', 2, 'Hola', 'Hi', 'three-option draft', OPTIONS, '2026-11-16T20:00:00Z', '2026-11-16 17:00:00'
    );
    const reader = openReadonly(fx.file);
    const inbox = loadInbox(reader, 50, now);
    const oscar = inbox.contacts.find((contact) => contact.displayName === 'Oscar');
    const camila = inbox.contacts.find((contact) => contact.displayName === 'Camila');
    assert.ok(oscar && camila);
    assert.equal(oscar.draftStatus, 'Expired');
    assert.equal(oscar.hasActionableDraft, false);
    assert.equal(camila.draftStatus, 'Draft ready');
    assert.equal(camila.hasActionableDraft, true);
    const thread = loadThread(reader, 'oscar@c.us', 80, now);
    assert.ok(thread);
    const cards = thread.events.filter((event) => event.kind === 'draft');
    assert.equal(cards.length, 2);
    assert.equal(cards[0].kind === 'draft' && cards[0].statusLabel, 'Stale');
    assert.equal(cards[0].kind === 'draft' && cards[0].sendable, false);
    assert.equal(cards[1].kind === 'draft' && cards[1].status, 'active');
    assert.equal(cards[1].kind === 'draft' && cards[1].statusLabel, 'Expired');
    assert.equal(cards[1].kind === 'draft' && cards[1].sendable, false);
    const live = loadThread(reader, 'live@c.us', 80, now);
    const liveDraft = live?.events.find((event) => event.kind === 'draft');
    assert.ok(liveDraft && liveDraft.kind === 'draft');
    assert.equal(liveDraft.statusLabel, 'Ready');
    assert.equal(liveDraft.sendable, true);
    reader.close();
  } finally {
    fx.close();
  }
});

test('stored profile photo is returned, and initials remain when it is missing', () => {
  const fx = fixture();
  try {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
    fx.writer.prepare(`INSERT INTO contacts(chat_id, phone, enabled, display_name, avatar_jpeg) VALUES(?,?,1,?,?)`)
      .run('a@c.us', '15551111', 'Camila', jpeg);
    fx.writer.prepare(`INSERT INTO contacts(chat_id, phone, enabled, display_name) VALUES(?,?,1,?)`)
      .run('b@c.us', '15552222', 'Laura');
    const reader = openReadonly(fx.file);
    const inbox = loadInbox(reader, 50, Date.parse('2026-11-16T20:00:00Z'));
    const camila = inbox.contacts.find((contact) => contact.displayName === 'Camila');
    const laura = inbox.contacts.find((contact) => contact.displayName === 'Laura');
    assert.equal(camila?.avatarJpeg, jpeg);
    assert.equal(laura?.avatarJpeg, null);
    assert.equal(loadThread(reader, 'a@c.us', 20)?.contact.avatarJpeg, jpeg);
    assert.equal(loadThread(reader, 'b@c.us', 20)?.contact.avatarJpeg, null);
    reader.close();
    const photo = renderToStaticMarkup(createElement(Avatar, {name: 'Camila', avatarJpeg: jpeg}));
    assert.match(photo, new RegExp(`data:image/jpeg;base64,${jpeg}`));
    const initials = renderToStaticMarkup(createElement(Avatar, {name: 'Camila'}));
    assert.match(initials, />CA</);
    assert.equal(initials.includes('<img'), false);
    const rejected = renderToStaticMarkup(createElement(Avatar, {name: 'Camila', avatarJpeg: 'not-a-photo'}));
    assert.match(rejected, />CA</);
  } finally {
    fx.close();
  }
});
