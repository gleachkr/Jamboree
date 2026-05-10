// JamboreeRoom: the local Yjs-backed room model. UI and (later) the network
// provider talk to this class via the command layer; nobody mutates Y.Doc
// structures directly. Per DESIGN.md §15.1, every command runs in a single
// Y transaction and appends an activity record so the UI can show "who did
// what" without inferring it from CRDT diffs.

import * as Y from 'yjs';
import type {
  ActivityId,
  ActivityRecord,
  DerivedPlaybackState,
  IntentId,
  PeerId,
  PlaybackIntent,
  PlaybackIntentKind,
  QueueEntry,
  QueueEntryId,
  TrackId,
  TrackMeta,
} from './types.ts';
import { derivePlaybackState, type RoomSnapshot } from './playback.ts';

export type NewTrackInput = Omit<TrackMeta, 'id' | 'addedByPeerId' | 'addedAt'> & {
  id?: TrackId;
};

export type RoomOptions = {
  peerId?: PeerId;
  doc?: Y.Doc;
  now?: () => number;
};

const SCHEMA_VERSION = 1;

export class JamboreeRoom {
  readonly doc: Y.Doc;
  readonly peerId: PeerId;

  private localSeq = 0;
  private readonly now: () => number;

  constructor(opts: RoomOptions = {}) {
    this.doc = opts.doc ?? new Y.Doc();
    this.peerId = opts.peerId ?? randomId('peer');
    this.now = opts.now ?? Date.now;

    // Touch the shared types so they exist with the expected kinds, and seed
    // metadata if the doc is fresh. Wrapped so we don't emit a meaningless
    // update for a doc that already has these initialised by another peer.
    this.doc.transact(() => {
      this.tracksMap();
      this.queueArray();
      this.intentsArray();
      this.activityArray();
      const meta = this.metaMap();
      if (!meta.has('schemaVersion')) meta.set('schemaVersion', SCHEMA_VERSION);
      if (!meta.has('createdAt')) meta.set('createdAt', this.now());
    }, this);
  }

  // --- shared-type accessors -------------------------------------------------

  metaMap(): Y.Map<unknown> {
    return this.doc.getMap('meta');
  }

  tracksMap(): Y.Map<TrackMeta> {
    return this.doc.getMap<TrackMeta>('tracks');
  }

  queueArray(): Y.Array<QueueEntry> {
    return this.doc.getArray<QueueEntry>('queue');
  }

  intentsArray(): Y.Array<PlaybackIntent> {
    return this.doc.getArray<PlaybackIntent>('playbackIntents');
  }

  activityArray(): Y.Array<ActivityRecord> {
    return this.doc.getArray<ActivityRecord>('activity');
  }

  // --- snapshot / derived state ---------------------------------------------

  snapshot(): RoomSnapshot {
    const tracks = new Map<TrackId, TrackMeta>();
    for (const [id, meta] of this.tracksMap().entries()) tracks.set(id, meta);
    return {
      tracks,
      queue: this.queueArray().toArray(),
      intents: this.intentsArray().toArray(),
    };
  }

  derivedState(): DerivedPlaybackState {
    return derivePlaybackState(this.snapshot());
  }

  activity(): readonly ActivityRecord[] {
    return this.activityArray().toArray();
  }

  // --- queue commands --------------------------------------------------------

  addTrack(input: NewTrackInput): TrackId {
    const id = input.id ?? randomId('track');
    const meta: TrackMeta = {
      ...input,
      id,
      addedByPeerId: this.peerId,
      addedAt: this.now(),
    };
    this.doc.transact(() => {
      this.tracksMap().set(id, meta);
      this.appendActivity({ kind: 'track-added', trackId: id });
    }, this);
    return id;
  }

  enqueueTrack(trackId: TrackId): QueueEntryId {
    if (!this.tracksMap().has(trackId)) {
      throw new Error(`enqueueTrack: unknown trackId ${trackId}`);
    }
    const entryId = randomId('entry');
    const entry: QueueEntry = {
      entryId,
      trackId,
      addedByPeerId: this.peerId,
      addedAt: this.now(),
    };
    this.doc.transact(() => {
      this.queueArray().push([entry]);
      this.appendActivity({ kind: 'queue-added', trackId, entryId });
    }, this);
    return entryId;
  }

  addAndEnqueue(input: NewTrackInput): { trackId: TrackId; entryId: QueueEntryId } {
    let trackId!: TrackId;
    let entryId!: QueueEntryId;
    this.doc.transact(() => {
      trackId = this.addTrack(input);
      entryId = this.enqueueTrack(trackId);
    }, this);
    return { trackId, entryId };
  }

  removeQueueEntry(entryId: QueueEntryId): boolean {
    let removed = false;
    this.doc.transact(() => {
      const arr = this.queueArray();
      const idx = arr.toArray().findIndex((e) => e.entryId === entryId);
      if (idx < 0) return;
      const trackId = arr.get(idx).trackId;
      arr.delete(idx, 1);
      this.appendActivity({ kind: 'queue-removed', entryId, trackId });
      removed = true;
    }, this);
    return removed;
  }

  // Move via delete+insert. This loses CRDT identity for the entry slot but
  // preserves the QueueEntry payload (entryId and trackId stay stable). Per
  // DESIGN.md §8 the room embraces visible convergence; concurrent move/remove
  // converges deterministically even though the chosen winner is not always
  // semantically "remove wins".
  moveQueueEntry(entryId: QueueEntryId, newIndex: number): boolean {
    let moved = false;
    this.doc.transact(() => {
      const arr = this.queueArray();
      const items = arr.toArray();
      const oldIdx = items.findIndex((e) => e.entryId === entryId);
      if (oldIdx < 0) return;
      const entry = items[oldIdx]!;
      arr.delete(oldIdx, 1);
      const clamped = clamp(newIndex, 0, arr.length);
      arr.insert(clamped, [entry]);
      this.appendActivity({ kind: 'queue-moved', entryId, trackId: entry.trackId });
      moved = true;
    }, this);
    return moved;
  }

  // --- playback intent commands ---------------------------------------------

  play(opts: { entryId?: QueueEntryId; positionMs?: number } = {}): IntentId {
    return this.appendIntent({
      kind: 'play',
      queueEntryId: opts.entryId,
      positionMs: opts.positionMs,
    });
  }

  pause(opts: { positionMs?: number } = {}): IntentId {
    return this.appendIntent({ kind: 'pause', positionMs: opts.positionMs });
  }

  seek(positionMs: number, opts: { entryId?: QueueEntryId } = {}): IntentId {
    return this.appendIntent({
      kind: 'seek',
      positionMs,
      queueEntryId: opts.entryId,
    });
  }

  selectEntry(entryId: QueueEntryId, opts: { positionMs?: number } = {}): IntentId {
    return this.appendIntent({
      kind: 'select-entry',
      queueEntryId: entryId,
      positionMs: opts.positionMs,
    });
  }

  skipNext(): IntentId {
    return this.appendIntent({ kind: 'skip-next' });
  }

  skipPrevious(): IntentId {
    return this.appendIntent({ kind: 'skip-previous' });
  }

  stop(): IntentId {
    return this.appendIntent({ kind: 'stop' });
  }

  // --- subscription / lifecycle ---------------------------------------------

  // Notifies on any mutation to the shared state used by the UI. Returns an
  // unsubscribe function. Listener is fired once per Yjs transaction.
  subscribe(listener: () => void): () => void {
    const onUpdate = () => listener();
    this.doc.on('afterTransaction', onUpdate);
    return () => this.doc.off('afterTransaction', onUpdate);
  }

  destroy(): void {
    this.doc.destroy();
  }

  // --- transport hooks (for tests now, real provider later) ------------------

  applyRemoteUpdate(update: Uint8Array): void {
    Y.applyUpdate(this.doc, update, 'remote');
  }

  encodeStateAsUpdate(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc);
  }

  encodeStateVector(): Uint8Array {
    return Y.encodeStateVector(this.doc);
  }

  encodeUpdateSince(stateVector: Uint8Array): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc, stateVector);
  }

  // --- internals -------------------------------------------------------------

  private appendIntent(
    fields: { kind: PlaybackIntentKind } & Partial<
      Pick<PlaybackIntent, 'queueEntryId' | 'positionMs'>
    >,
  ): IntentId {
    const id = randomId('intent');
    const intent: PlaybackIntent = {
      id,
      peerId: this.peerId,
      kind: fields.kind,
      queueEntryId: fields.queueEntryId,
      positionMs: fields.positionMs,
      createdAtWallMs: this.now(),
      localSeq: this.nextSeq(),
    };
    this.doc.transact(() => {
      this.intentsArray().push([intent]);
      this.appendActivity({
        kind: intent.kind,
        entryId: intent.queueEntryId,
        positionMs: intent.positionMs,
      });
    }, this);
    return id;
  }

  private appendActivity(fields: {
    kind: ActivityRecord['kind'];
    trackId?: TrackId;
    entryId?: QueueEntryId;
    positionMs?: number;
  }): ActivityId {
    const id = randomId('act');
    const record: ActivityRecord = {
      id,
      peerId: this.peerId,
      createdAtWallMs: this.now(),
      kind: fields.kind,
      trackId: fields.trackId,
      entryId: fields.entryId,
      positionMs: fields.positionMs,
    };
    this.activityArray().push([record]);
    return id;
  }

  private nextSeq(): number {
    this.localSeq += 1;
    return this.localSeq;
  }
}

// ---------------------------------------------------------------------------

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

function randomId(prefix: string): string {
  const uuid =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : fallbackUuid();
  return `${prefix}_${uuid}`;
}

function fallbackUuid(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
