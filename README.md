# tailserve-tui

A terminal panel over the local listening ports and the `tailscale serve`
handlers that share them: which ports a session's tools opened, which handlers
already proxy them, and one key to add or remove a handler.

It draws as a native [Tern](https://stencil.so/tern) surface — the program
describes a document, Tern lays it out, animates it and styles it for the
theme — and falls back to a plain snapshot everywhere else. It is a terminal
sibling of the tailnet panel in the livecraft web app, talking to the same
three endpoints.

```sh
npm install
npm start                      # or: node src/main.ts
npm start -- --url http://127.0.0.1:43121 --refresh 5
```

## The service it talks to

The panel owns no tailnet state: it reads a snapshot and asks for changes.

| Request | Body | Answer |
|---|---|---|
| `GET /api/tailscale` | — | the snapshot: `available`, `dnsName`, `error?`, `ports[]`, `exposures[]` |
| `POST /api/tailscale/expose` | `{ port, kind: 'https'\|'tcp', outwardPort?, path? }` | `{ ok: true }` |
| `POST /api/tailscale/unexpose` | `{ kind, outwardPort, path? }` | `{ ok: true }` |

`src/tailnet.ts` is that contract in types. A refusal carries `{ error }`,
which becomes the panel's banner. `--url` (or `TAILSERVE_URL`) names the
service; it defaults to `http://127.0.0.1:43121`, where the livecraft backend
serves these routes.

## Keys

| Key | Does |
|---|---|
| `↑` `↓` `j` `k` | move over ports and their handlers |
| `PgUp` `PgDn` `Home` `End` `g` | move further; the pane scrolls to follow |
| `enter` | on a port: open its expose options; on a handler: copy its URL |
| `h` / `t` | expose the selected port: HTTPS on the same outward port, or a raw TCP forwarder |
| `m` | mount it at a path under 443, with the process name as the slug |
| `x` | remove the selected handler |
| `f` `s` `/` | filter by port, process, address or handler URL |
| `r` | refresh now | 
| `q` | quit |

Everything is also clickable: a handler URL copies with Tern's own copy action
(the flash is Tern's), `⌘`-click opens it, `×` removes it, and a port's row
selects it. `enter` copies through OSC 52, which Tern may accept after asking,
per its clipboard policy.

## What the list shows

Ports grouped by the session whose tools opened them, then everything else —
served ports first, then by process name — then handlers whose target port is
not in the list, which stay removable. A session's own process (the scope
root) is hidden; naming it in the filter pulls it back in. A port that 127.0.0.1
cannot reach cannot be served: its row says so and its expose controls are
inert, as is every expose control when the tailscale CLI is unavailable.

## Outside Tern

`connect()` returns nothing when the pane is not a Tern surface (no TSP, a
pipe, tmux), so the program prints one plain snapshot and exits — useful in a
script, over ssh, or in CI. `--once` asks for that snapshot even inside Tern.

## Development

```sh
npm run typecheck
npm test
npm run stub      # a stand-in tailnet service, for driving mutations safely
```

The panel's semantics live in `src/model.ts` (pure: keys in, state and intents
out) and its document in `src/view.ts`; `src/main.ts` is the session loop and
`src/api.ts` the HTTP client. `AGENTS.md` has the Tern verification recipe.
