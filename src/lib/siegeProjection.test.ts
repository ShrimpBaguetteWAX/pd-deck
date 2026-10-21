import { describe, expect, it } from 'vitest'

import { fundingEta, joinsUntil, projectSiege, type ProjectionInput } from './siegeProjection'

const H = 3_600_000
const D = 24 * H

const base = (over: Partial<ProjectionInput> = {}): ProjectionInput => ({
  now: 3 * D,
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
  it('runs to the end time even when the targets are met sooner', () => {
    const p = projectSiege(base({ cumDef: 600_000 }))
    // 400k ATK in 3 days: 2M after 15 days. 600k DEF in 3 days: 2M after 10 days.
    expect(p.defMetAt).toBeCloseTo(10 * D, -3)
    expect(p.close).toBe(15 * D)
  })

  it('scales the others, score and joins, to the end and adds the funder bonus', () => {
    const p = projectSiege(base({ bonus: new Map([['b', 0.15]]) }))
    // Five times the time so far.
    const a = p.field.find((r) => r.account === 'a')!
    const b = p.field.find((r) => r.account === 'b')!
    expect(a.projected).toBeCloseTo(500_000, -2)
    expect(a.projectedJoins).toBe(50)
    expect(b.projected).toBeCloseTo(287_500, -2)
    expect(p.field.some((r) => r.me)).toBe(false)
  })

  it('places you by what your divisions add until the end', () => {
    const mine = [{ id: 1, atk: 50_000, def: 50_000, move: 0, readyAt: 3 * D }]
    const p = projectSiege(base({ mine }))
    // One join now, then one every 4 hours until day 15: 12 days × 6 + 1.
    expect(p.joins).toBe(joinsUntil(mine[0], 14_400, 15 * D))
    expect(p.joins).toBe(73)
    expect(p.added).toBe(p.joins * 100_000)
    expect(p.cost).toBe(p.joins * 25)
    const me = p.field.find((r) => r.me)!
    expect(me.projected).toBe(p.added)
    expect(me.projectedJoins).toBe(p.joins)
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
