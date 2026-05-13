import { useEffect, useReducer, useRef, useState } from 'react';
import { Awareness } from 'y-protocols/awareness';
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
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
import { joinJamboreeRoom } from './core/transport-trystero.ts';
import type { Transport } from './core/transport.ts';
import { nextWarmupFileRef } from './core/warmup.ts';
import type {
  ActivityRecord,
  Batch,
  DerivedPlaybackState,
  QueueEntry,
  QueueEntryId,
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
  transport: Transport;
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
    });
    const provider = new JamboreeYProvider({
      doc: room.doc,
      awareness,
      transport,
    });
    const media = new MediaCache({ transport });
    setState({ room, awareness, provider, media, transport });

    const unsubDoc = room.subscribe(force);
    const unsubMedia = media.subscribe(force);
    const unsubPeers = provider.onPeerChange(force);
    const onAwareness = () => force();
    awareness.on('change', onAwareness);

    return () => {
      unsubDoc();
      unsubMedia();
      unsubPeers();
      awareness.off('change', onAwareness);
      provider.destroy();
      media.destroy();
      transport.destroy();
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
  const { room, awareness, media, provider } = state;
  const inviteUrl = createInviteUrl(invite, appBaseUrl());
  const derived = room.derivedState();
  const snap = room.snapshot();
  const peerStates = Array.from(awareness.getStates().entries());
  const remotePeerCount = provider.getRemotePeers().size;
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Browsers tie media autoplay to a user-activation token that only lives
  // synchronously inside the gesture handler. Most of our user actions go
  // click → room.x() → Yjs update → re-render → useEffect → audio.play(),
  // crossing an async boundary that loses activation. Calling play() inline
  // during the click "unlocks" the element so later programmatic plays
  // (including ones triggered by remote peers' intents) are allowed.
  function gestureUnlock() {
    const audio = audioRef.current;
    if (!audio || !audio.src) return;
    void audio.play().catch(() => {
      // No src yet or browser still refused — useEffect path will retry
      // and surface autoplayBlocked if it also fails.
    });
  }

  // Auto-register any batch metadata we know about with the media mesh.
  // This includes both peers' batches (newly arriving via Yjs sync) and our
  // own after a reload. addBatchFromDoc is idempotent on contentId; receivers
  // don't request bytes until a track in the batch is selected as current or
  // upcoming.
  useEffect(() => {
    for (const batch of snap.batches.values()) {
      void media.addBatchFromDoc({
        contentId: batch.contentId,
        files: batch.files,
      });
    }
  }, [media, batchIdsFingerprint(snap.batches)]);

  return (
    <main>
      <header className="room-header">
        <h1>Jamboree</h1>
        <ConnectionPill remotePeerCount={remotePeerCount} />
      </header>
      <p>
        Room: <strong>{invite.roomId}</strong>
      </p>
      <details>
        <summary>Share link</summary>
        <code>{inviteUrl}</code>
      </details>

      <PeersPanel awareness={awareness} peerStates={peerStates} />
      <PlaybackPanel
        room={room}
        derived={derived}
        media={media}
        audioRef={audioRef}
        gestureUnlock={gestureUnlock}
      />
      <IngestPanel room={room} media={media} />
      <QueuePanel
        room={room}
        derived={derived}
        media={media}
        gestureUnlock={gestureUnlock}
      />
      <ActivityPanel room={room} />
    </main>
  );
}

function batchIdsFingerprint(batches: ReadonlyMap<string, Batch>): string {
  const ids = Array.from(batches.keys()).sort();
  return ids.join('|');
}

function ConnectionPill({ remotePeerCount }: { remotePeerCount: number }) {
  if (remotePeerCount === 0) {
    return (
      <span className="conn-pill conn-pill--searching">
        <span className="conn-dot" />
        Searching for peers…
      </span>
    );
  }
  return (
    <span className="conn-pill conn-pill--connected">
      <span className="conn-dot" />
      Connected · {remotePeerCount} {remotePeerCount === 1 ? 'peer' : 'peers'}
    </span>
  );
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
  audioRef,
  gestureUnlock,
}: {
  room: JamboreeRoom;
  derived: DerivedPlaybackState;
  media: MediaCache;
  audioRef: React.RefObject<HTMLAudioElement | null>;
  gestureUnlock: () => void;
}) {
  const [, tick] = useReducer((x: number) => x + 1, 0);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);

  // Re-render every 250ms while playing so the audio element's currentTime
  // and the buffer-bar progress stay live in the UI. (Position is read
  // directly off the audio element below; we just need a regular tick.)
  useEffect(() => {
    if (derived.status !== 'playing') return;
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [derived.status, derived.effectiveAtWallMs, derived.queueEntryId]);

  const snap = room.snapshot();
  const currentTrack = derived.trackId ? snap.tracks.get(derived.trackId) : undefined;
  const currentBatch = currentTrack ? snap.batches.get(currentTrack.batchId) : undefined;
  const fileStatus: FileStatus | null =
    currentTrack && currentBatch
      ? media.getStatus(currentBatch.contentId, currentTrack.fileIndex)
      : null;
  // The mesh protocol creates a playable object URL only after the selected
  // file is complete. Until then we show download progress and wait.
  const playUrl = fileStatus?.kind === 'ready' ? fileStatus.url : null;
  const bufferProgress =
    fileStatus?.kind === 'downloading' ? fileStatus.progress : null;

  // Resolve the next not-ready queue entry/track for serial warmup. Only one
  // non-active file is prefetched at LOW priority at a time; once it is
  // ready, the scan skips it and moves farther down the upcoming queue.
  const nextRef = nextWarmupFileRef(
    snap,
    derived.queueEntryId,
    (contentId, fileIndex) => media.getStatus(contentId, fileIndex),
  );

  // Tell the MediaCache which file is currently playing (HIGH priority) and
  // which upcoming file is being warmed (LOW priority). Both may be null.
  useEffect(() => {
    media.setActive(
      currentBatch && currentTrack
        ? { contentId: currentBatch.contentId, fileIndex: currentTrack.fileIndex }
        : null,
    );
  }, [media, currentBatch?.contentId, currentTrack?.fileIndex]);

  useEffect(() => {
    media.setUpcoming(nextRef);
  }, [media, nextRef?.contentId, nextRef?.fileIndex]);

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

    if (!playUrl) return; // playing but media not ready yet — useEffect will re-fire when playUrl arrives
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
        // NotAllowedError = autoplay block.
        // AbortError = the browser cancelled this play() because a fresh
        // load() (src change) or pause() arrived right after — exactly what
        // happens on track-switch / stop. Benign; don't surface it.
        if (err && err.name === 'NotAllowedError') {
          setAutoplayBlocked(true);
          setAudioError(null);
        } else if (err && err.name === 'AbortError') {
          setAutoplayBlocked(false);
          setAudioError(null);
        } else {
          setAutoplayBlocked(false);
          setAudioError(`${err?.name ?? 'Error'}: ${err?.message ?? String(err)}`);
        }
      });
    }
  }, [
    playUrl,
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
  function onTrackEnded() {
    if (derived.status !== 'playing' || !derived.queueEntryId) return;
    room.skipNext({ fromEntryId: derived.queueEntryId });
  }
  function onSelectViaSeek(targetMs: number) {
    gestureUnlock();
    room.seek(targetMs);
  }

  // Read position straight off the audio element. We only have meaningful
  // information once metadata has loaded; before that (and once the room
  // intent is 'stopped', which resets currentTime to 0) we surface nothing
  // rather than running an intent-based fake timer.
  const audioEl = audioRef.current;
  const positionMs =
    audioEl && audioEl.readyState >= 1 && derived.status !== 'stopped'
      ? audioEl.currentTime * 1000
      : null;

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
        <div>Position: {positionMs !== null ? formatMs(positionMs) : '—'}</div>
        {currentTrack && fileStatus && (
          <div className="muted small">{describeStatus(fileStatus)}</div>
        )}
        {bufferProgress !== null && (
          <BufferBar progress={bufferProgress} />
        )}
      </div>
      {/* Hidden — playback is driven by the room's intent state, surfaced
          via the buttons below. The element still emits errors, which we
          surface in the panel. */}
      <audio
        ref={audioRef}
        src={playUrl ?? undefined}
        preload="auto"
        onEnded={onTrackEnded}
        onError={() => {
          const err = audioRef.current?.error;
          // MEDIA_ERR_ABORTED (1) fires when src changes mid-fetch — that's
          // a benign side effect of track-switch / stop, not something the
          // user needs to see. Everything else is a real decode/source
          // problem and should surface.
          if (!err || err.code === MediaError.MEDIA_ERR_ABORTED) {
            setAudioError(null);
            return;
          }
          setAudioError(`media error code ${err.code}: ${err.message}`);
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
        <button
          disabled={positionMs === null}
          onClick={() =>
            positionMs !== null &&
            onSelectViaSeek(Math.max(0, positionMs - 10_000))
          }
        >
          -10s
        </button>
        <button
          disabled={positionMs === null}
          onClick={() =>
            positionMs !== null && onSelectViaSeek(positionMs + 30_000)
          }
        >
          +30s
        </button>
      </div>
    </section>
  );
}

function describeStatus(s: FileStatus): string {
  switch (s.kind) {
    case 'unknown':
      return 'Not in cache';
    case 'pending':
      return `Waiting · ${s.numPeers} ${peerWord(s.numPeers)}`;
    case 'downloading':
      // % is shown via the animated <BufferBar/>; the badge stays text-only
      // so it doesn't jump on every chunk.
      return `Downloading · ${s.numPeers} ${peerWord(s.numPeers)}`;
    case 'ready':
      return `Ready · ${s.numPeers} ${peerWord(s.numPeers)}`;
  }
}

function statusBadgeClass(s: FileStatus): string {
  switch (s.kind) {
    case 'ready':
      return 'badge ok';
    case 'downloading':
    case 'pending':
      return 'badge busy';
    case 'unknown':
      return 'badge';
  }
}

function BufferBar({ progress }: { progress: number }) {
  const pct = Math.max(0, Math.min(1, progress)) * 100;
  return (
    <div
      className="buffer-bar"
      role="progressbar"
      aria-label="Buffered"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
    >
      <div className="buffer-bar-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

function peerWord(n: number): string {
  return n === 1 ? 'peer' : 'peers';
}

function QueuePanel({
  room,
  derived,
  media,
  gestureUnlock,
}: {
  room: JamboreeRoom;
  derived: DerivedPlaybackState;
  media: MediaCache;
  gestureUnlock: () => void;
}) {
  // Self-tick every 250ms so queue-row BufferBars animate smoothly even when
  // the upstream media.subscribe → force() chain coalesces or drops updates
  // during piece-arrival bursts. Mirrors PlaybackPanel's setNow interval.
  const [, tick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, []);

  const snap = room.snapshot();

  // PointerSensor with a small distance so a tap doesn't accidentally start
  // a drag — the body itself is the "select" target. TouchSensor uses a
  // delay so scrolling the page still works on mobile; once held, drag is
  // enabled.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 180, tolerance: 8 },
    }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const newIdx = snap.queue.findIndex((e) => e.entryId === over.id);
    if (newIdx < 0) return;
    room.moveQueueEntry(active.id as QueueEntryId, newIdx);
  }

  const ids = snap.queue.map((e) => e.entryId);

  return (
    <section className="panel">
      <h2>Queue ({snap.queue.length})</h2>
      {snap.queue.length === 0 ? (
        <p className="muted italic">Queue is empty. Drop an audio file above.</p>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={onDragEnd}
        >
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            <ol className="queue">
              {snap.queue.map((entry) => {
                const meta = snap.tracks.get(entry.trackId);
                const batch = meta ? snap.batches.get(meta.batchId) : undefined;
                const isCurrent = entry.entryId === derived.queueEntryId;
                const status =
                  batch && meta
                    ? media.getStatus(batch.contentId, meta.fileIndex)
                    : null;
                return (
                  <SortableQueueRow
                    key={entry.entryId}
                    entry={entry}
                    meta={meta}
                    status={status}
                    isCurrent={isCurrent}
                    onSelect={() => {
                      gestureUnlock();
                      room.selectEntry(entry.entryId);
                    }}
                    onRemove={() => room.removeQueueEntry(entry.entryId)}
                  />
                );
              })}
            </ol>
          </SortableContext>
        </DndContext>
      )}
    </section>
  );
}

function SortableQueueRow({
  entry,
  meta,
  status,
  isCurrent,
  onSelect,
  onRemove,
}: {
  entry: QueueEntry;
  meta: TrackMeta | undefined;
  status: FileStatus | null;
  isCurrent: boolean;
  onSelect: () => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: entry.entryId });
  const isReady = status?.kind === 'ready';
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    // Dim rows whose audio isn't ready yet so the eye is drawn to playable
    // tracks. The drag handle and X stay full-strength via .queue-handle /
    // .queue-remove rules so they remain easy to hit.
    opacity: !isReady && !isDragging ? 0.55 : 1,
    zIndex: isDragging ? 1 : undefined,
  };
  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`queue-row${isCurrent ? ' current' : ''}${
        isDragging ? ' dragging' : ''
      }`}
    >
      <button
        type="button"
        className="queue-handle"
        aria-label="Drag to reorder"
        {...attributes}
        {...listeners}
      >
        ⋮⋮
      </button>
      <button
        type="button"
        className="queue-tap"
        onClick={onSelect}
        aria-label={`Select ${meta?.title ?? 'track'}`}
      >
        <div className="queue-title">
          {isCurrent ? '▶ ' : ''}
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
        {status?.kind === 'downloading' && (
          <BufferBar progress={status.progress} />
        )}
      </button>
      <button
        type="button"
        className="queue-remove"
        onClick={onRemove}
        aria-label={`Remove ${meta?.title ?? 'track'}`}
      >
        ×
      </button>
    </li>
  );
}

function IngestPanel({ room, media }: { room: JamboreeRoom; media: MediaCache }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Whole-drop ingestion: every file the user drops in a single gesture
  // becomes one Batch in the doc. Receivers only request chunks for whichever
  // file is selected as current/upcoming.
  async function ingestFiles(rawFiles: File[]) {
    const files = rawFiles.filter(isAudioFile);
    if (files.length === 0) {
      if (rawFiles.length > 0) setError('No audio files in the drop.');
      return;
    }
    setError(null);
    setBusy(
      files.length === 1
        ? `Hashing ${files[0]!.name}…`
        : `Hashing ${files.length} files…`,
    );
    try {
      const seeded = await media.seedBatch(files);
      const trackInputs = seeded.files.map((f, i) => ({
        title: f.name,
        mime: f.mime,
        sizeBytes: f.size,
        fileIndex: i,
      }));
      room.addAndEnqueueBatch(
        {
          contentId: seeded.contentId,
          files: seeded.files,
        },
        trackInputs,
      );
    } catch (e) {
      setError(`Failed to seed batch: ${describeError(e)}`);
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
      {busy && <p className="muted small">{busy}</p>}
      {error && <p className="small" style={{ color: 'crimson' }}>{error}</p>}
    </section>
  );
}

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function isAudioFile(f: File): boolean {
  if (f.type && f.type.startsWith('audio/')) return true;
  // Browsers don't always populate File.type for drag-and-drop. Fall back to
  // an extension sniff so dropped folders work consistently.
  return /\.(mp3|m4a|mp4|aac|flac|ogg|opus|wav|webm)$/i.test(f.name);
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
