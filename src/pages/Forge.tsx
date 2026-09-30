import { useMemo, type CSSProperties } from 'react'

import { buyShopItem, payForgeLevel } from '@/chain/actions/pd'
import { divisionAllowance, FREE_DIVISIONS } from '@/chain/config'
import { TokenIcon } from '@/components/Art'
import { Button } from '@/components/Button'
import { Loading } from '@/components/Loading'
import { Figure } from '@/components/Stat'
import { Tooltip } from '@/components/Tooltip'
import { useArmy, useAssetStats, useForgeConfig, usePlayer, useTemplates } from '@/data/game'
import type { ShopItemRow } from '@/data/types'
import { CheckIcon, FlameIcon, LockIcon } from '@/icons'
import { asset, formatNumber, formatToken, parseAsset } from '@/lib/format'
import { publicUrl } from '@/lib/publicUrl'
import { useTransaction } from '@/wallet/useTransaction'

import './Forge.css'

interface Category {
  key: string
  label: string
  accent: string
  img: string
  what: string
  why: string
}

const CATEGORIES: Category[] = [
  {
    key: 'divslot',
    label: 'Division slots',
    accent: '#00d4ff',
    img: '/img/slot-divisions-bg.webp',
    what: 'Lets you field one more division.',
    why: 'Each division runs its own mission loop and earns its own reward every cycle, so more divisions means more loops in parallel. You still need a warlord to lead it.'
  },
  {
    key: 'supslot',
    label: 'Supply slots',
    accent: '#2ee59d',
    img: '/img/slot-supplies-bg.webp',
    what: 'One more supply item equipped across your army.',
    why: 'A supply (Red Boar drink) adds attack and defense and, above all, cuts the mercenary’s move cost. Lower move cost = shorter lock on every mission = more cycles per day.'
  },
  {
    key: 'eqpslot',
    label: 'Equipment slots',
    accent: '#f5c84c',
    img: '/img/slot-equipment-bg.webp',
    what: 'One more weapon or armour piece equipped.',
    why: 'Equipment adds flat attack and defense to a mercenary. It is the quickest way to lift a division over a mission’s requirement and into a better-paying loop.'
  },
  {
    key: 'lavaslot',
    label: 'Lavalux slots',
    accent: '#a855f7',
    img: '/img/slot-lavalux-bg.webp',
    what: 'One more Lava Lux pass equipped.',
    why: 'A Lava Lux hotel pass multiplies a mercenary’s attack and defense (×1.16 up to ×1.70) but also raises its move cost. Put it on your strongest mercenaries.'
  }
]

const LEVEL_HELP =
  'Your forge level caps how many slots of each kind you may buy (each level opens the next band of the shop) and gates higher-tier supplies and creatures, which each have a minimum forge level. Upgrades are paid in TLM and may be paid in parts.'

export default function Forge() {
  const { run, pending, account } = useTransaction()
  const forge = useForgeConfig()
  const player = usePlayer(account)
  const army = useArmy(account)
  const stats = useAssetStats()
  const templates = useTemplates()

  const level = player.data?.forgeLevel ?? 0
  const next = forge.data?.levels.find((l) => Number(l.level) === level + 1)
  const maxLevel = forge.data ? Math.max(0, ...forge.data.levels.map((l) => Number(l.level))) : 0

  /** Shop items by category, in purchase order (cheapest / lowest level first). */
  const shop = useMemo(() => {
    const m = new Map<string, ShopItemRow[]>()
    for (const item of forge.data?.shopItems ?? []) {
      const key = String(item.reward_powerup)
      m.set(key, [...(m.get(key) ?? []), item])
    }
    for (const list of m.values())
      list.sort((a, b) => Number(a.min_forge_level) - Number(b.min_forge_level) || Number(a.id) - Number(b.id))
    return m
  }, [forge.data])

  /** What the next level opens: extra slots per category and newly usable gear. */
  const unlocks = useMemo(() => {
    if (!next) return null
    const lvl = Number(next.level)
    const slots = CATEGORIES.map((c) => ({
      c,
      n: (shop.get(c.key) ?? []).filter((i) => Number(i.min_forge_level) === lvl).length
    })).filter((x) => x.n > 0)
    const gear = new Set<string>()
    if (stats.data && templates.data)
      for (const s of stats.data.values())
        if (Number(s.min_forge_level) === lvl) gear.add(templates.data[String(s.template_id)]?.name ?? `#${s.template_id}`)
    return { slots, gear: [...gear] }
  }, [next, shop, stats.data, templates.data])

  if (!forge.data || !player.data) return <Loading inline label="Stoking the forge" />

  const paid = parseAsset(player.data.forgeProgress?.paid_tlm).amount
  const cost = next ? parseAsset(next.tlm_cost).amount : 0
  const remaining = Math.max(0, cost - paid)
  const tlmContract = forge.data.tokens?.tlm_contract || 'alien.worlds'
  const canPay = remaining > 0 && player.data.tlm >= remaining
  const used: Record<string, number> = {
    divslot: army.data?.divisions.length ?? 0,
    supslot: army.data?.gearUsed.supply ?? 0,
    eqpslot: army.data?.gearUsed.weapon ?? 0,
    lavaslot: army.data?.gearUsed.lavalux ?? 0
  }

  return (
    <div className="page forge">
      {/* Level */}
      <section className="fhero panel">
        <img className="fhero__bg" src={publicUrl('/img/forge-hero-bg.webp')} alt="" />
        <div className="fhero__text">
          <p className="eyebrow">The Forge</p>
          <h2>
            {level === 0 ? 'Forge locked' : `Forge level ${level}`}
            <Tooltip text={LEVEL_HELP} />
          </h2>
          <p className="muted">
            {level === 0
              ? 'Pay the first level to open the slot shop and start upgrading your army.'
              : level >= maxLevel
                ? 'Maximum level reached: every shop band and every tier of gear is open to you.'
                : 'Each level opens a new band of slots in the shop and unlocks higher-tier supplies and creatures.'}
          </p>
          {unlocks && (
            <ul className="fhero__unlocks">
              {unlocks.slots.map(({ c, n }) => (
                <li key={c.key} style={{ '--accent': c.accent } as CSSProperties}>
                  <b>+{n}</b> {c.label.toLowerCase()} to buy
                </li>
              ))}
              {unlocks.gear.length > 0 && (
                <li style={{ '--accent': '#ff9a6a' } as CSSProperties}>
                  <b>Unlocks</b> {unlocks.gear.slice(0, 4).join(', ')}
                  {unlocks.gear.length > 4 ? ` +${unlocks.gear.length - 4} more` : ''}
                </li>
              )}
            </ul>
          )}
        </div>
        {next ? (
          <div className="fhero__pay">
            <div className="fhero__pay-head">
              <span className="faint">Next level</span>
              <span className="fhero__lvl">
                <FlameIcon width={14} height={14} /> {next.level}
              </span>
            </div>
            <div className="fhero__amount">
              <TokenIcon symbol="TLM" size={20} />
              <b className="num">{formatNumber(cost, 0)}</b>
              <span className="faint">TLM</span>
            </div>
            <span className="progress progress--gold">
              <span style={{ width: `${cost ? Math.min(100, (paid / cost) * 100) : 0}%` }} />
            </span>
            <span className="faint num fhero__paid">
              {formatNumber(paid, 0)} / {formatNumber(cost, 0)} paid
            </span>
            <Button
              color="gradientYellow"
              block
              disabled={!canPay}
              isLoading={pending === 'forge'}
              onClick={() =>
                run(
                  (a, p) => payForgeLevel(a, p, level + 1, asset(remaining, 'TLM'), tlmContract),
                  `Forge level ${level + 1} reached`,
                  'forge'
                )
              }
            >
              Pay {formatToken(remaining)} TLM
            </Button>
            {!canPay && remaining > 0 && <small className="c-red">You hold {formatToken(player.data.tlm)} TLM.</small>}
          </div>
        ) : (
          <div className="fhero__pay fhero__pay--max">
            <CheckIcon /> Max level
          </div>
        )}
      </section>

      {/* Slot shop */}
      <div className="section-head">
        <div>
          <h2>Slot shop</h2>
          <p>
            Slots are bought one at a time with DEF; each category shows your next one. Hover a title to see what the slot does.
          </p>
        </div>
        <Figure
          label="Your DEF"
          value={
            <>
              <TokenIcon symbol="DEF" size={14} /> {formatToken(player.data.def)}
            </>
          }
          tone="c-deft"
        />
      </div>

      <div className={`fshop ${level === 0 ? 'is-locked' : ''}`}>
        {CATEGORIES.map((c) => {
          const items = shop.get(c.key) ?? []
          const owned = player.data!.powerups.get(c.key) ?? 0
          // Divisions come with some free; the other slots are only what was bought.
          const capacity = c.key === 'divslot' ? divisionAllowance(player.data!.powerups) : owned
          const nextItem = items[owned]
          const nextLevel = nextItem ? Number(nextItem.min_forge_level) : 0
          const locked = !!nextItem && nextLevel > level
          const price = nextItem ? parseAsset(nextItem.price) : null
          const affordable = !!price && player.data!.def >= price.amount
          const bands = [...new Set(items.map((i) => Number(i.min_forge_level)))].sort((a, b) => a - b)
          return (
            <article key={c.key} className="fcat" style={{ '--accent': c.accent } as CSSProperties}>
              <div className="fcat__visual">
                <img src={publicUrl(c.img)} alt="" />
              </div>
              <div className="fcat__body">
                <header className="fcat__head">
                  <Tooltip
                    text={
                      <>
                        <strong>{c.what}</strong> {c.why}
                      </>
                    }
                    side="bottom"
                  >
                    <h3>{c.label}</h3>
                  </Tooltip>
                  <span className="fcat__count num">
                    {owned} / {items.length}
                  </span>
                </header>
                <p className="fcat__what">{c.what}</p>
                <div className="fcat__use">
                  <span className="progress">
                    <span
                      style={{
                        width: `${capacity ? Math.min(100, (used[c.key] / capacity) * 100) : 0}%`,
                        background: c.accent
                      }}
                    />
                  </span>
                  <small className="faint num">
                    {c.key === 'divslot'
                      ? `${used[c.key]} of ${capacity} divisions (${FREE_DIVISIONS} free + ${owned} bought)`
                      : `${used[c.key]} of ${owned} in use`}
                  </small>
                </div>
                <div className="fcat__bands">
                  {bands.map((b) => {
                    const inBand = items.filter((i) => Number(i.min_forge_level) === b)
                    const first = items.findIndex((i) => Number(i.min_forge_level) === b)
                    const boughtHere = Math.max(0, Math.min(inBand.length, owned - first))
                    const open = level >= b
                    return (
                      <span
                        key={b}
                        className={`fband ${open ? (boughtHere >= inBand.length ? 'is-done' : 'is-open') : 'is-locked'}`}
                        title={`Forge level ${b}: ${inBand.length} slots`}
                      >
                        <small>{open ? `Lv ${b}` : <LockIcon width={9} height={9} />}</small>
                        <b className="num">
                          {boughtHere}/{inBand.length}
                        </b>
                      </span>
                    )
                  })}
                </div>
                <div className="fcat__buy">
                  {!nextItem ? (
                    <span className="fcat__done">
                      <CheckIcon width={14} height={14} /> All bought
                    </span>
                  ) : (
                    <>
                      <span className="fcat__price">
                        <small className="faint">Slot {owned + 1}</small>
                        <b className="num">
                          <TokenIcon symbol="DEF" size={16} /> {formatToken(price!.amount)} <span className="faint">DEF</span>
                        </b>
                      </span>
                      {locked ? (
                        <span className="chip chip--gold">
                          <LockIcon width={12} height={12} /> Forge Lv {nextLevel}
                        </span>
                      ) : (
                        <Button
                          size="sm"
                          disabled={!affordable || level === 0}
                          isLoading={pending === `buy-${c.key}`}
                          style={{ '--btn-bg': c.accent, '--btn-color': '#04121c', '--btn-glow': 'transparent' } as CSSProperties}
                          onClick={() =>
                            run(
                              (a, p) =>
                                buyShopItem(a, p, Number(nextItem.id), nextItem.price, nextItem.price_contract || 'defensetoken'),
                              `${c.label.slice(0, -1)} bought`,
                              `buy-${c.key}`
                            )
                          }
                        >
                          Buy
                        </Button>
                      )}
                    </>
                  )}
                </div>
                {nextItem && items[owned + 1] && (
                  <p className="fcat__then faint">
                    Then{' '}
                    {items
                      .slice(owned + 1, owned + 4)
                      .map(
                        (i) =>
                          `${formatToken(parseAsset(i.price).amount)}${Number(i.min_forge_level) > level ? ` (Lv ${i.min_forge_level})` : ''}`
                      )
                      .join(' · ')}{' '}
                    DEF
                  </p>
                )}
              </div>
            </article>
          )
        })}
      </div>
    </div>
  )
}
