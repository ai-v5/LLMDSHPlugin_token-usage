/**
 * Stat-only change detection for the on-disk Session corpus.
 *
 * The Host's `sessionQuery.listSessions()` reports identity and liveness but no
 * artifact timestamp, so a Session written by another Host process looks idle
 * even while its log keeps growing. Reading every log to find that out is what
 * made one scan cover only the newest slice of a large corpus, so this module
 * answers the cheap question instead: which Session artifacts changed?
 *
 * A missing or unrecognised store simply yields `undefined`, and the caller
 * keeps its previous refresh rule.
 */
import { readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

/** Canonical Session log names carry a format generation: `session[.vN].jsonl[.zstd]`. */
const SESSION_LOG = /^session(?:\.[a-z0-9]+)?\.jsonl(?:\.zstd)?$/i

/** Project directory -> Session directory -> log; deeper trees are not Session storage. */
const DEFAULT_MAX_DEPTH = 4

/** One directory batch per level keeps a wide corpus from opening every handle at once. */
const DIRECTORY_BATCH = 32

/** File stats are small and independent, so a wider batch shortens the walk. */
const STAT_BATCH = 64

/**
 * Read the newest Session artifact stamp for every stored Session.
 *
 * @param root - absolute Session storage directory (`<dsh home>/sessions`).
 * @param options - optional traversal bounds.
 * @returns `SessionId -> { size, mtimeMs }`, or `undefined` when the root holds no recognisable log.
 */
export async function readSessionStamps(root, options = {}) {
  if (typeof root !== 'string' || root.length === 0) return undefined
  const maxDepth = Number.isSafeInteger(options.maxDepth) && options.maxDepth >= 0
    ? options.maxDepth
    : DEFAULT_MAX_DEPTH
  const stamps = new Map()
  const directories = [{ path: root, depth: 0 }]
  const files = []
  while (directories.length > 0) {
    const batch = directories.splice(0, DIRECTORY_BATCH)
    const listings = await Promise.all(batch.map(async (directory) => {
      try {
        return { directory, entries: await readdir(directory.path, { withFileTypes: true }) }
      } catch {
        return { directory, entries: undefined }
      }
    }))
    for (const { directory, entries } of listings) {
      if (entries === undefined) continue
      for (const entry of entries) {
        const path = join(directory.path, entry.name)
        if (entry.isDirectory()) {
          if (directory.depth < maxDepth) directories.push({ path, depth: directory.depth + 1 })
          continue
        }
        if (!entry.isFile() || !SESSION_LOG.test(entry.name)) continue
        files.push({ sessionId: basename(directory.path), path })
      }
    }
  }
  for (let index = 0; index < files.length; index += STAT_BATCH) {
    const batch = files.slice(index, index + STAT_BATCH)
    const measured = await Promise.all(batch.map(async (file) => {
      try {
        const info = await stat(file.path)
        return { ...file, size: info.size, mtimeMs: info.mtimeMs }
      } catch {
        return undefined
      }
    }))
    for (const file of measured) {
      if (file === undefined) continue
      const previous = stamps.get(file.sessionId)
      // One Session directory may hold several retained generation logs.
      if (previous === undefined || file.mtimeMs >= previous.mtimeMs) {
        stamps.set(file.sessionId, { size: file.size, mtimeMs: file.mtimeMs })
      }
    }
  }
  return stamps.size === 0 ? undefined : stamps
}
