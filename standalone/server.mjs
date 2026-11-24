// Debate Arena — standalone server.
//
// A local app that pits models from supported providers against each other in a
// structured, judged debate. It mirrors the Copilot CLI extension's behaviour
// (same orchestration, same Markdown output) but runs on its own: a plain Node
// HTTP server serves the UI and exposes the same callbacks the page expects.
//
// Transport: where the extension used a native WebView + WebSocket bridge, this
// uses the two primitives every browser already has — `fetch` for request/reply
// RPC (POST /api/rpc) and Server-Sent Events for the streaming push channel
// (GET /api/events). That keeps the page's `window.copilot.*` / `window.debateUI.*`
// contract intact.
//
// Run it with `node server.mjs` (Node 18+). Configure via env:
//   OLLAMA_HOST      Ollama base URL (default http://127.0.0.1:11434)
//   AZURE_FOUNDRY_ENDPOINT (uses DefaultAzureCredential unless a key is set)
//   ANTHROPIC_API_KEY (or an `ant auth login` profile) / MISTRAL_API_KEY / OPENAI_API_KEY
//   DEBATE_PORT      preferred port (default 4757; falls forward if taken)
//   DEBATE_SAVE_DIR  where to write debates/ (default: current directory)
//   NO_OPEN          set to anything to skip auto-opening the browser

import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import { DefaultAzureCredential, getBearerTokenProvider } from "@azure/identity";
import { GoogleGenAI } from "@google/genai";
import { Mistral } from "@mistralai/mistralai";
import OpenAI from "openai";
import { createProviderRuntime } from "../shared/providers.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");
const PORT = Number(process.env.DEBATE_PORT) || 4757;
const SAVE_ROOT = process.env.DEBATE_SAVE_DIR ? resolve(process.env.DEBATE_SAVE_DIR) : process.cwd();

let activeAbort = null;
let runToken = 0;
const modelRuntime = createProviderRuntime({
    Anthropic,
    Mistral,
    OpenAI,
    GoogleGenAI,
    DefaultAzureCredential,
    getBearerTokenProvider,
});

// ---------------------------------------------------------------------------
// SSE push channel. Every connected page gets one open response; `push` fans a
// `window.debateUI.<fn>(...args)` call out to all of them. Fire-and-forget — a
// closed socket never aborts a run.
// ---------------------------------------------------------------------------
const clients = new Set();

function broadcast(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
        try {
            res.write(frame);
        } catch {
            /* socket gone — drop it on its own 'close' handler */
        }
    }
}

// Matches the extension's `push(fn, ...args)` signature so the orchestration
// code below can be lifted almost verbatim. Async for call-site symmetry.
async function push(fn, ...args) {
    broadcast("push", { fn, args });
}

function log(msg) {
    process.stdout.write(`${msg}\n`);
}

async function listModels() {
    return modelRuntime.listModels();
}

async function streamChat({ model, messages, signal, onDelta }) {
    return modelRuntime.streamChat({ model, messages, signal, onDelta });
}

// ---------------------------------------------------------------------------
// One spoken turn: announces a message card, streams the model's reply into
// it (coalescing tokens onto a ~40ms flush), and records it in the transcript.
// ---------------------------------------------------------------------------
async function speak({ id, role, side, name, model, phase, system, history, signal, push: pushFn = push }) {
    const selection = modelRuntime.resolveModel(model);
    await pushFn("beginMessage", { id, role, side, name, model: selection.label, phase });

    let pending = "";
    let lastFlush = 0;
    const flush = async (force) => {
        const now = Date.now();
        if (pending && (force || now - lastFlush >= 40)) {
            const delta = pending;
            pending = "";
            lastFlush = now;
            await pushFn("appendMessage", id, delta);
        }
    };

    // For debaters, hold back the start of the stream until it is clear
    // whether it opens with a label line, and drop the label if it does.
    // "check": looking for a label; "trim": label dropped, skipping the
    // whitespace after it; "done": streaming normally.
    let startState = role === "debater" ? "check" : "done";

    const messages = [{ role: "system", content: system }, ...history];
    let text;
    try {
        text = await streamChat({
            model,
            messages,
            signal,
            onDelta: async (piece) => {
                pending += piece;
                if (startState !== "done") {
                    pending = pending.trimStart();
                    if (!pending) return;
                    if (startState === "check" && pending.startsWith("[")) {
                        const label = pending.match(LEADING_LABEL);
                        // Keep buffering while a label line may still be arriving.
                        if (!label && !pending.includes("\n") && pending.length <= MAX_LABEL_LENGTH) return;
                        if (label) {
                            pending = pending.slice(label[0].length).trimStart();
                            if (!pending) {
                                startState = "trim";
                                return;
                            }
                        }
                    }
                    startState = "done";
                }
                await flush(false);
            },
        });
        if (role === "debater") text = text.replace(LEADING_LABEL, "").trimStart();
        await flush(true);
    } catch (e) {
        await flush(true);
        if (signal.aborted) {
            await pushFn("cancelMessage", id);
        } else {
            await pushFn("errorMessage", id, e.message);
        }
        throw e;
    }
    await pushFn("endMessage", id);
    return text;
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------
function debaterSystem(side, topic) {
    const stance = side === "pro" ? "in FAVOR of" : "AGAINST";
    const persona = side === "pro" ? "the Affirmative (Pro)" : "the Negative (Con)";
    const other = side === "pro" ? "the Con side" : "the Pro side";
    return [
        `You are a sharp, persuasive competitive debater arguing ${persona}.`,
        `The resolution under debate is: "${topic}".`,
        `You must argue ${stance} this resolution at all times — never concede the other side.`,
        `Be substantive: make clear claims, support them with reasoning and concrete examples,`,
        `and stay civil but forceful.`,
        `Speak in the first person. When you refer to the other debater, call them "my opponent" or "${other}", never "your opponent".`,
        `Write in direct prose and keep each turn focused — roughly 150-250 words.`,
        `Do not break character, do not address the judge directly, and do not narrate stage directions.`,
    ].join(" ");
}

function judgeSystem(topic) {
    return [
        `You are an impartial, expert debate judge evaluating a formal debate on the resolution: "${topic}".`,
        `Two debaters argued: PRO (Affirmative, in favor) and CON (Negative, against).`,
        `Judge them on argument quality, use of evidence and reasoning, persuasiveness, and how well`,
        `each rebutted the other — not on your personal opinion of the topic.`,
        `Your response MUST begin with a single line in exactly this format: "WINNER: PRO", "WINNER: CON", or "WINNER: DRAW".`,
        `After that line, write a thorough, well-structured explanation (Markdown allowed) of your decision,`,
        `citing specific moments and arguments from each side and explaining what tipped the balance.`,
    ].join(" ");
}

// Build a debater's conversation history from the transcript so far, ending
// with a request for the speech in `phase`. The debater's own speeches go back
// as bare assistant text, because a label on them teaches the model to open
// its next speech with one. Each own speech follows the request that produced
// it, so roles alternate and every history starts with a user message.
function historyFor(currentSide, transcript, phase) {
    const messages = [];
    let opponentHasSpoken = false;
    const request = (speech) => {
        const instruction = speechRequest(currentSide, speech, opponentHasSpoken);
        const last = messages.at(-1);
        if (last?.role === "user") last.content += `\n\n${instruction}`;
        else messages.push({ role: "user", content: instruction });
    };
    for (const t of transcript) {
        if (t.side === currentSide) {
            request(t.phase);
            messages.push({ role: "assistant", content: t.text });
        } else {
            const name = t.side === "pro" ? "Pro" : "Con";
            messages.push({ role: "user", content: `[${name}'s ${t.phase.toLowerCase()}]\n${t.text}` });
            opponentHasSpoken = true;
        }
    }
    request(phase);
    return messages;
}

// The request for one speech, which says what that phase of the debate calls
// for. Pro's opening is told that Con has not spoken, so it does not rebut
// arguments nobody has made.
function speechRequest(side, phase, opponentHasSpoken) {
    const other = side === "pro" ? "the Con side" : "the Pro side";
    let task;
    if (phase.startsWith("Opening")) {
        task = opponentHasSpoken
            ? `Present your own case. You may also respond to ${other}'s opening.`
            : `You speak first, and ${other} has not spoken yet. Present your own case, and do not respond to arguments that have not been made.`;
    } else if (phase.startsWith("Rebuttal")) {
        task = `Respond directly to the arguments ${other} has made so far, and reinforce your own case.`;
    } else {
        task = `Summarize why your side has won the debate, without introducing new arguments.`;
    }
    return `Deliver your ${phase.toLowerCase()} now. ${task} Respond with the speech only, with no heading or label.`;
}

// Some models still open a speech with a transcript-style label on its own
// line, such as "[Rebuttal — You (Pro · model)]". speak() strips it.
const MAX_LABEL_LENGTH = 200;
const LEADING_LABEL = new RegExp(`^\\[[^\\]\\n]{1,${MAX_LABEL_LENGTH}}\\][ \\t]*\\n`);

// Flat transcript for the judge.
function judgeTranscript(transcript) {
    return transcript.map((t) => `### ${t.phase} — ${t.label}\n${t.text}`).join("\n\n");
}

// ---------------------------------------------------------------------------
// startDebate: orchestrates the whole match and streams it to the page.
// config: { topic, proModel, conModel, judgeModel, rounds }
// Returns a structured result the page keeps for saving.
// ---------------------------------------------------------------------------
async function startDebate(config) {
    const topic = String(config?.topic || "").trim();
    if (!topic) throw new Error("Please enter a debate topic.");
    const proSelection = modelRuntime.resolveModel(config?.proModel);
    const conSelection = modelRuntime.resolveModel(config?.conModel);
    const judgeSelection = modelRuntime.resolveModel(config?.judgeModel);
    const rounds = Math.min(Math.max(parseInt(config?.rounds, 10) || 1, 1), 3);

    if (activeAbort) activeAbort.abort();
    const controller = new AbortController();
    activeAbort = controller;
    const signal = controller.signal;
    const myToken = ++runToken;
    // Suppress UI pushes from a superseded run so a stale debate can't write
    // into (or "finish") a newer one that started after a restart.
    const rpush = (...a) => (myToken === runToken ? push(...a) : Promise.resolve());

    const startedAt = new Date();
    const transcript = []; // { side, label, phase, text }
    let msgSeq = 0;
    const nextId = () => `m${++msgSeq}`;

    const proSys = debaterSystem("pro", topic);
    const conSys = debaterSystem("con", topic);
    const proLabel = `Pro · ${proSelection.label}`;
    const conLabel = `Con · ${conSelection.label}`;

    const turn = async (side, phase) => {
        const isPro = side === "pro";
        const text = await speak({
            id: nextId(),
            role: "debater",
            side,
            name: isPro ? "Pro" : "Con",
            model: isPro ? proSelection.ref : conSelection.ref,
            phase,
            system: isPro ? proSys : conSys,
            history: historyFor(side, transcript, phase),
            signal,
            push: rpush,
        });
        transcript.push({ side, label: isPro ? proLabel : conLabel, phase, text });
    };

    try {
        await rpush("debateStarted", {
            topic,
            proModel: proSelection.label,
            conModel: conSelection.label,
            judgeModel: judgeSelection.label,
            rounds,
            startedAt: startedAt.toISOString(),
        });

        // Opening statements
        await rpush("phase", "Opening Statements");
        await turn("pro", "Opening Statement");
        await turn("con", "Opening Statement");

        // Rebuttal rounds
        for (let r = 1; r <= rounds; r++) {
            const label = rounds > 1 ? `Rebuttal — Round ${r}` : "Rebuttal";
            await rpush("phase", label);
            await turn("pro", label);
            await turn("con", label);
        }

        // Closing statements
        await rpush("phase", "Closing Statements");
        await turn("pro", "Closing Statement");
        await turn("con", "Closing Statement");

        // Judge verdict
        await rpush("phase", "The Verdict");
        const judgeId = nextId();
        const verdictText = await speak({
            id: judgeId,
            role: "judge",
            side: "judge",
            name: "Judge",
            model: judgeSelection.ref,
            phase: "Verdict",
            system: judgeSystem(topic),
            history: [
                {
                    role: "user",
                    content: `Here is the full debate transcript. Render your verdict.\n\nRESOLUTION: "${topic}"\n\n${judgeTranscript(transcript)}`,
                },
            ],
            signal,
            push: rpush,
        });

        const { winner, winnerLabel } = parseWinner(verdictText, proLabel, conLabel);
        const finishedAt = new Date();
        const result = {
            topic,
            proModel: proSelection.model,
            proProvider: proSelection.provider,
            conModel: conSelection.model,
            conProvider: conSelection.provider,
            judgeModel: judgeSelection.model,
            judgeProvider: judgeSelection.provider,
            rounds,
            startedAt: startedAt.toISOString(),
            finishedAt: finishedAt.toISOString(),
            durationMs: finishedAt - startedAt,
            winner,
            winnerLabel,
            transcript,
            verdict: verdictText,
        };
        await rpush("debateFinished", { winner, winnerLabel });
        return result;
    } catch (e) {
        if (signal.aborted) {
            await rpush("debateCancelled");
            return { cancelled: true };
        }
        await rpush("debateError", e.message);
        throw e;
    } finally {
        if (activeAbort === controller) activeAbort = null;
    }
}

function parseWinner(verdict, proLabel, conLabel) {
    const m = verdict.match(/WINNER:\s*(PRO|CON|DRAW)/i);
    const tag = m ? m[1].toUpperCase() : "DRAW";
    if (tag === "PRO") return { winner: "pro", winnerLabel: proLabel };
    if (tag === "CON") return { winner: "con", winnerLabel: conLabel };
    return { winner: "draw", winnerLabel: "Draw" };
}

async function stopDebate() {
    if (activeAbort) {
        activeAbort.abort();
        activeAbort = null;
        return "stopped";
    }
    return "idle";
}

// ---------------------------------------------------------------------------
// saveDebate: writes a Markdown file with YAML front matter to <SAVE_ROOT>/debates/.
// payload is the result object from startDebate plus an optional `filename`.
// Returns the saved absolute path.
// ---------------------------------------------------------------------------
async function saveDebate(payload, filename) {
    if (!payload || !payload.transcript) throw new Error("Nothing to save yet — run a debate first.");

    const dir = join(SAVE_ROOT, "debates");
    await mkdir(dir, { recursive: true });

    const base = safeFileName(filename) || `${slug(payload.topic)}-${stamp(payload.finishedAt)}`;
    const name = base.toLowerCase().endsWith(".md") ? base : `${base}.md`;
    const path = join(dir, name);

    // Defense in depth: never let a crafted name escape the debates/ directory.
    if (resolve(path) !== path || !resolve(path).startsWith(resolve(dir) + sep)) {
        throw new Error("Invalid filename.");
    }

    await writeFile(path, renderMarkdown(payload), "utf8");
    log(`Saved debate to ${path}`);
    return path;
}

// copyDebate: return the rendered Markdown so the page can write it to the
// browser clipboard (a real user gesture makes navigator.clipboard reliable).
async function copyDebate(payload) {
    if (!payload || !payload.transcript) throw new Error("Nothing to copy yet — run a debate first.");
    return renderMarkdown(payload);
}

// Reduce a user-supplied filename to a single safe path segment (no directory
// traversal, no path separators, no leading dots). Returns "" if nothing usable.
function safeFileName(input) {
    if (!input) return "";
    const lastSegment = String(input).trim().replace(/\\/g, "/").split("/").pop() || "";
    const cleaned = lastSegment.replace(/[^A-Za-z0-9._ -]/g, "").replace(/^\.+/, "").trim();
    return cleaned === ".md" ? "" : cleaned;
}

function renderMarkdown(p) {
    // JSON double-quoted strings are valid YAML flow scalars and correctly
    // escape quotes, backslashes, newlines, and control characters.
    const yamlStr = (s) => JSON.stringify(String(s ?? ""));
    const fm = [
        "---",
        `title: ${yamlStr(`Debate: ${p.topic}`)}`,
        `topic: ${yamlStr(p.topic)}`,
        `date: ${yamlStr(p.finishedAt)}`,
        "debaters:",
        `  pro: ${yamlStr(p.proModel)}`,
        `  con: ${yamlStr(p.conModel)}`,
        `judge: ${yamlStr(p.judgeModel)}`,
        "providers:",
        `  pro: ${yamlStr(p.proProvider || "ollama")}`,
        `  con: ${yamlStr(p.conProvider || "ollama")}`,
        `  judge: ${yamlStr(p.judgeProvider || "ollama")}`,
        `rounds: ${p.rounds}`,
        `winner: ${yamlStr(p.winner)}`,
        `winner_label: ${yamlStr(p.winnerLabel)}`,
        `duration_seconds: ${Math.round((p.durationMs || 0) / 1000)}`,
        `generator: "Debate Arena"`,
        "---",
        "",
    ].join("\n");

    const winnerLine = p.winner === "draw" ? "**Result:** Draw" : `**Winner:** ${p.winnerLabel}`;

    const body = [
        `# Debate: ${p.topic}`,
        "",
        `> ${winnerLine}`,
        ">",
        `> Pro: \`${modelLabel(p.proProvider, p.proModel)}\` · Con: \`${modelLabel(p.conProvider, p.conModel)}\` · Judge: \`${modelLabel(p.judgeProvider, p.judgeModel)}\``,
        "",
        "## Transcript",
        "",
        ...p.transcript.map((t) => `### ${t.phase} — ${t.label}\n\n${t.text}\n`),
        "## Judge's Decision",
        "",
        p.verdict,
        "",
    ].join("\n");

    return fm + body;
}

function slug(s) {
    return (
        String(s)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 60) || "debate"
    );
}

function modelLabel(provider, model) {
    return modelRuntime.resolveModel(provider ? `${provider}:${model}` : model).label;
}

function stamp(iso) {
    const d = iso ? new Date(iso) : new Date();
    return d.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
}

// ---------------------------------------------------------------------------
// RPC: the page's `window.copilot.<method>(...args)` lands here as a POST.
// ---------------------------------------------------------------------------
const callbacks = { listModels, startDebate, stopDebate, saveDebate, copyDebate };

async function readJsonBody(req, limitBytes = 8 * 1024 * 1024) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
        total += chunk.length;
        if (total > limitBytes) throw new Error("Request body too large.");
        chunks.push(chunk);
    }
    if (!chunks.length) return {};
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function handleRpc(req, res) {
    let body;
    try {
        body = await readJsonBody(req);
    } catch (e) {
        return sendJson(res, 400, { error: `Bad request: ${e.message}` });
    }
    const { method, args = [] } = body || {};
    const fn = callbacks[method];
    if (typeof fn !== "function") {
        return sendJson(res, 404, { error: `Unknown method: ${method}` });
    }
    try {
        const result = await fn(...args);
        sendJson(res, 200, { result: result ?? null });
    } catch (e) {
        sendJson(res, 200, { error: e?.message || String(e) });
    }
}

function handleEvents(req, res) {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
    });
    res.write("retry: 2000\n");
    res.write("event: hello\ndata: {}\n\n");
    req.socket.setTimeout(0);
    clients.add(res);

    const heartbeat = setInterval(() => {
        try {
            res.write(": ping\n\n");
        } catch {
            /* handled by close */
        }
    }, 20000);

    const cleanup = () => {
        clearInterval(heartbeat);
        clients.delete(res);
    };
    req.on("close", cleanup);
    res.on("error", cleanup);
}

// ---------------------------------------------------------------------------
// Static file serving (the UI under ./public)
// ---------------------------------------------------------------------------
const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
};

async function serveStatic(pathname, res) {
    const rel = pathname === "/" ? "/index.html" : decodeURIComponent(pathname.split("?")[0]);
    const abs = normalize(join(PUBLIC_DIR, rel));
    if (abs !== PUBLIC_DIR && !abs.startsWith(PUBLIC_DIR + sep)) {
        res.writeHead(403).end();
        return;
    }
    try {
        const buf = await readFile(abs);
        res.writeHead(200, { "Content-Type": MIME[extname(abs)] || "application/octet-stream" });
        res.end(buf);
    } catch {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
    }
}

function sendJson(res, status, obj) {
    const buf = Buffer.from(JSON.stringify(obj));
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": buf.length });
    res.end(buf);
}

// ---------------------------------------------------------------------------
// Server wiring
// ---------------------------------------------------------------------------
const server = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    if (url.pathname === "/api/events" && req.method === "GET") return handleEvents(req, res);
    if (url.pathname === "/api/rpc" && req.method === "POST") return handleRpc(req, res);
    if (req.method === "GET" || req.method === "HEAD") return serveStatic(url.pathname, res);
    res.writeHead(405, { Allow: "GET, POST" }).end();
});
// Long debates keep the RPC response open for minutes — never time them out.
server.requestTimeout = 0;
server.headersTimeout = 0;

function openBrowser(url) {
    if (process.env.NO_OPEN) return;
    const [cmd, args] =
        process.platform === "darwin"
            ? ["open", [url]]
            : process.platform === "win32"
              ? ["cmd", ["/c", "start", "", url]]
              : ["xdg-open", [url]];
    try {
        spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
    } catch {
        /* no browser opener available — the URL is printed below regardless */
    }
}

function start(port, attemptsLeft) {
    server.once("error", (err) => {
        if (err.code === "EADDRINUSE" && attemptsLeft > 0) {
            start(port + 1, attemptsLeft - 1);
        } else {
            console.error(`Failed to start server: ${err.message}`);
            process.exit(1);
        }
    });
    server.listen(port, "127.0.0.1", () => {
        const url = `http://127.0.0.1:${port}/`;
        log("");
        log("  ⚔  Debate Arena is live");
        log(`     ${url}`);
        log(`     Ollama:  ${modelRuntime.ollamaHost}`);
        log("     Cloud:   Anthropic, Mistral, OpenAI, Microsoft Foundry, Google Gemini (when configured)");
        log(`     Saves:   ${join(SAVE_ROOT, "debates")}`);
        log("");
        log("  Press Ctrl+C to stop.");
        log("");
        openBrowser(url);
    });
}

start(PORT, 20);
