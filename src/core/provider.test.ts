import { afterEach, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import { JamboreeRoom } from './room.ts';
import { JamboreeYProvider } from './provider.ts';
import { FakeTransportHub, type Transport } from './transport.ts';

type Peer = {
  id: string;
  room: JamboreeRoom;
  awareness: Awareness;
  provider: JamboreeYProvider;
  transport: Transport;
};

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function makePeer(hub: FakeTransportHub, peerId: string): Peer {
  const transport = hub.connect(peerId);
  const room = new JamboreeRoom({ peerId });
  const awareness = new Awareness(room.doc);
  const provider = new JamboreeYProvider({ doc: room.doc, awareness, transport });
  // Now that handlers are wired, fire join notifications so the existing
  // peers and the new peer learn about each other.
  hub.announce(peerId);
  cleanups.push(() => {
    provider.destroy();
    room.destroy();
  });
  return { id: peerId, room, awareness, provider, transport };
}

let batchCounter = 0;
function uniqueContentId(): string {
  batchCounter += 1;
  return batchCounter.toString(16).padStart(40, '0');
}

function addOne(peer: Peer, title: string): { trackId: string; entryId: string } {
  const { trackIds, entryIds } = peer.room.addAndEnqueueBatch(
    {
      contentId: uniqueContentId(),
      files: [{ path: title, name: title, size: 1 }],
    },
    [{ title, fileIndex: 0 }],
  );
  return { trackId: trackIds[0]!, entryId: entryIds[0]! };
}

function queueTitles(peer: Peer): string[] {
  const snap = peer.room.snapshot();
  return snap.queue.map((e) => snap.tracks.get(e.trackId)?.title ?? '?');
}

describe('JamboreeYProvider — convergence', () => {
  it('two peers converge after concurrent edits', () => {
    const hub = new FakeTransportHub();
    const a = makePeer(hub, 'peer_a');
    const b = makePeer(hub, 'peer_b');

    addOne(a, 'A1');
    addOne(a, 'A2');
    addOne(b, 'B1');
    addOne(b, 'B2');

    expect(queueTitles(a)).toEqual(queueTitles(b));
    expect(queueTitles(a)).toHaveLength(4);
  });

  it('late joiner receives current queue and playback state', () => {
    const hub = new FakeTransportHub();
    const a = makePeer(hub, 'peer_a');
    const { entryId } = addOne(a, 'Established');
    addOne(a, 'Also');
    a.room.play({ entryId });

    const b = makePeer(hub, 'peer_b');

    expect(queueTitles(b)).toEqual(['Established', 'Also']);
    expect(b.room.derivedState().status).toBe('playing');
    expect(b.room.derivedState().queueEntryId).toBe(entryId);
  });

  it('disconnect/reconnect does not duplicate queue entries', () => {
    const hub = new FakeTransportHub();
    const a = makePeer(hub, 'peer_a');
    const b = makePeer(hub, 'peer_b');

    addOne(a, 'Shared');
    expect(queueTitles(b)).toEqual(['Shared']);

    // B disconnects, A makes another change, B reconnects with the same doc
    // (simulating a transient blip — the local doc state survives).
    b.provider.destroy();
    hub.disconnect('peer_b');

    addOne(a, 'AfterBlip');

    const transport = hub.connect('peer_b');
    const provider = new JamboreeYProvider({
      doc: b.room.doc,
      awareness: b.awareness,
      transport,
    });
    hub.announce('peer_b');
    cleanups.push(() => provider.destroy());

    expect(queueTitles(b)).toEqual(['Shared', 'AfterBlip']);
    expect(queueTitles(a)).toEqual(queueTitles(b));
  });
});

describe('JamboreeYProvider — adverse delivery', () => {
  it('duplicate update delivery is idempotent', () => {
    const hub = new FakeTransportHub();
    hub.autoDeliver = false;
    const a = makePeer(hub, 'peer_a');
    const b = makePeer(hub, 'peer_b');
    hub.flush(); // initial handshake

    addOne(a, 'Once');

    const captured = hub.takePending();
    expect(captured.length).toBeGreaterThan(0);
    hub.inject(captured);
    hub.flush();
    hub.inject(captured);
    hub.flush();

    expect(queueTitles(a)).toEqual(['Once']);
    expect(queueTitles(b)).toEqual(['Once']);
  });

  it('out-of-order update delivery still converges', () => {
    const hub = new FakeTransportHub();
    hub.autoDeliver = false;
    const a = makePeer(hub, 'peer_a');
    const b = makePeer(hub, 'peer_b');
    hub.flush();

    addOne(a, 'First');
    addOne(a, 'Second');

    const reversed = hub.takePending().reverse();
    hub.inject(reversed);
    hub.flush();

    expect(queueTitles(a)).toEqual(['First', 'Second']);
    expect(queueTitles(b)).toEqual(['First', 'Second']);
  });

  it('dropped update is recovered via resyncWith()', () => {
    const hub = new FakeTransportHub();
    hub.autoDeliver = false;
    const a = makePeer(hub, 'peer_a');
    const b = makePeer(hub, 'peer_b');
    hub.flush();

    addOne(a, 'LostInPost');

    // Drop everything currently in flight.
    hub.takePending();
    expect(queueTitles(b)).toEqual([]);

    // B notices it's behind and asks A to resync.
    b.provider.resyncWith('peer_a');
    hub.flush();

    expect(queueTitles(b)).toEqual(['LostInPost']);
    expect(queueTitles(a)).toEqual(queueTitles(b));
  });
});

describe('JamboreeYProvider — awareness', () => {
  it('local awareness state propagates to a remote peer', () => {
    const hub = new FakeTransportHub();
    const a = makePeer(hub, 'peer_a');
    const b = makePeer(hub, 'peer_b');

    a.awareness.setLocalState({ name: 'Alice' });

    const seen = b.awareness.getStates().get(a.awareness.clientID);
    expect(seen).toEqual({ name: 'Alice' });
  });

  it('awareness state set before a peer joins is delivered on join', () => {
    const hub = new FakeTransportHub();
    const a = makePeer(hub, 'peer_a');
    a.awareness.setLocalState({ name: 'Alice' });

    const b = makePeer(hub, 'peer_b');

    expect(b.awareness.getStates().get(a.awareness.clientID)).toEqual({
      name: 'Alice',
    });
  });
});
