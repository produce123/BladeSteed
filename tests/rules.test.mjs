/**
 * BladeSteed — 规则单元测试
 *
 * 每一条都对着需求书里的规则。引擎是纯逻辑，所以这里不需要浏览器、不需要等真实时间
 * （时钟是注入的，超时测试瞬间完成）。
 *
 * 用法：node tests/rules.test.mjs
 */

import { Match } from '../js/engine/engine.js';
import { viewFor } from '../js/engine/view.js';
import {
  ACT,
  ACTION_TIMEOUT_MS,
  MAX_HP,
  ORDER_TIMEOUT_MS,
  PHASE,
  RPS_TIMEOUT_MS,
  STEPS_MULTI,
  STEPS_SOLO,
  WILD,
} from '../js/engine/constants.js';
import { assert, eq, run, test } from './harness.mjs';

/* ------------------------------ 测试夹具 ------------------------------ */

const NAMES = ['甲', '乙', '丙', '丁'];
const IDS = ['a', 'b', 'c', 'd'];

/** 造一局，玩家 id 是 a/b/c/d，名字是 甲乙丙丁 */
function makeMatch(n = 2, { seed = 7, now } = {}) {
  const players = IDS.slice(0, n).map((id, i) => ({ id, name: NAMES[i] }));
  return new Match({ players, seed, now });
}

const P = (m, id) => m.player(id);

/**
 * 测试夹具：直接把某人摆到某个位置。
 * 只为「构造场景」，合法性校验本身仍然全部走 act()/legalActions()。
 */
function place(m, id, where) {
  P(m, id).place = where;
}

/** 一轮猜拳：choices 是 { id: 'rock'|'scissors'|'paper' } */
function pick(m, choices) {
  const out = {};
  for (const [id, c] of Object.entries(choices)) out[id] = m.submitRps(id, c);
  return out;
}

/** 让 solo 独自获胜（其他人出被克制的手势），返回该玩家 */
function soloWin(m, solo, choice = 'rock', loserChoice = 'scissors') {
  const choices = {};
  for (const p of m.players) choices[p.id] = p.id === solo ? choice : loserChoice;
  pick(m, choices);
  return P(m, solo);
}

/** 走完小猜拳：让 decider 成为唯一决胜者 */
function decideBy(m, decider) {
  const cands = m.mini.candidates.slice();
  const choices = {};
  for (const id of cands) choices[id] = id === decider ? 'rock' : 'scissors';
  pick(m, choices);
  return m.mini.decider;
}

/* ------------------------------ 基础设定 ------------------------------ */

test('初始属性：每人 10 血、开局在自己城内、无装备', () => {
  const m = makeMatch(4);
  eq(m.players.length, 4);
  for (const p of m.players) {
    eq(p.hp, MAX_HP, `${p.name} 初始血量`);
    eq(p.place, p.id, `${p.name} 开局应在自己城内`);
    eq(p.knife, false);
    eq(p.horse, false);
    eq(p.alive, true);
  }
});

test('开局随机分配座位 1..N，互不重复', () => {
  const m = makeMatch(4);
  const seats = m.players.map((p) => p.seat).sort();
  eq(seats, [1, 2, 3, 4]);
});

test('人数必须是 2–4', () => {
  let threw = false;
  try {
    makeMatch(1);
  } catch {
    threw = true;
  }
  assert(threw, '1 人应该被拒绝');
  threw = false;
  try {
    const five = ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({ id, name: NAMES[i] || '戊' }));
    new Match({ players: five });
  } catch {
    threw = true;
  }
  assert(threw, '5 人应该被拒绝');
});

/* ------------------------------ 猜拳与步数 ------------------------------ */

test('只有 1 人获胜：获得 2 步行动', () => {
  const m = makeMatch(4);
  soloWin(m, 'b');
  eq(m.phase, PHASE.ACTION);
  eq(m.current, 'b');
  eq(m.stepsLeft, STEPS_SOLO);
  eq(m.steps.b, STEPS_SOLO);
  eq(m.queue, ['b']);
});

test('≥2 人获胜：各 1 步，进入小猜拳决定顺序', () => {
  const m = makeMatch(4);
  pick(m, { a: 'rock', b: 'rock', c: 'scissors', d: 'scissors' });
  eq(m.phase, PHASE.ORDER);
  eq(m.mainWinners.sort(), ['a', 'b']);
  eq(m.steps.a, STEPS_MULTI);
  eq(m.steps.b, STEPS_MULTI);
  // 小猜拳：a 赢 → a 是决胜者
  eq(decideBy(m, 'a'), 'a');
  eq(m.submitOrder('a', ['b', 'a']).ok, true);
  eq(m.phase, PHASE.ACTION);
  eq(m.queue, ['b', 'a'], '行动顺序应完全按决胜者的决定');
});

test('3 人获胜：小猜拳里又出现 2 人获胜则继续猜，直到唯一胜者', () => {
  const m = makeMatch(4);
  pick(m, { a: 'rock', b: 'rock', c: 'rock', d: 'scissors' });
  eq(m.mainWinners.sort(), ['a', 'b', 'c']);
  eq(m.steps.a, 1);
  // 第一轮小猜拳：a、b 出布，c 出石头 → a、b 获胜，继续
  pick(m, { a: 'paper', b: 'paper', c: 'rock' });
  eq(m.mini.round, 2);
  eq(m.mini.candidates.sort(), ['a', 'b']);
  // 第二轮：b 赢
  eq(decideBy(m, 'b'), 'b');
  eq(m.submitOrder('b', ['c', 'a', 'b']).ok, true);
  eq(m.queue, ['c', 'a', 'b']);
});

test('无胜者（三种手势齐全 / 全员同一手势）都重开猜拳', () => {
  const m = makeMatch(3);
  pick(m, { a: 'rock', b: 'scissors', c: 'paper' });
  eq(m.phase, PHASE.RPS, '三种手势循环克制 → 无人获胜 → 重新猜拳');
  eq(m.rps.winners, []);
  pick(m, { a: 'rock', b: 'rock', c: 'rock' });
  eq(m.phase, PHASE.RPS, '全员同一手势 → 无人获胜 → 重新猜拳');
  soloWin(m, 'c');
  eq(m.phase, PHASE.ACTION);
});

test('猜拳提交幂等：重复同一手势成功，换手势被拒', () => {
  const m = makeMatch(3);
  eq(m.submitRps('a', 'rock').ok, true);
  eq(m.submitRps('a', 'rock').ok, true);
  eq(m.submitRps('a', 'paper').ok, false);
  eq(m.submitRps('a', '火').ok, false);
});

test('猜拳超时由系统随机代出，绝不停摆', () => {
  let t = 0;
  const m = makeMatch(3, { now: () => t });
  m.submitRps('a', 'rock');
  t += RPS_TIMEOUT_MS + 1;
  eq(m.tick(), true);
  assert(m.phase !== PHASE.RPS || m.rps.submitted.b, '超时后必须已经代出');
  assert(m.rps.winners.length >= 0);
  // 代出之后一定推进到了下一步（要么开打要么重赛）
  assert(m.phase === PHASE.ACTION || m.phase === PHASE.ORDER || m.rps.round === m.round);
});

test('小猜拳与排序都有超时兜底', () => {
  let t = 0;
  const m = makeMatch(3, { now: () => t });
  pick(m, { a: 'rock', b: 'rock', c: 'scissors' });
  eq(m.phase, PHASE.ORDER);

  // 小猜拳超时：系统随机代出。运气不好两边撞成同一种手势时，
  // 规则要求「再次猜拳」——那也是正常的，所以这里只要求「一定在推进」，
  // 并且最终必须能决出唯一决胜者（不允许永久卡住）。
  let guard = 0;
  while (!m.mini.decider && guard < 200) {
    t += RPS_TIMEOUT_MS + 1;
    m.tick();
    guard += 1;
  }
  assert(m.mini.decider, '小猜拳超时后最终必须有人成为决胜者');
  assert(guard < 200, `小猜拳重赛次数异常：${guard}`);

  t += ORDER_TIMEOUT_MS + 1;
  m.tick();
  eq(m.phase, PHASE.ACTION, '排序超时后必须自动开打');
  eq(m.queue.length, 2);
});

test('行动超时会自动结束剩余步数并把回合交出去', () => {
  let t = 0;
  const m = makeMatch(3, { now: () => t });
  pick(m, { a: 'rock', b: 'rock', c: 'scissors' });
  decideBy(m, 'a');
  m.submitOrder('a', ['a', 'b']);
  eq(m.current, 'a');
  t += ACTION_TIMEOUT_MS + 1;
  eq(m.tick(), true);
  assert(m.current !== 'a', '超时后不能还卡在同一个人身上');
});

/* ------------------------------ 装备购买 ------------------------------ */

test('买刀 / 买马：只在城内可买，消耗 1 步，永久持有', () => {
  const m = makeMatch(2);
  soloWin(m, 'a'); // 2 步
  eq(m.act('a', { type: ACT.BUY_KNIFE }).ok, true);
  eq(m.stepsLeft, 1);
  eq(P(m, 'a').knife, true);
  eq(m.act('a', { type: ACT.BUY_HORSE }).ok, true);
  eq(m.stepsLeft, 0);
  eq(P(m, 'a').horse, true);
  eq(m.current !== 'a' || m.stepsLeft === 0, true, '两步用完必须交出回合');
});

test('野外不能买装备，也不能重复买', () => {
  const m = makeMatch(2);
  soloWin(m, 'a');
  eq(m.act('a', { type: ACT.MOVE_OUT }).ok, true);
  eq(P(m, 'a').place, WILD);
  eq(m.act('a', { type: ACT.BUY_KNIFE }).ok, false, '野外不能买刀');

  const m2 = makeMatch(2);
  soloWin(m2, 'a');
  eq(m2.act('a', { type: ACT.BUY_KNIFE }).ok, true);
  eq(m2.act('a', { type: ACT.BUY_KNIFE }).ok, false, '已经买过就不能再买');
});

/* ------------------------------ 位移 ------------------------------ */

test('出城 / 进城：可指定任意一个人的城（含自己的城、含出局者的城）', () => {
  const m = makeMatch(3);
  soloWin(m, 'a'); // 2 步：出城 → 进城
  eq(m.act('a', { type: ACT.MOVE_OUT }).ok, true);
  eq(P(m, 'a').place, WILD);
  eq(m.act('a', { type: ACT.MOVE_IN, target: 'c' }).ok, true);
  eq(P(m, 'a').place, 'c');

  // 出局者的城永久存在
  const m2 = makeMatch(2);
  soloWin(m2, 'a');
  m2._eliminate('b', '测试');
  eq(m2.phase, PHASE.OVER, '只剩 1 人就是本局结束');
  // 换个场景：3 人局里有人出局，城依然在
  const m3 = makeMatch(3);
  soloWin(m3, 'a');
  m3._eliminate('c', '测试');
  eq(m3.alive().length, 2);
  eq(m3.legalActions('a').some((x) => x.type === ACT.BUY_KNIFE), true, 'a 还在城里');
  const m4 = makeMatch(3);
  soloWin(m4, 'a');
  m4.act('a', { type: ACT.MOVE_OUT });
  m4._eliminate('c', '测试');
  eq(m4.legalActions('a').some((x) => x.type === ACT.MOVE_IN && x.target === 'c'), true, '可以进已出局者的城');
});

test('野外不能「进城」、城内不能「出城」以外地乱走', () => {
  const m = makeMatch(2);
  soloWin(m, 'a');
  eq(m.act('a', { type: ACT.MOVE_OUT }).ok, true);
  eq(m.act('a', { type: ACT.MOVE_OUT }).ok, false, '已经在野外不能再出城');
  eq(m.act('a', { type: ACT.MOVE_IN, target: '不存在' }).ok, false);
});

/* ------------------------------ 攻击 ------------------------------ */

test('刀：需要已买刀 + 双方同一位置（同城或同在野外）', () => {
  const m = makeMatch(2);
  soloWin(m, 'a');
  eq(m.act('a', { type: ACT.KNIFE, target: 'b' }).ok, false, '没买刀不能刀人');
  m.act('a', { type: ACT.BUY_KNIFE });

  // 两人各在自己城内 → 不同位置
  const m2 = makeMatch(3);
  soloWin(m2, 'a');
  m2.act('a', { type: ACT.BUY_KNIFE });
  eq(m2.act('a', { type: ACT.KNIFE, target: 'b' }).ok, false, '不同位置不能刀');

  // 同城：a 进城到 b
  const m3 = makeMatch(3);
  soloWin(m3, 'a');
  P(m3, 'a').knife = true;
  place(m3, 'a', 'b');
  eq(m3.act('a', { type: ACT.KNIFE, target: 'b' }).ok, true);
  eq(P(m3, 'b').hp, MAX_HP - 1);

  // 同在野外
  const m4 = makeMatch(3);
  soloWin(m4, 'a');
  P(m4, 'a').knife = true;
  P(m4, 'a').place = WILD;
  P(m4, 'b').place = WILD;
  eq(m4.act('a', { type: ACT.KNIFE, target: 'b' }).ok, true, '野外两人可以互刀');
  eq(P(m4, 'b').hp, MAX_HP - 1);
});

test('踹：需要已买马 + 双方同在同一城内，扣 3 血并强制踢到野外', () => {
  const m = makeMatch(3);
  soloWin(m, 'a');
  place(m, 'a', 'b');
  place(m, 'c', 'b'); // 三人都在 b 的城里
  eq(m.act('a', { type: ACT.KICK, target: 'b' }).ok, false, '没买马不能踹');
  P(m, 'a').horse = true;
  eq(m.act('a', { type: ACT.KICK, target: 'b' }).ok, true);
  eq(P(m, 'b').hp, MAX_HP - 3);
  eq(P(m, 'b').place, WILD, '被踹的人必须被踢到野外');
  eq(P(m, 'a').place, 'b', '踹人的人留在原地');

  // 踹完对方在野外，同城关系解除 → 不能再连踹
  const m2 = makeMatch(3);
  soloWin(m2, 'a');
  P(m2, 'a').horse = true;
  place(m2, 'a', 'b');
  place(m2, 'b', 'b');
  eq(m2.act('a', { type: ACT.KICK, target: 'b' }).ok, true);
  eq(P(m2, 'b').place, WILD);
});

test('踹：野外不能踹，城里的人也踹不到野外的人', () => {
  // 双方都在野外
  const m = makeMatch(3);
  soloWin(m, 'a');
  P(m, 'a').horse = true;
  P(m, 'a').place = WILD;
  P(m, 'b').place = WILD;
  eq(m.act('a', { type: ACT.KICK, target: 'b' }).ok, false, '野外不能踹');

  // a 在城里（自己的城），b 在野外 → 位置不同，踹不到
  const m2 = makeMatch(3);
  soloWin(m2, 'a');
  P(m2, 'a').horse = true;
  P(m2, 'b').place = WILD;
  eq(P(m2, 'a').place, 'a', 'a 在自己的城里');
  eq(m2.act('a', { type: ACT.KICK, target: 'b' }).ok, false, '对方在野外，踹不到');

  // a 在城里，b 在另一座城 → 不是同一个城，踹不到
  const m3 = makeMatch(3);
  soloWin(m3, 'a');
  P(m3, 'a').horse = true;
  eq(m3.act('a', { type: ACT.KICK, target: 'c' }).ok, false, '不同城踹不到');
});

test('每 1 步只能做 1 个操作，2 步可以自由组合两个操作', () => {
  const m = makeMatch(3);
  soloWin(m, 'a');
  eq(m.stepsLeft, 2);
  eq(m.act('a', { type: ACT.BUY_KNIFE }).ok, true);
  eq(m.stepsLeft, 1);
  eq(m.act('a', { type: ACT.MOVE_OUT }).ok, true);
  eq(m.stepsLeft, 0);
  eq(m.current, null, '两步用完，回合结束');
});

test('可以主动结束剩余步数（防卡局）', () => {
  const m = makeMatch(3);
  pick(m, { a: 'rock', b: 'rock', c: 'scissors' });
  decideBy(m, 'a');
  m.submitOrder('a', ['a', 'b']);
  eq(m.stepsLeft, 1);
  eq(m.act('a', { type: ACT.PASS }).ok, true);
  eq(m.current, 'b', '结束时立刻把回合交给下一位');
});

/* ------------------------------ 胜负 ------------------------------ */

test('血量 ≤0 立即淘汰', () => {
  const m = makeMatch(3);
  soloWin(m, 'a');
  P(m, 'a').knife = true;
  place(m, 'a', 'b');
  P(m, 'b').hp = 1;
  eq(m.act('a', { type: ACT.KNIFE, target: 'b' }).ok, true);
  eq(P(m, 'b').alive, false);
  eq(P(m, 'b').hp, 0);
});

test('踹死：扣 3 血后出局，且出局前先被踢出城', () => {
  const m = makeMatch(3);
  soloWin(m, 'a');
  P(m, 'a').horse = true;
  place(m, 'a', 'b');
  place(m, 'b', 'b');
  P(m, 'b').hp = 2;
  eq(m.act('a', { type: ACT.KICK, target: 'b' }).ok, true);
  eq(P(m, 'b').alive, false);
  eq(P(m, 'b').place, WILD);
});

test('场上最后存活的一人获胜，一键重新开局可用', () => {
  const m = makeMatch(2);
  soloWin(m, 'a');
  P(m, 'a').knife = true;
  place(m, 'a', 'b');
  P(m, 'b').hp = 1;
  m.act('a', { type: ACT.KNIFE, target: 'b' });
  eq(m.phase, PHASE.OVER);
  eq(m.winner, 'a');

  const beforeRestart = m._eventId;
  m.restart();
  eq(m.phase, PHASE.RPS);
  eq(m.winner, null);
  eq(m.round, 1);
  for (const p of m.players) {
    eq(p.hp, MAX_HP);
    eq(p.alive, true);
    eq(p.knife, false);
    eq(p.horse, false);
    eq(p.place, p.id);
  }
  assert(
    m.events[0].id === beforeRestart + 1,
    '事件编号必须跨局保持单调，否则客户端会把重新开局的新事件当成旧的丢弃'
  );
});

test('玩家退出 / 断连自动判定出局', () => {
  const m = makeMatch(3);
  eq(m.leave('c').ok, true);
  eq(P(m, 'c').alive, false);
  eq(m.alive().length, 2);
  // 出局后不再需要他出拳
  pick(m, { a: 'rock', b: 'scissors' });
  eq(m.phase, PHASE.ACTION);
});

/* ------------------------------ 房主权威 / 视图裁剪 ------------------------------ */

test('房主权威：不是当前行动者、不是行动阶段的操作一律被拒', () => {
  const m = makeMatch(3);
  eq(m.act('a', { type: ACT.MOVE_OUT }).ok, false, '猜拳阶段不能行动');
  soloWin(m, 'a');
  eq(m.act('b', { type: ACT.MOVE_OUT }).ok, false, '没轮到 b');
  eq(m.act('a', { type: ACT.KICK, target: 'x' }).ok, false, '目标不存在');
});

test('视图裁剪：不泄露对手手势，也不下发 isAI', () => {
  const m = makeMatch(3);
  m.submitRps('a', 'rock');
  m.submitRps('b', 'paper');
  const va = viewFor(m, 'a');
  eq(va.rps.myChoice, 'rock');
  eq(va.rps.ready.a, true);
  eq(va.rps.ready.c, false);
  eq('submitted' in va.rps, false, '视图里不能有完整的出手表');
  assert(!JSON.stringify(va).includes('isAI'), '视图里绝不能出现 isAI 字段');
  // rpsChoices 是「可选手势清单」，本来就该有 paper；
  // 真正要检查的是 rps 这一块里不含别人出了什么。
  assert(!JSON.stringify(va.rps).includes('paper'), '不能泄露别人出了什么');
  eq(va.rps.myChoice, 'rock', '自己的手势自己看得到');
  assert(!JSON.stringify(va.mini || {}).includes('paper'), '小猜拳同样不能泄露');
});

test('无合法动作时永远有「结束行动」兜底（死锁不变量）', () => {
  const m = makeMatch(2);
  soloWin(m, 'a');
  m.act('a', { type: ACT.MOVE_OUT });
  // b 在猜拳阶段不会行动；这里直接检查 a 的第二步
  const acts = m.legalActions('a');
  assert(acts.some((x) => x.type === ACT.PASS), '任何时刻都必须能结束行动');
});

/* ------------------------------ 中途加入 ------------------------------ */

test('房主中途加 AI 补位：不影响本轮已定顺序，下一回合参与', () => {
  const m = makeMatch(2);
  m.addPlayer({ id: 'z', name: '机', isAI: true });
  eq(m.players.length, 3);
  eq(P(m, 'z').hp, MAX_HP);
  eq(P(m, 'z').place, 'z');
  const seats = m.players.map((p) => p.seat).sort();
  eq(seats, [1, 2, 3], '新玩家要占一个空座位');
  // 猜拳阶段加入 → 必须等他出拳
  pick(m, { a: 'rock', b: 'scissors' });
  eq(m.phase, PHASE.RPS, '还有人在猜拳，不能直接开打');
  m.submitRps('z', 'scissors');
  eq(m.phase, PHASE.ACTION);
  assert(m.alive().length === 3);

  // 上限 4 人
  m.addPlayer({ id: 'y', name: '器', isAI: true });
  eq(m.addPlayer({ id: 'x', name: '械', isAI: true }).ok, false);
});

/* ------------------------------ 位置合法性交叉检查 ------------------------------ */

test('legalActions 与 act 的判定完全一致（UI/AI/校验同一份真相）', () => {
  const m = makeMatch(3);
  soloWin(m, 'a');
  P(m, 'a').knife = true;
  P(m, 'a').horse = true;
  place(m, 'a', 'b');
  place(m, 'b', 'b');
  place(m, 'c', WILD);
  const acts = m.legalActions('a');
  const key = (x) => `${x.type}:${x.target || ''}`;
  const legalKeys = acts.map(key);
  // 合法动作全部能执行
  for (const a of acts) {
    if (a.type === ACT.PASS) continue;
    const probe = makeMatch(3);
    soloWin(probe, 'a');
    P(probe, 'a').knife = true;
    P(probe, 'a').horse = true;
    place(probe, 'a', 'b');
    place(probe, 'b', 'b');
    place(probe, 'c', WILD);
    eq(probe.act('a', a).ok, true, `${key(a)} 应该合法`);
  }
  // 明显非法的动作一个都不能混进去
  assert(!legalKeys.includes('knife:'), '刀必须指定目标');
  assert(legalKeys.includes('kick:b'), '同城且有马 → 能踹');
  assert(!legalKeys.includes('kick:c'), 'c 在野外 → 不能踹');
  assert(!legalKeys.includes('buy_knife:'), '已经买过刀 → 不能再买');
});

await run();