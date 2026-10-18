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

/** Scan the logical session corpus and fold every owned Assistant settlement. */
export async function collectTokenUsage(sessionQuery, options = {}) {
  const now = options.now ?? Date.now()
  const days = normalizeRange(options.days ?? 30)
  const dayOf = options.dayOf ?? localDay
  const signal = options.signal
  const records = await sessionQuery.listSessions(signal)
  const daily = new Map()
  const sessionsByDay = new Map()
  let skippedSessions = 0
  let turnCount = 0
  let stepCount = 0
  let generationMs = 0
  let timedOutputTokens = 0
  for (const record of records) {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted')
    let snapshot
    try {
      snapshot = await sessionQuery.readSession(record.header.id)
    } catch {
      skippedSessions += 1
      continue
    }
    if (signal?.aborted) throw signal.reason ?? new Error('aborted')
    let folded
    try {
      folded = foldSessionEvents(snapshot.events, snapshot.inheritedEventCount, dayOf)
    } catch {
      skippedSessions += 1
      continue
    }
    turnCount += folded.turnCount
    stepCount += folded.stepCount
    generationMs += folded.generationMs
    timedOutputTokens += folded.timedOutputTokens
    for (const [key, buckets] of folded.days) {
      daily.set(key, addBuckets(daily.get(key) ?? EMPTY_BUCKETS, buckets))
      const ids = sessionsByDay.get(key) ?? new Set()
      ids.add(record.header.id)
      sessionsByDay.set(key, ids)
    }
  }
  return buildStats({
    daily,
    sessionsByDay,
    days,
    now,
    sessionCount: records.length,
    skippedSessions,
    incomplete: skippedSessions > 0,
    turnCount,
    stepCount,
    generationMs,
    timedOutputTokens,
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
 * Create a one-hour TTL cache around {@link collectTokenUsage}.
 * Concurrent reads for one range share a single corpus scan.
 */
export function createTokenUsageService(sessionQuery, options = {}) {
  const ttlMs = options.ttlMs ?? 60 * 60_000
  const nowFn = options.now ?? Date.now
  const entries = new Map()
  const inflight = new Map()
  return {
    async read({ range, days, refresh = false, signal } = {}) {
      const normalized = normalizeRange(range ?? days ?? 30)
      const cached = entries.get(normalized)
      const now = nowFn()
      if (!refresh && cached !== undefined && now - cached.at < ttlMs) {
        return { ...cached.value, cached: true }
      }
      const key = String(normalized)
      const pending = inflight.get(key)
      if (pending !== undefined) return await raceSignal(pending, signal)
      const task = collectTokenUsage(sessionQuery, { days: normalized, now })
        .then((value) => {
          entries.set(normalized, { at: nowFn(), value })
          return { ...value, cached: false }
        })
        .finally(() => { inflight.delete(key) })
      task.catch(() => {})
      inflight.set(key, task)
      return await raceSignal(task, signal)
    },
  }
}
