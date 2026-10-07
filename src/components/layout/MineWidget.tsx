import { TokenIcon } from '@/components/Art'
import { Button } from '@/components/Button'
import { Tooltip } from '@/components/Tooltip'
import { RefreshIcon } from '@/icons'
import { useMining } from '@/mining/useMining'

/**
 * The top bar's mine button: Alien Worlds mining on the player's favourite lands (TLM Favorites).
 * Its own component because it ticks every second with the cooldown: only this part of the bar
 * re-renders, not the balances or the account menu.
 */
export function MineWidget() {
  const mining = useMining()

  return (
    <div className="mine" aria-live="polite">
      <div className="mine__body">
        <span className="mine__above">
          <span className="mine__mode">{mining.hasFavorites ? 'TLM Favorites' : 'Current land'}</span>
          {mining.estimatedTlm !== null && (
            <Tooltip text="Estimated TLM for the next mine, on the pools as they are now.">
              <span className="mine__estimate num">
                ≈ {mining.estimatedTlm.toFixed(4)} <TokenIcon symbol="TLM" size={11} />
              </span>
            </Tooltip>
          )}
          {mining.upgrade && (
            <Tooltip text={mining.upgrade.title}>
              <span className="mine__upgrade num">↑ {mining.upgrade.in}</span>
            </Tooltip>
          )}
        </span>
        <span className="mine__row">
          <Button
            className={`mine__button ${mining.isReady ? 'is-ready' : ''}`}
            color="gradientYellow"
            size="sm"
            pill
            onClick={mining.onClick}
            disabled={mining.isDisabled}
            isLoading={mining.isBusy}
          >
            <span className="num">{mining.buttonText}</span>
          </Button>
          <button
            type="button"
            className={`mine__refresh ${mining.isRefreshing ? 'is-spinning' : ''}`}
            onClick={mining.refresh}
            aria-label="Refresh mining data"
            title="Refresh"
          >
            <RefreshIcon width={14} height={14} />
          </button>
        </span>
        <span className="mine__below" title={mining.textBelow}>
          {mining.textBelow}
        </span>
      </div>
    </div>
  )
}
