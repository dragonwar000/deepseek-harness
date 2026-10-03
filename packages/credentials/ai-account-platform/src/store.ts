/** Durable AI Account metadata: one JSON file under the account root, replaced atomically. */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { AiAccountId, AiAccountKind } from '@deepseek-ai/dsh-ai-account'

/** Account ids name directories, so only Host-minted UUIDs are accepted from disk. */
const accountId = z.uuid().transform(value => value as AiAccountId)

const accountRecord = z.object({
  id: accountId,
  kind: z.enum(['claude', 'chatgpt']),
  email: z.string().nullable(),
  plan: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
})

const accountFile = z.object({
  version: z.literal(1),
  accounts: z.array(accountRecord),
  defaults: z.object({ claude: accountId.optional(), chatgpt: accountId.optional() }),
}).superRefine((file, issues) => {
  const ids = new Set<string>()
  for (const account of file.accounts) {
    if (ids.has(account.id)) issues.addIssue({ code: 'custom', message: `duplicate account ${account.id}` })
    ids.add(account.id)
  }
  for (const kind of ['claude', 'chatgpt'] as const) {
    const id = file.defaults[kind]
    if (id !== undefined && !file.accounts.some(account => account.id === id && account.kind === kind)) {
      issues.addIssue({ code: 'custom', message: `default ${kind} account ${id} is not a registered ${kind} account` })
    }
  }
})

/** One registered account's durable metadata; credentials are never stored here. */
export type AccountRecord = z.infer<typeof accountRecord>

/** The complete metadata file. */
export interface AccountFile {
  readonly version: 1
  readonly accounts: readonly AccountRecord[]
  readonly defaults: { readonly [Kind in AiAccountKind]?: AiAccountId | undefined }
}

/** Metadata before the first account is added. */
export const EMPTY_ACCOUNT_FILE: AccountFile = { version: 1, accounts: [], defaults: {} }

/**
 * Read and validate the metadata file.
 * @param path - absolute metadata file path.
 * @returns the stored metadata, or {@link EMPTY_ACCOUNT_FILE} when the file does not exist.
 * @throws when the file is unreadable, not JSON, or violates the metadata schema.
 */
export async function readAccountFile(path: string): Promise<AccountFile> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY_ACCOUNT_FILE
    throw error
  }
  const parsed = accountFile.safeParse(JSON.parse(text))
  if (!parsed.success) throw new Error(`ai-account: ${path} is not a valid account file: ${z.prettifyError(parsed.error)}`)
  return parsed.data
}

/**
 * Replace the metadata file through a same-directory temporary file and rename.
 * @param path - absolute metadata file path.
 * @param file - complete metadata to store.
 */
export async function writeAccountFile(path: string, file: AccountFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}
