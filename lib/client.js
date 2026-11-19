/**
 * dsh-image-gen · client 半（v0.3 重构版前端）
 *
 * 由 Harness 客户端模块系统按工厂包加载：bootstrap 注入 window.__ModuleLoader__，
 * require('react') 由平台静态表回答，因此本文件无构建步骤、无自有依赖。
 *
 * 贡献两个面：
 *   1. `sidebar.panellist` —— 左侧栏一个图标入口。
 *   2. `main`（同 id 的 key）—— 该入口打开的中心面板。
 *
 * 设计要点（参考「生图工作台」的单入口创作台）：
 *   · 顶部一条 topbar：品牌 + 分段导航（创作 / 作品 / 接入点与模型）+ 接口状态。
 *   · 创作页 = 结果舞台（自己滚动）+ 吸底创作台；一次生成就是一个「批次」，
 *     提示词、参数、参考图、结果都在同一张卡片里，不再被下一次生成冲掉。
 *   · 参数是胶囊 + 原生 select 透明叠加：既能点、也能键盘操作，无自绘下拉。
 *   · 参考图轨道贴在输入框左侧：空态是斜放虚线条，有图时堆叠、悬停扇形展开。
 *   · 颜色全部取自宿主主题令牌（--dsw-alias-*），深浅色自动成立。
 *
 * 数据一律走 host 半的 /dsh-image-gen/* 路由，与 image_generate / image_config
 * 工具读写同一份配置，所以面板里改完，模型下一句话就能用上新模型。
 */

window.__ModuleLoader__.load({
  id: 'dsh-image-gen',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef, useMemo, memo } = React;

    const NS = 'dsh-image-gen';
    const PANEL_ID = 'image-gen';
    const ROUTE = '/dsh-image-gen';
    const MAX_REFS = 8;

    /* ================================================================== */
    /* 样式                                                               */
    /* ================================================================== */

    const CSS = `
/* ------------------------------------------------------------------
   0. 令牌：一律从宿主主题派生，深/浅色都靠这一层自动成立
   ------------------------------------------------------------------ */
.ig{
  --ig-bg:var(--dsw-alias-bg-base,#fff);
  --ig-layer:var(--dsw-alias-bg-layer-1,#fff);
  --ig-fg:var(--dsw-alias-label-primary,#0f1115);
  --ig-fg2:var(--dsw-alias-label-secondary,#61666b);
  --ig-fg3:var(--dsw-alias-label-tertiary,#81858c);
  --ig-fg4:var(--dsw-alias-label-caption,#adb2b8);
  --ig-line:var(--dsw-alias-border-l2,rgba(0,0,0,.10));
  --ig-line2:var(--dsw-alias-border-l3,rgba(0,0,0,.12));
  --ig-line-soft:var(--dsw-alias-border-l1,rgba(0,0,0,.05));
  --ig-brand:var(--dsw-alias-brand-primary,#0f1115);
  --ig-on-brand:var(--dsw-alias-label-primary-foreground,#fff);
  --ig-brand-hover:var(--dsw-alias-button-primary-hover,#43454a);
  --ig-accent:var(--dsw-alias-state-business-primary,#4176e6);
  --ig-ok:var(--dsw-alias-state-success-primary,#22c55e);
  --ig-warn:var(--dsw-alias-state-warn-primary,#f59e0b);
  --ig-bad:var(--dsw-alias-state-error-primary,#ec1313);
  --ig-hover:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));
  --ig-active:var(--dsw-alias-interactive-bg-active,rgba(38,49,72,.10));
  --ig-fill:var(--dsw-alias-button-ghost-active-fill,rgba(0,0,0,.04));
  --ig-mask:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.24));
  --ig-shadow-panel:var(--dsw-elevation-soft,0 2px 10px rgba(0,0,0,.05));
  --ig-shadow-pop:var(--dsw-elevation-prominent,0 18px 44px rgba(0,0,0,.16));
  --ig-font:var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif);
  --ig-mono:var(--dsh-font-family-code-default,"SF Mono","JetBrains Mono",Consolas,monospace);
  --ig-ease:var(--ds-ease-in-out,cubic-bezier(.4,0,.2,1));
  --ig-r-sm:7px;
  --ig-r-md:10px;
  --ig-r-lg:14px;

  height:100%;min-height:0;display:flex;flex-direction:column;
  background:var(--ig-bg);color:var(--ig-fg);
  font-family:var(--ig-font);font-size:13px;line-height:1.55;
  -webkit-font-smoothing:antialiased;overflow:hidden;
}
.ig *,.ig *::before,.ig *::after{box-sizing:border-box}
/*
 * 元素级重置一律包在 :where() 里 —— :where() 的优先级是 0，重置只做「兜底默认值」，
 * 任何 .ig-xxx 类规则都能覆盖它。
 * 之前写成 .ig button{border:0}（优先级 0,1,1）会压过 .ig-btn / .ig-rail-add
 * 这些 (0,1,0) 的类规则，导致「加图」「参考图」和一堆按钮全都没有边框 —— 看起来就是“没框”。
 */
.ig :where(button, input, select, textarea){font:inherit;letter-spacing:0;color:inherit}
.ig :where(button){appearance:none;-webkit-appearance:none;border:0;cursor:pointer;background:none}
.ig :where(button:disabled){cursor:not-allowed}
.ig ::selection{background:color-mix(in srgb,var(--ig-accent) 26%,transparent)}
.ig :focus-visible{outline:2px solid var(--ig-accent);outline-offset:2px;border-radius:4px}
.ig svg{display:block;flex:0 0 auto}
.ig-mono{font-family:var(--ig-mono);font-size:11.5px;word-break:break-all}

/* 滚动条：细、低对比 */
.ig-scroll{scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2,rgba(0,0,0,.14)) transparent}
.ig-scroll::-webkit-scrollbar{width:10px;height:10px}
.ig-scroll::-webkit-scrollbar-thumb{
  background:var(--dsw-alias-scrollbar-bg-l2,rgba(0,0,0,.14));
  border-radius:99px;border:3px solid transparent;background-clip:padding-box;
}
.ig-scroll::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-scrollbar-hover-l2,rgba(0,0,0,.24));background-clip:padding-box}

/* ------------------------------------------------------------------
   1. 顶栏
   ------------------------------------------------------------------ */
.ig-top{
  flex:0 0 auto;display:flex;align-items:center;gap:12px;
  height:56px;padding:0 20px;
  border-bottom:1px solid var(--ig-line-soft);
  background:var(--ig-bg);
}
.ig-brand{display:flex;align-items:center;gap:9px;min-width:0;padding-right:4px}
.ig-brand-mark{
  width:26px;height:26px;border-radius:8px;display:grid;place-items:center;
  background:var(--ig-brand);color:var(--ig-on-brand);flex:0 0 auto;
}
.ig-brand-name{font-size:14px;font-weight:600;white-space:nowrap;letter-spacing:.01em}
.ig-nav{
  display:flex;gap:2px;padding:3px;margin-left:4px;
  border-radius:9px;background:var(--ig-fill);
}
.ig-nav-btn{
  height:28px;padding:0 13px;border-radius:7px;font-size:13px;color:var(--ig-fg2);
  display:inline-flex;align-items:center;gap:6px;
  transition:background .14s ease,color .14s ease;
}
.ig-nav-btn:hover{color:var(--ig-fg);background:var(--ig-hover)}
.ig-nav-btn[aria-selected="true"]{
  background:var(--ig-layer);color:var(--ig-fg);font-weight:600;
  box-shadow:0 1px 2px rgba(0,0,0,.07);
}
.ig-nav-count{
  font-size:10.5px;font-weight:500;font-variant-numeric:tabular-nums;
  padding:0 5px;border-radius:99px;background:var(--ig-active);color:var(--ig-fg2);
}
.ig-top-right{margin-left:auto;display:flex;align-items:center;gap:8px}
.ig-status{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--ig-fg3);white-space:nowrap}
.ig-status::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--ig-fg4);flex:0 0 auto}
.ig-status[data-tone="ok"]::before{background:var(--ig-ok)}
.ig-status[data-tone="warn"]::before{background:var(--ig-warn)}

/* ------------------------------------------------------------------
   2. 按钮 / 表单基元
   ------------------------------------------------------------------ */
.ig-btn{
  display:inline-flex;align-items:center;justify-content:center;gap:6px;
  height:32px;padding:0 12px;border-radius:8px;
  border:1px solid var(--ig-line);background:var(--ig-layer);color:var(--ig-fg);
  font-size:12.5px;white-space:nowrap;
  transition:background .14s ease,border-color .14s ease,color .14s ease;
}
.ig-btn:hover:not(:disabled){background:var(--ig-hover);border-color:var(--ig-line2)}
.ig-btn:active:not(:disabled){transform:translateY(.5px)}
.ig-btn:disabled{opacity:.42}
.ig-btn-primary{background:var(--ig-brand);color:var(--ig-on-brand);border-color:transparent;font-weight:600}
.ig-btn-primary:hover:not(:disabled){background:var(--ig-brand-hover);border-color:transparent}
.ig-btn-ghost{border-color:transparent;background:transparent;color:var(--ig-fg2)}
.ig-btn-ghost:hover:not(:disabled){background:var(--ig-hover);color:var(--ig-fg);border-color:transparent}
.ig-btn-danger{color:var(--ig-bad);border-color:color-mix(in srgb,var(--ig-bad) 28%,transparent);background:transparent}
.ig-btn-danger:hover:not(:disabled){background:color-mix(in srgb,var(--ig-bad) 10%,transparent);border-color:color-mix(in srgb,var(--ig-bad) 40%,transparent)}
.ig-btn-sm{height:28px;padding:0 9px;font-size:12px;border-radius:7px}
.ig-iconbtn{width:30px;height:30px;padding:0;border-radius:8px;color:var(--ig-fg2)}
.ig-iconbtn:hover:not(:disabled){color:var(--ig-fg)}
.ig-linkbtn{
  padding:0;font-size:12px;color:var(--ig-fg3);background:none;border:0;
  display:inline-flex;align-items:center;gap:4px;
  transition:color .14s ease;
}
.ig-linkbtn:hover{color:var(--ig-accent)}
.ig-linkbtn:disabled{opacity:.4}

.ig-input,.ig-select,.ig-area{
  width:100%;min-width:0;height:34px;padding:0 10px;
  border:1px solid var(--ig-line);border-radius:8px;
  background:var(--ig-layer);color:var(--ig-fg);font-size:12.5px;outline:none;
  transition:border-color .14s ease,box-shadow .14s ease,background .14s ease;
}
.ig-input::placeholder,.ig-area::placeholder{color:var(--ig-fg4)}
.ig-input:hover,.ig-select:hover,.ig-area:hover{border-color:var(--ig-line2)}
.ig-input:focus,.ig-select:focus,.ig-area:focus{
  border-color:var(--ig-accent);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--ig-accent) 18%,transparent);
}
.ig-select{cursor:pointer;appearance:none;padding-right:26px;
  background-image:linear-gradient(45deg,transparent 50%,var(--ig-fg3) 50%),linear-gradient(135deg,var(--ig-fg3) 50%,transparent 50%);
  background-position:calc(100% - 14px) 52%,calc(100% - 9px) 52%;
  background-size:5px 5px,5px 5px;background-repeat:no-repeat;
}
.ig-area{height:auto;min-height:88px;padding:8px 10px;line-height:1.6;resize:vertical}
.ig-area-code{font-family:var(--ig-mono);font-size:11.5px;min-height:70px}
.ig-field{display:flex;flex-direction:column;gap:5px;margin-bottom:10px;min-width:0}
.ig-label{font-size:12px;font-weight:600;color:var(--ig-fg2)}
.ig-hint{font-size:11.5px;color:var(--ig-fg3);line-height:1.55}
.ig-sep{height:1px;background:var(--ig-line-soft);margin:12px 0;border:0}

/* 分段控制器 */
.ig-seg{display:inline-flex;gap:2px;padding:2px;border-radius:8px;background:var(--ig-fill)}
.ig-seg button{height:26px;padding:0 10px;border-radius:6px;font-size:12px;color:var(--ig-fg2);transition:background .14s,color .14s}
.ig-seg button:hover{color:var(--ig-fg)}
.ig-seg button[aria-pressed="true"]{background:var(--ig-layer);color:var(--ig-fg);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.07)}

/* 标签 */
.ig-tag{
  display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 9px;
  border-radius:99px;border:1px solid var(--ig-line-soft);background:var(--ig-fill);
  color:var(--ig-fg2);font-size:11.5px;white-space:nowrap;max-width:100%;
}
.ig-tag[data-tone="ok"]{color:var(--ig-ok);border-color:color-mix(in srgb,var(--ig-ok) 30%,transparent);background:color-mix(in srgb,var(--ig-ok) 10%,transparent)}
.ig-tag[data-tone="bad"]{color:var(--ig-bad);border-color:color-mix(in srgb,var(--ig-bad) 30%,transparent);background:color-mix(in srgb,var(--ig-bad) 10%,transparent)}
.ig-tag[data-tone="warn"]{color:var(--ig-warn);border-color:color-mix(in srgb,var(--ig-warn) 34%,transparent);background:color-mix(in srgb,var(--ig-warn) 12%,transparent)}
.ig-tag[data-tone="brand"]{color:var(--ig-accent);border-color:color-mix(in srgb,var(--ig-accent) 30%,transparent);background:color-mix(in srgb,var(--ig-accent) 9%,transparent)}
/* 作品页的「编辑 / 生成」：编辑=淡紫，生成=中性灰，和创作台语义一致 */
.ig-tag[data-tone="violet"]{color:#7c5cd6;border-color:rgba(124,92,214,.26);background:rgba(124,92,214,.09)}

/* 提示条 */
.ig-msg{
  display:flex;gap:8px;align-items:flex-start;
  padding:8px 11px;border-radius:8px;font-size:12px;line-height:1.6;
  border:1px solid var(--ig-line-soft);background:var(--ig-fill);color:var(--ig-fg2);
  white-space:pre-wrap;word-break:break-word;
}
.ig-msg[data-tone="ok"]{color:color-mix(in srgb,var(--ig-ok) 78%,var(--ig-fg));border-color:color-mix(in srgb,var(--ig-ok) 26%,transparent);background:color-mix(in srgb,var(--ig-ok) 8%,transparent)}
.ig-msg[data-tone="bad"]{color:color-mix(in srgb,var(--ig-bad) 82%,var(--ig-fg));border-color:color-mix(in srgb,var(--ig-bad) 26%,transparent);background:color-mix(in srgb,var(--ig-bad) 8%,transparent)}
.ig-msg[data-tone="warn"]{color:color-mix(in srgb,var(--ig-warn) 82%,var(--ig-fg));border-color:color-mix(in srgb,var(--ig-warn) 28%,transparent);background:color-mix(in srgb,var(--ig-warn) 10%,transparent)}

/* ------------------------------------------------------------------
   3. 舞台（创作页）
   ------------------------------------------------------------------ */
.ig-view{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}
.ig-stage{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;position:relative}
.ig-stage-inner{
  width:100%;max-width:1060px;margin:0 auto;
  padding:24px 30px 18px;min-height:100%;
  display:flex;flex-direction:column;
}
.ig-feed{display:flex;flex-direction:column;gap:26px;flex:1 0 auto}

/* 空态
 *
 * 对齐「生图工作台」的做法：一小块居中提示（圆形图标 + 标题 + 一行灰字），
 * 不做按钮、不做缩略图墙。留白本身是干净的，塞满反而显乱。
 * 用 place-items:center 真正居中，而不是把内容顶到上面。 */
.ig-empty{
  flex:1 1 auto;min-height:180px;
  display:grid;place-items:center;text-align:center;
  color:var(--ig-fg3);padding:24px 20px;
}
.ig-empty-inner{display:flex;flex-direction:column;align-items:center}
.ig-empty-mark{
  width:52px;height:52px;border-radius:50%;display:grid;place-items:center;
  background:var(--ig-brand);color:var(--ig-on-brand);margin-bottom:14px;
  box-shadow:var(--ig-shadow-card, 0 2px 8px rgba(0,0,0,.12));
}
.ig-empty-title{font-size:14.5px;font-weight:600;color:var(--ig-fg);display:block}
.ig-empty-text{
  font-size:11.5px;color:var(--ig-fg4);display:block;
  margin-top:8px;max-width:30em;line-height:1.6;
}
/* 「还没有模型」那屏需要唯一的一个入口按钮，其余空态不用 */
.ig-empty-actions{display:flex;gap:8px;margin-top:14px;justify-content:center;flex-wrap:wrap}

/* ------------------------------------------------------------------
   4. 批次卡
   ------------------------------------------------------------------ */
.ig-batch{display:flex;flex-direction:column;gap:10px;min-width:0}
.ig-batch-head{display:flex;flex-direction:column;gap:7px;min-width:0}
.ig-batch-prompt{
  font-size:15.5px;line-height:1.6;color:var(--ig-fg);margin:0;
  white-space:pre-wrap;overflow-wrap:anywhere;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;
}
.ig-batch-prompt[data-open="1"]{display:block;-webkit-line-clamp:unset}
.ig-batch-promptwrap{position:relative;min-width:0}
.ig-batch-toggle{
  margin-top:3px;padding:0;background:none;border:0;
  font-size:12px;font-weight:600;color:var(--ig-accent);
}
.ig-batch-toggle:hover{text-decoration:underline}
.ig-batch-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.ig-batch-summary{
  display:flex;align-items:center;gap:7px;font-size:12px;color:var(--ig-fg3);
}
.ig-batch-summary .ig-dot{width:7px;height:7px;border-radius:50%;background:var(--ig-accent);flex:0 0 auto;animation:ig-pulse 1.5s ease-in-out infinite}
.ig-batch-summary[data-state="done"] .ig-dot{background:var(--ig-ok);animation:none}
.ig-batch-summary[data-state="failed"] .ig-dot{background:var(--ig-bad);animation:none}
.ig-batch-summary[data-state="cancelled"] .ig-dot{background:var(--ig-fg4);animation:none}
.ig-batch-elapsed{margin-left:auto;font-variant-numeric:tabular-nums;color:var(--ig-fg4);font-size:11.5px}
.ig-batch-acts{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto}

/* 槽位网格 */
.ig-slots{display:grid;gap:8px;width:100%;min-width:0}
.ig-slots[data-count="1"]{grid-template-columns:minmax(180px,352px)}
.ig-slots[data-count="2"]{grid-template-columns:repeat(2,minmax(0,336px))}
.ig-slots[data-count="3"]{grid-template-columns:repeat(3,minmax(0,1fr))}
.ig-slots[data-count="4"]{grid-template-columns:repeat(4,minmax(0,1fr))}
.ig-slot{
  position:relative;min-width:0;border-radius:var(--ig-r-md);overflow:hidden;
  border:1px solid var(--ig-line-soft);background:var(--ig-fill);
  max-height:min(54vh,468px);
}
.ig-slot.is-running{aspect-ratio:var(--ig-ar,1/1);overflow:hidden}
.ig-slot.is-running::before{
  content:'';position:absolute;inset:0;
  background:linear-gradient(105deg,transparent 22%,color-mix(in srgb,var(--ig-accent) 12%,transparent) 46%,transparent 72%);
  background-size:220% 100%;animation:ig-shimmer 2.2s linear infinite;
}
.ig-slot.is-running::after{
  content:'';position:absolute;inset:0;
  background:radial-gradient(120% 100% at 50% 0%,color-mix(in srgb,var(--ig-accent) 5%,transparent),transparent 65%);
}
.ig-slot img{display:block;width:100%;height:100%;object-fit:contain;background:var(--ig-fill);cursor:zoom-in}
.ig-slot-cancel{
  position:absolute;right:8px;bottom:8px;z-index:3;
  height:26px;padding:0 9px;border-radius:6px;font-size:11.5px;
  background:color-mix(in srgb,var(--ig-fg) 74%,transparent);color:var(--ig-bg);
  backdrop-filter:blur(6px);
}
.ig-slot-download{
  position:absolute;right:8px;bottom:8px;z-index:3;
  height:28px;padding:0 10px;border-radius:6px;font-size:11.5px;font-weight:600;
  display:inline-flex;align-items:center;gap:5px;text-decoration:none;
  background:color-mix(in srgb,var(--ig-fg) 76%,transparent);color:var(--ig-bg);
  opacity:0;transform:translateY(3px);
  backdrop-filter:blur(6px);
  transition:opacity .16s ease,transform .16s ease,background .14s ease;
}
.ig-slot:hover .ig-slot-download,.ig-slot:focus-within .ig-slot-download{opacity:1;transform:none}
.ig-slot-download:hover{background:var(--ig-accent)}
.ig-slot-fail{
  aspect-ratio:var(--ig-ar,1/1);display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:6px;padding:16px;
  background:color-mix(in srgb,var(--ig-bad) 6%,transparent);
  border:1px dashed color-mix(in srgb,var(--ig-bad) 32%,transparent);
  color:color-mix(in srgb,var(--ig-bad) 82%,var(--ig-fg));
  font-size:12px;line-height:1.55;text-align:center;word-break:break-word;
}
.ig-slot-fail-ico{opacity:.7}

/* ------------------------------------------------------------------
   5. 吸底创作台
   ------------------------------------------------------------------ */
.ig-dock{flex:0 0 auto;padding:0 30px 20px;position:relative}
.ig-dock::before{
  content:'';position:absolute;left:0;right:0;top:-26px;height:26px;
  background:linear-gradient(to top,var(--ig-bg),transparent);
  pointer-events:none;opacity:.9;
}
.ig-composer{
  max-width:1000px;margin:0 auto;
  background:var(--ig-layer);border:1px solid var(--ig-line);border-radius:16px;
  box-shadow:var(--ig-shadow-panel);padding:12px 14px 10px;
  transition:border-color .16s ease,box-shadow .16s ease;
}
.ig-composer:focus-within{border-color:var(--ig-line2);box-shadow:var(--ig-shadow-pop)}
.ig-composer-main{display:flex;gap:10px;align-items:flex-start}
.ig-composer-main{min-height:74px}

/* —— 参考图轨道 —— */
.ig-rail{position:relative;flex:0 0 52px;width:52px;min-height:74px;z-index:6;display:flex;align-items:flex-start}
.ig-rail-empty{
  width:52px;height:66px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;
  padding:0;overflow:hidden;
  border:1px dashed var(--ig-line2);border-radius:var(--ig-r-sm);
  background:var(--ig-fill);color:var(--ig-fg4);
  transform:rotate(-8deg);
  transition:transform .2s var(--ig-ease),border-color .16s ease,color .16s ease,background .16s ease;
}
.ig-rail-empty:hover{
  transform:rotate(-3deg);border-color:var(--ig-accent);color:var(--ig-accent);
  /* 底色必须不透明：面板背景是白/浅灰，透明底色会让下面的提示词文字透上来 */
  background:color-mix(in srgb,var(--ig-accent) 7%,var(--ig-bg));
}
.ig-rail-empty span{font-size:10.5px;line-height:1;letter-spacing:0;white-space:nowrap}
/* 收起时：所有卡片叠在同一个位置；悬停时向右扇形展开，加图位始终在末尾 */
.ig-rail-stack{position:relative;height:66px;display:flex;align-items:center;width:52px;transition:width .22s var(--ig-ease)}
.ig-rail-stack:hover{width:auto}
.ig-ref{
  position:relative;width:52px;height:66px;flex:0 0 52px;padding:0;
  border:1px solid var(--ig-line2);border-radius:var(--ig-r-sm);
  background:var(--ig-layer);overflow:hidden;line-height:1;
  box-shadow:0 1px 2px rgba(0,0,0,.07);
  transform:rotate(-8deg);
  transition:transform .22s var(--ig-ease),margin .22s var(--ig-ease),opacity .16s ease,box-shadow .16s ease,border-color .14s ease;
}
.ig-rail-stack:not(:hover) .ig-ref+.ig-ref{margin-left:-52px;opacity:0;pointer-events:none}
.ig-ref img{display:block;width:100%;height:100%;object-fit:cover}
.ig-ref-ph{display:flex;align-items:center;justify-content:center;width:100%;height:100%;color:var(--ig-fg4);background:var(--ig-fill)}
.ig-ref-idx{
  position:absolute;left:0;right:0;bottom:0;padding:1px 0;
  font-size:10px;text-align:center;
  background:color-mix(in srgb,var(--ig-fg) 64%,transparent);color:var(--ig-bg);
}
.ig-ref-del{
  position:absolute;right:1px;top:1px;width:16px;height:16px;padding:0;border-radius:50%;
  display:grid;place-items:center;opacity:.75;
  background:color-mix(in srgb,var(--ig-fg) 64%,transparent);color:var(--ig-bg);
  transition:opacity .12s ease,background .12s ease;
}
.ig-ref:hover .ig-ref-del{opacity:1}
.ig-ref-del:hover{background:var(--ig-bad)}
.ig-rail-stack:hover .ig-ref:nth-child(1){--ig-rot:-8deg;transform:rotate(var(--ig-rot))}
.ig-rail-stack:hover .ig-ref:nth-child(2){--ig-rot:-4deg;transform:rotate(var(--ig-rot))}
.ig-rail-stack:hover .ig-ref:nth-child(3){--ig-rot:0deg;transform:rotate(var(--ig-rot))}
.ig-rail-stack:hover .ig-ref:nth-child(4){--ig-rot:4deg;transform:rotate(var(--ig-rot))}
.ig-rail-stack:hover .ig-ref:nth-child(5){--ig-rot:7deg;transform:rotate(var(--ig-rot))}
.ig-rail-stack:hover .ig-ref:nth-child(6){--ig-rot:9deg;transform:rotate(var(--ig-rot))}
.ig-rail-stack:hover .ig-ref:nth-child(7){--ig-rot:11deg;transform:rotate(var(--ig-rot))}
.ig-rail-stack:hover .ig-ref:nth-child(8){--ig-rot:12.5deg;transform:rotate(var(--ig-rot))}
.ig-rail-stack:hover .ig-ref+.ig-ref{margin-left:-14px}
.ig-rail-stack:hover .ig-ref{box-shadow:var(--ig-shadow-pop)}
.ig-rail-stack:hover .ig-ref:hover{transform:rotate(var(--ig-rot,0deg)) scale(1.07);z-index:5;border-color:var(--ig-accent)}
/* 「加图」位：与参考图同尺寸的虚线方块，文字必须留在框内 */
.ig-rail-add{
  flex:0 0 52px;width:52px;height:66px;margin-left:6px;padding:0;overflow:hidden;
  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;
  border:1px dashed var(--ig-line2);border-radius:var(--ig-r-sm);
  background:var(--ig-fill);color:var(--ig-fg4);
  font-size:10.5px;line-height:1;white-space:nowrap;
  opacity:0;pointer-events:none;
  transition:opacity .16s ease,border-color .14s ease,color .14s ease,background .14s ease;
}
.ig-rail-stack:hover .ig-rail-add{opacity:1;pointer-events:auto}
.ig-rail-add:hover{border-color:var(--ig-accent);color:var(--ig-accent);background:color-mix(in srgb,var(--ig-accent) 7%,var(--ig-bg))}
.ig-rail-add span{font-size:10.5px;line-height:1;letter-spacing:0}

/* 参考图管理浮层 */
.ig-pop{
  position:absolute;left:0;bottom:calc(100% + 8px);z-index:40;
  width:min(340px,calc(100vw - 80px));
  background:var(--ig-layer);border:1px solid var(--ig-line);border-radius:var(--ig-r-md);
  box-shadow:var(--ig-shadow-pop);padding:10px;
  animation:ig-pop .16s var(--ig-ease) both;
}
.ig-pop-list{display:flex;flex-direction:column;gap:6px;max-height:190px;overflow:auto;margin-bottom:8px}
.ig-pop-add{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:6px}
/* 拖拽悬停：整个浮层变成落点，虚线框 + 淡色底，避免用户以为拖到别处去了 */
.ig-pop-drop{
  border-color:var(--ig-accent);
  box-shadow:var(--ig-shadow-pop),0 0 0 2px color-mix(in srgb,var(--ig-accent) 28%,transparent);
  background:color-mix(in srgb,var(--ig-accent) 5%,var(--ig-layer));
}
.ig-hint-bad{color:var(--ig-bad)}
.ig-pop-row{display:flex;align-items:center;gap:8px;min-width:0}
.ig-pop-thumb{
  width:32px;height:32px;flex:0 0 32px;border-radius:6px;overflow:hidden;
  border:1px solid var(--ig-line-soft);background:var(--ig-fill);
  display:grid;place-items:center;color:var(--ig-fg4);
}
.ig-pop-thumb img{width:100%;height:100%;object-fit:cover}
.ig-pop-path{
  flex:1 1 auto;min-width:0;font-size:11.5px;color:var(--ig-fg2);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-family:var(--ig-mono);
}

/* —— 输入区 —— */
.ig-composer-col{flex:1 1 auto;min-width:0;display:flex;flex-direction:column}
.ig-promptwrap{
  position:relative;border:1px solid var(--ig-line-soft);border-radius:var(--ig-r-md);
  background:var(--ig-bg);transition:border-color .14s ease,background .14s ease;
}
.ig-promptwrap:hover{border-color:var(--ig-line)}
.ig-promptwrap:focus-within{border-color:var(--ig-line2);background:var(--ig-layer)}
.ig-prompt{
  display:block;width:100%;min-height:74px;max-height:200px;
  padding:9px 40px 9px 11px;border:0;outline:none;resize:none;background:transparent;
  font-size:13.5px;line-height:1.65;color:var(--ig-fg);
}
.ig-prompt::placeholder{color:var(--ig-fg4)}
.ig-prompt:focus-visible{outline:none}
.ig-expand{
  position:absolute;right:6px;bottom:6px;width:26px;height:26px;
  display:grid;place-items:center;border-radius:6px;
  border:1px solid var(--ig-line-soft);background:var(--ig-fill);color:var(--ig-fg3);
}
.ig-expand:hover{color:var(--ig-accent);border-color:color-mix(in srgb,var(--ig-accent) 40%,transparent)}
.ig-tools{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:7px 2px 0;min-width:0}
.ig-tools-spacer{flex:1 1 auto}

/* 参数条 */
.ig-bar{
  display:flex;align-items:center;gap:8px;flex-wrap:wrap;
  margin-top:9px;padding-top:9px;border-top:1px solid var(--ig-line-soft);
}
.ig-params{display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex:1 1 auto;min-width:0}
.ig-chip{
  position:relative;display:inline-flex;align-items:center;gap:5px;
  height:30px;padding:0 9px;border-radius:99px;
  border:1px solid var(--ig-line);background:var(--ig-layer);color:var(--ig-fg2);
  font-size:11.5px;white-space:nowrap;
  transition:background .14s ease,border-color .14s ease,color .14s ease;
}
.ig-chip:hover{color:var(--ig-fg);border-color:var(--ig-line2);background:var(--ig-hover)}
.ig-chip:focus-within{border-color:var(--ig-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--ig-accent) 18%,transparent)}
.ig-chip-ico{display:inline-flex;color:var(--ig-fg4)}
.ig-chip-label{overflow:hidden;text-overflow:ellipsis;max-width:140px}
.ig-chip-caret{
  width:0;height:0;flex:0 0 auto;
  border-left:3.5px solid transparent;border-right:3.5px solid transparent;
  border-top:4px solid currentColor;opacity:.5;
}
.ig-chip>select{
  position:absolute;inset:0;width:100%;height:100%;
  opacity:0;cursor:pointer;border:0;appearance:none;padding:0;
}
.ig-chip[data-warn="1"]{color:var(--ig-warn);border-color:color-mix(in srgb,var(--ig-warn) 40%,transparent)}
.ig-submit{
  margin-left:auto;height:36px;padding:0 22px;border-radius:99px;
  display:inline-flex;align-items:center;justify-content:center;gap:7px;
  background:var(--ig-brand);color:var(--ig-on-brand);
  font-size:13px;font-weight:600;white-space:nowrap;
  transition:background .14s ease,opacity .14s ease;
}
.ig-submit:hover:not(:disabled){background:var(--ig-brand-hover)}
.ig-submit:disabled{opacity:.5}
.ig-submit-stop{background:transparent;color:var(--ig-fg2);border:1px solid var(--ig-line);font-weight:500}
.ig-submit-stop:hover:not(:disabled){background:var(--ig-hover);color:var(--ig-fg)}

/* 高级区 */
.ig-adv{
  display:grid;gap:0 12px;margin-top:9px;padding-top:9px;
  border-top:1px solid var(--ig-line-soft);
  grid-template-columns:repeat(auto-fit,minmax(170px,1fr));
}
.ig-foot{
  display:flex;align-items:center;gap:8px;min-width:0;
  margin-top:7px;padding:0 2px;font-size:11.5px;color:var(--ig-fg4);
}

/* 模型私有参数：生成页
 *
 * 布局要点（踩过的坑）：
 *   - 用 auto-fit 而不是 auto-fill：只有 2 个参数时，auto-fill 仍会切出
 *     一排放不下的空轨道，控件被拉得很宽、看着像坏了；auto-fit 会把
 *     空轨道收掉，控件保持自然宽度。
 *   - 上限 max-width：参数少时不让单个控件横跨整行（原来 size 那个输入框
 *     独占一行、宽到离谱）。
 *   - 标签在控件上方，间距压紧，整块高度从 ~100px 降到 ~56px。 */
.ig-modelparams-wrap{
  margin-top:8px;padding:8px 11px 9px;
  border:1px solid var(--ig-line-soft);border-radius:8px;
  background:color-mix(in srgb,var(--ig-fg) 2.5%,transparent);
}
.ig-mp-title{
  display:flex;align-items:center;gap:7px;flex-wrap:wrap;
  font-size:11px;font-weight:600;color:var(--ig-fg3);
  letter-spacing:.02em;margin-bottom:7px;width:100%;text-align:left;
}
.ig-mp-title::after{
  content:'';flex:1 1 auto;height:1px;min-width:12px;
  background:var(--ig-line-soft);
}
.ig-mp-title .ig-hint{font-weight:400}
/* 可点击的标题行（折叠开关） */
.ig-mp-toggle{
  background:none;border:0;padding:0;cursor:pointer;
  font-family:inherit;color:var(--ig-fg3);
  margin-bottom:7px;
}
.ig-mp-toggle:hover{color:var(--ig-fg2)}
.ig-mp-toggle:focus-visible{outline:2px solid var(--ig-accent);outline-offset:3px;border-radius:4px}
/* 折叠三角：CSS 画，不依赖图标集 */
.ig-mp-chev{
  flex:0 0 auto;width:0;height:0;
  border-left:4.5px solid var(--ig-fg4);
  border-top:3.5px solid transparent;
  border-bottom:3.5px solid transparent;
  transition:transform .15s var(--ig-ease);
  transform-origin:1.5px 50%;
}
.ig-mp-chev[data-open="1"]{transform:rotate(90deg)}
.ig-mp-count{
  font-weight:400;font-size:10px;color:var(--ig-fg4);
  background:color-mix(in srgb,var(--ig-fg) 7%,transparent);
  border-radius:4px;padding:1px 5px;
}
.ig-mp-summary{
  font-weight:400;font-size:10.5px;color:var(--ig-fg4);
  font-family:var(--ig-mono);min-width:0;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  max-width:60%;
}
.ig-modelparams{
  display:grid;gap:7px 10px;
  /* auto-fit：参数少时不铺满；max-width 防止单个控件横跨整行 */
  grid-template-columns:repeat(auto-fit,minmax(132px,168px));
  justify-content:start;
}
.ig-mp{display:flex;flex-direction:column;gap:3px;min-width:0}
.ig-mp-name{
  font-size:10.5px;color:var(--ig-fg4);line-height:1.3;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.ig-mp .ig-select,.ig-mp .ig-input{
  height:28px;font-size:12px;padding:3px 7px;
}
.ig-mp-bool{
  flex-direction:row;align-items:center;gap:6px;
  align-self:end;height:28px;
}

/* 参数声明编辑器（模型表单） */
.ig-params-editor{margin:6px 0 4px;overflow-x:auto}
.ig-prow{
  display:grid;gap:4px;
  grid-template-columns:1fr 84px 1.2fr 56px 56px 72px 1fr 1fr 32px;
  align-items:center;margin-bottom:4px;min-width:640px;
}
.ig-prow-head{font-size:10.5px;color:var(--ig-fg4);margin-bottom:2px}
.ig-prow-head span{text-align:left}
.ig-prow .ig-input,.ig-prow .ig-select{
  min-width:0;font-size:11.5px;padding:4px 6px;height:28px;
}
/* 不适用的格子（非数字行的「最小/最大」、非枚举行的「可选值」）：
   保留占位以维持列对齐，但弱化到几乎看不见，免得让人以为能填 */
.ig-prow .ig-input:disabled{
  background:transparent;border-color:transparent;
  color:var(--ig-fg4);opacity:.45;cursor:default;
}
.ig-prow .ig-input:disabled::placeholder{color:var(--ig-fg4)}
/* 「跟随」列给一点提示色：填了它就表示这个参数由通用控件驱动 */
.ig-prow .ig-prow-from:not(:placeholder-shown){
  border-color:color-mix(in srgb,var(--ig-accent) 45%,transparent);
}
.ig-prow .ig-btn-sm{padding:2px 7px;min-width:0}
.ig-check{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--ig-fg2)}
.ig-foot-size{margin-left:auto;font-family:var(--ig-mono);white-space:nowrap}
.ig-composer-status{margin-top:8px}

/* 生成中 */
.ig-spin{
  width:12px;height:12px;border-radius:50%;flex:0 0 auto;
  border:2px solid color-mix(in srgb,currentColor 32%,transparent);
  border-top-color:currentColor;animation:ig-rotate .8s linear infinite;
}

/* ------------------------------------------------------------------
   6. 作品页
   ------------------------------------------------------------------ */
.ig-works{width:100%;max-width:1240px;margin:0 auto;padding:18px 26px 28px;display:flex;flex-direction:column;gap:12px}
.ig-works-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.ig-works-note{font-size:12px;color:var(--ig-fg3);line-height:1.55}
.ig-works-bar .ig-btn:first-of-type{margin-left:auto}
.ig-search{position:relative;width:210px;max-width:100%}
.ig-search .ig-input{height:30px;padding-left:29px;font-size:12px}
.ig-search svg{position:absolute;left:9px;top:50%;transform:translateY(-50%);color:var(--ig-fg4);pointer-events:none}

/* 作品卡片：图 → 标签行 → 时间 → 提示词 → 按钮两行 */
.ig-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(255px,1fr));gap:14px}
.ig-card{
  display:flex;flex-direction:column;
  border:1px solid var(--ig-line-soft);border-radius:var(--ig-r-lg);
  overflow:hidden;background:var(--ig-layer);
  transition:border-color .16s ease,box-shadow .16s ease;
}
.ig-card:hover{border-color:var(--ig-line2);box-shadow:var(--ig-shadow-panel)}
/* 卡片图片：占满卡片宽度，用 cover 让不同画幅也不留白边 */
.ig-card-media{
  position:relative;display:block;width:100%;aspect-ratio:16/10;
  background:var(--ig-fill);cursor:zoom-in;overflow:hidden;flex:0 0 auto;
}
.ig-card-media img{
  display:block;width:100%;height:100%;object-fit:cover;
  transition:transform .24s var(--ig-ease);
}
.ig-card:hover .ig-card-media img{transform:scale(1.025)}
.ig-card-body{padding:9px 11px 11px;display:flex;flex-direction:column;gap:7px;min-width:0;flex:1 1 auto}
.ig-card-tags{display:flex;align-items:center;gap:5px;flex-wrap:wrap}
.ig-card-tags .ig-tag{font-size:10.5px;padding:1px 6px}
.ig-card-time{font-size:11px;color:var(--ig-fg4);font-variant-numeric:tabular-nums}
.ig-card-prompt{
  font-size:12px;line-height:1.62;color:var(--ig-fg2);margin:0;
  display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;
  overflow:hidden;word-break:break-word;
}
.ig-card-prompt[data-empty="1"]{color:var(--ig-fg4)}
/* 同一行卡片的按钮要底对齐：提示词 2 行 / 3 行时不能把按钮顶上去 */
.ig-card-acts{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:auto;padding-top:2px}
.ig-card-acts button,.ig-card-acts a{
  display:inline-flex;align-items:center;justify-content:center;gap:5px;
  height:28px;padding:0 8px;border-radius:7px;
  border:1px solid var(--ig-line);background:var(--ig-layer);
  color:var(--ig-fg2);font-size:11.5px;font-weight:500;font-family:inherit;
  text-decoration:none;cursor:pointer;transition:background .14s ease,border-color .14s ease,color .14s ease;
}
.ig-card-acts button:hover,.ig-card-acts a:hover{background:var(--ig-hover);border-color:var(--ig-line2);color:var(--ig-fg)}
.ig-card-acts .ig-danger{color:var(--ig-bad);border-color:color-mix(in srgb,var(--ig-bad) 28%,transparent)}
.ig-card-acts .ig-danger:hover{background:color-mix(in srgb,var(--ig-bad) 9%,transparent);border-color:color-mix(in srgb,var(--ig-bad) 45%,transparent);color:var(--ig-bad)}

/* ------------------------------------------------------------------
   7. 接入点与模型页
   ------------------------------------------------------------------ */
.ig-cfg{width:100%;max-width:920px;margin:0 auto;padding:20px 26px 34px;display:flex;flex-direction:column;gap:16px}
.ig-sec{
  border:1px solid var(--ig-line-soft);border-radius:var(--ig-r-lg);
  background:var(--ig-layer);padding:16px 18px;
}
.ig-sec-head{display:flex;align-items:center;gap:9px;margin-bottom:4px;flex-wrap:wrap}
.ig-sec-title{font-size:14px;font-weight:600;color:var(--ig-fg);letter-spacing:.01em}
.ig-sec-desc{font-size:12px;color:var(--ig-fg3);margin:2px 0 12px;line-height:1.65}
.ig-sec-head .ig-btn{margin-left:auto}

/* 分组框：一个接入点 = 一张浅色卡片，模型挂在下面 */
.ig-group{
  border:1px solid var(--ig-line-soft);border-radius:var(--ig-r-md);
  background:var(--ig-fill);padding:14px 15px;margin-top:12px;
}
.ig-group:first-of-type{margin-top:0}
.ig-group-head{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap}
.ig-group-main{flex:1 1 240px;min-width:0}
.ig-group-name{display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-size:14px;font-weight:600;color:var(--ig-fg)}
.ig-group-sub{font-size:12px;color:var(--ig-fg3);margin-top:3px;overflow:hidden;text-overflow:ellipsis;word-break:break-all}
.ig-group-acts{display:flex;gap:6px;flex-wrap:wrap;flex:0 0 auto;align-items:center}

/* 模型行：左侧名称 + 适用能力，右侧操作 */
.ig-model{
  display:flex;align-items:center;gap:10px;flex-wrap:wrap;
  padding:11px 12px;margin-top:8px;
  border:1px solid var(--ig-line-soft);border-radius:var(--ig-r-sm);
  background:var(--ig-layer);
  transition:border-color .14s ease;
}
.ig-model:hover{border-color:var(--ig-line2)}
.ig-model-main{flex:1 1 220px;min-width:0}
.ig-model-name{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:13px;font-weight:600;color:var(--ig-fg)}
.ig-model-sub{font-size:11.5px;color:var(--ig-fg3);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ig-model-acts{display:flex;gap:6px;flex-wrap:wrap;flex:0 0 auto}

/* 「在此接入点下添加模型」这类铺满宽度的按钮：参考图是浅灰实底，不是虚线框 */
.ig-addrow{
  display:flex;align-items:center;justify-content:center;gap:6px;
  width:100%;margin-top:10px;height:34px;
  border:1px solid var(--ig-line-soft);border-radius:var(--ig-r-sm);
  background:var(--ig-fill);color:var(--ig-fg2);
  font-size:12.5px;font-family:inherit;font-weight:500;cursor:pointer;
  transition:background .14s ease,border-color .14s ease,color .14s ease;
}
.ig-addrow:hover:not(:disabled){background:var(--ig-hover);border-color:var(--ig-line2);color:var(--ig-fg)}
.ig-addrow:disabled{opacity:.5;cursor:not-allowed}

/* 表单：两列网格，标签在上、输入在下 */
.ig-form{
  margin-top:12px;padding:15px 16px;
  border:1px solid var(--ig-line);border-radius:var(--ig-r-md);
  background:var(--ig-layer);
}
.ig-form-title{font-size:13px;font-weight:600;margin-bottom:12px;color:var(--ig-fg)}
.ig-2col{display:grid;gap:0 14px;grid-template-columns:repeat(auto-fit,minmax(210px,1fr))}
.ig-3col{display:grid;gap:0 14px;grid-template-columns:repeat(auto-fit,minmax(160px,1fr))}
.ig-checkline{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--ig-fg2);cursor:pointer}
.ig-checkline input{margin:0;cursor:pointer}
.ig-discover{
  display:flex;flex-wrap:wrap;gap:6px;max-height:200px;overflow:auto;
  padding:8px;border-radius:8px;background:var(--ig-fill);margin:8px 0;
}
.ig-discover label{
  display:inline-flex;align-items:center;gap:5px;font-size:11.5px;
  padding:3px 8px;border-radius:6px;border:1px solid transparent;cursor:pointer;
  color:var(--ig-fg2);background:var(--ig-layer);
}
.ig-discover label[data-on="1"]{border-color:var(--ig-accent);color:var(--ig-accent);background:color-mix(in srgb,var(--ig-accent) 8%,transparent)}
.ig-discover input{margin:0;cursor:pointer}

/* ------------------------------------------------------------------
   8. 弹层 / 提示
   ------------------------------------------------------------------ */
.ig-modal{
  position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;
  padding:22px;background:var(--ig-mask);
  backdrop-filter:blur(3px);animation:ig-fade .16s ease both;
}
.ig-modal-body{
  width:100%;max-width:1000px;max-height:100%;overflow:auto;
  background:var(--ig-bg);border:1px solid var(--ig-line);
  border-radius:16px;box-shadow:var(--ig-shadow-pop);
  animation:ig-rise .2s var(--ig-ease) both;
}
.ig-modal-head{
  display:flex;align-items:center;gap:10px;
  padding:12px 16px;border-bottom:1px solid var(--ig-line-soft);
  position:sticky;top:0;background:var(--ig-bg);z-index:2;
}
.ig-modal-title{font-size:13px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ig-mono)}
.ig-modal-close{margin-left:auto;display:flex;gap:6px;flex:0 0 auto}
.ig-modal-body-inner{display:flex;gap:20px;flex-wrap:wrap;padding:16px;align-items:flex-start}
.ig-modal-media{flex:1 1 420px;min-width:260px;display:flex;align-items:flex-start;justify-content:center}
.ig-modal-media img{
  display:block;width:100%;height:auto;max-height:68vh;object-fit:contain;
  border-radius:var(--ig-r-md);
  border:1px solid var(--ig-line-soft);background:var(--ig-fill);
}
.ig-modal-side{flex:1 1 290px;min-width:250px;min-height:0}
.ig-kv{display:grid;grid-template-columns:74px 1fr;gap:7px 12px;font-size:12px;margin:0 0 12px}
.ig-kv dt{color:var(--ig-fg3);font-size:11.5px}
.ig-kv dd{margin:0;color:var(--ig-fg);word-break:break-word;line-height:1.6}
.ig-toast{
  position:fixed;left:50%;bottom:24px;transform:translateX(-50%);
  z-index:90;max-width:min(560px,calc(100vw - 40px));
  display:flex;align-items:center;gap:8px;
  padding:9px 14px;border-radius:99px;font-size:12.5px;
  background:var(--dsw-alias-toast-bg,#353638);color:#fff;
  box-shadow:var(--ig-shadow-pop);animation:ig-rise .2s var(--ig-ease) both;
}

/* ------------------------------------------------------------------
   9. 动效
   ------------------------------------------------------------------ */
@keyframes ig-rotate{to{transform:rotate(360deg)}}
@keyframes ig-shimmer{from{background-position:110% 0}to{background-position:-110% 0}}
@keyframes ig-pulse{0%,100%{opacity:.5;transform:scale(.88)}50%{opacity:1;transform:scale(1.08)}}
@keyframes ig-fade{from{opacity:0}to{opacity:1}}
@keyframes ig-rise{from{opacity:0;transform:translateY(6px) scale(.995)}to{opacity:1;transform:none}}
@keyframes ig-pop{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.ig-appear{animation:ig-rise .22s var(--ig-ease) both}

@media (prefers-reduced-motion:reduce){
  .ig *,.ig *::before,.ig *::after{
    animation-duration:.001ms!important;animation-iteration-count:1!important;
    transition-duration:.001ms!important;
  }
}

/* ------------------------------------------------------------------
   10. 窄屏
   ------------------------------------------------------------------ */
@media (max-width:860px){
  .ig-top{padding:0 14px;gap:8px}
  .ig-brand-name{display:none}
  .ig-stage-inner{padding:18px 16px 14px}
  .ig-dock{padding:0 16px 14px}
  .ig-works{padding:18px 16px 22px}
  .ig-cfg{padding:18px 16px 22px}
  .ig-slots[data-count="2"],.ig-slots[data-count="3"]{grid-template-columns:repeat(2,minmax(0,1fr))}
  .ig-nav-btn{padding:0 9px;font-size:12.5px}
  .ig-batch-prompt{font-size:14.5px}
  .ig-modal-body-inner{padding:12px}
  .ig-rail{flex:0 0 46px;width:46px}
}
`;

    let styleDisposer = null;
    function ensureStyles(ctx) {
      if (styleDisposer) return;
      const styles = typeof ctx.get === 'function' ? ctx.get('styles') : undefined;
      if (styles && typeof styles.insert === 'function') {
        styleDisposer = styles.insert(CSS);
        return;
      }
      const el = document.createElement('style');
      el.setAttribute('data-plugin', NS);
      el.textContent = CSS;
      document.head.appendChild(el);
      styleDisposer = () => el.remove();
    }

    /* ================================================================== */
    /* 数据访问                                                            */
    /* ================================================================== */

    async function readJson(res) {
      const body = await res.json().catch(() => null);
      return { res, body };
    }

    async function getJson(path, signal) {
      const { res, body } = await readJson(
        await fetch(ROUTE + path, { headers: { accept: 'application/json' }, signal }),
      );
      if (!res.ok || !body || body.ok === false) throw new Error((body && body.error) || 'HTTP ' + res.status);
      return body;
    }

    async function postJson(path, payload, signal) {
      const { res, body } = await readJson(
        await fetch(ROUTE + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(payload || {}),
          signal,
        }),
      );
      if (!res.ok || !body || body.ok === false) throw new Error((body && body.error) || 'HTTP ' + res.status);
      return body;
    }

    const imageUrl = (name) => ROUTE + '/image?name=' + encodeURIComponent(name);
    const downloadUrl = (name) => imageUrl(name) + '&download=1';

    /* ================================================================== */
    /* 小工具                                                              */
    /* ================================================================== */

    function copyText(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(String(text));
          return true;
        }
      } catch {
        /* 落到下面的降级路径 */
      }
      try {
        const ta = document.createElement('textarea');
        ta.value = String(text);
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        return true;
      } catch {
        return false;
      }
    }

    function humanBytes(n) {
      const v = Number(n) || 0;
      if (v < 1024) return v + ' B';
      if (v < 1024 * 1024) return Math.round(v / 1024) + ' KB';
      return Math.round((v / 1024 / 1024) * 10) / 10 + ' MB';
    }

    function elapsedLabel(ms) {
      const s = Math.round((Number(ms) || 0) / 100) / 10;
      if (s < 60) return s + ' 秒';
      const m = Math.floor(s / 60);
      return m + ' 分 ' + Math.round(s - m * 60) + ' 秒';
    }

    function clockLabel(ms) {
      try {
        return new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      } catch {
        return '';
      }
    }

    /** "16:9" → "16 / 9"，给 CSS aspect-ratio 用。 */
    function ratioAspect(ratio) {
      const parts = String(ratio || '1:1').split(':');
      const a = Number(parts[0]) || 1;
      const b = Number(parts[1]) || 1;
      return a + ' / ' + b;
    }

    function basename(p) {
      const s = String(p || '');
      const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
      return i >= 0 ? s.slice(i + 1) : s;
    }

    /** 参考图缩略图：http(s) 直接给、画廊文件名走 /image、本机路径走 /file。 */
    function refPreview(value, images) {
      const v = String(value || '');
      if (!v) return '';
      if (/^https?:\/\//i.test(v)) return v;
      if (/^data:/i.test(v)) return v;
      const img = (images || []).find((x) => x.file === v || x.name === v);
      if (img) return imageUrl(img.name);
      // 本机绝对路径（含拖拽上传落到 uploads/ 的那种）：交给宿主路由读出来。
      const isLocal = /^[A-Za-z]:[\\/]/.test(v) || v.startsWith('/') || /^\\\\/.test(v);
      if (isLocal) return ROUTE + '/file?path=' + encodeURIComponent(v);
      return '';
    }

    /* ================================================================== */
    /* 图标（统一 16 格、1.4 描边）                                        */
    /* ================================================================== */

    const S = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' };

    function Icon(props) {
      const size = props.size || 16;
      return h('svg', { viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': true, ...S }, props.children);
    }

    const Ico = {
      spark: (p) => h(Icon, p,
        h('path', { d: 'M6.4 1.9c.5 2.5 1.4 3.4 3.9 3.9-2.5.5-3.4 1.4-3.9 3.9-.5-2.5-1.4-3.4-3.9-3.9 2.5-.5 3.4-1.4 3.9-3.9Z' }),
        h('path', { d: 'M11.6 8.6c.3 1.4.8 1.9 2.2 2.2-1.4.3-1.9.8-2.2 2.2-.3-1.4-.8-1.9-2.2-2.2 1.4-.3 1.9-.8 2.2-2.2Z' })),
      brush: (p) => h(Icon, p,
        h('path', { d: 'M2.9 13.1 3.7 10.1 11 2.8a1.7 1.7 0 0 1 2.4 2.4L6 12.4z' }),
        h('path', { d: 'M9.8 4 12 6.2' })),
      grid: (p) => h(Icon, p,
        h('rect', { x: 2.2, y: 3.2, width: 11.6, height: 9.6, rx: 1.8 }),
        h('circle', { cx: 6, cy: 6.7, r: 1.1 }),
        h('path', { d: 'M2.6 11.4 6.4 8.4l2.4 1.9 2.1-1.6 2.5 2.1' })),
      plug: (p) => h(Icon, p,
        h('path', { d: 'M5.6 2.2v3M10.4 2.2v3' }),
        h('rect', { x: 3.6, y: 5.2, width: 8.8, height: 4.4, rx: 2.2 }),
        h('path', { d: 'M8 9.6v4.2' })),
      plus: (p) => h(Icon, p, h('path', { d: 'M8 3.4v9.2M3.4 8h9.2' })),
      close: (p) => h(Icon, p, h('path', { d: 'M4.2 4.2 11.8 11.8M11.8 4.2 4.2 11.8' })),
      search: (p) => h(Icon, p, h('circle', { cx: 7.2, cy: 7.2, r: 4.1 }), h('path', { d: 'M10.3 10.3 13.4 13.4' })),
      refresh: (p) => h(Icon, p,
        h('path', { d: 'M13.2 8a5.2 5.2 0 1 1-1.6-3.8' }),
        h('path', { d: 'M13.4 2.4v3.2h-3.2' })),
      download: (p) => h(Icon, p,
        h('path', { d: 'M8 2.6v7.2M5.2 7.2 8 10l2.8-2.8' }),
        h('path', { d: 'M2.8 12.6h10.4' })),
      trash: (p) => h(Icon, p,
        h('path', { d: 'M2.9 4.4h10.2' }),
        h('path', { d: 'M6.2 4.4V3.1h3.6v1.3' }),
        h('path', { d: 'M4.2 4.4l.6 8.3a1 1 0 0 0 1 .9h4.4a1 1 0 0 0 1-.9l.6-8.3' })),
      check: (p) => h(Icon, p, h('path', { d: 'M3.2 8.4 6.3 11.5 12.8 4.8' })),
      image: (p) => h(Icon, p,
        h('rect', { x: 2.4, y: 3, width: 11.2, height: 10, rx: 1.8 }),
        h('circle', { cx: 5.9, cy: 6.3, r: 1.1 }),
        h('path', { d: 'M2.8 11.2 6.3 8.4l2.2 1.7 2-1.5 2.4 2' })),
      expand: (p) => h(Icon, p,
        h('path', { d: 'M9.6 2.6h3.8v3.8' }),
        h('path', { d: 'M6.4 13.4H2.6V9.6' }),
        h('path', { d: 'M13.4 2.6 9.2 6.8' }),
        h('path', { d: 'M2.6 13.4 6.8 9.2' })),
      /* 参数条图标 */
      model: (p) => h(Icon, p,
        h('rect', { x: 3, y: 3, width: 10, height: 10, rx: 2.5 }),
        h('rect', { x: 6.2, y: 6.2, width: 3.6, height: 3.6, rx: 1 })),
      ratio: (p) => h(Icon, p, h('rect', { x: 2.3, y: 4.2, width: 11.4, height: 7.6, rx: 1.6 })),
      res: (p) => h(Icon, p,
        h('rect', { x: 2.3, y: 2.3, width: 8.2, height: 8.2, rx: 1.6 }),
        h('path', { d: 'M5.6 13.7h5.9a2 2 0 0 0 2-2V5.8' })),
      grade: (p) => h(Icon, p, h('path', { d: 'M8 2.4 13.1 8 8 13.6 2.9 8z' })),
      count: (p) => h(Icon, p,
        h('path', { d: 'M2.8 5.6 8 3l5.2 2.6v4.8L8 13 2.8 10.4z' }),
        h('path', { d: 'M2.8 8 8 10.6 13.2 8' })),
      bg: (p) => h(Icon, p,
        h('rect', { x: 2.4, y: 2.4, width: 11.2, height: 11.2, rx: 2 }),
        h('path', { d: 'M2.6 13.4 13.4 2.6' })),
    };

    /* ================================================================== */
    /* 基元                                                                */
    /* ================================================================== */

    function Field(props) {
      return h('label', { className: 'ig-field' },
        h('span', { className: 'ig-label' }, props.label),
        props.children,
        props.hint ? h('span', { className: 'ig-hint' }, props.hint) : null);
    }

    function Msg(props) {
      if (!props.text) return null;
      return h('div', {
        className: 'ig-msg',
        'data-tone': props.tone || 'info',
        role: props.tone === 'bad' ? 'alert' : 'status',
      }, String(props.text));
    }

    function Seg(options, value, onChange, ariaLabel) {
      return h('div', { className: 'ig-seg', role: 'group', 'aria-label': ariaLabel || '' },
        options.map((o) => h('button', {
          key: String(o.value),
          type: 'button',
          'aria-pressed': o.value === value ? 'true' : 'false',
          onClick: () => onChange(o.value),
        }, o.label)));
    }

    /** 参数胶囊：图标 + 当前值 + 原生 select 透明铺满（可点、可键盘、无自绘下拉）。 */
    function Chip(props) {
      return h('div', {
        className: 'ig-chip',
        title: props.title || '',
        'data-warn': props.warn ? '1' : '0',
      },
        props.icon ? h('span', { className: 'ig-chip-ico', 'aria-hidden': true }, props.icon()) : null,
        h('span', { className: 'ig-chip-label' }, props.value),
        h('span', { className: 'ig-chip-caret', 'aria-hidden': true }),
        props.children);
    }

    /** 参考图缩略图：加载失败（路径写错、远端图取不到）时退成占位图标。
     *  注意 prop 不能叫 ref —— React 会把它当元素引用吞掉。 */
    function RefThumb(props) {
      const [broken, setBroken] = useState(false);
      const src = props.source ? props.source.preview : '';
      useEffect(() => {
        setBroken(false);
      }, [src]);
      if (!src || broken) {
        return h('span', { className: 'ig-ref-ph' }, h(Ico.image, { size: 16 }));
      }
      return h('img', { src, alt: '', loading: 'lazy', onError: () => setBroken(true) });
    }

    /**
     * 把一张作品的 sidecar 元数据翻译成「复用设置」需要的载荷。
     *
     * 面板里有两处要复用某张图的全部设置（作品页按钮、创作页空态缩略图），
     * 以前各写一份、各漏几项。统一放这里，加字段只改一处。
     */
    function replayFromMeta(meta, fileName) {
      const m = meta || {};
      return {
        model: m.model || '',
        ratio: m.ratio || '',
        tier: m.resolution || '',
        quality: m.quality || '',
        // 老记录没有 format 字段：从文件名后缀兜底
        format: m.format || (String(fileName || '').split('.').pop() || '').toLowerCase(),
        background: m.background || '',
        count: m.n || 1,
        negative: m.negative || '',
        seed: m.seed === undefined || m.seed === null ? '' : m.seed,
        params: m.params && typeof m.params === 'object' ? m.params : {},
        // 可复用的参考图路径（新记录才有）
        refPaths: Array.isArray(m.refPaths) ? m.refPaths : [],
      };
    }

    /** 判断一段文本在 clamp 后是否被截断（用于决定要不要显示「展开」）。 */
    function isClamped(el) {
      if (!el) return false;
      return el.scrollHeight - el.clientHeight > 2;
    }

    /* ================================================================== */
    /* 适配层：参数声明编辑 + 运行时控件                                    */
    /* ================================================================== */

    /** 声明类型的中文名。 */
    const PARAM_TYPE_LABEL = {
      enum: '枚举', string: '文本', int: '整数', number: '小数', bool: '开关',
    };

    /** 把声明表转成编辑用的一行行文本（面板上的「参数表」输入区）。 */
    function specToRows(params) {
      const rows = [];
      for (const [name, d] of Object.entries(params || {})) {
        rows.push({
          key: name + '@' + Math.random().toString(36).slice(2, 6),
          name,
          type: d.type || 'string',
          values: Array.isArray(d.values) ? d.values.join(', ') : '',
          def: d.default === undefined || d.default === null ? '' : String(d.default),
          min: d.min === null || d.min === undefined ? '' : String(d.min),
          max: d.max === null || d.max === undefined ? '' : String(d.max),
          label: d.label || '',
          from: d.from || '',
          at: d.at || '',
          lock: Boolean(d.lock),
        });
      }
      return rows;
    }

    /** 编辑行 → 声明对象（空值不写，保持配置干净）。 */
    function rowsToSpec(rows) {
      const out = {};
      for (const row of rows || []) {
        const name = String(row.name || '').trim();
        if (!name) continue;
        const spec = { type: row.type || 'string' };
        if (spec.type === 'enum') {
          spec.values = String(row.values || '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
          if (row.def !== '' && row.def !== undefined) spec.default = row.def;
        } else if (spec.type === 'int' || spec.type === 'number') {
          if (row.min !== '' && Number.isFinite(Number(row.min))) spec.min = Number(row.min);
          if (row.max !== '' && Number.isFinite(Number(row.max))) spec.max = Number(row.max);
          if (row.def !== '') spec.default = Number(row.def);
        } else if (spec.type === 'bool') {
          spec.default = String(row.def).toLowerCase() === 'true';
        } else {
          if (row.def !== '') spec.default = row.def;
        }
        if (row.label) spec.label = row.label;
        if (row.from) spec.from = row.from;
        if (row.at) spec.at = row.at;
        if (row.lock) spec.lock = true;
        out[name] = spec;
      }
      return out;
    }

    /** 一行参数声明的编辑控件。 */
    function ParamRowEditor(props) {
      const { row, index, onChange, onRemove } = props;
      const set = (patch) => onChange(index, { ...row, ...patch });
      const isEnum = row.type === 'enum';
      const isNum = row.type === 'int' || row.type === 'number';
      return h('div', { className: 'ig-prow' },
        h('input', {
          className: 'ig-input ig-prow-name', value: row.name, placeholder: '参数名',
          'aria-label': '参数名',
          onChange: (e) => set({ name: e.target.value.replace(/[^\w.\-]/g, '') }),
        }),
        h('select', {
          className: 'ig-select ig-prow-type', value: row.type,
          'aria-label': '类型',
          onChange: (e) => set({ type: e.target.value }),
        }, ['enum', 'string', 'int', 'number', 'bool'].map((t) =>
          h('option', { key: t, value: t }, PARAM_TYPE_LABEL[t]))),
        isEnum
          ? h('input', {
            className: 'ig-input ig-prow-val', value: row.values, placeholder: '值1, 值2, 值3',
            'aria-label': '可选值',
            onChange: (e) => set({ values: e.target.value }),
          })
          : h('input', {
            className: 'ig-input ig-prow-val', value: '', disabled: true,
            placeholder: '—', 'aria-label': '可选值（仅枚举）', tabIndex: -1,
          }),
        /* 最小 / 最大 这两列必须**恒定存在**。
           以前是 isNum ? input : null，非数字行少两个格子，后面的
           默认/显示名/跟随/删除整体左移两格 —— 于是「跟随」那一列里出现了
           删除按钮，「显示名」那一列里出现了 from 值（截图里的错位就是这个）。
           现在非数字行也占位（禁用的空输入），网格永远 9 列。 */
        h('input', {
          className: 'ig-input ig-prow-min', value: isNum ? row.min : '', disabled: !isNum,
          placeholder: '最小', 'aria-label': '最小值',
          onChange: (e) => set({ min: e.target.value.replace(/[^\d.\-]/g, '') }),
        }),
        h('input', {
          className: 'ig-input ig-prow-max', value: isNum ? row.max : '', disabled: !isNum,
          placeholder: '最大', 'aria-label': '最大值',
          onChange: (e) => set({ max: e.target.value.replace(/[^\d.\-]/g, '') }),
        }),
        h('input', {
          className: 'ig-input ig-prow-def', value: row.def,
          placeholder: row.type === 'bool' ? 'true/false' : '默认值',
          'aria-label': '默认值',
          onChange: (e) => set({ def: e.target.value }),
        }),
        h('input', {
          className: 'ig-input ig-prow-label', value: row.label, placeholder: '显示名（可选）',
          'aria-label': '显示名',
          onChange: (e) => set({ label: e.target.value }),
        }),
        h('input', {
          className: 'ig-input ig-prow-from', value: row.from, placeholder: '跟随（可选）',
          'aria-label': '由哪个通用参数驱动',
          title: '填 prompt/size/quality/format 等通用参数名：这个私有参数会自动跟随它取值',
          onChange: (e) => set({ from: e.target.value.replace(/[^\w.]/g, '') }),
        }),
        h('button', {
          type: 'button', className: 'ig-btn ig-btn-sm ig-btn-danger',
          'aria-label': '删除这个参数',
          onClick: () => onRemove(index),
        }, '×'));
    }

    /** 参数声明表的整体编辑区。 */
    function ParamsEditor(props) {
      const { rows, onChange } = props;
      const addRow = () => onChange([...(rows || []), {
        key: 'n' + Math.random().toString(36).slice(2, 8),
        name: '', type: 'enum', values: '', def: '', min: '', max: '',
        label: '', from: '', at: '', lock: false,
      }]);
      const patchRow = (i, next) => {
        const copy = (rows || []).slice();
        copy[i] = next;
        onChange(copy);
      };
      const removeRow = (i) => onChange((rows || []).filter((_, x) => x !== i));

      return h('div', { className: 'ig-params-editor' },
        h('div', { className: 'ig-prow ig-prow-head', 'aria-hidden': true },
          h('span', {}, '参数名'), h('span', {}, '类型'), h('span', {}, '可选值'),
          h('span', {}, '最小'), h('span', {}, '最大'), h('span', {}, '默认'),
          h('span', {}, '显示名'), h('span', {}, '跟随'), h('span', {}, '')),
        (rows || []).length === 0
          ? h('p', { className: 'ig-hint', style: { margin: '8px 0' } },
            '还没有声明的参数。这个模型会按 OpenAI 默认协议发请求。')
          : (rows || []).map((row, i) =>
            h(ParamRowEditor, { key: row.key || i, row, index: i, onChange: patchRow, onRemove: removeRow })),
        h('button', {
          type: 'button', className: 'ig-btn ig-btn-sm',
          style: { marginTop: 8 },
          onClick: addRow,
        }, '+ 加一个参数'));
    }

    /**
     * 收起状态下的一行取值摘要，例如「版本=flare · 画质=medium · 复杂度=2」。
     * 不显示的话，用户收起后改了什么都看不见。
     */
    function paramSummary(decls, values) {
      const bits = [];
      for (const d of decls || []) {
        const raw = values && values[d.name] !== undefined ? values[d.name]
          : d.default !== undefined && d.default !== null ? d.default : '';
        if (raw === '' || raw === undefined) continue;
        bits.push((d.label || d.name) + '=' + raw);
        if (bits.length >= 4) break;
      }
      if (!bits.length) return '';
      const more = (decls || []).length > bits.length ? ' …' : '';
      return bits.join(' · ') + more;
    }

    /**
     * 生成页：按声明渲染模型私有参数的控件。
     * 只渲染「不跟随通用参数」的那些 —— 跟随的（如 output_format 跟随 format）
     * 由上方通用控件驱动，不再重复显示。
     */
    function ModelParamControls(props) {
      const { decls, values, onChange } = props;
      const editable = (decls || []).filter((d) => !d.lock && !d.bridged);
      if (!editable.length) return null;
      return h('div', { className: 'ig-modelparams' },
        editable.map((d) => {
          const cur = values && values[d.name] !== undefined ? values[d.name]
            : d.default !== undefined && d.default !== null ? d.default : '';
          const label = d.label || d.name;
          if (d.type === 'enum' && d.values.length) {
            return h('label', { key: d.name, className: 'ig-mp' },
              h('span', { className: 'ig-mp-name' }, label),
              h('select', {
                className: 'ig-select', value: String(cur),
                'aria-label': label,
                onChange: (e) => onChange(d.name, e.target.value),
              }, d.values.map((v) => h('option', { key: String(v), value: String(v) }, String(v)))));
          }
          if (d.type === 'int' || d.type === 'number') {
            return h('label', { key: d.name, className: 'ig-mp' },
              h('span', { className: 'ig-mp-name' }, label),
              h('input', {
                className: 'ig-input', type: 'number', value: String(cur),
                min: d.min ?? undefined, max: d.max ?? undefined, step: d.type === 'int' ? 1 : 'any',
                'aria-label': label,
                onChange: (e) => onChange(d.name, e.target.value),
              }));
          }
          if (d.type === 'bool') {
            return h('label', { key: d.name, className: 'ig-mp ig-mp-bool' },
              h('input', {
                type: 'checkbox', checked: String(cur) === 'true',
                'aria-label': label,
                onChange: (e) => onChange(d.name, e.target.checked),
              }),
              h('span', { className: 'ig-mp-name' }, label));
          }
          return h('label', { key: d.name, className: 'ig-mp' },
            h('span', { className: 'ig-mp-name' }, label),
            h('input', {
              className: 'ig-input', value: String(cur),
              'aria-label': label,
              onChange: (e) => onChange(d.name, e.target.value),
            }));
        }));
    }

    /* ================================================================== */
    /* 批次卡                                                              */
    /* ================================================================== */

    const BatchCard = memo(function BatchCard(props) {
      const { batch, onOpenImage, onReuse, onRetry, onCancel, onCopy } = props;
      const [open, setOpen] = useState(false);
      const [clamped, setClamped] = useState(false);
      const promptRef = useRef(null);

      useEffect(() => {
        setClamped(isClamped(promptRef.current));
      }, [batch.prompt]);

      const running = batch.status === 'running';
      const failed = batch.status === 'failed';
      const cancelled = batch.status === 'cancelled';
      const files = batch.files || [];
      const count = Math.max(1, Math.min(4, Number(batch.count) || 1));

      const meta = [];
      if (batch.modelName) meta.push(batch.modelName);
      meta.push(batch.ratio + ' · ' + batch.tier);
      if (batch.quality) meta.push('质量 ' + batch.quality);
      if (batch.background && batch.background !== 'auto') meta.push(batch.background === 'transparent' ? '透明背景' : '不透明');
      if (batch.refs && batch.refs.length) meta.push('参考图 ' + batch.refs.length + ' 张');

      const stateText = running
        ? '生成中'
        : failed
          ? '生成失败'
          : cancelled
            ? '已取消'
            : '完成';

      const totalBytes = files.reduce((a, f) => a + (Number(f.bytes) || 0), 0);

      return h('article', { className: 'ig-batch ig-appear' },
        h('header', { className: 'ig-batch-head' },
          h('div', { className: 'ig-batch-promptwrap' },
            h('p', {
              ref: promptRef,
              className: 'ig-batch-prompt',
              'data-open': open ? '1' : '0',
              title: open ? '' : batch.prompt,
            }, batch.prompt),
            clamped || open
              ? h('button', {
                type: 'button',
                className: 'ig-batch-toggle',
                onClick: () => setOpen((v) => !v),
              }, open ? '收起' : '展开提示词')
              : null),
          h('div', { className: 'ig-batch-meta' },
            meta.map((t, i) => h('span', { key: i, className: 'ig-tag' }, t)),
            running ? null : h('span', { className: 'ig-batch-acts' },
              h('button', { type: 'button', className: 'ig-btn ig-btn-sm ig-btn-ghost', onClick: () => onCopy(batch.prompt) }, '复制提示词'),
              h('button', { type: 'button', className: 'ig-btn ig-btn-sm ig-btn-ghost', onClick: () => onReuse(batch) }, '复用参数'),
              h('button', { type: 'button', className: 'ig-btn ig-btn-sm ig-btn-ghost', onClick: () => onRetry(batch) }, '再生成一次'))),
          h('div', { className: 'ig-batch-summary', 'data-state': batch.status },
            h('span', { className: 'ig-dot' }),
            h('span', null, stateText),
            running ? h('span', { className: 'ig-batch-elapsed' }, batch.elapsed + 's') : null,
            !running && !failed && !cancelled
              ? h('span', { className: 'ig-batch-elapsed' },
                files.length + ' 张 · ' + elapsedLabel(batch.elapsedMs) +
                (totalBytes ? ' · ' + humanBytes(totalBytes) : '') +
                ' · ' + clockLabel(batch.finishedAt || batch.startedAt))
              : null),
          failed && batch.error ? h(Msg, { text: batch.error, tone: 'bad' }) : null,
          batch.notes && batch.notes.length ? h(Msg, { text: batch.notes.join('；'), tone: 'warn' }) : null),

        h('div', { className: 'ig-slots', 'data-count': String(count) },
          running
            ? Array.from({ length: count }, (_, i) =>
              h('div', {
                key: 'r' + i,
                className: 'ig-slot is-running',
                style: { '--ig-ar': ratioAspect(batch.ratio) },
              },
                i === 0 ? h('button', {
                  type: 'button',
                  className: 'ig-slot-cancel',
                  onClick: () => onCancel(batch.id),
                }, '取消') : null))
            : failed || cancelled
              ? h('div', { className: 'ig-slot-fail', style: { '--ig-ar': ratioAspect(batch.ratio) } },
                h('span', { className: 'ig-slot-fail-ico' }, h(cancelled ? Ico.close : Ico.image, { size: 22 })),
                h('span', null, cancelled ? '已取消这一批' : '没有拿到图片'),
                failed ? h('span', { style: { opacity: .72, fontSize: 11.5 } }, '可以点上面的「再生成一次」重试') : null)
              : files.length
                ? files.map((f, i) => h(Slot, { key: f.name || i, file: f, onOpenImage }))
                : h('div', { className: 'ig-slot-fail', style: { '--ig-ar': ratioAspect(batch.ratio) } },
                  h('span', { className: 'ig-slot-fail-ico' }, h(Ico.image, { size: 22 })),
                  h('span', null, '没有拿到图片'))));
    });

    function Slot(props) {
      const { file, onOpenImage } = props;
      const name = file.name || '';
      return h('div', { className: 'ig-slot' },
        file.url
          ? h('img', {
            src: file.url,
            alt: name || '生成结果',
            loading: 'lazy',
            onClick: () => onOpenImage && onOpenImage({ name, file: file.file, bytes: file.bytes, mtime: Date.now(), meta: file.meta }),
          })
          : h('div', { className: 'ig-slot-fail', style: { aspectRatio: '4 / 3' } },
            '已存到 images/ 之外，画廊里看不到这张'),
        name
          ? h('a', {
            className: 'ig-slot-download',
            href: downloadUrl(name),
            download: basename(name),
            onClick: (e) => e.stopPropagation(),
          }, h(Ico.download, { size: 13 }), '下载')
          : null);
    }

    /* ================================================================== */
    /* 参考图管理浮层                                                      */
    /* ================================================================== */

    function RefPopover(props) {
      const { refs, images, onAdd, onRemove, onClose } = props;
      const [value, setValue] = useState('');
      const [busy, setBusy] = useState(false);
      const [dragOver, setDragOver] = useState(false);
      const [err, setErr] = useState('');
      const boxRef = useRef(null);
      const fileRef = useRef(null);

      useEffect(() => {
        const onDoc = (e) => {
          if (boxRef.current && !boxRef.current.contains(e.target)) onClose();
        };
        const onKey = (e) => {
          if (e.key === 'Escape') onClose();
        };
        document.addEventListener('mousedown', onDoc);
        document.addEventListener('keydown', onKey);
        return () => {
          document.removeEventListener('mousedown', onDoc);
          document.removeEventListener('keydown', onKey);
        };
      }, [onClose]);

      const submit = () => {
        const v = String(value || '').trim();
        if (!v) return;
        onAdd(v);
        setValue('');
      };

      /* 拖进来 / 选文件 / 粘贴：浏览器拿不到本机路径，只能把字节交给宿主落盘，
         再拿回真实路径 —— 这样面板和手填路径就是同一条路。 */
      const uploadFiles = useCallback(async (fileList) => {
        const files = Array.from(fileList || []).filter((f) => String(f.type || '').startsWith('image/'));
        if (!files.length) {
          setErr('只支持图片文件（png / jpg / webp / gif）。');
          return;
        }
        setErr('');
        setBusy(true);
        try {
          for (const f of files) {
            const data = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result || ''));
              reader.onerror = () => reject(new Error('读不到「' + f.name + '」'));
              reader.readAsDataURL(f);
            });
            const out = await postJson('/ref.upload.json', { name: f.name, data });
            if (out && out.ok && out.file) onAdd(out.file);
          }
        } catch (e) {
          setErr(String((e && e.message) || e));
        } finally {
          setBusy(false);
        }
      }, [onAdd]);

      return h('div', {
        className: 'ig-pop' + (dragOver ? ' ig-pop-drop' : ''),
        ref: boxRef,
        role: 'dialog',
        'aria-label': '参考图',
        onDragOver: (e) => {
          e.preventDefault();
          if (!dragOver) setDragOver(true);
        },
        onDragLeave: (e) => {
          if (e.currentTarget === e.target) setDragOver(false);
        },
        onDrop: (e) => {
          e.preventDefault();
          setDragOver(false);
          uploadFiles(e.dataTransfer?.files);
        },
        onPaste: (e) => {
          const items = Array.from(e.clipboardData?.files || []);
          if (items.length) {
            e.preventDefault();
            uploadFiles(items);
          }
        },
      },
        refs.length
          ? h('div', { className: 'ig-pop-list' },
            refs.map((ref) =>
              h('div', { key: ref.id, className: 'ig-pop-row' },
                h('span', { className: 'ig-pop-thumb' },
                  ref.preview
                    ? h('img', { src: ref.preview, alt: '' })
                    : h(Ico.image, { size: 15 })),
                h('span', { className: 'ig-pop-path', title: ref.value }, ref.value),
                h('button', {
                  type: 'button',
                  className: 'ig-btn ig-btn-sm ig-btn-ghost ig-iconbtn',
                  title: '移除这张参考图',
                  'aria-label': '移除参考图 ' + ref.value,
                  onClick: () => onRemove(ref.id),
                }, h(Ico.close, { size: 13 })))))
          : h('p', { className: 'ig-hint', style: { margin: '0 0 8px' } },
            '还没有参考图。加一张就自动改用改图端点。'),

        h('div', { className: 'ig-pop-add' },
          h('input', {
            className: 'ig-input',
            value,
            placeholder: '本机图片路径 或 http(s) 地址',
            'aria-label': '参考图路径',
            onChange: (e) => setValue(e.target.value),
            onKeyDown: (e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              }
            },
          }),
          h('button', { type: 'button', className: 'ig-btn ig-btn-sm', onClick: submit, disabled: !value.trim() }, '加入')),

        h('div', { className: 'ig-pop-add' },
          h('input', {
            ref: fileRef,
            type: 'file',
            accept: 'image/*',
            multiple: true,
            style: { display: 'none' },
            onChange: (e) => {
              uploadFiles(e.target.files);
              e.target.value = '';
            },
          }),
          h('button', {
            type: 'button',
            className: 'ig-btn ig-btn-sm',
            disabled: busy,
            onClick: () => fileRef.current && fileRef.current.click(),
          }, busy ? '上传中…' : '选择文件…'),
          h('span', { className: 'ig-hint', style: { margin: '0 0 0 8px' } },
            '也可以把图片直接拖进来，或在这个浮层里 Ctrl+V 粘贴。')),

        err ? h('p', { className: 'ig-hint ig-hint-bad', style: { margin: '8px 0 0' } }, err) : null,

        h('p', { className: 'ig-hint', style: { margin: '8px 0 0' } },
          '还可以在「作品」里点某张图的「参考」，直接挂过来。' +
          '对话里的图在面板里用不了（面板没有会话上下文），但 AI 在对话里调用时会自动用 @last。'));
    }

    /* ================================================================== */
    /* 创作页                                                              */
    /* ================================================================== */

    const RATIO_OPTIONS = [
      { value: '1:1', label: '1:1 方形' },
      { value: '3:2', label: '3:2 横版' },
      { value: '4:3', label: '4:3 横版' },
      { value: '16:9', label: '16:9 横版' },
      { value: '2:3', label: '2:3 竖版' },
      { value: '3:4', label: '3:4 竖版' },
      { value: '9:16', label: '9:16 竖版' },
    ];
    const TIER_OPTIONS = ['1K', '2K', '4K'];
    const QUALITY_OPTIONS = [
      { value: '', label: '自动' },
      { value: 'low', label: '快速' },
      { value: 'medium', label: '标准' },
      { value: 'high', label: '精细' },
    ];
    const BACKGROUND_OPTIONS = [
      { value: 'auto', label: '自动' },
      { value: 'opaque', label: '不透明' },
      { value: 'transparent', label: '透明' },
    ];
    const FORMAT_OPTIONS = [
      { value: 'png', label: 'PNG 静图' },
      { value: 'jpeg', label: 'JPEG 静图' },
      { value: 'webp', label: 'WebP 静图' },
      { value: 'gif', label: 'GIF 动图' },
      { value: 'svg', label: 'SVG 矢量' },
    ];

    function CreateView(props) {
      const { snapshot, images, reload, notify, refQueue, consumeRefQueue, pendingPrompt, consumePendingPrompt, openImage, onOpenConfig } = props;

      const [prompt, setPrompt] = useState('');
      const [model, setModel] = useState('');
      const [ratio, setRatio] = useState('1:1');
      const [tier, setTier] = useState('1K');
      const [quality, setQuality] = useState('');
      const [background, setBackground] = useState('auto');
      const [format, setFormat] = useState('png');
      const [count, setCount] = useState(1);
      const [refs, setRefs] = useState([]);
      const [popOpen, setPopOpen] = useState(false);
      const [advanced, setAdvanced] = useState(false);
      const [negative, setNegative] = useState('');
      const [seed, setSeed] = useState('');
      const [saveTo, setSaveTo] = useState('');
      const [batches, setBatches] = useState([]);
      const [error, setError] = useState('');
      // 模型私有参数（按当前模型的 params 声明渲染控件）
      const [modelParams, setModelParams] = useState({});
      // 参数区的展开状态：用户手动点过之后就以他的选择为准（userToggledParams），
      // 否则按参数个数自动决定 —— 1~3 个展开（占不了多少地方），
      // 4 个以上默认收起，别把输入区顶得太高。
      const [paramsOpen, setParamsOpen] = useState(true);
      const [userToggledParams, setUserToggledParams] = useState(false);

      const promptRef = useRef(null);
      const stageRef = useRef(null);
      const ctrls = useRef(new Map());

      /* 模型下拉跟着「有没有参考图」切换，两种模式各自只列能用的模型：
         - 没有参考图 → 只列能文生图的（caps = both / generate）
         - 有参考图   → 只列能改图的（caps = both / edit）
         这样下拉里永远不会出现「选了也必然失败」的模型。两边都空的极端情况
         （只配了 generate 模型却加了参考图）退回列全部，让用户看得到模型而不是空下拉。 */
      const allModels = (snapshot?.config?.models || []).filter((m) => !m.providerMissing);
      const editMode = refs.length > 0;
      const fits = (m) => (editMode ? m.caps === 'edit' || m.caps === 'both' : m.caps === 'generate' || m.caps === 'both');
      const fitsModels = allModels.filter(fits);
      const models = fitsModels.length ? fitsModels : allModels;

      // 当前选中的模型必须属于这一栏；不属于就自动落到本栏的默认 / 第一个。
      const fallbackId = (() => {
        const def = models.find((m) => m.id === snapshot?.config?.defaultModel);
        return (def || models[0])?.id || '';
      })();
      const effective = (model && models.some((m) => m.id === model) ? model : '') || fallbackId;
      const activeModel = allModels.find((m) => m.id === effective);
      const computedSizes = snapshot?.computedSizes || {};

      /* 从「作品」页挂过来的参考图 */
      useEffect(() => {
        if (!refQueue || !refQueue.length) return;
        setRefs((prev) => {
          const next = prev.slice();
          for (const path of refQueue) {
            if (path && !next.some((r) => r.value === path) && next.length < MAX_REFS) {
              next.push({ id: 'r' + Math.random().toString(36).slice(2, 8), value: path, preview: refPreview(path, images) });
            }
          }
          return next;
        });
        consumeRefQueue && consumeRefQueue();
      }, [refQueue, consumeRefQueue, images]);

      /* 从「作品」页带过来的提示词与参数（「复用设置」）
       *
       * 这里要把上一次的**全部**创作条件还原回去，用户才不用重新调一遍：
       *   模型 / 画幅 / 分辨率档 / 质量 / 格式 / 背景 / 张数 / 反向词 /
       *   种子 / 参考图 / 模型私有参数
       * 只回填提示词是不够的 —— 改了画幅或换了版本参数，出来的图就不是原来那张了。 */
      useEffect(() => {
        if (!pendingPrompt) return;
        const carry = pendingPrompt;
        const text = typeof carry === 'string' ? carry : String(carry.prompt || '');
        if (text) setPrompt(text);
        // 参数回填：模型按名字/ID 对上就用，对不上保持当前选择
        if (carry && typeof carry === 'object') {
          const wantModel = String(carry.model || '').trim().toLowerCase();
          if (wantModel) {
            const hit = models.find((m) =>
              String(m.name || '').toLowerCase() === wantModel
              || String(m.model || '').toLowerCase() === wantModel
              || String(m.id || '').toLowerCase() === wantModel);
            if (hit) setModel(hit.id);
          }
          if (carry.ratio) setRatio(String(carry.ratio));
          if (carry.tier) setTier(String(carry.tier));
          if (carry.quality !== undefined) setQuality(String(carry.quality || ''));
          if (carry.format) setFormat(String(carry.format));
          // 原来漏掉的几项
          if (carry.background) setBackground(String(carry.background));
          if (carry.count) setCount(Math.min(4, Math.max(1, Number(carry.count) || 1)));
          if (carry.negative !== undefined) setNegative(String(carry.negative || ''));
          if (carry.seed !== undefined && carry.seed !== null && carry.seed !== '') setSeed(String(carry.seed));
          // 模型私有参数：整包放回去（声明变了也不会崩，渲染时按当前声明过滤）
          if (carry.params && typeof carry.params === 'object' && Object.keys(carry.params).length) {
            setModelParams((prev) => ({ ...prev, ...carry.params }));
            setUserToggledParams(true);
            setParamsOpen(true);
          }
          // 参考图：只需可复用的路径（refPaths）。老记录没有这个字段就跳过，
          // 不要拿 refs 里的文件名/哈希硬填 —— 那会指向不存在的文件。
          if (Array.isArray(carry.refPaths) && carry.refPaths.length) {
            const usable = carry.refPaths.filter((p) => typeof p === 'string' && p.trim());
            if (usable.length) {
              setRefs(usable.slice(0, MAX_REFS).map((p) => ({
                id: 'r' + Math.random().toString(36).slice(2, 8),
                value: p,
                preview: refPreview(p, images),
              })));
            }
            if (usable.length < carry.refPaths.length) {
              notify('有 ' + (carry.refPaths.length - usable.length) + ' 张参考图是临时数据，无法还原', 'warn');
            }
          }
        }
        consumePendingPrompt && consumePendingPrompt();
        requestAnimationFrame(() => {
          const el = promptRef.current;
          if (el) {
            el.focus();
            el.setSelectionRange(el.value.length, el.value.length);
          }
        });
      }, [pendingPrompt, consumePendingPrompt, models, images, notify]);

      /* 有批次在跑时，每秒刷新一次计时 */
      const hasRunning = batches.some((b) => b.status === 'running');
      useEffect(() => {
        if (!hasRunning) return undefined;
        const t = setInterval(() => {
          setBatches((prev) =>
            prev.map((b) => (b.status === 'running' ? { ...b, elapsed: Math.round((Date.now() - b.startedAt) / 1000) } : b)));
        }, 500);
        return () => clearInterval(t);
      }, [hasRunning]);

      /* 输入框自适应高度 */
      useEffect(() => {
        const el = promptRef.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = Math.min(200, Math.max(74, el.scrollHeight)) + 'px';
      }, [prompt]);

      useEffect(() => () => {
        for (const c of ctrls.current.values()) {
          try {
            c.abort();
          } catch {
            /* ignore */
          }
        }
        ctrls.current.clear();
      }, []);

      const addRef = useCallback((value) => {
        const v = String(value || '').trim();
        if (!v) return;
        setRefs((prev) => {
          if (prev.length >= MAX_REFS) return prev;
          if (prev.some((r) => r.value === v)) return prev;
          return prev.concat({ id: 'r' + Math.random().toString(36).slice(2, 8), value: v, preview: refPreview(v, images) });
        });
      }, [images]);

      const removeRef = useCallback((id) => {
        setRefs((prev) => prev.filter((r) => r.id !== id));
      }, []);

      const targetSize = useMemo(() => {
        const own = activeModel?.sizes || {};
        return own?.[tier]?.[ratio] || computedSizes?.[tier]?.[ratio] || '';
      }, [activeModel, tier, ratio, computedSizes]);

      /** 把当前草稿参数落成一次生成请求。 */
      const run = useCallback(async (draft) => {
        const text = String(draft.prompt || '').trim();
        if (!text) {
          setError('先写提示词。');
          return;
        }
        const id = 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
        const ctl = new AbortController();
        ctrls.current.set(id, ctl);
        const startedAt = Date.now();

        const batch = {
          id,
          prompt: text,
          model: draft.model,
          modelName: draft.modelName,
          ratio: draft.ratio,
          tier: draft.tier,
          count: draft.count,
          quality: draft.quality,
          background: draft.background,
          format: draft.format,
          refs: draft.refs,
          status: 'running',
          files: [],
          notes: [],
          error: '',
          startedAt,
          finishedAt: 0,
          elapsed: 0,
          elapsedMs: 0,
        };

        setError('');
        setBatches((prev) => [batch].concat(prev).slice(0, 30));
        requestAnimationFrame(() => {
          if (stageRef.current) stageRef.current.scrollTop = 0;
        });

        const body = {
          prompt: text,
          model: draft.model,
          ratio: draft.ratio,
          resolution: draft.tier,
          n: draft.count,
          images: draft.refs.map((r) => r.value),
        };
        if (draft.quality) body.quality = draft.quality;
        if (draft.background && draft.background !== 'auto') body.background = draft.background;
        if (draft.format) body.format = draft.format;
        if (draft.saveTo) body.saveTo = draft.saveTo;
        if (draft.negative) body.negative = draft.negative;
        if (draft.seed !== '' && draft.seed !== undefined && Number.isFinite(Number(draft.seed))) {
          body.seed = Math.round(Number(draft.seed));
        }
        // 模型私有参数：只发用户真正设过的（空的不发，让声明里的默认值生效）
        const priv = {};
        for (const [k, v] of Object.entries(draft.modelParams || {})) {
          if (v !== '' && v !== undefined && v !== null) priv[k] = v;
        }
        if (Object.keys(priv).length) body.params = priv;

        try {
          const out = await postJson('/generate.json', body, ctl.signal);
          const files = (out.result?.files || []).filter((f) => f.url || f.file);
          const elapsedMs = Number(out.result?.elapsedMs) || Date.now() - startedAt;
          setBatches((prev) => prev.map((b) => (b.id === id
            ? {
              ...b,
              status: 'done',
              files,
              notes: (out.notes || []).filter(Boolean),
              finishedAt: Date.now(),
              elapsedMs,
              elapsed: Math.round(elapsedMs / 1000),
            }
            : b)));
          notify('已生成 ' + files.length + ' 张 · ' + elapsedLabel(elapsedMs), 'ok');
          reload && reload();
        } catch (e) {
          if (e && (e.name === 'AbortError' || ctl.signal.aborted)) {
            setBatches((prev) => prev.map((b) => (b.id === id ? { ...b, status: 'cancelled', finishedAt: Date.now() } : b)));
          } else {
            setBatches((prev) => prev.map((b) => (b.id === id
              ? { ...b, status: 'failed', error: String((e && e.message) || e), finishedAt: Date.now() }
              : b)));
          }
        } finally {
          ctrls.current.delete(id);
        }
      }, [notify, reload]);

      const submit = useCallback(() => {
        run({
          prompt,
          model: effective,
          modelName: activeModel?.name || '',
          ratio,
          tier,
          count,
          quality,
          background,
          format,
          refs,
          negative: advanced ? negative.trim() : '',
          seed: advanced ? seed : '',
          saveTo: advanced ? saveTo.trim() : '',
          modelParams,
        });
      }, [run, prompt, effective, activeModel, ratio, tier, count, quality, background, format, refs, advanced, negative, seed, saveTo, modelParams]);

      const cancel = useCallback((id) => {
        const c = ctrls.current.get(id);
        if (c) {
          try {
            c.abort();
          } catch {
            /* ignore */
          }
        }
      }, []);

      const stopAll = useCallback(() => {
        for (const c of ctrls.current.values()) {
          try {
            c.abort();
          } catch {
            /* ignore */
          }
        }
      }, []);

      const reuse = useCallback((b) => {
        setPrompt(b.prompt);
        if (b.model) setModel(b.model);
        setRatio(b.ratio);
        setTier(b.tier);
        setQuality(b.quality || '');
        setBackground(b.background || 'auto');
        setCount(b.count || 1);
        if (b.refs) setRefs(b.refs);
        requestAnimationFrame(() => promptRef.current && promptRef.current.focus());
        notify('参数已填回创作台', 'ok');
      }, [notify]);

      const retry = useCallback((b) => {
        run({
          prompt: b.prompt,
          model: b.model,
          modelName: b.modelName,
          ratio: b.ratio,
          tier: b.tier,
          count: b.count,
          quality: b.quality,
          background: b.background,
          refs: b.refs || [],
        });
      }, [run]);

      const copy = useCallback((text) => {
        if (copyText(text)) notify('提示词已复制', 'ok');
        else notify('复制失败', 'bad');
      }, [notify]);

      const busy = batches.some((b) => b.status === 'running');

      if (!models.length) {
        return h('div', { className: 'ig-view' },
          h('div', { className: 'ig-stage ig-scroll' },
            h('div', { className: 'ig-stage-inner' },
              h('div', { className: 'ig-empty' },
                h('div', { className: 'ig-empty-mark' }, h(Ico.plug, { size: 22 })),
                h('div', { className: 'ig-empty-title' }, '还没有可用的生图模型'),
                h('p', { className: 'ig-empty-text' },
                  '先去「接入点与模型」填一个 Base URL 与 API Key，再加一个模型 ID。配好之后回到这里就能出图。'),
                h('div', { className: 'ig-empty-actions' },
                  h('button', { type: 'button', className: 'ig-btn ig-btn-primary', onClick: onOpenConfig }, '去配置'))))));
      }

      /* 空态：只有「图标 + 标题 + 一行说明」，居中显示。
         之前塞了「写点什么 / 放参考图」两个按钮和最近作品缩略图墙 —— 那些
         入口输入框旁边本来就有，堆在这里反而让创作页显得杂乱。留白干净就行。 */
      const emptyStage = h('div', { className: 'ig-empty' },
        h('div', { className: 'ig-empty-inner' },
          h('div', { className: 'ig-empty-mark' }, h(Ico.spark, { size: 24 })),
          h('strong', { className: 'ig-empty-title' }, '开始创作'),
          h('span', { className: 'ig-empty-text' }, '说一句描述，或者放几张参考图，结果会显示在这里')));

      const sizeHint = targetSize ? targetSize : '尺寸自适应';
      const busyLabel = busy ? '生成中…' : refs.length ? '开始编辑' : '生成';

      return h('div', { className: 'ig-view' },
        h('div', { className: 'ig-stage ig-scroll', ref: stageRef },
          h('div', { className: 'ig-stage-inner' },
            h('div', { className: 'ig-feed' },
              batches.length
                ? batches.map((b) => h(BatchCard, {
                  key: b.id,
                  batch: b,
                  onOpenImage: openImage,
                  onReuse: reuse,
                  onRetry: retry,
                  onCancel: cancel,
                  onCopy: copy,
                }))
                : emptyStage))),

        h('div', { className: 'ig-dock' },
          h('div', { className: 'ig-composer' },
            error ? h('div', { className: 'ig-composer-status' }, h(Msg, { text: error, tone: 'bad' })) : null,

            h('div', { className: 'ig-composer-main' },
              h('div', { className: 'ig-rail' },
                refs.length
                  ? h('div', { className: 'ig-rail-stack' },
                    refs.map((ref, i) =>
                      h('button', {
                        key: ref.id,
                        type: 'button',
                        className: 'ig-ref',
                        title: ref.value,
                        'aria-label': '参考图 ' + (i + 1) + '：' + ref.value,
                        onClick: () => setPopOpen(true),
                      },
                        h(RefThumb, { source: ref }),
                        h('span', { className: 'ig-ref-idx' }, '图 ' + (i + 1)),
                        h('span', {
                          className: 'ig-ref-del',
                          role: 'button',
                          tabIndex: -1,
                          'aria-label': '移除参考图 ' + (i + 1),
                          onClick: (e) => {
                            e.stopPropagation();
                            removeRef(ref.id);
                          },
                        }, h(Ico.close, { size: 10 })))),
                    refs.length < MAX_REFS
                      ? h('button', {
                        type: 'button',
                        className: 'ig-rail-add',
                        title: '再加一张参考图',
                        onClick: () => setPopOpen(true),
                      }, h(Ico.plus, { size: 15 }), h('span', null, '加图'))
                      : null)
                  : h('button', {
                    type: 'button',
                    className: 'ig-rail-empty',
                    title: '添加参考图（本机路径或图片地址）',
                    onClick: () => setPopOpen(true),
                  }, h(Ico.plus, { size: 17 }), h('span', null, '参考图')),
                popOpen
                  ? h(RefPopover, {
                    refs,
                    images,
                    onAdd: addRef,
                    onRemove: removeRef,
                    onClose: () => setPopOpen(false),
                  })
                  : null),

              h('div', { className: 'ig-composer-col' },
                h('div', { className: 'ig-promptwrap' },
                  h('textarea', {
                    ref: promptRef,
                    className: 'ig-prompt ig-scroll',
                    rows: 2,
                    value: prompt,
                    placeholder: refs.length
                      ? '描述修改要求，例如：保留图一的人物与构图，把背景换成清晨的海面…'
                      : '描述你想生成的画面，例如：清晨海边的现代玻璃屋，柔和自然光，电影感…',
                    'aria-label': '提示词',
                    onChange: (e) => setPrompt(e.target.value),
                    onKeyDown: (e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                        e.preventDefault();
                        if (!busy) submit();
                      }
                    },
                  }),
                  guardExpander(promptRef)),

                h('div', { className: 'ig-tools' },
                  h('button', {
                    type: 'button',
                    className: 'ig-linkbtn',
                    onClick: () => {
                      const p = images.map((x) => x.meta?.prompt).filter(Boolean).find((t) => t !== prompt);
                      if (!p) {
                        notify('作品里还没有可复用的提示词', 'warn');
                        return;
                      }
                      setPrompt(p);
                      notify('已填入最近一条历史提示词', 'ok');
                    },
                  }, '历史提示词'),
                  h('button', {
                    type: 'button',
                    className: 'ig-linkbtn',
                    onClick: () => {
                      if (!prompt.trim()) return;
                      copy(prompt);
                      notify('提示词已复制', 'ok');
                    },
                  }, '复制提示词'),
                  h('button', {
                    type: 'button',
                    className: 'ig-linkbtn',
                    onClick: () => setAdvanced((v) => !v),
                  }, advanced ? '收起高级' : '高级选项'),
                  h('span', { className: 'ig-tools-spacer' }),
                  h('span', { className: 'ig-foot-size' }, sizeHint)))),

            /* 当前模型的私有参数：声明了才出现，没声明就整块不渲染。
               跟随通用参数的（如 output_format from format）不在这显示，
               它们由上面的「格式」胶囊驱动。 */
            (() => {
              const decls = Object.entries(activeModel?.params || {}).map(([name, d]) => ({
                name,
                ...d,
                label: d.label || name,
                // 必须显式给出 bridged：ModelParamControls 内部按它过滤，
                // 光在外层用 d.from 过滤是不够的（两处判据不一致会让
                // size / output_format 这类跟随参数漏进界面，显示成空输入框）。
                bridged: Boolean(d.from),
              }));
              const shown = decls.filter((d) => !d.lock && !d.bridged);
              if (!shown.length) return null;
              // 默认收起：参数不是每次都要改，展开会一直占着输入区的高度。
              // 用户点开后按他的选择来（userToggledParams）。
              const open = userToggledParams ? paramsOpen : false;
              return h('div', { className: 'ig-modelparams-wrap' },
                h('button', {
                  type: 'button',
                  className: 'ig-mp-title ig-mp-toggle',
                  'aria-expanded': open ? 'true' : 'false',
                  title: open ? '收起这些参数' : '展开这些参数',
                  onClick: () => {
                    setParamsOpen(!open);
                    setUserToggledParams(true);
                  },
                },
                  h('span', { className: 'ig-mp-chev', 'aria-hidden': true, 'data-open': open ? '1' : '0' }),
                  h('span', {}, (activeModel?.name || '这个模型') + ' 的参数'),
                  h('span', { className: 'ig-mp-count' }, shown.length + ' 项'),
                  // 收起时把当前取值摘要露出来，不然改了参数看不见
                  open ? null : h('span', { className: 'ig-mp-summary' }, paramSummary(shown, modelParams))),
                open
                  ? h(ModelParamControls, {
                    decls,
                    values: modelParams,
                    onChange: (name, value) => setModelParams((prev) => ({ ...prev, [name]: value })),
                  })
                  : null);
            })(),

            advanced
              ? h('div', { className: 'ig-adv' },
                h(Field, { label: '反向提示词', hint: '只有模型配了请求体模板并写了 {{negative}} 才会发出去。' },
                  h('input', {
                    className: 'ig-input',
                    value: negative,
                    placeholder: '模糊、低清、多余手指',
                    onChange: (e) => setNegative(e.target.value),
                  })),
                h(Field, { label: '种子', hint: '固定它可以复现同一张图；仅模板 {{seed}} 消费。' },
                  h('input', {
                    className: 'ig-input',
                    value: seed,
                    placeholder: '留空即随机',
                    onChange: (e) => setSeed(e.target.value.replace(/[^\d-]/g, '')),
                  })),
                h(Field, { label: '额外导出目录（可选）', hint: '图片一定会存进作品画廊；填了这里会再复制一份过去。' },
                  h('input', {
                    className: 'ig-input',
                    value: saveTo,
                    placeholder: 'D:\\图片\\生成',
                    onChange: (e) => setSaveTo(e.target.value),
                  })))
              : null,

            h('div', { className: 'ig-bar' },
              h('div', { className: 'ig-params' },
                h(Chip, { icon: Ico.model, value: activeModel ? activeModel.name : '—', title: '模型' },
                  h('select', {
                    value: effective,
                    'aria-label': '模型',
                    onChange: (e) => setModel(e.target.value),
                  }, models.map((m) => h('option', { key: m.id, value: m.id },
                    m.name + ' · ' + m.model + (editMode ? '（可改图）' : '（可生图）'))))),

                h(Chip, { icon: Ico.ratio, value: ratio, title: '画幅比例' },
                  h('select', {
                    value: ratio,
                    'aria-label': '画幅',
                    onChange: (e) => setRatio(e.target.value),
                  }, RATIO_OPTIONS.map((o) => h('option', { key: o.value, value: o.value }, o.label)))),

                h(Chip, { icon: Ico.res, value: tier, title: '分辨率档（与画幅一起查出实际像素）' },
                  h('select', {
                    value: tier,
                    'aria-label': '分辨率',
                    onChange: (e) => setTier(e.target.value),
                  }, TIER_OPTIONS.map((t) => h('option', { key: t, value: t }, t)))),

                h(Chip, {
                  icon: Ico.grade,
                  value: (QUALITY_OPTIONS.find((o) => o.value === quality) || QUALITY_OPTIONS[0]).label,
                  title: '质量档',
                },
                  h('select', {
                    value: quality,
                    'aria-label': '质量',
                    onChange: (e) => setQuality(e.target.value),
                  }, QUALITY_OPTIONS.map((o) => h('option', { key: o.value || 'auto', value: o.value }, o.label)))),

                h(Chip, { icon: Ico.count, value: count + ' 张', title: '生成张数（每张单独计费）' },
                  h('select', {
                    value: String(count),
                    'aria-label': '张数',
                    onChange: (e) => setCount(Number(e.target.value)),
                  }, [1, 2, 3, 4].map((n) => h('option', { key: n, value: String(n) }, n + ' 张')))),

                h(Chip, {
                  icon: Ico.bg,
                  value: (BACKGROUND_OPTIONS.find((o) => o.value === background) || BACKGROUND_OPTIONS[0]).label,
                  title: '背景；只有非自动才发进请求',
                },
                  h('select', {
                    value: background,
                    'aria-label': '背景',
                    onChange: (e) => setBackground(e.target.value),
                  }, BACKGROUND_OPTIONS.map((o) => h('option', { key: o.value, value: o.value }, o.label)))),

                h(Chip, {
                  icon: Ico.image,
                  value: (FORMAT_OPTIONS.find((o) => o.value === format) || FORMAT_OPTIONS[0]).label,
                  title: '产出格式；默认 PNG 静图，要动图得显式选 GIF',
                },
                  h('select', {
                    value: format,
                    'aria-label': '格式',
                    onChange: (e) => setFormat(e.target.value),
                  }, FORMAT_OPTIONS.map((o) => h('option', { key: o.value, value: o.value }, o.label))))),

              busy
                ? h('button', { type: 'button', className: 'ig-submit ig-submit-stop', onClick: stopAll },
                  h('span', { className: 'ig-spin' }), '取消生成')
                : h('button', {
                  type: 'button',
                  className: 'ig-submit',
                  disabled: !prompt.trim(),
                  onClick: submit,
                }, h(Ico.spark, { size: 14 }), busyLabel))),

            h('div', { className: 'ig-foot' },
              h('span', null,
                activeModel?.summary
                  ? activeModel.summary
                  : '不添加参考图为文生图；添加参考图后自动改用改图端点。'),
              activeModel?.costHint ? h('span', { className: 'ig-foot-size' }, activeModel.costHint) : null)));
    }

    /** 提示词框右下角的放大键：把焦点放回输入框并滚到末尾。 */
    function guardExpander(ref) {
      return h('button', {
        type: 'button',
        className: 'ig-expand',
        title: '继续编辑提示词',
        'aria-label': '继续编辑提示词',
        onClick: () => {
          const el = ref.current;
          if (!el) return;
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        },
      }, h(Ico.expand, { size: 13 }));
    }

    /* ================================================================== */
    /* 作品页                                                              */
    /* ================================================================== */

    function WorksView(props) {
      const { images, reload, notify, openImage, onUseAsRef, onReusePrompt } = props;
      const [query, setQuery] = useState('');
      const [busy, setBusy] = useState(false);

      const filtered = useMemo(() => {
        const q = String(query || '').trim().toLowerCase();
        if (!q) return images;
        return images.filter((img) => {
          const meta = img.meta || {};
          return [img.name, meta.prompt, meta.model, meta.provider, meta.size]
            .filter(Boolean).join(' ').toLowerCase().includes(q);
        });
      }, [images, query]);

      const remove = useCallback(async (name) => {
        if (!window.confirm('删除这张图？文件会从磁盘移除。')) return;
        setBusy(true);
        try {
          await postJson('/image.delete.json', { name });
          notify('已删除 ' + name, 'ok');
          await reload();
        } catch (e) {
          notify(String((e && e.message) || e), 'bad');
        } finally {
          setBusy(false);
        }
      }, [reload, notify]);

      /** 时间戳：与详情弹层保持同一种写法，读起来更快。 */
      const stampOf = (img) => {
        const iso = img.meta?.at;
        const t = iso ? new Date(iso) : new Date(img.mtime);
        if (Number.isNaN(t.getTime())) return '';
        return t.toLocaleString('zh-CN', {
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
        }).replace(/\//g, '/');
      };

      return h('div', { className: 'ig-view' },
        h('div', { className: 'ig-stage ig-scroll' },
          h('div', { className: 'ig-works' },
            h('div', { className: 'ig-works-bar' },
              h('span', { className: 'ig-works-note' },
                '当前项目作品保存在本机，点击图片可查看完整原图。' +
                (images.length ? '（' + images.length + ' 张）' : '')),
              h('label', { className: 'ig-search' },
                h(Ico.search, { size: 13 }),
                h('input', {
                  className: 'ig-input',
                  value: query,
                  placeholder: '按提示词 / 模型过滤',
                  'aria-label': '搜索作品',
                  onChange: (e) => setQuery(e.target.value),
                })),
              h('button', {
                type: 'button', className: 'ig-btn ig-btn-sm', title: '重新读取作品',
                onClick: reload,
              }, h(Ico.refresh, { size: 13 }), '刷新'),
              images.length
                ? h('button', {
                  type: 'button', className: 'ig-btn ig-btn-sm ig-btn-danger', title: '把作品目录里的图全部删除',
                  disabled: busy,
                  onClick: async () => {
                    if (!window.confirm('清空全部 ' + images.length + ' 张作品？文件会从磁盘删除，无法恢复。')) return;
                    setBusy(true);
                    let ok = 0;
                    let failed = 0;
                    for (const img of images) {
                      try {
                        await postJson('/image.delete.json', { name: img.name });
                        ok += 1;
                      } catch {
                        failed += 1;
                      }
                    }
                    setBusy(false);
                    notify('已删除 ' + ok + ' 张' + (failed ? '，失败 ' + failed + ' 张' : ''), failed ? 'warn' : 'ok');
                    await reload();
                  },
                }, '清空项目作品')
                : null),

            images.length === 0
              ? h('div', { className: 'ig-empty' },
                h('div', { className: 'ig-empty-mark' }, h(Ico.grid, { size: 22 })),
                h('div', { className: 'ig-empty-title' }, '还没有作品'),
                h('p', { className: 'ig-empty-text' },
                  '在「创作」页出一张，或者直接在对话里让 AI 调 image_generate，生成的图都会出现在这里。'))
              : filtered.length === 0
                ? h('div', { className: 'ig-empty' },
                  h('div', { className: 'ig-empty-title' }, '没有匹配的作品'),
                  h('p', { className: 'ig-empty-text' }, '换个关键词试试：提示词、模型名、尺寸都能搜。'))
                : h('div', { className: 'ig-grid' },
                  filtered.map((img) => {
                    const meta = img.meta || {};
                    const modeLabel = meta.mode === 'edit' ? '编辑' : '生成';
                    const ratioLabel = meta.ratio || (meta.size ? String(meta.size).replace('x', ' × ') : '');
                    const tierLabel = meta.resolution || '';
                    const qualityLabel = meta.quality || '';
                    const promptText = meta.prompt || '';
                    return h('div', { key: img.name, className: 'ig-card' },
                      h('div', {
                        className: 'ig-card-media',
                        onClick: () => openImage(img),
                        role: 'button',
                        tabIndex: 0,
                        title: '点击查看大图',
                        onKeyDown: (e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            openImage(img);
                          }
                        },
                      },
                        h('img', {
                          src: imageUrl(img.name),
                          alt: promptText || img.name,
                          loading: 'lazy',
                        })),
                      h('div', { className: 'ig-card-body' },
                        h('div', { className: 'ig-card-tags' },
                          h('span', { className: 'ig-tag', 'data-tone': modeLabel === '编辑' ? 'violet' : '' }, modeLabel),
                          ratioLabel ? h('span', { className: 'ig-tag' }, ratioLabel) : null,
                          tierLabel ? h('span', { className: 'ig-tag' }, tierLabel) : null,
                          qualityLabel ? h('span', { className: 'ig-tag' }, qualityLabel) : null,
                          meta.model ? h('span', { className: 'ig-tag' }, meta.model) : null),
                        h('div', { className: 'ig-card-time' }, stampOf(img)),
                        h('p', {
                          className: 'ig-card-prompt',
                          'data-empty': promptText ? '0' : '1',
                          title: promptText,
                        }, promptText || '（这张图没有记录提示词）'),
                        h('div', { className: 'ig-card-acts' },
                          h('a', {
                            href: downloadUrl(img.name),
                            download: basename(img.name),
                            onClick: (e) => e.stopPropagation(),
                          }, h(Ico.download, { size: 12 }), '下载'),
                          h('button', {
                            type: 'button',
                            title: '把提示词与参数放回创作台',
                            onClick: () => {
                              if (!promptText) {
                                notify('这张图没有记录提示词，无法复用', 'warn');
                                return;
                              }
                              onReusePrompt(promptText, replayFromMeta(meta, img.name));
                            },
                          }, h(Ico.refresh, { size: 12 }), '复用设置'),
                          h('button', {
                            type: 'button',
                            title: '把这张图挂到创作台当参考图',
                            onClick: () => onUseAsRef(img),
                          }, h(Ico.image, { size: 12 }), '作为参考图'),
                          h('button', {
                            type: 'button',
                            className: 'ig-danger',
                            disabled: busy,
                            onClick: () => remove(img.name),
                          }, h(Ico.trash, { size: 12 }), '删除'))));
                  })))));
    }

    /* ================================================================== */
    /* 接入点与模型页                                                      */
    /* ================================================================== */

    const BLANK_PROVIDER = {
      name: '', baseUrl: '', apiKey: '',
      generatePath: '/images/generations', editPath: '',
      taskMode: 'sync', statusPath: '',
      taskIdField: 'data.task_id', resultUrlsField: 'result_url',
      pollIntervalMs: 3000, pollTimeoutMs: 300000, headersText: '',
    };

    const BLANK_MODEL = {
      name: '', model: '', providerId: '', caps: 'both',
      bodyTemplate: '', resultPath: '', maxSide: '',
      summary: '', notes: '', costHint: '', formats: '',
      extraText: '', sizesText: '',
      // ---- 适配层 ----
      paramsSpec: {}, bodyMode: 'openai', imagePayload: 'objects',
      endpointGen: '', endpointEdit: '', resultUrlField: '', editJson: false,
    };

    const TEMPLATE_PRESETS = [
      {
        id: 'dashscope',
        label: '阿里 DashScope 原生',
        value: '{"model":"{{model}}","input":{"messages":[{"role":"user","content":[{{image_blocks}}{"text":"{{prompt}}"}]}]},"parameters":{"prompt_extend":true,"n":{{n}},"size":"{{size_star}}","watermark":false}}',
      },
      {
        id: 'sensenova',
        label: '日日新 SenseNova 改图',
        value: '{"model":"{{model}}","prompt":"{{prompt}}","n":{{n}},"size":"auto","images":{{image_urls}},"watermark":false,"response_format":"b64_json"}',
      },
      {
        id: 'plain',
        label: '通用 JSON：model / prompt / n / size',
        value: '{"model":"{{model}}","prompt":"{{prompt}}","n":{{n}},"size":"{{size}}"}',
      },
      {
        id: 'sdwebui',
        label: 'SD WebUI 风格（含反向提示词与种子）',
        value: '{"model":"{{model}}","prompt":"{{prompt}}","negative_prompt":"{{negative}}","n_iter":{{n}},"size":"{{size}}","seed":{{seed}}}',
      },
    ];

    function ConfigView(props) {
      const { snapshot, reload, notify } = props;
      const [kind, setKind] = useState('');
      const [draft, setDraft] = useState(null);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [tested, setTested] = useState({});
      const [probed, setProbed] = useState({});
      const [discover, setDiscover] = useState(null);
      const [tplCheck, setTplCheck] = useState(null);

      const providers = snapshot?.config?.providers || [];
      const models = snapshot?.config?.models || [];
      const readiness = snapshot?.readiness || [];

      const save = useCallback(async (next, okText) => {
        setBusy(true);
        setError('');
        try {
          await postJson('/config.json', { config: next });
          notify(okText, 'ok');
          setKind('');
          setDraft(null);
          await reload();
        } catch (e) {
          setError(String((e && e.message) || e));
        } finally {
          setBusy(false);
        }
      }, [reload, notify]);

      /** 拿原始配置改一处再整体写回；sizes 只回写真正存过的值。 */
      const mutate = useCallback(async (fn, okText) => {
        const raw = snapshot?.raw;
        if (!raw) return;
        const next = {
          version: raw.version,
          providers: JSON.parse(JSON.stringify(raw.providers || [])),
          models: JSON.parse(JSON.stringify(raw.models || [])),
          defaultModel: raw.defaultModel || '',
          timeoutMs: raw.timeoutMs,
          outputDir: raw.outputDir || '',
          recordMetadata: raw.recordMetadata !== false,
          sizes: raw.sizes || {},
        };
        fn(next);
        await save(next, okText);
      }, [snapshot, save]);

      const probe = useCallback(async (providerId) => {
        setProbed((prev) => ({ ...prev, [providerId]: { pending: true } }));
        try {
          const out = await postJson('/probe.json', { providerId });
          setProbed((prev) => ({ ...prev, [providerId]: out.result }));
          return out.result;
        } catch (e) {
          const failed = { ok: false, reason: String((e && e.message) || e) };
          setProbed((prev) => ({ ...prev, [providerId]: failed }));
          return failed;
        }
      }, []);

      const test = useCallback(async (providerId, modelId) => {
        setTested((prev) => ({ ...prev, [providerId]: { pending: true } }));
        try {
          const out = await postJson('/test.json', { providerId, modelId });
          setTested((prev) => ({ ...prev, [providerId]: out.result }));
        } catch (e) {
          setTested((prev) => ({ ...prev, [providerId]: { ok: false, reason: String((e && e.message) || e) } }));
        }
      }, []);

      const runDiscover = useCallback(async (providerId) => {
        const r = await probe(providerId);
        if (!r || !r.ok) {
          notify('先探活成功才能发现模型：' + (r?.reason || '未知原因'), 'bad');
          return;
        }
        const ids = Array.isArray(r.models) ? r.models : [];
        if (!ids.length) {
          notify('站点没返回可解析的模型 id（报告 ' + (r.count ?? 0) + ' 个条目）。', 'warn');
          return;
        }
        setDiscover({
          providerId,
          ids,
          picked: ids.filter((id) => /image|flux|dall|sd|vision|paint|draw/i.test(id)),
        });
      }, [probe, notify]);

      const checkTemplate = useCallback(async (template) => {
        setTplCheck({ pending: true });
        try {
          const out = await postJson('/template.check.json', { template });
          setTplCheck({ ok: true, result: out.result });
        } catch (e) {
          setTplCheck({ ok: false, error: String((e && e.message) || e) });
        }
      }, []);

      const patch = (fields) => setDraft((d) => ({ ...d, ...fields }));

      /* —— 接入点表单 —— */
      const providerForm = kind === 'provider' && draft
        ? h('div', { className: 'ig-form' },
          h('div', { className: 'ig-form-title' }, draft.id ? '编辑接入点' : '新建接入点'),
          h(Field, { label: '名称' },
            h('input', {
              className: 'ig-input', value: draft.name, placeholder: '中转站 / 官方',
              onChange: (e) => patch({ name: e.target.value }),
            })),
          h(Field, { label: 'Base URL', hint: '只填到版本号为止，端点不要写进来。' },
            h('input', {
              className: 'ig-input', value: draft.baseUrl, placeholder: 'https://api.example.com/v1',
              onChange: (e) => patch({ baseUrl: e.target.value }),
            })),
          h(Field, { label: 'API Key', hint: draft.id ? '留空表示不修改现有密钥。' : '只存本地 config.json（0600）。' },
            h('input', {
              className: 'ig-input', type: 'password', value: draft.apiKey,
              placeholder: draft.id ? '（不修改）' : 'sk-…',
              autoComplete: 'new-password',
              onChange: (e) => patch({ apiKey: e.target.value }),
            })),
          h('div', { className: 'ig-2col' },
            h(Field, { label: '生图端点' },
              h('input', {
                className: 'ig-input', value: draft.generatePath || '', placeholder: '/images/generations',
                onChange: (e) => patch({ generatePath: e.target.value }),
              })),
            h(Field, { label: '改图端点', hint: '留空且模型有模板时退回生图端点。' },
              h('input', {
                className: 'ig-input', value: draft.editPath || '', placeholder: '/images/edits',
                onChange: (e) => patch({ editPath: e.target.value }),
              }))),
          h(Field, { label: '协议形态', hint: 'sync = 请求直接返回图片；poll = 先提交拿 task_id 再轮询（很多中转站是这种）。' },
            Seg([{ value: 'sync', label: '同步返回' }, { value: 'poll', label: '异步轮询' }], draft.taskMode,
              (v) => patch({ taskMode: v }), '协议形态')),
          draft.taskMode === 'poll'
            ? h('div', { className: 'ig-3col' },
              h(Field, { label: '状态查询端点' },
                h('input', {
                  className: 'ig-input', value: draft.statusPath || '', placeholder: '/media/status',
                  onChange: (e) => patch({ statusPath: e.target.value }),
                })),
              h(Field, { label: 'task_id 取值路径' },
                h('input', {
                  className: 'ig-input', value: draft.taskIdField || '', placeholder: 'data.task_id',
                  onChange: (e) => patch({ taskIdField: e.target.value }),
                })),
              h(Field, { label: '图片地址取值路径' },
                h('input', {
                  className: 'ig-input', value: draft.resultUrlsField || '', placeholder: 'result_url',
                  onChange: (e) => patch({ resultUrlsField: e.target.value }),
                })),
              h(Field, { label: '轮询间隔（ms）' },
                h('input', {
                  className: 'ig-input', value: String(draft.pollIntervalMs || ''), placeholder: '3000',
                  onChange: (e) => patch({ pollIntervalMs: e.target.value.replace(/[^\d]/g, '') }),
                })),
              h(Field, { label: '轮询超时（ms）' },
                h('input', {
                  className: 'ig-input', value: String(draft.pollTimeoutMs || ''), placeholder: '300000',
                  onChange: (e) => patch({ pollTimeoutMs: e.target.value.replace(/[^\d]/g, '') }),
                })))
            : null,
          h(Field, { label: '额外请求头（JSON，可留空）', hint: '有些站不用 Bearer，要 {"x-api-key":"…"}。authorization 会自动按 API Key 填。' },
            h('textarea', {
              className: 'ig-area ig-area-code', value: draft.headersText || '',
              placeholder: '{"api-key":"…"}',
              onChange: (e) => patch({ headersText: e.target.value }),
            })),
          error ? h(Msg, { text: error, tone: 'bad' }) : null,
          h('div', { style: { display: 'flex', gap: 8, marginTop: 10 } },
            h('button', {
              type: 'button',
              className: 'ig-btn ig-btn-primary',
              disabled: busy || !String(draft.baseUrl || '').trim(),
              onClick: () => {
                let headers = {};
                const rawHeaders = String(draft.headersText || '').trim();
                if (rawHeaders) {
                  try {
                    headers = JSON.parse(rawHeaders);
                  } catch (e) {
                    setError('额外请求头不是合法 JSON：' + String((e && e.message) || e));
                    return;
                  }
                }
                const patchBody = {
                  name: draft.name.trim(),
                  baseUrl: draft.baseUrl.trim().replace(/\/+$/, ''),
                  generatePath: draft.generatePath || '/images/generations',
                  editPath: draft.editPath || '',
                  taskMode: draft.taskMode || 'sync',
                  statusPath: (draft.statusPath || '').trim(),
                  taskIdField: (draft.taskIdField || 'data.task_id').trim(),
                  resultUrlsField: (draft.resultUrlsField || 'result_url').trim(),
                  pollIntervalMs: Number(draft.pollIntervalMs) > 0 ? Number(draft.pollIntervalMs) : 3000,
                  pollTimeoutMs: Number(draft.pollTimeoutMs) > 0 ? Number(draft.pollTimeoutMs) : 300000,
                  headers,
                };
                mutate((next) => {
                  if (draft.id) {
                    const p = next.providers.find((x) => x.id === draft.id);
                    if (p) {
                      Object.assign(p, patchBody);
                      if (draft.name.trim()) p.name = draft.name.trim();
                      if (draft.apiKey.trim()) p.apiKey = draft.apiKey.trim();
                    }
                  } else {
                    next.providers.push({
                      id: 'p_' + Date.now().toString(36),
                      ...patchBody,
                      name: draft.name.trim() || draft.baseUrl.replace(/^https?:\/\//, '').split('/')[0],
                      apiKey: draft.apiKey.trim(),
                      timeoutMs: 0,
                    });
                  }
                }, '已保存接入点');
              },
            }, busy ? '保存中…' : '保存'),
            h('button', {
              type: 'button', className: 'ig-btn', disabled: busy,
              onClick: () => { setKind(''); setDraft(null); setError(''); },
            }, '取消')))
        : null;

      /* —— 模型表单 —— */
      const modelForm = kind === 'model' && draft
        ? h('div', { className: 'ig-form' },
          h('div', { className: 'ig-form-title' }, draft.id ? '编辑模型' : '新建模型'),
          h('div', { className: 'ig-2col' },
            h(Field, { label: '显示名称' },
              h('input', {
                className: 'ig-input', value: draft.name, placeholder: 'GPT Image',
                onChange: (e) => patch({ name: e.target.value }),
              })),
            h(Field, { label: '模型 ID', hint: '必须与服务商给的完全一致。' },
              h('input', {
                className: 'ig-input', value: draft.model, placeholder: 'gpt-image-1',
                onChange: (e) => patch({ model: e.target.value }),
              }))),
          h('div', { className: 'ig-3col' },
            h(Field, { label: '所属接入点' },
              h('select', {
                className: 'ig-select', value: draft.providerId,
                onChange: (e) => patch({ providerId: e.target.value }),
              },
                h('option', { value: '' }, '（选择）'),
                providers.map((p) => h('option', { key: p.id, value: p.id }, p.name)))),
            h(Field, { label: '适用能力' },
              h('select', {
                className: 'ig-select', value: draft.caps,
                onChange: (e) => patch({ caps: e.target.value }),
              },
                h('option', { value: 'both' }, '生图 + 改图'),
                h('option', { value: 'generate' }, '仅生图'),
                h('option', { value: 'edit' }, '仅改图'))),
            h(Field, { label: '长边上限（px）' },
              h('input', {
                className: 'ig-input', value: draft.maxSide, placeholder: '不限',
                onChange: (e) => patch({ maxSide: e.target.value.replace(/[^\d]/g, '') }),
              }))),
          h('hr', { className: 'ig-sep' }),
          h(Field, { label: '请求体模板（可留空）', hint: '留空按 OpenAI Images 协议；非 OpenAI 协议才需要填。' },
            h('textarea', {
              className: 'ig-area ig-area-code', value: draft.bodyTemplate || '',
              placeholder: '{"model":"{{model}}","prompt":"{{prompt}}","n":{{n}},"size":"{{size}}"}',
              onChange: (e) => patch({ bodyTemplate: e.target.value }),
            })),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 } },
            h('select', {
              className: 'ig-select',
              style: { maxWidth: 260 },
              value: '',
              'aria-label': '套用模板预设',
              onChange: (e) => {
                const preset = TEMPLATE_PRESETS.find((p) => p.id === e.target.value);
                if (preset) patch({ bodyTemplate: preset.value });
              },
            },
              h('option', { value: '' }, '套用模板预设…'),
              TEMPLATE_PRESETS.map((p) => h('option', { key: p.id, value: p.id }, p.label))),
            h('button', {
              type: 'button', className: 'ig-btn ig-btn-sm',
              disabled: !String(draft.bodyTemplate || '').trim(),
              onClick: () => checkTemplate(draft.bodyTemplate),
            }, '校验模板'),
            tplCheck
              ? h('span', { className: 'ig-hint' },
                tplCheck.pending ? '校验中…' : tplCheck.ok ? '✓ 两遍渲染都是合法 JSON' : '✗ ' + tplCheck.error)
              : null),
          h(Field, { label: '结果取值路径（可留空）', hint: '留空自动嗅探。支持 a.b[0].c 与展开 output.results[].url，可逗号分隔多个候选。' },
            h('input', {
              className: 'ig-input', value: draft.resultPath || '', placeholder: 'output.results[].url',
              onChange: (e) => patch({ resultPath: e.target.value }),
            })),
          h('hr', { className: 'ig-sep' }),
          /* ---- 适配层：让「接新模型」等于写配置 ---- */
          h(Field, {
            label: '模型私有参数（这个模型自己认识的那些参数）',
            hint: '声明了你就能在「生成」页看到真实控件，AI 也会知道自己能传什么。' +
              '「跟随」一栏填 format/size/quality 这类通用参数名，这个私有参数就会自动跟着它取值' +
              '（例：output_format 跟随 format，用户选 gif 就自动变成 gif）。',
          },
            h(ParamsEditor, {
              rows: specToRows(draft.paramsSpec || {}),
              onChange: (rows) => patch({ paramsSpec: rowsToSpec(rows) }),
            })),
          h('div', { className: 'ig-3col' },
            h(Field, {
              label: '请求体骨架',
              hint: 'openai=带 model/prompt/size/quality/n；minimal=只带 model/prompt/n；custom=全由上面的参数表决定。',
            },
              h('select', {
                className: 'ig-select', value: draft.bodyMode || 'openai',
                onChange: (e) => patch({ bodyMode: e.target.value }),
              },
                h('option', { value: 'openai' }, 'openai（默认）'),
                h('option', { value: 'minimal' }, 'minimal'),
                h('option', { value: 'custom' }, 'custom'))),
            h(Field, {
              label: '参考图装载形态',
              hint: 'objects=[{"image_url":…}]；urls=["…"]；image_strings=image:["字符串"]；image=单图对象。',
            },
              h('select', {
                className: 'ig-select', value: draft.imagePayload || 'objects',
                onChange: (e) => patch({ imagePayload: e.target.value }),
              },
                h('option', { value: 'objects' }, 'objects'),
                h('option', { value: 'urls' }, 'urls'),
                h('option', { value: 'image_strings' }, 'image_strings'),
                h('option', { value: 'image' }, 'image'))),
            h(Field, {
              label: '改图走 JSON',
              hint: '声明了参数表会自动生效；没声明时才需要手动开。',
            },
              h('label', { className: 'ig-check' },
                h('input', {
                  type: 'checkbox', checked: Boolean(draft.editJson),
                  onChange: (e) => patch({ editJson: e.target.checked }),
                }),
                h('span', {}, '开')))),
          h('div', { className: 'ig-2col' },
            h(Field, {
              label: '生成端点（模型级覆盖，可留空）',
              hint: '留空用接入点的。统一端点站（一个端点同时吃生图/改图）在这里填。',
            },
              h('input', {
                className: 'ig-input', value: draft.endpointGen || '',
                placeholder: '/media/generate',
                onChange: (e) => patch({ endpointGen: e.target.value }),
              })),
            h(Field, {
              label: '改图端点（模型级覆盖，可留空）',
              hint: '关键：同一接入点下不同模型认不同端点时，靠这个字段区分。',
            },
              h('input', {
                className: 'ig-input', value: draft.endpointEdit || '',
                placeholder: '/media/generate',
                onChange: (e) => patch({ endpointEdit: e.target.value }),
              }))),
          h(Field, {
            label: '结果取值路径覆盖（可留空）',
            hint: '留空用接入点的 resultUrlsField。如 result_url / data.result_urls[]。',
          },
            h('input', {
              className: 'ig-input', value: draft.resultUrlField || '',
              placeholder: 'result_url',
              onChange: (e) => patch({ resultUrlField: e.target.value }),
            })),
          h('hr', { className: 'ig-sep' }),
          h(Field, { label: '自定义声明 · 能力', hint: '一句话说明它能干嘛。AI 会据此在多个模型之间挑合适的那个。' },
            h('input', {
              className: 'ig-input', value: draft.summary || '',
              placeholder: '出静态插画，擅长写实人像；也能出 SVG 与 GIF',
              onChange: (e) => patch({ summary: e.target.value }),
            })),
          h(Field, { label: '自定义声明 · 备注（可留空）', hint: '尺寸限制、速度、已知坑、适用场景。' },
            h('textarea', {
              className: 'ig-area', style: { minHeight: 64 }, value: draft.notes || '',
              placeholder: '长边上限 2048；出图约 20 秒；中文提示词效果一般',
              onChange: (e) => patch({ notes: e.target.value }),
            })),
          h('div', { className: 'ig-2col' },
            h(Field, { label: '费用提示（可留空）', hint: '帮 AI 权衡要不要多生成几张。' },
              h('input', {
                className: 'ig-input', value: draft.costHint || '', placeholder: '按次计费 · 约 0.2 元/张',
                onChange: (e) => patch({ costHint: e.target.value }),
              })),
            h(Field, { label: '产出格式（逗号分隔）', hint: 'png / jpeg / webp / gif / svg。' },
              h('input', {
                className: 'ig-input', value: draft.formats || '', placeholder: 'png, gif, svg',
                onChange: (e) => patch({ formats: e.target.value }),
              }))),
          h('div', { className: 'ig-2col' },
            h(Field, { label: '额外请求参数 extra（JSON，可留空）', hint: '浅合并进请求体顶层。' },
              h('textarea', {
                className: 'ig-area ig-area-code', value: draft.extraText || '',
                placeholder: '{"quality":"high"}',
                onChange: (e) => patch({ extraText: e.target.value }),
              })),
            h(Field, { label: '尺寸覆盖 sizes（JSON，可留空）', hint: '{"2K":{"16:9":"2560x1440"}}；留空按面积自动换算。' },
              h('textarea', {
                className: 'ig-area ig-area-code', value: draft.sizesText || '',
                placeholder: '{"2K":{"16:9":"2560x1440"}}',
                onChange: (e) => patch({ sizesText: e.target.value }),
              }))),
          error ? h(Msg, { text: error, tone: 'bad' }) : null,
          h('div', { style: { display: 'flex', gap: 8, marginTop: 10 } },
            h('button', {
              type: 'button',
              className: 'ig-btn ig-btn-primary',
              disabled: busy || !String(draft.model || '').trim() || !draft.providerId,
              onClick: () => {
                let extra;
                let sizes;
                const rawExtra = String(draft.extraText || '').trim();
                const rawSizes = String(draft.sizesText || '').trim();
                if (rawExtra) {
                  try {
                    extra = JSON.parse(rawExtra);
                  } catch (e) {
                    setError('额外请求参数不是合法 JSON：' + String((e && e.message) || e));
                    return;
                  }
                }
                if (rawSizes) {
                  try {
                    sizes = JSON.parse(rawSizes);
                  } catch (e) {
                    setError('尺寸覆盖不是合法 JSON：' + String((e && e.message) || e));
                    return;
                  }
                }
                const formats = String(draft.formats || '')
                  .split(/[,\s]+/).map((s) => s.trim().toLowerCase().replace(/^\./, '')).filter(Boolean);
                const body = {
                  name: draft.name.trim() || draft.model.trim(),
                  model: draft.model.trim(),
                  providerId: draft.providerId,
                  caps: draft.caps,
                  bodyTemplate: draft.bodyTemplate || '',
                  resultPath: (draft.resultPath || '').trim(),
                  maxSide: Number(draft.maxSide) > 0 ? Number(draft.maxSide) : 0,
                  summary: (draft.summary || '').trim(),
                  notes: (draft.notes || '').trim(),
                  costHint: (draft.costHint || '').trim(),
                  formats,
                  /* 清空 extras / sizes 时必须显式写空对象 —— 以前用
                     `...(extra === undefined ? {} : { extra })`，清空时整个键消失，
                     Object.assign 不覆盖旧值，用户以为删了、配置里还留着。 */
                  extra: extra || {},
                  sizes: sizes || {},
                  // ---- 适配层 ----
                  params: draft.paramsSpec || {},
                  bodyMode: draft.bodyMode || 'openai',
                  imagePayload: draft.imagePayload || 'objects',
                  endpoints: {
                    generate: (draft.endpointGen || '').trim(),
                    edit: (draft.endpointEdit || '').trim(),
                  },
                  resultUrlField: (draft.resultUrlField || '').trim(),
                  editJson: Boolean(draft.editJson),
                };
                mutate((next) => {
                  if (draft.id) {
                    const m = next.models.find((x) => x.id === draft.id);
                    if (m) Object.assign(m, body);
                  } else {
                    const id = 'm_' + Date.now().toString(36);
                    next.models.push({ id, ...body, extra: extra || {}, sizes: sizes || {} });
                    if (!next.defaultModel) next.defaultModel = id;
                  }
                }, '已保存模型');
              },
            }, busy ? '保存中…' : '保存'),
            h('button', {
              type: 'button', className: 'ig-btn', disabled: busy,
              onClick: () => { setKind(''); setDraft(null); setError(''); },
            }, '取消')))
        : null;

      return h('div', { className: 'ig-view' },
        h('div', { className: 'ig-stage ig-scroll' },
          h('div', { className: 'ig-cfg' },

            /* 接入点（每个接入点一张分组卡片，模型挂在它下面） */
            h('section', { className: 'ig-sec' },
              h('div', { className: 'ig-sec-head' },
                h('span', { className: 'ig-sec-title' }, '接入点'),
                providers.length
                  ? h('span', { className: 'ig-tag' }, providers.length + ' 个接入点 · ' + models.length + ' 个模型')
                  : null,
                h('button', {
                  type: 'button', className: 'ig-btn ig-btn-sm ig-btn-primary',
                  onClick: () => { setKind('provider'); setDraft({ ...BLANK_PROVIDER }); setError(''); setTplCheck(null); },
                }, h(Ico.plus, { size: 13 }), '新建接入点')),
              h('p', { className: 'ig-sec-desc' },
                '一个地址配一把密钥为一个接入点，它下面的模型共用这套凭据，不用每个模型都填一遍。'),

              providers.length === 0
                ? h('p', { className: 'ig-hint' }, '还没有接入点。点右上角「新建接入点」开始。')
                : providers.map((p) => {
                  const t = tested[p.id];
                  const pr = probed[p.id];
                  const own = models.filter((m) => m.providerId === p.id);
                  return h('div', { key: p.id, className: 'ig-group' },
                    h('div', { className: 'ig-group-head' },
                      h('div', { className: 'ig-group-main' },
                        h('div', { className: 'ig-group-name' },
                          p.name,
                          p.hasKey
                            ? h('span', { className: 'ig-tag', 'data-tone': 'ok' }, '密钥已设置')
                            : h('span', { className: 'ig-tag', 'data-tone': 'bad' }, '缺 API Key'),
                          p.taskMode === 'poll'
                            ? h('span', { className: 'ig-tag' }, '异步轮询')
                            : null),
                        h('div', { className: 'ig-group-sub ig-mono' }, p.baseUrl || '（未填 Base URL）'),
                        (p.hasKey && p.keyHint) || (Array.isArray(p.headers) && p.headers.length)
                          ? h('div', { className: 'ig-group-sub' },
                            [
                              p.hasKey && p.keyHint ? '密钥 ' + p.keyHint : '',
                              Array.isArray(p.headers) && p.headers.length ? '自定义头 ' + p.headers.length : '',
                            ].filter(Boolean).join(' · '))
                          : null),
                      h('div', { className: 'ig-group-acts' },
                        h('button', {
                          type: 'button', className: 'ig-btn ig-btn-sm', title: 'GET /models，免费，只验地址与密钥',
                          onClick: () => probe(p.id),
                        }, pr?.pending ? '探活中…' : '探活'),
                        h('button', {
                          type: 'button', className: 'ig-btn ig-btn-sm', title: '从站点的 /models 拉清单，勾选后批量加模型',
                          onClick: () => runDiscover(p.id),
                        }, '发现模型'),
                        h('button', {
                          type: 'button', className: 'ig-btn ig-btn-sm', title: '真发一次生成请求，会产生少量费用',
                          onClick: () => test(p.id),
                        }, t?.pending ? '测试中…' : '测试'),
                        h('button', {
                          type: 'button', className: 'ig-btn ig-btn-sm',
                          onClick: () => {
                            const raw = snapshot?.raw?.providers?.find((x) => x.id === p.id);
                            setKind('provider');
                            setDraft({
                              id: p.id,
                              name: p.name,
                              baseUrl: raw?.baseUrl || p.baseUrl || '',
                              apiKey: '',
                              generatePath: raw?.generatePath || p.generatePath || '/images/generations',
                              editPath: raw?.editPath || '',
                              taskMode: raw?.taskMode || 'sync',
                              statusPath: raw?.statusPath || '',
                              taskIdField: raw?.taskIdField || 'data.task_id',
                              resultUrlsField: raw?.resultUrlsField || 'result_url',
                              pollIntervalMs: raw?.pollIntervalMs || 3000,
                              pollTimeoutMs: raw?.pollTimeoutMs || 300000,
                              headersText: raw?.headers && Object.keys(raw.headers).length ? JSON.stringify(raw.headers, null, 2) : '',
                            });
                            setError('');
                            setTplCheck(null);
                          },
                        }, '编辑'),
                        h('button', {
                          type: 'button', className: 'ig-btn ig-btn-sm ig-btn-danger',
                          onClick: () => {
                            if (!window.confirm('删除接入点「' + p.name + '」及其下所有模型？')) return;
                            mutate((next) => {
                              next.providers = next.providers.filter((x) => x.id !== p.id);
                              next.models = next.models.filter((m) => m.providerId !== p.id);
                              if (!next.models.some((m) => m.id === next.defaultModel)) {
                                next.defaultModel = next.models[0]?.id || '';
                              }
                            }, '已删除接入点');
                          },
                        }, '删除'))),

                    pr && !pr.pending
                      ? h(Msg, {
                        tone: pr.ok ? 'ok' : 'bad',
                        text: pr.ok
                          ? '探活正常（HTTP ' + pr.status + '）' +
                          (pr.count !== null && pr.count !== undefined
                            ? '，站点报告 ' + pr.count + ' 个模型' + (pr.models?.length ? '：' + pr.models.join('、') : '')
                            : '') +
                          '\n这只证明地址与密钥可用，模型名对不对要再点「测试」。'
                          : pr.reason,
                      })
                      : null,
                    t && !t.pending
                      ? h(Msg, {
                        tone: t.ok ? (t.imageOk ? 'ok' : 'warn') : 'bad',
                        text: t.ok
                          ? '连通正常（HTTP ' + t.status + '）' + (t.note ? ' · ' + t.note : '') +
                          (t.imageOk ? '' : '，但没解析出图片：' + (t.imageError || ''))
                          : t.reason,
                      })
                      : null,

                    /* 该接入点下的模型 */
                    own.length === 0
                      ? h('p', { className: 'ig-hint', style: { margin: '10px 0 0' } },
                        '这个接入点下还没有模型。')
                      : own.map((m) => {
                        const st = readiness.find((r) => r.id === m.providerId)?.models?.find((x) => x.id === m.id);
                        const capsLabel = m.caps === 'both' ? '生图+改图' : m.caps === 'edit' ? '仅改图' : '仅生图';
                        return h('div', { key: m.id, className: 'ig-model' },
                          h('div', { className: 'ig-model-main' },
                            h('div', { className: 'ig-model-name' },
                              m.name,
                              m.isDefault ? h('span', { className: 'ig-tag' }, '默认') : null),
                            h('div', { className: 'ig-model-sub' },
                              m.model + ' · ' + capsLabel +
                              (m.providerMissing ? ' · ⚠ 接入点已删除'
                                : st ? (st.ready ? '' : ' · ⚠ 未就绪') : '')),
                            m.summary
                              ? h('div', { className: 'ig-model-sub', title: m.summary }, m.summary)
                              : h('div', { className: 'ig-model-sub', style: { color: 'var(--ig-fg4)' } },
                                '未写能力声明 —— 加一句，AI 才知道什么时候该选它。')),
                          h('div', { className: 'ig-model-acts' },
                            h('button', {
                              type: 'button', className: 'ig-btn ig-btn-sm',
                              onClick: () => {
                                const raw = snapshot?.raw?.models?.find((x) => x.id === m.id);
                                setKind('model');
                                setDraft({
                                  id: m.id,
                                  name: m.name,
                                  model: m.model,
                                  providerId: m.providerId,
                                  caps: m.caps,
                                  bodyTemplate: raw?.bodyTemplate || '',
                                  resultPath: raw?.resultPath || '',
                                  maxSide: m.maxSide ? String(m.maxSide) : '',
                                  summary: m.summary || '',
                                  notes: m.notes || '',
                                  costHint: m.costHint || '',
                                  formats: Array.isArray(m.formats) ? m.formats.join(', ') : m.formats || '',
                                  extraText: raw?.extra && Object.keys(raw.extra).length ? JSON.stringify(raw.extra, null, 2) : '',
                                  sizesText: raw?.sizes && Object.keys(raw.sizes).length ? JSON.stringify(raw.sizes, null, 2) : '',
                                  // ---- 适配层 ----
                                  paramsSpec: raw?.params || m.params || {},
                                  bodyMode: m.bodyMode || 'openai',
                                  imagePayload: m.imagePayload || 'objects',
                                  endpointGen: (m.endpoints && m.endpoints.generate) || '',
                                  endpointEdit: (m.endpoints && m.endpoints.edit) || '',
                                  resultUrlField: m.resultUrlField || '',
                                  editJson: m.editJson === true,
                                });
                                setError('');
                                setTplCheck(null);
                              },
                            }, '编辑'),
                            h('button', {
                              type: 'button', className: 'ig-btn ig-btn-sm',
                              disabled: m.isDefault,
                              onClick: () => mutate((next) => { next.defaultModel = m.id; }, '已设为默认模型'),
                            }, m.isDefault ? '默认' : '设为默认'),
                            h('button', {
                              type: 'button', className: 'ig-btn ig-btn-sm ig-btn-danger',
                              onClick: () => {
                                if (!window.confirm('删除模型「' + m.name + '」？')) return;
                                mutate((next) => {
                                  next.models = next.models.filter((x) => x.id !== m.id);
                                  if (next.defaultModel === m.id) next.defaultModel = next.models[0]?.id || '';
                                }, '已删除模型');
                              },
                            }, '删除')));
                      }),

                    /* 新建/编辑模型时，表单就地出现在这个接入点下 */
                    kind === 'model' && draft && draft.providerId === p.id ? modelForm : null,

                    h('button', {
                      type: 'button', className: 'ig-addrow',
                      onClick: () => {
                        setKind('model');
                        setDraft({ ...BLANK_MODEL, providerId: p.id });
                        setError('');
                        setTplCheck(null);
                      },
                    }, h(Ico.plus, { size: 13 }), '在此接入点下添加模型'));
                }),
              providerForm),

            /* 发现的模型 */
            discover
              ? h('section', { className: 'ig-sec' },
                h('div', { className: 'ig-sec-head' },
                  h('span', { className: 'ig-sec-title' }, '发现的模型（' + discover.ids.length + '）'),
                  h('button', { type: 'button', className: 'ig-btn ig-btn-sm', onClick: () => setDiscover(null) }, '关闭')),
                h('p', { className: 'ig-sec-desc' }, '勾选要加的模型，再点「加入选中」。默认勾上了名字像生图的那些。'),
                h('div', { className: 'ig-discover' },
                  discover.ids.map((id) => {
                    const on = discover.picked.includes(id);
                    return h('label', { key: id, 'data-on': on ? '1' : '0' },
                      h('input', {
                        type: 'checkbox',
                        checked: on,
                        onChange: (e) => setDiscover((prev) => ({
                          ...prev,
                          picked: e.target.checked ? prev.picked.concat(id) : prev.picked.filter((x) => x !== id),
                        })),
                      }),
                      id);
                  })),
                h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                  h('button', {
                    type: 'button', className: 'ig-btn ig-btn-primary ig-btn-sm',
                    disabled: busy || !discover.picked.length,
                    onClick: () => {
                      const picked = discover.picked.slice();
                      mutate((next) => {
                        const have = new Set(next.models.filter((m) => m.providerId === discover.providerId).map((m) => m.model));
                        for (const modelId of picked) {
                          if (have.has(modelId)) continue;
                          const id = 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
                          next.models.push({
                            id,
                            providerId: discover.providerId,
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
                          });
                          if (!next.defaultModel) next.defaultModel = id;
                        }
                      }, '已加入 ' + picked.length + ' 个模型');
                      setDiscover(null);
                    },
                  }, '加入选中 ' + discover.picked.length + ' 个'),
                  h('button', {
                    type: 'button', className: 'ig-btn ig-btn-sm',
                    onClick: () => setDiscover((prev) => ({ ...prev, picked: prev.ids.slice() })),
                  }, '全选'),
                  h('button', {
                    type: 'button', className: 'ig-btn ig-btn-sm',
                    onClick: () => setDiscover((prev) => ({
                      ...prev,
                      picked: prev.ids.filter((id) => /image|flux|dall|sd|vision|paint|draw/i.test(id)),
                    })),
                  }, '只选像生图的'),
                  h('button', {
                    type: 'button', className: 'ig-btn ig-btn-sm',
                    onClick: () => setDiscover((prev) => ({ ...prev, picked: [] })),
                  }, '清空选择')),
                h('p', { className: 'ig-hint', style: { marginTop: 8 } },
                  '导入的模型能力默认「生图+改图」且无模板；加完请补能力声明，或先点「测试」验证。'))
              : null,

            /* 全局 */
            h('section', { className: 'ig-sec' },
              h('div', { className: 'ig-sec-head' }, h('span', { className: 'ig-sec-title' }, '全局设置')),
              h('p', { className: 'ig-sec-desc' },
                '配置存在本机：' + (snapshot?.dir || '（未知）') + '（0600）。密钥只在本地文件里，不进插件装配层。'),
              h('label', { className: 'ig-checkline' },
                h('input', {
                  type: 'checkbox',
                  checked: snapshot?.config?.recordMetadata !== false,
                  onChange: () => mutate((next) => { next.recordMetadata = next.recordMetadata === false; }, '已切换元数据记录'),
                }),
                '记录出图元数据（提示词 / 模型 / 尺寸 / 耗时，可回看可复用）')))));
    }

    /* ================================================================== */
    /* 图片详情弹层                                                        */
    /* ================================================================== */

    function ImageModal(props) {
      const { image, meta, onClose, onReusePrompt, onUseAsRef, onDelete, notify } = props;
      const [loaded, setLoaded] = useState(null);

      useEffect(() => {
        if (!image) return undefined;
        const onKey = (e) => {
          if (e.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, [image, onClose]);

      if (!image) return null;
      const m = loaded || meta || image.meta || {};

      return h('div', { className: 'ig-modal', onClick: onClose, role: 'presentation' },
        h('div', {
          className: 'ig-modal-body',
          onClick: (e) => e.stopPropagation(),
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': '作品详情',
        },
          h('div', { className: 'ig-modal-head' },
            h('span', { className: 'ig-modal-title' }, image.name),
            h('span', { className: 'ig-modal-close' },
              h('button', { type: 'button', className: 'ig-btn ig-btn-sm', onClick: onClose }, '关闭'))),
          h('div', { className: 'ig-modal-body-inner' },
            h('div', { className: 'ig-modal-media' },
              h('img', {
                src: imageUrl(image.name),
                alt: (m && m.prompt) || image.name,
                onLoad: () => {
                  if (!image.meta && !meta) {
                    getJson('/image.meta.json?name=' + encodeURIComponent(image.name))
                      .then((out) => setLoaded(out.meta || {}))
                      .catch(() => setLoaded({}));
                  }
                },
              })),
            h('div', { className: 'ig-modal-side' },
              h('dl', { className: 'ig-kv' },
                h('dt', null, '提示词'),
                h('dd', null, m.prompt ? String(m.prompt) : '（无记录）'),
                h('dt', null, '模型'),
                h('dd', null, m.model || '—'),
                h('dt', null, '尺寸'),
                h('dd', null, m.size || '—'),
                m.ratio ? h('dt', null, '画幅') : null,
                m.ratio ? h('dd', null, m.ratio + (m.resolution ? ' · ' + m.resolution : '')) : null,
                // 用户设过的创作参数：留个记录，不然「复用设置」带回了什么都看不出来
                m.params && Object.keys(m.params).length ? h('dt', null, '私有参数') : null,
                m.params && Object.keys(m.params).length
                  ? h('dd', { className: 'ig-mono' },
                    Object.entries(m.params).map(([k, v]) => k + '=' + v).join(' · '))
                  : null,
                m.background ? h('dt', null, '背景') : null,
                m.background ? h('dd', null, m.background) : null,
                m.seed !== undefined && m.seed !== '' ? h('dt', null, '种子') : null,
                m.seed !== undefined && m.seed !== '' ? h('dd', { className: 'ig-mono' }, String(m.seed)) : null,
                m.elapsedMs ? h('dt', null, '耗时') : null,
                m.elapsedMs ? h('dd', null, elapsedLabel(m.elapsedMs)) : null,
                Array.isArray(m.refs) && m.refs.length ? h('dt', null, '参考图') : null,
                /* 老记录只存了 refs（文件名或附件哈希），新记录额外有 refPaths。
                   优先显示 refPaths 的文件名 —— 哈希对用户没有任何意义。 */
                Array.isArray(m.refs) && m.refs.length
                  ? h('dd', null, (Array.isArray(m.refPaths) && m.refPaths.length
                    ? m.refPaths.map((p) => (p ? basename(p) : '（临时图）'))
                    : m.refs).join('、'))
                  : null,
                h('dt', null, '文件'),
                h('dd', { className: 'ig-mono' },
                  humanBytes(image.bytes) + ' · ' + (m.at || new Date(image.mtime).toLocaleString('zh-CN')))),
              h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                m.prompt
                  ? h('button', {
                    type: 'button', className: 'ig-btn ig-btn-sm',
                    onClick: () => {
                      if (copyText(m.prompt)) notify('提示词已复制', 'ok');
                      else notify('复制失败', 'bad');
                    },
                  }, '复制提示词')
                  : null,
                m.prompt
                  ? h('button', {
                    type: 'button', className: 'ig-btn ig-btn-sm',
                    onClick: () => {
                      onReusePrompt(m.prompt, replayFromMeta(m, image.name));
                      onClose();
                    },
                  }, '拿去再生成')
                  : null,
                h('button', {
                  type: 'button', className: 'ig-btn ig-btn-sm',
                  onClick: () => { onUseAsRef(image); onClose(); },
                }, '作为参考图'),
                h('a', {
                  className: 'ig-btn ig-btn-sm',
                  href: downloadUrl(image.name),
                  download: basename(image.name),
                }, '下载'),
                h('button', {
                  type: 'button', className: 'ig-btn ig-btn-sm ig-btn-danger',
                  onClick: () => { onDelete(image.name); onClose(); },
                }, '删除'))))));
    }

    /* ================================================================== */
    /* 主面板                                                              */
    /* ================================================================== */

    function MainPanel() {
      const [view, setView] = useState('create');
      const [snapshot, setSnapshot] = useState(null);
      const [images, setImages] = useState([]);
      const [error, setError] = useState('');
      const [toast, setToast] = useState(null);
      const [refQueue, setRefQueue] = useState([]);
      const [pendingPrompt, setPendingPrompt] = useState('');
      const [viewing, setViewing] = useState(null);
      const toastTimer = useRef(null);

      const notify = useCallback((text, tone) => {
        setToast({ text, tone: tone || 'ok' });
        if (toastTimer.current) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(null), 3200);
      }, []);

      const reload = useCallback(async () => {
        try {
          const [cfg, imgs] = await Promise.all([
            getJson('/config.json'),
            getJson('/images.json?limit=400'),
          ]);
          setSnapshot(cfg);
          setImages(imgs.images || []);
          setError('');
        } catch (e) {
          setError(String((e && e.message) || e));
        }
      }, []);

      /** 静默刷新作品列表：AI 在对话里出的图也要能自己冒出来，不用手点刷新。 */
      const refreshWorks = useCallback(async () => {
        try {
          const imgs = await getJson('/images.json?limit=400');
          setImages(imgs.images || []);
        } catch {
          /* 轮询失败不打扰用户，下一轮再试 */
        }
      }, []);

      useEffect(() => {
        reload();
        return () => {
          if (toastTimer.current) clearTimeout(toastTimer.current);
        };
      }, [reload]);

      // 面板开着的时候定期静默同步：对话里 image_generate 出的图会直接出现在「作品」。
      // 只在页面可见时轮询，切走就停，避免后台白耗。
      useEffect(() => {
        let timer = null;
        const tick = () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
          refreshWorks();
        };
        const start = () => {
          if (timer) return;
          timer = setInterval(tick, 5000);
        };
        const stop = () => {
          if (!timer) return;
          clearInterval(timer);
          timer = null;
        };
        const onVisible = () => {
          if (document.visibilityState === 'visible') {
            tick();
            start();
          } else {
            stop();
          }
        };
        start();
        document.addEventListener('visibilitychange', onVisible);
        window.addEventListener('focus', tick);
        return () => {
          stop();
          document.removeEventListener('visibilitychange', onVisible);
          window.removeEventListener('focus', tick);
        };
      }, [refreshWorks]);

      const openImage = useCallback((img) => {
        if (!img || !img.name) return;
        setViewing(img);
      }, []);

      const useAsRef = useCallback((img) => {
        const path = img?.file || img?.name || '';
        if (!path) return;
        setRefQueue((prev) => (prev.includes(path) ? prev : prev.concat(path)));
        setView('create');
        notify('已加入参考图：' + (img.name || path), 'ok');
      }, [notify]);

      const consumeRefQueue = useCallback(() => setRefQueue([]), []);

      const reusePrompt = useCallback((prompt, extra) => {
        const payload = extra && typeof extra === 'object'
          ? { prompt: String(prompt || ''), ...extra }
          : String(prompt || '');
        setPendingPrompt(payload);
        setView('create');
        notify('提示词与参数已放回创作台', 'ok');
      }, [notify]);

      const consumePendingPrompt = useCallback(() => setPendingPrompt(''), []);

      const models = snapshot?.config?.models || [];
      const providers = snapshot?.config?.providers || [];
      const ready = models.length > 0 && providers.some((p) => p.hasKey);

      const tabs = [
        { id: 'create', label: '创作', count: 0 },
        { id: 'works', label: '作品', count: images.length },
        { id: 'config', label: '接入点与模型', count: models.length },
      ];

      return h('div', { className: 'ig' },
        h('header', { className: 'ig-top' },
          h('div', { className: 'ig-brand' },
            h('span', { className: 'ig-brand-mark' }, h(PanelIcon, { size: 15 })),
            h('span', { className: 'ig-brand-name' }, '生图工作台')),
          h('nav', { className: 'ig-nav', role: 'tablist', 'aria-label': '生图工作台视图' },
            tabs.map((t) => h('button', {
              key: t.id,
              type: 'button',
              role: 'tab',
              'aria-selected': view === t.id ? 'true' : 'false',
              className: 'ig-nav-btn',
              onClick: () => setView(t.id),
            },
              t.label,
              t.count ? h('span', { className: 'ig-nav-count' }, String(t.count)) : null))),
          h('div', { className: 'ig-top-right' },
            h('span', {
              className: 'ig-status',
              'data-tone': ready ? 'ok' : 'warn',
              title: ready ? '接入点已配置，可以直接出图' : '还没配置可用的模型',
            }, ready ? '接口已配置' : '接口未配置'),
            h('button', {
              type: 'button',
              className: 'ig-btn ig-btn-sm ig-btn-ghost ig-iconbtn',
              title: '重新读取配置与作品',
              'aria-label': '刷新',
              onClick: reload,
            }, h(Ico.refresh, { size: 14 })))),

        error ? h('div', { style: { padding: '10px 30px 0' } }, h(Msg, { text: '读取失败：' + error, tone: 'bad' })) : null,
        !snapshot && !error
          ? h('div', { className: 'ig-view' },
            h('div', { className: 'ig-stage ig-scroll' },
              h('div', { className: 'ig-stage-inner' },
                h('div', { className: 'ig-empty' },
                  h('div', { className: 'ig-empty-title' }, '加载中…'),
                  h('p', { className: 'ig-empty-text' }, '正在读取接入点与作品。')))))
          : null,

        snapshot && view === 'create'
          ? h(CreateView, {
            snapshot,
            images,
            reload,
            notify,
            refQueue,
            consumeRefQueue,
            pendingPrompt,
            consumePendingPrompt,
            openImage,
            onOpenConfig: () => setView('config'),
          })
          : null,
        snapshot && view === 'works'
          ? h(WorksView, { images, reload, notify, openImage, onUseAsRef: useAsRef, onReusePrompt: reusePrompt })
          : null,
        snapshot && view === 'config'
          ? h(ConfigView, { snapshot, reload, notify })
          : null,

        h(ImageModal, {
          image: viewing,
          meta: viewing?.meta || null,
          onClose: () => setViewing(null),
          onReusePrompt: (p) => reusePrompt(p),
          onUseAsRef: useAsRef,
          onDelete: async (name) => {
            try {
              await postJson('/image.delete.json', { name });
              notify('已删除 ' + name, 'ok');
              await reload();
            } catch (e) {
              notify(String((e && e.message) || e), 'bad');
            }
          },
          notify,
        }),

        toast
          ? h('div', { className: 'ig-toast', role: 'status', 'aria-live': 'polite' }, String(toast.text))
          : null);
    }

    /* ================================================================== */
    /* 侧边栏图标                                                          */
    /* ================================================================== */

    function PanelIcon(props) {
      const size = props?.size || 18;
      return h('svg', {
        viewBox: '0 0 20 20',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block' },
      },
        h('rect', { x: 2.6, y: 3.6, width: 14.8, height: 12.8, rx: 2.4 }),
        h('circle', { cx: 7.2, cy: 8.1, r: 1.6 }),
        h('path', { d: 'M3.4 14.2l3.7-3.4 2.8 2.4 3.1-3.2 3.6 3.7' }));
    }

    /** 一个槽位崩溃不该把整列打空。 */
    class Boundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: null };
      }
      static getDerivedStateFromError(failed) {
        return { failed };
      }
      componentDidCatch(error) {
        console.error('[image-gen] slot entry crashed:', error);
      }
      render() {
        if (this.state.failed) {
          return h('div', { className: 'ig' },
            h('div', { className: 'ig-view' },
              h('div', { className: 'ig-stage' },
                h('div', { className: 'ig-stage-inner' },
                  h('div', { className: 'ig-msg', 'data-tone': 'bad', role: 'alert' },
                    '生图面板出错：' + String(this.state.failed?.message || this.state.failed))))));
        }
        return this.props.children;
      }
    }

    /* ================================================================== */
    /* 插件体                                                              */
    /* ================================================================== */

    const name = NS;
    const inject = ['slots'];

    function apply(ctx) {
      ensureStyles(ctx);
      ctx.effect(() => () => {
        if (styleDisposer) {
          try {
            styleDisposer();
          } catch {
            /* ignore */
          }
          styleDisposer = null;
        }
      }, 'image-gen: styles');

      try {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 4, label: () => '生图' },
            (ownerProps) => h(Boundary, null, h(PanelIcon, { size: ownerProps?.size })),
          ));
        console.log('[' + NS + '] sidebar entry registered');
      } catch (e) {
        console.warn('[' + NS + '] sidebar.panellist registration failed:', e);
      }

      try {
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID }, () => h(Boundary, null, h(MainPanel))));
        console.log('[' + NS + '] main panel registered');
      } catch (e) {
        console.warn('[' + NS + '] main panel registration failed:', e);
      }
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
