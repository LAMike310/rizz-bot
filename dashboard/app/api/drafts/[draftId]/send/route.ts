import {NextResponse} from 'next/server';
import {requestDraftSend} from '../../../../../lib/agent-bridge';
import {
  cookieValue,
  dashboardSendEnabled,
  readSession,
  sameOriginWrite,
  sendSecretsConfigured
} from '../../../../../lib/owner-auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const noStore = {'Cache-Control': 'no-store'};

function reject(status: number, code: string) {
  return NextResponse.json({ok: false, code}, {status, headers: noStore});
}

export async function POST(request: Request, context: {params: Promise<{draftId: string}>}) {
  if (!dashboardSendEnabled()) return reject(403, 'SEND_DISABLED');
  if (!sendSecretsConfigured()) return reject(503, 'NOT_CONFIGURED');
  if (!readSession(cookieValue(request.headers.get('cookie')))) return reject(401, 'UNAUTHORIZED');
  if (!sameOriginWrite(request)) return reject(403, 'UNAUTHORIZED');
  const {draftId} = await context.params;
  if (!/^\d+$/.test(draftId)) return reject(404, 'DRAFT_NOT_FOUND');
  const key = request.headers.get('idempotency-key') || '';
  if (!/^[A-Za-z0-9._:-]{8,80}$/.test(key)) return reject(422, 'INVALID_OPTION');
  let body: {option?: unknown};
  try {
    body = await request.json();
  } catch {
    return reject(422, 'INVALID_OPTION');
  }
  if (body?.option !== 1 && body?.option !== 2 && body?.option !== 3) return reject(422, 'INVALID_OPTION');
  const result = await requestDraftSend(draftId, body.option, key);
  return NextResponse.json({ok: result.code === 'SENT', code: result.code}, {status: result.http, headers: noStore});
}
