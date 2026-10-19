/**
 * BladeSteed — 战场地图（SVG）
 *
 * 规则里「位置」只有两种：某人的城内 / 野外。
 * 地图把它画成：中间一片【野外】，四周环绕 N 座【城】（N = 本局人数）。
 * 开局随机分配的座位号决定谁在哪座城，头像就摆在他当前所在的位置上。
 *
 * 为什么要用 SVG 而不是 canvas：
 *   · 头像要能点（扔鸡蛋/鲜花），SVG 天然就是 DOM，不用自己算命中测试
 *   · 位置变化直接改 transform，浏览器自己补间，动画平滑且不占主线程
 *   · 缩放自适应，手机/电脑一套代码
 */

const NS = 'http://www.w3.org/2000/svg';

/** 画布尺寸（与 index.html 里的 viewBox 一致） */
const W = 400;
const H = 340;
const CX = W / 2;
const CY = 170;

/** 不同人数下的布局参数 */
const LAYOUT = {
  2: { cityR: 52, dist: 118, wildR: 46, angles: [180, 0] },
  3: { cityR: 46, dist: 112, wildR: 46, angles: [-90, 30, 150] },
  4: { cityR: 45, dist: 108, wildR: 46, angles: [-90, 0, 90, 180] },
};

const AVATAR_R = 12.5;
const HP_Y = 15;
const HP_W = 26;
const HP_H = 5;
const EQ_Y = 23;
/** 同一地点有多人时的环形站位半径 */
const RING_R = 20;
/** 点击热区半径：手机上也够好点（视觉半径的将近两倍） */
const HIT_R = 24;

function el(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/** 单人/多人站在同一个地点时的环形分布 */
function ringOffsets(count, radius) {
  if (count <= 0) return [];
  if (count === 1) return [{ dx: 0, dy: 0 }];
  const start = -Math.PI / 2 - (count === 2 ? Math.PI / 2 : 0);
  return Array.from({ length: count }, (_, i) => {
    const a = start + (i * 2 * Math.PI) / count;
    return { dx: Math.cos(a) * radius, dy: Math.sin(a) * radius };
  });
}

export class MapBoard {
  /**
   * @param {SVGElement} svg
   * @param {{onAvatarClick?:(pid:string)=>void}} [opts]
   */
  constructor(svg, { onAvatarClick } = {}) {
    this.svg = svg;
    this.onAvatarClick = onAvatarClick || (() => {});
    this.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

    // 分层：静态底图 / 头像 / 特效（特效永远在最上面）
    this.baseLayer = el('g', { class: 'layer-base' });
    this.tokenLayer = el('g', { class: 'layer-tokens' });
    this.fxLayer = el('g', { class: 'layer-fx' });
    this.svg.replaceChildren(this.baseLayer, this.tokenLayer, this.fxLayer);

    /** pid → { g, face, char, hpFill, hpText, eqKnife, eqHorse, hit } */
    this.nodes = new Map();
    /** pid → {x,y} 当前坐标（特效要用） */
    this.pos = new Map();
    this.signature = '';
    this.selfId = null;
  }

  /** 特效挂在这一层上 */
  get fx() {
    return this.fxLayer;
  }

  /** 某个头像此刻的坐标 */
  posOf(pid) {
    return this.pos.get(pid) || { x: CX, y: CY };
  }

  /** 某个头像「上一步」的坐标（特效回放用） */
  prevPosOf(pid) {
    return (this.prevPos && this.prevPos.get(pid)) || this.posOf(pid);
  }

  /* ------------------------------ 底图 ------------------------------ */

  _buildBase(players) {
    const n = Math.max(2, Math.min(4, players.length));
    const layout = LAYOUT[n];
    const sig = `${n}:${players.map((p) => p.id).sort().join(',')}`;
    if (sig === this.signature) return layout;
    this.signature = sig;

    const bySeat = [...players].sort((a, b) => a.seat - b.seat);
    this.baseLayer.replaceChildren();

    // 野外（中间那块公共区域）
    this.baseLayer.append(el('circle', { class: 'wild-ring', cx: CX, cy: CY, r: layout.wildR }));
    const wildName = el('text', { class: 'wild-name', x: CX, y: CY - layout.wildR + 14 });
    wildName.textContent = '野 外';
    this.baseLayer.append(wildName);
    this.wildLabelY = CY - layout.wildR + 14;

    // 每座城（城属于玩家，永久存在）
    this.cityPos = new Map();
    bySeat.forEach((p, i) => {
      const a = (layout.angles[i] * Math.PI) / 180;
      const x = CX + Math.cos(a) * layout.dist;
      const y = CY + Math.sin(a) * layout.dist;
      this.cityPos.set(p.id, { x, y, r: layout.cityR });
      this.baseLayer.append(el('circle', { class: 'city-ring', cx: x, cy: y, r: layout.cityR, 'data-city': p.id }));
    });
    this.layout = layout;
    return layout;
  }

  /* ------------------------------ 头像 ------------------------------ */

  _makeToken(p) {
    const g = el('g', { class: 'token', 'data-pid': p.id });
    // 透明的大热区：手机上也好点
    const hit = el('circle', { cx: 0, cy: 0, r: HIT_R, fill: 'transparent', class: 'tok-hit', 'data-pid': p.id });
    const face = el('circle', { class: 'tok-face', cx: 0, cy: 0, r: AVATAR_R });
    const char = el('text', { class: 'tok-char', x: 0, y: 0 });
    const hpbg = el('rect', { class: 'tok-hpbg', x: -HP_W / 2, y: HP_Y, width: HP_W, height: HP_H, rx: 2.4 });
    const hpFill = el('rect', { class: 'tok-hpfill', x: -HP_W / 2 + 0.6, y: HP_Y + 0.6, width: HP_W - 1.2, height: HP_H - 1.2, rx: 2 });
    const hpText = el('text', { class: 'tok-hptext', x: 0, y: HP_Y + HP_H / 2 + 0.5 });
    const eqKnife = el('text', { class: 'eq', x: -7, y: EQ_Y });
    const eqHorse = el('text', { class: 'eq', x: 7, y: EQ_Y });
    eqKnife.textContent = '刀';
    eqHorse.textContent = '马';

    // 事件挂在整组上：头像圆、血条、装备都可能被点到，挂在小热区上会漏
    g.addEventListener('click', (ev) => {
      ev.stopPropagation();
      // 把热区元素一起传出去，界面才知道该把「扔道具」菜单弹在哪
      this.onAvatarClick(p.id, hit);
    });
    // 手指按下时就给一点反馈
    g.addEventListener('pointerdown', () => face.classList.add('press'));

    g.append(hit, face, char, hpbg, hpFill, hpText, eqKnife, eqHorse);
    return { g, face, char, hpFill, hpText, eqKnife, eqHorse, hpbg, hit };
  }

  /**
   * 按一帧视图刷新地图。
   * @param {object} view viewFor(...) 的结果
   * @param {string} selfId
   */
  render(view, selfId) {
    if (!view) return;
    this.selfId = selfId;
    // 记下「这一步之前」的坐标：攻击特效要用它来确定「打之前那人站在哪」
    // （否则等渲染完再去问，人已经被踹到野外了）
    this.prevPos = new Map(this.pos);
    const players = view.players;
    const layout = this._buildBase(players);

    // 1) 每个位置上有哪些人（决定环形站位）
    const groups = new Map();
    for (const p of players) {
      const key = p.place === 'wild' ? 'wild' : `city:${p.place}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }

    const alive = players.filter((p) => p.alive).length;
    this.aliveCount = alive;

    // 2) 逐人更新
    const seen = new Set();
    for (const p of players) {
      seen.add(p.id);
      let node = this.nodes.get(p.id);
      if (!node) {
        node = this._makeToken(p);
        this.nodes.set(p.id, node);
        this.tokenLayer.append(node.g);
      }

      const key = p.place === 'wild' ? 'wild' : `city:${p.place}`;
      const group = groups.get(key);
      // 同一地点按座位号排一下，位置才稳定，不会每次刷新都换人
      group.sort((a, b) => a.seat - b.seat);
      const idx = group.findIndex((x) => x.id === p.id);
      const offs = ringOffsets(group.length, group.length === 1 ? 0 : RING_R);
      const off = offs[idx] || { dx: 0, dy: 0 };

      let base;
      if (p.place === 'wild') base = { x: CX, y: CY };
      else base = this.cityPos.get(p.place) || { x: CX, y: CY };
      const x = base.x + off.dx;
      const y = base.y + off.dy;
      this.pos.set(p.id, { x, y });

      // 位置变化靠 CSS transition 补间，所以只要改 transform —— 外面就看到了「走过去」的动画
      node.g.setAttribute('transform', `translate(${x}, ${y})`);

      node.char.textContent = p.name;
      const cls = ['token'];
      if (p.id === selfId) cls.push('is-me');
      if (!p.alive) cls.push('is-dead');
      if (view.current === p.id && view.phase === 'action') cls.push('is-current');
      node.g.setAttribute('class', cls.join(' '));

      // 血量条
      const ratio = Math.max(0, Math.min(1, p.hp / 10));
      node.hpFill.setAttribute('width', Math.max(0, (HP_W - 1.2) * ratio));
      node.hpFill.setAttribute('class', `tok-hpfill${ratio <= 0.3 ? ' low' : ratio <= 0.6 ? ' warn' : ''}`);
      node.hpText.textContent = p.alive ? String(p.hp) : '✕';

      // 装备亮暗
      node.eqKnife.setAttribute('class', `eq${p.knife ? ' has' : ''}`);
      node.eqHorse.setAttribute('class', `eq${p.horse ? ' has' : ''}`);

      node.g.style.opacity = p.alive ? '1' : '0.4';
    }

    // 3) 清掉已经不在名单里的人
    for (const [pid, node] of [...this.nodes]) {
      if (seen.has(pid)) continue;
      node.g.remove();
      this.nodes.delete(pid);
      this.pos.delete(pid);
    }

    // 4) 记下当前行动者，供外部（比如「轮到你了」的提示）查询
    this.currentPid = view.phase === 'action' ? view.current : null;
  }

  /** 高亮某个头像（被攻击时抖一下） */
  shake(pid) {
    const node = this.nodes.get(pid);
    if (!node) return;
    node.g.classList.remove('shake');
    // 强制回流，保证同一个动画能连续播两次
    void node.g.getBoundingClientRect();
    node.g.classList.add('shake');
    setTimeout(() => node.g.classList.remove('shake'), 360);
  }
}