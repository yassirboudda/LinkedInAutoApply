// ============================================================================
// LinkedIn AutoApply — Popup Script
// Controls the extension from the browser action popup.
// ============================================================================

const $ = (id) => document.getElementById(id);

async function sendToBackground(msg) {
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch (err) {
    console.error("Background message error:", err);
    return null;
  }
}

async function sendToContent(msg) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return null;
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch (err) {
    console.error("Content message error:", err);
    return null;
  }
}

async function refresh() {
  // Get state from background
  const state = await sendToBackground({ action: "getState" });
  if (!state) return;

  // Get status from content script
  const contentStatus = await sendToContent({ action: "getContentStatus" });

  // Update toggle
  $("enableToggle").checked = state.enabled;

  // Update stats
  $("appliedCount").textContent = state.stats?.applied || 0;
  $("skippedCount").textContent = state.stats?.skipped || 0;
  $("errorsCount").textContent = state.stats?.errors || 0;

  // Update status bar
  const statusBar = $("statusBar");
  if (contentStatus?.isRunning) {
    statusBar.className = "status-bar running";
    statusBar.textContent = "🔄 Session en cours...";
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

  // Update quick settings
  const settings = state.autoApplySettings || {};
  $("maxJobs").value = settings.maxJobsPerSession || 25;
  $("autoSubmitToggle").checked = settings.autoSubmit !== false;
  $("easyApplyOnly").checked = settings.onlyEasyApply !== false;

  // Update log
  const logEl = $("logOutput");
  if (state.log && state.log.length > 0) {
    logEl.innerHTML = state.log.slice(-50).map(line => {
      let color = "#e2e8f0";
      if (line.includes("✅")) color = "#68d391";
      else if (line.includes("❌")) color = "#fc8181";
      else if (line.includes("⚠️")) color = "#f6e05e";
      return `<div style="color:${color}">${escapeHtml(line)}</div>`;
    }).join("");
    logEl.scrollTop = logEl.scrollHeight;
  } else {
    logEl.innerHTML = '<div style="color:#a0aec0">Aucun log pour le moment</div>';
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

$("startBatchBtn").addEventListener("click", async () => {
  const result = await sendToContent({ action: "startAutoApply" });
  if (!result) {
    alert("⚠️ Ouvrez d'abord une page LinkedIn Jobs pour lancer la session.");
    return;
  }
  refresh();
});

$("applySingleBtn").addEventListener("click", async () => {
  const result = await sendToContent({ action: "applySingleJob" });
  if (!result) {
    alert("⚠️ Ouvrez d'abord une offre LinkedIn avec Easy Apply.");
    return;
  }
  refresh();
});

$("stopBtn").addEventListener("click", async () => {
  await sendToContent({ action: "stopAutoApply" });
  refresh();
});

$("openConfigBtn").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

$("clearBtn").addEventListener("click", async () => {
  if (confirm("Réinitialiser toutes les stats et l'historique ?")) {
    await sendToBackground({ action: "clearApplied" });
    await sendToBackground({ action: "clearLog" });
    refresh();
  }
});

$("clearLogBtn").addEventListener("click", async () => {
  await sendToBackground({ action: "clearLog" });
  refresh();
});

// Save quick settings on change
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

// Initial load + auto-refresh
refresh();
setInterval(refresh, 3000);
