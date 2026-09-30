/**
 * Build the pinned zeromem `zm` with its default fastembed feature and place it, the bge-small-en-v1.5 model, and
 * their license texts in the Desktop runtime resources. Every downloaded input is pinned by URL and SHA-256 in
 * `zeromem-lock.json`: the static onnxruntime archive that `zm` links and each model file.
 */

import { execFileSync } from 'node:child_process'
import { chmodSync, closeSync, copyFileSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { x as extractTar } from 'tar'
import { downloadPrimaryRuntimeAsset } from '../../../scripts/primary-runtime/prepare.ts'
import { bundledZeromemExecutable, bundledZeromemModels } from '../src/zeromem.ts'
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

/**
 * Windows system libraries the onnxruntime archive's DirectML provider references. ort-sys links them only for an
 * archive it downloads itself, so a build that names the archive with `ORT_LIB_LOCATION` passes them to rustc.
 */
const WINDOWS_ONNXRUNTIME_LIBRARIES = ['dxguid', 'DXCORE', 'DXGI', 'D3D12', 'DirectML']

/** Hugging Face cache folder that fastembed reads the model from. */
const ZEROMEM_MODEL_FOLDER = `models--${lock.model.repository.replace('/', '--')}`

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
  /** Target-owned directory holding cargo's compilation cache, the extracted onnxruntime, and the install root. */
  readonly work: string
  /** SHA-256-addressed download cache for the onnxruntime archive, the model files, and the license texts. */
  readonly cache: string
  /** Command that runs cargo, followed by its leading arguments. */
  readonly cargo: readonly string[]
  /** Environment of the cargo process; the build variables of {@link zeromemBuildEnvironment} are replaced. */
  readonly environment: NodeJS.ProcessEnv
}

/**
 * Cargo arguments that compile the pinned revision with its lock file and its default features.
 * @param target - Desktop target.
 * @param root - cargo install root.
 * @returns Arguments after the cargo command.
 */
export function zeromemInstallArguments(target: ZeromemTarget, root: string): string[] {
  return ['install', '--git', lock.repository, '--rev', lock.rev, '--locked', '--force',
    '--target', ZEROMEM_RUST_TARGETS[target], '--root', root, lock.crate]
}

/**
 * Environment of the cargo build. `ORT_LIB_LOCATION` makes ort-sys link the verified static onnxruntime instead of
 * downloading one into the user cache directory, and `LIBONNXRUNTIME_NO_PKG_CONFIG` stops it from preferring an
 * onnxruntime installed on the build host.
 * @param target - Desktop target.
 * @param environment - Inherited environment.
 * @param work - Target-owned work directory.
 * @param onnxruntime - Directory holding the extracted static onnxruntime library.
 * @returns The cargo environment.
 */
export function zeromemBuildEnvironment(
  target: ZeromemTarget, environment: NodeJS.ProcessEnv, work: string, onnxruntime: string,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    CARGO_TARGET_DIR: join(work, 'target'),
    ORT_LIB_LOCATION: onnxruntime,
    LIBONNXRUNTIME_NO_PKG_CONFIG: '1',
    ...target === 'win-x64' ? { CARGO_ENCODED_RUSTFLAGS: WINDOWS_ONNXRUNTIME_LIBRARIES.flatMap(name => ['-l', name]).join('\x1f') } : {},
  }
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
 * Download the target's pinned static onnxruntime archive, verify its SHA-256, and extract it afresh.
 * @param target - Desktop target.
 * @param work - Target-owned work directory.
 * @param cache - Download cache.
 * @returns The directory holding the static library, for `ORT_LIB_LOCATION`.
 */
export async function prepareOnnxruntime(target: ZeromemTarget, work: string, cache: string): Promise<string> {
  const archive = lock.onnxruntime.archives[target]
  const file = await downloadPrimaryRuntimeAsset(archive.url, archive.sha256, cache)
  const destination = join(work, 'onnxruntime')
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(destination, { recursive: true })
  await extractTar({ file, cwd: destination })
  return join(destination, 'onnxruntime', 'lib')
}

/**
 * Place the pinned model files, verified by SHA-256, in the Hugging Face cache layout fastembed reads.
 * @param directory - Model directory that `zm` receives as `<home>/models`.
 * @param cache - Download cache.
 */
export async function installZeromemModel(directory: string, cache: string): Promise<void> {
  const folder = join(directory, ZEROMEM_MODEL_FOLDER)
  for (const [file, sha256] of Object.entries(lock.model.files)) {
    const source = await downloadPrimaryRuntimeAsset(`https://huggingface.co/${lock.model.repository}/resolve/${lock.model.rev}/${file}`, sha256, cache)
    const destination = join(folder, 'snapshots', lock.model.rev, ...file.split('/'))
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(source, destination)
  }
  mkdirSync(join(folder, 'refs'), { recursive: true })
  // hf-hub reads the revision without trimming it.
  writeFileSync(join(folder, 'refs', 'main'), lock.model.rev)
}

/**
 * Compile the pinned `zm` against the verified onnxruntime, verify its architecture, and copy it with the model and
 * the license texts of zeromem, onnxruntime, and bge-small-en-v1.5 into `<runtime>/zeromem`.
 * @param options - Target, output, cache, and cargo command.
 * @returns The prepared executable path.
 * @throws ZeromemBuildError when cargo is missing, fails, or produces another architecture.
 */
export async function prepareZeromem(options: PrepareZeromemOptions): Promise<string> {
  const { target } = options
  const triple = ZEROMEM_RUST_TARGETS[target]
  const { platform, arch } = desktopTargetPlatform(target)
  const root = join(options.work, 'install')
  mkdirSync(options.cache, { recursive: true })
  const onnxruntime = await prepareOnnxruntime(target, options.work, options.cache)
  const [command, ...leading] = options.cargo
  try {
    execFileSync(command!, [...leading, ...zeromemInstallArguments(target, root)], {
      stdio: 'inherit', env: zeromemBuildEnvironment(target, options.environment, options.work, onnxruntime),
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
  const directory = dirname(executable)
  rmSync(directory, { recursive: true, force: true })
  mkdirSync(directory, { recursive: true })
  copyFileSync(built, executable)
  chmodSync(executable, 0o755)
  const licenses: readonly (readonly [string, string, string])[] = [
    ['LICENSE', `https://raw.githubusercontent.com/ptaranat/zeromem/${lock.rev}/LICENSE`, lock.licenseSha256],
    ['onnxruntime-LICENSE', `https://raw.githubusercontent.com/microsoft/onnxruntime/${lock.onnxruntime.rev}/LICENSE`, lock.onnxruntime.licenseSha256],
    ['onnxruntime-ThirdPartyNotices.txt', `https://raw.githubusercontent.com/microsoft/onnxruntime/${lock.onnxruntime.rev}/ThirdPartyNotices.txt`, lock.onnxruntime.noticesSha256],
    [`${lock.model.name}-LICENSE`, `https://raw.githubusercontent.com/FlagOpen/FlagEmbedding/${lock.model.licenseRev}/LICENSE`, lock.model.licenseSha256],
  ]
  for (const [name, url, sha256] of licenses) {
    copyFileSync(await downloadPrimaryRuntimeAsset(url, sha256, options.cache), join(directory, name))
  }
  await installZeromemModel(bundledZeromemModels(options.runtime), options.cache)
  return executable
}

/** Two stored turns and a query that shares no word with the matching one, so only a semantic embedder recalls it. */
export const ZEROMEM_SMOKE = {
  turns: [
    { session_id: 'smoke-deploy', speaker: 'user', text: 'Our deploy script retries failed uploads with exponential backoff.', ts: 1, uuid: 'smoke-1' },
    { session_id: 'smoke-lunch', speaker: 'user', text: 'We ordered pizza for the team lunch on Friday.', ts: 2, uuid: 'smoke-2' },
  ],
  query: 'which command handles transient network errors when pushing artifacts?',
} as const

interface McpAnswer {
  readonly id?: number
  readonly result?: { readonly serverInfo?: { readonly name?: string }; readonly content?: readonly { readonly text?: string }[] }
}

/**
 * Run the prepared `zm` as an MCP server with the bundled model: it must answer as zeromem, report
 * bge-small-en-v1.5 rather than its hash embedder, and recall the smoke turn a paraphrase names.
 * @param executable - Prepared or packaged `zm`.
 * @param target - Desktop target of the executable.
 * @param models - Model directory prepared by {@link installZeromemModel}.
 * @returns false without running when the target differs from this host; true after a successful recall.
 * @throws ZeromemBuildError when `zm` fails, answers as another program, runs its hash embedder, or recalls another turn.
 */
export function smokeZeromem(executable: string, target: ZeromemTarget, models: string): boolean {
  const { platform, arch } = desktopTargetPlatform(target)
  if (platform !== process.platform || arch !== process.arch) return false
  const home = mkdtempSync(join(tmpdir(), 'dsh-zeromem-smoke-'))
  try {
    symlinkSync(models, join(home, 'models'), 'junction')
    mkdirSync(join(home, 'spool'))
    writeFileSync(join(home, 'spool', 'smoke.jsonl'), ZEROMEM_SMOKE.turns.map(turn => `${JSON.stringify(turn)}\n`).join(''))
    const call = (id: number, name: string, args: object): object => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
    const output = execFileSync(executable, ['mcp', '--home', home], {
      input: [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dsh-desktop-smoke', version: '1' } } },
        call(2, 'zeromem_stats', {}),
        call(3, 'zeromem_recall', { query: ZEROMEM_SMOKE.query, top_k: 1 }),
      ].map(message => `${JSON.stringify(message)}\n`).join(''),
      encoding: 'utf8', timeout: 120_000, env: {},
    })
    const answers = new Map(output.split('\n').filter(line => line !== '').map((line) => {
      const answer = JSON.parse(line) as McpAnswer
      return [answer.id, answer] as const
    }))
    const text = (id: number): string => answers.get(id)?.result?.content?.[0]?.text ?? '{}'
    if (answers.get(1)?.result?.serverInfo?.name !== 'zeromem') throw new Error(`unexpected answer ${output.trim()}`)
    const stats = JSON.parse(text(2)) as { embedder?: string; embedder_is_fallback?: boolean }
    if (stats.embedder !== lock.model.name || stats.embedder_is_fallback !== false) throw new Error(`zm reports embedder ${stats.embedder ?? 'none'} with fallback ${String(stats.embedder_is_fallback)}`)
    const recall = JSON.parse(text(3)) as { evidence?: readonly { text?: string; role?: string }[] }
    const [first] = recall.evidence ?? []
    if (first?.role !== 'Main' || first.text !== ZEROMEM_SMOKE.turns[0].text) throw new Error(`zm recalled ${JSON.stringify(recall.evidence ?? [])} for the paraphrase`)
    return true
  } catch (error) {
    throw new ZeromemBuildError(`${executable} did not recall a paraphrase with ${lock.model.name} from ${models}`, { cause: error })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

/**
 * Prepare `zm` and its model for the selected Desktop target unless the environment omits them.
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
  if (!options.deferSmoke) smokeZeromem(executable, target, bundledZeromemModels(paths.runtime))
  return executable
}

if (import.meta.main) await prepareDesktopZeromem()
