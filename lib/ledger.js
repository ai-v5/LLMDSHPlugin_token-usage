/** Durable per-Session token ledger so archived sessions keep contributing. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isCount } from './stats.js'

const VERSION = 1
const BUCKET_KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']

/** Decode one stored bucket record; malformed records are dropped. */
function decodeBuckets(value) {
  if (value === null || typeof value !== 'object') return null
  const buckets = {}
  for (const key of BUCKET_KEYS) {
    if (!isCount(value[key])) return null
    buckets[key] = value[key]
  }
  return buckets
}

/** Decode one stored Session entry; malformed entries are dropped. */
function decodeEntry(value) {
  if (value === null || typeof value !== 'object'
    || value.days === null || typeof value.days !== 'object') return null
  const days = new Map()
  for (const [day, raw] of Object.entries(value.days)) {
    const buckets = decodeBuckets(raw)
    if (buckets !== null) days.set(day, buckets)
  }
  return {
    days,
    turnCount: isCount(value.turnCount) ? value.turnCount : 0,
    stepCount: isCount(value.stepCount) ? value.stepCount : 0,
    generationMs: isCount(value.generationMs) ? value.generationMs : 0,
    timedOutputTokens: isCount(value.timedOutputTokens) ? value.timedOutputTokens : 0,
    live: value.live !== false,
    updatedAt: isCount(value.updatedAt) ? value.updatedAt : 0,
  }
}

/** Encode the in-memory Session map for disk. */
function encode(sessions) {
  const entries = {}
  for (const [id, entry] of sessions) {
    if (typeof id !== 'string' || id.length === 0) continue
    entries[id] = {
      days: Object.fromEntries(entry.days),
      turnCount: entry.turnCount,
      stepCount: entry.stepCount,
      generationMs: entry.generationMs,
      timedOutputTokens: entry.timedOutputTokens,
      live: entry.live === true,
      updatedAt: entry.updatedAt ?? 0,
    }
  }
  return { version: VERSION, sessions: entries }
}

/**
 * Union two Session maps, keeping the more recently written entry per id.
 * A tie keeps `incoming`, because it came from the scan that just finished.
 */
function mergeByRecency(onDisk, incoming) {
  const merged = new Map(onDisk)
  for (const [id, entry] of incoming) {
    const existing = merged.get(id)
    if (existing === undefined || (entry.updatedAt ?? 0) >= (existing.updatedAt ?? 0)) {
      merged.set(id, entry)
    }
  }
  return merged
}

/**
 * Create a durable per-Session ledger at one file path.
 * The ledger keeps entries for Sessions absent from the latest scan,
 * which is what preserves history after archive or deletion.
 *
 * @param filePath - absolute ledger JSON path.
 */
export function createSessionLedger(filePath) {
  let sessions = null
  let loading = null
  let writes = Promise.resolve()

  /** Read the file as it is now; unreadable files are set aside rather than trusted. */
  async function readFromDisk() {
    let raw
    try {
      raw = await readFile(filePath, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return new Map()
      throw error
    }
    try {
      const parsed = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object' || parsed.version !== VERSION
        || parsed.sessions === null || typeof parsed.sessions !== 'object') {
        throw new Error('invalid token-usage ledger')
      }
      const map = new Map()
      for (const [id, value] of Object.entries(parsed.sessions)) {
        const entry = decodeEntry(value)
        if (entry !== null) map.set(id, entry)
      }
      return map
    } catch {
      // Keep the unreadable file for recovery; the next save starts a fresh ledger.
      const backup = `${filePath}.corrupt-${Date.now()}`
      try { await rename(filePath, backup) } catch { /* leave the original in place */ }
      return new Map()
    }
  }

  async function load() {
    if (sessions !== null) return sessions
    if (loading !== null) return loading
    loading = readFromDisk().then((map) => {
      sessions = map
      return sessions
    })
    return loading
  }

  async function save(next) {
    const task = writes.then(async () => {
      // Another Host may have written since this one loaded: merge instead of overwriting.
      let onDisk = new Map()
      try {
        onDisk = await readFromDisk()
      } catch { /* a missing or unreadable file leaves the incoming map authoritative */ }
      const merged = mergeByRecency(onDisk, next)
      sessions = merged
      await mkdir(dirname(filePath), { recursive: true })
      const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`
      await writeFile(temporary, JSON.stringify(encode(merged)), 'utf8')
      await rename(temporary, filePath)
    })
    writes = task.catch(() => {})
    return task
  }

  return {
    filePath,
    /** Load and validate the ledger once, returning a detached map. */
    async load() { return new Map(await load()) },
    /** Persist the full merged Session map atomically. */
    async save(next) { await save(next) },
  }
}
