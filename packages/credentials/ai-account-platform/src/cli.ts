/** Official Claude Code and Codex CLI invocations and parsers for their account-management output. */
import { z } from 'zod'
import type { AiAccountKind, AiAccountSignInPhase } from '@deepseek-ai/dsh-ai-account'

/** Account identity reported by an official CLI's status command. */
export interface CliIdentity {
  readonly email: string | null
  readonly plan: string | null
}

/**
 * One finished status command, read as a login state. `inconclusive` covers output that is neither a
 * signed-in nor a signed-out answer (an unexpected exit code, unreadable output), which must not be
 * reported to the user as a sign-out.
 */
export type CliStatus =
  | { readonly state: 'signedIn'; readonly identity: CliIdentity }
  | { readonly state: 'signedOut'; readonly message: string }
  | { readonly state: 'inconclusive' }

/** Characters kept from the CLI line quoted with a signed-out answer. */
const MESSAGE_LIMIT_CHARS = 240

/**
 * Quote the CLI's own explanation of a signed-out answer.
 * @param stdout - collected standard output.
 * @param stderr - collected standard error, preferred because the CLIs explain failures there.
 * @returns the first non-empty line, shortened to the message limit; empty when the CLI printed nothing.
 */
function firstLine(stdout: string, stderr: string): string {
  return `${stderr}\n${stdout}`.trim().replace(/\s*\n[\s\S]*$/, '').slice(0, MESSAGE_LIMIT_CHARS)
}

/** The status answer for output that states no sign-in status. */
export const INCONCLUSIVE: CliStatus = { state: 'inconclusive' }

/** How one account kind's official CLI signs in, identifies, and signs out against one configuration directory. */
export interface KindCli {
  /** Directory segment under the account root that holds this kind's per-account directories. */
  readonly directory: string
  /** Environment variable that points the CLI at one account's configuration directory. */
  readonly homeEnv: 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME'
  readonly loginArgs: readonly string[]
  readonly statusArgs: readonly string[]
  readonly logoutArgs: readonly string[]
  /** Phase shown while the login command waits for the user. */
  readonly waitingPhase: Extract<AiAccountSignInPhase, 'waiting-browser' | 'waiting-device-code'>
  /** Whether the login output carries a one-time device code. */
  readonly deviceCode: boolean
  /**
   * Whether the login command reads an authorization code from its terminal. This is a
   * per-kind fact rather than a match against the CLI's prompt text, so a reworded prompt
   * cannot hide the field the user needs. Claude's browser page ends on a code the user
   * copies back; Codex polls for authorization and reads nothing.
   */
  readonly awaitsCode: boolean
  /**
   * Read the login state from a finished status command.
   * @param exitCode - status command exit code.
   * @param stdout - collected standard output.
   * @param stderr - collected standard error.
   * @returns the signed-in identity, a signed-out answer with the CLI's explanation, or `inconclusive`.
   */
  parseStatus(exitCode: number | null, stdout: string, stderr: string): CliStatus
}

/** Fields of `claude auth status --json` this package reads; the CLI prints more. */
const claudeStatus = z.object({
  loggedIn: z.boolean(),
  email: z.string().min(1).optional(),
  subscriptionType: z.string().min(1).optional(),
})

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/

/** Per-kind official CLI contract. */
export const CLI: Readonly<Record<AiAccountKind, KindCli>> = {
  claude: {
    directory: 'claude',
    homeEnv: 'CLAUDE_CONFIG_DIR',
    loginArgs: ['auth', 'login', '--claudeai'],
    statusArgs: ['auth', 'status', '--json'],
    logoutArgs: ['auth', 'logout'],
    waitingPhase: 'waiting-browser',
    deviceCode: false,
    awaitsCode: true,
    parseStatus(exitCode, stdout, stderr) {
      let raw: unknown
      try {
        raw = JSON.parse(stdout)
      } catch (_notJson) {
        return INCONCLUSIVE
      }
      const parsed = claudeStatus.safeParse(raw)
      if (!parsed.success) return INCONCLUSIVE
      // `claude auth status --json` exits 1 with `loggedIn: false`; a signed-in answer must also exit 0.
      if (!parsed.data.loggedIn) return { state: 'signedOut', message: firstLine(stdout, stderr) }
      if (exitCode !== 0) return INCONCLUSIVE
      return { state: 'signedIn', identity: { email: parsed.data.email ?? null, plan: parsed.data.subscriptionType ?? null } }
    },
  },
  chatgpt: {
    directory: 'codex',
    homeEnv: 'CODEX_HOME',
    loginArgs: ['login', '--device-auth'],
    statusArgs: ['login', 'status'],
    logoutArgs: ['logout'],
    waitingPhase: 'waiting-device-code',
    deviceCode: true,
    awaitsCode: false,
    parseStatus(exitCode, stdout, stderr) {
      const text = `${stdout}\n${stderr}`
      if (/not logged in/i.test(text)) return { state: 'signedOut', message: firstLine(stdout, stderr) }
      if (exitCode !== 0 || !/logged in/i.test(text)) return INCONCLUSIVE
      return { state: 'signedIn', identity: { email: EMAIL.exec(text)?.[0] ?? null, plan: null } }
    },
  },
}

const ESCAPES = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u001B\[[0-?]*[ -/]*[@-~]/g
const URL_PATTERN = /https:\/\/[^\s"'<>\u001B]+/
const DEVICE_CODE = /\b[A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+\b/

/** Largest login-output tail kept for scanning; the URL and code appear within the first lines. */
const SCAN_LIMIT_CHARS = 16 * 1024

/** Values a login command has printed so far. */
export interface LoginPrompt {
  readonly url: string | null
  readonly userCode: string | null
}

/** Incremental scanner for the verification URL and device code a login command prints. */
export class LoginOutput {
  private text = ''
  private prompt: LoginPrompt = { url: null, userCode: null }

  /** @param deviceCode - whether to look for a one-time device code after the URL. */
  constructor(private readonly deviceCode: boolean) {}

  /**
   * Append one decoded output chunk.
   * @param chunk - text from standard output or standard error.
   * @returns the prompt when this chunk revealed a new URL or code, otherwise `undefined`.
   */
  push(chunk: string): LoginPrompt | undefined {
    this.text = `${this.text}${chunk}`.slice(-SCAN_LIMIT_CHARS)
    const plain = this.text.replace(ESCAPES, '')
    const url = this.prompt.url ?? URL_PATTERN.exec(plain)?.[0] ?? null
    const userCode = this.prompt.userCode
      ?? (this.deviceCode && url !== null ? DEVICE_CODE.exec(plain.slice(plain.indexOf(url) + url.length))?.[0] ?? null : null)
    if (url === this.prompt.url && userCode === this.prompt.userCode) return undefined
    this.prompt = { url, userCode }
    return this.prompt
  }
}
