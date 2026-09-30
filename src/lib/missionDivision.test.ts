import { describe, expect, it } from 'vitest'

import { CATEGORY } from '@/chain/config'
import type { AssetRef } from '@/data/assets'

import { planMissionDivision } from './missionDivision'
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

const empty = (): Record<Kind, AssetRef[]> => ({ warlord: [], mercenary: [], weapon: [], supply: [], creature: [], lavalux: [] })
const noSlots = { weapon: 0, supply: 0, lavalux: 0 }

describe('planMissionDivision', () => {
  it('uses the weakest mercenaries that reach the target and the smallest warlord that fits', () => {
    const free = empty()
    free.warlord.push(nft(CATEGORY.WARLORD, { slots: 5 }, 'big'), nft(CATEGORY.WARLORD, { slots: 2 }, 'small'))
    free.mercenary.push(
      nft(CATEGORY.MERCENARY, { atk: 300, def: 300, move: 50 }, 'hero'),
      nft(CATEGORY.MERCENARY, { atk: 60, def: 40, move: 20 }, 'a'),
      nft(CATEGORY.MERCENARY, { atk: 55, def: 40, move: 20 }, 'b'),
      nft(CATEGORY.MERCENARY, { atk: 20, def: 20, move: 20 }, 'c')
    )
    const plan = planMissionDivision(free, { atk: 110, def: 0 }, 0, noSlots)!
    const names = plan.bundle.mercs.map((m) => plan.assets.get(m.key)!.name).sort()
    expect(names).toEqual(['a', 'b'])
    expect(plan.assets.get(plan.bundle.warlord.key)!.name).toBe('small')
    expect(plan.bundle.atk).toBeGreaterThanOrEqual(110)
  })

  it('prefers a low move cost when strength is equal', () => {
    const free = empty()
    free.warlord.push(nft(CATEGORY.WARLORD, { slots: 1 }))
    free.mercenary.push(
      nft(CATEGORY.MERCENARY, { atk: 50, def: 0, move: 60 }, 'slow'),
      nft(CATEGORY.MERCENARY, { atk: 50, def: 0, move: 10 }, 'fast')
    )
    const plan = planMissionDivision(free, { atk: 50, def: 0 }, 0, noSlots)!
    expect(plan.assets.get(plan.bundle.mercs[0].key)!.name).toBe('fast')
  })

  it('returns nothing without a free warlord or when the reserve falls short', () => {
    const free = empty()
    free.mercenary.push(nft(CATEGORY.MERCENARY, { atk: 500 }))
    expect(planMissionDivision(free, { atk: 10, def: 0 }, 0, noSlots)).toBeNull()
    free.warlord.push(nft(CATEGORY.WARLORD, { slots: 3 }))
    expect(planMissionDivision(free, { atk: 600, def: 0 }, 0, noSlots)).toBeNull()
  })
})
