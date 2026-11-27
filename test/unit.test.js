import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanText } from '../text.js';
import { extractPcm } from '../wav.js';

test('Museの合図を外す', () => {
  assert.equal(cleanText('ーーということで例です'), 'ということで例です');
  assert.equal(cleanText('-- こんにちは'), 'こんにちは');
});
test('URL・絵文字・記号', () => {
  assert.equal(cleanText('見て https://example.com/a?b=1 です'), '見て URL です');
  assert.equal(cleanText('**大事** <:party:123456> だよ'), '大事 party だよ');
  assert.equal(cleanText('```js\nconst a=1\n```'), 'コード省略');
});
test('辞書は長い表記が優先', () => {
  assert.equal(cleanText('RSGT2027とRSGT', { RSGT: 'あ', RSGT2027: 'い' }), 'いとあ');
});
test('長文は切る／空は空', () => {
  assert.equal(cleanText('あ'.repeat(300), {}, 10), 'あ'.repeat(10) + '、以下省略');
  assert.equal(cleanText('   '), '');
});
test('WAVからPCMを取り出す（余分なチャンクがあっても）', () => {
  const pcm = Buffer.from([1, 2, 3, 4]);
  const chunk = (id, body) => { const h = Buffer.alloc(8); h.write(id, 'ascii'); h.writeUInt32LE(body.length, 4); return Buffer.concat([h, body, Buffer.alloc(body.length % 2)]); };
  const body = Buffer.concat([Buffer.from('WAVE'), chunk('fmt ', Buffer.alloc(16)), chunk('LIST', Buffer.from('abc')), chunk('data', pcm)]);
  const head = Buffer.alloc(8); head.write('RIFF', 'ascii'); head.writeUInt32LE(body.length, 4);
  assert.deepEqual(extractPcm(Buffer.concat([head, body])), pcm);
  assert.throws(() => extractPcm(Buffer.from('not a wav file')));
});

import { receptionText } from '../text.js';
import { chime, silence } from '../chime.js';

test('受付モードの文：Bot宛てメンションを外して名前を付ける', () => {
  assert.equal(receptionText('たなか', '@kawakuro いま1階に着きました', ['kawakuro']), 'たなかさんから。いま1階に着きました');
  assert.equal(receptionText('たなか', '@kawakuro', ['kawakuro']), 'たなかさんから呼び出しです');
  assert.equal(receptionText('たなか', '@かわくろ受付 @kawakuro 着きました', ['kawakuro', 'かわくろ受付']), 'たなかさんから。着きました');
});
test('チャイムと無音は 48kHz ステレオ s16le の長さになる', () => {
  assert.equal(silence(0.5).length, 24000 * 4);
  assert.equal(chime().length, Math.round(48000 * 1.3) * 4);
  assert.ok(chime().some((b) => b !== 0));
});

test('時刻つきの文を予約として見分ける', async () => {
  const { parseTimed } = await import('../text.js');
  assert.deepEqual(parseTimed('18:30 あと5分なのだ'), { hour: 18, minute: 30, body: 'あと5分なのだ' });
  assert.deepEqual(parseTimed('  １８：３０　あと5分'), { hour: 18, minute: 30, body: 'あと5分' });
  assert.deepEqual(parseTimed('18時30分に 集合なのだ'), { hour: 18, minute: 30, body: '集合なのだ' });
  assert.deepEqual(parseTimed('9時 朝会'), { hour: 9, minute: 0, body: '朝会' });
  assert.deepEqual(parseTimed('18時半 懇親会'), { hour: 18, minute: 30, body: '懇親会' });
  assert.equal(parseTimed('いま1階に着きました'), null);
  assert.equal(parseTimed('18:30'), null);
  assert.equal(parseTimed('25:00 だめ'), null);
  assert.equal(parseTimed('3時だからシナモンロール食べる'), null);
});
