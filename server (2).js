const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Readable } = require('stream');
const tb = require('./tb');

const env = process.env;
const MEMBER_PASSCODE = env.MEMBER_PASSCODE || 'member';
const OWNER_PASSWORD = env.ADMIN_PASSWORD || 'admin'; // あなた(オーナー)用
const SECRET = env.SECRET || 'dev-secret';

// ---------- 認証 ----------
const mac = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
const same = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest());
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
function setSession(res, sess) {
  const p = Buffer.from(JSON.stringify(sess)).toString('base64url');
  res.setHeader('Set-Cookie', `auth=${p}.${mac(p)}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax; Secure`);
}
function readSession(req) {
  const m = /(?:^|; )auth=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const [p, sig] = m[1].split('.');
  if (!p || !sig || !same(mac(p), sig)) return null;
  try { return JSON.parse(Buffer.from(p, 'base64url').toString()); } catch { return null; }
}
const loginTries = new Map(); // ip -> {n, reset}
function limited(req) {
  const now = Date.now(), t = loginTries.get(req.ip);
  if (!t || t.reset < now) { loginTries.set(req.ip, { n: 1, reset: now + 10 * 60 * 1000 }); return false; }
  return ++t.n > 10;
}

// ---------- 設定(管理人アカウント・投稿者記録) ----------
let metaCache = null, metaQueue = Promise.resolve();
async function metaGet() {
  if (!metaCache) metaCache = (await tb.readJson('meta.json')) || { accounts: [], videos: {} };
  metaCache.accounts ||= []; metaCache.videos ||= {};
  return metaCache;
}
function metaMutate(fn) {
  const p = metaQueue.then(async () => {
    const copy = structuredClone(await metaGet());
    const result = await fn(copy);
    await tb.writeJson('meta.json', copy);
    metaCache = copy;
    return result;
  });
  metaQueue = p.catch(() => {});
  return p;
}

// ---------- ミドルウェア ----------
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch((e) => {
  console.error(e, e.cause || '');
  res.status(502).json({ error: e.message || 'TeraBoxとの通信に失敗しました' });
});
const attach = wrap(async (req, res, next) => {
  const s = readSession(req);
  req.user = null;
  if (s?.r === 'member' || s?.r === 'owner') req.user = { role: s.r, name: s.r === 'owner' ? 'オーナー' : '' };
  else if (s?.r === 'manager') {
    const a = (await metaGet()).accounts.find((x) => x.id === s.id && !x.disabled);
    if (a) req.user = { role: 'manager', name: a.username, id: a.id };
  }
  next();
});
const needMember = (req, res, next) => req.user ? next() : res.status(401).json({ error: 'ログインが必要です' });
const needPoster = (req, res, next) => ['owner', 'manager'].includes(req.user?.role) ? next() : res.status(403).json({ error: '投稿できるのは管理人だけです' });
const needOwner = (req, res, next) => req.user?.role === 'owner' ? next() : res.status(403).json({ error: 'オーナーのみ可能です' });
const byOf = (u) => (u.role === 'owner' ? '@owner' : u.name);

const app = express();
app.set('trust proxy', 1);
app.get('/healthz', (req, res) => res.send('ok')); // 眠り防止用
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', attach);
app.use('/video', attach);
app.use('/thumb', attach);

app.post('/api/login', wrap(async (req, res) => {
  if (limited(req)) return res.status(429).json({ error: '試行回数が多すぎます。10分ほど待ってからお試しください' });
  const { username, password = '' } = req.body || {};
  if (username) {
    const a = (await metaGet()).accounts.find((x) => x.username === username && !x.disabled);
    if (!a || !same(hashPw(password, a.salt), a.hash)) return res.status(401).json({ error: 'ユーザー名かパスワードが違います' });
    setSession(res, { r: 'manager', id: a.id });
    return res.json({ role: 'manager' });
  }
  const role = same(password, OWNER_PASSWORD) ? 'owner' : same(password, MEMBER_PASSCODE) ? 'member' : null;
  if (!role) return res.status(401).json({ error: 'パスワードが違います' });
  setSession(res, { r: role });
  res.json({ role });
}));
app.get('/api/me', (req, res) => res.json(req.user ? { role: req.user.role, name: req.user.name } : { role: null }));
app.post('/api/logout', (req, res) => { res.setHeader('Set-Cookie', 'auth=; Path=/; Max-Age=0'); res.json({ ok: true }); });

// ---------- 動画一覧・編集 ----------
const canEdit = (user, meta, id) => user.role === 'owner' || (user.role === 'manager' && meta.videos[id]?.by === user.name);

app.get('/api/videos', needMember, wrap(async (req, res) => {
  const [items, thumbs, meta] = await Promise.all([
    tb.list(req.query.refresh === '1'),
    tb.thumbMap().catch(() => new Map()),
    metaGet().catch(() => ({ accounts: [], videos: {} })),
  ]);
  res.json(items.map((v) => ({
    ...v, path: undefined,
    hasThumb: thumbs.has(v.id),
    canEdit: canEdit(req.user, meta, v.id),
    by: req.user.role === 'owner' ? meta.videos[v.id]?.by || null : undefined,
  })));
}));

async function guardEdit(req, res) {
  const meta = await metaGet();
  if (!canEdit(req.user, meta, req.params.id)) { res.status(403).json({ error: 'この動画は編集できません' }); return false; }
  return true;
}
app.patch('/api/videos/:id', needPoster, wrap(async (req, res) => {
  if (!(await guardEdit(req, res))) return;
  const v = await tb.rename(req.params.id, String(req.body.title || ''));
  v ? res.json({ ...v, path: undefined }) : res.status(404).json({ error: '見つかりません' });
}));
app.delete('/api/videos/:id', needPoster, wrap(async (req, res) => {
  if (!(await guardEdit(req, res))) return;
  if (!(await tb.remove(req.params.id))) return res.status(404).json({ error: '見つかりません' });
  await metaMutate((m) => { delete m.videos[req.params.id]; }).catch(console.error);
  res.json({ ok: true });
}));
app.put('/api/videos/:id/thumb', needPoster, express.raw({ type: '*/*', limit: '3mb' }), wrap(async (req, res) => {
  if (!(await guardEdit(req, res))) return;
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: '画像が空です' });
  await tb.setThumb(req.params.id, req.body);
  res.json({ ok: true });
}));

// ---------- アップロード: ブラウザ → (4MBずつ) Renderの一時ファイル → TeraBox ----------
const UP_DIR = path.join(os.tmpdir(), 'video-share-up');
fs.rmSync(UP_DIR, { recursive: true, force: true });
fs.mkdirSync(UP_DIR, { recursive: true });
const MAX_UPLOAD = (Number(env.MAX_UPLOAD_MB) || 1024) * 1024 * 1024;
const uploads = new Map();
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;

app.post('/api/uploads', needPoster, (req, res) => {
  const { filename = '', size = 0, title = '' } = req.body || {};
  const ext = (filename.match(VIDEO_EXT) || [])[0];
  if (!ext) return res.status(400).json({ error: '対応していない形式です（mp4 / mov / m4v / webm / mkv / avi）' });
  if (!(size > 0) || size > MAX_UPLOAD) return res.status(400).json({ error: `ファイルサイズは ${MAX_UPLOAD / 1048576} MB までです` });
  const base = (title || filename.replace(VIDEO_EXT, '')).replace(/[\\/:*?"<>|]/g, '').trim() || '無題';
  const id = crypto.randomUUID(), file = path.join(UP_DIR, id);
  fs.writeFileSync(file, '');
  uploads.set(id, { file, name: base + ext, size, received: 0, state: 'receiving', by: byOf(req.user), owner: req.user.role + (req.user.id || '') });
  res.json({ id, chunkSize: 4 * 1024 * 1024 });
});
const mine = (req, res) => {
  const u = uploads.get(req.params.id);
  if (!u || u.owner !== req.user.role + (req.user.id || '')) { res.status(404).json({ error: 'アップロードが見つかりません' }); return null; }
  return u;
};
app.put('/api/uploads/:id', needPoster, express.raw({ type: '*/*', limit: '6mb' }), wrap(async (req, res) => {
  const u = mine(req, res); if (!u) return;
  const offset = Number(req.query.offset);
  if (u.state !== 'receiving' || !Buffer.isBuffer(req.body) || !req.body.length || !(offset >= 0) || offset + req.body.length > u.size)
    return res.status(400).json({ error: '不正なデータです' });
  const fh = await fs.promises.open(u.file, 'r+');
  try { await fh.write(req.body, 0, req.body.length, offset); } finally { await fh.close(); }
  u.received = Math.max(u.received, offset + req.body.length);
  res.json({ received: u.received });
}));
app.put('/api/uploads/:id/thumb', needPoster, express.raw({ type: '*/*', limit: '3mb' }), (req, res) => {
  const u = mine(req, res); if (!u) return;
  if (u.state === 'receiving' && Buffer.isBuffer(req.body) && req.body.length) u.thumb = req.body;
  res.json({ ok: true });
});
app.post('/api/uploads/:id/finish', needPoster, (req, res) => {
  const u = mine(req, res); if (!u) return;
  if (u.state !== 'receiving') return res.status(400).json({ error: '処理済みです' });
  if (u.received !== u.size) return res.status(400).json({ error: '送信が完了していません。もう一度お試しください' });
  u.state = 'processing'; u.phase = 'hashing'; u.done = 0; u.total = 0;
  tb.upload(u.file, u.name, u.size, (p) => Object.assign(u, p))
    .then(async () => {
      u.phase = 'finalizing';
      const item = (await tb.list(true)).find((x) => x.title + x.ext === u.name);
      if (item) {
        await metaMutate((m) => { m.videos[item.id] = { by: u.by }; }).catch(console.error);
        if (u.thumb) await tb.setThumb(item.id, u.thumb).catch(console.error);
      }
      u.state = 'done';
    })
    .catch((e) => { console.error(e, e.cause || ''); u.state = 'error'; u.error = e.message; })
    .finally(() => { fs.rm(u.file, { force: true }, () => {}); u.thumb = null; setTimeout(() => uploads.delete(req.params.id), 10 * 60 * 1000); });
  res.status(202).json({ ok: true });
});
app.get('/api/uploads/:id', needPoster, (req, res) => {
  const u = mine(req, res); if (!u) return;
  const { state, phase, done, total, error } = u;
  res.json({ state, phase, done, total, error });
});

// ---------- 管理人アカウント(オーナーのみ) ----------
const pub = (a) => ({ id: a.id, username: a.username, disabled: !!a.disabled, createdAt: a.createdAt });
app.get('/api/accounts', needOwner, wrap(async (req, res) => res.json((await metaGet()).accounts.map(pub))));
app.post('/api/accounts', needOwner, wrap(async (req, res) => {
  const { username = '', password = '' } = req.body || {};
  if (!/^[A-Za-z0-9_.-]{3,20}$/.test(username)) return res.status(400).json({ error: 'ユーザー名は英数字と _ . - の3〜20文字にしてください' });
  if (password.length < 8) return res.status(400).json({ error: 'パスワードは8文字以上にしてください' });
  const acc = await metaMutate((m) => {
    if (m.accounts.some((x) => x.username === username)) return null;
    const salt = crypto.randomBytes(16).toString('hex');
    const a = { id: crypto.randomUUID(), username, salt, hash: hashPw(password, salt), disabled: false, createdAt: new Date().toISOString() };
    m.accounts.push(a);
    return a;
  });
  acc ? res.json(pub(acc)) : res.status(409).json({ error: 'そのユーザー名は使われています' });
}));
app.patch('/api/accounts/:id', needOwner, wrap(async (req, res) => {
  const { password, disabled } = req.body || {};
  if (password !== undefined && password.length < 8) return res.status(400).json({ error: 'パスワードは8文字以上にしてください' });
  const acc = await metaMutate((m) => {
    const a = m.accounts.find((x) => x.id === req.params.id);
    if (!a) return null;
    if (password !== undefined) { a.salt = crypto.randomBytes(16).toString('hex'); a.hash = hashPw(password, a.salt); }
    if (typeof disabled === 'boolean') a.disabled = disabled;
    return a;
  });
  acc ? res.json(pub(acc)) : res.status(404).json({ error: '見つかりません' });
}));
app.delete('/api/accounts/:id', needOwner, wrap(async (req, res) => {
  const ok = await metaMutate((m) => { const n = m.accounts.length; m.accounts = m.accounts.filter((x) => x.id !== req.params.id); return m.accounts.length < n; });
  ok ? res.json({ ok: true }) : res.status(404).json({ error: '見つかりません' });
}));

// ---------- 再生・サムネイル（TeraBoxをRenderが中継。Range対応） ----------
async function upstream(id, range, force, p) {
  const url = await tb.dlink(id, force, p);
  const ctrl = new AbortController();
  const r = await fetch(url, { headers: { 'User-Agent': tb.UA, Cookie: `ndus=${env.TERABOX_NDUS}`, ...(range ? { Range: range } : {}) }, signal: ctrl.signal });
  return { r, ctrl };
}
async function proxy(req, res, id, { type, cache, path: p }) {
  try {
    let { r, ctrl } = await upstream(id, req.headers.range, false, p);
    if (!r.ok && r.status !== 206) { ctrl.abort(); ({ r, ctrl } = await upstream(id, req.headers.range, true, p)); }
    if (!r.ok && r.status !== 206) return res.status(502).send('取得できませんでした');
    res.status(r.status);
    for (const h of ['content-length', 'content-range', 'accept-ranges']) if (r.headers.get(h)) res.setHeader(h, r.headers.get(h));
    const ct = r.headers.get('content-type') || '';
    res.setHeader('Content-Type', ct.startsWith(type.split('/')[0] + '/') ? ct : type);
    if (cache) res.setHeader('Cache-Control', cache);
    res.on('close', () => ctrl.abort());
    Readable.fromWeb(r.body).on('error', () => res.end()).pipe(res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(502).send('取得できませんでした');
  }
}
app.get('/video/:id', needMember, (req, res) => proxy(req, res, req.params.id, { type: 'video/mp4' }));
app.get('/thumb/:id', needMember, async (req, res) => {
  try {
    const t = await tb.thumbFile(req.params.id);
    if (!t) return res.sendStatus(404);
    proxy(req, res, t.id, { type: 'image/jpeg', cache: 'private, max-age=3600', path: t.path });
  } catch (e) { console.error(e); res.sendStatus(502); }
});

// ---------- 眠り防止: 10分ごとに自分自身へアクセス ----------
if (env.RENDER_EXTERNAL_URL) {
  setInterval(() => fetch(env.RENDER_EXTERNAL_URL + '/healthz').catch(() => {}), 10 * 60 * 1000);
}

app.listen(env.PORT || 3000, () => console.log('running'));
