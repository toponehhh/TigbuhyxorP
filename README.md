# GitHub 网页、下载和 Git clone 代理

已部署服务：[tigbuhyxorp.pages.dev](https://tigbuhyxorp.pages.dev/)。

默认部署到 **Cloudflare Pages**。把 URL 中的 `github.com` 替换成自己的
`项目名.pages.dev`，路径和查询参数保持不变。 支持公开仓库网页、Release 附件、原始文件、源码压缩包和
HTTPS clone / fetch / pull。

Cloudflare 入口是 `worker.ts`，构建生成 `dist/_worker.js`，使用 Pages Functions
的高级模式接管全部路径。 代理逻辑在 `proxy.ts` 中；生产构建和运行均不需要 Deno，也不需要 GitHub
Token、KV、R2 或数据库。

## 部署到 Cloudflare Pages

### Git 仓库自动部署

1. 在 Cloudflare 的 **Workers & Pages** 中创建 **Pages** 项目，连接本仓库，生产分支选择 `main`。
2. 项目名与 `wrangler.toml` 中的 `name` 保持一致，当前默认是
   `tigbuhyxorp`。若使用其他项目名，请同步修改配置。
3. 使用以下构建设置：

| 设置                   | 值                              |
| ---------------------- | ------------------------------- |
| Framework preset       | None                            |
| Build command          | `npm run build`                 |
| Build output directory | `dist`                          |
| Root directory         | 仓库根目录                      |
| Node.js                | `22.23.3`，已在 `.nvmrc` 中固定 |

Pages 会根据 `package.json` 和 `package-lock.json` 安装依赖。需要手动指定 Node
版本时，设置构建环境变量 `NODE_VERSION=22.23.3`。 部署完成后使用控制台实际给出的
`https://项目名.pages.dev` 地址。下文 `your-project.pages.dev` 仅为示例，并非已部署服务。

这是动态 Pages 项目，请部署完整仓库并执行构建。仅上传原始 `main.ts` 或静态 HTML 无法运行代理。 参见
[Pages 高级模式](https://developers.cloudflare.com/pages/functions/advanced-mode/) 和
[Pages Wrangler 配置](https://developers.cloudflare.com/pages/functions/wrangler-configuration/)。

### 使用 Wrangler 部署

在 WSL 的 Linux Node.js 环境执行：

```sh
npm ci
npx wrangler login
# 首次创建项目时执行；名称应与 wrangler.toml 一致
npx wrangler pages project create tigbuhyxorp --production-branch main
npm run deploy
```

`npm run deploy` 会先构建，再执行 `wrangler pages deploy dist`。首次创建时，Git 集成和 Wrangler
直接上传 是两种项目创建方式，选用其中一种即可；参见
[Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/)。 不要把
Cloudflare API Token 或本地 `.dev.vars` 提交到仓库。

## 用法

### 浏览公开仓库和 Release

```text
https://your-project.pages.dev/intel/AI-Playground
https://your-project.pages.dev/intel/AI-Playground/releases/tag/v3.2.1-beta
https://your-project.pages.dev/toponehhh/TigbuhyxorP/blob/main/proxy.ts
```

页面中的 GitHub 链接、样式、脚本、头像、README 图片及 Release 附件列表均改写为代理地址。
浏览脚本还处理 fetch、XHR、动态资源和仓库内 AJAX 跳转。客户端需要能连接 Pages 域名，Cloudflare
需要能连接 GitHub。

浏览器打开 `blob` 链接时显示代码查看页；curl 等命令行客户端使用同一链接时下载原始文件。
在浏览器中直接下载原始文件，可使用 `/OWNER/REPO/raw/BRANCH/FILE`。

### Clone / fetch / pull

```sh
git clone --depth=1 https://your-project.pages.dev/octocat/Hello-World.git
git -C Hello-World fetch origin

# 已有仓库可修改远端地址
git remote set-url origin https://your-project.pages.dev/OWNER/REPO.git
```

### 下载文件、Release 附件和源码

```sh
curl -fL -o README https://your-project.pages.dev/octocat/Hello-World/blob/master/README
curl -fL -o FILE https://your-project.pages.dev/OWNER/REPO/releases/download/TAG/FILE
curl -fL -o source.zip https://your-project.pages.dev/octocat/Hello-World/archive/refs/heads/master.zip

# 断点续传取决于上游是否支持 Range
curl -fL -C - -o FILE https://your-project.pages.dev/OWNER/REPO/releases/download/TAG/FILE
```

`raw.githubusercontent.com` 的链接使用以下形式：

```text
https://your-project.pages.dev/__github__/raw.githubusercontent.com/OWNER/REPO/BRANCH/FILE
```

原始文件、Release 和 codeload 跳转会改写 `Location`，后续请求继续通过代理。

## 本地开发和验证

所有项目构建与调试都在 **WSL/Linux** 中执行，使用 Linux 版 Node.js 22.18 或更新版本：

```sh
npm ci
npm run check
npm test
npm run test:runtime
npm run dev
# Pages 本地地址：http://127.0.0.1:8788
```

- `npm test`：既有网页、下载、Git 和 Cloudflare 适配测试。
- `npm run test:runtime`：先构建，再使用与 Wrangler 相同版本的 Miniflare/workerd
  验证压缩、ETag、Range、 Git POST 及 160 MiB 流式下载，不访问真实 GitHub。
- `npm run dev`：构建后运行 `wrangler pages dev dist`，可访问真实 GitHub 上游。

浏览器回归同样在 WSL 运行。在另一个终端安装 Linux Playwright/Chromium 后：

```sh
npm install --prefix /tmp/tigbuh-browser-tests playwright@1.64.1
/tmp/tigbuh-browser-tests/node_modules/.bin/playwright install --with-deps chromium
PLAYWRIGHT_MODULE_PATH=/tmp/tigbuh-browser-tests/node_modules/playwright/index.mjs \
  node scripts/browser_test.mjs http://127.0.0.1:8788
```

脚本阻断代理以外的全部浏览器 HTTP(S) 请求，验证 Release 附件、仓库内 README 跳转、代码页和动态图片，
并把报告和截图写入 `.tmp/web-proxy/browser-results`。

旧 `main.ts`、`deno.json` 和 `deno.lock` 仅保留为可选的 Deno 本地入口，不参与 Pages 构建。

## Cloudflare 缓存与压缩

- 原始文件和 Git 二进制数据流式转发，保留 Range、ETag、文件名、Git-Protocol 和 POST 请求体。
- 保留浏览器的原站 Cache-Control。代理响应设置 Cloudflare-CDN-Cache-Control 和 CDN-Cache-Control 为
  no-store， 每次请求进入代理，避免混用 blob 网页与 raw 文件，或在边缘跳过条件判断。
- 普通上游 GET 可使用 Cloudflare 的子请求缓存；条件请求、Range、HEAD、认证和 Git POST 使用 fetch 的
  no-store。
- HTML 使用同源 CSP 和每页 nonce，不缓存。改写后的 JS/CSS/JSON 使用自身内容计算的弱 ETag，匹配时返回
  304。
- Workers 的未修改压缩响应保留 Content-Encoding；改写正文后移除旧编码和长度。不会套用 Deno fetch
  自动解压的假设。
- 若 Cloudflare 上游返回压缩的 206，代理会重新获取完整文件并返回
  200，避免无法独立解压的片段被误当成原文件字节。 此时客户端应完整下载；未压缩附件的 206
  和断点续传照常转发。

参见 [Workers fetch 与压缩](https://developers.cloudflare.com/workers/runtime-apis/fetch/) 和
[流式转发](https://developers.cloudflare.com/workers/runtime-apis/streams/)。

## 范围与验证边界

支持公开网页浏览和 HTTPS 下载。登录会话、Star、提交 Issue、Git push、SSH、Git LFS 独立接口不支持；
子模块中的原 GitHub 地址需要另外替换。只接受固定 GitHub 资源域名，不转发站点 Cookie； Authorization
仅发给 github.com，不发给附件和静态资源域名。原站统计 beacon 不发送。

等待上游响应头最多 60 秒，收到响应头后继续流式传输。连接失败返回 502，响应头等待超时返回 504。 网页
HTML/CSS/JS/JSON 需要改写，二进制下载不整体缓冲。实际访问效果受客户端到 Cloudflare、 Cloudflare 到
GitHub 的链路及
[Pages Functions / Workers 配额](https://developers.cloudflare.com/workers/platform/limits/) 影响。
本地 workerd 通过并不代表已在 Cloudflare 上线，也不代表已经验证上海电信链路或线上 CDN。

2026-10-23 的 Cloudflare 迁移检查已在 WSL 中通过：36 项自动测试、7 项 workerd 集成测试、 3
个阻断外部直连的浏览器页面测试、15 项真实 GitHub 下载检查，以及附件续传和 Git clone/fetch/fsck。
详情见 [Cloudflare Pages 本地验证报告](docs/cloudflare-pages-validation-2026-10-23.json)。

旧 Deno 部署的历史测试记录仍保留： [下载与 Git](docs/deployment-test-2026-10-08.json)、
[ETag 缓存修复](docs/cache-fix-validation-2026-10-08.json)、
[网页代理](docs/web-proxy-validation-2026-10-08.json)。这些报告不代表 Cloudflare 部署验证。
