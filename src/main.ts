#!/usr/bin/env node
import { connect, print, type Session } from '@stencil-hq/tern'
import type { TailnetPort } from './tailnet.ts'
import { DEFAULT_BASE, TailnetApi } from './api.ts'
import { resolvePaneOwnership } from './tern.ts'
import {
  exposureKey,
  exposeIntent,
  handleKey,
  openMount,
  POLL_MS,
  submitMountIntent,
  TailnetModel,
  unexposeIntent,
  unexposeRequest,
  type Intent,
} from './model.ts'
import {
  buildView,
  FILTER_ID,
  IDLE_ACTIONS,
  MOUNT_DRAFT_ID,
  rowNodeId,
  TAILNET_CSS,
  type ViewActions,
} from './view.ts'

/** The program's own version, as the handshake reports it. */
const VERSION = '0.1.0'

interface Options {
  url: string
  pollMs: number
  /** Print one snapshot and exit, instead of taking the pane. */
  once: boolean
}

type Parsed = { ok: true; options: Options } | { ok: false; message: string; code: number }

const USAGE = `Usage: node src/main.ts [options]

The tailserve panel — local ports and the \`tailscale serve\` handlers sharing
them — as a Tern surface. Inside Tern it draws natively; elsewhere it prints
one snapshot of the same view.

Options:
  --url URL       tailnet service origin (default: ${DEFAULT_BASE})
  --refresh SEC   poll interval in seconds (default: ${String(POLL_MS / 1000)})
  --once          print one snapshot and exit
  -h, --help      show this help

Keys:
  ↑ ↓             move over ports and their handlers (pgup/pgdn, home/end, g)
  enter           a port's expose options; a handler's URL, copied
  h / t           expose the selected port (HTTPS / raw TCP)
  m               mount it at a path under 443
  x               remove the selected handler
  f / s / /       filter by port, process, address or URL
  r               refresh      q  quit

A click does what enter does, and Tern's own copy action owns a URL click.
`

/** The command line, or the text to print instead of running. */
function parseArgs(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): Parsed {
  const options: Options = {
    url: env.TAILSERVE_URL ?? DEFAULT_BASE,
    pollMs: POLL_MS,
    once: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '-h' || flag === '--help') return { ok: false, message: USAGE, code: 0 }
    if (flag === '--once') {
      options.once = true
      continue
    }
    if (flag === '--url' || flag === '--refresh') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) {
        return { ok: false, message: `${flag} wants a value\n\n${USAGE}`, code: 2 }
      }
      index += 1
      if (flag === '--url') options.url = value
      else {
        const seconds = Number(value)
        if (!Number.isFinite(seconds) || seconds <= 0) {
          return { ok: false, message: `--refresh wants seconds, not ${value}\n\n${USAGE}`, code: 2 }
        }
        options.pollMs = Math.round(seconds * 1000)
      }
      continue
    }
    return { ok: false, message: `unknown option ${flag}\n\n${USAGE}`, code: 2 }
  }
  options.url = options.url.replace(/\/+$/, '')
  return { ok: true, options }
}

/**
 * One snapshot plus the Tern pane attribution it is grouped by, kept as the
 * program's view: a failure keeps the last snapshot and shows the banner, so
 * a transient blip never empties the panel. The two run together — the pane
 * lookup spawns `tern` per pane, which is the slower half.
 */
async function refresh(model: TailnetModel, api: TailnetApi): Promise<void> {
  const [snapshot, ownership] = await Promise.all([
    api.snapshot().then(
      (value) => ({ value, error: null as string | null }),
      (cause: unknown) => ({
        value: null,
        error: cause instanceof Error ? cause.message : String(cause),
      }),
    ),
    resolvePaneOwnership(),
  ])
  if (snapshot.value !== null) model.snapshot = snapshot.value
  model.ownership = ownership
  model.error = snapshot.error
  model.loading = false
  model.refreshedAt = Date.now()
}

/** One tailscale action: busy while it runs, a notice and a refresh on success. */
async function act(
  model: TailnetModel,
  api: TailnetApi,
  key: string,
  toast: string,
  action: () => Promise<void>,
  draw: () => void,
): Promise<void> {
  model.busy = key
  model.error = null
  draw()
  try {
    await action()
    model.openPort = null
    model.mount = null
    model.editing = null
    await refresh(model, api)
    model.show(toast, 'success')
  } catch (cause) {
    model.error = cause instanceof Error ? cause.message : String(cause)
  } finally {
    model.busy = null
    draw()
  }
}

/**
 * Copies through OSC 52, the clipboard sequence terminals (Tern included)
 * hand to the system clipboard. A click on a handler URL needs none of this:
 * Tern's own `copy` action owns that one.
 */
function copyToClipboard(text: string): void {
  process.stdout.write(`\u001b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\u0007`)
}

/** Runs one intent from the key map or the pointer actions. */
async function runIntent(
  model: TailnetModel,
  api: TailnetApi,
  intent: Intent,
  draw: () => void,
): Promise<void> {
  switch (intent.kind) {
    case 'quit':
      return
    case 'refresh':
      await refresh(model, api)
      draw()
      return
    case 'copy':
      copyToClipboard(intent.text)
      model.show(`Copied ${intent.text}`, 'success')
      draw()
      return
    case 'expose':
      await act(
        model,
        api,
        `expose:${intent.request.kind}:${String(intent.request.port)}:${intent.request.path ?? ''}`,
        intent.toast,
        () => api.expose(intent.request),
        draw,
      )
      return
    case 'unexpose':
      await act(model, api, `unexpose:${exposureKey(intent.exposure)}`, intent.toast, () =>
        api.unexpose(unexposeRequest(intent.exposure)), draw)
  }
}

/** The port the panel acts on, as the view's controls name ports by number. */
function portIn(model: TailnetModel, port: number): TailnetPort | null {
  return model.snapshot?.ports.find((entry) => entry.port === port) ?? null
}

/** What the view's buttons and rows run; every one redraws when it settles. */
function createActions(model: TailnetModel, api: TailnetApi, draw: () => void): ViewActions {
  const run = (intents: readonly Intent[]): void => {
    for (const intent of intents) void runIntent(model, api, intent, draw)
    draw()
  }
  return {
    refresh: () => run([{ kind: 'refresh' }]),
    selectPort: (port) => {
      const sections = model.sync()
      const index = sections.rows.findIndex((row) => row.key === `port:${String(port)}`)
      if (index >= 0) model.select(sections.rows, index)
      draw()
    },
    togglePort: (port) => {
      model.openPort = model.openPort === port ? null : port
      draw()
    },
    exposeHttps: (port) => run(exposeIntent(model, portIn(model, port), 'https')),
    exposeTcp: (port) => run(exposeIntent(model, portIn(model, port), 'tcp')),
    openMount: (port) => {
      openMount(model, portIn(model, port))
      draw()
    },
    submitMount: () => run(submitMountIntent(model)),
    unexpose: (exposure) => run([unexposeIntent(exposure)]),
    toggleFold: (section, collapsed) => {
      model.folded[section] = collapsed
      draw()
    },
    focusFilter: () => {
      model.editing = 'filter'
      model.filterDraft = { text: model.filter, cursor: model.filter.length }
      draw()
    },
    clearFilter: () => {
      model.filter = ''
      model.filterDraft = { text: '', cursor: 0 }
      model.editing = null
      draw()
    },
  }
}

/** The pane Tern gives us: the surface, its poll, and the key/event loop. */
async function runSurface(
  session: Session,
  api: TailnetApi,
  model: TailnetModel,
  options: Options,
): Promise<number> {
  const surface = session.open({ mode: 'screen', title: 'Tailserve', role: 'tailserve.panel' })
  surface.stylesheet('tailnet', TAILNET_CSS)
  const actions = createActions(model, api, () => draw())
  let revealed: string | null = null
  let focused: string | null = null

  /** Sends the whole view, then follows the cursor and the focused field. */
  function draw(): void {
    const sections = model.sync()
    surface.render(buildView(model, actions))
    const row = model.row(sections.rows)
    const id = row === null ? null : rowNodeId(model, row)
    if (id !== null && id !== revealed) {
      revealed = id
      surface.reveal(id, 'nearest')
    }
    const field = model.editing === 'filter'
      ? FILTER_ID
      : model.editing === 'mount'
      ? MOUNT_DRAFT_ID
      : null
    if (field !== focused) {
      focused = field
      surface.focus(field)
    }
  }

  const poll = setInterval(() => {
    if (model.paneVisible) void refresh(model, api).then(() => draw())
  }, options.pollMs)

  try {
    await refresh(model, api)
    draw()
    for await (const input of session) {
      if (input.type === 'key') {
        let quit = false
        for (const intent of handleKey(model, input.key)) {
          if (intent.kind === 'quit') {
            quit = true
            break
          }
          await runIntent(model, api, intent, () => draw())
        }
        draw()
        if (quit) break
        continue
      }
      const event = input.event
      // Only the pane's own state matters: key and click events a node
      // claimed never reach the loop.
      if (event.ev === 'visible') model.paneVisible = event.visible
      else if (event.ev === 'error') {
        model.ternError = event.sheet === undefined ? event.msg : `${event.sheet}: ${event.msg}`
      } else continue
      draw()
    }
  } finally {
    clearInterval(poll)
    await session.close()
  }
  return 0
}

/** No TSP: one static view. Tern keeps it in the scrollback, a pipe reads text. */
async function runSnapshot(api: TailnetApi, model: TailnetModel, options: Options): Promise<number> {
  await refresh(model, api)
  await print(buildView(model, IDLE_ACTIONS), { css: TAILNET_CSS })
  if (model.snapshot === null) return 1
  if (!options.once) {
    process.stderr.write(
      'Tailserve: this terminal does not speak TSP, so the snapshot is static — '
      + 'control the panel from a Tern pane (or pass --once for the snapshot alone).\n',
    )
  }
  return 0
}

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv, process.env)
  if (!parsed.ok) {
    ;(parsed.code === 0 ? process.stdout : process.stderr).write(parsed.message)
    return parsed.code
  }
  const api = new TailnetApi(parsed.options.url)
  const model = new TailnetModel(parsed.options.url)
  if (!parsed.options.once) {
    const session = await connect({ app: 'tailserve-tui', version: VERSION, features: [] })
    if (session !== null) return await runSurface(session, api, model, parsed.options)
  }
  return await runSnapshot(api, model, parsed.options)
}

// The handshake happens inside `main` before anything is written, so a Tern
// pane never sees stray output; a failure there is not worth a stack trace.
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (cause: unknown) => {
    process.stderr.write(`tailnet: ${cause instanceof Error ? cause.message : String(cause)}\n`)
    process.exitCode = 1
  },
)
