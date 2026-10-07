// TeraBox 非公式API(terabox-api)の薄いラッパー。
// TeraBox側の仕様変更で動かなくなる可能性があります（自己責任）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const crc32 = require('crc-32');
const DIR = process.env.TERABOX_DIR || '/openchat';
const THUMB_DIR = DIR + '_thumbs'; // サムネイル置き場（<fs_id>.jpg）
const META_DIR = DIR + '_meta';     // 管理人アカウント等の設定置き場（meta.json）
const CHUNK = 4 * 1024 * 1024;
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;
const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';

let appPromise;
function app() {
  if (!appPromise) {
    appPromise = import('terabox-api').then(async ({ default: TeraBoxApp }) => {
      const a = new TeraBoxApp(process.env.TERABOX_NDUS);
      await a.updateAppData();
      return a;
    }).catch((e) => { appPromise = null; throw e; });
  }
  return appPromise;
}

let listCache = { at: 0, items: [] };
async function list(force = false) {
  if (!force && Date.now() - listCache.at < 30000) return listCache.items;
  const a = await app();
  const r = await a.getRemoteDir(DIR);
  if (r.errno !== 0) throw new Error('TeraBox list errno=' + r.errno + '（ログイン切れの可能性: ndusを更新してください）');
  const items = (r.list || [])
    .filter((f) => !Number(f.isdir) && VIDEO_EXT.test(f.server_filename))
    .map((f) => ({
      id: String(f.fs_id),
      title: f.server_filename.replace(VIDEO_EXT, ''),
      ext: f.server_filename.match(VIDEO_EXT)[0],
      path: f.path,
      size: Number(f.size),
      createdAt: new Date(Number(f.server_mtime) * 1000).toISOString(),
    }))
    .sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1));
  listCache = { at: Date.now(), items };
  return items;
}

const dlCache = new Map();
async function dlink(id, force = false, knownPath) {
  const hit = dlCache.get(id);
  if (!force && hit && hit.exp > Date.now()) return hit.url;
  const a = await app();
  let url;
  const d = await a.download([Number(id)]);
  const arr = d.dlink || d.data?.dlink;
  url = Array.isArray(arr) ? arr[0]?.dlink : typeof arr === 'string' ? arr : undefined;
  if (!url) { // 予備: filemetas
    const p = knownPath || (await list()).find((x) => x.id === id)?.path;
    if (p) {
      const m = await a.getFileMeta([p]);
      url = m.info?.[0]?.dlink;
    }
  }
  if (!url) throw new Error('再生用URLを取得できませんでした');
  dlCache.set(id, { url, exp: Date.now() + 10 * 60 * 1000 });
  return url;
}

async function rename(id, title) {
  const item = (await list(true)).find((x) => x.id === id);
  if (!item) return null;
  const clean = title.replace(/[\\/:*?"<>|]/g, '').trim();
  if (!clean) return item;
  const a = await app();
  const r = await a.filemanager('rename', [{ id: Number(id), path: item.path, newname: clean + item.ext }]);
  if (r.errno !== 0) throw new Error('名前の変更に失敗しました errno=' + r.errno);
  listCache.at = 0;
  return { ...item, title: clean };
}

async function remove(id) {
  const item = (await list(true)).find((x) => x.id === id);
  if (!item) return false;
  const a = await app();
  const r = await a.filemanager('delete', [item.path]);
  if (r.errno !== 0) throw new Error('削除に失敗しました errno=' + r.errno);
  listCache.at = 0; dlCache.delete(id);
  await removeThumb(id).catch(() => {});
  return true;
}


// --- アップロード（一時ファイル → ハッシュ計算 → 4MBずつTeraBoxへ） ---
async function hashLocal(file, size) {
  const fh = await fs.promises.open(file, 'r');
  const fileH = crypto.createHash('md5'), sliceH = crypto.createHash('md5');
  const chunks = []; let crc = 0, pos = 0;
  try {
    while (pos < size) {
      const len = Math.min(CHUNK, size - pos);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, pos);
      fileH.update(buf);
      crc = crc32.buf(buf, crc);
      if (pos === 0) sliceH.update(buf.subarray(0, Math.min(256 * 1024, len)));
      chunks.push(crypto.createHash('md5').update(buf).digest('hex'));
      pos += len;
    }
  } finally { await fh.close(); }
  return { file: fileH.digest('hex'), slice: sliceH.digest('hex'), crc32: crc >>> 0, chunks };
}

async function upload(localPath, filename, size, onProgress, dir = DIR) {
  const a = await app();
  await a.createDir(dir).catch(() => {}); // 既にあれば無視
  onProgress({ phase: 'hashing', done: 0, total: 0 });
  const hash = await hashLocal(localPath, size);
  const data = { remote_dir: dir, file: filename, size, hash, upload_id: '' };

  const pre = await a.precreateFile(data);
  if (pre.errno !== 0) throw new Error('準備に失敗しました errno=' + pre.errno);
  data.upload_id = pre.uploadid;
  if (pre.return_type === 2) { listCache.at = 0; return; } // TeraBox側に同一ファイルがあり即完了

  const host = await a.getUploadHost();
  if (host.errno) throw new Error('アップロード先の取得に失敗しました errno=' + host.errno);

  const fh = await fs.promises.open(localPath, 'r');
  try {
    for (let i = 0; i < hash.chunks.length; i++) {
      const len = Math.min(CHUNK, size - i * CHUNK);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, i * CHUNK);
      let lastErr;
      for (let t = 0; t < 4; t++) {
        try {
          const r = await a.uploadChunk(data, i, new Blob([buf]));
          if (r.md5 && r.md5 !== hash.chunks[i]) throw new Error('チャンクの照合に失敗しました');
          lastErr = null; break;
        } catch (e) { lastErr = e; await new Promise((ok) => setTimeout(ok, 1000 * (t + 1))); }
      }
      if (lastErr) throw new Error('TeraBoxへの送信に失敗しました（' + (lastErr.message || '') + '）');
      onProgress({ phase: 'sending', done: i + 1, total: hash.chunks.length });
    }
  } finally { await fh.close(); }

  const r = await a.createFile(data);
  if (r.errno !== 0) throw new Error('保存の確定に失敗しました errno=' + r.errno);
  listCache.at = 0;
}

// --- サムネイル ---
let thumbCache = { at: 0, map: new Map() };
async function thumbMap(force = false) {
  if (!force && Date.now() - thumbCache.at < 30000) return thumbCache.map;
  const a = await app();
  const r = await a.getRemoteDir(THUMB_DIR);
  const map = new Map();
  if (r.errno === 0) for (const f of r.list || []) {
    const m = /^(\d+)\.jpg$/.exec(f.server_filename);
    if (m) map.set(m[1], { id: String(f.fs_id), path: f.path });
  }
  thumbCache = { at: Date.now(), map };
  return map;
}
async function thumbFile(id) { return (await thumbMap()).get(id) || null; }
async function removeThumb(id) {
  const t = (await thumbMap(true)).get(id);
  if (!t) return;
  const a = await app();
  await a.filemanager('delete', [t.path]);
  thumbCache.at = 0; dlCache.delete(t.id);
}
async function setThumb(id, buf) {
  await removeThumb(id);
  const tmp = path.join(os.tmpdir(), crypto.randomUUID() + '.jpg');
  fs.writeFileSync(tmp, buf);
  try { await upload(tmp, `${id}.jpg`, buf.length, () => {}, THUMB_DIR); }
  finally { fs.rm(tmp, { force: true }, () => {}); }
  thumbCache.at = 0;
}

// --- 設定JSON(管理人アカウント等)をTeraBoxに保存 ---
// 書き込みは「新ファイルを上げる → 旧ファイルを消す → 名前を戻す」の順で、途中で失敗しても消えないようにしています。
async function metaList() {
  const a = await app();
  await a.createDir(META_DIR).catch(() => {});
  const r = await a.getRemoteDir(META_DIR);
  if (r.errno !== 0) throw new Error('設定フォルダを読めませんでした errno=' + r.errno);
  return r.list || [];
}
async function readJson(name) {
  const files = await metaList();
  const f = files.find((x) => x.server_filename === name) || files.find((x) => x.server_filename === name + '.new');
  if (!f) return null;
  const url = await dlink(String(f.fs_id), true, f.path);
  const res = await fetch(url, { headers: { 'User-Agent': UA, Cookie: 'ndus=' + process.env.TERABOX_NDUS } });
  if (!res.ok) throw new Error('設定ファイルの読み込みに失敗しました');
  return JSON.parse(await res.text());
}
async function writeJson(name, obj) {
  const a = await app();
  const body = Buffer.from(JSON.stringify(obj));
  const tmp = path.join(os.tmpdir(), crypto.randomUUID() + '.json');
  fs.writeFileSync(tmp, body);
  try {
    let files = await metaList();
    const stale = files.find((x) => x.server_filename === name + '.new');
    if (stale) await a.filemanager('delete', [stale.path]);
    await upload(tmp, name + '.new', body.length, () => {}, META_DIR);
    files = await metaList();
    const old = files.find((x) => x.server_filename === name);
    if (old) await a.filemanager('delete', [old.path]);
    const fresh = files.find((x) => x.server_filename === name + '.new');
    const r = await a.filemanager('rename', [{ id: Number(fresh.fs_id), path: fresh.path, newname: name }]);
    if (r.errno !== 0) throw new Error('設定の保存に失敗しました errno=' + r.errno);
  } finally { fs.rm(tmp, { force: true }, () => {}); }
}

module.exports = { list, dlink, rename, remove, upload, thumbMap, thumbFile, setThumb, removeThumb, readJson, writeJson, UA };
