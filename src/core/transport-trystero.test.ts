import { beforeEach, describe, expect, it, vi } from 'vitest';
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
});
