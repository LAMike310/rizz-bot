'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {DatingAgent} = require('../src/agent');
const {parseApprovedAudio} = require('../src/whatsapp');
const {formatDraft} = require('../src/drafts');
const {Clock, dbFixture, agentConfig, quietLogger, incoming, suggested} = require('./helpers');

const target = '15551234567@c.us';
const owner = '573001234567@c.us';
const aliases = new Set([target]);
aliases.canonical = target;

function voiceConfig() {
  return {...agentConfig(), incomingVoiceEnabled: true, incomingVoiceLanguage: 'es', incomingVoiceMaxSeconds: 120, incomingVoiceMaxBytes: 8000000, apiKey: 'test-key', openrouterSttModel: 'openai/whisper-large-v3-turbo', voiceSttTimeoutMs: 30000};
}
function setup({transcribe, aiGenerate = async () => suggested} = {}) {
  const f = dbFixture();
  const clock = new Clock();
  const calls = [];
  const transcribed = [];
  const notices = [];
  const agent = new DatingAgent({
    db: f.db, config: voiceConfig(), logger: quietLogger(),
    ai: {generate: async (args) => { calls.push(args); return aiGenerate(args); }},
    drafts: {
      deliver: async () => ({status: 'notified', whatsappId: 'note-1'}),
      notifyOwner: async (text) => { notices.push(text); }
    },
    setTimer: clock.setTimeout, clearTimer: clock.clearTimeout, now: () => clock.t,
    transcribe: async (args) => {
      transcribed.push(args);
      if (transcribe) return transcribe(args);
      return {text: 'Hola Mike, el viernes estoy libre.', model: 'openai/whisper-large-v3-turbo', language: 'es'};
    }
  });
  const audio = Buffer.from('ogg-bytes').toString('base64');
  const getMedia = async () => ({data: audio, mimetype: 'audio/ogg; codecs=opus'});
  return {...f, clock, agent, calls, transcribed, notices, getMedia};
}

test('approved voice notes are transcribed in Spanish and stored on the original message', async () => {
  const x = setup();
  try {
    assert.equal(x.agent.onIncomingAudio({chatId: x.chat, whatsappId: 'voice-1', timestamp: 100, seconds: 15, getMedia: x.getMedia}), true);
    assert.equal(x.agent.onIncomingAudio({chatId: x.chat, whatsappId: 'voice-1', timestamp: 100, seconds: 15, getMedia: x.getMedia}), false);
    await x.agent.drain();
    assert.equal(x.transcribed.length, 1);
    assert.equal(x.transcribed[0].language, 'es');
    assert.equal(x.transcribed[0].model, 'openai/whisper-large-v3-turbo');
    const row = x.db.messageByWhatsappId('voice-1');
    assert.equal(row.body, 'Hola Mike, el viernes estoy libre.');
    assert.equal(row.transcription_status, 'complete');
    assert.equal(row.source_type, 'voice');
    assert.equal(x.db.countMessages(x.chat), 1);
  } finally { x.agent.stop(); x.close(); }
});

test('voice and later text keep WhatsApp order and produce one draft', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const x = setup({transcribe: () => pending});
  try {
    x.agent.onIncomingAudio({chatId: x.chat, whatsappId: 'voice-1', timestamp: 100, seconds: 8, getMedia: x.getMedia});
    x.agent.onIncoming(incoming(x.chat, 't1', 'Pero después de las seis.', 108));
    x.agent.onIncoming(incoming(x.chat, 't2', 'Te sirve?', 116));
    x.clock.tick(45000);
    assert.equal(x.calls.length, 0);
    release({text: 'Hola Mike, el viernes estoy libre.', model: 'openai/whisper-large-v3-turbo', language: 'es'});
    await x.agent.drain();
    assert.equal(x.calls.length, 1);
    assert.deepEqual(x.calls[0].history.map(m => m.body), [
      'Hola Mike, el viernes estoy libre.',
      'Pero después de las seis.',
      'Te sirve?'
    ]);
  } finally { x.agent.stop(); x.close(); }
});

test('transcription that finishes before the quiet period still waits for debounce', async () => {
  const x = setup();
  try {
    x.agent.onIncomingAudio({chatId: x.chat, whatsappId: 'voice-1', timestamp: 100, seconds: 4, getMedia: x.getMedia});
    await x.agent.drain();
    assert.equal(x.calls.length, 0);
    x.clock.tick(45000);
    await x.agent.drain();
    assert.equal(x.calls.length, 1);
  } finally { x.agent.stop(); x.close(); }
});

test('manual takeover cancels a draft while the transcript is still stored', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const x = setup({transcribe: () => pending});
  try {
    x.agent.onIncomingAudio({chatId: x.chat, whatsappId: 'voice-1', timestamp: 100, seconds: 4, getMedia: x.getMedia});
    x.agent.onOutgoing(incoming(x.chat, 'mine', 'Yo respondo.'));
    release({text: 'Hola Mike', model: 'openai/whisper-large-v3-turbo', language: 'es'});
    await x.agent.drain();
    x.clock.tick(120000);
    await x.agent.drain();
    assert.equal(x.calls.length, 0);
    assert.equal(x.db.messageByWhatsappId('voice-1').body, 'Hola Mike');
  } finally { x.agent.stop(); x.close(); }
});

test('a failed transcript does not generate a draft and a later burst can', async () => {
  const x = setup({transcribe: async () => { throw new Error('timed out'); }});
  try {
    x.agent.onIncomingAudio({chatId: x.chat, whatsappId: 'voice-1', timestamp: 100, seconds: 4, getMedia: x.getMedia});
    await x.agent.drain();
    x.clock.tick(45000);
    await x.agent.drain();
    assert.equal(x.calls.length, 0);
    assert.equal(x.notices.length, 1);
    assert.equal(x.db.messageByWhatsappId('voice-1').transcription_status, 'failed');
    x.agent.onIncoming(incoming(x.chat, 'later', 'Hola de nuevo', 200));
    x.clock.tick(45000);
    await x.agent.drain();
    assert.equal(x.calls.length, 1);
    assert.match(x.calls[0].history[0].body, /could not be transcribed/);
  } finally { x.agent.stop(); x.close(); }
});

test('restart leaves a pending voice unusable for the next draft', () => {
  const f = dbFixture();
  try {
    const saved = f.db.saveIncomingVoice({whatsappId: 'voice-1', chatId: f.chat, timestamp: 100});
    assert.equal(saved.revision, 1);
    assert.equal(f.db.abandonPendingTranscriptions(), 1);
    assert.equal(f.db.pendingVoiceCount(f.chat), 0);
    assert.equal(f.db.messageByWhatsappId('voice-1').transcription_status, 'failed');
    assert.equal(f.db.history(f.chat, 10).some(row => row.transcription_status === 'pending'), false);
  } finally { f.close(); }
});

test('parser accepts approved ptt and audio, and ignores everyone else', () => {
  const now = 1000000;
  const base = {id: {_serialized: 'abc', fromMe: false}, from: target, to: owner, timestamp: 1000, hasMedia: true, duration: 15};
  assert.equal(parseApprovedAudio({...base, type: 'ptt'}, aliases, 30000, now, now).chatId, target);
  assert.equal(parseApprovedAudio({...base, type: 'audio', id: {_serialized: 'aud'}}, aliases, 30000, now, now).whatsappId, 'aud');
  assert.equal(parseApprovedAudio({...base, type: 'ptt', from: '999@c.us'}, aliases, 30000, now, now), null);
  assert.equal(parseApprovedAudio({...base, type: 'ptt', from: owner, to: owner, fromMe: true, id: {_serialized: 'self', fromMe: true}}, aliases, 30000, now, now), null);
  assert.equal(parseApprovedAudio({...base, type: 'ptt', from: '456@g.us'}, aliases, 30000, now, now), null);
  assert.equal(parseApprovedAudio({...base, type: 'ptt', hasMedia: false}, aliases, 30000, now, now), null);
  assert.equal(parseApprovedAudio({...base, type: 'image'}, aliases, 30000, now, now), null);
  const shown = formatDraft({id: 57, options: suggested.options}, 'Valentina', 'Hola Mike', 'Hola Mike, el viernes estoy libre.');
  assert.match(shown, /\*VALENTINA\* · #57/);
  assert.match(shown, /> Hola Mike/);
  assert.match(shown, /_All good\. And you\?_/);
});
