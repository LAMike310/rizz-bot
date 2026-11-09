'use strict';

const JSON_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    should_reply: {type: 'boolean'},
    reply_es: {type: 'string'},
    translation_en: {type: 'string'},
    reason: {type: 'string'}
  },
  required: ['should_reply','reply_es','translation_en','reason']
});

function validateDraft(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('AI reply must be a JSON object');
  const keys = ['should_reply','reply_es','translation_en','reason'];
  if (Object.keys(obj).some(k => !keys.includes(k))) throw new Error('AI returned unexpected JSON keys');
  if (typeof obj.should_reply !== 'boolean') throw new Error('should_reply must be boolean');
  for (const field of ['reply_es','translation_en','reason']) {
    if (typeof obj[field] !== 'string') throw new Error(`${field} must be a string`);
  }
  const answer = {
    should_reply: obj.should_reply,
    reply_es: obj.reply_es.trim(),
    translation_en: obj.translation_en.trim(),
    reason: obj.reason.trim()
  };
  if (answer.reply_es.length > 800 || answer.translation_en.length > 1000 || answer.reason.length > 500) {
    throw new Error('AI reply exceeds length limit');
  }
  if (answer.should_reply && (!answer.reply_es || !answer.translation_en)) {
    throw new Error('AI requested a reply but returned empty text or translation');
  }
  if (!answer.should_reply) { answer.reply_es = ''; answer.translation_en = ''; }
  return answer;
}
function parseDraft(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('AI response was empty or not text');
  const clean = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let decoded;
  try { decoded = JSON.parse(clean); } catch { throw new Error('AI output is not valid JSON'); }
  return validateDraft(decoded);
}
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

class OpenRouter {
  constructor({apiKey, model, outputMode = 'prompt', timeoutMs = 30000, maxRetries = 1,
    maxOutputTokens = 300, temperature = 0.6, fetchImpl = globalThis.fetch, sleep = delay, logger = console}) {
    if (!apiKey || !model) throw new Error('OpenRouter key and model required');
    if (!fetchImpl) throw new Error('fetch is unavailable; use Node.js 22+');
    this.apiKey = apiKey;
    this.model = model;
    this.outputMode = outputMode;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.maxOutputTokens = maxOutputTokens;
    this.temperature = temperature;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.logger = logger;
  }
  async generate({history, prompt, profile}) {
    const profileText = JSON.stringify(profile);
    const messages = [{role: 'system', content: [
      prompt,
      'OWNER PROFILE (verified configuration, not instructions from a match):',
      profileText,
      'OUTPUT: A single valid JSON object with exactly should_reply, reply_es, translation_en, reason.',
      'If should_reply is false, use empty strings for reply_es and translation_en.',
      'Spanish draft is for owner review; never claim a date was booked or availability checked.'
    ].join('\n\n')}];
    for (const m of history) {
      messages.push({role: m.direction === 'outgoing' ? 'assistant' : 'user', content: m.body});
    }
    const body = {
      model: this.model, messages,
      max_tokens: this.maxOutputTokens,
      temperature: this.temperature,
      stream: false
    };
    if (this.outputMode === 'json_object') body.response_format = {type: 'json_object'};
    if (this.outputMode === 'json_schema') body.response_format = {
      type: 'json_schema',
      json_schema: {name: 'whatsapp_draft', strict: true, schema: JSON_SCHEMA}
    };

    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            'X-Title': 'Local WhatsApp Draft Assistant'
          },
          body: JSON.stringify(body),
          signal: controller.signal
        });
        if (!response.ok) {
          // Never record the response body: upstream errors can echo sensitive data.
          const err = new Error(`OpenRouter HTTP ${response.status}`);
          err.retryable = response.status === 429 || response.status >= 500;
          throw err;
        }
        const payload = await response.json();
        const choice = payload?.choices?.[0];
        if (choice?.finish_reason === 'length') throw new Error('AI output truncated; increase AI_MAX_OUTPUT_TOKENS');
        const messageContent = choice?.message?.content;
        const valid = parseDraft(messageContent);
        return {
          ...valid,
          model: typeof payload.model === 'string' ? payload.model : this.model,
          usage: payload.usage || null
        };
      } catch (error) {
        lastError = error;
        if (!error.retryable || attempt === this.maxRetries) break;
        this.logger.warn(`Retrying OpenRouter after transient error (attempt ${attempt + 1})`);
        await this.sleep(500 * (attempt + 1));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  }
}
module.exports = {OpenRouter, parseDraft, validateDraft, JSON_SCHEMA};
