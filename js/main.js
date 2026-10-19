/**
 * BladeSteed — 入口
 *
 * 整个项目零依赖、零构建：浏览器直接加载这个 ES Module 就能跑。
 * 部署 GitHub Pages 时不需要任何额外配置（见 README）。
 */

import { App } from './ui/app.js';

const app = new App();
app.boot();

// 方便调试：控制台里可以直接 window.bladeSteed 看当前会话与视图
window.bladeSteed = app;

// 页面被切到后台时不要继续播特效动画（省电、也避免回来时一堆动画一起炸）
document.addEventListener('visibilitychange', () => {
  document.body.classList.toggle('is-hidden', document.hidden);
});