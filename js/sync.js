// Keeps shows, played marks, positions, Up Next and settings the same on every device,
// through one private GitHub gist ("podplayer-sync.json"). Each device uses its own GitHub
// token (classic, "gist" scope only). Newest change wins, item by item.
import * as db from './db.js';
import * as pods from './podcasts.js';
import * as player from './player.js';
import { bus } from './events.js';

const API = 'https://api.github.com';
const FILE = 'podplayer-sync.json';
const DESCRIPTION = 'Podplayer sync (private, managed by the Podplayer app)';
const MAX_POSITIONS = 500;
const SETTINGS = ['googleClientId', 'proxy', 'musicFolders'];

const listeners = new Set();
export const onStatus = fn => listeners.add(fn);
let status = { state: 'off', at: 0, error: '' };
const setStatus = s => { status = { ...status, ...s }; listeners.forEach(fn => fn(status)); };
export const getStatus = () => status;

export const tokenUrl = 'https://github.com/settings/tokens/new?scopes=gist&description=Podplayer%20sync';

async function token() { return db.kv.get('syncToken', ''); }

async function gh(path, { method = 'GET', body, tok } = {}) {
  const api = (await db.kv.get('syncApi', '')) || API;   // override is only for local tests
  const res = await fetch(`${api}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${tok || await token()}`,
      Accept: 'application/vnd.github+json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  if (res.status === 401) throw new Error('GitHub key was rejected (expired or revoked?)');
  if (!res.ok) throw new Error(`GitHub error ${res.status}`);
  return res.status === 204 ? null : res.json();
}

// Find this account's sync gist, or create it.
async function gistId(tok) {
  const known = await db.kv.get('syncGist', '');
  if (known) return known;
  for (let page = 1; page <= 10; page++) {
    const list = await gh(`/gists?per_page=100&page=${page}`, { tok });
    const hit = list.find(g => g.files && g.files[FILE]);
    if (hit) { await db.kv.set('syncGist', hit.id); return hit.id; }
    if (list.length < 100) break;
  }
  const created = await gh('/gists', { method: 'POST', tok, body: { description: DESCRIPTION, public: false, files: { [FILE]: { content: JSON.stringify(empty()) } } } });
  await db.kv.set('syncGist', created.id);
  return created.id;
}

const empty = () => ({ v: 1, subs: {}, marks: {}, pos: {}, queue: null, settings: {} });

async function readRemote(id) {
  const g = await gh(`/gists/${id}`);
  const f = g.files[FILE];
  if (!f) return empty();
  let text = f.content;
  if (f.truncated) text = await (await fetch(f.raw_url, { cache: 'no-store' })).text();
  try { return { ...empty(), ...JSON.parse(text) }; } catch { return empty(); }
}

// What this device knows, in the sync format.
async function snapshot() {
  const snap = empty();
  for (const p of await db.getAll('podcasts')) {
    snap.subs[p.feedUrl] = { title: p.title, artwork: p.artwork, author: p.author, added: p.added, route: p.route, t: p.t || p.added || 0 };
  }
  for (const [url, t] of Object.entries(await db.kv.get('tombstones', {}))) {
    if (!snap.subs[url] || snap.subs[url].t < t) snap.subs[url] = { removed: true, t };
  }
  snap.marks = await db.kv.get('marks', {});
  const pos = (await db.kvEntries('pos:')).map(([k, v]) => [k.slice(4), v]).filter(([, v]) => v && v.at);
  pos.sort((a, b) => b[1].at - a[1].at);
  snap.pos = Object.fromEntries(pos.slice(0, MAX_POSITIONS));
  const queueAt = await db.kv.get('queueAt', 0);
  if (queueAt) snap.queue = { items: await db.kv.get('queue', []), current: await db.kv.get('current'), t: queueAt };
  for (const k of SETTINGS) {
    const v = await db.kv.get(k);
    const t = await db.kv.get(`${k}At`, 0);
    if (v !== null && t) snap.settings[k] = { v, t };
  }
  return snap;
}

const newer = (a, b, key = 't') => (!a ? b : !b ? a : (b[key] || 0) > (a[key] || 0) ? b : a);

export function merge(a, b) {
  const out = empty();
  for (const part of ['subs', 'marks', 'settings']) {
    for (const k of new Set([...Object.keys(a[part] || {}), ...Object.keys(b[part] || {})])) out[part][k] = newer(a[part]?.[k], b[part]?.[k]);
  }
  for (const k of new Set([...Object.keys(a.pos || {}), ...Object.keys(b.pos || {})])) out.pos[k] = newer(a.pos?.[k], b.pos?.[k], 'at');
  const pos = Object.entries(out.pos).sort((x, y) => y[1].at - x[1].at).slice(0, MAX_POSITIONS);
  out.pos = Object.fromEntries(pos);
  out.queue = newer(a.queue, b.queue);
  return out;
}

// Bring this device up to the merged state. Returns true if anything visible changed.
async function apply(local, merged) {
  let changed = false;
  const adds = [];
  for (const [url, s] of Object.entries(merged.subs)) {
    const mine = local.subs[url];
    if (mine && (mine.t || 0) >= s.t) continue;
    if (s.removed && mine && !mine.removed) {
      await pods.unsubscribe(url, { fromSync: true, t: s.t });
      changed = true;
    } else if (!s.removed && (!mine || mine.removed)) {
      adds.push(pods.subscribe(url, s, { fromSync: true }).then(() => { changed = true; })
        .catch(() => { /* feed unreachable from here right now; next sync retries */ }));
    } else if (!s.removed && mine) {
      const p = await db.get('podcasts', url);
      if (p) await db.put('podcasts', { ...p, t: s.t });
    }
  }
  await Promise.all(adds);
  for (const [id, m] of Object.entries(merged.marks)) {
    const mine = local.marks[id];
    if (!mine || m.t > mine.t) { await pods.setPlayed(id, m.p, { fromSync: true, t: m.t }); changed = true; }
  }
  let posChanged = false;
  for (const [id, p] of Object.entries(merged.pos)) {
    const mine = local.pos[id];
    if (!mine || p.at > mine.at) { await db.put('kv', p, `pos:${id}`); posChanged = true; }
  }
  for (const [k, s] of Object.entries(merged.settings)) {
    if (!local.settings[k] || s.t > local.settings[k].t) {
      await db.kv.set(k, s.v);
      await db.kv.set(`${k}At`, s.t);
      changed = true;
    }
  }
  if (merged.queue && (!local.queue || merged.queue.t > local.queue.t)) {
    await player.applyRemote({ queue: merged.queue.items, current: merged.queue.current, t: merged.queue.t });
    changed = true;
  } else if (posChanged) {
    await player.seekToSaved();
  }
  return changed || posChanged;
}

// Key order can differ between devices; compare canonically so we don't upload for nothing.
const canon = v => (Array.isArray(v) ? v.map(canon)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => [k, canon(v[k])]))
  : v);
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

let running = null;
let again = false;
let onApplied = () => {};
export const onRemoteChange = fn => { onApplied = fn; };

export async function syncNow() {
  if (!(await token())) { setStatus({ state: 'off' }); return; }
  if (running) { again = true; return running; }
  running = (async () => {
    setStatus({ state: 'syncing', error: '' });
    try {
      const id = await gistId();
      const [remote, local] = await Promise.all([readRemote(id), snapshot()]);
      const merged = merge(local, remote);
      const visible = await apply(local, merged);
      if (!same(merged, { ...empty(), ...remote })) {
        await gh(`/gists/${id}`, { method: 'PATCH', body: { files: { [FILE]: { content: JSON.stringify(merged) } } } });
      }
      setStatus({ state: 'ok', at: Date.now() });
      if (visible) onApplied();
    } catch (e) {
      setStatus({ state: 'error', error: e.message });
    } finally {
      running = null;
      if (again) { again = false; setTimeout(syncNow, 500); }
    }
  })();
  return running;
}

export async function connect(tok) {
  tok = tok.trim();
  const user = await gh('/user', { tok });   // proves the key works
  await db.kv.set('syncGist', '');
  await gistId(tok);
  await db.kv.set('syncToken', tok);
  await db.kv.set('syncUser', user.login);
  await syncNow();
  return user.login;
}

export async function disconnect() {
  await db.kv.set('syncToken', '');
  await db.kv.set('syncGist', '');
  setStatus({ state: 'off', error: '' });
}

// Settings saved on this device: stamp them so the newest wins everywhere.
export async function settingsChanged(keys) {
  for (const k of keys) if (SETTINGS.includes(k)) await db.kv.set(`${k}At`, Date.now());
}

// Sync shortly after local changes, when the app comes back to the screen, and every 2 minutes.
let timer = null;
bus.addEventListener('local-change', () => {
  clearTimeout(timer);
  timer = setTimeout(syncNow, 4000);
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') syncNow();
  else if (timer) { clearTimeout(timer); timer = null; syncNow(); }
});
setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, 120000);
