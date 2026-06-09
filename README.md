# Chaoxing Weixin Study Helper

Chrome/Edge extension plus a local Native Messaging helper for Chaoxing course study workflows. It monitors course videos, can move to the next lesson, sends quiz prompts to Weixin, accepts remote answer commands, supports question screenshots and multimodal explanations, and records wrong questions after submission.

## Structure

- `extension/`: Manifest V3 browser extension.
- `native-host/`: local Node.js helper for Weixin iLink login, messaging, image upload, LLM calls, and `font-cxsecret` decoding.
- `scripts/register-native-host.ps1`: Windows registration script for the Chrome/Edge Native Messaging host.

## Install

1. Install Node.js 22 or newer.
2. Open Chrome/Edge extension management, enable developer mode, and load the `extension/` directory.
3. Copy the extension ID.
4. Register the local helper:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\register-native-host.ps1 -ExtensionId <your-extension-id>
```

For Edge:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\register-native-host.ps1 -ExtensionId <your-extension-id> -Edge
```

## Usage

1. Open the extension popup and check that the local service is available.
2. Generate the Weixin QR code, scan it with mobile Weixin, and confirm login.
3. Fill in the Weixin target ID, for example `xxx@im.wechat`.
4. Configure the LLM API in the popup or remotely from Weixin.
5. Open a Chaoxing course page. The extension monitors videos and quiz frames across iframes.
6. When a quiz is detected, the extension sends the question text and screenshots to Weixin.

Remote Weixin commands:

- `答 1:A 2:BD 3:错`: fill answers on the page.
- `提交`: submit after all questions have been answered.
- `题图 1` or `题图全部`: resend question screenshots.
- `解析 1` or `解析全部`: request learning-oriented explanations.
- `错题` or `错题 10`: view recent wrong-question records.
- `清空错题`: clear the local wrong-question store.
- `配置API minimax <key>`: configure MiniMax Token Plan remotely.
- `配置API 自定义 <endpoint> <model> <key>`: configure a custom OpenAI-compatible API.
- `查看API`: view the current API configuration without exposing the key.

## Features

- Video notifications for pause, ended, stalled, and waiting states.
- Optional next-lesson click and autoplay attempts after a video ends.
- If a video is already completed and no Weixin `提交` command is pending, the extension can still move to the next lesson even when quiz answers have only been sent to Weixin.
- Weixin remote answer filling with validation:
  - single choice accepts one option;
  - multiple choice requires at least two options;
  - true/false accepts `对`/`错` or `A`/`B`;
  - duplicate or non-existent options are rejected.
- Manual submit command; the extension does not submit until it receives `提交`.
- Result-page wrong-question tracking in `chrome.storage.local`, capped at the latest 500 records.
- If submission came from Weixin, the wrong-question summary is sent back to Weixin.
- MiniMax preset support with model discovery via `/v1/models`; the popup warns before switching to a newly discovered model.
- `font-cxsecret` decoding for Chaoxing question text. The extension extracts the page's inline TTF, asks the native host to identify glyphs by path hash, and falls back to screenshots if decoding is unavailable.
- Question screenshots are uploaded through Weixin iLink CDN before sending.

## Limits

- The Weixin target must be an iLink-recognized target ID, usually obtained from an incoming Weixin message context.
- Screenshots require the browser tab to be visible; minimized or covered windows may produce blank or stale images.
- LLM explanations are for learning support only. Prompts instruct the model to explain concepts and reasoning, not to choose answers or complete coursework.
- The extension only fills answers that you explicitly send and only submits after an explicit `提交` command.
- Wrong-question records are local browser data and are not synced by this project.
- Weixin tokens are saved under `native-host/.state/accounts.json`; do not commit or share that file.
- LLM settings are saved under `native-host/.state/llm.json`; do not commit or share that file.

## Native Messaging

After login, the helper sends text and image messages through Weixin iLink APIs. The registered Native Messaging host ID remains:

```text
com.audio_check.weixin_monitor
```

The ID is kept stable so previously registered browser/native-host wiring remains compatible.
