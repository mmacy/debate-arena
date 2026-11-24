# Debate Arena

A Copilot CLI extension that opens a native desktop window where two models
from Ollama, Anthropic, Mistral, OpenAI, Microsoft Foundry, or Google Gemini
debate each other, judged by a third. Each participant can use a different provider. The
judge declares a winner and explains the decision, and the whole match can be
saved as Markdown with YAML front matter.

Ollama works without credentials. Hosted providers are enabled by setting their
API key in the environment before launching Copilot CLI.

## Requirements

- At least one provider: [Ollama](https://ollama.com) with a pulled model or
  credentials for one of the hosted providers.
- Node.js (provided by the Copilot CLI runtime).

## Usage

1. From Copilot CLI, run the slash command **`/debates`** (or ask the agent to
   call the `debates_show` tool) to open the window.
2. Enter a **resolution**, choose **Pro**, **Con**, and **Judge** models, and set
   the number of **rebuttal rounds** (1–3).
3. Click **Start Debate**. Each turn streams in token-by-token:
   Opening Statements → Rebuttals → Closing Statements → Verdict.
4. When the judge finishes, a glowing **🏆 Winner** pill appears next to the
   winning model. Click **Save to file** to write the debate to
   `debates/<name>.md` in the current working directory, or **Copy** to copy the
   full debate Markdown to the clipboard.

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
providers:
  pro: "ollama" | "anthropic" | "mistral" | "openai" | "foundry" | "google"
  con: "ollama" | "anthropic" | "mistral" | "openai" | "foundry" | "google"
  judge: "ollama" | "anthropic" | "mistral" | "openai" | "foundry" | "google"
rounds: <n>
winner: "pro" | "con" | "draw"
winner_label: "<human-readable winner>"
duration_seconds: <n>
generator: "Debate Arena"
---
```

…followed by the full transcript and the judge's decision.

## How it works

- `main.mjs` — extension glue. Registers the `/debates` slash command and the
  `debates_show` / `debates_eval` / `debates_close` tools, and implements the
  page callbacks (`listModels`, `startDebate`, `stopDebate`, `saveDebate`,
  `copyDebate`). It uses the shared provider runtime to stream tokens into the
  page via `window.debateUI.*`. **Copy** writes to the OS clipboard from the
  extension (`pbcopy`/`clip`/`xclip`/`wl-copy`) rather than the webview's
  gesture-gated in-page clipboard API, which is unreliable in WKWebView.
- `content/` — the webview UI (vanilla HTML/CSS/JS, Discord-inspired dark theme).
- `lib/` — the reusable `copilot-webview` host library (do not edit).

To apply changes: edit `content/` then call `debates_show` with `reload: true`,
or run `extensions_reload` for changes to `main.mjs`.

## Provider configuration

| Provider | Required variable | Optional endpoint |
| --- | --- | --- |
| Ollama | _(none)_ | `OLLAMA_HOST` |
| Anthropic | `ANTHROPIC_API_KEY`, or an `ant auth login` profile | `ANTHROPIC_BASE_URL` |
| Mistral | `MISTRAL_API_KEY` | `MISTRAL_BASE_URL` |
| OpenAI | `OPENAI_API_KEY` | `OPENAI_BASE_URL` |
| Microsoft Foundry | `AZURE_FOUNDRY_ENDPOINT`; API key optional | `AZURE_FOUNDRY_RESOURCE_ID`, `AZURE_FOUNDRY_DEPLOYMENTS` |
| Google Gemini API | `GEMINI_API_KEY` or `GOOGLE_API_KEY` | — |
| Google Vertex AI | `GOOGLE_CLOUD_PROJECT`; ADC configured | `GOOGLE_CLOUD_LOCATION` |

`DEBATE_MAX_TOKENS` optionally changes the 4,096-token per-turn limit. Hosted
providers receive the resolution and debate history for each turn; use only
Ollama when the content must remain local. Without `AZURE_INFERENCE_CREDENTIAL`,
Microsoft Foundry uses `DefaultAzureCredential`, which includes Azure CLI
authentication from an existing `az login` session. Deployment discovery uses
Azure Resource Manager and lists successful deployments from the matching
resource. For identities without resource-reader access, set
`AZURE_FOUNDRY_DEPLOYMENTS` to a comma-separated allowlist.

For Google Workspace/Cloud projects, run `gcloud auth application-default login`,
enable `aiplatform.googleapis.com`, and launch Copilot CLI with
`GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION=global`. Alternatively, use a
Google AI Studio `GEMINI_API_KEY`.
