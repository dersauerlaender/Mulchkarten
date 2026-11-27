// Kleine Promise-Hülle um IndexedDB.
const DB_NAME = 'mulchkarten';
const VERSION = 2;
let dbp;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('maps')) db.createObjectStore('maps', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
      if (!db.objectStoreNames.contains('features')) {
        const s = db.createObjectStore('features', { keyPath: 'id' });
        s.createIndex('mapId', 'mapId');
      }
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('times')) {
        const t = db.createObjectStore('times', { keyPath: 'id' });
        t.createIndex('mapId', 'mapId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
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

export const db = {
  get: async (s, key) => wrap((await store(s)).get(key)),
  getAll: async (s) => wrap((await store(s)).getAll()),
  put: async (s, val, key) => wrap((await store(s, 'readwrite')).put(val, key)),
  del: async (s, key) => wrap((await store(s, 'readwrite')).delete(key)),
  clear: async (s) => wrap((await store(s, 'readwrite')).clear()),
  keys: async (s) => wrap((await store(s)).getAllKeys()),
  byIndex: async (s, idx, val) => wrap((await store(s)).index(idx).getAll(val)),
  meta: {
    get: async (k, def) => (await wrap((await store('meta')).get(k))) ?? def,
    set: async (k, v) => wrap((await store('meta', 'readwrite')).put(v, k)),
  },
};
