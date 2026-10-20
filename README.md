# dsh-yuanbao-t2i

[DSH](https://github.com/deepseek-ai)（DeepSeek Harness）本地插件：用**腾讯元宝网页版**（混元 Hy Image）文生图，一次 4 张 PNG 直接落盘，并可在插件设置卡里选择是否去水印、用哪个去水印引擎、图片存到哪个目录。

> ⚠️ **性质说明**：本插件通过 [patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) 驱动真实浏览器登录元宝网页版，复用**你自己账号**的会话。请自行评估账号风险（频繁调用、自动化行为可能触发平台风控），并遵守腾讯元宝的服务条款。作者不对账号受限、图片内容或版权负责。

![去水印效果：左＝元宝原图（右下角水印），右＝开启 removeWatermark 且引擎为 LaMa](docs/watermark-before-after.jpg)

<sub>上半＝整图对比，下半＝右下角 2× 放大。默认**不去水印**；开启后可去掉右下角「元宝 AI生成」，但放大仍能看到轻微平滑／修补痕（纸纹、白底类画面更明显）——所以默认关。</sub>

## 它做什么

- 工具名 `yuanbao_t2i`：传中文提示词 → 弹出/复用浏览器 → 走 `yuanbao.tencent.com` 的 `/api/chat/` SSE，从 `type=replace` 帧的 `multimedias[]` 取图 → 裸 `fetch` 下载 → 落盘 PNG。
- 首次使用需**微信扫码登录**一次，登录态存在本地 profile 目录，之后复用。
- 同一个 profile 不能被两个浏览器同时打开，所以插件内部把所有调用**串行化**。
- 右下角「元宝 AI生成」水印可选去除：`lama`（Big-LaMa 深度模型，默认，质量好、慢）或 `telea`（OpenCV，快、痕迹明显）。**默认不去水印**——实测 LaMa 在纸纹/白底图上仍有轻微平滑痕，看用途决定。

## 示例

| 文件 | 内容 |
| --- | --- |
| [`examples/prompts.md`](examples/prompts.md) | 提示词模板：场景 BG / 角色立绘 / CG / 水彩 / 图标，含「加什么词能得到什么」对照 |
| [`examples/profile-setup.md`](examples/profile-setup.md) | 挂载到 DSH profile 的完整步骤（package.json、junction、cordis.patch.yml、验证与排错） |
| [`examples/settings.json`](examples/settings.json) | 插件设置文件（`~/.dsh/yuanbao-t2i-config.json`）示例 |

## 安装（DSH 本地插件）

插件是 DSH 的 **bundle + dual-face 包**（宿主半 `lib/plugin.js`，浏览器半 `client.js`）。装法：

1. 把本仓库放到 DSH profile 的 `vendor/` 下，例如
   `C:/Users/<你>/.dsh/profiles/desktop/vendor/yuanbao-t2i`
2. 装依赖：`npm install`（只依赖 `patchright@1.62.3`；首次运行会自行下载 Chromium）
3. 在 profile 的 `package.json` 里登记依赖与 bundle：
   ```json
   {
     "dependencies": { "dsh-yuanbao-t2i": "link:vendor/yuanbao-t2i" },
     "dsh": { "profile": { "bundles": ["dsh-yuanbao-t2i"] } }
   }
   ```
4. 把包链接进 profile 的 `node_modules`（Windows 可用 junction）：
   `mklink /J node_modules\dsh-yuanbao-t2i ..\vendor\yuanbao-t2i`
5. 重启 DSH Desktop（或在 Settings → Plugins 里把本插件关掉再打开）让它加载新的宿主半和浏览器半。

## 用法

在会话里直接让 AI 调用工具：

```
用元宝生图：一座哥特式教堂，雨夜，雾气，油画质感，竖构图
```

工具参数：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `prompt` | string（必填） | 中文提示词，越具体越好（主体+动作+环境+风格+构图） |
| `outDir` | string | 保存目录；不传＝用插件界面的「输出目录」，界面留空则用默认 `~/.dsh/yuanbao-t2i-out` |
| `removeWatermark` | boolean | 是否去水印；不传＝用插件界面开关。开启后产物写 `<outDir>/clean/`，原图保留 |
| `wmEngine` | `lama` \| `telea` | 去水印引擎（仅去水印时生效）；不传＝用插件界面设置 |

返回：图片绝对路径列表 + 原始（未去水印）路径。

## 插件界面（设置卡）

DSH **设置 → 插件 → dsh-yuanbao-t2i → 生成设置**：

- 输出目录（留空＝默认）
- 生成后自动去水印（开/关）
- 去水印引擎（Big-LaMa / OpenCV）
- 保存

设置存在 `~/.dsh/yuanbao-t2i-config.json`，由宿主的 `GET|POST /yuanbao-t2i/config` 路由读写（loopback only）。

## 环境变量

去水印相关的解释器/脚本默认值会自动探测，也可显式指定：

| 变量 | 作用 |
| --- | --- |
| `DSH_YUANBAO_PROFILE` | 浏览器 profile 目录（默认 `~/.dsh/yuanbao-t2i-profile`） |
| `DSH_YUANBAO_SETTINGS` | 设置文件路径（默认 `~/.dsh/yuanbao-t2i-config.json`） |
| `DSH_WM_PYTHON` | `telea` 引擎用的、装了 `opencv-python` 的 Python |
| `DSH_WM_SCRIPT` | `clean_watermark.py` 路径（telea 引擎） |
| `DSH_LAMA_PYTHON` | `lama` 引擎用的、装了 `torch` + `simple-lama-inpainting` 的 Python |
| `DSH_WM_ROI` | 水印区域 `x0,y0,x1,y1`（比例，默认 `0.71,0.878,0.992,0.996`；元宝改版面时改这个） |

### 去水印引擎的额外依赖（可选，只在开启去水印时需要）

- `lama`：`pip install torch simple-lama-inpainting`（首次运行会下载 Big-LaMa 权重 ~196MB；有 GPU 则 GPU 推理，约 3–8 秒/张）
- `telea`：一个装了 `opencv-python` 的解释器 + 本仓库之外提供的 `clean_watermark.py`

不开去水印则**不需要**上述任何东西，插件只依赖 patchright。

## 已知限制

- 一次固定 4 张图，尺寸随元宝返回（实测 1248×1872 / 1344×1792），单张 3MB 左右。
- 水印 ROI 按 2026-10 的版面量得（默认 `x 0.710–0.992, y 0.878–0.996`，只包住文字本体）；元宝改版面后需重新量，或用环境变量 `DSH_WM_ROI` 覆盖。
- 只做文生图；图生图/编辑类接口未实现。
- LaMa 修复在白色背景 + 细纸纹图上仍可能留下轻微平滑痕——这也是「默认不去水印」的原因。

## License

MIT
