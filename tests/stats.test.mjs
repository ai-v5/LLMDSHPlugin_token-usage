import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EMPTY_BUCKETS, foldSessionEvents, buildStats, localDay, usageOfEvent, streamDurationMs, collectTokenUsage,
  planSessionReads,
} from '../lib/stats.js'
import { createSessionLedger } from '../lib/ledger.js'
import { readSessionStamps } from '../lib/scan-index.js'

const usage = (input, output, cacheRead = 0, cacheWrite = 0) => ({
  inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
})

const message = (time, turn, step, value) => ({
  type: 'assistant/message', time, data: { turn, step, usage: value, stream: [] },
})

const attempt = (time, turn, step, value) => ({
  type: 'assistant/attempt', time, data: {
    turn, step, stream: [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage: value } }],
  },
})

test('usageOfEvent prefers the message usage and falls back to the stream', () => {
  assert.deepEqual(usageOfEvent(message(0, 1, 1, usage(5, 7))), usage(5, 7))
  assert.deepEqual(usageOfEvent(attempt(0, 1, 1, usage(3, 4))), usage(3, 4))
  assert.equal(usageOfEvent({ type: 'step/start', data: { turn: 1, step: 1 } }), undefined)
})

test('foldSessionEvents sums distinct attempts and replaces a same-attempt sample', () => {
  const events = [
    message(0, 1, 1, usage(100, 10)),
    message(1, 1, 2, usage(150, 20)),
    message(2, 1, 2, usage(200, 25)),
  ]
  const folded = foldSessionEvents(events, 0, () => '2026-10-18')
  assert.equal(folded.usageEvents, 3)
  assert.deepEqual(folded.days.get('2026-10-18'), {
    inputTokens: 300, outputTokens: 35, cacheReadTokens: 0, cacheWriteTokens: 0,
  })
})

test('a retry closes the replacement slot so both attempts count', () => {
  const events = [
    attempt(0, 1, 1, usage(10, 1)),
    { type: 'llm/retry-started', time: 1, data: { turn: 1, step: 1 } },
    message(2, 1, 1, usage(12, 2)),
  ]
  const folded = foldSessionEvents(events, 0, () => '2026-10-18')
  assert.deepEqual(folded.days.get('2026-10-18'), {
    inputTokens: 22, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0,
  })
})

test('fork-inherited events are excluded from the count', () => {
  const events = [message(0, 1, 1, usage(999, 99)), message(1, 2, 1, usage(4, 5))]
  const folded = foldSessionEvents(events, 1, () => '2026-10-18')
  assert.deepEqual(folded.days.get('2026-10-18'), {
    inputTokens: 4, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0,
  })
})

test('buildStats zero-fills the range and derives totals', () => {
  const daily = new Map([['2026-10-18', { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 1 }]])
  const sessionsByDay = new Map([['2026-10-18', new Set(['s1'])]])
  const result = buildStats({
    daily, sessionsByDay, days: 3, now: new Date(2026, 9, 18, 12).getTime(),
    sessionCount: 4, skippedSessions: 0, incomplete: false,
  })
  assert.deepEqual(result.series.map(day => day.date), ['2026-10-16', '2026-10-17', '2026-10-18'])
  assert.equal(result.series[0].totalTokens, 0)
  assert.equal(result.today.totalTokens, 116)
  assert.equal(result.today.inputOutputTokens, 15)
  assert.equal(result.today.sessions, 1)
  assert.equal(result.totals.totalTokens, 116)
  assert.deepEqual(result.allTime, result.totals)
  assert.equal(localDay(new Date(2026, 9, 18, 1).getTime()), '2026-10-18')
})

test('compaction/summary usage is counted once as its own call', () => {
  const events = [{
    type: 'compaction/summary', time: 0,
    data: { compactionId: 'c1', usage: usage(1000, 100), provider: 'p', model: 'm' },
  }]
  const folded = foldSessionEvents(events, 0, () => '2026-10-18')
  assert.deepEqual(folded.days.get('2026-10-18'), {
    inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0,
  })
})

test('collectTokenUsage skips inherited events and unreadable sessions', async () => {
  const { collectTokenUsage } = await import('../lib/stats.js')
  const query = {
    async listSessions() {
      return [{ header: { id: 'a' } }, { header: { id: 'b' } }, { header: { id: 'c' } }]
    },
    async readSession(id) {
      if (id === 'c') throw new Error('unreadable')
      if (id === 'a') {
        return {
          inheritedEventCount: 1,
          events: [message(0, 1, 1, usage(999, 99)), message(1, 1, 1, usage(10, 2))],
        }
      }
      return { inheritedEventCount: 0, events: [message(2, 1, 2, usage(20, 3))] }
    },
  }
  const result = await collectTokenUsage(query, {
    days: 1, now: new Date(2026, 9, 18, 12).getTime(), dayOf: () => '2026-10-18',
  })
  assert.equal(result.totals.inputTokens, 30)
  assert.equal(result.totals.outputTokens, 5)
  assert.equal(result.sessionCount, 3)
  assert.equal(result.skippedSessions, 1)
  assert.equal(result.incomplete, true)
})

test('a replacement sample moves its tokens from the old day to the new day', () => {
  const events = [
    message(0, 1, 1, usage(100, 10)),
    message(1000, 1, 1, usage(150, 20)),
  ]
  const folded = foldSessionEvents(events, 0, time => time < 500 ? '2026-10-17' : '2026-10-18')
  assert.equal(folded.days.get('2026-10-17'), undefined)
  assert.deepEqual(folded.days.get('2026-10-18'), {
    inputTokens: 150, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0,
  })
})

test('all-time range keeps full totals while the series stays bounded', () => {
  const daily = new Map([
    ['2026-10-16', { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }],
    ['2026-10-17', { inputTokens: 20, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }],
    ['2026-10-18', { inputTokens: 30, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 }],
  ])
  const result = buildStats({
    daily, sessionsByDay: new Map(), days: 'all', now: new Date(2026, 9, 18, 12).getTime(),
    sessionCount: 3, skippedSessions: 0, incomplete: false,
  })
  assert.equal(result.rangeKind, 'all')
  assert.equal(result.days, 3)
  assert.equal(result.totals.totalTokens, 66)
  assert.equal(result.allTime.totalTokens, 66)
  assert.deepEqual(result.series.map(day => day.date), ['2026-10-16', '2026-10-17', '2026-10-18'])
})

test('normalizeRange accepts all and rejects malformed day counts', async () => {
  const { normalizeRange } = await import('../lib/stats.js')
  assert.equal(normalizeRange('all'), 'all')
  assert.equal(normalizeRange('7'), 7)
  assert.equal(normalizeRange('7days'), 30)
  assert.equal(normalizeRange('0'), 1)
})

test('the host route serves the stats document', async () => {
  const { apply } = await import('../index.js')
  let route
  const ctx = {
    sessionQuery: {
      async listSessions() { return [{ header: { id: 's1' } }] },
      async readSession() {
        return { inheritedEventCount: 0, events: [message(Date.now(), 1, 1, usage(10, 2))] }
      },
    },
    connection: {
      fetch: {
        register(value) { route = value; return async () => {} },
      },
    },
    effect(callback) { return callback() },
    logger: { warn() {} },
  }
  apply(ctx)
  assert.equal(route.path, '/api/llm-token-usage/stats')
  const response = await route.fetch(new Request('http://host/api/llm-token-usage/stats?days=7'))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.days, 7)
  assert.equal(body.totals.totalTokens, 12)
})

test('service.read accepts a days fallback and returns that range', async () => {
  const { createTokenUsageService } = await import('../lib/stats.js')
  const service = createTokenUsageService({
    async listSessions() { return [] },
    async readSession() { return { inheritedEventCount: 0, events: [] } },
  }, { now: () => new Date(2026, 9, 18, 12).getTime() })
  const result = await service.read({ days: 7 })
  assert.equal(result.days, 7)
  assert.equal(result.rangeKind, 'days')
  assert.equal(result.series.length, 7)
})

test('aborting one reader does not reject a concurrent reader', async () => {
  const { createTokenUsageService } = await import('../lib/stats.js')
  const service = createTokenUsageService({
    async listSessions() {
      await new Promise(resolve => setTimeout(resolve, 25))
      return []
    },
    async readSession() { return { inheritedEventCount: 0, events: [] } },
  }, { now: () => new Date(2026, 9, 18, 12).getTime() })
  const controller = new AbortController()
  const first = service.read({ range: 30, signal: controller.signal })
  const second = service.read({ range: 30 })
  controller.abort()
  await assert.rejects(first)
  const value = await second
  assert.equal(value.days, 30)
})

test('a null usage sample is ignored instead of aborting the scan', () => {
  const events = [
    { type: 'assistant/message', time: 0, data: { turn: 1, step: 1, usage: null, stream: [] } },
    message(1, 1, 1, usage(10, 2)),
  ]
  const folded = foldSessionEvents(events, 0, () => '2026-10-18')
  assert.deepEqual(folded.days.get('2026-10-18'), {
    inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0,
  })
})

test('future-dated days stay out of all-time totals', () => {
  const daily = new Map([
    ['2026-10-17', { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }],
    ['2026-10-19', { inputTokens: 99, outputTokens: 9, cacheReadTokens: 0, cacheWriteTokens: 0 }],
  ])
  const result = buildStats({
    daily, sessionsByDay: new Map(), days: 'all', now: new Date(2026, 9, 18, 12).getTime(),
    sessionCount: 2, skippedSessions: 0, incomplete: false,
  })
  assert.equal(result.allTime.totalTokens, 11)
  assert.equal(result.totals.totalTokens, 11)
})

test('a repeated compaction id is counted once', () => {
  const events = [{
    type: 'compaction/summary', time: 0,
    data: { compactionId: 'same', usage: usage(10, 1) },
  }, {
    type: 'compaction/summary', time: 1,
    data: { compactionId: 'same', usage: usage(10, 1) },
  }]
  const folded = foldSessionEvents(events, 0, () => '2026-10-18')
  assert.deepEqual(folded.days.get('2026-10-18'), {
    inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
  })
})

test('streamDurationMs reads packed gaps and raw chunk times', () => {
  assert.equal(streamDurationMs([]), 0)
  assert.equal(streamDurationMs([
    { type: 'text-chunks', time0: 1000, index: 0, dt: [100, 250], texts: ['a', 'b', 'c'] },
  ]), 350)
  assert.equal(streamDurationMs([
    { type: 'chunk', time: 1000, chunk: { type: 'text-delta', index: 0, text: 'a' } },
    { type: 'chunk', time: 1500, chunk: { type: 'text-delta', index: 0, text: 'b' } },
  ]), 500)
})

test('turn, step, and generation-speed aggregates track owned events', () => {
  const events = [
    { type: 'turn/start', time: 0, data: { turn: 1 } },
    { type: 'step/start', time: 1, data: { turn: 1, step: 1 } },
    {
      type: 'assistant/message', time: 1400,
      data: {
        turn: 1, step: 1, usage: usage(10, 30),
        stream: [{ type: 'text-chunks', time0: 1000, index: 0, dt: [100, 100, 100, 100], texts: ['a', 'b', 'c', 'd', 'e'] }],
      },
    },
    { type: 'step/end', time: 1401, data: { turn: 1, step: 1 } },
    { type: 'turn/end', time: 1402, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const folded = foldSessionEvents(events, 0, () => '2026-10-18')
  assert.equal(folded.turnCount, 1)
  assert.equal(folded.stepCount, 1)
  assert.equal(folded.generationMs, 400)
  assert.equal(folded.timedOutputTokens, 30)
  const result = buildStats({
    daily: folded.days, sessionsByDay: new Map(), days: 'all',
    now: new Date(2026, 9, 18, 12).getTime(), sessionCount: 1,
    skippedSessions: 0, incomplete: false,
    turnCount: folded.turnCount, stepCount: folded.stepCount,
    generationMs: folded.generationMs, timedOutputTokens: folded.timedOutputTokens,
  })
  assert.deepEqual(result.activity, {
    turns: 1, steps: 1, generationMs: 400, timedOutputTokens: 30, tokensPerSecond: 75,
  })
})

test('a replacement sample replaces its generation duration too', () => {
  const stream = (time0) => [{
    type: 'text-chunks', time0, index: 0, dt: [500], texts: ['a', 'b'],
  }]
  const events = [
    {
      type: 'assistant/message', time: 1000,
      data: { turn: 1, step: 1, usage: usage(10, 20), stream: stream(500) },
    },
    {
      type: 'assistant/message', time: 2000,
      data: { turn: 1, step: 1, usage: usage(10, 25), stream: stream(1500) },
    },
  ]
  const folded = foldSessionEvents(events, 0, () => '2026-10-18')
  assert.equal(folded.generationMs, 500)
  assert.equal(folded.timedOutputTokens, 25)
})

test('fork-inherited lifecycle events are not counted as turns or steps', () => {
  const events = [
    { type: 'turn/start', time: 0, data: { turn: 1 } },
    { type: 'step/start', time: 1, data: { turn: 1, step: 1 } },
    message(2, 1, 1, usage(10, 1)),
  ]
  const folded = foldSessionEvents(events, 2, () => '2026-10-18')
  assert.equal(folded.turnCount, 0)
  assert.equal(folded.stepCount, 0)
  assert.equal(folded.generationMs, 0)
})

test('the host service keeps its default cache for fifteen minutes', async () => {
  const { createTokenUsageService } = await import('../lib/stats.js')
  let now = 0
  let scans = 0
  const service = createTokenUsageService({
    async listSessions() { scans += 1; return [] },
    async readSession() { return { inheritedEventCount: 0, events: [] } },
  }, { now: () => now })
  await service.read({ range: 30 })
  now = 14 * 60 * 1000
  await service.read({ range: 30 })
  assert.equal(scans, 1)
  now = 16 * 60 * 1000
  await service.read({ range: 30 })
  assert.equal(scans, 2)
})

const ledgerEntry = (input, output, turnCount = 1, stepCount = 1) => ({
  days: new Map([['2026-10-19', {
    inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0,
  }]]),
  turnCount,
  stepCount,
  generationMs: 100,
  timedOutputTokens: output,
})

test('the Session ledger round-trips its durable shape', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'llm-token-usage-'))
  try {
    const path = join(directory, 'ledger.json')
    const ledger = createSessionLedger(path)
    await ledger.save(new Map([['session-1', ledgerEntry(10, 2, 3, 4)]]))
    const loaded = await createSessionLedger(path).load()
    assert.deepEqual(loaded.get('session-1').days.get('2026-10-19'), {
      inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0,
    })
    assert.equal(loaded.get('session-1').turnCount, 3)
    assert.equal(loaded.get('session-1').stepCount, 4)
    assert.equal(loaded.get('session-1').generationMs, 100)
    assert.equal(loaded.get('session-1').timedOutputTokens, 2)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('two Hosts sharing one ledger keep each other entries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'llm-token-usage-'))
  try {
    const path = join(directory, 'ledger.json')
    const first = createSessionLedger(path)
    const second = createSessionLedger(path)
    await first.load()
    await second.load()
    await first.save(new Map([['a', { ...ledgerEntry(1, 1), updatedAt: 1_000 }]]))
    await second.save(new Map([['b', { ...ledgerEntry(2, 2), updatedAt: 2_000 }]]))
    const merged = await createSessionLedger(path).load()
    assert.equal(merged.size, 2)
    assert.ok(merged.has('a'))
    assert.ok(merged.has('b'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a newer on-disk entry survives a stale save', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'llm-token-usage-'))
  try {
    const path = join(directory, 'ledger.json')
    const stale = createSessionLedger(path)
    await stale.load()
    const writer = createSessionLedger(path)
    await writer.load()
    await writer.save(new Map([['s', { ...ledgerEntry(900, 5), updatedAt: 9_000 }]]))
    await stale.save(new Map([['s', { ...ledgerEntry(1, 1), updatedAt: 100 }]]))
    const final = await createSessionLedger(path).load()
    assert.equal(final.get('s').days.get('2026-10-19').inputTokens, 900)
    assert.equal(final.get('s').updatedAt, 9_000)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a deleted session stays in the aggregate while its live peer is replaced', async () => {
  const now = new Date(2026, 9, 19, 1).getTime()
  const previous = new Map([
    ['deleted', ledgerEntry(10, 1, 1, 2)],
    ['live', ledgerEntry(1000, 500, 99, 99)],
  ])
  const query = {
    async listSessions() { return [{ header: { id: 'live' } }] },
    async readSession() {
      return {
        inheritedEventCount: 0,
        events: [
          { type: 'turn/start', time: now, data: { turn: 1 } },
          { type: 'step/start', time: now, data: { turn: 1, step: 1 } },
          message(now, 1, 1, usage(20, 2)),
        ],
      }
    },
  }
  let persisted
  const result = await collectTokenUsage(query, {
    days: 'all',
    now,
    ledgerSessions: previous,
    persistSessions: (sessions) => { persisted = sessions },
  })
  assert.equal(result.allTime.totalTokens, 33)
  assert.equal(result.activity.turns, 2)
  assert.equal(result.activity.steps, 3)
  assert.ok(persisted.has('deleted'))
  assert.equal(persisted.get('live').days.get('2026-10-19').inputTokens, 20)
})

test('a stuck session read is skipped so the scan can finish', async () => {
  const now = new Date(2026, 9, 19, 1).getTime()
  const query = {
    async listSessions() {
      return [{ header: { id: 'hung' } }, { header: { id: 'ok' } }]
    },
    async readSession(id) {
      if (id === 'hung') return new Promise(() => {})
      return { inheritedEventCount: 0, events: [message(now, 1, 1, usage(2, 1))] }
    },
  }
  const result = await collectTokenUsage(query, { days: 'all', now, readTimeoutMs: 20 })
  assert.equal(result.skippedSessions, 1)
  assert.equal(result.incomplete, true)
  assert.equal(result.allTime.totalTokens, 3)
})

test('the scan prefers and disposes Session observations', async () => {
  const now = new Date(2026, 9, 19, 1).getTime()
  let disposed = 0
  let readCalls = 0
  const query = {
    async listSessions() { return [{ header: { id: 'observed' } }] },
    async observeSession(_id, options) {
      assert.equal(options.projectionMode, 'none')
      return {
        inheritedEventCount: 0,
        events: [message(now, 1, 1, usage(5, 2))],
        dispose() { disposed += 1 },
      }
    },
    async readSession() {
      readCalls += 1
      throw new Error('readSession should not be used')
    },
  }
  const result = await collectTokenUsage(query, { days: 'all', now })
  assert.equal(result.allTime.totalTokens, 7)
  assert.equal(disposed, 1)
  assert.equal(readCalls, 0)
})

test('an unchanged persisted session is reused without another read', async () => {
  const now = new Date(2026, 9, 19, 1).getTime()
  let reads = 0
  const query = {
    async listSessions() { return [{ header: { id: 'settled' }, live: false }] },
    async observeSession() {
      reads += 1
      throw new Error('settled session should not be observed')
    },
    async readSession() {
      reads += 1
      throw new Error('settled session should not be read')
    },
  }
  const result = await collectTokenUsage(query, {
    days: 'all',
    now,
    ledgerSessions: new Map([['settled', { ...ledgerEntry(10, 1), live: false }]]),
  })
  assert.equal(reads, 0)
  assert.equal(result.allTime.totalTokens, 11)
})

test('a non-live session whose log changed is read again and recounted', async () => {
  const now = new Date(2026, 9, 19, 1).getTime()
  const reads = []
  const query = {
    async listSessions() {
      return [
        { header: { id: 'settled', createdAt: 2 }, live: false },
        { header: { id: 'rewritten', createdAt: 1 }, live: false },
      ]
    },
    async readSession(id) {
      reads.push(id)
      return { inheritedEventCount: 0, events: [message(now, 1, 1, usage(400, 100))] }
    },
  }
  const previous = new Map([
    ['settled', { ...ledgerEntry(10, 1), live: false, updatedAt: now, size: 100, mtimeMs: 1_000 }],
    ['rewritten', { ...ledgerEntry(10, 1), live: false, updatedAt: now, size: 100, mtimeMs: 1_000 }],
  ])
  const stamps = new Map([
    ['settled', { size: 100, mtimeMs: 1_000 }],
    ['rewritten', { size: 140, mtimeMs: 2_000 }],
  ])
  const result = await collectTokenUsage(query, {
    days: 'all', now, ledgerSessions: previous, sessionStamps: stamps,
  })
  assert.deepEqual(reads, ['rewritten'])
  assert.equal(result.allTime.totalTokens, 11 + 500)
})

test('a ledger entry from before stamps is adopted when its log predates the snapshot', async () => {
  const now = new Date(2026, 9, 19, 1).getTime()
  let reads = 0
  const query = {
    async listSessions() { return [{ header: { id: 'legacy' }, live: false }] },
    async readSession() {
      reads += 1
      throw new Error('legacy entry should be adopted, not read')
    },
  }
  let persisted
  const result = await collectTokenUsage(query, {
    days: 'all',
    now,
    ledgerSessions: new Map([['legacy', { ...ledgerEntry(10, 1), live: false, updatedAt: 5_000 }]]),
    sessionStamps: new Map([['legacy', { size: 42, mtimeMs: 4_000 }]]),
    persistSessions: (sessions) => { persisted = sessions },
  })
  assert.equal(reads, 0)
  assert.equal(result.allTime.totalTokens, 11)
  assert.equal(persisted.get('legacy').size, 42)
  assert.equal(persisted.get('legacy').mtimeMs, 4_000)
})

test('a ledger entry from before stamps is read when its log moved after the snapshot', async () => {
  const now = new Date(2026, 9, 19, 1).getTime()
  const reads = []
  const query = {
    async listSessions() { return [{ header: { id: 'legacy' }, live: false }] },
    async readSession(id) {
      reads.push(id)
      return { inheritedEventCount: 0, events: [message(now, 1, 1, usage(70, 9))] }
    },
  }
  const result = await collectTokenUsage(query, {
    days: 'all',
    now,
    ledgerSessions: new Map([['legacy', { ...ledgerEntry(10, 1), live: false, updatedAt: 5_000 }]]),
    sessionStamps: new Map([['legacy', { size: 99, mtimeMs: 6_000 }]]),
  })
  assert.deepEqual(reads, ['legacy'])
  assert.equal(result.allTime.totalTokens, 79)
})

test('the read plan refreshes the most recently written session first', () => {
  const records = [
    { header: { id: 'createdLate', createdAt: 900 }, live: false },
    { header: { id: 'writtenLate', createdAt: 100 }, live: false },
  ]
  const stamps = new Map([
    ['createdLate', { size: 10, mtimeMs: 1_000 }],
    ['writtenLate', { size: 10, mtimeMs: 9_000 }],
  ])
  const { pending } = planSessionReads(records, new Map(), stamps)
  assert.deepEqual(pending.map(item => item.sessionId), ['writtenLate', 'createdLate'])
})

test('without stamps the read plan keeps the newest sessions first', () => {
  const records = [
    { header: { id: 'older', createdAt: 100 }, live: false },
    { header: { id: 'newer', createdAt: 900 }, live: false },
  ]
  const { pending } = planSessionReads(records, new Map(), undefined)
  assert.deepEqual(pending.map(item => item.sessionId), ['newer', 'older'])
})

test('the Session ledger keeps change stamps and still opens a version 1 file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'llm-token-usage-'))
  try {
    const path = join(directory, 'ledger.json')
    const ledger = createSessionLedger(path)
    await ledger.save(new Map([['session-1', {
      ...ledgerEntry(10, 2), updatedAt: 5_000, size: 128, mtimeMs: 4_000,
    }]]))
    const loaded = await createSessionLedger(path).load()
    assert.equal(loaded.get('session-1').size, 128)
    assert.equal(loaded.get('session-1').mtimeMs, 4_000)
    await writeFile(path, JSON.stringify({
      version: 1,
      sessions: {
        legacy: {
          days: {}, turnCount: 0, stepCount: 0, generationMs: 0, timedOutputTokens: 0, live: false, updatedAt: 7,
        },
      },
    }), 'utf8')
    const legacy = await createSessionLedger(path).load()
    assert.ok(legacy.has('legacy'))
    assert.equal(legacy.get('legacy').updatedAt, 7)
    assert.equal(legacy.get('legacy').size, undefined)
    assert.equal(legacy.get('legacy').mtimeMs, undefined)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('readSessionStamps reports the newest artifact of every stored session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'llm-token-usage-'))
  try {
    const project = join(directory, '--work--')
    const session = join(project, 'session-a')
    await mkdir(session, { recursive: true })
    const log = join(session, 'session.v4.jsonl.zstd')
    await writeFile(log, 'x'.repeat(10))
    await utimes(log, new Date(1_000_000), new Date(1_000_000))
    const stamps = await readSessionStamps(directory)
    assert.equal(stamps.size, 1)
    assert.deepEqual(stamps.get('session-a'), { size: 10, mtimeMs: new Date(1_000_000).getTime() })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('readSessionStamps stays out of the way when no session log is there', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'llm-token-usage-'))
  try {
    await writeFile(join(directory, 'notes.txt'), 'x')
    assert.equal(await readSessionStamps(directory), undefined)
    assert.equal(await readSessionStamps(join(directory, 'missing')), undefined)
    assert.equal(await readSessionStamps(''), undefined)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a scan that runs out of budget reports the sessions still waiting', async () => {
  const records = Array.from({ length: 40 }, (_, index) => ({
    header: { id: `s${index}`, createdAt: 40 - index }, live: false,
  }))
  const query = {
    async listSessions() { return records },
    async readSession() {
      await new Promise((resolve) => { setTimeout(resolve, 20) })
      return { inheritedEventCount: 0, events: [] }
    },
  }
  const result = await collectTokenUsage(query, { days: 'all', scanTimeoutMs: 40, readTimeoutMs: 1_000 })
  assert.ok(result.pendingSessions >= 1)
  assert.equal(result.incomplete, true)
})

test('a truncated scan keeps draining its backlog in the background', async () => {
  const { createTokenUsageService } = await import('../lib/stats.js')
  const directory = await mkdtemp(join(tmpdir(), 'llm-token-usage-'))
  const records = Array.from({ length: 30 }, (_, index) => ({
    header: { id: `s${index}`, createdAt: 30 - index }, live: false,
  }))
  let scans = 0
  const query = {
    async listSessions() { scans += 1; return records },
    async readSession() {
      await new Promise((resolve) => { setTimeout(resolve, 20) })
      return { inheritedEventCount: 0, events: [] }
    },
  }
  const service = createTokenUsageService(query, {
    ledger: createSessionLedger(join(directory, 'ledger.json')),
    scanTimeoutMs: 30,
    catchUpDelayMs: 0,
    catchUpPasses: 6,
  })
  try {
    const first = await service.read({ range: 'all' })
    assert.ok(first.pendingSessions >= 1)
    await new Promise((resolve) => { setTimeout(resolve, 600) })
    assert.ok(scans >= 3, `expected background scans, saw ${scans}`)
    const settled = await service.read({ range: 'all' })
    assert.equal(settled.pendingSessions, 0)
    assert.equal(settled.cached, true)
  } finally {
    service.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('a complete scan schedules no background pass', async () => {
  const { createTokenUsageService } = await import('../lib/stats.js')
  let scans = 0
  const query = {
    async listSessions() { scans += 1; return [] },
    async readSession() { return { inheritedEventCount: 0, events: [] } },
  }
  const service = createTokenUsageService(query, { catchUpDelayMs: 0 })
  try {
    await service.read({ range: 'all' })
    await new Promise((resolve) => { setTimeout(resolve, 100) })
    assert.equal(scans, 1)
  } finally {
    service.dispose()
  }
})

test('one scan overlaps a small pool of Session reads', async () => {
  const records = Array.from({ length: 12 }, (_, index) => ({
    header: { id: `s${index}`, createdAt: 12 - index }, live: false,
  }))
  let active = 0
  let peak = 0
  const query = {
    async listSessions() { return records },
    async readSession() {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => { setTimeout(resolve, 10) })
      active -= 1
      return { inheritedEventCount: 0, events: [] }
    },
  }
  const result = await collectTokenUsage(query, { days: 'all', readTimeoutMs: 1_000 })
  assert.equal(result.pendingSessions, 0)
  assert.equal(result.sessionCount, 12)
  assert.ok(peak > 1, `expected overlapping reads, saw ${peak}`)
  assert.ok(peak <= 4, `expected the read pool to stay bounded, saw ${peak}`)
})

test('a failed background pass retries instead of ending the drain', async () => {
  const { createTokenUsageService } = await import('../lib/stats.js')
  const directory = await mkdtemp(join(tmpdir(), 'llm-token-usage-'))
  const records = Array.from({ length: 24 }, (_, index) => ({
    header: { id: `s${index}`, createdAt: 24 - index }, live: false,
  }))
  let scans = 0
  const query = {
    async listSessions() {
      scans += 1
      if (scans === 2) throw new Error('listing failed once')
      return records
    },
    async readSession() {
      await new Promise((resolve) => { setTimeout(resolve, 10) })
      return { inheritedEventCount: 0, events: [] }
    },
  }
  const service = createTokenUsageService(query, {
    ledger: createSessionLedger(join(directory, 'ledger.json')),
    scanTimeoutMs: 30,
    catchUpDelayMs: 0,
    catchUpPasses: 8,
  })
  try {
    const first = await service.read({ range: 'all' })
    assert.ok(first.pendingSessions >= 1)
    await new Promise((resolve) => { setTimeout(resolve, 800) })
    assert.ok(scans >= 4, `expected the drain to keep scanning, saw ${scans}`)
    const settled = await service.read({ range: 'all' })
    assert.equal(settled.pendingSessions, 0)
  } finally {
    service.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('a reader that walks away does not throw away the scan it started', async () => {
  const { createTokenUsageService } = await import('../lib/stats.js')
  const directory = await mkdtemp(join(tmpdir(), 'llm-token-usage-'))
  const records = Array.from({ length: 20 }, (_, index) => ({
    header: { id: `s${index}`, createdAt: 20 - index }, live: false,
  }))
  const query = {
    async listSessions() { return records },
    async readSession() {
      await new Promise((resolve) => { setTimeout(resolve, 10) })
      return { inheritedEventCount: 0, events: [] }
    },
  }
  const service = createTokenUsageService(query, {
    ledger: createSessionLedger(join(directory, 'ledger.json')),
    scanTimeoutMs: 25,
    catchUpDelayMs: 0,
    catchUpPasses: 8,
  })
  try {
    const controller = new AbortController()
    const first = service.read({ range: 'all', signal: controller.signal })
    controller.abort(new Error('panel closed'))
    await assert.rejects(first)
    await new Promise((resolve) => { setTimeout(resolve, 600) })
    const settled = await service.read({ range: 'all' })
    assert.equal(settled.pendingSessions, 0)
    assert.equal(settled.cached, true)
  } finally {
    service.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
