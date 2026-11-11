'use strict';
require('dotenv').config();
const {Store} = require('./db');
const {DatingAgent} = require('./agent');
const {OpenRouter} = require('./openrouter');
const {DraftDelivery} = require('./drafts');
const {createWhatsAppClient} = require('./whatsapp');
const {loadConfig, logger: createLogger} = require('./config');
const {createVoiceSanity, downloadVoiceMedia} = require('./voice-sanity');

async function main() {
  const config = loadConfig();
  const log = createLogger(config.logLevel);
  const db = new Store(config.dbPath);
  const abandonedVoice = db.abandonPendingTranscriptions();
  const voiceBaselineId = db.maxMessageRowId();
  log.info(`SQLite initialized (${db.kind}); draft-only policy is enforced`);
  if (abandonedVoice) log.warn(`${abandonedVoice} voice note(s) were still transcribing at restart and will not be drafted.`);
  const ai = new OpenRouter({
    apiKey: config.apiKey,
    model: config.model,
    outputMode: config.outputMode,
    timeoutMs: config.apiTimeoutMs,
    maxRetries: config.maxRetries,
    maxOutputTokens: config.maxOutputTokens,
    temperature: config.temperature,
    logger: log
  });
  let agent = null;
  let drafts = null;
  let closing = false;
  const voiceSanity = createVoiceSanity({db, config, log, ai, getDrafts: () => drafts});
  const client = createWhatsAppClient(config, log, {
    onLoadContacts: () => db.enabledContacts().map((row) => ({
      chatId: row.chat_id,
      phone: row.phone,
      displayName: row.display_name || '',
      aliases: db.aliasesFor(row.chat_id)
    })),
    onContactEnabled: ({chatId, phone, displayName = '', aliases = []}) => {
      db.enableContact(chatId, phone, displayName, aliases, {maxEnabled: config.maxEnabledContacts});
    },
    onAliasLinked: ({chatId, alias}) => db.addAlias(chatId, alias),
    onPause: (phone) => {
      const result = db.pauseContact(phone);
      if (result.ok) agent?.pauseChat(result.contact.chat_id);
      return result;
    },
    onResume: (phone) => db.resumeContact(phone),
    onRemove: (phone) => {
      const result = db.removeContact(phone);
      if (result.ok) agent?.pauseChat(result.contact.chat_id);
      return result;
    },
    onList: () => db.formatContactList(),
    onReady: ({client}) => {
      agent?.stop();
      drafts = new DraftDelivery({
        client, enabled: config.selfNotifications, logger: log,
        draftOnly: config.draftOnly, approvedSendEnabled: config.approvedSendEnabled,
        isApprovedRecipient: (chatId) => db.canSendTo(chatId)
      });
      agent = new DatingAgent({db, ai, drafts, config, logger: log, voiceBaselineId});
      const enabled = db.enabledContacts().length;
      log.info(`Listener active. Debounce: ${config.debounceMs}ms. Model: ${config.model}. Enabled contacts: ${enabled}.`);
      if (config.draftOnly || !config.approvedSendEnabled) {
        log.info('Approved contact sending is off. Drafts stay in Message Yourself until DRAFT_ONLY=false and APPROVED_SEND_ENABLED=true.');
      } else {
        log.info('Human-approved sending is on. A quoted 1, 2, or 3 sends only to that draft\'s contact.');
      }
      log.info('In Message Yourself: /add +<number> enrolls a contact. /list, /pause, /resume, and /remove manage them.');
      if (config.incomingVoiceEnabled) {
        log.info(`Incoming voice transcription is on (${config.incomingVoiceLanguage}, ${config.openrouterSttModel}). Audio from approved contacts is sent to OpenRouter for transcription and is not stored.`);
      }
      if (abandonedVoice) {
        drafts.notifyOwner('A voice note was still processing when the app restarted. It was not used for a draft. Review that chat manually.').catch(() => {});
      }
    },
    onIncoming: (message) => agent?.onIncoming(message),
    onIncomingAudio: ({message, ...audio}) => agent?.onIncomingAudio({
      ...audio,
      getMedia: () => downloadVoiceMedia(client, message)
    }),
    onOutgoing: (message) => agent?.onOutgoing(message),
    onApproval: (command) => agent?.handleApproval(command),
    onSelfMessages: (messages) => agent?.observeSelfChat(messages),
    onVoiceSanity: (event) => voiceSanity.handle(event),
    onDisconnected: () => {agent?.stop(); agent = null;}
  });
  async function shutdown(signal, exitCode = 0) {
    if (closing) return;
    closing = true;
    log.info(`${signal}: stopping local agent`);
    agent?.stop();
    try { await Promise.race([client.destroy(), new Promise(resolve => setTimeout(resolve, 7000))]); }
    catch (error) { log.warn(`WhatsApp shutdown: ${error.message}`); }
    // An OpenRouter request may have already started. Allow it to settle
    // before closing SQLite, but do not initiate any new draft notifications.
    if (agent) await Promise.race([agent.drain(), new Promise(resolve => setTimeout(resolve, 4000))]);
    try { db.close(); } catch (error) { log.warn(`SQLite close: ${error.message}`); }
    process.exit(exitCode);
  }
  process.once('SIGINT', () => {void shutdown('SIGINT');});
  process.once('SIGTERM', () => {void shutdown('SIGTERM');});
  try {
    await client.initialize();
  } catch (error) {
    log.error(`WhatsApp initialization failed: ${error.message}`);
    await shutdown('startup error', 1);
  }
}
if (require.main === module) {
  main().catch(error => {
    console.error(`Startup failed: ${error.message}`);
    process.exitCode = 1;
  });
}
module.exports = {main};
