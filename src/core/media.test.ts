import { afterEach, describe, expect, it } from 'vitest';
import { MediaCache, base64ToUint8, uint8ToBase64 } from './media.ts';
import { FakeTransportHub } from './transport.ts';

function audioFile(name: string, bytes: Uint8Array): File {
  const part = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return new File([part], name, { type: 'audio/mpeg' });
}

async function waitFor(assertion: () => void | boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const result = assertion();
      if (result !== false) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (lastError) throw lastError;
  throw new Error('timed out waiting for assertion');
}

async function connectPair(): Promise<{
  hub: FakeTransportHub;
  alice: MediaCache;
  bob: MediaCache;
}> {
  const hub = new FakeTransportHub();
  const aliceTransport = hub.connect('alice');
  const bobTransport = hub.connect('bob');
  const alice = new MediaCache({ transport: aliceTransport });
  const bob = new MediaCache({ transport: bobTransport });
  hub.announce('alice');
  hub.announce('bob');
  return { hub, alice, bob };
}

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
    const bytes = new Uint8Array(0x9000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
    expect(base64ToUint8(uint8ToBase64(bytes))).toEqual(bytes);
  });
});

describe('MediaCache mesh protocol', () => {
  const caches: MediaCache[] = [];

  afterEach(() => {
    for (const cache of caches.splice(0)) cache.destroy();
  });

  it('seeds local files as ready object URLs', async () => {
    const media = new MediaCache();
    caches.push(media);
    const seeded = await media.seedBatch([
      audioFile('one.mp3', new Uint8Array([1, 2, 3])),
    ]);

    expect(seeded.contentId).toMatch(/^[a-f0-9]{64}$/);
    expect(seeded.files[0]).toMatchObject({
      name: 'one.mp3',
      size: 3,
      mime: 'audio/mpeg',
    });
    expect(seeded.files[0]!.sha256).toMatch(/^[a-f0-9]{64}$/);

    const status = media.getStatus(seeded.contentId, 0);
    expect(status.kind).toBe('ready');
  });

  it('registers a doc batch as pending until selected', async () => {
    const media = new MediaCache();
    caches.push(media);
    await media.addBatchFromDoc({
      contentId: 'a'.repeat(64),
      files: [{ path: 'one.mp3', name: 'one.mp3', size: 3 }],
    });

    expect(media.getStatus('a'.repeat(64), 0).kind).toBe('pending');
  });

  it('downloads the active file from a seed peer', async () => {
    const { alice, bob } = await connectPair();
    caches.push(alice, bob);
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const seeded = await alice.seedBatch([audioFile('one.mp3', bytes)]);

    await bob.addBatchFromDoc(seeded);
    bob.setActive({ contentId: seeded.contentId, fileIndex: 0 });

    await waitFor(() => {
      expect(bob.getStatus(seeded.contentId, 0).kind).toBe('ready');
    });
  });

  it('downloads an upcoming file without making it active', async () => {
    const { alice, bob } = await connectPair();
    caches.push(alice, bob);
    const seeded = await alice.seedBatch([
      audioFile('one.mp3', new Uint8Array([1])),
      audioFile('two.mp3', new Uint8Array([2, 3])),
    ]);

    await bob.addBatchFromDoc(seeded);
    bob.setUpcoming({ contentId: seeded.contentId, fileIndex: 1 });

    await waitFor(() => {
      expect(bob.getStatus(seeded.contentId, 1).kind).toBe('ready');
    });
    expect(bob.getStatus(seeded.contentId, 0).kind).toBe('pending');
  });

  it('lets a completed receiver re-serve a file to a late peer', async () => {
    const hub = new FakeTransportHub();
    const aliceTransport = hub.connect('alice');
    const bobTransport = hub.connect('bob');
    const alice = new MediaCache({ transport: aliceTransport });
    const bob = new MediaCache({ transport: bobTransport });
    caches.push(alice, bob);
    hub.announce('alice');
    hub.announce('bob');

    const seeded = await alice.seedBatch([
      audioFile('one.mp3', new Uint8Array([9, 8, 7, 6])),
    ]);
    await bob.addBatchFromDoc(seeded);
    bob.setActive({ contentId: seeded.contentId, fileIndex: 0 });
    await waitFor(() => {
      expect(bob.getStatus(seeded.contentId, 0).kind).toBe('ready');
    });

    alice.destroy();
    hub.disconnect('alice');

    const carolTransport = hub.connect('carol');
    const carol = new MediaCache({ transport: carolTransport });
    caches.push(carol);
    hub.announce('carol');
    await carol.addBatchFromDoc(seeded);
    carol.setActive({ contentId: seeded.contentId, fileIndex: 0 });

    await waitFor(() => {
      expect(carol.getStatus(seeded.contentId, 0).kind).toBe('ready');
    });
  });
});
