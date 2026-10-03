// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { usePendingAction } from '../src/use-pending-action.ts'

afterEach(cleanup)

it('reports an action as pending until it settles and clears a previous failure on the next run', async () => {
  const { result } = renderHook(() => usePendingAction())
  expect(result.current).toMatchObject({ pending: false, failed: false })
  const rejected = Promise.withResolvers<undefined>()
  act(() => { result.current.run(() => rejected.promise) })
  expect(result.current).toMatchObject({ pending: true, failed: false })
  await act(async () => { rejected.reject(new Error('refused')) })
  expect(result.current).toMatchObject({ pending: false, failed: true })
  const resolved = Promise.withResolvers<undefined>()
  act(() => { result.current.run(() => resolved.promise) })
  expect(result.current).toMatchObject({ pending: true, failed: false })
  await act(async () => { resolved.resolve(undefined) })
  expect(result.current).toMatchObject({ pending: false, failed: false })
})
