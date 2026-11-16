'use strict';

const fs = require('node:fs');
const {whatsappId, formatDraft} = require('./drafts');
const {isOwnerSelfMessage, quotedNotificationId} = require('./whatsapp');
const {transcribeAudio} = require('./transcribe');

function messageId(message) {
  return whatsappId(message) || whatsappId({id: message?._data?.id}) || '';
}

function mediaCandidates(message) {
  const values = [
    message?.id?._serialized,
    messageId(message),
    message?._data?.id?._serialized,
    message?.id?.id,
    message?._data?.id?.id
  ];
  return [...new Set(values.filter((value) => typeof value === 'string' && value))];
}

async function downloadVoiceMedia(client, message) {
  if (typeof message.downloadMedia === 'function') {
    try {
      const media = await message.downloadMedia();
      if (media?.data) return {data: media.data, mimetype: media.mimetype || '', filesize: media.filesize || null};
    } catch { /* the event payload often has no media key yet; the store retry follows */ }
  }
  if (!client?.pupPage) return {error: 'voice note media downloaded empty'};
  const result = await client.pupPage.evaluate(async (candidates) => {
    const plain = (id) => {
      try {
        if (!id) return '';
        if (typeof id === 'string') return id;
        if (typeof id._serialized === 'string' && id._serialized) return id._serialized;
        const remote = id.remote?._serialized || (typeof id.remote === 'string' ? id.remote : '');
        if (remote && id.id) return `${id.fromMe ? 'true' : 'false'}_${remote}_${id.id}`;
      } catch { return ''; }
      return '';
    };
    const shorts = new Set(candidates.map((id) => String(id).split('_').pop()).filter(Boolean));
    const Msg = window.require('WAWebCollections').Msg;
    const find = () => {
      for (const id of candidates) {
        const hit = Msg.get(id);
        if (hit) return hit;
      }
      const models = Msg.getModelsArray?.() || [];
      return models.find((msg) => {
        const full = plain(msg.id);
        const local = String(msg.id?.id || full.split('_').pop() || '');
        return shorts.has(local) || candidates.includes(full);
      }) || null;
    };
    let msg = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      msg = find();
      const stage = msg?.mediaData?.mediaStage || '';
      if (msg?.directPath || stage === 'RESOLVED') break;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    if (!msg) return {error: 'voice message was not in the WhatsApp store'};
    try {
      if (msg.mediaData?.mediaStage !== 'RESOLVED' && typeof msg.downloadMedia === 'function') {
        await msg.downloadMedia({downloadEvenIfExpensive: true, rmrReason: 1});
      }
    } catch (error) {
      return {error: `media resolve failed (${String(error?.message || error).slice(0, 120)})`};
    }
    const stage = msg.mediaData?.mediaStage || '';
    if (!msg.directPath) return {error: `voice media was not ready (${stage || 'no stage'})`};
    try {
      const mockQpl = {addAnnotations() { return this; }, addPoint() { return this; }};
      const declared = msg.mimetype && !String(msg.mimetype).includes('octet-stream')
        ? msg.mimetype
        : 'audio/ogg; codecs=opus';
      const decrypted = await window.require('WAWebDownloadManager').downloadManager.downloadAndMaybeDecrypt({
        directPath: msg.directPath,
        encFilehash: msg.encFilehash,
        filehash: msg.filehash,
        mediaKey: msg.mediaKey,
        mediaKeyTimestamp: msg.mediaKeyTimestamp,
        type: msg.type,
        mimetype: declared,
        signal: new AbortController().signal,
        downloadQpl: mockQpl
      });
      const data = await window.WWebJS.arrayBufferToBase64Async(decrypted);
      return {data, mimetype: declared, filesize: msg.size || null};
    } catch (error) {
      return {error: `decrypt failed (${String(error?.message || error).slice(0, 140)})`};
    }
  }, mediaCandidates(message));
  if (result?.data) return result;
  return {error: result?.error || 'voice note media downloaded empty'};
}

function isVoiceNote(message) {
  const type = String(message?.type || message?._data?.type || '').toLowerCase();
  return type === 'ptt' || Boolean(message?.isVoice || message?._data?.isPtt);
}

function audioFormat(mimetype) {
  const value = String(mimetype || '').toLowerCase();
  if (value.includes('ogg') || value.includes('opus')) return 'ogg';
  if (value.includes('wav')) return 'wav';
  if (value.includes('mpeg') || value.includes('mp3')) return 'mp3';
  if (value.includes('mp4') || value.includes('m4a') || value.includes('aac')) return 'm4a';
  if (value.includes('webm')) return 'webm';
  return '';
}

function durationSeconds(message) {
  const raw = message?.duration ?? message?._data?.duration;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function resolveQuotedDraft(db, _message, quotedId) {
  if (!quotedId || String(quotedId).startsWith('local-draft-')) return null;
  return db.draftByNotification(quotedId) || db.draftByStanza(quotedId);
}

function createVoiceSanity({db, config, log, ai = null, getDrafts = () => null, fetchImpl = globalThis.fetch, processed = new Set()}) {
  async function reply(ownerId, client, text) {
    await client.sendMessage(ownerId, text);
  }

  function transcribe(args) {
    return transcribeAudio({...args, fetchImpl, title: 'WhatsApp voice sanity check'});
  }

  async function handle({message, ownerId, client}) {
    if (!config.voiceSanityTestEnabled) return false;
    if (!isOwnerSelfMessage(message, ownerId)) return false;
    if (!isVoiceNote(message)) return false;

    const whatsappId = messageId(message);
    if (!whatsappId) {
      const id = message?.id;
      const keys = id && typeof id === 'object' ? Object.keys(id).slice(0, 8).join(',') : typeof id;
      log.warn(`Voice sanity ignored a self-chat voice note with no message id (id: ${keys || 'missing'})`);
      return true;
    }
    if (processed.has(whatsappId)) {
      log.info('Voice sanity ignored a repeated voice-note event');
      return true;
    }
    processed.add(whatsappId);

    const fail = async (reason) => {
      log.error(`Voice sanity failed: ${reason}`);
      try {
        await reply(ownerId, client, `VOICE TEST — FAIL\n\n${reason}\n\nNo dating reply was generated or sent.`);
      } catch (error) {
        log.error(`Voice sanity could not deliver the failure notice: ${error.message}`);
      }
    };

    try {
      const hasQuote = Boolean(
        message?.hasQuotedMsg
        || message?.quotedMessageId
        || message?._data?.quotedMsg
      );
      if (!hasQuote) {
        log.info('Voice sanity ignored an unquoted self-chat voice note');
        return true;
      }
      const quotedId = await quotedNotificationId(message);
      if (!quotedId) {
        await fail('Quoted message ID could not be retrieved.');
        return true;
      }
      const draft = await resolveQuotedDraft(db, message, quotedId);
      if (!draft) {
        await fail(`Quoted notification was not a stored draft (${quotedId.slice(0, 80)}). Reply to the draft message itself.`);
        return true;
      }

      const seconds = durationSeconds(message);
      if (seconds != null && seconds > config.voiceTestMaxSeconds) {
        await fail(`Voice note is ${seconds}s, over the ${config.voiceTestMaxSeconds}s limit.`);
        return true;
      }
      const media = await downloadVoiceMedia(client, message);
      if (!media?.data) {
        await fail(media?.error || 'Voice note media downloaded empty.');
        return true;
      }
      const mime = media.mimetype || '';
      const format = audioFormat(mime);
      const data = media.data;
      let bytes = 0;
      let audio = null;
      try {
        audio = data ? Buffer.from(data, 'base64') : Buffer.alloc(0);
        bytes = audio.length;
      } finally {
        audio = null;
      }
      if (!data || !bytes) {
        await fail('Voice note media downloaded empty.');
        return true;
      }
      if (bytes > config.voiceTestMaxBytes) {
        await fail(`Voice note is ${bytes} bytes, over the ${config.voiceTestMaxBytes} byte limit.`);
        return true;
      }
      if (!format) {
        await fail(`Audio MIME is not a known transcription format (${mime || 'unknown'}).`);
        return true;
      }

      log.info(`Voice sanity transcribing draft #${draft.id} (${format}, ${bytes} bytes${seconds == null ? '' : `, ${seconds}s`})`);
      const result = await transcribe({
        apiKey: config.apiKey,
        model: config.openrouterSttModel,
        data,
        format,
        timeoutMs: config.voiceSttTimeoutMs
      });
      const cost = result.cost == null ? 'not returned' : String(result.cost);
      const durationLine = seconds == null ? 'not exposed' : `${seconds} seconds`;
      await reply(ownerId, client, [
        'VOICE TEST — SUCCESS',
        '',
        `Draft: #${draft.id}`,
        'Quoted notification: MATCHED',
        `Audio: ${format.toUpperCase()}`,
        `Duration: ${durationLine}`,
        `Model: ${config.openrouterSttModel}`,
        `Latency: ${result.latencyMs} ms`,
        `OpenRouter cost: ${cost}`,
        '',
        'TRANSCRIPTION:',
        result.text,
        '',
        ai ? 'Revising that draft. Nothing is sent to the match unless you reply 1, 2, or 3.' : 'No dating reply was generated or sent.'
      ].join('\n'));
      log.info(`Voice sanity transcript delivered for draft #${draft.id} in ${result.latencyMs}ms`);
      if (ai) await publishRevision({draft, transcript: result.text, ownerId, client});
      return true;
    } catch (error) {
      await fail(error.message || 'Voice sanity failed');
      return true;
    }
  }

  async function publishRevision({draft, transcript, ownerId, client}) {
    const options = JSON.parse(draft.options_json || '[]');
    if (!Array.isArray(options) || options.length !== 3) {
      await reply(ownerId, client, `Draft #${draft.id} has no three options to revise.`);
      return;
    }
    const prompt = fs.readFileSync(config.promptPath, 'utf8');
    const profile = JSON.parse(fs.readFileSync(config.profilePath, 'utf8'));
    const history = db.history(draft.chat_id, config.maxHistory || 30);
    let response;
    try {
      response = await ai.revise({history, prompt, profile, options, feedback: transcript, draftId: draft.id});
    } catch (error) {
      log.error(`Voice revision failed: ${error.message}`);
      await reply(ownerId, client, `Revision failed: ${error.message}\n\nNothing was sent.`);
      return;
    }
    if (!response?.should_reply || response.options?.length !== 3) {
      await reply(ownerId, client, 'The model declined to revise that draft. Nothing was sent.');
      return;
    }
    const revision = db.revision(draft.chat_id);
    const expiresAt = new Date(Date.now() + (config.draftTtlMinutes || 120) * 60000).toISOString();
    const saved = revision === draft.revision
      ? db.saveDraft({chatId: draft.chat_id, revision, options: response.options, model: response.model, usage: response.usage, expiresAt})
      : null;
    const delivery = getDrafts();
    const contact = db.contact(draft.chat_id);
    const label = contact?.display_name || (contact?.phone ? `+${contact.phone}` : '');
    if (saved && delivery) {
      const result = await delivery.deliver({...saved, options: response.options}, {
        label,
        recentIncoming: '',
        beforeSend: () => db.isEnabled(draft.chat_id) && db.revision(draft.chat_id) === revision
      });
      if (result?.status === 'notified' && result.whatsappId && db.activateDraft(saved.id, result.whatsappId, expiresAt)) {
        log.info(`Voice revision delivered as draft #${saved.id}`);
        return;
      }
    }
    const shown = saved || {id: `${draft.id}-revision`, options: response.options};
    await reply(ownerId, client, formatDraft(shown, 'voice revision'));
    log.info(`Voice revision shown for draft #${draft.id} without a new approval`);
  }

  return {handle, transcribe, publishRevision};
}

module.exports = {createVoiceSanity, audioFormat, isVoiceNote, downloadVoiceMedia};
