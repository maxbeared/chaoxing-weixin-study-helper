// Video navigation and playback monitoring.
function isVisible(element) {
  if (!(element instanceof HTMLElement)) return false;
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none") return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function findNextButton() {
  for (const selector of NEXT_SELECTORS) {
    const candidates = Array.from(document.querySelectorAll(selector));
    const visible = candidates.find(isVisible);
    if (visible) return visible;
  }
  return null;
}

function findNextConfirmButton() {
  const hasTaskTip = Array.from(document.querySelectorAll(".jobLimitTip, .popWord2"))
    .some((item) => cleanText(item.innerText).includes("当前章节还有任务点未完成"));
  for (const selector of NEXT_CONFIRM_SELECTORS) {
    const candidates = Array.from(document.querySelectorAll(selector));
    const visible = candidates.find(isVisible);
    if (visible && (hasTaskTip || visible.classList.contains("nextChapter"))) return visible;
  }
  return null;
}

function clickNextConfirmIfShown() {
  if (!settings.enabled || !settings.autoNextOnEnded) return false;
  const button = findNextConfirmButton();
  if (!button) return false;
  markAutoPlayWindow();
  button.click();
  scheduleAutoPlayAttempts();
  return true;
}

function markAutoPlayWindow() {
  try {
    sessionStorage.setItem(AUTOPLAY_KEY, String(Date.now() + 45_000));
  } catch {
    // Ignore storage restrictions in sandboxed frames.
  }
}

function shouldAutoPlayNow() {
  if (!settings.enabled || !settings.autoPlayNextVideo) return false;
  try {
    const until = Number(sessionStorage.getItem(AUTOPLAY_KEY) || "0");
    return Date.now() < until;
  } catch {
    return false;
  }
}

function findPrimaryVideo() {
  for (const selector of VIDEO_SELECTORS) {
    const video = document.querySelector(selector);
    if (video instanceof HTMLVideoElement) return video;
  }
  return null;
}

function playWithVideoJs(video) {
  try {
    if (typeof window.videojs !== "function") return false;
    const player = window.videojs(video.id || "video_html5_api");
    const result = player?.play?.();
    result?.catch?.(() => {});
    return Boolean(player);
  } catch {
    return false;
  }
}

function clickVideoJsPlayButton() {
  const button = document.querySelector(".vjs-big-play-button, .vjs-play-control");
  if (isVisible(button)) {
    button.click();
    return true;
  }
  return false;
}

function tryPlayVideo(video = findPrimaryVideo()) {
  if (!shouldAutoPlayNow() || !(video instanceof HTMLVideoElement)) return;
  if (!video.paused || video.ended) return;

  if (playWithVideoJs(video)) return;

  try {
    if (video.preload === "none" && video.readyState === HTMLMediaElement.HAVE_NOTHING) {
      video.load?.();
    }
  } catch {
    // Some player wrappers restrict direct load calls.
  }

  const playResult = video.play?.();
  playResult?.catch?.(() => {
    clickVideoJsPlayButton();
  });

  const retryPlay = () => {
    const retryResult = video.play?.();
    retryResult?.catch?.(() => {});
  };
  video.addEventListener("loadeddata", retryPlay, { once: true });
  video.addEventListener("canplay", retryPlay, { once: true });
}

function scheduleAutoPlayAttempts() {
  if (!settings.enabled || !settings.autoPlayNextVideo) return;
  for (const delay of [300, 900, 1800, 3500, 6500, 10000]) {
    setTimeout(() => tryPlayVideo(), delay);
  }
}

function scheduleNextConfirmAttempts() {
  if (!settings.enabled || !settings.autoNextOnEnded) return;
  for (const delay of [200, 500, 1000, 1800, 3000, 5000]) {
    setTimeout(() => clickNextConfirmIfShown(), delay);
  }
}

async function clickNextLesson(video) {
  if (!settings.enabled || !settings.autoNextOnEnded || nextClicked.has(video)) return;
  if (hasRemoteSubmitPending()) return;
  nextClicked.add(video);
  markAutoPlayWindow();

  const button = findNextButton();
  if (button) {
    try {
      writeRuntimeLog("info", "auto_next_clicking", {
        selector: button.id ? `#${button.id}` : button.className || button.tagName
      });
      sendExtensionNotice(
        "next_lesson",
        "正在切换下一节",
        `即将点击页面中的下一节按钮。\n选择器：${button.id ? `#${button.id}` : button.className || button.tagName}`,
        { dedupeKey: `next:${location.href}`, cooldownSeconds: 10 }
      );
      button.click();
      scheduleNextConfirmAttempts();
      scheduleAutoPlayAttempts();
    } catch (error) {
      writeRuntimeLog("error", "auto_next_click_failed", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack || "" : ""
      });
      sendExtensionNotice(
        "runtime_error",
        "切换下一节失败",
        error instanceof Error ? error.message : String(error),
        { dedupeKey: `next-error:${location.href}`, cooldownSeconds: 30 }
      );
    }
    return;
  }

  const response = await askExtension({
    type: "auto-next-request",
    pageUrl: location.href,
    ts: Date.now()
  });
  if (response?.ok) {
    writeRuntimeLog("info", "auto_next_clicked_in_frames", response);
    sendExtensionNotice(
      "next_lesson",
      "正在切换下一节",
      `已在页面所有 frame 中触发下一节按钮。${response.selector ? `\n选择器：${response.selector}` : ""}`,
      { dedupeKey: `next:${location.href}`, cooldownSeconds: 10 }
    );
  } else {
    writeRuntimeLog("error", "auto_next_failed", response || { error: "No response" });
    sendExtensionNotice(
      "runtime_error",
      "切换下一节失败",
      response?.error || "没有找到下一节按钮。",
      { dedupeKey: `next-error:${location.href}`, cooldownSeconds: 30 }
    );
  }
  scheduleNextConfirmAttempts();
  scheduleAutoPlayAttempts();
}

function clearPauseTimer(video) {
  const timer = timers.get(video);
  if (timer) {
    clearTimeout(timer);
    timers.delete(video);
  }
}

function onPause(video) {
  clearPauseTimer(video);
  if (!settings.notifyOnPause || video.ended) return;
  const delay = Math.max(0, Number(settings.pauseDebounceSeconds) || 0) * 1000;
  const timer = setTimeout(() => {
    timers.delete(video);
    if (video.paused && !video.ended) {
      sendPlaybackEvent(video, "paused");
    }
  }, delay);
  timers.set(video, timer);
}

function onEnded(video) {
  clearPauseTimer(video);
  if (endedHandled.has(video)) return;
  endedHandled.add(video);
  if (settings.notifyOnEnded) {
    sendPlaybackEvent(video, "ended");
  }
  clickNextLesson(video);
}

function isVideoCompleted(video) {
  if (!(video instanceof HTMLVideoElement)) return false;
  if (video.ended) return true;
  const duration = Number(video.duration);
  const currentTime = Number(video.currentTime);
  return Number.isFinite(duration) && duration > 0 &&
    Number.isFinite(currentTime) && currentTime >= Math.max(0, duration - 0.5);
}

function checkAlreadyCompletedVideo(video) {
  if (isVideoCompleted(video)) {
    onEnded(video);
  }
}

function onStalled(video, reason) {
  if (!settings.notifyOnStalled || video.paused || video.ended) return;
  const previous = lastProgress.get(video) || 0;
  const now = Date.now();
  if (now - previous > 5000) {
    sendPlaybackEvent(video, reason);
    lastProgress.set(video, now);
  }
}

function watchVideo(video) {
  if (!(video instanceof HTMLVideoElement) || observed.has(video)) return;
  observed.add(video);
  video.setAttribute(VIDEO_MARK, String(++videoSeq));
  lastProgress.set(video, Date.now());

  video.addEventListener("play", () => clearPauseTimer(video), true);
  video.addEventListener("playing", () => {
    clearPauseTimer(video);
    lastProgress.set(video, Date.now());
  }, true);
  video.addEventListener("timeupdate", () => lastProgress.set(video, Date.now()), true);
  video.addEventListener("pause", () => onPause(video), true);
  video.addEventListener("ended", () => onEnded(video), true);
  video.addEventListener("loadedmetadata", () => checkAlreadyCompletedVideo(video), true);
  video.addEventListener("durationchange", () => checkAlreadyCompletedVideo(video), true);
  video.addEventListener("loadeddata", () => tryPlayVideo(video), true);
  video.addEventListener("canplay", () => tryPlayVideo(video), true);
  video.addEventListener("stalled", () => onStalled(video, "stalled"), true);
  video.addEventListener("waiting", () => onStalled(video, "waiting"), true);
  tryPlayVideo(video);
  setTimeout(() => checkAlreadyCompletedVideo(video), 300);
  setTimeout(() => checkAlreadyCompletedVideo(video), 2000);
}

function scanVideos(root = document) {
  if (root instanceof HTMLVideoElement) {
    watchVideo(root);
    return;
  }
  root.querySelectorAll?.("video").forEach(watchVideo);
}

