import type { AssetRef } from '@/data/assets'
import type { Division } from '@/data/game'

import type { SlotKind } from './bundle'
import { isTokenLoop, meetsRequirements, tlmPerHour, type MissionEconomics } from './loop'
import type { Market } from './market'
import { FAST_MOVE_WEIGHT, MOVE_WEIGHT, planFromDivision, planMissionDivision, type MissionPlan } from './missionDivision'
import { GEAR_KINDS, type Kind } from './stats'

/*
 * The army that earns the most TLM per hour from the missions on offer, built only from what is
 * staked. Rewards are flat per division and per cycle, so the earning of a division on a mission
 * is the mission's net reward over its cycle, and the cycle is shorter the lower the division's
 * move cost. More divisions earn more, up to the player's allowance and the warlords available.
 *
 * Choosing which missions to field, and with which NFTs, is a packing problem. It is searched
 * division by division: field a division for a mission, take its NFTs out of the pool, repeat.
 * Taking the best-paying next division every time can starve a later one (two 200-ATK divisions
 * may leave nothing for a third, where one 200 and two 100s would earn more), so a beam search
 * keeps the few best partial armies at every step instead of one. Two cheaper greedy passes with
 * other rankings (most per mercenary used; most per stat point used) run as well, and the army
 * that earns the most wins. Each division is the smallest that meets its mission (see
 * planMissionDivision), so the strong units stay for the missions that need them. The divisions
 * that exist now are candidates too, kept as they are, so the answer is never worse than leaving
 * the army alone.
 */

export interface OptimizedDivision {
  mission: MissionEconomics
  plan: MissionPlan
  perHour: number
  /** Set when this is one of the existing divisions, kept exactly as it is. */
  existingId?: number
}

export interface ArmyPlan {
  divisions: OptimizedDivision[]
  /** TLM per hour of the new divisions together. */
  perHour: number
  strategy: Strategy
}

export type Strategy = 'per-hour' | 'per-mercenary' | 'per-stat'
export const STRATEGIES: Strategy[] = ['per-hour', 'per-mercenary', 'per-stat']
/** Partial armies kept per step in the beam search (the 'per-hour' pass): wide while that is cheap. */
const beamWidth = (input: OptimizeInput) => {
  const n = input.pool.mercenary.length
  return n <= 20 ? 16 : n <= 40 ? 8 : 4
}
/** Past this much planning time the beam narrows to one, so a huge army still finishes. */
const BEAM_BUDGET_MS = 10_000
/** Hard stop: past this the search keeps what it has (a huge army may get fewer divisions than it could). */
const TOTAL_BUDGET_MS = 40_000
/** Extra passes only run while this much of the budget is left. */
const EXTRA_PASS_MIN_MS = 15_000
/**
 * Grid steps for the division planner. A 5 000 ATK target is then met to within about 6 points
 * (the planner adds a unit when rounding leaves it short), and each solve is several times faster.
 */
const PLANNER_GRID = 800
/**
 * Each mission is planned two ways: the division that uses the least strength (move counts a
 * little), and the fastest one that meets it (move counts a lot). The search keeps whichever
 * leads to the better army: saving strength for later divisions, or cutting this one's cycle.
 */
const MOVE_WEIGHTS = [MOVE_WEIGHT, FAST_MOVE_WEIGHT]

export interface OptimizeInput {
  /** Everything that may be rearranged: the reserve plus the NFTs of the divisions to be disbanded. */
  pool: Record<Kind, AssetRef[]>
  missions: MissionEconomics[]
  market: Market
  forgeLevel: number
  /** Forge slots per gear kind not used by the divisions that stay. */
  slotsFree: Record<SlotKind, number>
  /** New divisions allowed: the allowance minus the divisions that stay. */
  maxDivisions: number
  /** The divisions whose NFTs are in the pool, as they stand: the search may keep any of them as it is. */
  existing?: Division[]
}

export type Progress = { strategy: Strategy; strategyIndex: number; division: number }

interface Node {
  pool: Record<Kind, AssetRef[]>
  slots: Record<SlotKind, number>
  divisions: OptimizedDivision[]
  total: number
}

/** The best token loop a division of these stats can run, or null when no mission pays. */
export function bestLoop(
  d: { atk: number; def: number; move: number },
  missions: MissionEconomics[],
  market: Market
): { mission: MissionEconomics; perHour: number } | null {
  let best: { mission: MissionEconomics; perHour: number } | null = null
  for (const m of missions) {
    if (m.state !== 'active' || !isTokenLoop(m) || !meetsRequirements(m, d.atk, d.def)) continue
    const perHour = tlmPerHour(m, d.move, market)
    if (perHour > 0 && (!best || perHour > best.perHour)) best = { mission: m, perHour }
  }
  return best
}

/** The staked NFTs of some divisions and the reserve, as one pool by kind. */
export function poolOf(free: Record<Kind, AssetRef[]>, divisions: Division[]): Record<Kind, AssetRef[]> {
  const pool: Record<Kind, AssetRef[]> = {
    warlord: [...free.warlord],
    mercenary: [...free.mercenary],
    weapon: [...free.weapon],
    supply: [...free.supply],
    creature: [...free.creature],
    lavalux: [...free.lavalux]
  }
  for (const d of divisions) {
    if (d.leader) pool.warlord.push(d.leader)
    for (const u of d.units) {
      pool.mercenary.push(u.asset)
      for (const k of GEAR_KINDS) if (u.gear[k]) pool[k].push(u.gear[k]!)
    }
  }
  return pool
}

/** Missions worth fielding: active token loops, one per distinct requirement-and-pay. */
export function candidateMissions(missions: MissionEconomics[]): MissionEconomics[] {
  const seen = new Set<string>()
  return missions.filter((m) => {
    if (m.state !== 'active' || !isTokenLoop(m)) return false
    const key = [m.minAtk, m.minDef, m.cooldownBase, m.rewardTlm, m.rewardDef, m.costTlm, m.costDef].join('/')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const without = (pool: Record<Kind, AssetRef[]>, used: Set<string>): Record<Kind, AssetRef[]> => ({
  warlord: pool.warlord.filter((a) => !used.has(a.assetId)),
  mercenary: pool.mercenary.filter((a) => !used.has(a.assetId)),
  weapon: pool.weapon.filter((a) => !used.has(a.assetId)),
  supply: pool.supply.filter((a) => !used.has(a.assetId)),
  creature: pool.creature.filter((a) => !used.has(a.assetId)),
  lavalux: pool.lavalux.filter((a) => !used.has(a.assetId))
})

const usedKeys = (p: MissionPlan) => {
  const b = p.bundle
  return new Set([b.warlord.key, ...b.mercs.map((m) => m.key), ...GEAR_KINDS.flatMap((k) => b.gear[k].map((g) => g.key))])
}

/** How a strategy ranks a candidate division. Higher is better. */
function score(strategy: Strategy, perHour: number, p: MissionPlan): number {
  const b = p.bundle
  switch (strategy) {
    case 'per-hour':
      return perHour
    case 'per-mercenary':
      return perHour / Math.max(1, b.mercs.length)
    case 'per-stat':
      return perHour / Math.max(1, b.atk + b.def)
  }
}

/** The signature of a partial army: which NFTs it uses on which missions, whatever the order. */
const signature = (n: Node) =>
  n.divisions
    .map((d) => d.mission.id + ':' + [...usedKeys(d.plan)].sort().join(','))
    .sort()
    .join('|')

/**
 * Beam search over the next division to field. Width 1 is plain greedy. Partial armies are ranked
 * by `score` summed over their divisions; the answer is the army with the most TLM per hour.
 */
function search(
  input: OptimizeInput,
  strategy: Strategy,
  width: number,
  deadline: number,
  onProgress?: (p: Progress) => void
): ArmyPlan {
  const missions = candidateMissions(input.missions)
  // Missions in order of what they could pay at best (no move at all). With one partial army and
  // the per-hour ranking that lets a step stop early; it is a sensible order for the rest too.
  const ceiling = new Map(missions.map((m) => [m.id, tlmPerHour(m, 0, input.market)]))
  const ordered = [...missions].filter((m) => ceiling.get(m.id)! > 0).sort((a, b) => ceiling.get(b.id)! - ceiling.get(a.id)!)
  const started = Date.now()
  let outOfTime = false
  const start: Node = { pool: input.pool, slots: { ...input.slotsFree }, divisions: [], total: 0 }
  // What a pool could reach at most: the strongest units up to the biggest warlord, plus all gear.
  const reach = (pool: Record<Kind, AssetRef[]>, stat: 'attack' | 'defense') => {
    const slots = Math.max(0, ...pool.warlord.map((w) => w.stats?.slots_max ?? 0))
    const mercs = pool.mercenary
      .map((a) => Number(a.stats?.[stat] ?? 0))
      .sort((a, b) => b - a)
      .slice(0, slots)
    const gear = (['weapon', 'supply', 'creature'] as Kind[]).flatMap((k) =>
      pool[k]
        .map((a) => Number(a.stats?.[stat] ?? 0))
        .sort((a, b) => b - a)
        .slice(0, slots)
    )
    return [...mercs, ...gear].reduce((n, v) => n + v, 0) * 1.7
  }
  // The divisions that exist now, as candidates to keep as they are.
  const keepable = (input.existing ?? [])
    .map((d) => ({ d, plan: planFromDivision(d), loop: bestLoop(d, input.missions, input.market) }))
    .filter(
      (x): x is { d: Division; plan: MissionPlan; loop: { mission: MissionEconomics; perHour: number } } => !!x.plan && !!x.loop
    )
  let frontier: Node[] = [start]
  let best: Node = start
  for (let step = 1; step <= input.maxDivisions && frontier.length; step++) {
    onProgress?.({ strategy, strategyIndex: STRATEGIES.indexOf(strategy), division: step })
    const children: Node[] = []
    const seen = new Set<string>()
    for (const node of frontier) {
      if (!node.pool.warlord.length || !node.pool.mercenary.length) continue
      let bestHere = -Infinity
      // Keeping an existing division as it is, when every NFT of it is still in the pool.
      const inPool = new Set(
        [...node.pool.warlord, ...node.pool.mercenary, ...GEAR_KINDS.flatMap((k) => node.pool[k])].map((a) => a.assetId)
      )
      for (const { d, plan, loop } of keepable) {
        const keys = usedKeys(plan)
        if ([...keys].some((k) => !inPool.has(k))) continue
        const b = plan.bundle
        if ((['weapon', 'supply', 'lavalux'] as SlotKind[]).some((k) => b.gear[k].length > node.slots[k])) continue
        const s = score(strategy, loop.perHour, plan)
        bestHere = Math.max(bestHere, s)
        const slots = { ...node.slots }
        for (const k of ['weapon', 'supply', 'lavalux'] as SlotKind[]) slots[k] -= b.gear[k].length
        const child: Node = {
          pool: without(node.pool, keys),
          slots,
          divisions: [...node.divisions, { mission: loop.mission, plan, perHour: loop.perHour, existingId: d.id }],
          total: node.total + s
        }
        const sig = signature(child)
        if (seen.has(sig)) continue
        seen.add(sig)
        children.push(child)
      }
      const maxAtk = reach(node.pool, 'attack')
      const maxDef = reach(node.pool, 'defense')
      for (const m of ordered) {
        if (Date.now() > deadline) {
          outOfTime = true
          break
        }
        // Nothing this mission could pay would beat what this army already found for this step.
        if (strategy === 'per-hour' && width === 1 && ceiling.get(m.id)! <= bestHere) break
        // Out of reach for what is left: no need to solve it.
        if (m.minAtk > maxAtk || m.minDef > maxDef) continue
        // A mission with no requirement takes the smallest division there is.
        const target = m.minAtk > 0 || m.minDef > 0 ? { atk: m.minAtk, def: m.minDef } : { atk: 1, def: 0 }
        for (const moveWeight of MOVE_WEIGHTS) {
          const plan = planMissionDivision(node.pool, target, input.forgeLevel, node.slots, { moveWeight, gridMax: PLANNER_GRID })
          if (!plan) break
          const perHour = tlmPerHour(m, plan.bundle.move, input.market)
          if (perHour <= 0) break
          const s = score(strategy, perHour, plan)
          bestHere = Math.max(bestHere, s)
          const slots = { ...node.slots }
          for (const k of ['weapon', 'supply', 'lavalux'] as SlotKind[]) slots[k] -= plan.bundle.gear[k].length
          const child: Node = {
            pool: without(node.pool, usedKeys(plan)),
            slots,
            divisions: [...node.divisions, { mission: m, plan, perHour }],
            total: node.total + s
          }
          // The same divisions reached in another order (or by both weights) are the same army.
          const sig = signature(child)
          if (seen.has(sig)) continue
          seen.add(sig)
          children.push(child)
        }
      }
    }
    if (!children.length) break
    children.sort((x, y) => y.total - x.total)
    const keep = Date.now() - started > BEAM_BUDGET_MS ? 1 : width
    frontier = children.slice(0, keep)
    for (const c of frontier) if (earning(c) > earning(best)) best = c
    if (outOfTime) break
  }
  return { divisions: best.divisions, perHour: earning(best), strategy }
}

const earning = (n: Node) => n.divisions.reduce((sum, d) => sum + d.perHour, 0)

/** The army plan that earns the most, over the strategies. */
export function optimizeArmy(input: OptimizeInput, onProgress?: (p: Progress) => void): ArmyPlan {
  const started = Date.now()
  const deadline = started + TOTAL_BUDGET_MS
  // Leaving every existing division as it is: the floor any answer has to beat.
  const asIs: OptimizedDivision[] = []
  for (const d of input.existing ?? []) {
    const plan = planFromDivision(d)
    const loop = bestLoop(d, input.missions, input.market)
    if (plan && loop) asIs.push({ mission: loop.mission, plan, perHour: loop.perHour, existingId: d.id })
  }
  let best: ArmyPlan =
    asIs.length && asIs.length <= input.maxDivisions
      ? { divisions: asIs, perHour: asIs.reduce((n, d) => n + d.perHour, 0), strategy: 'per-hour' }
      : { divisions: [], perHour: 0, strategy: 'per-hour' }
  for (const strategy of STRATEGIES) {
    if (deadline - Date.now() < EXTRA_PASS_MIN_MS && strategy !== 'per-hour') break
    const plan = search(input, strategy, strategy === 'per-hour' ? beamWidth(input) : 1, deadline, onProgress)
    if (plan.perHour > best.perHour + 1e-9) best = plan
  }
  return best
}
