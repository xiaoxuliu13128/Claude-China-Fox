/**
 * seats/doubao.js — 豆包席位（诚实版）
 *
 * 现状
 *   参考项目把豆包席位标为 `.user_skills/cha-doubao`，但本机验证：
 *   ~/.user_skills 不存在，豆包只有 %LOCALAPPDATA%\Doubao 缓存目录。
 *
 *   而且豆包是字节的封闭客户端：
 *     · 没有公开的插件/skill 目录约定
 *     · 不走 Anthropic / OpenAI 标准协议
 *     · 主程序不在常见安装路径（只有缓存目录）
 *     · 很可能有完整性校验
 *
 * 所以这个席位定位为 detect-only：
 *   能检测、能解释为什么做不了，但**不给假的"一键破甲"按钮**。
 *
 * 如果以后找到可行注入点，再升级成 full。
 */

import path from 'node:path';
import fs from 'node:fs';
import { LOCAL, ROAM, PF, HOME, exists, sizeMB, log } from '../util.js';

const CANDIDATES = [
  path.join(LOCAL, 'Doubao'),
  path.join(ROAM, 'Doubao'),
  path.join(HOME, '.user_skills'),
  path.join(HOME, '.doubao'),
  path.join(PF, 'Doubao'),
  path.join(LOCAL, 'Programs', 'Doubao'),
];

function detect() {
  // 空目录不算安装 —— 本机 %LOCALAPPDATA%\Doubao 就是个残留空壳
  const found = CANDIDATES.filter((p) => {
    if (!exists(p)) return false;
    try {
      const entries = fs.readdirSync(p);
      return entries.length > 0;
    } catch { return false; }
  });

  // 尝试找主程序
  let exe = null;
  for (const p of found) {
    try {
      const hit = fs.readdirSync(p).find((n) => /^Doubao.*\.exe$/i.test(n) || /\.exe$/i.test(n));
      if (hit) { exe = path.join(p, hit); break; }
    } catch {}
  }

  const hasUserSkills = exists(path.join(HOME, '.user_skills'));

  return {
    installed: found.length > 0,
    path: found[0] || null,
    foundPaths: found,
    exe,
    configPath: found[0] || null,
    state: {
      cacheDirs: found.length,
      emptyShell: CANDIDATES.some((p) => exists(p)) && found.length === 0,
      userSkillsDir: hasUserSkills,
      mainExe: exe,
      armored: false,
    },
  };
}

const notSupported = (what) => ({
  preview() {
    return {
      steps: [
        '豆包当前没有可行的本地注入点',
        '',
        '已排查：',
        '  · ~/.user_skills        —— 不存在',
        '  · %LOCALAPPDATA%\\Doubao —— 只有缓存，无主程序',
        '  · 没有公开的插件/skill 目录约定',
        '  · 不走 Anthropic/OpenAI 标准协议',
        '',
        '参考项目 gpt6-Astra 的席位表里写了 `.user_skills/cha-doubao`，',
        '但本机验证该路径不存在 —— 可能是别的版本，或者需要先启动豆包才创建。',
        '',
        `所以「${what}」这个功能暂时不做，避免给你一个点了没反应的按钮。`,
      ],
      supported: false,
      reason: 'no-injection-point',
    };
  },
  apply() {
    return { ok: false, error: '豆包暂无可用的注入点，未实现' };
  },
});

const arms = notSupported('破甲');
const clean = notSupported('清理');
const key = notSupported('配置 Key');

const custom = {
  list() { return { personas: [], supported: false }; },
  apply() { return { ok: false, error: '豆包暂不支持自定义' }; },
};

export default {
  id: 'doubao',
  name: '豆包',
  vendor: '字节跳动',
  tier: 'detect-only',
  inject: [],
  detect,
  actions: { clean, key, armor: arms, custom },
  note: '封闭客户端，本机未找到可用注入点',
};
