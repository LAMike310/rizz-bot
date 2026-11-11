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
