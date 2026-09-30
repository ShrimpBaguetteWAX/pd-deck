import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import { claimMission, deployActions } from '@/chain/actions/pd'
import { IpfsImg, PlanetIcon } from '@/components/Art'
import { Button } from '@/components/Button'
import { Loading } from '@/components/Loading'
import { Figure, StatTrio } from '@/components/Stat'
import { Ticking } from '@/components/Ticking'
import { Tooltip } from '@/components/Tooltip'
import { useArmy, useDeployments, useMarket, useMissionConfig, usePlayer, useTemplates, type Deployment } from '@/data/game'
import { GiftIcon, RefreshIcon, RocketIcon, TimerIcon } from '@/icons'
import { clock, formatDuration, formatSigned, formatToken, titleCase } from '@/lib/format'
import { costParts, cycleNet, missionEconomics, rewardParts, type MissionEconomics } from '@/lib/loop'
import { fundEntries, quoteFunding, sellDefAction, tlmForDef } from '@/lib/market'

/** Remembers whether claimed DEF is sold for TLM right away. */
const CASH_OUT_KEY = 'pd.cash-out-def'
import { publicUrl } from '@/lib/publicUrl'
import { shortDuration, useClockFor } from '@/lib/time'
import { useTransaction } from '@/wallet/useTransaction'

import './Deployments.css'

export default function Deployments() {
  const { account, run, pending } = useTransaction()
  const deployments = useDeployments(account)
  const config = useMissionConfig()
  const army = useArmy(account)
  const player = usePlayer(account)
  const templates = useTemplates()
  const market = useMarket()
  const [cashOut, setCashOut] = useState(() => {
    try {
      return localStorage.getItem(CASH_OUT_KEY) === '1'
    } catch {
      return false
    }
  })
  const toggleCashOut = () =>
    setCashOut((v) => {
      try {
        localStorage.setItem(CASH_OUT_KEY, v ? '0' : '1')
      } catch {
        /* storage unavailable: the choice lasts for this visit */
      }
      return !v
    })

  const unlocks = useMemo(() => deployments.data?.map((d) => d.unlockAt) ?? [], [deployments.data])
  const now = useClockFor(unlocks)

  const econ = useMemo(() => {
    const m = new Map<number, MissionEconomics>()
    if (config.data)
      for (const row of config.data.missions) m.set(Number(row.mission_id), missionEconomics(row, config.data, now))
    return m
  }, [config.data, now])

  const divisionById = useMemo(() => new Map(army.data?.divisions.map((d) => [d.id, d]) ?? []), [army.data])

  if (!deployments.data || !config.data) return <Loading inline label="Contacting the field" />

  const list = deployments.data
  const ready = list.filter((d) => d.unlockAt <= now)
  const running = list.filter((d) => d.unlockAt > now)
  const groups = groupByMission(list)

  /** Ready deployments whose mission is still open, so the division can go straight back out. */
  const loopable = ready.filter((d) => econ.get(d.missionId)?.state === 'active')
  const wallet = player.data ? { tlm: player.data.tlm, def: player.data.def } : null

  /**
   * Claims `claims` and sends `redeploy` back out, as one transaction. The claimed TLM and DEF land
   * before the next action runs, so they pay the new entries; DEF still missing is bought with TLM,
   * and with cash-out on, the claimed DEF the entries do not need is sold for TLM.
   */
  function cycle(claims: Deployment[], redeploy: Deployment[]) {
    const sum = (list: Deployment[], f: (e: MissionEconomics) => number) =>
      list.reduce((n, d) => n + (econ.get(d.missionId) ? f(econ.get(d.missionId)!) : 0), 0)
    const earnedTlm = sum(claims, (e) => e.rewardTlm)
    const earnedDef = sum(claims, (e) => e.rewardDef)
    const cost = { tlm: sum(redeploy, (e) => e.costTlm), def: sum(redeploy, (e) => e.costDef) }
    const after = wallet ? { tlm: wallet.tlm + earnedTlm, def: wallet.def + earnedDef } : null
    const funding = quoteFunding(market, cost, after)
    const surplusDef = cashOut ? Math.max(0, earnedDef - cost.def) : 0
    const sold = surplusDef > 0 ? tlmForDef(market, surplusDef) : 0
    const build = (a: string, p: string) => [
      ...claims.map((d) => claimMission(a, p, d.missionId, d.divisionId)),
      ...fundEntries(a, p, market, cost, after).actions,
      ...groupByMission(redeploy).flatMap(({ missionId, items }) => {
        const ids = items.map((d) => d.divisionId)
        const stale = ids.filter((id) => divisionById.get(id) && !divisionById.get(id)!.fresh)
        return deployActions(a, p, missionId, ids, stale, econ.get(missionId)!.costs)
      }),
      ...(surplusDef > 0 ? [sellDefAction(a, p, market, surplusDef).action] : [])
    ]
    return { build, funding, surplusDef, sold, earnedTlm, earnedDef }
  }

  const all = cycle(ready, [])
  const loopAll = cycle(ready, loopable)
  const readyValue = all.earnedTlm + tlmForDef(market, all.earnedDef)

  const claimAll = () =>
    run(
      all.build,
      `${ready.length} reward${ready.length === 1 ? '' : 's'} claimed${all.surplusDef > 0 ? `, ${formatToken(all.surplusDef)} DEF sold for ≈${formatToken(all.sold)} TLM` : ''}`,
      'claim-all'
    )

  const redeployAll = () =>
    run(
      loopAll.build,
      `Claimed ${ready.length} and redeployed ${loopable.length}${loopAll.surplusDef > 0 ? `, ${formatToken(loopAll.surplusDef)} DEF sold` : ''}`,
      'loop-all'
    )

  const nextReturn = running[0]?.unlockAt

  return (
    <div className="page deployments">
      <header className="deployments__top panel panel--tight">
        <div className="army__figures deployments__figures">
          <Figure label="Ready to claim" value={ready.length} tone={ready.length ? 'c-green' : ''} />
          <Figure label="On mission" value={running.length} />
          <Figure
            label="Next return"
            value={nextReturn ? <Ticking render={(t) => clock((nextReturn - t) / 1000)} /> : '–'}
            tone="c-mov"
          />
          <Figure
            label="Waiting for you"
            value={formatToken(readyValue, 'TLM')}
            tone="c-tlm"
            help="Rewards of the ready divisions in TLM, with any DEF valued at what selling it on Alcor would give."
          />
        </div>
        <div className="deployments__actions">
          <Tooltip text="Sell the DEF you claim for TLM on Alcor, in the claim transaction. When you loop, the DEF the next entries need is kept and only the rest is sold.">
            <button type="button" className={`cashout ${cashOut ? 'is-on' : ''}`} onClick={toggleCashOut} aria-pressed={cashOut}>
              <span className="cashout__knob" /> DEF → TLM
            </button>
          </Tooltip>
          <button
            type="button"
            className={`icon-btn ${deployments.isFetching ? 'is-spinning' : ''}`}
            title="Refresh"
            onClick={() => void deployments.refetch()}
          >
            <RefreshIcon />
          </button>
          <Button color="ghost" size="sm" disabled={!ready.length} isLoading={pending === 'claim-all'} onClick={claimAll}>
            <GiftIcon /> Claim all ({ready.length})
          </Button>
          <Tooltip
            text={
              loopable.length
                ? `Claims every ready reward and sends those divisions back to the same missions in one transaction. Rewards pay the new entries first${loopAll.funding.defBought > 0 ? `; ${formatToken(loopAll.funding.defBought)} DEF is bought with TLM` : ''}${loopAll.surplusDef > 0 ? `; ${formatToken(loopAll.surplusDef)} spare DEF is sold for ≈${formatToken(loopAll.sold)} TLM` : ''}.`
                : 'Nothing ready whose mission is still open.'
            }
          >
            <Button
              color="gradientYellow"
              size="sm"
              disabled={!loopable.length || !loopAll.funding.affordable}
              isLoading={pending === 'loop-all'}
              onClick={redeployAll}
            >
              <RocketIcon /> Claim & redeploy ({loopable.length})
            </Button>
          </Tooltip>
        </div>
      </header>

      {list.length === 0 ? (
        <div className="empty deployments__empty">
          <strong>No division is out right now</strong>
          <span>
            Pick a loop on the <Link to="/missions">Missions</Link> page: the best one for your army is highlighted at the top.
          </span>
        </div>
      ) : (
        <div className="dgrid">
          {groups.map(({ missionId, items }) => {
            const e = econ.get(missionId)
            const readyHere = items.filter((d) => d.unlockAt <= now)
            const nftName = e?.rewardNft ? templates.data?.[String(e.rewardNft.templateId)]?.name : undefined
            return (
              <article key={missionId} className={`dcard ${readyHere.length ? 'has-ready' : ''}`}>
                <div className="dcard__visual">
                  <IpfsImg hash={e?.image} alt="" fallback={publicUrl('/img/mission-fallback.webp')} />
                  <div className="dcard__over">
                    <span className="dcard__op">
                      <PlanetIcon planet={e?.planet ?? ''} size={14} /> {titleCase(e?.planet ?? '')} · OP-
                      {String(missionId).padStart(3, '0')}
                    </span>
                    <h3>{e?.title ?? `Mission #${missionId}`}</h3>
                  </div>
                  {readyHere.length > 0 && (
                    <span className="dcard__ready">
                      <GiftIcon width={12} height={12} /> {readyHere.length} ready
                    </span>
                  )}
                </div>
                <div className="dcard__body">
                  <p className="dcard__reward">
                    <span className="faint">Per division</span>{' '}
                    <b className="c-tlm">{e ? rewardParts(e, nftName).join(' + ') || 'no reward data' : '…'}</b>
                    {e && costParts(e).length > 0 && <span className="faint"> · entry {costParts(e).join(' + ')}</span>}
                    {e && e.state !== 'active' && <span className="chip chip--red">mission {e.state}</span>}
                  </p>
                  <ul className="dlist">
                    {items.map((d) => {
                      const total = Math.max(1, d.unlockAt - d.joinedAt)
                      const isReady = d.unlockAt <= now
                      const canLoop = isReady && e?.state === 'active'
                      return (
                        <li key={`${d.missionId}-${d.divisionId}`} className={`dline ${isReady ? 'is-ready' : ''}`}>
                          <div className="dline__who">
                            <b>#{d.divisionId}</b>
                            <StatTrio atk={d.entry.atk} def={d.entry.def} move={d.entry.movecost} size="sm" />
                          </div>
                          <div className="dline__time">
                            {isReady ? (
                              <span className="dline__done">
                                <GiftIcon width={13} height={13} /> Ready
                              </span>
                            ) : (
                              <>
                                <span className="progress progress--gold">
                                  <Ticking
                                    render={(t) => (
                                      <span style={{ width: `${Math.min(100, ((t - d.joinedAt) / total) * 100)}%` }} />
                                    )}
                                  />
                                </span>
                                <span className="dline__count num">
                                  <TimerIcon width={12} height={12} /> <Ticking render={(t) => clock((d.unlockAt - t) / 1000)} />
                                  <small className="faint">of {formatDuration(total / 1000)}</small>
                                </span>
                              </>
                            )}
                          </div>
                          <div className="dline__act">
                            <Button
                              size="sm"
                              color={isReady ? 'gradientGreen' : 'ghost'}
                              disabled={!isReady}
                              isLoading={pending === `claim-${d.divisionId}`}
                              onClick={() =>
                                run(cycle([d], []).build, `Division #${d.divisionId} claimed`, `claim-${d.divisionId}`)
                              }
                            >
                              Claim
                            </Button>
                            {canLoop && e && (
                              <Tooltip
                                text={`Claim and send #${d.divisionId} straight back (${formatDuration((d.unlockAt - d.joinedAt) / 1000)} lock, ${formatSigned(cycleNet(e, market), 'TLM')} net per cycle after swaps).`}
                              >
                                <Button
                                  size="sm"
                                  color="gradientYellow"
                                  disabled={!cycle([d], [d]).funding.affordable}
                                  isLoading={pending === `loop-${d.divisionId}`}
                                  onClick={() =>
                                    run(cycle([d], [d]).build, `#${d.divisionId} claimed and redeployed`, `loop-${d.divisionId}`)
                                  }
                                >
                                  <RocketIcon /> Loop
                                </Button>
                              </Tooltip>
                            )}
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                  {e && Number.isFinite(e.endAt) && (
                    <p className="faint dcard__foot">Mission window ends in {shortDuration(e.endAt - now)}</p>
                  )}
                </div>
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}

function groupByMission(list: Deployment[]): { missionId: number; items: Deployment[] }[] {
  const m = new Map<number, Deployment[]>()
  for (const d of list) m.set(d.missionId, [...(m.get(d.missionId) ?? []), d])
  // Missions with something to claim first, then by the soonest return.
  return [...m.entries()]
    .map(([missionId, items]) => ({ missionId, items: items.sort((a, b) => a.unlockAt - b.unlockAt) }))
    .sort((a, b) => a.items[0].unlockAt - b.items[0].unlockAt)
}
