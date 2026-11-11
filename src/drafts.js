'use strict';

const STYLE_LABELS = ['NATURAL', 'PLAYFUL', 'DIRECT'];
const CONTEXT_LIMIT = 200;

function draftIdFromNotification(body) {
  const text = String(body || '');
  const legacy = /^DRAFT #(\d+)/.exec(text);
  if (legacy) return Number(legacy[1]);
  const current = /^\*[^*\n]+\* · #(\d+)/.exec(text);
  return current ? Number(current[1]) : null;
}

function isDraftNotification(body) {
  return draftIdFromNotification(body) != null;
}

function clipContext(text, limit = CONTEXT_LIMIT) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= limit) return clean;
  const mark = '…';
  const budget = limit - mark.length;
  const head = Math.ceil(budget * 0.65);
  return `${clean.slice(0, head).trimEnd()}${mark}${clean.slice(clean.length - (budget - head)).trimStart()}`;
}

function quoteContext(recentIncoming, voiceTranscript) {
  const incoming = String(recentIncoming || '').replace(/\s+/g, ' ').trim();
  const voice = String(voiceTranscript || '').replace(/\s+/g, ' ').trim();
  return clipContext(incoming || voice);
}

function optionHeading(option, index) {
  const fallback = STYLE_LABELS[index] || String(option?.style || 'option').toUpperCase();
  const words = String(option?.label || '').trim().split(/\s+/).filter(Boolean);
  const usable = words.length >= 2 && words.length <= 4 && words.join(' ').length <= 48
    && words.every(word => /^[\p{L}\p{N}][\p{L}\p{N}'’-]*$/u.test(word));
  return (usable ? words.join(' ') : fallback).toUpperCase();
}

function whatsappId(result) {
  if (!result) return null;
  if (typeof result === 'string') return result;
  const id = result.id ?? result._data?.id;
  if (typeof id === 'string' && id) return id;
  if (id && typeof id === 'object') {
    if (typeof id._serialized === 'string' && id._serialized) return id._serialized;
    const remote = typeof id.remote === 'string' ? id.remote : id.remote?._serialized;
    const local = typeof id.id === 'string' ? id.id : '';
    if (remote && local) return `${id.fromMe ? 'true' : 'false'}_${remote}_${local}`;
  }
  if (typeof result._serialized === 'string' && result._serialized) return result._serialized;
  return null;
}

async function readSelfChatMessages(client) {
  if (!client?.pupPage) return [];
    return client.pupPage.evaluate(async () => {
    const plainId = (id) => {
      try {
        if (!id) return '';
        if (typeof id === 'string') return id;
        if (typeof id._serialized === 'string' && id._serialized) return id._serialized;
        const asString = id.toString?.();
        if (typeof asString === 'string' && asString.includes('@') && asString.includes('_')) return asString;
        const remote = id.remote?._serialized || (typeof id.remote === 'string' ? id.remote : '');
        const local = id.id || id._id;
        if (remote && local) return `${id.fromMe ? 'true' : 'false'}_${remote}_${local}`;
      } catch { /* non-serializable WhatsApp objects are skipped */ }
      return '';
    };
    const mine = new Set();
    const remember = (wid) => {
      const id = plainId(wid);
      if (id) mine.add(id);
      try {
        const asString = wid?.toString?.();
        if (asString && asString.includes('@')) mine.add(asString);
      } catch { /* wid string form is optional */ }
    };
    try {
      const {getMaybeMeLidUser, getMaybeMePnUser} = window.require('WAWebUserPrefsMeUser');
      remember(getMaybeMeLidUser());
      remember(getMaybeMePnUser());
    } catch { /* prefs module can be absent */ }
    try { remember(window.require('WAWebConnModel').Conn.wid); } catch { /* connection model unavailable */ }
    const rowFor = (msg, remote) => {
      const type = String(msg.type || 'chat');
      if (type !== 'chat' && type !== 'ptt' && type !== 'audio') return null;
      const quotedRemote = plainId(msg.quotedRemoteJid) || remote;
      const quotedId = plainId(msg.quotedMsg?.id) || (msg.quotedStanzaID ? `true_${quotedRemote}_${msg.quotedStanzaID}` : '');
      return {
        body: String(msg.body || '').slice(0, 2000),
        fromMe: true,
        type,
        isVoice: type === 'ptt' || Boolean(msg.isPtt),
        duration: Number(msg.duration) || undefined,
        hasQuotedMsg: Boolean(quotedId),
        timestamp: Number(msg.t) || 0,
        from: remote,
        to: remote,
        id: {_serialized: plainId(msg.id), remote, fromMe: true},
        quotedMessageId: quotedId
      };
    };
    const rows = [];
    const seen = new Set();
    const push = (msg, remote) => {
      const row = rowFor(msg, remote);
      if (!row?.id._serialized || seen.has(row.id._serialized)) return;
      seen.add(row.id._serialized);
      rows.push(row);
    };
    let chats = [];
    try { chats = window.require('WAWebCollections').Chat.getModelsArray(); } catch { chats = []; }
    for (const chat of chats) {
      const remote = plainId(chat.id);
      let isMe = false;
      try { isMe = Boolean(chat.contact?.isMe || chat.isMe); } catch { isMe = false; }
      let msgs = chat.msgs?.getModelsArray?.() || [];
      const holdsDraft = msgs.some((msg) => {
        const body = String(msg.body || '');
        return body.startsWith('DRAFT #') || /^\*[^*\n]+\* · #\d+/.test(body);
      });
      if (!isMe && !mine.has(remote) && !holdsDraft) continue;
      if (msgs.length < 30) {
        try {
          const loaded = await window.require('WAWebChatLoadMessages').loadEarlierMsgs({chat});
          if (Array.isArray(loaded) && loaded.length) msgs = loaded.concat(msgs);
        } catch { /* the open chat window is enough when history will not load */ }
      }
      for (const msg of msgs) push(msg, remote);
    }
    let models = [];
    try { models = window.require('WAWebCollections').Msg.getModelsArray(); } catch { models = []; }
    const byRemote = new Map();
    for (const msg of models) {
      const remote = plainId(msg.id?.remote);
      if (!remote) continue;
      if (!byRemote.has(remote)) byRemote.set(remote, []);
      byRemote.get(remote).push(msg);
    }
    for (const [remote, grouped] of byRemote) {
      const self = mine.has(remote) || grouped.some((msg) => {
        const body = String(msg.body || '');
        return body.startsWith('DRAFT #') || /^\*[^*\n]+\* · #\d+/.test(body);
      });
      if (!self) continue;
      for (const msg of grouped) push(msg, remote);
    }
    rows.sort((a, b) => a.timestamp - b.timestamp);
    return rows.slice(-40);
  });
}

async function sendPlainText(client, chatId, text) {
  if (client?.pupPage) {
    const id = await client.pupPage.evaluate(async (chatId, text) => {
      const plainId = (id) => {
        try {
          if (!id) return '';
          if (typeof id === 'string') return id;
          if (typeof id._serialized === 'string' && id._serialized) return id._serialized;
          const asString = id.toString?.();
          if (typeof asString === 'string' && asString.includes('@') && asString.includes('_')) return asString;
          const remote = id.remote?._serialized || (typeof id.remote === 'string' ? id.remote : '');
          const local = id.id || id._id;
          if (remote && local) return `${id.fromMe ? 'true' : 'false'}_${remote}_${local}`;
        } catch { return ''; }
        return '';
      };
      const chat = await window.WWebJS.getChat(chatId, {getAsModel: false});
      if (!chat) return '';
      const msg = await window.WWebJS.sendMessage(chat, text, {});
      return plainId(msg?.id) || plainId(chat.msgs?.last?.()?.id);
    }, chatId, text);
    if (id) return id;
  }
  const result = await client.sendMessage(chatId, text);
  return whatsappId(result);
}

async function idFromRecentSelfChat(client, ownerId, text) {
  const messages = await readSelfChatMessages(client);
  const match = [...messages].reverse().find((message) => message.body === text);
  return whatsappId(match);
}

function formatDraft(draft, label, recentIncoming = '', voiceTranscript = '') {
  const name = String(label || 'Draft').replace(/[*_~]/g, '').trim() || 'Draft';
  const quote = quoteContext(recentIncoming, voiceTranscript);
  const options = draft.options || [];
  const lines = [`*${name.toUpperCase()}* · #${draft.id}`, ''];
  if (quote) lines.push(`> ${quote}`, '');
  options.forEach((option, index) => {
    lines.push(`*${index + 1} · ${optionHeading(option, index)}*`);
    lines.push(option.reply_es);
    lines.push(`_${option.translation_en}_`);
    lines.push('');
  });
  lines.push(
    '──────────────',
    '↪ Reply *1 / 2 / 3* to send',
    '🎙 Reply with voice to revise',
    '_⏳ Awaiting approval_'
  );
  return lines.join('\n');
}

function formatConfirmation(draft, label) {
  const name = String(label || 'contact').replace(/[*_~]/g, '').trim() || 'contact';
  return `✓ Sent · ${name} · #${draft.id} · Option ${draft.selected_option}`;
}

function formatRejection(draft, code) {
  const id = draft?.id ? `Draft #${draft.id}` : 'That draft';
  if (code === 'stale') return `${id} is outdated.\n\nA newer message has arrived.\nPlease use the latest draft.`;
  if (code === 'paused') return `${id} belongs to a paused contact.\n\nNothing was sent.`;
  if (code === 'expired') return `${id} has expired.\n\nNothing was sent.`;
  if (code === 'sent' || code === 'sending' || code === 'duplicate-approval') return `${id} was already used.\n\nNothing else was sent.`;
  if (code === 'uncertain') return `${id} has an unconfirmed send.\n\nNothing else was sent. Check the chat before retrying.`;
  return `${id} cannot be approved.\n\nNothing was sent.`;
}

// Self-chat notifications and approved-contact sends live here.
// The model never chooses a recipient. Each send uses the draft's chat_id.
class DraftDelivery {
  constructor({client, enabled = true, testChatId, label = 'US Test Contact', logger = console,
    draftOnly = true, approvedSendEnabled = false, isApprovedRecipient = null}) {
    this.client = client;
    this.enabled = enabled;
    this.testChatId = testChatId;
    this.label = label;
    this.logger = logger;
    this.draftOnly = draftOnly;
    this.approvedSendEnabled = approvedSendEnabled;
    this.isApprovedRecipient = isApprovedRecipient;
  }
  selfId() {
    const id = this.client.info?.wid?._serialized;
    if (!id || typeof id !== 'string' || !/^\d+@(c\.us|lid)$/.test(id)) {
      throw new Error('Verified owner WhatsApp ID is unavailable; refusing delivery');
    }
    if (this.testChatId && id === this.testChatId) throw new Error('Owner ID equals test contact; refusing delivery');
    if (this.isApprovedRecipient?.(id)) throw new Error('Owner ID equals an approved contact; refusing delivery');
    return id;
  }
  async deliver(draft, {recentIncoming = '', voiceTranscript = '', beforeSend = () => true, label = ''} = {}) {
    const text = formatDraft(draft, label || this.label, recentIncoming, voiceTranscript);
    if (!this.enabled) {
      this.logger.info(`\n--- LOCAL DRAFT ---\n${text}\n--- END DRAFT ---`);
      return {status: 'local', whatsappId: null};
    }
    let ownerId;
    try { ownerId = this.selfId(); } catch (error) {
      this.logger.error(error.message);
      this.logger.info(`\n--- LOCAL FALLBACK DRAFT ---\n${text}\n--- END DRAFT ---`);
      return {status: 'failed', whatsappId: null};
    }
    if (!beforeSend()) return {status: 'stale', whatsappId: null};
    let id = null;
    try {
      id = await sendPlainText(this.client, ownerId, text);
    } catch (error) {
      this.logger.warn(`Self-chat send reported an error (${error.message}); checking whether WhatsApp stored the draft`);
    }
    try {
      if (!id) id = await idFromRecentSelfChat(this.client, ownerId, text);
      if (!id || String(id).startsWith('local-draft-')) {
        this.logger.error(`Draft #${draft.id} has no WhatsApp notification id and cannot be approved`);
        this.logger.info(`\n--- LOCAL FALLBACK DRAFT ---\n${text}\n--- END DRAFT ---`);
        return {status: 'failed', whatsappId: null};
      }
      return {status: 'notified', whatsappId: id};
    } catch (error) {
      this.logger.error(`Self-chat notification failed: ${error.message}`);
      this.logger.info(`\n--- LOCAL FALLBACK DRAFT ---\n${text}\n--- END DRAFT ---`);
      return {status: 'failed', whatsappId: null};
    }
  }
  canSendToContact() {
    return this.approvedSendEnabled === true && this.draftOnly === false;
  }
  async sendApproved({chatId, text}) {
    if (!this.canSendToContact()) return {ok: false, reason: 'send-disabled'};
    if (!chatId) return {ok: false, reason: 'missing-recipient'};
    if (typeof text !== 'string' || !text.trim()) return {ok: false, reason: 'empty-text'};
    let ownerId;
    try { ownerId = this.selfId(); }
    catch (error) { return {ok: false, reason: 'owner-unavailable'}; }
    if (chatId === ownerId) return {ok: false, reason: 'owner-recipient'};
    if (this.isApprovedRecipient && !this.isApprovedRecipient(chatId)) return {ok: false, reason: 'not-allowlisted'};
    const id = await sendPlainText(this.client, chatId, text);
    if (!id) {
      const error = new Error('Approved send returned no WhatsApp id');
      error.uncertain = true;
      throw error;
    }
    return {ok: true, whatsappId: id};
  }
  async notifyOwner(text) {
    try {
      const ownerId = this.selfId();
      await sendPlainText(this.client, ownerId, text);
    } catch (error) {
      this.logger.error(`Owner notice failed: ${error.message}`);
    }
  }
}
module.exports = {
  DraftDelivery, formatDraft, formatConfirmation, formatRejection, whatsappId, readSelfChatMessages,
  draftIdFromNotification, isDraftNotification
};
