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
  return n <= 60 ? 12 : n <= 120 ? 6 : 3
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
 * Each mission is planned four ways: the division that uses the least strength (move counts a
 * little), the fastest one that meets it (move counts a lot), the one with the fewest mercenaries,
 * and the one made of the units worth the least elsewhere (see opportunityCost). The search keeps
 * whichever leads to the better army.
 */
type Variant = { moveWeight: number; mercPenalty?: number; costOf?: (a: AssetRef, usual: number) => number }
const VARIANTS: Variant[] = [
  { moveWeight: MOVE_WEIGHT },
  { moveWeight: FAST_MOVE_WEIGHT },
  // Fewest mercenaries: strong units and gear, which keeps warlord slots and troops for other divisions.
  { moveWeight: MOVE_WEIGHT, mercPenalty: 1000 }
]
/** One hour of what a unit could earn elsewhere counts as this many strength points. */
const OPPORTUNITY_WEIGHT = 100
/** Under a move cap (alignMove), move barely matters: the division fills up to the cap with the weakest units. */
const ALIGNED_MOVE_WEIGHT = 0.2

/**
 * The fourth way to plan a division: every unit costs what it could earn on its own (a mercenary
 * alone on the best mission it reaches; a weapon by how much it lifts the best single mercenary),
 * so the division is filled with the units that are worth the least anywhere else. The strength
 * cost stays as a tie-break.
 */
function opportunityCost(input: OptimizeInput, missions: MissionEconomics[]): Variant['costOf'] {
  const rate = (atk: number, def: number, move: number) => {
    let r = 0
    for (const m of missions) {
      if (!meetsRequirements(m, atk, def)) continue
      const v = tlmPerHour(m, move, input.market)
      if (v > r) r = v
    }
    return r
  }
  const stat = (a: AssetRef) => ({
    atk: Number(a.stats?.attack ?? 0),
    def: Number(a.stats?.defense ?? 0),
    move: Number(a.stats?.movecost ?? 0)
  })
  const alone = new Map(input.pool.mercenary.map((m) => [m.assetId, rate(stat(m).atk, stat(m).def, stat(m).move)]))
  const value = new Map<string, number>(alone)
  for (const w of input.pool.weapon) {
    const ws = stat(w)
    let gain = 0
    for (const m of input.pool.mercenary) {
      const ms = stat(m)
      gain = Math.max(gain, rate(ms.atk + ws.atk, ms.def + ws.def, ms.move) - (alone.get(m.assetId) ?? 0))
    }
    value.set(w.assetId, gain)
  }
  return (a, usual) => (value.has(a.assetId) ? OPPORTUNITY_WEIGHT * value.get(a.assetId)! + usual / 100 : usual)
}

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
  /**
   * Divisions on missions of the same length are claimed and sent out again together, so they all
   * run at the pace of the slowest of them: the army is valued that way, a later division may not
   * be slower than the slowest already fielded for that length, and under that cap move hardly
   * counts, so it ends up close to it. Their move costs come out similar and they return together.
   */
  alignMove?: boolean
}

export type Progress = { strategy: Strategy; strategyIndex: number; division: number }

interface Node {
  pool: Record<Kind, AssetRef[]>
  slots: Record<SlotKind, number>
  divisions: OptimizedDivision[]
  total: number
  /** total plus what the rest of the pool could still earn: what the beam ranks by. */
  rank: number
}

/**
 * An optimistic guess at what a pool can still earn: for every division still allowed, the best
 * rate one remaining mercenary could earn alone (with a remaining weapon, while weapon slots
 * last), each mercenary and weapon counted once. It is the same guess for every branch at the same
 * depth except through what the branch has used up, which is exactly what the ranking needs to
 * see: a division that eats the strong single units or the weapons leaves less for the rest.
 */
function potential(node: Node, input: OptimizeInput, missions: MissionEconomics[]): number {
  const left = Math.min(input.maxDivisions - node.divisions.length, node.pool.warlord.length, node.pool.mercenary.length)
  if (left <= 0) return 0
  const weapons = node.pool.weapon
    .map((w) => ({ atk: Number(w.stats?.attack ?? 0), def: Number(w.stats?.defense ?? 0) }))
    .sort((x, y) => y.atk + y.def - (x.atk + x.def))
  const weaponSlots = Math.min(node.slots.weapon, weapons.length)
  const best = weapons[0] ?? { atk: 0, def: 0 }
  const rate = (atk: number, def: number, move: number) => {
    let r = 0
    for (const mission of missions) {
      if (!meetsRequirements(mission, atk, def)) continue
      const v = tlmPerHour(mission, move, input.market)
      if (v > r) r = v
    }
    return r
  }
  const singles = node.pool.mercenary.map((m) => {
    const atk = Number(m.stats?.attack ?? 0)
    const def = Number(m.stats?.defense ?? 0)
    const move = Number(m.stats?.movecost ?? 0)
    const alone = rate(atk, def, move)
    return { alone, armed: weaponSlots > 0 ? Math.max(alone, rate(atk + best.atk, def + best.def, move)) : alone }
  })
  // The best few mercenaries, one per open division; the weapon goes to those it helps most, at most once per slot.
  singles.sort((x, y) => y.armed - x.armed)
  const chosen = singles.slice(0, left)
  const gains = chosen.map((c) => c.armed - c.alone).sort((x, y) => y - x)
  const armedGain = gains.slice(0, weaponSlots).reduce((n, g) => n + g, 0)
  return chosen.reduce((n, c) => n + c.alone, 0) + armedGain
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
  const variants: Variant[] = [...VARIANTS, { moveWeight: MOVE_WEIGHT, costOf: opportunityCost(input, ordered) }]
  const start: Node = { pool: input.pool, slots: { ...input.slotsFree }, divisions: [], total: 0, rank: 0 }
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
        const divisions = [...node.divisions, { mission: loop.mission, plan, perHour: loop.perHour, existingId: d.id }]
        const child: Node = {
          pool: without(node.pool, keys),
          slots,
          divisions,
          total: input.alignMove
            ? valued(divisions, input).reduce((n, x) => n + score(strategy, x.perHour, x.plan), 0)
            : node.total + s,
          rank: 0
        }
        child.rank = child.total + (strategy === 'per-hour' ? potential(child, input, ordered) : 0)
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
        // Aligning: the slowest division already fielded for a mission of this length caps this one.
        const peers = input.alignMove ? node.divisions.filter((d) => d.mission.cooldownBase === m.cooldownBase) : []
        const cap = peers.length ? Math.max(...peers.map((d) => d.plan.bundle.move)) : undefined
        for (const variant of variants) {
          const options =
            cap !== undefined
              ? { ...variant, moveWeight: ALIGNED_MOVE_WEIGHT, maxMove: cap, gridMax: PLANNER_GRID }
              : { ...variant, gridMax: PLANNER_GRID }
          const plan = planMissionDivision(node.pool, target, input.forgeLevel, node.slots, options)
          if (!plan) break
          const perHour = tlmPerHour(m, plan.bundle.move, input.market)
          if (perHour <= 0) break
          const s = score(strategy, perHour, plan)
          bestHere = Math.max(bestHere, s)
          const slots = { ...node.slots }
          for (const k of ['weapon', 'supply', 'lavalux'] as SlotKind[]) slots[k] -= plan.bundle.gear[k].length
          const divisions = [...node.divisions, { mission: m, plan, perHour }]
          const child: Node = {
            pool: without(node.pool, usedKeys(plan)),
            slots,
            divisions,
            total: input.alignMove
              ? valued(divisions, input).reduce((n, x) => n + score(strategy, x.perHour, x.plan), 0)
              : node.total + s,
            rank: 0
          }
          child.rank = child.total + (strategy === 'per-hour' ? potential(child, input, ordered) : 0)
          // The same divisions reached in another order (or by both weights) are the same army.
          const sig = signature(child)
          if (seen.has(sig)) continue
          seen.add(sig)
          children.push(child)
        }
      }
    }
    if (!children.length) break
    children.sort((x, y) => y.rank - x.rank)
    const keep = Date.now() - started > BEAM_BUDGET_MS ? 1 : width
    frontier = children.slice(0, keep)
    for (const c of frontier) if (earning(c, input) > earning(best, input)) best = c
    if (outOfTime) break
  }
  return { divisions: valued(best.divisions, input), perHour: earning(best, input), strategy }
}

/**
 * What each division earns when the ones on missions of the same length wait for the slowest of
 * them (alignMove): its mission's rate at that group's highest move cost.
 */
export function alignedDivisions(divisions: OptimizedDivision[], market: Market): OptimizedDivision[] {
  const slowest = new Map<number, number>()
  for (const d of divisions)
    slowest.set(d.mission.cooldownBase, Math.max(slowest.get(d.mission.cooldownBase) ?? 0, d.plan.bundle.move))
  return divisions.map((d) => ({ ...d, perHour: tlmPerHour(d.mission, slowest.get(d.mission.cooldownBase)!, market) }))
}

const valued = (divisions: OptimizedDivision[], input: OptimizeInput) =>
  input.alignMove ? alignedDivisions(divisions, input.market) : divisions

const earning = (n: Node, input: OptimizeInput) => valued(n.divisions, input).reduce((sum, d) => sum + d.perHour, 0)

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
  const asIsValued = valued(asIs, input)
  let best: ArmyPlan =
    asIs.length && asIs.length <= input.maxDivisions
      ? { divisions: asIsValued, perHour: asIsValued.reduce((n, d) => n + d.perHour, 0), strategy: 'per-hour' }
      : { divisions: [], perHour: 0, strategy: 'per-hour' }
  for (const strategy of STRATEGIES) {
    if (deadline - Date.now() < EXTRA_PASS_MIN_MS && strategy !== 'per-hour') break
    const plan = search(input, strategy, strategy === 'per-hour' ? beamWidth(input) : 1, deadline, onProgress)
    if (plan.perHour > best.perHour + 1e-9) best = plan
  }
  return best
}
