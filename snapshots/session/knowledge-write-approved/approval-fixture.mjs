/** Headless has no approval answerer; allow every asked approval once so the granted path is recorded. */
export const name = 'approval-fixture'
export const inject = ['approval']

export function apply(ctx) {
  ctx.on('approval/request', () => Promise.resolve('allowed-once'))
}
