import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import test from 'node:test';
import {POST as sendDraft} from '../app/api/drafts/[draftId]/send/route';
import {POST as unlock} from '../app/api/session/route';
import {DraftPanel} from '../components/draft-panel';
import {
  cookieValue,
  issueSession,
  readSession,
  sameOriginWrite,
  sendControlMode,
  sessionCookie
} from '../lib/owner-auth';

const SECRET = 'owner-secret-value';
const SESSION = 'session-secret-val';
const TOKEN = 'agent-token-value1';

function withSendEnv(run: () => Promise<void> | void) {
  const previous = {
    DASHBOARD_SEND_ENABLED: process.env.DASHBOARD_SEND_ENABLED,
    DASHBOARD_OWNER_SECRET: process.env.DASHBOARD_OWNER_SECRET,
    DASHBOARD_SESSION_SECRET: process.env.DASHBOARD_SESSION_SECRET,
    DASHBOARD_AGENT_TOKEN: process.env.DASHBOARD_AGENT_TOKEN
  };
  process.env.DASHBOARD_SEND_ENABLED = 'true';
  process.env.DASHBOARD_OWNER_SECRET = SECRET;
  process.env.DASHBOARD_SESSION_SECRET = SESSION;
  process.env.DASHBOARD_AGENT_TOKEN = TOKEN;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value == null) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

function draft(sendable: boolean) {
  return {
    kind: 'draft' as const,
    id: '86',
    timestamp: '2026-11-16T18:00:00.000Z',
    timeLabel: '1:00 PM',
    status: sendable ? 'active' : 'expired',
    statusLabel: sendable ? 'Ready' : 'Expired',
    sendable,
    options: [
      {style: 'natural', label: null, replyEs: 'El viernes', translationEn: 'On Friday'},
      {style: 'playful', label: null, replyEs: 'Jaja el viernes', translationEn: 'Haha Friday'}
    ],
    selectedOption: null,
    relatedMessageId: null,
    previousDraftId: null,
    approvedAt: null,
    sentAt: null,
    expiresAt: null,
    hasSendId: false,
    warning: null
  };
}

test('dashboard send stays off until the flag and owner session are configured', () => {
  const previous = process.env.DASHBOARD_SEND_ENABLED;
  delete process.env.DASHBOARD_SEND_ENABLED;
  assert.equal(sendControlMode(undefined), 'off');
  if (previous == null) delete process.env.DASHBOARD_SEND_ENABLED;
  else process.env.DASHBOARD_SEND_ENABLED = previous;
});

test('owner session cookies are httpOnly and same-origin writes are required', async () => {
  await withSendEnv(() => {
    assert.equal(sendControlMode(undefined), 'locked');
    const token = issueSession();
    assert.equal(readSession(token), true);
    assert.match(sessionCookie(token, true), /HttpOnly/);
    assert.match(sessionCookie(token, true), /SameSite=Strict/);
    assert.match(sessionCookie(token, true), /Secure/);
    assert.equal(sessionCookie(token, false).includes('Secure'), false);
    assert.equal(cookieValue(`a=1; inbox_owner=${token}`), token);
    const headers = {
      host: 'mikes-mac.tail544626.ts.net',
      origin: 'https://mikes-mac.tail544626.ts.net',
      'sec-fetch-site': 'same-origin',
      'x-inbox-request': '1'
    };
    assert.equal(sameOriginWrite(new Request('https://mikes-mac.tail544626.ts.net/api/drafts/1/send', {headers})), true);
    assert.equal(sameOriginWrite(new Request('https://mikes-mac.tail544626.ts.net/api/drafts/1/send', {
      headers: {...headers, origin: 'https://evil.example'}
    })), false);
    assert.equal(sameOriginWrite(new Request('http://127.0.0.1:3010/api/drafts/1/send', {
      headers: {
        host: '127.0.0.1:3010',
        'x-forwarded-host': 'mikes-mac.tail544626.ts.net',
        origin: 'https://mikes-mac.tail544626.ts.net',
        'sec-fetch-site': 'same-origin',
        'x-inbox-request': '1'
      }
    })), true);
    assert.equal(sameOriginWrite(new Request('http://127.0.0.1:3010/api/drafts/1/send', {
      headers: {
        host: '127.0.0.1:3010',
        'x-forwarded-host': 'mikes-mac.tail544626.ts.net',
        origin: 'https://evil.example',
        'sec-fetch-site': 'same-origin',
        'x-inbox-request': '1'
      }
    })), false);
    assert.equal(sendControlMode(token), 'ready');
  });
});

test('the send route rejects disabled, anonymous, and cross-origin requests', async () => {
  await withSendEnv(async () => {
    const disabled = process.env.DASHBOARD_SEND_ENABLED;
    process.env.DASHBOARD_SEND_ENABLED = 'false';
    const off = await sendDraft(new Request('http://127.0.0.1/api/drafts/4/send', {method: 'POST', body: '{"option":1}'}), {
      params: Promise.resolve({draftId: '4'})
    });
    assert.equal(off.status, 403);
    assert.equal((await off.json()).code, 'SEND_DISABLED');
    process.env.DASHBOARD_SEND_ENABLED = disabled;

    const token = issueSession();
    const anonymous = await sendDraft(new Request('http://127.0.0.1/api/drafts/4/send', {
      method: 'POST',
      headers: {origin: 'http://127.0.0.1', host: '127.0.0.1', 'x-inbox-request': '1', 'content-type': 'application/json'},
      body: JSON.stringify({option: 2, chat_id: '1999@c.us'})
    }), {params: Promise.resolve({draftId: '4'})});
    assert.equal(anonymous.status, 401);

    const foreign = await sendDraft(new Request('http://127.0.0.1/api/drafts/4/send', {
      method: 'POST',
      headers: {
        origin: 'https://evil.example',
        host: '127.0.0.1',
        cookie: `inbox_owner=${token}`,
        'x-inbox-request': '1',
        'content-type': 'application/json',
        'idempotency-key': 'request-001'
      },
      body: JSON.stringify({option: 2})
    }), {params: Promise.resolve({draftId: '4'})});
    assert.equal(foreign.status, 403);

    const unlocked = await unlock(new Request('http://127.0.0.1/api/session', {
      method: 'POST',
      headers: {origin: 'http://127.0.0.1', host: '127.0.0.1', 'x-inbox-request': '1', 'content-type': 'application/json'},
      body: JSON.stringify({secret: SECRET})
    }));
    assert.equal(unlocked.status, 200);
    assert.match(unlocked.headers.get('set-cookie') || '', /HttpOnly/);
    assert.equal((unlocked.headers.get('set-cookie') || '').includes(TOKEN), false);
    assert.equal((unlocked.headers.get('set-cookie') || '').includes(SECRET), false);
  });
});

test('desktop send buttons appear only for a ready sendable draft', () => {
  const historical = renderToStaticMarkup(createElement(DraftPanel, {
    open: true,
    onToggle() {},
    sendControls: 'ready',
    recipientName: 'Camila',
    recipientIdentity: '+1 555 123 4567',
    draft: draft(false)
  }));
  assert.equal(historical.includes('>Send<'), false);
  const ready = renderToStaticMarkup(createElement(DraftPanel, {
    open: true,
    onToggle() {},
    sendControls: 'ready',
    recipientName: 'Camila',
    recipientIdentity: '+1 555 123 4567',
    draft: draft(true)
  }));
  assert.equal(ready.match(/>Send</g)?.length, 2);
  assert.match(ready, /Hover an option and choose Send/);
  assert.equal(ready.includes('<button type="submit"'), false);
  const locked = renderToStaticMarkup(createElement(DraftPanel, {
    open: true,
    onToggle() {},
    sendControls: 'off',
    draft: draft(true)
  }));
  assert.equal(locked.includes('>Send<'), false);
  assert.match(locked, /To send, reply 1, 2, or 3/);
});
