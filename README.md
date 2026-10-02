# RawTrace MCP

**让 AI 看见网页变化的过程：持续采集，按需回溯。**

Passive browser tracing for coding agents — document baselines, incremental changes, and queryable history.

[English](README.en.md) · [快速开始](#快速开始) · [工具与查询](#工具与查询) · [Trace v2](docs/trace-schema-v2.md) · [安全说明](SECURITY.md)

## 这是做什么的？

RawTrace 是一个本地 MCP 记录器。你的 Playwright 脚本或其他工具负责操作浏览器，RawTrace 通过 CDP 旁路连接选定标签页，持续记录 DOM、表单状态、网络、WebSocket、Cookie、Console 和 iframe 生命周期。

适合排查：一闪而过的提示、偶发自动化失败、异步 DOM 更新、请求与界面状态不一致、登录跳转和 WebSocket 消息时序。采集结束后，可以搜索事件，也可以查询某个时间或事件序号时的页面状态。

```text
Playwright / 其他浏览器工具 ──操作──> 已开启 CDP 的 Chromium
                                        │
                                     RawTrace
                                        │
                          初始基线 → 增量事件 → 检查点
                                        │
                        本地文件 ← MCP 查询 / 历史状态重建
```

- **增量记录**：初始文档保存一份节点树，后续记录节点增删、移动、属性、文本和表单状态变化。
- **可回溯**：刷新或导航建立新基线；检查点缩短历史状态重建所需的增量链。
- **可查询**：按页面、来源、时间、序号、节点或文本检索；支持明确开启的网络 body 文本搜索。
- **持久保存**：NDJSON 分段写入，大内容按 SHA-256 去重；服务重启后仍可查询。
- **范围明确**：只录制显式选择的标签页及其 iframe，不自动跟随弹窗或其他标签页。

网络请求、WebSocket 消息和 Console 日志本身按事件保存，不对它们强行做 DOM diff。重复的消息事件仍保留，只有附件内容去重。

## 版本与安装渠道

| 渠道 | 当前内容 | 使用方式 |
| --- | --- | --- |
| 本仓库 main / 源码 0.4.0 | 新版持续采集，9 个工具，trace v2 | 按下方步骤从源码构建 |
| npm 0.3.0 / v0.3.0 标签 | 旧版浏览器控制与监控接口，trace v1 | 仅用于旧工作流 |
| 插件市场当前固定版本 | 仍指向已发布的 npm 0.3.0 | 尚不提供本文的新版接口 |

**0.4.0 尚未发布到 npm。** 直接执行 `npx rawtrace-mcp` 或从当前插件市场安装，可能得到旧版；要使用本页描述的功能，请先使用源码构建和绝对路径配置。发布新版后再更新市场固定版本。

新版移除了全部 `browser_*`、`monitor_*`、`--tool-profile` 以及 ZIP 导出。旧 trace 不会被修改，但 v2 查询器不重建 v1；旧文件请用 0.3.x 或对应历史版本读取。

## 快速开始

### 1. 获取并构建

需要 **Node.js 22+**。

```sh
git clone https://github.com/ss26367098/rawtrace-mcp.git
cd rawtrace-mcp
npm ci
npm run build
```

### 2. 准备一个可连接的浏览器

如果你的自动化工具已经提供 Chromium CDP 地址，直接使用它，并跳到第 3 步。RawTrace 自身不会启动、导航或关闭浏览器。

没有现成 CDP 浏览器时，可以使用仓库中的独立示例控制器：

```sh
npx playwright install chromium
node examples/browser.mjs http://localhost:3000
```

把 URL 换成你的测试站点，或省略 URL 打开空白页。示例启动一个独立测试 profile，CDP 地址默认为 `http://127.0.0.1:9222`，可通过 `--port 9333` 修改；终端需保持运行。它是外部控制器示例，不是 MCP 工具。

你可以在这个浏览器中手动复现，也可以让现有 Playwright 控制器连接**同一个 CDP 地址**进行操作。两个不同的浏览器实例不会自动共享录制范围。没有暴露 CDP 的内置浏览器不能直接接入。

### 3. 在 MCP 客户端配置本地入口

Codex：编辑 `~/.codex/config.toml`，按实际路径填写：

```toml
[mcp_servers.rawtrace]
command = "node"
args = [
  "/absolute/path/rawtrace-mcp/dist/cli.js",
  "--output-root",
  "/absolute/path/rawtrace-data"
]
startup_timeout_sec = 30
```

Windows 路径可用正斜杠，例如 `C:/Projects/rawtrace-mcp/dist/cli.js` 和 `C:/Data/rawtrace-traces`。使用绝对输出路径，避免重启后因工作目录变化而找不到历史。配置格式参考 [Codex 官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。

也可以通过 CLI 注册：

```sh
codex mcp add rawtrace -- node /absolute/path/rawtrace-mcp/dist/cli.js --output-root /absolute/path/rawtrace-data
```

支持 `mcpServers` JSON 的客户端：

```json
{
  "mcpServers": {
    "rawtrace": {
      "command": "node",
      "args": ["/absolute/path/rawtrace-mcp/dist/cli.js", "--output-root", "/absolute/path/rawtrace-data"]
    }
  }
}
```

重启客户端或新建会话，确认出现下表中的 **9 个工具**。不要同时保留一个提供旧接口的同名插件。stdio 模式由客户端启动，不需要额外在终端启动 MCP 服务。

### 4. 让 Agent 开始采集

可以直接给 Agent 这段提示：

> 我的授权测试浏览器 CDP 地址是 http://127.0.0.1:9222。先列出标签页，只选 URL 为 http://localhost:3000 的页面开启 RawTrace 持续采集。浏览器操作交给原有工具。复现结束后停止采集，检索相关 DOM 和网络事件，并给出关键事件序号及前后页面状态。不要在回复里展示原始凭据。

工具调用顺序：

1. `capture_targets`：传入 `cdpUrl` 和 `acknowledgeRawCapture: true`，取得真实 `targetId`。
2. `capture_start`：传入同一 `cdpUrl`、选定的 `targetIds` 和 acknowledgment。保存返回的 `sessionId`。
3. 用外部工具或手动操作复现问题。期间可调用 `capture_status`。
4. `capture_stop({})`：刷新记录并断开；浏览器保持运行。
5. 用返回的 `sessionId` 查询历史；`trace_state.pageId` 使用之前选定的 `targetId`。

## 工具与查询

| 工具 | 用途 |
| --- | --- |
| `capture_targets` | 发现现有 CDP 浏览器中的页面 |
| `capture_start` | 对明确目标开启一个持续采集会话 |
| `capture_status` | 查看计数、队列、容量及异常状态 |
| `capture_stop` | 停止并落盘，释放连接 |
| `trace_list` | 从输出根目录发现历史记录，包括标注为 legacy 的 v1 |
| `trace_info` | 读取 manifest、检查点和恢复诊断 |
| `trace_events` | 分页检索事件，按需搜索网络 body |
| `trace_state` | 重建指定时刻的节点树或文本及可用 Cookie 状态 |
| `trace_artifact` | 按引用分块读取经完整性校验的附件 |

除 `capture_stop` 外，发现及数据读取工具均要求 `acknowledgeRawCapture: true`。同一服务进程允许一个活动采集会话，该会话可显式选择多个页面。

以下 JSON 是 MCP 工具参数，**不是终端命令**。把占位 ID 换成实际返回值。

**搜索 DOM 变化 — `trace_events`：**

```json
{
  "sessionId": "trace_REPLACE_WITH_SESSION_ID",
  "source": "dom",
  "text": "加载中",
  "afterSeq": 0,
  "limit": 100,
  "acknowledgeRawCapture": true
}
```

**搜索接口响应内容 — `trace_events`：**

```json
{
  "sessionId": "trace_REPLACE_WITH_SESSION_ID",
  "source": "network",
  "urlContains": "/api/profile",
  "text": "unauthorized",
  "searchBodies": true,
  "acknowledgeRawCapture": true
}
```

**重建某一事件之后的页面文本 — `trace_state`：**

```json
{
  "sessionId": "trace_REPLACE_WITH_SESSION_ID",
  "pageId": "REPLACE_WITH_TARGET_ID",
  "atSeq": 120,
  "format": "text",
  "acknowledgeRawCapture": true
}
```

省略 `atSeq` 查询最新已录状态；也可以改用 `atTime`（Unix epoch 毫秒），两者不能同时指定。`format: "tree"` 返回带节点 ID 的结构和表单状态。请同时检查 `complete` 和 `gaps`。

事件每页默认 100 条、最多 1,000 条。若 `hasMore: true`，使用返回的 `nextAfterSeq` 作为下一次的 `afterSeq`。大型查询结果会返回 JSON 附件引用，用 `trace_artifact` 的 `ref`、`offset` 和 `maxBytes` 分块读取；精确拼接二进制内容时使用 `encoding: "base64"`。完整参数和格式见 [Trace v2](docs/trace-schema-v2.md)。

## 可选配置、数据范围与限制

- 各采集种类默认开启，可在 `capture_start` 单独设置 `captureDom`、`captureNetwork`、`captureWebSockets`、`captureCookies`、`captureConsole`、`captureFrames`。
- Cookie 按所选页面所在的**整个共享浏览器上下文**采样：初始基线、每秒差异、停止前最后比较；采样间的快速变化可能漏过。
- 单个网络 body 默认上限为 20 MB，`maxBodyBytes` 可调整；没有会话总容量限制或自动历史清理。磁盘空间需要自行管理。
- DOM 默认在有变化的 60 秒后，或累计 5,000 个增量事件后建立检查点。事件日志按 64 MiB 分段，附件按内容去重。
- 队列、断连和写入失败会报告；并不保证捕获浏览器中所有内部事件。
- 跨域 iframe 的检查点异步补齐；中间时刻查询可能明确返回文档缺失。closed shadow DOM、Canvas/WebGL、CSSOM 动画和视觉回放不在范围内。
- 重建文本是记录的文本节点拼接，不等于浏览器布局后的 `innerText`。时间对齐是估算，事件先后不能直接证明因果关系。

**增量存储不是脱敏。** 基线及变化仍可能包含输入值、密码、Cookie、token、请求体和个人信息。只在授权系统使用，CDP 地址保持私有，不要提交或分享真实 trace。

## 可选 HTTP 接入

```sh
node dist/cli.js --transport http --host 127.0.0.1 --port 3757 --output-root /absolute/path/rawtrace-data
```

客户端连接 `http://127.0.0.1:3757/mcp`。非 loopback 绑定需要 `--unsafe-remote` 和 `--auth-token`。stdio 和 HTTP 是二选一的服务启动方式；它们都需要另外提供浏览器的 CDP 地址。

## 常见问题

| 现象 | 检查方法 |
| --- | --- |
| 仍出现 35/59 个旧工具 | 检查是否仍在使用 npm 0.3.0 或旧插件；改为本地 dist/cli.js 后重启 |
| CDP 连接失败 | 检查浏览器是否运行、端口是否开启；9222 是浏览器端口，3757 是可选 MCP HTTP 端口 |
| 找不到 targetId | 重新调用 capture_targets，标签页关闭重开后 ID 会变化 |
| 找不到历史会话 | 保持同一个绝对 --output-root；trace_list 只发现其下的会话 |
| 不能读取旧 trace | v1 仅列出，不自动转换；使用旧版本读取 |
| 基线缺失或 complete=false | 查看 trace_info / gaps；查询时间可能早于首份基线，或存在导航、iframe、缓冲或断连缺口 |

## 开发与验证

```sh
npm run typecheck
npm run lint
npm test
npm run test:real-run
```

集成测试通过独立 Playwright 浏览器验证记录与重建；real-run 实际调用全部 9 个工具。实现分为 CDP 连接、采集、会话存储、状态重建和 MCP 接口；浏览器脚本本地打包，不加载 CDN。

[贡献指南](CONTRIBUTING.md) · [安全策略](SECURITY.md) · [MIT License](LICENSE)
