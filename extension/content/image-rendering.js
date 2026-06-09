// Extension/native messaging helpers and image rendering.
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

function inlineComputedStyles(source, target) {
  if (!(source instanceof Element) || !(target instanceof Element)) return;
  const computed = getComputedStyle(source);
  const keep = [
    "box-sizing", "display", "position", "width", "min-width", "max-width", "height", "min-height", "max-height",
    "margin", "padding", "border", "border-radius", "background", "background-color", "color",
    "font", "font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing",
    "text-align", "text-decoration", "white-space", "word-break", "overflow-wrap", "vertical-align",
    "list-style", "list-style-type", "box-shadow", "opacity"
  ];
  target.setAttribute("style", keep.map((name) => `${name}:${computed.getPropertyValue(name)}`).join(";"));

  const sourceChildren = Array.from(source.children);
  const targetChildren = Array.from(target.children);
  for (let i = 0; i < sourceChildren.length; i += 1) {
    inlineComputedStyles(sourceChildren[i], targetChildren[i]);
  }
}

function copyFormState(source, target) {
  if (!(source instanceof Element) || !(target instanceof Element)) return;
  if (source instanceof HTMLInputElement && target instanceof HTMLInputElement) {
    target.checked = source.checked;
    target.value = source.value;
    if (source.checked) target.setAttribute("checked", "checked");
    target.setAttribute("value", source.value);
  }
  if (source instanceof HTMLTextAreaElement && target instanceof HTMLTextAreaElement) {
    target.value = source.value;
    target.textContent = source.value;
  }
  if (source instanceof HTMLSelectElement && target instanceof HTMLSelectElement) {
    target.value = source.value;
  }

  const sourceChildren = Array.from(source.children);
  const targetChildren = Array.from(target.children);
  for (let i = 0; i < sourceChildren.length; i += 1) {
    copyFormState(sourceChildren[i], targetChildren[i]);
  }
}

function renderElementImageDataUrl(element) {
  return new Promise((resolve) => {
    if (!(element instanceof HTMLElement)) {
      resolve("");
      return;
    }
    const rect = element.getBoundingClientRect();
    const width = Math.max(320, Math.min(1200, Math.ceil(rect.width || element.scrollWidth || 800)));
    const height = Math.max(120, Math.min(1800, Math.ceil(rect.height || element.scrollHeight || 300)));
    const clone = element.cloneNode(true);
    inlineComputedStyles(element, clone);
    copyFormState(element, clone);
    clone.style.position = "static";
    clone.style.transform = "none";
    clone.style.width = `${width}px`;
    clone.style.minHeight = `${height}px`;
    clone.style.margin = "0";
    clone.style.background = getComputedStyle(element).backgroundColor || "#fff";

    const wrapper = document.createElement("div");
    wrapper.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
    wrapper.style.width = `${width}px`;
    wrapper.style.minHeight = `${height}px`;
    wrapper.style.padding = "14px";
    wrapper.style.boxSizing = "border-box";
    wrapper.style.background = "#fff";
    wrapper.appendChild(clone);

    const serialized = new XMLSerializer().serializeToString(wrapper);
    const svg = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width + 28}" height="${height + 28}">`,
      `<foreignObject width="100%" height="100%">${serialized}</foreignObject>`,
      "</svg>"
    ].join("");
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth || width + 28;
        canvas.height = image.naturalHeight || height + 28;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(image, 0, 0);
        resolve(canvas.toDataURL("image/jpeg", 0.82));
      } catch {
        resolve("");
      }
    };
    image.onerror = () => resolve("");
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
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

