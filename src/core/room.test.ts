import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { JamboreeRoom } from './room.ts';

function syncBoth(a: JamboreeRoom, b: JamboreeRoom): void {
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc), 'remote');
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc), 'remote');
}

function trackInput(title: string) {
  return { title, sourceKind: 'local-file' as const };
}

describe('JamboreeRoom — single-peer commands', () => {
  it('addAndEnqueue puts a track in tracks and an entry in queue', () => {
    const room = new JamboreeRoom({ peerId: 'peer_a' });
    const { trackId, entryId } = room.addAndEnqueue(trackInput('Hello'));
    const snap = room.snapshot();
    expect(snap.tracks.get(trackId)?.title).toBe('Hello');
    expect(snap.queue).toHaveLength(1);
    expect(snap.queue[0]!.entryId).toBe(entryId);
    expect(snap.queue[0]!.trackId).toBe(trackId);
  });

  it('removeQueueEntry removes the queue entry but keeps the track', () => {
    const room = new JamboreeRoom();
    const { trackId, entryId } = room.addAndEnqueue(trackInput('A'));
    expect(room.removeQueueEntry(entryId)).toBe(true);
    const snap = room.snapshot();
    expect(snap.queue).toHaveLength(0);
    expect(snap.tracks.get(trackId)).toBeDefined();
  });

  it('moveQueueEntry reorders the queue', () => {
    const room = new JamboreeRoom();
    const a = room.addAndEnqueue(trackInput('A'));
    const b = room.addAndEnqueue(trackInput('B'));
    const c = room.addAndEnqueue(trackInput('C'));
    room.moveQueueEntry(c.entryId, 0);
    const order = room.snapshot().queue.map((e) => e.entryId);
    expect(order).toEqual([c.entryId, a.entryId, b.entryId]);
  });

  it('play/pause/seek append intents and produce expected derived state', () => {
    let now = 1_000;
    const room = new JamboreeRoom({ now: () => now });
    const { entryId } = room.addAndEnqueue(trackInput('A'));
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
    const { trackId, entryId } = room.addAndEnqueue(trackInput('A'));
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
    const { entryId } = room.addAndEnqueue(trackInput('A'));
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

    a.addAndEnqueue(trackInput('A1'));
    a.addAndEnqueue(trackInput('A2'));
    b.addAndEnqueue(trackInput('B1'));
    b.addAndEnqueue(trackInput('B2'));

    syncBoth(a, b);

    const orderA = a.snapshot().queue.map((e) => e.trackId);
    const orderB = b.snapshot().queue.map((e) => e.trackId);
    expect(orderA).toEqual(orderB);
    expect(orderA).toHaveLength(4);
  });

  it('different update orders converge to the same queue', () => {
    const seed = new JamboreeRoom({ peerId: 'peer_seed' });
    const t1 = seed.addAndEnqueue(trackInput('T1')).trackId;
    const t2 = seed.addAndEnqueue(trackInput('T2')).trackId;
    const seedUpdate = seed.encodeStateAsUpdate();

    const a = new JamboreeRoom({ peerId: 'peer_a' });
    const b = new JamboreeRoom({ peerId: 'peer_b' });
    a.applyRemoteUpdate(seedUpdate);
    b.applyRemoteUpdate(seedUpdate);

    // Two concurrent edits from the same starting state.
    a.addAndEnqueue(trackInput('A_NEW'));
    const updA = a.encodeUpdateSince(b.encodeStateVector());

    b.addAndEnqueue(trackInput('B_NEW'));
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

    const seeded = a.addAndEnqueue(trackInput('Shared'));
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
    const { entryId } = room.addAndEnqueue(trackInput('A'));
    now = 2_000; room.play({ entryId });
    expect(room.derivedState().status).toBe('playing');
    now = 3_000; room.removeQueueEntry(entryId);
    const state = room.derivedState();
    expect(state.status).toBe('stopped');
    expect(state.queueEntryId).toBeUndefined();
  });

  it('idempotent re-application of the same update does not duplicate entries', () => {
    const a = new JamboreeRoom();
    a.addAndEnqueue(trackInput('A'));
    const update = a.encodeStateAsUpdate();

    const b = new JamboreeRoom();
    b.applyRemoteUpdate(update);
    b.applyRemoteUpdate(update);
    b.applyRemoteUpdate(update);

    expect(b.snapshot().queue).toHaveLength(1);
  });
});
