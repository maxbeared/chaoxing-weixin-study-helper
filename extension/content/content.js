installRuntimeErrorReporter();
loadSettings();
writeRuntimeLog("info", "content_script_started", {
  readyState: document.readyState,
  pageAgeMs: Date.now() - contentScriptStartedAt
});
installScreenWakeLockController();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  for (const [key, change] of Object.entries(changes)) {
    settings[key] = change.newValue;
  }
  if (changes.enabled || changes.preventSleep) {
    refreshScreenWakeLock("settings_changed");
  }
  if (changes.enabled || changes.targetId || changes.accountId) {
    refreshRemoteCommandBridge();
  }
});

scanVideosDeep();
scanCompletedJobMarkers();
scheduleNoVideoChapterAutoNext();
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
  scheduleNoVideoChapterAutoNext();
  ensureQuizPanel();
  scheduleWrongQuestionScan();
  clickNextConfirmIfShown();
});
observer.observe(document.documentElement, { childList: true, subtree: true });
setInterval(() => {
  scanVideosDeep();
  scanCompletedJobMarkers();
  scheduleNoVideoChapterAutoNext();
}, 3000);
