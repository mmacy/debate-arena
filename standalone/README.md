# Debate Arena — standalone

The same Debate Arena, without the Copilot CLI. A small local web app pits models
from [Ollama](https://ollama.com), Anthropic, Mistral, OpenAI, Microsoft
Foundry, or Google Gemini against each other in a structured, judged debate,
streamed live to your browser.

It lives alongside the [Copilot CLI extension](../.github/extensions/debates/) and
shares its debate logic and saved-file format — it just swaps the native-window
bridge for a browser + HTTP/SSE.

## Requirements

- [Node.js](https://nodejs.org) 18 or newer.
- At least one provider: a running Ollama server with a pulled model, or one or
  more hosted-provider API keys.

## Run it

From this directory:

```bash
npm install
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
| `ANTHROPIC_API_KEY` | _(unset)_ | Enables Anthropic model discovery and generation. Not needed if you have signed in with `ant auth login`; the SDK reads that profile automatically. |
| `ANTHROPIC_BASE_URL` | Anthropic default | Optional Anthropic-compatible endpoint override. |
| `MISTRAL_API_KEY` | _(unset)_ | Enables Mistral model discovery and generation. |
| `MISTRAL_BASE_URL` | Mistral default | Optional Mistral endpoint override. |
| `OPENAI_API_KEY` | _(unset)_ | Enables OpenAI model discovery and generation. |
| `OPENAI_BASE_URL` | OpenAI default | Optional OpenAI endpoint override. |
| `AZURE_INFERENCE_CREDENTIAL` | _(unset)_ | Optional Foundry API key. When omitted, `DefaultAzureCredential` is used. |
| `AZURE_FOUNDRY_ENDPOINT` | _(unset)_ | Microsoft Foundry resource endpoint; `/openai/v1/` is appended when omitted. |
| `AZURE_FOUNDRY_RESOURCE_ID` | _(unset)_ | Full ARM resource ID. Speeds up deployment discovery when the endpoint is ambiguous. |
| `AZURE_FOUNDRY_DEPLOYMENTS` | _(unset)_ | Comma-separated deployment allowlist for key-only or restricted environments. |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | _(unset)_ | Enables Gemini through the Gemini Developer API. |
| `GOOGLE_CLOUD_PROJECT` | _(unset)_ | Enables Gemini through Vertex AI using Application Default Credentials. |
| `GOOGLE_CLOUD_LOCATION` | `global` | Vertex AI location. |
| `GOOGLE_GENAI_USE_VERTEXAI` | _(unset)_ | Force Vertex AI even when an API key is also present. |
| `DEBATE_MAX_TOKENS` | `4096` | Maximum output tokens per turn, bounded from 256–16,384. |
| `DEBATE_PORT` | `4757` | Preferred port. If it's taken, the server steps forward to the next free one. |
| `DEBATE_SAVE_DIR` | current directory | Where the `debates/` folder is created. |
| `NO_OPEN` | _(unset)_ | Set to anything to skip auto-opening the browser. |

```bash
ANTHROPIC_API_KEY=... OPENAI_API_KEY=... DEBATE_PORT=8080 npm start
```

For Microsoft Foundry, set the resource endpoint and its inference key:

```bash
AZURE_FOUNDRY_ENDPOINT=https://<resource>.openai.azure.com \
  npm start
```

`AZURE_OPENAI_ENDPOINT` and `AZURE_INFERENCE_ENDPOINT` are accepted as endpoint
aliases, and `AZURE_OPENAI_API_KEY` is accepted as a credential alias. Without a
key, `DefaultAzureCredential` attempts the standard Azure identity chain,
including an existing `az login` session. Debate Arena queries Azure Resource
Manager and shows only successful deployments from the matching Foundry
resource:

```bash
az login
AZURE_FOUNDRY_ENDPOINT=https://<resource>.openai.azure.com npm start
```

If the Azure identity can invoke models but cannot read the resource through
Azure Resource Manager, specify the deployment names explicitly:

```bash
AZURE_FOUNDRY_ENDPOINT=https://<resource>.openai.azure.com \
AZURE_FOUNDRY_DEPLOYMENTS=gpt-5.4-mini,my-other-deployment npm start
```

## Google Gemini setup

The simplest option is the Gemini Developer API:

1. Open [Google AI Studio API keys](https://aistudio.google.com/apikey).
2. Create or select a project and create a key.
3. Launch Debate Arena with that key:

```bash
GEMINI_API_KEY=... npm start
```

For a Google Workspace or Google Cloud project, use Vertex AI instead:

1. Select or create a Google Cloud project and enable billing for it.
2. Enable the Vertex AI API:

   ```bash
   gcloud services enable aiplatform.googleapis.com --project=YOUR_PROJECT_ID
   ```

3. Create local Application Default Credentials:

   ```bash
   gcloud auth application-default login
   ```

4. Launch with the project:

   ```bash
   GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID \
   GOOGLE_CLOUD_LOCATION=global \
   npm start
   ```

Your Workspace login can be used if that identity has permission and the project
administrator has not restricted API access. A Google account or Workspace
membership alone is not an API credential; the app needs either an AI Studio key
or successful Vertex AI ADC. Debate Arena keeps the model list filtered to
Gemini models that support text generation.

## How it works

- `server.mjs` — a Node HTTP server. It serves the UI from
  `public/`, exposes the debate engine over two endpoints, and talks to Ollama
  or a configured hosted provider server-side (so there are no CORS hoops):
  - `POST /api/rpc` — request/reply calls (`listModels`, `startDebate`,
    `stopDebate`, `saveDebate`, `copyDebate`). This is the page's
    `window.copilot.<method>(...)` shim on the wire.
  - `GET /api/events` — a Server-Sent Events stream the server pushes turn-by-turn
    updates over, dispatched in the page to `window.debateUI.<fn>(...)`.
- `public/` — the browser UI (vanilla HTML/CSS/JS). The argument prose is set in
  a reading serif; the two corners and the judge get their own colours and sides.

Fonts are loaded from Google Fonts with local fallbacks. Debate prompts and
previous speeches are sent to whichever provider is selected; keep all three
participants on a local Ollama model when content must stay on your machine.

## Saved file format

Identical to the extension: Markdown with a YAML front-matter block (topic,
models, winner, duration, …) followed by the full transcript and the judge's
decision. See the [extension README](../.github/extensions/debates/README.md#saved-file-format).
