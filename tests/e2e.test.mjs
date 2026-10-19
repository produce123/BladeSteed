/**
 * BladeSteed — 浏览器端到端测试
 *
 * 用真实的无头 Chrome 打开真实页面，用**真实鼠标点击**按钮，
 * 一路打到「本局结束」，再检查：
 *   · 界面有没有崩（控制台报错 / 未捕获异常一律算失败）
 *   · 手机窄屏、平板、桌面四种视口下会不会溢出、按钮够不够大
 *   · 联机时三个浏览器看到的状态是否收敛到同一份
 *
 * 用法：node tests/e2e.test.mjs
 */

import { existsSync, mkdirSync } from 'node:fs';
import { Page } from '../tools/cdp.mjs';
import { startServer } from '../tools/serve.mjs';
import { assert, eq, run, test } from './harness.mjs';

const SHOTS = 'tests/screenshots';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = await startServer(0);
const opened = [];

async function boot({ width = 430, height = 932, mobile = true } = {}) {
  const page = await Page.launch({ headless: true, width, height, mobile });
  opened.push(page);
  await page.goto(server.url);
  await page.waitFor('return !!window.bladeSteed', 10000, '页面启动');
  // 测试环境没声音也别浪费 CPU；特效保留（我们要检查它有没有真的画出来）
  await page.eval('window.bladeSteed.audio.enabled = false; return 1');
  return page;
}

async function setName(page, name) {
  await page.setInput('#input-name', name);
  const ok = await page.eval(`return window.bladeSteed._currentName() === ${JSON.stringify(name)}`);
  assert(ok, `名字没设进去：${name}`);
}

/** 把电脑的行动间隔压到最短，不然一局要打两分钟 */
async function speedUpAi(page) {
  return page.evalRaw(
    `(() => { const d = window.bladeSteed.session && window.bladeSteed.session.driver; if (!d) return false; d._aiDelay = () => 25; return true; })()`
  );
}

/** 看一眼牌桌现在该点哪个按钮（只读，不点） */
async function probeUi(page) {
  return page.evalRaw(`(() => {
    const app = window.bladeSteed;
    const v = app.view;
    if (!v) return { act: 'none' };
    if (v.phase === 'over') return { act: 'over', round: v.round, winner: v.winner };
    const me = v.players.find((p) => p.id === app.selfId);
    const ui = (sel) => [...document.querySelectorAll(sel)].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 1 && r.height > 1 && !el.disabled;
    });
    if (v.phase === 'rps' && v.rps && !v.rps.myChoice && (!me || me.alive)) {
      const btns = ui('#board-panel .rps-btn');
      if (btns.length) return { act: 'rps', round: v.round, index: Math.floor(Math.random() * btns.length) };
    }
    if (v.phase === 'order' && v.mini) {
      if (v.mini.decider === app.selfId) {
        const b = ui('#board-panel .act-btn').find((x) => x.textContent.includes('就按这个顺序'));
        if (b) return { act: 'order', round: v.round };
      } else if (!v.mini.decider && v.mini.candidates.includes(app.selfId) && (!me || me.alive)) {
        const btns = ui('#board-panel .rps-btn');
        // 必须随机出拳：固定三种不同的拳会让三人局永远三平局，无限重猜（规则本来就是这样）
        if (btns.length) return { act: 'rps', round: v.round, index: Math.floor(Math.random() * btns.length) };
      }
    }
    if (v.phase === 'action' && v.current === app.selfId) {
      const btns = ui('#board-panel .act-btn');
      if (btns.length) {
        const score = (b) => {
          const t = b.textContent;
          if (t.includes('踹')) return 4;
          if (t.includes('刀 ')) return 3;
          if (t.includes('买')) return 2;
          if (t.includes('出城') || t.includes('进 ')) return 1;
          return 0;
        };
        let best = 0, bs = -1;
        btns.forEach((b, i) => { const s = score(b); if (s > bs) { bs = s; best = i; } });
        return { act: 'action', index: best, steps: v.stepsLeft, round: v.round };
      }
    }
    return { act: 'wait', phase: v.phase, round: v.round };
  })()`);
}

/** 按当前局面点一次真实按钮 */
async function uiStep(page) {
  const p = await probeUi(page);
  try {
    if (p.act === 'rps') await page.click('#board-panel .rps-btn', { index: p.index || 0 });
    else if (p.act === 'order') await page.click('#board-panel .act-btn');
    else if (p.act === 'action') await page.click('#board-panel .act-btn', { index: p.index });
  } catch {
    // 面板可能刚好被新一帧状态重建了，按钮数量变了 —— 下一次循环重新探测再点就行
  }
  return p;
}

/** 一直用真实点击打到本局结束 */
async function playToEnd(page, { timeoutMs = 240000, label = '' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let actions = 0;
  let lastRound = 0;
  while (Date.now() < deadline) {
    const p = await uiStep(page);
    if (p.act === 'over') return { actions, rounds: p.round, winner: p.winner };
    if (p.act === 'action') actions += 1;
    if (p.round && p.round > lastRound) lastRound = p.round;
    await sleep(p.act === 'wait' ? 160 : 30);
  }
  throw new Error(`打不完这一局（${label}）：已经过了 ${Math.round(timeoutMs / 1000)} 秒`);
}

/** 公开状态指纹：联机时三家必须一致 */
const FINGERPRINT = `(() => {
  const v = window.bladeSteed.view;
  if (!v) return null;
  const ps = v.players.map((p) => p.id + '|' + p.name + '|' + p.seat + '|' + p.hp + '|' + p.alive + '|' + p.knife + '|' + p.horse + '|' + p.place).sort().join(' ');
  return v.phase + '|' + v.round + '|' + v.winner + '|' + ps;
})()`;

function assertClean(page, label) {
  if (page.errors.length) {
    throw new Error(`${label} 出现控制台错误/异常：\n${page.errors.join('\n')}`);
  }
}

/* ============================ 用例 ============================ */

test('单机 4 人机对局：真实点击打完整局', async () => {
  const page = await boot();
  await setName(page, '甲');
  await page.click('#btn-go-local');
  await page.waitFor('return document.getElementById("screen-local").classList.contains("is-active")', 5000, '人机设置页');
  await page.click('.seg-btn[data-size="4"]');
  await page.click('#btn-local-start');
  await page.waitFor('return document.getElementById("screen-board").classList.contains("is-active")', 8000, '牌桌');
  assert(await speedUpAi(page), '没找到对局驱动');

  await page.waitFor('return window.bladeSteed.view && window.bladeSteed.view.players.length === 4', 8000, '4 人就位');

  const result = await playToEnd(page, { timeoutMs: 240000, label: '单机 4 人' });
  assert(result.actions > 3, `真人这边几乎没行动过（${result.actions} 次），界面可能卡住了`);
  assert(result.rounds > 1, '至少该打过一个回合');

  const end = await page.evalRaw(`(() => {
    const app = window.bladeSteed;
    const v = app.view;
    return {
      phase: v.phase,
      winner: v.winner,
      alive: v.players.filter((p) => p.alive).length,
      tokens: app.board.nodes.size,
      cities: app.board.baseLayer.querySelectorAll('.city-ring').length,
      logLines: document.querySelectorAll('#board-log .log-line').length,
      restartBtn: !!document.querySelector('#board-panel .act-btn'),
      panelText: document.getElementById('board-panel').textContent,
    };
  })()`);

  eq(end.phase, 'over', '应该已经结束');
  assert(end.winner, '必须产生赢家');
  eq(end.alive, 1, '结束时只剩 1 个人');
  eq(end.tokens, 4, '地图上 4 个头像都还在（出局的人留在原地）');
  eq(end.cities, 4, '4 座城都要画出来，就算城主出局了城也还在');
  assert(end.logLines > 3, '播报日志该有内容');
  assert(end.panelText.includes('重新开局'), '结束后要能一键重开');
  assertClean(page, '单机 4 人');
  console.log(`  ℹ 打了 ${result.rounds} 回合，真人执行 ${result.actions} 次操作`);

  // 一键重新开局：血量、装备、位置、回合数全部回到起点
  await page.click('#board-panel .act-btn', { index: 0 });
  await page.waitFor('return window.bladeSteed.view.phase === "rps" && window.bladeSteed.view.round === 1', 8000, '重新开局');
  const fresh = await page.evalRaw(`(() => {
    const v = window.bladeSteed.view;
    return { hp: v.players.map((p) => p.hp), alive: v.players.filter((p) => p.alive).length, gear: v.players.some((p) => p.knife || p.horse), winner: v.winner, seats: v.players.map((p) => p.seat).sort().join('') };
  })()`);
  eq(fresh.hp, [10, 10, 10, 10], '重开后所有人满血');
  eq(fresh.alive, 4, '重开后所有人复活');
  eq(fresh.gear, false, '重开后装备清空');
  eq(fresh.winner, null, '重开后没有赢家');
  assert(fresh.seats.length === 4, '重开后座位要重新分配');
  assertClean(page, '重新开局');
});

test('界面交互：猜拳按钮、头像扔鸡蛋、菜单、规则页、名字校验', async () => {
  const page = await boot();
  mkdirSync(SHOTS, { recursive: true });

  // 没取名字之前不许进游戏
  await page.setInput('#input-name', '');
  await page.eval('return 1');
  await page.click('#btn-go-online');
  await sleep(200);
  eq(await page.eval('return window.bladeSteed.screen'), 'screen-home', '没取名字就不该跳走');
  assert(await page.eval('return !document.getElementById("toast").hidden'), '该给出提示');

  // 规则页
  await page.click('#btn-go-rules');
  await page.waitFor('return document.getElementById("screen-rules").classList.contains("is-active")', 5000, '规则页');
  const rulesText = await page.eval('return document.getElementById("screen-rules").textContent');
  for (const kw of ['10', '买刀', '买马', '踹', '猜拳', '野外', '行动']) {
    assert(rulesText.includes(kw), `规则页应该讲到「${kw}」`);
  }
  await page.click('#screen-rules [data-back]');
  // 等提示自己消失，免得它盖在后面的按钮上（真实提示 2.6 秒后自动收）
  await page.eval('return 1');
  await sleep(3000);
  assert(await page.eval('return document.getElementById("toast").hidden'), '提示应该会自动消失');

  // 开一局人机，检查猜拳按钮
  await setName(page, '乙');
  await page.click('#btn-go-local');
  await page.click('#btn-local-start');
  await page.waitFor('return document.getElementById("screen-board").classList.contains("is-active")', 8000, '牌桌');
  await speedUpAi(page);
  await page.waitFor('return !!document.querySelector("#board-panel .rps-btn")', 8000, '猜拳按钮出现');

  const rpsBefore = await page.evalRaw(`(() => {
    const b = [...document.querySelectorAll('#board-panel .rps-btn')];
    return { n: b.length, labels: b.map((x) => x.textContent), h: b[0].getBoundingClientRect().height };
  })()`);
  eq(rpsBefore.n, 3, '应该有石头剪刀布三个按钮');
  assert(rpsBefore.h >= 48, `猜拳按钮太小（${rpsBefore.h}px）`);
  await page.click('#board-panel .rps-btn', { index: 0 });
  await page.waitFor('return !!(window.bladeSteed.view && window.bladeSteed.view.rps && window.bladeSteed.view.rps.myChoice)', 6000, '自己选择生效');
  assert(await page.eval('return window.bladeSteed.view.rps.myChoice === "rock"'), '选的手势要记录下来');
  assert(await page.eval('return [...document.querySelectorAll("#board-panel .rps-btn")].every((b) => b.disabled)'), '出完拳按钮该锁住');

  // 点头像 → 扔鸡蛋
  const otherId = await page.eval('return window.bladeSteed.view.players.find((p) => p.id !== window.bladeSteed.selfId).id');
  const otherName = await page.eval(`return window.bladeSteed.view.players.find((p) => p.id === ${JSON.stringify(otherId)}).name`);
  await page.click(`.tok-hit[data-pid="${otherId}"]`);
  await page.waitFor('return !document.getElementById("popover").hidden', 4000, '扔道具菜单弹出');
  const popText = await page.eval('return document.getElementById("popover").textContent');
  assert(popText.includes('鸡蛋') && popText.includes('鲜花'), `菜单里要有鸡蛋和鲜花（点的是 ${otherName}）`);

  // 菜单不能被屏幕边缘截掉
  const popBox = await page.evalRaw(`(() => { const r = document.getElementById('popover').getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: window.innerWidth, h: window.innerHeight }; })()`);
  assert(popBox.l >= 0 && popBox.r <= popBox.w + 1, '菜单横向跑出屏幕了');
  assert(popBox.t >= 0 && popBox.b <= popBox.h + 1, '菜单纵向跑出屏幕了');

  await page.click('#popover-actions .pop-btn', { index: 0 });
  await page.waitFor('return window.bladeSteed.fx.fx.children.length > 0', 3000, '飞行动画出现在特效层');
  const fxKinds = await page.evalRaw(`(() => [...window.bladeSteed.fx.fx.children].map((n) => n.tagName + '.' + (n.getAttribute('class') || '')))()`);
  assert(fxKinds.length > 0, '特效层应该有内容');
  await page.waitFor('return window.bladeSteed.fx.fx.children.length === 0', 4000, '特效播完要自己清干净');

  // 菜单开合
  await page.click('#btn-board-menu');
  await page.waitFor('return !document.getElementById("board-menu").hidden', 3000, '菜单打开');
  const sheetText = await page.eval('return document.getElementById("board-menu").textContent');
  assert(sheetText.includes('重新开局'), '菜单里要有重新开局');

  const closeZone = await page.evalRaw(`(() => {
    const el = document.getElementById('menu-close');
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], top: top ? top.tagName + '.' + (top.getAttribute('class') || '') + '#' + (top.id || '') : 'null' };
  })()`);
  await page.click('#menu-close');
  try {
    await page.waitFor('return document.getElementById("board-menu").hidden', 3000, '菜单关闭');
  } catch (e) {
    throw new Error(`${e.message}\n 取消按钮位置 ${JSON.stringify(closeZone.rect)}，该点最上层是 ${closeZone.top}`);
  }

  await page.screenshot(`${SHOTS}/board-4p-mobile.png`);
  assertClean(page, '界面交互');
});

test('联机三人：靠房间号配对，打完一局且三家状态一致', async () => {
  const host = await boot();
  await setName(host, '甲');
  await host.click('#btn-go-online');
  await host.click('#btn-create-room');
  await host.waitFor('return document.getElementById("screen-lobby").classList.contains("is-active")', 8000, '大厅');
  await host.waitFor('return window.bladeSteed.session.snapshot().net.open > 0', 12000, '信令通道打开');
  const code = await host.eval('return document.getElementById("lobby-code").textContent');
  eq(code.length, 6, `房间号应该是 6 位，实际「${code}」`);

  const guests = [];
  for (const name of ['乙', '丙']) {
    const g = await boot();
    await setName(g, name);
    await g.click('#btn-go-online');
    await g.setInput('#input-room', code);
    await g.click('#btn-join-room');
    await g.waitFor('return document.getElementById("screen-lobby").classList.contains("is-active")', 8000, '进入大厅');
    guests.push(g);
  }

  const all = [host, ...guests];
  for (const p of all) {
    await p.waitFor('return window.bladeSteed.session.snapshot().members.length === 3', 40000, '三家名单到齐');
  }
  const hostNames = await host.eval('return window.bladeSteed.session.snapshot().members.map((m) => m.name).sort().join("")');
  eq(hostNames.length, 3, '房主该看到三个人');

  await host.click('#btn-lobby-start');
  for (const p of all) {
    await p.waitFor('return document.getElementById("screen-board").classList.contains("is-active")', 30000, '进入牌桌');
    await p.waitFor('return !!window.bladeSteed.view', 30000, '收到第一帧状态');
  }
  // 客人端没有对局驱动（AI 由房主那边跑），只有房主需要提速
  assert(await speedUpAi(host), '房主端缺对局驱动');

  const results = await Promise.all(all.map((p, i) => playToEnd(p, { timeoutMs: 300000, label: `联机第 ${i + 1} 家` })));
  for (const p of all) {
    await p.waitFor('return window.bladeSteed.view.phase === "over"', 20000, '本局结束');
  }

  const prints = await Promise.all(all.map((p) => p.evalRaw(FINGERPRINT)));
  eq(new Set(prints).size, 1, `三家看到的公开状态不一致：\n${prints.join('\n')}`);
  assert(prints[0].includes('over'), '应该已经结束');

  const net = await host.evalRaw(`(() => { const s = window.bladeSteed.session.snapshot(); return { direct: s.direct, mode: s.linkMode, open: s.net.open, channels: s.net.channels.map((c) => c.id + ':' + c.state) }; })()`);
  console.log(`  ℹ 房主链路：${net.mode}，直连 ${net.direct} 条，公共通道 ${net.open} 条 [${net.channels.join(' ')}]`);
  console.log(`  ℹ 三家自动对局行动次数：${results.map((r) => r.actions).join(' / ')}`);

  await host.screenshot(`${SHOTS}/online-host.png`);
  await guests[0].screenshot(`${SHOTS}/online-guest.png`);
  for (const [i, p] of all.entries()) assertClean(p, `联机第 ${i + 1} 家`);
});

test('自适应：四种视口都不溢出、按钮够大、头像不出画布', async () => {
  mkdirSync(SHOTS, { recursive: true });
  const page = await boot();
  await setName(page, '小');
  await page.click('#btn-go-local');
  await page.click('.seg-btn[data-size="4"]');
  await page.click('#btn-local-start');
  await page.waitFor('return document.getElementById("screen-board").classList.contains("is-active")', 8000, '牌桌');
  await speedUpAi(page);
  await page.waitFor('return window.bladeSteed.view && window.bladeSteed.view.players.length === 4', 8000, '4 人');

  const viewports = [
    { width: 360, height: 640, mobile: true, tag: 'small-phone' },
    { width: 390, height: 844, mobile: true, tag: 'phone' },
    { width: 820, height: 1180, mobile: false, tag: 'tablet' },
    { width: 1440, height: 900, mobile: false, tag: 'desktop' },
  ];

  for (const vp of viewports) {
    await page.setViewport(vp.width, vp.height, vp.mobile);
    await sleep(450);
    const r = await page.evalRaw(`(() => {
      const de = document.documentElement;
      const big = ['#board-panel .act-btn', '#board-panel .rps-btn', '.icon-btn', '.big-btn', '.seg-btn'];
      const small = [];
      for (const sel of big) {
        for (const el of document.querySelectorAll(sel)) {
          const b = el.getBoundingClientRect();
          if (b.width > 1 && b.height > 1 && b.height < 48) small.push(sel + '=' + Math.round(b.height));
        }
      }
      const app = window.bladeSteed;
      const outside = [];
      for (const [pid, p] of app.board.pos) {
        if (p.x < 8 || p.x > 392 || p.y < 8 || p.y > 332) outside.push(pid + '@' + Math.round(p.x) + ',' + Math.round(p.y));
      }
      const map = document.getElementById('map').getBoundingClientRect();
      return {
        scrollW: de.scrollWidth, innerW: window.innerWidth,
        scrollH: de.scrollHeight, innerH: window.innerHeight,
        small, outside,
        map: { w: Math.round(map.width), h: Math.round(map.height), bottom: Math.round(map.bottom) },
        panelBottom: Math.round(document.getElementById('board-panel').getBoundingClientRect().bottom),
        vh: window.innerHeight,
      };
    })()`);

    assert(r.scrollW <= r.innerW + 2, `${vp.tag}：横向溢出了（内容 ${r.scrollW} > 视口 ${r.innerW}）`);
    assert(r.scrollH <= r.innerH + 2, `${vp.tag}：纵向溢出了（内容 ${r.scrollH} > 视口 ${r.innerH}）`);
    eq(r.small.length, 0, `${vp.tag}：这些按钮小于 48px — ${r.small.join(', ')}`);
    eq(r.outside.length, 0, `${vp.tag}：头像跑出画布了 — ${r.outside.join(', ')}`);
    assert(r.map.h > 120, `${vp.tag}：地图被压得太扁（${r.map.h}px）`);
    assert(r.panelBottom <= r.vh + 2, `${vp.tag}：行动面板被挤到屏幕下面了`);

    await page.screenshot(`${SHOTS}/board-${vp.tag}.png`);
    console.log(`  ℹ ${vp.tag} ${vp.width}x${vp.height}：地图 ${r.map.w}x${r.map.h}，面板底 ${r.panelBottom}/${r.vh}`);
  }

  assertClean(page, '自适应');
});

/* ============================ 收尾 ============================ */

await run(async () => {
  for (const p of opened) {
    try {
      p.close();
    } catch {
      /* 忽略 */
    }
  }
  await server.close();
  if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });
});