const HOST_NAME = "com.audio_check.weixin_monitor";

const DEFAULTS = {
  enabled: true,
  autoNextOnEnded: true,
  autoPlayNextVideo: true,
  targetId: "",
  accountId: "",
  lastContextToken: "",
  cooldownSeconds: 120,
  includeUrl: true,
  notifyOnPause: true,
  notifyOnEnded: true,
  notifyOnStalled: true,
  pauseDebounceSeconds: 3
};

let lastSentAtByKey = new Map();

function storageGet(defaults = DEFAULTS) {
  return new Promise((resolve) => chrome.storage.sync.get(defaults, resolve));
}

function nativeSend(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendNativeMessage(HOST_NAME, message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        resolve({ ok: false, error: err.message });
      } else {
        resolve(response || { ok: false, error: "Native host returned no response." });
      }
    });
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function captureVisibleTabForSender(sender, message) {
  const tabId = sender.tab?.id;
  const windowId = sender.tab?.windowId;
  if (!tabId || windowId === undefined) {
    return { ok: false, error: "No sender tab available for screenshot." };
  }

  try {
    await chrome.tabs.update(tabId, { active: true });
  } catch {
    // If Chrome refuses to focus the tab, try capture anyway.
  }
  await wait(Math.max(0, Number(message.delayMs) || 150));

  return new Promise((resolve) => {
    chrome.tabs.captureVisibleTab(
      windowId,
      {
        format: message.format === "png" ? "png" : "jpeg",
        quality: Math.min(100, Math.max(30, Number(message.quality) || 82))
      },
      (dataUrl) => {
        const err = chrome.runtime.lastError;
        if (err) resolve({ ok: false, error: err.message });
        else resolve({ ok: true, dataUrl });
      }
    );
  });
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const rounded = Math.floor(seconds);
  const h = Math.floor(rounded / 3600);
  const m = Math.floor((rounded % 3600) / 60);
  const s = rounded % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function buildNotice(reason, video, includeUrl) {
  const reasonText = {
    paused: "暂停",
    ended: "结束",
    stalled: "停止响应",
    waiting: "缓冲等待"
  }[reason] || reason;
  const lines = [
    `视频播放${reasonText}`,
    `页面：${video.pageTitle || "未命名页面"}`,
    `进度：${formatTime(video.currentTime)} / ${formatTime(video.duration)}`
  ];
  if (includeUrl && video.pageUrl) lines.push(`链接：${video.pageUrl}`);
  return lines.join("\n");
}

async function handlePlaybackEvent(message, sender) {
  const settings = await storageGet();
  if (!settings.enabled) return { ok: false, skipped: true, reason: "disabled" };
  if (!settings.targetId) return { ok: false, skipped: true, reason: "missing_target" };

  const tabId = sender.tab?.id ?? "unknown";
  const key = `${tabId}:${message.reason}:${message.video?.pageUrl || ""}`;
  const cooldownMs = Math.max(0, Number(settings.cooldownSeconds) || 0) * 1000;
  const now = Date.now();
  const last = lastSentAtByKey.get(key) || 0;
  if (now - last < cooldownMs) {
    return { ok: true, skipped: true, reason: "cooldown" };
  }

  lastSentAtByKey.set(key, now);
  const text = buildNotice(message.reason, message.video || {}, settings.includeUrl);
  const result = await nativeSend({
    type: "sendText",
    targetId: settings.targetId,
    accountId: settings.accountId || undefined,
    contextToken: settings.lastContextToken || undefined,
    text
  });

  await chrome.storage.local.set({
    lastDelivery: {
      at: now,
      ok: Boolean(result.ok),
      reason: message.reason,
      pageTitle: message.video?.pageTitle || "",
      error: result.error || ""
    }
  });
  return result;
}

async function clickNextInAllFrames(sender) {
  const tabId = sender.tab?.id;
  if (!tabId) return { ok: false, error: "No tab id for auto-next request." };

  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => {
      const selectors = [
        "#prevNextFocusNext",
        ".prev_next.next",
        ".jb_btn.prev_next.next",
        "[role='button'][onclick*='PCount.next']",
        "[onclick*='PCount.next']"
      ];
      const confirmSelectors = [
        ".popDiv .nextChapter",
        ".popBottom .nextChapter",
        "a.nextChapter[onclick*='PCount.next']"
      ];
      const isVisible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none") return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const clickConfirmIfShown = () => {
        const hasTaskTip = Array.from(document.querySelectorAll(".jobLimitTip, .popWord2"))
          .some((item) => String(item.innerText || "").replace(/\s+/g, " ").trim().includes("当前章节还有任务点未完成"));
        for (const selector of confirmSelectors) {
          const button = Array.from(document.querySelectorAll(selector)).find(isVisible);
          if (button && (hasTaskTip || button.classList.contains("nextChapter"))) {
            button.click();
            return { clicked: true, selector, confirm: true };
          }
        }
        return null;
      };
      try {
        sessionStorage.setItem("audioCheckAutoPlayNextUntil", String(Date.now() + 45_000));
      } catch {
        // Ignore storage restrictions.
      }
      const immediateConfirm = clickConfirmIfShown();
      if (immediateConfirm) return immediateConfirm;
      for (const selector of selectors) {
        const button = Array.from(document.querySelectorAll(selector)).find(isVisible);
        if (button) {
          button.click();
          for (const delay of [200, 500, 1000, 1800, 3000]) {
            setTimeout(clickConfirmIfShown, delay);
          }
          return { clicked: true, selector };
        }
      }
      return { clicked: false };
    }
  });

  const clicked = results.find((item) => item.result?.clicked);
  return clicked ? { ok: true, ...clicked.result } : { ok: false, error: "Next button not found." };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "video-playback-event") {
    handlePlaybackEvent(message, sender).then(sendResponse);
    return true;
  }
  if (message?.type === "auto-next-request") {
    clickNextInAllFrames(sender).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
    return true;
  }
  if (message?.type === "native") {
    nativeSend(message.payload).then(sendResponse);
    return true;
  }
  if (message?.type === "capture-visible-tab") {
    captureVisibleTabForSender(sender, message).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
    return true;
  }
  return false;
});
