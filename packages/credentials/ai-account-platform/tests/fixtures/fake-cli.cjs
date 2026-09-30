#!/usr/bin/env node
// Fake `claude` / `codex` executable for AI Account tests. The copy's basename
// selects the product; files beside the copy script its behavior and record calls.
//
// Both login commands are interactive terminal programs, like the official CLIs:
// they refuse to run without a terminal on standard input. `claude` then reads the
// authorization code its browser page shows, and `codex` polls for authorization
// (its `.approve` file standing in for the authorization server) without reading
// anything, matching `awaitsCode` in `src/cli.ts`.
const { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { basename, dirname, join } = require('node:path')

const product = basename(process.argv[1])
const here = dirname(process.argv[1])
const args = process.argv.slice(2).join(' ')
const home = product === 'claude' ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME
const behaviorFile = join(here, `${product}.behavior`)
const behavior = existsSync(behaviorFile) ? readFileSync(behaviorFile, 'utf8').trim() : ''
const signedIn = join(home, 'fake-signed-in')
appendFileSync(join(here, 'calls.log'), `${JSON.stringify({ product, args, home })}\n`)

function succeed() {
  writeFileSync(signedIn, 'yes')
  process.exit(0)
}

/** Poll for the authorization an out-of-band service grants; the Codex device flow reads no input. */
function waitForApproval() {
  const approval = join(here, `${product}.approve`)
  const timer = setInterval(() => {
    if (!existsSync(approval)) return
    clearInterval(timer)
    rmSync(approval)
    succeed()
  }, 10)
}

/** Read the authorization code from this command's terminal, the way the Claude login does. */
function readCode() {
  process.stdout.write('Paste code here if prompted > ')
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    const end = buffer.search(/[\r\n]/)
    if (end < 0) return
    const code = buffer.slice(0, end).trim()
    buffer = buffer.slice(end + 1)
    if (code.length === 0) return
    if (behavior === 'code-rejected') {
      process.stdout.write('That code is not valid.\n')
      process.exit(1)
    }
    writeFileSync(join(here, 'submitted-code'), code)
    succeed()
  })
  process.stdin.resume()
}

if (args === 'auth login --claudeai' || args === 'login --device-auth') {
  if (behavior === 'login-fails') {
    process.stderr.write('login failed\n')
    process.exit(1)
  }
  // The official login commands render a terminal interface and read their
  // confirmation from it. Without a terminal there is no channel to confirm on,
  // so refuse instead of printing a URL that can never be answered.
  if (process.stdin.isTTY !== true) {
    process.stderr.write('claude: raw mode is not supported on the current process.stdin\n')
    process.exit(2)
  }
  if (product === 'claude') {
    process.stdout.write('Opening browser to sign in…\n')
    process.stdout.write("If the browser didn't open, visit: https://claude.ai/oauth/authorize?code=true&state=fake\n")
    readCode()
  } else {
    process.stdout.write('\u001b[1mFollow these steps to sign in with ChatGPT using device code authorization:\u001b[0m\n\n')
    process.stdout.write('1. Open this link in your browser and sign in to your account\n   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\n\n')
    setTimeout(() => process.stdout.write('2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m\n   \u001b[94mABCD-EFGHI\u001b[0m\n'), 20)
    waitForApproval()
  }
} else if (args === 'auth status --json') {
  if (behavior === 'status-garbage') {
    process.stdout.write('not json\n')
    process.exit(0)
  }
  const loggedIn = existsSync(signedIn)
  process.stdout.write(JSON.stringify(loggedIn
    ? { loggedIn: true, authMethod: 'claude.ai', email: 'claude-user@example.com', subscriptionType: 'max' }
    : { loggedIn: false, authMethod: 'none' }))
  process.exit(loggedIn ? 0 : 1)
} else if (args === 'login status') {
  if (!existsSync(signedIn)) {
    process.stderr.write('Not logged in\n')
    process.exit(1)
  }
  process.stderr.write(behavior === 'status-email' ? 'Logged in using ChatGPT (codex-user@example.com)\n' : 'Logged in using ChatGPT\n')
  process.exit(0)
} else if (args === 'auth logout' || args === 'logout') {
  rmSync(signedIn, { force: true })
  process.exit(behavior === 'logout-fails' ? 3 : 0)
} else {
  process.stderr.write(`unexpected arguments: ${args}\n`)
  process.exit(64)
}
