// Tiny IndexedDB wrapper. Everything the app remembers lives on the phone.
const DB_NAME = 'podplayer';
const DB_VERSION = 1;

let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('kv');                                   // settings, queue, positions
        db.createObjectStore('podcasts', { keyPath: 'feedUrl' });
        const ep = db.createObjectStore('episodes', { keyPath: 'id' });
        ep.createIndex('feedUrl', 'feedUrl');
        db.createObjectStore('blobs', { keyPath: 'id' });             // offline audio
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name, mode = 'readonly') {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export async function get(name, key) { return wrap((await store(name)).get(key)); }
export async function getAll(name) { return wrap((await store(name)).getAll()); }
export async function put(name, value, key) {
  const s = await store(name, 'readwrite');
  return wrap(key === undefined ? s.put(value) : s.put(value, key));
}
export async function del(name, key) { return wrap((await store(name, 'readwrite')).delete(key)); }
export async function byIndex(name, index, value) {
  return wrap((await store(name)).index(index).getAll(value));
}

export async function putMany(name, values) {
  const db = await open();
  const tx = db.transaction(name, 'readwrite');
  const s = tx.objectStore(name);
  values.forEach(v => s.put(v));
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function blobKeys() {
  return wrap((await store('blobs')).getAllKeys());
}

// All kv entries whose key starts with prefix -> [[key, value], ...]
export async function kvEntries(prefix) {
  const s = await store('kv');
  const range = IDBKeyRange.bound(prefix, `${prefix}￿`);
  return new Promise((resolve, reject) => {
    const out = [];
    const req = s.openCursor(range);
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve(out);
      out.push([cur.key, cur.value]);
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

// Settings and small state
export const kv = {
  get: (k, dflt = null) => get('kv', k).then(v => (v === undefined ? dflt : v)),
  set: (k, v) => put('kv', v, k),
};
