/** Account-local CLI credential files and macOS Keychain entries; secrets never enter command arguments. */
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { AiAccountKind } from '@deepseek-ai/dsh-ai-account'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

/** One existing credential location, with replacement constrained to that same location. */
export interface CliCredentialLocation {
  readonly text: string
  /** @param text - complete replacement CLI credential JSON. */
  write(text: string): Promise<void>
}

/**
 * Read one regular credential file without following a file symlink.
 * @param path - account-local credential path.
 * @returns its text, or `undefined` when no file exists.
 */
async function readCredentialFile(path: string): Promise<string | undefined> {
  try {
    const entry = await lstat(path)
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('CLI credential path must be a regular file')
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error('CLI credential file could not be read')
  }
}

/** Account-scoped access to vendor credential storage through the owned subprocess runtime. */
export class CliCredentialStorage {
  /**
   * @param subprocess - execution runtime for macOS Keychain commands.
   * @param graceMs - termination grace for those commands.
   */
  constructor(private readonly subprocess: SubprocessRuntime, private readonly graceMs: number) {}

  /**
   * Read an existing credential location for a registered account.
   * @param kind - product that owns the credential.
   * @param home - registered account's configuration directory.
   * @param signal - operation deadline and provider lifetime.
   * @returns the existing file or Keychain item; `undefined` when no supported credential exists.
   */
  async read(kind: AiAccountKind, home: string, signal: AbortSignal): Promise<CliCredentialLocation | undefined> {
    const directory = await lstat(home)
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('CLI account directory must be a real directory')
    const path = join(home, kind === 'claude' ? '.credentials.json' : 'auth.json')
    const text = await readCredentialFile(path)
    if (text !== undefined) return {
      text,
      write: async (next) => {
        signal.throwIfAborted()
        await writeFileAtomic(path, `${next}\n`, { mode: 0o600, dirMode: 0o700 })
      },
    }
    if (process.platform !== 'darwin') return undefined
    const canonical = await realpath(home)
    const service = kind === 'claude'
      ? `Claude Code-credentials-${createHash('sha256').update(home.normalize('NFC')).digest('hex').slice(0, 8)}`
      : 'Codex Auth'
    const account = kind === 'claude' ? userInfo().username : `cli|${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`
    const result = await this.security(home, ['find-generic-password', '-s', service, '-a', account, '-w'], undefined, signal)
    if (result.exitCode === 44) return undefined
    if (result.exitCode !== 0) throw new Error('CLI Keychain credential could not be read')
    return {
      text: result.text.trim(),
      write: async (next) => {
        const quote = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
        // security's interactive command reader accepts quoted arguments on stdin; the secret stays out of argv.
        const input = `add-generic-password -U -s ${quote(service)} -a ${quote(account)} -w ${quote(next)}\n`
        const written = await this.security(home, ['-i'], input, signal)
        if (written.exitCode !== 0) throw new Error('CLI Keychain credential could not be written')
        const confirmed = await this.security(home, ['find-generic-password', '-s', service, '-a', account, '-w'], undefined, signal)
        if (confirmed.exitCode !== 0 || confirmed.text.trim() !== next) throw new Error('CLI Keychain credential replacement was not stored')
      },
    }
  }

  private async security(home: string, args: string[], input: string | undefined, signal: AbortSignal) {
    const child = this.subprocess.spawn({
      argv: ['/usr/bin/security', ...args], cwd: home, env: {}, graceMs: this.graceMs, signal,
      stdio: { stdin: input === undefined ? 'ignore' : { data: input }, stdout: 'pipe', stderr: 'pipe' },
    })
    child.stderr?.resume()
    let text = ''
    try {
      if (child.stdout !== undefined) {
        for await (const chunk of child.stdout) {
          text += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
          if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('CLI Keychain credential exceeds the storage limit')
        }
      }
      const outcome = await child.done
      signal.throwIfAborted()
      return { exitCode: outcome.exitCode, text }
    } finally {
      await child.terminate()
    }
  }
}
