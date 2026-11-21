/**
 * seats/dsh.js — DSH Desktop 席位
 *
 * 注入位：cordis 插件系统
 *   %APPDATA%\dsh-desktop\harness\cordis.patch.yml   ← 挂载点
 *   %APPDATA%\dsh-desktop\harness\plugins\*.mjs      ← 插件本体
 *
 * 与 dsh-purge 的关系：互不干扰。本席位用独立插件 id（fox-armor），
 * 独立 section 名，不占用 system-prompt 的 config 槽位。
 *
 * 注意：DSH 的配置根与 CLI 版不同。
 *   CLI 版  $DSH_HOME 默认 ~/.dsh
 *   桌面版  %APPDATA%\dsh-desktop\harness
 */

import path from 'node:path';
import fs from 'node:fs';
import {
  ROAM, LOCAL, PF, HOME, exists, sizeMB, readText, writeText,
  backup, restoreFrom, latestBackup, log, killProcess, wrapMarked, stripMarked, hasMarked,
} from '../util.js';

const HARNESS = path.join(ROAM, 'dsh-desktop', 'harness');
const PATCH   = path.join(HARNESS, 'cordis.patch.yml');
const PLUGINS = path.join(HARNESS, 'plugins');
const PLUGIN_ID = 'fox-armor';
const PLUGIN_FILE = path.join(PLUGINS, `${PLUGIN_ID}.mjs`);

const INSTALL_CANDIDATES = [
  path.join('D:', 'dhs', 'DSH Desktop'),
  path.join(PF, 'DSH Desktop'),
  path.join(LOCAL, 'Programs', 'DSH Desktop'),
];

/** 本仓库自带的插件源码 */
function pluginSourcePath() {
  // workbench/src/lib/seats/dsh.js → 回到仓库根的 plugins/dsh/fox-armor.mjs
  return path.resolve(new URL('../../../../plugins/dsh/fox-armor.mjs', import.meta.url).pathname.replace(/^\//, ''));
}

function detect() {
  const installPath = INSTALL_CANDIDATES.find((p) => exists(p));
  const harnessOk = exists(HARNESS);

  const patchText = readText(PATCH) || '';
  const registered = patchText.includes(PLUGIN_ID);
  // 允许被注释掉的情况
  const enabled = registered && !new RegExp(`#\\s*-\\s*id:\\s*${PLUGIN_ID}`).test(patchText);

  let asar = null;
  if (installPath) {
    const p = path.join(installPath, 'resources', 'app.asar');
    if (exists(p)) asar = { path: p, sizeMB: sizeMB(p) };
  }

  return {
    installed: !!(installPath || harnessOk),
    path: installPath || HARNESS,
    asar,
    configPath: HARNESS,
    state: {
      harnessFound: harnessOk,
      patchFile: exists(PATCH),
      pluginInstalled: exists(PLUGIN_FILE),
      pluginRegistered: registered,
      armored: enabled,
      hasPurge: exists(path.join(HARNESS, 'dsh-purge')),
    },
  };
}

// ── 模块 2：清理 ──────────────────────────────────────
const clean = {
  preview() {
    return {
      steps: [
        '本席位不改 DSH 的联网设置（DSH 桌面版没有等价开关）',
        '仅清缓存：cache / storages 里的临时文件',
        '保留 sessions、profiles、plugins、llm-deepseek 等配置',
        '不删登录态（DSH 用 API Key，删了要重配）',
      ],
      note: 'DSH 桌面版没有 disableNonessential 这类策略键，强行改造会破坏现有会话',
    };
  },
  apply() {
    const dirs = [
      path.join(HARNESS, 'cache'),
    ];
    let cleaned = 0;
    for (const d of dirs) {
      if (!exists(d)) continue;
      try {
        for (const f of fs.readdirSync(d, { withFileTypes: true })) {
          if (f.isFile()) fs.rmSync(path.join(d, f.name), { force: true });
        }
        cleaned++;
      } catch {}
    }
    log('dsh', `clean applied, ${cleaned} dirs`);
    return { ok: true, changed: [`缓存 ${cleaned} 个目录`] };
  },
  restore() { return { ok: true, note: '只清了缓存，无需还原' }; },
};

// ── 模块 3：配置 Key ──────────────────────────────────
const key = {
  preview(opts = {}) {
    return {
      steps: [
        'DSH 的模型配置在 llm-deepseek 目录与 profiles 里',
        '本席位暂不自动改写（会破坏现有 profile 结构）',
        '建议在 DSH 设置界面里换 Key',
      ],
      manual: true,
      configPath: path.join(HARNESS, 'llm-deepseek'),
    };
  },
  apply() {
    return { ok: false, error: 'DSH 的 Key 需在应用内设置，不提供自动写入' };
  },
};

// ── 模块 4：一键破甲（插件注入）──────────────────────
const armor = {
  preview(opts = {}) {
    return {
      steps: [
        `复制插件到 ${PLUGIN_FILE}`,
        `在 cordis.patch.yml 追加 insert 记录（id=${PLUGIN_ID}）`,
        '备份原 cordis.patch.yml',
        '重启 DSH 生效',
      ],
      plugin: PLUGIN_FILE,
      patch: PATCH,
      persona: opts.persona || '',
      note: '与 dsh-purge 并存，不抢 system-prompt 的 config 槽位',
    };
  },

  apply(opts = {}) {
    if (!exists(HARNESS)) return { ok: false, error: `找不到 DSH 配置根: ${HARNESS}` };

    fs.mkdirSync(PLUGINS, { recursive: true });

    // 1) 插件本体
    const src = pluginSourcePath();
    if (exists(src)) {
      fs.copyFileSync(src, PLUGIN_FILE);
    } else if (!exists(PLUGIN_FILE)) {
      return { ok: false, error: `找不到插件源: ${src}` };
    }

    // 2) cordis.patch.yml
    const bk = backup('dsh', 'armor', [{ kind: 'file', path: PATCH }]);
    let text = readText(PATCH) || '';

    if (hasMarked(text, PLUGIN_ID)) {
      // 已经被本工具装过，替换标记段
      text = stripMarked(text, PLUGIN_ID);
    }

    const personaPath = (opts.persona || path.resolve('personas/default.md')).replace(/\\/g, '/');
    const fileUrl = 'file:///' + PLUGIN_FILE.replace(/\\/g, '/');
    const block =
      `- insert:\n` +
      `    - id: ${PLUGIN_ID}\n` +
      `      name: "${fileUrl}"\n` +
      `      config:\n` +
      `        persona: "${personaPath}"\n` +
      `        order: 900\n` +
      `        disable: false\n`;

    writeText(PATCH, text.replace(/\s+$/, '') + '\n\n' + wrapMarked(PLUGIN_ID, block));

    log('dsh', `armor applied, persona=${personaPath}, backup=${bk.id}`);
    return {
      ok: true,
      installed: [PLUGIN_FILE, PATCH],
      persona: personaPath,
      backup: bk.id,
      needRestart: true,
    };
  },

  restore() {
    const bk = latestBackup('dsh', 'armor');
    if (!bk) {
      // 没有备份时，退化为只摘掉标记段
      const text = readText(PATCH) || '';
      if (hasMarked(text, PLUGIN_ID)) {
        writeText(PATCH, stripMarked(text, PLUGIN_ID));
        return { ok: true, note: '已移除插入段（无备份可还原原文件）', needRestart: true };
      }
      return { ok: false, error: '没有备份记录，也没有插入段' };
    }
    restoreFrom(bk.manifestPath);
    log('dsh', `armor restored from ${bk.id}`);
    return { ok: true, restored: bk.id, needRestart: true };
  },
};

const custom = {
  list() { return { personas: [], note: '人格由 workbench/personas 管理' }; },
  apply(opts = {}) {
    if (!opts.persona) return { ok: false, error: '缺 persona 路径' };
    // 改插件的 persona 指向
    const text = readText(PATCH) || '';
    if (!hasMarked(text, PLUGIN_ID)) return { ok: false, error: '插件未安装，先跑 armor.apply' };
    const updated = text.replace(
      new RegExp(`(id: ${PLUGIN_ID}[\\s\\S]*?persona:\\s*")[^"]*(")`),
      `$1${opts.persona.replace(/\\/g, '/')}$2`
    );
    writeText(PATCH, updated);
    return { ok: true, persona: opts.persona, needRestart: true };
  },
};

export default {
  id: 'dsh',
  name: 'DSH Desktop',
  vendor: 'DeepSeek',
  tier: 'full',
  inject: ['cordis-plugin'],
  detect,
  actions: { clean, key, armor, custom },
  harnessRoot: HARNESS,
  pluginPath: PLUGIN_FILE,
};
