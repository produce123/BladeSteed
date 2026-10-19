/**
 * BladeSteed — 联机集成测试（真实公共信令通道）
 *
 * 这个测试**不模拟网络**：它真的去连公共 MQTT / ntfy 通道，真的走一遍
 * 「客人广播 HELLO → 房主应答 → 交换 SDP → 建立链路」的配对流程。
 *
 * Node 里没有 RTCPeerConnection，所以链路会自动落到**中转模式**——
 * 这刚好把「直连失败时的兜底路径」完整测了一遍（真实浏览器里的直连由 e2e 测试覆盖）。
 *
 * 验证点：
 *   · 三个人能靠 6 位房间号互相找到
 *   · 大厅名单在所有人那里一致
 *   · 开局后每个人只收到**自己该看到的那一份**状态，猜拳未揭晓前不泄露别人的手势
 *   · 三个客户端自动打完一整局，最终公开状态（血量/位置/装备/回合）完全一致
 *   · 客户端中途断线，房主立刻判他出局，其他人同步看到
 *
 * 用法：node tests/net.test.mjs
 */

import { ClientSession, HostSession } from '../js/net/session.js';
import { makeRoomCode } from '../js/net/protocol.js';
import { PHASE } from '../js/engine/constants.js';
import { legalActionsFrom } from '../js/engine/rules.js';
import { AiBrain } from '../js/ai/ai.js';
import { assert, eq, run, test } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等某个条件成立 */
async function waitFor(label, fn, timeoutMs = 60000, stepMs = 120) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(stepMs);
  }
  throw new Error(`等待超时：${label}`);
}

/**
 * 自动替一个会话出拳 / 排序 / 行动。
 * 用的是**客户端自己看到的视图**，动作再从 legalActionsFrom 里挑，
 * 所以它同时也验证了「客人拿到的视图足够自己做决策」。
 */
class Autopilot {
  constructor(session) {
    this.s = session;
    this.brain = new AiBrain(session.selfId);
    this.marks = new Set();
    this.lastRev = -1;
    this.lastActAt = 0;
    this.actions = 0;
    this.state = '?';
  }

  tick() {
    const v = this.s.view;
    if (!v || v.phase === PHASE.OVER) return;
    const me = v.players.find((p) => p.id === this.s.selfId);
    if (!me || !me.alive) return;

    if (v.phase === PHASE.RPS && v.rps) {
      const k = `rps-${v.round}`;
      if (!this.marks.has(k)) {
        this.marks.add(k);
        this.s.submitRps(this.brain.chooseHand(v));
      }
      return;
    }

    if (v.phase === PHASE.ORDER && v.mini) {
      if (v.mini.decider === this.s.selfId) {
        const k = `order-${v.round}`;
        if (!this.marks.has(k)) {
          this.marks.add(k);
          const others = v.mainWinners.filter((id) => id !== this.s.selfId);
          this.s.submitOrder([this.s.selfId, ...others]);
        }
      } else if (!v.mini.decider && v.mini.candidates.includes(this.s.selfId)) {
        const k = `mini-${v.round}-${v.mini.round}`;
        if (!this.marks.has(k)) {
          this.marks.add(k);
          this.s.submitRps(this.brain.chooseHand(v));
        }
      }
      return;
    }

    if (v.phase === PHASE.ACTION && v.current === this.s.selfId) {
      // 正常情况下 rev 一变就说明上一步已经被受理了。
      // 但中继通道是 QoS0，回执和广播都可能丢 —— 所以再加一条时间兜底：
      // 同一个 rev 上最多等 4 秒就重新决策一次（步数没变就再发，已经用掉就自然会被拒），
      // 不然一次丢包就要干等 60 秒的行动超时。
      const now = Date.now();
      if (this.lastRev === v.rev && now - this.lastActAt < 4000) return;
      this.lastRev = v.rev;
      this.lastActAt = now;
      const acts = legalActionsFrom(v, this.s.selfId);
      if (!acts.length) return;
      const action = this.brain.chooseAction(v);
      const ok = acts.some((a) => a.type === action.type && (a.target || null) === (action.target || null));
      this.s.act(ok ? action : { type: 'pass' });
      this.actions += 1;
    }
  }
}

/** 公开状态指纹：三个人必须完全一致 */
function publicFingerprint(view) {
  const players = view.players
    .map((p) => `${p.id}|${p.name}|${p.seat}|${p.hp}|${p.alive}|${p.knife}|${p.horse}|${p.place}`)
    .sort()
    .join(' ');
  return `${view.phase}|${view.round}|${players}|${view.winner || '-'}|${(view.mainWinners || []).slice().sort().join(',')}`;
}

/** 视图里猜拳那一块**只允许**出现这几个字段，多一个都可能是在泄露出拳 */
function assertNoHandLeak(view, tag) {
  if (view.rps) {
    const keys = Object.keys(view.rps).sort().join(',');
    eq(keys, 'deadlineIn,myChoice,ready,round,winners', `${tag}: rps 视图字段被改动，可能泄露了别人的手势`);
    for (const [pid, ready] of Object.entries(view.rps.ready)) {
      assert(typeof ready === 'boolean', `${tag}: ready 只能是布尔值`);
      if (pid !== view.__selfId) {
        assert(ready !== 'rock' && ready !== 'paper' && ready !== 'scissors', `${tag}: ready 里混进了手势`);
      }
    }
  }
  assert(!JSON.stringify(view).includes('isAI'), `${tag}: 视图里绝不能出现 isAI`);
}

test('真实公共通道：三人配对 + 大厅同步 + 打完整局 + 断线判负', async () => {
  const room = makeRoomCode();
  const host = new HostSession({ name: '甲', roomCode: room });
  const clients = [new ClientSession({ name: '乙' }), new ClientSession({ name: '丙' })];
  const sessions = [host, ...clients];
  let netInfo = '';

  try {
    const opened = await host.open({ timeoutMs: 8000 });
    assert(opened > 0, '房主连不上任何公共信令通道');

    // 两个客人依次加入（真去公共通道上找人）
    for (const c of clients) {
      const r = await c.join(room, { timeoutMs: 8000, waitMs: 25000 });
      assert(r.ok, `加入失败：${r.error}`);
    }

    // 大厅名单在三个人那里必须一致
    await waitFor('房主看到 3 个人', () => host.members.length === 3, 30000);
    for (const s of sessions) {
      await waitFor(`成员名单同步（${s.mode}）`, () => s.snapshot().members.length === 3, 30000);
    }
    const names = host.members.map((m) => m.name).sort().join('');
    eq(names.length, 3, '三个人的名字都该在名单里');

    const status = host.bus.status();
    netInfo = `公共通道 ${status.open} 条：${status.channels.map((c) => `${c.id}(${c.label})`).join('、')}`;

    // 开局
    const started = host.startMatch();
    assert(started.ok, `开局失败：${started.error}`);
    for (const s of sessions) {
      await waitFor(`收到第一帧状态（${s.mode}）`, () => !!s.view, 30000);
    }

    // 三个客户端各自自动打完一整局
    const pilots = sessions.map((s) => new Autopilot(s));
    const deadline = Date.now() + 300000;
    let lastReport = 0;
    let progress = '';
    while (Date.now() < deadline) {
      for (const p of pilots) p.tick();
      // 每次 tick 都对三份视图做「有没有泄露出拳」的全量检查太费 CPU（会拖慢对局），
      // 每秒查一轮足够了
      if (Date.now() - lastReport > 1000) {
        for (const s of sessions) {
          if (s.view) {
            s.view.__selfId = s.selfId;
            assertNoHandLeak(s.view, s.mode);
          }
        }
      }
      const done = sessions.every((s) => s.view && s.view.phase === PHASE.OVER);
      if (done) break;
      if (Date.now() - lastReport > 15000) {
        lastReport = Date.now();
        progress = sessions
          .map((s) => {
            const v = s.view;
            if (!v) return '无帧';
            return `${v.phase}/第${v.round}回合`;
          })
          .join(' | ');
        console.log(`  … 对局进行中：${progress}`);
      }
      await sleep(80);
    }

    const stuck = sessions.filter((s) => !s.view || s.view.phase !== PHASE.OVER);
    assert(
      stuck.length === 0,
      `还有 ${stuck.length} 家没能打完这一局（最后进度：${progress}）`
    );
    for (const p of pilots) assert(p.actions > 0, '自动打手一次都没行动过，说明链路根本没通');

    // 三家看到的最终公开状态必须完全一致
    const prints = sessions.map((s) => publicFingerprint(s.view));
    eq(new Set(prints).size, 1, `三家的公开状态不一致：\n${prints.join('\n')}`);
    const winner = host.view.winner;
    assert(winner, '必须有胜者');

    // 断线 → 立刻判出局（重新开一局来验证）
    host.restart();
    await waitFor('重新开局后三家都回到猜拳阶段', () => sessions.every((s) => s.view && s.view.phase === PHASE.RPS), 40000);
    const victim = clients[1];
    const victimId = victim.selfId;
    const before = host.members.length;
    eq(before, 3);
    victim.close(); // 直接拔线，什么也不发
    await waitFor(
      '房主在超时后把断线的人判出局',
      () => !host.members.some((m) => m.id === victimId) && host.view && !host.view.players.find((p) => p.id === victimId)?.alive,
      40000
    );
    const left = host.view.players.find((p) => p.id === victimId);
    eq(left.alive, false, '断线的人必须被判出局');
    await waitFor(
      '剩下的客人也看到这个人出局',
      () => !clients[0].view.players.find((p) => p.id === victimId)?.alive,
      40000
    );
    assert(host.view.phase === PHASE.OVER || host.view.players.filter((p) => p.alive).length >= 1, '状态必须自洽');

    console.log(`  ℹ ${netInfo}`);
    console.log(`  ℹ 自动对局共执行 ${pilots.reduce((a, p) => a + p.actions, 0)} 次行动`);
  } finally {
    for (const s of sessions) {
      try {
        s.close();
      } catch {
        /* 忽略 */
      }
    }
  }
});

test('房间号规整：大小写、空格、容易混淆的字符都能纠正', async () => {
  const { normalizeRoomCode, ROOM_CODE_LENGTH } = await import('../js/net/protocol.js');
  eq(normalizeRoomCode(' ab c1o0 '), 'ABC100');
  eq(normalizeRoomCode('abcdefg').length, ROOM_CODE_LENGTH);
  eq(normalizeRoomCode('!!!').length, 0);
});

await run();