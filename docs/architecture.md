# Architecture

This project has two runtime boundaries:

- `extension/`: the Manifest V3 browser extension.
- `native-host/`: the Node.js Native Messaging host used by the extension.

## Extension

- `extension/manifest.json`: browser permissions, content script matches, popup entry, and service worker entry.
- `extension/background/background.js`: extension service worker. It receives content-script and popup messages, applies notification cooldown rules, captures visible tabs, writes extension logs, and forwards Native Messaging calls.
- `extension/content/state.js`: shared content-script constants and runtime state.
- `extension/content/runtime.js`: settings loading, extension messaging, runtime logs, and error reporting.
- `extension/content/video.js`: video monitoring, auto-next, and autoplay.
- `extension/content/quiz-extraction.js`: Chaoxing quiz DOM extraction and `font-cxsecret` decoding.
- `extension/content/image-rendering.js`: extension/native messaging helpers and question image rendering.
- `extension/content/remote-commands.js`: Weixin command parsing.
- `extension/content/weixin-delivery.js`: Weixin text/image delivery, screenshots, and LLM explanation handlers.
- `extension/content/answer-state.js`: answer validation/application and wrong-question recording.
- `extension/content/remote-bridge.js`: remote submit state, message polling, and quiz bridge.
- `extension/content/quiz-panel.js`: injected quiz helper panel.
- `extension/content/content.js`: small bootstrap that wires listeners and starts scanning.
- `extension/popup/popup.html`: extension popup markup.
- `extension/popup/popup.css`: popup styles.
- `extension/popup/popup.js`: popup controller for settings, Weixin login, LLM configuration, message polling, and logs.

## Native Host

- `native-host/host.mjs`: stable compatibility entry used by install scripts, Native Messaging manifests, and `npm start`.
- `native-host/src/host.mjs`: native host implementation. It handles the Native Messaging protocol, Weixin iLink login/send/poll APIs, image uploads, `font-cxsecret` decoding, LLM settings and calls, and host logs.
- `native-host/run-host.cmd` and `native-host/run-host.sh`: development wrappers that execute the compatibility entry.
- `native-host/.state/`: runtime state written locally by the native host. Do not commit this directory.

## Install Scripts

- `install.cmd` and `install.sh`: user-facing install entrypoints.
- `scripts/install.ps1`: Windows install orchestration.
- `scripts/register-native-host.ps1`: browser Native Messaging manifest registration.
