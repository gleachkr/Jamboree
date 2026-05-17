import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
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
import { getPref, rememberRoom, setPref } from './core/persistence.ts';
import type {
  ActivityRecord,
  Batch,
  DerivedPlaybackState,
  QueueEntry,
  QueueEntryId,
  TrackMeta,
} from './core/types.ts';

// localStorage stores a synchronous mirror of the display name so first paint
// doesn't flash an empty input. IndexedDB is the durable home (DESIGN.md §10).
const NAME_STORAGE_KEY = 'jamboree:name';
const NAME_PREF_KEY = 'displayName';

function readInviteFromBrowser(): RoomInvite | null {
  return parseInviteFromParts(window.location.pathname, window.location.hash);
}

function appBaseUrl(): string {
  return new URL(import.meta.env.BASE_URL, window.location.origin).toString();
}

function loadCachedName(): string {
  try {
    return localStorage.getItem(NAME_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function persistName(value: string): void {
  try {
    localStorage.setItem(NAME_STORAGE_KEY, value);
  } catch {
    // ignore quota / private mode failures
  }
  void setPref(NAME_PREF_KEY, value);
}

type ShareInviteResult = 'shared' | 'copied' | 'cancelled' | 'failed';
type ShareInviteState = Exclude<ShareInviteResult, 'cancelled'> | 'idle';

async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall through to the textarea fallback below.
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.append(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
}

function isShareCancellation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'AbortError'
  );
}

async function shareInviteUrl(url: string): Promise<ShareInviteResult> {
  const shareData: ShareData = {
    title: 'Jamboree room',
    text: 'Join my Jamboree room.',
    url,
  };

  if (navigator.share && navigator.canShare?.(shareData) !== false) {
    try {
      await navigator.share(shareData);
      return 'shared';
    } catch (error) {
      if (isShareCancellation(error)) return 'cancelled';
      // If the native share sheet is unavailable or rejects the payload,
      // retain the older clipboard behavior as a fallback.
    }
  }

  return (await copyText(url)) ? 'copied' : 'failed';
}

function useOnline(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
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

type AppTab = 'player' | 'room';

function Room({ invite }: { invite: RoomInvite }) {
  const [state, setState] = useState<RoomState | null>(null);
  const [, force] = useReducer((x: number) => x + 1, 0);

  useEffect(() => {
    const room = new JamboreeRoom();
    const awareness = new Awareness(room.doc);
    awareness.setLocalState({
      peerId: room.peerId,
      name: loadCachedName(),
      clientKind: 'browser',
    });
    // Hydrate the durable name from IDB and bump the recent-rooms list. Both
    // are best-effort: failures (Node test env, private mode, etc.) are
    // silently swallowed in persistence.ts.
    void (async () => {
      const stored = await getPref<string>(NAME_PREF_KEY);
      if (typeof stored === 'string' && stored.length > 0) {
        awareness.setLocalStateField('name', stored);
        try {
          localStorage.setItem(NAME_STORAGE_KEY, stored);
        } catch {
          // ignore
        }
      }
      void rememberRoom(invite.roomId);
    })();
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
  const online = useOnline();
  const [activeTab, setActiveTab] = useState<AppTab>('player');
  const upload = useTrackIngest(room, media);
  const viewportDragOver = useViewportFileDrop(upload.ingestFiles);
  const [shareState, setShareState] = useState<ShareInviteState>('idle');

  async function shareInvite() {
    setShareState('idle');
    const result = await shareInviteUrl(inviteUrl);
    if (result === 'cancelled') return;
    setShareState(result);
    window.setTimeout(() => setShareState('idle'), 1600);
  }

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
    <main className="app-shell">
      <input
        ref={upload.fileInputRef}
        type="file"
        accept="audio/*"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          void upload.ingestFiles(files);
          e.target.value = '';
        }}
      />
      {viewportDragOver && (
        <div className="drop-overlay" aria-live="polite">
          <div className="drop-overlay-message">Drop audio to add it</div>
        </div>
      )}

      <header className="app-nav">
        <div className="brand" aria-label="Jamboree">
          <span className="brand-full">Jamboree</span>
          <span className="brand-icon" aria-hidden="true">[J]</span>
        </div>
        <TabNav
          activeTab={activeTab}
          online={online}
          remotePeerCount={remotePeerCount}
          onChange={setActiveTab}
        />
        <button
          type="button"
          className="share-link"
          onClick={shareInvite}
          aria-label="Share room link"
        >
          {shareState === 'shared'
            ? 'shared'
            : shareState === 'copied'
              ? 'copied'
              : shareState === 'failed'
                ? 'share failed'
                : 'share'}
        </button>
      </header>
      {!online && (
        <p className="offline-banner small">
          You're offline. Jamboree rooms need active network peers — reconnect
          to join others.
        </p>
      )}

      {/* Keep playback mounted while the Room tab is shown. The hidden audio
          element, media warmup effects, Media Session handlers, and ended
          handler are all owned by PlaybackPanel, so unmounting it would stop
          local playback and detach playback side effects. */}
      <div hidden={activeTab !== 'player'}>
        <PlaybackPanel
          room={room}
          derived={derived}
          media={media}
          audioRef={audioRef}
          gestureUnlock={gestureUnlock}
        />
      </div>

      {activeTab === 'player' && (
        <QueuePanel
          room={room}
          derived={derived}
          media={media}
          gestureUnlock={gestureUnlock}
          onUploadClick={upload.openFilePicker}
          uploadBusy={upload.busy}
          uploadError={upload.error}
        />
      )}

      {activeTab === 'room' && (
        <>
          <PeersPanel awareness={awareness} peerStates={peerStates} />
          <ActivityPanel room={room} />
        </>
      )}
    </main>
  );
}

function batchIdsFingerprint(batches: ReadonlyMap<string, Batch>): string {
  const ids = Array.from(batches.keys()).sort();
  return ids.join('|');
}

function TabNav({
  activeTab,
  online,
  remotePeerCount,
  onChange,
}: {
  activeTab: AppTab;
  online: boolean;
  remotePeerCount: number;
  onChange: (tab: AppTab) => void;
}) {
  const tabs: Array<{ id: AppTab; label: string; meta?: string }> = [
    { id: 'player', label: 'Player' },
    {
      id: 'room',
      label: 'Room',
      meta: online
        ? `${remotePeerCount} ${peerWord(remotePeerCount)}`
        : 'offline',
    },
  ];
  return (
    <nav className="tab-nav" role="tablist" aria-label="Room sections">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className={`tab-button${activeTab === tab.id ? ' active' : ''}`}
          role="tab"
          aria-selected={activeTab === tab.id}
          onClick={() => onChange(tab.id)}
        >
          <span>{tab.label}</span>
          {tab.meta && <span className="tab-meta">{tab.meta}</span>}
        </button>
      ))}
    </nav>
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
    persistName(value);
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

type TransportIconName =
  | 'next'
  | 'pause'
  | 'play'
  | 'previous'
  | 'seekBack'
  | 'seekForward'
  | 'stop';

function TransportIcon({ name }: { name: TransportIconName }) {
  return (
    <svg
      aria-hidden="true"
      className="transport-icon"
      fill="none"
      viewBox="0 0 24 24"
    >
      {name === 'previous' && (
        <>
          <path d="M6 5v14" />
          <path d="m18 6-9 6 9 6V6Z" />
        </>
      )}
      {name === 'next' && (
        <>
          <path d="M18 5v14" />
          <path d="m6 6 9 6-9 6V6Z" />
        </>
      )}
      {name === 'play' && <path d="m8 5 11 7-11 7V5Z" />}
      {name === 'pause' && (
        <>
          <path d="M8 5v14" />
          <path d="M16 5v14" />
        </>
      )}
      {name === 'stop' && <path d="M7 7h10v10H7z" />}
      {name === 'seekBack' && (
        <>
          <path d="M9 7H5v4" />
          <path d="M5 11a7 7 0 1 0 2-5" />
        </>
      )}
      {name === 'seekForward' && (
        <>
          <path d="M15 7h4v4" />
          <path d="M19 11a7 7 0 1 1-2-5" />
        </>
      )}
    </svg>
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
  const [audioDurationMs, setAudioDurationMs] = useState<number | null>(null);

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
  const totalDurationMs = currentTrack?.durationMs ?? audioDurationMs;

  // Resolve the next not-ready queue entry/track for serial warmup. Only one
  // non-active file is prefetched at LOW priority at a time; once it is
  // ready, the scan skips it and keeps moving around the queue.
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

  useEffect(() => {
    setAudioDurationMs(null);
  }, [currentTrack?.id, playUrl]);

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

  // Media Session API: surface metadata + transport controls to the OS so
  // headset buttons, lock-screen widgets, and system tray controls all drive
  // the same room intent log as the in-page buttons. Per DESIGN.md §10 we
  // only register where supported and route every action through the room
  // command layer — no special-cased authority.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    if (currentTrack) {
      try {
        ms.metadata = new MediaMetadata({
          title: currentTrack.title || 'Jamboree',
          artist: currentTrack.artist ?? '',
          album: currentTrack.album ?? '',
        });
      } catch {
        // Some embedded WebViews construct MediaMetadata lazily.
      }
    } else {
      ms.metadata = null;
    }
    ms.playbackState =
      derived.status === 'playing'
        ? 'playing'
        : derived.status === 'paused'
          ? 'paused'
          : 'none';
  }, [
    currentTrack?.id,
    currentTrack?.title,
    currentTrack?.artist,
    currentTrack?.album,
    derived.status,
  ]);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const audio = audioRef.current;
    if (typeof ms.setPositionState !== 'function') return;
    if (!audio || derived.status === 'stopped' || !currentTrack) {
      try { ms.setPositionState({}); } catch { /* ignore */ }
      return;
    }
    const duration = ((currentTrack.durationMs ?? audioDurationMs) ?? 0) / 1000;
    try {
      ms.setPositionState({
        duration: duration > 0 ? duration : 0,
        position: Math.max(0, audio.currentTime),
        playbackRate: audio.playbackRate || 1,
      });
    } catch {
      // Spec rejects negative/NaN values; treat as best-effort.
    }
  }, [
    derived.status,
    derived.queueEntryId,
    derived.sourceIntentId,
    currentTrack?.id,
    currentTrack?.durationMs,
    audioDurationMs,
  ]);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    type Entry = [MediaSessionAction, MediaSessionActionHandler];
    const audio = audioRef.current;
    const handlers: Entry[] = [
      ['play', () => room.play()],
      ['pause', () => room.pause()],
      ['nexttrack', () => room.skipNext()],
      ['previoustrack', () => room.skipPrevious()],
      ['stop', () => room.stop()],
      ['seekto', (details) => {
        if (typeof details.seekTime !== 'number') return;
        room.seek(details.seekTime * 1000);
      }],
      ['seekbackward', (details) => {
        const delta = (details.seekOffset ?? 10) * 1000;
        const current = audio ? audio.currentTime * 1000 : 0;
        room.seek(Math.max(0, current - delta));
      }],
      ['seekforward', (details) => {
        const delta = (details.seekOffset ?? 30) * 1000;
        const current = audio ? audio.currentTime * 1000 : 0;
        room.seek(current + delta);
      }],
    ];
    const registered: MediaSessionAction[] = [];
    for (const [action, handler] of handlers) {
      try {
        ms.setActionHandler(action, handler);
        registered.push(action);
      } catch {
        // Browser does not support this action — skip cleanly.
      }
    }
    return () => {
      for (const action of registered) {
        try { ms.setActionHandler(action, null); } catch { /* ignore */ }
      }
    };
  }, [room, audioRef]);

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
  function syncAudioDuration() {
    const duration = audioRef.current?.duration;
    setAudioDurationMs(
      typeof duration === 'number' && Number.isFinite(duration)
        ? duration * 1000
        : null,
    );
  }

  // Read position straight off the audio element when possible. Before the
  // media element has metadata, fall back to the pure playback reducer so the
  // displayed timer still reflects room intent without writing to Yjs.
  const audioEl = audioRef.current;
  const positionMs =
    audioEl && audioEl.readyState >= 1 && derived.status !== 'stopped'
      ? audioEl.currentTime * 1000
      : null;
  const displayPositionMs = currentTrack
    ? positionMs ?? currentPositionMs(derived, Date.now())
    : 0;
  const progressPct = totalDurationMs
    ? Math.max(0, Math.min(100, (displayPositionMs / totalDurationMs) * 100))
    : 0;
  const canSeek = Boolean(currentTrack) && derived.status !== 'stopped';

  return (
    <section className="panel playback-panel">
      <div className="player-details">
        <div className="player-meta">
          <span className="status-chip">{derived.status}</span>
          <h2>{currentTrack?.title ?? 'No track selected'}</h2>
          {currentTrack && fileStatus && (
            <div className="muted small">{describeStatus(fileStatus)}</div>
          )}
        </div>
        <div className="time-row" aria-label="Playback time">
          <span>{formatMs(displayPositionMs)}</span>
          <span>{totalDurationMs ? formatMs(totalDurationMs) : '—:—'}</span>
        </div>
        <div className="playback-meter" aria-hidden="true">
          <div className="playback-meter-fill" style={{ width: `${progressPct}%` }} />
        </div>
        {bufferProgress !== null && <BufferBar progress={bufferProgress} />}
      </div>
      {/* Hidden — playback is driven by the room's intent state, surfaced
          via the buttons below. The element still emits errors, which we
          surface in the panel. */}
      <audio
        ref={audioRef}
        src={playUrl ?? undefined}
        preload="auto"
        onLoadedMetadata={syncAudioDuration}
        onDurationChange={syncAudioDuration}
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
      {audioError && <p className="error-text small">{audioError}</p>}
      <div className="transport-controls" aria-label="Playback controls">
        <button
          type="button"
          className="icon-button"
          onClick={onSkipPrevious}
          aria-label="Previous track"
          title="Previous track"
        >
          <TransportIcon name="previous" />
        </button>
        {derived.status === 'playing' ? (
          <button
            type="button"
            className="icon-button primary"
            onClick={onPause}
            aria-label="Pause"
            title="Pause"
          >
            <TransportIcon name="pause" />
          </button>
        ) : (
          <button
            type="button"
            className="icon-button primary"
            onClick={onPlay}
            aria-label="Play"
            title="Play"
          >
            <TransportIcon name="play" />
          </button>
        )}
        <button
          type="button"
          className="icon-button"
          onClick={onSkipNext}
          aria-label="Next track"
          title="Next track"
        >
          <TransportIcon name="next" />
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={() => room.stop()}
          aria-label="Stop"
          title="Stop"
        >
          <TransportIcon name="stop" />
        </button>
        <button
          type="button"
          className="icon-button small-icon"
          disabled={!canSeek}
          onClick={() => onSelectViaSeek(Math.max(0, displayPositionMs - 10_000))}
          aria-label="Seek back 10 seconds"
          title="Seek back 10 seconds"
        >
          <TransportIcon name="seekBack" />
          <span>10</span>
        </button>
        <button
          type="button"
          className="icon-button small-icon"
          disabled={!canSeek}
          onClick={() => onSelectViaSeek(displayPositionMs + 30_000)}
          aria-label="Seek forward 30 seconds"
          title="Seek forward 30 seconds"
        >
          <span>30</span>
          <TransportIcon name="seekForward" />
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
  onUploadClick,
  uploadBusy,
  uploadError,
}: {
  room: JamboreeRoom;
  derived: DerivedPlaybackState;
  media: MediaCache;
  gestureUnlock: () => void;
  onUploadClick: () => void;
  uploadBusy: string | null;
  uploadError: string | null;
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
    <section className="panel queue-panel">
      {snap.queue.length === 0 ? (
        <p className="muted italic">
          Queue is empty. Drop audio anywhere in the window to add tracks.
        </p>
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
      <div className="queue-upload-footer">
        <button
          type="button"
          className="upload-link"
          onClick={onUploadClick}
          disabled={uploadBusy !== null}
        >
          + upload
        </button>
        {uploadBusy && <span className="muted small">{uploadBusy}</span>}
        {uploadError && <span className="error-text small">{uploadError}</span>}
      </div>
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
          {isCurrent && <span className="current-marker" aria-hidden="true" />}
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

function useTrackIngest(room: JamboreeRoom, media: MediaCache) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Whole-drop ingestion: every file the user drops in a single gesture
  // becomes one Batch in the doc. Receivers only request chunks for whichever
  // file is selected as current/upcoming.
  const ingestFiles = useCallback(async (rawFiles: File[]) => {
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
  }, [media, room]);

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  return { busy, error, fileInputRef, ingestFiles, openFilePicker };
}

function useViewportFileDrop(ingestFiles: (files: File[]) => void | Promise<void>) {
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    let depth = 0;

    function onDragEnter(e: DragEvent) {
      if (!eventHasFiles(e)) return;
      e.preventDefault();
      depth += 1;
      setDragOver(true);
    }

    function onDragOver(e: DragEvent) {
      if (!eventHasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      setDragOver(true);
    }

    function onDragLeave(e: DragEvent) {
      if (!eventHasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragOver(false);
    }

    function onDrop(e: DragEvent) {
      if (!eventHasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragOver(false);
      void ingestFiles(Array.from(e.dataTransfer?.files ?? []));
    }

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [ingestFiles]);

  return dragOver;
}

function eventHasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
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
  return (
    <section className="panel">
      <h2>Activity</h2>
      {items.length === 0 ? (
        <p className="muted italic">No room events yet.</p>
      ) : (
        <ul className="activity">
          {items.map((item) => (
            <li key={item.id}>{describeActivity(item)}</li>
          ))}
        </ul>
      )}
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
