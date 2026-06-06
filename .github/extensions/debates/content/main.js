// Page-side logic for Debate Arena. window.copilot is provided by /__bridge.js.
// The extension pushes updates into the page by calling window.debateUI.*.

const $ = (id) => document.getElementById(id);
const els = {
  topic: $("topic"),
  pro: $("proModel"),
  con: $("conModel"),
  judge: $("judgeModel"),
  rounds: $("rounds"),
  start: $("startBtn"),
  stop: $("stopBtn"),
  refresh: $("refreshBtn"),
  setupMsg: $("setupMsg"),
  status: $("statusPill"),
  statusText: $("statusPill").querySelector(".status-text"),
  stage: $("stage"),
  empty: $("empty"),
  proWin: $("proWin"),
  conWin: $("conWin"),
  drawWin: $("drawWin"),
  saveBar: $("saveBar"),
  filename: $("filename"),
  save: $("saveBtn"),
  saveResult: $("saveResult"),
};

let lastResult = null;           // result from startDebate, used for saving
const messages = new Map();      // id -> { rawEl text, contentEl }

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------
function setStatus(kind, text) {
  els.status.className = `status ${kind}`;
  els.statusText.textContent = text;
}
function setSetupMsg(text, isError) {
  els.setupMsg.textContent = text || "";
  els.setupMsg.classList.toggle("error", !!isError);
}
function hideWinPills() {
  els.proWin.hidden = true;
  els.conWin.hidden = true;
  els.drawWin.hidden = true;
}

// ---------------------------------------------------------------------------
// Model loading
// ---------------------------------------------------------------------------
async function loadModels() {
  setSetupMsg("Loading models…");
  els.start.disabled = true;
  try {
    const models = await copilot.listModels();
    for (const sel of [els.pro, els.con, els.judge]) sel.innerHTML = "";
    models.forEach((m) => {
      [els.pro, els.con, els.judge].forEach((sel) => {
        const o = document.createElement("option");
        o.value = m;
        o.textContent = m;
        sel.appendChild(o);
      });
    });
    // Sensible defaults: distinct debaters when possible.
    els.pro.selectedIndex = 0;
    els.con.selectedIndex = Math.min(1, models.length - 1);
    els.judge.selectedIndex = Math.min(2, models.length - 1);
    setSetupMsg(`${models.length} model${models.length === 1 ? "" : "s"} available.`);
    els.start.disabled = false;
  } catch (e) {
    for (const sel of [els.pro, els.con, els.judge]) sel.innerHTML = '<option>—</option>';
    setSetupMsg(e.message || String(e), true);
  }
}

// ---------------------------------------------------------------------------
// Tiny safe Markdown renderer (escape first, then block + inline rules)
// ---------------------------------------------------------------------------
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
function inline(s) {
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_\w])_(?!\s)([^_\n]+?)_/g, "$1<em>$2</em>");
  return s;
}
function renderMarkdown(src) {
  const lines = escapeHtml(src).split("\n");
  let html = "";
  let i = 0;
  while (i < lines.length) {
    let line = lines[i];

    if (/^\s*$/.test(line)) { i++; continue; }

    // code fence
    if (/^```/.test(line)) {
      i++;
      const buf = [];
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      html += `<pre><code>${buf.join("\n")}</code></pre>`;
      continue;
    }

    // special WINNER callout
    const w = line.match(/^\s*WINNER:\s*(.+)$/i);
    if (w) {
      html += `<p class="winner-callout">🏆 Winner: ${inline(w[1].trim())}</p>`;
      i++;
      continue;
    }

    // headings
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lvl = Math.min(h[1].length, 3) + 2;
      html += `<h${lvl}>${inline(h[2])}</h${lvl}>`;
      i++;
      continue;
    }

    // blockquote
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      html += `<blockquote>${inline(buf.join("<br>"))}</blockquote>`;
      continue;
    }

    // unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        buf.push(`<li>${inline(lines[i].replace(/^\s*[-*+]\s+/, ""))}</li>`);
        i++;
      }
      html += `<ul>${buf.join("")}</ul>`;
      continue;
    }

    // ordered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        buf.push(`<li>${inline(lines[i].replace(/^\s*\d+[.)]\s+/, ""))}</li>`);
        i++;
      }
      html += `<ol>${buf.join("")}</ol>`;
      continue;
    }

    // paragraph (consume until blank line)
    const buf = [];
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^(#{1,6})\s/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    html += `<p>${inline(buf.join("<br>"))}</p>`;
  }
  return html;
}

// ---------------------------------------------------------------------------
// Stage rendering
// ---------------------------------------------------------------------------
function nearBottom() {
  return els.stage.scrollHeight - els.stage.scrollTop - els.stage.clientHeight < 120;
}
function scrollDown(force) {
  if (force || nearBottom()) els.stage.scrollTop = els.stage.scrollHeight;
}
function clearStage() {
  els.stage.querySelectorAll(".msg, .phase-divider").forEach((n) => n.remove());
  messages.clear();
  els.empty.hidden = true;
}

const INITIAL = { pro: "P", con: "C", judge: "J" };

window.debateUI = {
  debateStarted(info) {
    clearStage();
    hideWinPills();
    els.saveBar.hidden = true;
    els.saveResult.textContent = "";
    setStatus("running", "Debating…");
  },

  phase(label) {
    const div = document.createElement("div");
    div.className = "phase-divider";
    div.textContent = label;
    els.stage.appendChild(div);
    scrollDown(false);
  },

  beginMessage(m) {
    els.empty.hidden = true;
    const node = document.createElement("div");
    node.className = `msg ${m.side}`;
    node.innerHTML = `
      <div class="avatar">${INITIAL[m.side] || "?"}</div>
      <div class="msg-body">
        <div class="msg-head">
          <span class="msg-name">${escapeHtml(m.name)}</span>
          <span class="badge model">${escapeHtml(m.model)}</span>
          <span class="badge phase">${escapeHtml(m.phase)}</span>
        </div>
        <div class="msg-content cursor"></div>
      </div>`;
    els.stage.appendChild(node);
    messages.set(m.id, { raw: "", contentEl: node.querySelector(".msg-content") });
    scrollDown(true);
  },

  appendMessage(id, delta) {
    const rec = messages.get(id);
    if (!rec) return;
    rec.raw += delta;
    rec.contentEl.innerHTML = renderMarkdown(rec.raw);
    rec.contentEl.classList.add("cursor");
    scrollDown(false);
  },

  endMessage(id) {
    const rec = messages.get(id);
    if (rec) rec.contentEl.classList.remove("cursor");
  },

  errorMessage(id, msg) {
    const rec = messages.get(id);
    if (!rec) return;
    rec.contentEl.classList.remove("cursor");
    rec.contentEl.innerHTML += `<p class="err">⚠ ${escapeHtml(msg)}</p>`;
  },

  cancelMessage(id) {
    const rec = messages.get(id);
    if (!rec) return;
    rec.contentEl.classList.remove("cursor");
    rec.contentEl.innerHTML += `<p class="cancel-note">⏹ Turn cancelled.</p>`;
  },

  debateFinished(info) {
    setStatus("done", "Debate complete");
    hideWinPills();
    const pill =
      info.winner === "pro" ? els.proWin :
      info.winner === "con" ? els.conWin : els.drawWin;
    if (info.winnerLabel) pill.title = info.winnerLabel;
    pill.hidden = false;
    showSaveBar();
    scrollDown(true);
    finishRun();
  },

  debateCancelled() {
    setStatus("idle", "Stopped");
    finishRun();
  },

  debateError(msg) {
    setStatus("error", "Error");
    setSetupMsg(msg, true);
    finishRun();
  },
};

// ---------------------------------------------------------------------------
// Run control
// ---------------------------------------------------------------------------
function setRunning(running) {
  els.start.hidden = running;
  els.stop.hidden = !running;
  els.stop.disabled = false;
  els.stop.textContent = "Stop";
  els.topic.disabled = running;
  els.pro.disabled = running;
  els.con.disabled = running;
  els.judge.disabled = running;
  els.rounds.disabled = running;
  els.refresh.disabled = running;
}
function finishRun() {
  setRunning(false);
}

function slug(s) {
  return (
    s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) ||
    "debate"
  );
}

async function start() {
  const config = {
    topic: els.topic.value.trim(),
    proModel: els.pro.value,
    conModel: els.con.value,
    judgeModel: els.judge.value,
    rounds: els.rounds.value,
  };
  if (!config.topic) { setSetupMsg("Enter a resolution to debate.", true); els.topic.focus(); return; }

  setSetupMsg("");
  setRunning(true);
  lastResult = null;
  try {
    const result = await copilot.startDebate(config);
    if (result && !result.cancelled) {
      lastResult = result;
      els.filename.value = `${slug(config.topic)}`;
    }
  } catch (e) {
    setStatus("error", "Error");
    setSetupMsg(e.message || String(e), true);
    setRunning(false);
  }
}

function showSaveBar() {
  if (!els.filename.value) els.filename.value = slug(els.topic.value || "debate");
  els.saveBar.hidden = false;
}

async function save() {
  if (!lastResult) { els.saveResult.textContent = "Nothing to save yet."; return; }
  els.save.disabled = true;
  els.saveResult.className = "save-result";
  els.saveResult.textContent = "Saving…";
  try {
    const path = await copilot.saveDebate(lastResult, els.filename.value.trim());
    els.saveResult.className = "save-result ok";
    els.saveResult.textContent = `Saved → ${path}`;
  } catch (e) {
    els.saveResult.className = "save-result error";
    els.saveResult.textContent = e.message || String(e);
  } finally {
    els.save.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
els.start.addEventListener("click", start);
els.stop.addEventListener("click", () => {
  els.stop.disabled = true;
  els.stop.textContent = "Stopping…";
  setStatus("running", "Stopping…");
  copilot.stopDebate();
});
els.refresh.addEventListener("click", loadModels);
els.save.addEventListener("click", save);

loadModels();
