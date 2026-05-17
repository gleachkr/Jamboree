import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelName } from './transport.ts';

type ReceiveHandler = (data: Uint8Array, peerId: string) => void;

class FakeTrysteroRoom {
  readonly actionReceivers = new Map<ChannelName, ReceiveHandler>();
  readonly sent: Array<{
    channel: ChannelName;
    payload: Uint8Array;
    peerId?: string;
  }> = [];
  leaveCalls = 0;
  pingImpl: (peerId: string) => Promise<number> = () => Promise.resolve(1);
  private peerJoin: ((peerId: string) => void) | null = null;
  private peerLeave: ((peerId: string) => void) | null = null;

  makeAction<T>(channel: ChannelName): unknown {
    const send = (payload: T, peerId?: string) => {
      this.sent.push({ channel, payload: payload as Uint8Array, peerId });
      return Promise.resolve();
    };
    const receive = (handler: ReceiveHandler) => {
      this.actionReceivers.set(channel, handler);
    };
    return [send, receive];
  }

  onPeerJoin(handler: (peerId: string) => void): void {
    this.peerJoin = handler;
  }

  onPeerLeave(handler: (peerId: string) => void): void {
    this.peerLeave = handler;
  }

  ping(peerId: string): Promise<number> {
    return this.pingImpl(peerId);
  }

  getPeers(): Record<string, RTCPeerConnection> {
    return {};
  }

  leave(): Promise<void> {
    this.leaveCalls += 1;
    return Promise.resolve();
  }

  emitJoin(peerId: string): void {
    this.peerJoin?.(peerId);
  }

  emitLeave(peerId: string): void {
    this.peerLeave?.(peerId);
  }

  emitAction(
    channel: ChannelName,
    payload: Uint8Array,
    peerId: string,
  ): void {
    this.actionReceivers.get(channel)?.(payload, peerId);
  }
}

const mockTrystero = vi.hoisted(() => {
  const rooms: FakeTrysteroRoom[] = [];
  return {
    rooms,
    joinRoom: vi.fn(() => {
      const room = new FakeTrysteroRoom();
      rooms.push(room);
      return room;
    }),
  };
});

vi.mock('@trystero-p2p/torrent', () => ({
  getRelaySockets: () => ({}),
  joinRoom: mockTrystero.joinRoom,
  selfId: 'self_peer',
}));

import { joinJamboreeRoom } from './transport-trystero.ts';

beforeEach(() => {
  vi.useFakeTimers();
  mockTrystero.rooms.length = 0;
  mockTrystero.joinRoom.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('TrysteroTransport', () => {
  it('rejoins the Trystero room after all known peers leave', async () => {
    const transport = joinJamboreeRoom({
      roomId: 'room',
      roomKey: 'key',
      zeroPeerRejoinDelayMs: 100,
      rejoinCooldownMs: 0,
    });
    const firstRoom = mockTrystero.rooms[0]!;

    firstRoom.emitJoin('peer_a');
    firstRoom.emitLeave('peer_a');
    await vi.advanceTimersByTimeAsync(100);

    expect(firstRoom.leaveCalls).toBe(1);
    expect(mockTrystero.rooms).toHaveLength(2);

    transport.destroy();
  });

  it('keeps action receivers wired across a zero-peer rejoin', async () => {
    const transport = joinJamboreeRoom({
      roomId: 'room',
      roomKey: 'key',
      zeroPeerRejoinDelayMs: 100,
      rejoinCooldownMs: 0,
    });
    const seen: Array<{ peerId: string; payload: Uint8Array }> = [];
    transport.receive('sv', (peerId, payload) => {
      seen.push({ peerId, payload });
    });

    mockTrystero.rooms[0]!.emitJoin('peer_a');
    mockTrystero.rooms[0]!.emitLeave('peer_a');
    await vi.advanceTimersByTimeAsync(100);

    const payload = new Uint8Array([1, 2, 3]);
    mockTrystero.rooms[1]!.emitAction('sv', payload, 'peer_a');

    expect(seen).toEqual([{ peerId: 'peer_a', payload }]);

    transport.destroy();
  });

  it('keeps retrying while previously connected and peerless', async () => {
    const transport = joinJamboreeRoom({
      roomId: 'room',
      roomKey: 'key',
      zeroPeerRejoinDelayMs: 100,
      rejoinCooldownMs: 0,
    });
    const firstRoom = mockTrystero.rooms[0]!;

    firstRoom.emitJoin('peer_a');
    firstRoom.emitLeave('peer_a');
    await vi.advanceTimersByTimeAsync(100);
    expect(mockTrystero.rooms).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(100);
    expect(mockTrystero.rooms).toHaveLength(3);

    transport.destroy();
  });

  it('rejoins when the only known peer stops answering pings', async () => {
    const transport = joinJamboreeRoom({
      roomId: 'room',
      roomKey: 'key',
      rejoinCooldownMs: 0,
      peerHealthCheckIntervalMs: 100,
      peerHealthCheckTimeoutMs: 50,
    });
    const firstRoom = mockTrystero.rooms[0]!;
    const left: string[] = [];
    transport.onPeerLeave((peerId) => left.push(peerId));
    firstRoom.pingImpl = () => new Promise<number>(() => {});

    firstRoom.emitJoin('peer_a');
    await vi.advanceTimersByTimeAsync(150);

    expect(left).toEqual(['peer_a']);
    expect(firstRoom.leaveCalls).toBe(1);
    expect(mockTrystero.rooms).toHaveLength(2);

    transport.destroy();
  });

  it('drops stale peers without rejoining when others answer', async () => {
    const transport = joinJamboreeRoom({
      roomId: 'room',
      roomKey: 'key',
      rejoinCooldownMs: 0,
      peerHealthCheckIntervalMs: 100,
      peerHealthCheckTimeoutMs: 50,
    });
    const firstRoom = mockTrystero.rooms[0]!;
    const left: string[] = [];
    transport.onPeerLeave((peerId) => left.push(peerId));
    firstRoom.pingImpl = (peerId) => {
      if (peerId === 'peer_a') return new Promise<number>(() => {});
      return Promise.resolve(1);
    };

    firstRoom.emitJoin('peer_a');
    firstRoom.emitJoin('peer_b');
    await vi.advanceTimersByTimeAsync(150);

    expect(left).toEqual(['peer_a']);
    expect(firstRoom.leaveCalls).toBe(0);
    expect(mockTrystero.rooms).toHaveLength(1);

    transport.destroy();
  });

  it('does not rejoin when known peers answer health pings', async () => {
    const transport = joinJamboreeRoom({
      roomId: 'room',
      roomKey: 'key',
      rejoinCooldownMs: 0,
      peerHealthCheckIntervalMs: 100,
      peerHealthCheckTimeoutMs: 50,
    });
    const firstRoom = mockTrystero.rooms[0]!;

    firstRoom.emitJoin('peer_a');
    await vi.advanceTimersByTimeAsync(250);

    expect(firstRoom.leaveCalls).toBe(0);
    expect(mockTrystero.rooms).toHaveLength(1);

    transport.destroy();
  });

  it('accelerates a pending rejoin when page becomes visible', async () => {
    const browser = installBrowserLifecycle();
    const transport = joinJamboreeRoom({
      roomId: 'room',
      roomKey: 'key',
      zeroPeerRejoinDelayMs: 10_000,
      rejoinCooldownMs: 0,
    });
    const firstRoom = mockTrystero.rooms[0]!;

    firstRoom.emitJoin('peer_a');
    firstRoom.emitLeave('peer_a');
    browser.fireDocument('visibilitychange');
    await vi.advanceTimersByTimeAsync(0);

    expect(mockTrystero.rooms).toHaveLength(2);

    transport.destroy();
  });

  it('accelerates a pending rejoin on page show', async () => {
    const browser = installBrowserLifecycle();
    const transport = joinJamboreeRoom({
      roomId: 'room',
      roomKey: 'key',
      zeroPeerRejoinDelayMs: 10_000,
      rejoinCooldownMs: 0,
    });
    const firstRoom = mockTrystero.rooms[0]!;

    firstRoom.emitJoin('peer_a');
    firstRoom.emitLeave('peer_a');
    browser.fireWindow('pageshow');
    await vi.advanceTimersByTimeAsync(0);

    expect(mockTrystero.rooms).toHaveLength(2);

    transport.destroy();
  });
});

type Listener = () => void;

function installBrowserLifecycle(): {
  fireDocument: (type: string) => void;
  fireWindow: (type: string) => void;
} {
  const documentListeners = new Map<string, Set<Listener>>();
  const windowListeners = new Map<string, Set<Listener>>();
  const add = (
    listeners: Map<string, Set<Listener>>,
    type: string,
    listener: Listener,
  ) => {
    let set = listeners.get(type);
    if (!set) {
      set = new Set();
      listeners.set(type, set);
    }
    set.add(listener);
  };
  const remove = (
    listeners: Map<string, Set<Listener>>,
    type: string,
    listener: Listener,
  ) => {
    listeners.get(type)?.delete(listener);
  };
  const fire = (listeners: Map<string, Set<Listener>>, type: string) => {
    for (const listener of listeners.get(type) ?? []) listener();
  };

  vi.stubGlobal('document', {
    visibilityState: 'visible',
    addEventListener: vi.fn((type: string, listener: Listener) => {
      add(documentListeners, type, listener);
    }),
    removeEventListener: vi.fn((type: string, listener: Listener) => {
      remove(documentListeners, type, listener);
    }),
  });
  vi.stubGlobal('window', {
    addEventListener: vi.fn((type: string, listener: Listener) => {
      add(windowListeners, type, listener);
    }),
    removeEventListener: vi.fn((type: string, listener: Listener) => {
      remove(windowListeners, type, listener);
    }),
  });

  return {
    fireDocument: (type: string) => fire(documentListeners, type),
    fireWindow: (type: string) => fire(windowListeners, type),
  };
}
