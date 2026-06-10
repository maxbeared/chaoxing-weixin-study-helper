const HOST_NAME = "com.audio_check.weixin_monitor";

const DEFAULTS = {
  enabled: true,
  autoNextOnEnded: true,
  autoPlayNextVideo: true,
  preventSleep: true,
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

const EXTENSION_LOGS_KEY = "audioCheckRuntimeLogs";
const MAX_EXTENSION_LOGS = 2000;

let lastSentAtByKey = new Map();
let runtimeErrorNotifiedAt = new Map();
let keepAwakeTabIds = new Set();
let powerKeepAwakeActive = false;

function storageGet(defaults = DEFAULTS) {
  return new Promise((resolve) => chrome.storage.sync.get(defaults, resolve));
}

function storageLocalGet(defaults) {
  return new Promise((resolve) => chrome.storage.local.get(defaults, resolve));
}

function storageLocalSet(values) {
  return new Promise((resolve) => chrome.storage.local.set(values, resolve));
}

function compactDetails(details) {
  if (details === undefined || details === null) return {};
  try {
    return JSON.parse(JSON.stringify(details, (key, value) => {
      if (/token|key|authorization|apiKey|api_key/i.test(key)) return "[redacted]";
      if (typeof value === "string" && value.length > 1200) return `${value.slice(0, 1200)}...`;
      return value;
    }));
  } catch {
    return { value: String(details).slice(0, 1200) };
  }
}

async function appendExtensionLog(level, source, event, details = {}, sender = {}) {
  const entry = {
    at: new Date().toISOString(),
    level,
    source,
    event,
    tabId: sender.tab?.id ?? "",
    url: sender.tab?.url || details.pageUrl || details.url || "",
    details: compactDetails(details)
  };
  try {
    const stored = await storageLocalGet({ [EXTENSION_LOGS_KEY]: [] });
    const logs = Array.isArray(stored[EXTENSION_LOGS_KEY]) ? stored[EXTENSION_LOGS_KEY] : [];
    logs.push(entry);
    await storageLocalSet({ [EXTENSION_LOGS_KEY]: logs.slice(-MAX_EXTENSION_LOGS) });
  } catch {
    // Logging must never affect extension behavior.
  }
}

function nativeSend(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendNativeMessage(HOST_NAME, message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        appendExtensionLog("error", "background", "native_message_failed", {
          type: message?.type || "",
          error: err.message
        });
        resolve({ ok: false, error: err.message });
      } else {
        if (response?.ok === false) {
          appendExtensionLog("error", "background", "native_message_error", {
            type: message?.type || "",
            error: response.error || "Native host returned an error."
          });
        }
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
    appendExtensionLog("error", "background", "capture_failed", { error: "No sender tab available for screenshot." }, sender);
    return { ok: false, error: "No sender tab available for screenshot." };
  }

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    appendExtensionLog("error", "background", "capture_failed", { error: "Sender tab is no longer available." }, sender);
    return { ok: false, error: "Sender tab is no longer available." };
  }
  if (!tab.active) {
    appendExtensionLog("info", "background", "capture_skipped_inactive_tab", { pageUrl: sender.tab?.url || "" }, sender);
    return { ok: false, inactiveTab: true, error: "课程标签页不在前台，已改用后台题目截图。" };
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
        if (err) {
          appendExtensionLog("error", "background", "capture_failed", { error: err.message }, sender);
          resolve({ ok: false, error: err.message });
        } else {
          appendExtensionLog("info", "background", "capture_visible_tab_ok", { format: message.format || "jpeg" }, sender);
          resolve({ ok: true, dataUrl });
        }
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

function buildExtensionNotice(message, includeUrl) {
  const notice = message.notice || {};
  const lines = [
    notice.title || "扩展通知"
  ];
  if (notice.detail) lines.push(String(notice.detail).slice(0, 1200));
  if (notice.pageTitle) lines.push(`页面：${notice.pageTitle}`);
  if (includeUrl && notice.pageUrl) lines.push(`链接：${notice.pageUrl}`);
  return lines.join("\n");
}

async function sendWeixinNotice(message, sender, text, reason, pageTitle, pageUrl, cooldownSeconds) {
  const settings = await storageGet();
  if (!settings.enabled) {
    appendExtensionLog("info", "background", "weixin_notice_skipped", { reason: "disabled", noticeReason: reason }, sender);
    return { ok: false, skipped: true, reason: "disabled" };
  }
  if (!settings.targetId) {
    appendExtensionLog("info", "background", "weixin_notice_skipped", { reason: "missing_target", noticeReason: reason }, sender);
    return { ok: false, skipped: true, reason: "missing_target" };
  }

  const tabId = sender.tab?.id ?? "unknown";
  const key = `${tabId}:${reason}:${pageUrl || ""}:${message.notice?.dedupeKey || ""}`;
  const cooldownMs = Math.max(0, Number(cooldownSeconds ?? settings.cooldownSeconds) || 0) * 1000;
  const now = Date.now();
  const last = lastSentAtByKey.get(key) || 0;
  if (now - last < cooldownMs) {
    appendExtensionLog("info", "background", "weixin_notice_skipped", { reason: "cooldown", noticeReason: reason }, sender);
    return { ok: true, skipped: true, reason: "cooldown" };
  }

  lastSentAtByKey.set(key, now);
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
      reason,
      pageTitle: pageTitle || "",
      error: result.error || ""
    }
  });
  appendExtensionLog(result.ok ? "info" : "error", "background", "weixin_notice_sent", {
    noticeReason: reason,
    pageTitle,
    pageUrl,
    ok: Boolean(result.ok),
    error: result.error || ""
  }, sender);
  return result;
}

async function handlePlaybackEvent(message, sender) {
  const settings = await storageGet();
  if (!settings.enabled) {
    appendExtensionLog("info", "background", "playback_notice_skipped", { reason: "disabled", playbackReason: message.reason }, sender);
    return { ok: false, skipped: true, reason: "disabled" };
  }
  if (!settings.targetId) {
    appendExtensionLog("info", "background", "playback_notice_skipped", { reason: "missing_target", playbackReason: message.reason }, sender);
    return { ok: false, skipped: true, reason: "missing_target" };
  }

  const tabId = sender.tab?.id ?? "unknown";
  const key = `${tabId}:${message.reason}:${message.video?.pageUrl || ""}`;
  const cooldownMs = Math.max(0, Number(settings.cooldownSeconds) || 0) * 1000;
  const now = Date.now();
  const last = lastSentAtByKey.get(key) || 0;
  if (now - last < cooldownMs) {
    appendExtensionLog("info", "background", "playback_notice_skipped", { reason: "cooldown", playbackReason: message.reason }, sender);
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
  appendExtensionLog(result.ok ? "info" : "error", "background", "playback_notice_sent", {
    playbackReason: message.reason,
    pageTitle: message.video?.pageTitle || "",
    pageUrl: message.video?.pageUrl || "",
    ok: Boolean(result.ok),
    error: result.error || ""
  }, sender);
  return result;
}

async function handleExtensionNotice(message, sender) {
  const settings = await storageGet();
  const notice = message.notice || {};
  const text = buildExtensionNotice(message, settings.includeUrl);
  return sendWeixinNotice(
    message,
    sender,
    text,
    notice.kind || "extension_notice",
    notice.pageTitle || "",
    notice.pageUrl || "",
    notice.cooldownSeconds
  );
}

async function updatePowerKeepAwake(message, sender) {
  const tabId = sender.tab?.id;
  if (tabId === undefined) {
    appendExtensionLog("error", "background", "power_keep_awake_failed", {
      active: Boolean(message.active),
      reason: message.reason || "",
      error: "No sender tab id."
    }, sender);
    return { ok: false, error: "No sender tab id." };
  }

  if (message.active) {
    keepAwakeTabIds.add(tabId);
  } else {
    keepAwakeTabIds.delete(tabId);
  }

  try {
    if (keepAwakeTabIds.size > 0) {
      chrome.power.requestKeepAwake("display");
      if (!powerKeepAwakeActive) {
        appendExtensionLog("info", "background", "power_keep_awake_requested", {
          reason: message.reason || "",
          activeTabs: Array.from(keepAwakeTabIds)
        }, sender);
      }
      powerKeepAwakeActive = true;
    } else {
      chrome.power.releaseKeepAwake();
      if (powerKeepAwakeActive) {
        appendExtensionLog("info", "background", "power_keep_awake_released", {
          reason: message.reason || ""
        }, sender);
      }
      powerKeepAwakeActive = false;
    }
    return { ok: true, active: powerKeepAwakeActive, activeTabCount: keepAwakeTabIds.size };
  } catch (error) {
    appendExtensionLog("error", "background", "power_keep_awake_failed", {
      active: Boolean(message.active),
      reason: message.reason || "",
      error: error instanceof Error ? error.message : String(error)
    }, sender);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function installRuntimeErrorReporter() {
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

    const noticeMessage = {
      notice: {
        kind: "runtime_error",
        title: "超星学习助手后台运行出错",
        detail: `${message}${stack}`.slice(0, 1600),
        pageTitle: "扩展后台",
        pageUrl: "",
        dedupeKey,
        cooldownSeconds: 60
      }
    };
    sendWeixinNotice(
      noticeMessage,
      {},
      buildExtensionNotice(noticeMessage, false),
      "runtime_error",
      "扩展后台",
      "",
      60
    ).catch(() => {});
    appendExtensionLog("error", "background", "runtime_error", {
      message,
      stack
    });
  };

  self.addEventListener("error", (event) => {
    notify("background_error", event.error, event.message);
  });
  self.addEventListener("unhandledrejection", (event) => {
    notify("background_unhandledrejection", event.reason, "Promise 执行失败");
  });
}

async function clickNextInAllFrames(sender, message = {}) {
  const tabId = sender.tab?.id;
  if (!tabId) {
    appendExtensionLog("error", "background", "auto_next_failed", { error: "No tab id for auto-next request." }, sender);
    return { ok: false, error: "No tab id for auto-next request." };
  }
  appendExtensionLog("info", "background", "auto_next_frame_request_started", {
    trigger: message.trigger || "",
    pageUrl: message.pageUrl || sender.tab?.url || "",
    diagnostic: message.diagnostic || null
  }, sender);

  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => {
      const selectors = [
        "#prevNextFocusNext",
        "#prevNextFocusNext a",
        ".prev_next.next a",
        ".prev_next.next",
        ".jb_btn.prev_next.next",
        ".jb_btn.prev_next.next a",
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
      const normalizeText = (text) => String(text || "").replace(/\s+/g, " ").trim();
      const clipText = (value, max = 160) => {
        const text = normalizeText(value);
        return text.length > max ? `${text.slice(0, max)}...` : text;
      };
      const describeButton = (element) => {
        if (!(element instanceof HTMLElement)) return null;
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName,
          id: element.id || "",
          className: typeof element.className === "string" ? clipText(element.className, 120) : "",
          text: clipText([
            element.innerText,
            element.textContent,
            element.getAttribute("title"),
            element.getAttribute("aria-label"),
            element.getAttribute("value")
          ].filter(Boolean).join(" "), 160),
          onclick: clipText(element.getAttribute("onclick") || "", 200),
          href: clipText(element.getAttribute("href") || "", 200),
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          }
        };
      };
      const isNextLikeElement = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const onclick = String(element.getAttribute("onclick") || "");
        if (/PCount\.next/i.test(onclick)) return true;
        const text = normalizeText([
          element.innerText,
          element.textContent,
          element.getAttribute("title"),
          element.getAttribute("aria-label"),
          element.getAttribute("value")
        ].filter(Boolean).join(" "));
        if (/上一节|上一章|上一个|上一课|prev|previous/i.test(text)) return false;
        if (/下一节|下一章|下一个|下一课|next/i.test(text)) return true;
        return element.id === "prevNextFocusNext";
      };
      const findNextButton = () => {
        for (const selector of selectors) {
          const button = Array.from(document.querySelectorAll(selector)).find(isVisible);
          if (button) return { button, selector };
        }
        const fallback = Array.from(document.querySelectorAll("a, button, [role='button'], input[type='button'], input[type='submit'], [onclick]"))
          .find((item) => isVisible(item) && isNextLikeElement(item));
        return fallback ? { button: fallback, selector: "text-or-attribute-next" } : null;
      };
      const hasPreviousLessonButton = () => {
        return Array.from(document.querySelectorAll("a, button, [role='button'], input[type='button'], input[type='submit'], [onclick], #prevNextFocusPrev"))
          .some((element) => {
            if (!isVisible(element)) return false;
            const text = normalizeText([
              element.innerText,
              element.textContent,
              element.getAttribute("title"),
              element.getAttribute("aria-label"),
              element.getAttribute("value"),
              element.getAttribute("onclick")
            ].filter(Boolean).join(" "));
            return /上一节|上一章|上一个|上一课|prev|previous|PCount\.pre/i.test(text) ||
              element.id === "prevNextFocusPrev";
          });
      };
      const clickConfirmIfShown = () => {
        const hasTaskTip = Array.from(document.querySelectorAll(".jobLimitTip, .popWord2, .popDiv, .popBottom"))
          .some((item) => normalizeText(item.innerText).includes("当前章节还有任务点未完成"));
        for (const selector of confirmSelectors) {
          const button = Array.from(document.querySelectorAll(selector)).find(isVisible);
          if (button && (hasTaskTip || button.classList.contains("nextChapter") || isNextLikeElement(button))) {
            button.click();
            return { clicked: true, selector, confirm: true, hasTaskTip, frameUrl: location.href, frameTitle: document.title, button: describeButton(button) };
          }
        }
        if (hasTaskTip) {
          const next = findNextButton();
          if (next) {
            next.button.click();
            return { clicked: true, selector: next.selector, confirm: true, hasTaskTip, frameUrl: location.href, frameTitle: document.title, button: describeButton(next.button) };
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
      const next = findNextButton();
      if (next) {
        next.button.click();
        for (const delay of [200, 500, 1000, 1800, 3000, 5000, 8000, 12000]) {
          setTimeout(clickConfirmIfShown, delay);
        }
        return { clicked: true, selector: next.selector, frameUrl: location.href, frameTitle: document.title, button: describeButton(next.button) };
      }
      return {
        clicked: false,
        lastLesson: hasPreviousLessonButton(),
        frameUrl: location.href,
        frameTitle: document.title,
        readyState: document.readyState,
        nextCandidateCount: selectors.reduce((count, selector) => count + document.querySelectorAll(selector).length, 0),
        confirmCandidateCount: confirmSelectors.reduce((count, selector) => count + document.querySelectorAll(selector).length, 0)
      };
    }
  });

  const clicked = results.find((item) => item.result?.clicked);
  const lastLesson = !clicked && results.some((item) => item.result?.lastLesson);
  const response = clicked
    ? { ok: true, frameId: clicked.frameId, ...clicked.result }
    : { ok: false, lastLesson, error: lastLesson ? "Already at the last lesson." : "Next button not found." };
  appendExtensionLog(
    response.ok || response.lastLesson ? "info" : "error",
    "background",
    response.ok ? "auto_next_clicked" : response.lastLesson ? "auto_next_last_lesson" : "auto_next_failed",
    {
      trigger: message.trigger || "",
      ...response,
      frameResults: results.map((item) => ({ frameId: item.frameId, result: item.result })).slice(0, 20)
    },
    sender
  );
  return response;
}

installRuntimeErrorReporter();

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!keepAwakeTabIds.delete(tabId)) return;
  if (keepAwakeTabIds.size === 0) {
    try {
      chrome.power.releaseKeepAwake();
      powerKeepAwakeActive = false;
      appendExtensionLog("info", "background", "power_keep_awake_released", {
        reason: "tab_removed"
      });
    } catch (error) {
      appendExtensionLog("error", "background", "power_keep_awake_failed", {
        reason: "tab_removed",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "video-playback-event") {
    handlePlaybackEvent(message, sender).then(sendResponse);
    return true;
  }
  if (message?.type === "extension-notice") {
    handleExtensionNotice(message, sender).then(sendResponse);
    return true;
  }
  if (message?.type === "auto-next-request") {
    clickNextInAllFrames(sender, message).then(sendResponse).catch((error) => {
      appendExtensionLog("error", "background", "auto_next_exception", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack || "" : ""
      }, sender);
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
    return true;
  }
  if (message?.type === "runtime-log") {
    appendExtensionLog(message.level || "info", message.source || "content", message.event || "log", message.details || {}, sender)
      .then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === "power-keep-awake") {
    updatePowerKeepAwake(message, sender).then(sendResponse);
    return true;
  }
  if (message?.type === "get-extension-logs") {
    storageLocalGet({ [EXTENSION_LOGS_KEY]: [] }).then((stored) => {
      sendResponse({ ok: true, logs: stored[EXTENSION_LOGS_KEY] || [] });
    });
    return true;
  }
  if (message?.type === "clear-extension-logs") {
    storageLocalSet({ [EXTENSION_LOGS_KEY]: [] }).then(() => sendResponse({ ok: true }));
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
