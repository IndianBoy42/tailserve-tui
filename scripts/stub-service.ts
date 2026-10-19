// A stand-in for the tailnet service, so the panel can be driven — including
// its expose and unexpose calls — without touching a real tailscale config.
//
//   node scripts/stub-service.ts [--port 4399] [--log requests.jsonl]
//
// It serves one fixture snapshot, appends every request body to the log, and
// applies expose/unexpose to its copy, so a refresh shows the change. The
// fixture is shaped to exercise every branch the panel has: two session
// groups, a session root (hidden), a port bound off loopback (unservable), a
// port whose owner `ss` hid, more ports than fit a pane (so the list
// scrolls), a root handler, a path mount, and two handlers with no local port.
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'

const args = process.argv.slice(2)
const flag = (name: string, fallback: string): string => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1]! : fallback
}
const port = Number(flag('port', '4399'))
const log = flag('log', '/tmp/tailserve-requests.jsonl')
const dns = flag('dns', 'demo-node.tailnet.ts.net')

interface Owner {
  pid: number
  name: string
  sessionId?: string
  sessionName?: string
  sessionMain?: boolean
}
interface FixturePort {
  port: number
  addresses: string[]
  proxyable: boolean
  owners: Owner[]
}
interface FixtureExposure {
  kind: 'https' | 'tcp'
  outwardPort: number
  path?: string
  target: string
  targetPort?: number
  url: string
}

const listening = (
  number: number,
  name: string | null,
  extra: Partial<FixturePort> & { owner?: Partial<Owner> } = {},
): FixturePort => {
  const { owner, ...rest } = extra
  return {
    port: number,
    addresses: ['127.0.0.1'],
    proxyable: true,
    owners: name === null ? [] : [{ pid: 1000, name, ...owner }],
    ...rest,
  }
}

const fixture = {
  available: true,
  dnsName: dns,
  ports: [
    listening(9000, 'marimo', { owner: { sessionId: 's1', sessionName: 'marimo-playground' } }),
    listening(2718, 'node', { owner: { sessionId: 's1', sessionName: 'marimo-playground' } }),
    listening(4321, 'bun', { owner: { sessionId: 's2', sessionName: 'api-work' } }),
    listening(8000, 'uvicorn', { owner: { sessionId: 's2', sessionName: 'api-work' } }),
    listening(9101, 'omp', { owner: { sessionId: 's3', sessionMain: true } }),
    listening(6443, 'slirp', { addresses: ['0.0.0.0'], proxyable: false }),
    listening(7000, null),
    ...['vite', 'jupyter', 'grafana', 'prometheus', 'postgres', 'redis', 'ollama', 'code-server',
      'minio', 'syncthing', 'plexus', 'rscorer', 'nxnode', 'pcbnew'].map((name, index) =>
      listening(5100 + index, name)
    ),
  ] as FixturePort[],
  exposures: [
    { kind: 'https', outwardPort: 9000, target: 'http://127.0.0.1:9000', targetPort: 9000, url: `https://${dns}:9000/` },
    { kind: 'tcp', outwardPort: 4321, target: '127.0.0.1:4321', targetPort: 4321, url: '' },
    { kind: 'https', outwardPort: 443, path: '/api', target: 'http://127.0.0.1:8000', targetPort: 8000, url: `https://${dns}/api` },
    { kind: 'https', outwardPort: 8443, target: 'http://127.0.0.1:9999', targetPort: 9999, url: `https://${dns}:8443/` },
    { kind: 'tcp', outwardPort: 5432, target: '127.0.0.1:5432', url: '' },
  ] as FixtureExposure[],
}

/** A path mount lands on 443; a root HTTPS or TCP handler on the local port. */
function apply(url: string, body: Record<string, unknown>): void {
  const outwardPort = typeof body.outwardPort === 'number'
    ? body.outwardPort
    : typeof body.path === 'string'
    ? 443
    : body.port
  if (url === '/api/tailscale/expose') {
    const path = typeof body.path === 'string' ? body.path : undefined
    fixture.exposures.push({
      kind: body.kind === 'tcp' ? 'tcp' : 'https',
      outwardPort: Number(outwardPort),
      ...(path === undefined ? {} : { path }),
      target: `127.0.0.1:${String(body.port)}`,
      targetPort: Number(body.port),
      url: path === undefined && body.kind === 'https'
        ? `https://${dns}:${String(outwardPort)}/`
        : path === undefined
        ? ''
        : `https://${dns}/${path}`,
    })
  } else if (url === '/api/tailscale/unexpose') {
    const at = fixture.exposures.findIndex((exposure) =>
      exposure.kind === body.kind
      && exposure.outwardPort === outwardPort
      && (exposure.path ?? '/') === (body.path ?? '/')
    )
    if (at >= 0) fixture.exposures.splice(at, 1)
  }
}

createServer((request, response) => {
  const url = request.url ?? '/'
  if (request.method === 'GET') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(fixture))
    return
  }
  let body = ''
  request.on('data', (chunk: Buffer) => {
    body += chunk.toString('utf8')
  })
  request.on('end', () => {
    appendFileSync(log, `${JSON.stringify({ method: request.method, url, body })}\n`)
    apply(url, JSON.parse(body || '{}') as Record<string, unknown>)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"ok":true}')
  })
}).listen(port, '127.0.0.1', () => {
  process.stdout.write(`tailnet stub on http://127.0.0.1:${String(port)}, logging to ${log}\n`)
})
