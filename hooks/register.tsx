import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register, ResolveInput } from 'claude-code'

import type { ContextState, LongRunState, RateWindow } from '../types'

const lastHitAt = atom({ plugin: 'long-live-the-claude', key: 'lastHitAt' } as const, null)
const limits = atom({ plugin: 'long-live-the-claude', key: 'limits' } as const, [])
const warm = atom({ plugin: 'long-live-the-claude', key: 'warm' } as const, {
  count: 0,
  isFailing: false,
  isBroken: false,
  lastTurnAt: null,
  note: null,
})
const LONG_RUN_OFF: LongRunState = {
  isOn: false,
  phase: 'run',
  resetsAt: null,
  isReminded: false,
  pausedAt: null,
  held: [],
  isIdle: false,
}
const longRun = atom({ plugin: 'long-live-the-claude', key: 'longRun' } as const, LONG_RUN_OFF)
const now = atom({ plugin: 'long-live-the-claude', key: 'now' } as const, 0)
const context = atom({ plugin: 'long-live-the-claude', key: 'context' } as const, null)
const expanded = atom({ plugin: 'long-live-the-claude', key: 'expanded' } as const, false)

// The session's cache TTL. The plugin API cannot read it, so we assume the 1-hour TTL
// Claude Code uses on a subscription; if it is really 5 minutes, the first keep-alive
// misses, which we detect and then stop keeping warm.
const TTL_MS = 60 * 60 * 1000
// How long before expiry to refresh
const LEAD_MS = 3 * 60 * 1000
// How long to wait before retrying a failed keep-alive
const RETRY_MS = 60 * 1000
// Stop keeping warm once the main conversation has been idle this long. A cache hit costs
// 1/20 of the base input price and rebuilding a 1-hour cache costs 2x, so about 40
// keep-alives (~38 hours) cost as much as one rebuild; keep some margin.
const IDLE_CAP_MS = 36 * 3600_000
// A keep-alive whose cache-read share is below this is treated as a miss
const HIT_RATIO = 0.5

const KEEPALIVE_PROMPT =
  '[cache keep-alive] This is an automatic keep-alive request from the long-live-the-claude plugin. Nothing to do; reply with just "ok".'

// Check-in: while the model has not marked [idle], an idle gap is refreshed by a turn in the main
// conversation instead of a fork. The person sees only this short line; the instructions are
// appended as a row only the model reads
const NUDGE_LABEL = '[long run] check-in'
const nudgeText = (idleFor: number) =>
  `[long-live-the-claude · long-run check-in] The main conversation has been idle for about ${roughly(idleFor)}. ` +
  'This is an automatic check-in from the plugin, not a new message from the user. ' +
  'If there is work to move forward, or a background task or remote job you were waiting on should have finished by now, check on it and continue. ' +
  'If what you are waiting on is still running normally, a brief confirmation before ending the turn is enough; no extra work is needed. ' +
  'If you judge that you should genuinely stop (the task is done, or you are waiting for the user), put [idle] alone on the last line of your reply: ' +
  'check-ins then stop and only the cache is kept warm, until a new message arrives in the conversation.'
// The reply's last line is [idle] on its own
const IDLE_MARK = /(^|\n)[ \t]*\[idle\][ \t]*$/

// Long-run mode: once the 5-hour window reaches this percentage, ask the model to wrap up
// and pause after the turn until the window resets
const PAUSE_AT = 95
// Wait a little after the reset before waking, so we do not hit a window that has not rolled over yet
const WAKE_DELAY_MS = 2 * 60_000
// Inputs held back while paused: background task notifications and scheduled triggers.
// What the person types always goes through.
const HELD_ORIGINS = new Set(['task-notification', 'scheduled-trigger'])

// Share of the compaction window at which the context reading turns yellow / red
// (auto-compaction fires at about 93%)
const CONTEXT_WARN = 0.7
const CONTEXT_DANGER = 0.85

// The compaction window comes from /context's breakdown: rawMaxTokens already resolves env vars,
// settings and model defaults, and auto-compaction fires at it minus the reserved buffer row.
// The breakdown is a local estimate (no request). It is configuration, so we read it at session
// start and on model switch only; the token count follows every response.
async function loadContext($: Engine) {
  const u = await $.session.usage({ breakdown: 'summary' })
  const b = u.context.breakdown
  const limit = b?.rawMaxTokens ?? u.context.window
  const buffer = b?.categories.find(c => c.kind === 'buffer')?.tokens ?? 0
  await update($, context, () => ({
    tokens: u.context.tokens,
    limit,
    compactAt: limit - buffer,
    window: u.context.window,
  }))
}

// Each window's length, and how long to observe before projecting: early in a window there are
// too few samples and the average rate is badly overestimated
const WINDOWS: Record<string, { length: number; minElapsed: number }> = {
  five_hour: { length: 5 * 3600_000, minElapsed: 30 * 60_000 },
  seven_day: { length: 7 * 24 * 3600_000, minElapsed: 12 * 3600_000 },
}

// Extrapolates the average rate since the window began to the reset. restAtReset may be negative
// (runs out early), in which case runsOutIn is how long the same rate lasts; null when the
// window is unknown or has not been observed long enough
function project(kind: string, used: number, resetIn: number) {
  const w = WINDOWS[kind]
  if (w === undefined) return null
  const elapsed = w.length - resetIn
  if (elapsed < w.minElapsed) return null
  const rate = used / elapsed
  const restAtReset = 100 - rate * w.length

  return { restAtReset, runsOutIn: restAtReset < 0 ? Math.max(0, (100 - used) / rate) : null }
}

const pad = (n: number) => String(n).padStart(2, '0')

const countdown = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)

  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`
}

const roughly = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)

  return h < 24 ? `${h}h${pad(m % 60)}m` : `${Math.floor(h / 24)}d${h % 24}h`
}

const toWindows = (list: readonly RateWindow[]): RateWindow[] =>
  list.map(w => ({ kind: w.kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt }))

// Whether a main-conversation turn is running: no keep-alive then, the turn refreshes the cache itself
let isBusy = false
let isForking = false
let retryAt = 0
// For testing: refresh every this many ms instead of 3 minutes before expiry. Module-only, gone on reload.
let debugEveryMs: number | null = null

// ---- Long-run mode ----

// The switch and the pause are kept per session in $.store, so they survive an app restart
// or a resumed conversation; turning the mode off deletes the entry
let storeKey: string | null = null
let isWaking = false
let wakeRetryAt = 0
// Check-ins: isNudging while a submission is on its way in; isNudgeTurn while a check-in's turn runs;
// nudgeSteps counts that turn's requests, and more than one means the model got to work (real activity)
let isNudging = false
let isNudgeTurn = false
let nudgeSteps = 0
let nudgeIdleFor = 0

async function setLongRun($: Engine, fn: (x: LongRunState) => LongRunState) {
  await update($, longRun, fn)
  if (storeKey === null) return
  const x = await read($, longRun)
  if (x.isOn) await $.store.set(storeKey, x)
  else await $.store.delete(storeKey)
}

const hhmm = (ms: number) => {
  const d = new Date(ms)

  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const reminderText = (resetsAt: number) =>
  `The 5-hour usage limit has reached ${PAUSE_AT}% and resets at ${hhmm(resetsAt)}. ` +
  'Please bring the current step to a natural stopping point and end this turn. ' +
  `The session will then pause and resume automatically at ${hhmm(resetsAt + WAKE_DELAY_MS)}; ` +
  'background task notifications that arrive during the pause will be delivered when it resumes.'

// Called when the usage readings change: with long-run mode on and running normally,
// crossing the threshold on the 5-hour window starts the wind-down
async function checkQuota($: Engine, list: readonly RateWindow[]) {
  const lr = await read($, longRun)
  if (!lr.isOn || lr.phase !== 'run') return
  const five = list.find(x => x.kind === 'five_hour')
  if (five?.resetsAt === undefined || five.percentUsed < PAUSE_AT) return
  const resetsAt = Date.parse(five.resetsAt)
  // A stale reading past its reset (just woke, the new window's response has not arrived) does not count
  if (!(resetsAt > (await $.clock.now()))) return
  await startWinding($, resetsAt)
}

async function startWinding($: Engine, resetsAt: number) {
  await setLongRun($, x => ({ ...x, phase: 'winding', resetsAt, isReminded: false }))
  // The turn has already ended (the limit was crossed by its last request): no tool call is
  // left to carry the reminder, so pause right away
  if (!isBusy) await enterPause($)
}

async function enterPause($: Engine) {
  const t = await $.clock.now()
  await setLongRun($, x => ({ ...x, phase: 'paused', pausedAt: t, held: [] }))
  const lr = await read($, longRun)
  if (lr.resetsAt !== null) $.ui.toast(`Long run: paused, resumes at ${hhmm(lr.resetsAt + WAKE_DELAY_MS)}`)
}

// Ends the pause: the reset came (reset), or long-run mode was turned off mid-pause (off).
// Held notifications go to the model with this prompt; turning off with none held sends nothing
async function wake($: Engine, reason: 'reset' | 'off') {
  if (isWaking) return
  isWaking = true
  try {
    const lr = await read($, longRun)
    const t = await $.clock.now()
    const parts =
      reason === 'reset'
        ? [`The 5-hour usage limit has reset (paused for ${roughly(t - (lr.pausedAt ?? t))}). You can continue where you left off.`]
        : ['Long-run mode was turned off, so the pause ended early.']
    if (lr.held.length > 0) {
      const n = lr.held.length
      parts.push(`${n} background notification${n === 1 ? '' : 's'} arrived during the pause:`, ...lr.held)
    }

    await setLongRun($, x => ({ ...x, phase: 'run', resetsAt: null, isReminded: false, pausedAt: null, held: [] }))
    if (reason === 'off' && lr.held.length === 0) return

    const r = await $.prompt.submit({ text: parts.join('\n\n') }).catch((err: unknown) => ({ drop: String(err) }))
    if (r.drop !== undefined && reason === 'reset') {
      // Not delivered (a dialog in the way, say): go back to the pause and retry in a minute
      wakeRetryAt = t + RETRY_MS
      await setLongRun($, () => lr)
      $.ui.toast(`Long run: wake-up not delivered (${r.drop}); retrying in 1 minute`)
    }
  } finally {
    isWaking = false
  }
}

async function setLongRunOn($: Engine, isOn: boolean) {
  const lr = await read($, longRun)
  if (isOn === lr.isOn) return
  if (!isOn) {
    if (lr.phase === 'paused') await wake($, 'off')
    await setLongRun($, () => LONG_RUN_OFF)

    return
  }
  retryAt = 0
  debugEveryMs = null
  await update($, warm, w => ({ ...w, count: 0, isFailing: false, isBroken: false, note: null }))
  await setLongRun($, () => ({ ...LONG_RUN_OFF, isOn: true }))
  await checkQuota($, await read($, limits))
}

// Sends one keep-alive and returns a note for people. Only automatic keep-alives touch the warm
// state; a manual one (the Refresh button, /long-run test) just returns its result.
async function keepAlive($: Engine, reason: 'auto' | 'manual'): Promise<string> {
  isForking = true
  try {
    const r = await $.model.fork({ prompt: KEEPALIVE_PROMPT })
    const t = await $.clock.now()

    if (!r.isAnswered) {
      const why = r.reason === 'api-error' ? `api-error ${r.status ?? ''}`.trim() : r.reason
      const note = `Keep-alive failed: ${why}`
      if (reason === 'auto') {
        retryAt = t + RETRY_MS
        const w = await read($, warm)
        // Toast on the first failure only; the retries every minute stay quiet
        if (!w.isFailing) $.ui.toast(`${note}; retrying in 1 minute`)
        await update($, warm, x => ({ ...x, isFailing: true, note }))
      }

      return note
    }

    const u = r.usage
    const total = u.cache_read_input_tokens + u.cache_creation_input_tokens + u.input_tokens
    const ratio = total > 0 ? u.cache_read_input_tokens / total : 0
    const k = (n: number) => `${Math.round(n / 1000)}k`
    await update($, lastHitAt, () => t)

    if (ratio < HIT_RATIO) {
      // A miss: the cache expired before we refreshed it (most likely the TTL is really 5 minutes).
      // This request rebuilt it, but refreshing on a 1-hour rhythm is pointless, so automatic
      // keep-alive stops; the usage pause keeps working
      const note = `Cache miss (read ${k(u.cache_read_input_tokens)} of ${k(total)}), rebuilt`
      if (reason === 'auto') {
        await update($, warm, w => ({
          ...w,
          isBroken: true,
          isFailing: false,
          note: `${note}; the TTL is probably not 1 hour, keep-alive stopped (turn long-run mode on again to retry)`,
        }))
        $.ui.toast('Keep-alive missed the cache; automatic keep-alive stopped')
      }

      return note
    }

    const note = `Last: keep-alive hit ${Math.round(ratio * 100)}% (${k(u.cache_read_input_tokens)})`
    if (reason === 'auto') {
      await update($, warm, w => ({ ...w, count: w.count + 1, isFailing: false, note }))
    }

    return note
  } finally {
    isForking = false
  }
}

// Starts a check-in turn in the main conversation
async function nudge($: Engine): Promise<string> {
  const t = await $.clock.now()
  const w = await read($, warm)
  nudgeIdleFor = w.lastTurnAt === null ? 0 : t - w.lastTurnAt
  isNudging = true
  try {
    // The instructions go in first as a row the person does not see and the model reads (context a
    // prompt.submit hook attaches to the plugin's own submission does not reach the model), then a
    // short prompt starts the turn
    const a = await $.session.append({
      message: { type: 'user', content: [{ type: 'text', text: `<system-reminder>\n${nudgeText(nudgeIdleFor)}\n</system-reminder>` }] },
    })
    if (a.deny !== undefined) $.ui.toast(`Check-in instructions not appended (${a.deny})`)
    const r = await $.prompt.submit({ text: NUDGE_LABEL }).catch((err: unknown) => ({ drop: String(err) }))
    if (r.drop !== undefined) {
      const note = `Check-in not delivered: ${r.drop}`
      retryAt = t + RETRY_MS
      if (!w.isFailing) $.ui.toast(`${note}; retrying in 1 minute`)
      await update($, warm, x => ({ ...x, isFailing: true, note }))

      return note
    }
    // The turn has started; turn.start sets this too, but claim it now so the next tick does not resend.
    // isNudgeTurn is set here as well: the plugin's own prompt.submit hook may not see its own submission
    isBusy = true
    if (!isNudgeTurn) {
      isNudgeTurn = true
      nudgeSteps = 0
    }
    const note = `Last: check-in (idle ${roughly(nudgeIdleFor)})`
    await update($, warm, x => ({ ...x, count: x.count + 1, isFailing: false, note }))

    return note
  } finally {
    isNudging = false
  }
}

async function tick($: Engine) {
  const t = await $.clock.now()
  await update($, now, () => t)

  const lr = await read($, longRun)
  if (!lr.isOn) return

  // The pause is over: wake up
  if (lr.phase === 'paused' && lr.resetsAt !== null && t >= lr.resetsAt + WAKE_DELAY_MS && t >= wakeRetryAt) {
    await wake($, 'reset')

    return
  }

  const w = await read($, warm)
  const hit = await read($, lastHitAt)
  if (w.isBroken || hit === null || isBusy || isForking || isNudging || t < retryAt) return
  // Idle too long: refreshing further would cost more than one rebuild on return; wait for the next real request
  if (w.lastTurnAt !== null && t - w.lastTurnAt > IDLE_CAP_MS) return
  // By the local clock the cache has expired: the timer could not refresh in time (the machine
  // most likely slept). A request now must miss and says nothing about the TTL; reset and wait
  // for the next real request to build a fresh cache.
  if (t >= hit + TTL_MS) {
    await update($, lastHitAt, () => null)
    await update($, warm, x => ({ ...x, isFailing: false, note: 'Cache expired while the machine slept; timing restarts at the next request' }))

    return
  }
  const dueAt = debugEveryMs !== null ? hit + debugEveryMs : hit + TTL_MS - LEAD_MS
  if (t < dueAt) return
  // The model has not said it is done: ask in the conversation, which refreshes the cache too;
  // once it has (or while winding down or paused), just fork a keep-alive
  if (lr.phase === 'run' && !lr.isIdle) await nudge($)
  else await keepAlive($, 'auto')
}

// ---- The band above the prompt ----
const BAR_W = 72
const BAR_H = 6
const RING = 14
const OK = '#4f9d69'
const WARN = '#d9a036'
const DANGER = '#d1453b'
const MUTED = '#9a9a9a'
// The ring's color while keep-alive is on and the cache is healthy; near expiry, expired or
// failing still win with yellow / red
const WARM = '#4a90d9'
// The part expected to be used up before the reset is drawn translucent
const FADE = 0.55
const CLAY = '#c96442'

// pct is the share left: the bar shortens as it runs down and turns yellow, then red.
// mark is the share projected to be left at the reset: the bar past mark is drawn translucent,
// the part the current rate will use up; without it the bar is solid
function barSvg(pct: number, mark?: number) {
  const p = Math.max(0, Math.min(100, pct))
  const fill = p <= 20 ? DANGER : p <= 40 ? WARN : CLAY
  const width = (q: number) => Math.max(q > 0 ? BAR_H : 0, (BAR_W * q) / 100)
  const solid = mark === undefined ? p : Math.max(0, Math.min(p, mark))
  const rect = (q: number, opacity: number) =>
    q > 0
      ? `<rect width="${width(q).toFixed(1)}" height="${BAR_H}" rx="${BAR_H / 2}" fill="${fill}" fill-opacity="${opacity}"/>`
      : ''

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${BAR_W}" height="${BAR_H}" viewBox="0 0 ${BAR_W} ${BAR_H}"><rect width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}" fill="${MUTED}" fill-opacity="0.25"/>${solid < p ? rect(p, FADE) : ''}${rect(solid, 1)}</svg>`
}

// dot marks keep-alive as on: a filled dot in the ring's center, for when color alone is not enough
function ringSvg(fraction: number, color: string, dot: string | null) {
  const f = Math.max(0, Math.min(1, fraction))
  const r = RING / 2 - 1.5
  const c = 2 * Math.PI * r
  const center = dot === null ? '' : `<circle cx="${RING / 2}" cy="${RING / 2}" r="2" fill="${dot}"/>`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${RING}" height="${RING}" viewBox="0 0 ${RING} ${RING}"><circle cx="${RING / 2}" cy="${RING / 2}" r="${r}" fill="none" stroke="${MUTED}" stroke-opacity="0.3" stroke-width="2.5"/><circle cx="${RING / 2}" cy="${RING / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="${(c * f).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 ${RING / 2} ${RING / 2})"/>${center}</svg>`
}

function barText(pct: number) {
  const n = Math.round(Math.max(0, Math.min(100, pct)) / 20)

  return '▰'.repeat(n) + '▱'.repeat(5 - n)
}

async function drawBand($: Engine, e: ResolveInput) {
  const els = $.ui.resolve(e)
  const { Box, Button, Text } = els
  const Svg = 'Svg' in els ? els.Svg : undefined
  const t = (await read($, now)) || Date.now()
  const list = await read($, limits)
  const hit = await read($, lastHitAt)
  const w = await read($, warm)
  const lr = await read($, longRun)
  const ctx = await read($, context)
  const isIdleTooLong = w.lastTurnAt !== null && t - w.lastTurnAt > IDLE_CAP_MS
  // Keep-alive is actually working: long-run mode on, not stopped, not idle too long
  const isWarming = lr.isOn && !w.isBroken && !isIdleTooLong

  const five = list.find(x => x.kind === 'five_hour')
  const week = list.find(x => x.kind === 'seven_day')
  const left = hit === null ? null : hit + TTL_MS - t
  // The ring's color: first whether the cache is near expiry or expired, then whether keep-alive
  // is failing; otherwise the keep-alive color while it is on
  const cacheTone =
    left === null
      ? MUTED
      : left <= 0
        ? DANGER
        : left <= LEAD_MS
          ? WARN
          : isWarming && w.isFailing
            ? WARN
            : isWarming
              ? WARM
              : OK
  const dot = isWarming ? (w.isFailing ? WARN : WARM) : null

  // SVG on the desktop, characters in the terminal
  const meter = (pct: number, label: string, mark?: number) =>
    Svg ? (
      <Svg source={barSvg(pct, mark)} alt={label} width={BAR_W} height={BAR_H} />
    ) : (
      <Text color={pct <= 20 ? 'error' : undefined} dimColor={pct > 20}>
        {barText(pct)}
      </Text>
    )

  const k = (n: number) => (n >= 1e6 ? `${Math.round(n / 1e5) / 10}M` : `${Math.round(n / 1000)}k`)

  // ---- Main row: the standing readings and the buttons; its width does not change when expanded ----
  const usage = (name: string, win: RateWindow) => {
    // Shows what is left; percentUsed has at most one decimal and exceeds 100 past the limit
    const rest = Math.max(0, Math.round((100 - win.percentUsed) * 10) / 10)
    const resetIn = win.resetsAt === undefined ? null : Date.parse(win.resetsAt) - t
    const p = resetIn === null ? null : project(win.kind, win.percentUsed, resetIn)

    return (
      <Box gap={1} alignItems="center">
        {meter(rest, `${name} ${rest}% left`, p === null ? undefined : Math.max(0, p.restAtReset))}
        <Text bold={rest <= 20}>{`${rest}%`}</Text>
      </Box>
    )
  }

  // Context against the compaction window (the same basis as /context's percentage), with no bar:
  // it answers "how far from auto-compaction", not "how much is left"
  const contextText = (c: ContextState & { tokens: number }) => {
    const used = c.tokens / c.limit
    const tone = used >= CONTEXT_DANGER ? 'error' : used >= CONTEXT_WARN ? 'warning' : undefined

    return (
      <Box gap={1} alignItems="center">
        <Text dimColor>ctx</Text>
        <Text color={tone} bold={tone === 'error'}>{`${k(c.tokens)} / ${k(c.limit)}`}</Text>
      </Box>
    )
  }

  const cacheText = left === null ? '—' : left > 0 ? countdown(left) : 'expired'

  // ---- Details: click the band to expand. Where the surface has Client each detail sits right below
  // its reading; elsewhere they fall back to a row of their own ----
  const resetLines = (win: RateWindow) => {
    if (win.resetsAt === undefined) return []
    const resetIn = Date.parse(win.resetsAt) - t
    const p = project(win.kind, win.percentUsed, resetIn)

    // The bar's translucent part already shows what is projected to be left; here we only warn when it runs out early
    return [`resets in ${roughly(resetIn)}`, p?.runsOutIn != null ? `runs out in ~${roughly(p.runsOutIn)}` : null]
  }

  // Long-run pause: a short badge in the main row
  const wakeAt = lr.resetsAt === null ? null : lr.resetsAt + WAKE_DELAY_MS
  const pauseBadge =
    !lr.isOn || wakeAt === null
      ? null
      : lr.phase === 'winding'
        ? 'Winding down'
        : lr.phase === 'paused'
          ? `Paused · resumes ${hhmm(wakeAt)}${lr.held.length > 0 ? ` · ${lr.held.length} held` : ''}`
          : null
  // The details below the cache column: two lines at most, each truncated rather than wrapped, so
  // they never push the buttons out
  const held = lr.held.length
  const keeperLines: (string | null)[] = !lr.isOn
    ? [w.note]
    : lr.phase === 'winding' && wakeAt !== null
      ? [`Winding down · ${lr.isReminded ? 'model asked to wrap up' : 'asks at the next tool call'} · resumes ${hhmm(wakeAt)}`]
      : lr.phase === 'paused' && wakeAt !== null
        ? [`Paused · resumes in ${roughly(wakeAt - t)} (${hhmm(wakeAt)})`, `${held} notification${held === 1 ? '' : 's'} held`]
        : w.isBroken || w.isFailing
          ? [w.note]
          : isIdleTooLong
            ? [`Idle over ${IDLE_CAP_MS / 3600_000}h, stopped`, 'resumes at the next request']
            : hit === null
              ? ['Waiting for the next request']
              : [`${lr.isIdle ? '[idle] · keep-alive only' : 'no [idle] · check-ins'} · kept warm ${w.count}×`, w.note]

  const compactLine = ctx?.tokens !== undefined ? `${k(Math.max(0, ctx.compactAt - ctx.tokens))} to auto-compact` : null
  const isText = (x: unknown): x is string => typeof x === 'string' && x !== ''

  // Where the surface has Client, a transparent click probe covers the area left of the buttons:
  // a click anywhere toggles the details. Without Client there are no clicks, so we fall back to
  // the host's hover: hovering the band shows the details row.
  // The probe must not cover the buttons: a probe layered above eats the button's click, and no
  // positioning order wins over it
  const Client = 'Client' in els ? els.Client : undefined
  const isExpanded = await read($, expanded)

  const probe = (key: string) =>
    Client ? (
      <Box position="absolute" top={0} left={0} right={0} bottom={0}>
        <Client key={key} module="./click-probe.tsx" props={{ zone: 'band' }} width="100%" height="100%" />
      </Box>
    ) : null

  // One column: the standing reading on top and, when expanded, its details below.
  // 5h and 7d pass a label: it stands on its own at the left (top-aligned, on the reading's line)
  // and the details line up with the bar; ctx and cache pass none: the label is part of the
  // reading and the details start at the column's left edge.
  // The first three columns' details are no wider than their readings, so expanding does not shift
  // the main row; the last column (cache and long run) may shrink and truncate instead of pushing the buttons
  type El = ReturnType<typeof usage>
  const column = (key: string, label: El | null, main: El, lines: unknown[], isLast = false) => {
    const shown = Client && isExpanded ? lines.filter(isText) : []
    const body = (
      <Box key={`${key}-body`} flexDirection="column" flexShrink={isLast ? 1 : 0} minWidth={isLast ? 0 : undefined}>
        {main}
        {shown.map((d, i) => (
          <Text key={`${key}-${i}`} dimColor wrap={isLast ? 'truncate-end' : undefined}>
            {d}
          </Text>
        ))}
      </Box>
    )
    if (label === null) return body

    return (
      <Box key={key} gap={1} alignItems="flex-start" flexShrink={0}>
        {label}
        {body}
      </Box>
    )
  }
  const label = (text: string) => (
    <Box>
      <Text dimColor>{text}</Text>
    </Box>
  )

  // Without Client: the details stay a row of their own below the main row, shown on hover
  const flat = [
    five && `5h ${resetLines(five).filter(isText).join(' · ')}`,
    week && `7d ${resetLines(week).filter(isText).join(' · ')}`,
    compactLine,
    ...keeperLines,
  ].filter(isText)
  const detailRow =
    Client || flat.length === 0 ? null : (
      <Box key="details" columnGap={3} flexWrap="wrap" display="none" hover={{ display: 'flex' }}>
        {flat.map((d, i) => (
          <Text key={`d-${i}`} dimColor>
            {d}
          </Text>
        ))}
      </Box>
    )

  const cacheMain = (
    <Box gap={1} alignItems="center">
      {Svg ? (
        <Svg
          source={ringSvg(left === null ? 0 : left / TTL_MS, cacheTone, dot)}
          alt={`cache ${cacheText}${isWarming ? ', kept warm' : ''}`}
          width={RING}
          height={RING}
        />
      ) : null}
      <Text dimColor>cache</Text>
      <Text color={left !== null && left <= LEAD_MS ? (left <= 0 ? 'error' : 'warning') : undefined}>{cacheText}</Text>
      {/* No ring in the terminal: a word marks keep-alive as on */}
      {!Svg && isWarming ? <Text dimColor>· warm</Text> : null}
    </Box>
  )

  return (
    <Box key="band" flexDirection="column">
      <Box alignItems="flex-start">
        {/* The readings area stretches up to the buttons, so the gap before them and the expanded details are under the probe too */}
        <Box
          key="usage-zone"
          position="relative"
          flexGrow={1}
          flexShrink={1}
          minWidth={0}
          paddingRight={3}
          columnGap={3}
          alignItems="flex-start"
        >
          {five && column('c-5h', label('5h'), usage('5h', five), resetLines(five))}
          {week && column('c-7d', label('7d'), usage('7d', week), resetLines(week))}
          {ctx?.tokens !== undefined && column('c-ctx', null, contextText({ ...ctx, tokens: ctx.tokens }), [compactLine])}
          {column('c-cache', null, cacheMain, keeperLines, true)}
          {probe('probe-main')}
        </Box>
        <Box gap={1} alignItems="center" flexShrink={0}>
          {pauseBadge !== null ? (
            <Box flexShrink={1} minWidth={0}>
              <Text color={lr.phase === 'paused' ? 'warning' : undefined} wrap="truncate-end">
                {pauseBadge}
              </Text>
            </Box>
          ) : null}
          {isWarming && w.isFailing ? (
            <Box flexShrink={1} minWidth={0}>
              <Text color="warning" wrap="truncate-end">
                Retrying
              </Text>
            </Box>
          ) : null}
          {/* isForking is a module variable; the once-a-second tick redraws it */}
          {isForking ? (
            <Box flexShrink={0}>
              <Text dimColor>Refreshing…</Text>
            </Box>
          ) : (
            <Button
              key="refresh"
              label="Refresh"
              onPress={async () => {
                if (isBusy) {
                  $.ui.toast('A turn is running; the cache refreshes when it ends')

                  return
                }
                if (isForking) return
                $.ui.toast(await keepAlive($, 'manual'))
              }}
            />
          )}
          {/* A check mark after the label while long-run mode is on; the button looks the same either way */}
          <Button
            key="toggle"
            label={lr.isOn ? 'Long run ✓' : 'Long run'}
            onPress={async () => {
              const isOn = !(await read($, longRun)).isOn
              await setLongRunOn($, isOn)
              $.ui.toast(
                isOn
                  ? `Long-run mode on: idle gaps get check-ins (keep-alive only once the model marks [idle]), pauses at ${PAUSE_AT}% of the 5h limit until it resets`
                  : 'Long-run mode off',
              )
            }}
          />
        </Box>
      </Box>
      {detailRow}
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'long-run',
      description: `Long-run mode: check in during idle gaps (keep-alive only once the model marks [idle]), pause at ${PAUSE_AT}% of the 5h limit and wake at the reset. /long-run [on|off|test|nudge|sim <min>|debug <min>]`,
    })

    storeKey = `longRun:${await $.session.id()}`
    const saved = await $.store.get(storeKey)
    const isSaved = typeof saved === 'object' && saved !== null && (saved as LongRunState).isOn === true
    await update($, longRun, () => (isSaved ? { ...LONG_RUN_OFF, ...(saved as LongRunState) } : LONG_RUN_OFF))

    const usage = await $.session.usage()
    await update($, limits, () => toWindows(usage.rateLimits))
    await loadContext($)
    await update($, now, () => Date.now())

    // Stopped mid-wind-down before a restart: that turn is long gone, so pause now;
    // otherwise take one look at the usage
    const lr = await read($, longRun)
    if (lr.isOn && lr.phase === 'winding') await enterPause($)
    else await checkQuota($, usage.rateLimits)

    $.ui.status(undefined)
    $.clock.every(1000, () => void tick($))

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      await update($, limits, () => toWindows(e.rateLimits))
      await checkQuota($, e.rateLimits)
    }

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    isBusy = true

    return next(e)
  })

  // Every model request in a turn refreshes the cache (a turn of tool calls makes many), so we time
  // by request, not by turn. A subagent's requests do not refresh the main conversation's prefix.
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    const u = r.usage
    if (e.agentId === undefined && u) {
      const t = Date.now()
      await update($, lastHitAt, () => t)
      // A check-in's turn is not activity, or the idle cap would never be reached; if the model
      // gets to work, turn.complete records it
      if (isNudgeTurn) nudgeSteps += 1
      else await update($, warm, w => ({ ...w, lastTurnAt: t }))
      // The context the next request carries = this input (cache reads and writes included) + this
      // output, the same basis as Claude Code's own "Context window"; session.measure leaves out the output
      const tokens = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens + u.output_tokens
      await update($, context, c => (c === null ? c : { ...c, tokens }))
    }

    return r
  })

  // The wrap-up reminder: past the threshold, the main conversation's next tool result carries
  // one system reminder, once
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined || r.deny !== undefined) return r
    const lr = await read($, longRun)
    if (!lr.isOn || lr.phase !== 'winding' || lr.isReminded || lr.resetsAt === null) return r
    await setLongRun($, x => ({ ...x, isReminded: true }))

    return { ...r, context: [...(r.context ?? []), reminderText(lr.resetsAt)] }
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      isBusy = false
      if (isNudgeTurn && nudgeSteps > 1) {
        const t = Date.now()
        await update($, warm, w => ({ ...w, lastTurnAt: t }))
      }
      isNudgeTurn = false
      nudgeSteps = 0
      const lr = await read($, longRun)
      if (lr.isOn) {
        // The model marked [idle], or the person interrupted the turn (they are here; do not carry on
        // for them): keep-alive only. An API error does not count: a check-in is just what revives it
        const isIdle = e.reason === 'aborted' || IDLE_MARK.test(e.answer.trimEnd())
        if (isIdle !== lr.isIdle) await setLongRun($, x => ({ ...x, isIdle }))
      }
      if (lr.isOn && lr.phase === 'winding') await enterPause($)
    }

    return next(e)
  })

  // While paused, background task notifications and scheduled triggers start no turn: their text is
  // held and handed to the model at wake-up. What the person types goes through, and so does
  // anything delivered into a running turn (turnId set)
  on('prompt.submit', async ($, e, next) => {
    // Our own check-in: mark the turn so turn.step and turn.complete can tell it apart
    if (e.origin.kind === 'plugin' && e.origin.name === 'long-live-the-claude' && e.text === NUDGE_LABEL) {
      isNudgeTurn = true
      nudgeSteps = 0
      const r = await next(e)
      if (r.drop !== undefined) isNudgeTurn = false

      return r
    }
    const lr = await read($, longRun)
    if (!lr.isOn || lr.phase !== 'paused' || e.turnId !== undefined || !HELD_ORIGINS.has(e.origin.kind)) {
      return next(e)
    }
    await setLongRun($, x => ({ ...x, held: [...x.held, e.text] }))
    const wakeAt = lr.resetsAt === null ? 'after the reset' : `at ${hhmm(lr.resetsAt + WAKE_DELAY_MS)}`

    return { drop: `Long-run pause: notification held, it goes to the model when the session resumes ${wakeAt}` }
  })

  // After a compaction, a model switch or /clear the old cache is void: reset the timer, and
  // keep-alive waits for the next request to build a new one
  on('classic.PostCompact', async ($, e, next) => {
    await update($, lastHitAt, () => null)

    return next(e)
  })

  on('classic.PostModelSwitch', async ($, e, next) => {
    await update($, lastHitAt, () => null)
    // The new model's window and compaction threshold may differ
    await loadContext($)

    return next(e)
  })

  on('session.end', { reason: 'clear' }, async ($, e, next) => {
    await update($, lastHitAt, () => null)

    return next(e)
  })

  on('command.run', { command: 'long-run' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const t = await $.clock.now()

    if (arg === '' || arg === 'on') {
      await setLongRunOn($, true)
      const hit = await read($, lastHitAt)
      const tail = hit === null ? ' There is no cache to keep yet; timing starts at the next request.' : ''

      return {
        text: `Long-run mode on: idle gaps get a check-in turn in the conversation, which also refreshes the cache, and once the model ends a reply with [idle] they are only kept warm (either way until ${IDLE_CAP_MS / 3600_000}h of idleness); at ${PAUSE_AT}% of the 5h limit the model is asked to wrap up, and the session pauses until the reset, then wakes.${tail}`,
      }
    }

    if (arg === 'off') {
      await setLongRunOn($, false)
      debugEveryMs = null

      return { text: 'Long-run mode off.' }
    }

    if (arg === 'test') {
      if (isForking) return { text: 'A keep-alive is in flight; try again shortly.' }
      return { text: `Test keep-alive done: ${await keepAlive($, 'manual')}` }
    }

    // Sends one check-in now (a plugin's prompt waits until the session is idle, so it starts after this command)
    if (arg === 'nudge') {
      if (isNudging || isNudgeTurn) return { text: 'A check-in is already on its way.' }
      void nudge($)

      return { text: 'Check-in queued; it enters the conversation once this command ends.' }
    }

    // Tests the pause: pretend the 5h window just crossed the threshold and resets in N minutes
    const sim = /^sim\s+(\d+(?:\.\d+)?)$/.exec(arg)
    if (sim) {
      await setLongRunOn($, true)
      const lr = await read($, longRun)
      if (lr.phase !== 'run') return { text: `Already ${lr.phase === 'paused' ? 'paused' : 'winding down'}.` }
      const resetsAt = t + Number(sim[1]) * 60_000
      await startWinding($, resetsAt)

      return {
        text: `Simulated: 5h past ${PAUSE_AT}%, resets at ${hhmm(resetsAt)}. ${isBusy ? 'The model is asked to wrap up at its next tool call and the session pauses when the turn ends' : 'No turn is running, so the session paused right away'}; it wakes at ${hhmm(resetsAt + WAKE_DELAY_MS)}.`,
      }
    }

    const debug = /^debug\s+(\d+(?:\.\d+)?)$/.exec(arg)
    if (debug) {
      await setLongRunOn($, true)
      debugEveryMs = Number(debug[1]) * 60_000
      retryAt = 0

      return {
        text: `Debug: refreshing every ${debug[1]} min (counted from the last request); long-run mode is on. /long-run off ends it, and so does a plugin reload.`,
      }
    }

    return { text: 'Usage: /long-run [on] | off | test | nudge | sim <minutes> | debug <minutes>' }
  })

  on('ui.message', async ($, e, next) => {
    // A probe reports a click on the band: toggle the details row
    const d = e.data as { zone?: unknown } | null
    if (d && d.zone === 'band') await update($, expanded, x => !x)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    return drawBand($, e)
  })
}
