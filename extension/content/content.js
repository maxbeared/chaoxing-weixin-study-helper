installRuntimeErrorReporter();
loadSettings();
writeRuntimeLog("info", "content_script_started", {
  readyState: document.readyState,
  pageAgeMs: Date.now() - contentScriptStartedAt
});
installScreenWakeLockController();
if (window.top === window) {
  startRemoteCommandBridge({ globalOnly: true });
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  for (const [key, change] of Object.entries(changes)) {
    settings[key] = change.newValue;
  }
  if (changes.enabled || changes.preventSleep) {
    refreshScreenWakeLock("settings_changed");
  }
});

scanVideosDeep();
scanCompletedJobMarkers();
watchManualSubmitClicks();
ensureQuizPanel();
scheduleWrongQuestionScan();
const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        scanVideosDeep(node);
      }
    }
  }
  scanVideosDeep();
  scanCompletedJobMarkers();
  ensureQuizPanel();
  scheduleWrongQuestionScan();
  clickNextConfirmIfShown();
});
observer.observe(document.documentElement, { childList: true, subtree: true });
setInterval(() => {
  scanVideosDeep();
  scanCompletedJobMarkers();
}, 3000);
