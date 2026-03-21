// LinkedIn AutoApply — Offscreen keepalive
// Pings service worker every 20 seconds to prevent hibernation.
setInterval(() => {
  chrome.runtime.sendMessage({ type: "keepalive" }).catch(() => {});
}, 20000);
console.log("[LinkedInAutoApply] Offscreen keepalive active");
