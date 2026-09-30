/**
 * The knowledge bundle with its memory-zeromem row enabled and the row's empty `zmPath` and `modelDir` kept, as CTD
 * Core Desktop runs it: the plugin resolves the real `zm` that `DSH_ZEROMEM_ZM` names and the model that
 * `DSH_ZEROMEM_MODELS` names, and a later session recalls an earlier turn with bge-small-en-v1.5.
 * Self-skips unless both name existing paths, for example the `zm` and `models/` that `pnpm run prepare:desktop:zeromem`
 * places under `apps/desktop/.desktop-build/targets/<target>/runtime/zeromem/`.
 */

import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { boot, cleanup, recallRoundTrip, storeRoot } from './loader-harness.ts'

const zm = process.env['DSH_ZEROMEM_ZM']
const models = process.env['DSH_ZEROMEM_MODELS']
const available = zm !== undefined && zm !== '' && existsSync(zm) && models !== undefined && models !== '' && existsSync(models)

afterEach(cleanup)

describe.skipIf(!available)('knowledge bundle with the zm and model DSH_ZEROMEM_ZM and DSH_ZEROMEM_MODELS name', () => {
  it('stores a turn and recalls it from a later session through the row defaults', async () => {
    const { ctx, workspace } = await boot(new Map(), [{
      id: 'memory-zeromem',
      disabled: false,
      config: { zmPath: '', embedder: 'default', modelDir: '', storeRoot: storeRoot() },
    }])
    const trip = await recallRoundTrip(ctx, workspace)
    expect(trip.tools).toEqual(expect.arrayContaining(['memory_recall', 'memory_stats']))
    expect(trip.isError).toBe(false)
    expect(trip.recall).toContain('Our retries use jittered backoff.')
    expect(trip.recall).toContain('earlier')
  })
})
