#!/usr/bin/env node
/**
 * server.mjs — Fox Workbench 本地服务
 *
 * 给 UI 提供 REST API。启动后浏览器打开 http://127.0.0.1:8792
 *
 *   GET  /                      UI
 *   GET  /api/seats             席位能力列表
 *   GET  /api/detect            检测全部席位
 *   POST /api/preview           { seat, action, opts }  预览
 *   POST /api/apply             { seat, action, opts }  执行
 *   POST /api/restore           { seat, action, opts }  还原
 *   GET  /api/backups?seat=     备份列表
 *   GET  /api/personas          人格列表
 *   GET  /api/proxy/status      代理状态
 *   POST /api/proxy/start       启动代理
 *   POST /api/proxy/stop        停止代理
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawn } from 'node:child_process';
import { detectAll, listSeats, run } from './src/lib/seats/index.js';
import { listBackups, APP_DIR } from './src/lib/util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PORT = 8792;
const PROXY_PORT = 8790;
const PROXY_JS = path.join(REPO_ROOT, 'core', 'proxy.mjs');
const PERSONA_DIR = path.join(REPO_ROOT, 'personas');

const json = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};

const readBody = (req) => new Promise((resolve) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
    catch { resolve({}); }
  });
});

// ── 代理状态 ────────────────────────────────────────────
function proxyRunning() {
  try {
    const out = execSync('netstat -ano -p TCP', { encoding: 'utf8', timeout: 8000 });
    const line = out.split('\n').find((l) => l.includes(`127.0.0.1:${PROXY_PORT}`));
    return !!(line && /LISTENING/.test(line));
  } catch { return false; }
}

function startProxy(opts = {}) {
  if (proxyRunning()) return { ok: true, already: true, port: PROXY_PORT };
  if (!fs.existsSync(PROXY_JS)) return { ok: false, error: `找不到代理脚本: ${PROXY_JS}` };

  const logDir = path.join(APP_DIR, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const fd = fs.openSync(path.join(logDir, 'proxy.log'), 'a');
  const env = {
    ...process.env,
    PROVIDER: opts.provider || 'deepseek',
    PERSONA: opts.persona || path.join(PERSONA_DIR, 'default.md'),
    PORT: String(PROXY_PORT),
    DEBUG: '1',
  };
  const p = spawn(process.execPath, [PROXY_JS], {
    env, detached: true, stdio: ['ignore', fd, fd], windowsHide: true,
  });
  p.unref();
  return { ok: true, pid: p.pid, port: PROXY_PORT };
}

function stopProxy() {
  try {
    execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='node.exe'\\" | Where-Object { $_.CommandLine -like '*proxy.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`,
      { stdio: 'ignore', timeout: 15000 }
    );
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ── 人格列表 ────────────────────────────────────────────
function listPersonas() {
  const out = [];
  for (const dir of [PERSONA_DIR, path.join(PERSONA_DIR, 'custom')]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      const full = path.join(dir, f);
      let text = '';
      try { text = fs.readFileSync(full, 'utf8'); } catch {}
      out.push({
        name: f.replace(/\.md$/, ''),
        scope: path.basename(dir) === 'custom' ? 'custom' : 'builtin',
        size: text.length,
        path: full,
        isDefault: f === 'default.md',
        title: (text.match(/^#\s+(.+)$/m) || [, ''])[1],
      });
    }
  }
  return out.sort((a, b) => (a.isDefault ? -1 : b.isDefault ? 1 : a.name.localeCompare(b.name)));
}

// ── 路由 ────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const p = url.pathname;
  const method = req.method;

  // UI
  if (method === 'GET' && (p === '/' || p === '/index.html')) {
    const f = path.join(__dirname, 'renderer', 'index.html');
    if (!fs.existsSync(f)) return json(res, 404, { error: 'renderer/index.html 不存在' });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(f));
  }

  // API
  try {
    if (method === 'GET' && p === '/api/seats')   return json(res, 200, listSeats());
    if (method === 'GET' && p === '/api/detect')  return json(res, 200, detectAll());
    if (method === 'GET' && p === '/api/personas') return json(res, 200, listPersonas());
    if (method === 'GET' && p === '/api/backups') {
      return json(res, 200, listBackups(url.searchParams.get('seat') || null));
    }
    if (method === 'GET' && p === '/api/proxy/status') {
      return json(res, 200, { running: proxyRunning(), port: PROXY_PORT });
    }

    if (method === 'POST') {
      const body = await readBody(req);

      if (p === '/api/proxy/start') return json(res, 200, startProxy(body));
      if (p === '/api/proxy/stop')  return json(res, 200, stopProxy());

      if (p === '/api/preview' || p === '/api/apply' || p === '/api/restore') {
        const op = p.slice(5);   // preview | apply | restore
        const { seat, action, opts = {} } = body;
        if (!seat || !action) return json(res, 400, { ok: false, error: '缺 seat 或 action' });
        const r = run(seat, action, op, opts);
        return json(res, 200, r);
      }
    }

    return json(res, 404, { error: 'not found' });
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message, stack: e.stack });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  Fox Workbench');
  console.log('  ' + '─'.repeat(40));
  console.log(`  UI        http://127.0.0.1:${PORT}`);
  console.log(`  代理端口  ${PROXY_PORT}`);
  console.log(`  仓库根    ${REPO_ROOT}`);
  console.log('');
  console.log('  席位：');
  for (const s of listSeats()) {
    console.log(`    ${s.id.padEnd(12)} ${s.name.padEnd(16)} [${s.tier}]`);
  }
  console.log('');
});
