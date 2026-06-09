(function () {
  const VIDEO_MARK = "data-audio-check-video-monitor";
  const DEFAULTS = {
    enabled: true,
    autoNextOnEnded: true,
    autoPlayNextVideo: true,
    notifyOnPause: true,
    notifyOnEnded: true,
    notifyOnStalled: true,
    pauseDebounceSeconds: 3
  };

  let settings = { ...DEFAULTS };
  let videoSeq = 0;
  const timers = new WeakMap();
  const lastProgress = new WeakMap();
  const observed = new WeakSet();
  const nextClicked = new WeakSet();
  const endedHandled = new WeakSet();
  const AUTOPLAY_KEY = "audioCheckAutoPlayNextUntil";
  const NEXT_SELECTORS = [
    "#prevNextFocusNext",
    ".prev_next.next",
    ".jb_btn.prev_next.next",
    "[role='button'][onclick*='PCount.next']",
    "[onclick*='PCount.next']"
  ];
  const NEXT_CONFIRM_SELECTORS = [
    ".popDiv .nextChapter",
    ".popBottom .nextChapter",
    "a.nextChapter[onclick*='PCount.next']"
  ];
  const VIDEO_SELECTORS = [
    "#video_html5_api",
    "video.vjs-tech",
    "video"
  ];
  const QUIZ_PANEL_ID = "audio-check-quiz-panel";
  const REMOTE_QUIZ_KEY_PREFIX = "audioCheckRemoteQuiz:";
  const REMOTE_SUBMIT_PENDING_KEY_PREFIX = "audioCheckRemoteSubmit:";
  const WRONG_QUESTIONS_KEY = "audioCheckWrongQuestions";
  let remoteQuizStarted = false;
  let remoteQuizPollTimer = 0;
  let wrongQuestionScanTimer = 0;
  let wrongQuestionScanRunning = false;
  let cxSecretMap = null;
  let cxSecretLoading = null;
  let cxSecretAttempted = false;

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

  function clickNextLesson(video) {
    if (!settings.enabled || !settings.autoNextOnEnded || nextClicked.has(video)) return;
    if (hasRemoteSubmitPending()) return;
    nextClicked.add(video);
    markAutoPlayWindow();

    const button = findNextButton();
    if (button) {
      button.click();
      scheduleNextConfirmAttempts();
      scheduleAutoPlayAttempts();
      return;
    }

    chrome.runtime.sendMessage({
      type: "auto-next-request",
      pageUrl: location.href,
      ts: Date.now()
    });
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

  function cleanText(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function decodeCxSecretText(text) {
    if (!cxSecretMap) return String(text || "");
    return String(text || "").replace(/[\s\S]/gu, (char) => cxSecretMap[char] || char);
  }

  function cleanDecodedText(text) {
    return cleanText(decodeCxSecretText(text));
  }

  function hasCxSecretText() {
    return Boolean(document.querySelector(".font-cxsecret"));
  }

  function extractCxSecretFontBase64() {
    for (const sheet of Array.from(document.styleSheets)) {
      let rules = [];
      try {
        rules = Array.from(sheet.cssRules || []);
      } catch {
        continue;
      }
      for (const rule of rules) {
        const cssText = rule.cssText || "";
        if (!/font-cxsecret/i.test(cssText)) continue;
        const match = cssText.match(/base64,([^"')\s]+)/i);
        if (match) return match[1];
      }
    }
    const styleText = Array.from(document.querySelectorAll("style"))
      .map((style) => style.textContent || "")
      .find((text) => /font-cxsecret/i.test(text) && /base64,/i.test(text));
    return styleText?.match(/base64,([^"')\s]+)/i)?.[1] || "";
  }

  function ensureCxSecretDecoder() {
    if (cxSecretMap || cxSecretLoading || cxSecretAttempted || !hasCxSecretText()) return cxSecretLoading || Promise.resolve();
    const fontBase64 = extractCxSecretFontBase64();
    cxSecretAttempted = true;
    if (!fontBase64) return Promise.resolve();
    cxSecretLoading = askNative({
      type: "decodeCxSecretFont",
      fontBase64
    }).then((response) => {
      if (response?.ok && response.map && typeof response.map === "object") {
        cxSecretMap = response.map;
      }
    }).finally(() => {
      cxSecretLoading = null;
    });
    return cxSecretLoading;
  }

  function typeLabel(type) {
    return {
      "0": "单选题",
      "1": "多选题",
      "3": "判断题"
    }[String(type)] || "题目";
  }

  function extractQuestion(block) {
    const timu = block.querySelector(".TiMu");
    const qid = block.getAttribute("data") || block.querySelector("[qid]")?.getAttribute("qid") || "";
    const type = timu?.getAttribute("data") || block.querySelector("[qtype]")?.getAttribute("qtype") || "";
    const title = block.querySelector(".fontLabel")?.innerText || block.querySelector(".Zy_TItle")?.innerText || "";
    const stem = cleanDecodedText(title.replace(/^\d+\s*/, ""));
    const options = Array.from(block.querySelectorAll("li[role='radio'], li[role='checkbox']")).map((li) => {
      const marker = li.querySelector(".num_option, .num_option_dx");
      const text = li.querySelector("a.after")?.innerText || li.innerText || li.getAttribute("aria-label") || "";
      return {
        label: cleanDecodedText(marker?.innerText || ""),
        value: marker?.getAttribute("data") || "",
        text: cleanDecodedText(text.replace(/选择$/, "")),
        ariaLabel: cleanDecodedText(li.getAttribute("aria-label") || "")
      };
    });
    return {
      qid,
      type,
      typeLabel: typeLabel(type),
      stem,
      options,
      block
    };
  }

  function extractQuestions() {
    return Array.from(document.querySelectorAll(".singleQuesId"))
      .map(extractQuestion)
      .filter((question) => question.stem || question.options.length);
  }

  function askNative(payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "native", payload }, (response) => {
        resolve(response || { ok: false, error: chrome.runtime.lastError?.message || "No response" });
      });
    });
  }

  function askExtension(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        resolve(response || { ok: false, error: chrome.runtime.lastError?.message || "No response" });
      });
    });
  }

  function localStorageGet(defaults) {
    return new Promise((resolve) => chrome.storage.local.get(defaults, resolve));
  }

  function localStorageSet(values) {
    return new Promise((resolve) => chrome.storage.local.set(values, resolve));
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function resizeImageDataUrl(dataUrl, maxWidth = 1280, maxHeight = 1280, quality = 0.74) {
    return new Promise((resolve) => {
      const image = new Image();
      image.onload = () => {
        const scale = Math.min(1, maxWidth / image.naturalWidth, maxHeight / image.naturalHeight);
        const width = Math.max(1, Math.round(image.naturalWidth * scale));
        const height = Math.max(1, Math.round(image.naturalHeight * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(image, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      image.onerror = () => resolve(dataUrl);
      image.src = dataUrl;
    });
  }

  function questionPayload(question) {
    return {
      qid: question.qid,
      type: question.type,
      typeLabel: question.typeLabel,
      stem: question.stem,
      options: question.options
    };
  }

  function formatQuestionForWeixin(question, index) {
    const lines = [
      `${index + 1}. ${question.typeLabel} ${question.stem}`
    ];
    for (const option of question.options) {
      lines.push(`  ${option.label || option.value || "-"}. ${option.text}`);
    }
    return lines.join("\n");
  }

  function formatQuizForWeixin(questions) {
    return [
      `检测到章节习题，共 ${questions.length} 题。`,
      "请直接回复你的选项，格式示例：",
      "答 1:A 2:BD 3:错",
      "填完后如需提交，请单独回复：提交",
      "远程配置API：配置API minimax <key>",
      "查看配置：查看API",
      "查看解析：解析 1（或 解析全部）",
      "重发题图：题图 1（或 题图全部）",
      "页面使用防复制字体时，请以随后发送的题目截图为准。",
      "",
      ...questions.map(formatQuestionForWeixin)
    ].join("\n\n").slice(0, 6000);
  }

  function parseRemoteAnswers(text) {
    const raw = cleanText(text).replace(/^答[:：]?\s*/i, "");
    const answers = [];
    const pattern = /(?:^|\s|,|，|;|；)(\d{1,2})\s*[:：\.、]?\s*([A-Ha-h]+|对|错|true|false)(?=\s|,|，|;|；|$)/g;
    let match;
    while ((match = pattern.exec(raw))) {
      answers.push({
        index: Number(match[1]) - 1,
        answer: match[2].toUpperCase()
      });
    }
    return answers;
  }

  function isSubmitCommand(text) {
    return /^(提交|确认提交|submit)$/i.test(cleanText(text));
  }

  function parseExplainCommand(text) {
    const raw = cleanText(text);
    if (/^(解析全部|讲解全部|解释全部)$/i.test(raw)) {
      return { all: true };
    }
    const match = raw.match(/^(解析|讲解|解释)\s*([0-9]{1,2})(?:\s+([0-9]{1,2}))*$/i);
    if (!match) return null;
    const numbers = Array.from(raw.matchAll(/[0-9]{1,2}/g))
      .map((item) => Number(item[0]))
      .filter((num) => Number.isInteger(num) && num > 0);
    return numbers.length ? { indexes: numbers.map((num) => num - 1) } : null;
  }

  function parseScreenshotCommand(text) {
    const raw = cleanText(text);
    if (/^(题图全部|截图全部|图片全部|拍照全部)$/i.test(raw)) {
      return { all: true };
    }
    const match = raw.match(/^(题图|截图|图片|拍照)\s*([0-9]{1,2})(?:\s+([0-9]{1,2}))*$/i);
    if (!match) return null;
    const numbers = Array.from(raw.matchAll(/[0-9]{1,2}/g))
      .map((item) => Number(item[0]))
      .filter((num) => Number.isInteger(num) && num > 0);
    return numbers.length ? { indexes: numbers.map((num) => num - 1) } : null;
  }

  function parseApiConfigCommand(text) {
    const raw = String(text || "").trim();
    if (/^(查看API|查看api|api状态|API状态)$/i.test(raw)) {
      return { action: "status" };
    }
    const miniMax = raw.match(/^配置\s*(?:API|api)\s+(?:minimax|MiniMax|MINIMAX)\s+(\S+)$/);
    if (miniMax) {
      return {
        action: "save",
        settings: {
          preset: "minimax",
          endpoint: "https://api.minimaxi.com/v1/chat/completions",
          model: "MiniMax-M3",
          apiKey: miniMax[1]
        }
      };
    }
    const custom = raw.match(/^配置\s*(?:API|api)\s+(?:自定义|custom)\s+(\S+)\s+(\S+)\s+(\S+)$/i);
    if (custom) {
      return {
        action: "save",
        settings: {
          preset: "custom",
          endpoint: custom[1],
          model: custom[2],
          apiKey: custom[3]
        }
      };
    }
    return null;
  }

  function parseWrongBookCommand(text) {
    const raw = cleanText(text);
    if (/^(清空错题|错题清空)$/i.test(raw)) {
      return { action: "clear" };
    }
    const match = raw.match(/^错题(?:列表|记录)?(?:\s+(\d{1,2}))?$/i);
    if (match) {
      return { action: "list", limit: Math.min(30, Math.max(1, Number(match[1]) || 5)) };
    }
    return null;
  }

  function formatApiStatus(response) {
    if (!response?.ok) return `API配置失败：${response?.error || "未知错误"}`;
    const lines = [
      "API配置状态：",
      `预置：${response.preset || "custom"}`,
      `接口：${response.endpoint || "未配置"}`,
      `模型：${response.model || "未配置"}`,
      `Key：${response.hasApiKey ? "已保存" : "未保存"}`
    ];
    if (response.modelRefresh?.ok) {
      lines.push(`模型列表：已刷新，选择 ${response.modelRefresh.selectedModel}`);
    }
    if (response.warning) {
      lines.push(`提醒：模型列表刷新失败，暂用当前模型。${response.warning}`);
    }
    return lines.join("\n");
  }

  async function sendWeixinText(settings, text) {
    const chunks = [];
    const raw = String(text || "");
    for (let i = 0; i < raw.length; i += 1800) {
      chunks.push(raw.slice(i, i + 1800));
    }
    for (const chunk of chunks.length ? chunks : [""]) {
      await askNative({
        type: "sendText",
        targetId: settings.targetId,
        accountId: settings.accountId || undefined,
        contextToken: settings.lastContextToken || undefined,
        text: chunk
      });
    }
  }

  async function sendWeixinImage(settings, dataUrl, caption) {
    if (!dataUrl) return { ok: false, error: "没有可发送的截图。" };
    return askNative({
      type: "sendImageDataUrl",
      targetId: settings.targetId,
      accountId: settings.accountId || undefined,
      contextToken: settings.lastContextToken || undefined,
      dataUrl,
      caption
    });
  }

  async function captureQuestionImage(question) {
    const block = findQuestionBlock(question);
    if (block?.scrollIntoView) {
      block.scrollIntoView({ behavior: "instant", block: "center", inline: "nearest" });
    }
    const panel = document.getElementById(QUIZ_PANEL_ID);
    const previousDisplay = panel?.style.display;
    if (panel) panel.style.display = "none";
    await wait(450);
    const response = await askExtension({
      type: "capture-visible-tab",
      format: "jpeg",
      quality: 82,
      delayMs: 120
    });
    if (panel) panel.style.display = previousDisplay || "";
    return response?.ok ? await resizeImageDataUrl(response.dataUrl || "") : "";
  }

  async function handleScreenshotCommand(command, settings) {
    const questions = extractQuestions();
    const indexes = command.all
      ? questions.map((_, index) => index)
      : Array.from(new Set(command.indexes || []));
    if (!indexes.length) {
      await sendWeixinText(settings, "未识别要发送截图的题号。格式示例：题图 1");
      return true;
    }
    for (const index of indexes) {
      const question = questions[index];
      if (!question) {
        await sendWeixinText(settings, `第 ${index + 1} 题不存在。`);
        continue;
      }
      const imageDataUrl = await captureQuestionImage(question);
      const sent = await sendWeixinImage(settings, imageDataUrl, `第 ${index + 1} 题截图`);
      if (!sent?.ok) {
        await sendWeixinText(settings, `第 ${index + 1} 题截图发送失败：${sent?.error || "未知错误"}`);
      }
    }
    return true;
  }

  async function handleExplainCommand(command, settings) {
    const questions = extractQuestions();
    const indexes = command.all
      ? questions.map((_, index) => index)
      : Array.from(new Set(command.indexes || []));
    if (!indexes.length) {
      await sendWeixinText(settings, "未识别要解析的题号。格式示例：解析 1");
      return true;
    }
    for (const index of indexes) {
      const question = questions[index];
      if (!question) {
        await sendWeixinText(settings, `第 ${index + 1} 题不存在。`);
        continue;
      }
      await sendWeixinText(settings, `正在解析第 ${index + 1} 题...`);
      const imageDataUrl = await captureQuestionImage(question);
      const response = await askNative({
        type: "explainQuestion",
        question: questionPayload(question),
        imageDataUrl,
        timeoutMs: 60_000
      });
      const content = response?.ok
        ? response.content || "没有返回解析内容。"
        : `解析失败：${response?.error || "未知错误"}`;
      await sendWeixinText(settings, `第 ${index + 1} 题解析：\n${content}`);
    }
    return true;
  }

  function findQuestionBlock(question) {
    if (question.block?.isConnected) return question.block;
    return Array.from(document.querySelectorAll(".singleQuesId"))
      .find((block) => (block.getAttribute("data") || "") === question.qid) || null;
  }

  function optionLabelsForAnswer(answer) {
    if (answer === "对") return ["对"];
    if (answer === "错") return ["错"];
    if (answer === "TRUE") return ["A"];
    if (answer === "FALSE") return ["B"];
    return answer.split("").filter(Boolean);
  }

  function validateRemoteAnswer(question, answer) {
    const raw = cleanText(answer).toUpperCase();
    const labels = optionLabelsForAnswer(raw);
    const type = String(question.type);
    if (type === "0" && labels.length !== 1) {
      return { ok: false, reason: "单选题只能提交一个选项" };
    }
    if (type === "3") {
      const validJudge = ["对", "错", "TRUE", "FALSE", "A", "B"].includes(raw);
      if (!validJudge || labels.length !== 1) {
        return { ok: false, reason: "判断题只能提交 对/错 或 A/B" };
      }
    }
    if (type === "1" && labels.length < 2) {
      return { ok: false, reason: "多选题至少提交两个选项" };
    }
    const normalized = labels.map((label) => cleanText(label).toUpperCase());
    const hasDuplicate = new Set(normalized).size !== normalized.length;
    if (hasDuplicate) {
      return { ok: false, reason: "选项不能重复" };
    }
    const available = new Set(question.options.flatMap((option) => [
      cleanText(option.label).toUpperCase(),
      cleanText(option.value).toUpperCase(),
      cleanDecodedText(option.text).toUpperCase()
    ].filter(Boolean)));
    const missing = normalized.filter((label) => !available.has(label));
    if (missing.length) {
      return { ok: false, reason: `不存在选项 ${missing.join("")}` };
    }
    return { ok: true, labels };
  }

  function hiddenAnswerValue(question) {
    const block = findQuestionBlock(question);
    const input = block?.querySelector(`input[name='answer${question.qid}'], input#answer${question.qid}`);
    return input?.value || "";
  }

  function clickAnswerOption(question, label) {
    const block = findQuestionBlock(question);
    if (!block) return false;
    const options = Array.from(block.querySelectorAll("li[role='radio'], li[role='checkbox']"));
    const wanted = cleanText(label).toUpperCase();
    const li = options.find((item) => {
      const marker = item.querySelector(".num_option, .num_option_dx");
      const markerLabel = cleanDecodedText(marker?.innerText || "").toUpperCase();
      const value = cleanText(marker?.getAttribute("data") || "").toUpperCase();
      const text = cleanDecodedText(item.querySelector("a.after")?.innerText || "").toUpperCase();
      return markerLabel === wanted || value === wanted || text === wanted;
    });
    if (!li) return false;

    const marker = li.querySelector(".num_option, .num_option_dx");
    const value = marker?.getAttribute("data") || "";
    const current = hiddenAnswerValue(question);
    if (String(question.type) === "1" && value && current.includes(value)) return true;
    if (String(question.type) !== "1" && value && current === value) return true;
    li.click();
    return true;
  }

  function applyRemoteAnswers(answers) {
    const questions = extractQuestions();
    const applied = [];
    const failed = [];
    for (const item of answers) {
      const question = questions[item.index];
      if (!question) {
        failed.push(`${item.index + 1}:${item.answer}`);
        continue;
      }
      const validation = validateRemoteAnswer(question, item.answer);
      if (!validation.ok) {
        failed.push(`${item.index + 1}:${item.answer}（${validation.reason}）`);
        continue;
      }
      const labels = validation.labels;
      const ok = labels.every((label) => clickAnswerOption(question, label));
      (ok ? applied : failed).push(`${item.index + 1}:${item.answer}`);
    }
    return { applied, failed };
  }

  function simpleHash(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function selectedOptionDetails(question) {
    const raw = hiddenAnswerValue(question);
    if (!raw) return [];
    const values = new Set(String(raw).split("").filter(Boolean));
    return question.options.filter((option) => values.has(String(option.value || option.label || ""))).map((option) => ({
      label: option.label || option.value || "",
      value: option.value || "",
      text: option.text || ""
    }));
  }

  function textFromSelectors(block, selectors) {
    if (!block) return "";
    const text = selectors
      .flatMap((selector) => Array.from(block.querySelectorAll(selector)))
      .map((item) => cleanDecodedText(item.innerText || item.textContent || ""))
      .filter(Boolean)
      .join("\n");
    return text;
  }

  function extractCorrectAnswerText(block) {
    const direct = textFromSelectors(block, [
      ".correctAnswer",
      ".answerShow",
      ".newAnswerBx",
      ".Py_answer",
      ".Zy_ulBottom",
      ".B-answer-ct"
    ]);
    const combined = direct || cleanDecodedText(block.innerText || "");
    const lines = combined.split(/\n|。|；/).map(cleanDecodedText).filter(Boolean);
    const answerLines = lines.filter((line) => /正确答案|参考答案|标准答案|答案/.test(line) && !/我的答案|你的答案/.test(line));
    return (answerLines[0] || textFromSelectors(block, [".correctAnswer"]) || "").slice(0, 600);
  }

  function extractMyAnswerText(block, question) {
    const direct = textFromSelectors(block, [".myAnswer", ".answerCon", ".B-answerCon"]);
    const line = direct.split(/\n/).map(cleanDecodedText).find((item) => /我的答案|你的答案|学生答案/.test(item));
    if (line) return line.slice(0, 600);
    const selected = selectedOptionDetails(question);
    if (!selected.length) return "";
    return selected.map((item) => `${item.label || item.value}. ${item.text}`.trim()).join("；");
  }

  function questionResultStatus(question) {
    const block = findQuestionBlock(question);
    if (!block) return { known: false, wrong: false, partial: false };
    const hasWrong = Boolean(block.querySelector(".marking_cuo, .result_wrong, b.wr, .Zy_ulBottom b.wr, i.cuo, span.cuo"));
    const hasPartial = Boolean(block.querySelector(".marking_bandui, .bandui"));
    const hasRight = Boolean(block.querySelector(".marking_dui, .result_right, b.ri, .Zy_ulBottom b.ri, i.dui, span.dui"));
    const resultText = cleanDecodedText(block.innerText || "");
    const textWrong = /回答错误|作答错误|答案错误|错误/.test(resultText) && /正确答案|参考答案|标准答案/.test(resultText);
    const textRight = /回答正确|作答正确|答案正确|正确/.test(resultText) && !textWrong;
    const known = hasWrong || hasPartial || hasRight || textWrong || textRight;
    return {
      known,
      wrong: hasWrong || hasPartial || textWrong,
      partial: hasPartial
    };
  }

  function extractWrongQuestionsFromResult() {
    const questions = extractQuestions();
    let knownCount = 0;
    const wrong = [];
    for (const [index, question] of questions.entries()) {
      const status = questionResultStatus(question);
      if (!status.known) continue;
      knownCount += 1;
      if (!status.wrong) continue;
      const recordId = [
        location.origin,
        location.pathname,
        question.qid || simpleHash(question.stem),
        simpleHash(question.stem)
      ].join(":");
      wrong.push({
        id: recordId,
        qid: question.qid,
        index: index + 1,
        type: question.type,
        typeLabel: question.typeLabel,
        stem: question.stem,
        options: question.options.map(({ label, value, text }) => ({ label, value, text })),
        myAnswer: extractMyAnswerText(findQuestionBlock(question), question),
        correctAnswer: extractCorrectAnswerText(findQuestionBlock(question)),
        partial: status.partial,
        pageTitle: titleForPage(),
        pageUrl: location.href,
        recordedAt: new Date().toISOString()
      });
    }
    return {
      isResult: knownCount > 0,
      questionCount: questions.length,
      knownCount,
      wrong
    };
  }

  async function saveWrongQuestions(records) {
    if (!records.length) return { saved: 0, total: 0 };
    const stored = await localStorageGet({ [WRONG_QUESTIONS_KEY]: [] });
    const existing = Array.isArray(stored[WRONG_QUESTIONS_KEY]) ? stored[WRONG_QUESTIONS_KEY] : [];
    const byId = new Map(existing.map((item) => [item.id, item]));
    for (const record of records) {
      byId.set(record.id, { ...byId.get(record.id), ...record });
    }
    const next = Array.from(byId.values())
      .sort((a, b) => String(b.recordedAt || "").localeCompare(String(a.recordedAt || "")))
      .slice(0, 500);
    await localStorageSet({ [WRONG_QUESTIONS_KEY]: next });
    return { saved: records.length, total: next.length };
  }

  function formatWrongQuestionsForWeixin(result, saved) {
    if (!result.wrong.length) {
      return `提交完成，未检测到错题。已识别结果：${result.knownCount}/${result.questionCount} 题。`;
    }
    const lines = [
      `提交完成，记录错题 ${result.wrong.length} 题（错题库共 ${saved.total} 题）。`
    ];
    for (const item of result.wrong.slice(0, 8)) {
      lines.push("");
      lines.push(`${item.index}. ${item.typeLabel} ${item.stem}`);
      if (item.myAnswer) lines.push(`我的答案：${item.myAnswer}`);
      if (item.correctAnswer) lines.push(item.correctAnswer.startsWith("正确答案") ? item.correctAnswer : `正确答案：${item.correctAnswer}`);
    }
    if (result.wrong.length > 8) lines.push(`\n还有 ${result.wrong.length - 8} 题已记录到本地错题库。`);
    return lines.join("\n");
  }

  function formatWrongBookForWeixin(records, limit) {
    if (!records.length) return "本地错题库为空。";
    const lines = [`本地错题库共 ${records.length} 题，最近 ${Math.min(limit, records.length)} 题：`];
    for (const [index, item] of records.slice(0, limit).entries()) {
      lines.push("");
      lines.push(`${index + 1}. ${item.typeLabel || "题目"} ${item.stem || ""}`);
      if (item.myAnswer) lines.push(`我的答案：${item.myAnswer}`);
      if (item.correctAnswer) lines.push(item.correctAnswer.startsWith("正确答案") ? item.correctAnswer : `正确答案：${item.correctAnswer}`);
      if (item.recordedAt) lines.push(`记录时间：${item.recordedAt.replace("T", " ").slice(0, 16)}`);
    }
    return lines.join("\n");
  }

  async function handleWrongBookCommand(command, settings) {
    if (command.action === "clear") {
      await localStorageSet({ [WRONG_QUESTIONS_KEY]: [] });
      await sendWeixinText(settings, "已清空本地错题库。");
      return true;
    }
    const stored = await localStorageGet({ [WRONG_QUESTIONS_KEY]: [] });
    const records = Array.isArray(stored[WRONG_QUESTIONS_KEY]) ? stored[WRONG_QUESTIONS_KEY] : [];
    await sendWeixinText(settings, formatWrongBookForWeixin(records, command.limit || 5));
    return true;
  }

  function remoteSubmitPendingKey() {
    return `${REMOTE_SUBMIT_PENDING_KEY_PREFIX}${location.origin}${location.pathname}`;
  }

  function remoteSubmitPendingGlobalKey() {
    return `${REMOTE_SUBMIT_PENDING_KEY_PREFIX}${location.origin}:latest`;
  }

  function markRemoteSubmitPending() {
    try {
      const until = String(Date.now() + 3 * 60_000);
      sessionStorage.setItem(remoteSubmitPendingKey(), until);
      sessionStorage.setItem(remoteSubmitPendingGlobalKey(), until);
    } catch {
      // Ignore storage restrictions.
    }
  }

  function consumeRemoteSubmitPending() {
    try {
      const keys = [remoteSubmitPendingKey(), remoteSubmitPendingGlobalKey()];
      const hit = keys.find((key) => Date.now() <= Number(sessionStorage.getItem(key) || "0"));
      const until = Number(hit ? sessionStorage.getItem(hit) : "0");
      if (Date.now() <= until) {
        keys.forEach((key) => sessionStorage.removeItem(key));
        return true;
      }
      keys.forEach((key) => {
        if (sessionStorage.getItem(key)) sessionStorage.removeItem(key);
      });
    } catch {
      // Ignore storage restrictions.
    }
    return false;
  }

  function hasRemoteSubmitPending() {
    try {
      const keys = [remoteSubmitPendingKey(), remoteSubmitPendingGlobalKey()];
      return keys.some((key) => Date.now() <= Number(sessionStorage.getItem(key) || "0"));
    } catch {
      return false;
    }
  }

  function wrongResultRecordedKey() {
    return `${remoteSessionKey()}:wrongRecorded`;
  }

  async function scanAndRecordWrongQuestions() {
    if (wrongQuestionScanRunning) return;
    wrongQuestionScanRunning = true;
    try {
      if (hasCxSecretText() && !cxSecretMap && !cxSecretAttempted) {
        await ensureCxSecretDecoder();
      }
      const result = extractWrongQuestionsFromResult();
      if (!result.isResult) return;
      const resultKey = wrongResultRecordedKey();
      if (sessionStorage.getItem(resultKey)) return;
      const remoteSubmit = consumeRemoteSubmitPending();
      const saved = await saveWrongQuestions(result.wrong);
      sessionStorage.setItem(resultKey, String(Date.now()));
      if (remoteSubmit) {
        const settings = await remoteQuizSettings();
        if (settings.targetId) {
          await sendWeixinText(settings, formatWrongQuestionsForWeixin(result, saved));
        }
      }
    } finally {
      wrongQuestionScanRunning = false;
    }
  }

  function scheduleWrongQuestionScan() {
    clearTimeout(wrongQuestionScanTimer);
    wrongQuestionScanTimer = window.setTimeout(scanAndRecordWrongQuestions, 1200);
  }

  function watchManualSubmitClicks() {
    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest(".btnSubmit, a[onclick*='btnBlueSubmit'], #confirmSubWin .bluebtn, a[onclick*='submitCheckTimes']");
      if (button) scheduleWrongQuestionScan();
    }, true);
  }

  function clickSubmitIfRequested(source = "manual") {
    const unanswered = extractQuestions()
      .map((question, index) => ({ question, index }))
      .filter(({ question }) => !hiddenAnswerValue(question))
      .map(({ index }) => index + 1);
    if (unanswered.length) {
      return { ok: false, reason: `仍有未作答题目：${unanswered.join(", ")}` };
    }
    const submit = document.querySelector(".btnSubmit, .btnSubmit span, a[onclick*='btnBlueSubmit']");
    const button = submit?.closest?.("a") || submit;
    if (isVisible(button)) {
      if (source === "remote") markRemoteSubmitPending();
      button.click();
      setTimeout(() => {
        const confirm = document.querySelector("#confirmSubWin .bluebtn, a[onclick*='submitCheckTimes']");
        if (isVisible(confirm)) {
          if (source === "remote") markRemoteSubmitPending();
          confirm.click();
          scheduleWrongQuestionScan();
        }
      }, 800);
      scheduleWrongQuestionScan();
      return { ok: true };
    }
    return { ok: false, reason: "页面没有找到提交按钮" };
  }

  function remoteSessionKey() {
    return `${REMOTE_QUIZ_KEY_PREFIX}${location.origin}${location.pathname}${location.search}`;
  }

  async function remoteQuizSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get({
        targetId: "",
        accountId: "",
        lastContextToken: ""
      }, resolve);
    });
  }

  async function sendRemoteQuizIfNeeded(questions) {
    const key = remoteSessionKey();
    const sent = sessionStorage.getItem(key);
    if (sent) return;
    const settings = await remoteQuizSettings();
    if (!settings.targetId) return;
    const response = await askNative({
      type: "sendText",
      targetId: settings.targetId,
      accountId: settings.accountId || undefined,
      contextToken: settings.lastContextToken || undefined,
      text: formatQuizForWeixin(questions)
    });
    if (!response?.ok) return;
    for (const [index, question] of questions.entries()) {
      const imageDataUrl = await captureQuestionImage(question);
      const sent = await sendWeixinImage(settings, imageDataUrl, `第 ${index + 1} 题截图（以图片为准）`);
      if (!sent?.ok) {
        await sendWeixinText(settings, `第 ${index + 1} 题截图发送失败：${sent?.error || "未知错误"}。可稍后回复：题图 ${index + 1}`);
      }
    }
    sessionStorage.setItem(key, String(Date.now()));
  }

  async function pollRemoteQuizReplies() {
    const settings = await remoteQuizSettings();
    if (!settings.targetId) return;
    const response = await askNative({
      type: "pollMessages",
      accountId: settings.accountId || undefined,
      timeoutMs: 1000
    });
    if (!response?.ok || !Array.isArray(response.messages)) return;
    for (const message of response.messages) {
      const from = message.groupId || message.fromUserId;
      if (from !== settings.targetId) continue;
      const text = message.text || "";
      const apiCommand = parseApiConfigCommand(text);
      if (apiCommand) {
        const apiResponse = apiCommand.action === "status"
          ? await askNative({ type: "getLlmSettings" })
          : await askNative({ type: "saveLlmSettings", settings: apiCommand.settings });
        await sendWeixinText(settings, formatApiStatus(apiResponse));
        continue;
      }
      const explainCommand = parseExplainCommand(text);
      if (explainCommand) {
        await handleExplainCommand(explainCommand, settings);
        continue;
      }
      const screenshotCommand = parseScreenshotCommand(text);
      if (screenshotCommand) {
        await handleScreenshotCommand(screenshotCommand, settings);
        continue;
      }
      const wrongBookCommand = parseWrongBookCommand(text);
      if (wrongBookCommand) {
        await handleWrongBookCommand(wrongBookCommand, settings);
        continue;
      }
      if (isSubmitCommand(text)) {
        const submitted = clickSubmitIfRequested("remote");
        await sendWeixinText(settings, submitted.ok ? "已收到“提交”命令，已在页面点击提交。" : `收到“提交”命令，但未提交：${submitted.reason}`);
        continue;
      }
      const answers = parseRemoteAnswers(text);
      if (!answers.length) continue;
      const result = applyRemoteAnswers(answers);
      await sendWeixinText(settings, [
          result.applied.length ? `已填入：${result.applied.join(" ")}` : "",
          result.failed.length ? `未识别：${result.failed.join(" ")}` : "",
          "如需提交，请单独回复：提交"
        ].filter(Boolean).join("\n"));
    }
  }

  function startRemoteQuizBridge(questions) {
    if (remoteQuizStarted || !questions.length) return;
    remoteQuizStarted = true;
    sendRemoteQuizIfNeeded(questions);
    remoteQuizPollTimer = window.setInterval(pollRemoteQuizReplies, 8000);
  }

  function ensureQuizPanel() {
    if (hasCxSecretText() && !cxSecretMap && !cxSecretAttempted) {
      ensureCxSecretDecoder().then(() => ensureQuizPanel());
      return;
    }
    const questions = extractQuestions();
    if (!questions.length || document.getElementById(QUIZ_PANEL_ID)) return;

    const panel = document.createElement("aside");
    panel.id = QUIZ_PANEL_ID;
    panel.innerHTML = `
      <div class="acq-head">
        <strong>题目助手</strong>
        <button type="button" class="acq-close">×</button>
      </div>
      <div class="acq-note">微信远程作答只填入你回复的选项；发送“提交”才会提交。</div>
      <div class="acq-list"></div>
    `;
    const style = document.createElement("style");
    style.textContent = `
      #${QUIZ_PANEL_ID} {
        position: fixed;
        right: 18px;
        top: 88px;
        z-index: 2147483647;
        width: 340px;
        max-height: calc(100vh - 120px);
        overflow: auto;
        background: #ffffff;
        color: #172026;
        border: 1px solid #dbe2e7;
        border-radius: 8px;
        box-shadow: 0 12px 34px rgba(16, 24, 32, .18);
        font: 13px/1.45 "Microsoft YaHei", "Segoe UI", sans-serif;
      }
      #${QUIZ_PANEL_ID} .acq-head {
        position: sticky;
        top: 0;
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 10px 12px;
        background: #f5f7f8;
        border-bottom: 1px solid #dbe2e7;
      }
      #${QUIZ_PANEL_ID} .acq-close {
        width: 28px;
        height: 28px;
        border: 1px solid #dbe2e7;
        border-radius: 6px;
        background: #fff;
        cursor: pointer;
      }
      #${QUIZ_PANEL_ID} .acq-note {
        padding: 8px 12px;
        color: #65717b;
        border-bottom: 1px solid #edf1f4;
      }
      #${QUIZ_PANEL_ID} .acq-item {
        padding: 10px 12px;
        border-bottom: 1px solid #edf1f4;
      }
      #${QUIZ_PANEL_ID} .acq-stem {
        margin-bottom: 8px;
        color: #172026;
      }
      #${QUIZ_PANEL_ID} .acq-options {
        margin: 0 0 8px;
        padding-left: 18px;
        color: #34424d;
      }
      #${QUIZ_PANEL_ID} .acq-explain {
        width: 100%;
        border: 1px solid #13795b;
        border-radius: 6px;
        background: #13795b;
        color: #fff;
        padding: 7px 8px;
        cursor: pointer;
      }
      #${QUIZ_PANEL_ID} .acq-result {
        white-space: pre-wrap;
        margin-top: 8px;
        padding: 8px;
        border-radius: 6px;
        background: #f5f7f8;
        color: #172026;
      }
    `;

    const list = panel.querySelector(".acq-list");
    for (const [index, question] of questions.entries()) {
      const item = document.createElement("section");
      item.className = "acq-item";
      const options = question.options
        .map((option) => `<li>${option.label || option.value || "-"} ${option.text}</li>`)
        .join("");
      item.innerHTML = `
        <div class="acq-stem">${index + 1}. ${question.stem}</div>
        ${options ? `<ol class="acq-options">${options}</ol>` : ""}
        <button type="button" class="acq-explain">解析这题</button>
        <div class="acq-result" hidden></div>
      `;
      item.querySelector(".acq-explain").addEventListener("click", async () => {
        const result = item.querySelector(".acq-result");
        result.hidden = false;
        result.textContent = "正在请求大模型解析...";
        const imageDataUrl = await captureQuestionImage(question);
        const response = await askNative({
          type: "explainQuestion",
          question: questionPayload(question),
          imageDataUrl,
          timeoutMs: 60_000
        });
        result.textContent = response?.ok ? response.content || "没有返回内容。" : `解析失败：${response?.error || "未知错误"}`;
      });
      list.appendChild(item);
    }

    panel.querySelector(".acq-close").addEventListener("click", () => panel.remove());
    document.documentElement.appendChild(style);
    document.documentElement.appendChild(panel);
    startRemoteQuizBridge(questions);
  }

  loadSettings();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    for (const [key, change] of Object.entries(changes)) {
      settings[key] = change.newValue;
    }
  });

  scanVideos();
  watchManualSubmitClicks();
  ensureQuizPanel();
  scheduleWrongQuestionScan();
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          scanVideos(node);
        }
      }
    }
    ensureQuizPanel();
    scheduleWrongQuestionScan();
    clickNextConfirmIfShown();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
