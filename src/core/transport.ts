// Transport: the narrow surface JamboreeYProvider needs from the network. The
// real implementation wraps Trystero (see transport-trystero.ts); the fake hub
// in this file lets tests simulate duplicate / out-of-order / dropped delivery
// without touching WebRTC.

export type RemotePeerId = string;

// Channel names are short — Trystero limits action ids to 12 bytes.
export type ChannelName = 'sv' | 'up' | 'aw';
export const CHANNELS: readonly ChannelName[] = ['sv', 'up', 'aw'];

export interface Transport {
  readonly localPeerId: RemotePeerId;
  onPeerJoin(handler: (peerId: RemotePeerId) => void): () => void;
  onPeerLeave(handler: (peerId: RemotePeerId) => void): () => void;
  // peerId omitted = broadcast to all currently connected peers.
  send(channel: ChannelName, payload: Uint8Array, peerId?: RemotePeerId): void;
  receive(
    channel: ChannelName,
    handler: (peerId: RemotePeerId, payload: Uint8Array) => void,
  ): () => void;
  destroy(): void;
}

// ---------------------------------------------------------------------------
// Fake transport hub: an in-process mesh used by provider tests.
//
// Default behavior is auto-deliver, which makes the common case ("two peers,
// concurrent edits, expect convergence") read like a synchronous test. For
// tests that need to manipulate the network — drop a message, reorder, or
// duplicate — set `autoDeliver = false`, perform the actions, then call
// `flush()` (or take pending messages and replay them however you want).

export type PendingMessage = {
  from: RemotePeerId;
  to: RemotePeerId;
  channel: ChannelName;
  payload: Uint8Array;
};

export class FakeTransportHub {
  autoDeliver = true;
  private readonly transports = new Map<RemotePeerId, FakeTransport>();
  private readonly pending: PendingMessage[] = [];

  // Allocate a transport for `peerId`. Does NOT fire any join notifications:
  // the caller needs to subscribe its provider to the returned transport
  // first (otherwise the very first state-vector exchange would race the
  // receive() registration). Call announce(peerId) once the provider is
  // wired up to broadcast join events both ways.
  connect(peerId: RemotePeerId): Transport {
    if (this.transports.has(peerId)) {
      throw new Error(`FakeTransportHub: duplicate peer ${peerId}`);
    }
    const t = new FakeTransport(peerId, this);
    this.transports.set(peerId, t);
    return t;
  }

  announce(peerId: RemotePeerId): void {
    const t = this.transports.get(peerId);
    if (!t) throw new Error(`FakeTransportHub: unknown peer ${peerId}`);
    for (const [otherId, other] of this.transports) {
      if (otherId === peerId) continue;
      other._notifyJoin(peerId);
      t._notifyJoin(otherId);
    }
  }

  disconnect(peerId: RemotePeerId): void {
    const t = this.transports.get(peerId);
    if (!t) return;
    this.transports.delete(peerId);
    t._markDestroyed();
    for (const other of this.transports.values()) {
      other._notifyLeave(peerId);
    }
    // Drop any pending traffic to/from the disconnected peer.
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const m = this.pending[i]!;
      if (m.from === peerId || m.to === peerId) this.pending.splice(i, 1);
    }
  }

  // Test hooks ---------------------------------------------------------------

  pendingCount(): number {
    return this.pending.length;
  }

  takePending(): PendingMessage[] {
    return this.pending.splice(0, this.pending.length);
  }

  // Put messages back into the queue (typically captured via takePending()
  // and then replayed in a different order, twice for duplicates, etc.).
  inject(messages: PendingMessage[]): void {
    for (const m of messages) this.pending.push(m);
  }

  flush(): void {
    // Loop until quiescent — applying a delivery may schedule more sends if
    // autoDeliver is on, but deliveries during a flush bypass autoDeliver to
    // avoid unbounded recursion.
    while (this.pending.length > 0) {
      const batch = this.pending.splice(0, this.pending.length);
      for (const m of batch) {
        const dest = this.transports.get(m.to);
        dest?._deliver(m.from, m.channel, m.payload);
      }
    }
  }

  // Internal: called by FakeTransport.send -----------------------------------

  _enqueue(
    from: RemotePeerId,
    channel: ChannelName,
    payload: Uint8Array,
    to: RemotePeerId | undefined,
  ): void {
    const targets = to
      ? [to]
      : Array.from(this.transports.keys()).filter((p) => p !== from);
    for (const t of targets) {
      this.pending.push({ from, to: t, channel, payload });
    }
    if (this.autoDeliver) this.flush();
  }
}

class FakeTransport implements Transport {
  readonly localPeerId: RemotePeerId;
  private readonly hub: FakeTransportHub;
  private destroyed = false;
  private readonly joinHandlers = new Set<(p: RemotePeerId) => void>();
  private readonly leaveHandlers = new Set<(p: RemotePeerId) => void>();
  private readonly receivers = new Map<
    ChannelName,
    Set<(p: RemotePeerId, payload: Uint8Array) => void>
  >();

  constructor(peerId: RemotePeerId, hub: FakeTransportHub) {
    this.localPeerId = peerId;
    this.hub = hub;
  }

  onPeerJoin(handler: (peerId: RemotePeerId) => void): () => void {
    this.joinHandlers.add(handler);
    return () => this.joinHandlers.delete(handler);
  }

  onPeerLeave(handler: (peerId: RemotePeerId) => void): () => void {
    this.leaveHandlers.add(handler);
    return () => this.leaveHandlers.delete(handler);
  }

  send(channel: ChannelName, payload: Uint8Array, peerId?: RemotePeerId): void {
    if (this.destroyed) return;
    this.hub._enqueue(this.localPeerId, channel, payload, peerId);
  }

  receive(
    channel: ChannelName,
    handler: (peerId: RemotePeerId, payload: Uint8Array) => void,
  ): () => void {
    let set = this.receivers.get(channel);
    if (!set) {
      set = new Set();
      this.receivers.set(channel, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  destroy(): void {
    this.hub.disconnect(this.localPeerId);
  }

  _notifyJoin(peerId: RemotePeerId): void {
    for (const h of this.joinHandlers) h(peerId);
  }

  _notifyLeave(peerId: RemotePeerId): void {
    for (const h of this.leaveHandlers) h(peerId);
  }

  _deliver(from: RemotePeerId, channel: ChannelName, payload: Uint8Array): void {
    if (this.destroyed) return;
    const set = this.receivers.get(channel);
    if (!set) return;
    for (const h of set) h(from, payload);
  }

  _markDestroyed(): void {
    this.destroyed = true;
  }
}
