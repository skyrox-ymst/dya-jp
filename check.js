// 動作確認: TERABOX_NDUS=xxxx node check.js
const tb = require('./tb');
(async () => {
  const items = await tb.list(true);
  console.log('動画の数:', items.length);
  console.table(items.map(({ id, title, size }) => ({ id, title, size })));
  if (!items[0]) return console.log('フォルダに動画を入れてから再実行してください');
  const url = await tb.dlink(items[0].id, true);
  console.log('再生URL取得OK:', url.slice(0, 60) + '...');
  const r = await fetch(url, { headers: { 'User-Agent': tb.UA, Cookie: 'ndus=' + process.env.TERABOX_NDUS, Range: 'bytes=0-99' } });
  console.log('先頭100バイト取得:', r.status, r.headers.get('content-type'));
  // 速度テスト: 最大10MBを実際に取得して、再生開始までの時間と速度を測る
  const t0 = Date.now();
  const r2 = await fetch(url, { headers: { 'User-Agent': tb.UA, Cookie: 'ndus=' + process.env.TERABOX_NDUS, Range: 'bytes=0-10485759' } });
  const reader = r2.body.getReader();
  let got = 0, first = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; if (!first) first = Date.now() - t0; got += value.length; }
  const sec = (Date.now() - t0) / 1000;
  console.log(`最初のデータまで: ${first}ms / ${(got / 1048576).toFixed(1)}MBを${sec.toFixed(1)}秒 = ${(got / 1048576 / sec).toFixed(2)} MB/秒（≒${(got * 8 / 1e6 / sec).toFixed(1)} Mbps）`);
  console.log('動画のビットレートよりこの速度が大きければ、止まらず再生できます');
})().catch((e) => { console.error('失敗:', e.message, e.cause || ''); process.exit(1); });
