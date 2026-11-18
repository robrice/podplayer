// The one <audio> element, queue, resume positions, speed, sleep timer, lock-screen controls.
import * as db from './db.js';
import * as downloads from './downloads.js';
import { fetchBlob } from './drive.js';

const audio = new Audio();
audio.preload = 'auto';

const state = {
  track: null,      // what's loaded
  queue: [],        // Up Next
  speed: 1,
  sleepAt: 0,       // epoch ms, or -1 = end of this track
  error: '',
  loading: false,
};

const listeners = new Set();
export const onChange = fn => listeners.add(fn);
const notify = () => listeners.forEach(fn => fn(state));

export const getState = () => state;
export const element = audio;

let objectUrl = null;
let lastSave = 0;

// iPhone Safari only lets an <audio> element start on its own after a tap has started it once.
// Play a moment of silence on the first tap so later plays (Drive fetches, next in queue) work.
let unlocked = false;
export function unlock() {
  if (unlocked || audio.src) return;
  unlocked = true;
  const rate = 8000, n = 800;   // 0.1 s of 8-bit mono silence
  const buf = new DataView(new ArrayBuffer(44 + n));
  const str = (o, s) => [...s].forEach((c, i) => buf.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); buf.setUint32(4, 36 + n, true); str(8, 'WAVEfmt ');
  buf.setUint32(16, 16, true); buf.setUint16(20, 1, true); buf.setUint16(22, 1, true);
  buf.setUint32(24, rate, true); buf.setUint32(28, rate, true); buf.setUint16(32, 1, true); buf.setUint16(34, 8, true);
  str(36, 'data'); buf.setUint32(40, n, true);
  for (let i = 0; i < n; i++) buf.setUint8(44 + i, 128);
  const silence = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  audio.src = silence;
  audio.play().then(() => { if (audio.src === silence) audio.pause(); }).catch(() => {});
}

let loadedId = null;   // track whose audio is actually in the element

async function savePosition(force = false) {
  if (!state.track || !Number.isFinite(audio.currentTime)) return;
  const now = Date.now();
  if (!force && now - lastSave < 5000) return;
  lastSave = now;
  await db.put('kv', { t: audio.currentTime, d: audio.duration || 0, at: now }, `pos:${state.track.id}`);
}

export async function position(id) {
  return db.kv.get(`pos:${id}`);
}

async function persistQueue() {
  await db.kv.set('queue', state.queue);
  await db.kv.set('current', state.track);
}

async function sourceFor(track) {
  const saved = await downloads.blobFor(track.id);
  if (saved) return URL.createObjectURL(saved);
  if (track.source === 'drive') return URL.createObjectURL(await fetchBlob(track.driveId));
  return track.audioUrl;
}

// Load a track and (optionally) start playing at its saved spot.
export async function load(track, { autoplay = true } = {}) {
  await savePosition(true);
  state.track = track;
  state.error = '';
  state.loading = true;
  notify();
  try {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    const src = await sourceFor(track);
    objectUrl = src.startsWith('blob:') ? src : null;
    audio.src = src;
    loadedId = track.id;
    audio.playbackRate = state.speed;
    const pos = await position(track.id);
    const resumeAt = pos && pos.d && pos.t < pos.d - 10 ? pos.t : 0;
    if (resumeAt) {
      audio.addEventListener('loadedmetadata', () => { audio.currentTime = resumeAt; }, { once: true });
    }
    setMediaSession(track);
    await persistQueue();
    if (autoplay) await audio.play();
  } catch (err) {
    state.error = err.needsSignIn ? 'Sign in to Google Drive to play this.' : (err.message || 'Could not play');
  } finally {
    state.loading = false;
    notify();
  }
}

export function play() { return audio.play().catch(e => { state.error = e.message; notify(); }); }
export function pause() { audio.pause(); }
export function toggle() {
  if (state.track && loadedId !== state.track.id) return load(state.track);   // restored Drive track not fetched yet
  return audio.paused ? play() : pause();
}
export function seekBy(sec) {
  audio.currentTime = Math.max(0, Math.min((audio.duration || Infinity), audio.currentTime + sec));
}
export function seekTo(sec) { audio.currentTime = sec; }

export async function setSpeed(s) {
  state.speed = s;
  audio.playbackRate = s;
  await db.kv.set('speed', s);
  notify();
}

let sleepTimer = null;
export function setSleep(minutes) {
  clearTimeout(sleepTimer);
  if (minutes === 0) state.sleepAt = 0;
  else if (minutes === -1) state.sleepAt = -1;
  else {
    state.sleepAt = Date.now() + minutes * 60000;
    sleepTimer = setTimeout(() => { pause(); state.sleepAt = 0; notify(); }, minutes * 60000);
  }
  notify();
}

// Queue
export async function enqueue(track, { next = false } = {}) {
  state.queue = state.queue.filter(t => t.id !== track.id);
  if (next) state.queue.unshift(track); else state.queue.push(track);
  await persistQueue();
  notify();
}
export async function dequeue(id) {
  state.queue = state.queue.filter(t => t.id !== id);
  await persistQueue();
  notify();
}
export async function replaceQueue(tracks) {
  state.queue = tracks;
  await persistQueue();
  notify();
}

export async function playNext() {
  const next = state.queue.shift();
  if (next) await load(next);
  else { await persistQueue(); notify(); }
}

async function finished() {
  const t = state.track;
  if (!t) return;
  await db.put('kv', { t: 0, d: audio.duration || 0, at: Date.now(), done: true }, `pos:${t.id}`);
  if (t.source !== 'drive') {
    const ep = await db.get('episodes', t.id);
    if (ep) await db.put('episodes', { ...ep, played: true });
    if (await db.kv.get('deleteAfterPlay', true)) await downloads.remove(t.id);
  }
  if (state.sleepAt === -1) { state.sleepAt = 0; notify(); return; }
  await playNext();
}

function setMediaSession(track) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: track.subtitle || track.folder || '',
    album: track.podcastTitle || track.folder || '',
    artwork: track.artwork ? [{ src: track.artwork, sizes: '512x512' }] : [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
  });
}

function updatePositionState() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration,
      playbackRate: audio.playbackRate,
      position: Math.min(audio.currentTime, audio.duration),
    });
  } catch { /* some browsers reject during load */ }
}

if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  const handlers = {
    play: () => play(),
    pause: () => pause(),
    seekbackward: d => seekBy(-(d.seekOffset || 15)),
    seekforward: d => seekBy(d.seekOffset || 30),
    seekto: d => seekTo(d.seekTime),
    nexttrack: () => playNext(),
  };
  for (const [action, fn] of Object.entries(handlers)) {
    try { ms.setActionHandler(action, fn); } catch { /* unsupported action */ }
  }
}

audio.addEventListener('timeupdate', () => { savePosition(); updatePositionState(); notify(); });
audio.addEventListener('pause', () => { savePosition(true); notify(); });
audio.addEventListener('play', notify);
audio.addEventListener('durationchange', notify);
audio.addEventListener('ended', finished);
audio.addEventListener('error', () => {
  if (!state.track) return;
  state.error = 'This audio could not be loaded.';
  notify();
});

// Restore the last session (paused) when the app opens.
export async function restore() {
  state.speed = await db.kv.get('speed', 1);
  state.queue = await db.kv.get('queue', []);
  const current = await db.kv.get('current');
  if (current) {
    // Drive tracks need a fresh sign-in token unless saved offline, so load them lazily.
    if (current.source === 'drive' && !(await downloads.isSaved(current.id))) {
      state.track = current;
    } else {
      await load(current, { autoplay: false });
    }
  }
  notify();
}

window.addEventListener('pagehide', () => savePosition(true));
document.addEventListener('visibilitychange', () => { if (document.hidden) savePosition(true); });
