'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {DatingAgent} = require('../src/agent');
const {DraftDelivery} = require('../src/drafts');
const {Store} = require('../src/db');
const {parseOwnerApproval} = require('../src/whatsapp');
const {dbFixture, agentConfig, quietLogger, incoming, suggested} = require('./helpers');

function harness({sendEnabled = true} = {}) {
  const f = dbFixture();
  const sent = [];
  const owner = '573009999999@c.us';
  const client = {
    info: {wid: {_serialized: owner}},
    sendMessage: async (id, text) => {
      sent.push({id, text});
      return {id: {_serialized: `out-${sent.length}`}};
    }
  };
  const drafts = new DraftDelivery({
    client, testChatId: f.chat, label: 'Wrong global label', logger: quietLogger(),
    draftOnly: !sendEnabled, approvedSendEnabled: sendEnabled,
    isApprovedRecipient: (chatId) => f.db.canSendTo(chatId)
  });
  const agent = new DatingAgent({
    db: f.db, drafts, config: {...agentConfig(), draftTtlMinutes: 120}, logger: quietLogger(),
    ai: {generate: async () => suggested}, setTimer() { return 1; }, clearTimer() {}
  });
  f.db.saveEvent({...incoming(f.chat, 'm1', 'Jajaja sí, el viernes estoy libre.'), direction: 'incoming'});
  const draft = f.db.saveDraft({
    chatId: f.chat, revision: 1, options: suggested.options, model: 'mock',
    expiresAt: new Date(Date.now() + 60 * 60000).toISOString()
  });
  assert.equal(f.db.activateDraft(draft.id, 'note-1', draft.expires_at), true);
  return {f, sent, owner, agent, draft};
}

test('Quoted 2 sends the stored playful Spanish text once', async () => {
  const x = harness();
  try {
    const result = await x.agent.handleApproval({approvalWhatsappId: 'ap-1', quotedWhatsappId: 'note-1', option: 2, label: 'Valentina'});
    assert.equal(result.ok, true);
    const toContact = x.sent.filter(item => item.id === x.f.chat);
    assert.equal(toContact.length, 1);
    assert.equal(toContact[0].text, suggested.options[1].reply_es);
    assert.equal(x.f.db.draft(x.draft.id).status, 'sent');
    assert.equal(x.f.db.draft(x.draft.id).selected_option, 2);
    assert.ok(x.f.db.draft(x.draft.id).sent_whatsapp_id);
    const confirmation = x.sent.find(item => item.id === x.owner);
    assert.match(confirmation.text, /✓ Sent · \+15551234567 · #\d+ · Option 2/);
    assert.equal(/Wrong global label/.test(confirmation.text), false);
    const again = await x.agent.handleApproval({approvalWhatsappId: 'ap-2', quotedWhatsappId: 'note-1', option: 2, label: 'Valentina'});
    assert.equal(again.ok, false);
    assert.equal(x.sent.filter(item => item.id === x.f.chat).length, 1);
  } finally { x.agent.stop(); x.f.close(); }
});

test('Options 1 and 3 select their own stored Spanish text', async () => {
  for (const option of [1, 3]) {
    const x = harness();
    try {
      await x.agent.handleApproval({approvalWhatsappId: `ap-${option}`, quotedWhatsappId: 'note-1', option, label: 'Valentina'});
      assert.equal(x.sent.find(item => item.id === x.f.chat).text, suggested.options[option - 1].reply_es);
    } finally { x.agent.stop(); x.f.close(); }
  }
});

test('Unquoted numbers, other text, and unrelated quotes do not send', async () => {
  const owner = '573009999999@c.us';
  const base = {fromMe: true, from: owner, to: owner, id: {_serialized: 'ap-x', remote: owner, fromMe: true}};
  assert.equal(await parseOwnerApproval({...base, body: '2'}, owner), null);
  assert.equal(await parseOwnerApproval({...base, body: '4', quotedMessageId: 'note-1'}, owner), null);
  assert.equal(await parseOwnerApproval({...base, body: 'send 2', quotedMessageId: 'note-1'}, owner), null);
  assert.equal(await parseOwnerApproval({...base, fromMe: false, id: {...base.id, fromMe: false}, body: '2', quotedMessageId: 'note-1'}, owner), null);
  const parsed = await parseOwnerApproval({...base, body: ' 2 ', quotedMessageId: 'note-1'}, owner);
  assert.equal(parsed.option, 2);
  assert.equal(parsed.quotedWhatsappId, 'note-1');
  const x = harness();
  try {
    const missing = await x.agent.handleApproval({approvalWhatsappId: 'ap-x', quotedWhatsappId: 'other-message', option: 2});
    assert.equal(missing.ok, false);
    assert.equal(x.sent.filter(item => item.id === x.f.chat).length, 0);
  } finally { x.agent.stop(); x.f.close(); }
});

test('A newer incoming message and an expired draft cannot be approved', async () => {
  const x = harness();
  try {
    x.agent.onIncoming(incoming(x.f.chat, 'm2', 'Espera'));
    const stale = await x.agent.handleApproval({approvalWhatsappId: 'ap-stale', quotedWhatsappId: 'note-1', option: 1});
    assert.equal(stale.code, 'stale');
    assert.equal(x.sent.filter(item => item.id === x.f.chat).length, 0);
  } finally { x.agent.stop(); x.f.close(); }
  const expired = harness();
  try {
    expired.f.db.db.prepare(`UPDATE drafts SET expires_at=? WHERE id=?`).run('2000-01-01T00:00:00.000Z', expired.draft.id);
    const result = await expired.agent.handleApproval({approvalWhatsappId: 'ap-old', quotedWhatsappId: 'note-1', option: 1});
    assert.equal(result.code, 'expired');
    assert.equal(expired.sent.filter(item => item.id === expired.f.chat).length, 0);
  } finally { expired.agent.stop(); expired.f.close(); }
});

test('The same approval id and a restart do not send again', async () => {
  const x = harness();
  try {
    await x.agent.handleApproval({approvalWhatsappId: 'ap-same', quotedWhatsappId: 'note-1', option: 1});
    const dup = await x.agent.handleApproval({approvalWhatsappId: 'ap-same', quotedWhatsappId: 'note-1', option: 1});
    assert.equal(dup.code, 'duplicate-approval');
    assert.equal(x.sent.filter(item => item.id === x.f.chat).length, 1);
    x.f.db.db.prepare(`UPDATE drafts SET status='sending' WHERE id=?`).run(x.draft.id);
    x.f.db.close();
    const reopened = new Store(x.f.filename, {driver: 'builtin'});
    try {
      assert.equal(reopened.draft(x.draft.id).status, 'uncertain');
    } finally { reopened.close(); }
  } finally { fs.rmSync(x.f.dir, {recursive: true, force: true}); }
});

test('An unquoted number sends nothing', async () => {
  const x = harness();
  try {
    const result = await x.agent.handleApproval({approvalWhatsappId: 'plain-3', quotedWhatsappId: '', option: 3, label: 'Valentina'});
    assert.equal(result.ok, false);
    assert.equal(result.code, 'unquoted');
    assert.equal(x.sent.filter(item => item.id === x.f.chat).length, 0);
    assert.equal(x.f.db.draft(x.draft.id).status, 'active');
    assert.match(x.sent.map(item => item.text).join('\n'), /Nothing was sent/);
  } finally { x.agent.stop(); x.f.close(); }
});

test('Sending stays off while DRAFT_ONLY or the approval flag blocks delivery', async () => {
  const x = harness({sendEnabled: false});
  try {
    const result = await x.agent.handleApproval({approvalWhatsappId: 'ap-off', quotedWhatsappId: 'note-1', option: 3});
    assert.equal(result.code, 'send-disabled');
    assert.equal(x.f.db.draft(x.draft.id).status, 'active');
    assert.equal(x.sent.filter(item => item.id === x.f.chat).length, 0);
  } finally { x.agent.stop(); x.f.close(); }
});

test('A manual outgoing message invalidates the active draft', () => {
  const x = harness();
  try {
    x.agent.onOutgoing(incoming(x.f.chat, 'manual', 'Yo respondo'));
    assert.equal(x.f.db.draft(x.draft.id).status, 'stale');
  } finally { x.agent.stop(); x.f.close(); }
});

test('Two claims of one active draft authorize one send', () => {
  const x = harness();
  try {
    const now = new Date().toISOString();
    const first = x.f.db.claimApproval({notificationWhatsappId: 'note-1', approvalWhatsappId: 'a', option: 1, now});
    const second = x.f.db.claimApproval({notificationWhatsappId: 'note-1', approvalWhatsappId: 'b', option: 2, now});
    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal(x.f.db.draft(x.draft.id).status, 'sending');
  } finally { x.agent.stop(); x.f.close(); }
});
