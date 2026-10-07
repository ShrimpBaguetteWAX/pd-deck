import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import type { Planet } from '@/chain/config'
import { toast } from '@/components/toast'
import {
  refreshMining,
  useEquippedTools,
  useFavoriteLands,
  useLandTypes,
  useLivePools,
  useMiner,
  usePlanetMinCommission,
  usePlanetPools,
  type FavoriteLand
} from '@/data/mining'
import { cooldownLabel, useNow } from '@/lib/time'
import { useSession } from '@/state/session'

import {
  effectiveCommission,
  estimateTlm,
  mineReadyAt,
  miningPowerByRarity,
  nextFavoriteUpgrade,
  pickFavoriteLand
} from './estimates'
import { mineNow } from './mineNow'

const MINE_SOUND = 'https://play.alienworlds.io/sounds/aw-mining-claim-sfx-02.mp3'

/**
 * The top bar's mine button: Alien Worlds mining on the player's favourite lands (the ones saved
 * on Mission Control), choosing at each press the land that pays the most TLM among those ready.
 * Without favourites it mines on the current land. Any wallet may mine.
 */
export function useMining() {
  const { account, permission, spectating } = useSession(
    useShallow((s) => ({ account: s.account, permission: s.permission, spectating: s.spectating }))
  )
  const miner = useMiner(account)
  const tools = useEquippedTools(account)
  const favorites = useFavoriteLands(account)
  const now = useNow(1000)
  const [busy, setBusy] = useState(false)

  const hasFavorites = favorites.lands.length > 0
  // The picks only need to move on every few seconds, not on every clock tick.
  const coarseNow = Math.floor(now / 5000) * 5000
  const toolData = tools.data
  const lastMine = miner.data?.last_mine
  const readyFor = (land: FavoriteLand) => mineReadyAt(land.delay, toolData, lastMine)

  const best = useMemo(
    () => (hasFavorites ? pickFavoriteLand(favorites.lands, readyFor, coarseNow) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hasFavorites, favorites.lands, toolData, lastMine, coarseNow]
  )
  // A favourite that pays more but is still cooling down: the button moves up to it once ready.
  const upgrade = useMemo(
    () => (hasFavorites ? nextFavoriteUpgrade(favorites.lands, readyFor, coarseNow) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hasFavorites, favorites.lands, toolData, lastMine, coarseNow]
  )

  // Without favourites, the estimate is for the current land.
  const enabled = !!account
  const landTypes = useLandTypes(enabled)
  const pools = usePlanetPools(enabled)
  const planetMin = usePlanetMinCommission(enabled)
  const livePlanets = (hasFavorites ? favorites.lands.map((l) => l.planetName) : [miner.data?.land?.planetName ?? ''])
    .filter(Boolean)
    .map((p) => p.toLowerCase() as Planet)
  useLivePools(livePlanets, enabled)

  const estimatedTlm = useMemo(() => {
    if (hasFavorites) return best?.estimatedTlm ?? null
    const land = miner.data?.land
    if (!land || !pools.data) return null
    const planet = land.planetName.toLowerCase() as Planet
    const landType = landTypes.data?.find((l) => l.landtype_id === land.cardid)
    const commission = effectiveCommission(land.commission / 10000, planetMin.data?.[planet] ?? 0)
    const gross = estimateTlm(miningPowerByRarity(toolData), landType?.mining_power_mod ?? 0, pools.data[planet])
    return gross - gross * commission
  }, [hasFavorites, best, miner.data, pools.data, landTypes.data, planetMin.data, toolData])

  const landDelay = hasFavorites ? best?.delay : miner.data?.land?.delay
  const readyAt = mineReadyAt(landDelay, toolData, lastMine)
  const label = cooldownLabel(readyAt, now)
  const dataLoading = miner.isLoading || tools.isLoading || favorites.isLoading
  const notSetUp = !dataLoading && (!miner.data || (toolData ?? []).length === 0)

  // The Alien Worlds chime when the cooldown runs out.
  const previous = useRef(label)
  useEffect(() => {
    if (previous.current !== 'MINE' && label === 'MINE' && !dataLoading && !notSetUp && !spectating) {
      void new Audio(MINE_SOUND).play().catch(() => undefined)
    }
    previous.current = label
  }, [label, dataLoading, notSetUp, spectating])

  async function onClick() {
    if (!account) return
    if (spectating) {
      toast.info('You are viewing this account read-only. Sign in with your wallet to mine.')
      return
    }
    setBusy(true)
    try {
      let landId: string | undefined
      if (hasFavorites) {
        // Read the pools now and mine where the return is best at this moment, among lands ready.
        const lands = await favorites.estimateNow()
        landId = pickFavoriteLand(lands, readyFor, Date.now())?.asset_id
      }
      await mineNow({ account, permission, tools: toolData, landId })
    } finally {
      setBusy(false)
    }
  }

  const landName = hasFavorites ? best?.landName : miner.data?.land?.landName
  const planetName = hasFavorites ? best?.planetName : miner.data?.land?.planetName

  return {
    onClick,
    refresh: () => refreshMining(account),
    isBusy: busy || dataLoading,
    isDisabled: spectating || busy || dataLoading || notSetUp || label !== 'MINE',
    /** Cooldown over and nothing in the way: the moment to press it. */
    isReady: !spectating && !busy && !dataLoading && !notSetUp && label === 'MINE',
    isRefreshing: miner.isFetching || tools.isFetching,
    buttonText: label,
    /** TLM the next mine should pay on the current pools; null where there is no estimate. */
    estimatedTlm,
    hasFavorites,
    /** The better favourite the button will pick once it comes off cooldown, while it waits. */
    upgrade:
      upgrade && upgrade.at > now
        ? {
            in: cooldownLabel(upgrade.at, now, ''),
            title: `${upgrade.land.landName} on ${upgrade.land.planetName} pays more (${upgrade.land.estimatedTlm.toFixed(4)} TLM) and comes off cooldown in ${cooldownLabel(upgrade.at, now, '')}`
          }
        : null,
    textBelow: notSetUp
      ? 'Set up mining in Alien Worlds first'
      : landName
        ? `${landName}${planetName ? ` · ${planetName}` : ''}`
        : ''
  }
}
