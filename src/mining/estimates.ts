import type { EquippedTool, FavoriteLand } from '@/data/mining'
import { chainDate } from '@/lib/time'

/*
 * The mine button's arithmetic, as the Alien Worlds client does it: when the equipped bag can
 * mine again, what a mine should pay on a land, and which favourite land to mine next.
 */

/**
 * When the equipped bag can mine again: the land's delay attribute (10 = 1x) scales the tool
 * delays, where only the slowest tool counts fully, the second counts half with two tools, and
 * fully with three.
 */
export function mineReadyAt(landDelay: number | undefined, tools: EquippedTool[] | undefined, lastMine?: string): number {
  const multiplier = (landDelay ?? 0) / 10
  const delays = (tools ?? []).map((tool) => tool.delay ?? 0).sort((a, b) => b - a)

  let seconds = 0
  if (delays.length === 1) seconds = multiplier * delays[0]
  else if (delays.length === 2) seconds = multiplier * (delays[0] + delays[1] / 2)
  else if (delays.length >= 3) seconds = multiplier * (delays[0] + delays[1])

  const lastToolUse = Math.max(0, ...(tools ?? []).map((tool) => (tool.last_use ?? 0) * 1000))
  const lastMineAt = lastMine ? +chainDate(lastMine) : 0
  const last = Math.max(lastToolUse, Number.isFinite(lastMineAt) ? lastMineAt : 0)

  return last + seconds * 1000
}

/** Mining power per rarity across the equipped tools. */
export function miningPowerByRarity(tools: EquippedTool[] | undefined): Record<string, number> {
  const out: Record<string, number> = {}
  for (const tool of tools ?? []) out[tool.rarity] = (out[tool.rarity] ?? 0) + Number(tool.mining_power ?? 0)
  return out
}

/** Expected TLM per mine before commission: each rarity's share is capped at 80% of that planet's pool bucket. */
export function estimateTlm(
  powerByRarity: Record<string, number>,
  landMiningPowerMod: number,
  pools: Record<string, number> | undefined
): number {
  if (!pools) return 0
  return Object.entries(powerByRarity).reduce((sum, [rarity, power]) => {
    const share = Math.min(0.8, (power * landMiningPowerMod) / 10000)
    return sum + share * (pools[rarity] ?? 0)
  }, 0)
}

/** Commission is never below the planet minimum. Both are fractions. */
export const effectiveCommission = (landCommission: number, planetMin: number) => Math.max(landCommission, planetMin)

/**
 * The favourite land to mine next: among the lands ready now (or, when none is, the ones ready
 * soonest), the one that pays the most TLM.
 */
export function pickFavoriteLand(lands: FavoriteLand[], readyAt: (land: FavoriteLand) => number, now: number) {
  if (lands.length === 0) return null
  let pool = lands.filter((land) => readyAt(land) <= now)
  if (pool.length === 0) {
    const soonest = Math.min(...lands.map(readyAt))
    pool = lands.filter((land) => readyAt(land) === soonest)
  }
  return [...pool].sort((a, b) => b.estimatedTlm - a.estimatedTlm)[0]
}

/** Below this, a land pays the same for all the player can see, so it is no upgrade. */
const UPGRADE_EPSILON = 1e-4

/**
 * The favourite land the button will move up to once it comes off cooldown: one that pays more
 * than the land it would pick right now, the soonest such. Null when nothing cooling down beats
 * the current pick, and while mining itself is still on cooldown.
 */
export function nextFavoriteUpgrade(
  lands: FavoriteLand[],
  readyAt: (land: FavoriteLand) => number,
  now: number
): { land: FavoriteLand; at: number } | null {
  const current = pickFavoriteLand(lands, readyAt, now)
  if (!current || readyAt(current) > now) return null
  const better = lands
    .filter((land) => readyAt(land) > now && land.estimatedTlm - current.estimatedTlm >= UPGRADE_EPSILON)
    .map((land) => ({ land, at: readyAt(land) }))
    .sort((a, b) => a.at - b.at || b.land.estimatedTlm - a.land.estimatedTlm)
  return better[0] ?? null
}
