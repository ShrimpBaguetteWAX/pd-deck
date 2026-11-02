import { describe, expect, it } from 'vitest'

import type { AssetRef } from '@/data/assets'
import type { Division } from '@/data/game'

import { isCurrent, planRestore, snapshot, type Preset } from './armyPresets'
import type { Kind } from './stats'

const ref = (id: string): AssetRef => ({
  assetId: id,
  templateId: 't',
  schema: 'x',
  name: id,
  rarity: '',
  img: '',
  info: null,
  stats: null
})
const division = (id: number, leader: string, units: [string, Record<string, string>?][]): Division =>
  ({
    id,
    leader: ref(leader),
    units: units.map(([m, g = {}]) => ({
      asset: ref(m),
      gear: Object.fromEntries(Object.entries(g).map(([k, v]) => [k, ref(v)]))
    })),
    slotsMax: 10
  }) as unknown as Division
const empty = (): Record<Kind, AssetRef[]> => ({ warlord: [], mercenary: [], weapon: [], supply: [], creature: [], lavalux: [] })

describe('army presets', () => {
  const army = [division(1, 'w1', [['m1', { weapon: 'g1' }], ['m2']]), division(2, 'w2', [['m3']])]
  const preset: Preset = { id: 'p', name: 'Main', savedAt: 0, divisions: snapshot(army) }

  it('knows when the army stands exactly as saved', () => {
    expect(isCurrent(preset, army)).toBe(true)
    expect(isCurrent(preset, [army[0]])).toBe(false)
  })

  it('keeps matching divisions, takes apart the rest and rebuilds what differs', () => {
    // Division 2 now has m4 instead of m3; division 3 is new.
    const now = [army[0], division(2, 'w2', [['m4']]), division(3, 'w3', [['m3']])]
    const plan = planRestore(preset, now, empty(), () => true)
    expect(plan.keep.map((d) => d.id)).toEqual([1])
    expect(plan.disband.map((d) => d.id).sort()).toEqual([2, 3])
    expect(plan.build).toEqual([{ leader: 'w2', units: [{ merc: 'm3', gear: {} }] }])
  })

  it('leaves divisions on a mission alone and skips what needs their NFTs', () => {
    const now = [division(1, 'w1', [['m3']]), division(2, 'w2', [['m1']])]
    const away = (d: Division) => d.id !== 2
    const plan = planRestore(preset, now, { ...empty(), mercenary: [ref('m2')] }, away)
    expect(plan.locked.map((d) => d.id)).toEqual([2])
    // w2 leads the division out on a mission, and m1 is in it.
    expect(plan.skipped.map((s) => s.division.leader)).toEqual(['w2'])
    expect(plan.build).toEqual([{ leader: 'w1', units: [{ merc: 'm2', gear: {} }] }])
    expect(plan.held.sort()).toEqual(['m1', 'w2'])
  })

  it('says which NFTs are no longer staked', () => {
    const plan = planRestore(preset, [], { ...empty(), warlord: [ref('w1')], mercenary: [ref('m1'), ref('m2')] }, () => true)
    expect(plan.missing.sort()).toEqual(['g1', 'w2'])
    expect(plan.build).toEqual([
      {
        leader: 'w1',
        units: [
          { merc: 'm1', gear: {} },
          { merc: 'm2', gear: {} }
        ]
      }
    ])
  })
})
