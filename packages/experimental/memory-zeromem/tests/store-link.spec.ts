import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareStore, resolveStore } from '../src/store.ts'
import { cleanup, tempRoot } from './harness.ts'

vi.mock('node:fs/promises', async original => ({
  ...await original<typeof import('node:fs/promises')>(),
  symlink: () => Promise.reject(Object.assign(new Error('operation not permitted'), { code: 'EPERM' })),
}))

afterEach(cleanup)

describe('prepareStore', () => {
  it('fails when the model cache link cannot be created for a reason other than an existing link', async () => {
    const { root } = tempRoot()
    await expect(prepareStore(resolveStore({ scope: 'global', storeRoot: root, cwd: undefined }))).rejects.toMatchObject({ code: 'EPERM' })
  })
})
