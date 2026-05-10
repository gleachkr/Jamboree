// JamboreeYProvider: bridges a Y.Doc + Awareness to a Transport. Per
// DESIGN.md §5 we use the simple state-vector handshake: on peer-join each
// side sends its state vector, the other replies with the diff. After that,
// every local Y.Doc update is broadcast incrementally. Awareness updates
// piggyback on the same transport on a separate channel.
//
// Loop avoidance is by origin: when any provider applies a remote update or
// remote awareness state, it tags the apply with the shared REMOTE_ORIGIN
// symbol. All providers ignore updates bearing that origin. Using one shared
// symbol (not `this`) lets multiple providers attach to the same doc — for
// example, a BroadcastChannel transport for same-browser sync running
// alongside a Trystero transport for cross-network sync — without forming
// rebroadcast loops.

import * as Y from 'yjs';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import type { Transport } from './transport.ts';

// Symbol.for so HMR/multi-bundle setups still share the same identity.
export const REMOTE_ORIGIN = Symbol.for('jamboree:remote-origin');

export type JamboreeYProviderOptions = {
  doc: Y.Doc;
  awareness: Awareness;
  transport: Transport;
};

export class JamboreeYProvider {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  readonly transport: Transport;

  private destroyed = false;
  private readonly unsubs: Array<() => void> = [];
  private readonly remotePeers = new Set<string>();

  constructor(opts: JamboreeYProviderOptions) {
    this.doc = opts.doc;
    this.awareness = opts.awareness;
    this.transport = opts.transport;

    // Wire transport callbacks first so we don't miss any join events fired
    // during construction.
    this.unsubs.push(this.transport.onPeerJoin(this.handlePeerJoin));
    this.unsubs.push(this.transport.onPeerLeave(this.handlePeerLeave));
    this.unsubs.push(this.transport.receive('sv', this.handleStateVector));
    this.unsubs.push(this.transport.receive('up', this.handleRemoteUpdate));
    this.unsubs.push(this.transport.receive('aw', this.handleRemoteAwareness));

    this.doc.on('update', this.handleLocalDocUpdate);
    // 'update' fires for both content changes and clock heartbeats; we want
    // to broadcast both so remote peers don't time out our state.
    this.awareness.on('update', this.handleLocalAwarenessUpdate);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    // Tell other peers our awareness is gone before we tear down. Not strictly
    // required (the heartbeat will time out within 30s) but polite.
    try {
      removeAwarenessStates(this.awareness, [this.awareness.clientID], REMOTE_ORIGIN);
    } catch {
      // ignore
    }
    this.doc.off('update', this.handleLocalDocUpdate);
    this.awareness.off('update', this.handleLocalAwarenessUpdate);
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
  }

  // Force-resync to a specific peer (used for "dropped update" recovery).
  resyncWith(peerId: string): void {
    this.sendStateVectorTo(peerId);
    this.sendOurAwarenessTo(peerId);
  }

  // --- handlers --------------------------------------------------------------

  private handlePeerJoin = (peerId: string): void => {
    this.remotePeers.add(peerId);
    this.sendStateVectorTo(peerId);
    this.sendOurAwarenessTo(peerId);
  };

  private handlePeerLeave = (peerId: string): void => {
    this.remotePeers.delete(peerId);
    // We don't know which Awareness clientIDs map to which transport peer, so
    // we let the peer's own clock heartbeat expire. (DESIGN.md §4.6 makes
    // awareness explicitly ephemeral — this is fine.)
  };

  private handleStateVector = (peerId: string, sv: Uint8Array): void => {
    const diff = Y.encodeStateAsUpdate(this.doc, sv);
    this.transport.send('up', diff, peerId);
  };

  private handleRemoteUpdate = (_peerId: string, update: Uint8Array): void => {
    Y.applyUpdate(this.doc, update, REMOTE_ORIGIN);
  };

  private handleRemoteAwareness = (_peerId: string, update: Uint8Array): void => {
    applyAwarenessUpdate(this.awareness, update, REMOTE_ORIGIN);
  };

  private handleLocalDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === REMOTE_ORIGIN) return; // already applied from a remote peer
    this.transport.send('up', update);
  };

  private handleLocalAwarenessUpdate = (
    payload: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin === REMOTE_ORIGIN) return;
    const changed = [
      ...payload.added,
      ...payload.updated,
      ...payload.removed,
    ];
    if (changed.length === 0) return;
    const update = encodeAwarenessUpdate(this.awareness, changed);
    this.transport.send('aw', update);
  };

  // --- send helpers ----------------------------------------------------------

  private sendStateVectorTo(peerId: string): void {
    this.transport.send('sv', Y.encodeStateVector(this.doc), peerId);
  }

  private sendOurAwarenessTo(peerId: string): void {
    if (this.awareness.getLocalState() === null) return;
    const update = encodeAwarenessUpdate(this.awareness, [this.awareness.clientID]);
    this.transport.send('aw', update, peerId);
  }
}
