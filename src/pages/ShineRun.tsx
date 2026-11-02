import { useState } from 'react'

import { ascendAction, sacrificeAction } from '@/chain/actions/ascend'
import { buySalesActions } from '@/chain/actions/market'
import { addUnit, assignGear, createDivision, removeUnit, stakeAssets, unassignGear, unstakeAsset } from '@/chain/actions/pd'
import { atomic } from '@/chain/atomic'
import { COLLECTIONS, CONTRACTS, FRAGMENT_TEMPLATE } from '@/chain/config'
import { getRows } from '@/chain/rpc'
import { Button } from '@/components/Button'
import { toast } from '@/components/toast'
import type { AssetRef } from '@/data/assets'
import { costKey, type AscensionConfig } from '@/data/ascension'
import { useArmy, type Division } from '@/data/game'
import { queryClient } from '@/data/queryClient'
import { CheckIcon } from '@/icons'
import { formatNumber } from '@/lib/format'
import { buyFragments, type FragmentOffer } from '@/lib/shinePlan'
import { GEAR_KINDS, type GearKind } from '@/lib/stats'
import { useTransaction } from '@/wallet/useTransaction'

import { disbandActions } from './ArmyMissions'

/*
 * Doing what the shine planner shows, step by step, each step one or more wallet signatures:
 *
 *  1. Buy: the cheapest Fragments and cards to sacrifice, in one transaction that also sends those
 *     cards to the altar. The oracle reveals the sacrifice a few seconds later; if the luck of the
 *     draw leaves the wallet short, Resume buys the rest.
 *  2. Free: the cards come out of the division and out of the game into the wallet (a warlord only
 *     by taking the division apart).
 *  3. Ascend: one star per card per transaction round. Every star mints a new card, so each round
 *     waits for the new ones to show up before the next.
 *  4. Restake: the new cards go back into the game and onto the same mercenaries; a new warlord
 *     gets its division again (a new one, with a new number), then its mercenaries and gear.
 *
 * Everything is worked out when the run starts and kept, since the army changes under it.
 */

export type ShineRole = { kind: 'warlord' } | { kind: 'merc' } | { kind: 'gear'; gear: GearKind; unit: string }

export interface ShineCard {
  asset: AssetRef
  role: ShineRole
  /** Templates one star up each. */
  path: string[]
  /** Stars to add. */
  steps: number
  fromStars: number
}

export interface ShinePlan {
  division: Division
  cards: ShineCard[]
  /** Fragments the stars cost in all. */
  needed: number
  /** Fragments of your own left alone (when you chose not to use them). */
  reserve: number
}

type Phase = 'buy' | 'free' | 'ascend' | 'restake' | 'fill'
interface Progress {
  done: Phase[]
  failed: Phase | null
  /** Each card's asset id now, by its original id. */
  ids: Record<string, string>
  /** Stars each card has gained so far. */
  starsDone: Record<string, number>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** The wallet's game NFTs by template, straight from AtomicAssets. */
async function owned(account: string): Promise<Map<string, string[]>> {
  const lists = await Promise.all(COLLECTIONS.map((c) => atomic.getOwnedAssets(account, c).catch(() => [])))
  const m = new Map<string, string[]>()
  for (const a of lists.flat()) {
    if (!a.template) continue
    const t = String(a.template.template_id)
    m.set(t, [...(m.get(t) ?? []), String(a.asset_id)])
  }
  return m
}

/** Waits until the oracle has revealed every sacrifice of the account (a minute and a half at most). */
async function revealed(account: string): Promise<boolean> {
  for (let i = 0; i < 45; i++) {
    const rows = await getRows<{ player: string }>({
      code: CONTRACTS.ASCEND,
      scope: CONTRACTS.ASCEND,
      table: 'pendingburns'
    }).catch(() => null)
    if (rows && !rows.some((r) => r.player === account)) return true
    await sleep(2000)
  }
  return false
}

export function ShineRun({
  account,
  plan,
  offers,
  cfg,
  editable,
  blocked: reason = '',
  onStart,
  onReset
}: {
  account: string
  plan: ShinePlan
  offers: FragmentOffer[]
  cfg: AscensionConfig
  /** Whether the division can be changed now (not out on a mission, nothing to claim). */
  editable: boolean
  /** Why it cannot be done at all, if so. */
  blocked?: string
  /** The plan, frozen, when the run starts. */
  onStart: (plan: ShinePlan) => void
  /** Back to planning, once a run is finished. */
  onReset: () => void
}) {
  const { run, pending, spectating } = useTransaction()
  const army = useArmy(account)
  // The plan as it was when Shine it was pressed.
  const [frozen, setFrozen] = useState<ShinePlan | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  const busy = pending === 'shine'
  const p = frozen ?? plan
  const warlord = p.cards.find((c) => c.role.kind === 'warlord')
  const phases: Phase[] = ['buy', 'free', 'ascend', 'restake', ...(warlord ? (['fill'] as Phase[]) : [])]
  const finished = !!progress && phases.every((x) => progress.done.includes(x))

  const idOf = (pr: Progress, id: string) => pr.ids[id] ?? id

  async function execute() {
    const plan = frozen ?? p
    if (!frozen) {
      setFrozen(plan)
      onStart(plan)
    }
    let pr: Progress = progress ? { ...progress, failed: null } : { done: [], failed: null, ids: {}, starsDone: {} }
    setProgress(pr)
    const d = plan.division
    const lead = plan.cards.find((c) => c.role.kind === 'warlord')

    for (const phase of phases) {
      if (pr.done.includes(phase)) continue
      let ok = false

      if (phase === 'buy') {
        // Fragments still to come for the stars not yet done.
        const left = plan.cards.reduce((n, c) => {
          for (let k = pr.starsDone[c.asset.assetId] ?? 0; k < c.steps; k++)
            n += cfg.costs.get(costKey(c.asset.rarity, c.fromStars + k)) ?? 0
          return n
        }, 0)
        const have = (await owned(account)).get(FRAGMENT_TEMPLATE)?.length ?? 0
        const missing = left + plan.reserve - have
        if (missing <= 0) ok = true
        else {
          const buy = buyFragments(missing, offers)
          if (buy.short || !buy.picks.length) {
            toast.error(`The market holds too few Fragments and cards for the ${missing} Fragments still missing.`)
          } else {
            const sacrifice = buy.picks.filter((o) => o.sacrifice).map((o) => o.listing.assetId)
            ok = await run(
              (a, perm) => [
                ...buySalesActions(
                  a,
                  perm,
                  buy.picks.map((o) => o.listing)
                ),
                ...(sacrifice.length ? [sacrificeAction(a, perm, sacrifice)] : [])
              ],
              `Bought ${count(buy.picks.length - sacrifice.length, 'Fragment')}${sacrifice.length ? ` and sacrificed ${count(sacrifice.length, 'card')}` : ''} for ${formatNumber(buy.wax, 2)} WAX`,
              'shine'
            )
            void queryClient.invalidateQueries({ queryKey: ['market-listings'] })
            if (ok && sacrifice.length) {
              if (!(await revealed(account))) {
                toast.error('The altar has not revealed the sacrifice yet. Wait a moment and press Resume.')
                ok = false
              }
            }
            if (ok) {
              // A sacrifice pays out by chance: check, and buy the rest on Resume when it fell short.
              await sleep(2000)
              const now = (await owned(account)).get(FRAGMENT_TEMPLATE)?.length ?? 0
              if (now < left + plan.reserve) {
                toast.error(
                  `The sacrifices gave fewer Fragments than average: ${left + plan.reserve - now} short. Press Resume to buy the rest.`
                )
                ok = false
              }
            }
          }
        }
      } else if (phase === 'free') {
        const out = plan.cards.map((c) => c.asset.assetId)
        ok = await run(
          (a, perm) => {
            if (lead) return [...disbandActions(a, perm, d), ...out.map((id) => unstakeAsset(a, perm, id))]
            return plan.cards.flatMap((c) => {
              if (c.role.kind === 'gear')
                return [unassignGear(a, perm, d.id, c.role.unit, c.asset.assetId), unstakeAsset(a, perm, c.asset.assetId)]
              // A mercenary: its gear off first, then it leaves the division.
              const u = d.units.find((x) => x.asset.assetId === c.asset.assetId)
              return [
                ...GEAR_KINDS.filter((k) => u?.gear[k]).map((k) =>
                  unassignGear(a, perm, d.id, c.asset.assetId, u!.gear[k]!.assetId)
                ),
                removeUnit(a, perm, c.asset.assetId),
                unstakeAsset(a, perm, c.asset.assetId)
              ]
            })
          },
          `${count(out.length, 'card')} back in your wallet`,
          'shine'
        )
      } else if (phase === 'ascend') {
        ok = true
        // One round per star: each card that still has one to gain goes up one.
        while (ok) {
          const round = plan.cards.filter((c) => (pr.starsDone[c.asset.assetId] ?? 0) < c.steps)
          if (!round.length) break
          const before = await owned(account)
          const fragments = [...(before.get(FRAGMENT_TEMPLATE) ?? [])]
          const costs = round.map(
            (c) => cfg.costs.get(costKey(c.asset.rarity, c.fromStars + (pr.starsDone[c.asset.assetId] ?? 0))) ?? 0
          )
          const total = costs.reduce((n, x) => n + x, 0)
          if (fragments.length < total) {
            toast.error(`${fragments.length} Fragments in the wallet, this round needs ${total}. Press Resume to buy the rest.`)
            pr = { ...pr, done: pr.done.filter((x) => x !== 'buy') }
            ok = false
            break
          }
          let at = 0
          const slices = costs.map((c) => fragments.slice(at, (at += c)))
          ok = await run(
            (a, perm) => round.map((c, i) => ascendAction(a, perm, idOf(pr, c.asset.assetId), slices[i])),
            `${count(round.length, 'card')} up a star`,
            'shine'
          )
          if (!ok) break
          // The new cards: of each target template, the one that was not there before.
          const targets = round.map((c) => c.path[pr.starsDone[c.asset.assetId] ?? 0])
          let found: (string | undefined)[] = []
          for (let i = 0; i < 15; i++) {
            await sleep(2000)
            const after = await owned(account)
            const taken = new Set<string>()
            found = targets.map((t) => {
              const id = (after.get(t) ?? []).find((x) => !(before.get(t) ?? []).includes(x) && !taken.has(x))
              if (id) taken.add(id)
              return id
            })
            if (found.every(Boolean)) break
          }
          if (!found.every(Boolean)) {
            toast.error('The new cards have not shown up yet. Wait a moment and press Resume.')
            ok = false
            break
          }
          const ids = { ...pr.ids }
          const starsDone = { ...pr.starsDone }
          round.forEach((c, i) => {
            ids[c.asset.assetId] = found[i]!
            starsDone[c.asset.assetId] = (starsDone[c.asset.assetId] ?? 0) + 1
          })
          pr = { ...pr, ids, starsDone }
          setProgress(pr)
        }
      } else if (phase === 'restake') {
        const fresh = plan.cards.map((c) => idOf(pr, c.asset.assetId))
        ok = await run(
          (a, perm) => {
            if (lead) return [stakeAssets(a, perm, fresh), createDivision(a, perm, idOf(pr, lead.asset.assetId))]
            return [
              stakeAssets(a, perm, fresh),
              ...plan.cards.flatMap((c) => {
                if (c.role.kind === 'gear') {
                  // Gear of a mercenary that is ascending too goes back on with it, below.
                  if (plan.cards.some((x) => x.asset.assetId === (c.role as { unit: string }).unit)) return []
                  return [assignGear(a, perm, d.id, c.role.unit, c.role.gear, idOf(pr, c.asset.assetId))]
                }
                const u = d.units.find((x) => x.asset.assetId === c.asset.assetId)
                const merc = idOf(pr, c.asset.assetId)
                return [
                  addUnit(a, perm, d.id, merc),
                  ...GEAR_KINDS.filter((k) => u?.gear[k]).map((k) =>
                    assignGear(a, perm, d.id, merc, k, idOf(pr, u!.gear[k]!.assetId))
                  )
                ]
              })
            ]
          },
          lead ? 'Cards staked and the division made again' : 'Cards staked and equipped again',
          'shine'
        )
      } else {
        // The warlord's new division: find its number, then put every mercenary and its gear back.
        const leader = idOf(pr, lead!.asset.assetId)
        let id: number | undefined
        for (let i = 0; i < 10 && id === undefined; i++) {
          const fresh = await army.refetch()
          id = fresh.data?.divisions.find((x) => x.leader?.assetId === leader)?.id
          if (id === undefined) await sleep(1500)
        }
        if (id === undefined) {
          toast.error('The new division has not shown up yet. Wait a moment and press Resume.')
        } else {
          const div = id
          ok = await run(
            (a, perm) => [
              ...d.units.map((u) => addUnit(a, perm, div, idOf(pr, u.asset.assetId))),
              ...d.units.flatMap((u) =>
                GEAR_KINDS.filter((k) => u.gear[k]).map((k) =>
                  assignGear(a, perm, div, idOf(pr, u.asset.assetId), k, idOf(pr, u.gear[k]!.assetId))
                )
              )
            ],
            `Division ${div} is back together`,
            'shine'
          )
        }
      }

      if (!ok) {
        pr = { ...pr, failed: phase }
        setProgress(pr)
        return
      }
      pr = { ...pr, done: [...pr.done, phase] }
      setProgress(pr)
    }
    void army.refetch()
  }

  const n = p.cards.length
  const label = (x: Phase) =>
    x === 'buy'
      ? 'Buy the Fragments still missing (and cards to sacrifice for them)'
      : x === 'free'
        ? warlord
          ? `Take Division ${p.division.id} apart and unstake ${count(n, 'card')}`
          : `Unequip and unstake ${count(n, 'card')}`
        : x === 'ascend'
          ? `Ascend: ${count(
              p.cards.reduce((m, c) => m + c.steps, 0),
              'star'
            )} in ${count(Math.max(...p.cards.map((c) => c.steps)), 'round')}`
          : x === 'restake'
            ? warlord
              ? 'Stake the new cards and make the division again'
              : 'Stake the new cards and equip them again'
            : 'Put the mercenaries and their gear back'

  const blocked = spectating
    ? 'Read-only while spectating.'
    : reason && !progress
      ? reason
      : !editable && !progress
        ? `Division ${p.division.id} is out on a mission or has a reward to claim: it can be changed once it is back and claimed.`
        : ''

  return (
    <div className="asp__run">
      <ol className="asp__steps">
        {phases.map((x, i) => (
          <li key={x} className={progress?.failed === x ? 'is-failed' : progress?.done.includes(x) ? 'is-done' : ''}>
            <span>{progress?.done.includes(x) ? <CheckIcon width={12} height={12} /> : i + 1}</span>
            {label(x)}
          </li>
        ))}
      </ol>
      {blocked && <p className="faint">{blocked}</p>}
      {finished ? (
        <div className="asp__go">
          <p className="c-green">Done: the stars are on and the division is back in shape.</p>
          <Button size="sm" color="ghost" onClick={onReset}>
            Plan another
          </Button>
        </div>
      ) : (
        <div className="asp__go">
          <Button color="gradientYellow" disabled={!!blocked || busy} isLoading={busy} onClick={() => void execute()}>
            {progress?.failed ? 'Resume' : 'Shine it'}
          </Button>
          <small className="faint">Each step asks your wallet to sign; a step that fails can be resumed.</small>
        </div>
      )}
    </div>
  )
}
