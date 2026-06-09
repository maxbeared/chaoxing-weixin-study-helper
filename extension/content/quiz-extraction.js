// Quiz extraction and cxsecret decoding.
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

