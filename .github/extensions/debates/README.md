# Debate Arena

A Copilot CLI extension that opens a native desktop window where **two local
[Ollama](https://ollama.com) models debate each other**, judged by a third.
Pick a model for the Pro debater, the Con debater, and the Judge, give them a
resolution, and watch the match stream in live. The judge declares a winner and
explains the decision; you can then save the whole thing to a Markdown file with
YAML front matter.

Everything runs **locally** through Ollama — nothing leaves your machine.

## Requirements

- [Ollama](https://ollama.com) running locally with at least one model pulled
  (`ollama pull qwen3.5`, etc.). The extension talks to `http://127.0.0.1:11434`
  by default; override with the `OLLAMA_HOST` environment variable.
- Node.js (provided by the Copilot CLI runtime).

## Usage

1. From Copilot CLI, run the slash command **`/debates`** (or ask the agent to
   call the `debates_show` tool) to open the window.
2. Enter a **resolution**, choose **Pro**, **Con**, and **Judge** models, and set
   the number of **rebuttal rounds** (1–3).
3. Click **Start Debate**. Each turn streams in token-by-token:
   Opening Statements → Rebuttals → Closing Statements → Verdict.
4. When the judge finishes, a winner banner appears. Click **Save to file** to
   write the debate to `debates/<name>.md` in the current working directory.

## Saved file format

Saved debates are Markdown with a YAML front-matter metadata block:

```yaml
---
title: "Debate: <topic>"
topic: "<topic>"
date: "<ISO timestamp>"
debaters:
  pro: "<model>"
  con: "<model>"
judge: "<model>"
rounds: <n>
winner: "pro" | "con" | "draw"
winner_label: "<human-readable winner>"
duration_seconds: <n>
generator: "Debate Arena (Ollama)"
---
```

…followed by the full transcript and the judge's decision.

## How it works

- `main.mjs` — extension glue. Registers the `/debates` slash command and the
  `debates_show` / `debates_eval` / `debates_close` tools, and implements the
  page callbacks (`listModels`, `startDebate`, `stopDebate`, `saveDebate`).
  It streams Ollama `/api/chat` tokens and pushes them into the page via
  `window.debateUI.*`.
- `content/` — the webview UI (vanilla HTML/CSS/JS, Discord-inspired dark theme).
- `lib/` — the reusable `copilot-webview` host library (do not edit).

To apply changes: edit `content/` then call `debates_show` with `reload: true`,
or run `extensions_reload` for changes to `main.mjs`.
