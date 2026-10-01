import { describe, expect, it } from 'vitest'

import { CATEGORY } from '@/chain/config'
import type { AssetRef } from '@/data/assets'
import type { MissionRow } from '@/data/types'

import { bestLoop, candidateMissions, optimizeArmy } from './armyOptimizer'
import type { MissionEconomics } from './loop'
import { fallbackMarket } from './market'
import type { Kind } from './stats'

let next = 1
function nft(category: number, s: Partial<{ atk: number; def: number; move: number; slots: number }>, name = ''): AssetRef {
  const id = String(next++)
  return {
    assetId: id,
    templateId: `t${id}`,
    schema: 'x',
    name: name || `#${id}`,
    rarity: 'common',
    img: '',
    info: null,
    stats: {
      template_id: next,
      category,
      attack: s.atk ?? 0,
      defense: s.def ?? 0,
      movecost: s.move ?? 0,
      movecost_reduction: 0,
      slots_max: s.slots ?? 0,
      attack_mult_bp: 10000,
      defense_mult_bp: 10000,
      movecost_mult_bp: 10000,
      min_forge_level: 0,
      image: ''
    }
  }
}

function mission(id: number, minAtk: number, rewardTlm: number, cooldownBase = 3600): MissionEconomics {
  return {
    mission: { mission_id: id } as unknown as MissionRow,
    id,
    meta: {},
    title: `M${id}`,
    planet: 'x',
    image: '',
    lore: '',
    state: 'active',
    startAt: 0,
    endAt: 0,
    minAtk,
    minDef: 0,
    cooldownBase,
    rewardTlm,
    rewardDef: 0,
    rewardShards: 0,
    rewardNft: null,
    costTlm: 0,
    costDef: 0,
    maxDivisions: 0,
    joined: 0
  } as unknown as MissionEconomics
}

const empty = (): Record<Kind, AssetRef[]> => ({ warlord: [], mercenary: [], weapon: [], supply: [], creature: [], lavalux: [] })
const market = fallbackMarket()
const noSlots = { weapon: 0, supply: 0, lavalux: 0 }

describe('optimizeArmy', () => {
  it('fields several small divisions when that earns more than one big one', () => {
    const pool = empty()
    for (let i = 0; i < 3; i++) pool.warlord.push(nft(CATEGORY.WARLORD, { slots: 6 }))
    for (let i = 0; i < 6; i++) pool.mercenary.push(nft(CATEGORY.MERCENARY, { atk: 100, move: 10 }))
    // One 600 ATK mission pays 50 TLM an hour; a 100 ATK mission pays 30: three of those beat it.
    const missions = [mission(1, 600, 50), mission(2, 100, 30)]
    const plan = optimizeArmy({ pool, missions, market, forgeLevel: 0, slotsFree: noSlots, maxDivisions: 3 })
    expect(plan.divisions).toHaveLength(3)
    expect(plan.divisions.every((d) => d.mission.id === 2)).toBe(true)
    expect(plan.perHour).toBeGreaterThan(50)
    // Every NFT is used at most once.
    const ids = plan.divisions.flatMap((d) => {
      const b = d.plan.bundle
      return [b.warlord.key, ...b.mercs.map((m) => m.key), ...b.gear.weapon.map((g) => g.key)]
    })
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('respects the division allowance and stops when warlords run out', () => {
    const pool = empty()
    pool.warlord.push(nft(CATEGORY.WARLORD, { slots: 3 }), nft(CATEGORY.WARLORD, { slots: 3 }))
    for (let i = 0; i < 6; i++) pool.mercenary.push(nft(CATEGORY.MERCENARY, { atk: 50, move: 10 }))
    const missions = [mission(1, 50, 10)]
    expect(optimizeArmy({ pool, missions, market, forgeLevel: 0, slotsFree: noSlots, maxDivisions: 1 }).divisions).toHaveLength(1)
    expect(optimizeArmy({ pool, missions, market, forgeLevel: 0, slotsFree: noSlots, maxDivisions: 5 }).divisions).toHaveLength(2)
  })

  it('prefers the mission that pays more per hour for the same division', () => {
    const pool = empty()
    pool.warlord.push(nft(CATEGORY.WARLORD, { slots: 2 }))
    pool.mercenary.push(nft(CATEGORY.MERCENARY, { atk: 200, move: 10 }))
    const missions = [mission(1, 100, 10), mission(2, 100, 20)]
    const plan = optimizeArmy({ pool, missions, market, forgeLevel: 0, slotsFree: noSlots, maxDivisions: 3 })
    expect(plan.divisions[0].mission.id).toBe(2)
    expect(bestLoop({ atk: 200, def: 0, move: 10 }, missions, market)?.mission.id).toBe(2)
  })

  it('keeps one candidate per distinct requirement and pay', () => {
    expect(candidateMissions([mission(1, 100, 10), mission(2, 100, 10), mission(3, 200, 10)])).toHaveLength(2)
  })
})

describe('beam search', () => {
  it('does not starve a later division by taking the best-paying next one twice', () => {
    // Two strong and four weak mercenaries, three warlords. A 200 ATK mission pays 10 an hour, a
    // 100 ATK mission 6. Greedy takes 200 twice (strong + weak×3, then nothing is left for a third
    // division); one 200 and two 100s earn more.
    const pool = empty()
    for (let i = 0; i < 3; i++) pool.warlord.push(nft(CATEGORY.WARLORD, { slots: 6 }))
    pool.mercenary.push(nft(CATEGORY.MERCENARY, { atk: 110, move: 10 }), nft(CATEGORY.MERCENARY, { atk: 110, move: 10 }))
    for (let i = 0; i < 4; i++) pool.mercenary.push(nft(CATEGORY.MERCENARY, { atk: 50, move: 10 }))
    const missions = [mission(1, 200, 10, 3600), mission(2, 100, 6, 3600)]
    const plan = optimizeArmy({ pool, missions, market, forgeLevel: 0, slotsFree: noSlots, maxDivisions: 3 })
    expect(plan.divisions).toHaveLength(3)
    expect(plan.divisions.filter((d) => d.mission.id === 1)).toHaveLength(1)
  })
})

describe('existing divisions', () => {
  it('keeps a division as it is when nothing planned beats it, and never proposes less', () => {
    // A single mercenary with a weapon reaches the 200 ATK mission; the planner alone would pick
    // the same NFTs, so the answer is the existing division, kept, and the plan is never worse.
    const warlord = nft(CATEGORY.WARLORD, { slots: 1 })
    const merc = nft(CATEGORY.MERCENARY, { atk: 150, move: 10 })
    const weapon = nft(CATEGORY.WEAPON, { atk: 60 })
    const division = {
      id: 7,
      leader: warlord,
      units: [{ asset: merc, gear: { weapon } }],
      slotsMax: 1,
      atk: 210,
      def: 0,
      move: 10,
      lock: null
    } as unknown as import('@/data/game').Division
    const pool = empty()
    pool.warlord.push(warlord)
    pool.mercenary.push(merc)
    pool.weapon.push(weapon)
    const missions = [mission(1, 200, 10), mission(2, 100, 6)]
    const plan = optimizeArmy({
      pool,
      missions,
      market,
      forgeLevel: 0,
      slotsFree: { weapon: 1, supply: 0, lavalux: 0 },
      maxDivisions: 3,
      existing: [division]
    })
    expect(plan.divisions).toHaveLength(1)
    expect(plan.divisions[0].existingId).toBe(7)
    expect(plan.perHour).toBeCloseTo(bestLoop(division, missions, market)!.perHour, 6)
  })
})
