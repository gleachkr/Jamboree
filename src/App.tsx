import { useEffect, useReducer, useRef, useState } from 'react';
import { Awareness } from 'y-protocols/awareness';
import {
  createInviteUrl,
  generateInvite,
  parseInviteFromParts,
  type RoomInvite,
} from './core/invite.ts';
import { JamboreeRoom } from './core/room.ts';
import { currentPositionMs } from './core/playback.ts';
import { JamboreeYProvider } from './core/provider.ts';
import { MediaCache, type FileStatus } from './core/media.ts';
import { WSS_TRACKERS } from './core/trackers.ts';
import { joinJamboreeRoom } from './core/transport-trystero.ts';
import type {
  ActivityRecord,
  DerivedPlaybackState,
  TrackMeta,
} from './core/types.ts';

const NAME_STORAGE_KEY = 'jamboree:name';

function readInviteFromBrowser(): RoomInvite | null {
  return parseInviteFromParts(window.location.pathname, window.location.hash);
}

function appBaseUrl(): string {
  return new URL(import.meta.env.BASE_URL, window.location.origin).toString();
}

function loadStoredName(): string {
  try {
    return localStorage.getItem(NAME_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function storeName(value: string): void {
  try {
    localStorage.setItem(NAME_STORAGE_KEY, value);
  } catch {
    // ignore quota / private mode failures
  }
}

export default function App() {
  const [initialInvite] = useState<RoomInvite | null>(readInviteFromBrowser);
  const [generated, setGenerated] = useState<RoomInvite | null>(null);
  const invite = initialInvite ?? generated;

  function createRoom() {
    const next = generateInvite();
    window.history.replaceState(null, '', createInviteUrl(next, appBaseUrl()));
    setGenerated(next);
  }

  if (!invite) {
    return (
      <main>
        <h1>Jamboree</h1>
        <p>An ephemeral, friends-only listening room.</p>
        <button onClick={createRoom}>Create a room</button>
      </main>
    );
  }

  return <Room invite={invite} />;
}

type RoomState = {
  room: JamboreeRoom;
  awareness: Awareness;
  provider: JamboreeYProvider;
  media: MediaCache;
};

function Room({ invite }: { invite: RoomInvite }) {
  const [state, setState] = useState<RoomState | null>(null);
  const [, force] = useReducer((x: number) => x + 1, 0);

  useEffect(() => {
    const room = new JamboreeRoom();
    const awareness = new Awareness(room.doc);
    awareness.setLocalState({
      peerId: room.peerId,
      name: loadStoredName(),
      clientKind: 'browser',
    });
    const transport = joinJamboreeRoom({
      roomId: invite.roomId,
      roomKey: invite.key,
      relayUrls: WSS_TRACKERS,
    });
    const provider = new JamboreeYProvider({
      doc: room.doc,
      awareness,
      transport,
    });
    const media = new MediaCache({ trackers: WSS_TRACKERS });
    setState({ room, awareness, provider, media });

    const unsubDoc = room.subscribe(force);
    const unsubMedia = media.subscribe(force);
    const onAwareness = () => force();
    awareness.on('change', onAwareness);

    return () => {
      unsubDoc();
      unsubMedia();
      awareness.off('change', onAwareness);
      provider.destroy();
      media.destroy();
      // provider.destroy already broadcasts our awareness removal; room
      // destroy tears down the doc and chain-destroys the awareness.
      room.destroy();
      setState(null);
    };
  }, [invite.roomId, invite.key]);

  if (!state) return <main><h1>Jamboree</h1><p className="muted">Connecting…</p></main>;

  return <RoomBody invite={invite} state={state} />;
}

function RoomBody({ invite, state }: { invite: RoomInvite; state: RoomState }) {
  const { room, awareness, media } = state;
  const inviteUrl = createInviteUrl(invite, appBaseUrl());
  const derived = room.derivedState();
  const snap = room.snapshot();
  const peerStates = Array.from(awareness.getStates().entries());

  // Auto-fetch any track we know about but haven't yet handed to WebTorrent.
  // This includes both peers' tracks (newly arriving via Yjs sync) and our
  // own tracks after a reload. addMagnet is idempotent, so no need to guard.
  useEffect(() => {
    for (const meta of snap.tracks.values()) {
      if (meta.magnetURI) void media.addMagnet(meta.magnetURI);
    }
    // Re-run whenever the set of tracks changes. Using map size+ids as a
    // cheap dependency — referential identity of snap changes every render.
  }, [media, trackIdsFingerprint(snap.tracks)]);

  return (
    <main>
      <h1>Jamboree</h1>
      <p>
        Room: <strong>{invite.roomId}</strong>
      </p>
      <details>
        <summary>Share link</summary>
        <code>{inviteUrl}</code>
      </details>

      <PeersPanel awareness={awareness} peerStates={peerStates} />
      <PlaybackPanel room={room} derived={derived} media={media} />
      <IngestPanel room={room} media={media} />
      <QueuePanel room={room} derived={derived} media={media} />
      <ActivityPanel room={room} />
    </main>
  );
}

function trackIdsFingerprint(tracks: ReadonlyMap<string, TrackMeta>): string {
  const ids = Array.from(tracks.keys()).sort();
  return ids.join('|');
}

function PeersPanel({
  awareness,
  peerStates,
}: {
  awareness: Awareness;
  peerStates: Array<[number, Record<string, unknown>]>;
}) {
  const [name, setName] = useState<string>(
    () => (awareness.getLocalState()?.name as string | undefined) ?? '',
  );

  function commitName(value: string) {
    setName(value);
    storeName(value);
    awareness.setLocalStateField('name', value);
  }

  return (
    <section className="panel">
      <h2>Peers ({peerStates.length})</h2>
      <div className="row">
        <label>
          Your name:{' '}
          <input
            value={name}
            onChange={(e) => commitName(e.target.value)}
            placeholder="anonymous"
          />
        </label>
      </div>
      {peerStates.length === 0 ? (
        <p className="muted italic">No peers connected yet.</p>
      ) : (
        <ul className="activity">
          {peerStates.map(([clientID, state]) => {
            const isSelf = clientID === awareness.clientID;
            const displayName =
              (state.name as string | undefined)?.trim() || '(anonymous)';
            return (
              <li key={clientID}>
                {displayName}
                {isSelf ? ' (you)' : ''}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function PlaybackPanel({
  room,
  derived,
  media,
}: {
  room: JamboreeRoom;
  derived: DerivedPlaybackState;
  media: MediaCache;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (derived.status !== 'playing') {
      setNow(Date.now());
      return;
    }
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [derived.status, derived.effectiveAtWallMs, derived.queueEntryId]);

  const snap = room.snapshot();
  const currentTrack = derived.trackId ? snap.tracks.get(derived.trackId) : undefined;
  const fileStatus: FileStatus | null =
    currentTrack?.infoHash != null
      ? media.getStatus(currentTrack.infoHash, currentTrack.fileIndex ?? 0)
      : null;
  const blobUrl = fileStatus?.kind === 'ready' ? fileStatus.blobUrl : null;

  // Slave the audio element to the room's playback intent. We re-anchor on
  // every change to sourceIntentId — that captures play/pause/seek/select
  // without us having to special-case each kind. Drift correction during
  // steady-state playback is deferred (DESIGN §15.6).
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    // Pause/stop must run even when blobUrl is null — a Stop intent clears
    // derived.trackId, which nulls out blobUrl, but the audio element may
    // still hold a buffered blob from before. Don't short-circuit.
    if (derived.status !== 'playing') {
      audio.pause();
      if (derived.status === 'stopped') audio.currentTime = 0;
      setAutoplayBlocked(false);
      return;
    }

    if (!blobUrl) return; // playing but media not ready yet — useEffect will re-fire when blobUrl arrives
    const expectedSec = currentPositionMs(derived, Date.now()) / 1000;
    if (Math.abs(audio.currentTime - expectedSec) > 0.5) {
      audio.currentTime = expectedSec;
    }
    const p = audio.play();
    if (p && typeof p.then === 'function') {
      p.then(() => {
        setAutoplayBlocked(false);
        setAudioError(null);
      }).catch((err: Error) => {
        // NotAllowedError = autoplay block; other errors = decode/source issues.
        if (err && err.name === 'NotAllowedError') {
          setAutoplayBlocked(true);
          setAudioError(null);
        } else {
          setAutoplayBlocked(false);
          setAudioError(`${err?.name ?? 'Error'}: ${err?.message ?? String(err)}`);
        }
      });
    }
  }, [
    blobUrl,
    derived.status,
    derived.sourceIntentId,
    derived.queueEntryId,
    derived.trackId,
  ]);

  function manuallyResume() {
    const audio = audioRef.current;
    if (!audio) return;
    void audio.play().then(() => setAutoplayBlocked(false));
  }

  // Browsers tie media autoplay to a user-activation token that exists only
  // synchronously inside the click handler. Our flow normally goes
  // click → room.play() → Yjs update → re-render → useEffect → audio.play(),
  // which crosses an async boundary and loses activation. Calling play()
  // here, in the gesture, "unlocks" the element for subsequent programmatic
  // plays (including ones triggered by remote peers' play intents).
  function gestureUnlock() {
    const audio = audioRef.current;
    if (!audio || !audio.src) return;
    void audio.play().catch(() => {
      // No src yet, or browser still refused — useEffect path will retry
      // and surface autoplayBlocked if it also fails.
    });
  }

  function onPlay() {
    gestureUnlock();
    room.play();
  }
  function onPause() {
    room.pause();
  }
  function onSkipNext() {
    gestureUnlock();
    room.skipNext();
  }
  function onSkipPrevious() {
    gestureUnlock();
    room.skipPrevious();
  }
  function onSelectViaSeek(targetMs: number) {
    gestureUnlock();
    room.seek(targetMs);
  }

  const positionMs = currentPositionMs(derived, now);

  return (
    <section className="panel">
      <h2>Playback</h2>
      <div className="now-playing">
        <div>
          Status: <strong>{derived.status}</strong>
        </div>
        <div>
          Track: <strong>{currentTrack?.title ?? '—'}</strong>
        </div>
        <div>Position: {formatMs(positionMs)}</div>
        {currentTrack && fileStatus && (
          <div className="muted small">{describeStatus(fileStatus)}</div>
        )}
      </div>
      {/* Hidden — playback is driven by the room's intent state, surfaced
          via the buttons below. The element still emits errors, which we
          surface in the panel. */}
      <audio
        ref={audioRef}
        src={blobUrl ?? undefined}
        preload="auto"
        onError={() => {
          const err = audioRef.current?.error;
          setAudioError(
            err ? `media error code ${err.code}: ${err.message}` : 'media error',
          );
        }}
      />
      {autoplayBlocked && (
        <p className="muted small">
          Browser blocked autoplay.{' '}
          <button className="compact" onClick={manuallyResume}>
            Click to play
          </button>
        </p>
      )}
      {audioError && (
        <p className="small" style={{ color: 'crimson' }}>{audioError}</p>
      )}
      <div className="row">
        <button onClick={onSkipPrevious}>Previous</button>
        {derived.status === 'playing' ? (
          <button onClick={onPause}>Pause</button>
        ) : (
          <button onClick={onPlay}>Play</button>
        )}
        <button onClick={onSkipNext}>Next</button>
        <button onClick={() => room.stop()}>Stop</button>
        <button onClick={() => onSelectViaSeek(Math.max(0, positionMs - 10_000))}>
          -10s
        </button>
        <button onClick={() => onSelectViaSeek(positionMs + 30_000)}>+30s</button>
      </div>
    </section>
  );
}

function describeStatus(s: FileStatus): string {
  switch (s.kind) {
    case 'unknown':
      return 'Not in cache';
    case 'pending':
      return `Fetching metadata · ${s.numPeers} ${peerWord(s.numPeers)}`;
    case 'downloading':
      return `${(s.progress * 100).toFixed(0)}% · ${s.numPeers} ${peerWord(s.numPeers)}`;
    case 'materializing':
      return 'Buffering…';
    case 'ready':
      return `Ready · ${s.numPeers} ${peerWord(s.numPeers)}`;
  }
}

function statusBadgeClass(s: FileStatus): string {
  switch (s.kind) {
    case 'ready':
      return 'badge ok';
    case 'materializing':
    case 'downloading':
    case 'pending':
      return 'badge busy';
    case 'unknown':
      return 'badge';
  }
}

function peerWord(n: number): string {
  return n === 1 ? 'peer' : 'peers';
}

function QueuePanel({
  room,
  derived,
  media,
}: {
  room: JamboreeRoom;
  derived: DerivedPlaybackState;
  media: MediaCache;
}) {
  const snap = room.snapshot();

  return (
    <section className="panel">
      <h2>Queue ({snap.queue.length})</h2>
      {snap.queue.length === 0 ? (
        <p className="muted italic">Queue is empty. Drop an audio file above.</p>
      ) : (
        <ol className="queue">
          {snap.queue.map((entry, idx) => {
            const meta = snap.tracks.get(entry.trackId);
            const isCurrent = entry.entryId === derived.queueEntryId;
            const status =
              meta?.infoHash != null
                ? media.getStatus(meta.infoHash, meta.fileIndex ?? 0)
                : null;
            return (
              <li
                key={entry.entryId}
                className={`queue-row${isCurrent ? ' current' : ''}`}
              >
                <div className="queue-meta">
                  <div className="queue-title">
                    <strong>{meta?.title ?? '(missing)'}</strong>
                  </div>
                  <div className="queue-sub muted small">
                    {shortPeer(entry.addedByPeerId)}
                    {status && (
                      <>
                        {' · '}
                        <span className={statusBadgeClass(status)}>
                          {describeStatus(status)}
                        </span>
                      </>
                    )}
                  </div>
                </div>
                <div className="queue-actions">
                  <button
                    className="compact"
                    onClick={() => room.selectEntry(entry.entryId)}
                  >
                    Select
                  </button>
                  <button
                    className="compact"
                    disabled={idx === 0}
                    onClick={() => room.moveQueueEntry(entry.entryId, idx - 1)}
                  >
                    Up
                  </button>
                  <button
                    className="compact"
                    disabled={idx === snap.queue.length - 1}
                    onClick={() => room.moveQueueEntry(entry.entryId, idx + 1)}
                  >
                    Down
                  </button>
                  <button
                    className="compact"
                    onClick={() => room.removeQueueEntry(entry.entryId)}
                  >
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function IngestPanel({ room, media }: { room: JamboreeRoom; media: MediaCache }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [magnet, setMagnet] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  async function ingestFiles(files: File[]) {
    if (files.length === 0) return;
    setError(null);
    for (const file of files) {
      setBusy(`Hashing ${file.name}…`);
      try {
        const info = await media.seedFile(file);
        room.addAndEnqueue({
          title: file.name,
          sourceKind: 'magnet',
          mime: file.type || info.mime,
          sizeBytes: info.sizeBytes,
          magnetURI: info.magnetURI,
          infoHash: info.infoHash,
          fileName: info.fileName,
          fileIndex: info.fileIndex,
        });
      } catch (e) {
        setError(`Failed to seed ${file.name}: ${describeError(e)}`);
      }
    }
    setBusy(null);
  }

  async function ingestMagnet() {
    const m = magnet.trim();
    if (!m) return;
    setError(null);
    setBusy('Fetching torrent metadata…');
    try {
      const info = await media.addMagnet(m);
      room.addAndEnqueue({
        title: info.fileName,
        sourceKind: 'magnet',
        mime: info.mime,
        sizeBytes: info.sizeBytes,
        magnetURI: info.magnetURI,
        infoHash: info.infoHash,
        fileName: info.fileName,
        fileIndex: info.fileIndex,
      });
      setMagnet('');
    } catch (e) {
      setError(`Failed to add magnet: ${describeError(e)}`);
    } finally {
      setBusy(null);
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    void ingestFiles(files);
  }

  return (
    <section className="panel">
      <h2>Add tracks</h2>
      <div
        className={`dropzone${dragOver ? ' dragover' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click();
        }}
      >
        Drop audio files here, or click to choose.
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*"
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            void ingestFiles(files);
            e.target.value = '';
          }}
        />
      </div>
      <div className="row">
        <input
          type="text"
          placeholder="magnet:?xt=urn:btih:…"
          value={magnet}
          onChange={(e) => setMagnet(e.target.value)}
          style={{ flex: 1, minWidth: '12rem' }}
        />
        <button onClick={() => void ingestMagnet()} disabled={!magnet.trim()}>
          Add magnet
        </button>
      </div>
      {busy && <p className="muted small">{busy}</p>}
      {error && <p className="small" style={{ color: 'crimson' }}>{error}</p>}
    </section>
  );
}

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function ActivityPanel({ room }: { room: JamboreeRoom }) {
  const items = room.activity().slice(-12).reverse();
  if (items.length === 0) return null;
  return (
    <section className="panel">
      <h2>Activity</h2>
      <ul className="activity">
        {items.map((item) => (
          <li key={item.id}>{describeActivity(item)}</li>
        ))}
      </ul>
    </section>
  );
}

function describeActivity(item: ActivityRecord): string {
  const who = shortPeer(item.peerId);
  switch (item.kind) {
    case 'track-added':
      return `${who} added a track`;
    case 'queue-added':
      return `${who} enqueued a track`;
    case 'queue-removed':
      return `${who} removed an entry`;
    case 'queue-moved':
      return `${who} moved an entry`;
    case 'play':
      return `${who} pressed play`;
    case 'pause':
      return `${who} paused`;
    case 'seek':
      return `${who} seeked to ${formatMs(item.positionMs ?? 0)}`;
    case 'select-entry':
      return `${who} selected an entry`;
    case 'skip-next':
      return `${who} skipped to next`;
    case 'skip-previous':
      return `${who} skipped to previous`;
    case 'stop':
      return `${who} stopped playback`;
  }
}

function formatMs(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(s / 60)
    .toString()
    .padStart(2, '0');
  const ss = (s % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
}

function shortPeer(peerId: string): string {
  return peerId.length > 12 ? `${peerId.slice(0, 12)}…` : peerId;
}
