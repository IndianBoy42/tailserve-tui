import assert from 'node:assert/strict'
import test from 'node:test'
import { View, plain, type Key } from '@stencil-hq/tern'
import type {
  TailnetExposure,
  TailnetPort,
  TailnetPortOwner,
  TailnetSnapshot,
} from '../src/tailnet.ts'
import {
  computeSections,
  editDraft,
  handleKey,
  openMount,
  slugFor,
  submitMountIntent,
  TailnetModel,
  unexposeRequest,
  type Row,
  type Sections,
} from '../src/model.ts'
import {
  noOwnership,
  paneCommand,
  paneLabel,
  type Pane,
  type PaneOwnership,
} from '../src/tern.ts'
import {
  buildView,
  FILTER_ID,
  IDLE_ACTIONS,
  MOUNT_DRAFT_ID,
  rowNodeId,
} from '../src/view.ts'

/** One key press, with every modifier the decoder reports. */
function key(name: string, extra: Partial<Key> = {}): Key {
  return { name, ctrl: false, alt: false, shift: false, meta: false, ...extra }
}

function owner(name: string, extra: Partial<TailnetPortOwner> = {}): TailnetPortOwner {
  return { pid: 1, name, ...extra }
}

function listening(
  port: number,
  owners: TailnetPortOwner[],
  extra: Partial<TailnetPort> = {},
): TailnetPort {
  return { port, addresses: ['127.0.0.1'], proxyable: true, owners, ...extra }
}

function handler(
  kind: 'https' | 'tcp',
  outwardPort: number,
  target: string,
  extra: Partial<TailnetExposure> = {},
): TailnetExposure {
  return { kind, outwardPort, target, url: '', ...extra }
}

/**
 * Two sessions, one scope root (hidden), one unservable port, one port with
 * no visible owner, and one handler whose target port is not in the list.
 */
const SNAPSHOT: TailnetSnapshot = {
  available: true,
  dnsName: 'host.ts.net',
  ports: [
    listening(3000, [owner('vite', { sessionId: 's1', sessionName: 'Alpha' })]),
    listening(5173, [owner('bun', { sessionId: 's1', sessionName: 'Alpha' })]),
    listening(8080, [owner('caddy')]),
    // The session's own Pi process (the scope root), and its tools below it.
    listening(9001, [owner('omp', { sessionId: 's2', sessionName: 'Beta', sessionMain: true })]),
    listening(9100, [owner('docker', { sessionId: 's2', sessionName: 'Beta' })]),
    listening(2719, [owner('unseen', { sessionMain: true })]),
    listening(4000, [owner('plexus')], { addresses: ['0.0.0.0'], proxyable: false }),
  ],
  exposures: [
    handler('https', 3000, 'http://127.0.0.1:3000', {
      targetPort: 3000,
      url: 'https://host.ts.net:3000/',
    }),
    handler('https', 443, 'http://127.0.0.1:9001', {
      targetPort: 9001,
      path: '/omp',
      url: 'https://host.ts.net/omp',
    }),
    handler('tcp', 8080, '127.0.0.1:8080', { targetPort: 8080 }),
    handler('https', 8443, 'http://127.0.0.1:9999', {
      targetPort: 9999,
      url: 'https://host.ts.net:8443/',
    }),
    handler('tcp', 5432, '127.0.0.1:5432'),
  ],
}

function modelWith(snapshot: TailnetSnapshot | null = SNAPSHOT): TailnetModel {
  const model = new TailnetModel('http://127.0.0.1:43121')
  model.snapshot = snapshot
  model.refreshedAt = Date.now()
  return model
}

/** A model grouped by session scopes, the mode no Tern daemon leaves you in. */
function sessionModel(snapshot: TailnetSnapshot | null = SNAPSHOT): TailnetModel {
  const model = modelWith(snapshot)
  model.grouping = 'sessions'
  return model
}

/** One Tern pane, as `tern ls --json` plus `tern process` would describe it. */
function pane(id: number, over: Partial<Pane> = {}): Pane {
  return {
    id,
    session: 'Default',
    tab: 1,
    title: '',
    cwd: '/home/anshuman',
    program: '/usr/bin/fish',
    focused: false,
    rootPid: 100 + (id % 100),
    group: 200 + (id % 100),
    own: false,
    ...over,
  }
}

/** An attribution holding these ports in these panes. */
function ownershipOf(entries: Array<[number, Pane]>): PaneOwnership {
  const byPort = new Map<number, Pane[]>()
  for (const [port, holder] of entries) byPort.set(port, [holder])
  return {
    own: entries.find(([, holder]) => holder.own)?.[1] ?? null,
    panes: [...new Set(entries.map(([, holder]) => holder))],
    byId: new Map(entries.map(([, holder]) => [holder.id, holder])),
    byPort,
    unreadable: false,
  }
}

/** The drawn port row for one port; the fixture always has one. */
function portAt(sections: Sections, port: number): TailnetPort {
  const row = sections.rows.find((entry) => entry.kind === 'port' && entry.port.port === port)
  if (row === undefined || row.kind !== 'port') throw new Error(`no port row for ${String(port)}`)
  return row.port
}

/** The open mount dialog's draft; tests open it before asking. */
function mountDraft(model: TailnetModel): { text: string; cursor: number } {
  const mount = model.mount
  if (mount === null) throw new Error('no mount dialog is open')
  return mount.draft
}

test('groups ports by the Tern pane holding them, and falls back for the rest', () => {
  const marimo = pane(11, { title: 'marimo playground', tab: 2 })
  const api = pane(22, { session: 'Second', tab: 1, cwd: '/home/anshuman/api' })
  const rscorer = pane(33, { title: 'scoring', foreground: { pid: 900, name: 'rscorer' } })
  const sections = computeSections(
    SNAPSHOT,
    '',
    'panes',
    ownershipOf([[3000, marimo], [5173, marimo], [8080, api], [9100, rscorer]]),
  )

  assert.deepEqual(
    sections.groups.map((group) => [group.id, group.name, group.ports.map((p) => p.port)]),
    [
      ['pane:22', 'fish', [8080]],
      ['pane:11', 'marimo playground', [3000, 5173]],
      ['pane:33', 'scoring', [9100]],
    ],
  )
  assert.deepEqual(sections.groups[0]?.meta, ['Second · tab 1', '· fish'])
  assert.deepEqual(sections.groups[1]?.meta, ['Default · tab 2', '· fish'])
  assert.deepEqual(sections.groups[2]?.meta, ['Default · tab 1', '· rscorer'])
  // Ports no pane holds stay listed together, served first then by name.
  // 9001's owner is another session's scope root, which no pane here holds.
  assert.deepEqual(sections.others.map((port) => port.port), [9001, 4000, 2719])
  assert.equal(sections.visible, 7)
  assert.equal(sections.total, 7)
})

test('a pane group counts the scope-root ports it holds, and marks its own', () => {
  const mine = pane(11, { title: 'this session', own: true })
  const sections = computeSections(SNAPSHOT, '', 'panes', ownershipOf([[9001, mine], [3000, mine]]))
  assert.deepEqual(sections.groups.map((group) => [group.name, group.own, group.mainOnly]), [
    ['this session', true, 1],
  ])
  assert.deepEqual(sections.groups[0]?.meta, ['Default · tab 1', '· fish', '· this pane'])
  assert.deepEqual(sections.groups[0]?.ports.map((port) => port.port), [3000, 9001])
})

test('groups by session scope on request, keeping the scope-root port', () => {
  const sections = computeSections(SNAPSHOT, '', 'sessions', noOwnership())
  assert.deepEqual(sections.groups.map((group) => [group.id, group.name, group.ports.map((p) => p.port)]), [
    ['session:s1', 'Alpha', [3000, 5173]],
    ['session:s2', 'Beta', [9001, 9100]],
  ])
  assert.deepEqual(sections.others.map((port) => port.port), [8080, 4000, 2719])
  assert.equal(sections.visible, 7)
  assert.equal(sections.total, 7)
})

test('a group heading reads the pane the way the tree does', () => {
  assert.equal(paneLabel(pane(1, { title: 'agent work' })), 'agent work')
  assert.equal(paneLabel(pane(1, { foreground: { pid: 5, name: 'node' } })), 'node')
  assert.equal(paneLabel(pane(1, { program: '/usr/bin/fish' })), 'fish')
  assert.equal(paneLabel(pane(1, { program: '' }), undefined), 'pane 1')
  assert.equal(paneCommand(pane(1, { foreground: { pid: 5, name: 'uvicorn' } })), 'uvicorn')
  assert.equal(paneCommand(pane(1, { program: '/usr/bin/fish' })), 'fish')
})

test('orders other ports by served first, then process name and port', () => {
  const sections = computeSections(
    {
      ...SNAPSHOT,
      ports: [
        listening(22, [owner('sshd')]),
        listening(443, [owner('caddy')]),
        listening(80, [owner('caddy')]),
      ],
      exposures: [handler('https', 443, 'http://127.0.0.1:443', { targetPort: 443 })],
    },
    '',
  )
  assert.deepEqual(sections.others.map((port) => port.port), [443, 80, 22])
})

test('filters on port, process, address and handler target', () => {
  const sessions = (query: string): Sections => computeSections(SNAPSHOT, query, 'sessions')
  assert.deepEqual(sessions('vite').groups[0]?.ports.map((p) => p.port), [3000])
  assert.deepEqual(sessions('9100').groups.map((group) => group.name), ['Beta'])
  assert.deepEqual(sessions('0.0.0.0').others.map((p) => p.port), [4000])
  assert.deepEqual(sessions('ts.net:8443').handlers.length, 2)
  assert.equal(sessions('nothing-matches').visible, 0)

  // A pane group survives the filter only on its ports; its heading is not searched.
  const held = ownershipOf([[3000, pane(11, { title: 'marimo playground' })]])
  assert.deepEqual(computeSections(SNAPSHOT, 'vite', 'panes', held).groups.map((g) => g.name), [
    'marimo playground',
  ])
  assert.deepEqual(computeSections(SNAPSHOT, 'marimo', 'panes', held).groups, [])
})

test('a filter pulls the session root ports back in as other ports', () => {
  const sections = computeSections(SNAPSHOT, '9001')
  assert.deepEqual(sections.others.map((port) => port.port), [9001])
  assert.deepEqual(sections.groups, [])
})

test('rows walk ports with their handlers, then the unmatched handlers', () => {
  const sections = computeSections(SNAPSHOT, '', 'sessions', noOwnership())
  assert.deepEqual(
    sections.rows.map((row) => (row.kind === 'port' ? row.key : `handler:${row.key}`)),
    [
      'session:s1:port:3000',
      'handler:expose:https:3000:/',
      'session:s1:port:5173',
      'session:s2:port:9001',
      'handler:expose:https:443:/omp',
      'session:s2:port:9100',
      'o:port:8080',
      'handler:expose:tcp:8080:/',
      'o:port:4000',
      'o:port:2719',
      'handler:expose:https:8443:/',
      'handler:expose:tcp:5432:/',
    ],
  )
  assert.deepEqual(sections.groups.map((group) => group.id), ['session:s1', 'session:s2'])
})

test('row keys carry the group, so a regroup keeps unrelated rows still', () => {
  const held = ownershipOf([[3000, pane(11, { title: 'marimo' })]])
  const panes = computeSections(SNAPSHOT, '', 'panes', held)
  const sessions = computeSections(SNAPSHOT, '', 'sessions', noOwnership())
  const panePort = panes.rows.find((row) => row.kind === 'port' && row.port.port === 3000)
  const sessionPort = sessions.rows.find((row) => row.kind === 'port' && row.port.port === 3000)
  assert.equal(panePort?.key, 'pane:11:port:3000')
  assert.equal(sessionPort?.key, 'session:s1:port:3000')
  // Handlers are identified by the handler itself, not the group it sits in.
  const handlerRow = panes.rows.find((row) => row.kind === 'handler')
  assert.equal(handlerRow?.key, 'expose:https:3000:/')
})

test('a slug reads from the process name, with a port fallback', () => {
  assert.equal(slugFor(listening(3000, [owner('Marimo Server', { sessionMain: true }), owner('vite-dev', { sessionId: 's1' })])), 'vite-dev')
  assert.equal(slugFor(listening(8123, [owner('node')])), 'node')
  assert.equal(slugFor(listening(8123, [])), 'p8123')
})

test('edits a draft by code point, never splitting a surrogate pair', () => {
  const draft = { text: 'ab', cursor: 2 }
  assert.equal(editDraft(draft, key('backspace')), true)
  assert.deepEqual(draft, { text: 'a', cursor: 1 })
  editDraft(draft, key('x', { text: 'é' }))
  assert.deepEqual(draft, { text: 'aé', cursor: 2 })
  draft.cursor = 0
  editDraft(draft, key('delete'))
  assert.deepEqual(draft, { text: 'é', cursor: 0 })
  assert.equal(editDraft(draft, key('up')), false)

  const emoji = { text: '🙂x', cursor: 2 }
  editDraft(emoji, key('left'))
  assert.equal(emoji.cursor, 0)
})

test('the default handler removal names a root mount without a path', () => {
  assert.deepEqual(
    unexposeRequest(handler('https', 3000, 'http://127.0.0.1:3000', { path: '/' })),
    { kind: 'https', outwardPort: 3000 },
  )
  assert.deepEqual(
    unexposeRequest(handler('https', 443, 'http://127.0.0.1:3000', { path: '/marimo' })),
    { kind: 'https', outwardPort: 443, path: '/marimo' },
  )
})

test('walks rows, opens a port menu and removes one handler', () => {
  const model = sessionModel()
  const rows = model.sync().rows
  assert.equal(model.cursorKey, 'session:s1:port:3000')
  assert.deepEqual(handleKey(model, key('down')), [])
  assert.equal(model.cursorKey, 'expose:https:3000:/')
  handleKey(model, key('up'))
  handleKey(model, key('enter'))
  assert.equal(model.openPort, 3000)
  handleKey(model, key('enter'))
  assert.equal(model.openPort, null)

  handleKey(model, key('down')) // the https handler on :3000
  assert.equal(model.cursorKey, 'expose:https:3000:/')
  const intents = handleKey(model, key('x'))
  assert.equal(intents.length, 1)
  assert.deepEqual(intents[0], {
    kind: 'unexpose',
    exposure: SNAPSHOT.exposures[0],
    toast: 'Removed HTTPS on :3000',
  })
  // A port row itself has nothing to remove.
  handleKey(model, key('up'))
  assert.deepEqual(handleKey(model, key('x')), [])

  handleKey(model, key('end'))
  assert.equal(model.cursorIndex, rows.length - 1)
  handleKey(model, key('home'))
  assert.equal(model.cursorKey, 'session:s1:port:3000')
})

test('groups by Tern panes by default, and G switches the grouping', () => {
  const held = ownershipOf([
    [3000, pane(11, { title: 'marimo' })],
    [5173, pane(11, { title: 'marimo' })],
  ])
  const model = modelWith(SNAPSHOT)
  model.ownership = held
  assert.equal(model.grouping, 'panes')
  assert.deepEqual(model.sync().groups.map((group) => group.name), ['marimo'])
  assert.equal(model.cursorKey, 'pane:11:port:3000')
  assert.deepEqual(model.sync().groups[0]?.ports.map((port) => port.port), [3000, 5173])

  handleKey(model, key('G'))
  assert.equal(model.grouping, 'sessions')
  assert.deepEqual(model.sync().groups.map((group) => group.name), ['Alpha', 'Beta'])
  // The cursor follows the port it pointed at, wherever the new grouping put it.
  assert.equal(model.cursorKey, 'session:s1:port:3000')
  assert.deepEqual(model.sync().groups[0]?.ports.map((port) => port.port), [3000, 5173])

  handleKey(model, key('G'))
  assert.equal(model.grouping, 'panes')
  assert.equal(model.cursorKey, 'pane:11:port:3000')
  assert.deepEqual(model.sync().groups.map((group) => group.name), ['marimo'])

  // With no daemon, everything falls through to the unattributed list.
  model.ownership = noOwnership()
  assert.deepEqual(model.sync().groups, [])
  assert.equal(model.sync().others.length, 7)
  assert.equal(model.cursorKey, 'o:port:8080')
})

test('exposes only ports the tailnet can reach', () => {
  const model = modelWith()
  const sections = model.sync()

  // The first row belongs to a pane group; it is served and still exposable.
  model.select(sections.rows, 0)
  assert.deepEqual(handleKey(model, key('h')), [
    { kind: 'expose', request: { kind: 'https', port: 8080 }, toast: 'HTTPS on :8080' },
  ])

  model.select(sections.rows, sections.rows.findIndex((row) => String(row.key).endsWith(':port:5173')))
  assert.deepEqual(handleKey(model, key('h')), [
    { kind: 'expose', request: { kind: 'https', port: 5173 }, toast: 'HTTPS on :5173' },
  ])
  assert.deepEqual(handleKey(model, key('t')), [
    { kind: 'expose', request: { kind: 'tcp', port: 5173 }, toast: 'TCP on :5173' },
  ])

  // 4000 is bound off loopback, so it cannot be a serve target at all.
  model.select(sections.rows, sections.rows.findIndex((row) => String(row.key).endsWith(':port:4000')))
  assert.equal(openMount(model, portAt(sections, 4000)), false)
  assert.deepEqual(handleKey(model, key('m')), [])
  assert.equal(model.mount, null)

  const offline = sessionModel({ ...SNAPSHOT, available: false })
  const offlineRows = offline.sync().rows
  offline.select(offlineRows, offlineRows.findIndex((row) => String(row.key).endsWith(':port:5173')))
  assert.deepEqual(handleKey(offline, key('h')), [])
})

test('mounts a path with the process slug, and cancels on escape', () => {
  const model = sessionModel()
  const rows = model.sync().rows
  model.select(rows, rows.findIndex((row) => String(row.key).endsWith(':port:8080')))
  assert.deepEqual(handleKey(model, key('m')), [])
  assert.deepEqual(model.mount, { port: 8080, draft: { text: 'caddy', cursor: 5 } })
  assert.equal(model.editing, 'mount')

  handleKey(model, key('backspace'))
  handleKey(model, key('backspace'))
  assert.equal(mountDraft(model).text, 'cad')
  handleKey(model, key('x', { text: 'x' }))
  assert.deepEqual(handleKey(model, key('enter')), [
    { kind: 'expose', request: { kind: 'https', port: 8080, path: 'cadx' }, toast: 'Mounted /cadx' },
  ])

  handleKey(model, key('escape'))
  assert.equal(model.mount, null)
  assert.equal(model.editing, null)
  assert.deepEqual(submitMountIntent(model), [])

  // An emptied slug mounts nothing.
  openMount(model, portAt(model.sync(), 8080))
  mountDraft(model).text = '  '
  assert.deepEqual(handleKey(model, key('enter')), [])
})

test('types in the filter, walks the list with it, and clears it', () => {
  const model = modelWith()
  model.ownership = ownershipOf([[3000, pane(11, { title: 'marimo' })]])
  assert.deepEqual(handleKey(model, key('/')), [])
  assert.equal(model.editing, 'filter')
  for (const character of 'vite') handleKey(model, key(character, { text: character }))
  assert.equal(model.filter, 'vite')
  assert.deepEqual(model.sync().groups.map((group) => group.name), ['marimo'])
  assert.deepEqual(model.sync().others, [])
  assert.equal(model.cursorKey, 'pane:11:port:3000')
  // The filter narrows the ports; handlers the snapshot cannot map to one
  // stay reachable, so they are always removable.
  assert.deepEqual(model.sync().rows.map((row) => row.key), [
    'pane:11:port:3000',
    'expose:https:3000:/',
    'expose:https:8443:/',
    'expose:tcp:5432:/',
  ])
  handleKey(model, key('down'))
  assert.equal(model.cursorKey, 'expose:https:3000:/')
  for (let step = 0; step < 5; step += 1) handleKey(model, key('down'))
  // The cursor stops at the end of the rows the filter left.
  assert.equal(model.cursorKey, 'expose:tcp:5432:/')
  handleKey(model, key('enter'))
  assert.equal(model.editing, null)

  handleKey(model, key('escape'))
  assert.equal(model.filter, '')
  assert.equal(model.filterDraft.text, '')
})

test('one action at a time, and a quit that always works', () => {
  const model = sessionModel()
  model.busy = 'expose:https:5173'
  assert.deepEqual(handleKey(model, key('r')), [])
  assert.equal(model.cursorKey, 'session:s1:port:3000')
  handleKey(model, key('down'))
  assert.equal(model.cursorKey, 'expose:https:3000:/')
  assert.deepEqual(handleKey(model, key('q')), [{ kind: 'quit' }])
  handleKey(model, key('/'))
  assert.deepEqual(handleKey(model, key('c', { ctrl: true })), [{ kind: 'quit' }])
})

test('fills a snapshot with addresses, tags and the visible count', () => {
  const model = modelWith()
  model.ownership = ownershipOf([
    [3000, pane(11, { title: 'marimo playground', tab: 2 })],
    [5173, pane(11, { title: 'marimo playground', tab: 2 })],
  ])
  const text = plain(buildView(model, IDLE_ACTIONS))
  assert.match(text, /Tailserve host\.ts\.net/)
  assert.match(text, /marimo playground/)
  assert.match(text, /Default · tab 2/)
  assert.match(text, /vite :3000/)
  assert.match(text, /https:\/\/host\.ts\.net:3000\//)
  assert.match(text, /not on 127\.0\.0\.1/)
  assert.match(text, /Other handlers/)
  assert.match(text, /7\/7/)
  assert.match(text, /Tern panes/)
})

test('builds a view whose ids resolve, including the fields it focuses', () => {
  const model = modelWith()
  const view = buildView(model, IDLE_ACTIONS)
  const tree = View.from(view)
  assert.ok(tree.find(FILTER_ID), `${FILTER_ID} must be in the view`)
  for (const row of model.sync().rows) {
    const id = rowNodeId(model, row)
    assert.ok(id !== null && tree.find(id) !== undefined, `${row.key} must resolve to a node`)
  }

  openMount(model, portAt(model.sync(), 5173))
  const withDialog = View.from(buildView(model, IDLE_ACTIONS))
  assert.ok(withDialog.find(MOUNT_DRAFT_ID), `${MOUNT_DRAFT_ID} must be in the view`)
})

test('keeps one node per rank as the banner and the notice come and go', () => {
  const model = modelWith(null)
  const first = View.from(buildView(model, IDLE_ACTIONS))
  assert.ok(first.find('main.banner'))
  assert.ok(first.find('main.state'))

  model.snapshot = SNAPSHOT
  model.error = 'tailscale is not running'
  model.show('HTTPS on :5173', 'success')
  const second = View.from(buildView(model, IDLE_ACTIONS))
  assert.ok(second.find('main.banner'))
  assert.ok(second.find('main.state'))
  assert.equal(plain(buildView(model, IDLE_ACTIONS)).includes('tailscale is not running'), true)
})

test('marks the cursor row and shows the selected port menu', () => {
  const model = modelWith()
  const rows: Row[] = model.sync().rows
  model.select(rows, rows.findIndex((row) => String(row.key).endsWith(':port:8080')))
  model.openPort = 8080
  const text = plain(buildView(model, IDLE_ACTIONS))
  assert.match(text, /HTTPS on :8080/)
  assert.match(text, /TCP on :8080/)
  assert.match(text, /Mount path…/)
})
