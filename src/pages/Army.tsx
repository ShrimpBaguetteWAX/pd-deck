import { useEffect, useMemo, useState, type CSSProperties, useRef } from 'react'
import { Link } from 'react-router-dom'

import { addUnit, assignGear, createDivision, removeUnit, stakeAssets, unassignGear, unstakeAsset } from '@/chain/actions/pd'
import { CardArt, rarityColor } from '@/components/Art'
import { Button } from '@/components/Button'
import { Loading } from '@/components/Loading'
import { Modal } from '@/components/Modal'
import { Figure, StatTrio } from '@/components/Stat'
import { Ticking } from '@/components/Ticking'
import { Tooltip } from '@/components/Tooltip'
import type { AssetRef } from '@/data/assets'
import {
  useArmy,
  useDeployments,
  useMarket,
  useMissionConfig,
  usePlayer,
  useWalletNfts,
  type Division,
  type Unit
} from '@/data/game'
import { CheckIcon, ChevronIcon, GiftIcon, LockIcon, PlusIcon, SparkIcon, TimerIcon, XIcon } from '@/icons'
import { bestLoop } from '@/lib/armyOptimizer'
import { formatDuration, formatNumber } from '@/lib/format'
import { missionEconomics } from '@/lib/loop'
import { GEAR_KINDS, KIND_LABEL, missionLockSeconds, power, unitTotals, type GearKind, type Kind } from '@/lib/stats'
import { chainDate, shortDuration, useClockFor } from '@/lib/time'
import { useTransaction } from '@/wallet/useTransaction'

import { DisbandAllModal, MissionDivisionModal, disbandActions } from './ArmyMissions'
import { OptimizeArmyModal } from './ArmyOptimize'

import { divisionAllowance, FREE_DIVISIONS } from '@/chain/config'

import './Army.css'

/** Which forge purchase caps each gear kind; creatures need no slot. */
const GEAR_POWERUP: Record<GearKind, string | null> = {
  weapon: 'eqpslot',
  supply: 'supslot',
  creature: null,
  lavalux: 'lavaslot'
}

const GEAR_HELP: Record<GearKind, string> = {
  weapon: 'Equipment adds flat attack and defense. Needs a free equipment slot from the Forge.',
  supply:
    'A supply adds attack and defense and lowers this mercenary’s move cost, so its missions cool down faster. Needs a supply slot.',
  creature: 'A creature adds attack and defense. Higher tiers need a higher forge level; no slot purchase needed.',
  lavalux:
    'A Lava Lux pass multiplies attack and defense (×1.16 to ×1.70) and also raises move cost. Best on your strongest mercenaries. Needs a Lavalux slot.'
}

const byPower = (a: AssetRef, b: AssetRef) => power(b.stats) - power(a.stats)

export default function Army() {
  const { account, run, pending } = useTransaction()
  const army = useArmy(account)
  const player = usePlayer(account)
  const deployments = useDeployments(account)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [picker, setPicker] = useState<{ kind: Kind; unit?: Unit } | null>(null)
  const [stakeOpen, setStakeOpen] = useState<false | 'stake' | 'unstake'>(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [preview, setPreview] = useState<AutoPlan | null>(null)
  const [disbandAllOpen, setDisbandAllOpen] = useState(false)
  const [missionOpen, setMissionOpen] = useState(false)
  const [optimizeOpen, setOptimizeOpen] = useState(false)
  const config = useMissionConfig()
  const market = useMarket()

  const divisions = army.data?.divisions ?? []
  const selected = divisions.find((d) => d.id === selectedId) ?? divisions[0] ?? null

  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id)
  }, [selected, selectedId])

  const readyByDivision = useMemo(() => {
    const m = new Map<number, number>()
    for (const d of deployments.data ?? []) m.set(d.divisionId, d.unlockAt)
    return m
  }, [deployments.data])
  const now = useClockFor([...readyByDivision.values()])

  // Every mission as the loop planner sees it, for what each division earns.
  const missions = useMemo(
    () => (config.data ? config.data.missions.map((row) => missionEconomics(row, config.data!)) : []),
    [config.data]
  )

  if (!army.data || !player.data) return <Loading inline label="Mustering the army" />

  const { free, gearUsed } = army.data
  const forgeLevel = player.data.forgeLevel
  const allowance = divisionAllowance(player.data.powerups)
  const atLimit = divisions.length >= allowance
  const limitNote = `All ${allowance} division slots are in use. Buy a Division slot in the Forge, or disband a division, first.`
  const powerups = player.data.powerups
  const gearBudget = (kind: GearKind) => {
    const key = GEAR_POWERUP[kind]
    if (!key) return Infinity
    return (powerups.get(key) ?? 0) - gearUsed[kind]
  }
  const usable = (a: AssetRef) => (a.stats?.min_forge_level ?? 0) <= forgeLevel

  const totals = divisions.reduce(
    (t, d) => ({
      atk: t.atk + d.atk,
      def: t.def + d.def,
      move: t.move + d.move
    }),
    { atk: 0, def: 0, move: 0 }
  )
  // What the army earns now: each division on the mission that pays it the most per hour.
  const currentPerHour = divisions.reduce((n, d) => n + (d.units.length ? (bestLoop(d, missions, market)?.perHour ?? 0) : 0), 0)
  const freeUnits = free.mercenary.length
  const freeGear = free.weapon.length + free.supply.length + free.creature.length + free.lavalux.length

  const stateOf = (d: Division): { label: string; tone: string; until?: number } => {
    const unlock = readyByDivision.get(d.id)
    if (unlock !== undefined)
      return unlock <= now
        ? { label: 'Ready to claim', tone: 'is-ready' }
        : { label: 'On mission', tone: 'is-away', until: unlock }
    if (d.lock && +chainDate(d.lock.locked_until) > now)
      return {
        label: 'On mission',
        tone: 'is-away',
        until: +chainDate(d.lock.locked_until)
      }
    if (d.units.length === 0) return { label: 'Empty', tone: 'is-empty' }
    return { label: 'Idle', tone: 'is-idle' }
  }

  // ---- One-click helpers ----------------------------------------------------------------------

  /** Auto-fill's plan: the strongest free mercenaries for every empty slot. Shown before signing. */
  function autoFill(d: Division) {
    const n = Math.max(0, d.slotsMax - d.units.length)
    const picks = [...free.mercenary].sort(byPower).slice(0, n)
    if (picks.length) setPreview({ mode: 'fill', division: d, lines: picks.map((asset) => ({ asset })) })
  }

  /** Auto-equip's plan: the best free gear onto the strongest mercenaries missing it, within the Forge slot budget. */
  function autoEquip(d: Division) {
    const units = [...d.units].sort((x, y) => power(y.asset.stats) - power(x.asset.stats))
    const lines: PlanLine[] = []
    for (const kind of GEAR_KINDS) {
      let budget = gearBudget(kind)
      const pool = free[kind].filter(usable).sort(byPower)
      for (const unit of units) {
        if (budget <= 0 || !pool.length) break
        if (unit.gear[kind]) continue
        lines.push({ asset: pool.shift()!, unit, kind })
        budget--
      }
    }
    if (lines.length) setPreview({ mode: 'equip', division: d, lines })
  }

  async function confirmPreview(plan: AutoPlan, lines: PlanLine[]) {
    const d = plan.division
    const ok =
      plan.mode === 'fill'
        ? await run(
            (a, p) => lines.map((l) => addUnit(a, p, d.id, l.asset.assetId)),
            `${lines.length} mercenar${lines.length === 1 ? 'y' : 'ies'} joined division #${d.id}`,
            'autofill'
          )
        : await run(
            (a, p) => lines.map((l) => assignGear(a, p, d.id, l.unit!.asset.assetId, l.kind!, l.asset.assetId)),
            `${lines.length} piece${lines.length === 1 ? '' : 's'} of gear equipped`,
            'autoequip'
          )
    if (ok) setPreview(null)
  }

  async function clearDivision(d: Division) {
    if (!d.units.length) return
    await run((a, p) => d.units.map((u) => removeUnit(a, p, u.asset.assetId)), `Division #${d.id} emptied`, 'clear')
  }

  /** Empties the division and deletes it in one transaction; its mercenaries and gear go back to the reserve. */
  async function disband(d: Division) {
    if (!d.leader) return
    const ok = await run((a, p) => disbandActions(a, p, d), `Division #${d.id} disbanded`, 'disband')
    if (ok) setSelectedId(null)
  }

  // The contract refuses changes while a division is out or its last reward is unclaimed.
  const selectedState = selected ? stateOf(selected) : null
  const editable = !!selectedState && (selectedState.tone === 'is-idle' || selectedState.tone === 'is-empty')
  const emptyFillable = selected && editable ? Math.min(selected.slotsMax - selected.units.length, free.mercenary.length) : 0
  const equippable =
    selected && editable
      ? GEAR_KINDS.reduce((n, kind) => {
          const need = selected.units.filter((u) => !u.gear[kind]).length
          return n + Math.max(0, Math.min(need, free[kind].filter(usable).length, gearBudget(kind)))
        }, 0)
      : 0

  return (
    <div className="page army">
      {/* Summary strip */}
      <header className="army__top panel panel--tight">
        <div className="army__figures">
          <Figure
            label="Divisions"
            value={`${divisions.length} / ${allowance}`}
            tone={divisions.length >= allowance ? 'c-gold' : ''}
            help={`You may have ${allowance} divisions: ${FREE_DIVISIONS} free and ${allowance - FREE_DIVISIONS} Division slot${allowance - FREE_DIVISIONS === 1 ? '' : 's'} bought in the Forge.${divisions.length >= allowance ? ' All in use: buy another slot in the Forge for more.' : ` ${allowance - divisions.length} more can be created.`}`}
          />
          <Figure label="Attack" value={totals.atk.toLocaleString('en-US')} tone="c-atk" />
          <Figure label="Defense" value={totals.def.toLocaleString('en-US')} tone="c-def" />
          <Figure label="Move" value={totals.move.toLocaleString('en-US')} tone="c-mov" />
          <Figure
            label="TLM / h"
            value={formatNumber(currentPerHour, 1)}
            tone="c-tlm"
            help="What your divisions earn together per hour, each on the mission that pays it the most (net of entry fees and DEF swaps). Optimize rebuilds the army for the highest total."
          />
          <Figure
            label="Reserve"
            value={`${freeUnits} + ${freeGear}`}
            help="Staked mercenaries and gear not assigned to a division yet."
          />
        </div>
        <div className="army__top-actions">
          <Button color="ghost" size="sm" onClick={() => setStakeOpen('stake')}>
            Stake NFTs
          </Button>
          <Button color="ghost" size="sm" onClick={() => setStakeOpen('unstake')}>
            Unstake NFTs
          </Button>
          {divisions.length > 0 && (
            <Button color="ghost" size="sm" onClick={() => setDisbandAllOpen(true)}>
              Disband all
            </Button>
          )}
          <Button
            size="sm"
            color="gradientYellow"
            disabled={!missions.length}
            title="Rebuild the army from everything staked to earn the most TLM an hour"
            onClick={() => setOptimizeOpen(true)}
          >
            <SparkIcon /> Optimize
          </Button>
          <Button
            size="sm"
            color="gradientGreen"
            disabled={atLimit}
            title={atLimit ? limitNote : undefined}
            onClick={() => setMissionOpen(true)}
          >
            <SparkIcon /> For a mission
          </Button>
          <Button size="sm" disabled={atLimit} title={atLimit ? limitNote : undefined} onClick={() => setCreateOpen(true)}>
            <PlusIcon /> New division
          </Button>
        </div>
      </header>

      {divisions.length === 0 ? (
        <div className="empty army__empty">
          <strong>No divisions yet</strong>
          <span>Stake a warlord, then create your first division. Mercenaries join it and gear goes on them.</span>
          <div className="army__empty-actions">
            <Button color="ghost" onClick={() => setStakeOpen('stake')}>
              Stake NFTs
            </Button>
            <Button onClick={() => setCreateOpen(true)}>Create a division</Button>
          </div>
        </div>
      ) : (
        <div className="army__layout">
          {/* Division rail */}
          <aside className="rail">
            {divisions.map((d) => {
              const st = stateOf(d)
              return (
                <button
                  key={d.id}
                  type="button"
                  className={`rail__item ${selected?.id === d.id ? 'is-selected' : ''} ${st.tone}`}
                  onClick={() => setSelectedId(d.id)}
                >
                  {d.leader ? (
                    <CardArt asset={d.leader} shape="square" className="rail__art" />
                  ) : (
                    <span className="rail__art rail__art--none" />
                  )}
                  <span className="rail__body">
                    <span className="rail__head">
                      <b>#{d.id}</b>
                      <span className={`rail__state ${st.tone}`}>
                        {st.until ? <Ticking render={(t) => shortDuration(st.until! - t)} /> : st.label}
                      </span>
                    </span>
                    <StatTrio atk={d.atk} def={d.def} move={d.move} size="sm" />
                    <span className="rail__slots">
                      <span className="progress">
                        <span
                          style={{
                            width: `${d.slotsMax ? (d.units.length / d.slotsMax) * 100 : 0}%`
                          }}
                        />
                      </span>
                      <small className="num">
                        {d.units.length}/{d.slotsMax}
                      </small>
                    </span>
                  </span>
                  <ChevronIcon className="rail__chev" />
                </button>
              )
            })}
          </aside>

          {/* Selected division board */}
          {selected && (
            <section className="board rise" key={selected.id}>
              <header className="board__head">
                {selected.leader && <CardArt asset={selected.leader} className="board__leader" />}
                <div className="board__title">
                  <p className="eyebrow">Division #{selected.id}</p>
                  <h2>{selected.leader?.name ?? 'Warlord'}</h2>
                  <p className="muted">
                    {selected.leader?.rarity && (
                      <span style={{ color: rarityColor(selected.leader.rarity) }}>
                        {titleCase(selected.leader.rarity)} warlord
                      </span>
                    )}
                    {' · '}
                    {selected.slotsMax} mercenary slots
                    {selected.leader?.info?.stars ? ` · ${'★'.repeat(selected.leader.info.stars)}` : ''}
                  </p>
                  <div className="board__stats">
                    <StatTrio atk={selected.atk} def={selected.def} move={selected.move} size="lg" help />
                    {!selected.fresh && (
                      <Tooltip text="The contract's cached stats are from an older epoch. They are recalculated automatically the next time this division deploys.">
                        <span className="chip chip--gold">stats refresh on deploy</span>
                      </Tooltip>
                    )}
                  </div>
                  <p className="board__cooldown faint">
                    <TimerIcon width={12} height={12} /> Mission lock: base cooldown +{' '}
                    {formatDuration(missionLockSeconds(0, selected.move))} from move cost
                  </p>
                </div>
                <div className="board__actions">
                  {(() => {
                    const st = stateOf(selected)
                    if (st.tone === 'is-ready')
                      return (
                        <Link to="/deployments" className="board__state is-ready">
                          <GiftIcon /> Reward ready to claim
                        </Link>
                      )
                    if (st.until)
                      return (
                        <span className="board__state is-away">
                          <LockIcon /> On mission · <Ticking render={(t) => shortDuration(st.until! - t)} />
                        </span>
                      )
                    return null
                  })()}
                  <Button
                    size="sm"
                    disabled={emptyFillable <= 0}
                    isLoading={pending === 'autofill'}
                    onClick={() => autoFill(selected)}
                  >
                    <SparkIcon /> Auto-fill {emptyFillable > 0 ? `(${emptyFillable})` : ''}
                  </Button>
                  <Button
                    size="sm"
                    color="gradientGreen"
                    disabled={equippable <= 0}
                    isLoading={pending === 'autoequip'}
                    onClick={() => autoEquip(selected)}
                  >
                    <SparkIcon /> Auto-equip {equippable > 0 ? `(${equippable})` : ''}
                  </Button>
                  <details className="board__more">
                    <summary className="icon-btn" title="More">
                      ···
                    </summary>
                    <div className="board__menu">
                      <button
                        type="button"
                        disabled={!selected.units.length || pending !== null}
                        onClick={() => void clearDivision(selected)}
                      >
                        Remove all mercenaries
                      </button>
                      <button
                        type="button"
                        className="is-danger"
                        title="Removes every mercenary and deletes the division in one transaction. Everything goes back to your reserve."
                        disabled={!editable || pending !== null}
                        onClick={() => void disband(selected)}
                      >
                        Disband division
                      </button>
                    </div>
                  </details>
                </div>
              </header>

              {!editable && selectedState && (
                <p className={`board__notice ${selectedState.tone}`}>
                  {selectedState.tone === 'is-ready' ? (
                    <>
                      <GiftIcon width={14} height={14} /> This division has an unclaimed reward.{' '}
                      <Link to="/deployments">Claim it</Link> to edit the roster again.
                    </>
                  ) : (
                    <>
                      <LockIcon width={14} height={14} /> Out on a mission: the roster can be changed once it returns and the
                      reward is claimed.
                    </>
                  )}
                </p>
              )}

              <div className={`slots ${editable ? '' : 'is-frozen'}`}>
                {selected.units.map((unit) => (
                  <UnitCard
                    key={unit.asset.assetId}
                    unit={unit}
                    division={selected}
                    budget={gearBudget}
                    onPick={(kind) => setPicker({ kind, unit })}
                    onUnassign={(gear) =>
                      run(
                        (a, p) => unassignGear(a, p, selected.id, unit.asset.assetId, gear.assetId),
                        `${gear.name} removed`,
                        `un-${gear.assetId}`
                      )
                    }
                    onRemove={() =>
                      run(
                        (a, p) => removeUnit(a, p, unit.asset.assetId),
                        `${unit.asset.name} left the division`,
                        `rm-${unit.asset.assetId}`
                      )
                    }
                    pending={pending}
                  />
                ))}
                {Array.from({
                  length: Math.max(0, selected.slotsMax - selected.units.length)
                }).map((_, i) => (
                  <button
                    key={`empty-${i}`}
                    type="button"
                    className="slot slot--empty"
                    disabled={!editable}
                    onClick={() => setPicker({ kind: 'mercenary' })}
                  >
                    <PlusIcon />
                    <span>Add mercenary</span>
                    {i === 0 && free.mercenary.length > 0 && <small>{free.mercenary.length} in reserve</small>}
                    {i === 0 && free.mercenary.length === 0 && <small>reserve empty · stake more</small>}
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {picker && selected && (
        <PickerModal
          kind={picker.kind}
          unit={picker.unit}
          division={selected}
          pool={free[picker.kind]}
          budget={picker.kind === 'mercenary' || picker.kind === 'warlord' ? Infinity : gearBudget(picker.kind as GearKind)}
          forgeLevel={forgeLevel}
          pending={pending}
          onClose={() => setPicker(null)}
          onAdd={async (assets) => {
            const ok =
              picker.kind === 'mercenary'
                ? await run(
                    (a, p) => assets.map((m) => addUnit(a, p, selected.id, m.assetId)),
                    `${assets.length} mercenar${assets.length === 1 ? 'y' : 'ies'} joined #${selected.id}`,
                    'pick'
                  )
                : await run(
                    (a, p) =>
                      assignGear(a, p, selected.id, picker.unit!.asset.assetId, picker.kind as GearKind, assets[0].assetId),
                    `${assets[0].name} equipped`,
                    'pick'
                  )
            if (ok) setPicker(null)
          }}
          onUnstake={(asset) =>
            run((a, p) => unstakeAsset(a, p, asset.assetId), `${asset.name} returned to your wallet`, `unstake-${asset.assetId}`)
          }
        />
      )}

      {disbandAllOpen && (
        <DisbandAllModal
          divisions={divisions.filter((d) => {
            const t = stateOf(d).tone
            return !!d.leader && (t === 'is-idle' || t === 'is-empty')
          })}
          skipped={
            divisions.filter((d) => {
              const t = stateOf(d).tone
              return !(d.leader && (t === 'is-idle' || t === 'is-empty'))
            }).length
          }
          onClose={() => setDisbandAllOpen(false)}
          onDone={() => {
            setDisbandAllOpen(false)
            setSelectedId(null)
          }}
        />
      )}
      {optimizeOpen && (
        <OptimizeArmyModal
          account={account}
          divisions={divisions}
          disbandable={(d) => {
            const t = stateOf(d).tone
            return !!d.leader && (t === 'is-idle' || t === 'is-empty')
          }}
          free={free}
          forgeLevel={forgeLevel}
          powerups={powerups}
          allowance={allowance}
          missions={missions}
          market={market}
          onClose={() => setOptimizeOpen(false)}
          onDone={(id) => {
            setOptimizeOpen(false)
            if (id !== null) setSelectedId(id)
          }}
        />
      )}
      {missionOpen && (
        <MissionDivisionModal
          account={account}
          free={free}
          forgeLevel={forgeLevel}
          slotsFree={{
            weapon: gearBudget('weapon'),
            supply: gearBudget('supply'),
            lavalux: gearBudget('lavalux')
          }}
          onClose={() => setMissionOpen(false)}
          onCreated={(id) => {
            setMissionOpen(false)
            if (id !== null) setSelectedId(id)
          }}
        />
      )}
      {preview && (
        <AutoPreview
          plan={preview}
          pending={pending}
          onClose={() => setPreview(null)}
          onConfirm={(lines) => confirmPreview(preview, lines)}
        />
      )}

      {stakeOpen && <StakeModal account={account} mode={stakeOpen} onClose={() => setStakeOpen(false)} />}

      {createOpen && (
        <CreateDivisionModal
          account={account}
          freeWarlords={free.warlord}
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => {
            setCreateOpen(false)
            if (id) setSelectedId(id)
          }}
        />
      )}
    </div>
  )
}

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

// ---- Auto-fill / Auto-equip preview -----------------------------------------------------------------

/** One step of an auto plan: a mercenary to add, or a piece of gear (`asset`) for `unit`'s `kind` slot. */
interface PlanLine {
  asset: AssetRef
  unit?: Unit
  kind?: GearKind
}

interface AutoPlan {
  mode: 'fill' | 'equip'
  division: Division
  lines: PlanLine[]
}

const lineKey = (l: PlanLine) => `${l.asset.assetId}-${l.unit?.asset.assetId ?? ''}`

/** What a unit brings with its current gear plus any planned pieces. */
const totalsWith = (unit: Unit, extra: PlanLine[]) => {
  const gear = { ...unit.gear }
  for (const l of extra) if (l.kind) gear[l.kind] = l.asset
  return unitTotals({
    unit: unit.asset.stats,
    weapon: gear.weapon?.stats,
    supply: gear.supply?.stats,
    creature: gear.creature?.stats,
    lavalux: gear.lavalux?.stats
  })
}

/**
 * Shows exactly what Auto-fill or Auto-equip would do, with the division's stats before and after.
 * Every line can be unticked; nothing is signed until Confirm.
 */
function AutoPreview({
  plan,
  pending,
  onClose,
  onConfirm
}: {
  plan: AutoPlan
  pending: string | null
  onClose: () => void
  onConfirm: (lines: PlanLine[]) => Promise<void>
}) {
  const { division: d, mode } = plan
  const [off, setOff] = useState<Set<string>>(new Set())
  const toggle = (k: string) =>
    setOff((s) => {
      const n = new Set(s)
      if (n.has(k)) n.delete(k)
      else n.add(k)
      return n
    })
  const lines = plan.lines.filter((l) => !off.has(lineKey(l)))

  // The division after the plan: new units add their own totals; new gear changes its unit's totals.
  const delta = { atk: 0, def: 0, move: 0 }
  if (mode === 'fill') {
    for (const l of lines) {
      const t = unitTotals({ unit: l.asset.stats })
      delta.atk += t.atk
      delta.def += t.def
      delta.move += t.move
    }
  } else {
    const byUnit = new Map<Unit, PlanLine[]>()
    for (const l of lines) byUnit.set(l.unit!, [...(byUnit.get(l.unit!) ?? []), l])
    for (const [unit, extra] of byUnit) {
      const before = totalsWith(unit, [])
      const after = totalsWith(unit, extra)
      delta.atk += after.atk - before.atk
      delta.def += after.def - before.def
      delta.move += after.move - before.move
    }
  }
  const after = { atk: d.atk + delta.atk, def: d.def + delta.def, move: d.move + delta.move }
  const title = mode === 'fill' ? `Auto-fill division #${d.id}` : `Auto-equip division #${d.id}`
  const key = mode === 'fill' ? 'autofill' : 'autoequip'

  return (
    <Modal className="picker" onClose={onClose} label={title} locked={pending === key}>
      <header className="picker__head">
        <div>
          <p className="eyebrow">Preview · nothing is signed yet</p>
          <h3>{title}</h3>
          <p className="muted">
            {mode === 'fill'
              ? 'The strongest mercenaries in your reserve, one per empty slot. Untick any you want to keep out.'
              : 'The best free gear goes to your strongest mercenaries first, within your Forge slots. Untick anything you want to keep.'}
          </p>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
          <XIcon />
        </button>
      </header>

      <div className="autoprev__stats">
        <span className="autoprev__col">
          <small>Now</small>
          <StatTrio atk={d.atk} def={d.def} move={d.move} />
        </span>
        <span className="autoprev__arrow">→</span>
        <span className="autoprev__col">
          <small>After</small>
          <StatTrio atk={after.atk} def={after.def} move={after.move} />
        </span>
        <span className="autoprev__delta num">
          <b className="c-atk">{signed(delta.atk)} ATK</b>
          <b className="c-def">{signed(delta.def)} DEF</b>
          <b className="c-mov">{signed(delta.move)} MOVE</b>
          {delta.move !== 0 && <small className="faint">{signed(delta.move * 10)} s per mission</small>}
        </span>
      </div>

      <ul className="autoprev__list">
        {plan.lines.map((l) => {
          const k = lineKey(l)
          const on = !off.has(k)
          const unitDelta =
            l.unit && l.kind
              ? (() => {
                  const b = totalsWith(l.unit, [])
                  const a = totalsWith(l.unit, [l])
                  return { atk: a.atk - b.atk, def: a.def - b.def, move: a.move - b.move }
                })()
              : null
          return (
            <li key={k}>
              <button type="button" className={`autoprev__line ${on ? 'is-on' : ''}`} onClick={() => toggle(k)} aria-pressed={on}>
                <span className={`deploy__check ${on ? 'is-on' : ''}`} />
                <CardArt asset={l.asset} shape="square" className="autoprev__art" />
                <span className="autoprev__what">
                  <b>{l.asset.name}</b>
                  <small style={{ color: rarityColor(l.asset.rarity) }}>
                    {titleCase(l.asset.rarity || '')} {l.kind ? KIND_LABEL[l.kind].toLowerCase() : 'mercenary'}
                    {l.asset.info?.stars ? ` ${'★'.repeat(l.asset.info.stars)}` : ''}
                  </small>
                </span>
                {l.unit && (
                  <span className="autoprev__onto">
                    <span className="faint">onto</span>
                    <CardArt asset={l.unit.asset} shape="square" className="autoprev__art autoprev__art--sm" />
                    <span>{l.unit.asset.name}</span>
                  </span>
                )}
                {unitDelta ? (
                  <span className="autoprev__gain num">
                    <b className="c-atk">{signed(unitDelta.atk)}</b> <b className="c-def">{signed(unitDelta.def)}</b>{' '}
                    <b className="c-mov">{signed(unitDelta.move)}</b>
                  </span>
                ) : (
                  l.asset.stats && (
                    <StatTrio atk={l.asset.stats.attack} def={l.asset.stats.defense} move={l.asset.stats.movecost} size="sm" />
                  )
                )}
              </button>
            </li>
          )
        })}
      </ul>

      <footer className="picker__foot">
        <span className="muted">
          {lines.length} of {plan.lines.length} · one transaction
        </span>
        <div className="autoprev__actions">
          <Button color="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            color={mode === 'fill' ? 'solidBlue' : 'gradientGreen'}
            disabled={!lines.length}
            isLoading={pending === key}
            onClick={() => onConfirm(lines)}
          >
            <CheckIcon />{' '}
            {mode === 'fill'
              ? `Add ${lines.length} mercenar${lines.length === 1 ? 'y' : 'ies'}`
              : `Equip ${lines.length} item${lines.length === 1 ? '' : 's'}`}
          </Button>
        </div>
      </footer>
    </Modal>
  )
}

const signed = (n: number) => `${n > 0 ? '+' : ''}${Math.round(n).toLocaleString('en-US')}`

// ---- A mercenary and its four gear slots ------------------------------------------------------------

interface UnitCardProps {
  unit: Unit
  division: Division
  budget: (kind: GearKind) => number
  onPick: (kind: GearKind) => void
  onUnassign: (gear: AssetRef) => Promise<boolean>
  onRemove: () => Promise<boolean>
  pending: string | null
}

function UnitCard({ unit, budget, onPick, onUnassign, onRemove, pending }: UnitCardProps) {
  const t = unitTotals({
    unit: unit.asset.stats,
    weapon: unit.gear.weapon?.stats,
    supply: unit.gear.supply?.stats,
    creature: unit.gear.creature?.stats,
    lavalux: unit.gear.lavalux?.stats
  })
  const boosted = t.atk > (unit.asset.stats?.attack ?? 0) || t.def > (unit.asset.stats?.defense ?? 0)
  return (
    <article className="slot unit" style={{ '--rarity': rarityColor(unit.asset.rarity) } as CSSProperties}>
      <div className="unit__top">
        <CardArt asset={unit.asset} shape="square" className="unit__art" />
        <div className="unit__info">
          <b className="unit__name" title={unit.asset.name}>
            {unit.asset.name}
          </b>
          <span className="unit__meta">
            <span style={{ color: rarityColor(unit.asset.rarity) }}>{titleCase(unit.asset.rarity || 'unit')}</span>
            {unit.asset.info?.type ? ` · ${unit.asset.info.type}` : ''}
          </span>
          <Tooltip
            text={
              <>
                Base {unit.asset.stats?.attack ?? 0} / {unit.asset.stats?.defense ?? 0} / {unit.asset.stats?.movecost ?? 0}. With
                gear{' '}
                <strong>
                  {t.atk} / {t.def} / {t.move}
                </strong>
                {t.atkMult !== 1 ? ` (×${t.atkMult} from Lava Lux)` : ''}.
              </>
            }
          >
            <span className={`unit__stats ${boosted ? 'is-boosted' : ''}`}>
              <StatTrio atk={t.atk} def={t.def} move={t.move} size="sm" />
            </span>
          </Tooltip>
        </div>
        <button
          type="button"
          className="unit__remove icon-btn"
          title="Remove from division"
          disabled={pending !== null}
          onClick={() => void onRemove()}
        >
          <XIcon />
        </button>
      </div>
      <div className="gear">
        {GEAR_KINDS.map((kind) => {
          const g = unit.gear[kind]
          const left = budget(kind)
          return g ? (
            <Tooltip key={kind} text={`${g.name}${g.info?.effect ? ` · ${g.info.effect}` : ''}. Click to remove.`}>
              <button
                type="button"
                className="gear__slot is-filled"
                style={{ '--rarity': rarityColor(g.rarity) } as CSSProperties}
                disabled={pending !== null}
                onClick={() => void onUnassign(g)}
              >
                <CardArt asset={g} shape="square" />
                <span className="gear__x">
                  <XIcon width={12} height={12} />
                </span>
              </button>
            </Tooltip>
          ) : (
            <Tooltip
              key={kind}
              text={`${KIND_LABEL[kind]}: ${GEAR_HELP[kind]}${Number.isFinite(left) ? ` Slots left: ${Math.max(0, left)}.` : ''}`}
            >
              <button type="button" className={`gear__slot ${left <= 0 ? 'is-capped' : ''}`} onClick={() => onPick(kind)}>
                <span className="gear__label">{KIND_LABEL[kind].slice(0, 3)}</span>
                {left <= 0 ? <LockIcon width={12} height={12} /> : <PlusIcon width={12} height={12} />}
              </button>
            </Tooltip>
          )
        })}
      </div>
    </article>
  )
}

// ---- Picker: reserve assets of one kind, for a division or a mercenary --------------------------------

interface PickerProps {
  kind: Kind
  unit?: Unit
  division: Division
  pool: AssetRef[]
  budget: number
  forgeLevel: number
  pending: string | null
  onClose: () => void
  onAdd: (assets: AssetRef[]) => Promise<void>
  onUnstake: (asset: AssetRef) => Promise<boolean>
}

function PickerModal({ kind, unit, division, pool, budget, forgeLevel, pending, onClose, onAdd, onUnstake }: PickerProps) {
  const multi = kind === 'mercenary'
  const max = multi ? Math.max(0, division.slotsMax - division.units.length) : 1
  const sorted = useMemo(() => [...pool].sort(byPower), [pool])
  const [chosen, setChosen] = useState<string[]>(() => (multi ? sorted.slice(0, max).map((a) => a.assetId) : []))
  const capped = budget <= 0

  const toggle = (id: string) => {
    if (!multi) {
      setChosen([id])
      return
    }
    setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : c.length < max ? [...c, id] : c))
  }
  const picked = sorted.filter((a) => chosen.includes(a.assetId))
  const title = multi ? `Add mercenaries to #${division.id}` : `${KIND_LABEL[kind]} for ${unit?.asset.name ?? 'mercenary'}`

  return (
    <Modal className="picker" onClose={onClose} label={title}>
      <header className="picker__head">
        <div>
          <p className="eyebrow">{multi ? `${max} free slot${max === 1 ? '' : 's'}` : KIND_LABEL[kind]}</p>
          <h3>{title}</h3>
          {!multi && <p className="muted">{GEAR_HELP[kind as GearKind]}</p>}
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
          <XIcon />
        </button>
      </header>

      {capped && !multi && (
        <p className="picker__note">
          Every {KIND_LABEL[kind].toLowerCase()} slot is in use. <Link to="/forge">Buy another in the Forge</Link> or free one
          from another mercenary.
        </p>
      )}

      {sorted.length === 0 ? (
        <div className="empty">
          <strong>Nothing in reserve</strong>
          <span>Stake {KIND_LABEL[kind].toLowerCase()} NFTs from your wallet first (Army → Stake NFTs).</span>
        </div>
      ) : (
        <div className="picker__grid">
          {sorted.map((a) => {
            const locked = (a.stats?.min_forge_level ?? 0) > forgeLevel
            const on = chosen.includes(a.assetId)
            return (
              <div key={a.assetId} className={`pick ${on ? 'is-on' : ''} ${locked ? 'is-locked' : ''}`}>
                <button
                  type="button"
                  className="pick__main"
                  disabled={locked || (capped && !multi)}
                  onClick={() => toggle(a.assetId)}
                >
                  <CardArt asset={a} shape="square" />
                  <span className="pick__name" title={a.name}>
                    {a.name}
                  </span>
                  <span className="pick__meta" style={{ color: rarityColor(a.rarity) }}>
                    {titleCase(a.rarity || '')}
                    {a.info?.stars ? ` ${'★'.repeat(a.info.stars)}` : ''}
                  </span>
                  {a.stats && kind !== 'lavalux' && (
                    <StatTrio
                      atk={a.stats.attack}
                      def={a.stats.defense}
                      move={kind === 'supply' ? -a.stats.movecost_reduction : a.stats.movecost}
                      size="sm"
                    />
                  )}
                  {a.stats && kind === 'lavalux' && (
                    <span className="pick__mult num">
                      ATK ×{a.stats.attack_mult_bp / 10000} · MOVE ×{a.stats.movecost_mult_bp / 10000}
                    </span>
                  )}
                  {locked && <span className="pick__lock">Forge Lv {a.stats?.min_forge_level}</span>}
                  {on && (
                    <span className="pick__check">
                      <CheckIcon width={12} height={12} />
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  className="pick__unstake"
                  title="Unstake: return this NFT to your wallet"
                  disabled={pending !== null}
                  onClick={() => void onUnstake(a)}
                >
                  Unstake
                </button>
              </div>
            )
          })}
        </div>
      )}

      <footer className="picker__foot">
        <span className="muted">{multi ? `${picked.length} of ${max} selected` : picked[0] ? picked[0].name : 'Pick one'}</span>
        <Button disabled={!picked.length || (capped && !multi)} isLoading={pending === 'pick'} onClick={() => onAdd(picked)}>
          {multi ? `Add ${picked.length || ''}` : 'Equip'}
        </Button>
      </footer>
    </Modal>
  )
}

// ---- Stake NFTs from the wallet, or unstake them from the reserve ---------------------------------------

function StakeModal({ account, mode, onClose }: { account: string | null; mode: 'stake' | 'unstake'; onClose: () => void }) {
  const staking = mode === 'stake'
  const wallet = useWalletNfts(staking ? account : null)
  const army = useArmy(account)
  // Staking offers the wallet; unstaking the reserve (staked NFTs in no division: a unit in a division comes out of it first).
  const source = staking ? wallet.data : army.data ? Object.values(army.data.free).flat() : undefined
  const loading = staking ? wallet.isLoading : army.isLoading
  const { run, runSequence, pending } = useTransaction()
  const [kinds, setKinds] = useState<Set<Kind>>(new Set(['warlord', 'mercenary', 'weapon', 'supply', 'creature', 'lavalux']))

  const groups = useMemo(() => {
    const g: Record<Kind, AssetRef[]> = {
      warlord: [],
      mercenary: [],
      weapon: [],
      supply: [],
      creature: [],
      lavalux: []
    }
    for (const a of source ?? []) {
      const k = a.stats ? kindOfStats(a.stats.category) : null
      if (k) g[k].push(a)
    }
    return g
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet.data, army.data, staking])

  // Staking starts with everything shown selected; unstaking with nothing, so a stray click cannot
  // send the whole reserve back. Single NFTs are taken out (and put back) with a click.
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const seeded = useRef(false)
  useEffect(() => {
    if (staking || seeded.current || !source) return
    seeded.current = true
    setExcluded(new Set(source.map((x) => x.assetId)))
  }, [staking, source])
  const shown = (Object.keys(groups) as Kind[]).filter((k) => kinds.has(k)).flatMap((k) => groups[k])
  const chosen = shown.filter((a) => !excluded.has(a.assetId))
  const toggle = (id: string) =>
    setExcluded((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const selectShown = (on: boolean) =>
    setExcluded((s) => {
      const n = new Set(s)
      for (const a of shown) {
        if (on) n.delete(a.assetId)
        else n.add(a.assetId)
      }
      return n
    })

  async function stake() {
    if (!chosen.length) return
    const ids = chosen.map((a) => a.assetId)
    const batches: string[][] = []
    for (let i = 0; i < ids.length; i += 50) batches.push(ids.slice(i, i + 50))
    if (staking) {
      // One transfer action carries up to 50 NFTs; a large stake is several transfer actions in one transaction.
      const ok = await run(
        (a, p) => batches.map((b) => stakeAssets(a, p, b)),
        `${ids.length} NFT${ids.length === 1 ? '' : 's'} staked`,
        'stake'
      )
      if (ok) onClose()
      return
    }
    // Unstaking is one action per NFT: 50 to a transaction, signed one after another when there are more.
    const done = await runSequence(
      batches.map((b) => ({
        build: (a: string, p: string) => b.map((id) => unstakeAsset(a, p, id)),
        success: `${b.length} NFT${b.length === 1 ? '' : 's'} returned to your wallet`
      })),
      'stake'
    )
    if (done === batches.length) onClose()
  }

  return (
    <Modal className="picker" onClose={onClose} label={staking ? 'Stake NFTs' : 'Unstake NFTs'}>
      <header className="picker__head">
        <div>
          <p className="eyebrow">{staking ? 'Wallet → game' : 'Game → wallet'}</p>
          <h3>{staking ? 'Stake NFTs' : 'Unstake NFTs'}</h3>
          <p className="muted">
            {staking
              ? 'Staked NFTs stay yours; staking moves them into the game contract so divisions can use them. Unstake any time.'
              : 'Only NFTs in your reserve can come back: a unit or gear inside a division has to leave it first (or disband the division).'}
          </p>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
          <XIcon />
        </button>
      </header>

      {loading ? (
        <Loading inline label={staking ? 'Reading your wallet' : 'Reading your reserve'} />
      ) : !source?.length ? (
        <div className="empty">
          <strong>{staking ? 'No stakeable NFTs in your wallet' : 'Nothing in your reserve'}</strong>
          <span>
            {staking
              ? 'Warlords, mercenaries, equipment, supplies, creatures and Lava Lux passes from the Planetary Defense collection can be staked.'
              : 'Every staked NFT is inside a division. Take a unit out of its division, or disband one, and it shows up here.'}
          </span>
        </div>
      ) : (
        <>
          <div className="stake__kinds">
            {(Object.keys(groups) as Kind[]).map((k) => (
              <button
                key={k}
                type="button"
                className={`stake__kind ${kinds.has(k) ? 'is-on' : ''}`}
                disabled={!groups[k].length}
                onClick={() =>
                  setKinds((s) => {
                    const n = new Set(s)
                    if (n.has(k)) n.delete(k)
                    else n.add(k)
                    return n
                  })
                }
              >
                <b className="num">{groups[k].length}</b> {KIND_LABEL[k]}
              </button>
            ))}
            <span className="stake__all">
              <button type="button" className="mk-link" disabled={!shown.length} onClick={() => selectShown(true)}>
                Select all
              </button>
              <button type="button" className="mk-link" disabled={!shown.length} onClick={() => selectShown(false)}>
                Select none
              </button>
            </span>
          </div>
          <div className="picker__grid picker__grid--dense">
            {shown.map((a) => (
              <button
                key={a.assetId}
                type="button"
                className={`pick stake__pick ${excluded.has(a.assetId) ? 'is-off' : 'is-on'}`}
                aria-pressed={!excluded.has(a.assetId)}
                title={
                  excluded.has(a.assetId)
                    ? `Click to ${staking ? 'stake' : 'unstake'} this one`
                    : `Click to leave this one ${staking ? 'in the wallet' : 'staked'}`
                }
                onClick={() => toggle(a.assetId)}
              >
                <span className="pick__main">
                  <CardArt asset={a} shape="square" />
                  <span className="pick__name" title={a.name}>
                    {a.name}
                  </span>
                  <span className="pick__meta" style={{ color: rarityColor(a.rarity) }}>
                    {titleCase(a.rarity || '')}
                  </span>
                </span>
                {!excluded.has(a.assetId) && (
                  <span className="stake__check">
                    <CheckIcon width={12} height={12} />
                  </span>
                )}
              </button>
            ))}
          </div>
        </>
      )}

      <footer className="picker__foot">
        <span className="muted">
          {chosen.length} of {shown.length} selected
        </span>
        <Button disabled={!chosen.length} isLoading={pending === 'stake'} onClick={stake}>
          {staking ? 'Stake' : 'Unstake'} {chosen.length || ''}
        </Button>
      </footer>
    </Modal>
  )
}

function kindOfStats(category: number): Kind | null {
  return (
    ([null, 'mercenary', 'weapon', 'supply', 'creature', 'lavalux', 'lavalux'] as (Kind | null)[])[category] ??
    (category === 0 ? 'warlord' : null)
  )
}

// ---- Create a division from a warlord ---------------------------------------------------------------------

function CreateDivisionModal({
  account,
  freeWarlords,
  onClose,
  onCreated
}: {
  account: string | null
  freeWarlords: AssetRef[]
  onClose: () => void
  onCreated: (id: number | null) => void
}) {
  const wallet = useWalletNfts(account)
  const { run, pending } = useTransaction()
  const walletWarlords = (wallet.data ?? []).filter((a) => a.stats?.category === 0)
  const options = [
    ...freeWarlords.map((a) => ({ asset: a, staked: true })),
    ...walletWarlords.map((a) => ({ asset: a, staked: false }))
  ].sort((x, y) => (y.asset.stats?.slots_max ?? 0) - (x.asset.stats?.slots_max ?? 0))
  // Several divisions can be raised at once; the strongest warlord is preselected.
  const [chosen, setChosen] = useState<string[] | null>(null)
  const selected = chosen ?? (options[0] ? [options[0].asset.assetId] : [])
  const picks = options.filter((o) => selected.includes(o.asset.assetId))
  const toggle = (id: string) => setChosen(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id])
  const allOn = options.length > 0 && picks.length === options.length
  const toStake = picks.filter((o) => !o.staked).map((o) => o.asset.assetId)

  async function create() {
    if (!picks.length) return
    // Warlords still in the wallet are staked first, then every division is created, all in one transaction.
    const ok = await run(
      (a, p) => [
        ...(toStake.length ? [stakeAssets(a, p, toStake)] : []),
        ...picks.map((o) => createDivision(a, p, o.asset.assetId))
      ],
      picks.length === 1 ? `Division created under ${picks[0].asset.name}` : `${picks.length} divisions created`,
      'create'
    )
    if (ok) onCreated(null)
  }

  return (
    <Modal className="picker" onClose={onClose} label="New division">
      <header className="picker__head">
        <div>
          <p className="eyebrow">Warlord</p>
          <h3>New division</h3>
          <p className="muted">
            A warlord leads each division; its rarity sets how many mercenaries fit. Extra divisions beyond your slots need a
            Forge purchase.
          </p>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
          <XIcon />
        </button>
      </header>

      {wallet.isLoading && !options.length ? (
        <Loading inline label="Looking for warlords" />
      ) : !options.length ? (
        <div className="empty">
          <strong>No free warlord</strong>
          <span>Every warlord you own already leads a division. Get another warlord NFT to field one more.</span>
        </div>
      ) : (
        <>
          {options.length > 1 && (
            <div className="picker__tools">
              <button type="button" className="chip" onClick={() => setChosen(allOn ? [] : options.map((o) => o.asset.assetId))}>
                {allOn ? 'Clear selection' : `Select all (${options.length})`}
              </button>
            </div>
          )}
          <div className="picker__grid">
            {options.map(({ asset, staked }) => (
              <div key={asset.assetId} className={`pick ${selected.includes(asset.assetId) ? 'is-on' : ''}`}>
                <button
                  type="button"
                  className="pick__main"
                  aria-pressed={selected.includes(asset.assetId)}
                  onClick={() => toggle(asset.assetId)}
                >
                  <CardArt asset={asset} shape="square" />
                  <span className="pick__name">{asset.name}</span>
                  <span className="pick__meta" style={{ color: rarityColor(asset.rarity) }}>
                    {titleCase(asset.rarity || '')}
                    {asset.info?.stars ? ` ${'★'.repeat(asset.info.stars)}` : ''}
                  </span>
                  <span className="pick__mult">
                    {asset.stats?.slots_max ?? '?'} slots
                    {staked ? '' : ' · in wallet'}
                  </span>
                  {selected.includes(asset.assetId) && (
                    <span className="pick__check">
                      <CheckIcon width={12} height={12} />
                    </span>
                  )}
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      <footer className="picker__foot">
        <span className="muted">
          {picks.length === 0
            ? 'Pick one or more warlords'
            : `${picks.length} selected · ${picks.reduce((n, o) => n + (o.asset.stats?.slots_max ?? 0), 0)} mercenary slots${toStake.length ? ` · stakes ${toStake.length} from your wallet first` : ''}`}
        </span>
        <Button disabled={!picks.length} isLoading={pending === 'create'} onClick={create}>
          {picks.length > 1 ? `Create ${picks.length} divisions` : 'Create division'}
        </Button>
      </footer>
    </Modal>
  )
}
