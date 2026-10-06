export type RateWindow = { kind: string; percentUsed: number; resetsAt?: string }

export type WarmState = {
  /** Keep-alives sent since long-run mode was turned on */
  count: number
  /** The last automatic keep-alive failed and a retry is pending */
  isFailing: boolean
  /** A keep-alive missed the cache, so the TTL is probably not 1 hour; automatic keep-alive stops until long-run mode is turned on again */
  isBroken: boolean
  /** When the main conversation last made a real model request (keep-alives excluded); keep-alive stops after a long idle */
  lastTurnAt: number | null
  /** The result of the last automatic keep-alive, shown in the details row */
  note: string | null
}

/**
 * Long-run mode: `run` is normal; `winding` means the 5h window crossed the threshold and we wait
 * for the model to wrap up and the turn to end; `paused` holds background notifications back
 * until the reset, then wakes the session
 */
export type LongRunPhase = 'run' | 'winding' | 'paused'

export type LongRunState = {
  isOn: boolean
  phase: LongRunPhase
  /** When the 5h window resets (ms); set while winding or paused */
  resetsAt: number | null
  /** Whether the wrap-up reminder has been attached to a tool result */
  isReminded: boolean
  /** When the pause began */
  pausedAt: number | null
  /** The text of background notifications held during the pause, handed to the model at wake-up */
  held: string[]
  /**
   * The model ended its last main-conversation turn with [idle] (or the person interrupted the turn):
   * it considers itself done. While true, idle gaps only get a forked keep-alive; while false, they get
   * a check-in turn in the conversation. Re-decided at the end of every main-conversation turn
   */
  isIdle: boolean
}

export type ContextState = {
  /** The last response's input plus output tokens, i.e. the context the next request carries; empty before the first response */
  tokens?: number
  /** The compaction window (/context's rawMaxTokens), the denominator for percentages and colors */
  limit: number
  /** Where auto-compaction actually fires: the compaction window minus the reserved buffer */
  compactAt: number
  /** The model's own context window */
  window: number
}

declare module 'claude-code' {
  interface PluginState {
    'long-live-the-claude': {
      /** When the main conversation's last request (or the last keep-alive) finished; the cache TTL counts from here */
      lastHitAt: number | null
      limits: RateWindow[]
      context: ContextState | null
      warm: WarmState
      longRun: LongRunState
      now: number
      /** Whether the details row under the main row is expanded */
      expanded: boolean
    }
  }
}
