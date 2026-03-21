// ============================================================================
// LinkedIn AutoApply — Background Service Worker
// Manages state, Mistral AI calls for answering questions, CV OCR processing,
// and coordinates the content script for Easy Apply automation.
// ============================================================================

const KEEPALIVE_ALARM_NAME = "linkedin-keepalive";
const MISTRAL_MODEL = "mistral-large-latest";
const MISTRAL_ENDPOINT = "https://api.mistral.ai/v1/chat/completions";
const DEFAULT_API_KEY = "uwqtlWhrRDIdE0QAHYkIhMFkLTbkDYIb";

self._LINKEDIN_AUTOAPPLY_VERSION = "1.0.0";

// ── Default Profile ─────────────────────────────────────────────────────────
const DEFAULT_PROFILE = {
  fullName: "Yassir Boudda",
  firstName: "Yassir",
  lastName: "Boudda",
  email: "yassirboudda@gmail.com",
  phone: "+33744241119",
  linkedin: "linkedin.com/in/yboudda",
  location: "France",
  title: "Développeur Fullstack",
  experience: "10+ ans développeur web fullstack",
  stack: "Laravel, Vue.js, React, WordPress, Shopify, PHP, Python, Node.js, TypeScript, RPA, UiPath, Power Automate",
  education: "",
  languages: "Français (natif), Anglais (courant), Arabe (natif)",
  availability: "Disponible immédiatement",
  salaryExpectation: "",
  coverLetterDefault: "",
};

// ── State Management ────────────────────────────────────────────────────────
async function getState() {
  const result = await chrome.storage.local.get([
    "appliedJobs", "pendingJobs", "skippedJobs", "enabled",
    "log", "stats", "profile", "cvText", "mistralApiKey",
    "autoApplySettings",
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

async function saveState(state) {
  // Trim log to 500 entries
  if (state.log && state.log.length > 500) {
    state.log = state.log.slice(-500);
  }
  await chrome.storage.local.set(state);
}

function addLog(state, msg, level = "info") {
  const ts = new Date().toLocaleString("fr-FR", { hour12: false });
  const prefix = level === "error" ? "❌" : level === "warn" ? "⚠️" : level === "success" ? "✅" : "ℹ️";
  state.log.push(`[${ts}] ${prefix} ${msg}`);
  console.log(`[LinkedInAutoApply] ${msg}`);
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
        temperature: 0.6,
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

/**
 * Generate an answer for a LinkedIn Easy Apply question
 * @param {string} question - The question text/label
 * @param {string} fieldType - "text", "textarea", "select", "radio", "number"
 * @param {string[]} options - Available options for select/radio fields
 * @param {object} jobInfo - { title, company, description }
 * @param {object} profile - User's profile data
 * @param {string} cvText - Extracted CV text
 */
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

RÈGLES:
- Réponds UNIQUEMENT avec la valeur à mettre dans le champ, RIEN d'autre
- Pas de guillemets, pas d'explication, pas de préfixe
- Si c'est une question oui/non, réponds "Oui" ou "Non"
- Si c'est un nombre (années d'expérience, etc.), réponds UNIQUEMENT le nombre
- Si c'est un champ texte libre, sois concis (1-3 phrases max)
- Si c'est un choix multiple, choisis l'option la plus pertinente parmi celles proposées
- Utilise le contexte du CV et du profil pour des réponses précises
- En cas de doute sur les années d'expérience, utilise 10
- Pour les questions de salaire sans info, réponds selon le marché français
- Réponds en français si la question est en français, en anglais sinon
- JAMAIS de markdown ou formatting`;

  let userPrompt;

  if (fieldType === "select" || fieldType === "radio") {
    userPrompt = `Question: "${question}"
Type de champ: choix parmi les options suivantes
Options disponibles: ${JSON.stringify(options)}

Réponds avec EXACTEMENT l'une des options ci-dessus (texte identique).`;
  } else if (fieldType === "number") {
    userPrompt = `Question: "${question}"
Type de champ: nombre uniquement

Réponds avec UN SEUL NOMBRE, rien d'autre.`;
  } else {
    userPrompt = `Question: "${question}"
Type de champ: ${fieldType === "textarea" ? "texte libre (2-3 phrases)" : "texte court (1 phrase)"}

Réponds de manière concise et pertinente.`;
  }

  const answer = await askMistral(systemPrompt, userPrompt, 200);
  if (!answer) {
    return getDefaultAnswer(question, fieldType, profile);
  }

  // For select/radio, verify the answer matches one of the options
  if ((fieldType === "select" || fieldType === "radio") && options && options.length > 0) {
    const exactMatch = options.find(o => o.toLowerCase().trim() === answer.toLowerCase().trim());
    if (exactMatch) return exactMatch;

    // Fuzzy match: find the option that best contains the answer or vice versa
    const fuzzyMatch = options.find(o =>
      o.toLowerCase().includes(answer.toLowerCase()) ||
      answer.toLowerCase().includes(o.toLowerCase())
    );
    if (fuzzyMatch) return fuzzyMatch;

    // Default to first option if nothing matches
    console.warn(`[LinkedInAutoApply] AI answer "${answer}" doesn't match options, using first option`);
    return options[0];
  }

  // For number fields, extract just the number
  if (fieldType === "number") {
    const numMatch = answer.match(/\d+/);
    return numMatch ? numMatch[0] : "10";
  }

  return answer;
}

/**
 * Fallback answers when Mistral is unavailable
 */
function getDefaultAnswer(question, fieldType, profile) {
  const q = question.toLowerCase();

  // Phone number
  if (/phone|téléphone|numero|numéro|mobile|tel/i.test(q)) {
    return profile.phone || "+33744241119";
  }

  // Email
  if (/email|e-mail|courriel|mail/i.test(q)) {
    return profile.email || "";
  }

  // Years of experience
  if (/ann[ée]es?\s*(d'?exp|expéri)|years?\s*of\s*exp|experience.*years/i.test(q)) {
    return "10";
  }

  // Salary
  if (/salaire|salary|rémunération|remuneration|prétention/i.test(q)) {
    return profile.salaryExpectation || "45000";
  }

  // Start date / availability
  if (/disponib|start\s*date|quand|when.*start|date.*début/i.test(q)) {
    return profile.availability || "Immédiatement";
  }

  // Visa / work authorization
  if (/visa|autori[sz]ation.*travail|work.*autho|droit.*travail|legally/i.test(q)) {
    return "Oui";
  }

  // Relocation
  if (/d[ée]m[ée]nag|relocat|mobili/i.test(q)) {
    return "Oui";
  }

  // Cover letter / motivation
  if (/lettre|cover\s*letter|motivation|pourquoi|why.*interested/i.test(q)) {
    return profile.coverLetterDefault ||
      `Passionné par ce poste, j'apporte ${profile.experience || "10+ ans d'expérience"} en ${profile.stack || "développement web"}. Disponible immédiatement.`;
  }

  // Language
  if (/langue|language|parlez/i.test(q)) {
    return profile.languages || "Français, Anglais, Arabe";
  }

  // Default
  if (fieldType === "number") return "10";
  return profile.title || "Développeur Fullstack";
}

// ── CV Text Extraction (Tesseract.js via offscreen or direct) ───────────────
// The actual OCR runs in the options page where the user uploads their CV.
// The extracted text is stored in chrome.storage.local as "cvText".
// Background just reads it.

async function getCvText() {
  const result = await chrome.storage.local.get(["cvText"]);
  return result.cvText || "";
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
      reasons: ["WORKERS"],
      justification: "Keep service worker alive for LinkedIn auto-apply monitoring",
    });
    console.log("[LinkedInAutoApply] Offscreen keepalive document created");
  } catch (err) {
    if (!err.message?.includes("Only a single offscreen")) {
      console.error("[LinkedInAutoApply] Offscreen error:", err);
    }
  }
}

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
        msg.question,
        msg.fieldType,
        msg.options || [],
        msg.jobInfo || {},
        state.profile,
        state.cvText,
      );
      sendResponse({ answer });
    })();
    return true;
  }

  if (msg.action === "markApplied") {
    (async () => {
      const state = await getState();
      state.appliedJobs[msg.jobId] = {
        title: msg.title,
        company: msg.company,
        url: msg.url,
        ts: new Date().toISOString(),
      };
      state.stats.applied++;
      state.stats.lastRun = new Date().toISOString();
      addLog(state, `Candidature envoyée: ${msg.title} @ ${msg.company}`, "success");
      await saveState(state);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.action === "markSkipped") {
    (async () => {
      const state = await getState();
      state.skippedJobs[msg.jobId] = {
        title: msg.title,
        reason: msg.reason,
        ts: new Date().toISOString(),
      };
      state.stats.skipped++;
      addLog(state, `Ignoré: ${msg.title} — ${msg.reason}`, "warn");
      await saveState(state);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.action === "markError") {
    (async () => {
      const state = await getState();
      state.stats.errors++;
      addLog(state, `Erreur: ${msg.title} — ${msg.error}`, "error");
      await saveState(state);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.action === "addLog") {
    (async () => {
      const state = await getState();
      addLog(state, msg.message, msg.level || "info");
      await saveState(state);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.action === "clearLog") {
    (async () => {
      const state = await getState();
      state.log = [];
      await saveState(state);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.action === "clearApplied") {
    (async () => {
      await chrome.storage.local.set({
        appliedJobs: {},
        skippedJobs: {},
        stats: { applied: 0, skipped: 0, errors: 0, lastRun: null },
      });
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.action === "saveProfile") {
    (async () => {
      await chrome.storage.local.set({ profile: msg.profile });
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.action === "saveCvText") {
    (async () => {
      await chrome.storage.local.set({ cvText: msg.cvText });
      const state = await getState();
      addLog(state, `CV texte mis à jour (${msg.cvText.length} caractères)`, "success");
      await saveState(state);
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
});

// ── Alarm Handlers ──────────────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM_NAME) {
    console.log("[LinkedInAutoApply] Keepalive tick");
    ensureOffscreenKeepalive();
  }
});

// ── Init ────────────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  console.log("[LinkedInAutoApply] Installed v" + self._LINKEDIN_AUTOAPPLY_VERSION);

  // Set default API key if not already set
  const existing = await chrome.storage.local.get(["mistralApiKey"]);
  if (!existing.mistralApiKey) {
    await chrome.storage.local.set({ mistralApiKey: DEFAULT_API_KEY });
  }

  // Set default profile if not set
  const profResult = await chrome.storage.local.get(["profile"]);
  if (!profResult.profile) {
    await chrome.storage.local.set({ profile: { ...DEFAULT_PROFILE } });
  }

  // Start keepalive
  chrome.alarms.create(KEEPALIVE_ALARM_NAME, { periodInMinutes: 0.4 });
  ensureOffscreenKeepalive();
});

chrome.runtime.onStartup.addListener(async () => {
  console.log("[LinkedInAutoApply] Startup");
  chrome.alarms.create(KEEPALIVE_ALARM_NAME, { periodInMinutes: 0.4 });
  ensureOffscreenKeepalive();
});
