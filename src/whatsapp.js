'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {Client, LocalAuth} = require('whatsapp-web.js');
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
  if (!number || value.length < 10) return false;
  return value === number || value.endsWith(number) || number.endsWith(value);
}

function contactMatchesNumber(contact, number) {
  const values = [
    contact?.phoneNumber?.user,
    typeof contact?.phoneNumber === 'string' ? contact.phoneNumber : '',
    contact?.phoneNumber?._serialized
  ];
  return values.some((value) => phoneMatchesDigits(value, number));
}

function parseApprovedEvent(message, kind, aliases, maxEventAgeMs, readyAtMs, now, trustedChatId = '') {
  if (!message || !aliases) return null;
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
  const rawChat = candidateChatIds(message).find((id) => aliases.has(id))
    || (trustedChatId && aliases.has(trustedChatId) ? trustedChatId : '');
  if (!rawChat) return null;

  const whatsappId = whatsappMessageId(message);
  if (!whatsappId) return null;
  return {
    chatId: aliases.canonical || rawChat,
    whatsappId,
    body,
    timestamp: Number.isFinite(Number(message.timestamp)) ? Number(message.timestamp) : Math.floor(now / 1000)
  };
}

function phoneMatchesApproved(pn, number, canonical) {
  const serialized = serializeWid(pn);
  const pnDigits = digits(serialized);
  return serialized === canonical || pnDigits === number || (pnDigits && number.endsWith(pnDigits));
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
  if (typeof client.getContacts === 'function') {
    try {
      for (const contact of (await client.getContacts()) || []) {
        const id = serializeWid(contact?.id);
        const contactNumber = digits(contact?.number || contact?.id?.user);
        if (contactNumber === number && id) aliases.add(id);
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

async function scanApprovedMessages(client, number, aliasIds) {
  if (!client.pupPage) return {scanned: 0, messages: [], aliases: [], newest: 'none'};
  const rows = await client.pupPage.evaluate(async (number, aliasIds) => {
    const onlyDigits = (value) => String(value || '').replace(/\D/g, '');
    const samePhone = (candidate) => {
      const value = onlyDigits(candidate);
      return value === number || (value.length >= 10 && (number.endsWith(value) || value.endsWith(number)));
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
    const phoneById = window.__rizzPhoneById || (window.__rizzPhoneById = new Map());
    const rememberContact = (contact) => {
      const id = contact?.id?._serialized || '';
      if (!id || id.endsWith('@g.us') || id.endsWith('@newsletter')) return;
      const phone = onlyDigits(contact.phoneNumber?.user || contact.phoneNumber);
      if (phone) phoneById.set(id, phone);
      if (samePhone(phone) || samePhone(id)) aliases.add(id);
    };
    for (const contact of collections.Contact.getModelsArray?.() || []) rememberContact(contact);
    try {
      const phoneWid = window.require('WAWebWidFactory').createWid(`${number}@c.us`);
      rememberContact(collections.Contact.get(phoneWid));
      const lid = window.require('WAWebApiContact').getCurrentLid(phoneWid);
      if (lid) {
        aliases.add(lid._serialized || `${lid.user}@${lid.server}`);
        rememberContact(collections.Contact.get(lid));
      }
    } catch {
      // The saved contact list above is enough when this lookup is unavailable.
    }
    const remoteOf = (msg) => msg?.id?.remote?._serialized
      || (msg?.id?.remote?.user && msg?.id?.remote?.server ? `${msg.id.remote.user}@${msg.id.remote.server}` : '');
    const approvedRemote = async (remote) => Boolean(remote) && (aliases.has(remote) || samePhone(await phoneForRemote(remote)));
    const messages = [];
    const seen = new Set();
    const consider = async (msg, trusted = false) => {
      if (!msg) return;
      const id = msg.id?._serialized || '';
      const remote = remoteOf(msg);
      if (!id || seen.has(id)) return;
      if (!trusted && !(await approvedRemote(remote))) return;
      seen.add(id);
      if (remote) aliases.add(remote);
      messages.push(window.WWebJS.getMessageModel(msg));
    };
    for (const chat of collections.Chat.getModelsArray?.() || []) {
      const remote = chat.id?._serialized || '';
      const known = aliases.has(remote) || samePhone(chat.id?.user) || samePhone(chat.contact?.phoneNumber) || samePhone(phoneById.get(remote));
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
      for (const msg of msgs.slice(-12)) await consider(msg, true);
      if (chat.lastReceivedKey?._serialized) await consider(collections.Msg.get(chat.lastReceivedKey._serialized), true);
    }
    const stored = collections.Msg.getModelsArray?.() || [];
    for (const msg of stored) {
      if (aliases.has(remoteOf(msg))) await consider(msg, true);
    }
    const newestMsg = stored.at(-1);
    const newestRemote = remoteOf(newestMsg);
    const newestPhone = await phoneForRemote(newestRemote);
    const newest = newestMsg
      ? `${aliases.size} ids; newest ${newestRemote.split('@')[1] || 'unknown'} type=${newestMsg.type || 'unknown'} phone=${samePhone(newestPhone) ? 'approved' : newestPhone ? 'different-number' : 'missing'}`
      : 'none';
    return {scanned: stored.length, messages, aliases: [...aliases], newest};
  }, number, [...aliasIds]);
  return {
    scanned: rows.scanned,
    messages: rows.messages || [],
    aliases: rows.aliases || [],
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
    return phones.some((value) => value === expected || value.endsWith(expected) || expected.endsWith(value));
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

function skipReason(message, aliases, maxEventAgeMs = 30000, readyAtMs = 0, now = Date.now()) {
  if (!aliases) return 'allowlist-not-ready';
  if (message?.type && message.type !== 'chat') return `type:${message.type}`;
  const from = chatAddress(message?.from);
  const to = chatAddress(message?.to);
  const remote = chatAddress(message?.id?.remote);
  if ([from, to, remote].some((id) => id.endsWith('@g.us'))) return 'group';
  if (from && to && from === to) return 'self-chat';
  const fromMe = Boolean(message?.fromMe || message?.id?.fromMe);
  const ids = candidateChatIds(message);
  if (!ids.length) return 'missing-chat-id';
  if (!ids.some((id) => aliases.has(id))) {
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
  let aliases = null;
  let pollTimer = null;
  let lastPollLog = 0;
  let pollBusy = false;
  let missingChatLogged = false;
  const seenMessageIds = new Set();

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
    resolveTestContact(client, config.number, log)
      .then(async (resolved) => {
        aliases = resolved;
        log.info(`WhatsApp ready; approved contact resolved to ${resolved.canonical} (${resolved.size} id aliases)`);
        try { await client.sendPresenceAvailable(); } catch { /* presence is best-effort */ }
        try { await rememberChatsFromStore(client, resolved, config.number, log); }
        catch (error) { log.warn(`Approved chat discovery failed (${error.message})`); }
        handlers.onReady?.({client, chatId: resolved.canonical});
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(() => { void pollApprovedChat(); }, 5000);
        void pollApprovedChat();
      })
      .catch((error) => {
        aliases = null;
        log.error(error.message);
      });
  });

  const handleIncoming = async (message, trustedChatId = '') => {
    const seenId = message?.id?._serialized || (typeof message?.id === 'string' ? message.id : '');
    if (seenId && seenMessageIds.has(seenId)) return false;
    if (message?.fromMe || message?.id?.fromMe) return false;
    if (!aliases) {
      log.info(`Ignored incoming WhatsApp event (${skipReason(message, aliases)})`);
      return false;
    }
    for (const id of candidateChatIds(message)) {
      if (aliases.has(id)) continue;
      if (await linkContactAlias(client, aliases, config.number, id)) continue;
      await rememberApprovedAlias(client, aliases, config.number, id, log);
    }
    const ageLimit = trustedChatId ? Math.max(config.maxEventAgeMs, 300000) : config.maxEventAgeMs;
    const parsed = parseApprovedEvent(message, 'incoming', aliases, ageLimit, readyAt, Date.now(), trustedChatId);
    if (parsed) {
      seenMessageIds.add(parsed.whatsappId);
      log.info('Approved incoming message queued for debounce');
      handlers.onIncoming?.(parsed);
      return true;
    }
    const reason = skipReason(message, aliases, trustedChatId ? Math.max(config.maxEventAgeMs, 300000) : config.maxEventAgeMs, readyAt, Date.now());
    if (reason === 'stale-timestamp' && seenId) seenMessageIds.add(seenId);
    if (reason !== 'group' && reason !== 'self-chat' && !reason.startsWith('not-allowlisted:c.us')) {
      log.info(`Ignored incoming WhatsApp event (${reason})`);
    }
    return false;
  };

  const handleOutgoing = (message) => {
    const parsed = parseApprovedEvent(message, 'outgoing', aliases, config.maxEventAgeMs, readyAt, Date.now());
    if (parsed) handlers.onOutgoing?.(parsed);
  };

  async function pollApprovedChat() {
    if (!aliases || pollBusy) return;
    pollBusy = true;
    try {
      const chats = await loadOpenChats(client);
      const matches = chats.filter((chat) => chatMatchesApproved(chat, aliases, config.number));
      for (const chat of matches) {
        const id = serializeWid(chat.id);
        if (id) aliases.add(id);
      }
      const scanned = await scanApprovedMessages(client, config.number, aliases);
      for (const id of scanned.aliases) aliases.add(id);
      let queued = 0;
      for (const message of scanned.messages) {
        const remote = chatAddress(message.id?.remote) || chatAddress(message.from);
        if (remote) aliases.add(remote);
        if (message?.fromMe || message?.id?.fromMe) handleOutgoing(message);
        else if (await handleIncoming(message, aliases.canonical)) queued += 1;
      }
      if (!scanned.messages.length && !missingChatLogged) {
        missingChatLogged = true;
        log.warn(`Approved phone has no loaded text yet (${scanned.scanned} messages in the WhatsApp store; newest ${scanned.newest}).`);
      }
      if (queued || Date.now() - lastPollLog > 15000) {
        lastPollLog = Date.now();
        log.info(`Approved chat poll found ${scanned.messages.length} stored message(s) for the test phone; queued ${queued}`);
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

  client.on('message_create', (message) => {
    const fromMe = Boolean(message?.fromMe || message?.id?.fromMe);
    if (!fromMe) {
      void handleIncoming(message);
      return;
    }
    handleOutgoing(message);
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
    aliases = null;
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
  resolveTestContact,
  rememberApprovedAlias,
  chatMatchesApproved,
  localAuthOptions,
  chromeExecutablePath,
  contactMatchesNumber,
  whatsappMessageId
};
