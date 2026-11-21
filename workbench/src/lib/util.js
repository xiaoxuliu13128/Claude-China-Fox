/**
 * util.js — 席位适配器的公共能力
 *
 * 所有客户端适配都需要的底层动作：路径常量、注册表读写、文件备份、
 * 事务日志。放在这里，避免每个 seat 重复实现。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

export const HOME  = os.homedir();
export const LOCAL = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
export const ROAM  = process.env.APPDATA      || path.join(HOME, 'AppData', 'Roaming');
export const PF    = process.env.ProgramFiles || 'C:\\Program Files';
export const PF86  = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
export const TEMP  = os.tmpdir();

export const APP_DIR     = path.join(LOCAL, 'FoxWorkbench');
export const BACKUP_DIR  = path.join(APP_DIR, 'backups');
export const LOG_DIR     = path.join(APP_DIR, 'logs');

for (const d of [APP_DIR, BACKUP_DIR, LOG_DIR]) {
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
}

// ── 文件系统 ────────────────────────────────────────────
export const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
export const sizeMB = (p) => { try { return Math.round(fs.statSync(p).size / 1048576 * 10) / 10; } catch { return 0; } };

export function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

export function writeText(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, 'utf8');
}

export function readJson(p) {
  const t = readText(p);
  if (!t) return null;
  try { return JSON.parse(t); } catch { return null; }
}

export function writeJson(p, obj) {
  writeText(p, JSON.stringify(obj, null, 2));
}

/** 目录里第一个匹配的条目 */
export function findFirst(dir, re) {
  try {
    const hit = fs.readdirSync(dir).find((n) => re.test(n));
    return hit ? path.join(dir, hit) : null;
  } catch { return null; }
}

// ── 注册表 ──────────────────────────────────────────────
/** HKCU 短路径，如 regSet('SOFTWARE\\Policies\\Claude', 'k', 'v') */
export function regSet(subKey, name, value, type = 'REG_SZ', hive = 'HKCU') {
  const v = String(value).replace(/"/g, '\\"');
  execSync(`reg add "${hive}\\${subKey}" /v "${name}" /t ${type} /d "${v}" /f`, { stdio: 'ignore' });
}

export function regDel(subKey, name, hive = 'HKCU') {
  try { execSync(`reg delete "${hive}\\${subKey}" /v "${name}" /f`, { stdio: 'ignore' }); return true; }
  catch { return false; }
}

export function regGet(subKey, name, hive = 'HKCU') {
  try {
    const out = execSync(`reg query "${hive}\\${subKey}" /v "${name}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+REG_\\w+\\s+(.*)`));
    return m ? m[1].trim() : null;
  } catch { return null; }
}

export function regKeyExists(subKey, hive = 'HKCU') {
  try { execSync(`reg query "${hive}\\${subKey}"`, { stdio: 'ignore' }); return true; }
  catch { return false; }
}

// ── 备份 / 还原 ─────────────────────────────────────────
/**
 * 备份一批对象，返回一个 transaction id。
 *   entries: [{ kind:'file', path }, { kind:'reg', subKey, name, hive }]
 */
export function backup(seatId, label, entries) {
  const id = `${seatId}-${label}-${Date.now()}`;
  const dir = path.join(BACKUP_DIR, id);
  fs.mkdirSync(dir, { recursive: true });

  const manifest = { id, seatId, label, at: new Date().toISOString(), entries: [] };

  for (const e of entries) {
    try {
      if (e.kind === 'file' && exists(e.path)) {
        const name = `${manifest.entries.length}-${path.basename(e.path)}`;
        fs.copyFileSync(e.path, path.join(dir, name));
        manifest.entries.push({ ...e, backup: name });
      } else if (e.kind === 'reg') {
        const val = regGet(e.subKey, e.name, e.hive || 'HKCU');
        if (val !== null) {
          manifest.entries.push({ ...e, value: val });
        }
      }
    } catch {}
  }

  writeJson(path.join(dir, 'manifest.json'), manifest);
  return manifest;
}

/** 按 manifest 还原 */
export function restoreFrom(manifestPath) {
  const m = readJson(manifestPath);
  if (!m) throw new Error('备份清单读不到');
  const dir = path.dirname(manifestPath);
  let n = 0;

  for (const e of m.entries) {
    try {
      if (e.kind === 'file' && e.backup) {
        fs.copyFileSync(path.join(dir, e.backup), e.path);
        n++;
      } else if (e.kind === 'reg' && e.value !== undefined) {
        regSet(e.subKey, e.name, e.value, e.type || 'REG_SZ', e.hive || 'HKCU');
        n++;
      }
    } catch {}
  }
  return { ok: true, restored: n, manifest: m };
}

/** 列出某个席位的备份 */
export function listBackups(seatId) {
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter((n) => !seatId || n.startsWith(seatId + '-'))
      .map((n) => {
        const mp = path.join(BACKUP_DIR, n, 'manifest.json');
        const m = readJson(mp);
        return m ? { dir: n, manifestPath: mp, ...m } : null;
      })
      .filter(Boolean)
      .sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  } catch { return []; }
}

/** 取最近一次备份 */
export function latestBackup(seatId, label) {
  const all = listBackups(seatId);
  return all.find((b) => !label || b.label === label) || null;
}

// ── 日志 ────────────────────────────────────────────────
export function log(seatId, msg) {
  const line = `[${new Date().toISOString()}] [${seatId}] ${msg}\n`;
  try { fs.appendFileSync(path.join(LOG_DIR, 'workbench.log'), line); } catch {}
}

// ── 杂项 ────────────────────────────────────────────────
export function killProcess(names) {
  for (const n of names) {
    try { execSync(`taskkill /F /IM "${n}" /T`, { stdio: 'ignore' }); } catch {}
  }
}

export function runPowerShell(script) {
  return execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${script.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8', timeout: 60000 });
}

/** 简单的 HTML 注释标记包裹 / 解包，用于可回滚的文本注入 */
export function wrapMarked(tag, body) {
  const b = `<!-- FOX-${tag.toUpperCase()}:BEGIN -->`;
  const e = `<!-- FOX-${tag.toUpperCase()}:END -->`;
  const t = String(body).replace(/\s+$/, '');
  return `${b}\n${t}\n${e}\n`;
}

export function stripMarked(text, tag) {
  const b = `<!-- FOX-${tag.toUpperCase()}:BEGIN -->`;
  const e = `<!-- FOX-${tag.toUpperCase()}:END -->`;
  return text.replace(new RegExp(`${b}[\\s\\S]*?${e}\\n?`, 'g'), '');
}

export function hasMarked(text, tag) {
  return text.includes(`<!-- FOX-${tag.toUpperCase()}:BEGIN -->`);
}
