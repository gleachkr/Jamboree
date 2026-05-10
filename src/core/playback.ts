// Pure derived-state reducer. Walks playback intents in CRDT order and
// produces an anchored DerivedPlaybackState. Per DESIGN.md §7, the play
// head is represented as a (positionMs, effectiveAtWallMs) pair so the UI
// can extrapolate continuous time locally without writing it back to Yjs.

import type {
  DerivedPlaybackState,
  PlaybackIntent,
  QueueEntry,
  TrackMeta,
} from './types.ts';

export type RoomSnapshot = {
  tracks: ReadonlyMap<string, TrackMeta>;
  queue: readonly QueueEntry[];
  intents: readonly PlaybackIntent[];
};

const STOPPED: DerivedPlaybackState = {
  status: 'stopped',
  positionMs: 0,
  effectiveAtWallMs: 0,
};

export function derivePlaybackState(snapshot: RoomSnapshot): DerivedPlaybackState {
  const queueEntries = new Set(snapshot.queue.map((e) => e.entryId));

  let state: DerivedPlaybackState = STOPPED;

  for (const intent of snapshot.intents) {
    state = applyIntent(state, intent, snapshot.queue, queueEntries);
  }

  // If the current entry was removed from the queue, fall back to stopped.
  if (state.queueEntryId && !queueEntries.has(state.queueEntryId)) {
    state = { ...STOPPED, effectiveAtWallMs: state.effectiveAtWallMs };
  }

  if (state.queueEntryId) {
    const entry = snapshot.queue.find((e) => e.entryId === state.queueEntryId);
    if (entry) state = { ...state, trackId: entry.trackId };
  }

  return state;
}

export function currentPositionMs(state: DerivedPlaybackState, nowWallMs: number): number {
  if (state.status !== 'playing') return state.positionMs;
  return Math.max(0, state.positionMs + (nowWallMs - state.effectiveAtWallMs));
}

function applyIntent(
  prior: DerivedPlaybackState,
  intent: PlaybackIntent,
  queue: readonly QueueEntry[],
  queueEntries: ReadonlySet<string>,
): DerivedPlaybackState {
  const t = intent.createdAtWallMs;

  switch (intent.kind) {
    case 'play': {
      const target = intent.queueEntryId ?? prior.queueEntryId ?? queue[0]?.entryId;
      if (!target || !queueEntries.has(target)) return prior;
      const sameEntry = target === prior.queueEntryId;
      const positionMs =
        intent.positionMs ?? (sameEntry ? frozenPosition(prior, t) : 0);
      return {
        status: 'playing',
        queueEntryId: target,
        positionMs,
        effectiveAtWallMs: t,
        sourceIntentId: intent.id,
      };
    }

    case 'pause': {
      if (!prior.queueEntryId) return prior;
      const positionMs = intent.positionMs ?? frozenPosition(prior, t);
      return {
        status: 'paused',
        queueEntryId: prior.queueEntryId,
        positionMs,
        effectiveAtWallMs: t,
        sourceIntentId: intent.id,
      };
    }

    case 'seek': {
      const target = intent.queueEntryId ?? prior.queueEntryId;
      if (!target || !queueEntries.has(target)) return prior;
      const positionMs = intent.positionMs ?? 0;
      return {
        ...prior,
        queueEntryId: target,
        positionMs,
        effectiveAtWallMs: t,
        sourceIntentId: intent.id,
      };
    }

    case 'select-entry': {
      const target = intent.queueEntryId;
      if (!target || !queueEntries.has(target)) return prior;
      return {
        status: prior.status === 'playing' ? 'playing' : 'paused',
        queueEntryId: target,
        positionMs: intent.positionMs ?? 0,
        effectiveAtWallMs: t,
        sourceIntentId: intent.id,
      };
    }

    case 'skip-next': {
      const next = neighbor(queue, prior.queueEntryId, +1);
      if (!next) return { ...STOPPED, effectiveAtWallMs: t, sourceIntentId: intent.id };
      return {
        status: 'playing',
        queueEntryId: next.entryId,
        positionMs: 0,
        effectiveAtWallMs: t,
        sourceIntentId: intent.id,
      };
    }

    case 'skip-previous': {
      const prev = neighbor(queue, prior.queueEntryId, -1);
      if (!prev) return { ...STOPPED, effectiveAtWallMs: t, sourceIntentId: intent.id };
      return {
        status: 'playing',
        queueEntryId: prev.entryId,
        positionMs: 0,
        effectiveAtWallMs: t,
        sourceIntentId: intent.id,
      };
    }

    case 'stop':
      return { ...STOPPED, effectiveAtWallMs: t, sourceIntentId: intent.id };
  }
}

function frozenPosition(state: DerivedPlaybackState, atWallMs: number): number {
  if (state.status !== 'playing') return state.positionMs;
  return Math.max(0, state.positionMs + (atWallMs - state.effectiveAtWallMs));
}

function neighbor(
  queue: readonly QueueEntry[],
  currentEntryId: string | undefined,
  direction: 1 | -1,
): QueueEntry | undefined {
  if (queue.length === 0) return undefined;
  if (!currentEntryId) return direction > 0 ? queue[0] : queue[queue.length - 1];
  const idx = queue.findIndex((e) => e.entryId === currentEntryId);
  if (idx < 0) return direction > 0 ? queue[0] : queue[queue.length - 1];
  return queue[idx + direction];
}
