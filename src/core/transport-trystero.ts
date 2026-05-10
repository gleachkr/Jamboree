// Trystero adapter for the Transport interface. Uses the BitTorrent tracker
// strategy by default rather than Nostr (which DESIGN.md §2 originally
// proposed): Nostr public relays rate-limit our signaling traffic ("you are
// noting too much" from Damus, etc.), while WebTorrent trackers are
// purpose-built for high-frequency WebRTC signaling and don't push back on
// reasonable announce volumes. The room password is the URL-fragment key
// from the invite — both the rendezvous secret and the implicit capability.
//
// We deliberately keep this file thin: all protocol logic lives in
// provider.ts and is tested against the FakeTransportHub. This file only
// translates between the Transport interface and Trystero's room API.

import { joinRoom, selfId } from '@trystero-p2p/torrent';
import type {
  ActionReceiver,
  ActionSender,
  Room,
} from '@trystero-p2p/core';
import {
  CHANNELS,
  type ChannelName,
  type RemotePeerId,
  type Transport,
} from './transport.ts';

export type TrysteroTransportOptions = {
  roomId: string;
  // Capability secret from the invite URL fragment; used as the Trystero
  // room password so peers without the secret cannot join the room on the
  // rendezvous network.
  roomKey: string;
  // Application identifier used to namespace this app on the rendezvous
  // network (so we don't see traffic from other Trystero apps).
  appId?: string;
  // Override the rendezvous relays. Defaults to Trystero's built-in
  // WebTorrent tracker list (tracker.webtorrent.dev, openwebtorrent, etc.).
  // Cross-NAT calls may also need a TURN server passed via turnConfig.
  relayUrls?: string[];
  turnConfig?: Array<{
    urls: string | string[];
    username?: string;
    credential?: string;
  }>;
};

const DEFAULT_APP_ID = 'jamboree.app';

export function joinJamboreeRoom(opts: TrysteroTransportOptions): TrysteroTransport {
  const room = joinRoom(
    {
      appId: opts.appId ?? DEFAULT_APP_ID,
      password: opts.roomKey,
      relayConfig: opts.relayUrls ? { urls: opts.relayUrls } : undefined,
      turnConfig: opts.turnConfig,
    },
    opts.roomId,
  );
  return new TrysteroTransport({ room, localPeerId: selfId });
}

export class TrysteroTransport implements Transport {
  readonly localPeerId: RemotePeerId;
  private readonly room: Room;
  private readonly senders: Map<ChannelName, ActionSender<Uint8Array>> = new Map();
  private readonly receivers: Map<
    ChannelName,
    Set<(peerId: RemotePeerId, payload: Uint8Array) => void>
  > = new Map();
  private readonly joinHandlers = new Set<(peerId: RemotePeerId) => void>();
  private readonly leaveHandlers = new Set<(peerId: RemotePeerId) => void>();
  private destroyed = false;

  constructor(opts: { room: Room; localPeerId: RemotePeerId }) {
    this.room = opts.room;
    this.localPeerId = opts.localPeerId;

    for (const channel of CHANNELS) {
      const [send, receive] = this.room.makeAction<Uint8Array>(channel) as [
        ActionSender<Uint8Array>,
        ActionReceiver<Uint8Array>,
        unknown,
      ];
      this.senders.set(channel, send);
      const handlers = new Set<(p: RemotePeerId, payload: Uint8Array) => void>();
      this.receivers.set(channel, handlers);
      receive((data, peerId) => {
        // Trystero hands us the raw payload (Uint8Array on supporting strats).
        // Fan out to all subscribed receivers for this channel.
        for (const h of handlers) h(peerId, asUint8Array(data));
      });
    }

    this.room.onPeerJoin((peerId) => {
      for (const h of this.joinHandlers) h(peerId);
    });
    this.room.onPeerLeave((peerId) => {
      for (const h of this.leaveHandlers) h(peerId);
    });
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
    const sender = this.senders.get(channel);
    if (!sender) return;
    // Ignore the returned promise — Trystero resolves once the message has
    // been queued on every peer's data channel; we treat sends as fire-and-
    // forget at this layer.
    void sender(payload, peerId);
  }

  receive(
    channel: ChannelName,
    handler: (peerId: RemotePeerId, payload: Uint8Array) => void,
  ): () => void {
    const set = this.receivers.get(channel);
    if (!set) throw new Error(`unknown channel ${channel}`);
    set.add(handler);
    return () => set.delete(handler);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    void this.room.leave();
  }
}

function asUint8Array(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  throw new Error(`TrysteroTransport: expected binary payload, got ${typeof data}`);
}
