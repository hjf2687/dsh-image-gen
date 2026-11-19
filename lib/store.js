/**
 * dsh-image-gen · 配置存储
 *
 * 接入点（Base URL + API Key + 端点 + 自定义请求头）
 *   → 模型（模型 ID + 能力 + 模板 + 取值路径 + 声明）
 * 两级结构。
 *
 * 为什么用独立 JSON 文件而不是插件的 Config：
 *   API Key 不该进 profile 的 cordis.patch.yml（那是可分享、可提交的装配层）。
 *   文件放在 $DSH_HOME/dsh-image-gen/config.json，权限 0600，只在本机。
 *
 * 写入一律「读-改-写 + 临时文件替换」，避免面板与工具并发写时留下半截 JSON。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeParams } from './adapter.js';

const FILE_MODE = 0o600;
export const CONFIG_VERSION = 2;
const DEFAULT_GEN_PATH = '/images/generations';
const DEFAULT_EDIT_PATH = '/images/edits';

/** 模型可能产出的图片格式。空数组 = 不声明（按实际响应的魔数判断）。 */
export const KNOWN_FORMATS = ['png', 'jpeg', 'webp', 'gif', 'svg'];

/** 空配置骨架。 */
function emptyConfig() {
  return {
    version: CONFIG_VERSION,
    providers: [],
    models: [],
    defaultModel: '',
    sizes: {},
    outputDir: '',
    timeoutMs: 180000,
    recordMetadata: true,
  };
}

export function defaultDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'dsh-image-gen');
}

/** 配置目录：插件 Config.dir 覆盖默认。 */
export function resolveDir(configured) {
  const raw = String(configured || '').trim();
  return raw || defaultDir();
}

export function configPath(dir) {
  return path.join(dir, 'config.json');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function listOf(v) {
  return Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : [];
}

function str(v, fallback = '') {
  return typeof v === 'string' ? v : v === undefined || v === null ? fallback : String(v);
}

function numOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 归一化 formats：接受数组或逗号/空格分隔字符串，别名统一、去重、不认识的丢弃。 */
export function normalizeFormats(v) {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\s]+/) : [];
  const out = [];
  for (const item of raw) {
    let f = String(item || '').trim().toLowerCase().replace(/^\./, '');
    if (f === 'jpg') f = 'jpeg';
    if (f === 'svg+xml') f = 'svg';
    if (f === 'svgz') f = 'svg';
    if (KNOWN_FORMATS.includes(f) && !out.includes(f)) out.push(f);
  }
  return out;
}

/** 自定义请求头：只收字符串键值，去掉 authorization / content-length 这类不能手填的。 */
function normalizeHeaders(v) {
  const out = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [rawKey, rawValue] of Object.entries(v)) {
    const key = String(rawKey || '').trim();
    const value = typeof rawValue === 'string' ? rawValue.trim() : rawValue === undefined || rawValue === null ? '' : String(rawValue);
    if (!key || !value) continue;
    if (/^(authorization|content-length|content-type|host|connection)$/i.test(key)) continue;
    out[key] = value;
  }
  return out;
}

/** 模型级尺寸覆盖：`{ "1K": { "1:1": "1024x1024" } }`，只保留 "宽x高"。 */
function normalizeSizes(v) {
  const out = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [tier, ratios] of Object.entries(v)) {
    if (!ratios || typeof ratios !== 'object' || Array.isArray(ratios)) continue;
    const bucket = {};
    for (const [ratio, size] of Object.entries(ratios)) {
      const s = str(size).trim().toLowerCase();
      if (/^\d+x\d+$/.test(s)) bucket[String(ratio)] = s;
    }
    if (Object.keys(bucket).length) out[String(tier).toUpperCase()] = bucket;
  }
  return out;
}

/** 请求体骨架：只有三个合法值，其余回落 openai。 */
export function normalizeBodyMode(v) {
  const s = String(v || '').trim().toLowerCase();
  return ['openai', 'minimal', 'custom'].includes(s) ? s : 'openai';
}

/** 参考图装载形态：决定 images 字段长什么样。 */
export function normalizeImagePayload(v) {
  const s = String(v || '').trim().toLowerCase();
  return ['objects', 'urls', 'image', 'image_strings', 'b64'].includes(s) ? s : 'objects';
}

/** 模型级端点覆盖：`{ generate: "/media/generate", edit: "/media/generate" }`。 */
function normalizeEndpoints(v) {
  const out = { generate: '', edit: '' };
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const key of ['generate', 'edit']) {
    const raw = str(v[key]).trim();
    out[key] = raw ? (raw.startsWith('/') ? raw : '/' + raw) : '';
  }
  return out;
}

/**
 * 参数声明：交给 adapter 归一（那边容忍笔误、认不出的整条丢弃）。
 * 这里只做「必须是对象」的粗筛，避免把数组当表。
 */
function normalizeParamSpecs(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  try {
    return normalizeParams(v);
  } catch {
    return {};
  }
}

/** 规整一遍：容忍手改过的文件，未知字段丢弃、缺字段补默认。 */
function normalize(raw) {
  const base = emptyConfig();
  if (!raw || typeof raw !== 'object') return base;

  const usedProviderIds = new Set();
  base.providers = listOf(raw.providers)
    .map((p) => {
      let id = str(p.id) || 'p_' + Math.random().toString(36).slice(2, 9);
      while (usedProviderIds.has(id)) id = 'p_' + Math.random().toString(36).slice(2, 9);
      usedProviderIds.add(id);
      return {
        id,
        name: str(p.name) || '未命名接入点',
        baseUrl: str(p.baseUrl).trim().replace(/\/+$/, ''),
        apiKey: str(p.apiKey).trim(),
        generatePath: str(p.generatePath) || '/images/generations',
        editPath: str(p.editPath),
        timeoutMs: numOr(p.timeoutMs, 0),
        // 异步任务接口：先提交拿 task_id，再轮询状态。
        taskMode: str(p.taskMode) === 'poll' ? 'poll' : 'sync',
        statusPath: str(p.statusPath),
        taskIdField: str(p.taskIdField) || 'data.task_id',
        resultUrlsField: str(p.resultUrlsField) || 'result_url',
        pollIntervalMs: numOr(p.pollIntervalMs, 3000),
        pollTimeoutMs: numOr(p.pollTimeoutMs, 300000),
        headers: normalizeHeaders(p.headers),
      };
    })
    .filter((p) => p.id);

  const providerIds = new Set(base.providers.map((p) => p.id));
  const usedModelIds = new Set();
  base.models = listOf(raw.models)
    .map((m) => {
      let id = str(m.id) || 'm_' + Math.random().toString(36).slice(2, 9);
      while (usedModelIds.has(id)) id = 'm_' + Math.random().toString(36).slice(2, 9);
      usedModelIds.add(id);
      return {
        id,
        providerId: str(m.providerId),
        name: str(m.name) || str(m.model) || '未命名模型',
        model: str(m.model),
        caps: ['both', 'generate', 'edit'].includes(str(m.caps)) ? str(m.caps) : 'both',
        maxSide: numOr(m.maxSide, 0),
        bodyTemplate: str(m.bodyTemplate),
        resultPath: str(m.resultPath),
        /* 改图时改用 JSON 请求体（参考图塞进 images 数组），而不是 OpenAI 的 multipart。
           日日新这类端点虽然叫 /images/edits，但只吃 JSON + dataURL；用 multipart 会 400。 */
        editJson: m.editJson === true,
        extra: m.extra && typeof m.extra === 'object' && !Array.isArray(m.extra) ? m.extra : {},
        // 自定义声明：给模型看的「这个模型能干嘛」，由用户在面板或工具里写。
        summary: str(m.summary),
        notes: str(m.notes),
        formats: normalizeFormats(m.formats),
        // 模型级别的尺寸覆盖（有些模型只吃固定几档尺寸）
        sizes: normalizeSizes(m.sizes),
        // 只有声明了 svg 才考虑走矢量通路；其余按实际响应的魔数判断
        costHint: str(m.costHint),
        /* ---- 适配层（新）：让「接新模型」只改配置 ---- */
        // 这个模型自己声明要哪些参数（见 adapter.js 的文件头说明）
        params: normalizeParamSpecs(m.params),
        // 请求体骨架：openai（默认）/ minimal / custom
        bodyMode: normalizeBodyMode(m.bodyMode),
        // 参考图装载形态：objects / urls / image
        imagePayload: normalizeImagePayload(m.imagePayload),
        // 结果取值路径（模型级；留空回落到接入点）
        resultUrlField: str(m.resultUrlField),
        // 模型级端点覆盖：空串 = 沿用接入点的
        endpoints: normalizeEndpoints(m.endpoints),
        // 模型级鉴权头覆盖：空 = 沿用接入点
        headers: m.headers && typeof m.headers === 'object' && !Array.isArray(m.headers) ? m.headers : {},
      };
    })
    .filter((m) => m.id);

  // 默认模型必须真实存在，否则退回第一个可用模型（旧版这里是个恒真的表达式）
  const wanted = str(raw.defaultModel).trim();
  base.defaultModel = wanted && base.models.some((m) => m.id === wanted) ? wanted : base.models[0]?.id || '';

  base.sizes = normalizeSizes(raw.sizes);
  base.outputDir = str(raw.outputDir);
  base.timeoutMs = numOr(raw.timeoutMs, 180000);
  base.recordMetadata = raw.recordMetadata === false ? false : true;
  // 保留一条线索：模型绑着已经不存在的接入点时，面板与工具都要报出来
  for (const m of base.models) {
    if (!providerIds.has(m.providerId)) m.providerMissing = true;
    else delete m.providerMissing;
  }
  return base;
}

export function loadConfig(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return normalize(readJson(configPath(dir)));
}

export function saveConfig(dir, next) {
  fs.mkdirSync(dir, { recursive: true });
  const clean = normalize(next);
  const file = configPath(dir);
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2), { mode: FILE_MODE });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, FILE_MODE);
  } catch {
    /* Windows 上 chmod 语义有限，失败不算错 */
  }
  return clean;
}

/** 读-改-写：mutator 拿到当前配置副本，返回新配置。 */
export function mutateConfig(dir, mutator) {
  const current = loadConfig(dir);
  const next = mutator(current);
  return saveConfig(dir, next && typeof next === 'object' ? next : current);
}

/**
 * 面板读到的密钥是脱敏的（abcd…wxyz）。整体写回时若不处理，脱敏串会被当成
 * 真密钥存下去，下一次请求就 401 —— 而且用户不会有任何提示。
 * 规则：按 id 对上老接入点时，新值「缺省」或「含省略号」就沿用旧密钥。
 */
export function mergePreservingKeys(existing, incoming) {
  const oldById = new Map((existing.providers || []).map((p) => [p.id, p]));
  const next = incoming && typeof incoming === 'object' ? { ...incoming } : {};
  next.providers = (Array.isArray(next.providers) ? next.providers : []).map((p) => {
    const old = oldById.get(p.id);
    const key = typeof p.apiKey === 'string' ? p.apiKey : '';
    const looksMasked = key.includes('…') || key === '';
    if (old && looksMasked) return { ...p, apiKey: old.apiKey };
    return p;
  });
  return next;
}

/** 生成稳定 id（前缀 + 时间戳 + 随机），便于人读日志。 */
export function makeId(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** 密钥脱敏：只留首尾四位。掩码里必须始终带省略号 —— 写回时靠它识别「这是掩码，别当真值存」。 */
export function maskKey(key) {
  const k = String(key || '');
  if (!k) return '';
  if (k.length <= 8) return '••••…';
  return k.slice(0, 4) + '…' + k.slice(-4);
}

/**
 * 就绪检查：把一个模型解析成「可直接发请求」的描述。
 * 失败时返回可操作的原因，而不是布尔值 —— 模型据此能自己修配置。
 */
export function resolveModel(config, modelId, mode) {
  const models = config.models || [];
  const wanted = String(modelId || '').trim();
  const canUse = (m) => (mode === 'edit' ? m.caps === 'edit' || m.caps === 'both' : m.caps === 'generate' || m.caps === 'both');
  const usable = models.filter(canUse);

  let model = null;
  if (wanted) {
    model = models.find((m) => m.id === wanted || m.name === wanted || m.model === wanted) || null;
    if (!model) {
      return {
        ok: false,
        reason:
          '没有找到模型「' +
          wanted +
          '」。已配置：' +
          (usable.length ? usable.map((m) => m.name + '(' + m.model + ')').join('、') : '（无）'),
      };
    }
    if (!canUse(model)) {
      return {
        ok: false,
        reason: '模型「' + model.name + '」不支持' + (mode === 'edit' ? '改图' : '生图') + '（适用能力是 ' + model.caps + '）。',
      };
    }
  } else {
    const preferred = String(config.defaultModel || '').trim();
    model = (preferred && usable.find((m) => m.id === preferred)) || usable[0] || null;
    if (!model) {
      return {
        ok: false,
        reason:
          '还没有可用的' +
          (mode === 'edit' ? '改图' : '生图') +
          '模型。先调 image_admin（op=provider.add）加接入点，再 op=model.add 加模型；或让用户在侧边栏「生图」面板里配。',
      };
    }
  }

  const provider = (config.providers || []).find((p) => p.id === model.providerId);
  if (!provider) {
    return { ok: false, reason: '模型「' + model.name + '」所属的接入点已不存在，请重新指定 providerId。' };
  }
  if (!provider.baseUrl) return { ok: false, reason: '接入点「' + provider.name + '」还没有填 Base URL。' };
  if (!provider.apiKey && !Object.keys(provider.headers || {}).length) {
    return { ok: false, reason: '接入点「' + provider.name + '」还没有填 API Key（也没有自定义鉴权头）。' };
  }

  // 改图端点留空且模型用了模板时，退回生图端点（日日新这类协议同一个入口）
  const rawPath = mode === 'edit' ? provider.editPath : provider.generatePath;
  const editFallsBack = mode === 'edit' && !String(rawPath || '').trim() && String(model.bodyTemplate || '').trim();
  const providerEndpoint = editFallsBack
    ? provider.generatePath || DEFAULT_GEN_PATH
    : mode === 'edit'
      ? rawPath || DEFAULT_EDIT_PATH
      : rawPath || DEFAULT_GEN_PATH;

  /* 端点优先级：模型级覆盖 > 接入点默认 > 协议默认。
   *
   * 这一条是「接什么模型都能适应」的关键之一。以前端点只挂在接入点上，
   * 同一个 key 下 2.5 认 /images/edits、2.6 只认 /media/generate 就表达不出来，
   * 只能把 2.6 的 caps 降成 generate（等于宣布它不能改图）。
   */
  const own = model.endpoints && typeof model.endpoints === 'object' ? model.endpoints : {};
  const ownPath = String((mode === 'edit' ? own.edit : own.generate) || '').trim();
  const endpoint = ownPath || providerEndpoint;

  // 鉴权头：模型级覆盖叠加在接入点之上（极少数站点同一 key 下不同模型要不同头）
  const headers = { ...(provider.headers || {}), ...(model.headers || {}) };

  // 结果取值路径：模型级优先，留空回落到接入点
  const resultUrlsField = String(model.resultUrlField || '').trim() || provider.resultUrlsField;

  return {
    ok: true,
    provider: {
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      taskMode: provider.taskMode,
      statusPath: provider.statusPath,
      taskIdField: provider.taskIdField,
      resultUrlsField,
      pollIntervalMs: provider.pollIntervalMs,
      pollTimeoutMs: provider.pollTimeoutMs,
      timeoutMs: provider.timeoutMs,
      headers,
    },
    model,
    url: provider.baseUrl + (endpoint.startsWith('/') ? endpoint : '/' + endpoint),
    endpoint,
    mode,
    usesTemplate: Boolean(String(model.bodyTemplate || '').trim()),
    // 模型声明了参数表 → 走声明式请求体（protocol.buildBody 的通路 0）
    usesParams: Boolean(model.params && Object.keys(model.params).length),
  };
}

/** 某个模型在某个档位下的尺寸：模型覆盖优先，其次全局覆盖，最后按面积推算。 */
export function sizeTable(config, model) {
  const out = {};
  const global = config.sizes && typeof config.sizes === 'object' ? config.sizes : {};
  const own = model?.sizes && typeof model.sizes === 'object' ? model.sizes : {};
  const tiers = new Set([...Object.keys(global), ...Object.keys(own)]);
  for (const tier of tiers) {
    out[tier] = { ...(own[tier] || {}) };
    for (const [ratio, size] of Object.entries(global[tier] || {})) {
      if (!out[tier][ratio]) out[tier][ratio] = size;
    }
  }
  return out;
}

/** 给模型/用户看的配置摘要，不含密钥本身。 */
export function describeConfig(config) {
  return {
    providers: (config.providers || []).map((p) => ({
      id: p.id,
      name: p.name,
      baseUrl: p.baseUrl,
      generatePath: p.generatePath,
      editPath: p.editPath,
      taskMode: p.taskMode,
      statusPath: p.statusPath,
      pollIntervalMs: p.pollIntervalMs,
      pollTimeoutMs: p.pollTimeoutMs,
      headers: Object.keys(p.headers || {}),
      hasKey: Boolean(p.apiKey),
      keyHint: maskKey(p.apiKey),
      models: (config.models || []).filter((m) => m.providerId === p.id).map((m) => m.name),
    })),
    models: (config.models || []).map((m) => ({
      id: m.id,
      name: m.name,
      model: m.model,
      providerId: m.providerId,
      providerName: (config.providers || []).find((p) => p.id === m.providerId)?.name || '(已删除)',
      caps: m.caps,
      hasTemplate: Boolean(String(m.bodyTemplate || '').trim()),
      resultPath: m.resultPath || '',
      maxSide: m.maxSide || 0,
      summary: m.summary || '',
      notes: m.notes || '',
      formats: m.formats || [],
      sizes: m.sizes || {},
      costHint: m.costHint || '',
      isDefault: m.id === config.defaultModel,
      providerMissing: Boolean(m.providerMissing),
      // 适配层字段：面板要能回填与展示
      params: m.params || {},
      bodyMode: m.bodyMode || 'openai',
      imagePayload: m.imagePayload || 'objects',
      endpoints: m.endpoints || { generate: '', edit: '' },
      resultUrlField: m.resultUrlField || '',
      editJson: m.editJson === true,
      headers: m.headers || {},
    })),
    defaultModel: config.defaultModel || '',
    timeoutMs: config.timeoutMs,
    outputDir: config.outputDir || '',
    recordMetadata: config.recordMetadata !== false,
  };
}

/* ------------------------------------------------------------------ */
/* 画廊 / 元数据                                                       */
/* ------------------------------------------------------------------ */

export const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|svg)$/i;

/**
 * 「作品」画廊真正扫描的目录。
 *
 * 必须只有这一处定义：落盘（runner）、列表（listImages）、面板取图/删图路由
 * 三边一旦各算各的，就会出现「图生成了、对话里也看见了，但作品页是空的」——
 * 这正是 v0.2 的 bug：saveTo 把图写到了别处，画廊却只认 <dir>/images。
 */
export function galleryDir(dir, config) {
  const out = String(config?.outputDir || '').trim();
  return out ? path.resolve(out) : path.join(dir, 'images');
}

/** 画廊列表：按 mtime 倒序，最多 limit 张。config 给了才认 outputDir 覆盖。 */
export function listImages(dir, limit = 120, config = null) {
  const outDir = galleryDir(dir, config);
  let names = [];
  try {
    names = fs.readdirSync(outDir);
  } catch {
    return [];
  }
  return names
    .filter((n) => IMAGE_EXT_RE.test(n))
    .map((n) => {
      const file = path.join(outDir, n);
      let stat = null;
      try {
        stat = fs.statSync(file);
      } catch {
        return null;
      }
      if (!stat) return null;
      const meta = readSidecar(file);
      return {
        name: n,
        file,
        bytes: stat.size,
        mtime: stat.mtimeMs,
        ...(meta ? { meta } : {}),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);
}

/** 同名 sidecar（`xxx.png.json`）：记录提示词与参数，可复现、可检索。 */
export function sidecarPath(file) {
  return file + '.json';
}

export function readSidecar(file) {
  const meta = readJson(sidecarPath(file));
  return meta && typeof meta === 'object' ? meta : null;
}

export function writeSidecar(file, meta) {
  try {
    fs.writeFileSync(sidecarPath(file), JSON.stringify(meta, null, 2));
  } catch {
    /* 元数据写不进去不影响出图 */
  }
}

/**
 * 取 images/ 下的文件名并做穿越防护。
 * 允许 `sub/name.png` 这种一层子目录（saveTo 指到 images 的子目录时会出现）。
 */
export function safeImageName(name) {
  const raw = String(name || '');
  if (!raw) return '';
  if (raw.includes('\u0000')) return '';
  const normalized = raw.replace(/\\/g, '/');
  if (normalized.startsWith('/') || normalized.includes('..')) return '';
  if (!IMAGE_EXT_RE.test(normalized)) return '';
  return normalized;
}
