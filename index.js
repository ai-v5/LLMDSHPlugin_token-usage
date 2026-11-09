/** Host half: expose per-day token usage from the Session corpus. */
import { createSessionLedger } from './lib/ledger.js'
import { readSessionStamps } from './lib/scan-index.js'
import { createTokenUsageService, normalizeRange } from './lib/stats.js'

export const name = 'llm-token-usage'

export const inject = ['sessionQuery', 'connection', 'dshHomePath']

const STATS_PATH = '/api/llm-token-usage/stats'

export function apply(ctx) {
  const ledger = createLedger(ctx)
  const service = createTokenUsageService(ctx.sessionQuery, {
    ...(ledger === undefined ? {} : { ledger }),
    sessionStamps: createStampsReader(ctx),
    logger: ctx.logger,
  })
  ctx.effect(() => {
    const dispose = ctx.connection.fetch.register({
      path: STATS_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: (request) => handle(ctx, service, request),
    })
    return () => {
      void dispose()
      service.dispose()
    }
  }, 'llm-token-usage: stats route')
}

/** Use the Host home service when present; tests and embedded callers may omit it. */
function createLedger(ctx) {
  return typeof ctx.dshHomePath === 'function'
    ? createSessionLedger(ctx.dshHomePath('token-usage-ledger.json'))
    : undefined
}

/**
 * Stat the stored Session logs so a scan can skip the ones that did not change.
 * The Host owns that layout; when it is unknown the reader yields `undefined`
 * and the service falls back to re-reading on liveness alone.
 */
function createStampsReader(ctx) {
  if (typeof ctx.dshHomePath !== 'function') return undefined
  const root = ctx.dshHomePath('sessions')
  return () => readSessionStamps(root)
}

async function handle(ctx, service, request) {
  try {
    const url = new URL(request.url)
    const range = url.searchParams.get('range') === 'all'
      ? 'all'
      : normalizeRange(url.searchParams.get('days') || 30)
    const refresh = url.searchParams.get('refresh') === '1'
    const value = await service.read({ range, refresh, signal: request.signal })
    return Response.json(value, { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 })
    ctx.logger?.warn?.('llm-token-usage: stats read failed', error)
    return Response.json({ error: 'token-usage-unavailable' }, { status: 500 })
  }
}
