// ============================================================================
// LinkedIn AutoApply — Popup Script v1.4.0
// Controls the extension from the browser action popup.
// FIXED: session written DIRECTLY to storage (belt-and-suspenders)
// Added: Copier button for log, version bump
// ============================================================================

const $ = (id) => document.getElementById(id);

async function sendToBackground(msg) {
  try { return await chrome.runtime.sendMessage(msg); }
  catch (err) { console.error("BG msg error:", err); return null; }
}

async function sendToContent(msg) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return null;
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch (err) { console.error("Content msg error:", err); return null; }
}

async function refresh() {
  const state = await sendToBackground({ action: "getState" });
  if (!state) return;

  const contentStatus = await sendToContent({ action: "getContentStatus" });
  const session = state.session;

  $("enableToggle").checked = state.enabled;

  $("appliedCount").textContent = state.stats?.applied || 0;
  $("skippedCount").textContent = state.stats?.skipped || 0;
  $("errorsCount").textContent = state.stats?.errors || 0;

  // Dev Debug button state
  const debugBtn = $("devDebugBtn");
  if (state.devDebug) {
    debugBtn.textContent = "🐛 DEV Debug: ON";
    debugBtn.classList.add("active");
  } else {
    debugBtn.textContent = "🐛 DEV Debug: OFF";
    debugBtn.classList.remove("active");
  }

  const statusBar = $("statusBar");
  if (session?.active) {
    statusBar.className = "status-bar session";
    const pageNum = (session.currentPage || 0) + 1;
    statusBar.textContent = `🔄 Session: "${session.keywords}" — page ${pageNum} (${session.applied || 0}/${session.maxJobs || 25})`;
    $("startBatchBtn").style.display = "none";
    $("applySingleBtn").style.display = "none";
    $("stopBtn").style.display = "block";
  } else if (contentStatus?.isRunning) {
    statusBar.className = "status-bar running";
    statusBar.textContent = "🔄 Application en cours...";
    $("startBatchBtn").style.display = "none";
    $("applySingleBtn").style.display = "none";
    $("stopBtn").style.display = "block";
  } else if (state.enabled) {
    statusBar.className = "status-bar active";
    statusBar.textContent = "✅ Prêt";
    $("startBatchBtn").style.display = "";
    $("applySingleBtn").style.display = "";
    $("stopBtn").style.display = "none";
  } else {
    statusBar.className = "status-bar inactive";
    statusBar.textContent = "⏹️ Désactivé";
    $("startBatchBtn").style.display = "";
    $("applySingleBtn").style.display = "";
    $("stopBtn").style.display = "none";
  }

  const settings = state.autoApplySettings || {};
  $("maxJobs").value = settings.maxJobsPerSession || 25;
  $("autoSubmitToggle").checked = settings.autoSubmit !== false;
  $("easyApplyOnly").checked = settings.onlyEasyApply !== false;

  const logEl = $("logOutput");
  if (state.log && state.log.length > 0) {
    logEl.innerHTML = state.log.slice(-80).map(line => {
      let color = "#e2e8f0";
      if (line.includes("✅")) color = "#68d391";
      else if (line.includes("❌")) color = "#fc8181";
      else if (line.includes("⚠️")) color = "#f6e05e";
      else if (line.includes("🚀") || line.includes("📄")) color = "#63b3ed";
      else if (line.includes("[DEBUG]")) color = "#b794f4";
      return `<div style="color:${color}">${escapeHtml(line)}</div>`;
    }).join("");
    logEl.scrollTop = logEl.scrollHeight;
  } else {
    logEl.innerHTML = '<div style="color:#a0aec0">Aucun log</div>';
  }
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// ── Event Listeners ───────────────────────────────────────────────────────

$("enableToggle").addEventListener("change", async (e) => {
  await sendToBackground({ action: "setEnabled", enabled: e.target.checked });
  refresh();
});

// ── DEV Debug Toggle ──────────────────────────────────────────────────────
$("devDebugBtn").addEventListener("click", async () => {
  const result = await sendToBackground({ action: "toggleDevDebug" });
  refresh();
});

// ── Download Debug Log ────────────────────────────────────────────────────
$("downloadLogBtn").addEventListener("click", async () => {
  await sendToBackground({ action: "downloadDebugLog" });
  $("downloadLogBtn").textContent = "✅ Téléchargé!";
  setTimeout(() => { $("downloadLogBtn").textContent = "📥 Télécharger Log"; }, 2000);
});

// ── "Lancer Session" → show modal ────────────────────────────────────────
$("startBatchBtn").addEventListener("click", () => {
  chrome.storage.local.get(["lastKeywords", "lastLocation"], (r) => {
    $("searchKeyword").value = r.lastKeywords || "";
    $("searchLocation").value = r.lastLocation || "";
  });
  $("sessionModal").classList.add("visible");
  $("searchKeyword").focus();
});

$("cancelSessionBtn").addEventListener("click", () => {
  $("sessionModal").classList.remove("visible");
});

$("searchKeyword").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); $("searchLocation").focus(); }
});
$("searchLocation").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); $("launchSessionBtn").click(); }
});

$("launchSessionBtn").addEventListener("click", async () => {
  const keywords = $("searchKeyword").value.trim();
  const location = $("searchLocation").value.trim();

  if (!keywords) {
    $("searchKeyword").style.borderColor = "#e74c3c";
    $("searchKeyword").focus();
    return;
  }

  await chrome.storage.local.set({ lastKeywords: keywords, lastLocation: location });
  const maxJobs = parseInt($("maxJobs").value) || 25;

  // ── Collect selected job types ──
  const jobTypeChecks = document.querySelectorAll(".jobTypeCheck:checked");
  const jobTypeCodes = new Set();
  let addAlternanceKeyword = false;
  for (const cb of jobTypeChecks) {
    jobTypeCodes.add(cb.value);
    if (cb.dataset.keyword === "alternance") addAlternanceKeyword = true;
  }
  const jobTypeParam = [...jobTypeCodes].join(","); // e.g. "F,C,I"

  // If "alternance" is checked, ensure the keyword is in the search
  let finalKeywords = keywords;
  if (addAlternanceKeyword && !keywords.toLowerCase().includes("alternance")) {
    finalKeywords = keywords + " alternance";
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CRITICAL FIX v1.4.0: Write session DIRECTLY to chrome.storage.local
  // This bypasses the service worker entirely — no more active=undefined!
  // ═══════════════════════════════════════════════════════════════════════
  const session = {
    active: true,
    keywords: finalKeywords,
    location: location,
    currentPage: 0,
    applied: 0,
    skipped: 0,
    errors: 0,
    maxJobs: maxJobs,
    jobTypes: jobTypeParam,
    startedAt: new Date().toISOString(),
  };

  // Write DIRECTLY to storage (guaranteed, no service worker dependency)
  await chrome.storage.local.set({ session });
  console.log("[popup] Session written DIRECTLY to storage:", session);

  // Also notify background service worker (for logging, non-critical)
  const result = await sendToBackground({ action: "startSession", keywords: finalKeywords, location, maxJobs });
  console.log("[popup] startSession bg result:", result);

  // Verify it's really in storage
  const check = await chrome.storage.local.get(["session"]);
  console.log("[popup] Storage verification:", check.session?.active);

  // Build search URL
  const params = new URLSearchParams();
  params.set("keywords", finalKeywords);
  if (location) params.set("location", location);
  params.set("f_AL", "true");
  if (jobTypeParam) params.set("f_JT", jobTypeParam);
  const searchUrl = `https://www.linkedin.com/jobs/search/?${params.toString()}`;

  // Navigate tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    await chrome.tabs.update(tab.id, { url: searchUrl });
  } else {
    await chrome.tabs.create({ url: searchUrl });
  }

  $("sessionModal").classList.remove("visible");
  window.close();
});

// ── "Postuler ici" → single apply ────────────────────────────────────────
$("applySingleBtn").addEventListener("click", async () => {
  const result = await sendToContent({ action: "applySingleJob" });
  if (!result) {
    alert("⚠️ Ouvrez d'abord une offre LinkedIn avec candidature simplifiée.");
    return;
  }
  refresh();
});

$("stopBtn").addEventListener("click", async () => {
  await sendToContent({ action: "stopAutoApply" });
  await sendToBackground({ action: "endSession" });
  refresh();
});

$("openConfigBtn").addEventListener("click", () => chrome.runtime.openOptionsPage());

$("clearBtn").addEventListener("click", async () => {
  if (confirm("Réinitialiser toutes les stats et l'historique ?")) {
    await sendToBackground({ action: "clearApplied" });
    await sendToBackground({ action: "clearLog" });
    await sendToBackground({ action: "endSession" });
    refresh();
  }
});

$("clearLogBtn").addEventListener("click", async () => {
  await sendToBackground({ action: "clearLog" });
  refresh();
});

// ── Copier le log ─────────────────────────────────────────────────────────
$("copyLogBtn").addEventListener("click", async () => {
  const logText = $("logOutput").innerText;
  try {
    await navigator.clipboard.writeText(logText);
    $("copyLogBtn").textContent = "✅ Copié!";
    setTimeout(() => { $("copyLogBtn").textContent = "Copier"; }, 2000);
  } catch (err) {
    // Fallback for clipboard API failures
    const ta = document.createElement("textarea");
    ta.value = logText;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    $("copyLogBtn").textContent = "✅ Copié!";
    setTimeout(() => { $("copyLogBtn").textContent = "Copier"; }, 2000);
  }
});

for (const id of ["maxJobs", "autoSubmitToggle", "easyApplyOnly"]) {
  $(id).addEventListener("change", async () => {
    const state = await sendToBackground({ action: "getState" });
    const settings = state?.autoApplySettings || {};
    settings.maxJobsPerSession = parseInt($("maxJobs").value) || 25;
    settings.autoSubmit = $("autoSubmitToggle").checked;
    settings.onlyEasyApply = $("easyApplyOnly").checked;
    await chrome.storage.local.set({ autoApplySettings: settings });
  });
}

refresh();
setInterval(refresh, 2000);
