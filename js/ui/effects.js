/**
 * BladeSteed — 特效层
 *
 * 设计原则：**只做便宜的事**。
 *   · 飞行物：一个 SVG 元素 + CSS transform 补间，浏览器走合成层，不占主线程
 *   · 爆开：用 Web Animations API 放射几颗粒子（最多 9 颗），动画结束立刻从 DOM 摘掉
 *   · 飘字 / 刀光：一段 CSS 动画，定时器到点删除
 * 全程没有 rAF 轮询、没有逐帧计算，所以手机上也稳。
 *
 * 关掉特效（body.no-fx）时，飞行物与粒子一律不创建，只保留必要的位移过渡。
 */

const NS = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

export class Effects {
  /** @param {import('./map.js').MapBoard} board */
  constructor(board) {
    this.board = board;
    this.enabled = true;
    this._banner = null;
  }

  get fx() {
    return this.board.fx;
  }

  /* ---------------------------- 扔鸡蛋 / 鲜花 ---------------------------- */

  /**
   * 从一个人头上飞到另一个人头上，命中后绽放 / 碎裂。
   * @param {string} fromPid
   * @param {string} toPid
   * @param {'egg'|'flower'} kind
   */
  reaction(fromPid, toPid, kind) {
    const to = this.board.posOf(toPid);
    if (!this.enabled) {
      this.impact(to, kind, toPid);
      return;
    }
    const from = this.board.posOf(fromPid);
    const glyph = kind === 'flower' ? '🌸' : '🥚';

    const item = el('text', { class: 'fly-item' });
    item.textContent = glyph;
    item.style.transition = 'transform .5s cubic-bezier(.35,.1,.35,1)';
    item.style.transform = `translate(${from.x}px, ${from.y}px)`;
    this.fx.append(item);

    // 两帧后再改目标位置，浏览器才会真的走过渡；不然会「瞬间就到」
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        item.style.transform = `translate(${to.x}px, ${to.y}px) rotate(320deg)`;
      })
    );
    setTimeout(() => {
      item.remove();
      this.impact(to, kind, toPid);
    }, 520);
  }

  /** 命中瞬间：鲜花绽放 / 鸡蛋碎裂 */
  impact(pos, kind, pid) {
    if (!this.enabled) return;
    const color = kind === 'flower' ? ['#ff9ec7', '#ffd6e7', '#ffc2dd'] : ['#fff3c4', '#ffe08a', '#f6d365'];
    const n = kind === 'flower' ? 8 : 9;
    const g = el('g', { class: 'burst', transform: `translate(${pos.x}, ${pos.y})` });
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.4;
      const dist = 14 + Math.random() * 10;
      const c = el('circle', { cx: 0, cy: 0, r: 2.2 + Math.random() * 1.8, fill: color[i % color.length] });
      g.append(c);
      c.animate(
        [
          { opacity: 1, transform: 'translate(0px,0px) scale(.4)' },
          { opacity: 0, transform: `translate(${Math.cos(a) * dist}px, ${Math.sin(a) * dist}px) scale(1.3)` },
        ],
        { duration: 460, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'forwards' }
      );
    }
    this.fx.append(g);
    setTimeout(() => g.remove(), 520);

    // 被砸的人抖一下
    if (pid) this.board.shake(pid);
  }

  /* ------------------------------ 攻击特效 ------------------------------ */

  /** 刀光 */
  slash(pos) {
    if (!this.enabled) return;
    const g = el('g', { class: 'slash-g', transform: `translate(${pos.x}, ${pos.y})` });
    const line = el('path', { class: 'slash', d: 'M -16 -14 L 16 14', 'stroke-dasharray': '46', 'stroke-dashoffset': '46' });
    const line2 = el('path', { class: 'slash', d: 'M -14 15 L 15 -13', 'stroke-dasharray': '44', 'stroke-dashoffset': '44' });
    g.append(line, line2);
    this.fx.append(g);
    setTimeout(() => g.remove(), 380);
  }

  /** 踹击：一脚踢过去的弧线 */
  kick(fromPos, toPos) {
    if (!this.enabled) return;
    const g = el('g', { class: 'kick-g' });
    const midX = (fromPos.x + toPos.x) / 2;
    const midY = (fromPos.y + toPos.y) / 2;
    const foot = el('text', { class: 'fly-item', x: 0, y: 0 });
    foot.textContent = '🦶';
    g.append(foot);
    g.style.transform = `translate(${fromPos.x}px, ${fromPos.y}px)`;
    this.fx.append(g);
    foot.animate(
      [
        { transform: 'translate(0px,0px) scale(.8)', opacity: 0.6 },
        { transform: `translate(${midX - fromPos.x}px, ${midY - fromPos.y}px) scale(1.3)`, opacity: 1 },
        { transform: `translate(${toPos.x - fromPos.x}px, ${toPos.y - fromPos.y}px) scale(1)`, opacity: 0.9 },
      ],
      { duration: 340, easing: 'cubic-bezier(.3,.8,.4,1)', fill: 'forwards' }
    );
    setTimeout(() => g.remove(), 420);
  }

  /** 飘一个数字上去（伤害） */
  damage(pos, text, color) {
    if (!this.enabled) return;
    const t = el('text', { class: 'dmg-float', x: pos.x, y: pos.y - 18, fill: color || '#ff7b7b' });
    t.textContent = text;
    this.fx.append(t);
    setTimeout(() => t.remove(), 950);
  }

  /** 头像上方冒一行小字（买刀 / 出城 / 进城…） */
  pop(pos, text, color) {
    if (!this.enabled) return;
    const t = el('text', { class: 'pop-text', x: pos.x, y: pos.y - 20, fill: color || '#ffb454' });
    t.textContent = text;
    this.fx.append(t);
    setTimeout(() => t.remove(), 950);
  }

  /* --------------------- 大厅里的互动（普通 DOM 版） --------------------- */

  /**
   * 大厅没有地图，只有一排头像，所以这里用普通 DOM 元素飞。
   * 逻辑和 SVG 版一致：从发送者头像中心飞到目标头像中心，命中后爆开。
   */
  reactionDom(fromEl, toEl, kind) {
    if (!fromEl || !toEl) return;
    const a = fromEl.getBoundingClientRect();
    const b = toEl.getBoundingClientRect();
    const from = { x: a.left + a.width / 2, y: a.top + a.height / 2 };
    const to = { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    const glyph = kind === 'flower' ? '🌸' : '🥚';

    if (this.enabled) {
      const item = document.createElement('div');
      item.className = 'dom-fly';
      item.textContent = glyph;
      item.style.transform = `translate(${from.x}px, ${from.y}px)`;
      document.body.append(item);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          item.style.transform = `translate(${to.x}px, ${to.y}px) rotate(320deg)`;
        })
      );
      setTimeout(() => {
        item.remove();
        this._domBurst(to, kind);
        toEl.classList.remove('shake');
        void toEl.offsetWidth;
        toEl.classList.add('shake');
      }, 480);
    } else {
      this._domBurst(to, kind);
    }
  }

  _domBurst(pos, kind) {
    if (!this.enabled) return;
    const color = kind === 'flower' ? '#ff9ec7' : '#ffe08a';
    const n = 7;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.4;
      const dist = 16 + Math.random() * 10;
      const p = document.createElement('div');
      p.className = 'dom-burst';
      p.style.background = color;
      p.style.left = `${pos.x}px`;
      p.style.top = `${pos.y}px`;
      document.body.append(p);
      p.animate(
        [
          { opacity: 1, transform: 'translate(-50%,-50%) scale(.4)' },
          { opacity: 0, transform: `translate(calc(-50% + ${Math.cos(a) * dist}px), calc(-50% + ${Math.sin(a) * dist}px)) scale(1.2)` },
        ],
        { duration: 440, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'forwards' }
      );
      setTimeout(() => p.remove(), 480);
    }
  }

  /* ------------------------------ 中央横幅 ------------------------------ */

  /** 屏幕中央的播报（谁赢、几步、行动顺序…） */
  banner(text, ms = 1600) {
    if (!this._banner) {
      this._banner = document.createElement('div');
      this._banner.className = 'banner';
      document.body.append(this._banner);
    }
    const b = this._banner;
    b.textContent = text;
    b.classList.remove('show');
    void b.offsetWidth;
    b.classList.add('show');
    clearTimeout(this._bannerTimer);
    this._bannerTimer = setTimeout(() => b.classList.remove('show'), ms);
  }

  /** 清空所有还在飞的特效（比如重新开局时） */
  clear() {
    for (const node of [...this.fx.children]) node.remove();
  }
}