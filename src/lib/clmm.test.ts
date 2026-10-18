import { describe, expect, it } from 'vitest'

import { bestSize, findLoops, loopOut, spotRate, swapOut, type ClmmPool, type ClmmToken } from './clmm'

const token = (symbol: string, decimals = 4): ClmmToken => ({ id: `${symbol}@c`, symbol, contract: 'c', decimals })
const X = token('X')
const Y = token('Y')
const Z = token('Z')

/** A pool with `price` B per A (display units) and liquidity L, no ticks: one infinite range. */
function pool(
  id: number,
  a: ClmmToken,
  b: ClmmToken,
  price: number,
  L: number,
  fee = 0.003,
  ticks: ClmmPool['ticks'] = []
): ClmmPool {
  const raw = (price * 10 ** b.decimals) / 10 ** a.decimals
  const sqrt = Math.sqrt(raw)
  return {
    id,
    a,
    b,
    sqrt,
    tick: Math.floor(Math.log(raw) / Math.log(1.0001)),
    liquidity: L,
    fee,
    ticks,
    reserveA: 0,
    reserveB: 0
  }
}

describe('swapOut', () => {
  it('matches the constant-product result within one range', () => {
    const p = pool(1, X, Y, 2, 1e9, 0)
    // Constant liquidity L = sqrt(x*y) in raw units: x = L/s, y = L*s.
    const s = p.sqrt
    const xRaw = 1e9 / s
    const yRaw = 1e9 * s
    const inRaw = 10 * 1e4
    const expected = (yRaw - (xRaw * yRaw) / (xRaw + inRaw)) / 1e4
    // Paid in whole raw units: rounded down to the 4 decimals.
    expect(swapOut(p, X.id, 10)).toBeCloseTo(Math.floor(expected * 1e4) / 1e4, 9)
  })

  it('takes the fee off the input', () => {
    const free = pool(1, X, Y, 2, 1e12, 0)
    const paid = pool(1, X, Y, 2, 1e12, 0.01)
    expect(swapOut(paid, X.id, 100)).toBeCloseTo(swapOut(free, X.id, 99), 6)
  })

  it('gives less once the price leaves the range and the liquidity there is thinner', () => {
    const base = pool(1, X, Y, 1, 1e8, 0)
    // Half the liquidity drops out just below the current price.
    const thin = { ...base, ticks: [{ tick: base.tick - 10, net: 5e7 }] }
    const big = 1000
    expect(swapOut(thin, X.id, big)).toBeLessThan(swapOut(base, X.id, big))
    // A tiny swap stays inside the range and gets the same.
    expect(swapOut(thin, X.id, 0.001)).toBeCloseTo(swapOut(base, X.id, 0.001), 8)
  })

  it('stops when liquidity runs out', () => {
    const base = pool(1, X, Y, 1, 1e8, 0)
    const edge = { ...base, ticks: [{ tick: base.tick + 5, net: -1e8 }] }
    const a = swapOut(edge, Y.id, 1e6)
    const b = swapOut(edge, Y.id, 2e6)
    expect(a).toBeGreaterThan(0)
    expect(b).toBeCloseTo(a, 6)
  })
})

describe('loops', () => {
  it('finds a mispriced triangle and sizes it', () => {
    // X→Y at 2, Y→Z at 3, Z→X at 0.2: 1 X makes 1.2 X before fees and depth.
    const pools = [pool(1, X, Y, 2, 1e9), pool(2, Y, Z, 3, 1e9), pool(3, Z, X, 0.2, 1e9)]
    const loops = findLoops(pools, [X.id])
    const tri = loops.find((l) => l.pools.length === 3 && l.path[1].id === Y.id)!
    expect(tri.marginal).toBeGreaterThan(1.18)
    const best = bestSize(tri)
    expect(best.profit).toBeGreaterThan(0)
    // Doubling the size past the optimum earns less.
    expect(loopOut(tri, best.amount * 2) - best.amount * 2).toBeLessThan(best.profit)
    // The other direction loses.
    const back = loops.find((l) => l.pools.length === 3 && l.path[1].id === Z.id)!
    expect(back.marginal).toBeLessThan(1)
  })

  it('finds two pools of the same pair at different prices', () => {
    const pools = [pool(1, X, Y, 2, 1e9), pool(2, X, Y, 2.2, 1e9)]
    const loops = findLoops(pools, [X.id])
    expect(loops.some((l) => l.pools.length === 2 && l.marginal > 1)).toBe(true)
    expect(spotRate(pools[0], Y.id)).toBeCloseTo(0.5, 9)
  })

  it('caps the size', () => {
    const pools = [pool(1, X, Y, 2, 1e12), pool(2, X, Y, 2.2, 1e12)]
    const loop = findLoops(pools, [X.id]).find((l) => l.marginal > 1)!
    expect(bestSize(loop, 5).amount).toBeLessThanOrEqual(5)
  })
})

describe('rounding', () => {
  it('pays whole units of a token without decimals', () => {
    const whole = token('W', 0)
    const p = pool(9, X, whole, 0.37, 1e6, 0)
    const out = swapOut(p, X.id, 10)
    expect(Number.isInteger(out)).toBe(true)
    expect(out).toBe(3)
  })
})

describe('fee rounding', () => {
  it('rounds the fee up to a whole unit, so one unit of a token without decimals buys nothing', () => {
    const whole = token('W', 0)
    const p = pool(10, whole, X, 1000, 1e9, 0.01)
    expect(swapOut(p, whole.id, 1)).toBe(0)
    // Five units with a 0.3% fee lose a whole unit to the fee: the same as swapping four fee-free.
    const q = pool(11, whole, X, 1000, 1e12, 0.003)
    const free = pool(11, whole, X, 1000, 1e12, 0)
    expect(swapOut(q, whole.id, 5)).toBeCloseTo(swapOut(free, whole.id, 4), 4)
  })
})
