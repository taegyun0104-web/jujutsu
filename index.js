require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const {
  Client, GatewayIntentBits, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
} = require("discord.js");

const app = express();
app.get("/", (_, res) => res.send("🔱 주술회전 RPG 봇 가동 중"));
app.get("/health", (_, res) => res.json({ status: "ok", uptime: process.uptime() }));
app.listen(process.env.PORT || 3000, () => console.log(`🌐 HTTP 포트 ${process.env.PORT || 3000}`));

// ════════════════════════════════════════════════════════
// ── PostgreSQL
// ════════════════════════════════════════════════════════
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway") ? { rejectUnauthorized: false } : false,
  max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000,
});
pool.on("error", (err) => console.error("PostgreSQL 풀 오류:", err.message));

async function dbInit() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS players (user_id TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW())`);
    console.log("✅ PostgreSQL 테이블 준비 완료");
  } catch (e) { console.log("⚠️ DB 연결 실패, 메모리 모드"); }
}
async function dbLoad() {
  try {
    const res = await pool.query("SELECT user_id, data FROM players");
    const obj = {};
    for (const row of res.rows) obj[row.user_id] = row.data;
    console.log(`✅ DB 로드: ${res.rows.length}명`);
    return obj;
  } catch (e) { console.log("⚠️ DB 로드 실패"); return {}; }
}

const saveQueue = new Map();
const savePending = new Set();
async function dbSave(userId, data) {
  try {
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO players(user_id,data,updated_at) VALUES($1,$2,NOW()) ON CONFLICT(user_id) DO UPDATE SET data=$2,updated_at=NOW()`,
        [userId, JSON.stringify(data)]
      );
    } finally { client.release(); }
  } catch (e) { console.error(`DB 저장 오류 [${userId}]:`, e.message); }
}
function savePlayer(userId) {
  if (!players[userId]) return;
  if (saveQueue.has(userId)) clearTimeout(saveQueue.get(userId));
  const timer = setTimeout(async () => {
    saveQueue.delete(userId);
    if (savePending.has(userId)) { savePlayer(userId); return; }
    savePending.add(userId);
    try { await dbSave(userId, players[userId]); }
    catch (e) { setTimeout(() => savePlayer(userId), 5000); }
    finally { savePending.delete(userId); }
  }, 300);
  saveQueue.set(userId, timer);
}
async function savePlayerNow(userId) {
  if (!players[userId]) return;
  if (saveQueue.has(userId)) { clearTimeout(saveQueue.get(userId)); saveQueue.delete(userId); }
  savePending.add(userId);
  try { await dbSave(userId, players[userId]); }
  catch (e) { setTimeout(() => savePlayer(userId), 3000); }
  finally { savePending.delete(userId); }
}
setInterval(async () => {
  for (const uid of Object.keys(players)) {
    if (!saveQueue.has(uid) && !savePending.has(uid)) {
      try { await dbSave(uid, players[uid]); } catch {}
    }
  }
}, 3 * 60 * 1000);

// ════════════════════════════════════════════════════════
// ── Discord 클라이언트
// ════════════════════════════════════════════════════════
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});
const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) { console.error("❌ DISCORD_TOKEN 없음!"); process.exit(1); }

const DEV_IDS = new Set(["1284771557633425470", "1397218266505678881"]);
const isDev = (id) => DEV_IDS.has(id);

// ════════════════════════════════════════════════════════
// ── 등급/색상
// ════════════════════════════════════════════════════════
const JJK_GRADE_COLOR = {
  "특급": 0xF5C842, "준특급": 0xff8c00, "1급": 0x7C5CFC, "준1급": 0x9b72cf,
  "2급": 0x4ade80, "3급": 0x94a3b8, "4급": 0x64748b,
};
const JJK_GRADE_EMOJI = { "특급": "🔱", "준특급": "💠", "1급": "⭐⭐", "준1급": "⭐", "2급": "🔹🔹", "3급": "🔹", "4급": "◽" };
const JJK_GRADE_LABEL = {
  "특급": "【 특 급 】", "준특급": "【준특급】", "1급": "【 1 급 】",
  "준1급": "【준 1급】", "2급": "【 2 급 】", "3급": "【 3 급 】", "4급": "【 4 급 】",
};

// ════════════════════════════════════════════════════════
// ── 📦 주구 재료 시스템
// ════════════════════════════════════════════════════════
const MATERIALS = {
  cursed_thread:  { name: "저주 실",     emoji: "🧵", desc: "저급 저주령에서 획득. 주구 제작 기본 재료." },
  cursed_bone:    { name: "저주 뼈",     emoji: "🦴", desc: "1급 저주령에서 획득." },
  cursed_core:    { name: "저주 핵",     emoji: "💜", desc: "특급 저주령에서 획득." },
  cursed_crystal: { name: "저주 수정",   emoji: "💎", desc: "보스에서 획득. 최상위 재료." },
  iron_fragment:  { name: "철 파편",     emoji: "⚙️", desc: "모든 적에서 획득." },
  spirit_essence: { name: "영혼 정수",   emoji: "✨", desc: "특급 이상 적에서 획득." },
  dragon_scale:   { name: "용 비늘",     emoji: "🐉", desc: "보스에서 획득. 희귀 재료." },
};

// 주구 (무기) 정의
const WEAPONS = {
  cursed_knife: {
    name: "저주 단검", emoji: "🗡️", grade: "일반",
    atkBonus: 15, defBonus: 0, hpBonus: 0, desc: "저주 에너지가 깃든 단검.",
    recipe: { cursed_thread: 3, iron_fragment: 5 }, color: 0x94a3b8,
  },
  cursed_blade: {
    name: "저주 도검", emoji: "⚔️", grade: "희귀",
    atkBonus: 35, defBonus: 5, hpBonus: 100, desc: "날카로운 저주 도검. 적의 방어를 관통.",
    recipe: { cursed_bone: 4, iron_fragment: 8, cursed_thread: 2 }, color: 0x4ade80,
  },
  cursed_spear: {
    name: "저주 창", emoji: "🔱", grade: "희귀",
    atkBonus: 45, defBonus: 0, hpBonus: 0, desc: "원거리 공격이 가능한 저주 창.",
    recipe: { cursed_bone: 5, cursed_thread: 5 }, color: 0x4ade80,
  },
  spirit_shield: {
    name: "영혼 방패", emoji: "🛡️", grade: "고급",
    atkBonus: 5, defBonus: 40, hpBonus: 300, desc: "영혼 정수로 만든 방어 도구.",
    recipe: { spirit_essence: 3, cursed_core: 2, iron_fragment: 10 }, color: 0x7C5CFC,
  },
  cursed_hammer: {
    name: "저주 망치", emoji: "🔨", grade: "고급",
    atkBonus: 60, defBonus: 10, hpBonus: 150, desc: "묵직한 저주 망치. 강타 공격.",
    recipe: { cursed_core: 3, cursed_bone: 6, iron_fragment: 12 }, color: 0x7C5CFC,
  },
  dragon_sword: {
    name: "용의 검", emoji: "🐉⚔️", grade: "전설",
    atkBonus: 100, defBonus: 30, hpBonus: 500, desc: "용 비늘로 만든 전설의 검. 압도적인 파괴력.",
    recipe: { dragon_scale: 3, cursed_crystal: 2, spirit_essence: 5, cursed_core: 4 }, color: 0xF5C842,
  },
  sukuna_vessel: {
    name: "스쿠나의 그릇", emoji: "👹", grade: "전설",
    atkBonus: 80, defBonus: 20, hpBonus: 800, desc: "스쿠나의 힘이 깃든 주구. 이타도리 전용.",
    recipe: { cursed_crystal: 3, dragon_scale: 2, cursed_core: 6 }, color: 0x8b0000,
  },
};

// 적별 재료 드롭 테이블
const ENEMY_DROPS = {
  e1: [ // 저급 저주령
    { mat: "cursed_thread",  min: 1, max: 3, chance: 0.80 },
    { mat: "iron_fragment",  min: 1, max: 2, chance: 0.60 },
    { mat: "cursed_bone",    min: 1, max: 1, chance: 0.10 },
  ],
  e2: [ // 1급 저주령
    { mat: "cursed_bone",    min: 1, max: 2, chance: 0.70 },
    { mat: "iron_fragment",  min: 2, max: 4, chance: 0.80 },
    { mat: "cursed_thread",  min: 2, max: 4, chance: 0.50 },
    { mat: "cursed_core",    min: 1, max: 1, chance: 0.08 },
  ],
  e3: [ // 특급 저주령
    { mat: "cursed_core",    min: 1, max: 2, chance: 0.65 },
    { mat: "spirit_essence", min: 1, max: 2, chance: 0.55 },
    { mat: "cursed_bone",    min: 2, max: 4, chance: 0.80 },
    { mat: "iron_fragment",  min: 3, max: 6, chance: 0.90 },
    { mat: "cursed_crystal", min: 1, max: 1, chance: 0.05 },
  ],
  e4: [ // 보스
    { mat: "cursed_crystal", min: 1, max: 2, chance: 0.80 },
    { mat: "dragon_scale",   min: 1, max: 2, chance: 0.60 },
    { mat: "spirit_essence", min: 2, max: 4, chance: 0.90 },
    { mat: "cursed_core",    min: 2, max: 4, chance: 0.90 },
    { mat: "iron_fragment",  min: 5, max: 10, chance: 1.00 },
  ],
};

// 사멸회유 몹 드롭
const JUJUTSU_DROPS = {
  j1: [{ mat: "cursed_thread", min:1, max:2, chance:0.70 }, { mat:"iron_fragment", min:1, max:2, chance:0.60 }],
  j2: [{ mat: "cursed_thread", min:1, max:3, chance:0.70 }, { mat:"cursed_bone", min:1, max:1, chance:0.35 }, { mat:"iron_fragment", min:1, max:3, chance:0.65 }],
  j3: [{ mat: "cursed_bone", min:1, max:2, chance:0.55 }, { mat:"iron_fragment", min:1, max:3, chance:0.70 }],
  j4: [{ mat: "cursed_core", min:1, max:1, chance:0.30 }, { mat:"cursed_bone", min:1, max:3, chance:0.65 }, { mat:"spirit_essence", min:1, max:1, chance:0.20 }],
  j5: [{ mat: "cursed_core", min:1, max:2, chance:0.55 }, { mat:"spirit_essence", min:1, max:2, chance:0.40 }, { mat:"cursed_crystal", min:1, max:1, chance:0.08 }],
  j6: [{ mat: "cursed_crystal", min:1, max:1, chance:0.50 }, { mat:"dragon_scale", min:1, max:1, chance:0.30 }, { mat:"spirit_essence", min:2, max:3, chance:0.80 }],
};

function rollDrops(enemyId, isJujutsu = false) {
  const table = isJujutsu ? JUJUTSU_DROPS[enemyId] : ENEMY_DROPS[enemyId];
  if (!table) return {};
  const result = {};
  for (const entry of table) {
    if (Math.random() < entry.chance) {
      const qty = entry.min + Math.floor(Math.random() * (entry.max - entry.min + 1));
      result[entry.mat] = (result[entry.mat] || 0) + qty;
    }
  }
  return result;
}

function addMaterials(player, drops) {
  if (!player.materials) player.materials = {};
  for (const [mat, qty] of Object.entries(drops)) {
    player.materials[mat] = (player.materials[mat] || 0) + qty;
  }
}

function formatDrops(drops) {
  const parts = [];
  for (const [mat, qty] of Object.entries(drops)) {
    const m = MATERIALS[mat];
    if (m) parts.push(`${m.emoji} **${m.name}** ×${qty}`);
  }
  return parts.length ? parts.join("  ") : "없음";
}

function getWeaponStats(player) {
  if (!player.equippedWeapon) return { atk: 0, def: 0, hp: 0 };
  const w = WEAPONS[player.equippedWeapon];
  if (!w) return { atk: 0, def: 0, hp: 0 };
  return { atk: w.atkBonus, def: w.defBonus, hp: w.hpBonus };
}

// ════════════════════════════════════════════════════════
// ── 📋 퀘스트 시스템
// ════════════════════════════════════════════════════════
const DAILY_QUESTS = [
  {
    id: "dq_battle3",   type: "battle_win",   target: 3,
    name: "오늘의 수련",       desc: "전투 3회 승리",
    reward: { crystals: 80, xp: 150, materials: { iron_fragment: 3 } },
  },
  {
    id: "dq_culling5",  type: "culling_wave",  target: 5,
    name: "컬링 특훈",         desc: "컬링 게임 5웨이브 달성",
    reward: { crystals: 100, xp: 200, materials: { cursed_thread: 5 } },
  },
  {
    id: "dq_jujutsu3",  type: "jujutsu_point", target: 3,
    name: "사멸회유 임무",     desc: "사멸회유 3포인트 달성",
    reward: { crystals: 90, xp: 180, materials: { cursed_bone: 2 } },
  },
  {
    id: "dq_skill5",    type: "skill_use",     target: 5,
    name: "술식 연마",         desc: "술식 5회 사용",
    reward: { crystals: 70, xp: 130, materials: { cursed_thread: 3, iron_fragment: 2 } },
  },
  {
    id: "dq_gacha1",    type: "gacha_pull",    target: 1,
    name: "운명의 소환",       desc: "가챠 1회 소환",
    reward: { crystals: 60, xp: 100, materials: { iron_fragment: 5 } },
  },
  {
    id: "dq_nokill2",   type: "boss_kill",     target: 2,
    name: "정예 사냥",         desc: "특급 저주령 이상 2마리 처치",
    reward: { crystals: 150, xp: 300, materials: { cursed_core: 1 } },
  },
];

const WEEKLY_QUESTS = [
  {
    id: "wq_battle20",  type: "battle_win",   target: 20,
    name: "주간 전사",          desc: "이번 주 전투 20회 승리",
    reward: { crystals: 500, xp: 1000, materials: { cursed_core: 3, spirit_essence: 2 } },
  },
  {
    id: "wq_culling15", type: "culling_wave",  target: 15,
    name: "컬링 마스터",        desc: "컬링 게임 15웨이브 달성 (합산)",
    reward: { crystals: 600, xp: 1200, materials: { cursed_crystal: 1, cursed_bone: 8 } },
  },
  {
    id: "wq_jujutsu15", type: "jujutsu_point", target: 15,
    name: "사멸회유 전문가",    desc: "사멸회유 총 15포인트 달성",
    reward: { crystals: 550, xp: 1100, materials: { spirit_essence: 4, cursed_core: 2 } },
  },
  {
    id: "wq_boss5",     type: "boss_kill",     target: 5,
    name: "보스 사냥꾼",        desc: "특급 저주령 이상 5마리 처치",
    reward: { crystals: 700, xp: 1400, materials: { dragon_scale: 1, cursed_crystal: 1 } },
  },
  {
    id: "wq_craft1",    type: "weapon_craft",  target: 1,
    name: "주구 장인",          desc: "주구 1개 제작",
    reward: { crystals: 400, xp: 800, materials: { spirit_essence: 3, dragon_scale: 1 } },
  },
  {
    id: "wq_pvpwin3",   type: "pvp_win",       target: 3,
    name: "결투 챔피언",        desc: "PvP 3회 승리",
    reward: { crystals: 800, xp: 1600, materials: { cursed_crystal: 2, dragon_scale: 1 } },
  },
];

function getTodayKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${d.getUTCMonth()+1}-${d.getUTCDate()}`;
}
function getWeekKey() {
  const d = new Date();
  const weekStart = new Date(d);
  weekStart.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return `${weekStart.getUTCFullYear()}-${weekStart.getUTCMonth()+1}-${weekStart.getUTCDate()}`;
}

function initQuests(player) {
  const today = getTodayKey();
  const week  = getWeekKey();
  if (!player.quests) player.quests = {};

  // 일일 퀘스트 초기화
  if (player.quests.dailyKey !== today) {
    player.quests.dailyKey = today;
    // 3개 랜덤 뽑기
    const picked = [...DAILY_QUESTS].sort(() => Math.random() - 0.5).slice(0, 3);
    player.quests.daily = picked.map(q => ({ id: q.id, progress: 0, done: false, claimed: false }));
  }

  // 주간 퀘스트 초기화
  if (player.quests.weekKey !== week) {
    player.quests.weekKey = week;
    const picked = [...WEEKLY_QUESTS].sort(() => Math.random() - 0.5).slice(0, 3);
    player.quests.weekly = picked.map(q => ({ id: q.id, progress: 0, done: false, claimed: false }));
  }

  if (!player.quests.daily)  player.quests.daily  = [];
  if (!player.quests.weekly) player.quests.weekly = [];
}

function updateQuestProgress(player, type, amount = 1) {
  initQuests(player);
  // 일일
  for (const qp of player.quests.daily) {
    if (qp.done) continue;
    const def = DAILY_QUESTS.find(q => q.id === qp.id);
    if (!def || def.type !== type) continue;
    qp.progress = Math.min(qp.progress + amount, def.target);
    if (qp.progress >= def.target) qp.done = true;
  }
  // 주간
  for (const qp of player.quests.weekly) {
    if (qp.done) continue;
    const def = WEEKLY_QUESTS.find(q => q.id === qp.id);
    if (!def || def.type !== type) continue;
    qp.progress = Math.min(qp.progress + amount, def.target);
    if (qp.progress >= def.target) qp.done = true;
  }
}

function claimQuestReward(player, questId, isWeekly = false) {
  initQuests(player);
  const list = isWeekly ? player.quests.weekly : player.quests.daily;
  const allDefs = isWeekly ? WEEKLY_QUESTS : DAILY_QUESTS;
  const qp = list.find(q => q.id === questId);
  if (!qp || !qp.done || qp.claimed) return null;
  const def = allDefs.find(q => q.id === questId);
  if (!def) return null;
  qp.claimed = true;
  player.crystals += def.reward.crystals || 0;
  player.xp += def.reward.xp || 0;
  if (def.reward.materials) addMaterials(player, def.reward.materials);
  return def.reward;
}

// ════════════════════════════════════════════════════════
// ── 상태이상
// ════════════════════════════════════════════════════════
const STATUS_EFFECTS = {
  poison:        { id:"poison",        name:"독",      emoji:"☠️", desc:"매 턴 최대HP의 5% 피해",          duration:3 },
  burn:          { id:"burn",          name:"화상",    emoji:"🔥", desc:"매 턴 최대HP의 8% 피해",          duration:2 },
  freeze:        { id:"freeze",        name:"빙결",    emoji:"❄️", desc:"1턴 행동 불가",                    duration:1 },
  weaken:        { id:"weaken",        name:"약화",    emoji:"💔", desc:"공격력 30% 감소",                  duration:2 },
  stun:          { id:"stun",          name:"기절",    emoji:"⚡", desc:"1턴 행동 불가",                    duration:1 },
  battleInstinct:{ id:"battleInstinct",name:"전투본능",emoji:"🔥💪",desc:"공격력 40% 증가, 회피율 25% 증가",duration:3 },
  cursed_wound:  { id:"cursed_wound",  name:"저주상처",emoji:"🩸", desc:"매 턴 최대HP의 10% 피해 (강력)", duration:2 },
  blind:         { id:"blind",         name:"실명",    emoji:"🌑", desc:"명중률 50% 감소",                  duration:2 },
};

function applyStatus(target, statusId) {
  if (!target.statusEffects) target.statusEffects = [];
  const existing = target.statusEffects.find(s => s.id === statusId);
  if (existing) existing.turns = STATUS_EFFECTS[statusId].duration;
  else target.statusEffects.push({ id: statusId, turns: STATUS_EFFECTS[statusId].duration });
}

function tickStatus(target, maxHp) {
  if (!target.statusEffects || target.statusEffects.length === 0) return { dmg: 0, expired: [], log: [] };
  let totalDmg = 0;
  const expired = [], log = [];
  for (const se of target.statusEffects) {
    const def = STATUS_EFFECTS[se.id];
    if (!def) { se.turns = 0; continue; }
    if (se.id === "poison") { const d = Math.max(1, Math.floor(maxHp * 0.05)); totalDmg += d; log.push(`${def.emoji} **${def.name}** — **${d}** 피해!`); }
    if (se.id === "burn")   { const d = Math.max(1, Math.floor(maxHp * 0.08)); totalDmg += d; log.push(`${def.emoji} **${def.name}** — **${d}** 피해!`); }
    if (se.id === "cursed_wound") { const d = Math.max(1, Math.floor(maxHp * 0.10)); totalDmg += d; log.push(`${def.emoji} **${def.name}** — **${d}** 피해!`); }
    se.turns--;
    if (se.turns <= 0) expired.push(se.id);
  }
  target.statusEffects = target.statusEffects.filter(s => s.turns > 0);
  if (totalDmg > 0) target.hp = Math.max(0, target.hp - totalDmg);
  return { dmg: totalDmg, expired, log };
}

function statusStr(se) {
  if (!se || se.length === 0) return "없음";
  return se.map(s => `${STATUS_EFFECTS[s.id]?.emoji||""}${STATUS_EFFECTS[s.id]?.name||s.id}(${s.turns}턴)`).join(" ");
}
function isIncapacitated(se) { return !!(se && se.some(s => s.id === "freeze" || s.id === "stun")); }
function isBlind(se) { return !!(se && se.some(s => s.id === "blind")); }
function getWeakenMult(se) {
  let mult = 1;
  if (se && se.some(s => s.id === "weaken")) mult *= 0.7;
  if (se && se.some(s => s.id === "battleInstinct")) mult *= 1.4;
  return mult;
}
function getBattleInstinctEvade(se) { return !!(se && se.some(s => s.id === "battleInstinct")); }

function rollHit(attackerSe, defenderSe) {
  // 실명 상태면 50% 명중률
  if (isBlind(attackerSe) && Math.random() < 0.50) return false;
  const baseEvade = 0.05;
  const instinctBonus = getBattleInstinctEvade(defenderSe) ? 0.25 : 0;
  return Math.random() > (baseEvade + instinctBonus);
}

// ════════════════════════════════════════════════════════
// ── 흑섬 시스템 (10% 확률)
// ════════════════════════════════════════════════════════
function isBlackFlash() { return Math.random() < 0.10; }

function getBlackFlashArt() {
  return [
    "```ansi",
    "\u001b[1;31m╔═══════════════════════════════════════╗",
    "\u001b[1;31m║  ██████╗ ██╗      █████╗  ██████╗██╗  ██╗║",
    "\u001b[1;31m║  ██╔══██╗██║     ██╔══██╗██╔════╝██║ ██╔╝║",
    "\u001b[1;33m║  ██████╔╝██║     ███████║██║     █████╔╝ ║",
    "\u001b[1;33m║  ██╔══██╗██║     ██╔══██║██║     ██╔═██╗ ║",
    "\u001b[1;31m║  ██████╔╝███████╗██║  ██║╚██████╗██║  ██╗║",
    "\u001b[1;31m║  ╚═════╝ ╚══════╝╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝║",
    "\u001b[1;31m╠═══════════════════════════════════════╣",
    "\u001b[1;33m║  ⚫⚫⚫  B L A C K   F L A S H  ⚫⚫⚫  ║",
    "\u001b[1;31m║        저주 에너지 순간 최대 방출!!      ║",
    "\u001b[1;31m╚═══════════════════════════════════════╝",
    "```",
  ].join("\n");
}

// ════════════════════════════════════════════════════════
// ── 스쿠나 손가락
// ════════════════════════════════════════════════════════
const SUKUNA_FINGER_MAX = 20;
function getFingerBonus(fingers) {
  return {
    atkBonus: Math.floor(fingers * 10),
    defBonus: Math.floor(fingers * 6),
    hpBonus: fingers * 200,
    label: fingers >= 20 ? "🔴 스쿠나 완전 각성" :
           fingers >= 15 ? "🔴 스쿠나 각성 Lv.4" :
           fingers >= 10 ? "🟠 스쿠나 각성 Lv.3" :
           fingers >= 5  ? "🟡 스쿠나 각성 Lv.2" :
           fingers >= 1  ? "🟢 스쿠나 각성 Lv.1" : "스쿠나 봉인 중",
  };
}

// ════════════════════════════════════════════════════════
// ── 코가네 펫
// ════════════════════════════════════════════════════════
const KOGANE_GRADES = {
  "전설": { color:0xF5C842,emoji:"🌟",stars:"★★★★★",rate:0.5, atkBonus:0.25,defBonus:0.20,hpBonus:0.20,xpBonus:0.30,crystalBonus:0.25, skill:"황금 포효",skillDesc:"전투 시작 시 적에게 추가 피해 (ATK의 50%)",skillChance:0.35, passiveDesc:"ATK+25% DEF+20% HP+20% XP+30% 크리스탈+25%"},
  "특급": { color:0xff8c00,emoji:"🔶",stars:"★★★★☆",rate:2.0, atkBonus:0.18,defBonus:0.15,hpBonus:0.15,xpBonus:0.20,crystalBonus:0.18, skill:"황금 이빨",skillDesc:"공격 시 15% 확률로 약화 부여",skillChance:0.15, passiveDesc:"ATK+18% DEF+15% HP+15% XP+20% 크리스탈+18%"},
  "1급":  { color:0x7C5CFC,emoji:"🔷",stars:"★★★☆☆",rate:8.0, atkBonus:0.12,defBonus:0.10,hpBonus:0.10,xpBonus:0.12,crystalBonus:0.10, skill:"황금 발톱",skillDesc:"공격 시 10% 확률로 추가타 (ATK의 30%)",skillChance:0.10, passiveDesc:"ATK+12% DEF+10% HP+10% XP+12% 크리스탈+10%"},
  "2급":  { color:0x4ade80,emoji:"🟢",stars:"★★☆☆☆",rate:22.5,atkBonus:0.07,defBonus:0.06,hpBonus:0.06,xpBonus:0.07,crystalBonus:0.06, skill:"황금 보호막",skillDesc:"HP 30% 이하 시 1회 피해 50% 감소",skillChance:1.0, passiveDesc:"ATK+7% DEF+6% HP+6% XP+7% 크리스탈+6%"},
  "3급":  { color:0x94a3b8,emoji:"⚪",stars:"★☆☆☆☆",rate:67.0,atkBonus:0.03,defBonus:0.02,hpBonus:0.02,xpBonus:0.03,crystalBonus:0.02, skill:"황금 냄새",skillDesc:"전투 후 크리스탈 +5% 추가 획득",skillChance:1.0, passiveDesc:"ATK+3% DEF+2% HP+2% XP+3% 크리스탈+2%"},
};
const KOGANE_POOL = [
  { grade:"전설",rate:0.5 },{ grade:"특급",rate:2.0 },{ grade:"1급",rate:8.0 },
  { grade:"2급",rate:22.5 },{ grade:"3급",rate:67.0 },
];
function rollKogane() {
  const total = KOGANE_POOL.reduce((s,p) => s+p.rate, 0);
  let roll = Math.random() * total;
  for (const e of KOGANE_POOL) { roll -= e.rate; if (roll <= 0) return e.grade; }
  return "3급";
}
function getKoganeBonus(player) {
  if (!player.kogane?.grade) return { atk:1,def:1,hp:1,xp:1,crystal:1 };
  const g = KOGANE_GRADES[player.kogane.grade];
  if (!g) return { atk:1,def:1,hp:1,xp:1,crystal:1 };
  return { atk:1+g.atkBonus, def:1+g.defBonus, hp:1+g.hpBonus, xp:1+g.xpBonus, crystal:1+g.crystalBonus };
}

// ════════════════════════════════════════════════════════
// ── 스킬 이펙트
// ════════════════════════════════════════════════════════
const SKILL_EFFECTS = {
  "주먹질":     { art:"```\n  💥  \n ▓▓▓▓▓\n  💥  \n```",color:0xff6b35,flavorText:"저주 에너지를 주먹에 집중시킨다!"},
  "다이버전트 주먹":{ art:"```\n ⚡💥⚡\n▓▓▓▓▓▓▓\n ⚡💥⚡\n```",color:0xff4500,flavorText:"발산하는 저주 에너지 — 몸의 내부에서 폭발!"},
  "흑섬":       { art:"```\n🌑🌑🌑🌑🌑\n⬛ 黑 閃 ⬛\n🌑🌑🌑🌑🌑\n```",color:0x1a0a2e,flavorText:"순간적으로 발산되는 최대 저주 에너지!"},
  "어주자":     { art:"```\n👹✨👹✨👹\n✨ 廻 夏 ✨\n👹✨👹✨👹\n```",color:0xb5451b,flavorText:"스쿠나의 힘이 몸을 가득 채운다..."},
  "스쿠나 발현":{ art:"```\n🔴👹🔴👹🔴\n👹 両面宿儺 👹\n🔴👹🔴👹🔴\n```",color:0x8b0000,flavorText:"저주의 왕이 이타도리의 몸을 장악한다!"},
  "아오":       { art:"```\n  🔵🔵🔵  \n🔵  蒼  🔵\n  🔵🔵🔵  \n```",color:0x0066ff,flavorText:"무한에 의한 인력 — 모든 것을 끌어당긴다"},
  "아카":       { art:"```\n  🔴🔴🔴  \n🔴  赫  🔴\n  🔴🔴🔴  \n```",color:0xff0033,flavorText:"무한에 의한 척력 — 모든 것을 날려버린다"},
  "무라사키":   { art:"```\n🔴⚡🔵⚡🔴\n⚡  紫  ⚡\n🔵⚡🔴⚡🔵\n```",color:0x9900ff,flavorText:"아오와 아카의 융합 — 허공을 찢는 허수!"},
  "무량공처":   { art:"```\n∞∞∞∞∞∞∞∞∞\n∞ 無量空処 ∞\n∞∞∞∞∞∞∞∞∞\n```",color:0x00ffff,flavorText:"\"나는 최강이니까\" — 무한이 세계를 지배한다"},
  "자폭 무라사키":{ art:"```\n💥🔴💥🔵💥\n💥 自爆 紫 💥\n💥🔵💥🔴💥\n```",color:0xff0000,flavorText:"모든 힘을 쏟아붓는 자폭 공격!"},
  "해":         { art:"```\n  ✂️✂️✂️  \n✂️  解  ✂️\n  ✂️✂️✂️  \n```",color:0xcc0000,flavorText:"만물을 베어내는 저주의 왕의 손톱!"},
  "팔":         { art:"```\n🌌✂️🌌✂️🌌\n✂️  捌  ✂️\n🌌✂️🌌✂️🌌\n```",color:0x8b0000,flavorText:"공간 자체를 베어내는 절대적 술식!"},
  "푸가":       { art:"```\n💀🔥💀🔥💀\n🔥 不 雅 🔥\n💀🔥💀🔥💀\n```",color:0x4a0000,flavorText:"닿는 모든 것을 분해한다!"},
  "복마어주자": { art:"```\n👑🌑👑🌑👑\n🌑伏魔御廚子🌑\n👑🌑👑🌑👑\n```",color:0x2a0000,flavorText:"천지개벽 — 저주의 왕의 궁극 영역전개!"},
  "세계참":     { art:"```\n🌍✂️🌍✂️🌍\n✂️ 世界斬 ✂️\n🌍✂️🌍✂️🌍\n```",color:0x4a0000,flavorText:"세계조차 베어버린다!"},
  "부기우기":   { art:"```\n🎵💪🎵💪🎵\n💪 Boogie 💪\n🎵💪🎵💪🎵\n```",color:0x1e90ff,flavorText:"\"댄스홀 가수!\" — 보조공격술 위치 전환! 빙결의 한기!"},
  "전투본능":   { art:"```\n⚔️🔥⚔️🔥⚔️\n🔥戦闘本能🔥\n⚔️🔥⚔️🔥⚔️\n```",color:0xff8c00,flavorText:"전사의 본능이 각성한다! 공격력·회피 극대화!"},
  "험한 도박":  { art:"```\n🎰🎰🎰🎰🎰\n  険 賭 博  \n🎰🎰🎰🎰🎰\n```",color:0xffaa00,flavorText:"운에 맡긴 도박 공격!"},
  "질풍열차":   { art:"```\n🚂💨🚂💨🚂\n  疾 風 列  \n🚂💨🚂💨🚂\n```",color:0x44aaff,flavorText:"강력한 열차처럼 돌진!"},
  "유한 소설":  { art:"```\n📖✨📖✨📖\n✨ 有限小説 ✨\n📖✨📖✨📖\n```",color:0x88ff88,flavorText:"불멸의 몸으로 싸운다!"},
  "질풍강운":   { art:"```\n🎰🌪️🎰🌪️🎰\n🌪️ 疾風強運 🌪️\n🎰🌪️🎰🌪️🎰\n```",color:0xffcc00,flavorText:"영역전개 — 운이 터진다!"},
  "_default":   { art:"```\n  ✨✨✨  \n✨ 術 式 ✨\n  ✨✨✨  \n```",color:0x7c5cfc,flavorText:"저주 에너지가 폭발한다!"},
};
function getSkillEffect(n) { return SKILL_EFFECTS[n] || SKILL_EFFECTS["_default"]; }

// ════════════════════════════════════════════════════════
// ── 캐릭터 데이터
// ════════════════════════════════════════════════════════
const CHARACTERS = {
  itadori: {
    name:"이타도리 유지",emoji:"🟠",grade:"준1급",
    atk:90,def:75,spd:85,maxHp:1000,domain:null,
    desc:"특급주술사 후보생. 스쿠나의 손가락을 삼킨 그릇.",
    lore:"\"남은 건 내가 어떻게 죽느냐다.\"",
    fingerSkills:true,
    skills:[
      {name:"주먹질",       minMastery:0,  dmg:95,  desc:"강력한 기본 주먹 공격."},
      {name:"다이버전트 주먹",minMastery:5, dmg:160, desc:"저주 에너지를 실은 주먹.",statusApply:{target:"enemy",statusId:"stun",chance:0.3}},
      {name:"흑섬",         minMastery:15, dmg:240, desc:"최대 저주 에너지 방출!",statusApply:{target:"enemy",statusId:"weaken",chance:0.5}},
      {name:"어주자",       minMastery:30, dmg:340, desc:"스쿠나의 힘을 빌린 궁극기.",statusApply:{target:"enemy",statusId:"burn",chance:0.7}},
      {name:"스쿠나 발현",  minMastery:50, dmg:520, desc:"스쿠나가 몸을 장악! 10손가락 이상 필요.",statusApply:{target:"enemy",statusId:"freeze",chance:0.8}},
    ],
  },
  gojo: {
    name:"고조 사토루",emoji:"🔵",grade:"특급",
    atk:130,def:120,spd:110,maxHp:1800,domain:"무량공처",
    desc:"최강의 주술사. 무량공처를 구사한다.",
    lore:"\"사람들이 왜 내가 최강이라고 하는지 알아?\"",
    skills:[
      {name:"아오",    minMastery:0,  dmg:145, desc:"적들을 끌어당겨서 공격한다."},
      {name:"아카",    minMastery:5,  dmg:220, desc:"적들을 날려서 폭발시킨다.",statusApply:{target:"enemy",statusId:"burn",chance:0.5}},
      {name:"무라사키",minMastery:15, dmg:320, desc:"아오와 아카를 합쳐서 발사.",statusApply:{target:"enemy",statusId:"weaken",chance:0.6}},
      {name:"무량공처",minMastery:30, dmg:480, desc:"무한을 지배하는 궁극술식.",statusApply:{target:"enemy",statusId:"freeze",chance:0.8}},
    ],
  },
  megumi: {
    name:"후시구로 메구미",emoji:"⚫",grade:"1급",
    atk:110,def:108,spd:100,maxHp:1250,domain:"강압암예정",
    desc:"식신술을 구사하는 주술사.",
    lore:"\"나는 선한 사람을 구하기 위해 싸운다.\"",
    skills:[
      {name:"옥견",         minMastery:0,  dmg:115, desc:"식신 옥견을 소환한다."},
      {name:"탈토",         minMastery:5,  dmg:180, desc:"식신 대호를 소환한다.",statusApply:{target:"enemy",statusId:"weaken",chance:0.4}},
      {name:"만상",         minMastery:15, dmg:265, desc:"열 가지 식신을 소환한다.",statusApply:{target:"enemy",statusId:"poison",chance:0.5}},
      {name:"후루베 유라유라",minMastery:30,dmg:380, desc:"최강의 식신, 마허라가라 강림.",statusApply:{target:"enemy",statusId:"stun",chance:0.6}},
    ],
  },
  nobara: {
    name:"쿠기사키 노바라",emoji:"🌸",grade:"1급",
    atk:115,def:95,spd:105,maxHp:1180,domain:null,
    desc:"망치를 이용해 영혼에 공격 가능한 주술사.",
    lore:"\"도쿄에 올 때부터 각오는 되어 있었어.\"",
    skills:[
      {name:"망치질",minMastery:0,  dmg:118, desc:"저주 못을 박는다."},
      {name:"공명",  minMastery:5,  dmg:195, desc:"허수아비를 통해 공명 피해.",statusApply:{target:"enemy",statusId:"poison",chance:0.5}},
      {name:"철정",  minMastery:15, dmg:280, desc:"저주 에너지 주입 못을 박는다.",statusApply:{target:"enemy",statusId:"weaken",chance:0.5}},
      {name:"발화",  minMastery:30, dmg:390, desc:"모든 못에 동시 폭발 공명.",statusApply:{target:"enemy",statusId:"burn",chance:0.8}},
    ],
  },
  nanami: {
    name:"나나미 켄토",emoji:"🟡",grade:"1급",
    atk:118,def:108,spd:90,maxHp:1380,domain:null,
    desc:"1급 주술사. 합리적 판단의 소유자.",
    lore:"\"초과 근무는 사절이지만... 이건 의무다.\"",
    skills:[
      {name:"둔기 공격",minMastery:0,  dmg:120, desc:"단단한 둔기로 타격한다."},
      {name:"칠할삼분", minMastery:5,  dmg:200, desc:"7:3 지점을 노린 약점 공격.",statusApply:{target:"enemy",statusId:"weaken",chance:0.6}},
      {name:"십수할",   minMastery:15, dmg:290, desc:"열 배의 저주 에너지 방출."},
      {name:"초과근무", minMastery:30, dmg:410, desc:"한계를 넘어선 폭발적 강화."},
    ],
  },
  sukuna: {
    name:"료멘 스쿠나",emoji:"🔴",grade:"특급",
    atk:140,def:115,spd:120,maxHp:2500,domain:"복마어주자",
    desc:"저주의 왕. 역대 최강의 저주된 영혼.",
    lore:"\"약한 놈이 강한 놈을 거스르는 건 죄악이다.\"",
    skills:[
      {name:"해",      minMastery:0,  dmg:145, desc:"날카로운 손톱으로 베어낸다.",statusApply:{target:"enemy",statusId:"burn",chance:0.4}},
      {name:"팔",      minMastery:5,  dmg:235, desc:"공간 자체를 베어낸다.",statusApply:{target:"enemy",statusId:"weaken",chance:0.5}},
      {name:"푸가",    minMastery:15, dmg:345, desc:"닿는 모든 것을 분해한다.",statusApply:{target:"enemy",statusId:"poison",chance:0.7}},
      {name:"복마어주자",minMastery:30,dmg:500, desc:"천지개벽의 궁극 영역전개.",statusApply:{target:"enemy",statusId:"freeze",chance:0.9}},
    ],
  },
  geto: {
    name:"게토 스구루",emoji:"🟢",grade:"특급",
    atk:115,def:105,spd:100,maxHp:1600,domain:null,
    desc:"전 특급 주술사. 저주를 다루는 달인.",
    lore:"\"주술사는 비주술사를 지켜야 한다.\"",
    skills:[
      {name:"저주 방출",  minMastery:0,  dmg:125, desc:"저급 저주령을 방출한다."},
      {name:"최대출력",   minMastery:5,  dmg:210, desc:"저주령을 전력으로 방출.",statusApply:{target:"enemy",statusId:"poison",chance:0.4}},
      {name:"저주영조종", minMastery:15, dmg:300, desc:"수천의 저주령을 조종한다.",statusApply:{target:"enemy",statusId:"weaken",chance:0.6}},
      {name:"감로대법",   minMastery:30, dmg:425, desc:"감로대법으로 모든 저주 흡수.",statusApply:{target:"enemy",statusId:"stun",chance:0.5}},
    ],
  },
  maki: {
    name:"마키 젠인",emoji:"⚪",grade:"준1급",
    atk:122,def:110,spd:115,maxHp:1300,domain:null,
    desc:"저주력이 없어도 강한 주술사. HP 30% 이하 시 천여주박 각성!",
    lore:"\"젠인 가문 — 그 이름을 내가 직접 끝내주지.\"",
    awakening:{ threshold:0.30, dmgMult:2.0, label:"천여주박 각성" },
    skills:[
      {name:"봉술",    minMastery:0,  dmg:122, desc:"저주 도구 봉으로 타격."},
      {name:"저주창",  minMastery:5,  dmg:200, desc:"저주 도구 창을 투척한다.",statusApply:{target:"enemy",statusId:"weaken",chance:0.4}},
      {name:"저주도구술",minMastery:15,dmg:285, desc:"다양한 저주 도구를 구사.",statusApply:{target:"enemy",statusId:"burn",chance:0.5}},
      {name:"천개봉파",minMastery:30, dmg:400, desc:"수천의 저주 도구 연속 공격.",statusApply:{target:"enemy",statusId:"stun",chance:0.6}},
    ],
  },
  panda: {
    name:"판다",emoji:"🐼",grade:"2급",
    atk:105,def:118,spd:85,maxHp:1400,domain:null,
    desc:"저주로 만든 특이체질의 주술사.",
    lore:"\"난 판다야. 진짜 판다.\"",
    skills:[
      {name:"박치기",    minMastery:0,  dmg:108, desc:"머리로 힘차게 들이받는다.",statusApply:{target:"enemy",statusId:"stun",chance:0.2}},
      {name:"곰 발바닥", minMastery:5,  dmg:175, desc:"두꺼운 발바닥으로 내리친다."},
      {name:"팬더 변신", minMastery:15, dmg:255, desc:"진짜 팬더로 변신해 공격.",statusApply:{target:"enemy",statusId:"weaken",chance:0.4}},
      {name:"고릴라 변신",minMastery:30,dmg:360, desc:"고릴라 형태로 폭발적 강화.",statusApply:{target:"enemy",statusId:"stun",chance:0.5}},
    ],
  },
  inumaki: {
    name:"이누마키 토게",emoji:"🟤",grade:"준1급",
    atk:112,def:90,spd:110,maxHp:1120,domain:null,
    desc:"주술언어를 구사하는 준1급 주술사.",
    lore:"\"연어알—\"",
    skills:[
      {name:"멈춰라",  minMastery:0,  dmg:115, desc:"상대의 움직임을 봉쇄한다.",statusApply:{target:"enemy",statusId:"freeze",chance:0.5}},
      {name:"달려라",  minMastery:5,  dmg:180, desc:"상대를 무작위로 달리게 한다.",statusApply:{target:"enemy",statusId:"weaken",chance:0.5}},
      {name:"주술언어",minMastery:15, dmg:265, desc:"강력한 주술 명령을 내린다.",statusApply:{target:"enemy",statusId:"stun",chance:0.6}},
      {name:"폭발해라",minMastery:30, dmg:375, desc:"상대를 그 자리에서 폭발시킨다.",statusApply:{target:"enemy",statusId:"burn",chance:0.8}},
    ],
  },
  yuta: {
    name:"오코츠 유타",emoji:"🌟",grade:"특급",
    atk:128,def:112,spd:115,maxHp:1750,domain:"진안상애",
    desc:"특급 주술사. 리카의 저주를 다루는 최강급.",
    lore:"\"리카... 나는 아직 살아야 해.\"",
    skills:[
      {name:"모방술식",minMastery:0,  dmg:135, desc:"다른 술식을 모방해 공격한다."},
      {name:"리카 소환",minMastery:5,  dmg:220, desc:"저주의 여왕 리카를 소환한다.",statusApply:{target:"enemy",statusId:"weaken",chance:0.5}},
      {name:"순애빔",  minMastery:15, dmg:340, desc:"리카와의 순수한 사랑을 에너지로 발사.",statusApply:{target:"enemy",statusId:"burn",chance:0.6}},
      {name:"진안상애",minMastery:30, dmg:480, desc:"영역전개로 모든 것을 사랑으로 파괴.",statusApply:{target:"enemy",statusId:"freeze",chance:0.9}},
    ],
  },
  higuruma: {
    name:"히구루마 히로미",emoji:"⚖️",grade:"1급",
    atk:118,def:105,spd:95,maxHp:1320,domain:"주복사사",
    desc:"전직 변호사 출신 주술사.",
    lore:"\"이 법정에서는 — 내가 판사다.\"",
    skills:[
      {name:"저주도구",   minMastery:0,  dmg:120, desc:"저주 에너지를 담은 도구로 공격."},
      {name:"몰수",       minMastery:5,  dmg:195, desc:"상대의 술식을 몰수한다.",statusApply:{target:"enemy",statusId:"weaken",chance:0.7}},
      {name:"사형판결",   minMastery:15, dmg:285, desc:"재판 결과에 따른 강력한 제재.",statusApply:{target:"enemy",statusId:"stun",chance:0.5}},
      {name:"집행인 인형",minMastery:30, dmg:410, desc:"집행인 인형을 소환해 즉시 처형.",statusApply:{target:"enemy",statusId:"freeze",chance:0.7}},
    ],
  },
  jogo: {
    name:"죠고",emoji:"🌋",grade:"특급",
    atk:125,def:100,spd:105,maxHp:1680,domain:"개관철위산",
    desc:"화염을 다루는 준특급 저주령.",
    lore:"\"인간이야말로 진정한 저주다.\"",
    skills:[
      {name:"화염 분사",minMastery:0,  dmg:130, desc:"강렬한 불꽃을 내뿜는다.",statusApply:{target:"enemy",statusId:"burn",chance:0.5}},
      {name:"용암 폭발",minMastery:5,  dmg:215, desc:"발밑의 용암을 폭발시킨다.",statusApply:{target:"enemy",statusId:"burn",chance:0.7}},
      {name:"극번 운",  minMastery:15, dmg:315, desc:"하늘에서 불타는 운석을 소환한다.",statusApply:{target:"enemy",statusId:"weaken",chance:0.5}},
      {name:"개관철위산",minMastery:30,dmg:460, desc:"화산을 소환하는 궁극 영역전개.",statusApply:{target:"enemy",statusId:"burn",chance:1.0}},
    ],
  },
  dagon: {
    name:"다곤",emoji:"🌊",grade:"특급",
    atk:118,def:108,spd:96,maxHp:1620,domain:"탕온평선",
    desc:"수중 저주령.",
    lore:"\"물은 모든 것을 삼킨다.\"",
    skills:[
      {name:"물고기 소환",  minMastery:0,  dmg:125, desc:"날카로운 물고기 떼를 소환한다.",statusApply:{target:"enemy",statusId:"poison",chance:0.4}},
      {name:"해수 폭발",    minMastery:5,  dmg:205, desc:"강력한 해수를 압축해 발사한다.",statusApply:{target:"enemy",statusId:"weaken",chance:0.5}},
      {name:"조류 소용돌이",minMastery:15, dmg:295, desc:"거대한 물의 소용돌이로 공격한다.",statusApply:{target:"enemy",statusId:"freeze",chance:0.4}},
      {name:"탕온평선",     minMastery:30, dmg:450, desc:"무수한 물고기로 가득 찬 영역전개.",statusApply:{target:"enemy",statusId:"poison",chance:0.9}},
    ],
  },
  hanami: {
    name:"하나미",emoji:"🌿",grade:"특급",
    atk:115,def:118,spd:93,maxHp:1750,domain:null,
    desc:"식물 저주령. 자연 술식을 구사한다.",
    lore:"\"자연은 인간의 적이 아니다.\"",
    skills:[
      {name:"나무뿌리 채찍",minMastery:0, dmg:122, desc:"나무뿌리를 채찍처럼 휘두른다.",statusApply:{target:"enemy",statusId:"weaken",chance:0.3}},
      {name:"꽃비",         minMastery:5, dmg:198, desc:"독성 꽃가루를 비처럼 쏟아낸다.",statusApply:{target:"enemy",statusId:"poison",chance:0.6}},
      {name:"대지의 저주",  minMastery:15,dmg:285, desc:"대지 전체에 저주 에너지를 퍼뜨린다.",statusApply:{target:"enemy",statusId:"poison",chance:0.7}},
      {name:"재앙의 꽃",    minMastery:30,dmg:425, desc:"거대한 꽃을 소환해 모든 것을 흡수한다.",statusApply:{target:"enemy",statusId:"stun",chance:0.6}},
    ],
  },
  mahito: {
    name:"마히토",emoji:"🩸",grade:"특급",
    atk:120,def:98,spd:110,maxHp:1560,domain:"자폐원돈과",
    desc:"영혼을 자유자재로 변형하는 준특급 저주령.",
    lore:"\"영혼이 육체를 만드는 거야.\"",
    skills:[
      {name:"영혼 변형",  minMastery:0, dmg:128, desc:"영혼을 변형해 직접 타격한다.",statusApply:{target:"enemy",statusId:"weaken",chance:0.4}},
      {name:"무위전변",   minMastery:5, dmg:212, desc:"접촉한 신체를 기괴하게 변형한다.",statusApply:{target:"enemy",statusId:"stun",chance:0.4}},
      {name:"편사지경체", minMastery:15,dmg:308, desc:"신체를 무한히 변형해 공격한다.",statusApply:{target:"enemy",statusId:"weaken",chance:0.6}},
      {name:"자폐원돈과", minMastery:30,dmg:455, desc:"영혼과 육체의 경계를 무너뜨리는 영역.",statusApply:{target:"enemy",statusId:"freeze",chance:0.8}},
    ],
  },
  todo: {
    name:"토도 아오이",emoji:"💪",grade:"1급",
    atk:128,def:108,spd:112,maxHp:1500,domain:null,
    desc:"보조 공격술(부기우기)을 구사하는 1급 주술사.",
    lore:"\"너의 이상형은 어떤 여자야?\"",
    skills:[
      {name:"부기우기",  minMastery:0,  dmg:130, desc:"보조공격술 — 위치 전환 + 빙결 40%.",statusApply:{target:"enemy",statusId:"freeze",chance:0.40}},
      {name:"브루탈 펀치",minMastery:5, dmg:215, desc:"최대 저주력을 실은 파괴적 주먹.",statusApply:{target:"enemy",statusId:"weaken",chance:0.30}},
      {name:"흑섬",      minMastery:15, dmg:320, desc:"이타도리에게 배운 흑섬!",statusApply:{target:"enemy",statusId:"burn",chance:0.45}},
      {name:"전투본능",  minMastery:30, dmg:200, desc:"자신에게 전투본능 버프! (ATK 40%↑, 회피 25%↑, 3턴)",statusApply:{target:"self",statusId:"battleInstinct",chance:1.0}},
    ],
  },
  hakari: {
    name:"하카리 키리토",emoji:"🎰",grade:"1급",
    atk:125,def:105,spd:110,maxHp:1650,domain:"질풍강운",
    desc:"복권 술식을 사용하는 주술사.",
    lore:"\"운도 실력이다! 철저하게 즐기자!\"",
    skills:[
      {name:"험한 도박",minMastery:0,  dmg:125, desc:"운에 맡긴 도박 공격!",statusApply:{target:"enemy",statusId:"stun",chance:0.3}},
      {name:"질풍열차", minMastery:5,  dmg:210, desc:"강력한 열차처럼 돌진!",statusApply:{target:"enemy",statusId:"weaken",chance:0.4}},
      {name:"유한 소설",minMastery:15, dmg:315, desc:"불멸의 몸으로 싸운다!",statusApply:{target:"self",statusId:"battleInstinct",chance:0.6}},
      {name:"질풍강운", minMastery:30, dmg:480, desc:"영역전개 — 운이 터진다!",statusApply:{target:"enemy",statusId:"freeze",chance:0.7}},
    ],
  },
};

// ════════════════════════════════════════════════════════
// ── 적 데이터
// ════════════════════════════════════════════════════════
const ENEMIES = [
  { id:"e1",name:"저급 저주령", emoji:"👹",hp:550, atk:38, def:12, xp:75, crystals:18, masteryXp:1, fingers:0, statusAttack:null },
  { id:"e2",name:"1급 저주령",  emoji:"👺",hp:1100,atk:80, def:40, xp:190,crystals:40, masteryXp:3, fingers:0, statusAttack:{statusId:"poison",chance:0.3} },
  { id:"e3",name:"특급 저주령", emoji:"💀",hp:2400,atk:128,def:72, xp:440,crystals:90, masteryXp:7, fingers:1, statusAttack:{statusId:"burn",chance:0.4} },
  { id:"e4",name:"저주의 왕 (보스)",emoji:"👑",hp:5500,atk:195,def:110,xp:1000,crystals:200,masteryXp:15,fingers:3,statusAttack:{statusId:"weaken",chance:0.5} },
];

const JUJUTSU_ENEMIES = [
  { id:"j1",name:"약화된 저주령",   emoji:"💧",hp:300, atk:25, def:8,  xp:55, crystals:12,masteryXp:1, points:1,fingers:0, statusAttack:null,desc:"⚡ 빠르지만 약함 (1포인트)"},
  { id:"j2",name:"중간급 저주령",   emoji:"🌀",hp:620, atk:55, def:28, xp:115,crystals:28,masteryXp:2, points:1,fingers:0, statusAttack:{statusId:"weaken",chance:0.2},desc:"⚖️ 균형잡힌 몹 (1포인트)"},
  { id:"j3",name:"강화 저주령",     emoji:"🔥",hp:450, atk:75, def:22, xp:95, crystals:23,masteryXp:2, points:1,fingers:0, statusAttack:{statusId:"burn",chance:0.35},desc:"💥 공격적이지만 방어 낮음 (1포인트)"},
  { id:"j4",name:"특수 저주령",     emoji:"☠️",hp:960, atk:88, def:48, xp:190,crystals:45,masteryXp:4, points:2,fingers:0, statusAttack:{statusId:"poison",chance:0.4},desc:"🧪 독 공격! (2포인트)"},
  { id:"j5",name:"엘리트 저주령",   emoji:"💀",hp:1380,atk:108,def:60, xp:280,crystals:70,masteryXp:6, points:3,fingers:1, statusAttack:{statusId:"burn",chance:0.5},desc:"⚔️ 강력한 엘리트 (3포인트)"},
  { id:"j6",name:"사멸회유 수호자", emoji:"👹",hp:2100,atk:135,def:82, xp:440,crystals:100,masteryXp:10,points:5,fingers:2,statusAttack:{statusId:"weaken",chance:0.6},desc:"🏆 최강 수호자 (5포인트)"},
];

// ════════════════════════════════════════════════════════
// ── 가챠 풀
// ════════════════════════════════════════════════════════
const GACHA_POOL = [
  {id:"gojo",rate:0.3},{id:"yuta",rate:0.45},{id:"geto",rate:0.9},{id:"jogo",rate:0.6},
  {id:"mahito",rate:0.6},{id:"hanami",rate:0.7},{id:"dagon",rate:0.7},{id:"itadori",rate:2.5},
  {id:"megumi",rate:6.0},{id:"nanami",rate:6.0},{id:"maki",rate:6.5},{id:"nobara",rate:6.5},
  {id:"higuruma",rate:6.5},{id:"todo",rate:5.0},{id:"panda",rate:32.0},{id:"inumaki",rate:23.75},
  {id:"hakari",rate:5.0},
];
const GACHA_RARITY = {
  "특급":  {stars:"★★★★★",color:0xF5C842,effect:"✨🔱✨🔱✨",flash:"LEGENDARY"},
  "준특급":{stars:"★★★★☆",color:0xff8c00,effect:"💠💠💠💠💠",flash:"EPIC"},
  "1급":   {stars:"★★★☆☆",color:0x7C5CFC,effect:"⭐⭐⭐⭐",flash:"RARE"},
  "준1급": {stars:"★★★☆☆",color:0x9b72cf,effect:"⭐⭐⭐",flash:"RARE"},
  "2급":   {stars:"★★☆☆☆",color:0x4ade80,effect:"🔹🔹🔹",flash:"UNCOMMON"},
  "3급":   {stars:"★☆☆☆☆",color:0x94a3b8,effect:"◽◽",flash:"COMMON"},
};
function rollGacha(count=1) {
  const total = GACHA_POOL.reduce((s,p) => s+p.rate, 0);
  return Array.from({length:count}, () => {
    let roll = Math.random() * total;
    for (const e of GACHA_POOL) { roll -= e.rate; if (roll <= 0) return e.id; }
    return GACHA_POOL[GACHA_POOL.length-1].id;
  });
}

const REVERSE_CHARS = new Set(["gojo","yuta"]);
const CODES = { "release":{crystals:200}, "sorryforbugs":{crystals:1000} };

// ════════════════════════════════════════════════════════
// ── 인메모리 세션
// ════════════════════════════════════════════════════════
let players = {};
const battles = {};
const cullings = {};
const jujutsus = {};
const parties = {};
const partyInvites = {};
const pvpSessions = {};
const pvpChallenges = {};
let _partyIdSeq = 1;
let _pvpIdSeq = 1;

// ════════════════════════════════════════════════════════
// ── 주력 스킬
// ════════════════════════════════════════════════════════
function getMainSkill(player, charId) {
  if (charId === "gojo" && player.mainSkillUnlocked?.gojo)
    return { name:"자폭 무라사키", dmg:640, desc:"모든 힘을 쏟아붓는 자폭 공격! 사용 후 HP 1" };
  if (charId === "sukuna" && player.mainSkillUnlocked?.sukuna)
    return { name:"세계참", dmg:700, desc:"세계조차 베어버리는 궁극의 기술!" };
  return null;
}

// ════════════════════════════════════════════════════════
// ── 플레이어 유틸
// ════════════════════════════════════════════════════════
function getPlayer(userId, username="플레이어") {
  if (!players[userId]) {
    players[userId] = {
      id:userId, name:username, crystals:500, xp:0,
      owned:["itadori"], active:"itadori",
      hp:CHARACTERS["itadori"].maxHp, potion:3,
      wins:0, losses:0,
      mastery:{itadori:0},
      reverseOutput:1.0, reverseCooldown:0,
      cullingBest:0, jujutsuBest:0,
      usedCodes:[], lastDaily:0,
      pvpWins:0, pvpLosses:0,
      statusEffects:[], skillCooldown:0,
      dailyStreak:0, sukunaFingers:0,
      kogane:null, koganeGachaCount:0,
      mainSkillUnlocked:{gojo:false, sukuna:false},
      materials:{}, equippedWeapon:null, craftedWeapons:[],
      quests:{},
    };
    savePlayer(userId);
  }
  const p = players[userId];
  let changed = false;
  if (p.name !== username && username !== "플레이어") { p.name = username; changed = true; }
  const defaults = {
    reverseOutput:1.0, reverseCooldown:0, mastery:{}, cullingBest:0,
    jujutsuBest:0, usedCodes:[], lastDaily:0, pvpWins:0, pvpLosses:0,
    statusEffects:[], skillCooldown:0, dailyStreak:0, sukunaFingers:0,
    kogane:null, koganeGachaCount:0,
    mainSkillUnlocked:{gojo:false,sukuna:false},
    materials:{}, equippedWeapon:null, craftedWeapons:[],
    quests:{},
  };
  for (const [k,v] of Object.entries(defaults)) {
    if (p[k] === undefined) { p[k] = typeof v==="object"&&v!==null ? JSON.parse(JSON.stringify(v)) : v; changed = true; }
  }
  if (!p.id) { p.id = userId; changed = true; }
  if (changed) savePlayer(userId);
  return p;
}

function getMastery(player, charId) { return player.mastery?.[charId] || 0; }
function getAvailableSkills(player, charId) {
  const m = getMastery(player, charId);
  return CHARACTERS[charId].skills.filter(s => {
    if (m < s.minMastery) return false;
    if (s.name === "스쿠나 발현" && (player.sukunaFingers||0) < 10) return false;
    return true;
  });
}
function getCurrentSkill(player, charId) {
  const skills = getAvailableSkills(player, charId);
  return skills[skills.length-1] || CHARACTERS[charId].skills[0];
}
function getNextSkill(player, charId) {
  const m = getMastery(player, charId);
  return CHARACTERS[charId].skills.find(s => s.minMastery > m) || null;
}

function getPlayerStats(player) {
  const ch = CHARACTERS[player.active];
  const kb = getKoganeBonus(player);
  const ws = getWeaponStats(player);
  if (player.active !== "itadori") return {
    atk: Math.floor(ch.atk * kb.atk) + ws.atk,
    def: Math.floor(ch.def * kb.def) + ws.def,
    maxHp: Math.floor(ch.maxHp * kb.hp) + ws.hp,
  };
  const bonus = getFingerBonus(player.sukunaFingers||0);
  return {
    atk: Math.floor((ch.atk + bonus.atkBonus) * kb.atk) + ws.atk,
    def: Math.floor((ch.def + bonus.defBonus) * kb.def) + ws.def,
    maxHp: Math.floor((ch.maxHp + bonus.hpBonus) * kb.hp) + ws.hp,
  };
}

function masteryBar(mastery, charId) {
  const tiers = CHARACTERS[charId].skills.map(s => s.minMastery);
  const max = tiers[tiers.length-1];
  if (mastery >= max) return "`[MAX]` 모든 스킬 해금!";
  const next = tiers.find(t => t > mastery) || max;
  const prev = [...tiers].reverse().find(t => t <= mastery) || 0;
  const fill = Math.round(((mastery - prev) / (next - prev)) * 10);
  return "`" + "█".repeat(Math.max(0,fill)) + "░".repeat(Math.max(0,10-fill)) + "`" + ` ${mastery}/${next}`;
}

function getLevel(xp) { return Math.floor(xp / 200) + 1; }

function hpBar(cur, max, len=10) {
  const pct = Math.max(0, Math.min(1, cur/max));
  const fill = Math.round(pct * len);
  const color = pct > 0.5 ? "🟩" : pct > 0.25 ? "🟨" : "🟥";
  return color.repeat(Math.max(0,fill)) + "⬛".repeat(Math.max(0,len-fill));
}

function isMakiAwakened(player) {
  if (player.active !== "maki") return false;
  const stats = getPlayerStats(player);
  return player.hp <= Math.floor(stats.maxHp * CHARACTERS["maki"].awakening.threshold);
}

function calcDmg(atk, def, mult=1) {
  const variance = 0.70 + Math.random() * 0.60;
  return Math.max(1, Math.floor((atk * variance - def * 0.22) * mult));
}

function calcDmgForPlayer(player, enemyDef, baseMult=1) {
  const stats = getPlayerStats(player);
  let mult = baseMult * getWeakenMult(player.statusEffects);
  if (isMakiAwakened(player)) mult *= CHARACTERS["maki"].awakening.dmgMult;
  return calcDmg(stats.atk, enemyDef, mult);
}

function calcSkillDmgForPlayer(player, baseSkillDmg) {
  let dmg = baseSkillDmg + Math.floor(Math.random() * 60);
  dmg = Math.floor(dmg * getWeakenMult(player.statusEffects));
  if (isMakiAwakened(player)) dmg = Math.floor(dmg * CHARACTERS["maki"].awakening.dmgMult);
  if (player.active === "itadori") {
    const bonus = getFingerBonus(player.sukunaFingers||0);
    dmg = Math.floor(dmg * (1 + bonus.atkBonus / 120));
  }
  const kb = getKoganeBonus(player);
  dmg = Math.floor(dmg * kb.atk);
  const ws = getWeaponStats(player);
  dmg += Math.floor(ws.atk * 0.5);
  return dmg;
}

function applySkillStatus(skill, defenderObj, attackerObj=null) {
  if (!skill.statusApply) return [];
  const { target, statusId, chance } = skill.statusApply;
  if (Math.random() > chance) return [];
  const def = STATUS_EFFECTS[statusId];
  if (target === "enemy") {
    applyStatus(defenderObj, statusId);
    return [`${def.emoji} **${def.name}** 상태이상 적용! (${def.duration}턴)`];
  }
  if (target === "self" && attackerObj) {
    applyStatus(attackerObj, statusId);
    return [`${def.emoji} **${def.name}** 발동! (${def.duration}턴)`];
  }
  return [];
}

function tickCooldowns(player) {
  if (player.reverseCooldown > 0) player.reverseCooldown--;
  if (player.skillCooldown > 0) player.skillCooldown--;
}

// ════════════════════════════════════════════════════════
// ── 파티/PvP 유틸
// ════════════════════════════════════════════════════════
function getPartyId(userId) {
  return Object.keys(parties).find(pid => parties[pid]?.members?.includes(userId)) || null;
}
function getParty(userId) { const pid = getPartyId(userId); return pid ? parties[pid] : null; }
function getPvpSessionByUser(userId) { return Object.values(pvpSessions).find(s => s.p1Id===userId||s.p2Id===userId)||null; }
function pvpOpponent(session, userId) {
  if (session.p1Id===userId) return {id:session.p2Id,hpKey:"hp2",statusKey:"status2",skillCdKey:"skillCd2",reverseCdKey:"reverseCd2",domainKey:"domainUsed2"};
  return {id:session.p1Id,hpKey:"hp1",statusKey:"status1",skillCdKey:"skillCd1",reverseCdKey:"reverseCd1",domainKey:"domainUsed1"};
}
function pvpSelf(session, userId) {
  if (session.p1Id===userId) return {id:session.p1Id,hpKey:"hp1",statusKey:"status1",skillCdKey:"skillCd1",reverseCdKey:"reverseCd1",domainKey:"domainUsed1"};
  return {id:session.p2Id,hpKey:"hp2",statusKey:"status2",skillCdKey:"skillCd2",reverseCdKey:"reverseCd2",domainKey:"domainUsed2"};
}

// ════════════════════════════════════════════════════════
// ── 컬링/사멸회유 유틸
// ════════════════════════════════════════════════════════
function getCullingPool(wave) {
  if (wave<=3) return ["e1","e1","e1","e2"];
  if (wave<=7) return ["e1","e2","e2","e2","e3"];
  if (wave<=14) return ["e2","e2","e3","e3","e3"];
  return ["e2","e3","e3","e4","e4"];
}
function pickCullingEnemy(wave) {
  const pool = getCullingPool(wave);
  const id = pool[Math.floor(Math.random()*pool.length)];
  const base = ENEMIES.find(e => e.id===id);
  const scale = 1 + (wave-1) * 0.05;
  return { ...base, hp:Math.floor(base.hp*scale), atk:Math.floor(base.atk*scale), def:Math.floor(base.def*scale), xp:Math.floor(base.xp*scale), crystals:Math.floor(base.crystals*scale), currentHp:Math.floor(base.hp*scale), statusEffects:[] };
}
function generateJujutsuChoices(wave) {
  const pool = wave<=3 ? ["j1","j1","j2","j3"] : wave<=7 ? ["j2","j3","j3","j4"] : wave<=12 ? ["j3","j4","j4","j5"] : ["j4","j5","j5","j6"];
  const ids = [];
  for (const id of [...pool].sort(()=>Math.random()-0.5)) { if (!ids.includes(id)) ids.push(id); if (ids.length===3) break; }
  while (ids.length<3) { const fb=pool[Math.floor(Math.random()*pool.length)]; if (!ids.includes(fb)) ids.push(fb); }
  return ids.slice(0,3).map(id => {
    const base = JUJUTSU_ENEMIES.find(e=>e.id===id);
    const scale = 1+(wave-1)*0.04;
    return {...base, hp:Math.floor(base.hp*scale), atk:Math.floor(base.atk*scale), def:Math.floor(base.def*scale), xp:Math.floor(base.xp*scale), crystals:Math.floor(base.crystals*scale), statusEffects:[]};
  });
}

// ════════════════════════════════════════════════════════
// ── 고퀄 전투 결과 처리 (공통 함수)
// ════════════════════════════════════════════════════════
function buildBattleLog(lines) {
  return lines.filter(Boolean).join("\n");
}

// 전투 승리 공통 처리
async function processBattleWin(player, enemy, interaction, isReply = false) {
  const kb = getKoganeBonus(player);
  const xpGain  = Math.floor((enemy.xp || enemy.masteryXp || 1) * kb.xp);
  const crystalGain = Math.floor((enemy.crystals || 0) * kb.crystal);
  player.xp       += xpGain;
  player.crystals += crystalGain;
  const masteryGain = enemy.masteryXp || 1;
  player.mastery[player.active] = (player.mastery[player.active] || 0) + masteryGain;
  player.wins++;

  // 재료 드롭
  const drops = rollDrops(enemy.id || "e1");
  addMaterials(player, drops);

  // 스쿠나 손가락
  if (enemy.fingers) player.sukunaFingers = Math.min(SUKUNA_FINGER_MAX, (player.sukunaFingers||0)+enemy.fingers);

  // 주력 스킬 언락
  let unlockMsg = "";
  if (player.active==="gojo" && !player.mainSkillUnlocked?.gojo && player.wins>=20) {
    if (!player.mainSkillUnlocked) player.mainSkillUnlocked={};
    player.mainSkillUnlocked.gojo = true;
    unlockMsg = "\n🎉 **고조의 주력 스킬 '자폭 무라사키' 획득!**";
  }
  if (player.active==="sukuna" && !player.mainSkillUnlocked?.sukuna && (player.sukunaFingers||0)>=10) {
    if (!player.mainSkillUnlocked) player.mainSkillUnlocked={};
    player.mainSkillUnlocked.sukuna = true;
    unlockMsg = "\n🎉 **스쿠나의 주력 스킬 '세계참' 획득!**";
  }

  // 퀘스트 업데이트
  updateQuestProgress(player, "battle_win", 1);
  if (enemy.id === "e3" || enemy.id === "e4") updateQuestProgress(player, "boss_kill", 1);

  const dropText = Object.keys(drops).length > 0 ? `\n\n📦 **재료 드롭:**\n${formatDrops(drops)}` : "";
  const questDone = getNewlyCompletedQuestMsg(player);

  const embed = new EmbedBuilder()
    .setTitle("🏆 전투 승리!")
    .setColor(0xF5C842)
    .setDescription([
      "```ansi",
      `\u001b[1;33m╔═══════════════════════════════╗`,
      `\u001b[1;33m║   ✨  V I C T O R Y  ✨       ║`,
      `\u001b[1;33m╚═══════════════════════════════╝`,
      "```",
      `> **${enemy.name}** 처치!`,
      `> ⭐ XP **+${xpGain}** | 💎 **+${crystalGain}** | 📈 숙련 **+${masteryGain}**`,
      dropText,
      unlockMsg,
      questDone,
    ].filter(Boolean).join("\n"))
    .addFields({ name:"📊 현재 스탯", value:`> 💚 HP: **${Math.max(0,player.hp)}** | 💎 **${player.crystals}** 크리스탈\n> ⚔️ 전적: **${player.wins}**승 **${player.losses}**패`, inline:false })
    .setFooter({ text:`LV.${getLevel(player.xp)} | 다음 전투: !전투 또는 /전투` });

  savePlayer(player.id);
  return embed;
}

function getNewlyCompletedQuestMsg(player) {
  initQuests(player);
  const msgs = [];
  for (const qp of player.quests.daily||[]) {
    if (qp.done && !qp.claimed) {
      const def = DAILY_QUESTS.find(q=>q.id===qp.id);
      if (def) msgs.push(`> 📋 **일일퀘 완료!** ${def.name} — \`!퀘스트\`로 보상 수령`);
    }
  }
  for (const qp of player.quests.weekly||[]) {
    if (qp.done && !qp.claimed) {
      const def = WEEKLY_QUESTS.find(q=>q.id===qp.id);
      if (def) msgs.push(`> 📅 **주간퀘 완료!** ${def.name} — \`!퀘스트\`로 보상 수령`);
    }
  }
  return msgs.join("\n");
}

// ════════════════════════════════════════════════════════
// ── 임베드 함수들
// ════════════════════════════════════════════════════════
function profileEmbed(player) {
  const ch = CHARACTERS[player.active];
  const stats = getPlayerStats(player);
  const skill = getCurrentSkill(player, player.active);
  const next  = getNextSkill(player, player.active);
  const mastery  = getMastery(player, player.active);
  const awakened = isMakiAwakened(player);
  const lv = getLevel(player.xp);
  const hpPct = Math.max(0, player.hp) / stats.maxHp;
  const xpNow = player.xp % 200;
  const fingers = player.sukunaFingers||0;
  const fingerBonus = getFingerBonus(fingers);
  const kb = getKoganeBonus(player);
  const kogane = player.kogane;
  const kg = kogane ? KOGANE_GRADES[kogane.grade] : null;
  const gradeInfo = GACHA_RARITY[ch.grade] || GACHA_RARITY["3급"];
  const mainSkill = getMainSkill(player, player.active);
  const weapon = player.equippedWeapon ? WEAPONS[player.equippedWeapon] : null;
  const ws = getWeaponStats(player);

  const HP_LEN=18, hpFill=Math.round(hpPct*HP_LEN);
  const hpColor = hpPct>0.6?"🟢":hpPct>0.3?"🟡":"🔴";
  const hpBarStr = `${hpColor} \`${"█".repeat(Math.max(0,hpFill))}${"░".repeat(Math.max(0,HP_LEN-hpFill))}\` **${Math.max(0,player.hp)}**/**${stats.maxHp}**`;
  const XP_LEN=18, xpFill=Math.round((xpNow/200)*XP_LEN);
  const xpBarStr = `📊 \`${"▰".repeat(Math.max(0,xpFill))}${"▱".repeat(Math.max(0,XP_LEN-xpFill))}\` **${xpNow}**/200`;

  // 재료 인벤토리 요약
  const matSummary = Object.entries(player.materials||{})
    .filter(([,qty])=>qty>0)
    .map(([id,qty])=>`${MATERIALS[id]?.emoji||""}${qty}`)
    .join("  ") || "없음";

  // 퀘스트 진행 현황
  initQuests(player);
  const dailyDone = (player.quests.daily||[]).filter(q=>q.done&&!q.claimed).length;
  const weeklyDone = (player.quests.weekly||[]).filter(q=>q.done&&!q.claimed).length;
  const questStatus = `📋 일일 수령가능: **${dailyDone}**개  📅 주간 수령가능: **${weeklyDone}**개`;

  const embed = new EmbedBuilder()
    .setTitle(awakened ? `🔥 ≪ 천여주박 각성 ≫  ${player.name}의 카드` : `${gradeInfo.effect}  ${player.name}의 주술사 카드  ${gradeInfo.effect}`)
    .setColor(awakened ? 0xFF2200 : gradeInfo.color)
    .addFields(
      {
        name:"┌─ 🏅 주술사 정보 ─────────────────┐",
        value:[
          `> 🎖️ **LV.${lv}**  |  ${ch.emoji} **${ch.name}** \`[${ch.grade}]\`  ${gradeInfo.stars}`,
          `> ${xpBarStr}`,
          `> 💎 **${player.crystals}** 크리스탈   🧪 회복약 **${player.potion}**개`,
          `> ⚔️ 일반 \`${player.wins}승 ${player.losses}패\`   PvP \`${player.pvpWins}승 ${player.pvpLosses}패\``,
          `> 🌊 컬링 최고: **WAVE ${player.cullingBest}**   🎯 사멸회유: **${player.jujutsuBest}pt**`,
        ].join("\n"), inline:false
      },
      {
        name:"┌─ 💚 전투 상태 ───────────────────┐",
        value:[
          `> ${hpBarStr}`,
          `> 🗡️ ATK **${stats.atk}**  🛡️ DEF **${stats.def}**  💚 HP **${stats.maxHp}**`,
          weapon ? `> ${weapon.emoji} **장착 주구:** ${weapon.name} (ATK+${ws.atk} DEF+${ws.def} HP+${ws.hp})` : `> ⚔️ 장착 주구: 없음`,
          `> 🩸 상태이상: **${statusStr(player.statusEffects)}**`,
          `> ⚡ 술식 CD: ${player.skillCooldown>0?`**${player.skillCooldown}턴**`:"✅ 가능"}   ♻ 반전 CD: ${player.reverseCooldown>0?`**${player.reverseCooldown}턴**`:"✅ 가능"}`,
          kogane&&kg ? `> 🐾 코가네 [${kogane.grade}]: ${kg.passiveDesc}` : `> 🐾 코가네: 없음`,
        ].filter(Boolean).join("\n"), inline:false
      },
      {
        name:"┌─ 📦 재료 인벤토리 ───────────────┐",
        value:`> ${matSummary}\n> \`!재료\` 또는 \`!주구목록\` 으로 상세 확인`, inline:false
      },
      {
        name:"┌─ 📋 퀘스트 현황 ─────────────────┐",
        value:`> ${questStatus}\n> \`!퀘스트\` 로 확인 및 보상 수령`, inline:false
      },
      {
        name:"┌─ 📦 보유 캐릭터 ──────────────────┐",
        value:player.owned.map(id=>{
          const c=CHARACTERS[id]; const m=getMastery(player,id); const ri=GACHA_RARITY[c.grade]||GACHA_RARITY["3급"];
          return `> ${id===player.active?"▶️":"　"} ${c.emoji} **${c.name}** \`${c.grade}\` ${ri.stars} · 숙련 \`${m}\``;
        }).join("\n")||"> 없음", inline:false
      },
    )
    .setFooter({text:`!전투 !컬링 !사멸회유 !결투 !가챠 !퀘스트 !주구목록 !재료 | ${player.name}`})
    .setTimestamp();
  return embed;
}

function questEmbed(player) {
  initQuests(player);
  const embed = new EmbedBuilder()
    .setTitle("📋 퀘스트 현황")
    .setColor(0x7C5CFC)
    .setTimestamp();

  // 일일 퀘스트
  const dailyLines = (player.quests.daily||[]).map(qp => {
    const def = DAILY_QUESTS.find(q=>q.id===qp.id);
    if (!def) return "";
    const bar = `\`${"█".repeat(Math.floor(qp.progress/def.target*8))}${"░".repeat(8-Math.floor(qp.progress/def.target*8))}\``;
    const status = qp.claimed ? "✅ 수령 완료" : qp.done ? "🎁 수령 가능 (`!퀘보상 일`)" : `${bar} ${qp.progress}/${def.target}`;
    const rew = `+${def.reward.crystals}💎 +${def.reward.xp}XP${def.reward.materials?` ${Object.entries(def.reward.materials).map(([m,q])=>`${MATERIALS[m]?.emoji||""}×${q}`).join(" ")}` : ""}`;
    return `> **${def.name}** — ${def.desc}\n> ${status}\n> 보상: ${rew}`;
  }).filter(Boolean).join("\n\n");

  // 주간 퀘스트
  const weeklyLines = (player.quests.weekly||[]).map(qp => {
    const def = WEEKLY_QUESTS.find(q=>q.id===qp.id);
    if (!def) return "";
    const bar = `\`${"█".repeat(Math.floor(qp.progress/def.target*8))}${"░".repeat(8-Math.floor(qp.progress/def.target*8))}\``;
    const status = qp.claimed ? "✅ 수령 완료" : qp.done ? "🎁 수령 가능 (`!퀘보상 주`)" : `${bar} ${qp.progress}/${def.target}`;
    const rew = `+${def.reward.crystals}💎 +${def.reward.xp}XP${def.reward.materials?` ${Object.entries(def.reward.materials).map(([m,q])=>`${MATERIALS[m]?.emoji||""}×${q}`).join(" ")}` : ""}`;
    return `> **${def.name}** — ${def.desc}\n> ${status}\n> 보상: ${rew}`;
  }).filter(Boolean).join("\n\n");

  embed.addFields(
    { name:"📋 ─── 일일 퀘스트 ───────────────────", value: dailyLines||"> 없음", inline:false },
    { name:"📅 ─── 주간 퀘스트 ───────────────────", value: weeklyLines||"> 없음", inline:false },
  );
  embed.setFooter({ text:"!퀘보상 일 [번호] | !퀘보상 주 [번호] 로 보상 수령" });
  return embed;
}

function materialsEmbed(player) {
  const mats = player.materials || {};
  const lines = Object.entries(MATERIALS).map(([id, m]) => {
    const qty = mats[id] || 0;
    return `> ${m.emoji} **${m.name}** ×${qty}  — ${m.desc}`;
  });
  return new EmbedBuilder()
    .setTitle("📦 재료 인벤토리")
    .setColor(0x7c5cfc)
    .setDescription(lines.join("\n"))
    .setFooter({ text:"!주구목록 — 주구 목록 및 제작 | !주구제작 [이름]" });
}

function weaponListEmbed(player) {
  const mats = player.materials || {};
  const lines = Object.entries(WEAPONS).map(([id, w]) => {
    const canCraft = Object.entries(w.recipe).every(([m,qty]) => (mats[m]||0) >= qty);
    const owned = (player.craftedWeapons||[]).includes(id);
    const equipped = player.equippedWeapon === id;
    const recipeStr = Object.entries(w.recipe).map(([m,qty]) => {
      const have = mats[m]||0;
      return `${MATERIALS[m]?.emoji||""}${have}/${qty}`;
    }).join(" ");
    return `> ${equipped?"⚔️":owned?"✅":"🔒"} **${w.emoji} ${w.name}** \`[${w.grade}]\`\n> ATK+${w.atkBonus} DEF+${w.defBonus} HP+${w.hpBonus}\n> 재료: ${recipeStr}  ${canCraft&&!owned?"**✨ 제작 가능!**":owned?"(보유중)":""}`;
  });
  return new EmbedBuilder()
    .setTitle("⚔️ 주구 (무기) 목록")
    .setColor(0xF5C842)
    .setDescription(lines.join("\n\n"))
    .setFooter({ text:"!주구제작 [무기명] | !장착 [무기명] | !해제" });
}

function cullingEmbed(player, session, log=[]) {
  const ch = CHARACTERS[player.active];
  const stats = getPlayerStats(player);
  const enemy = session.currentEnemy;
  const awakened = isMakiAwakened(player);
  return new EmbedBuilder()
    .setTitle(`${awakened?"🔥 ":""}⚔️ 컬링 게임 — 🌊 WAVE ${session.wave}`)
    .setColor(awakened?0xFF2200:session.wave>=15?0xF5C842:session.wave>=8?0xe63946:0x7C5CFC)
    .setDescription(log.join("\n")||"⚔️ 새 파도가 밀려온다!")
    .addFields(
      {name:`${ch.emoji} 내 HP`,value:`${hpBar(player.hp,stats.maxHp)} \`${Math.max(0,player.hp)}/${stats.maxHp}\`${awakened?" 🔥각성":""}\n상태: ${statusStr(player.statusEffects)}\n⚡술식: \`${player.skillCooldown>0?player.skillCooldown+"턴":"가능"}\` ♻반전: \`${player.reverseCooldown>0?player.reverseCooldown+"턴":"가능"}\``,inline:true},
      {name:`${enemy.emoji} ${enemy.name}`,value:`${hpBar(session.enemyHp,enemy.hp)} \`${Math.max(0,session.enemyHp)}/${enemy.hp}\`\n상태: ${statusStr(enemy.statusEffects)}`,inline:true},
      {name:"📊 현황",value:`WAVE **${session.wave}** | 처치 **${session.kills}** | **${session.totalXp}** XP / **${session.totalCrystals}**💎`,inline:false},
    )
    .setFooter({text:`현재 스킬: ${getCurrentSkill(player,player.active).name} | 최고기록: WAVE ${player.cullingBest}`});
}

function jujutsuEmbed(player, session, log=[], choices=null) {
  const ch = CHARACTERS[player.active];
  const stats = getPlayerStats(player);
  const awakened = isMakiAwakened(player);
  const embed = new EmbedBuilder()
    .setTitle(`🎯 사멸회유 — WAVE ${session.wave} | 포인트 **${session.points}**/15`)
    .setColor(session.points>=10?0xF5C842:session.points>=5?0xff8c00:0x7C5CFC)
    .setDescription(log.join("\n")||"🎯 사멸회유 진행 중!")
    .addFields(
      {name:`${ch.emoji} 내 HP`,value:`${hpBar(player.hp,stats.maxHp)} \`${Math.max(0,player.hp)}/${stats.maxHp}\`${awakened?" 🔥각성":""}\n상태: ${statusStr(player.statusEffects)}\n⚡술식: \`${player.skillCooldown>0?player.skillCooldown+"턴":"가능"}\` ♻반전: \`${player.reverseCooldown>0?player.reverseCooldown+"턴":"가능"}\``,inline:false},
      {name:"🎯 포인트",value:`${"🟦".repeat(Math.min(session.points,15))}${"⬜".repeat(Math.max(0,15-session.points))} **${session.points}/15**\n**${session.totalXp}** XP / **${session.totalCrystals}**💎`,inline:false},
    );
  if (session.currentEnemy) {
    const enemy = session.currentEnemy;
    embed.addFields({name:`${enemy.emoji} 현재 적: ${enemy.name}`,value:`${hpBar(session.enemyHp,enemy.hp)} \`${Math.max(0,session.enemyHp)}/${enemy.hp}\`\n상태: ${statusStr(enemy.statusEffects)}\n포인트: +${enemy.points}점`,inline:false});
  }
  if (choices) embed.addFields({name:"⚔️ 다음 적 선택",value:choices.map((c,i)=>`**[${i+1}]** ${c.emoji} ${c.name} — HP:\`${c.hp}\` ATK:\`${c.atk}\` | +${c.points}점\n└ ${c.desc}`).join("\n"),inline:false});
  embed.setFooter({text:`최고기록: ${player.jujutsuBest}포인트 | 15포인트 달성 시 보너스!`});
  return embed;
}

function pvpEmbed(session, log=[]) {
  const p1=players[session.p1Id], p2=players[session.p2Id];
  const ch1=CHARACTERS[p1.active], ch2=CHARACTERS[p2.active];
  const s1=getPlayerStats(p1), s2=getPlayerStats(p2);
  return new EmbedBuilder()
    .setTitle(`⚔️ PvP 결투  ${p1.name} VS ${p2.name}`)
    .setColor(0xF5C842)
    .setDescription(log.join("\n")||"⚔️ 결투 시작!")
    .addFields(
      {name:`${ch1.emoji} ${p1.name} [${ch1.grade}]`,value:`${hpBar(session.hp1,s1.maxHp)} \`${Math.max(0,session.hp1)}/${s1.maxHp}\`\n상태: ${statusStr(session.status1)}\n⚡술식: \`${session.skillCd1>0?session.skillCd1+"턴":"가능"}\``,inline:true},
      {name:`${ch2.emoji} ${p2.name} [${ch2.grade}]`,value:`${hpBar(session.hp2,s2.maxHp)} \`${Math.max(0,session.hp2)}/${s2.maxHp}\`\n상태: ${statusStr(session.status2)}\n⚡술식: \`${session.skillCd2>0?session.skillCd2+"턴":"가능"}\``,inline:true},
      {name:"🎯 현재 턴",value:`**${session.turn===session.p1Id?p1.name:p2.name}**의 차례 (라운드 ${session.round})`,inline:false},
    )
    .setFooter({text:"술식: 5턴 쿨다운 | 반전술식: 3턴 쿨다운 (고조/유타) | 회피율 5%"});
}

function partyCullingEmbed(party, session, log=[]) {
  const enemy = session.currentEnemy;
  const memberLines = party.members.map(uid => {
    const p=players[uid]; if (!p) return `> ❓ (${uid})`;
    const ch=CHARACTERS[p.active], stats=getPlayerStats(p), aw=isMakiAwakened(p);
    const hpPct=Math.max(0,p.hp)/stats.maxHp;
    const hpIcon=hpPct>0.5?"🟢":hpPct>0.25?"🟡":"🔴";
    return `> ${party.leader===uid?"👑":"👤"} **${p.name}** ${ch.emoji} ${hpIcon} \`${Math.max(0,p.hp)}/${stats.maxHp}\`${aw?" 🔥":""} | ${statusStr(p.statusEffects)}`;
  }).join("\n");
  return new EmbedBuilder()
    .setTitle(`⚔️ [파티] 컬링 게임 — 🌊 WAVE ${session.wave}`)
    .setColor(session.wave>=15?0xF5C842:session.wave>=8?0xe63946:0x7C5CFC)
    .setDescription(log.join("\n")||"⚔️ 파티 컬링 게임 진행 중!")
    .addFields(
      {name:`👥 파티원 (${party.members.length}명)`,value:memberLines||"없음",inline:false},
      {name:`${enemy.emoji} ${enemy.name}`,value:`${hpBar(Math.max(0,session.enemyHp),enemy.hp)} \`${Math.max(0,session.enemyHp)}/${enemy.hp}\`\n상태: ${statusStr(enemy.statusEffects||[])}`,inline:false},
      {name:"📊 현황",value:`WAVE **${session.wave}** | 처치 **${session.kills}** | **${session.totalXp}** XP / **${session.totalCrystals}**💎`,inline:false},
    )
    .setFooter({text:"파티원 누구나 행동 가능! | 파티원 전원 사망 시 종료"});
}

function gachaLoadingEmbed(stage=1) {
  const frames=[
    {title:"🔮 주술 소환 의식 — 준비",color:0x0a0a1e,desc:["```ansi","\u001b[2;30m╔══════════════════════════╗","\u001b[2;34m║  ？    ？    ？    ？    ║","\u001b[2;30m╚══════════════════════════╝","```","> *저주 에너지가 수렴하기 시작한다...*"].join("\n")},
    {title:"⚡ 저주 에너지 최대 수렴 중...",color:0x1a0533,desc:["```ansi","\u001b[1;35m╔══════════════════════════╗","\u001b[1;35m║  ⚡   ✦   ？？？   ⚡   ║","\u001b[1;35m╚══════════════════════════╝","```","> *주술 에너지가 임계점에 도달한다...*"].join("\n")},
  ];
  const f=frames[stage-1]||frames[0];
  return new EmbedBuilder().setTitle(f.title).setColor(f.color).setDescription(f.desc);
}
function gachaRevealEmbed(grade) {
  const info=GACHA_RARITY[grade]||GACHA_RARITY["3급"];
  return new EmbedBuilder().setTitle(`${info.effect} ${grade} 등급의 기운이 느껴진다!`).setColor(info.color).setDescription(`> *${info.stars}  —  ${info.flash}!*`);
}
function gachaResultEmbed(charId, isNew, player) {
  const ch=CHARACTERS[charId], info=GACHA_RARITY[ch.grade]||GACHA_RARITY["3급"];
  return new EmbedBuilder()
    .setTitle(isNew?`${info.effect} ✨ NEW! — ${ch.name} 획득!`:`${info.effect} 중복 — ${ch.name} (+50💎)`)
    .setColor(isNew?info.color:0x4a5568)
    .setDescription([`> *"${ch.lore||ch.desc}"*`].join("\n"))
    .addFields({name:"🌌 영역전개",value:ch.domain||"없음",inline:true},{name:"📖 설명",value:ch.desc,inline:false})
    .setFooter({text:`💎 잔여: ${player.crystals}`});
}
function gacha10ResultEmbed(results, newOnes, dupCrystals, player) {
  const sorted=[...results].sort((a,b)=>{
    const o=["특급","준특급","1급","준1급","2급","3급","4급"];
    return o.indexOf(CHARACTERS[a].grade)-o.indexOf(CHARACTERS[b].grade);
  });
  const lines=sorted.map(id=>{
    const ch=CHARACTERS[id],info=GACHA_RARITY[ch.grade]||GACHA_RARITY["3급"],isN=newOnes.includes(id);
    return `${ch.emoji} ${info.stars} **${ch.name}** \`[${ch.grade}]\`${isN?" **✨NEW!**":""}`;
  });
  const legendaries=results.filter(id=>CHARACTERS[id].grade==="특급");
  return new EmbedBuilder()
    .setTitle(legendaries.length>0?`🔱 ⚡ 10연차 — 전설 등급 획득!! ⚡ 🔱`:`🎲 10회 주술 소환 결과`)
    .setColor(legendaries.length>0?0xF5C842:0x7c5cfc)
    .setDescription(lines.join("\n"))
    .addFields(
      {name:"✨ 신규 획득",value:newOnes.length?newOnes.map(id=>`${CHARACTERS[id].emoji} ${CHARACTERS[id].name}`).join(", "):"없음",inline:true},
      {name:"🔄 중복 보상",value:`**+${dupCrystals}** 💎`,inline:true},
      {name:"💎 잔여",value:`**${player.crystals}**`,inline:true},
    );
}
function koganeProfileEmbed(player) {
  const kogane=player.kogane;
  if (!kogane) return new EmbedBuilder().setTitle("🐾 코가네 — 황금 개 펫").setColor(0x4a5568).setDescription("> **코가네**가 없습니다! `!코가네가챠` (200💎)").setFooter({text:"!코가네가챠 (200💎)"});
  const g=KOGANE_GRADES[kogane.grade];
  return new EmbedBuilder().setTitle(`${g.emoji} 코가네 [${kogane.grade}] ${g.stars}`).setColor(g.color)
    .setDescription([`> **패시브:** ${g.passiveDesc}`,`> **스킬:** ${g.skill} — ${g.skillDesc}`].join("\n"))
    .addFields(
      {name:"📊 스탯 보너스",value:`> 🗡️ ATK +${Math.round(g.atkBonus*100)}%\n> 🛡️ DEF +${Math.round(g.defBonus*100)}%\n> 💚 HP +${Math.round(g.hpBonus*100)}%`,inline:true},
      {name:"📈 보상 보너스",value:`> ⭐ XP +${Math.round(g.xpBonus*100)}%\n> 💎 크리스탈 +${Math.round(g.crystalBonus*100)}%`,inline:true},
    ).setFooter({text:`총 소환 횟수: ${player.koganeGachaCount||0}회`});
}

// ════════════════════════════════════════════════════════
// ── 버튼 팩토리
// ════════════════════════════════════════════════════════
const mkBattleButtons = (player) => {
  const canSkill = !player||player.skillCooldown<=0;
  const canReverse = !player||player.reverseCooldown<=0;
  const hasReverse = !player||REVERSE_CHARS.has(player.active);
  const mainSkill = getMainSkill(player, player.active);
  const buttons=[
    new ButtonBuilder().setCustomId("b_attack").setLabel("⚔️ 공격").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("b_skill").setLabel(`🌀 ${getCurrentSkill(player,player.active).name}`).setStyle(ButtonStyle.Primary).setDisabled(!canSkill),
  ];
  if (mainSkill) buttons.push(new ButtonBuilder().setCustomId("b_main").setLabel(`⭐ ${mainSkill.name}`).setStyle(ButtonStyle.Success));
  buttons.push(
    new ButtonBuilder().setCustomId("b_reverse").setLabel("♻️ 반전").setStyle(ButtonStyle.Secondary).setDisabled(!canReverse||!hasReverse),
    new ButtonBuilder().setCustomId("b_run").setLabel("🏃 도주").setStyle(ButtonStyle.Secondary),
  );
  return new ActionRowBuilder().addComponents(buttons);
};
const mkCullingButtons = (player) => {
  const canSkill=!player||player.skillCooldown<=0;
  const canReverse=!player||player.reverseCooldown<=0;
  const hasReverse=!player||REVERSE_CHARS.has(player.active);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("c_attack").setLabel("⚔️ 공격").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("c_skill").setLabel(`🌀 ${getCurrentSkill(player,player.active).name}`).setStyle(ButtonStyle.Primary).setDisabled(!canSkill),
    new ButtonBuilder().setCustomId("c_reverse").setLabel("♻️ 반전").setStyle(ButtonStyle.Secondary).setDisabled(!canReverse||!hasReverse),
    new ButtonBuilder().setCustomId("c_escape").setLabel("🏳️ 철수").setStyle(ButtonStyle.Secondary),
  );
};
const mkJujutsuButtons = (player, choices) => {
  const row=new ActionRowBuilder();
  for (let i=0;i<Math.min(choices.length,3);i++) {
    row.addComponents(new ButtonBuilder().setCustomId(`j_choice_${i}`).setLabel(`⚔️ ${choices[i].name}`).setStyle(ButtonStyle.Primary));
  }
  const canSkill=!player||player.skillCooldown<=0;
  const canReverse=!player||player.reverseCooldown<=0;
  const hasReverse=!player||REVERSE_CHARS.has(player.active);
  return [row, new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("j_attack").setLabel("⚔️ 공격").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("j_skill").setLabel(`🌀 ${getCurrentSkill(player,player.active).name}`).setStyle(ButtonStyle.Primary).setDisabled(!canSkill),
    new ButtonBuilder().setCustomId("j_reverse").setLabel("♻️ 반전").setStyle(ButtonStyle.Secondary).setDisabled(!canReverse||!hasReverse),
    new ButtonBuilder().setCustomId("j_escape").setLabel("🏳️ 철수").setStyle(ButtonStyle.Secondary),
  )];
};
const mkPvpButtons = (session, userId) => {
  const self=pvpSelf(session,userId);
  const canSkill=self.skillCdKey?session[self.skillCdKey]<=0:true;
  const canReverse=self.reverseCdKey?session[self.reverseCdKey]<=0:true;
  const player=players[userId];
  const hasReverse=REVERSE_CHARS.has(player?.active);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("p_attack").setLabel("⚔️ 공격").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("p_skill").setLabel(`🌀 술식${canSkill?"":"(✖)"}`).setStyle(ButtonStyle.Primary).setDisabled(!canSkill),
    new ButtonBuilder().setCustomId("p_domain").setLabel("🌌 영역전개").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("p_reverse").setLabel(`♻️ 반전${canReverse?"":"(✖)"}`).setStyle(ButtonStyle.Secondary).setDisabled(!canReverse||!hasReverse),
    new ButtonBuilder().setCustomId("p_surrender").setLabel("🏳️ 항복").setStyle(ButtonStyle.Secondary),
  );
};

// ════════════════════════════════════════════════════════
// ── 고퀄 전투 핸들러 (일반 전투)
// ════════════════════════════════════════════════════════
async function handleBattleAction(interaction, player, battle, action) {
  const enemy = battle.enemy;

  // ── 공격 ──
  if (action === "b_attack") {
    if (isIncapacitated(player.statusEffects)) {
      return interaction.reply({ content:"❌ 상태이상으로 행동할 수 없습니다!", ephemeral:true });
    }
    const hit = rollHit(player.statusEffects, enemy.statusEffects);
    const log = [];
    let dmg = 0, isBlack = false;

    if (!hit) {
      log.push("⚡ 공격이 **빗나갔다!**");
    } else {
      dmg = calcDmgForPlayer(player, enemy.def);
      isBlack = isBlackFlash();
      if (isBlack) {
        dmg = Math.floor(dmg * 2.5);
        player.crystals += 50;
        log.push(getBlackFlashArt());
        log.push(`\u001b[1;31m💥 **흑섬 발동!!** **${dmg}** 피해! (2.5배) +50💎`);
      } else {
        log.push(`> ⚔️ ${player.name}의 공격! **${dmg}** 피해!`);
      }
      enemy.currentHp = Math.max(0, enemy.currentHp - dmg);
    }

    const stats = getPlayerStats(player);
    const embed = new EmbedBuilder()
      .setTitle(isBlack ? "⚫ 흑 섬 ⚫" : "⚔️ 공격!")
      .setColor(isBlack ? 0x0a0a0a : 0xff6b35)
      .setDescription(log.join("\n"))
      .addFields(
        {name:`${CHARACTERS[player.active].emoji} 내 HP`,value:`${hpBar(player.hp,stats.maxHp)} \`${Math.max(0,player.hp)}/${stats.maxHp}\``,inline:true},
        {name:`${enemy.emoji} ${enemy.name}`,value:`${hpBar(enemy.currentHp,enemy.hp)} \`${Math.max(0,enemy.currentHp)}/${enemy.hp}\``,inline:true},
      );

    if (enemy.currentHp <= 0) {
      delete battles[interaction.user.id];
      const winEmbed = await processBattleWin(player, enemy, interaction);
      return interaction.update({ embeds:[embed, winEmbed], components:[] });
    }

    // 적 반격
    await doEnemyAttack(player, enemy, log);
    embed.setDescription(log.join("\n"));
    embed.spliceFields(0,2,
      {name:`${CHARACTERS[player.active].emoji} 내 HP`,value:`${hpBar(player.hp,stats.maxHp)} \`${Math.max(0,player.hp)}/${stats.maxHp}\`\n상태: ${statusStr(player.statusEffects)}`,inline:true},
      {name:`${enemy.emoji} ${enemy.name}`,value:`${hpBar(enemy.currentHp,enemy.hp)} \`${Math.max(0,enemy.currentHp)}/${enemy.hp}\`\n상태: ${statusStr(enemy.statusEffects||[])}`,inline:true},
    );
    tickCooldowns(player);

    if (player.hp <= 0) {
      player.losses++;
      delete battles[interaction.user.id];
      embed.setColor(0xe63946);
      const defeatEmbed = new EmbedBuilder().setTitle("💀 패배...").setColor(0xe63946)
        .setDescription("```ansi\n\u001b[1;31m╔═══════════════╗\n\u001b[1;31m║  💀 D E F E A T  💀  ║\n\u001b[1;31m╚═══════════════╝\n```\n> 저주령에게 쓰러졌습니다...\n> `!회복` 으로 HP를 회복하세요.");
      savePlayer(interaction.user.id);
      return interaction.update({ embeds:[embed, defeatEmbed], components:[] });
    }

    savePlayer(interaction.user.id);
    await interaction.update({ embeds:[embed], components:[mkBattleButtons(player)] });
    return;
  }

  // ── 술식 ──
  if (action === "b_skill") {
    if (isIncapacitated(player.statusEffects)) {
      return interaction.reply({ content:"❌ 상태이상으로 행동할 수 없습니다!", ephemeral:true });
    }
    if (player.skillCooldown > 0) {
      return interaction.reply({ content:`❌ 술식 쿨다운: ${player.skillCooldown}턴 남음!`, ephemeral:true });
    }
    const skill = getCurrentSkill(player, player.active);
    const hit = rollHit(player.statusEffects, enemy.statusEffects);
    const log = [];

    if (!hit) {
      log.push("⚡ 술식이 **빗나갔다!**");
    } else {
      let dmg = calcSkillDmgForPlayer(player, skill.dmg);
      // 흑섬 10% 술식에도 적용
      const isBlack = isBlackFlash();
      if (isBlack) { dmg = Math.floor(dmg * 2.5); player.crystals += 50; }
      const statusLog = applySkillStatus(skill, enemy, player);
      enemy.currentHp = Math.max(0, enemy.currentHp - dmg);
      const fx = getSkillEffect(skill.name);
      log.push(fx.art);
      log.push(`> *"${fx.flavorText}"*`);
      if (isBlack) log.push(`⚫ **흑섬 발동!!** **${dmg}** 피해! (2.5배) +50💎`);
      else log.push(`> 💥 **${skill.name}** — **${dmg}** 피해!`);
      log.push(...statusLog);
      updateQuestProgress(player, "skill_use", 1);
    }
    player.skillCooldown = 5;

    const stats = getPlayerStats(player);
    const embed = new EmbedBuilder()
      .setTitle(`🌀 ${skill.name}!`)
      .setColor(getSkillEffect(skill.name).color)
      .setDescription(log.join("\n"))
      .addFields(
        {name:`${CHARACTERS[player.active].emoji} 내 HP`,value:`${hpBar(player.hp,stats.maxHp)} \`${Math.max(0,player.hp)}/${stats.maxHp}\``,inline:true},
        {name:`${enemy.emoji} ${enemy.name}`,value:`${hpBar(enemy.currentHp,enemy.hp)} \`${Math.max(0,enemy.currentHp)}/${enemy.hp}\``,inline:true},
      );

    if (enemy.currentHp <= 0) {
      delete battles[interaction.user.id];
      const winEmbed = await processBattleWin(player, enemy, interaction);
      return interaction.update({ embeds:[embed, winEmbed], components:[] });
    }

    await doEnemyAttack(player, enemy, log);
    embed.setDescription(log.join("\n"));
    embed.spliceFields(0,2,
      {name:`${CHARACTERS[player.active].emoji} 내 HP`,value:`${hpBar(player.hp,stats.maxHp)} \`${Math.max(0,player.hp)}/${stats.maxHp}\`\n상태: ${statusStr(player.statusEffects)}`,inline:true},
      {name:`${enemy.emoji} ${enemy.name}`,value:`${hpBar(enemy.currentHp,enemy.hp)} \`${Math.max(0,enemy.currentHp)}/${enemy.hp}\`\n상태: ${statusStr(enemy.statusEffects||[])}`,inline:true},
    );
    tickCooldowns(player);

    if (player.hp <= 0) {
      player.losses++;
      delete battles[interaction.user.id];
      const defeatEmbed = new EmbedBuilder().setTitle("💀 패배...").setColor(0xe63946).setDescription("> 쓰러졌습니다... `!회복` 으로 HP를 회복하세요.");
      savePlayer(interaction.user.id);
      return interaction.update({ embeds:[embed, defeatEmbed], components:[] });
    }
    savePlayer(interaction.user.id);
    return interaction.update({ embeds:[embed], components:[mkBattleButtons(player)] });
  }

  // ── 주력 스킬 ──
  if (action === "b_main") {
    const mainSkill = getMainSkill(player, player.active);
    if (!mainSkill) return interaction.reply({ content:"❌ 주력 스킬 미획득!", ephemeral:true });
    if (isIncapacitated(player.statusEffects)) return interaction.reply({ content:"❌ 상태이상으로 행동 불가!", ephemeral:true });
    const hit = rollHit(player.statusEffects, enemy.statusEffects);
    const log = [];

    if (!hit) {
      log.push("⚡ 주력 스킬이 **빗나갔다!**");
    } else {
      let dmg = calcSkillDmgForPlayer(player, mainSkill.dmg);
      const isBlack = isBlackFlash();
      if (isBlack) { dmg = Math.floor(dmg * 2.5); player.crystals += 50; }
      enemy.currentHp = Math.max(0, enemy.currentHp - dmg);
      const fx = getSkillEffect(mainSkill.name);
      log.push(fx.art);
      log.push(`> *"${fx.flavorText}"*`);
      if (isBlack) log.push(`⚫ **흑섬 발동!!** **${dmg}** 피해! (2.5배)`);
      else log.push(`> ⭐ **${mainSkill.name}** — **${dmg}** 피해!`);
      if (mainSkill.name === "자폭 무라사키") { player.hp = 1; log.push("> 💥 **자폭 효과!** 자신의 HP가 1이 되었다!"); }
    }
    player.skillCooldown = 6;

    const stats = getPlayerStats(player);
    const embed = new EmbedBuilder().setTitle(`⭐ ${mainSkill.name}!`).setColor(0xffcc00)
      .setDescription(log.join("\n"))
      .addFields(
        {name:"내 HP",value:`${hpBar(player.hp,stats.maxHp)} \`${Math.max(0,player.hp)}/${stats.maxHp}\``,inline:true},
        {name:`${enemy.emoji}`,value:`${hpBar(enemy.currentHp,enemy.hp)} \`${Math.max(0,enemy.currentHp)}/${enemy.hp}\``,inline:true},
      );

    if (enemy.currentHp <= 0) {
      delete battles[interaction.user.id];
      const winEmbed = await processBattleWin(player, enemy, interaction);
      return interaction.update({ embeds:[embed,winEmbed], components:[] });
    }

    await doEnemyAttack(player, enemy, log);
    tickCooldowns(player);
    if (player.hp <= 0) {
      player.losses++; delete battles[interaction.user.id];
      savePlayer(interaction.user.id);
      return interaction.update({ embeds:[embed, new EmbedBuilder().setTitle("💀 패배...").setColor(0xe63946).setDescription("> `!회복` 으로 HP 회복")], components:[] });
    }
    savePlayer(interaction.user.id);
    return interaction.update({ embeds:[embed], components:[mkBattleButtons(player)] });
  }

  // ── 반전술식 ──
  if (action === "b_reverse") {
    if (!REVERSE_CHARS.has(player.active)) return interaction.reply({ content:"❌ 이 캐릭터는 반전술식 불가!", ephemeral:true });
    const stats = getPlayerStats(player);
    const healAmount = Math.floor(stats.maxHp * 0.4);
    player.hp = Math.min(stats.maxHp, player.hp + healAmount);
    player.reverseCooldown = 3;
    // 상태이상 해제
    player.statusEffects = player.statusEffects.filter(s => s.id==="battleInstinct");
    tickCooldowns(player);
    savePlayer(interaction.user.id);
    const embed = new EmbedBuilder().setTitle("♻️ 반전술식!").setColor(0x00ff88)
      .setDescription([`> 💚 **${healAmount}** HP 회복!`, `> 🧹 상태이상 해제!`].join("\n"))
      .addFields({name:"내 HP",value:`${hpBar(player.hp,stats.maxHp)} \`${player.hp}/${stats.maxHp}\``,inline:true});
    return interaction.update({ embeds:[embed], components:[mkBattleButtons(player)] });
  }

  // ── 도주 ──
  if (action === "b_run") {
    delete battles[interaction.user.id];
    return interaction.update({ content:"🏃 전투에서 도주했습니다!", embeds:[], components:[] });
  }
}

// 적 반격 (공통)
async function doEnemyAttack(player, enemy, log) {
  const stats = getPlayerStats(player);
  // 상태이상 틱
  const tick = tickStatus(player, stats.maxHp);
  if (tick.log.length) log.push(...tick.log);

  const enemyHit = rollHit(enemy.statusEffects || [], player.statusEffects);
  if (!enemyHit) {
    log.push(`> ↩️ **${enemy.name}**의 공격이 빗나갔다!`);
    return;
  }
  const eDmg = calcDmg(enemy.atk, stats.def);
  player.hp = Math.max(0, player.hp - eDmg);
  log.push(`> 💢 **${enemy.name}** 의 반격! **${eDmg}** 피해!`);

  if (enemy.statusAttack && Math.random() < (enemy.statusAttack.chance || 0.3)) {
    applyStatus(player, enemy.statusAttack.statusId);
    const sdef = STATUS_EFFECTS[enemy.statusAttack.statusId];
    log.push(`> ${sdef.emoji} **${sdef.name}** 상태이상!`);
  }
}

// ════════════════════════════════════════════════════════
// ── 컬링 핸들러
// ════════════════════════════════════════════════════════
async function handleCullingAction(interaction, player, culling, action) {
  const enemy = culling.currentEnemy;
  const stats = getPlayerStats(player);
  const log = [];

  if (action === "c_escape") {
    if (culling.wave > (player.cullingBest||0)) player.cullingBest = culling.wave;
    delete cullings[interaction.user.id];
    savePlayer(interaction.user.id);
    return interaction.update({ content:`🏳️ 컬링 종료! 최고 기록: WAVE **${player.cullingBest}**`, embeds:[], components:[] });
  }

  if (action === "c_reverse") {
    if (!REVERSE_CHARS.has(player.active)) return interaction.reply({ content:"❌ 반전술식 불가!", ephemeral:true });
    const heal = Math.floor(stats.maxHp * 0.4);
    player.hp = Math.min(stats.maxHp, player.hp + heal);
    player.reverseCooldown = 3;
    player.statusEffects = player.statusEffects.filter(s=>s.id==="battleInstinct");
    log.push(`> ♻️ **${heal}** HP 회복! 상태이상 해제!`);
  } else if (action === "c_attack" || action === "c_skill") {
    if (isIncapacitated(player.statusEffects)) return interaction.reply({ content:"❌ 상태이상으로 행동 불가!", ephemeral:true });
    const hit = rollHit(player.statusEffects, enemy.statusEffects);
    let dmg = 0, isBlack = false;

    if (!hit) {
      log.push("⚡ 공격이 **빗나갔다!**");
    } else {
      if (action === "c_skill") {
        if (player.skillCooldown > 0) return interaction.reply({ content:`❌ 술식 쿨다운: ${player.skillCooldown}턴`, ephemeral:true });
        const skill = getCurrentSkill(player, player.active);
        dmg = calcSkillDmgForPlayer(player, skill.dmg);
        isBlack = isBlackFlash();
        if (isBlack) { dmg = Math.floor(dmg*2.5); player.crystals+=50; }
        const statusLog = applySkillStatus(skill, enemy, player);
        const fx = getSkillEffect(skill.name);
        log.push(fx.art);
        if (isBlack) log.push(`⚫ **흑섬!** **${dmg}** 피해! (×2.5) +50💎`);
        else log.push(`> 🌀 **${skill.name}** — **${dmg}** 피해!`);
        log.push(...statusLog);
        player.skillCooldown = 5;
        updateQuestProgress(player, "skill_use", 1);
      } else {
        dmg = calcDmgForPlayer(player, enemy.def);
        isBlack = isBlackFlash();
        if (isBlack) { dmg = Math.floor(dmg*2.5); player.crystals+=50; log.push(`⚫ **흑섬!** **${dmg}** 피해!`); }
        else log.push(`> ⚔️ 공격! **${dmg}** 피해!`);
      }
      culling.enemyHp = Math.max(0, culling.enemyHp - dmg);
    }

    // 적 처치
    if (culling.enemyHp <= 0) {
      const kb = getKoganeBonus(player);
      const xp = Math.floor(enemy.xp * kb.xp);
      const cr = Math.floor(enemy.crystals * kb.crystal);
      culling.totalXp += xp; culling.totalCrystals += cr; culling.kills++;
      player.xp += xp; player.crystals += cr;
      player.mastery[player.active] = (player.mastery[player.active]||0) + (enemy.masteryXp||1);
      if (enemy.fingers) player.sukunaFingers = Math.min(SUKUNA_FINGER_MAX,(player.sukunaFingers||0)+enemy.fingers);

      // 재료 드롭
      const drops = rollDrops(enemy.id);
      addMaterials(player, drops);

      // 퀘스트
      updateQuestProgress(player, "battle_win", 1);
      if (enemy.id==="e3"||enemy.id==="e4") updateQuestProgress(player, "boss_kill", 1);

      log.push(`> ✅ **${enemy.name}** 처치! +${xp}XP +${cr}💎`);
      if (Object.keys(drops).length) log.push(`> 📦 ${formatDrops(drops)}`);

      // 다음 웨이브
      culling.wave++;
      updateQuestProgress(player, "culling_wave", 1);
      if (culling.wave > (player.cullingBest||0)) player.cullingBest = culling.wave;
      const nextEnemy = pickCullingEnemy(culling.wave);
      culling.currentEnemy = nextEnemy;
      culling.enemyHp = nextEnemy.hp;
      log.push(`> 🌊 **WAVE ${culling.wave}** — **${nextEnemy.name}** 등장!`);
    } else {
      // 적 반격
      await doEnemyAttack(player, enemy, log);
      if (player.hp <= 0) {
        if (culling.wave > (player.cullingBest||0)) player.cullingBest = culling.wave;
        delete cullings[interaction.user.id];
        savePlayer(interaction.user.id);
        const over = new EmbedBuilder().setTitle("💀 컬링 종료!").setColor(0xe63946)
          .setDescription(`> WAVE **${culling.wave}** 에서 쓰러졌습니다!\n> 총 XP: **${culling.totalXp}** | 총 💎: **${culling.totalCrystals}**\n> 최고기록: WAVE **${player.cullingBest}**`);
        return interaction.update({ embeds:[over], components:[] });
      }
    }
  }
  tickCooldowns(player);
  savePlayer(interaction.user.id);
  const embed = cullingEmbed(player, culling, log);
  return interaction.update({ embeds:[embed], components:[mkCullingButtons(player)] });
}

// ════════════════════════════════════════════════════════
// ── 사멸회유 핸들러
// ════════════════════════════════════════════════════════
async function handleJujutsuAction(interaction, player, jujutsu, action) {
  const stats = getPlayerStats(player);
  const log = [];

  if (action === "j_escape") {
    if (jujutsu.points > (player.jujutsuBest||0)) player.jujutsuBest = jujutsu.points;
    delete jujutsus[interaction.user.id];
    savePlayer(interaction.user.id);
    return interaction.update({ content:`🏳️ 사멸회유 종료! 최고 기록: **${player.jujutsuBest}pt**`, embeds:[], components:[] });
  }

  const enemy = jujutsu.currentEnemy;
  if (!enemy) return interaction.reply({ content:"❌ 적을 먼저 선택하세요!", ephemeral:true });

  if (action === "j_reverse") {
    if (!REVERSE_CHARS.has(player.active)) return interaction.reply({ content:"❌ 반전술식 불가!", ephemeral:true });
    const heal = Math.floor(stats.maxHp * 0.4);
    player.hp = Math.min(stats.maxHp, player.hp + heal);
    player.reverseCooldown = 3;
    player.statusEffects = player.statusEffects.filter(s=>s.id==="battleInstinct");
    log.push(`> ♻️ **${heal}** HP 회복!`);
  } else {
    if (isIncapacitated(player.statusEffects)) return interaction.reply({ content:"❌ 상태이상으로 행동 불가!", ephemeral:true });
    const hit = rollHit(player.statusEffects, enemy.statusEffects);
    let dmg = 0;

    if (!hit) {
      log.push("⚡ 공격이 **빗나갔다!**");
    } else {
      if (action === "j_skill") {
        if (player.skillCooldown > 0) return interaction.reply({ content:`❌ 술식 쿨다운: ${player.skillCooldown}턴`, ephemeral:true });
        const skill = getCurrentSkill(player, player.active);
        dmg = calcSkillDmgForPlayer(player, skill.dmg);
        const isBlack = isBlackFlash();
        if (isBlack) { dmg = Math.floor(dmg*2.5); player.crystals+=50; }
        const statusLog = applySkillStatus(skill, enemy, player);
        const fx = getSkillEffect(skill.name);
        log.push(fx.art);
        if (isBlack) log.push(`⚫ **흑섬!** **${dmg}** 피해! +50💎`);
        else log.push(`> 🌀 **${skill.name}** — **${dmg}** 피해!`);
        log.push(...statusLog);
        player.skillCooldown = 5;
        updateQuestProgress(player, "skill_use", 1);
      } else {
        dmg = calcDmgForPlayer(player, enemy.def);
        const isBlack = isBlackFlash();
        if (isBlack) { dmg = Math.floor(dmg*2.5); player.crystals+=50; log.push(`⚫ **흑섬!** **${dmg}** 피해!`); }
        else log.push(`> ⚔️ 공격! **${dmg}** 피해!`);
      }
      jujutsu.enemyHp = Math.max(0, jujutsu.enemyHp - dmg);
    }

    if (jujutsu.enemyHp <= 0) {
      const kb = getKoganeBonus(player);
      const xp = Math.floor(enemy.xp*kb.xp);
      const cr = Math.floor(enemy.crystals*kb.crystal);
      jujutsu.totalXp += xp; jujutsu.totalCrystals += cr;
      jujutsu.points += enemy.points||1;
      player.xp += xp; player.crystals += cr;
      player.mastery[player.active] = (player.mastery[player.active]||0)+(enemy.masteryXp||1);

      // 재료 드롭
      const drops = rollDrops(enemy.id, true);
      addMaterials(player, drops);

      updateQuestProgress(player, "battle_win", 1);
      updateQuestProgress(player, "jujutsu_point", enemy.points||1);
      if (enemy.id==="j5"||enemy.id==="j6") updateQuestProgress(player, "boss_kill", 1);

      log.push(`> ✅ **${enemy.name}** 처치! +${xp}XP +${cr}💎 +${enemy.points}점`);
      if (Object.keys(drops).length) log.push(`> 📦 ${formatDrops(drops)}`);

      if (jujutsu.points >= 15) {
        // 클리어 보상
        player.crystals += 300; player.xp += 500;
        if (jujutsu.points > (player.jujutsuBest||0)) player.jujutsuBest = jujutsu.points;
        delete jujutsus[interaction.user.id];
        const over = new EmbedBuilder().setTitle("🏆 사멸회유 클리어!").setColor(0xF5C842)
          .setDescription([
            "```ansi",`\u001b[1;33m╔════════════════╗\n║   CLEAR!!  🏆   ║\n╚════════════════╝`,"```",
            `> 15포인트 달성! **+300💎 +500XP** 보너스!`,
            `> 총 XP: **${jujutsu.totalXp}** | 총 💎: **${jujutsu.totalCrystals}**`,
            getNewlyCompletedQuestMsg(player),
          ].filter(Boolean).join("\n"));
        savePlayer(interaction.user.id);
        return interaction.update({ embeds:[over], components:[] });
      }

      // 다음 적 선택
      jujutsu.wave++; jujutsu.currentEnemy = null; jujutsu.enemyHp = 0;
      const choices = generateJujutsuChoices(jujutsu.wave);
      jujutsu.choices = choices;
      const embed = jujutsuEmbed(player, jujutsu, log, choices);
      tickCooldowns(player); savePlayer(interaction.user.id);
      return interaction.update({ embeds:[embed], components:mkJujutsuButtons(player, choices) });
    }

    // 적 반격
    await doEnemyAttack(player, enemy, log);
    if (player.hp <= 0) {
      if (jujutsu.points > (player.jujutsuBest||0)) player.jujutsuBest = jujutsu.points;
      delete jujutsus[interaction.user.id];
      savePlayer(interaction.user.id);
      const over = new EmbedBuilder().setTitle("💀 사멸회유 종료!").setColor(0xe63946)
        .setDescription(`> **${jujutsu.points}포인트** 획득! XP: **${jujutsu.totalXp}** | 💎: **${jujutsu.totalCrystals}**`);
      return interaction.update({ embeds:[over], components:[] });
    }
  }
  tickCooldowns(player); savePlayer(interaction.user.id);
  const embed = jujutsuEmbed(player, jujutsu, log);
  const rows = mkJujutsuButtons(player, []);
  return interaction.update({ embeds:[embed], components:[rows[1]] });
}

// ════════════════════════════════════════════════════════
// ── PvP 핸들러
// ════════════════════════════════════════════════════════
async function handlePvpAction(interaction, player, session, action) {
  const selfKeys = pvpSelf(session, player.id);
  const oppKeys  = pvpOpponent(session, player.id);
  const opp = players[oppKeys.id];
  const selfStats = getPlayerStats(player);
  const oppStats  = getPlayerStats(opp);
  const log = [];

  if (action === "p_surrender") {
    player.pvpLosses++; opp.pvpWins++;
    updateQuestProgress(opp, "pvp_win", 1);
    const sid = Object.keys(pvpSessions).find(k=>pvpSessions[k]===session);
    if (sid) delete pvpSessions[sid];
    savePlayer(player.id); savePlayer(opp.id);
    return interaction.update({ content:`🏳️ **${player.name}** 항복! **${opp.name}** 승리!`, embeds:[], components:[] });
  }

  if (action === "p_attack") {
    const hit = rollHit(player.statusEffects, session[oppKeys.statusKey]);
    if (!hit) { log.push("⚡ 공격이 빗나갔다!"); }
    else {
      let dmg = calcDmg(selfStats.atk * getWeakenMult(player.statusEffects), oppStats.def);
      const isBlack = isBlackFlash();
      if (isBlack) { dmg = Math.floor(dmg*2.5); log.push(`⚫ **흑섬!** **${dmg}** 피해! (×2.5)`); }
      else { log.push(`⚔️ **${player.name}** 의 공격! **${dmg}** 피해!`); }
      session[oppKeys.hpKey] = Math.max(0, session[oppKeys.hpKey] - dmg);
    }
  } else if (action === "p_skill") {
    if (session[selfKeys.skillCdKey] > 0) return interaction.reply({ content:"❌ 술식 쿨다운!", ephemeral:true });
    const skill = getCurrentSkill(player, player.active);
    const hit = rollHit(player.statusEffects, session[oppKeys.statusKey]);
    if (!hit) { log.push("⚡ 술식이 빗나갔다!"); }
    else {
      let dmg = calcSkillDmgForPlayer(player, skill.dmg);
      const isBlack = isBlackFlash();
      if (isBlack) { dmg = Math.floor(dmg*2.5); log.push(`⚫ **흑섬!** **${dmg}** 피해!`); }
      else { log.push(`🌀 **${skill.name}** — **${dmg}** 피해!`); }
      if (skill.statusApply && Math.random() < skill.statusApply.chance) {
        if (skill.statusApply.target==="enemy") {
          applyStatus({statusEffects:session[oppKeys.statusKey]}, skill.statusApply.statusId);
          log.push(`${STATUS_EFFECTS[skill.statusApply.statusId]?.emoji} 상태이상 부여!`);
        }
      }
      session[oppKeys.hpKey] = Math.max(0, session[oppKeys.hpKey] - dmg);
    }
    session[selfKeys.skillCdKey] = 5;
    updateQuestProgress(player, "skill_use", 1);
  } else if (action === "p_domain") {
    const ch = CHARACTERS[player.active];
    if (!ch.domain) return interaction.reply({ content:"❌ 영역전개 없음!", ephemeral:true });
    const dmg = Math.floor(selfStats.atk * 2.8);
    session[oppKeys.hpKey] = Math.max(0, session[oppKeys.hpKey] - dmg);
    log.push(`🌌 **${ch.domain}** — **${dmg}** 피해!`);
  } else if (action === "p_reverse") {
    if (!REVERSE_CHARS.has(player.active)) return interaction.reply({ content:"❌ 반전술식 불가!", ephemeral:true });
    if (session[selfKeys.reverseCdKey] > 0) return interaction.reply({ content:"❌ 반전 쿨다운!", ephemeral:true });
    const heal = Math.floor(selfStats.maxHp * 0.4);
    session[selfKeys.hpKey] = Math.min(selfStats.maxHp, session[selfKeys.hpKey] + heal);
    session[selfKeys.reverseCdKey] = 3;
    log.push(`♻️ **${heal}** HP 회복!`);
  }

  // 승패 판정
  if (session[oppKeys.hpKey] <= 0) {
    player.pvpWins++; opp.pvpLosses++;
    updateQuestProgress(player, "pvp_win", 1);
    const sid = Object.keys(pvpSessions).find(k=>pvpSessions[k]===session);
    if (sid) delete pvpSessions[sid];
    savePlayer(player.id); savePlayer(opp.id);
    const winEmbed = new EmbedBuilder().setTitle(`🏆 ${player.name} 승리!`).setColor(0xF5C842)
      .setDescription(`> **${player.name}** 이 **${opp.name}** 을 격파!\n> ⚔️ PvP 전적: **${player.pvpWins}**승 **${player.pvpLosses}**패`);
    return interaction.update({ embeds:[pvpEmbed(session,log), winEmbed], components:[] });
  }

  // 턴 교체
  session.round++;
  session.turn = oppKeys.id;
  if (session[selfKeys.skillCdKey] > 0) session[selfKeys.skillCdKey]--;
  if (session[selfKeys.reverseCdKey] > 0) session[selfKeys.reverseCdKey]--;

  const embed = pvpEmbed(session, log);
  const buttons = mkPvpButtons(session, oppKeys.id);
  await interaction.update({ embeds:[embed], components:[buttons] });
}

// ════════════════════════════════════════════════════════
// ── 파티 컬링 핸들러
// ════════════════════════════════════════════════════════
async function handlePartyCullingAction(interaction, player, session, action) {
  const party = getParty(player.id);
  if (!party) return;
  const enemy = session.currentEnemy;
  const log = [];

  if (action === "pc_escape") {
    delete cullings[party.id];
    return interaction.update({ content:"🏳️ 파티 컬링 종료!", embeds:[], components:[] });
  }

  if (isIncapacitated(player.statusEffects)) return interaction.reply({ content:"❌ 상태이상!", ephemeral:true });
  const hit = rollHit(player.statusEffects, enemy.statusEffects);
  let dmg = 0;

  if (!hit) { log.push(`⚡ **${player.name}**의 공격이 빗나갔다!`); }
  else if (action === "pc_skill") {
    if (player.skillCooldown > 0) return interaction.reply({ content:"❌ 술식 쿨다운!", ephemeral:true });
    const skill = getCurrentSkill(player, player.active);
    dmg = calcSkillDmgForPlayer(player, skill.dmg);
    const isBlack = isBlackFlash();
    if (isBlack) { dmg = Math.floor(dmg*2.5); log.push(`⚫ **${player.name}** 흑섬! **${dmg}** 피해!`); }
    else { log.push(`> 🌀 **${player.name}**: ${skill.name} — **${dmg}** 피해!`); }
    player.skillCooldown = 5;
  } else {
    dmg = calcDmgForPlayer(player, enemy.def);
    const isBlack = isBlackFlash();
    if (isBlack) { dmg = Math.floor(dmg*2.5); log.push(`⚫ **${player.name}** 흑섬! **${dmg}** 피해!`); }
    else { log.push(`> ⚔️ **${player.name}** 공격! **${dmg}** 피해!`); }
  }
  session.enemyHp = Math.max(0, session.enemyHp - dmg);

  if (session.enemyHp <= 0) {
    session.totalXp += enemy.xp; session.totalCrystals += enemy.crystals; session.kills++;
    for (const uid of party.members) {
      const p = players[uid]; if (!p) continue;
      p.xp += Math.floor(enemy.xp/party.members.length);
      p.crystals += Math.floor(enemy.crystals/party.members.length);
      const drops = rollDrops(enemy.id);
      addMaterials(p, drops);
      updateQuestProgress(p, "battle_win", 1);
      savePlayer(uid);
    }
    session.wave++;
    updateQuestProgress(player, "culling_wave", 1);
    if (session.wave > (player.cullingBest||0)) player.cullingBest = session.wave;
    const next = pickCullingEnemy(session.wave);
    session.currentEnemy = next; session.enemyHp = next.hp;
    log.push(`> ✅ 처치! WAVE **${session.wave}** — **${next.name}** 등장!`);
  } else {
    // 파티원들에게 적 피해
    const tgt = party.members[Math.floor(Math.random()*party.members.length)];
    const p2 = players[tgt]; if (p2) {
      const eDmg = calcDmg(enemy.atk, getPlayerStats(p2).def);
      p2.hp = Math.max(0, p2.hp - eDmg);
      log.push(`> 💢 **${enemy.name}** → **${p2.name}** **${eDmg}** 피해!`);
      if (p2.hp <= 0) log.push(`> 💀 **${p2.name}** 전투 불능!`);
    }
    // 전원 사망 체크
    if (party.members.every(uid => (players[uid]?.hp||0) <= 0)) {
      delete cullings[party.id];
      return interaction.update({ content:"💀 파티 전원 쓰러짐! 컬링 종료!", embeds:[], components:[] });
    }
  }
  tickCooldowns(player); savePlayer(player.id);
  const embed = partyCullingEmbed(party, session, log);
  return interaction.update({ embeds:[embed], components:[mkCullingButtons(player)] });
}

// ════════════════════════════════════════════════════════
// ── Discord 준비 & 슬래시 커맨드 등록
// ════════════════════════════════════════════════════════
client.once("ready", async () => {
  console.log(`✅ 로그인: ${client.user.tag}`);
  await dbInit();
  players = await dbLoad();
  console.log("🚀 주술회전 RPG 봇 활성화");

  const commands = [
    {name:"프로필",description:"내 프로필 확인"},
    {name:"전투",description:"일반 전투 시작"},
    {name:"술식",description:"현재 캐릭터 술식 확인"},
    {name:"가챠",description:"캐릭터 뽑기",options:[{name:"횟수",type:4,description:"1 또는 10",required:true}]},
    {name:"활성",description:"활성 캐릭터 변경",options:[{name:"캐릭터",type:3,description:"캐릭터 ID",required:true}]},
    {name:"출석",description:"매일 출석 체크"},
    {name:"회복",description:"회복약 사용"},
    {name:"코가네가챠",description:"코가네 펫 뽑기 (200💎)"},
    {name:"코가네",description:"코가네 펫 정보"},
    {name:"손가락",description:"스쿠나 손가락 현황"},
    {name:"컬링",description:"컬링 게임 시작"},
    {name:"사멸회유",description:"사멸회유 게임 시작"},
    {name:"결투",description:"PvP 결투 신청",options:[{name:"대상",type:6,description:"결투할 대상",required:true}]},
    {name:"파티생성",description:"파티 생성"},
    {name:"파티초대",description:"파티 초대",options:[{name:"대상",type:6,description:"초대할 대상",required:true}]},
    {name:"파티나가기",description:"파티 탈퇴"},
    {name:"파티컬링",description:"파티 컬링 시작"},
    {name:"코드",description:"쿠폰 코드 사용",options:[{name:"코드",type:3,description:"쿠폰 코드",required:true}]},
    {name:"퀘스트",description:"퀘스트 현황 확인"},
    {name:"재료",description:"재료 인벤토리 확인"},
    {name:"주구목록",description:"주구(무기) 목록 및 제작 현황"},
    {name:"주구제작",description:"주구 제작",options:[{name:"이름",type:3,description:"무기 ID",required:true}]},
    {name:"장착",description:"주구 장착",options:[{name:"이름",type:3,description:"무기 ID",required:true}]},
    {name:"해제",description:"주구 해제"},
    {name:"도움말",description:"명령어 목록"},
  ];
  await client.application.commands.set(commands);
  console.log("✅ 슬래시 커맨드 등록 완료");
});

// ════════════════════════════════════════════════════════
// ── 인터랙션 핸들러
// ════════════════════════════════════════════════════════
client.on("interactionCreate", async (interaction) => {
  if (interaction.isButton()) {
    const { customId, user } = interaction;
    const userId = user.id;
    const player = getPlayer(userId, user.username);

    if (customId.startsWith("b_")) {
      const battle = battles[userId];
      if (!battle) return interaction.reply({ content:"❌ 진행 중인 전투 없음", ephemeral:true });
      return handleBattleAction(interaction, player, battle, customId);
    }
    if (customId.startsWith("c_")) {
      const culling = cullings[userId];
      if (!culling) return interaction.reply({ content:"❌ 진행 중인 컬링 없음", ephemeral:true });
      return handleCullingAction(interaction, player, culling, customId);
    }
    if (customId.startsWith("j_")) {
      const jujutsu = jujutsus[userId];
      if (!jujutsu) return interaction.reply({ content:"❌ 진행 중인 사멸회유 없음", ephemeral:true });
      if (customId === "j_escape") { delete jujutsus[userId]; return interaction.update({ content:"🏳 사멸회유 종료", embeds:[], components:[] }); }
      if (customId.startsWith("j_choice_")) {
        const idx = parseInt(customId.split("_")[2]);
        if (jujutsu.choices?.[idx]) {
          jujutsu.currentEnemy = JSON.parse(JSON.stringify(jujutsu.choices[idx]));
          jujutsu.enemyHp = jujutsu.currentEnemy.hp;
          jujutsu.choices = null;
          return interaction.update({ embeds:[jujutsuEmbed(player,jujutsu)], components:[mkJujutsuButtons(player,[])[1]] });
        }
        return interaction.reply({ content:"❌ 잘못된 선택", ephemeral:true });
      }
      return handleJujutsuAction(interaction, player, jujutsu, customId);
    }
    if (customId.startsWith("p_")) {
      const session = getPvpSessionByUser(userId);
      if (!session) return interaction.reply({ content:"❌ 진행 중인 PvP 없음", ephemeral:true });
      if (session.turn !== userId) return interaction.reply({ content:"⏳ 당신의 턴이 아닙니다!", ephemeral:true });
      return handlePvpAction(interaction, player, session, customId);
    }
    if (customId.startsWith("pc_")) {
      const party = getParty(userId);
      if (!party) return interaction.reply({ content:"❌ 파티 없음", ephemeral:true });
      const session = cullings[party.id];
      if (!session) return interaction.reply({ content:"❌ 진행 중인 파티 컬링 없음", ephemeral:true });
      if (player.hp <= 0) return interaction.reply({ content:"💀 전투 불능 상태!", ephemeral:true });
      return handlePartyCullingAction(interaction, player, session, customId);
    }
    if (customId.startsWith("party_invite_")) {
      const parts = customId.split("_");
      const partyId = parts[3], targetId = parts[4];
      if (user.id !== targetId) return interaction.reply({ content:"❌ 당신을 위한 초대가 아닙니다.", ephemeral:true });
      const invite = partyInvites[targetId];
      if (!invite || invite.partyId !== partyId) return interaction.reply({ content:"❌ 만료된 초대", ephemeral:true });
      if (customId.includes("accept")) {
        const party = parties[partyId];
        if (!party) return interaction.reply({ content:"❌ 파티가 해체됨", ephemeral:true });
        if (party.members.length >= 4) return interaction.reply({ content:"❌ 파티 가득참", ephemeral:true });
        if (getPartyId(targetId)) return interaction.reply({ content:"❌ 이미 파티에 소속됨", ephemeral:true });
        party.members.push(targetId); delete partyInvites[targetId];
        return interaction.update({ content:`✅ 파티 참가! (${party.members.length}/4)`, embeds:[], components:[] });
      } else {
        delete partyInvites[targetId];
        return interaction.update({ content:"❌ 초대 거절", embeds:[], components:[] });
      }
    }
    if (customId.startsWith("pvp_challenge_")) {
      const parts = customId.split("_");
      const action = parts[3], challengerId = parts[4];
      if (action === "accept") {
        const challenge = pvpChallenges[challengerId];
        if (!challenge || challenge.target !== user.id) return interaction.reply({ content:"❌ 유효하지 않은 도전", ephemeral:true });
        if (getPvpSessionByUser(user.id)||getPvpSessionByUser(challengerId)) return interaction.reply({ content:"❌ 이미 PvP 중", ephemeral:true });
        const p1=players[challengerId], p2=players[user.id];
        const s1=getPlayerStats(p1), s2=getPlayerStats(p2);
        const sessionId = `${_pvpIdSeq++}`;
        pvpSessions[sessionId] = { id:sessionId,p1Id:challengerId,p2Id:user.id, hp1:s1.maxHp,hp2:s2.maxHp, status1:[],status2:[], skillCd1:0,skillCd2:0, reverseCd1:0,reverseCd2:0, domainUsed1:false,domainUsed2:false, turn:challengerId,round:1 };
        delete pvpChallenges[challengerId];
        return interaction.update({ embeds:[pvpEmbed(pvpSessions[sessionId])], components:[mkPvpButtons(pvpSessions[sessionId],challengerId)] });
      } else {
        delete pvpChallenges[challengerId];
        return interaction.update({ content:"❌ 결투 거절", embeds:[], components:[] });
      }
    }
  }

  if (interaction.isChatInputCommand()) {
    const { commandName, user } = interaction;
    const userId = user.id;
    const player = getPlayer(userId, user.username);
    await handleCommand(interaction, commandName, player, userId, user);
  }
});

// ════════════════════════════════════════════════════════
// ── 슬래시 명령 처리
// ════════════════════════════════════════════════════════
async function handleCommand(interaction, commandName, player, userId, user) {
  if (commandName === "프로필") return interaction.reply({ embeds:[profileEmbed(player)] });

  if (commandName === "전투") {
    if (battles[userId]) return interaction.reply({ content:"❌ 이미 전투 중!", ephemeral:true });
    const eBase = ENEMIES[Math.floor(Math.random()*3)];
    const enemy = { ...eBase, currentHp:eBase.hp, statusEffects:[] };
    battles[userId] = { enemy };
    const stats = getPlayerStats(player);
    const embed = new EmbedBuilder().setTitle("⚔️ 전투 시작!").setColor(0xff0000)
      .setDescription(`**${enemy.emoji} ${enemy.name}** 이(가) 나타났다!\n\n${hpBar(player.hp,stats.maxHp)} \`${player.hp}/${stats.maxHp}\``)
      .addFields({name:"적 정보",value:`💚 HP: ${enemy.hp} | 🗡️ ATK: ${enemy.atk} | 🛡️ DEF: ${enemy.def}`,inline:false});
    return interaction.reply({ embeds:[embed], components:[mkBattleButtons(player)] });
  }

  if (commandName === "술식") return interaction.reply({ embeds:[buildSkillEmbed(player)] });

  if (commandName === "가챠") {
    const count = interaction.options.getInteger("횟수");
    if (count!==1&&count!==10) return interaction.reply({ content:"❌ 1회 또는 10회만 가능!", ephemeral:true });
    const cost = count===1?150:1350;
    if (player.crystals < cost) return interaction.reply({ content:`💎 크리스탈 부족! (필요: ${cost})`, ephemeral:true });
    player.crystals -= cost;
    updateQuestProgress(player, "gacha_pull", 1);
    await interaction.reply({ embeds:[gachaLoadingEmbed(1)] });
    await new Promise(r=>setTimeout(r,2000));
    await interaction.editReply({ embeds:[gachaLoadingEmbed(2)] });
    await new Promise(r=>setTimeout(r,2000));
    if (count===1) {
      const result = rollGacha(1)[0];
      const isNew = !player.owned.includes(result);
      if (isNew) player.owned.push(result); else player.crystals+=50;
      await interaction.editReply({ embeds:[gachaRevealEmbed(CHARACTERS[result].grade), gachaResultEmbed(result,isNew,player)] });
    } else {
      const results = rollGacha(10);
      const dupCrystals = results.filter(id=>player.owned.includes(id)).length*50;
      const newOnes = results.filter(id=>!player.owned.includes(id));
      for (const id of newOnes) player.owned.push(id);
      player.crystals += dupCrystals;
      await interaction.editReply({ embeds:[gacha10ResultEmbed(results,newOnes,dupCrystals,player)] });
    }
    savePlayer(userId);
  }

  if (commandName === "활성") {
    const charId = interaction.options.getString("캐릭터").toLowerCase();
    if (!player.owned.includes(charId)) return interaction.reply({ content:"❌ 미보유 캐릭터!", ephemeral:true });
    player.active = charId;
    const stats = getPlayerStats(player); player.hp = stats.maxHp;
    await interaction.reply({ content:`✅ **${CHARACTERS[charId].name}** 으로 변경! HP 회복됨.` });
    savePlayer(userId);
  }

  if (commandName === "출석") {
    const now = Date.now();
    if (now - (player.lastDaily||0) < 86400000) {
      const remaining = Math.ceil((86400000-(now-player.lastDaily))/3600000);
      return interaction.reply({ content:`⏰ ${remaining}시간 후 가능`, ephemeral:true });
    }
    const streakBonus = Math.min(player.dailyStreak||0,30);
    const totalCrystals = 100 + streakBonus*5;
    player.crystals += totalCrystals; player.lastDaily = now;
    player.dailyStreak = (player.dailyStreak||0)+1;
    await interaction.reply({ content:`✅ 출석 체크! +${totalCrystals}💎 (연속 ${player.dailyStreak}일)` });
    savePlayer(userId);
  }

  if (commandName === "회복") {
    if (player.potion<=0) return interaction.reply({ content:"❌ 회복약 없음!", ephemeral:true });
    const stats = getPlayerStats(player); player.hp = stats.maxHp; player.potion--;
    await interaction.reply({ content:`✅ HP 완전 회복! (남은 회복약: ${player.potion}개)` });
    savePlayer(userId);
  }

  if (commandName === "코가네가챠") {
    if (player.crystals<200) return interaction.reply({ content:"💎 부족! (필요: 200)", ephemeral:true });
    player.crystals-=200; player.koganeGachaCount=(player.koganeGachaCount||0)+1;
    const grade = rollKogane();
    const gradeOrder=["3급","2급","1급","특급","전설"];
    const isUpgrade = !player.kogane||gradeOrder.indexOf(grade)>gradeOrder.indexOf(player.kogane.grade);
    if (isUpgrade) player.kogane={grade}; else player.crystals+=50;
    await interaction.reply({ content:`🐾 **코가네 [${grade}]** ${isUpgrade?"(등급 상승!)":"(중복 +50💎)"}\n${KOGANE_GRADES[grade].passiveDesc}` });
    savePlayer(userId);
  }

  if (commandName === "코가네") return interaction.reply({ embeds:[koganeProfileEmbed(player)] });

  if (commandName === "손가락") {
    const fingers = player.sukunaFingers||0;
    const bonus = getFingerBonus(fingers);
    const embed = new EmbedBuilder().setTitle("👹 스쿠나 손가락").setColor(0x8b0000)
      .setDescription([
        "```",`╔══════════════════════════════╗`,
        `║  🖕  ${"█".repeat(fingers)}${"░".repeat(SUKUNA_FINGER_MAX-fingers)}  ║`,
        `║  ${fingers} / ${SUKUNA_FINGER_MAX}  ║`,`╚══════════════════════════════╝`,"```",
        `> **${bonus.label}**`,`> ATK +${bonus.atkBonus} | DEF +${bonus.defBonus} | HP +${bonus.hpBonus}`,
      ].join("\n"));
    return interaction.reply({ embeds:[embed] });
  }

  if (commandName === "컬링") {
    if (cullings[userId]) return interaction.reply({ content:"🌊 이미 컬링 중!", ephemeral:true });
    const firstEnemy = pickCullingEnemy(1);
    cullings[userId] = { wave:1,kills:0,totalXp:0,totalCrystals:0, currentEnemy:firstEnemy,enemyHp:firstEnemy.hp };
    return interaction.reply({ embeds:[cullingEmbed(player,cullings[userId])], components:[mkCullingButtons(player)] });
  }

  if (commandName === "사멸회유") {
    if (jujutsus[userId]) return interaction.reply({ content:"🎯 이미 사멸회유 중!", ephemeral:true });
    const choices = generateJujutsuChoices(1);
    jujutsus[userId] = { wave:1,points:0,totalXp:0,totalCrystals:0, choices,currentEnemy:null,enemyHp:0 };
    return interaction.reply({ embeds:[jujutsuEmbed(player,jujutsus[userId],[],choices)], components:mkJujutsuButtons(player,choices) });
  }

  if (commandName === "결투") {
    const target = interaction.options.getUser("대상");
    if (target.id===userId) return interaction.reply({ content:"❌ 자신과 결투 불가!", ephemeral:true });
    if (getPvpSessionByUser(userId)||getPvpSessionByUser(target.id)) return interaction.reply({ content:"❌ 이미 PvP 중!", ephemeral:true });
    pvpChallenges[userId] = { target:target.id };
    const embed = new EmbedBuilder().setTitle("⚔️ PvP 결투 신청").setColor(0xF5C842)
      .setDescription(`${target}님, **${user.username}**님이 결투를 신청했습니다!`).setFooter({text:"30초 내 수락/거절"});
    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`pvp_challenge_accept_${userId}`).setLabel("✅ 수락").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`pvp_challenge_decline_${userId}`).setLabel("❌ 거절").setStyle(ButtonStyle.Danger),
    );
    await interaction.reply({ content:`${target}`, embeds:[embed], components:[buttons] });
    setTimeout(()=>{ if(pvpChallenges[userId]) delete pvpChallenges[userId]; },30000);
  }

  if (commandName === "파티생성") {
    if (getPartyId(userId)) return interaction.reply({ content:"❌ 이미 파티 소속!", ephemeral:true });
    const partyId = `${_partyIdSeq++}`;
    parties[partyId] = { id:partyId,leader:userId,members:[userId],bestWave:0 };
    return interaction.reply({ content:`✅ 파티 생성! ID: ${partyId}` });
  }

  if (commandName === "파티초대") {
    const target = interaction.options.getUser("대상");
    const party = getParty(userId);
    if (!party) return interaction.reply({ content:"❌ 파티 없음!", ephemeral:true });
    if (party.leader!==userId) return interaction.reply({ content:"❌ 파티장만 초대 가능!", ephemeral:true });
    if (party.members.length>=4) return interaction.reply({ content:"❌ 파티 가득참!", ephemeral:true });
    if (getPartyId(target.id)) return interaction.reply({ content:"❌ 이미 다른 파티 소속!", ephemeral:true });
    partyInvites[target.id] = { partyId:party.id,inviter:userId };
    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`party_invite_accept_${party.id}_${target.id}`).setLabel("✅ 수락").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`party_invite_decline_${party.id}_${target.id}`).setLabel("❌ 거절").setStyle(ButtonStyle.Danger),
    );
    await interaction.reply({ content:`${target}`, embeds:[new EmbedBuilder().setTitle("👥 파티 초대").setColor(0x4ade80).setDescription(`${target}님, 파티에 초대했습니다!`)], components:[buttons] });
    setTimeout(()=>{ if(partyInvites[target.id]) delete partyInvites[target.id]; },60000);
  }

  if (commandName === "파티나가기") {
    const party = getParty(userId);
    if (!party) return interaction.reply({ content:"❌ 파티 없음!", ephemeral:true });
    const isLeader = party.leader===userId;
    party.members = party.members.filter(id=>id!==userId);
    if (party.members.length===0) { delete parties[party.id]; return interaction.reply({ content:"✅ 파티 탈퇴 (파티 해체)" }); }
    if (isLeader) party.leader = party.members[0];
    return interaction.reply({ content:`✅ 파티 탈퇴` });
  }

  if (commandName === "파티컬링") {
    const party = getParty(userId);
    if (!party) return interaction.reply({ content:"❌ 파티 없음!", ephemeral:true });
    if (party.leader!==userId) return interaction.reply({ content:"❌ 파티장만 시작!", ephemeral:true });
    if (cullings[party.id]) return interaction.reply({ content:"🌊 이미 파티 컬링 중!", ephemeral:true });
    const firstEnemy = pickCullingEnemy(1);
    cullings[party.id] = { wave:1,kills:0,totalXp:0,totalCrystals:0, currentEnemy:firstEnemy,enemyHp:firstEnemy.hp };
    return interaction.reply({ embeds:[partyCullingEmbed(party,cullings[party.id])], components:[mkCullingButtons(player)] });
  }

  if (commandName === "코드") {
    const code = interaction.options.getString("코드").toLowerCase();
    if (player.usedCodes.includes(code)) return interaction.reply({ content:"❌ 이미 사용한 코드!", ephemeral:true });
    if (CODES[code]) {
      player.crystals += CODES[code].crystals||0;
      player.usedCodes.push(code);
      await interaction.reply({ content:`✅ 코드 사용! +${CODES[code].crystals||0}💎` });
      savePlayer(userId);
    } else return interaction.reply({ content:"❌ 유효하지 않은 코드!", ephemeral:true });
  }

  if (commandName === "퀘스트") return interaction.reply({ embeds:[questEmbed(player)] });
  if (commandName === "재료") return interaction.reply({ embeds:[materialsEmbed(player)] });
  if (commandName === "주구목록") return interaction.reply({ embeds:[weaponListEmbed(player)] });

  if (commandName === "주구제작") {
    const weaponId = interaction.options.getString("이름").toLowerCase().replace(/ /g,"_");
    const w = WEAPONS[weaponId];
    if (!w) return interaction.reply({ content:`❌ 존재하지 않는 주구: ${weaponId}\n가능: ${Object.keys(WEAPONS).join(", ")}`, ephemeral:true });
    if ((player.craftedWeapons||[]).includes(weaponId)) return interaction.reply({ content:"❌ 이미 제작한 주구입니다!", ephemeral:true });
    const mats = player.materials||{};
    for (const [mat,qty] of Object.entries(w.recipe)) {
      if ((mats[mat]||0) < qty) {
        const m = MATERIALS[mat];
        return interaction.reply({ content:`❌ 재료 부족! ${m.emoji}**${m.name}** ${mats[mat]||0}/${qty}`, ephemeral:true });
      }
    }
    // 재료 차감
    for (const [mat,qty] of Object.entries(w.recipe)) mats[mat] -= qty;
    if (!player.craftedWeapons) player.craftedWeapons = [];
    player.craftedWeapons.push(weaponId);
    updateQuestProgress(player, "weapon_craft", 1);
    savePlayer(userId);
    const embed = new EmbedBuilder().setTitle(`${w.emoji} ${w.name} 제작 완료!`).setColor(w.color)
      .setDescription([`> **등급:** ${w.grade}`,`> 🗡️ ATK+${w.atkBonus} 🛡️ DEF+${w.defBonus} 💚 HP+${w.hpBonus}`,`> ${w.desc}`,`\n> \`!장착 ${weaponId}\` 으로 장착하세요!`].join("\n"));
    return interaction.reply({ embeds:[embed] });
  }

  if (commandName === "장착") {
    const weaponId = interaction.options.getString("이름").toLowerCase().replace(/ /g,"_");
    if (!(player.craftedWeapons||[]).includes(weaponId)) return interaction.reply({ content:"❌ 제작하지 않은 주구!", ephemeral:true });
    player.equippedWeapon = weaponId;
    const w = WEAPONS[weaponId];
    savePlayer(userId);
    return interaction.reply({ content:`✅ **${w.emoji} ${w.name}** 장착! ATK+${w.atkBonus} DEF+${w.defBonus} HP+${w.hpBonus}` });
  }

  if (commandName === "해제") {
    if (!player.equippedWeapon) return interaction.reply({ content:"❌ 장착된 주구 없음!", ephemeral:true });
    const w = WEAPONS[player.equippedWeapon];
    player.equippedWeapon = null;
    savePlayer(userId);
    return interaction.reply({ content:`✅ **${w?.name||"주구"}** 해제됨.` });
  }

  if (commandName === "도움말") {
    const embed = new EmbedBuilder().setTitle("🔱 주술회전 RPG 봇 명령어").setColor(0xF5C842)
      .setDescription([
        "**⚔️ 전투**","`!전투` `/전투` 일반 전투","`!컬링` `/컬링` 웨이브 컬링","`!사멸회유` 포인트 수집","`!결투 @유저` PvP",
        "","**👥 파티**","`!파티생성` `/파티초대 @유저` `/파티나가기` `/파티컬링`",
        "","**🎲 가챠**","`!가챠` `!가챠10` 캐릭터 소환 (150💎/1350💎)","`!코가네가챠` 펫 소환 (200💎)",
        "","**⚔️ 주구 시스템**","`!재료` 재료 인벤토리","`!주구목록` 주구 목록","`!주구제작 [ID]` 주구 제작","`!장착 [ID]` 장착 | `!해제` 해제",
        "","**📋 퀘스트**","`!퀘스트` 퀘스트 확인","`!퀘보상 일 [번호]` 일일 보상 수령","`!퀘보상 주 [번호]` 주간 보상 수령",
        "","**🛠️ 기타**","`!프로필` `/출석` `/회복` `/손가락` `/코드 [코드]`",
      ].join("\n")).setFooter({text:"흑섬 확률 10% | 재료 드롭 | 주구 제작으로 스탯 강화!"});
    return interaction.reply({ embeds:[embed] });
  }
}

// ════════════════════════════════════════════════════════
// ── 술식 임베드 (보조)
// ════════════════════════════════════════════════════════
function buildSkillEmbed(player) {
  const id = player.active;
  const ch = CHARACTERS[id];
  const mastery = getMastery(player, id);
  const awakened = isMakiAwakened(player);
  const fingers = player.sukunaFingers||0;
  const mainSkill = getMainSkill(player, id);
  return new EmbedBuilder()
    .setTitle(`${ch.emoji} ≪ 술식 트리 ≫ ${ch.name}${awakened?"  🔥[각성]":""}`)
    .setColor(awakened?0xFF2200:JJK_GRADE_COLOR[ch.grade])
    .setDescription([
      `> ${ch.lore||ch.desc}`,
      `> 📈 **숙련도** ${masteryBar(mastery,id)}`,
      `> 🌌 **영역전개** \`${ch.domain||"없음"}\``,
      id==="itadori"?`> 👹 **스쿠나 손가락** \`${fingers}/${SUKUNA_FINGER_MAX}\` — ${getFingerBonus(fingers).label}`:"",
      awakened?`> 🔥 **천여주박 각성 중** — 모든 데미지 **2배**!`:"",
      mainSkill?`> ⭐ **주력 스킬:** ${mainSkill.name} (획득 완료!)`:(id==="gojo"?`> ⭐ **주력 스킬:** 자폭 무라사키 (❌ 미획득 - 20승 필요)`:id==="sukuna"?`> ⭐ **주력 스킬:** 세계참 (❌ 미획득 - 손가락 10개 필요)`:""),
    ].filter(Boolean).join("\n"))
    .addFields(ch.skills.map((s,idx) => {
      const unlocked = mastery>=s.minMastery;
      const fingerLock = s.name==="스쿠나 발현"&&fingers<10;
      const available = unlocked&&!fingerLock;
      const fx = getSkillEffect(s.name);
      const statusNote = s.statusApply?` \`${STATUS_EFFECTS[s.statusApply.statusId]?.emoji}${STATUS_EFFECTS[s.statusApply.statusId]?.name} ${Math.round(s.statusApply.chance*100)}%\``:"";
      return {
        name:`${available?"✅":"🔒"} [${idx+1}] ${s.name}  —  피해 **${s.dmg}**${statusNote}  (숙련 ${s.minMastery})`,
        value:[`> ${s.desc}`, available?`> ${fx.art}`:"> 🔒 잠김", available?`> *${fx.flavorText}*`:""].filter(Boolean).join("\n"),
        inline:false,
      };
    }))
    .setFooter({text:"흑섬 10% 확률로 발동! | 전투 승리 시 숙련도 상승"});
}

// ════════════════════════════════════════════════════════
// ── ! 명령어 핸들러
// ════════════════════════════════════════════════════════
client.on("messageCreate", async (message) => {
  if (message.author.bot||!message.content.startsWith("!")) return;
  const args = message.content.slice(1).trim().split(/\s+/);
  const cmd  = args[0].toLowerCase();
  const userId = message.author.id;
  const player = getPlayer(userId, message.author.username);

  if (cmd === "프로필") return message.reply({ embeds:[profileEmbed(player)] });

  if (cmd === "전투") {
    if (battles[userId]) return message.reply("❌ 이미 전투 중!");
    const eBase = ENEMIES[Math.floor(Math.random()*3)];
    const enemy = { ...eBase, currentHp:eBase.hp, statusEffects:[] };
    battles[userId] = { enemy };
    const stats = getPlayerStats(player);
    const embed = new EmbedBuilder().setTitle("⚔️ 전투 시작!").setColor(0xff0000)
      .setDescription(`**${enemy.emoji} ${enemy.name}** 등장!\n내 HP: ${player.hp}/${stats.maxHp}`)
      .addFields({name:"적 정보",value:`💚 HP: ${enemy.hp} | 🗡️ ATK: ${enemy.atk} | 🛡️ DEF: ${enemy.def}`});
    return message.reply({ embeds:[embed], components:[mkBattleButtons(player)] });
  }

  if (cmd === "술식") return message.reply({ embeds:[buildSkillEmbed(player)] });

  if (cmd === "가챠"||cmd==="가챠10") {
    const count = cmd==="가챠10"?10:parseInt(args[1])||1;
    if (count!==1&&count!==10) return message.reply("❌ 1회 또는 10회만 가능!");
    const cost = count===1?150:1350;
    if (player.crystals<cost) return message.reply(`💎 부족! (필요: ${cost})`);
    player.crystals-=cost;
    updateQuestProgress(player, "gacha_pull", 1);
    const loadingMsg = await message.reply({ embeds:[gachaLoadingEmbed(1)] });
    await new Promise(r=>setTimeout(r,1500));
    await loadingMsg.edit({ embeds:[gachaLoadingEmbed(2)] });
    await new Promise(r=>setTimeout(r,1500));
    if (count===1) {
      const result = rollGacha(1)[0];
      const isNew = !player.owned.includes(result);
      if (isNew) player.owned.push(result); else player.crystals+=50;
      await loadingMsg.edit({ embeds:[gachaRevealEmbed(CHARACTERS[result].grade), gachaResultEmbed(result,isNew,player)] });
    } else {
      const results = rollGacha(10);
      const dupCrystals = results.filter(id=>player.owned.includes(id)).length*50;
      const newOnes = results.filter(id=>!player.owned.includes(id));
      for (const id of newOnes) player.owned.push(id);
      player.crystals+=dupCrystals;
      await loadingMsg.edit({ embeds:[gacha10ResultEmbed(results,newOnes,dupCrystals,player)] });
    }
    savePlayer(userId);
    return;
  }

  if (cmd === "활성") {
    const charId = args[1]?.toLowerCase();
    if (!charId) return message.reply(`!활성 [캐릭터ID]\n가능: ${Object.keys(CHARACTERS).join(", ")}`);
    if (!CHARACTERS[charId]) return message.reply(`❌ 존재하지 않는 캐릭터: ${charId}`);
    if (!player.owned.includes(charId)) return message.reply("❌ 미보유 캐릭터!");
    player.active = charId;
    const stats = getPlayerStats(player); player.hp = stats.maxHp;
    await message.reply(`✅ **${CHARACTERS[charId].name}** 으로 변경! HP 회복됨.`);
    savePlayer(userId); return;
  }

  if (cmd === "출석") {
    const now = Date.now();
    if (now-(player.lastDaily||0)<86400000) { const h=Math.ceil((86400000-(now-player.lastDaily))/3600000); return message.reply(`⏰ ${h}시간 후 가능`); }
    const streak = Math.min(player.dailyStreak||0,30);
    const cr = 100+streak*5;
    player.crystals+=cr; player.lastDaily=now; player.dailyStreak=(player.dailyStreak||0)+1;
    await message.reply(`✅ 출석! +${cr}💎 (연속 ${player.dailyStreak}일)`);
    savePlayer(userId); return;
  }

  if (cmd === "회복") {
    if (player.potion<=0) return message.reply("❌ 회복약 없음!");
    const stats = getPlayerStats(player); player.hp=stats.maxHp; player.potion--;
    await message.reply(`✅ HP 완전 회복! (남은: ${player.potion}개)`);
    savePlayer(userId); return;
  }

  if (cmd === "코가네가챠") {
    if (player.crystals<200) return message.reply("💎 부족! (필요: 200)");
    player.crystals-=200; player.koganeGachaCount=(player.koganeGachaCount||0)+1;
    const grade = rollKogane();
    const gradeOrder=["3급","2급","1급","특급","전설"];
    const isUpgrade = !player.kogane||gradeOrder.indexOf(grade)>gradeOrder.indexOf(player.kogane.grade);
    if (isUpgrade) player.kogane={grade}; else player.crystals+=50;
    await message.reply(`🐾 **코가네 [${grade}]** ${isUpgrade?"(등급 상승!)":" (중복 +50💎)"}\n${KOGANE_GRADES[grade].passiveDesc}`);
    savePlayer(userId); return;
  }

  if (cmd === "코가네") return message.reply({ embeds:[koganeProfileEmbed(player)] });

  if (cmd === "손가락") {
    const fingers=player.sukunaFingers||0; const bonus=getFingerBonus(fingers);
    await message.reply(`👹 **스쿠나 손가락**: ${fingers}/${SUKUNA_FINGER_MAX}\n${bonus.label}\nATK+${bonus.atkBonus} | DEF+${bonus.defBonus} | HP+${bonus.hpBonus}`);
    return;
  }

  if (cmd === "컬링") {
    if (cullings[userId]) return message.reply("🌊 이미 컬링 중!");
    const firstEnemy = pickCullingEnemy(1);
    cullings[userId] = { wave:1,kills:0,totalXp:0,totalCrystals:0, currentEnemy:firstEnemy,enemyHp:firstEnemy.hp };
    return message.reply({ embeds:[cullingEmbed(player,cullings[userId])], components:[mkCullingButtons(player)] });
  }

  if (cmd === "사멸회유") {
    if (jujutsus[userId]) return message.reply("🎯 이미 사멸회유 중!");
    const choices = generateJujutsuChoices(1);
    jujutsus[userId] = { wave:1,points:0,totalXp:0,totalCrystals:0, choices,currentEnemy:null,enemyHp:0 };
    return message.reply({ embeds:[jujutsuEmbed(player,jujutsus[userId],[],choices)], components:mkJujutsuButtons(player,choices) });
  }

  if (cmd === "결투") {
    const target = message.mentions.users.first();
    if (!target) return message.reply("❌ !결투 @유저");
    if (target.id===userId) return message.reply("❌ 자신과 결투 불가!");
    if (getPvpSessionByUser(userId)||getPvpSessionByUser(target.id)) return message.reply("❌ 이미 PvP 중!");
    pvpChallenges[userId]={target:target.id};
    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`pvp_challenge_accept_${userId}`).setLabel("✅ 수락").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`pvp_challenge_decline_${userId}`).setLabel("❌ 거절").setStyle(ButtonStyle.Danger),
    );
    await message.reply({ content:`${target}`, embeds:[new EmbedBuilder().setTitle("⚔️ PvP 결투 신청").setColor(0xF5C842).setDescription(`**${message.author.username}** 의 도전!`).setFooter({text:"30초 내 수락/거절"})], components:[buttons] });
    setTimeout(()=>{ if(pvpChallenges[userId]) delete pvpChallenges[userId]; },30000);
    return;
  }

  if (cmd === "파티생성") {
    if (getPartyId(userId)) return message.reply("❌ 이미 파티 소속!");
    const partyId=`${_partyIdSeq++}`;
    parties[partyId]={id:partyId,leader:userId,members:[userId],bestWave:0};
    return message.reply(`✅ 파티 생성! ID: ${partyId}`);
  }

  if (cmd === "파티초대") {
    const target = message.mentions.users.first();
    if (!target) return message.reply("❌ !파티초대 @유저");
    const party = getParty(userId);
    if (!party) return message.reply("❌ 파티 없음!");
    if (party.leader!==userId) return message.reply("❌ 파티장만 초대!");
    if (party.members.length>=4) return message.reply("❌ 파티 가득참!");
    if (getPartyId(target.id)) return message.reply("❌ 이미 다른 파티 소속!");
    partyInvites[target.id]={partyId:party.id,inviter:userId};
    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`party_invite_accept_${party.id}_${target.id}`).setLabel("✅ 수락").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`party_invite_decline_${party.id}_${target.id}`).setLabel("❌ 거절").setStyle(ButtonStyle.Danger),
    );
    await message.reply({ content:`${target}`, embeds:[new EmbedBuilder().setTitle("👥 파티 초대").setColor(0x4ade80).setDescription(`**${message.author.username}** 의 초대!`)], components:[buttons] });
    setTimeout(()=>{ if(partyInvites[target.id]) delete partyInvites[target.id]; },60000);
    return;
  }

  if (cmd === "파티나가기") {
    const party = getParty(userId);
    if (!party) return message.reply("❌ 파티 없음!");
    const isLeader=party.leader===userId;
    party.members=party.members.filter(id=>id!==userId);
    if (party.members.length===0) { delete parties[party.id]; return message.reply("✅ 파티 탈퇴 (파티 해체)"); }
    if (isLeader) party.leader=party.members[0];
    return message.reply("✅ 파티 탈퇴");
  }

  if (cmd === "파티컬링") {
    const party = getParty(userId);
    if (!party) return message.reply("❌ 파티 없음!");
    if (party.leader!==userId) return message.reply("❌ 파티장만 시작!");
    if (cullings[party.id]) return message.reply("🌊 이미 파티 컬링 중!");
    const firstEnemy=pickCullingEnemy(1);
    cullings[party.id]={wave:1,kills:0,totalXp:0,totalCrystals:0, currentEnemy:firstEnemy,enemyHp:firstEnemy.hp};
    return message.reply({ embeds:[partyCullingEmbed(party,cullings[party.id])], components:[mkCullingButtons(player)] });
  }

  if (cmd === "코드") {
    const code = args[1]?.toLowerCase();
    if (!code) return message.reply("!코드 [코드명]");
    if (player.usedCodes.includes(code)) return message.reply("❌ 이미 사용한 코드!");
    if (CODES[code]) {
      player.crystals+=CODES[code].crystals||0; player.usedCodes.push(code);
      await message.reply(`✅ 코드 사용! +${CODES[code].crystals||0}💎`);
      savePlayer(userId);
    } else return message.reply("❌ 유효하지 않은 코드!");
    return;
  }

  // ── 퀘스트 관련 ──
  if (cmd === "퀘스트") return message.reply({ embeds:[questEmbed(player)] });

  if (cmd === "퀘보상") {
    const type = args[1]; // "일" or "주"
    const idx  = parseInt(args[2])-1;
    if (type !== "일" && type !== "주") return message.reply("❌ !퀘보상 일 [번호] 또는 !퀘보상 주 [번호]");
    initQuests(player);
    const isWeekly = type==="주";
    const list = isWeekly ? player.quests.weekly : player.quests.daily;
    if (isNaN(idx)||idx<0||idx>=list.length) return message.reply(`❌ 번호 오류 (1~${list.length})`);
    const qp = list[idx];
    if (!qp.done) return message.reply("❌ 아직 완료되지 않았습니다!");
    if (qp.claimed) return message.reply("❌ 이미 수령한 보상입니다!");
    const reward = claimQuestReward(player, qp.id, isWeekly);
    if (!reward) return message.reply("❌ 보상 수령 실패");
    const matStr = reward.materials ? Object.entries(reward.materials).map(([m,q])=>`${MATERIALS[m]?.emoji||""}**${MATERIALS[m]?.name||m}** ×${q}`).join(", ") : "없음";
    await message.reply(`🎁 **보상 수령!**\n> +${reward.crystals}💎 +${reward.xp}XP\n> 재료: ${matStr}`);
    savePlayer(userId); return;
  }

  // ── 재료/주구 ──
  if (cmd === "재료") return message.reply({ embeds:[materialsEmbed(player)] });
  if (cmd === "주구목록") return message.reply({ embeds:[weaponListEmbed(player)] });

  if (cmd === "주구제작") {
    const weaponId = args.slice(1).join("_").toLowerCase();
    const w = WEAPONS[weaponId];
    if (!w) {
      const list = Object.entries(WEAPONS).map(([id,w])=>`\`${id}\` ${w.emoji}${w.name}`).join(", ");
      return message.reply(`❌ 존재하지 않는 주구!\n가능: ${list}`);
    }
    if ((player.craftedWeapons||[]).includes(weaponId)) return message.reply("❌ 이미 제작한 주구!");
    const mats = player.materials||{};
    for (const [mat,qty] of Object.entries(w.recipe)) {
      if ((mats[mat]||0)<qty) {
        const m=MATERIALS[mat];
        return message.reply(`❌ 재료 부족! ${m.emoji}**${m.name}** ${mats[mat]||0}/${qty}`);
      }
    }
    for (const [mat,qty] of Object.entries(w.recipe)) mats[mat]-=qty;
    if (!player.craftedWeapons) player.craftedWeapons=[];
    player.craftedWeapons.push(weaponId);
    updateQuestProgress(player, "weapon_craft", 1);
    savePlayer(userId);
    return message.reply({ embeds:[new EmbedBuilder().setTitle(`${w.emoji} ${w.name} 제작 완료!`).setColor(w.color).setDescription([`> **등급:** ${w.grade}`,`> 🗡️ ATK+${w.atkBonus} 🛡️ DEF+${w.defBonus} 💚 HP+${w.hpBonus}`,`> ${w.desc}`,`\n> \`!장착 ${weaponId}\` 으로 장착하세요!`].join("\n"))] });
  }

  if (cmd === "장착") {
    const weaponId = args.slice(1).join("_").toLowerCase();
    if (!(player.craftedWeapons||[]).includes(weaponId)) return message.reply("❌ 제작하지 않은 주구!");
    player.equippedWeapon = weaponId;
    const w=WEAPONS[weaponId];
    savePlayer(userId);
    return message.reply(`✅ **${w.emoji} ${w.name}** 장착! ATK+${w.atkBonus} DEF+${w.defBonus} HP+${w.hpBonus}`);
  }

  if (cmd === "해제") {
    if (!player.equippedWeapon) return message.reply("❌ 장착된 주구 없음!");
    const w=WEAPONS[player.equippedWeapon]; player.equippedWeapon=null;
    savePlayer(userId);
    return message.reply(`✅ **${w?.name||"주구"}** 해제됨.`);
  }

  if (cmd === "도감") {
    const ownedList = player.owned.map(id=>{
      const c=CHARACTERS[id]; const ri=GACHA_RARITY[c.grade]||GACHA_RARITY["3급"];
      return `${c.emoji} **${c.name}** \`${c.grade}\` ${ri.stars}`;
    }).join("\n");
    const missingList = Object.keys(CHARACTERS).filter(id=>!player.owned.includes(id)).map(id=>{
      const c=CHARACTERS[id]; const ri=GACHA_RARITY[c.grade]||GACHA_RARITY["3급"];
      return `${c.emoji} **${c.name}** \`${c.grade}\` ${ri.stars}`;
    }).join("\n");
    return message.reply(`📖 **도감** (${player.owned.length}/${Object.keys(CHARACTERS).length})\n\n**보유**\n${ownedList||"없음"}\n\n**미획득**\n${missingList||"모두 획득! 🎉"}`);
  }

  if (cmd === "도움말") {
    return message.reply([
      "🔱 **주술회전 RPG 명령어**",
      "⚔️ `!전투` `!컬링` `!사멸회유` `!결투 @유저`",
      "🎲 `!가챠` `!가챠10` `!코가네가챠`",
      "⚔️ `!재료` `!주구목록` `!주구제작 [ID]` `!장착 [ID]` `!해제`",
      "📋 `!퀘스트` `!퀘보상 일 [번호]` `!퀘보상 주 [번호]`",
      "👤 `!프로필` `!도감` `!술식` `!활성 [ID]` `!출석` `!회복` `!손가락` `!코드`",
      "👥 `!파티생성` `!파티초대 @유저` `!파티나가기` `!파티컬링`",
      "",
      "⚫ **흑섬**: 공격 시 **10%** 확률 발동 → 피해 **×2.5** + 💎50 보너스!",
      "📦 **재료 드롭**: 전투 승리 시 재료 획득 → 주구 제작으로 스탯 강화!",
      "📋 **퀘스트**: 일일/주간 퀘스트 완료 시 💎·XP·재료 보상!",
    ].join("\n"));
  }

  // ── 개발자 명령어 ──
  if (cmd === "개발자패널" && isDev(userId)) {
    return message.reply("🛠️ **개발자 패널**\n`!쿨다운초기화` `!아이템지급 [아이템] [수량]` `!전체저장` `!플레이어정보 @유저`");
  }
  if (cmd === "쿨다운초기화" && isDev(userId)) {
    player.skillCooldown=0; player.reverseCooldown=0;
    await message.reply("✅ 쿨다운 초기화!"); savePlayer(userId); return;
  }
  if (cmd === "아이템지급" && isDev(userId)) {
    const item=args[1], amount=parseInt(args[2])||1;
    if (item==="크리스탈") player.crystals+=amount;
    else if (item==="회복약") player.potion+=amount;
    else if (item==="손가락") player.sukunaFingers=Math.min(SUKUNA_FINGER_MAX,(player.sukunaFingers||0)+amount);
    else if (MATERIALS[item]) { player.materials=player.materials||{}; player.materials[item]=(player.materials[item]||0)+amount; }
    else return message.reply("❌ 아이템: 크리스탈, 회복약, 손가락, cursed_thread, cursed_bone, cursed_core, cursed_crystal, iron_fragment, spirit_essence, dragon_scale");
    await message.reply(`✅ ${item} +${amount} 지급!`); savePlayer(userId); return;
  }
  if (cmd === "전체저장" && isDev(userId)) {
    for (const uid of Object.keys(players)) await dbSave(uid, players[uid]);
    return message.reply("✅ 전체 저장 완료!");
  }
  if (cmd === "플레이어정보" && isDev(userId)) {
    const target = message.mentions.users.first()||message.author;
    const p = players[target.id];
    if (!p) return message.reply("❌ 플레이어 정보 없음");
    const matSummary = Object.entries(p.materials||{}).filter(([,q])=>q>0).map(([id,q])=>`${MATERIALS[id]?.emoji||""}${q}`).join(" ")||"없음";
    return message.reply(`📊 **${p.name}**\n💎${p.crystals} XP${p.xp} LV.${getLevel(p.xp)}\n🎭 ${CHARACTERS[p.active].name}\n⚔️${p.wins}승 ${p.losses}패\n📦 재료: ${matSummary}\n⚔️ 장착: ${p.equippedWeapon||"없음"}`);
  }
});

client.login(TOKEN);
