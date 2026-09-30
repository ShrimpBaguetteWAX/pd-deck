import type { AssetRef } from '@/data/assets'

import { solveBundle, type Bundle, type Candidate, type SlotKind, type WarlordOption } from './bundle'
import { kindOf, type Kind } from './stats'

/*
 * The division for one mission, built only from the reserve (staked NFTs in no division).
 *
 * Rewards are flat per division, so any division that meets the requirement earns the same. The
 * best one therefore uses up as little of the reserve as it can: the weakest units that still reach
 * the target, so the strong ones stay free for harder missions, and a low move cost, since every
 * move point adds 10 s to the mission lock. The bundle solver does the search; instead of WAX, each
 * NFT "costs" the strength it ties up. Nothing is bought: no Forge slots, no Forge levels.
 */

/** One move point costs as much as this many stat points (it lengthens every mission cycle). */
const MOVE_WEIGHT = 3
/** A bigger warlord is kept for bigger missions, when a smaller one fits. */
const WARLORD_SLOT_WEIGHT = 2

export interface MissionPlan {
  bundle: Bundle
  /** Candidate key → the staked NFT. */
  assets: Map<string, AssetRef>
}

export function planMissionDivision(
  free: Record<Kind, AssetRef[]>,
  target: { atk: number; def: number },
  forgeLevel: number,
  /** Forge slots still free per gear kind (creatures need none). */
  slotsFree: Record<SlotKind, number>
): MissionPlan | null {
  const assets = new Map<string, AssetRef>()
  const warlords: WarlordOption[] = []
  const items: Candidate[] = []

  for (const list of Object.values(free))
    for (const a of list) {
      const st = a.stats
      const kind = kindOf(st)
      if (!st || !kind) continue
      const minLevel = Number(st.min_forge_level || 0)
      // Only what works at today's Forge level: nothing gets upgraded here.
      if (minLevel > forgeLevel) continue
      const key = a.assetId
      if (kind === 'warlord') {
        if (st.slots_max > 0) {
          assets.set(key, a)
          warlords.push({ key, slots: Number(st.slots_max), minLevel, cost: Number(st.slots_max) * WARLORD_SLOT_WEIGHT })
        }
        continue
      }
      const atk = Number(st.attack || 0)
      const def = Number(st.defense || 0)
      const move = Number(st.movecost || 0)
      const moveReduction = Number(st.movecost_reduction || 0)
      const lava =
        kind === 'lavalux'
          ? {
              atkMult: Number(st.attack_mult_bp || 10000) / 10000,
              defMult: Number(st.defense_mult_bp || 10000) / 10000,
              moveMult: Number(st.movecost_mult_bp || 10000) / 10000
            }
          : null
      const cost = lava
        ? // A multiplier's worth, in stat points on a typical line.
          (lava.atkMult - 1 + lava.defMult - 1) * 100 + (lava.moveMult - 1) * 20 * MOVE_WEIGHT
        : Math.max(0.1, atk + def + MOVE_WEIGHT * (move - moveReduction))
      assets.set(key, a)
      items.push({
        key,
        kind: kind as Candidate['kind'],
        group: a.templateId,
        atk,
        def,
        move,
        moveReduction,
        ...(lava ?? {}),
        minLevel,
        cost
      })
    }

  if (!warlords.length || !items.some((i) => i.kind === 'mercenary')) return null
  const levels = [0, 0, 0, 0, 0, 0].map((_, L) => (L === forgeLevel ? 0 : Infinity))
  const bundle = solveBundle({
    atk: target.atk,
    def: target.def,
    warlords,
    items,
    economy: {
      forgeLevel,
      levelWax: levels,
      levelTlm: levels,
      slots: {
        weapon: { free: Math.max(0, slotsFree.weapon), offers: [] },
        supply: { free: Math.max(0, slotsFree.supply), offers: [] },
        lavalux: { free: Math.max(0, slotsFree.lavalux), offers: [] }
      }
    }
  })
  return bundle ? { bundle, assets } : null
}
