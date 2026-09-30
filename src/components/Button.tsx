import { useEffect, useRef, useState, type ButtonHTMLAttributes, type MouseEvent, type ReactNode } from 'react'

import './Button.css'

export type ButtonColor =
  | 'gradientRed'
  | 'gradientGreen'
  | 'gradientOrange'
  | 'gradientYellow'
  | 'gradientBlue'
  | 'gradientPink'
  | 'gradientBlack'
  | 'gradientGray'
  | 'solidBlue'
  | 'ghost'
  | 'danger'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode
  color?: ButtonColor
  size?: 'sm' | 'md' | 'lg'
  block?: boolean
  pill?: boolean
  isLoading?: boolean
  /** Renders a <span> styled as a button, for use inside links. */
  asSpan?: boolean
}

/** Tracks a click handler's promise so the element can show it is working until it settles. */
function usePendingClick<E>(onClick?: (event: E) => unknown) {
  const [pending, setPending] = useState(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  function handleClick(event: E) {
    if (pending) return
    const result = onClick?.(event)
    if (result instanceof Promise) {
      setPending(true)
      const done = () => {
        if (mounted.current) setPending(false)
      }
      result.then(done, done)
    }
  }

  return { pending, handleClick }
}

/** A plain (icon) button that shows a spinner while its click promise runs. */
export function AsyncIconButton({
  onClick,
  disabled,
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  const { pending, handleClick } = usePendingClick<MouseEvent<HTMLButtonElement>>(onClick)
  return (
    <button
      type="button"
      className={`${className} ${pending ? 'is-busy' : ''}`}
      aria-busy={pending || undefined}
      disabled={disabled || pending}
      onClick={handleClick}
      {...rest}
    >
      {pending ? <span className="spinner" aria-hidden /> : children}
    </button>
  )
}

export function Button({
  children,
  color = 'solidBlue',
  size = 'md',
  block,
  pill,
  isLoading,
  asSpan,
  className = '',
  type = 'button',
  onClick,
  disabled,
  ...rest
}: ButtonProps) {
  // A click that returns a promise (every transaction does) keeps this button busy until it settles,
  // so each action visibly registers even where the caller passes no isLoading.
  const { pending, handleClick } = usePendingClick<MouseEvent<HTMLButtonElement>>(onClick)
  const busy = !!isLoading || pending

  const classes = [
    'btn',
    `btn--${color}`,
    `btn--${size}`,
    block ? 'btn--block' : '',
    pill ? 'btn--pill' : '',
    busy ? 'is-busy' : '',
    className
  ]
    .filter(Boolean)
    .join(' ')

  const content = (
    <>
      {busy && <span className="spinner btn__spinner" aria-hidden />}
      <span className={`btn__label ${busy ? 'is-hidden' : ''}`}>{children}</span>
    </>
  )

  if (asSpan) return <span className={classes}>{content}</span>

  return (
    <button
      type={type}
      className={classes}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      onClick={handleClick}
      {...rest}
    >
      {content}
    </button>
  )
}
