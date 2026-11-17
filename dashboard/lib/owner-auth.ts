import {createHmac, timingSafeEqual} from 'node:crypto';
import {sameSiteHost} from './host';
import type {SendControls} from './types';

const COOKIE = 'inbox_owner';
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

export function dashboardSendEnabled(): boolean {
  return process.env.DASHBOARD_SEND_ENABLED === 'true';
}

export function sendSecretsConfigured(): boolean {
  return secretOk('DASHBOARD_OWNER_SECRET') && secretOk('DASHBOARD_SESSION_SECRET') && secretOk('DASHBOARD_AGENT_TOKEN');
}

function secretOk(name: string): boolean {
  return (process.env[name] || '').length >= 16;
}

export function sendControlMode(cookie: string | undefined, now = Date.now()): SendControls {
  if (!dashboardSendEnabled()) return 'off';
  if (!sendSecretsConfigured()) return 'unconfigured';
  return readSession(cookie, now) ? 'ready' : 'locked';
}

export function secretsMatch(input: string, secret: string): boolean {
  const actual = Buffer.from(input);
  const expected = Buffer.from(secret);
  if (actual.length !== expected.length) {
    timingSafeEqual(expected, expected);
    return false;
  }
  return timingSafeEqual(actual, expected);
}

export function issueSession(now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({exp: now + MAX_AGE_MS})).toString('base64url');
  const sig = createHmac('sha256', process.env.DASHBOARD_SESSION_SECRET || '').update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function readSession(cookie: string | undefined, now = Date.now()): boolean {
  if (!cookie || !process.env.DASHBOARD_SESSION_SECRET) return false;
  const dot = cookie.lastIndexOf('.');
  if (dot <= 0) return false;
  const payload = cookie.slice(0, dot);
  const sig = cookie.slice(dot + 1);
  const expected = createHmac('sha256', process.env.DASHBOARD_SESSION_SECRET).update(payload).digest('base64url');
  if (!secretsMatch(sig, expected)) return false;
  try {
    const body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {exp?: number};
    return typeof body.exp === 'number' && body.exp > now;
  } catch {
    return false;
  }
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${MAX_AGE_MS / 1000}; SameSite=Strict${secure ? '; Secure' : ''}`;
}

export function cookieValue(header: string | null, name = COOKIE): string {
  if (!header) return '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return '';
}

export function sameOriginWrite(request: Request): boolean {
  const host = request.headers.get('host');
  const origin = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');
  if (!host || !origin) return false;
  if (site && site !== 'same-origin') return false;
  if (request.headers.get('x-inbox-request') !== '1') return false;
  let originHost = '';
  try { originHost = new URL(origin).host; }
  catch { return false; }
  const forwarded = (request.headers.get('x-forwarded-host') || '').split(',')[0].trim();
  // Tailscale Serve keeps the browser host in X-Forwarded-Host and may rewrite Host to loopback.
  return sameSiteHost(originHost, host) || sameSiteHost(originHost, forwarded);
}

export function requestIsSecure(request: Request): boolean {
  const proto = request.headers.get('x-forwarded-proto') || new URL(request.url).protocol.replace(':', '');
  return proto === 'https';
}
