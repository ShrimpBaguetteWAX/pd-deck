import { describe, expect, it } from 'vitest'

import { binomialPmf, convolve, forecastOpenings, oddsOf } from './chestOdds'
import type { Market, Opening } from './blendEconomy'

import { QUANTUM_CHEST as CHEST, QUANTUM_KEY as KEY } from '@/data/blends'
const A = '10'
const B = '11'

const opening = (withKey: boolean, outcomes: [string, number][]): Opening => ({
  blend: { id: withKey ? 2 : 1 } as Opening['blend'],
  withKey,
  cost: null,
  outcomes: outcomes.map(([templateId, chance]) => ({ templateId, chance }))
})

/** A market with floors only: chest 100, key 50, material A 40, material B 10. */
const market = {
  listings: new Map([
    [CHEST, [{ price: 100 }]],
    [KEY, [{ price: 50 }]],
    [A, [{ price: 40 }]],
    [B, [{ price: 10 }]]
  ]),
  recent: new Map(),
  owned: new Map(),
  templates: new Map(),
  fee: 0
} as unknown as Market

describe('binomialPmf', () => {
  it('sums to one and matches the closed form', () => {
    const pmf = binomialPmf(4, 0.3)
    expect(pmf.reduce((n, p) => n + p, 0)).toBeCloseTo(1, 12)
    expect(pmf[2]).toBeCloseTo(6 * 0.3 ** 2 * 0.7 ** 2, 12)
    expect(binomialPmf(0, 0.5)).toEqual([1])
    expect(binomialPmf(3, 0)).toEqual([1, 0, 0, 0])
    expect(binomialPmf(3, 1)).toEqual([0, 0, 0, 1])
  })

  it('convolves two distributions', () => {
    expect(convolve([0.5, 0.5], [0.5, 0.5])).toEqual([0.25, 0.5, 0.25])
  })
})

describe('forecastOpenings', () => {
  const chest = opening(false, [
    [A, 0.5],
    [B, 0.5]
  ])

  it('normalises odds', () => {
    expect([
      ...oddsOf(
        opening(false, [
          [A, 2],
          [B, 6]
        ])
      ).values()
    ]).toEqual([0.25, 0.75])
  })

  it('values a pull at the listing it replaces, and the rest as surplus', () => {
    // One chest, the bundle buys one A at 40: half the time it is covered.
    const one = forecastOpenings([{ opening: chest, count: 1 }], [{ templateId: A, price: 40 }], market)
    expect(one.cost).toBe(100)
    expect(one.covered).toBeCloseTo(0.5, 12)
    expect(one.saving).toBeCloseTo(20, 12)
    // The B pulled half the time is surplus, sold at 10 after the 7% fees.
    expect(one.surplus).toBeCloseTo(0.5 * 10 * 0.93, 12)
    expect(one.unpriced).toBe(0)

    // Two chests: A is covered unless both pulls are B (1/4). The spare A (1/4 of the time) is surplus.
    const two = forecastOpenings([{ opening: chest, count: 2 }], [{ templateId: A, price: 40 }], market)
    expect(two.covered).toBeCloseTo(0.75, 12)
    expect(two.saving).toBeCloseTo(30, 12)
    expect(two.surplus).toBeCloseTo((0.25 * 40 + 1 * 10) * 0.93, 12)
  })

  it('replaces the dearest listing first and adds up openings of both kinds', () => {
    const keyed = opening(true, [[A, 1]])
    const buys = [
      { templateId: A, price: 30 },
      { templateId: A, price: 50 }
    ]
    const f = forecastOpenings(
      [
        { opening: chest, count: 1 },
        { opening: keyed, count: 1 }
      ],
      buys,
      market
    )
    expect(f.openings).toBe(2)
    expect(f.cost).toBe(100 + 150)
    // The keyed chest always gives one A (worth the 50 listing); the plain one adds the 30 half the time.
    expect(f.covered).toBeCloseTo(1.5, 12)
    expect(f.saving).toBeCloseTo(50 + 0.5 * 30, 12)
  })

  it('reports a missing floor as no cost and unpriced outcomes', () => {
    const noKey = { ...market, listings: new Map([[CHEST, [{ price: 100 }]]]) } as unknown as Market
    const f = forecastOpenings([{ opening: opening(true, [[A, 1]]), count: 3 }], [], noKey)
    expect(f.cost).toBeNull()
    expect(f.unpriced).toBe(1)
    expect(f.surplus).toBe(0)
  })
})
