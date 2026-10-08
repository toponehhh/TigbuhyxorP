# GitHub 下载和 Git clone 代理

无第三方依赖，入口为 `main.ts`。部署后，把 URL 中的 `github.com` 换成你的 Deno Deploy
域名，路径和查询参数照旧。

## 部署到 Deno Deploy

1. 将本目录的源码放入自己的 GitHub 仓库。
2. 在 [Deno Deploy 控制台](https://console.deno.com/) 创建应用，选择该仓库。
3. 项目已有 `deno.json` 部署配置：动态应用，入口 `./main.ts`，无需安装依赖或构建。 如果只上传
   `main.ts`，选择 `No Preset`、`Dynamic`，入口填 `main.ts`，安装和构建命令留空。
4. 部署完成后，使用控制台给出的生产域名或你绑定的自定义域名。

当前 Deno Deploy 默认域名形如 `应用名.组织名.deno.net`。下文以 `gh-proxy.example-org.deno.net`
为例，请替换为自己的域名。 参考：[部署步骤](https://docs.deno.com/deploy/getting_started/)、
[源码中的部署配置](https://docs.deno.com/deploy/reference/builds/)、
[域名说明](https://docs.deno.com/deploy/reference/domains/)。

## 用法

### Clone / fetch / pull

```sh
# 原地址：https://github.com/octocat/Hello-World.git
git clone https://gh-proxy.example-org.deno.net/octocat/Hello-World.git

# 也可以浅克隆
git clone --depth=1 https://gh-proxy.example-org.deno.net/octocat/Hello-World.git

# 由这个地址 clone 的仓库，后续 fetch / pull 会继续使用代理
git -C Hello-World fetch origin
```

已有仓库可只修改 origin：

```sh
git remote set-url origin https://gh-proxy.example-org.deno.net/OWNER/REPO.git
```

### 下载单个文件

```sh
# 原地址：https://github.com/octocat/Hello-World/blob/master/README
# blob 链接会转换为原始文件下载，而不是下载 GitHub 的 HTML 页面
curl -fL -o README https://gh-proxy.example-org.deno.net/octocat/Hello-World/blob/master/README
```

`github.com/OWNER/REPO/raw/...` 地址同样支持。原来使用 `raw.githubusercontent.com`
的链接，可使用下面的形式：

```text
https://gh-proxy.example-org.deno.net/__github__/raw.githubusercontent.com/OWNER/REPO/BRANCH/FILE
```

### 下载 Release 附件 / 源码压缩包

```sh
curl -fL -o FILE https://gh-proxy.example-org.deno.net/OWNER/REPO/releases/download/TAG/FILE

curl -fL -o source.zip https://gh-proxy.example-org.deno.net/octocat/Hello-World/archive/refs/heads/master.zip

# 断点续传，是否成功取决于上游文件是否支持 Range
curl -fL -C - -o FILE https://gh-proxy.example-org.deno.net/OWNER/REPO/releases/download/TAG/FILE
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

也可以单独复制脚本运行：`deno run --allow-net main.ts`。

## 工作方式和范围

- 下载响应和 Git 请求/响应使用流式转发，不将整个文件或仓库读入内存。
- 保留 `Range`、条件请求头、文件名、状态码及 Git Smart HTTP 的 `Git-Protocol` 和 POST 请求体。上游的
  404、403 等状态码照常返回。
- 支持公开仓库的 HTTPS clone / fetch / pull 和文件下载。SSH 地址、Git push、Git LFS
  的独立接口不在当前范围内；子模块中记录的 GitHub 地址需要另外改为代理地址。
- 只允许固定的 GitHub 下载域名。不会转发站点 Cookie；客户端传入的 `Authorization` 仅转发到
  `github.com`，不会转发给附件域名。没有内置或保存 GitHub Token。
- 等待上游响应头最多 60 秒；收到响应头后不设置整个下载的时限。连接失败返回 502，等待超时返回 504。
- 加速效果取决于你到 Deno Deploy、Deno Deploy 到 GitHub 的网络，以及部署平台的带宽和额度。
  脚本不保证固定提速，也不实现全站网页资源重写或持久缓存。

Git HTTP 协议参考：[Git Smart HTTP](https://git-scm.com/docs/gitprotocol-http)。
