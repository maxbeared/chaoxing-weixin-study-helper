# 超星微信学习助手

这是一个 Chrome/Edge 扩展和本地 Native Messaging helper，用于辅助超星课程学习流程。它可以监控课程视频、尝试自动进入下一节、把章节习题发送到微信、接收微信远程作答命令、发送题目截图、调用多模态大模型做学习解析，并在提交后记录错题。

## 目录结构

- `extension/`：Manifest V3 浏览器扩展。
- `native-host/`：本地 Node.js helper，负责微信 iLink 登录、消息发送、图片上传、大模型调用和 `font-cxsecret` 字体解码。
- `install.cmd`：Windows 一键安装入口。
- `install.sh`：macOS/Linux 安装入口。
- `scripts/install.ps1`：注册 Native Messaging host、打开扩展管理页；发布包带 native host 二进制时不需要 Node/npm。
- `scripts/register-native-host.ps1`：Windows 下注册 Chrome/Edge Native Messaging host 的脚本。

## 安装

### 发布包安装（推荐）

发布包如果已经包含 `native-host/dist/<平台-架构>/chaoxing-weixin-native-host`，用户电脑不需要安装 Node.js、npm 或其他运行时依赖。

Windows：

1. 双击根目录的 `install.cmd`。
2. 脚本会注册 Chrome/Edge Native Messaging host、打开扩展管理页，并把 `extension/` 路径复制到剪贴板。
3. 在 Chrome/Edge 扩展管理页启用“开发者模式”，点击“加载已解压的扩展程序”，选择 `extension/` 目录。

macOS/Linux：

```sh
sh ./install.sh
```

然后在 Chrome/Edge 扩展管理页启用“开发者模式”，点击“加载已解压的扩展程序”，选择脚本输出的 `extension/` 目录。

> Chrome/Edge 不允许普通脚本静默加载本地未打包扩展，所以最后一步仍需要在扩展管理页点一次“加载已解压”。扩展 ID 已固定，用户不再需要复制 ID 或手动注册 helper。

只注册 Chrome：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Browser Chrome
```

只注册 Edge：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Browser Edge
```

macOS/Linux 对应命令：

```sh
sh ./install.sh --browser chrome
sh ./install.sh --browser edge
```

### 源码安装

如果源码包里没有 `native-host/dist/...` 二进制，安装脚本会自动回退到开发模式，此时需要先安装 Node.js 22 或更新版本。

### 手动注册

一般不需要手动注册。如果你要指定自己的扩展 ID，可以使用：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\register-native-host.ps1 -ExtensionId <你的扩展ID> -Browser Chrome
```

## 构建无依赖发布包

在有 Node.js 22 的构建机上执行：

```sh
cd native-host
npm install
npm run build:native
```

构建完成后，把项目根目录连同 `extension/`、`native-host/dist/`、`install.cmd`、`install.sh` 一起打包发布。用户使用这个发布包安装时不需要 Node/npm。

当前构建脚本会生成：

- `native-host/dist/win-x64/chaoxing-weixin-native-host.exe`
- `native-host/dist/win-arm64/chaoxing-weixin-native-host.exe`
- `native-host/dist/macos-x64/chaoxing-weixin-native-host`
- `native-host/dist/macos-arm64/chaoxing-weixin-native-host`
- `native-host/dist/linux-x64/chaoxing-weixin-native-host`

## 使用

1. 点击扩展图标，确认本地服务可用。
2. 生成微信二维码，用手机微信扫码并确认登录。
3. 填入微信目标 ID，例如 `xxx@im.wechat`。
4. 在弹窗中配置大模型 API，或通过微信远程配置。
5. 打开超星课程页面。扩展会跨 iframe 监控视频和习题页面。
6. 检测到习题时，扩展会把题目文本和截图发送到微信。
7. 扩展只在超星/学银在线相关页面注入；切换到其他标签页后，课程页中的视频监控、远程作答和提交仍会继续处理。

不绑定微信目标 ID 也可以使用本地功能：视频监控、自动下一节、自动播放、题目面板、手动作答和本地错题记录会继续运行；微信通知、题图发送和远程作答命令会自动跳过。

## 微信命令

- `答 1:A 2:BD 3:错`：在页面填入答案。
- `提交`：在所有题目已作答后提交。
- `题图 1` 或 `题图全部`：重发题目截图。
- `解析 1` 或 `解析全部`：请求学习型解析。
- `错题` 或 `错题 10`：查看最近错题记录。
- `清空错题`：清空本地错题库。
- `配置API minimax <key>`：远程配置 MiniMax Token Plan。
- `配置API 自定义 <endpoint> <model> <key>`：远程配置自定义 OpenAI-compatible 接口。
- `查看API`：查看当前 API 配置，不回显 Key。

## 功能

- 视频暂停、结束、卡住、缓冲等待时发送微信通知。
- 已绑定微信目标时，自动切换下一节、切换失败和扩展运行异常会发送微信通知。
- 弹窗支持查看、下载和清空运行日志；native host 日志保存在 `.state/logs/runtime.log` 和 `.state/logs/error.log`。
- 视频结束后可自动点击下一节，并尝试自动播放下一节视频。
- 如果视频已经播放完成，且当前没有微信 `提交` 命令正在等待结果，即使题目答案还只是发送到微信、尚未提交，也会继续进入下一节。
- 微信远程作答带基础校验：
  - 单选题只能提交一个选项；
  - 多选题至少提交两个选项；
  - 判断题支持 `对`/`错` 或 `A`/`B`；
  - 重复选项或不存在的选项会被拒绝。
- 只在收到明确的 `提交` 命令后提交，不会自动提交。
- 提交后扫描结果页，将错题记录到 `chrome.storage.local`，最多保留最近 500 条。
- 如果提交来自微信，会把本次错题摘要发回微信。
- MiniMax 预置支持通过 `/v1/models` 发现新模型；弹窗会提示切换，不会静默切换。
- 支持超星 `font-cxsecret` 字体混淆解码：扩展提取页面内联 TTF，交给 native host 按 glyph path hash 识别文字；解码不可用时回退到题目截图。
- 题目截图通过微信 iLink CDN 上传后发送。

## 限制

- 微信目标 ID 必须是 iLink 能识别的目标，通常来自收到的微信消息上下文，不是普通昵称。
- 截图依赖浏览器标签页可见；窗口最小化或被遮挡时，可能截到空白或过期画面。
- 当课程标签页不在前台时，题图会改用题目 DOM 生成的后台截图；少数跨域图片可能无法完整渲染。
- 大模型解析只用于学习辅助。Prompt 会要求模型讲考点和思路，不直接选择答案或完成作业。
- 扩展只填入你明确回复的选项，只在收到明确 `提交` 后提交。
- 错题库是本地浏览器数据，本项目不会同步这些记录。
- 微信 token 保存在 `native-host/.state/accounts.json`，不要提交或外发。
- 大模型设置保存在 `native-host/.state/llm.json`，不要提交或外发。

## Native Messaging

登录后，helper 通过微信 iLink API 发送文本和图片消息。已注册的 Native Messaging host ID 保持为：

```text
com.audio_check.weixin_monitor
```

这个 ID 保持不变，是为了兼容已经注册过的浏览器和本地 helper 绑定关系。
