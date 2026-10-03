// Scripted zm for the memory-episodes snapshot: answers zeromem's `zm mcp` MCP subset
// (https://github.com/ptaranat/zeromem, crates/zeromem/src/mcp.rs) with one stored conversation turn
// and one verified episode of an earlier session for every recall, leaves out the session named by
// exclude_session, and writes nothing. The store directory passed as --home is not read.

import { createInterface } from 'node:readline'

const STORED = [
  { turn_id: 1, session_id: 'earlier-session', session_turn: 0, speaker: 'user', text: 'Add a retry to the client.', ts: 1790000000, score: 1, role: 'Main' },
  { turn_id: 2, session_id: 'earlier-session', session_turn: 0, speaker: 'assistant', text: '# Verified episode\nTurn: 1\nFinal response event: 4\nVerifier event: 5; verdict: ok\n\n## Request\n\nAdd a retry to the client.\n\n## Outcome\n\nAdded three attempts with backoff.\n\n## Files changed\n\n- src/retry.ts — successful tool result event 3\n\n## Verification\n\nThe verifier accepted the final response at event 4.', ts: 1790000060, score: 0.5, role: 'LocalNeighbor' },
]

const reply = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
const input = createInterface({ input: process.stdin })
input.on('line', (line) => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  if (request.method === 'initialize') {
    reply({ id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'zeromem', version: '0.3.0' } } })
    return
  }
  const args = request.params.arguments ?? {}
  const value = request.params.name === 'zeromem_recall'
    ? { route: 'Local', evidence: STORED.filter(turn => turn.session_id !== args.exclude_session).slice(0, args.top_k ?? 5) }
    : { turns: STORED.length, sessions: 1, entities: 3, windows: 1, episodes: 1, embedder: 'hash-v1-256', embedder_is_fallback: true }
  reply({ id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], isError: false } })
})
input.on('close', () => process.exit(0))
