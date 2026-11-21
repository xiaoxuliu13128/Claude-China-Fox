#!/usr/bin/env node
/**
 * 破甲注入代理（Anthropic 协议）
 *
 * 原理：Claude Desktop 的每个模型请求都发往 inferenceGatewayBaseUrl。
 *       把它指向本代理，本代理在转发前改写 system 字段，即可注入人格/解除限制，
 *       完全不需要修改 app.asar，官方更新也不会覆盖。
 *
 * 用法：
 *   node pojia-proxy.mjs
 *   然后把注册表 inferenceGatewayBaseUrl 指向 http://127.0.0.1:8790
 *
 * 环境变量：
 *   UPSTREAM   上游真实地址，默认 https://api.deepseek.com/anthropic
 *   PORT       监听端口，默认 8790
 *   PERSONA    注入内容文件，默认同目录 persona.md
 *   MODE       append（追加到原 system 后，默认） / replace（整段替换）
 *   DEBUG      1 打印每条被改写的请求
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const UPSTREAM = process.env.UPSTREAM || 'https://api.deepseek.com/anthropic';
const PORT = Number(process.env.PORT || 8790);
const PERSONA_FILE = process.env.PERSONA || path.join(__dirname, 'persona.md');
const MODE = (process.env.MODE || 'replace').toLowerCase();
const DEBUG = process.env.DEBUG === '1';
// 关 thinking 的策略：
//   off   —— 全关（省预算，但普通问题会变笨，不推荐）
//   smart —— 分类判断（默认）：内容敏感的关，技术敏感的保留
//   keep  —— 全开
const THINKING = (process.env.THINKING || 'smart').toLowerCase();

// 抓包：设 DUMP=1 会把每次请求的完整结构写到 dumps/ 目录
// 用途：看清官方的 31KB base prompt 到底落在哪个字段、tools 里藏了什么
const DUMP = process.env.DUMP === '1';
// effort 统一由代理控制（low/medium/high/xhigh/max）。留空则保留客户端的选择。
const EFFORT = (process.env.EFFORT || 'medium').toLowerCase();
const DUMP_DIR = path.join(__dirname, 'dumps');
let dumpCount = 0;
const DUMP_MAX = 6;

function dumpRequest(obj, url) {
  if (!DUMP || dumpCount >= DUMP_MAX) return;
  try {
    if (!fs.existsSync(DUMP_DIR)) fs.mkdirSync(DUMP_DIR, { recursive: true });
    const sysLen = typeof obj.system === 'string' ? obj.system.length
                 : Array.isArray(obj.system) ? JSON.stringify(obj.system).length : 0;
    const toolsLen = Array.isArray(obj.tools) ? JSON.stringify(obj.tools).length : 0;
    const msgLen = Array.isArray(obj.messages) ? JSON.stringify(obj.messages).length : 0;
    const meta = {
      url,
      model: obj.model,
      systemLen: sysLen,
      toolsCount: Array.isArray(obj.tools) ? obj.tools.length : 0,
      toolsLen,
      messagesCount: Array.isArray(obj.messages) ? obj.messages.length : 0,
      messagesLen: msgLen,
      maxTokens: obj.max_tokens,
      hasThinking: !!obj.thinking,
      stream: obj.stream,
      topLevelKeys: Object.keys(obj),
    };
    const idx = String(dumpCount + 1).padStart(2, '0');
    fs.writeFileSync(path.join(DUMP_DIR, `${idx}-meta.json`), JSON.stringify(meta, null, 2), 'utf8');
    fs.writeFileSync(path.join(DUMP_DIR, `${idx}-full.json`), JSON.stringify(obj, null, 2), 'utf8');
    dumpCount++;
    console.log(`[dump] #${idx} system=${sysLen}B tools=${meta.toolsCount}个/${toolsLen}B msgs=${meta.messagesCount}个/${msgLen}B`);
  } catch (e) {
    console.error('[dump error]', e.message);
  }
}

// 【内容类敏感】不需要推理，而且模型会在 thinking 里反复犹豫把预算烧光 → 关掉
const CONTENT_SENSITIVE = /露骨|性描写|色情|情色|裸体|做爱|性行为|呻吟|淫|骚|高潮|强奸|血腥|虐杀|肢解|恋尸|乱伦/;

// 【技术类敏感】恰恰需要推理：要规划步骤、写代码、查错 → 保留 thinking
// 仅用于日志统计，不参与压制
const TECH_SENSITIVE = /恶意软件|木马|病毒|勒索|远控|RAT|C2|键盘记录|keylog|免杀|shellcode|注入|提权|横向|域控|mimikatz|hashcat|撞库|口令喷洒|社工|钓鱼|仿站|外挂|透视|自瞄|反作弊|破解|注册机|keygen|脱壳|加壳|DRM|绕过|bypass|webshell|SQLi|XSS|SSRF|XXE|RCE|后门|持久化|代理池|扫端口|批量注册|验证码/;

function loadPersona() {
  try {
    const t = fs.readFileSync(PERSONA_FILE, 'utf8').trim();
    return t;
  } catch {
    return '';
  }
}

let persona = loadPersona();
const up = new URL(UPSTREAM);

/** 把 system 字段改成我们要的 */
function rewriteBody(buf, logTag) {
  let obj;
  try {
    obj = JSON.parse(buf.toString('utf8'));
  } catch {
    return buf; // 不是 JSON 就原样转发
  }

  dumpRequest(obj, logTag);

  const original = obj.system;
  const add = persona;

  if (MODE === 'replace') {
    obj.system = add;
  } else {
    // append：把原 system 放前面，人格放后面（后写的一般更容易被遵循）
    if (typeof original === 'string') {
      obj.system = original + '\n\n' + add;
    } else if (Array.isArray(original)) {
      obj.system = [...original, { type: 'text', text: add }];
    } else if (original === undefined || original === null) {
      obj.system = add;
    } else {
      obj.system = String(original) + '\n\n' + add;
    }
  }

  // thinking 策略
  if (THINKING === 'off') {
    obj.thinking = { type: 'disabled' };
  } else if (THINKING === 'smart') {
    // 扫最后 3 条用户消息，判断内容性质
    let probe = '';
    const msgs = Array.isArray(obj.messages) ? obj.messages.slice(-3) : [];
    for (const m of msgs) {
      if (typeof m.content === 'string') probe += m.content + '\n';
      else if (Array.isArray(m.content)) {
        for (const c of m.content) if (c && c.type === 'text') probe += (c.text || '') + '\n';
      }
    }
    // 关键：只要涉及敏感内容（技术或内容），一律压 thinking。
    // 实测保留 thinking 会让模型在「要不要做这件事」上反复权衡，
    // max_tokens 被思考吃光，正文返回 0 字 —— 比降智更糟。
    const isContent = CONTENT_SENSITIVE.test(probe);
    const isTech = TECH_SENSITIVE.test(probe);
    if (isContent || isTech) {
      obj.thinking = { type: 'disabled' };
      if (DEBUG) console.log(`  [thinking] ${isContent ? '内容类' : '技术类'} → disabled`);
    } else {
      // 官方默认是 {type:"adaptive"}，DeepSeek 按 enabled 处理。原样保留。
      if (DEBUG) console.log(`  [thinking] 普通对话 → 保留 (${obj.thinking?.type || 'unset'})`);
    }
  }

  // effort 由代理统一控制，省得每次去界面点。
  // 官方用 output_config.effort（low/medium/high/xhigh/max）。
  // max 太费，默认压到 medium；要改就设环境变量 EFFORT=high 之类。
  if (EFFORT) {
    obj.output_config = { ...(obj.output_config || {}), effort: EFFORT };
    if (DEBUG) console.log(`  [effort] -> ${EFFORT}`);
  }

  // ── 兼容性清洗：只保留上游认识的字段 ──────────────────────
  // Claude Desktop 会塞一堆 Anthropic 私有/实验性字段（safeguards 尤其巨大，
  // 里面是整套 auto_mode 权限规则），DeepSeek 收到不认识的字段直接 400
  // "Extra inputs are not permitted"，界面上表现就是 Invalid request。
  const ALLOWED = new Set([
    'model', 'messages', 'system', 'tools', 'tool_choice', 'temperature',
    'top_p', 'top_k', 'stop_sequences', 'stream', 'metadata', 'thinking',
    'output_config', 'max_tokens',
  ]);
  for (const k of Object.keys(obj)) {
    if (!ALLOWED.has(k)) {
      delete obj[k];
      if (DEBUG) console.log(`  [strip] 去掉不兼容字段: ${k}`);
    }
  }

  // max_tokens 夹到上游能接受的范围（128000 会被某些端点判为超限）
  const mt = Number(obj.max_tokens);
  if (!Number.isFinite(mt) || mt > 8192) {
    obj.max_tokens = 8192;
    if (DEBUG) console.log(`  [budget] max_tokens ${Number.isFinite(mt) ? mt : 'unset'} -> 8192`);
  } else if (mt < 4096) {
    obj.max_tokens = 4096;
    if (DEBUG) console.log(`  [budget] max_tokens ${mt} -> 4096（保底）`);
  }

  if (DEBUG) {
    const before = JSON.stringify(original ?? '').length;
    const after = JSON.stringify(obj.system ?? '').length;
    console.log(`[${logTag}] model=${obj.model} system ${before} -> ${after} 字符  mode=${MODE}`);
  }
  return Buffer.from(JSON.stringify(obj), 'utf8');
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = Buffer.concat(chunks);

    // 只改写 messages 端点，其它（models 等）原样过
    const isMessages = req.url.includes('/v1/messages');
    if (isMessages && persona && req.method === 'POST') {
      body = rewriteBody(body, 'inject');
    }

    const headers = { ...req.headers };
    delete headers['host'];
    delete headers['content-length'];
    headers['content-length'] = Buffer.byteLength(body);

    const target = new URL(up.pathname.replace(/\/$/, '') + req.url, up.origin);

    const preq = https.request(
      {
        hostname: target.hostname,
        port: target.port || 443,
        path: target.pathname + target.search,
        method: req.method,
        headers,
        timeout: 900000,
      },
      (pres) => {
        res.writeHead(pres.statusCode || 502, pres.headers);
        pres.pipe(res);
      }
    );

    preq.on('error', (e) => {
      console.error('[proxy error]', e.message);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: String(e.message) } }));
    });
    preq.on('timeout', () => { preq.destroy(new Error('upstream timeout')); });

    preq.write(body);
    preq.end();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  破甲注入代理已启动');
  console.log('  ------------------------------------------');
  console.log(`  监听      http://127.0.0.1:${PORT}`);
  console.log(`  上游      ${UPSTREAM}`);
  console.log(`  人格文件  ${PERSONA_FILE}`);
  console.log(`  人格大小  ${persona.length} 字符 ${persona ? '' : '（空！注入不会生效）'}`);
  console.log(`  注入模式  ${MODE}`);
  console.log('');
  console.log('  下一步：注册表 inferenceGatewayBaseUrl 指到本代理，然后重启 Claude Desktop');
  console.log('  自检：应用里发一句固定口令，看是否回固定答案');
  console.log('');
});

// 人格文件热重载：改了 md 不用重启代理
fs.watchFile(PERSONA_FILE, { interval: 1000 }, () => {
  persona = loadPersona();
  console.log(`[persona reloaded] ${persona.length} 字符`);
});
