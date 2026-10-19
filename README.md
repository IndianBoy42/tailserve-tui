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

## Grouping: the Tern pane the work lives in

Ports are grouped by the **Tern pane whose process tree holds them** — a pane
is where the work that opened a port actually lives, and its title says what
that work is (for an agent pane, the session's own title). The lookup is three
local reads: `tern ls --json` for the session/tab/pane tree, `tern process
<pane> --json` per pane for its process ids, then `/proc` and `ss -tlnp` to
walk a listener up to the pane that holds it. `G` switches to the
pi-livecraft session scopes behind the same list, and `--once`/a pipe falls
back to them automatically, so nothing depends on Tern being there.

| Where a port came from | How it is shown |
|---|---|
| a Tern pane's process tree or foreground job | that pane's group, named by its title, with `Default · tab 1 · omp` under it |
| the pane this panel runs in | the same group, with a `this pane` badge |
| a pane whose process escaped both its tree and its job group | the backend's session scope, or the unattributed list |
| no Tern daemon at all | the session scopes, then "Other ports" |

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
| `G` | group by Tern panes (default) or livecraft sessions |
| `r` | refresh now | 
| `q` | quit |

Everything is also clickable: a handler URL copies with Tern's own copy action
(the flash is Tern's), `⌘`-click opens it, `×` removes it, and a port's row
selects it. `enter` copies through OSC 52, which Tern may accept after asking,
per its clipboard policy.

## What the list shows

The groups above, then everything no group claims — served ports first, then
by process name — then handlers whose target port is not in the list, which
stay removable. A port that 127.0.0.1 cannot reach cannot be served: its row
says so and its expose controls are inert, as is every expose control when the
tailscale CLI is unavailable. A session's own process is labelled
`session process`, and inside a Tern window Tern's live pane list is the
authority on which panes exist — no polling of the daemon beyond a refresh.

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
