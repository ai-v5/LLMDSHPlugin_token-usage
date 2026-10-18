import test from 'node:test'
import assert from 'node:assert/strict'
import {
  EMPTY_BUCKETS, foldSessionEvents, buildStats, localDay, usageOfEvent,
} from '../lib/stats.js'

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
