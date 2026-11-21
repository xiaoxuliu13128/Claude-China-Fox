#!/usr/bin/env node
/**
 * server.mjs — Fox 控制台本地服务
 *
 * 提供 REST API 给 UI 用。启动后在浏览器打开 http://127.0.0.1:8791
 *
 * 职责：
 *   GET  /api/detect          检测所有客户端状态
 *   POST /api/proxy/start     启动注入代理
 *   POST /api/proxy/stop      停止代理
 *   GET  /api/proxy/status    代理状态
 *   POST /api/claude/key      配置 Claude 的 key
 *   POST /api/claude/armor    启用/停用 Claude 破甲
 *   POST /api/persona/apply   应用人格文件
 *   GET  /api/persona/list    列人格
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 8791;
const PROXY_PORT = 8790;

const json = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};

// ── 人格管理 ────────────────────────────────────────────
function listPersonas() {
  const out = [];
  for (const dir of [path.join(ROOT, 'personas'), path.join(ROOT, 'personas', 'custom')]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      const full = path.join(dir, f);
      const text = fs.readFileSync(full, 'utf8');
      out.push({
        name: f.replace(/\.md$/, ''),
        dir: path.basename(dir),
        size: text.length,
        path: full,
        isDefault: f === 'default.md',
      });
    }
  }
  return out;
}

// ── 代理管理 ────────────────────────────────────────────
let proxyProc = null;

function proxyRunning() {
  try {
    const out = execSync('netstat -ano -p TCP', { encoding: 'utf8' });
    return out.includes(`127.0.0.1:${PROXY_PORT}`) && /LISTENING/.test(
      out.split('\n').find(l => l.includes(`:${PROXY_PORT}`)) || ''
    );
  } catch { return false; }
}

function startProxy(opts = {}) {
  if (proxyRunning()) return { ok: true, already: true, port: PROXY_PORT };
  const nodeExe = process.execPath;
  const env = {
    ...process.env,
    PROVIDER: opts.provider || 'deepseek',
    PERSONA: opts.persona || path.join(ROOT, 'personas', 'default.md'),
    PORT: String(PROXY_PORT),
    DEBUG: '1',
  };
  const logDir = path.join(ROOT, 'dumps');
  fs.mkdirSync(logDir, { recursive: true });
  const outFd = fs.openSync(path.join(logDir, 'proxy.log'), 'a');
  proxyProc = spawn(nodeExe, [path.join(ROOT, 'core', 'proxy.mjs')], {
    env, detached: true, stdio: ['ignore', outFd, outFd], windowsHide: true,
  });
  proxyProc.unref();
  return { ok: true, pid: proxyProc.pid, port: PROXY_PORT };
}

function stopProxy() {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='node.exe'\\" | Where-Object { $_.CommandLine -like '*proxy.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ── Claude 专用 ────────────────────────────────────────
const REG = 'HKCU\\SOFTWARE\\Policies\\Claude';
const UPSTREAMS = {
  deepseek: 'https://api.deepseek.com/anthropic',
  glm: 'https://open.bigmodel.cn/api/anthropic',
  kimi: 'https://api.moonshot.ai/anthropic',
  anthropic: 'https://api.anthropic.com',
};
const MODELS = {
  deepseek: '[{"name":"claude-opus-5-5","labelOverride":"DeepSeek V4 Pro"},{"name":"claude-sonnet-5","labelOverride":"DeepSeek Flash"}]',
  glm: '[{"name":"claude-opus-5-5","labelOverride":"GLM-5.3"},{"name":"claude-sonnet-5","labelOverride":"GLM-5.3-Flash"}]',
  kimi: '[{"name":"claude-opus-5-5","labelOverride":"Kimi K3"},{"name":"claude-sonnet-5","labelOverride":"Kimi Flash"}]',
  anthropic: '',
};

function regSet(name, value) {
  execSync(`reg add "${REG}" /v ${name} /t REG_SZ /d "${String(value).replace(/"/g, '\\"')}" /f`,
    { stdio: 'ignore' });
}
function regDel(name) {
  try { execSync(`reg delete "${REG}" /v ${name} /f`, { stdio: 'ignore' }); } catch {}
}
function regGet(name) {
  try {
    const r = execSync(`reg query "${REG}" /v ${name}`, { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] });
    const m = r.match(new RegExp(`${name}\\s+REG_SZ\\s+(.*)`));
    return m ? m[1].trim() : null;
  } catch { return null; }
}

function claudeSetKey({ provider, key, baseUrl }) {
  if (!key) throw new Error('缺 key');
  const url = baseUrl || UPSTREAMS[provider] || UPSTREAMS.deepseek;
  const models = MODELS[provider] ?? MODELS.deepseek;
  regSet('inferenceProvider', 'gateway');
  regSet('inferenceGatewayBaseUrl', url);
  regSet('inferenceGatewayApiKey', key);
  regSet('inferenceGatewayAuthScheme', 'bearer');
  regSet('deploymentMode', '3p');
  regSet('disableNonessentialServices', 'true');
  regSet('disableNonessentialTelemetry', 'true');
  regSet('skipWebFetchPreflight', 'true');
  regSet('inferenceGatewayAutoModeServerChecks', 'false');
  regSet('autoModeEnabled', 'true');
  if (models) regSet('inferenceModels', models);
  return { ok: true, url, models: models ? 'set' : 'auto' };
}

function claudeArmor(on) {
  if (on) {
    regSet('inferenceGatewayBaseUrl', `http://127.0.0.1:${PROXY_PORT}`);
    return { ok: true, gateway: `http://127.0.0.1:${PROXY_PORT}` };
  } else {
    const cur = regGet('inferenceProvider');
    const up = UPSTREAMS.deepseek;
    regSet('inferenceGatewayBaseUrl', up);
    return { ok: true, gateway: up };
  }
}

// ── 路由 ────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  // 静态文件
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    const file = path.join(__dirname, 'index.html');
    if (!fs.existsSync(file)) return json(res, 404, { error: 'index.html 不存在' });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(file));
  }

  if (req.method === 'GET' && p === '/api/detect') {
    try {
      const out = execSync(`"${process.execPath}" "${path.join(ROOT,'core','detect.mjs')}" --json`,
        { encoding: 'utf8', timeout: 20000 });
      return json(res, 200, JSON.parse(out));
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  if (req.method === 'GET' && p === '/api/proxy/status') {
    return json(res, 200, { running: proxyRunning(), port: PROXY_PORT });
  }

  if (req.method === 'POST' && p === '/api/proxy/start') {
    try { return json(res, 200, startProxy()); } catch (e) { return json(res, 500, { error: e.message }); }
  }

  if (req.method === 'POST' && p === '/api/proxy/stop') {
    return json(res, 200, stopProxy());
  }

  if (req.method === 'GET' && p === '/api/persona/list') {
    return json(res, 200, listPersonas());
  }

  // 后面几个需要 body
  if (req.method === 'POST') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {}
      try {
        switch (p) {
          case '/api/claude/key':    return json(res, 200, claudeSetKey(body));
          case '/api/claude/armor':  return json(res, 200, claudeArmor(body.on));
          case '/api/persona/apply': {
            const src = body.path;
            if (!fs.existsSync(src)) throw new Error('人格文件不存在');
            const dst = path.join(ROOT, 'personas', 'default.md');
            if (fs.existsSync(dst)) fs.copyFileSync(dst, dst + '.bak');
            fs.copyFileSync(src, dst);
            return json(res, 200, { ok: true, size: fs.statSync(dst).size });
          }
          default: return json(res, 404, { error: 'no such endpoint' });
        }
      } catch (e) { return json(res, 500, { error: e.message }); }
    });
    return;
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  Fox 控制台');
  console.log('  ────────────────────────────────');
  console.log(`  http://127.0.0.1:${PORT}`);
  console.log('');
  console.log('  代理端口 : ' + PROXY_PORT);
  console.log('  仓库根   : ' + ROOT);
  console.log('');
});
