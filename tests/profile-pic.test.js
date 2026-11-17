'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const {
  JPEG_MAX_BYTES,
  candidateIds,
  compressToJpeg,
  profileJpegForContact,
  refreshContactAvatars,
  shouldRefreshAvatar
} = require('../src/profile-pic');

test('profile photo compression returns a small jpeg', async () => {
  const png = await sharp({
    create: {width: 40, height: 64, channels: 3, background: {r: 18, g: 92, b: 70}}
  }).png().toBuffer();
  const encoded = await compressToJpeg(png);
  const jpeg = Buffer.from(encoded, 'base64');
  assert.equal(jpeg[0], 0xff);
  assert.equal(jpeg[1], 0xd8);
  assert.ok(jpeg.length < JPEG_MAX_BYTES);
  const meta = await sharp(jpeg).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, 256);
  assert.equal(meta.height, 256);
  await assert.rejects(() => compressToJpeg(Buffer.from('hello world, not an image')), /not an image/);
});

test('profile photo lookup prefers the chat id, then phone ids, then hidden ids', async () => {
  assert.deepEqual(candidateIds('999@lid', ['999@lid', '1555@c.us', 'other@lid']), ['999@lid', '1555@c.us', 'other@lid']);
  const seen = [];
  const png = await sharp({
    create: {width: 8, height: 8, channels: 3, background: {r: 200, g: 40, b: 40}}
  }).png().toBuffer();
  const client = {
    pupPage: {
      async evaluate(_fn, id) {
        seen.push(id);
        return String(id).endsWith('@c.us') ? png.toString('base64') : null;
      }
    }
  };
  const encoded = await profileJpegForContact(client, {chatId: '999@lid', aliases: ['1555@c.us', 'other@lid']});
  const jpeg = Buffer.from(encoded, 'base64');
  assert.equal(jpeg[0], 0xff);
  assert.equal(jpeg[1], 0xd8);
  assert.deepEqual(seen, ['999@lid', '1555@c.us']);
  const empty = {
    pupPage: {async evaluate() { return null; }}
  };
  assert.equal(await profileJpegForContact(empty, {chatId: '1555@c.us', aliases: []}), null);
});

test('profile photo refresh skips a recent photo and clears a hidden one', async () => {
  assert.equal(shouldRefreshAvatar(new Date().toISOString(), Date.now()), false);
  assert.equal(shouldRefreshAvatar(null, Date.now()), true);
  const saved = [];
  const seen = [];
  const db = {
    aliasesFor(chatId) {
      assert.equal(chatId, 'new@lid');
      return ['1555@c.us', '999@lid'];
    },
    saveContactAvatar(chatId, jpeg) { saved.push({chatId, jpeg}); }
  };
  const client = {
    pupPage: {
      async evaluate(_fn, id) {
        seen.push(id);
        return null;
      }
    }
  };
  const warnings = [];
  await refreshContactAvatars({
    client,
    db,
    log: {warn(message) { warnings.push(message); }},
    now: Date.now(),
    contacts: [
      {chat_id: 'old@c.us', phone: '1', avatar_fetched_at: new Date().toISOString()},
      {chat_id: 'new@lid', phone: '2'}
    ]
  });
  assert.deepEqual(seen, ['new@lid', '1555@c.us', '999@lid']);
  assert.deepEqual(saved, [{chatId: 'new@lid', jpeg: null}]);
  assert.deepEqual(warnings, []);

  const failing = {
    pupPage: {async evaluate() { return {error: 'offline'}; }}
  };
  await refreshContactAvatars({
    client: failing,
    db: {
      aliasesFor() { return []; },
      saveContactAvatar() { throw new Error('should not save'); }
    },
    log: {warn(message) { warnings.push(message); }},
    contacts: [{chat_id: 'x@c.us', phone: '9'}]
  });
  assert.match(warnings[0], /offline/);
});
