import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";

const FIXED_BASE_URL = "https://ilinkai.weixin.qq.com";
const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const CXSECRET_TABLE_URL = "https://www.forestpolice.org/ttf/2.0/table.json";
const DEFAULT_BOT_TYPE = "3";
const CHANNEL_VERSION = "2.4.4";
const ILINK_APP_ID = "bot";
const ILINK_APP_CLIENT_VERSION = buildClientVersion(CHANNEL_VERSION);
const HOST_VERSION = "0.1.0";
const ACTIVE_LOGIN_TTL_MS = 5 * 60_000;
const QR_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_API_TIMEOUT_MS = 15_000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const HOST_RUNTIME_DIR = process.env.CX_WEIXIN_HOST_DIR || (process.pkg ? path.dirname(process.execPath) : SOURCE_ROOT);
const STATE_DIR = path.join(HOST_RUNTIME_DIR, ".state");
const LOG_DIR = path.join(STATE_DIR, "logs");
const RUNTIME_LOG_FILE = path.join(LOG_DIR, "runtime.log");
const ERROR_LOG_FILE = path.join(LOG_DIR, "error.log");
const MAX_LOG_BYTES = 1024 * 1024;
const ACCOUNT_FILE = path.join(STATE_DIR, "accounts.json");
const SYNC_FILE = path.join(STATE_DIR, "sync.json");
const LLM_FILE = path.join(STATE_DIR, "llm.json");
const CXSECRET_TABLE_FILE = path.join(STATE_DIR, "cxsecret-table.json");
const activeLogins = new Map();
let typrModule = null;
let cxSecretTablePromise = null;

// Runtime paths, state files, and logging.
function buildClientVersion(version) {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((part) => Number.parseInt(part, 10) || 0);
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function ensureLogDir() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function redactForLog(value) {
  try {
    return JSON.parse(JSON.stringify(value, (key, item) => {
      if (/token|key|authorization|apiKey|api_key|password|secret/i.test(key)) return "[redacted]";
      if (typeof item === "string" && item.length > 1200) return `${item.slice(0, 1200)}...`;
      return item;
    }));
  } catch {
    return String(value).slice(0, 1200);
  }
}

function rotateLogIfNeeded(file) {
  try {
    if (!fs.existsSync(file)) return;
    const stat = fs.statSync(file);
    if (stat.size <= MAX_LOG_BYTES) return;
    const oldFile = `${file}.1`;
    if (fs.existsSync(oldFile)) fs.rmSync(oldFile, { force: true });
    fs.renameSync(file, oldFile);
  } catch {
    // Logging must never break native messaging.
  }
}

function appendHostLog(level, event, details = {}) {
  try {
    ensureLogDir();
    const entry = {
      at: new Date().toISOString(),
      level,
      event,
      pid: process.pid,
      platform: `${os.platform()} ${os.release()}`,
      details: redactForLog(details)
    };
    const line = `${JSON.stringify(entry)}\n`;
    const file = level === "error" ? ERROR_LOG_FILE : RUNTIME_LOG_FILE;
    rotateLogIfNeeded(file);
    fs.appendFileSync(file, line, "utf8");
    if (level === "error") {
      rotateLogIfNeeded(RUNTIME_LOG_FILE);
      fs.appendFileSync(RUNTIME_LOG_FILE, line, "utf8");
    }
  } catch {
    // Logging must never break native messaging.
  }
}

function readLogFileTail(file, maxBytes = 256 * 1024) {
  try {
    if (!fs.existsSync(file)) return "";
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    return `Failed to read log file ${file}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function getNativeLogs() {
  return {
    ok: true,
    logDir: LOG_DIR,
    runtimeLog: readLogFileTail(RUNTIME_LOG_FILE),
    errorLog: readLogFileTail(ERROR_LOG_FILE)
  };
}

function clearNativeLogs() {
  ensureLogDir();
  for (const file of [RUNTIME_LOG_FILE, ERROR_LOG_FILE, `${RUNTIME_LOG_FILE}.1`, `${ERROR_LOG_FILE}.1`]) {
    try {
      if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    } catch {
      // Best effort.
    }
  }
  appendHostLog("info", "logs_cleared");
  return { ok: true, logDir: LOG_DIR };
}

function loadAccounts() {
  try {
    if (!fs.existsSync(ACCOUNT_FILE)) return { accounts: [], defaultAccountId: "" };
    const parsed = JSON.parse(fs.readFileSync(ACCOUNT_FILE, "utf8"));
    return {
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
      defaultAccountId: typeof parsed.defaultAccountId === "string" ? parsed.defaultAccountId : ""
    };
  } catch {
    return { accounts: [], defaultAccountId: "" };
  }
}

function saveAccounts(state) {
  ensureStateDir();
  fs.writeFileSync(ACCOUNT_FILE, JSON.stringify(state, null, 2), "utf8");
  try {
    fs.chmodSync(ACCOUNT_FILE, 0o600);
  } catch {
    // Windows ignores POSIX chmod semantics; best effort only.
  }
}

function loadSyncState() {
  try {
    if (!fs.existsSync(SYNC_FILE)) return {};
    const parsed = JSON.parse(fs.readFileSync(SYNC_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveSyncState(state) {
  ensureStateDir();
  fs.writeFileSync(SYNC_FILE, JSON.stringify(state, null, 2), "utf8");
}

function loadLlmSettings() {
  try {
    if (!fs.existsSync(LLM_FILE)) return {};
    const parsed = JSON.parse(fs.readFileSync(LLM_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveLlmSettingsFile(settings) {
  ensureStateDir();
  fs.writeFileSync(LLM_FILE, JSON.stringify(settings, null, 2), "utf8");
  try {
    fs.chmodSync(LLM_FILE, 0o600);
  } catch {
    // Best effort only on Windows.
  }
}

async function getTypr() {
  if (!typrModule) {
    globalThis.window = globalThis.window || { TextDecoder };
    const mod = require("typr.js");
    typrModule = mod.default || mod;
  }
  return typrModule;
}

async function loadCxSecretTable() {
  if (cxSecretTablePromise) return cxSecretTablePromise;
  cxSecretTablePromise = (async () => {
    try {
      if (fs.existsSync(CXSECRET_TABLE_FILE)) {
        const cached = JSON.parse(fs.readFileSync(CXSECRET_TABLE_FILE, "utf8"));
        if (cached && typeof cached === "object" && Object.keys(cached).length) return cached;
      }
    } catch {
      // Ignore corrupt cache and refresh below.
    }

    const response = await withTimeout(async (signal) => {
      const res = await fetch(CXSECRET_TABLE_URL, { signal });
      const text = await res.text();
      if (!res.ok) throw new Error(`cxsecret table ${res.status}: ${text}`);
      return text ? JSON.parse(text) : {};
    }, 20_000);
    ensureStateDir();
    fs.writeFileSync(CXSECRET_TABLE_FILE, JSON.stringify(response), "utf8");
    return response;
  })();
  return cxSecretTablePromise;
}

// LLM settings and model discovery.
function deriveModelsEndpoint(chatEndpoint) {
  const url = new URL(chatEndpoint);
  const originalPath = url.pathname;
  url.pathname = originalPath.replace(/\/chat\/completions\/?$/, "/models");
  if (url.pathname === originalPath || !url.pathname.endsWith("/models")) {
    url.pathname = "/v1/models";
  }
  url.search = "";
  url.hash = "";
  return url.toString();
}

function modelRank(id) {
  const text = String(id || "");
  const m = text.match(/MiniMax-M(\d+(?:\.\d+)?)/i);
  if (!m) return 0;
  return Number(m[1]) || 0;
}

function chooseLatestMiniMaxModel(models) {
  const candidates = models
    .filter((model) => /^MiniMax-M/i.test(model.id || ""))
    .sort((a, b) => {
      const createdDiff = Number(b.created || 0) - Number(a.created || 0);
      if (createdDiff) return createdDiff;
      return modelRank(b.id) - modelRank(a.id);
    });
  return candidates[0]?.id || "";
}

async function fetchAvailableModels(endpoint, apiKey, timeoutMs = 20_000) {
  const modelsEndpoint = deriveModelsEndpoint(endpoint);
  const response = await withTimeout(async (signal) => {
    const res = await fetch(modelsEndpoint, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      signal
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Models ${res.status}: ${text}`);
    return text ? JSON.parse(text) : {};
  }, timeoutMs);
  const models = Array.isArray(response.data) ? response.data : [];
  return { modelsEndpoint, models };
}

async function refreshMiniMaxModel(settings) {
  if (settings.preset !== "minimax" || !settings.endpoint || !settings.apiKey) {
    return { settings, modelRefresh: { skipped: true } };
  }
  const { modelsEndpoint, models } = await fetchAvailableModels(settings.endpoint, settings.apiKey);
  const latestModel = chooseLatestMiniMaxModel(models);
  if (!latestModel) {
    throw new Error(`No MiniMax text model found from ${modelsEndpoint}`);
  }
  return {
    settings: {
      ...settings,
      model: latestModel,
      modelAutoSelectedAt: new Date().toISOString()
    },
    modelRefresh: {
      ok: true,
      modelsEndpoint,
      selectedModel: latestModel,
      modelCount: models.length
    }
  };
}

async function checkLatestModel() {
  const settings = loadLlmSettings();
  if (settings.preset !== "minimax" || !settings.endpoint || !settings.apiKey) {
    return {
      ok: true,
      skipped: true,
      reason: "MiniMax preset is not fully configured."
    };
  }
  const { modelsEndpoint, models } = await fetchAvailableModels(settings.endpoint, settings.apiKey);
  const latestModel = chooseLatestMiniMaxModel(models);
  if (!latestModel) {
    return {
      ok: false,
      error: `No MiniMax text model found from ${modelsEndpoint}`
    };
  }
  const currentModel = settings.model || "";
  return {
    ok: true,
    skipped: false,
    preset: settings.preset,
    endpoint: settings.endpoint,
    currentModel,
    latestModel,
    hasUpdate: Boolean(currentModel && latestModel && currentModel !== latestModel),
    modelCount: models.length,
    modelsEndpoint
  };
}

async function saveLlmSettings(update) {
  const existing = loadLlmSettings();
  let next = {
    preset: String(update.preset ?? existing.preset ?? "custom").trim() || "custom",
    endpoint: String(update.endpoint ?? existing.endpoint ?? "").trim(),
    model: String(update.model ?? existing.model ?? "").trim(),
    apiKey: update.apiKey === undefined ? String(existing.apiKey ?? "") : String(update.apiKey || "").trim()
  };

  let modelRefresh = { skipped: true };
  let warning = "";
  if (next.preset === "minimax" && next.apiKey) {
    try {
      const refreshed = await refreshMiniMaxModel(next);
      next = refreshed.settings;
      modelRefresh = refreshed.modelRefresh;
    } catch (error) {
      warning = error instanceof Error ? error.message : String(error);
    }
  }
  saveLlmSettingsFile(next);
  return {
    ok: true,
    preset: next.preset,
    endpoint: next.endpoint,
    model: next.model,
    hasApiKey: Boolean(next.apiKey),
    modelRefresh,
    warning
  };
}

// Weixin account storage and API client helpers.
function upsertAccount(account) {
  const state = loadAccounts();
  const accounts = state.accounts.filter((item) => item.accountId !== account.accountId);
  accounts.push(account);
  saveAccounts({
    accounts,
    defaultAccountId: account.accountId
  });
}

function resolveAccount(accountId) {
  const state = loadAccounts();
  if (accountId) {
    const match = state.accounts.find((item) => item.accountId === accountId);
    if (!match) throw new Error(`Account not found: ${accountId}`);
    return match;
  }
  if (state.defaultAccountId) {
    const match = state.accounts.find((item) => item.accountId === state.defaultAccountId);
    if (match) return match;
  }
  if (state.accounts.length === 1) return state.accounts[0];
  if (state.accounts.length > 1) {
    throw new Error("Multiple accounts are stored. Set accountId in the extension popup.");
  }
  throw new Error("No Weixin account is connected. Generate and scan a QR code first.");
}

function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

function randomWechatUin() {
  const value = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(value), "utf8").toString("base64");
}

function buildCommonHeaders() {
  return {
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION)
  };
}

function buildHeaders(token) {
  const headers = {
    "Content-Type": "application/json",
    "AuthorizationType": "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    ...buildCommonHeaders()
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function baseInfo() {
  return {
    channel_version: CHANNEL_VERSION,
    bot_agent: `ChaoxingWeixinStudyHelper/${HOST_VERSION}`
  };
}

async function withTimeout(promiseFactory, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await promiseFactory(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function apiGet(baseUrl, endpoint, timeoutMs = DEFAULT_API_TIMEOUT_MS) {
  const url = new URL(endpoint, ensureTrailingSlash(baseUrl));
  return withTimeout(async (signal) => {
    const response = await fetch(url, {
      method: "GET",
      headers: buildCommonHeaders(),
      signal
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`GET ${endpoint} ${response.status}: ${text}`);
    return text ? JSON.parse(text) : {};
  }, timeoutMs);
}

async function apiPost(baseUrl, endpoint, body, token, timeoutMs = DEFAULT_API_TIMEOUT_MS) {
  const url = new URL(endpoint, ensureTrailingSlash(baseUrl));
  return withTimeout(async (signal) => {
    const response = await fetch(url, {
      method: "POST",
      headers: buildHeaders(token),
      body: JSON.stringify(body),
      signal
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`POST ${endpoint} ${response.status}: ${text}`);
    return text ? JSON.parse(text) : {};
  }, timeoutMs);
}

async function fetchQRCode(botType = DEFAULT_BOT_TYPE) {
  return apiPost(
    FIXED_BASE_URL,
    `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    { local_token_list: loadAccounts().accounts.map((item) => item.token).filter(Boolean) },
    undefined,
    DEFAULT_API_TIMEOUT_MS
  );
}

async function pollQRStatus(login, verifyCode) {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(login.qrcode)}`;
  if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
  try {
    return await apiGet(login.currentApiBaseUrl || FIXED_BASE_URL, endpoint, QR_LONG_POLL_TIMEOUT_MS);
  } catch (error) {
    if (error?.name === "AbortError") return { status: "wait" };
    throw error;
  }
}

// Weixin login flow.
function purgeExpiredLogins() {
  const now = Date.now();
  for (const [key, login] of activeLogins.entries()) {
    if (now - login.startedAt > ACTIVE_LOGIN_TTL_MS) activeLogins.delete(key);
  }
}

async function loginStart(message) {
  purgeExpiredLogins();
  const sessionKey = crypto.randomUUID();
  const response = await fetchQRCode(message.botType || DEFAULT_BOT_TYPE);
  if (!response.qrcode || !response.qrcode_img_content) {
    throw new Error(`Unexpected QR response: ${JSON.stringify(response)}`);
  }

  activeLogins.set(sessionKey, {
    sessionKey,
    qrcode: response.qrcode,
    qrcodeUrl: response.qrcode_img_content,
    startedAt: Date.now(),
    currentApiBaseUrl: FIXED_BASE_URL,
    pendingVerifyCode: ""
  });

  const qrDataUrl = await QRCode.toDataURL(response.qrcode_img_content, {
    margin: 2,
    width: 260,
    errorCorrectionLevel: "M"
  });

  return {
    ok: true,
    sessionKey,
    qrDataUrl,
    qrPayload: response.qrcode_img_content,
    message: "请用手机微信扫描二维码并确认。"
  };
}

async function loginWait(message) {
  const login = activeLogins.get(message.sessionKey);
  if (!login) throw new Error("Login session not found or expired.");
  const deadline = Date.now() + Math.max(1000, Number(message.timeoutMs) || 60000);

  while (Date.now() < deadline) {
    const status = await pollQRStatus(login, message.verifyCode || login.pendingVerifyCode);
    login.status = status.status;

    if (status.status === "wait" || status.status === "scaned") continue;
    if (status.status === "scaned_but_redirect") {
      if (status.redirect_host) login.currentApiBaseUrl = `https://${status.redirect_host}`;
      continue;
    }
    if (status.status === "need_verifycode") {
      return {
        ok: false,
        needVerifyCode: true,
        status: status.status,
        error: "手机微信要求输入配对数字。本 helper 当前只返回状态，请在后续版本补充输入框。"
      };
    }
    if (status.status === "expired") {
      activeLogins.delete(message.sessionKey);
      return { ok: false, status: status.status, error: "二维码已过期，请重新生成。" };
    }
    if (status.status === "verify_code_blocked") {
      activeLogins.delete(message.sessionKey);
      return { ok: false, status: status.status, error: "验证码多次错误，请稍后重试。" };
    }
    if (status.status === "binded_redirect") {
      activeLogins.delete(message.sessionKey);
      return { ok: true, alreadyConnected: true, status: status.status, message: "此微信已连接过。" };
    }
    if (status.status === "confirmed") {
      if (!status.ilink_bot_id || !status.bot_token) {
        throw new Error(`Login confirmed without credentials: ${JSON.stringify(status)}`);
      }
      const account = {
        accountId: status.ilink_bot_id,
        token: status.bot_token,
        baseUrl: status.baseurl || FIXED_BASE_URL,
        userId: status.ilink_user_id || "",
        savedAt: new Date().toISOString()
      };
      upsertAccount(account);
      activeLogins.delete(message.sessionKey);
      return {
        ok: true,
        status: status.status,
        accountId: account.accountId,
        userId: account.userId,
        baseUrl: account.baseUrl,
        message: "微信连接成功。"
      };
    }
  }

  return { ok: false, status: login.status || "wait", error: "扫码确认超时。" };
}

function generateClientId() {
  return `chaoxing-study-${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}`;
}

// Image upload, font decoding, and message operations.
function dataUrlToBuffer(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) throw new Error("Expected a base64 data URL.");
  return {
    mimeType: match[1],
    buffer: Buffer.from(match[2], "base64")
  };
}

async function decodeCxSecretFont(message) {
  const fontBase64 = String(message.fontBase64 || "").replace(/^data:.*?;base64,/, "").trim();
  if (!fontBase64) throw new Error("fontBase64 is required.");
  const buffer = Buffer.from(fontBase64, "base64");
  if (!buffer.length) throw new Error("fontBase64 is empty.");

  const [Typr, table] = await Promise.all([getTypr(), loadCxSecretTable()]);
  const font = Typr.parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  const map = {};
  const misses = [];
  const seenGids = new Set();

  for (let codePoint = 0; codePoint <= 0xffff; codePoint += 1) {
    let glyphId = 0;
    try {
      glyphId = Typr.U.codeToGlyph(font, codePoint);
    } catch {
      glyphId = 0;
    }
    if (!glyphId || seenGids.has(glyphId)) continue;
    seenGids.add(glyphId);
    const source = String.fromCodePoint(codePoint);
    const pathData = Typr.U.glyphToPath(font, glyphId);
    const hash = crypto
      .createHash("md5")
      .update(JSON.stringify(pathData))
      .digest("hex")
      .slice(24);
    const decodedCodePoint = table[hash];
    if (decodedCodePoint) {
      map[source] = String.fromCodePoint(Number(decodedCodePoint));
    } else {
      misses.push({ source, hash });
    }
  }

  return {
    ok: true,
    map,
    mappedCount: Object.keys(map).length,
    missCount: misses.length,
    misses: misses.slice(0, 20)
  };
}

function aesEcbPaddedSize(size) {
  return Math.ceil((size + 1) / 16) * 16;
}

function encryptAesEcb(plaintext, key) {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

async function uploadImageBuffer(account, targetId, buffer) {
  const rawsize = buffer.length;
  const rawfilemd5 = crypto.createHash("md5").update(buffer).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);
  const aeskeyHex = aeskey.toString("hex");

  const uploadUrlResp = await apiPost(
    account.baseUrl || FIXED_BASE_URL,
    "ilink/bot/getuploadurl",
    {
      filekey,
      media_type: 1,
      to_user_id: targetId,
      rawsize,
      rawfilemd5,
      filesize,
      no_need_thumb: true,
      aeskey: aeskeyHex,
      base_info: baseInfo()
    },
    account.token,
    DEFAULT_API_TIMEOUT_MS
  );
  const uploadParam = uploadUrlResp.upload_param;
  if (!uploadParam) {
    throw new Error(`getuploadurl returned no upload_param: ${JSON.stringify(uploadUrlResp)}`);
  }

  const uploadUrl = `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
  const ciphertext = encryptAesEcb(buffer, aeskey);
  const uploadRes = await withTimeout(async (signal) => {
    const res = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(ciphertext),
      signal
    });
    const downloadParam = res.headers.get("x-encrypted-param") || "";
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`CDN upload ${res.status}: ${res.headers.get("x-error-message") || text}`);
    }
    if (!downloadParam) throw new Error("CDN upload response missing x-encrypted-param.");
    return downloadParam;
  }, 30_000);

  return {
    downloadParam: uploadRes,
    aeskeyHex,
    ciphertextSize: ciphertext.length
  };
}

async function sendText(message) {
  const targetId = String(message.targetId || "").trim();
  const text = String(message.text || "").trim();
  if (!targetId) throw new Error("targetId is required.");
  if (!text) throw new Error("text is required.");

  const account = resolveAccount(message.accountId);
  const body = {
    msg: {
      from_user_id: "",
      to_user_id: targetId,
      client_id: generateClientId(),
      message_type: 2,
      message_state: 2,
      item_list: [
        {
          type: 1,
          text_item: { text }
        }
      ],
      context_token: message.contextToken || undefined,
      run_id: message.runId || undefined
    },
    base_info: baseInfo()
  };

  const response = await apiPost(account.baseUrl || FIXED_BASE_URL, "ilink/bot/sendmessage", body, account.token);
  return { ok: true, response };
}

async function sendImageDataUrl(message) {
  const targetId = String(message.targetId || "").trim();
  if (!targetId) throw new Error("targetId is required.");
  const { mimeType, buffer } = dataUrlToBuffer(message.dataUrl);
  if (!/^image\/(png|jpeg|jpg|webp)$/i.test(mimeType)) {
    throw new Error(`Unsupported image MIME type: ${mimeType}`);
  }
  if (!buffer.length) throw new Error("image data is empty.");
  if (buffer.length > 8 * 1024 * 1024) throw new Error("image is too large to send.");

  const account = resolveAccount(message.accountId);
  const caption = String(message.caption || "").trim();
  if (caption) {
    await sendText({
      targetId,
      accountId: message.accountId,
      contextToken: message.contextToken,
      runId: message.runId,
      text: caption
    });
  }

  const uploaded = await uploadImageBuffer(account, targetId, buffer);
  const body = {
    msg: {
      from_user_id: "",
      to_user_id: targetId,
      client_id: generateClientId(),
      message_type: 2,
      message_state: 2,
      item_list: [
        {
          type: 2,
          image_item: {
            media: {
              encrypt_query_param: uploaded.downloadParam,
              aes_key: Buffer.from(uploaded.aeskeyHex).toString("base64"),
              encrypt_type: 1
            },
            mid_size: uploaded.ciphertextSize
          }
        }
      ],
      context_token: message.contextToken || undefined,
      run_id: message.runId || undefined
    },
    base_info: baseInfo()
  };

  const response = await apiPost(account.baseUrl || FIXED_BASE_URL, "ilink/bot/sendmessage", body, account.token);
  return { ok: true, response };
}

async function pollMessages(message) {
  const account = resolveAccount(message.accountId);
  const syncState = loadSyncState();
  const accountSync = syncState[account.accountId] || {};
  let response;
  try {
    response = await apiPost(
      account.baseUrl || FIXED_BASE_URL,
      "ilink/bot/getupdates",
      {
        get_updates_buf: accountSync.getUpdatesBuf || "",
        base_info: baseInfo()
      },
      account.token,
      Number(message.timeoutMs) || QR_LONG_POLL_TIMEOUT_MS
    );
  } catch (error) {
    if (error?.name === "AbortError") {
      response = { msgs: [], get_updates_buf: accountSync.getUpdatesBuf || "" };
    } else {
      throw error;
    }
  }

  if (response.get_updates_buf !== undefined) {
    syncState[account.accountId] = {
      getUpdatesBuf: response.get_updates_buf,
      savedAt: new Date().toISOString()
    };
    saveSyncState(syncState);
  }

  const messages = Array.isArray(response.msgs) ? response.msgs : [];
  return {
    ok: true,
    accountId: account.accountId,
    count: messages.length,
    messages: messages.slice(-20).map((item) => ({
      fromUserId: item.from_user_id || "",
      toUserId: item.to_user_id || "",
      groupId: item.group_id || "",
      contextToken: item.context_token || "",
      messageId: item.message_id || item.client_id || "",
      text: extractText(item),
      createdAt: item.create_time_ms || 0
    }))
  };
}

function extractText(message) {
  const items = Array.isArray(message.item_list) ? message.item_list : [];
  return items
    .map((item) => item?.text_item?.text || "")
    .filter(Boolean)
    .join("\n")
    .slice(0, 240);
}

// LLM question explanation.
function redactedLlmSettings() {
  const settings = loadLlmSettings();
  return {
    ok: true,
    preset: settings.preset || "custom",
    endpoint: settings.endpoint || "",
    model: settings.model || "",
    hasApiKey: Boolean(settings.apiKey)
  };
}

function buildQuestionPrompt(question) {
  const options = Array.isArray(question.options) ? question.options : [];
  const optionText = options
    .map((option) => `${option.label || option.value || "-"}: ${option.text || ""}`.trim())
    .join("\n");
  return [
    "请作为学习辅导助手，帮助我理解下面这道题。",
    "要求：不要直接给出最终选项字母、不要替我作答；请解释题目考点、判断思路、每个选项该如何分析，以及需要回看课程中的哪些知识点。",
    "如果页面文本存在乱码或字体映射异常，请明确指出无法可靠判断，并只基于可读文本给出学习建议。",
    "",
    `题型：${question.typeLabel || question.type || "未知"}`,
    `题干：${question.stem || ""}`,
    optionText ? `选项：\n${optionText}` : ""
  ].filter(Boolean).join("\n");
}

async function explainQuestion(message) {
  let settings = loadLlmSettings();
  if (settings.preset === "minimax" && settings.apiKey && settings.endpoint) {
    try {
      const refreshed = await refreshMiniMaxModel(settings);
      settings = refreshed.settings;
      saveLlmSettingsFile(settings);
    } catch {
      // Keep the last saved model if model discovery is temporarily unavailable.
    }
  }
  const endpoint = String(settings.endpoint || "").trim();
  const model = String(settings.model || "").trim();
  const apiKey = String(settings.apiKey || "").trim();
  if (!endpoint || !model || !apiKey) {
    throw new Error("LLM settings are incomplete. Configure endpoint, model, and API key first.");
  }

  const question = message.question || {};
  const imageDataUrl = String(message.imageDataUrl || "").trim();
  const userContent = imageDataUrl
    ? [
        {
          type: "text",
          text: [
            buildQuestionPrompt(question),
            "",
            "随附截图是页面实际显示的题面。若 DOM 文本与截图不一致，请以截图为准；仍然不要直接给出最终选项。"
          ].join("\n")
        },
        {
          type: "image_url",
          image_url: { url: imageDataUrl }
        }
      ]
    : buildQuestionPrompt(question);
  const body = {
    model,
    messages: [
      {
        role: "system",
        content: "你是学习辅导助手。你帮助用户理解题目和复习知识点，但不直接代答考试、测验或作业。"
      },
      {
        role: "user",
        content: userContent
      }
    ],
    temperature: 0.2
  };

  const response = await withTimeout(async (signal) => {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`LLM ${res.status}: ${text}`);
    return text ? JSON.parse(text) : {};
  }, Number(message.timeoutMs) || 60_000);

  const content =
    response?.choices?.[0]?.message?.content ||
    response?.output_text ||
    response?.content ||
    "";
  return {
    ok: true,
    content: String(content || "").trim(),
    rawUsage: response?.usage || undefined
  };
}

// Native message router and protocol loop.
async function handleMessage(message) {
  const type = String(message?.type || "unknown");
  appendHostLog("info", "request_started", {
    type,
    fields: Object.keys(message || {}).filter((key) => !/token|key|authorization|api/i.test(key))
  });

  switch (message?.type) {
    case "status": {
      const state = loadAccounts();
      return {
        ok: true,
        hostVersion: HOST_VERSION,
        node: process.version,
        platform: `${os.platform()} ${os.release()}`,
        logDir: LOG_DIR,
        accountCount: state.accounts.length,
        defaultAccountId: state.defaultAccountId || "",
        llmConfigured: Boolean(loadLlmSettings().apiKey)
      };
    }
    case "loginStart":
      return loginStart(message);
    case "loginWait":
      return loginWait(message);
    case "sendText":
      return sendText(message);
    case "sendImageDataUrl":
      return sendImageDataUrl(message);
    case "decodeCxSecretFont":
      return decodeCxSecretFont(message);
    case "pollMessages":
      return pollMessages(message);
    case "getLlmSettings":
      return redactedLlmSettings();
    case "saveLlmSettings":
      return saveLlmSettings(message.settings || {});
    case "checkLatestModel":
      return checkLatestModel();
    case "explainQuestion":
      return explainQuestion(message);
    case "getLogs":
      return getNativeLogs();
    case "clearLogs":
      return clearNativeLogs();
    default:
      return { ok: false, error: `Unknown message type: ${message?.type}` };
  }
}

async function handleMessageWithLogging(message) {
  const startedAt = Date.now();
  const type = String(message?.type || "unknown");
  try {
    const response = await handleMessage(message);
    appendHostLog(response?.ok === false ? "error" : "info", "request_finished", {
      type,
      ok: response?.ok !== false,
      error: response?.error || "",
      durationMs: Date.now() - startedAt
    });
    return response;
  } catch (error) {
    appendHostLog("error", "request_failed", {
      type,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack || "" : "",
      durationMs: Date.now() - startedAt
    });
    throw error;
  }
}

function readNativeMessages(onMessage) {
  let buffer = Buffer.alloc(0);
  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) return;
      const payload = buffer.subarray(4, 4 + length).toString("utf8");
      buffer = buffer.subarray(4 + length);
      try {
        onMessage(JSON.parse(payload));
      } catch (error) {
        appendHostLog("error", "invalid_native_message", {
          error: error instanceof Error ? error.message : String(error),
          payloadPreview: payload.slice(0, 500)
        });
        writeNativeMessage({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  });
}

function writeNativeMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  process.stdout.write(Buffer.concat([header, payload]));
}

process.on("uncaughtException", (error) => {
  appendHostLog("error", "uncaught_exception", {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack || "" : ""
  });
});

process.on("unhandledRejection", (reason) => {
  appendHostLog("error", "unhandled_rejection", {
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack || "" : ""
  });
});

appendHostLog("info", "host_started", {
  hostVersion: HOST_VERSION,
  node: process.version,
  runtimeDir: HOST_RUNTIME_DIR
});

readNativeMessages(async (message) => {
  try {
    const response = await handleMessageWithLogging(message);
    writeNativeMessage(response);
  } catch (error) {
    writeNativeMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});
