---
name: factory-dev-slot
description: Give each worktree its own local dev server (a dev slot) so parallel agents can validate the same app at once, as a per-worktree container published on 127.0.0.1:<port> with no app changes. Use before starting a dev server or validating in a browser when another agent or worktree may be running one, when the app's fixed dev port is taken (EADDRINUSE), when you would stop and restart one server to compare branches, or when stopping a dev server you started. Triggers on "port in use", "another worktree has the dev server", "run agents in parallel", "start a dev slot", "stop the dev server".
---

# Dev slots

A **dev slot** (`slot` in the commands) is one worktree's dev server running in its own container. Inside, the app keeps its fixed dev port; Docker publishes it on a free host port from the app's range, so slots never collide and nothing is reachable off the machine. Docker labels say who owns a container (app, worktree, port); a lease file says when a slot command last touched it. Needs Docker. Without it, see "When Docker is off".

Every command runs from inside the worktree (or takes `--worktree DIR`). The app defaults to the project name from `factory-context`. The script is `.agents/skills/factory-dev-slot/scripts/slot.mjs`, called `slot` below; run it with `node`.

```bash
node .agents/skills/factory-dev-slot/scripts/slot.mjs up
```

## Validate against your own worktree

1. **Start the slot:** `slot up`. It reaps expired slots, reuses this worktree's slot if one exists, queues while memory is short, otherwise builds the image when the app has a Dockerfile that changed, picks a port, starts the container, and waits for the health path to return 200. It prints one JSON line:
   ```json
   {"app":"my-site","port":14321,"baseUrl":"http://localhost:14321","url":"http://localhost:14321/","session":"my-site-main", ...}
   ```
2. **Point every browser step at it.** Use the printed `baseUrl` and `session`. `eval "$(node .../slot.mjs env)"` exports `DEV_SLOT_BASE_URL` and `DEV_SLOT_SESSION` (names an app config can change, see `env`). Each Bash tool call is a fresh shell, so repeat the `eval` in every call that needs them.
3. **Prove ownership before you report a result:** `slot check` exits 0 only when the slot's port (or `--url URL`) is served by this worktree. Exit 9 names the worktree that is actually serving it; anything you saw there is someone else's code.
4. **Done:** `slot down` removes the container and keeps its `node_modules` volume; `--purge` drops the volume too. Stop your slot when the task ends. A server you started outside a slot stops by its own PID (see below). A slot you forget is reaped after `idleMinutes`.

The step is complete when `slot check` exits 0 for the URL your browser session used.

## App configs

An app config says how to run one app. `slot` looks for it, first match wins:

1. `<worktree>/.agents/factory-metadata/dev-slot.json`, whose `name` must equal the app name (the project name).
2. `.agents/skills/factory-dev-slot-*/apps/<app>.json`, shipped by an installed companion.

No match is an error that lists both places. The shape is `schemas/app.schema.json`:

| Field | Meaning |
|---|---|
| `name`, `image`, `containerPort`, `healthPath`, `portRange`, `memoryGiB` | required. `image` is a ready image (`node:24`) or, with `dockerfile`, the tag to build. `portRange` is `[first, last]` host ports; `memoryGiB` is one slot's measured peak |
| `command` | optional `sh -c` run in `/app` instead of the image's own command: install, then start the dev server bound to `0.0.0.0` |
| `dockerfile` | optional worktree-relative Dockerfile; built when its hash changes, `--rebuild` forces it |
| `scheme` | `http` or `https` (default `https`) |
| `idleMinutes` | gc after this long without a slot command (default 60) |
| `certDir` | gitignored dev-cert dir copied from the main checkout into a worktree that lacks it |
| `sessionPrefix` | browser session prefix (default the app name); the slug is appended |
| `env` | names of the variables `slot env` sets: `baseUrl`, `session`, optional `proxyPort` (default `DEV_SLOT_BASE_URL`, `DEV_SLOT_SESSION`) |

The worktree is bind-mounted at `/app` and `/app/node_modules` is a per-slot named volume, so this suits Node apps whose dependencies install in the container.

### Example: an Astro site

`examples/astro.json` is the whole config for a site that runs `pnpm dev` on port 4321. Copy it to the project, rename it, and `slot up`:

```bash
cp .agents/skills/factory-dev-slot/examples/astro.json .agents/factory-metadata/dev-slot.json   # then set "name" to the project name
```

```json
{
  "name": "my-astro-site",
  "image": "node:24",
  "command": "corepack enable && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile && pnpm dev --host 0.0.0.0 --port 4321",
  "scheme": "http", "containerPort": 4321, "healthPath": "/",
  "portRange": [14321, 14399], "memoryGiB": 2
}
```

Use the Node major the project's `.nvmrc` or `engines` asks for, and the package manager its lockfile uses. `--host 0.0.0.0` matters: a dev server bound to the container's loopback is not reachable through the published port.

## Env profiles

A profile adds the container setup a company network needs: auth files, CA certificates, proxy variables. `adapters.envProfile` (from `factory-context`) names one. `slot up` loads `.agents/skills/*/profiles/<name>.json` from the project's installed skills, and applies it to the container. With no `adapters.envProfile`, nothing is applied. A named profile that is not installed or does not match the schema stops `up` with exit 1 and says where it looked.

The shape is `schemas/profile.schema.json`; every list is optional:

```json
{
  "name": "acme-network",
  "mounts": [{ "host": "~/.npmrc", "container": "/home/node/.npmrc", "warnIfMissing": "no ~/.npmrc" }],
  "env": { "SOME_FLAG": "1" },
  "envFromFile": [{ "name": "REG_TOKEN", "file": "~/.npmrc", "linePrefix": "//registry.example/:_authToken=" }],
  "passEnv": ["NO_PROXY"],
  "rewriteLoopbackEnv": ["HTTPS_PROXY"],
  "caBundle": { "from": "macos-keychain", "keychains": ["/Library/Keychains/System.keychain"], "container": "/home/node/ca.pem", "env": "NODE_EXTRA_CA_CERTS" },
  "hints": { "buildFailed": "run the registry login, then retry" }
}
```

- `mounts` are read-only unless `readOnly` is `false`; a missing host path is skipped with its warning.
- `envFromFile` reads the first line starting with `linePrefix`. The value reaches the container through the child process env, never argv or logs.
- `rewriteLoopbackEnv` forwards a host variable with `127.0.0.1` or `localhost` replaced by `host.docker.internal`. `passEnv` forwards it as it is.
- `caBundle` exports certificates (`macos-keychain` or a PEM `file`) into the state dir, mounts them read-only, and points `env` at them.
- Nothing else in the agent's environment reaches the container. A test fails if `docker run` would forward a credential the profile does not name.

## State, leases and the queue

Slot state lives in `<stateRoot>/../dev-slots` (`stateRoot` from `factory-context`), so every worktree of one project shares it. `DEV_SLOT_STATE` overrides it. Leases, queue tickets and the `slot host` lock sit there. A slot only reaps slots of its own project; memory and ports are counted across all slots on the machine.

- **Leases.** Every `up`, `url`, `env` and `check` renews this worktree's lease; `slot list` shows `lastUsed`. A long stretch with no slot command lets it lapse, so run `slot check` between browser steps.
- **gc** removes a slot when its worktree directory is gone (and then its volume too), when its container has exited, or when its lease is older than `idleMinutes`. An idle slot keeps its volume, so `slot up` brings it back fast. gc runs at the start of every `slot up` and every queue round; `slot gc [--dry-run]` runs it by hand. Nothing runs it on a timer.
- **The queue.** When Docker's memory cannot fit one more slot at `memoryGiB`, `slot up` takes a ticket and waits: oldest first, rechecked every 10 s, gc reclaiming expired slots each round. A ticket that stops heartbeating for 2 minutes loses its place. `--timeout S` caps the wait (default 1800 s, then exit 10) and the readiness wait after it (default 900 s). `--force` skips the queue and risks the VM swapping.
- **Decide within three status lines.** When `up` still prints `waiting for memory` after three rounds, run `slot list` and `slot gc --dry-run`. A finished slot of yours: `slot down`. One gc would reap: `slot gc`. A live slot from another worktree: stop your `up` and ask the user which slot to stop, or take `slot host`.
- **A coordinator's slot starves the agent it delegates to.** Before handing off, `slot down` your own slot, and bring it back after.

## When Docker is off

Without Docker, the app's own port is a single machine-wide slot. `slot host` waits (up to `--timeout`, default 1800 s) until the port is free or already served from this worktree, then takes a lock so the next agent waits through your startup window. Start the dev server yourself in the background, confirm with `slot check`, and run `slot host --release` from the same worktree when you stop it. Waiting is the outcome here; validating on a port another worktree holds is not.

Stop that server by its PID, proven yours: `lsof -tiTCP:<port> -sTCP:LISTEN`, then `lsof -p <pid> -a -d cwd -Fn` must print your worktree. Kill that one PID in a command of its own. A `pkill -f` pattern matches every agent's server on the machine.

## Exit codes

| Code | Meaning | Do |
|---|---|---|
| 0 | Done | Use the printed JSON |
| 1 | Bad usage, not in a git worktree, no app config, or a missing or invalid env profile | Fix the call, the app config or `adapters.envProfile` |
| 2 | Docker not running, build failed, or no free port in `portRange` | Start Docker; read the build error (a profile's `hints.buildFailed` is appended) |
| 4 | Container exited or never became ready | Read the log tail it printed; `docker logs <container>` |
| 8 | No running slot / nothing listening | `slot up` |
| 9 | The port is served by another worktree | Use your own slot; never validate there |
| 10 | `up` timed out in the memory queue, or `host` timed out | Ask the user: a slot to stop, more Docker memory, or a longer `--timeout` |

## Rules

- **One worktree per slot.** The container bind-mounts the worktree, and a dev server's start-up clean can wipe its build output, so two slots on one worktree can delete each other's assets. Run builds and tests in the worktree before `slot up`, or `slot down` / `slot up` after.
- **Each build you compare is its own worktree.** Copying another branch's file into a worktree under a running server races hot reload. Serve the baseline from `git worktree add --detach <path> origin/<trunk>`, in its own slot or after `slot down`.
- **`slot down --purge` before `git worktree remove`.** A running slot keeps writing into its bind mount, so removing the worktree under it fails with `Directory not empty`. If that happens, `rm -rf` the directory, `git worktree prune`, then `slot gc`.
- **Ports bind `127.0.0.1` only, and no container gets the Docker socket.** Keep both when adding an app.
- **Sign-in happens on the host, never in a slot.** A container serves the app and nothing else.
- **Secrets stay out of argv and logs.** Profiles pass secrets through the child env only.
