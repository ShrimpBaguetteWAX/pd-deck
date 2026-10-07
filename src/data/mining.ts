import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

import { atomic } from '@/chain/atomic'
import { CONTRACTS, PLANET_SCOPES, PLANETS, type Planet } from '@/chain/config'
import { getRow, getRows } from '@/chain/rpc'
import { parseAsset } from '@/lib/format'
import { effectiveCommission, estimateTlm, miningPowerByRarity } from '@/mining/estimates'

import { queryClient } from './queryClient'

/*
 * Alien Worlds mining data for the top bar's mine button: the miner row (last mine, current land),
 * the equipped tools (the bag, with the stats hq.mu keeps per template), land types, the planets'
 * reward pools, each planet's minimum commission, and the favourite lands a Mission Control member
 * saved (members.mc), which the button mines on.
 */

const MIN = 60_000
const HOUR = 60 * MIN

export interface Miner {
  miner: string
  last_mine_tx: string
  last_mine: string
  current_land: string
}

interface Bag {
  account: string
  items: (string | number)[]
  locked: number
}

interface ToolUse {
  asset_id: string
  last_use: number
}

export interface AwTool {
  template_id: number
  toolname: string
  rarity: string
  shine: string
  type: string
  img: string
  cooldown_seconds: number
  mining_power: number
  nft_power: number
  pow: number
}

export interface LandType {
  landtype_id: number
  landname: string
  rarity: string
  img: string
  cooldown_mod: number
  mining_power_mod: number
  nft_power_mod: number
  pow_mod: number
}

/** Immutable data of an alien.worlds land NFT. */
export interface LandData {
  name: string
  img: string
  rarity: string
  cardid: number
  commission: number
  delay: number
  difficulty: number
  ease: number
  luck: number
  planet: string
  x: number
  y: number
}

/** Immutable data of an alien.worlds tool NFT. */
export interface ToolData {
  name: string
  img: string
  rarity: string
  shine: string
  type: string
  cardid: number
  delay: number
  difficulty: number
  ease: number
  luck: number
}

export interface EquippedTool extends ToolData {
  asset_id: string
  template_id: string
  last_use: number
  cooldown_seconds: number
  mining_power: number
  nft_power: number
  pow: number
  toolname: string
}

export interface CurrentLand extends LandData {
  asset_id: string
  owner: string
  landName: string
  planetName: string
}

export interface FavoriteLand extends CurrentLand {
  /** TLM a mine should pay there after commission, on the pools as last read. */
  estimatedTlm: number
  /** Effective commission as a percentage. */
  commissionPercent: number
}

type PoolMap = Record<Planet, Record<string, number>>

const exact = (key: string) => ({ lower_bound: key, upper_bound: key })
const { M_FEDERATION, HQ_MU, AWLNDRATINGS, MEMBERS_MC } = CONTRACTS

export const readMiner = (account: string) =>
  getRow<Miner>({ code: M_FEDERATION, table: 'miners', ...exact(account) }, { confirmEmpty: true })
const readBag = (account: string) => getRow<Bag>({ code: M_FEDERATION, table: 'bags', ...exact(account) }, { confirmEmpty: true })
const readToolUse = (assetId: string) => getRow<ToolUse>({ code: M_FEDERATION, table: 'tooluse', ...exact(assetId) })

async function readPools(planet: Planet): Promise<Record<string, number>> {
  const row = await getRow<{ pool_buckets: { key: string; value: string }[] }>({
    code: M_FEDERATION,
    table: 'pools',
    scope: PLANET_SCOPES[planet]
  })
  return Object.fromEntries((row?.pool_buckets ?? []).map((b) => [b.key, parseAsset(b.value).amount]))
}

const landOf = (asset: { asset_id: string; owner: string; data: Record<string, unknown> }): CurrentLand => {
  const data = asset.data as unknown as LandData
  const [landName, planetName] = String(data.name ?? '').split(' on ')
  return { ...data, asset_id: asset.asset_id, owner: asset.owner, landName, planetName: planetName ?? '' }
}

export const useAwTools = () =>
  useQuery({ queryKey: ['mine', 'awtools'], queryFn: () => getRows<AwTool>({ code: HQ_MU, table: 'awtools' }), staleTime: HOUR })

export const useLandTypes = (enabled = true) =>
  useQuery({
    queryKey: ['mine', 'landtypes'],
    queryFn: () => getRows<LandType>({ code: HQ_MU, table: 'awlandtypes' }),
    staleTime: HOUR,
    enabled
  })

/** min_commission per planet, as a fraction (500 -> 0.05). */
export function usePlanetMinCommission(enabled = true) {
  return useQuery({
    queryKey: ['mine', 'planet-min'],
    staleTime: HOUR,
    enabled,
    queryFn: async () => {
      const entries = await Promise.all(
        PLANETS.map(async (planet) => {
          const row = await getRow<{ data: { key: string; value: [string, number] }[] }>({
            code: AWLNDRATINGS,
            table: 'plntconfigs',
            scope: PLANET_SCOPES[planet]
          })
          const min = row?.data.find((c) => c.key === 'min_commission')?.value?.[1] ?? 0
          return [planet, Number(min) / 10000] as const
        })
      )
      return Object.fromEntries(entries) as Record<Planet, number>
    }
  })
}

const POOLS_KEY = ['mine', 'pools']

export function usePlanetPools(enabled = true) {
  return useQuery({
    queryKey: POOLS_KEY,
    staleTime: 5 * MIN,
    enabled,
    queryFn: async () => {
      const entries = await Promise.all(PLANETS.map(async (planet) => [planet, await readPools(planet)] as const))
      return Object.fromEntries(entries) as PoolMap
    }
  })
}

/** How often the planets the mine button depends on are read again. */
const LIVE_POOLS_MS = 5_000

/**
 * Keeps the pools of `planets` current for the mine button: read every few seconds while the tab
 * is in view and merged into the shared pools, so the estimate on screen moves with them.
 */
export function useLivePools(planets: Planet[], enabled: boolean) {
  const wanted = [...new Set(planets)].sort()
  return useQuery({
    queryKey: [...POOLS_KEY, 'live', wanted.join(',')],
    enabled: enabled && wanted.length > 0,
    refetchInterval: LIVE_POOLS_MS,
    staleTime: LIVE_POOLS_MS,
    queryFn: async () => {
      const entries = await Promise.all(wanted.map(async (planet) => [planet, await readPools(planet)] as const))
      const fresh = Object.fromEntries(entries) as Partial<PoolMap>
      queryClient.setQueryData<PoolMap>(POOLS_KEY, (all) => (all ? { ...all, ...fresh } : undefined))
      return fresh
    }
  })
}

export function useMiner(account: string | null) {
  return useQuery({
    queryKey: ['mine', 'miner', account],
    enabled: !!account,
    staleTime: 20 * MIN,
    queryFn: async () => {
      const miner = await readMiner(account!)
      if (!miner) return null
      const [asset] = await atomic.getAssetsByIds([String(miner.current_land)])
      return { ...miner, land: asset ? landOf(asset) : null }
    }
  })
}

export function useEquippedTools(account: string | null) {
  const awTools = useAwTools()
  return useQuery({
    queryKey: ['mine', 'tools', account],
    enabled: !!account && !!awTools.data,
    staleTime: 20 * MIN,
    queryFn: async (): Promise<EquippedTool[]> => {
      const bag = await readBag(account!)
      const ids = (bag?.items ?? []).map(String)
      if (!ids.length) return []
      const [assets, uses] = await Promise.all([atomic.getAssetsByIds(ids), Promise.all(ids.map((id) => readToolUse(id)))])
      return ids.flatMap((id, i) => {
        const asset = assets.find((a) => a.asset_id === id)
        if (!asset) return []
        const data = asset.data as unknown as ToolData
        const templateId = asset.template?.template_id ?? ''
        const stats = awTools.data!.find((tool) => String(tool.template_id) === templateId && tool.shine === data.shine)
        return [
          {
            ...data,
            asset_id: id,
            template_id: templateId,
            last_use: Number(uses[i]?.last_use ?? 0),
            cooldown_seconds: stats?.cooldown_seconds ?? 0,
            mining_power: stats?.mining_power ?? 0,
            nft_power: stats?.nft_power ?? 0,
            pow: stats?.pow ?? 0,
            toolname: stats?.toolname ?? data.name
          }
        ]
      })
    }
  })
}

interface McMember {
  wallet?: string
  usrsettings?: { key: string; value: string }[]
}

/**
 * The favourite lands the player saved on Mission Control (members.mc keeps them in the member's
 * settings), each with the TLM a mine should pay there now. Empty for players without any.
 */
export function useFavoriteLands(account: string | null) {
  const enabled = !!account
  const tools = useEquippedTools(account)
  const landTypes = useLandTypes(enabled)
  const pools = usePlanetPools(enabled)
  const planetMin = usePlanetMinCommission(enabled)

  const member = useQuery({
    queryKey: ['mine', 'favorites', account],
    enabled,
    staleTime: 5 * MIN,
    queryFn: async () => {
      const row = await getRow<McMember>({ code: MEMBERS_MC, table: 'mcmembers', ...exact(account!) }, { confirmEmpty: true })
      const ids = (row?.usrsettings ?? [])
        .filter((s) => s.key.includes('land'))
        .flatMap((s) => s.value.split(','))
        .map((s) => s.trim())
        .filter(Boolean)
      const assets = ids.length ? await atomic.getAssetsByIds(ids) : []
      return ids.flatMap((id) => {
        const asset = assets.find((a) => a.asset_id === id)
        return asset ? [landOf(asset)] : []
      })
    }
  })

  const toolData = tools.data
  const landTypeData = landTypes.data
  const planetMinData = planetMin.data
  const estimate = (lands: CurrentLand[] | undefined, poolData: PoolMap | undefined): FavoriteLand[] => {
    const power = miningPowerByRarity(toolData)
    return (lands ?? []).map((land) => {
      const planet = land.planetName.toLowerCase() as Planet
      const landType = landTypeData?.find((l) => l.landtype_id === land.cardid)
      const commission = effectiveCommission(land.commission / 10000, planetMinData?.[planet] ?? 0)
      const gross = estimateTlm(power, landType?.mining_power_mod ?? 0, poolData?.[planet])
      return { ...land, estimatedTlm: gross - gross * commission, commissionPercent: commission * 100 }
    })
  }

  const refetchPools = pools.refetch
  const memberData = member.data
  return useMemo(
    () => ({
      lands: estimate(memberData, pools.data),
      isLoading: member.isLoading,
      /** The lands on the pools as they are right now: read again when the button is pressed. */
      estimateNow: async () => estimate(memberData, (await refetchPools()).data)
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [memberData, member.isLoading, pools.data, toolData, landTypeData, planetMinData, refetchPools]
  )
}

/** After a mine: the miner row, the tools' cooldowns and the pools (which every mine moves). */
export function refreshMining(account: string | null) {
  return Promise.all(
    [['mine', 'miner', account], ['mine', 'tools', account], POOLS_KEY].map((queryKey) =>
      queryClient.invalidateQueries({ queryKey })
    )
  )
}
