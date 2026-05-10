// MediaCache: thin wrapper around a single browser WebTorrent client. Owns
// torrent lifecycles, tracks progress per torrent, and hands out blob URLs
// for ready files. The room (Y.Doc) carries TrackMeta with magnetURI; this
// module turns those magnet URIs into playable bytes.
//
// Idempotent on infoHash: callers may safely re-invoke addMagnet for tracks
// they're already seeding or downloading. seedFile and addMagnet both
// resolve to the same TorrentInfo shape so the caller can write a TrackMeta
// without caring which flow produced it.

import WebTorrent from 'webtorrent';
import type { TrackId } from './types.ts';

export type TorrentInfo = {
  infoHash: string;
  magnetURI: string;
  fileIndex: number;
  fileName: string;
  sizeBytes: number;
  mime: string;
};

export type FileStatus =
  | { kind: 'unknown' }
  | { kind: 'pending'; numPeers: number }
  | {
      kind: 'downloading';
      progress: number;
      bytesDownloaded: number;
      bytesTotal: number;
      numPeers: number;
    }
  // 100%-downloaded but the Blob hasn't finished assembling from the chunk
  // store yet. Distinct from 'ready' so the UI can show "Buffering" rather
  // than a stalled 100%.
  | { kind: 'materializing'; bytesTotal: number; numPeers: number }
  | {
      kind: 'ready';
      blobUrl: string;
      bytesTotal: number;
      numPeers: number;
    };

type Entry = {
  torrent: WebTorrent.Torrent;
  blobUrls: Map<number, string>;
  // Pending getBlobURL() calls — coalesced so each file gets one outstanding
  // request even if multiple subscribers ask at once.
  blobUrlPending: Map<number, Promise<string>>;
};

// Throttle subscriber notifications: WebTorrent emits 'download' on every
// piece, which can fire hundreds of times per second on a fast peer. The UI
// only needs ~4Hz to feel responsive.
const NOTIFY_INTERVAL_MS = 250;

export class MediaCache {
  private readonly client: WebTorrent.Instance;
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  private readonly trackers: string[] | undefined;

  constructor(opts: { client?: WebTorrent.Instance; trackers?: string[] } = {}) {
    this.client = opts.client ?? new WebTorrent();
    this.trackers = opts.trackers && opts.trackers.length > 0 ? opts.trackers : undefined;
  }

  // Add a magnet idempotently. Resolves once the torrent has metadata so the
  // caller can build a TrackMeta. For background fetches (remote peer's
  // track) the caller can ignore the returned promise — the entry will keep
  // downloading and progress is observable via getStatus().
  addMagnet(magnetURI: string): Promise<TorrentInfo> {
    if (this.destroyed) return Promise.reject(new Error('MediaCache destroyed'));
    const existing = this.findByMagnet(magnetURI);
    if (existing) return this.toInfoOnReady(existing);
    // Override the magnet's embedded tracker list (some peers may have
    // generated it with WebTorrent's broken defaults). The peer-discovery
    // mechanism is the tracker URL set, so swapping it here makes us look
    // for peers on our trusted list — peers that are still on the bad
    // trackers won't see us, but a peer using this build will.
    const torrent = this.client.add(magnetURI, { announce: this.trackers });
    return this.register(torrent);
  }

  // Seed a local file. Resolves once WebTorrent has hashed the file and
  // produced a magnet URI.
  seedFile(file: File): Promise<TorrentInfo> {
    if (this.destroyed) return Promise.reject(new Error('MediaCache destroyed'));
    const torrent = this.client.seed(file, { announce: this.trackers });
    return this.register(torrent);
  }

  getStatus(infoHash: string, fileIndex: number): FileStatus {
    const entry = this.entries.get(infoHash);
    if (!entry) return { kind: 'unknown' };
    const torrent = entry.torrent;
    const numPeers = torrent.numPeers;
    if (!torrent.ready) return { kind: 'pending', numPeers };
    const file = torrent.files[fileIndex];
    if (!file) return { kind: 'pending', numPeers };
    const blobUrl = entry.blobUrls.get(fileIndex);
    if (blobUrl) {
      return { kind: 'ready', blobUrl, bytesTotal: file.length, numPeers };
    }
    if (file.progress >= 1) {
      if (!entry.blobUrlPending.has(fileIndex)) {
        void this.materializeBlobUrl(entry, fileIndex);
      }
      return { kind: 'materializing', bytesTotal: file.length, numPeers };
    }
    return {
      kind: 'downloading',
      progress: file.progress,
      bytesDownloaded: file.downloaded,
      bytesTotal: file.length,
      numPeers,
    };
  }

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
      for (const url of entry.blobUrls.values()) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore
        }
      }
    }
    this.entries.clear();
    this.listeners.clear();
    try {
      this.client.destroy();
    } catch {
      // ignore — destroy on a half-initialised client may throw
    }
  }

  // --- internals -----------------------------------------------------------

  private findByMagnet(magnetURI: string): WebTorrent.Torrent | undefined {
    // infoHash isn't directly exposed by parse-torrent here; cheaper to scan.
    // Both magnetURI strings produced by WebTorrent are stable per infoHash,
    // and we only ever add a given magnet via one path, so a string match
    // also catches the seed-then-remote-add case.
    for (const entry of this.entries.values()) {
      if (entry.torrent.magnetURI === magnetURI) return entry.torrent;
    }
    return undefined;
  }

  private register(torrent: WebTorrent.Torrent): Promise<TorrentInfo> {
    // Wire entry up immediately so getStatus has something to report even
    // before the 'ready' event fires.
    const entry: Entry = {
      torrent,
      blobUrls: new Map(),
      blobUrlPending: new Map(),
    };
    // infoHash is set synchronously for seed(); for add() it appears on the
    // 'infoHash' event. Store under a sentinel until known.
    if (torrent.infoHash) {
      this.entries.set(torrent.infoHash, entry);
    } else {
      torrent.once('infoHash', () => {
        this.entries.set(torrent.infoHash, entry);
        this.scheduleNotify();
      });
    }
    torrent.on('download', () => this.scheduleNotify());
    torrent.on('upload', () => this.scheduleNotify());
    torrent.on('wire', () => this.scheduleNotify());
    torrent.on('done', () => this.scheduleNotify());
    torrent.on('ready', () => this.scheduleNotify());
    torrent.on('error', () => this.scheduleNotify());
    torrent.on('warning', () => {
      // Tracker warnings are noisy and benign. Swallow.
    });
    return this.toInfoOnReady(torrent);
  }

  private toInfoOnReady(torrent: WebTorrent.Torrent): Promise<TorrentInfo> {
    return new Promise((resolve, reject) => {
      const onReady = () => {
        cleanup();
        const fileIndex = pickAudioFileIndex(torrent.files);
        const file = torrent.files[fileIndex];
        if (!file) {
          reject(new Error('torrent has no files'));
          return;
        }
        resolve({
          infoHash: torrent.infoHash,
          magnetURI: torrent.magnetURI,
          fileIndex,
          fileName: file.name,
          sizeBytes: file.length,
          mime: mimeFromFileName(file.name),
        });
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

  private async materializeBlobUrl(entry: Entry, fileIndex: number): Promise<void> {
    const file = entry.torrent.files[fileIndex];
    if (!file) return;
    // WebTorrent v2 dropped the v1 `getBlobURL(cb)` API in favour of an
    // async `file.blob()` returning a Blob. The shipped @types/webtorrent
    // package still describes the v1 callback API, so we cast through an
    // ad-hoc shape here. Switching to `client.createServer()` + streamURL
    // would let us play before full download, but for Stage 3 we keep it
    // simple and buffer the full Blob.
    const fileV2 = file as unknown as { blob(): Promise<Blob> };
    const pending = (async () => {
      const blob = await fileV2.blob();
      return URL.createObjectURL(blob);
    })();
    entry.blobUrlPending.set(fileIndex, pending);
    try {
      const url = await pending;
      entry.blobUrls.set(fileIndex, url);
      this.scheduleNotify();
    } catch (err) {
      // Surface in console — silent failures here cost us hours of confusion.
      console.error('[jamboree] materializeBlobUrl failed', err);
    } finally {
      entry.blobUrlPending.delete(fileIndex);
    }
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

// Picks the first audio file in the torrent if any look like audio,
// otherwise returns 0. Magnet-only torrents from outside Jamboree may
// include non-audio sidecars; we just default to the first thing.
function pickAudioFileIndex(files: readonly { name: string }[]): number {
  for (let i = 0; i < files.length; i++) {
    if (looksLikeAudio(files[i]!.name)) return i;
  }
  return 0;
}

function looksLikeAudio(name: string): boolean {
  return /\.(mp3|m4a|mp4|aac|flac|ogg|opus|wav|webm)$/i.test(name);
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

// Marker so callers can disambiguate logs originating from this module.
export const MEDIA_CACHE_TAG = Symbol.for('jamboree:media-cache');

// Re-exported so consumers don't have to import from types.ts just for this
// shape. Kept as a type alias rather than a brand for now.
export type { TrackId };
