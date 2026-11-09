'use strict';
const fs = require('node:fs');

// Deliberately only one contact in V1; still keyed by chat ID to keep the
// debounce and revision invariants explicit and testable.
class DatingAgent {
  constructor({db, ai, drafts, config, logger = console,
    setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now}) {
    this.db = db;
    this.ai = ai;
    this.drafts = drafts;
    this.config = config;
    this.logger = logger;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.now = now;
    this.timers = new Map();
    this.pending = new Map();
    this.due = new Map();
    this.running = new Map();
    this.stopped = false;
  }
  onIncoming(message) { return this.onEvent(message, 'incoming'); }
  onOutgoing(message) { return this.onEvent(message, 'outgoing'); }
  onEvent(message, direction) {
    if (this.stopped || !this.db.isEnabled(message.chatId)) return false;
    const revision = this.db.saveEvent({ ...message, direction });
    if (revision == null) return false; // duplicate or unsupported event
    this.cancelTimer(message.chatId);
    this.due.delete(message.chatId);
    if (direction === 'incoming') {
      this.schedule(message.chatId, revision);
      this.logger.debug(`Incoming message persisted; revision ${revision}; debounce started`);
    } else {
      this.logger.info(`Manual outgoing message; revision ${revision}; pending draft canceled`);
    }
    return true;
  }
  cancelTimer(chatId) {
    if (this.timers.has(chatId)) this.clearTimer(this.timers.get(chatId));
    this.timers.delete(chatId);
    this.pending.delete(chatId);
  }
  schedule(chatId, revision) {
    if (this.stopped) return;
    this.cancelTimer(chatId);
    this.pending.set(chatId, revision);
    const timer = this.setTimer(() => this.timerExpired(chatId, revision), this.config.debounceMs);
    this.timers.set(chatId, timer);
  }
  timerExpired(chatId, revision) {
    if (this.stopped || this.pending.get(chatId) !== revision) return;
    this.timers.delete(chatId);
    this.pending.delete(chatId);
    if (!this.db.isEnabled(chatId) || this.db.revision(chatId) !== revision) return;
    if (this.running.has(chatId)) {
      this.due.set(chatId, revision); // quiet period elapsed while older call in flight
      return;
    }
    this.startGeneration(chatId, revision);
  }
  isCurrent(chatId, revision) {
    return !this.stopped && this.db.isEnabled(chatId) && this.db.revision(chatId) === revision;
  }
  startGeneration(chatId, revision) {
    if (this.stopped || !this.isCurrent(chatId, revision)) return;
    if (this.running.has(chatId)) { this.due.set(chatId, revision); return; }
    const task = this.generate(chatId, revision)
      .catch(error => this.logger.error(`Draft generation failed (${error.message})`))
      .finally(() => {
        this.running.delete(chatId);
        const due = this.due.get(chatId);
        this.due.delete(chatId);
        if (due != null && !this.pending.has(chatId) && this.isCurrent(chatId, due)) {
          this.startGeneration(chatId, due);
        }
      });
    this.running.set(chatId, task);
  }
  async generate(chatId, revision) {
    if (!this.isCurrent(chatId, revision)) return;
    const history = this.db.history(chatId, this.config.maxHistory);
    if (!history.length || history.at(-1).direction !== 'incoming') return;
    const prompt = fs.readFileSync(this.config.promptPath, 'utf8');
    const profile = JSON.parse(fs.readFileSync(this.config.profilePath, 'utf8'));
    this.logger.info(`Generating draft for revision ${revision} (history ${history.length} messages)`);
    const response = await this.ai.generate({history, prompt, profile});
    if (!this.isCurrent(chatId, revision)) {
      this.logger.info(`Discarded stale response for revision ${revision}`);
      return;
    }
    if (!response.should_reply) {
      this.logger.info(`Model advised no reply for revision ${revision}`);
      return;
    }
    const draft = this.db.saveDraft({chatId, revision, ...response});
    if (!draft) return;
    this.logger.info(`Saved draft #${draft.id} using ${response.model || 'selected model'}`);
    if (!this.isCurrent(chatId, revision)) {
      this.db.updateDraft(draft.id, 'stale');
      return;
    }
    const lastIncoming = [...history].reverse().find(m => m.direction === 'incoming')?.body || '';
    const status = await this.drafts.deliver(draft, {
      recentIncoming: lastIncoming,
      beforeSend: () => this.isCurrent(chatId, revision)
    });
    if (status === 'notified') {
      this.db.updateDraft(draft.id, 'notified');
      this.logger.info(`Draft #${draft.id} delivered to owner self-chat`);
    } else if (status === 'failed') {
      this.db.updateDraft(draft.id, 'failed');
    } else if (status === 'stale') {
      this.db.updateDraft(draft.id, 'stale');
    }
  }
  async drain() {
    // Test utility: wait for already-running generations; does not advance timers.
    const active = [...this.running.values()];
    if (active.length) await Promise.allSettled(active);
  }
  stop() {
    this.stopped = true;
    for (const chatId of [...this.timers.keys()]) this.cancelTimer(chatId);
    this.due.clear();
  }
}
module.exports = {DatingAgent};
