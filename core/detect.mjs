#!/usr/bin/env node
/**
 * detect.mjs — 自动检测本机装了哪些 AI 客户端，并判断可用的注入方式
 *
 * 输出 JSON，供 UI 或后续脚本消费。
 *
 * 用法：
 *   node core/detect.mjs          打印人类可读报告
 *   node core/detect.mjs --json   输出 JSON
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

const HOME = os.homedir();
const LOCAL = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const ROAM  = process.env.APPDATA      || path.join(HOME, 'AppData', 'Roaming');
const PF    = process.env.ProgramFiles || 'C:\\Program Files';
const PF86  = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const sizeMB = (p) => { try { return Math.round(fs.statSync(p).size / 1048576 * 10) / 10; } catch { return 0; } };

/**
 * 每个客户端定义：
 *   paths    候选安装目录
 *   marks    识别特征文件（相对路径）
 *   kind     技术栈
 *   inject   可用的注入方式（按优先级）
 */
const CATALOG = [
  {
    id: 'claude',
    name: 'Claude Desktop',
    vendor: 'Anthropic',
    kind: 'electron',
    paths: [path.join(LOCAL, 'AnthropicClaude')],
    marks: ['claude.exe'],
    inject: ['gateway-proxy'],   // 已实测：注册表 3P + 代理改 system
    notes: '注册表托管策略 + HTTP 代理注入，官方更新不影响',
    // 检测是否已配置
    check: () => {
      try {
        const r = execSync(
          'reg query "HKCU\\SOFTWARE\\Policies\\Claude" /v inferenceGatewayBaseUrl',
          { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }
        );
        const m = r.match(/inferenceGatewayBaseUrl\s+REG_SZ\s+(\S+)/);
        return m ? { configured: true, gateway: m[1] } : { configured: false };
      } catch { return { configured: false }; }
    },
  },
  {
    id: 'dsh',
    name: 'DSH Desktop',
    vendor: 'DeepSeek',
    kind: 'electron',
    paths: [
      path.join('D:', 'dhs', 'DSH Desktop'),
      path.join(PF, 'DSH Desktop'),
      path.join(LOCAL, 'Programs', 'DSH Desktop'),
    ],
    marks: ['resources', 'locales'],
    inject: ['plugin'],          // Cordis 插件系统（dsh-purge 走这条路）
    notes: '插件式（cordis.patch.yml），需要写插件包，不能靠代理',
    check: () => {
      const cfg = path.join(ROAM, 'dsh-desktop', 'harness');
      const inject = path.join(cfg, 'prompt-inject.md');
      const plugins = path.join(cfg, 'plugins');
      return {
        configured: exists(inject),
        promptInject: exists(inject) ? sizeMB(inject) + 'KB' : null,
        pluginsDir: exists(plugins),
      };
    },
  },
  {
    id: 'workbuddy',
    name: 'WorkBuddy',
    vendor: '腾讯',
    kind: 'electron',
    paths: [
      path.join('D:', 'Program Files', 'wb', 'WorkBuddy'),
      path.join(PF, 'wb', 'WorkBuddy'),
      path.join(LOCAL, 'Programs', 'WorkBuddy'),
    ],
    marks: ['resources'],
    inject: ['asar-patch', 'plugin'],   // 待确认
    notes: 'Electron，注入方式待摸清（asar 改写 / 内置插件 / 代理）',
    check: () => ({ configured: false }),
  },
  {
    id: 'doubao',
    name: '豆包',
    vendor: '字节跳动',
    kind: 'unknown',
    paths: [
      path.join(LOCAL, 'Doubao'),
      path.join(PF, 'Doubao'),
      path.join(LOCAL, 'Programs', 'Doubao'),
    ],
    marks: [],
    inject: [],                  // 封闭客户端，可能无解
    notes: '本地只有缓存目录，主程序位置待确认',
    check: () => ({ configured: false }),
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    vendor: 'OpenAI',
    kind: 'cli',
    paths: [
      path.join(ROAM, 'npm', 'node_modules', '@openai', 'codex'),
      path.join(HOME, '.codex'),
    ],
    marks: ['.codex'],
    inject: ['config-file'],     // config.toml + AGENTS.md
    notes: 'CLI，改 ~/.codex/config.toml 的 model_provider 即可',
    check: () => ({
      configured: exists(path.join(HOME, '.codex', 'config.toml')),
      configPath: path.join(HOME, '.codex', 'config.toml'),
    }),
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    vendor: 'Google',
    kind: 'cli',
    paths: [
      path.join(ROAM, 'npm', 'node_modules', '@google', 'gemini-cli'),
      path.join(HOME, '.gemini'),
    ],
    marks: ['.gemini'],
    inject: ['config-file'],
    notes: 'CLI，改 ~/.gemini/settings.json 的 baseUrl',
    check: () => ({
      configured: exists(path.join(HOME, '.gemini', 'settings.json')),
      configPath: path.join(HOME, '.gemini', 'settings.json'),
    }),
  },
];

function detect() {
  return CATALOG.map((c) => {
    const found = c.paths.find((p) => exists(p));
    if (!found) return { id: c.id, name: c.name, vendor: c.vendor, installed: false };

    // 找主程序 / 版本
    let version = null, exe = null, asar = null;
    try {
      const top = fs.readdirSync(found);
      for (const f of top) {
        if (/^app-[\d.]+$/.test(f)) {
          const sub = path.join(found, f, 'claude.exe');
          if (exists(sub)) { exe = sub; version = f.replace('app-', ''); }
        }
      }
      if (!exe) for (const f of top) if (f.endsWith('.exe')) exe = path.join(found, f);
      const asarPath = path.join(found, 'resources', 'app.asar');
      if (exists(asarPath)) asar = { path: asarPath, sizeMB: sizeMB(asarPath) };
    } catch {}

    let check = {};
    try { check = c.check ? c.check() : {}; } catch {}

    return {
      id: c.id,
      name: c.name,
      vendor: c.vendor,
      installed: true,
      path: found,
      version,
      exe,
      asar,
      kind: c.kind,
      inject: c.inject,
      notes: c.notes,
      state: check,
    };
  });
}

const result = detect();

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log('');
  console.log('  AI 客户端检测');
  console.log('  ────────────────────────────────────────────');
  for (const c of result) {
    if (c.installed) {
      console.log(`  ✓ ${c.name.padEnd(18)} ${c.vendor}`);
      console.log(`      路径   ${c.path}`);
      if (c.version) console.log(`      版本   ${c.version}`);
      if (c.asar) console.log(`      asar   ${c.asar.sizeMB} MB`);
      console.log(`      注入   ${c.inject.length ? c.inject.join(' → ') : '（无可用方式）'}`);
      const st = c.state || {};
      if (st.configured) console.log(`      状态   ✓ 已配置 ${st.gateway ? '→ ' + st.gateway : ''}`);
      else console.log(`      状态   ○ 未配置`);
      if (c.notes) console.log(`      说明   ${c.notes}`);
    } else {
      console.log(`  ○ ${c.name.padEnd(18)} 未安装`);
    }
    console.log('');
  }
  const n = result.filter((c) => c.installed).length;
  console.log(`  检测到 ${n} / ${result.length} 个客户端`);
  console.log('');
}
