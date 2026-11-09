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
    onReady: ({client, chatId, displayName = ''}) => {
      agent?.stop();
      db.enableTestContact(chatId, config.number, displayName);
      const label = db.contact(chatId)?.display_name || displayName || `+${config.number}`;
      drafts = new DraftDelivery({
        client, enabled: config.selfNotifications,
        testChatId: chatId, label, logger: log,
        draftOnly: config.draftOnly, approvedSendEnabled: config.approvedSendEnabled
      });
      agent = new DatingAgent({db, ai, drafts, config, logger: log, voiceBaselineId});
      log.info(`Listener active. Debounce: ${config.debounceMs}ms. Model: ${config.model}.`);
      if (config.draftOnly || !config.approvedSendEnabled) {
        log.info('Approved contact sending is off. Drafts stay in Message Yourself until DRAFT_ONLY=false and APPROVED_SEND_ENABLED=true.');
      } else {
        log.info('Human-approved sending is enabled for the allowlisted contact only.');
      }
      log.info('Send /add +<number> in your WhatsApp self-chat to switch the drafted contact.');
      if (config.incomingVoiceEnabled) {
        log.info(`Incoming voice transcription is on (${config.incomingVoiceLanguage}, ${config.openrouterSttModel}). Audio from the approved contact is sent to OpenRouter for transcription and is not stored.`);
      }
      if (abandonedVoice) {
        drafts.notifyOwner('A voice note was still processing when the app restarted. It was not used for a draft. Review that chat manually.').catch(() => {});
      }
    },
    onContactEnabled: ({chatId, phone, displayName = ''}) => {
      db.enableTestContact(chatId, phone, displayName);
      if (drafts) {
        drafts.testChatId = chatId;
        drafts.label = db.contact(chatId)?.display_name || displayName || `+${phone}`;
      }
    },
    onIncoming: (message) => agent?.onIncoming(message),
    onIncomingAudio: ({message, ...audio}) => agent?.onIncomingAudio({
      ...audio,
      getMedia: () => downloadVoiceMedia(client, message)
    }),
    onOutgoing: (message) => agent?.onOutgoing(message),
    onApproval: (command) => agent?.handleApproval({...command, label: drafts?.label}),
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
