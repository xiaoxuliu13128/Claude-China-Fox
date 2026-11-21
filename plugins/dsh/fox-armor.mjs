/**
 * fox-armor — DSH 破甲插件（注入层）
 *
 * 干什么
 *   把 personas/default.md 的内容作为一个常驻 section 追加进系统提示。
 *   不改宿主的任何文件，不动 dsh-purge，不占用 system-prompt 的 config 槽位。
 *
 * 怎么启用
 *   在 %APPDATA%\dsh-desktop\harness\cordis.patch.yml 里加：
 *
 *     - insert:
 *         - id: fox-armor
 *           name: "file:///C:/Users/Administrator/AppData/Roaming/dsh-desktop/harness/plugins/fox-armor.mjs"
 *           config:
 *             persona: "D:/破解/gh-publish/personas/default.md"
 *             order: 900
 *             disable: false
 *
 *   然后重启 DSH。
 *
 * 怎么停
 *   把 disable 改成 true，或把上面那段从 cordis.patch.yml 删掉。
 *
 * 设计说明
 *   - 用 prompt.section() 而不是 ctx.on('system-prompt/assemble')，因为 section
 *     是插件生态的常规做法，别的破甲插件想接管 assemble 时不会冲突。
 *   - 人格文件每次请求时读，改 md 不用重启。
 *   - 读不到文件就静默跳过，不让它把启动搞挂。
 */

import fs from 'node:fs';

export const name = 'fox-armor';

// 只声明用到的服务。cordis 会按 inject 在 ctx 上挂服务代理
export const inject = ['systemPrompt'];

const SECTION_NAME = 'fox-armor';
const DEFAULT_ORDER = 900;

/** 兼容不同 cordis 版本：服务代理有时在 ctx 上，有时要经 ctx.inject 拿 */
function getService(ctx, svcName) {
  try {
    if (ctx?.[svcName]) return ctx[svcName];
  } catch { /* 代理访问可能抛错 */ }
  try {
    if (typeof ctx?.inject === 'function') {
      let got = null;
      ctx.inject([svcName], (s) => { got = s; });
      if (got) return got;
    }
  } catch { /* 同上 */ }
  return null;
}

function readPersona(file) {
  try {
    if (!file) return '';
    return fs.readFileSync(file, 'utf8').trim();
  } catch (e) {
    return '';
  }
}

export function apply(ctx, config = {}) {
  const cfg = {
    persona: config.persona || '',
    order: Number.isFinite(config.order) ? config.order : DEFAULT_ORDER,
    disable: config.disable === true,
    label: config.label || SECTION_NAME,
  };

  if (cfg.disable) {
    ctx.logger?.info?.('fox-armor: disabled by config');
    return;
  }
  if (!cfg.persona) {
    ctx.logger?.warn?.('fox-armor: no persona path configured, skipped');
    return;
  }

  const prompt = getService(ctx, 'systemPrompt');
  if (!prompt || typeof prompt.section !== 'function') {
    ctx.logger?.warn?.('fox-armor: systemPrompt.section unavailable, skipped');
    return;
  }

  // 启动时校验一次，方便排错
  const initial = readPersona(cfg.persona);
  if (initial) {
    ctx.logger?.info?.(`fox-armor: persona loaded ${initial.length} chars from ${cfg.persona}`);
  } else {
    ctx.logger?.warn?.(`fox-armor: persona file unreadable at startup: ${cfg.persona}`);
  }

  // text 传函数 → 每次组装时现读，改 md 不用重启
  ctx.effect(() =>
    prompt.section({
      name: cfg.label,
      order: cfg.order,
      text: () => {
        const body = readPersona(cfg.persona);
        return body || '';
      },
    })
  );

  ctx.logger?.info?.(`fox-armor: section "${cfg.label}" registered at order ${cfg.order}`);
}

export default { name, inject, apply };
