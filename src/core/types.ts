// Shared room model types. These mirror DESIGN.md §4 but target Stage 1:
// queue + tracks + playback intents only. Awareness, snapshots, chat, and
// settings are deferred until later stages.

export type TrackId = string;
export type QueueEntryId = string;
export type IntentId = string;
export type ActivityId = string;
export type PeerId = string;

export type TrackSourceKind = 'local-file' | 'magnet' | 'web-seed' | 'url';

export type TrackMeta = {
  id: TrackId;
  title: string;
  artist?: string;
  album?: string;
  durationMs?: number;
  mime?: string;
  sizeBytes?: number;
  magnetURI?: string;
  fileName?: string;
  fileIndex?: number;
  infoHash?: string;
  addedByPeerId: PeerId;
  addedAt: number;
  sourceKind: TrackSourceKind;
  webSeeds?: string[];
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
