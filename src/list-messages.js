'use strict';
require('dotenv').config();
const {Client, LocalAuth} = require('whatsapp-web.js');
const {loadConfig} = require('./config');
const {localAuthOptions, chromeExecutablePath} = require('./whatsapp');

async function main() {
  const config = loadConfig();
  const executablePath = chromeExecutablePath(config.chromeExecutable);
  const puppeteer = {headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox']};
  if (executablePath) puppeteer.executablePath = executablePath;
  const client = new Client({
    authStrategy: new LocalAuth(localAuthOptions(config)),
    puppeteer
  });
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for WhatsApp ready')), 90000);
    client.on('qr', () => {
      clearTimeout(timer);
      reject(new Error('WhatsApp asked for a new QR. Stop. Session was not reused.'));
    });
    client.on('ready', () => {
      clearTimeout(timer);
      resolve();
    });
    client.on('auth_failure', (message) => {
      clearTimeout(timer);
      reject(new Error(`Auth failure: ${String(message || '').slice(0, 120)}`));
    });
  });
  await client.initialize();
  await done;
  const report = await client.pupPage.evaluate(async (number) => {
    const onlyDigits = (value) => String(value || '').replace(/\D/g, '');
    const same = (value) => {
      const digits = onlyDigits(value);
      return digits === number;
    };
    const serialized = (value) => value?._serialized || (value?.user && value?.server ? `${value.user}@${value.server}` : '');
    const collections = window.require('WAWebCollections');
    const ids = new Set([`${number}@c.us`, `${number}@s.whatsapp.net`]);
    const contacts = [];
    for (const contact of collections.Contact.getModelsArray?.() || []) {
      const id = serialized(contact.id);
      const userid = onlyDigits(contact.userid);
      const phone = onlyDigits(contact.phoneNumber?.user || contact.phoneNumber);
      if (id.endsWith('@g.us') || id.endsWith('@newsletter')) continue;
      if (!same(userid) && !same(phone) && !same(id)) continue;
      if (id) ids.add(id);
      contacts.push({
        idServer: (id.split('@')[1] || 'unknown'),
        useridTail: userid.slice(-4),
        phoneTail: phone.slice(-4),
        name: contact.name || contact.pushname || contact.shortName || ''
      });
    }
    const remoteOf = (msg) => serialized(msg?.id?.remote) || serialized(msg?.from);
    const rows = [];
    const add = (msg, source) => {
      if (!msg) return;
      const remote = remoteOf(msg);
      const body = String(msg.body || msg.caption || '').replace(/\s+/g, ' ').trim();
      rows.push({
        source,
        remoteServer: remote.split('@')[1] || 'unknown',
        fromMe: Boolean(msg.id?.fromMe || msg.fromMe),
        type: msg.type || 'unknown',
        at: msg.t || msg.timestamp || null,
        body
      });
    };
    let approvedChats = 0;
    let loadError = '';
    for (const chat of collections.Chat.getModelsArray?.() || []) {
      const id = serialized(chat.id);
      const userid = onlyDigits(chat.contact?.userid);
      if (id.endsWith('@g.us') || id.endsWith('@newsletter')) continue;
      if (!ids.has(id) && !same(chat.id?.user) && !same(userid)) continue;
      approvedChats += 1;
      if (id) ids.add(id);
      let msgs = chat.msgs?.getModelsArray?.() || [];
      if (msgs.length < 20) {
        try {
          const earlier = await window.require('WAWebChatLoadMessages').loadEarlierMsgs({chat});
          if (earlier?.length) msgs = [...earlier, ...msgs];
        } catch (error) {
          loadError = String(error?.message || error).slice(0, 80);
        }
      }
      for (const msg of msgs.slice(-20)) add(msg, 'chat');
    }
    for (const msg of collections.Msg.getModelsArray?.() || []) {
      if (ids.has(remoteOf(msg))) add(msg, 'store');
    }
    const seen = new Set();
    const messages = [];
    for (const row of rows) {
      const key = `${row.at}|${row.fromMe}|${row.body}`;
      if (seen.has(key)) continue;
      seen.add(key);
      messages.push(row);
    }
    messages.sort((a, b) => Number(a.at || 0) - Number(b.at || 0));
    return {
      approvedChats,
      linkedContacts: contacts,
      loadError,
      messageCount: messages.length,
      messages: messages.slice(-20)
    };
  }, config.number);
  console.log(JSON.stringify(report, null, 2));
  await client.destroy();
  process.exit(0);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
