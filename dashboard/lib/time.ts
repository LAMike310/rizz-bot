export function epochMs(value: number | null | undefined, createdAt?: string | null): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  return sqliteTimeMs(createdAt);
}

export function sqliteTimeMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const iso = trimmed.includes('T') ? trimmed : `${trimmed.replace(' ', 'T')}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export function formatWhen(ms: number, now = Date.now()): string {
  const delta = now - ms;
  if (delta >= 0 && delta < 60_000) return 'just now';
  if (delta >= 0 && delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta >= 0 && delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  if (delta >= 86_400_000 && delta < 172_800_000) return 'Yesterday';
  return new Intl.DateTimeFormat('en-US', {month: 'short', day: 'numeric'}).format(ms);
}

export function formatHour(ms: number): string {
  return new Intl.DateTimeFormat('en-US', {hour: 'numeric', minute: '2-digit'}).format(ms);
}

export function dayText(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const start = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const diff = start(now) - start(date);
  if (diff === 0) return 'Today';
  if (diff === 86_400_000) return 'Yesterday';
  return new Intl.DateTimeFormat('en-US', {month: 'short', day: 'numeric'}).format(date);
}

export function formatClock(ms: number): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(ms);
}
