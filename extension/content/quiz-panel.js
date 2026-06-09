// Page panel and bootstrap.
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

