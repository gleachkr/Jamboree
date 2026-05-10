# Jamboree Design: Peer-Equal CRDT Rooms with Yjs

Status: revised design, replacing the earlier host/controller-oriented room model.

Jamboree is an ephemeral, friends-only, peer-to-peer listening room. A room is created by sharing an invite URL. Everyone who joins with the room secret is an equal peer. There is no privileged host, no permanent room database, and no central authority for playlist state. The shared queue and playback coordination are represented as a Yjs CRDT document; media bytes are distributed with WebTorrent; browser/CLI peers join through public rendezvous infrastructure, initially Trystero over Nostr.

This document assumes the product name **Jamboree**, with canonical CLI `jamboree` and optional shortcut `jam`.

## 1. Design goals

Jamboree should feel like a spontaneous living-room music session. The system should support friends joining a temporary room, adding tracks, editing the queue concurrently, and controlling playback without requiring one designated leader.

The architecture should preserve these properties:

- **Peer equality.** Every connected user can add, reorder, remove, play, pause, and seek, subject only to optional room policy settings stored in the shared document.
- **Ephemerality.** A room exists because peers are present. If everyone leaves and no peer persists the room locally, it disappears.
- **URL-first sharing.** A room is joined from a link such as `https://jamboree.app/r/quiet-moon#key=...`.
- **Capability security.** Possession of the URL fragment secret is the room capability. The server hosting the static app should not receive the room secret.
- **Client-side first.** The browser app is the primary experience. The CLI is a peer, seeder, player, and optional local control daemon.
- **No central playlist backend.** Public infrastructure may be used for rendezvous, but room state should be peer-owned.
- **Graceful imperfection.** Playback sync should be good enough for shared listening, not a fragile attempt at sample-accurate synchronization.

## 2. Core architecture

Jamboree consists of four layers:

1. **Static web/PWA shell.** Hosts the app, manifest, icons, service worker, and UI. It does not store room state.
2. **Rendezvous and peer connection.** Uses Trystero, initially with the Nostr strategy, to discover peers and establish WebRTC connections. Trystero exists to solve WebRTC signaling; app data flows peer-to-peer after connections are established. Trystero supports multiple rendezvous strategies, including Nostr, BitTorrent, MQTT, Supabase, Firebase, IPFS, and self-hosted WebSocket relay. See: <https://github.com/dmotz/trystero>.
3. **CRDT state.** Uses a Yjs `Y.Doc` as the authoritative room state. Yjs exposes shared types such as maps and arrays that can be mutated concurrently and merged without conventional merge conflicts. See: <https://docs.yjs.dev/> and <https://github.com/yjs/yjs>.
4. **Media transport and playback.** Uses WebTorrent to distribute immutable media blobs and stream them in browsers and Node. WebTorrent is a streaming torrent client for Node.js and the web, with browser usage requiring WebRTC support. See: <https://webtorrent.io/docs>.

The room state is not “messages from a host.” It is a replicated document. UI actions mutate the Yjs document locally; Yjs updates propagate to peers; every peer derives the same queue and playback state from the converged document.

## 3. Invite and room identity

A room invite has two parts:

```text
https://jamboree.app/r/<room-id>#key=<secret>
```

The `room-id` may be human-readable or random. It is public routing material and should not be treated as secret. The `key` is high-entropy random material encoded in the URL fragment. URL fragments are handled client-side and are not sent in the HTTP request for the page.

The room secret is used for three things:

- Trystero room password or equivalent strategy-level authentication, when available.
- Deriving application-layer encryption keys for CRDT update payloads.
- Deriving opaque room or friend tokens if later features need them.

For MVP, possession of the room secret is sufficient to mutate the room. There is no account system and no per-user ACL.

## 4. Yjs room document model

The room is represented by a single `Y.Doc`.

Suggested top-level shape:

```ts
interface JamboreeDocShape {
  meta: Y.Map<unknown>
  peers: AwarenessStateOnly
  tracks: Y.Map<Y.Map<unknown>>
  queue: Y.Array<string>
  playbackIntents: Y.Array<PlaybackIntent>
  chat: Y.Array<ChatMessage>
  settings: Y.Map<unknown>
  snapshots: Y.Array<PlaybackSnapshot>
}
```

In actual Yjs code:

```ts
const doc = new Y.Doc()

const meta = doc.getMap('meta')
const tracks = doc.getMap<Y.Map<unknown>>('tracks')
const queue = doc.getArray<string>('queue')
const playbackIntents = doc.getArray<PlaybackIntent>('playbackIntents')
const chat = doc.getArray<ChatMessage>('chat')
const settings = doc.getMap('settings')
const snapshots = doc.getArray<PlaybackSnapshot>('snapshots')
```

### 4.1 `meta`

Room metadata. Example keys:

```ts
meta.set('schemaVersion', 1)
meta.set('createdAt', Date.now())
meta.set('roomName', 'quiet moon')
meta.set('createdByPeerId', peerId)
```

`createdByPeerId` is informative only. It does not grant authority.

### 4.2 `tracks`

A map from stable track ID to track metadata.

```ts
type TrackId = string

type TrackMeta = {
  id: TrackId
  title: string
  artist?: string
  album?: string
  durationMs?: number
  mime?: string
  sizeBytes?: number
  magnetURI: string
  fileName?: string
  fileIndex?: number
  infoHash?: string
  addedByPeerId: string
  addedAt: number
  sourceKind: 'local-file' | 'magnet' | 'web-seed' | 'url'
  webSeeds?: string[]
}
```

In Yjs, each track can be stored as a nested `Y.Map`. This allows concurrent metadata edits to merge field-by-field instead of replacing an entire object.

Track IDs should be content-oriented when possible, for example `sha256(infoHash + fileIndex + normalizedFileName)`, but a random UUID is acceptable for MVP if duplicate tracks are tolerable.

### 4.3 `queue`

A `Y.Array<TrackId>` representing the current shared queue order.

All peers may insert, delete, and reorder. Concurrent inserts converge according to Yjs ordering. The UI should make concurrent edits visible and unsurprising rather than pretending that users are editing a locked queue.

Recommended queue operations:

```ts
appendTrack(trackId)
insertTrackAfter(anchorTrackId, trackId)
removeQueueEntry(queueEntryId or index)
moveQueueEntry(entryId, newIndex)
```

For robustness, consider representing queue entries as objects with stable entry IDs rather than bare track IDs:

```ts
type QueueEntry = {
  entryId: string
  trackId: string
  addedByPeerId: string
  addedAt: number
}
```

This permits duplicate tracks in the queue and makes deletion/move operations less ambiguous. The MVP should use `QueueEntry`, not bare track IDs.

### 4.4 `playbackIntents`

Playback should not be stored as a continuously updated “current time” field. That would create write churn and clock fights. Instead, peers append discrete playback intents. Every peer derives the current playback state from the same ordered intent log.

```ts
type PlaybackIntent = {
  id: string
  peerId: string
  kind: 'play' | 'pause' | 'seek' | 'skip-next' | 'skip-previous' | 'select-entry' | 'stop'
  queueEntryId?: string
  positionMs?: number
  createdAtWallMs: number
  localSeq: number
}
```

The winning intent is the last valid intent in the converged Yjs array, after applying deterministic validation. Because concurrent Yjs array insertions converge to a deterministic order, using CRDT order rather than wall-clock order avoids disagreement between peers.

Validation examples:

- A `select-entry` intent is ignored if the queue entry no longer exists.
- A `seek` intent applies to the currently derived entry unless it names an entry explicitly.
- A `skip-next` intent advances from the currently derived entry at the time the peer processes it; the resulting concrete `select-entry` may be appended by that peer to avoid ambiguity.
- A `pause` intent records the derived position at the time it was created.

For MVP, prefer concrete intents over relative intents. For example, the UI button “next” should compute the next queue entry locally and append `select-entry` plus `play`, rather than appending only `skip-next`.

### 4.5 `snapshots` and compaction

The playback intent log should not grow forever. Any peer may append a snapshot:

```ts
type PlaybackSnapshot = {
  id: string
  peerId: string
  createdAtWallMs: number
  supersedesIntentIds: string[]
  state: {
    queueEntryId?: string
    status: 'playing' | 'paused' | 'stopped'
    positionMs: number
    effectiveAtWallMs: number
  }
}
```

Compaction can be conservative in v0. Do not delete old intents until the implementation has tests showing that late-joining peers still converge. For ephemeral rooms, it is acceptable to delay compaction or compact only when the log exceeds a threshold.

### 4.6 Awareness state

Yjs Awareness is for ephemeral presence, not durable room state. Use it for:

- Display name.
- Avatar/color.
- Current selected track in UI.
- Buffering state.
- Whether the peer can seed a given track.
- Playback drift estimate.
- Typing/chat draft status.

Do not use Awareness for the queue, track metadata, or authoritative playback intents, because awareness state is intentionally ephemeral.

Suggested awareness shape:

```ts
type PeerAwareness = {
  peerId: string
  name: string
  clientKind: 'browser' | 'pwa' | 'cli'
  playing?: boolean
  currentQueueEntryId?: string
  currentPositionMs?: number
  bufferedUntilMs?: number
  seedingTrackIds?: string[]
  lastSeenWallMs: number
}
```

## 5. Yjs provider over Trystero

Do not make Trystero room actions the application protocol. Use Trystero as the transport for Yjs sync and awareness updates.

Implement an in-tree provider, tentatively:

```ts
class JamboreeYProvider {
  constructor(opts: {
    doc: Y.Doc
    awareness: Awareness
    room: TrysteroRoom
    crypto: RoomCrypto
  })

  connect(): void
  disconnect(): void
  destroy(): void
}
```

The provider should support:

- Initial state sync when a new peer connects.
- Incremental `Y.update` broadcasting when the local doc changes.
- Awareness update broadcasting.
- Duplicate and out-of-order update handling.
- Optional application-layer encryption using keys derived from the room secret.

Implementation strategy:

1. Use Yjs update APIs directly for MVP: `Y.encodeStateAsUpdate`, `Y.applyUpdate`, and the `doc.on('update')` event.
2. On peer join, exchange state vectors and full or differential updates. If implementing the full y-protocol sync handshake is too much for v0, send a full encoded state update on peer join and rely on incremental updates afterward.
3. Send awareness updates separately using `y-protocols/awareness` or a minimal local equivalent.
4. Normalize binary payloads. If the Trystero strategy supports `ArrayBuffer`/`Uint8Array`, use that. Otherwise, encode as base64.
5. Track provider origin to avoid rebroadcast loops.

There is existing prior art around Yjs over WebRTC and Yjs over Trystero, but the design should keep the provider small and in-tree so the room model remains explicit.

## 6. Media lifecycle

Media bytes remain outside the CRDT document. The document stores references and metadata; WebTorrent moves the bytes.

### 6.1 Adding a local file from the browser

1. User drags an audio file into the room.
2. Browser creates/seeds a WebTorrent torrent for the file.
3. Browser receives the magnet URI/infohash.
4. Browser writes a new `TrackMeta` and `QueueEntry` into the Yjs document in a single transaction.
5. Other peers observe the new queue entry, add the magnet to their WebTorrent client, and begin fetching.

### 6.2 Adding from the CLI

The CLI should be able to add local files or magnets:

```sh
jamboree add ~/Music/foo.mp3 --room 'https://jamboree.app/r/quiet-moon#key=...'
jamboree add 'magnet:?xt=urn:btih:...' --room ...
```

The CLI is just another peer. It mutates the Yjs document and seeds/fetches media with WebTorrent. It does not bypass the CRDT room model.

### 6.3 Playback

Browser peers stream to `<audio>`.

CLI peers should initially delegate playback to `mpv`, using a local stream URL when possible. This avoids building a codec/audio stack.

The CLI must pass the acceptance test: a file added and seeded by a CLI peer can be played by browser peers, and a file added by a browser peer can be played by the CLI. If the chosen Node WebTorrent package cannot reliably reach browser WebRTC peers, the CLI transport choice must be revisited, for example by using a browser-compatible WebTorrent implementation, WebTorrent-hybrid where appropriate, or explicit web-seed fallback.

## 7. Playback synchronization model

Jamboree should not aim for sample-perfect sync. It should aim for stable shared intent.

Each peer derives:

```ts
type DerivedPlaybackState = {
  status: 'playing' | 'paused' | 'stopped'
  queueEntryId?: string
  trackId?: string
  positionMs: number
  effectiveAtWallMs: number
  sourceIntentId?: string
}
```

When an intent says “play entry E at position P at time T,” each peer computes expected current position as:

```ts
expectedPosition = P + (Date.now() - T)
```

Clock skew is acceptable at the level of a friends-only music room. For better behavior, peers can estimate offset using lightweight ping/pong over the data channel, but this is not required for MVP.

Drift policy:

- If local drift is under 1.5 seconds, do nothing.
- If local drift is between 1.5 and 5 seconds, gently seek or adjust on the next natural boundary.
- If local drift exceeds 5 seconds, hard seek.
- If buffering prevents sync, mark the peer as buffering in awareness rather than fighting the global state.

Do not write continuous playback position to Yjs. Write only discrete intents.

## 8. Equal-peer conflict policy

Because all peers are equal, Jamboree should embrace visible convergence rather than pretend conflicts cannot happen.

Examples:

- If Alice and Bob add tracks at the same time, both appear in the queue in the deterministic Yjs order.
- If Alice removes a track while Bob moves it, the remove wins if the queue entry no longer exists after convergence.
- If Alice presses pause while Bob presses play concurrently, the last intent in CRDT order wins.
- If two peers edit a track title concurrently, nested Yjs maps merge at the field level; for the same field, Yjs last-writer behavior applies according to its conflict rules.

The UI should include a small activity feed so users understand what happened: “Alice added X,” “Bob paused,” “Graham moved Y after Z.” The activity feed can be derived from the CRDT operations or represented as its own append-only `Y.Array` if needed.

## 9. PWA layer

Jamboree should be PWA-enhanced but not PWA-dependent.

PWA features:

- `manifest.webmanifest` with icons, app name, theme color, display mode, and start URL.
- Service worker for caching the static app shell.
- Offline fallback page explaining that rooms require online peers.
- IndexedDB persistence for local preferences, recent room names, display name, and optional recent Yjs document snapshots.
- Media Session API integration for play/pause/next/previous controls where supported.

Explicit non-goals:

- Do not treat the service worker as an always-on seeder.
- Do not rely on background WebRTC after the app is closed.
- Do not cache full media blobs by default.
- Do not implement push notifications in the MVP.

The PWA should improve launch and control UX, not change the peer-owned room model.

## 10. CLI design

The CLI is a first-class peer. It should be able to join rooms, seed media, play media, and optionally expose local control interfaces.

Commands:

```sh
jamboree create
jamboree join <invite-url>
jamboree add <file-or-magnet> --room <invite-url>
jamboree play --room <invite-url>
jamboree pause --room <invite-url>
jamboree next --room <invite-url>
jamboree daemon --room <invite-url>
jamboree daemon --room <invite-url> --mpd
```

The daemon mode keeps a peer online while the process runs. It may seed tracks, play through `mpv`, and expose MPD-compatible local control.

The CLI must not become a hidden central authority. All queue and playback changes should be Yjs mutations, just like browser actions.

## 11. In-tree MPD-compatible façade

Jamboree should implement its own narrow MPD-compatible server in-tree. Do not depend on an abandoned or partial JS MPD server library.

The MPD façade is a local compatibility layer over the Jamboree command API. It is not the core protocol. It should bind to `127.0.0.1` by default and should never expose invite secrets through MPD responses.

Command subset for v0:

```text
ping
close
commands
notcommands
status
currentsong
playlistinfo
playlistid
play
playid
pause
stop
next
previous
seek
seekid
seekcur
add
addid
clear
delete
deleteid
move
moveid
idle
noidle
```

MPD protocol notes:

- MPD uses line-based text records over TCP.
- The server greets clients with `OK MPD <version>`.
- Successful command responses end with `OK`.
- Errors use `ACK` responses.
- `idle` blocks until a named subsystem changes; `noidle` cancels it. The MPD docs specify that while a client is waiting for `idle`, no commands other than `noidle` are allowed. See: <https://mpd.readthedocs.io/en/latest/protocol.html>.

MPD-to-Jamboree mapping:

```text
mpc status       -> derived playback state
mpc current      -> derived current track
mpc playlist     -> Yjs queue
mpc play         -> append playback intent
mpc pause        -> append playback intent
mpc next         -> append select-entry/play intent for next queue entry
mpc seekcur      -> append seek intent
idle player      -> wake on playbackIntents/snapshot changes
idle playlist    -> wake on queue/tracks changes
```

Unsupported database/library commands should either return an empty valid response or a clear `ACK`, depending on what common MPD clients tolerate best.

Test against `mpc` and `ncmpcpp`. `mpc` is the command-line client for MPD and is a useful compatibility baseline. See: <https://www.musicpd.org/doc/mpc/html/>.

## 12. Security and privacy

Security model: friends-only by shared secret.

MVP guarantees:

- Static host does not receive the invite secret.
- Peers without the room secret cannot join the room through the intended protocol.
- CRDT update payloads should be encrypted at the application layer if Trystero strategy-level encryption is insufficient or uncertain.
- MPD server binds to localhost by default.
- No room key, invite URL, magnet URI, or local file path appears in logs by default.
- Service worker does not cache invite URLs with fragments, room secrets, or full media blobs.

Non-goals:

- No protection against a friend intentionally resharing the invite.
- No moderation system in MVP.
- No identity recovery.
- No long-term availability after all peers leave.

Optional later improvements:

- Per-peer public keys and signed CRDT-level operations.
- Revocable invite links.
- Read-only/listen-only invites.
- Friend lists and push notifications.
- Backup peers or explicitly configured always-on seed peers.

## 13. Staged implementation plan

### Stage 0: Project skeleton and shared model

Deliverables:

- Monorepo or workspace with `app`, `cli`, and `core` packages.
- Shared TypeScript types for tracks, queue entries, playback intents, derived playback state, and room invites.
- Basic room URL parser/generator.
- Unit tests for invite parsing and key handling.

Acceptance criteria:

- `core` builds independently.
- Browser and CLI can import shared types.
- Invite secret remains in the URL fragment and is not sent in app HTTP requests.

### Stage 1: Local Yjs room model

Deliverables:

- In-memory `Y.Doc` schema.
- Queue operations: add, remove, move.
- Playback intent operations: play, pause, select, seek.
- Derived playback-state reducer.
- Activity feed prototype.

Acceptance criteria:

- Applying concurrent queue edits in different orders converges to the same queue.
- Concurrent playback intents converge to the same derived state.
- Deleting the current queue entry yields a deterministic stopped or next-track state.
- No continuous playback clock writes are made to the Yjs document.

### Stage 2: Trystero-backed Yjs provider

Deliverables:

- `JamboreeYProvider` using Trystero/Nostr.
- Initial state sync on peer join.
- Incremental update propagation.
- Awareness propagation.
- Basic encryption wrapper for provider payloads if needed.

Acceptance criteria:

- Two browser tabs on different profiles/devices converge after concurrent edits.
- A late joiner receives the current queue and playback state.
- Disconnect/reconnect does not duplicate queue entries or corrupt playback state.
- Simulated duplicate and out-of-order updates do not break convergence.

### Stage 3: Browser media MVP

Deliverables:

- Drag/drop local audio files.
- Browser WebTorrent seeding.
- Magnet ingestion.
- Queue rendering.
- `<audio>` playback from WebTorrent file stream.
- Awareness display for peer presence and buffering.

Acceptance criteria:

- Alice adds a local file; Bob sees it, fetches it, and plays it.
- Bob adds a magnet; Alice sees and plays it.
- Removing a queued item updates all peers.
- Browser refresh rejoins the room and receives state from peers still present.

### Stage 4: Equal-peer playback sync

Deliverables:

- Playback intent UI: play, pause, seek, next, previous.
- Derived playback reducer integrated with the audio player.
- Drift detection and correction.
- Buffering awareness.

Acceptance criteria:

- If Alice presses play, Bob starts playback within an acceptable delay.
- If Bob presses pause, Alice pauses after receiving the CRDT update.
- Concurrent play/pause actions converge to one visible result.
- Buffering peers do not continuously overwrite global playback state.

### Stage 5: PWA support

Deliverables:

- Web app manifest.
- Service worker app-shell caching.
- Offline fallback.
- Local preferences in IndexedDB.
- Media Session API integration.

Acceptance criteria:

- App installs on supported desktop/mobile browsers.
- Reloading with network disabled shows the app shell plus a clear “rooms require network peers” message.
- Media controls work where Media Session is supported.
- Service worker does not cache full audio blobs by default.

### Stage 6: CLI peer

Deliverables:

- `jamboree join`.
- `jamboree add` for local files and magnets.
- `jamboree daemon` to stay connected and seed.
- Playback through `mpv` or equivalent external player.

Acceptance criteria:

- CLI joins the same Yjs room as browser peers.
- CLI-added tracks appear in browser queue.
- Browser-added tracks can be played by CLI.
- CLI can remain running as a seeding peer while the browser closes.

### Stage 7: In-tree MPD façade

Deliverables:

- TCP MPD-compatible server bound to localhost.
- Parser and response encoder.
- Supported command subset.
- `idle`/`noidle` support.
- Mapping from MPD commands to Yjs mutations.

Acceptance criteria:

- `mpc status` shows current Jamboree state.
- `mpc playlist` shows the shared queue.
- `mpc current` shows the current track.
- `mpc play`, `pause`, `next`, `previous`, and `seekcur` mutate the Yjs room state.
- `ncmpcpp` connects, displays the queue, and follows playback/playlist changes.
- MPD listener binds only to localhost unless explicitly configured otherwise.

### Stage 8: Hardening and packaging

Deliverables:

- Cross-browser test matrix.
- CLI packaging for npm and/or standalone binaries.
- Better error reporting for failed peer connections and missing media.
- Optional TURN configuration, but disabled by default.
- Privacy/security review.

Acceptance criteria:

- A three-peer room with browser, PWA, and CLI can run for one hour without state divergence.
- Reordering, adding, deleting, and playback controls remain responsive under ordinary packet loss/reconnect conditions.
- Logs do not reveal room secrets or local file paths.
- Documentation clearly states ephemerality and no-background-seeding limitations.

## 14. Testing requirements

### 14.1 CRDT model tests

Use property-style tests where feasible.

Required cases:

- Concurrent appends converge.
- Concurrent insert-after operations converge.
- Concurrent remove/move of the same queue entry converges.
- Playback intents appended concurrently produce the same derived state after sync.
- Snapshot/compaction does not change derived state.
- Late-joining document receiving updates in different orders converges.

### 14.2 Provider tests

Use a fake transport before testing Trystero.

Required cases:

- Duplicate update delivery.
- Out-of-order update delivery.
- Dropped update followed by full resync.
- Peer disconnect during initial sync.
- Awareness update expiry.
- Encrypted payload cannot be decoded with wrong room key.

### 14.3 Browser integration tests

Required cases:

- Two browser contexts join the same room.
- Drag/drop file appears in both queues.
- Playback intent from one peer affects another.
- Refresh while another peer remains online restores current state.
- No invite secret appears in network request URLs.

### 14.4 Media tests

Required cases:

- Browser-to-browser file seeding.
- Browser-to-CLI file seeding.
- CLI-to-browser file seeding.
- Magnet-only track ingestion.
- Missing/slow seeder behavior.
- Unsupported codec behavior.

### 14.5 PWA tests

Required cases:

- Manifest validates.
- App shell loads offline.
- Offline room join produces a helpful error.
- Media Session controls invoke local actions.
- Full media blobs are not cached unless user explicitly opts in.

### 14.6 MPD compatibility tests

Required cases:

- `mpc status`.
- `mpc current`.
- `mpc playlist`.
- `mpc play`, `pause`, `next`, `prev`, `seekcur`.
- `mpc idle player` wakes after playback change.
- `mpc idle playlist` wakes after queue change.
- `ncmpcpp` displays and controls the room at a basic level.
- Unsupported commands fail gracefully.

## 15. Implementation guidelines

### 15.1 Keep CRDT operations semantic

Do not let UI components manipulate Yjs structures directly. Provide a small command layer:

```ts
room.addTrack(fileOrMagnet)
room.enqueueTrack(trackId)
room.moveQueueEntry(entryId, index)
room.removeQueueEntry(entryId)
room.play(entryId, positionMs)
room.pause()
room.seek(positionMs)
```

Each command should perform a Yjs transaction and append any activity record needed for UI feedback.

### 15.2 Keep derived state pure

The playback reducer should be deterministic and side-effect free:

```ts
const state = derivePlaybackState({ tracks, queue, playbackIntents, snapshots }, now)
```

This makes it easy to test convergence and debug client disagreements.

### 15.3 Separate durable CRDT state from ephemeral awareness

If losing the data would break the room, it belongs in Yjs shared types. If losing the data merely removes presence/status information, it belongs in Awareness.

### 15.4 Do not over-sync playback position

Continuous time is local. Shared playback is represented by discrete intents.

### 15.5 Make equal control visible

Because everyone can control the room, the UI should show recent actions and the acting peer. This avoids the feeling that playback is changing mysteriously.

### 15.6 Keep MPD local and narrow

The MPD façade should translate local MPD commands into the same command layer used by the browser and CLI. It should not get special queue state, special playback state, or special authority.

### 15.7 Avoid permanent infrastructure assumptions

The app may use public relays and trackers, but no feature should require Jamboree-owned persistent state until explicitly added. Future push notifications, friend lists, and backup peers should be separate optional services.

## 16. Open questions

1. Should the room allow optional “soft roles,” such as DJ mode or vote-skip, or is pure equality part of the product identity?
2. Should queue entries be tombstoned rather than deleted to make activity history clearer?
3. Should Jamboree persist recent Yjs room snapshots locally in IndexedDB, or should true ephemerality mean leaving no local room state unless opted in?
4. Should application-layer encryption wrap all Yjs updates from the start, or is Trystero password-based protection enough for MVP?
5. How much MPD compatibility is necessary before calling the façade useful?
6. Should the CLI use Bun, Node, or support both? Node is the safer initial target for WebTorrent and MPD compatibility; Bun can be evaluated once the daemon is stable.

## 17. Summary

The CRDT design is a better match for Jamboree than a host/controller model. It makes the product conceptually cleaner: the room is the shared document, every friend is a peer, and conflicts are resolved by the CRDT rather than by social or architectural privilege.

The key implementation decision is to make Yjs the center of the room model and keep everything else as adapters:

- Trystero adapts peer discovery and transport to Yjs updates.
- WebTorrent adapts immutable media blobs to track references in the document.
- The browser/PWA adapts the document to a friendly UI.
- The CLI adapts the same document to terminal playback and seeding.
- The MPD façade adapts local MPD clients to the same command layer.

That gives Jamboree a simple invariant: if you know the room secret and can reach another peer, you can participate as an equal member of the jam.
