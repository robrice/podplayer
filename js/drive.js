// Google Drive audio: sign in (OAuth implicit redirect), list folders with audio, fetch files.
import * as db from './db.js';
import { CONFIG } from './config.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const API = 'https://www.googleapis.com/drive/v3';

async function clientId() {
  return (await db.kv.get('googleClientId', '')) || CONFIG.googleClientId;
}

function redirectUri() {
  return location.origin + location.pathname;
}

export async function signIn() {
  const id = await clientId();
  if (!id) throw new Error('Add your Google client ID in Settings first.');
  const state = crypto.getRandomValues(new Uint32Array(2)).join('');
  await db.kv.set('oauthState', state);   // IndexedDB survives the trip out to Google and back
  const params = new URLSearchParams({
    client_id: id,
    redirect_uri: redirectUri(),
    response_type: 'token',
    scope: SCOPE,
    include_granted_scopes: 'true',
    state,
  });
  location.assign(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}

// Called at startup: pick the token out of the URL fragment after Google redirects back.
export async function handleRedirect() {
  if (!location.hash.includes('access_token=')) return false;
  const p = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', location.pathname + location.search);
  if (p.get('state') !== (await db.kv.get('oauthState'))) return false;
  await db.kv.set('oauthState', null);
  const expires = Date.now() + (Number(p.get('expires_in')) - 60) * 1000;
  await db.kv.set('driveToken', { token: p.get('access_token'), expires });
  return true;
}

export async function token() {
  const t = await db.kv.get('driveToken');
  return t && t.expires > Date.now() ? t.token : null;
}

export async function signOut() {
  await db.kv.set('driveToken', null);
}

async function api(path, params = {}) {
  const t = await token();
  if (!t) throw Object.assign(new Error('Sign in to Google Drive'), { needsSignIn: true });
  const res = await fetch(`${API}/${path}?${new URLSearchParams(params)}`, {
    headers: { Authorization: `Bearer ${t}` },
  });
  if (res.status === 401) {
    await signOut();
    throw Object.assign(new Error('Drive sign-in expired'), { needsSignIn: true });
  }
  if (!res.ok) throw new Error(`Drive error ${res.status}`);
  return res.json();
}

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const FOLDER = 'application/vnd.google-apps.folder';

// The "Music folders" setting: Drive folder links or IDs, one per line. Blank = whole Drive.
export async function folderSetting() {
  const v = await db.kv.get('musicFolders');
  return v === null ? CONFIG.musicFolders.join('\n') : v;
}

export function folderIds(text) {
  return String(text || '').split(/[\s,]+/).map(s => {
    const m = s.match(/folders\/([A-Za-z0-9_-]{10,})/) || s.match(/[?&]id=([A-Za-z0-9_-]{10,})/) || s.match(/^([A-Za-z0-9_-]{20,})$/);
    return m ? m[1] : null;
  }).filter(Boolean);
}

async function listAll(q, fields) {
  const out = [];
  let pageToken;
  do {
    const data = await api('files', { q, fields: `nextPageToken, files(${fields})`, pageSize: '1000', ...(pageToken ? { pageToken } : {}) });
    out.push(...data.files);
    pageToken = data.nextPageToken;
  } while (pageToken);
  return out;
}

// Audio inside the chosen folders and their subfolders (3 levels down).
async function filesInFolders(roots) {
  const files = [];
  const names = new Map();
  let level = roots;
  for (let depth = 0; depth < 4 && level.length; depth++) {
    const next = [];
    for (const id of level) {
      const kids = await listAll(`'${id}' in parents and trashed = false and (mimeType contains 'audio/' or mimeType = '${FOLDER}')`, 'id, name, mimeType, size, parents');
      for (const k of kids) {
        if (k.mimeType === FOLDER) { names.set(k.id, k.name); next.push(k.id); }
        else files.push(k);
      }
    }
    level = next;
  }
  return { files, names };
}

// Audio files grouped by folder: [{ id, name, files: [...] }]
export async function audioFolders() {
  const roots = folderIds(await folderSetting());
  let files;
  let names = new Map();
  if (roots.length) ({ files, names } = await filesInFolders(roots));
  else files = await listAll("mimeType contains 'audio/' and trashed = false", 'id, name, mimeType, size, parents');

  const groups = new Map();
  for (const f of files) {
    const parent = f.parents?.[0] || 'root';
    if (!groups.has(parent)) groups.set(parent, []);
    groups.get(parent).push({
      id: `drive-${f.id}`,
      driveId: f.id,
      title: f.name.replace(/\.[^.]+$/, '').replace(/_/g, ' '),
      name: f.name,
      type: f.mimeType,
      size: Number(f.size) || 0,
      source: 'drive',
    });
  }

  const folders = await Promise.all([...groups].map(async ([id, list]) => {
    let name = names.get(id) || 'My Drive';
    if (id !== 'root' && !names.has(id)) {
      try { name = (await api(`files/${id}`, { fields: 'name' })).name; } catch { name = 'Folder'; }
    }
    list.sort((a, b) => byName.compare(a.name, b.name));
    list.forEach(f => { f.folder = name; });
    return { id, name, files: list };
  }));
  folders.sort((a, b) => byName.compare(a.name, b.name));
  await db.kv.set('driveFolders', folders);   // so the list shows without signing in
  await db.kv.set('driveFoldersFor', await folderSetting());
  return folders;
}

// Last scan, unless the folder setting has changed since (then it needs a rescan).
export async function cachedFolders() {
  if ((await db.kv.get('driveFoldersFor', '')) !== (await folderSetting())) return [];
  return db.kv.get('driveFolders', []);
}

// Whole-file download (an <audio> tag can't send the sign-in header itself).
export async function fetchBlob(driveId) {
  const t = await token();
  if (!t) throw Object.assign(new Error('Sign in to Google Drive'), { needsSignIn: true });
  const res = await fetch(`${API}/files/${driveId}?alt=media`, { headers: { Authorization: `Bearer ${t}` } });
  if (!res.ok) throw new Error(`Drive download failed (${res.status})`);
  const blob = await res.blob();
  return new Blob([blob], { type: playableType(blob.type) });
}

// Drive reports .m4a as audio/x-m4a, which iPhone Safari may refuse for blob audio.
function playableType(type) {
  const t = (type || '').toLowerCase();
  if (/m4a|mp4|aac/.test(t)) return 'audio/mp4';
  if (/mpeg|mp3/.test(t)) return 'audio/mpeg';
  return t || 'audio/mpeg';
}
