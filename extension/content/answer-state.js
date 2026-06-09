// Answer application and wrong-question recording.
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

