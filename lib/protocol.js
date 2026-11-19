/**
 * dsh-image-gen · 协议层
 *
 * 纯函数，无 I/O、无宿主依赖。负责「把一次生成意图变成 HTTP 请求体」和
 * 「把接口响应变成图片字节」这两件事：
 *
 *   - 请求体模板（{{prompt}} {{model}} {{n}} {{size}} …）
 *     让非 OpenAI 协议（DashScope 原生、日日新 SenseNova 等）也能接。
 *   - 结果取值路径（如 output.results[].url）留空时在响应里自动嗅探。
 *   - 尺寸表按「面积恒定」推算，保证不同画幅像素总量接近。
 *   - 图片魔数识别与宽高探测：接口不总是如实给格式与尺寸，本地自己认。
 */

/** 画幅比例：决定宽高比，不含像素。 */
export const RATIOS = ['1:1', '3:2', '4:3', '16:9', '2:3', '3:4', '9:16'];

import { applyParams, compilePlan, normalizeParams } from './adapter.js';

/** 分辨率档位 → 目标面积（像素²）。 */
export const RES_AREA = { '1K': 1024 * 1024, '2K': 2048 * 2048, '4K': 3840 * 2160 };

export const DEFAULT_GEN_PATH = '/images/generations';
export const DEFAULT_EDIT_PATH = '/images/edits';

/** 请求体模板里可用的占位符（面板提示与报错共用一份清单）。 */
export const PLACEHOLDERS = [
  'prompt',
  'negative',
  'model',
  'n',
  'size',
  'size_star',
  'quality',
  'format',
  'ratio',
  'resolution',
  'background',
  'seed',
  'strength',
  'mask',
  'images',
  'image_blocks',
  'image_urls',
];

/** 能产出的图片格式。 */
export const FORMATS = ['png', 'jpeg', 'webp', 'gif', 'svg'];

/** 只有出动图才有意义的参数：出静图时必须摘掉，否则站点会当成要动图。 */
const GIF_ONLY_PARAMS = ['frame_count', 'frame_duration_ms', 'frame_delay', 'frames'];

/** 格式归一：jpg → jpeg、svg+xml → svg，不认识返回空串。 */
export function normalizeFormat(value) {
  let f = String(value || '').trim().toLowerCase().replace(/^\./, '');
  if (f === 'jpg' || f === 'jpe') f = 'jpeg';
  if (f === 'svg+xml' || f === 'svgz') f = 'svg';
  return FORMATS.includes(f) ? f : '';
}

/**
 * 深合并：override 里出现的键覆盖 base，纯对象递归合并，其余整体替换。
 * 返回新对象，不改入参。
 */
function mergeDeep(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return override;
  if (!base || typeof base !== 'object' || Array.isArray(base)) return { ...override };
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const isPlainBase = out[key] && typeof out[key] === 'object' && !Array.isArray(out[key]);
    const isPlainValue = value && typeof value === 'object' && !Array.isArray(value);
    out[key] = isPlainBase && isPlainValue ? mergeDeep(out[key], value) : value;
  }
  return out;
}

/** 出静图时把动图专用参数摘掉（extra 里残留的 frame_count 之类）。 */
function dropAnimationParams(params, format) {
  if (!params || typeof params !== 'object' || Array.isArray(params) || format === 'gif') return params;
  const out = { ...params };
  for (const key of GIF_ONLY_PARAMS) delete out[key];
  return out;
}

/** 图片容器键：嗅探时优先在这些键上找图。 */
const IMAGE_VALUE_KEYS = ['b64_json', 'base64', 'b64', 'image_b64', 'imageBase64', 'image', 'image_url', 'imageUrl', 'img', 'url', 'artifact'];
const IMAGE_CONTAINER_KEYS = ['data', 'output', 'images', 'image_urls', 'urls', 'result', 'results', 'choices', 'message', 'content', 'artifacts', 'files', 'items', 'task_result'];

/* ------------------------------------------------------------------ */
/* 尺寸                                                                */
/* ------------------------------------------------------------------ */

/** 对齐到 16 的倍数，且不小于 16。 */
export function round16(v) {
  return Math.max(16, Math.round(v / 16) * 16);
}

/** 画幅 × 分辨率 → "宽x高"；面积恒定。 */
export function sizeFor(ratio, tier) {
  const area = RES_AREA[tier];
  if (!area) return null;
  const [a, b] = String(ratio).split(':').map(Number);
  if (!a || !b) return null;
  return round16(Math.sqrt((area * a) / b)) + 'x' + round16(Math.sqrt((area * b) / a));
}

/**
 * 参考图的宽高 → 最接近的画幅档位（RATIOS 里的某一项）。
 * 用于改图时「不传 ratio 就沿用参考图比例」：取对数距离最近的那个档，
 * 这样 2687×1500（1.79）会落到 16:9，而不是被强行压成 1:1。
 */
export function ratioForDims(dims) {
  const w = Number(dims?.width) || 0;
  const h = Number(dims?.height) || 0;
  if (!w || !h) return '';
  const want = Math.log(w / h);
  let best = '';
  let bestGap = Infinity;
  for (const ratio of RATIOS) {
    const [a, b] = ratio.split(':').map(Number);
    if (!a || !b) continue;
    const gap = Math.abs(Math.log(a / b) - want);
    if (gap < bestGap) {
      bestGap = gap;
      best = ratio;
    }
  }
  return best;
}

/** 整张尺寸表（给面板展示用）。 */
export function defaultSizes() {
  const out = {};
  for (const tier of Object.keys(RES_AREA)) {
    out[tier] = {};
    for (const ratio of RATIOS) out[tier][ratio] = sizeFor(ratio, tier);
  }
  return out;
}

/** 尺寸字符串归一：'1024X1024' / '1024*1024' → '1024x1024'。 */
export function normalizeSize(value) {
  return String(value || '').trim().toLowerCase().replace(/\s*\*\s*/g, 'x').replace(/\s+/g, '');
}

/* ------------------------------------------------------------------ */
/* 模板                                                                */
/* ------------------------------------------------------------------ */

/**
 * 占位符所在位置是不是 JSON 字符串字面量内部。
 *
 * 模板是「文本拼接」出来的 JSON，占位符分两类位置：
 * - 字符串内部（`"prompt":"{{prompt}}"`）→ 值必须按 JSON 字符串转义，
 *   否则提示词里的换行/引号/反斜杠会拼出非法 JSON（Bad control character …）。
 * - 字符串外部（`"n":{{n}}`、`"images":{{image_urls}}`）→ 值必须原样插入，
 *   加了引号反而会把数字/数组拼坏。
 *
 * 判据：从模板开头数到该占位符为止，未被转义的 `"` 的个数为奇数 → 在字符串内。
 */
function insideJsonString(text, offset) {
  let quotes = 0;
  let escaped = false;
  for (let i = 0; i < offset; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') quotes += 1;
  }
  return quotes % 2 === 1;
}

/** 按上下文决定是否转义：字符串内 → JSON 字符串内容，字符串外 → 原样。 */
function renderValue(text, offset, value) {
  const raw = String(value);
  return insideJsonString(text, offset) ? JSON.stringify(raw).slice(1, -1) : raw;
}

/** `{{ name }}` 占位符替换；未知占位符原样保留，由调用方检测后报错。 */
export function renderTemplate(tpl, ctx) {
  const text = String(tpl);
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (all, key, offset) =>
    Object.prototype.hasOwnProperty.call(ctx, key) ? renderValue(text, offset, ctx[key]) : all,
  );
}

/** 模板里残留的占位符。 */
export function leftoverPlaceholders(text) {
  return [...new Set(String(text).match(/\{\{\s*\w+\s*\}\}/g) || [])];
}

/** 参考图 → `{"image":"…"},` 片段（自带尾随逗号；无图时为空）。 */
export function imageBlocksFragment(urls) {
  if (!Array.isArray(urls) || urls.length === 0) return '';
  return urls.map((u) => '{"image":' + JSON.stringify(u) + '}').join(',') + ',';
}

/** 参考图 → `[{"image_url":"…"}]`（日日新这类要包一层的协议用）。 */
export function imageUrlsFragment(urls) {
  const list = Array.isArray(urls) ? urls : [];
  return JSON.stringify(list.map((u) => ({ image_url: u })));
}

/** Base URL 归一：去尾斜杠。 */
export function normalizeBase(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

/** 端点归一：空则回退到默认，并补前导斜杠。 */
export function normalizePath(path, fallback) {
  const raw = String(path || '').trim();
  if (!raw) return fallback;
  return raw.startsWith('/') ? raw : '/' + raw;
}

/**
 * 组请求体。
 *
 * @param spec.model        模型 ID
 * @param spec.prompt       提示词
 * @param spec.negative     反向提示词（只有模板能消费）
 * @param spec.size         具体尺寸（可能为 "auto"）
 * @param spec.quality      质量档
 * @param spec.background   'auto' | 'opaque' | 'transparent'
 * @param spec.ratio        画幅，供模板用
 * @param spec.resolution   分辨率档，供模板用
 * @param spec.seed         随机种子，供模板用
 * @param spec.strength     改图强度，供模板用
 * @param spec.bodyTemplate 请求体模板（空 = OpenAI 协议）
 * @param spec.extra        额外参数（浅合并到顶层，同名以 extra 为准）
 * @param spec.images       参考图的 dataURL / URL 数组（模板用）
 * @param spec.mask         蒙版的 dataURL（模板用）
 */
export function buildBody(spec) {
  const urls = Array.isArray(spec.images) ? spec.images : [];
  const extra = spec.extra && typeof spec.extra === 'object' && !Array.isArray(spec.extra) ? spec.extra : {};
  const n = Number.isFinite(Number(spec.n)) && Number(spec.n) > 0 ? Number(spec.n) : 1;

  // ---- 通路 0：声明式参数（新）----
  // 模型的 `params` 表说了算：骨架按 bodyMode 定，每个字段的位置/默认值/桥接
  // 全从声明来。这条通路让「接新模型」变成写配置，而不是改代码。
  const plan = compilePlan({ params: spec.params, bodyMode: spec.bodyMode });
  if (plan.declared) {
    return buildDeclarative(spec, plan, { urls, extra, n });
  }

  const tpl = String(spec.bodyTemplate || '').trim();
  if (tpl) {
    const ctx = {
      prompt: spec.prompt ?? '',
      negative: spec.negative ?? '',
      model: spec.model ?? '',
      n,
      size: spec.size ?? '',
      size_star: String(spec.size || '').replace('x', '*'),
      quality: spec.quality ?? '',
      // 模板曾漏了这一项：PLACEHOLDERS 里列着 {{format}}，ctx 却没有 format 键，
      // 于是模板一写 {{format}} 就撞「占位符没被替换」。归一后为空串时渲染为空。
      format: normalizeFormat(spec.format) || '',
      ratio: spec.ratio ?? '',
      resolution: spec.resolution ?? '',
      background: spec.background || 'auto',
      seed: spec.seed === undefined || spec.seed === null || spec.seed === '' ? -1 : spec.seed,
      strength: spec.strength === undefined || spec.strength === null || spec.strength === '' ? '' : spec.strength,
      mask: spec.mask ?? '',
      images: JSON.stringify(urls),
      image_blocks: imageBlocksFragment(urls),
      image_urls: imageUrlsFragment(urls),
    };
    const raw = renderTemplate(tpl, ctx);
    const left = leftoverPlaceholders(raw);
    if (left.length) {
      throw new Error(
        '请求体模板里有没被替换的占位符：' +
          left.join(' ') +
          '。可用占位符：' +
          PLACEHOLDERS.join(' / ') +
          '。',
      );
    }
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      throw new Error('请求体模板替换占位符后不是合法 JSON：' + String(e.message || e));
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new Error('请求体模板必须展开成一个 JSON 对象。');
    }
    const tplFormat = normalizeFormat(spec.format);
    const shaped = tplFormat ? applyFormat(obj, tplFormat) : obj;
    if (tplFormat) return shaped;
    return Object.assign(shaped, extra);
  }

  // ---- 默认协议：显式参数优先，extra 只补没人指定的位置 ----
  // 以前这里先铺基础字段再 Object.assign(extra)，等于「模型配置里钉死的值永远赢」。
  // 后果很实在：gpt-image-2.6 的 extra.params 里写死 output_format=gif，
  // AI 想出一张静图也没有任何参数能翻盘，只能拿到动图。
  const extraFormat = normalizeFormat(extra?.params?.output_format) || normalizeFormat(extra?.output_format);
  // 动图是特例产物：配置里钉死的 gif **不能**当默认，否则「画一张图」永远拿到动图。
  // 要 gif 就在调用时显式传 format="gif"。
  const defaultFormat = extraFormat && extraFormat !== 'gif' ? extraFormat : 'png';
  const format = normalizeFormat(spec.format) || defaultFormat;
  const body = {
    model: spec.model,
    prompt: spec.prompt,
    size: spec.size,
    quality: spec.quality || 'medium',
    n,
  };
  // extra 打底：模型级的固定参数（版本、站点私有字段等）
  const merged = mergeDeep(body, extra);

  // 调用方显式给了值 → 覆盖掉 extra 里钉死的同名项
  const explicitSize = Boolean(spec.explicitSize && spec.size);
  if (explicitSize) merged.size = spec.size;
  if (spec.quality) merged.quality = spec.quality;
  if (spec.background && spec.background !== 'auto') merged.background = spec.background;

  // params 是很多站点放私有参数的容器，同样按「显式优先」处理
  if (merged.params && typeof merged.params === 'object' && !Array.isArray(merged.params)) {
    const params = { ...merged.params };
    if (explicitSize) params.size = spec.size;
    if (spec.quality) params.quality = spec.quality;
    // 格式与动图参数：出静图时把 output_format 改回静图、并摘掉 frame_count 这类
    // 动图专用字段 —— 留着它们，站点仍会当成「要出 GIF」。
    params.output_format = format;
    merged.params = dropAnimationParams(params, format);
  }
  merged.output_format = format;
  // seed / negative 不进默认协议：OpenAI 官方接口对未知字段直接 400，
  // 想用它们就给模型配请求体模板（{{seed}} / {{negative}}）。
  return merged;
}

/**
 * 把「显式格式」应用到默认协议体上。
 * 需要同时处理顶层 output_format 与 params.output_format —— 站点把哪个当准不统一，
 * 两边都写一致最稳；同时把动图专用参数按目标格式收拾干净。
 */
function applyFormat(body, format) {
  const out = { ...body };
  if (out.output_format !== undefined) out.output_format = format;
  if (out.params && typeof out.params === 'object' && !Array.isArray(out.params)) {
    const params = { ...out.params };
    // 原来这里是 if (params.output_format !== undefined) … else if (format) …，
    // 两个分支做的事完全一样（都等于 params.output_format = format），合并掉。
    if (format) params.output_format = format;
    out.params = dropAnimationParams(params, format);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 声明式请求体                                                        */
/* ------------------------------------------------------------------ */

/**
 * 请求体骨架。决定了「哪些通用字段无条件带上、带在哪」。
 *
 *   openai   （默认）model / prompt / size / quality / n —— 就是老行为
 *   minimal          只带 model / prompt / n，其余全由 params 声明决定
 *   custom           连 model / prompt 都交给声明（极端站点用）
 */
export const BODY_MODES = ['openai', 'minimal', 'custom'];

/** 骨架里每个模式无条件带的字段。 */
const BODY_SKELETON = {
  openai: (spec, n) => ({
    model: spec.model,
    prompt: spec.prompt,
    size: spec.size,
    quality: spec.quality || 'medium',
    n,
  }),
  minimal: (spec, n) => ({ model: spec.model, prompt: spec.prompt, n }),
  custom: (spec, n) => ({ n }),
};

/**
 * 构造请求体：声明式通路。
 *
 * 处理顺序：
 *   1. 按 bodyMode 铺骨架
 *   2. 骨架字段若被声明 `from` 桥接（或同名声明），以声明为准
 *   3. 按声明逐项铺：响应参数（at / from / default / lock）
 *   4. extra 兜底（老配置兼容）：只补声明里没提到的键
 *   5. 参考图按 transport 装载
 */
function buildDeclarative(spec, plan, { extra, n }) {
  const mode = BODY_MODES.includes(String(spec.bodyMode || '')) ? String(spec.bodyMode) : 'openai';
  const body = (BODY_SKELETON[mode] || BODY_SKELETON.openai)(spec, n);
  const errors = [];

  // 通用参数上下文：声明里的 from 从这里取值
  const ctx = {
    prompt: spec.prompt ?? '',
    negative: spec.negative ?? '',
    model: spec.model ?? '',
    n,
    size: spec.size ?? '',
    quality: spec.quality ?? '',
    format: normalizeFormat(spec.format) || '',
    background: spec.background || 'auto',
    seed: spec.seed,
    strength: spec.strength,
    ratio: spec.ratio ?? '',
    resolution: spec.resolution ?? '',
  };

  // 声明里如果直接声明了骨架同名字段（如 `{ "size": { "from": "size" }}`），
  // 先把骨架那个值清掉，交给声明决定位置和形态。
  const declared = plan.params;
  if (mode !== 'custom') {
    for (const key of Object.keys(body)) {
      if (declared[key] && declared[key].from) delete body[key];
    }
  }

  // 调用方显式给的模型私有参数（通道名故意不叫 params —— 声明表占用了这个名字）
  const explicitParams =
    spec.privateParams && typeof spec.privateParams === 'object' && !Array.isArray(spec.privateParams)
      ? spec.privateParams
      : {};

  applyParams(body, declared, ctx, explicitParams, (msg) => errors.push(msg));

  // 校验失败的项，抛错前把全部问题一次说完（比逐条试错省一轮）
  if (errors.length) throw new Error(errors.join(' '));

  // extra 兜底：老配置里钉死的站点私有参数，声明里没有的照旧合并进来
  for (const [k, v] of Object.entries(extra)) {
    if (k === 'params' && v && typeof v === 'object' && !Array.isArray(v)) {
      const box = body.params && typeof body.params === 'object' ? { ...body.params } : {};
      for (const [pk, pv] of Object.entries(v)) if (!(pk in box)) box[pk] = pv;
      if (Object.keys(box).length) body.params = box;
      continue;
    }
    if (!(k in body)) body[k] = v;
  }

  // 参考图：按模型的 transport 装载
  attachImagesToBody(body, spec, declared);

  // 动图专用参数：目标不是 gif 就摘干净（否则站点仍当成要 GIF）
  if (body.params && typeof body.params === 'object' && !Array.isArray(body.params)) {
    body.params = dropAnimationParams(body.params, normalizeFormat(spec.format) || 'png');
  }

  return body;
}

/**
 * 把参考图塞进请求体。
 *
 * 声明里可用特殊参数名自动装载：
 *   images / images_objects / image
 * 也可以用 transport 配置决定形态（见 IMAGE_PAYLOADS）。
 */
function attachImagesToBody(body, spec, declared) {
  const urls = Array.isArray(spec.images) ? spec.images : [];
  if (!urls.length) return;
  const t = spec.imagePayload || 'objects';

  // 声明里显式写了的，尊重声明（它可能用了 at 指定容器）
  const hasDeclared = ['images', 'image', 'images_objects', 'image_urls'].some((k) => k in declared);

  const shapes = {
    objects: () => ({ key: 'images', value: urls.map((u) => ({ image_url: u })) }),
    urls: () => ({ key: 'images', value: urls.slice() }),
    // 「image 是字符串数组」这一类站点（tt-image-2）：字段名是单数，值是字符串数组
    image_strings: () => ({ key: 'image', value: urls.slice() }),
    // 单图字段 + {image_url} 对象
    image: () => ({ key: 'image', value: { image_url: urls[0] } }),
  };
  const shape = (shapes[t] || shapes.objects)();

  if (!hasDeclared) {
    body[shape.key] = shape.value;
    return;
  }
  // 声明指定了容器 → 用声明的位置
  const container = declared[shape.key]?.at || '';
  if (container) setAtSafe(body, container, shape.key, shape.value);
  else body[shape.key] = shape.value;
}


function setAtSafe(body, container, key, value) {
  const path = String(container || '').split('.').filter(Boolean);
  if (!path.length) {
    body[key] = value;
    return;
  }
  let cur = body;
  for (const seg of path) {
    if (!cur[seg] || typeof cur[seg] !== 'object' || Array.isArray(cur[seg])) cur[seg] = {};
    cur = cur[seg];
  }
  cur[key] = value;
}

/* ------------------------------------------------------------------ */
/* 响应取值                                                            */
/* ------------------------------------------------------------------ */

/** 解析一段路径：`a.b[0].c`、`output.results[].url`。 */
function parseSegment(seg) {
  const m = /^([^[\]]*)((?:\[[^\]]*\])*)$/.exec(seg);
  if (!m) return null;
  const ops = [];
  const re = /\[([^\]]*)\]/g;
  let g;
  while ((g = re.exec(m[2]))) ops.push(g[1]);
  return { name: m[1], ops };
}

/**
 * 按点路径取值。
 * - `a.b`        取属性
 * - `a[0].b`     取数组元素
 * - `a[].b`      展开数组，返回所有元素的 b 组成的新数组
 * 多值结果统一返回数组，取不到返回 undefined。
 */
export function pickPath(root, path) {
  const raw = String(path || '').trim();
  if (!raw) return undefined;
  let cur = [root];
  for (const rawSeg of raw.split('.')) {
    const seg = parseSegment(rawSeg.trim());
    if (!seg) return undefined;
    const next = [];
    for (const node of cur) {
      let val = seg.name ? (node && typeof node === 'object' ? node[seg.name] : undefined) : node;
      let spread = false;
      for (const op of seg.ops) {
        if (op === '') {
          if (Array.isArray(val)) next.push(...val);
          spread = true;
          val = undefined;
          break;
        }
        const idx = Number(op);
        if (!Array.isArray(val) || !Number.isInteger(idx) || idx < 0) {
          val = undefined;
          break;
        }
        val = val[idx];
      }
      if (!spread && val !== undefined && val !== null) next.push(val);
    }
    cur = next;
    if (!cur.length) return undefined;
  }
  return cur.length === 1 ? cur[0] : cur;
}

/** 一个已知的图片容器取值（b64 / dataURL / URL）。 */
export function knownImageValue(x) {
  if (!x || typeof x !== 'object') return null;
  for (const k of IMAGE_VALUE_KEYS) {
    const v = x[k];
    if (typeof v === 'string' && v.length) return v;
    if (v && typeof v === 'object') {
      const r = knownImageValue(v);
      if (r) return r;
    }
  }
  for (const k of IMAGE_CONTAINER_KEYS) {
    const v = x[k];
    if (Array.isArray(v)) {
      for (const it of v) {
        const r = knownImageValue(it);
        if (r) return r;
      }
    } else if (v && typeof v === 'object') {
      const r = knownImageValue(v);
      if (r) return r;
    }
  }
  return null;
}

/** 字符串像不像一张图的值。 */
function looksLikeImageValue(s) {
  const v = String(s || '').trim();
  if (!v) return false;
  if (/^data:image\//i.test(v)) return true;
  if (/^https?:\/\//i.test(v)) return true;
  if (/^(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(v)) return true;
  // 裸 base64：长度够长、字符集干净、没有句子标点
  if (v.length > 400 && /^[A-Za-z0-9+/\r\n=]+$/.test(v)) return true;
  return false;
}

/**
 * 在整份响应里广度优先地找图片值。
 * 有界（深度 ≤ 6、节点 ≤ 600），避免异常响应把进程拖住。
 */
export function collectImageValues(data) {
  const out = [];
  const seen = new Set();
  const queue = [{ node: data, depth: 0 }];
  let visited = 0;
  while (queue.length && visited < 600) {
    const { node, depth } = queue.shift();
    visited += 1;
    if (!node || typeof node !== 'object' || depth > 6) continue;
    const keys = Array.isArray(node) ? node.map((_, i) => i) : Object.keys(node);
    for (const k of keys) {
      const v = node[k];
      if (typeof v === 'string') {
        const isImageKey = IMAGE_VALUE_KEYS.includes(String(k)) || IMAGE_CONTAINER_KEYS.includes(String(k));
        if (isImageKey && looksLikeImageValue(v) && !seen.has(v)) {
          seen.add(v);
          out.push(v);
        }
      } else if (Array.isArray(v)) {
        for (const it of v) {
          if (typeof it === 'string') {
            if (looksLikeImageValue(it) && !seen.has(it)) {
              seen.add(it);
              out.push(it);
            }
          } else if (it && typeof it === 'object') {
            queue.push({ node: it, depth: depth + 1 });
          }
        }
      } else if (v && typeof v === 'object') {
        queue.push({ node: v, depth: depth + 1 });
      }
    }
  }
  return out;
}

/** 把取值结果摊平成图片值列表。 */
function flattenImageValues(value) {
  const out = [];
  const walk = (v, depth) => {
    if (v === null || v === undefined || depth > 4) return;
    if (typeof v === 'string') {
      if (looksLikeImageValue(v) && !out.includes(v)) out.push(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const it of v) walk(it, depth + 1);
      return;
    }
    if (typeof v === 'object') {
      const direct = knownImageValue(v);
      if (direct && !out.includes(direct)) out.push(direct);
    }
  };
  walk(value, 0);
  return out;
}

/**
 * 从成功响应里取出全部图片值（b64 / dataURL / URL）。
 * resultPath 支持逗号分隔的多个候选路径，按顺序取第一个有结果的。
 * 没配路径就自动嗅探。
 */
export function extractImages(data, resultPath) {
  const candidates = String(resultPath || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (candidates.length) {
    for (const path of candidates) {
      const v = pickPath(data, path);
      const values = flattenImageValues(v);
      if (values.length) return values;
    }
    throw new Error(
      '按结果取值路径「' +
        resultPath +
        '」没取到图片。响应顶层键：' +
        (data && typeof data === 'object' ? Object.keys(data).slice(0, 12).join(', ') : typeof data) +
        '；可在面板里改正路径，或用 .content-list 查看完整响应。',
    );
  }

  const many = collectImageValues(data);
  if (many.length) return many;
  const one = knownImageValue(data);
  if (one) return [one];
  throw new Error(
    '接口返回成功，但没找到图片字段。可在模型里填「结果取值路径」，例如 output.choices[0].message.content[0].image 或 output.results[].url。',
  );
}

/* ------------------------------------------------------------------ */
/* 错误翻译                                                            */
/* ------------------------------------------------------------------ */

/** 把错误信息翻译成「下一步该改哪里」，比裸 HTTP 码有用。 */
export function explainHttpFailure(status, message, requestUrl) {
  const msg = String(message || '').slice(0, 500);
  let hint = '';
  if (/model\s*not\s*exist|model.*not.*found|unknown model|invalid model|model_not_found/i.test(msg)) {
    hint = '　→　「模型 ID」不对：核对模型那一格，要和服务商给出的名字完全一致。';
  } else if (/insufficient|balance|quota|余额|欠费|额度/i.test(msg)) {
    hint = '　→　账户额度不足：去服务商后台充值，或换一个接入点。';
  } else if (/content[_ -]?policy|safety|敏感|违规|审核/i.test(msg)) {
    hint = '　→　提示词被内容审核拦下：改写措辞后重试，不要一次只改一两个字。';
  } else if (status === 400) {
    hint = '　→　请求参数被拒：常见原因是尺寸不被支持、模型不支持改图、或请求体模板与协议不符。' + (requestUrl ? '实际请求：' + requestUrl : '');
  } else if (status === 401 || status === 403) {
    hint = '　→　鉴权失败：核对接入点的 API Key，以及它是否属于这个 Base URL。';
  } else if (status === 404) {
    hint = '　→　地址不存在：核对「Base URL + 端点」的拼法（端点不要重复写进 Base URL）。' + (requestUrl ? '实际请求：' + requestUrl : '');
  } else if (status === 413) {
    hint = '　→　请求过大：参考图太多或太大，减少张数或换小图。';
  } else if (status === 429) {
    hint = '　→　被限流：稍等再试，或降低并发张数。';
  } else if (status >= 500) {
    hint = '　→　服务商侧故障：换时间重试，或换一个接入点。';
  }
  return 'HTTP ' + status + '：' + msg + hint;
}

/* ------------------------------------------------------------------ */
/* 字节                                                                */
/* ------------------------------------------------------------------ */

/** dataURL / 裸 base64 → Uint8Array。 */
export function base64ToBytes(value) {
  const raw = String(value).startsWith('data:') ? String(value).split(',')[1] ?? '' : String(value);
  return new Uint8Array(Buffer.from(raw, 'base64'));
}

/** 字节 → 扩展名（按魔数判断，接口不总是如实给 content-type）。 */
export function sniffExt(bytes) {
  if (!bytes || !bytes.length) return 'bin';
  if (bytes.length >= 8) {
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg';
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif';
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45) return 'webp';
  }
  // SVG：文本，允许前导空白/BOM/XML 声明
  const head = Buffer.from(bytes.subarray(0, 512)).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'svg';
  return 'bin';
}

/**
 * 图片宽高探测（不依赖任何图像库）。
 * 支持 PNG / JPEG / GIF / WEBP；认不出返回 null。
 */
export function probeImageSize(bytes) {
  if (!bytes || bytes.length < 16) return null;
  const b = bytes;

  // PNG: IHDR 里的宽高，大端 32 位
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    try {
      return { width: dv.getUint32(16), height: dv.getUint32(20) };
    } catch {
      return null;
    }
  }

  // GIF: 逻辑屏幕宽高，小端 16 位
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8) };
  }

  // WEBP: VP8X / VP8 / VP8L 三种头
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) {
    const kind = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (kind === 'VP8X' && b.length >= 30) {
      const w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
      const h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
      return { width: w, height: h };
    }
    if (kind === 'VP8L' && b.length >= 25) {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (kind === 'VP8 ' && b.length >= 30) {
      const w = (b[26] | (b[27] << 8)) & 0x3fff;
      const h = (b[28] | (b[29] << 8)) & 0x3fff;
      if (w && h) return { width: w, height: h };
    }
    return null;
  }

  // JPEG: 逐段扫描 SOFn
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = b[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = (b[i + 2] << 8) | b[i + 3];
      if (len < 2) return null;
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        return { width: (b[i + 7] << 8) | b[i + 8], height: (b[i + 5] << 8) | b[i + 6] };
      }
      i += 2 + len;
    }
    return null;
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* 模板校验                                                            */
/* ------------------------------------------------------------------ */

/**
 * 校验请求体模板：按「无参考图」「两张参考图」各渲染一遍，两遍都必须是合法 JSON 对象。
 * 面板的「校验」按钮与工具写入配置前都走这里。
 */
export function validateTemplate(tpl) {
  const probe = (n) => ({
    model: 'probe',
    prompt: '试解析',
    negative: '',
    n: 1,
    size: '1024x1024',
    quality: 'medium',
    ratio: '1:1',
    resolution: '1K',
    background: 'auto',
    seed: -1,
    strength: '',
    images: Array.from({ length: n }, () => 'data:image/png;base64,AAAA'),
    bodyTemplate: tpl,
    extra: {},
  });
  const empty = buildBody(probe(0));
  const two = buildBody(probe(2));
  return {
    ok: true,
    emptyKeys: Object.keys(empty || {}),
    refKeys: Object.keys(two || {}),
  };
}
