// Offline audio, stored on the phone in IndexedDB.
import * as db from './db.js';
import { fetchBlob } from './drive.js';
import { candidates } from './net.js';

const listeners = new Set();
export const onChange = fn => listeners.add(fn);
const notify = () => listeners.forEach(fn => fn());

const inFlight = new Map();   // id -> progress 0..1

export const progress = id => inFlight.get(id);

export async function isSaved(id) {
  return Boolean(await db.get('blobs', id));
}

export async function save(track) {
  if (inFlight.has(track.id)) return;
  inFlight.set(track.id, 0);
  notify();
  try {
    let blob;
    if (track.source === 'drive') {
      blob = await fetchBlob(track.driveId);
    } else {
      // The feed proxy carries text only, so audio must come straight from the show's host.
      let res;
      for (const url of candidates(track.audioUrl)) {
        try {
          res = await fetch(url);
          if (res.ok) break;
        } catch { /* blocked: try the next address */ }
        res = null;
      }
      if (!res) throw new Error("this show doesn't allow downloads (it still streams)");
      blob = await readWithProgress(res, track);
    }
    await db.put('blobs', {
      id: track.id,
      blob,
      saved: Date.now(),
      size: blob.size,
      track: { ...track, notes: undefined },
    });
    if (navigator.storage?.persist) navigator.storage.persist();
  } finally {
    inFlight.delete(track.id);
    notify();
  }
}

async function readWithProgress(res, track) {
  const total = Number(res.headers.get('content-length')) || track.size || 0;
  if (!res.body || !total) return res.blob();
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    inFlight.set(track.id, Math.min(got / total, 1));
    notify();
  }
  return new Blob(chunks, { type: track.type || res.headers.get('content-type') || 'audio/mpeg' });
}

export async function remove(id) {
  await db.del('blobs', id);
  notify();
}

export async function list() {
  return (await db.getAll('blobs')).map(b => ({ ...b.track, size: b.size, saved: b.saved }));
}

export async function blobFor(id) {
  return (await db.get('blobs', id))?.blob || null;
}
