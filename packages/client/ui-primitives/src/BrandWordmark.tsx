import type { IconProps } from './icons/props.ts'
import clsx from 'clsx'
import { CTD_BRAND_INK_CLASS, CtdMark } from './CtdMark.tsx'

/** Edge of the square slot the Coteccons mark occupies, in the artwork's own units. */
const MARK_SIZE = 24

/** Gap between the Coteccons mark and the wordmark text, in the artwork's own units. */
const MARK_TEXT_GAP = 8

/** Native (`size`-independent) width of the "CTD Core" text-only artwork. */
const TEXT_WIDTH = 120

/** The wordmark's lettering: the fixed product name, identical in every locale. */
export const CTD_WORDMARK_GLYPHS = 'CTD Core'

/** Display options for the official brand wordmark. */
export interface BrandWordmarkProps extends IconProps {
  /** Whether to include the leading Coteccons mark; defaults to true. */
  includeMark?: boolean | undefined
}

/**
 * Render the full "CTD Core" wordmark: the Coteccons mark followed by "CTD Core"
 * set in the same face as `OfficialBrandName` (Montserrat bold). Mark and text use
 * the brand ink: navy in the light theme, white in the dark theme.
 * @param props.size - height in px (default 24; width follows the selected artwork).
 * @param props.className - extra class for layout placement.
 * @param props.includeMark - whether to include the leading Coteccons mark.
 * @returns the wordmark svg (aria-hidden decorative brand art).
 */
export function BrandWordmark({ size = 24, className, includeMark = true }: BrandWordmarkProps) {
  const markWidth = MARK_SIZE
  const textX = includeMark ? markWidth + MARK_TEXT_GAP : 0
  const width = textX + TEXT_WIDTH
  return (
    <svg
      width={(size * width) / 24}
      height={size}
      className={clsx(CTD_BRAND_INK_CLASS, className)}
      viewBox={`0 0 ${width} 24`}
      fill="none"
      aria-hidden="true"
    >
      {includeMark && <CtdMark size={markWidth} />}
      <text
        x={textX}
        y="17"
        fill="currentColor"
        fontSize="17"
        fontWeight="700"
        fontFamily="Montserrat, system-ui, sans-serif"
        letterSpacing="-0.3"
      >
        {CTD_WORDMARK_GLYPHS}
      </text>
    </svg>
  )
}
