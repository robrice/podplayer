// Podcast search (Apple's free directory), RSS parsing, and refreshing subscriptions.
import * as db from './db.js';
import { fetchFeedText } from './net.js';
import { touch } from './events.js';

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

export async function loadFeed(feedUrl, hint) {
  const { text, route } = await fetchFeedText(feedUrl, hint);
  const parsed = parseFeed(text, feedUrl);
  parsed.podcast.route = route;   // remember what worked for next refresh
  return parsed;
}

// Save new episodes but keep what we already know (played flag) about old ones.
// Played marks synced from another device ('marks') win over the local flag.
async function merge(podcast, episodes) {
  const known = new Map((await db.byIndex('episodes', 'feedUrl', podcast.feedUrl)).map(e => [e.id, e]));
  const marks = await db.kv.get('marks', {});
  const merged = episodes.map(e => ({ ...e, played: marks[e.id] ? marks[e.id].p : (known.get(e.id)?.played || false) }));
  await db.putMany('episodes', merged);
  const existing = await db.get('podcasts', podcast.feedUrl);
  await db.put('podcasts', { ...existing, ...podcast, refreshed: Date.now() });
  return merged.filter(e => !known.has(e.id)).length;
}

// `fromSync` = change came from another device: keep its timestamp, don't echo it back.
export async function subscribe(feedUrl, hint = {}, { fromSync = false } = {}) {
  const { podcast, episodes } = await loadFeed(feedUrl, hint.route);
  podcast.artwork = podcast.artwork || hint.artwork || '';
  podcast.added = hint.added || Date.now();
  podcast.t = fromSync ? hint.t : Date.now();
  await merge(podcast, episodes);
  const tomb = await db.kv.get('tombstones', {});
  if (tomb[feedUrl]) { delete tomb[feedUrl]; await db.kv.set('tombstones', tomb); }
  if (!fromSync) touch();
  return podcast;
}

export async function unsubscribe(feedUrl, { fromSync = false, t = Date.now() } = {}) {
  const eps = await db.byIndex('episodes', 'feedUrl', feedUrl);
  for (const e of eps) {
    await db.del('episodes', e.id);
    await db.del('blobs', e.id);
  }
  await db.del('podcasts', feedUrl);
  const tomb = await db.kv.get('tombstones', {});
  tomb[feedUrl] = t;
  await db.kv.set('tombstones', tomb);
  if (!fromSync) touch();
}

export async function setPlayed(id, played, { fromSync = false, t = Date.now() } = {}) {
  const ep = await db.get('episodes', id);
  if (ep && ep.played !== played) await db.put('episodes', { ...ep, played });
  const marks = await db.kv.get('marks', {});
  marks[id] = { p: played, t };
  await db.kv.set('marks', marks);
  if (!fromSync) touch();
}

// Refresh every subscription; returns { added, failed: [titles] }
export async function refreshAll() {
  const subs = await db.getAll('podcasts');
  let added = 0;
  const failed = [];
  await Promise.all(subs.map(async sub => {
    try {
      const { podcast, episodes } = await loadFeed(sub.feedUrl, sub.route);
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
