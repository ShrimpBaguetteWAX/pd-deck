/*
 * WAX endpoints for the bot: many nodes, probed at start and every ten minutes, used in turn so no
 * single one carries every request. A node that fails or rate-limits sits out for a while; a node
 * without dry runs (compute_transaction) or without the history API is only used for what it has.
 */

export type Capability = 'chain' | 'compute' | 'history'

/** Public WAX nodes; the list the web app uses, plus history nodes. */
const DEFAULT_NODES = [
  'https://wax.greymass.com',
  'https://wax.eosusa.io',
  'https://wax.blacklusion.io',
  'https://wax-api.alcor.exchange',
  'https://wax.a-dex.xyz',
  'https://api.waxsweden.org',
  'https://api.wax.bountyblok.io',
  'https://waxapi.blocksindia.com',
  'https://wax.eosphere.io',
  'https://api.wax.detroitledger.tech',
  'https://wax.api.eosnation.io',
  'https://wax.cryptolions.io',
  'https://api.hivebp.io',
  'https://hyperion7.sentnl.io',
  'https://wax.eosdac.io',
  'https://wax-history.eosdac.io',
  'https://api.wax.alohaeos.com',
  'https://wax.eosrio.io'
]

export interface Endpoint {
  url: string
  chain: boolean
  history: boolean
  /** False once the node refused a dry run as unsupported. */
  compute: boolean
  /** Round trip of the last probe, in ms. */
  latency: number
  /** How far the node's head block lagged real time on the probe, in s. */
  lag: number
  benchedUntil: number
  /** Request times over the last minute. */
  recent: number[]
  failures: number
  lastError: string
}

const PROBE_TIMEOUT_MS = 3500
const REPROBE_MS = 10 * 60_000
const BENCH_MS = 60_000
const BENCH_RATE_LIMIT_MS = 120_000
const MAX_HEAD_LAG_S = 60

export class EndpointPool {
  endpoints: Endpoint[]
  probedAt = 0
  private turn: Record<Capability, number> = { chain: 0, compute: 0, history: 0 }

  constructor(extra: string[] = []) {
    const urls = [...new Set([...extra, ...DEFAULT_NODES].map((u) => u.trim().replace(/\/$/, '')).filter(Boolean))]
    this.endpoints = urls.map((url) => ({
      url,
      chain: false,
      history: false,
      compute: true,
      latency: 0,
      lag: 0,
      benchedUntil: 0,
      recent: [],
      failures: 0,
      lastError: ''
    }))
  }

  /** Tests every node for chain reads (fresh head block) and the history API. */
  async probe(): Promise<void> {
    await Promise.all(
      this.endpoints.map(async (e) => {
        const started = Date.now()
        try {
          const res = await fetch(`${e.url}/v1/chain/get_info`, {
            method: 'POST',
            body: '{}',
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
          })
          const info = (await res.json()) as { head_block_time?: string; chain_id?: string }
          e.latency = Date.now() - started
          e.lag = info.head_block_time ? (Date.now() - Date.parse(info.head_block_time + 'Z')) / 1000 : Infinity
          e.chain = res.ok && !!info.chain_id && e.lag < MAX_HEAD_LAG_S
          if (!e.chain) e.lastError = res.ok ? `head block ${Math.round(e.lag)} s behind` : `HTTP ${res.status}`
        } catch (err) {
          e.chain = false
          e.lastError = err instanceof Error ? err.message : String(err)
        }
        try {
          const res = await fetch(`${e.url}/v2/history/get_actions?account=swap.alcor&limit=1`, {
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
          })
          const json = (await res.json()) as { actions?: { '@timestamp': string }[] }
          const newest = json.actions?.[0]?.['@timestamp']
          e.history = res.ok && !!newest && Date.now() - Date.parse(newest + 'Z') < 10 * 60_000
        } catch {
          e.history = false
        }
      })
    )
    this.probedAt = Date.now()
  }

  async ensureProbed() {
    if (Date.now() - this.probedAt > REPROBE_MS) await this.probe()
  }

  private usable(e: Endpoint, cap: Capability, now: number) {
    if (e.benchedUntil > now) return false
    if (cap === 'history') return e.history
    if (cap === 'compute') return e.chain && e.compute
    return e.chain
  }

  /** The next node in turn that can do `cap`, fastest ones first in the rotation. */
  pick(cap: Capability, exclude: Set<string> = new Set()): Endpoint | null {
    const now = Date.now()
    const list = this.endpoints
      .filter((e) => this.usable(e, cap, now) && !exclude.has(e.url))
      .sort((a, b) => a.latency - b.latency)
    if (!list.length) return null
    const e = list[this.turn[cap]++ % list.length]
    e.recent.push(now)
    while (e.recent.length && now - e.recent[0] > 60_000) e.recent.shift()
    return e
  }

  /** The node failed: it sits out for a while (longer when it rate-limited). */
  fail(e: Endpoint, error: string, rateLimited = false) {
    e.failures++
    e.lastError = error
    e.benchedUntil = Date.now() + (rateLimited ? BENCH_RATE_LIMIT_MS : BENCH_MS)
  }

  /** For the page. */
  report() {
    const now = Date.now()
    return {
      probedAt: this.probedAt,
      endpoints: this.endpoints
        .map((e) => ({
          url: e.url.replace(/^https:\/\//, ''),
          chain: e.chain,
          history: e.history,
          compute: e.compute,
          latency: e.latency,
          benched: e.benchedUntil > now,
          perMinute: e.recent.filter((t) => now - t <= 60_000).length,
          failures: e.failures,
          lastError: e.lastError
        }))
        .sort((a, b) => Number(b.chain || b.history) - Number(a.chain || a.history) || a.latency - b.latency)
    }
  }
}

/** Errors that are about the transaction itself: every node would give the same answer. */
const TX_ERROR =
  /assert|overdrawn|tx_cpu|tx_net|deadline_exception|expired_tx|duplicate|unsatisfied_authorization|missing_auth|invalid_signature|ram_usage|balance/i
/** Errors meaning the node does not offer the call. */
const UNSUPPORTED = /unknown endpoint|not found|not supported|disabled|unknown key|404/i

/**
 * A chain call through the pool: tries nodes in turn until one answers. A transaction error goes
 * straight back to the caller; node trouble benches the node and the next one is tried.
 */
export async function poolCall(pool: EndpointPool, path: string, body: unknown, attempts = 4): Promise<unknown> {
  await pool.ensureProbed()
  const cap: Capability = path.includes('compute_transaction') ? 'compute' : 'chain'
  const tried = new Set<string>()
  let last: unknown = new Error('No WAX node is available right now')
  for (let i = 0; i < attempts; i++) {
    const e = pool.pick(cap, tried)
    if (!e) break
    tried.add(e.url)
    try {
      const res = await fetch(e.url + path, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) })
      const json = (await res.json().catch(() => null)) as {
        error?: { name?: string; what?: string; details?: { message?: string }[] }
      } | null
      if (res.ok) return json
      const message = json?.error?.details?.[0]?.message ?? json?.error?.what ?? `HTTP ${res.status}`
      const name = json?.error?.name ?? ''
      const err = Object.assign(new Error(message), { json })
      if (TX_ERROR.test(name) || TX_ERROR.test(message)) throw Object.assign(err, { final: true })
      if (cap === 'compute' && (res.status === 404 || UNSUPPORTED.test(message))) e.compute = false
      else pool.fail(e, message, res.status === 429)
      last = err
    } catch (err) {
      if ((err as { final?: boolean }).final) throw err
      pool.fail(e, err instanceof Error ? err.message : String(err))
      last = err
    }
  }
  throw last instanceof Error ? last : new Error(String(last))
}

/** A history request through the pool, trying nodes in turn. */
export async function poolHistory<T>(pool: EndpointPool, query: string, attempts = 3): Promise<T> {
  await pool.ensureProbed()
  const tried = new Set<string>()
  let last: unknown = new Error('No history node is available right now')
  for (let i = 0; i < attempts; i++) {
    const e = pool.pick('history', tried)
    if (!e) break
    tried.add(e.url)
    try {
      const res = await fetch(`${e.url}/v2/history/get_actions?${query}`, { signal: AbortSignal.timeout(8000) })
      if (!res.ok) {
        pool.fail(e, `HTTP ${res.status}`, res.status === 429)
        last = new Error(`HTTP ${res.status}`)
        continue
      }
      return (await res.json()) as T
    } catch (err) {
      pool.fail(e, err instanceof Error ? err.message : String(err))
      last = err
    }
  }
  throw last instanceof Error ? last : new Error(String(last))
}
