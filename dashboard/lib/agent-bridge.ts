export async function requestDraftSend(draftId: string, option: number, idempotencyKey: string): Promise<{http: number; code: string}> {
  const token = process.env.DASHBOARD_AGENT_TOKEN || '';
  const port = process.env.DASHBOARD_AGENT_PORT || '39217';
  if (!/^\d+$/.test(port) || !token) return {http: 503, code: 'WHATSAPP_UNAVAILABLE'};
  try {
    const response = await fetch(`http://127.0.0.1:${port}/internal/drafts/${draftId}/send`, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'idempotency-key': idempotencyKey
      },
      body: JSON.stringify({option})
    });
    const body = await response.json() as {code?: string};
    return {http: response.status, code: typeof body.code === 'string' ? body.code : 'UNKNOWN_OUTCOME'};
  } catch {
    return {http: 503, code: 'WHATSAPP_UNAVAILABLE'};
  }
}
