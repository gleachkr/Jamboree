// Shared room model types. Media is grouped into Batches: one .torrent per
// drop/import, addressable by infoHash, with N audio files inside. A Track is
// a thin reference to (batchId, fileIndex) plus presentation metadata.

export type TrackId = string;
export type BatchId = string;
export type QueueEntryId = string;
export type IntentId = string;
export type ActivityId = string;
export type PeerId = string;

export type BatchFile = {
  // Path inside the torrent. For a single-file batch this is just the
  // filename; for a multi-file batch it's the per-file path WebTorrent
  // reports on file.path.
  path: string;
  name: string;
  size: number;
  mime?: string;
};

// A Batch holds the .torrent bytes for one drop. Receivers decode the bytes
// directly into WebTorrent.add — they don't wait on metadata exchange, and
// they don't have to download anything until a referenced track is selected.
export type Batch = {
  id: BatchId;
  infoHash: string;
  torrentFileBase64: string;
  files: BatchFile[];
  addedByPeerId: PeerId;
  addedAt: number;
};

export type TrackMeta = {
  id: TrackId;
  title: string;
  artist?: string;
  album?: string;
  durationMs?: number;
  mime?: string;
  sizeBytes?: number;
  // Reference into the batches map. fileIndex indexes batch.files.
  batchId: BatchId;
  fileIndex: number;
  addedByPeerId: PeerId;
  addedAt: number;
};

export type QueueEntry = {
  entryId: QueueEntryId;
  trackId: TrackId;
  addedByPeerId: PeerId;
  addedAt: number;
};

export type PlaybackIntentKind =
  | 'play'
  | 'pause'
  | 'seek'
  | 'select-entry'
  | 'skip-next'
  | 'skip-previous'
  | 'stop';

export type PlaybackIntent = {
  id: IntentId;
  peerId: PeerId;
  kind: PlaybackIntentKind;
  queueEntryId?: QueueEntryId;
  positionMs?: number;
  createdAtWallMs: number;
  localSeq: number;
};

export type PlaybackStatus = 'playing' | 'paused' | 'stopped';

// The anchored derived state. `positionMs` is the play head position at
// `effectiveAtWallMs`. Callers extrapolate to "now" themselves: when
// status === 'playing', currentPositionMs = positionMs + (now - effectiveAtWallMs).
export type DerivedPlaybackState = {
  status: PlaybackStatus;
  queueEntryId?: QueueEntryId;
  trackId?: TrackId;
  positionMs: number;
  effectiveAtWallMs: number;
  sourceIntentId?: IntentId;
};

export type ActivityKind =
  | 'track-added'
  | 'queue-added'
  | 'queue-removed'
  | 'queue-moved'
  | 'play'
  | 'pause'
  | 'seek'
  | 'select-entry'
  | 'skip-next'
  | 'skip-previous'
  | 'stop';

export type ActivityRecord = {
  id: ActivityId;
  peerId: PeerId;
  createdAtWallMs: number;
  kind: ActivityKind;
  trackId?: TrackId;
  entryId?: QueueEntryId;
  positionMs?: number;
};
