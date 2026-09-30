import { publicUrl } from '@/lib/publicUrl'

import './Loading.css'

/** Six planets circling while the chain answers; `inline` sizes it for a page area instead of the screen. */
export function Loading({ inline = false, label = 'Establishing uplink' }: { inline?: boolean; label?: string }) {
  return (
    <div className={`loading ${inline ? 'loading--inline' : ''}`} role="status" aria-live="polite">
      <div className="loading__ring" aria-hidden>
        {['naron', 'neri', 'veles', 'kavian', 'eyeke', 'magor'].map((p, i) => (
          <img key={p} src={publicUrl(`/img/planets/${p}.png`)} alt="" style={{ '--i': i } as React.CSSProperties} />
        ))}
      </div>
      <span className="loading__label">{label}</span>
    </div>
  )
}
