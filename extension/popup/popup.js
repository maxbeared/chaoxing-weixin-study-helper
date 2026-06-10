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

let loginSessionKey = "";
let pendingLatestModel = "";

const LLM_PRESETS = {
  minimax: {
    endpoint: "https://api.minimaxi.com/v1/chat/completions",
    model: "MiniMax-M3"
  }
};

const $ = (id) => document.getElementById(id);

function log(message) {
  $("log").textContent = typeof message === "string" ? message : JSON.stringify(message, null, 2);
}

function nativeSend(payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "native", payload }, (response) => {
      const err = chrome.runtime.lastError;
      if (err) resolve({ ok: false, error: err.message });
      else resolve(response);
    });
  });
}

function extensionSend(payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(payload, (response) => {
      const err = chrome.runtime.lastError;
      if (err) resolve({ ok: false, error: err.message });
      else resolve(response || { ok: false, error: "No response" });
    });
  });
}

function formatExtensionLogs(logs) {
  if (!Array.isArray(logs) || !logs.length) return "(扩展运行日志为空)";
  return logs.map((item) => {
    const details = item.details ? ` ${JSON.stringify(item.details)}` : "";
    const tab = item.tabId !== "" && item.tabId !== undefined ? ` tab=${item.tabId}` : "";
    const url = item.url ? ` url=${item.url}` : "";
    return `[${item.at}] ${item.level || "info"} ${item.source || "extension"} ${item.event || "log"}${tab}${url}${details}`;
  }).join("\n");
}

async function collectLogs() {
  const [extensionLogs, nativeLogs] = await Promise.all([
    extensionSend({ type: "get-extension-logs" }),
    nativeSend({ type: "getLogs" })
  ]);
  const sections = [
    "===== Extension Logs =====",
    extensionLogs?.ok ? formatExtensionLogs(extensionLogs.logs) : `读取扩展日志失败：${extensionLogs?.error || "未知错误"}`,
    "",
    "===== Native Runtime Log =====",
    nativeLogs?.ok ? nativeLogs.runtimeLog || "(native runtime log 为空)" : `读取 native 日志失败：${nativeLogs?.error || "未知错误"}`,
    "",
    "===== Native Error Log =====",
    nativeLogs?.ok ? nativeLogs.errorLog || "(native error log 为空)" : `读取 native 错误日志失败：${nativeLogs?.error || "未知错误"}`,
    "",
    nativeLogs?.logDir ? `Native log dir: ${nativeLogs.logDir}` : ""
  ];
  return sections.join("\n");
}

async function viewLogs() {
  $("logsView").value = "正在读取日志...";
  $("logsView").value = await collectLogs();
}

async function downloadLogs() {
  const text = await collectLogs();
  $("logsView").value = text;
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `chaoxing-study-helper-logs-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function clearLogs() {
  const [extensionResult, nativeResult] = await Promise.all([
    extensionSend({ type: "clear-extension-logs" }),
    nativeSend({ type: "clearLogs" })
  ]);
  $("logsView").value = [
    extensionResult?.ok ? "扩展日志已清空。" : `扩展日志清空失败：${extensionResult?.error || "未知错误"}`,
    nativeResult?.ok ? "Native 日志已清空。" : `Native 日志清空失败：${nativeResult?.error || "未知错误"}`
  ].join("\n");
}

function updateLlmPresetUi(forceDefaults = false) {
  const preset = $("llmPreset").value;
  const config = LLM_PRESETS[preset];
  const isPreset = Boolean(config);
  if (isPreset) {
    if (forceDefaults || !$("llmEndpoint").value.trim()) $("llmEndpoint").value = config.endpoint;
    if (forceDefaults || !$("llmModel").value.trim()) $("llmModel").value = config.model;
  }
  $("llmEndpoint").disabled = isPreset;
  $("llmModel").disabled = isPreset;
  $("llmPresetNote").textContent = isPreset
    ? "保存时会调用 /v1/models 自动选择最新 MiniMax-M 系列模型。"
    : "";
}

function loadSettings() {
  chrome.storage.sync.get(DEFAULTS, (settings) => {
    $("enabled").checked = settings.enabled;
    $("targetId").value = settings.targetId || "";
    $("accountId").value = settings.accountId || "";
    $("cooldownSeconds").value = settings.cooldownSeconds;
    $("pauseDebounceSeconds").value = settings.pauseDebounceSeconds;
    $("includeUrl").checked = settings.includeUrl;
    $("autoNextOnEnded").checked = settings.autoNextOnEnded;
    $("autoPlayNextVideo").checked = settings.autoPlayNextVideo;
    $("preventSleep").checked = settings.preventSleep;
    $("notifyOnPause").checked = settings.notifyOnPause;
    $("notifyOnEnded").checked = settings.notifyOnEnded;
    $("notifyOnStalled").checked = settings.notifyOnStalled;
  });
}

function collectSettings() {
  return {
    enabled: $("enabled").checked,
    targetId: $("targetId").value.trim(),
    accountId: $("accountId").value.trim(),
    cooldownSeconds: Number($("cooldownSeconds").value) || 0,
    pauseDebounceSeconds: Number($("pauseDebounceSeconds").value) || 0,
    includeUrl: $("includeUrl").checked,
    autoNextOnEnded: $("autoNextOnEnded").checked,
    autoPlayNextVideo: $("autoPlayNextVideo").checked,
    preventSleep: $("preventSleep").checked,
    notifyOnPause: $("notifyOnPause").checked,
    notifyOnEnded: $("notifyOnEnded").checked,
    notifyOnStalled: $("notifyOnStalled").checked
  };
}

async function saveSettings() {
  const settings = collectSettings();
  await chrome.storage.sync.set(settings);
  log("设置已保存");
}

async function checkStatus() {
  const response = await nativeSend({ type: "status" });
  $("statusText").textContent = response?.ok ? "本地服务可用" : "本地服务不可用";
  log(response);
}

async function loadLlmSettings() {
  const response = await nativeSend({ type: "getLlmSettings" });
  if (!response?.ok) return;
  $("llmPreset").value = response.preset || "custom";
  $("llmEndpoint").value = response.endpoint || "";
  $("llmModel").value = response.model || "";
  $("llmApiKey").placeholder = response.hasApiKey ? "已保存；留空不修改" : "请输入 API Key";
  updateLlmPresetUi();
}

function showModelUpdate(check) {
  if (!check?.ok || !check.hasUpdate) {
    $("modelUpdate").classList.add("hidden");
    pendingLatestModel = "";
    return;
  }
  pendingLatestModel = check.latestModel;
  $("modelUpdateText").textContent = `发现 MiniMax 新模型：${check.latestModel}，当前使用：${check.currentModel || "未配置"}`;
  $("modelUpdate").classList.remove("hidden");
}

async function checkLatestModel() {
  const check = await nativeSend({ type: "checkLatestModel" });
  showModelUpdate(check);
  if (check?.ok && !check.skipped) {
    log(check);
  }
}

async function switchToLatestModel() {
  if (!pendingLatestModel) return;
  const response = await nativeSend({
    type: "saveLlmSettings",
    settings: {
      preset: "minimax",
      endpoint: LLM_PRESETS.minimax.endpoint,
      model: pendingLatestModel
    }
  });
  if (response?.ok) {
    $("llmPreset").value = response.preset || "minimax";
    $("llmEndpoint").value = response.endpoint || "";
    $("llmModel").value = response.model || pendingLatestModel;
    $("llmApiKey").value = "";
    $("llmApiKey").placeholder = response.hasApiKey ? "已保存；留空不修改" : "请输入 API Key";
    updateLlmPresetUi();
    $("modelUpdate").classList.add("hidden");
    pendingLatestModel = "";
  }
  log(response);
}

async function saveLlmSettings() {
  updateLlmPresetUi();
  const preset = $("llmPreset").value;
  const response = await nativeSend({
    type: "saveLlmSettings",
    settings: {
      preset,
      endpoint: $("llmEndpoint").value.trim(),
      model: $("llmModel").value.trim(),
      apiKey: $("llmApiKey").value
    }
  });
  if (response?.ok) {
    $("llmPreset").value = response.preset || preset;
    $("llmEndpoint").value = response.endpoint || "";
    $("llmModel").value = response.model || "";
    updateLlmPresetUi();
    if (response.model) $("llmModel").value = response.model;
    $("llmApiKey").value = "";
    $("llmApiKey").placeholder = response.hasApiKey ? "已保存；留空不修改" : "请输入 API Key";
  }
  log(response);
  checkLatestModel();
}

async function startLogin() {
  const response = await nativeSend({ type: "loginStart", force: true });
  if (!response?.ok) {
    log(response);
    return;
  }
  loginSessionKey = response.sessionKey;
  $("qrImage").src = response.qrDataUrl;
  $("qrMessage").textContent = response.message || "请用手机微信扫码确认";
  $("qrWrap").classList.remove("hidden");
  log("二维码已生成。扫码后点“我已扫码，检查登录”。登录成功后，用接收通知的微信给助手发一句话，再点“读取最近消息”自动绑定目标。");
}

async function waitLogin() {
  if (!loginSessionKey) {
    log("请先生成二维码。");
    return;
  }
  log("正在检查扫码状态，最多等待 60 秒...");
  let response = await nativeSend({
    type: "loginWait",
    sessionKey: loginSessionKey,
    timeoutMs: 60000
  });
  if (response?.needVerifyCode) {
    const verifyCode = prompt("输入手机微信上显示的配对数字");
    if (verifyCode) {
      response = await nativeSend({
        type: "loginWait",
        sessionKey: loginSessionKey,
        timeoutMs: 60000,
        verifyCode: verifyCode.trim()
      });
    }
  }
  if (response?.ok && response.accountId) {
    $("accountId").value = response.accountId;
    $("targetId").value = "";
    await chrome.storage.sync.set({
      accountId: response.accountId,
      targetId: "",
      lastContextToken: ""
    });
    await saveSettings();
    $("statusText").textContent = "微信已连接";
    log("微信已连接。已清空旧的微信目标 ID。现在用接收通知的微信给助手发一句话，然后点“读取最近消息”重新绑定目标。");
    return;
  }
  log(response);
}

async function testSend() {
  await saveSettings();
  const settings = collectSettings();
  if (!settings.targetId) {
    log("还没有微信目标 ID。请先用接收通知的微信给助手发一句话，然后点“读取最近消息”，系统会自动填入。");
    return;
  }
  const response = await nativeSend({
    type: "sendText",
    targetId: settings.targetId,
    accountId: settings.accountId || undefined,
    contextToken: settings.lastContextToken || undefined,
    text: `测试通知\n来自浏览器扩展\n${new Date().toLocaleString()}`
  });
  log(response);
}

async function selectMessageTarget(message, reason = "manual") {
  const target = message?.groupId || message?.fromUserId || "";
  if (!target) return false;
  $("targetId").value = target;
  await chrome.storage.sync.set({
    targetId: target,
    lastContextToken: message.contextToken || ""
  });
  log(reason === "auto" ? `已自动填入微信目标 ID：${target}` : `已填入目标：${target}`);
  return true;
}

function renderMessages(messages) {
  const wrap = $("messages");
  wrap.textContent = "";
  if (!messages?.length) {
    const empty = document.createElement("p");
    empty.textContent = "没有读取到新消息。先从目标微信给此账号发一条消息，再读取。";
    wrap.appendChild(empty);
    return;
  }
  for (const message of messages) {
    const target = message.groupId || message.fromUserId;
    if (!target) continue;
    const button = document.createElement("button");
    button.className = "message";
    const id = document.createElement("strong");
    id.textContent = target;
    const text = document.createElement("span");
    text.textContent = message.text || "(非文本消息)";
    button.append(id, text);
    button.addEventListener("click", async () => {
      await selectMessageTarget(message);
    });
    wrap.appendChild(button);
  }
}

async function pollMessages() {
  const settings = collectSettings();
  log("正在读取最近消息，最多等待 35 秒...");
  const response = await nativeSend({
    type: "pollMessages",
    accountId: settings.accountId || undefined,
    timeoutMs: 35000
  });
  if (response?.ok) {
    renderMessages(response.messages);
    const candidates = (response.messages || []).filter((message) => message.groupId || message.fromUserId);
    if (!$("targetId").value.trim() && candidates.length) {
      await selectMessageTarget(candidates[candidates.length - 1], "auto");
      return;
    }
  }
  log(response);
}

$("saveBtn").addEventListener("click", saveSettings);
$("statusBtn").addEventListener("click", checkStatus);
$("loginBtn").addEventListener("click", startLogin);
$("waitLoginBtn").addEventListener("click", waitLogin);
$("testBtn").addEventListener("click", testSend);
$("pollBtn").addEventListener("click", pollMessages);
$("saveLlmBtn").addEventListener("click", saveLlmSettings);
$("llmPreset").addEventListener("change", () => updateLlmPresetUi(true));
$("switchModelBtn").addEventListener("click", switchToLatestModel);
$("enabled").addEventListener("change", saveSettings);
$("viewLogsBtn").addEventListener("click", viewLogs);
$("downloadLogsBtn").addEventListener("click", downloadLogs);
$("clearLogsBtn").addEventListener("click", clearLogs);

loadSettings();
checkStatus();
loadLlmSettings();
checkLatestModel();
