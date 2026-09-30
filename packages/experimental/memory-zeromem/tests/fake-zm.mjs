// Scripted stand-in for zeromem's `zm [--no-model] mcp --home <dir>` (https://github.com/ptaranat/zeromem,
// crates/zeromem/src/mcp.rs and spool.rs). It speaks the same newline-delimited JSON-RPC subset, drains
// `<home>/spool/*.jsonl` with source-uuid dedup before every tool call, keeps turns in
// `<home>/fake-store.json`, and returns the recall, stats, and forget results in zeromem's field names.
// Recall scores a turn by the query words it contains. `--fake-mode <mode>` placed before zeromem's
// own arguments scripts a failure. Every invocation is appended to `<home>/fake-calls.jsonl`.

import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
let mode = 'normal'
const modeAt = args.indexOf('--fake-mode')
if (modeAt !== -1) {
  mode = args[modeAt + 1]
  args.splice(modeAt, 2)
}
const noModel = args.includes('--no-model')
// zm reports its hash embedder with --no-model, or when fastembed is not compiled in (mode fallback).
const fallback = noModel || mode === 'fallback'
const homeAt = args.indexOf('--home')
const command = args.filter(arg => arg !== '--no-model')[0]
if (command !== 'mcp' || homeAt === -1) {
  process.stderr.write('zm: usage: zm [--db PATH] [--no-model] <command>\n')
  process.exit(1)
}
const home = args[homeAt + 1]
appendFileSync(join(home, 'fake-calls.jsonl'), `${JSON.stringify({ argv: args, cwd: process.cwd() })}\n`)

if (mode === 'exit') {
  process.stderr.write('zm: database is locked\n')
  process.exit(3)
}

const storePath = join(home, 'fake-store.json')
const load = () => (existsSync(storePath) ? JSON.parse(readFileSync(storePath, 'utf8')) : { turns: [] })
const save = store => writeFileSync(storePath, JSON.stringify(store))

function drain(store) {
  const spool = join(home, 'spool')
  if (!existsSync(spool)) return
  for (const name of readdirSync(spool).filter(file => file.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(join(spool, name), 'utf8').split('\n').filter(entry => entry.trim() !== '')) {
      const turn = JSON.parse(line)
      if (!store.turns.some(stored => stored.uuid === turn.uuid)) store.turns.push(turn)
    }
    rmSync(join(spool, name))
  }
}

const words = text => text.toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 2)

function recall(store, argsOf) {
  const query = new Set(words(argsOf.query))
  const scored = store.turns
    .filter(turn => turn.session_id !== argsOf.exclude_session)
    .map(turn => ({ turn, score: words(turn.text).filter(word => query.has(word)).length }))
    .filter(entry => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, argsOf.top_k ?? 5)
  const evidence = scored.map((entry, index) => ({
    turn_id: store.turns.indexOf(entry.turn) + 1,
    session_id: entry.turn.session_id,
    session_turn: 0,
    speaker: entry.turn.speaker,
    text: entry.turn.text,
    ts: entry.turn.ts,
    score: entry.score,
    role: index === 0 ? 'Main' : 'LocalNeighbor',
  }))
  return { route: 'Local', evidence, ...fallback ? { warning: { note: 'zeromem is running on the hash fallback embedder' } } : {} }
}

function call(name, argsOf) {
  if (mode === 'tool-error') return { text: 'store is corrupt', isError: true }
  if (mode === 'not-json') return { text: 'plain words', isError: false }
  if (mode === 'bad-fields') return { text: '{"evidence":[{"text":1}]}', isError: false }
  const store = load()
  drain(store)
  let value
  if (name === 'zeromem_recall') {
    if (typeof argsOf.query !== 'string') return { text: 'query is required', isError: true }
    value = recall(store, argsOf)
  } else if (name === 'zeromem_stats') {
    value = { turns: store.turns.length, sessions: new Set(store.turns.map(turn => turn.session_id)).size, entities: 0, windows: 0, episodes: 0, embedder: fallback ? 'hash-v1-256' : 'fake-embedder', embedder_is_fallback: fallback }
  } else if (name === 'zeromem_forget_session') {
    const before = store.turns.length
    store.turns = store.turns.filter(turn => turn.session_id !== argsOf.session_id)
    value = { session_id: argsOf.session_id, deleted_turns: before - store.turns.length }
  } else {
    return { text: `unknown tool ${name}`, isError: true }
  }
  save(store)
  return { text: JSON.stringify(value, null, 2), isError: false }
}

const reply = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
const input = createInterface({ input: process.stdin })
input.on('line', (line) => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  if (request.method === 'initialize') {
    process.stdout.write('zeromem: warming up\n')
    reply({ id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: mode === 'impostor' ? 'other-server' : 'zeromem', version: '0.3.0' } } })
    return
  }
  if (mode === 'silent' || mode === 'hang') return
  if (mode === 'bad-result') {
    reply({ id: request.id, result: { content: [] } })
    return
  }
  if (mode === 'rpc-error') {
    reply({ id: request.id, error: { code: -32601, message: 'method not found: tools/call' } })
    return
  }
  const { text, isError } = call(request.params.name, request.params.arguments ?? {})
  reply({ id: request.id, result: { content: [{ type: 'text', text }], isError } })
})
input.on('close', () => {
  if (mode === 'hang') setInterval(() => {}, 1000)
  else process.exit(0)
})
