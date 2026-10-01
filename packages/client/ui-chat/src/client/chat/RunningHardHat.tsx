/** Construction hard hat with a beacon for the running Chat status. */
import css from './ChatView.module.css'

const SHELL_PATH = 'M3 12.25V11a5 5 0 0 1 3.5-4.77M9.5 6.23A5 5 0 0 1 13 11v1.25'
const RIDGE_PATH = 'M6.5 10V6.5a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1V10'
const BEACON_PATH = 'M8 1.5v1.25M4.75 3l.9.9M11.25 3l-.9.9'

/**
 * Render the decorative running icon; CSS tilts the hat and blinks the beacon unless reduced motion is requested.
 * @returns a 16-unit vector hard hat drawn in the current text color.
 */
export function RunningHardHat() {
  return (
    <span className={css.runningIcon} aria-hidden="true">
      <svg className={css.runningHardHat} width="100%" height="100%" viewBox="0 0 16 16" fill="none">
        <g stroke="currentColor" strokeWidth={1} strokeLinecap="round" strokeLinejoin="round">
          <path d={SHELL_PATH} />
          <path d={RIDGE_PATH} />
        </g>
        <rect x={1.5} y={12.25} width={13} height={1.75} rx={0.875} fill="currentColor" />
        <path className={css.runningHardHatBeacon} d={BEACON_PATH} stroke="currentColor" strokeWidth={1} strokeLinecap="round" />
      </svg>
    </span>
  )
}
