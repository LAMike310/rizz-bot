'use strict';

function formatDraft(draft, label, recentIncoming = '') {
  const snippet = recentIncoming.replace(/\s+/g, ' ').slice(0, 170);
  return [
    `DRAFT #${draft.id} — ${label}`,
    '',
    ...(snippet ? ['Last incoming:', snippet, ''] : []),
    'Suggested reply:', draft.reply_es,
    '',
    'English:', draft.translation_en,
    '',
    'Reason:', draft.reason,
    '',
    '(For review only. Nothing was sent to the test contact.)'
  ].join('\n');
}

// Only this class has an automated sendMessage call in V1. There is NO method
// accepting a recipient argument, so the model cannot select a destination.
class DraftDelivery {
  constructor({client, enabled = true, testChatId, label = 'US Test Contact', logger = console}) {
    this.client = client;
    this.enabled = enabled;
    this.testChatId = testChatId;
    this.label = label;
    this.logger = logger;
  }
  selfId() {
    const id = this.client.info?.wid?._serialized;
    if (!id || typeof id !== 'string' || !/^\d+@(c\.us|lid)$/.test(id)) {
      throw new Error('Verified owner WhatsApp ID is unavailable; refusing delivery');
    }
    if (id === this.testChatId) throw new Error('Owner ID equals test contact; refusing delivery');
    return id;
  }
  // beforeSend runs synchronously immediately before invoking sendMessage.
  async deliver(draft, {recentIncoming = '', beforeSend = () => true} = {}) {
    const text = formatDraft(draft, this.label, recentIncoming);
    if (!this.enabled) {
      this.logger.info(`\n--- LOCAL DRAFT ---\n${text}\n--- END DRAFT ---`);
      return 'local';
    }
    let ownerId;
    try { ownerId = this.selfId(); } catch (error) {
      this.logger.error(error.message);
      this.logger.info(`\n--- LOCAL FALLBACK DRAFT ---\n${text}\n--- END DRAFT ---`);
      return 'failed';
    }
    if (!beforeSend()) return 'stale';
    try {
      // No awaited operation occurs between the final revision check and send invocation.
      await this.client.sendMessage(ownerId, text);
      return 'notified';
    } catch (error) {
      this.logger.error(`Self-chat notification failed: ${error.message}`);
      this.logger.info(`\n--- LOCAL FALLBACK DRAFT ---\n${text}\n--- END DRAFT ---`);
      return 'failed';
    }
  }
}
module.exports = {DraftDelivery, formatDraft};
