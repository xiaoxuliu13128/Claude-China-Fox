/**
 * seats/gemini.js — Gemini CLI 席位
 *
 * 注入位：
 *   ~/.gemini/GEMINI.md              常驻指令
 *   ~/.gemini/settings.json          context.fileName 指向上面那个 md
 *
 * 本机未安装，代码按标准结构写。
 */

import path from 'node:path';
import fs from 'node:fs';
import {
  HOME, ROAM, exists, readText, writeText, readJson, writeJson,
  backup, restoreFrom, latestBackup, log, wrapMarked, stripMarked, hasMarked,
} from '../util.js';

const GEMINI_DIR = path.join(HOME, '.gemini');
const SETTINGS   = path.join(GEMINI_DIR, 'settings.json');
const GEMINI_MD  = path.join(GEMINI_DIR, 'GEMINI.md');
const TAG        = 'GEMINI';

const INSTALL_CANDIDATES = [
  path.join(ROAM, 'npm', 'node_modules', '@google', 'gemini-cli'),
  GEMINI_DIR,
];

function detect() {
  const installPath = INSTALL_CANDIDATES.find((p) => exists(p));
  const hasDir = exists(GEMINI_DIR);
  const settings = readJson(SETTINGS);

  return {
    installed: !!(installPath || hasDir),
    path: installPath || GEMINI_DIR,
    configPath: GEMINI_DIR,
    state: {
      settingsJson: exists(SETTINGS),
      geminiMd: exists(GEMINI_MD),
      contextFileName: settings?.context?.fileName || null,
      armored: exists(GEMINI_MD) && hasMarked(readText(GEMINI_MD) || '', TAG),
    },
  };
}

const clean = {
  preview() {
    return {
      steps: ['Gemini CLI 纯本地，清理 ~/.gemini/log 与 tmp（如存在）'],
      note: 'CLI 类工具不需要断网处理',
    };
  },
  apply() {
    const dirs = [path.join(GEMINI_DIR, 'log'), path.join(GEMINI_DIR, 'tmp')];
    let n = 0;
    for (const d of dirs) {
      if (!exists(d)) continue;
      try {
        for (const f of fs.readdirSync(d, { withFileTypes: true })) {
          if (f.isFile()) fs.rmSync(path.join(d, f.name), { force: true });
        }
        n++;
      } catch {}
    }
    return { ok: true, changed: [`清理 ${n} 个目录`] };
  },
  restore() { return { ok: true }; },
};

const key = {
  preview() {
    return {
      steps: [
        'Gemini CLI 读环境变量 GEMINI_API_KEY 或 ~/.gemini/.env',
        '第三方端点通过 settings.json 的 baseUrl 配置',
        '本席位不自动写 key（避免覆盖已有配置）',
      ],
      manual: true,
      configPath: SETTINGS,
    };
  },
  apply() {
    return { ok: false, error: 'Gemini 的 key 请用环境变量或在应用内设置' };
  },
};

const armor = {
  preview(opts = {}) {
    return {
      steps: [
        `写入 ${GEMINI_MD}（带标记包裹）`,
        `改写 ${SETTINGS} 的 context.fileName 指向 GEMINI.md`,
      ],
      md: GEMINI_MD,
      settings: SETTINGS,
      persona: opts.persona || '',
    };
  },

  apply(opts = {}) {
    if (!opts.persona) return { ok: false, error: '缺 persona 路径' };
    const personaText = readText(opts.persona);
    if (!personaText) return { ok: false, error: `读不到 ${opts.persona}` };

    fs.mkdirSync(GEMINI_DIR, { recursive: true });
    const bk = backup('gemini', 'armor', [
      { kind: 'file', path: SETTINGS },
      { kind: 'file', path: GEMINI_MD },
    ]);

    // 1) GEMINI.md
    let md = readText(GEMINI_MD) || '';
    if (hasMarked(md, TAG)) md = stripMarked(md, TAG);
    writeText(GEMINI_MD, md.replace(/\s+$/, '') + (md.trim() ? '\n\n' : '') + wrapMarked(TAG, personaText));

    // 2) settings.json
    const settings = readJson(SETTINGS) || {};
    settings.context = settings.context || {};
    settings.context.fileName = 'GEMINI.md';
    writeJson(SETTINGS, settings);

    log('gemini', `armor applied, backup=${bk.id}`);
    return { ok: true, installed: [GEMINI_MD, SETTINGS], backup: bk.id, needRestart: false };
  },

  restore() {
    const bk = latestBackup('gemini', 'armor');
    if (bk) { restoreFrom(bk.manifestPath); return { ok: true, restored: bk.id }; }
    const md = readText(GEMINI_MD);
    if (md && hasMarked(md, TAG)) {
      writeText(GEMINI_MD, stripMarked(md, TAG));
      return { ok: true, note: '已移除标记段' };
    }
    return { ok: false, error: '没有安装记录' };
  },
};

const custom = {
  list() { return { personas: [] }; },
  apply(opts = {}) { return armor.apply(opts); },
};

export default {
  id: 'gemini',
  name: 'Gemini CLI',
  vendor: 'Google',
  tier: 'partial',
  inject: ['config-file'],
  detect,
  actions: { clean, key, armor, custom },
  geminiDir: GEMINI_DIR,
};
