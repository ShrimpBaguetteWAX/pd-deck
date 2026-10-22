import { TokenIcon } from '@/components/Art'
import { Tooltip } from '@/components/Tooltip'
import { ArrowUpIcon } from '@/icons'
import { formatNumber } from '@/lib/format'
import { cooldownLabel } from '@/lib/time'
import { useMining, type MineBlock } from '@/mining/useMining'
import { MINING_BLOCKED_MESSAGE } from '@/wallet/session'

/** What the switched-off key says, and the longer reason on hover. */
const BLOCKED: Record<MineBlock, [string, string]> = {
  'signed-out': ['Sign in', 'Sign in to mine.'],
  spectating: ['Read-only', 'You are viewing another account.'],
  loading: ['…', 'Reading your miner, tools and favourite lands.'],
  anchor: ['Unavailable with Anchor', MINING_BLOCKED_MESSAGE],
  'no-member': ['Members only', 'Mining here goes through WAX Mission Control and needs a Mission Control membership.'],
  flagged: ['Unavailable', 'Your Mission Control membership is flagged.'],
  'no-tools': ['No tools equipped', 'Equip mining tools in Alien Worlds or on WAX Mission Control.'],
  'no-favorites': ['No favourite lands', 'Add favourite lands on WAX Mission Control; the Mine button picks among them.']
}

/**
 * The Mine half of the top bar's console, laid out line for line like the Loop key beside it: the
 * action and the number on top, the land and the "better land" hint underneath, or a hairline filling
 * up while the tools cool down. Orange for favourites by TLM, green for favourites by shards; the
 * number is the TLM estimate in both.
 */
export function MineKey({ now }: { now: number }) {
  const m = useMining(now)
  const tlm = m.mode === 'tlm'
  // Both modes show the TLM a mine pays: shard mode only changes which land is picked.
  const value = m.pick ? m.pick.estimatedTlm : 0
  const ready = !m.block && !m.cooling && !!m.pick
  const unit = <TokenIcon symbol="TLM" size={13} />

  const tip = m.block
    ? BLOCKED[m.block][1]
    : m.busy
      ? 'Mining: finding the proof of work and waiting for the chain.'
      : m.cooling
        ? `Your tools are cooling down. ${m.pick?.landName} is the best favourite land once they are ready.`
        : `Mines on ${m.pick?.landName}: ≈ ${formatNumber(value, 4)} TLM after its commission${tlm ? '' : `, and ≈ ${formatNumber(m.pick?.shards ?? 0, 1)} shards`}.${
            m.upgrade
              ? ` ${m.upgrade.land.landName} pays ≈ ${formatNumber(m.upgrade.land.estimatedTlm, 4)} TLM${tlm ? '' : ` and ≈ ${formatNumber(m.upgrade.land.shards, 1)} shards`} and is ready in ${cooldownLabel(m.upgrade.at, now, '0:00')}.`
              : ''
          }`

  return (
    <Tooltip text={tip}>
      <button
        type="button"
        className={`mine-key is-${m.mode} ${ready ? 'is-ready' : ''} ${m.busy ? 'is-busy' : ''} ${m.block && m.block !== 'loading' ? 'is-off' : ''}`}
        disabled={!!m.block || m.busy || m.cooling}
        onClick={() => void m.mine()}
      >
        <span className="mine-key__r1">
          <span className="mine-key__lab">
            {m.busy ? (
              <>
                <span className="spinner" /> Mining
              </>
            ) : (
              'Mine'
            )}
          </span>
          {!m.block && m.cooling && m.pickReadyAt ? (
            <span className="mine-key__time num">{cooldownLabel(m.pickReadyAt, now, '0:00')}</span>
          ) : !m.block && m.pick ? (
            <span className="mine-key__est num">
              {formatNumber(value, tlm ? 4 : 1)} {unit}
            </span>
          ) : null}
        </span>
        <span className="mine-key__r2">
          {m.block ? (
            <span className="mine-key__land">{BLOCKED[m.block][0]}</span>
          ) : m.cooling ? (
            <span className="mine-key__line" aria-hidden="true">
              <i style={{ width: `${Math.round(m.progress * 1000) / 10}%` }} />
            </span>
          ) : (
            <>
              <span className="mine-key__land">{m.pick?.landName}</span>
              {m.upgrade && (
                <span className="mine-key__up num">
                  <ArrowUpIcon width={9} height={9} />
                  {cooldownLabel(m.upgrade.at, now, '0:00')}
                </span>
              )}
            </>
          )}
        </span>
      </button>
    </Tooltip>
  )
}
