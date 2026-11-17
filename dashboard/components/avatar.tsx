const STOPS = ['#3f8f6b', '#6d5efc', '#c46b4a', '#3d7ea6', '#8b6bb8', '#b4536a'];

function photoSource(avatarJpeg?: string | null): string | null {
  if (!avatarJpeg || avatarJpeg.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(avatarJpeg)) return null;
  return `data:image/jpeg;base64,${avatarJpeg}`;
}

export function Avatar({name, avatarJpeg = null, size = 44}: {name: string; avatarJpeg?: string | null; size?: number}) {
  const photo = photoSource(avatarJpeg);
  const frame = {width: size, height: size};
  if (photo) {
    return <img className="avatar" src={photo} alt="" width={size} height={size} style={frame} />;
  }
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const initials = (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : (parts[0] || '?').slice(0, 2)).toUpperCase();
  let hash = 0;
  for (const char of name) hash = (hash + char.charCodeAt(0)) % STOPS.length;
  const from = STOPS[hash];
  const to = STOPS[(hash + 2) % STOPS.length];
  return (
    <span
      className="avatar"
      style={{background: `linear-gradient(160deg, ${from}, ${to})`, ...frame, fontSize: `${Math.max(0.7, (size * 0.34) / 16)}rem`}}
      aria-hidden="true"
    >
      {initials}
    </span>
  );
}
