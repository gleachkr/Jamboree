// MediaCache: thin wrapper around a single browser WebTorrent client. Media
// is organised into Batches — one .torrent per drop/import, addressable by
// infoHash, with N audio files inside. The Yjs doc carries the .torrent bytes
// (base64), so receivers don't have to wait on metadata exchange and can
// surface the file list immediately.
//
// Receivers add each batch with `deselect: true`, which leaves the piece
// picker idle. Pieces are only requested for files we explicitly select. The
// MediaCache selects at most two files at any moment: the active track (the
// one playing) at HIGH priority, and one not-yet-ready upcoming track at LOW
// priority for warmup. Everything else is metadata-only.
//
// Two URL paths, decided per entry:
//   - Receivers use `file.streamURL`, served by WebTorrent's prebuilt SW
//     (registered in main.tsx and passed in via swRegistration). Range
//     requests resolve against the chunk store as pieces arrive.
//   - Seeders use a plain object URL on the source File. We already have
//     the bytes in memory, so we skip the SW round-trip entirely.

import WebTorrent from 'webtorrent';
import type { BatchFile } from './types.ts';

export type SeededBatch = {
  infoHash: string;
  torrentFileBase64: string;
  files: BatchFile[];
};

export type FileStatus =
  | { kind: 'unknown' }
  | { kind: 'pending'; numPeers: number }
  | {
      kind: 'streaming';
      url: string;
      progress: number;
      bytesDownloaded: number;
      bytesTotal: number;
      numPeers: number;
    }
  | {
      kind: 'ready';
      url: string;
      bytesTotal: number;
      numPeers: number;
    };

export type FileRef = { infoHash: string; fileIndex: number };

type Entry = {
  torrent: WebTorrent.Torrent;
  kind: 'add' | 'seed';
  startedAtMs: number;
  // For seeds: per-fileIndex object URL on the source File. Built eagerly so
  // playback can short-circuit straight to <audio src=...> without hitting
  // the SW or the chunk store.
  seedObjectUrls: Map<number, string>;
  // Selections currently applied to the torrent's piece picker, indexed by
  // fileIndex. The value is the priority that was passed to file.select().
  // Tracked so a re-select with a different priority can deselect cleanly,
  // rather than stacking duplicate selections inside WebTorrent.
  selections: Map<number, number>;
  lastProgressLogMs?: number;
  lastProgressBytes?: number;
};

// Throttle subscriber notifications. WebTorrent emits 'download' on every
// piece; the UI only needs ~4Hz to feel responsive.
const NOTIFY_INTERVAL_MS = 250;

// Per-file priorities. WebTorrent's piece picker treats higher numbers as
// higher priority; selections accumulate per torrent. We layer two
// selections at most: the currently-playing file (HIGH) and one upcoming
// file (LOW). Everything else is deselected.
const ACTIVE_PRIORITY = 5;
const UPCOMING_PRIORITY = 2;

// Diagnostic: how often to log download throughput while pieces are arriving.
const PROGRESS_LOG_INTERVAL_MS = 2000;

export class MediaCache {
  private readonly client: WebTorrent.Instance;
  private readonly trackers: string[] | undefined;
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  // Pending addBatchFromDoc promises, keyed by infoHash, so concurrent calls
  // for the same batch coalesce instead of racing into duplicate-add errors.
  private readonly pendingAdds = new Map<string, Promise<void>>();

  private active: FileRef | null = null;
  private upcoming: FileRef | null = null;

  constructor(opts: {
    client?: WebTorrent.Instance;
    trackers?: string[];
    swRegistration?: ServiceWorkerRegistration | null;
  } = {}) {
    this.client = opts.client ?? new WebTorrent();
    this.trackers = opts.trackers && opts.trackers.length > 0 ? opts.trackers : undefined;
    if (opts.swRegistration) {
      // Streaming server: routes file.streamURL fetches through the SW into
      // WebTorrent's chunk store. Without this, receivers have no way to
      // play a track. (Seeds still play via seedObjectUrls.)
      try {
        (this.client as unknown as {
          createServer(o: { controller: ServiceWorkerRegistration }): unknown;
        }).createServer({ controller: opts.swRegistration });
      } catch (err) {
        console.warn('[jamboree] WebTorrent createServer failed', err);
      }
    }
  }

  // --- ingestion -------------------------------------------------------------

  // Seed a batch of local files as one multi-file torrent (or a single-file
  // torrent if files.length === 1). Resolves once the torrent is ready and
  // its .torrent file has been built. The caller writes the SeededBatch into
  // the Yjs doc as a Batch entry.
  seedBatch(files: File[]): Promise<SeededBatch> {
    if (this.destroyed) return Promise.reject(new Error('MediaCache destroyed'));
    if (files.length === 0) {
      return Promise.reject(new Error('seedBatch: no files'));
    }
    mediaLog('seedBatch:start', { count: files.length });
    const startedAtMs = performance.now();
    return new Promise<SeededBatch>((resolve, reject) => {
      let settled = false;
      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        action();
      };
      try {
        // WebTorrent.seed accepts File[] but @types/webtorrent only types
        // single-File. Cast through unknown.
        type SeedFn = (
          input: File[],
          opts: { announce?: string[] },
          onseed: (t: WebTorrent.Torrent) => void,
        ) => WebTorrent.Torrent;
        const seedFn = this.client.seed as unknown as SeedFn;
        const torrent = seedFn.call(
          this.client,
          files,
          { announce: this.trackers },
          (seeded) => {
            // onseed fires both on first-time seed (seeded === torrent) and
            // on duplicate-content (seeded is the pre-existing torrent and
            // WebTorrent silently destroyed ours). Either way we register and
            // resolve from the surviving torrent.
            settle(() => {
              this.register(seeded, 'seed', files, startedAtMs)
                .then(resolve, reject);
            });
          },
        );
        torrent.on('error', (err: Error | string) => {
          const msg = err instanceof Error ? err.message : String(err);
          const dup = parseDuplicate(msg);
          if (dup && this.entries.has(dup)) {
            // Re-seeding the same content: resolve to the existing entry.
            settle(() => {
              this.toSeededBatch(this.entries.get(dup)!.torrent).then(resolve, reject);
            });
            return;
          }
          settle(() => reject(err instanceof Error ? err : new Error(msg)));
        });
      } catch (err) {
        settle(() => reject(err instanceof Error ? err : new Error(String(err))));
      }
    });
  }

  // Receive a batch by its .torrent bytes (from the Yjs doc). Adds with
  // deselect:true so no pieces are requested until the caller selects a
  // file via setActive / setUpcoming. Idempotent on infoHash; concurrent
  // calls for the same batch coalesce.
  addBatchFromDoc(batch: { infoHash: string; torrentFileBase64: string }): Promise<void> {
    if (this.destroyed) return Promise.reject(new Error('MediaCache destroyed'));
    if (this.entries.has(batch.infoHash)) return Promise.resolve();
    const existing = this.pendingAdds.get(batch.infoHash);
    if (existing) return existing;
    const p = this.doAddBatchFromDoc(batch).finally(() => {
      this.pendingAdds.delete(batch.infoHash);
    });
    this.pendingAdds.set(batch.infoHash, p);
    return p;
  }

  private async doAddBatchFromDoc(batch: {
    infoHash: string;
    torrentFileBase64: string;
  }): Promise<void> {
    mediaLog('addBatch:start', { hash: shortHash(batch.infoHash) });
    const startedAtMs = performance.now();
    let bytes: Uint8Array;
    try {
      bytes = base64ToUint8(batch.torrentFileBase64);
    } catch (err) {
      throw new Error(
        `addBatchFromDoc: invalid base64 (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    // Cast: @types/webtorrent doesn't expose the deselect/strategy options.
    type AddOpts = {
      announce?: string[];
      deselect?: boolean;
      strategy?: 'sequential' | 'rarest';
    };
    type AddFn = (torrentId: Uint8Array, opts: AddOpts) => WebTorrent.Torrent;
    const addFn = this.client.add as unknown as AddFn;
    let torrent: WebTorrent.Torrent;
    try {
      torrent = addFn.call(this.client, bytes, {
        announce: this.trackers,
        deselect: true,
        strategy: 'sequential',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const dup = parseDuplicate(msg);
      if (dup && this.entries.has(dup)) return;
      throw err instanceof Error ? err : new Error(msg);
    }
    await this.register(torrent, 'add', undefined, startedAtMs);
  }

  // --- active/upcoming -------------------------------------------------------

  // Mark the file currently being played (HIGH priority) and one upcoming
  // queue file (LOW priority warmup). Either may be null. Safe to call before
  // the relevant batches have been added — the selections will be applied as
  // soon as their torrent is registered.
  setActive(target: FileRef | null): void {
    if (sameRef(this.active, target)) return;
    this.active = target;
    this.reconcileSelections();
  }

  setUpcoming(target: FileRef | null): void {
    if (sameRef(this.upcoming, target)) return;
    this.upcoming = target;
    this.reconcileSelections();
  }

  // Walk every entry, compute the desired selection priority per fileIndex,
  // and call select/deselect to converge. Called whenever active or upcoming
  // changes, and on torrent registration so a new batch picks up the right
  // selections without the caller having to re-set them.
  private reconcileSelections(): void {
    const desired = this.desiredSelections();
    for (const [infoHash, entry] of this.entries) {
      if (entry.kind !== 'add') continue; // seeds have all bytes already
      const want = desired.get(infoHash) ?? new Map();
      this.applyEntrySelections(entry, want);
    }
  }

  private desiredSelections(): Map<string, Map<number, number>> {
    const out = new Map<string, Map<number, number>>();
    const put = (ref: FileRef, priority: number) => {
      let m = out.get(ref.infoHash);
      if (!m) {
        m = new Map();
        out.set(ref.infoHash, m);
      }
      // Active wins over upcoming when both point at the same file (active
      // is iterated first in apply()), but we still record only the higher
      // priority here so the diff at apply() time is correct.
      const cur = m.get(ref.fileIndex);
      if (cur === undefined || priority > cur) m.set(ref.fileIndex, priority);
    };
    if (this.active) put(this.active, ACTIVE_PRIORITY);
    if (this.upcoming) put(this.upcoming, UPCOMING_PRIORITY);
    return out;
  }

  private applyEntrySelections(entry: Entry, want: Map<number, number>): void {
    // Deselect files we no longer want, or whose priority changed.
    for (const [fileIndex, prevPriority] of entry.selections) {
      const nextPriority = want.get(fileIndex);
      if (nextPriority === prevPriority) continue;
      this.deselectFile(entry, fileIndex);
    }
    // Select (or re-select) files we now want.
    for (const [fileIndex, priority] of want) {
      if (entry.selections.get(fileIndex) === priority) continue;
      this.selectFile(entry, fileIndex, priority);
    }
  }

  private selectFile(entry: Entry, fileIndex: number, priority: number): void {
    const file = entry.torrent.files[fileIndex];
    if (!file) {
      // Metadata not yet — registerOnce will reconcile on the 'ready' event.
      return;
    }
    try {
      (file as unknown as { select(priority: number): void }).select(priority);
      entry.selections.set(fileIndex, priority);
      mediaLog('select', {
        hash: shortHash(entry.torrent.infoHash),
        fileIndex,
        priority,
      });
    } catch (err) {
      mediaLog('select-failed', {
        hash: shortHash(entry.torrent.infoHash),
        fileIndex,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private deselectFile(entry: Entry, fileIndex: number): void {
    const file = entry.torrent.files[fileIndex];
    if (!file) {
      entry.selections.delete(fileIndex);
      return;
    }
    try {
      (file as unknown as { deselect(): void }).deselect();
    } catch (err) {
      mediaLog('deselect-failed', {
        hash: shortHash(entry.torrent.infoHash),
        fileIndex,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    entry.selections.delete(fileIndex);
  }

  // --- status queries --------------------------------------------------------

  getStatus(infoHash: string, fileIndex: number): FileStatus {
    const entry = this.entries.get(infoHash);
    if (!entry) return { kind: 'unknown' };
    const torrent = entry.torrent;
    const numPeers = torrent.numPeers;
    // Seeder side: we have the bytes in memory.
    const seedUrl = entry.seedObjectUrls.get(fileIndex);
    if (seedUrl) {
      const bytesTotal = torrent.files[fileIndex]?.length ?? 0;
      return { kind: 'ready', url: seedUrl, bytesTotal, numPeers };
    }
    const file = torrent.files[fileIndex];
    // For add() with the .torrent bytes inline, files[] is populated
    // synchronously, so this is only ever falsy for malformed inputs.
    if (!file) return { kind: 'pending', numPeers };
    const streamUrl = (file as unknown as { streamURL?: string }).streamURL;
    // No streamURL means the SW server isn't up (createServer failed or
    // wasn't given a registration) — surface as pending so the UI doesn't
    // claim playability.
    if (!streamUrl) return { kind: 'pending', numPeers };
    if (file.progress >= 1) {
      return { kind: 'ready', url: streamUrl, bytesTotal: file.length, numPeers };
    }
    // We surface streaming even before any pieces arrive, as long as the file
    // is selected — at that point streamURL is well-defined and an <audio>
    // src will start fetching ranges via the SW.
    if (file.progress > 0 || entry.selections.has(fileIndex)) {
      return {
        kind: 'streaming',
        url: streamUrl,
        progress: file.progress,
        bytesDownloaded: file.downloaded,
        bytesTotal: file.length,
        numPeers,
      };
    }
    // Known torrent, file exists, but we haven't selected it — no pieces
    // will arrive. The UI should show "queued, not yet warmed".
    return { kind: 'pending', numPeers };
  }

  // --- subscription / lifecycle ---------------------------------------------

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
    }
    for (const entry of this.entries.values()) {
      for (const url of entry.seedObjectUrls.values()) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore
        }
      }
    }
    this.entries.clear();
    this.pendingAdds.clear();
    this.listeners.clear();
    try {
      this.client.destroy();
    } catch {
      // destroy on a half-initialised client may throw — non-fatal.
    }
  }

  // --- internals -------------------------------------------------------------

  // Register an entry for a freshly-created torrent (seed or add). Resolves
  // once metadata is in hand so seedBatch's caller has a SeededBatch to
  // write into the doc. For add() we already have metadata embedded in the
  // .torrent bytes, so this resolves nearly immediately.
  private register(
    torrent: WebTorrent.Torrent,
    kind: 'add' | 'seed',
    seedFiles: File[] | undefined,
    startedAtMs: number,
  ): Promise<SeededBatch> {
    const infoHash = torrent.infoHash;
    if (infoHash && this.entries.has(infoHash)) {
      // Duplicate path: WebTorrent handed us the existing torrent. Re-use the
      // existing entry's seed URLs (we may be re-seeding the same files).
      return this.toSeededBatch(this.entries.get(infoHash)!.torrent);
    }
    const seedObjectUrls = new Map<number, string>();
    if (seedFiles) {
      // Build object URLs eagerly. Order matches the seed input, which is
      // also the order WebTorrent assigns to torrent.files[]. (For multi-file
      // seeds, WebTorrent stable-sorts by path; using file.name as the path
      // means input order is preserved.)
      seedFiles.forEach((f, i) => {
        seedObjectUrls.set(i, URL.createObjectURL(f));
      });
    }
    const entry: Entry = {
      torrent,
      kind,
      startedAtMs,
      seedObjectUrls,
      selections: new Map(),
    };
    const log = (event: string, extra?: Record<string, unknown>) =>
      mediaLog(`${kind}:${event}`, {
        hash: shortHash(torrent.infoHash),
        dt: dtSec(startedAtMs),
        peers: torrent.numPeers,
        ...extra,
      });
    log('register');

    const finishRegistration = () => {
      if (this.entries.has(torrent.infoHash)) return;
      this.entries.set(torrent.infoHash, entry);
      // A previously-set active/upcoming may apply to this batch.
      this.reconcileSelections();
    };

    if (infoHash) finishRegistration();
    else torrent.once('infoHash', finishRegistration);

    torrent.on('download', () => {
      this.logProgress(entry);
      this.scheduleNotify();
    });
    torrent.on('upload', () => this.scheduleNotify());
    // @types/webtorrent's overload set excludes 'wire' — cast through unknown.
    (torrent.on as unknown as (
      event: 'wire',
      h: (wire: { remoteAddress?: string }) => void,
    ) => void).call(torrent, 'wire', (wire) => {
      log('wire', { addr: wire.remoteAddress });
      this.scheduleNotify();
    });
    torrent.on('done', () => {
      log('done');
      this.scheduleNotify();
    });
    torrent.on('ready', () => {
      log('ready', { files: torrent.files.map((f) => f.name) });
      // Selections may have been queued before files[] was populated; apply
      // them now.
      this.reconcileSelections();
      this.scheduleNotify();
    });
    torrent.on('noPeers', (announceType: string) =>
      log('noPeers', { announceType }),
    );
    torrent.on('error', (e: Error | string) => {
      log('error', { msg: e instanceof Error ? e.message : String(e) });
      this.scheduleNotify();
    });
    torrent.on('warning', (w: Error | string) => {
      const msg = w instanceof Error ? w.message : String(w);
      console.warn(
        `[jam/wt ${shortHash(torrent.infoHash)} +${dtSec(startedAtMs)}s] ${kind}:warning`,
        msg,
      );
    });
    return this.toSeededBatch(torrent);
  }

  private toSeededBatch(torrent: WebTorrent.Torrent): Promise<SeededBatch> {
    return new Promise((resolve, reject) => {
      const onReady = () => {
        cleanup();
        try {
          const tBytes = (torrent as unknown as { torrentFile: Uint8Array }).torrentFile;
          const files: BatchFile[] = torrent.files.map((f) => ({
            // f.path is the in-torrent path (matches single-file vs multi-file
            // layout). f.name is the display basename.
            path: (f as unknown as { path: string }).path ?? f.name,
            name: f.name,
            size: f.length,
            mime: mimeFromFileName(f.name),
          }));
          resolve({
            infoHash: torrent.infoHash,
            torrentFileBase64: uint8ToBase64(tBytes),
            files,
          });
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      };
      const onError = (err: Error | string) => {
        cleanup();
        reject(typeof err === 'string' ? new Error(err) : err);
      };
      const cleanup = () => {
        torrent.off('ready', onReady);
        torrent.off('error', onError);
      };
      if (torrent.ready) onReady();
      else {
        torrent.on('ready', onReady);
        torrent.on('error', onError);
      }
    });
  }

  // Throttled per-torrent throughput log. Records bytes-downloaded at each
  // tick and reports the delta since the last tick, so the speed number is
  // an observed average over the interval rather than WebTorrent's own
  // exponential-moving-average `downloadSpeed`.
  private logProgress(entry: Entry): void {
    const now = performance.now();
    const last = entry.lastProgressLogMs ?? entry.startedAtMs;
    if (now - last < PROGRESS_LOG_INTERVAL_MS) return;
    const torrent = entry.torrent;
    const bytes = torrent.downloaded;
    const lastBytes = entry.lastProgressBytes ?? 0;
    const elapsedSec = (now - last) / 1000;
    const bps = elapsedSec > 0 ? Math.round((bytes - lastBytes) / elapsedSec) : 0;
    entry.lastProgressLogMs = now;
    entry.lastProgressBytes = bytes;
    mediaLog(`${entry.kind}:progress`, {
      hash: shortHash(torrent.infoHash),
      dt: dtSec(entry.startedAtMs),
      progress: torrent.progress.toFixed(3),
      kbps: Math.round(bps / 1024),
      peers: torrent.numPeers,
      downloadedKB: Math.round(bytes / 1024),
    });
  }

  private scheduleNotify(): void {
    if (this.destroyed || this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      for (const l of this.listeners) {
        try {
          l();
        } catch {
          // a single bad listener shouldn't poison the rest
        }
      }
    }, NOTIFY_INTERVAL_MS);
  }
}

// --- helpers ---------------------------------------------------------------

function sameRef(a: FileRef | null, b: FileRef | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.infoHash === b.infoHash && a.fileIndex === b.fileIndex;
}

function parseDuplicate(msg: string): string | null {
  const m = /duplicate[^a-f0-9]*([a-f0-9]{40})/i.exec(msg);
  return m ? m[1]!.toLowerCase() : null;
}

export function uint8ToBase64(bytes: Uint8Array): string {
  // Chunked to avoid String.fromCharCode's argument-count limits on large
  // inputs (~64KB+).
  const chunk = 0x8000;
  let s = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

export function base64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function mimeFromFileName(name: string): string {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  switch (ext) {
    case 'mp3':
      return 'audio/mpeg';
    case 'm4a':
    case 'mp4':
    case 'aac':
      return 'audio/mp4';
    case 'flac':
      return 'audio/flac';
    case 'ogg':
    case 'opus':
      return 'audio/ogg';
    case 'wav':
      return 'audio/wav';
    case 'webm':
      return 'audio/webm';
    default:
      return 'application/octet-stream';
  }
}

// --- logging ---------------------------------------------------------------

function mediaLog(event: string, fields: Record<string, unknown>): void {
  console.log(`[jam/wt] ${event}`, fields);
}

function shortHash(infoHash: string | undefined): string {
  return infoHash ? infoHash.slice(0, 8) : '????????';
}

function dtSec(startedAtMs: number): string {
  return ((performance.now() - startedAtMs) / 1000).toFixed(2);
}
