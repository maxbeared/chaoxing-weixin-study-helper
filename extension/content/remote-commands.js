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

