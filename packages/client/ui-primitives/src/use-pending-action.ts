/** One-at-a-time async command state shared by settings groups whose buttons disable while a command runs. */
import { useState } from 'react'

/** The pending-action hook's return: the in-flight flag, the last-outcome flag, and the runner. */
export interface PendingAction {
  /** True from `run` until its action settles; render disabled controls off it. */
  readonly pending: boolean
  /** True after the latest action rejected; cleared when the next action starts. */
  readonly failed: boolean
  /**
   * Start an action; the caller disables its controls while `pending` is true.
   * @param action - command to await; a rejection sets `failed` instead of propagating.
   */
  readonly run: (action: () => Promise<void>) => void
}

/**
 * Track one async command's in-flight and failure state.
 * @returns the current flags and the `run` handler.
 */
export function usePendingAction(): PendingAction {
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const run = (action: () => Promise<void>): void => {
    setPending(true)
    setFailed(false)
    void action().then(
      () => { setPending(false) },
      () => { setPending(false); setFailed(true) },
    )
  }
  return { pending, failed, run }
}
