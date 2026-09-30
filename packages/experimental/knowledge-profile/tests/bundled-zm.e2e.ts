/**
 * The knowledge bundle with its memory-zeromem row enabled and the row's empty `zmPath` kept, as CTD Core Desktop
 * runs it: the plugin resolves the real `zm` that `DSH_ZEROMEM_ZM` names and a later session recalls an earlier turn.
 * Self-skips unless `DSH_ZEROMEM_ZM` names an existing `zm`, for example the one `pnpm run prepare:desktop:zeromem`
 * places under `apps/desktop/.desktop-build/targets/<target>/runtime/zeromem/`.
 */

import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { boot, cleanup, recallRoundTrip, storeRoot } from './loader-harness.ts'

const zm = process.env['DSH_ZEROMEM_ZM']

afterEach(cleanup)

describe.skipIf(zm === undefined || zm === '' || !existsSync(zm))('knowledge bundle with the zm DSH_ZEROMEM_ZM names', () => {
  it('stores a turn and recalls it from a later session through the row defaults', async () => {
    const { ctx, workspace } = await boot(new Map(), [{
      id: 'memory-zeromem',
      disabled: false,
      config: { zmPath: '', embedder: 'hash', storeRoot: storeRoot() },
    }])
    const trip = await recallRoundTrip(ctx, workspace)
    expect(trip.tools).toEqual(expect.arrayContaining(['memory_recall', 'memory_stats']))
    expect(trip.isError).toBe(false)
    expect(trip.recall).toContain('Our retries use jittered backoff.')
    expect(trip.recall).toContain('earlier')
  })
})
