import { useState } from 'react'
import { Link } from 'react-router-dom'

import { IpfsImg, PlanetIcon } from '@/components/Art'
import { Button } from '@/components/Button'
import { Loading } from '@/components/Loading'
import { Figure, StatTrio } from '@/components/Stat'
import { Ticking } from '@/components/Ticking'
import { Tooltip } from '@/components/Tooltip'
import { useDeployments, useMarket, useMissionConfig, useTemplates, type Deployment } from '@/data/game'
import { GiftIcon, RefreshIcon, RocketIcon, TimerIcon } from '@/icons'
import { clock, formatDuration, formatSigned, formatToken, titleCase } from '@/lib/format'
import { costParts, cycleNet, rewardParts } from '@/lib/loop'
import { tlmForDef } from '@/lib/market'
import { CASH_OUT_KEY, readCashOut, useLoopPlan } from '@/lib/useLoop'
import { publicUrl } from '@/lib/publicUrl'
import { shortDuration } from '@/lib/time'
import { useTransaction } from '@/wallet/useTransaction'

import './Deployments.css'

export default function Deployments() {
  const { account, run, runSequence, pending } = useTransaction()
  const deployments = useDeployments(account)
  const config = useMissionConfig()
  const templates = useTemplates()
  const market = useMarket()
  const [cashOut, setCashOut] = useState(readCashOut)
  const toggleCashOut = () =>
    setCashOut((v) => {
      try {
        localStorage.setItem(CASH_OUT_KEY, v ? '0' : '1')
      } catch {
        /* storage unavailable: the choice lasts for this visit */
      }
      return !v
    })

  const { now, econ, divisionById, cycle } = useLoopPlan(account, cashOut)

  if (!deployments.data || !config.data) return <Loading inline label="Contacting the field" />

  const list = deployments.data
  const ready = list.filter((d) => d.unlockAt <= now)
  const running = list.filter((d) => d.unlockAt > now)
  const groups = groupByMission(list)

  /** Ready deployments whose mission is still open, so the division can go straight back out. */
  const loopable = ready.filter((d) => econ.get(d.missionId)?.state === 'active')

  const all = cycle(ready, [])
  const loopAll = cycle(ready, loopable)
  const readyValue = all.earnedTlm + tlmForDef(market, all.earnedDef)

  const claimAll = () =>
    run(
      all.build,
      `${ready.length} reward${ready.length === 1 ? '' : 's'} claimed${all.surplusDef > 0 ? `, ${formatToken(all.surplusDef)} DEF sold for ≈${formatToken(all.sold)} TLM` : ''}`,
      'claim-all'
    )

  const redeployAll = () => runSequence(loopAll.parts, 'loop-all')

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
                ? `Claims every ready reward and sends those divisions back to the same missions: the claims in one transaction, then one per division (the contract takes one join at a time). Rewards pay the new entries first${loopAll.funding.defBought > 0 ? `; ${formatToken(loopAll.funding.defBought)} DEF is bought with TLM` : ''}${loopAll.surplusDef > 0 ? `; ${formatToken(loopAll.surplusDef)} spare DEF is sold for ≈${formatToken(loopAll.sold)} TLM` : ''}.`
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
                            <StatTrio
                              atk={d.entry?.atk ?? divisionById.get(d.divisionId)?.atk ?? 0}
                              def={d.entry?.def ?? divisionById.get(d.divisionId)?.def ?? 0}
                              move={d.entry?.movecost ?? divisionById.get(d.divisionId)?.move ?? 0}
                              size="sm"
                            />
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
