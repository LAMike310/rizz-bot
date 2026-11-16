const STOPS = ['#3f8f6b', '#6d5efc', '#c46b4a', '#3d7ea6', '#8b6bb8', '#b4536a'];

export function Avatar({name, size = 44}: {name: string; size?: number}) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const initials = (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : (parts[0] || '?').slice(0, 2)).toUpperCase();
  let hash = 0;
  for (const char of name) hash = (hash + char.charCodeAt(0)) % STOPS.length;
  const from = STOPS[hash];
  const to = STOPS[(hash + 2) % STOPS.length];
  return (
    <span
      className="avatar"
      style={{background: `linear-gradient(145deg, ${from}, ${to})`, width: size, height: size, fontSize: Math.max(12, Math.round(size * 0.34))}}
      aria-hidden="true"
    >
      {initials}
    </span>
  );
}
