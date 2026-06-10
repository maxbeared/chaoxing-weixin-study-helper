// Settings, messaging, and runtime diagnostics.
function loadSettings() {
  chrome.storage.sync.get(DEFAULTS, (stored) => {
    settings = { ...DEFAULTS, ...stored };
  });
}

function titleForPage() {
  return document.title || location.hostname || location.href;
}

function describeVideo(video) {
  const src = video.currentSrc || video.src || "";
  return {
    pageTitle: titleForPage(),
    pageUrl: location.href,
    videoSrc: src,
    currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
    duration: Number.isFinite(video.duration) ? video.duration : 0,
    paused: video.paused,
    ended: video.ended,
    readyState: video.readyState
  };
}

function sendPlaybackEvent(video, reason) {
  if (!settings.enabled) return;
  chrome.runtime.sendMessage({
    type: "video-playback-event",
    reason,
    video: describeVideo(video),
    frameUrl: location.href,
    ts: Date.now()
  });
}

function sendExtensionNotice(kind, title, detail = "", extra = {}) {
  if (!settings.enabled) return;
  try {
    chrome.runtime.sendMessage({
      type: "extension-notice",
      notice: {
        kind,
        title,
        detail,
        pageTitle: titleForPage(),
        pageUrl: location.href,
        frameUrl: location.href,
        ts: Date.now(),
        ...extra
      }
    });
  } catch {
    // Notification failures must not break the page workflow.
  }
}

function writeRuntimeLog(level, event, details = {}) {
  try {
    chrome.runtime.sendMessage({
      type: "runtime-log",
      level,
      source: "content",
      event,
      details: {
        diagnosticSessionId,
        pageTitle: titleForPage(),
        pageUrl: location.href,
        frameUrl: location.href,
        ...details
      }
    });
  } catch {
    // Logging is best-effort only.
  }
}

function installRuntimeErrorReporter() {
  const extensionBaseUrl = chrome.runtime.getURL("");
  const isOwnErrorEvent = (event) => {
    const filename = String(event.filename || "");
    return filename.startsWith(extensionBaseUrl);
  };
  const notify = (kind, error, fallback = "") => {
    const message = error instanceof Error
      ? `${error.name || "Error"}: ${error.message || fallback}`
      : String(error || fallback || "未知错误");
    const stack = error instanceof Error && error.stack ? `\n${error.stack}` : "";
    const dedupeKey = `${kind}:${message}`.slice(0, 240);
    const now = Date.now();
    const last = runtimeErrorNotifiedAt.get(dedupeKey) || 0;
    if (now - last < 60_000) return;
    runtimeErrorNotifiedAt.set(dedupeKey, now);
    writeRuntimeLog("error", "runtime_error", {
      message,
      stack
    });
    sendExtensionNotice(
      "runtime_error",
      "超星学习助手运行出错",
      `${message}${stack}`.slice(0, 1600),
      { dedupeKey, cooldownSeconds: 60 }
    );
  };

  window.addEventListener("error", (event) => {
    if (!isOwnErrorEvent(event)) return;
    notify("error", event.error, event.message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    notify("unhandledrejection", event.reason, "Promise 执行失败");
  });
}
