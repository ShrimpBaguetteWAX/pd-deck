import { CONTRACTS } from '@/chain/config'
import { getTransactionActions } from '@/chain/history'
import { getRow, getRows, rpcCall } from '@/chain/rpc'
import { QUOTE_HOLDERS, verifyLoop, type Verified } from '@/lib/alcorChain'
import {
  bestSize,
  clmmFromRow,
  findLoops,
  liquidPools,
  waxPrices,
  spotRate,
  type ClmmPool,
  type ClmmTick,
  type ClmmToken,
  type Loop,
  type PoolRow,
  type Sized
} from '@/lib/clmm'

/*
 * Loops on Alcor: every pool is read, the ones with some size on both sides are kept, every loop of
 * two or three pools that starts and ends in WAX or TLM is checked at the margin, and the most
 * promising are simulated exactly (with their pools' tick tables) to find their best size.
 */

export const WAX_ID = 'WAX@eosio.token'
export const TLM_ID = 'TLM@alien.worlds'

/** A pool counts when both sides hold at least this much, valued in WAX. */
const MIN_POOL_WAX = 20
/** Loops whose marginal rate beats this are simulated exactly, the best MAX_EXACT of them. */
const MIN_MARGINAL = 1.001
const MAX_EXACT = 60
/** Largest trade looked at, in WAX worth. */
export const MAX_TRADE_WAX = 100_000
/** Loops paying less than this, in WAX worth, are not listed. */
const MIN_PROFIT_WAX = 0.01
const TICK_READS_AT_ONCE = 6

export interface Opportunity {
  /** Pool ids and start, stable across scans. */
  key: string
  loop: Loop
  /** The simulation's best size and profit. */
  simulated: Sized
  /** The best size the real contract confirms in a dry run, and what it returns. */
  best: Verified
  /** WAX per unit of the start token. */
  startWax: number
}

export interface Scan {
  at: number
  pools: number
  liquid: number
  loops: number
  simulated: number
  /** Loops the simulation liked that the dry runs did not confirm. */
  rejected: number
  opportunities: Opportunity[]
  /** WAX per TLM, for showing TLM amounts in WAX. */
  waxPerTlm: number
}

async function readTicks(poolId: number): Promise<ClmmTick[]> {
  const rows = await getRows<{ id: number | string; liquidityNet: string }>({
    code: CONTRACTS.ALCOR_SWAP,
    scope: String(poolId),
    table: 'ticks'
  })
  return rows.map((t) => ({ tick: Number(t.id), net: Number(t.liquidityNet) })).sort((a, b) => a.tick - b.tick)
}

async function withTicks(pools: ClmmPool[]): Promise<void> {
  const queue = [...pools]
  await Promise.all(
    Array.from({ length: TICK_READS_AT_ONCE }, async () => {
      for (let p = queue.shift(); p; p = queue.shift()) p.ticks = await readTicks(p.id)
    })
  )
}

const keyOf = (loop: Loop) => `${loop.start.id}|${loop.pools.map((p) => p.id).join(',')}`

export async function scanLoops(onStep?: (label: string) => void): Promise<Scan> {
  onStep?.('Reading every Alcor pool')
  const rows = await getRows<PoolRow>({ code: CONTRACTS.ALCOR_SWAP, table: 'pools' })
  const pools = rows.filter((r) => Number(r.active) && Number(r.liquidity) > 0).map(clmmFromRow)
  const price = waxPrices(pools)
  const liquid = liquidPools(pools, price, MIN_POOL_WAX)

  onStep?.('Checking the loops')
  const loops = findLoops(liquid, [WAX_ID, TLM_ID])
  const promising = loops
    .filter((l) => l.marginal > MIN_MARGINAL)
    .sort((a, b) => b.marginal - a.marginal)
    .slice(0, MAX_EXACT)

  onStep?.(`Simulating ${promising.length} loops exactly`)
  await withTicks([...new Set(promising.flatMap((l) => l.pools))])

  const candidates = promising
    .map((loop) => {
      const startWax = price.get(loop.start.id) ?? 0
      const cap = startWax > 0 ? MAX_TRADE_WAX / startWax : 1e6
      return { loop, startWax, cap, simulated: bestSize(loop, cap) }
    })
    .filter((c) => c.simulated.profit * c.startWax >= MIN_PROFIT_WAX)

  // The simulation can be off (rounding inside thin pools, tokens that refuse transfers): the real
  // contract decides, in free dry runs from an account that holds plenty of the start token.
  onStep?.(`Checking ${candidates.length} loops against the contract`)
  const opportunities: Opportunity[] = []
  const queue = [...candidates]
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let c = queue.shift(); c; c = queue.shift()) {
        const holder = QUOTE_HOLDERS[c.loop.start.id]
        if (!holder) continue
        const { best } = await verifyLoop(rpcCall, holder, c.loop, c.simulated.amount, c.cap)
        if (best && best.profit * c.startWax >= MIN_PROFIT_WAX)
          opportunities.push({ key: keyOf(c.loop), loop: c.loop, simulated: c.simulated, best, startWax: c.startWax })
      }
    })
  )
  opportunities.sort((a, b) => b.best.profit * b.startWax - a.best.profit * a.startWax)

  return {
    at: Date.now(),
    pools: rows.length,
    liquid: liquid.length,
    loops: loops.length,
    simulated: promising.length,
    rejected: candidates.length - opportunities.length,
    opportunities,
    waxPerTlm: price.get(TLM_ID) ?? 0
  }
}

/** The loop with its pools and ticks read again, as they are right now. */
export async function refreshLoop(loop: Loop): Promise<Loop> {
  const pools = await Promise.all(
    loop.pools.map(async (p) => {
      const row = await getRow<PoolRow>({ code: CONTRACTS.ALCOR_SWAP, table: 'pools', lower_bound: p.id, upper_bound: p.id })
      if (!row) throw new Error(`Alcor pool ${p.id} could not be read.`)
      const fresh = clmmFromRow(row)
      fresh.ticks = await readTicks(p.id)
      return fresh
    })
  )
  let marginal = 1
  let id = loop.start.id
  for (const p of pools) {
    marginal *= spotRate(p, id) * (1 - p.fee)
    id = id === p.a.id ? p.b.id : p.a.id
  }
  return { ...loop, pools, marginal }
}

const fixed = (n: number, decimals: number) => (Math.floor(n * 10 ** decimals) / 10 ** decimals).toFixed(decimals)

/**
 * The swap: all of `amount` into the loop's first pool, through every pool in one Alcor call, and at
 * least `minOut` of the start token back, or the whole transaction fails.
 */
export function loopSwapAction(account: string, permission: string, loop: Loop, amount: number, minOut: number) {
  const t = loop.start
  return {
    account: t.contract,
    name: 'transfer',
    authorization: [{ actor: account, permission }],
    data: {
      from: account,
      to: CONTRACTS.ALCOR_SWAP,
      quantity: `${fixed(amount, t.decimals)} ${t.symbol}`,
      memo: `swapexactin#${loop.pools.map((p) => p.id).join(',')}#${account}#${fixed(minOut, t.decimals)} ${t.symbol}@${t.contract}#0`
    }
  }
}

/** Rounds down to what the token can hold. */
export const floorTo = (n: number, t: ClmmToken) => Math.floor(n * 10 ** t.decimals) / 10 ** t.decimals

export interface LoopResult {
  paid: number
  received: number
  profit: number
}

const amountOf = (data: Record<string, unknown>, symbol: string): number | null => {
  const q = String(data.quantity ?? '')
  const [num, sym] = q.split(' ')
  return sym === symbol ? Number(num) : null
}

/**
 * What the transaction actually moved, from the history nodes: what went from the account to Alcor,
 * and what came back to it, in the start token. Waits for the nodes to index it (null if they have
 * not within about half a minute).
 */
export async function readLoopResult(trxId: string, account: string, start: ClmmToken): Promise<LoopResult | null> {
  for (let attempt = 0; attempt < 12; attempt++) {
    await new Promise((r) => setTimeout(r, attempt === 0 ? 2000 : 2500))
    try {
      const actions = await getTransactionActions(trxId)
      if (!actions.length) continue
      let paid = 0
      let received = 0
      const seen = new Set<string>()
      for (const a of actions) {
        if (a.act.account !== start.contract || a.act.name !== 'transfer') continue
        const d = a.act.data
        // Notifications repeat a transfer once per recipient; count each once.
        const sig = `${String(d.from)}>${String(d.to)}>${String(d.quantity)}>${String(d.memo ?? '')}`
        if (seen.has(sig)) continue
        seen.add(sig)
        const n = amountOf(d, start.symbol)
        if (n === null) continue
        if (d.from === account && d.to === CONTRACTS.ALCOR_SWAP) paid += n
        if (d.from === CONTRACTS.ALCOR_SWAP && d.to === account) received += n
      }
      if (paid > 0) return { paid, received, profit: received - paid }
    } catch {
      // Not indexed yet, or the node failed: try again.
    }
  }
  return null
}
