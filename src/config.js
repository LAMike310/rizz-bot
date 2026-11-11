'use strict';
const path = require('node:path');

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  if (!['true', 'false'].includes(raw.toLowerCase())) throw new Error(`${name} must be true or false`);
  return raw.toLowerCase() === 'true';
}
function language(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (value === 'auto' || /^[a-z]{2}$/.test(value)) return value;
  throw new Error(`${name} must be auto or a two-letter language code`);
}
function integer(name, fallback, low, high) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const n = Number(raw);
  if (n < low || n > high) throw new Error(`${name} must be between ${low} and ${high}`);
  return n;
}
function loadConfig(root = process.cwd()) {
  const number = (process.env.TEST_CONTACT_NUMBER || '').replace(/[+\s()\-]/g, '');
  if (!/^\d{8,15}$/.test(number)) throw new Error('Set TEST_CONTACT_NUMBER to 8–15 digits, including country code.');
  const apiKey = process.env.OPENROUTER_API_KEY || '';
  if (!apiKey) throw new Error('Set OPENROUTER_API_KEY in .env');
  const model = (process.env.OPENROUTER_MODEL || '').trim();
  if (!model) throw new Error('Set OPENROUTER_MODEL in .env');
  const mode = process.env.OPENROUTER_OUTPUT_MODE || 'prompt';
  if (!['prompt', 'json_object', 'json_schema'].includes(mode)) throw new Error('Invalid OPENROUTER_OUTPUT_MODE');
  const temp = Number(process.env.AI_TEMPERATURE ?? 0.6);
  if (!Number.isFinite(temp) || temp < 0 || temp > 2) throw new Error('AI_TEMPERATURE must be 0–2');
  return Object.freeze({
    root, number, apiKey, model, outputMode: mode,
    temperature: temp,
    maxRetries: integer('OPENROUTER_MAX_RETRIES', 1, 0, 2),
    maxOutputTokens: integer('AI_MAX_OUTPUT_TOKENS', 2048, 80, 8192),
    apiTimeoutMs: integer('AI_TIMEOUT_MS', 30000, 1000, 120000),
    prod: bool('PROD', false),
    debounceMs: bool('PROD', false) ? 45000 : 5000,
    maxHistory: integer('MAX_HISTORY_MESSAGES', 30, 2, 200),
    selfNotifications: bool('SELF_CHAT_NOTIFICATIONS', true),
    draftOnly: bool('DRAFT_ONLY', true),
    approvedSendEnabled: bool('APPROVED_SEND_ENABLED', false),
    draftTtlMinutes: integer('DRAFT_TTL_MINUTES', 120, 1, 10080),
    maxEnabledContacts: integer('MAX_ENABLED_CONTACTS', 10, 1, 100),
    maxEventAgeMs: integer('MAX_EVENT_AGE_MS', 30000, 0, 300000),
    clientId: process.env.WHATSAPP_CLIENT_ID || 'dating-agent',
    authPath: path.resolve(root, process.env.WHATSAPP_AUTH_PATH || '.wwebjs_auth'),
    dbPath: path.resolve(root, process.env.DATABASE_PATH || 'data/whatsapp.db'),
    promptPath: path.resolve(root, 'prompts/dating.md'),
    profilePath: path.resolve(root, 'prompts/me.json'),
    chromeExecutable: process.env.CHROME_EXECUTABLE_PATH || undefined,
    headless: bool('WHATSAPP_HEADLESS', false),
    logLevel: process.env.LOG_LEVEL || 'info',
    voiceSanityTestEnabled: bool('VOICE_SANITY_TEST_ENABLED', false),
    openrouterSttModel: (process.env.OPENROUTER_STT_MODEL || 'openai/whisper-large-v3-turbo').trim(),
    voiceTestMaxSeconds: integer('VOICE_TEST_MAX_SECONDS', 30, 1, 300),
    voiceTestMaxBytes: integer('VOICE_TEST_MAX_BYTES', 5000000, 1, 25000000),
    voiceSttTimeoutMs: integer('VOICE_STT_TIMEOUT_MS', 30000, 1000, 120000),
    incomingVoiceEnabled: bool('INCOMING_VOICE_ENABLED', false),
    incomingVoiceLanguage: language('INCOMING_VOICE_LANGUAGE', 'es'),
    incomingVoiceMaxSeconds: integer('INCOMING_VOICE_MAX_SECONDS', 120, 1, 600),
    incomingVoiceMaxBytes: integer('INCOMING_VOICE_MAX_BYTES', 8000000, 1, 25000000)
  });
}
function logger(level = 'info') {
  const order = {debug: 0, info: 1, warn: 2, error: 3};
  const min = order[level] ?? 1;
  const output = {};
  for (const name of Object.keys(order)) {
    output[name] = (...args) => {
      if (order[name] >= min) console[name === 'debug' ? 'log' : name](`[${new Date().toISOString()}] ${name.toUpperCase()}`, ...args);
    };
  }
  return output;
}
module.exports = {loadConfig, logger};
