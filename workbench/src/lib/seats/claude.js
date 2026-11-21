/**
 * seats/claude.js — Claude Desktop 席位
 *
 * 注入位：注册表托管策略（HKCU\SOFTWARE\Policies\Claude）+ HTTP 代理
 * 特点：不改程序目录，官方自动更新冲不掉
 *
 * 已验证：
 *   - deploymentMode=3p 让登录页消失，界面显示 "No claude.ai account needed"
 *   - inferenceGatewayBaseUrl 指向代理后，每轮请求的 system 被替换
 *   - safeguards 等私有字段必须删掉，否则上游 400
 */

import path from 'node:path';
import fs from 'node:fs';
import {
  LOCAL, ROAM, HOME, exists, sizeMB, findFirst,
  regSet, regGet, regDel, regKeyExists,
  backup, restoreFrom, latestBackup, wrapMarked, stripMarked, hasMarked,
  log, killProcess,
} from '../util.js';

const POLICY = 'SOFTWARE\\Policies\\Claude';
const INSTALL = path.join(LOCAL, 'AnthropicClaude');

const PROVIDERS = {
  deepseek:  { url: 'https://api.deepseek.com/anthropic',     label: 'DeepSeek',
               models: '[{"name":"claude-opus-5-5","labelOverride":"DeepSeek V4 Pro"},{"name":"claude-sonnet-5","labelOverride":"DeepSeek Flash"}]' },
  glm:       { url: 'https://open.bigmodel.cn/api/anthropic', label: '智谱 GLM',
               models: '[{"name":"claude-opus-5-5","labelOverride":"GLM-5.3"},{"name":"claude-sonnet-5","labelOverride":"GLM-5.3-Flash"}]' },
  kimi:      { url: 'https://api.moonshot.ai/anthropic',      label: 'Kimi',
               models: '[{"name":"claude-opus-5-5","labelOverride":"Kimi K3"},{"name":"claude-sonnet-5","labelOverride":"Kimi Flash"}]' },
  anthropic: { url: 'https://api.anthropic.com',              label: 'Anthropic 官方', models: '' },
};

function detect() {
  if (!exists(INSTALL)) return { installed: false };

  let version = null, exe = null;
  try {
    const apps = fs.readdirSync(INSTALL).filter((n) => /^app-[\d.]+$/.test(n));
    if (apps.length) {
      // 取版本号最大的
      apps.sort((a, b) => {
        const pa = a.replace('app-', '').split('.').map(Number);
        const pb = b.replace('app-', '').split('.').map(Number);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
          if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
        }
        return 0;
      });
      version = apps[0].replace('app-', '');
      exe = path.join(INSTALL, apps[0], 'claude.exe');
    }
  } catch {}

  const gateway = regGet(POLICY, 'inferenceGatewayBaseUrl');
  const mode = regGet(POLICY, 'deploymentMode');
  const asarPath = path.join(INSTALL, 'resources', 'app.asar');

  return {
    installed: true,
    version,
    exe: exe || path.join(INSTALL, 'claude.exe'),
    path: INSTALL,
    asar: exists(asarPath) ? { path: asarPath, sizeMB: sizeMB(asarPath) } : null,
    state: {
      configured: !!gateway,
      gateway,
      deploymentMode: mode,
      armored: !!(gateway && gateway.includes('127.0.0.1')),
    },
  };
}

// ── 模块 2：清理联网与登录 ────────────────────────────
const clean = {
  preview() {
    return {
      steps: [
        '备份当前注册表策略',
        '写入：disableNonessentialServices=true（关特性拉取/变更日志）',
        '写入：disableNonessentialTelemetry=true（关遥测）',
        '写入：skipWebFetchPreflight=true（WebFetch 不回连 anthropic）',
        '关闭 Claude 进程',
        '清理 Cache / Code Cache / Local Storage / Session Storage / Network',
        '（不删登录凭据本体，避免误伤其他账号）',
      ],
      note: '不改 hosts，避免影响其他程序访问 anthropic 域名',
    };
  },

  apply() {
    const bk = backup('claude', 'clean', [
      { kind: 'reg', subKey: POLICY, name: 'disableNonessentialServices' },
      { kind: 'reg', subKey: POLICY, name: 'disableNonessentialTelemetry' },
      { kind: 'reg', subKey: POLICY, name: 'skipWebFetchPreflight' },
    ]);

    regSet(POLICY, 'disableNonessentialServices', 'true');
    regSet(POLICY, 'disableNonessentialTelemetry', 'true');
    regSet(POLICY, 'skipWebFetchPreflight', 'true');

    killProcess(['claude.exe']);

    const dirs = [
      path.join(ROAM, 'Claude', 'Cache'),
      path.join(ROAM, 'Claude', 'Code Cache'),
      path.join(ROAM, 'Claude', 'Local Storage'),
      path.join(ROAM, 'Claude', 'Session Storage'),
      path.join(ROAM, 'Claude', 'Network'),
      path.join(LOCAL, 'Claude-3p', 'Network'),
      path.join(LOCAL, 'Claude-3p', 'Session Storage'),
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

    log('claude', `clean applied, ${cleaned} dirs cleaned, backup=${bk.id}`);
    return { ok: true, changed: ['策略 3 项', `缓存 ${cleaned} 个目录`], backup: bk.id };
  },

  restore() {
    const bk = latestBackup('claude', 'clean');
    if (!bk) return { ok: false, error: '没有 clean 的备份记录' };
    const r = restoreFrom(bk.manifestPath);
    log('claude', `clean restored from ${bk.id}`);
    return r;
  },
};

// ── 模块 3：配置 Key ──────────────────────────────────
const key = {
  preview(opts = {}) {
    const p = PROVIDERS[opts.provider] || PROVIDERS.deepseek;
    return {
      steps: [
        `供应商：${p.label}`,
        `端点：${p.url}`,
        `写入：inferenceProvider=gateway`,
        `写入：inferenceGatewayBaseUrl=${p.url}`,
        `写入：inferenceGatewayApiKey=<你的 key>`,
        `写入：deploymentMode=3p（去掉 claude.ai 登录入口）`,
        p.models ? `写入：inferenceModels（2 个模型映射）` : '（官方端点无需指定模型列表）',
        '重启 Claude Desktop',
      ],
      target: POLICY,
      provider: opts.provider || 'deepseek',
      url: p.url,
    };
  },

  apply(opts = {}) {
    const provider = opts.provider || 'deepseek';
    const p = PROVIDERS[provider];
    if (!p) return { ok: false, error: `未知供应商: ${provider}` };
    if (!opts.key) return { ok: false, error: '缺 API Key' };
    const url = opts.baseUrl || p.url;

    const bk = backup('claude', 'key', [
      { kind: 'reg', subKey: POLICY, name: 'inferenceProvider' },
      { kind: 'reg', subKey: POLICY, name: 'inferenceGatewayBaseUrl' },
      { kind: 'reg', subKey: POLICY, name: 'inferenceGatewayApiKey' },
      { kind: 'reg', subKey: POLICY, name: 'deploymentMode' },
      { kind: 'reg', subKey: POLICY, name: 'inferenceModels' },
    ]);

    const writes = [
      ['inferenceProvider', 'gateway'],
      ['inferenceGatewayBaseUrl', url],
      ['inferenceGatewayApiKey', opts.key],
      ['inferenceGatewayAuthScheme', 'bearer'],
      ['deploymentMode', '3p'],
      ['disableNonessentialServices', 'true'],
      ['disableNonessentialTelemetry', 'true'],
      ['skipWebFetchPreflight', 'true'],
      ['inferenceGatewayAutoModeServerChecks', 'false'],
      ['autoModeEnabled', 'true'],
    ];
    if (p.models) writes.push(['inferenceModels', p.models]);

    for (const [k, v] of writes) regSet(POLICY, k, v);

    log('claude', `key applied provider=${provider} url=${url} backup=${bk.id}`);
    return { ok: true, written: writes.map(([k]) => k), url, backup: bk.id };
  },
};

// ── 模块 4：一键破甲 ──────────────────────────────────
const armor = {
  preview(opts = {}) {
    const port = opts.port || 8790;
    return {
      steps: [
        `网关指向本地代理 http://127.0.0.1:${port}`,
        '代理启动时读人格文件，每轮请求替换 system 字段',
        '人格文件改动实时生效（代理每秒检查）',
        '不改 app.asar / claude.exe，官方更新不影响',
      ],
      persona: opts.persona || '',
      port,
      gateway: `http://127.0.0.1:${port}`,
    };
  },

  apply(opts = {}) {
    const port = opts.port || 8790;
    const bk = backup('claude', 'armor', [
      { kind: 'reg', subKey: POLICY, name: 'inferenceGatewayBaseUrl' },
    ]);
    regSet(POLICY, 'inferenceGatewayBaseUrl', `http://127.0.0.1:${port}`);
    log('claude', `armor applied -> 127.0.0.1:${port}, backup=${bk.id}`);
    return { ok: true, gateway: `http://127.0.0.1:${port}`, backup: bk.id };
  },

  restore(opts = {}) {
    const provider = opts.provider || 'deepseek';
    const p = PROVIDERS[provider];
    regSet(POLICY, 'inferenceGatewayBaseUrl', p.url);
    log('claude', `armor restored -> ${p.url}`);
    return { ok: true, gateway: p.url };
  },
};

// ── 模块 5：私有化定制 ────────────────────────────────
const custom = {
  list() {
    return {
      personas: [],   // 由上层注入，这里只声明能力
      note: '人格文件由 workbench/personas 管理',
    };
  },
  apply(opts = {}) {
    if (!opts.persona) return { ok: false, error: '缺 persona 路径' };
    // Claude 这边人格走代理，不落盘到客户端，所以这里只确认代理能读到
    log('claude', `custom persona -> ${opts.persona}`);
    return { ok: true, persona: opts.persona, via: 'proxy' };
  },
};

export default {
  id: 'claude',
  name: 'Claude Desktop',
  vendor: 'Anthropic',
  tier: 'full',
  inject: ['registry-policy', 'gateway-proxy'],
  detect,
  actions: { clean, key, armor, custom },
  providers: PROVIDERS,
  policyKey: POLICY,
};
