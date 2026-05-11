import { describe, it, expect } from 'vitest';
import { currentPositionMs, derivePlaybackState, type RoomSnapshot } from './playback.ts';
import type { Batch, PlaybackIntent, QueueEntry, TrackMeta } from './types.ts';

let intentSeq = 0;
function intent(fields: Partial<PlaybackIntent> & Pick<PlaybackIntent, 'kind' | 'createdAtWallMs'>): PlaybackIntent {
  intentSeq += 1;
  return {
    id: `intent_${intentSeq}`,
    peerId: fields.peerId ?? 'peer_a',
    kind: fields.kind,
    queueEntryId: fields.queueEntryId,
    positionMs: fields.positionMs,
    createdAtWallMs: fields.createdAtWallMs,
    localSeq: fields.localSeq ?? intentSeq,
  };
}

function entry(entryId: string, trackId: string): QueueEntry {
  return { entryId, trackId, addedByPeerId: 'peer_a', addedAt: 0 };
}

function track(id: string, title: string): TrackMeta {
  return {
    id,
    title,
    batchId: 'batch_test',
    fileIndex: 0,
    addedByPeerId: 'peer_a',
    addedAt: 0,
  };
}

function snapshot(opts: { queue?: QueueEntry[]; intents?: PlaybackIntent[]; tracks?: TrackMeta[] } = {}): RoomSnapshot {
  const tracks = new Map<string, TrackMeta>();
  for (const t of opts.tracks ?? []) tracks.set(t.id, t);
  const batches = new Map<string, Batch>();
  return { batches, tracks, queue: opts.queue ?? [], intents: opts.intents ?? [] };
}

describe('derivePlaybackState', () => {
  it('returns stopped on an empty room', () => {
    const state = derivePlaybackState(snapshot());
    expect(state.status).toBe('stopped');
    expect(state.queueEntryId).toBeUndefined();
  });

  it('play with no entryId selects the first queue entry', () => {
    const queue = [entry('e1', 't1'), entry('e2', 't2')];
    const state = derivePlaybackState(snapshot({
      queue,
      tracks: [track('t1', 'A'), track('t2', 'B')],
      intents: [intent({ kind: 'play', createdAtWallMs: 1000 })],
    }));
    expect(state.status).toBe('playing');
    expect(state.queueEntryId).toBe('e1');
    expect(state.trackId).toBe('t1');
    expect(state.positionMs).toBe(0);
    expect(state.effectiveAtWallMs).toBe(1000);
  });

  it('pause freezes the play head at intent time', () => {
    const queue = [entry('e1', 't1')];
    const state = derivePlaybackState(snapshot({
      queue,
      intents: [
        intent({ kind: 'play', queueEntryId: 'e1', createdAtWallMs: 1000 }),
        intent({ kind: 'pause', createdAtWallMs: 4500 }),
      ],
    }));
    expect(state.status).toBe('paused');
    expect(state.queueEntryId).toBe('e1');
    expect(state.positionMs).toBe(3500);
    expect(state.effectiveAtWallMs).toBe(4500);
  });

  it('seek updates the play head position', () => {
    const queue = [entry('e1', 't1')];
    const state = derivePlaybackState(snapshot({
      queue,
      intents: [
        intent({ kind: 'play', queueEntryId: 'e1', createdAtWallMs: 1000 }),
        intent({ kind: 'seek', positionMs: 60_000, createdAtWallMs: 2000 }),
      ],
    }));
    expect(state.status).toBe('playing');
    expect(state.positionMs).toBe(60_000);
    expect(state.effectiveAtWallMs).toBe(2000);
  });

  it('select-entry switches the entry but keeps status', () => {
    const queue = [entry('e1', 't1'), entry('e2', 't2')];
    const state = derivePlaybackState(snapshot({
      queue,
      intents: [
        intent({ kind: 'play', queueEntryId: 'e1', createdAtWallMs: 1000 }),
        intent({ kind: 'select-entry', queueEntryId: 'e2', createdAtWallMs: 2000 }),
      ],
    }));
    expect(state.status).toBe('playing');
    expect(state.queueEntryId).toBe('e2');
    expect(state.positionMs).toBe(0);
  });

  it('skip-next advances to the next queue entry', () => {
    const queue = [entry('e1', 't1'), entry('e2', 't2'), entry('e3', 't3')];
    const state = derivePlaybackState(snapshot({
      queue,
      intents: [
        intent({ kind: 'play', queueEntryId: 'e1', createdAtWallMs: 1000 }),
        intent({ kind: 'skip-next', createdAtWallMs: 2000 }),
      ],
    }));
    expect(state.queueEntryId).toBe('e2');
    expect(state.status).toBe('playing');
  });

  it('skip-next at end of queue stops playback', () => {
    const queue = [entry('e1', 't1')];
    const state = derivePlaybackState(snapshot({
      queue,
      intents: [
        intent({ kind: 'play', queueEntryId: 'e1', createdAtWallMs: 1000 }),
        intent({ kind: 'skip-next', createdAtWallMs: 2000 }),
      ],
    }));
    expect(state.status).toBe('stopped');
    expect(state.queueEntryId).toBeUndefined();
  });

  it('intents referencing a removed entry are ignored', () => {
    const state = derivePlaybackState(snapshot({
      queue: [entry('e2', 't2')],
      intents: [
        intent({ kind: 'play', queueEntryId: 'e1', createdAtWallMs: 1000 }),
        intent({ kind: 'select-entry', queueEntryId: 'e_gone', createdAtWallMs: 2000 }),
      ],
    }));
    expect(state.status).toBe('stopped');
  });

  it('falls back to stopped when the current entry was removed from the queue', () => {
    const state = derivePlaybackState(snapshot({
      queue: [entry('e2', 't2')],
      intents: [
        // The play targets e1, but e1 is no longer in queue at derive time.
        intent({ kind: 'play', queueEntryId: 'e1', createdAtWallMs: 1000 }),
      ],
    }));
    expect(state.status).toBe('stopped');
    expect(state.queueEntryId).toBeUndefined();
  });

  it('stop wins as the last intent', () => {
    const state = derivePlaybackState(snapshot({
      queue: [entry('e1', 't1')],
      intents: [
        intent({ kind: 'play', queueEntryId: 'e1', createdAtWallMs: 1000 }),
        intent({ kind: 'stop', createdAtWallMs: 2000 }),
      ],
    }));
    expect(state.status).toBe('stopped');
  });

  it('resume play after pause continues from the frozen position', () => {
    const queue = [entry('e1', 't1')];
    const state = derivePlaybackState(snapshot({
      queue,
      intents: [
        intent({ kind: 'play', queueEntryId: 'e1', createdAtWallMs: 1000 }),
        intent({ kind: 'pause', createdAtWallMs: 5000 }), // position frozen at 4000
        intent({ kind: 'play', createdAtWallMs: 9000 }),
      ],
    }));
    expect(state.status).toBe('playing');
    expect(state.positionMs).toBe(4000);
    expect(state.effectiveAtWallMs).toBe(9000);
  });
});

describe('currentPositionMs', () => {
  it('extrapolates while playing', () => {
    const queue = [entry('e1', 't1')];
    const state = derivePlaybackState(snapshot({
      queue,
      intents: [intent({ kind: 'play', queueEntryId: 'e1', createdAtWallMs: 1000 })],
    }));
    expect(currentPositionMs(state, 6000)).toBe(5000);
  });

  it('returns frozen position while paused', () => {
    const queue = [entry('e1', 't1')];
    const state = derivePlaybackState(snapshot({
      queue,
      intents: [
        intent({ kind: 'play', queueEntryId: 'e1', createdAtWallMs: 1000 }),
        intent({ kind: 'pause', createdAtWallMs: 4000 }),
      ],
    }));
    expect(currentPositionMs(state, 999_999)).toBe(3000);
  });
});
