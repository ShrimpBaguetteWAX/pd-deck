import { missionLockSeconds } from './stats'

/*
 * Where a live siege season is heading: when it closes, where every player stands then, and
 * where you would land if your divisions joined on every cooldown until the close.
 *
 * Everything is a straight line from the average pace since launch. The season closes when both
 * community targets are met, or when its timer runs out, whichever comes first. Other players are
 * assumed to keep their own pace; the top funders' bonus is added at the close, as the contract
 * does.
 */

export interface ProjectedDivision {
  id: number
  atk: number
  def: number
  move: number
  /** When it can join next: now, or when it comes back from a mission or the siege. */
  readyAt: number
}

export interface StandingRow {
  account: string
  score: number
  joins: number
}

export interface ProjectionInput {
  now: number
  startAt: number
  endAt: number
  cumAtk: number
  cumDef: number
  targetAtk: number
  targetDef: number
  cooldownBase: number
  entry: number
  board: StandingRow[]
  /** Score bonus at the close, by account (the top three funders). */
  bonus: Map<string, number>
  /** Your divisions that meet the season's minimum. */
  mine: ProjectedDivision[]
  me: string | null
}

export interface ProjectedRow extends StandingRow {
  /** Score at the close, the funder bonus included. */
  projected: number
  rank: number
  me: boolean
}

export interface Projection {
  /** ATK and DEF the season gains per hour, on average since launch. */
  atkPerHour: number
  defPerHour: number
  /** When each target is met at that pace, without you. */
  atkMetAt: number
  defMetAt: number
  /** When the season closes without you, and with your divisions joining on every cooldown. */
  closeWithout: number
  close: number
  /** Your joins, their entry fees and the score they add, from now until the close. */
  joins: number
  cost: number
  added: number
  /** The field at the close, you included when you have divisions to send. */
  field: ProjectedRow[]
}

const HOUR = 3_600_000

/** Joins a division makes from `readyAt` until `until`: one when ready, then one per cooldown. */
export function joinsUntil(d: ProjectedDivision, cooldownBase: number, until: number): number {
  if (d.readyAt >= until) return 0
  const cycle = missionLockSeconds(cooldownBase, d.move) * 1000
  return Math.floor((until - d.readyAt) / cycle) + 1
}

export function projectSiege(p: ProjectionInput): Projection {
  // At least an hour in, so the first minutes of a season do not project from almost nothing.
  const elapsed = Math.max(HOUR, p.now - p.startAt)
  const atkPerHour = (p.cumAtk / elapsed) * HOUR
  const defPerHour = (p.cumDef / elapsed) * HOUR
  const metAt = (cum: number, target: number, perHour: number) =>
    cum >= target ? p.now : perHour > 0 ? p.now + ((target - cum) / perHour) * HOUR : Infinity
  const atkMetAt = metAt(p.cumAtk, p.targetAtk, atkPerHour)
  const defMetAt = metAt(p.cumDef, p.targetDef, defPerHour)
  const closeWithout = Math.min(p.endAt, Math.max(atkMetAt, defMetAt))

  // Your divisions speed the season up, which in turn leaves them fewer joins: settle both together.
  const myRate = (k: 'atk' | 'def') => p.mine.reduce((n, d) => n + d[k] * (3600 / missionLockSeconds(p.cooldownBase, d.move)), 0)
  const close = Math.min(
    p.endAt,
    Math.max(metAt(p.cumAtk, p.targetAtk, atkPerHour + myRate('atk')), metAt(p.cumDef, p.targetDef, defPerHour + myRate('def')))
  )
  let joins = 0
  let added = 0
  for (const d of p.mine) {
    const n = joinsUntil(d, p.cooldownBase, close)
    joins += n
    added += n * (d.atk + d.def)
  }

  const grow = (close - p.startAt) / elapsed
  const rows = p.board.map((r) => ({
    ...r,
    projected: r.score * grow * (1 + (p.bonus.get(r.account) ?? 0)),
    me: r.account === p.me
  }))
  if (p.me && p.mine.length) {
    const mine = rows.find((r) => r.me)
    // Your own line: what you have, your bonus, and what your divisions add, not your past pace.
    const projected = ((mine?.score ?? 0) + added) * (1 + (p.bonus.get(p.me) ?? 0))
    if (mine) mine.projected = projected
    else rows.push({ account: p.me, score: 0, joins: 0, projected, me: true })
  }
  const field = rows.sort((a, b) => b.projected - a.projected).map((r, i) => ({ ...r, rank: i + 1 }))
  return { atkPerHour, defPerHour, atkMetAt, defMetAt, closeWithout, close, joins, cost: joins * p.entry, added, field }
}

/** When a funding phase reaches its threshold at the pace since its first contribution. */
export function fundingEta(funded: number, threshold: number, since: number | null, now: number): number | null {
  if (funded >= threshold) return now
  if (since === null || funded <= 0) return null
  const perMs = funded / Math.max(HOUR, now - since)
  return now + (threshold - funded) / perMs
}
