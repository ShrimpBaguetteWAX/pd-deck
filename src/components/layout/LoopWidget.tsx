import { TokenIcon } from '@/components/Art'
import { Button } from '@/components/Button'
import { Tooltip } from '@/components/Tooltip'
import { RefreshIcon } from '@/icons'
import { refreshPlayer } from '@/data/game'
import { formatNumber } from '@/lib/format'
import { tlmForDef } from '@/lib/market'
import { cooldownLabel, shortDuration, useNow } from '@/lib/time'
import { readCashOut, useLoopPlan } from '@/lib/useLoop'
import { useTransaction } from '@/wallet/useTransaction'

/**
 * The top bar's loop button: how many divisions are back from their missions, what is waiting
 * to be claimed, and a countdown to the next return. Pressing it claims every reward and sends
 * the divisions whose mission is still open straight back out, as the Deployments page does. Its
 * own component because it ticks every second: only this part of the bar re-renders.
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

  const buttonText = !loop.loaded
    ? '…'
    : ready
      ? loop.loopable.length
        ? `Loop ${loop.loopable.length}`
        : `Claim ${ready}`
      : loop.nextReturnAt
        ? cooldownLabel(loop.nextReturnAt, now, 'Loop')
        : 'No divisions out'
  const textBelow = !loop.loaded
    ? ''
    : ready && loop.nextReturnAt
      ? `next back in ${shortDuration(loop.nextReturnAt - now)}`
      : ready
        ? total === ready
          ? 'all back'
          : ''
        : loop.running.length
          ? `${loop.running.length} out`
          : 'send divisions out on Missions'

  async function onClick() {
    if (!plan) return
    if (spectating) return
    await runSequence(plan.parts, 'loop-all')
    void refreshPlayer(account)
  }

  return (
    <div className="loop" aria-live="polite">
      <div className="loop__body">
        <span className="loop__above">
          <span className="loop__mode">{loop.loaded ? `${ready} of ${total} ready` : 'Deployments'}</span>
          {waiting > 0 && (
            <Tooltip text="Rewards waiting to be claimed, DEF counted at today's TLM price.">
              <span className="loop__estimate num">
                ≈ {formatNumber(waiting, 1)} <TokenIcon symbol="TLM" size={11} />
              </span>
            </Tooltip>
          )}
        </span>
        <span className="loop__row">
          <Tooltip
            text={
              !ready
                ? 'Counts down to the next division back from its mission.'
                : !affordable
                  ? 'The entry fees of the redeploys are more than your TLM covers. Claim and redeploy from the Deployments page, or add TLM.'
                  : loop.loopable.length
                    ? `Claims ${ready} reward${ready === 1 ? '' : 's'} and sends ${loop.loopable.length} division${loop.loopable.length === 1 ? '' : 's'} straight back out, one transaction per division.`
                    : `Claims ${ready} reward${ready === 1 ? '' : 's'}; the missions have closed, so nothing goes back out.`
            }
          >
            <Button
              className={`loop__button ${ready && affordable && !busy ? 'is-ready' : ''}`}
              color="gradientYellow"
              size="sm"
              pill
              onClick={onClick}
              disabled={spectating || busy || !ready || !affordable || !loop.loaded}
              isLoading={busy || (!!account && !loop.loaded && loop.loading)}
            >
              <span className="num">{buttonText}</span>
            </Button>
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
        <span className="loop__below" title={textBelow}>
          {textBelow}
        </span>
      </div>
    </div>
  )
}
