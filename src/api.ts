import type {
  TailnetExposeRequest,
  TailnetSnapshot,
  TailnetUnexposeRequest,
} from './tailnet.ts'

/** Where a tailnet service listens unless `--url` or `TAILSERVE_URL` says otherwise. */
export const DEFAULT_BASE = 'http://127.0.0.1:43121'

/** `tailscale serve` answers in well under a second; the poll never waits long. */
const TIMEOUT_MS = 15_000

/** How a service refuses a request: its own message, and an optional code. */
interface ErrorBody {
  error?: string
  code?: string
}

/**
 * The tailnet endpoints a backend exposes over loopback: the whole snapshot,
 * and one handler added or removed. A non-2xx answer carries `{ error }`,
 * which becomes the thrown message.
 */
export class TailnetApi {
  /** Origin, without a trailing slash. */
  readonly base: string

  constructor(base: string) {
    this.base = base.replace(/\/+$/, '')
  }

  /** Local listening ports plus the current `tailscale serve` handlers. */
  async snapshot(): Promise<TailnetSnapshot> {
    return await this.send<TailnetSnapshot>('/api/tailscale')
  }

  /** Adds one serve handler for a local port. */
  async expose(request: TailnetExposeRequest): Promise<void> {
    await this.send<{ ok: true }>('/api/tailscale/expose', request)
  }

  /** Removes one serve handler. */
  async unexpose(request: TailnetUnexposeRequest): Promise<void> {
    await this.send<{ ok: true }>('/api/tailscale/unexpose', request)
  }

  /**
   * One request, with the backend's error message as the failure. A body is
   * only sent for `POST`, so a `GET` carries no content type.
   */
  private async send<T>(path: string, body?: unknown): Promise<T> {
    const url = `${this.base}${path}`
    let response: Response
    try {
      response = await fetch(url, {
        method: body === undefined ? 'GET' : 'POST',
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (cause) {
      // The backend owns the tailnet snapshot; without it there is nothing to
      // read and nothing to toggle, so the message names the fix.
      const reason = cause instanceof Error ? cause.message : String(cause)
      throw new Error(`cannot reach ${this.base} (${reason}) — is the backend running?`)
    }
    const value: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      const detail = (value ?? {}) as ErrorBody
      throw new Error(detail.error ?? `Request failed (${String(response.status)})`)
    }
    return value as T
  }
}
