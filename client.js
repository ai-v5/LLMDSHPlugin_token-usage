/**
 * Client half of the `llm-dsh-token-usage` bundle plugin.
 *
 * Registers a sidebar footer action whose panel shows the all-time token total
 * and a GitHub-style daily calendar heatmap. Hovering a day shows its exact
 * input/output/cache/session breakdown.
 *
 * Plain-JS bundle format: `react` is the only runtime module, no JSX.
 */
window.__ModuleLoader__.load({
  id: 'llm-dsh-token-usage',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement

    /** Stats route owned by the host half of this bundle. */
    const STATS_PATH = '/api/llm-token-usage/stats'
    /** Marker attribute for the single injected stylesheet. */
    const STYLE_MARKER = 'data-llm-token-usage-style'
    /** Number of days the calendar shows, including today. */
    const CALENDAR_DAYS = 365

    /** Simplified Chinese dictionary. */
    const ZH = {
      trigger: 'Token 统计',
      panelTitle: 'Token 用量',
      refresh: '刷新',
      close: '关闭',
      total: '总量',
      inputOutput: '输入+输出',
      cacheRead: '缓存读取',
      cacheWrite: '缓存写入',
      sessions: '会话',
      today: '今日',
      activeDays: '活跃天数',
      calendarLabel: '每日 Token 用量日历',
      less: '少',
      more: '多',
      noUsage: '暂无用量',
      loading: '正在读取 Token 用量…',
      refreshing: '正在刷新…',
      empty: '还没有记录到 Token 用量。',
      loadFailed: (message) => `读取 Token 用量失败：${message}`,
      retry: '重试',
      incomplete: (count) => `${count} 个会话读取失败，统计可能不完整。`,
      truncated: '日历显示最近 365 天，顶部总量为全部历史。',
      tokens: 'tokens',
      monthNames: ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'],
      weekdays: ['一', '二', '三', '四', '五', '六', '日'],
    }

    /** English dictionary, key for key with {@link ZH}. */
    const EN = {
      trigger: 'Token usage',
      panelTitle: 'Token usage',
      refresh: 'Refresh',
      close: 'Close',
      total: 'Total',
      inputOutput: 'in + out',
      cacheRead: 'cache read',
      cacheWrite: 'cache write',
      sessions: 'Sessions',
      today: 'Today',
      activeDays: 'Active days',
      calendarLabel: 'Daily token usage calendar',
      less: 'Less',
      more: 'More',
      noUsage: 'No usage',
      loading: 'Loading token usage…',
      refreshing: 'Refreshing…',
      empty: 'No token usage recorded yet.',
      loadFailed: (message) => `Could not load token usage: ${message}`,
      retry: 'Retry',
      incomplete: (count) => `${count} session(s) could not be read; totals may be incomplete.`,
      truncated: 'The calendar shows the most recent 365 days; the headline covers all history.',
      tokens: 'tokens',
      monthNames: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
      weekdays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    }

    /** Chinese when the document or the browser asks for it, English otherwise. */
    function detectLanguage() {
      const fromDocument = typeof document === 'undefined' || document.documentElement === null
        ? ''
        : document.documentElement.lang
      const fromNavigator = typeof navigator === 'undefined' || typeof navigator.language !== 'string'
        ? ''
        : navigator.language
      const language = String(fromDocument || fromNavigator || '')
      return language.toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
    }

    /** Coerce a wire value to a finite non-negative count. */
    function numberOf(value) {
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
    }

    /** Drop trailing fractional zeros so `1.20M` still reads as `1.2M`. */
    function trimFraction(text) {
      return text.indexOf('.') === -1 ? text : text.replace(/\.?0+$/, '')
    }

    /** Compact token count: 1234, 12.3K, 345K, 1.2M, 3.4B. */
    function formatTokens(value) {
      const count = Math.round(numberOf(value))
      if (count < 1000) return String(count)
      if (count >= 1e9) return trimFraction((count / 1e9).toFixed(2)) + 'B'
      if (count >= 999950) return trimFraction((count / 1e6).toFixed(2)) + 'M'
      if (count >= 1e5) return Math.round(count / 1e3) + 'K'
      return trimFraction((count / 1e3).toFixed(1)) + 'K'
    }

    /** Exact token count with locale digit grouping. */
    function formatFull(value, language) {
      return (Number(value) || 0).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US')
    }

    /** Local calendar day key (`YYYY-MM-DD`). */
    function dayKey(date) {
      const month = String(date.getMonth() + 1).padStart(2, '0')
      const day = String(date.getDate()).padStart(2, '0')
      return `${date.getFullYear()}-${month}-${day}`
    }

    /** Midnight of the given date in the local timezone. */
    function startOfDay(value) {
      const date = new Date(value)
      return new Date(date.getFullYear(), date.getMonth(), date.getDate())
    }

    /** Add whole days without crossing a DST hour. */
    function addDays(date, days) {
      const next = new Date(date)
      next.setDate(next.getDate() + days)
      return next
    }

    /**
     * Build a Monday-first calendar grid ending today.
     * @param {readonly any[]} series - ascending daily buckets from the host.
     * @param {Date} today - local current day.
     * @returns {{ weeks: Array<Array<any>>, labels: Array<{ week: number, label: string }> }}
     */
    function buildCalendar(series, today) {
      const byDay = new Map(series.map(day => [day.date, day]))
      const end = startOfDay(today)
      const start = addDays(end, -(CALENDAR_DAYS - 1))
      start.setDate(start.getDate() - ((start.getDay() + 6) % 7))
      const weeks = []
      const labels = []
      let lastMonth = -1
      let cursor = start
      while (cursor <= end) {
        const week = []
        for (let row = 0; row < 7; row += 1) {
          const date = addDays(cursor, row)
          const key = dayKey(date)
          week.push({
            key,
            date,
            inRange: date >= start && date <= end,
            day: byDay.get(key),
          })
        }
        const first = week.find(cell => cell.inRange)
        if (first !== undefined && first.date.getMonth() !== lastMonth) {
          lastMonth = first.date.getMonth()
          labels.push({ week: weeks.length, month: lastMonth })
        }
        weeks.push(week)
        cursor = addDays(cursor, 7)
      }
      return { weeks, labels }
    }

    /** One compact bar-chart mark for the footer trigger. */
    function barChartIcon(size) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 20 20',
        fill: 'none',
        focusable: 'false',
        'aria-hidden': true,
        style: { display: 'block' },
      }, [
        h('rect', { key: 'left', x: 3.4, y: 9.6, width: 3, height: 6, rx: 1.4, fill: 'currentColor', opacity: 0.5 }),
        h('rect', { key: 'middle', x: 8.5, y: 5.2, width: 3, height: 10.4, rx: 1.4, fill: 'currentColor' }),
        h('rect', { key: 'right', x: 13.6, y: 11.9, width: 3, height: 3.7, rx: 1.4, fill: 'currentColor', opacity: 0.5 }),
      ])
    }

    /** Refresh glyph: a circular arrow. */
    function refreshIcon() {
      return h('svg', {
        width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', focusable: 'false', 'aria-hidden': true,
      }, [
        h('path', {
          key: 'arc',
          d: 'M13 8a5 5 0 1 1-1.6-3.7',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
        }),
        h('path', {
          key: 'head',
          d: 'M13.3 2.3v2.8h-2.8',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      ])
    }

    /** Close glyph: a cross. */
    function closeIcon() {
      return h('svg', {
        width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', focusable: 'false', 'aria-hidden': true,
      }, [
        h('path', {
          key: 'cross',
          d: 'M4.4 4.4 11.6 11.6M11.6 4.4 4.4 11.6',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
        }),
      ])
    }

    /** Both dictionaries, keyed by {@link detectLanguage}. */
    const MESSAGES = { zh: ZH, en: EN }

    /** Resolve the stats route against the page base so mounted Web prefixes work. */
    function statsUrl(refresh) {
      const url = new URL(STATS_PATH.slice(1), document.baseURI)
      url.searchParams.set('range', 'all')
      if (refresh) url.searchParams.set('refresh', '1')
      return url.toString()
    }

    /** Quantile thresholds keep the heatmap readable across very different ranges. */
    function thresholdsOf(values) {
      if (values.length === 0) return [0, 0, 0]
      const at = ratio => values[Math.min(values.length - 1, Math.floor(ratio * (values.length - 1)))]
      return [at(0.25), at(0.5), at(0.75)]
    }

    /** GitHub-style daily token heatmap with a hover/focus detail card. */
    function Calendar({ series, todayKey, t }) {
      const language = detectLanguage()
      const [hover, setHover] = React.useState(null)
      const calendar = React.useMemo(() => buildCalendar(series, new Date()), [series])
      const values = React.useMemo(
        () => series.map(day => numberOf(day.totalTokens)).filter(value => value > 0).sort((left, right) => left - right),
        [series],
      )
      const thresholds = React.useMemo(() => thresholdsOf(values), [values])
      const levelOf = (value) => {
        if (value <= 0) return 0
        if (value <= thresholds[0]) return 1
        if (value <= thresholds[1]) return 2
        if (value <= thresholds[2]) return 3
        return 4
      }
      const show = (event, cell) => {
        const rect = event.currentTarget.getBoundingClientRect()
        const day = cell.day ?? {
          totalTokens: 0, inputOutputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, sessions: 0,
        }
        const below = rect.top < 160
        const x = Math.min(Math.max(rect.left + rect.width / 2, 150), Math.max(150, window.innerWidth - 150))
        setHover({ x, y: below ? rect.bottom + 8 : rect.top - 6, below, key: cell.key, day })
      }
      const hide = () => { setHover(null) }
      const calendarNode = h('div', { className: 'llmtu-cal' }, [
        h('div', {
          key: 'months',
          className: 'llmtu-cal-months',
          style: { gridTemplateColumns: `repeat(${calendar.weeks.length}, var(--llmtu-cell))` },
        }, calendar.labels.map(label => h('span', {
          key: label.week,
          className: 'llmtu-cal-month',
          style: { gridColumn: String(label.week + 1) },
        }, t.monthNames[label.month]))),
        h('div', { key: 'body', className: 'llmtu-cal-body' }, [
          h('div', { key: 'weekdays', className: 'llmtu-cal-weekdays' }, t.weekdays.map((name, index) => h('span', {
            key: name,
            className: 'llmtu-cal-weekday',
          }, index === 0 || index === 2 || index === 4 ? name : ''))),
          h('div', { key: 'scroll', className: 'llmtu-cal-scroll' },
            h('div', { className: 'llmtu-cal-weeks' }, calendar.weeks.map((week, weekIndex) => h('div', {
              key: weekIndex,
              className: 'llmtu-cal-week',
            }, week.map(cell => h('div', {
              key: cell.key,
              className: 'llmtu-cal-cell',
              'data-level': cell.inRange ? levelOf(numberOf(cell.day?.totalTokens)) : 'blank',
              'data-today': cell.key === todayKey ? '' : undefined,
              tabIndex: cell.inRange && numberOf(cell.day?.totalTokens) > 0 ? 0 : undefined,
              role: cell.inRange ? 'img' : undefined,
              'aria-label': cell.inRange
                ? `${cell.key}: ${formatFull(cell.day?.totalTokens ?? 0, language)} ${t.tokens}`
                : undefined,
              onMouseEnter: cell.inRange ? event => { show(event, cell) } : undefined,
              onFocus: cell.inRange ? event => { show(event, cell) } : undefined,
              onMouseLeave: hide,
              onBlur: hide,
            })))))),
        ]),
        h('div', { key: 'legend', className: 'llmtu-cal-legend' }, [
          h('span', { key: 'less' }, t.less),
          ...[0, 1, 2, 3, 4].map(level => h('span', {
            key: level,
            className: 'llmtu-cal-swatch',
            'data-level': level,
          })),
          h('span', { key: 'more' }, t.more),
        ]),
      ])
      const tip = hover === null ? null : ReactDOM.createPortal(
        h('div', {
          className: 'llmtu-cal-tip',
          'data-placement': hover.below ? 'bottom' : 'top',
          style: { left: hover.x, top: hover.y },
          role: 'tooltip',
        }, [
          h('strong', { key: 'date', className: 'llmtu-cal-tip-date' }, hover.key),
          h('div', { key: 'total' }, `${t.total} ${formatFull(hover.day.totalTokens, language)}`),
          h('div', { key: 'io' }, `${t.inputOutput} ${formatFull(hover.day.inputOutputTokens, language)}`),
          h('div', { key: 'cache' },
            `${t.cacheRead} ${formatFull(hover.day.cacheReadTokens, language)} · ${t.cacheWrite} ${formatFull(hover.day.cacheWriteTokens, language)}`),
          h('div', { key: 'sessions' }, `${t.sessions} ${numberOf(hover.day.sessions)}`),
        ]),
        document.body,
      )
      return h(React.Fragment, null, calendarNode, tip)
    }

    /**
     * Sidebar footer action: a trigger matching the shipped Cordis geometry
     * (`wide` row vs. 36px rail icon) plus the all-time summary and calendar.
     * @param props - slot props; `wide` is the sidebar's expanded flag.
     */
    function TokenUsageAction({ wide }) {
      const language = detectLanguage()
      const t = MESSAGES[language]
      const [open, setOpen] = React.useState(false)
      const [sequence, setSequence] = React.useState(0)
      const [state, setState] = React.useState({ status: 'idle', data: null, error: null })
      const [anchor, setAnchor] = React.useState(null)
      const rootRef = React.useRef(null)
      const buttonRef = React.useRef(null)
      const refreshRef = React.useRef(false)

      /** Ask the next fetch for fresh host data (bypassing its 60s cache). */
      const requestRefresh = React.useCallback(() => {
        refreshRef.current = true
        setSequence(value => value + 1)
      }, [])

      React.useEffect(() => {
        if (!open) return undefined
        const controller = new AbortController()
        const refresh = refreshRef.current
        refreshRef.current = false
        setState(previous => ({ status: 'loading', data: previous.data, error: null }))
        const query = statsUrl(refresh)
        fetch(query, { cache: 'no-store', signal: controller.signal })
          .then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            return response.json()
          })
          .then((data) => {
            if (controller.signal.aborted) return
            setState({ status: 'ready', data, error: null })
          })
          .catch((error) => {
            if (controller.signal.aborted) return
            const message = error instanceof Error ? error.message : String(error)
            setState(previous => ({ status: 'error', data: previous.data, error: message }))
          })
        return () => { controller.abort() }
      }, [open, sequence])

      React.useLayoutEffect(() => {
        if (!open) return undefined
        const place = () => {
          const node = rootRef.current
          if (node === null) return
          const rect = node.getBoundingClientRect()
          setAnchor({ left: rect.left, bottom: window.innerHeight - rect.top + 8 })
        }
        place()
        window.addEventListener('resize', place)
        return () => { window.removeEventListener('resize', place) }
      }, [open])

      React.useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          const node = rootRef.current
          if (node !== null && event.target instanceof Node && node.contains(event.target)) return
          setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key !== 'Escape' || event.defaultPrevented) return
          setOpen(false)
          const trigger = buttonRef.current
          if (trigger !== null) trigger.focus()
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open])

      /** Move focus into the dialog when it mounts; keep it stable afterwards. */
      const setPanelRef = React.useCallback((node) => {
        if (node !== null) node.focus({ preventScroll: true })
      }, [])

      const data = state.data
      const series = data !== null && Array.isArray(data.series) ? data.series : []
      const all = data !== null && data.allTime !== null && data.allTime !== undefined ? data.allTime : null
      const today = data !== null && data.today !== null && data.today !== undefined ? data.today : null
      const todayKey = today !== null ? today.date : dayKey(new Date())
      const activeDays = series.reduce((count, day) => count + (numberOf(day.totalTokens) > 0 ? 1 : 0), 0)
      const hasUsage = all !== null && numberOf(all.totalTokens) > 0
      const skipped = data !== null ? numberOf(data.skippedSessions) : 0
      const busy = state.status === 'loading' || state.status === 'idle'

      const sections = []
      if (state.status === 'error') {
        sections.push(h('div', { key: 'error', className: 'llmtu-error', role: 'alert' }, [
          h('span', { key: 'message', children: t.loadFailed(state.error) }),
          h('button', { key: 'retry', type: 'button', className: 'llmtu-retry', onClick: requestRefresh }, t.retry),
        ]))
      }
      if (data === null) {
        if (state.status !== 'error') sections.push(h('p', { key: 'loading', className: 'llmtu-note' }, t.loading))
      } else {
        sections.push(h('div', { key: 'summary', className: 'llmtu-summary' }, [
          h('div', { key: 'head', className: 'llmtu-summary-head' }, [
            h('span', { key: 'label', className: 'llmtu-summary-label' }, t.total),
            h('span', { key: 'detail', className: 'llmtu-summary-detail' },
              `${t.inputOutput} ${formatTokens(all?.inputOutputTokens)} · ${t.cacheRead} ${formatTokens(all?.cacheReadTokens)}`),
            h('span', {
              key: 'value',
              className: 'llmtu-summary-value',
              title: formatFull(all?.totalTokens, language),
            }, formatTokens(all?.totalTokens)),
          ]),
          h('div', { key: 'meta', className: 'llmtu-summary-meta' },
            `${t.today} ${formatTokens(today?.totalTokens)} · ${t.activeDays} ${activeDays} · ${t.sessions} ${numberOf(data.sessionCount)}`),
        ]))
        sections.push(h(Calendar, { key: 'calendar', series, todayKey, t }))
        if (!hasUsage) sections.push(h('p', { key: 'empty', className: 'llmtu-note' }, t.empty))
        if (data.seriesTruncated === true) sections.push(h('p', { key: 'truncated', className: 'llmtu-note' }, t.truncated))
        if (skipped > 0 || data.incomplete === true) {
          sections.push(h('p', { key: 'incomplete', className: 'llmtu-note' }, t.incomplete(skipped)))
        }
      }
      if (busy && data !== null) sections.push(h('p', { key: 'refreshing', className: 'llmtu-note' }, t.refreshing))

      const trigger = h('button', {
        ref: buttonRef,
        type: 'button',
        className: 'llmtu-badge',
        'aria-label': t.trigger,
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        title: wide ? undefined : t.trigger,
        onClick: () => setOpen(value => !value),
      }, [
        h('span', { key: 'icon', className: 'llmtu-badge-icon', children: barChartIcon(wide ? 16 : 18) }),
        wide ? h('span', { key: 'label', className: 'llmtu-badge-label', children: t.trigger }) : null,
        wide && today !== null
          ? h('span', { key: 'count', className: 'llmtu-badge-count', children: formatTokens(today.totalTokens) })
          : null,
      ])

      const panel = open && anchor !== null
        ? h('section', {
          key: 'panel',
          ref: setPanelRef,
          className: 'llmtu-panel',
          role: 'dialog',
          'aria-label': t.panelTitle,
          tabIndex: -1,
          style: anchor,
        }, [
          h('header', { key: 'header', className: 'llmtu-header' }, [
            h('span', { key: 'title', className: 'llmtu-title', children: t.panelTitle }),
            h('div', { key: 'actions', className: 'llmtu-header-actions' }, [
              h('button', {
                key: 'refresh',
                type: 'button',
                className: 'llmtu-icon-button',
                'aria-label': t.refresh,
                title: t.refresh,
                disabled: busy,
                onClick: requestRefresh,
              }, refreshIcon()),
              h('button', {
                key: 'close',
                type: 'button',
                className: 'llmtu-icon-button',
                'aria-label': t.close,
                title: t.close,
                onClick: () => {
                  setOpen(false)
                  const node = buttonRef.current
                  if (node !== null) node.focus()
                },
              }, closeIcon()),
            ]),
          ]),
          h('div', { key: 'body', className: 'llmtu-body', 'aria-busy': busy }, sections),
        ])
        : null

      return h('div', {
        ref: rootRef,
        className: wide ? 'llmtu-layer' : 'llmtu-layer llmtu-rail',
      }, [
        panel,
        h('div', { key: 'buttons', className: 'llmtu-footer-buttons', children: trigger }),
      ])
    }

    /** All panel styling in one injected sheet; every value follows the host theme. */
    const STYLES = `
      .llmtu-layer{position:relative;display:flex;align-items:center;width:100%;height:42px;margin:8px 0 0;flex:none}
      .llmtu-layer.llmtu-rail{width:36px;height:36px;margin:0}
      .llmtu-footer-buttons{display:flex;align-items:center;width:100%}
      .llmtu-badge{display:inline-flex;align-items:center;gap:8px;width:calc(100% + 4px);height:42px;margin:0 -2px;padding:0 10px 0 8px;border:0;border-radius:12px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;cursor:pointer;overflow:hidden}
      .llmtu-badge:hover,.llmtu-badge[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover)}
      .llmtu-rail .llmtu-badge{justify-content:center;width:36px;height:36px;margin:0;padding:0;border-radius:50%}
      .llmtu-badge-icon{display:inline-flex;flex:none}
      .llmtu-badge-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .llmtu-badge-count{margin-left:auto;flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:16px;font-variant-numeric:tabular-nums}
      .llmtu-panel{position:fixed;isolation:isolate;z-index:40;display:flex;flex-direction:column;width:660px;max-width:calc(100vw - 24px);max-height:70vh;overflow:hidden;outline:none;border:0;border-radius:12px;box-shadow:var(--dsw-elevation-prominent);background:var(--dsw-specific-menu,#fff);backdrop-filter:var(--dsw-menu-backdrop-filter,none)}
      .llmtu-header{flex:none;display:flex;align-items:center;gap:8px;min-height:44px;padding:10px 12px;box-sizing:border-box}
      .llmtu-title{flex:1;min-width:0;font-size:14px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary,#1f2328)}
      .llmtu-header-actions{display:flex;align-items:center;gap:4px}
      .llmtu-icon-button{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-tertiary,#8b949e);cursor:pointer}
      .llmtu-icon-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#1f2328)}
      .llmtu-icon-button:disabled{opacity:.4;cursor:default}
      .llmtu-body{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:0 12px 12px}
      .llmtu-summary{padding:10px 12px;border:0.5px solid var(--dsw-alias-border-l4,rgba(127,127,127,.14));border-radius:10px}
      .llmtu-summary-head{display:flex;align-items:baseline;gap:10px;min-width:0}
      .llmtu-summary-label{flex:none;font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary,#1f2328)}
      .llmtu-summary-detail{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8b949e);font-variant-numeric:tabular-nums}
      .llmtu-summary-value{flex:none;font-size:22px;font-weight:600;line-height:28px;color:var(--dsw-alias-label-primary,#1f2328);font-variant-numeric:tabular-nums}
      .llmtu-summary-meta{margin-top:4px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8b949e);font-variant-numeric:tabular-nums}
      .llmtu-cal{--llmtu-cell:9px;margin-top:14px}
      .llmtu-cal-months{display:grid;column-gap:2px;height:14px;margin:0 0 2px 28px;color:var(--dsw-alias-label-caption,#8b949e);font-size:9px;line-height:12px;white-space:nowrap}
      .llmtu-cal-month{grid-row:1;overflow:visible}
      .llmtu-cal-body{display:flex;gap:6px;min-width:0}
      .llmtu-cal-weekdays{display:grid;grid-template-rows:repeat(7,var(--llmtu-cell));gap:2px;width:22px;flex:none;color:var(--dsw-alias-label-caption,#8b949e);font-size:9px;line-height:var(--llmtu-cell);text-align:right}
      .llmtu-cal-scroll{min-width:0;overflow:visible}
      .llmtu-cal-weeks{display:flex;gap:2px}
      .llmtu-cal-week{display:grid;grid-template-rows:repeat(7,var(--llmtu-cell));gap:2px}
      .llmtu-cal-cell{width:var(--llmtu-cell);height:var(--llmtu-cell);border-radius:2px;background:var(--dsw-alias-border-l4,rgba(127,127,127,.2));opacity:.35;outline:none}
      .llmtu-cal-cell[data-level="1"]{background:var(--dsw-alias-state-business-primary,#2563eb);opacity:.2}
      .llmtu-cal-cell[data-level="2"]{background:var(--dsw-alias-state-business-primary,#2563eb);opacity:.4}
      .llmtu-cal-cell[data-level="3"]{background:var(--dsw-alias-state-business-primary,#2563eb);opacity:.65}
      .llmtu-cal-cell[data-level="4"]{background:var(--dsw-alias-state-business-primary,#2563eb);opacity:.95}
      .llmtu-cal-cell[data-level="blank"]{background:transparent;opacity:0;pointer-events:none}
      .llmtu-cal-cell[data-level]:not([data-level="blank"]):hover,.llmtu-cal-cell[data-level]:not([data-level="blank"]):focus{box-shadow:0 0 0 1px var(--dsw-alias-label-primary,#1f2328);opacity:1}
      .llmtu-cal-cell[data-today]{box-shadow:0 0 0 1px var(--dsw-alias-label-tertiary,#8b949e)}
      .llmtu-cal-legend{display:flex;align-items:center;justify-content:flex-end;gap:4px;margin-top:8px;color:var(--dsw-alias-label-tertiary,#8b949e);font-size:10px;line-height:14px}
      .llmtu-cal-swatch{width:10px;height:10px;border-radius:2px;background:var(--dsw-alias-border-l4,rgba(127,127,127,.2));opacity:.35}
      .llmtu-cal-swatch[data-level="1"]{background:var(--dsw-alias-state-business-primary,#2563eb);opacity:.2}
      .llmtu-cal-swatch[data-level="2"]{background:var(--dsw-alias-state-business-primary,#2563eb);opacity:.4}
      .llmtu-cal-swatch[data-level="3"]{background:var(--dsw-alias-state-business-primary,#2563eb);opacity:.65}
      .llmtu-cal-swatch[data-level="4"]{background:var(--dsw-alias-state-business-primary,#2563eb);opacity:.95}
      .llmtu-cal-tip{position:fixed;z-index:1000;min-width:180px;max-width:280px;padding:8px 10px;border:0.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));border-radius:8px;background:var(--dsw-specific-menu,#fff);box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.18));color:var(--dsw-alias-label-secondary,#57606a);font-size:11px;line-height:17px;font-variant-numeric:tabular-nums;pointer-events:none;transform:translate(-50%,-100%);margin-top:-6px}
      .llmtu-cal-tip[data-placement="bottom"]{transform:translate(-50%,0);margin-top:0}
      .llmtu-cal-tip-date{display:block;margin-bottom:3px;color:var(--dsw-alias-label-primary,#1f2328);font-size:12px;line-height:18px}
      .llmtu-note{margin:8px 0 0;color:var(--dsw-alias-label-tertiary,#8b949e);font-size:12px;line-height:18px}
      .llmtu-error{display:flex;align-items:center;gap:8px;margin:8px 0;color:var(--dsw-alias-state-error-primary,#d1242f);font-size:12px;line-height:18px}
      .llmtu-retry{margin-left:auto;flex:none;padding:2px 8px;border:0.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));border-radius:999px;background:transparent;color:inherit;font:inherit;font-size:11px;cursor:pointer}
      .llmtu-retry:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
      @media (max-width:700px){.llmtu-panel{width:calc(100vw - 24px)}.llmtu-cal{--llmtu-cell:7px}}
      @media (max-width:560px){.llmtu-cal{--llmtu-cell:6px}}
    `
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          for (const stale of document.querySelectorAll(`style[${STYLE_MARKER}]`)) stale.remove()
          const style = document.createElement('style')
          style.setAttribute(STYLE_MARKER, '')
          style.textContent = STYLES
          document.head.appendChild(style)
          return () => { style.remove() }
        }, 'llm-token-usage: styles')
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'token-usage',
          order: 10,
          label: 'Token usage',
        }, TokenUsageAction))
      },
    }
  },
})
