/**
 * Lexical detection of shell commands that create, change, move, or delete
 * files in the knowledge store (port of overstack R1 `no_write_raw.py`
 * `BASH_WRITE_TO_RAW` and `BASH_COPY_DEST_RAW`, widened to deletion, moves,
 * in-place editors, git path commands, and PowerShell cmdlets). A command that
 * names the store after a writing verb is refused even when the write would
 * land elsewhere.
 * @module @deepseek-ai/dsh-experimental-knowledge-rules/shell
 */

/** Model-facing reason for every refused direct write. */
export const STORE_WRITE_REASON = 'Pages in the knowledge store change only through knowledge_write, which records the session events each page is based on; this call would change the store directly. Use knowledge_write instead.'

/**
 * The store root as it appears in commands.
 * @param root - configured store root.
 * @returns the root without a leading `./`, surrounding blanks, or trailing slashes.
 */
export function normalizeStoreRoot(root: string): string {
  return root.trim().replace(/^\.\//, '').replace(/\/+$/, '')
}

/**
 * Escape a literal for a regular expression.
 * @param value - literal text.
 * @returns the escaped pattern.
 */
function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Why a shell command may not run.
 * @param command - the command line.
 * @param storeRoot - configured store root.
 * @returns {@link STORE_WRITE_REASON} when the command writes into the store, else `undefined`.
 */
export function shellWriteReason(command: string, storeRoot: string): string | undefined {
  const path = `['"]?(?:\\S*/)?${escapePattern(normalizeStoreRoot(storeRoot))}(?:/\\S*)?['"]?`
  const end = '(?:\\s|$|[|;&])'
  const patterns = [
    new RegExp(`>>?\\s*${path}${end}`),
    new RegExp(`\\b(?:rm|rmdir|unlink|mv|touch|truncate|mkdir|tee|git\\s+(?:rm|mv|checkout|restore|clean))\\b[^|;&]*\\s${path}${end}`),
    new RegExp(`\\b(?:sed|perl)\\b[^|;&]*\\s-\\w*i\\S*[^|;&]*\\s${path}${end}`),
    new RegExp(`\\b(?:cp|rsync|ln|install)\\b[^|;&]*\\s${path}\\s*(?:$|[|;&])`),
    new RegExp(`\\b(?:Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|Clear-Content)\\b[^|;]*\\s${path}(?:\\s|$|[|;])`, 'i'),
  ]
  return patterns.some(pattern => pattern.test(command)) ? STORE_WRITE_REASON : undefined
}
