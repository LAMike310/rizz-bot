'use strict';
require('dotenv').config();

function keyShape(key) {
  return {
    length: key.length,
    prefix: key.slice(0, 7),
    whitespace: /\s/.test(key),
    quotes: /["']/.test(key)
  };
}

function redact(text, key) {
  return String(text || '').split(key).join('[redacted]').slice(0, 400);
}

async function request(path, {method = 'GET', body, key}) {
  const response = await fetch(`https://openrouter.ai/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'X-Title': 'Local WhatsApp Draft Assistant'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return {status: response.status, json, text: redact(text, key)};
}

async function main() {
  const key = process.env.OPENROUTER_API_KEY || '';
  const model = (process.env.OPENROUTER_MODEL || '').trim();
  if (!key) throw new Error('OPENROUTER_API_KEY is missing from .env');
  if (!model) throw new Error('OPENROUTER_MODEL is missing from .env');
  console.log('Key shape:', keyShape(key));
  console.log('Model:', model);

  const auth = await request('/key', {key});
  console.log('Auth check status:', auth.status);
  if (auth.json?.error?.message) console.log('Auth error:', auth.json.error.message);
  if (auth.status !== 200) {
    console.log('Auth response:', auth.text);
    process.exitCode = 1;
    return;
  }
  const label = auth.json?.data?.label || auth.json?.data?.limit_remaining != null
    ? `ok, remaining=${auth.json.data.limit_remaining}`
    : 'ok';
  console.log('Auth:', label);

  const chat = await request('/chat/completions', {
    method: 'POST',
    key,
    body: {
      model,
      stream: false,
      max_tokens: 40,
      temperature: 0,
      messages: [{role: 'user', content: 'Reply with the single word pong.'}]
    }
  });
  console.log('Chat status:', chat.status);
  if (chat.json?.error?.message) console.log('Chat error:', chat.json.error.message);
  const content = chat.json?.choices?.[0]?.message?.content;
  if (content) console.log('Model reply:', String(content).trim());
  else console.log('Chat response:', chat.text);
  if (chat.status !== 200) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
