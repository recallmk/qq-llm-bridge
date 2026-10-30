import test from 'node:test';
import assert from 'node:assert/strict';
import { mdToPlain, splitForQQ, splitForChat, splitSentences, truncateText } from './md-to-plain.mjs';

test('markdown emphasis, code and quotes are stripped but the words survive', () => {
  const md = [
    '# 标题',
    '',
    '**重点** 和 *斜体* 还有 ~~删除~~ 和 __下划线__',
    '',
    '> 引用一句话',
    '',
    '- 第一项',
    '- 第二项',
    '',
    '```js',
    'const a = 1;',
    '```',
    '',
    '行内 `code` 保留',
  ].join('\n');
  const plain = mdToPlain(md);
  assert.match(plain, /^标题$/m);
  assert.match(plain, /重点 和 斜体 还有 删除 和 下划线/);
  assert.match(plain, /^引用一句话$/m);
  assert.match(plain, /^• 第一项$/m);
  assert.match(plain, /^const a = 1;$/m);
  assert.match(plain, /行内 code 保留/);
  assert.ok(!plain.includes('**'));
  assert.ok(!plain.includes('```'));
});

test('links keep their text and the url in brackets, tables lose separator rows', () => {
  const plain = mdToPlain('看 [文档](https://example.com/a?b=1) 就行。\n\n| 项 | 值 |\n|---|---|\n| a | 1 |');
  assert.match(plain, /看 文档 \(https:\/\/example\.com\/a\?b=1\) 就行。/);
  assert.match(plain, /项 \| 值/);
  assert.ok(!plain.includes('---|'));
});

test('multiplication stars and leading list stars are not eaten as emphasis', () => {
  assert.equal(mdToPlain('2 * 3 * 4'), '2 * 3 * 4');
  assert.equal(mdToPlain('* 一条列表'), '• 一条列表');
  assert.equal(mdToPlain('a * b'), 'a * b');
});

test('splitting never cuts an emoji (surrogate pair) in half', () => {
  const text = '😀'.repeat(300);
  const parts = splitForQQ(text, 10);
  assert.equal(parts.join(''), text);
  for (const p of parts) assert.ok(!/^[\udc00-\udfff]/.test(p), 'part starts with a lone low surrogate');
});

test('splitForQQ keeps newlines and respects the limit for plain text', () => {
  const text = `${'一'.repeat(50)}\n${'二'.repeat(50)}\n${'三'.repeat(50)}`;
  const parts = splitForQQ(text, 120);
  assert.equal(parts.join(''), text);
  for (const p of parts) assert.ok(p.length <= 120);
});

test('sentence splitting keeps closing quotes with the sentence they end', () => {
  assert.deepEqual(splitSentences('他说：“走吧。”然后走了'), ['他说：“走吧。”', '然后走了']);
  assert.deepEqual(splitSentences('第一句。第二句！'), ['第一句。', '第二句！']);
});

test('short replies stay one message and empty replies produce nothing', () => {
  assert.deepEqual(splitForChat('在的，怎么了？'), ['在的，怎么了？']);
  assert.deepEqual(splitForChat('   '), []);
  assert.deepEqual(splitForChat(''), []);
});

test('long replies are packed by sentence without losing text', () => {
  const sentence = '这是一句用来测试分段的普通中文。';
  const text = sentence.repeat(40);
  const parts = splitForChat(text, { chunkChars: 200, maxChars: 600 });
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 600);
  assert.equal(parts.join(''), text);
  // 每一段都应该以句末标点收尾，而不是被拦腰截断
  for (const p of parts.slice(0, -1)) assert.match(p, /[。！？!?；;…]$/);
});

test('one runaway sentence is hard-split instead of being sent as one wall of text', () => {
  const text = '啊'.repeat(3000);
  const parts = splitForChat(text, { chunkChars: 200, maxChars: 600 });
  assert.ok(parts.length >= 5);
  for (const p of parts) assert.ok(p.length <= 600);
  assert.equal(parts.join(''), text);
});

test('paragraph breaks are preserved inside a message', () => {
  const text = '第一段。\n\n第二段。';
  assert.deepEqual(splitForChat(text), ['第一段。\n\n第二段。']);
});

test('truncateText counts code points and never leaves a lone surrogate', () => {
  assert.equal(truncateText('😀😀😀', 3).length, 2);
  assert.equal(truncateText('abc', 0), '');
  assert.equal(truncateText('abc', 10), 'abc');
});
