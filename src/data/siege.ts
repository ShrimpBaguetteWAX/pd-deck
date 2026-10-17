import { useQuery, type UseQueryResult } from '@tanstack/react-query'

import { CONTRACTS, PLANETS, type Planet } from '@/chain/config'
import { getActions } from '@/chain/history'
import { getRow, getRows } from '@/chain/rpc'
import { parseAsset } from '@/lib/format'
import { chainDate } from '@/lib/time'

import { queryClient } from './queryClient'

/*
 * Planetary sieges, from siege.pdef. Each world has a row in `planets` once the game has opened
 * it: a DEF threshold the community funds to unlock a season, then a season with attack and
 * defense targets that joined divisions score towards, an entry cost in TLM and a cooldown.
 * Scores per player live in `accscores` under a scope made of the planet and the season; a
 * player's joined divisions in `entries` under the planet; the season's prizes in `rankprizes`.
 */

/** Worlds in the contract's planet_id order (1..6). */
export const SIEGE_PLANETS: Planet[] = ['naron', 'kavian', 'magor', 'veles', 'eyeke', 'neri']
export const planetIdOf = (planet: string) => SIEGE_PLANETS.indexOf(planet as Planet) + 1
export const planetOf = (id: number): Planet | null => SIEGE_PLANETS[id - 1] ?? null

export type SiegeStatus = 'unopened' | 'locked' | 'active' | 'met' | 'failed'
const STATUS: Record<number, SiegeStatus> = { 0: 'locked', 1: 'active', 2: 'met', 3: 'failed' }

export interface Siege {
  planet: Planet
  planetId: number
  /** False for a world the contract has no row for yet. */
  onChain: boolean
  status: SiegeStatus
  season: number
  everUnlocked: boolean
  durationDays: number
  /** DEF the community has to send before the season opens, and how much it has. */
  thresholdDef: number
  fundedDef: number
  startAt: number | null
  endAt: number | null
  entryTlm: number
  cooldownBase: number
  targetAtk: number
  targetDef: number
  cumAtk: number
  cumDef: number
  minAtk: number
  minDef: number
  deployments: number
  participants: number
  distributedRanks: number
}

interface PlanetRow {
  planet_id: number | string
  season_id: number | string
  status: number | string
  ever_unlocked: number | string
  unlock_threshold_def: string
  unlock_progress_def: string
  duration_days: number | string
  start_time: string
  end_time: string
  entry_cost_tlm: string
  cooldown_base_sec: number | string
  target_atk: number | string
  target_def: number | string
  min_div_attack: number | string
  min_div_defense: number | string
  cum_atk: number | string
  cum_def: number | string
  total_deployments: number | string
  participants: number | string
  distributed_ranks: number | string
}

const EPOCH = '1970-01-01T00:00:00'
const timeOf = (t: string) => (!t || t.startsWith(EPOCH) ? null : +chainDate(t))

const empty = (planet: Planet): Siege => ({
  planet,
  planetId: planetIdOf(planet),
  onChain: false,
  status: 'unopened',
  season: 0,
  everUnlocked: false,
  durationDays: 0,
  thresholdDef: 0,
  fundedDef: 0,
  startAt: null,
  endAt: null,
  entryTlm: 0,
  cooldownBase: 0,
  targetAtk: 0,
  targetDef: 0,
  cumAtk: 0,
  cumDef: 0,
  minAtk: 0,
  minDef: 0,
  deployments: 0,
  participants: 0,
  distributedRanks: 0
})

function siegeOf(row: PlanetRow): Siege | null {
  const planet = planetOf(Number(row.planet_id))
  if (!planet) return null
  const endAt = timeOf(row.end_time)
  const status = STATUS[Number(row.status)] ?? 'locked'
  return {
    planet,
    planetId: Number(row.planet_id),
    onChain: true,
    status,
    season: Number(row.season_id) || 1,
    everUnlocked: Number(row.ever_unlocked) === 1,
    durationDays: Number(row.duration_days) || 0,
    thresholdDef: parseAsset(row.unlock_threshold_def).amount,
    fundedDef: parseAsset(row.unlock_progress_def).amount,
    startAt: timeOf(row.start_time),
    endAt,
    entryTlm: parseAsset(row.entry_cost_tlm).amount,
    cooldownBase: Number(row.cooldown_base_sec) || 0,
    targetAtk: Number(row.target_atk) || 0,
    targetDef: Number(row.target_def) || 0,
    cumAtk: Number(row.cum_atk) || 0,
    cumDef: Number(row.cum_def) || 0,
    minAtk: Number(row.min_div_attack) || 0,
    minDef: Number(row.min_div_defense) || 0,
    deployments: Number(row.total_deployments) || 0,
    participants: Number(row.participants) || 0,
    distributedRanks: Number(row.distributed_ranks) || 0
  }
}

/** Whether divisions may join right now: the season is open and not over. */
export const joinOpen = (s: Siege, now: number) => s.status === 'active' && (s.endAt === null || s.endAt > now)

/** All six worlds, the ones without a row as greyed placeholders. */
export function useSieges(): UseQueryResult<Siege[]> {
  return useQuery({
    queryKey: ['sieges'],
    staleTime: 30_000,
    refetchInterval: 30_000,
    queryFn: async () => {
      const rows = await getRows<PlanetRow>({ code: CONTRACTS.SIEGE, scope: CONTRACTS.SIEGE, table: 'planets', limit: 10 })
      const byPlanet = new Map(rows.map(siegeOf).flatMap((s) => (s ? [[s.planet, s] as const] : [])))
      return PLANETS.map((p) => byPlanet.get(p) ?? empty(p)).sort((a, b) => a.planetId - b.planetId)
    }
  })
}

export interface RankPrize {
  rank: number
  def: number
  nfts: { templateId: string; schema: string; count: number }[]
}

export function useRankPrizes(planetId: number | null): UseQueryResult<RankPrize[]> {
  return useQuery({
    queryKey: ['siege-prizes', planetId],
    enabled: !!planetId,
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const rows = await getRows<{
        rank: number | string
        def_amount: string
        nfts: { collection: string; schema: string; template_id: number | string; count: number | string }[]
      }>({ code: CONTRACTS.SIEGE, scope: String(planetId), table: 'rankprizes', limit: 100 })
      return rows
        .map((r) => ({
          rank: Number(r.rank),
          def: parseAsset(r.def_amount).amount,
          nfts: (r.nfts ?? []).map((n) => ({ templateId: String(n.template_id), schema: n.schema, count: Number(n.count) }))
        }))
        .filter((r) => r.rank > 0)
        .sort((a, b) => a.rank - b.rank)
    }
  })
}

export interface ScoreRow {
  rank: number
  account: string
  atk: number
  def: number
  score: number
  deployments: number
}

/** The season's scope: the planet in the high half, the season in the low half. */
export const seasonScope = (planetId: number, season: number) =>
  ((BigInt(planetId) << 32n) | (BigInt(season) & 0xffffffffn)).toString()

export function useLeaderboard(siege: Siege | null): UseQueryResult<ScoreRow[]> {
  const key = siege?.onChain && siege.season ? seasonScope(siege.planetId, siege.season) : null
  return useQuery({
    queryKey: ['siege-scores', key],
    enabled: !!key,
    staleTime: 30_000,
    refetchInterval: 30_000,
    queryFn: async () => {
      const rows = await getRows<{
        account: string
        cum_atk: number | string
        cum_def: number | string
        cum_score: number | string
        deployments: number | string
      }>({ code: CONTRACTS.SIEGE, scope: key!, table: 'accscores', limit: 200 })
      return rows
        .map((r) => ({
          rank: 0,
          account: r.account,
          atk: Number(r.cum_atk) || 0,
          def: Number(r.cum_def) || 0,
          score: Number(r.cum_score) || (Number(r.cum_atk) || 0) + (Number(r.cum_def) || 0),
          deployments: Number(r.deployments) || 0
        }))
        .sort((a, b) => b.score - a.score)
        .map((r, i) => ({ ...r, rank: i + 1 }))
    }
  })
}

export interface SiegeEntry {
  entryId: number
  planetId: number
  season: number
  divisionId: number
  atk: number
  def: number
  move: number
  joinedAt: number
  unlockAt: number
}

/** The player's joined divisions across every world that has a row. */
export function useSiegeEntries(account: string | null, planetIds: number[]): UseQueryResult<SiegeEntry[]> {
  return useQuery({
    queryKey: ['siege-entries', account, planetIds.join(',')],
    enabled: !!account && planetIds.length > 0,
    staleTime: 20_000,
    refetchInterval: 30_000,
    queryFn: async () => {
      const lists = await Promise.all(
        planetIds.map((id) =>
          getRows<{
            entry_id: number | string
            owner: string
            season_id: number | string
            division_id: number | string
            atk: number | string
            def: number | string
            movecost: number | string
            join_time: string
            unlock_time: string
          }>({ code: CONTRACTS.SIEGE, scope: String(id), table: 'entries', limit: 500 }).then((rows) =>
            rows
              .filter((r) => r.owner === account)
              .map((r) => ({
                entryId: Number(r.entry_id),
                planetId: id,
                season: Number(r.season_id) || 0,
                divisionId: Number(r.division_id),
                atk: Number(r.atk) || 0,
                def: Number(r.def) || 0,
                move: Number(r.movecost) || 0,
                joinedAt: +chainDate(r.join_time),
                unlockAt: +chainDate(r.unlock_time)
              }))
          )
        )
      )
      return lists.flat()
    }
  })
}

/** TLM core.pdef holds for the player, which siege entries are paid from. */
export function useTlmBalance(account: string | null): UseQueryResult<number> {
  return useQuery({
    queryKey: ['tlm-balance', account],
    enabled: !!account,
    staleTime: 20_000,
    queryFn: async () => {
      const rows = await getRows<{ balance: string }>({ code: CONTRACTS.CORE, scope: account!, table: 'balances', limit: 20 })
      const tlm = rows.map((r) => parseAsset(r.balance)).find((a) => a.symbol === 'TLM')
      return tlm?.amount ?? 0
    }
  })
}

/** Entry fee already paid to a world and not used yet; the contract spends it before the balance. */
export function useEntryCredit(account: string | null, planetId: number | null): UseQueryResult<number> {
  return useQuery({
    queryKey: ['siege-credit', account, planetId],
    enabled: !!account && !!planetId,
    staleTime: 20_000,
    queryFn: async () => {
      const row = await getRow<{ owner: string; paid_amount: string }>({
        code: CONTRACTS.SIEGE,
        scope: String(planetId),
        table: 'entrypays',
        lower_bound: account!,
        upper_bound: account!
      })
      return row && row.owner === account ? parseAsset(row.paid_amount).amount : 0
    }
  })
}

export interface Contribution {
  account: string
  def: number
  at: number
  trxId: string
}

/**
 * Who funded a world: the DEF transfers to the siege contract with its unlock memo, from the
 * history nodes (the contract's own contributions table cannot be read: its stored rows no
 * longer match its ABI).
 */
export function useContributions(planetId: number | null): UseQueryResult<Contribution[]> {
  return useQuery({
    queryKey: ['siege-contributions', planetId],
    enabled: !!planetId,
    staleTime: 60_000,
    queryFn: async () => {
      const actions = await getActions(CONTRACTS.SIEGE, { filter: `${CONTRACTS.DEF}:transfer`, 'transfer.to': CONTRACTS.SIEGE })
      const memo = `unlock:${planetId}`
      return actions
        .filter((a) => String(a.act.data.memo ?? '') === memo)
        .map((a) => ({
          account: String(a.act.data.from ?? ''),
          def: parseAsset(String(a.act.data.quantity ?? '0 DEF')).amount,
          at: +chainDate(a['@timestamp']),
          trxId: a.trx_id
        }))
        .sort((a, b) => b.at - a.at)
    }
  })
}

/** After a contribution, a join or a claim: the world, the player's entries, scores and balances. */
export function refreshSieges(account: string | null) {
  return Promise.all(
    [
      ['sieges'],
      ['siege-entries', account],
      ['siege-scores'],
      ['siege-credit', account],
      ['tlm-balance', account],
      ['siege-contributions'],
      ['player', account],
      ['army', account]
    ].map((queryKey) => queryClient.invalidateQueries({ queryKey }))
  )
}
