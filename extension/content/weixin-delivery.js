// Weixin delivery, screenshots, and LLM explanation handlers.
async function sendWeixinText(settings, text) {
  if (!settings?.targetId) {
    writeRuntimeLog("info", "weixin_text_skipped", { reason: "missing_target" });
    return { ok: false, skipped: true, reason: "missing_target" };
  }
  const chunks = [];
  const raw = String(text || "");
  for (let i = 0; i < raw.length; i += 1800) {
    chunks.push(raw.slice(i, i + 1800));
  }
  let lastResponse = { ok: true };
  for (const chunk of chunks.length ? chunks : [""]) {
    lastResponse = await askNative({
      type: "sendText",
      targetId: settings.targetId,
      accountId: settings.accountId || undefined,
      contextToken: settings.lastContextToken || undefined,
      text: chunk
    });
    if (!lastResponse?.ok) {
      writeRuntimeLog("error", "weixin_text_failed", {
        error: lastResponse?.error || "Unknown error"
      });
    }
  }
  writeRuntimeLog(lastResponse?.ok ? "info" : "error", "weixin_text_sent", {
    ok: Boolean(lastResponse?.ok),
    error: lastResponse?.error || "",
    chunks: chunks.length || 1
  });
  return lastResponse;
}

async function sendWeixinImage(settings, dataUrl, caption) {
  if (!settings?.targetId) {
    writeRuntimeLog("info", "weixin_image_skipped", { reason: "missing_target" });
    return { ok: false, skipped: true, reason: "missing_target" };
  }
  if (!dataUrl) return { ok: false, error: "没有可发送的截图。" };
  const response = await askNative({
    type: "sendImageDataUrl",
    targetId: settings.targetId,
    accountId: settings.accountId || undefined,
    contextToken: settings.lastContextToken || undefined,
    dataUrl,
    caption
  });
  writeRuntimeLog(response?.ok ? "info" : "error", "weixin_image_sent", {
    ok: Boolean(response?.ok),
    error: response?.error || ""
  });
  return response;
}

async function captureQuestionImage(question) {
  const block = findQuestionBlock(question);
  if (block?.scrollIntoView) {
    block.scrollIntoView({ behavior: "instant", block: "center", inline: "nearest" });
  }
  const panel = document.getElementById(QUIZ_PANEL_ID);
  const previousDisplay = panel?.style.display;
  if (panel) panel.style.display = "none";
  try {
    await wait(450);
    const response = await askExtension({
      type: "capture-visible-tab",
      format: "jpeg",
      quality: 82,
      delayMs: 120
    });
    if (response?.ok) return await resizeImageDataUrl(response.dataUrl || "");
    writeRuntimeLog("info", "capture_dom_fallback", {
      error: response?.error || "",
      inactiveTab: Boolean(response?.inactiveTab)
    });
    return await renderElementImageDataUrl(block);
  } finally {
    if (panel) panel.style.display = previousDisplay || "";
  }
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

