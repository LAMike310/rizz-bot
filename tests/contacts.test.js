'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {Store} = require('../src/db');
const {DatingAgent} = require('../src/agent');
const {DraftDelivery} = require('../src/drafts');
const {
  parseApprovedEvent, parseOwnerCommand, handleOwnerCommand, createContactDirectory, isOwnerSelfMessage
} = require('../src/whatsapp');
const {Clock, dbFixture, agentConfig, quietLogger, incoming, deferred, suggested} = require('./helpers');

const owner = '573001234567@c.us';
const valentina = '15551234567@c.us';
const camila = '15550000002@c.us';

function message(from, body = 'Hola') {
  return {
    id: {_serialized: `msg-${from}`, fromMe: false, remote: from},
    from, to: owner, type: 'chat', body, timestamp: 1000
  };
}

function command(body, from = owner) {
  return {
    id: {_serialized: `cmd-${body}`, fromMe: true, remote: from},
    from, to: from, fromMe: true, type: 'chat', body
  };
}

test('enrollment keeps every contact and stores aliases that survive restart', () => {
  const f = dbFixture();
  try {
    f.db.enableContact(valentina, '15551234567', 'Valentina', [valentina]);
    f.db.enableContact(camila, '+1 (555) 000-0002', 'Camila', [camila, '999@lid']);
    f.db.enableContact(camila, '15550000002', 'Camila', [camila, '999@lid']);
    assert.equal(f.db.isEnabled(valentina), true);
    assert.equal(f.db.isEnabled(camila), true);
    assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE chat_id=?').get(camila).n, 1);
    assert.equal(f.db.aliasesFor(camila).includes('999@lid'), true);
    assert.throws(() => f.db.addAlias(valentina, '999@lid'), /another contact/);
    assert.match(f.db.formatContactList(), /Valentina · \+15551234567/);
    assert.match(f.db.formatContactList(), /Camila · \+15550000002/);
    const filename = f.filename;
    f.db.close();
    const reopened = new Store(filename, {driver: 'builtin'});
    try {
      assert.equal(reopened.isEnabled(valentina), true);
      assert.equal(reopened.isEnabled(camila), true);
      assert.equal(reopened.aliasesFor(camila).includes('999@lid'), true);
      assert.equal(reopened.draftByNotification('ABCDEF'), null);
    } finally { reopened.close(); }
  } finally { fs.rmSync(f.dir, {recursive: true, force: true}); }
});

test('pause, resume, and remove stay inside one contact', () => {
  const f = dbFixture();
  try {
    f.db.enableContact(valentina, '15551234567', 'Valentina', [valentina]);
    f.db.enableContact(camila, '15550000002', 'Camila', [camila]);
    f.db.saveEvent({...incoming(camila, 'c1', 'Hola'), direction: 'incoming'});
    const draft = f.db.saveDraft({chatId: camila, revision: 1, options: suggested.options, model: 'mock'});
    assert.equal(f.db.activateDraft(draft.id, 'note-camila'), true);
    const paused = f.db.pauseContact('15550000002');
    assert.equal(paused.ok, true);
    assert.equal(f.db.isEnabled(camila), false);
    assert.equal(f.db.isEnabled(valentina), true);
    assert.equal(f.db.draft(draft.id).status, 'stale');
    assert.equal(f.db.aliasesFor(camila).includes(camila), true);
    const resumed = f.db.resumeContact('15550000002');
    assert.equal(resumed.ok, true);
    assert.equal(f.db.isEnabled(camila), true);
    assert.equal(f.db.draft(draft.id).status, 'stale');
    const removed = f.db.removeContact('15550000002');
    assert.equal(removed.ok, true);
    assert.equal(f.db.isEnabled(camila), false);
    assert.equal(f.db.contact(camila).archived, 1);
    assert.equal(f.db.isEnabled(valentina), true);
    assert.match(f.db.resumeContact('15550000002').text, /\/add/);
    assert.equal(f.db.canSendTo(camila), false);
    f.db.enableContact(camila, '15550000002', 'Camila', [camila]);
    assert.equal(f.db.isEnabled(camila), true);
    assert.equal(f.db.contact(camila).archived, 0);
  } finally { f.close(); }
});

test('draft lookup is exact and synthetic notification ids cannot be approved', () => {
  const f = dbFixture();
  try {
    f.db.saveEvent({...incoming(f.chat, 'm', 'Hola'), direction: 'incoming'});
    const draft = f.db.saveDraft({chatId: f.chat, revision: 1, options: suggested.options, model: 'mock'});
    const full = `true_${f.chat}_ABCDEF`;
    assert.equal(f.db.activateDraft(draft.id, full), true);
    assert.equal(f.db.draftByNotification('ABCDEF'), null);
    assert.equal(f.db.draftByNotification(`_${full.split('_').pop()}`), null);
    assert.equal(f.db.draftByNotification(full).chat_id, f.chat);
    assert.equal(f.db.draftByNotification(`${full}_out`).id, draft.id);
    const stanza = '3EB0915FCBE23D4E533071';
    f.db.db.prepare(`UPDATE drafts SET notification_whatsapp_id=? WHERE id=?`).run(`true_${f.chat}_${stanza}_out`, draft.id);
    assert.equal(f.db.draftByNotification(stanza), null);
    assert.equal(f.db.draftByStanza(stanza).id, draft.id);
    assert.equal(f.db.draftByStanza(`true_111@c.us_${stanza}`).id, draft.id);
    assert.equal(f.db.draftByStanza('ABCDEF'), null);
    f.db.db.prepare(`UPDATE drafts SET notification_whatsapp_id=? WHERE id=?`).run(full, draft.id);
    const quoted = f.db.claimApproval({
      notificationWhatsappId: full,
      approvalWhatsappId: 'approval-out',
      option: 1,
      now: new Date().toISOString(),
      dryRun: true
    });
    assert.equal(quoted.ok, true);
    assert.equal(f.db.activateDraft(draft.id, 'local-draft-4'), false);
    f.db.db.prepare(`UPDATE drafts SET status='active', notification_whatsapp_id=? WHERE id=?`).run('local-draft-4', draft.id);
    const filename = f.filename;
    f.db.close();
    const reopened = new Store(filename, {driver: 'builtin'});
    try {
      assert.equal(reopened.draft(draft.id).status, 'failed');
      assert.equal(reopened.draftByNotification('local-draft-4'), null);
    } finally { reopened.close(); }
  } finally { fs.rmSync(f.dir, {recursive: true, force: true}); }
});

test('resume ignores messages from before the contact was resumed', () => {
  const directory = createContactDirectory();
  directory.replace({chatId: camila, phone: '15550000002', displayName: 'Camila', aliases: [camila]});
  const duringPause = message(camila, 'during pause');
  duringPause.timestamp = 1000;
  directory.markFresh(camila, 1000 * 1000 + 10000);
  assert.equal(parseApprovedEvent(duringPause, 'incoming', directory, 300000, 0, 1000 * 1000 + 10000), null);
  const after = message(camila, 'after resume');
  after.timestamp = 1020;
  assert.equal(parseApprovedEvent(after, 'incoming', directory, 300000, 0, 1020 * 1000).chatId, camila);
});

test('routing uses the sender alias and ignores an unapproved chat', () => {
  const directory = createContactDirectory();
  directory.replace({chatId: valentina, phone: '15551234567', displayName: 'Valentina', aliases: [valentina]});
  directory.replace({chatId: camila, phone: '15550000002', displayName: 'Camila', aliases: [camila, '999@lid']});
  const fromCamila = parseApprovedEvent(message('999@lid', 'Qué haces?'), 'incoming', directory, 30000, 1000000, 1000000, valentina);
  assert.equal(fromCamila.chatId, camila);
  assert.equal(parseApprovedEvent(message('19998887777@c.us'), 'incoming', directory, 30000, 1000000, 1000000), null);
  assert.throws(() => directory.replace({chatId: valentina, phone: '15551234567', aliases: ['999@lid']}), /another contact/);
  assert.equal(isOwnerSelfMessage(command('/remove +15551234567', camila), owner, new Set([camila, '999@lid'])), false);
});

test('owner commands enroll, list, and pause without disabling the other contact', async () => {
  const f = dbFixture();
  const sent = [];
  const resolved = new Set([camila, '999@lid']);
  resolved.canonical = camila;
  resolved.displayName = 'Camila';
  const hooks = {
    ownerId: owner,
    resolve: async () => resolved,
    enable: (row) => f.db.enableContact(row.chatId, row.phone, row.displayName, row.aliases),
    list: async () => f.db.formatContactList(),
    pause: async (number) => f.db.pauseContact(number).text,
    resume: async (number) => f.db.resumeContact(number).text,
    remove: async (number) => f.db.removeContact(number).text,
    reply: async (_id, text) => sent.push(text)
  };
  try {
    assert.equal(parseOwnerCommand('/add +15550000002').command, 'add');
    assert.equal(parseOwnerCommand('hola /add +15550000002'), null);
    assert.equal(await handleOwnerCommand(command('/add +15550000002'), hooks), true);
    assert.equal(f.db.isEnabled(valentina), true);
    assert.equal(f.db.isEnabled(camila), true);
    assert.match(sent.at(-1), /Camila/);
    assert.equal(await handleOwnerCommand(command('/list'), hooks), true);
    assert.match(sent.at(-1), /ACTIVE CONTACTS \(2\)/);
    assert.match(sent.at(-1), /Valentina|15551234567/);
    assert.match(sent.at(-1), /Camila/);
    assert.equal(await handleOwnerCommand(command('/pause +15550000002'), hooks), true);
    assert.equal(f.db.isEnabled(camila), false);
    assert.equal(f.db.isEnabled(valentina), true);
    assert.equal(await handleOwnerCommand(command('/add +15550000002', camila), {...hooks, blocked: new Set([camila])}), false);
  } finally { f.close(); }
});

test('reverse-order quoted approvals send each option to its own contact', async () => {
  const f = dbFixture();
  try {
    f.db.enableContact(valentina, '15551234567', 'Valentina', [valentina]);
    f.db.enableContact(camila, '15550000002', 'Camila', [camila]);
    f.db.saveEvent({...incoming(valentina, 'a', 'El viernes estoy libre.'), direction: 'incoming'});
    f.db.saveEvent({...incoming(camila, 'b', 'Qué haces esta noche?'), direction: 'incoming'});
    const draftA = f.db.saveDraft({chatId: valentina, revision: 1, options: suggested.options, model: 'mock', expiresAt: '2099-01-01T00:00:00.000Z'});
    const draftB = f.db.saveDraft({chatId: camila, revision: 1, options: suggested.options, model: 'mock', expiresAt: '2099-01-01T00:00:00.000Z'});
    assert.equal(f.db.activateDraft(draftA.id, 'note-a', draftA.expires_at), true);
    assert.equal(f.db.activateDraft(draftB.id, 'note-b', draftB.expires_at), true);
    const sent = [];
    const client = {
      info: {wid: {_serialized: owner}},
      sendMessage: async (id, text) => {
        sent.push({id, text});
        return {id: {_serialized: `out-${sent.length}`}};
      }
    };
    const drafts = new DraftDelivery({
      client, label: 'Wrong global label', logger: quietLogger(),
      draftOnly: false, approvedSendEnabled: true,
      isApprovedRecipient: (chatId) => f.db.canSendTo(chatId)
    });
    const agent = new DatingAgent({db: f.db, drafts, config: agentConfig(), logger: quietLogger(), ai: {}, setTimer() { return 1; }, clearTimer() {}});
    const second = await agent.handleApproval({approvalWhatsappId: 'ap-b', quotedWhatsappId: 'note-b', option: 2});
    const first = await agent.handleApproval({approvalWhatsappId: 'ap-a', quotedWhatsappId: 'note-a', option: 1});
    assert.equal(second.ok, true);
    assert.equal(first.ok, true);
    assert.equal(sent.filter(item => item.id === camila).map(item => item.text).join(''), suggested.options[1].reply_es);
    assert.equal(sent.filter(item => item.id === valentina).map(item => item.text).join(''), suggested.options[0].reply_es);
    const notes = sent.filter(item => item.id === owner).map(item => item.text);
    assert.match(notes[0], /✓ Sent · Camila · #\d+ · Option 2/);
    assert.match(notes[1], /✓ Sent · Valentina · #\d+ · Option 1/);
    assert.equal(notes.some(text => text.includes('Wrong global label')), false);
    const suffix = await agent.handleApproval({approvalWhatsappId: 'ap-suffix', quotedWhatsappId: 'note-b'.slice(-3), option: 1});
    assert.equal(suffix.ok, false);
    assert.equal(sent.filter(item => item.id === camila || item.id === valentina).length, 2);
    agent.stop();
  } finally { f.close(); }
});

test('pausing one contact during generation does not notify that contact or block the other', async () => {
  const f = dbFixture();
  try {
    f.db.enableContact(valentina, '15551234567', 'Valentina', [valentina]);
    f.db.enableContact(camila, '15550000002', 'Camila', [camila]);
    const clock = new Clock();
    const gate = deferred();
    const calls = [];
    const delivered = [];
    const agent = new DatingAgent({
      db: f.db, config: agentConfig(), logger: quietLogger(),
      ai: {generate: async ({history}) => {
        calls.push(history.map(row => row.body));
        if (history.some(row => row.body === 'from-a')) await gate.promise;
        return suggested;
      }},
      drafts: {
        deliver: async (draft) => {
          delivered.push(draft.chat_id);
          return {status: 'notified', whatsappId: `note-${draft.id}`};
        },
        notifyOwner: async () => {}
      },
      setTimer: clock.setTimeout, clearTimer: clock.clearTimeout, now: () => clock.t
    });
    assert.equal(agent.onIncoming(incoming(valentina, 'a1', 'from-a')), true);
    assert.equal(agent.onIncoming(incoming(camila, 'b1', 'from-b')), true);
    clock.tick(45000);
    await new Promise((resolve) => setImmediate(resolve));
    f.db.pauseContact('15551234567');
    agent.pauseChat(valentina);
    gate.resolve();
    await agent.drain();
    assert.equal(delivered.includes(valentina), false);
    assert.equal(delivered.includes(camila), true);
    assert.equal(calls.some(history => history.includes('from-a') && history.includes('from-b')), false);
    assert.equal(calls.some(history => history.includes('from-b')), true);
    agent.stop();
  } finally { f.close(); }
});

test('a missing WhatsApp notification id does not become an approvable draft', async () => {
  const sent = [];
  const client = {
    info: {wid: {_serialized: owner}},
    sendMessage: async () => ({})
  };
  const drafts = new DraftDelivery({client, testChatId: camila, logger: quietLogger()});
  const draft = {id: 42, chat_id: valentina, options: suggested.options};
  const result = await drafts.deliver(draft, {beforeSend: () => true});
  assert.deepEqual(result, {status: 'failed', whatsappId: null});
  assert.equal(sent.length, 0);
  assert.equal(/local-draft-/.test(JSON.stringify(result)), false);
});
