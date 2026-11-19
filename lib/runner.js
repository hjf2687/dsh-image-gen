/**
 * dsh-image-gen · 执行器
 *
 * 一次生成 = 组请求 → 发请求 → 取出图片值 → 落盘（+ sidecar 元数据）。
 * 落盘是必须的：图片要能在面板画廊里回看，也要能作为文件路径交给别的工具
 * （比如拿去当参考图、塞进 PPT）。回传给模型的 durable attachment 另算，
 * 由 host.js 负责。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  base64ToBytes,
  buildBody,
  explainHttpFailure,
  extractImages,
  normalizeBase,
  pickPath,
  probeImageSize,
  ratioForDims,
  sizeFor,
  sniffExt,
} from './protocol.js';
import { galleryDir, sizeTable, writeSidecar } from './store.js';

export const IMAGE_MEDIA = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
};

/** 宿主附件服务只收这几种位图。 */
export const HOST_IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif'];

/** 取媒体类型。 */
export function mediaForExt(ext) {
  return IMAGE_MEDIA[String(ext).toLowerCase()] || 'application/octet-stream';
}

/** SVG 判定：交给调用方决定「能不能当图片回传」。 */
export function isSvgExt(ext) {
  return String(ext).toLowerCase() === 'svg';
}

/* ------------------------------------------------------------------ */
/* 参考图                                                              */
/* ------------------------------------------------------------------ */

/**
 * 参考图 → 可直接塞进请求的字符串。
 * 支持三种写法：
 *   - 本机路径（相对路径按 cwd 解析）
 *   - `data:image/...;base64,...`（已经是 dataURL，原样用）
 *   - `http(s)://…`（已经是 URL，原样用）
 */
export function readReference(ref) {
  const raw = String(ref || '').trim();
  if (!raw) throw new Error('参考图路径是空的。');
  if (/^data:/i.test(raw)) {
    return { value: raw, kind: 'data', bytes: 0, label: 'dataURL' };
  }
  if (/^https?:\/\//i.test(raw)) {
    return { value: raw, kind: 'url', bytes: 0, label: raw };
  }
  const abs = path.resolve(raw);
  let buf;
  try {
    buf = fs.readFileSync(abs);
  } catch (e) {
    throw new Error('读不到参考图「' + raw + '」：' + String((e && e.message) || e));
  }
  const ext = path.extname(abs).slice(1).toLowerCase();
  const media = IMAGE_MEDIA[ext] || 'image/png';
  return {
    value: 'data:' + media + ';base64,' + buf.toString('base64'),
    kind: 'file',
    bytes: buf.length,
    ext,
    media,
    file: abs,
    label: path.basename(abs),
  };
}

/** 参考图 → 字节（multipart 改图要用真字节）。 */
function refBytes(ref) {
  if (ref.kind === 'file') return fs.readFileSync(ref.file);
  if (ref.kind === 'data') return base64ToBytes(ref.value);
  throw new Error('参考图是远程 URL（' + ref.value + '），OpenAI 改图协议要求本地字节；给它配请求体模板走 JSON 协议。');
}

/* ------------------------------------------------------------------ */
/* 文件命名                                                            */
/* ------------------------------------------------------------------ */

/** 文件名里不要出现 Windows 非法字符，也别太长。 */
function safeName(input) {
  const s = String(input || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s.length > 60 ? s.slice(0, 60) : s || 'image';
}

/** 时间戳：20261105-211435，本地时区，方便按时间排序。 */
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    '-' +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds())
  );
}

/* ------------------------------------------------------------------ */
/* 下载                                                                */
/* ------------------------------------------------------------------ */

/** 下载 URL 图片；同源时带上鉴权头（很多中转站的原图地址要鉴权）。 */
async function fetchImageUrl(url, provider, signal) {
  const headers = {};
  try {
    const target = new URL(url);
    const same = provider?.baseUrl && target.origin === new URL(provider.baseUrl).origin;
    if (same && provider?.apiKey) headers.authorization = 'Bearer ' + provider.apiKey;
    if (same && provider?.headers) Object.assign(headers, provider.headers);
  } catch {
    /* URL 不合法就走无头下载，让 fetch 自己报错 */
  }
  let res;
  try {
    res = await fetch(url, { headers, signal });
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/abort/i.test(msg)) throw new Error('已取消。');
    throw new Error('图片 URL 下载失败：' + msg);
  }
  if (!res.ok) throw new Error('图片 URL 下载失败：HTTP ' + res.status + '（' + url + '）');
  return new Uint8Array(await res.arrayBuffer());
}

/* ------------------------------------------------------------------ */
/* 异步任务轮询                                                        */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FAILED_STATES = new Set(['failed', 'failure', 'error', 'canceled', 'cancelled', 'rejected', 'expired']);
const DONE_STATES = new Set(['success', 'succeeded', 'completed', 'complete', 'done', 'finished']);

/**
 * 轮询异步任务直到出结果。
 *
 * 状态字段常见三种拼法：`state` / `status` / `data.status`，值有大写也有小写，
 * 这里统一小写后再判定。停止条件用「状态不再进行中」，而不是只看 success，
 * 否则失败任务会一直等到超时。
 */
async function pollTaskResult({ provider, taskId, signal, statusPathOverride }) {
  const statusPath = statusPathOverride || provider.statusPath || '/media/status';
  const base = normalizeBase(provider.baseUrl);
  const url =
    base +
    (statusPath.startsWith('/') ? statusPath : '/' + statusPath) +
    (statusPath.includes('?') ? '&' : '?') +
    'task_id=' +
    encodeURIComponent(taskId);
  const interval = Math.max(500, Number(provider.pollIntervalMs) || 3000);
  const total = Number(provider.pollTimeoutMs) || 300000;
  const deadline = Date.now() + total;

  let last = null;
  let attempt = 0;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('已取消。');
    attempt += 1;

    let body = null;
    try {
      const res = await fetch(url, {
        headers: { ...(provider.headers || {}), ...(provider.apiKey ? { authorization: 'Bearer ' + provider.apiKey } : {}) },
        signal,
      });
      body = await res.json().catch(() => null);
      if (!res.ok && !body) throw new Error('HTTP ' + res.status);
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/abort/i.test(msg)) throw new Error('已取消。');
      // 单次查询失败不致命（网络抖动），继续等到总超时
      last = msg;
      await sleep(interval);
      continue;
    }

    last = body;
    const stateValue =
      pickPath(body, 'data.state') ?? body?.state ?? pickPath(body, 'data.status') ?? body?.status ?? body?.status_group ?? '';
    const state = String(stateValue || '').toLowerCase();
    const progress = pickPath(body, 'data.progress') ?? body?.progress;

    if (FAILED_STATES.has(state)) {
      const why = pickPath(body, 'data.error') ?? body?.error ?? body?.message ?? body?.status ?? '未知原因';
      throw new Error('任务失败（task_id=' + taskId + '）：' + (typeof why === 'string' ? why : JSON.stringify(why).slice(0, 200)));
    }

    const urls = pickPath(body, provider.resultUrlsField);
    const list = Array.isArray(urls) ? urls.filter(Boolean) : typeof urls === 'string' && urls ? [urls] : [];
    const done = DONE_STATES.has(state) || body?.is_final === true || body?.data?.is_final === true;
    if (list.length && (done || !state)) return list;
    if (done && !list.length) {
      // 有的站状态写 success 但图在别的字段，退出前再嗅探一次
      const sniffed = (() => {
        try {
          return extractImages(body, '');
        } catch {
          return [];
        }
      })();
      if (sniffed.length) return sniffed;
      throw new Error(
        '任务已完成（task_id=' + taskId + '）但没解析出图片。响应：' + JSON.stringify(body).slice(0, 300),
      );
    }

    provider.onProgress?.(attempt, state, progress);
    await sleep(interval);
  }

  throw new Error(
    '等待出图超时（' +
      Math.round(total / 1000) +
      's，task_id=' +
      taskId +
      '）。最后状态：' +
      JSON.stringify(last).slice(0, 240),
  );
}

/* ------------------------------------------------------------------ */
/* 图片值 → 字节                                                       */
/* ------------------------------------------------------------------ */

/** 图片值（b64 / dataURL / URL / 内联 SVG 源码）→ 字节。 */
async function imageValueToBytes(value, provider, signal) {
  const v = String(value || '').trim();
  if (!v) throw new Error('接口返回的图片字段是空的。');
  if (/^https?:\/\//i.test(v)) return fetchImageUrl(v, provider, signal);
  // dataURL：可能声明了 svg+xml，此时内容仍是 base64，正常解码即可
  if (v.startsWith('data:')) return base64ToBytes(v);
  // 内联 SVG 源码（未经 base64）
  if (/^(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(v)) return new Uint8Array(Buffer.from(v, 'utf8'));
  return base64ToBytes(v);
}

/* ------------------------------------------------------------------ */
/* 网络错误翻译                                                        */
/* ------------------------------------------------------------------ */

/**
 * 把 Node fetch 的失败翻译成人能看的话。
 *
 * 原生 message 经常只有 `fetch failed`，真正原因藏在 `e.cause` 的 code 里。
 * 不给出来的话，AI 分不清「域名写错了」「被防火墙挡了」「证书问题」还是「服务没启动」，
 * 只能瞎猜着重试 —— 而每次重试都可能产生费用。
 */
export function describeFetchError(err) {
  const cause = err?.cause;
  const code = String(cause?.code || err?.code || '');
  const detail = String(cause?.message || err?.message || err || '');
  const map = {
    ENOTFOUND: '域名解析不了 —— 检查 Base URL 的域名是否写错',
    EAI_AGAIN: '域名解析超时 —— 可能是网络或 DNS 问题，稍后重试',
    ECONNREFUSED: '连接被拒绝 —— 地址/端口不对，或服务没在跑',
    ECONNRESET: '连接被对方重置 —— 可能被墙或需要代理',
    ETIMEDOUT: '连接超时 —— 网络不通或对方响应太慢',
    EHOSTUNREACH: '主机不可达 —— 网络路由问题',
    ENETUNREACH: '网络不可达 —— 检查本机网络',
    CERT_HAS_EXPIRED: 'HTTPS 证书过期 —— 对方站点的问题，或本机时间不对',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'HTTPS 证书是自签的 —— 该站点不可信，或需要自建信任',
    ERR_TLS_CERT_ALTNAME_INVALID: 'HTTPS 证书与域名不匹配 —— Base URL 可能写错了',
    UND_ERR_CONNECT_TIMEOUT: '连接超时 —— 网络不通或需要代理',
  };
  const friendly = map[code];
  const bits = [friendly || detail || '未知网络错误'];
  if (code) bits.push('[' + code + ']');
  // 原有 message 不是 "fetch failed" 时也带上，避免丢信息
  const orig = String(err?.message || '');
  if (orig && orig !== 'fetch failed' && !friendly) bits.unshift(orig);
  return bits.join(' ');
}

/* ------------------------------------------------------------------ */
/* 一次生成                                                            */
/* ------------------------------------------------------------------ */

/**
 * 第一张本地参考图的宽高。远程 URL / dataURL 只在不额外联网的前提下探一下：
 * - file：直接读字节探尺寸
 * - data：base64 解出头部若干字节就够（PNG/JPEG 头都在前 64KB 内）
 * - url：跳过（不为了量尺寸多下一次网络）
 * 任何失败都返回 null，让调用方退回默认画幅，绝不因为量尺寸而中断生成。
 */
function firstRefDims(refs) {
  const ref = (refs || []).find((r) => r && (r.kind === 'file' || r.kind === 'data'));
  if (!ref) return null;
  try {
    if (ref.kind === 'file') {
      const head = fs.readFileSync(ref.file);
      return probeImageSize(head);
    }
    const bytes = new Uint8Array(Buffer.from(String(ref.value).split(',')[1] || '', 'base64'));
    // JPEG 的 SOFn 段可能靠后，给足前 256KB；拿不到就当没有。
    return probeImageSize(bytes.subarray(0, Math.min(bytes.length, 262144)));
  } catch {
    return null;
  }
}

/**
 * 解析尺寸：显式 size 优先，其次 画幅 × 档位 查表（模型覆盖 > 全局 > 面积推算）。
 *
 * 改图且调用方没指定 size / ratio / resolution 时，**沿用参考图的比例** ——
 * 否则 2687×1500 的参考图会被默认压成 1:1，人物直接变形。
 * @param opts.refDims 第一张参考图的 { width, height }（拿不到就不传）
 */
export function resolveSize(args, config, model, opts = {}) {
  let size = String(args?.size || '').trim().toLowerCase().replace(/\s*\*\s*/g, 'x');
  if (size) {
    if (!/^\d+x\d+$/.test(size) && size !== 'auto') {
      throw new Error('size 必须是 "1024x1024" 这种格式，或 "auto"；收到的是「' + args.size + '」。');
    }
  } else {
    const tier = String(args?.resolution || '1K').toUpperCase();
    const asked = String(args?.ratio || '').trim();
    // 没显式要画幅就跟着参考图走；拿不到参考图尺寸才退回 1:1。
    const ratio = asked || ratioForDims(opts.refDims) || '1:1';
    const table = sizeTable(config, model);
    size = table?.[tier]?.[ratio] || sizeFor(ratio, tier) || '1024x1024';
  }
  // 模型设了长边上限就等比缩小 —— 显式 size 也要缩，否则用户填 4K 会被接口直接 400。
  if (model?.maxSide && size !== 'auto') {
    const [w, h] = size.split('x').map(Number);
    const longest = Math.max(w, h);
    if (longest > model.maxSide) {
      const scale = model.maxSide / longest;
      size = Math.max(16, Math.round((w * scale) / 16) * 16) + 'x' + Math.max(16, Math.round((h * scale) / 16) * 16);
    }
  }
  return size;
}

/**
 * 发一次生成请求。
 *
 * @param opts.resolved  resolveModel() 的成功返回值
 * @param opts.config    当前配置（取超时、尺寸表）
 * @param opts.args      生成参数
 * @param opts.dir       配置目录（决定默认输出目录）
 * @param opts.signal    AbortSignal
 * @param opts.onProgress 轮询进度回调 (attempt, state, progress) => void
 */
export async function runGeneration(opts) {
  const { resolved, config, args, dir, signal } = opts;
  const started = Date.now();

  const prompt = String(args?.prompt || '').trim();
  if (!prompt) throw new Error('prompt 不能为空。');
  const n = Math.min(4, Math.max(1, Math.floor(Number(args?.n) || 1)));

  // ---- 参考图 ----
  const refSources = Array.isArray(args?.images) ? args.images.filter((x) => typeof x === 'string' && x.trim()) : [];
  const refs = refSources.map((r) => readReference(r));
  const refValues = refs.map((r) => r.value);
  const maskRef = String(args?.mask || '').trim() ? readReference(String(args.mask)) : null;

  // 第一张参考图的宽高：改图时拿它推导画幅（不传 ratio 就沿用）。
  // 只探本地字节，不额外读盘（ref.value 已经是读好的 dataURL / 原路径）。
  const size = resolveSize(args, config, resolved.model, { refDims: firstRefDims(refs) });

  // ---- 请求体 ----
  const body = buildBody({
    model: resolved.model.model,
    prompt,
    negative: args?.negative,
    size,
    // 调用方显式给了 size / ratio / resolution 之一，就表示「这次的画幅由我说了算」，
    // protocol 层据此避免被模型 extra 里钉死的尺寸覆盖。
    explicitSize: Boolean(String(args?.size || '').trim() || String(args?.ratio || '').trim() || String(args?.resolution || '').trim()),
    format: args?.format,
    quality: args?.quality,
    background: args?.background,
    ratio: args?.ratio,
    resolution: args?.resolution,
    seed: args?.seed,
    strength: args?.strength,
    mask: maskRef ? maskRef.value : '',
    n,
    bodyTemplate: resolved.model.bodyTemplate,
    extra: resolved.model.extra,
    images: refValues,
    /* ---- 适配层字段 ---- */
    params: resolved.model.params,
    privateParams: args?.params,
    bodyMode: resolved.model.bodyMode,
    imagePayload: resolved.model.imagePayload,
  });

  const isEdit = resolved.mode === 'edit';
  const provider = resolved.provider;
  const timeoutMs = Number(provider.timeoutMs || config.timeoutMs || 180000);
  const ac = new AbortController();
  const onAbort = () => ac.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) throw new Error('已取消。');
    signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => ac.abort(new Error('请求超时（' + timeoutMs + 'ms）')), timeoutMs);

  const headers = { ...(provider.headers || {}) };
  if (provider.apiKey) headers.authorization = 'Bearer ' + provider.apiKey;
  let payload;
  const requestUrl = resolved.url;

  try {
    /* 是否走 JSON 提交（而不是 multipart / 模板占位）：
     *   - 模型显式开了 editJson
     *   - 或声明了参数表**并且**端点不是 OpenAI 那套 /images/edits
     *
     * 注意：不能只看「有没有声明 params」。2.5 这类模型走的是标准
     * multipart /images/edits，如果因为加了参数声明就强改成 JSON 提交，
     * 会把本来能用的改坏 —— 这是引入适配层时最容易踩的回归。 */
    const usesOpenAiEdits = /\/images\/edits\/?$/i.test(String(resolved.endpoint || ''));
    const jsonSubmit = !resolved.usesTemplate
      && (resolved.model?.editJson === true || (resolved.usesParams && !usesOpenAiEdits));

    if (isEdit && !resolved.usesTemplate && jsonSubmit) {
      /* 改图走 JSON + dataURL：参考图放进 images 数组。
         适配「端点叫 /images/edits 但只吃 JSON」的服务（日日新等），
         它们收到 multipart 会返回 400 invalid arguments。 */
      if (!refs.length) throw new Error('改图必须给至少一张参考图（images 参数传本地图片路径）。');
      headers['content-type'] = 'application/json';
      /* 声明式通路已在 protocol.buildBody 里按 imagePayload 装好参考图，
         这里只在「完全没装」时补一次。

         判断要看两个键：`images`（objects / urls 形态）和 `image`
         （image / image_strings 形态）。只看 images 会把 tt-image-2 这种
         「参考图在 image 字段」的模型重复装一份，反而把格式弄错。 */
      const alreadyAttached = body.images !== undefined || body.image !== undefined;
      const jsonBody = resolved.usesParams && alreadyAttached
        ? { ...body }
        : { ...body, images: refs.map((r) => ({ image_url: r.value })) };
      if (maskRef) jsonBody.mask = { image_url: maskRef.value };
      payload = { body: JSON.stringify(jsonBody) };
    } else if (isEdit && !resolved.usesTemplate) {
      // OpenAI 改图协议：multipart/form-data，参考图按 image 字段多份
      if (!refs.length) throw new Error('改图必须给至少一张参考图（images 参数传本地图片路径）。');
      const form = new FormData();
      for (const [k, v] of Object.entries(body)) {
        if (v === undefined || v === null) continue;
        // 声明式通路会把参考图装进 body.images，但 multipart 的参考图是下面的
        // 文件字段，重复发一遍会让站点收到两份图（有的直接 400）。
        if (k === 'images' || k === 'image') continue;
        form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
      }
      refs.forEach((ref, i) => {
        const bytes = refBytes(ref);
        const ext = ref.kind === 'file' ? ref.ext : sniffExt(bytes);
        const media = ref.kind === 'file' ? ref.media : mediaForExt(ext);
        const name = (ref.kind === 'file' ? path.basename(ref.file) : 'image-' + (i + 1) + '.' + (ext || 'png')) || 'image.' + (ext || 'png');
        form.append('image', new Blob([bytes], { type: media }), name);
      });
      if (maskRef) {
        const mbytes = refBytes(maskRef);
        form.append('mask', new Blob([mbytes], { type: mediaForExt(sniffExt(mbytes)) }), 'mask.' + (sniffExt(mbytes) || 'png'));
      }
      payload = { body: form };
    } else {
      headers['content-type'] = 'application/json';
      payload = { body: JSON.stringify(body) };
    }

    let res;
    let text;
    try {
      res = await fetch(requestUrl, { method: 'POST', headers, ...payload, signal: ac.signal });
      text = await res.text();
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/abort/i.test(msg)) {
        const reason = ac.signal.reason;
        throw new Error(
          reason instanceof Error ? reason.message : '请求已取消或超时（' + timeoutMs + 'ms）。',
        );
      }
      /* Node 的 fetch 失败时 message 往往只有一句 "fetch failed"，真正原因在
         e.cause 里（ENOTFOUND / ECONNREFUSED / CERT_… / ETIMEDOUT）。
         不把它带出来，AI 和用户都只能干瞪眼。 */
      throw new Error('请求发不出去：' + describeFetchError(e) + '（' + requestUrl + '）');
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      if (!res.ok) throw new Error(explainHttpFailure(res.status, text, requestUrl));
      throw new Error('接口返回的不是 JSON（HTTP ' + res.status + '）：' + text.slice(0, 260));
    }
    if (!res.ok) {
      const msg = (data && ((data.error && data.error.message) || data.message || data.msg || data.code)) || text.slice(0, 260);
      throw new Error(explainHttpFailure(res.status, msg, requestUrl));
    }
    // 有些站 HTTP 200 但 body 里写失败
    const softState = String(pickPath(data, 'data.state') ?? data?.state ?? data?.status ?? '').toLowerCase();
    if (FAILED_STATES.has(softState) && !pickPath(data, provider.resultUrlsField)) {
      const why = pickPath(data, 'data.error') ?? data?.error ?? data?.message ?? softState;
      throw new Error('接口返回失败：' + (typeof why === 'string' ? why : JSON.stringify(why).slice(0, 240)));
    }

    // ---- 异步任务：提交只拿到 task_id，要轮询到出结果 ----
    let resolvedValues = null;
    if (provider.taskMode === 'poll') {
      const taskId = pickPath(data, provider.taskIdField) || pickPath(data, 'data.task_id') || data?.task_id;
      if (taskId) {
        // 提交已经完成，后面是纯轮询：把「请求超时」定时器收掉，改用轮询自己的总超时。
        // 否则 180s 的请求超时会在出图前把轮询打断，而 pollTimeoutMs 可能设得更长。
        clearTimeout(timer);
        resolvedValues = await pollTaskResult({
          provider: { ...provider, onProgress: opts.onProgress },
          taskId: String(taskId),
          signal: ac.signal,
        });
      } else {
        // 同一个站常混用两种协议：生图走异步任务，改图走 OpenAI 同步端点。
        // 提交响应里直接带图就当同步结果用；既没有 task_id 也没有图才算错。
        try {
          resolvedValues = extractImages(data, resolved.model.resultPath);
        } catch {
          throw new Error(
            '这是异步任务接口，但提交响应里既没有 task_id（按 ' +
              provider.taskIdField +
              ' 取）也没有图片。可能该端点其实是同步协议：把接入点改成 sync 再试。原始响应：' +
              JSON.stringify(data).slice(0, 240),
          );
        }
      }
    }

    // ---- 取值 ----
    const values = resolvedValues || extractImages(data, resolved.model.resultPath);

    // ---- 落盘 ----
    // 主副本**永远**写进画廊目录（galleryDir），这样「作品」页一定看得到。
    // opts.outputDir 只表示「另外再导出一份到这里」，不再替换主副本位置——
    // 之前 saveTo 直接顶替 outDir，图就落到了画廊扫不到的目录，作品页一片空白。
    const galleryOut = galleryDir(dir, config);
    const extraOut = opts.outputDir ? path.resolve(String(opts.outputDir)) : '';
    const sameCopy = extraOut && path.resolve(extraOut) === path.resolve(galleryOut);
    const outDir = galleryOut;
    fs.mkdirSync(outDir, { recursive: true });
    if (extraOut && !sameCopy) fs.mkdirSync(extraOut, { recursive: true });

    const files = [];
    for (let i = 0; i < values.length; i += 1) {
      const bytes = await imageValueToBytes(values[i], provider, ac.signal);
      const ext = sniffExt(bytes);
      const dims = probeImageSize(bytes);
      const base = stamp() + '-' + safeName(resolved.model.name) + (values.length > 1 ? '-' + (i + 1) : '');
      let file = path.join(outDir, base + '.' + ext);
      // 同一秒内多张要避让，否则后一张覆盖前一张
      let dup = 1;
      while (fs.existsSync(file)) file = path.join(outDir, base + '-' + ++dup + '.' + ext);
      fs.writeFileSync(file, bytes);
      // 额外导出：复制一份到用户指定的目录（主副本仍在画廊）
      let extraFile = '';
      if (extraOut && !sameCopy) {
        try {
          extraFile = path.join(extraOut, path.basename(file));
          fs.writeFileSync(extraFile, bytes);
        } catch (e) {
          extraFile = '';
          opts.onExportError?.(String((e && e.message) || e));
        }
      }
      files.push({
        file,
        bytes: bytes.length,
        mediaType: mediaForExt(ext),
        ext,
        ...(dims ? { width: dims.width, height: dims.height } : {}),
        // SVG 不是位图：宿主的附件服务只收 png/jpeg/webp/gif，只能用文本回传给模型
        vector: isSvgExt(ext),
        index: i + 1,
        ...(extraFile ? { extraFile } : {}),
      });
    }

    const result = {
      files,
      size,
      prompt,
      elapsedMs: Date.now() - started,
      requestUrl,
      model: resolved.model.name,
      modelId: resolved.model.model,
      provider: resolved.provider.name,
      providerId: resolved.provider.id,
      mode: resolved.mode,
      refs: refs.map((r) => r.label),
    };

    if (config.recordMetadata !== false) {
      /* 参考图要记**可再次使用的路径**，而不是给人看的 label。
       *
       * label 是 `path.basename()` 或附件哈希（@last 转过来的那种），
       * 拿它当参考图路径会指向一个不存在的位置 —— 复用设置时必然报
       * 「读不到参考图」。所以另存一份 refPaths：
       *   - 本机文件   → 绝对路径
       *   - http URL   → 原样
       *   - dataURL    → 不存（太长且没法重复用），标记 omitted
       */
      const refPaths = [];
      for (const r of refs) {
        if (r.kind === 'file' && r.file) refPaths.push(r.file);
        else if (r.kind === 'url') refPaths.push(r.value);
        else if (r.kind === 'data') refPaths.push('');
      }
      for (const f of files) {
        writeSidecar(f.file, {
          prompt,
          negative: args?.negative || '',
          model: result.model,
          modelId: result.modelId,
          provider: result.provider,
          mode: result.mode,
          size,
          ratio: args?.ratio || '',
          resolution: args?.resolution || '1K',
          quality: args?.quality || '',
          // 记下**实际产出**的扩展名，而不是调用参数：用户没传 format 时，
          // 默认格式由模型 extra / 协议决定，只有落盘结果才是真的。
          format: f.ext || '',
          segment: values.length > 1 ? f.index + '/' + values.length : '',
          refs: result.refs,
          // 可复用的参考图路径（与 refs 一一对应，dataURL 位置为空串）
          refPaths,
          // 本次用到的**模型私有参数**：不留这份，复用设置时这些参数会丢
          params: args?.params && typeof args.params === 'object' ? args.params : {},
          background: args?.background && args.background !== 'auto' ? args.background : '',
          seed: args?.seed === undefined || args?.seed === null || args?.seed === '' ? '' : args.seed,
          n: files.length || 1,
          at: new Date().toISOString(),
          elapsedMs: result.elapsedMs,
        });
      }
    }

    return result;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/* ------------------------------------------------------------------ */
/* 连通性测试                                                          */
/* ------------------------------------------------------------------ */

/** 直连探一次：不发提示词，只探「地址 + 鉴权 + 模型名」。 */
export async function testProvider(config, providerId, modelId) {
  const built = (() => {
    const provider = (config.providers || []).find((p) => p.id === providerId);
    if (!provider) return { ok: false, reason: '没有这个接入点：' + providerId };
    if (!provider.baseUrl) return { ok: false, reason: '接入点「' + provider.name + '」还没填 Base URL。' };
    if (!provider.apiKey && !Object.keys(provider.headers || {}).length) {
      return { ok: false, reason: '接入点「' + provider.name + '」还没填 API Key。' };
    }
    const model =
      (modelId && (config.models || []).find((m) => m.id === modelId || m.model === modelId)) ||
      (config.models || []).find((m) => m.providerId === provider.id) ||
      null;
    if (!model) return { ok: false, reason: '接入点下还没有模型，先加一个模型再测。' };
    // 模型级端点优先（与 resolveModel 同一套优先级），否则「测试」会测错地址
    const own = model.endpoints && typeof model.endpoints === 'object' ? model.endpoints : {};
    const endpoint = String(own.generate || '').trim() || provider.generatePath || '/images/generations';
    return {
      ok: true,
      provider,
      model,
      url: normalizeBase(provider.baseUrl) + (endpoint.startsWith('/') ? endpoint : '/' + endpoint),
    };
  })();

  if (!built.ok) return built;

  const timeoutMs = Math.min(30000, Number(built.provider.timeoutMs || config.timeoutMs || 30000));
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const body = buildBody({
      model: built.model.model,
      prompt: 'ping',
      size: '1024x1024',
      quality: 'low',
      background: 'auto',
      ratio: '1:1',
      n: 1,
      bodyTemplate: built.model.bodyTemplate,
      extra: built.model.extra,
      images: [],
      // 适配层：模型声明了参数表就按声明构造，否则退回 OpenAI 默认协议
      params: built.model.params,
      bodyMode: built.model.bodyMode,
      imagePayload: built.model.imagePayload,
    });
    const headers = { ...(built.provider.headers || {}) };
    if (built.provider.apiKey) headers.authorization = 'Bearer ' + built.provider.apiKey;
    headers['content-type'] = 'application/json';
    const res = await fetch(built.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* 非 JSON 也照样报状态码 */
    }
    if (res.ok) {
      // 异步任务接口在测试里只能验到「提交成功」，这是预期行为
      if (built.provider.taskMode === 'poll') {
        const taskId = pickPath(data, built.provider.taskIdField) || data?.task_id;
        return {
          ok: true,
          status: res.status,
          url: built.url,
          imageOk: Boolean(taskId),
          imageError: taskId ? '' : '提交成功但没拿到 task_id，检查「task_id 取值路径」',
          note: '异步任务接口：已成功提交，出图需在生成时轮询。',
        };
      }
      let imageOk = true;
      let imageError = '';
      try {
        extractImages(data, built.model.resultPath);
      } catch (e) {
        imageOk = false;
        imageError = String(e.message || e);
      }
      return { ok: true, status: res.status, url: built.url, imageOk, imageError };
    }
    const msg = (data && ((data.error && data.error.message) || data.message || data.msg || data.code)) || text.slice(0, 260);
    return { ok: false, status: res.status, reason: explainHttpFailure(res.status, msg, built.url) };
  } catch (e) {
    const msg = String((e && e.message) || e);
    return {
      ok: false,
      reason: /abort/i.test(msg) ? '请求超时（' + timeoutMs + 'ms）或被取消。' : '请求发不出去：' + msg,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 轻量探活：只打 `GET {baseUrl}{path}`（默认 /models），不发提示词、不产生生成费用。
 * 用来先分清「地址/密钥不对」与「模型参数不对」。
 */
export async function probeEndpoint(provider, path = '/models', signal) {
  const base = normalizeBase(provider?.baseUrl);
  if (!base) return { ok: false, reason: '接入点没填 Base URL。' };
  const url = base + (path.startsWith('/') ? path : '/' + path);
  const headers = { ...(provider.headers || {}) };
  if (provider.apiKey) headers.authorization = 'Bearer ' + provider.apiKey;
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ac.abort(), 15000);
  try {
    const res = await fetch(url, { headers, signal: ac.signal });
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* ignore */
    }
    if (!res.ok) {
      const msg = (data && ((data.error && data.error.message) || data.message)) || text.slice(0, 200);
      return { ok: false, status: res.status, url, reason: explainHttpFailure(res.status, msg, url) };
    }
    const count = Array.isArray(data?.data) ? data.data.length : Array.isArray(data) ? data.length : null;
    // 全量返回：model.discover 要靠它一次拿完，截断会静默漏掉模型
    const ids = Array.isArray(data?.data)
      ? data.data.map((m) => m?.id).filter(Boolean)
      : Array.isArray(data)
        ? data.map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean)
        : [];
    return { ok: true, status: res.status, url, count, models: ids };
  } catch (e) {
    const msg = String((e && e.message) || e);
    return { ok: false, url, reason: /abort/i.test(msg) ? '请求超时（15s）。' : '请求发不出去：' + msg };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
