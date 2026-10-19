import type { Key } from '@stencil-hq/tern'
import type {
  TailnetExposeRequest,
  TailnetExposure,
  TailnetPort,
  TailnetSnapshot,
  TailnetUnexposeRequest,
} from './tailnet.ts'

/** Poll cadence: a spawned dev server should show up without a manual refresh. */
export const POLL_MS = 5_000

/** A text field's text and UTF-16 caret. The program owns both (no `edit`). */
export interface Draft {
  text: string
  cursor: number
}

/** One selectable line: a listening port, or one handler in the serve config. */
export type Row =
  | { kind: 'port'; key: string; port: TailnetPort; exposures: readonly TailnetExposure[] }
  | { kind: 'handler'; key: string; exposure: TailnetExposure }

/** The ports and handlers of one session scope. */
export interface PortGroup {
  id: string
  name: string
  ports: TailnetPort[]
}

/** Everything the view draws, computed from one snapshot and the filter. */
export interface Sections {
  /** Session groups, ports a session's tools opened, filtered and non-empty. */
  groups: PortGroup[]
  /** Everything else listening, served ports first, filtered. */
  others: TailnetPort[]
  /** Handlers whose target port is not in the list (removable, nothing else). */
  handlers: TailnetExposure[]
  /** Every row in draw order, for the cursor. */
  rows: Row[]
  /** The handlers of each local port, by that port. */
  exposures: Map<number, TailnetExposure[]>
  /** Ports left by the filter, and every port the snapshot holds. */
  visible: number
  total: number
}

/** A side effect the session loop runs; `handleKey` only decides. */
export type Intent =
  | { kind: 'quit' }
  | { kind: 'refresh' }
  | { kind: 'expose'; request: TailnetExposeRequest; toast: string }
  | { kind: 'unexpose'; exposure: TailnetExposure; toast: string }
  | { kind: 'copy'; text: string }

/** One transient notice, no. `n` bumped so the same text shows again. */
export interface Notice {
  n: number
  text: string
  tone: 'success' | 'error'
}

/** The processes holding a port, as `ss` reports them, for the row's handle. */
export function portProcesses(port: TailnetPort): string {
  const names = [...new Set(port.owners.map((owner) => owner.name))]
  return names.length > 0 ? names.join(', ') : 'unknown process'
}

/** A handler key: kind, outward port and mount path identify one handler. */
export function exposureKey(exposure: TailnetExposure): string {
  return `expose:${exposure.kind}:${String(exposure.outwardPort)}:${exposure.path ?? '/'}`
}

/** The serve handler to remove for one exposure; a root mount names no path. */
export function unexposeRequest(exposure: TailnetExposure): TailnetUnexposeRequest {
  return {
    kind: exposure.kind,
    outwardPort: exposure.outwardPort,
    ...(exposure.path === undefined || exposure.path === '/' ? {} : { path: exposure.path }),
  }
}

/** A path mount's slug: the process name, or the port when it has none. */
export function slugFor(port: TailnetPort): string {
  const owner = port.owners.find((entry) => entry.sessionMain !== true) ?? port.owners[0]
  const slug = (owner?.name ?? `p${String(port.port)}`).toLowerCase().replace(/[^a-z0-9]+/g, '-')
  return slug.replace(/^-+|-+$/g, '') || `p${String(port.port)}`
}

/** The handlers of one port; a port bound twice still answers once. */
export function exposuresOf(
  byPort: ReadonlyMap<number, TailnetExposure[]>,
  port: TailnetPort,
): readonly TailnetExposure[] {
  return byPort.get(port.port) ?? []
}

/**
 * Free-text match over port number, process name, bind addresses, and the
 * port's handler targets — so searching `3000`, `marimo`, or `ts.net` all
 * narrow the list. `query` is trimmed and lowercased by the caller.
 */
function matchesFilter(
  port: TailnetPort,
  handlers: readonly TailnetExposure[],
  query: string,
): boolean {
  if (query === '') return true
  const haystack = [
    String(port.port),
    ...port.owners.map((owner) => owner.name),
    ...port.addresses,
    ...handlers.flatMap((handler) => [handler.target, handler.url]),
  ]
    .join(' ')
    .toLowerCase()
  return query.split(/\s+/).every((term) => haystack.includes(term))
}

/** Ports by process name (case-insensitive), then port number. */
function byProcessThenPort(left: TailnetPort, right: TailnetPort): number {
  const leftName = portProcesses(left).toLowerCase()
  const rightName = portProcesses(right).toLowerCase()
  if (leftName !== rightName) {
    const byName = leftName.localeCompare(rightName)
    if (byName !== 0) return byName
  }
  return left.port - right.port
}

/**
 * The visible port groups, other ports, unmatched handlers and the flat row
 * list — the grouping, ordering and filter the panel's rows share.
 */
export function computeSections(snapshot: TailnetSnapshot | null, filter: string): Sections {
  const ports = snapshot?.ports ?? []
  const byPort = new Map<number, TailnetExposure[]>()
  for (const handler of snapshot?.exposures ?? []) {
    if (handler.targetPort === undefined) continue
    const list = byPort.get(handler.targetPort) ?? []
    list.push(handler)
    byPort.set(handler.targetPort, list)
  }
  const query = filter.trim().toLowerCase()
  const sessionPorts = ports.filter((port) =>
    port.owners.some((owner) => owner.sessionMain === true)
  )

  const bySession = new Map<string, PortGroup>()
  for (const port of ports) {
    // The session's own Pi process (the scope root) is not something to share:
    // only the tools it spawned belong in the session's list.
    if (port.owners.some((owner) => owner.sessionMain === true)) continue
    const owner = port.owners.find((entry) => entry.sessionId !== undefined)
    if (owner?.sessionId === undefined) continue
    const group = bySession.get(owner.sessionId) ?? {
      id: owner.sessionId,
      name: owner.sessionName ?? 'Session',
      ports: [],
    }
    group.ports.push(port)
    bySession.set(owner.sessionId, group)
  }
  const groups = [...bySession.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((group) => ({
      ...group,
      ports: group.ports.filter((port) => matchesFilter(port, exposuresOf(byPort, port), query)),
    }))
    .filter((group) => group.ports.length > 0)

  // Pushed under "Other ports" when the filter names it, so a session port
  // stays findable by search without sitting in the session's list.
  const others = [
    ...ports.filter((port) => !port.owners.some((owner) => owner.sessionId !== undefined)),
    ...(query === '' ? [] : sessionPorts),
  ]
    // Served ports first, then by process name, so a busy host reads top-down.
    .sort((left, right) =>
      exposuresOf(byPort, right).length - exposuresOf(byPort, left).length
      || byProcessThenPort(left, right)
    )
    .filter((port) => matchesFilter(port, exposuresOf(byPort, port), query))

  const known = new Set(ports.map((port) => port.port))
  const handlers = (snapshot?.exposures ?? []).filter((handler) =>
    handler.targetPort === undefined || !known.has(handler.targetPort)
  )

  const rows: Row[] = []
  for (const group of groups) {
    for (const port of group.ports) {
      rows.push({
        kind: 'port',
        key: `port:${String(port.port)}`,
        port,
        exposures: exposuresOf(byPort, port),
      })
      for (const exposure of exposuresOf(byPort, port)) {
        rows.push({ kind: 'handler', key: exposureKey(exposure), exposure })
      }
    }
  }
  for (const port of others) {
    rows.push({
      kind: 'port',
      key: `port:${String(port.port)}`,
      port,
      exposures: exposuresOf(byPort, port),
    })
    for (const exposure of exposuresOf(byPort, port)) {
      rows.push({ kind: 'handler', key: exposureKey(exposure), exposure })
    }
  }
  for (const exposure of handlers) {
    rows.push({ kind: 'handler', key: exposureKey(exposure), exposure })
  }

  const visible = groups.reduce((total, group) => total + group.ports.length, 0) + others.length
  return { groups, others, handlers, rows, exposures: byPort, visible, total: ports.length }
}

/** Moves a UTF-16 caret one code point, so a surrogate pair is never split. */
function step(text: string, cursor: number, direction: -1 | 1): number {
  if (direction === 1) {
    return Math.min(text.length, cursor + ((text.codePointAt(cursor) ?? 0) > 0xffff ? 2 : 1))
  }
  const last = text.charCodeAt(cursor - 1)
  const lead = text.charCodeAt(cursor - 2)
  return Math.max(0, cursor - (last >= 0xdc00 && last <= 0xdfff && lead >= 0xd800 && lead <= 0xdbff ? 2 : 1))
}

/**
 * Applies one key to a draft the program owns: the caret moves, the text
 * changes, nothing else. False when the key is not an editing key.
 */
export function editDraft(draft: Draft, key: Key): boolean {
  const { text, cursor } = draft
  if (key.name === 'backspace' && cursor > 0) {
    const from = step(text, cursor, -1)
    draft.text = text.slice(0, from) + text.slice(cursor)
    draft.cursor = from
  } else if (key.name === 'delete') {
    draft.text = text.slice(0, cursor) + text.slice(step(text, cursor, 1))
  } else if (key.name === 'left') {
    draft.cursor = step(text, cursor, -1)
  } else if (key.name === 'right') {
    draft.cursor = step(text, cursor, 1)
  } else if (key.name === 'home' || (key.ctrl && key.name === 'a')) {
    draft.cursor = 0
  } else if (key.name === 'end' || (key.ctrl && key.name === 'e')) {
    draft.cursor = text.length
  } else if (key.ctrl && key.name === 'u') {
    draft.text = text.slice(cursor)
    draft.cursor = 0
  } else if (key.text !== undefined && !key.ctrl && !key.meta && !key.alt) {
    draft.text = text.slice(0, cursor) + key.text + text.slice(cursor)
    draft.cursor = cursor + key.text.length
  } else {
    return false
  }
  return true
}

/** Everything the panel draws and acts on, apart from the snapshot itself. */
export class TailnetModel {
  /** Backend origin; fixed for the process's life. */
  readonly url: string
  snapshot: TailnetSnapshot | null = null
  /** Transport failure, or the snapshot's own tailnet error. */
  error: string | null = null
  /** The last thing Tern rejected (a bad node, a dropped CSS declaration). */
  ternError: string | null = null
  loading = true
  /** Key of the action in flight, so only its control reads busy. */
  busy: string | null = null
  /** When the last refresh finished, for the "updated" segment. */
  refreshedAt = 0
  /** False while the pane is hidden: polling would be wasted work. */
  paneVisible = true
  filter = ''
  filterDraft: Draft = { text: '', cursor: 0 }
  /** Which text field owns the keys, when one does. */
  editing: 'filter' | 'mount' | null = null
  /** The port whose expose menu is open; one menu at a time. */
  openPort: number | null = null
  mount: { port: number; draft: Draft } | null = null
  /** Folded sections; "Other ports" and "Other handlers" start open. */
  folded = { others: false, handlers: false }
  notice: Notice | null = null
  cursorKey: string | null = null
  cursorIndex = 0
  private noticeSeq = 0
  private cached: Sections = computeSections(null, '')
  private cachedFor: { snapshot: TailnetSnapshot | null; filter: string } = {
    snapshot: null,
    filter: '',
  }

  constructor(url: string) {
    this.url = url
  }

  /** The sections for the current snapshot and filter, computed when they change. */
  sync(): Sections {
    if (this.cachedFor.snapshot !== this.snapshot || this.cachedFor.filter !== this.filter) {
      this.cachedFor = { snapshot: this.snapshot, filter: this.filter }
      this.cached = computeSections(this.snapshot, this.filter)
      this.reconcile(this.cached.rows)
    }
    return this.cached
  }

  row(rows: readonly Row[]): Row | null {
    return rows[this.cursorIndex] ?? null
  }

  /** Keeps the cursor on a row that still exists, nearest to where it was. */
  reconcile(rows: readonly Row[]): void {
    if (this.cursorKey !== null && rows.some((row) => row.key === this.cursorKey)) {
      this.cursorIndex = rows.findIndex((row) => row.key === this.cursorKey)
      return
    }
    this.cursorIndex = Math.max(0, Math.min(this.cursorIndex, rows.length - 1))
    this.cursorKey = rows[this.cursorIndex]?.key ?? null
  }

  /** Moves the cursor by `delta` rows, clamped at both ends. */
  move(rows: readonly Row[], delta: number): void {
    if (rows.length === 0) return
    this.select(rows, Math.max(0, Math.min(this.cursorIndex + delta, rows.length - 1)))
  }

  select(rows: readonly Row[], index: number): void {
    this.cursorIndex = Math.max(0, Math.min(index, rows.length - 1))
    this.cursorKey = rows[this.cursorIndex]?.key ?? null
  }

  /** The port a row acts on: the row's own, or the one its handler targets. */
  portOf(row: Row | null): TailnetPort | null {
    if (row === null) return null
    if (row.kind === 'port') return row.port
    return this.snapshot?.ports.find((port) => port.port === row.exposure.targetPort) ?? null
  }

  /** Shows one notice, the same text included, by making it a new node. */
  show(text: string, tone: Notice['tone']): void {
    this.noticeSeq += 1
    this.notice = { n: this.noticeSeq, text, tone }
  }

  /** Whether a port can take a new handler at all. */
  canExpose(port: TailnetPort | null): boolean {
    return port !== null && port.proxyable && this.snapshot?.available === true
  }
}

/** The expose intent for one port, or none when it cannot take a handler. */
export function exposeIntent(
  model: TailnetModel,
  port: TailnetPort | null,
  kind: 'https' | 'tcp',
): Intent[] {
  if (port === null || !model.canExpose(port)) return []
  return [
    {
      kind: 'expose',
      request: { kind, port: port.port },
      toast: `${kind === 'tcp' ? 'TCP' : 'HTTPS'} on :${String(port.port)}`,
    },
  ]
}

/** Opens the path-mount dialog for one port, with the process slug filled in. */
export function openMount(model: TailnetModel, port: TailnetPort | null): boolean {
  if (port === null || !model.canExpose(port)) return false
  const slug = slugFor(port)
  model.mount = { port: port.port, draft: { text: slug, cursor: slug.length } }
  model.editing = 'mount'
  return true
}

/** The removal intent for one handler. */
export function unexposeIntent(exposure: TailnetExposure): Intent {
  return {
    kind: 'unexpose',
    exposure,
    toast: `Removed ${exposure.kind.toUpperCase()} on :${String(exposure.outwardPort)}`,
  }
}

/** The expose request for a path mount, or nothing while the slug is empty. */
export function submitMountIntent(model: TailnetModel): Intent[] {
  const mount = model.mount
  if (mount === null) return []
  const path = mount.draft.text.trim()
  if (path === '') return []
  return [
    {
      kind: 'expose',
      request: { kind: 'https', port: mount.port, path },
      toast: `Mounted /${path}`,
    },
  ]
}

/** Keys an action in flight owns: its controls stay quiet until it settles. */
const CLAIMED_WHILE_BUSY: Record<string, true> = {
  enter: true,
  x: true,
  delete: true,
  h: true,
  t: true,
  m: true,
  r: true,
}

/**
 * One key to state changes and side effects. Mutating the model here (rather
 * than in the session loop) keeps every decision testable without a terminal.
 */
export function handleKey(model: TailnetModel, key: Key): Intent[] {
  const sections = model.sync()
  const rows = sections.rows
  if (key.ctrl && key.name === 'c') return [{ kind: 'quit' }]
  if (model.busy !== null && CLAIMED_WHILE_BUSY[key.name] === true) return []

  if (model.mount !== null) {
    if (key.name === 'escape') {
      model.mount = null
      model.editing = null
      return []
    }
    if (key.name === 'enter') return submitMountIntent(model)
    editDraft(model.mount.draft, key)
    return []
  }

  if (model.editing === 'filter') {
    if (key.name === 'escape' || key.name === 'enter') {
      model.editing = null
      return []
    }
    if (key.name === 'up' || key.name === 'down') {
      // The filter narrows the list while the arrows still walk it.
      model.move(rows, key.name === 'up' ? -1 : 1)
      return []
    }
    if (editDraft(model.filterDraft, key)) model.filter = model.filterDraft.text
    return []
  }

  const row = model.row(rows)
  const port = model.portOf(row)
  switch (key.name) {
    case 'q':
      return [{ kind: 'quit' }]
    case 'r':
      return [{ kind: 'refresh' }]
    case 'k':
    case 'up':
      model.move(rows, -1)
      return []
    case 'j':
    case 'down':
      model.move(rows, 1)
      return []
    case 'page_up':
      model.move(rows, -10)
      return []
    case 'page_down':
      model.move(rows, 10)
      return []
    case 'home':
      model.select(rows, 0)
      return []
    case 'end':
      model.select(rows, rows.length - 1)
      return []
    case 'g':
      model.select(rows, key.shift ? rows.length - 1 : 0)
      return []
    case 'f':
    case 's':
    case '/':
      model.editing = 'filter'
      model.filterDraft = { text: model.filter, cursor: model.filter.length }
      return []
    case 'enter':
      if (row?.kind === 'port') {
        model.openPort = model.openPort === row.port.port ? null : row.port.port
        return []
      }
      if (row?.kind === 'handler' && row.exposure.url !== '') {
        return [{ kind: 'copy', text: row.exposure.url }]
      }
      return []
    case 'x':
    case 'delete':
      return row?.kind === 'handler' ? [unexposeIntent(row.exposure)] : []
    case 'h':
      return exposeIntent(model, port, 'https')
    case 't':
      return exposeIntent(model, port, 'tcp')
    case 'm':
      openMount(model, port)
      return []
    case 'o':
      if (key.shift) model.folded.handlers = !model.folded.handlers
      else model.folded.others = !model.folded.others
      return []
    case 'escape':
      if (model.openPort !== null) model.openPort = null
      else if (model.filter !== '') {
        model.filter = ''
        model.filterDraft = { text: '', cursor: 0 }
      }
      return []
    default:
      return []
  }
}
