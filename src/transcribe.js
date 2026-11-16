'use strict';

function usageCost(usage) {
  if (!usage || typeof usage !== 'object') return null;
  if (usage.cost != null) return usage.cost;
  if (usage.total_cost != null) return usage.total_cost;
  return null;
}

async function transcribeAudio({
  apiKey,
  model,
  data,
  format,
  timeoutMs,
  language,
  fetchImpl = globalThis.fetch,
  title = 'WhatsApp voice transcription'
}) {
  if (!apiKey) {
    const error = new Error('OPENROUTER_API_KEY is missing');
    error.code = 'config';
    throw error;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  const body = {model, input_audio: {data, format}};
  if (language && language !== 'auto') body.language = language;
  try {
    const response = await fetchImpl('https://openrouter.ai/api/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': title
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const latencyMs = Date.now() - started;
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    if (!response.ok) {
      const detail = typeof payload?.error?.message === 'string' ? payload.error.message : `HTTP ${response.status}`;
      const error = new Error(`OpenRouter transcription failed (${detail.slice(0, 160)})`);
      error.code = 'provider';
      throw error;
    }
    const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
    if (!text) {
      const error = new Error('OpenRouter transcription response had no text');
      error.code = 'invalid';
      throw error;
    }
    return {
      text,
      latencyMs,
      model: payload.model || model,
      language: language && language !== 'auto' ? language : 'auto',
      usage: payload.usage || null,
      cost: usageCost(payload.usage)
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeout = new Error('OpenRouter transcription timed out');
      timeout.code = 'timeout';
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {transcribeAudio};
