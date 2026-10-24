import { useState } from 'react'
import { Link } from 'react-router-dom'

import { IpfsImg, PlanetIcon } from '@/components/Art'
import { Button } from '@/components/Button'
import { Loading } from '@/components/Loading'
import { Figure, StatTrio } from '@/components/Stat'
import { Ticking } from '@/components/Ticking'
import { Tooltip } from '@/components/Tooltip'
import { useDeployments, useMarket, useMissionConfig, useTemplates } from '@/data/game'
import { GiftIcon, RefreshIcon, RocketIcon, TimerIcon } from '@/icons'
import { clock, formatDuration, formatSigned, formatToken } from '@/lib/format'
import { costParts, cycleNet, rewardParts } from '@/lib/loop'
import { tlmForDef } from '@/lib/market'
import { CASH_OUT_KEY, readCashOut, useLoopPlan } from '@/lib/useLoop'
import { publicUrl } from '@/lib/publicUrl'
import { useTransaction } from '@/wallet/useTransaction'

import { DeploymentTimeline } from './DeploymentsTimeline'

import './Deployments.css'

const hhmm = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export default function Deployments() {
  const { account, run, runSequence, pending } = useTransaction()
  const deployments = useDeployments(account)
  const config = useMissionConfig()
  const templates = useTemplates()
  const market = useMarket()
  const [cashOut, setCashOut] = useState(readCashOut)
  /** Divisions picked on the timeline (or in the list), highlighted in both. */
  const [picked, setPicked] = useState<Set<string>>(() => new Set())
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
  // One row per division out, in the order they come back.
  const rows = [...list]
    .sort((a, b) => a.unlockAt - b.unlockAt)
    .map((d) => {
      const e = econ.get(d.missionId)
      const nftName = e?.rewardNft ? templates.data?.[String(e.rewardNft.templateId)]?.name : undefined
      return {
        key: `${d.missionId}-${d.divisionId}`,
        d,
        e,
        reward: e ? rewardParts(e, nftName).join(' + ') : '',
        value: e ? e.rewardTlm + tlmForDef(market, e.rewardDef) : 0
      }
    })

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

  const redeployAll = () =>
    runSequence(loopAll.parts, 'loop-all', `Looping ${loopable.length} division${loopable.length === 1 ? '' : 's'}`)

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
        <section className="dret">
          <DeploymentTimeline
            items={rows.map((r) => ({ key: r.key, deployment: r.d, value: r.value, label: `#${r.d.divisionId} ${r.reward}` }))}
            selected={picked}
            onPick={(keys) =>
              setPicked((cur) => (keys.every((k) => cur.has(k)) && cur.size === keys.length ? new Set() : new Set(keys)))
            }
          />
          <ul className="dret__list">
            {rows.map(({ key, d, e, reward }) => {
              const total = Math.max(1, d.unlockAt - d.joinedAt)
              const isReady = d.unlockAt <= now
              const canLoop = isReady && e?.state === 'active'
              const div = divisionById.get(d.divisionId)
              return (
                <li
                  key={key}
                  className={`dret__row${isReady ? ' is-ready' : ''}${picked.has(key) ? ' is-on' : ''}`}
                  onClick={(ev) => {
                    if ((ev.target as HTMLElement).closest('button')) return
                    setPicked((cur) => (cur.has(key) && cur.size === 1 ? new Set() : new Set([key])))
                  }}
                >
                  <span className="dret__art">
                    <IpfsImg hash={e?.image} alt="" fallback={publicUrl('/img/mission-fallback.webp')} />
                  </span>
                  <div className="dret__who">
                    <b>{e?.title ?? `Mission #${d.missionId}`}</b>
                    <span>
                      <PlanetIcon planet={e?.planet ?? ''} size={12} /> Division #{d.divisionId}
                      <StatTrio
                        atk={d.entry?.atk ?? div?.atk ?? 0}
                        def={d.entry?.def ?? div?.def ?? 0}
                        move={d.entry?.movecost ?? div?.move ?? 0}
                        size="sm"
                      />
                      {e && e.state !== 'active' && <span className="chip chip--red">mission {e.state}</span>}
                    </span>
                  </div>
                  <div className="dret__bring">
                    <b className="c-tlm">{reward || '…'}</b>
                    {e && costParts(e).length > 0 && <small className="faint">entry {costParts(e).join(' + ')}</small>}
                  </div>
                  <div className="dret__time">
                    {isReady ? (
                      <span className="dret__done">
                        <GiftIcon width={13} height={13} /> Back since {hhmm(d.unlockAt)}
                      </span>
                    ) : (
                      <>
                        <span className="dret__count num">
                          <TimerIcon width={12} height={12} /> <Ticking render={(t) => clock((d.unlockAt - t) / 1000)} />
                          <small className="faint">at {hhmm(d.unlockAt)}</small>
                        </span>
                        <span className="progress progress--gold">
                          <Ticking
                            render={(t) => <span style={{ width: `${Math.min(100, ((t - d.joinedAt) / total) * 100)}%` }} />}
                          />
                        </span>
                      </>
                    )}
                  </div>
                  <div className="dret__act">
                    <Button
                      size="sm"
                      color={isReady ? 'gradientGreen' : 'ghost'}
                      disabled={!isReady}
                      isLoading={pending === `claim-${d.divisionId}`}
                      onClick={() => run(cycle([d], []).build, `Division #${d.divisionId} claimed`, `claim-${d.divisionId}`)}
                    >
                      <GiftIcon /> Claim
                    </Button>
                    <Tooltip
                      text={
                        !isReady
                          ? `Claims and sends #${d.divisionId} straight back once it returns.`
                          : !canLoop
                            ? 'The mission is no longer open: claim only.'
                            : `Claim and send #${d.divisionId} straight back (${formatDuration((d.unlockAt - d.joinedAt) / 1000)} lock${e ? `, ${formatSigned(cycleNet(e, market), 'TLM')} net per cycle after swaps` : ''}).`
                      }
                    >
                      <Button
                        size="sm"
                        color={canLoop ? 'gradientYellow' : 'ghost'}
                        disabled={!canLoop || !cycle([d], [d]).funding.affordable}
                        isLoading={pending === `loop-${d.divisionId}`}
                        onClick={() =>
                          run(cycle([d], [d]).build, `#${d.divisionId} claimed and redeployed`, `loop-${d.divisionId}`)
                        }
                      >
                        <RocketIcon /> Loop
                      </Button>
                    </Tooltip>
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </div>
  )
}
