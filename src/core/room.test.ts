import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { JamboreeRoom } from './room.ts';
import type { QueueEntryId, TrackId } from './types.ts';

function syncBoth(a: JamboreeRoom, b: JamboreeRoom): void {
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc), 'remote');
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc), 'remote');
}

// Unique infoHash per call so addBatch doesn't dedupe across distinct test
// tracks. Valid hex of length 40 (mirrors a real BitTorrent infoHash).
let batchCounter = 0;
function uniqueInfoHash(): string {
  batchCounter += 1;
  return batchCounter.toString(16).padStart(40, '0');
}

// One-line equivalent of the old trackInput helper: add a single-file batch
// containing one track, enqueue the track. Returns the same shape the old
// addAndEnqueue did.
function addOne(
  room: JamboreeRoom,
  title: string,
): { trackId: TrackId; entryId: QueueEntryId } {
  const { trackIds, entryIds } = room.addAndEnqueueBatch(
    {
      infoHash: uniqueInfoHash(),
      torrentFileBase64: '',
      files: [{ path: title, name: title, size: 1 }],
    },
    [{ title, fileIndex: 0 }],
  );
  return { trackId: trackIds[0]!, entryId: entryIds[0]! };
}

describe('JamboreeRoom — single-peer commands', () => {
  it('addAndEnqueueBatch puts a batch + track + queue entry into the doc', () => {
    const room = new JamboreeRoom({ peerId: 'peer_a' });
    const { batchId, trackIds, entryIds } = room.addAndEnqueueBatch(
      {
        infoHash: uniqueInfoHash(),
        torrentFileBase64: '',
        files: [{ path: 'Hello.mp3', name: 'Hello.mp3', size: 1 }],
      },
      [{ title: 'Hello', fileIndex: 0 }],
    );
    const snap = room.snapshot();
    expect(snap.batches.get(batchId)).toBeDefined();
    expect(snap.tracks.get(trackIds[0]!)?.title).toBe('Hello');
    expect(snap.tracks.get(trackIds[0]!)?.batchId).toBe(batchId);
    expect(snap.queue).toHaveLength(1);
    expect(snap.queue[0]!.entryId).toBe(entryIds[0]!);
    expect(snap.queue[0]!.trackId).toBe(trackIds[0]!);
  });

  it('addBatch is idempotent on infoHash', () => {
    const room = new JamboreeRoom();
    const sharedHash = uniqueInfoHash();
    const id1 = room.addBatch({
      infoHash: sharedHash,
      torrentFileBase64: '',
      files: [{ path: 'a.mp3', name: 'a.mp3', size: 1 }],
    });
    const id2 = room.addBatch({
      infoHash: sharedHash,
      torrentFileBase64: '',
      files: [{ path: 'a.mp3', name: 'a.mp3', size: 1 }],
    });
    expect(id1).toBe(id2);
    expect(room.snapshot().batches.size).toBe(1);
  });

  it('multi-file batch creates one batch and N tracks', () => {
    const room = new JamboreeRoom();
    const files = [
      { path: 'a.mp3', name: 'a.mp3', size: 1 },
      { path: 'b.mp3', name: 'b.mp3', size: 1 },
      { path: 'c.mp3', name: 'c.mp3', size: 1 },
    ];
    const { batchId, trackIds, entryIds } = room.addAndEnqueueBatch(
      { infoHash: uniqueInfoHash(), torrentFileBase64: '', files },
      [
        { title: 'A', fileIndex: 0 },
        { title: 'B', fileIndex: 1 },
        { title: 'C', fileIndex: 2 },
      ],
    );
    expect(trackIds).toHaveLength(3);
    expect(entryIds).toHaveLength(3);
    expect(room.snapshot().batches.size).toBe(1);
    expect(room.snapshot().tracks.size).toBe(3);
    expect(room.snapshot().queue).toHaveLength(3);
    for (const tid of trackIds) {
      expect(room.snapshot().tracks.get(tid)?.batchId).toBe(batchId);
    }
  });

  it('removeQueueEntry removes the queue entry but keeps the track and batch', () => {
    const room = new JamboreeRoom();
    const { trackId, entryId } = addOne(room, 'A');
    expect(room.removeQueueEntry(entryId)).toBe(true);
    const snap = room.snapshot();
    expect(snap.queue).toHaveLength(0);
    expect(snap.tracks.get(trackId)).toBeDefined();
    expect(snap.batches.size).toBe(1);
  });

  it('moveQueueEntry reorders the queue', () => {
    const room = new JamboreeRoom();
    const a = addOne(room, 'A');
    const b = addOne(room, 'B');
    const c = addOne(room, 'C');
    room.moveQueueEntry(c.entryId, 0);
    const order = room.snapshot().queue.map((e) => e.entryId);
    expect(order).toEqual([c.entryId, a.entryId, b.entryId]);
  });

  it('play/pause/seek append intents and produce expected derived state', () => {
    let now = 1_000;
    const room = new JamboreeRoom({ now: () => now });
    const { entryId } = addOne(room, 'A');
    now = 2_000; room.play({ entryId });
    now = 5_000; room.pause();
    expect(room.derivedState()).toMatchObject({
      status: 'paused',
      queueEntryId: entryId,
      positionMs: 3_000,
      effectiveAtWallMs: 5_000,
    });
    now = 6_000; room.seek(60_000);
    expect(room.derivedState()).toMatchObject({
      status: 'paused',
      positionMs: 60_000,
      effectiveAtWallMs: 6_000,
    });
  });

  it('records activity entries for queue and playback commands', () => {
    const room = new JamboreeRoom({ peerId: 'peer_a' });
    const { trackId, entryId } = addOne(room, 'A');
    room.play({ entryId });
    room.pause();
    const kinds = room.activity().map((a) => a.kind);
    expect(kinds).toEqual(['track-added', 'queue-added', 'play', 'pause']);
    expect(room.activity().every((a) => a.peerId === 'peer_a')).toBe(true);
    expect(room.activity().some((a) => a.trackId === trackId)).toBe(true);
  });

  it('does not write continuous playback time to the doc', () => {
    let now = 1_000;
    const room = new JamboreeRoom({ now: () => now });
    const { entryId } = addOne(room, 'A');
    now = 2_000; room.play({ entryId });
    const intentsBefore = room.intentsArray().length;
    // Simulate time passing — derive at later wall-times, no writes should
    // happen as a side-effect.
    for (let t = 3_000; t <= 60_000; t += 1_000) {
      now = t;
      room.derivedState();
    }
    expect(room.intentsArray().length).toBe(intentsBefore);
  });
});

describe('JamboreeRoom — convergence (Stage 1 acceptance)', () => {
  it('concurrent appends from two peers converge to the same queue', () => {
    const a = new JamboreeRoom({ peerId: 'peer_a' });
    const b = new JamboreeRoom({ peerId: 'peer_b' });
    syncBoth(a, b);

    addOne(a, 'A1');
    addOne(a, 'A2');
    addOne(b, 'B1');
    addOne(b, 'B2');

    syncBoth(a, b);

    const orderA = a.snapshot().queue.map((e) => e.trackId);
    const orderB = b.snapshot().queue.map((e) => e.trackId);
    expect(orderA).toEqual(orderB);
    expect(orderA).toHaveLength(4);
  });

  it('different update orders converge to the same queue', () => {
    const seed = new JamboreeRoom({ peerId: 'peer_seed' });
    const t1 = addOne(seed, 'T1').trackId;
    const t2 = addOne(seed, 'T2').trackId;
    const seedUpdate = seed.encodeStateAsUpdate();

    const a = new JamboreeRoom({ peerId: 'peer_a' });
    const b = new JamboreeRoom({ peerId: 'peer_b' });
    a.applyRemoteUpdate(seedUpdate);
    b.applyRemoteUpdate(seedUpdate);

    // Two concurrent edits from the same starting state.
    addOne(a, 'A_NEW');
    const updA = a.encodeUpdateSince(b.encodeStateVector());

    addOne(b, 'B_NEW');
    const updB = b.encodeUpdateSince(a.encodeStateVector());

    // Apply in opposite orders on a third and fourth peer.
    const c = new JamboreeRoom({ peerId: 'peer_c' });
    c.applyRemoteUpdate(seedUpdate);
    c.applyRemoteUpdate(updA);
    c.applyRemoteUpdate(updB);

    const d = new JamboreeRoom({ peerId: 'peer_d' });
    d.applyRemoteUpdate(seedUpdate);
    d.applyRemoteUpdate(updB);
    d.applyRemoteUpdate(updA);

    expect(c.snapshot().queue.map((e) => e.trackId))
      .toEqual(d.snapshot().queue.map((e) => e.trackId));

    void t1; void t2;
  });

  it('concurrent playback intents converge to the same derived state', () => {
    const a = new JamboreeRoom({ peerId: 'peer_a', now: () => 1_000 });
    const b = new JamboreeRoom({ peerId: 'peer_b', now: () => 1_000 });

    const seeded = addOne(a, 'Shared');
    syncBoth(a, b);

    // Both peers act at the same wall-clock instant.
    a.play({ entryId: seeded.entryId });
    b.pause();

    syncBoth(a, b);

    expect(a.derivedState()).toEqual(b.derivedState());
  });

  it('deleting the current queue entry yields stopped state', () => {
    let now = 1_000;
    const room = new JamboreeRoom({ now: () => now });
    const { entryId } = addOne(room, 'A');
    now = 2_000; room.play({ entryId });
    expect(room.derivedState().status).toBe('playing');
    now = 3_000; room.removeQueueEntry(entryId);
    const state = room.derivedState();
    expect(state.status).toBe('stopped');
    expect(state.queueEntryId).toBeUndefined();
  });

  it('idempotent re-application of the same update does not duplicate entries', () => {
    const a = new JamboreeRoom();
    addOne(a, 'A');
    const update = a.encodeStateAsUpdate();

    const b = new JamboreeRoom();
    b.applyRemoteUpdate(update);
    b.applyRemoteUpdate(update);
    b.applyRemoteUpdate(update);

    expect(b.snapshot().queue).toHaveLength(1);
    expect(b.snapshot().batches.size).toBe(1);
  });
});
