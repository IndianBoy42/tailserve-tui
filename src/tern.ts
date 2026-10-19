/**
 * Which Tern pane owns a listening port.
 *
 * Tern's daemon knows a pane's process ids, but nothing about sockets: ask it
 * once for the pane tree (`tern ls --json`) and once per pane for the ids
 * (`tern process <id> --json`, which the daemon resolves even when the caller
 * is outside the pane), then read `/proc` for the process graph and `ss` for
 * the listeners. The panel uses this to group ports by the pane whose work
 * opened them, instead of by the session scope that pi-livecraft assigns.
 *
 * Every call degrades: no `tern`, no daemon, another user's socket, an
 * unreadable `/proc` entry — the ports that cannot be attributed are simply
 * not, and the panel falls back to the backend's own attribution.
 */
import { execFile } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** One environment value, treating the empty string as absent. */
function env(name: string): string | null {
  const value = process.env[name]
  return value === undefined || value === '' ? null : value
}

/**
 * The `tern` binary. A pane sets `TERN_ACP` to the client its own terminal
 * attached — an empty string when that is a remote or browser client, so the
 * name on `PATH` is the fallback, not the empty value.
 */
const TERN = env('TERN_ACP') ?? 'tern'

/** The pane the panel itself runs in, from the environment Tern gives it. */
export const OWN_PANE: number | null = (() => {
  const value = Number(env('TERN_PANE'))
  return env('TERN_PANE') !== null && Number.isSafeInteger(value) ? value : null
})()

/** The pane the environment names, for the cgroup fallback below. */
const OWN_WINDOW_PANE: number | null = (() => {
  const value = Number(env('TERN_WINDOW_PANE'))
  return env('TERN_WINDOW_PANE') !== null && Number.isSafeInteger(value) ? value : null
})()

/** Nothing waits on a local socket answer; this only bounds a wedged binary. */
const TIMEOUT_MS = 5_000

/** One pane of a Tern window: its place in the session/tab tree and its processes. */
export interface Pane {
  /** The pane (block) id `tern process` takes. */
  id: number
  session: string
  /** One-based tab number, `0` for a detached pane. */
  tab: number
  /** The pane's title: for an omp pane, the agent session's title. */
  title: string
  cwd: string
  program: string
  focused: boolean
  /** The pane's shell, the root of everything it spawned. */
  rootPid?: number
  /** The pane's current foreground process group. */
  group?: number
  /** The program Tern sees in the foreground of that group, when it is running one. */
  foreground?: { pid: number; name: string }
  /** True for the pane the panel runs in. */
  own: boolean
}

/** What of one pane's process tree: enough to attribute a socket's owner. */
interface Proc {
  ppid: number
  pgrp: number
  name: string
}

/** Every listener and the pane whose work opened it, if any. */
export interface PaneOwnership {
  /** The panel's own pane, when it runs in one. */
  own: Pane | null
  /** The panes that hold at least one process, in draw order. */
  panes: Pane[]
  /** Panes by `tern process`-style id. */
  byId: Map<number, Pane>
  /**
   * Pane per listening port. A port can be held twice (IPv4 and IPv6, or two
   * sockets in one process), so both pids are attributed; the first is the
   * one the panel names.
   */
  byPort: Map<number, Pane[]>
  /** True when the daemon would not or could not answer: panes may be stale. */
  unreadable: boolean
}

/** One pane as `tern ls --json` lists it. */
interface ListingBlock {
  id?: number
  title?: string
  cwd?: string
  program?: string
  focused?: boolean
}

/** The listing shape of `tern ls --json`, trimmed to what this needs. */
interface Listing {
  sessions?: Array<{
    name?: string
    tabs?: Array<{ number?: number; blocks?: ListingBlock[] }>
  }>
  detached?: ListingBlock[]
}

/**
 * Runs one `tern` subcommand, or nothing when there is no daemon to answer.
 * A pane whose `PATH` lacks the client (a trimmed launch environment) can
 * still reach its own daemon: `TERN_PANE_SOCKET` names it, and the failing
 * name is retried against it once.
 */
async function tern(args: readonly string[]): Promise<string | null> {
  for (const binary of TERN_CANDIDATES) {
    try {
      const { stdout } = await run(binary, [...args], { maxBuffer: 8 << 20, timeout: TIMEOUT_MS })
      return stdout
    } catch (cause) {
      // A missing binary is worth one retry elsewhere; a daemon that answered
      // "no such pane" is not.
      if (!isMissingBinary(cause)) return null
    }
  }
  return null
}

/**
 * The clients to try, in order: the `TERN_ACP` name when it is one, then the
 * bare name — which is what a pane whose `TERN_ACP` is empty needs, and it
 * still lands on the right daemon because `TERN_PANE_SOCKET` is in the
 * environment the spawned client inherits.
 */
const TERN_CANDIDATES: readonly string[] = TERN === 'tern' ? ['tern'] : [TERN, 'tern']

/** Whether a failed spawn failed because the binary does not exist. */
function isMissingBinary(cause: unknown): boolean {
  const code = (cause as { code?: string } | null)?.code
  return code === 'ENOENT' || code === 'EACCES'
}

/**
 * The pane this process runs in, when the daemon cannot say so: a pane
 * launched in its own cgroup (`…/tern/pane-<id>.scope`) names itself, which
 * is how a sandboxed program with no `tern` on its `PATH` still knows where
 * it is. Reading the pane a program runs in is always permitted, even when
 * the rest of `/proc` is not.
 */
function ownPaneFromCgroup(): number | null {
  let group: string
  try {
    group = readFileSync('/proc/self/cgroup', 'utf8')
  } catch {
    return null
  }
  const scoped = /tern(?:[^/\n]*)?\/pane-(\d+)\.scope/.exec(group)
  if (scoped !== null) {
    const id = Number(scoped[1])
    return Number.isSafeInteger(id) && id > 0 ? id : null
  }
  // A bare cgroup path falls back to the environment's own pane number.
  const own = OWN_PANE ?? OWN_WINDOW_PANE
  return own !== null && group.includes(String(own)) ? own : null
}

/** Every pane of every session this window knows, in draw order. */
export async function listPanes(): Promise<Pane[]> {
  const stdout = await tern(['ls', '--json'])
  if (stdout === null) return []
  const own = OWN_PANE ?? ownPaneFromCgroup()
  let listing: Listing
  try {
    listing = JSON.parse(stdout) as Listing
  } catch {
    return []
  }
  const panes: Pane[] = []
  const push = (block: ListingBlock | undefined, session: string, tab: number): void => {
    if (block === undefined || typeof block.id !== 'number') return
    panes.push({
      id: block.id,
      session,
      tab,
      title: block.title ?? '',
      cwd: block.cwd ?? '',
      program: block.program ?? '',
      focused: block.focused === true,
      own: block.id === own,
    })
  }
  for (const session of listing.sessions ?? []) {
    for (const entry of session.tabs ?? []) {
      for (const block of entry.blocks ?? []) push(block, session.name ?? 'Default', entry.number ?? 0)
    }
  }
  for (const block of listing.detached ?? []) push(block, 'detached', 0)
  return panes
}

/** One pane's process ids: its shell, its foreground group, its foreground program. */
async function readPaneProcesses(pane: Pane): Promise<void> {
  const stdout = await tern(['process', String(pane.id), '--json'])
  if (stdout === null) return
  try {
    const info = JSON.parse(stdout) as {
      child?: { pid?: number }
      group?: number
      foreground?: { pid?: number; name?: string }
    }
    if (typeof info.child?.pid === 'number') pane.rootPid = info.child.pid
    if (typeof info.group === 'number') pane.group = info.group
    if (typeof info.foreground?.pid === 'number') {
      pane.foreground = { pid: info.foreground.pid, name: info.foreground.name ?? '' }
    }
  } catch {
    // A browser block or a pane that has exited answers nothing useful.
  }
}

/** Every live process's parent, process group and name, in one sweep. */
function processTable(): Map<number, Proc> {
  const table = new Map<number, Proc>()
  let entries: string[]
  try {
    entries = readdirSync('/proc')
  } catch {
    return table
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    let stat: string
    try {
      stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
    } catch {
      continue // Exited mid-sweep, or another user's process.
    }
    // `comm` may hold spaces and parentheses: everything after the last ')' is
    // fields 3 onwards, so ppid (4) and pgrp (5) are the second and third.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    table.set(Number(entry), {
      ppid: Number(fields[1]),
      pgrp: Number(fields[2]),
      name: fields[0] ?? '',
    })
  }
  return table
}

/** Every listening TCP port and the pid holding it, as `ss` reports them. */
async function listeners(): Promise<Array<{ port: number; pid: number }>> {
  let stdout: string
  try {
    ;({ stdout } = await run('ss', ['-tlnpH'], { maxBuffer: 8 << 20, timeout: TIMEOUT_MS }))
  } catch {
    return []
  }
  const out: Array<{ port: number; pid: number }> = []
  for (const line of stdout.split('\n')) {
    const local = line.split(/\s+/)[3]
    if (local === undefined) continue
    const port = Number(local.slice(local.lastIndexOf(':') + 1))
    const pid = Number(/pid=(\d+)/.exec(line)?.[1])
    if (Number.isInteger(port) && Number.isSafeInteger(pid) && pid > 0) out.push({ port, pid })
  }
  return out
}

/**
 * The pane owning one pid: the nearest pane root above it in the process
 * tree, or the pane whose foreground group it belongs to. A double-forked
 * daemon that escaped both is nobody's, which is the honest answer.
 */
function paneOfPid(
  pid: number,
  roots: ReadonlyMap<number, Pane>,
  groups: ReadonlyMap<number, Pane>,
  table: ReadonlyMap<number, Proc>,
): Pane | null {
  let current = pid
  const seen = new Set<number>()
  while (!seen.has(current)) {
    seen.add(current)
    const root = roots.get(current)
    if (root !== undefined) return root
    const group = groups.get(table.get(current)?.pgrp ?? -1)
    if (group !== undefined) return group
    const parent = table.get(current)?.ppid
    if (parent === undefined || parent <= 1 || parent === current) return null
    current = parent
  }
  return null
}

/** The process names of a pid's process group, for a pane whose job is unnamed. */
function groupMembers(group: number, table: ReadonlyMap<number, Proc>): string[] {
  const names: string[] = []
  for (const entry of table.values()) {
    if (entry.pgrp === group && entry.name !== '') names.push(entry.name)
  }
  return [...new Set(names)]
}

/**
 * A pane's label: the title Tern shows, or the process working in its
 * foreground — what the panel groups and sorts by.
 */
export function paneLabel(pane: Pane, table?: ReadonlyMap<number, Proc>): string {
  if (pane.title !== '') return pane.title
  if (pane.foreground !== undefined && pane.foreground.name !== '') return pane.foreground.name
  if (pane.group !== undefined && table !== undefined) {
    const names = groupMembers(pane.group, table)
    if (names.length > 0) return names.join(', ')
  }
  const program = pane.program.split('/').pop()
  return program === undefined || program === '' ? `pane ${String(pane.id)}` : program
}

/** The command a pane's foreground program runs, for the row's tooltip. */
export function paneCommand(pane: Pane): string {
  if (pane.foreground !== undefined && pane.foreground.name !== '') return pane.foreground.name
  const program = pane.program.split('/').pop() ?? pane.program
  return program === '' ? 'shell' : program
}

/**
 * Attributes every listening port to the Tern pane holding it. One listing,
 * one `tern process` per pane, one `/proc` sweep and one `ss`; a failure
 * anywhere leaves that part of the answer empty rather than the whole one.
 */
export async function resolvePaneOwnership(): Promise<PaneOwnership> {
  const panes = await listPanes()
  if (panes.length === 0) {
    // No daemon answered: name our own pane from the environment and cgroup,
    // so a sandboxed panel still says where it runs, then leave attribution
    // to the backend's session scopes.
    const own = ownPaneFromCgroup()
    const stand: Pane[] = own === null ? [] : [{
      id: own,
      session: env('TERN_SESSION') ?? 'this window',
      tab: Number(env('TERN_WINDOW_PANE') ?? 0),
      title: '',
      cwd: process.cwd(),
      program: process.execPath,
      focused: false,
      own: true,
    }]
    return {
      own: stand[0] ?? null,
      panes: stand,
      byId: new Map(stand.map((pane) => [pane.id, pane])),
      byPort: new Map(),
      unreadable: true,
    }
  }
  await Promise.all(panes.map(readPaneProcesses))
  const table = processTable()
  const roots = new Map<number, Pane>()
  const groups = new Map<number, Pane>()
  for (const pane of panes) {
    if (pane.rootPid !== undefined) roots.set(pane.rootPid, pane)
    if (pane.group !== undefined) groups.set(pane.group, pane)
  }
  const byPort = new Map<number, Pane[]>()
  for (const listener of await listeners()) {
    const pane = paneOfPid(listener.pid, roots, groups, table)
    if (pane === null) continue
    const held = byPort.get(listener.port) ?? []
    if (!held.includes(pane)) held.push(pane)
    byPort.set(listener.port, held)
  }
  return {
    own: panes.find((pane) => pane.own) ?? null,
    panes: panes.filter((pane) => pane.rootPid !== undefined),
    byId: new Map(panes.map((pane) => [pane.id, pane])),
    byPort,
    unreadable: false,
  }
}

/** An empty answer, for a caller with nothing to resolve. */
export function noOwnership(): PaneOwnership {
  return { own: null, panes: [], byId: new Map(), byPort: new Map(), unreadable: false }
}
