/**
 * dsh-image-gen · Host 半
 *
 * 三条贡献：
 *   1. `image_generate` —— 模型在对话里调的生图/改图工具。生成的图片既落盘，
 *      也作为 durable attachment 回传，所以模型自己「看得见」刚生成的图。
 *      参考图可以直接引用对话里最近的图（`@last`），不必先落到本地。
 *   2. `image_config` —— 读写接入点/模型配置 + 免费探活 + 模板校验 + 画廊管理。
 *      密钥只回显首尾四位。
 *   3. `/dsh-image-gen/*` —— 供侧边栏面板读写的 HTTP 路由（面板与工具共用同一份配置）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FORMATS,
  RATIOS,
  RES_AREA,
  defaultSizes,
  normalizeFormat,
  sniffExt,
  validateTemplate,
} from './protocol.js';
import { describeParams, editableParams, normalizeParamsChecked } from './adapter.js';
import {
  describeConfig,
  galleryDir,
  listImages,
  loadConfig,
  makeId,
  maskKey,
  mergePreservingKeys,
  mutateConfig,
  readSidecar,
  resolveDir,
  resolveModel,
  safeImageName,
  saveConfig,
  sidecarPath,
  sizeTable,
} from './store.js';
import {
  HOST_IMAGE_EXT,
  probeEndpoint,
  runGeneration,
  testProvider,
} from './runner.js';

export const TOOL_GENERATE = 'image_generate';
export const TOOL_CONFIG = 'image_config';
export const TOOL_ADMIN = 'image_admin';
const ROUTE_PREFIX = '/dsh-image-gen';
const FORM_CACHE_DIR = 'cache';

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

/** 会话里最近 N 张图片附件（用于 `images: ["@last"]`）。 */
function recentSessionImages(ctx, sessionId, limit = 1) {
  const sessions = ctx.get('sessions');
  if (!sessions || !sessionId) return [];
  const session = sessions.get(sessionId);
  if (!session) return [];
  let events = [];
  try {
    events = session.snapshotEvents?.() || [];
  } catch {
    return [];
  }
  const out = [];
  const seen = new Set();
  for (let i = events.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const ev = events[i];
    if (!ev) continue;
    // user/message 的 data 本身就是消息；tool/result 与 assistant/message 的 data.message 才是消息
    const message = ev.type === 'user/message' ? (ev.data?.message ?? ev.data) : ev.data?.message;
    const blocks = Array.isArray(message?.content) ? message.content : [];
    for (let j = blocks.length - 1; j >= 0 && out.length < limit; j -= 1) {
      const block = blocks[j];
      const ref = block && block.type === 'image' ? block.attachment : null;
      if (!ref || !ref.attachmentId) continue;
      const id = String(ref.attachmentId);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(ref);
    }
  }
  return out;
}

/**
 * 把 `@last` / `@last:2` 这类占位解析成本机文件路径（临时目录里的 PNG），
 * 好让 runner 统一按「路径」处理参考图。返回 { paths, notes }。
 */
async function materializeRecentImages(ctx, sessionId, refs, dir) {
  const attachments = ctx.get('attachments');
  if (!attachments) throw new Error('宿主没有 attachments 服务，无法读取对话里的参考图。');
  const cacheDir = path.join(dir, FORM_CACHE_DIR);
  fs.mkdirSync(cacheDir, { recursive: true });
  const paths = [];
  const notes = [];
  for (const ref of refs) {
    try {
      const stored = await attachments.readImage(ref);
      const data = stored?.data || stored?.bytes;
      if (!data || !data.length) throw new Error('附件内容为空');
      const media = String(stored?.ref?.mediaType || stored?.mediaType || ref.mediaType || 'image/png');
      const ext = media === 'image/jpeg' ? 'jpg' : media.split('/')[1] || 'png';
      // attachmentId 里可能带冒号（如 sha256:abcd…），Windows 上会被当成 NTFS 数据流，
      // 所以文件名一律只保留字母数字，再加一段内容哈希避免碰撞。
      const idPart = String(ref.attachmentId).replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
      const file = path.join(cacheDir, 'ref-' + idPart + '.' + ext);
      if (!fs.existsSync(file) || fs.statSync(file).size !== data.length) fs.writeFileSync(file, data);
      paths.push(file);
    } catch (e) {
      notes.push('读不到对话里的图：' + String((e && e.message) || e));
    }
  }
  return { paths, notes };
}

/** 解析 `images` 参数：把 `@last` 折叠成路径，其余原样保留。 */
async function expandImages(ctx, sessionId, input, dir) {
  const list = Array.isArray(input) ? input.map((x) => String(x || '').trim()).filter(Boolean) : [];
  const plain = [];
  const wanted = [];
  for (const item of list) {
    const m = /^@(last|recent)(?::(\d+))?$/i.exec(item);
    if (!m) {
      plain.push(item);
      continue;
    }
    const count = Math.max(1, Math.min(4, Number(m[2]) || 1));
    wanted.push(count);
  }
  const notes = [];
  let fromSession = [];
  if (wanted.length) {
    const count = Math.max(...wanted);
    const refs = recentSessionImages(ctx, sessionId, count);
    if (!refs.length) {
      // 请求了 @last 却拿不到图：必须报错，不能静默退化成文生图 —— 那会白花一次钱，
      // 而且用户以为是在改图。
      throw new Error(
        '要引用对话里的图（@last），但当前会话里找不到可用的图片附件。' +
          '请改用本机图片路径，或先在对话里发一张图。',
      );
    }
    const materialized = await materializeRecentImages(ctx, sessionId, refs, dir);
    fromSession = materialized.paths;
    notes.push(...materialized.notes);
    if (!fromSession.length) {
      throw new Error('读到了对话里的图片附件，但无法解码成文件：' + notes.join('；'));
    }
  }
  return { images: [...fromSession, ...plain], notes };
}

/* ------------------------------------------------------------------ */
/* 工具：image_generate                                                */
/* ------------------------------------------------------------------ */

function generateParameters() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['prompt'],
    properties: {
      prompt: { type: 'string', description: '图片描述。改图时描述「要怎么改」。' },
      model: {
        type: 'string',
        description: '模型名或模型 ID。省略则用默认模型。不确定有哪些可选时先调 image_config op=models。',
      },
      ratio: {
        type: 'string',
        enum: RATIOS,
        description: '画幅比例，默认 1:1。与 size 二选一（给了 size 就忽略它）。',
      },
      resolution: {
        type: 'string',
        enum: ['1K', '2K', '4K'],
        description: '分辨率档，默认 1K。与 ratio 配合按面积恒定换算像素。',
      },
      size: {
        type: 'string',
        description: '具体尺寸，如 "1024x1024" 或 "auto"。与 ratio+resolution 二选一。',
      },
      quality: { type: 'string', description: '质量档，如 low / medium / high / hd。各接口含义不同。' },
      format: {
        type: 'string',
        enum: FORMATS,
        description:
          '产出格式，默认 png（静图）。gif 是动图（部分模型支持）；svg 是矢量源码。' +
          '用户要插画/照片/封面时用 png，别用 gif。',
      },
      background: {
        type: 'string',
        enum: ['auto', 'opaque', 'transparent'],
        description: '背景；只有非 auto 才发进请求。需要 PNG 透明背景的素材用 transparent。',
      },
      n: { type: 'integer', description: '生成张数 1-4，默认 1。每张单独计费。' },
      images: {
        type: 'array',
        items: { type: 'string' },
        description:
          '参考图：本机路径、http(s) 图片地址，或 "@last"（对话里最近生成/收到的图）。' +
          '给一张以上就走改图；"@last" 让你能在一张图上连续改。',
      },
      mask: { type: 'string', description: '蒙版图路径（局部重绘用，仅默认 OpenAI 协议或模板 {{mask}} 支持）。' },
      negative: { type: 'string', description: '反向提示词，仅请求体模板消费（{{negative}}）。' },
      seed: { type: 'integer', description: '随机种子，仅请求体模板消费（{{seed}}）。固定它可以复现同一张图。' },
      strength: { type: 'number', description: '改图强度 0-1，仅请求体模板消费（{{strength}}）。' },
      params: {
        type: 'object',
        additionalProperties: true,
        description:
          '模型私有参数（按该模型 image_config op=models 里列出的「可调参数」填）。' +
          '例如 {"version":"sunburst","complexity":3}。只对这个模型有效，别的模型不认识会忽略。',
      },
      saveTo: {
        type: 'string',
        description:
          '额外导出的目录（可选）。图片主副本永远存在插件画廊里（「作品」页能看到），这里填了会再复制一份过去。',
      },
    },
  };
}

/** 给模型的回执：JSON 信封 + 人读摘要两个 text 块，然后图片块。 */
function renderGenerate(_args, value) {
  const blocks = [];
  if (value && value.envelope) blocks.push({ type: 'text', text: JSON.stringify(value.envelope) });
  blocks.push({ type: 'text', text: String((value && value.text) || '') });
  for (const image of (value && value.images) || []) {
    if (image) blocks.push({ type: 'image', attachment: image });
  }
  return blocks;
}

/** 批量把图片变成宿主 attachment（失败不静默：把原因写进回执）。 */
async function attachImages(ctx, entries) {
  const attachments = ctx.get('attachments');
  if (!attachments) return { refs: [], why: ['宿主没有 attachments 服务，图片只落盘未回传。'] };
  const limits = attachments.imageLimits || {};
  const accepted = new Set((limits.mediaTypes || []).filter(Boolean));
  const usable = [];
  const why = [];
  for (const entry of entries) {
    if (accepted.size && !accepted.has(entry.mediaType)) {
      why.push(entry.mediaType + ' 不在宿主支持范围内（支持：' + [...accepted].join('/') + '），该图只落盘。');
      continue;
    }
    if (limits.maxImageBytes && entry.bytes.length > limits.maxImageBytes) {
      why.push('图片 ' + Math.round(entry.bytes.length / 1024) + 'KB 超过宿主单图上限，只落盘未回传。');
      continue;
    }
    usable.push(entry);
  }
  if (!usable.length) return { refs: [], why };

  try {
    if (typeof attachments.saveImages === 'function' && usable.length > 1) {
      const refs = await attachments.saveImages(usable.map((e) => ({ data: e.bytes, mediaType: e.mediaType, name: e.name })));
      return { refs: [...refs], why };
    }
  } catch (e) {
    why.push('批量回传失败，改逐张重试：' + String((e && e.message) || e));
  }

  const refs = [];
  for (const entry of usable) {
    try {
      const ref = await attachments.saveImage({ data: entry.bytes, mediaType: entry.mediaType, name: entry.name });
      refs.push(ref);
    } catch (e) {
      why.push('saveImage 失败：' + String((e && e.message) || e));
    }
  }
  return { refs, why };
}

/** 给模型看的「有哪些模型可选」清单。 */
function modelMenu(config, mode) {
  const usable = (config.models || []).filter((m) =>
    mode === 'edit' ? m.caps === 'edit' || m.caps === 'both' : m.caps === 'generate' || m.caps === 'both',
  );
  return usable.map((m) => {
    const line = { name: m.name, model: m.model, caps: m.caps };
    const provider = (config.providers || []).find((p) => p.id === m.providerId);
    if (provider) line.provider = provider.name;
    if (m.summary) line.summary = m.summary;
    if (m.notes) line.notes = m.notes;
    if (Array.isArray(m.formats) && m.formats.length) line.formats = m.formats;
    // 默认出图格式：调用时不传 format 就会用这个。模型配置里钉死 gif 的会在这里显示出来，
    // 让模型知道「这个模型默认出动图，要静图得显式 format="png"」。
    const preset = normalizeFormat(m.extra?.params?.output_format) || normalizeFormat(m.extra?.output_format);
    line.defaultFormat = preset && preset !== 'gif' ? preset : 'png';
    if (m.maxSide) line.maxSide = m.maxSide;
    if (m.costHint) line.cost = m.costHint;
    if (m.id === config.defaultModel) line.isDefault = true;
    // 适配层：模型自己声明的可调参数，AI 据此填 image_generate 的 params
    const specs = describeParams(m.params);
    if (specs.length) line.params = specs;
    return line;
  });
}

function menuText(menu) {
  if (!menu.length) return '';
  return (
    '\n\n可选模型：\n' +
    menu
      .map((m) => {
        const bits = [m.name + '（model=' + m.model + '）' + (m.isDefault ? ' [默认]' : '')];
        if (m.summary) bits.push('  能力：' + m.summary);
        if (m.notes) bits.push('  备注：' + m.notes);
        if (m.formats) bits.push('  格式：' + m.formats.join('/'));
        return '· ' + bits.join('\n');
      })
      .join('\n')
  );
}

export function buildGenerateTool(ctx, configDir) {
  return {
    name: TOOL_GENERATE,
    description:
      '用已配置的生图接口生成图片，并把图片直接回传（你能看到结果，用户也能在对话里看到）。' +
      '不给 images 是文生图；给 images（本机路径 / http URL / "@last"）是改图，"@last" 指对话里最近的一张图。' +
      '**先调 image_config op=models 看有哪些模型**：每个模型带自定义声明（summary / notes / formats）、默认出图格式，' +
      '有的还带「可调参数」清单 —— 那些就是填进 params 的模型私有参数（如版本、画质档、复杂度）。' +
      '按需求挑合适的模型，不要总用默认。' +
      '**格式**：默认出 png 静图。用户说「画一张图/海报/插画/照片/封面」时**不要传 format**，或显式传 format="png"；' +
      '只有用户明确要动图（GIF、表情包动画、会动的）时才传 format="gif"。' +
      '用户没说尺寸就按默认 1K；说了「1K/2K/4K」用 resolution，说了横竖版用 ratio。' +
      '每次调用都会产生接口费用；不要为了"看看效果"重复生成同一提示词。' +
      '还没配置时调 image_config op=guide。',
    parameters: generateParameters(),
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        required: ['text'],
        properties: {
          text: { type: 'string' },
          envelope: { type: 'object', additionalProperties: true },
          images: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      render: renderGenerate,
    },
    isConcurrencySafe: () => true,
    timeoutMs: 600000,
    async execute(args, exec) {
      const dir = resolveDir(configDir);
      const config = loadConfig(dir);
      const requested = String(args?.model || '').trim();
      // exec.agent.session.id 才是会话 id；agent.id 在有 fork/子代理时可能不同，
      // 取错会让 @last 永远找不到图。两个都试一遍，优先 session。
      const sessionId = exec?.agent?.session?.id || exec?.agent?.id || '';

      // ---- 参考图（含 @last 折叠） ----
      let expanded;
      try {
        expanded = await expandImages(ctx, sessionId, args?.images, dir);
      } catch (e) {
        return { text: '参考图解析失败：' + String((e && e.message) || e), envelope: { ok: false } };
      }
      const mode = expanded.images.length ? 'edit' : 'generate';
      const resolved = resolveModel(config, requested, mode);
      if (!resolved.ok) {
        const menu = modelMenu(config, mode);
        return {
          text: '无法生成：' + resolved.reason + menuText(menu),
          envelope: { ok: false, reason: resolved.reason, available: menu.map((m) => m.name) },
        };
      }

      let result;
      const exportNotes = [];
      try {
        result = await runGeneration({
          resolved,
          config,
          args: { ...(args || {}), images: expanded.images, prompt: args?.prompt },
          dir,
          // saveTo 是「额外导出」，主副本固定在画廊目录里
          outputDir: args?.saveTo ? path.resolve(String(args.saveTo)) : '',
          signal: exec?.signal,
          onExportError: (why) => exportNotes.push(why),
        });
      } catch (e) {
        const message = String((e && e.message) || e);
        return {
          text: '生成失败：' + message,
          envelope: { ok: false, reason: message, url: resolved.url, model: resolved.model.name, refs: expanded.images },
        };
      }

      // ---- 回传图片 ----
      const hostable = [];
      const vectors = [];
      for (const f of result.files) {
        if (f.vector) {
          // SVG 是矢量源码，宿主的 attachment 只收位图 —— 直接内联给模型看，
          // 比报一个「不支持」更有用：模型能自己判断路径对不对、要不要改。
          let svg = '';
          try {
            svg = fs.readFileSync(f.file, 'utf8');
          } catch {
            svg = '（读取失败）';
          }
          vectors.push({ path: f.file, svg: svg.length > 16000 ? svg.slice(0, 16000) + '\n<!-- 已截断 -->' : svg });
          continue;
        }
        if (!HOST_IMAGE_EXT.includes(f.ext)) continue;
        hostable.push({
          bytes: fs.readFileSync(f.file),
          mediaType: f.mediaType,
          name: path.basename(f.file),
        });
      }
      const attached = await attachImages(ctx, hostable);

      const lines = [];
      const seconds = Math.round(result.elapsedMs / 100) / 10;
      lines.push('已生成 ' + result.files.length + ' 张 · ' + result.model + ' · ' + result.size + ' · ' + seconds + 's');
      for (const f of result.files) {
        const dims = f.width && f.height ? ' ' + f.width + '×' + f.height : '';
        lines.push('文件：' + f.file + dims + '（' + Math.round(f.bytes / 1024) + ' KB）');
      }
      lines.push('已存入「作品」画廊，可在侧边栏「生图」面板回看。');
      if (exportNotes.length) lines.push('⚠ 额外导出失败：' + exportNotes.join('；'));
      if (expanded.notes.length) lines.push('参考图提示：' + expanded.notes.join('；'));
      if (vectors.length) {
        lines.push(
          '以下 ' + vectors.length + ' 个是 SVG 矢量图，已按文本内联（对话里不作为图片显示，可用浏览器打开文件）：',
        );
        for (const v of vectors) lines.push(v.svg);
      }
      if (attached.why.length) lines.push('⚠ ' + attached.why.join('；'));

      return {
        text: lines.join('\n'),
        envelope: {
          ok: true,
          model: result.model,
          modelId: result.modelId,
          provider: result.provider,
          mode: result.mode,
          size: result.size,
          elapsedMs: result.elapsedMs,
          refs: result.refs,
          files: result.files.map((f) => ({
            path: f.file,
            bytes: f.bytes,
            ...(f.width && f.height ? { width: f.width, height: f.height } : {}),
            ...(f.vector ? { vector: true } : {}),
            ...(f.extraFile ? { extraFile: f.extraFile } : {}),
          })),
          attached: attached.refs.length,
        },
        images: attached.refs,
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/* 工具：image_config                                                  */
/* ------------------------------------------------------------------ */

/**
 * 查询类 op：日常最常用，schema 保持极小 —— 常驻上下文里只占几百字符。
 * 写配置的操作全部挪到 image_admin，因为它们的参数（baseUrl / apiKey / bodyTemplate …）
 * 占 4K 字符，而 AI 平时根本用不到。
 */
const QUERY_OPS = ['list', 'models', 'guide', 'gallery', 'gallery.delete'];

/** 写配置类 op（只出现在 image_admin 里）。 */
const ADMIN_OPS = [
  'provider.add',
  'provider.update',
  'provider.remove',
  'model.add',
  'model.update',
  'model.remove',
  'model.discover',
  'default.set',
  'test',
  'probe',
  'template.check',
];

const OPS = [...QUERY_OPS, ...ADMIN_OPS];

/** 判断一个模型 id 看着像不像生图/改图模型（用于 discover 过滤）。 */
const IMAGE_MODEL_HINT = /(image|imagen|dall|flux|sd[-_]?xl|stable-?diffusion|midjourney|seedream|seedance-image|wanx|kolors|hunyuan.{0,6}image|qwen.{0,4}image|tt-image|gpt-image|nano-?banana|recraft|ideogram|sdxl|playground|doubao.{0,6}seedream)/i;

/** 查询类工具的参数：只留真正会用到的几个。 */
function queryParameters() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['op'],
    properties: {
      op: {
        type: 'string',
        enum: QUERY_OPS,
        description:
          'list=看配置与就绪状态；models=看可用模型及声明（挑模型前先看，默认同时列生图与改图）；' +
          'guide=没配置时看要收哪些信息；gallery=看历史图与提示词；gallery.delete=删图。' +
          '要新增/修改接入点或模型，用 image_admin。',
      },
      caps: {
        type: 'string',
        enum: ['both', 'generate', 'edit'],
        description: 'models：只列某一类模型。省略=生图和改图都列，这是推荐用法。',
      },
      limit: { type: 'number', description: 'gallery：返回多少条，默认 20。' },
      query: { type: 'string', description: 'gallery：按提示词/模型名过滤。' },
      names: {
        type: 'array',
        items: { type: 'string' },
        description: 'gallery.delete：要删除的图片文件名（gallery 返回的 name）。',
      },
    },
  };
}

/** 配置类工具的参数：字段多，但只在真正改配置时才会被读到。 */
function adminParameters() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['op'],
    properties: {
      op: {
        type: 'string',
        enum: ADMIN_OPS,
        description:
          'provider.*=增删改接入点；model.*=增删改模型；model.discover=从站点批量导入；' +
          'default.set=设默认模型；probe=免费探活（GET /models，不产生生成费用）；' +
          'test=发一次最小生成请求验连通（会产生少量费用）；template.check=校验请求体模板。',
      },
      id: { type: 'string', description: 'provider.*/model.* 的目标 id（update / remove 用）。' },
      name: { type: 'string', description: '接入点或模型的显示名。' },
      providerId: { type: 'string', description: 'model.add/update：所属接入点 id；test/probe：要测的接入点 id。' },
      baseUrl: { type: 'string', description: 'provider.*：只填到版本号为止，例如 https://api.example.com/v1。' },
      apiKey: { type: 'string', description: 'provider.*：该接入点的密钥。' },
      generatePath: { type: 'string', description: 'provider.*：生图端点，默认 /images/generations。' },
      editPath: { type: 'string', description: 'provider.*：改图端点，默认 /images/edits；留空且模型有模板时退回生图端点。' },
      taskMode: {
        type: 'string',
        enum: ['sync', 'poll'],
        description: 'provider.*：sync=请求直接返回图片；poll=异步任务，提交拿 task_id 后轮询状态。',
      },
      statusPath: { type: 'string', description: 'provider.*：taskMode=poll 时的状态查询端点，默认 /media/status。' },
      taskIdField: { type: 'string', description: 'provider.*：从提交响应里取 task_id 的点路径，默认 data.task_id。' },
      resultUrlsField: { type: 'string', description: 'provider.*：从轮询响应里取图片地址的点路径，默认 result_url。' },
      pollIntervalMs: { type: 'number', description: 'provider.*：轮询间隔毫秒，默认 3000。' },
      pollTimeoutMs: { type: 'number', description: 'provider.*：轮询总超时毫秒，默认 300000。' },
      headers: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'provider.*：额外请求头，如 {"x-api-key":"…"}。authorization 会自动用 apiKey 填。',
      },
      model: { type: 'string', description: 'model.*：请求体里 model 字段的值，必须与服务商完全一致。' },
      caps: { type: 'string', enum: ['both', 'generate', 'edit'], description: 'model.*：适用能力，默认 both。' },
      bodyTemplate: {
        type: 'string',
        description:
          'model.*：请求体模板，留空按 OpenAI 协议。占位符见 op=template.check 的报错清单：' +
          '{{prompt}} {{negative}} {{model}} {{n}} {{size}} {{size_star}} {{quality}} {{ratio}} {{resolution}} ' +
          '{{background}} {{seed}} {{strength}} {{mask}} {{images}} {{image_blocks}} {{image_urls}}。',
      },
      resultPath: {
        type: 'string',
        description:
          'model.*：结果取值路径，支持 a.b[0].c 与展开 a[].b，可用逗号写多个候选，例如 output.results[].url。留空自动嗅探。',
      },
      maxSide: { type: 'number', description: 'model.*：长边上限（像素）。超过会自动等比缩小请求尺寸。' },
      extra: {
        type: 'object',
        additionalProperties: true,
        description: 'model.*：浅合并到请求体顶层的额外参数，如 {"version":"sunburst","params":{"quality":"high"}}。',
      },
      sizes: {
        type: 'object',
        additionalProperties: true,
        description: 'model.*：该模型的尺寸覆盖，如 {"2K":{"16:9":"2560x1440"}}；不放心的尺寸交给自动换算。',
      },
      params: {
        type: 'object',
        additionalProperties: true,
        description:
          'model.*：**模型私有参数声明表**（接新模型的核心，不用改代码）。写法：' +
          '{"version":["standard","pro"],"complexity":{"type":"int","min":1,"max":3,"default":2,"label":"复杂度"},' +
          '"output_format":{"type":"enum","values":["png","gif"],"from":"format","at":"params"}}。' +
          '简写数组=枚举（第一个是默认）；固定值=钉死；from 把通用参数（format/size/quality…）桥接到站点私有名；' +
          'at 指定放进哪个容器（如 params / input.parameters）。声明了这个就走声明式请求体。',
      },
      bodyMode: {
        type: 'string',
        enum: ['openai', 'minimal', 'custom'],
        description: 'model.*：请求体骨架。openai=默认（带 model/prompt/size/quality/n）；minimal=只带 model/prompt/n；custom=全交给 params。',
      },
      imagePayload: {
        type: 'string',
        enum: ['objects', 'urls', 'image', 'image_strings'],
        description:
          'model.*：参考图装载形态。objects=[{"image_url":"…"}]（默认）；urls=["…"]；' +
          'image_strings=image:["…"]（字段名单数、值是字符串数组）；image=单图对象。',
      },
      endpoints: {
        type: 'object',
        additionalProperties: true,
        description:
          'model.*：模型级端点覆盖 {"generate":"/media/generate","edit":"/media/generate"}。' +
          '解决「同一个 key 下不同模型认不同端点」——这正是 gpt-image-2.6 不能改图的根因。',
      },
      resultUrlField: {
        type: 'string',
        description: 'model.*：该模型的结果取值路径（覆盖接入点的 resultUrlsField），如 result_url 或 data.result_urls[]。',
      },
      editJson: {
        type: 'boolean',
        description: 'model.*：改图时改用 JSON 请求体（参考图塞 images 数组）而不是 multipart。声明了 params 时自动生效。',
      },
      summary: {
        type: 'string',
        description: 'model.*：一句话说明这个模型能干嘛、擅长什么。image_generate 会把它给模型看，让它自己挑。',
      },
      notes: { type: 'string', description: 'model.*：细节备注——尺寸限制、速度、已知坑、适用场景。' },
      costHint: { type: 'string', description: 'model.*：费用提示，如「按次计费 · 约 0.2 元/张」，帮模型权衡。' },
      formats: {
        type: 'array',
        items: { type: 'string' },
        description: 'model.*：能产出的格式，如 ["png","gif","svg"]。svg 会按文本内联回传，其余按图片显示。',
      },
      modelId: { type: 'string', description: 'default.set / test / probe 的目标模型 id。' },
      template: { type: 'string', description: 'template.check：要校验的请求体模板。' },
      endpoint: { type: 'string', description: 'probe：探活路径，默认 /models。' },
      filter: {
        type: 'string',
        description: 'model.discover：只导入名字匹配这个正则的模型，如 "image|flux"；省略则只导入看起来像生图的模型。',
      },
      all: { type: 'boolean', description: 'model.discover：true = 导入站点报告的每一个模型（含视频、文本模型）。' },
    },
  };
}

function describeReadiness(config) {
  return (config.providers || []).map((provider) => {
    const models = (config.models || []).filter((m) => m.providerId === provider.id);
    const problems = [];
    if (!provider.baseUrl) problems.push('缺 Base URL');
    if (!provider.apiKey && !Object.keys(provider.headers || {}).length) problems.push('缺 API Key');
    if (!models.length) problems.push('没有模型');
    return {
      provider: provider.name,
      id: provider.id,
      baseUrl: provider.baseUrl || '(未填)',
      taskMode: provider.taskMode,
      problems,
      models: models.map((m) => {
        const r = resolveModel(config, m.id, m.caps === 'edit' ? 'edit' : 'generate');
        return {
          id: m.id,
          name: m.name,
          model: m.model,
          ready: r.ok,
          reason: r.ok ? '' : r.reason,
          summary: m.summary || '',
          notes: m.notes || '',
          formats: m.formats || [],
          costHint: m.costHint || '',
        };
      }),
    };
  });
}

function renderConfig(_args, value) {
  return [{ type: 'text', text: String((value && value.text) || '') }];
}

/** 两个工具共用的 execute：按 op 分派，越界的 op 直接拒绝。 */
function makeConfigExecute(configDir, allowed) {
  return async function execute(args) {
    const op = String(args?.op || 'list');
    if (!allowed.includes(op)) {
      return {
        text:
          'op=' + op + ' 不属于这个工具。本工具可用：' + allowed.join(' / ') +
          (QUERY_OPS.includes(op) ? '' : '（配置类操作请用 image_admin）'),
      };
    }
    return executeConfigOp(configDir, args);
  };
}

const OUTPUT_SCHEMA = {
  schema: {
    type: 'object',
    additionalProperties: true,
    required: ['text'],
    properties: { text: { type: 'string' } },
  },
  render: renderConfig,
};

export function buildQueryTool(configDir) {
  return {
    name: TOOL_CONFIG,
    description:
      '查看生图插件的现状：op=list 看接入点与就绪状态；op=models 看可用模型及它们的自定义声明（**挑模型前先看这个**，' +
      '默认同时列生图和改图两类）；op=gallery 看历史图与提示词；op=guide 在没配置时看要收哪些信息。' +
      '不产生任何生成费用，可以放心调。新增/修改接入点或模型请用 image_admin。',
    parameters: queryParameters(),
    output: OUTPUT_SCHEMA,
    isConcurrencySafe: () => true,
    timeoutMs: 60000,
    execute: makeConfigExecute(configDir, QUERY_OPS),
  };
}

export function buildAdminTool(configDir) {
  return {
    name: TOOL_ADMIN,
    description:
      '改生图插件的配置（等价于侧边栏「生图」面板里的表单）：provider.* / model.* 增删改、model.discover 批量导入、' +
      'default.set 设默认、probe 免费探活、test 真发一次验连通（会产生少量费用）、template.check 校验模板。' +
      'API Key 只回显首尾四位；不要把密钥写进对话正文。' +
      '给模型写 summary/notes/formats/costHint 就是给它一份「自我介绍」，之后 image_generate 会照着挑。',
    parameters: adminParameters(),
    output: OUTPUT_SCHEMA,
    isConcurrencySafe: () => false,
    timeoutMs: 120000,
    execute: makeConfigExecute(configDir, ADMIN_OPS),
  };
}

/** 旧名保留：面板与已有调用方还在用 buildConfigTool。 */
export function buildConfigTool(configDir) {
  return {
    name: TOOL_CONFIG,
    description:
      '管理生图插件的接入点与模型（等价于侧边栏「生图」面板里的表单）。op=list 先看现状；' +
      'op=models 列出可用模型与它们的自定义声明；op=guide 在没配置时告诉你该收哪些信息；' +
      'op=probe 免费探活（不产生生成费用），op=test 真发一次生成请求（会产生少量费用）。' +
      'API Key 只回显首尾四位；不要把密钥写进对话正文。',
    parameters: adminParameters(),
    output: OUTPUT_SCHEMA,
    isConcurrencySafe: () => false,
    timeoutMs: 120000,
    execute: makeConfigExecute(configDir, OPS),
  };
}

/** 所有 op 的实现（两个工具共用这一份）。 */
async function executeConfigOp(configDir, args) {
  const dir = resolveDir(configDir);
  const op = String(args?.op || 'list');

  try {
        if (op === 'guide') {
          return {
            text: [
              '需要两样东西，问用户要：',
              '1) 接入点：Base URL（只到版本号，如 https://api.example.com/v1）+ API Key。',
              '2) 模型：model ID（服务商给的原始名字，如 gpt-image-1 / tt-image-2.5）。',
              '拿到后依次：',
              '  image_admin op=provider.add name="…" baseUrl="…" apiKey="…"',
              '  image_admin op=model.add providerId=<上一步返回的 id> name="…" model="…"',
              '  image_admin op=probe（免费，验地址与密钥）',
              '  image_admin op=test（真发一次，验模型名与出图解析）',
              '',
              '**如果站点有私有参数（版本 / 画质档 / 复杂度…）**，给模型写 params 声明表，',
              '之后 AI 和面板都能按它传参，不用改代码。写法：',
              '  image_admin op=model.update id=<模型id> params={',
              '    "version":["standard","pro"],                        // 数组=可选值，第一个是默认',
              '    "quality":{"type":"enum","values":["low","high"],"default":"high","label":"画质"},',
              '    "output_format":{"from":"format","at":"params"}       // 跟随通用参数 format',
              '  }',
              '不确定合法值时，先用「n 传非法值」的方式撞一次（站点会在建任务前拒绝并报出合法值），',
              '别用其它参数撞 —— 有的站不校验参数名，会直接建任务扣钱。',
              '',
              '**如果这个模型的端点和接入点不一样**（同一 key 下不同模型认不同端点），加：',
              '  endpoints={"generate":"/media/generate","edit":"/media/generate"}',
              '若参考图字段不是 images:[{image_url}] 那种，再用 imagePayload 指定形态（objects/urls/image/image_strings）。',
              '请求体骨架要精简用 bodyMode="minimal"（只带 model/prompt/n）。',
              '',
              '异步任务型站点（提交后要轮询）再加 taskMode="poll"、statusPath、taskIdField、resultUrlsField。',
              '请求体形状完全不是扁平结构的，才需要 bodyTemplate（配 op=template.check 先校验）。',
              '用户也可以打开侧边栏「生图」面板手工填。',
            ].join('\n'),
          };
        }

        if (op === 'models') {
          const config = loadConfig(dir);
          const asked = String(args?.caps || '').trim();
          // 不传 caps 就两类都列 —— 以前默认只列「生图」，导致改图专用的模型
          // （比如只标了 caps=edit 的那个）在名单里看不见，模型会以为它不存在。
          const modes = asked === 'edit' || asked === 'generate' ? [asked] : ['generate', 'edit'];
          const blocks = [];
          let listed = 0;
          for (const mode of modes) {
            const menu = modelMenu(config, mode);
            if (!menu.length) {
              if (asked) blocks.push('没有可用于' + (mode === 'edit' ? '改图' : '生图') + '的模型。先在面板或 image_admin 里加一个。');
              continue;
            }
            listed += menu.length;
            const lines = [];
            lines.push('可用于' + (mode === 'edit' ? '改图' : '生图') + '的模型 ' + menu.length + ' 个：');
            for (const m of menu) {
              lines.push('');
              lines.push('· ' + m.name + '（model=' + m.model + '）' + (m.isDefault ? ' [默认]' : '') + ' · caps=' + m.caps);
              if (m.provider) lines.push('  接入点：' + m.provider);
              if (m.summary) lines.push('  能力：' + m.summary);
              if (m.notes) lines.push('  备注：' + m.notes);
              if (m.formats) lines.push('  能产出的格式：' + m.formats.join(' / '));
              lines.push('  不传 format 时出：' + m.defaultFormat + (m.defaultFormat === 'png' ? '（静图）' : ''));
              if (m.maxSide) lines.push('  长边上限：' + m.maxSide + 'px');
              if (m.cost) lines.push('  费用：' + m.cost);
              if (m.params && m.params.length) {
                // 适配层：模型自己声明的私有参数，直接告诉 AI 怎么填
                lines.push('  可调参数（填在 params 里）：');
                for (const p of m.params) lines.push('    - ' + p);
                lines.push('  调用示例：image_generate model="' + m.name + '" prompt="…" params={…}');
              } else {
                lines.push('  调用：image_generate model="' + m.name + '" prompt="…"');
              }
            }
            blocks.push(lines.join('\n'));
          }
          if (!listed) {
            return { text: '没有任何可用模型。先在面板或 image_admin 里加一个。' };
          }
          // 同时具备两种能力的模型会在两栏里各出现一次；这里说明一下，免得以为重复。
          const dup = (config.models || []).some((m) => m.caps === 'both');
          if (!asked && dup) blocks.push('（caps=both 的模型两栏都会出现，是同一个模型，不是重复配置。）');
          return { text: blocks.join('\n\n') };
        }

        if (op === 'list') {
          const config = loadConfig(dir);
          const summary = describeConfig(config);
          const readiness = describeReadiness(config);
          if (!summary.providers.length) {
            return {
              text:
                '还没有任何接入点。\n配置目录：' +
                dir +
                '\n\n先调 op=guide 看需要收集哪些信息，或者让用户打开侧边栏「生图」面板手工填。',
            };
          }
          const lines = [];
          lines.push('配置目录：' + dir);
          const defName = (config.models || []).find((m) => m.id === config.defaultModel)?.name;
          lines.push('默认模型：' + (defName ? defName + '（id=' + config.defaultModel + '）' : '(未设，用第一个可用模型)'));
          lines.push('图片目录：' + galleryDir(dir, config));
          for (const row of readiness) {
            lines.push('');
            lines.push('接入点「' + row.provider + '」' + (row.problems.length ? ' ⚠ ' + row.problems.join('、') : ' ✓'));
            lines.push('  baseUrl: ' + row.baseUrl + (row.taskMode === 'poll' ? '（异步轮询）' : ''));
            if (!row.models.length) lines.push('  （没有模型）');
            for (const m of row.models) {
              lines.push('  模型 ' + m.name + ' (' + m.model + ') ' + (m.ready ? '✓ 可用' : '⚠ ' + m.reason));
            }
          }
          return { text: lines.join('\n') };
        }

        if (op === 'probe') {
          const config = loadConfig(dir);
          const wanted = String(args?.providerId || '').trim();
          const provider = wanted
            ? (config.providers || []).find((p) => p.id === wanted)
            : (config.providers || [])[0];
          if (!provider) return { text: '没有可探活的接入点。先 op=provider.add。' };
          const r = await probeEndpoint(provider, String(args?.endpoint || '/models'));
          if (!r.ok) return { text: '探活 ✗ · ' + r.reason };
          const lines = ['探活 ✓ · HTTP ' + r.status + ' · ' + r.url];
          if (r.count !== null) {
            const shown = (r.models || []).slice(0, 15);
            lines.push(
              '该接入点报告 ' + r.count + ' 个模型' +
                (shown.length ? '，前几个：' + shown.join('、') + (r.count > shown.length ? ' …' : '') : '') +
                '。',
            );
            if (r.count) lines.push('要批量加进模型列表，用 op=model.discover（可按 filter 过滤），别一个个 model.add。');
          }
          lines.push('这只能证明「地址 + 密钥」可用；模型名对不对要用 op=test 验证（会真发一次生成）。');
          return { text: lines.join('\n') };
        }

        if (op === 'template.check') {
          const tpl = String(args?.template ?? args?.bodyTemplate ?? '').trim();
          if (!tpl) return { text: 'template.check 需要 template（或 bodyTemplate）。' };
          try {
            const r = validateTemplate(tpl);
            return {
              text:
                '模板 ✓ 两遍渲染都是合法 JSON。\n无参考图时顶层键：' +
                r.emptyKeys.join(', ') +
                '\n有参考图时顶层键：' +
                r.refKeys.join(', '),
            };
          } catch (e) {
            return { text: '模板 ✗ ' + String(e.message || e) };
          }
        }

        if (op === 'model.discover') {
          const providerId = String(args?.providerId || '').trim();
          const config = loadConfig(dir);
          const provider = providerId
            ? (config.providers || []).find((p) => p.id === providerId)
            : (config.providers || [])[0];
          if (!provider) return { text: '还没有接入点。先 op=provider.add。' };
          const probed = await probeEndpoint(provider, String(args?.endpoint || '/models'));
          if (!probed.ok) return { text: '拉不到模型清单：' + probed.reason };
          const ids = Array.isArray(probed.models) ? probed.models : [];
          if (!ids.length) {
            return {
              text:
                '站点在 ' + probed.url + ' 返回了 ' + (probed.count ?? 0) + ' 个条目，但解析不出模型 id。' +
                '请手动 op=model.add。',
            };
          }
          const explicit = String(args?.filter || '').trim();
          let re = null;
          if (explicit) {
            try {
              re = new RegExp(explicit, 'i');
            } catch (e) {
              return { text: 'filter 不是合法正则：' + String(e.message || e) };
            }
          }
          const candidates = args?.all
            ? ids
            : ids.filter((id) => (re ? re.test(id) : IMAGE_MODEL_HINT.test(id)));
          if (!candidates.length) {
            return {
              text:
                '站点报告了 ' + ids.length + ' 个模型，但没有名字看起来像生图的。' +
                '用 filter="<正则>" 指定，或 all=true 全量导入。\n全部模型：' +
                ids.slice(0, 60).join('、') + (ids.length > 60 ? ' …' : ''),
            };
          }
          const existing = new Set((config.models || []).filter((m) => m.providerId === provider.id).map((m) => m.model));
          /* 统一端点判定：生成端点填的不是 OpenAI 那套 /images/generations、
             或者改图端点空着 —— 说明这个站是「一个端点 + 请求体里区分生图/改图」的协议。
             小梦（lk888）就是这种：/v1/media/generate 统一吃，/v1/images/* 直接 400。 */
          const genPath = String(provider.generatePath || '').trim();
          const editPath = String(provider.editPath || '').trim();
          const unifiedEndpoint = Boolean(genPath) && (!editPath || !/^\/images\//i.test(genPath));
          const added = [];
          const skipped = [];
          mutateConfig(dir, (c) => {
            for (const modelId of candidates) {
              if (existing.has(modelId)) {
                skipped.push(modelId);
                continue;
              }
              const id = makeId('m');
              /* 端点推断：统一端点站把生成端点也当改图端点用，
                 新导入的模型立刻就能带参考图改图 —— 这正是
                 gpt-image-2.6「明明能改图却被判成 generate」的根因，在这里一次性规避。 */
              c.models.push({
                id,
                providerId: provider.id,
                name: modelId,
                model: modelId,
                caps: 'both',
                maxSide: 0,
                bodyTemplate: '',
                resultPath: '',
                extra: {},
                sizes: {},
                summary: '',
                notes: '',
                costHint: '',
                formats: [],
                params: {},
                bodyMode: 'openai',
                imagePayload: 'objects',
                endpoints: unifiedEndpoint ? { generate: genPath, edit: genPath } : {},
                resultUrlField: '',
                editJson: unifiedEndpoint,
              });
              if (!c.defaultModel) c.defaultModel = id;
              added.push(modelId);
            }
            return c;
          });
          const lines = [];
          lines.push('从「' + provider.name + '」的 ' + probed.url + ' 发现 ' + ids.length + ' 个条目。');
          if (added.length) lines.push('已导入 ' + added.length + ' 个：' + added.join('、'));
          if (skipped.length) lines.push('已存在跳过 ' + skipped.length + ' 个：' + skipped.slice(0, 20).join('、'));
          lines.push('');
          lines.push('导入的模型能力默认 both、无模板。请接着做两件事：');
          if (unifiedEndpoint) {
            lines.push('  · 该接入点是统一端点（' + genPath + '）：已自动把改图端点也指向它，');
            lines.push('    新模型不用额外配置就能带参考图改图。');
          }
          lines.push('  1) op=test modelId=<id> 逐个验证真能出图（会产生少量费用）；');
          lines.push('  2) op=model.update 写 summary/notes/formats，让 AI 知道什么时候该选它；');
          lines.push('     如果这个模型有私有参数（版本/画质档等），用 op=model.update params={…} 声明，');
          lines.push('     面板就会给你渲染真实控件，AI 也知道怎么填。');
          lines.push('不像生图的模型没有被导入；要全量导入用 all=true。');
          return { text: lines.join('\n') };
        }

        if (op === 'gallery') {
          const config = loadConfig(dir);
          const limit = Math.min(200, Math.max(1, Number(args?.limit) || 20));
          const query = String(args?.query || '').trim().toLowerCase();
          let images = listImages(dir, 400, config);
          if (query) {
            images = images.filter((img) => {
              const meta = img.meta || {};
              const hay = [img.name, meta.prompt, meta.model, meta.provider].join(' ').toLowerCase();
              return hay.includes(query);
            });
          }
          images = images.slice(0, limit);
          if (!images.length) {
            return { text: '画廊里' + (query ? '没有匹配「' + query + '」的' : '还没有') + '图片。' };
          }
          const lines = ['最近 ' + images.length + ' 张（共 ' + listImages(dir, 100000, config).length + ' 张）：'];
          for (const img of images) {
            const meta = img.meta || {};
            lines.push('');
            lines.push('· ' + img.name + ' · ' + Math.round(img.bytes / 1024) + 'KB');
            if (meta.prompt) lines.push('  提示词：' + String(meta.prompt).slice(0, 160));
            const bits = [meta.model, meta.size, meta.ratio].filter(Boolean);
            if (bits.length) lines.push('  参数：' + bits.join(' · '));
            lines.push('  路径：' + img.file);
          }
          lines.push('');
          lines.push('要复用某张的提示词：image_generate prompt="<上面的提示词>"。');
          lines.push('要把它当参考图：image_generate images=["<上面的路径>"] prompt="…"。');
          return { text: lines.join('\n') };
        }

        if (op === 'gallery.delete') {
          const names = Array.isArray(args?.names) ? args.names.map((n) => String(n || '').trim()).filter(Boolean) : [];
          if (!names.length) return { text: 'gallery.delete 需要 names（gallery 返回的 name）。' };
          const removed = [];
          const missing = [];
          const gdir = galleryDir(dir, loadConfig(dir));
          for (const name of names) {
            const safe = safeImageName(name);
            if (!safe) {
              missing.push(name + '（非法文件名）');
              continue;
            }
            const file = path.join(gdir, safe);
            if (!fs.existsSync(file)) {
              missing.push(name);
              continue;
            }
            fs.unlinkSync(file);
            try {
              if (fs.existsSync(sidecarPath(file))) fs.unlinkSync(sidecarPath(file));
            } catch {
              /* sidecar 删不掉不影响图片 */
            }
            removed.push(safe);
          }
          return {
            text:
              (removed.length ? '已删除：' + removed.join('、') : '没有删除任何文件') +
              (missing.length ? '\n没找到：' + missing.join('、') : ''),
          };
        }

        if (op === 'provider.add') {
          const baseUrl = String(args?.baseUrl || '').trim();
          if (!baseUrl) return { text: 'provider.add 需要 baseUrl。' };
          let created = null;
          mutateConfig(dir, (config) => {
            const id = makeId('p');
            config.providers.push({
              id,
              name: String(args?.name || '').trim() || baseUrl.replace(/^https?:\/\//, '').split('/')[0],
              baseUrl: baseUrl.replace(/\/+$/, ''),
              apiKey: String(args?.apiKey || '').trim(),
              generatePath: String(args?.generatePath || '') || '/images/generations',
              editPath: String(args?.editPath || ''),
              timeoutMs: 0,
              taskMode: String(args?.taskMode || '') === 'poll' ? 'poll' : 'sync',
              statusPath: String(args?.statusPath || ''),
              taskIdField: String(args?.taskIdField || '') || 'data.task_id',
              resultUrlsField: String(args?.resultUrlsField || '') || 'result_url',
              pollIntervalMs: Number(args?.pollIntervalMs) > 0 ? Number(args.pollIntervalMs) : 3000,
              pollTimeoutMs: Number(args?.pollTimeoutMs) > 0 ? Number(args.pollTimeoutMs) : 300000,
              headers: args?.headers && typeof args.headers === 'object' ? args.headers : {},
            });
            created = config.providers[config.providers.length - 1];
            return config;
          });
          return {
            text:
              '已加接入点「' +
              created.name +
              '」id=' +
              created.id +
              '。下一步：op=model.add providerId=' +
              created.id +
              ' name="…" model="…"，然后 op=probe 验连通。',
          };
        }

        if (op === 'provider.update') {
          const id = String(args?.id || '').trim();
          if (!id) return { text: 'provider.update 需要 id。先 op=list 看 id。' };
          let found = false;
          mutateConfig(dir, (config) => {
            const p = config.providers.find((x) => x.id === id);
            if (!p) return config;
            found = true;
            if (args.name !== undefined) p.name = String(args.name).trim() || p.name;
            if (args.baseUrl !== undefined) p.baseUrl = String(args.baseUrl).trim().replace(/\/+$/, '');
            if (args.apiKey !== undefined && String(args.apiKey).trim() && !String(args.apiKey).includes('…')) {
              p.apiKey = String(args.apiKey).trim();
            }
            if (args.generatePath !== undefined) p.generatePath = String(args.generatePath).trim() || '/images/generations';
            if (args.editPath !== undefined) p.editPath = String(args.editPath).trim();
            if (args.taskMode !== undefined) p.taskMode = String(args.taskMode) === 'poll' ? 'poll' : 'sync';
            if (args.statusPath !== undefined) p.statusPath = String(args.statusPath).trim();
            if (args.taskIdField !== undefined) p.taskIdField = String(args.taskIdField).trim() || 'data.task_id';
            if (args.resultUrlsField !== undefined) p.resultUrlsField = String(args.resultUrlsField).trim() || 'result_url';
            if (args.pollIntervalMs !== undefined) p.pollIntervalMs = Number(args.pollIntervalMs) > 0 ? Number(args.pollIntervalMs) : 3000;
            if (args.pollTimeoutMs !== undefined) p.pollTimeoutMs = Number(args.pollTimeoutMs) > 0 ? Number(args.pollTimeoutMs) : 300000;
            if (args.headers !== undefined) p.headers = args.headers && typeof args.headers === 'object' ? args.headers : {};
            return config;
          });
          return { text: found ? '已更新接入点 ' + id + '。' : '没有 id=' + id + ' 的接入点。' };
        }

        if (op === 'provider.remove') {
          const id = String(args?.id || '').trim();
          if (!id) return { text: 'provider.remove 需要 id。' };
          let removed = null;
          mutateConfig(dir, (config) => {
            const p = config.providers.find((x) => x.id === id);
            if (!p) return config;
            removed = p;
            config.providers = config.providers.filter((x) => x.id !== id);
            const orphan = config.models.filter((m) => m.providerId === id);
            config.models = config.models.filter((m) => m.providerId !== id);
            if (orphan.some((m) => m.id === config.defaultModel)) config.defaultModel = config.models[0]?.id || '';
            return config;
          });
          if (!removed) return { text: '没有 id=' + id + ' 的接入点。' };
          return { text: '已删除接入点「' + removed.name + '」及其下的模型。' };
        }

        if (op === 'model.add') {
          const providerId = String(args?.providerId || '').trim();
          const modelValue = String(args?.model || '').trim();
          if (!providerId) return { text: 'model.add 需要 providerId。先 op=list 看接入点 id。' };
          if (!modelValue) return { text: 'model.add 需要 model（服务商给的 model ID）。' };
          const config0 = loadConfig(dir);
          if (!config0.providers.some((p) => p.id === providerId)) {
            return { text: '没有 id=' + providerId + ' 的接入点。先 provider.add。' };
          }
          const tpl = String(args?.bodyTemplate || '');
          if (tpl.trim()) {
            try {
              validateTemplate(tpl);
            } catch (e) {
              return { text: '请求体模板校验失败，未写入：' + String(e.message || e) };
            }
          }
          // 参数声明：写法有疑问时不阻断写入，但必须报出来 —— 否则 AI 以为配好了，
          // 实际那个参数被当成「钉死成某个字符串」，用户改都改不动。
          const paramCheck = normalizeParamsChecked(args?.params);
          let created = null;
          mutateConfig(dir, (config) => {
            const id = makeId('m');
            config.models.push({
              id,
              providerId,
              name: String(args?.name || '').trim() || modelValue,
              model: modelValue,
              caps: ['both', 'generate', 'edit'].includes(String(args?.caps)) ? String(args.caps) : 'both',
              maxSide: Number(args?.maxSide) > 0 ? Math.round(Number(args.maxSide)) : 0,
              bodyTemplate: tpl,
              resultPath: String(args?.resultPath || '').trim(),
              extra: args?.extra && typeof args.extra === 'object' ? args.extra : {},
              sizes: args?.sizes && typeof args.sizes === 'object' ? args.sizes : {},
              summary: String(args?.summary || '').trim(),
              notes: String(args?.notes || '').trim(),
              costHint: String(args?.costHint || '').trim(),
              formats: args?.formats,
              // ---- 适配层 ----
              params: args?.params && typeof args.params === 'object' ? args.params : {},
              bodyMode: String(args?.bodyMode || '') || 'openai',
              imagePayload: String(args?.imagePayload || '') || 'objects',
              endpoints: args?.endpoints && typeof args.endpoints === 'object' ? args.endpoints : {},
              resultUrlField: String(args?.resultUrlField || '').trim(),
              editJson: args?.editJson === true,
            });
            if (!config.defaultModel) config.defaultModel = id;
            created = config.models[config.models.length - 1];
            return config;
          });
          return {
            text:
              '已加模型「' + created.name + '」id=' + created.id + '。建议下一步 op=probe 验连通。' +
              (paramCheck.problems.length
                ? '\n\n⚠ 参数声明有 ' + paramCheck.problems.length + ' 处需要注意：\n' +
                  paramCheck.problems.map((x) => '  · ' + x).join('\n')
                : Object.keys(paramCheck.params).length
                  ? '\n已记录 ' + Object.keys(paramCheck.params).length + ' 个参数声明，AI 和面板都会据此显示。'
                  : ''),
          };
        }

        if (op === 'model.update') {
          const id = String(args?.id || '').trim();
          if (!id) return { text: 'model.update 需要 id。' };
          const paramCheck = normalizeParamsChecked(args?.params);
          let found = false;
          let tplError = '';
          let tplApplied = false;
          mutateConfig(dir, (config) => {
            const m = config.models.find((x) => x.id === id);
            if (!m) return config;
            found = true;
            if (args.name !== undefined) m.name = String(args.name).trim() || m.name;
            if (args.model !== undefined) m.model = String(args.model).trim() || m.model;
            if (args.providerId !== undefined) m.providerId = String(args.providerId).trim();
            if (args.caps !== undefined && ['both', 'generate', 'edit'].includes(String(args.caps))) m.caps = String(args.caps);
            if (args.maxSide !== undefined) m.maxSide = Number(args.maxSide) > 0 ? Math.round(Number(args.maxSide)) : 0;
            if (args.resultPath !== undefined) m.resultPath = String(args.resultPath || '').trim();
            if (args.extra !== undefined && args.extra && typeof args.extra === 'object') m.extra = args.extra;
            if (args.sizes !== undefined && args.sizes && typeof args.sizes === 'object') m.sizes = args.sizes;
            if (args.summary !== undefined) m.summary = String(args.summary || '').trim();
            if (args.notes !== undefined) m.notes = String(args.notes || '').trim();
            if (args.costHint !== undefined) m.costHint = String(args.costHint || '').trim();
            if (args.formats !== undefined) m.formats = args.formats;
            // ---- 适配层 ----
            if (args.params !== undefined) m.params = args.params && typeof args.params === 'object' ? args.params : {};
            if (args.bodyMode !== undefined) m.bodyMode = String(args.bodyMode || '') || 'openai';
            if (args.imagePayload !== undefined) m.imagePayload = String(args.imagePayload || '') || 'objects';
            if (args.endpoints !== undefined) m.endpoints = args.endpoints && typeof args.endpoints === 'object' ? args.endpoints : {};
            if (args.resultUrlField !== undefined) m.resultUrlField = String(args.resultUrlField || '').trim();
            if (args.editJson !== undefined) m.editJson = args.editJson === true;
            if (args.bodyTemplate !== undefined) {
              const tpl = String(args.bodyTemplate || '');
              if (!tpl.trim()) {
                m.bodyTemplate = '';
                tplApplied = true;
              } else {
                try {
                  validateTemplate(tpl);
                  m.bodyTemplate = tpl;
                  tplApplied = true;
                } catch (e) {
                  tplError = String(e.message || e);
                }
              }
            }
            return config;
          });
          if (!found) return { text: '没有 id=' + id + ' 的模型。' };
          if (tplError) return { text: '模型其它字段已更新，但请求体模板校验失败、模板未写入：' + tplError };
          return {
            text:
              '已更新模型 ' + id + (args.bodyTemplate !== undefined ? (tplApplied ? '（含模板）' : '') : '') + '。' +
              (paramCheck.problems.length
                ? '\n\n⚠ 参数声明有 ' + paramCheck.problems.length + ' 处需要注意：\n' +
                  paramCheck.problems.map((x) => '  · ' + x).join('\n')
                : ''),
          };
        }

        if (op === 'model.remove') {
          const id = String(args?.id || '').trim();
          if (!id) return { text: 'model.remove 需要 id。' };
          let removed = null;
          mutateConfig(dir, (config) => {
            const m = config.models.find((x) => x.id === id);
            if (!m) return config;
            removed = m;
            config.models = config.models.filter((x) => x.id !== id);
            if (config.defaultModel === id) config.defaultModel = config.models[0]?.id || '';
            return config;
          });
          return { text: removed ? '已删除模型「' + removed.name + '」。' : '没有 id=' + id + ' 的模型。' };
        }

        if (op === 'default.set') {
          const id = String(args?.modelId || args?.id || '').trim();
          if (!id) return { text: 'default.set 需要 modelId。' };
          const config = loadConfig(dir);
          const model = config.models.find((m) => m.id === id || m.name === id || m.model === id);
          if (!model) return { text: '没有 id=' + id + ' 的模型。' };
          mutateConfig(dir, (c) => {
            c.defaultModel = model.id;
            return c;
          });
          return { text: '默认模型已设为「' + model.name + '」（id=' + model.id + '）。' };
        }

        if (op === 'test') {
          const config = loadConfig(dir);
          const providerId = String(args?.providerId || '').trim();
          const provider = providerId ? (config.providers || []).find((p) => p.id === providerId) : (config.providers || [])[0];
          if (!provider) return { text: providerId ? '没有 id=' + providerId + ' 的接入点。' : '还没有接入点，无法测试。' };
          const r = await testProvider(config, provider.id, String(args?.modelId || ''));
          if (!r.ok) return { text: '连通 ✗ · ' + r.reason };
          return {
            text:
              '连通 ✓ · HTTP ' +
              r.status +
              (r.note ? '\n' + r.note : '') +
              (r.imageOk ? '' : '\n⚠ 请求通了但没解析出图片：' + r.imageError),
          };
        }

        return { text: '不认识的 op：' + op + '。可用：' + OPS.join(' / ') };
  } catch (e) {
    return { text: '配置操作失败：' + String((e && e.message) || e) };
  }
}

/* ------------------------------------------------------------------ */
/* HTTP 路由（面板用）                                                  */
/* ------------------------------------------------------------------ */

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

async function readBody(req, limitBytes = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function mediaForFile(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'svg') return 'image/svg+xml';
  return 'image/png';
}

/** 面板路由：全部挂在 /dsh-image-gen 前缀下。 */
export function buildRoutes(ctx, configDir) {
  const dir = resolveDir(configDir);

  const handler = async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const route = url.pathname.slice(ROUTE_PREFIX.length) || '/';

    try {
      /* ---------------- 配置 ---------------- */
      if (route === '/config.json' && req.method === 'GET') {
        const config = loadConfig(dir);
        return sendJson(res, 200, {
          ok: true,
          dir,
          config: describeConfig(config),
          readiness: describeReadiness(config),
          ratios: RATIOS,
          tiers: Object.keys(RES_AREA),
          sizes: config.sizes && Object.keys(config.sizes).length ? config.sizes : defaultSizes(),
          computedSizes: defaultSizes(),
          raw: {
            version: config.version,
            providers: (config.providers || []).map((p) => ({ ...p, apiKey: maskKey(p.apiKey) })),
            models: config.models || [],
            defaultModel: config.defaultModel,
            timeoutMs: config.timeoutMs,
            outputDir: config.outputDir,
            recordMetadata: config.recordMetadata !== false,
            // 只回真正存过的尺寸覆盖；面板回写时用它，避免把自动换算值固化
            sizes: config.sizes || {},
          },
        });
      }

      if (route === '/config.json' && (req.method === 'POST' || req.method === 'PUT')) {
        const body = await readBody(req);
        const incoming = body && body.config ? body.config : body;
        const merged = mergePreservingKeys(loadConfig(dir), incoming);
        const saved = saveConfig(dir, merged);
        return sendJson(res, 200, { ok: true, config: describeConfig(saved) });
      }

      /* ---------------- 画廊 ---------------- */
      if (route === '/images.json' && req.method === 'GET') {
        const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get('limit')) || 120));
        const query = String(url.searchParams.get('q') || '').trim().toLowerCase();
        const config = loadConfig(dir);
        let images = listImages(dir, Math.min(2000, limit * 4), config);
        if (query) {
          images = images.filter((img) => {
            const meta = img.meta || {};
            return [img.name, meta.prompt, meta.model, meta.provider, meta.size]
              .filter(Boolean)
              .join(' ')
              .toLowerCase()
              .includes(query);
          });
        }
        return sendJson(res, 200, {
          ok: true,
          images: images.slice(0, limit),
          total: listImages(dir, 100000, config).length,
          galleryDir: galleryDir(dir, config),
        });
      }

      if (route === '/image' && req.method === 'GET') {
        const name = safeImageName(url.searchParams.get('name'));
        if (!name) return sendJson(res, 400, { ok: false, error: 'bad name' });
        const file = path.join(galleryDir(dir, loadConfig(dir)), name);
        if (!fs.existsSync(file)) return sendJson(res, 404, { ok: false, error: 'not found' });
        const bytes = fs.readFileSync(file);
        const download = url.searchParams.get('download') === '1';
        res.writeHead(200, {
          'content-type': mediaForFile(file),
          'cache-control': 'private, max-age=60',
          ...(download
            ? { 'content-disposition': 'attachment; filename="' + path.basename(name).replace(/"/g, '') + '"' }
            : {}),
        });
        res.end(bytes);
        return;
      }

      if (route === '/file' && req.method === 'GET') {
        // 本机参考图的缩略图：面板只有一个本地路径，拿不到 <img src>。
        // 只允许读「上传目录 / 画廊目录 / @last 缓存」下的文件，并按真实路径前缀校验，
        // 防止把 /file?path=C:\anything 变成任意文件读取。
        const raw = String(url.searchParams.get('path') || '').trim();
        if (!raw) return sendJson(res, 400, { ok: false, error: 'bad path' });
        let abs;
        try {
          abs = path.resolve(raw);
        } catch {
          return sendJson(res, 400, { ok: false, error: 'bad path' });
        }
        // 白名单目录之外也允许读，但**必须是图片文件**（按扩展名 + 魔数双重判定）。
        // 用户手填的参考图路径可能在任何地方（桌面、网盘目录…），缩略图得能显示；
        // 但绝不把这个路由变成任意文件读取 —— 非图片一律 403。
        const ext = path.extname(abs).slice(1).toLowerCase();
        const imageExt = (HOST_IMAGE_EXT.includes(ext) || ext === 'svg');
        if (!imageExt) return sendJson(res, 403, { ok: false, error: '只允许读取图片文件' });
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
          return sendJson(res, 404, { ok: false, error: 'not found' });
        }
        // 扩展名可以伪造，再核一次魔数；认不出来就按扩展名放行（svg 是文本，没有魔数）。
        const head = Buffer.alloc(12);
        try {
          const fd = fs.openSync(abs, 'r');
          fs.readSync(fd, head, 0, 12, 0);
          fs.closeSync(fd);
        } catch {
          return sendJson(res, 403, { ok: false, error: '读不到这个文件' });
        }
        const sniffed = ext === 'svg' ? 'svg' : sniffExt(new Uint8Array(head));
        if (sniffed === 'bin') {
          return sendJson(res, 403, { ok: false, error: '不是可识别的图片文件' });
        }
        res.writeHead(200, {
          'content-type': mediaForFile(abs),
          'cache-control': 'private, max-age=300',
        });
        res.end(fs.readFileSync(abs));
        return;
      }

      if (route === '/ref.upload.json' && req.method === 'POST') {
        // 面板拖进来的文件：浏览器只有字节，没有本机路径。这里收下来存到
        // <dir>/uploads/，再回一个真实路径给面板 —— 之后它就和手填的路径没区别。
        const body = await readBody(req, 64 * 1024 * 1024);
        const rawName = String(body.name || 'ref.png');
        const base = path.basename(rawName).replace(/[^\w.\-\u4e00-\u9fa5]/g, '_').slice(-60) || 'ref.png';
        const ext = path.extname(base).slice(1).toLowerCase();
        if (!HOST_IMAGE_EXT.includes(ext)) {
          return sendJson(res, 400, { ok: false, error: '只收图片（' + HOST_IMAGE_EXT.join(' / ') + '），收到：' + (ext || '无扩展名') });
        }
        const data = String(body.data || '');
        const comma = data.indexOf(',');
        const b64 = data.startsWith('data:') && comma >= 0 ? data.slice(comma + 1) : data;
        if (!b64) return sendJson(res, 400, { ok: false, error: '上传内容是空的' });
        const bytes = Buffer.from(b64, 'base64');
        if (!bytes.length) return sendJson(res, 400, { ok: false, error: '上传内容解码后为空' });
        const upDir = path.join(dir, 'uploads');
        fs.mkdirSync(upDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
        const name = stamp + '-' + base;
        const file = path.join(upDir, name);
        fs.writeFileSync(file, bytes);
        return sendJson(res, 200, { ok: true, file, name, bytes: bytes.length });
      }

      if (route === '/image.delete.json' && req.method === 'POST') {
        const body = await readBody(req);
        const name = safeImageName(body.name);
        if (!name) return sendJson(res, 400, { ok: false, error: 'bad name' });
        const file = path.join(galleryDir(dir, loadConfig(dir)), name);
        if (!fs.existsSync(file)) return sendJson(res, 404, { ok: false, error: 'not found' });
        fs.unlinkSync(file);
        try {
          if (fs.existsSync(sidecarPath(file))) fs.unlinkSync(sidecarPath(file));
        } catch {
          /* ignore */
        }
        return sendJson(res, 200, { ok: true, name });
      }

      if (route === '/image.meta.json' && req.method === 'GET') {
        const name = safeImageName(url.searchParams.get('name'));
        if (!name) return sendJson(res, 400, { ok: false, error: 'bad name' });
        const file = path.join(galleryDir(dir, loadConfig(dir)), name);
        if (!fs.existsSync(file)) return sendJson(res, 404, { ok: false, error: 'not found' });
        return sendJson(res, 200, { ok: true, name, meta: readSidecar(file) });
      }

      /* ---------------- 生成 ---------------- */
      if (route === '/generate.json' && req.method === 'POST') {
        const body = await readBody(req);
        const config = loadConfig(dir);
        const wantsLast = Array.isArray(body.images) && body.images.some((x) => /^@(last|recent)/i.test(String(x || '').trim()));
        if (wantsLast) {
          return sendJson(res, 200, {
            ok: false,
            error: '面板里不能用 @last（它指「对话里最近的一张图」，只有 AI 在对话里调用时才有会话上下文）。请用画廊里的「参考」按钮，或直接填本机图片路径。',
          });
        }
        const expanded = await expandImages(ctx, '', body.images, dir);
        const mode = expanded.images.length ? 'edit' : 'generate';
        const resolved = resolveModel(config, String(body.model || ''), mode);
        if (!resolved.ok) return sendJson(res, 200, { ok: false, error: resolved.reason });
        try {
          const result = await runGeneration({
            resolved,
            config,
            args: { ...body, images: expanded.images },
            dir,
            outputDir: body.saveTo ? path.resolve(String(body.saveTo)) : '',
          });
          const gdir = galleryDir(dir, config);
          return sendJson(res, 200, {
            ok: true,
            notes: expanded.notes,
            result: {
              ...result,
              files: result.files.map((f) => {
                const rel = path.relative(gdir, f.file);
                const name = rel.startsWith('..') ? '' : rel.split(path.sep).join('/');
                return {
                  ...f,
                  name,
                  url: name ? '/dsh-image-gen/image?name=' + encodeURIComponent(name) : '',
                };
              }),
            },
          });
        } catch (e) {
          return sendJson(res, 200, { ok: false, error: String((e && e.message) || e) });
        }
      }

      /* ---------------- 连通性 ---------------- */
      if (route === '/test.json' && req.method === 'POST') {
        const body = await readBody(req);
        const config = loadConfig(dir);
        const result = await testProvider(config, String(body.providerId || ''), String(body.modelId || ''));
        return sendJson(res, 200, { ok: true, result });
      }

      if (route === '/probe.json' && req.method === 'POST') {
        const body = await readBody(req);
        const config = loadConfig(dir);
        const provider = (config.providers || []).find((p) => p.id === body.providerId) || (config.providers || [])[0];
        if (!provider) return sendJson(res, 200, { ok: false, error: '还没有接入点。' });
        const result = await probeEndpoint(provider, String(body.endpoint || '/models'));
        return sendJson(res, 200, { ok: true, result });
      }

      if (route === '/template.check.json' && req.method === 'POST') {
        const body = await readBody(req);
        const tpl = String(body.template || '').trim();
        if (!tpl) return sendJson(res, 200, { ok: false, error: '模板是空的。' });
        try {
          const r = validateTemplate(tpl);
          return sendJson(res, 200, { ok: true, result: r });
        } catch (e) {
          return sendJson(res, 200, { ok: false, error: String((e && e.message) || e) });
        }
      }

      /* ---------------- 元信息 ---------------- */
      if (route === '/meta.json' && req.method === 'GET') {
        const config = loadConfig(dir);
        return sendJson(res, 200, {
          ok: true,
          dir,
          imagesDir: galleryDir(dir, config),
          home: os.homedir(),
          ratios: RATIOS,
          tiers: Object.keys(RES_AREA),
          sizeTable: sizeTable(config, config.models.find((m) => m.id === config.defaultModel)),
        });
      }

      return sendJson(res, 404, { ok: false, error: 'unknown route ' + route });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  };

  return {
    handle: handler,
    route: { kind: 'prefix', path: ROUTE_PREFIX, handler },
  };
}

/** plugin.js 用：拿到可直接 register 的路由对象。 */
export function buildRoute(ctx, configDir) {
  return buildRoutes(ctx, configDir).route;
}

export function routePrefix() {
  return ROUTE_PREFIX;
}

/* ------------------------------------------------------------------ */
/* 系统提示词：什么时候该主动出图                                      */
/* ------------------------------------------------------------------ */

/**
 * 渲染 image-gen 的能力段落。
 *
 * 工具定义只告诉模型「有这么个工具」，不会让它想到「用户说『画一张…』时应该主动调用」。
 * 这一段补的就是这个判断：什么算要图、没图时怎么改、多模型怎么挑、以及不去做什么。
 *
 * 未配置模型时返回空串 —— 否则模型会去调一个必然失败的工具，反而浪费一轮。
 */
export function renderCapabilitySection(ctx, configDir) {
  let config = null;
  try {
    config = loadConfig(resolveDir(configDir));
  } catch {
    return '';
  }
  const models = (config.models || []).filter((m) => !m.providerMissing);
  const hasKey = (config.providers || []).some((p) => p.apiKey);
  if (!models.length || !hasKey) return '';

  // 只列「能干什么」，不列细节（细节在 image_config op=models 里，按需再取）。
  const kinds = [];
  if (models.some((m) => m.caps !== 'edit')) kinds.push('文生图');
  if (models.some((m) => m.caps !== 'generate')) kinds.push('参考图改图');
  const formats = new Set();
  for (const m of models) for (const f of m.formats || []) formats.add(f);
  const odd = [...formats].filter((f) => f !== 'png');

  return [
    '## 出图能力',
    '',
    '本机已配置生图接口（' + models.length + ' 个模型，可用：' + kinds.join(' / ') + '）。',
    odd.length ? '部分模型还能产出 ' + odd.join(' / ') + '。' : '',
    '',
    '**什么时候主动调用 `image_generate`**：',
    '- 用户说「画一张…」「生成个图」「出个封面 / 图标 / 海报 / 立绘 / 配图」「帮我设计个 Logo」，',
    '  或者要你「做一张图看看」——即使他没说出「用工具」两个字。',
    '- 用户给了参考图（他自己发的图，或对话里更早生成的图）并要求改成什么样。',
    '- 用户明确要图片文件，而不是要你描述图片长什么样。',
    '',
    '**传参怎么选**（这一步最容易出错，照做）：',
    '- 参考图就在对话里时（用户刚发的图、或上一轮生成的图），**直接传 images: ["@last"]**，',
    '  不要去磁盘上找文件、也不要让用户先存成文件。更早的图用 "@last:2"。',
    '- 改图时**不要自己猜 ratio**：不传就自动沿用参考图的比例。',
    '  只有用户明确要求换画幅时才传 ratio。',
    '- 格式：**默认就是 png 静图，什么都别传**。只有用户明确说要动图（GIF / 表情动画 / 会动的）',
    '  才传 `format="gif"`。要矢量图传 `format="svg"`。用户说「生成一张 1K 的图」时**不要**传 gif。',
    '- 尺寸：用户说「1K / 2K / 4K」就传 `resolution`；说「横版 / 竖版 / 方图 / 16:9 / 9:16」就传 `ratio`；',
    '  两者可以一起传。什么都没说就用默认值，别自己编像素。',
    '- 模型：有多个模型时先 `image_config` op=models 看声明，按「静图 / 动图 / 矢量」和擅长领域挑。',
    '  只有一个模型就别折腾，直接用。',
    '',
    '**不要做的事**：',
    '- 不要只用文字描述画面就当作完成了出图请求——用户要的是图，不是图的样子。',
    '- 不要为了「看看效果」重复生成同一提示词；每次调用都会产生接口费用。',
    '- 用户只是要一句话解释「这张图大概是怎样」时，不要出图。',
    '- 不要因为某个模型声明支持 gif 就默认出 gif——那是可选能力，不是默认行为。',
    '',
    '**拿到需求之后**：',
    '1. 需求还缺关键信息（画幅、用途、风格）且影响结果时，先用一句话问清，或按最合理的默认值直接出。',
    '2. 不确定该用哪个模型时，调 `image_config` op=models 看各模型的声明再挑；只有一个模型就直接用。',
    '3. 出图后用一两句话说明你做了什么、图存在哪，不要复述提示词。',
    '',
    '**什么时候用 image_admin**：只有用户要「加 / 改 / 删接入点或模型」「设默认模型」「验连通」时才用，',
    '平时查现状用 `image_config`（`list` / `models` / `gallery`）就够了。',
    '',
    '没配置接口时（这一段不会出现），用 `image_config` op=guide 看怎么配，再用 `image_admin` 写入。',
  ].filter((line) => line !== '').join('\n');
}
