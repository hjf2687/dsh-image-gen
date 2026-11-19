/**
 * dsh-image-gen · loader 入口
 *
 * 与 dsh-usage-meter 同构：Loader 把本模块登记进 ESM registry，改完 host 侧代码
 * 不重启就拿不到新代码。所以这里只做「按 mtime 重新 import」的薄壳，
 * 真正的贡献都在 host.js / runner.js / store.js / protocol.js 里。
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-image-gen';
export const inject = ['tools', 'webServer'];
const HOST_URL = new URL('./host.js', import.meta.url);
const CLOSURE = ['host.js', 'runner.js', 'store.js', 'protocol.js'];
let lastStamp = '';

function closureStamp() {
  const parts = [];
  for (const relative of CLOSURE) {
    try {
      const stat = fs.statSync(fileURLToPath(new URL(`./${relative}`, import.meta.url)));
      parts.push(`${relative}:${Math.round(stat.mtimeMs)}:${stat.size}`);
    } catch {
      parts.push(`${relative}:missing`);
    }
  }
  return parts.join('|');
}

export async function apply(ctx, config) {
  const stamp = closureStamp();
  const target = new URL(HOST_URL.href);
  target.searchParams.set('v', encodeURIComponent(stamp));
  if (stamp !== lastStamp) {
    lastStamp = stamp;
    console.log('[image-gen] host closure changed — reloading it from disk');
  }
  const host = await import(target.href);
  if (typeof host.buildGenerateTool !== 'function') {
    throw new Error('dsh-image-gen: lib/host.js 没有导出 buildGenerateTool()');
  }

  const configDir = String(config?.dir || '').trim();

  // ---- 工具 ----
  ctx.effect(() => ctx.tools.register(host.buildGenerateTool(ctx, configDir)), 'image-gen: image_generate');
  // 查询和配置拆成两个工具：查询类的 schema 只有几百字符，配置类的（baseUrl/apiKey/bodyTemplate…）
  // 有 3.5K 字符，只有真要改配置时才用得上，不该常驻上下文。
  ctx.effect(() => ctx.tools.register(host.buildQueryTool(configDir)), 'image-gen: image_config');
  ctx.effect(() => ctx.tools.register(host.buildAdminTool(configDir)), 'image-gen: image_admin');

  // ---- 面板路由 ----
  ctx.effect(
    () => ctx.webServer.register(host.buildRoute(ctx, configDir)),
    'image-gen: panel routes',
  );

  // ---- 系统提示词 ----
  // 只有工具定义时，模型看到的是「有个叫 image_generate 的工具」，并不会想到
  // 在「帮我画一张…」这种请求里该用它。这一段把「什么时候该主动出图」写进提示词。
  ctx.inject(['systemPrompt'], (sp) => {
    sp.effect(
      () => sp.systemPrompt.section({
        name: 'image-gen:capabilities',
        // 放在工具清单附近（dsh-ops 的 tooling 段是 3250），紧随其后。
        order: 3260,
        interpolate: false,
        text: () => {
          // 没配模型时不说「可以出图」，否则模型会去调用一个必然失败的工具。
          return host.renderCapabilitySection(ctx, configDir);
        },
      }),
      'image-gen: capability section',
    );
  });

  console.log('[image-gen] ready (image_generate / image_config / image_admin / ' + host.routePrefix() + ')');
}
