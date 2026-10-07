import { Tooltip } from '@/components/Tooltip'
import { RefreshIcon } from '@/icons'
import { refreshPlayer } from '@/data/game'
import { formatNumber } from '@/lib/format'
import { tlmForDef } from '@/lib/market'
import { cooldownLabel, shortDuration, useNow } from '@/lib/time'
import { readCashOut, useLoopPlan } from '@/lib/useLoop'
import { useTransaction } from '@/wallet/useTransaction'

/** The timeline never spans less than this, so it is never a single point. */
const MIN_WINDOW_MS = 60_000

/**
 * The top bar's loop button, a raised key: the label on top (the count of divisions back and
 * the word, or the time to the next return) and, as its underline, a timeline with one dot per
 * division at the moment it returns, gold once it is back, with a hairline at now. Pressing it
 * claims every reward and sends the divisions whose mission is still open straight back out, as
 * the Deployments page does. Its own component because it ticks every second.
 */
export function LoopWidget() {
  const { account, runSequence, pending, spectating } = useTransaction()
  const loop = useLoopPlan(account, readCashOut())
  const now = useNow(1000)

  const total = loop.deployments.length
  const ready = loop.ready.length
  const plan = ready ? loop.cycle(loop.ready, loop.loopable) : null
  const waiting = plan ? plan.earnedTlm + tlmForDef(loop.market, plan.earnedDef) : 0
  const busy = pending === 'loop-all'
  const affordable = !plan || plan.funding.affordable
  const canPress = !!plan && affordable && !busy && !spectating && loop.loaded

  // The timeline runs from the moment the earliest division still out left to the latest return,
  // so the hairline at now travels along it as the missions run. With every division back it runs
  // from the earliest departure to now.
  const ats = loop.deployments.map((d) => d.unlockAt)
  const anchors = loop.running.length ? loop.running : loop.deployments
  const start = anchors.length ? Math.min(...anchors.map((d) => d.joinedAt)) : now
  const end = Math.max(start + MIN_WINDOW_MS, now, ...ats)
  const pos = (t: number) => `${Math.round(Math.min(1, Math.max(0, (t - start) / (end - start))) * 1000) / 10}%`
  const dots = [...loop.deployments].sort((a, b) => a.unlockAt - b.unlockAt)
  const nextId = dots.find((d) => d.unlockAt > now)?.divisionId

  async function onClick() {
    if (!plan) return
    if (spectating) return
    await runSequence(plan.parts, 'loop-all')
    void refreshPlayer(account)
  }

  const time = loop.nextReturnAt ? cooldownLabel(loop.nextReturnAt, now, '00:00') : null
  return (
    <div className="loop" aria-live="polite">
      <div className="loop__body">
        <span className="loop__row">
          <Tooltip
            text={
              !loop.loaded
                ? 'Reading your deployments.'
                : total === 0
                  ? 'Nothing is out. Send divisions out from the Missions page.'
                  : !ready
                    ? `Counts down to the next division back. The line runs from when the earliest division still out left to the last return; each dot is a division at the moment it returns.`
                    : !affordable
                      ? 'The entry fees of the redeploys are more than your TLM covers. Claim and redeploy from the Deployments page, or add TLM.'
                      : loop.loopable.length
                        ? `Claims ${ready} reward${ready === 1 ? '' : 's'} (≈ ${formatNumber(waiting, 1)} TLM, DEF at today's price) and sends ${loop.loopable.length} division${loop.loopable.length === 1 ? '' : 's'} straight back out, one transaction per division.`
                        : `Claims ${ready} reward${ready === 1 ? '' : 's'} (≈ ${formatNumber(waiting, 1)} TLM); the missions have closed, so nothing goes back out.`
            }
          >
            <button
              type="button"
              className={`loop__key ${ready && affordable ? 'is-ready' : ''} ${busy ? 'is-busy' : ''}`}
              disabled={!canPress}
              onClick={() => void onClick()}
            >
              <span className="loop__lab">
                {busy ? (
                  <span className="loop__word">
                    <span className="spinner" /> Signing
                  </span>
                ) : ready ? (
                  <span className="loop__word">
                    <span className="loop__cell num">{ready}</span> {loop.loopable.length ? 'Loop' : 'Claim'}
                  </span>
                ) : (
                  <small>{loop.loaded ? (total ? 'Next back' : 'Deployments') : '…'}</small>
                )}
                <span className="loop__time num">{time ?? (ready ? 'all back' : '')}</span>
              </span>
              <span className="loop__tl" aria-hidden="true">
                {dots.map((d) => (
                  <i
                    key={d.divisionId}
                    className={`loop__dot ${d.unlockAt <= now ? 'is-back' : ''} ${d.divisionId === nextId ? 'is-next' : ''}`}
                    style={{ left: pos(d.unlockAt) }}
                    title={
                      d.unlockAt <= now
                        ? `#${d.divisionId} is back`
                        : `#${d.divisionId} back in ${shortDuration(d.unlockAt - now)}`
                    }
                  />
                ))}
                {total > 0 && <i className="loop__now" style={{ left: pos(now) }} />}
              </span>
            </button>
          </Tooltip>
          <button
            type="button"
            className="loop__refresh"
            onClick={() => void refreshPlayer(account)}
            aria-label="Refresh deployments"
            title="Refresh"
          >
            <RefreshIcon width={14} height={14} />
          </button>
        </span>
      </div>
    </div>
  )
}
