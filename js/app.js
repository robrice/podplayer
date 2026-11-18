// UI: tabs (Podcasts, Music, Downloads, Settings), show pages, mini player and full player.
import * as db from './db.js';
import * as pods from './podcasts.js';
import * as drive from './drive.js';
import * as downloads from './downloads.js';
import * as player from './player.js';
import { CONFIG } from './config.js';

const $ = sel => document.querySelector(sel);
const main = $('#main');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ICON = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
  back15: '<svg viewBox="0 0 24 24"><path d="M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"/><text x="12" y="16.5" font-size="6.5" text-anchor="middle">15</text></svg>',
  fwd30: '<svg viewBox="0 0 24 24"><path d="M12 5V1l5 5-5 5V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8z"/><text x="12" y="16.5" font-size="6.5" text-anchor="middle">30</text></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M12 3v11m0 0l-4-4m4 4l4-4M5 20h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  done: '<svg viewBox="0 0 24 24"><path d="M5 12l4 4 10-10" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  queue: '<svg viewBox="0 0 24 24"><path d="M4 6h12M4 12h12M4 18h8M18 15v6m-3-3h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V4h4v3m-7 0l1 13h8l1-13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
};

function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '0:00';
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
const fmtDur = sec => (sec ? (sec >= 3600 ? `${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min` : `${Math.round(sec / 60)} min`) : '');
const fmtDate = ms => (ms ? new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: new Date(ms).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }) : '');
const fmtMB = b => (b ? `${(b / 1e6).toFixed(b > 1e8 ? 0 : 1)} MB` : '');

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 3200);
}

// Show notes come from the internet: keep only simple formatting and http(s) links.
function sanitize(html) {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const allowed = new Set(['A', 'P', 'BR', 'UL', 'OL', 'LI', 'B', 'STRONG', 'I', 'EM']);
  const walk = node => {
    [...node.childNodes].forEach(child => {
      if (child.nodeType === 1) {
        walk(child);
        if (!allowed.has(child.tagName)) {
          child.replaceWith(...child.childNodes);
          return;
        }
        const href = child.getAttribute('href');
        [...child.attributes].forEach(a => child.removeAttribute(a.name));
        if (child.tagName === 'A' && href && /^https?:/i.test(href)) {
          child.setAttribute('href', href);
          child.setAttribute('target', '_blank');
          child.setAttribute('rel', 'noopener');
        }
      } else if (child.nodeType !== 3) {
        child.remove();
      }
    });
  };
  const root = doc.body.firstChild;
  walk(root);
  return root.innerHTML;
}

function trackFromEpisode(ep, podcast) {
  return {
    id: ep.id, source: 'podcast', title: ep.title, audioUrl: ep.audioUrl, type: ep.type,
    size: ep.size, duration: ep.duration, artwork: ep.artwork || podcast?.artwork || '',
    subtitle: podcast?.title || '', podcastTitle: podcast?.title || '', feedUrl: ep.feedUrl,
  };
}

// ---------- navigation ----------
let tab = 'podcasts';
const stack = [];   // pushed sub-pages within a tab

function setTab(name) {
  tab = name;
  stack.length = 0;
  document.querySelectorAll('nav.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  render();
}

function push(page) {
  stack.push(page);
  render();
  main.scrollTop = 0;
}

function pop() {
  stack.pop();
  render();
}

function header(title, { back = false, actions = '' } = {}) {
  return `<header class="bar">
    ${back ? '<button class="icon-btn back" data-act="back" aria-label="Back">‹</button>' : ''}
    <h1>${esc(title)}</h1>
    <div class="bar-actions">${actions}</div>
  </header>`;
}

async function render() {
  const page = stack[stack.length - 1];
  if (page) return page();
  if (tab === 'podcasts') return renderLibrary();
  if (tab === 'music') return renderMusic();
  if (tab === 'downloads') return renderDownloads();
  return renderSettings();
}

// ---------- Podcasts tab ----------
async function renderLibrary() {
  const subs = (await db.getAll('podcasts')).sort((a, b) => a.title.localeCompare(b.title));
  const all = await db.getAll('episodes');
  const byFeed = new Map(subs.map(s => [s.feedUrl, s]));
  const latest = all.filter(e => !e.played && byFeed.has(e.feedUrl))
    .sort((a, b) => b.pubDate - a.pubDate).slice(0, 15);

  main.innerHTML = `
    ${header('Podcasts', { actions: '<button class="text-btn" data-act="refresh">Refresh</button>' })}
    <form class="search" data-act="search">
      <input type="search" name="q" placeholder="Search for a podcast to add" autocomplete="off" enterkeyhint="search">
    </form>
    ${subs.length ? `
      <h2 class="section">Your shows</h2>
      <div class="grid">${subs.map(s => `
        <button class="tile" data-act="show" data-feed="${esc(s.feedUrl)}">
          <img src="${esc(s.artwork)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
          <span>${esc(s.title)}</span>
        </button>`).join('')}
      </div>
      <h2 class="section">New episodes</h2>
      <ul class="list">${(await Promise.all(latest.map(e => episodeRow(e, byFeed.get(e.feedUrl), true)))).join('') || '<li class="empty">You are all caught up.</li>'}</ul>
    ` : `
      <div class="empty-state">
        <p>Search above to add your first show.</p>
        <p class="hint">Moving from Spotify? Search each show by name, or import an OPML file in Settings.</p>
      </div>`}
  `;
}

async function episodeRow(ep, podcast, showPodcast = false) {
  const saved = await downloads.isSaved(ep.id);
  const pos = await player.position(ep.id);
  const prog = downloads.progress(ep.id);
  const left = pos && !pos.done && pos.t > 5 && ep.duration ? `${fmtDur(ep.duration - pos.t)} left` : fmtDur(ep.duration);
  return `<li class="row ${ep.played ? 'played' : ''}" data-id="${esc(ep.id)}">
    ${showPodcast ? `<img class="thumb" src="${esc(ep.artwork || podcast?.artwork)}" alt="" loading="lazy">` : ''}
    <button class="row-main" data-act="notes" data-id="${esc(ep.id)}">
      <span class="meta">${esc(showPodcast ? podcast?.title : fmtDate(ep.pubDate))}${showPodcast ? ` · ${fmtDate(ep.pubDate)}` : ''}</span>
      <span class="title">${esc(ep.title)}</span>
      <span class="meta">${esc(left)}${ep.played ? ' · Played' : ''}${saved ? ' · Downloaded' : ''}</span>
    </button>
    <div class="row-actions">
      <button class="icon-btn" data-act="dl" data-id="${esc(ep.id)}" aria-label="${saved ? 'Downloaded' : 'Download'}">
        ${prog !== undefined ? `<span class="pct">${Math.round(prog * 100)}%</span>` : saved ? ICON.done : ICON.down}
      </button>
      <button class="icon-btn play-btn" data-act="play-ep" data-id="${esc(ep.id)}" aria-label="Play">${ICON.play}</button>
    </div>
  </li>`;
}

function showSearch(q) {
  push(async () => {
    main.innerHTML = `${header(`“${q}”`, { back: true })}<p class="loading">Searching…</p>`;
    try {
      const results = await pods.search(q);
      const subs = new Set((await db.getAll('podcasts')).map(p => p.feedUrl));
      main.innerHTML = `${header(`“${q}”`, { back: true })}
        <ul class="list">${results.map(r => `
          <li class="row">
            <img class="thumb" src="${esc(r.artwork)}" alt="" loading="lazy">
            <div class="row-main"><span class="title">${esc(r.title)}</span><span class="meta">${esc(r.author)}</span></div>
            <div class="row-actions">${subs.has(r.feedUrl)
              ? '<span class="meta">Added</span>'
              : `<button class="pill" data-act="subscribe" data-feed="${esc(r.feedUrl)}" data-art="${esc(r.artwork)}">Add</button>`}</div>
          </li>`).join('') || '<li class="empty">No shows found.</li>'}</ul>`;
    } catch (e) {
      main.innerHTML = `${header('Search', { back: true })}<p class="error">${esc(e.message)}</p>`;
    }
  });
}

function showPodcast(feedUrl) {
  push(async () => {
    const p = await db.get('podcasts', feedUrl);
    if (!p) return pop();
    const eps = (await db.byIndex('episodes', 'feedUrl', feedUrl)).sort((a, b) => b.pubDate - a.pubDate);
    main.innerHTML = `${header(p.title, { back: true })}
      <div class="show-head">
        <img src="${esc(p.artwork)}" alt="">
        <div>
          <p class="meta">${esc(p.author)}</p>
          <p class="meta">${eps.length} episodes</p>
          <button class="pill subtle" data-act="unsubscribe" data-feed="${esc(feedUrl)}">Remove show</button>
        </div>
      </div>
      <ul class="list">${(await Promise.all(eps.map(e => episodeRow(e, p)))).join('')}</ul>`;
  });
}

async function showNotes(id) {
  const ep = await db.get('episodes', id);
  if (!ep) return;
  const p = await db.get('podcasts', ep.feedUrl);
  const sheet = $('#sheet');
  sheet.innerHTML = `<div class="sheet-card">
      <button class="grab" data-act="close-sheet" aria-label="Close"></button>
      <p class="meta">${esc(p?.title)} · ${fmtDate(ep.pubDate)} · ${fmtDur(ep.duration)}</p>
      <h2>${esc(ep.title)}</h2>
      <div class="sheet-actions">
        <button class="pill" data-act="play-ep" data-id="${esc(id)}">Play</button>
        <button class="pill subtle" data-act="queue-ep" data-id="${esc(id)}">Add to Up Next</button>
        <button class="pill subtle" data-act="toggle-played" data-id="${esc(id)}">${ep.played ? 'Mark unplayed' : 'Mark played'}</button>
      </div>
      <div class="notes">${sanitize(ep.notes || '')}</div>
    </div>`;
  sheet.classList.add('open');
}

function closeSheet() {
  $('#sheet').classList.remove('open');
}

// ---------- Music tab (Google Drive) ----------
async function renderMusic() {
  const signedIn = Boolean(await drive.token());
  const hasClient = Boolean(await db.kv.get('googleClientId', CONFIG.googleClientId));
  let folders = await drive.cachedFolders();
  main.innerHTML = `${header('Music', { actions: signedIn ? '<button class="text-btn" data-act="drive-scan">Rescan</button>' : '' })}
    ${!hasClient ? '<div class="empty-state"><p>To play music from Google Drive, add your Google client ID in Settings.</p></div>' : ''}
    ${hasClient && !signedIn ? `<div class="banner"><span>Sign in to stream from Google Drive. Downloaded tracks play without signing in.</span><button class="pill" data-act="drive-signin">Sign in</button></div>` : ''}
    <ul class="list">${folders.map(f => `
      <li class="row">
        <button class="row-main" data-act="folder" data-folder="${esc(f.id)}">
          <span class="title">${esc(f.name)}</span><span class="meta">${f.files.length} tracks</span>
        </button>
        <div class="row-actions"><button class="icon-btn play-btn" data-act="play-folder" data-folder="${esc(f.id)}" aria-label="Play folder">${ICON.play}</button></div>
      </li>`).join('') || (signedIn ? '<li class="empty"><button class="pill" data-act="drive-scan">Find audio in my Drive</button></li>' : '')}</ul>`;
  if (signedIn && !folders.length && !renderMusic.scanned) {
    renderMusic.scanned = true;
    scanDrive();
  }
}

async function scanDrive() {
  toast('Looking for audio in Drive…');
  try {
    await drive.audioFolders();
    if (tab === 'music') render();
  } catch (e) {
    toast(e.message);
  }
}

async function folderTracks(folderId) {
  return (await drive.cachedFolders()).find(f => f.id === folderId)?.files || [];
}

function showFolder(folderId) {
  push(async () => {
    const folder = (await drive.cachedFolders()).find(f => f.id === folderId);
    if (!folder) return pop();
    const rows = await Promise.all(folder.files.map(async t => {
      const saved = await downloads.isSaved(t.id);
      const prog = downloads.progress(t.id);
      const pos = await player.position(t.id);
      return `<li class="row" data-id="${esc(t.id)}">
        <button class="row-main" data-act="play-drive" data-folder="${esc(folderId)}" data-id="${esc(t.id)}">
          <span class="title">${esc(t.title)}</span>
          <span class="meta">${fmtMB(t.size)}${saved ? ' · Downloaded' : ''}${pos?.done ? ' · Played' : pos?.t > 5 ? ` · at ${fmtTime(pos.t)}` : ''}</span>
        </button>
        <div class="row-actions">
          <button class="icon-btn" data-act="dl-drive" data-folder="${esc(folderId)}" data-id="${esc(t.id)}" aria-label="Download">
            ${prog !== undefined ? `<span class="pct">${Math.round(prog * 100)}%</span>` : saved ? ICON.done : ICON.down}
          </button>
        </div>
      </li>`;
    }));
    main.innerHTML = `${header(folder.name, { back: true, actions: `<button class="text-btn" data-act="dl-folder" data-folder="${esc(folderId)}">Download all</button>` })}
      <ul class="list">${rows.join('')}</ul>`;
  });
}

// ---------- Downloads tab ----------
async function renderDownloads() {
  const items = (await downloads.list()).sort((a, b) => b.saved - a.saved);
  const total = items.reduce((n, i) => n + (i.size || 0), 0);
  let quota = '';
  if (navigator.storage?.estimate) {
    const est = await navigator.storage.estimate();
    if (est.quota) quota = ` of ${fmtMB(est.quota)} available`;
  }
  main.innerHTML = `${header('Downloads')}
    <p class="meta pad">${items.length} ${items.length === 1 ? 'item' : 'items'} ·${fmtMB(total) || '0 MB'}${quota}</p>
    <ul class="list">${items.map(t => `
      <li class="row">
        ${t.artwork ? `<img class="thumb" src="${esc(t.artwork)}" alt="" loading="lazy">` : ''}
        <button class="row-main" data-act="play-saved" data-id="${esc(t.id)}">
          <span class="meta">${esc(t.subtitle || t.folder || '')}</span>
          <span class="title">${esc(t.title)}</span>
          <span class="meta">${fmtMB(t.size)}</span>
        </button>
        <div class="row-actions"><button class="icon-btn" data-act="rm-saved" data-id="${esc(t.id)}" aria-label="Delete download">${ICON.trash}</button></div>
      </li>`).join('') || '<li class="empty">Tap the download arrow on an episode or song to keep it on this phone for listening without internet.</li>'}</ul>`;
}

// ---------- Settings tab ----------
async function renderSettings() {
  const clientId = await db.kv.get('googleClientId', CONFIG.googleClientId) || '';
  const proxy = await db.kv.get('proxy', CONFIG.proxy) || '';
  const delAfter = await db.kv.get('deleteAfterPlay', true);
  const signedIn = Boolean(await drive.token());
  main.innerHTML = `${header('Settings')}
    <form class="settings" data-act="save-settings">
      <label>Google client ID (for Drive music)
        <input name="googleClientId" value="${esc(clientId)}" placeholder="1234-abc.apps.googleusercontent.com" autocomplete="off" spellcheck="false">
      </label>
      <label>Feed proxy URL (optional)
        <input name="proxy" value="${esc(proxy)}" placeholder="https://script.google.com/macros/s/…/exec" autocomplete="off" spellcheck="false">
        <span class="hint">Only needed for shows that won't load, such as NPR's.</span>
      </label>
      <label class="check"><input type="checkbox" name="deleteAfterPlay" ${delAfter ? 'checked' : ''}> Delete downloaded episodes after they finish</label>
      <button class="pill" type="submit">Save</button>
    </form>
    <div class="settings">
      <p class="label">Google Drive</p>
      ${signedIn ? '<button class="pill subtle" data-act="drive-signout">Sign out of Drive</button>' : '<button class="pill subtle" data-act="drive-signin">Sign in to Drive</button>'}
      <p class="label">Subscriptions</p>
      <label class="pill subtle file-pill">Import OPML<input type="file" accept=".opml,.xml,text/xml" data-act="opml-import" hidden></label>
      <button class="pill subtle" data-act="opml-export">Export OPML</button>
    </div>
    <p class="hint pad">Everything is stored on this phone only. Add to Home Screen from Safari's Share menu to use it like an app.</p>`;
}

// ---------- player UI ----------
function renderMini(s) {
  const mini = $('#mini');
  if (!s.track) { mini.hidden = true; return; }
  mini.hidden = false;
  const a = player.element;
  const pct = a.duration ? (a.currentTime / a.duration) * 100 : 0;
  mini.querySelector('.mini-art').src = s.track.artwork || 'icons/icon-192.png';
  mini.querySelector('.mini-title').textContent = s.track.title;
  mini.querySelector('.mini-sub').textContent = s.error || (s.loading ? 'Loading…' : (s.track.subtitle || s.track.folder || ''));
  mini.querySelector('.mini-toggle').innerHTML = a.paused ? ICON.play : ICON.pause;
  mini.querySelector('.mini-progress').style.width = `${pct}%`;
  if ($('#full').classList.contains('open')) renderFull(s);
}

function renderFull(s) {
  const full = $('#full');
  const a = player.element;
  if (!s.track) return;
  const key = `${s.track.id}|${s.queue.map(q => q.id).join(',')}|${s.speed}|${s.sleepAt}`;
  if (full.dataset.key !== key) {
    full.dataset.key = key;
    const speeds = [0.8, 1, 1.2, 1.5, 1.75, 2];
    full.querySelector('.full-body').innerHTML = `
      <img class="full-art" src="${esc(s.track.artwork || 'icons/icon-512.png')}" alt="">
      <p class="meta">${esc(s.track.subtitle || s.track.folder || '')}</p>
      <h2>${esc(s.track.title)}</h2>
      <input class="scrub" type="range" min="0" max="1000" value="0" aria-label="Position">
      <div class="times"><span class="t-cur">0:00</span><span class="t-left">-0:00</span></div>
      <div class="controls">
        <button class="icon-btn big" data-act="seek" data-sec="-15" aria-label="Back 15 seconds">${ICON.back15}</button>
        <button class="icon-btn huge full-toggle" data-act="toggle" aria-label="Play or pause"></button>
        <button class="icon-btn big" data-act="seek" data-sec="30" aria-label="Forward 30 seconds">${ICON.fwd30}</button>
      </div>
      <div class="chips">
        <label>Speed <select data-act="speed">${speeds.map(v => `<option value="${v}" ${v === s.speed ? 'selected' : ''}>${v}×</option>`).join('')}</select></label>
        <label>Sleep <select data-act="sleep">
          <option value="0" ${!s.sleepAt ? 'selected' : ''}>Off</option>
          ${[5, 15, 30, 45, 60].map(m => `<option value="${m}">${m} min</option>`).join('')}
          <option value="-1" ${s.sleepAt === -1 ? 'selected' : ''}>End of episode</option>
        </select></label>
        ${s.queue.length ? '<button class="pill subtle" data-act="next">Next ›</button>' : ''}
      </div>
      <h3 class="section">Up Next</h3>
      <ul class="list">${s.queue.map(t => `
        <li class="row"><div class="row-main"><span class="meta">${esc(t.subtitle || t.folder || '')}</span><span class="title">${esc(t.title)}</span></div>
        <div class="row-actions"><button class="icon-btn" data-act="unqueue" data-id="${esc(t.id)}" aria-label="Remove">✕</button></div></li>`).join('') || '<li class="empty">Nothing queued. Use “Add to Up Next” on an episode.</li>'}</ul>`;
    if (s.sleepAt > 0) full.querySelector('[data-act="sleep"]').insertAdjacentHTML('afterbegin', `<option selected>${fmtTime((s.sleepAt - Date.now()) / 1000)} left</option>`);
  }
  full.querySelector('.full-toggle').innerHTML = a.paused ? ICON.play : ICON.pause;
  const scrub = full.querySelector('.scrub');
  if (!scrub.matches(':active') && a.duration) scrub.value = String(Math.round((a.currentTime / a.duration) * 1000));
  full.querySelector('.t-cur').textContent = fmtTime(a.currentTime);
  full.querySelector('.t-left').textContent = `-${fmtTime((a.duration || 0) - a.currentTime)}`;
}

// ---------- actions ----------
async function playEpisode(id) {
  const ep = await db.get('episodes', id);
  if (!ep) return;
  closeSheet();
  await player.load(trackFromEpisode(ep, await db.get('podcasts', ep.feedUrl)));
}

async function downloadTrack(track) {
  try {
    await downloads.save(track);
    toast('Downloaded');
  } catch (e) {
    toast(e.needsSignIn ? 'Sign in to Drive first' : `Download failed: ${e.message}`);
  }
}

main.addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.target;
  if (form.dataset.act === 'search') {
    const q = form.q.value.trim();
    if (q) showSearch(q);
  } else if (form.dataset.act === 'save-settings') {
    await db.kv.set('googleClientId', form.googleClientId.value.trim());
    await db.kv.set('proxy', form.proxy.value.trim().replace(/\/$/, ''));
    await db.kv.set('deleteAfterPlay', form.deleteAfterPlay.checked);
    toast('Saved');
  }
});

main.addEventListener('change', async e => {
  if (e.target.dataset.act !== 'opml-import') return;
  const file = e.target.files[0];
  if (!file) return;
  const urls = pods.parseOpml(await file.text());
  toast(`Importing ${urls.length} shows…`);
  let ok = 0;
  for (const u of urls) {
    try { await pods.subscribe(u); ok++; } catch { /* skip bad feeds */ }
  }
  toast(`Imported ${ok} of ${urls.length} shows`);
});

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]');
  if (el && /^(play|toggle)/.test(el.dataset.act)) player.unlock();
  if (!el || el.tagName === 'FORM' || el.tagName === 'SELECT' || el.tagName === 'INPUT') return;
  const { act, id, feed, folder } = el.dataset;
  switch (act) {
    case 'back': pop(); break;
    case 'tab': setTab(el.dataset.tab); break;
    case 'refresh': {
      el.disabled = true;
      toast('Checking for new episodes…');
      const r = await pods.refreshAll();
      toast(r.failed.length ? `${r.added} new · couldn't load ${r.failed.join(', ')}` : `${r.added} new episodes`);
      render();
      break;
    }
    case 'subscribe':
      el.disabled = true;
      el.textContent = 'Adding…';
      try {
        const p = await pods.subscribe(feed, { artwork: el.dataset.art });
        el.replaceWith(Object.assign(document.createElement('span'), { className: 'meta', textContent: 'Added' }));
        toast(`Added ${p.title}`);
      } catch (err) {
        el.disabled = false;
        el.textContent = 'Add';
        toast(`Couldn't load this show (${err.message}). A feed proxy in Settings may fix it.`);
      }
      break;
    case 'unsubscribe':
      if (confirm('Remove this show and its downloads?')) { await pods.unsubscribe(feed); pop(); }
      break;
    case 'show': showPodcast(feed); break;
    case 'notes': showNotes(id); break;
    case 'close-sheet': closeSheet(); break;
    case 'play-ep': playEpisode(id); break;
    case 'queue-ep': {
      const ep = await db.get('episodes', id);
      await player.enqueue(trackFromEpisode(ep, await db.get('podcasts', ep.feedUrl)));
      closeSheet();
      toast('Added to Up Next');
      break;
    }
    case 'toggle-played': {
      const ep = await db.get('episodes', id);
      await db.put('episodes', { ...ep, played: !ep.played });
      closeSheet();
      render();
      break;
    }
    case 'dl': {
      if (await downloads.isSaved(id)) {
        if (confirm('Delete this download?')) await downloads.remove(id);
        break;
      }
      const ep = await db.get('episodes', id);
      downloadTrack(trackFromEpisode(ep, await db.get('podcasts', ep.feedUrl)));
      break;
    }
    case 'drive-signin':
      try { await drive.signIn(); } catch (err) { toast(err.message); }
      break;
    case 'drive-signout': await drive.signOut(); render(); break;
    case 'drive-scan': scanDrive(); break;
    case 'folder': showFolder(folder); break;
    case 'play-folder':
    case 'play-drive': {
      const tracks = await folderTracks(folder);
      let start = act === 'play-drive' ? tracks.findIndex(t => t.id === id) : 0;
      if (act === 'play-folder') {
        // Resume an audiobook-style folder at the first unfinished track.
        for (let i = 0; i < tracks.length; i++) {
          const pos = await player.position(tracks[i].id);
          if (!pos?.done) { start = i; break; }
        }
      }
      await player.replaceQueue(tracks.slice(start + 1));
      await player.load(tracks[start]);
      break;
    }
    case 'dl-drive': {
      const t = (await folderTracks(folder)).find(x => x.id === id);
      if (await downloads.isSaved(id)) { if (confirm('Delete this download?')) await downloads.remove(id); }
      else downloadTrack(t);
      break;
    }
    case 'dl-folder': {
      for (const t of await folderTracks(folder)) {
        if (!(await downloads.isSaved(t.id))) await downloadTrack(t);
      }
      break;
    }
    case 'play-saved': {
      const item = (await downloads.list()).find(t => t.id === id);
      if (item) await player.load(item);
      break;
    }
    case 'rm-saved': await downloads.remove(id); break;
    case 'opml-export': {
      const blob = new Blob([pods.buildOpml(await db.getAll('podcasts'))], { type: 'text/xml' });
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'podcasts.opml' });
      a.click();
      break;
    }
    case 'open-full': $('#full').classList.add('open'); renderFull(player.getState()); break;
    case 'close-full': $('#full').classList.remove('open'); break;
    case 'toggle': player.toggle(); break;
    case 'seek': player.seekBy(Number(el.dataset.sec)); break;
    case 'next': player.playNext(); break;
    case 'unqueue': player.dequeue(id); break;
  }
});

$('#full').addEventListener('change', e => {
  const act = e.target.dataset.act;
  if (act === 'speed') player.setSpeed(Number(e.target.value));
  if (act === 'sleep') player.setSleep(Number(e.target.value));
});
$('#full').addEventListener('input', e => {
  if (!e.target.classList.contains('scrub')) return;
  const a = player.element;
  if (a.duration) player.seekTo((Number(e.target.value) / 1000) * a.duration);
});
$('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(); });

// Re-render list pages when downloads progress (throttled).
let pending = false;
downloads.onChange(() => {
  if (pending || (tab === 'settings' && !stack.length)) return;
  pending = true;
  setTimeout(() => { pending = false; render(); }, 400);
});
player.onChange(renderMini);

// ---------- startup ----------
async function start() {
  const fromGoogle = await drive.handleRedirect();
  await player.restore();
  if (fromGoogle) setTab('music'); else render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  // Quietly check for new episodes at most every 30 minutes.
  const last = await db.kv.get('lastRefresh', 0);
  if ((await db.getAll('podcasts')).length && Date.now() - last > 30 * 60000) {
    await db.kv.set('lastRefresh', Date.now());
    const r = await pods.refreshAll();
    if (r.added) { toast(`${r.added} new episodes`); if (tab === 'podcasts' && !stack.length) render(); }
  }
}

start();
