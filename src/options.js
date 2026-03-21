// ============================================================================
// LinkedIn AutoApply — Options Page Script
// Handles profile editing, CV upload+OCR (Tesseract.js in-browser), settings.
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

  // Auto-Apply Settings
  const settings = result.autoApplySettings || {};
  $("maxJobsPerSession").value = settings.maxJobsPerSession || 25;
  $("delayJobMin").value = settings.delayBetweenJobs?.min || 8000;
  $("delayJobMax").value = settings.delayBetweenJobs?.max || 20000;
  $("delayStepMin").value = settings.delayBetweenSteps?.min || 1500;
  $("delayStepMax").value = settings.delayBetweenSteps?.max || 4000;
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

  // For text-based PDFs or images, show preview
  if (file.type.startsWith("image/")) {
    // Show a small image preview
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
    // Load Tesseract.js from CDN if not already loaded
    if (!window.Tesseract) {
      await loadScript("https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js");
    }

    ocrStatus.textContent = "🔍 Extraction OCR en cours...";
    progressFill.style.width = "15%";

    let imageData;

    if (uploadedFile.type === "application/pdf") {
      // For PDFs, we need to render them to canvas first
      // Load PDF.js from CDN
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
        const viewport = page.getViewport({ scale: 2.0 }); // Higher scale = better OCR

        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext("2d");

        await page.render({ canvasContext: ctx, viewport }).promise;

        // First try to extract text directly from PDF (for text-based PDFs)
        const textContent = await page.getTextContent();
        const directText = textContent.items.map(item => item.str).join(" ").trim();

        if (directText.length > 50) {
          // PDF has embedded text, no need for OCR
          allText.push(directText);
        } else {
          // Use Tesseract OCR for scanned PDF pages
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
      // For images, OCR directly
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

    // Clean up extracted text
    const cleanedText = cleanOcrText(imageData);

    if (cleanedText.length < 10) {
      ocrStatus.textContent = "⚠️ Très peu de texte extrait. Vérifiez la qualité de l'image.";
      ocrStatus.className = "ocr-status error";
    } else {
      // Set the extracted text in the CV textarea
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

/**
 * Clean up OCR-extracted text
 */
function cleanOcrText(text) {
  return text
    // Normalize whitespace
    .replace(/[ \t]+/g, " ")
    // Remove excessive blank lines
    .replace(/\n{3,}/g, "\n\n")
    // Fix common OCR artifacts
    .replace(/[|]/g, "l")
    .replace(/\u00AD/g, "-") // soft hyphens
    // Trim each line
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * Load a script from URL
 */
function loadScript(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Failed to load: ${url}`));
    document.head.appendChild(script);
  });
}

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
