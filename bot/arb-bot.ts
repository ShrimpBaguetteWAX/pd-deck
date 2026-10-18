/*
 * Alcor loop bot. Runs on your own computer: `node bot/arb-bot.ts` (or double-click bot/start.cmd),
 * then open http://127.0.0.1:5199 to start and stop it and to see the wallet and every trade.
 *
 * Every interval (15 s by default) it reads every Alcor pool, screens every loop of two or three
 * pools that starts and ends in WAX or TLM, simulates the promising ones exactly, and dry-runs the
 * best of them from your account on a node (compute_transaction: the real contract, no signature,
 * no effect). When a confirmed loop earns at least the minimum (0.1 WAX by default), it signs one
 * swap through every pool with the key from bot/.env. The swap asks for at least the input plus
 * that minimum back, so on chain it either earns that much or fails and changes nothing. The input
 * is never more than the wallet holds.
 *
 * The private key is read from bot/.env and used for signing only; it is never logged, shown in the
 * page or sent anywhere but as a signature. Best practice: a permission of its own that may only
 * transfer WAX and TLM (see bot/README.md).
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PackedTransaction, PrivateKey, SignedTransaction } from '@wharfkit/antelope'

import {
  buildTransaction,
  chainError,
  loopAction,
  loopFlows,
  QUOTE_HOLDERS,
  verifyLoop,
  type Rpc
} from '../src/lib/alcorChain.ts'
import {
  bestSize,
  clmmFromRow,
  findLoops,
  liquidPools,
  TLM_TOKEN_ID,
  WAX_TOKEN_ID,
  waxPrices,
  type ClmmPool,
  type ClmmTick,
  type Loop,
  type PoolRow
} from '../src/lib/clmm.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = 5199
const SETTINGS_FILE = join(HERE, 'settings.json')
const TRADES_FILE = join(HERE, 'trades.jsonl')

// ---- Configuration -----------------------------------------------------------------------------

/** bot/.env: KEY=value lines. */
function readEnv(): Record<string, string> {
  const file = join(HERE, '.env')
  if (!existsSync(file)) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/)
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return out
}

const env = readEnv()
let ACCOUNT = env.ARB_ACCOUNT ?? ''
let PERMISSION = env.ARB_PERMISSION || 'active'
let signer: PrivateKey | null = null
let keyProblem = ''

function loadKey(key: string | undefined) {
  signer = null
  keyProblem = ''
  try {
    if (key) signer = PrivateKey.from(key)
    else keyProblem = 'No private key yet: enter the account and key above. Until then the bot can only watch.'
  } catch {
    keyProblem = 'The saved private key is not valid: enter it again. Until then the bot can only watch.'
  }
  if (!ACCOUNT) keyProblem = 'No account yet: enter the account, permission and key above.'
}
loadKey(env.ARB_PRIVATE_KEY)

const NAME = /^[a-z1-5.]{1,12}$/

/**
 * Account, permission and key from the page: checked against the account's permissions on chain,
 * then kept in bot/.env (on this computer only) and used from now on.
 */
async function setCredentials(input: { account?: unknown; permission?: unknown; key?: unknown }): Promise<string | null> {
  const account = String(input.account ?? '').trim()
  const permission = String(input.permission ?? '').trim() || 'active'
  const key = String(input.key ?? '').trim()
  if (!NAME.test(account)) return 'That is not a WAX account name.'
  if (!NAME.test(permission)) return 'That is not a permission name.'
  let parsed: PrivateKey
  try {
    parsed = PrivateKey.from(key)
  } catch {
    return 'That is not a valid private key.'
  }
  const pub = String(parsed.toPublic())
  const legacy = parsed.toPublic().toLegacyString()
  try {
    const acc = (await rpc('/v1/chain/get_account', { account_name: account })) as {
      permissions?: { perm_name: string; required_auth: { keys: { key: string }[] } }[]
    }
    const perm = acc.permissions?.find((p) => p.perm_name === permission)
    if (!perm) return `${account} has no permission called ${permission}.`
    if (!perm.required_auth.keys.some((k) => k.key === pub || k.key === legacy))
      return `This key is not one of the keys of ${account}@${permission}.`
  } catch (err) {
    return `Could not read ${account} from the chain: ${chainError(err)}`
  }
  ACCOUNT = account
  PERMISSION = permission
  const nodes = env.ARB_NODES ? `ARB_NODES=${env.ARB_NODES}\n` : ''
  writeFileSync(
    join(HERE, '.env'),
    `# Written by the bot's page. Stays on this computer (bot/.env is in .gitignore).\nARB_ACCOUNT=${account}\nARB_PERMISSION=${permission}\nARB_PRIVATE_KEY=${key}\n${nodes}`
  )
  loadKey(key)
  log(`Key saved for ${account}@${permission}`)
  return null
}

function clearCredentials() {
  if (state.running) stop()
  const nodes = env.ARB_NODES ? `ARB_NODES=${env.ARB_NODES}\n` : ''
  writeFileSync(join(HERE, '.env'), `ARB_ACCOUNT=${ACCOUNT}\nARB_PERMISSION=${PERMISSION}\n${nodes}`)
  loadKey(undefined)
  log('Key removed')
}

const NODES = (
  env.ARB_NODES || 'https://wax.greymass.com,https://wax.eosusa.io,https://api.wax.alohaeos.com,https://wax.eosphere.io'
)
  .split(',')
  .map((s) => s.trim().replace(/\/$/, ''))
  .filter(Boolean)

interface Settings {
  /** Smallest profit worth signing, in WAX (TLM loops are converted at the pool price). */
  minProfitWax: number
  intervalSec: number
  /** Largest input, in WAX worth, on top of the wallet limit. */
  maxTradeWax: number
  starts: ('WAX' | 'TLM')[]
  /** Scan and confirm, but never sign. */
  watchOnly: boolean
  /** At most one trade per this many seconds; scans go on in between. */
  tradeGapSec: number
}

const DEFAULTS: Settings = {
  minProfitWax: 0.1,
  intervalSec: 15,
  maxTradeWax: 500,
  starts: ['WAX', 'TLM'],
  watchOnly: false,
  tradeGapSec: 60
}

function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) }
  } catch {
    return { ...DEFAULTS }
  }
}

let settings = loadSettings()

/** Pools count when both sides hold at least this, in WAX. */
const MIN_POOL_WAX = 20
const MIN_MARGINAL = 1.001
const MAX_EXACT = 60
/** Loops the simulation rates above this share of the minimum get dry-run. */
const SCREEN_SHARE = 0.5
const MAX_DRY_RUN_LOOPS = 5
const TICK_CACHE_MS = 60_000

// ---- Chain access --------------------------------------------------------------------------------

let nodeIndex = 0

/** A node call with failover; a contract error (HTTP 500 with an error body) is returned to the caller. */
const rpc: Rpc = async (path, body) => {
  let last: unknown
  for (let i = 0; i < NODES.length; i++) {
    const url = NODES[(nodeIndex + i) % NODES.length]
    try {
      const res = await fetch(url + path, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) })
      const json = (await res.json().catch(() => null)) as { error?: { what?: string; details?: { message?: string }[] } } | null
      if (res.ok) {
        nodeIndex = (nodeIndex + i) % NODES.length
        return json
      }
      const err = Object.assign(new Error(json?.error?.details?.[0]?.message ?? json?.error?.what ?? `HTTP ${res.status}`), {
        json
      })
      // The contract refused: every node would say the same.
      if (json?.error) throw Object.assign(err, { contract: true })
      last = err
    } catch (err) {
      if ((err as { contract?: boolean }).contract) throw err
      last = err
    }
  }
  nodeIndex = (nodeIndex + 1) % NODES.length
  throw last instanceof Error ? last : new Error('No node answered')
}

async function tableRows<T>(body: Record<string, unknown>): Promise<T[]> {
  const out: T[] = []
  let lower = ''
  for (let page = 0; page < 40; page++) {
    const res = (await rpc('/v1/chain/get_table_rows', {
      json: true,
      limit: 1000,
      ...body,
      ...(lower ? { lower_bound: lower } : {})
    })) as {
      rows: T[]
      more: boolean
      next_key?: string
    }
    out.push(...res.rows)
    if (!res.more || !res.next_key) break
    lower = res.next_key
  }
  return out
}

/** Highest pool id seen, so the next read can fetch every page at once. */
let maxPoolId = 0

/** Every Alcor pool: page by page the first time, then all pages in parallel by id range. */
async function readPools(): Promise<PoolRow[]> {
  if (!maxPoolId) {
    const rows = await tableRows<PoolRow>({ code: 'swap.alcor', scope: 'swap.alcor', table: 'pools' })
    maxPoolId = Math.max(0, ...rows.map((r) => Number(r.id)))
    return rows
  }
  const pages = Math.ceil((maxPoolId + 1) / 1000)
  const parts = await Promise.all(
    Array.from({ length: pages + 1 }, (_, k) =>
      tableRows<PoolRow>({
        code: 'swap.alcor',
        scope: 'swap.alcor',
        table: 'pools',
        lower_bound: String(k * 1000),
        // The last range is open, for pools created since.
        ...(k < pages ? { upper_bound: String(k * 1000 + 999) } : {})
      })
    )
  )
  const rows = parts.flat()
  maxPoolId = Math.max(maxPoolId, ...rows.map((r) => Number(r.id)))
  return rows
}

const tickCache = new Map<number, { at: number; ticks: ClmmTick[] }>()

async function ticksOf(poolId: number): Promise<ClmmTick[]> {
  const hit = tickCache.get(poolId)
  if (hit && Date.now() - hit.at < TICK_CACHE_MS) return hit.ticks
  const rows = await tableRows<{ id: number | string; liquidityNet: string }>({
    code: 'swap.alcor',
    scope: String(poolId),
    table: 'ticks'
  })
  const ticks = rows.map((t) => ({ tick: Number(t.id), net: Number(t.liquidityNet) })).sort((a, b) => a.tick - b.tick)
  tickCache.set(poolId, { at: Date.now(), ticks })
  return ticks
}

async function balance(contract: string, symbol: string): Promise<number> {
  if (!ACCOUNT) return 0
  const res = (await rpc('/v1/chain/get_currency_balance', { code: contract, account: ACCOUNT, symbol })) as string[]
  return res.length ? Number(res[0].split(' ')[0]) : 0
}

// ---- State shown in the page ----------------------------------------------------------------------

interface Trade {
  at: number
  route: string[]
  pools: number[]
  symbol: string
  input: number
  expected: number
  minOut: number
  output: number | null
  profit: number | null
  profitWax: number | null
  status: 'done' | 'failed'
  trxId?: string
  error?: string
}

interface Candidate {
  route: string[]
  pools: number[]
  symbol: string
  input: number
  received: number
  profit: number
  profitWax: number
}

const state = {
  running: false,
  busy: false,
  balances: { wax: 0, tlm: 0, at: 0 },
  scan: null as null | {
    at: number
    ms: number
    pools: number
    liquid: number
    loops: number
    simulated: number
    dryRun: number
    confirmed: Candidate[]
  },
  lastError: '',
  log: [] as string[]
}

function log(line: string) {
  const stamp = new Date().toLocaleTimeString()
  state.log.unshift(`${stamp}  ${line}`)
  state.log.length = Math.min(state.log.length, 80)
  console.log(`${stamp}  ${line}`)
}

function readTrades(): Trade[] {
  if (!existsSync(TRADES_FILE)) return []
  return readFileSync(TRADES_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as Trade
      } catch {
        return null
      }
    })
    .filter((t): t is Trade => t !== null)
}

let lastTrade = 0
/** When the last trade was sent, failed ones included (from the log the first time). */
function lastTradeAt(): number {
  if (!lastTrade) lastTrade = readTrades().reduce((m, t) => Math.max(m, t.at), 0)
  return lastTrade
}

function saveTrade(t: Trade) {
  lastTrade = t.at
  appendFileSync(TRADES_FILE, JSON.stringify(t) + '\n')
}

// ---- One scan ------------------------------------------------------------------------------------

const routeOf = (loop: Loop) => loop.path.map((t) => t.symbol)

async function refreshBalances() {
  const [wax, tlm] = await Promise.all([balance('eosio.token', 'WAX'), balance('alien.worlds', 'TLM')])
  state.balances = { wax, tlm, at: Date.now() }
}

async function scanOnce() {
  const started = Date.now()
  await refreshBalances()

  const rows = await readPools()
  const pools = rows.filter((r) => Number(r.active) && Number(r.liquidity) > 0).map(clmmFromRow)
  const price = waxPrices(pools)
  const liquid = liquidPools(pools, price, MIN_POOL_WAX)
  const starts = settings.starts.map((s) => (s === 'WAX' ? WAX_TOKEN_ID : TLM_TOKEN_ID))
  const loops = findLoops(liquid, starts)
  const promising = loops
    .filter((l) => l.marginal > MIN_MARGINAL)
    .sort((a, b) => b.marginal - a.marginal)
    .slice(0, MAX_EXACT)

  const needTicks = [...new Set(promising.flatMap((l) => l.pools))]
  await Promise.all(needTicks.map(async (p: ClmmPool) => (p.ticks = await ticksOf(p.id))))

  // Size each loop to what the wallet holds (never more) and the trade limit.
  const capOf = (loop: Loop) => {
    const startWax = price.get(loop.start.id) ?? 0
    // Without an account (watching only) there is no wallet to limit the size.
    const held = !ACCOUNT ? Infinity : loop.start.id === WAX_TOKEN_ID ? state.balances.wax : state.balances.tlm
    return { startWax, cap: Math.min(held, startWax > 0 ? settings.maxTradeWax / startWax : 0) }
  }
  const screened = promising
    .map((loop) => {
      const { startWax, cap } = capOf(loop)
      return { loop, startWax, cap, sim: cap > 0 ? bestSize(loop, cap) : null }
    })
    .filter((c) => c.sim && c.sim.profit * c.startWax >= settings.minProfitWax * SCREEN_SHARE)
    .sort((a, b) => b.sim!.profit * b.startWax - a.sim!.profit * a.startWax)
    .slice(0, MAX_DRY_RUN_LOOPS)

  // The contract decides: dry runs from this very account, at sizes around the simulated best.
  const confirmed: (Candidate & { loop: Loop; startWax: number })[] = []
  for (const c of screened) {
    // From this very account when there is one; otherwise from an account that holds plenty.
    const holder = ACCOUNT || QUOTE_HOLDERS[c.loop.start.id]
    if (!holder) continue
    const { best } = await verifyLoop(rpc, holder, c.loop, c.sim!.amount, c.cap)
    if (!best) continue
    confirmed.push({
      loop: c.loop,
      startWax: c.startWax,
      route: routeOf(c.loop),
      pools: c.loop.pools.map((p) => p.id),
      symbol: c.loop.start.symbol,
      input: best.amount,
      received: best.received,
      profit: best.profit,
      profitWax: best.profit * c.startWax
    })
  }
  confirmed.sort((a, b) => b.profitWax - a.profitWax)

  state.scan = {
    at: Date.now(),
    ms: Date.now() - started,
    pools: rows.length,
    liquid: liquid.length,
    loops: loops.length,
    simulated: promising.length,
    dryRun: screened.length,
    confirmed: confirmed.map(({ loop: _loop, startWax: _w, ...rest }) => rest)
  }

  const best = confirmed[0]
  if (!best || best.profitWax < settings.minProfitWax) return
  if (settings.watchOnly || !signer) {
    log(`Would run ${best.route.join(' > ')}: ${best.input} ${best.symbol} for +${best.profit.toFixed(6)} (watch only)`)
    return
  }
  const since = (Date.now() - lastTradeAt()) / 1000
  if (since < settings.tradeGapSec) {
    log(
      `Found ${best.route.join(' > ')} (+${best.profit.toFixed(6)} ${best.symbol}), waiting: last trade ${Math.round(since)} s ago`
    )
    return
  }
  // Right before signing: read this route's pools and ticks again, size it again to the wallet, and
  // let the contract confirm it once more. Only a route that still clears the minimum is signed.
  const fresh = await refreshRoute(best.loop)
  await refreshBalances()
  const held = fresh.start.id === WAX_TOKEN_ID ? state.balances.wax : state.balances.tlm
  const cap = Math.min(held, best.startWax > 0 ? settings.maxTradeWax / best.startWax : 0)
  if (!(cap > 0)) return
  const guess = Math.min(cap, Math.max(bestSize(fresh, cap).amount, best.input))
  const { best: now, error } = await verifyLoop(rpc, ACCOUNT, fresh, guess, cap)
  if (!now || now.profit * best.startWax < settings.minProfitWax) {
    log(`Skipped ${best.route.join(' > ')}: gone on the final check${error ? ` (${error})` : ''}`)
    return
  }
  await execute(fresh, now.amount, now.received, best.startWax)
}

/** The loop with its pools and ticks read straight from the chain, bypassing every cache. */
async function refreshRoute(loop: Loop): Promise<Loop> {
  const pools = await Promise.all(
    loop.pools.map(async (p) => {
      const [row] = await tableRows<PoolRow>({
        code: 'swap.alcor',
        scope: 'swap.alcor',
        table: 'pools',
        lower_bound: String(p.id),
        upper_bound: String(p.id)
      })
      if (!row) throw new Error(`Pool ${p.id} could not be read`)
      const fresh = clmmFromRow(row)
      tickCache.delete(p.id)
      fresh.ticks = await ticksOf(p.id)
      return fresh
    })
  )
  return { ...loop, pools }
}

// ---- Signing ---------------------------------------------------------------------------------------

async function execute(loop: Loop, input: number, expectedOut: number, startWax: number) {
  const t = loop.start
  const unit = 10 ** -t.decimals
  // At least the minimum profit back, or the transaction fails as a whole.
  const minProfit = Math.max(unit, startWax > 0 ? settings.minProfitWax / startWax : expectedOut - input)
  const minOut = input + minProfit
  const trade: Trade = {
    at: Date.now(),
    route: routeOf(loop),
    pools: loop.pools.map((p) => p.id),
    symbol: t.symbol,
    input,
    expected: expectedOut - input,
    minOut,
    output: null,
    profit: null,
    profitWax: null,
    status: 'failed'
  }
  try {
    const { tx, chainId } = await buildTransaction(rpc, [loopAction(ACCOUNT, PERMISSION, loop, input, minOut)])
    const signature = signer!.signDigest(tx.signingDigest(chainId))
    const packed = PackedTransaction.fromSigned(SignedTransaction.from({ ...tx, signatures: [signature] }))
    const res = (await rpc('/v1/chain/push_transaction', packed)) as { transaction_id: string; processed: unknown }
    const flows = loopFlows(res.processed, ACCOUNT, t)
    trade.trxId = res.transaction_id
    trade.output = flows.received
    trade.profit = flows.received - flows.paid
    trade.profitWax = trade.profit * startWax
    trade.input = flows.paid || input
    trade.status = 'done'
    log(
      `Ran ${trade.route.join(' > ')}: ${trade.input} ${t.symbol} in, ${trade.output} back, ${trade.profit >= 0 ? '+' : ''}${trade.profit.toFixed(t.decimals)} ${t.symbol}`
    )
  } catch (err) {
    trade.error = chainError(err)
    log(`Failed ${trade.route.join(' > ')}: ${trade.error}`)
  }
  saveTrade(trade)
  await refreshBalances().catch(() => undefined)
}

// ---- The loop ----------------------------------------------------------------------------------------

let timer: NodeJS.Timeout | null = null

async function tick() {
  if (!state.running || state.busy) return
  state.busy = true
  const startedAt = Date.now()
  try {
    await scanOnce()
    state.lastError = ''
  } catch (err) {
    state.lastError = chainError(err)
    log(`Scan failed: ${state.lastError}`)
  } finally {
    state.busy = false
    // Start to start: the next scan begins one interval after this one began (at once if it overran).
    const wait = Math.max(0, settings.intervalSec * 1000 - (Date.now() - startedAt))
    if (state.running) timer = setTimeout(() => void tick(), wait)
  }
}

function start() {
  if (state.running) return
  state.running = true
  log(signer && !settings.watchOnly ? `Started: trading for ${ACCOUNT}@${PERMISSION}` : 'Started in watch-only mode')
  void tick()
}

function stop() {
  state.running = false
  if (timer) clearTimeout(timer)
  timer = null
  log('Stopped')
}

// ---- The control page ----------------------------------------------------------------------------------

function snapshot() {
  const trades = readTrades().reverse().slice(0, 200)
  const total = trades.filter((t) => t.status === 'done').reduce((n, t) => n + (t.profitWax ?? 0), 0)
  return {
    running: state.running,
    busy: state.busy,
    account: ACCOUNT,
    permission: PERMISSION,
    canTrade: !!signer && !!ACCOUNT,
    /** Only the public half: the private key never leaves the bot. */
    publicKey: signer ? String(signer.toPublic()) : null,
    keyProblem,
    settings,
    balances: state.balances,
    scan: state.scan,
    lastError: state.lastError,
    log: state.log,
    trades,
    totalProfitWax: total
  }
}

function readBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        resolve({})
      }
    })
  })
}

function applySettings(input: Partial<Settings>) {
  const num = (v: unknown, lo: number, hi: number, fallback: number) => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback
  }
  settings = {
    minProfitWax: num(input.minProfitWax, 0.001, 1e6, settings.minProfitWax),
    intervalSec: num(input.intervalSec, 5, 3600, settings.intervalSec),
    maxTradeWax: num(input.maxTradeWax, 1, 1e7, settings.maxTradeWax),
    starts: Array.isArray(input.starts)
      ? (input.starts.filter((s) => s === 'WAX' || s === 'TLM') as Settings['starts'])
      : settings.starts,
    watchOnly: typeof input.watchOnly === 'boolean' ? input.watchOnly : settings.watchOnly,
    tradeGapSec: num(input.tradeGapSec, 0, 86400, settings.tradeGapSec)
  }
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2))
  log('Settings saved')
}

const server = createServer(async (req, res) => {
  const send = (code: number, body: unknown, type = 'application/json') => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' })
    res.end(type === 'application/json' ? JSON.stringify(body) : String(body))
  }
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  if (req.method === 'GET' && url.pathname === '/')
    return send(200, readFileSync(join(HERE, 'ui.html'), 'utf8'), 'text/html; charset=utf-8')
  if (req.method === 'GET' && url.pathname === '/api/state') return send(200, snapshot())
  // Changes need a custom header, so another website cannot drive the bot from your browser.
  if (req.method === 'POST' && req.headers['x-arb-bot'] === '1') {
    if (url.pathname === '/api/start') {
      start()
      return send(200, snapshot())
    }
    if (url.pathname === '/api/stop') {
      stop()
      return send(200, snapshot())
    }
    if (url.pathname === '/api/credentials') {
      const problem = await setCredentials((await readBody(req)) as Record<string, unknown>)
      if (!problem) await refreshBalances().catch(() => undefined)
      return send(problem ? 400 : 200, { ...snapshot(), problem })
    }
    if (url.pathname === '/api/credentials/clear') {
      clearCredentials()
      return send(200, snapshot())
    }
    if (url.pathname === '/api/settings') {
      applySettings((await readBody(req)) as Partial<Settings>)
      return send(200, snapshot())
    }
  }
  send(404, { error: 'not found' })
})

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`The bot is already running (port ${PORT} is taken). Open http://127.0.0.1:${PORT} to control it.`)
    process.exit(0)
  }
  throw err
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Alcor loop bot: open http://127.0.0.1:${PORT}`)
  if (keyProblem) console.log(keyProblem)
  else console.log(`Account ${ACCOUNT}@${PERMISSION}, key loaded.`)
  refreshBalances().catch((err) => log(`Could not read balances: ${chainError(err)}`))
})
