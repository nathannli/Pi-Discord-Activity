# pi-discord-presence (Pi-Bolt build)

> **Discord Rich Presence for Pi-Bolt.** It shows what the
> agent is doing on your behalf, live.

This is a Pi-Bolt–specific fork of
[gwynnnplaine/pi-discord-presence](https://github.com/gwynnnplaine/pi-discord-presence).

## Why this fork exists

Upstream talks to Discord through `@xhayper/discord-rpc`. Its dependency
`@vladfrangu/async_event_emitter` bundles `node-inspect-extracted`, which throws
at module load under Pi-Bolt's runtime (Bun, JIT off, jiti loader):

```
Error: Failed to load extension ".../pi-discord-presence/index.ts":
Failed to load extension: Attempted to assign to readonly property.
```

The same import works under plain `node`/`bun`, so the failure is specific to
Pi-Bolt. This fork replaces `src/transport.ts` with a zero-dependency client that
speaks Discord's local IPC protocol directly over `node:net`. Everything else is
upstream code, unchanged apart from the transport factory name.

Side effects of the rewrite:

- **No runtime dependencies** — nothing to `npm install`.
- **No helper process** — unlike the older `pi-discord-activity`, nothing is
  spawned, so no orphaned/zombie helpers are left behind.

Tested on Pi-Bolt 0.7.0 (pi 1.0.3, darwin-arm64). Stock pi with a Node runtime
should also work, but use upstream there.

## What it shows

`Editing foo.tsx` · `Running: git` · `Searching the codebase` · `Thinking…` ·
`Idle in dotfiles` — with the project, the model, and a session-elapsed timer.

| Pi activity                    | Shows as                  |
| ------------------------------ | ------------------------- |
| `edit` / `write` a file        | `Editing foo.tsx`         |
| `read` a file                  | `Reading foo.tsx`         |
| `grep` / `glob` / search       | `Searching the codebase`  |
| `web_search` / `fetch`         | `Browsing the web`        |
| `bash`                         | `Running: <first token>`  |
| any other tool                 | `Running <toolName>`      |
| generating a response          | `Thinking…`               |
| waiting for you                | `Idle in <project>`       |

The second line is `project · model`. The large image is the PI logo; the small
badge is the file's language icon.

## Install (Pi-Bolt)

Clone into Pi-Bolt's global extension directory, which is auto-discovered:

```bash
git clone git@github.com:nathannli/Pi-Discord-Activity.git \
  ~/.pi/agent/extensions/pi-discord-presence
```

Or try it for one session without installing:

```bash
pi-bolt -e /absolute/path/to/Pi-Discord-Activity/index.ts
```

If you previously installed upstream, remove `npm:@gwynnnplaine/pi-discord-presence`
from the `packages` list in `~/.pi/agent/settings.json`; otherwise Pi-Bolt keeps
failing to start with the error above.

## Discord app

Works out of the box against the default **Pi** application
(`defaults.json`). To use your own name and art, create a Discord application
and set its client ID in the config below.

## Config

Global `~/.pi/agent/discord-presence.json`:

```json
{ "enabled": true, "clientId": "1520833162148712580" }
```

Per-project `<repo>/.pi/discord-presence.json` (honored only when the project is
trusted) — silence a sensitive repo:

```json
{ "enabled": false }
```

Runtime: `/presence on`, `/presence off`, `/presence status`
(session-only). Precedence: **runtime > project > global**.

## Behavior

- **Active only in interactive TUI mode** (not `-p` / json one-shot runs).
- **Rate limit**: Discord caps presence at ~1 update / 15s. Updates are
  coalesced to the latest state with a trailing flush.
- **Privacy**: on by default; filenames + project name are broadcast. Disable
  globally, per-project, or at runtime. No filename ever leaks from `bash` args
  (only the first token is shown).
- **Multiple Pi sessions** share one Discord slot — last writer wins.
- **Discord not running**: connection fails silently and is retried lazily.

## Layout

```
index.ts            re-exports the entry
src/result.ts       Result / ok / err
src/types.ts        branded types, Activity union, configs, errors, constructors
src/language.ts     extension → language-icon map
src/activity.ts     event reducer (reduce / toActivity / classifyTool)
src/render.ts       Activity → PresenceCard → wire payload
src/config.ts       parse + load config, resolveEnablement
src/scheduler.ts    Clock + coalesce/trailing-flush rate limiter
src/transport.ts    DiscordTransport seam + direct Discord IPC client (fork change)
src/link.ts         connection state machine + lazy reconnect
src/extension.ts    wires Pi events → reducer → scheduler
```

## License

MIT — original work © gwynnnplaine. See [LICENSE](LICENSE).
