/*
 * Exact swaps through Alcor's concentrated-liquidity pools, and the search for loops that start and
 * end in the same token with more than they started with.
 *
 * A pool keeps sqrt(price) as sqrt(raw B per raw A) and the liquidity active at that price. Liquidity
 * changes at initialised ticks (liquidityNet: added when the price crosses the tick upwards, removed
 * when it crosses downwards). Within one range the constant-liquidity formulas are exact; a swap that
 * runs out of range steps to the next tick and carries on with the liquidity there. The pool's fee
 * comes off the input, and the output is rounded down to whole raw units of the token, as the pool
 * pays it: a token with few decimals loses a real share of a small trade to that.
 */

export interface ClmmToken {
  /** symbol@contract: symbols alone are not unique on WAX. */
  id: string
  symbol: string
  contract: string
  decimals: number
}

export interface ClmmTick {
  tick: number
  net: number
}

/** Which exchange a pool belongs to: Alcor's concentrated liquidity, or Taco's constant product. */
export type Venue = 'alcor' | 'taco'

export interface ClmmPool {
  /** Alcor's pool id; for Taco an internal number (the pair is in `name`). Unique across venues. */
  id: number
  venue: Venue
  /** For display and Taco reads: Alcor "#10447", Taco the pair id like "TACWAX". */
  name: string
  a: ClmmToken
  b: ClmmToken
  /** sqrt(raw B per raw A). */
  sqrt: number
  tick: number
  liquidity: number
  /** Fraction, e.g. 0.01 for a 1% pool. */
  fee: number
  /** Initialised ticks in ascending order; empty: only the active range is known. */
  ticks: ClmmTick[]
  /** Deposited amounts as the pool row reports them (all ranges together), for a size estimate. */
  reserveA: number
  reserveB: number
}

export interface PoolRow {
  id: number | string
  active: number | boolean
  tokenA: { quantity: string; contract: string }
  tokenB: { quantity: string; contract: string }
  fee: number | string
  currSlot: { sqrtPriceX64: string; tick: number | string }
  liquidity: string
}

const tokenOf = (t: { quantity: string; contract: string }): { token: ClmmToken; amount: number } => {
  const [num, symbol] = t.quantity.split(' ')
  return {
    token: {
      id: `${symbol}@${t.contract}`,
      symbol,
      contract: t.contract,
      decimals: num.includes('.') ? num.split('.')[1].length : 0
    },
    amount: Number(num)
  }
}

/** A pool row as a ClmmPool (ticks to be added separately). */
export function clmmFromRow(row: PoolRow): ClmmPool {
  const a = tokenOf(row.tokenA)
  const b = tokenOf(row.tokenB)
  return {
    id: Number(row.id),
    venue: 'alcor',
    name: `#${row.id}`,
    a: a.token,
    b: b.token,
    sqrt: Number((BigInt(row.currSlot.sqrtPriceX64) * 10n ** 12n) / 2n ** 64n) / 1e12,
    tick: Number(row.currSlot.tick),
    liquidity: Number(row.liquidity),
    fee: Number(row.fee) / 1e6,
    ticks: [],
    reserveA: a.amount,
    reserveB: b.amount
  }
}

export interface TacoRow {
  id: string
  pool1: { quantity: string; contract: string }
  pool2: { quantity: string; contract: string }
}

/** Taco internal ids start here, clear of Alcor's pool ids. */
export const TACO_ID_BASE = 100_000_000

/** Taco's swap fee, paid out of the input before it reaches the pair. */
export const TACO_SWAP_FEE = 0.002
/** Taco's pool fee, kept in the pair. */
export const TACO_POOL_FEE = 0.001

/** A Taco pair as a pool; `index` gives it a stable internal id. */
export function tacoFromRow(row: TacoRow, index: number): ClmmPool {
  const a = tokenOf(row.pool1)
  const b = tokenOf(row.pool2)
  return {
    id: TACO_ID_BASE + index,
    venue: 'taco',
    name: row.id,
    a: a.token,
    b: b.token,
    sqrt: 0,
    tick: 0,
    liquidity: 0,
    fee: TACO_SWAP_FEE + TACO_POOL_FEE,
    ticks: [],
    reserveA: a.amount,
    reserveB: b.amount
  }
}

const sqrtAt = (tick: number) => Math.pow(1.0001, tick / 2)

/** Mid price of `from` in the other token (display units), before fee and depth. */
export function spotRate(p: ClmmPool, fromId: string): number {
  if (p.venue === 'taco') {
    if (!(p.reserveA > 0 && p.reserveB > 0)) return 0
    return fromId === p.a.id ? p.reserveB / p.reserveA : p.reserveA / p.reserveB
  }
  const bPerA = (p.sqrt * p.sqrt * 10 ** p.a.decimals) / 10 ** p.b.decimals
  return fromId === p.a.id ? bPerA : 1 / bPerA
}

/**
 * Taco: the swap fee leaves the input first, the pool fee stays in the pair, the rest swaps at
 * constant product; the output is paid in whole raw units.
 */
function tacoOut(p: ClmmPool, fromId: string, amount: number): number {
  const aIn = fromId === p.a.id
  const inT = aIn ? p.a : p.b
  const outT = aIn ? p.b : p.a
  const rIn = (aIn ? p.reserveA : p.reserveB) * 10 ** inT.decimals
  const rOut = (aIn ? p.reserveB : p.reserveA) * 10 ** outT.decimals
  const raw = Math.floor(amount * 10 ** inT.decimals + 1e-9)
  const afterSwapFee = raw - Math.round(raw * TACO_SWAP_FEE)
  if (afterSwapFee <= 0 || !(rIn > 0 && rOut > 0)) return 0
  const effective = afterSwapFee * (1 - TACO_POOL_FEE)
  return Math.floor((rOut * effective) / (rIn + effective)) / 10 ** outT.decimals
}

export const otherToken = (p: ClmmPool, fromId: string) => (fromId === p.a.id ? p.b : p.a)

/**
 * What paying `amount` of `fromId` (display units) into the pool returns of the other token,
 * stepping across initialised ticks. Stops where liquidity runs out (the rest of the input would
 * not be swapped; the result is then what the pool can give).
 */
export function swapOut(p: ClmmPool, fromId: string, amount: number): number {
  if (!(amount > 0)) return 0
  if (p.venue === 'taco') return tacoOut(p, fromId, amount)
  const aToB = fromId === p.a.id
  let s = p.sqrt
  let L = p.liquidity
  // The input arrives in whole raw units and the fee is rounded up to a whole unit, as the pool
  // charges it: on a token with few decimals that can be most of a small trade.
  const raw = Math.floor(amount * 10 ** (aToB ? p.a.decimals : p.b.decimals) + 1e-9)
  let x = raw - Math.ceil(raw * p.fee - 1e-9)
  if (x <= 0) return 0
  let out = 0
  const T = p.ticks
  if (aToB) {
    // A in, price falls: walk down through ticks at or below the current one.
    let i = T.length - 1
    while (i >= 0 && T[i].tick > p.tick) i--
    for (let guard = 0; x > 0 && guard < 10_000; guard++) {
      const low = i >= 0 ? T[i] : null
      const sLow = low ? sqrtAt(low.tick) : 0
      if (L <= 0) {
        if (!low) break
        L -= low.net
        s = sLow
        i--
        continue
      }
      const maxIn = low ? L * (1 / sLow - 1 / s) : Infinity
      if (x < maxIn) {
        const next = (L * s) / (L + x * s)
        out += L * (s - next)
        break
      }
      out += L * (s - sLow)
      x -= maxIn
      s = sLow
      L -= low!.net
      i--
    }
    // The pool pays whole raw units: round down to the token's precision.
    return Math.floor(out) / 10 ** p.b.decimals
  }
  // B in, price rises: walk up through ticks above the current one.
  let i = 0
  while (i < T.length && T[i].tick <= p.tick) i++
  for (let guard = 0; x > 0 && guard < 10_000; guard++) {
    const up = i < T.length ? T[i] : null
    const sUp = up ? sqrtAt(up.tick) : Infinity
    if (L <= 0) {
      if (!up) break
      L += up.net
      s = sUp
      i++
      continue
    }
    const maxIn = up ? L * (sUp - s) : Infinity
    if (x < maxIn) {
      const next = s + x / L
      out += L * (1 / s - 1 / next)
      break
    }
    out += L * (1 / s - 1 / sUp)
    x -= maxIn
    s = sUp
    L += up!.net
    i++
  }
  return Math.floor(out) / 10 ** p.a.decimals
}

export interface Loop {
  /** Token the loop starts and ends in. */
  start: ClmmToken
  pools: ClmmPool[]
  /** Tokens along the way, first and last = start. */
  path: ClmmToken[]
  /** Output per unit input for a tiny trade, fees included: above 1 means the loop pays at the margin. */
  marginal: number
}

/** Walks `amount` of the loop's start token through its pools. */
export function loopOut(loop: Loop, amount: number): number {
  let id = loop.start.id
  let v = amount
  for (const p of loop.pools) {
    v = swapOut(p, id, v)
    id = otherToken(p, id).id
  }
  return v
}

export interface Sized {
  amount: number
  out: number
  profit: number
}

/**
 * The input with the largest profit, at most `cap`. Profit rises then falls with size, so a coarse
 * pass on a log scale finds the hill and a ternary search climbs it.
 */
export function bestSize(loop: Loop, cap = 1e7, floor = 1e-4): Sized {
  if (!(cap > floor)) return { amount: 0, out: 0, profit: 0 }
  // Rounding to whole units makes profit a staircase: keep the best point actually seen.
  let best: Sized = { amount: 0, out: 0, profit: 0 }
  const profitAt = (x: number) => {
    const amount = Math.min(cap, x)
    const out = loopOut(loop, amount)
    const profit = out - amount
    if (profit > best.profit) best = { amount, out, profit }
    return profit
  }
  const lo = Math.log(floor)
  const hi = Math.log(cap)
  const STEPS = 96
  let bestK = 0
  let bestP = -Infinity
  for (let k = 0; k <= STEPS; k++) {
    const p = profitAt(Math.exp(lo + ((hi - lo) * k) / STEPS))
    if (p > bestP) {
      bestP = p
      bestK = k
    }
  }
  let a = lo + ((hi - lo) * Math.max(0, bestK - 1)) / STEPS
  let b = lo + ((hi - lo) * Math.min(STEPS, bestK + 1)) / STEPS
  for (let k = 0; k < 40; k++) {
    const m1 = a + (b - a) / 3
    const m2 = b - (b - a) / 3
    if (profitAt(Math.exp(m1)) < profitAt(Math.exp(m2))) a = m1
    else b = m2
  }
  profitAt(Math.exp((a + b) / 2))
  return best
}

/**
 * Every loop of two or three pools that starts and ends in one of `starts`, never using a pool
 * twice, with its marginal rate (fees included).
 */
export function findLoops(pools: ClmmPool[], starts: string[]): Loop[] {
  const edges = new Map<string, { pool: ClmmPool; to: ClmmToken; rate: number }[]>()
  for (const p of pools)
    for (const [from, to] of [
      [p.a, p.b],
      [p.b, p.a]
    ] as const) {
      const list = edges.get(from.id) ?? []
      list.push({ pool: p, to, rate: spotRate(p, from.id) * (1 - p.fee) })
      edges.set(from.id, list)
    }
  const tokens = new Map<string, ClmmToken>()
  for (const p of pools) {
    tokens.set(p.a.id, p.a)
    tokens.set(p.b.id, p.b)
  }
  const loops: Loop[] = []
  for (const s of starts) {
    const start = tokens.get(s)
    if (!start) continue
    for (const e1 of edges.get(s) ?? []) {
      for (const e2 of edges.get(e1.to.id) ?? []) {
        if (e2.pool === e1.pool) continue
        if (e2.to.id === s) {
          loops.push({ start, pools: [e1.pool, e2.pool], path: [start, e1.to, start], marginal: e1.rate * e2.rate })
          continue
        }
        for (const e3 of edges.get(e2.to.id) ?? []) {
          if (e3.to.id !== s || e3.pool === e1.pool || e3.pool === e2.pool) continue
          loops.push({
            start,
            pools: [e1.pool, e2.pool, e3.pool],
            path: [start, e1.to, e2.to, start],
            marginal: e1.rate * e2.rate * e3.rate
          })
        }
      }
    }
  }
  return loops
}

export const WAX_TOKEN_ID = 'WAX@eosio.token'
export const TLM_TOKEN_ID = 'TLM@alien.worlds'
export const DEF_TOKEN_ID = 'DEF@defensetoken'

/** Each token's price in WAX, from the pool holding the most WAX against it. */
export function waxPrices(pools: ClmmPool[]): Map<string, number> {
  const price = new Map<string, number>([[WAX_TOKEN_ID, 1]])
  const depth = new Map<string, number>()
  for (const p of pools) {
    const waxSide = p.a.id === WAX_TOKEN_ID ? 'a' : p.b.id === WAX_TOKEN_ID ? 'b' : null
    if (!waxSide) continue
    const other = waxSide === 'a' ? p.b : p.a
    const wax = waxSide === 'a' ? p.reserveA : p.reserveB
    if (wax <= (depth.get(other.id) ?? 0)) continue
    depth.set(other.id, wax)
    price.set(other.id, spotRate(p, other.id))
  }
  return price
}

/** Pools whose both sides hold at least `minWax`, valued in WAX (tokens without a WAX price drop out). */
export function liquidPools(pools: ClmmPool[], price: Map<string, number>, minWax: number): ClmmPool[] {
  return pools.filter((p) => {
    const pa = price.get(p.a.id)
    const pb = price.get(p.b.id)
    return pa !== undefined && pb !== undefined && Math.min(p.reserveA * pa, p.reserveB * pb) >= minWax
  })
}

/** One transfer of a loop: consecutive Alcor pools go in one swap, every Taco pair is its own. */
export interface Segment {
  venue: Venue
  pools: ClmmPool[]
  inToken: ClmmToken
  inAmount: number
  outToken: ClmmToken
  /** The least this transfer must return, or the whole transaction fails. */
  minOut: number
}

/** Each later transfer spends this much less than the previous one is expected to return. */
export const SEGMENT_SLACK = 0.003

const floorUnits = (n: number, t: ClmmToken) => Math.floor(n * 10 ** t.decimals + 1e-9) / 10 ** t.decimals

/**
 * The loop as transfers: `amount` into the first, each next one spending what the previous one is
 * sure to return (its simulated output less SEGMENT_SLACK), the last asking for `minOut`. Whatever
 * a transfer returns above that stays in the wallet as a small remainder of that token.
 */
export function planSegments(loop: Loop, amount: number, minOut: number): Segment[] {
  const groups: ClmmPool[][] = []
  for (const p of loop.pools) {
    const last = groups[groups.length - 1]
    if (p.venue === 'alcor' && last && last[0].venue === 'alcor') last.push(p)
    else groups.push([p])
  }
  const segments: Segment[] = []
  let token = loop.start
  let input = amount
  groups.forEach((pools, i) => {
    let id = token.id
    let out = input
    for (const p of pools) {
      out = swapOut(p, id, out)
      id = otherToken(p, id).id
    }
    const outToken = otherToken(pools[pools.length - 1], pools.length > 1 ? pathBefore(pools, token) : token.id)
    const last = i === groups.length - 1
    const min = last ? minOut : floorUnits(out * (1 - SEGMENT_SLACK), outToken)
    segments.push({ venue: pools[0].venue, pools, inToken: token, inAmount: input, outToken, minOut: min })
    token = outToken
    input = min
  })
  return segments
}

/** The token that goes into the last pool of `pools` when `start` goes into the first. */
function pathBefore(pools: ClmmPool[], start: ClmmToken): string {
  let id = start.id
  for (const p of pools.slice(0, -1)) id = otherToken(p, id).id
  return id
}
