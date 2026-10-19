/**
 * Component: Verified File Placement (copy into the library and prove it landed)
 * Documentation: documentation/phase3/file-organization.md
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { copyFile, filesEqual, isSameFile, PARTIAL_FILE_PATTERN, partialNameHash, sameLeadingBytes } from './copy-file';
import type { PlacementStatus } from './import-inventory';

const STALE_PARTIAL_MS = 24 * 60 * 60 * 1000;

/** Allowed difference between a tagged copy's duration and its original's. */
export const TAGGED_DURATION_TOLERANCE_MS = 1000;

export interface PlaceOptions {
  fileMode: number;
  /** Compare same-size existing targets byte-for-byte (only worth it when a delete depends on the answer). */
  compareExisting: boolean;
}

export interface PlaceResult {
  status: PlacementStatus;
  /** Path the content lives at (an existing Plex-coerced .m4b counts as the target). */
  target: string;
  reason?: string;
}

/**
 * Remove leftover partial files in `dir`: those for this target name, and any
 * older than 24 h. Only regular files matching the exact partial pattern in
 * that one folder are touched.
 */
export async function removeStalePartials(dir: string, targetName: string): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const hash = partialNameHash(targetName);
  const now = Date.now();
  for (const entry of entries) {
    const match = PARTIAL_FILE_PATTERN.exec(entry.name);
    if (!match || !entry.isFile()) continue;
    const full = path.join(dir, entry.name);
    try {
      const stat = await fs.lstat(full);
      if (!stat.isFile()) continue;
      if (match[1] === hash || now - stat.mtimeMs > STALE_PARTIAL_MS) {
        await fs.unlink(full);
      }
    } catch {
      // Raced with another cleanup
    }
  }
}

/** Existing library entry for `target`, including the .m4b name Plex format coercion renames .mp4/.m4a to. */
async function findExistingTarget(target: string): Promise<string | null> {
  const candidates = [target];
  const ext = path.extname(target).toLowerCase();
  if (ext === '.mp4' || ext === '.m4a') {
    candidates.push(path.join(path.dirname(target), `${path.basename(target, path.extname(target))}.m4b`));
  }
  for (const candidate of candidates) {
    try {
      await fs.lstat(candidate);
      return candidate;
    } catch {
      // Not there
    }
  }
  return null;
}

async function copyInto(source: string, target: string, fileMode: number): Promise<PlaceResult> {
  try {
    await copyFile(source, target);
    await fs.chmod(target, fileMode).catch(() => undefined);
    return { status: 'copied', target };
  } catch (error) {
    return { status: 'failed', target, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Place `source` at `target`.
 *
 * Existing targets are never trusted by name alone:
 * - not a regular file (symlink, directory, ...): `differs`, never overwritten
 * - same regular file as the source (hard links fine): `identical`
 * - smaller and a byte-prefix of the source (interrupted copy): re-copied
 * - same size: `identical` / `differs` by content when compareExisting, else `present`
 * - anything else: `differs`, never overwritten
 */
export async function placeFile(source: string, target: string, options: PlaceOptions): Promise<PlaceResult> {
  await removeStalePartials(path.dirname(target), path.basename(target));

  const existing = await findExistingTarget(target);
  if (!existing) {
    return copyInto(source, target, options.fileMode);
  }

  let targetStat;
  let sourceStat;
  try {
    targetStat = await fs.lstat(existing);
    sourceStat = await fs.stat(source);
  } catch (error) {
    return { status: 'failed', target: existing, reason: error instanceof Error ? error.message : String(error) };
  }

  if (!targetStat.isFile()) {
    return { status: 'differs', target: existing, reason: 'existing target is not a regular file' };
  }
  if (await isSameFile(source, existing)) {
    return { status: 'identical', target: existing };
  }

  try {
    if (targetStat.size < sourceStat.size) {
      if (await sameLeadingBytes(existing, source, targetStat.size)) {
        // Only an interrupted copy of this exact source leaves a byte-prefix behind
        return copyInto(source, existing, options.fileMode);
      }
      return { status: 'differs', target: existing, reason: 'existing target is smaller and not a prefix of the source' };
    }
    if (targetStat.size === sourceStat.size) {
      if (!options.compareExisting) {
        return { status: 'present', target: existing };
      }
      return (await filesEqual(existing, source))
        ? { status: 'identical', target: existing }
        : { status: 'differs', target: existing, reason: 'existing target has different content' };
    }
    return { status: 'differs', target: existing, reason: 'existing target is larger than the source' };
  } catch (error) {
    return { status: 'failed', target: existing, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** True when `status` means the content is proven to be at the target. */
export function isVerifiedStatus(status: PlacementStatus): boolean {
  return status === 'copied' || status === 'identical';
}

// =========================================================================
// AUDIO PLACEMENT (original or tagged derivative)
// =========================================================================

export interface AudioPlaceOptions extends PlaceOptions {
  /** Duration in ms; throws or returns <= 0 when the file cannot be probed. */
  probeDuration: (filePath: string) => Promise<number>;
}

export interface AudioPlacement extends PlaceResult {
  verified: boolean;
  /** True when the library holds the tagged derivative rather than the original bytes. */
  usedDerivative: boolean;
}

async function durationsMatch(original: string, placed: string, probe: (p: string) => Promise<number>): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([probe(original), probe(placed)]);
    return a > 0 && b > 0 && Math.abs(a - b) <= TAGGED_DURATION_TOLERANCE_MS;
  } catch {
    return false;
  }
}

async function placeOriginal(original: string, target: string, options: PlaceOptions): Promise<AudioPlacement> {
  const result = await placeFile(original, target, options);
  return { ...result, verified: isVerifiedStatus(result.status), usedDerivative: false };
}

/**
 * Place one audio source. A tagged derivative is preferred, but it only counts
 * as verified when the placed file's duration matches the original's within
 * TAGGED_DURATION_TOLERANCE_MS; otherwise the original is placed untagged
 * (byte-checked by the copy). A derivative that cannot be placed, or an
 * existing target that differs from it, falls back to the original too.
 */
export async function placeAudio(
  original: string,
  derivative: string | undefined,
  target: string,
  options: AudioPlaceOptions
): Promise<AudioPlacement> {
  if (!derivative) {
    return placeOriginal(original, target, options);
  }

  const tagged = await placeFile(derivative, target, options);
  if (tagged.status === 'failed' || tagged.status === 'differs') {
    const fallback = await placeOriginal(original, target, options);
    return {
      ...fallback,
      reason: fallback.status === 'copied'
        ? `Tagged copy failed (${tagged.reason}); original placed without metadata tags`
        : fallback.reason ?? tagged.reason,
    };
  }

  if (await durationsMatch(original, tagged.target, options.probeDuration)) {
    return { ...tagged, verified: isVerifiedStatus(tagged.status), usedDerivative: true };
  }

  if (tagged.status === 'present') {
    // Not ours to overwrite: unknown content of the right size
    return { ...tagged, verified: false, usedDerivative: false, reason: 'existing target could not be verified' };
  }

  // The tagged bytes we placed (or that a previous run placed) are suspect: use the original
  const replaced = await copyInto(original, tagged.target, options.fileMode);
  return {
    ...replaced,
    verified: replaced.status === 'copied',
    usedDerivative: false,
    reason: replaced.reason ?? 'tagged copy duration did not match the original; original placed untagged',
  };
}
