// Remote submit state and polling bridge.
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

