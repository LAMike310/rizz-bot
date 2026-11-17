import {NextResponse} from 'next/server';
import {
  dashboardSendEnabled,
  issueSession,
  requestIsSecure,
  sameOriginWrite,
  secretsMatch,
  sendSecretsConfigured,
  sessionCookie
} from '../../../lib/owner-auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(request: Request) {
  if (!dashboardSendEnabled() || !sendSecretsConfigured()) {
    return NextResponse.json({ok: false, code: 'SEND_DISABLED'}, {status: 403, headers: {'Cache-Control': 'no-store'}});
  }
  if (!sameOriginWrite(request)) {
    return NextResponse.json({ok: false, code: 'UNAUTHORIZED'}, {status: 403, headers: {'Cache-Control': 'no-store'}});
  }
  let body: {secret?: unknown};
  try { body = await request.json(); }
  catch { return NextResponse.json({ok: false, code: 'UNAUTHORIZED'}, {status: 401, headers: {'Cache-Control': 'no-store'}}); }
  const secret = typeof body.secret === 'string' ? body.secret : '';
  if (!secretsMatch(secret, process.env.DASHBOARD_OWNER_SECRET || '')) {
    return NextResponse.json({ok: false, code: 'UNAUTHORIZED'}, {status: 401, headers: {'Cache-Control': 'no-store'}});
  }
  const response = NextResponse.json({ok: true}, {headers: {'Cache-Control': 'no-store'}});
  response.headers.append('set-cookie', sessionCookie(issueSession(), requestIsSecure(request)));
  return response;
}
