import './Loading.css'

/**
 * The deck's mark drawn stroke by stroke while the chain answers: the shield, then the two
 * chevrons, then the planet dot, and a fade before it starts again. `inline` sizes it for a page
 * area instead of the screen.
 */
export function Loading({ inline = false, label = 'Establishing uplink' }: { inline?: boolean; label?: string }) {
  return (
    <div className={`loading ${inline ? 'loading--inline' : ''}`} role="status" aria-live="polite">
      <svg
        className="loading__glyph"
        viewBox="0 0 34 34"
        fill="none"
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <path className="loading__shield" d="M17 3 30 9v9c0 7-6 11-13 13C10 29 4 25 4 18V9z" stroke="var(--cyan)" />
        <path className="loading__chev loading__chev--1" d="M11 14l6-4 6 4" stroke="#ffd166" />
        <path className="loading__chev loading__chev--2" d="M11 20l6-4 6 4" stroke="#ffd166" />
        <circle className="loading__dot" cx="17" cy="25" r="1.6" fill="var(--cyan)" />
      </svg>
      <span className="loading__label">{label}</span>
    </div>
  )
}
