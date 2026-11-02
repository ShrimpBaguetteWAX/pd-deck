import { useMemo, useState } from 'react'

import { CardArt, rarityColor } from '@/components/Art'
import { Button } from '@/components/Button'
import { Figure } from '@/components/Stat'
import type { AssetRef } from '@/data/assets'
import type { AscensionConfig } from '@/data/ascension'
import { liveStats, useArmy, useDeployments, useMarket, useMissionConfig, usePlayer, type Unit } from '@/data/game'
import { useSwapPools } from '@/data/market'
import type { AssetStats } from '@/data/types'
import { MinusIcon, PlusIcon } from '@/icons'
import type { Market } from '@/lib/blendEconomy'
import { formatDuration, formatNumber, formatSigned } from '@/lib/format'
import { cycleSeconds, isTokenLoop, meetsRequirements, missionEconomics, tlmPerHour, type MissionEconomics } from '@/lib/loop'
import { receiveFor } from '@/lib/pool'
import { ascendPath, buyFragments, fragmentOffers, fragmentsFor } from '@/lib/shinePlan'
import { KIND_LABEL, kindOf } from '@/lib/stats'
import { useNow } from '@/lib/time'
import { useTransaction } from '@/wallet/useTransaction'

import { ShineRun, type ShinePlan, type ShineRole } from './ShineRun'

/*
 * The shine planner: pick a division, pretend any of its cards had more stars, and see what that
 * costs (Fragments, bought on the market as Fragments or as cards to sacrifice, whichever is
 * cheaper) against what it brings: the division's new attack, defense and move, how much more TLM
 * an hour it makes on the mission it is running (or would run), and how long until it pays back.
 */

const stars = (a: AssetRef) => Number(a.stats?.min_forge_level ?? 0)
const pct = (n: number) => `${n > 0 ? '+' : ''}${formatNumber(n, 0)}%`
const tlm = (n: number) => formatNumber(n, Math.abs(n) >= 100 ? 0 : 2)

interface Card {
  asset: AssetRef
  /** Where it sits, e.g. "Warlord", "Weapon of Grunt". */
  place: string
  role: ShineRole
  path: string[]
}

export function ShinePlanner({
  account,
  cfg,
  stats,
  market,
  fragmentsOwned
}: {
  account: string
  cfg: AscensionConfig
  stats: Map<string, AssetStats>
  market: Market
  fragmentsOwned: number
}) {
  const army = useArmy(account)
  const deployments = useDeployments(account)
  const config = useMissionConfig()
  const player = usePlayer(account)
  const tokens = useMarket()
  const pools = useSwapPools()
  const now = useNow(60_000)
  const [divisionId, setDivisionId] = useState<number | null>(null)
  // Stars added per card (asset id).
  const [extra, setExtra] = useState<Record<string, number>>({})
  const [useOwn, setUseOwn] = useState(true)
  // Once Shine it is pressed the plan is kept as it was: cards and divisions change under the run.
  const [shining, setShining] = useState<ShinePlan | null>(null)
  const [startToken, setStartToken] = useState(0)
  const { spectating } = useTransaction()

  const divisions = useMemo(() => (army.data?.divisions ?? []).filter((d) => d.leader && d.units.length), [army.data])
  const division = shining?.division ?? divisions.find((d) => d.id === divisionId) ?? divisions[0] ?? null

  const missions = useMemo(
    () =>
      config.data
        ? config.data.missions.map((m) => missionEconomics(m, config.data!, now)).filter((e) => e.state !== 'closed')
        : [],
    [config.data, now]
  )
  const offers = useMemo(() => fragmentOffers(market, cfg), [market, cfg])

  if (!division) return null

  // Every card in the division that can still go up a star.
  const cards: Card[] = []
  const add = (asset: AssetRef | undefined | null, place: string, role: ShineRole) => {
    if (!asset) return
    const path = ascendPath(asset.templateId, cfg.next)
    if (path.length) cards.push({ asset, place, role, path })
  }
  add(division.leader, 'Warlord', { kind: 'warlord' })
  for (const u of division.units) {
    const unit = u.asset.assetId
    add(u.asset, 'Mercenary', { kind: 'merc' })
    add(u.gear.weapon, `Weapon of ${u.asset.name}`, { kind: 'gear', gear: 'weapon', unit })
    add(u.gear.supply, `Supply of ${u.asset.name}`, { kind: 'gear', gear: 'supply', unit })
    add(u.gear.creature, `Creature of ${u.asset.name}`, { kind: 'gear', gear: 'creature', unit })
    add(u.gear.lavalux, `Lava Lux of ${u.asset.name}`, { kind: 'gear', gear: 'lavalux', unit })
  }
  const stepsOf = (c: Card) => Math.min(extra[c.asset.assetId] ?? 0, c.path.length)
  const setSteps = (c: Card, n: number) => setExtra((x) => ({ ...x, [c.asset.assetId]: Math.max(0, Math.min(c.path.length, n)) }))

  // The division with shined cards: each takes the stats of its template that many stars up.
  const before = liveStats(division.units, division.units.length, division.leader) ?? division
  const statsWith = (stepsFor: (c: Card) => number) => {
    const shined = (a: AssetRef | undefined | null): AssetRef | undefined => {
      if (!a) return undefined
      const c = cards.find((x) => x.asset.assetId === a.assetId)
      const n = c ? stepsFor(c) : 0
      const to = n ? stats.get(c!.path[n - 1]) : undefined
      return to ? { ...a, stats: to } : a
    }
    const units: Unit[] = division.units.map((u) => ({
      asset: shined(u.asset)!,
      gear: {
        weapon: shined(u.gear.weapon),
        supply: shined(u.gear.supply),
        creature: shined(u.gear.creature),
        lavalux: shined(u.gear.lavalux)
      }
    }))
    return liveStats(units, units.length, shined(division.leader)) ?? before
  }
  const after = statsWith(stepsOf)

  // What it costs: Fragments per card, from your own first if you like, the rest off the market.
  let needed = 0
  let unpriced = false
  let topStars = 0
  for (const c of cards) {
    const n = stepsOf(c)
    if (!n) continue
    const f = fragmentsFor(cfg, c.asset.rarity, stars(c.asset), n)
    if (f === null) unpriced = true
    else needed += f
    topStars = Math.max(topStars, stars(c.asset) + n)
  }
  const own = useOwn ? Math.min(fragmentsOwned, needed) : 0
  const buy = buyFragments(needed - own, offers)
  const costTlm = pools.data ? receiveFor(pools.data.tlm, 'WAX', buy.wax) : null
  // The shopping list: the picked listings, by card.
  const shopping = [
    ...buy.picks
      .reduce((m, o) => {
        const key = `${o.listing.templateId}:${o.sacrifice}`
        const s = m.get(key) ?? { key, name: o.listing.asset.name, sacrifice: o.sacrifice, count: 0, wax: 0, fragments: 0 }
        m.set(key, { ...s, count: s.count + 1, wax: s.wax + o.listing.price, fragments: s.fragments + o.fragments })
        return m
      }, new Map<string, { key: string; name: string; sacrifice: boolean; count: number; wax: number; fragments: number }>())
      .values()
  ]
  const forgeLevel = player.data?.forgeLevel ?? 0

  // What it brings: on the mission it is running, or the best TLM loop it would run.
  const out = deployments.data?.find((d) => d.divisionId === division.id)
  const best = (atk: number, def: number, move: number) => {
    let top: { e: MissionEconomics; perHour: number } | null = null
    for (const e of missions) {
      if (e.state !== 'active' || !isTokenLoop(e) || !meetsRequirements(e, atk, def)) continue
      const perHour = tlmPerHour(e, move, tokens)
      if (!top || perHour > top.perHour) top = { e, perHour }
    }
    return top
  }
  const running = out ? missions.find((e) => e.id === out.missionId) : null
  const current = running ?? best(before.atk, before.def, before.move)?.e ?? null
  const nowPerHour = current && isTokenLoop(current) ? tlmPerHour(current, before.move, tokens) : 0
  const thenPerHour = current && isTokenLoop(current) ? tlmPerHour(current, after.move, tokens) : 0
  const gain = thenPerHour - nowPerHour
  // Only a mission the stars open up: one it could not run before.
  const better = best(after.atk, after.def, after.move)
  const unlocked = better && better.e.id !== best(before.atk, before.def, before.move)?.e.id ? better : null
  const switchGain = unlocked && current && unlocked.e.id !== current.id ? unlocked.perHour - nowPerHour : 0
  const payback = (g: number) => (costTlm !== null && g > 0 ? (costTlm / g) * 3600 : null)
  const changed = needed > 0

  // One more star on each card alone, quickest payback first: what it costs and what it adds per
  // hour, on the mission the division runs, or on a better one the star opens up.
  const bestBefore = best(before.atk, before.def, before.move)
  const ranking = cards
    .flatMap((c) => {
      const f = fragmentsFor(cfg, c.asset.rarity, stars(c.asset), 1)
      if (f === null) return []
      const a = statsWith((x) => (x === c ? 1 : 0))
      const onCurrent = current && isTokenLoop(current) ? tlmPerHour(current, a.move, tokens) - nowPerHour : 0
      const top = best(a.atk, a.def, a.move)
      const opens = top && top.e.id !== bestBefore?.e.id && top.perHour - nowPerHour > onCurrent ? top : null
      const gain = opens ? opens.perHour - nowPerHour : onCurrent
      const b = buyFragments(f - (useOwn ? Math.min(fragmentsOwned, f) : 0), offers)
      const tlmCost = pools.data ? receiveFor(pools.data.tlm, 'WAX', b.wax) : null
      const secs = tlmCost !== null && gain > 0 ? (tlmCost / gain) * 3600 : Infinity
      return [
        {
          c,
          f,
          wax: b.wax,
          tlmCost,
          gain,
          secs,
          short: b.short,
          a,
          opens,
          needsForge: stars(c.asset) + 1 > (player.data?.forgeLevel ?? 0)
        }
      ]
    })
    .sort((x, y) => x.secs - y.secs || y.gain - x.gain)
    .slice(0, 10)
  const idle = !division.lock && !out
  const upgrade = (c: Card) => {
    setExtra({ [c.asset.assetId]: 1 })
    setStartToken((t) => t + 1)
  }

  return (
    <section className="bl-section asp">
      <div>
        <h3 className="asc__h">Shine planner</h3>
        <p className="faint bl-explain">
          Pick a division and add stars to any of its cards to see what it would cost and what it would earn. Fragments come from
          your wallet first, the rest from the market at today&apos;s prices: Fragments, or cards to sacrifice when those are
          cheaper per Fragment (counted at their average yield). Nothing is bought or changed here.
        </p>
      </div>

      <div className="segmented asp__divs" role="group" aria-label="Division">
        {divisions.map((d) => (
          <button
            key={d.id}
            type="button"
            className={d.id === division.id ? 'is-active' : ''}
            disabled={!!shining}
            onClick={() => {
              setDivisionId(d.id)
              setExtra({})
            }}
          >
            #{d.id}
          </button>
        ))}
      </div>

      {ranking.length > 0 && (
        <div className="asp__rank panel panel--tight">
          <div className="asp__rank-head">
            <b>Best next star in Division {division.id}</b>
            <small className="faint">
              One more star on each card alone, quickest payback first
              {current ? `, on ${current.title}` : ''}.
            </small>
          </div>
          <ol>
            {ranking.map((r, i) => {
              const why = spectating
                ? 'Read-only while spectating.'
                : !idle
                  ? 'The division is out on a mission or has a reward to claim.'
                  : r.needsForge
                    ? `Needs Forge level ${stars(r.c.asset) + 1} to be equipped.`
                    : r.short
                      ? 'The market holds too few Fragments for it.'
                      : ''
              return (
                <li key={r.c.asset.assetId}>
                  <span className="asp__rank-n num">{i + 1}</span>
                  <CardArt asset={r.c.asset} shape="square" className="asp__rank-art" />
                  <span className="asp__rank-name">
                    <b>{r.c.asset.name}</b>
                    <small className="faint">
                      {r.c.place} · {'★'.repeat(stars(r.c.asset))}
                      <span className="c-green">★</span>
                      {r.a.move !== before.move && (
                        <>
                          {' '}
                          · move {formatNumber(before.move, 0)} → {formatNumber(r.a.move, 0)}
                        </>
                      )}
                      {r.opens && <span className="c-green"> · opens {r.opens.e.title}</span>}
                    </small>
                  </span>
                  <span className="asp__rank-fig num">
                    <b>{r.wax > 0 ? `${formatNumber(r.wax, 0)} WAX` : 'your Fragments'}</b>
                    <small className="faint">{r.f} Fragments</small>
                  </span>
                  <span className="asp__rank-fig num">
                    <b className={r.gain > 0 ? 'c-green' : ''}>{formatSigned(r.gain)}</b>
                    <small className="faint">TLM / h</small>
                  </span>
                  <span className="asp__rank-fig num">
                    <b>{Number.isFinite(r.secs) ? formatDuration(r.secs) : 'never'}</b>
                    <small className="faint">pays back</small>
                  </span>
                  <Button
                    size="sm"
                    color="gradientYellow"
                    disabled={!!why || !!shining}
                    title={why || `Buy what is missing, ascend ${r.c.asset.name} one star and put it back`}
                    onClick={() => upgrade(r.c)}
                  >
                    Upgrade
                  </Button>
                </li>
              )
            })}
          </ol>
        </div>
      )}

      {cards.length === 0 ? (
        <div className="empty">
          <strong>Nothing in Division {division.id} can go up a star</strong>
          <span>Warlords, creatures, supplies and Lava Lux ascend, up to their rarity&apos;s last star.</span>
        </div>
      ) : (
        <div className="asp__cards">
          {cards.map((c) => {
            const n = stepsOf(c)
            const from = stars(c.asset)
            const now = c.asset.stats
            const to = n ? stats.get(c.path[n - 1]) : undefined
            const f = n ? fragmentsFor(cfg, c.asset.rarity, from, n) : 0
            const kind = kindOf(now)
            const line = (s?: AssetStats | null) =>
              !s
                ? '?'
                : kind === 'lavalux'
                  ? `×${(Number(s.attack_mult_bp) / 10000).toFixed(2)} / ×${(Number(s.movecost_mult_bp) / 10000).toFixed(2)} move`
                  : kind === 'warlord'
                    ? `−${s.movecost_reduction} move`
                    : kind === 'supply'
                      ? `${s.attack}/${s.defense} · −${s.movecost_reduction} move`
                      : `${s.attack}/${s.defense} · ${s.movecost} move`
            return (
              <article key={c.asset.assetId} className={`asp__card ${n ? 'is-on' : ''}`}>
                <CardArt asset={c.asset} shape="square" className="asc__art" zoom />
                <div className="asp__name">
                  <b>{c.asset.name}</b>
                  <small style={{ color: rarityColor(c.asset.rarity) }}>
                    {c.asset.rarity} {kind ? KIND_LABEL[kind] : ''} · {c.place}
                  </small>
                  <small className="num">
                    {line(now)}
                    {to && <span className="c-green"> → {line(to)}</span>}
                  </small>
                </div>
                <div className="asp__stars">
                  <span className="asp__rail" aria-label={`${from + n} stars`}>
                    <span className="c-gold">{'★'.repeat(from)}</span>
                    <span className="c-green">{'★'.repeat(n)}</span>
                    <span className="faint">{'☆'.repeat(c.path.length - n)}</span>
                  </span>
                  <span className="stepper stepper--row">
                    <button type="button" aria-label="One star less" disabled={!!shining} onClick={() => setSteps(c, n - 1)}>
                      <MinusIcon width={12} height={12} />
                    </button>
                    <b className="num">+{n}</b>
                    <button type="button" aria-label="One star more" disabled={!!shining} onClick={() => setSteps(c, n + 1)}>
                      <PlusIcon width={12} height={12} />
                    </button>
                  </span>
                  <small className="faint num">{n ? (f === null ? 'no price' : `${f} Fragments`) : ''}</small>
                </div>
              </article>
            )
          })}
        </div>
      )}

      <div className="asp__result panel panel--tight">
        <div className="asp__figures">
          <Figure
            label="Attack"
            value={
              after.atk === before.atk
                ? formatNumber(before.atk, 0)
                : `${formatNumber(before.atk, 0)} → ${formatNumber(after.atk, 0)}`
            }
            tone="c-atk"
          />
          <Figure
            label="Defense"
            value={
              after.def === before.def
                ? formatNumber(before.def, 0)
                : `${formatNumber(before.def, 0)} → ${formatNumber(after.def, 0)}`
            }
            tone="c-def"
          />
          <Figure
            label="Move"
            value={
              after.move === before.move
                ? formatNumber(before.move, 0)
                : `${formatNumber(before.move, 0)} → ${formatNumber(after.move, 0)}`
            }
            tone="c-mov"
          />
          {current && (
            <Figure
              label="Cycle"
              value={
                after.move === before.move
                  ? formatDuration(cycleSeconds(current, before.move))
                  : `${formatDuration(cycleSeconds(current, before.move))} → ${formatDuration(cycleSeconds(current, after.move))}`
              }
              help={`On ${current.title}: ${formatDuration(current.cooldownBase)} base plus 10 seconds per move point.`}
            />
          )}
        </div>

        <div className="asp__figures">
          <Figure
            label="Fragments"
            value={formatNumber(needed, 0)}
            help={`Fragments the stars cost. You have ${fragmentsOwned}${useOwn ? `; ${own} of them are used first` : ''}.`}
          />
          <Figure
            label="Market cost"
            value={changed ? `${formatNumber(buy.wax, 2)} WAX` : '–'}
            tone={buy.short ? 'c-red' : ''}
            help={
              buy.short
                ? `The market does not hold enough: ${formatNumber(buy.fragments, 1)} of ${formatNumber(needed - own, 0)} Fragments are listed.`
                : `${buy.boughtFragments} Fragment${buy.boughtFragments === 1 ? '' : 's'} bought and ${buy.sacrificed} card${buy.sacrificed === 1 ? '' : 's'} bought to sacrifice (about ${formatNumber(buy.fragments, 1)} Fragments in all, at their average yield).`
            }
          />
          <Figure
            label="In TLM"
            value={changed && costTlm !== null ? tlm(costTlm) : '–'}
            tone="c-tlm"
            help="What that WAX would buy in TLM on Alcor right now."
          />
          <Figure
            label="TLM / h"
            value={
              !current
                ? '–'
                : gain
                  ? `${formatNumber(nowPerHour, 1)} → ${formatNumber(thenPerHour, 1)}`
                  : formatNumber(nowPerHour, 1)
            }
            tone="c-tlm"
            help={
              current
                ? `${out ? 'On the mission it is running' : 'On the best TLM loop it can run'}: ${current.title}, net of entry fees and DEF swaps, running back to back.`
                : 'No open mission pays this division TLM.'
            }
          />
          <Figure label="Gain / h" value={current ? formatSigned(gain) : '–'} tone={gain > 0 ? 'c-green' : ''} />
          <Figure
            label="Pays back in"
            value={changed && gain > 0 && payback(gain) !== null ? formatDuration(payback(gain)!) : '–'}
            help="The TLM the stars cost, divided by the TLM per hour they add, with the division running back to back."
          />
          <Figure
            label="30-day ROI"
            value={changed && costTlm ? pct(((gain * 24 * 30) / costTlm - 1) * 100) : '–'}
            tone={changed && costTlm && gain * 24 * 30 > costTlm ? 'c-green' : changed ? 'c-red' : ''}
            help="Thirty days of the added TLM per hour against what the stars cost: 0% is breaking even."
          />
        </div>

        <div className="asp__notes">
          <label className="asp__own">
            <input type="checkbox" checked={useOwn} onChange={(e) => setUseOwn(e.target.checked)} /> Use my {fragmentsOwned}{' '}
            Fragment
            {fragmentsOwned === 1 ? '' : 's'} first
          </label>
          {unlocked && switchGain > gain + 0.05 && (
            <span className="c-green">
              With these stars it could also run {unlocked.e.title}: {formatSigned(switchGain)} TLM / h over today.
            </span>
          )}
          {topStars > forgeLevel && (
            <span className="c-red">
              A {topStars}-star card needs Forge level {topStars} to be equipped; you are at {forgeLevel}.
            </span>
          )}
          {unpriced && <span className="c-red">A star has no Fragment price in the game&apos;s table.</span>}
        </div>

        {changed && buy.picks.length > 0 && (
          <div className="asp__shop">
            <small className="faint">Bought on the market</small>
            <ul>
              {shopping.map((s) => (
                <li key={s.key}>
                  <span>
                    {s.count}× {s.name}
                    {s.sacrifice && <em className="faint"> to sacrifice, about {formatNumber(s.fragments, 1)} Fragments</em>}
                  </span>
                  <b className="num">{formatNumber(s.wax, 2)} WAX</b>
                </li>
              ))}
            </ul>
          </div>
        )}

        {(changed || shining) && (
          <ShineRun
            account={account}
            onStart={setShining}
            startToken={startToken}
            onReset={() => {
              setShining(null)
              setExtra({})
            }}
            cfg={cfg}
            offers={offers}
            editable={!division.lock && !out}
            blocked={
              unpriced
                ? "A star has no Fragment price in the game's table."
                : topStars > forgeLevel
                  ? `Raise the Forge to level ${topStars} first: the new card could not be equipped again.`
                  : buy.short
                    ? 'The market holds too few Fragments and cards to sacrifice for this.'
                    : ''
            }
            plan={
              shining ?? {
                division,
                cards: cards
                  .filter((c) => stepsOf(c) > 0)
                  .map((c) => ({ asset: c.asset, role: c.role, path: c.path, steps: stepsOf(c), fromStars: stars(c.asset) })),
                needed,
                reserve: useOwn ? 0 : fragmentsOwned
              }
            }
          />
        )}
      </div>
    </section>
  )
}
