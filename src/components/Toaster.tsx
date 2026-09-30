import { useEffect, useState, type CSSProperties } from 'react'

import { TOAST_MS, useToasts } from './toast'

import './Toaster.css'

/**
 * Where the toasts hang: under whatever bars are at the top of the page, so they never cover the
 * top bar or the section menu. Only measured while a toast is up, and again as the page scrolls,
 * since the section menu is only sticky on the widest screens.
 */
function useToastTop(count: number) {
  const [top, setTop] = useState<number>()

  useEffect(() => {
    if (count === 0) return
    const place = () => {
      const bars = ['.topbar', '.section-nav'].map((sel) => document.querySelector(sel)?.getBoundingClientRect().bottom ?? 0)
      setTop(Math.max(0, ...bars) + 10)
    }
    place()
    window.addEventListener('scroll', place, { passive: true })
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place)
      window.removeEventListener('resize', place)
    }
  }, [count])

  return top
}

export function Toaster() {
  const toasts = useToasts((s) => s.toasts)
  const dismiss = useToasts((s) => s.dismiss)
  const top = useToastTop(toasts.length)

  return (
    <div className="toaster" role="status" aria-live="polite" style={top === undefined ? undefined : { top }}>
      {toasts.map((t) => (
        <button
          key={t.id}
          className={`toast toast--${t.kind}`}
          style={{ '--toast-life': `${TOAST_MS}ms` } as CSSProperties}
          onClick={() => dismiss(t.id)}
        >
          <span className="toast__icon" aria-hidden>
            {t.kind === 'success' ? '✓' : t.kind === 'error' ? '!' : 'i'}
          </span>
          <span className="toast__message">{t.message}</span>
          <span className="toast__bar" />
        </button>
      ))}
    </div>
  )
}
