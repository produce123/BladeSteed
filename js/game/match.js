/**
 * BladeSteed — 对局驱动
 *
 * 把「引擎 + AI」编排成一场会自己往前走的比赛：
 *   · 定时 tick() 推进超时（猜拳 10 秒、排序 15 秒、单步行动 60 秒）
 *   · 轮到 AI 时延迟一点再动手，玩家才看得清 AI 做了什么
 *   · 任何状态变化都 emit('change')，由会话层决定怎么广播
 *
 * 单机人机与联机房主共用这一个类 —— 所以「房主是唯一权威状态机」不是额外写的逻辑，
 * 而是同一份代码的两种用法。
 */

import { Emitter } from './emitter.js';
import { Match } from '../engine/engine.js';
import { viewFor } from '../engine/view.js';
import { PHASE } from '../engine/constants.js';
import { aiStep, makeBrains } from '../ai/ai.js';

/** 心跳间隔：推进超时用的 */
const TICK_MS = 250;

export class GameDriver extends Emitter {
  /**
   * @param {object} opts
   * @param {{id:string,name:string,isAI?:boolean}[]} opts.roster
   * @param {number} [opts.seed]
   */
  constructor({ roster, seed }) {
    super();
    this.roster = roster.map((p) => ({ id: p.id, name: p.name, isAI: !!p.isAI }));
    this.engine = new Match({ players: this.roster, seed });
    this.brains = makeBrains(this.engine.players);
    this._timer = null;
    this._aiTimer = null;
    this._stopped = true;
  }

  /* ---------------------------- 生命周期 ---------------------------- */

  start() {
    if (!this._stopped) return;
    this._stopped = false;
    this._timer = setInterval(() => {
      if (this.engine.tick()) this.notify();
    }, TICK_MS);
    this._scheduleAi();
  }

  stop() {
    this._stopped = true;
    clearInterval(this._timer);
    clearTimeout(this._aiTimer);
    this._timer = null;
    this._aiTimer = null;
  }

  /** 一键重新开局：座位重洗、血量装备全重置，AI 性格不变但记忆清空 */
  restart() {
    const roster = this.engine.players.map((p) => ({ id: p.id, name: p.name, isAI: p.isAI }));
    this.engine = new Match({ players: roster });
    this.brains = makeBrains(this.engine.players);
    this.notify();
  }

  /* ---------------------------- 输入 ---------------------------- */

  submitRps(pid, choice) {
    const r = this.engine.submitRps(pid, choice);
    if (r.ok) this.notify();
    return r;
  }

  submitOrder(pid, order) {
    const r = this.engine.submitOrder(pid, order);
    if (r.ok) this.notify();
    return r;
  }

  act(pid, action) {
    const r = this.engine.act(pid, action);
    if (r.ok) this.notify();
    return r;
  }

  /** 中途加入（房主加 AI 补位用） */
  addPlayer(p) {
    const r = this.engine.addPlayer(p);
    if (r.ok) this.notify();
    return r;
  }

  /** 玩家离开 / 断连 → 立刻判出局 */
  removePlayer(pid) {
    const r = this.engine.leave(pid);
    if (r.ok) this.notify();
    return r;
  }

  viewFor(pid) {
    return viewFor(this.engine, pid);
  }

  /** 通用的「状态变了」通知：顺手把 AI 的下一步排上 */
  notify() {
    this.emit('change');
    this._scheduleAi();
  }

  /* ---------------------------- AI 调度 ---------------------------- */

  /** 现在有没有 AI 在等？ */
  hasPendingAi() {
    const e = this.engine;
    if (e.phase === PHASE.RPS && e.rps) {
      return e.alive().some((p) => p.isAI && !e.rps.submitted[p.id]);
    }
    if (e.phase === PHASE.ORDER && e.mini) {
      if (e.mini.decider) return e.player(e.mini.decider)?.isAI === true;
      return e.mini.candidates.some((id) => e.player(id)?.isAI && !e.mini.submitted[id]);
    }
    if (e.phase === PHASE.ACTION) return e.player(e.current)?.isAI === true;
    return false;
  }

  /**
   * AI 思考延时。
   * 刻意留出这段时间：一是让真人看清自己出的拳和 AI 出的拳，
   * 二是让「谁先谁后」在界面上有节奏，而不是瞬间刷屏。
   */
  _aiDelay() {
    const e = this.engine;
    if (e.phase === PHASE.RPS && e.rps && e.alive().some((p) => p.isAI && !e.rps.submitted[p.id])) {
      return 1400 + Math.random() * 1500;
    }
    if (e.phase === PHASE.ORDER && e.mini) {
      if (e.mini.decider && e.player(e.mini.decider)?.isAI) return 900 + Math.random() * 700;
      if (!e.mini.decider && e.mini.candidates.some((id) => e.player(id)?.isAI && !e.mini.submitted[id])) {
        return 900 + Math.random() * 900;
      }
    }
    if (e.phase === PHASE.ACTION && e.player(e.current)?.isAI) return 750 + Math.random() * 650;
    return null;
  }

  _scheduleAi() {
    if (this._stopped || this._aiTimer) return;
    const delay = this._aiDelay();
    if (delay == null) return;
    this._aiTimer = setTimeout(() => {
      this._aiTimer = null;
      if (this._stopped) return;
      const acted = aiStep(this.engine, this.brains, viewFor);
      if (acted) this.notify();
      else this._scheduleAi();
    }, delay);
  }
}