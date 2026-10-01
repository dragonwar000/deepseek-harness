// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { RunningHardHat } from '../src/client/chat/RunningHardHat.tsx'

afterEach(cleanup)

describe('RunningHardHat', () => {
  it('renders one decorative vector hard hat in the current text color without inline styles or raster images', () => {
    const view = render(<RunningHardHat />)
    const icon = view.container.firstElementChild!
    expect(icon.tagName).toBe('SPAN')
    expect(icon.getAttribute('aria-hidden')).toBe('true')
    expect(icon.children).toHaveLength(1)
    const svg = icon.firstElementChild!
    expect(svg.tagName.toLowerCase()).toBe('svg')
    expect(svg.getAttribute('viewBox')).toBe('0 0 16 16')
    const marks = [...svg.querySelectorAll('path, rect')]
    expect(marks).toHaveLength(4)
    for (const mark of marks) {
      const paint = mark.getAttribute('stroke') ?? mark.closest('g')?.getAttribute('stroke') ?? mark.getAttribute('fill')
      expect(paint).toBe('currentColor')
    }
    for (const path of svg.querySelectorAll('path')) expect(path.getAttribute('d')).toMatch(/^M/)
    expect(svg.querySelectorAll('[class]')).toHaveLength(1)
    expect(view.container.querySelector('animate, image, img')).toBeNull()
    expect(view.container.querySelector('[style]')).toBeNull()
  })
})
