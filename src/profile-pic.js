'use strict';

const sharp = require('sharp');

const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;
const JPEG_MAX_BYTES = 128 * 1024;
const JPEG_QUALITY = 72;
const EDGE = 256;
const REFRESH_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

function isImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true;
  if (buffer[0] === 0x89 && buffer.toString('ascii', 1, 4) === 'PNG') return true;
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return true;
  if (buffer.toString('ascii', 0, 3) === 'GIF') return true;
  return false;
}

function candidateIds(chatId, aliases = []) {
  const seen = new Set();
  const primary = String(chatId || '').trim();
  const ids = [];
  if (primary) {
    ids.push(primary);
    seen.add(primary);
  }
  const rest = [];
  for (const alias of aliases) {
    const id = String(alias || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    rest.push(id);
  }
  const rank = (id) => (id.endsWith('@c.us') ? 0 : id.endsWith('@lid') ? 1 : 2);
  rest.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return [...ids, ...rest];
}

function shouldRefreshAvatar(fetchedAt, now = Date.now()) {
  const ms = Date.parse(fetchedAt || '');
  if (!Number.isFinite(ms)) return true;
  return now - ms >= REFRESH_MS;
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Profile photo timed out')), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

async function compressToJpeg(buffer) {
  if (!isImage(buffer)) throw new Error('Profile photo is not an image');
  if (buffer.length > MAX_DOWNLOAD_BYTES) throw new Error('Profile photo is too large');
  const jpeg = await sharp(buffer, {failOn: 'error', limitInputPixels: 16_000_000})
    .rotate()
    .resize(EDGE, EDGE, {fit: 'cover', position: 'attention'})
    .jpeg({quality: JPEG_QUALITY, mozjpeg: true})
    .toBuffer();
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg.length > JPEG_MAX_BYTES) {
    throw new Error('Profile photo did not compress');
  }
  return jpeg.toString('base64');
}

async function downloadProfileBytes(client, contactId) {
  if (!client?.pupPage || !contactId) return null;
  const payload = await client.pupPage.evaluate(async (id, maxBytes) => {
    const encode = (bytes) => {
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      return btoa(binary);
    };
    try {
      const wid = window.require('WAWebWidFactory').createWid(id);
      const thumbs = window.require('WAWebCollections').ProfilePicThumb;
      try { await thumbs.find(wid); } catch { /* A hidden photo or a missing contact is not a failure. */ }
      const thumb = thumbs.get(wid) || thumbs.get(id);
      const picUrl = thumb?.eurl || thumb?.img || '';
      if (!picUrl) return null;
      const response = await fetch(picUrl);
      if (!response.ok) return {error: `Profile photo download failed (${response.status})`};
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.length || bytes.length > maxBytes) return null;
      return encode(bytes);
    } catch (error) {
      return {error: error?.message || String(error)};
    }
  }, contactId, MAX_DOWNLOAD_BYTES);
  if (payload && typeof payload === 'object') throw new Error(payload.error || 'Profile photo could not be downloaded');
  if (typeof payload !== 'string' || !payload) return null;
  return Buffer.from(payload, 'base64');
}

async function profileJpegForContact(client, {chatId, aliases = []} = {}) {
  let lastError = null;
  for (const id of candidateIds(chatId, aliases)) {
    try {
      const bytes = await downloadProfileBytes(client, id);
      if (!bytes || !isImage(bytes) || bytes.length > MAX_DOWNLOAD_BYTES) continue;
      return compressToJpeg(bytes);
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return null;
}

async function refreshContactAvatars({client, db, log, contacts, now = Date.now(), timeoutMs = FETCH_TIMEOUT_MS}) {
  for (const contact of contacts || []) {
    const chatId = contact.chat_id || contact.chatId;
    if (!chatId) continue;
    const fetchedAt = contact.avatar_fetched_at || contact.avatarFetchedAt || null;
    if (!shouldRefreshAvatar(fetchedAt, now)) continue;
    try {
      const jpeg = await withTimeout(profileJpegForContact(client, {
        chatId,
        aliases: contact.aliases || db.aliasesFor(chatId)
      }), timeoutMs);
      db.saveContactAvatar(chatId, jpeg);
    } catch (error) {
      log?.warn?.(`Profile photo for +${contact.phone || chatId}: ${error.message || error}`);
    }
  }
}

module.exports = {
  MAX_DOWNLOAD_BYTES,
  JPEG_MAX_BYTES,
  REFRESH_MS,
  FETCH_TIMEOUT_MS,
  isImage,
  candidateIds,
  shouldRefreshAvatar,
  compressToJpeg,
  downloadProfileBytes,
  profileJpegForContact,
  refreshContactAvatars
};
