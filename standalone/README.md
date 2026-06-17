# Debate Arena — standalone

The same Debate Arena, without the Copilot CLI. This is a small, **dependency-free**
local web app: a plain Node server pits two [Ollama](https://ollama.com) models
against each other in a structured, judged debate, streamed live to your browser.

It lives alongside the [Copilot CLI extension](../.github/extensions/debates/) and
shares its debate logic and saved-file format — it just swaps the native-window
bridge for a browser + HTTP/SSE.

## Requirements

- [Node.js](https://nodejs.org) 18 or newer (uses the built-in `fetch`; **no `npm install` needed**).
- [Ollama](https://ollama.com) running locally with at least one model pulled
  (e.g. `ollama pull llama3.2` — any installed model works).

## Run it

From this directory:

```bash
node server.mjs
```

The server prints its URL (default <http://127.0.0.1:4757>) and tries to open
your browser automatically. Then:

1. Enter a **resolution**.
2. Pick a model for the **Pro** corner, the **Con** corner, and the **presiding judge**.
3. Choose the number of **rebuttal rounds** (1–3) and click **Start debate**.

Each turn streams in token by token — opening statements, rebuttals, closing
statements — and the judge declares a winner and explains the verdict. When it
finishes, **Save transcript** writes a Markdown file to `debates/` in the
directory you launched from, or **Copy Markdown** puts the whole thing on your
clipboard.

## Configuration

All optional, via environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama base URL. Point it at a remote/LAN server to use that instead — your topic and transcript are then sent there. |
| `DEBATE_PORT` | `4757` | Preferred port. If it's taken, the server steps forward to the next free one. |
| `DEBATE_SAVE_DIR` | current directory | Where the `debates/` folder is created. |
| `NO_OPEN` | _(unset)_ | Set to anything to skip auto-opening the browser. |

```bash
OLLAMA_HOST=http://192.168.1.50:11434 DEBATE_PORT=8080 node server.mjs
```

## How it works

- `server.mjs` — a zero-dependency Node HTTP server. It serves the UI from
  `public/`, exposes the debate engine over two endpoints, and talks to Ollama
  server-side (so there are no CORS hoops):
  - `POST /api/rpc` — request/reply calls (`listModels`, `startDebate`,
    `stopDebate`, `saveDebate`, `copyDebate`). This is the page's
    `window.copilot.<method>(...)` shim on the wire.
  - `GET /api/events` — a Server-Sent Events stream the server pushes turn-by-turn
    updates over, dispatched in the page to `window.debateUI.<fn>(...)`.
- `public/` — the browser UI (vanilla HTML/CSS/JS). The argument prose is set in
  a reading serif; the two corners and the judge get their own colours and sides.

Fonts are loaded from Google Fonts with local fallbacks; the debate content
itself never leaves your machine (only Ollama is contacted, server-side).

## Saved file format

Identical to the extension: Markdown with a YAML front-matter block (topic,
models, winner, duration, …) followed by the full transcript and the judge's
decision. See the [extension README](../.github/extensions/debates/README.md#saved-file-format).
