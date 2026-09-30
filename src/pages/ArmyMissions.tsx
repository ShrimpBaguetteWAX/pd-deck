import { useEffect, useMemo, useState } from 'react'

import { addUnit, assignGear, createDivision, deleteDivision, removeUnit, unassignGear } from '@/chain/actions/pd'
import { CardArt, PlanetIcon, rarityColor } from '@/components/Art'
import { Button } from '@/components/Button'
import { Loading } from '@/components/Loading'
import { Modal } from '@/components/Modal'
import { StatTrio } from '@/components/Stat'
import { toast } from '@/components/toast'
import type { AssetRef } from '@/data/assets'
import { useArmy, useMissionConfig, type Division } from '@/data/game'
import { TimerIcon, XIcon } from '@/icons'
import type { SlotKind } from '@/lib/bundle'
import { formatDuration, formatNumber } from '@/lib/format'
import { missionEconomics, rewardParts, type MissionEconomics } from '@/lib/loop'
import { planMissionDivision, type MissionPlan } from '@/lib/missionDivision'
import { GEAR_KINDS, missionLockSeconds, type Kind } from '@/lib/stats'
import { useTransaction } from '@/wallet/useTransaction'

type Action = ReturnType<typeof removeUnit>

/**
 * Everything that takes one division apart, in the order the contract needs: every piece of gear
 * back to the reserve, every mercenary out, then the division itself (which frees its warlord).
 */
export function disbandActions(a: string, p: string, d: Division): Action[] {
  return [
    ...d.units.flatMap((u) =>
      GEAR_KINDS.filter((k) => u.gear[k]).map((k) => unassignGear(a, p, d.id, u.asset.assetId, u.gear[k]!.assetId))
    ),
    ...d.units.map((u) => removeUnit(a, p, u.asset.assetId)),
    ...(d.leader ? [deleteDivision(a, p, d.leader.assetId)] : [])
  ]
}

// ---- Disband all ------------------------------------------------------------------------------------

export function DisbandAllModal({
  divisions,
  skipped,
  onClose,
  onDone
}: {
  /** Idle or empty divisions: the ones the contract lets go. */
  divisions: Division[]
  /** Divisions left alone because they are out on a mission or have a reward to claim. */
  skipped: number
  onClose: () => void
  onDone: () => void
}) {
  const { run, pending, spectating } = useTransaction()
  const units = divisions.reduce((n, d) => n + d.units.length, 0)
  const gear = divisions.reduce((n, d) => n + d.units.reduce((m, u) => m + GEAR_KINDS.filter((k) => u.gear[k]).length, 0), 0)

  async function disbandAll() {
    const ok = await run(
      (a, p) => divisions.flatMap((d) => disbandActions(a, p, d)),
      `${divisions.length} division${divisions.length === 1 ? '' : 's'} disbanded`,
      'disband-all'
    )
    if (ok) onDone()
  }

  return (
    <Modal className="picker mdiv-confirm" onClose={onClose} label="Disband all divisions">
      <header className="picker__head">
        <div>
          <p className="eyebrow">Army</p>
          <h3>Disband all divisions</h3>
          <p className="muted">
            Every piece of gear comes off, every mercenary leaves and each division is deleted. Everything stays staked and goes
            back to your reserve, ready for new divisions.
          </p>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
          <XIcon />
        </button>
      </header>
      <ul className="mdiv-confirm__list">
        <li>
          <b className="num">{divisions.length}</b> division{divisions.length === 1 ? '' : 's'} disbanded
        </li>
        <li>
          <b className="num">{units}</b> mercenaries back to the reserve
        </li>
        <li>
          <b className="num">{gear}</b> pieces of gear unequipped
        </li>
        {skipped > 0 && (
          <li className="faint">
            {skipped === 1
              ? '1 division is on a mission or waiting for a claim, so it stays as it is.'
              : `${skipped} divisions are on a mission or waiting for a claim, so they stay as they are.`}
          </li>
        )}
      </ul>
      <footer className="picker__foot">
        <Button color="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          color="danger"
          disabled={!divisions.length || spectating}
          isLoading={pending === 'disband-all'}
          onClick={() => void disbandAll()}
        >
          Disband {divisions.length} division{divisions.length === 1 ? '' : 's'}
        </Button>
      </footer>
    </Modal>
  )
}

// ---- A division for a mission ------------------------------------------------------------------------

export function MissionDivisionModal({
  account,
  free,
  forgeLevel,
  slotsFree,
  onClose,
  onCreated
}: {
  account: string | null
  free: Record<Kind, AssetRef[]>
  forgeLevel: number
  slotsFree: Record<SlotKind, number>
  onClose: () => void
  onCreated: (divisionId: number | null) => void
}) {
  const config = useMissionConfig()
  const army = useArmy(account)
  const { run, pending, spectating } = useTransaction()
  const [missionId, setMissionId] = useState<number | null>(null)

  const missions = useMemo(() => {
    if (!config.data) return []
    const seen = new Set<string>()
    return config.data.missions
      .map((row) => missionEconomics(row, config.data!))
      .filter((e) => e.state === 'active' && (e.minAtk > 0 || e.minDef > 0))
      .sort((a, b) => a.minAtk + a.minDef - (b.minAtk + b.minDef))
      .filter((e) => {
        // One entry per requirement and title is enough to choose from.
        const k = `${e.title}/${e.minAtk}/${e.minDef}`
        if (seen.has(k)) return false
        seen.add(k)
        return true
      })
  }, [config.data])

  /*
   * Every mission is planned as soon as the list is open, one per tick so the page stays responsive,
   * so each row can show what would go in and the first one the reserve can field is picked at once.
   * The reserve is keyed by content: the Army page hands over new objects on every render.
   */
  const reserveKey = useMemo(
    () =>
      JSON.stringify([
        Object.values(free).map((list) => list.map((a) => a.assetId)),
        forgeLevel,
        slotsFree.weapon,
        slotsFree.supply,
        slotsFree.lavalux
      ]),
    [free, forgeLevel, slotsFree]
  )
  const [plans, setPlans] = useState<{ key: string; byMission: Map<number, MissionPlan | null> }>({
    key: '',
    byMission: new Map()
  })
  useEffect(() => {
    let cancelled = false
    const byMission = new Map<number, MissionPlan | null>()
    setPlans({ key: reserveKey, byMission: new Map() })
    let i = 0
    const next = () => {
      if (cancelled || i >= missions.length) return
      const m = missions[i++]
      byMission.set(m.id, planMissionDivision(free, { atk: m.minAtk, def: m.minDef }, forgeLevel, slotsFree))
      setPlans({ key: reserveKey, byMission: new Map(byMission) })
      setTimeout(next, 0)
    }
    setTimeout(next, 0)
    return () => {
      cancelled = true
    }
    // The reserve's content is in reserveKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reserveKey, missions])
  const planned = plans.key === reserveKey ? plans.byMission : new Map<number, MissionPlan | null>()

  // Until the user picks one, show the first mission the reserve can field.
  const firstReachable = missions.find((m) => planned.get(m.id))?.id ?? null
  const shownId = missionId ?? firstReachable
  const mission = missions.find((m) => m.id === shownId) ?? null
  const plan = mission ? (planned.get(mission.id) ?? null) : null
  const planning = !!mission && !planned.has(mission.id)

  async function create(m: MissionEconomics) {
    if (!plan) return
    const b = plan.bundle
    const id = (key: string) => plan.assets.get(key)!.assetId
    const leader = id(b.warlord.key)
    const created = await run((a, p) => [createDivision(a, p, leader)], 'Division created, adding the troops…', 'mission-div')
    if (!created) return
    // The new division's id is only known once the chain has it.
    let divisionId: number | null = null
    for (let i = 0; i < 10 && divisionId === null; i++) {
      const fresh = await army.refetch()
      divisionId = fresh.data?.divisions.find((d) => d.leader?.assetId === leader)?.id ?? null
      if (divisionId === null) await new Promise((r) => setTimeout(r, 1500))
    }
    if (divisionId === null) {
      toast.error('The new division has not shown up yet. Open it in a moment and use Auto-fill to finish.')
      onCreated(null)
      return
    }
    const div = divisionId
    const ok = await run(
      (a, p) => [
        ...b.units.map((u) => addUnit(a, p, div, id(u.merc.key))),
        ...b.units.flatMap((u) =>
          GEAR_KINDS.filter((k) => u.gear[k]).map((k) => assignGear(a, p, div, id(u.merc.key), k, id(u.gear[k]!.key)))
        )
      ],
      `Division #${div} is ready for ${m.title}: ${formatNumber(b.atk, 0)} ATK / ${formatNumber(b.def, 0)} DEF`,
      'mission-div'
    )
    onCreated(ok ? div : null)
  }

  // Why nothing can be built, when that is the case.
  const freeWarlords = free.warlord.filter((w) => (w.stats?.slots_max ?? 0) > 0)
  const shortBecause =
    freeWarlords.length === 0
      ? 'Every staked warlord already leads a division, and a new division needs a free one. Disband a division or stake another warlord first.'
      : free.mercenary.length === 0
        ? 'There is no mercenary in your reserve. Take some out of a division or stake more first.'
        : null

  const gearCount = plan ? GEAR_KINDS.reduce((n, k) => n + plan.bundle.gear[k].length, 0) : 0

  return (
    <Modal className="picker mdiv" onClose={onClose} label="Division for a mission">
      <header className="picker__head">
        <div>
          <p className="eyebrow">From your reserve</p>
          <h3>A division for a mission</h3>
          <p className="muted">
            Pick a mission. The division that just meets it is built from your staked NFTs: the weakest units that reach the
            requirement, so your strong ones stay free, with the lowest move cost for a short lock.
          </p>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
          <XIcon />
        </button>
      </header>

      {!config.data ? (
        <Loading inline label="Reading the missions" />
      ) : (
        <div className="mdiv__layout">
          <ul className="mdiv__missions">
            {missions.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  className={`mdiv__mission ${m.id === shownId ? 'is-on' : ''} ${planned.get(m.id) === null ? 'is-short' : ''}`}
                  onClick={() => setMissionId(m.id)}
                >
                  <PlanetIcon planet={m.planet} size={22} />
                  <span className="mdiv__mission-text">
                    <b>{m.title}</b>
                    <small className="faint">{rewardParts(m).join(' + ') || 'No reward listed'}</small>
                  </span>
                  <span className="mdiv__req num">
                    {m.minAtk > 0 && <span className="c-atk">{formatNumber(m.minAtk, 0)} ATK</span>}
                    {m.minDef > 0 && <span className="c-def">{formatNumber(m.minDef, 0)} DEF</span>}
                  </span>
                  <MissionStrip plan={planned.get(m.id)} pending={!planned.has(m.id)} />
                </button>
              </li>
            ))}
          </ul>

          <section className="mdiv__plan">
            {!mission ? (
              <p className="muted">
                {planned.size < missions.length
                  ? 'Working out what your reserve can field…'
                  : 'Your reserve cannot field any of these missions yet.'}
              </p>
            ) : planning ? (
              <Loading inline label="Picking the troops" />
            ) : !plan ? (
              <div className="empty">
                <strong>{shortBecause ? 'Nothing to build with' : 'Your reserve cannot reach this'}</strong>
                <span>
                  {shortBecause ?? (
                    <>
                      The staked NFTs in no division, with your free Forge slots, fall short of {formatNumber(mission.minAtk, 0)}{' '}
                      ATK
                      {mission.minDef ? ` / ${formatNumber(mission.minDef, 0)} DEF` : ''}. Disband a division or stake more first.
                    </>
                  )}
                </span>
              </div>
            ) : (
              <>
                <div className="mdiv__head">
                  <CardArt asset={plan.assets.get(plan.bundle.warlord.key)!} shape="square" className="mdiv__leader" />
                  <div>
                    <p className="eyebrow">{mission.title}</p>
                    <h4>{plan.assets.get(plan.bundle.warlord.key)!.name}</h4>
                    <StatTrio atk={plan.bundle.atk} def={plan.bundle.def} move={plan.bundle.move} />
                    <p className="faint mdiv__lock">
                      <TimerIcon width={12} height={12} /> Mission lock{' '}
                      {formatDuration(missionLockSeconds(mission.cooldownBase, plan.bundle.move))} · {plan.bundle.mercs.length} of{' '}
                      {plan.bundle.warlord.slots} slots · {gearCount} gear
                    </p>
                  </div>
                </div>
                <ul className="mdiv__units">
                  {plan.bundle.units.map((u) => {
                    const merc = plan.assets.get(u.merc.key)!
                    return (
                      <li key={u.merc.key}>
                        <CardArt asset={merc} shape="square" className="mdiv__unit-art" />
                        <span className="mdiv__unit-body">
                          <span className="mdiv__unit-name" style={{ color: rarityColor(merc.rarity) }}>
                            {merc.name}
                          </span>
                          <span className="mdiv__unit-gear">
                            {GEAR_KINDS.filter((k) => u.gear[k]).map((k) => {
                              const g = plan.assets.get(u.gear[k]!.key)!
                              return (
                                <span key={k} className="mdiv__gear" title={g.name}>
                                  <CardArt asset={g} shape="square" className="mdiv__gear-art" />
                                  <small>{g.name}</small>
                                </span>
                              )
                            })}
                          </span>
                        </span>
                        <StatTrio atk={u.atk} def={u.def} move={u.move} size="sm" />
                      </li>
                    )
                  })}
                </ul>
                <footer className="picker__foot">
                  <span className="faint">Two transactions: create the division, then add the troops.</span>
                  <Button
                    color="gradientYellow"
                    disabled={spectating || !account}
                    isLoading={pending === 'mission-div'}
                    onClick={() => void create(mission)}
                  >
                    Create this division
                  </Button>
                </footer>
              </>
            )}
          </section>
        </div>
      )}
    </Modal>
  )
}

/** The troops a mission would get, as a row of small portraits (or why there are none). */
function MissionStrip({ plan, pending }: { plan: MissionPlan | null | undefined; pending: boolean }) {
  if (pending) return <span className="mdiv__strip faint">…</span>
  if (!plan) return <span className="mdiv__strip faint">not enough in reserve</span>
  const b = plan.bundle
  const faces = [b.warlord.key, ...b.mercs.map((m) => m.key)]
  const shown = faces.slice(0, 6)
  const gear = GEAR_KINDS.reduce((n, k) => n + b.gear[k].length, 0)
  return (
    <span className="mdiv__strip">
      {shown.map((key) => (
        <CardArt key={key} asset={plan.assets.get(key)!} shape="square" className="mdiv__face" />
      ))}
      {faces.length > shown.length && <small className="faint">+{faces.length - shown.length}</small>}
      {gear > 0 && <small className="faint">· {gear} gear</small>}
    </span>
  )
}
