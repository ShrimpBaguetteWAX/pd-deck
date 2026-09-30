import { useState } from 'react'

import { GUIDE_URL } from '@/chain/config'
import { Button } from '@/components/Button'
import { toast } from '@/components/toast'
import { useGlobalStats } from '@/data/game'
import { FlameIcon, GiftIcon, RocketIcon, UsersIcon } from '@/icons'
import { formatCompact, parseAsset } from '@/lib/format'
import { publicUrl } from '@/lib/publicUrl'
import { useSession } from '@/state/session'
import { preloadWallet } from '@/wallet/session'

import './Landing.css'

const FEATURES = [
  { icon: UsersIcon, title: 'Build divisions', text: 'Stake warlords and mercenaries, equip them in a few clicks.' },
  { icon: RocketIcon, title: 'Run the best loop', text: 'Every mission ranked by TLM per hour for your divisions.' },
  { icon: GiftIcon, title: 'Claim & redeploy', text: 'One transaction collects rewards and sends the division back out.' },
  { icon: FlameIcon, title: 'Forge upgrades', text: 'Slots and levels, each explained before you pay.' }
]

export default function Landing() {
  const login = useSession((s) => s.login)
  const restored = useSession((s) => s.restored)
  const [busy, setBusy] = useState(false)
  const stats = useGlobalStats()

  async function connect() {
    setBusy(true)
    try {
      await login()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not connect')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="landing">
      <div className="landing__planet" aria-hidden>
        <img src={publicUrl('/img/planets/magor.png')} alt="" />
      </div>
      <section className="landing__hero rise">
        <img className="landing__logo" src={publicUrl('/img/full_logo.webp')} alt="Planetary Defense" />
        <p className="landing__tag">Command deck</p>
        <h1>Your divisions. The best missions. Fewer clicks.</h1>
        <p className="landing__lead">
          A faster way to play Planetary Defense on WAX: build and equip divisions on one screen, see which mission loop pays the
          most Trilium for your army, and claim and redeploy in a single transaction.
        </p>
        <div className="landing__actions">
          <Button size="lg" color="gradientBlue" isLoading={busy || !restored} onMouseEnter={preloadWallet} onClick={connect}>
            Connect wallet
          </Button>
          <a className="landing__guide" href={GUIDE_URL} target="_blank" rel="noreferrer">
            Read the guide
          </a>
        </div>
        <p className="landing__wallets faint">WAX Cloud Wallet · Anchor</p>
      </section>

      <section className="landing__features">
        {FEATURES.map(({ icon: Icon, title, text }) => (
          <div key={title} className="feature">
            <span className="feature__icon">
              <Icon />
            </span>
            <strong>{title}</strong>
            <span>{text}</span>
          </div>
        ))}
      </section>

      {stats.data && (
        <section className="landing__stats">
          <div>
            <b className="num">{formatCompact(Number(stats.data.player_count))}</b>
            <span>Commanders</span>
          </div>
          <div>
            <b className="num c-tlm">{formatCompact(parseAsset(stats.data.tlm_distributed).amount)}</b>
            <span>TLM paid out</span>
          </div>
          <div>
            <b className="num c-deft">{formatCompact(parseAsset(stats.data.def_distributed).amount)}</b>
            <span>DEF paid out</span>
          </div>
        </section>
      )}
    </div>
  )
}
