import { html, span, ui, type Node, type Renderable, type SpanData } from '@stencil-hq/tern'
import type { TailnetExposure, TailnetPort } from './tailnet.ts'
import {
  exposuresOf,
  exposureKey,
  portProcesses,
  slugFor,
  type Row,
  type Sections,
  type TailnetModel,
} from './model.ts'

/**
 * Where the cursor's row lives in the view, for `surface.reveal`. Ids derive
 * from keys (`<region>.<key>.<key>…`), so this mirrors the tree below.
 */
export function rowNodeId(model: TailnetModel, row: Row): string | null {
  const sections = model.sync()
  if (row.kind === 'handler') {
    const owner = sections.groups
      .concat([{ id: '', name: '', ports: sections.others }])
      .find((group) => group.ports.some((port) => port.port === row.exposure.targetPort))
    if (owner !== undefined) {
      const key = owner.id === '' ? 'others' : `g:${owner.id}`
      return `main.${key}.port:${String(row.exposure.targetPort)}`
    }
    return model.folded.handlers ? null : `main.handlers.${row.key}`
  }
  const group = sections.groups.find((entry) =>
    entry.ports.some((port) => port.port === row.port.port)
  )
  if (group !== undefined) return `main.g:${group.id}.${row.key}`
  return sections.others.some((port) => port.port === row.port.port)
    ? `main.others.${row.key}`
    : null
}

/** The filter field's node id (`<region>.<key>.<key>`); mirrors the tree below. */
export const FILTER_ID = 'main.header.search.filter'

/** The mount draft's node id; mirrors the keys under the overlay below. */
export const MOUNT_DRAFT_ID = 'layer.mount.body.field.draft'

/**
 * What a pointer or keystroke runs. The session loop builds these over the
 * live session; the `--once` path passes no-ops, since a printed view
 * listens to nothing.
 */
export interface ViewActions {
  refresh(): void
  selectPort(port: number): void
  togglePort(port: number): void
  exposeHttps(port: number): void
  exposeTcp(port: number): void
  openMount(port: number): void
  submitMount(): void
  unexpose(exposure: TailnetExposure): void
  toggleFold(section: 'others' | 'handlers', collapsed: boolean): void
  focusFilter(): void
  clearFilter(): void
}

/** Controls of a view nothing can touch: a printed snapshot listens to no one. */
export const IDLE_ACTIONS: ViewActions = {
  refresh: () => {},
  selectPort: () => {},
  togglePort: () => {},
  exposeHttps: () => {},
  exposeTcp: () => {},
  openMount: () => {},
  submitMount: () => {},
  unexpose: () => {},
  toggleFold: () => {},
  focusFilter: () => {},
  clearFilter: () => {},
}

/**
 * Tern's program sheets are confined to the surface, so every rule here sits
 * inside the regions; the `nt-*` classes come from `el` nodes, the
 * `tailserve.*` roles from node `role` props. Lengths use `--sf-cw` (one cell):
 * `ch` is not a length unit Tern parses.
 */
export const TAILNET_CSS = `
[data-role='tailserve.header'] { padding-bottom: 4px; }
[data-role='tailserve.banner'] {
	padding: 4px 8px;
	border-radius: var(--r-chip);
	background: rgb(from var(--bad) r g b / 10%);
}
[data-role='tailserve.port'] { padding: 3px 0; border-top: 1px solid var(--l1); }
[data-role='tailserve.port'][data-mark='pick'],
[data-role='tailserve.handler'][data-mark='pick'] { background: rgb(from var(--accent) r g b / 8%); }
[data-role='tailserve.addr'] { color: var(--t4); font-size: 0.92em; }
[data-role='tailserve.kind'] { min-width: calc(6 * var(--sf-cw)); }
[data-role='tailserve.url'] { color: var(--accent-ink); }
[data-role='tailserve.url']:hover { text-decoration: underline; }
[data-role='tailserve.count'] { color: var(--t3); }
.nt-btn {
	padding: 0 6px;
	border: 1px solid var(--l2);
	border-radius: var(--r-chip);
	color: var(--t2);
}
.nt-btn:hover {
	border-color: var(--accent);
	color: var(--accent-ink);
	background: rgb(from var(--accent) r g b / 8%);
}
.nt-btn.on { border-color: var(--accent); color: var(--accent-ink); }
.nt-btn.primary { border-color: var(--accent); color: var(--accent-ink); }
.nt-btn.nt-x:hover { border-color: var(--bad); color: var(--bad); background: transparent; }
.nt-btn.off { border-color: var(--l1); color: var(--t4); }
.nt-btn.off:hover { border-color: var(--l1); color: var(--t4); background: transparent; }
`

/** The header: identity, connection state, refresh, and the filter field. */
function header(model: TailnetModel, actions: ViewActions, sections: Sections): Node {
  const editing = model.editing === 'filter'
  const available = model.snapshot?.available === true
  return ui.col({ key: 'header', role: 'tailserve.header', gap: 'xs' }, [
    ui.row({ key: 'title', gap: 'sm' }, [
      ui.text({
        spans: [span('Tailserve', 'strong'), span(` ${model.snapshot?.dnsName ?? 'not connected'}`, 'muted')],
      }),
      ui.row({ key: 'gap', grow: 1 }),
      ui.badge({
        key: 'state',
        text: available ? 'connected' : model.snapshot === null ? 'reading…' : 'offline',
        tone: available ? 'success' : 'warning',
      }),
      html.button(
        { class: 'nt-btn', title: 'Refresh ports (r)', onClick: () => actions.refresh() },
        '⟳',
      ),
    ]),
    ui.row({ key: 'search', gap: 'sm' }, [
      ui.input({
        key: 'filter',
        grow: 1,
        text: model.filterDraft.text,
        cursor: model.filterDraft.cursor,
        placeholder: 'Filter by port, process, or URL',
        readonly: !editing,
        prompt: [span('/', 'key')],
        onClick: () => actions.focusFilter(),
      }),
      ui.text({
        key: 'count',
        role: 'tailserve.count',
        spans: [span(`${String(sections.visible)}/${String(sections.total)}`, 'num')],
      }),
      model.filter === ''
        ? null
        : html.button(
            { key: 'clear', class: 'nt-btn nt-x', title: 'Clear filter (esc)', onClick: () => actions.clearFilter() },
            '×',
          ),
    ]),
  ])
}

/** One serve handler: its kind, its URL (a click copies it), and remove. */
function handlerRow(exposure: TailnetExposure, selected: boolean, actions: ViewActions): Node {
  return ui.row({
    key: exposureKey(exposure),
    role: 'tailserve.handler',
    gap: 'sm',
    mark: selected ? 'pick' : undefined,
  }, [
    ui.text({
      role: 'tailserve.kind',
      spans: [span(exposure.kind === 'tcp' ? 'TCP' : 'HTTPS', 'accent strong')],
    }),
    ui.text({
      role: 'tailserve.url',
      spans: [span(exposure.url || exposure.target)],
      // Tern's own copy action reads the node's text: the two clicks the
      // panel offers (copy, open) become one here, with ⌘-click to open.
      actions: { click: 'copy', menu: ['copy', 'open'] },
      href: exposure.url === '' ? undefined : exposure.url,
      title: exposure.url === '' ? exposure.target : `Copy ${exposure.url}`,
    }),
    html.button(
      {
        class: 'nt-btn nt-x',
        title: `Remove ${exposure.kind} on port ${String(exposure.outwardPort)} (x)`,
        onClick: () => actions.unexpose(exposure),
      },
      '×',
    ),
  ])
}

/** One listening port: its process, port, addresses, tags, menu and handlers. */
function portRow(
  port: TailnetPort,
  exposures: readonly TailnetExposure[],
  model: TailnetModel,
  actions: ViewActions,
): Node {
  const selected = model.cursorKey === `port:${String(port.port)}`
  const open = model.openPort === port.port
  const canExpose = model.canExpose(port)
  const mainOnly = port.owners.every((owner) => owner.sessionMain === true)
  const blocked = model.snapshot?.available !== true
    ? 'tailscale is unavailable'
    : 'the port is not reachable at 127.0.0.1'
  const head: Array<Node | null> = [
    ui.text({
      spans: [span(portProcesses(port), 'strong'), span(` :${String(port.port)}`, 'num muted')],
    }),
    exposures.length === 0 ? null : ui.badge({ key: 'live', text: 'live', tone: 'success' }),
    mainOnly ? ui.badge({ key: 'main', text: 'session process', tone: 'muted' }) : null,
    port.proxyable ? null : ui.badge({ key: 'warn', text: 'not on 127.0.0.1', tone: 'warning' }),
  ]
  return ui.col(
    {
      key: `port:${String(port.port)}`,
      role: 'tailserve.port',
      gap: 'xs',
      mark: selected ? 'pick' : undefined,
      onClick: () => actions.selectPort(port.port),
    },
    [
      ui.row({ key: 'head', gap: 'sm' }, head),
      port.addresses.length === 0
        ? null
        : ui.text({ key: 'addr', role: 'tailserve.addr', spans: [span(port.addresses.join(' · '))] }),
      ...exposures.map((exposure) =>
        handlerRow(exposure, model.cursorKey === exposureKey(exposure), actions)
      ),
      ui.row({ key: 'act', gap: 'sm' }, [
        canExpose
          ? html.button(
              {
                class: open ? 'nt-btn on' : 'nt-btn',
                title: open ? 'Close the expose options' : 'Expose this port on the tailnet (enter)',
                onClick: () => actions.togglePort(port.port),
              },
              open ? 'Close' : 'Expose…',
            )
          : html.button({ class: 'nt-btn off', title: blocked }, 'Expose…'),
        // The three one-click handlers, shown while the menu is open.
        open && canExpose
          ? html.button(
              {
                class: 'nt-btn',
                title: `HTTPS on the same outward port (h)`,
                onClick: () => actions.exposeHttps(port.port),
              },
              `HTTPS on :${String(port.port)}`,
            )
          : null,
        open && canExpose
          ? html.button(
              {
                class: 'nt-btn',
                title: 'A raw TCP forwarder, same local port (t)',
                onClick: () => actions.exposeTcp(port.port),
              },
              `TCP on :${String(port.port)}`,
            )
          : null,
        open && canExpose
          ? html.button(
              {
                class: 'nt-btn',
                title: `Mount the process slug under 443 (m) — ${slugFor(port)}`,
                onClick: () => actions.openMount(port.port),
              },
              'Mount path…',
            )
          : null,
      ]),
    ],
  )
}

/** A foldable list of rows: the session groups, other ports, other handlers. */
function section(
  key: string,
  head: SpanData[],
  rows: Node[],
  fold: { collapsible: true; collapsed: boolean; onToggle: (collapsed: boolean) => void } | null,
): Node {
  return ui.section(
    {
      key,
      head,
      ...(fold === null
        ? {}
        : {
            collapsible: true,
            collapsed: fold.collapsed,
            onToggle: (event) => fold.onToggle(event.collapsed),
          }),
    },
    rows,
  )
}

/** The mount dialog: the outward name is fixed, the slug is the field. */
function mountOverlay(model: TailnetModel, actions: ViewActions): Node | null {
  const mount = model.mount
  if (mount === null) return null
  const dns = model.snapshot?.dnsName ?? 'host'
  return ui.overlay(
    { key: 'mount', role: 'tailserve.mount', head: 'Mount a path', size: 'sm', anchor: 'center', modal: true },
    [
      ui.col({ key: 'body', gap: 'sm' }, [
        ui.text({
          key: 'lead',
          spans: [
            span('Proxies '),
            span(`:${String(mount.port)}`, 'num'),
            span(' under '),
            // The field's own prompt is the slash between the host and the slug.
            span(`https://${dns}`, 'path'),
          ],
        }),
        ui.row({ key: 'field', gap: 'xs' }, [
          ui.input({
            key: 'draft',
            grow: 1,
            text: mount.draft.text,
            cursor: mount.draft.cursor,
            placeholder: 'path-slug',
            prompt: [span('/', 'key')],
          }),
          html.button(
            { class: 'nt-btn primary', title: 'Add the handler (enter)', onClick: () => actions.submitMount() },
            'Mount',
          ),
        ]),
        ui.row({ key: 'hint' }, [
          ui.text({ spans: [span('enter mount · escape cancel', 'muted')] }),
        ]),
      ]),
    ],
  )
}

/** The status strip: how to drive the panel, and how fresh it is. */
function statusBar(model: TailnetModel, sections: Sections): Node {
  const age = model.refreshedAt === 0
    ? 0
    : Math.round((Date.now() - model.refreshedAt) / 1000) * 1000
  return ui.status({ role: 'tailserve.status' }, [
    ui.seg({
      key: 'busy',
      hidden: model.busy === null,
      icon: 'timer',
      spans: [span(model.busy ?? 'working', 'muted')],
    }),
    ui.seg({
      key: 'keys',
      priority: 1,
      spans: [
        span('↑↓', 'key'),
        span(' move · '),
        span('enter', 'key'),
        span(' expose · '),
        span('h', 'key'),
        span('/'),
        span('t', 'key'),
        span(' add · '),
        span('x', 'key'),
        span(' remove · '),
        span('/', 'key'),
        span(' filter · '),
        span('r', 'key'),
        span(' refresh · '),
        span('q', 'key'),
        span(' quit'),
      ],
    }),
    ui.seg({
      key: 'count',
      side: 'right',
      priority: 2,
      icon: 'compass',
      spans: [span(`${String(sections.visible)}/${String(sections.total)} ports`)],
    }),
    ui.seg({ key: 'age', side: 'right', priority: 1, icon: 'clock' }, [
      ui.elapsed({ age, format: 'short' }),
    ]),
  ])
}

/**
 * The whole panel: the header, banner and rows in `main`, the key hints
 * in `dock`, and the mount dialog and notice in `layer`.
 */
export function buildView(model: TailnetModel, actions: ViewActions): Renderable {
  const sections = model.sync()
  const banner = model.error ?? model.snapshot?.error ?? model.ternError ?? null
  const empty = model.snapshot === null && model.error === null
    ? 'Reading ports…'
    : sections.total === 0
    ? 'No listening TCP ports.'
    : sections.visible === 0
    ? `No ports match “${model.filter.trim()}”.`
    : null

  return {
    main: ui.col({ gap: 'sm' }, [
      header(model, actions, sections),
      ui.text({
        key: 'banner',
        role: 'tailserve.banner',
        tone: 'error',
        hidden: banner === null,
        spans: banner === null ? [] : [span('⚠ ', 'warning'), span(banner, 'error')],
      }),
      ui.text({
        key: 'state',
        role: 'tailserve.state',
        hidden: empty === null,
        spans: empty === null ? [] : [span(empty, 'muted')],
      }),
      ...sections.groups.map((group) =>
        section(
          `g:${group.id}`,
          [
            span(group.name, 'strong'),
            span(`  ${String(group.ports.length)} port${group.ports.length === 1 ? '' : 's'}`, 'muted'),
          ],
          group.ports.map((port) =>
            portRow(port, exposuresOf(sections.exposures, port), model, actions)
          ),
          null,
        )
      ),
      sections.others.length === 0
        ? null
        : section(
            'others',
            [
              span('Other ports', 'strong'),
              span(`  ${String(sections.others.length)}`, 'muted'),
            ],
            sections.others.map((port) =>
              portRow(port, exposuresOf(sections.exposures, port), model, actions)
            ),
            {
              collapsible: true,
              collapsed: model.folded.others,
              onToggle: (collapsed) => actions.toggleFold('others', collapsed),
            },
          ),
      sections.handlers.length === 0
        ? null
        : section(
            'handlers',
            [
              span('Other handlers', 'strong'),
              span(`  ${String(sections.handlers.length)}`, 'muted'),
            ],
            sections.handlers.map((exposure) =>
              handlerRow(exposure, model.cursorKey === exposureKey(exposure), actions)
            ),
            {
              collapsible: true,
              collapsed: model.folded.handlers,
              onToggle: (collapsed) => actions.toggleFold('handlers', collapsed),
            },
          ),
    ]),
    dock: ui.col({ gap: 'none' }, [statusBar(model, sections)]),
    layer: ui.col({ gap: 'sm' }, [
      mountOverlay(model, actions),
      model.notice === null
        ? null
        : ui.toast({
            key: `toast:${String(model.notice.n)}`,
            text: model.notice.text,
            tone: model.notice.tone === 'error' ? 'error' : 'success',
            ttl: 2_400,
          }),
    ]),
  }
}
