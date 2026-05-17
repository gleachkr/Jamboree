// Pure derived-state reducer. Walks playback intents in CRDT order and
// produces an anchored DerivedPlaybackState. Per DESIGN.md §7, the play
// head is represented as a (positionMs, effectiveAtWallMs) pair so the UI
// can extrapolate continuous time locally without writing it back to Yjs.

import type {
  Batch,
  DerivedPlaybackState,
  PlaybackIntent,
  QueueEntry,
  TrackMeta,
} from './types.ts';

export type RoomSnapshot = {
  batches: ReadonlyMap<string, Batch>;
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

    case 'skip-next':
    case 'skip-previous':
      return applyResolvedSkip(prior, intent, queueEntries, t);

    case 'stop':
      return { ...STOPPED, effectiveAtWallMs: t, sourceIntentId: intent.id };
  }
}

function applyResolvedSkip(
  prior: DerivedPlaybackState,
  intent: PlaybackIntent,
  queueEntries: ReadonlySet<string>,
  atWallMs: number,
): DerivedPlaybackState {
  const sourceMatches = matchesExpectedEntry(prior, intent);
  if (!sourceMatches && prior.queueEntryId) return prior;
  if (!sourceMatches && intent.queueEntryId) {
    if (queueEntries.has(intent.queueEntryId)) return prior;
  }

  const target = intent.targetQueueEntryId;
  if (!target || !queueEntries.has(target)) {
    return stoppedAt(atWallMs, intent.id);
  }
  return playingAt(target, atWallMs, intent.id);
}

function playingAt(
  entryId: string,
  atWallMs: number,
  sourceIntentId: string,
): DerivedPlaybackState {
  return {
    status: 'playing',
    queueEntryId: entryId,
    positionMs: 0,
    effectiveAtWallMs: atWallMs,
    sourceIntentId,
  };
}

function stoppedAt(atWallMs: number, sourceIntentId: string): DerivedPlaybackState {
  return { ...STOPPED, effectiveAtWallMs: atWallMs, sourceIntentId };
}

function frozenPosition(state: DerivedPlaybackState, atWallMs: number): number {
  if (state.status !== 'playing') return state.positionMs;
  return Math.max(0, state.positionMs + (atWallMs - state.effectiveAtWallMs));
}

function matchesExpectedEntry(
  prior: DerivedPlaybackState,
  intent: PlaybackIntent,
): boolean {
  return !intent.queueEntryId || prior.queueEntryId === intent.queueEntryId;
}
