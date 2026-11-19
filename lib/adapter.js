/**
 * dsh-image-gen · 模型适配层
 *
 * 目标：**接一个新模型 = 写一段配置，不改代码**。
 *
 * 以前的做法是插件硬编码一套 OpenAI 形状的参数（model/prompt/size/quality/n…），
 * 站点的私有参数只能塞进 extra，然后被「显式参数优先」静默覆盖掉。接非 OpenAI
 * 站点就必须写整份 bodyTemplate 推倒重来 —— 全有或全无，中间没有层。
 *
 * 这一层补的就是中间那层：**每个模型自己声明它要什么参数**，面板据此渲染真实
 * 控件，工具据此构造请求体，谁也不用猜。
 *
 * 声明写法（宽容度从高到低都收）：
 *
 *   "params": {
 *     // 1) 固定值：调用方改不了（老 extra 的语义，但可读）
 *     "version": "sunburst",
 *
 *     // 2) 简写：值域即枚举，第一个是默认
 *     "quality": ["low", "medium", "high"],
 *
 *     // 3) 完整声明
 *     "complexity": { "type": "int", "min": 1, "max": 3, "default": 2, "label": "复杂度" },
 *
 *     // 4) 由通用参数驱动（关键：把 format/size 这类通用名桥接到站点私有名）
 *     "output_format": { "type": "enum", "values": ["png","gif","svg"], "default": "png", "from": "format" },
 *     "size":          { "type": "string", "from": "size" },
 *     "size_star":     { "type": "string", "from": "size", "transform": "star" }
 *   }
 *
 * 每个声明支持的字段：
 *   type      string | int | number | bool | enum（省略时按 default/values 推断）
 *   values    enum 值域
 *   min/max   数值范围
 *   default   默认值（不给则「不传」，除非 from 取到了值）
 *   label     面板显示名（不给则用参数名）
 *   at        放在请求体哪个容器里：'' = 顶层（默认）, 'params', 'parameters',
 *             'input.parameters' …（点路径，中间层自动创建）
 *   from      由哪个通用参数驱动：prompt/model/n/size/quality/format/background/
 *             seed/strength/negative/ratio/resolution
 *   transform 取值变换：star（1024x1024→1024*1024）/ int / number / string /
 *             bool / upper / lower / dims（→{width,height}）
 *   lock      true = 即使调用方传了也不覆盖（钉死）
 *   send      'always' | 'when-set'（默认 when-set：为空就不发）
 */

/** 声明里能出现的 type。 */
export const PARAM_TYPES = ['string', 'int', 'number', 'bool', 'enum'];

/** 内置变换。 */
const TRANSFORMS = {
  star: (v) => String(v).replace(/[xX*]/g, '*'),
  int: (v) => Math.round(Number(v)),
  number: (v) => Number(v),
  string: (v) => String(v),
  bool: (v) => Boolean(v),
  upper: (v) => String(v).toUpperCase(),
  lower: (v) => String(v).toLowerCase(),
  dims: (v) => {
    const [w, h] = String(v).split(/[x*]/).map(Number);
    return Number.isFinite(w) && Number.isFinite(h) ? { width: w, height: h } : String(v);
  },
};

/** 通用参数名：`from` 只能引用这些。 */
export const COMMON_SOURCES = [
  'prompt',
  'negative',
  'model',
  'n',
  'size',
  'quality',
  'format',
  'background',
  'seed',
  'strength',
  'ratio',
  'resolution',
];

/** 是不是空值（空串 / null / undefined 都算没给）。 */
function isBlank(v) {
  return v === undefined || v === null || v === '';
}

/**
 * 把一段原始声明归一成 `{ 参数名 -> 声明对象 }`，同时收集问题。
 *
 * 返回 `{ params, problems }`。problems 里放「值看着不对但没法证明是错的」条目 ——
 * 调用方（面板保存 / image_admin）要把它们报出来，否则用户会以为配好了。
 *
 * 为什么要收集问题：`version: "sunburst"` 这种写法有两种可能 ——
 * 用户真的想钉死成 sunburst，或者写错了（本意是值域 ["sunburst"]）。
 * 以前一律按「钉死」处理且不吭声，结果是参数永远发不出去、
 * 用户在面板上改也改不动（被 lock 挡住），排查起来极难。
 */
export function normalizeParamsChecked(raw) {
  const params = {};
  const problems = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw !== undefined && raw !== null) problems.push('params 必须是一个对象，收到的是 ' + typeof raw + '。');
    return { params, problems };
  }
  for (const [rawKey, rawSpec] of Object.entries(raw)) {
    const key = String(rawKey || '').trim();
    if (!key) continue;
    const { decl, problem } = normalizeOneChecked(rawSpec, key);
    params[key] = decl;
    if (problem) problems.push(problem);
  }
  return { params, problems };
}

/** 归一 + 检查（内部）。 */
function normalizeOneChecked(spec, key) {
  // 数组简写：枚举
  if (Array.isArray(spec)) {
    if (!spec.length) return { decl: normalizeOne(spec), problem: '参数「' + key + '」的值域是空数组，它会被当成「不传」。' };
    return { decl: normalizeOne(spec), problem: '' };
  }
  // 对象：完整声明
  if (spec !== null && typeof spec === 'object') {
    if (Array.isArray(spec.values) && !spec.values.length && spec.from === undefined) {
      return { decl: normalizeOne(spec), problem: '参数「' + key + '」是 enum 但 values 是空的，它会被当成「不传」。' };
    }
    return { decl: normalizeOne(spec), problem: '' };
  }
  // 固定值（字符串/数字/布尔）
  const decl = normalizeOne(spec);
  let problem = '';
  if (typeof spec === 'string' && /^[,\s]+$/.test(spec) === false && spec.includes(',')) {
    problem =
      '参数「' + key + '」被当成固定值（钉死成 "' + spec + '"，调用时改不了）。' +
      '如果你想给它多个可选值，请写成数组：["' + spec.split(',')[0].trim() + '", …]。';
  } else if (typeof spec === 'string') {
    problem =
      '参数「' + key + '」是字符串固定值（钉死成 "' + spec + '"，调用时改不了）。' +
      '如果本意是「可选值」，请写成数组：["' + spec + '"]；确定要钉死就忽略这条。';
  }
  return { decl, problem };
}

/** 把一段原始声明归一成 `{ 参数名 -> 声明对象 }`（兼容旧签名，丢弃 problems）。 */
export function normalizeParams(raw) {
  return normalizeParamsChecked(raw).params;
}


/** 单条声明的归一。 */
function normalizeOne(spec) {
  // 1) 简写：数组即枚举（值域，第一个是默认）
  if (Array.isArray(spec)) {
    const values = spec.filter((v) => v !== undefined && v !== null);
    return {
      type: 'enum',
      values,
      min: null,
      max: null,
      default: values[0],
      label: '',
      at: '',
      from: '',
      transform: '',
      lock: false,
      send: 'when-set',
    };
  }
  // 2) 固定值：字符串/数字/布尔/null 直接当默认值 + 钉死
  if (spec === null || typeof spec !== 'object') {
    return {
      type: typeof spec === 'number' ? (Number.isInteger(spec) ? 'int' : 'number') : typeof spec === 'boolean' ? 'bool' : 'string',
      values: [],
      min: null,
      max: null,
      default: spec,
      label: '',
      at: '',
      from: '',
      transform: '',
      lock: true,
      send: 'always',
    };
  }

  const values = Array.isArray(spec.values) ? spec.values.filter((v) => v !== undefined && v !== null) : [];
  let type = String(spec.type || '').trim().toLowerCase();
  if (!PARAM_TYPES.includes(type)) {
    type = values.length ? 'enum' : typeof spec.default === 'number' ? (Number.isInteger(spec.default) ? 'int' : 'number') : 'string';
  }

  return {
    type,
    values: type === 'enum' ? values : [],
    min: spec.min === undefined || spec.min === null ? null : Number(spec.min),
    max: spec.max === undefined || spec.max === null ? null : Number(spec.max),
    default: spec.default,
    label: String(spec.label || '').trim(),
    // at 允许写成 "params" / "input.parameters" / ".params"（前导点忽略）
    at: String(spec.at || '').trim().replace(/^\.+/, '').replace(/\.+$/, ''),
    from: String(spec.from || '').trim(),
    transform: String(spec.transform || '').trim(),
    lock: spec.lock === true,
    send: String(spec.send || '').trim() === 'always' ? 'always' : 'when-set',
  };
}

/** 值是否符合声明（只在有值时校验；返回错误串或空串）。 */
export function validateValue(name, decl, value) {
  if (isBlank(value)) return '';
  switch (decl.type) {
    case 'enum':
      if (!decl.values.length) return '';
      // 枚举用宽松比较（站点常把 1K 写成 1k）
      return decl.values.some((v) => String(v) === String(value))
        ? ''
        : '参数「' + (decl.label || name) + '」只能是 ' + decl.values.join(' / ') + '，收到的是「' + value + '」。';
    case 'int':
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n)) return '参数「' + (decl.label || name) + '」要填数字，收到的是「' + value + '」。';
      if (decl.type === 'int' && !Number.isInteger(n)) return '参数「' + (decl.label || name) + '」要填整数。';
      if (decl.min !== null && n < decl.min) return '参数「' + (decl.label || name) + '」不能小于 ' + decl.min + '。';
      if (decl.max !== null && n > decl.max) return '参数「' + (decl.label || name) + '」不能大于 ' + decl.max + '。';
      return '';
    }
    case 'bool':
      return /^(true|false|1|0|yes|no)$/i.test(String(value))
        ? ''
        : '参数「' + (decl.label || name) + '」要填 true / false。';
    default:
      return '';
  }
}

/** 按类型把值收敛成该发的样子。 */
function coerce(decl, value) {
  if (decl.transform && TRANSFORMS[decl.transform]) {
    try {
      return TRANSFORMS[decl.transform](value);
    } catch {
      /* 变换失败就用原值 */
    }
  }
  switch (decl.type) {
    case 'int':
      return Math.round(Number(value));
    case 'number':
      return Number(value);
    case 'bool':
      return /^(true|1|yes)$/i.test(String(value));
    case 'enum': {
      // 保留站点声明的原始大小写
      const hit = decl.values.find((v) => String(v) === String(value));
      return hit === undefined ? value : hit;
    }
    default:
      return typeof value === 'string' ? value : String(value);
  }
}

/** 声明是不是「由通用参数驱动」。 */
export function isBridged(decl) {
  return Boolean(decl?.from);
}

/** 一个模型的参数声明里，被 from 引用的通用参数集合（面板用它决定要不要显示某控件）。 */
export function bridgedSources(params) {
  const out = new Set();
  for (const decl of Object.values(params || {})) if (decl.from) out.add(decl.from);
  return out;
}

/**
 * 把值写进请求体的指定容器。
 * at='' 写顶层；at='params' 写 body.params[key]；at='input.parameters' 逐层建对象。
 */
export function setAt(body, container, key, value) {
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

/** 读已写在 body 里的值（用于「同路径已存在就不重复写」判断）。 */
function getAt(body, container, key) {
  const path = String(container || '').split('.').filter(Boolean);
  let cur = body;
  for (const seg of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur && typeof cur === 'object' ? cur[key] : undefined;
}

/**
 * 按声明表把参数铺进请求体。
 *
 * 优先级（高 → 低）：
 *   1. lock = true 的固定值（钉死）
 *   2. 调用方在 `params` 里**显式指名**的模型私有参数
 *   3. 由 `from` 桥接来的通用参数（如 format → output_format）
 *   4. 声明的 default
 *
 * @param body     正在构造的请求体（会被就地修改）
 * @param params   归一后的声明表
 * @param ctx      通用参数上下文（prompt/model/n/size/quality/format/…）
 * @param explicit 调用方显式传来的模型私有参数（image_generate 的 params）
 * @param onError  校验失败回调 (message) => void；不传就静默丢弃该项
 * @returns {{ applied: string[], skipped: string[] }}
 */
export function applyParams(body, params, ctx, explicit, onError) {
  const applied = [];
  const skipped = [];
  const given = explicit && typeof explicit === 'object' && !Array.isArray(explicit) ? explicit : {};

  for (const [name, decl] of Object.entries(params || {})) {
    const at = decl.at;

    // ---- 取值 ----
    let value;
    let source = '';
    if (decl.lock) {
      value = decl.default;
      source = 'lock';
    } else if (Object.prototype.hasOwnProperty.call(given, name) && !isBlank(given[name])) {
      value = given[name];
      source = 'explicit';
    } else if (decl.from && !isBlank(ctx[decl.from])) {
      value = ctx[decl.from];
      source = 'from:' + decl.from;
    } else if (decl.default !== undefined) {
      /* 桥接参数在源值为空时**回落到声明默认值**（而不是干脆不发）。
         例：output_format 跟随 format，用户没选格式时应该发默认 png，
         而不是让站点自己决定 —— 否则「不传 format 就是静图」这个承诺就断了。
         没写 default 的桥接参数（如 size 跟随 size）才真的跳过。 */
      value = decl.default;
      source = 'default';
    }

    // ---- 兜底：同一容器里已经有这个键（比如默认协议铺过的） ----
    if (isBlank(value)) {
      const existing = getAt(body, at, name);
      if (!isBlank(existing)) {
        applied.push(name);
        continue;
      }
      skipped.push(name);
      continue;
    }

    // ---- 校验 ----
    const err = validateValue(name, decl, value);
    if (err) {
      if (onError) onError(err);
      skipped.push(name);
      continue;
    }

    setAt(body, at, name, coerce(decl, value));
    applied.push(name);
    void source;
  }

  return { applied, skipped };
}

/**
 * 编译一个模型的「请求构造计划」。
 * 没有参数声明时返回 `{ declared: false }`，调用方走默认 OpenAI 协议（向后兼容）。
 */
export function compilePlan(model) {
  const params = normalizeParams(model?.params);
  const names = Object.keys(params);
  if (!names.length) return { declared: false, params: {} };
  return {
    declared: true,
    params,
    // 声明了 OUTPUT 参数就说明请求体由声明说了算，不再追加 OpenAI 的默认字段
    selfDescribing: true,
  };
}

/** 给面板用的「这个模型可调哪些参数」清单（不含 from 桥接的，那些走通用控件）。 */
export function editableParams(params) {
  const out = [];
  for (const [name, decl] of Object.entries(params || {})) {
    if (decl.lock) continue; // 固定值不给用户改
    out.push({
      name,
      type: decl.type,
      values: decl.values,
      min: decl.min,
      max: decl.max,
      default: decl.default,
      label: decl.label || name,
      at: decl.at,
      from: decl.from,
      bridged: Boolean(decl.from),
      send: decl.send,
    });
  }
  return out;
}

/** 给模型（AI）看的参数说明，写进 image_config op=models 的清单。 */
export function describeParams(params) {
  const list = [];
  for (const [name, decl] of Object.entries(params || {})) {
    const bits = [];
    bits.push(name);
    if (decl.type === 'enum' && decl.values.length) bits.push('∈{' + decl.values.join('|') + '}');
    else if (decl.type === 'int' || decl.type === 'number') {
      const range = decl.min !== null || decl.max !== null ? '[' + (decl.min ?? '') + '..' + (decl.max ?? '') + ']' : '';
      bits.push(decl.type + range);
    } else bits.push(decl.type);
    if (decl.default !== undefined && decl.default !== '') bits.push('默认=' + JSON.stringify(decl.default));
    if (decl.lock) bits.push('钉死');
    if (decl.from) bits.push('由 ' + decl.from + ' 驱动');
    if (decl.label) bits.push('「' + decl.label + '」');
    list.push(bits.join(' '));
  }
  return list;
}
