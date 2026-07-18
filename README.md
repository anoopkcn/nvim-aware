# nvim-aware

Make AI coding agents aware of a running **Neovim** session.

When your prompt refers to the editor — "explain **this file**", "fix the bug in the
**selected** code", "what's the **error under the cursor**?", "work through the
**quickfix list**" — the agent receives a live snapshot of Neovim's state: current file,
cursor position, visual selection, search register, quickfix list, visible windows, and
listed buffers. Neutral prompts ("what is 2 + 2") inject nothing, so there is no token
cost by default.

No Neovim plugin, config, or UI changes are required. Editor state is read from the
outside over `nvim --server <addr> --remote-expr`. Any normal Neovim ≥ 0.5 already
listens on a server (`:echo v:servername`).

Two hosts are supported, sharing one implementation:

| Host | Integration | Details |
|------|-------------|---------|
| [Claude Code](https://code.claude.com) | plugin (hooks + MCP tool + `/nvim` + launcher) | [hosts/claude/README.md](hosts/claude/README.md) |
| Pi | wrapper + extension (`nvim_context` tool + `/nvim`) | [hosts/pi/README.md](hosts/pi/README.md) |

## Quick start — Claude Code

**Option A: the `claude-nvim` launcher** (recommended — no install needed):

```bash
# once: put the launcher on your PATH
ln -s /path/to/nvim-aware/hosts/claude/bin/claude-nvim ~/.local/bin/claude-nvim

# then, with Neovim open in your project:
claude-nvim
```

The launcher finds your running Neovim (interactive picker if several), starts Claude in
that instance's working directory, and auto-loads the plugin. Everything else — flags
like `--model` — passes through to `claude` untouched.

**Option B: install the plugin permanently**, then just run `claude`:

```text
/plugin marketplace add anoopkcn/nvim-aware
/plugin install nvim-aware-claude@nvim-aware
```

(With a global install, set `NVIM_AWARE_AUTO_PLUGIN_DIR=0` if you also use `claude-nvim`,
so the plugin isn't loaded twice.)

**Then use it** — open a file in Neovim, and in Claude Code:

- ask anything that references the editor: *"explain this file"*, *"fix the selected code"*,
  *"what does the error under the cursor mean?"*, *"go through the quickfix list"* —
  a live snapshot is injected automatically;
- run `/nvim` to see exactly what Claude sees;
- Claude can also call the `nvim_context` tool itself whenever it needs fresh editor state.

## Quick start — Pi

```bash
# once: put the wrapper on your PATH
ln -s /path/to/nvim-aware/hosts/pi/bin/pi-nvim ~/.local/bin/pi-nvim

# then, with Neovim open in your project:
pi-nvim
```

The wrapper picks the running Neovim instance, starts Pi in its working directory, and
auto-loads the extension. Pi then receives the editor snapshot before every agent turn,
exposes the `nvim_context` tool, and provides `/nvim` to display the full snapshot.
Normal Pi args pass through: `pi-nvim --model sonnet:high`, `pi-nvim -p "explain the
code under my cursor"`.

For a standalone install without the repo checkout, copy the self-contained bundles:

```bash
cp hosts/pi/dist/pi-nvim ~/.local/bin/pi-nvim
mkdir -p ~/.pi/agent/extensions
cp hosts/pi/dist/nvim-aware-pi.ts ~/.pi/agent/extensions/nvim-aware-pi.ts
export NVIM_AWARE_AUTO_EXTENSION=0   # extension is global now; don't load it twice
```

Those copies are self-contained, so they keep running the version you copied. Re-copy
both files after updating the repo to pick up changes.

## Keep typing `claude` / `pi`

Prefer opting in with a flag instead of a separate command? Add a shell function to your
`~/.bashrc` / `~/.zshrc` that routes to the launcher only when `--nvim` is present:

```bash
claude() {
    for arg in "$@"; do
        case "$arg" in
            --nvim|--nvim=*|--nvim-*) claude-nvim "$@"; return ;;
        esac
    done
    command claude "$@"
}
```

Now `claude` behaves exactly as before, while `claude --nvim` connects to Neovim.
`--nvim=/tmp/nvim-main` is shorthand for `--nvim-server /tmp/nvim-main`. The same
pattern works for `pi` with `pi-nvim`.

## Multiple Neovim instances

- Launchers show an interactive picker in a TTY; non-interactively they pick the
  instance whose working directory best matches yours (exact match → file containment →
  directory containment). The hooks/extension use the same heuristic.
- Pin an instance explicitly: get the address in Neovim with `:echo v:servername`, then
  `claude-nvim --nvim-server <addr>` / `pi-nvim --nvim-server <addr>`, or start Neovim
  with a stable address: `nvim --listen /tmp/nvim-main`.

## Configuration

All configuration is via environment variables. Both hosts share one decision, so these
mean the same thing under Claude Code and Pi:

| Variable | Default | Meaning |
|----------|---------|---------|
| `NVIM_AWARE_PROMPT_CONTEXT` | `auto` | Per-prompt injection: `auto` (only when the prompt references the editor), `full` (every prompt), `hint` (only remind the agent the tool exists), `off`. |
| `NVIM_AWARE_SERVER` | _(discovered)_ | Pin a specific Neovim server address; skips discovery. Set automatically by the launchers. |
| `NVIM_AWARE_SNAPSHOT_TTL_MS` | `750` | Snapshot cache TTL in long-lived hosts. |
| `NVIM_AWARE_PROMPT_TIMEOUT_MS` | `800` | Refresh timeout for prompt-time snapshots. |
| `NVIM_AWARE_DISABLE` | _(unset)_ | Any truthy value disables all context injection. |

Under `auto`, a prompt that does not reach for the editor injects nothing. Pi used to
inject on every turn regardless; if you prefer that, set
`NVIM_AWARE_PROMPT_CONTEXT=full`. The `/nvim` command and the `nvim_context` tool keep
working in every mode — an explicit request is not automatic injection.

Host-specific: `NVIM_AWARE_AUTO_PLUGIN_DIR=0` / `NVIM_AWARE_AUTO_EXTENSION=0` stop the
launchers auto-loading the plugin/extension (for global installs);
`NVIM_AWARE_REAL_CLAUDE` / `NVIM_AWARE_REAL_PI` pin the real binary if the wrapper
cannot find it on `PATH`.

## Architecture

```
core/                     single source of truth (plain ESM, zero runtime deps)
  transport.mjs           the seam: everything that spawns or touches the filesystem
  discovery.mjs           which instance? env -> serverlist() -> socket scan; cwd matching
  snapshot-lua.mjs        the Lua evaluated inside Neovim
  snapshot.mjs            the snapshot contract: build a request, parse and normalize
  session.mjs             a connection: resolution, caching, invalidation, stale fallback
  injection.mjs           whether a turn gets editor state, and how much
  config.mjs              the environment, read as a value
  format.mjs              compact / full snapshot rendering
  launcher.mjs            generic "launch a CLI pre-connected to Neovim" engine
  proc.mjs                process exec, timeouts, bounded concurrency, small utils

hosts/claude/             the Claude Code plugin (self-contained)
  hooks/  mcp/  commands/ bin/   host glue: hooks, MCP server, /nvim, launcher config
  core/                   GENERATED — vendored copy of core/

hosts/pi/                 the Pi integration
  bin/pi-nvim             thin launcher config (imports ../../core)
  extensions/…pi.ts       thin extension source (imports ../../core)
  dist/                   GENERATED — single-file bundles for distribution

scripts/build.mjs         materializes core into the host artifacts
test/                     node:test suite, no dependencies
```

Hosts do not assemble these themselves. They open a **session** and ask it for a
snapshot, and ask **injection** whether this turn warrants one. Both hosts obey the same
decision, so `NVIM_AWARE_PROMPT_CONTEXT` and `NVIM_AWARE_DISABLE` behave identically
under Claude Code and Pi.

Everything that spawns a process or reads the filesystem goes through the transport, so
the rest of `core/` is exercisable without a running editor.

Both hosts require **self-contained artifacts**: a Claude marketplace install copies
only `hosts/claude/`, and the Pi extension supports single-file copy-install. The build
step therefore vendors `core/` into `hosts/claude/core/` and bundles the Pi files into
`hosts/pi/dist/`. **Generated output is committed**, so installs never need a toolchain.

## Developing

Edit `core/` or the host sources, then regenerate the artifacts:

```bash
npm run build     # or: node scripts/build.mjs
npm run check     # exit 1 if committed artifacts are out of sync (for CI / pre-commit)
npm test          # the drift check, then the test suite
```

`npm test` runs `--check` first on purpose: the Claude host executes the *vendored* copy
under `hosts/claude/core/`, so a forgotten rebuild means debugging code you did not edit.

Bundling needs an `esbuild` binary, resolved from `$ESBUILD`, `node_modules/.bin`
(`npm install`), `tools/esbuild` (drop a standalone binary there), or `PATH`.

Never edit `hosts/claude/core/` or `hosts/pi/dist/` by hand — they carry a
`GENERATED FILE` banner and are overwritten by the build.

## Requirements

- Neovim ≥ 0.5 with a listening server (default for normal sessions, or `nvim --listen`).
- Node.js ≥ 18 and `nvim` on `PATH`.

## License

MIT
