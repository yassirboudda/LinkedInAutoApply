// ============================================================================
// LinkedIn AutoApply — Background Service Worker v1.4.0
// Manages state, Mistral AI calls, session management, debug file logging.
// v1.4.0: version bump, blacklist in getState
// ============================================================================

const KEEPALIVE_ALARM_NAME = "linkedin-keepalive";
const DEBUG_FLUSH_ALARM = "linkedin-debug-flush";
const MISTRAL_MODEL = "mistral-large-latest";
const MISTRAL_ENDPOINT = "https://api.mistral.ai/v1/chat/completions";
const DEFAULT_API_KEY = "uwqtlWhrRDIdE0QAHYkIhMFkLTbkDYIb";

self._LINKEDIN_AUTOAPPLY_VERSION = "1.4.0";

// ── Default Profile ─────────────────────────────────────────────────────────
const DEFAULT_PROFILE = {
  fullName: "",
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  linkedin: "",
  location: "",
  title: "",
  experience: "",
  stack: ",
  education: "",
  languages: "",
  availability: "Disponible immédiatement",
  salaryExpectation: "",
  coverLetterDefault: "",
};

// ── State Management ────────────────────────────────────────────────────────
async function getState() {
  const result = await chrome.storage.local.get([
    "appliedJobs", "pendingJobs", "skippedJobs", "enabled",
    "log", "stats", "profile", "cvText", "mistralApiKey",
    "autoApplySettings", "session", "devDebug", "blacklistedCompanies",
  ]);
  return {
    appliedJobs: result.appliedJobs || {},
    pendingJobs: result.pendingJobs || [],
    skippedJobs: result.skippedJobs || {},
    enabled: result.enabled !== false,
    log: result.log || [],
    stats: result.stats || { applied: 0, skipped: 0, errors: 0, lastRun: null },
    profile: result.profile || { ...DEFAULT_PROFILE },
    cvText: result.cvText || "",
    mistralApiKey: result.mistralApiKey || DEFAULT_API_KEY,
    session: result.session || null,
    devDebug: result.devDebug || false,
    blacklistedCompanies: result.blacklistedCompanies || [],
    autoApplySettings: result.autoApplySettings || {
      maxJobsPerSession: 25,
      delayBetweenJobs: { min: 8000, max: 20000 },
      delayBetweenSteps: { min: 1500, max: 4000 },
      onlyEasyApply: true,
      skipAlreadyApplied: true,
      autoSubmit: true,
      pauseOnUnknownQuestion: true,
    },
  };
}

// ── Targeted Storage Helpers (avoid race conditions) ────────────────────────
async function appendLog(msg, level = "info") {
  const { log = [] } = await chrome.storage.local.get(["log"]);
  const ts = new Date().toLocaleString("fr-FR", { hour12: false });
  const prefix = level === "error" ? "❌" : level === "warn" ? "⚠️" : level === "success" ? "✅" : "ℹ️";
  log.push(`[${ts}] ${prefix} ${msg}`);
  if (log.length > 1000) log.splice(0, log.length - 1000);
  await chrome.storage.local.set({ log });
  console.log(`[LinkedInAutoApply] ${prefix} ${msg}`);
}

// ── Debug Log file flush ────────────────────────────────────────────────────
async function flushDebugLog() {
  try {
    const { devDebug, log = [] } = await chrome.storage.local.get(["devDebug", "log"]);
    if (!devDebug) return;
    if (log.length === 0) return;

    const header = `=== LinkedIn AutoApply Debug Log ===\n`;
    const meta = `Flushed: ${new Date().toISOString()}\nVersion: ${self._LINKEDIN_AUTOAPPLY_VERSION}\nEntries: ${log.length}\n${"=".repeat(40)}\n\n`;
    const body = log.join("\n");
    const content = header + meta + body + "\n";

    const dataUrl = "data:text/plain;charset=utf-8," + encodeURIComponent(content);
    chrome.downloads.download({
      url: dataUrl,
      filename: "linkedin-autoapply-debug.log",
      conflictAction: "overwrite",
      saveAs: false,
    }, (downloadId) => {
      if (downloadId) {
        setTimeout(() => {
          chrome.downloads.erase({ id: downloadId });
        }, 2000);
      }
    });
    console.log("[LinkedInAutoApply] Debug log flushed to file");
  } catch (err) {
    console.error("[LinkedInAutoApply] Debug flush error:", err);
  }
}

// ── Mistral API ─────────────────────────────────────────────────────────────
async function getApiKey() {
  const result = await chrome.storage.local.get(["mistralApiKey"]);
  return result.mistralApiKey || DEFAULT_API_KEY;
}

async function askMistral(systemPrompt, userPrompt, maxTokens = 300) {
  const apiKey = await getApiKey();
  if (!apiKey) {
    console.warn("[LinkedInAutoApply] No Mistral API key");
    return null;
  }
  try {
    const response = await fetch(MISTRAL_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MISTRAL_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: maxTokens,
        temperature: 0.3,
      }),
    });
    if (response.status === 429) {
      console.warn("[LinkedInAutoApply] Mistral rate limit");
      return null;
    }
    if (!response.ok) {
      const text = await response.text();
      console.error("[LinkedInAutoApply] Mistral error:", response.status, text);
      return null;
    }
    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.error("[LinkedInAutoApply] Mistral fetch error:", err);
    return null;
  }
}

async function generateAnswer(question, fieldType, options, jobInfo, profile, cvText) {
  const contextParts = [];
  if (profile.fullName) contextParts.push(`Nom: ${profile.fullName}`);
  if (profile.email) contextParts.push(`Email: ${profile.email}`);
  if (profile.phone) contextParts.push(`Téléphone: ${profile.phone}`);
  if (profile.location) contextParts.push(`Localisation: ${profile.location}`);
  if (profile.title) contextParts.push(`Titre: ${profile.title}`);
  if (profile.experience) contextParts.push(`Expérience: ${profile.experience}`);
  if (profile.stack) contextParts.push(`Compétences: ${profile.stack}`);
  if (profile.education) contextParts.push(`Formation: ${profile.education}`);
  if (profile.languages) contextParts.push(`Langues: ${profile.languages}`);
  if (profile.availability) contextParts.push(`Disponibilité: ${profile.availability}`);
  if (profile.salaryExpectation) contextParts.push(`Prétentions salariales: ${profile.salaryExpectation}`);

  const profileContext = contextParts.join("\n");
  const cvContext = cvText ? `\n\nContenu du CV:\n${cvText.substring(0, 2000)}` : "";

  const systemPrompt = `Tu es un assistant qui aide à remplir les formulaires de candidature LinkedIn Easy Apply pour ${profile.fullName || "le candidat"}.
Profil du candidat:
${profileContext}
${cvContext}

Poste visé: ${jobInfo.title || "Non spécifié"} chez ${jobInfo.company || "Non spécifié"}
${jobInfo.description ? `Description du poste: ${jobInfo.description.substring(0, 500)}` : ""}

RÈGLES ABSOLUES:
- Réponds UNIQUEMENT avec la valeur à mettre dans le champ, RIEN d'autre
- Pas de guillemets, pas d'explication, pas de préfixe, pas de phrase
- Si la question demande un NOMBRE ou CHIFFRE: réponds UNIQUEMENT avec un nombre (ex: 45000, 10, 5)
- Si c'est une question oui/non, réponds "Oui" ou "Non"
- Si c'est un champ de salaire/rémunération: réponds un nombre brut annuel (ex: 55000)
- Si c'est un champ texte libre, sois concis (1-3 phrases max)
- Si c'est un choix multiple, choisis l'option la plus pertinente parmi celles proposées
- Utilise le contexte du CV et du profil pour des réponses précises
- En cas de doute sur les années d'expérience, utilise 10
- Réponds en français si la question est en français, en anglais sinon
- JAMAIS de markdown, formatting, guillemets ou texte explicatif`;

  let userPrompt;
  if (fieldType === "select" || fieldType === "radio") {
    userPrompt = `Question: "${question}"
Type de champ: choix parmi les options suivantes
Options disponibles: ${JSON.stringify(options)}

Réponds avec EXACTEMENT l'une des options ci-dessus (texte identique).`;
  } else if (fieldType === "number") {
    userPrompt = `Question: "${question}"
Type de champ: NOMBRE UNIQUEMENT (champ numérique)

IMPORTANT: Le champ n'accepte QUE des chiffres. Pas de texte, pas de symbole, pas d'espace.
Réponds avec UN SEUL NOMBRE ENTIER comme: 45000 ou 10 ou 3
Si c'est un salaire, donne le montant brut annuel en euros (ex: 55000).
Si c'est des années d'expérience, donne le nombre (ex: 10).`;
  } else {
    userPrompt = `Question: "${question}"
Type de champ: ${fieldType === "textarea" ? "texte libre (2-3 phrases)" : "texte court (1 phrase)"}

Réponds de manière concise et pertinente.`;
  }

  const answer = await askMistral(systemPrompt, userPrompt, 200);
  if (!answer) return getDefaultAnswer(question, fieldType, profile);

  if ((fieldType === "select" || fieldType === "radio") && options && options.length > 0) {
    const exactMatch = options.find(o => o.toLowerCase().trim() === answer.toLowerCase().trim());
    if (exactMatch) return exactMatch;
    const fuzzyMatch = options.find(o =>
      o.toLowerCase().includes(answer.toLowerCase()) ||
      answer.toLowerCase().includes(o.toLowerCase())
    );
    if (fuzzyMatch) return fuzzyMatch;
    return options[0];
  }

  if (fieldType === "number") {
    const cleaned = answer.replace(/[\s€$,\.]/g, "");
    const allNums = cleaned.match(/\d+/g);
    if (allNums && allNums.length > 0) {
      const biggest = allNums.sort((a, b) => parseInt(b) - parseInt(a))[0];
      return biggest;
    }
    return getDefaultAnswer(question, "number", profile);
  }

  return answer;
}

function getDefaultAnswer(question, fieldType, profile) {
  const q = question.toLowerCase();
  if (/phone|téléphone|numero|numéro|mobile|tel/i.test(q)) return profile.phone || "";
  if (/email|e-mail|courriel|mail/i.test(q)) return profile.email || "";
  if (/ann[ée]es?\s*(d'?exp|expéri)|years?\s*of\s*exp|experience.*years/i.test(q)) return "10";
  if (/salaire|salary|rémunération|remuneration|prétention/i.test(q)) return profile.salaryExpectation || "55000";
  if (/disponib|start\s*date|quand|when.*start|date.*début/i.test(q)) return profile.availability || "Immédiatement";
  if (/visa|autori[sz]ation.*travail|work.*autho|droit.*travail|legally/i.test(q)) return "Oui";
  if (/d[ée]m[ée]nag|relocat|mobili/i.test(q)) return "Oui";
  if (/location|city|ville|lieu|localisation|adresse|r[ée]gion|where.*(?:live|based|located)/i.test(q)) return profile.location || "France";
  if (/lettre|cover\s*letter|motivation|pourquoi|why.*interested/i.test(q)) {
    return profile.coverLetterDefault ||
      `Passionné par ce poste, j'apporte ${profile.experience || "une solide expérience"} en ${profile.stack || "mon domaine"}. Disponible immédiatement.`;
  }
  if (/langue|language|parlez/i.test(q)) return profile.languages || "Français, Anglais, Arabe";
  if (fieldType === "number") {
    if (/salaire|salary|rémunération|remuneration|prétention/i.test(q)) return "55000";
    if (/ann[ée]e|year/i.test(q)) return "10";
    return "10";
  }
  return profile.title || "";
}

// ── Offscreen Keepalive ─────────────────────────────────────────────────────
async function ensureOffscreenKeepalive() {
  try {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
    });
    if (existingContexts.length > 0) return;
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["DOM_PARSER"],
      justification: "Keepalive for service worker",
    });
  } catch (err) {
    console.warn("[LinkedInAutoApply] Offscreen error:", err.message);
  }
}

// ── Active Session Trigger via tabs.onUpdated ───────────────────────────────
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!tab.url) return;

  const isSearchPage = tab.url.includes("linkedin.com/jobs/search") ||
                       tab.url.includes("linkedin.com/jobs/collection");

  if (!isSearchPage) return;

  try {
    const { session } = await chrome.storage.local.get(["session"]);
    if (!session || !session.active) {
      console.log("[LinkedInAutoApply] tabs.onUpdated: search page loaded but no active session");
      return;
    }

    await appendLog(`[BG] Page recherche chargée (tab ${tabId}) — envoi startAutoApply dans 6s...`, "info");

    await new Promise(r => setTimeout(r, 6000));

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const resp = await chrome.tabs.sendMessage(tabId, { action: "startAutoApply" });
        await appendLog(`[BG] startAutoApply envoyé OK (tentative ${attempt}), réponse: ${JSON.stringify(resp)}`, "info");
        return;
      } catch (err) {
        await appendLog(`[BG] startAutoApply tentative ${attempt} échouée: ${err.message}`, "warn");
        if (attempt < 3) {
          await new Promise(r => setTimeout(r, 3000));
        }
      }
    }

    try {
      await appendLog("[BG] Injection content.js par scripting API...", "info");
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"],
      });
      await new Promise(r => setTimeout(r, 5000));
      await chrome.tabs.sendMessage(tabId, { action: "startAutoApply" });
      await appendLog("[BG] startAutoApply envoyé après injection", "success");
    } catch (err2) {
      await appendLog(`[BG] Injection fallback échoué: ${err2.message}`, "error");
    }
  } catch (err) {
    console.error("[LinkedInAutoApply] tabs.onUpdated error:", err);
  }
});

// ── Message Handlers ────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "keepalive") {
    sendResponse({ ok: true });
    return;
  }

  if (msg.action === "getState") {
    getState().then(sendResponse);
    return true;
  }

  if (msg.action === "setEnabled") {
    chrome.storage.local.set({ enabled: msg.enabled });
    sendResponse({ ok: true });
    return;
  }

  if (msg.action === "generateAnswer") {
    (async () => {
      const state = await getState();
      const answer = await generateAnswer(
        msg.question, msg.fieldType, msg.options || [],
        msg.jobInfo || {}, state.profile, state.cvText,
      );
      sendResponse({ answer });
    })();
    return true;
  }

  // ── FIXED: Targeted storage updates to avoid race conditions ──────────

  if (msg.action === "markApplied") {
    (async () => {
      const { appliedJobs = {}, stats = { applied: 0, skipped: 0, errors: 0, lastRun: null } } =
        await chrome.storage.local.get(["appliedJobs", "stats"]);

      appliedJobs[msg.jobId || ("auto_" + Date.now())] = {
        title: msg.title, company: msg.company,
        url: msg.url, ts: new Date().toISOString(),
      };
      stats.applied = (stats.applied || 0) + 1;
      stats.lastRun = new Date().toISOString();
      await chrome.storage.local.set({ appliedJobs, stats });

      const { session } = await chrome.storage.local.get(["session"]);
      if (session && session.active) {
        session.applied = (session.applied || 0) + 1;
        await chrome.storage.local.set({ session });
      }
      await appendLog(`Candidature envoyée: ${msg.title} @ ${msg.company}`, "success");
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.action === "markSkipped") {
    (async () => {
      const { skippedJobs = {}, stats = { applied: 0, skipped: 0, errors: 0, lastRun: null } } =
        await chrome.storage.local.get(["skippedJobs", "stats"]);
      skippedJobs[msg.jobId || ("skip_" + Date.now())] = {
        title: msg.title, reason: msg.reason, ts: new Date().toISOString(),
      };
      stats.skipped = (stats.skipped || 0) + 1;
      await chrome.storage.local.set({ skippedJobs, stats });
      await appendLog(`Ignoré: ${msg.title} — ${msg.reason}`, "warn");
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.action === "markError") {
    (async () => {
      const { stats = { applied: 0, skipped: 0, errors: 0, lastRun: null } } =
        await chrome.storage.local.get(["stats"]);
      stats.errors = (stats.errors || 0) + 1;
      await chrome.storage.local.set({ stats });
      await appendLog(`Erreur: ${msg.title} — ${msg.error}`, "error");
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.action === "addLog") {
    appendLog(msg.message, msg.level || "info").then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.action === "clearLog") {
    chrome.storage.local.set({ log: [] }).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.action === "clearApplied") {
    chrome.storage.local.set({
      appliedJobs: {}, skippedJobs: {},
      stats: { applied: 0, skipped: 0, errors: 0, lastRun: null },
    }).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.action === "saveProfile") {
    chrome.storage.local.set({ profile: msg.profile }).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.action === "saveCvText") {
    (async () => {
      await chrome.storage.local.set({ cvText: msg.cvText });
      await appendLog(`CV texte mis à jour (${msg.cvText.length} caractères)`, "success");
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.action === "getProfile") {
    (async () => {
      const state = await getState();
      sendResponse({ profile: state.profile, cvText: state.cvText });
    })();
    return true;
  }

  // ── Session Management ────────────────────────────────────────────────

  if (msg.action === "startSession") {
    (async () => {
      // Note: v1.4.0 — popup also writes session directly to storage
      // This handler is now a backup + logging mechanism
      const session = {
        active: true,
        keywords: msg.keywords || "",
        location: msg.location || "",
        currentPage: 0,
        applied: 0,
        skipped: 0,
        errors: 0,
        maxJobs: msg.maxJobs || 25,
        startedAt: new Date().toISOString(),
      };
      await chrome.storage.local.set({ session });
      await appendLog(`Session démarrée: "${msg.keywords}" à "${msg.location}" (max ${session.maxJobs})`, "info");

      const check = await chrome.storage.local.get(["session"]);
      if (check.session && check.session.active) {
        await appendLog("[BG] Session vérifiée active dans storage OK", "info");
      } else {
        await appendLog("[BG] ERREUR: Session NON trouvée après sauvegarde!", "error");
      }
      sendResponse({ ok: true, session });
    })();
    return true;
  }

  if (msg.action === "getSession") {
    chrome.storage.local.get(["session"]).then(r => sendResponse(r.session || null));
    return true;
  }

  if (msg.action === "updateSession") {
    (async () => {
      const { session } = await chrome.storage.local.get(["session"]);
      if (session) {
        Object.assign(session, msg.updates);
        await chrome.storage.local.set({ session });
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.action === "endSession") {
    (async () => {
      const { session } = await chrome.storage.local.get(["session"]);
      if (session) {
        session.active = false;
        session.endedAt = new Date().toISOString();
        await chrome.storage.local.set({ session });
      }
      await appendLog(`Session terminée`, "success");
      await flushDebugLog();
      sendResponse({ ok: true });
    })();
    return true;
  }

  // ── Dev Debug ─────────────────────────────────────────────────────────

  if (msg.action === "toggleDevDebug") {
    (async () => {
      const { devDebug } = await chrome.storage.local.get(["devDebug"]);
      const newVal = !devDebug;
      await chrome.storage.local.set({ devDebug: newVal });
      if (newVal) {
        chrome.alarms.create(DEBUG_FLUSH_ALARM, { periodInMinutes: 1 });
        await appendLog("[DEV] Mode debug activé — logs sauvegardés toutes les 60s", "info");
      } else {
        chrome.alarms.clear(DEBUG_FLUSH_ALARM);
        await appendLog("[DEV] Mode debug désactivé", "info");
      }
      sendResponse({ ok: true, devDebug: newVal });
    })();
    return true;
  }

  if (msg.action === "downloadDebugLog") {
    flushDebugLog().then(() => sendResponse({ ok: true }));
    return true;
  }
});

// ── Alarm Handlers ──────────────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM_NAME) {
    ensureOffscreenKeepalive();
  }
  if (alarm.name === DEBUG_FLUSH_ALARM) {
    flushDebugLog();
  }
});

// ── Init ────────────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  console.log("[LinkedInAutoApply] Installed v" + self._LINKEDIN_AUTOAPPLY_VERSION);
  const existing = await chrome.storage.local.get(["mistralApiKey"]);
  if (!existing.mistralApiKey) {
    await chrome.storage.local.set({ mistralApiKey: DEFAULT_API_KEY });
  }
  const profResult = await chrome.storage.local.get(["profile"]);
  if (!profResult.profile) {
    await chrome.storage.local.set({ profile: { ...DEFAULT_PROFILE } });
  }
  const { devDebug } = await chrome.storage.local.get(["devDebug"]);
  if (devDebug) {
    chrome.alarms.create(DEBUG_FLUSH_ALARM, { periodInMinutes: 1 });
  }
  chrome.alarms.create(KEEPALIVE_ALARM_NAME, { periodInMinutes: 0.4 });
  ensureOffscreenKeepalive();
});

chrome.runtime.onStartup.addListener(async () => {
  console.log("[LinkedInAutoApply] Startup");
  const { devDebug } = await chrome.storage.local.get(["devDebug"]);
  if (devDebug) {
    chrome.alarms.create(DEBUG_FLUSH_ALARM, { periodInMinutes: 1 });
  }
  chrome.alarms.create(KEEPALIVE_ALARM_NAME, { periodInMinutes: 0.4 });
  ensureOffscreenKeepalive();
});
