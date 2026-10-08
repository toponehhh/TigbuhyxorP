# GitHub 网页、下载和 Git clone 代理

入口为 `main.ts`，使用 `parse5` 解析和改写网页 HTML。部署后，把 URL 中的 `github.com` 换成你的 Deno
Deploy 域名，路径和查询参数照旧。

已部署服务：[ghp.aishow.deno.net](https://ghp.aishow.deno.net/)。下文示例使用这个地址；
自行部署时替换为自己的域名。

## 部署到 Deno Deploy

1. 将本目录的源码放入自己的 GitHub 仓库。
2. 在 [Deno Deploy 控制台](https://console.deno.com/) 创建应用，选择该仓库。
3. 项目已有 `deno.json` 部署配置：动态应用，入口 `./main.ts`，安装和构建命令留空。 Deno
   会解析配置中固定版本的 npm 依赖。请部署完整仓库，包含 `proxy_urls.ts`、
   `web_proxy.ts`、`browser_client.ts`、`deno.json` 和 `deno.lock`。
4. 部署完成后，使用控制台给出的生产域名或你绑定的自定义域名。

当前 Deno Deploy 默认域名形如 `应用名.组织名.deno.net`。
参考：[部署步骤](https://docs.deno.com/deploy/getting_started/)、
[源码中的部署配置](https://docs.deno.com/deploy/reference/builds/)、
[域名说明](https://docs.deno.com/deploy/reference/domains/)。

## 用法

### 浏览公开仓库和 Release 网页

在浏览器中直接打开替换域名后的地址：

```text
https://ghp.aishow.deno.net/intel/AI-Playground
https://ghp.aishow.deno.net/intel/AI-Playground/releases/tag/v3.2.1-beta
https://ghp.aishow.deno.net/toponehhh/TigbuhyxorP/blob/main/main.ts
```

网页中的 GitHub 链接、样式、脚本、图片和 Release 附件列表会经由代理加载。 浏览脚本同时处理
`fetch`、XHR 和动态创建的资源，仓库内的 AJAX 跳转也会改写其 JSON 中的地址。
客户端只需能连接代理域名；代理服务器仍需要能连接 GitHub。

浏览器打开 `blob` 链接时显示代码查看页；curl 等命令行客户端使用同一个地址时继续下载原始文件。
浏览器需要直接下载原始文件时，可以使用 `/OWNER/REPO/raw/BRANCH/FILE` 地址。

当前范围是公开网页浏览。登录、私有仓库的网页会话、Star、提交 Issue 等需要认证或写入的操作不支持；
不会转发站点 Cookie，原站访问统计的 beacon 也不发送。

### Clone / fetch / pull

```sh
# 原地址：https://github.com/octocat/Hello-World.git
git clone https://ghp.aishow.deno.net/octocat/Hello-World.git

# 也可以浅克隆
git clone --depth=1 https://ghp.aishow.deno.net/octocat/Hello-World.git

# 由这个地址 clone 的仓库，后续 fetch / pull 会继续使用代理
git -C Hello-World fetch origin
```

已有仓库可只修改 origin：

```sh
git remote set-url origin https://ghp.aishow.deno.net/OWNER/REPO.git
```

### 下载单个文件

```sh
# 原地址：https://github.com/octocat/Hello-World/blob/master/README
# curl 的 blob 链接会转换为原始文件下载
curl -fL -o README https://ghp.aishow.deno.net/octocat/Hello-World/blob/master/README
```

`github.com/OWNER/REPO/raw/...` 地址同样支持。原来使用 `raw.githubusercontent.com`
的链接，可使用下面的形式：

```text
https://ghp.aishow.deno.net/__github__/raw.githubusercontent.com/OWNER/REPO/BRANCH/FILE
```

### 下载 Release 附件 / 源码压缩包

```sh
curl -fL -o FILE https://ghp.aishow.deno.net/OWNER/REPO/releases/download/TAG/FILE

curl -fL -o source.zip https://ghp.aishow.deno.net/octocat/Hello-World/archive/refs/heads/master.zip

# 断点续传，是否成功取决于上游文件是否支持 Range
curl -fL -C - -o FILE https://ghp.aishow.deno.net/OWNER/REPO/releases/download/TAG/FILE
```

浏览器会自动跟随跳转；curl 使用 `-L`。跳转到 GitHub 的原始文件、Release 附件、codeload
等下载域名时，脚本会把 `Location` 改回代理域名，后续请求继续通过代理。

## 本地运行和检查

在 WSL 的 Linux 终端中安装
[Linux 版 Deno](https://docs.deno.com/runtime/getting_started/installation/)，进入项目目录后执行：

```sh
deno task start
# 本地地址：http://localhost:8000

deno task check
deno task test
```

也可以在完整项目目录运行：`deno run --allow-net main.ts`。

浏览器回归脚本使用 Linux Node.js、Playwright 和 Chromium。在 WSL 中先启动本地代理，再在另一个 WSL
终端运行：

```sh
npm install --prefix /tmp/tigbuh-browser-tests playwright@1.64.0
/tmp/tigbuh-browser-tests/node_modules/.bin/playwright install --with-deps chromium
PLAYWRIGHT_MODULE_PATH=/tmp/tigbuh-browser-tests/node_modules/playwright/index.mjs \
  node scripts/browser_test.mjs http://127.0.0.1:8000
```

脚本阻断所有代理来源以外的浏览器 HTTP(S) 请求，检查 Release 附件、仓库内跳转、代码页和动态图片。
测试报告和截图写入忽略目录 `.tmp/web-proxy/browser-results`。npm、Node.js 和浏览器均需使用 Linux
版本。

## 网页代理本地验证（2026-10-08）

全部检查在 WSL Ubuntu 中执行，验证的是新增网页功能的本地代码：

- 31 项自动测试通过，覆盖 HTML/CSS/JS/JSON 地址改写、同源 CSP、文本验证器及原下载行为。
- Chromium 阻断代理之外的所有 HTTP(S) 请求，Intel Release 页、仓库主页及仓库内 README 跳转、
  本仓库的代码查看页全部通过；没有外部直连、CSP 拦截或 JavaScript 错误。
- 15 项真实 GitHub 下载条件请求检查通过；Release 附件的 Range 续传和完整 SHA-256 校验通过。 Git
  浅克隆、补全历史及 `git fsck --full` 通过。

结果见 [网页代理测试报告](docs/web-proxy-validation-2026-10-08.json)。 该检查验证客户端不依赖 GitHub
直连；上海电信到 Deno 的链路质量和新部署的 CDN 行为仍需线上验证。 匿名访问的可选
`/_global-navigation/payloads.json` 接口仍返回原站 404，已测试的网页内容和跳转正常。

## 部署实测（2026-10-08）

在 WSL Ubuntu 中测试了 `https://ghp.aishow.deno.net/`，被测源码提交为
`95f60e6ca1c96e9fc19a1d4c603ade1dce5de7c3`。 详细请求结果、文件校验和测速数据见
[结构化测试报告](docs/deployment-test-2026-10-08.json)。

- HTTPS、blob/raw 文件、Release 附件和源码 ZIP 下载通过；重定向全程经过代理域名。 文件 SHA-256 和
  ZIP CRC 校验通过。
- Range 返回 206。先下载二进制文件的 65,536 字节，再用 `curl -C -` 补齐到 2,566,310 字节；拼接后的
  SHA-256 与直接下载一致。
- HTTPS 浅克隆、`fetch --unshallow`、完整克隆和不带 `.git` 后缀的仓库地址均通过。 Git
  对象完整性、提交和文件内容校验通过。
- HTTP 检查通过 10/11 项，未通过项是缓存命中时的 ETag 条件请求。

同一份 `ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz`（2,566,310 字节，约 2.45 MiB） 各下载两次：

| 方式        | 平均下载耗时 |
| ----------- | -----------: |
| GitHub 直连 |     3.013 秒 |
| Deno 代理   |     3.354 秒 |

本次 WSL 客户端网络下未观察到提速。这个结果只描述该客户端的两轮测量。

初始部署的缓存异常：相同 ETag 在 GitHub 直连时返回 304；代理命中 CDN 缓存时返回 200，
并重复传输整个文件，响应头为 `Cache-Status: deno; hit`。换用新的查询参数绕开缓存后， 代理返回
304。实测差异指向 Deno CDN 的缓存命中路径；以上结果记录的是初始部署，当前源码采用下述缓存策略。
参考：[Deno CDN 缓存说明](https://docs.deno.com/deploy/reference/caching/)。

## 缓存策略

- 在上游原有 `Vary` 中合并 `If-None-Match`、`If-Modified-Since`、`If-Match`、 `If-Unmodified-Since`
  和 `If-Range`，防止普通下载的 CDN 缓存直接用于带条件的请求。
- 带上述条件头的响应设置 `Deno-CDN-Cache-Control: no-store`，包括上游返回 200、304、206 和 412
  的情况。原始文件下载的条件头交给 GitHub 判断，响应状态和正文照常转发。
- 普通下载仍使用上游缓存策略；保留 `ETag`、`Last-Modified` 和客户端 `Cache-Control`。 上游已有
  `Vary: *` 时保持不变。
- `Vary` 同时合并 `Accept`、`Sec-Fetch-Dest` 和
  `X-GitHub-Proxy-Web`，区分浏览器代码查看页和命令行下载。
- 改写后的 HTML 使用每页脚本 nonce 和同源 CSP，设置浏览器及 Deno CDN `no-store`，移除原站验证器。
  改写后的 JS/CSS/JSON 使用自身内容计算的弱 ETag；匹配时返回 304，HEAD 返回与 GET
  相同的验证器和长度。 原始文件和 Release 附件不参与网页正文改写。

修复已通过 WSL Ubuntu 中的 20 项自动测试和 15 项真实 GitHub HTTP 检查；本地代理的浅克隆、 补全历史和
Git 对象校验通过。这些检查不包含 Deno CDN，部署行为需另外验证。

新部署已在 WSL 中验证：curl 复用 HTTP/2 连接，对同一个 URL 先普通 GET 预热，再带相同 ETag 请求，返回
304 且无正文；弱 ETag、多值和通配符也返回 304。不匹配的 ETag 返回 200，条件响应均绕开 CDN
缓存；之后普通 GET 仍命中 CDN。Range、条件 Range、浅克隆、补全历史和 Git 对象校验通过。 12 项 curl
检查全部通过，结果见 [缓存修复实测报告](docs/cache-fix-validation-2026-10-08.json)。

另一轮 urllib HTTP/1.1 检查中，条件请求、HEAD 和 Range 均与上游一致，但没有观察到普通下载的 CDN
命中。缓存命中会受请求方式和部署节点影响，这两轮结果分别记录在报告中。

## 工作方式和范围

- 下载响应和 Git 请求/响应使用流式转发，不将整个文件或仓库读入内存。
- 保留 `Range`、条件请求头、文件名、状态码及 Git Smart HTTP 的 `Git-Protocol` 和 POST 请求体。上游的
  404、403 等状态码照常返回。
- 支持公开仓库的 HTTPS clone / fetch / pull 和文件下载。SSH 地址、Git push、Git LFS
  的独立接口不在当前范围内；子模块中记录的 GitHub 地址需要另外改为代理地址。
- HTML 使用解析器改写，CSS/JS/JSON 中的 GitHub 资源地址也会改回代理。浏览脚本优先于原站脚本执行，
  CSP 限制资源和动态请求使用代理同源；二进制附件仍然流式转发。
- 只允许固定的 GitHub 及资源域名，包括 GitHub Assets、头像、camo、raw、codeload 和 Release
  附件域名。 不会转发站点 Cookie；客户端传入的 `Authorization` 仅转发到
  `github.com`，不会转发给附件域名。没有内置或保存 GitHub Token。
- 等待上游响应头最多 60 秒；收到响应头后不设置整个下载的时限。连接失败返回 502，等待超时返回 504。
- 加速效果取决于你到 Deno Deploy、Deno Deploy 到 GitHub 的网络，以及部署平台的带宽和额度。
  脚本不保证固定提速，不实现持久缓存。GitHub 更新网页结构或前端接口时，网页改写可能需要同步调整。

Git HTTP 协议参考：[Git Smart HTTP](https://git-scm.com/docs/gitprotocol-http)。
