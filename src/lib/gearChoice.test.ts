import { describe, expect, it } from 'vitest'

import { CATEGORY } from '@/chain/config'
import type { AssetRef } from '@/data/assets'

import { evaluate, type Candidate, type WarlordOption } from './bundle'
import { planMissionDivision } from './missionDivision'
import type { Kind } from './stats'

let next = 1
type S = Partial<{ atk: number; def: number; move: number; slots: number; cut: number; am: number; dm: number; mm: number }>
function nft(category: number, s: S, name = ''): AssetRef {
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
      movecost_reduction: s.cut ?? 0,
      slots_max: s.slots ?? 0,
      attack_mult_bp: s.am ?? 10000,
      defense_mult_bp: s.dm ?? 10000,
      movecost_mult_bp: s.mm ?? 10000,
      min_forge_level: 0,
      image: ''
    }
  }
}
const empty = (): Record<Kind, AssetRef[]> => ({ warlord: [], mercenary: [], weapon: [], supply: [], creature: [], lavalux: [] })

const c = (key: string, kind: Candidate['kind'], v: Partial<Candidate>): Candidate => ({
  key,
  kind,
  group: key,
  atk: 0,
  def: 0,
  move: 0,
  moveReduction: 0,
  minLevel: 0,
  cost: 0,
  ...v
})
const warlord: WarlordOption = { key: 'w', slots: 5, minLevel: 0, cost: 0 }

describe('evaluate', () => {
  it('puts the strongest Lava Lux on the unit that is strongest with its gear', () => {
    const b = evaluate({
      warlord,
      mercs: [c('a', 'mercenary', { atk: 100 }), c('b', 'mercenary', { atk: 90 })],
      gear: {
        weapon: [],
        supply: [],
        // The big creature goes to the stronger mercenary; the shined Lava Lux follows the strongest unit.
        creature: [c('pet', 'creature', { atk: 60 }), c('pup', 'creature', { atk: 1 })],
        lavalux: [
          c('plain', 'lavalux', { atkMult: 1.16, defMult: 1.16, moveMult: 1.7 }),
          c('shined', 'lavalux', { atkMult: 1.28, defMult: 1.28, moveMult: 1.6 })
        ]
      }
    })
    const on = (key: string) => b.units.find((u) => u.merc.key === key)!
    expect(on('a').gear.creature?.key).toBe('pet')
    expect(on('a').gear.lavalux?.key).toBe('shined')
  })
})

describe('planMissionDivision', () => {
  it('leads a slow division with the warlord whose shine cancels its move', () => {
    const free = empty()
    free.warlord.push(nft(CATEGORY.WARLORD, { slots: 3 }, 'plain'), nft(CATEGORY.WARLORD, { slots: 3, cut: 28 }, 'shined'))
    free.mercenary.push(nft(CATEGORY.MERCENARY, { atk: 60, move: 20 }), nft(CATEGORY.MERCENARY, { atk: 60, move: 20 }))
    const plan = planMissionDivision(free, { atk: 120, def: 0 }, 0, { weapon: 0, supply: 0, lavalux: 0 })!
    expect(plan.assets.get(plan.bundle.warlord.key)!.name).toBe('shined')
    expect(plan.bundle.move).toBe(12)
  })
})
