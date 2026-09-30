import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bundledZeromemExecutable, ZEROMEM_EXECUTABLE_ENV, zeromemHostEnvironment } from '../src/zeromem.ts'
import lock from '../scripts/zeromem-lock.json' with { type: 'json' }

const download = vi.hoisted(() => vi.fn<(url: string, sha256: string, cache: string) => Promise<string>>())
vi.mock('../../../scripts/primary-runtime/prepare.ts', () => ({ downloadPrimaryRuntimeAsset: download }))

const { executableArchitecture, OMIT_ZEROMEM_ENV, prepareDesktopZeromem, prepareZeromem, smokeZeromem, ZeromemBuildError, zeromemInstallArguments } = await import('../scripts/prepare-zeromem.ts')

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
  it('places zm under runtime/zeromem with the platform suffix', () => {
    expect(bundledZeromemExecutable(join('r', 'runtime'), 'darwin')).toBe(join('r', 'runtime', 'zeromem', 'zm'))
    expect(bundledZeromemExecutable(join('r', 'runtime'), 'win32')).toBe(join('r', 'runtime', 'zeromem', 'zm.exe'))
    expect(bundledZeromemExecutable('runtime')).toBe(join('runtime', 'zeromem', process.platform === 'win32' ? 'zm.exe' : 'zm'))
  })

  it('names the carried zm only when it exists and no inherited value is set', () => {
    expect(ZEROMEM_EXECUTABLE_ENV).toBe('DSH_ZEROMEM_ZM')
    expect(zeromemHostEnvironment('/app/zm', {}, () => true)).toEqual({ DSH_ZEROMEM_ZM: '/app/zm' })
    expect(zeromemHostEnvironment('/app/zm', { DSH_ZEROMEM_ZM: '' }, () => true)).toEqual({ DSH_ZEROMEM_ZM: '/app/zm' })
    expect(zeromemHostEnvironment('/app/zm', { DSH_ZEROMEM_ZM: '/custom/zm' }, () => true)).toEqual({})
    expect(zeromemHostEnvironment('/app/zm', {}, () => false)).toEqual({})
    expect(zeromemHostEnvironment(join(tempRoot(), 'zm'), {})).toEqual({})
  })
})

describe('pinned zm build', () => {
  function options(target: 'mac-arm64' | 'mac-x64' | 'win-x64', mode = '') {
    const root = tempRoot()
    const license = join(root, 'license-download')
    writeFileSync(license, 'MIT License\n')
    download.mockResolvedValue(license)
    const log = join(root, 'cargo.jsonl')
    return {
      root, log,
      options: {
        target, runtime: join(root, 'runtime'), work: join(root, 'work'), cache: join(root, 'cache'),
        cargo: [process.execPath, FAKE_CARGO], environment: { ...process.env, FAKE_CARGO_LOG: log, FAKE_CARGO_MODE: mode },
      },
    }
  }

  it('installs the locked revision without default features for the target triple', () => {
    expect(zeromemInstallArguments('mac-x64', '/root')).toEqual(['install', '--git', 'https://github.com/ptaranat/zeromem',
      '--rev', lock.rev, '--locked', '--no-default-features', '--force', '--target', 'x86_64-apple-darwin', '--root', '/root', 'zeromem'])
    expect(lock.rev).toMatch(/^[0-9a-f]{40}$/u)
  })

  it.each([
    ['mac-arm64', 'aarch64-apple-darwin', 'zm'],
    ['mac-x64', 'x86_64-apple-darwin', 'zm'],
    ['win-x64', 'x86_64-pc-windows-msvc', 'zm.exe'],
  ] as const)('produces an executable %s zm with its license', async (target, triple, name) => {
    const { root, log, options: prepared } = options(target)
    const executable = await prepareZeromem(prepared)
    expect(executable).toBe(join(root, 'runtime', 'zeromem', name))
    if (process.platform !== 'win32') expect(statSync(executable).mode & 0o111).toBe(0o111)
    expect(readFileSync(join(root, 'runtime', 'zeromem', 'LICENSE'), 'utf8')).toBe('MIT License\n')
    expect(download).toHaveBeenCalledWith(`https://raw.githubusercontent.com/ptaranat/zeromem/${lock.rev}/LICENSE`, lock.licenseSha256, prepared.cache)
    const [call] = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { args: string[]; targetDir: string })
    expect(call!.args).toEqual(zeromemInstallArguments(target, join(prepared.work, 'install')))
    expect(call!.args).toContain(triple)
    expect(call!.targetDir).toBe(join(prepared.work, 'target'))
  })

  it('replaces an earlier prepared directory', async () => {
    const { root, options: prepared } = options('mac-arm64')
    mkdirSync(join(root, 'runtime', 'zeromem'), { recursive: true })
    writeFileSync(join(root, 'runtime', 'zeromem', 'stale'), '')
    await prepareZeromem(prepared)
    expect(existsSync(join(root, 'runtime', 'zeromem', 'stale'))).toBe(false)
  })

  it('fails with a named error when cargo is missing, fails, or builds another architecture', async () => {
    const missing = options('mac-arm64').options
    await expect(prepareZeromem({ ...missing, cargo: [join(tempRoot(), 'no-cargo')] })).rejects.toThrow(/cargo was not found; install Rust from https:\/\/rustup\.rs with the aarch64-apple-darwin target, or set DSH_DESKTOP_OMIT_ZEROMEM=1/u)
    await expect(prepareZeromem(options('mac-x64', 'fail').options)).rejects.toThrow(/needs `rustup target add x86_64-apple-darwin`/u)
    const wrong = prepareZeromem(options('mac-arm64', 'wrong-arch').options)
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

  function script(serverName: string): string {
    const file = join(tempRoot(), 'zm')
    writeFileSync(file, `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{serverInfo:{name:${JSON.stringify(serverName)}}}})+'\\n')})\n`)
    chmodSync(file, 0o755)
    return file
  }

  it('skips a target this host cannot run', () => {
    expect(smokeZeromem('/nonexistent/zm', foreignTarget)).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('accepts a zeromem MCP answer and refuses another server', () => {
    expect(smokeZeromem(script('zeromem'), hostTarget)).toBe(true)
    expect(() => smokeZeromem(script('other'), hostTarget)).toThrow(/did not answer as a zeromem MCP server/u)
  })

  it.skipIf(process.env.DSH_ZEROMEM_ZM === undefined || process.env.DSH_ZEROMEM_ZM === '')('answers as zeromem from a real zm', () => {
    expect(smokeZeromem(process.env.DSH_ZEROMEM_ZM!, hostTarget)).toBe(true)
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
