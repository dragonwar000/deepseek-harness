/**
 * Pure types of the stationarity guard: the one home of the
 * `loop/stationarity` session-event declaration and its payload types.
 * @module @deepseek-ai/dsh-experimental-stationarity-guard/types
 */

/** `readOnly`: every call in the step is concurrency-safe; `sideEffect`: at least one call is exclusive. */
export type StationarityTier = 'sideEffect' | 'readOnly'

/** What the guard did, or would have done in `shadow` mode. */
export type StationarityAction = 'remind' | 'stop'

/** `repeat`: the step's evidence signature reached a threshold; `noop`: consecutive read-only steps added no new call/result pair. */
export type StationarityReason = 'repeat' | 'noop'

/** One guard decision about a completed tool step, recorded at the next step boundary. */
export interface LoopStationarity {
  /** Turn of the judged step. */
  turn: number
  /** The judged step. */
  step: number
  /** Plugin mode at decision time. */
  mode: 'shadow' | 'enforce'
  /** sha256 hex of the step's sorted (tool, canonical arguments, result hash) triples. */
  signature: string
  /** Side-effect tier of the judged step. */
  tier: StationarityTier
  /** Steps with this signature since the last human message, this one included. */
  repeats: number
  /** Consecutive read-only steps without a new call/result pair, this one included. */
  noopRun: number
  /** The decision. */
  action: StationarityAction
  /** Which counter reached its threshold. */
  reason: StationarityReason
  /** True iff the guard acted (`enforce`); false records a `shadow` decision. */
  applied: boolean
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** One stationarity decision at a step boundary. Log-only; never derived history. */
    'loop/stationarity': LoopStationarity
  }
}
