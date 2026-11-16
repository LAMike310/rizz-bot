export function isLocalHost(host: string | null): boolean {
  if (!host) return false;
  const bare = host.trim().toLowerCase().replace(/:\d+$/, '');
  const name = bare.startsWith('[') && bare.endsWith(']') ? bare.slice(1, -1) : bare;
  return name === '127.0.0.1' || name === 'localhost' || name === '::1';
}
