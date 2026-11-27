/**
 * inbox-bridge：本地 HTTP → 注入一个活着的 DSH 会话 → 唤醒 agent。
 *
 * 只做这一件事，不碰 QQ、不依赖 MCP：
 *   GET  /health          数量/计数/版本（不回会话 id）
 *   GET  /sessions        活会话列表（要 token；选目标时用）
 *   GET  /delivery/{id}   查一条投递的结果（要 token）
 *   POST /config          改默认目标会话/端口（要 token）
 *   POST /inbox           投一条消息（要 token）
 *
 * 语义（0.2.0，对应维护域 Rev2 需求）：
 *   · **默认异步**：立刻返回 202 { ok, queued, id, sessionId }，
 *     投递结果用 GET /delivery/{id} 或 /health 计数看。wait:true 时等结果（≤ maxWaitMs）返回 200。
 *   · 注入走 `Agent.followup()`，DSH 内部是**同步入队、排到下一轮**，会话忙也照收。
 *     所以插件不需要等会话空闲：0.1.x 那 90 秒的等待正是"客户端超时→重试→同一条发三遍"的根。
 *   · 服务端 dedupeKey：显式 key 才生效，15 分钟、按会话隔离；同 key 再发回 duplicate:true。
 *   · onBusy：queue（默认，立刻入队）/ wait（先等空闲，≤ maxWaitMs）/ drop（忙就丢）。
 *   · 持久队列：接收即落盘（JSONL），插件/DSH 重启后补投"已接收但没来得及投"的条目。
 *
 * 配置：~/.dsh/inbox-bridge.json（可用 $INBOX_BRIDGE_CONFIG 改路径）
 *   { "port": 39881, "token": "<自动生成>", "sessionId": "<默认目标会话>" }
 *   可选：queueFile / logFile / dedupeTtlMs / maxWaitMs
 * 端口 0 = 系统分配（仅测试用，实际端口见日志/health）。端口变更需重启 DSH。
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { FeatureStore, defaultFeaturesFile } from './shared.js';

export const name = 'inbox-bridge';

/** 插件版本：/health.version 会报出来，维护域据此核对部署的是哪版。 */
export const version = '0.8.1';

const MAX_BODY = 64 * 1024;
const DEFAULT_PORT = 39881;
/** 与 scripts/inbox_send.py 的 15 分钟窗口一致，避免两边去重窗口对不上。 */
const DEFAULT_DEDUPE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_WAIT_MS = 5000;
const MAX_WAIT_MS = 90_000;
const MAX_DEDUPE_ENTRIES = 1000;
const MAX_JOBS = 1000;
const MAX_PENDING = 1000;
/** 后台等空闲的上限：超过就不再等（followup 会排到下一轮，不会丢）。 */
const MAX_BACKGROUND_WAIT_MS = 10 * 60 * 1000;
const PUMP_INTERVAL_MS = 500;
const MAX_JOURNAL_LINES = 2000;
const LOG_MAX_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

export const inject = ['agents'];

export function configFile(override) {
  return override || process.env.INBOX_BRIDGE_CONFIG || path.join(os.homedir(), '.dsh', 'inbox-bridge.json');
}

function defaultQueueFile() {
  return path.join(os.homedir(), '.dsh', 'inbox-queue.jsonl');
}

function defaultLogFile() {
  return path.join(os.homedir(), '.dsh', 'inbox-bridge.log');
}

/** 配置被重建过的痕迹（按文件路径）：/health 会报出来，免得调用方全 401 却查不到原因。 */
const configIssues = new Map();

function saveConfig(data, file = configFile()) {
  // 原子写：先写临时文件再 rename，避免读到半截 JSON
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 临时文件可能根本没建出来
    }
    console.error('[inbox-bridge] save config failed:', error && error.message);
  }
}

function loadConfig(file = configFile()) {
  const key = path.resolve(file);
  const defaults = { port: DEFAULT_PORT, token: '', sessionId: '' };
  let data = { ...defaults };
  let raw = null;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    // 首次运行：没有文件，正常
    raw = null;
  }
  if (raw !== null) {
    try {
      data = { ...defaults, ...JSON.parse(raw) };
    } catch (error) {
      // 损坏：先把原文件留档，再重建；否则 token 一变，调用方全 401 还查不到原因
      const backup = `${file}.corrupt-${Date.now()}`;
      let saved = '';
      try {
        fs.copyFileSync(file, backup);
        saved = backup;
      } catch (copyError) {
        console.error('[inbox-bridge] config backup failed:', copyError && copyError.message);
      }
      const reason = String((error && error.message) || error);
      configIssues.set(key, { backup: saved, at: Date.now(), reason });
      console.error(
        `[inbox-bridge] 配置损坏（${reason}）` +
          (saved ? `，已留档到 ${saved}` : '，留档失败') +
          '；将重建配置，token 会变（旧调用方会 401）',
      );
    }
  }
  if (!data.token) {
    data.token = crypto.randomBytes(16).toString('hex');
    saveConfig(data, file);
  }
  return data;
}

/** 这份配置本进程内被重建过没有（重建时 token 已换）。 */
function configIssueOf(file) {
  const issue = configIssues.get(path.resolve(file));
  if (!issue) return { ok: true };
  return { ok: false, backup: issue.backup, at: issue.at, reason: issue.reason.slice(0, 160) };
}

function sessionIdOf(agent) {
  if (!agent) return '';
  return String(agent.id || agent.sessionId || (agent.session && agent.session.id) || '');
}

function isLoopbackHostname(hostname) {
  const value = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return value === '127.0.0.1' || value === 'localhost' || value === '::1';
}

/** 浏览器来源只允许回环页面（GUI 是 127.0.0.1:<随机端口>）；无 Origin 视为非浏览器。 */
function originAllowed(origin) {
  if (!origin) return true;
  // 桌面壳（file://）发的是 Origin: null，同样只在本机可达
  if (origin === 'null') return true;
  try {
    return isLoopbackHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/** 定长比较，避免按字节数泄露 token 前缀。 */
function tokenMatches(expected, given) {
  if (!expected) return false;
  const a = Buffer.from(String(expected), 'utf8');
  const b = Buffer.from(String(given ?? ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function nowIso(ms = Date.now()) {
  return new Date(ms).toISOString();
}

/** 带时间戳的日志；给了文件就落盘并在超过上限时轮转（保留 1 份）。 */
export class RotatingLog {
  constructor(file, { maxBytes = LOG_MAX_BYTES, silent = false } = {}) {
    this.file = file || '';
    this.maxBytes = maxBytes;
    this.silent = silent;
  }

  write(line) {
    const stamped = `${nowIso()} ${line}`;
    if (!this.silent) console.log(`[inbox-bridge] ${stamped}`);
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      try {
        if (fs.statSync(this.file).size >= this.maxBytes) fs.renameSync(this.file, `${this.file}.1`);
      } catch {
        // 文件还不存在：直接写
      }
      fs.appendFileSync(this.file, stamped + '\n', 'utf8');
    } catch (error) {
      console.error('[inbox-bridge] log write failed:', error && error.message);
    }
  }
}

/** 短期去重表：key -> {at, id}；过期或超量时淘汰。 */
export class DedupeStore {
  constructor({ ttlMs = DEFAULT_DEDUPE_TTL_MS, max = MAX_DEDUPE_ENTRIES } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.entries = new Map();
  }

  get size() {
    this.prune();
    return this.entries.size;
  }

  get(key, now = Date.now()) {
    const hit = this.entries.get(key);
    if (!hit) return null;
    if (now - hit.at >= this.ttlMs) {
      this.entries.delete(key);
      return null;
    }
    return hit;
  }

  add(key, id, now = Date.now()) {
    this.entries.set(key, { at: now, id });
    if (this.entries.size > this.max) this.prune(now, true);
  }

  prune(now = Date.now(), force = false) {
    for (const [key, hit] of this.entries) {
      if (now - hit.at >= this.ttlMs) this.entries.delete(key);
    }
    if (force) {
      while (this.entries.size > this.max) {
        const oldest = this.entries.keys().next();
        if (oldest.done) break;
        this.entries.delete(oldest.value);
      }
    }
  }

  delete(key) {
    this.entries.delete(key);
  }

  clear() {
    this.entries.clear();
  }
}

/**
 * 持久投递日志（JSONL）：接收即写一行 accepted，结果再写一行。
 * 重启时把"没有终态"的条目找出来补投 —— 只覆盖"已接收但进程挂了"那一个窗口，
 * 不做无脑重放（重放会制造重复，正是要修的病）。
 */
export class Journal {
  constructor(file, { maxLines = MAX_JOURNAL_LINES, log } = {}) {
    this.file = file || '';
    this.maxLines = maxLines;
    this.log = log || (() => {});
    this.lines = 0;
    // id → 尚未有终态的 accepted 记录；自动压缩只保留这些，避免把待投条目清掉
    this.accepted = new Map();
  }

  load() {
    const records = [];
    if (!this.file) return records;
    let raw = '';
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return records;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // 半行（进程被杀时写了半截）：跳过
      }
    }
    this.lines = records.length;
    this.accepted = new Map();
    for (const record of records) {
      if (!record || !record.id) continue;
      if (record.verdict === 'accepted') this.accepted.set(record.id, record);
      else this.accepted.delete(record.id);
    }
    return records;
  }

  append(record) {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify(record) + '\n', 'utf8');
      this.lines += 1;
      if (record && record.id) {
        if (record.verdict === 'accepted') this.accepted.set(record.id, record);
        else this.accepted.delete(record.id);
      }
      if (this.lines > this.maxLines) this.compact([...this.accepted.values()]);
    } catch (error) {
      this.log(`journal write failed: ${(error && error.message) || error}`);
    }
  }

  /** 只保留未完成条目（其余已有终态，不需要再补投）。 */
  compact(pending = []) {
    if (!this.file) return;
    try {
      const tmp = `${this.file}.tmp-${process.pid}`;
      const body = pending.map((record) => JSON.stringify(record)).join('\n');
      fs.writeFileSync(tmp, body ? body + '\n' : '', 'utf8');
      fs.renameSync(tmp, this.file);
      this.lines = pending.length;
      this.accepted = new Map();
      for (const record of pending) {
        if (record && record.id && record.verdict === 'accepted') this.accepted.set(record.id, record);
      }
    } catch (error) {
      this.log(`journal compact failed: ${(error && error.message) || error}`);
    }
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      // 按 UTF-8 字节算：中文 1 字 3 字节，不能用字符串长度
      size += chunk.length;
      if (size > limit) {
        settled = true;
        const error = new Error('body too large');
        error.code = 'E_TOO_LARGE';
        reject(error);
        // 排空剩余数据，让 413 响应能正常写回；直接 destroy 会让客户端只看到断连
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function clampWait(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) return DEFAULT_MAX_WAIT_MS;
  return Math.min(Math.floor(ms), MAX_WAIT_MS);
}

/**
 * 建一个 bridge 实例（不启动）。测试可以直接用它，不必经由 Cordis。
 */
export function createBridge(ctx, options = {}) {
  const cfg0 = loadConfig(options.configPath);
  const logger = new RotatingLog(options.logFile === undefined ? cfg0.logFile || defaultLogFile() : options.logFile, {
    silent: options.silent === true,
  });
  const log = (msg) => logger.write(msg);
  // 按会话的功能开关（和 model.js 共用同一份文件；客户端开关经 /features 读写）
  const features = new FeatureStore(
    options.featuresFile === undefined ? defaultFeaturesFile() : options.featuresFile,
    { log },
  );
  const dedupe = new DedupeStore({ ttlMs: Number(cfg0.dedupeTtlMs) || DEFAULT_DEDUPE_TTL_MS });
  const queueFile = options.queueFile === undefined ? cfg0.queueFile || defaultQueueFile() : options.queueFile;
  const journal = new Journal(queueFile, { log });
  const startedAt = Date.now();
  const jobs = new Map();
  const counters = { delivered: 0, failed: 0, dropped: 0 };
  const lastActivity = new Map();
  let lastDeliveredAt = 0;
  let pending = [];
  /** 已接收、还在等空闲的投递单 id（持久日志里对应 verdict=accepted） */
  const waiting = new Set();
  let pump = null;
  let stopped = false;
  let server = null;
  let listeningPort = 0;

  function readCfg() {
    return loadConfig(options.configPath);
  }

  function saveCfg(data) {
    saveConfig(data, options.configPath);
  }

  /** 从持久日志恢复：只把"接收了但没有终态"的条目留着补投。 */
  function loadJournal() {
    const records = journal.load();
    const states = new Map();
    for (const record of records) {
      if (!record || !record.id) continue;
      states.set(record.id, record);
    }
    pending = [];
    for (const record of states.values()) {
      if (record.verdict !== 'accepted') continue;
      const source = record.source || '';
      jobs.set(record.id, {
        id: record.id,
        messageId: crypto.randomUUID(),
        sessionId: record.sessionId,
        status: 'queued',
        createdAt: record.at,
        text: record.text,
        bytes: Buffer.byteLength(String(record.text || ''), 'utf8'),
        dedupeKey: record.dedupeKey || '',
        source,
        prefix: source ? `[inbox-bridge:${source}] ` : '[inbox-bridge] ',
      });
      pending.push(record.id);
    }
    if (records.length > pending.length) journal.compact([...states.values()].filter((r) => r.verdict === 'accepted'));
  }

  function rememberJob(job) {
    jobs.set(job.id, job);
    while (jobs.size > MAX_JOBS) {
      const oldest = jobs.keys().next();
      if (oldest.done) break;
      jobs.delete(oldest.value);
    }
  }

  function pendingCount() {
    let count = 0;
    for (const job of jobs.values()) if (job.status === 'queued') count += 1;
    return count;
  }

  function describeAgent(agent) {
    const id = sessionIdOf(agent);
    let name = '';
    try {
      const cwd = agent && agent.session && agent.session.header && agent.session.header.cwd;
      if (cwd) name = path.basename(String(cwd));
    } catch {
      // 拿不到就用空名字，不因为标题信息拖垮 /sessions
    }
    return {
      id,
      name,
      live: true,
      busy: Boolean(agent && agent.status === 'running'),
      lastActiveAt: lastActivity.get(id) || 0,
    };
  }

  function liveAgents() {
    return ctx.agents.list();
  }

  function send(res, code, payload) {
    const body = JSON.stringify(payload);
    const headers = {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    };
    // 只反射回环来源的 Origin；不再无条件 *
    if (res.__allowOrigin) headers['access-control-allow-origin'] = res.__allowOrigin;
    res.writeHead(code, headers);
    res.end(body);
  }

  /**
   * 等会话真的空闲，最多 ms 毫秒。返回是否空闲（超时/等待失败一律 false，
   * 调用方必须据此决定"排队"而不是"硬塞"）。
   */
  function waitForIdle(agent, ms) {
    if (!agent) return Promise.resolve(false);
    if (typeof agent.whenIdle !== 'function') return Promise.resolve(agent.status !== 'running');
    const timer = new Promise((resolve) => {
      const handle = setTimeout(() => resolve(false), ms);
      if (typeof handle.unref === 'function') handle.unref();
    });
    return Promise.race([agent.whenIdle().then(() => true, () => false), timer]).then(
      (idle) => Boolean(idle) && agent.status !== 'running',
    );
  }

  /**
   * 后台等空闲：每 PUMP_INTERVAL_MS 扫一次 waiting。
   * 空闲了才真正 followup；会话一直忙到 MAX_BACKGROUND_WAIT_MS 就先投出去
   * （followup 只是排到下一轮，不会打断正在跑的回合），并留日志。
   */
  function ensurePump() {
    if (pump || stopped) return;
    pump = setInterval(() => {
      if (!waiting.size) {
        stopPump();
        return;
      }
      for (const id of [...waiting]) {
        const job = jobs.get(id);
        if (!job || job.status !== 'queued') {
          waiting.delete(id);
          continue;
        }
        const agent = ctx.agents.get(job.sessionId);
        const expired = Date.now() - job.createdAt >= MAX_BACKGROUND_WAIT_MS;
        if (!agent) {
          if (!expired) continue;
          waiting.delete(id);
          job.status = 'failed';
          job.error = 'no live session';
          counters.failed += 1;
          journal.append({ ...journalRecord(job), verdict: 'failed', error: job.error });
          log(`queued ${job.id} failed: no live session (${job.sessionId})`);
          continue;
        }
        if (agent.status === 'running' && !expired) continue;
        waiting.delete(id);
        deliver(job);
      }
      if (!waiting.size) stopPump();
    }, PUMP_INTERVAL_MS);
    if (typeof pump.unref === 'function') pump.unref();
  }

  function stopPump() {
    if (pump) clearInterval(pump);
    pump = null;
  }

  /** 排到后台：状态保持 queued，等空闲再投。 */
  function queueWhenIdle(job) {
    job.status = 'queued';
    waiting.add(job.id);
    ensurePump();
  }

  /** 投一条：同步入队（DSH 的 followup 就是排队），返回 job。 */
  function deliver(job) {
    try {
      const agent = ctx.agents.get(job.sessionId);
      if (!agent) {
        job.status = 'failed';
        job.error = 'no live session';
        journal.append({ ...journalRecord(job), verdict: 'failed', error: job.error });
        counters.failed += 1;
        log(`delivery ${job.id} failed: no live session ${job.sessionId}`);
        return job;
      }
      job.busy = agent.status === 'running';
      agent.followup({
        // followup 接收完整 UserMessage：role 和 id 都必填。
        // 缺 role 会一路混进会话历史，最后让模型请求因 "missing field `role`" 被拒。
        role: 'user',
        id: job.messageId,
        content: [{ type: 'text', text: job.prefix + job.text }],
        source: { kind: 'user' },
      });
      job.status = 'delivered';
      job.deliveredAt = Date.now();
      lastActivity.set(job.sessionId, job.deliveredAt);
      lastDeliveredAt = job.deliveredAt;
      counters.delivered += 1;
      journal.append({ ...journalRecord(job), verdict: 'delivered' });
      log(`delivered ${job.id} ${job.bytes}B → ${job.sessionId}`);
      return job;
    } catch (error) {
      job.status = 'failed';
      job.error = String((error && error.message) || error);
      counters.failed += 1;
      // 投递失败要把去重条目撤掉，否则同 dedupeKey 的重试会被当成 duplicate 丢掉
      if (job.dedupeKey) dedupe.delete(`${job.sessionId}|${job.dedupeKey}`);
      journal.append({ ...journalRecord(job), verdict: 'failed', error: job.error });
      log(`delivery ${job.id} failed: ${job.error}`);
      return job;
    }
  }

  function journalRecord(job) {
    return {
      id: job.id,
      at: job.createdAt,
      sessionId: job.sessionId,
      text: job.text,
      dedupeKey: job.dedupeKey || undefined,
      source: job.source || undefined,
    };
  }

  /** 重启补投：只处理 accepted 的条目；有 dedupeKey 且已投过的直接标 duplicate。 */
  function replayPending() {
    if (!pending.length) return 0;
    let replayed = 0;
    const queued = [];
    for (const id of pending) {
      const job = jobs.get(id);
      if (!job || job.status !== 'queued') continue;
      if (job.dedupeKey) {
        const scope = `${job.sessionId}|${job.dedupeKey}`;
        const hit = dedupe.get(scope);
        if (hit) {
          job.status = 'delivered';
          job.deliveredAt = Date.now();
          job.duplicateOf = hit.id;
          journal.append({ ...journalRecord(job), verdict: 'duplicate' });
          log(`replay ${job.id}: already delivered as ${hit.id}, skip`);
          continue;
        }
      }
      if (!ctx.agents.get(job.sessionId)) {
        // 会话暂时不在：排进后台泵（泵里有 MAX_BACKGROUND_WAIT_MS 过期失败逻辑）
        queueWhenIdle(job);
        queued.push(job);
        continue;
      }
      deliver(job);
      replayed += 1;
    }
    pending = [];
    journal.compact(queued.map((job) => ({ ...journalRecord(job), verdict: 'accepted' })));
    if (replayed) log(`replayed ${replayed} pending deliveries after restart`);
    return replayed;
  }

  async function handle(req, res) {
    const cfg = readCfg();
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const tokenOk = tokenMatches(cfg.token, req.headers['x-inbox-token']);

    // Host 必须是回环（挡 DNS rebinding）；Origin 只允许回环页面
    const hostHeader = String(req.headers.host || '');
    const host = hostHeader.startsWith('[')
      ? hostHeader.slice(0, hostHeader.indexOf(']') + 1)
      : hostHeader.split(':')[0];
    if (!isLoopbackHostname(host)) return send(res, 403, { ok: false, error: 'forbidden host' });
    const origin = req.headers.origin;
    if (origin && !originAllowed(origin)) return send(res, 403, { ok: false, error: 'forbidden origin' });
    res.__allowOrigin = origin && originAllowed(origin) ? origin : '';

    // 浏览器预检：只放行本机页面需要的那一组
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...(res.__allowOrigin ? { 'access-control-allow-origin': res.__allowOrigin } : {}),
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type, x-inbox-token',
        'access-control-max-age': '600',
        'access-control-allow-private-network': 'true',
        'content-length': '0',
      });
      res.end();
      return;
    }

    // 按会话的功能开关：**只允许回环页面、故意不校验 token**——它决定"某个会话能不能
    // **被别的会话**换模型"（目标同意），不读不写任何消息内容。页面拿不到桥的 token。
    if (url.pathname === '/features/model-tools') {
      if (req.method === 'GET') {
        const sessionId = String(url.searchParams.get('sessionId') || '');
        if (!sessionId) return send(res, 400, { ok: false, error: 'missing sessionId' });
        return send(res, 200, { ok: true, sessionId, enabled: features.isEnabled(sessionId) });
      }
      if (req.method === 'POST') {
        let raw = '';
        try {
          raw = await readBody(req, MAX_BODY);
        } catch (error) {
          if (error && error.code === 'E_TOO_LARGE') return send(res, 413, { ok: false, error: 'body too large' });
          throw error;
        }
        let body = {};
        try {
          body = JSON.parse(raw || '{}');
        } catch {
          return send(res, 400, { ok: false, error: 'bad json' });
        }
        const sessionId = String(body.sessionId || '');
        if (!sessionId) return send(res, 400, { ok: false, error: 'missing sessionId' });
        features.set(sessionId, Boolean(body.enabled));
        log(`feature model-tools ${body.enabled ? 'on' : 'off'} → ${sessionId}`);
        return send(res, 200, { ok: true, sessionId, enabled: features.isEnabled(sessionId) });
      }
      return send(res, 405, { ok: false, error: 'method not allowed' });
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      let live = [];
      try {
        live = liveAgents();
      } catch (error) {
        return send(res, 500, { ok: false, error: String((error && error.message) || error) });
      }
      const uptimeMs = Date.now() - startedAt;
      return send(res, 200, {
        ok: true,
        port: listeningPort,
        version,
        sessions: live.length,
        busy: live.filter((agent) => agent && agent.status === 'running').length,
        queued: pendingCount(),
        delivered: counters.delivered,
        failed: counters.failed,
        dropped: counters.dropped,
        lastDeliveredAt,
        uptimeSec: Math.floor(uptimeMs / 1000),
        uptimeMs,
        dedupe: dedupe.size,
        features: features.list().length,
        config: configIssueOf(options.configPath || configFile()),
      });
    }

    if (req.method === 'GET' && url.pathname === '/sessions') {
      if (!tokenOk) return send(res, 401, { ok: false, error: 'bad token' });
      let live = [];
      try {
        live = liveAgents();
      } catch (error) {
        return send(res, 500, { ok: false, error: String((error && error.message) || error) });
      }
      return send(res, 200, { ok: true, sessions: live.map(describeAgent) });
    }

    if (req.method === 'GET' && url.pathname.startsWith('/delivery/')) {
      if (!tokenOk) return send(res, 401, { ok: false, error: 'bad token' });
      const id = decodeURIComponent(url.pathname.slice('/delivery/'.length));
      const job = jobs.get(id);
      if (!job) return send(res, 404, { ok: false, error: 'unknown delivery id' });
      return send(res, 200, {
        ok: true,
        id: job.id,
        sessionId: job.sessionId,
        status: job.status,
        createdAt: job.createdAt,
        deliveredAt: job.deliveredAt || null,
        duplicateOf: job.duplicateOf || null,
        error: job.error || null,
      });
    }

    if (req.method === 'POST' && url.pathname === '/config') {
      if (!tokenOk) return send(res, 401, { ok: false, error: 'bad token' });
      let rawCfg = '';
      try {
        rawCfg = await readBody(req, MAX_BODY);
      } catch (error) {
        if (error && error.code === 'E_TOO_LARGE') return send(res, 413, { ok: false, error: 'body too large' });
        throw error;
      }
      let patch = {};
      try {
        patch = JSON.parse(rawCfg || '{}');
      } catch {
        return send(res, 400, { ok: false, error: 'bad json' });
      }
      const next = { ...cfg };
      if (patch.sessionId !== undefined) next.sessionId = String(patch.sessionId || '');
      const wantPort = Number(patch.port);
      if (patch.port !== undefined && Number.isFinite(wantPort) && wantPort >= 0 && wantPort < 65536) {
        next.port = wantPort;
      }
      saveCfg(next);
      return send(res, 200, {
        ok: true,
        sessionId: next.sessionId,
        port: next.port,
        note: 'port 变更需重启 DSH 生效',
      });
    }

    if (req.method === 'POST' && url.pathname === '/inbox') {
      if (!tokenOk) return send(res, 401, { ok: false, error: 'bad token' });
      let raw = '';
      try {
        raw = await readBody(req, MAX_BODY);
      } catch (error) {
        if (error && error.code === 'E_TOO_LARGE') return send(res, 413, { ok: false, error: 'body too large' });
        throw error;
      }
      let body = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        return send(res, 400, { ok: false, error: 'bad json' });
      }
      const text = String(body.text || '').trim();
      if (!text) return send(res, 400, { ok: false, error: 'empty text' });

      let live = [];
      try {
        live = liveAgents();
      } catch (error) {
        return send(res, 500, { ok: false, error: String((error && error.message) || error) });
      }
      const want = String(body.sessionId || cfg.sessionId || '');
      let agent = want ? ctx.agents.get(want) : null;
      if (!agent && !want && live.length === 1) agent = live[0];
      if (!agent && !want && live.length > 1) {
        const payload = { ok: false, error: 'multiple live sessions; specify sessionId' };
        if (tokenOk) payload.sessions = live.map(sessionIdOf);
        return send(res, 409, payload);
      }
      if (!agent) {
        const payload = { ok: false, error: 'no live session' };
        if (tokenOk) payload.sessions = live.map(sessionIdOf);
        return send(res, 404, payload);
      }

      const sessionId = sessionIdOf(agent);
      const dedupeKey = String(body.dedupeKey || '').trim();
      const scope = dedupeKey ? `${sessionId}|${dedupeKey}` : '';
      if (scope) {
        const hit = dedupe.get(scope);
        if (hit) {
          const job = jobs.get(hit.id);
          return send(res, body.wait ? 200 : 202, {
            ok: true,
            queued: false,
            duplicate: true,
            id: hit.id,
            sessionId,
            ...(job ? { status: job.status } : {}),
          });
        }
      }

      if (pendingCount() >= MAX_PENDING) {
        return send(res, 429, { ok: false, error: 'queue full', queued: pendingCount() });
      }

      const onBusy = ['queue', 'wait', 'drop'].includes(body.onBusy) ? body.onBusy : 'queue';
      const busy = agent.status === 'running';
      if (busy && onBusy === 'drop') {
        counters.dropped += 1;
        log(`dropped: ${sessionId} busy (${text.length} chars)`);
        return send(res, 200, { ok: true, dropped: true, reason: 'busy', sessionId });
      }

      const source = String(body.source || '').trim().slice(0, 40);
      const newJob = () => {
        const job = {
          id: crypto.randomUUID(),
          // messageId 单独生成：/delivery 的 id 是投递单号，消息 id 是会话历史里的 id
          messageId: crypto.randomUUID(),
          sessionId,
          text,
          bytes: Buffer.byteLength(text, 'utf8'),
          dedupeKey,
          source,
          prefix: source ? `[inbox-bridge:${source}] ` : '[inbox-bridge] ',
          createdAt: Date.now(),
          status: 'queued',
        };
        rememberJob(job);
        journal.append({ ...journalRecord(job), verdict: 'accepted' });
        if (scope) dedupe.add(scope, job.id, job.createdAt);
        return job;
      };

      // wait:true / onBusy=wait：先真的等空闲。等到了才投；等不到就排队，绝不硬塞。
      const wantsIdle = onBusy === 'wait' || Boolean(body.wait);
      // 先登记（dedupe + journal）再 await：否则并发同 dedupeKey 的请求都能通过检查而双投
      const job = newJob();
      if (busy && wantsIdle) {
        const waitMs = clampWait(body.maxWaitMs);
        const idle = await waitForIdle(agent, waitMs);
        if (!idle) {
          queueWhenIdle(job);
          log(`wait ${waitMs}ms 未空闲，转后台排队 ${job.id} → ${sessionId}`);
          return send(res, 202, {
            ok: true,
            queued: true,
            delivered: false,
            waited: true,
            id: job.id,
            sessionId,
            status: job.status,
            note: `${waitMs}ms 内未空闲，已排队，空闲后自动投递；可用 GET /delivery/{id} 查`,
          });
        }
      }
      deliver(job);
      if (job.status === 'failed') {
        return send(res, 500, { ok: false, id: job.id, sessionId, status: job.status, error: job.error });
      }
      if (body.wait) {
        return send(res, 200, {
          ok: true,
          delivered: true,
          queued: job.busy,
          id: job.id,
          sessionId,
          status: job.status,
          waited: wantsIdle && busy,
        });
      }
      return send(res, 202, {
        ok: true,
        queued: job.busy,
        delivered: true,
        id: job.id,
        sessionId,
        status: job.status,
        waited: wantsIdle && busy,
      });
    }

    return send(res, 404, { ok: false, error: 'not found' });
  }

  function resolvePort(cfg) {
    const fromEnv = process.env.INBOX_BRIDGE_PORT;
    if (fromEnv !== undefined && fromEnv !== '') {
      const port = Number(fromEnv);
      if (Number.isFinite(port) && port >= 0 && port < 65536) return port;
    }
    const port = Number(cfg.port);
    if (Number.isFinite(port) && port >= 0 && port < 65536) return port;
    return DEFAULT_PORT;
  }

  async function start() {
    if (server) return listeningPort;
    const cfg = readCfg();
    const port = resolvePort(cfg);
    loadJournal();
    const instance = http.createServer((req, res) => {
      handle(req, res).catch((error) => {
        log(`request failed: ${(error && error.message) || error}`);
        try {
          if (!res.headersSent) send(res, 500, { ok: false, error: String((error && error.message) || error) });
          else res.end();
        } catch {
          // 响应已发出去，忽略
        }
      });
    });
    instance.requestTimeout = REQUEST_TIMEOUT_MS;
    instance.headersTimeout = 10_000;
    instance.keepAliveTimeout = 5_000;
    instance.on('error', (error) => {
      log(`server error: ${(error && error.message) || error}`);
    });
    server = instance;
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          instance.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          instance.off('error', onError);
          resolve();
        };
        instance.once('listening', onListening);
        instance.once('error', onError);
        instance.listen(port, '127.0.0.1');
      });
    } catch (error) {
      server = null;
      throw error;
    }
    listeningPort = (instance.address() && instance.address().port) || port;
    log(`listening on http://127.0.0.1:${listeningPort} (v${version})`);
    if (pending.length) replayPending();
    return listeningPort;
  }

  async function stop() {
    // 还没投的条目留在 JSONL 里，下次启动补投；其余都是同步写，没有要 flush 的缓冲。
    stopped = true;
    waiting.clear();
    stopPump();
    dedupe.clear();
    const instance = server;
    server = null;
    listeningPort = 0;
    if (!instance) return;
    await new Promise((resolve) => {
      instance.close(() => resolve());
      if (typeof instance.closeAllConnections === 'function') instance.closeAllConnections();
    });
  }

  return {
    start,
    stop,
    get port() {
      return listeningPort;
    },
    get server() {
      return server;
    },
    get dedupeSize() {
      return dedupe.size;
    },
    get counters() {
      return { ...counters, lastDeliveredAt };
    },
    get jobs() {
      return jobs;
    },
  };
}

export function apply(ctx) {
  const bridge = createBridge(ctx);
  bridge.start().catch((error) => {
    console.error(
      `[inbox-bridge] failed to listen: ${(error && error.message) || error}；` +
        `改 ${configFile()} 的 port 后重启 DSH`,
    );
  });
  ctx.effect(() => () => bridge.stop());
}
