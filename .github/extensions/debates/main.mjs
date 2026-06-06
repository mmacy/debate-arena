// Debate Arena — pits two local Ollama models against each other in a
// structured debate, judged by a third model. The native window (served from
// ./content) drives everything through the `copilot.*` bridge; this file
// implements those callbacks and streams the debate back into the page.
import { joinSession } from "@github/copilot-sdk/extension";
import { join, resolve, sep } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { CopilotWebview } from "./lib/copilot-webview.js";

const OLLAMA_HOST = process.env.OLLAMA_HOST?.replace(/\/+$/, "") || "http://127.0.0.1:11434";

let session;
let activeAbort = null;
let runToken = 0;

const webview = new CopilotWebview({
    extensionName: "debates",
    contentDir: join(import.meta.dirname, "content"),
    title: "Debate Arena",
    width: 1180,
    height: 880,
    callbacks: {
        listModels,
        startDebate,
        stopDebate,
        saveDebate,
        copyDebate: async (payload) => {
            if (!payload || !payload.transcript) throw new Error("Nothing to copy yet — run a debate first.");
            const md = renderMarkdown(payload);
            await osClipboardCopy(md);
            return md.length;
        },
        log: (msg, opts) => session?.log(msg, opts),
    },
});

// ---------------------------------------------------------------------------
// Page bridge helper: push a JS call into the page. Fire-and-forget but
// awaited so streaming stays ordered; a single failed push never aborts a run.
// ---------------------------------------------------------------------------
async function push(fn, ...args) {
    const code = `window.debateUI && window.debateUI.${fn}(${args.map((a) => JSON.stringify(a)).join(",")})`;
    try {
        await webview.eval(code, { timeoutMs: 5000 });
    } catch {
        /* page navigated/closed mid-stream — ignore */
    }
}

// ---------------------------------------------------------------------------
// Write text to the OS clipboard from the extension (Node) side. WKWebView's
// in-page clipboard API is gesture-gated and unreliable, so we shell out to the
// platform clipboard utility instead. Linux tries xclip then wl-copy.
// ---------------------------------------------------------------------------
function osClipboardCopy(text) {
    const candidates =
        process.platform === "darwin" ? [["pbcopy", []]] :
        process.platform === "win32" ? [["clip", []]] :
        [["xclip", ["-selection", "clipboard"]], ["wl-copy", []]];

    const tryOne = ([cmd, args]) =>
        new Promise((resolve, reject) => {
            const child = spawn(cmd, args);
            let settled = false;
            const done = (fn, arg) => { if (!settled) { settled = true; clearTimeout(timer); fn(arg); } };
            const timer = setTimeout(() => {
                try { child.kill(); } catch {}
                done(reject, new Error(`${cmd} timed out`));
            }, 4000);
            child.on("error", (e) => done(reject, e));
            child.on("close", (code) => (code === 0 ? done(resolve) : done(reject, new Error(`${cmd} exited with code ${code}`))));
            child.stdin.on("error", () => {});
            child.stdin.end(text);
        });

    return candidates.reduce(
        (p, cand) => p.catch(() => tryOne(cand)),
        Promise.reject(new Error("init"))
    ).catch((e) => {
        const hint = process.platform === "linux" ? " (install xclip or wl-clipboard)" : "";
        throw new Error(`Could not access the system clipboard${hint}: ${e.message}`);
    });
}

// ---------------------------------------------------------------------------
// Ollama: list installed models
// ---------------------------------------------------------------------------
async function listModels() {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, {
        signal: AbortSignal.timeout(8000),
    }).catch((e) => {
        throw new Error(`Could not reach Ollama at ${OLLAMA_HOST}. Is it running? (${e.message})`);
    });
    if (!res.ok) throw new Error(`Ollama responded ${res.status} ${res.statusText}`);
    const data = await res.json();
    const models = (data.models || [])
        .map((m) => m.name)
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
    if (!models.length) {
        throw new Error("Ollama is running but no models are installed. Pull one with `ollama pull <model>`.");
    }
    return models;
}

// ---------------------------------------------------------------------------
// Ollama: stream a chat completion, pushing token deltas into the page via the
// provided onDelta callback. Returns the full assembled text.
// ---------------------------------------------------------------------------
async function streamChat({ model, messages, signal, onDelta }) {
    const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model,
            messages,
            stream: true,
            think: false,
            options: { temperature: 0.8 },
        }),
        signal,
    });
    if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Ollama /api/chat failed for "${model}" (${res.status}). ${detail}`.trim());
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";

    const handleLine = async (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let obj;
        try {
            obj = JSON.parse(trimmed);
        } catch {
            return;
        }
        if (obj.error) throw new Error(obj.error);
        const piece = obj.message?.content || "";
        if (piece) {
            full += piece;
            await onDelta(piece);
        }
    };

    for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            await handleLine(line);
        }
    }
    if (buffer) await handleLine(buffer);
    return full.trim();
}

// ---------------------------------------------------------------------------
// One spoken turn: announces a message card, streams the model's reply into
// it (coalescing tokens onto a ~40ms flush), and records it in the transcript.
// ---------------------------------------------------------------------------
async function speak({ id, role, side, name, model, phase, system, history, signal, push: pushFn = push }) {
    await pushFn("beginMessage", { id, role, side, name, model, phase });

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

    const messages = [{ role: "system", content: system }, ...history];
    let text;
    try {
        text = await streamChat({
            model,
            messages,
            signal,
            onDelta: async (piece) => {
                pending += piece;
                await flush(false);
            },
        });
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
    return [
        `You are a sharp, persuasive competitive debater arguing ${persona}.`,
        `The resolution under debate is: "${topic}".`,
        `You must argue ${stance} this resolution at all times — never concede the other side.`,
        `Be substantive: make clear claims, support them with reasoning and concrete examples,`,
        `directly rebut your opponent's points when responding, and stay civil but forceful.`,
        `Write in flowing prose (light Markdown is fine). Keep each turn focused — roughly 150-250 words.`,
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

// Render the running transcript as plain text for a debater's conversation history.
function historyFor(currentSide, transcript) {
    return transcript.map((t) => {
        const speaker = t.side === currentSide ? "You" : "Your opponent";
        return {
            role: t.side === currentSide ? "assistant" : "user",
            content: `[${t.phase} — ${speaker} (${t.label})]\n${t.text}`,
        };
    });
}

// Flat transcript for the judge.
function judgeTranscript(transcript) {
    return transcript
        .map((t) => `### ${t.phase} — ${t.label}\n${t.text}`)
        .join("\n\n");
}

// ---------------------------------------------------------------------------
// startDebate: orchestrates the whole match and streams it to the page.
// config: { topic, proModel, conModel, judgeModel, rounds }
// Returns a structured result the page keeps for saving.
// ---------------------------------------------------------------------------
async function startDebate(config) {
    const topic = String(config?.topic || "").trim();
    const proModel = config?.proModel;
    const conModel = config?.conModel;
    const judgeModel = config?.judgeModel;
    const rounds = Math.min(Math.max(parseInt(config?.rounds, 10) || 1, 1), 3);

    if (!topic) throw new Error("Please enter a debate topic.");
    if (!proModel || !conModel || !judgeModel) throw new Error("Please choose a model for both debaters and the judge.");

    if (activeAbort) activeAbort.abort();
    const controller = new AbortController();
    activeAbort = controller;
    const signal = controller.signal;
    const myToken = ++runToken;
    // Suppress UI pushes from a superseded run so a stale debate can't write
    // into (or "Stop"/"finish") a newer one that started after a restart.
    const rpush = (...a) => (myToken === runToken ? push(...a) : Promise.resolve());

    const startedAt = new Date();
    const transcript = []; // { side, label, phase, text }
    let msgSeq = 0;
    const nextId = () => `m${++msgSeq}`;

    const proSys = debaterSystem("pro", topic);
    const conSys = debaterSystem("con", topic);
    const proLabel = `Pro · ${proModel}`;
    const conLabel = `Con · ${conModel}`;

    const turn = async (side, phase) => {
        const isPro = side === "pro";
        const text = await speak({
            id: nextId(),
            role: "debater",
            side,
            name: isPro ? "Pro" : "Con",
            model: isPro ? proModel : conModel,
            phase,
            system: isPro ? proSys : conSys,
            history: historyFor(side, transcript),
            signal,
            push: rpush,
        });
        transcript.push({ side, label: isPro ? proLabel : conLabel, phase, text });
    };

    try {
        await rpush("debateStarted", {
            topic,
            proModel,
            conModel,
            judgeModel,
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
            model: judgeModel,
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
            proModel,
            conModel,
            judgeModel,
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
// saveDebate: writes a Markdown file with YAML front matter to ./debates/.
// payload is the result object returned by startDebate plus an optional
// `filename`. Returns the saved absolute path.
// ---------------------------------------------------------------------------
async function saveDebate(payload, filename) {
    if (!payload || !payload.transcript) throw new Error("Nothing to save yet — run a debate first.");

    const dir = join(process.cwd(), "debates");
    await mkdir(dir, { recursive: true });

    const base =
        safeFileName(filename) ||
        `${slug(payload.topic)}-${stamp(payload.finishedAt)}`;
    const name = base.toLowerCase().endsWith(".md") ? base : `${base}.md`;
    const path = join(dir, name);

    // Defense in depth: never let a crafted name escape the debates/ directory.
    if (resolve(path) !== path || !resolve(path).startsWith(resolve(dir) + sep)) {
        throw new Error("Invalid filename.");
    }

    await writeFile(path, renderMarkdown(payload), "utf8");
    await session?.log(`Saved debate to ${path}`);
    return path;
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
        `rounds: ${p.rounds}`,
        `winner: ${yamlStr(p.winner)}`,
        `winner_label: ${yamlStr(p.winnerLabel)}`,
        `duration_seconds: ${Math.round((p.durationMs || 0) / 1000)}`,
        `generator: "Debate Arena (Ollama)"`,
        "---",
        "",
    ].join("\n");

    const winnerLine =
        p.winner === "draw"
            ? "**Result:** Draw"
            : `**Winner:** ${p.winnerLabel}`;

    const body = [
        `# Debate: ${p.topic}`,
        "",
        `> ${winnerLine}`,
        ">",
        `> Pro: \`${p.proModel}\` · Con: \`${p.conModel}\` · Judge: \`${p.judgeModel}\``,
        "",
        "## Transcript",
        "",
        ...p.transcript.map(
            (t) => `### ${t.phase} — ${t.label}\n\n${t.text}\n`
        ),
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

function stamp(iso) {
    const d = iso ? new Date(iso) : new Date();
    return d.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
}

// ---------------------------------------------------------------------------
// Session wiring
// ---------------------------------------------------------------------------
session = await joinSession({
    tools: webview.tools,
    commands: [
        {
            name: "debates",
            description: "Open the Debate Arena — pit two local Ollama models against each other, judged by a third.",
            handler: async () => {
                await webview.show();
            },
        },
    ],
    hooks: { onSessionEnd: webview.close },
});
