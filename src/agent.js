'use strict';
const fs = require('node:fs');
const {formatConfirmation, formatRejection, draftIdFromNotification} = require('./drafts');
const {transcribeAudio} = require('./transcribe');
const {audioFormat} = require('./voice-sanity');

// Deliberately only one contact in V1; still keyed by chat ID to keep the
// debounce and revision invariants explicit and testable.
class DatingAgent {
  constructor({db, ai, drafts, config, logger = console,
    setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now, transcribe = transcribeAudio, voiceBaselineId = 0}) {
    this.db = db;
    this.ai = ai;
    this.drafts = drafts;
    this.config = config;
    this.logger = logger;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.now = now;
    this.transcribe = transcribe;
    this.timers = new Map();
    this.pending = new Map();
    this.due = new Map();
    this.running = new Map();
    this.waitingTranscript = new Map();
    this.burstFloor = new Map();
    this.voiceBaselineId = voiceBaselineId;
    this.voiceTasks = new Set();
    this.failureNotices = new Set();
    this.stopped = false;
  }
  onIncoming(message) { return this.onEvent(message, 'incoming'); }
  onOutgoing(message) { return this.onEvent(message, 'outgoing'); }
  onEvent(message, direction) {
    if (this.stopped || !this.db.isEnabled(message.chatId)) return false;
    const hadPending = this.pending.has(message.chatId) || this.running.has(message.chatId) || this.due.has(message.chatId);
    const revision = this.db.saveEvent({ ...message, direction });
    if (revision == null) return false; // duplicate or unsupported event
    this.cancelTimer(message.chatId);
    this.due.delete(message.chatId);
    this.waitingTranscript.delete(message.chatId);
    if (direction === 'incoming') {
      this.schedule(message.chatId, revision);
      this.logger.info(`Incoming message persisted; revision ${revision}; debounce started`);
    } else if (hadPending) {
      this.logger.info(`Manual outgoing message; revision ${revision}; pending draft canceled`);
    } else {
      this.logger.info(`Outgoing message saved; revision ${revision}. Waiting for the test number to reply`);
    }
    return true;
  }
  onIncomingAudio({chatId, whatsappId, timestamp, seconds, getMedia}) {
    if (!this.config.incomingVoiceEnabled || this.stopped || !this.db.isEnabled(chatId)) return false;
    const saved = this.db.saveIncomingVoice({whatsappId, chatId, timestamp});
    if (!saved) return false;
    const revision = saved.revision;
    this.cancelTimer(chatId);
    this.due.delete(chatId);
    this.waitingTranscript.delete(chatId);
    this.schedule(chatId, revision);
    this.logger.info(`Incoming voice note persisted; revision ${revision}; debounce started`);
    const task = this.finishVoice({chatId, whatsappId, seconds, getMedia})
      .catch(error => this.logger.error(`Voice transcription failed (${error.message})`));
    this.voiceTasks.add(task);
    task.finally(() => this.voiceTasks.delete(task));
    return true;
  }
  async finishVoice({chatId, whatsappId, seconds, getMedia}) {
    const failed = async (reason) => {
      const row = this.db.failVoice(whatsappId);
      this.logger.error(`Voice note ${whatsappId} failed: ${reason}`);
      if (row && !this.failureNotices.has(whatsappId)) {
        this.failureNotices.add(whatsappId);
        try {
          await this.drafts?.notifyOwner?.('A voice note could not be transcribed. Review that chat manually. Nothing was drafted from it.');
        } catch (error) {
          this.logger.error(`Voice failure notice was not delivered (${error.message})`);
        }
      }
      this.afterTranscript(chatId);
    };
    try {
      const limit = this.config.incomingVoiceMaxSeconds;
      if (seconds != null && limit && seconds > limit) {
        await failed(`Voice note is ${seconds}s, over the ${limit}s limit.`);
        return;
      }
      const media = typeof getMedia === 'function' ? await getMedia() : null;
      if (!media?.data) {
        await failed(media?.error || 'Voice note media downloaded empty.');
        return;
      }
      const format = audioFormat(media.mimetype || '');
      let bytes = 0;
      try { bytes = Buffer.from(media.data, 'base64').length; } catch { bytes = 0; }
      if (!bytes) {
        await failed('Voice note media downloaded empty.');
        return;
      }
      if (bytes > (this.config.incomingVoiceMaxBytes || 8000000)) {
        await failed(`Voice note is ${bytes} bytes, over the limit.`);
        return;
      }
      if (!format) {
        await failed(`Audio MIME is not a known transcription format (${media.mimetype || 'unknown'}).`);
        return;
      }
      const language = this.config.incomingVoiceLanguage || 'es';
      const result = await this.transcribe({
        apiKey: this.config.apiKey,
        model: this.config.openrouterSttModel || 'openai/whisper-large-v3-turbo',
        data: media.data,
        format,
        timeoutMs: this.config.voiceSttTimeoutMs || 30000,
        language,
        title: 'WhatsApp incoming voice'
      });
      if (!result?.text?.trim()) {
        await failed('Transcript was empty.');
        return;
      }
      const saved = this.db.completeVoice(whatsappId, {text: result.text, model: result.model, language: result.language});
      if (!saved) return;
      this.logger.info(`Voice note transcribed (${result.model}, ${language})`);
      this.afterTranscript(chatId);
    } catch (error) {
      await failed(error.message || 'transcription failed');
    }
  }
  afterTranscript(chatId) {
    if (this.stopped || this.db.pendingVoiceCount(chatId) > 0) return;
    const revision = this.db.revision(chatId);
    if (this.waitingTranscript.get(chatId) !== revision) return;
    this.waitingTranscript.delete(chatId);
    if (this.voiceBurstBlocked(chatId)) {
      this.burstFloor.set(chatId, this.db.maxMessageId(chatId));
      this.logger.info('Skipped draft because a voice note in this burst was not transcribed');
      return;
    }
    if (this.pending.has(chatId)) return;
    this.startGeneration(chatId, revision);
  }
  voiceBurstBlocked(chatId) {
    const floor = Math.max(this.burstFloor.get(chatId) || 0, this.voiceBaselineId || 0);
    return this.db.voiceFailureSince(chatId, floor);
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
    if (this.db.pendingVoiceCount(chatId) > 0) {
      this.waitingTranscript.set(chatId, revision);
      this.logger.info(`Quiet period elapsed; waiting for voice transcription (revision ${revision})`);
      return;
    }
    if (this.voiceBurstBlocked(chatId)) {
      this.burstFloor.set(chatId, this.db.maxMessageId(chatId));
      this.logger.info('Skipped draft because a voice note in this burst was not transcribed');
      return;
    }
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
    let response;
    try {
      response = await this.ai.generate({history, prompt, profile});
    } catch (error) {
      if (!error.invalidOutput) throw error;
      this.logger.error(`Draft JSON failed twice (${error.message})`);
      await this.drafts.notifyOwner("Sorry, you're on your own this round.");
      return;
    }
    if (!this.isCurrent(chatId, revision)) {
      this.logger.info(`Discarded stale response for revision ${revision}`);
      return;
    }
    if (!response.should_reply) {
      this.logger.info(`Model advised no reply for revision ${revision}`);
      return;
    }
    const expiresAt = new Date(this.now() + (this.config.draftTtlMinutes || 120) * 60000).toISOString();
    const draft = this.db.saveDraft({chatId, revision, options: response.options, model: response.model, usage: response.usage, expiresAt});
    if (!draft) return;
    this.logger.info(`Saved draft #${draft.id} using ${response.model || 'selected model'}`);
    if (!this.isCurrent(chatId, revision)) {
      this.db.updateDraft(draft.id, 'stale');
      return;
    }
    const lastIncoming = [...history].reverse().find(m => m.direction === 'incoming')?.body || '';
    const voiceTranscript = history.filter(m => m.source_type === 'voice' && m.transcription_status === 'complete').map(m => m.body).join('\n');
    const delivery = await this.drafts.deliver({...draft, options: response.options}, {
      recentIncoming: lastIncoming,
      voiceTranscript,
      beforeSend: () => this.isCurrent(chatId, revision)
    });
    const status = delivery?.status;
    if (status === 'notified' && delivery.whatsappId && this.db.activateDraft(draft.id, delivery.whatsappId, expiresAt)) {
      this.logger.info(`Draft #${draft.id} delivered to owner self-chat`);
    } else if (status === 'notified') {
      this.db.updateDraft(draft.id, 'failed');
      this.logger.error(`Draft #${draft.id} notification was not bound to an active draft`);
    } else if (status === 'failed') {
      this.db.updateDraft(draft.id, 'failed');
    } else if (status === 'stale') {
      this.db.updateDraft(draft.id, 'stale');
    }
  }
  observeSelfChat(messages) {
    for (const message of messages || []) {
      const draftId = draftIdFromNotification(message.body);
      if (!draftId) continue;
      const id = message.id?._serialized || message.id;
      if (typeof id === 'string' && this.db.bindNotification(draftId, id)) {
        this.logger.info(`Bound draft #${draftId} to its WhatsApp notification`);
      }
    }
  }
  async handleApproval({approvalWhatsappId, quotedWhatsappId, option, label}) {
    if (!approvalWhatsappId || ![1, 2, 3].includes(option)) {
      return {ok: false, code: 'invalid'};
    }
    let quoted = quotedWhatsappId;
    if (!quoted) {
      const latest = this.db.latestActiveDraft();
      if (!latest?.notification_whatsapp_id) return {ok: false, code: 'no-active-draft'};
      quoted = latest.notification_whatsapp_id;
      this.logger.info(`Unquoted ${option} applied to latest draft #${latest.id}`);
    }
    const now = new Date(this.now()).toISOString();
    const sendingEnabled = this.drafts.canSendToContact();
    const claimed = this.db.claimApproval({
      notificationWhatsappId: quoted,
      approvalWhatsappId,
      option,
      now,
      dryRun: !sendingEnabled
    });
    if (!claimed.ok) {
      this.logger.info(`Rejected approval ${approvalWhatsappId}: ${claimed.code}`);
      if (claimed.draft && claimed.code !== 'duplicate-approval') {
        await this.drafts.notifyOwner(formatRejection(claimed.draft, claimed.code));
      }
      return claimed;
    }
    if (!sendingEnabled || !this.db.isEnabled(claimed.chatId)) {
      this.logger.info(`Approval matched draft #${claimed.draft.id} option ${option}; sending is disabled`);
      await this.drafts.notifyOwner(`Draft #${claimed.draft.id} — option ${option} recognized. Sending is disabled. Nothing was sent.`);
      return {ok: false, code: 'send-disabled', draft: claimed.draft};
    }
    try {
      const sent = await this.drafts.sendApproved({chatId: claimed.chatId, text: claimed.text});
      if (!sent.ok) {
        this.db.markUncertain(claimed.draft.id);
        this.logger.error(`Approved send refused (${sent.reason})`);
        await this.drafts.notifyOwner(formatRejection(claimed.draft, 'uncertain'));
        return {ok: false, code: sent.reason, draft: this.db.draft(claimed.draft.id)};
      }
      this.db.markSent(claimed.draft.id, sent.whatsappId, now);
      const saved = this.db.draft(claimed.draft.id);
      await this.drafts.notifyOwner(formatConfirmation(saved, label || this.drafts.label));
      this.logger.info(`Draft #${saved.id} option ${option} sent`);
      return {ok: true, code: 'sent', draft: saved};
    } catch (error) {
      this.db.markUncertain(claimed.draft.id);
      this.logger.error(`Approved send unconfirmed (${error.message}). No automatic retry.`);
      await this.drafts.notifyOwner(formatRejection(claimed.draft, 'uncertain'));
      return {ok: false, code: 'uncertain', draft: this.db.draft(claimed.draft.id)};
    }
  }
  async drain() {
    // Test utility: wait for already-running generations; does not advance timers.
    const active = [...this.running.values(), ...this.voiceTasks];
    if (active.length) await Promise.allSettled(active);
    const started = [...this.running.values()];
    if (started.length) await Promise.allSettled(started);
  }
  stop() {
    this.stopped = true;
    for (const chatId of [...this.timers.keys()]) this.cancelTimer(chatId);
    this.due.clear();
  }
}
module.exports = {DatingAgent};
