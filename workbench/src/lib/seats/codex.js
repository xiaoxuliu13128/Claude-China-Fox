/**
 * seats/codex.js — Codex CLI 席位
 *
 * 注入位（参考公开资料 + coldbrew 席位表）：
 *   ~/.codex/config.toml        model_instructions_file 指向一个 md
 *   ~/.codex/AGENTS.md          常驻指令
 *   ~/.codex/prompts/*.md       可调用的提示词
 *
 * 本机未安装，代码按标准结构写，装上后即可用。
 */

import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import {
  HOME, ROAM, exists, readText, writeText,
  backup, restoreFrom, latestBackup, log, wrapMarked, stripMarked, hasMarked,
} from '../util.js';

const CODEX_DIR = path.join(HOME, '.codex');
const CONFIG    = path.join(CODEX_DIR, 'config.toml');
const AGENTS    = path.join(CODEX_DIR, 'AGENTS.md');
const PROMPTS   = path.join(CODEX_DIR, 'prompts');
const PACK_MD   = path.join(CODEX_DIR, 'prompts', 'fox-codex.md');
const TAG       = 'CODE';

const INSTALL_CANDIDATES = [
  path.join(ROAM, 'npm', 'node_modules', '@openai', 'codex'),
  CODEX_DIR,
];

function detect() {
  const installPath = INSTALL_CANDIDATES.find((p) => exists(p));
  const hasDir = exists(CODEX_DIR);

  let cli = null;
  try {
    cli = execSync('codex --version', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {}

  return {
    installed: !!(installPath || hasDir),
    path: installPath || CODEX_DIR,
    configPath: CODEX_DIR,
    state: {
      configToml: exists(CONFIG),
      agentsMd: exists(AGENTS),
      promptsDir: exists(PROMPTS),
      packInstalled: exists(PACK_MD),
      armored: exists(PACK_MD) && hasMarked(readText(CONFIG) || '', TAG),
      cli,
    },
  };
}

const clean = {
  preview() {
    return {
      steps: [
        'Codex CLI 是纯本地工具，没有后台联网行为',
        '清理 ~/.codex/log 与 ~/.codex/cache（如存在）',
        '不删 config.toml、auth.json、sessions',
      ],
      note: 'CLI 类工具不需要断网处理',
    };
  },
  apply() {
    const dirs = [path.join(CODEX_DIR, 'log'), path.join(CODEX_DIR, 'cache')];
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
  preview(opts = {}) {
    return {
      steps: [
        'Codex 的凭据在 ~/.codex/auth.json（由 codex login 生成）',
        '第三方端点通过 config.toml 的 model_provider 配置：',
        '  [model_providers.xxx]  base_url / env_key',
        '本席位不自动改写 auth.json（格式随版本变化）',
      ],
      manual: true,
      configPath: CONFIG,
    };
  },
  apply() {
    return { ok: false, error: 'Codex 的凭据请用 codex login 或手动编辑 config.toml' };
  },
};

const armor = {
  preview(opts = {}) {
    return {
      steps: [
        `写入 ${PACK_MD}（人格正文）`,
        `在 ${CONFIG} 追加 model_instructions_file 指向该文件`,
        `在 ${AGENTS} 追加带标记的短入口`,
      ],
      pack: PACK_MD,
      config: CONFIG,
      agents: AGENTS,
      persona: opts.persona || '',
    };
  },

  apply(opts = {}) {
    if (!opts.persona) return { ok: false, error: '缺 persona 路径' };
    const personaText = readText(opts.persona);
    if (!personaText) return { ok: false, error: `读不到 ${opts.persona}` };

    fs.mkdirSync(PROMPTS, { recursive: true });
    const bk = backup('codex', 'armor', [
      { kind: 'file', path: CONFIG },
      { kind: 'file', path: AGENTS },
      { kind: 'file', path: PACK_MD },
    ]);

    // 1) 提示词包
    writeText(PACK_MD, wrapMarked(TAG, personaText));

    // 2) config.toml 追加一行（TOML 里用注释标记方便回滚）
    let cfg = readText(CONFIG) || '';
    if (hasMarked(cfg, TAG)) cfg = stripMarked(cfg, TAG);
    const line = `model_instructions_file = "${PACK_MD.replace(/\\/g, '/')}"`;
    cfg = cfg.replace(/\s+$/, '') + '\n\n' + wrapMarked(TAG, line);
    writeText(CONFIG, cfg);

    // 3) AGENTS.md 短入口
    let ag = readText(AGENTS) || '';
    if (hasMarked(ag, TAG)) ag = stripMarked(ag, TAG);
    ag = ag.replace(/\s+$/, '') + '\n\n' + wrapMarked(TAG, '详细执行规范见 prompts/fox-codex.md。');
    writeText(AGENTS, ag);

    log('codex', `armor applied, backup=${bk.id}`);
    return { ok: true, installed: [PACK_MD, CONFIG, AGENTS], backup: bk.id, needRestart: false };
  },

  restore() {
    const bk = latestBackup('codex', 'armor');
    if (!bk) return { ok: false, error: '没有备份记录' };
    restoreFrom(bk.manifestPath);
    // 兜底：如果备份里没有原文件，至少摘掉标记段
    for (const [p, tag] of [[CONFIG, TAG], [AGENTS, TAG]]) {
      const t = readText(p);
      if (t && hasMarked(t, tag)) writeText(p, stripMarked(t, tag));
    }
    try { if (exists(PACK_MD)) fs.rmSync(PACK_MD, { force: true }); } catch {}
    return { ok: true, restored: bk.id };
  },
};

const custom = {
  list() { return { personas: [] }; },
  apply(opts = {}) { return armor.apply(opts); },
};

export default {
  id: 'codex',
  name: 'Codex CLI',
  vendor: 'OpenAI',
  tier: 'partial',
  inject: ['config-file'],
  detect,
  actions: { clean, key, armor, custom },
  codexDir: CODEX_DIR,
};
