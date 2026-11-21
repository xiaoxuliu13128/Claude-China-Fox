/**
 * seats/index.js — 席位注册表
 *
 * 「席位」= 一个 AI 客户端的适配器。每个席位实现同一组接口，
 * 上层 UI 和 runtime 只认接口，不认具体客户端。
 *
 * 接口契约（所有方法可选，缺的表示该客户端不支持）
 * ─────────────────────────────────────────────
 *   id          string   唯一标识
 *   name        string   显示名
 *   vendor      string   厂商
 *   tier        string   'full'（五模块齐） | 'partial'（部分） | 'detect-only'
 *   inject      string[] 注入手段，用于展示
 *
 *   detect()                    → { installed, version, path, configPath, state }
 *   actions.clean.preview()     → { steps: string[] }        只列出要做什么
 *   actions.clean.apply(opts)   → { ok, changed: string[] }
 *   actions.clean.restore()     → { ok }
 *   actions.key.preview(opts)   → { steps, target }
 *   actions.key.apply(opts)     → { ok, written }
 *   actions.armor.preview(opts) → { steps, persona }
 *   actions.armor.apply(opts)   → { ok, installed: string[] }
 *   actions.armor.restore()     → { ok }
 *   actions.custom.list()       → { personas: [...] }
 *   actions.custom.apply(opts)  → { ok }
 *
 * 约定
 * ─────
 *   1. 任何 apply 前必须先跑 preview，把要改的东西列清楚
 *   2. 任何写操作都要先备份，restore 能还原
 *   3. 检测失败不要抛异常，返回 installed:false
 *   4. 不动用户已经配好的东西（幂等）
 */

import claude from './claude.js';
import dsh from './dsh.js';
import workbuddy from './workbuddy.js';
import codex from './codex.js';
import gemini from './gemini.js';
import doubao from './doubao.js';

const ALL = [claude, dsh, workbuddy, codex, gemini, doubao];

export const SEATS = new Map(ALL.map((s) => [s.id, s]));

/** 全部席位（含未安装的） */
export function listSeats() {
  return ALL.map((s) => ({
    id: s.id,
    name: s.name,
    vendor: s.vendor,
    tier: s.tier,
    inject: s.inject || [],
    actions: Object.keys(s.actions || {}),
  }));
}

/** 检测全部席位，返回带状态的结果 */
export function detectAll() {
  return ALL.map((s) => {
    let d = { installed: false };
    try {
      d = s.detect() || { installed: false };
    } catch (e) {
      d = { installed: false, error: e.message };
    }
    return {
      id: s.id,
      name: s.name,
      vendor: s.vendor,
      tier: s.tier,
      inject: s.inject || [],
      actions: Object.keys(s.actions || {}),
      ...d,
    };
  });
}

/** 取单个席位 */
export function getSeat(id) {
  return SEATS.get(id) || null;
}

/**
 * 统一执行入口。
 *   seatId  席位 id
 *   action  clean | key | armor | custom
 *   op      preview | apply | restore | list
 *   opts    传给具体实现的参数
 */
export function run(seatId, action, op, opts = {}) {
  const seat = getSeat(seatId);
  if (!seat) return { ok: false, error: `未知席位: ${seatId}` };

  const a = seat.actions?.[action];
  if (!a) return { ok: false, error: `${seat.name} 不支持 ${action}` };

  const fn = a[op];
  if (typeof fn !== 'function') return { ok: false, error: `${seat.name} 的 ${action} 不支持 ${op}` };

  try {
    const r = fn(opts) || { ok: true };
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, error: e.message, stack: e.stack };
  }
}

export default { SEATS, listSeats, detectAll, getSeat, run };
