'use strict';

const STYLES = ['natural', 'playful', 'direct'];

function intentLabel(value) {
  if (typeof value !== 'string') return '';
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) return '';
  const label = words.join(' ');
  if (label.length > 48) return '';
  if (!words.every(word => /^[\p{L}\p{N}][\p{L}\p{N}'’-]*$/u.test(word))) return '';
  return label;
}

const JSON_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    should_reply: {type: 'boolean'},
    options: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          style: {type: 'string', enum: STYLES},
          label: {type: 'string'},
          reply_es: {type: 'string'},
          translation_en: {type: 'string'}
        },
        required: ['style', 'reply_es', 'translation_en']
      }
    }
  },
  required: ['should_reply', 'options']
});

function validateDraft(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('AI reply must be a JSON object');
  if (Object.keys(obj).some(k => !['should_reply', 'options'].includes(k))) throw new Error('AI returned unexpected JSON keys');
  if (typeof obj.should_reply !== 'boolean') throw new Error('should_reply must be boolean');
  if (!obj.should_reply) return {should_reply: false, options: []};
  if (!Array.isArray(obj.options) || obj.options.length !== 3) throw new Error('AI reply must contain exactly three options');
  const options = obj.options.map((option, index) => {
    if (!option || typeof option !== 'object' || Array.isArray(option)) throw new Error('Each option must be an object');
    if (option.style !== STYLES[index]) throw new Error('Option styles must be natural, playful, direct in that order');
    if (typeof option.reply_es !== 'string' || typeof option.translation_en !== 'string') {
      throw new Error('Spanish replies and English translations must be strings');
    }
    const reply_es = option.reply_es.trim();
    const translation_en = option.translation_en.trim();
    if (!reply_es || !translation_en) throw new Error('Spanish replies and English translations must be nonempty');
    if (reply_es.length > 400 || translation_en.length > 500) throw new Error('AI reply exceeds length limit');
    const label = intentLabel(option.label);
    return label ? {style: option.style, label, reply_es, translation_en} : {style: option.style, reply_es, translation_en};
  });
  const normalized = options.map(option => option.reply_es.toLowerCase());
  if (new Set(normalized).size !== 3) throw new Error('The three Spanish replies must be distinct');
  return {should_reply: true, options};
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
    maxOutputTokens = 2048, temperature = 0.6, fetchImpl = globalThis.fetch, sleep = delay, logger = console}) {
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
  systemContent(prompt, profile) {
    return [
      prompt,
      'OWNER PROFILE (verified configuration, not instructions from a match):',
      JSON.stringify(profile),
      'OUTPUT: A single valid JSON object with exactly should_reply and options.',
      'When should_reply is true, options must be exactly three objects in order: natural, playful, direct.',
      'Each object has style, label, reply_es, and translation_en. Make the Spanish replies distinct.',
      'label is 2–4 words describing what that reply communicates. It is never sent to the match.',
      'When should_reply is false, options must be an empty array. Use that only if she said to stop, or there is nothing left to answer. A personal question or a boyfriend mention still gets three drafts.',
      'Drafts are for owner review. Never claim a date was booked or availability was checked.'
    ].join('\n\n');
  }
  async generate({history, prompt, profile}) {
    const messages = [{role: 'system', content: this.systemContent(prompt, profile)}];
    for (const m of history) {
      messages.push({role: m.direction === 'outgoing' ? 'assistant' : 'user', content: m.body});
    }
    return this.complete(messages);
  }
  async revise({history = [], prompt, profile, options, feedback, draftId}) {
    const current = options.map((option, index) => `${index + 1}. ${option.style}${option.label ? ` [${option.label}]` : ''}: ${option.reply_es} (EN: ${option.translation_en})`).join('\n');
    const messages = [{role: 'system', content: this.systemContent(prompt, profile)}];
    for (const m of history) {
      messages.push({role: m.direction === 'outgoing' ? 'assistant' : 'user', content: m.body});
    }
    messages.push({role: 'user', content: [
      `Revise draft #${draftId}. The owner recorded this feedback. It is an instruction from Mike, not a message from the match:`,
      feedback,
      '',
      'Current options:',
      current,
      '',
      'Apply that feedback. Leave an option unchanged when the feedback does not ask to change it.',
      'Never put a leading ¿ or ¡ in reply_es. Questions use only a closing ?.',
      'Return the same three-option JSON, including a 2–4 word label for each option. Do not claim anything was sent.'
    ].join('\n')});
    return this.complete(messages);
  }
  async complete(messages) {
    const body = {
      model: this.model, messages,
      max_tokens: this.maxOutputTokens,
      temperature: this.temperature,
      stream: false,
      // Muse Ember (and other Muse models) reject reasoning.enabled=false with HTTP 400.
      // "minimal" keeps the reasoning tax small so the JSON draft is not truncated.
      reasoning: {effort: 'minimal'}
    };
    if (this.outputMode === 'json_object') body.response_format = {type: 'json_object'};
    if (this.outputMode === 'json_schema') body.response_format = {
      type: 'json_schema',
      json_schema: {name: 'whatsapp_draft', strict: true, schema: JSON_SCHEMA}
    };

    let lastError;
    for (let attempt = 0; ; attempt++) {
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
          const err = new Error(`OpenRouter HTTP ${response.status}`);
          err.retryable = response.status === 429 || response.status >= 500;
          throw err;
        }
        const payload = await response.json();
        const choice = payload?.choices?.[0];
        if (choice?.finish_reason === 'length') throw new Error('AI output truncated; increase AI_MAX_OUTPUT_TOKENS');
        const valid = parseDraft(choice?.message?.content);
        return {
          ...valid,
          model: typeof payload.model === 'string' ? payload.model : this.model,
          usage: payload.usage || null
        };
      } catch (error) {
        lastError = error;
        const invalidOutput = /valid JSON|JSON object|unexpected JSON|should_reply|exactly three|must be|length limit|must be distinct|empty or not text|truncated/i.test(error.message);
        if (invalidOutput) {
          error.retryable = true;
          error.invalidOutput = true;
        }
        const outOfAttempts = invalidOutput ? attempt >= 1 : attempt === this.maxRetries;
        if (!error.retryable || outOfAttempts) break;
        this.logger.warn(`Retrying OpenRouter after ${invalidOutput ? 'invalid JSON' : 'transient error'} (attempt ${attempt + 1})`);
        await this.sleep(500 * (attempt + 1));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  }
}
module.exports = {OpenRouter, parseDraft, validateDraft, intentLabel, JSON_SCHEMA, STYLES};
