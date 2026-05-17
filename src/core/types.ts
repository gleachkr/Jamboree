// Shared room model types. Media is grouped into Batches: one drop/import,
// addressable by content id, with N audio files inside. A Track is a thin
// reference to (batchId, fileIndex) plus presentation metadata.

export type TrackId = string;
export type BatchId = string;
export type QueueEntryId = string;
export type IntentId = string;
export type ActivityId = string;
export type PeerId = string;

export type BatchFile = {
  // Path inside the dropped/imported batch. For local files this is usually
  // just the filename; future directory import can preserve nested paths.
  path: string;
  name: string;
  size: number;
  mime?: string;
  // Optional SHA-256 of this file's bytes. The mesh media protocol uses this
  // to reject corrupt chunk responses before creating a playable Blob URL.
  sha256?: string;
};

// A Batch holds metadata for one drop/import. `contentId` is a stable
// SHA-256 based identifier for the batch manifest, used by the mesh media
// protocol to request files from peers.
export type Batch = {
  id: BatchId;
  contentId: string;
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
  // Primary entry for this intent. For skip intents this is the source
  // guard, while targetQueueEntryId below is the resolved destination.
  // A null target means the skip was resolved at the queue boundary.
  queueEntryId?: QueueEntryId;
  targetQueueEntryId?: QueueEntryId | null;
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
