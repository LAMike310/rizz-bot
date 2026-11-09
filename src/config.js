'use strict';
const path = require('node:path');

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  if (!['true', 'false'].includes(raw.toLowerCase())) throw new Error(`${name} must be true or false`);
  return raw.toLowerCase() === 'true';
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
  if (!bool('DRAFT_ONLY', true)) throw new Error('V1 is hard-locked to DRAFT_ONLY=true.');
  const mode = process.env.OPENROUTER_OUTPUT_MODE || 'prompt';
  if (!['prompt', 'json_object', 'json_schema'].includes(mode)) throw new Error('Invalid OPENROUTER_OUTPUT_MODE');
  const temp = Number(process.env.AI_TEMPERATURE ?? 0.6);
  if (!Number.isFinite(temp) || temp < 0 || temp > 2) throw new Error('AI_TEMPERATURE must be 0–2');
  return Object.freeze({
    root, number, apiKey, model, outputMode: mode,
    temperature: temp,
    maxRetries: integer('OPENROUTER_MAX_RETRIES', 1, 0, 2),
    maxOutputTokens: integer('AI_MAX_OUTPUT_TOKENS', 300, 80, 2048),
    apiTimeoutMs: integer('AI_TIMEOUT_MS', 30000, 1000, 120000),
    debounceMs: integer('DEBOUNCE_MS', 5000, 100, 300000),
    maxHistory: integer('MAX_HISTORY_MESSAGES', 30, 2, 200),
    selfNotifications: bool('SELF_CHAT_NOTIFICATIONS', true),
    maxEventAgeMs: integer('MAX_EVENT_AGE_MS', 30000, 0, 300000),
    clientId: process.env.WHATSAPP_CLIENT_ID || 'dating-agent',
    authPath: path.resolve(root, process.env.WHATSAPP_AUTH_PATH || '.wwebjs_auth'),
    dbPath: path.resolve(root, process.env.DATABASE_PATH || 'data/whatsapp.db'),
    promptPath: path.resolve(root, 'prompts/dating.md'),
    profilePath: path.resolve(root, 'prompts/me.json'),
    chromeExecutable: process.env.CHROME_EXECUTABLE_PATH || undefined,
    headless: bool('WHATSAPP_HEADLESS', false),
    logLevel: process.env.LOG_LEVEL || 'info'
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
