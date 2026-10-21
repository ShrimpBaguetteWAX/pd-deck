import { useCallback, useEffect, useState } from 'react'

import { Button } from '@/components/Button'
import { toast } from '@/components/toast'
import { useMiningMode } from '@/mining/mode'
import type { MiningMode } from '@/mining/types'
import { useSession } from '@/state/session'
import { AUTO_GROUPS, AUTO_SIGN_PERMISSION, actionKey, saveActions, savedActions } from '@/wallet/autoSign'
import {
  autoSignStatus,
  disableAutoSign,
  enableAutoSign,
  formatTransactError,
  isUserCancel,
  reloadAutoSign,
  syncAutoSign,
  type AutoSignStatus
} from '@/wallet/session'

import './Settings.css'

const STATE_LABEL: Record<AutoSignStatus['state'], string> = {
  active: 'On',
  inactive: 'Set up on another device',
  mismatch: 'Out of step with the actions below',
  'not-setup': 'Off'
}

/** Settings: for now, which game actions the deck may sign by itself. */
export default function Settings() {
  const account = useSession((s) => s.account)
  const spectating = useSession((s) => s.spectating)
  const [picked, setPicked] = useState<string[]>(savedActions)
  const [saved, setSaved] = useState<string[]>(savedActions)
  const [status, setStatus] = useState<AutoSignStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const canSign = !!account && !spectating
  const refresh = useCallback(async () => {
    if (!canSign) return
    try {
      setStatus(await autoSignStatus())
    } catch {
      setStatus(null)
    }
  }, [canSign])
  useEffect(() => {
    void refresh()
  }, [refresh, account])

  const changed = picked.length !== saved.length || picked.some((k) => !saved.includes(k))
  const on = status?.state === 'active' || status?.state === 'mismatch'

  /** Runs one wallet step, then reads the status again; a cancelled prompt is not an error. */
  async function step(key: string, work: () => Promise<void>, success: string) {
    setBusy(key)
    try {
      await work()
      toast.success(success)
    } catch (err) {
      if (!isUserCancel(err)) toast.error(formatTransactError(err))
    } finally {
      setBusy(null)
      await refresh()
    }
  }

  /** Keeps the picked actions in this browser; with auto-signing on, links them on chain too. */
  async function save() {
    saveActions(picked)
    setSaved(picked)
    await step(
      'save',
      async () => {
        await reloadAutoSign()
        if (on) await syncAutoSign()
      },
      on ? 'Auto-sign actions updated' : 'Saved'
    )
  }

  const mode = useMiningMode((s) => s.mode)
  const setMode = useMiningMode((s) => s.setMode)
  const MODES: { key: MiningMode; title: string; sub: string }[] = [
    { key: 'tlm', title: 'Land favourites by TLM', sub: 'Mines the ready favourite land that pays the most TLM.' },
    { key: 'shard', title: 'Land favourites by Shards', sub: 'Mines the ready favourite land that pays the most shards.' }
  ]

  const toggle = (key: string) => setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]))

  return (
    <div className="page settings">
      <header className="settings__head">
        <p className="eyebrow">Settings</p>
        <h2>Mining</h2>
      </header>

      <section className="panel settings__card">
        <p className="settings__lead">
          Which of your WAX Mission Control favourite lands the Mine button in the top bar picks. Your favourites are kept with
          your Mission Control membership, so the list is the same there and here.
        </p>
        <div className="settings__modes" role="radiogroup" aria-label="Mining mode">
          {MODES.map((m) => (
            <button
              key={m.key}
              type="button"
              role="radio"
              aria-checked={mode === m.key}
              className={`settings__mode is-${m.key}`}
              onClick={() => setMode(m.key)}
            >
              <span className="settings__chip">Mine</span>
              <span>
                <b>{m.title}</b>
                <small>{m.sub}</small>
              </span>
              <span className="settings__radio" />
            </button>
          ))}
        </div>
      </section>

      <h2 className="settings__h2">Auto-sign</h2>

      <section className="panel settings__card">
        <div className="settings__status">
          <div>
            <span className={`settings__pill is-${status?.state ?? 'unknown'}`}>
              {status ? STATE_LABEL[status.state] : canSign ? '…' : 'Off'}
            </span>
            <p className="settings__lead">
              The deck signs the actions you tick below by itself, with a key kept in this browser and added to your account as
              the <code>{AUTO_SIGN_PERMISSION}</code> permission. Everything else still asks your wallet.
            </p>
            {status?.publicKey && (
              <p className="settings__key">
                Key <code>{status.publicKey}</code>
              </p>
            )}
          </div>
          <div className="settings__actions">
            {!canSign ? (
              <span className="faint">
                {spectating ? 'Viewing another account read-only.' : 'Sign in with your wallet to set it up.'}
              </span>
            ) : on ? (
              <Button
                color="ghost"
                isLoading={busy === 'off'}
                disabled={!!busy}
                onClick={() => void step('off', disableAutoSign, 'Auto-sign turned off')}
              >
                Turn off
              </Button>
            ) : (
              <Button
                color="solidBlue"
                isLoading={busy === 'on'}
                disabled={!!busy || changed || !saved.length}
                title={changed ? 'Save the actions first' : undefined}
                onClick={() => void step('on', enableAutoSign, 'Auto-sign is on')}
              >
                {status?.state === 'inactive' ? 'Set up in this browser' : 'Turn on'}
              </Button>
            )}
            {status?.state === 'mismatch' && !changed && (
              <Button
                color="ghost"
                isLoading={busy === 'sync'}
                disabled={!!busy}
                onClick={() => void step('sync', syncAutoSign, 'Auto-sign actions updated')}
              >
                Update on chain
              </Button>
            )}
          </div>
        </div>
      </section>

      <section className="panel settings__card">
        <div className="settings__label">
          <span>Actions the deck may sign</span>
          <Button
            size="sm"
            color={changed ? 'solidBlue' : 'ghost'}
            disabled={!changed || !!busy}
            isLoading={busy === 'save'}
            onClick={() => void save()}
          >
            {on ? 'Save and update' : 'Save'}
          </Button>
        </div>
        {AUTO_GROUPS.map((g) => (
          <fieldset key={g.title} className="settings__group">
            <legend>{g.title}</legend>
            {g.actions.map((a) => {
              const key = actionKey(a)
              return (
                <label key={key} className={`settings__action ${a.warning ? 'is-risky' : ''}`}>
                  <input type="checkbox" checked={picked.includes(key)} onChange={() => toggle(key)} />
                  <span>
                    {a.label}
                    <code>
                      {a.contract}::{a.action}
                    </code>
                    {a.warning && <small>{a.warning}</small>}
                  </span>
                </label>
              )
            })}
          </fieldset>
        ))}
        <p className="settings__note">
          A transaction is signed by itself only when every action in it is ticked here. Turning auto-sign on, changing the
          actions while it is on, and turning it off each ask your wallet once. The key lives in this browser only; clearing its
          data turns auto-sign off here.
        </p>
      </section>
    </div>
  )
}
