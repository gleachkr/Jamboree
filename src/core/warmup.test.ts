import { describe, expect, it } from 'vitest';
import { nextWarmupFileRef } from './warmup.ts';
import type { Batch, QueueEntry, TrackMeta } from './types.ts';

type Snapshot = Parameters<typeof nextWarmupFileRef>[0];
type StatusKind = ReturnType<Parameters<typeof nextWarmupFileRef>[2]>['kind'];

function batch(id: string): Batch {
  return {
    id,
    infoHash: `${id}`.padEnd(40, id),
    torrentFileBase64: '',
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
  return (infoHash: string, _fileIndex: number): { kind: StatusKind } => ({
    kind: ready.has(infoHash) ? 'ready' : 'pending',
  });
}

describe('nextWarmupFileRef', () => {
  it('starts at the first queue entry when nothing is selected', () => {
    const snap = snapshot(['a', 'b', 'c']);

    expect(nextWarmupFileRef(snap, undefined, statusMap([]))).toEqual({
      infoHash: 'a'.padEnd(40, 'a'),
      fileIndex: 0,
    });
  });

  it('returns the queue entry after the current one', () => {
    const snap = snapshot(['a', 'b', 'c']);

    expect(nextWarmupFileRef(snap, 'a', statusMap([]))).toEqual({
      infoHash: 'b'.padEnd(40, 'b'),
      fileIndex: 0,
    });
  });

  it('skips ready entries and continues down the upcoming queue', () => {
    const snap = snapshot(['a', 'b', 'c', 'd']);

    expect(nextWarmupFileRef(snap, 'a', statusMap(['b', 'c']))).toEqual({
      infoHash: 'd'.padEnd(40, 'd'),
      fileIndex: 0,
    });
  });

  it('returns null once every upcoming entry is ready', () => {
    const snap = snapshot(['a', 'b', 'c']);

    expect(nextWarmupFileRef(snap, 'a', statusMap(['b', 'c']))).toBeNull();
  });

  it('does not warm entries before the current one', () => {
    const snap = snapshot(['a', 'b', 'c']);

    expect(nextWarmupFileRef(snap, 'b', statusMap(['c']))).toBeNull();
  });

  it('returns null if the current entry has left the queue', () => {
    const snap = snapshot(['a', 'b', 'c']);

    expect(nextWarmupFileRef(snap, 'missing', statusMap([]))).toBeNull();
  });
});
