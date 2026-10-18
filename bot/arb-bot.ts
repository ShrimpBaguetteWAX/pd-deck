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

import { BlockFollower } from './blocks.ts'
import { EndpointPool, poolCall, poolHistory, poolPushFastest } from './endpoints.ts'

import {
  buildTransaction,
  chainError,
  dryRunLoop,
  loopActions,
  loopFlows,
  QUOTE_HOLDERS,
  verifyLoop,
  type Rpc
} from '../src/lib/alcorChain.ts'
import {
  bestSize,
  clmmFromRow,
  tacoFromRow,
  findLoops,
  liquidPools,
  otherToken,
  spotRate,
  TLM_TOKEN_ID,
  DEF_TOKEN_ID,
  WAX_TOKEN_ID,
  waxPrices,
  type ClmmPool,
  type ClmmTick,
  type Loop,
  type PoolRow,
  type TacoRow
} from '../src/lib/clmm.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = 5199
const SETTINGS_FILE = join(HERE, 'settings.json')
const TRADES_FILE = join(HERE, 'trades.jsonl')
/** Whether the bot was running, so a restart picks up where it was (only Stop keeps it stopped). */
const RUN_FILE = join(HERE, 'run-state.json')
const rememberRunning = (running: boolean) => writeFileSync(RUN_FILE, JSON.stringify({ running }))
const wasRunning = () => {
  try {
    return JSON.parse(readFileSync(RUN_FILE, 'utf8')).running === true
  } catch {
    return false
  }
}

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

/** Many WAX nodes, probed and used in turn (extra ones can be added in bot/.env as ARB_NODES). */
const endpointPool = new EndpointPool(
  [...(env.ARB_NODES ?? '').split(','), ...(env.ARB_HISTORY ?? '').split(',')].filter(Boolean)
)

/** The tokens a loop may start and end in. */
type StartSymbol = 'WAX' | 'TLM' | 'DEF'
const START_IDS: Record<StartSymbol, string> = { WAX: WAX_TOKEN_ID, TLM: TLM_TOKEN_ID, DEF: DEF_TOKEN_ID }

/** What the wallet holds of a start token. */
function heldOf(tokenId: string): number {
  if (tokenId === WAX_TOKEN_ID) return state.balances.wax
  if (tokenId === TLM_TOKEN_ID) return state.balances.tlm
  if (tokenId === DEF_TOKEN_ID) return state.balances.def
  return 0
}

interface Settings {
  /** How often the swap logs are polled. */
  pollSec: number
  /** How often every pool is read in full. */
  fullRefreshMin: number
  /** Largest input, in WAX worth, on top of the wallet limit. */
  maxTradeWax: number
  starts: StartSymbol[]
  /** Scan and confirm, but never sign. */
  watchOnly: boolean
  /** At most one trade per this many seconds; scans go on in between. */
  tradeGapSec: number
  /** 2 once DEF is among the possible start tokens (settings saved before that get it added once). */
  startsVersion: number
}

const DEFAULTS: Settings = {
  pollSec: 5,
  fullRefreshMin: 5,
  maxTradeWax: 500,
  starts: ['WAX', 'TLM', 'DEF'],
  watchOnly: false,
  tradeGapSec: 60,
  startsVersion: 2
}

function loadSettings(): Settings {
  try {
    const saved = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as Partial<Settings> & {
      intervalSec?: number
      minProfitWax?: number
    }
    // There is no minimum profit any more: any profit counts.
    delete saved.minProfitWax
    // DEF became a start token later: settings saved before then get it once; unticking it later sticks.
    if ((saved.startsVersion ?? 1) < 2 && Array.isArray(saved.starts) && !saved.starts.includes('DEF'))
      saved.starts = [...saved.starts, 'DEF']
    saved.startsVersion = 2
    // Older settings had one scan interval; the log polling replaces it.
    delete saved.intervalSec
    return { ...DEFAULTS, ...saved }
  } catch {
    return { ...DEFAULTS }
  }
}

let settings = loadSettings()

/** Pools count when both sides hold at least this, in WAX. */
const MIN_POOL_WAX = 20
const MIN_MARGINAL = 1.001
const MAX_EXACT = 60
const MAX_DRY_RUN_LOOPS = 5
/** Price ranges only change when liquidity moves, which the logs report; so they are kept longer. */
const TICK_CACHE_MS = 10 * 60_000

// ---- Chain access --------------------------------------------------------------------------------

/** A node call with failover; a contract error (HTTP 500 with an error body) is returned to the caller. */
/** Every chain request the bot makes, by kind, for the page's request counter. */
const requestLog: { at: number; kind: string }[] = []
function countRequest(path: string) {
  const kind = path.includes('compute_transaction')
    ? 'dry runs'
    : path.includes('trace_api')
      ? 'blocks'
      : path.includes('push_transaction')
        ? 'transactions'
        : path.includes('get_table_rows')
          ? 'table reads'
          : path.includes('history')
            ? 'swap logs'
            : 'other'
  const now = Date.now()
  requestLog.push({ at: now, kind })
  while (requestLog.length && now - requestLog[0].at > 60_000) requestLog.shift()
}

/** The chain head, reused for a few seconds: every dry run needs one, none needs it fresher. */
let infoCache: { at: number; value: unknown } | null = null
const INFO_CACHE_MS = 5000

const rpc: Rpc = async (path, body) => {
  if (path === '/v1/chain/get_info' && infoCache && Date.now() - infoCache.at < INFO_CACHE_MS) return infoCache.value
  const value = await rpcUncached(path, body)
  if (path === '/v1/chain/get_info') infoCache = { at: Date.now(), value }
  return value
}

const rpcUncached: Rpc = async (path, body) => {
  countRequest(path)
  return poolCall(endpointPool, path, body)
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

/** Every Taco pair. */
async function readTaco(): Promise<TacoRow[]> {
  return tableRows<TacoRow>({ code: 'swap.taco', scope: 'swap.taco', table: 'pairs' })
}

/** Taco pairs as pools, with internal ids that stay the same as long as the pair exists. */
const tacoIds = new Map<string, number>()
function tacoPools(rows: TacoRow[]): ClmmPool[] {
  return rows.map((row) => {
    if (!tacoIds.has(row.id)) tacoIds.set(row.id, tacoIds.size)
    return tacoFromRow(row, tacoIds.get(row.id)!)
  })
}

const poolName = (p: ClmmPool) => (p.venue === 'taco' ? `Taco ${p.name}` : `Alcor ${p.id}`)

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
  /** Pool names: Alcor "#10447", Taco pair ids. */
  pools: string[]
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
  /** From the block that opened the gap being made to this transaction being accepted, in ms. */
  reactionMs?: number
}

interface Candidate {
  route: string[]
  pools: string[]
  symbol: string
  input: number
  received: number
  profit: number
  profitWax: number
}

const state = {
  running: false,
  busy: false,
  balances: { wax: 0, tlm: 0, def: 0, at: 0 },
  /** The account's CPU over the chain's 24-hour window: used and available, in microseconds. */
  cpu: { used: 0, max: 0, pct: 0, at: 0 },
  /** What the bot did since it started: from loops looked at to trades sent. */
  stats: { since: Date.now(), passes: 0, loopsChecked: 0, dryRunLoops: 0, confirmed: 0, finalFails: 0, sent: 0, failedTx: 0 },
  scan: null as null | {
    at: number
    ms: number
    mode: 'full' | 'logs'
    pools: number
    liquid: number
    loops: number
    /** Loops checked this pass: all on a full read, those through changed pools otherwise. */
    checked: number
    swaps: number
    changedPools: number
    fullAt: number
    feed: 'blocks' | 'logs'
    block: number
    lagSec: number
    swapsSeen: number
    simulated: number
    dryRun: number
    /** Loops and pools set aside after the chain turned them down. */
    setAside: number
    blockedPools: number
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

// ---- Loops the chain turned down, and the pools being scanned ---------------------------------------

/**
 * Some pools look mispriced only because they cannot really be traded (a token whose transfers the
 * exchange never sees, for one). A loop the dry runs turn down is set aside for a while, and a pool
 * in several turned-down loops for longer, so the dry runs move on to other candidates.
 */
const LOOP_SET_ASIDE_MS = 30 * 60_000
const POOL_BLOCK_MS = 6 * 3600_000
const POOL_STRIKES = 3
const rejectedLoops = new Map<string, number>()
const blockedPools = new Map<string, { strikes: number; until: number }>()

const loopKey = (l: Loop) => `${l.start.id}|${l.pools.map(poolName).join(',')}`

function rejectLoop(l: Loop) {
  const now = Date.now()
  rejectedLoops.set(loopKey(l), now + LOOP_SET_ASIDE_MS)
  for (const p of l.pools) {
    const b = blockedPools.get(poolName(p)) ?? { strikes: 0, until: 0 }
    b.strikes++
    if (b.strikes >= POOL_STRIKES) {
      b.until = now + POOL_BLOCK_MS
      b.strikes = 0
    }
    blockedPools.set(poolName(p), b)
  }
}

interface PoolEntry {
  name: string
  venue: 'alcor' | 'taco'
  pair: string
  /** Value of the thinner side, in WAX. */
  depthWax: number
  feePct: number
  /** When the pool's row was last read (every scan reads every pool). */
  readAt: number
  /** Alcor: when its price ranges were last read. */
  ticksAt?: number
  /** When a loop through it was last dry-run. */
  checkedAt?: number
  /** The pool's state as of the last scan; a different one means someone traded or moved liquidity. */
  sig: string
  /** When a scan last saw the pool change. */
  movedAt?: number
  /** Swaps seen in the logs over the last hour. */
  moves: number[]
}

const ACTIVITY_WINDOW_MS = 3600_000
/** When the bot started watching, so the page can say how much of the hour it has seen. */
const watchingSince = Date.now()

/** What changes when the pool trades: Alcor's price and active liquidity, Taco's reserves. */
const stateOf = (p: ClmmPool) => (p.venue === 'taco' ? `${p.reserveA}|${p.reserveB}` : `${p.sqrt}|${p.liquidity}|${p.tick}`)

const poolIndex = new Map<string, PoolEntry>()

/** The pools of this scan (those with enough on both sides), keeping what earlier scans noted. */
function indexPools(pools: ClmmPool[], price: Map<string, number>, at: number) {
  const seen = new Set<string>()
  for (const p of pools) {
    const name = poolName(p)
    seen.add(name)
    const pa = price.get(p.a.id) ?? 0
    const pb = price.get(p.b.id) ?? 0
    const prev = poolIndex.get(name)
    const sig = stateOf(p)
    const moves = (prev?.moves ?? []).filter((t) => at - t < ACTIVITY_WINDOW_MS)
    poolIndex.set(name, {
      name,
      venue: p.venue,
      pair: `${p.a.symbol}/${p.b.symbol}`,
      depthWax: Math.min(p.reserveA * pa, p.reserveB * pb),
      feePct: p.fee * 100,
      readAt: at,
      ticksAt: prev?.ticksAt,
      checkedAt: prev?.checkedAt,
      sig,
      movedAt: prev?.movedAt,
      moves
    })
  }
  for (const name of poolIndex.keys()) if (!seen.has(name)) poolIndex.delete(name)
}

/** A swap seen in the logs: counted for the pool's activity. */
function noteSwap(name: string, at: number) {
  const e = poolIndex.get(name)
  if (!e) return
  e.moves = e.moves.filter((t) => Date.now() - t < ACTIVITY_WINDOW_MS)
  e.moves.push(at)
  e.movedAt = Math.max(e.movedAt ?? 0, at)
}

/** The scanned pools for the page: filtered by text and exchange, the most active first. */
function poolList(q: string, venue: string, limit: number) {
  const needle = q.trim().toLowerCase()
  const now = Date.now()
  const rows = [...poolIndex.values()]
    .filter((p) => (venue === 'alcor' || venue === 'taco' ? p.venue === venue : true))
    .filter((p) => !needle || p.name.toLowerCase().includes(needle) || p.pair.toLowerCase().includes(needle))
    .map((p) => ({ ...p, movesHour: p.moves.filter((t) => now - t < ACTIVITY_WINDOW_MS).length }))
    .sort((a, b) => b.movesHour - a.movesHour || (b.movedAt ?? 0) - (a.movedAt ?? 0) || b.depthWax - a.depthWax)
  return {
    total: poolIndex.size,
    matching: rows.length,
    watchingMs: now - watchingSince,
    pools: rows.slice(0, limit).map(({ sig: _sig, moves: _moves, ...p }) => ({
      ...p,
      blockedUntil: (blockedPools.get(p.name)?.until ?? 0) > now ? blockedPools.get(p.name)!.until : null
    }))
  }
}

// ---- The market in memory -------------------------------------------------------------------------

/**
 * Every pool, read in full at the start and every few minutes; in between, the swap logs of both
 * exchanges (polled every few seconds) update the pools that traded, and only the loops through
 * those pools are checked again. Each log carries the pool's state right after the swap.
 */
interface Market {
  at: number
  /** Pools read in the last full pass (all of both exchanges). */
  read: number
  liquid: ClmmPool[]
  price: Map<string, number>
  loops: Loop[]
  loopsByPool: Map<string, Loop[]>
  alcor: Map<number, ClmmPool>
  taco: Map<string, ClmmPool>
}

let market: Market | null = null

/** Pools that blocks changed since the last pass, and the swaps among those changes. */
const pendingChanged = new Set<ClmmPool>()
let pendingSwaps = 0

/** The main feed: every block, about a second after it is made, through the trace API. */
const follower = new BlockFollower(
  endpointPool,
  (path, body) => rpc(path, body),
  (actions) => {
    if (!market) return
    const { changed, swaps } = applyLogs(market, actions as LogAction[])
    for (const p of changed) pendingChanged.add(p)
    pendingSwaps += swaps
    if (changed.size) requestPass()
  }
)
follower.onRequest = (kind) => countRequest(kind === 'block' ? '/v1/trace_api/get_block' : '/v1/chain/get_info')

/** Where the log polling stands, for the page. */
const watch = {
  /** Newest log timestamp handled, per exchange (ms), and the last sequence numbers seen. */
  alcorTs: 0,
  tacoTs: 0,
  seen: new Set<string>(),
  lastPollAt: 0,
  /** How far behind the chain the history node was on the last poll, in seconds. */
  lagSec: 0,
  swapsSeen: 0,
  failures: 0
}

interface LogAction {
  '@timestamp': string
  global_sequence: number | string
  trx_id?: string
  act: { account: string; name: string; data: Record<string, unknown> }
}

/** A swap someone made on Alcor or Taco, as the logs reported it. */
interface SeenSwap {
  at: number
  venue: 'alcor' | 'taco'
  /** Alcor pool id or Taco pair id. */
  pool: string
  inAmount: number
  inSymbol: string
  outAmount: number
  outSymbol: string
  who: string
  trxId?: string
  /** True when the swap was one of this bot's own. */
  mine: boolean
}

const SWAPS_FILE = join(HERE, 'swaps.jsonl')
const TICKER_SIZE = 300
/** The latest swaps, newest first, for the page's ticker; every one is also appended to bot/swaps.jsonl. */
const ticker: SeenSwap[] = []

/** A logged swap in plain terms: what went in and what came out. */
function swapOfLog(a: LogAction): SeenSwap | null {
  const d = a.act.data
  const at = tsOf(a)
  if (a.act.name === 'logswap') {
    // Alcor logs the pool's side: positive is what the pool received, negative what it paid out.
    const sides = [String(d.tokenA ?? ''), String(d.tokenB ?? '')].map((q) => ({
      amount: Number(q.split(' ')[0]),
      symbol: q.split(' ')[1] ?? ''
    }))
    const into = sides.find((x) => x.amount > 0)
    const out = sides.find((x) => x.amount < 0)
    if (!into || !out) return null
    const who = String(d.recipient ?? d.sender ?? '')
    return {
      at,
      venue: 'alcor',
      pool: `#${d.poolId}`,
      inAmount: into.amount,
      inSymbol: into.symbol,
      outAmount: -out.amount,
      outSymbol: out.symbol,
      who,
      trxId: a.trx_id,
      mine: who === ACCOUNT
    }
  }
  if (a.act.name === 'exchangelog') {
    const who = String(d.maker ?? '')
    return {
      at,
      venue: 'taco',
      pool: String(d.id ?? ''),
      inAmount: amountOfAsset(d.quantity_in),
      inSymbol: symbolOfAsset(d.quantity_in),
      outAmount: amountOfAsset(d.quantity_out),
      outSymbol: symbolOfAsset(d.quantity_out),
      who,
      trxId: a.trx_id,
      mine: who === ACCOUNT
    }
  }
  return null
}

function recordSwap(sw: SeenSwap) {
  ticker.unshift(sw)
  if (ticker.length > TICKER_SIZE) ticker.length = TICKER_SIZE
  try {
    appendFileSync(SWAPS_FILE, JSON.stringify(sw) + String.fromCharCode(10))
  } catch {
    // The log file is a convenience; the ticker works without it.
  }
}

async function history(params: Record<string, string>): Promise<LogAction[]> {
  countRequest('/v2/history')
  const json = await poolHistory<{ actions?: LogAction[] }>(endpointPool, new URLSearchParams(params).toString())
  return json.actions ?? []
}

const amountOfAsset = (q: unknown) => Number(String(q ?? '').split(' ')[0])
const symbolOfAsset = (q: unknown) => String(q ?? '').split(' ')[1] ?? ''
const tsOf = (a: LogAction) => Date.parse(a['@timestamp'] + 'Z')

/** Reads every pool of both exchanges and lays out every loop, indexed by pool. */
async function buildMarket(): Promise<Market> {
  const at = Date.now()
  const [rows, tacoRows] = await Promise.all([readPools(), readTaco()])
  const pools = [...rows.filter((r) => Number(r.active) && Number(r.liquidity) > 0).map(clmmFromRow), ...tacoPools(tacoRows)]
  const price = waxPrices(pools)
  const liquid = liquidPools(pools, price, MIN_POOL_WAX)
  const starts = settings.starts.map((s) => START_IDS[s])
  const loops = findLoops(liquid, starts)
  const loopsByPool = new Map<string, Loop[]>()
  for (const l of loops)
    for (const p of l.pools) {
      const list = loopsByPool.get(poolName(p)) ?? []
      list.push(l)
      loopsByPool.set(poolName(p), list)
    }
  indexPools(liquid, price, at)
  // Logs from just before this read on are applied next: the read itself may be a few seconds old.
  watch.alcorTs = watch.tacoTs = at - 10_000
  return {
    at,
    read: rows.length + tacoRows.length,
    liquid,
    price,
    loops,
    loopsByPool,
    alcor: new Map(liquid.filter((p) => p.venue === 'alcor').map((p) => [p.id, p])),
    taco: new Map(liquid.filter((p) => p.venue === 'taco').map((p) => [p.name, p]))
  }
}

/** The swap logs since the last poll, from the history nodes (the fallback feed). */
async function fetchLogs(): Promise<LogAction[]> {
  const iso = (ms: number) => new Date(ms - 1000).toISOString().slice(0, 19)
  const [alcorLogs, tacoLogs] = await Promise.all([
    history({
      account: 'swap.alcor',
      filter: 'swap.alcor:logswap,swap.alcor:logmint,swap.alcor:logburn',
      after: iso(watch.alcorTs),
      sort: 'asc',
      limit: '500'
    }),
    history({
      account: 'swap.taco',
      filter: 'swap.taco:exchangelog,swap.taco:liquiditylog',
      after: iso(watch.tacoTs),
      sort: 'asc',
      limit: '500'
    })
  ])
  watch.lastPollAt = Date.now()
  return [...alcorLogs, ...tacoLogs]
}

/** Swap logs, from either feed, applied to the pools in memory; returns the pools that changed. */
function applyLogs(m: Market, logs: LogAction[]): { changed: Set<ClmmPool>; swaps: number } {
  const changed = new Set<ClmmPool>()
  let swaps = 0
  let newest = 0
  for (const a of logs) {
    const seq = String(a.global_sequence)
    if (watch.seen.has(seq)) continue
    watch.seen.add(seq)
    // Every swap goes in the ticker, also in pools the bot does not trade.
    const seenSwap = swapOfLog(a)
    if (seenSwap) recordSwap(seenSwap)
    const at = tsOf(a)
    newest = Math.max(newest, at)
    const d = a.act.data
    let pool: ClmmPool | undefined
    if (a.act.account === 'swap.alcor') {
      watch.alcorTs = Math.max(watch.alcorTs, at)
      pool = m.alcor.get(Number(d.poolId))
      if (!pool) continue
      pool.sqrt = Number((BigInt(String(d.sqrtPriceX64)) * 10n ** 12n) / 2n ** 64n) / 1e12
      pool.tick = Number(d.tick)
      if (d.liquidity !== undefined && a.act.name === 'logswap') pool.liquidity = Number(d.liquidity)
      pool.reserveA = amountOfAsset(d.reserveA)
      pool.reserveB = amountOfAsset(d.reserveB)
      if (a.act.name !== 'logswap') {
        // Liquidity was added or taken out: the active liquidity and price ranges are read again.
        tickCache.delete(pool.id)
        stalePools.add(poolName(pool))
      }
    } else {
      watch.tacoTs = Math.max(watch.tacoTs, at)
      pool = m.taco.get(String(d.id ?? symbolOfAsset(d.lp_token)))
      if (!pool) continue
      for (const q of [d.pool1, d.pool2]) {
        if (symbolOfAsset(q) === pool.a.symbol) pool.reserveA = amountOfAsset(q)
        else if (symbolOfAsset(q) === pool.b.symbol) pool.reserveB = amountOfAsset(q)
      }
    }
    changed.add(pool)
    if (a.act.name === 'logswap' || a.act.name === 'exchangelog') {
      swaps++
      noteSwap(poolName(pool), at)
    }
  }
  if (newest) watch.lagSec = Math.max(0, (Date.now() - newest) / 1000)
  // Keep the memory of seen logs small.
  if (watch.seen.size > 20_000) watch.seen = new Set([...watch.seen].slice(-5_000))
  watch.swapsSeen += swaps
  return { changed, swaps }
}

/** Pools whose liquidity changed since they were read: read again before their loops are sized. */
const stalePools = new Set<string>()

async function rereadStale(m: Market, pools: ClmmPool[]) {
  await Promise.all(
    pools
      .filter((p) => stalePools.has(poolName(p)))
      .map(async (p) => {
        const fresh = (await refreshRoute({ start: p.a, pools: [p], path: [], marginal: 0 })).pools[0]
        Object.assign(p, { ...fresh, id: p.id })
        stalePools.delete(poolName(p))
        if (p.venue === 'alcor') m.alcor.set(p.id, p)
      })
  )
}

/** Recomputes a loop's marginal rate from its pools as they are now. */
function remargin(l: Loop) {
  let marginal = 1
  let id = l.start.id
  for (const p of l.pools) {
    marginal *= spotRate(p, id) * (1 - p.fee)
    id = otherToken(p, id).id
  }
  l.marginal = marginal
}

// ---- One pass ------------------------------------------------------------------------------------

const routeOf = (loop: Loop) => loop.path.map((t) => t.symbol)

async function refreshBalances() {
  const [wax, tlm, def] = await Promise.all([
    balance('eosio.token', 'WAX'),
    balance('alien.worlds', 'TLM'),
    balance('defensetoken', 'DEF')
  ])
  state.balances = { wax, tlm, def, at: Date.now() }
  if (ACCOUNT) {
    try {
      const acc = (await rpc('/v1/chain/get_account', { account_name: ACCOUNT })) as {
        cpu_limit?: { used: number | string; max: number | string }
      }
      const used = Number(acc.cpu_limit?.used ?? 0)
      const max = Number(acc.cpu_limit?.max ?? 0)
      state.cpu = { used, max, pct: max > 0 ? (used / max) * 100 : 0, at: Date.now() }
    } catch {
      // The CPU figure is for the page only; the balances above are what the trading needs.
    }
  }
}

let lastBalanceAt = 0

/**
 * One pass: a full read when it is due (or the logs cannot be read), otherwise the logs since the
 * last pass; then the loops through whatever changed are checked.
 */
async function scanOnce() {
  const started = Date.now()
  // When the newest block behind this pass was made: the clock for the reaction time of a trade.
  const triggerAt = follower.healthy ? follower.blockTime : 0
  state.stats.passes++
  if (Date.now() - lastBalanceAt > 30_000) {
    await refreshBalances()
    lastBalanceAt = Date.now()
  }

  let mode: 'full' | 'logs' = 'logs'
  let candidates: Loop[]
  let swaps = 0
  let changedCount = 0
  const due = !market || Date.now() - market.at > settings.fullRefreshMin * 60_000 || watch.failures >= 3
  if (due) {
    mode = 'full'
    market = await buildMarket()
    watch.failures = 0
    pendingChanged.clear()
    pendingSwaps = 0
    candidates = market.loops
  } else {
    // The blocks feed the pools as they come; the history logs only fill in while the blocks stall.
    if (!follower.healthy) {
      try {
        const r = applyLogs(market!, await fetchLogs())
        for (const p of r.changed) pendingChanged.add(p)
        pendingSwaps += r.swaps
        watch.failures = 0
      } catch (err) {
        watch.failures++
        throw new Error(`Could not read the swap logs (${chainError(err)}); a full read follows if this repeats`)
      }
    }
    const changed = [...pendingChanged]
    pendingChanged.clear()
    swaps = pendingSwaps
    pendingSwaps = 0
    changedCount = changed.length
    const set = new Set<Loop>()
    for (const p of changed) for (const l of market!.loopsByPool.get(poolName(p)) ?? []) set.add(l)
    candidates = [...set]
    candidates.forEach(remargin)
  }
  const m = market!

  const scanNow = Date.now()
  const setAside = (l: Loop) =>
    (rejectedLoops.get(loopKey(l)) ?? 0) > scanNow || l.pools.some((p) => (blockedPools.get(poolName(p))?.until ?? 0) > scanNow)
  const promising = candidates
    .filter((l) => l.marginal > MIN_MARGINAL && !setAside(l))
    .sort((a, b) => b.marginal - a.marginal)
    .slice(0, MAX_EXACT)

  const involved = [...new Set(promising.flatMap((l) => l.pools))]
  await rereadStale(m, involved)
  await Promise.all(
    involved
      .filter((p) => p.venue === 'alcor')
      .map(async (p: ClmmPool) => {
        p.ticks = await ticksOf(p.id)
        const entry = poolIndex.get(poolName(p))
        if (entry) entry.ticksAt = tickCache.get(p.id)?.at ?? Date.now()
      })
  )

  // Size each loop to what the wallet holds (never more) and the trade limit.
  const capOf = (loop: Loop) => {
    const startWax = m.price.get(loop.start.id) ?? 0
    // Without an account (watching only) there is no wallet to limit the size.
    const held = !ACCOUNT ? Infinity : heldOf(loop.start.id)
    return { startWax, cap: Math.min(held, startWax > 0 ? settings.maxTradeWax / startWax : 0) }
  }
  const screened = promising
    .map((loop) => {
      const { startWax, cap } = capOf(loop)
      return { loop, startWax, cap, sim: cap > 0 ? bestSize(loop, cap) : null }
    })
    .filter((c) => c.sim && c.sim.profit > 0)
    .sort((a, b) => b.sim!.profit * b.startWax - a.sim!.profit * a.startWax)
    .slice(0, MAX_DRY_RUN_LOOPS)

  // The contract decides: dry runs from this very account, at sizes around the simulated best.
  const confirmed: (Candidate & { loop: Loop; startWax: number })[] = []
  for (const c of screened) {
    // From this very account when there is one; otherwise from an account that holds plenty.
    const holder = ACCOUNT || QUOTE_HOLDERS[c.loop.start.id]
    if (!holder) continue
    const { best } = await verifyLoop(rpc, holder, c.loop, c.sim!.amount, c.cap)
    for (const p of c.loop.pools) {
      const entry = poolIndex.get(poolName(p))
      if (entry) entry.checkedAt = Date.now()
    }
    if (!best) {
      rejectLoop(c.loop)
      continue
    }
    confirmed.push({
      loop: c.loop,
      startWax: c.startWax,
      route: routeOf(c.loop),
      pools: c.loop.pools.map(poolName),
      symbol: c.loop.start.symbol,
      input: best.amount,
      received: best.received,
      profit: best.profit,
      profitWax: best.profit * c.startWax
    })
  }
  confirmed.sort((a, b) => b.profitWax - a.profitWax)
  state.stats.loopsChecked += candidates.length
  state.stats.dryRunLoops += screened.length
  state.stats.confirmed += confirmed.length

  state.scan = {
    at: Date.now(),
    ms: Date.now() - started,
    mode,
    pools: m.read,
    liquid: m.liquid.length,
    loops: m.loops.length,
    checked: candidates.length,
    swaps,
    changedPools: changedCount,
    fullAt: m.at,
    feed: follower.healthy ? 'blocks' : 'logs',
    block: follower.block,
    lagSec: follower.healthy ? follower.lagSec : watch.lagSec,
    swapsSeen: watch.swapsSeen,
    simulated: promising.length,
    dryRun: screened.length,
    setAside: [...rejectedLoops.values()].filter((t) => t > Date.now()).length,
    blockedPools: [...blockedPools.values()].filter((b) => b.until > Date.now()).length,
    // Keep the last confirmed list on a quiet pass, so the page does not flicker.
    confirmed:
      screened.length || mode === 'full'
        ? confirmed.map(({ loop: _loop, startWax: _w, ...rest }) => rest)
        : (state.scan?.confirmed ?? [])
  }
  if (mode === 'full')
    log(
      `Full read: ${m.read.toLocaleString()} pools, ${m.liquid.length.toLocaleString()} liquid, ${m.loops.length.toLocaleString()} loops`
    )

  const best = confirmed[0]
  if (!best || !(best.profit > 0)) return
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
  // Right before signing: one more dry run of exactly this trade against the chain as it is now
  // (a dry run runs on the node's newest state). Only if it still pays is it signed.
  const check = await dryRunLoop(rpc, ACCOUNT, best.loop, best.input)
  if (!check.ok || !(check.received - check.paid > 0)) {
    state.stats.finalFails++
    log(`Skipped ${best.route.join(' > ')}: gone on the final check${!check.ok ? ` (${check.error})` : ''}`)
    return
  }
  await execute(best.loop, check.paid, check.received, best.startWax, triggerAt)
}

/** The loop with its pools and ticks read straight from the chain, bypassing every cache. */
async function refreshRoute(loop: Loop): Promise<Loop> {
  const pools = await Promise.all(
    loop.pools.map(async (p) => {
      if (p.venue === 'taco') {
        const [row] = await tableRows<TacoRow>({
          code: 'swap.taco',
          scope: 'swap.taco',
          table: 'pairs',
          lower_bound: p.name,
          upper_bound: p.name
        })
        if (!row) throw new Error(`Taco pair ${p.name} could not be read`)
        return { ...tacoFromRow(row, 0), id: p.id }
      }
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

async function execute(loop: Loop, input: number, expectedOut: number, startWax: number, triggerAt = 0) {
  const t = loop.start
  const unit = 10 ** -t.decimals
  // At least the minimum profit back, or the transaction fails as a whole.
  // Any profit counts: the swap only has to return one smallest unit more than went in.
  const minProfit = unit
  void expectedOut
  void startWax
  const minOut = input + minProfit
  const trade: Trade = {
    at: Date.now(),
    route: routeOf(loop),
    pools: loop.pools.map(poolName),
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
    const { tx, chainId } = await buildTransaction(rpc, loopActions(ACCOUNT, PERMISSION, loop, input, minOut))
    const signature = signer!.signDigest(tx.signingDigest(chainId))
    const packed = PackedTransaction.fromSigned(SignedTransaction.from({ ...tx, signatures: [signature] }))
    countRequest('/v1/chain/push_transaction')
    state.stats.sent++
    const res = (await poolPushFastest(endpointPool, packed)) as { transaction_id: string; processed: unknown }
    const flows = loopFlows(res.processed, ACCOUNT, t)
    trade.trxId = res.transaction_id
    trade.output = flows.received
    trade.profit = flows.received - flows.paid
    trade.profitWax = trade.profit * startWax
    trade.input = flows.paid || input
    trade.status = 'done'
    if (triggerAt) trade.reactionMs = Date.now() - triggerAt
    log(
      `Ran ${trade.route.join(' > ')}: ${trade.input} ${t.symbol} in, ${trade.output} back, ${trade.profit >= 0 ? '+' : ''}${trade.profit.toFixed(t.decimals)} ${t.symbol}`
    )
  } catch (err) {
    trade.error = chainError(err)
    state.stats.failedTx++
    log(`Failed ${trade.route.join(' > ')}: ${trade.error}`)
  }
  saveTrade(trade)
  await refreshBalances().catch(() => undefined)
}

// ---- The loop ----------------------------------------------------------------------------------------

let timer: NodeJS.Timeout | null = null
/** A block changed pools while a pass ran: run another right after it. */
let passQueued = false

/** Runs a pass now, or right after the current one. */
function requestPass() {
  if (!state.running) return
  if (state.busy) {
    passQueued = true
    return
  }
  if (timer) clearTimeout(timer)
  void tick()
}

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
    const wait = Math.max(0, settings.pollSec * 1000 - (Date.now() - startedAt))
    if (state.running) {
      if (passQueued) {
        passQueued = false
        timer = setTimeout(() => void tick(), 0)
      } else timer = setTimeout(() => void tick(), wait)
    }
  }
}

function start() {
  if (state.running) return
  state.running = true
  rememberRunning(true)
  log(signer && !settings.watchOnly ? `Started: trading for ${ACCOUNT}@${PERMISSION}` : 'Started in watch-only mode')
  follower.start()
  void tick()
}

function stop() {
  state.running = false
  rememberRunning(false)
  follower.stop()
  if (timer) clearTimeout(timer)
  timer = null
  log('Stopped')
}

// ---- The control page ----------------------------------------------------------------------------------

function snapshot() {
  const all = readTrades()
  const trades = all.slice().reverse().slice(0, 200)
  const done = all.filter((t) => t.status === 'done')
  const total = done.reduce((n, t) => n + (t.profitWax ?? 0), 0)
  // Every trade so far, not just the ones shown: profit in the token each loop started and ended in.
  const profitBySymbol = { WAX: 0, TLM: 0, DEF: 0 } as Record<string, number>
  for (const t of done) profitBySymbol[t.symbol] = (profitBySymbol[t.symbol] ?? 0) + (t.profit ?? 0)
  const tradeCounts = { done: done.length, failed: all.length - done.length }
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
    cpu: state.cpu,
    stats: state.stats,
    scan: state.scan,
    lastError: state.lastError,
    log: state.log,
    trades,
    totalProfitWax: total,
    profitBySymbol,
    tradeCounts,
    /** The WAX nodes in use, with speed and load. */
    endpoints: endpointPool.report(),
    /** The latest swaps on both exchanges, newest first. */
    ticker: ticker.slice(0, 120),
    /** Chain requests in the last minute, by kind. */
    requests: requestLog
      .filter((r) => Date.now() - r.at <= 60_000)
      .reduce<Record<string, number>>((m, r) => ((m[r.kind] = (m[r.kind] ?? 0) + 1), m), {})
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
  const startsBefore = settings.starts.join(',')
  settings = {
    pollSec: num(input.pollSec, 2, 600, settings.pollSec),
    fullRefreshMin: num(input.fullRefreshMin, 1, 120, settings.fullRefreshMin),
    maxTradeWax: num(input.maxTradeWax, 1, 1e7, settings.maxTradeWax),
    starts: Array.isArray(input.starts) ? (input.starts.filter((s) => s in START_IDS) as Settings['starts']) : settings.starts,
    watchOnly: typeof input.watchOnly === 'boolean' ? input.watchOnly : settings.watchOnly,
    tradeGapSec: num(input.tradeGapSec, 0, 86400, settings.tradeGapSec),
    startsVersion: 2
  }
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2))
  // Other start tokens mean other loops: they are laid out again on the next pass.
  if (settings.starts.join(',') !== startsBefore) market = null
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
  if (req.method === 'GET' && url.pathname === '/api/pools')
    return send(
      200,
      poolList(
        url.searchParams.get('q') ?? '',
        url.searchParams.get('venue') ?? '',
        Math.min(500, Number(url.searchParams.get('limit')) || 200)
      )
    )
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

server.listen(PORT, '127.0.0.1', async () => {
  await endpointPool.probe().catch(() => undefined)
  const ok = endpointPool.endpoints.filter((e) => e.chain).length
  const hist = endpointPool.endpoints.filter((e) => e.history).length
  console.log(`WAX nodes: ${ok} answer chain requests, ${hist} have the history API (of ${endpointPool.endpoints.length} tried).`)
  console.log(`Alcor loop bot: open http://127.0.0.1:${PORT}`)
  if (keyProblem) console.log(keyProblem)
  else console.log(`Account ${ACCOUNT}@${PERMISSION}, key loaded.`)
  refreshBalances().catch((err) => log(`Could not read balances: ${chainError(err)}`))
  if (wasRunning()) {
    log('Was running before the restart: starting again')
    start()
  }
})
