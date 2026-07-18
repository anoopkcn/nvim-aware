# nvim-aware-pi

A tiny wrapper + Pi extension for the workflow where Neovim is your editor and Pi is open
in a separate terminal/split.

It does **not** add prompts or UI inside Neovim. The wrapper only chooses a running
Neovim instance, starts Pi in that instance's cwd, and lets the extension expose the live
editor snapshot to the agent.

This is one host of the [nvim-aware](https://github.com/anoopkcn/nvim-aware) monorepo;
the shared implementation lives in the repo's `core/`. The `dist/` directory contains
generated single-file bundles for distribution (do not edit them; run the repo build).

## What Pi learns

When started through the wrapper, Pi gets Neovim context on turns whose prompt reaches
for the editor (see [Injection modes](#injection-modes) to change that). The extension
keeps a very short snapshot cache to avoid redundant `nvim --remote-expr` calls during
rapid turns, and falls back to the last known snapshot if Neovim is briefly slow or
unavailable:

- Neovim cwd
- current file
- cursor line/column and cursor line text
- active visual selection, or the last visual selection when available
- `/` search register
- quickfix list
- listed buffers
- visible windows

It also exposes a `nvim_context` tool so the model can force-refresh the snapshot if you
refer to "current file", "selection", "cursor", or "buffers". The `/nvim` command also
forces a fresh read and shows the full snapshot.

## Use locally

```bash
./bin/pi-nvim
```

The wrapper auto-loads the bundled extension (`dist/nvim-aware-pi.ts`), so this works
without installing the extension globally.

Pass normal Pi args after it:

```bash
./bin/pi-nvim --model sonnet:high
./bin/pi-nvim -p "Explain the code under my cursor"
```

## Install globally

```bash
mkdir -p ~/.local/bin
ln -sf "$PWD/bin/pi-nvim" ~/.local/bin/pi-nvim
```

Make sure `~/.local/bin` is on your `PATH`, then run:

```bash
pi-nvim
```

If you want a standalone install without the repo checkout, copy the **bundled** pair
from `dist/` instead (they are self-contained; the source files in `bin/` and
`extensions/` import the repo's `core/` and only work from a checkout):

```bash
cp dist/pi-nvim ~/.local/bin/pi-nvim
mkdir -p ~/.pi/agent/extensions
cp dist/nvim-aware-pi.ts ~/.pi/agent/extensions/nvim-aware-pi.ts
```

When the extension is installed globally, set `NVIM_AWARE_AUTO_EXTENSION=0` so the
wrapper does not load it twice.

## Keep typing `pi --nvim`

A wrapper cannot change Pi's cwd after Pi has already started. To keep the exact command
shape, add a shell function that intercepts `--nvim` before launching real Pi:

```bash
pi() {
  for arg in "$@"; do
    case "$arg" in
      --nvim|--nvim=*) pi-nvim "$@"; return ;;
    esac
  done
  command pi "$@"
}
```

Now this works without patching Pi core:

```bash
pi --nvim
```

## Multiple Neovim instances

If one Neovim instance is found, the wrapper uses it automatically.

If multiple are found in an interactive terminal, it asks which one to connect to.
Entries are labelled by directory name, full cwd, and current file. The selected Neovim
cwd becomes Pi's cwd before Pi starts, and the selected server is passed as
`--nvim-server` so the extension reads the same instance.

To bypass discovery/picking and take the fastest path, get the address in Neovim
(`:echo v:servername`), then:

```bash
pi-nvim --nvim-server /path/from/v:servername
```

You can also start Neovim with a stable address:

```bash
nvim --listen /tmp/nvim-main
pi-nvim --nvim-server /tmp/nvim-main
```

## Configuration

The env vars are shared with the other nvim-aware hosts.

| Variable | Default | Meaning |
|----------|---------|---------|
| `NVIM_AWARE_PROMPT_CONTEXT` | `auto` | How much state to inject per turn: `auto`, `full`, `hint`, or `off`. |
| `NVIM_AWARE_SERVER` | _(discovered)_ | Pin a specific Neovim server address; skips discovery. |
| `NVIM_AWARE_SNAPSHOT_TTL_MS` | `750` | Prompt-time snapshot cache TTL. |
| `NVIM_AWARE_PROMPT_TIMEOUT_MS` | `800` | Cached-refresh timeout for prompt-time snapshots. |
| `NVIM_AWARE_DISABLE` | _(unset)_ | Any truthy value disables injection and withdraws the tool. |
| `NVIM_AWARE_REAL_PI` | _(from `PATH`)_ | Path to the real Pi binary if the wrapper cannot find it. |
| `NVIM_AWARE_AUTO_EXTENSION` | _(unset)_ | Set to `0` to stop the wrapper auto-loading the bundled extension. |

### Injection modes

- **`auto`** (default) — inject a compact snapshot only when the prompt reaches for the
  editor ("this file", "the selection", "the quickfix list"). Neutral prompts cost nothing.
- **`full`** — inject a compact snapshot before every turn.
- **`hint`** — never inject state; just remind the agent that `nvim_context` exists.
- **`off`** — inject nothing.

Before 0.3.0 this extension ignored `NVIM_AWARE_PROMPT_CONTEXT` and always behaved as
`full`. Set `NVIM_AWARE_PROMPT_CONTEXT=full` to keep that behaviour. `/nvim` and the
`nvim_context` tool work in every mode — an explicit request is not automatic injection.

## Notes

- Requires `nvim` on `PATH`.
- No Pi core patch is required. The wrapper changes cwd before launching Pi.
- `--nvim-server` probes only the explicit server instead of discovering every instance.
- Normal startup first checks fast candidates from `NVIM`, `NVIM_LISTEN_ADDRESS`, and
  Neovim's `serverlist()`; filesystem socket scanning is only a fallback, and candidate
  probes run with bounded concurrency.
- This is intentionally simpler than Neovim-driven prompt plugins: Neovim stays just the
  editor; Pi remains the chat/agent UI.
