/** Temporary workspace with the local filesystem provider and the wiki store. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WikiFilesystemKnowledge from '../src/index.ts'
import type { Config } from '../src/index.ts'

/** A workspace directory with mounted services. */
export interface Workspace {
  readonly dir: string
  readonly ctx: Context
  write(path: string, content: string): void
  dispose(): Promise<void>
}

/**
 * Seed files, mount `LocalFileSystem` at the directory, then the store.
 * @param files - workspace-relative path to content.
 * @param config - store config.
 * @returns the workspace.
 */
export async function workspace(files: Record<string, string>, config: Config = {}): Promise<Workspace> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-knowledge-'))
  const write = (path: string, content: string): void => {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  for (const [path, content] of Object.entries(files)) write(path, content)
  const ctx = new Context()
  await ctx.plugin(LocalFileSystem, { cwd: dir })
  await ctx.plugin(WikiFilesystemKnowledge, config)
  return {
    dir,
    ctx,
    write,
    async dispose() {
      await ctx.fiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/**
 * Page text with frontmatter lines and a body.
 * @param fields - frontmatter lines.
 * @param body - body text.
 * @returns the file text.
 */
export function page(fields: string[], body = ''): string {
  return `---\n${fields.join('\n')}\n---\n\n${body}\n`
}
