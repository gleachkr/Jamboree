import type { FileRef, FileStatus } from './media.ts';
import type {
  Batch,
  QueueEntry,
  QueueEntryId,
  TrackMeta,
} from './types.ts';

type WarmupSnapshot = {
  queue: readonly QueueEntry[];
  tracks: ReadonlyMap<string, TrackMeta>;
  batches: ReadonlyMap<string, Batch>;
};

type WarmupStatus = Pick<FileStatus, 'kind'>;

// Return the next not-yet-ready queue file to warm, scanning forward from the
// current queue entry. When nothing is selected yet, queue[0] is the likely
// first play, so the scan starts there.
//
// This intentionally warms only one non-active file at a time. Once that file
// reaches ready, the next render skips over it and selects the following
// not-ready file. That gives us serial warmup down the upcoming queue without
// diluting the active track's piece priority across many files at once.
export function nextWarmupFileRef(
  snap: WarmupSnapshot,
  currentEntryId: QueueEntryId | undefined,
  getStatus: (infoHash: string, fileIndex: number) => WarmupStatus,
): FileRef | null {
  if (snap.queue.length === 0) return null;

  let startIdx = 0;
  if (currentEntryId) {
    const currentIdx = snap.queue.findIndex(
      (e) => e.entryId === currentEntryId,
    );
    if (currentIdx < 0) return null;
    startIdx = currentIdx + 1;
  }

  for (let i = startIdx; i < snap.queue.length; i += 1) {
    const entry = snap.queue[i]!;
    const meta = snap.tracks.get(entry.trackId);
    if (!meta) continue;
    const batch = snap.batches.get(meta.batchId);
    if (!batch) continue;
    if (getStatus(batch.infoHash, meta.fileIndex).kind === 'ready') continue;
    return { infoHash: batch.infoHash, fileIndex: meta.fileIndex };
  }

  return null;
}
