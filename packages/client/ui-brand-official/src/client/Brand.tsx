import { CTD_BRAND_INK_CLASS, CTD_WORDMARK_GLYPHS, CtdMark } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the Coteccons mark with the presentation requested by its host surface.
 * The shared `CtdMark` primitive is the single source of the icon artwork,
 * so the sidebar occupant and the conversation hero fallback stay identical.
 * @param props - Host-supplied mark presentation.
 * @returns the Coteccons icon mark.
 */
export function OfficialBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return <CtdMark size={size} />
}

/**
 * Render the CTD Core wordmark.
 * @returns the CTD Core name wordmark.
 */
export function OfficialBrandName() {
  return (
    <svg
      className={CTD_BRAND_INK_CLASS}
      width={96}
      height={18}
      viewBox="0 0 96 18"
      fill="none"
      aria-hidden="true"
    >
      <text
        x="0"
        y="15"
        fill="currentColor"
        fontSize="15"
        fontWeight="700"
        fontFamily="Montserrat, system-ui, sans-serif"
        letterSpacing="-0.3"
      >
        {CTD_WORDMARK_GLYPHS}
      </text>
    </svg>
  )
}
