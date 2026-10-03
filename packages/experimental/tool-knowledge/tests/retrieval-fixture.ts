/**
 * Keyless retrieval fixture for `knowledge_query`: a small engineering wiki
 * and held-out questions, each with the store pages that answer it. The
 * questions use the phrasing a model would send, not the page titles.
 */

/** One store page: store-relative id, frontmatter type and title, and body. */
export interface FixturePage {
  readonly id: string
  readonly type: string
  readonly title: string
  readonly body: string
}

/** One question with the pages that answer it. */
export interface FixtureQuery {
  readonly query: string
  readonly expected: readonly string[]
}

/** The wiki pages. */
export const RETRIEVAL_PAGES: readonly FixturePage[] = [
  { id: 'concepts/retry-policy.md', type: 'concept', title: 'Retry policy', body: 'Outbound HTTP requests retry three times on 5xx responses and connection resets. Each retry waits according to the backoff schedule. Requests that are not idempotent never retry.' },
  { id: 'concepts/backoff.md', type: 'concept', title: 'Exponential backoff', body: 'The wait before attempt n is base * 2^n with full jitter, capped at 30 seconds. Jitter spreads retries from many clients so they do not arrive together.' },
  { id: 'concepts/circuit-breaker.md', type: 'concept', title: 'Circuit breaker', body: 'After five consecutive failures to a dependency the breaker opens and calls fail fast for 60 seconds. A single probe call then decides whether the breaker closes again.' },
  { id: 'concepts/rate-limiting.md', type: 'concept', title: 'Rate limiting', body: 'The API gateway enforces a token bucket per API key: 100 requests per minute with a burst of 20. Clients over the limit receive 429 with a Retry-After header.' },
  { id: 'concepts/cache-invalidation.md', type: 'concept', title: 'Cache invalidation', body: 'Product pages are cached in Redis for ten minutes. A write to the catalog publishes an invalidation event that deletes the affected keys.' },
  { id: 'concepts/auth-tokens.md', type: 'concept', title: 'Access and refresh tokens', body: 'Access tokens are JWTs valid for 15 minutes. The client exchanges a refresh token, valid for 30 days, for a new access token. Refresh tokens rotate on every use.' },
  { id: 'concepts/session-storage.md', type: 'concept', title: 'Session storage', body: 'Browser sessions are stored server side in Postgres, keyed by an opaque cookie. Expired sessions are swept nightly.' },
  { id: 'concepts/structured-logging.md', type: 'concept', title: 'Structured logging', body: 'Services log JSON lines with a trace id, level, and message. Never log secrets or personal data; the logger redacts known token fields.' },
  { id: 'concepts/metrics.md', type: 'concept', title: 'Metrics and alerts', body: 'Every service exports Prometheus counters and latency histograms. Alerts page the on-call engineer when the error rate exceeds two percent for five minutes.' },
  { id: 'concepts/feature-flags.md', type: 'concept', title: 'Feature flags', body: 'New behavior ships behind a flag that is off by default. Flags are evaluated per request and can target a percentage of users.' },
  { id: 'concepts/config-loading.md', type: 'concept', title: 'Configuration loading', body: 'Configuration is read from environment variables first, then from config.yaml. A missing required key stops the service at startup.' },
  { id: 'concepts/queue-workers.md', type: 'concept', title: 'Queue workers', body: 'Background jobs run on queue workers that acknowledge a message only after the job commits. A job that fails five times moves to the dead letter queue.' },
  { id: 'concepts/websocket-reconnect.md', type: 'concept', title: 'WebSocket reconnect', body: 'The client reconnects a dropped WebSocket with backoff and resubscribes to every channel it held, resuming from the last event id.' },
  { id: 'decisions/postgres-over-mongo.md', type: 'decision', title: 'Postgres over MongoDB', body: 'We chose Postgres because orders need transactions across tables and the team already runs it. MongoDB was rejected for the order service.' },
  { id: 'decisions/monorepo.md', type: 'decision', title: 'One monorepo', body: 'All services live in one repository so a change to a shared library and its consumers lands in one pull request.' },
  { id: 'procedures/database-migrations.md', type: 'procedure', title: 'Database migrations', body: 'Write each schema migration as an expand step and a later contract step. Run migrations before deploying code that needs the new columns; never drop a column in the same release that stops using it.' },
  { id: 'procedures/deployment.md', type: 'procedure', title: 'Deployment', body: 'Deploys roll out to one canary instance, wait ten minutes of healthy metrics, then continue to the rest of the fleet. Roll back by redeploying the previous image tag.' },
  { id: 'procedures/release.md', type: 'procedure', title: 'Release process', body: 'Cut a release branch on Monday, tag a release candidate, and promote it after QA signs off. The changelog is generated from merged pull request titles.' },
  { id: 'procedures/ci-pipeline.md', type: 'procedure', title: 'CI pipeline', body: 'Every pull request runs lint, type checks, unit tests, and integration tests in parallel. A red check blocks the merge.' },
  { id: 'procedures/incident-response.md', type: 'procedure', title: 'Incident response', body: 'The on-call engineer acknowledges the page, opens an incident channel, and posts updates every thirty minutes until the service recovers. A postmortem follows within a week.' },
]

/** Held-out questions. */
export const RETRIEVAL_QUERIES: readonly FixtureQuery[] = [
  { query: 'how many times do failed requests retry', expected: ['concepts/retry-policy.md'] },
  { query: 'jitter wait between attempts', expected: ['concepts/backoff.md'] },
  { query: 'stop calling a dependency that keeps failing', expected: ['concepts/circuit-breaker.md'] },
  { query: 'what happens when a client sends too many requests per minute', expected: ['concepts/rate-limiting.md'] },
  { query: 'when does redis drop stale product data', expected: ['concepts/cache-invalidation.md'] },
  { query: 'refresh token lifetime', expected: ['concepts/auth-tokens.md'] },
  { query: 'where are browser sessions kept', expected: ['concepts/session-storage.md'] },
  { query: 'can I log secrets', expected: ['concepts/structured-logging.md'] },
  { query: 'error rate alert threshold', expected: ['concepts/metrics.md', 'procedures/incident-response.md'] },
  { query: 'roll out new behavior to a percentage of users', expected: ['concepts/feature-flags.md'] },
  { query: 'environment variables and config file order', expected: ['concepts/config-loading.md'] },
  { query: 'dead letter queue for failing jobs', expected: ['concepts/queue-workers.md'] },
  { query: 'resubscribe channels after the socket drops', expected: ['concepts/websocket-reconnect.md'] },
  { query: 'why not mongodb for orders', expected: ['decisions/postgres-over-mongo.md'] },
  { query: 'drop a column safely', expected: ['procedures/database-migrations.md'] },
  { query: 'canary rollout and rollback', expected: ['procedures/deployment.md'] },
  { query: 'how is the changelog produced for a release', expected: ['procedures/release.md'] },
  { query: 'checks that block merging a pull request', expected: ['procedures/ci-pipeline.md'] },
  { query: 'what to do when paged for an outage', expected: ['procedures/incident-response.md', 'concepts/metrics.md'] },
  { query: 'backoff for reconnecting clients', expected: ['concepts/websocket-reconnect.md', 'concepts/backoff.md'] },
]
