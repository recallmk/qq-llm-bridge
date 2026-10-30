import { projectPath } from './project-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { QqImages, qqImageUrl, imageMime } from './qq-images.mjs';
import { visionFixture } from './vision-fixture.mjs';

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(projectPath(".tmp/qq-images-test-"));
  t.after(async () => { const real = await fs.realpath(root); if (!real.toLowerCase().startsWith('e:\\ds\\.tmp\\qq-images-test-')) throw new Error('unexpected test root'); await fs.rm(real, { recursive: true, force: true }); });
  const image = visionFixture(), original = path.join(root, 'original.png'); await fs.writeFile(original, image.bytes);
  let calls = 0;
  const config = { root: path.join(root, 'cache'), localRoots: [root],
    call: async action => { calls++; assert.equal(action, 'get_image'); return { status: 'ok', data: { file: original } }; }, ...options };
  const store = new QqImages(config);
  const capture = (scope = 'p-1', messageId = '1001') => store.capture(scope, [{ file: 'qq-image-opaque-id', url: '' }], { messageId, senderId: '1' });
  return { root, store, image, original, config, capture, calls: () => calls };
}

test('QQ get_image bytes become native raster blocks with source identity and survive restart', async t => {
  const h = await fixture(t); const refs = await h.capture();
  await h.store.bind('p-1', refs, 'obs-from-message');
  const first = await h.store.prepare('p-1', [{ text: '[图片]', imageIds: refs }]);
  assert.equal(first.images[0].data, h.image.bytes.toString('base64'));
  assert.equal(first.images[0].mimeType, 'image/png');
  assert.equal(first.attachedImages[0].observationId, 'obs-from-message');
  assert.equal(first.attachedImages[0].speakerId, '1'); assert.equal(h.calls(), 1);
  assert.equal(JSON.stringify(first.attachedImages).includes(h.root), false);
  const restarted = new QqImages(h.config);
  const next = await restarted.prepare('p-1', [{ text: '刚才那张图是什么' }]);
  assert.equal(next.images[0].data, first.images[0].data); assert.equal(next.attachedImages[0].kind, 'recent');
  assert.equal(h.calls(), 1, 'the cached bytes are reused');
  assert.equal((await restarted.prepare('g-10', [{ text: '刚才那张图是什么', imageIds: refs }])).images.length, 0);
});
test('Tencent CDN bytes are fetched only when selected for a model turn', async t => {
  let downloads = 0; let bytes;
  const h = await fixture(t, { fetchImpl: async url => { downloads++; assert.match(url, /^https:\/\/gchat\.qpic\.cn\//); return new Response(bytes, { headers: { 'content-type': 'image/png' } }); } });
  bytes = h.image.bytes;
  const refs = await h.store.capture('g-10', [{ url: 'http://gchat.qpic.cn/test.png', file: '' }], { messageId: '1', senderId: '2' });
  assert.equal(downloads, 0);
  const result = await h.store.prepare('g-10', [{ text: '[图片]', imageIds: refs }]);
  assert.equal(result.images.length, 1); assert.equal(downloads, 1); assert.equal(h.calls(), 0);
});
test('image URLs and redirect targets cannot fetch arbitrary hosts or local services', async t => {
  for (const url of ['http://127.0.0.1:3102/fish','http://localhost/a','https://qpic.cn.attacker.example/a','file:///D:/Agent-project/ds/a.png','https://user:pass@gchat.qpic.cn/a','https://gchat.qpic.cn:8443/a']) assert.throws(() => qqImageUrl(url));
  let requests = 0;
  const h = await fixture(t, { fetchImpl: async () => { requests++; return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:3102/fish' } }); } });
  const refs = await h.store.capture('p-1', [{ url: 'https://gchat.qpic.cn/a', file: '' }], { messageId: '1' });
  const result = await h.store.prepare('p-1', [{ text: '[图片]', imageIds: refs }]);
  assert.equal(requests, 1); assert.equal(result.images.length, 0); assert.ok(result.warnings.length);
});
test('oversize bodies and SVG payloads are not passed to the model', async t => {
  let body = Buffer.alloc(2048);
  const h = await fixture(t, { maxImageBytes: 1024, fetchImpl: async () => new Response(body) });
  let refs = await h.store.capture('p-1', [{ url: 'https://gchat.qpic.cn/large', file: '' }], { messageId: '1' });
  assert.equal((await h.store.prepare('p-1', [{ imageIds: refs }])).images.length, 0);
  body = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>bad</script></svg>');
  refs = await h.store.capture('p-1', [{ url: 'https://gchat.qpic.cn/svg', file: '' }], { messageId: '2' });
  assert.equal((await h.store.prepare('p-1', [{ imageIds: refs }])).images.length, 0);
  assert.throws(() => imageMime(body));
});
test('get_image cannot make the bridge read a file outside configured QQ directories', async t => {
  const h = await fixture(t, { call: async () => ({ status: 'ok', data: { file: projectPath("qq-bridge/persona.md") } }) });
  const refs = await h.capture();
  const result = await h.store.prepare('p-1', [{ imageIds: refs }]);
  assert.equal(result.images.length, 0); assert.ok(result.warnings.length);
});
test('quoted images are resolved only after verifying the original QQ conversation', async t => {
  let original; const observations = [];
  const h = await fixture(t, { observe: async (scope, input) => { observations.push({ scope, ...input }); return { id: 'obs-quoted' }; },
    call: async action => action === 'get_msg'
      ? { status: 'ok', data: { message_type: 'group', group_id: 10, user_id: 2, message: [{ type: 'image', data: { file: 'id' } }] } }
      : { status: 'ok', data: { file: original } } });
  original = h.original;
  const wrong = await h.store.prepare('g-20', [{ quotedMessageId: '123', text: '这张图是什么' }]);
  assert.equal(wrong.images.length, 0); assert.equal(observations.length, 0);
  const good = await h.store.prepare('g-10', [{ quotedMessageId: '123', text: '这张图是什么' }]);
  assert.equal(good.images.length, 1); assert.equal(good.attachedImages[0].kind, 'quoted');
  assert.equal(good.attachedImages[0].observationId, 'obs-quoted'); assert.equal(observations[0].speakerId, '2');
});
test('a cancelled turn cannot publish image bytes as successful input', async t => {
  const controller = new AbortController();
  const h = await fixture(t, { fetchImpl: async () => { controller.abort(); throw controller.signal.reason; } });
  const refs = await h.store.capture('p-1', [{ url: 'https://gchat.qpic.cn/a', file: '' }], { messageId: '1' });
  await assert.rejects(h.store.prepare('p-1', [{ imageIds: refs }], { signal: controller.signal }), { name: 'AbortError' });
});
test('corrupt indices fail closed and cleanup touches only generated cache files', async t => {
  const h = await fixture(t); await h.capture();
  const keep = path.join(h.config.root, 'keep.txt'); await fs.writeFile(keep, 'keep');
  const expired = path.join(h.config.root, `image-${'a'.repeat(64)}.bin`); await fs.writeFile(expired, 'old'); await fs.utimes(expired, 0, 0);
  await h.capture('p-1', '1002');
  assert.equal(await fs.readFile(keep, 'utf8'), 'keep'); await assert.rejects(fs.stat(expired), { code: 'ENOENT' });
  const index = path.join(h.config.root, 'index.json'); await fs.writeFile(index, '{broken');
  const restarted = new QqImages(h.config);
  await assert.rejects(restarted.prepare('p-1', [{ text: '刚才图片' }]));
  assert.equal(await fs.readFile(index, 'utf8'), '{broken');
});
