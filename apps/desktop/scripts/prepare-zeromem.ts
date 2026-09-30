/** Build the pinned zeromem `zm` executable with cargo and place it in the Desktop runtime resources. */

import { execFileSync } from 'node:child_process'
import { chmodSync, closeSync, copyFileSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { downloadPrimaryRuntimeAsset } from '../../../scripts/primary-runtime/prepare.ts'
import { bundledZeromemExecutable } from '../src/zeromem.ts'
import { desktopTargetPlatform, resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import lock from './zeromem-lock.json' with { type: 'json' }

/** A supported Desktop packaging target. */
export type ZeromemTarget = 'mac-arm64' | 'mac-x64' | 'win-x64'

/** Rust target triple compiled for each Desktop target. */
export const ZEROMEM_RUST_TARGETS: Readonly<Record<ZeromemTarget, string>> = {
  'mac-arm64': 'aarch64-apple-darwin',
  'mac-x64': 'x86_64-apple-darwin',
  'win-x64': 'x86_64-pc-windows-msvc',
}

/** Packaging environment variable that builds Desktop without `zm`; memory-zeromem then needs `zm` on `PATH`. */
export const OMIT_ZEROMEM_ENV = 'DSH_DESKTOP_OMIT_ZEROMEM'

/** The pinned `zm` could not be built, or the build produced another architecture's executable. */
export class ZeromemBuildError extends Error {
  /**
   * @param message - What failed and how to proceed.
   * @param options - The underlying failure.
   */
  constructor(message: string, options?: ErrorOptions) {
    super(`desktop zeromem: ${message}`, options)
    this.name = 'ZeromemBuildError'
  }
}

/** Inputs of one `zm` preparation. */
export interface PrepareZeromemOptions {
  /** Desktop target whose `zm` is compiled. */
  readonly target: ZeromemTarget
  /** Runtime resource directory receiving `zeromem/`. */
  readonly runtime: string
  /** Target-owned directory holding cargo's compilation cache and install root. */
  readonly work: string
  /** SHA-256-addressed download cache for the license text. */
  readonly cache: string
  /** Command that runs cargo, followed by its leading arguments. */
  readonly cargo: readonly string[]
  /** Environment of the cargo process; `CARGO_TARGET_DIR` is replaced. */
  readonly environment: NodeJS.ProcessEnv
}

/**
 * Cargo arguments that compile the pinned revision with its lock file and without the fastembed feature.
 * @param target - Desktop target.
 * @param root - cargo install root.
 * @returns Arguments after the cargo command.
 */
export function zeromemInstallArguments(target: ZeromemTarget, root: string): string[] {
  return ['install', '--git', lock.repository, '--rev', lock.rev, '--locked', '--no-default-features', '--force',
    '--target', ZEROMEM_RUST_TARGETS[target], '--root', root, lock.crate]
}

function header(path: string, length: number): Buffer {
  const descriptor = openSync(path, 'r')
  try {
    const bytes = Buffer.alloc(length)
    return bytes.subarray(0, readSync(descriptor, bytes, 0, length, 0))
  } finally { closeSync(descriptor) }
}

/**
 * Architecture of a thin 64-bit Mach-O or a PE executable.
 * @param path - Executable file.
 * @returns `darwin-arm64`, `darwin-x64`, `win32-x64`, or `unknown`.
 */
export function executableArchitecture(path: string): string {
  const bytes = header(path, 4096)
  if (bytes.length >= 8 && bytes.readUInt32LE(0) === 0xfeedfacf) {
    const cpu = bytes.readUInt32LE(4)
    return cpu === 0x0100000c ? 'darwin-arm64' : cpu === 0x01000007 ? 'darwin-x64' : 'unknown'
  }
  if (bytes.length >= 0x40 && bytes.toString('latin1', 0, 2) === 'MZ') {
    const pe = bytes.readUInt32LE(0x3c)
    if (pe + 6 <= bytes.length && bytes.toString('latin1', pe, pe + 4) === 'PE\0\0' && bytes.readUInt16LE(pe + 4) === 0x8664) return 'win32-x64'
  }
  return 'unknown'
}

/**
 * Compile the pinned `zm`, verify its architecture, and copy it with zeromem's license into `<runtime>/zeromem`.
 * @param options - Target, output, cache, and cargo command.
 * @returns The prepared executable path.
 * @throws ZeromemBuildError when cargo is missing, fails, or produces another architecture.
 */
export async function prepareZeromem(options: PrepareZeromemOptions): Promise<string> {
  const { target } = options
  const triple = ZEROMEM_RUST_TARGETS[target]
  const { platform, arch } = desktopTargetPlatform(target)
  const root = join(options.work, 'install')
  const [command, ...leading] = options.cargo
  try {
    execFileSync(command!, [...leading, ...zeromemInstallArguments(target, root)], {
      stdio: 'inherit', env: { ...options.environment, CARGO_TARGET_DIR: join(options.work, 'target') },
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ZeromemBuildError(`cargo was not found; install Rust from https://rustup.rs with the ${triple} target, or set ${OMIT_ZEROMEM_ENV}=1 to build Desktop without zm`, { cause: error })
    }
    throw new ZeromemBuildError(`cargo could not build zeromem ${lock.rev} for ${triple}; a build for another architecture needs \`rustup target add ${triple}\``, { cause: error })
  }
  const built = join(root, 'bin', platform === 'win32' ? 'zm.exe' : 'zm')
  const found = executableArchitecture(built)
  if (found !== `${platform}-${arch}`) throw new ZeromemBuildError(`${built} is a ${found} executable, not ${platform}-${arch}`)
  const executable = bundledZeromemExecutable(options.runtime, platform)
  rmSync(dirname(executable), { recursive: true, force: true })
  mkdirSync(dirname(executable), { recursive: true })
  copyFileSync(built, executable)
  chmodSync(executable, 0o755)
  mkdirSync(options.cache, { recursive: true })
  const license = await downloadPrimaryRuntimeAsset(`https://raw.githubusercontent.com/ptaranat/zeromem/${lock.rev}/LICENSE`, lock.licenseSha256, options.cache)
  copyFileSync(license, join(dirname(executable), 'LICENSE'))
  return executable
}

/**
 * Run the prepared `zm` as an MCP server with its hash embedder and check that it answers as zeromem.
 * @param executable - Prepared or packaged `zm`.
 * @param target - Desktop target of the executable.
 * @returns false without running when the target differs from this host; true after a successful answer.
 * @throws ZeromemBuildError when `zm` fails or answers as another program.
 */
export function smokeZeromem(executable: string, target: ZeromemTarget): boolean {
  const { platform, arch } = desktopTargetPlatform(target)
  if (platform !== process.platform || arch !== process.arch) return false
  const home = mkdtempSync(join(tmpdir(), 'dsh-zeromem-smoke-'))
  try {
    const output = execFileSync(executable, ['--no-model', 'mcp', '--home', home], {
      input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dsh-desktop-smoke', version: '1' } } })}\n`,
      encoding: 'utf8', timeout: 30_000, env: {},
    })
    const response = JSON.parse(output.split('\n')[0]!) as { result?: { serverInfo?: { name?: unknown } } }
    if (response.result?.serverInfo?.name !== 'zeromem') throw new Error(`unexpected answer ${output.trim()}`)
    return true
  } catch (error) {
    throw new ZeromemBuildError(`${executable} did not answer as a zeromem MCP server`, { cause: error })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

/**
 * Prepare `zm` for the selected Desktop target unless the environment omits it.
 * @param options - Signed Windows packaging defers execution until the packaged smoke runs the signed `zm`.
 * @param environment - Packaging or development environment.
 * @returns The prepared executable, or undefined when {@link OMIT_ZEROMEM_ENV} is `1`.
 */
export async function prepareDesktopZeromem(
  options: { readonly deferSmoke?: boolean } = {}, environment: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const target = resolveDesktopBuildTarget(environment)
  const paths = resolveDesktopTargetBuildPaths(environment)
  if (environment[OMIT_ZEROMEM_ENV] === '1') {
    console.warn(`desktop zeromem: ${OMIT_ZEROMEM_ENV}=1, so this build carries no zm`)
    return undefined
  }
  const executable = await prepareZeromem({
    target, runtime: paths.runtime, work: join(paths.root, 'zeromem'), cache: paths.downloads, cargo: ['cargo'], environment,
  })
  if (!options.deferSmoke) smokeZeromem(executable, target)
  return executable
}

if (import.meta.main) await prepareDesktopZeromem()
