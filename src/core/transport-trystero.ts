// Trystero adapter for the Transport interface. Uses Trystero's BitTorrent
// tracker strategy for rendezvous signaling. We intentionally do not pass a
// pinned relay list here while debugging discovery, so Trystero uses its own
// default tracker set. The room password is the URL-fragment key from the
// invite — both the rendezvous secret and the implicit capability.
//
// We deliberately keep this file thin: all protocol logic lives in
// provider.ts and is tested against the FakeTransportHub. This file only
// translates between the Transport interface and Trystero's room API.

import {
  getRelaySockets,
  joinRoom,
  selfId,
} from '@trystero-p2p/torrent';
import type {
  ActionReceiver,
  ActionSender,
  JoinRoomCallbacks,
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
  // Override the rendezvous relays. Leave undefined to use Trystero's
  // built-in BitTorrent tracker set. Cross-NAT calls may also need a TURN
  // server passed via turnConfig.
  relayUrls?: string[];
  turnConfig?: Array<{
    urls: string | string[];
    username?: string;
    credential?: string;
  }>;
  // Trystero's torrent strategy can keep stale per-room offer state after a
  // WebRTC disconnect. A full leave/join clears that state, matching the
  // manual page refresh that users report as fixing repeering.
  zeroPeerRejoinDelayMs?: number;
  rejoinCooldownMs?: number;
  // WebRTC stacks, especially on mobile suspend/resume paths, can leave a
  // data channel looking present even after the remote side has dropped us.
  // Periodic Trystero pings let us notice that stale-peer state and rejoin.
  peerHealthCheckIntervalMs?: number;
  peerHealthCheckTimeoutMs?: number;
};

const DEFAULT_APP_ID = 'jamboree.app';
const DEFAULT_ZERO_PEER_REJOIN_DELAY_MS = 5_000;
const DEFAULT_REJOIN_COOLDOWN_MS = 30_000;
const DEFAULT_PEER_HEALTH_CHECK_INTERVAL_MS = 20_000;
const DEFAULT_PEER_HEALTH_CHECK_TIMEOUT_MS = 8_000;

export function joinJamboreeRoom(
  opts: TrysteroTransportOptions,
): TrysteroTransport {
  const debug = trysteroDebugEnabled();
  trysteroInfo('join', {
    roomId: opts.roomId,
    selfId,
    relays: opts.relayUrls ?? '(trystero defaults)',
  });
  const room = createTrysteroRoom(opts, debug);
  if (debug) instrumentRelaySocketsSoon();
  return new TrysteroTransport({
    opts,
    room,
    localPeerId: selfId,
    debug,
  });
}

function createTrysteroRoom(
  opts: TrysteroTransportOptions,
  debug: boolean,
): Room {
  const relayUrls = opts.relayUrls;
  const callbacks: JoinRoomCallbacks = {
    onJoinError: (details) => {
      console.warn('[jam/trystero] join error', details);
    },
  };
  if (debug) {
    callbacks.onPeerHandshake = async (
      peerId,
      _send,
      _receive,
      isInitiator,
    ) => {
      trysteroInfo('peer handshake', { peerId, isInitiator });
    };
  }
  return joinRoom(
    {
      appId: opts.appId ?? DEFAULT_APP_ID,
      password: opts.roomKey,
      relayConfig: relayUrls ? { urls: relayUrls } : undefined,
      turnConfig: opts.turnConfig,
    },
    opts.roomId,
    callbacks,
  );
}

export class TrysteroTransport implements Transport {
  readonly localPeerId: RemotePeerId;

  private readonly opts: TrysteroTransportOptions;
  private readonly debug: boolean;
  private room: Room;
  private readonly senders: Map<
    ChannelName,
    ActionSender<Uint8Array>
  > = new Map();
  private readonly receivers: Map<
    ChannelName,
    Set<(peerId: RemotePeerId, payload: Uint8Array) => void>
  > = new Map();
  private readonly joinHandlers = new Set<(peerId: RemotePeerId) => void>();
  private readonly leaveHandlers = new Set<(peerId: RemotePeerId) => void>();
  private readonly currentPeerIds = new Set<RemotePeerId>();
  private destroyed = false;
  private hasEverHadPeer = false;
  private rejoinTimer: ReturnType<typeof setTimeout> | null = null;
  private rejoinTimerTargetMs = 0;
  private rejoinInFlight: Promise<void> | null = null;
  private lastRejoinAtMs = 0;
  private peerHealthTimer: ReturnType<typeof setInterval> | null = null;
  private peerHealthCheckInFlight = false;

  constructor(opts: {
    opts: TrysteroTransportOptions;
    room: Room;
    localPeerId: RemotePeerId;
    debug: boolean;
  }) {
    this.opts = opts.opts;
    this.room = opts.room;
    this.localPeerId = opts.localPeerId;
    this.debug = opts.debug;

    for (const channel of CHANNELS) {
      this.receivers.set(channel, new Set());
    }
    this.attachRoom(opts.room);
    this.addBrowserLifecycleHandlers();
    this.startPeerHealthChecks();
  }

  onPeerJoin(handler: (peerId: RemotePeerId) => void): () => void {
    this.joinHandlers.add(handler);
    return () => this.joinHandlers.delete(handler);
  }

  onPeerLeave(handler: (peerId: RemotePeerId) => void): () => void {
    this.leaveHandlers.add(handler);
    return () => this.leaveHandlers.delete(handler);
  }

  send(
    channel: ChannelName,
    payload: Uint8Array,
    peerId?: RemotePeerId,
  ): void {
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
    this.clearRejoinTimer();
    this.stopPeerHealthChecks();
    this.removeBrowserLifecycleHandlers();
    this.currentPeerIds.clear();
    void this.room.leave();
  }

  private attachRoom(room: Room): void {
    this.room = room;
    this.senders.clear();

    for (const channel of CHANNELS) {
      const [send, receive] = room.makeAction<Uint8Array>(channel) as [
        ActionSender<Uint8Array>,
        ActionReceiver<Uint8Array>,
        unknown,
      ];
      this.senders.set(channel, send);
      const handlers = this.receivers.get(channel);
      if (!handlers) throw new Error(`unknown channel ${channel}`);
      receive((data, peerId) => {
        if (this.destroyed || room !== this.room) return;
        for (const h of handlers) h(peerId, asUint8Array(data));
      });
    }

    room.onPeerJoin((peerId) => {
      if (this.destroyed || room !== this.room) return;
      trysteroInfo('peer join', { peerId });
      this.hasEverHadPeer = true;
      const alreadyKnown = this.currentPeerIds.has(peerId);
      this.currentPeerIds.add(peerId);
      this.clearRejoinTimer();
      if (!alreadyKnown) {
        for (const h of this.joinHandlers) h(peerId);
      }
    });
    room.onPeerLeave((peerId) => {
      if (this.destroyed || room !== this.room) return;
      trysteroInfo('peer leave', { peerId });
      const wasKnown = this.currentPeerIds.delete(peerId);
      if (wasKnown) {
        for (const h of this.leaveHandlers) h(peerId);
      }
      this.scheduleZeroPeerRejoin('all peers left');
    });
  }

  private scheduleZeroPeerRejoin(
    reason: string,
    minDelayMs = this.opts.zeroPeerRejoinDelayMs
      ?? DEFAULT_ZERO_PEER_REJOIN_DELAY_MS,
  ): void {
    if (this.destroyed) return;
    if (!this.hasEverHadPeer || this.currentPeerIds.size > 0) return;
    if (this.rejoinInFlight) return;

    const now = Date.now();
    const cooldown = this.opts.rejoinCooldownMs ?? DEFAULT_REJOIN_COOLDOWN_MS;
    const sinceLastRejoin = now - this.lastRejoinAtMs;
    const cooldownRemaining = Math.max(0, cooldown - sinceLastRejoin);
    const ms = Math.max(minDelayMs, cooldownRemaining);
    const targetMs = now + ms;
    if (this.rejoinTimer) {
      if (this.rejoinTimerTargetMs <= targetMs) return;
      this.clearRejoinTimer();
    }

    trysteroInfo('schedule rejoin', { reason, ms });
    this.rejoinTimerTargetMs = targetMs;
    this.rejoinTimer = setTimeout(() => {
      this.rejoinTimer = null;
      this.rejoinTimerTargetMs = 0;
      void this.rejoinAfterZeroPeers(reason);
    }, ms);
  }

  private async rejoinAfterZeroPeers(reason: string): Promise<void> {
    if (this.destroyed || this.currentPeerIds.size > 0) return;
    await this.rejoinNow(reason, false);
  }

  private async rejoinNow(
    reason: string,
    notifyCurrentPeersLeft: boolean,
  ): Promise<void> {
    if (this.destroyed) return;
    if (this.rejoinInFlight) return this.rejoinInFlight;

    this.clearRejoinTimer();
    this.rejoinInFlight = (async () => {
      const oldRoom = this.room;
      this.lastRejoinAtMs = Date.now();
      this.senders.clear();
      if (notifyCurrentPeersLeft) this.markAllPeersLeft(reason);
      trysteroInfo('rejoin', { reason });
      try {
        await oldRoom.leave();
      } catch (err) {
        console.warn('[jam/trystero] rejoin leave failed', err);
      }
      if (this.destroyed || this.currentPeerIds.size > 0) return;
      this.attachRoom(createTrysteroRoom(this.opts, this.debug));
      if (this.debug) instrumentRelaySocketsSoon();
    })().finally(() => {
      this.rejoinInFlight = null;
      this.scheduleZeroPeerRejoin('still no peers after rejoin');
    });

    await this.rejoinInFlight;
  }

  private markAllPeersLeft(reason: string): void {
    this.markPeersLeft(Array.from(this.currentPeerIds), reason);
  }

  private markPeersLeft(peerIds: RemotePeerId[], reason: string): void {
    const leftPeerIds: RemotePeerId[] = [];
    for (const peerId of peerIds) {
      if (this.currentPeerIds.delete(peerId)) leftPeerIds.push(peerId);
    }
    if (leftPeerIds.length === 0) return;
    trysteroInfo('mark peers left', { reason, peerIds: leftPeerIds });
    for (const peerId of leftPeerIds) {
      for (const h of this.leaveHandlers) h(peerId);
    }
  }

  private clearRejoinTimer(): void {
    if (!this.rejoinTimer) return;
    clearTimeout(this.rejoinTimer);
    this.rejoinTimer = null;
    this.rejoinTimerTargetMs = 0;
  }

  private startPeerHealthChecks(): void {
    if (this.peerHealthTimer) return;
    const intervalMs = this.opts.peerHealthCheckIntervalMs
      ?? DEFAULT_PEER_HEALTH_CHECK_INTERVAL_MS;
    if (intervalMs <= 0) return;
    this.peerHealthTimer = setInterval(() => {
      void this.checkPeerHealth('periodic health check');
    }, intervalMs);
  }

  private stopPeerHealthChecks(): void {
    if (!this.peerHealthTimer) return;
    clearInterval(this.peerHealthTimer);
    this.peerHealthTimer = null;
  }

  private async checkPeerHealth(reason: string): Promise<void> {
    if (this.destroyed || this.rejoinInFlight) return;
    if (this.peerHealthCheckInFlight) return;
    const peerIds = Array.from(this.currentPeerIds);
    if (peerIds.length === 0) return;

    this.peerHealthCheckInFlight = true;
    try {
      const health = await Promise.all(peerIds.map(async (peerId) => ({
        peerId,
        healthy: await this.pingPeerWithTimeout(peerId),
      })));
      if (this.destroyed || this.rejoinInFlight) return;

      const stalePeerIds = health
        .filter(({ healthy }) => !healthy)
        .map(({ peerId }) => peerId);
      if (stalePeerIds.length === 0) return;

      const healthyPeerIds = health
        .filter(({ healthy }) => healthy)
        .map(({ peerId }) => peerId);
      const detail = `${reason}; stale peers: ${stalePeerIds.join(', ')}`;
      this.markPeersLeft(stalePeerIds, detail);
      if (healthyPeerIds.length > 0) return;

      await this.rejoinNow(detail, false);
    } finally {
      this.peerHealthCheckInFlight = false;
    }
  }

  private async pingPeerWithTimeout(peerId: RemotePeerId): Promise<boolean> {
    const timeoutMs = this.opts.peerHealthCheckTimeoutMs
      ?? DEFAULT_PEER_HEALTH_CHECK_TIMEOUT_MS;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        this.room.ping(peerId).then(() => true, () => false),
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private addBrowserLifecycleHandlers(): void {
    if (typeof window === 'undefined') return;
    window.addEventListener('online', this.handleBrowserOnline);
    window.addEventListener('pageshow', this.handlePageShow);
    if (typeof document !== 'undefined') {
      document.addEventListener(
        'visibilitychange',
        this.handleVisibilityChange,
      );
    }
  }

  private removeBrowserLifecycleHandlers(): void {
    if (typeof window === 'undefined') return;
    window.removeEventListener('online', this.handleBrowserOnline);
    window.removeEventListener('pageshow', this.handlePageShow);
    if (typeof document !== 'undefined') {
      document.removeEventListener(
        'visibilitychange',
        this.handleVisibilityChange,
      );
    }
  }

  private handleBrowserOnline = (): void => {
    this.scheduleZeroPeerRejoin('browser online', 0);
    void this.checkPeerHealth('browser online');
  };

  private handlePageShow = (): void => {
    this.scheduleZeroPeerRejoin('page show', 0);
    void this.checkPeerHealth('page show');
  };

  private handleVisibilityChange = (): void => {
    if (
      typeof document !== 'undefined'
      && document.visibilityState !== 'visible'
    ) {
      return;
    }
    this.scheduleZeroPeerRejoin('page visible', 0);
    void this.checkPeerHealth('page visible');
  };
}

function trysteroDebugEnabled(): boolean {
  try {
    return localStorage.getItem('jamboree:debug') === '1';
  } catch {
    return false;
  }
}

function trysteroInfo(event: string, fields?: Record<string, unknown>): void {
  if (!trysteroDebugEnabled()) return;
  console.info(`[jam/trystero] ${event}`, fields ?? {});
}

const instrumentedRelaySockets = new WeakSet<WebSocket>();

function instrumentRelaySocketsSoon(): void {
  const instrument = (label: string) => {
    const sockets = getRelaySockets() as Record<string, WebSocket>;
    const relays = Object.fromEntries(
      Object.entries(sockets).map(([url, socket]) => [
        url,
        readyStateName(socket.readyState),
      ]),
    );
    console.info('[jam/trystero] relay sockets', { label, relays });

    for (const [url, socket] of Object.entries(sockets)) {
      if (instrumentedRelaySockets.has(socket)) continue;
      instrumentedRelaySockets.add(socket);
      socket.addEventListener('open', () => {
        console.info('[jam/trystero] relay open', { url });
      });
      socket.addEventListener('close', (event) => {
        console.warn('[jam/trystero] relay close', {
          url,
          code: event.code,
          reason: event.reason,
        });
      });
      socket.addEventListener('error', () => {
        console.warn('[jam/trystero] relay error', { url });
      });
      socket.addEventListener('message', (event) => {
        console.info('[jam/trystero] relay in', {
          url,
          message: summarizeRelayMessage(event.data),
        });
      });
      wrapRelaySend(url, socket);
    }
  };
  window.setTimeout(() => instrument('100ms'), 100);
  window.setTimeout(() => instrument('500ms'), 500);
  window.setTimeout(() => instrument('2500ms'), 2500);
}

function wrapRelaySend(url: string, socket: WebSocket): void {
  const originalSend = socket.send.bind(socket);
  socket.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
    console.info('[jam/trystero] relay out', {
      url,
      message: summarizeRelayMessage(data),
    });
    originalSend(data);
  };
}

function summarizeRelayMessage(data: unknown): unknown {
  if (typeof data !== 'string') return typeof data;
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    return summarizeTrackerJson(parsed);
  } catch {
    return data.length > 160 ? `${data.slice(0, 160)}…` : data;
  }
}

function summarizeTrackerJson(msg: Record<string, unknown>): unknown {
  const offer = msg.offer as { sdp?: string } | undefined;
  const answer = msg.answer as { sdp?: string } | undefined;
  return {
    action: msg.action,
    info_hash: shortHex(String(msg.info_hash ?? '')),
    peer_id: msg.peer_id,
    to_peer_id: msg.to_peer_id,
    numwant: msg.numwant,
    interval: msg.interval,
    offer_id: msg.offer_id,
    offers: Array.isArray(msg.offers) ? msg.offers.length : undefined,
    offer: offer ? summarizeSdp(offer.sdp) : undefined,
    answer: answer ? summarizeSdp(answer.sdp) : undefined,
    failure: msg['failure reason'],
    warning: msg['warning message'],
  };
}

function summarizeSdp(sdp: unknown): string {
  return typeof sdp === 'string' ? `${sdp.length} chars` : typeof sdp;
}

function shortHex(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

function readyStateName(state: number): string {
  switch (state) {
    case WebSocket.CONNECTING:
      return 'connecting';
    case WebSocket.OPEN:
      return 'open';
    case WebSocket.CLOSING:
      return 'closing';
    case WebSocket.CLOSED:
      return 'closed';
    default:
      return String(state);
  }
}

function asUint8Array(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  throw new Error(
    `TrysteroTransport: expected binary payload, got ${typeof data}`,
  );
}
