import type { AnyAction, Session, SessionKit } from '@wharfkit/session'

import { APP_NAME, CHAIN_ID } from '@/chain/config'
import { endpointPool } from '@/chain/endpoints'

let kit: Promise<SessionKit> | null = null
let current: Session | undefined

/** Where WharfKit's BrowserLocalStorage keeps the last session. */
const STORED_SESSION_KEY = 'wharf--session'

/**
 * The wallet code is downloaded on first use, not at startup, and the kit is built after the
 * endpoint pool has been probed, so the wallet broadcasts through a node confirmed up and in
 * sync this session. WAX Cloud Wallet and Anchor are offered.
 */
function getKit(): Promise<SessionKit> {
  kit ??= (async () => {
    const [{ SessionKit, ChainDefinition }, { default: WebRenderer }, anchor, cloudWallet] = await Promise.all([
      import('@wharfkit/session'),
      import('@wharfkit/web-renderer'),
      import('@wharfkit/wallet-plugin-anchor'),
      import('@wharfkit/wallet-plugin-cloudwallet'),
      endpointPool.probe()
    ])
    const ui = new WebRenderer()
    // Closing the wallet picker cancels its login promise silently, so kit.login() would never
    // settle and the sign-in button would spin forever. Hear the close here.
    const addCancelable = ui.addCancelablePromise
    ui.addCancelablePromise = (cancel: (reason?: string, silent?: boolean) => unknown) =>
      addCancelable((reason?: string, silent?: boolean) => {
        onPickerClosed?.()
        return cancel(reason, silent)
      })
    return new SessionKit({
      appName: APP_NAME,
      chains: [ChainDefinition.from({ id: CHAIN_ID, url: endpointPool.next() })],
      ui,
      walletPlugins: [new cloudWallet.WalletPluginCloudWallet(), new anchor.WalletPluginAnchor()]
    })
  })()
  kit.catch(() => {
    kit = null
  })
  return kit
}

export function preloadWallet() {
  void getKit().catch(() => undefined)
}

function hasStoredSession(): boolean {
  try {
    return localStorage.getItem(STORED_SESSION_KEY) !== null
  } catch {
    return true
  }
}

export function isUserCancel(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '')
  return /cancel|closed|rejected by user|user rejected|denied/i.test(message)
}

export async function restoreSession(): Promise<Session | undefined> {
  if (!hasStoredSession()) return undefined
  const k = await getKit()
  try {
    current = await k.restore()
  } catch {
    current = undefined
  }
  return current
}

let onPickerClosed: (() => void) | null = null

/** Opens the wallet picker. Resolves to undefined if the user cancels or closes it. */
export async function login(): Promise<Session | undefined> {
  const k = await getKit()
  const closed = new Promise<undefined>((resolve) => {
    onPickerClosed = () => resolve(undefined)
  })
  try {
    const result = await Promise.race([k.login(), closed])
    if (!result) return undefined
    current = result.session
    return result.session
  } catch (err) {
    if (isUserCancel(err)) return undefined
    throw err
  } finally {
    onPickerClosed = null
  }
}

export async function logout(): Promise<void> {
  const k = await getKit()
  await k.logout(current)
  current = undefined
}

export function walletId(): string | null {
  return current ? current.walletPlugin.id : null
}

export function permission(): string {
  return current ? String(current.permission) : 'active'
}

/** Turns a wallet/chain error into the message users should see. */
export function formatTransactError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? '')
  const message = raw
    .replace(/^.*assertion failure with message:\s*/i, '')
    .replace(/\s*- 3\s*$/, '')
    .trim()
  if (!message) return 'Transaction failed'
  return message.charAt(0).toUpperCase() + message.slice(1)
}

export async function transact(actions: AnyAction[]): Promise<string> {
  const session = current ?? (await restoreSession())
  if (!session) throw new Error('Connect a wallet first')
  const result = await session.transact({ actions }, { broadcast: true, expireSeconds: 120 })
  return String(result.resolved?.transaction.id ?? '')
}
