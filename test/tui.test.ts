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
    // The session's own process: never in a group, never in "Other ports".
    listening(9001, [owner('omp', { sessionId: 's2', sessionMain: true })]),
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

test('groups session ports and hides the session scope root', () => {
  const sections = computeSections(SNAPSHOT, '')
  assert.deepEqual(sections.groups.map((group) => [group.name, group.ports.map((port) => port.port)]), [
    ['Alpha', [3000, 5173]],
    ['Beta', [9100]],
  ])
  // 9001 belongs to a session root only, so no group and no "Other ports".
  assert.deepEqual(sections.others.map((port) => port.port), [8080, 4000, 2719])
  assert.equal(sections.visible, 6)
  assert.equal(sections.total, 7)
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
  assert.deepEqual(computeSections(SNAPSHOT, 'vite').groups[0]?.ports.map((p) => p.port), [3000])
  assert.deepEqual(computeSections(SNAPSHOT, '9100').groups.map((group) => group.name), ['Beta'])
  assert.deepEqual(computeSections(SNAPSHOT, '0.0.0.0').others.map((p) => p.port), [4000])
  assert.deepEqual(computeSections(SNAPSHOT, 'ts.net:8443').handlers.length, 2)
  assert.equal(computeSections(SNAPSHOT, 'nothing-matches').visible, 0)
})

test('a filter pulls the session root ports back in as other ports', () => {
  const sections = computeSections(SNAPSHOT, '9001')
  assert.deepEqual(sections.others.map((port) => port.port), [9001])
  assert.deepEqual(sections.groups, [])
})

test('rows walk ports with their handlers, then the unmatched handlers', () => {
  const sections = computeSections(SNAPSHOT, '')
  assert.deepEqual(
    sections.rows.map((row) => (row.kind === 'port' ? `port:${String(row.port.port)}` : row.key)),
    [
      'port:3000',
      'expose:https:3000:/',
      'port:5173',
      'port:9100',
      'port:8080',
      'expose:tcp:8080:/',
      'port:4000',
      'port:2719',
      'expose:https:8443:/',
      'expose:tcp:5432:/',
    ],
  )
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
  const model = modelWith()
  model.sync()
  assert.equal(model.cursorKey, 'port:3000')
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
  assert.equal(model.cursorIndex, computeSections(SNAPSHOT, '').rows.length - 1)
  handleKey(model, key('home'))
  assert.equal(model.cursorKey, 'port:3000')
})

test('exposes only ports the tailnet can reach', () => {
  const model = modelWith()
  const sections = model.sync()

  // 3000 is served already but still exposable; the first row is selected.
  assert.deepEqual(handleKey(model, key('h')), [
    { kind: 'expose', request: { kind: 'https', port: 3000 }, toast: 'HTTPS on :3000' },
  ])

  model.select(sections.rows, sections.rows.findIndex((row) => row.key === 'port:5173'))
  assert.deepEqual(handleKey(model, key('h')), [
    { kind: 'expose', request: { kind: 'https', port: 5173 }, toast: 'HTTPS on :5173' },
  ])
  assert.deepEqual(handleKey(model, key('t')), [
    { kind: 'expose', request: { kind: 'tcp', port: 5173 }, toast: 'TCP on :5173' },
  ])

  // 4000 is bound off loopback, so it cannot be a serve target at all.
  model.select(sections.rows, sections.rows.findIndex((row) => row.key === 'port:4000'))
  assert.equal(openMount(model, portAt(sections, 4000)), false)
  assert.deepEqual(handleKey(model, key('m')), [])
  assert.equal(model.mount, null)

  const offline = modelWith({ ...SNAPSHOT, available: false })
  const offlineRows = offline.sync().rows
  offline.select(offlineRows, offlineRows.findIndex((row) => row.key === 'port:5173'))
  assert.deepEqual(handleKey(offline, key('h')), [])
})

test('mounts a path with the process slug, and cancels on escape', () => {
  const model = modelWith()
  const rows = model.sync().rows
  model.select(rows, rows.findIndex((row) => row.key === 'port:8080'))
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
  assert.deepEqual(handleKey(model, key('/')), [])
  assert.equal(model.editing, 'filter')
  for (const character of 'vite') handleKey(model, key(character, { text: character }))
  assert.equal(model.filter, 'vite')
  assert.deepEqual(model.sync().groups.map((group) => group.name), ['Alpha'])
  assert.deepEqual(model.sync().others, [])
  assert.equal(model.cursorKey, 'port:3000')
  // The filter narrows the ports; handlers the snapshot cannot map to one
  // stay reachable, so they are always removable.
  assert.deepEqual(model.sync().rows.map((row) => row.key), [
    'port:3000',
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
  const model = modelWith()
  model.busy = 'expose:https:5173'
  assert.deepEqual(handleKey(model, key('r')), [])
  assert.equal(model.cursorKey, 'port:3000')
  handleKey(model, key('down'))
  assert.equal(model.cursorKey, 'expose:https:3000:/')
  assert.deepEqual(handleKey(model, key('q')), [{ kind: 'quit' }])
  handleKey(model, key('/'))
  assert.deepEqual(handleKey(model, key('c', { ctrl: true })), [{ kind: 'quit' }])
})

test('fills a snapshot with addresses, tags and the visible count', () => {
  const text = plain(buildView(modelWith(), IDLE_ACTIONS))
  assert.match(text, /Tailserve host\.ts\.net/)
  assert.match(text, /Alpha/)
  assert.match(text, /vite :3000/)
  assert.match(text, /https:\/\/host\.ts\.net:3000\//)
  assert.match(text, /not on 127\.0\.0\.1/)
  assert.match(text, /Other handlers/)
  assert.match(text, /6\/7/)
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
  model.select(rows, rows.findIndex((row) => row.key === 'port:8080'))
  model.openPort = 8080
  const text = plain(buildView(model, IDLE_ACTIONS))
  assert.match(text, /HTTPS on :8080/)
  assert.match(text, /TCP on :8080/)
  assert.match(text, /Mount path…/)
})
