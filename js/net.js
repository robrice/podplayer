// Getting past servers that block web apps (CORS), without any setup on Rob's side.
import * as db from './db.js';
import { CONFIG } from './config.js';

// Podcast links often pass through measurement redirects that block browsers, with the real
// address embedded in the path (…/podtrac.com/redirect.mp3/pdst.fm/e/cdn.host.com/file.mp3).
// After the original link, try each embedded host, innermost first.
export function candidates(url) {
  const out = [url];
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/');
    const isHost = s => /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,12}$/i.test(s) && !/\.(mp3|m4a|aac|mp4|ogg|opus|wav|xml|rss)$/i.test(s);
    for (let i = parts.length - 1; i > 0; i--) {
      if (isHost(parts[i])) out.push(`https://${parts.slice(i).join('/')}${u.search}`);
    }
  } catch { /* not a URL */ }
  return out;
}

// Free public relay, last resort only: often slow or down.
const PUBLIC_RELAY = url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;

// Same key as feed_key() in tools/mirror.py
export async function feedKey(url) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 20);
}

let mirrorIndex = null;
let mirrorIndexAt = 0;
async function mirrored(url) {
  if (!mirrorIndex || Date.now() - mirrorIndexAt > 5 * 60000) {
    try {
      const res = await fetch(`mirror/index.json?t=${Date.now()}`);
      mirrorIndex = res.ok ? await res.json() : {};
    } catch {
      mirrorIndex = mirrorIndex || {};
    }
    mirrorIndexAt = Date.now();
  }
  return mirrorIndex[url] ? `mirror/${mirrorIndex[url].file}` : null;
}

// Link that opens a GitHub issue asking the Actions job to mirror a feed.
export function mirrorRequestUrl(feedUrl, title = '') {
  const params = new URLSearchParams({
    title: `mirror: ${feedUrl}`,
    body: `Podplayer couldn't load ${title || 'this show'} directly. Please mirror it.\n\n(Submit this issue; the mirror runs within a couple of minutes.)`,
  });
  return `https://github.com/${CONFIG.repo}/issues/new?${params}`;
}

async function routes(url) {
  const list = candidates(url).map(u => ({ via: u === url ? 'direct' : 'embedded', url: u }));
  const copy = await mirrored(url);
  if (copy) list.push({ via: 'mirror', url: copy });
  const own = (await db.kv.get('proxy', CONFIG.proxy)) || '';
  if (own) list.push({ via: 'proxy', url: `${own}?url=${encodeURIComponent(url)}` });
  list.push({ via: 'relay', url: PUBLIC_RELAY(url) });
  return list;
}

async function tryFetch(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    return text;
  } finally {
    clearTimeout(timer);
  }
}

const looksLikeFeed = text => /<(rss|feed|opml)[\s>]/i.test(text.slice(0, 5000));

// Fetch feed text. `hint` is the route that worked last time ({via, url}), tried first.
// Returns { text, route }.
export async function fetchFeedText(feedUrl, hint) {
  let list = await routes(feedUrl);
  if (hint) list = [hint, ...list.filter(r => r.url !== hint.url)];
  let lastErr;
  for (const route of list) {
    try {
      const text = await tryFetch(route.url, route.via === 'relay' ? 25000 : 20000);
      if (!looksLikeFeed(text)) throw new Error('not a podcast feed');
      return { text, route };
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(lastErr?.name === 'AbortError' ? 'timed out' : (lastErr?.message || 'could not load'));
}
