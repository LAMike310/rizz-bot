const LABELS: Record<string, string> = {
  pending: 'Pending',
  active: 'Ready',
  stale: 'Stale',
  sending: 'Submitted',
  sent: 'Sent',
  uncertain: 'Uncertain',
  failed: 'Failed',
  expired: 'Expired'
};

export function listDraftStatus(
  actionable: boolean,
  latest: string | null,
  latestExpiresAt: string | null = null,
  now = Date.now()
): string {
  if (actionable) return 'Draft ready';
  if (latest === 'active' && isPastExpiry(latestExpiresAt, now)) return 'Expired';
  switch (latest) {
    case 'sent': return 'Sent';
    case 'stale': return 'Stale';
    case 'failed': return 'Failed';
    case 'pending': return 'Pending';
    case 'sending': return 'Submitted';
    case 'expired': return 'Expired';
    case 'uncertain': return 'Uncertain';
    default: return 'No active draft';
  }
}

export function statusLabel(status: string): string {
  return LABELS[status] ?? status;
}

export function draftBadgeLabel(status: string, expiresAt: string | null, now = Date.now()): string {
  if (status === 'active' && isPastExpiry(expiresAt, now)) return 'Expired';
  return statusLabel(status);
}

export function draftOpensOnLoad(sendable: boolean): boolean {
  return sendable;
}

export function isPastExpiry(expiresAt: string | null | undefined, now = Date.now()): boolean {
  if (!expiresAt) return false;
  const trimmed = expiresAt.trim();
  if (!trimmed) return false;
  const iso = trimmed.includes('T') ? trimmed : `${trimmed.replace(' ', 'T')}Z`;
  const exp = Date.parse(iso);
  return Number.isFinite(exp) && exp <= now;
}

export function isActionableDraft(row: {
  status: string;
  revision: number;
  expires_at: string | null;
}, contact: {enabled: number; archived: number; revision: number}, now = Date.now()): boolean {
  if (row.status !== 'active') return false;
  if (contact.enabled !== 1 || contact.archived === 1) return false;
  if (contact.revision !== row.revision) return false;
  if (isPastExpiry(row.expires_at, now)) return false;
  return true;
}
