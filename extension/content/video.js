// Video navigation and playback monitoring.
function isVisible(element) {
  if (!(element instanceof HTMLElement)) return false;
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none") return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function normalizeUiText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function clipLogText(value, max = 160) {
  const text = normalizeUiText(value);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function describeElementForLog(element) {
  if (!(element instanceof HTMLElement)) return null;
  const rect = element.getBoundingClientRect();
  return {
    tag: element.tagName,
    id: element.id || "",
    className: typeof element.className === "string" ? clipLogText(element.className, 120) : "",
    text: clipLogText([
      element.innerText,
      element.textContent,
      element.getAttribute("title"),
      element.getAttribute("aria-label"),
      element.getAttribute("value")
    ].filter(Boolean).join(" "), 160),
    onclick: clipLogText(element.getAttribute("onclick") || "", 200),
    href: clipLogText(element.getAttribute("href") || "", 200),
    visible: isVisible(element),
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    }
  };
}

function describeVideoForLog(video) {
  if (!(video instanceof HTMLVideoElement)) return null;
  return {
    mark: video.getAttribute(VIDEO_MARK) || "",
    src: clipLogText(video.currentSrc || video.src || "", 220),
    currentTime: Number.isFinite(video.currentTime) ? Number(video.currentTime.toFixed(3)) : 0,
    duration: Number.isFinite(video.duration) ? Number(video.duration.toFixed(3)) : 0,
    paused: video.paused,
    ended: video.ended,
    readyState: video.readyState,
    networkState: video.networkState,
    played: playedVideos.has(video),
    replayedUnmarked: replayedUnmarkedVideos.has(video)
  };
}

function describeVideosForLog(doc = document) {
  try {
    return Array.from(doc.querySelectorAll("video")).slice(0, 5).map(describeVideoForLog);
  } catch {
    return [];
  }
}

function describeMarkersForLog(doc = document) {
  return getCompletedJobMarkers(doc).slice(0, 8).map(describeElementForLog);
}

function getAutoNextDiagnostic(doc = document, extra = {}) {
  return {
    pageAgeMs: Date.now() - contentScriptStartedAt,
    topPageKey: getAutoNextPageKey(),
    frameReadyState: doc?.readyState || "",
    documentHidden: document.hidden,
    playedSinceNavigation,
    videos: describeVideosForLog(doc),
    completedJobMarkers: describeMarkersForLog(doc),
    nextButton: describeElementForLog(findNextButton()),
    ...extra
  };
}

function isNextLikeElement(element) {
  if (!(element instanceof HTMLElement)) return false;
  const onclick = String(element.getAttribute("onclick") || "");
  if (/PCount\.next/i.test(onclick)) return true;
  const text = normalizeUiText([
    element.innerText,
    element.textContent,
    element.getAttribute("title"),
    element.getAttribute("aria-label"),
    element.getAttribute("value")
  ].filter(Boolean).join(" "));
  if (/上一节|上一章|上一个|上一课|prev|previous/i.test(text)) return false;
  if (/下一节|下一章|下一个|下一课|next/i.test(text)) return true;
  return element.id === "prevNextFocusNext";
}

function findNextButton() {
  for (const selector of NEXT_SELECTORS) {
    const candidates = Array.from(document.querySelectorAll(selector));
    const visible = candidates.find(isVisible);
    if (visible) return visible;
  }
  const fallbackCandidates = Array.from(document.querySelectorAll("a, button, [role='button'], input[type='button'], input[type='submit'], [onclick]"));
  return fallbackCandidates.find((item) => isVisible(item) && isNextLikeElement(item)) || null;
}

function hasPreviousLessonButton() {
  return Array.from(document.querySelectorAll("a, button, [role='button'], input[type='button'], input[type='submit'], [onclick], #prevNextFocusPrev"))
    .some((element) => {
      if (!isVisible(element)) return false;
      const text = normalizeUiText([
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
}

function notifyLastLesson(response = {}) {
  writeRuntimeLog("info", "auto_next_last_lesson", response);
  sendExtensionNotice(
    "next_lesson",
    "已到最后一节",
    "没有找到可用的下一节按钮，当前课程可能已经到最后一节。",
    { dedupeKey: `last-lesson:${location.href}`, cooldownSeconds: 60 }
  );
}

function isTaskTipShown() {
  return Array.from(document.querySelectorAll(".jobLimitTip, .popWord2, .popDiv, .popBottom"))
    .some((item) => normalizeUiText(item.innerText).includes("当前章节还有任务点未完成"));
}

function findNextConfirmButton() {
  const hasTaskTip = isTaskTipShown();
  for (const selector of NEXT_CONFIRM_SELECTORS) {
    const candidates = Array.from(document.querySelectorAll(selector));
    const visible = candidates.find(isVisible);
    if (visible && (hasTaskTip || visible.classList.contains("nextChapter") || isNextLikeElement(visible))) return visible;
  }
  if (hasTaskTip) return findNextButton();
  return null;
}

function clickNextConfirmIfShown() {
  if (!settings.enabled || !settings.autoNextOnEnded) return false;
  const button = findNextConfirmButton();
  if (!button) return false;
  writeRuntimeLog("info", "auto_next_confirm_clicking", getAutoNextDiagnostic(document, {
    trigger: "confirm-dialog",
    button: describeElementForLog(button)
  }));
  markAutoPlayWindow();
  button.click();
  scheduleAutoPlayAttempts();
  return true;
}

function getAutoNextPageKey() {
  try {
    return top.location.href || location.href;
  } catch {
    return location.href;
  }
}

function claimAutoNext(reason) {
  try {
    const now = Date.now();
    const pageKey = getAutoNextPageKey();
    const value = sessionStorage.getItem(AUTO_NEXT_CLAIM_KEY);
    if (value) {
      const parsed = JSON.parse(value);
      if (parsed?.pageKey === pageKey && now - Number(parsed.ts || 0) < 10_000) {
        writeRuntimeLog("info", "auto_next_claim_skipped", {
          reason,
          claimedBy: parsed.reason || "",
          ageMs: now - Number(parsed.ts || 0)
        });
        return false;
      }
    }
    sessionStorage.setItem(AUTO_NEXT_CLAIM_KEY, JSON.stringify({ pageKey, reason, ts: now }));
  } catch {
    // If storage is unavailable, continue with the local in-memory guards.
  }
  return true;
}

function getCompletedJobMarkers(doc = document) {
  return Array.from(doc.querySelectorAll(
    ".ans-job-icon-clear[aria-label='任务点已完成'], .ans-job-icon-clear[aria-label*='已完成']"
  )).filter(isVisible);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasCompletedJobMarkerDeep(root = document, seen = new WeakSet(), depth = 0) {
  if (!root || depth > 4) return false;

  let doc = null;
  if (root instanceof Document) {
    doc = root;
  } else if (root instanceof HTMLIFrameElement || root instanceof HTMLFrameElement) {
    try {
      doc = root.contentWindow?.document || null;
    } catch {
      doc = null;
    }
  } else {
    doc = root.ownerDocument || null;
  }

  if (!doc || seen.has(doc)) return false;
  seen.add(doc);
  if (getCompletedJobMarkers(doc).length > 0) return true;

  for (const frame of doc.querySelectorAll("iframe, frame")) {
    try {
      if (hasCompletedJobMarkerDeep(frame, seen, depth + 1)) return true;
    } catch {
      // Cross-origin and sandboxed frames are ignored here.
    }
  }
  return false;
}

function hasCompletedJobMarkerInPage() {
  if (hasCompletedJobMarkerDeep(document)) return true;
  try {
    if (window.top?.document && window.top.document !== document) {
      return hasCompletedJobMarkerDeep(window.top.document);
    }
  } catch {
    // Cross-origin top documents are not accessible from this frame.
  }
  return false;
}

async function scheduleCompletedJobMarkerAutoNext(doc, markerCount) {
  if (completedJobMarkerAutoNextPending || jobCompleteAutoNextStarted) return;
  completedJobMarkerAutoNextPending = true;
  const frameUrl = doc.location?.href || "";
  const pageKey = getAutoNextPageKey();
  writeRuntimeLog("info", "auto_next_job_marker_detected", {
    frameUrl,
    markerCount,
    readyState: doc.readyState || "",
    pageAgeMs: Date.now() - contentScriptStartedAt,
    delayMs: COMPLETED_JOB_MARKER_DELAY_MS,
    diagnostic: getAutoNextDiagnostic(doc)
  });

  await wait(COMPLETED_JOB_MARKER_DELAY_MS);

  if (!settings.enabled || !settings.autoNextOnEnded || jobCompleteAutoNextStarted) {
    completedJobMarkerAutoNextPending = false;
    writeRuntimeLog("info", "auto_next_job_marker_cancelled", {
      reason: !settings.enabled ? "disabled" : !settings.autoNextOnEnded ? "auto_next_disabled" : "already_started",
      frameUrl,
      diagnostic: getAutoNextDiagnostic(doc)
    });
    return;
  }
  if (getAutoNextPageKey() !== pageKey) {
    completedJobMarkerAutoNextPending = false;
    writeRuntimeLog("info", "auto_next_job_marker_cancelled", {
      reason: "page_changed",
      frameUrl,
      diagnostic: getAutoNextDiagnostic(doc)
    });
    return;
  }
  if (getCompletedJobMarkers(doc).length === 0) {
    completedJobMarkerAutoNextPending = false;
    writeRuntimeLog("info", "auto_next_job_marker_cancelled", {
      reason: "marker_missing_after_delay",
      frameUrl,
      diagnostic: getAutoNextDiagnostic(doc)
    });
    return;
  }
  if (!claimAutoNext("completed-job-marker")) {
    completedJobMarkerAutoNextPending = false;
    writeRuntimeLog("info", "auto_next_job_marker_cancelled", {
      reason: "claim_rejected",
      frameUrl,
      diagnostic: getAutoNextDiagnostic(doc)
    });
    return;
  }

  jobCompleteAutoNextStarted = true;
  writeRuntimeLog("info", "auto_next_job_marker_completed", {
    frameUrl,
    markerCount: getCompletedJobMarkers(doc).length,
    delayed: true,
    delayMs: COMPLETED_JOB_MARKER_DELAY_MS,
    diagnostic: getAutoNextDiagnostic(doc)
  });
  sendExtensionNotice(
    "next_lesson",
    "任务点已完成，准备进入下一节",
    "检测到页面任务点已完成标记，将自动切换到下一节。",
    { dedupeKey: `job-marker:${location.href}`, cooldownSeconds: 10 }
  );
  clickNextLesson({ marker: "completed-job", noticeSent: true });
}

function scanCompletedJobMarkers(root = document, seen = new WeakSet(), depth = 0) {
  if (!settings.enabled || !settings.autoNextOnEnded || jobCompleteAutoNextStarted || completedJobMarkerAutoNextPending) return;
  if (!root || depth > 4) return;

  let doc = null;
  if (root instanceof Document) {
    doc = root;
  } else if (root instanceof HTMLIFrameElement || root instanceof HTMLFrameElement) {
    try {
      doc = root.contentWindow?.document || null;
    } catch {
      doc = null;
    }
  } else {
    doc = root.ownerDocument || null;
  }

  if (!doc || seen.has(doc)) return;
  seen.add(doc);

  const markers = getCompletedJobMarkers(doc);
  if (markers.length > 0) {
    scheduleCompletedJobMarkerAutoNext(doc, markers.length);
    return;
  }

  doc.querySelectorAll("iframe, frame").forEach((frame) => {
    try {
      scanCompletedJobMarkers(frame, seen, depth + 1);
    } catch {
      // Cross-origin and sandboxed frames are handled by their own content scripts when matched.
    }
  });
}

function hasQuizQuestionsInPage() {
  try {
    if (typeof extractQuestions === "function" && extractQuestions().length > 0) return true;
  } catch {
    // Quiz extraction can fail on partially loaded pages; fall back to selectors below.
  }
  return Boolean(document.querySelector(".singleQuesId, .TiMu, .Zy_TItle, li[role='radio'], li[role='checkbox']"));
}

async function getPageContentState() {
  const localState = {
    ok: true,
    hasVideo: Boolean(findPrimaryVideoDeep() || findPrimaryVideo()),
    hasQuiz: hasQuizQuestionsInPage(),
    hasCompletedJobMarker: hasCompletedJobMarkerInPage(),
    hasNextButton: Boolean(findNextButton()),
    frameCount: 1,
    source: "content"
  };

  try {
    const response = await askExtension({
      type: "page-content-state-request",
      pageUrl: location.href,
      ts: Date.now()
    });
    if (response?.ok) return response;
  } catch {
    // The local state is sufficient when the background worker is unavailable.
  }
  return localState;
}

async function scheduleNoVideoChapterAutoNext() {
  if (window.top !== window) return;
  if (!settings.enabled || !settings.autoNextOnEnded) return;
  if (noVideoAutoNextPending || noVideoAutoNextStarted || jobCompleteAutoNextStarted) return;
  if (hasRemoteSubmitPending()) return;

  noVideoAutoNextPending = true;
  const pageKey = getAutoNextPageKey();
  const startedAt = Date.now();
  writeRuntimeLog("info", "auto_next_no_video_check_scheduled", {
    delayMs: NO_VIDEO_AUTO_NEXT_DELAY_MS,
    diagnostic: getAutoNextDiagnostic(document)
  });

  await wait(NO_VIDEO_AUTO_NEXT_DELAY_MS);

  try {
    if (!settings.enabled || !settings.autoNextOnEnded || noVideoAutoNextStarted || jobCompleteAutoNextStarted) {
      writeRuntimeLog("info", "auto_next_no_video_check_cancelled", {
        reason: !settings.enabled ? "disabled" : !settings.autoNextOnEnded ? "auto_next_disabled" : "already_started",
        diagnostic: getAutoNextDiagnostic(document)
      });
      return;
    }
    if (getAutoNextPageKey() !== pageKey) {
      writeRuntimeLog("info", "auto_next_no_video_check_cancelled", {
        reason: "page_changed",
        diagnostic: getAutoNextDiagnostic(document)
      });
      return;
    }
    if (hasRemoteSubmitPending()) {
      writeRuntimeLog("info", "auto_next_no_video_check_cancelled", {
        reason: "remote_submit_pending",
        diagnostic: getAutoNextDiagnostic(document)
      });
      return;
    }

    const state = await getPageContentState();
    const hasVideo = Boolean(state.hasVideo);
    const hasCompletedJobMarker = Boolean(state.hasCompletedJobMarker);
    const hasNextButton = Boolean(state.hasNextButton);
    if (hasVideo || hasCompletedJobMarker || !hasNextButton) {
      writeRuntimeLog("info", "auto_next_no_video_check_cancelled", {
        reason: hasVideo ? "video_found" : hasCompletedJobMarker ? "completed_marker_found" : "next_button_missing",
        elapsedMs: Date.now() - startedAt,
        pageState: state,
        diagnostic: getAutoNextDiagnostic(document)
      });
      return;
    }
    if (!claimAutoNext("no-video-chapter")) {
      writeRuntimeLog("info", "auto_next_no_video_check_cancelled", {
        reason: "claim_rejected",
        pageState: state,
        diagnostic: getAutoNextDiagnostic(document)
      });
      return;
    }

    noVideoAutoNextStarted = true;
    writeRuntimeLog("info", "auto_next_no_video_chapter", {
      elapsedMs: Date.now() - startedAt,
      pageState: state,
      diagnostic: getAutoNextDiagnostic(document)
    });
    clickNextLesson({ marker: "no-video-chapter", noticeSent: false });
  } finally {
    noVideoAutoNextPending = false;
  }
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

function findPrimaryVideoDeep(root = document, seen = new WeakSet(), depth = 0) {
  if (!root || depth > 4) return null;
  let doc = null;
  if (root instanceof Document) {
    doc = root;
  } else if (root instanceof HTMLIFrameElement || root instanceof HTMLFrameElement) {
    try {
      doc = root.contentWindow?.document || null;
    } catch {
      doc = null;
    }
  } else {
    doc = root.ownerDocument || null;
  }

  if (!doc || seen.has(doc)) return null;
  seen.add(doc);
  for (const selector of VIDEO_SELECTORS) {
    const video = doc.querySelector(selector);
    if (video instanceof HTMLVideoElement) return video;
  }
  for (const frame of doc.querySelectorAll("iframe, frame")) {
    const video = findPrimaryVideoDeep(frame, seen, depth + 1);
    if (video) return video;
  }
  return null;
}

function formatPlaybackTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const rounded = Math.floor(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const rest = rounded % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  }
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function playbackStateLabel(video) {
  if (!(video instanceof HTMLVideoElement)) return "未检测到视频";
  if (video.ended) return "已结束";
  if (video.paused && Number(video.currentTime || 0) <= 0) return "未开始/加载中";
  if (video.paused) return "暂停中";
  return "正在播放";
}

function getPlaybackProgressSummary() {
  const video = findPrimaryVideoDeep() || findPrimaryVideo();
  if (!(video instanceof HTMLVideoElement)) {
    return "视频进度：当前页面未检测到视频。";
  }
  const currentTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
  const percent = duration > 0 ? `${Math.min(100, Math.max(0, Math.round((currentTime / duration) * 100)))}%` : "未知";
  return `视频进度：${formatPlaybackTime(currentTime)} / ${formatPlaybackTime(duration)}（${percent}），${playbackStateLabel(video)}`;
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

function restartVideo(video) {
  if (!(video instanceof HTMLVideoElement)) return false;
  try {
    if (typeof window.videojs === "function") {
      const player = window.videojs(video.id || "video_html5_api");
      player?.currentTime?.(0);
      const result = player?.play?.();
      result?.catch?.(() => clickVideoJsPlayButton());
      return Boolean(player);
    }
  } catch {
    // Fall back to the native video element.
  }

  try {
    video.currentTime = 0;
  } catch {
    // Some wrapped players restrict direct seeking.
  }

  try {
    const result = video.play?.();
    result?.catch?.(() => clickVideoJsPlayButton());
    return true;
  } catch {
    return clickVideoJsPlayButton();
  }
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
  for (const delay of [200, 500, 1000, 1800, 3000, 5000, 8000, 12000]) {
    setTimeout(() => clickNextConfirmIfShown(), delay);
  }
}

async function clickNextLesson(video) {
  const trigger = video instanceof HTMLVideoElement ? "video-ended" : video?.marker || "unknown";
  const diagnostic = getAutoNextDiagnostic(document, {
    trigger,
    triggerVideo: video instanceof HTMLVideoElement ? describeVideoForLog(video) : null
  });
  writeRuntimeLog("info", "auto_next_decision_started", diagnostic);
  if (!settings.enabled || !settings.autoNextOnEnded) {
    writeRuntimeLog("info", "auto_next_decision_skipped", {
      reason: !settings.enabled ? "disabled" : "auto_next_disabled",
      diagnostic
    });
    return;
  }
  if (video && typeof video === "object" && nextClicked.has(video)) {
    writeRuntimeLog("info", "auto_next_decision_skipped", {
      reason: "already_clicked_for_trigger",
      diagnostic
    });
    return;
  }
  if (hasRemoteSubmitPending()) {
    writeRuntimeLog("info", "auto_next_decision_skipped", {
      reason: "remote_submit_pending",
      diagnostic
    });
    return;
  }
  if (video && typeof video === "object") nextClicked.add(video);
  const noticeAlreadySent = Boolean(video?.noticeSent);
  markAutoPlayWindow();

  const button = findNextButton();
  if (button) {
    try {
      writeRuntimeLog("info", "auto_next_clicking", {
        trigger,
        selector: button.id ? `#${button.id}` : button.className || button.tagName,
        button: describeElementForLog(button),
        diagnostic: getAutoNextDiagnostic(document)
      });
      if (!noticeAlreadySent) {
        sendExtensionNotice(
          "next_lesson",
          "正在切换下一节",
          `即将点击页面中的下一节按钮。\n选择器：${button.id ? `#${button.id}` : button.className || button.tagName}`,
          { dedupeKey: `next:${location.href}`, cooldownSeconds: 10 }
        );
      }
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
    trigger,
    diagnostic,
    ts: Date.now()
  });
  if (response?.ok) {
    writeRuntimeLog("info", "auto_next_clicked_in_frames", {
      trigger,
      response,
      diagnostic: getAutoNextDiagnostic(document)
    });
    if (!noticeAlreadySent) {
      sendExtensionNotice(
        "next_lesson",
        "正在切换下一节",
        `已在页面所有 frame 中触发下一节按钮。${response.selector ? `\n选择器：${response.selector}` : ""}`,
        { dedupeKey: `next:${location.href}`, cooldownSeconds: 10 }
      );
    }
  } else {
    if (response?.lastLesson || hasPreviousLessonButton()) {
      notifyLastLesson(response || {});
      return;
    }
    writeRuntimeLog("error", "auto_next_failed", {
      trigger,
      response: response || { error: "No response" },
      diagnostic: getAutoNextDiagnostic(document)
    });
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
  if (isVideoCompleted(video)) {
    onEnded(video);
    return;
  }
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

async function waitForCompletedJobMarker(ms = 1800) {
  if (hasCompletedJobMarkerInPage()) {
    writeRuntimeLog("info", "auto_next_completed_marker_check", getAutoNextDiagnostic(document, {
      result: true,
      phase: "immediate"
    }));
    return true;
  }
  writeRuntimeLog("info", "auto_next_completed_marker_check", getAutoNextDiagnostic(document, {
    result: false,
    phase: "before_wait",
    waitMs: ms
  }));
  await wait(ms);
  scanCompletedJobMarkers();
  const result = hasCompletedJobMarkerInPage();
  writeRuntimeLog("info", "auto_next_completed_marker_check", getAutoNextDiagnostic(document, {
    result,
    phase: "after_wait",
    waitMs: ms
  }));
  return result;
}

async function handleEndedNavigation(video) {
  if (endedHandling.has(video)) return;
  endedHandling.add(video);
  try {
    if (await waitForCompletedJobMarker()) {
      endedHandled.add(video);
      if (jobCompleteAutoNextStarted) return;
      clickNextLesson(video);
      return;
    }

    if (!replayedUnmarkedVideos.has(video)) {
      replayedUnmarkedVideos.add(video);
      writeRuntimeLog("info", "auto_next_replay_unmarked_video", {
        currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
        duration: Number.isFinite(video.duration) ? video.duration : 0
      });
      sendExtensionNotice(
        "next_lesson",
        "任务点未完成，重新播放一次",
        "视频已结束但页面尚未显示任务点已完成标记，将自动重播一次。",
        { dedupeKey: `replay-unmarked:${location.href}`, cooldownSeconds: 30 }
      );
      restartVideo(video);
      return;
    }

    endedHandled.add(video);
    writeRuntimeLog("error", "auto_next_unmarked_after_replay", {
      currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
      duration: Number.isFinite(video.duration) ? video.duration : 0
    });
    sendExtensionNotice(
      "runtime_error",
      "任务点仍未完成",
      "视频已重播一次，但页面仍未显示任务点已完成标记，已停止自动进入下一节。",
      { dedupeKey: `unmarked-after-replay:${location.href}`, cooldownSeconds: 60 }
    );
  } finally {
    endedHandling.delete(video);
  }
}

function onEnded(video) {
  clearPauseTimer(video);
  if (endedHandled.has(video) || endedHandling.has(video)) return;
  writeRuntimeLog("info", "auto_next_video_ended_seen", getAutoNextDiagnostic(document, {
    trigger: "video-ended",
    triggerVideo: describeVideoForLog(video)
  }));
  if (!playedVideos.has(video)) {
    writeRuntimeLog("info", "auto_next_skipped_unplayed_video", getAutoNextDiagnostic(document, {
      trigger: "video-ended",
      triggerVideo: describeVideoForLog(video)
    }));
    endedHandled.add(video);
    return;
  }
  if (settings.notifyOnEnded) {
    sendPlaybackEvent(video, "ended");
  }
  handleEndedNavigation(video);
}

function isVideoCompleted(video) {
  if (!(video instanceof HTMLVideoElement)) return false;
  return video.ended;
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
  writeRuntimeLog("info", "video_observed", {
    video: describeVideoForLog(video),
    pageAgeMs: Date.now() - contentScriptStartedAt
  });

  video.addEventListener("play", () => {
    playedVideos.add(video);
    playedSinceNavigation = true;
    writeRuntimeLog("info", "video_play_seen", {
      video: describeVideoForLog(video)
    });
    clearPauseTimer(video);
  }, true);
  video.addEventListener("playing", () => {
    playedVideos.add(video);
    playedSinceNavigation = true;
    writeRuntimeLog("info", "video_playing_seen", {
      video: describeVideoForLog(video)
    });
    clearPauseTimer(video);
    lastProgress.set(video, Date.now());
  }, true);
  video.addEventListener("timeupdate", () => {
    if (!video.ended && Number(video.currentTime) > 1) {
      playedVideos.add(video);
      playedSinceNavigation = true;
    }
    lastProgress.set(video, Date.now());
    checkAlreadyCompletedVideo(video);
  }, true);
  video.addEventListener("pause", () => onPause(video), true);
  video.addEventListener("ended", () => onEnded(video), true);
  video.addEventListener("loadedmetadata", () => checkAlreadyCompletedVideo(video), true);
  video.addEventListener("durationchange", () => checkAlreadyCompletedVideo(video), true);
  video.addEventListener("loadeddata", () => tryPlayVideo(video), true);
  video.addEventListener("canplay", () => tryPlayVideo(video), true);
  video.addEventListener("stalled", () => onStalled(video, "stalled"), true);
  video.addEventListener("waiting", () => onStalled(video, "waiting"), true);
  if (!video.paused && !video.ended) {
    playedVideos.add(video);
    playedSinceNavigation = true;
  }
  tryPlayVideo(video);
  setTimeout(() => checkAlreadyCompletedVideo(video), 300);
  setTimeout(() => checkAlreadyCompletedVideo(video), 2000);
  const completionInterval = setInterval(() => {
    if (!document.contains(video)) {
      clearInterval(completionInterval);
      return;
    }
    checkAlreadyCompletedVideo(video);
  }, 3000);
}

function scanVideos(root = document) {
  if (root instanceof HTMLVideoElement) {
    watchVideo(root);
    return;
  }
  root.querySelectorAll?.("video").forEach(watchVideo);
}

function scanVideosDeep(root = document, seen = new WeakSet(), depth = 0) {
  if (!root || depth > 4) return;
  let doc = null;
  if (root instanceof Document) {
    doc = root;
  } else if (root instanceof HTMLIFrameElement || root instanceof HTMLFrameElement) {
    try {
      doc = root.contentWindow?.document || null;
    } catch {
      doc = null;
    }
  } else {
    scanVideos(root);
    doc = root.ownerDocument || null;
  }

  if (!doc || seen.has(doc)) return;
  seen.add(doc);
  scanVideos(doc);

  doc.querySelectorAll("iframe, frame").forEach((frame) => {
    try {
      scanVideosDeep(frame, seen, depth + 1);
    } catch {
      // Cross-origin and sandboxed frames are handled by their own content scripts when matched.
    }
  });
}

