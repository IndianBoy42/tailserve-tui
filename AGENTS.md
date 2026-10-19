# Agent notes

A Tern (TSP) panel over local ports and the `tailscale serve` handlers sharing
them. Node ≥22 runs the sources directly; there is no build step.

## Layout

| File | Owns |
|---|---|
| `src/tailnet.ts` | The wire contract with the tailnet service (mirror of the backend's types) |
| `src/api.ts` | The three HTTP calls, and their error text |
| `src/model.ts` | All semantics: snapshot → sections/rows, keys → state and intents. Pure, no I/O |
| `src/view.ts` | The document (`{main, dock, layer}`) and the program stylesheet |
| `src/main.ts` | argv/env, the Tern session loop, intent execution, the plain fallback |

Keep it that way: every decision belongs in `model.ts` so tests drive keys
without a terminal, and node ids derive from `key` props — if a tree level
gains or loses a key, `FILTER_ID`, `MOUNT_DRAFT_ID` and `rowNodeId` change with it.

## Checks

```sh
npm run typecheck
npm test
```

## Verifying in Tern

Render offscreen and inspect:

```sh
cd /tmp && cat > scenario.txt <<'EOF'
size 1280 900
run "cd DIR && /absolute/path/to/node src/main.ts --url http://127.0.0.1:4399"
shot flush
shot flush          # real time passes; the program finishes its handshake
key ArrowDown
shot flush
shot 02-row
key q
EOF
tern shot scenario.txt --out DIR/shots --theme dark
```

Then read the PNG, and the `.layout.json` beside it (a flat element list with
`path`, `rect`, `visible`, `opacity`) when a shot disagrees with the DOM.

Friction that costs round trips:

- **`wait <MS>` advances simulated time**, so it does not give a starting
  program real time: keys sent right after `run` race the handshake (the shell
  in that pane eats them) and are silently lost. Buy real time with `shot`
  steps, or drive a live window — `tern serve --control /tmp/sock` plus
  `tern ctl --control /tmp/sock key ArrowDown` with a shell `sleep` — which is
  also the only way to run `tree`/`dump` mid-interaction.
- A pane's `PATH` omits nvm's bin directory: `run` the program with an
  absolute node path, or it fails as "command not found" inside the pane.
- Attribute selectors with dots need quotes in Tern's `tree`/`dump`
  (`[data-role="tailserve.port"]`); unquoted they match nothing.
- A toast caught mid fade-in has `opacity: 0` in the layout even though it is
  drawn, so an absent toast in a PNG is not proof it never fired.

Test mutations against `scripts/stub-service.ts`, never the real tailnet: it
serves one fixture snapshot, logs every request body, and applies
expose/unexpose to its copy, so a refresh shows the change.

```sh
npm run stub                           # 127.0.0.1:4399, log at /tmp/tailserve-requests.jsonl
node src/main.ts --url http://127.0.0.1:4399
```

Its fixture is the one worth keeping: two session groups, a scope-root port, a
port bound off loopback, a port with no visible owner, more ports than fit a
pane (so the list scrolls), a root handler, a path mount, and two handlers with
no local port. Keep it in step with anything `src/model.ts` branches on.

`--once` prints one plain snapshot; it is the cheap way to check the model and
the view without Tern, and the whole fallback path.

## Version control

jj (colocated). One task, one described commit: `jj describe`, then `jj new`.
