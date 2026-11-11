'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {Client, LocalAuth} = require('whatsapp-web.js');
const {whatsappId, readSelfChatMessages} = require('./drafts');
const qrcode = require('qrcode-terminal');

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function localAuthOptions(config) {
  return {
    clientId: config.clientId || 'dating-agent',
    dataPath: config.authPath
  };
}

function projectChromePath(envPath) {
  if (envPath && fs.existsSync(envPath)) return envPath;
  const chromeRoot = path.join(__dirname, '..', '.cache', 'puppeteer', 'chrome');
  if (!fs.existsSync(chromeRoot)) return undefined;
  for (const version of fs.readdirSync(chromeRoot)) {
    const candidate = path.join(
      chromeRoot, version, 'chrome-mac-arm64',
      'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'
    );
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function chromeExecutablePath(envPath) {
  return projectChromePath(envPath) || (() => {
    try { return require('puppeteer').executablePath(); } catch { return undefined; }
  })();
}

function eventTimeMs(message, now) {
  const stamp = Number(message?.timestamp);
  if (!Number.isFinite(stamp)) return now;
  return stamp > 1e12 ? stamp : stamp * 1000;
}

function chatAddress(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return serializeWid(value);
}

function candidateChatIds(message) {
  return [
    chatAddress(message?.id?.remote),
    chatAddress(message?.from),
    chatAddress(message?.to),
    chatAddress(message?.author)
  ].filter(Boolean);
}

function whatsappMessageId(message) {
  if (!message?.id) return '';
  if (typeof message.id === 'string') return message.id;
  if (typeof message.id._serialized === 'string' && message.id._serialized) return message.id._serialized;
  const remote = chatAddress(message.id.remote) || chatAddress(message.from) || '';
  const local = typeof message.id.id === 'string' ? message.id.id : '';
  if (!remote || !local) return '';
  return `${message.id.fromMe ? 'me' : 'them'}_${remote}_${local}`;
}

function phoneMatchesDigits(candidate, number) {
  const value = digits(candidate);
  return Boolean(number) && value === number;
}

function savedContactName(contact) {
  const raw = contact?.name || contact?.shortName || contact?.pushname || '';
  const clean = String(raw).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!clean || /^\+?[\d\s()-]{8,}$/.test(clean)) return '';
  return clean;
}

function contactMatchesNumber(contact, number) {
  const values = [
    contact?.phoneNumber?.user,
    typeof contact?.phoneNumber === 'string' ? contact.phoneNumber : '',
    contact?.phoneNumber?._serialized
  ];
  return values.some((value) => phoneMatchesDigits(value, number));
}

function asDirectory(aliases) {
  if (!aliases) return null;
  if (typeof aliases.chatIdFor === 'function' && typeof aliases.has === 'function') return aliases;
  const canonical = aliases.canonical || '';
  return {
    has: (id) => aliases.has(id),
    chatIdFor: (id) => (aliases.has(id) ? (canonical || id) : '')
  };
}

function resolveApprovedChatId(message, directory) {
  if (!directory) return '';
  for (const id of candidateChatIds(message)) {
    const chatId = directory.chatIdFor(id);
    if (chatId) return chatId;
  }
  return '';
}

function createContactDirectory() {
  const byAlias = new Map();
  const byChat = new Map();
  const freshAfter = new Map();
  return {
    get size() { return byChat.size; },
    has(alias) { return byAlias.has(alias); },
    chatIdFor(alias) { return byAlias.get(alias)?.chatId || ''; },
    contact(chatId) { return byChat.get(chatId) || null; },
    contactByPhone(phone) {
      const hits = [...byChat.values()].filter((row) => row.phone === phone);
      return hits.length === 1 ? hits[0] : null;
    },
    contacts() { return [...byChat.values()]; },
    phones() { return [...byChat.values()].map((row) => row.phone); },
    aliasIds() { return [...byAlias.keys()]; },
    markFresh(chatId, ts) { freshAfter.set(chatId, ts); },
    freshAfter(chatId) { return freshAfter.get(chatId) || 0; },
    replace(contact) {
      const chatId = contact.chatId;
      if (!chatId) throw new Error('Missing chat id');
      const next = [...new Set([chatId, ...(contact.aliases || [])].map((alias) => String(alias || '').trim()).filter(Boolean))];
      for (const alias of next) {
        const owner = byAlias.get(alias);
        if (owner && owner.chatId !== chatId) {
          const error = new Error(`WhatsApp id ${alias} already belongs to another contact`);
          error.code = 'alias-collision';
          throw error;
        }
      }
      const previous = byChat.get(chatId);
      if (previous) {
        for (const alias of previous.aliases) {
          if (!next.includes(alias)) byAlias.delete(alias);
        }
      }
      const record = {chatId, phone: contact.phone, displayName: contact.displayName || '', aliases: next};
      byChat.set(chatId, record);
      for (const alias of next) byAlias.set(alias, record);
      return record;
    },
    unload(chatId) {
      const previous = byChat.get(chatId);
      if (!previous) return;
      for (const alias of previous.aliases) byAlias.delete(alias);
      byChat.delete(chatId);
    }
  };
}

function parseApprovedEvent(message, kind, aliases, maxEventAgeMs, readyAtMs, now, trustedChatId = '') {
  const directory = asDirectory(aliases);
  if (!message || !directory) return null;
  const tsMs = eventTimeMs(message, now);
  if (tsMs < now - maxEventAgeMs) return null;
  if (readyAtMs && tsMs < readyAtMs - maxEventAgeMs) return null;

  const body = typeof message.body === 'string' ? message.body : '';
  if (!body.trim()) return null;
  if (message.type && message.type !== 'chat') return null;

  const from = chatAddress(message.from);
  const to = chatAddress(message.to);
  const remote = chatAddress(message.id?.remote);
  if ([from, to, remote].some((id) => id.endsWith('@g.us'))) return null;
  if (from && to && from === to) return null;

  const fromMe = Boolean(message.fromMe || message.id?.fromMe);
  if (kind === 'incoming' && fromMe) return null;
  if (kind === 'outgoing' && !fromMe) return null;
  const chatId = resolveApprovedChatId(message, directory);
  if (!chatId) return null;
  if (typeof directory.freshAfter === 'function') {
    const floor = directory.freshAfter(chatId);
    if (floor && tsMs < floor - 2000) return null;
  }

  const whatsappId = whatsappMessageId(message);
  if (!whatsappId) return null;
  return {
    chatId,
    whatsappId,
    body,
    timestamp: Number.isFinite(Number(message.timestamp)) ? Number(message.timestamp) : Math.floor(now / 1000)
  };
}

function phoneMatchesApproved(pn, number, canonical) {
  const serialized = serializeWid(pn);
  const pnDigits = digits(serialized);
  return serialized === canonical || pnDigits === number;
}

function serializeWid(wid) {
  if (!wid) return '';
  if (typeof wid === 'string') return wid;
  if (typeof wid._serialized === 'string') return wid._serialized;
  if (wid.user && wid.server) return `${wid.user}@${wid.server}`;
  return '';
}

async function resolveTestContact(client, rawNumber, logger = console) {
  const number = digits(rawNumber);
  if (!/^\d{8,15}$/.test(number)) throw new Error('Invalid test contact number');
  const wid = await client.getNumberId(number);
  let canonical = serializeWid(wid);
  const aliases = new Set();
  if (canonical.endsWith('@lid')) aliases.add(canonical);
  if (!canonical.endsWith('@c.us') && typeof client.getContacts === 'function') {
    const contacts = await client.getContacts();
    const match = (contacts || []).find((contact) => {
      const id = serializeWid(contact?.id);
      const contactNumber = digits(contact?.number || contact?.id?.user);
      return id.endsWith('@c.us') && (contactNumber === number || id.startsWith(`${number}@`));
    });
    if (match) canonical = serializeWid(match.id);
  }
  if (!canonical.endsWith('@c.us')) {
    const reason = wid == null ? 'WhatsApp has no account for that number' : 'lookup did not return a phone chat id';
    throw new Error(`Approved test contact could not be resolved (${reason}); allowlist remains disabled`);
  }
  const owner = serializeWid(client.info?.wid);
  if (owner && owner === canonical) {
    throw new Error('Test contact resolves to the owner account; refusing');
  }
  aliases.add(canonical);
  aliases.canonical = canonical;
  aliases.displayName = '';
  if (typeof client.getContacts === 'function') {
    try {
      for (const contact of (await client.getContacts()) || []) {
        const id = serializeWid(contact?.id);
        const contactNumber = digits(contact?.number || contact?.id?.user || contact?.phoneNumber?.user);
        const matches = (contactNumber === number && id) || id === canonical || contactMatchesNumber(contact, number);
        if (contactNumber === number && id) aliases.add(id);
        if (matches && !aliases.displayName) aliases.displayName = savedContactName(contact);
      }
    } catch (error) {
      logger.warn?.(`Contact book scan failed (${error.message}); continuing with the confirmed phone ID`);
    }
  }
  if (typeof client.getContactLidAndPhone === 'function') {
    try {
      const rows = await client.getContactLidAndPhone([canonical, ...aliases]);
      for (const row of rows || []) {
        if (phoneMatchesApproved(row?.pn, number, canonical) && row?.lid) aliases.add(serializeWid(row.lid));
      }
    } catch (error) {
      logger.warn?.(`LID lookup failed (${error.message}); continuing with the confirmed phone ID`);
    }
  }
  return aliases;
}

function chatMatchesApproved(chat, aliases, number) {
  const id = serializeWid(chat?.id);
  if (!id || id.endsWith('@g.us') || id.endsWith('@newsletter')) return false;
  const user = digits(chat?.id?.user || id);
  return aliases.has(id) || user === number;
}

async function scanApprovedMessages(client, numbers, aliasIds) {
  const enrolled = (Array.isArray(numbers) ? numbers : [numbers]).filter(Boolean);
  if (!client.pupPage) return {scanned: 0, messages: [], links: [], newest: 'none'};
  const rows = await client.pupPage.evaluate(async (numbers, aliasIds) => {
    const onlyDigits = (value) => String(value || '').replace(/\D/g, '');
    const samePhone = (candidate) => {
      const value = onlyDigits(candidate);
      if (!value || value.length < 8) return '';
      const hits = numbers.filter((number) => value === number);
      return hits.length === 1 ? hits[0] : '';
    };
    const widOf = (remote) => {
      try { return window.require('WAWebWidFactory').createWid(remote); }
      catch { return null; }
    };
    const asPhone = (resolved) => {
      const server = resolved?.server || '';
      if (server && server !== 'c.us' && server !== 's.whatsapp.net') return '';
      return onlyDigits(resolved?.user || '');
    };
    const phoneOfWid = (wid) => {
      if (!wid) return '';
      const attempts = [
        () => window.require('WAWebApiContact').getPhoneNumber(wid),
        () => window.require('WAWebLidMigrationUtils').toPn(wid),
        () => window.require('WAWebApiContact').getAlternateUserWid(wid)
      ];
      for (const attempt of attempts) {
        try {
          const phone = asPhone(attempt());
          if (phone) return phone;
        } catch {
          // Try the next resolver.
        }
      }
      try {
        const contact = window.require('WAWebCollections').Contact.get(wid);
        return asPhone(contact?.phoneNumber);
      } catch {
        return '';
      }
    };
    const phoneForRemote = async (remote) => {
      if (!remote || remote.endsWith('@g.us') || remote.endsWith('@newsletter')) return '';
      if (phoneById.has(remote)) return phoneById.get(remote);
      if (remote.endsWith('@c.us') || remote.endsWith('@s.whatsapp.net')) {
        const phone = onlyDigits(remote);
        phoneById.set(remote, phone);
        return phone;
      }
      const wid = widOf(remote);
      try { await window.require('WAWebQueryExistsJob').queryWidExists(wid); } catch { /* lookup can still succeed */ }
      const phone = phoneOfWid(wid);
      phoneById.set(remote, phone);
      return phone;
    };
    const collections = window.require('WAWebCollections');
    const aliases = new Set(aliasIds);
    const links = [];
    const phoneById = window.__rizzPhoneById || (window.__rizzPhoneById = new Map());
    const rememberContact = (contact) => {
      const id = contact?.id?._serialized || '';
      if (!id || id.endsWith('@g.us') || id.endsWith('@newsletter')) return;
      const phone = onlyDigits(contact.phoneNumber?.user || contact.phoneNumber);
      if (phone) phoneById.set(id, phone);
      const matched = samePhone(phone) || samePhone(id);
      if (matched) {
        aliases.add(id);
        links.push({alias: id, phone: matched});
      }
    };
    for (const contact of collections.Contact.getModelsArray?.() || []) rememberContact(contact);
    for (const number of numbers) {
      try {
        const phoneWid = window.require('WAWebWidFactory').createWid(`${number}@c.us`);
        rememberContact(collections.Contact.get(phoneWid));
        const lid = window.require('WAWebApiContact').getCurrentLid(phoneWid);
        if (lid) {
          const lidId = lid._serialized || `${lid.user}@${lid.server}`;
          aliases.add(lidId);
          links.push({alias: lidId, phone: number});
          rememberContact(collections.Contact.get(lid));
        }
      } catch {
        // The saved contact list above is enough when this lookup is unavailable.
      }
    }
    const remoteOf = (msg) => msg?.id?.remote?._serialized
      || (msg?.id?.remote?.user && msg?.id?.remote?.server ? `${msg.id.remote.user}@${msg.id.remote.server}` : '');
    const approvedRemote = async (remote) => Boolean(remote) && (aliases.has(remote) || samePhone(await phoneForRemote(remote)));
    const messages = [];
    const seen = new Set();
    const consider = async (msg, trustedPhone = '') => {
      if (!msg) return;
      const id = msg.id?._serialized || '';
      const remote = remoteOf(msg);
      if (!id || seen.has(id)) return;
      let phone = typeof trustedPhone === 'string' ? trustedPhone : '';
      if (!phone && remote) phone = samePhone(phoneById.get(remote)) || samePhone(await phoneForRemote(remote));
      if (!phone && !(await approvedRemote(remote)) && !aliases.has(remote)) return;
      seen.add(id);
      if (remote && phone) links.push({alias: remote, phone});
      messages.push({model: window.WWebJS.getMessageModel(msg), phone});
    };
    for (const chat of collections.Chat.getModelsArray?.() || []) {
      const remote = chat.id?._serialized || '';
      const phone = samePhone(chat.id?.user) || samePhone(chat.contact?.phoneNumber) || samePhone(phoneById.get(remote));
      const known = aliases.has(remote) || Boolean(phone);
      if (!known) continue;
      let msgs = chat.msgs?.getModelsArray?.() || [];
      if (msgs.length < 8) {
        try {
          const earlier = await window.require('WAWebChatLoadMessages').loadEarlierMsgs({chat});
          if (earlier?.length) msgs = [...earlier, ...msgs];
        } catch {
          // Keep the messages already attached to this chat.
        }
      }
      for (const msg of msgs.slice(-12)) await consider(msg, phone);
      if (chat.lastReceivedKey?._serialized) await consider(collections.Msg.get(chat.lastReceivedKey._serialized), phone);
    }
    const stored = collections.Msg.getModelsArray?.() || [];
    for (const msg of stored) {
      if (aliases.has(remoteOf(msg))) await consider(msg, '');
    }
    const newestMsg = stored.at(-1);
    const newestRemote = remoteOf(newestMsg);
    const newestPhone = await phoneForRemote(newestRemote);
    const newest = newestMsg
      ? `${aliases.size} ids; newest ${newestRemote.split('@')[1] || 'unknown'} type=${newestMsg.type || 'unknown'} phone=${samePhone(newestPhone) ? 'approved' : newestPhone ? 'different-number' : 'missing'}`
      : 'none';
    return {scanned: stored.length, messages, links, newest};
  }, enrolled, [...aliasIds]);
  return {
    scanned: rows.scanned,
    messages: rows.messages || [],
    links: rows.links || [],
    newest: rows.newest || 'none'
  };
}

async function loadOpenChats(client) {
  if (client.pupPage) {
    try {
      const rows = await client.pupPage.evaluate(async () => {
        const collection = window.require('WAWebCollections').Chat;
        const models = typeof collection.getModelsArray === 'function'
          ? collection.getModelsArray()
          : [];
        const loaded = [];
        for (const chat of models) {
          let msgs = chat.msgs?.getModelsArray?.() || [];
          if (msgs.length < 8) {
            try {
              const earlier = await window.require('WAWebChatLoadMessages').loadEarlierMsgs({chat});
              if (earlier?.length) msgs = [...earlier, ...msgs];
            } catch {
              // Keep whatever is already loaded in this chat.
            }
          }
          loaded.push({
            id: chat.id?._serialized || (chat.id?.user && chat.id?.server ? `${chat.id.user}@${chat.id.server}` : ''),
            user: chat.id?.user || '',
            messages: msgs.slice(-8).map((message) => window.WWebJS.getMessageModel(message))
          });
        }
        return loaded;
      });
      return rows.map((row) => ({
        id: {_serialized: row.id, user: row.user},
        messages: row.messages
      }));
    } catch {
      // Fall through to the library chat list.
    }
  }
  if (typeof client.getChats !== 'function') return [];
  const chats = await client.getChats();
  const loaded = [];
  for (const chat of chats || []) {
    let messages = [];
    try { messages = await chat.fetchMessages({limit: 8}); } catch { messages = []; }
    loaded.push({id: chat.id, messages});
  }
  return loaded;
}

async function rememberChatsFromStore(client, aliases, number, logger) {
  const chats = await loadOpenChats(client);
  let matched = 0;
  for (const chat of chats) {
    if (!chatMatchesApproved(chat, aliases, number)) continue;
    const id = serializeWid(chat.id);
    if (id) aliases.add(id);
    matched += 1;
  }
  logger.info?.(`Approved chat discovery matched ${matched} open chat id(s)`);
  return chats;
}

async function linkContactAlias(client, aliases, number, rawId) {
  const id = chatAddress(rawId);
  if (!id || aliases.has(id) || !client.pupPage) return false;
  const matched = await client.pupPage.evaluate((contactId, expected) => {
    let contact = null;
    try { contact = window.require('WAWebCollections').Contact.get(contactId); } catch { return false; }
    if (!contact) return false;
    const digits = (value) => String(value?.user || value || '').replace(/\D/g, '');
    const phones = [contact.phoneNumber?.user, typeof contact.phoneNumber === 'string' ? contact.phoneNumber : '', contact.phoneNumber?._serialized]
      .map(digits)
      .filter((value) => value.length >= 10);
    return phones.some((value) => value === expected);
  }, id, number);
  if (matched) aliases.add(id);
  return matched;
}

async function rememberApprovedAlias(client, aliases, number, rawId, logger) {
  const id = chatAddress(rawId);
  if (!id || aliases.has(id) || id.endsWith('@g.us') || id.endsWith('@newsletter')) return false;
  if (typeof client.getContactLidAndPhone !== 'function') return false;
  try {
    const rows = await client.getContactLidAndPhone([id]);
    for (const row of rows || []) {
      const pn = serializeWid(row?.pn);
      if (!phoneMatchesApproved(pn, number, aliases.canonical)) continue;
      aliases.add(id);
      const lid = serializeWid(row.lid);
      if (lid) aliases.add(lid);
      if (pn) aliases.add(pn);
      logger.info?.('Mapped an incoming hidden chat id to the approved contact');
      return true;
    }
  } catch (error) {
    logger.warn?.(`Live LID map failed (${error.message})`);
  }
  return false;
}

function parseOwnerCommand(body) {
  const text = String(body || '').trim();
  const add = text.match(/^\/add\s+\+?(\d{8,15})$/i);
  if (add) return {command: 'add', number: add[1]};
  const managed = text.match(/^\/(pause|resume|remove)\s+\+?(\d{8,15})$/i);
  if (managed) return {command: managed[1].toLowerCase(), number: managed[2]};
  if (/^\/list$/i.test(text)) return {command: 'list', number: ''};
  return null;
}

function parseAddCommand(body) {
  const parsed = parseOwnerCommand(body);
  return parsed?.command === 'add' ? parsed.number : null;
}

function approvalChoice(body) {
  const match = String(body || '').trim().match(/^([123])$/);
  return match ? Number(match[1]) : null;
}

function bareStanza(value) {
  const id = String(value || '');
  return /^[A-F0-9]{16,}$/i.test(id) ? id : '';
}

async function quotedNotificationId(message) {
  const direct = typeof message?.quotedMessageId === 'string' ? message.quotedMessageId : '';
  if (direct.includes('@')) return direct;
  const embedded = whatsappId(message?._data?.quotedMsg) || '';
  if (embedded.includes('@')) return embedded;
  if (message?.hasQuotedMsg && typeof message.getQuotedMessage === 'function') {
    try {
      const quoted = whatsappId(await message.getQuotedMessage());
      if (quoted && quoted.includes('@')) return quoted;
    } catch { /* the quoted message is not loaded yet */ }
  }
  const stanza = bareStanza(direct) || bareStanza(message?._data?.quotedStanzaID) || bareStanza(embedded);
  const remote = chatAddress(message?._data?.quotedRemoteJid)
    || chatAddress(message?.id?.remote)
    || chatAddress(message?.from)
    || chatAddress(message?.to);
  if (stanza && remote) return `true_${remote}_${stanza}`;
  return direct || embedded || null;
}

async function parseOwnerApproval(message, ownerId, testChatId = '') {
  if (!isOwnerSelfMessage(message, ownerId, testChatId)) return null;
  const option = approvalChoice(message?.body);
  if (!option) return null;
  const quotedWhatsappId = await quotedNotificationId(message);
  if (!quotedWhatsappId) return null;
  const approvalWhatsappId = message?.id?._serialized || (typeof message?.id === 'string' ? message.id : '');
  if (!approvalWhatsappId) return null;
  return {option, quotedWhatsappId, approvalWhatsappId};
}

function blockedChatIds(value) {
  if (!value) return new Set();
  if (value instanceof Set) return value;
  return new Set([value]);
}

function isOwnerSelfMessage(message, ownerId, blocked = '') {
  if (!ownerId) return false;
  if (!Boolean(message?.fromMe || message?.id?.fromMe)) return false;
  const ids = [chatAddress(message?.from), chatAddress(message?.to), chatAddress(message?.id?.remote)].filter(Boolean);
  if (!ids.length) return false;
  if (ids.every((id) => id === ownerId)) return true;
  const only = new Set(ids);
  if (only.size !== 1) return false;
  const chatId = ids[0];
  if (chatId.endsWith('@g.us') || chatId.endsWith('@newsletter')) return false;
  if (blockedChatIds(blocked).has(chatId)) return false;
  return chatId.endsWith('@c.us') || chatId.endsWith('@lid');
}

async function handleOwnerCommand(message, hooks) {
  const parsed = parseOwnerCommand(message?.body);
  if (!isOwnerSelfMessage(message, hooks.ownerId, hooks.blocked)) {
    if (parsed) hooks.log?.warn(`Ignored /${parsed.command}: message is not Message Yourself`);
    return false;
  }
  if (!parsed) return false;
  hooks.log?.info(`Running /${parsed.command}${parsed.number ? ` +${parsed.number}` : ''} from Message Yourself`);
  const reply = (text) => hooks.reply(hooks.ownerId, text);
  try {
    if (parsed.command === 'add') {
      const resolved = await hooks.resolve(parsed.number);
      hooks.enable({
        chatId: resolved.canonical,
        phone: parsed.number,
        displayName: resolved.displayName || '',
        aliases: [...resolved]
      });
      const who = resolved.displayName || `+${parsed.number}`;
      await reply(`Drafting enabled for ${who}.`);
    } else if (parsed.command === 'list') {
      await reply(await hooks.list());
    } else if (parsed.command === 'pause') {
      await reply(await hooks.pause(parsed.number));
    } else if (parsed.command === 'resume') {
      await reply(await hooks.resume(parsed.number));
    } else if (parsed.command === 'remove') {
      await reply(await hooks.remove(parsed.number));
    }
  } catch (error) {
    await reply(`Could not ${parsed.command}: ${error.message}`);
  }
  return true;
}

function isIncomingAudio(message) {
  const type = String(message?.type || message?._data?.type || '').toLowerCase();
  return type === 'ptt' || type === 'audio' || Boolean(message?.isVoice || message?._data?.isPtt);
}

function parseApprovedAudio(message, aliases, maxEventAgeMs, readyAtMs, now, trustedChatId = '') {
  const directory = asDirectory(aliases);
  if (!message || !directory || !isIncomingAudio(message)) return null;
  if (message.hasMedia === false) return null;
  const tsMs = eventTimeMs(message, now);
  if (tsMs < now - maxEventAgeMs) return null;
  if (readyAtMs && tsMs < readyAtMs - maxEventAgeMs) return null;
  const from = chatAddress(message.from);
  const to = chatAddress(message.to);
  const remote = chatAddress(message.id?.remote);
  if ([from, to, remote].some((id) => id.endsWith('@g.us'))) return null;
  if (from && to && from === to) return null;
  if (Boolean(message.fromMe || message.id?.fromMe)) return null;
  const chatId = resolveApprovedChatId(message, directory);
  if (!chatId) return null;
  if (typeof directory.freshAfter === 'function') {
    const floor = directory.freshAfter(chatId);
    if (floor && tsMs < floor - 2000) return null;
  }
  const whatsappId = whatsappMessageId(message);
  if (!whatsappId) return null;
  const duration = Number(message.duration ?? message._data?.duration);
  return {
    chatId,
    whatsappId,
    timestamp: Number.isFinite(Number(message.timestamp)) ? Number(message.timestamp) : Math.floor(now / 1000),
    seconds: Number.isFinite(duration) && duration >= 0 ? duration : null
  };
}

function skipReason(message, aliases, maxEventAgeMs = 30000, readyAtMs = 0, now = Date.now()) {
  const directory = asDirectory(aliases);
  if (!directory) return 'allowlist-not-ready';
  if (message?.type && message.type !== 'chat') return `type:${message.type}`;
  const from = chatAddress(message?.from);
  const to = chatAddress(message?.to);
  const remote = chatAddress(message?.id?.remote);
  if ([from, to, remote].some((id) => id.endsWith('@g.us'))) return 'group';
  if (from && to && from === to) return 'self-chat';
  const fromMe = Boolean(message?.fromMe || message?.id?.fromMe);
  const ids = candidateChatIds(message);
  if (!ids.length) return 'missing-chat-id';
  if (!ids.some((id) => directory.has(id))) {
    const sample = ids.find((id) => id.endsWith('@lid')) ? 'lid' : (ids[0].split('@')[1] || 'unknown');
    return `not-allowlisted:${sample}`;
  }
  if (!(typeof message?.body === 'string' && message.body.trim())) return 'empty-body';
  if (!whatsappMessageId(message)) return 'missing-id';
  const tsMs = eventTimeMs(message, now);
  if (tsMs < now - maxEventAgeMs || (readyAtMs && tsMs < readyAtMs - maxEventAgeMs)) return 'stale-timestamp';
  return 'filtered';
}

function createWhatsAppClient(config, log, handlers) {
  const executablePath = chromeExecutablePath(config.chromeExecutable);
  const puppeteer = {
    headless: config.headless === true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  };
  if (executablePath) puppeteer.executablePath = executablePath;

  const client = new Client({
    authStrategy: new LocalAuth(localAuthOptions(config)),
    puppeteer
  });

  let readyAt = 0;
  let accepting = false;
  const directory = createContactDirectory();
  let pollTimer = null;
  let lastPollLog = 0;
  let lastSelfPollLog = 0;
  let pollBusy = false;
  let missingChatLogged = false;
  const seenMessageIds = new Set();
  const blockedAliases = () => new Set(directory.aliasIds());

  function adoptContact(contact) {
    directory.replace({
      chatId: contact.chatId,
      phone: contact.phone,
      displayName: contact.displayName || '',
      aliases: contact.aliases || []
    });
  }

  function rememberLink(chatId, alias) {
    const id = chatAddress(alias);
    if (!id || !chatId || id.endsWith('@g.us') || id.endsWith('@newsletter')) return;
    if (directory.chatIdFor(id) === chatId) return;
    if (directory.has(id)) {
      log.warn('Ignored a WhatsApp id that already belongs to another contact');
      return;
    }
    const contact = directory.contact(chatId);
    if (!contact) return;
    handlers.onAliasLinked?.({chatId, alias: id});
    directory.replace({...contact, aliases: [...contact.aliases, id]});
  }

  async function attachUnknownAlias(rawId) {
    const id = chatAddress(rawId);
    if (!id || directory.has(id) || id.endsWith('@g.us') || id.endsWith('@newsletter')) return;
    const matches = [];
    for (const contact of directory.contacts()) {
      const scratch = new Set(contact.aliases);
      scratch.canonical = contact.chatId;
      const linked = await linkContactAlias(client, scratch, contact.phone, id)
        || await rememberApprovedAlias(client, scratch, contact.phone, id, log);
      if (linked) matches.push({contact, scratch});
    }
    if (matches.length !== 1) {
      if (matches.length > 1) log.warn('Ignored an ambiguous WhatsApp id');
      return;
    }
    for (const alias of matches[0].scratch) {
      try { rememberLink(matches[0].contact.chatId, alias); }
      catch (error) { log.warn(`Alias was not stored (${error.message})`); }
    }
  }

  client.on('qr', (qr) => {
    log.warn('WhatsApp requested a new pairing QR. Existing LocalAuth session was not reused. Stop and check WHATSAPP_AUTH_PATH, WHATSAPP_CLIENT_ID, and that no other process is using this profile.');
    try { qrcode.generate(qr, {small: true}); }
    catch { log.error('Could not render QR in the terminal.'); }
  });

  client.on('authenticated', () => {
    log.info('WhatsApp authenticated; waiting for ready event');
  });

  client.on('auth_failure', (message) => {
    log.error(`WhatsApp authentication failed (${String(message || '').slice(0, 120)}). Do not delete the existing session; check the auth path and client id.`);
  });

  client.on('ready', () => {
    readyAt = Date.now();
    void (async () => {
      try { await client.sendPresenceAvailable(); } catch { /* presence is best-effort */ }
      for (const contact of handlers.onLoadContacts?.() || []) {
        if (!contact.aliases?.length) {
          try {
            const resolved = await resolveTestContact(client, contact.phone, log);
            if (resolved.canonical !== contact.chatId) {
              log.warn(`Excluded +${contact.phone} until WhatsApp identity matches the stored chat`);
              continue;
            }
            const aliases = [...resolved];
            for (const alias of aliases) handlers.onAliasLinked?.({chatId: contact.chatId, alias});
            adoptContact({...contact, displayName: contact.displayName || resolved.displayName || '', aliases});
          } catch (error) {
            log.warn(`Excluded +${contact.phone} until WhatsApp identity is verified (${error.message})`);
          }
          continue;
        }
        try { adoptContact(contact); }
        catch (error) { log.error(`Excluded +${contact.phone}: ${error.message}`); }
      }
      try {
        const resolved = await resolveTestContact(client, config.number, log);
        const phone = digits(config.number);
        const aliases = [...resolved];
        handlers.onContactEnabled?.({
          chatId: resolved.canonical,
          phone,
          displayName: resolved.displayName || '',
          aliases
        });
        adoptContact({chatId: resolved.canonical, phone, displayName: resolved.displayName || '', aliases});
      } catch (error) {
        log.error(error.message);
      }
      log.info(`WhatsApp ready; ${directory.size} approved contact(s)`);
      handlers.onReady?.({client, contacts: directory.contacts()});
      accepting = true;
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(() => { void pollApprovedChat(); }, 5000);
      void pollApprovedChat();
    })().catch((error) => log.error(error.message));
  });

  const handleIncoming = async (message) => {
    const seenId = message?.id?._serialized || (typeof message?.id === 'string' ? message.id : '');
    if (seenId && seenMessageIds.has(seenId)) return false;
    if (message?.fromMe || message?.id?.fromMe) return false;
    if (!accepting || !directory.size) {
      log.info('Ignored incoming WhatsApp event (allowlist-not-ready)');
      return false;
    }
    for (const id of candidateChatIds(message)) {
      if (directory.has(id)) continue;
      await attachUnknownAlias(id);
    }
    const ageLimit = config.maxEventAgeMs;
    if (config.incomingVoiceEnabled && isIncomingAudio(message)) {
      const audio = parseApprovedAudio(message, directory, ageLimit, readyAt, Date.now());
      if (audio) {
        seenMessageIds.add(audio.whatsappId);
        log.info('Approved incoming voice note queued');
        await handlers.onIncomingAudio?.({...audio, message});
        return true;
      }
    }
    const parsed = parseApprovedEvent(message, 'incoming', directory, ageLimit, readyAt, Date.now());
    if (parsed) {
      seenMessageIds.add(parsed.whatsappId);
      log.info('Approved incoming message queued for debounce');
      handlers.onIncoming?.(parsed);
      return true;
    }
    const reason = skipReason(message, directory, ageLimit, readyAt, Date.now());
    if (reason === 'stale-timestamp' && seenId) seenMessageIds.add(seenId);
    if (reason !== 'group' && reason !== 'self-chat' && !reason.startsWith('not-allowlisted:c.us')) {
      log.info(`Ignored incoming WhatsApp event (${reason})`);
    }
    return false;
  };

  const handleOutgoing = (message) => {
    if (!accepting || !directory.size) return;
    const parsed = parseApprovedEvent(message, 'outgoing', directory, config.maxEventAgeMs, readyAt, Date.now());
    if (parsed) handlers.onOutgoing?.(parsed);
  };

  async function pollApprovedChat() {
    if (!accepting || pollBusy) return;
    pollBusy = true;
    try {
      let queued = 0;
      let scannedCount = 0;
      if (directory.size) {
        const scanned = await scanApprovedMessages(client, directory.phones(), directory.aliasIds());
        scannedCount = scanned.messages.length;
        for (const link of scanned.links) {
          const contact = directory.contactByPhone(link.phone);
          if (!contact) continue;
          try { rememberLink(contact.chatId, link.alias); }
          catch (error) { log.warn(`Alias was not stored (${error.message})`); }
        }
        for (const row of scanned.messages) {
          const message = row.model || row;
          if (message?.fromMe || message?.id?.fromMe) handleOutgoing(message);
          else if (await handleIncoming(message)) queued += 1;
        }
        if (!scanned.messages.length && !missingChatLogged) {
          missingChatLogged = true;
          log.warn(`Approved contacts have no loaded text yet (${scanned.scanned} messages in the WhatsApp store; newest ${scanned.newest}).`);
        }
      }
      await pollSelfApprovals();
      if (queued || Date.now() - lastPollLog > 15000) {
        lastPollLog = Date.now();
        log.info(`Approved chat poll found ${scannedCount} stored message(s) across ${directory.size} contact(s); queued ${queued}`);
      }
    } catch (error) {
      if (Date.now() - lastPollLog > 15000) {
        lastPollLog = Date.now();
        log.warn(`Approved chat poll failed (${error.message})`);
      }
    } finally {
      pollBusy = false;
    }
  }

  client.on('message', (message) => {
    void handleIncoming(message);
  });

  const ownerId = () => serializeWid(client.info?.wid);

  async function pollSelfApprovals() {
    const owner = ownerId();
    if (!owner || !client.pupPage) return;
    let messages = [];
    try {
      messages = await readSelfChatMessages(client);
      await handlers.onSelfMessages?.(messages);
    } catch (error) {
      if (Date.now() - lastSelfPollLog > 15000) {
        lastSelfPollLog = Date.now();
        log.warn(`Self-chat approval poll failed (${error.message})`);
      }
      return;
    }
    if (Date.now() - lastSelfPollLog > 15000) {
      lastSelfPollLog = Date.now();
      const choices = messages.filter((message) => /^[123]$/.test(String(message.body || '').trim())).length;
      const commands = messages.filter((message) => parseOwnerCommand(message.body)).length;
      log.info(`Self-chat scan saw ${messages.length} message(s), ${commands} command(s), ${choices} numbered repl${choices === 1 ? 'y' : 'ies'}`);
    }
    for (const message of messages) {
      const seenId = whatsappId(message);
      if (!seenId || seenMessageIds.has(`self:${seenId}`)) continue;
      if (parseOwnerCommand(message?.body)) {
        seenMessageIds.add(`self:${seenId}`);
        await onOwnerCommand(message);
        continue;
      }
      if (String(message?.type || '').toLowerCase() === 'ptt' || message?.isVoice) {
        seenMessageIds.add(`self:${seenId}`);
        await handlers.onVoiceSanity?.({message, ownerId: owner, client});
        continue;
      }
      const approval = await parseOwnerApproval(message, owner, blockedAliases());
      seenMessageIds.add(`self:${seenId}`);
      if (!approval) continue;
      log.info(`Owner approval ${approval.option} for quoted message ${approval.quotedWhatsappId}`);
      await handlers.onApproval?.(approval);
    }
  }

  const onOwnerCommand = (message) => handleOwnerCommand(message, {
    ownerId: ownerId(),
    blocked: blockedAliases(),
    log,
    resolve: (number) => resolveTestContact(client, number, log),
    enable: (row) => {
      handlers.onContactEnabled?.(row);
      adoptContact(row);
      missingChatLogged = false;
      const who = row.displayName || `+${row.phone}`;
      log.info(`Drafting enabled for ${who}`);
    },
    list: () => handlers.onList?.() || 'ACTIVE CONTACTS (0)\n\nNo contacts are enabled.',
    pause: async (number) => {
      const result = await handlers.onPause?.(number);
      if (result?.ok) directory.unload(result.contact.chat_id);
      return result?.text || `No contact is enrolled for +${number}.`;
    },
    resume: async (number) => {
      const result = await handlers.onResume?.(number);
      if (result?.ok) {
        directory.markFresh(result.contact.chat_id, Date.now());
        adoptContact({
          chatId: result.contact.chat_id,
          phone: result.contact.phone,
          displayName: result.contact.display_name || '',
          aliases: result.aliases || []
        });
      }
      return result?.text || `No contact is enrolled for +${number}.`;
    },
    remove: async (number) => {
      const result = await handlers.onRemove?.(number);
      if (result?.ok) directory.unload(result.contact.chat_id);
      return result?.text || `No contact is enrolled for +${number}.`;
    },
    reply: (id, text) => client.sendMessage(id, text)
  });

  client.on('message_create', (message) => {
    const fromMe = Boolean(message?.fromMe || message?.id?.fromMe);
    if (fromMe) {
      void (async () => {
        if (await onOwnerCommand(message)) return;
        if (await handlers.onVoiceSanity?.({message, ownerId: ownerId(), client})) return;
        const approval = await parseOwnerApproval(message, ownerId(), blockedAliases());
        if (approval) {
          await handlers.onApproval?.(approval);
          return;
        }
        handleOutgoing(message);
      })().catch((error) => log.error(`Owner command failed: ${error.message}`));
      return;
    }
    void handleIncoming(message);
  });

  client.on('message_ciphertext', (message) => {
    log.info('Incoming ciphertext received; waiting for decrypt or poll');
    void handleIncoming(message);
  });

  client.on('change_state', (state) => {
    log.info(`WhatsApp connection state: ${String(state).slice(0, 40)}`);
  });

  client.on('disconnected', (reason) => {
    readyAt = 0;
    accepting = false;
    for (const contact of directory.contacts()) directory.unload(contact.chatId);
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    log.warn(`WhatsApp disconnected (${String(reason || 'unknown').slice(0, 80)}). No stale draft will be sent.`);
    handlers.onDisconnected?.();
  });

  return client;
}

module.exports = {
  createWhatsAppClient,
  parseApprovedEvent,
  parseApprovedAudio,
  isIncomingAudio,
  parseAddCommand,
  parseOwnerCommand,
  createContactDirectory,
  parseOwnerApproval,
  approvalChoice,
  isOwnerSelfMessage,
  quotedNotificationId,
  handleOwnerCommand,
  resolveTestContact,
  rememberApprovedAlias,
  chatMatchesApproved,
  localAuthOptions,
  chromeExecutablePath,
  contactMatchesNumber,
  savedContactName,
  whatsappMessageId
};
