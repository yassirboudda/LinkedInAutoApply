// ============================================================================
// LinkedIn AutoApply — Content Script v1.7.0
// Handles DOM interactions: form filling, modal navigation, multi-page session.
// v1.7.0: Fix date fields, location typeahead selection, required checkboxes
// v1.6.0: Fix clickJobCard — use URL currentJobId param (no <a> click/navigation)
// v1.5.0: Typeahead handling, button retry
// v1.4.0: Direct storage reads, blacklist, improved button detection
// ============================================================================
(function () {
  if (window.__LinkedInAutoApply_loaded) return;
  window.__LinkedInAutoApply_loaded = true;

  const VERSION = "1.7.0";
  let isRunning = false;
  let shouldStop = false;
  const sessionStats = { applied: 0, skipped: 0, errors: 0 };

  // ── Helpers ───────────────────────────────────────────────────────────
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const randomDelay = (min, max) => Math.floor(Math.random() * (max - min)) + min;

  function log(msg, level = "info") {
    const prefix = { error: "❌", warn: "⚠️", success: "✅", info: "ℹ️" }[level] || "ℹ️";
    console.log(`[LinkedInAutoApply] ${prefix} ${msg}`);
    chrome.runtime.sendMessage({ action: "addLog", message: msg, level }).catch(() => {});
  }

  // ── DOM Helpers ─────────────────────────────────────────────────────────
  function $(selector, root = document) { return root.querySelector(selector); }
  function $$(selector, root = document) { return [...root.querySelectorAll(selector)]; }

  function waitForElement(selector, timeout = 10000, root = document) {
    return new Promise((resolve, reject) => {
      const el = $(selector, root);
      if (el) return resolve(el);
      const observer = new MutationObserver(() => {
        const el = $(selector, root);
        if (el) { observer.disconnect(); resolve(el); }
      });
      observer.observe(root === document ? document.body : root, {
        childList: true, subtree: true,
      });
      setTimeout(() => { observer.disconnect(); reject(new Error(`Timeout: ${selector}`)); }, timeout);
    });
  }

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

  async function humanType(element, text) {
    element.focus();
    element.dispatchEvent(new Event("focus", { bubbles: true }));
    if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
      element.value = "";
      element.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
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

  function setNativeValue(element, value) {
    const valueSetter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(element), "value"
    )?.set;
    if (valueSetter) { valueSetter.call(element, value); }
    else { element.value = value; }
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

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

  // ── Typeahead / Autocomplete Dropdown Handler ──────────────────────────
  async function handleTypeaheadDropdown(inputElement, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      // Wait for typeahead dropdown to appear (LinkedIn debounces input)
      await sleep(800 + attempt * 400);

      const dropdownSelectors = [
        'div[role="listbox"]',
        'ul[role="listbox"]',
        '.basic-typeahead__triggered-content',
        '[id*="typeahead"][role="listbox"]',
        'div.typeahead-results',
        'ul.typeahead-results',
      ];

      for (const sel of dropdownSelectors) {
        const dropdown = document.querySelector(sel);
        if (dropdown && dropdown.offsetParent !== null) {
          const options = [
            ...dropdown.querySelectorAll('[role="option"]'),
            ...dropdown.querySelectorAll('li.basic-typeahead__selectable'),
            ...dropdown.querySelectorAll('li[id*="typeahead"]'),
            ...dropdown.querySelectorAll('li'),
          ];
          // Deduplicate
          const seen = new Set();
          const uniqueOptions = options.filter(o => {
            if (seen.has(o) || o.offsetParent === null) return false;
            seen.add(o); return true;
          });

          if (uniqueOptions.length > 0) {
            const first = uniqueOptions[0];
            log(`[DEBUG] Typeahead: ${uniqueOptions.length} option(s) — sélection: "${first.textContent.trim().substring(0, 50)}"`, "info");
            await humanClick(first);
            await sleep(600);
            return true;
          }
        }
      }

      // Fallback: try arrow down + Enter to force select first dropdown item
      if (attempt === retries) {
        log(`[DEBUG] Typeahead: aucun dropdown trouvé — tentative ArrowDown+Enter`, "info");
        inputElement.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
        await sleep(300);
        inputElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        inputElement.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
        await sleep(600);
        return false;
      }

      // Between retries, trigger an extra input event to re-fire typeahead
      log(`[DEBUG] Typeahead: retry ${attempt}/${retries} — re-trigger input`, "info");
      inputElement.dispatchEvent(new Event("input", { bubbles: true }));
    }
    return false;
  }

  // ── LinkedIn Easy Apply Detection ───────────────────────────────────────
  function findEasyApplyButton() {
    const selectors = [
      'button.jobs-apply-button',
      'button[aria-label*="Easy Apply"]',
      'button[aria-label*="Candidature simplifiée"]',
      'button[aria-label*="Postuler"]',
    ];
    for (const sel of selectors) {
      const btn = $(sel);
      if (btn && btn.offsetParent !== null) {
        log(`[DEBUG] Easy Apply trouvé via selector: ${sel}`, "info");
        return btn;
      }
    }
    const buttons = $$("button");
    for (const btn of buttons) {
      const text = btn.textContent.trim().toLowerCase();
      if ((text.includes("easy apply") || text.includes("candidature simplifiée") ||
           text.includes("postuler") || text.includes("postuler facilement")) &&
          btn.offsetParent !== null && !btn.disabled) {
        log(`[DEBUG] Easy Apply trouvé via texte: "${text}"`, "info");
        return btn;
      }
    }
    const spans = $$("span");
    for (const span of spans) {
      const text = span.textContent.trim().toLowerCase();
      if (text === "candidature simplifiée" || text === "easy apply" || text === "postuler") {
        let parent = span.parentElement;
        while (parent && parent.tagName !== "BUTTON" && parent.tagName !== "A") {
          parent = parent.parentElement;
          if (parent === document.body) return span;
        }
        log(`[DEBUG] Easy Apply trouvé via span/parent`, "info");
        return parent || span;
      }
    }
    log("[DEBUG] Easy Apply bouton NON trouvé", "warn");
    return null;
  }

  function isModalOpen() {
    const modalSelectors = [
      'div.jobs-easy-apply-content',
      'div.jobs-easy-apply-modal',
      '#artdeco-modal-outlet div[role="dialog"]',
    ];
    for (const sel of modalSelectors) {
      const modal = $(sel);
      if (modal && modal.offsetParent !== null) return modal;
    }
    const interop = $("#interop-outlet");
    if (interop) {
      const dialog = $('div[role="dialog"]', interop) || $('div[class*="modal"]', interop);
      if (dialog) return dialog;
    }
    return null;
  }

  function getCurrentJobInfo() {
    const info = { title: "", company: "", description: "", jobId: "", url: window.location.href };
    const titleSelectors = [
      'h1.t-24', 'h1.job-title', 'h1.jobs-unified-top-card__job-title',
      'h1 a.ember-view', 'h2.t-24', 'h1',
    ];
    for (const sel of titleSelectors) {
      const el = $(sel);
      if (el?.textContent?.trim()) { info.title = el.textContent.trim(); break; }
    }
    const companySelectors = [
      'a.ember-view.t-black.t-normal span',
      '.jobs-unified-top-card__company-name a',
      '.job-details-jobs-unified-top-card__company-name a',
      'span.jobs-unified-top-card__company-name',
      'a[href*="/company/"]',
    ];
    for (const sel of companySelectors) {
      const el = $(sel);
      if (el?.textContent?.trim()) { info.company = el.textContent.trim(); break; }
    }
    if (!info.company) {
      const companySpans = $$("span");
      for (const span of companySpans) {
        const parent = span.closest("div");
        if (parent && parent.querySelector('a[href*="/company/"]')) {
          info.company = parent.querySelector('a[href*="/company/"]').textContent.trim();
          break;
        }
      }
    }
    const descSelectors = [
      '.jobs-description__content', '.jobs-description-content__text',
      'div#job-details', 'article div.jobs-description',
    ];
    for (const sel of descSelectors) {
      const el = $(sel);
      if (el?.textContent?.trim()) { info.description = el.textContent.trim().substring(0, 1000); break; }
    }
    const jobIdMatch = window.location.href.match(/currentJobId=(\d+)/);
    if (jobIdMatch) info.jobId = jobIdMatch[1];
    if (!info.jobId) {
      const jobIdMatch2 = window.location.href.match(/\/jobs\/view\/(\d+)/);
      if (jobIdMatch2) info.jobId = jobIdMatch2[1];
    }
    return info;
  }

  // ── Modal Form Handling ─────────────────────────────────────────────────
  function getModalFormFields(modal) {
    const fields = [];
    if (!modal) return fields;

    const inputs = $$('input[type="text"], input[type="tel"], input[type="email"], input[type="number"], input[type="url"], input[type="date"], input:not([type])', modal);
    for (const input of inputs) {
      if (input.offsetParent === null || input.disabled) continue;
      if (input.type === "hidden" || input.type === "radio" || input.type === "checkbox") continue;

      let detectedType = input.type || "text";
      if (detectedType === "text") {
        const container = input.closest("div.fb-dash-form-element, div.artdeco-text-input, div");
        const errorText = container ? (container.textContent || "").toLowerCase() : "";
        const labelText = (findLabelForInput(input, modal) || "").toLowerCase();
        if (
          errorText.includes("decimal number") ||
          errorText.includes("nombre décimal") ||
          errorText.includes("nombre entier") ||
          errorText.includes("numeric value") ||
          errorText.includes("enter a number") ||
          labelText.includes("salaire") ||
          labelText.includes("salary") ||
          labelText.includes("rémunération") ||
          labelText.includes("prétention") ||
          /ann[ée]e|year/i.test(labelText)
        ) {
          detectedType = "number";
          log(`[DEBUG] Champ "${findLabelForInput(input, modal)}" reclassé comme "number"`, "info");
        }
      }

      fields.push({
        element: input, type: detectedType,
        label: findLabelForInput(input, modal),
        value: input.value,
        required: input.required || input.getAttribute("aria-required") === "true",
      });
    }

    for (const ta of $$("textarea", modal)) {
      if (ta.offsetParent === null || ta.disabled) continue;
      fields.push({ element: ta, type: "textarea", label: findLabelForInput(ta, modal),
        value: ta.value, required: ta.required || ta.getAttribute("aria-required") === "true" });
    }

    for (const sel of $$("select", modal)) {
      if (sel.offsetParent === null || sel.disabled) continue;
      const options = [...sel.options].map(o => o.text).filter(t => t && t !== "--" &&
        !t.toLowerCase().includes("sélectionnez") && !t.toLowerCase().includes("select"));
      fields.push({ element: sel, type: "select", label: findLabelForInput(sel, modal),
        value: sel.value, options, required: sel.required || sel.getAttribute("aria-required") === "true" });
    }

    const radioGroups = {};
    for (const radio of $$('input[type="radio"]', modal)) {
      const name = radio.name;
      if (!radioGroups[name]) radioGroups[name] = { elements: [], labels: [] };
      radioGroups[name].elements.push(radio);
      radioGroups[name].labels.push(findLabelForInput(radio, modal));
    }
    for (const [name, group] of Object.entries(radioGroups)) {
      const firstRadio = group.elements[0];
      const fieldset = firstRadio.closest("fieldset");
      const legend = fieldset ? $("legend", fieldset) : null;
      const groupLabel = legend?.textContent?.trim() || findLabelForInput(firstRadio, modal);
      fields.push({ element: group.elements[0], elements: group.elements, type: "radio",
        label: groupLabel, options: group.labels,
        value: group.elements.find(r => r.checked)?.value || "", required: group.elements[0].required });
    }

    for (const cb of $$('input[type="checkbox"]', modal)) {
      if (cb.offsetParent === null || cb.disabled) continue;
      fields.push({ element: cb, type: "checkbox", label: findLabelForInput(cb, modal),
        value: cb.checked, required: cb.required });
    }

    for (const trigger of $$('button[role="combobox"], button[data-test-text-selectable-option]', modal)) {
      fields.push({ element: trigger, type: "dropdown-button",
        label: findLabelForInput(trigger, modal), value: trigger.textContent.trim(),
        required: trigger.getAttribute("aria-required") === "true" });
    }

    return fields;
  }

  function findLabelForInput(input, root) {
    if (input.id) {
      const label = $(`label[for="${input.id}"]`, root);
      if (label) return label.textContent.trim();
    }
    const parentLabel = input.closest("label");
    if (parentLabel) return parentLabel.textContent.trim();
    if (input.getAttribute("aria-label")) return input.getAttribute("aria-label").trim();
    const labelledBy = input.getAttribute("aria-labelledby");
    if (labelledBy) {
      const labelEl = document.getElementById(labelledBy);
      if (labelEl) return labelEl.textContent.trim();
    }
    if (input.placeholder) return input.placeholder.trim();
    const prevSibling = input.previousElementSibling;
    if (prevSibling && (prevSibling.tagName === "LABEL" || prevSibling.tagName === "SPAN")) {
      return prevSibling.textContent.trim();
    }
    const container = input.closest("div");
    if (container) {
      const label = $("label, span.t-14, span.t-bold", container);
      if (label && label !== input) return label.textContent.trim();
    }
    return input.name || input.id || "Unknown field";
  }

  // ── Date Detection (for date availability / start date fields) ──────────
  function isDateQuestion(label) {
    return /date|disponib|start\s*date|début|quand.*commencer|when.*start|estimée/i.test(label);
  }

  function getAvailabilityDate() {
    // Return a date ~7 days from now in YYYY-MM-DD and DD/MM/YYYY formats
    const d = new Date();
    d.setDate(d.getDate() + 7);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return { iso: `${yyyy}-${mm}-${dd}`, fr: `${dd}/${mm}/${yyyy}`, short: `${dd}/${mm}/${yyyy}` };
  }

  // ── Location field detection ─────────────────────────────────────────────
  function isLocationField(label) {
    return /location|city|ville|lieu|localisation|adresse|région|region|where/i.test(label);
  }

  // ── Get user location from session search location or profile ────────────
  async function getUserLocation() {
    try {
      const data = await chrome.storage.local.get(["session", "profile"]);
      // Prefer session search location (the city user is job-searching in)
      const sessionLoc = data.session?.location || "";
      const profileLoc = data.profile?.location || "";
      // Use session location first (more specific, e.g. "Paris"), fallback to profile
      const raw = sessionLoc || profileLoc;
      if (!raw) return null;
      // Strip country suffix: "Paris, France" → "Paris", "Lyon, Auvergne-Rhône-Alpes, France" → "Lyon"
      const city = raw.split(",")[0].trim();
      log(`[DEBUG] getUserLocation: session="${sessionLoc}", profile="${profileLoc}" → city="${city}"`, "info");
      return city;
    } catch (err) {
      log(`[DEBUG] getUserLocation error: ${err.message}`, "warn");
      return null;
    }
  }

  // ── Fill a Single Form Field ────────────────────────────────────────────
  async function fillField(field, jobInfo) {
    if (field.value && field.type !== "select" && field.type !== "radio" && field.type !== "checkbox") {
      log(`Champ "${field.label}" déjà rempli: "${String(field.value).substring(0, 50)}"`, "info");
      return;
    }
    if (field.type === "select" && field.value && field.value !== "" && field.element.selectedIndex > 0) {
      log(`Select "${field.label}" déjà sélectionné`, "info");
      return;
    }
    log(`Remplissage: "${field.label}" (${field.type})`);

    try {
      // ── Special handling: date input fields ──
      if (field.element.type === "date" || (field.type === "text" && isDateQuestion(field.label))) {
        const dates = getAvailabilityDate();
        const el = field.element;
        if (el.type === "date") {
          // HTML5 date input: use ISO format
          setNativeValue(el, dates.iso);
          log(`OK "${field.label}" = "${dates.iso}" (date input)`, "success");
        } else {
          // Text field expecting a date: try DD/MM/YYYY
          await humanType(el, dates.fr);
          await sleep(300);
          // If there's a validation error, try ISO format
          const container = el.closest("div");
          const hasError = container && container.querySelector('[class*="error"], [class*="invalid"], [role="alert"]');
          if (hasError) {
            log(`[DEBUG] Date format DD/MM/YYYY rejected, trying YYYY-MM-DD`, "info");
            el.value = "";
            el.dispatchEvent(new Event("input", { bubbles: true }));
            await humanType(el, dates.iso);
          }
          log(`OK "${field.label}" = "${dates.fr}" (date text)`, "success");
        }
        return;
      }

      // ── Special handling: location/city fields — bypass AI, use session/profile location ──
      if ((field.type === "text" || field.type === "textarea") && isLocationField(field.label)) {
        const userCity = await getUserLocation();
        if (userCity) {
          log(`[DEBUG] Location field "${field.label}" → using user location: "${userCity}"`, "info");
          await humanType(field.element, userCity);
          const typeaheadOk = await handleTypeaheadDropdown(field.element);
          if (!typeaheadOk) {
            log(`[DEBUG] Location typeahead failed for "${userCity}" — retry with shorter text`, "info");
            field.element.value = "";
            field.element.dispatchEvent(new Event("input", { bubbles: true }));
            await sleep(500);
            const shortQuery = userCity.substring(0, Math.min(userCity.length, 5));
            await humanType(field.element, shortQuery);
            await handleTypeaheadDropdown(field.element, 4);
          }
          return;
        }
        // Fallback to AI if no stored location
        log(`[DEBUG] No stored location found, falling back to AI for "${field.label}"`, "info");
      }

      const response = await chrome.runtime.sendMessage({
        action: "generateAnswer", question: field.label,
        fieldType: field.type, options: field.options || [], jobInfo,
      });
      let answer = response?.answer;
      if (!answer) { log(`Pas de réponse pour "${field.label}"`, "warn"); return; }

      if (field.type === "number") {
        const cleaned = answer.replace(/[\s\u00a0€$,]/g, "");
        const numMatch = cleaned.match(/\d+/);
        answer = numMatch ? numMatch[0] : "10";
        log(`[DEBUG] Champ numérique "${field.label}" => ${answer}`, "info");
      }

      // For location/city fields that fell through (no stored location), strip country suffix from AI answer
      if ((field.type === "text" || field.type === "textarea") && isLocationField(field.label)) {
        answer = answer.split(",")[0].trim();
        log(`[DEBUG] Location field AI answer → shortened to: "${answer}"`, "info");
      }

      await sleep(randomDelay(300, 800));

      switch (field.type) {
        case "number": {
          const el = field.element;
          el.focus();
          el.dispatchEvent(new Event("focus", { bubbles: true }));
          setNativeValue(el, answer);
          el.dispatchEvent(new Event("blur", { bubbles: true }));
          break;
        }
        case "text": case "tel": case "email": case "url":
        case "textarea": {
          await humanType(field.element, answer);
          // Handle typeahead/autocomplete dropdowns (location, city, etc.)
          const typeaheadOk = await handleTypeaheadDropdown(field.element);
          // If location field and typeahead failed (AI fallback path), try shorter query
          if (!typeaheadOk && isLocationField(field.label)) {
            log(`[DEBUG] Location typeahead failed (AI fallback) — retry with shorter text`, "info");
            field.element.value = "";
            field.element.dispatchEvent(new Event("input", { bubbles: true }));
            await sleep(500);
            const shortQuery = answer.substring(0, Math.min(answer.length, 5));
            await humanType(field.element, shortQuery);
            await handleTypeaheadDropdown(field.element, 4);
          }
          break;
        }
        case "select": {
          const options = [...field.element.options];
          let idx = options.findIndex(o => o.text.toLowerCase().trim() === answer.toLowerCase().trim());
          if (idx < 0) idx = options.findIndex(o =>
            o.text.toLowerCase().includes(answer.toLowerCase()) || answer.toLowerCase().includes(o.text.toLowerCase()));
          if (idx < 0) idx = Math.min(1, options.length - 1);
          field.element.selectedIndex = idx;
          field.element.dispatchEvent(new Event("change", { bubbles: true }));
          break;
        }
        case "radio": {
          if (field.elements) {
            let target = null;
            for (let i = 0; i < field.elements.length; i++) {
              const lbl = field.options[i]?.toLowerCase().trim();
              if (lbl === answer.toLowerCase().trim() || lbl?.includes(answer.toLowerCase())) {
                target = field.elements[i]; break;
              }
            }
            if (!target) target = field.elements.find((r, i) => {
              const lbl = field.options[i]?.toLowerCase();
              return lbl?.includes("oui") || lbl?.includes("yes");
            }) || field.elements[0];
            if (target) await humanClick(target);
          }
          break;
        }
        case "checkbox": {
          // v1.7.0: Required checkboxes (terms, proceed, accept) are always checked
          const lbl = (field.label || "").toLowerCase();
          const isRequired = field.required || field.element.required ||
            field.element.getAttribute("aria-required") === "true";
          const isMandatoryContext = /proceed|accept|terms|conditions|agree|certif|confirm|j'accepte|j'atteste|j'autorise|engagement|consent/i.test(lbl);
          const shouldCheck = isRequired || isMandatoryContext || /oui|yes|true|1|accept|j'accepte/i.test(answer);
          if (shouldCheck && !field.element.checked) {
            await humanClick(field.element);
            // Verify it got checked; if not, try direct property set
            if (!field.element.checked) {
              field.element.checked = true;
              field.element.dispatchEvent(new Event("change", { bubbles: true }));
              field.element.dispatchEvent(new Event("input", { bubbles: true }));
              log(`[DEBUG] Checkbox force-checked via property`, "info");
            }
          }
          break;
        }
        case "dropdown-button": {
          await humanClick(field.element);
          await sleep(randomDelay(500, 1000));
          const listbox = $('ul[role="listbox"], div[role="listbox"]');
          if (listbox) {
            const optionEls = $$('li[role="option"], div[role="option"]', listbox);
            const targetOpt = optionEls.find(o =>
              o.textContent.toLowerCase().trim().includes(answer.toLowerCase())) || optionEls[0];
            if (targetOpt) await humanClick(targetOpt);
          }
          break;
        }
      }
      log(`OK "${field.label}" = "${answer}"`, "success");
    } catch (err) {
      log(`Erreur remplissage "${field.label}": ${err.message}`, "error");
    }
  }

  // ── Modal Navigation (IMPROVED v1.4.0: wider button search) ────────────
  function findNextButton(modal) {
    if (!modal) return null;

    const submitTexts = [
      "envoyer la candidature", "submit application",
      "soumettre la candidature", "soumettre",
      "envoyer", "submit",
      "postuler", "apply",
      "vérifier et envoyer", "review and submit",
    ];
    const nextTexts = [
      "suivant", "next",
      "continuer", "continue",
      "réviser", "review",
      "vérifier", "verify",
      "confirmer", "confirm",
      "passer en revue",
    ];

    // Search in modal first, then in parent dialog containers
    const searchRoots = [modal];
    // Also search in wider dialog scope (parent dialog if modal is inner content)
    const parentDialog = modal.closest('div[role="dialog"]');
    if (parentDialog && parentDialog !== modal) {
      searchRoots.push(parentDialog);
    }
    // Also try the artdeco modal outlet
    const artdecoOutlet = document.getElementById("artdeco-modal-outlet");
    if (artdecoOutlet && !searchRoots.includes(artdecoOutlet)) {
      searchRoots.push(artdecoOutlet);
    }

    for (const searchRoot of searchRoots) {
      const allButtons = $$("button", searchRoot);

      if (searchRoot === searchRoots[0]) {
        log(`[DEBUG] findNextButton: ${allButtons.length} boutons dans le modal`, "info");
        const btnTexts = allButtons.map(b => `"${b.textContent.trim().substring(0, 50)}"${b.disabled ? " [disabled]" : ""}`);
        log(`[DEBUG] Boutons: ${btnTexts.join(", ")}`, "info");
      }

      // Check submit buttons first
      for (const btn of allButtons) {
        const text = btn.textContent.trim().toLowerCase();
        if (submitTexts.some(t => text.includes(t)) && !btn.disabled) {
          log(`[DEBUG] Bouton SUBMIT trouvé: "${btn.textContent.trim()}" (root: ${searchRoot === modal ? "modal" : "parent"})`, "info");
          return { button: btn, isSubmit: true };
        }
      }
      // Check next buttons
      for (const btn of allButtons) {
        const text = btn.textContent.trim().toLowerCase();
        if (nextTexts.some(t => text.includes(t)) && !btn.disabled) {
          log(`[DEBUG] Bouton NEXT trouvé: "${btn.textContent.trim()}" (root: ${searchRoot === modal ? "modal" : "parent"})`, "info");
          return { button: btn, isSubmit: false };
        }
      }
      // Check spans inside buttons
      for (const span of $$("span", searchRoot)) {
        const text = span.textContent.trim().toLowerCase();
        if (submitTexts.some(t => text.includes(t))) {
          const btn = span.closest("button, a");
          if (btn && !btn.disabled) {
            log(`[DEBUG] Bouton SUBMIT (span): "${span.textContent.trim()}"`, "info");
            return { button: btn, isSubmit: true };
          }
        }
      }
      for (const span of $$("span", searchRoot)) {
        const text = span.textContent.trim().toLowerCase();
        if (nextTexts.some(t => text.includes(t))) {
          const btn = span.closest("button, a");
          if (btn && !btn.disabled) {
            log(`[DEBUG] Bouton NEXT (span): "${span.textContent.trim()}"`, "info");
            return { button: btn, isSubmit: false };
          }
        }
      }
      // Check aria-label
      for (const btn of allButtons) {
        if (btn.disabled) continue;
        const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
        if (submitTexts.some(t => aria.includes(t))) {
          log(`[DEBUG] Bouton SUBMIT (aria): "${aria}"`, "info");
          return { button: btn, isSubmit: true };
        }
        if (nextTexts.some(t => aria.includes(t))) {
          log(`[DEBUG] Bouton NEXT (aria): "${aria}"`, "info");
          return { button: btn, isSubmit: false };
        }
      }
    }

    // FALLBACK: look for primary-colored/styled buttons in modal footer
    const footer = $('footer, div[class*="footer"], div[class*="action"]', modal);
    if (footer) {
      const footerBtns = $$("button", footer).filter(b => !b.disabled);
      if (footerBtns.length > 0) {
        const primary = footerBtns[footerBtns.length - 1];
        log(`[DEBUG] Bouton FALLBACK footer: "${primary.textContent.trim()}"`, "info");
        const text = primary.textContent.trim().toLowerCase();
        const isSubmit = submitTexts.some(t => text.includes(t)) ||
                         text.includes("envoyer") || text.includes("submit");
        return { button: primary, isSubmit };
      }
    }

    // LAST RESORT: search ENTIRE document for dialog footer buttons
    const globalDialog = document.querySelector('div[role="dialog"]');
    if (globalDialog) {
      const globalFooter = $('footer, div[class*="footer"]', globalDialog);
      if (globalFooter) {
        const gBtns = $$("button", globalFooter).filter(b => !b.disabled);
        if (gBtns.length > 0) {
          const btn = gBtns[gBtns.length - 1];
          log(`[DEBUG] Bouton GLOBAL FALLBACK: "${btn.textContent.trim()}"`, "info");
          const text = btn.textContent.trim().toLowerCase();
          const isSubmit = submitTexts.some(t => text.includes(t));
          return { button: btn, isSubmit };
        }
      }
    }

    log("[DEBUG] AUCUN bouton Next/Submit trouvé!", "error");
    return null;
  }

  function findDismissButton(modal) {
    if (!modal) return null;
    const selectors = [
      'button[aria-label*="Dismiss"]', 'button[aria-label*="Fermer"]',
      'button[aria-label*="Close"]', 'button[data-test-modal-close-btn]',
      'button.artdeco-modal__dismiss',
    ];
    for (const sel of selectors) {
      const btn = $(sel, modal) || $(sel);
      if (btn) return btn;
    }
    for (const btn of $$("button", modal)) {
      const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
      if (aria.includes("dismiss") || aria.includes("fermer") || aria.includes("close")) return btn;
      const svg = $("svg", btn);
      if (svg && btn.children.length === 1 && !btn.textContent.trim()) return btn;
    }
    return null;
  }

  function detectModalStatus(modal) {
    if (!modal) return "unknown";
    const text = modal.textContent.toLowerCase();
    if (text.includes("already applied") || text.includes("déjà postulé") || text.includes("candidature déjà envoyée")) return "already_applied";
    if (text.includes("application submitted") || text.includes("candidature envoyée") || text.includes("your application was sent")) return "success";
    if (text.includes("error") || text.includes("erreur") || text.includes("something went wrong")) return "error";
    return "in_progress";
  }

  async function handleDiscardDialog() {
    await sleep(500);
    const discardBtn = findByText("button", ["discard", "annuler", "ignorer", "supprimer", "oui, annuler"]);
    if (discardBtn) {
      log("[DEBUG] Clic sur bouton discard/annuler", "info");
      await humanClick(discardBtn);
      await sleep(500);
    }
  }

  function stepFieldsHash(fields) {
    return fields.map(f => f.label).sort().join("|");
  }

  // ── Blacklist Check ─────────────────────────────────────────────────────
  async function isCompanyBlacklisted(companyName) {
    if (!companyName) return false;
    try {
      const { blacklistedCompanies = [] } = await chrome.storage.local.get(["blacklistedCompanies"]);
      if (blacklistedCompanies.length === 0) return false;
      const companyLower = companyName.toLowerCase().trim();
      for (const blocked of blacklistedCompanies) {
        const blockedLower = blocked.toLowerCase().trim();
        if (!blockedLower) continue;
        // Partial match: "capgemini" matches "Capgemini Engineering"
        if (companyLower.includes(blockedLower) || blockedLower.includes(companyLower)) {
          log(`🚫 Entreprise blacklistée: "${companyName}" (match: "${blocked}")`, "warn");
          return true;
        }
      }
    } catch (err) {
      log(`[DEBUG] Erreur vérif blacklist: ${err.message}`, "warn");
    }
    return false;
  }

  // ── Main Apply Flow ─────────────────────────────────────────────────────
  async function applyToCurrentJob(settings) {
    const jobInfo = getCurrentJobInfo();
    log(`Candidature: ${jobInfo.title} @ ${jobInfo.company}`);

    const easyApplyBtn = findEasyApplyButton();
    if (!easyApplyBtn) {
      log("Bouton Easy Apply non trouvé — HTML: " + document.body?.innerText?.substring(0, 200), "warn");
      return { success: false, reason: "no_easy_apply_button" };
    }

    await humanClick(easyApplyBtn);
    await sleep(randomDelay(1500, 3000));

    let modal = isModalOpen();
    if (!modal) { await sleep(2000); modal = isModalOpen(); }
    if (!modal) {
      log("Modal Easy Apply ne s'ouvre pas", "error");
      return { success: false, reason: "modal_not_opened" };
    }

    const maxSteps = 12;
    let step = 0;
    let lastFieldsHash = "";
    let stuckCount = 0;

    while (step < maxSteps && !shouldStop) {
      step++;
      log(`Étape ${step}...`);

      const status = detectModalStatus(modal);
      log(`[DEBUG] Status modal: ${status}`, "info");

      if (status === "already_applied") {
        log("Déjà postulé à ce poste", "warn");
        const dismissBtn = findDismissButton(modal);
        if (dismissBtn) await humanClick(dismissBtn);
        await handleDiscardDialog();
        return { success: false, reason: "already_applied" };
      }
      if (status === "success") {
        log("Candidature envoyée avec succès!", "success");
        const dismissBtn = findDismissButton(modal) || findByText("button", ["fermer", "close", "done", "terminé"], modal);
        if (dismissBtn) { await sleep(500); await humanClick(dismissBtn); }
        return { success: true };
      }

      const fields = getModalFormFields(modal);
      const currentHash = stepFieldsHash(fields);
      log(`${fields.length} champ(s) à l'étape ${step} (hash: ${currentHash.substring(0, 40)})`, "info");

      if (currentHash === lastFieldsHash && currentHash !== "") {
        stuckCount++;
        log(`[DEBUG] Même étape détectée ${stuckCount} fois`, "warn");
        if (stuckCount >= 2) {
          log("Bloqué sur la même étape 2x — vérification erreurs de validation", "warn");
          const errorMsgs = $$('[class*="error"], [class*="invalid"], [role="alert"]', modal);
          for (const err of errorMsgs) {
            const errText = err.textContent.trim();
            if (errText) log(`[DEBUG] Erreur validation: "${errText}"`, "error");
          }
          if (stuckCount >= 3) {
            log("Bloqué 3x sur même étape — abandon", "error");
            const dismissBtn = findDismissButton(modal);
            if (dismissBtn) await humanClick(dismissBtn);
            await handleDiscardDialog();
            return { success: false, reason: "stuck_on_step" };
          }
        }
      } else {
        stuckCount = 0;
      }
      lastFieldsHash = currentHash;

      for (const field of fields) {
        if (shouldStop) break;
        await fillField(field, jobInfo);
        await sleep(randomDelay(settings.delayBetweenSteps?.min || 1000, settings.delayBetweenSteps?.max || 3000));
      }

      await sleep(randomDelay(1000, 2000));
      let nextAction = findNextButton(modal);

      // Retry once if button not found (may need time after typeahead selection)
      if (!nextAction) {
        log("[DEBUG] Bouton non trouvé — attente et retry...", "info");
        await sleep(2000);
        modal = isModalOpen();
        if (modal) nextAction = findNextButton(modal);
      }

      if (!nextAction) {
        log("Pas de bouton Suivant/Envoyer trouvé — vérif status...", "warn");
        const statusCheck = detectModalStatus(modal);
        if (statusCheck === "success") {
          log("Candidature envoyée!", "success");
          const dismissBtn = findDismissButton(modal);
          if (dismissBtn) await humanClick(dismissBtn);
          return { success: true };
        }
        log("[DEBUG] Tentative dernier recours — cherche bouton action...", "warn");
        const lastResort = $$("button", modal).filter(b => !b.disabled && b.offsetParent !== null);
        const actionBtn = lastResort.find(b => {
          const t = b.textContent.trim().toLowerCase();
          return !t.includes("fermer") && !t.includes("close") && !t.includes("dismiss") &&
                 !t.includes("annuler") && !t.includes("cancel") && !t.includes("précédent") &&
                 !t.includes("previous") && !t.includes("retour") && t.length > 0 && t.length < 50;
        });
        if (actionBtn) {
          log(`[DEBUG] Clic dernier recours: "${actionBtn.textContent.trim()}"`, "info");
          await humanClick(actionBtn);
          await sleep(randomDelay(2000, 4000));
          modal = isModalOpen();
          if (modal) {
            const retryStatus = detectModalStatus(modal);
            if (retryStatus === "success") {
              log("Candidature envoyée (dernier recours)!", "success");
              const dismissBtn = findDismissButton(modal);
              if (dismissBtn) await humanClick(dismissBtn);
              return { success: true };
            }
            continue;
          }
          return { success: true };
        }
        const dismissBtn = findDismissButton(modal);
        if (dismissBtn) await humanClick(dismissBtn);
        await handleDiscardDialog();
        return { success: false, reason: "no_next_button" };
      }

      if (nextAction.isSubmit) {
        if (!settings.autoSubmit) {
          log("Mode review: autoSubmit=false", "warn");
          return { success: false, reason: "manual_submit_required" };
        }
        log(`Envoi de la candidature (bouton: "${nextAction.button.textContent.trim()}")...`, "info");
        await humanClick(nextAction.button);
        await sleep(randomDelay(2000, 4000));

        modal = isModalOpen();
        if (modal) {
          const finalStatus = detectModalStatus(modal);
          log(`[DEBUG] Status après envoi: ${finalStatus}`, "info");
          if (finalStatus === "success") {
            log("Candidature envoyée avec succès!", "success");
            const dismissBtn = findDismissButton(modal) || findByText("button", ["fermer", "close", "done", "terminé"], modal);
            if (dismissBtn) { await sleep(500); await humanClick(dismissBtn); }
            return { success: true };
          }
          log("[DEBUG] Modal encore ouvert après submit — continue boucle", "warn");
          continue;
        }
        return { success: true };
      }

      log(`Clic sur "${nextAction.button.textContent.trim()}"...`);
      await humanClick(nextAction.button);
      await sleep(randomDelay(1500, 3000));

      modal = isModalOpen();
      if (!modal) {
        log("Modal fermé après clic Suivant", "warn");
        return { success: false, reason: "modal_closed_unexpectedly" };
      }
    }

    if (step >= maxSteps) {
      log("Trop d'étapes (>12) — abandon", "error");
      const dismissBtn = findDismissButton(modal);
      if (dismissBtn) await humanClick(dismissBtn);
      await handleDiscardDialog();
      return { success: false, reason: "too_many_steps" };
    }
    return { success: false, reason: "stopped" };
  }

  // ── Job List Scanning ───────────────────────────────────────────────────
  function getJobCards() {
    const cards = [];
    const cardSelectors = [
      "li.jobs-search-results__list-item",
      "li.ember-view.occludable-update",
      'div[data-job-id]',
      'li[data-occludable-job-id]',
      'li.scaffold-layout__list-item',
      '.jobs-search-results-list li',
      '.scaffold-layout__list li.ember-view',
      'ul.scaffold-layout__list-container li',
    ];
    for (const sel of cardSelectors) {
      const els = $$(sel);
      if (els.length > 0) {
        for (const el of els) {
          const jobId = el.getAttribute("data-job-id") ||
            el.getAttribute("data-occludable-job-id") ||
            el.querySelector("a")?.href?.match(/\/jobs\/view\/(\d+)/)?.[1] ||
            el.querySelector('[data-job-id]')?.getAttribute('data-job-id') || "";
          cards.push({ element: el, jobId });
        }
        return cards;
      }
    }
    const listContainer =
      $("ul.jobs-search-results__list") ||
      $("div.jobs-search-results-list") ||
      $(".scaffold-layout__list") ||
      $('[class*="jobs-search-results"]');
    if (listContainer) {
      const items = $$("li", listContainer);
      for (const item of items) {
        const link = $("a", item);
        const match = link?.href?.match(/\/jobs\/view\/(\d+)/);
        cards.push({ element: item, jobId: match?.[1] || "" });
      }
    }
    return cards;
  }

  async function clickJobCard(card) {
    // v1.6.0 CRITICAL: Do NOT click <a> links at all — even synthetic MouseEvent
    // on <a> tags causes real navigation away from the search page.
    // Instead, update the URL's currentJobId param. LinkedIn's SPA watches
    // for URL changes and loads job details in the right split-pane panel.
    log(`[DEBUG] clickJobCard: jobId=${card.jobId}`, "info");

    // Scroll the card into view for visual feedback
    card.element.scrollIntoView({ behavior: "smooth", block: "center" });
    await sleep(randomDelay(300, 600));

    if (card.jobId) {
      // Method 1 (preferred): Update URL param — LinkedIn SPA loads job in right panel
      const url = new URL(window.location.href);
      url.searchParams.set("currentJobId", card.jobId);
      window.history.replaceState(null, "", url.toString());
      // Trigger popstate so LinkedIn's router picks up the change
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
      log(`[DEBUG] URL updated with currentJobId=${card.jobId}`, "info");
      await sleep(randomDelay(1500, 2500));

      // Check if the right panel loaded by looking for job title change
      const rightPanel = $(".jobs-search__job-details, .scaffold-layout__detail, .job-details-module");
      if (rightPanel) {
        log(`[DEBUG] Panneau détail trouvé`, "info");
      }
    }

    // Method 2 (fallback): If URL param didn't work, click the card's container
    // element (NOT the <a> tag) to trigger LinkedIn's delegation handler
    if (!findEasyApplyButton()) {
      log(`[DEBUG] Easy Apply non visible après URL update — click sur carte`, "info");
      const clickTarget = card.element; // the <li>, NOT the <a> inside
      const rect = clickTarget.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      clickTarget.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: x, clientY: y }));
      await sleep(50);
      clickTarget.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: x, clientY: y }));
      clickTarget.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x, clientY: y }));
      await sleep(randomDelay(2000, 3000));
    }

    // Safety: verify we're still on the search page
    if (!window.location.href.includes("/jobs/search") && !window.location.href.includes("/jobs/collection")) {
      log("[DEBUG] Navigation détectée hors recherche — retour arrière", "warn");
      window.history.back();
      await sleep(3000);
    }
  }

  function hasEasyApplyBadge(cardElement) {
    const text = cardElement.textContent.toLowerCase();
    return text.includes("easy apply") || text.includes("candidature simplifiée");
  }

  async function scrollJobList() {
    const listEl = $(".jobs-search-results-list") || $(".scaffold-layout__list") ||
      $('[class*="jobs-search-results"]') || $(".jobs-search-results-list__list");
    if (!listEl) {
      log("[DEBUG] Conteneur liste non trouvé, scroll page entière", "warn");
      for (let i = 0; i < 5; i++) { window.scrollBy(0, 600); await sleep(800); }
      window.scrollTo(0, 0); await sleep(500);
      return;
    }
    for (let i = 0; i < 5; i++) { listEl.scrollTop = listEl.scrollHeight; await sleep(800); }
    listEl.scrollTop = 0; await sleep(500);
  }

  function buildSearchUrl(keywords, location, page = 0) {
    const params = new URLSearchParams();
    if (keywords) params.set("keywords", keywords);
    if (location) params.set("location", location);
    params.set("f_AL", "true");
    if (page > 0) params.set("start", String(page * 25));
    return `https://www.linkedin.com/jobs/search/?${params.toString()}`;
  }

  async function waitForJobCards(maxWaitMs = 30000) {
    const startTime = Date.now();
    let attempt = 0;
    while (Date.now() - startTime < maxWaitMs) {
      attempt++;
      window.scrollBy(0, 300); await sleep(500); window.scrollTo(0, 0);
      const cards = getJobCards();
      if (cards.length > 0) {
        log(`${cards.length} offre(s) détectées après ${attempt} tentative(s) (${Math.round((Date.now() - startTime) / 1000)}s)`);
        return cards;
      }
      log(`[DEBUG] Attente offres... tentative ${attempt}`, "info");
      await sleep(2000);
    }
    log(`Aucune offre trouvée après ${maxWaitMs / 1000}s`, "error");
    return [];
  }

  // ── Auto Apply Session (multi-page) ─────────────────────────────────────
  async function runAutoApplySession() {
    if (isRunning) {
      log("[DEBUG] runAutoApplySession appelé mais isRunning=true — refusé", "warn");
      return;
    }

    isRunning = true;
    shouldStop = false;

    log("[DEBUG] runAutoApplySession START", "info");

    // ═══════════════════════════════════════════════════════════════════
    // CRITICAL FIX v1.4.0: Read session DIRECTLY from storage
    // (no service worker dependency — avoids the active=undefined bug)
    // ═══════════════════════════════════════════════════════════════════
    const { session } = await chrome.storage.local.get(["session"]);
    const state = await chrome.runtime.sendMessage({ action: "getState" });
    const settings = state.autoApplySettings || {};
    const maxJobs = session?.maxJobs || settings.maxJobsPerSession || 25;
    const appliedJobs = state.appliedJobs || {};
    const totalApplied = session?.applied || 0;

    log(`AutoApply démarré — page ${(session?.currentPage || 0) + 1} (${totalApplied}/${maxJobs} postulées)`, "info");

    await scrollJobList();
    let jobCards = await waitForJobCards(30000);

    if (jobCards.length === 0) {
      log("Aucune offre trouvée — fin de session", "error");
      if (session?.active) {
        await chrome.runtime.sendMessage({ action: "endSession" });
      }
      isRunning = false;
      return;
    }

    try {
      let pageApplied = 0;

      for (let i = 0; i < jobCards.length && !shouldStop; i++) {
        // Check max jobs (read directly from storage for accuracy)
        const { session: currentSession } = await chrome.storage.local.get(["session"]);
        if (currentSession && (currentSession.applied || 0) >= maxJobs) {
          log(`Max atteint (${maxJobs}) — fin`, "info");
          break;
        }

        const card = jobCards[i];
        if (card.jobId && appliedJobs[card.jobId]) {
          log(`Ignoré (déjà postulé): job ${card.jobId}`, "info");
          continue;
        }

        if (settings.onlyEasyApply !== false && !hasEasyApplyBadge(card.element)) {
          log(`[DEBUG] Carte ${i + 1}: pas Easy Apply — ignorée`, "info");
          continue;
        }

        log(`Sélection offre ${i + 1}/${jobCards.length}...`);
        await clickJobCard(card);

        // Wait for the right panel to load job details
        await sleep(randomDelay(1500, 2500));
        const jobInfo = getCurrentJobInfo();
        if (!jobInfo.jobId && card.jobId) jobInfo.jobId = card.jobId;

        log(`Offre: ${jobInfo.title || "(sans titre)"} @ ${jobInfo.company || "(inconnu)"}`, "info");

        // Safety check: make sure we're still on search page
        if (!window.location.href.includes("/jobs/search") && !window.location.href.includes("/jobs/collection")) {
          log("[DEBUG] Plus sur la page de recherche — retour", "warn");
          window.history.back();
          await sleep(3000);
          continue;
        }

        // ── Blacklist check ─────────────────────────────────────────
        if (await isCompanyBlacklisted(jobInfo.company)) {
          await chrome.runtime.sendMessage({
            action: "markSkipped", jobId: jobInfo.jobId,
            title: jobInfo.title, reason: `Blacklistée: ${jobInfo.company}`,
          }).catch(() => {});
          continue;
        }

        // Wait for Easy Apply button with retry (right panel may still be loading)
        let easyApplyBtn = findEasyApplyButton();
        if (!easyApplyBtn) {
          log(`[DEBUG] Easy Apply non visible — attente 3s...`, "info");
          await sleep(3000);
          easyApplyBtn = findEasyApplyButton();
        }
        if (!easyApplyBtn) {
          log(`Pas de bouton Easy Apply: ${jobInfo.title}`, "info");
          await chrome.runtime.sendMessage({
            action: "markSkipped", jobId: jobInfo.jobId,
            title: jobInfo.title, reason: "Pas de candidature simplifiée",
          }).catch(() => {});
          continue;
        }

        log(`Candidature en cours: ${jobInfo.title}...`);
        const result = await applyToCurrentJob(settings);

        if (result.success) {
          pageApplied++;
          await chrome.runtime.sendMessage({
            action: "markApplied", jobId: jobInfo.jobId,
            title: jobInfo.title, company: jobInfo.company, url: jobInfo.url,
          }).catch(() => {});
          log(`Postulé (${pageApplied} sur cette page): ${jobInfo.title}`, "success");
        } else if (result.reason === "already_applied") {
          await chrome.runtime.sendMessage({
            action: "markSkipped", jobId: jobInfo.jobId,
            title: jobInfo.title, reason: "Déjà postulé",
          }).catch(() => {});
        } else {
          await chrome.runtime.sendMessage({
            action: "markError", jobId: jobInfo.jobId,
            title: jobInfo.title, error: result.reason,
          }).catch(() => {});
          log(`Échec (${result.reason}): ${jobInfo.title}`, "error");
        }

        if (!shouldStop && i < jobCards.length - 1) {
          const delay = randomDelay(settings.delayBetweenJobs?.min || 8000, settings.delayBetweenJobs?.max || 20000);
          log(`Pause ${Math.round(delay / 1000)}s...`);
          await sleep(delay);
        }
      }

      // Multi-page: next page
      if (!shouldStop) {
        const { session: updatedSession } = await chrome.storage.local.get(["session"]);
        if (updatedSession?.active && (updatedSession.applied || 0) < maxJobs) {
          const nextPage = (updatedSession.currentPage || 0) + 1;
          await chrome.runtime.sendMessage({
            action: "updateSession",
            updates: { currentPage: nextPage },
          });
          const nextUrl = buildSearchUrl(updatedSession.keywords, updatedSession.location, nextPage);
          log(`Page suivante ${nextPage + 1}: ${nextUrl}`);
          await sleep(randomDelay(3000, 6000));
          window.location.href = nextUrl;
          return;
        } else {
          if (updatedSession?.active) {
            await chrome.runtime.sendMessage({ action: "endSession" });
            log(`Session terminée — ${updatedSession.applied || 0} candidature(s)`, "success");
          }
        }
      } else {
        await chrome.runtime.sendMessage({ action: "endSession" });
        log("Session arrêtée par l'utilisateur", "warn");
      }
    } catch (err) {
      log(`Erreur session: ${err.message}`, "error");
      console.error("[LinkedInAutoApply] Session error:", err);
    }

    isRunning = false;
  }

  // ── Single Job Apply ────────────────────────────────────────────────────
  async function applySingleJob() {
    if (isRunning) { log("Déjà en cours", "warn"); return; }
    isRunning = true;
    shouldStop = false;
    try {
      const state = await chrome.runtime.sendMessage({ action: "getState" });
      const settings = state?.autoApplySettings || {};
      const result = await applyToCurrentJob(settings);
      if (result.success) {
        const jobInfo = getCurrentJobInfo();
        await chrome.runtime.sendMessage({
          action: "markApplied", jobId: jobInfo.jobId,
          title: jobInfo.title, company: jobInfo.company, url: jobInfo.url,
        }).catch(() => {});
        log(`Postulé: ${jobInfo.title}`, "success");
      }
    } catch (err) {
      log(`Erreur: ${err.message}`, "error");
    }
    isRunning = false;
  }

  // ── Auto-resume session — READS DIRECTLY FROM STORAGE ──────────────────
  async function checkAndResumeSession() {
    const url = window.location.href;
    const isSearchPage = url.includes("/jobs/search") || url.includes("/jobs/collection");

    log(`[DEBUG] checkAndResumeSession: url match=${isSearchPage}, isRunning=${isRunning}`, "info");

    if (!isSearchPage) {
      log("[DEBUG] Pas une page de recherche — pas de session auto", "info");
      return;
    }

    // Poll every 3s for up to 60s to find an active session
    const maxWait = 60000;
    const interval = 3000;
    const startTime = Date.now();
    let attempt = 0;

    while (Date.now() - startTime < maxWait) {
      attempt++;
      try {
        // ═══════════════════════════════════════════════════════════════
        // CRITICAL FIX v1.4.0: Read session DIRECTLY from storage
        // This bypasses the service worker entirely!
        // ═══════════════════════════════════════════════════════════════
        const { session } = await chrome.storage.local.get(["session"]);
        log(`[DEBUG] Session poll #${attempt}: active=${session?.active}, isRunning=${isRunning}`, "info");

        if (session && session.active && !isRunning) {
          log(`Session active trouvée: "${session.keywords}" page ${(session.currentPage || 0) + 1} — démarrage dans 3s...`, "info");
          await sleep(3000);
          if (!isRunning) {
            await runAutoApplySession();
          }
          return;
        }

        if (isRunning) {
          log("[DEBUG] Session déjà en cours (isRunning=true) — arrêt polling", "info");
          return;
        }
      } catch (err) {
        log(`[DEBUG] Erreur session poll #${attempt}: ${err.message}`, "warn");
      }

      await sleep(interval);
    }

    log("[DEBUG] Aucune session active trouvée après 60s de polling", "info");
  }

  // ── Message Handler ─────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "startAutoApply") {
      log("[DEBUG] Message startAutoApply reçu de background", "info");
      if (isRunning) {
        log("[DEBUG] Déjà en cours — refusé", "warn");
        sendResponse({ ok: false, reason: "already_running" });
        return;
      }
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
      sendResponse({ isRunning, sessionStats, url: window.location.href, version: VERSION });
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
    badge.textContent = "\u{1F680} AutoApply v" + VERSION;
    badge.title = "LinkedIn AutoApply actif";
    badge.addEventListener("mouseenter", () => { badge.style.transform = "scale(1.05)"; });
    badge.addEventListener("mouseleave", () => { badge.style.transform = "scale(1)"; });
    document.body.appendChild(badge);
  }

  // ── Init ────────────────────────────────────────────────────────────────
  addStatusBadge();
  log(`LinkedIn AutoApply v${VERSION} chargé sur ${window.location.href}`);

  // Start aggressive session polling (primary resume mechanism)
  checkAndResumeSession();
})();
