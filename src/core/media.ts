// MediaCache: media blob exchange over the existing Trystero peer mesh.
//
// Content is identified by a SHA-256 based batch manifest id generated
// during ingest. Receivers request whole-file chunks from any connected peer
// that has the blob; once a file is complete it is stored as a Blob URL and
// can be re-served to later peers.
//
// The protocol is deliberately small:
//   - `mr`: request one byte range for (batch id, file index)
//   - `mc`: respond with that range
//
// Peers broadcast requests. Any holder may answer; duplicates are ignored.
// Downloads are file-granular and sequential because the UI only needs the
// active track and one upcoming track. The protocol is deliberately less
// clever than a content swarm, and easier to reason about in our room mesh.

import type { BatchFile } from './types.ts';
import type { RemotePeerId, Transport } from './transport.ts';

export type SeededBatch = {
  contentId: string;
  files: BatchFile[];
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
  | {
      kind: 'ready';
      url: string;
      bytesTotal: number;
      numPeers: number;
    };

export type FileRef = { contentId: string; fileIndex: number };

type Entry = {
  contentId: string;
  files: BatchFile[];
  records: Map<number, FileRecord>;
};

type FileRecord = {
  meta: BatchFile;
  source?: Blob;
  objectUrl?: string;
  buffer?: Uint8Array;
  downloaded: number;
  download?: DownloadState;
};

type DownloadState = {
  requestId: string;
  nextOffset: number;
  timer: ReturnType<typeof setTimeout> | null;
};

type RequestMessage = {
  v: 1;
  id: string;
  c: string;
  i: number;
  o: number;
  l: number;
};

type ChunkHeader = {
  v: 1;
  id: string;
  c: string;
  i: number;
  o: number;
  t: number;
};

const CHUNK_SIZE = 64 * 1024;
const REQUEST_RETRY_MS = 1500;
const NOTIFY_INTERVAL_MS = 250;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class MediaCache {
  private readonly transport: Transport | null;
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private readonly unsubs: Array<() => void> = [];
  private readonly remotePeers = new Set<RemotePeerId>();
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  private active: FileRef | null = null;
  private upcoming: FileRef | null = null;

  constructor(opts: { transport?: Transport } = {}) {
    this.transport = opts.transport ?? null;
    if (this.transport) {
      this.unsubs.push(this.transport.onPeerJoin(this.handlePeerJoin));
      this.unsubs.push(this.transport.onPeerLeave(this.handlePeerLeave));
      this.unsubs.push(this.transport.receive('mr', this.handleRequest));
      this.unsubs.push(this.transport.receive('mc', this.handleChunk));
    }
  }

  // --- ingestion -----------------------------------------------------------

  async seedBatch(files: File[]): Promise<SeededBatch> {
    if (this.destroyed) throw new Error('MediaCache destroyed');
    if (files.length === 0) throw new Error('seedBatch: no files');

    mediaLog('seedBatch:start', { count: files.length });
    const startedAtMs = performance.now();
    const fileHashes = await Promise.all(files.map(hashBlobHex));
    const contentId = await hashContentId(files, fileHashes);
    const batchFiles: BatchFile[] = files.map((f, i) => ({
      path: f.name,
      name: f.name,
      size: f.size,
      mime: f.type || mimeFromFileName(f.name),
      sha256: fileHashes[i],
    }));

    const entry = this.ensureEntry(contentId, batchFiles);
    files.forEach((file, i) => {
      const rec = this.ensureRecord(entry, i);
      rec.source = file;
      rec.downloaded = file.size;
      if (!rec.objectUrl) rec.objectUrl = URL.createObjectURL(file);
      this.cancelDownload(rec);
    });
    mediaLog('seedBatch:ready', {
      hash: shortId(contentId),
      dt: dtSec(startedAtMs),
      files: files.length,
    });
    this.scheduleNotify();

    return {
      contentId,
      files: batchFiles,
    };
  }

  addBatchFromDoc(batch: {
    contentId: string;
    files?: readonly BatchFile[];
  }): Promise<void> {
    if (this.destroyed) return Promise.reject(new Error('MediaCache destroyed'));
    if (this.entries.has(batch.contentId)) return Promise.resolve();
    if (!batch.files) {
      return Promise.reject(new Error('addBatchFromDoc: missing file list'));
    }
    this.ensureEntry(batch.contentId, batch.files);
    this.reconcileDownloads();
    this.scheduleNotify();
    return Promise.resolve();
  }

  // --- active/upcoming -----------------------------------------------------

  setActive(target: FileRef | null): void {
    if (sameRef(this.active, target)) return;
    this.active = target;
    this.reconcileDownloads();
  }

  setUpcoming(target: FileRef | null): void {
    if (sameRef(this.upcoming, target)) return;
    this.upcoming = target;
    this.reconcileDownloads();
  }

  private reconcileDownloads(): void {
    const wanted = new Set<string>();
    if (this.active) wanted.add(refKey(this.active.contentId, this.active.fileIndex));
    if (this.upcoming) {
      wanted.add(refKey(this.upcoming.contentId, this.upcoming.fileIndex));
    }

    for (const entry of this.entries.values()) {
      for (const [fileIndex, rec] of entry.records) {
        const key = refKey(entry.contentId, fileIndex);
        if (wanted.has(key)) this.startOrResumeDownload(entry, fileIndex, rec);
        else this.cancelDownload(rec);
      }
    }
  }

  private startOrResumeDownload(
    entry: Entry,
    fileIndex: number,
    rec: FileRecord,
  ): void {
    if (rec.source) return;
    if (!this.transport) return;
    if (rec.downloaded >= rec.meta.size && rec.objectUrl) return;
    if (!rec.buffer) rec.buffer = new Uint8Array(rec.meta.size);
    if (rec.download) return;
    rec.download = {
      requestId: randomId('req'),
      nextOffset: rec.downloaded,
      timer: null,
    };
    this.requestNextChunk(entry, fileIndex, rec);
  }

  private cancelDownload(rec: FileRecord): void {
    if (!rec.download) return;
    if (rec.download.timer) clearTimeout(rec.download.timer);
    rec.download = undefined;
  }

  // --- status queries ------------------------------------------------------

  getStatus(contentId: string, fileIndex: number): FileStatus {
    const entry = this.entries.get(contentId);
    if (!entry) return { kind: 'unknown' };
    const rec = entry.records.get(fileIndex);
    const numPeers = this.remotePeers.size;
    if (!rec) return { kind: 'pending', numPeers };
    if (rec.objectUrl && rec.downloaded >= rec.meta.size) {
      return {
        kind: 'ready',
        url: rec.objectUrl,
        bytesTotal: rec.meta.size,
        numPeers,
      };
    }
    if (rec.downloaded > 0 || rec.download) {
      return {
        kind: 'downloading',
        progress: progressOf(rec),
        bytesDownloaded: rec.downloaded,
        bytesTotal: rec.meta.size,
        numPeers,
      };
    }
    return { kind: 'pending', numPeers };
  }

  // --- subscription / lifecycle -------------------------------------------

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
    for (const entry of this.entries.values()) {
      for (const rec of entry.records.values()) {
        this.cancelDownload(rec);
        if (rec.objectUrl) URL.revokeObjectURL(rec.objectUrl);
      }
    }
    this.entries.clear();
    this.listeners.clear();
  }

  // --- protocol handlers ---------------------------------------------------

  private handlePeerJoin = (peerId: RemotePeerId): void => {
    this.remotePeers.add(peerId);
    this.scheduleNotify();
  };

  private handlePeerLeave = (peerId: RemotePeerId): void => {
    this.remotePeers.delete(peerId);
    this.scheduleNotify();
  };

  private handleRequest = (peerId: RemotePeerId, payload: Uint8Array): void => {
    if (this.destroyed || !this.transport) return;
    let req: RequestMessage;
    try {
      req = JSON.parse(textDecoder.decode(payload)) as RequestMessage;
    } catch {
      return;
    }
    if (!validRequest(req)) return;
    const rec = this.entries.get(req.c)?.records.get(req.i);
    if (!rec?.source) return;
    const start = clamp(req.o, 0, rec.source.size);
    const end = clamp(req.o + req.l, start, rec.source.size);
    void rec.source.slice(start, end).arrayBuffer().then((buf) => {
      if (this.destroyed || !this.transport) return;
      const header: ChunkHeader = {
        v: 1,
        id: req.id,
        c: req.c,
        i: req.i,
        o: start,
        t: rec.source!.size,
      };
      this.transport.send('mc', encodeChunk(header, new Uint8Array(buf)), peerId);
    });
  };

  private handleChunk = (_peerId: RemotePeerId, payload: Uint8Array): void => {
    if (this.destroyed) return;
    let decoded: { header: ChunkHeader; bytes: Uint8Array };
    try {
      decoded = decodeChunk(payload);
    } catch {
      return;
    }
    const { header, bytes } = decoded;
    if (!validChunkHeader(header)) return;
    const entry = this.entries.get(header.c);
    const rec = entry?.records.get(header.i);
    if (!entry || !rec?.download) return;
    if (rec.download.requestId !== header.id) return;
    if (!rec.buffer || header.o !== rec.download.nextOffset) return;
    if (header.o + bytes.byteLength > rec.buffer.byteLength) return;

    if (rec.download.timer) clearTimeout(rec.download.timer);
    rec.download.timer = null;
    rec.buffer.set(bytes, header.o);
    rec.downloaded = Math.max(rec.downloaded, header.o + bytes.byteLength);
    this.scheduleNotify();

    if (rec.downloaded >= rec.meta.size) {
      void this.finishDownload(rec);
      return;
    }
    rec.download.nextOffset = rec.downloaded;
    this.requestNextChunk(entry, header.i, rec);
  };

  private requestNextChunk(entry: Entry, fileIndex: number, rec: FileRecord): void {
    if (!this.transport || !rec.download) return;
    const offset = rec.download.nextOffset;
    const length = Math.min(CHUNK_SIZE, Math.max(0, rec.meta.size - offset));
    if (length <= 0) {
      void this.finishDownload(rec);
      return;
    }
    const req: RequestMessage = {
      v: 1,
      id: rec.download.requestId,
      c: entry.contentId,
      i: fileIndex,
      o: offset,
      l: length,
    };
    this.transport.send('mr', textEncoder.encode(JSON.stringify(req)));
    rec.download.timer = setTimeout(() => {
      if (!rec.download) return;
      this.requestNextChunk(entry, fileIndex, rec);
    }, REQUEST_RETRY_MS);
  }

  private async finishDownload(rec: FileRecord): Promise<void> {
    if (!rec.buffer) return;
    this.cancelDownload(rec);
    const expectedHash = rec.meta.sha256;
    if (expectedHash) {
      const actualHash = await hashBytesHex(rec.buffer);
      if (actualHash !== expectedHash) {
        mediaLog('download:hash-mismatch', { expectedHash, actualHash });
        rec.buffer = undefined;
        rec.downloaded = 0;
        this.scheduleNotify();
        this.reconcileDownloads();
        return;
      }
    }
    const blob = new Blob([arrayBufferFromBytes(rec.buffer)], {
      type: rec.meta.mime || mimeFromFileName(rec.meta.name),
    });
    rec.source = blob;
    if (rec.objectUrl) URL.revokeObjectURL(rec.objectUrl);
    rec.objectUrl = URL.createObjectURL(blob);
    rec.downloaded = rec.meta.size;
    rec.buffer = undefined;
    mediaLog('download:ready', { name: rec.meta.name, bytes: rec.meta.size });
    this.scheduleNotify();
  }

  // --- entry helpers -------------------------------------------------------

  private ensureEntry(contentId: string, files: readonly BatchFile[]): Entry {
    const existing = this.entries.get(contentId);
    if (existing) return existing;
    const entry: Entry = {
      contentId,
      files: files.map((f) => ({ ...f })),
      records: new Map(),
    };
    entry.files.forEach((_, i) => this.ensureRecord(entry, i));
    this.entries.set(contentId, entry);
    return entry;
  }

  private ensureRecord(entry: Entry, fileIndex: number): FileRecord {
    const existing = entry.records.get(fileIndex);
    if (existing) return existing;
    const meta = entry.files[fileIndex];
    if (!meta) throw new Error(`unknown fileIndex ${fileIndex}`);
    const rec: FileRecord = { meta, downloaded: 0 };
    entry.records.set(fileIndex, rec);
    return rec;
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
  return a.contentId === b.contentId && a.fileIndex === b.fileIndex;
}

function refKey(contentId: string, fileIndex: number): string {
  return `${contentId}:${fileIndex}`;
}

function progressOf(rec: FileRecord): number {
  if (rec.meta.size <= 0) return 1;
  return Math.max(0, Math.min(1, rec.downloaded / rec.meta.size));
}

function validRequest(msg: RequestMessage): boolean {
  return (
    msg?.v === 1 &&
    typeof msg.id === 'string' &&
    typeof msg.c === 'string' &&
    Number.isInteger(msg.i) &&
    Number.isInteger(msg.o) &&
    Number.isInteger(msg.l) &&
    msg.i >= 0 &&
    msg.o >= 0 &&
    msg.l > 0
  );
}

function validChunkHeader(h: ChunkHeader): boolean {
  return (
    h?.v === 1 &&
    typeof h.id === 'string' &&
    typeof h.c === 'string' &&
    Number.isInteger(h.i) &&
    Number.isInteger(h.o) &&
    Number.isInteger(h.t) &&
    h.i >= 0 &&
    h.o >= 0 &&
    h.t >= 0
  );
}

function encodeChunk(header: ChunkHeader, bytes: Uint8Array): Uint8Array {
  const headerBytes = textEncoder.encode(JSON.stringify(header));
  const out = new Uint8Array(4 + headerBytes.byteLength + bytes.byteLength);
  new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(
    0,
    headerBytes.byteLength,
    false,
  );
  out.set(headerBytes, 4);
  out.set(bytes, 4 + headerBytes.byteLength);
  return out;
}

function decodeChunk(payload: Uint8Array): { header: ChunkHeader; bytes: Uint8Array } {
  if (payload.byteLength < 4) throw new Error('chunk too small');
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const headerLen = view.getUint32(0, false);
  if (payload.byteLength < 4 + headerLen) throw new Error('bad header length');
  const headerBytes = payload.subarray(4, 4 + headerLen);
  const header = JSON.parse(textDecoder.decode(headerBytes)) as ChunkHeader;
  return { header, bytes: payload.subarray(4 + headerLen) };
}

async function hashContentId(files: File[], fileHashes: string[]): Promise<string> {
  const manifest = files.map((f, i) => ({
    name: f.name,
    size: f.size,
    type: f.type || mimeFromFileName(f.name),
    sha256: fileHashes[i],
  }));
  const bytes = textEncoder.encode(JSON.stringify(manifest));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return bytesToHex(new Uint8Array(digest));
}

async function hashBlobHex(blob: Blob): Promise<string> {
  return hashBytesHex(new Uint8Array(await blob.arrayBuffer()));
}

async function hashBytesHex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', arrayBufferFromBytes(bytes));
  return bytesToHex(new Uint8Array(digest));
}

function arrayBufferFromBytes(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function randomId(prefix: string): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `${prefix}-${bytesToHex(bytes)}`;
}

export function uint8ToBase64(bytes: Uint8Array): string {
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

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function mediaLog(event: string, fields: Record<string, unknown>): void {
  console.log(`[jam/media] ${event}`, fields);
}

function shortId(contentId: string | undefined): string {
  return contentId ? contentId.slice(0, 8) : '????????';
}

function dtSec(startedAtMs: number): string {
  return ((performance.now() - startedAtMs) / 1000).toFixed(2);
}
