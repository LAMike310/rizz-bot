'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createVoiceSanity} = require('../src/voice-sanity');
const path = require('node:path');
const {dbFixture, quietLogger, suggested} = require('./helpers');

const OWNER = '111@c.us';
const options = [
  {style: 'natural', reply_es: 'Hola', translation_en: 'Hi'},
  {style: 'playful', reply_es: 'Hola jaja', translation_en: 'Hi haha'},
  {style: 'direct', reply_es: 'Hola, cómo vas?', translation_en: 'Hi, how are you?'}
];

function config(overrides = {}) {
  return {
    voiceSanityTestEnabled: true,
    apiKey: 'test-key',
    openrouterSttModel: 'openai/whisper-large-v3-turbo',
    voiceTestMaxSeconds: 30,
    voiceTestMaxBytes: 5000000,
    voiceSttTimeoutMs: 30000,
    ...overrides
  };
}

function voice({id = 'voice-1', quoted = 'note-1', duration = 10, type = 'ptt', from = OWNER, download, getQuotedMessage}) {
  return {
    fromMe: true,
    from,
    to: OWNER,
    type,
    duration,
    hasQuotedMsg: Boolean(quoted),
    id: {_serialized: id},
    quotedMessageId: quoted || '',
    downloadMedia: download,
    getQuotedMessage
  };
}

function seed(db) {
  db.saveEvent({chatId: '15551234567@c.us', whatsappId: 'm1', body: 'Hi', direction: 'incoming', timestamp: 1});
  const draft = db.saveDraft({chatId: '15551234567@c.us', revision: 1, options, model: 'x'});
  assert.equal(db.activateDraft(draft.id, 'note-1'), true);
  return draft;
}

test('voice sanity is a no-op when the flag is off', async () => {
  const f = dbFixture();
  try {
    const calls = [];
    const sanity = createVoiceSanity({db: f.db, config: config({voiceSanityTestEnabled: false}), log: quietLogger()});
    const handled = await sanity.handle({
      ownerId: OWNER,
      client: {sendMessage: async (...args) => calls.push(args)},
      message: voice({})
    });
    assert.equal(handled, false);
    assert.equal(calls.length, 0);
  } finally { f.close(); }
});

test('voice sanity transcribes a quoted self-chat note once and only replies to the owner', async () => {
  const f = dbFixture();
  try {
    const draft = seed(f.db);
    const before = JSON.stringify(f.db.draft(draft.id));
    const sent = [];
    let fetches = 0;
    const audio = Buffer.from('ogg-bytes').toString('base64');
    const sanity = createVoiceSanity({
      db: f.db,
      config: config(),
      log: quietLogger(),
      fetchImpl: async (url, init) => {
        fetches += 1;
        assert.equal(url, 'https://openrouter.ai/api/v1/audio/transcriptions');
        const body = JSON.parse(init.body);
        assert.equal(body.model, 'openai/whisper-large-v3-turbo');
        assert.equal(body.input_audio.format, 'ogg');
        assert.equal(body.input_audio.data, audio);
        assert.match(init.headers.Authorization, /^Bearer /);
        return {
          ok: true,
          json: async () => ({text: 'Invite her for pizza, more playful, keep it short.', usage: {cost: 0.001}})
        };
      }
    });
    const message = voice({
      download: async () => ({mimetype: 'audio/ogg; codecs=opus', data: audio})
    });
    const client = {sendMessage: async (id, text) => sent.push({id, text})};
    assert.equal(await sanity.handle({message, ownerId: OWNER, client}), true);
    assert.equal(await sanity.handle({message, ownerId: OWNER, client}), true);
    assert.equal(fetches, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].id, OWNER);
    assert.match(sent[0].text, /VOICE TEST — SUCCESS/);
    assert.match(sent[0].text, new RegExp(`Draft: #${draft.id}`));
    assert.match(sent[0].text, /pizza/);
    assert.equal(JSON.stringify(f.db.draft(draft.id)), before);
  } finally { f.close(); }
});

test('voice sanity matches a short quoted stanza to the stored draft id', async () => {
  const f = dbFixture();
  try {
    f.db.saveEvent({chatId: '15551234567@c.us', whatsappId: 'm1', body: 'Hi', direction: 'incoming', timestamp: 1});
    const draft = f.db.saveDraft({chatId: '15551234567@c.us', revision: 1, options, model: 'x'});
    const stanza = '3EB0915FCBE23D4E533071';
    assert.equal(f.db.activateDraft(draft.id, `true_149835034435636@lid_${stanza}_out`), true);
    const sent = [];
    const audio = Buffer.from('ogg-bytes').toString('base64');
    const sanity = createVoiceSanity({
      db: f.db,
      config: config(),
      log: quietLogger(),
      fetchImpl: async () => ({ok: true, json: async () => ({text: 'mas corto'})})
    });
    assert.equal(await sanity.handle({
      ownerId: OWNER,
      client: {sendMessage: async (id, text) => sent.push({id, text})},
      message: voice({
        id: 'voice-stanza',
        quoted: stanza,
        download: async () => ({mimetype: 'audio/ogg', data: audio})
      })
    }), true);
    assert.match(sent[0].text, /VOICE TEST — SUCCESS/);
    assert.match(sent[0].text, new RegExp(`Draft: #${draft.id}`));
  } finally { f.close(); }
});

test('voice sanity ignores a quoted id that is not the stored notification id', async () => {
  const f = dbFixture();
  try {
    f.db.saveEvent({chatId: '15551234567@c.us', whatsappId: 'm1', body: 'Hi', direction: 'incoming', timestamp: 1});
    const draft = f.db.saveDraft({chatId: '15551234567@c.us', revision: 1, options, model: 'x'});
    const before = JSON.stringify(f.db.draft(draft.id));
    const sent = [];
    const sanity = createVoiceSanity({
      db: f.db,
      config: config(),
      log: quietLogger(),
      fetchImpl: async () => ({ok: true, json: async () => ({text: 'pizza, playful, short'})})
    });
    const message = voice({
      id: 'voice-body',
      quoted: '3EB0125DF4E536242D7925',
      download: async () => ({mimetype: 'audio/ogg', data: Buffer.from('ok').toString('base64')}),
      getQuotedMessage: async () => ({body: `DRAFT #${draft.id} — +1\n\n1. NATURAL`})
    });
    assert.equal(await sanity.handle({
      message, ownerId: OWNER, client: {sendMessage: async (id, text) => sent.push({id, text})}
    }), true);
    assert.match(sent[0].text, /not a stored draft/);
    assert.equal(JSON.stringify(f.db.draft(draft.id)), before);
    assert.equal(sent.some(item => /pizza/.test(item.text)), false);
  } finally { f.close(); }
});

test('voice sanity downloads from the WhatsApp store when the event has no media yet', async () => {
  const f = dbFixture();
  try {
    const draft = seed(f.db);
    const audio = Buffer.from('ogg-from-store').toString('base64');
    let fetches = 0;
    const sanity = createVoiceSanity({
      db: f.db,
      config: config(),
      log: quietLogger(),
      fetchImpl: async (_url, init) => {
        fetches += 1;
        assert.equal(JSON.parse(init.body).input_audio.data, audio);
        return {ok: true, json: async () => ({text: 'pizza'})};
      }
    });
    const sent = [];
    const message = voice({
      id: 'voice-late',
      download: async () => undefined
    });
    const client = {
      sendMessage: async (id, text) => sent.push({id, text}),
      pupPage: {evaluate: async () => ({data: audio, mimetype: 'audio/ogg; codecs=opus'})}
    };
    assert.equal(await sanity.handle({message, ownerId: OWNER, client}), true);
    assert.equal(fetches, 1);
    assert.match(sent[0].text, new RegExp(`Draft: #${draft.id}`));
  } finally { f.close(); }
});

test('a transcribed voice note revises the quoted draft and does not message the match', async () => {
  const f = dbFixture();
  try {
    const draft = seed(f.db);
    const before = f.db.draft(draft.id).status;
    const audio = Buffer.from('ogg-bytes').toString('base64');
    const revised = suggested.options.map((option, index) => index === 1
      ? {...option, reply_es: 'Y si mejor pizza, jaja?', translation_en: 'How about pizza instead, haha?'}
      : option);
    const sent = [];
    const delivered = [];
    const sanity = createVoiceSanity({
      db: f.db,
      config: config({
        promptPath: path.join(__dirname, '../prompts/dating.md'),
        profilePath: path.join(__dirname, '../prompts/me.json'),
        maxHistory: 30,
        draftTtlMinutes: 120
      }),
      log: quietLogger(),
      ai: {revise: async ({feedback, draftId}) => {
        assert.equal(draftId, draft.id);
        assert.match(feedback, /pizza/);
        return {should_reply: true, options: revised, model: 'mock', usage: null};
      }},
      getDrafts: () => ({
        deliver: async (next) => {
          delivered.push(next);
          return {status: 'notified', whatsappId: 'note-revised'};
        }
      }),
      fetchImpl: async () => ({ok: true, json: async () => ({text: 'Invite her for pizza.'})})
    });
    const message = voice({download: async () => ({mimetype: 'audio/ogg', data: audio})});
    await sanity.handle({
      message,
      ownerId: OWNER,
      client: {sendMessage: async (id, text) => sent.push({id, text})}
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].id, OWNER);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].options[1].reply_es, 'Y si mejor pizza, jaja?');
    assert.equal(f.db.draft(delivered[0].id).status, 'active');
    assert.equal(f.db.draft(draft.id).status, before);
  } finally { f.close(); }
});

test('voice sanity ignores unquoted notes and notes outside the self-chat', async () => {
  const f = dbFixture();
  try {
    const sent = [];
    const sanity = createVoiceSanity({
      db: f.db, config: config(), log: quietLogger(),
      fetchImpl: async () => { throw new Error('should not transcribe'); }
    });
    const client = {sendMessage: async (...args) => sent.push(args)};
    assert.equal(await sanity.handle({
      ownerId: OWNER, client,
      message: voice({quoted: '', id: 'bare'})
    }), true);
    assert.equal(await sanity.handle({
      ownerId: OWNER, client,
      message: voice({from: '15551234567@c.us', id: 'match-voice'})
    }), false);
    assert.equal(sent.length, 0);
  } finally { f.close(); }
});

test('voice sanity reports missing media, size, key, timeout, and a bad transcript without sending elsewhere', async () => {
  const f = dbFixture();
  try {
    seed(f.db);
    const sent = [];
    const client = {sendMessage: async (id, text) => sent.push({id, text})};
    const base = {db: f.db, config: config(), log: quietLogger()};

    let sanity = createVoiceSanity(base);
    await sanity.handle({
      ownerId: OWNER, client,
      message: voice({id: 'empty', download: async () => ({mimetype: 'audio/ogg', data: ''})})
    });

    sanity = createVoiceSanity({...base, config: config({voiceTestMaxBytes: 4})});
    await sanity.handle({
      ownerId: OWNER, client,
      message: voice({id: 'big', download: async () => ({mimetype: 'audio/ogg', data: Buffer.from('12345').toString('base64')})})
    });

    sanity = createVoiceSanity({...base, config: config({apiKey: ''})});
    await sanity.handle({
      ownerId: OWNER, client,
      message: voice({id: 'nokey', download: async () => ({mimetype: 'audio/ogg', data: Buffer.from('ok').toString('base64')})})
    });

    sanity = createVoiceSanity({
      ...base,
      config: config({voiceSttTimeoutMs: 20}),
      fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      })
    });
    await sanity.handle({
      ownerId: OWNER, client,
      message: voice({id: 'slow', download: async () => ({mimetype: 'audio/ogg', data: Buffer.from('ok').toString('base64')})})
    });

    sanity = createVoiceSanity({
      ...base,
      fetchImpl: async () => ({ok: true, json: async () => ({text: '  '})})
    });
    await sanity.handle({
      ownerId: OWNER, client,
      message: voice({id: 'bad', download: async () => ({mimetype: 'audio/ogg', data: Buffer.from('ok').toString('base64')})})
    });

    assert.equal(sent.length, 5);
    assert.ok(sent.every((row) => row.id === OWNER));
    assert.match(sent.map((row) => row.text).join('\n'), /empty/);
    assert.match(sent.map((row) => row.text).join('\n'), /byte limit/);
    assert.match(sent.map((row) => row.text).join('\n'), /OPENROUTER_API_KEY/);
    assert.match(sent.map((row) => row.text).join('\n'), /timed out/);
    assert.match(sent.map((row) => row.text).join('\n'), /no text/);
  } finally { f.close(); }
});
