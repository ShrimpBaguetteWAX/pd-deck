import { useMemo, useState } from 'react'

import { addUnit, assignGear, createDivision } from '@/chain/actions/pd'
import { CardArt, PlanetIcon } from '@/components/Art'
import { Button } from '@/components/Button'
import { Modal } from '@/components/Modal'
import { StatTrio } from '@/components/Stat'
import { toast } from '@/components/toast'
import { Tooltip } from '@/components/Tooltip'
import type { AssetRef } from '@/data/assets'
import { useArmy, type Division } from '@/data/game'
import { CheckIcon, TimerIcon, XIcon } from '@/icons'
import { bestLoop, candidateMissions, poolOf, type OptimizeInput } from '@/lib/armyOptimizer'
import type { SlotKind } from '@/lib/bundle'
import { SLOT_POWERUP } from '@/lib/forgeEconomy'
import { formatDuration, formatNumber } from '@/lib/format'
import type { MissionEconomics } from '@/lib/loop'
import type { Market } from '@/lib/market'
import { GEAR_KINDS, missionLockSeconds, type Kind } from '@/lib/stats'
import { useArmyOptimizer } from '@/lib/useArmyOptimizer'
import { useTransaction } from '@/wallet/useTransaction'

import { disbandActions, MissionStrip } from './ArmyMissions'

/*
 * "Optimize for missions": the army rebuilt from everything staked so that it earns the most TLM
 * per hour from the missions on offer. Three transactions: disband the divisions that can be
 * disbanded, create the new ones, then add every mercenary and its gear. Divisions out on a
 * mission (or waiting for a claim) cannot be touched and stay as they are.
 */

type Step = 'disband' | 'create' | 'fill'

/** The player's choices survive reopening the dialog. */
const STORE_OFF = 'pd:optimize:missions-off'
const STORE_ALIGN = 'pd:optimize:align-move'
const readStore = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}
const writeStore = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Private windows and full storage: the choice just does not persist.
  }
}
interface Run {
  /** Steps still to do, in order. */
  steps: Step[]
  done: Step[]
  failed: Step | null
  /** New division ids by warlord asset id, known after "create". */
  created: Map<string, number>
}

export function OptimizeArmyModal({
  account,
  divisions,
  disbandable,
  free,
  forgeLevel,
  powerups,
  allowance,
  missions,
  market,
  onClose,
  onDone
}: {
  account: string | null
  divisions: Division[]
  /** Which divisions may be taken apart (idle or empty). */
  disbandable: (d: Division) => boolean
  free: Record<Kind, AssetRef[]>
  forgeLevel: number
  powerups: Map<string, number>
  allowance: number
  missions: MissionEconomics[]
  market: Market
  onClose: () => void
  onDone: (firstDivisionId: number | null) => void
}) {
  const army = useArmy(account)
  const { run, pending, spectating } = useTransaction()
  const [runState, setRunState] = useState<Run | null>(null)

  const rearrange = useMemo(() => divisions.filter(disbandable), [divisions, disbandable])
  const kept = useMemo(() => divisions.filter((d) => !disbandable(d)), [divisions, disbandable])

  // Which missions may be fielded (all by default), and whether move costs are matched per mission length.
  const candidates = useMemo(() => candidateMissions(missions), [missions])
  const [off, setOff] = useState<Set<number>>(() => new Set(readStore<number[]>(STORE_OFF, [])))
  const [alignMove, setAlignMove] = useState<boolean>(() => readStore<boolean>(STORE_ALIGN, false))
  const toggleMission = (id: number) =>
    setOff((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      writeStore(STORE_OFF, [...next])
      return next
    })
  const setAllMissions = (on: boolean) => {
    const next = on ? new Set<number>() : new Set(candidates.map((m) => m.id))
    writeStore(STORE_OFF, [...next])
    setOff(next)
  }
  const toggleAlign = () =>
    setAlignMove((v) => {
      writeStore(STORE_ALIGN, !v)
      return !v
    })
  const chosenMissions = useMemo(() => missions.filter((m) => !off.has(m.id)), [missions, off])

  const input = useMemo<OptimizeInput>(() => {
    const usedByKept = { weapon: 0, supply: 0, lavalux: 0 }
    for (const d of kept)
      for (const u of d.units) for (const k of ['weapon', 'supply', 'lavalux'] as SlotKind[]) if (u.gear[k]) usedByKept[k]++
    const slotsFree = Object.fromEntries(
      (['weapon', 'supply', 'lavalux'] as SlotKind[]).map((k) => [
        k,
        Math.max(0, (powerups.get(SLOT_POWERUP[k]) ?? 0) - usedByKept[k])
      ])
    ) as Record<SlotKind, number>
    return {
      pool: poolOf(free, rearrange),
      existing: rearrange,
      missions: chosenMissions,
      market,
      forgeLevel,
      slotsFree,
      maxDivisions: Math.max(0, allowance - kept.length),
      alignMove
    }
  }, [free, rearrange, kept, chosenMissions, market, forgeLevel, powerups, allowance, alignMove])
  const optimizer = useArmyOptimizer(input)
  const plan = optimizer.plan

  // What the army earns now, and what the untouched divisions keep earning.
  const perHourOf = (list: Division[]) =>
    list.reduce((n, d) => n + (d.units.length ? (bestLoop(d, missions, market)?.perHour ?? 0) : 0), 0)
  const currentPerHour = perHourOf(divisions)
  const keptPerHour = perHourOf(kept)
  const optimizedPerHour = plan ? keptPerHour + plan.perHour : null
  const gain = optimizedPerHour === null ? null : optimizedPerHour - currentPerHour

  // Divisions the plan keeps as they are stay untouched; only the rest is taken apart and rebuilt.
  const keptIds = useMemo(
    () => new Set((plan?.divisions ?? []).flatMap((d) => (d.existingId != null ? [d.existingId] : []))),
    [plan]
  )
  const toDisband = rearrange.filter((d) => !keptIds.has(d.id))
  const fresh = (plan?.divisions ?? []).filter((d) => d.existingId == null)
  const nothingToDo = !!plan && fresh.length === 0 && toDisband.length === 0

  const steps: Step[] = [
    ...(toDisband.length ? (['disband'] as Step[]) : []),
    ...(fresh.length ? (['create', 'fill'] as Step[]) : [])
  ]
  const state: Run = runState ?? { steps, done: [], failed: null, created: new Map() }
  const busy = pending === 'optimize'
  const finished = state.done.length === steps.length && steps.length > 0 && !!plan

  async function execute(from: Run) {
    let cur: Run = { ...from, failed: null }
    setRunState(cur)
    const leaders = fresh.map((d) => d.plan.assets.get(d.plan.bundle.warlord.key)!.assetId)
    for (const step of steps) {
      if (cur.done.includes(step)) continue
      let ok = false
      if (step === 'disband') {
        ok = await run(
          (a, p) => toDisband.flatMap((d) => disbandActions(a, p, d)),
          `${toDisband.length} division${toDisband.length === 1 ? '' : 's'} disbanded`,
          'optimize'
        )
      } else if (step === 'create') {
        ok = await run(
          (a, p) => leaders.map((leader) => createDivision(a, p, leader)),
          `${leaders.length} division${leaders.length === 1 ? '' : 's'} created`,
          'optimize'
        )
        if (ok) {
          // The new ids are only known once the chain has them.
          const created = new Map<string, number>()
          for (let i = 0; i < 10 && created.size < leaders.length; i++) {
            const fresh = await army.refetch()
            for (const d of fresh.data?.divisions ?? [])
              if (d.leader && leaders.includes(d.leader.assetId)) created.set(d.leader.assetId, d.id)
            if (created.size < leaders.length) await new Promise((r) => setTimeout(r, 1500))
          }
          if (created.size < leaders.length) {
            toast.error('The new divisions have not all shown up yet. Wait a moment and press Resume.')
            ok = false
          }
          cur = { ...cur, created }
        }
      } else {
        const created = cur.created
        ok = await run(
          (a, p) =>
            fresh.flatMap((d) => {
              const id = created.get(d.plan.assets.get(d.plan.bundle.warlord.key)!.assetId)!
              const asset = (key: string) => d.plan.assets.get(key)!.assetId
              return [
                ...d.plan.bundle.units.map((u) => addUnit(a, p, id, asset(u.merc.key))),
                ...d.plan.bundle.units.flatMap((u) =>
                  GEAR_KINDS.filter((k) => u.gear[k]).map((k) =>
                    assignGear(a, p, id, asset(u.merc.key), k, asset(u.gear[k]!.key))
                  )
                )
              ]
            }),
          `${fresh.length} division${fresh.length === 1 ? '' : 's'} filled and equipped: about ${formatNumber(optimizedPerHour ?? 0, 1)} TLM an hour`,
          'optimize'
        )
      }
      if (!ok) {
        cur = { ...cur, failed: step }
        setRunState(cur)
        return
      }
      cur = { ...cur, done: [...cur.done, step] }
      setRunState(cur)
    }
  }

  const stepLabel = (s: Step) =>
    s === 'disband'
      ? `Disband ${toDisband.length} division${toDisband.length === 1 ? '' : 's'}`
      : s === 'create'
        ? `Create ${fresh.length} division${fresh.length === 1 ? '' : 's'}`
        : 'Add the mercenaries and their gear'

  return (
    <Modal className="picker opt" onClose={onClose} label="Optimize for missions" locked={busy}>
      <header className="picker__head">
        <div>
          <p className="eyebrow">From everything staked</p>
          <h3>Optimize for missions</h3>
          <p className="muted">
            The army that earns the most TLM an hour from the missions on offer, built from your staked NFTs. Rewards are flat per
            division and cycle, so it fields as many divisions as pay, each just strong enough for its mission and as quick as it
            can be.
          </p>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" disabled={busy}>
          <XIcon />
        </button>
      </header>

      <div className="opt__compare">
        <div className="opt__figure">
          <span className="faint">Now</span>
          <b className="num">{formatNumber(currentPerHour, 1)}</b>
          <small className="faint">TLM / h · {divisions.filter((d) => d.units.length).length} divisions</small>
        </div>
        <span className="opt__arrow">→</span>
        <div className={`opt__figure ${gain === null ? '' : gain > 0 ? 'is-up' : 'is-flat'}`}>
          <span className="faint">Optimized</span>
          <b className="num">{optimizedPerHour === null ? '…' : formatNumber(optimizedPerHour, 1)}</b>
          <small className="faint">
            {plan ? `TLM / h · ${kept.length + plan.divisions.length} divisions` : 'planning…'}
            {gain !== null && ` · ${gain >= 0 ? '+' : ''}${formatNumber(gain, 1)}`}
          </small>
        </div>
      </div>

      <div className="opt__options">
        <div className="opt__missions">
          <span className="opt__label">
            Missions
            <button type="button" className="mk-link" disabled={busy || off.size === 0} onClick={() => setAllMissions(true)}>
              all
            </button>
            <button
              type="button"
              className="mk-link"
              disabled={busy || off.size >= candidates.length}
              onClick={() => setAllMissions(false)}
            >
              none
            </button>
          </span>
          <span className="opt__chips">
            {candidates.map((m) => {
              const on = !off.has(m.id)
              return (
                <Tooltip
                  key={m.id}
                  text={`${m.title}: needs ${formatNumber(m.minAtk, 0)} ATK${m.minDef ? ` / ${formatNumber(m.minDef, 0)} DEF` : ''}, ${formatDuration(m.cooldownBase)} base. ${on ? 'Click to leave it out.' : 'Click to allow it.'}`}
                >
                  <button
                    type="button"
                    className={`opt__chip ${on ? 'is-on' : ''}`}
                    aria-pressed={on}
                    disabled={busy}
                    onClick={() => toggleMission(m.id)}
                  >
                    <PlanetIcon planet={m.planet} size={13} /> {m.title}
                  </button>
                </Tooltip>
              )
            })}
          </span>
        </div>
        <label className={`opt__check ${alignMove ? 'is-on' : ''}`}>
          <input type="checkbox" checked={alignMove} disabled={busy} onChange={toggleAlign} />
          <span>
            <b>Match move costs</b>
            <small className="faint">
              Divisions on missions of the same length get similar move costs, so they return together and can be claimed and sent
              out again as one.
            </small>
          </span>
        </label>
      </div>

      {kept.length > 0 && (
        <p className="opt__kept faint">
          {kept.length} division{kept.length === 1 ? ' is' : 's are'} out on a mission or waiting for a claim and cannot be
          changed now: {kept.length === 1 ? 'it stays' : 'they stay'} as {kept.length === 1 ? 'it is' : 'they are'} (about{' '}
          {formatNumber(keptPerHour, 1)} TLM / h of the total).
        </p>
      )}

      {optimizer.running ? (
        <p className="opt__planning">
          <span className="spinner" />{' '}
          {optimizer.progress
            ? `Planning, approach ${optimizer.progress.strategyIndex + 1} of 3, division ${optimizer.progress.division}…`
            : 'Planning…'}
        </p>
      ) : !plan || plan.divisions.length === 0 ? (
        <div className="empty">
          <strong>Nothing to field</strong>
          <span>
            {input.maxDivisions <= 0
              ? 'Every division slot is taken by a division that is out right now.'
              : off.size >= candidates.length
                ? 'Every mission is left out. Allow at least one above.'
                : 'No staked warlord and mercenaries together reach a mission that pays TLM among the ones allowed.'}
          </span>
        </div>
      ) : (
        <>
          <ul className="opt__list">
            {plan.divisions.map((d, i) => {
              const b = d.plan.bundle
              const warlord = d.plan.assets.get(b.warlord.key)!
              const gear = GEAR_KINDS.reduce((n, k) => n + b.gear[k].length, 0)
              return (
                <li key={i} className="opt__row">
                  <CardArt asset={warlord} shape="square" className="opt__leader" />
                  <div className="opt__body">
                    <div className="opt__title">
                      <PlanetIcon planet={d.mission.planet} size={16} />
                      <b>{d.mission.title}</b>
                      {d.existingId != null && (
                        <Tooltip text={`Division #${d.existingId} as it is now: it is not taken apart.`}>
                          <span className="chip chip--green">kept as is</span>
                        </Tooltip>
                      )}
                      <small className="faint">
                        needs {formatNumber(d.mission.minAtk, 0)} ATK
                        {d.mission.minDef ? ` / ${formatNumber(d.mission.minDef, 0)} DEF` : ''}
                      </small>
                    </div>
                    <div className="opt__meta">
                      <StatTrio atk={b.atk} def={b.def} move={b.move} size="sm" />
                      <span className="faint">
                        <TimerIcon width={11} height={11} /> {formatDuration(missionLockSeconds(d.mission.cooldownBase, b.move))}{' '}
                        · {b.mercs.length} of {b.warlord.slots} slots · {gear} gear
                      </span>
                    </div>
                    <MissionStrip plan={d.plan} pending={false} gearNote={false} />
                  </div>
                  <Tooltip text="Net TLM an hour of this division's time on this mission, after entry fees and DEF swaps.">
                    <b className="opt__rate num c-green">{formatNumber(d.perHour, 2)}</b>
                  </Tooltip>
                </li>
              )
            })}
          </ul>

          <ol className="opt__steps">
            {steps.map((s, i) => {
              const done = state.done.includes(s)
              const now = !done && state.done.length === i
              return (
                <li key={s} className={done ? 'is-done' : state.failed === s ? 'is-failed' : now && busy ? 'is-now' : ''}>
                  {done ? <CheckIcon width={14} height={14} /> : <span className="opt__dot">{i + 1}</span>} {stepLabel(s)}
                </li>
              )
            })}
          </ol>

          <footer className="picker__foot">
            {finished ? (
              <>
                <span className="c-green">Done. The new divisions are ready to deploy from the Missions page.</span>
                <Button color="gradientYellow" onClick={() => onDone(state.created.values().next().value ?? null)}>
                  Show the army
                </Button>
              </>
            ) : state.failed ? (
              <>
                <span className="c-red">
                  Step {steps.indexOf(state.failed) + 1} did not go through. The steps before it are done and stay done.
                </span>
                <Button color="gradientYellow" disabled={spectating} isLoading={busy} onClick={() => void execute(state)}>
                  Resume at step {steps.indexOf(state.failed) + 1}
                </Button>
              </>
            ) : nothingToDo || (gain !== null && gain <= 0.05) ? (
              <span className="c-green">Your army already earns the most this search can find. Nothing to change.</span>
            ) : (
              <>
                <span className="faint">
                  {steps.length} transaction{steps.length === 1 ? '' : 's'}: {steps.map(stepLabel).join(', ').toLowerCase()}.
                  {keptIds.size > 0 &&
                    ` ${keptIds.size} division${keptIds.size === 1 ? ' stays' : 's stay'} as ${keptIds.size === 1 ? 'it is' : 'they are'}.`}
                </span>
                <Button color="gradientYellow" disabled={spectating} isLoading={busy} onClick={() => void execute(state)}>
                  Rebuild the army
                </Button>
              </>
            )}
          </footer>
        </>
      )}
    </Modal>
  )
}
