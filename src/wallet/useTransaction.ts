import { useRef, useState } from 'react'
import type { AnyAction } from '@wharfkit/session'
import { useShallow } from 'zustand/react/shallow'

import { regPlayer } from '@/chain/actions/pd'
import { toast } from '@/components/toast'
import { refreshPlayer, usePlayer } from '@/data/game'
import { sleep } from '@/lib/format'
import { useSession } from '@/state/session'

import { formatTransactError, isUserCancel, transact } from './session'

/** A node shows a signed transaction about a second later; lagging nodes get one more read. */
const CATCH_UP_MS = 1200
const LATE_NODE_MS = 4000
/** More actions than this do not fit one transaction (CPU and size limits): it is split. */
const MAX_ACTIONS_PER_TX = 10
/** Actions per transaction once split. */
const SPLIT_SIZE = 10
/** Between split parts: a later part may spend what an earlier one deposited, so let it land first. */
const BETWEEN_PARTS_MS = 1500

/** One transaction, or parts of SPLIT_SIZE in order when there are more than MAX_ACTIONS_PER_TX actions. */
export function splitActions<T>(actions: T[]): T[][] {
  if (actions.length <= MAX_ACTIONS_PER_TX) return [actions]
  return Array.from({ length: Math.ceil(actions.length / SPLIT_SIZE) }, (_, i) =>
    actions.slice(i * SPLIT_SIZE, (i + 1) * SPLIT_SIZE)
  )
}

type Build = (account: string, permission: string) => AnyAction | AnyAction[]

/**
 * Signs one or more actions for the signed-in player, shows the outcome and reads the player's
 * data again. A first-time player is registered in the same transaction. `key` names the button
 * that is waiting when a screen has several.
 *
 * With `split` (the Market uses it), more than MAX_ACTIONS_PER_TX actions are sent as several
 * transactions of SPLIT_SIZE, one after
 * the other and in the original order (a deposit always lands before what spends it). Each part is
 * signed separately. If a part fails, the ones before it have already gone through; the message
 * says so.
 *
 * With `refresh: false` the player's data is not read again afterwards; a sequence uses it for
 * all but its last transaction, so the next signature is asked for right away.
 */
export function useTransaction() {
  const { account, permission, spectating } = useSession(
    useShallow((s) => ({ account: s.account, permission: s.permission, spectating: s.spectating }))
  )
  const player = usePlayer(account)
  const [pending, setPending] = useState<string | null>(null)
  /** Set once a transaction of this session registered the player, so the next does not again. */
  const registered = useRef(false)

  type Options = { split?: boolean; refresh?: boolean }

  /** Resolves true once signed and refreshed, false when cancelled, refused or failed. */
  async function run(build: Build, success: string, key = 'tx', opts: Options = {}): Promise<boolean> {
    if (!account) return false
    if (spectating) {
      toast.info('You are viewing this account read-only. Sign in with your wallet to act.')
      return false
    }
    setPending(key)
    try {
      return await runOne(account, build, success, opts)
    } finally {
      setPending(null)
    }
  }

  async function runOne(account: string, build: Build, success: string, opts: Options): Promise<boolean> {
    try {
      const built = build(account, permission)
      let actions = Array.isArray(built) ? built : [built]
      const register = !!player.data && !player.data.registered && !registered.current
      if (register) actions = [regPlayer(account, permission), ...actions]
      const parts = opts.split ? splitActions(actions) : [actions]
      for (let i = 0; i < parts.length; i++) {
        if (parts.length > 1) {
          if (i > 0) await sleep(BETWEEN_PARTS_MS)
          toast.info(`Transaction ${i + 1} of ${parts.length}: ${parts[i].length} actions. Please sign.`)
        }
        try {
          await transact(parts[i])
          if (register) registered.current = true
        } catch (err) {
          if (i === 0) throw err
          // Earlier parts are on chain: say so, and show what is there now.
          const why = isUserCancel(err) ? 'was cancelled' : `failed: ${formatTransactError(err)}`
          toast.error(
            `Transaction ${i + 1} of ${parts.length} ${why}. Transactions 1${i > 1 ? `–${i}` : ''} already went through; ` +
              'check the result and do the rest again.'
          )
          await refreshPlayer(account)
          return false
        }
      }
      if (success) toast.success(success)
      if (opts.refresh !== false) {
        await sleep(CATCH_UP_MS)
        await refreshPlayer(account)
        setTimeout(() => void refreshPlayer(account), LATE_NODE_MS)
      }
      return true
    } catch (err) {
      if (!isUserCancel(err)) toast.error(formatTransactError(err))
      return false
    }
  }

  /**
   * Signs several transactions one after another, in order, each with its own success message;
   * stops at the first that fails or is cancelled and says how many went through. Resolves to
   * the number of transactions that went through. The next signature is asked for as soon as the
   * previous transaction is accepted: the player's data is read again only once, at the end (the
   * parts are built from the state before the first one, and the wallet broadcasts them all
   * through one node, so a later part sees what an earlier one did).
   */
  async function runSequence(parts: { build: Build; success: string }[], key = 'tx'): Promise<number> {
    if (!account) return 0
    if (spectating) {
      toast.info('You are viewing this account read-only. Sign in with your wallet to act.')
      return 0
    }
    setPending(key)
    try {
      for (let i = 0; i < parts.length; i++) {
        const last = i === parts.length - 1
        if (parts.length > 1) toast.info(`Transaction ${i + 1} of ${parts.length}: ${parts[i].success}. Please sign.`)
        const ok = await runOne(
          account,
          parts[i].build,
          parts.length > 1 ? `${i + 1} of ${parts.length}: ${parts[i].success}` : parts[i].success,
          { refresh: last }
        )
        if (!ok) {
          if (i > 0) {
            toast.error(`Stopped at transaction ${i + 1} of ${parts.length}. The first ${i} went through.`)
            void refreshPlayer(account)
          }
          return i
        }
      }
      return parts.length
    } finally {
      setPending(null)
    }
  }

  return { run, runSequence, busy: pending !== null, pending, account, permission, spectating }
}
