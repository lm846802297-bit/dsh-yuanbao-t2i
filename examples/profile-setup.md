# 挂载到 DSH profile（完整示例）

以 Windows + DSH Desktop 为例，profile 目录记作 `<profile>`（本机是 `C:/Users/<你>/.dsh/profiles/desktop`）。

## 1. 放代码 + 装依赖

```bash
cd <profile>/vendor
git clone https://github.com/lm846802297-bit/dsh-yuanbao-t2i.git yuanbao-t2i
cd yuanbao-t2i
npm install          # 只装 patchright@1.62.3；首次运行还会下载 Chromium
```

## 2. 登记到 profile

`<profile>/package.json`：

```json
{
  "dependencies": {
    "dsh-yuanbao-t2i": "link:vendor/yuanbao-t2i"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-yuanbao-t2i"]
    }
  }
}
```

## 3. 链接包目录（Windows junction，等价于 pnpm 的 symlink）

```bat
cd <profile>\node_modules
mklink /J dsh-yuanbao-t2i ..\vendor\yuanbao-t2i
```

Linux/macOS：

```bash
cd <profile>/node_modules && ln -s ../vendor/yuanbao-t2i dsh-yuanbao-t2i
```

## 4. 插件自己的 cordis.patch.yml

包里的 `cordis.patch.yml` 声明插件在层栈里的 id（`package.json` 的 `dsh.bundle.patch` 指向它）：

```yaml
# 把本地维护的元宝文生图插件挂进 profile 层栈
- insert:
    - id: dsh-yuanbao-t2i
      name: 'dsh-yuanbao-t2i'
```

⇒ 宿主半 `lib/plugin.js` 提供 `yuanbao_t2i` 工具，浏览器半 `client.js` 提供设置卡（`dsh.client` 段的 `platform: web` / `immediately: true`）。

## 5. 重载

关掉 DSH Desktop 再打开（或在 **设置 → 插件** 里把本插件关掉再打开）。
**宿主半只在启动时加载一次** ⇒ 改 `lib/*.js` 之后必须重启 DSH 才生效；改 `client.js` 会在下次刷新时重载。

## 6. 验证

1. 会话里让 AI 调用 `yuanbao_t2i`（或直接说「用元宝生图：…」），工具列表里应出现该工具。
2. 首次运行会弹浏览器窗口 → 微信扫码登录一次（登录态存 `~/.dsh/yuanbao-t2i-profile`）。
3. 产物默认落 `~/.dsh/yuanbao-t2i-out/`，每次 4 张 PNG。
4. **设置 → 插件 → dsh-yuanbao-t2i → 生成设置** 里能看到「输出目录 / 自动去水印 / 去水印引擎」。

## 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| 工具列表里没有 `yuanbao_t2i` | `dsh.profile.bundles` 没登记、`node_modules` 里没链接、或没重启 DSH |
| 报 `patchright` 找不到 | 插件目录下没跑 `npm install` |
| 报浏览器 profile 被占用 | 同一 profile 不能双开；插件内部已串行化，但**手动**开着的浏览器要先关 |
| 生成超时 | 元宝出图 20–60s，`timeoutMs` 已给足；网络/风控异常时会卡住，重试或稍等 |
| 网页改版后取不到图 | `lib/generate.js` 里的选择器/SSE 字段按 2026-10 版面写的，需要重新抓一次 |
