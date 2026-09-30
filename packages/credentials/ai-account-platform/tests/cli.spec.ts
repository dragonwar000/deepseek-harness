/** Official CLI output parsing: signed-in identity and login prompts. */
import { expect, it } from 'vitest'
import { CLI, LoginOutput, type KindCli } from '../src/cli.ts'

it('reads the Claude identity only from a signed-in JSON status', () => {
  const parse: KindCli['parseIdentity'] = (...args) => CLI.claude.parseIdentity(...args)
  expect(parse(0, JSON.stringify({ loggedIn: true, email: 'a@example.com', subscriptionType: 'pro' }), '')).toEqual({ email: 'a@example.com', plan: 'pro' })
  expect(parse(0, JSON.stringify({ loggedIn: true }), '')).toEqual({ email: null, plan: null })
  expect(parse(0, JSON.stringify({ loggedIn: false }), '')).toBeUndefined()
  expect(parse(0, JSON.stringify({ email: 'a@example.com' }), '')).toBeUndefined()
  expect(parse(0, 'Logged in', '')).toBeUndefined()
  expect(parse(1, JSON.stringify({ loggedIn: true }), '')).toBeUndefined()
})

it('reads the Codex identity from its status text on either stream', () => {
  const parse: KindCli['parseIdentity'] = (...args) => CLI.chatgpt.parseIdentity(...args)
  expect(parse(0, '', 'Logged in using ChatGPT')).toEqual({ email: null, plan: null })
  expect(parse(0, 'Logged in using ChatGPT (me@example.org)', '')).toEqual({ email: 'me@example.org', plan: null })
  expect(parse(1, '', 'Not logged in')).toBeUndefined()
  expect(parse(0, '', 'Not signed in')).toBeUndefined()
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
