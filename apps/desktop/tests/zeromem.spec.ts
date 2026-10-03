import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { c as createTar } from 'tar'
import { bundledZeromemExecutable, bundledZeromemModels, ZEROMEM_EXECUTABLE_ENV, ZEROMEM_MODELS_ENV, zeromemHostEnvironment } from '../src/zeromem.ts'
import lock from '../scripts/zeromem-lock.json' with { type: 'json' }

const download = vi.hoisted(() => vi.fn<(url: string, sha256: string, cache: string) => Promise<string>>())
vi.mock('../../../scripts/primary-runtime/prepare.ts', () => ({ downloadPrimaryRuntimeAsset: download }))

const {
  executableArchitecture, OMIT_ZEROMEM_ENV, prepareDesktopZeromem, prepareZeromem, smokeZeromem, ZEROMEM_SMOKE, ZeromemBuildError,
  zeromemBuildEnvironment, zeromemInstallArguments,
} = await import('../scripts/prepare-zeromem.ts')

const FAKE_CARGO = fileURLToPath(new URL('./fixtures/fake-cargo.mjs', import.meta.url))
const roots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'desktop-zeromem-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  download.mockReset()
})

describe('carried zm location and Host environment', () => {
  it('places zm and its model under runtime/zeromem', () => {
    expect(bundledZeromemExecutable(join('r', 'runtime'), 'darwin')).toBe(join('r', 'runtime', 'zeromem', 'zm'))
    expect(bundledZeromemExecutable(join('r', 'runtime'), 'win32')).toBe(join('r', 'runtime', 'zeromem', 'zm.exe'))
    expect(bundledZeromemExecutable('runtime')).toBe(join('runtime', 'zeromem', process.platform === 'win32' ? 'zm.exe' : 'zm'))
    expect(bundledZeromemModels(join('r', 'runtime'))).toBe(join('r', 'runtime', 'zeromem', 'models'))
  })

  it('names each carried path only when it exists and no inherited value is set', () => {
    const zm = bundledZeromemExecutable('/app/runtime')
    const models = bundledZeromemModels('/app/runtime')
    expect([ZEROMEM_EXECUTABLE_ENV, ZEROMEM_MODELS_ENV]).toEqual(['DSH_ZEROMEM_ZM', 'DSH_ZEROMEM_MODELS'])
    expect(zeromemHostEnvironment('/app/runtime', {}, () => true)).toEqual({ DSH_ZEROMEM_ZM: zm, DSH_ZEROMEM_MODELS: models })
    expect(zeromemHostEnvironment('/app/runtime', { DSH_ZEROMEM_ZM: '', DSH_ZEROMEM_MODELS: '' }, () => true)).toEqual({ DSH_ZEROMEM_ZM: zm, DSH_ZEROMEM_MODELS: models })
    expect(zeromemHostEnvironment('/app/runtime', { DSH_ZEROMEM_ZM: '/custom/zm' }, () => true)).toEqual({ DSH_ZEROMEM_MODELS: models })
    expect(zeromemHostEnvironment('/app/runtime', { DSH_ZEROMEM_MODELS: '/custom/models' }, () => true)).toEqual({ DSH_ZEROMEM_ZM: zm })
    expect(zeromemHostEnvironment('/app/runtime', {}, path => path === zm)).toEqual({ DSH_ZEROMEM_ZM: zm })
    expect(zeromemHostEnvironment(tempRoot(), {})).toEqual({})
  })
})

describe('pinned zm build', () => {
  /** Answer each pinned download with a local file: a tar archive holding the static library, otherwise the URL text. */
  async function serveDownloads(root: string): Promise<void> {
    const staged = join(root, 'archive')
    mkdirSync(join(staged, 'onnxruntime', 'lib'), { recursive: true })
    writeFileSync(join(staged, 'onnxruntime', 'lib', 'libonnxruntime.a'), 'static onnxruntime')
    const archive = join(root, 'onnxruntime.tgz')
    await createTar({ gzip: true, file: archive, cwd: staged }, ['onnxruntime'])
    download.mockImplementation((url) => {
      if (url.endsWith('.tgz')) return Promise.resolve(archive)
      const file = join(root, `download-${download.mock.calls.length}`)
      writeFileSync(file, url)
      return Promise.resolve(file)
    })
  }

  async function options(target: 'mac-arm64' | 'mac-x64' | 'win-x64', mode = '') {
    const root = tempRoot()
    await serveDownloads(root)
    const log = join(root, 'cargo.jsonl')
    return {
      root, log,
      options: {
        target, runtime: join(root, 'runtime'), work: join(root, 'work'), cache: join(root, 'cache'),
        cargo: [process.execPath, FAKE_CARGO], environment: { ...process.env, FAKE_CARGO_LOG: log, FAKE_CARGO_MODE: mode },
      },
    }
  }

  it('installs the locked revision with its default features for the target triple', () => {
    expect(zeromemInstallArguments('mac-x64', '/root')).toEqual(['install', '--git', 'https://github.com/ptaranat/zeromem',
      '--rev', lock.rev, '--locked', '--force', '--target', 'x86_64-apple-darwin', '--root', '/root', 'zeromem'])
    for (const rev of [lock.rev, lock.onnxruntime.rev, lock.model.rev, lock.model.licenseRev]) expect(rev).toMatch(/^[0-9a-f]{40}$/u)
    for (const archive of Object.values(lock.onnxruntime.archives)) expect(archive.sha256).toMatch(/^[0-9a-f]{64}$/u)
    for (const sha256 of Object.values(lock.model.files)) expect(sha256).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('links the verified onnxruntime and keeps ort-sys away from pkg-config', () => {
    expect(zeromemBuildEnvironment('mac-arm64', { PATH: '/bin', ORT_LIB_LOCATION: '/elsewhere' }, '/work', '/work/ort/lib')).toEqual({
      PATH: '/bin', CARGO_TARGET_DIR: join('/work', 'target'), ORT_LIB_LOCATION: '/work/ort/lib', LIBONNXRUNTIME_NO_PKG_CONFIG: '1',
    })
    expect(zeromemBuildEnvironment('win-x64', {}, '/work', '/work/ort/lib').CARGO_ENCODED_RUSTFLAGS)
      .toBe(['-l', 'dxguid', '-l', 'DXCORE', '-l', 'DXGI', '-l', 'D3D12', '-l', 'DirectML'].join('\x1f'))
  })

  it.each([
    ['mac-arm64', 'aarch64-apple-darwin', 'zm'],
    ['mac-x64', 'x86_64-apple-darwin', 'zm'],
    ['win-x64', 'x86_64-pc-windows-msvc', 'zm.exe'],
  ] as const)('produces an executable %s zm with its model and licenses', async (target, triple, name) => {
    const { root, log, options: prepared } = await options(target)
    const executable = await prepareZeromem(prepared)
    const directory = join(root, 'runtime', 'zeromem')
    expect(executable).toBe(join(directory, name))
    if (process.platform !== 'win32') expect(statSync(executable).mode & 0o111).toBe(0o111)
    expect(download).toHaveBeenCalledWith(lock.onnxruntime.archives[target].url, lock.onnxruntime.archives[target].sha256, prepared.cache)
    for (const [file, url] of [
      ['LICENSE', `https://raw.githubusercontent.com/ptaranat/zeromem/${lock.rev}/LICENSE`],
      ['onnxruntime-LICENSE', `https://raw.githubusercontent.com/microsoft/onnxruntime/${lock.onnxruntime.rev}/LICENSE`],
      ['onnxruntime-ThirdPartyNotices.txt', `https://raw.githubusercontent.com/microsoft/onnxruntime/${lock.onnxruntime.rev}/ThirdPartyNotices.txt`],
      ['bge-small-en-v1.5-LICENSE', `https://raw.githubusercontent.com/FlagOpen/FlagEmbedding/${lock.model.licenseRev}/LICENSE`],
    ]) expect(readFileSync(join(directory, file!), 'utf8')).toBe(url)
    const snapshot = join(directory, 'models', 'models--Xenova--bge-small-en-v1.5', 'snapshots', lock.model.rev)
    for (const [file, sha256] of Object.entries(lock.model.files)) {
      const url = `https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/${lock.model.rev}/${file}`
      expect(download).toHaveBeenCalledWith(url, sha256, prepared.cache)
      expect(readFileSync(join(snapshot, ...file.split('/')), 'utf8')).toBe(url)
    }
    expect(readFileSync(join(directory, 'models', 'models--Xenova--bge-small-en-v1.5', 'refs', 'main'), 'utf8')).toBe(lock.model.rev)
    const [call] = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { args: string[]; targetDir: string; ortLib: string; archive: boolean; noPkgConfig: string })
    expect(call!.args).toEqual(zeromemInstallArguments(target, join(prepared.work, 'install')))
    expect(call!.args).toContain(triple)
    expect(call!.targetDir).toBe(join(prepared.work, 'target'))
    expect(call!.ortLib).toBe(join(prepared.work, 'onnxruntime', 'onnxruntime', 'lib'))
    expect(call!.archive).toBe(true)
    expect(call!.noPkgConfig).toBe('1')
  })

  it('replaces an earlier prepared directory and extracted onnxruntime', async () => {
    const { root, options: prepared } = await options('mac-arm64')
    mkdirSync(join(prepared.work, 'onnxruntime'), { recursive: true })
    writeFileSync(join(prepared.work, 'onnxruntime', 'stale'), '')
    mkdirSync(join(root, 'runtime', 'zeromem'), { recursive: true })
    writeFileSync(join(root, 'runtime', 'zeromem', 'stale'), '')
    await prepareZeromem(prepared)
    expect(existsSync(join(root, 'runtime', 'zeromem', 'stale'))).toBe(false)
    expect(existsSync(join(prepared.work, 'onnxruntime', 'stale'))).toBe(false)
  })

  it('fails with a named error when cargo is missing, fails, or builds another architecture', async () => {
    const missing = (await options('mac-arm64')).options
    await expect(prepareZeromem({ ...missing, cargo: [join(tempRoot(), 'no-cargo')] })).rejects.toThrow(/cargo was not found; install Rust from https:\/\/rustup\.rs with the aarch64-apple-darwin target, or set DSH_DESKTOP_OMIT_ZEROMEM=1/u)
    await expect(prepareZeromem((await options('mac-x64', 'fail')).options)).rejects.toThrow(/needs `rustup target add x86_64-apple-darwin`/u)
    const wrong = prepareZeromem((await options('mac-arm64', 'wrong-arch')).options)
    await expect(wrong).rejects.toBeInstanceOf(ZeromemBuildError)
    await expect(wrong).rejects.toThrow(/is a darwin-x64 executable, not darwin-arm64/u)
  })

  it('reads the architecture of Mach-O and PE headers', () => {
    const root = tempRoot()
    const file = join(root, 'bin')
    const macho = Buffer.alloc(8)
    macho.writeUInt32LE(0xfeedfacf, 0)
    macho.writeUInt32LE(0x12, 4)
    writeFileSync(file, macho)
    expect(executableArchitecture(file)).toBe('unknown')
    const pe = Buffer.alloc(0x40)
    pe.write('MZ', 0, 'latin1')
    pe.writeUInt32LE(0x1000, 0x3c)
    writeFileSync(file, pe)
    expect(executableArchitecture(file)).toBe('unknown')
    pe.writeUInt32LE(0x38, 0x3c)
    writeFileSync(file, Buffer.concat([pe, Buffer.from('PE\0\0\x4c\x01', 'latin1')]))
    expect(executableArchitecture(file)).toBe('unknown')
    writeFileSync(file, '#!/bin/sh\n')
    expect(executableArchitecture(file)).toBe('unknown')
  })
})

describe('zm smoke', () => {
  const hostTarget = process.platform === 'win32' ? 'win-x64' : process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64'
  const foreignTarget = hostTarget === 'mac-arm64' ? 'mac-x64' : 'mac-arm64'

  interface Script { readonly server?: string; readonly embedder?: string; readonly fallback?: boolean; readonly recall?: 'spooled' | 'none' }

  /**
   * A `zm` stand-in that answers initialize, stats, and recall; `spooled` recall returns the first spooled turn when
   * `<home>/models` resolves to the model directory the smoke passed.
   */
  function script(answer: Script = {}): string {
    const file = join(tempRoot(), 'zm')
    const { server = 'zeromem', embedder = 'bge-small-en-v1.5', fallback = false, recall = 'spooled' } = answer
    writeFileSync(file, `#!${process.execPath}
const { existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const home = process.argv[process.argv.indexOf('--home') + 1]
let input = ''
process.stdin.on('data', chunk => { input += chunk })
process.stdin.on('end', () => {
  const turn = JSON.parse(readFileSync(join(home, 'spool', 'smoke.jsonl'), 'utf8').split('\\n')[0])
  const evidence = ${JSON.stringify(recall)} === 'spooled' && existsSync(join(home, 'models', 'marker')) ? [{ role: 'Main', text: turn.text }] : []
  for (const request of input.split('\\n').filter(line => line !== '').map(line => JSON.parse(line))) {
    const text = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], isError: false })
    const result = request.method === 'initialize' ? { serverInfo: { name: ${JSON.stringify(server)} } }
      : request.params.name === 'zeromem_stats' ? text({ embedder: ${JSON.stringify(embedder)}, embedder_is_fallback: ${fallback} })
      : text({ evidence })
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n')
  }
})
`)
    chmodSync(file, 0o755)
    return file
  }

  function models(): string {
    const directory = join(tempRoot(), 'models')
    mkdirSync(directory)
    writeFileSync(join(directory, 'marker'), '')
    return directory
  }

  it('skips a target this host cannot run', () => {
    expect(smokeZeromem('/nonexistent/zm', foreignTarget, '/nonexistent/models')).toBe(false)
  })

  it('names a paraphrase that shares no word with the turn it must recall', () => {
    const words = (text: string) => new Set(text.toLowerCase().match(/[a-z]+/gu))
    const query = words(ZEROMEM_SMOKE.query)
    expect([...words(ZEROMEM_SMOKE.turns[0].text)].filter(word => query.has(word))).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('accepts a model-backed recall of the paraphrase', () => {
    expect(smokeZeromem(script(), hostTarget, models())).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('refuses another server, the hash embedder, and a recall that misses the turn', () => {
    const refused = (zm: string, directory = models()) => () => smokeZeromem(zm, hostTarget, directory)
    expect(refused(script({ server: 'other' }))).toThrow(/did not recall a paraphrase with bge-small-en-v1\.5/u)
    expect(refused(script({ embedder: 'hash-v1-256', fallback: true }))).toThrow(ZeromemBuildError)
    expect(refused(script({ fallback: true }))).toThrow(ZeromemBuildError)
    expect(refused(script({ recall: 'none' }))).toThrow(ZeromemBuildError)
    expect(refused(script(), join(tempRoot(), 'absent'))).toThrow(ZeromemBuildError)
  })

  it.skipIf(process.env.DSH_ZEROMEM_ZM === undefined || process.env.DSH_ZEROMEM_ZM === '' || process.env.DSH_ZEROMEM_MODELS === undefined)('recalls a paraphrase with a real zm and model', () => {
    expect(smokeZeromem(process.env.DSH_ZEROMEM_ZM!, hostTarget, process.env.DSH_ZEROMEM_MODELS!)).toBe(true)
  })
})

describe('Desktop zm preparation', () => {
  it('builds nothing when the environment omits zm', async () => {
    const environment = { DSH_DESKTOP_TARGET_PLATFORM: 'darwin', DSH_DESKTOP_TARGET_ARCH: 'arm64', [OMIT_ZEROMEM_ENV]: '1' }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect(await prepareDesktopZeromem({}, environment)).toBeUndefined()
      expect(warn).toHaveBeenCalledWith('desktop zeromem: DSH_DESKTOP_OMIT_ZEROMEM=1, so this build carries no zm')
    } finally { warn.mockRestore() }
  })
})
