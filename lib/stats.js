/**
 * Pure per-day token accounting for DSH Session events.
 *
 * The fold mirrors `@deepseek-ai/dsh-token-meter`'s `tokenUsage` projection:
 * every Assistant settlement contributes the last usage sample of its attempt,
 * a retry closes the replacement slot, and a later sample for the same
 * turn/step replaces the earlier one instead of adding to it.
 */

/** Four disjoint provider usage buckets, all non-negative integers. */
export const EMPTY_BUCKETS = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
})

/** @returns {boolean} whether a value is a non-negative safe integer. */
export function isCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** @returns {boolean} whether a value is a provider usage record. */
function isUsage(value) {
  return value !== null && typeof value === 'object'
}

/** The provider usage carried by one assistant settlement, if any. */
export function usageOfEvent(event) {
  if (event === null || typeof event !== 'object') return undefined
  const data = event.data
  if (data === null || typeof data !== 'object') return undefined
  if (event.type === 'assistant/message' && isUsage(data.usage)) return data.usage
  if (event.type === 'compaction/summary' && isUsage(data.usage)) return data.usage
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined
  const stream = data.stream
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const entry = stream[index]
    if (entry !== null && typeof entry === 'object'
      && entry.type === 'chunk' && entry.chunk !== null && typeof entry.chunk === 'object'
      && entry.chunk.type === 'usage' && entry.chunk.usage !== undefined) {
      return entry.chunk.usage
    }
  }
  return undefined
}

/** Normalize one provider usage sample into the four disjoint buckets. */
export function bucketsOfUsage(usage) {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
  }
}

/** A local calendar day key (`YYYY-MM-DD`) for one Unix-epoch millisecond. */
export function localDay(time) {
  const date = new Date(time)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** Add two bucket records. */
export function addBuckets(left, right) {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
  }
}

/** Subtract `right` from `left`, clamping each bucket at zero. */
export function subtractBuckets(left, right) {
  return {
    inputTokens: Math.max(0, left.inputTokens - right.inputTokens),
    outputTokens: Math.max(0, left.outputTokens - right.outputTokens),
    cacheReadTokens: Math.max(0, left.cacheReadTokens - right.cacheReadTokens),
    cacheWriteTokens: Math.max(0, left.cacheWriteTokens - right.cacheWriteTokens),
  }
}

/** Whether two bucket records carry the same values. */
export function equalBuckets(left, right) {
  return left.inputTokens === right.inputTokens
    && left.outputTokens === right.outputTokens
    && left.cacheReadTokens === right.cacheReadTokens
    && left.cacheWriteTokens === right.cacheWriteTokens
}

/** Sum of all four buckets: every provider-billed token, cache reads included. */
export function totalTokens(buckets) {
  return buckets.inputTokens + buckets.outputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens
}

/** Prompt plus completion tokens without cache reads. */
export function inputOutputTokens(buckets) {
  return buckets.inputTokens + buckets.outputTokens
}

/**
 * Elapsed time represented by one compact Assistant stream.
 * Packed delta records carry `time0` plus `dt` gaps; raw chunks carry `time`.
 *
 * @param {readonly any[]} stream - durable stream records from one model settlement.
 * @returns {number} milliseconds between the first and last recorded chunk, or 0.
 */
export function streamDurationMs(stream) {
  if (!Array.isArray(stream)) return 0
  let first = Infinity
  let last = -Infinity
  for (const record of stream) {
    if (record === null || typeof record !== 'object') continue
    if (typeof record.time === 'number' && Number.isFinite(record.time)) {
      first = Math.min(first, record.time)
      last = Math.max(last, record.time)
      continue
    }
    if (typeof record.time0 !== 'number' || !Number.isFinite(record.time0)) continue
    let end = record.time0
    if (Array.isArray(record.dt)) {
      for (const gap of record.dt) {
        if (typeof gap === 'number' && Number.isFinite(gap) && gap >= 0) end += gap
      }
    }
    first = Math.min(first, record.time0)
    last = Math.max(last, end)
  }
  return last > first ? last - first : 0
}

/**
 * Fold one Session's raw event log into per-day buckets.
 *
 * @param {readonly any[]} events - the complete replay-validated raw log.
 * @param {number} inheritedEventCount - fork-inherited prefix to exclude.
 * @param {(time: number) => string} dayOf - event time to local day key.
 * @returns {{ days: Map<string, any>, usageEvents: number, turnCount: number, stepCount: number, generationMs: number, timedOutputTokens: number }}
 */
export function foldSessionEvents(events, inheritedEventCount = 0, dayOf = localDay) {
  const days = new Map()
  const seenCompactions = new Set()
  let usageEvents = 0
  let turnCount = 0
  let stepCount = 0
  let generationMs = 0
  let timedOutputTokens = 0
  let last
  const start = Math.max(0, Math.trunc(inheritedEventCount) || 0)
  for (let index = start; index < events.length; index += 1) {
    const event = events[index]
    if (event === null || typeof event !== 'object' || typeof event.type !== 'string') continue
    if (event.type === 'turn/start') {
      turnCount += 1
      continue
    }
    if (event.type === 'step/start') {
      stepCount += 1
      continue
    }
    if (event.type === 'llm/retry-started') {
      const data = event.data
      if (last !== undefined && data !== null && typeof data === 'object'
        && last.turn === data.turn && last.step === data.step) {
        last = undefined
      }
      continue
    }
    if (event.type === 'compaction/summary') {
      const data = event.data
      const usage = data?.usage
      if (!isUsage(usage) || !isCount(usage.inputTokens) || !isCount(usage.outputTokens)) continue
      const compactionId = data?.compactionId
      if (compactionId !== undefined) {
        if (seenCompactions.has(compactionId)) continue
        seenCompactions.add(compactionId)
      }
      const buckets = bucketsOfUsage(usage)
      if (totalTokens(buckets) === 0) continue
      if (typeof event.time !== 'number' || !Number.isFinite(event.time)) continue
      const key = dayOf(event.time)
      days.set(key, addBuckets(days.get(key) ?? EMPTY_BUCKETS, buckets))
      usageEvents += 1
      continue
    }
    const usage = usageOfEvent(event)
    if (usage === undefined) continue
    if (!isCount(usage.inputTokens) || !isCount(usage.outputTokens)) continue
    if (usage.cacheReadTokens !== undefined && !isCount(usage.cacheReadTokens)) continue
    if (usage.cacheWriteTokens !== undefined && !isCount(usage.cacheWriteTokens)) continue
    const data = event.data
    const turn = data.turn
    const step = data.step
    const buckets = bucketsOfUsage(usage)
    const streamMs = streamDurationMs(data.stream)
    const sampleGenerationMs = buckets.outputTokens > 0 ? streamMs : 0
    const sampleTimedOutput = sampleGenerationMs > 0 ? buckets.outputTokens : 0
    if (typeof event.time !== 'number' || !Number.isFinite(event.time)) continue
    const key = dayOf(event.time)
    const previous = last !== undefined && last.turn === turn && last.step === step
      ? last
      : undefined
    if (previous !== undefined && equalBuckets(previous.buckets, buckets)) continue
    if (previous !== undefined) {
      const remaining = subtractBuckets(
        days.get(previous.day) ?? EMPTY_BUCKETS,
        previous.buckets,
      )
      if (totalTokens(remaining) === 0) days.delete(previous.day)
      else days.set(previous.day, remaining)
      generationMs = Math.max(0, generationMs - previous.generationMs)
      timedOutputTokens = Math.max(0, timedOutputTokens - previous.timedOutputTokens)
    }
    days.set(key, addBuckets(days.get(key) ?? EMPTY_BUCKETS, buckets))
    generationMs += sampleGenerationMs
    timedOutputTokens += sampleTimedOutput
    usageEvents += 1
    last = {
      turn,
      step,
      buckets,
      day: key,
      generationMs: sampleGenerationMs,
      timedOutputTokens: sampleTimedOutput,
    }
  }
  return { days, usageEvents, turnCount, stepCount, generationMs, timedOutputTokens }
}

/** Clamp a requested history length to 1..366 days (default 30). */
export function normalizeDays(value) {
  const parsed = typeof value === 'string' && /^\d+$/.test(value.trim())
    ? Number(value.trim())
    : value
  if (!Number.isSafeInteger(parsed)) return 30
  return Math.min(366, Math.max(1, parsed))
}

/** A range is either a bounded day count or the complete history. */
export function normalizeRange(value) {
  if (typeof value === 'string' && value.trim().toLowerCase() === 'all') return 'all'
  return normalizeDays(value)
}

/** Local calendar day keys for the inclusive range ending today. */
export function rangeDayKeys(now, days) {
  const end = new Date(now)
  const keys = []
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(end.getFullYear(), end.getMonth(), end.getDate() - offset)
    keys.push(localDay(date.getTime()))
  }
  return keys
}

/** Shape one bucket record for the wire, with derived totals. */
export function describeBuckets(buckets) {
  return {
    inputTokens: buckets.inputTokens,
    outputTokens: buckets.outputTokens,
    cacheReadTokens: buckets.cacheReadTokens,
    cacheWriteTokens: buckets.cacheWriteTokens,
    totalTokens: totalTokens(buckets),
    inputOutputTokens: inputOutputTokens(buckets),
  }
}

/** Build the wire result from folded daily data. */
export function buildStats({
  daily,
  sessionsByDay,
  days,
  now,
  sessionCount,
  skippedSessions,
  pendingSessions = 0,
  staleSessions = 0,
  refreshed = 0,
  incomplete,
  turnCount = 0,
  stepCount = 0,
  generationMs = 0,
  timedOutputTokens = 0,
}) {
  const todayKey = localDay(now)
  const allKeys = [...daily.keys()].filter(key => key <= todayKey).sort()
  let allTime = EMPTY_BUCKETS
  for (const [key, buckets] of daily) {
    if (key <= todayKey) allTime = addBuckets(allTime, buckets)
  }
  const rangeKind = days === 'all' ? 'all' : 'days'
  let keys
  let totals
  if (rangeKind === 'all') {
    keys = allKeys.slice(-365)
    if (keys[keys.length - 1] !== todayKey) keys.push(todayKey)
    totals = allTime
  } else {
    keys = rangeDayKeys(now, days)
    const keyset = new Set(keys)
    totals = EMPTY_BUCKETS
    for (const [key, buckets] of daily) {
      if (keyset.has(key)) totals = addBuckets(totals, buckets)
    }
  }
  const series = keys.map((date) => {
    const buckets = daily.get(date) ?? EMPTY_BUCKETS
    return {
      date,
      ...describeBuckets(buckets),
      sessions: sessionsByDay.get(date)?.size ?? 0,
    }
  })
  const today = series[series.length - 1] ?? {
    date: keys[keys.length - 1] ?? todayKey,
    ...describeBuckets(EMPTY_BUCKETS),
    sessions: 0,
  }
  return {
    generatedAt: now,
    days: rangeKind === 'all' ? keys.length : days,
    rangeKind,
    seriesTruncated: rangeKind === 'all' && allKeys.length > 0 && allKeys[0] < keys[0],
    range: { from: keys[0] ?? today.date, to: today.date },
    today,
    totals: describeBuckets(totals),
    allTime: describeBuckets(allTime),
    series,
    sessionCount,
    skippedSessions,
    pendingSessions,
    staleSessions,
    refreshed,
    incomplete,
    activity: {
      turns: turnCount,
      steps: stepCount,
      generationMs,
      timedOutputTokens,
      tokensPerSecond: generationMs > 0 ? timedOutputTokens / (generationMs / 1000) : 0,
    },
  }
}

/** Fold one Session result into the ledger entry shape. */
function sessionEntryOf(folded, live, updatedAt, stamp) {
  return {
    days: folded.days,
    turnCount: folded.turnCount,
    stepCount: folded.stepCount,
    generationMs: folded.generationMs,
    timedOutputTokens: folded.timedOutputTokens,
    live,
    updatedAt,
    ...(stamp === undefined ? {} : { size: stamp.size, mtimeMs: stamp.mtimeMs }),
  }
}

/**
 * Decide whether one listed Session must be read again.
 *
 * A live Session can grow in this process, a Session absent from the ledger was
 * never counted, and a Session whose artifact changed since the last read may
 * have been written by another Host. Everything else is reused as is.
 *
 * @returns `'read'`, `'reuse'`, or `'adopt'` for a legacy entry that may keep its
 *   numbers and only take the stamp of the artifact it was read from.
 */
function refreshDecision(live, known, stamp, hasStamps) {
  if (known === undefined) return 'read'
  if (live) return 'read'
  // Without stamps the artifact cannot be compared, so keep the old rule.
  if (!hasStamps || stamp === undefined) return known.live === false ? 'reuse' : 'read'
  if (known.size === undefined || known.mtimeMs === undefined) {
    // A ledger written before stamps existed still holds the numbers read at
    // `updatedAt`; the artifact only needs a read when it moved after that.
    return stamp.mtimeMs > (known.updatedAt ?? 0) ? 'read' : 'adopt'
  }
  return stamp.size === known.size && stamp.mtimeMs === known.mtimeMs ? 'reuse' : 'read'
}

/**
 * Window that makes a Session "hot": something probably wrote it moments ago, so
 * it is worth reading before the settled history.
 */
const HOT_WINDOW_MS = 15 * 60_000

/** Artifact time that orders one pending item, falling back to its creation time. */
function modifiedOf(item) {
  const mtime = item.stamp?.mtimeMs
  return typeof mtime === 'number' && Number.isFinite(mtime) ? mtime : item.createdAt ?? 0
}

/**
 * Read order for one scan: live Sessions, then the hot tail newest first, then
 * the settled backlog oldest first.
 *
 * A newest-first queue spends every budget on the same head, so once a corpus
 * carries more changed Sessions than one scan can read, the same slice is
 * re-planned forever and the tail never runs. Oldest first makes the frontier
 * advance monotonically, because a Session leaves the pending set as soon as it
 * is read and a fresh arrival can only join the back of the queue.
 */
function compareRefreshOrder(left, right, now) {
  if (left.live !== right.live) return left.live ? -1 : 1
  const hotBoundary = now - HOT_WINDOW_MS
  const leftModified = modifiedOf(left)
  const rightModified = modifiedOf(right)
  const leftHot = leftModified >= hotBoundary
  const rightHot = rightModified >= hotBoundary
  if (leftHot !== rightHot) return leftHot ? -1 : 1
  if (leftModified !== rightModified) {
    return leftHot ? rightModified - leftModified : leftModified - rightModified
  }
  if (left.createdAt !== right.createdAt) {
    return leftHot ? right.createdAt - left.createdAt : left.createdAt - right.createdAt
  }
  return left.sessionId.localeCompare(right.sessionId)
}

/**
 * Build the read plan for one scan.
 *
 * @param records - `listSessions()` records for the whole logical corpus.
 * @param previousSessions - retained ledger entries.
 * @param sessionStamps - artifact stamps by Session id, or `undefined` when change detection is unavailable.
 * @param options - `now` for the hot window, and `deferred` ids a previous read failed on.
 * @returns `{ pending, retained, changed }`: Sessions to read in priority order,
 *   the ledger map to aggregate (legacy entries pick up their stamp here), and
 *   whether anything about the ledger moved enough to be worth writing back.
 */
export function planSessionReads(records, previousSessions, sessionStamps, options = {}) {
  const hasStamps = sessionStamps !== undefined
  const now = options.now ?? Date.now()
  const deferred = options.deferred
  const pending = []
  const retained = new Map(previousSessions)
  let changed = false
  for (const record of records) {
    const sessionId = record.header.id
    // A Session whose read just failed keeps its retained numbers and stops
    // holding a worker; the next pass after the deferral retries it.
    if (deferred !== undefined && deferred.has(sessionId)) continue
    const known = previousSessions.get(sessionId)
    const live = record.live !== false
    const stamp = hasStamps ? sessionStamps.get(sessionId) : undefined
    const decision = refreshDecision(live, known, stamp, hasStamps)
    if (decision === 'read') {
      pending.push({ sessionId, live, stamp, createdAt: record.header.createdAt ?? 0 })
      changed = true
      continue
    }
    if (decision === 'adopt') {
      retained.set(sessionId, { ...known, size: stamp.size, mtimeMs: stamp.mtimeMs })
      changed = true
    }
  }
  pending.sort((left, right) => compareRefreshOrder(left, right, now))
  return { pending, retained, changed }
}

/**
 * Retained Sessions whose log moved after the numbers were read.
 *
 * These are the entries the panel can only show from the past: the scan never
 * managed to refresh them (timeout, failure, or deferral), so a total built from
 * them is quietly older than the corpus.
 */
function countStaleSessions(records, retained, liveSessions, sessionStamps) {
  if (sessionStamps === undefined) return 0
  let stale = 0
  for (const record of records) {
    const sessionId = record.header.id
    if (liveSessions.has(sessionId)) continue
    const entry = retained.get(sessionId)
    if (entry === undefined || entry.size === undefined || entry.mtimeMs === undefined) continue
    const stamp = sessionStamps.get(sessionId)
    if (stamp === undefined) continue
    if (stamp.size !== entry.size || stamp.mtimeMs !== entry.mtimeMs) stale += 1
  }
  return stale
}

/**
 * Merge live Session entries over the retained ledger and aggregate all history.
 * Entries absent from the live scan belong to archived or deleted sessions and are kept.
 */
export function aggregateSessionUsage(previousSessions, liveSessions) {
  const sessions = new Map(previousSessions)
  for (const [id, entry] of liveSessions) sessions.set(id, entry)
  const daily = new Map()
  const sessionsByDay = new Map()
  let turnCount = 0
  let stepCount = 0
  let generationMs = 0
  let timedOutputTokens = 0
  for (const [id, entry] of sessions) {
    for (const [key, buckets] of entry.days) {
      daily.set(key, addBuckets(daily.get(key) ?? EMPTY_BUCKETS, buckets))
      const ids = sessionsByDay.get(key) ?? new Set()
      ids.add(id)
      sessionsByDay.set(key, ids)
    }
    turnCount += entry.turnCount
    stepCount += entry.stepCount
    generationMs += entry.generationMs
    timedOutputTokens += entry.timedOutputTokens
  }
  return { sessions, daily, sessionsByDay, turnCount, stepCount, generationMs, timedOutputTokens }
}

/** Concurrent Session reads per scan; the Host itself reads at most four persisted logs at once. */
const SCAN_READ_CONCURRENCY = 4

/** Reject after ms so one stuck Session cannot hold the whole scan. */
function withTimeout(promise, ms, label) {
  if (!Number.isFinite(ms) || ms <= 0) return promise
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), ms)
    }),
  ]).finally(() => { clearTimeout(timer) })
}

/** Release an observation lease without depending on one disposal spelling. */
function disposeObservation(observation) {
  if (typeof observation.dispose === 'function') observation.dispose()
  else if (typeof observation[Symbol.dispose] === 'function') observation[Symbol.dispose]()
}

/** Read one Session through the cheaper observation API when the Host offers it. */
async function readSessionSnapshot(sessionQuery, sessionId, timeoutMs) {
  if (typeof sessionQuery.observeSession === 'function') {
    let observation
    let timedOut = false
    const pending = sessionQuery.observeSession(sessionId, { projectionMode: 'none' })
    pending.then((late) => {
      if (!timedOut) return
      try { disposeObservation(late) } catch { /* the timeout already won */ }
    }, () => {})
    try {
      observation = await withTimeout(pending, timeoutMs, `session ${sessionId}`)
      return { events: observation.events, inheritedEventCount: observation.inheritedEventCount }
    } catch (error) {
      timedOut = true
      throw error
    } finally {
      if (observation !== undefined) disposeObservation(observation)
    }
  }
  return await withTimeout(
    sessionQuery.readSession(sessionId),
    timeoutMs,
    `session ${sessionId}`,
  )
}

/** Extra read budget per megabyte of stored log, because the Host replays a whole log per read. */
const READ_TIMEOUT_PER_MEGABYTE_MS = 500

/** Ceiling for one read, so a single huge Session cannot own a whole scan budget. */
const READ_TIMEOUT_MAX_MS = 60_000

/** Read budget for one pending item, scaled by the size of the log it replays. */
export function readTimeoutFor(item, baseMs, perMegabyteMs, maxMs) {
  if (!Number.isFinite(baseMs) || baseMs <= 0) return baseMs
  const size = item.stamp?.size
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return baseMs
  const scaled = baseMs + (size / 1e6) * perMegabyteMs
  return Number.isFinite(maxMs) && maxMs > 0 ? Math.min(maxMs, scaled) : scaled
}

/**
 * Scan the logical session corpus and fold every owned Assistant settlement.
 *
 * Sessions are read by a small worker pool: one cold log read is mostly waiting on
 * the Host, so overlapping a few keeps a single scan budget productive without
 * holding more large event arrays than the Host itself would.
 */
export async function collectTokenUsage(sessionQuery, options = {}) {
  const now = options.now ?? Date.now()
  const days = normalizeRange(options.days ?? 30)
  const dayOf = options.dayOf ?? localDay
  const signal = options.signal
  const readTimeoutMs = options.readTimeoutMs ?? 15_000
  const readTimeoutPerMegabyteMs = options.readTimeoutPerMegabyteMs ?? READ_TIMEOUT_PER_MEGABYTE_MS
  const readTimeoutMaxMs = options.readTimeoutMaxMs ?? READ_TIMEOUT_MAX_MS
  const scanTimeoutMs = options.scanTimeoutMs ?? 45_000
  const deadline = Number.isFinite(scanTimeoutMs) && scanTimeoutMs > 0
    ? Date.now() + scanTimeoutMs
    : Infinity
  const records = await withTimeout(sessionQuery.listSessions(signal), 10_000, 'session list')
  const previousSessions = options.ledgerSessions ?? new Map()
  const { pending, retained, changed } = planSessionReads(
    records,
    previousSessions,
    options.sessionStamps,
    { now, deferred: options.deferred },
  )
  const liveSessions = new Map()
  let skippedSessions = 0
  let scanTimedOut = false
  let processed = 0
  /** Report a failed read so the caller can leave that Session alone for a while. */
  const noteFailure = (sessionId) => {
    try { options.onReadFailure?.(sessionId) } catch { /* a reporter must not break the scan */ }
  }
  const concurrency = Math.min(
    Number.isSafeInteger(options.readConcurrency) && options.readConcurrency > 0
      ? options.readConcurrency
      : SCAN_READ_CONCURRENCY,
    pending.length,
  )
  let cursor = 0
  /** One read worker: claim the next Session and fold it until the queue or the budget ends. */
  const worker = async () => {
    for (;;) {
      if (signal?.aborted) return
      if (cursor >= pending.length) return
      if (Date.now() > deadline) {
        scanTimedOut = true
        return
      }
      const item = pending[cursor]
      cursor += 1
      processed += 1
      let snapshot
      try {
        snapshot = await readSessionSnapshot(
          sessionQuery,
          item.sessionId,
          readTimeoutFor(item, readTimeoutMs, readTimeoutPerMegabyteMs, readTimeoutMaxMs),
        )
      } catch {
        skippedSessions += 1
        noteFailure(item.sessionId)
        continue
      }
      if (signal?.aborted) return
      let folded
      try {
        folded = foldSessionEvents(snapshot.events, snapshot.inheritedEventCount, dayOf)
      } catch {
        skippedSessions += 1
        noteFailure(item.sessionId)
        continue
      }
      liveSessions.set(item.sessionId, sessionEntryOf(folded, item.live, Date.now(), item.stamp))
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  if (signal?.aborted) throw signal.reason ?? new Error('aborted')
  const aggregate = aggregateSessionUsage(retained, liveSessions)
  // A scan that neither read nor adopted anything leaves the ledger exactly as it
  // already is, and the one-minute poll must not rewrite the whole corpus file.
  if (options.persistSessions !== undefined && (changed || liveSessions.size > 0)) {
    await options.persistSessions(aggregate.sessions)
  }
  return buildStats({
    daily: aggregate.daily,
    sessionsByDay: aggregate.sessionsByDay,
    days,
    now,
    sessionCount: records.length,
    skippedSessions,
    pendingSessions: scanTimedOut ? pending.length - processed : 0,
    staleSessions: countStaleSessions(records, retained, liveSessions, options.sessionStamps),
    refreshed: liveSessions.size,
    incomplete: skippedSessions > 0 || scanTimedOut,
    turnCount: aggregate.turnCount,
    stepCount: aggregate.stepCount,
    generationMs: aggregate.generationMs,
    timedOutputTokens: aggregate.timedOutputTokens,
  })
}

/** Reject only this waiter when its caller aborts; the shared scan continues. */
function raceSignal(promise, signal) {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'))
  return new Promise((resolve, reject) => {
    const onAbort = () => { reject(signal.reason ?? new Error('aborted')) }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

/**
 * Create a short TTL cache around {@link collectTokenUsage}.
 * Concurrent reads for one range share a single corpus scan, and a scan only
 * re-reads Sessions whose artifact changed, so the window stays far below the
 * browser's poll cadence: the panel asks once a minute and gets a fresh scan.
 *
 * A scan that runs out of budget leaves Sessions pending; a bounded chain of
 * follow-up scans drains that backlog without a user request, started by the scan
 * itself so a closed or aborted reader cannot end it. Between passes the cached
 * document stays available, so a reader never waits for the whole backlog.
 */
export function createTokenUsageService(sessionQuery, options = {}) {
  /** Short enough that a poll sees new settlements, long enough that bursts share one scan. */
  const ttlMs = options.ttlMs ?? 60_000
  const catchUpDelayMs = options.catchUpDelayMs ?? 2_000
  const catchUpPasses = options.catchUpPasses ?? 40
  /** Consecutive failed passes that end the burst instead of retrying forever. */
  const catchUpFailures = 3
  const nowFn = options.now ?? Date.now
  const ledger = options.ledger
  const logger = options.logger
  const readStamps = options.sessionStamps
  /** Scan limits apply to every pass, including catch-up passes. */
  const scanLimits = {}
  if (Number.isFinite(options.scanTimeoutMs)) scanLimits.scanTimeoutMs = options.scanTimeoutMs
  if (Number.isFinite(options.readTimeoutMs)) scanLimits.readTimeoutMs = options.readTimeoutMs
  const entries = new Map()
  const inflight = new Map()
  const catchUp = new Map()
  /** Sessions whose read just failed, with the time they may be retried. */
  const deferred = new Map()
  const deferFailedMs = options.deferFailedMs ?? 10 * 60_000
  /** A scan outlives its reader: only disposal aborts one, so a closed panel never wastes a pass. */
  const scanAbort = new AbortController()
  let scanQueue = Promise.resolve()
  let disposed = false

  /**
   * Ids to keep out of the queue right now.
   *
   * One unreadable or oversized Session would otherwise sit at the front of the
   * oldest-first queue and be retried on every pass, which is exactly the head
   * of line blocking that leaves the rest of the backlog frozen.
   */
  const deferredIds = (at) => {
    const ids = new Set()
    for (const [sessionId, until] of deferred) {
      if (until <= at) deferred.delete(sessionId)
      else ids.add(sessionId)
    }
    return ids
  }

  /** One queued corpus scan; concurrent callers for one range share the task. */
  const enqueue = (normalized) => {
    const key = String(normalized)
    const running = inflight.get(key)
    if (running !== undefined) return running
    const now = nowFn()
    const scan = async () => {
      let ledgerSessions = new Map()
      if (ledger !== undefined) {
        try {
          ledgerSessions = await withTimeout(ledger.load(), 5_000, 'ledger read')
        } catch (error) {
          logger?.warn?.('llm-token-usage: ledger read failed', error)
        }
      }
      let sessionStamps
      if (ledger !== undefined && typeof readStamps === 'function') {
        try {
          sessionStamps = await withTimeout(Promise.resolve().then(readStamps), 10_000, 'session stamps')
        } catch (error) {
          logger?.warn?.('llm-token-usage: session stamps unavailable', error)
        }
      }
      return collectTokenUsage(sessionQuery, {
        days: normalized,
        now,
        ledgerSessions,
        sessionStamps,
        deferred: deferredIds(nowFn()),
        signal: scanAbort.signal,
        ...scanLimits,
        onReadFailure: (sessionId) => {
          deferred.set(sessionId, nowFn() + deferFailedMs)
          logger?.warn?.('llm-token-usage: session read failed, deferring it', { sessionId })
        },
        persistSessions: ledger === undefined ? undefined : async (sessions) => {
          try {
            await withTimeout(ledger.save(sessions), 10_000, 'ledger write')
          } catch (error) {
            logger?.warn?.('llm-token-usage: ledger write failed', error)
          }
        },
      })
    }
    const task = scanQueue.then(scan, scan)
      .then((value) => {
        entries.set(normalized, { at: nowFn(), value })
        // The backlog is drained from the scan itself, so a reader that navigates
        // away from an aborted request does not cancel the follow-up passes.
        scheduleCatchUp(normalized, value)
        return { ...value, cached: false }
      })
      .finally(() => { inflight.delete(key) })
    scanQueue = task.catch(() => {})
    task.catch(() => {})
    inflight.set(key, task)
    return task
  }

  /** Arm one follow-up pass; the timer is shared per range so one burst never doubles up. */
  const armCatchUp = (normalized, state) => {
    if (disposed || state.timer !== undefined || state.passes >= catchUpPasses) return
    state.timer = setTimeout(() => {
      state.timer = undefined
      if (disposed) return
      state.passes += 1
      // The successful pass re-arms from `enqueue`'s completion, which is the one
      // place that sees the fresh pending count.
      enqueue(normalized).catch((error) => {
        // A failed pass says nothing about the backlog: retry a bounded number of
        // times instead of silently ending the burst.
        state.failures += 1
        logger?.warn?.('llm-token-usage: background scan failed', error)
        if (state.failures >= catchUpFailures) {
          state.passes = catchUpPasses
          return
        }
        armCatchUp(normalized, state)
      })
    }, catchUpDelayMs)
    state.timer.unref?.()
  }

  /** Keep draining a truncated backlog, bounded per burst so one refresh cannot hog the Host. */
  const scheduleCatchUp = (normalized, value) => {
    const state = catchUp.get(normalized) ?? { timer: undefined, passes: 0, failures: 0 }
    catchUp.set(normalized, state)
    state.failures = 0
    if (disposed || value.pendingSessions === 0) {
      state.passes = 0
      return
    }
    // The queue is ordered so that one pass advances its front, which makes a
    // non-empty backlog the only progress signal that holds up: comparing queue
    // lengths across passes stops the drain whenever a busy corpus adds as many
    // Sessions as the scan closes.
    logger?.info?.('llm-token-usage: draining session backlog', {
      range: normalized,
      pending: value.pendingSessions,
      refreshed: value.refreshed,
      passes: state.passes,
    })
    armCatchUp(normalized, state)
  }

  return {
    async read({ range, days, refresh = false, signal } = {}) {
      const normalized = normalizeRange(range ?? days ?? 30)
      const cached = entries.get(normalized)
      const now = nowFn()
      if (!refresh && cached !== undefined && now - cached.at < ttlMs) {
        return { ...cached.value, cached: true }
      }
      const state = catchUp.get(normalized)
      if (state !== undefined) {
        // An explicit request restarts the burst budget.
        state.passes = 0
        state.failures = 0
      }
      return await raceSignal(enqueue(normalized), signal)
    },
    /** Stop follow-up scans and detach timers; the cached document stays readable. */
    dispose() {
      disposed = true
      scanAbort.abort(new Error('token-usage service disposed'))
      for (const state of catchUp.values()) {
        if (state.timer !== undefined) clearTimeout(state.timer)
        state.timer = undefined
      }
    },
  }
}
