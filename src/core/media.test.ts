import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type WebTorrent from 'webtorrent';
import { MediaCache, base64ToUint8, uint8ToBase64 } from './media.ts';

// ---------------------------------------------------------------------------
// Fakes: just enough of WebTorrent's surface to drive MediaCache through its
// add → register → reconcile-selections path without touching the network.
// Behaviour modeled on add-by-.torrent-bytes: metadata is available
// synchronously (no infoHash/ready races), and per-file select/deselect is
// tracked so tests can assert the resulting piece-picker state.
// ---------------------------------------------------------------------------

type Listener = (...args: unknown[]) => void;

class FakeEmitter {
  private listeners = new Map<string, Set<Listener>>();
  on(event: string, h: Listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(h);
    return this;
  }
  once(event: string, h: Listener) {
    const wrap: Listener = (...args) => {
      this.off(event, wrap);
      h(...args);
    };
    return this.on(event, wrap);
  }
  off(event: string, h: Listener) {
    this.listeners.get(event)?.delete(h);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    for (const h of [...(this.listeners.get(event) ?? [])]) h(...args);
  }
}

class FakeFile {
  name: string;
  path: string;
  length: number;
  progress = 0;
  downloaded = 0;
  streamURL: string;
  // Stack of priority values currently applied. select() pushes, deselect()
  // pops, mirroring WebTorrent's selection list. effectivePriority is the
  // top of the stack (matches what the piece picker would see).
  selectionStack: number[] = [];

  constructor(opts: { name: string; length?: number; streamURL?: string }) {
    this.name = opts.name;
    this.path = opts.name;
    this.length = opts.length ?? 1024;
    this.streamURL = opts.streamURL ?? `fake://${opts.name}`;
  }

  select(priority: number) {
    this.selectionStack.push(priority);
  }
  deselect() {
    this.selectionStack.pop();
  }
  get effectivePriority(): number | undefined {
    return this.selectionStack[this.selectionStack.length - 1];
  }
}

class FakeTorrent extends FakeEmitter {
  infoHash: string;
  files: FakeFile[];
  ready = true;
  numPeers = 0;
  progress = 0;
  downloaded = 0;
  downloadSpeed = 0;
  torrentFile = new Uint8Array([1, 2, 3, 4]);

  constructor(opts: { infoHash: string; files: FakeFile[] }) {
    super();
    this.infoHash = opts.infoHash;
    this.files = opts.files;
  }
}

class FakeClient {
  addCalls = 0;
  seedCalls = 0;
  private nextAdds: FakeTorrent[] = [];

  queueAdd(t: FakeTorrent) {
    this.nextAdds.push(t);
  }

  add(_bytes: unknown, _opts: unknown): FakeTorrent {
    this.addCalls += 1;
    const t = this.nextAdds.shift();
    if (!t) throw new Error('FakeClient: no torrent queued for add()');
    return t;
  }

  seed(): FakeTorrent {
    this.seedCalls += 1;
    throw new Error('FakeClient.seed not used in these tests');
  }

  destroy() {}
}

function newCache(client: FakeClient): MediaCache {
  return new MediaCache({ client: client as unknown as WebTorrent.Instance });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('base64 helpers', () => {
  it('round-trips an empty buffer', () => {
    const empty = new Uint8Array();
    expect(base64ToUint8(uint8ToBase64(empty))).toEqual(empty);
  });

  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(base64ToUint8(uint8ToBase64(bytes))).toEqual(bytes);
  });

  it('round-trips a buffer larger than one fromCharCode chunk', () => {
    // > 0x8000 to exercise the chunking path in uint8ToBase64.
    const bytes = new Uint8Array(0x9000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
    expect(base64ToUint8(uint8ToBase64(bytes))).toEqual(bytes);
  });
});

describe('MediaCache — addBatchFromDoc', () => {
  let client: FakeClient;
  let media: MediaCache;

  beforeEach(() => {
    client = new FakeClient();
    media = newCache(client);
  });

  afterEach(() => {
    media.destroy();
  });

  it('registers an entry that surfaces in getStatus', async () => {
    const t = new FakeTorrent({
      infoHash: 'a'.repeat(40),
      files: [new FakeFile({ name: 'one.mp3' })],
    });
    client.queueAdd(t);

    await media.addBatchFromDoc({ infoHash: t.infoHash, torrentFileBase64: '' });

    const status = media.getStatus(t.infoHash, 0);
    // Nothing selected yet → no pieces will arrive, so we report pending
    // even though metadata is in hand.
    expect(status.kind).toBe('pending');
  });

  it('is idempotent on infoHash', async () => {
    const t = new FakeTorrent({
      infoHash: 'b'.repeat(40),
      files: [new FakeFile({ name: 'one.mp3' })],
    });
    client.queueAdd(t);

    await media.addBatchFromDoc({ infoHash: t.infoHash, torrentFileBase64: '' });
    await media.addBatchFromDoc({ infoHash: t.infoHash, torrentFileBase64: '' });
    await media.addBatchFromDoc({ infoHash: t.infoHash, torrentFileBase64: '' });

    expect(client.addCalls).toBe(1);
  });

  it('coalesces concurrent calls for the same infoHash', async () => {
    const t = new FakeTorrent({
      infoHash: 'c'.repeat(40),
      files: [new FakeFile({ name: 'one.mp3' })],
    });
    client.queueAdd(t);

    await Promise.all([
      media.addBatchFromDoc({ infoHash: t.infoHash, torrentFileBase64: '' }),
      media.addBatchFromDoc({ infoHash: t.infoHash, torrentFileBase64: '' }),
    ]);

    expect(client.addCalls).toBe(1);
  });
});

describe('MediaCache — setActive / setUpcoming', () => {
  let client: FakeClient;
  let media: MediaCache;

  beforeEach(() => {
    client = new FakeClient();
    media = newCache(client);
  });

  afterEach(() => {
    media.destroy();
  });

  async function addBatch(infoHash: string, fileNames: string[]): Promise<FakeTorrent> {
    const t = new FakeTorrent({
      infoHash,
      files: fileNames.map((n) => new FakeFile({ name: n })),
    });
    client.queueAdd(t);
    await media.addBatchFromDoc({ infoHash, torrentFileBase64: '' });
    return t;
  }

  it('selects the active file at high priority', async () => {
    const t = await addBatch('a'.repeat(40), ['a.mp3', 'b.mp3', 'c.mp3']);
    media.setActive({ infoHash: t.infoHash, fileIndex: 1 });

    expect(t.files[0]!.effectivePriority).toBeUndefined();
    expect(t.files[1]!.effectivePriority).toBe(5); // ACTIVE_PRIORITY
    expect(t.files[2]!.effectivePriority).toBeUndefined();
  });

  it('selects upcoming at lower priority than active', async () => {
    const t = await addBatch('b'.repeat(40), ['a.mp3', 'b.mp3']);
    media.setActive({ infoHash: t.infoHash, fileIndex: 0 });
    media.setUpcoming({ infoHash: t.infoHash, fileIndex: 1 });

    expect(t.files[0]!.effectivePriority).toBe(5);
    expect(t.files[1]!.effectivePriority).toBe(2); // UPCOMING_PRIORITY
  });

  it('deselects the previous active when changing tracks', async () => {
    const t = await addBatch('c'.repeat(40), ['a.mp3', 'b.mp3']);
    media.setActive({ infoHash: t.infoHash, fileIndex: 0 });
    media.setActive({ infoHash: t.infoHash, fileIndex: 1 });

    // The old selection should be cleared, not stacked.
    expect(t.files[0]!.selectionStack).toEqual([]);
    expect(t.files[1]!.effectivePriority).toBe(5);
  });

  it('clears all selections when active and upcoming are null', async () => {
    const t = await addBatch('d'.repeat(40), ['a.mp3', 'b.mp3']);
    media.setActive({ infoHash: t.infoHash, fileIndex: 0 });
    media.setUpcoming({ infoHash: t.infoHash, fileIndex: 1 });
    media.setActive(null);
    media.setUpcoming(null);

    expect(t.files[0]!.selectionStack).toEqual([]);
    expect(t.files[1]!.selectionStack).toEqual([]);
  });

  it('routes active+upcoming across two batches', async () => {
    const t1 = await addBatch('1'.repeat(40), ['a.mp3']);
    const t2 = await addBatch('2'.repeat(40), ['b.mp3']);

    media.setActive({ infoHash: t1.infoHash, fileIndex: 0 });
    media.setUpcoming({ infoHash: t2.infoHash, fileIndex: 0 });

    expect(t1.files[0]!.effectivePriority).toBe(5);
    expect(t2.files[0]!.effectivePriority).toBe(2);
  });

  it('promotes a file whose selection priority changes', async () => {
    const t = await addBatch('e'.repeat(40), ['a.mp3']);
    // First make it upcoming, then promote to active.
    media.setUpcoming({ infoHash: t.infoHash, fileIndex: 0 });
    expect(t.files[0]!.effectivePriority).toBe(2);

    media.setActive({ infoHash: t.infoHash, fileIndex: 0 });
    media.setUpcoming(null);
    expect(t.files[0]!.effectivePriority).toBe(5);
    // No stacked LOW remaining.
    expect(t.files[0]!.selectionStack).toEqual([5]);
  });

  it('applies pending selections on batch registration', async () => {
    // setActive arrives BEFORE the batch is added. Once added, the selection
    // should be reconciled automatically.
    const infoHash = 'f'.repeat(40);
    media.setActive({ infoHash, fileIndex: 0 });

    const t = await addBatch(infoHash, ['a.mp3', 'b.mp3']);
    expect(t.files[0]!.effectivePriority).toBe(5);
    expect(t.files[1]!.effectivePriority).toBeUndefined();
  });
});

describe('MediaCache — getStatus', () => {
  let client: FakeClient;
  let media: MediaCache;

  beforeEach(() => {
    client = new FakeClient();
    media = newCache(client);
  });

  afterEach(() => {
    media.destroy();
  });

  it('returns unknown for an unregistered batch', () => {
    expect(media.getStatus('z'.repeat(40), 0).kind).toBe('unknown');
  });

  it('reports streaming once the active file is selected', async () => {
    const t = new FakeTorrent({
      infoHash: 'a'.repeat(40),
      files: [new FakeFile({ name: 'a.mp3' })],
    });
    client.queueAdd(t);
    await media.addBatchFromDoc({ infoHash: t.infoHash, torrentFileBase64: '' });
    media.setActive({ infoHash: t.infoHash, fileIndex: 0 });

    const status = media.getStatus(t.infoHash, 0);
    expect(status.kind).toBe('streaming');
    if (status.kind === 'streaming') expect(status.url).toBe('fake://a.mp3');
  });

  it('reports ready once progress hits 1', async () => {
    const t = new FakeTorrent({
      infoHash: 'a'.repeat(40),
      files: [new FakeFile({ name: 'a.mp3' })],
    });
    client.queueAdd(t);
    await media.addBatchFromDoc({ infoHash: t.infoHash, torrentFileBase64: '' });
    media.setActive({ infoHash: t.infoHash, fileIndex: 0 });
    t.files[0]!.progress = 1;

    const status = media.getStatus(t.infoHash, 0);
    expect(status.kind).toBe('ready');
  });
});
