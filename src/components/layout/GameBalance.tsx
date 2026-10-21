import { useState } from 'react'

import { depositAction, withdrawBalanceAction } from '@/chain/actions/pd'
import { CONTRACTS } from '@/chain/config'
import { TokenIcon } from '@/components/Art'
import { Button } from '@/components/Button'
import { Modal } from '@/components/Modal'
import { useGameBalance, usePlayer } from '@/data/game'
import { DECIMALS, quantityOf, type BalanceSymbol } from '@/lib/deposit'
import { formatNumber } from '@/lib/format'
import { useTransaction } from '@/wallet/useTransaction'

import './GameBalance.css'

/*
 * The game balance, as on the official site: TLM and DEF deposited with core.pdef. Joining a
 * mission takes its entry fee from here, so looping needs no new tokens each cycle; whatever is
 * left can be withdrawn to the wallet at any time.
 */

const SYMBOLS: BalanceSymbol[] = ['TLM', 'DEF']
const CONTRACT: Record<BalanceSymbol, string> = { TLM: CONTRACTS.TLM, DEF: CONTRACTS.DEF }
const key = (s: BalanceSymbol) => (s === 'TLM' ? 'tlm' : 'def')
/** Round down to what the token can hold, so Max never asks for a fraction too many. */
const floorTo = (n: number, s: BalanceSymbol) => Math.floor(n * 10 ** DECIMALS[s]) / 10 ** DECIMALS[s]

export function GameBalanceModal({ account, onClose }: { account: string; onClose: () => void }) {
  const { run, pending, spectating } = useTransaction()
  const player = usePlayer(account)
  const game = useGameBalance(account)
  const [mode, setMode] = useState<'deposit' | 'withdraw'>('deposit')
  const [symbol, setSymbol] = useState<BalanceSymbol>('TLM')
  const [text, setText] = useState('')

  const wallet = player.data ? { tlm: player.data.tlm, def: player.data.def } : null
  const inGame = game.data ?? null
  const available = (mode === 'deposit' ? wallet : inGame)?.[key(symbol)] ?? 0
  const amount = floorTo(Number(text.replace(',', '.')) || 0, symbol)
  const error =
    text && amount <= 0
      ? 'Enter an amount above zero.'
      : amount > available + 1e-12
        ? `Only ${formatNumber(available, 4)} ${symbol} available.`
        : null
  const busy = pending === 'game-balance'

  async function submit() {
    if (amount <= 0 || error) return
    const quantity = quantityOf(amount, symbol)
    const ok = await run(
      (a, p) => [mode === 'deposit' ? depositAction(a, p, CONTRACT[symbol], quantity) : withdrawBalanceAction(a, p, quantity)],
      mode === 'deposit' ? `${quantity} deposited to the game` : `${quantity} withdrawn to your wallet`,
      'game-balance'
    )
    if (ok) {
      setText('')
      void game.refetch()
    }
  }

  return (
    <Modal className="picker gbal" onClose={onClose} label="Game balance" locked={busy}>
      <header className="picker__head">
        <div>
          <p className="eyebrow">core.pdef</p>
          <h3>Game balance</h3>
        </div>
        <button type="button" className="gbal__close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      <p className="gbal__lead">
        Entry fees are taken from here when a division joins a mission, so the loop does not send new TLM or DEF every cycle.
        Rewards still go to your wallet. Withdraw what is left at any time.
      </p>

      <div className="gbal__tokens">
        {SYMBOLS.map((s) => (
          <button
            key={s}
            type="button"
            className={`gbal__token${symbol === s ? ' is-on' : ''}`}
            onClick={() => setSymbol(s)}
            aria-pressed={symbol === s}
          >
            <span className="gbal__sym">
              <TokenIcon symbol={s} size={18} /> {s}
            </span>
            <span className="gbal__row">
              <small>In game</small>
              <b className="num">{inGame ? formatNumber(inGame[key(s)], 4) : '–'}</b>
            </span>
            <span className="gbal__row is-dim">
              <small>In wallet</small>
              <span className="num">{wallet ? formatNumber(wallet[key(s)], 4) : '–'}</span>
            </span>
          </button>
        ))}
      </div>

      <div className="gbal__form">
        <div className="segmented">
          <button type="button" className={mode === 'deposit' ? 'is-active' : ''} onClick={() => setMode('deposit')}>
            Deposit
          </button>
          <button type="button" className={mode === 'withdraw' ? 'is-active' : ''} onClick={() => setMode('withdraw')}>
            Withdraw
          </button>
        </div>
        <label className="gbal__amount">
          <span className="eyebrow">Amount</span>
          <span className="gbal__input">
            <input
              id="gbal-amount"
              className="input num"
              inputMode="decimal"
              placeholder={`0 ${symbol}`}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void submit()}
            />
            <button type="button" className="gbal__max" onClick={() => setText(String(floorTo(available, symbol)))}>
              Max
            </button>
          </span>
          <small className={error ? 'c-red' : 'faint'}>
            {error ?? `${formatNumber(available, 4)} ${symbol} ${mode === 'deposit' ? 'in your wallet' : 'in the game'}`}
          </small>
        </label>
        <Button color="solidBlue" disabled={spectating || amount <= 0 || !!error} isLoading={busy} onClick={submit}>
          {mode === 'deposit' ? 'Deposit' : 'Withdraw'} {amount > 0 ? `${formatNumber(amount, 4)} ${symbol}` : symbol}
        </Button>
      </div>
    </Modal>
  )
}
