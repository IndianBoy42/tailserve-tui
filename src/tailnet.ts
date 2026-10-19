/**
 * The tailnet contract this panel reads and writes: what a backend that runs
 * `ss` and the `tailscale` CLI reports about one host, and what the panel may
 * ask it to change. The panel owns no tailnet state of its own — every field
 * here arrives on a response and goes back on a request.
 */

/** One process holding a TCP port. */
export interface TailnetPortOwner {
  pid: number
  /** Process name as `ss` reports it (the thread or binary name). */
  name: string
  /** Session whose scope cgroup contains the process. */
  sessionId?: string
  /** That session's display name. */
  sessionName?: string
  /**
   * True for the session's own root process — the scope root, not one of its
   * children. The panel leads with children, which is what sessions serve.
   */
  sessionMain?: boolean
}

/** A TCP port accepting connections on this host, as `ss` reports it. */
export interface TailnetPort {
  port: number
  /** Every bind address seen for the port (`127.0.0.1`, `0.0.0.0`, `::`, `*`, …). */
  addresses: string[]
  /**
   * True when 127.0.0.1 reaches the port, the only target `tailscale serve`
   * proxies to. A port bound only to another address cannot be served.
   */
  proxyable: boolean
  owners: TailnetPortOwner[]
}

/** One handler in the `tailscale serve` configuration. */
export interface TailnetExposure {
  kind: 'https' | 'tcp'
  /** Port Tailscale listens on within the tailnet. */
  outwardPort: number
  /** Mount path on the outward HTTPS port; `/` is the root mount. */
  path?: string
  /** Local `host:port` the handler proxies to, as Tailscale records it. */
  target: string
  /** Local port parsed from `target`, when the target is a numeric TCP address. */
  targetPort?: number
  /** Reachable URL, or empty when the MagicDNS name is unknown. */
  url: string
}

/** Request body for `POST /api/tailscale/expose`. */
export interface TailnetExposeRequest {
  /** Local port to proxy to. */
  port: number
  /** HTTPS reverse proxy (default) or a raw TCP forwarder. */
  kind: 'https' | 'tcp'
  /**
   * Tailnet port to listen on. Defaults to the local port for a root HTTPS
   * mount, and to 443 for a path mount.
   */
  outwardPort?: number
  /** Mount at this path on the outward port instead of the root. HTTPS only. */
  path?: string
}

/** Request body for `POST /api/tailscale/unexpose`. Names the handler to remove. */
export interface TailnetUnexposeRequest {
  kind: 'https' | 'tcp'
  outwardPort: number
  /** Mount path of the handler being removed, for a non-root HTTPS mount. */
  path?: string
}

/** Local listening ports and the current `tailscale serve` configuration. */
export interface TailnetSnapshot {
  /** False when the tailscale CLI is missing or its daemon is unreachable. */
  available: boolean
  /** This node's MagicDNS name, without the trailing dot. */
  dnsName?: string
  /** Why the tailnet side is unavailable, when it is. */
  error?: string
  ports: TailnetPort[]
  exposures: TailnetExposure[]
}
