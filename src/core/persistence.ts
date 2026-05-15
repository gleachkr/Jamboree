// Local IndexedDB-backed preferences store. Per DESIGN.md §10, durable
// client-side state (display name, recent room names, future per-user
// preferences) belongs in IDB rather than localStorage so PWA installs can
// carry it across reloads without bumping into quota or sync semantics.
//
// The API is Promise-based and tolerant of "no IDB" environments (Node tests,
// private mode): reads resolve to undefined, writes resolve silently. Callers
// should not assume IDB is available.

const DB_NAME = 'jamboree';
const DB_VERSION = 1;
const PREFS_STORE = 'prefs';

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === 'undefined') {
    dbPromise = Promise.resolve(null);
    return dbPromise;
  }
  dbPromise = new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PREFS_STORE)) {
        db.createObjectStore(PREFS_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

export async function getPref<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(PREFS_STORE, 'readonly');
      const req = tx.objectStore(PREFS_STORE).get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

export async function setPref<T>(key: string, value: T): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(PREFS_STORE, 'readwrite');
      tx.objectStore(PREFS_STORE).put(value as unknown, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

export type RecentRoom = {
  roomId: string;
  lastVisitedAt: number;
};

const RECENTS_KEY = 'recentRooms';
const MAX_RECENTS = 8;

// Note: only the room id (the public routing material) is stored. The room
// secret lives in the URL fragment and is never persisted here — design §10
// keeps recents as breadcrumbs, not re-joinable links.
export async function rememberRoom(roomId: string): Promise<void> {
  const existing = (await getPref<RecentRoom[]>(RECENTS_KEY)) ?? [];
  const dedup = existing.filter((r) => r.roomId !== roomId);
  dedup.unshift({ roomId, lastVisitedAt: Date.now() });
  await setPref(RECENTS_KEY, dedup.slice(0, MAX_RECENTS));
}

export async function getRecentRooms(): Promise<RecentRoom[]> {
  return (await getPref<RecentRoom[]>(RECENTS_KEY)) ?? [];
}
