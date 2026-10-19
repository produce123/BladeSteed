/**
 * BladeSteed — 极简事件发射器
 * 会话与驱动都用它，避免各处重复实现。
 */

export class Emitter {
  constructor() {
    this._handlers = {};
  }

  on(name, cb) {
    (this._handlers[name] ||= []).push(cb);
    return this;
  }

  off(name, cb) {
    const list = this._handlers[name];
    if (list) this._handlers[name] = list.filter((x) => x !== cb);
    return this;
  }

  emit(name, ...args) {
    for (const cb of (this._handlers[name] || []).slice()) {
      try {
        cb(...args);
      } catch (e) {
        console.error(`事件 ${name} 处理失败`, e);
      }
    }
  }
}