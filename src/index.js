'use strict';
require('dotenv').config();
const {Store} = require('./db');
const {DatingAgent} = require('./agent');
const {OpenRouter} = require('./openrouter');
const {DraftDelivery} = require('./drafts');
const {createWhatsAppClient} = require('./whatsapp');
const {loadConfig, logger: createLogger} = require('./config');

async function main() {
  const config = loadConfig();
  const log = createLogger(config.logLevel);
  const db = new Store(config.dbPath);
  log.info(`SQLite initialized (${db.kind}); draft-only policy is enforced`);
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
  const client = createWhatsAppClient(config, log, {
    onReady: ({client, chatId}) => {
      agent?.stop();
      db.enableTestContact(chatId, config.number);
      drafts = new DraftDelivery({
        client, enabled: config.selfNotifications,
        testChatId: chatId, label: `+${config.number}`, logger: log
      });
      agent = new DatingAgent({db, ai, drafts, config, logger: log});
      log.info(`Listener active. Debounce: ${config.debounceMs}ms. Model: ${config.model}.`);
      log.info('No automated messages can be sent to the test contact.');
      log.info('Send /add +<number> in your WhatsApp self-chat to switch the drafted contact.');
    },
    onContactEnabled: ({chatId, phone}) => {
      db.enableTestContact(chatId, phone);
      if (drafts) {
        drafts.testChatId = chatId;
        drafts.label = `+${phone}`;
      }
    },
    onIncoming: (message) => agent?.onIncoming(message),
    onOutgoing: (message) => agent?.onOutgoing(message),
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
