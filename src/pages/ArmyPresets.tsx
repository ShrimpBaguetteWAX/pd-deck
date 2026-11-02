import { useMemo, useState } from 'react'

import { addUnit, assignGear, createDivision } from '@/chain/actions/pd'
import { Button } from '@/components/Button'
import { Modal } from '@/components/Modal'
import { toast } from '@/components/toast'
import type { AssetRef } from '@/data/assets'
import { useArmy, type Division } from '@/data/game'
import { CheckIcon, XIcon } from '@/icons'
import {
  isCurrent,
  planRestore,
  readPresets,
  snapshot,
  writePresets,
  type Preset,
  type PresetDivision,
  type RestorePlan
} from '@/lib/armyPresets'
import { GEAR_KINDS, type GearKind, type Kind } from '@/lib/stats'
import { useTransaction } from '@/wallet/useTransaction'

import { disbandActions } from './ArmyMissions'

/*
 * Army presets: save the army exactly as built, and come back to it with one click. Kept in this
 * browser, per account. Restoring runs like Optimize: take apart what differs, create the divisions
 * the preset needs, then add every mercenary and its gear; a step that fails can be resumed.
 */

type Step = 'disband' | 'create' | 'fill'
interface Run {
  steps: Step[]
  done: Step[]
  failed: Step | null
  created: Map<string, number>
}

const dateOf = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const unitsOf = (ds: PresetDivision[]) => ds.reduce((n, d) => n + d.units.length, 0)

export function ArmyPresetsModal({
  account,
  divisions,
  free,
  editable,
  onClose,
  onDone
}: {
  account: string | null
  divisions: Division[]
  free: Record<Kind, AssetRef[]>
  /** Whether a division can be changed now (idle or empty). */
  editable: (d: Division) => boolean
  onClose: () => void
  onDone: () => void
}) {
  const { run, pending, spectating } = useTransaction()
  const army = useArmy(account)
  const [presets, setPresets] = useState<Preset[]>(() => readPresets(account))
  const [name, setName] = useState('')
  const [restoring, setRestoring] = useState<Preset | null>(null)
  // Worked out when Restore is pressed and kept: the army changes under it as the steps run.
  const [plan, setPlan] = useState<RestorePlan | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [runState, setRunState] = useState<Run | null>(null)
  const busy = pending === 'preset'

  // Every NFT by asset id, for names in the summaries.
  const names = useMemo(() => {
    const m = new Map<string, string>()
    for (const list of Object.values(free)) for (const a of list) m.set(a.assetId, a.name)
    for (const d of divisions) {
      if (d.leader) m.set(d.leader.assetId, d.leader.name)
      for (const u of d.units) {
        m.set(u.asset.assetId, u.asset.name)
        for (const k of GEAR_KINDS) if (u.gear[k]) m.set(u.gear[k]!.assetId, u.gear[k]!.name)
      }
    }
    return m
  }, [divisions, free])

  const save = (list: Preset[]) => {
    if (!account) return
    setPresets(list)
    if (!writePresets(account, list)) toast.error('This browser would not keep the preset (storage blocked or full).')
  }

  const current = snapshot(divisions)
  function saveNew() {
    const label = name.trim() || `Preset ${presets.length + 1}`
    save([{ id: `${Date.now()}`, name: label, savedAt: Date.now(), divisions: current }, ...presets])
    setName('')
    toast.success(`"${label}" saved: ${count(current.length, 'division')}`)
  }
  const overwrite = (p: Preset) => {
    save(presets.map((x) => (x.id === p.id ? { ...x, savedAt: Date.now(), divisions: current } : x)))
    toast.success(`"${p.name}" now holds the army as it is`)
  }
  const remove = (p: Preset) => {
    save(presets.filter((x) => x.id !== p.id))
    setConfirmDelete(null)
  }

  const steps: Step[] = plan
    ? [
        ...(plan.disband.length ? (['disband'] as Step[]) : []),
        ...(plan.build.length ? (['create'] as Step[]) : []),
        ...(unitsOf(plan.build) ? (['fill'] as Step[]) : [])
      ]
    : []
  const state: Run = runState ?? { steps, done: [], failed: null, created: new Map() }
  const finished = !!plan && steps.length > 0 && state.done.length === steps.length

  async function execute(from: Run) {
    if (!plan || !restoring) return
    let cur: Run = { ...from, failed: null }
    setRunState(cur)
    const leaders = plan.build.map((d) => d.leader)
    for (const step of steps) {
      if (cur.done.includes(step)) continue
      let ok = false
      if (step === 'disband') {
        ok = await run(
          (a, p) => plan.disband.flatMap((d) => disbandActions(a, p, d)),
          `${count(plan.disband.length, 'division')} taken apart`,
          'preset'
        )
      } else if (step === 'create') {
        ok = await run(
          (a, p) => leaders.map((leader) => createDivision(a, p, leader)),
          `${count(leaders.length, 'division')} created`,
          'preset'
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
            plan.build.flatMap((d) => {
              const id = created.get(d.leader)!
              return [
                ...d.units.map((u) => addUnit(a, p, id, u.merc)),
                ...d.units.flatMap((u) =>
                  (Object.entries(u.gear) as [GearKind, string][]).map(([k, g]) => assignGear(a, p, id, u.merc, k, g))
                )
              ]
            }),
          `"${restoring.name}" restored`,
          'preset'
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
      ? `Take apart ${count(plan!.disband.length, 'division')} that differ`
      : s === 'create'
        ? `Create ${count(plan!.build.length, 'division')}`
        : `Add ${count(unitsOf(plan!.build), 'mercenary', 'mercenaries')} and their gear`

  return (
    <Modal className="picker presets" onClose={onClose} label="Army presets" locked={busy}>
      <header className="picker__head">
        <div>
          <p className="eyebrow">{restoring ? 'Restore preset' : 'Saved in this browser'}</p>
          <h3>{restoring ? restoring.name : 'Army presets'}</h3>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} disabled={busy} aria-label="Close">
          <XIcon />
        </button>
      </header>

      {!restoring ? (
        <>
          <form
            className="presets__save"
            onSubmit={(e) => {
              e.preventDefault()
              if (current.length) saveNew()
            }}
          >
            <input
              className="presets__name"
              value={name}
              maxLength={40}
              placeholder={`Preset ${presets.length + 1}`}
              onChange={(e) => setName(e.target.value)}
              aria-label="Preset name"
            />
            <Button type="submit" size="sm" disabled={!current.length}>
              Save current army
            </Button>
          </form>
          <p className="muted presets__hint">
            Saves every division as it stands: {count(current.length, 'division')},{' '}
            {count(unitsOf(current), 'mercenary', 'mercenaries')} and the gear on each.
          </p>

          {presets.length === 0 ? (
            <div className="empty">
              <strong>No presets yet</strong>
              <span>Build your divisions the way you like them, then save them here to come back to with one click.</span>
            </div>
          ) : (
            <ul className="presets__list">
              {presets.map((p) => {
                const now = isCurrent(p, divisions)
                return (
                  <li key={p.id} className={`presets__row${now ? ' is-current' : ''}`}>
                    <div className="presets__info">
                      <b>
                        {p.name}
                        {now && (
                          <span className="presets__badge">
                            <CheckIcon width={11} height={11} /> As it stands
                          </span>
                        )}
                      </b>
                      <small>
                        {count(p.divisions.length, 'division')} · {count(unitsOf(p.divisions), 'mercenary', 'mercenaries')} ·
                        saved {dateOf(p.savedAt)}
                      </small>
                    </div>
                    <div className="presets__actions">
                      {confirmDelete === p.id ? (
                        <>
                          <Button size="sm" color="ghost" onClick={() => setConfirmDelete(null)}>
                            Keep
                          </Button>
                          <Button size="sm" color="ghost" onClick={() => remove(p)}>
                            Delete
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button size="sm" color="ghost" onClick={() => setConfirmDelete(p.id)} title="Delete this preset">
                            Delete
                          </Button>
                          <Button
                            size="sm"
                            color="ghost"
                            disabled={!current.length || now}
                            onClick={() => overwrite(p)}
                            title="Replace this preset with the army as it stands"
                          >
                            Update
                          </Button>
                          <Button
                            size="sm"
                            color="solidBlue"
                            disabled={now}
                            onClick={() => {
                              setRunState(null)
                              setPlan(planRestore(p, divisions, free, editable))
                              setRestoring(p)
                            }}
                          >
                            Restore
                          </Button>
                        </>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </>
      ) : (
        plan && (
          <div className="presets__restore">
            <ul className="presets__facts">
              <li>
                <b>{plan.keep.length}</b> already as saved, left alone
              </li>
              <li>
                <b>{plan.disband.length}</b> taken apart (their NFTs go back to the reserve first)
              </li>
              <li>
                <b>{plan.build.length}</b> built from the preset
              </li>
              {plan.locked.length > 0 && (
                <li>
                  <b>{plan.locked.length}</b> out on a mission or waiting for a claim: they cannot change and stay as they are
                </li>
              )}
            </ul>
            {(plan.skipped.length > 0 || plan.missing.length > 0 || plan.held.length > 0) && (
              <div className="presets__warn">
                {plan.skipped.map((s) => (
                  <p key={s.division.leader}>
                    {names.get(s.division.leader) ?? `Warlord ${s.division.leader}`} is left out: {s.reason}.
                  </p>
                ))}
                {plan.missing.length > 0 && (
                  <p>No longer staked, left out: {plan.missing.map((id) => names.get(id) ?? `#${id}`).join(', ')}.</p>
                )}
                {plan.held.length > 0 && (
                  <p>
                    In a division out on a mission or waiting for a claim, left out for now:{' '}
                    {plan.held.map((id) => names.get(id) ?? `#${id}`).join(', ')}. Restore again once it is back.
                  </p>
                )}
              </div>
            )}

            {steps.length === 0 ? (
              <p className="muted">Nothing to do: everything that can change already matches.</p>
            ) : (
              <ol className="presets__steps">
                {steps.map((s) => (
                  <li key={s} className={state.done.includes(s) ? 'is-done' : state.failed === s ? 'is-failed' : ''}>
                    <span>{state.done.includes(s) ? <CheckIcon width={12} height={12} /> : steps.indexOf(s) + 1}</span>
                    {stepLabel(s)}
                  </li>
                ))}
              </ol>
            )}
            {spectating && <p className="muted">You are viewing this account read-only; sign in with your wallet to restore.</p>}
          </div>
        )
      )}

      {restoring && (
        <footer className="picker__foot">
          <Button
            color="ghost"
            disabled={busy}
            onClick={() => {
              if (finished) onDone()
              setRestoring(null)
              setPlan(null)
              setRunState(null)
            }}
          >
            {finished ? 'Done' : 'Back'}
          </Button>
          {!finished && steps.length > 0 && (
            <Button color="gradientGreen" isLoading={busy} disabled={busy || spectating} onClick={() => void execute(state)}>
              {state.failed ? 'Resume' : `Restore "${restoring.name}"`}
            </Button>
          )}
        </footer>
      )}
    </Modal>
  )
}
