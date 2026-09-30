import { Component, type ErrorInfo, type ReactNode } from 'react'

import './ErrorBoundary.css'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/** A page chunk that no longer exists on the server, typically right after a new deploy. */
const isStaleChunk = (error: Error) =>
  /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(
    error.message
  )

/**
 * Catches render errors so one broken page can't blank the whole app.
 * Mount it with a key that changes per page (e.g. the pathname) so navigating away clears the error.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Page crashed', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    const stale = isStaleChunk(error)
    return (
      <div className="page">
        <section className="crash" role="alert">
          <h2 className="crash__title">{stale ? 'A new version is available' : 'This page ran into a problem'}</h2>
          <p className="crash__text">
            {stale
              ? 'Reload to get the latest version.'
              : 'Try again, or reload if it keeps happening. The other pages still work.'}
          </p>
          <div className="crash__actions">
            {!stale && (
              <button type="button" className="crash__button" onClick={() => this.setState({ error: null })}>
                Try again
              </button>
            )}
            <button type="button" className="crash__button crash__button--primary" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        </section>
      </div>
    )
  }
}
