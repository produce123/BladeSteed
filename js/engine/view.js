/**
 * BladeSteed — 视图裁剪
 *
 * 房主是唯一权威，客人拿到的永远是「裁剪后的视图」。
 * 这里唯一需要保密的信息是**猜拳还没揭晓时各自出了什么**；
 * 血量 / 位置 / 装备 / 行动顺序本来就是公开信息。
 *
 * 特别注意：视图里**绝不下发 isAI 字段**。
 * AI 与真人吃的是同一个 viewFor() 的结果，
 * 所以「AI 知道谁是真人」在结构上就不可能发生，也就不会针对或保护谁。
 */

import { KEEP_EVENTS, KEEP_LOG, PHASE, RPS } from './constants.js';

/** 只保留「谁已经出过拳」，不泄露出了什么 */
function readyMap(engine, submitted, ids) {
  const out = {};
  for (const id of ids) out[id] = !!(submitted && submitted[id]);
  return out;
}

/**
 * 生成某个玩家（或观战者 viewerId=null）该看到的视图。
 * @param {import('./engine.js').Match} engine
 * @param {string|null} viewerId
 */
export function viewFor(engine, viewerId) {
  const now = engine.nowMs();

  // 公开的玩家信息（不含 isAI）
  const players = engine.players.map((p) => ({
    id: p.id,
    name: p.name,
    seat: p.seat,
    hp: p.hp,
    alive: p.alive,
    knife: p.knife,
    horse: p.horse,
    place: p.place,
  }));

  const rps = engine.rps
    ? {
        round: engine.rps.round,
        ready: readyMap(engine, engine.rps.submitted, engine.players.filter((p) => p.alive).map((p) => p.id)),
        myChoice: (viewerId && engine.rps.submitted[viewerId]) || null,
        winners: engine.rps.winners.slice(),
        deadlineIn: Math.max(0, engine.rps.deadline - now),
      }
    : null;

  const mini = engine.mini
    ? {
        round: engine.mini.round,
        candidates: engine.mini.candidates.slice(),
        ready: readyMap(engine, engine.mini.submitted, engine.mini.candidates),
        myChoice: (viewerId && engine.mini.submitted[viewerId]) || null,
        decider: engine.mini.decider,
        deadlineIn: Math.max(0, engine.mini.deadline - now),
      }
    : null;

  return {
    v: 1,
    rev: engine.rev,
    phase: engine.phase,
    round: engine.round,
    players,
    rps,
    mini,
    mainWinners: engine.mainWinners.slice(),
    steps: { ...engine.steps },
    queue: engine.queue.slice(),
    current: engine.current,
    stepsLeft: engine.stepsLeft,
    winner: engine.winner,
    /** 猜拳可用手势（客户端照着渲染按钮，避免两边写死不一致） */
    rpsChoices: RPS.slice(),
    actionDeadlineIn: engine.phase === PHASE.ACTION ? Math.max(0, engine.actionDeadline - now) : 0,
    log: engine.log.slice(-KEEP_LOG),
    /** 动画事件：客户端按 id 去重后依次播放 */
    events: engine.events.slice(-KEEP_EVENTS),
  };
}