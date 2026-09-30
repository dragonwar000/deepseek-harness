/** Official CLI output parsing: login state, signed-in identity, and login prompts. */
import { expect, it } from 'vitest'
import { CLI, LoginOutput, type KindCli } from '../src/cli.ts'

const inconclusive = { state: 'inconclusive' }

it('reads the Claude login state only from its JSON status', () => {
  const parse: KindCli['parseStatus'] = (...args) => CLI.claude.parseStatus(...args)
  expect(parse(0, JSON.stringify({ loggedIn: true, email: 'a@example.com', subscriptionType: 'pro' }), ''))
    .toEqual({ state: 'signedIn', identity: { email: 'a@example.com', plan: 'pro' } })
  expect(parse(0, JSON.stringify({ loggedIn: true }), '')).toEqual({ state: 'signedIn', identity: { email: null, plan: null } })
  // The shape the CLI printed when the user's account lapsed.
  const lapsed = JSON.stringify({ loggedIn: false, authMethod: 'none' })
  expect(parse(1, lapsed, '')).toEqual({ state: 'signedOut', message: lapsed })
  expect(parse(1, lapsed, '\n  Not logged in · Please run /login  \n')).toEqual({ state: 'signedOut', message: 'Not logged in · Please run /login' })
  expect(parse(1, lapsed, 'x'.repeat(500))).toEqual({ state: 'signedOut', message: 'x'.repeat(240) })
  expect(parse(0, JSON.stringify({ email: 'a@example.com' }), '')).toEqual(inconclusive)
  expect(parse(0, 'Logged in', '')).toEqual(inconclusive)
  expect(parse(1, JSON.stringify({ loggedIn: true }), '')).toEqual(inconclusive)
})

it('reads the Codex login state from its status text on either stream', () => {
  const parse: KindCli['parseStatus'] = (...args) => CLI.chatgpt.parseStatus(...args)
  expect(parse(0, '', 'Logged in using ChatGPT')).toEqual({ state: 'signedIn', identity: { email: null, plan: null } })
  expect(parse(0, 'Logged in using ChatGPT (me@example.org)', '')).toEqual({ state: 'signedIn', identity: { email: 'me@example.org', plan: null } })
  expect(parse(1, '', 'Not logged in')).toEqual({ state: 'signedOut', message: 'Not logged in' })
  expect(parse(1, '', '')).toEqual(inconclusive)
  expect(parse(0, '', 'Not signed in')).toEqual(inconclusive)
})

it('reports each new login prompt once across chunk boundaries and terminal escapes', () => {
  const claude = new LoginOutput(false)
  expect(claude.push('Opening browser…\n')).toBeUndefined()
  expect(claude.push('visit: \u001b]8;;https://claude.ai/x\u0007https://claude.ai/oauth/authorize?a=1\u001b]8;;\u0007\n'))
    .toEqual({ url: 'https://claude.ai/oauth/authorize?a=1', userCode: null })
  expect(claude.push('ABCD-EFGH\n')).toBeUndefined()

  const codex = new LoginOutput(true)
  expect(codex.push('   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\n')).toEqual({ url: 'https://auth.openai.com/codex/device', userCode: null })
  expect(codex.push('   \u001b[94mWXYZ-')).toBeUndefined()
  expect(codex.push('12345\u001b[0m\n')).toEqual({ url: 'https://auth.openai.com/codex/device', userCode: 'WXYZ-12345' })
  expect(codex.push('more output\n')).toBeUndefined()
})
