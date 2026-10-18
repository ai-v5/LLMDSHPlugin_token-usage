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
    }
  }
  return { version: VERSION, sessions: entries }
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

  async function load() {
    if (sessions !== null) return sessions
    if (loading !== null) return loading
    loading = (async () => {
      let raw
      try {
        raw = await readFile(filePath, 'utf8')
      } catch (error) {
        if (error?.code === 'ENOENT') {
          sessions = new Map()
          return sessions
        }
        throw error
      }
      try {
        const parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object' || parsed.version !== VERSION
          || parsed.sessions === null || typeof parsed.sessions !== 'object') {
          throw new Error('invalid token-usage ledger')
        }
        sessions = new Map()
        for (const [id, value] of Object.entries(parsed.sessions)) {
          const entry = decodeEntry(value)
          if (entry !== null) sessions.set(id, entry)
        }
        return sessions
      } catch (error) {
        // Keep the unreadable file for recovery; a later save starts a fresh ledger.
        const backup = `${filePath}.corrupt-${Date.now()}`
        try { await rename(filePath, backup) } catch { /* leave the original in place */ }
        sessions = new Map()
        return sessions
      }
    })()
    return loading
  }

  async function save(next) {
    sessions = new Map(next)
    const task = writes.then(async () => {
      await mkdir(dirname(filePath), { recursive: true })
      const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`
      await writeFile(temporary, JSON.stringify(encode(sessions)), 'utf8')
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
