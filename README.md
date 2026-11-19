# dsh-image-gen

让 AI 在**对话里直接出图**、让**你在面板里管图和参数**的 DSH 插件 v0.2。

用户说「画一只戴耳机看雨的猫」，模型调 `image_generate` 就出图：图片直接出现在对话里，
同时落盘到本机，并附一份 sidecar 元数据（提示词 / 模型 / 尺寸 / 耗时），之后能在画廊里
回看、复用提示词、或把那张图再拿去改。

参考「生图工作台」的配置模型：**接入点（Base URL + API Key + 端点 + 协议形态）→ 模型
（模型 ID + 能力 + 模板 + 取值路径 + 自定义声明）**，所以 OpenAI 官方、DashScope 原生、
日日新、以及 lk888 这类异步任务站都能接。

## 装完怎么用

1. 侧边栏「生图」面板 → **接入点与模型** → 新建接入点（Base URL + API Key）。
2. 加一个模型（模型 ID 必须与服务商给的完全一致）。
3. 点「探活」（免费）确认地址与密钥；点「测试」真发一次确认能出图。
4. 回对话里说「画一张…」，或者直接在面板「生成」页出图。

也可以直接跟 AI 说「加一个接入点，Base URL 是 …，Key 是 …」，模型会用 `image_admin`
写配置。**密钥永远只回显首尾四位**，别让它写进对话正文。

## 三个工具

| 工具 | 作用 |
|---|---|
| `image_generate` | 文生图 / 改图。不给 `images` 走生图端点；给了参考图走改图端点。图片落盘并作为 image block 回传——**模型自己看得见刚生成的图**。 |
| `image_config` | **只查询**：`list` / `models` / `guide` / `gallery` / `gallery.delete`。schema 只有几百字符，可以随便调。 |
| `image_admin` | **改配置**：`provider.*` / `model.*` / `model.discover` / `default.set` / `test` / `probe` / `template.check`。 |

> 为什么拆两个：配置类参数（baseUrl / apiKey / bodyTemplate / resultPath …）加起来 3.5K 字符，
> 而日常只用得上 `list` / `models` / `gallery`。拆开后 `image_config` 的常驻开销从 4075 字符降到 653。

`models` 的两个行为：

- **不传 `caps` 就同时列「生图」和「改图」两栏**。以前默认只列生图，只标了 `caps=edit` 的模型会完全看不见。
- 每个模型行尾标 `caps=`，`caps=both` 的会在两栏各出现一次（是同一个模型，不是重复配置）。

`image_admin` 里两个容易混的 op：

- `probe`：`GET {baseUrl}/models`，**免费**，只证明「地址 + 密钥」可用。
- `test`：真发一次最小生成请求，**会产生少量费用**，能验证模型名与出图解析。

### 参考图有三种来源

`images` 的每一项可以是：

| 写法 | 含义 |
|---|---|
| `D:\图片\ref.png` | 本机图片路径（相对路径按 cwd 解析） |
| `https://…/ref.png` | 远程图片地址（要求接口能取到，或配模板走 JSON 协议） |
| `@last` | **对话里最近的一张图**（你刚发的，或上一轮刚生成的） |

`@last` 是 v0.2 的关键能力：它把「对话里那张图」经附件服务读出来、写成本机临时文件，
再当普通参考图走，所以**连续改图不需要手工存文件**。要更早的图用 `@last:2`。

> 改图时**不传 `ratio` / `size` / `resolution` 就沿用参考图的比例**（按对数距离吸附到最近的标准画幅）。
> 2687×1500 的参考图会走 16:9，而不是被默认压成 1:1 把人拉变形。要覆盖就显式传 `ratio`。

> 拿不到图时会直接报错，不会静默退化成文生图——否则会白花一次钱，而你以为在改图。

## 让模型自己挑模型（自定义声明）

每个模型可以写一份「自我介绍」，`image_generate` 和 `op=models` 会把它交给模型，
模型就能按需求在多个模型之间挑，而不是永远用默认那个。

| 字段 | 作用 |
|---|---|
| `summary` | 一句话说明能干嘛、擅长什么，如「出静态插画，擅长写实人像；不支持改图」 |
| `notes` | 细节：尺寸限制、速度、已知坑、适用场景 |
| `costHint` | 费用提示，如「按次计费 · 约 0.2 元/张」，帮模型权衡要不要多出几张 |
| `formats` | 产出格式：`png` / `jpeg` / `webp` / `gif` / `svg` |

`formats` 对回传方式有实际影响：声明或实际产出 `svg` 时，宿主显示不了矢量图，
插件会把 SVG 源码按文本内联进回执（模型能读、能判断对不对），其余格式作为图片块显示。

## 参数

`image_generate`：`prompt`（必填）、`model`、`ratio`+`resolution` 或 `size`、`quality`、
`format`、`background`、`n`（1–4）、`images`、`mask`、`negative`、`seed`、`strength`、`saveTo`。

`saveTo` 只是**额外导出**：图片主副本永远落在插件画廊目录（`$DSH_HOME/dsh-image-gen/images/`，
或用 `outputDir` 覆盖的那个目录），所以调用时传了 `saveTo` 也一定能在「作品」页回看；
填了 `saveTo` 才会再复制一份到指定目录。**这一点是 v0.2.1 修的关键 bug**：旧版让 `saveTo`
直接顶替了落盘目录，AI 在对话里出图时随手带上 `saveTo`，图就存到了画廊扫不到的地方，
于是「对话里有图、作品里是空的」。

- `ratio` × `resolution` 按**面积恒定**查表：1K ≈ 1024²、2K ≈ 2048²、4K ≈ 3840×2160，
  16:9 的 4K 正好 3840×2160。可用接入点全局 `sizes` 或模型级 `sizes` 覆盖。
- 模型设了 `maxSide` 时会**等比缩小**请求尺寸，而不是让接口报错。
- **`format` 默认 `png`**：不传就是静图。`gif` 是动图，**必须显式要**才会出——
  即使模型的 `extra` 里钉死了 `output_format: "gif"` 也一样（那是模型的「可产出格式」，
  不是「默认行为」）。出静图时还会自动摘掉 `frame_count` / `frame_duration_ms` 这类
  动图专用参数，否则站点仍会当成要出 GIF。
- **显式参数优先于 `extra`**：调用时传了 `size` / `ratio` / `resolution` / `quality` / `format`，
  就以调用方为准；`extra` 只补没人指定的项。旧版是 `Object.assign(extra)` 打底，
  等于模型配置里钉死的值永远赢——于是「要 16:9 出方图」「要静图出动图」这类问题
  静默发生，回执里写的还是你要求的参数。
- `negative` / `seed` / `strength` / `mask` 只有模型配了请求体模板才会发出去
  （占位符 `{{negative}}` / `{{seed}}` / `{{strength}}` / `{{mask}}`）——OpenAI 官方
  接口对未知字段直接 400，所以默认协议里不带它们。

## 接入新模型：写配置，不改代码

这是本插件最核心的设计目标 —— **底座与模型解耦**。

以前接一个非 OpenAI 站点只有两个选择：要么吃下插件硬编码的 OpenAI 字段（站点不认识就报错），
要么写一整份 `bodyTemplate` 把请求体推倒重来。中间那层是空的，于是每接一个新模型都要改代码。

现在中间那层叫**参数声明表**（`models[].params`）：模型自己说它要什么参数，插件照着构造请求体。

### 一个完整例子

小梦（lk888）的 `tt-image-2.6`：统一端点 `/v1/media/generate`，私有参数 `version` / `quality` / `complexity`。

```json
{
  "model": "tt-image-2.6",
  "caps": "both",
  "bodyMode": "minimal",
  "imagePayload": "objects",
  "endpoints": { "generate": "/media/generate", "edit": "/media/generate" },
  "params": {
    "version":       { "type": "enum", "values": ["flare", "sunburst"], "default": "flare", "label": "版本" },
    "quality":       { "type": "enum", "values": ["low", "medium", "high"], "default": "medium", "label": "画质" },
    "complexity":    { "type": "int", "min": 1, "max": 3, "default": 2, "label": "复杂度" },
    "size":          { "type": "string", "from": "size" },
    "output_format": { "type": "enum", "values": ["png", "gif", "svg"], "default": "png", "from": "format", "at": "params" }
  }
}
```

配完这一段，**面板上就会自动出现「版本 / 画质 / 复杂度」三个真实控件**，
AI 也通过 `image_config op=models` 知道可以传 `params={"version":"sunburst"}`。
代码一行没动。

### 声明怎么写

四种写法，从简到全：

```json
"params": {
  "version": "sunburst",                          // 固定值：调用方改不了（钉死）
  "quality": ["low", "medium", "high"],           // 简写：数组即枚举，第一个是默认
  "complexity": { "type": "int", "min": 1, "max": 3, "default": 2, "label": "复杂度" },
  "output_format": { "type": "enum", "values": ["png","gif"], "from": "format", "at": "params" }
}
```

每个声明支持的字段：

| 字段 | 作用 |
|---|---|
| `type` | `string` / `int` / `number` / `bool` / `enum`（省略时按 default 或 values 推断） |
| `values` | enum 的值域 |
| `min` / `max` | 数值范围 |
| `default` | 默认值。不给就是「不传」 |
| `label` | 面板上显示的中文名，不填就用参数名 |
| **`from`** | **由哪个通用参数驱动**：`prompt` / `model` / `n` / `size` / `quality` / `format` / `background` / `seed` / `strength` / `negative` / `ratio` / `resolution` |
| `at` | 放进哪个容器：默认顶层；`params`、`input.parameters` 这类点路径会逐层建对象 |
| `lock` | `true` = 即使调用方传了也不覆盖 |
| `send` | `always`（总是发）/ `when-set`（有值才发，默认） |
| `transform` | 取值变换：`star`（`1024x1024`→`1024*1024`）/ `int` / `number` / `string` / `bool` / `upper` / `lower` / `dims` |

**`from` 是这一层最关键的东西**：它把插件的通用参数翻译成站点的私有参数名。
用户选「GIF」时，`format` 变成 `gif`，再自动写进站点认识的 `params.output_format` ——
用户不用知道站点管它叫什么。

### 三个配套字段

| 字段 | 作用 |
|---|---|
| `bodyMode` | 请求体骨架。`openai`（默认，带 model/prompt/size/quality/n）/ `minimal`（只带 model/prompt/n）/ `custom`（全交给 params） |
| `imagePayload` | 参考图装载形态。`objects`（`[{"image_url":…}]`，默认）/ `urls`（`["…"]`）/ `image_strings`（`image:["…"]`，字段名单数）/ `image`（单图对象） |
| **`endpoints`** | **模型级端点覆盖** `{"generate":…, "edit":…}`。解决「同一个 key 下不同模型认不同端点」 |

### 同一家站点的三种形态（实测）

小梦（lk888）一家就有三种不同约定，正好说明为什么需要这些字段：

| 模型 | 端点 | 参考图字段 | 私有参数 |
|---|---|---|---|
| `tt-image-2.6` | `/media/generate` | `images: [{image_url}]` | `version` / `quality` / `complexity` |
| `tt-image-2.5` | `/images/edits`（multipart） | 文件字段 | `version` / `quality` |
| `tt-image-2` | `/media/generate` | **`image: ["字符串"]`** | 不校验 |

三个模型全部跑通，代码没有为任何一个写特例 —— 差异全在配置里。

### 为什么 `endpoints` 是必需的

这正是 `gpt-image-2.6` 之前「不能改图」的根因：

- 小梦是**统一端点**站：所有图像模型都走 `/v1/media/generate`，生图/改图靠「请求体里有没有 `images`」区分
- 但插件按 OpenAI 的双端点（`/images/generations` + `/images/edits`）设计，而**端点挂在接入点上**
- 2.6 不认 `/images/*`，直接 400 → 被当成「不支持改图」→ `caps` 降成 `generate` → 从此连试都不试
- 2.5 恰好认 `/images/edits`，所以同一个接入点下 2.5 正常、2.6 挂掉

端点下沉到模型之后，这个表达不出来的差异就能写出来了。`model.discover` 导入时会自动识别统一端点站
并预填 `endpoints` 与 `editJson`，不用手工配。

### 一条命令接完一个模型

```bash
image_admin op=model.add providerId=p_xxx name="某模型" model="site-model-id" \
  bodyMode="minimal" endpoints='{"generate":"/media/generate","edit":"/media/generate"}' \
  params='{"version":["a","b"],"quality":["low","high"],"output_format":{"from":"format","at":"params"}}'
```

面板里也有对应界面：模型表单里的「模型私有参数」是一个真正的行编辑器
（参数名 / 类型 / 可选值 / 最小 / 最大 / 默认 / 显示名 / 跟随），不用手写 JSON。

## 接入非 OpenAI 协议（请求体模板）

参数声明表搞不定的极端协议（比如请求体形状完全不是扁平的），再用模板。
给模型填**请求体模板**，整个请求体按模板拼。可用占位符：

`{{prompt}}` `{{negative}}` `{{model}}` `{{n}}` `{{size}}` `{{size_star}}` `{{quality}}`
`{{ratio}}` `{{resolution}}` `{{background}}` `{{seed}}` `{{strength}}` `{{mask}}`
`{{images}}` `{{image_blocks}}` `{{image_urls}}`

`{{image_blocks}}` 自带尾随逗号、无参考图时展开为空，所以同一个模板既能生图也能改图。
保存前会用「0 张参考图」「2 张参考图」各渲染一遍校验，两遍都必须是合法 JSON；
面板上有「校验模板」按钮，工具里有 `op=template.check`。

填充时按占位符的**位置**决定要不要转义：落在 JSON 字符串里的（`"prompt":"{{prompt}}"`）
会按 JSON 字符串规则转义，提示词里的换行、引号、反斜杠不会把请求体拼坏；落在字符串外的
（`"n":{{n}}`、`"images":{{image_urls}}`）原样插入，数字和数组保持原有类型。
所以多行提示词可以直接写，不用手动压成一行。

> 三条通路的优先级：**参数声明（有 `params` 时）> 请求体模板（有 `bodyTemplate` 时）> OpenAI 默认协议**。
> 三者可共存，但只用最高优先级的那条；没配的模型行为与以前完全一致。

面板内置几个模板预设（DashScope 原生、日日新 SenseNova、通用 JSON、SD WebUI 风格），
选一个再改。

阿里 DashScope 原生：

```json
{"model":"{{model}}","input":{"messages":[{"role":"user","content":[{{image_blocks}}{"text":"{{prompt}}"}]}]},"parameters":{"prompt_extend":true,"n":{{n}},"size":"{{size_star}}","watermark":false}}
```

日日新 SenseNova 改图：

```json
{"model":"{{model}}","prompt":"{{prompt}}","n":{{n}},"size":"auto","images":{{image_urls}},"watermark":false,"response_format":"b64_json"}
```

配了模板后，**结果取值路径**也常需要填，例如
`output.choices[0].message.content[0].image`。留空则在响应里自动嗅探。

### 结果取值路径的语法

- `a.b[0].c` —— 逐层取
- `output.results[].url` —— **展开**数组，把所有 url 收成图片列表（`n>1` 时不会只拿一张）
- `data.result_url,data.url` —— 逗号分隔多个候选，按顺序取第一个有结果的

### 异步任务接口（先提交再轮询）

很多中转站不是 OpenAI 的同步协议。把接入点设成 `taskMode: poll`，再填：

| 字段 | 含义 |
|---|---|
| `statusPath` | 状态查询端点，默认 `/media/status`，会拼 `?task_id=…` |
| `taskIdField` | 从提交响应里取 task_id 的点路径，默认 `data.task_id` |
| `resultUrlsField` | 从轮询响应里取图片地址的点路径，默认 `result_url` |
| `pollIntervalMs` / `pollTimeoutMs` | 轮询间隔 / 总超时 |

状态字段支持 `state` / `status` / `data.status` 三种拼法，大小写不敏感；失败态
（failed / error / cancelled / expired）会立刻中止而不是等到超时。

## 面板三页

| 页 | 能做什么 |
|---|---|
| 生成 | 提示词（Ctrl+Enter 生成）、模型下拉、画幅 × 分辨率 × 张数、参考图芯片（可加路径 / `@last` / 从画廊「参考」）、高级选项（反向提示词、种子、保存目录）、本次结果可「全部作为参考图」。 |
| 画廊 | 按提示词 / 模型过滤、点图看详情（提示词 / 模型 / 尺寸 / 耗时）、复制提示词、拿去再生成、作为参考图、下载、删除。 |
| 接入点与模型 | 接入点增删改（含协议形态、自定义请求头）、免费的「探活」与收费的「测试」、模型增删改（含模板预设、模板校验、取值路径、声明、extra、尺寸覆盖）、默认模型、元数据开关。 |

## 数据与安全

- 接入点、模型与 API Key 存在 `$DSH_HOME/dsh-image-gen/config.json`（0600，仅本机），
  **不写进** `cordis.patch.yml`（那是可分享、可提交的装配层）。
- 生成的图片存在 `$DSH_HOME/dsh-image-gen/images/`（配置了 `outputDir` 则改到那里），
  同名 `.json` 记录提示词与参数。落盘目录、画廊列表、取图/删图路由统一走
  `store.galleryDir()`，不会各处各算一遍。
- `image_generate` 的 `saveTo` 只做额外复制，主副本始终在画廊目录。
- 面板读写的是脱敏后的密钥；整体写回时按 id 把真密钥补回去，不会用掩码覆盖真值。
- 图与元数据的读取路由只接受画廊目录下的相对文件名（拒绝 `..` 与绝对路径）。
- `@last` 把对话里的图写到 `$DSH_HOME/dsh-image-gen/cache/` 下再当参考图用，不经过网络。
- 生成请求会产生接口费用；插件**不做自动重试**，避免重复扣费。
- 面板开着时会每 5 秒静默同步一次作品列表（切到后台就停），所以 AI 在对话里出的图
  不用手点刷新就会出现在「作品」页。

## 结构

```
lib/plugin.js     loader 入口（按 mtime 重新 import host 闭包，改代码免重启）
lib/adapter.js    适配层：模型参数声明表的归一、校验、组装（纯函数，无 I/O）
lib/host.js       三个工具、@last 取图、附件批量回传、参考图上传、面板 HTTP 路由
lib/runner.js     发请求、异步轮询、取图、落盘、宽高探测、探活、连通性测试
lib/store.js      配置读写与归一、就绪检查、尺寸表、密钥脱敏、画廊与元数据
lib/protocol.js   请求体组装（三条通路）、模板引擎、尺寸表、路径取值、图片嗅探（纯函数）
lib/client.js     侧边栏面板：生成 / 画廊 / 接入点与模型
```

## 已知边界

- 改图仍以「本机路径 / URL / @last」为准；面板可以直接把图片**拖进参考图浮层**、按「选择文件…」
  或在里面 Ctrl+V 粘贴——文件会经 `/ref.upload.json` 落到 `$DSH_HOME/dsh-image-gen/uploads/`，
  之后当普通路径用。面板里**不能**用 `@last`（面板没有会话上下文）。
- 面板不做批量选择与批量删除（工具里 `gallery.delete` 支持批量）。
- 探活默认打 `/models`；不提供该端点的站会失败，这属于站点差异，不是配置错误。
- 参数声明表要求请求体是**扁平结构**（或固定的容器路径 `at`）。请求体形状完全动态的协议
  （比如需要按参数动态增删数组元素）还是得写 `bodyTemplate`。

