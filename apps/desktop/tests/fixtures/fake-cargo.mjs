/**
 * Stand-in for `cargo install`: records its arguments and writes a `zm` whose header names the requested
 * Rust target. `FAKE_CARGO_MODE=fail` exits 101; `FAKE_CARGO_MODE=wrong-arch` writes the other macOS architecture.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
appendFileSync(process.env.FAKE_CARGO_LOG, `${JSON.stringify({ args, targetDir: process.env.CARGO_TARGET_DIR })}\n`)
if (process.env.FAKE_CARGO_MODE === 'fail') process.exit(101)
const root = args[args.indexOf('--root') + 1]
let triple = args[args.indexOf('--target') + 1]
if (process.env.FAKE_CARGO_MODE === 'wrong-arch') triple = triple === 'aarch64-apple-darwin' ? 'x86_64-apple-darwin' : 'aarch64-apple-darwin'
mkdirSync(join(root, 'bin'), { recursive: true })
if (triple === 'x86_64-pc-windows-msvc') {
  const pe = Buffer.alloc(0x100)
  pe.write('MZ', 0, 'latin1')
  pe.writeUInt32LE(0x80, 0x3c)
  pe.write('PE\0\0', 0x80, 'latin1')
  pe.writeUInt16LE(0x8664, 0x84)
  writeFileSync(join(root, 'bin', 'zm.exe'), pe)
} else {
  const macho = Buffer.alloc(32)
  macho.writeUInt32LE(0xfeedfacf, 0)
  macho.writeUInt32LE(triple === 'aarch64-apple-darwin' ? 0x0100000c : 0x01000007, 4)
  writeFileSync(join(root, 'bin', 'zm'), macho)
}
