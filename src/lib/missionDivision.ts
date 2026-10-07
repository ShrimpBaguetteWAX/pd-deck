import type { AssetRef } from '@/data/assets'

import type { Division } from '@/data/game'

import { evaluate, solveBundle, type Bundle, type Candidate, type SlotKind, type WarlordOption } from './bundle'
import { GEAR_KINDS, kindOf, type Kind } from './stats'

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
export const MOVE_WEIGHT = 3
/** Weighted like this, move matters more than strength: the fastest division that meets the mission. */
export const FAST_MOVE_WEIGHT = 30
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
  slotsFree: Record<SlotKind, number>,
  /** mercPenalty: extra cost per mercenary, so that fewer, stronger units (and gear) are preferred. */
  /**
   * mercPenalty: extra cost per mercenary, so that fewer, stronger units (and gear) are preferred.
   * costOf: the caller's own cost for a unit (given the usual one), e.g. what it would earn elsewhere.
   * maxMove: the division's move cost may not exceed this (null when no division fits under it).
   */
  options: {
    moveWeight?: number
    gridMax?: number
    mercPenalty?: number
    costOf?: (a: AssetRef, usual: number) => number
    maxMove?: number
  } = {}
): MissionPlan | null {
  const moveWeight = options.moveWeight ?? MOVE_WEIGHT
  const mercPenalty = options.mercPenalty ?? 0
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
      const usual = lava
        ? // A multiplier's worth, in stat points on a typical line.
          (lava.atkMult - 1 + lava.defMult - 1) * 100 + (lava.moveMult - 1) * 20 * moveWeight
        : Math.max(0.1, atk + def + moveWeight * (move - moveReduction) + (kind === 'mercenary' ? mercPenalty : 0))
      const cost = options.costOf ? Math.max(0.1, options.costOf(a, usual)) : usual
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
    ...(options.gridMax ? { gridMax: options.gridMax } : {}),
    ...(options.maxMove ? { maxMove: options.maxMove } : {}),
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

/** A staked NFT as a solver candidate (cost 0: nothing is bought), or null when it has no stats. */
function candidateOf(a: AssetRef): Candidate | null {
  const st = a.stats
  const kind = kindOf(st)
  if (!st || !kind || kind === 'warlord') return null
  const lava = kind === 'lavalux'
  return {
    key: a.assetId,
    kind,
    group: a.templateId,
    atk: Number(st.attack || 0),
    def: Number(st.defense || 0),
    move: Number(st.movecost || 0),
    moveReduction: Number(st.movecost_reduction || 0),
    ...(lava
      ? {
          atkMult: Number(st.attack_mult_bp || 10000) / 10000,
          defMult: Number(st.defense_mult_bp || 10000) / 10000,
          moveMult: Number(st.movecost_mult_bp || 10000) / 10000
        }
      : {}),
    minLevel: Number(st.min_forge_level || 0),
    cost: 0
  }
}

/**
 * A division exactly as it stands now, as a plan: so the army search can keep it as it is instead
 * of taking it apart. Null when it has no warlord or no mercenaries.
 */
export function planFromDivision(d: Division): MissionPlan | null {
  if (!d.leader || !d.units.length) return null
  const assets = new Map<string, AssetRef>()
  assets.set(d.leader.assetId, d.leader)
  const mercs: Candidate[] = []
  const gear: Bundle['gear'] = { weapon: [], supply: [], creature: [], lavalux: [] }
  for (const u of d.units) {
    const merc = candidateOf(u.asset)
    if (!merc) return null
    assets.set(u.asset.assetId, u.asset)
    mercs.push(merc)
    for (const k of GEAR_KINDS) {
      const g = u.gear[k]
      if (!g) continue
      const c = candidateOf(g)
      if (!c) return null
      assets.set(g.assetId, g)
      gear[k].push(c)
    }
  }
  const warlord: WarlordOption = {
    key: d.leader.assetId,
    slots: d.slotsMax,
    minLevel: Number(d.leader.stats?.min_forge_level || 0),
    cost: 0
  }
  const ev = evaluate({ warlord, mercs, gear })
  const bundle: Bundle = {
    warlord,
    mercs,
    gear,
    ...ev,
    cost: 0,
    nftCost: 0,
    slotCost: 0,
    forgeCost: 0,
    level: 0,
    slotsBought: { weapon: [], supply: [], lavalux: [] }
  }
  return { bundle, assets }
}
