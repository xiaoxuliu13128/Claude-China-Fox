#!/usr/bin/env node
/**
 * cli.js — Fox Workbench 命令行入口
 *
 * 六席位 × 五模块的统一操作面。UI 还没做之前，用它验证全部逻辑。
 *
 * 用法
 *   node cli.js detect
 *   node cli.js seats
 *   node cli.js preview <seat> <action>
 *   node cli.js apply   <seat> <action> [--persona PATH] [--provider deepseek] [--key KEY]
 *   node cli.js restore <seat> <action>
 *   node cli.js backups [seat]
 *
 * 例
 *   node cli.js detect
 *   node cli.js preview claude key
 *   node cli.js apply   claude key --provider deepseek --key sk-xxx
 *   node cli.js apply   workbuddy armor --persona ../personas/default.md
 *   node cli.js restore workbuddy armor
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectAll, listSeats, run, getSeat } from './src/lib/seats/index.js';
import { listBackups } from './src/lib/util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// workbench/cli.js → ../ 是仓库根（gh-publish）
const REPO_ROOT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const cmd = argv[0];

function flag(name, def = null) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}

const C = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  err: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function printDetect() {
  const seats = detectAll();
  console.log('');
  console.log(C.bold('  席位检测'));
  console.log(C.dim('  ' + '─'.repeat(66)));
  for (const s of seats) {
    const mark = s.installed ? C.ok('✓') : C.dim('○');
    const tier = s.tier === 'full' ? C.ok('full') : s.tier === 'partial' ? C.warn('partial') : C.dim('detect-only');
    console.log(`  ${mark} ${s.name.padEnd(16)} ${s.vendor.padEnd(12)} ${tier}`);
    if (!s.installed) continue;
    if (s.path) console.log(C.dim(`      路径  ${s.path}`));
    if (s.version) console.log(C.dim(`      版本  ${s.version}`));
    if (s.asar) console.log(C.dim(`      asar  ${s.asar.sizeMB} MB`));
    const st = s.state || {};
    const bits = [];
    if (st.armored) bits.push(C.ok('已破甲'));
    else if (st.configured) bits.push(C.warn('已配置未破甲'));
    else bits.push(C.dim('未配置'));
    if (st.pluginInstalled) bits.push('插件已装');
    if (st.existingSkills) bits.push(`${st.existingSkills} 个技能`);
    if (st.hasPurge) bits.push('dsh-purge 在');
    console.log(`      状态  ${bits.join('  ')}`);
  }
  console.log('');
  console.log(C.dim(`  共 ${seats.length} 个席位，${seats.filter((s) => s.installed).length} 个已安装`));
  console.log('');
}

function printSeats() {
  console.log('');
  for (const s of listSeats()) {
    console.log(`  ${C.bold(s.id.padEnd(12))} ${s.name}  ${C.dim('[' + s.tier + ']')}`);
    console.log(C.dim(`      注入  ${s.inject.join(', ') || '（无）'}`));
    console.log(C.dim(`      动作  ${s.actions.join(', ')}`));
  }
  console.log('');
}

function main() {
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(`
  Fox Workbench CLI

    detect                     检测所有席位
    seats                      列出席位能力
    preview <seat> <action>    预览要做什么（不改任何东西）
    apply   <seat> <action>    执行
    restore <seat> <action>    还原
    backups [seat]             列出备份

  选项
    --persona PATH             人格文件（armor/custom 用）
    --provider NAME            deepseek | glm | kimi | anthropic（key 用）
    --key KEY                  API Key（key 用）
    --port N                   代理端口（armor 用，默认 8790）

  action: clean | key | armor | custom
`);
    return;
  }

  if (cmd === 'detect') return printDetect();
  if (cmd === 'seats') return printSeats();

  if (cmd === 'backups') {
    const seat = argv[1];
    const all = listBackups(seat);
    if (!all.length) return console.log(C.dim('  没有备份记录'));
    for (const b of all) {
      console.log(`  ${b.id}  ${C.dim(b.at)}  ${b.entries.length} 项`);
    }
    return;
  }

  const seatId = argv[1];
  const action = argv[2];
  if (!seatId || !action) return console.log(C.err('  缺参数：<seat> <action>'));

  const seat = getSeat(seatId);
  if (!seat) return console.log(C.err(`  未知席位: ${seatId}。跑 node cli.js seats 看可用的`));

  const opts = {
    persona: flag('persona', path.join(REPO_ROOT, 'personas', 'default.md')),
    provider: flag('provider', 'deepseek'),
    key: flag('key'),
    port: Number(flag('port', 8790)),
  };

  if (cmd === 'preview') {
    const r = run(seatId, action, 'preview', opts);
    if (!r.ok) return console.log(C.err('  ' + r.error));
    console.log('');
    console.log(C.bold(`  ${seat.name} · ${action} · 预览`));
    console.log(C.dim('  ' + '─'.repeat(66)));
    if (r.supported === false) {
      for (const s of r.steps) console.log('  ' + (s.startsWith('  ') ? C.dim(s) : s));
      console.log('');
      console.log(C.warn(`  不支持：${r.reason}`));
      return;
    }
    for (const s of r.steps || []) console.log('  ' + (s.startsWith('  ') ? C.dim(s) : s));
    if (r.note) console.log('');
    if (r.note) console.log(C.dim('  注：' + r.note));
    console.log('');
    if (r.manual) console.log(C.warn('  这个动作用手动方式，不自动写入'));
    return;
  }

  if (cmd === 'apply') {
    const r = run(seatId, action, 'apply', opts);
    if (!r.ok) return console.log(C.err('  ' + r.error));
    console.log('');
    console.log(C.ok(`  ✓ ${seat.name} · ${action} 已执行`));
    for (const [k, v] of Object.entries(r)) {
      if (k === 'ok') continue;
      const val = Array.isArray(v) ? v.join('\n                ') : String(v);
      console.log(`    ${k.padEnd(12)} ${val}`);
    }
    if (r.needRestart) console.log(C.warn('\n    需要重启对应客户端才生效'));
    console.log('');
    return;
  }

  if (cmd === 'restore') {
    const r = run(seatId, action, 'restore', opts);
    if (!r.ok) return console.log(C.err('  ' + r.error));
    console.log(C.ok(`  ✓ ${seat.name} · ${action} 已还原`));
    for (const [k, v] of Object.entries(r)) {
      if (k === 'ok') continue;
      console.log(`    ${k.padEnd(12)} ${v}`);
    }
    if (r.needRestart) console.log(C.warn('\n    需要重启对应客户端'));
    console.log('');
    return;
  }

  console.log(C.err(`  未知命令: ${cmd}`));
}

main();
