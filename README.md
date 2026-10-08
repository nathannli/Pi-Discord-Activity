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

```bash
pi-bolt install git:github.com/nathannli/Pi-Discord-Activity
# or, project-local only:
pi-bolt install git:github.com/nathannli/Pi-Discord-Activity -l
```

Update later with `pi-bolt update git:github.com/nathannli/Pi-Discord-Activity`.
Remove with
`pi-bolt remove git:github.com/nathannli/Pi-Discord-Activity`.

Or try it for one session without installing:

```bash
git clone https://github.com/nathannli/Pi-Discord-Activity.git
pi-bolt -e "$PWD/Pi-Discord-Activity/index.ts"
```

If you previously installed upstream, remove `npm:@gwynnnplaine/pi-discord-presence`
from the `packages` list in `~/.pi/agent/settings.json`; otherwise Pi-Bolt keeps
failing to start with the error above.

## Discord app

Works out of the box against the default **Pi** application
(`defaults.json`). Discord takes the displayed activity name from the application
associated with the client ID, not from the local activity text.

To display **Pi-Bolt**, use the Pi-Bolt application ID shown in the global config
below. This configuration has been verified with Discord desktop running.
Restart Pi-Bolt after changing the config.

To use your own application name and art:

1. Open the [Discord Developer Portal](https://discord.com/developers/applications).
2. Select **New Application**, name it **Pi-Bolt** (or your preferred name), and create it.
3. Under **General Information**, copy the **Application ID** and use it as `clientId`.
4. Under **Rich Presence → Art Assets**, upload a logo named **`pi_logo`** and save changes.
5. Restart Pi-Bolt with Discord desktop running. New art assets may take time to appear.

No bot or server invite is required. The Application ID is public; do not use a
bot token or client secret.

## Config

Global `~/.pi/agent/discord-presence.json`:

```json
{ "enabled": true, "clientId": "1557577584110215258" }
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
