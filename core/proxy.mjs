#!/usr/bin/env node
/**
 * fox-proxy — 通用 LLM 注入代理
 *
 * 六个客户端共用。作用：把发往上游的请求拦下来，改写 system 字段注入人格，
 * 同时处理各家上游的兼容性问题（私有字段、thinking 行为、token 预算）。
 *
 * 环境变量
 *   PROVIDER   deepseek | glm | kimi | anthropic | custom   默认 deepseek
 *   UPSTREAM   覆盖 PROVIDER 推导出的上游地址
 *   PORT       监听端口，默认 8790
 *   PERSONA    人格文件路径，默认 ../personas/default.md
 *   MODE       replace | append                             默认 replace
 *   THINKING   smart | off | keep                           默认 smart
 *   EFFORT     low | medium | high | xhigh | max            默认 medium（留空则不干预）
 *   STRIP      all | whitelist | none                       默认 whitelist
 *   DUMP       1 = 把请求结构写到 ./dumps/
 *   DEBUG      1 = 打印每次判定
 *
 * 已验证行为见 ../docs/FULL-GUIDE.md
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 上游预设 ────────────────────────────────────────────
const PROVIDERS = {
  deepseek:  { url: 'https://api.deepseek.com/anthropic',        label: 'DeepSeek' },
  glm:       { url: 'https://open.bigmodel.cn/api/anthropic',    label: '智谱 GLM' },
  kimi:      { url: 'https://api.moonshot.ai/anthropic',         label: 'Kimi' },
  anthropic: { url: 'https://api.anthropic.com',                 label: 'Anthropic 官方' },
  custom:    { url: '',                                          label: '自定义' },
};

const PROVIDER = (process.env.PROVIDER || 'deepseek').toLowerCase();
const preset   = PROVIDERS[PROVIDER] || PROVIDERS.custom;
const UPSTREAM = process.env.UPSTREAM || preset.url;
const PORT     = Number(process.env.PORT || 8790);
const MODE     = (process.env.MODE || 'replace').toLowerCase();
const THINKING = (process.env.THINKING || 'smart').toLowerCase();
const EFFORT   = (process.env.EFFORT ?? 'medium').toLowerCase();
const STRIP    = (process.env.STRIP || 'whitelist').toLowerCase();
const DUMP     = process.env.DUMP === '1';
const DEBUG    = process.env.DEBUG === '1';
const PERSONA_FILE = process.env.PERSONA || path.join(__dirname, '..', 'personas', 'default.md');

if (!UPSTREAM) { console.error('没有上游地址。设 PROVIDER=kimi 或 UPSTREAM=https://...'); process.exit(1); }
const up = new URL(UPSTREAM);

// ── 人格 ────────────────────────────────────────────────
function loadPersona() {
  try { return fs.readFileSync(PERSONA_FILE, 'utf8').trim(); } catch { return ''; }
}
let persona = loadPersona();

// ── 意图分类 ────────────────────────────────────────────
// 内容类：不需要推理，而且模型会在 thinking 里反复犹豫把预算烧光 → 关掉
const CONTENT_SENSITIVE = /露骨|性描写|色情|情色|裸体|做爱|性行为|呻吟|淫|骚|高潮|强奸|血腥|虐杀|肢解|恋尸|乱伦/;
// 技术类：看着敏感，但保留 thinking 会让模型在「要不要做」上耗光预算 → 同样关掉
const TECH_SENSITIVE = /恶意软件|木马|病毒|勒索|远控|RAT|C2|键盘记录|keylog|免杀|shellcode|注入|提权|横向|域控|mimikatz|hashcat|撞库|口令喷洒|社工|钓鱼|仿站|外挂|透视|自瞄|反作弊|破解|注册机|keygen|脱壳|加壳|DRM|绕过|bypass|webshell|SQLi|XSS|SSRF|XXE|RCE|后门|持久化|代理池|扫端口|批量注册|验证码/;

// ── 字段白名单 ──────────────────────────────────────────
// Claude Desktop 会塞一堆 Anthropic 私有字段（safeguards 尤其巨大），
// 上游不认识就 400 "Extra inputs are not permitted"，界面上显示 Invalid request
const ALLOWED = new Set([
  'model', 'messages', 'system', 'tools', 'tool_choice', 'temperature',
  'top_p', 'top_k', 'stop_sequences', 'stream', 'metadata', 'thinking',
  'output_config', 'max_tokens',
]);

// ── 抓包 ────────────────────────────────────────────────
const DUMP_DIR = path.join(__dirname, '..', 'dumps');
let dumpCount = 0;
const DUMP_MAX = 6;

function dumpRequest(obj, url) {
  if (!DUMP || dumpCount >= DUMP_MAX) return;
  try {
    fs.mkdirSync(DUMP_DIR, { recursive: true });
    const meta = {
      url, model: obj.model,
      systemLen: typeof obj.system === 'string' ? obj.system.length
                 : Array.isArray(obj.system) ? JSON.stringify(obj.system).length : 0,
      toolsCount: Array.isArray(obj.tools) ? obj.tools.length : 0,
      toolsLen: Array.isArray(obj.tools) ? JSON.stringify(obj.tools).length : 0,
      messagesCount: Array.isArray(obj.messages) ? obj.messages.length : 0,
      maxTokens: obj.max_tokens,
      hasThinking: !!obj.thinking,
      stream: obj.stream,
      topLevelKeys: Object.keys(obj),
    };
    const idx = String(dumpCount + 1).padStart(2, '0');
    fs.writeFileSync(path.join(DUMP_DIR, `${idx}-meta.json`), JSON.stringify(meta, null, 2), 'utf8');
    fs.writeFileSync(path.join(DUMP_DIR, `${idx}-full.json`), JSON.stringify(obj, null, 2), 'utf8');
    dumpCount++;
    console.log(`[dump] #${idx} system=${meta.systemLen}B tools=${meta.toolsCount}个/${meta.toolsLen}B msgs=${meta.messagesCount}个`);
  } catch (e) { console.error('[dump]', e.message); }
}

// ── 请求改写 ────────────────────────────────────────────
function rewriteBody(buf, urlPath) {
  let obj;
  try { obj = JSON.parse(buf.toString('utf8')); } catch { return buf; }

  dumpRequest(obj, urlPath);
  const log = [];

  // 1) 字段白名单
  if (STRIP === 'whitelist') {
    for (const k of Object.keys(obj)) {
      if (!ALLOWED.has(k)) { delete obj[k]; log.push(`strip:${k}`); }
    }
  }

  // 2) 人格注入
  if (persona) {
    if (MODE === 'replace') {
      obj.system = persona;
    } else {
      const orig = obj.system;
      if (typeof orig === 'string') obj.system = orig + '\n\n' + persona;
      else if (Array.isArray(orig)) obj.system = [...orig, { type: 'text', text: persona }];
      else obj.system = persona;
    }
    log.push(`inject:${MODE}`);
  }

  // 3) thinking 策略
  if (THINKING === 'off') {
    obj.thinking = { type: 'disabled' };
    log.push('thinking:off');
  } else if (THINKING === 'smart') {
    let probe = '';
    for (const m of (Array.isArray(obj.messages) ? obj.messages.slice(-3) : [])) {
      if (typeof m.content === 'string') probe += m.content + '\n';
      else if (Array.isArray(m.content)) for (const c of m.content) if (c?.type === 'text') probe += (c.text || '') + '\n';
    }
    if (CONTENT_SENSITIVE.test(probe) || TECH_SENSITIVE.test(probe)) {
      obj.thinking = { type: 'disabled' };
      log.push('thinking:disabled(敏感)');
    } else {
      log.push('thinking:keep');
    }
  }

  // 4) effort
  if (EFFORT) {
    obj.output_config = { ...(obj.output_config || {}), effort: EFFORT };
    log.push(`effort:${EFFORT}`);
  }

  // 5) token 预算夹紧
  const mt = Number(obj.max_tokens);
  if (!Number.isFinite(mt) || mt > 8192) { obj.max_tokens = 8192; log.push(`mt:${Number.isFinite(mt) ? mt : 'unset'}->8192`); }
  else if (mt < 4096) { obj.max_tokens = 4096; log.push(`mt:${mt}->4096`); }

  if (DEBUG) console.log(`[inject] ${log.join(' ')}`);
  return Buffer.from(JSON.stringify(obj), 'utf8');
}

// ── 服务 ────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = Buffer.concat(chunks);
    if (req.method === 'POST' && req.url.includes('/v1/messages') && persona) {
      body = rewriteBody(body, req.url);
    }

    const headers = { ...req.headers };
    delete headers['host'];
    delete headers['content-length'];
    headers['content-length'] = Buffer.byteLength(body);

    const target = new URL(up.pathname.replace(/\/$/, '') + req.url, up.origin);
    const preq = https.request({
      hostname: target.hostname,
      port: target.port || 443,
      path: target.pathname + target.search,
      method: req.method,
      headers,
      timeout: 900000,
    }, (pres) => {
      res.writeHead(pres.statusCode || 502, pres.headers);
      pres.pipe(res);
    });

    preq.on('error', (e) => {
      console.error('[upstream]', e.message);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: String(e.message) } }));
    });
    preq.on('timeout', () => preq.destroy(new Error('upstream timeout')));
    preq.write(body);
    preq.end();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  fox-proxy');
  console.log('  ────────────────────────────────────────');
  console.log(`  监听      http://127.0.0.1:${PORT}`);
  console.log(`  上游      ${preset.label}  ${UPSTREAM}`);
  console.log(`  人格      ${PERSONA_FILE}`);
  console.log(`            ${persona.length} 字符 ${persona ? '' : '（空！注入不会生效）'}`);
  console.log(`  注入模式  ${MODE}`);
  console.log(`  thinking  ${THINKING}`);
  console.log(`  effort    ${EFFORT || '(不干预)'}`);
  console.log(`  字段清洗  ${STRIP}`);
  console.log('');
});

fs.watchFile(PERSONA_FILE, { interval: 1000 }, () => {
  persona = loadPersona();
  console.log(`[persona] 重新加载 ${persona.length} 字符`);
});
