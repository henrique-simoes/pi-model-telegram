# pi-model-telegram

Manage [pi](https://github.com/earendil-works/pi) providers, models, and
thinking levels from a Telegram chat connected through
[pi-chat](https://github.com/earendil-works/pi-chat).

pi-chat bridges Telegram to a pi session, but its in-chat vocabulary is only
`stop`, `new`, `compact`, and `status`. Provider authentication and model
selection stay in pi's terminal UI. This extension brings them to the chat.

## Commands

| Command | Effect |
|---------|--------|
| `/model [filter]` | List models and switch to one |
| `/thinking` | List thinking levels and set one |
| `/login [filter]` | Authenticate a provider with an API key |
| `/logout <provider>` | Remove a stored provider credential |
| `/endpoint` | Add a custom OpenAI-compatible endpoint |
| `/providers` | Show providers and whether each is authenticated |
| `/whichmodel` | Show the active model and thinking level |
| `/help` | List these commands |

Lists are numbered; reply with a number to choose. Send `cancel` to abort.
`stop`, `new`, `compact`, and `status` are left to pi-chat and are never
intercepted.

## How it works

pi-chat delivers each inbound chat message with `pi.sendUserMessage()`, which
raises pi's `input` event with `source: "extension"`. Pi's documented lifecycle
evaluates that event *before* the model runs, and a handler may return
`{ action: "handled" }` to answer without an LLM turn.

That ordering is what makes `/login` possible. With an empty `auth.json` no
model can run, so no tool call or agent reply could ever happen — a tool-based
design would be unreachable exactly when you need it most.

A registered tool is not an option either: pi-chat blocks every tool outside
`read`, `write`, `edit`, `bash`, `chat_history`, `chat_attach`, and
`chat_request_secret` during a remote turn. Intercepting `input` is the only
mechanism available to a chat-facing extension.

Because a handled input produces no assistant message, pi-chat has nothing to
deliver, so this extension sends its replies directly to the Telegram Bot API
using the token pi-chat already stores. It only *sends*; pi-chat keeps sole
ownership of receiving, so there is no `getUpdates` conflict.

Outside a pi-chat Telegram worker the extension is completely inert. It detects
the worker's `--chat-conversation` flag and returns immediately when absent, so
it never shadows pi's own `/login` and `/model` in the terminal.

## Requirements

- pi with the pi-chat extension loaded
- A configured Telegram account and channel in pi-chat
- The worker started by `/chat-spawn-all` (it passes `--chat-conversation`)

## Install

```bash
pi install git:github.com/henrique-simoes/pi-model-telegram@v0.3.0
```

Any pi package source works:

```bash
pi install git:github.com/henrique-simoes/pi-model-telegram   # track default branch
pi install /absolute/path/to/pi-model-telegram                # local checkout
pi -e git:github.com/henrique-simoes/pi-model-telegram        # try without installing
```

Installing writes the source to `~/.pi/agent/settings.json`. Restart the
pi-chat workers so they load it:

```
/chat-spawn-all --restart
```

You can also drop `extensions/pi-model-telegram.ts` into
`~/.pi/agent/extensions/` for auto-discovery, which is useful while the
repository is private and the container has no credentials for it.

## Update

```bash
pi update --extensions     # update packages and reconcile pinned git refs
pi update --all            # also update pi itself
```

Pinned refs (`@v0.3.0`) are reconciled but not advanced. To move to a new
release, install the new ref explicitly.

## Before a provider is authenticated

pi-chat cannot complete a turn without a model: it sets an internal
`chatTurnInFlight` flag when it dispatches and clears it only from `agent_end`,
which never fires when no model exists. Left alone, the channel accepts exactly
one message and then ignores everything after it - this happens with or without
this extension.

While no provider is authenticated, each handled command therefore triggers a
`/chat-new` session reset so pi-chat can dispatch again. That reset reconnects
the same conversation but takes a few seconds, so **allow roughly half a minute
between commands until you have authenticated a provider and picked a model.**
Once a model is active, turns run normally, the reset stops, and commands are
immediate.

## Security

`/login` accepts an API key as a chat message. That key travels through
Telegram and is written to the channel's local pi-chat log. The extension
deletes your message when Telegram permits it, but treat any key sent this way
as exposed and prefer `/login` in pi's terminal session for first-time setup.

Keys are written to `~/.pi/agent/auth.json` with mode `0600` in pi's documented
format. A key beginning with `$` or `!` is escaped so pi stores it literally
rather than interpolating an environment variable or executing a command.

Subscription and OAuth sign-in are not offered over chat; those flows need a
browser and belong in the terminal.

## Development

```bash
npm install
npm run typecheck
npm test
```

## License

MIT
