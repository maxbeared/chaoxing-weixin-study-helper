// Remote command parsing.
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
  return /^(提交|确认提交|提交答案|交卷|submit)$/i.test(cleanText(text));
}

function hasInlineSubmitCommand(text) {
  return /(?:^|\s|,|，|;|；)(提交|确认提交|提交答案|交卷|submit)(?=\s|,|，|;|；|$)/i.test(cleanText(text));
}

function parseHelpCommand(text) {
  return /^(帮助|菜单|help|\?)$/i.test(cleanText(text));
}

function parseStatusCommand(text) {
  return /^状态$/i.test(cleanText(text));
}

function parseQuizProgressCommand(text) {
  return /^答题进度$/i.test(cleanText(text));
}

function parsePlaybackProgressCommand(text) {
  return /^(播放进度|视频进度|当前进度)$/i.test(cleanText(text));
}

function parseQuestionTextCommand(text) {
  const raw = cleanText(text);
  if (/^(重发|题目全部)$/i.test(raw)) {
    return { all: true };
  }
  if (/^(当前|当前题|题目)$/i.test(raw)) {
    return { current: true };
  }
  const match = raw.match(/^题目\s*([0-9]{1,2})(?:\s+([0-9]{1,2}))*$/i);
  if (!match) return null;
  const numbers = Array.from(raw.matchAll(/[0-9]{1,2}/g))
    .map((item) => Number(item[0]))
    .filter((num) => Number.isInteger(num) && num > 0);
  return numbers.length ? { indexes: numbers.map((num) => num - 1) } : null;
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
  if (/^查看\s*API$/i.test(raw) || /^API\s*状态$/i.test(raw)) {
    return { action: "status" };
  }
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

function formatWeixinCommandHelp() {
  return [
    "微信命令菜单：",
    "答题：答 1:A 2:BD 3:错",
    "答完并提交：答 1:A 2:BD 提交",
    "提交：提交 / 确认提交 / 交卷",
    "综合状态：状态",
    "答题进度：答题进度",
    "播放进度：播放进度 / 视频进度 / 当前进度",
    "查看题目：当前 / 题目 3 / 题目 1 2",
    "重发题目：重发 / 题目全部",
    "题图：题图 1 / 题图全部",
    "解析：解析 1 / 解析全部",
    "错题：错题 / 错题 10 / 清空错题",
    "API：查看API / 配置API minimax <key>",
    "自定义API：配置API 自定义 <endpoint> <model> <key>"
  ].join("\n");
}

function formatWeixinShortHelp() {
  return [
    "未识别这条微信命令。",
    "常用格式：",
    "答 1:A 2:BD 3:错",
    "答 1:A 2:BD 提交",
    "状态 / 播放进度 / 题图 1 / 解析 1",
    "回复“帮助”查看全部命令。"
  ].join("\n");
}
