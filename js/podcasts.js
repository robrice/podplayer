// Podcast search (Apple's free directory), RSS parsing, and refreshing subscriptions.
import * as db from './db.js';
import { CONFIG } from './config.js';

const ITUNES_NS = 'http://www.itunes.com/dtds/podcast-1.0.dtd';
const CONTENT_NS = 'http://purl.org/rss/1.0/modules/content/';

export async function search(term) {
  const url = `https://itunes.apple.com/search?media=podcast&limit=25&term=${encodeURIComponent(term)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  const data = await res.json();
  return data.results
    .filter(r => r.feedUrl)
    .map(r => ({
      feedUrl: r.feedUrl,
      title: r.collectionName,
      author: r.artistName,
      artwork: r.artworkUrl600 || r.artworkUrl100,
    }));
}

async function proxyUrl() {
  return (await db.kv.get('proxy', CONFIG.proxy)) || '';
}

// Fetch from a server that may not allow browsers; falls back to the proxy if one is set.
export async function fetchCors(url, opts = {}) {
  try {
    const res = await fetch(url, opts);
    if (res.ok) return res;
    throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    const proxy = await proxyUrl();
    if (!proxy) throw err;
    const res = await fetch(`${proxy}?url=${encodeURIComponent(url)}`, opts);
    if (!res.ok) throw new Error(`HTTP ${res.status} via proxy`);
    return res;
  }
}

function text(el, tag, ns) {
  if (!el) return '';
  const found = ns ? el.getElementsByTagNameNS(ns, tag)[0] : el.getElementsByTagName(tag)[0];
  return found ? found.textContent.trim() : '';
}

function itunesImage(el) {
  const img = el.getElementsByTagNameNS(ITUNES_NS, 'image')[0];
  return img ? img.getAttribute('href') : '';
}

// "1:02:03", "62:03", or "3723" -> seconds
export function parseDuration(s) {
  if (!s) return 0;
  if (/^\d+$/.test(s)) return Number(s);
  return s.split(':').reduce((acc, part) => acc * 60 + (Number(part) || 0), 0);
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function parseFeed(xmlText, feedUrl) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Feed is not valid XML');
  const channel = doc.getElementsByTagName('channel')[0];
  if (!channel) throw new Error('Not a podcast feed');

  // Channel-level fields only: children of <channel>, not of <item>.
  const direct = tag => [...channel.children].find(c => c.localName === tag && c.namespaceURI !== ITUNES_NS);
  const chImageEl = [...channel.children].find(c => c.localName === 'image' && c.namespaceURI === ITUNES_NS);
  const rssImage = direct('image');
  const podcast = {
    feedUrl,
    title: direct('title')?.textContent.trim() || feedUrl,
    author: [...channel.children].find(c => c.localName === 'author' && c.namespaceURI === ITUNES_NS)?.textContent.trim() || '',
    artwork: chImageEl?.getAttribute('href') || (rssImage ? text(rssImage, 'url') : ''),
    description: direct('description')?.textContent.trim() || '',
  };

  const episodes = [...channel.getElementsByTagName('item')].map(item => {
    const enc = item.getElementsByTagName('enclosure')[0];
    const audioUrl = enc?.getAttribute('url') || '';
    const guid = text(item, 'guid') || audioUrl || text(item, 'title');
    const pub = Date.parse(text(item, 'pubDate'));
    return {
      id: `${hash(feedUrl)}-${hash(guid)}`,
      feedUrl,
      title: text(item, 'title') || 'Untitled episode',
      audioUrl,
      type: enc?.getAttribute('type') || 'audio/mpeg',
      size: Number(enc?.getAttribute('length')) || 0,
      duration: parseDuration(text(item, 'duration', ITUNES_NS)),
      pubDate: Number.isFinite(pub) ? pub : 0,
      notes: text(item, 'encoded', CONTENT_NS) || text(item, 'description') || text(item, 'summary', ITUNES_NS),
      artwork: itunesImage(item) || podcast.artwork,
    };
  }).filter(e => e.audioUrl);

  return { podcast, episodes };
}

export async function loadFeed(feedUrl) {
  const res = await fetchCors(feedUrl);
  return parseFeed(await res.text(), feedUrl);
}

// Save new episodes but keep what we already know (played flag) about old ones.
async function merge(podcast, episodes) {
  const known = new Map((await db.byIndex('episodes', 'feedUrl', podcast.feedUrl)).map(e => [e.id, e]));
  const merged = episodes.map(e => ({ ...e, played: known.get(e.id)?.played || false }));
  await db.putMany('episodes', merged);
  const existing = await db.get('podcasts', podcast.feedUrl);
  await db.put('podcasts', { ...existing, ...podcast, refreshed: Date.now() });
  return merged.filter(e => !known.has(e.id)).length;
}

export async function subscribe(feedUrl, hint = {}) {
  const { podcast, episodes } = await loadFeed(feedUrl);
  podcast.artwork = podcast.artwork || hint.artwork || '';
  podcast.added = Date.now();
  await merge(podcast, episodes);
  return podcast;
}

export async function unsubscribe(feedUrl) {
  const eps = await db.byIndex('episodes', 'feedUrl', feedUrl);
  for (const e of eps) {
    await db.del('episodes', e.id);
    await db.del('blobs', e.id);
  }
  await db.del('podcasts', feedUrl);
}

// Refresh every subscription; returns { added, failed: [titles] }
export async function refreshAll() {
  const subs = await db.getAll('podcasts');
  let added = 0;
  const failed = [];
  await Promise.all(subs.map(async sub => {
    try {
      const { podcast, episodes } = await loadFeed(sub.feedUrl);
      podcast.artwork = podcast.artwork || sub.artwork;
      added += await merge(podcast, episodes);
    } catch {
      failed.push(sub.title);
    }
  }));
  return { added, failed };
}

export function parseOpml(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  return [...doc.getElementsByTagName('outline')]
    .map(o => o.getAttribute('xmlUrl'))
    .filter(Boolean);
}

export function buildOpml(podcasts) {
  const esc = s => String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const lines = podcasts.map(p => `    <outline type="rss" text="${esc(p.title)}" xmlUrl="${esc(p.feedUrl)}"/>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head><title>Podplayer subscriptions</title></head>\n  <body>\n${lines.join('\n')}\n  </body>\n</opml>\n`;
}
