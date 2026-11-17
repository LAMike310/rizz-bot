'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {Store} = require('../src/db');
const {dbFixture,incoming} = require('./helpers');

test('SQLite: insert is idempotent; conversation revision increments only for new messages', () => {
  const f=dbFixture();
  try {
    const m=incoming(f.chat,'m1','Hola');
    assert.equal(f.db.saveEvent({...m,direction:'incoming'}),1);
    assert.equal(f.db.saveEvent({...m,direction:'incoming'}),null);
    assert.equal(f.db.revision(f.chat),1);
    assert.equal(f.db.countMessages(f.chat),1);
    assert.equal(f.db.saveEvent({...incoming(f.chat,'m2','Buenas'),direction:'outgoing'}),2);
    assert.deepEqual(f.db.history(f.chat,10).map(x=>x.direction),['incoming','outgoing']);
  } finally {f.close();}
});

test('SQLite: drafts are version bound and invalidated on further messages', () => {
  const f=dbFixture();
  try {
    f.db.saveEvent({...incoming(f.chat,'a','Hi'),direction:'incoming'});
    const options=[
      {style:'natural',reply_es:'Hola',translation_en:'Hi'},
      {style:'playful',reply_es:'Hola jaja',translation_en:'Hi haha'},
      {style:'direct',reply_es:'Hola, cómo vas?',translation_en:'Hi, how are you?'}
    ];
    const d=f.db.saveDraft({chatId:f.chat,revision:1,options,model:'x'});
    assert.ok(d?.id);
    assert.equal(f.db.saveDraft({chatId:f.chat,revision:0,options}),null);
    f.db.saveEvent({...incoming(f.chat,'b','What about Friday?'),direction:'incoming'});
    assert.equal(f.db.draft(d.id).status,'stale');
    assert.equal(f.db.activateDraft(d.id,'note-1'),false);
  } finally {f.close();}
});

test('SQLite: reopening preserves messages and drafts', () => {
  const f=dbFixture();
  try {
    f.db.saveEvent({...incoming(f.chat,'a','Hi'),direction:'incoming'});
    f.db.close();
    const reopened=new Store(f.filename,{driver:'builtin'});
    try {assert.equal(reopened.countMessages(f.chat),1); assert.equal(reopened.revision(f.chat),1);}
    finally {reopened.close();}
  } finally {require('node:fs').rmSync(f.dir,{recursive:true,force:true});}
});

test('SQLite: enabling another contact keeps the previous one', () => {
  const f=dbFixture();
  try {
    f.db.enableTestContact('15557654321@c.us','15557654321','Valentina');
    assert.equal(f.db.isEnabled(f.chat),true);
    assert.equal(f.db.isEnabled('15557654321@c.us'),true);
    assert.equal(f.db.contact('15557654321@c.us').display_name,'Valentina');
    assert.equal(f.db.contact('15557654321@c.us').phone,'15557654321');
    f.db.enableTestContact('15557654321@c.us','15557654321','');
    assert.equal(f.db.contact('15557654321@c.us').display_name,'Valentina');
    assert.equal(f.db.aliasesFor(f.chat).includes(f.chat), true);
  } finally {f.close();}
});

test('SQLite: profile photo is stored as jpeg base64 and rejected otherwise', () => {
  const f = dbFixture();
  try {
    const names = f.db.db.prepare('PRAGMA table_info(contacts)').all().map((column) => column.name);
    assert.equal(names.includes('avatar_jpeg'), true);
    assert.equal(names.includes('avatar_fetched_at'), true);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
    const saved = f.db.saveContactAvatar(f.chat, jpeg);
    assert.equal(saved.avatar_jpeg, jpeg);
    assert.ok(saved.avatar_fetched_at);
    const cleared = f.db.saveContactAvatar(f.chat, null);
    assert.equal(cleared.avatar_jpeg, null);
    assert.ok(cleared.avatar_fetched_at);
    assert.throws(() => f.db.saveContactAvatar(f.chat, Buffer.from('not a jpeg').toString('base64')));
    assert.throws(() => f.db.saveContactAvatar(f.chat, '%%%'));
    assert.equal(f.db.contact(f.chat).avatar_jpeg, null);
  } finally {f.close();}
});

test('SQLite: existing contacts gain profile photo columns', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const {DatabaseSync} = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-avatar-'));
  const filename = path.join(dir, 'test.db');
  const raw = new DatabaseSync(filename);
  raw.exec(`CREATE TABLE contacts (
    chat_id TEXT PRIMARY KEY,
    phone TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 0,
    display_name TEXT NOT NULL DEFAULT '',
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  raw.close();
  const db = new Store(filename, {driver: 'builtin'});
  try {
    const names = db.db.prepare('PRAGMA table_info(contacts)').all().map((column) => column.name);
    assert.equal(names.includes('avatar_jpeg'), true);
    assert.equal(names.includes('avatar_fetched_at'), true);
  } finally {
    db.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
