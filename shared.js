/**
 * shared：桥与换模型工具共用的小工具。
 *
 *  · FeatureStore —— 按会话记录"是否允许发起跨会话操作"，落盘 JSON（原子写）；
 *  · sessionIdOf —— 从 Agent 上取会话 id；
 *  · messageFor / deliver —— 构造一条用户消息并 followup 进目标会话（会话忙就排下一轮）。
 *
 * 两个插件 row 导入的是同一个模块实例，所以内存/文件状态天然共享。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/** 默认状态文件：可用 $SESSION_BRIDGE_FEATURES 覆盖。 */
export function defaultFeaturesFile() {
  return process.env.SESSION_BRIDGE_FEATURES || path.join(os.homedir(), '.dsh', 'session-bridge-features.json');
}

/**
 * 按会话的开关存储：`{ "enabled": ["session-…"] }`。
 * 读失败/损坏时按"全关"处理，不抛错；写失败只记日志。
 */
export class FeatureStore {
  constructor(file = defaultFeaturesFile(), { log } = {}) {
    this.file = file;
    this.log = log || (() => {});
  }

  read() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        enabled: Array.isArray(data && data.enabled) ? data.enabled.map(String) : [],
      };
    } catch {
      return { enabled: [] };
    }
  }

  write(data) {
    const tmp = `${this.file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
      return true;
    } catch (error) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // 临时文件可能没建出来
      }
      this.log(`features write failed: ${(error && error.message) || error}`);
      return false;
    }
  }

  isEnabled(sessionId) {
    return this.read().enabled.includes(String(sessionId));
  }

  set(sessionId, enabled) {
    const id = String(sessionId);
    const current = this.read();
    const set = new Set(current.enabled);
    if (enabled) set.add(id);
    else set.delete(id);
    const next = { enabled: [...set] };
    this.write(next);
    return next.enabled;
  }

  list() {
    return this.read().enabled;
  }
}

/** 从 Agent 上取会话 id（兼容 id/sessionId/session.id 三种形态）。 */
export function sessionIdOf(agent) {
  if (!agent) return '';
  return String(agent.id || agent.sessionId || (agent.session && agent.session.id) || '');
}

/**
 * 构造一条用户消息，前缀规则：
 *   · 默认 `[session-bridge] `；
 *   · 给了 source 就是 `[session-bridge:<source>] `（最多 40 字）。
 */
export function messageFor(text, source = '') {
  const label = String(source || '').trim().slice(0, 40);
  const prefix = label ? `[session-bridge:${label}] ` : '[session-bridge] ';
  return {
    role: 'user',
    id: crypto.randomUUID(),
    content: [{ type: 'text', text: prefix + String(text) }],
    source: { kind: 'user' },
  };
}

/**
 * 把一条消息同步入队到目标 Agent（DSH 的 followup 会排到下一轮）。
 * @returns {{ id: string, queued: boolean }}
 */
export function deliver(agent, text, source) {
  const message = messageFor(text, source);
  agent.followup(message);
  return { id: message.id, queued: agent && agent.status === 'running' };
}
