/**
 * BladeSteed — 房间会话
 *
 * 三种模式共用同一套对局驱动（GameDriver），所以三种模式的规则行为完全一致：
 *   · LocalSession   单机人机：完全不走网络
 *   · HostSession    房主：**唯一的权威状态机**，负责校验、裁剪、广播、断连判定
 *   · ClientSession  客人：只发操作意图，只收「自己该看到的那一份」状态
 *
 * 配对流程（没有任何后端，全靠公共信令通道撮合）：
 *   客人广播 HELLO → 房主回 HOST_PRESENT → 客人发 OFFER → 房主回 ANSWER
 *   → 建立 WebRTC DataChannel（直连）。
 * 任何一步失败都不影响对局：对局消息会自动走「中转模式」（信令通道转发）。
 *
 * 可靠性：
 *   · 操作带 actionId，没收到回执就重发，房主按 id 去重 —— 公共通道是 QoS0，消息会丢。
 *   · 状态帧带 seq，客户端收到就回 STATE_ACK；房主每 2 秒补齐落后的人。
 *     （状态帧是完整快照，幂等覆盖，丢一帧不会让人卡在旧状态。）
 */

import { LINK, MSG, REACTION, ROOM_CODE_LENGTH, envelope, makeMsgId, makePeerId } from './protocol.js';
import { SignalBus } from './channels.js';
import { PeerLink } from './rtc.js';
import { GameDriver } from '../game/match.js';
import { Emitter } from '../game/emitter.js';
import { MAX_PLAYERS, isValidName, normalizeName } from '../engine/constants.js';
import { pickAiName } from '../ai/ai.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 客人多久没听到房主的声音就算断线（毫秒） */
const HOST_TIMEOUT_MS = 15000;
/** 房主多久没收到某个客人的消息就判他掉线（毫秒） */
const CLIENT_TIMEOUT_MS = 15000;
/** 心跳间隔 */
const HEARTBEAT_MS = 3000;
/** 房主周期性补发状态的间隔 */
const STATE_RESYNC_MS = 2000;

export { isValidName, normalizeName };

/** 玩家 id 前缀：AI 用固定前缀，便于识别与生成名字 */
const AI_ID_PREFIX = 'ai_';

/* ============================== 单机人机 ============================== */

export class LocalSession extends Emitter {
  /**
   * @param {object} opts
   * @param {string} opts.name 自己的单字名
   * @param {number} [opts.size] 2/3/4 人局
   */
  constructor({ name, size = 4 }) {
    super();
    this.mode = 'local';
    this.selfId = makePeerId();
    this.selfName = normalizeName(name) || '我';
    this.members = [{ id: this.selfId, name: this.selfName, isAI: false, isHost: true, connected: true }];
    while (this.members.length < Math.min(MAX_PLAYERS, Math.max(2, size))) this.addAi();
    this.driver = null;
    this.view = null;
    this.over = false;
  }

  /** 大厅里加一个 AI 补位 */
  addAi() {
    if (this.members.length >= MAX_PLAYERS) return { ok: false, error: `最多 ${MAX_PLAYERS} 人` };
    const id = AI_ID_PREFIX + Math.random().toString(36).slice(2, 8);
    const name = pickAiName(this.members.map((m) => m.name));
    this.members.push({ id, name, isAI: true, isHost: false, connected: true });
    if (this.driver) this.driver.addPlayer({ id, name, isAI: true });
    this.emit('update');
    return { ok: true };
  }

  /** 大厅里踢掉一个 AI（真人自己不能踢） */
  removeMember(id) {
    if (id === this.selfId) return { ok: false, error: '不能移除自己' };
    const before = this.members.length;
    this.members = this.members.filter((m) => m.id !== id || !m.isAI);
    if (this.members.length === before) return { ok: false, error: '找不到这个成员' };
    if (this.driver) this.driver.removePlayer(id);
    this.emit('update');
    return { ok: true };
  }

  start() {
    if (this.driver) return;
    this.driver = new GameDriver({ roster: this.members.map((m) => ({ id: m.id, name: m.name, isAI: m.isAI })) });
    this.driver.on('change', () => this._sync());
    this.driver.start();
    this._sync();
  }

  restart() {
    if (!this.driver) return;
    this.driver.restart();
  }

  submitRps(choice) {
    return this.driver ? this.driver.submitRps(this.selfId, choice) : { ok: false, error: '对局还没开始' };
  }

  submitOrder(order) {
    return this.driver ? this.driver.submitOrder(this.selfId, order) : { ok: false, error: '对局还没开始' };
  }

  act(action) {
    return this.driver ? this.driver.act(this.selfId, action) : { ok: false, error: '对局还没开始' };
  }

  /** 单机模式下扔鸡蛋/鲜花：本地回环一下，让动画照常播 */
  sendReaction(to, kind) {
    this.emit('reaction', { from: this.selfId, to, kind, id: makeMsgId(this.selfId) });
    return { ok: true };
  }

  leave() {
    if (this.driver) this.driver.stop();
    this.driver = null;
  }

  _sync() {
    this.view = this.driver.viewFor(this.selfId);
    this.over = this.view.phase === 'over';
    this.emit('update');
  }

  /** 给 UI 的统一状态快照 */
  snapshot() {
    return {
      mode: this.mode,
      selfId: this.selfId,
      selfName: this.selfName,
      roomCode: '',
      members: this.members.map((m) => ({ ...m, isSelf: m.id === this.selfId })),
      net: null,
      match: this.view,
      started: !!this.driver,
    };
  }
}

/* ============================== 房主 ============================== */

export class HostSession extends Emitter {
  /**
   * @param {object} opts
   * @param {string} opts.name
   * @param {string} opts.roomCode
   */
  constructor({ name, roomCode }) {
    super();
    this.mode = 'host';
    this.selfId = makePeerId();
    this.selfName = normalizeName(name) || '主';
    this.roomCode = roomCode;
    /** @type {{id:string,name:string,isAI:boolean,isHost:boolean,connected:boolean,lastSeen:number}[]} */
    this.members = [
      { id: this.selfId, name: this.selfName, isAI: false, isHost: true, connected: true, lastSeen: Date.now() },
    ];
    /** @type {Map<string, PeerLink>} */
    this.links = new Map();
    this.bus = null;
    this.driver = null;
    this.view = null;
    this.netStatus = { open: 0, channels: [] };
    this._timers = [];
    this._closed = false;
    this._broadcastTimer = null;
    this._seenActions = new Set();
    this._seenActionOrder = [];
  }

  /* ---------------------------- 开局前准备 ---------------------------- */

  /** 打开公共信令通道并开始应答客人的 HELLO */
  async open({ timeoutMs = 6000 } = {}) {
    this.bus = new SignalBus({
      room: this.roomCode,
      peerId: this.selfId,
      onMessage: (from, msg) => this._onMessage(from, msg),
      onStatus: (st) => {
        this.netStatus = st;
        this.emit('update');
      },
    });
    const open = await this.bus.open({ timeoutMs });
    this.netStatus = this.bus.status();

    // 心跳：给客人回 PONG，并对超时的人判掉线
    this._timers.push(setInterval(() => this._heartbeat(), HEARTBEAT_MS));
    // 周期性补发状态，保证没人卡在旧帧
    this._timers.push(
      setInterval(() => {
        if (this.driver) this._broadcastState();
      }, STATE_RESYNC_MS)
    );
    this.emit('update');
    return open;
  }

  /** 大厅里加一个 AI 补位（对局中也可以，会立刻出现在场上） */
  addAi() {
    if (this.members.length >= MAX_PLAYERS) return { ok: false, error: `最多 ${MAX_PLAYERS} 人` };
    const id = AI_ID_PREFIX + Math.random().toString(36).slice(2, 8);
    const name = pickAiName(this.members.map((m) => m.name));
    this.members.push({ id, name, isAI: true, isHost: false, connected: true, lastSeen: Date.now() });
    if (this.driver) this.driver.addPlayer({ id, name, isAI: true });
    this._broadcastLobby();
    this.emit('update');
    return { ok: true };
  }

  /** 把某个成员请出去（AI 直接删，真人通知他并断开直连） */
  removeMember(id) {
    if (id === this.selfId) return { ok: false, error: '房主不能移除自己' };
    const m = this.members.find((x) => x.id === id);
    if (!m) return { ok: false, error: '找不到这个成员' };
    this.members = this.members.filter((x) => x.id !== id);
    if (m.isAI) {
      if (this.driver) this.driver.removePlayer(id);
    } else {
      this.sendTo(id, envelope({ id: makeMsgId(this.selfId), from: this.selfId, to: id, type: MSG.BYE, reason: '房主把你请出了房间' }));
      const link = this.links.get(id);
      if (link) {
        link.close();
        this.links.delete(id);
      }
      if (this.driver) this.driver.removePlayer(id);
    }
    this._broadcastLobby();
    if (this.driver) this._broadcastState();
    this.emit('update');
    return { ok: true };
  }

  /* ---------------------------- 开局 ---------------------------- */

  startMatch() {
    const roster = this.members
      .filter((m) => m.connected || m.isAI)
      .map((m) => ({ id: m.id, name: m.name, isAI: m.isAI }));
    if (roster.length < 2) return { ok: false, error: '至少要 2 个人才能开局' };

    this.members = this.members.filter((m) => m.connected || m.isAI);
    this.driver = new GameDriver({ roster });
    this.driver.on('change', () => this._onEngineChange());
    this.driver.start();

    for (const m of this.members) {
      if (m.id === this.selfId) continue;
      this.sendTo(
        m.id,
        envelope({ id: makeMsgId(this.selfId), from: this.selfId, to: m.id, type: MSG.START, roster })
      );
    }
    this.emit('update');
    this._broadcastState();
    return { ok: true };
  }

  restart() {
    if (!this.driver) return;
    this.driver.restart();
  }

  /* ---------------------------- 输入 ---------------------------- */

  submitRps(choice) {
    return this.driver ? this.driver.submitRps(this.selfId, choice) : { ok: false, error: '对局还没开始' };
  }

  submitOrder(order) {
    return this.driver ? this.driver.submitOrder(this.selfId, order) : { ok: false, error: '对局还没开始' };
  }

  act(action) {
    return this.driver ? this.driver.act(this.selfId, action) : { ok: false, error: '对局还没开始' };
  }

  /** 房主自己扔鸡蛋/鲜花：广播给所有人（含自己，靠 from 判断是不是自己扔的） */
  sendReaction(to, kind) {
    const msg = envelope({
      id: makeMsgId(this.selfId),
      from: this.selfId,
      to: 'all',
      type: MSG.REACTION,
      target: to,
      kind,
    });
    this._fanout(msg);
    this.emit('reaction', { from: this.selfId, to, kind, id: msg.id });
    return { ok: true };
  }

  leave(reason = '房主离开了房间') {
    const msg = envelope({ id: makeMsgId(this.selfId), from: this.selfId, to: 'all', type: MSG.BYE, reason });
    this._fanout(msg);
    this.close();
  }

  close() {
    this._closed = true;
    for (const t of this._timers) clearInterval(t);
    this._timers = [];
    clearTimeout(this._broadcastTimer);
    if (this.driver) this.driver.stop();
    for (const link of this.links.values()) link.close();
    this.links.clear();
    if (this.bus) this.bus.close();
    this.bus = null;
  }

  /* ---------------------------- 收发 ---------------------------- */

  /** 发给某个 peer：优先直连，直连不通自动走中转 */
  sendTo(peerId, msg) {
    const link = this.links.get(peerId);
    if (link) {
      link.send(msg);
      return;
    }
    if (this.bus) this.bus.send(peerId, msg);
  }

  /** 发给所有人 */
  _fanout(msg) {
    for (const m of this.members) {
      if (m.id === this.selfId) continue;
      this.sendTo(m.id, msg);
    }
  }

  _onMessage(from, msg) {
    if (this._closed) return;
    const member = this.members.find((m) => m.id === from);
    if (member) member.lastSeen = Date.now();

    switch (msg.type) {
      case MSG.HELLO:
        this._onHello(from, msg);
        break;

      case MSG.OFFER:
        this._onOffer(from, msg);
        break;

      case MSG.ICE: {
        const link = this.links.get(from);
        if (link) link.handleIce(msg.candidate);
        break;
      }

      case MSG.ACTION:
        this._onAction(from, msg);
        break;

      case MSG.STATE_ACK: {
        // 客人收到了第几帧。这里只用于观测，真正的兜底是周期性全量补发。
        if (member) member.ackedRev = msg.seq;
        break;
      }

      case MSG.STATE_REQ:
        if (this.driver && member) {
          this.sendTo(from, this._stateMsgFor(from));
        }
        break;

      case MSG.REACTION: {
        // 转发给所有人（含发起者自己，客户端看到 from 是自己就不用重复播动画）
        const out = envelope({
          id: msg.id || makeMsgId(this.selfId),
          from,
          to: 'all',
          type: MSG.REACTION,
          target: msg.target,
          kind: msg.kind,
        });
        this._fanout(out);
        this.emit('reaction', { from, to: msg.target, kind: msg.kind, id: out.id });
        break;
      }

      case MSG.PING:
        this.sendTo(from, envelope({ id: makeMsgId(this.selfId), from: this.selfId, to: from, type: MSG.PONG }));
        break;

      case MSG.BYE:
        this._dropMember(from, '离开了房间');
        break;

      default:
        break;
    }
  }

  _onHello(from, msg) {
    let member = this.members.find((m) => m.id === from);
    if (!member) {
      if (this.members.length >= MAX_PLAYERS) {
        // 满员：礼貌拒绝
        this.sendTo(
          from,
          envelope({
            id: makeMsgId(this.selfId),
            from: this.selfId,
            to: from,
            type: MSG.HOST_PRESENT,
            full: true,
            reason: `房间已经满了（最多 ${MAX_PLAYERS} 人）`,
          })
        );
        return;
      }
      if (this.driver) {
        // 对局已经开始：可以中途加入，但要等下一个猜拳回合才参与行动
        // （引擎自己会处理，这里只是把人加进名单）
      }
      let name = normalizeName(msg.name);
      if (!isValidName(name)) name = pickAiName(this.members.map((m) => m.name));
      if (this.members.some((m) => m.name === name)) name = pickAiName(this.members.map((m) => m.name));
      member = { id: from, name, isAI: false, isHost: false, connected: true, lastSeen: Date.now() };
      this.members.push(member);
      if (this.driver) this.driver.addPlayer({ id: from, name, isAI: false });
    }
    member.connected = true;
    member.lastSeen = Date.now();

    // 告诉他是谁在当房主（顺便把最终名字回给他）
    this.sendTo(
      from,
      envelope({
        id: makeMsgId(this.selfId),
        from: this.selfId,
        to: from,
        type: MSG.HOST_PRESENT,
        full: false,
        name: member.name,
      })
    );
    this._broadcastLobby();
    if (this.driver) this._broadcastState();
    this.emit('update');
  }

  _onOffer(from, msg) {
    let link = this.links.get(from);
    if (!link) {
      link = new PeerLink({
        selfId: this.selfId,
        peerId: from,
        isHost: true,
        signalOut: (to, m) => this._signal(to, m),
        relayOut: (to, m) => this.bus && this.bus.send(to, m),
        onMessage: (peerId, m) => this._onMessage(peerId, m),
        onModeChange: () => this.emit('update'),
      });
      this.links.set(from, link);
    }
    link.handleOffer(msg.sdp);
  }

  _signal(to, m) {
    if (this.bus) this.bus.send(to, envelope({ id: makeMsgId(this.selfId), from: this.selfId, to, ...m }));
  }

  _onAction(from, msg) {
    if (!this.driver) return;
    // 去重：公共通道是 QoS0，客人会重发，同一条操作只受理一次
    const key = msg.actionId || msg.id;
    if (key) {
      if (this._seenActions.has(key)) {
        this.sendTo(from, envelope({ id: makeMsgId(this.selfId), from: this.selfId, to: from, type: MSG.ACTION_ACK, actionId: key, ok: true, duplicate: true }));
        return;
      }
      this._seenActions.add(key);
      this._seenActionOrder.push(key);
      if (this._seenActionOrder.length > 400) this._seenActions.delete(this._seenActionOrder.shift());
    }

    let r = { ok: false, error: '未知操作' };
    if (msg.kind === 'rps') r = this.driver.submitRps(from, msg.choice);
    else if (msg.kind === 'order') r = this.driver.submitOrder(from, msg.order);
    else if (msg.kind === 'act') r = this.driver.act(from, msg.action);

    this.sendTo(
      from,
      envelope({
        id: makeMsgId(this.selfId),
        from: this.selfId,
        to: from,
        type: MSG.ACTION_ACK,
        actionId: key,
        ok: !!r.ok,
        error: r.error || '',
      })
    );
    if (r.ok) this._broadcastState();
  }

  _stateMsgFor(peerId) {
    const view = this.driver.viewFor(peerId);
    return envelope({
      id: makeMsgId(this.selfId),
      from: this.selfId,
      to: peerId,
      type: MSG.STATE,
      seq: view.rev,
      view,
    });
  }

  _onEngineChange() {
    // 状态变化可能连着来好几下（比如 AI 一次性提交），合并成一次广播
    clearTimeout(this._broadcastTimer);
    this._broadcastTimer = setTimeout(() => {
      this._broadcastState();
      this.emit('update');
    }, 60);
  }

  _broadcastState() {
    if (!this.driver || this._closed) return;
    for (const m of this.members) {
      if (m.id === this.selfId || m.isAI) continue;
      this.sendTo(m.id, this._stateMsgFor(m.id));
    }
    this.view = this.driver.viewFor(this.selfId);
    this.emit('update');
  }

  _broadcastLobby() {
    const lobby = {
      members: this.members.map((m) => ({ id: m.id, name: m.name, isAI: m.isAI, isHost: m.isHost, connected: m.connected })),
      started: !!this.driver,
    };
    this._fanout(envelope({ id: makeMsgId(this.selfId), from: this.selfId, to: 'all', type: MSG.LOBBY, lobby }));
    this.view = this.driver ? this.driver.viewFor(this.selfId) : null;
    this.emit('update');
  }

  /** 心跳：回 PONG 由 _onMessage 处理；这里负责判掉线 */
  _heartbeat() {
    if (this._closed) return;
    const now = Date.now();
    for (const m of this.members.slice()) {
      if (m.id === this.selfId || m.isAI) continue;
      if (m.connected && now - (m.lastSeen || 0) > CLIENT_TIMEOUT_MS) {
        // 断连 = 自动判出局
        this._dropMember(m.id, '断线了');
      }
    }
  }

  _dropMember(id, reason) {
    const m = this.members.find((x) => x.id === id);
    if (!m) return;
    m.connected = false;
    const link = this.links.get(id);
    if (link) {
      link.close();
      this.links.delete(id);
    }
    if (this.driver) {
      this.driver.removePlayer(id);
      this._broadcastState();
    }
    // 从名单里移除（他的城会永久留在地图上，引擎自己保证）
    this.members = this.members.filter((x) => x.id !== id);
    this._broadcastLobby();
    this.emit('toast', `${m.name} ${reason}，已判出局`);
    this.emit('update');
  }

  snapshot() {
    return {
      mode: this.mode,
      selfId: this.selfId,
      selfName: this.selfName,
      roomCode: this.roomCode,
      members: this.members.map((m) => ({ ...m, isSelf: m.id === this.selfId })),
      net: this.bus ? this.bus.status() : this.netStatus,
      direct: [...this.links.values()].filter((l) => l.isDirect).length,
      /** 房主侧只要有一条直连就算直连可用；全是中转时提示玩家 */
      linkMode: [...this.links.values()].some((l) => l.isDirect)
        ? LINK.DIRECT
        : this.links.size
          ? LINK.RELAY
          : LINK.CONNECTING,
      match: this.driver ? (this.view = this.driver.viewFor(this.selfId)) : null,
      started: !!this.driver,
    };
  }
}

/* ============================== 客人 ============================== */

export class ClientSession extends Emitter {
  constructor({ name }) {
    super();
    this.mode = 'client';
    this.selfId = makePeerId();
    this.selfName = normalizeName(name) || '客';
    this.roomCode = '';
    this.hostId = null;
    this.members = [];
    this.link = null;
    this.bus = null;
    this.view = null;
    this.netStatus = { open: 0, channels: [] };
    this._timers = [];
    this._closed = false;
    this._lastHostSeen = Date.now();
    /** 待回执的操作：actionId → {done} */
    this._pendingActions = new Map();
    this._actionCounter = 0;
    this._lastStateSeq = 0;
    this.started = false;
    this.linkMode = LINK.CONNECTING;
  }

  /** 加入房间：开通道 → 喊 HELLO → 等房主应答 */
  async join(roomCode, { timeoutMs = 6000, waitMs = 12000 } = {}) {
    this.roomCode = roomCode;
    this.bus = new SignalBus({
      room: roomCode,
      peerId: this.selfId,
      onMessage: (from, msg) => this._onMessage(from, msg),
      onStatus: (st) => {
        this.netStatus = st;
        this.emit('update');
      },
    });
    const open = await this.bus.open({ timeoutMs });
    this.netStatus = this.bus.status();
    if (open === 0) {
      return { ok: false, error: '连不上任何公共信令通道，请检查网络后重试' };
    }

    // 喊人：喊几遍，避免第一声丢了
    const shout = () =>
      this.bus.send(
        'all',
        envelope({ id: makeMsgId(this.selfId), from: this.selfId, to: 'all', type: MSG.HELLO, name: this.selfName })
      );
    shout();
    const shoutTimer = setInterval(shout, 2500);

    const ok = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), waitMs);
      this.once('host-present', () => {
        clearTimeout(t);
        resolve(true);
      });
    });
    clearInterval(shoutTimer);
    if (!ok) {
      this.close();
      return { ok: false, error: '没找到这个房间。确认房间号是否正确，或让房主重开房间。' };
    }

    this._timers.push(setInterval(() => this._heartbeat(), HEARTBEAT_MS));
    this.emit('update');
    return { ok: true };
  }

  once(name, cb) {
    const wrapper = (...args) => {
      this.off(name, wrapper);
      cb(...args);
    };
    return this.on(name, wrapper);
  }

  /* ---------------------------- 输入 ---------------------------- */

  /** 发一条消息给房主，返回这条消息的 id（调用方需要的话可以拿去用） */
  _sendToHost(msg) {
    const id = msg.id || makeMsgId(this.selfId);
    const full = envelope({ ...msg, id, from: this.selfId, to: this.hostId });
    if (this.link) this.link.send(full);
    else if (this.bus) this.bus.send(this.hostId, full);
    return id;
  }

  /**
   * 发一个操作意图。
   * 房主没回执就重发（公共通道是 QoS0，丢消息很常见），重发用的 actionId 不变，
   * 房主那边按 id 去重，所以重复受理不会造成二次伤害。
   */
  _intent(kind, payload) {
    if (!this.hostId) return { ok: false, error: '还没连上房主' };
    const actionId = `${this.selfId}-act-${++this._actionCounter}`;
    const send = () => this._sendToHost({ type: MSG.ACTION, kind, actionId, ...payload });
    send();

    // 3 秒没回执就再发一次，最多重试 2 次
    let tries = 0;
    const retry = setInterval(() => {
      tries += 1;
      if (this._pendingActions.get(actionId)?.done || tries > 2) {
        clearInterval(retry);
        return;
      }
      send();
    }, 3000);
    this._pendingActions.set(actionId, { done: false });
    return { ok: true, pending: true, actionId };
  }

  submitRps(choice) {
    return this._intent('rps', { choice });
  }

  submitOrder(order) {
    return this._intent('order', { order });
  }

  act(action) {
    return this._intent('act', { action });
  }

  sendReaction(to, kind) {
    const id = this._sendToHost({ type: MSG.REACTION, target: to, kind });
    // 自己先播一遍动画，不用等房主回声
    this.emit('reaction', { from: this.selfId, to, kind, id: 'local-' + id });
    return { ok: true };
  }

  leave() {
    if (this.hostId) {
      try {
        this._sendToHost({ type: MSG.BYE });
      } catch {
        /* 忽略 */
      }
    }
    this.close();
  }

  close() {
    this._closed = true;
    for (const t of this._timers) clearInterval(t);
    this._timers = [];
    if (this.link) {
      this.link.close();
      this.link = null;
    }
    if (this.bus) {
      this.bus.close();
      this.bus = null;
    }
  }

  /* ---------------------------- 收消息 ---------------------------- */

  _onMessage(from, msg) {
    if (this._closed) return;
    if (msg.type !== MSG.ICE && msg.type !== MSG.OFFER && msg.type !== MSG.ANSWER) {
      this._lastHostSeen = Date.now();
    }

    switch (msg.type) {
      case MSG.HOST_PRESENT: {
        if (msg.full) {
          this.emit('error', msg.reason || '房间已经满了');
          this.close();
          return;
        }
        if (this.hostId && this.hostId !== from) return; // 已经有房主了
        this.hostId = from;
        if (msg.name) this.selfName = msg.name;
        this.emit('host-present', from);
        this._connectToHost();
        break;
      }

      case MSG.ANSWER:
        if (this.link) this.link.handleAnswer(msg.sdp);
        break;

      case MSG.ICE:
        if (this.link) this.link.handleIce(msg.candidate);
        break;

      case MSG.LOBBY: {
        const lobby = msg.lobby || {};
        this.members = (lobby.members || []).map((m) => ({ ...m, isSelf: m.id === this.selfId }));
        const me = this.members.find((m) => m.id === this.selfId);
        if (me && me.name) this.selfName = me.name;
        this.started = !!lobby.started;
        this.emit('update');
        break;
      }

      case MSG.START: {
        this.started = true;
        if (msg.roster) {
          this.members = msg.roster.map((m) => ({ ...m, isHost: m.id === this.hostId, isSelf: m.id === this.selfId }));
        }
        this.emit('update');
        break;
      }

      case MSG.STATE: {
        this.view = msg.view;
        this._lastStateSeq = msg.seq;
        this._sendToHost({ type: MSG.STATE_ACK, seq: msg.seq });
        this.emit('update');
        break;
      }

      case MSG.ACTION_ACK: {
        const p = this._pendingActions.get(msg.actionId);
        if (p) p.done = true;
        if (!msg.ok && msg.error) this.emit('error', msg.error);
        this.emit('update');
        break;
      }

      case MSG.REACTION: {
        if (from === this.selfId) break;
        this.emit('reaction', { from, to: msg.target, kind: msg.kind, id: msg.id });
        break;
      }

      case MSG.BYE: {
        this.emit('error', msg.reason || '房主离开了房间');
        this.emit('host-gone');
        this.close();
        break;
      }

      case MSG.PONG:
        break;

      default:
        break;
    }
  }

  /** 和房主建立 WebRTC 直连（失败了也没关系，消息会自动走中转） */
  _connectToHost() {
    if (this.link || !this.hostId) return;
    this.link = new PeerLink({
      selfId: this.selfId,
      peerId: this.hostId,
      isHost: false,
      signalOut: (to, m) =>
        this.bus && this.bus.send(to, envelope({ id: makeMsgId(this.selfId), from: this.selfId, to, ...m })),
      relayOut: (to, m) => this.bus && this.bus.send(to, m),
      onMessage: (peerId, m) => this._onMessage(peerId, m),
      onModeChange: (peerId, mode) => {
        this.linkMode = mode;
        this.emit('update');
      },
    });
    this.link.startAsOfferer();
    this.emit('update');
  }

  /** 心跳：还听得到房主的声音吗 */
  _heartbeat() {
    if (this._closed) return;
    try {
      this._sendToHost({ type: MSG.PING });
    } catch {
      /* 忽略 */
    }
    if (this.hostId && Date.now() - this._lastHostSeen > HOST_TIMEOUT_MS) {
      this.emit('host-gone');
      this.close();
    }
  }

  snapshot() {
    return {
      mode: this.mode,
      selfId: this.selfId,
      selfName: this.selfName,
      roomCode: this.roomCode,
      members: this.members,
      net: this.bus ? this.bus.status() : this.netStatus,
      linkMode: this.link ? (this.link.isDirect ? LINK.DIRECT : LINK.RELAY) : LINK.CONNECTING,
      match: this.view,
      started: !!this.started,
    };
  }
}

/** 单字名校验再导出一次，UI 直接用 */
export { ROOM_CODE_LENGTH, REACTION, sleep };