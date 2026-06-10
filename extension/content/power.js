// Screen wake lock control.
function isTopFrame() {
  return window.top === window;
}

function shouldKeepScreenAwake() {
  return isTopFrame() && settings.enabled && settings.preventSleep;
}

function clearWakeLockRetry() {
  if (screenWakeLockRetryTimer) {
    window.clearTimeout(screenWakeLockRetryTimer);
    screenWakeLockRetryTimer = 0;
  }
}

function scheduleWakeLockRetry(reason) {
  clearWakeLockRetry();
  if (!shouldKeepScreenAwake()) return;
  screenWakeLockRetryTimer = window.setTimeout(() => {
    screenWakeLockRetryTimer = 0;
    requestScreenWakeLock(`retry:${reason}`);
  }, 30_000);
}

function setExtensionKeepAwake(active, reason = "update") {
  if (!isTopFrame()) return;
  try {
    chrome.runtime.sendMessage({
      type: "power-keep-awake",
      active: Boolean(active),
      reason,
      pageUrl: location.href,
      ts: Date.now()
    }, () => {
      const err = chrome.runtime.lastError;
      if (err) {
        writeRuntimeLog("error", "extension_keep_awake_failed", {
          active: Boolean(active),
          reason,
          error: err.message
        });
      }
    });
  } catch (error) {
    writeRuntimeLog("error", "extension_keep_awake_exception", {
      active: Boolean(active),
      reason,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function refreshExtensionKeepAwake(reason = "refresh") {
  setExtensionKeepAwake(shouldKeepScreenAwake(), reason);
}

async function releaseScreenWakeLock(reason = "release") {
  clearWakeLockRetry();
  setExtensionKeepAwake(false, reason);
  const lock = screenWakeLock;
  screenWakeLock = null;
  if (!lock) return;
  try {
    await lock.release();
    writeRuntimeLog("info", "wake_lock_released", { reason });
  } catch (error) {
    writeRuntimeLog("error", "wake_lock_release_failed", {
      reason,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function requestScreenWakeLock(reason = "request") {
  if (!isTopFrame()) return;
  if (!shouldKeepScreenAwake()) {
    await releaseScreenWakeLock("disabled");
    return;
  }
  setExtensionKeepAwake(true, reason);
  if (!("wakeLock" in navigator)) {
    if (!screenWakeLockUnsupportedLogged) {
      screenWakeLockUnsupportedLogged = true;
      writeRuntimeLog("error", "wake_lock_unsupported", {
        reason,
        userAgent: navigator.userAgent || ""
      });
    }
    return;
  }
  if (document.visibilityState !== "visible") {
    writeRuntimeLog("info", "wake_lock_waiting_for_visible_page", { reason });
    return;
  }
  if (screenWakeLock || screenWakeLockRequesting) return;

  screenWakeLockRequesting = true;
  try {
    screenWakeLock = await navigator.wakeLock.request("screen");
    clearWakeLockRetry();
    writeRuntimeLog("info", "wake_lock_acquired", {
      reason,
      visibilityState: document.visibilityState
    });
    screenWakeLock.addEventListener("release", () => {
      screenWakeLock = null;
      writeRuntimeLog("info", "wake_lock_auto_released", {
        reason,
        visibilityState: document.visibilityState
      });
      if (document.visibilityState === "visible") {
        scheduleWakeLockRetry("auto_released");
      }
    });
  } catch (error) {
    screenWakeLock = null;
    writeRuntimeLog("error", "wake_lock_request_failed", {
      reason,
      visibilityState: document.visibilityState,
      error: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name || "" : ""
    });
    scheduleWakeLockRetry("request_failed");
  } finally {
    screenWakeLockRequesting = false;
  }
}

function refreshScreenWakeLock(reason = "refresh") {
  if (!isTopFrame()) return;
  refreshExtensionKeepAwake(reason);
  if (shouldKeepScreenAwake()) {
    requestScreenWakeLock(reason);
  } else {
    releaseScreenWakeLock(reason);
  }
}

function installScreenWakeLockController() {
  if (!isTopFrame()) return;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      requestScreenWakeLock("visible");
    } else {
      writeRuntimeLog("info", "wake_lock_page_hidden", {
        visibilityState: document.visibilityState
      });
    }
  });
  window.addEventListener("pageshow", () => requestScreenWakeLock("pageshow"));
  window.addEventListener("pagehide", () => releaseScreenWakeLock("pagehide"));
  if (!extensionKeepAwakeHeartbeatTimer) {
    extensionKeepAwakeHeartbeatTimer = window.setInterval(() => refreshExtensionKeepAwake("heartbeat"), 60_000);
  }
  requestScreenWakeLock("startup");
}
