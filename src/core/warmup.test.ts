import { describe, expect, it } from 'vitest';
import { nextWarmupFileRef } from './warmup.ts';
import type { Batch, QueueEntry, TrackMeta } from './types.ts';

type Snapshot = Parameters<typeof nextWarmupFileRef>[0];
type StatusKind = ReturnType<Parameters<typeof nextWarmupFileRef>[2]>['kind'];

function batch(id: string): Batch {
  return {
    id,
    contentId: `${id}`.padEnd(40, id),
    files: [],
    addedByPeerId: 'peer_a',
    addedAt: 0,
  };
}

function track(id: string, batchId = id): TrackMeta {
  return {
    id,
    title: id,
    batchId,
    fileIndex: 0,
    addedByPeerId: 'peer_a',
    addedAt: 0,
  };
}

function entry(id: string, trackId = id): QueueEntry {
  return {
    entryId: id,
    trackId,
    addedByPeerId: 'peer_a',
    addedAt: 0,
  };
}

function snapshot(ids: string[]): Snapshot {
  const batches = new Map<string, Batch>();
  const tracks = new Map<string, TrackMeta>();
  const queue: QueueEntry[] = [];

  for (const id of ids) {
    batches.set(id, batch(id));
    tracks.set(id, track(id));
    queue.push(entry(id));
  }

  return { batches, tracks, queue };
}

function statusMap(readyIds: string[]) {
  const ready = new Set(readyIds.map((id) => `${id}`.padEnd(40, id)));
  return (contentId: string, _fileIndex: number): { kind: StatusKind } => ({
    kind: ready.has(contentId) ? 'ready' : 'pending',
  });
}

describe('nextWarmupFileRef', () => {
  it('starts at the first queue entry when nothing is selected', () => {
    const snap = snapshot(['a', 'b', 'c']);

    expect(nextWarmupFileRef(snap, undefined, statusMap([]))).toEqual({
      contentId: 'a'.padEnd(40, 'a'),
      fileIndex: 0,
    });
  });

  it('returns the queue entry after the current one', () => {
    const snap = snapshot(['a', 'b', 'c']);

    expect(nextWarmupFileRef(snap, 'a', statusMap([]))).toEqual({
      contentId: 'b'.padEnd(40, 'b'),
      fileIndex: 0,
    });
  });

  it('skips ready entries and continues down the upcoming queue', () => {
    const snap = snapshot(['a', 'b', 'c', 'd']);

    expect(nextWarmupFileRef(snap, 'a', statusMap(['b', 'c']))).toEqual({
      contentId: 'd'.padEnd(40, 'd'),
      fileIndex: 0,
    });
  });

  it('wraps to the beginning after reaching the end', () => {
    const snap = snapshot(['a', 'b', 'c']);

    expect(nextWarmupFileRef(snap, 'b', statusMap(['c']))).toEqual({
      contentId: 'a'.padEnd(40, 'a'),
      fileIndex: 0,
    });
  });

  it('starts at the beginning when the current entry is last', () => {
    const snap = snapshot(['a', 'b', 'c']);

    expect(nextWarmupFileRef(snap, 'c', statusMap([]))).toEqual({
      contentId: 'a'.padEnd(40, 'a'),
      fileIndex: 0,
    });
  });

  it('returns null once every non-active entry is ready', () => {
    const snap = snapshot(['a', 'b', 'c']);

    expect(nextWarmupFileRef(snap, 'b', statusMap(['a', 'c']))).toBeNull();
  });

  it('does not warm the current entry', () => {
    const snap = snapshot(['a']);

    expect(nextWarmupFileRef(snap, 'a', statusMap([]))).toBeNull();
  });

  it('returns null if the current entry has left the queue', () => {
    const snap = snapshot(['a', 'b', 'c']);

    expect(nextWarmupFileRef(snap, 'missing', statusMap([]))).toBeNull();
  });
});
