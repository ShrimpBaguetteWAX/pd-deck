import { useMemo } from 'react'

import type { AnyAction } from '@wharfkit/session'

import { claimMission, deployActions } from '@/chain/actions/pd'
import { freshMarket, useArmy, useDeployments, useMarket, useMissionConfig, usePlayer, type Deployment } from '@/data/game'
import { missionEconomics, type MissionEconomics } from '@/lib/loop'
import { fundEntries, quoteFunding, sellDefAction, tlmForDef } from '@/lib/market'
import { useClockFor } from '@/lib/time'

/*
 * The claim-and-redeploy loop, shared by the Deployments page and the top bar's loop button:
 * which divisions are back, which can go straight out again, when the next one returns, and the
 * transactions that claim the rewards and send them back out.
 */

/** Remembers whether claimed DEF is sold for TLM right away. */
export const CASH_OUT_KEY = 'pd.cash-out-def'

export function readCashOut(): boolean {
  try {
    return localStorage.getItem(CASH_OUT_KEY) === '1'
  } catch {
    return false
  }
}

export interface LoopPart {
  build: (a: string, p: string) => AnyAction[] | Promise<AnyAction[]>
  success: string
}

export function useLoopPlan(account: string | null, cashOut: boolean) {
  const deployments = useDeployments(account)
  const config = useMissionConfig()
  const army = useArmy(account)
  const player = usePlayer(account)
  const market = useMarket()

  // Re-render as each division's cooldown ends.
  const unlocks = useMemo(() => deployments.data?.map((d) => d.unlockAt) ?? [], [deployments.data])
  const now = useClockFor(unlocks)

  const econ = useMemo(() => {
    const m = new Map<number, MissionEconomics>()
    if (config.data)
      for (const row of config.data.missions) m.set(Number(row.mission_id), missionEconomics(row, config.data, now))
    return m
  }, [config.data, now])

  const divisionById = useMemo(() => new Map(army.data?.divisions.map((d) => [d.id, d]) ?? []), [army.data])

  const list = deployments.data ?? []
  const ready = list.filter((d) => d.unlockAt <= now)
  const running = list.filter((d) => d.unlockAt > now)
  /** Ready deployments whose mission is still open, so the division can go straight back out. */
  const loopable = ready.filter((d) => econ.get(d.missionId)?.state === 'active')
  const nextReturnAt = running.length ? Math.min(...running.map((d) => d.unlockAt)) : null
  const wallet = player.data ? { tlm: player.data.tlm, def: player.data.def } : null

  /**
   * Claims `claims` and sends `redeploy` back out. The claims, the DEF purchase and the cash-out
   * go in the first transaction; the claimed TLM and DEF land before the next action runs, so they
   * pay the new entries. The contract takes one join per transaction, so the first division sent
   * back out goes with the claims and every further one is a transaction of its own. The swaps
   * are built from a pool quote read at signing time, so their minimum output is current.
   */
  function cycle(claims: Deployment[], redeploy: Deployment[]) {
    const sum = (items: Deployment[], f: (e: MissionEconomics) => number) =>
      items.reduce((n, d) => n + (econ.get(d.missionId) ? f(econ.get(d.missionId)!) : 0), 0)
    const earnedTlm = sum(claims, (e) => e.rewardTlm)
    const earnedDef = sum(claims, (e) => e.rewardDef)
    const cost = { tlm: sum(redeploy, (e) => e.costTlm), def: sum(redeploy, (e) => e.costDef) }
    const after = wallet ? { tlm: wallet.tlm + earnedTlm, def: wallet.def + earnedDef } : null
    const funding = quoteFunding(market, cost, after)
    const surplusDef = cashOut ? Math.max(0, earnedDef - cost.def) : 0
    const sold = surplusDef > 0 ? tlmForDef(market, surplusDef) : 0
    const head = async (a: string, p: string) => {
      const m = await freshMarket(market)
      return [
        ...claims.map((d) => claimMission(a, p, d.missionId, d.divisionId)),
        ...fundEntries(a, p, m, cost, after).actions,
        ...(surplusDef > 0 ? [sellDefAction(a, p, m, surplusDef).action] : [])
      ]
    }
    const out = (a: string, p: string, x: Deployment) =>
      deployActions(
        a,
        p,
        x.missionId,
        x.divisionId,
        !!divisionById.get(x.divisionId) && !divisionById.get(x.divisionId)!.fresh,
        econ.get(x.missionId)!.costs
      )
    const [first, ...rest] = redeploy
    const parts: LoopPart[] = [
      {
        build: async (a, p) => [...(await head(a, p)), ...(first ? out(a, p, first) : [])],
        success: !first
          ? `${claims.length} claimed`
          : rest.length
            ? `${claims.length} claimed, #${first.divisionId} sent back out`
            : `#${first.divisionId} claimed and redeployed`
      },
      ...rest.map((x) => ({
        build: (a: string, p: string) => out(a, p, x),
        success: `#${x.divisionId} sent back to ${econ.get(x.missionId)?.title ?? 'its mission'}`
      }))
    ]
    return { parts, build: parts[0].build, funding, surplusDef, sold, earnedTlm, earnedDef }
  }

  return {
    loaded: !!deployments.data && !!config.data,
    loading: deployments.isLoading || config.isLoading,
    deployments: list,
    ready,
    running,
    loopable,
    nextReturnAt,
    now,
    econ,
    divisionById,
    market,
    cycle
  }
}
