import clsx from 'clsx'
import css from './CtdMark.module.css'
import type { IconProps } from './icons/props.ts'

/**
 * Class that sets `color` to the brand ink: brand navy `#16315E` in the light
 * theme and white when `body[data-ds-dark-theme]` is present. Artwork filled
 * with `currentColor` follows it.
 */
export const CTD_BRAND_INK_CLASS = css.ink as string

/**
 * viewBox of the mark artwork, in the official logo's own units: the symbol's
 * 59.7 × 42.1 extent centered in a 61.8 unit square so it fits square icon slots.
 */
export const CTD_MARK_VIEWBOX = { x: -0.55, y: -9.45, width: 61.8, height: 61.8 }

/** Official Coteccons symbol: the C. */
const SYMBOL_C = 'M32.0306 34.772C25.2283 34.772 19.7164 29.2831 19.7164 22.5151C19.7164 15.7471 25.2283 10.2583 32.0306 10.2583C34.8515 10.2583 37.4574 11.2041 39.5331 12.7969L44.3197 6.54347C40.9286 3.95096 36.6872 2.41211 32.0806 2.41211C21.2319 2.41211 12.394 10.9542 11.9788 21.6477C3.02081 29.9447 -1.91086 38.2368 1.70036 41.7262C3.55599 43.5199 11.0535 42.4319 16.9555 39.9619C17.2856 39.8247 17.0805 39.3885 16.7254 39.4375C11.8938 40.1334 7.7424 39.6287 6.37194 37.8252C4.35125 35.1689 6.65203 29.6703 11.9838 23.3385C12.459 33.9732 21.277 42.4515 32.0806 42.4515C36.6872 42.4515 40.9286 40.9127 44.3197 38.3201L39.5931 32.1795C37.5074 33.8065 34.8866 34.772 32.0306 34.772Z'

/** Official Coteccons symbol: the orbit ellipse arc. */
const SYMBOL_ORBIT = 'M37.5421 28.9937C37.337 29.1309 37.1169 28.8417 37.307 28.68C45.2597 21.8042 55.2731 13.2915 53.8076 6.72939C52.9973 3.10281 46.9603 2.83327 43.7542 3.47037C43.224 3.57819 43.214 3.19593 43.7042 2.97049C49.286 0.422085 57.8939 -0.724699 59.7396 2.25498C62.8606 7.29298 50.9316 20.2262 37.5421 28.9937Z'

/**
 * Render the Coteccons mark: the official C and orbit symbol. The fill is
 * `currentColor` through the brand ink class, so the mark is navy in the light
 * theme and white in the dark theme.
 * @param props.size - square edge in px (default 24).
 * @param props.className - extra class for layout placement.
 * @returns the mark svg (aria-hidden; pair with a wordmark for accessibility).
 */
export function CtdMark({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      className={clsx(CTD_BRAND_INK_CLASS, className)}
      viewBox={`${CTD_MARK_VIEWBOX.x} ${CTD_MARK_VIEWBOX.y} ${CTD_MARK_VIEWBOX.width} ${CTD_MARK_VIEWBOX.height}`}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d={SYMBOL_C} />
      <path d={SYMBOL_ORBIT} />
    </svg>
  )
}
