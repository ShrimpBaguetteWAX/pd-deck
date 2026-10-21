import { describe, expect, it } from 'vitest'

import { fundingEta, joinsUntil, projectSiege, type ProjectionInput } from './siegeProjection'

const H = 3_600_000
const D = 24 * H

const base = (over: Partial<ProjectionInput> = {}): ProjectionInput => ({
  now: 2 * D,
  startAt: 0,
  endAt: 15 * D,
  cumAtk: 400_000,
  cumDef: 400_000,
  targetAtk: 2_000_000,
  targetDef: 2_000_000,
  cooldownBase: 14_400,
  entry: 25,
  board: [
    { account: 'a', score: 100_000, joins: 10 },
    { account: 'b', score: 50_000, joins: 5 }
  ],
  bonus: new Map(),
  mine: [],
  me: 'me',
  ...over
})

describe('projectSiege', () => {
  it('closes when the slower target is met at the pace since launch', () => {
    const p = projectSiege(base({ cumDef: 200_000 }))
    // 400k ATK in 2 days: 2M after 10 days. 200k DEF in 2 days: 2M after 20 days, past the 15-day timer.
    expect(p.atkMetAt).toBeCloseTo(10 * D, -3)
    expect(p.closeWithout).toBe(15 * D)
  })

  it('scales the others to the close and adds the funder bonus', () => {
    const p = projectSiege(base({ bonus: new Map([['b', 0.15]]) }))
    // Close at day 10: five times the time so far.
    expect(p.close).toBeCloseTo(10 * D, -3)
    expect(p.field.find((r) => r.account === 'a')!.projected).toBeCloseTo(500_000, -2)
    expect(p.field.find((r) => r.account === 'b')!.projected).toBeCloseTo(287_500, -2)
    expect(p.field.some((r) => r.me)).toBe(false)
  })

  it('places you by what your divisions add, and brings the close forward', () => {
    const mine = [{ id: 1, atk: 50_000, def: 50_000, move: 0, readyAt: 2 * D }]
    const p = projectSiege(base({ mine }))
    expect(p.close).toBeLessThan(p.closeWithout)
    // One join now, then one every 4 hours until the close.
    expect(p.joins).toBe(joinsUntil(mine[0], 14_400, p.close))
    expect(p.added).toBe(p.joins * 100_000)
    expect(p.cost).toBe(p.joins * 25)
    const me = p.field.find((r) => r.me)!
    expect(me.projected).toBe(p.added)
    expect(me.rank).toBe(p.field.filter((r) => r.projected > me.projected).length + 1)
  })

  it('counts a division only from when it is back', () => {
    const d = { id: 1, atk: 1000, def: 1000, move: 0, readyAt: 5 * H }
    expect(joinsUntil(d, 14_400, 5 * H)).toBe(0)
    expect(joinsUntil(d, 14_400, 5 * H + 1)).toBe(1)
    expect(joinsUntil(d, 14_400, 13 * H + 1)).toBe(3)
  })
})

describe('fundingEta', () => {
  it('extends the pace since the first contribution', () => {
    expect(fundingEta(100, 1000, 0, 10 * D)).toBeCloseTo(100 * D, -3)
    expect(fundingEta(1000, 1000, 0, 5)).toBe(5)
    expect(fundingEta(0, 1000, null, 5)).toBeNull()
  })
})
