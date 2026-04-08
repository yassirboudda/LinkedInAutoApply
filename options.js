// ============================================================================
// LinkedIn AutoApply — Options Page Script v1.4.0
// Handles profile editing, CV upload+OCR (Tesseract.js), settings, blacklist.
// ============================================================================

const $ = (id) => document.getElementById(id);

// ── Toast Notifications ─────────────────────────────────────────────────────
function showToast(msg, type = "success") {
  const toast = $("toast");
  toast.textContent = msg;
  toast.className = `toast ${type} show`;
  setTimeout(() => {
    toast.className = `toast ${type}`;
  }, 3000);
}

// ── Load Settings ───────────────────────────────────────────────────────────
async function loadSettings() {
  const result = await chrome.storage.local.get([
    "mistralApiKey", "profile", "cvText", "autoApplySettings",
    "blacklistedCompanies",
  ]);

  // API Key
  $("apiKey").value = result.mistralApiKey || "";

  // Profile
  const profile = result.profile || {};
  $("fullName").value = profile.fullName || "";
  $("email").value = profile.email || "";
  $("phone").value = profile.phone || "";
  $("location").value = profile.location || "";
  $("title").value = profile.title || "";
  $("linkedin").value = profile.linkedin || "";
  $("experience").value = profile.experience || "";
  $("stack").value = profile.stack || "";
  $("education").value = profile.education || "";
  $("languages").value = profile.languages || "";
  $("availability").value = profile.availability || "";
  $("salaryExpectation").value = profile.salaryExpectation || "";
  $("coverLetterDefault").value = profile.coverLetterDefault || "";

  // CV Text
  $("cvText").value = result.cvText || "";

  // Blacklisted Companies
  const blacklist = result.blacklistedCompanies || [];
  $("blacklistedCompanies").value = blacklist.join("\n");
  updateBlacklistCount(blacklist.length);

  // Auto-Apply Settings
  const settings = result.autoApplySettings || {};
  $("maxJobsPerSession").value = settings.maxJobsPerSession || 25;
  $("delayJobMin").value = settings.delayBetweenJobs?.min || 8000;
  $("delayJobMax").value = settings.delayBetweenJobs?.max || 20000;
  $("delayStepMin").value = settings.delayBetweenSteps?.min || 1500;
  $("delayStepMax").value = settings.delayBetweenSteps?.max || 4000;
}

function updateBlacklistCount(count) {
  const badge = $("blacklistCount");
  if (count > 0) {
    badge.textContent = count;
    badge.style.display = "inline-block";
  } else {
    badge.style.display = "none";
  }
}

// ── Save Settings ───────────────────────────────────────────────────────────
async function saveAll() {
  // Save API key
  await chrome.storage.local.set({ mistralApiKey: $("apiKey").value.trim() });

  // Save profile
  const profile = {
    fullName: $("fullName").value.trim(),
    firstName: $("fullName").value.trim().split(" ")[0],
    lastName: $("fullName").value.trim().split(" ").slice(1).join(" "),
    email: $("email").value.trim(),
    phone: $("phone").value.trim(),
    location: $("location").value.trim(),
    title: $("title").value.trim(),
    linkedin: $("linkedin").value.trim(),
    experience: $("experience").value.trim(),
    stack: $("stack").value.trim(),
    education: $("education").value.trim(),
    languages: $("languages").value.trim(),
    availability: $("availability").value.trim(),
    salaryExpectation: $("salaryExpectation").value.trim(),
    coverLetterDefault: $("coverLetterDefault").value.trim(),
  };
  await chrome.storage.local.set({ profile });

  // Save CV text
  await chrome.storage.local.set({ cvText: $("cvText").value });

  // Save blacklisted companies
  const blacklistRaw = $("blacklistedCompanies").value;
  const blacklist = blacklistRaw
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0);
  await chrome.storage.local.set({ blacklistedCompanies: blacklist });
  updateBlacklistCount(blacklist.length);

  // Save auto-apply settings
  const autoApplySettings = {
    maxJobsPerSession: parseInt($("maxJobsPerSession").value) || 25,
    delayBetweenJobs: {
      min: parseInt($("delayJobMin").value) || 8000,
      max: parseInt($("delayJobMax").value) || 20000,
    },
    delayBetweenSteps: {
      min: parseInt($("delayStepMin").value) || 1500,
      max: parseInt($("delayStepMax").value) || 4000,
    },
    onlyEasyApply: true,
    skipAlreadyApplied: true,
    autoSubmit: true,
    pauseOnUnknownQuestion: true,
  };
  await chrome.storage.local.set({ autoApplySettings });

  showToast("✅ Configuration sauvegardée!");
}

// ── CV Upload & OCR (Tesseract.js) ──────────────────────────────────────────
let uploadedFile = null;

// Drag & drop handler
const uploadArea = $("cvUploadArea");
const fileInput = $("cvFileInput");

uploadArea.addEventListener("click", () => fileInput.click());
uploadArea.addEventListener("dragover", (e) => {
  e.preventDefault();
  uploadArea.classList.add("dragover");
});
uploadArea.addEventListener("dragleave", () => {
  uploadArea.classList.remove("dragover");
});
uploadArea.addEventListener("drop", (e) => {
  e.preventDefault();
  uploadArea.classList.remove("dragover");
  const files = e.dataTransfer.files;
  if (files.length > 0) handleFileSelect(files[0]);
});
fileInput.addEventListener("change", (e) => {
  if (e.target.files.length > 0) handleFileSelect(e.target.files[0]);
});

function handleFileSelect(file) {
  if (file.size > 10 * 1024 * 1024) {
    showToast("Fichier trop volumineux (max 10 MB)", "error");
    return;
  }

  uploadedFile = file;
  uploadArea.innerHTML = `
    <div class="icon">📄</div>
    <div class="text">${file.name}</div>
    <div class="formats">${(file.size / 1024).toFixed(1)} KB — ${file.type || "unknown"}</div>
  `;
  $("extractBtn").style.display = "block";

  if (file.type.startsWith("image/")) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = document.createElement("img");
      img.src = e.target.result;
      img.style.cssText = "max-width: 200px; max-height: 150px; margin-top: 8px; border-radius: 4px;";
      uploadArea.appendChild(img);
    };
    reader.readAsDataURL(file);
  }
}

// OCR Extraction using Tesseract.js (loaded from CDN)
$("extractBtn").addEventListener("click", async () => {
  if (!uploadedFile) return;

  const ocrStatus = $("ocrStatus");
  const progressBar = $("ocrProgress");
  const progressFill = $("ocrProgressBar");

  ocrStatus.textContent = "⏳ Chargement de Tesseract.js...";
  ocrStatus.className = "ocr-status processing";
  progressBar.className = "progress-bar active";
  progressFill.style.width = "5%";
  $("extractBtn").disabled = true;

  try {
    if (!window.Tesseract) {
      await loadScript("https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js");
    }

    ocrStatus.textContent = "🔍 Extraction OCR en cours...";
    progressFill.style.width = "15%";

    let imageData;

    if (uploadedFile.type === "application/pdf") {
      if (!window.pdfjsLib) {
        await loadScript("https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js");
        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
          "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
      }

      ocrStatus.textContent = "📄 Rendu du PDF...";
      progressFill.style.width = "25%";

      const arrayBuffer = await uploadedFile.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      const allText = [];

      for (let i = 1; i <= pdf.numPages; i++) {
        ocrStatus.textContent = `📄 OCR page ${i}/${pdf.numPages}...`;
        progressFill.style.width = `${25 + (i / pdf.numPages) * 60}%`;

        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 2.0 });

        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext("2d");

        await page.render({ canvasContext: ctx, viewport }).promise;

        const textContent = await page.getTextContent();
        const directText = textContent.items.map(item => item.str).join(" ").trim();

        if (directText.length > 50) {
          allText.push(directText);
        } else {
          const result = await Tesseract.recognize(canvas, "fra+eng", {
            logger: (m) => {
              if (m.status === "recognizing text") {
                const pct = 25 + (((i - 1 + m.progress) / pdf.numPages) * 60);
                progressFill.style.width = `${pct}%`;
              }
            },
          });
          allText.push(result.data.text);
        }
      }

      imageData = allText.join("\n\n--- Page ---\n\n");
    } else {
      const result = await Tesseract.recognize(uploadedFile, "fra+eng", {
        logger: (m) => {
          if (m.status === "recognizing text") {
            progressFill.style.width = `${15 + m.progress * 75}%`;
          }
          ocrStatus.textContent = `🔍 ${m.status}... ${Math.round((m.progress || 0) * 100)}%`;
        },
      });
      imageData = result.data.text;
    }

    progressFill.style.width = "95%";

    const cleanedText = cleanOcrText(imageData);

    if (cleanedText.length < 10) {
      ocrStatus.textContent = "⚠️ Très peu de texte extrait. Vérifiez la qualité de l'image.";
      ocrStatus.className = "ocr-status error";
    } else {
      $("cvText").value = cleanedText;
      ocrStatus.textContent = `✅ ${cleanedText.length} caractères extraits avec succès!`;
      ocrStatus.className = "ocr-status success";
    }

    progressFill.style.width = "100%";
    setTimeout(() => {
      progressBar.className = "progress-bar";
    }, 2000);
  } catch (err) {
    console.error("OCR Error:", err);
    ocrStatus.textContent = `❌ Erreur OCR: ${err.message}`;
    ocrStatus.className = "ocr-status error";
    progressBar.className = "progress-bar";
  }

  $("extractBtn").disabled = false;
});

function cleanOcrText(text) {
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[|]/g, "l")
    .replace(/\u00AD/g, "-")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

function loadScript(url) {
  return new Promise(async (resolve, reject) => {
    try {
      // MV3 CSP blocks remote <script> tags on extension pages.
      // Workaround: fetch the script, create a blob URL, then load it.
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      const text = await response.text();
      const blob = new Blob([text], { type: "application/javascript" });
      const blobUrl = URL.createObjectURL(blob);
      const script = document.createElement("script");
      script.src = blobUrl;
      script.onload = () => { URL.revokeObjectURL(blobUrl); resolve(); };
      script.onerror = () => { URL.revokeObjectURL(blobUrl); reject(new Error(`Failed to execute: ${url}`)); };
      document.head.appendChild(script);
    } catch (err) {
      reject(new Error(`Failed to load: ${url} — ${err.message}`));
    }
  });
}

// ── Update blacklist count on input ─────────────────────────────────────────
$("blacklistedCompanies").addEventListener("input", () => {
  const lines = $("blacklistedCompanies").value.split("\n").filter(l => l.trim().length > 0);
  updateBlacklistCount(lines.length);
});

// ── Event Listeners ─────────────────────────────────────────────────────────
$("saveBtn").addEventListener("click", saveAll);

$("resetBtn").addEventListener("click", async () => {
  if (confirm("Réinitialiser l'historique des candidatures, les logs et les stats ?")) {
    await chrome.storage.local.set({
      appliedJobs: {},
      skippedJobs: {},
      pendingJobs: [],
      log: [],
      stats: { applied: 0, skipped: 0, errors: 0, lastRun: null },
    });
    showToast("Historique réinitialisé!");
  }
});

// ── Init ────────────────────────────────────────────────────────────────────
loadSettings();
