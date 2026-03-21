// ============================================================================
// LinkedIn AutoApply — Content Script
// Runs on linkedin.com/jobs/* pages. Detects Easy Apply jobs, automates
// the multi-step application modal, fills forms using Mistral AI.
// ============================================================================

(function () {
  "use strict";

  const VERSION = "1.0.0";
  let isRunning = false;
  let shouldStop = false;
  let appliedCount = 0;
  let sessionStats = { applied: 0, skipped: 0, errors: 0 };

  // ── Utility Functions ───────────────────────────────────────────────────
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function randomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function log(msg, level = "info") {
    const prefix = {
      info: "ℹ️",
      success: "✅",
      warn: "⚠️",
      error: "❌",
    }[level] || "ℹ️";
    console.log(`[LinkedInAutoApply] ${prefix} ${msg}`);
    chrome.runtime.sendMessage({ action: "addLog", message: msg, level }).catch(() => {});
  }

  // ── DOM Helpers ─────────────────────────────────────────────────────────
  function $(selector, root = document) {
    return root.querySelector(selector);
  }

  function $$(selector, root = document) {
    return [...root.querySelectorAll(selector)];
  }

  /**
   * Wait for an element to appear in the DOM
   */
  function waitForElement(selector, timeout = 10000, root = document) {
    return new Promise((resolve, reject) => {
      const el = $(selector, root);
      if (el) return resolve(el);

      const observer = new MutationObserver(() => {
        const el = $(selector, root);
        if (el) {
          observer.disconnect();
          resolve(el);
        }
      });

      observer.observe(root === document ? document.body : root, {
        childList: true,
        subtree: true,
      });

      setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Timeout waiting for: ${selector}`));
      }, timeout);
    });
  }

  /**
   * Find element by text content (case-insensitive, partial match)
   */
  function findByText(tag, texts, root = document) {
    const elements = $$(tag, root);
    for (const el of elements) {
      const elText = el.textContent.trim().toLowerCase();
      for (const text of texts) {
        if (elText.includes(text.toLowerCase())) return el;
      }
    }
    return null;
  }

  /**
   * Simulate human-like typing
   */
  async function humanType(element, text) {
    element.focus();
    element.dispatchEvent(new Event("focus", { bubbles: true }));

    // Clear existing value
    if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
      element.value = "";
      element.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      // contenteditable div
      element.textContent = "";
    }

    for (const char of text) {
      if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
        element.value += char;
      } else {
        element.textContent += char;
      }
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new KeyboardEvent("keydown", { key: char, bubbles: true }));
      element.dispatchEvent(new KeyboardEvent("keyup", { key: char, bubbles: true }));
      await sleep(randomDelay(10, 40));
    }

    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  /**
   * Set a value directly (for inputs that need it)
   */
  function setNativeValue(element, value) {
    const valueSetter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(element), "value"
    )?.set;
    if (valueSetter) {
      valueSetter.call(element, value);
    } else {
      element.value = value;
    }
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /**
   * Click an element with human-like mouse events
   */
  async function humanClick(element) {
    if (!element) return;
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    await sleep(randomDelay(200, 500));

    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2 + randomDelay(-2, 2);
    const y = rect.top + rect.height / 2 + randomDelay(-2, 2);

    element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: x, clientY: y }));
    await sleep(randomDelay(50, 150));
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: x, clientY: y }));
    await sleep(randomDelay(30, 80));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: x, clientY: y }));
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x, clientY: y }));
    element.click();
  }

  // ── LinkedIn Easy Apply Detection ───────────────────────────────────────

  /**
   * Find all Easy Apply buttons on the page (job listings or job detail)
   */
  function findEasyApplyButton() {
    // LinkedIn uses various selectors for Easy Apply button
    const selectors = [
      // Job detail page - main apply button
      'button.jobs-apply-button',
      'button[aria-label*="Easy Apply"]',
      'button[aria-label*="Candidature simplifiée"]',
      // New LinkedIn DOM (hashed classes) - use text content
    ];

    for (const sel of selectors) {
      const btn = $(sel);
      if (btn && btn.offsetParent !== null) return btn;
    }

    // Fallback: find by text content
    const buttons = $$("button");
    for (const btn of buttons) {
      const text = btn.textContent.trim().toLowerCase();
      if (
        (text.includes("easy apply") || text.includes("candidature simplifiée")) &&
        btn.offsetParent !== null &&
        !btn.disabled
      ) {
        return btn;
      }
    }

    // Also check spans inside buttons (LinkedIn's new DOM)
    const spans = $$("span");
    for (const span of spans) {
      const text = span.textContent.trim().toLowerCase();
      if (text === "candidature simplifiée" || text === "easy apply") {
        // Walk up to find the clickable parent (button or anchor)
        let parent = span.parentElement;
        while (parent && parent.tagName !== "BUTTON" && parent.tagName !== "A") {
          parent = parent.parentElement;
          if (parent === document.body) return span; // fallback to span itself
        }
        return parent || span;
      }
    }

    return null;
  }

  /**
   * Check if the Easy Apply modal is currently open
   */
  function isModalOpen() {
    // LinkedIn Easy Apply modal indicators
    const modalSelectors = [
      'div[data-test-modal]',
      'div.artdeco-modal',
      'div[role="dialog"]',
      'div.jobs-easy-apply-modal',
      '#artdeco-modal-outlet div[role="dialog"]',
    ];

    for (const sel of modalSelectors) {
      const modal = $(sel);
      if (modal && modal.offsetParent !== null) return modal;
    }

    // Check #interop-outlet for the new LinkedIn UI
    const interop = $("#interop-outlet");
    if (interop) {
      const dialog = $('div[role="dialog"]', interop) || $('div[class*="modal"]', interop);
      if (dialog) return dialog;
    }

    return null;
  }

  /**
   * Get the current job info from the page
   */
  function getCurrentJobInfo() {
    const info = { title: "", company: "", description: "", jobId: "", url: window.location.href };

    // Job title
    const titleSelectors = [
      'h1.t-24', 'h1.job-title', 'h1.jobs-unified-top-card__job-title',
      'h1 a.ember-view', 'h2.t-24',
      'h1', // generic fallback
    ];
    for (const sel of titleSelectors) {
      const el = $(sel);
      if (el?.textContent?.trim()) {
        info.title = el.textContent.trim();
        break;
      }
    }

    // Company name
    const companySelectors = [
      'a.ember-view.t-black.t-normal span',
      '.jobs-unified-top-card__company-name a',
      '.job-details-jobs-unified-top-card__company-name a',
      'span.jobs-unified-top-card__company-name',
      'a[href*="/company/"]',
    ];
    for (const sel of companySelectors) {
      const el = $(sel);
      if (el?.textContent?.trim()) {
        info.company = el.textContent.trim();
        break;
      }
    }

    // Also try the new DOM: look for company text near the job title
    if (!info.company) {
      const companySpans = $$("span");
      for (const span of companySpans) {
        const parent = span.closest("div");
        if (parent && parent.querySelector('a[href*="/company/"]')) {
          const link = parent.querySelector('a[href*="/company/"]');
          info.company = link.textContent.trim();
          break;
        }
      }
    }

    // Job description
    const descSelectors = [
      '.jobs-description__content',
      '.jobs-description-content__text',
      'div#job-details',
      'article div.jobs-description',
    ];
    for (const sel of descSelectors) {
      const el = $(sel);
      if (el?.textContent?.trim()) {
        info.description = el.textContent.trim().substring(0, 1000);
        break;
      }
    }

    // Job ID from URL
    const jobIdMatch = window.location.href.match(/currentJobId=(\d+)/);
    if (jobIdMatch) info.jobId = jobIdMatch[1];
    if (!info.jobId) {
      const jobIdMatch2 = window.location.href.match(/\/jobs\/view\/(\d+)/);
      if (jobIdMatch2) info.jobId = jobIdMatch2[1];
    }

    return info;
  }

  // ── Modal Form Handling ─────────────────────────────────────────────────

  /**
   * Find all form fields in the current modal step
   */
  function getModalFormFields(modal) {
    const fields = [];

    if (!modal) return fields;

    // Text inputs
    const inputs = $$('input[type="text"], input[type="tel"], input[type="email"], input[type="number"], input[type="url"], input:not([type])', modal);
    for (const input of inputs) {
      if (input.offsetParent === null || input.disabled) continue;
      const label = findLabelForInput(input, modal);
      fields.push({
        element: input,
        type: input.type || "text",
        label: label,
        value: input.value,
        required: input.required || input.getAttribute("aria-required") === "true",
      });
    }

    // Textareas
    const textareas = $$("textarea", modal);
    for (const ta of textareas) {
      if (ta.offsetParent === null || ta.disabled) continue;
      const label = findLabelForInput(ta, modal);
      fields.push({
        element: ta,
        type: "textarea",
        label: label,
        value: ta.value,
        required: ta.required || ta.getAttribute("aria-required") === "true",
      });
    }

    // Select dropdowns
    const selects = $$("select", modal);
    for (const sel of selects) {
      if (sel.offsetParent === null || sel.disabled) continue;
      const label = findLabelForInput(sel, modal);
      const options = [...sel.options].map((o) => o.text).filter((t) => t && t !== "--" && t !== "Select an option" && t !== "Sélectionnez une option");
      fields.push({
        element: sel,
        type: "select",
        label: label,
        value: sel.value,
        options: options,
        required: sel.required || sel.getAttribute("aria-required") === "true",
      });
    }

    // Radio button groups
    const radioGroups = {};
    const radios = $$('input[type="radio"]', modal);
    for (const radio of radios) {
      const name = radio.name;
      if (!radioGroups[name]) {
        radioGroups[name] = {
          elements: [],
          labels: [],
          groupLabel: "",
        };
      }
      radioGroups[name].elements.push(radio);
      const lbl = findLabelForInput(radio, modal);
      radioGroups[name].labels.push(lbl);
    }
    for (const [name, group] of Object.entries(radioGroups)) {
      // Find the group label (fieldset legend or nearby label)
      const firstRadio = group.elements[0];
      const fieldset = firstRadio.closest("fieldset");
      const legend = fieldset ? $("legend", fieldset) : null;
      const groupLabel = legend?.textContent?.trim() || findLabelForInput(firstRadio, modal);

      fields.push({
        element: group.elements[0],
        elements: group.elements,
        type: "radio",
        label: groupLabel,
        options: group.labels,
        value: group.elements.find(r => r.checked)?.value || "",
        required: group.elements[0].required,
      });
    }

    // Checkboxes (single)
    const checkboxes = $$('input[type="checkbox"]', modal);
    for (const cb of checkboxes) {
      if (cb.offsetParent === null || cb.disabled) continue;
      const label = findLabelForInput(cb, modal);
      fields.push({
        element: cb,
        type: "checkbox",
        label: label,
        value: cb.checked,
        required: cb.required,
      });
    }

    // LinkedIn's custom dropdown buttons (artdeco-dropdown)
    const dropdownTriggers = $$('button[role="combobox"], button[data-test-text-selectable-option]', modal);
    for (const trigger of dropdownTriggers) {
      const label = findLabelForInput(trigger, modal);
      fields.push({
        element: trigger,
        type: "dropdown-button",
        label: label,
        value: trigger.textContent.trim(),
        required: trigger.getAttribute("aria-required") === "true",
      });
    }

    return fields;
  }

  /**
   * Find the label text for a form input
   */
  function findLabelForInput(input, root) {
    // Try explicit label[for=id]
    if (input.id) {
      const label = $(`label[for="${input.id}"]`, root);
      if (label) return label.textContent.trim();
    }

    // Try wrapping label
    const parentLabel = input.closest("label");
    if (parentLabel) return parentLabel.textContent.trim();

    // Try aria-label
    if (input.getAttribute("aria-label")) {
      return input.getAttribute("aria-label").trim();
    }

    // Try aria-labelledby
    const labelledBy = input.getAttribute("aria-labelledby");
    if (labelledBy) {
      const labelEl = document.getElementById(labelledBy);
      if (labelEl) return labelEl.textContent.trim();
    }

    // Try placeholder
    if (input.placeholder) return input.placeholder.trim();

    // Try preceding sibling label or span
    const prevSibling = input.previousElementSibling;
    if (prevSibling && (prevSibling.tagName === "LABEL" || prevSibling.tagName === "SPAN")) {
      return prevSibling.textContent.trim();
    }

    // Try parent container's first label or span
    const container = input.closest("div");
    if (container) {
      const label = $("label, span.t-14, span.t-bold", container);
      if (label && label !== input) return label.textContent.trim();
    }

    return input.name || input.id || "Unknown field";
  }

  // ── Fill a Single Form Field ────────────────────────────────────────────

  /**
   * Fill a form field with an AI-generated or default answer
   */
  async function fillField(field, jobInfo) {
    // Skip already filled fields (unless empty)
    if (field.value && field.type !== "select" && field.type !== "radio" && field.type !== "checkbox") {
      log(`Champ "${field.label}" déjà rempli: "${field.value}"`, "info");
      return;
    }

    // For select with a value already selected (not the placeholder)
    if (field.type === "select" && field.value && field.value !== "" && field.element.selectedIndex > 0) {
      log(`Select "${field.label}" déjà sélectionné`, "info");
      return;
    }

    log(`Remplissage: "${field.label}" (${field.type})`);

    try {
      // Ask the background script (which calls Mistral) for an answer
      const response = await chrome.runtime.sendMessage({
        action: "generateAnswer",
        question: field.label,
        fieldType: field.type === "textarea" ? "textarea" : field.type === "select" ? "select" : field.type === "radio" ? "radio" : field.type === "number" ? "number" : "text",
        options: field.options || [],
        jobInfo: jobInfo,
      });

      const answer = response?.answer;
      if (!answer) {
        log(`Pas de réponse pour "${field.label}"`, "warn");
        return;
      }

      await sleep(randomDelay(300, 800));

      switch (field.type) {
        case "text":
        case "tel":
        case "email":
        case "url":
        case "number":
          await humanType(field.element, answer);
          break;

        case "textarea":
          await humanType(field.element, answer);
          break;

        case "select": {
          const options = [...field.element.options];
          const matchIdx = options.findIndex(
            (o) => o.text.toLowerCase().trim() === answer.toLowerCase().trim()
          );
          if (matchIdx >= 0) {
            field.element.selectedIndex = matchIdx;
          } else {
            // Fuzzy match
            const fuzzyIdx = options.findIndex(
              (o) =>
                o.text.toLowerCase().includes(answer.toLowerCase()) ||
                answer.toLowerCase().includes(o.text.toLowerCase())
            );
            if (fuzzyIdx >= 0) {
              field.element.selectedIndex = fuzzyIdx;
            } else {
              // Default to first non-placeholder option
              field.element.selectedIndex = Math.min(1, options.length - 1);
            }
          }
          field.element.dispatchEvent(new Event("change", { bubbles: true }));
          break;
        }

        case "radio": {
          if (field.elements) {
            // Find the radio that matches the answer
            let targetRadio = null;
            for (let i = 0; i < field.elements.length; i++) {
              const radioLabel = field.options[i]?.toLowerCase().trim();
              if (radioLabel === answer.toLowerCase().trim() || radioLabel?.includes(answer.toLowerCase())) {
                targetRadio = field.elements[i];
                break;
              }
            }
            // Default: click the first "Yes"/"Oui" radio, or first one
            if (!targetRadio) {
              targetRadio = field.elements.find((r, i) => {
                const lbl = field.options[i]?.toLowerCase();
                return lbl?.includes("oui") || lbl?.includes("yes");
              }) || field.elements[0];
            }
            if (targetRadio) {
              await humanClick(targetRadio);
            }
          }
          break;
        }

        case "checkbox": {
          // For checkboxes, check if the answer implies checking
          const shouldCheck = /oui|yes|true|1|accept|j'accepte/i.test(answer);
          if (shouldCheck && !field.element.checked) {
            await humanClick(field.element);
          }
          break;
        }

        case "dropdown-button": {
          // LinkedIn custom dropdown - click to open, then select option
          await humanClick(field.element);
          await sleep(randomDelay(500, 1000));
          // Find the dropdown options
          const listbox = $('ul[role="listbox"], div[role="listbox"]');
          if (listbox) {
            const optionEls = $$('li[role="option"], div[role="option"]', listbox);
            const targetOpt = optionEls.find(
              (o) => o.textContent.toLowerCase().trim().includes(answer.toLowerCase())
            ) || optionEls[0];
            if (targetOpt) await humanClick(targetOpt);
          }
          break;
        }
      }

      log(`✓ "${field.label}" = "${answer}"`, "success");
    } catch (err) {
      log(`Erreur remplissage "${field.label}": ${err.message}`, "error");
    }
  }

  // ── Modal Navigation ────────────────────────────────────────────────────

  /**
   * Find the "Next" / "Continue" / "Submit" button in the modal
   */
  function findNextButton(modal) {
    if (!modal) return null;

    // Check for submit button first (final step)
    const submitTexts = [
      "envoyer la candidature", "submit application", "soumettre",
      "envoyer", "submit", "postuler",
    ];
    const allButtons = $$("button", modal);

    // Look for submit / final action button
    for (const btn of allButtons) {
      const text = btn.textContent.trim().toLowerCase();
      if (submitTexts.some((t) => text.includes(t)) && !btn.disabled) {
        return { button: btn, isSubmit: true };
      }
    }

    // Look for next/continue buttons
    const nextTexts = [
      "suivant", "next", "continuer", "continue", "réviser", "review",
    ];
    for (const btn of allButtons) {
      const text = btn.textContent.trim().toLowerCase();
      if (nextTexts.some((t) => text.includes(t)) && !btn.disabled) {
        return { button: btn, isSubmit: false };
      }
    }

    // Also check for spans within buttons
    const spans = $$("span", modal);
    for (const span of spans) {
      const text = span.textContent.trim().toLowerCase();
      if (submitTexts.some((t) => text.includes(t))) {
        const btn = span.closest("button, a");
        if (btn && !btn.disabled) return { button: btn, isSubmit: true };
      }
    }
    for (const span of spans) {
      const text = span.textContent.trim().toLowerCase();
      if (nextTexts.some((t) => text.includes(t))) {
        const btn = span.closest("button, a");
        if (btn && !btn.disabled) return { button: btn, isSubmit: false };
      }
    }

    // Also try aria-label on buttons
    for (const btn of allButtons) {
      const ariaLabel = (btn.getAttribute("aria-label") || "").toLowerCase();
      if (submitTexts.some((t) => ariaLabel.includes(t)) && !btn.disabled) {
        return { button: btn, isSubmit: true };
      }
      if (nextTexts.some((t) => ariaLabel.includes(t)) && !btn.disabled) {
        return { button: btn, isSubmit: false };
      }
    }

    return null;
  }

  /**
   * Find the dismiss/close button for the modal
   */
  function findDismissButton(modal) {
    if (!modal) return null;

    const selectors = [
      'button[aria-label*="Dismiss"]',
      'button[aria-label*="Fermer"]',
      'button[aria-label*="Close"]',
      'button[data-test-modal-close-btn]',
      'button.artdeco-modal__dismiss',
    ];

    for (const sel of selectors) {
      const btn = $(sel, modal) || $(sel); // try both in modal and globally
      if (btn) return btn;
    }

    // Fallback: look for X or close button
    const buttons = $$("button", modal);
    for (const btn of buttons) {
      const ariaLabel = (btn.getAttribute("aria-label") || "").toLowerCase();
      if (ariaLabel.includes("dismiss") || ariaLabel.includes("fermer") || ariaLabel.includes("close")) {
        return btn;
      }
      // SVG close icon (X button)
      const svg = $("svg", btn);
      if (svg && btn.children.length === 1 && !btn.textContent.trim()) {
        return btn; // likely a close icon button
      }
    }

    return null;
  }

  /**
   * Detect if the modal is showing an error or "already applied" message
   */
  function detectModalStatus(modal) {
    if (!modal) return "unknown";

    const text = modal.textContent.toLowerCase();

    if (text.includes("already applied") || text.includes("déjà postulé") || text.includes("candidature déjà envoyée")) {
      return "already_applied";
    }

    if (text.includes("application submitted") || text.includes("candidature envoyée") || text.includes("your application was sent")) {
      return "success";
    }

    if (text.includes("error") || text.includes("erreur") || text.includes("something went wrong")) {
      return "error";
    }

    return "in_progress";
  }

  // ── Main Apply Flow ─────────────────────────────────────────────────────

  /**
   * Apply to a single job by walking through the Easy Apply modal
   */
  async function applyToCurrentJob(settings) {
    const jobInfo = getCurrentJobInfo();
    log(`Candidature: ${jobInfo.title} @ ${jobInfo.company}`);

    // Step 1: Click Easy Apply button
    const easyApplyBtn = findEasyApplyButton();
    if (!easyApplyBtn) {
      log("Bouton Easy Apply non trouvé", "warn");
      return { success: false, reason: "no_easy_apply_button" };
    }

    await humanClick(easyApplyBtn);
    await sleep(randomDelay(1500, 3000));

    // Step 2: Wait for modal to open
    let modal = isModalOpen();
    if (!modal) {
      // Try again with longer wait
      await sleep(2000);
      modal = isModalOpen();
    }
    if (!modal) {
      log("Modal Easy Apply ne s'ouvre pas", "error");
      return { success: false, reason: "modal_not_opened" };
    }

    // Step 3: Walk through multi-step form
    const maxSteps = 10;
    let step = 0;

    while (step < maxSteps && !shouldStop) {
      step++;
      log(`Étape ${step}...`);

      // Check modal status
      const status = detectModalStatus(modal);
      if (status === "already_applied") {
        log("Déjà postulé à ce poste", "warn");
        const dismissBtn = findDismissButton(modal);
        if (dismissBtn) await humanClick(dismissBtn);
        return { success: false, reason: "already_applied" };
      }
      if (status === "success") {
        log("Candidature envoyée avec succès!", "success");
        // Close the success modal
        const dismissBtn = findDismissButton(modal) || findByText("button", ["fermer", "close", "done", "terminé"], modal);
        if (dismissBtn) {
          await sleep(randomDelay(500, 1000));
          await humanClick(dismissBtn);
        }
        return { success: true };
      }

      // Find and fill form fields
      const fields = getModalFormFields(modal);
      log(`${fields.length} champ(s) trouvé(s) à l'étape ${step}`);

      for (const field of fields) {
        if (shouldStop) break;
        await fillField(field, jobInfo);
        await sleep(randomDelay(settings.delayBetweenSteps?.min || 1000, settings.delayBetweenSteps?.max || 3000));
      }

      // Find and click Next/Submit
      await sleep(randomDelay(500, 1500));
      const nextAction = findNextButton(modal);

      if (!nextAction) {
        log("Pas de bouton Suivant/Envoyer trouvé", "warn");
        // Maybe it's the success screen?
        const statusCheck = detectModalStatus(modal);
        if (statusCheck === "success") {
          log("Candidature envoyée!", "success");
          const dismissBtn = findDismissButton(modal);
          if (dismissBtn) await humanClick(dismissBtn);
          return { success: true };
        }
        // Close modal and bail
        const dismissBtn = findDismissButton(modal);
        if (dismissBtn) await humanClick(dismissBtn);
        return { success: false, reason: "no_next_button" };
      }

      if (nextAction.isSubmit) {
        if (!settings.autoSubmit) {
          log("Mode review: candidature prête mais pas envoyée (autoSubmit=false)", "warn");
          return { success: false, reason: "manual_submit_required" };
        }
        log("Envoi de la candidature...", "info");
        await humanClick(nextAction.button);
        await sleep(randomDelay(2000, 4000));

        // Check for success
        modal = isModalOpen();
        if (modal) {
          const finalStatus = detectModalStatus(modal);
          if (finalStatus === "success") {
            log("Candidature envoyée avec succès!", "success");
            const dismissBtn = findDismissButton(modal) || findByText("button", ["fermer", "close", "done", "terminé"], modal);
            if (dismissBtn) {
              await sleep(randomDelay(500, 1000));
              await humanClick(dismissBtn);
            }
            return { success: true };
          }
        }
        // Even if we can't confirm, assume success after submit
        return { success: true };
      }

      // Click Next/Continue
      log("Clic sur Suivant/Continuer...");
      await humanClick(nextAction.button);
      await sleep(randomDelay(1500, 3000));

      // Re-detect modal (it might have updated)
      modal = isModalOpen();
      if (!modal) {
        log("Modal fermé après clic Suivant", "warn");
        return { success: false, reason: "modal_closed_unexpectedly" };
      }
    }

    if (step >= maxSteps) {
      log("Trop d'étapes (>10) — abandon", "error");
      const dismissBtn = findDismissButton(modal);
      if (dismissBtn) await humanClick(dismissBtn);
      return { success: false, reason: "too_many_steps" };
    }

    return { success: false, reason: "stopped" };
  }

  // ── Job List Scanning ───────────────────────────────────────────────────

  /**
   * Get all job cards from the search results page
   */
  function getJobCards() {
    const cards = [];
    // LinkedIn job cards in search results
    const cardSelectors = [
      "li.jobs-search-results__list-item",
      "li.ember-view.occludable-update",
      'div[data-job-id]',
      'li[data-occludable-job-id]',
    ];

    for (const sel of cardSelectors) {
      const els = $$(sel);
      if (els.length > 0) {
        for (const el of els) {
          const jobId = el.getAttribute("data-job-id") ||
            el.getAttribute("data-occludable-job-id") ||
            el.querySelector("a")?.href?.match(/\/jobs\/view\/(\d+)/)?.[1] ||
            "";
          cards.push({ element: el, jobId });
        }
        return cards;
      }
    }

    // Fallback: any list items in the job list container
    const listContainer = $("ul.jobs-search-results__list, div.jobs-search-results-list");
    if (listContainer) {
      const items = $$("li", listContainer);
      for (const item of items) {
        const link = $("a", item);
        const jobIdMatch = link?.href?.match(/\/jobs\/view\/(\d+)/);
        cards.push({ element: item, jobId: jobIdMatch?.[1] || "" });
      }
    }

    return cards;
  }

  /**
   * Click on a job card to open its details
   */
  async function clickJobCard(card) {
    const link = $("a", card.element) || card.element;
    await humanClick(link);
    await sleep(randomDelay(2000, 4000));
  }

  /**
   * Check if a job has an Easy Apply badge in the search results
   */
  function hasEasyApplyBadge(cardElement) {
    const text = cardElement.textContent.toLowerCase();
    return text.includes("easy apply") || text.includes("candidature simplifiée");
  }

  // ── Auto Apply Session ──────────────────────────────────────────────────

  /**
   * Run a full auto-apply session on the current job search results page
   */
  async function runAutoApplySession() {
    if (isRunning) {
      log("Session déjà en cours", "warn");
      return;
    }

    isRunning = true;
    shouldStop = false;
    sessionStats = { applied: 0, skipped: 0, errors: 0 };

    const state = await chrome.runtime.sendMessage({ action: "getState" });
    const settings = state.autoApplySettings || {};
    const maxJobs = settings.maxJobsPerSession || 25;
    const appliedJobs = state.appliedJobs || {};

    log(`🚀 Session AutoApply démarrée (max ${maxJobs} jobs)`);

    try {
      const jobCards = getJobCards();
      log(`${jobCards.length} offre(s) trouvée(s) sur la page`);

      for (let i = 0; i < jobCards.length && sessionStats.applied < maxJobs && !shouldStop; i++) {
        const card = jobCards[i];

        // Skip if already applied
        if (card.jobId && appliedJobs[card.jobId]) {
          log(`Ignoré (déjà postulé): job ${card.jobId}`, "info");
          sessionStats.skipped++;
          continue;
        }

        // Skip if no Easy Apply badge
        if (settings.onlyEasyApply && !hasEasyApplyBadge(card.element)) {
          sessionStats.skipped++;
          continue;
        }

        // Click the job card to load its details
        await clickJobCard(card);

        // Get updated job info
        const jobInfo = getCurrentJobInfo();
        if (!jobInfo.jobId && card.jobId) jobInfo.jobId = card.jobId;

        // Check again for Easy Apply on the detail page
        const easyApplyBtn = findEasyApplyButton();
        if (!easyApplyBtn) {
          log(`Pas de Easy Apply: ${jobInfo.title}`, "info");
          sessionStats.skipped++;
          chrome.runtime.sendMessage({
            action: "markSkipped",
            jobId: jobInfo.jobId,
            title: jobInfo.title,
            reason: "Pas de candidature simplifiée",
          }).catch(() => {});
          continue;
        }

        // Apply to this job
        const result = await applyToCurrentJob(settings);

        if (result.success) {
          sessionStats.applied++;
          chrome.runtime.sendMessage({
            action: "markApplied",
            jobId: jobInfo.jobId,
            title: jobInfo.title,
            company: jobInfo.company,
            url: jobInfo.url,
          }).catch(() => {});
        } else if (result.reason === "already_applied") {
          sessionStats.skipped++;
          chrome.runtime.sendMessage({
            action: "markSkipped",
            jobId: jobInfo.jobId,
            title: jobInfo.title,
            reason: "Déjà postulé",
          }).catch(() => {});
        } else {
          sessionStats.errors++;
          chrome.runtime.sendMessage({
            action: "markError",
            jobId: jobInfo.jobId,
            title: jobInfo.title,
            error: result.reason,
          }).catch(() => {});
        }

        // Random delay between jobs
        const delay = randomDelay(
          settings.delayBetweenJobs?.min || 8000,
          settings.delayBetweenJobs?.max || 20000
        );
        log(`Pause ${Math.round(delay / 1000)}s avant le prochain job...`);
        await sleep(delay);
      }
    } catch (err) {
      log(`Erreur session: ${err.message}`, "error");
    }

    isRunning = false;
    log(`🏁 Session terminée — ${sessionStats.applied} candidature(s), ${sessionStats.skipped} ignorée(s), ${sessionStats.errors} erreur(s)`, "success");
  }

  /**
   * Apply to only the currently viewed job (single job mode)
   */
  async function applySingleJob() {
    if (isRunning) {
      log("Déjà en cours", "warn");
      return;
    }

    isRunning = true;
    shouldStop = false;

    const state = await chrome.runtime.sendMessage({ action: "getState" });
    const settings = state.autoApplySettings || {};

    try {
      const result = await applyToCurrentJob(settings);
      const jobInfo = getCurrentJobInfo();

      if (result.success) {
        chrome.runtime.sendMessage({
          action: "markApplied",
          jobId: jobInfo.jobId,
          title: jobInfo.title,
          company: jobInfo.company,
          url: jobInfo.url,
        }).catch(() => {});
        log("Candidature unique envoyée!", "success");
      } else {
        log(`Échec candidature unique: ${result.reason}`, "error");
      }
    } catch (err) {
      log(`Erreur: ${err.message}`, "error");
    }

    isRunning = false;
  }

  // ── Message Handler ─────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "startAutoApply") {
      runAutoApplySession().then(() => sendResponse({ ok: true }));
      return true;
    }

    if (msg.action === "applySingleJob") {
      applySingleJob().then(() => sendResponse({ ok: true }));
      return true;
    }

    if (msg.action === "stopAutoApply") {
      shouldStop = true;
      log("Arrêt demandé...", "warn");
      sendResponse({ ok: true });
      return;
    }

    if (msg.action === "getContentStatus") {
      sendResponse({
        isRunning,
        sessionStats,
        url: window.location.href,
        version: VERSION,
      });
      return;
    }
  });

  // ── Visual Indicator ────────────────────────────────────────────────────
  function addStatusBadge() {
    if (document.getElementById("linkedin-autoapply-badge")) return;

    const badge = document.createElement("div");
    badge.id = "linkedin-autoapply-badge";
    badge.style.cssText = `
      position: fixed; bottom: 20px; right: 20px; z-index: 99999;
      background: linear-gradient(135deg, #0077b5, #00a0dc);
      color: white; padding: 8px 16px; border-radius: 20px;
      font-size: 12px; font-weight: 600; box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      cursor: pointer; user-select: none; transition: all 0.3s;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    `;
    badge.textContent = "🚀 AutoApply v" + VERSION;
    badge.title = "LinkedIn AutoApply actif";

    badge.addEventListener("mouseenter", () => {
      badge.style.transform = "scale(1.05)";
    });
    badge.addEventListener("mouseleave", () => {
      badge.style.transform = "scale(1)";
    });

    document.body.appendChild(badge);
  }

  // ── Init ────────────────────────────────────────────────────────────────
  addStatusBadge();
  log(`LinkedIn AutoApply v${VERSION} chargé sur ${window.location.href}`);
})();
