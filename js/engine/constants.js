/**
 * BladeSteed — 规则常量
 *
 * 这里的每一条都对应规则书里的一句话，改规则只改这里。
 */

/** 每位玩家固定 10 滴血 */
export const MAX_HP = 10;

/** 一刀固定扣 1 滴血 */
export const KNIFE_DAMAGE = 1;

/** 一踹固定扣 3 滴血 */
export const KICK_DAMAGE = 3;

/** 支持 2 / 3 / 4 人 */
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;

/** 位置：'wild' 表示野外（全局唯一的一片公共区域）；其余值是「城主的 playerId」 */
export const WILD = 'wild';

/** 猜拳手势 */
export const RPS = ['rock', 'paper', 'scissors'];

/** 手势克制关系：BEATS[a] = b 表示 a 赢 b */
export const BEATS = {
  rock: 'scissors',
  scissors: 'paper',
  paper: 'rock',
};

/** 手势中文名 */
export const RPS_LABEL = { rock: '石头', scissors: '剪刀', paper: '布' };

/** 阶段 */
export const PHASE = {
  RPS: 'rps', // 所有人同步猜拳
  ORDER: 'order', // 多人获胜：小猜拳定决胜者，决胜者排行动顺序
  ACTION: 'action', // 赢家按顺序花行动步数
  OVER: 'over', // 分出胜负
};

/** 动作类型（每个动作恰好消耗 1 步） */
export const ACT = {
  BUY_KNIFE: 'buy_knife', // 买刀（仅城内）
  BUY_HORSE: 'buy_horse', // 买马（仅城内）
  MOVE_OUT: 'move_out', // 出城：城内 → 野外
  MOVE_IN: 'move_in', // 进城：野外 → 指定某个城
  KNIFE: 'knife', // 刀：同位置，-1 血
  KICK: 'kick', // 踹：同在城内，-3 血并踢到野外
  PASS: 'pass', // 主动结束剩余步数
};

/** 动作中文名（播报 / 按钮都用它） */
export const ACT_LABEL = {
  [ACT.BUY_KNIFE]: '买刀',
  [ACT.BUY_HORSE]: '买马',
  [ACT.MOVE_OUT]: '出城',
  [ACT.MOVE_IN]: '进城',
  [ACT.KNIFE]: '刀',
  [ACT.KICK]: '踹',
  [ACT.PASS]: '结束行动',
};

/** 装备中文名 */
export const ITEM_LABEL = { knife: '刀', horse: '马' };

/** 一个人获胜：2 步行动 */
export const STEPS_SOLO = 2;
/** 多人获胜：每人 1 步 */
export const STEPS_MULTI = 1;

/** 猜拳超时（超时由系统随机代出） */
export const RPS_TIMEOUT_MS = 10000;
/** 决胜者排行动顺序的超时（超时按座位号兜底排序） */
export const ORDER_TIMEOUT_MS = 15000;
/** 单步行动超时（超时自动结束剩余步数，避免挂机卡局） */
export const ACTION_TIMEOUT_MS = 60000;
/** 状态帧里最多保留多少条事件 / 播报 */
export const KEEP_LOG = 60;
export const KEEP_EVENTS = 60;

/** 单字名称：允许中日韩汉字与字母数字，长度按「字符」算 */
export function isValidName(name) {
  const s = String(name || '').trim();
  if ([...s].length !== 1) return false;
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}A-Za-z0-9]/u.test(s);
}

/** 规整名称：只留下第一个字符 */
export function normalizeName(name) {
  return [...String(name || '').trim()].slice(0, 1).join('');
}

/** 判断某个位置是不是「城内」 */
export function isCity(place) {
  return place !== WILD;
}