function bareHost(host: string | null): string | null {
  if (!host) return null;
  const bare = host.trim().toLowerCase().replace(/:\d+$/, '');
  return bare.startsWith('[') && bare.endsWith(']') ? bare.slice(1, -1) : bare;
}

export function isLocalHost(host: string | null): boolean {
  const name = bareHost(host);
  if (!name) return false;
  return name === '127.0.0.1' || name === 'localhost' || name === '::1';
}

/** Tailscale MagicDNS, e.g. mikes-macbook-air.tail544626.ts.net */
export function isTailnetHost(host: string | null): boolean {
  const name = bareHost(host);
  if (!name) return false;
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.ts\.net$/.test(name);
}

export function isAllowedInboxHost(host: string | null): boolean {
  return isLocalHost(host) || isTailnetHost(host);
}

export function sameSiteHost(left: string | null, right: string | null): boolean {
  const a = bareHost(left);
  const b = bareHost(right);
  return Boolean(a && b && a === b);
}
