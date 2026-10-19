/**
 * BladeSteed — 界面主控
 *
 * 职责：
 *   · 屏幕切换（首页 / 人机 / 在线 / 大厅 / 牌桌 / 规则）
 *   · 把会话层的状态画成地图 + 行动面板 + 播报
 *   · 把引擎事件（刀、踹、买装备、出局…）翻译成动画和音效
 *
 * 这里**不包含任何游戏规则判断**：能做什么一律问 legalActionsFrom(视图)，
 * 所以界面上永远不会出现「按钮点了却被房主拒绝」这种情况。
 */

import { HostSession, ClientSession, LocalSession, isValidName, normalizeName } from '../net/session.js';
import { MapBoard } from './map.js';
import { Effects } from './effects.js';
import { AudioKit } from './audio.js';
import { ACT, MAX_PLAYERS, PHASE, RPS_LABEL, WILD } from '../engine/constants.js';
import { legalActionsFrom } from '../engine/rules.js';
import { REACTION, ROOM_CODE_LENGTH, makeRoomCode, normalizeRoomCode } from '../net/protocol.js';

const $ = (id) => document.getElementById(id);

const RPS_EMOJI = { rock: '✊', scissors: '✌️', paper: '✋' };

/** 名字快捷选项：省得手机上打字 */
const NAME_POOL = '甲乙丙丁王李张刘陈刀马侠客狼虎龙鹰隼鲨鹤猫犬一二三四五六七八九'.split('');

function h(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, String(v));
  }
  for (const c of [].concat(children)) if (c) node.append(c);
  return node;
}

export class App {
  constructor() {
    this.audio = new AudioKit();
    this.board = new MapBoard($('map'), { onAvatarClick: (pid, el) => this._onAvatarClick(pid, 'board', el) });
    this.fx = new Effects(this.board);

    /** @type {LocalSession|HostSession|ClientSession|null} */
    this.session = null;
    this.screen = 'screen-home';
    this.view = null;
    this.selfId = null;
    this.lastEventId = 0;
    this.lastLogId = 0;
    this.orderDraft = null;
    this.orderKey = '';
    this._deadlineAt = 0;
    this._timerId = null;
    this._chipEls = new Map();
    this._pendingReaction = null;
    this._localSize = 4;
    this._toastTimer = null;
    this._blockerCount = 0;
  }

  /* ============================== 启动 ============================== */

  boot() {
    this._loadPrefs();
    this._bindHome();
    this._bindLocal();
    this._bindOnline();
    this._bindLobby();
    this._bindBoard();
    this._buildNameQuick();

    // 任何一次点击都可能解锁音频（浏览器自动播放策略），顺手收起「扔道具」菜单。
    // 注意：点在菜单自己身上时**绝不能**收 —— pointerdown 先于 click 触发，
    // 收掉了菜单，随后的 click 就落空了，真机上就是「菜单里的按钮点不动」。
    document.addEventListener(
      'pointerdown',
      (ev) => {
        this.audio.unlock();
        const pop = $('popover');
        if (pop && !pop.hidden && !pop.contains(ev.target)) this._closePopover();
      },
      { capture: true }
    );

    this._timerId = setInterval(() => this._tickTimer(), 200);
    this.showScreen('screen-home');
  }

  _loadPrefs() {
    let sound = true;
    let fx = true;
    let name = '';
    try {
      sound = localStorage.getItem('bs.sound') !== '0';
      fx = localStorage.getItem('bs.fx') !== '0';
      name = localStorage.getItem('bs.name') || '';
    } catch {
      /* 隐私模式下拿不到就算了 */
    }
    this.audio.enabled = sound;
    this.fx.enabled = fx;
    document.body.classList.toggle('no-fx', !fx);
    $('toggle-sound').setAttribute('aria-pressed', String(sound));
    $('toggle-fx').setAttribute('aria-pressed', String(fx));
    if (name) $('input-name').value = name;
  }

  _savePref(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* 忽略 */
    }
  }

  /* ============================== 屏幕 ============================== */

  showScreen(id) {
    this.screen = id;
    for (const s of document.querySelectorAll('.screen')) s.classList.toggle('is-active', s.id === id);
    if (id === 'screen-board') this._renderBoard();
    if (id === 'screen-lobby') this._renderLobby();
    if (id === 'screen-online') this._renderNetStatus($('net-status'));
  }

  /** 统一的会话接入：所有事件都在这里挂上 */
  _attach(session) {
    this.session = session;
    this.selfId = session.selfId;
    this.lastEventId = 0;
    this.lastLogId = 0;
    this.orderDraft = null;
    this.board.nodes.clear();
    this.board.tokenLayer.replaceChildren();
    this.fx.clear();

    session.on('update', () => this._onUpdate());
    session.on('reaction', (r) => this._onReaction(r));
    session.on('error', (msg) => this.toast(msg, true));
    session.on('toast', (msg) => this.toast(msg));
    session.on('host-gone', () => {
      this.toast('房主已经离开房间', true);
      this._detach();
      this.showScreen('screen-home');
    });
  }

  _detach() {
    if (this.session) {
      try {
        this.session.leave();
      } catch {
        /* 忽略 */
      }
    }
    this.session = null;
    this.view = null;
    this.selfId = null;
  }

  _onUpdate() {
    const snap = this.session ? this.session.snapshot() : null;
    if (!snap) return;
    this.selfId = snap.selfId;

    if (!snap.match) {
      if (this.screen !== 'screen-lobby') this.showScreen('screen-lobby');
      this._renderLobby();
      return;
    }
    this.view = snap.match;
    if (this.screen !== 'screen-board') this.showScreen('screen-board');
    this._renderBoard();
  }

  /* ============================== 首页 ============================== */

  _buildNameQuick() {
    const box = $('name-quick');
    box.replaceChildren();
    const pool = [...NAME_POOL].sort(() => Math.random() - 0.5).slice(0, 9);
    for (const c of pool) {
      box.append(
        h('button', {
          type: 'button',
          text: c,
          onclick: () => {
            $('input-name').value = c;
            this._savePref('bs.name', c);
            this.audio.play('click');
          },
        })
      );
    }
  }

  _currentName() {
    return normalizeName($('input-name').value);
  }

  /** 进房间前必须有单字名 */
  _requireName() {
    const name = this._currentName();
    if (!isValidName(name)) {
      this.toast('请先给自己取一个单字名字', true);
      $('input-name').focus();
      $('name-hint').textContent = '必须是一个字，比如「甲」「王」「刀」。';
      return null;
    }
    this._savePref('bs.name', name);
    $('name-hint').textContent = '头像就是你这个字，房间里所有人都看得到。';
    return name;
  }

  _bindHome() {
    $('input-name').addEventListener('input', () => {
      const v = normalizeName($('input-name').value);
      $('input-name').value = v;
      if (v) this._savePref('bs.name', v);
    });

    $('toggle-sound').addEventListener('click', () => {
      this.audio.enabled = !this.audio.enabled;
      $('toggle-sound').setAttribute('aria-pressed', String(this.audio.enabled));
      this._savePref('bs.sound', this.audio.enabled ? '1' : '0');
      if (this.audio.enabled) this.audio.play('click');
      this._syncMenuLabels();
    });

    $('toggle-fx').addEventListener('click', () => {
      this.fx.enabled = !this.fx.enabled;
      document.body.classList.toggle('no-fx', !this.fx.enabled);
      $('toggle-fx').setAttribute('aria-pressed', String(this.fx.enabled));
      this._savePref('bs.fx', this.fx.enabled ? '1' : '0');
      this._syncMenuLabels();
    });

    $('btn-go-local').addEventListener('click', () => {
      if (!this._requireName()) return;
      this.audio.play('click');
      this.showScreen('screen-local');
    });
    $('btn-go-online').addEventListener('click', () => {
      if (!this._requireName()) return;
      this.audio.play('click');
      this.showScreen('screen-online');
    });
    $('btn-go-rules').addEventListener('click', () => {
      this.audio.play('click');
      this.showScreen('screen-rules');
    });

    for (const b of document.querySelectorAll('[data-back]')) {
      b.addEventListener('click', () => {
        this.audio.play('click');
        this.showScreen(b.dataset.back);
      });
    }
  }

  /* ============================== 人机 ============================== */

  _bindLocal() {
    for (const b of $('local-size').querySelectorAll('.seg-btn')) {
      b.addEventListener('click', () => {
        this._localSize = Number(b.dataset.size);
        for (const x of $('local-size').querySelectorAll('.seg-btn')) x.classList.toggle('is-on', x === b);
        this.audio.play('click');
      });
    }
    $('btn-local-start').addEventListener('click', () => {
      const name = this._requireName();
      if (!name) return;
      this.audio.play('click');
      const s = new LocalSession({ name, size: this._localSize });
      this._attach(s);
      s.start();
    });
  }

  /* ============================== 在线 ============================== */

  _bindOnline() {
    $('input-room').addEventListener('input', () => {
      $('input-room').value = normalizeRoomCode($('input-room').value);
    });

    $('btn-create-room').addEventListener('click', async () => {
      const name = this._requireName();
      if (!name) return;
      this.audio.play('click');
      const code = makeRoomCode();
      const s = new HostSession({ name, roomCode: code });
      this._attach(s);
      this.showScreen('screen-lobby');
      $('lobby-code').textContent = code;
      this._setBlocker(true, '正在打开联机通道…');
      const open = await s.open();
      this._setBlocker(false);
      if (open === 0) this.toast('连不上任何公共信令通道，请检查网络后重试', true);
      this._renderLobby();
    });

    $('btn-join-room').addEventListener('click', async () => {
      const name = this._requireName();
      if (!name) return;
      const code = normalizeRoomCode($('input-room').value);
      if (code.length !== ROOM_CODE_LENGTH) {
        this.toast(`房间号是 ${ROOM_CODE_LENGTH} 位`, true);
        return;
      }
      this.audio.play('click');
      const s = new ClientSession({ name });
      this._attach(s);
      this.showScreen('screen-lobby');
      $('lobby-code').textContent = code;
      this._renderLobby();
      this._setBlocker(true, '正在进入房间…');
      const r = await s.join(code);
      this._setBlocker(false);
      if (!r.ok) {
        this.toast(r.error, true);
        this._detach();
        this.showScreen('screen-online');
        return;
      }
      this._renderLobby();
    });
  }

  _renderNetStatus(el) {
    if (!el || !this.session) return;
    const snap = this.session.snapshot();
    const net = snap.net;
    if (!net) {
      el.textContent = '无需联网（单机人机）';
      return;
    }
    const parts = [`<b>${net.open}</b> 条公共通道在线`];
    if (snap.direct !== undefined) parts.push(`${snap.direct} 条 P2P 直连`);
    if (snap.linkMode === 'relay') parts.push('<span class="warn">当前走中转模式</span>');
    if (!net.channels || !net.channels.length) parts.push('通道全部掉线，正在自动重连…');
    el.innerHTML = parts.join(' · ');
  }

  /* ============================== 大厅 ============================== */

  _bindLobby() {
    $('btn-lobby-leave').addEventListener('click', () => {
      this.audio.play('click');
      this._detach();
      this.showScreen('screen-home');
    });

    $('btn-copy-room').addEventListener('click', async () => {
      const code = $('lobby-code').textContent;
      try {
        await navigator.clipboard.writeText(code);
        this.toast(`房间号 ${code} 已复制`);
      } catch {
        this.toast(`房间号：${code}`);
      }
    });

    $('btn-lobby-add-ai').addEventListener('click', () => {
      if (!this.session || this.session.mode === 'client') return;
      const r = this.session.addAi();
      if (!r.ok) this.toast(r.error, true);
      else this.audio.play('click');
      this._renderLobby();
    });

    $('btn-lobby-start').addEventListener('click', () => {
      if (!this.session) return;
      if (this.session.mode === 'client') {
        this.toast('等房主开始对局');
        return;
      }
      const r = this.session.startMatch ? this.session.startMatch() : null;
      if (r && !r.ok) {
        this.toast(r.error, true);
        return;
      }
      this.audio.play('click');
    });

    $('popover-cancel').addEventListener('click', () => this._closePopover());
  }

  _renderLobby() {
    if (!this.session) return;
    const snap = this.session.snapshot();
    const isHost = snap.mode === 'host' || snap.mode === 'local';
    $('lobby-code').textContent = snap.roomCode || '单机';
    $('btn-lobby-add-ai').style.display = isHost ? '' : 'none';
    $('btn-lobby-start').style.display = isHost ? '' : 'none';
    $('lobby-count').textContent = String(snap.members.length);
    this._renderNetStatus($('lobby-net'));

    const grid = $('lobby-avatars');
    grid.replaceChildren();
    this._chipEls.clear();

    for (const m of snap.members) {
      const chip = h('div', { class: `avatar-chip${m.isSelf ? ' is-self' : ''}` });
      const face = h('div', { class: 'avatar-face', text: m.name, 'data-pid': m.id });
      face.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (m.isSelf) return;
        this._onAvatarClick(m.id, 'lobby', face);
      });
      chip.append(face, h('div', { class: 'avatar-name', text: m.isSelf ? '你' : m.isAI ? `${m.name} · AI` : m.name }));
      grid.append(chip);
      this._chipEls.set(m.id, face);
    }
    for (let i = snap.members.length; i < MAX_PLAYERS; i++) {
      grid.append(
        h('div', { class: 'avatar-chip is-empty' }, [
          h('div', { class: 'avatar-face', text: '＋' }),
          h('div', { class: 'avatar-name', text: '空位' }),
        ])
      );
    }

    const sub = $('lobby-start-sub');
    if (snap.mode === 'client') {
      sub.textContent = '等房主开始对局';
    } else {
      sub.textContent =
        snap.members.length < 2 ? `至少 2 人（现在 ${snap.members.length} 人）` : `${snap.members.length} 人 · 开局随机分配座位`;
    }
    $('btn-lobby-start').disabled = snap.mode !== 'client' && snap.members.length < 2;
    $('btn-lobby-start').style.opacity = $('btn-lobby-start').disabled ? '0.45' : '';
  }

  /* ============================== 牌桌 ============================== */

  _bindBoard() {
    $('btn-board-menu').addEventListener('click', () => {
      this.audio.play('click');
      this._syncMenuLabels();
      $('board-menu').hidden = false;
    });
    $('menu-close').addEventListener('click', () => ($('board-menu').hidden = true));
    $('board-menu').addEventListener('click', (ev) => {
      if (ev.target === $('board-menu')) $('board-menu').hidden = true;
    });

    $('menu-restart').addEventListener('click', () => {
      $('board-menu').hidden = true;
      if (!this.session) return;
      if (this.session.mode === 'client') {
        this.toast('重新开局由房主决定');
        return;
      }
      this.session.restart();
      this.lastEventId = 0;
      this.lastLogId = 0;
      this.fx.clear();
      this.toast('已重新开局');
    });

    $('menu-sound').addEventListener('click', () => {
      this.audio.enabled = !this.audio.enabled;
      $('toggle-sound').setAttribute('aria-pressed', String(this.audio.enabled));
      this._savePref('bs.sound', this.audio.enabled ? '1' : '0');
      this._syncMenuLabels();
    });
    $('menu-fx').addEventListener('click', () => {
      this.fx.enabled = !this.fx.enabled;
      document.body.classList.toggle('no-fx', !this.fx.enabled);
      $('toggle-fx').setAttribute('aria-pressed', String(this.fx.enabled));
      this._savePref('bs.fx', this.fx.enabled ? '1' : '0');
      this._syncMenuLabels();
    });
    $('menu-leave').addEventListener('click', () => {
      $('board-menu').hidden = true;
      this._detach();
      this.showScreen('screen-home');
    });
  }

  _syncMenuLabels() {
    $('menu-sound').textContent = `🔊 音效：${this.audio.enabled ? '开' : '关'}`;
    $('menu-fx').textContent = `✨ 特效：${this.fx.enabled ? '开' : '关'}`;
    $('toggle-sound').setAttribute('aria-pressed', String(this.audio.enabled));
    $('toggle-fx').setAttribute('aria-pressed', String(this.fx.enabled));
  }

  _renderBoard() {
    const view = this.view;
    if (!view || !this.session) return;
    const snap = this.session.snapshot();

    // 1) 地图（先画完再播事件，特效才知道大家现在站在哪）
    this.board.render(view, this.selfId);

    // 2) 顶部状态
    const phaseNames = { rps: '猜拳', order: '定顺序', action: '行动', over: '结束' };
    const phaseEl = $('board-phase');
    phaseEl.textContent = this._phaseText(view, phaseNames);
    phaseEl.classList.toggle('hot', view.phase === 'action' && view.current === this.selfId);
    $('board-round').textContent = `第 ${view.round} 回合`;

    // 3) 计时器
    this._syncDeadline(view);

    // 4) 播报 + 特效
    this._playEvents(view);
    this._renderLog(view);

    // 5) 行动面板
    this._renderPanel(view, snap);
  }

  _phaseText(view, names) {
    if (view.phase === PHASE.OVER) return '本局结束';
    if (view.phase === PHASE.RPS) return '猜拳';
    if (view.phase === PHASE.ORDER) {
      const m = view.mini;
      if (m && m.decider) {
        return m.decider === this.selfId ? '你来定顺序' : `${this._name(view, m.decider)} 定顺序`;
      }
      return '小猜拳';
    }
    if (view.phase === PHASE.ACTION) {
      return view.current === this.selfId ? `你的行动 · 剩 ${view.stepsLeft} 步` : `${this._name(view, view.current)} 行动中`;
    }
    return names[view.phase] || '';
  }

  _name(view, pid) {
    const p = view.players.find((x) => x.id === pid);
    return p ? p.name : '?';
  }

  _syncDeadline(view) {
    let inMs = null;
    if (view.phase === PHASE.RPS && view.rps) inMs = view.rps.deadlineIn;
    else if (view.phase === PHASE.ORDER && view.mini) inMs = view.mini.deadlineIn;
    else if (view.phase === PHASE.ACTION) inMs = view.actionDeadlineIn;
    this._deadlineAt = inMs == null ? 0 : Date.now() + inMs;
    this._tickTimer(true);
  }

  _tickTimer(force) {
    const el = $('board-timer');
    if (!el) return;
    if (!this.view || this.view.phase === PHASE.OVER || !this._deadlineAt) {
      el.classList.add('idle');
      el.classList.remove('urgent');
      el.firstChild.textContent = '—';
      return;
    }
    const left = Math.max(0, this._deadlineAt - Date.now());
    const sec = Math.ceil(left / 1000);
    el.classList.remove('idle');
    el.classList.toggle('urgent', left <= 3000);
    const span = el.firstChild;
    if (span.textContent !== String(sec)) {
      span.textContent = String(sec);
      if (force !== true && left <= 3000 && sec > 0) this.audio.play('tick');
    }
  }

  _renderLog(view) {
    const el = $('board-log');
    const lines = view.log.filter((l) => l.id > this.lastLogId);
    if (lines.length) {
      this.lastLogId = view.log[view.log.length - 1].id;
      for (const l of lines) el.append(h('div', { class: 'log-line', text: l.text }));
      while (el.children.length > 40) el.firstChild.remove();
    }
    // 打开日志时总是把最新一条顶到可见区
    el.scrollTop = el.scrollHeight;
  }

  /* ============================== 事件回放 ============================== */

  _playEvents(view) {
    const events = view.events || [];
    if (!events.length) return;
    const maxId = events[events.length - 1].id;
    if (this.lastEventId === 0) {
      // 第一次拿到状态（刚进房间 / 刚重连）：只对齐游标，不要把历史事件全播一遍
      this.lastEventId = maxId;
      return;
    }
    const fresh = events.filter((e) => e.id > this.lastEventId);
    this.lastEventId = maxId;
    fresh.forEach((ev, i) => {
      setTimeout(() => this._playOne(ev, view), this.fx.enabled ? i * 110 : 0);
    });
  }

  _playOne(ev, view) {
    const posOf = (pid) => this.board.posOf(pid);
    const nameOf = (pid) => this._name(view, pid);
    const me = this.selfId;

    switch (ev.t) {
      case 'rps-reveal': {
        this.audio.play('reveal');
        if (!ev.winners || !ev.winners.length) {
          this.fx.banner('无人获胜，重新猜拳');
        } else if (ev.winners.length === 1) {
          this.fx.banner(`${nameOf(ev.winners[0])} 获胜 · 2 步行动`);
        } else {
          this.fx.banner(`${ev.winners.map(nameOf).join('、')} 获胜 · 各 1 步`);
        }
        break;
      }
      case 'mini-reveal': {
        this.audio.play('reveal');
        if (ev.winners && ev.winners.length === 1) this.fx.banner(`${nameOf(ev.winners[0])} 赢得小猜拳`);
        else this.fx.banner('小猜拳平局，再来一次');
        break;
      }
      case 'order-decider':
        this.fx.banner(`${nameOf(ev.decider)} 来决定行动顺序`);
        break;
      case 'order':
        this.fx.banner(`行动顺序：${ev.order.map(nameOf).join(' → ')}`);
        break;
      case 'turn':
        if (ev.pid !== me) this.audio.play('turn');
        break;
      case 'buy':
        this.audio.play('buy');
        this.fx.pop(posOf(ev.pid), ev.item === 'knife' ? '＋刀' : '＋马');
        break;
      case 'knife': {
        this.audio.play('slash');
        const p = this.board.prevPosOf(ev.target);
        this.fx.slash(p);
        this.fx.damage(p, '-1');
        this.board.shake(ev.target);
        setTimeout(() => this.audio.play('hurt'), 90);
        break;
      }
      case 'kick': {
        this.audio.play('kick');
        const from = posOf(ev.pid);
        const p = this.board.prevPosOf(ev.target);
        this.fx.kick(from, p);
        this.fx.damage(p, '-3');
        this.board.shake(ev.target);
        setTimeout(() => this.audio.play('hurt'), 110);
        break;
      }
      case 'down':
        this.audio.play('down');
        this.fx.banner(`${nameOf(ev.pid)} 出局！`);
        break;
      case 'over':
        if (ev.winner === me) this.audio.play('win');
        else this.audio.play('lose');
        this.fx.banner(ev.winner ? `${nameOf(ev.winner)} 是本局赢家！` : '本局无人存活', 2200);
        break;
      default:
        break;
    }
  }

  /* ============================== 行动面板 ============================== */

  _renderPanel(view, snap) {
    const panel = $('board-panel');
    panel.replaceChildren();

    if (view.phase === PHASE.OVER) {
      panel.append(this._panelOver(view, snap));
      return;
    }
    if (view.phase === PHASE.RPS) {
      panel.append(this._panelRps(view, view.rps, snap));
      return;
    }
    if (view.phase === PHASE.ORDER) {
      panel.append(this._panelOrder(view, snap));
      return;
    }
    if (view.phase === PHASE.ACTION) {
      panel.append(this._panelAction(view, snap));
    }
  }

  _me(view) {
    return view.players.find((p) => p.id === this.selfId) || null;
  }

  _readyRow(view, ready, ids) {
    const row = h('div', { class: 'ready-row' });
    for (const id of ids) {
      row.append(h('span', { class: `ready-chip${ready[id] ? ' on' : ''}`, text: `${this._name(view, id)}${ready[id] ? ' 已出' : ' …'}` }));
    }
    return row;
  }

  /** 猜拳 / 小猜拳的按钮面板 */
  _panelRps(view, pool, snap) {
    const box = h('div', { class: 'action-panel' });
    const me = this._me(view);
    const ids = pool.candidates ? pool.candidates : view.players.filter((p) => p.alive).map((p) => p.id);

    if (me && me.alive && (!pool.candidates || pool.candidates.includes(this.selfId))) {
      const row = h('div', { class: 'rps-row' });
      for (const c of view.rpsChoices || ['rock', 'scissors', 'paper']) {
        const picked = pool.myChoice === c;
        const btn = h('button', {
          class: `rps-btn${picked ? ' is-picked' : ''}`,
          type: 'button',
          disabled: !!pool.myChoice ? '' : null,
        });
        btn.append(h('span', { class: 'emoji', text: RPS_EMOJI[c] }), h('span', { text: RPS_LABEL[c] }));
        btn.addEventListener('click', () => {
          this.audio.play('pick');
          this.session.submitRps(c);
        });
        row.append(btn);
      }
      box.append(
        h('div', { class: 'panel-title', text: pool.myChoice ? `你出了【${RPS_LABEL[pool.myChoice]}】，等其他人…` : '出拳！' }),
        row
      );
    } else {
      box.append(h('div', { class: 'panel-title', text: me && !me.alive ? '你已出局，在本局结束前可以继续观战和扔道具' : '等其他人出拳…' }));
    }
    box.append(this._readyRow(view, pool.ready || {}, ids));
    return box;
  }

  /** 决胜者排顺序 */
  _panelOrder(view, snap) {
    const box = h('div', { class: 'action-panel' });
    const m = view.mini;
    const aliveWinners = view.mainWinners.filter((id) => view.players.find((p) => p.id === id)?.alive);

    if (!m || m.decider !== this.selfId) {
      if (m && m.candidates && m.candidates.includes(this.selfId) && !m.decider) {
        return this._panelRps(view, m, snap);
      }
      box.append(
        h('div', {
          class: 'waiting',
          html: m && m.decider ? `等 <b>${this._name(view, m.decider)}</b> 决定 ${aliveWinners.length} 人的行动顺序…` : '等小猜拳结果…',
        })
      );
      return box;
    }

    // 我是决胜者：拖动排序（点一个、再点一个即交换）
    const key = `${view.round}:${m.round}:${aliveWinners.join(',')}`;
    if (this.orderKey !== key || !this.orderDraft || this.orderDraft.length !== aliveWinners.length) {
      this.orderKey = key;
      this.orderDraft = aliveWinners.slice();
    }
    box.append(h('div', { class: 'panel-title', text: '点两个人交换位置，第一位最先行动' }));

    const list = h('div', { class: 'order-list' });
    this.orderDraft.forEach((pid, idx) => {
      const item = h('div', { class: `order-item${this._orderSel === idx ? ' is-sel' : ''}` }, [
        h('span', { class: 'idx', text: String(idx + 1) }),
        h('span', { text: `${this._name(view, pid)}${pid === this.selfId ? '（你）' : ''}` }),
        h('span', { class: 'swaphint', text: this._orderSel === idx ? '再点一个交换' : '点击选择' }),
      ]);
      item.addEventListener('click', () => {
        this.audio.play('click');
        if (this._orderSel == null || this._orderSel === idx) {
          this._orderSel = this._orderSel === idx ? null : idx;
        } else {
          const a = this._orderSel;
          [this.orderDraft[a], this.orderDraft[idx]] = [this.orderDraft[idx], this.orderDraft[a]];
          this._orderSel = null;
        }
        this._renderPanel(view, snap);
      });
      list.append(item);
    });
    box.append(list);

    const order = this.orderDraft.slice();
    box.append(
      h('button', {
        class: 'act-btn hot wide',
        type: 'button',
        text: '✅ 就按这个顺序',
        onclick: () => {
          this.audio.play('click');
          this._orderSel = null;
          this.session.submitOrder(order);
        },
      })
    );
    return box;
  }

  /** 行动按钮 */
  _panelAction(view, snap) {
    const box = h('div', { class: 'action-panel' });
    const me = this._me(view);

    if (view.current !== this.selfId) {
      box.append(
        h('div', {
          class: 'waiting',
          html: `等 <b>${this._name(view, view.current)}</b> 行动中…（还剩 ${view.stepsLeft} 步）`,
        })
      );
      return box;
    }

    const acts = legalActionsFrom(view, this.selfId);
    if (!acts.length) {
      box.append(h('div', { class: 'waiting', text: '没有可做的操作' }));
      return box;
    }

    box.append(h('div', { class: 'panel-title', text: `轮到你行动，还剩 ${view.stepsLeft} 步 · 每步只能做一件事` }));

    const grid = h('div', { class: 'act-grid' });
    for (const a of acts) {
      const [title, sub] = this._actionLabel(a, view);
      const cls =
        a.type === ACT.PASS
          ? 'act-btn wide'
          : a.type === ACT.KICK || a.type === ACT.KNIFE
            ? 'act-btn danger'
            : a.type === ACT.BUY_KNIFE || a.type === ACT.BUY_HORSE
              ? 'act-btn hot'
              : 'act-btn';
      const btn = h('button', { class: cls, type: 'button' }, [h('span', { text: title }), sub ? h('span', { class: 'sub', text: sub }) : null]);
      btn.addEventListener('click', () => {
        this.audio.play('click');
        this.session.act({ type: a.type, target: a.target });
      });
      grid.append(btn);
    }
    box.append(grid);
    if (me && acts.some((a) => a.type === ACT.PASS)) {
      box.append(h('div', { class: 'panel-title', text: '「结束行动」会放弃剩下的步数' }));
    }
    return box;
  }

  _actionLabel(a, view) {
    const n = (pid) => this._name(view, pid);
    switch (a.type) {
      case ACT.BUY_KNIFE:
        return ['🔪 买刀', '解锁【刀】· 永久'];
      case ACT.BUY_HORSE:
        return ['🐴 买马', '解锁【踹】· 永久'];
      case ACT.MOVE_OUT:
        return ['🚶 出城', '去野外'];
      case ACT.MOVE_IN:
        return [`🏯 进 ${n(a.target)}的城`, ''];
      case ACT.KNIFE:
        return [`🔪 刀 ${n(a.target)}`, '-1 血'];
      case ACT.KICK:
        return [`🦶 踹 ${n(a.target)}`, '-3 血 + 踢出城'];
      case ACT.PASS:
        return ['✋ 结束行动', ''];
      default:
        return [a.type, ''];
    }
  }

  _panelOver(view, snap) {
    const box = h('div', { class: 'action-panel' });
    const win = view.winner;
    box.append(
      h('div', {
        class: 'waiting',
        html: win ? `🏆 <b>${this._name(view, win)}</b> 是本局赢家` : '本局无人存活',
      })
    );
    const isHost = snap.mode !== 'client';
    if (isHost) {
      box.append(
        h('button', {
          class: 'act-btn hot wide',
          type: 'button',
          text: '🔄 一键重新开局',
          onclick: () => {
            this.audio.play('click');
            this.session.restart();
            this.lastEventId = 0;
            this.lastLogId = 0;
            this.fx.clear();
          },
        })
      );
    } else {
      box.append(h('div', { class: 'panel-title', text: '等房主决定是否再来一局' }));
    }
    box.append(
      h('button', {
        class: 'act-btn wide',
        type: 'button',
        text: '🏠 回到首页',
        onclick: () => {
          this.audio.play('click');
          this._detach();
          this.showScreen('screen-home');
        },
      })
    );
    return box;
  }

  /* ============================== 头像互动 ============================== */

  _onAvatarClick(pid, where, domEl) {
    if (!this.session || pid === this.selfId) return;
    const snap = this.session.snapshot();
    const member = snap.members.find((m) => m.id === pid);
    if (!member) return;

    const pop = $('popover');
    $('popover-name').textContent = `${member.name}${member.isAI ? ' · AI' : ''}`;
    const actions = $('popover-actions');
    actions.replaceChildren();

    const mk = (label, fn) => {
      const b = h('button', { class: 'pop-btn', type: 'button', text: label });
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        fn();
        this._closePopover();
      });
      return b;
    };
    actions.append(
      mk('🥚 鸡蛋', () => this._sendReaction(pid, REACTION.EGG, where, domEl)),
      mk('🌸 鲜花', () => this._sendReaction(pid, REACTION.FLOWER, where, domEl))
    );

    // 房主可以直接把 AI 请走
    const isHost = snap.mode === 'host' || snap.mode === 'local';
    if (isHost && member.isAI) {
      actions.append(
        mk('✖ 移除 AI', () => {
          this.session.removeMember(pid);
          this._renderLobby();
        })
      );
    }

    pop.hidden = false;
    const rect = domEl
      ? domEl.getBoundingClientRect()
      : { left: window.innerWidth / 2, top: window.innerHeight / 2, width: 0, height: 0 };
    const pw = pop.offsetWidth || 200;
    let left = rect.left + rect.width / 2 - pw / 2;
    left = Math.max(10, Math.min(window.innerWidth - pw - 10, left));
    let top = rect.top + rect.height + 10;
    if (top + pop.offsetHeight > window.innerHeight - 10) top = Math.max(10, rect.top - pop.offsetHeight - 10);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }

  _closePopover() {
    const pop = $('popover');
    if (pop && !pop.hidden) pop.hidden = true;
  }

  _sendReaction(pid, kind, where, domEl) {
    if (!this.session) return;
    this.session.sendReaction(pid, kind);
    this.audio.play(kind === 'flower' ? 'flower' : 'egg');
    // 自己扔的这一下立刻播动画，不等回声（回声回来时 _onReaction 会按 from 认出来并跳过）
    if (!this.fx.enabled) return;
    if (where === 'lobby') {
      this.fx.reactionDom(this._chipEls.get(this.selfId), domEl || this._chipEls.get(pid), kind);
    } else {
      this.fx.reaction(this.selfId, pid, kind);
    }
  }

  _onReaction(r) {
    if (!r || !r.to) return;
    if (r.from === this.selfId) return; // 自己扔的自己已经播过了
    this.audio.play(r.kind === 'flower' ? 'flower' : 'egg');
    if (this.screen === 'screen-board') {
      this.fx.reaction(r.from, r.to, r.kind);
    } else if (this.screen === 'screen-lobby') {
      this.fx.reactionDom(this._chipEls.get(r.from), this._chipEls.get(r.to), r.kind);
    }
  }

  /* ============================== 小部件 ============================== */

  toast(text, isError) {
    const el = $('toast');
    el.textContent = text;
    el.classList.toggle('error', !!isError);
    el.hidden = false;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      el.hidden = true;
    }, 2600);
  }

  _setBlocker(on, text) {
    this._blockerCount += on ? 1 : -1;
    const el = $('blocker');
    if (this._blockerCount > 0) {
      $('blocker-text').textContent = text || '处理中…';
      el.hidden = false;
    } else {
      this._blockerCount = 0;
      el.hidden = true;
    }
  }
}