require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const {
  Client, GatewayIntentBits, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
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
const GACHA_RARITY = {
  "특급":  { stars:"★★★★★", color:0xF5C842, effect:"✨🔱✨🔱✨", flash:"LEGENDARY" },
  "준특급":{ stars:"★★★★☆", color:0xff8c00, effect:"💠💠💠💠💠", flash:"EPIC" },
  "1급":   { stars:"★★★☆☆", color:0x7C5CFC, effect:"⭐⭐⭐⭐",   flash:"RARE" },
  "준1급": { stars:"★★★☆☆", color:0x9b72cf, effect:"⭐⭐⭐",     flash:"RARE" },
  "2급":   { stars:"★★☆☆☆", color:0x4ade80, effect:"🔹🔹🔹",   flash:"UNCOMMON" },
  "3급":   { stars:"★☆☆☆☆", color:0x94a3b8, effect:"◽◽",       flash:"COMMON" },
};

// ════════════════════════════════════════════════════════
// ── 재료 시스템
// ════════════════════════════════════════════════════════
const MATERIALS = {
  cursed_thread:  { name:"저주 실",   emoji:"🧵", desc:"저급 저주령 드롭" },
  cursed_bone:    { name:"저주 뼈",   emoji:"🦴", desc:"1급 저주령 드롭" },
  cursed_core:    { name:"저주 핵",   emoji:"💜", desc:"특급 저주령 드롭" },
  cursed_crystal: { name:"저주 수정", emoji:"💎", desc:"보스 드롭" },
  iron_fragment:  { name:"철 파편",   emoji:"⚙️", desc:"모든 적 드롭" },
  spirit_essence: { name:"영혼 정수", emoji:"✨", desc:"특급 이상 드롭" },
  dragon_scale:   { name:"용 비늘",   emoji:"🐉", desc:"보스 드롭" },
};

const WEAPONS = {
  cursed_knife:  { name:"저주 단검",     emoji:"🗡️",    grade:"일반", atkBonus:15,  defBonus:0,  hpBonus:0,   desc:"저주 단검.",        recipe:{ cursed_thread:3, iron_fragment:5 },                              color:0x94a3b8 },
  cursed_blade:  { name:"저주 도검",     emoji:"⚔️",    grade:"희귀", atkBonus:35,  defBonus:5,  hpBonus:100, desc:"저주 도검.",         recipe:{ cursed_bone:4, iron_fragment:8, cursed_thread:2 },               color:0x4ade80 },
  cursed_spear:  { name:"저주 창",       emoji:"🔱",    grade:"희귀", atkBonus:45,  defBonus:0,  hpBonus:0,   desc:"원거리 저주 창.",     recipe:{ cursed_bone:5, cursed_thread:5 },                               color:0x4ade80 },
  spirit_shield: { name:"영혼 방패",     emoji:"🛡️",    grade:"고급", atkBonus:5,   defBonus:40, hpBonus:300, desc:"영혼 정수 방어구.",   recipe:{ spirit_essence:3, cursed_core:2, iron_fragment:10 },            color:0x7C5CFC },
  cursed_hammer: { name:"저주 망치",     emoji:"🔨",    grade:"고급", atkBonus:60,  defBonus:10, hpBonus:150, desc:"저주 망치.",          recipe:{ cursed_core:3, cursed_bone:6, iron_fragment:12 },              color:0x7C5CFC },
  dragon_sword:  { name:"용의 검",       emoji:"🐉⚔️",  grade:"전설", atkBonus:100, defBonus:30, hpBonus:500, desc:"전설의 검.",          recipe:{ dragon_scale:3, cursed_crystal:2, spirit_essence:5, cursed_core:4 }, color:0xF5C842 },
  sukuna_vessel: { name:"스쿠나의 그릇", emoji:"👹",    grade:"전설", atkBonus:80,  defBonus:20, hpBonus:800, desc:"스쿠나의 힘이 깃든 주구.", recipe:{ cursed_crystal:3, dragon_scale:2, cursed_core:6 },          color:0x8b0000 },
};

const ENEMY_DROPS = {
  e1: [{ mat:"cursed_thread",  min:1, max:3, chance:0.80 }, { mat:"iron_fragment",  min:1, max:2, chance:0.60 }, { mat:"cursed_bone",    min:1, max:1, chance:0.10 }],
  e2: [{ mat:"cursed_bone",    min:1, max:2, chance:0.70 }, { mat:"iron_fragment",  min:2, max:4, chance:0.80 }, { mat:"cursed_thread",  min:2, max:4, chance:0.50 }, { mat:"cursed_core",    min:1, max:1, chance:0.08 }],
  e3: [{ mat:"cursed_core",    min:1, max:2, chance:0.65 }, { mat:"spirit_essence", min:1, max:2, chance:0.55 }, { mat:"cursed_bone",    min:2, max:4, chance:0.80 }, { mat:"iron_fragment",  min:3, max:6, chance:0.90 }, { mat:"cursed_crystal", min:1, max:1, chance:0.05 }],
  e4: [{ mat:"cursed_crystal", min:1, max:2, chance:0.80 }, { mat:"dragon_scale",   min:1, max:2, chance:0.60 }, { mat:"spirit_essence", min:2, max:4, chance:0.90 }, { mat:"cursed_core",    min:2, max:4, chance:0.90 }, { mat:"iron_fragment",  min:5, max:10, chance:1.00 }],
  // 스쿠나 보스 - 손가락 100% + 풍부한 재료
  e_sukuna: [{ mat:"cursed_crystal", min:3, max:5, chance:1.00 }, { mat:"dragon_scale",   min:2, max:4, chance:1.00 }, { mat:"spirit_essence", min:4, max:8, chance:1.00 }, { mat:"cursed_core",    min:4, max:8, chance:1.00 }, { mat:"iron_fragment",  min:10, max:20, chance:1.00 }],
  // 레이드 드롭
  e_heian:  [{ mat:"cursed_crystal", min:5, max:8, chance:1.00 }, { mat:"dragon_scale",   min:3, max:5, chance:1.00 }, { mat:"spirit_essence", min:6, max:10, chance:1.00 }, { mat:"cursed_core",    min:5, max:8, chance:1.00 }],
  e_mahara: [{ mat:"cursed_crystal", min:4, max:7, chance:1.00 }, { mat:"dragon_scale",   min:3, max:5, chance:1.00 }, { mat:"spirit_essence", min:5, max:8, chance:1.00 }, { mat:"iron_fragment",  min:15, max:25, chance:1.00 }],
};
const JUJUTSU_DROPS = {
  j1: [{ mat:"cursed_thread", min:1, max:2, chance:0.70 }, { mat:"iron_fragment", min:1, max:2, chance:0.60 }],
  j2: [{ mat:"cursed_thread", min:1, max:3, chance:0.70 }, { mat:"cursed_bone",   min:1, max:1, chance:0.35 }, { mat:"iron_fragment",  min:1, max:3, chance:0.65 }],
  j3: [{ mat:"cursed_bone",   min:1, max:2, chance:0.55 }, { mat:"iron_fragment", min:1, max:3, chance:0.70 }],
  j4: [{ mat:"cursed_core",   min:1, max:1, chance:0.30 }, { mat:"cursed_bone",   min:1, max:3, chance:0.65 }, { mat:"spirit_essence", min:1, max:1, chance:0.20 }],
  j5: [{ mat:"cursed_core",   min:1, max:2, chance:0.55 }, { mat:"spirit_essence",min:1, max:2, chance:0.40 }, { mat:"cursed_crystal", min:1, max:1, chance:0.08 }],
  j6: [{ mat:"cursed_crystal",min:1, max:1, chance:0.50 }, { mat:"dragon_scale",  min:1, max:1, chance:0.30 }, { mat:"spirit_essence", min:2, max:3, chance:0.80 }],
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
  for (const [mat, qty] of Object.entries(drops)) player.materials[mat] = (player.materials[mat] || 0) + qty;
}
function formatDrops(drops) {
  const parts = [];
  for (const [mat, qty] of Object.entries(drops)) {
    const m = MATERIALS[mat];
    if (m) parts.push(`${m.emoji}**${m.name}**×${qty}`);
  }
  return parts.length ? parts.join(" ") : "없음";
}
function getWeaponStats(player) {
  if (!player.equippedWeapon) return { atk:0, def:0, hp:0 };
  const w = WEAPONS[player.equippedWeapon];
  if (!w) return { atk:0, def:0, hp:0 };
  return { atk:w.atkBonus, def:w.defBonus, hp:w.hpBonus };
}

// ════════════════════════════════════════════════════════
// ── 퀘스트 시스템
// ════════════════════════════════════════════════════════
const DAILY_QUESTS = [
  { id:"dq_battle3",  type:"battle_win",   target:3,  name:"오늘의 수련",   desc:"전투 3회 승리",           reward:{ crystals:80,  xp:150, materials:{ iron_fragment:3 } } },
  { id:"dq_culling5", type:"culling_wave",  target:5,  name:"컬링 특훈",     desc:"컬링 5웨이브 달성",       reward:{ crystals:100, xp:200, materials:{ cursed_thread:5 } } },
  { id:"dq_jujutsu3", type:"jujutsu_point", target:3,  name:"사멸회유 임무", desc:"사멸회유 3포인트",        reward:{ crystals:90,  xp:180, materials:{ cursed_bone:2 } } },
  { id:"dq_skill5",   type:"skill_use",     target:5,  name:"술식 연마",     desc:"술식 5회 사용",           reward:{ crystals:70,  xp:130, materials:{ cursed_thread:3, iron_fragment:2 } } },
  { id:"dq_gacha1",   type:"gacha_pull",    target:1,  name:"운명의 소환",   desc:"가챠 1회",                reward:{ crystals:60,  xp:100, materials:{ iron_fragment:5 } } },
  { id:"dq_nokill2",  type:"boss_kill",     target:2,  name:"정예 사냥",     desc:"특급 이상 2마리 처치",    reward:{ crystals:150, xp:300, materials:{ cursed_core:1 } } },
];
const WEEKLY_QUESTS = [
  { id:"wq_battle20", type:"battle_win",   target:20, name:"주간 전사",       desc:"이번 주 전투 20승",       reward:{ crystals:500, xp:1000, materials:{ cursed_core:3, spirit_essence:2 } } },
  { id:"wq_culling15",type:"culling_wave",  target:15, name:"컬링 마스터",     desc:"컬링 15웨이브",           reward:{ crystals:600, xp:1200, materials:{ cursed_crystal:1, cursed_bone:8 } } },
  { id:"wq_jujutsu15",type:"jujutsu_point", target:15, name:"사멸회유 전문가", desc:"사멸회유 15포인트",       reward:{ crystals:550, xp:1100, materials:{ spirit_essence:4, cursed_core:2 } } },
  { id:"wq_boss5",    type:"boss_kill",     target:5,  name:"보스 사냥꾼",     desc:"특급 이상 5마리",         reward:{ crystals:700, xp:1400, materials:{ dragon_scale:1, cursed_crystal:1 } } },
  { id:"wq_craft1",   type:"weapon_craft",  target:1,  name:"주구 장인",       desc:"주구 1개 제작",           reward:{ crystals:400, xp:800,  materials:{ spirit_essence:3, dragon_scale:1 } } },
  { id:"wq_pvpwin3",  type:"pvp_win",       target:3,  name:"결투 챔피언",     desc:"PvP 3승",                 reward:{ crystals:800, xp:1600, materials:{ cursed_crystal:2, dragon_scale:1 } } },
];

function getTodayKey() { const d=new Date(); return `${d.getUTCFullYear()}-${d.getUTCMonth()+1}-${d.getUTCDate()}`; }
function getWeekKey()  { const d=new Date(); const ws=new Date(d); ws.setUTCDate(d.getUTCDate()-d.getUTCDay()); return `${ws.getUTCFullYear()}-${ws.getUTCMonth()+1}-${ws.getUTCDate()}`; }

function initQuests(player) {
  const today=getTodayKey(), week=getWeekKey();
  if (!player.quests) player.quests={};
  if (player.quests.dailyKey!==today) {
    player.quests.dailyKey=today;
    const picked=[...DAILY_QUESTS].sort(()=>Math.random()-0.5).slice(0,3);
    player.quests.daily=picked.map(q=>({ id:q.id, progress:0, done:false, claimed:false }));
  }
  if (player.quests.weekKey!==week) {
    player.quests.weekKey=week;
    const picked=[...WEEKLY_QUESTS].sort(()=>Math.random()-0.5).slice(0,3);
    player.quests.weekly=picked.map(q=>({ id:q.id, progress:0, done:false, claimed:false }));
  }
  if (!player.quests.daily)  player.quests.daily=[];
  if (!player.quests.weekly) player.quests.weekly=[];
}
function updateQuestProgress(player, type, amount=1) {
  initQuests(player);
  for (const qp of player.quests.daily)  { if (qp.done) continue; const def=DAILY_QUESTS.find(q=>q.id===qp.id);  if (!def||def.type!==type) continue; qp.progress=Math.min(qp.progress+amount,def.target);  if (qp.progress>=def.target) qp.done=true; }
  for (const qp of player.quests.weekly) { if (qp.done) continue; const def=WEEKLY_QUESTS.find(q=>q.id===qp.id); if (!def||def.type!==type) continue; qp.progress=Math.min(qp.progress+amount,def.target); if (qp.progress>=def.target) qp.done=true; }
}
function claimQuestReward(player, questId, isWeekly=false) {
  initQuests(player);
  const list=isWeekly?player.quests.weekly:player.quests.daily;
  const allDefs=isWeekly?WEEKLY_QUESTS:DAILY_QUESTS;
  const qp=list.find(q=>q.id===questId);
  if (!qp||!qp.done||qp.claimed) return null;
  const def=allDefs.find(q=>q.id===questId);
  if (!def) return null;
  qp.claimed=true;
  player.crystals+=(def.reward.crystals||0);
  player.xp+=(def.reward.xp||0);
  if (def.reward.materials) addMaterials(player,def.reward.materials);
  return def.reward;
}

// ════════════════════════════════════════════════════════
// ── 상태이상
// ════════════════════════════════════════════════════════
const STATUS_EFFECTS = {
  poison:        { id:"poison",         name:"독",       emoji:"☠️", desc:"매 턴 최대HP 5% 피해",   duration:3 },
  burn:          { id:"burn",           name:"화상",     emoji:"🔥", desc:"매 턴 최대HP 8% 피해",   duration:2 },
  freeze:        { id:"freeze",         name:"빙결",     emoji:"❄️", desc:"1턴 행동 불가",           duration:1 },
  weaken:        { id:"weaken",         name:"약화",     emoji:"💔", desc:"공격력 30% 감소",         duration:2 },
  stun:          { id:"stun",           name:"기절",     emoji:"⚡", desc:"1턴 행동 불가",           duration:1 },
  battleInstinct:{ id:"battleInstinct", name:"전투본능", emoji:"🔥💪",desc:"공격력 40%↑, 회피 25%↑", duration:3 },
  cursed_wound:  { id:"cursed_wound",   name:"저주상처", emoji:"🩸", desc:"매 턴 최대HP 10% 피해",  duration:2 },
  blind:         { id:"blind",          name:"실명",     emoji:"🌑", desc:"명중률 50% 감소",         duration:2 },
  adapted:       { id:"adapted",        name:"적응",     emoji:"🔰", desc:"이 술식 피해 무효",       duration:999 },
};

function applyStatus(target, statusId) {
  if (!target.statusEffects) target.statusEffects=[];
  const existing=target.statusEffects.find(s=>s.id===statusId);
  if (existing) existing.turns=STATUS_EFFECTS[statusId].duration;
  else target.statusEffects.push({ id:statusId, turns:STATUS_EFFECTS[statusId].duration });
}
function tickStatus(target, maxHp) {
  if (!target.statusEffects||target.statusEffects.length===0) return { dmg:0, expired:[], log:[] };
  let totalDmg=0; const expired=[], log=[];
  for (const se of target.statusEffects) {
    const def=STATUS_EFFECTS[se.id]; if (!def) { se.turns=0; continue; }
    if (se.id==="poison")       { const d=Math.max(1,Math.floor(maxHp*0.05)); totalDmg+=d; log.push(`${def.emoji}**${def.name}** ${d} 피해!`); }
    if (se.id==="burn")         { const d=Math.max(1,Math.floor(maxHp*0.08)); totalDmg+=d; log.push(`${def.emoji}**${def.name}** ${d} 피해!`); }
    if (se.id==="cursed_wound") { const d=Math.max(1,Math.floor(maxHp*0.10)); totalDmg+=d; log.push(`${def.emoji}**${def.name}** ${d} 피해!`); }
    if (se.id!=="adapted") se.turns--;
    if (se.turns<=0) expired.push(se.id);
  }
  target.statusEffects=target.statusEffects.filter(s=>s.turns>0);
  if (totalDmg>0) target.hp=Math.max(0, target.hp-totalDmg);
  return { dmg:totalDmg, expired, log };
}
function statusStr(se) {
  if (!se||se.length===0) return "없음";
  return se.map(s=>`${STATUS_EFFECTS[s.id]?.emoji||""}${STATUS_EFFECTS[s.id]?.name||s.id}(${s.id==="adapted"?"∞":s.turns+"턴"})`).join(" ");
}
function isIncapacitated(se) { return !!(se&&se.some(s=>s.id==="freeze"||s.id==="stun")); }
function isBlind(se)          { return !!(se&&se.some(s=>s.id==="blind")); }
function getWeakenMult(se)    { let m=1; if (se&&se.some(s=>s.id==="weaken")) m*=0.7; if (se&&se.some(s=>s.id==="battleInstinct")) m*=1.4; return m; }
function getBattleInstinctEvade(se) { return !!(se&&se.some(s=>s.id==="battleInstinct")); }
function rollHit(atkSe, defSe) {
  if (isBlind(atkSe)&&Math.random()<0.50) return false;
  return Math.random()>(0.05+(getBattleInstinctEvade(defSe)?0.25:0));
}

// ════════════════════════════════════════════════════════
// ── 흑섬
// ════════════════════════════════════════════════════════
function isBlackFlash() { return Math.random()<0.10; }
function getBlackFlashBanner() {
  return ["```ansi","\u001b[1;31m╔══════════════════════════╗","\u001b[1;33m║   ⚫  B L A C K  F L A S H  ⚫  ║","\u001b[1;31m╠══════════════════════════╣","\u001b[1;33m║  저주 에너지 순간 최대 방출!!  ║","\u001b[1;31m╚══════════════════════════╝","```"].join("\n");
}

// ════════════════════════════════════════════════════════
// ── 스쿠나 손가락 시스템 (개편)
// ════════════════════════════════════════════════════════
const SUKUNA_FINGER_MAX = 20;
// 손가락 1개 이상이면 스쿠나 잠금해제
function isSukunaUnlocked(player) { return (player.sukunaFingers||0) >= 1; }
function getFingerBonus(fingers) {
  return {
    atkBonus: Math.floor(fingers * 12),
    defBonus: Math.floor(fingers * 7),
    hpBonus:  fingers * 250,
    label: fingers>=20 ? "🔴 완전 각성 — 저주의 왕" :
           fingers>=15 ? "🔴 스쿠나 각성 Lv.4" :
           fingers>=10 ? "🟠 스쿠나 각성 Lv.3" :
           fingers>=5  ? "🟡 스쿠나 각성 Lv.2" :
           fingers>=1  ? "🟢 스쿠나 각성 Lv.1" : "봉인 중",
  };
}

// ════════════════════════════════════════════════════════
// ── 코가네 펫
// ════════════════════════════════════════════════════════
const KOGANE_GRADES = {
  "전설": { color:0xF5C842,emoji:"🌟",stars:"★★★★★",rate:0.5,  atkBonus:0.25,defBonus:0.20,hpBonus:0.20,xpBonus:0.30,crystalBonus:0.25, skill:"황금 포효",    passiveDesc:"ATK+25% DEF+20% HP+20% XP+30% 크리스탈+25%" },
  "특급": { color:0xff8c00,emoji:"🔶",stars:"★★★★☆",rate:2.0,  atkBonus:0.18,defBonus:0.15,hpBonus:0.15,xpBonus:0.20,crystalBonus:0.18, skill:"황금 이빨",    passiveDesc:"ATK+18% DEF+15% HP+15% XP+20% 크리스탈+18%" },
  "1급":  { color:0x7C5CFC,emoji:"🔷",stars:"★★★☆☆",rate:8.0,  atkBonus:0.12,defBonus:0.10,hpBonus:0.10,xpBonus:0.12,crystalBonus:0.10, skill:"황금 발톱",    passiveDesc:"ATK+12% DEF+10% HP+10% XP+12% 크리스탈+10%" },
  "2급":  { color:0x4ade80,emoji:"🟢",stars:"★★☆☆☆",rate:22.5, atkBonus:0.07,defBonus:0.06,hpBonus:0.06,xpBonus:0.07,crystalBonus:0.06, skill:"황금 보호막",  passiveDesc:"ATK+7% DEF+6% HP+6% XP+7% 크리스탈+6%" },
  "3급":  { color:0x94a3b8,emoji:"⚪",stars:"★☆☆☆☆",rate:67.0, atkBonus:0.03,defBonus:0.02,hpBonus:0.02,xpBonus:0.03,crystalBonus:0.02, skill:"황금 냄새",    passiveDesc:"ATK+3% DEF+2% HP+2% XP+3% 크리스탈+2%" },
};
const KOGANE_POOL = [{ grade:"전설",rate:0.5 },{ grade:"특급",rate:2.0 },{ grade:"1급",rate:8.0 },{ grade:"2급",rate:22.5 },{ grade:"3급",rate:67.0 }];
function rollKogane() {
  const total=KOGANE_POOL.reduce((s,p)=>s+p.rate,0); let roll=Math.random()*total;
  for (const e of KOGANE_POOL) { roll-=e.rate; if (roll<=0) return e.grade; } return "3급";
}
function getKoganeBonus(player) {
  if (!player.kogane?.grade) return { atk:1,def:1,hp:1,xp:1,crystal:1 };
  const g=KOGANE_GRADES[player.kogane.grade]; if (!g) return { atk:1,def:1,hp:1,xp:1,crystal:1 };
  return { atk:1+g.atkBonus, def:1+g.defBonus, hp:1+g.hpBonus, xp:1+g.xpBonus, crystal:1+g.crystalBonus };
}

// ════════════════════════════════════════════════════════
// ── 스킬 이펙트
// ════════════════════════════════════════════════════════
const SKILL_EFFECTS = {
  "주먹질":        { art:"```\n 💥 \n▓▓▓\n 💥 \n```",     color:0xff6b35, flavorText:"저주 에너지를 주먹에 집중!" },
  "다이버전트 주먹":{ art:"```\n⚡💥⚡\n▓▓▓▓▓\n⚡💥⚡\n```", color:0xff4500, flavorText:"발산하는 저주 에너지 — 내부 폭발!" },
  "흑섬":          { art:"```\n🌑🌑🌑\n⬛黑閃⬛\n🌑🌑🌑\n```",color:0x1a0a2e, flavorText:"순간 최대 저주 에너지 방출!" },
  "어주자":        { art:"```\n👹✨👹\n✨廻夏✨\n👹✨👹\n```",color:0xb5451b, flavorText:"스쿠나의 힘이 몸을 가득 채운다..." },
  "스쿠나 발현":   { art:"```\n🔴👹🔴\n👹両面宿儺👹\n🔴👹🔴\n```",color:0x8b0000,flavorText:"저주의 왕이 장악한다!" },
  "아오":          { art:"```\n 🔵🔵🔵 \n🔵 蒼 🔵\n 🔵🔵🔵 \n```",color:0x0066ff,flavorText:"무한의 인력 — 모든 것을 끌어당긴다" },
  "아카":          { art:"```\n 🔴🔴🔴 \n🔴 赫 🔴\n 🔴🔴🔴 \n```",color:0xff0033,flavorText:"무한의 척력 — 모든 것을 날려버린다" },
  "무라사키":      { art:"```\n🔴⚡🔵\n⚡ 紫 ⚡\n🔵⚡🔴\n```",  color:0x9900ff,flavorText:"아오와 아카의 융합 — 허공을 찢는 허수!" },
  "무량공처":      { art:"```\n∞∞∞∞∞\n∞無量空処∞\n∞∞∞∞∞\n```",color:0x00ffff,flavorText:"나는 최강이니까 — 무한이 세계를 지배한다" },
  "자폭 무라사키": { art:"```\n💥🔴💥\n💥自爆紫💥\n💥🔵💥\n```",color:0xff0000,flavorText:"모든 힘을 쏟아붓는 자폭 공격!" },
  "해":            { art:"```\n ✂️✂️✂️ \n✂️ 解 ✂️\n ✂️✂️✂️ \n```",color:0xcc0000,flavorText:"만물을 베어내는 저주의 왕의 손톱!" },
  "팔":            { art:"```\n🌌✂️🌌\n✂️ 捌 ✂️\n🌌✂️🌌\n```",  color:0x8b0000,flavorText:"공간 자체를 베어내는 절대 술식!" },
  "푸가":          { art:"```\n💀🔥💀\n🔥不雅🔥\n💀🔥💀\n```",  color:0x4a0000,flavorText:"닿는 모든 것을 분해한다!" },
  "복마어주자":    { art:"```\n👑🌑👑\n🌑伏魔御廚子🌑\n👑🌑👑\n```",color:0x2a0000,flavorText:"천지개벽 — 저주의 왕의 궁극 영역!" },
  "세계참":        { art:"```\n🌍✂️🌍\n✂️世界斬✂️\n🌍✂️🌍\n```",  color:0x4a0000,flavorText:"세계조차 베어버린다!" },
  "부기우기":      { art:"```\n🎵💪🎵\n💪Boogie💪\n🎵💪🎵\n```",  color:0x1e90ff,flavorText:"댄스홀 가수! 빙결의 한기!" },
  "전투본능":      { art:"```\n⚔️🔥⚔️\n🔥戦闘本能🔥\n⚔️🔥⚔️\n```",color:0xff8c00,flavorText:"전사의 본능이 각성한다!" },
  "_default":      { art:"```\n ✨✨✨ \n✨術式✨\n ✨✨✨ \n```",  color:0x7c5cfc,flavorText:"저주 에너지가 폭발한다!" },
};
function getSkillEffect(n) { return SKILL_EFFECTS[n]||SKILL_EFFECTS["_default"]; }

// ════════════════════════════════════════════════════════
// ── 캐릭터 데이터
// ════════════════════════════════════════════════════════
const CHARACTERS = {
  itadori: { name:"이타도리 유지",  emoji:"🟠", grade:"준1급", atk:90,  def:75,  spd:85,  maxHp:1000, domain:null,       desc:"특급주술사 후보생. 스쿠나의 그릇.", lore:"\"남은 건 내가 어떻게 죽느냐다.\"", fingerSkills:true,
    skills:[
      { name:"주먹질",       minMastery:0,  dmg:95,  desc:"기본 주먹 공격." },
      { name:"다이버전트 주먹",minMastery:5, dmg:160, desc:"저주 에너지를 실은 주먹.", statusApply:{ target:"enemy",statusId:"stun",chance:0.3 } },
      { name:"흑섬",         minMastery:15, dmg:240, desc:"최대 저주 에너지 방출!",   statusApply:{ target:"enemy",statusId:"weaken",chance:0.5 } },
      { name:"어주자",       minMastery:30, dmg:340, desc:"스쿠나의 힘을 빌린 궁극기.",statusApply:{ target:"enemy",statusId:"burn",chance:0.7 } },
      { name:"스쿠나 발현",  minMastery:50, dmg:520, desc:"스쿠나 장악! 10손가락 필요.",statusApply:{ target:"enemy",statusId:"freeze",chance:0.8 } },
    ],
  },
  gojo: { name:"고조 사토루",   emoji:"🔵", grade:"특급",  atk:130, def:120, spd:110, maxHp:1800, domain:"무량공처",  desc:"최강의 주술사. 무량공처 구사.", lore:"\"사람들이 왜 내가 최강이라고 하는지 알아?\"",
    skills:[
      { name:"아오",    minMastery:0,  dmg:145, desc:"인력으로 끌어당겨 공격." },
      { name:"아카",    minMastery:5,  dmg:220, desc:"척력으로 폭발.", statusApply:{ target:"enemy",statusId:"burn",chance:0.5 } },
      { name:"무라사키",minMastery:15, dmg:320, desc:"아오+아카 융합.", statusApply:{ target:"enemy",statusId:"weaken",chance:0.6 } },
      { name:"무량공처",minMastery:30, dmg:480, desc:"무한을 지배하는 궁극 술식.", statusApply:{ target:"enemy",statusId:"freeze",chance:0.8 } },
    ],
  },
  megumi: { name:"후시구로 메구미",emoji:"⚫", grade:"1급",   atk:110, def:108, spd:100, maxHp:1250, domain:"강압암예정",desc:"식신술 구사.", lore:"\"나는 선한 사람을 구하기 위해 싸운다.\"",
    skills:[
      { name:"옥견",          minMastery:0,  dmg:115, desc:"식신 옥견 소환." },
      { name:"탈토",          minMastery:5,  dmg:180, desc:"식신 대호 소환.", statusApply:{ target:"enemy",statusId:"weaken",chance:0.4 } },
      { name:"만상",          minMastery:15, dmg:265, desc:"열 가지 식신.", statusApply:{ target:"enemy",statusId:"poison",chance:0.5 } },
      { name:"후루베 유라유라",minMastery:30, dmg:380, desc:"마허라가라 강림.", statusApply:{ target:"enemy",statusId:"stun",chance:0.6 } },
    ],
  },
  nobara: { name:"쿠기사키 노바라",emoji:"🌸",grade:"1급",   atk:115, def:95,  spd:105, maxHp:1180, domain:null,       desc:"저주 못 술식.", lore:"\"도쿄에 올 때부터 각오는 되어 있었어.\"",
    skills:[
      { name:"망치질",minMastery:0,  dmg:118, desc:"저주 못을 박는다." },
      { name:"공명",  minMastery:5,  dmg:195, desc:"허수아비 공명 피해.", statusApply:{ target:"enemy",statusId:"poison",chance:0.5 } },
      { name:"철정",  minMastery:15, dmg:280, desc:"저주 에너지 못.", statusApply:{ target:"enemy",statusId:"weaken",chance:0.5 } },
      { name:"발화",  minMastery:30, dmg:390, desc:"동시 폭발 공명.", statusApply:{ target:"enemy",statusId:"burn",chance:0.8 } },
    ],
  },
  nanami: { name:"나나미 켄토",  emoji:"🟡", grade:"1급",   atk:118, def:108, spd:90,  maxHp:1380, domain:null,       desc:"합리적 판단의 1급 주술사.", lore:"\"초과 근무는 사절이지만... 이건 의무다.\"",
    skills:[
      { name:"둔기 공격",minMastery:0,  dmg:120, desc:"둔기 타격." },
      { name:"칠할삼분", minMastery:5,  dmg:200, desc:"7:3 약점 공격.", statusApply:{ target:"enemy",statusId:"weaken",chance:0.6 } },
      { name:"십수할",   minMastery:15, dmg:290, desc:"열 배 저주 에너지." },
      { name:"초과근무", minMastery:30, dmg:410, desc:"한계 초과 폭발 강화." },
    ],
  },
  sukuna: { name:"료멘 스쿠나",  emoji:"🔴", grade:"특급",  atk:140, def:115, spd:120, maxHp:2500, domain:"복마어주자",desc:"저주의 왕. 손가락 수에 따라 강해진다.", lore:"\"약한 놈이 강한 놈을 거스르는 건 죄악이다.\"",
    skills:[
      { name:"해",       minMastery:0,  dmg:145, desc:"손톱으로 베어낸다.", statusApply:{ target:"enemy",statusId:"burn",chance:0.4 } },
      { name:"팔",       minMastery:5,  dmg:235, desc:"공간 자체를 벤다.", statusApply:{ target:"enemy",statusId:"weaken",chance:0.5 } },
      { name:"푸가",     minMastery:15, dmg:345, desc:"모든 것을 분해한다.", statusApply:{ target:"enemy",statusId:"poison",chance:0.7 } },
      { name:"복마어주자",minMastery:30,dmg:500, desc:"궁극 영역전개.", statusApply:{ target:"enemy",statusId:"freeze",chance:0.9 } },
    ],
  },
  geto: { name:"게토 스구루",   emoji:"🟢", grade:"특급",  atk:115, def:105, spd:100, maxHp:1600, domain:null,       desc:"저주령 술사.", lore:"\"주술사는 비주술사를 지켜야 한다.\"",
    skills:[
      { name:"저주 방출",  minMastery:0,  dmg:125, desc:"저급 저주령 방출." },
      { name:"최대출력",   minMastery:5,  dmg:210, desc:"전력 방출.", statusApply:{ target:"enemy",statusId:"poison",chance:0.4 } },
      { name:"저주영조종", minMastery:15, dmg:300, desc:"수천의 저주령.", statusApply:{ target:"enemy",statusId:"weaken",chance:0.6 } },
      { name:"감로대법",   minMastery:30, dmg:425, desc:"저주 흡수.", statusApply:{ target:"enemy",statusId:"stun",chance:0.5 } },
    ],
  },
  maki: { name:"마키 젠인",     emoji:"⚪", grade:"준1급", atk:122, def:110, spd:115, maxHp:1300, domain:null,       desc:"HP 30% 이하 천여주박 각성!", lore:"\"젠인 가문 — 그 이름을 내가 직접 끝내주지.\"",
    awakening:{ threshold:0.30, dmgMult:2.0, label:"천여주박 각성" },
    skills:[
      { name:"봉술",    minMastery:0,  dmg:122, desc:"저주 도구 봉." },
      { name:"저주창",  minMastery:5,  dmg:200, desc:"저주 창 투척.", statusApply:{ target:"enemy",statusId:"weaken",chance:0.4 } },
      { name:"저주도구술",minMastery:15,dmg:285, desc:"다양한 저주 도구.", statusApply:{ target:"enemy",statusId:"burn",chance:0.5 } },
      { name:"천개봉파",minMastery:30, dmg:400, desc:"수천 도구 연속.", statusApply:{ target:"enemy",statusId:"stun",chance:0.6 } },
    ],
  },
  panda: { name:"판다",         emoji:"🐼", grade:"2급",   atk:105, def:118, spd:85,  maxHp:1400, domain:null,       desc:"저주로 만든 특이체질.", lore:"\"난 판다야. 진짜 판다.\"",
    skills:[
      { name:"박치기",    minMastery:0,  dmg:108, desc:"머리로 들이받는다.", statusApply:{ target:"enemy",statusId:"stun",chance:0.2 } },
      { name:"곰 발바닥", minMastery:5,  dmg:175, desc:"두꺼운 발바닥 타격." },
      { name:"팬더 변신", minMastery:15, dmg:255, desc:"진짜 팬더로 변신.", statusApply:{ target:"enemy",statusId:"weaken",chance:0.4 } },
      { name:"고릴라 변신",minMastery:30,dmg:360, desc:"고릴라 형태 폭발.", statusApply:{ target:"enemy",statusId:"stun",chance:0.5 } },
    ],
  },
  inumaki: { name:"이누마키 토게",emoji:"🟤",grade:"준1급", atk:112, def:90,  spd:110, maxHp:1120, domain:null,       desc:"주술언어 구사.", lore:"\"연어알—\"",
    skills:[
      { name:"멈춰라",  minMastery:0,  dmg:115, desc:"움직임 봉쇄.", statusApply:{ target:"enemy",statusId:"freeze",chance:0.5 } },
      { name:"달려라",  minMastery:5,  dmg:180, desc:"무작위로 달리게.", statusApply:{ target:"enemy",statusId:"weaken",chance:0.5 } },
      { name:"주술언어",minMastery:15, dmg:265, desc:"강력한 주술 명령.", statusApply:{ target:"enemy",statusId:"stun",chance:0.6 } },
      { name:"폭발해라",minMastery:30, dmg:375, desc:"그 자리에서 폭발.", statusApply:{ target:"enemy",statusId:"burn",chance:0.8 } },
    ],
  },
  yuta: { name:"오코츠 유타",   emoji:"🌟", grade:"특급",  atk:128, def:112, spd:115, maxHp:1750, domain:"진안상애",  desc:"특급 주술사. 리카의 저주.", lore:"\"리카... 나는 아직 살아야 해.\"",
    skills:[
      { name:"모방술식",minMastery:0,  dmg:135, desc:"다른 술식 모방." },
      { name:"리카 소환",minMastery:5, dmg:220, desc:"저주의 여왕 리카.", statusApply:{ target:"enemy",statusId:"weaken",chance:0.5 } },
      { name:"순애빔",  minMastery:15, dmg:340, desc:"순수한 사랑을 에너지로.", statusApply:{ target:"enemy",statusId:"burn",chance:0.6 } },
      { name:"진안상애",minMastery:30, dmg:480, desc:"사랑으로 모든 것 파괴.", statusApply:{ target:"enemy",statusId:"freeze",chance:0.9 } },
    ],
  },
  higuruma: { name:"히구루마 히로미",emoji:"⚖️",grade:"1급", atk:118, def:105, spd:95,  maxHp:1320, domain:"주복사사", desc:"전직 변호사 출신 주술사.", lore:"\"이 법정에서는 — 내가 판사다.\"",
    skills:[
      { name:"저주도구",   minMastery:0,  dmg:120, desc:"저주 도구 공격." },
      { name:"몰수",       minMastery:5,  dmg:195, desc:"술식 몰수.", statusApply:{ target:"enemy",statusId:"weaken",chance:0.7 } },
      { name:"사형판결",   minMastery:15, dmg:285, desc:"강력한 재판 제재.", statusApply:{ target:"enemy",statusId:"stun",chance:0.5 } },
      { name:"집행인 인형",minMastery:30, dmg:410, desc:"집행인 인형 처형.", statusApply:{ target:"enemy",statusId:"freeze",chance:0.7 } },
    ],
  },
  jogo: { name:"죠고",          emoji:"🌋", grade:"준특급", atk:125, def:100, spd:105, maxHp:1680, domain:"개관철위산",desc:"화염 저주령.", lore:"\"인간이야말로 진정한 저주다.\"",
    skills:[
      { name:"화염 분사",minMastery:0,  dmg:130, desc:"불꽃 분사.", statusApply:{ target:"enemy",statusId:"burn",chance:0.5 } },
      { name:"용암 폭발",minMastery:5,  dmg:215, desc:"용암 폭발.", statusApply:{ target:"enemy",statusId:"burn",chance:0.7 } },
      { name:"극번 운",  minMastery:15, dmg:315, desc:"운석 소환.", statusApply:{ target:"enemy",statusId:"weaken",chance:0.5 } },
      { name:"개관철위산",minMastery:30,dmg:460, desc:"화산 영역전개.", statusApply:{ target:"enemy",statusId:"burn",chance:1.0 } },
    ],
  },
  dagon: { name:"다곤",         emoji:"🌊", grade:"준특급", atk:118, def:108, spd:96,  maxHp:1620, domain:"탕온평선", desc:"수중 저주령.", lore:"\"물은 모든 것을 삼킨다.\"",
    skills:[
      { name:"물고기 소환",  minMastery:0,  dmg:125, desc:"물고기 떼 소환.", statusApply:{ target:"enemy",statusId:"poison",chance:0.4 } },
      { name:"해수 폭발",    minMastery:5,  dmg:205, desc:"해수 압축 발사.", statusApply:{ target:"enemy",statusId:"weaken",chance:0.5 } },
      { name:"조류 소용돌이",minMastery:15, dmg:295, desc:"거대 소용돌이.", statusApply:{ target:"enemy",statusId:"freeze",chance:0.4 } },
      { name:"탕온평선",     minMastery:30, dmg:450, desc:"물고기 영역전개.", statusApply:{ target:"enemy",statusId:"poison",chance:0.9 } },
    ],
  },
  hanami: { name:"하나미",       emoji:"🌿", grade:"준특급", atk:115, def:118, spd:93,  maxHp:1750, domain:null,       desc:"식물 저주령.", lore:"\"자연은 인간의 적이 아니다.\"",
    skills:[
      { name:"나무뿌리 채찍",minMastery:0, dmg:122, desc:"뿌리 채찍.", statusApply:{ target:"enemy",statusId:"weaken",chance:0.3 } },
      { name:"꽃비",         minMastery:5, dmg:198, desc:"독성 꽃가루.", statusApply:{ target:"enemy",statusId:"poison",chance:0.6 } },
      { name:"대지의 저주",  minMastery:15,dmg:285, desc:"대지 저주 에너지.", statusApply:{ target:"enemy",statusId:"poison",chance:0.7 } },
      { name:"재앙의 꽃",    minMastery:30,dmg:425, desc:"거대 꽃 흡수.", statusApply:{ target:"enemy",statusId:"stun",chance:0.6 } },
    ],
  },
  mahito: { name:"마히토",       emoji:"🩸", grade:"준특급", atk:120, def:98,  spd:110, maxHp:1560, domain:"자폐원돈과",desc:"영혼 변형 저주령.", lore:"\"영혼이 육체를 만드는 거야.\"",
    skills:[
      { name:"영혼 변형",  minMastery:0, dmg:128, desc:"영혼 변형 타격.", statusApply:{ target:"enemy",statusId:"weaken",chance:0.4 } },
      { name:"무위전변",   minMastery:5, dmg:212, desc:"신체 변형.", statusApply:{ target:"enemy",statusId:"stun",chance:0.4 } },
      { name:"편사지경체", minMastery:15,dmg:308, desc:"무한 변형.", statusApply:{ target:"enemy",statusId:"weaken",chance:0.6 } },
      { name:"자폐원돈과", minMastery:30,dmg:455, desc:"영혼·육체 경계 붕괴.", statusApply:{ target:"enemy",statusId:"freeze",chance:0.8 } },
    ],
  },
  todo: { name:"토도 아오이",   emoji:"💪", grade:"1급",   atk:128, def:108, spd:112, maxHp:1500, domain:null,       desc:"보조 공격술 구사.", lore:"\"너의 이상형은 어떤 여자야?\"",
    skills:[
      { name:"부기우기",  minMastery:0,  dmg:130, desc:"위치 전환 + 빙결.", statusApply:{ target:"enemy",statusId:"freeze",chance:0.40 } },
      { name:"브루탈 펀치",minMastery:5, dmg:215, desc:"최대 저주력 주먹.", statusApply:{ target:"enemy",statusId:"weaken",chance:0.30 } },
      { name:"흑섬",      minMastery:15, dmg:320, desc:"이타도리에게 배운 흑섬.", statusApply:{ target:"enemy",statusId:"burn",chance:0.45 } },
      { name:"전투본능",  minMastery:30, dmg:200, desc:"전투본능 버프! ATK↑↑", statusApply:{ target:"self",statusId:"battleInstinct",chance:1.0 } },
    ],
  },
  hakari: { name:"하카리 키리토",emoji:"🎰", grade:"1급",   atk:125, def:105, spd:110, maxHp:1650, domain:"질풍강운", desc:"복권 술식.", lore:"\"운도 실력이다! 철저하게 즐기자!\"",
    skills:[
      { name:"험한 도박",minMastery:0,  dmg:125, desc:"운에 맡긴 공격.", statusApply:{ target:"enemy",statusId:"stun",chance:0.3 } },
      { name:"질풍열차", minMastery:5,  dmg:210, desc:"열차처럼 돌진.", statusApply:{ target:"enemy",statusId:"weaken",chance:0.4 } },
      { name:"유한 소설",minMastery:15, dmg:315, desc:"불멸의 몸으로 싸운다.", statusApply:{ target:"self",statusId:"battleInstinct",chance:0.6 } },
      { name:"질풍강운", minMastery:30, dmg:480, desc:"영역전개 — 운이 터진다!", statusApply:{ target:"enemy",statusId:"freeze",chance:0.7 } },
    ],
  },
};

// ════════════════════════════════════════════════════════
// ── 적 데이터
// ════════════════════════════════════════════════════════
const ENEMIES = [
  { id:"e1", name:"저급 저주령",      emoji:"👹", hp:550,  atk:38,  def:12,  xp:75,   crystals:18,  masteryXp:1,  fingers:0, statusAttack:null },
  { id:"e2", name:"1급 저주령",       emoji:"👺", hp:1100, atk:80,  def:40,  xp:190,  crystals:40,  masteryXp:3,  fingers:0, statusAttack:{ statusId:"poison",chance:0.3 } },
  { id:"e3", name:"특급 저주령",      emoji:"💀", hp:2400, atk:128, def:72,  xp:440,  crystals:90,  masteryXp:7,  fingers:0, statusAttack:{ statusId:"burn",chance:0.4 } },
  { id:"e4", name:"저주의 왕 (보스)", emoji:"👑", hp:5500, atk:195, def:110, xp:1000, crystals:200, masteryXp:15, fingers:3, statusAttack:{ statusId:"weaken",chance:0.5 } },
  // ── 스쿠나 보스 (전투에서 랜덤 등장)
  { id:"e_sukuna", name:"료멘 스쿠나 ★BOSS★", emoji:"🔴", hp:5500, atk:200, def:120, xp:1200, crystals:300, masteryXp:20, fingers:1, statusAttack:{ statusId:"burn",chance:0.5 }, isSukunaBoss:true },
];
// 스쿠나 보스 전투 10% 확률로 등장
function pickBattleEnemy() {
  if (Math.random() < 0.10) return ENEMIES[4]; // 스쿠나 보스
  return ENEMIES[Math.floor(Math.random() * 3)];
}

// ── 레이드 보스
const RAID_BOSSES = {
  heian: {
    id:"heian", name:"헤이안 시대 스쿠나", emoji:"👹🔱", hp:11000, atk:400, def:220, xp:3000, crystals:600, masteryXp:30, fingers:3,
    statusAttack:{ statusId:"burn",chance:0.6 },
    desc:"기존 스쿠나의 2배 힘. 완전 각성 상태.",
    domain:"복마어주자 · 완전 해방",
    skills:[
      { name:"세계참",  dmg:700, desc:"세계를 베어버린다!", statusApply:{ target:"enemy",statusId:"weaken",chance:0.7 } },
      { name:"대화재",  dmg:500, desc:"모든 것을 불태운다!", statusApply:{ target:"enemy",statusId:"burn",chance:1.0 } },
      { name:"복마어주자", dmg:600, desc:"궁극 영역전개!", statusApply:{ target:"enemy",statusId:"freeze",chance:0.5 } },
    ],
  },
  mahara: {
    id:"mahara", name:"마허라가라",       emoji:"🐍⚡", hp:5000,  atk:180, def:200, xp:2500, crystals:500, masteryXp:25, fingers:0,
    statusAttack:{ statusId:"stun",chance:0.4 },
    desc:"한 술식에 적응해 피해를 무효화한다!",
    domain:null,
    adaptedSkill: null, // 처음엔 null, 첫 번째 술식 맞으면 적응
    skills:[
      { name:"신의 강타",  dmg:380, desc:"압도적 물리 공격!", statusApply:{ target:"enemy",statusId:"stun",chance:0.5 } },
      { name:"저주 흡수",  dmg:280, desc:"저주를 흡수해 역공!", statusApply:{ target:"enemy",statusId:"weaken",chance:0.6 } },
      { name:"제왕의 위압",dmg:320, desc:"위압으로 사기 저하!", statusApply:{ target:"enemy",statusId:"weaken",chance:0.8 } },
    ],
  },
};

const JUJUTSU_ENEMIES = [
  { id:"j1",name:"약화된 저주령",   emoji:"💧",hp:300, atk:25,def:8, xp:55, crystals:12,masteryXp:1, points:1,fingers:0, statusAttack:null,desc:"⚡ 빠르지만 약함 (1포인트)"},
  { id:"j2",name:"중간급 저주령",   emoji:"🌀",hp:620, atk:55,def:28,xp:115,crystals:28,masteryXp:2, points:1,fingers:0, statusAttack:{ statusId:"weaken",chance:0.2},desc:"⚖️ 균형잡힌 몹 (1포인트)"},
  { id:"j3",name:"강화 저주령",     emoji:"🔥",hp:450, atk:75,def:22,xp:95, crystals:23,masteryXp:2, points:1,fingers:0, statusAttack:{ statusId:"burn",chance:0.35},desc:"💥 공격적 (1포인트)"},
  { id:"j4",name:"특수 저주령",     emoji:"☠️",hp:960, atk:88,def:48,xp:190,crystals:45,masteryXp:4, points:2,fingers:0, statusAttack:{ statusId:"poison",chance:0.4},desc:"🧪 독 공격! (2포인트)"},
  { id:"j5",name:"엘리트 저주령",   emoji:"💀",hp:1380,atk:108,def:60,xp:280,crystals:70,masteryXp:6, points:3,fingers:1, statusAttack:{ statusId:"burn",chance:0.5},desc:"⚔️ 강력 (3포인트)"},
  { id:"j6",name:"사멸회유 수호자", emoji:"👹",hp:2100,atk:135,def:82,xp:440,crystals:100,masteryXp:10,points:5,fingers:2,statusAttack:{ statusId:"weaken",chance:0.6},desc:"🏆 최강 수호자 (5포인트)"},
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
function rollGacha(count=1) {
  const total=GACHA_POOL.reduce((s,p)=>s+p.rate,0);
  return Array.from({length:count},()=>{
    let roll=Math.random()*total;
    for (const e of GACHA_POOL) { roll-=e.rate; if (roll<=0) return e.id; }
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
const parties  = {};
const partyInvites  = {};
const pvpSessions   = {};
const pvpChallenges = {};
const raidSessions  = {}; // partyId -> raidSession
let _partyIdSeq=1, _pvpIdSeq=1;

// ════════════════════════════════════════════════════════
// ── 주력 스킬
// ════════════════════════════════════════════════════════
function getMainSkill(player, charId) {
  if (charId==="gojo"   && player.mainSkillUnlocked?.gojo)   return { name:"자폭 무라사키", dmg:640, desc:"모든 힘을 쏟아붓는 자폭! 사용 후 HP 1" };
  if (charId==="sukuna" && player.mainSkillUnlocked?.sukuna) return { name:"세계참", dmg:700, desc:"세계조차 베어버린다!" };
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
      wins:0, losses:0, mastery:{ itadori:0 },
      reverseOutput:1.0, reverseCooldown:0,
      cullingBest:0, jujutsuBest:0,
      usedCodes:[], lastDaily:0,
      pvpWins:0, pvpLosses:0,
      statusEffects:[], skillCooldown:0,
      dailyStreak:0, sukunaFingers:0,
      kogane:null, koganeGachaCount:0,
      mainSkillUnlocked:{ gojo:false, sukuna:false },
      materials:{}, equippedWeapon:null, craftedWeapons:[],
      quests:{}, raidKills:0,
    };
    savePlayer(userId);
  }
  const p=players[userId];
  let changed=false;
  if (p.name!==username&&username!=="플레이어") { p.name=username; changed=true; }
  const defaults={ reverseOutput:1.0,reverseCooldown:0,mastery:{},cullingBest:0,jujutsuBest:0,usedCodes:[],lastDaily:0,pvpWins:0,pvpLosses:0,statusEffects:[],skillCooldown:0,dailyStreak:0,sukunaFingers:0,kogane:null,koganeGachaCount:0,mainSkillUnlocked:{gojo:false,sukuna:false},materials:{},equippedWeapon:null,craftedWeapons:[],quests:{},raidKills:0 };
  for (const [k,v] of Object.entries(defaults)) { if (p[k]===undefined) { p[k]=typeof v==="object"&&v!==null?JSON.parse(JSON.stringify(v)):v; changed=true; } }
  if (!p.id) { p.id=userId; changed=true; }

  // 스쿠나 자동 잠금해제 (손가락 1개 이상)
  if (isSukunaUnlocked(p) && !p.owned.includes("sukuna")) {
    p.owned.push("sukuna");
    changed=true;
  }

  if (changed) savePlayer(userId);
  return p;
}

function getMastery(player,charId) { return player.mastery?.[charId]||0; }
function getAvailableSkills(player,charId) {
  const m=getMastery(player,charId);
  return CHARACTERS[charId].skills.filter(s=>{
    if (m<s.minMastery) return false;
    if (s.name==="스쿠나 발현"&&(player.sukunaFingers||0)<10) return false;
    return true;
  });
}
function getCurrentSkill(player,charId) { const skills=getAvailableSkills(player,charId); return skills[skills.length-1]||CHARACTERS[charId].skills[0]; }
function getNextSkill(player,charId)    { const m=getMastery(player,charId); return CHARACTERS[charId].skills.find(s=>s.minMastery>m)||null; }

function getPlayerStats(player) {
  const ch=CHARACTERS[player.active];
  const kb=getKoganeBonus(player);
  const ws=getWeaponStats(player);
  let base={ atk:ch.atk, def:ch.def, maxHp:ch.maxHp };

  // 스쿠나: 손가락 보너스
  if (player.active==="sukuna") {
    const bonus=getFingerBonus(player.sukunaFingers||0);
    base.atk+=bonus.atkBonus;
    base.def+=bonus.defBonus;
    base.maxHp+=bonus.hpBonus;
  }
  // 이타도리: 손가락 적은 보너스
  if (player.active==="itadori" && (player.sukunaFingers||0)>0) {
    const bonus=getFingerBonus(player.sukunaFingers||0);
    base.atk+=Math.floor(bonus.atkBonus*0.5);
    base.def+=Math.floor(bonus.defBonus*0.5);
    base.maxHp+=Math.floor(bonus.hpBonus*0.5);
  }

  return {
    atk:  Math.floor(base.atk  * kb.atk)  + ws.atk,
    def:  Math.floor(base.def  * kb.def)  + ws.def,
    maxHp:Math.floor(base.maxHp * kb.hp) + ws.hp,
  };
}

function masteryBar(mastery,charId) {
  const tiers=CHARACTERS[charId].skills.map(s=>s.minMastery);
  const max=tiers[tiers.length-1];
  if (mastery>=max) return "`[MAX]` 모든 스킬 해금!";
  const next=tiers.find(t=>t>mastery)||max;
  const prev=[...tiers].reverse().find(t=>t<=mastery)||0;
  const fill=Math.round(((mastery-prev)/(next-prev))*10);
  return "`"+"█".repeat(Math.max(0,fill))+"░".repeat(Math.max(0,10-fill))+"`"+` ${mastery}/${next}`;
}
function getLevel(xp) { return Math.floor(xp/200)+1; }
function hpBar(cur,max,len=10) {
  const pct=Math.max(0,Math.min(1,cur/max));
  const fill=Math.round(pct*len);
  const color=pct>0.5?"🟩":pct>0.25?"🟨":"🟥";
  return color.repeat(Math.max(0,fill))+"⬛".repeat(Math.max(0,len-fill));
}
function isMakiAwakened(player) {
  if (player.active!=="maki") return false;
  const stats=getPlayerStats(player);
  return player.hp<=Math.floor(stats.maxHp*CHARACTERS["maki"].awakening.threshold);
}
function calcDmg(atk,def,mult=1) {
  const variance=0.70+Math.random()*0.60;
  return Math.max(1,Math.floor((atk*variance-def*0.22)*mult));
}
function calcDmgForPlayer(player,enemyDef,baseMult=1) {
  const stats=getPlayerStats(player);
  let mult=baseMult*getWeakenMult(player.statusEffects);
  if (isMakiAwakened(player)) mult*=CHARACTERS["maki"].awakening.dmgMult;
  return calcDmg(stats.atk,enemyDef,mult);
}
function calcSkillDmgForPlayer(player,baseSkillDmg) {
  let dmg=baseSkillDmg+Math.floor(Math.random()*60);
  dmg=Math.floor(dmg*getWeakenMult(player.statusEffects));
  if (isMakiAwakened(player)) dmg=Math.floor(dmg*CHARACTERS["maki"].awakening.dmgMult);
  const kb=getKoganeBonus(player);
  dmg=Math.floor(dmg*kb.atk);
  const ws=getWeaponStats(player);
  dmg+=Math.floor(ws.atk*0.5);
  return dmg;
}
function applySkillStatus(skill,defenderObj,attackerObj=null) {
  if (!skill.statusApply) return [];
  const {target,statusId,chance}=skill.statusApply;
  if (Math.random()>chance) return [];
  const def=STATUS_EFFECTS[statusId];
  if (target==="enemy") { applyStatus(defenderObj,statusId); return [`${def.emoji}**${def.name}** 상태이상!(${def.duration}턴)`]; }
  if (target==="self"&&attackerObj) { applyStatus(attackerObj,statusId); return [`${def.emoji}**${def.name}** 발동!(${def.duration}턴)`]; }
  return [];
}
function tickCooldowns(player) { if (player.reverseCooldown>0) player.reverseCooldown--; if (player.skillCooldown>0) player.skillCooldown--; }

// ════════════════════════════════════════════════════════
// ── 파티/PvP 유틸
// ════════════════════════════════════════════════════════
function getPartyId(userId) { return Object.keys(parties).find(pid=>parties[pid]?.members?.includes(userId))||null; }
function getParty(userId)   { const pid=getPartyId(userId); return pid?parties[pid]:null; }
function getPvpSessionByUser(userId) { return Object.values(pvpSessions).find(s=>s.p1Id===userId||s.p2Id===userId)||null; }
function pvpSelf(session,userId) {
  return session.p1Id===userId
    ?{id:session.p1Id,hpKey:"hp1",statusKey:"status1",skillCdKey:"skillCd1",reverseCdKey:"reverseCd1"}
    :{id:session.p2Id,hpKey:"hp2",statusKey:"status2",skillCdKey:"skillCd2",reverseCdKey:"reverseCd2"};
}
function pvpOpponent(session,userId) {
  return session.p1Id===userId
    ?{id:session.p2Id,hpKey:"hp2",statusKey:"status2",skillCdKey:"skillCd2",reverseCdKey:"reverseCd2"}
    :{id:session.p1Id,hpKey:"hp1",statusKey:"status1",skillCdKey:"skillCd1",reverseCdKey:"reverseCd1"};
}

// ════════════════════════════════════════════════════════
// ── 컬링/사멸회유 유틸
// ════════════════════════════════════════════════════════
function getCullingPool(wave) {
  if (wave<=3)  return ["e1","e1","e1","e2"];
  if (wave<=7)  return ["e1","e2","e2","e2","e3"];
  if (wave<=14) return ["e2","e2","e3","e3","e3"];
  return ["e2","e3","e3","e4","e4"];
}
function pickCullingEnemy(wave) {
  const pool=getCullingPool(wave);
  const id=pool[Math.floor(Math.random()*pool.length)];
  const base=ENEMIES.find(e=>e.id===id);
  const scale=1+(wave-1)*0.05;
  return { ...base, hp:Math.floor(base.hp*scale), atk:Math.floor(base.atk*scale), def:Math.floor(base.def*scale), xp:Math.floor(base.xp*scale), crystals:Math.floor(base.crystals*scale), currentHp:Math.floor(base.hp*scale), statusEffects:[] };
}
function generateJujutsuChoices(wave) {
  const pool=wave<=3?["j1","j1","j2","j3"]:wave<=7?["j2","j3","j3","j4"]:wave<=12?["j3","j4","j4","j5"]:["j4","j5","j5","j6"];
  const ids=[];
  for (const id of [...pool].sort(()=>Math.random()-0.5)) { if (!ids.includes(id)) ids.push(id); if (ids.length===3) break; }
  while (ids.length<3) { const fb=pool[Math.floor(Math.random()*pool.length)]; if (!ids.includes(fb)) ids.push(fb); }
  return ids.slice(0,3).map(id=>{
    const base=JUJUTSU_ENEMIES.find(e=>e.id===id);
    const scale=1+(wave-1)*0.04;
    return {...base, hp:Math.floor(base.hp*scale), atk:Math.floor(base.atk*scale), def:Math.floor(base.def*scale), xp:Math.floor(base.xp*scale), crystals:Math.floor(base.crystals*scale), statusEffects:[]};
  });
}

// ════════════════════════════════════════════════════════
// ── 전투 처리 공통
// ════════════════════════════════════════════════════════
async function processBattleWin(player, enemy) {
  const kb=getKoganeBonus(player);
  const xpGain=Math.floor((enemy.xp||1)*kb.xp);
  const crystalGain=Math.floor((enemy.crystals||0)*kb.crystal);
  player.xp+=xpGain; player.crystals+=crystalGain;
  const masteryGain=enemy.masteryXp||1;
  player.mastery[player.active]=(player.mastery[player.active]||0)+masteryGain;
  player.wins++;

  const drops=rollDrops(enemy.id||"e1");
  addMaterials(player,drops);

  // 스쿠나 보스 처치 → 손가락 +1 100%
  if (enemy.isSukunaBoss) {
    const prev=player.sukunaFingers||0;
    player.sukunaFingers=Math.min(SUKUNA_FINGER_MAX,prev+(enemy.fingers||1));
    // 스쿠나 캐릭터 자동 잠금해제
    if (!player.owned.includes("sukuna")) player.owned.push("sukuna");
  } else if (enemy.fingers) {
    player.sukunaFingers=Math.min(SUKUNA_FINGER_MAX,(player.sukunaFingers||0)+enemy.fingers);
  }

  // 주력 스킬 언락
  let unlockMsg="";
  if (player.active==="gojo"&&!player.mainSkillUnlocked?.gojo&&player.wins>=20)   { if (!player.mainSkillUnlocked) player.mainSkillUnlocked={}; player.mainSkillUnlocked.gojo=true;   unlockMsg="\n🎉 **고조의 주력 스킬 '자폭 무라사키' 획득!**"; }
  if (player.active==="sukuna"&&!player.mainSkillUnlocked?.sukuna&&(player.sukunaFingers||0)>=10) { if (!player.mainSkillUnlocked) player.mainSkillUnlocked={}; player.mainSkillUnlocked.sukuna=true; unlockMsg="\n🎉 **스쿠나의 주력 스킬 '세계참' 획득!**"; }

  updateQuestProgress(player,"battle_win",1);
  if (enemy.id==="e3"||enemy.id==="e4"||enemy.isSukunaBoss) updateQuestProgress(player,"boss_kill",1);

  const dropText=Object.keys(drops).length>0?`\n📦 **재료:** ${formatDrops(drops)}`:"";
  const fingerMsg=enemy.isSukunaBoss?`\n👹 **스쿠나 손가락 획득!** 현재 ${player.sukunaFingers}/${SUKUNA_FINGER_MAX} — ${getFingerBonus(player.sukunaFingers).label}`:"";
  const sukunaUnlock=(enemy.isSukunaBoss&&!player.owned.includes("sukuna"))?"\n🔓 **스쿠나 캐릭터 잠금해제!**":"";
  const questDone=getNewlyCompletedQuestMsg(player);

  return new EmbedBuilder()
    .setTitle("🏆 전투 승리!")
    .setColor(enemy.isSukunaBoss?0x8b0000:0xF5C842)
    .setDescription([
      "```ansi",`\u001b[1;33m╔═══════════════════╗`,`\u001b[1;33m║  ✨  V I C T O R Y  ✨  ║`,`\u001b[1;33m╚═══════════════════╝`,"```",
      `> **${enemy.name}** 처치!`,
      `> ⭐ XP **+${xpGain}** | 💎 **+${crystalGain}** | 📈 숙련 **+${masteryGain}**`,
      dropText, fingerMsg, sukunaUnlock, unlockMsg, questDone,
    ].filter(Boolean).join("\n"))
    .addFields({ name:"📊 현재 상태", value:`> 💚 HP: **${Math.max(0,player.hp)}** | 💎 **${player.crystals}** | ⚔️ **${player.wins}**승 **${player.losses}**패` })
    .setFooter({ text:`LV.${getLevel(player.xp)} | !전투 으로 다시 싸우기` });
}

function getNewlyCompletedQuestMsg(player) {
  initQuests(player);
  const msgs=[];
  for (const qp of player.quests.daily||[])  { if (qp.done&&!qp.claimed) { const def=DAILY_QUESTS.find(q=>q.id===qp.id);  if (def) msgs.push(`> 📋 **일일퀘 완료!** ${def.name} — \`!퀘스트\`로 수령`); } }
  for (const qp of player.quests.weekly||[]) { if (qp.done&&!qp.claimed) { const def=WEEKLY_QUESTS.find(q=>q.id===qp.id); if (def) msgs.push(`> 📅 **주간퀘 완료!** ${def.name} — \`!퀘스트\`로 수령`); } }
  return msgs.join("\n");
}

// ════════════════════════════════════════════════════════
// ── 고퀄 프로필 카드 임베드
// ════════════════════════════════════════════════════════
function profileEmbed(player) {
  const ch=CHARACTERS[player.active];
  const stats=getPlayerStats(player);
  const mastery=getMastery(player,player.active);
  const awakened=isMakiAwakened(player);
  const lv=getLevel(player.xp);
  const xpNow=player.xp%200;
  const fingers=player.sukunaFingers||0;
  const kb=getKoganeBonus(player);
  const kogane=player.kogane;
  const kg=kogane?KOGANE_GRADES[kogane.grade]:null;
  const gradeInfo=GACHA_RARITY[ch.grade]||GACHA_RARITY["3급"];
  const weapon=player.equippedWeapon?WEAPONS[player.equippedWeapon]:null;
  const ws=getWeaponStats(player);

  const hpPct=Math.max(0,player.hp)/stats.maxHp;
  const HP_LEN=16, hpFill=Math.round(hpPct*HP_LEN);
  const hpColor=hpPct>0.6?"🟢":hpPct>0.3?"🟡":"🔴";
  const hpBarStr=`${hpColor} \`${"█".repeat(Math.max(0,hpFill))}${"░".repeat(Math.max(0,HP_LEN-hpFill))}\``;

  const XP_LEN=16, xpFill=Math.round((xpNow/200)*XP_LEN);
  const xpBarStr=`\`${"▰".repeat(Math.max(0,xpFill))}${"▱".repeat(Math.max(0,XP_LEN-xpFill))}\``;

  const fingerBar=fingers>0?`${"🔴".repeat(Math.min(fingers,10))}${"⬛".repeat(Math.max(0,10-fingers))} **${fingers}/${SUKUNA_FINGER_MAX}**`:`⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛ **0/${SUKUNA_FINGER_MAX}**`;

  initQuests(player);
  const dailyDone=(player.quests.daily||[]).filter(q=>q.done&&!q.claimed).length;
  const weeklyDone=(player.quests.weekly||[]).filter(q=>q.done&&!q.claimed).length;

  const matSummary=Object.entries(player.materials||{}).filter(([,qty])=>qty>0).map(([id,qty])=>`${MATERIALS[id]?.emoji||""}${qty}`).join(" ")||"없음";

  // 상단 배너
  const titleLine=awakened
    ?`🔥 ══ 천여주박 각성 ══ ${player.name} ══ 🔥`
    :`${gradeInfo.effect} ${player.name} ${gradeInfo.effect}`;

  const embed=new EmbedBuilder()
    .setTitle(titleLine)
    .setColor(awakened?0xFF2200:gradeInfo.color)
    .setDescription([
      "```ansi",
      `\u001b[1;36m╔══════════════════════════════════════╗`,
      `\u001b[1;36m║  ${ch.emoji}  ${ch.name.padEnd(18)} [${ch.grade}]  ║`,
      `\u001b[1;33m║  LV.${String(lv).padEnd(4)} XP ${xpBarStr}  ║`,
      `\u001b[1;32m║  ${hpBarStr}  ${String(Math.max(0,player.hp)).padStart(5)}/${stats.maxHp} HP  ║`,
      `\u001b[1;36m╚══════════════════════════════════════╝`,
      "```",
    ].join("\n"));

  embed.addFields(
    {
      name:"⚔️ ─── 전투 스탯 ────────────────────",
      value:[
        `> 🗡️ ATK **${stats.atk}**   🛡️ DEF **${stats.def}**   💚 MaxHP **${stats.maxHp}**`,
        weapon?`> ${weapon.emoji} 장착: **${weapon.name}** (ATK+${ws.atk} DEF+${ws.def} HP+${ws.hp})`:`> ⚔️ 장착 주구: 없음`,
        `> 🩸 상태이상: ${statusStr(player.statusEffects)}`,
        `> ⚡ 술식 CD: ${player.skillCooldown>0?`**${player.skillCooldown}턴**`:"✅"}   ♻ 반전 CD: ${player.reverseCooldown>0?`**${player.reverseCooldown}턴**`:"✅"}`,
      ].join("\n"), inline:false,
    },
    {
      name:"📊 ─── 전적 & 기록 ──────────────────",
      value:[
        `> ⚔️ 일반 **${player.wins}승 ${player.losses}패**   🥊 PvP **${player.pvpWins}승 ${player.pvpLosses}패**`,
        `> 🌊 컬링 최고: **WAVE ${player.cullingBest}**   🎯 사멸회유: **${player.jujutsuBest}pt**`,
        `> 💎 크리스탈: **${player.crystals}**   🧪 회복약: **${player.potion}개**`,
      ].join("\n"), inline:false,
    },
    {
      name:"👹 ─── 스쿠나 손가락 ─────────────────",
      value:[
        `> ${fingerBar}`,
        `> **${getFingerBonus(fingers).label}**`,
        fingers>0?`> ATK+${getFingerBonus(fingers).atkBonus}  DEF+${getFingerBonus(fingers).defBonus}  HP+${getFingerBonus(fingers).hpBonus}`:`> 전투에서 스쿠나를 처치하면 획득!`,
        isSukunaUnlocked(player)?`> ✅ 스쿠나 캐릭터 잠금해제됨`:`> 🔒 스쿠나 보스를 처치해 해금!`,
      ].join("\n"), inline:false,
    },
    {
      name:"🐾 ─── 코가네 펫 ───────────────────",
      value:kogane&&kg
        ?`> ${kg.emoji} **[${kogane.grade}]** ${kg.stars}\n> ${kg.passiveDesc}`
        :`> 없음 — \`!코가네가챠\` (200💎)`, inline:false,
    },
    {
      name:"📦 ─── 재료 인벤토리 ─────────────────",
      value:`> ${matSummary}\n> \`!재료\` 로 상세 확인`, inline:false,
    },
    {
      name:"📋 ─── 퀘스트 현황 ──────────────────",
      value:`> 📋 일일 수령가능 **${dailyDone}개**   📅 주간 수령가능 **${weeklyDone}개**\n> \`!퀘스트\` 로 확인`, inline:false,
    },
    {
      name:"🎭 ─── 보유 캐릭터 ──────────────────",
      value:player.owned.map(id=>{
        const c=CHARACTERS[id]; const m=getMastery(player,id); const ri=GACHA_RARITY[c.grade]||GACHA_RARITY["3급"];
        return `> ${id===player.active?"▶️":"　"} ${c.emoji} **${c.name}** \`${c.grade}\` ${ri.stars} 숙련\`${m}\``;
      }).join("\n")||"> 없음", inline:false,
    },
  );

  embed.setFooter({ text:`!전투 !컬링 !사멸회유 !결투 !레이드 !가챠 | ${player.name}` }).setTimestamp();
  return embed;
}

// ════════════════════════════════════════════════════════
// ── 기타 임베드들
// ════════════════════════════════════════════════════════
function questEmbed(player) {
  initQuests(player);
  const embed=new EmbedBuilder().setTitle("📋 퀘스트 현황").setColor(0x7C5CFC).setTimestamp();
  const dailyLines=(player.quests.daily||[]).map(qp=>{
    const def=DAILY_QUESTS.find(q=>q.id===qp.id); if (!def) return "";
    const bar=`\`${"█".repeat(Math.floor(qp.progress/def.target*8))}${"░".repeat(8-Math.floor(qp.progress/def.target*8))}\``;
    const status=qp.claimed?"✅ 수령 완료":qp.done?"🎁 수령 가능 (`!퀘보상 일`)":`${bar} ${qp.progress}/${def.target}`;
    const rew=`+${def.reward.crystals}💎 +${def.reward.xp}XP`;
    return `> **${def.name}** — ${def.desc}\n> ${status}  |  보상: ${rew}`;
  }).filter(Boolean).join("\n\n");
  const weeklyLines=(player.quests.weekly||[]).map(qp=>{
    const def=WEEKLY_QUESTS.find(q=>q.id===qp.id); if (!def) return "";
    const bar=`\`${"█".repeat(Math.floor(qp.progress/def.target*8))}${"░".repeat(8-Math.floor(qp.progress/def.target*8))}\``;
    const status=qp.claimed?"✅ 수령 완료":qp.done?"🎁 수령 가능 (`!퀘보상 주`)":`${bar} ${qp.progress}/${def.target}`;
    const rew=`+${def.reward.crystals}💎 +${def.reward.xp}XP`;
    return `> **${def.name}** — ${def.desc}\n> ${status}  |  보상: ${rew}`;
  }).filter(Boolean).join("\n\n");
  embed.addFields(
    { name:"📋 ─── 일일 퀘스트 ───────────────────", value:dailyLines||"> 없음", inline:false },
    { name:"📅 ─── 주간 퀘스트 ───────────────────", value:weeklyLines||"> 없음", inline:false },
  );
  embed.setFooter({ text:"!퀘보상 일 [번호] | !퀘보상 주 [번호]" });
  return embed;
}

function materialsEmbed(player) {
  const mats=player.materials||{};
  const lines=Object.entries(MATERIALS).map(([id,m])=>`> ${m.emoji} **${m.name}** ×${mats[id]||0}  — ${m.desc}`);
  return new EmbedBuilder().setTitle("📦 재료 인벤토리").setColor(0x7c5cfc).setDescription(lines.join("\n")).setFooter({ text:"!주구목록 | !주구제작 [ID] | !장착 [ID] | !해제" });
}

function weaponListEmbed(player) {
  const mats=player.materials||{};
  const lines=Object.entries(WEAPONS).map(([id,w])=>{
    const canCraft=Object.entries(w.recipe).every(([m,qty])=>(mats[m]||0)>=qty);
    const owned=(player.craftedWeapons||[]).includes(id);
    const equipped=player.equippedWeapon===id;
    const recipeStr=Object.entries(w.recipe).map(([m,qty])=>`${MATERIALS[m]?.emoji||""}${mats[m]||0}/${qty}`).join(" ");
    return `> ${equipped?"⚔️":owned?"✅":"🔒"} **${w.emoji} ${w.name}** \`[${w.grade}]\`\n> ATK+${w.atkBonus} DEF+${w.defBonus} HP+${w.hpBonus}  재료: ${recipeStr}  ${canCraft&&!owned?"**✨ 제작 가능!**":owned?"(보유)":""}`;
  });
  return new EmbedBuilder().setTitle("⚔️ 주구 목록").setColor(0xF5C842).setDescription(lines.join("\n\n")).setFooter({ text:"!주구제작 [ID] | !장착 [ID] | !해제" });
}

function hpBar2(cur,max) {
  const pct=Math.max(0,Math.min(1,cur/max));
  const fill=Math.round(pct*12);
  return `${"█".repeat(Math.max(0,fill))}${"░".repeat(Math.max(0,12-fill))}`;
}

function battleEmbed(player, enemy, log=[]) {
  const ch=CHARACTERS[player.active];
  const stats=getPlayerStats(player);
  const awakened=isMakiAwakened(player);
  const isBoss=enemy.isSukunaBoss;
  const hpPct=Math.max(0,player.hp)/stats.maxHp;
  const ePct=Math.max(0,enemy.currentHp)/enemy.hp;
  return new EmbedBuilder()
    .setTitle(isBoss?"🔴 ≪ 스쿠나 보스 출현! ≫":awakened?"🔥 전투 [천여주박 각성]":"⚔️ 전투")
    .setColor(isBoss?0x8b0000:awakened?0xFF2200:0xe63946)
    .setDescription(log.length?log.join("\n"):"⚔️ 전투 시작!")
    .addFields(
      { name:`${ch.emoji} ${player.name}${awakened?" 🔥":""}`, value:[`\`${hpBar2(player.hp,stats.maxHp)}\` ${Math.max(0,player.hp)}/${stats.maxHp}`,`🩸 ${statusStr(player.statusEffects)} | ⚡\`${player.skillCooldown>0?player.skillCooldown+"턴":"가능"}\``].join("\n"), inline:true },
      { name:`${enemy.emoji} ${enemy.name}`,                   value:[`\`${hpBar2(enemy.currentHp,enemy.hp)}\` ${Math.max(0,enemy.currentHp)}/${enemy.hp}`,`🩸 ${statusStr(enemy.statusEffects)}`].join("\n"),                                          inline:true },
    )
    .setFooter({ text:`흑섬 10% 확률 | 스킬 CD: ${player.skillCooldown}턴` });
}

function cullingEmbed(player, session, log=[]) {
  const ch=CHARACTERS[player.active];
  const stats=getPlayerStats(player);
  const enemy=session.currentEnemy;
  const awakened=isMakiAwakened(player);
  return new EmbedBuilder()
    .setTitle(`${awakened?"🔥 ":""}⚔️ 컬링 게임 — 🌊 WAVE ${session.wave}`)
    .setColor(awakened?0xFF2200:session.wave>=15?0xF5C842:session.wave>=8?0xe63946:0x7C5CFC)
    .setDescription(log.join("\n")||"⚔️ 새 파도!")
    .addFields(
      { name:`${ch.emoji} 내 HP`, value:`\`${hpBar2(player.hp,stats.maxHp)}\` **${Math.max(0,player.hp)}/${stats.maxHp}**${awakened?" 🔥":""}\n${statusStr(player.statusEffects)} | ⚡\`${player.skillCooldown>0?player.skillCooldown+"턴":"가능"}\``, inline:true },
      { name:`${enemy.emoji} ${enemy.name}`, value:`\`${hpBar2(session.enemyHp,enemy.hp)}\` **${Math.max(0,session.enemyHp)}/${enemy.hp}**\n${statusStr(enemy.statusEffects)}`, inline:true },
      { name:"📊", value:`WAVE **${session.wave}** | 처치 **${session.kills}** | XP **${session.totalXp}** | 💎 **${session.totalCrystals}**`, inline:false },
    )
    .setFooter({ text:`최고기록: WAVE ${player.cullingBest}` });
}

function jujutsuEmbed(player, session, log=[], choices=null) {
  const ch=CHARACTERS[player.active];
  const stats=getPlayerStats(player);
  const awakened=isMakiAwakened(player);
  const embed=new EmbedBuilder()
    .setTitle(`🎯 사멸회유 — WAVE ${session.wave} | 포인트 **${session.points}/15**`)
    .setColor(session.points>=10?0xF5C842:session.points>=5?0xff8c00:0x7C5CFC)
    .setDescription(log.join("\n")||"🎯 사멸회유 진행 중!")
    .addFields(
      { name:`${ch.emoji} 내 HP`, value:`\`${hpBar2(player.hp,stats.maxHp)}\` **${Math.max(0,player.hp)}/${stats.maxHp}**${awakened?" 🔥":""}\n${statusStr(player.statusEffects)}`, inline:false },
      { name:"🎯 포인트", value:`${"🟦".repeat(Math.min(session.points,15))}${"⬜".repeat(Math.max(0,15-session.points))} **${session.points}/15**`, inline:false },
    );
  if (session.currentEnemy) {
    const e=session.currentEnemy;
    embed.addFields({ name:`${e.emoji} ${e.name}`, value:`\`${hpBar2(session.enemyHp,e.hp)}\` **${Math.max(0,session.enemyHp)}/${e.hp}**\n${statusStr(e.statusEffects)} | +${e.points}점`, inline:false });
  }
  if (choices) embed.addFields({ name:"⚔️ 다음 적 선택", value:choices.map((c,i)=>`**[${i+1}]** ${c.emoji} **${c.name}** HP:\`${c.hp}\` | +${c.points}점 — ${c.desc}`).join("\n"), inline:false });
  embed.setFooter({ text:`최고기록: ${player.jujutsuBest}pt` });
  return embed;
}

// ── PvP 임베드 (완벽 개편)
function pvpEmbed(session, log=[]) {
  const p1=players[session.p1Id], p2=players[session.p2Id];
  if (!p1||!p2) return new EmbedBuilder().setTitle("PvP 오류").setColor(0xe63946);
  const ch1=CHARACTERS[p1.active], ch2=CHARACTERS[p2.active];
  const s1=getPlayerStats(p1), s2=getPlayerStats(p2);
  const hpPct1=Math.max(0,session.hp1)/s1.maxHp;
  const hpPct2=Math.max(0,session.hp2)/s2.maxHp;
  const isP1Turn=session.turn===session.p1Id;
  return new EmbedBuilder()
    .setTitle(`⚔️ PvP 결투 — ${p1.name} vs ${p2.name}`)
    .setColor(0xF5C842)
    .setDescription(log.length?log.join("\n"):"⚔️ 결투 시작!")
    .addFields(
      {
        name:`${ch1.emoji} ${p1.name} [${ch1.grade}] ${isP1Turn?"◀ 현재 턴":""}`,
        value:[
          `\`${hpBar2(session.hp1,s1.maxHp)}\` **${Math.max(0,session.hp1)}/${s1.maxHp}**`,
          `${statusStr(session.status1)} | ⚡\`${session.skillCd1>0?session.skillCd1+"턴":"가능"}\``,
        ].join("\n"), inline:true,
      },
      {
        name:`${ch2.emoji} ${p2.name} [${ch2.grade}] ${!isP1Turn?"◀ 현재 턴":""}`,
        value:[
          `\`${hpBar2(session.hp2,s2.maxHp)}\` **${Math.max(0,session.hp2)}/${s2.maxHp}**`,
          `${statusStr(session.status2)} | ⚡\`${session.skillCd2>0?session.skillCd2+"턴":"가능"}\``,
        ].join("\n"), inline:true,
      },
      { name:"📊", value:`라운드 **${session.round}** | **${isP1Turn?p1.name:p2.name}**의 차례`, inline:false },
    )
    .setFooter({ text:"술식 5턴 CD | 반전 3턴 CD | 영역전개 1회 | 흑섬 10%" });
}

// ── 레이드 임베드
function raidEmbed(party, session, log=[]) {
  const boss=session.boss;
  const memberLines=party.members.map(uid=>{
    const p=players[uid]; if (!p) return `> ❓ unknown`;
    const ch=CHARACTERS[p.active], stats=getPlayerStats(p);
    const pct=Math.max(0,p.hp)/stats.maxHp;
    const hpIcon=pct>0.5?"🟢":pct>0.25?"🟡":"🔴";
    return `> ${party.leader===uid?"👑":"👤"} **${p.name}** ${ch.emoji} ${hpIcon}\`${hpBar2(p.hp,stats.maxHp)}\` ${Math.max(0,p.hp)}/${stats.maxHp}  ${statusStr(p.statusEffects)}`;
  }).join("\n");
  const adaptedNote=boss.id==="mahara"&&session.adaptedSkill?`\n> 🔰 **적응된 술식:** ${session.adaptedSkill} (이 술식 무효!)`:"";
  return new EmbedBuilder()
    .setTitle(`💥 레이드: ${boss.emoji} ${boss.name}`)
    .setColor(boss.id==="heian"?0x8b0000:0x4a0000)
    .setDescription(log.length?log.join("\n"):"> 레이드 시작!")
    .addFields(
      { name:`${boss.emoji} 보스 HP`, value:`\`${hpBar2(session.bossHp,boss.hp)}\` **${Math.max(0,session.bossHp)}/${boss.hp}**\n${statusStr(session.bossStatus||[])}${adaptedNote}`, inline:false },
      { name:`👥 파티원 (${party.members.length}명)`, value:memberLines||"> 없음", inline:false },
      { name:"📊 현황", value:`총 피해: **${session.totalDmg||0}** | 단계: ${session.phase||1}`, inline:false },
    )
    .setFooter({ text:"파티원 모두 협력해 보스를 처치하라!" });
}

// ── 가챠 임베드
function gachaLoadingEmbed(stage=1) {
  const frames=[
    { title:"🔮 주술 소환 준비...",   color:0x0a0a1e, desc:["```ansi","\u001b[2;30m╔══════════════╗","\u001b[2;34m║  ？  ？  ？  ？  ║","\u001b[2;30m╚══════════════╝","```","> *저주 에너지가 수렴한다...*"].join("\n") },
    { title:"⚡ 저주 에너지 수렴 중!", color:0x1a0533, desc:["```ansi","\u001b[1;35m╔══════════════╗","\u001b[1;35m║  ⚡  ✦  ？？？  ⚡  ║","\u001b[1;35m╚══════════════╝","```","> *임계점에 도달한다...*"].join("\n") },
  ];
  const f=frames[stage-1]||frames[0];
  return new EmbedBuilder().setTitle(f.title).setColor(f.color).setDescription(f.desc);
}
function gachaRevealEmbed(grade) {
  const info=GACHA_RARITY[grade]||GACHA_RARITY["3급"];
  return new EmbedBuilder().setTitle(`${info.effect} ${grade} 등급!`).setColor(info.color).setDescription(`> *${info.stars}  —  ${info.flash}!*`);
}
function gachaResultEmbed(charId, isNew, player) {
  const ch=CHARACTERS[charId], info=GACHA_RARITY[ch.grade]||GACHA_RARITY["3급"];
  return new EmbedBuilder()
    .setTitle(isNew?`${info.effect} ✨ NEW! — ${ch.name} 획득!`:`${info.effect} 중복 — ${ch.name} (+50💎)`)
    .setColor(isNew?info.color:0x4a5568)
    .setDescription(`> *"${ch.lore||ch.desc}"*`)
    .addFields({ name:"🌌 영역전개", value:ch.domain||"없음", inline:true },{ name:"📖 설명", value:ch.desc, inline:false })
    .setFooter({ text:`💎 잔여: ${player.crystals}` });
}
function gacha10ResultEmbed(results, newOnes, dupCrystals, player) {
  const sorted=[...results].sort((a,b)=>{
    const o=["특급","준특급","1급","준1급","2급","3급"]; return o.indexOf(CHARACTERS[a].grade)-o.indexOf(CHARACTERS[b].grade);
  });
  const lines=sorted.map(id=>{
    const ch=CHARACTERS[id], info=GACHA_RARITY[ch.grade]||GACHA_RARITY["3급"], isN=newOnes.includes(id);
    return `${ch.emoji} ${info.stars} **${ch.name}** \`[${ch.grade}]\`${isN?" **✨NEW!**":""}`;
  });
  const legendaries=results.filter(id=>CHARACTERS[id].grade==="특급");
  return new EmbedBuilder()
    .setTitle(legendaries.length>0?`🔱 ⚡ 10연차 — 전설 획득!! ⚡ 🔱`:`🎲 10회 소환 결과`)
    .setColor(legendaries.length>0?0xF5C842:0x7c5cfc)
    .setDescription(lines.join("\n"))
    .addFields(
      { name:"✨ 신규", value:newOnes.length?newOnes.map(id=>`${CHARACTERS[id].emoji} ${CHARACTERS[id].name}`).join(", "):"없음", inline:true },
      { name:"🔄 중복 보상", value:`**+${dupCrystals}** 💎`, inline:true },
      { name:"💎 잔여", value:`**${player.crystals}**`, inline:true },
    );
}
function koganeProfileEmbed(player) {
  const kogane=player.kogane;
  if (!kogane) return new EmbedBuilder().setTitle("🐾 코가네 — 황금 개 펫").setColor(0x4a5568).setDescription("> **코가네**가 없습니다! `!코가네가챠` (200💎)");
  const g=KOGANE_GRADES[kogane.grade];
  return new EmbedBuilder().setTitle(`${g.emoji} 코가네 [${kogane.grade}] ${g.stars}`).setColor(g.color)
    .setDescription(`> **패시브:** ${g.passiveDesc}\n> **스킬:** ${g.skill}`)
    .addFields(
      { name:"📊 스탯 보너스", value:`> ATK+${Math.round(g.atkBonus*100)}%\n> DEF+${Math.round(g.defBonus*100)}%\n> HP+${Math.round(g.hpBonus*100)}%`, inline:true },
      { name:"📈 보상 보너스", value:`> XP+${Math.round(g.xpBonus*100)}%\n> 크리스탈+${Math.round(g.crystalBonus*100)}%`, inline:true },
    ).setFooter({ text:`총 소환: ${player.koganeGachaCount||0}회` });
}
function partyCullingEmbed(party, session, log=[]) {
  const enemy=session.currentEnemy;
  const memberLines=party.members.map(uid=>{
    const p=players[uid]; if (!p) return `> ❓`;
    const ch=CHARACTERS[p.active], stats=getPlayerStats(p), aw=isMakiAwakened(p);
    return `> ${party.leader===uid?"👑":"👤"} **${p.name}** ${ch.emoji} \`${hpBar2(p.hp,stats.maxHp)}\` ${Math.max(0,p.hp)}/${stats.maxHp}${aw?" 🔥":""}`;
  }).join("\n");
  return new EmbedBuilder()
    .setTitle(`⚔️ [파티] 컬링 — 🌊 WAVE ${session.wave}`)
    .setColor(session.wave>=15?0xF5C842:session.wave>=8?0xe63946:0x7C5CFC)
    .setDescription(log.join("\n")||"⚔️ 파티 컬링!")
    .addFields(
      { name:`👥 파티원`, value:memberLines||"없음", inline:false },
      { name:`${enemy.emoji} ${enemy.name}`, value:`\`${hpBar2(session.enemyHp,enemy.hp)}\` **${Math.max(0,session.enemyHp)}/${enemy.hp}**\n${statusStr(enemy.statusEffects||[])}`, inline:false },
      { name:"📊", value:`WAVE **${session.wave}** | 처치 **${session.kills}** | XP **${session.totalXp}** | 💎 **${session.totalCrystals}**`, inline:false },
    );
}

// ════════════════════════════════════════════════════════
// ── 버튼 팩토리
// ════════════════════════════════════════════════════════
const mkBattleButtons = (player) => {
  const canSkill=!player||player.skillCooldown<=0;
  const canReverse=!player||player.reverseCooldown<=0;
  const hasReverse=!player||REVERSE_CHARS.has(player.active);
  const mainSkill=getMainSkill(player,player.active);
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
  const canSkill=session[self.skillCdKey]<=0;
  const canReverse=session[self.reverseCdKey]<=0;
  const player=players[userId];
  const hasReverse=REVERSE_CHARS.has(player?.active);
  const ch=CHARACTERS[player?.active];
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("p_attack").setLabel("⚔️ 공격").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("p_skill").setLabel(`🌀 ${getCurrentSkill(player,player.active).name}`).setStyle(ButtonStyle.Primary).setDisabled(!canSkill),
    new ButtonBuilder().setCustomId("p_domain").setLabel("🌌 영역전개").setStyle(ButtonStyle.Success).setDisabled(!ch?.domain||session[self.hpKey+"_domainUsed"]),
    new ButtonBuilder().setCustomId("p_reverse").setLabel("♻️ 반전").setStyle(ButtonStyle.Secondary).setDisabled(!canReverse||!hasReverse),
    new ButtonBuilder().setCustomId("p_surrender").setLabel("🏳️ 항복").setStyle(ButtonStyle.Secondary),
  );
};
const mkRaidButtons = (player) => {
  const canSkill=!player||player.skillCooldown<=0;
  const canReverse=!player||player.reverseCooldown<=0;
  const hasReverse=!player||REVERSE_CHARS.has(player.active);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("r_attack").setLabel("⚔️ 공격").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("r_skill").setLabel(`🌀 ${getCurrentSkill(player,player.active).name}`).setStyle(ButtonStyle.Primary).setDisabled(!canSkill),
    new ButtonBuilder().setCustomId("r_reverse").setLabel("♻️ 반전").setStyle(ButtonStyle.Secondary).setDisabled(!canReverse||!hasReverse),
    new ButtonBuilder().setCustomId("r_escape").setLabel("🏃 도주").setStyle(ButtonStyle.Secondary),
  );
};

// ── 캐릭터 선택 드롭다운 메뉴
function mkCharSelectMenu(player) {
  const opts = player.owned.map(id => {
    const ch=CHARACTERS[id];
    const ri=GACHA_RARITY[ch.grade]||GACHA_RARITY["3급"];
    const mastery=getMastery(player,id);
    const isActive=player.active===id;
    return new StringSelectMenuOptionBuilder()
      .setLabel(`${ch.name} [${ch.grade}]`)
      .setDescription(`숙련 ${mastery} | ${ri.stars}${isActive?" ◀ 현재 활성":""}`)
      .setValue(id)
      .setEmoji(isActive?"▶️":"🎭")
      .setDefault(isActive);
  });
  if (opts.length===0) {
    opts.push(new StringSelectMenuOptionBuilder().setLabel("보유 캐릭터 없음").setValue("none").setEmoji("❌"));
  }
  const menu=new StringSelectMenuBuilder()
    .setCustomId("char_select")
    .setPlaceholder("활성 캐릭터 선택...")
    .addOptions(opts);
  return new ActionRowBuilder().addComponents(menu);
}

// ════════════════════════════════════════════════════════
// ── 적 반격 (공통)
// ════════════════════════════════════════════════════════
async function doEnemyAttack(player, enemy, log) {
  const stats=getPlayerStats(player);
  const tick=tickStatus(player,stats.maxHp);
  if (tick.log.length) log.push(...tick.log);
  const enemyHit=rollHit(enemy.statusEffects||[],player.statusEffects);
  if (!enemyHit) { log.push(`> ↩️ **${enemy.name}** 공격 빗나감!`); return; }
  const eDmg=calcDmg(enemy.atk,stats.def);
  player.hp=Math.max(0,player.hp-eDmg);
  log.push(`> 💢 **${enemy.name}** 반격! **${eDmg}** 피해!`);
  if (enemy.statusAttack&&Math.random()<(enemy.statusAttack.chance||0.3)) {
    applyStatus(player,enemy.statusAttack.statusId);
    const sdef=STATUS_EFFECTS[enemy.statusAttack.statusId];
    log.push(`> ${sdef.emoji}**${sdef.name}** 상태이상!`);
  }
}

// ════════════════════════════════════════════════════════
// ── 일반 전투 핸들러
// ════════════════════════════════════════════════════════
async function handleBattleAction(interaction, player, battle, action) {
  const enemy=battle.enemy;
  const log=[];

  if (action==="b_run") {
    delete battles[interaction.user.id];
    return interaction.update({ content:"🏃 전투에서 도주!", embeds:[], components:[] });
  }
  if (action==="b_reverse") {
    if (!REVERSE_CHARS.has(player.active)) return interaction.reply({ content:"❌ 반전술식 불가!", ephemeral:true });
    const stats=getPlayerStats(player);
    const heal=Math.floor(stats.maxHp*0.4);
    player.hp=Math.min(stats.maxHp,player.hp+heal);
    player.reverseCooldown=3;
    player.statusEffects=player.statusEffects.filter(s=>s.id==="battleInstinct");
    log.push(`> ♻️ **${heal}** HP 회복! 상태이상 해제!`);
    tickCooldowns(player); savePlayer(interaction.user.id);
    return interaction.update({ embeds:[battleEmbed(player,enemy,log)], components:[mkBattleButtons(player)] });
  }

  if (isIncapacitated(player.statusEffects)) return interaction.reply({ content:"❌ 상태이상 행동 불가!", ephemeral:true });

  // ── 공격 / 술식 / 주력 스킬
  let dmg=0, isBlack=false, skillUsed=null;
  const hit=rollHit(player.statusEffects,enemy.statusEffects);

  if (action==="b_attack") {
    if (!hit) { log.push("⚡ 공격 **빗나감!**"); }
    else {
      dmg=calcDmgForPlayer(player,enemy.def);
      isBlack=isBlackFlash();
      if (isBlack) { dmg=Math.floor(dmg*2.5); player.crystals+=50; log.push(getBlackFlashBanner()); log.push(`💥 **흑섬 발동!!** **${dmg}** 피해! (×2.5) +50💎`); }
      else log.push(`> ⚔️ 공격! **${dmg}** 피해!`);
      enemy.currentHp=Math.max(0,enemy.currentHp-dmg);
    }
  } else if (action==="b_skill") {
    if (player.skillCooldown>0) return interaction.reply({ content:`❌ 술식 CD: ${player.skillCooldown}턴`, ephemeral:true });
    skillUsed=getCurrentSkill(player,player.active);
    if (!hit) { log.push("⚡ 술식 **빗나감!**"); }
    else {
      dmg=calcSkillDmgForPlayer(player,skillUsed.dmg);
      isBlack=isBlackFlash();
      if (isBlack) { dmg=Math.floor(dmg*2.5); player.crystals+=50; }
      const fx=getSkillEffect(skillUsed.name);
      log.push(fx.art, `> *"${fx.flavorText}"*`);
      if (isBlack) log.push(`⚫ **흑섬!** **${dmg}** 피해! (×2.5)`);
      else log.push(`> 🌀 **${skillUsed.name}** — **${dmg}** 피해!`);
      const slog=applySkillStatus(skillUsed,enemy,player); log.push(...slog);
      enemy.currentHp=Math.max(0,enemy.currentHp-dmg);
      updateQuestProgress(player,"skill_use",1);
    }
    player.skillCooldown=5;
  } else if (action==="b_main") {
    const mainSkill=getMainSkill(player,player.active);
    if (!mainSkill) return interaction.reply({ content:"❌ 주력 스킬 미획득!", ephemeral:true });
    if (!hit) { log.push("⚡ 주력 스킬 **빗나감!**"); }
    else {
      dmg=calcSkillDmgForPlayer(player,mainSkill.dmg);
      isBlack=isBlackFlash();
      if (isBlack) { dmg=Math.floor(dmg*2.5); player.crystals+=50; }
      const fx=getSkillEffect(mainSkill.name);
      log.push(fx.art, `> *"${fx.flavorText}"*`);
      if (isBlack) log.push(`⚫ **흑섬!** **${dmg}** 피해!`);
      else log.push(`> ⭐ **${mainSkill.name}** — **${dmg}** 피해!`);
      if (mainSkill.name==="자폭 무라사키") { player.hp=1; log.push("> 💥 **자폭!** HP가 1이 되었다!"); }
      enemy.currentHp=Math.max(0,enemy.currentHp-dmg);
    }
    player.skillCooldown=6;
  }

  // 승리 체크
  if (enemy.currentHp<=0) {
    delete battles[interaction.user.id];
    const winEmbed=await processBattleWin(player,enemy);
    savePlayer(interaction.user.id);
    return interaction.update({ embeds:[battleEmbed(player,enemy,log),winEmbed], components:[] });
  }

  // 적 반격
  await doEnemyAttack(player,enemy,log);
  tickCooldowns(player);

  if (player.hp<=0) {
    player.losses++; delete battles[interaction.user.id];
    const defeatEmbed=new EmbedBuilder().setTitle("💀 패배...").setColor(0xe63946)
      .setDescription("```ansi\n\u001b[1;31m╔════════════╗\n║ 💀 D E F E A T 💀 ║\n╚════════════╝\n```\n> `!회복` 으로 HP를 회복하세요.");
    savePlayer(interaction.user.id);
    return interaction.update({ embeds:[battleEmbed(player,enemy,log),defeatEmbed], components:[] });
  }
  savePlayer(interaction.user.id);
  return interaction.update({ embeds:[battleEmbed(player,enemy,log)], components:[mkBattleButtons(player)] });
}

// ════════════════════════════════════════════════════════
// ── 컬링 핸들러
// ════════════════════════════════════════════════════════
async function handleCullingAction(interaction, player, culling, action) {
  const enemy=culling.currentEnemy;
  const stats=getPlayerStats(player);
  const log=[];

  if (action==="c_escape") {
    if (culling.wave>(player.cullingBest||0)) player.cullingBest=culling.wave;
    delete cullings[interaction.user.id]; savePlayer(interaction.user.id);
    return interaction.update({ content:`🏳️ 컬링 종료! 최고기록: WAVE **${player.cullingBest}**`, embeds:[], components:[] });
  }
  if (action==="c_reverse") {
    if (!REVERSE_CHARS.has(player.active)) return interaction.reply({ content:"❌ 반전 불가!", ephemeral:true });
    const heal=Math.floor(stats.maxHp*0.4);
    player.hp=Math.min(stats.maxHp,player.hp+heal); player.reverseCooldown=3;
    player.statusEffects=player.statusEffects.filter(s=>s.id==="battleInstinct");
    log.push(`> ♻️ **${heal}** HP 회복!`);
  } else {
    if (isIncapacitated(player.statusEffects)) return interaction.reply({ content:"❌ 상태이상!", ephemeral:true });
    const hit=rollHit(player.statusEffects,enemy.statusEffects);
    let dmg=0;
    if (!hit) { log.push("⚡ 빗나감!"); }
    else if (action==="c_skill") {
      if (player.skillCooldown>0) return interaction.reply({ content:`❌ 술식 CD: ${player.skillCooldown}턴`, ephemeral:true });
      const skill=getCurrentSkill(player,player.active);
      dmg=calcSkillDmgForPlayer(player,skill.dmg);
      const isBlack=isBlackFlash();
      if (isBlack) { dmg=Math.floor(dmg*2.5); player.crystals+=50; }
      const fx=getSkillEffect(skill.name);
      log.push(fx.art);
      if (isBlack) log.push(`⚫ **흑섬!** **${dmg}** 피해! +50💎`);
      else log.push(`> 🌀 **${skill.name}** — **${dmg}** 피해!`);
      const slog=applySkillStatus(skill,enemy,player); log.push(...slog);
      player.skillCooldown=5; updateQuestProgress(player,"skill_use",1);
    } else {
      dmg=calcDmgForPlayer(player,enemy.def);
      const isBlack=isBlackFlash();
      if (isBlack) { dmg=Math.floor(dmg*2.5); player.crystals+=50; log.push(`⚫ **흑섬!** **${dmg}** 피해!`); }
      else log.push(`> ⚔️ 공격! **${dmg}** 피해!`);
    }
    culling.enemyHp=Math.max(0,culling.enemyHp-dmg);
    if (culling.enemyHp<=0) {
      const kb=getKoganeBonus(player);
      const xp=Math.floor(enemy.xp*kb.xp), cr=Math.floor(enemy.crystals*kb.crystal);
      culling.totalXp+=xp; culling.totalCrystals+=cr; culling.kills++;
      player.xp+=xp; player.crystals+=cr;
      player.mastery[player.active]=(player.mastery[player.active]||0)+(enemy.masteryXp||1);
      if (enemy.fingers) player.sukunaFingers=Math.min(SUKUNA_FINGER_MAX,(player.sukunaFingers||0)+enemy.fingers);
      const drops=rollDrops(enemy.id); addMaterials(player,drops);
      updateQuestProgress(player,"battle_win",1);
      if (enemy.id==="e3"||enemy.id==="e4") updateQuestProgress(player,"boss_kill",1);
      log.push(`> ✅ **${enemy.name}** 처치! +${xp}XP +${cr}💎`);
      if (Object.keys(drops).length) log.push(`> 📦 ${formatDrops(drops)}`);
      culling.wave++;
      updateQuestProgress(player,"culling_wave",1);
      if (culling.wave>(player.cullingBest||0)) player.cullingBest=culling.wave;
      const next=pickCullingEnemy(culling.wave);
      culling.currentEnemy=next; culling.enemyHp=next.hp;
      log.push(`> 🌊 **WAVE ${culling.wave}** — **${next.name}** 등장!`);
    } else {
      await doEnemyAttack(player,enemy,log);
      if (player.hp<=0) {
        if (culling.wave>(player.cullingBest||0)) player.cullingBest=culling.wave;
        delete cullings[interaction.user.id]; savePlayer(interaction.user.id);
        const over=new EmbedBuilder().setTitle("💀 컬링 종료!").setColor(0xe63946)
          .setDescription(`> WAVE **${culling.wave}** 에서 쓰러짐!\n> XP: **${culling.totalXp}** | 💎: **${culling.totalCrystals}**\n> 최고: WAVE **${player.cullingBest}**`);
        return interaction.update({ embeds:[over], components:[] });
      }
    }
  }
  tickCooldowns(player); savePlayer(interaction.user.id);
  return interaction.update({ embeds:[cullingEmbed(player,culling,log)], components:[mkCullingButtons(player)] });
}

// ════════════════════════════════════════════════════════
// ── 사멸회유 핸들러
// ════════════════════════════════════════════════════════
async function handleJujutsuAction(interaction, player, jujutsu, action) {
  const stats=getPlayerStats(player);
  const log=[];
  if (action==="j_escape") {
    if (jujutsu.points>(player.jujutsuBest||0)) player.jujutsuBest=jujutsu.points;
    delete jujutsus[interaction.user.id]; savePlayer(interaction.user.id);
    return interaction.update({ content:`🏳️ 사멸회유 종료! 최고: **${player.jujutsuBest}pt**`, embeds:[], components:[] });
  }
  const enemy=jujutsu.currentEnemy;
  if (!enemy) return interaction.reply({ content:"❌ 적을 먼저 선택하세요!", ephemeral:true });
  if (action==="j_reverse") {
    if (!REVERSE_CHARS.has(player.active)) return interaction.reply({ content:"❌ 반전 불가!", ephemeral:true });
    const heal=Math.floor(stats.maxHp*0.4);
    player.hp=Math.min(stats.maxHp,player.hp+heal); player.reverseCooldown=3;
    player.statusEffects=player.statusEffects.filter(s=>s.id==="battleInstinct");
    log.push(`> ♻️ **${heal}** HP 회복!`);
  } else {
    if (isIncapacitated(player.statusEffects)) return interaction.reply({ content:"❌ 상태이상!", ephemeral:true });
    const hit=rollHit(player.statusEffects,enemy.statusEffects);
    let dmg=0;
    if (!hit) { log.push("⚡ 빗나감!"); }
    else if (action==="j_skill") {
      if (player.skillCooldown>0) return interaction.reply({ content:`❌ 술식 CD: ${player.skillCooldown}턴`, ephemeral:true });
      const skill=getCurrentSkill(player,player.active);
      dmg=calcSkillDmgForPlayer(player,skill.dmg);
      const isBlack=isBlackFlash();
      if (isBlack) { dmg=Math.floor(dmg*2.5); player.crystals+=50; }
      const fx=getSkillEffect(skill.name); log.push(fx.art);
      if (isBlack) log.push(`⚫ **흑섬!** **${dmg}** 피해!`);
      else log.push(`> 🌀 **${skill.name}** — **${dmg}** 피해!`);
      const slog=applySkillStatus(skill,enemy,player); log.push(...slog);
      player.skillCooldown=5; updateQuestProgress(player,"skill_use",1);
    } else {
      dmg=calcDmgForPlayer(player,enemy.def);
      const isBlack=isBlackFlash();
      if (isBlack) { dmg=Math.floor(dmg*2.5); player.crystals+=50; log.push(`⚫ **흑섬!** **${dmg}** 피해!`); }
      else log.push(`> ⚔️ 공격! **${dmg}** 피해!`);
    }
    jujutsu.enemyHp=Math.max(0,jujutsu.enemyHp-dmg);
    if (jujutsu.enemyHp<=0) {
      const kb=getKoganeBonus(player);
      const xp=Math.floor(enemy.xp*kb.xp), cr=Math.floor(enemy.crystals*kb.crystal);
      jujutsu.totalXp+=xp; jujutsu.totalCrystals+=cr; jujutsu.points+=enemy.points||1;
      player.xp+=xp; player.crystals+=cr;
      player.mastery[player.active]=(player.mastery[player.active]||0)+(enemy.masteryXp||1);
      const drops=rollDrops(enemy.id,true); addMaterials(player,drops);
      updateQuestProgress(player,"battle_win",1);
      updateQuestProgress(player,"jujutsu_point",enemy.points||1);
      if (enemy.id==="j5"||enemy.id==="j6") updateQuestProgress(player,"boss_kill",1);
      log.push(`> ✅ **${enemy.name}** 처치! +${xp}XP +${cr}💎 +${enemy.points}점`);
      if (Object.keys(drops).length) log.push(`> 📦 ${formatDrops(drops)}`);
      if (jujutsu.points>=15) {
        player.crystals+=300; player.xp+=500;
        if (jujutsu.points>(player.jujutsuBest||0)) player.jujutsuBest=jujutsu.points;
        delete jujutsus[interaction.user.id];
        const over=new EmbedBuilder().setTitle("🏆 사멸회유 클리어!").setColor(0xF5C842)
          .setDescription(["```ansi",`\u001b[1;33m╔══════════╗\n║ CLEAR!! 🏆 ║\n╚══════════╝`,"```",`> 15포인트! **+300💎 +500XP**`, getNewlyCompletedQuestMsg(player)].filter(Boolean).join("\n"));
        savePlayer(interaction.user.id);
        return interaction.update({ embeds:[over], components:[] });
      }
      jujutsu.wave++; jujutsu.currentEnemy=null; jujutsu.enemyHp=0;
      const choices=generateJujutsuChoices(jujutsu.wave);
      jujutsu.choices=choices;
      tickCooldowns(player); savePlayer(interaction.user.id);
      return interaction.update({ embeds:[jujutsuEmbed(player,jujutsu,log,choices)], components:mkJujutsuButtons(player,choices) });
    }
    await doEnemyAttack(player,enemy,log);
    if (player.hp<=0) {
      if (jujutsu.points>(player.jujutsuBest||0)) player.jujutsuBest=jujutsu.points;
      delete jujutsus[interaction.user.id]; savePlayer(interaction.user.id);
      const over=new EmbedBuilder().setTitle("💀 사멸회유 종료!").setColor(0xe63946)
        .setDescription(`> **${jujutsu.points}포인트** | XP: **${jujutsu.totalXp}** | 💎: **${jujutsu.totalCrystals}**`);
      return interaction.update({ embeds:[over], components:[] });
    }
  }
  tickCooldowns(player); savePlayer(interaction.user.id);
  return interaction.update({ embeds:[jujutsuEmbed(player,jujutsu,log)], components:[mkJujutsuButtons(player,[])[1]] });
}

// ════════════════════════════════════════════════════════
// ── PvP 핸들러 (완벽 개편)
// ════════════════════════════════════════════════════════
async function handlePvpAction(interaction, player, session, action) {
  const selfKeys=pvpSelf(session,player.id);
  const oppKeys=pvpOpponent(session,player.id);
  const opp=players[oppKeys.id];
  if (!opp) return interaction.reply({ content:"❌ 상대 플레이어를 찾을 수 없습니다!", ephemeral:true });
  const selfStats=getPlayerStats(player);
  const oppStats=getPlayerStats(opp);
  const log=[];

  if (action==="p_surrender") {
    player.pvpLosses++; opp.pvpWins++;
    updateQuestProgress(opp,"pvp_win",1);
    const sid=Object.keys(pvpSessions).find(k=>pvpSessions[k]===session);
    if (sid) delete pvpSessions[sid];
    savePlayer(player.id); savePlayer(opp.id);
    return interaction.update({ content:`🏳️ **${player.name}** 항복! **${opp.name}** 승리!\n> PvP 전적 갱신됨.`, embeds:[], components:[] });
  }

  // 상태이상으로 행동 불가
  if (isIncapacitated(session[selfKeys.statusKey])) {
    // 상태이상 틱
    const fakeTarget={ hp:session[selfKeys.hpKey], statusEffects:session[selfKeys.statusKey] };
    const tick=tickStatus(fakeTarget,selfStats.maxHp);
    session[selfKeys.hpKey]=fakeTarget.hp;
    if (tick.log.length) log.push(...tick.log);
    // 턴 교체
    session.round++; session.turn=oppKeys.id;
    if (session[selfKeys.skillCdKey]>0) session[selfKeys.skillCdKey]--;
    if (session[selfKeys.reverseCdKey]>0) session[selfKeys.reverseCdKey]--;
    log.push(`> ⚡ **${player.name}** 상태이상으로 행동 불가! (턴 넘어감)`);
    if (session[selfKeys.hpKey]<=0) {
      player.pvpLosses++; opp.pvpWins++;
      updateQuestProgress(opp,"pvp_win",1);
      const sid=Object.keys(pvpSessions).find(k=>pvpSessions[k]===session);
      if (sid) delete pvpSessions[sid];
      savePlayer(player.id); savePlayer(opp.id);
      return interaction.update({ embeds:[pvpEmbed(session,log), new EmbedBuilder().setTitle(`💀 ${player.name} — 상태이상으로 사망`).setColor(0xe63946).setDescription(`**${opp.name}** 승리!`)], components:[] });
    }
    const embed=pvpEmbed(session,log);
    const buttons=mkPvpButtons(session,oppKeys.id);
    return interaction.update({ embeds:[embed], components:[buttons] });
  }

  const oppStatusRef={ statusEffects:session[oppKeys.statusKey] };
  const selfStatusRef={ statusEffects:session[selfKeys.statusKey] };

  if (action==="p_attack") {
    const hit=rollHit(session[selfKeys.statusKey],session[oppKeys.statusKey]);
    if (!hit) { log.push(`⚡ **${player.name}** 공격 빗나감!`); }
    else {
      let dmg=calcDmg(selfStats.atk*getWeakenMult(session[selfKeys.statusKey]),oppStats.def);
      const isBlack=isBlackFlash();
      if (isBlack) { dmg=Math.floor(dmg*2.5); log.push(getBlackFlashBanner()); log.push(`⚫ **흑섬!** **${dmg}** 피해! (×2.5)`); }
      else log.push(`⚔️ **${player.name}** 공격! **${dmg}** 피해!`);
      session[oppKeys.hpKey]=Math.max(0,session[oppKeys.hpKey]-dmg);
    }
  } else if (action==="p_skill") {
    if (session[selfKeys.skillCdKey]>0) return interaction.reply({ content:"❌ 술식 쿨다운!", ephemeral:true });
    const skill=getCurrentSkill(player,player.active);
    const hit=rollHit(session[selfKeys.statusKey],session[oppKeys.statusKey]);
    if (!hit) { log.push(`⚡ **${player.name}** 술식 빗나감!`); }
    else {
      let dmg=calcSkillDmgForPlayer(player,skill.dmg);
      const isBlack=isBlackFlash();
      if (isBlack) { dmg=Math.floor(dmg*2.5); log.push(`⚫ **흑섬!** **${dmg}** 피해!`); }
      else {
        const fx=getSkillEffect(skill.name); log.push(fx.art);
        log.push(`🌀 **${skill.name}** — **${dmg}** 피해!`);
      }
      // 상태이상 적용
      if (skill.statusApply&&Math.random()<skill.statusApply.chance) {
        if (skill.statusApply.target==="enemy") {
          applyStatus(oppStatusRef,skill.statusApply.statusId);
          session[oppKeys.statusKey]=oppStatusRef.statusEffects;
          const sdef=STATUS_EFFECTS[skill.statusApply.statusId];
          log.push(`${sdef.emoji}**${sdef.name}** 상태이상 부여!`);
        } else if (skill.statusApply.target==="self") {
          applyStatus(selfStatusRef,skill.statusApply.statusId);
          session[selfKeys.statusKey]=selfStatusRef.statusEffects;
          const sdef=STATUS_EFFECTS[skill.statusApply.statusId];
          log.push(`${sdef.emoji}**${sdef.name}** 발동!`);
        }
      }
      session[oppKeys.hpKey]=Math.max(0,session[oppKeys.hpKey]-dmg);
    }
    session[selfKeys.skillCdKey]=5;
    updateQuestProgress(player,"skill_use",1);
  } else if (action==="p_domain") {
    const ch=CHARACTERS[player.active];
    if (!ch.domain) return interaction.reply({ content:"❌ 영역전개 없음!", ephemeral:true });
    if (session[selfKeys.hpKey+"_domainUsed"]) return interaction.reply({ content:"❌ 영역전개 이미 사용!", ephemeral:true });
    const dmg=Math.floor(selfStats.atk*2.8);
    session[oppKeys.hpKey]=Math.max(0,session[oppKeys.hpKey]-dmg);
    session[selfKeys.hpKey+"_domainUsed"]=true;
    const fx=getSkillEffect(ch.domain);
    log.push(fx?fx.art:"");
    log.push(`🌌 **${ch.domain}** 영역전개! **${dmg}** 피해!`);
  } else if (action==="p_reverse") {
    if (!REVERSE_CHARS.has(player.active)) return interaction.reply({ content:"❌ 반전 불가!", ephemeral:true });
    if (session[selfKeys.reverseCdKey]>0) return interaction.reply({ content:"❌ 반전 쿨다운!", ephemeral:true });
    const heal=Math.floor(selfStats.maxHp*0.4);
    session[selfKeys.hpKey]=Math.min(selfStats.maxHp,session[selfKeys.hpKey]+heal);
    session[selfKeys.reverseCdKey]=3;
    // 상태이상 해제
    session[selfKeys.statusKey]=session[selfKeys.statusKey].filter(s=>s.id==="battleInstinct");
    log.push(`♻️ **${player.name}** **${heal}** HP 회복! 상태이상 해제!`);
  }

  // 승패 판정
  if (session[oppKeys.hpKey]<=0) {
    player.pvpWins++; opp.pvpLosses++;
    updateQuestProgress(player,"pvp_win",1);
    const sid=Object.keys(pvpSessions).find(k=>pvpSessions[k]===session);
    if (sid) delete pvpSessions[sid];
    // 보상
    const reward=Math.floor(100+Math.random()*100);
    player.crystals+=reward;
    savePlayer(player.id); savePlayer(opp.id);
    const winEmbed=new EmbedBuilder().setTitle(`🏆 ${player.name} 승리!`).setColor(0xF5C842)
      .setDescription(`> **${player.name}** 이 **${opp.name}** 을 격파!\n> ⚔️ PvP: **${player.pvpWins}승 ${player.pvpLosses}패**\n> 💎 보상: **+${reward}**`);
    return interaction.update({ embeds:[pvpEmbed(session,log),winEmbed], components:[] });
  }

  // 상태이상 틱 (상대방에게)
  const oppFakeTarget={ hp:session[oppKeys.hpKey], statusEffects:session[oppKeys.statusKey] };
  const oppTick=tickStatus(oppFakeTarget,oppStats.maxHp);
  session[oppKeys.hpKey]=oppFakeTarget.hp;
  if (oppTick.log.length) log.push(...oppTick.log.map(l=>`[상대] ${l}`));

  // 상대방 HP 체크 (DoT)
  if (session[oppKeys.hpKey]<=0) {
    player.pvpWins++; opp.pvpLosses++;
    updateQuestProgress(player,"pvp_win",1);
    const sid=Object.keys(pvpSessions).find(k=>pvpSessions[k]===session);
    if (sid) delete pvpSessions[sid];
    const reward=Math.floor(100+Math.random()*100); player.crystals+=reward;
    savePlayer(player.id); savePlayer(opp.id);
    const winEmbed=new EmbedBuilder().setTitle(`🏆 ${player.name} 승리! (DoT)`).setColor(0xF5C842)
      .setDescription(`> 상태이상으로 **${opp.name}** 격파!\n> 💎 보상: **+${reward}**`);
    return interaction.update({ embeds:[pvpEmbed(session,log),winEmbed], components:[] });
  }

  // 턴 교체
  session.round++;
  session.turn=oppKeys.id;
  if (session[selfKeys.skillCdKey]>0) session[selfKeys.skillCdKey]--;
  if (session[selfKeys.reverseCdKey]>0) session[selfKeys.reverseCdKey]--;

  const embed=pvpEmbed(session,log);
  const buttons=mkPvpButtons(session,oppKeys.id);
  return interaction.update({ embeds:[embed], components:[buttons] });
}

// ════════════════════════════════════════════════════════
// ── 레이드 핸들러
// ════════════════════════════════════════════════════════
async function handleRaidAction(interaction, player, session, rSession, action) {
  const party=parties[rSession.partyId];
  if (!party) return interaction.reply({ content:"❌ 파티 없음!", ephemeral:true });
  if (player.hp<=0) return interaction.reply({ content:"💀 전투 불능!", ephemeral:true });

  const boss=rSession.boss;
  const log=[];

  if (action==="r_escape") {
    delete raidSessions[rSession.partyId];
    return interaction.update({ content:"🏃 레이드 도주!", embeds:[], components:[] });
  }

  if (action==="r_reverse") {
    if (!REVERSE_CHARS.has(player.active)) return interaction.reply({ content:"❌ 반전 불가!", ephemeral:true });
    const stats=getPlayerStats(player);
    const heal=Math.floor(stats.maxHp*0.4);
    player.hp=Math.min(stats.maxHp,player.hp+heal); player.reverseCooldown=3;
    player.statusEffects=player.statusEffects.filter(s=>s.id==="battleInstinct");
    log.push(`> ♻️ **${player.name}** **${heal}** HP 회복!`);
  } else {
    if (isIncapacitated(player.statusEffects)) return interaction.reply({ content:"❌ 상태이상!", ephemeral:true });
    const hit=rollHit(player.statusEffects,rSession.bossStatus||[]);
    let dmg=0;

    if (!hit) { log.push(`⚡ **${player.name}** 공격 빗나감!`); }
    else if (action==="r_skill") {
      if (player.skillCooldown>0) return interaction.reply({ content:`❌ 술식 CD: ${player.skillCooldown}턴`, ephemeral:true });
      const skill=getCurrentSkill(player,player.active);

      // 마허라 적응 체크
      if (boss.id==="mahara") {
        if (!rSession.adaptedSkill) {
          // 첫 번째 술식 사용 → 적응
          rSession.adaptedSkill=skill.name;
          log.push(`> 🔰 **마허라가라가 '${skill.name}'에 적응!** 이제 이 술식은 무효화됩니다!`);
          dmg=0;
        } else if (rSession.adaptedSkill===skill.name) {
          log.push(`> 🔰 **마허라가라가 '${skill.name}'에 이미 적응!** 피해 없음!`);
          dmg=0;
        } else {
          dmg=calcSkillDmgForPlayer(player,skill.dmg);
        }
      } else {
        dmg=calcSkillDmgForPlayer(player,skill.dmg);
      }

      if (dmg>0) {
        const isBlack=isBlackFlash();
        if (isBlack) { dmg=Math.floor(dmg*2.5); player.crystals+=50; }
        const fx=getSkillEffect(skill.name); log.push(fx.art);
        if (isBlack) log.push(`⚫ **흑섬!** **${dmg}** 피해!`);
        else log.push(`> 🌀 **${player.name}: ${skill.name}** — **${dmg}** 피해!`);
        const slog=applySkillStatus(skill,{statusEffects:rSession.bossStatus||[]},player);
        rSession.bossStatus=rSession.bossStatus||[];
        log.push(...slog);
        updateQuestProgress(player,"skill_use",1);
      }
      player.skillCooldown=5;
    } else { // r_attack
      dmg=calcDmgForPlayer(player,boss.def);
      const isBlack=isBlackFlash();
      if (isBlack) { dmg=Math.floor(dmg*2.5); player.crystals+=50; log.push(`⚫ **${player.name} 흑섬!** **${dmg}** 피해!`); }
      else log.push(`> ⚔️ **${player.name}** 공격! **${dmg}** 피해!`);
    }

    rSession.bossHp=Math.max(0,rSession.bossHp-dmg);
    rSession.totalDmg=(rSession.totalDmg||0)+dmg;

    // 보스 처치
    if (rSession.bossHp<=0) {
      const kb=getKoganeBonus(player);
      // 모든 파티원에게 보상
      for (const uid of party.members) {
        const p=players[uid]; if (!p) continue;
        const xp=Math.floor(boss.xp/party.members.length*kb.xp);
        const cr=Math.floor(boss.crystals/party.members.length*kb.crystal);
        p.xp+=xp; p.crystals+=cr;
        p.mastery[p.active]=(p.mastery[p.active]||0)+(boss.masteryXp||10);
        if (boss.fingers) p.sukunaFingers=Math.min(SUKUNA_FINGER_MAX,(p.sukunaFingers||0)+boss.fingers);
        const drops=rollDrops(boss.id==="heian"?"e_heian":"e_mahara");
        addMaterials(p,drops);
        p.raidKills=(p.raidKills||0)+1;
        updateQuestProgress(p,"battle_win",1);
        updateQuestProgress(p,"boss_kill",1);
        savePlayer(uid);
      }
      delete raidSessions[rSession.partyId];
      const winEmbed=new EmbedBuilder()
        .setTitle(`🏆 레이드 클리어! — ${boss.name}`)
        .setColor(0xF5C842)
        .setDescription([
          "```ansi",`\u001b[1;33m╔══════════════════╗`,`\u001b[1;33m║  🏆 RAID CLEAR!! 🏆  ║`,`\u001b[1;33m╚══════════════════╝`,"```",
          `> **${boss.name}** 처치!`,
          `> 총 피해: **${rSession.totalDmg}**`,
          `> 보상: +${boss.xp}XP +${boss.crystals}💎 (파티 분배)`,
          boss.fingers>0?`> 👹 스쿠나 손가락 **+${boss.fingers}** 각 파티원!`:"",
          `> 📦 레이드 전용 재료 드롭!`,
        ].filter(Boolean).join("\n"));
      return interaction.update({ embeds:[raidEmbed(party,rSession,log),winEmbed], components:[] });
    }

    // 보스 반격
    const tick=tickStatus(player,getPlayerStats(player).maxHp);
    if (tick.log.length) log.push(...tick.log);
    // 보스가 랜덤 파티원 공격
    const targets=party.members.filter(uid=>(players[uid]?.hp||0)>0);
    if (targets.length>0) {
      const tgtId=targets[Math.floor(Math.random()*targets.length)];
      const tgt=players[tgtId];
      const bossHit=rollHit(rSession.bossStatus||[],tgt.statusEffects);
      if (bossHit) {
        // 보스 스킬 or 일반 공격
        const useSkill=Math.random()<0.3&&boss.skills?.length>0;
        if (useSkill) {
          const bSkill=boss.skills[Math.floor(Math.random()*boss.skills.length)];
          const bDmg=calcDmg(bSkill.dmg,getPlayerStats(tgt).def,1.0);
          tgt.hp=Math.max(0,tgt.hp-bDmg);
          log.push(`> 💥 **${boss.name}**: ${bSkill.name} → **${tgt.name}** **${bDmg}** 피해!`);
          if (bSkill.statusApply&&Math.random()<bSkill.statusApply.chance) {
            applyStatus(tgt,bSkill.statusApply.statusId);
            const sdef=STATUS_EFFECTS[bSkill.statusApply.statusId];
            log.push(`> ${sdef.emoji}**${tgt.name}**에게 **${sdef.name}** 상태이상!`);
          }
        } else {
          const bDmg=calcDmg(boss.atk,getPlayerStats(tgt).def);
          tgt.hp=Math.max(0,tgt.hp-bDmg);
          log.push(`> 💢 **${boss.name}** 공격 → **${tgt.name}** **${bDmg}** 피해!`);
          if (boss.statusAttack&&Math.random()<(boss.statusAttack.chance||0.3)) {
            applyStatus(tgt,boss.statusAttack.statusId);
            const sdef=STATUS_EFFECTS[boss.statusAttack.statusId];
            log.push(`> ${sdef.emoji}**${tgt.name}**에게 **${sdef.name}**!`);
          }
        }
        if (tgt.hp<=0) log.push(`> 💀 **${tgt.name}** 전투 불능!`);
        savePlayer(tgtId);
      } else {
        log.push(`> ↩️ **${boss.name}** 공격 빗나감!`);
      }
    }

    // 전원 사망 체크
    if (party.members.every(uid=>(players[uid]?.hp||0)<=0)) {
      delete raidSessions[rSession.partyId];
      return interaction.update({ content:"💀 파티 전원 사망! 레이드 실패!", embeds:[], components:[] });
    }
  }
  tickCooldowns(player); savePlayer(player.id);
  return interaction.update({ embeds:[raidEmbed(party,rSession,log)], components:[mkRaidButtons(player)] });
}

// ════════════════════════════════════════════════════════
// ── 파티 컬링 핸들러
// ════════════════════════════════════════════════════════
async function handlePartyCullingAction(interaction, player, session, action) {
  const party=getParty(player.id); if (!party) return;
  const enemy=session.currentEnemy;
  const log=[];

  if (action==="pc_escape") { delete cullings[party.id]; return interaction.update({ content:"🏳️ 파티 컬링 종료!", embeds:[], components:[] }); }
  if (isIncapacitated(player.statusEffects)) return interaction.reply({ content:"❌ 상태이상!", ephemeral:true });
  const hit=rollHit(player.statusEffects,enemy.statusEffects);
  let dmg=0;
  if (!hit) { log.push(`⚡ **${player.name}** 빗나감!`); }
  else if (action==="pc_skill") {
    if (player.skillCooldown>0) return interaction.reply({ content:"❌ 술식 CD!", ephemeral:true });
    const skill=getCurrentSkill(player,player.active);
    dmg=calcSkillDmgForPlayer(player,skill.dmg);
    const isBlack=isBlackFlash();
    if (isBlack) { dmg=Math.floor(dmg*2.5); log.push(`⚫ **${player.name} 흑섬!** **${dmg}** 피해!`); }
    else { log.push(`> 🌀 **${player.name}**: ${skill.name} — **${dmg}** 피해!`); }
    player.skillCooldown=5;
  } else {
    dmg=calcDmgForPlayer(player,enemy.def);
    const isBlack=isBlackFlash();
    if (isBlack) { dmg=Math.floor(dmg*2.5); log.push(`⚫ **${player.name} 흑섬!** **${dmg}** 피해!`); }
    else { log.push(`> ⚔️ **${player.name}** 공격! **${dmg}** 피해!`); }
  }
  session.enemyHp=Math.max(0,session.enemyHp-dmg);
  if (session.enemyHp<=0) {
    session.totalXp+=enemy.xp; session.totalCrystals+=enemy.crystals; session.kills++;
    for (const uid of party.members) {
      const p=players[uid]; if (!p) continue;
      p.xp+=Math.floor(enemy.xp/party.members.length);
      p.crystals+=Math.floor(enemy.crystals/party.members.length);
      const drops=rollDrops(enemy.id); addMaterials(p,drops);
      updateQuestProgress(p,"battle_win",1); savePlayer(uid);
    }
    session.wave++; updateQuestProgress(player,"culling_wave",1);
    if (session.wave>(player.cullingBest||0)) player.cullingBest=session.wave;
    const next=pickCullingEnemy(session.wave); session.currentEnemy=next; session.enemyHp=next.hp;
    log.push(`> ✅ 처치! WAVE **${session.wave}** — **${next.name}** 등장!`);
  } else {
    const tgtId=party.members[Math.floor(Math.random()*party.members.length)];
    const p2=players[tgtId]; if (p2) {
      const eDmg=calcDmg(enemy.atk,getPlayerStats(p2).def);
      p2.hp=Math.max(0,p2.hp-eDmg);
      log.push(`> 💢 **${enemy.name}** → **${p2.name}** **${eDmg}** 피해!`);
      if (p2.hp<=0) log.push(`> 💀 **${p2.name}** 전투 불능!`);
    }
    if (party.members.every(uid=>(players[uid]?.hp||0)<=0)) {
      delete cullings[party.id];
      return interaction.update({ content:"💀 파티 전원 쓰러짐!", embeds:[], components:[] });
    }
  }
  tickCooldowns(player); savePlayer(player.id);
  return interaction.update({ embeds:[partyCullingEmbed(party,session,log)], components:[mkCullingButtons(player)] });
}

// ════════════════════════════════════════════════════════
// ── Discord 준비 & 슬래시 커맨드
// ════════════════════════════════════════════════════════
client.once("ready", async () => {
  console.log(`✅ 로그인: ${client.user.tag}`);
  await dbInit(); players=await dbLoad();
  console.log("🚀 주술회전 RPG 봇 활성화");
  const commands=[
    {name:"프로필",description:"내 프로필 카드"},
    {name:"전투",description:"일반 전투 시작"},
    {name:"캐릭터선택",description:"드롭다운으로 캐릭터 변경"},
    {name:"술식",description:"술식 트리 확인"},
    {name:"가챠",description:"캐릭터 소환",options:[{name:"횟수",type:4,description:"1 또는 10",required:true}]},
    {name:"출석",description:"매일 출석"},
    {name:"회복",description:"회복약 사용"},
    {name:"코가네가챠",description:"코가네 펫 소환 (200💎)"},
    {name:"코가네",description:"코가네 정보"},
    {name:"손가락",description:"스쿠나 손가락 현황"},
    {name:"컬링",description:"컬링 게임"},
    {name:"사멸회유",description:"사멸회유 게임"},
    {name:"결투",description:"PvP 결투",options:[{name:"대상",type:6,description:"결투 상대",required:true}]},
    {name:"파티생성",description:"파티 생성"},
    {name:"파티초대",description:"파티 초대",options:[{name:"대상",type:6,description:"초대 대상",required:true}]},
    {name:"파티나가기",description:"파티 탈퇴"},
    {name:"파티컬링",description:"파티 컬링 시작"},
    {name:"레이드",description:"레이드 시작",options:[{name:"보스",type:3,description:"heian 또는 mahara",required:true,choices:[{name:"헤이안 스쿠나",value:"heian"},{name:"마허라가라",value:"mahara"}]}]},
    {name:"코드",description:"쿠폰 코드",options:[{name:"코드",type:3,description:"코드명",required:true}]},
    {name:"퀘스트",description:"퀘스트 확인"},
    {name:"재료",description:"재료 인벤토리"},
    {name:"주구목록",description:"주구 목록"},
    {name:"주구제작",description:"주구 제작",options:[{name:"이름",type:3,description:"주구 ID",required:true}]},
    {name:"장착",description:"주구 장착",options:[{name:"이름",type:3,description:"주구 ID",required:true}]},
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
  // ── 드롭다운 메뉴
  if (interaction.isStringSelectMenu()) {
    const { customId, user, values } = interaction;
    const player=getPlayer(user.id, user.username);

    if (customId==="char_select") {
      const charId=values[0];
      if (charId==="none") return interaction.reply({ content:"❌ 보유한 캐릭터가 없습니다!", ephemeral:true });
      if (!player.owned.includes(charId)) return interaction.reply({ content:"❌ 미보유 캐릭터!", ephemeral:true });
      player.active=charId;
      const stats=getPlayerStats(player); player.hp=stats.maxHp;
      savePlayer(user.id);
      const ch=CHARACTERS[charId];
      const embed=new EmbedBuilder()
        .setTitle(`✅ 캐릭터 변경 — ${ch.emoji} ${ch.name}`)
        .setColor(JJK_GRADE_COLOR[ch.grade]||0x7c5cfc)
        .setDescription([
          `> **${ch.name}** [${ch.grade}] 로 변경됨!`,
          `> 💚 HP 완전 회복: **${stats.maxHp}**`,
          `> *"${ch.lore||ch.desc}"*`,
          `> 🌌 영역전개: **${ch.domain||"없음"}**`,
          ch.id==="sukuna"?`> 👹 손가락 보너스 적용 중: ${getFingerBonus(player.sukunaFingers||0).label}`:"",
        ].filter(Boolean).join("\n"))
        .setFooter({ text:"캐릭터를 다시 바꾸려면 !캐릭터선택" });
      return interaction.update({ embeds:[embed], components:[mkCharSelectMenu(player)] });
    }
  }

  if (interaction.isButton()) {
    const { customId, user }=interaction;
    const userId=user.id;
    const player=getPlayer(userId, user.username);

    if (customId.startsWith("b_")) { const battle=battles[userId]; if (!battle) return interaction.reply({ content:"❌ 진행 중인 전투 없음", ephemeral:true }); return handleBattleAction(interaction,player,battle,customId); }
    if (customId.startsWith("c_")) { const culling=cullings[userId]; if (!culling) return interaction.reply({ content:"❌ 진행 중인 컬링 없음", ephemeral:true }); return handleCullingAction(interaction,player,culling,customId); }
    if (customId.startsWith("j_")) {
      const jujutsu=jujutsus[userId];
      if (!jujutsu) return interaction.reply({ content:"❌ 진행 중인 사멸회유 없음", ephemeral:true });
      if (customId==="j_escape") { delete jujutsus[userId]; return interaction.update({ content:"🏳 사멸회유 종료", embeds:[], components:[] }); }
      if (customId.startsWith("j_choice_")) {
        const idx=parseInt(customId.split("_")[2]);
        if (jujutsu.choices?.[idx]) {
          jujutsu.currentEnemy=JSON.parse(JSON.stringify(jujutsu.choices[idx]));
          jujutsu.enemyHp=jujutsu.currentEnemy.hp; jujutsu.choices=null;
          return interaction.update({ embeds:[jujutsuEmbed(player,jujutsu)], components:[mkJujutsuButtons(player,[])[1]] });
        }
        return interaction.reply({ content:"❌ 잘못된 선택", ephemeral:true });
      }
      return handleJujutsuAction(interaction,player,jujutsu,customId);
    }
    if (customId.startsWith("p_")) {
      const session=getPvpSessionByUser(userId);
      if (!session) return interaction.reply({ content:"❌ 진행 중인 PvP 없음", ephemeral:true });
      if (session.turn!==userId) return interaction.reply({ content:"⏳ 당신의 턴이 아닙니다!", ephemeral:true });
      return handlePvpAction(interaction,player,session,customId);
    }
    if (customId.startsWith("r_")) {
      const party=getParty(userId);
      if (!party) return interaction.reply({ content:"❌ 파티 없음!", ephemeral:true });
      const rSession=raidSessions[party.id];
      if (!rSession) return interaction.reply({ content:"❌ 진행 중인 레이드 없음!", ephemeral:true });
      return handleRaidAction(interaction,player,party,rSession,customId);
    }
    if (customId.startsWith("pc_")) {
      const party=getParty(userId);
      if (!party) return interaction.reply({ content:"❌ 파티 없음", ephemeral:true });
      const session=cullings[party.id];
      if (!session) return interaction.reply({ content:"❌ 진행 중인 파티 컬링 없음", ephemeral:true });
      if (player.hp<=0) return interaction.reply({ content:"💀 전투 불능!", ephemeral:true });
      return handlePartyCullingAction(interaction,player,session,customId);
    }
    if (customId.startsWith("party_invite_")) {
      const parts=customId.split("_"); const partyId=parts[3], targetId=parts[4];
      if (user.id!==targetId) return interaction.reply({ content:"❌ 당신을 위한 초대가 아닙니다.", ephemeral:true });
      const invite=partyInvites[targetId];
      if (!invite||invite.partyId!==partyId) return interaction.reply({ content:"❌ 만료된 초대", ephemeral:true });
      if (customId.includes("accept")) {
        const party=parties[partyId]; if (!party) return interaction.reply({ content:"❌ 파티 해체됨", ephemeral:true });
        if (party.members.length>=4) return interaction.reply({ content:"❌ 파티 가득참", ephemeral:true });
        if (getPartyId(targetId)) return interaction.reply({ content:"❌ 이미 파티 소속", ephemeral:true });
        party.members.push(targetId); delete partyInvites[targetId];
        return interaction.update({ content:`✅ 파티 참가! (${party.members.length}/4)`, embeds:[], components:[] });
      } else {
        delete partyInvites[targetId];
        return interaction.update({ content:"❌ 초대 거절", embeds:[], components:[] });
      }
    }
    if (customId.startsWith("pvp_challenge_")) {
      const parts=customId.split("_"); const action=parts[3], challengerId=parts[4];
      if (action==="accept") {
        const challenge=pvpChallenges[challengerId];
        if (!challenge||challenge.target!==user.id) return interaction.reply({ content:"❌ 유효하지 않은 도전", ephemeral:true });
        if (getPvpSessionByUser(user.id)||getPvpSessionByUser(challengerId)) return interaction.reply({ content:"❌ 이미 PvP 중", ephemeral:true });
        const p1=players[challengerId], p2=players[user.id];
        const s1=getPlayerStats(p1), s2=getPlayerStats(p2);
        const sessionId=`${_pvpIdSeq++}`;
        pvpSessions[sessionId]={ id:sessionId,p1Id:challengerId,p2Id:user.id, hp1:s1.maxHp,hp2:s2.maxHp, status1:[],status2:[], skillCd1:0,skillCd2:0, reverseCd1:0,reverseCd2:0, hp1_domainUsed:false,hp2_domainUsed:false, turn:challengerId,round:1 };
        delete pvpChallenges[challengerId];
        const embed=pvpEmbed(pvpSessions[sessionId],[
          "```ansi","\u001b[1;31m╔═══════════════╗","\u001b[1;31m║  ⚔️  P v P  S T A R T  ⚔️  ║","\u001b[1;31m╚═══════════════╝","```",
          `> **${p1.name}** vs **${p2.name}**`,"> **${p1.name}**의 첫 번째 턴!",
        ]);
        return interaction.update({ embeds:[embed], components:[mkPvpButtons(pvpSessions[sessionId],challengerId)] });
      } else {
        delete pvpChallenges[challengerId];
        return interaction.update({ content:"❌ 결투 거절", embeds:[], components:[] });
      }
    }
  }

  if (interaction.isChatInputCommand()) {
    const { commandName, user }=interaction;
    const userId=user.id;
    const player=getPlayer(userId, user.username);
    await handleSlashCommand(interaction, commandName, player, userId, user);
  }
});

// ════════════════════════════════════════════════════════
// ── 슬래시 명령 처리
// ════════════════════════════════════════════════════════
async function handleSlashCommand(interaction, commandName, player, userId, user) {
  if (commandName==="프로필") return interaction.reply({ embeds:[profileEmbed(player)] });

  if (commandName==="캐릭터선택") {
    const embed=new EmbedBuilder()
      .setTitle("🎭 캐릭터 선택")
      .setColor(0x7C5CFC)
      .setDescription(`현재 활성: **${CHARACTERS[player.active].emoji} ${CHARACTERS[player.active].name}**\n드롭다운 메뉴에서 원하는 캐릭터를 선택하세요!`);
    return interaction.reply({ embeds:[embed], components:[mkCharSelectMenu(player)] });
  }

  if (commandName==="전투") {
    if (battles[userId]) return interaction.reply({ content:"❌ 이미 전투 중!", ephemeral:true });
    const eBase=pickBattleEnemy();
    const enemy={ ...eBase, currentHp:eBase.hp, statusEffects:[] };
    battles[userId]={ enemy };
    const isBoss=enemy.isSukunaBoss;
    const embed=new EmbedBuilder()
      .setTitle(isBoss?"🔴 ≪ 스쿠나 보스 출현! ≫ 🔴":"⚔️ 전투 시작!")
      .setColor(isBoss?0x8b0000:0xe63946)
      .setDescription(isBoss
        ?["```ansi","\u001b[1;31m╔═══════════════════╗","\u001b[1;31m║  👹  료멘 스쿠나  등장!  ║","\u001b[1;31m╠═══════════════════╣","\u001b[1;33m║  손가락 1개 100% 드롭!!  ║","\u001b[1;31m╚═══════════════════╝","```"].join("\n")
        :`> **${enemy.emoji} ${enemy.name}** 등장!`);
    embed.addFields({ name:"적 정보", value:`💚 HP: **${enemy.hp}** | 🗡️ ATK: **${enemy.atk}** | 🛡️ DEF: **${enemy.def}**${isBoss?"\n> 💀 **매우 강력한 보스!** — 처치 시 스쿠나 손가락 획득!":`\n내 HP: **${player.hp}**/${getPlayerStats(player).maxHp}`} });
    return interaction.reply({ embeds:[embed], components:[mkBattleButtons(player)] });
  }

  if (commandName==="술식") return interaction.reply({ embeds:[buildSkillEmbed(player)] });

  if (commandName==="가챠") {
    const count=interaction.options.getInteger("횟수");
    if (count!==1&&count!==10) return interaction.reply({ content:"❌ 1회 또는 10회만 가능!", ephemeral:true });
    const cost=count===1?150:1350;
    if (player.crystals<cost) return interaction.reply({ content:`💎 부족! (필요: ${cost})`, ephemeral:true });
    player.crystals-=cost; updateQuestProgress(player,"gacha_pull",1);
    await interaction.reply({ embeds:[gachaLoadingEmbed(1)] });
    await new Promise(r=>setTimeout(r,2000));
    await interaction.editReply({ embeds:[gachaLoadingEmbed(2)] });
    await new Promise(r=>setTimeout(r,2000));
    if (count===1) {
      const result=rollGacha(1)[0];
      const isNew=!player.owned.includes(result);
      if (isNew) player.owned.push(result); else player.crystals+=50;
      await interaction.editReply({ embeds:[gachaRevealEmbed(CHARACTERS[result].grade),gachaResultEmbed(result,isNew,player)] });
    } else {
      const results=rollGacha(10);
      const dupCrystals=results.filter(id=>player.owned.includes(id)).length*50;
      const newOnes=results.filter(id=>!player.owned.includes(id));
      for (const id of newOnes) player.owned.push(id);
      player.crystals+=dupCrystals;
      await interaction.editReply({ embeds:[gacha10ResultEmbed(results,newOnes,dupCrystals,player)] });
    }
    savePlayer(userId);
  }

  if (commandName==="출석") {
    const now=Date.now();
    if (now-(player.lastDaily||0)<86400000) { const h=Math.ceil((86400000-(now-player.lastDaily))/3600000); return interaction.reply({ content:`⏰ ${h}시간 후 가능`, ephemeral:true }); }
    const streak=Math.min(player.dailyStreak||0,30);
    const cr=100+streak*5;
    player.crystals+=cr; player.lastDaily=now; player.dailyStreak=(player.dailyStreak||0)+1;
    await interaction.reply({ content:`✅ 출석! **+${cr}💎** (연속 ${player.dailyStreak}일)` });
    savePlayer(userId);
  }

  if (commandName==="회복") {
    if (player.potion<=0) return interaction.reply({ content:"❌ 회복약 없음!", ephemeral:true });
    const stats=getPlayerStats(player); player.hp=stats.maxHp; player.potion--;
    await interaction.reply({ content:`✅ HP 완전 회복! (남은: **${player.potion}개**)` });
    savePlayer(userId);
  }

  if (commandName==="코가네가챠") {
    if (player.crystals<200) return interaction.reply({ content:"💎 부족! (필요: 200)", ephemeral:true });
    player.crystals-=200; player.koganeGachaCount=(player.koganeGachaCount||0)+1;
    const grade=rollKogane();
    const gradeOrder=["3급","2급","1급","특급","전설"];
    const isUpgrade=!player.kogane||gradeOrder.indexOf(grade)>gradeOrder.indexOf(player.kogane.grade);
    if (isUpgrade) player.kogane={ grade }; else player.crystals+=50;
    await interaction.reply({ content:`🐾 **코가네 [${grade}]** ${isUpgrade?"(등급 상승!)":"(중복 +50💎)"}\n${KOGANE_GRADES[grade].passiveDesc}` });
    savePlayer(userId);
  }

  if (commandName==="코가네") return interaction.reply({ embeds:[koganeProfileEmbed(player)] });

  if (commandName==="손가락") {
    const fingers=player.sukunaFingers||0;
    const bonus=getFingerBonus(fingers);
    const embed=new EmbedBuilder().setTitle("👹 스쿠나 손가락").setColor(0x8b0000)
      .setDescription([
        "```",`╔═══════════════════════╗`,
        `║  🖕  ${"█".repeat(Math.min(fingers,10))}${"░".repeat(Math.max(0,10-Math.min(fingers,10)))} ${fingers}/${SUKUNA_FINGER_MAX}  ║`,
        `╚═══════════════════════╝`,"```",
        `> **${bonus.label}**`,
        `> ATK+${bonus.atkBonus} | DEF+${bonus.defBonus} | HP+${bonus.hpBonus}`,
        `> ${isSukunaUnlocked(player)?"✅ 스쿠나 캐릭터 해금됨":"🔒 스쿠나를 처치해 해금!"}`,
      ].join("\n"));
    return interaction.reply({ embeds:[embed] });
  }

  if (commandName==="컬링") {
    if (cullings[userId]) return interaction.reply({ content:"🌊 이미 컬링 중!", ephemeral:true });
    const firstEnemy=pickCullingEnemy(1);
    cullings[userId]={ wave:1,kills:0,totalXp:0,totalCrystals:0, currentEnemy:firstEnemy,enemyHp:firstEnemy.hp };
    return interaction.reply({ embeds:[cullingEmbed(player,cullings[userId])], components:[mkCullingButtons(player)] });
  }

  if (commandName==="사멸회유") {
    if (jujutsus[userId]) return interaction.reply({ content:"🎯 이미 사멸회유 중!", ephemeral:true });
    const choices=generateJujutsuChoices(1);
    jujutsus[userId]={ wave:1,points:0,totalXp:0,totalCrystals:0, choices,currentEnemy:null,enemyHp:0 };
    return interaction.reply({ embeds:[jujutsuEmbed(player,jujutsus[userId],[],choices)], components:mkJujutsuButtons(player,choices) });
  }

  if (commandName==="결투") {
    const target=interaction.options.getUser("대상");
    if (target.id===userId) return interaction.reply({ content:"❌ 자신과 결투 불가!", ephemeral:true });
    if (getPvpSessionByUser(userId)||getPvpSessionByUser(target.id)) return interaction.reply({ content:"❌ 이미 PvP 중!", ephemeral:true });
    pvpChallenges[userId]={ target:target.id };
    const p1ch=CHARACTERS[player.active], p2=getPlayer(target.id,target.username), p2ch=CHARACTERS[p2.active];
    const embed=new EmbedBuilder().setTitle("⚔️ PvP 결투 신청").setColor(0xF5C842)
      .setDescription([
        `> **${user.username}** ${p1ch.emoji}[${p1ch.grade}]  VS  ${p2ch.emoji}[${p2ch.grade}] **${target.username}**`,
        `> ATK: **${getPlayerStats(player).atk}** vs ATK: **${getPlayerStats(p2).atk}**`,
        `> HP: **${getPlayerStats(player).maxHp}** vs HP: **${getPlayerStats(p2).maxHp}**`,
      ].join("\n")).setFooter({ text:"30초 내 수락/거절" });
    const buttons=new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`pvp_challenge_accept_${userId}`).setLabel("✅ 수락").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`pvp_challenge_decline_${userId}`).setLabel("❌ 거절").setStyle(ButtonStyle.Danger),
    );
    await interaction.reply({ content:`${target}`, embeds:[embed], components:[buttons] });
    setTimeout(()=>{ if(pvpChallenges[userId]) delete pvpChallenges[userId]; },30000);
  }

  if (commandName==="파티생성") {
    if (getPartyId(userId)) return interaction.reply({ content:"❌ 이미 파티 소속!", ephemeral:true });
    const partyId=`${_partyIdSeq++}`;
    parties[partyId]={ id:partyId,leader:userId,members:[userId],bestWave:0 };
    return interaction.reply({ content:`✅ 파티 생성! ID: **${partyId}**\n> !파티초대 @유저 로 파티원을 모집하세요.` });
  }

  if (commandName==="파티초대") {
    const target=interaction.options.getUser("대상");
    const party=getParty(userId);
    if (!party) return interaction.reply({ content:"❌ 파티 없음!", ephemeral:true });
    if (party.leader!==userId) return interaction.reply({ content:"❌ 파티장만 초대!", ephemeral:true });
    if (party.members.length>=4) return interaction.reply({ content:"❌ 파티 가득참!", ephemeral:true });
    if (getPartyId(target.id)) return interaction.reply({ content:"❌ 이미 다른 파티 소속!", ephemeral:true });
    partyInvites[target.id]={ partyId:party.id, inviter:userId };
    const buttons=new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`party_invite_accept_${party.id}_${target.id}`).setLabel("✅ 수락").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`party_invite_decline_${party.id}_${target.id}`).setLabel("❌ 거절").setStyle(ButtonStyle.Danger),
    );
    await interaction.reply({ content:`${target}`, embeds:[new EmbedBuilder().setTitle("👥 파티 초대").setColor(0x4ade80).setDescription(`**${user.username}** 의 파티 초대!`)], components:[buttons] });
    setTimeout(()=>{ if(partyInvites[target.id]) delete partyInvites[target.id]; },60000);
  }

  if (commandName==="파티나가기") {
    const party=getParty(userId); if (!party) return interaction.reply({ content:"❌ 파티 없음!", ephemeral:true });
    const isLeader=party.leader===userId;
    party.members=party.members.filter(id=>id!==userId);
    if (party.members.length===0) { delete parties[party.id]; return interaction.reply({ content:"✅ 파티 탈퇴 (파티 해체)" }); }
    if (isLeader) party.leader=party.members[0];
    return interaction.reply({ content:"✅ 파티 탈퇴" });
  }

  if (commandName==="파티컬링") {
    const party=getParty(userId);
    if (!party) return interaction.reply({ content:"❌ 파티 없음!", ephemeral:true });
    if (party.leader!==userId) return interaction.reply({ content:"❌ 파티장만 시작!", ephemeral:true });
    if (cullings[party.id]) return interaction.reply({ content:"🌊 이미 파티 컬링 중!", ephemeral:true });
    const firstEnemy=pickCullingEnemy(1);
    cullings[party.id]={ wave:1,kills:0,totalXp:0,totalCrystals:0, currentEnemy:firstEnemy,enemyHp:firstEnemy.hp };
    return interaction.reply({ embeds:[partyCullingEmbed(party,cullings[party.id])], components:[mkCullingButtons(player)] });
  }

  if (commandName==="레이드") {
    const bossId=interaction.options.getString("보스");
    const party=getParty(userId);
    if (!party) return interaction.reply({ content:"❌ 파티가 필요합니다! `!파티생성` 으로 파티를 만드세요.", ephemeral:true });
    if (party.leader!==userId) return interaction.reply({ content:"❌ 파티장만 레이드 시작 가능!", ephemeral:true });
    if (party.members.length<2) return interaction.reply({ content:"❌ 레이드는 최소 2명 필요!", ephemeral:true });
    if (raidSessions[party.id]) return interaction.reply({ content:"❌ 이미 레이드 진행 중!", ephemeral:true });
    const boss=RAID_BOSSES[bossId];
    if (!boss) return interaction.reply({ content:"❌ 잘못된 보스 ID!", ephemeral:true });
    raidSessions[party.id]={ partyId:party.id, boss, bossHp:boss.hp, bossStatus:[], adaptedSkill:null, totalDmg:0, phase:1 };
    const embed=new EmbedBuilder()
      .setTitle(`💥 레이드 시작! — ${boss.emoji} ${boss.name}`)
      .setColor(bossId==="heian"?0x8b0000:0x4a0000)
      .setDescription([
        "```ansi",`\u001b[1;31m╔══════════════════════╗`,
        bossId==="heian"?`\u001b[1;31m║  👹 헤이안 시대 스쿠나 등장!  ║`:`\u001b[1;35m║  🐍 마허라가라 등장!  ║`,
        `\u001b[1;31m╚══════════════════════╝`,"```",
        `> **${boss.desc}**`,
        bossId==="heian"?"> ⚠️ 기존 스쿠나의 **2배** 공격력과 체력!":"> ⚠️ 첫 번째 술식에 **적응** — 해당 술식 무효화!",
        `> 💚 보스 HP: **${boss.hp}** | 🗡️ ATK: **${boss.atk}**`,
        `> 👥 파티원 **${party.members.length}명** 참여 가능`,
      ].join("\n"));
    return interaction.reply({ embeds:[embed,raidEmbed(party,raidSessions[party.id])], components:[mkRaidButtons(player)] });
  }

  if (commandName==="코드") {
    const code=interaction.options.getString("코드").toLowerCase();
    if (player.usedCodes.includes(code)) return interaction.reply({ content:"❌ 이미 사용한 코드!", ephemeral:true });
    if (CODES[code]) {
      player.crystals+=(CODES[code].crystals||0); player.usedCodes.push(code);
      await interaction.reply({ content:`✅ 코드 사용! +${CODES[code].crystals||0}💎` });
      savePlayer(userId);
    } else return interaction.reply({ content:"❌ 유효하지 않은 코드!", ephemeral:true });
  }

  if (commandName==="퀘스트") return interaction.reply({ embeds:[questEmbed(player)] });
  if (commandName==="재료") return interaction.reply({ embeds:[materialsEmbed(player)] });
  if (commandName==="주구목록") return interaction.reply({ embeds:[weaponListEmbed(player)] });

  if (commandName==="주구제작") {
    const weaponId=interaction.options.getString("이름").toLowerCase().replace(/ /g,"_");
    const w=WEAPONS[weaponId];
    if (!w) return interaction.reply({ content:`❌ 없는 주구: ${weaponId}\n가능: ${Object.keys(WEAPONS).join(", ")}`, ephemeral:true });
    if ((player.craftedWeapons||[]).includes(weaponId)) return interaction.reply({ content:"❌ 이미 제작한 주구!", ephemeral:true });
    const mats=player.materials||{};
    for (const [mat,qty] of Object.entries(w.recipe)) {
      if ((mats[mat]||0)<qty) { const m=MATERIALS[mat]; return interaction.reply({ content:`❌ 재료 부족! ${m.emoji}**${m.name}** ${mats[mat]||0}/${qty}`, ephemeral:true }); }
    }
    for (const [mat,qty] of Object.entries(w.recipe)) mats[mat]-=qty;
    if (!player.craftedWeapons) player.craftedWeapons=[];
    player.craftedWeapons.push(weaponId);
    updateQuestProgress(player,"weapon_craft",1);
    savePlayer(userId);
    return interaction.reply({ embeds:[new EmbedBuilder().setTitle(`${w.emoji} ${w.name} 제작 완료!`).setColor(w.color).setDescription([`> **등급:** ${w.grade}`,`> ATK+${w.atkBonus} DEF+${w.defBonus} HP+${w.hpBonus}`,`> ${w.desc}`,`> \`!장착 ${weaponId}\` 으로 장착하세요!`].join("\n"))] });
  }

  if (commandName==="장착") {
    const weaponId=interaction.options.getString("이름").toLowerCase().replace(/ /g,"_");
    if (!(player.craftedWeapons||[]).includes(weaponId)) return interaction.reply({ content:"❌ 제작하지 않은 주구!", ephemeral:true });
    player.equippedWeapon=weaponId; const w=WEAPONS[weaponId];
    savePlayer(userId);
    return interaction.reply({ content:`✅ **${w.emoji} ${w.name}** 장착! ATK+${w.atkBonus} DEF+${w.defBonus} HP+${w.hpBonus}` });
  }

  if (commandName==="해제") {
    if (!player.equippedWeapon) return interaction.reply({ content:"❌ 장착된 주구 없음!", ephemeral:true });
    const w=WEAPONS[player.equippedWeapon]; player.equippedWeapon=null;
    savePlayer(userId);
    return interaction.reply({ content:`✅ **${w?.name||"주구"}** 해제됨.` });
  }

  if (commandName==="도움말") {
    return interaction.reply({ embeds:[buildHelpEmbed()] });
  }
}

// ════════════════════════════════════════════════════════
// ── 술식 임베드
// ════════════════════════════════════════════════════════
function buildSkillEmbed(player) {
  const id=player.active;
  const ch=CHARACTERS[id];
  const mastery=getMastery(player,id);
  const awakened=isMakiAwakened(player);
  const fingers=player.sukunaFingers||0;
  const mainSkill=getMainSkill(player,id);
  return new EmbedBuilder()
    .setTitle(`${ch.emoji} ≪ 술식 트리 ≫ ${ch.name}${awakened?"  🔥[각성]":""}`)
    .setColor(awakened?0xFF2200:JJK_GRADE_COLOR[ch.grade]||0x94a3b8)
    .setDescription([
      `> *"${ch.lore||ch.desc}"*`,
      `> 📈 **숙련도** ${masteryBar(mastery,id)}`,
      `> 🌌 **영역전개** \`${ch.domain||"없음"}\``,
      id==="sukuna"?`> 👹 **손가락** \`${fingers}/${SUKUNA_FINGER_MAX}\` — ${getFingerBonus(fingers).label}`:"",
      id==="itadori"&&fingers>0?`> 👹 **스쿠나 영향** — ${getFingerBonus(fingers).label} (50% 적용)`:"",
      awakened?`> 🔥 **천여주박 각성 중** — 피해 **×2**!`:"",
      mainSkill?`> ⭐ **주력 스킬:** ${mainSkill.name} ✅`:(id==="gojo"?`> ⭐ **주력 스킬 미획득:** 20승 필요`:id==="sukuna"?`> ⭐ **주력 스킬 미획득:** 손가락 10개 필요`:""),
    ].filter(Boolean).join("\n"))
    .addFields(ch.skills.map((s,idx)=>{
      const unlocked=mastery>=s.minMastery;
      const fingerLock=s.name==="스쿠나 발현"&&fingers<10;
      const available=unlocked&&!fingerLock;
      const fx=getSkillEffect(s.name);
      const statusNote=s.statusApply?` — ${STATUS_EFFECTS[s.statusApply.statusId]?.emoji}${STATUS_EFFECTS[s.statusApply.statusId]?.name}(${Math.round(s.statusApply.chance*100)}%)`:"";
      return {
        name:`${available?"✅":"🔒"} [${idx+1}] ${s.name}  피해 **${s.dmg}**${statusNote}`,
        value:[`> ${s.desc}`, available?`> ${fx.art}`:`> 🔒 미해금 (숙련 ${s.minMastery} 필요)`, available?`> *${fx.flavorText}*`:""].filter(Boolean).join("\n"),
        inline:false,
      };
    }))
    .setFooter({ text:"흑섬 10% 확률 발동!" });
}

// ════════════════════════════════════════════════════════
// ── 도움말 임베드
// ════════════════════════════════════════════════════════
function buildHelpEmbed() {
  return new EmbedBuilder()
    .setTitle("🔱 주술회전 RPG 봇 — 명령어 목록")
    .setColor(0xF5C842)
    .addFields(
      { name:"⚔️ 전투 & 게임", value:"`!전투` `!컬링` `!사멸회유` `!결투 @유저`\n`!레이드 [heian/mahara]` ← 파티 필요!", inline:false },
      { name:"👥 파티", value:"`!파티생성` `!파티초대 @유저` `!파티나가기` `!파티컬링`", inline:false },
      { name:"🎭 캐릭터", value:"`!캐릭터선택` ← **드롭다운 메뉴!**\n`!술식` `!손가락`\n스쿠나: 보스 처치로 손가락 1개 → 자동 해금!", inline:false },
      { name:"🎲 가챠", value:"`!가챠` (150💎) `!가챠10` (1350💎)\n`!코가네가챠` (200💎)", inline:false },
      { name:"⚔️ 주구 시스템", value:"`!재료` `!주구목록` `!주구제작 [ID]` `!장착 [ID]` `!해제`", inline:false },
      { name:"📋 퀘스트", value:"`!퀘스트` `!퀘보상 일 [번호]` `!퀘보상 주 [번호]`", inline:false },
      { name:"🛠️ 기타", value:"`!프로필` `!출석` `!회복` `!코가네` `!코드 [코드]` `!도감`", inline:false },
      { name:"💡 특수 시스템", value:"⚫ **흑섬**: 10% 확률 발동 → 피해 ×2.5 +50💎\n👹 **스쿠나 보스**: 10% 확률 등장 → 손가락 100% 드롭\n🔱 **레이드**: 헤이안 스쿠나 (2배 강력) / 마허라가라 (술식 적응)", inline:false },
    )
    .setFooter({ text:"슬래시 커맨드 / 접두사 ! 모두 지원" });
}

// ════════════════════════════════════════════════════════
// ── ! 명령어 핸들러
// ════════════════════════════════════════════════════════
client.on("messageCreate", async (message) => {
  if (message.author.bot||!message.content.startsWith("!")) return;
  const args=message.content.slice(1).trim().split(/\s+/);
  const cmd=args[0].toLowerCase();
  const userId=message.author.id;
  const player=getPlayer(userId, message.author.username);

  if (cmd==="프로필") return message.reply({ embeds:[profileEmbed(player)] });

  if (cmd==="캐릭터선택") {
    const embed=new EmbedBuilder().setTitle("🎭 캐릭터 선택").setColor(0x7C5CFC)
      .setDescription(`현재: **${CHARACTERS[player.active].emoji} ${CHARACTERS[player.active].name}**\n드롭다운에서 원하는 캐릭터를 선택하세요!`);
    return message.reply({ embeds:[embed], components:[mkCharSelectMenu(player)] });
  }

  if (cmd==="전투") {
    if (battles[userId]) return message.reply("❌ 이미 전투 중!");
    const eBase=pickBattleEnemy();
    const enemy={ ...eBase, currentHp:eBase.hp, statusEffects:[] };
    battles[userId]={ enemy };
    const isBoss=enemy.isSukunaBoss;
    const embed=new EmbedBuilder()
      .setTitle(isBoss?"🔴 ≪ 스쿠나 보스 출현! ≫":"⚔️ 전투 시작!")
      .setColor(isBoss?0x8b0000:0xe63946)
      .setDescription(isBoss
        ?["```ansi","\u001b[1;31m╔═══════════════════╗","\u001b[1;31m║  👹  료멘 스쿠나  등장!  ║","\u001b[1;31m╠═══════════════════╣","\u001b[1;33m║  손가락 1개 100% 드롭!!  ║","\u001b[1;31m╚═══════════════════╝","```"].join("\n")
        :`> **${enemy.emoji} ${enemy.name}** 등장!`)
      .addFields({ name:"적 정보", value:`💚 HP: **${enemy.hp}** | 🗡️ ATK: **${enemy.atk}** | 🛡️ DEF: **${enemy.def}**${isBoss?"\n> **스쿠나 손가락 100% 드롭!**":""}`});
    return message.reply({ embeds:[embed], components:[mkBattleButtons(player)] });
  }

  if (cmd==="술식") return message.reply({ embeds:[buildSkillEmbed(player)] });

  if (cmd==="가챠"||cmd==="가챠10") {
    const count=cmd==="가챠10"?10:(parseInt(args[1])||1);
    if (count!==1&&count!==10) return message.reply("❌ 1회 또는 10회만 가능!");
    const cost=count===1?150:1350;
    if (player.crystals<cost) return message.reply(`💎 부족! (필요: ${cost})`);
    player.crystals-=cost; updateQuestProgress(player,"gacha_pull",1);
    const loadingMsg=await message.reply({ embeds:[gachaLoadingEmbed(1)] });
    await new Promise(r=>setTimeout(r,1500));
    await loadingMsg.edit({ embeds:[gachaLoadingEmbed(2)] });
    await new Promise(r=>setTimeout(r,1500));
    if (count===1) {
      const result=rollGacha(1)[0];
      const isNew=!player.owned.includes(result);
      if (isNew) player.owned.push(result); else player.crystals+=50;
      await loadingMsg.edit({ embeds:[gachaRevealEmbed(CHARACTERS[result].grade),gachaResultEmbed(result,isNew,player)] });
    } else {
      const results=rollGacha(10);
      const dupCrystals=results.filter(id=>player.owned.includes(id)).length*50;
      const newOnes=results.filter(id=>!player.owned.includes(id));
      for (const id of newOnes) player.owned.push(id);
      player.crystals+=dupCrystals;
      await loadingMsg.edit({ embeds:[gacha10ResultEmbed(results,newOnes,dupCrystals,player)] });
    }
    savePlayer(userId); return;
  }

  if (cmd==="출석") {
    const now=Date.now();
    if (now-(player.lastDaily||0)<86400000) { const h=Math.ceil((86400000-(now-player.lastDaily))/3600000); return message.reply(`⏰ ${h}시간 후 가능`); }
    const streak=Math.min(player.dailyStreak||0,30); const cr=100+streak*5;
    player.crystals+=cr; player.lastDaily=now; player.dailyStreak=(player.dailyStreak||0)+1;
    await message.reply(`✅ 출석! **+${cr}💎** (연속 ${player.dailyStreak}일)`);
    savePlayer(userId); return;
  }

  if (cmd==="회복") {
    if (player.potion<=0) return message.reply("❌ 회복약 없음!");
    const stats=getPlayerStats(player); player.hp=stats.maxHp; player.potion--;
    await message.reply(`✅ HP 완전 회복! (남은: **${player.potion}개**)`);
    savePlayer(userId); return;
  }

  if (cmd==="코가네가챠") {
    if (player.crystals<200) return message.reply("💎 부족! (필요: 200)");
    player.crystals-=200; player.koganeGachaCount=(player.koganeGachaCount||0)+1;
    const grade=rollKogane();
    const gradeOrder=["3급","2급","1급","특급","전설"];
    const isUpgrade=!player.kogane||gradeOrder.indexOf(grade)>gradeOrder.indexOf(player.kogane.grade);
    if (isUpgrade) player.kogane={ grade }; else player.crystals+=50;
    await message.reply(`🐾 **코가네 [${grade}]** ${isUpgrade?"(등급 상승!)":"(중복 +50💎)"}\n${KOGANE_GRADES[grade].passiveDesc}`);
    savePlayer(userId); return;
  }

  if (cmd==="코가네") return message.reply({ embeds:[koganeProfileEmbed(player)] });

  if (cmd==="손가락") {
    const fingers=player.sukunaFingers||0; const bonus=getFingerBonus(fingers);
    await message.reply(`👹 **스쿠나 손가락**: ${fingers}/${SUKUNA_FINGER_MAX} — ${bonus.label}\nATK+${bonus.atkBonus} | DEF+${bonus.defBonus} | HP+${bonus.hpBonus}\n${isSukunaUnlocked(player)?"✅ 스쿠나 해금됨":"🔒 스쿠나 보스 처치로 해금!"}`);
    return;
  }

  if (cmd==="컬링") {
    if (cullings[userId]) return message.reply("🌊 이미 컬링 중!");
    const firstEnemy=pickCullingEnemy(1);
    cullings[userId]={ wave:1,kills:0,totalXp:0,totalCrystals:0, currentEnemy:firstEnemy,enemyHp:firstEnemy.hp };
    return message.reply({ embeds:[cullingEmbed(player,cullings[userId])], components:[mkCullingButtons(player)] });
  }

  if (cmd==="사멸회유") {
    if (jujutsus[userId]) return message.reply("🎯 이미 사멸회유 중!");
    const choices=generateJujutsuChoices(1);
    jujutsus[userId]={ wave:1,points:0,totalXp:0,totalCrystals:0, choices,currentEnemy:null,enemyHp:0 };
    return message.reply({ embeds:[jujutsuEmbed(player,jujutsus[userId],[],choices)], components:mkJujutsuButtons(player,choices) });
  }

  if (cmd==="결투") {
    const target=message.mentions.users.first();
    if (!target) return message.reply("❌ !결투 @유저");
    if (target.id===userId) return message.reply("❌ 자신과 결투 불가!");
    if (getPvpSessionByUser(userId)||getPvpSessionByUser(target.id)) return message.reply("❌ 이미 PvP 중!");
    pvpChallenges[userId]={ target:target.id };
    const p2=getPlayer(target.id,target.username);
    const p1ch=CHARACTERS[player.active], p2ch=CHARACTERS[p2.active];
    const buttons=new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`pvp_challenge_accept_${userId}`).setLabel("✅ 수락").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`pvp_challenge_decline_${userId}`).setLabel("❌ 거절").setStyle(ButtonStyle.Danger),
    );
    await message.reply({ content:`${target}`, embeds:[new EmbedBuilder().setTitle("⚔️ PvP 결투 신청").setColor(0xF5C842).setDescription(`> **${message.author.username}** ${p1ch.emoji}[${p1ch.grade}]  VS  ${p2ch.emoji}[${p2ch.grade}] **${target.username}**`).setFooter({ text:"30초 내 수락/거절" })], components:[buttons] });
    setTimeout(()=>{ if(pvpChallenges[userId]) delete pvpChallenges[userId]; },30000);
    return;
  }

  if (cmd==="파티생성") {
    if (getPartyId(userId)) return message.reply("❌ 이미 파티 소속!");
    const partyId=`${_partyIdSeq++}`;
    parties[partyId]={ id:partyId,leader:userId,members:[userId],bestWave:0 };
    return message.reply(`✅ 파티 생성! ID: **${partyId}**`);
  }

  if (cmd==="파티초대") {
    const target=message.mentions.users.first();
    if (!target) return message.reply("❌ !파티초대 @유저");
    const party=getParty(userId);
    if (!party) return message.reply("❌ 파티 없음!");
    if (party.leader!==userId) return message.reply("❌ 파티장만 초대!");
    if (party.members.length>=4) return message.reply("❌ 파티 가득참!");
    if (getPartyId(target.id)) return message.reply("❌ 이미 다른 파티 소속!");
    partyInvites[target.id]={ partyId:party.id, inviter:userId };
    const buttons=new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`party_invite_accept_${party.id}_${target.id}`).setLabel("✅ 수락").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`party_invite_decline_${party.id}_${target.id}`).setLabel("❌ 거절").setStyle(ButtonStyle.Danger),
    );
    await message.reply({ content:`${target}`, embeds:[new EmbedBuilder().setTitle("👥 파티 초대").setColor(0x4ade80).setDescription(`**${message.author.username}** 의 초대!`)], components:[buttons] });
    setTimeout(()=>{ if(partyInvites[target.id]) delete partyInvites[target.id]; },60000);
    return;
  }

  if (cmd==="파티나가기") {
    const party=getParty(userId); if (!party) return message.reply("❌ 파티 없음!");
    const isLeader=party.leader===userId;
    party.members=party.members.filter(id=>id!==userId);
    if (party.members.length===0) { delete parties[party.id]; return message.reply("✅ 파티 탈퇴 (파티 해체)"); }
    if (isLeader) party.leader=party.members[0];
    return message.reply("✅ 파티 탈퇴");
  }

  if (cmd==="파티컬링") {
    const party=getParty(userId);
    if (!party) return message.reply("❌ 파티 없음!");
    if (party.leader!==userId) return message.reply("❌ 파티장만 시작!");
    if (cullings[party.id]) return message.reply("🌊 이미 파티 컬링 중!");
    const firstEnemy=pickCullingEnemy(1);
    cullings[party.id]={ wave:1,kills:0,totalXp:0,totalCrystals:0, currentEnemy:firstEnemy,enemyHp:firstEnemy.hp };
    return message.reply({ embeds:[partyCullingEmbed(party,cullings[party.id])], components:[mkCullingButtons(player)] });
  }

  if (cmd==="레이드") {
    const bossId=args[1]?.toLowerCase();
    if (!bossId||!RAID_BOSSES[bossId]) return message.reply("❌ !레이드 [heian/mahara]\n> `heian` = 헤이안 스쿠나\n> `mahara` = 마허라가라");
    const party=getParty(userId);
    if (!party) return message.reply("❌ 파티가 필요합니다! `!파티생성` 으로 파티를 만드세요.");
    if (party.leader!==userId) return message.reply("❌ 파티장만 레이드 시작 가능!");
    if (party.members.length<2) return message.reply("❌ 레이드는 최소 2명 필요!");
    if (raidSessions[party.id]) return message.reply("❌ 이미 레이드 진행 중!");
    const boss=RAID_BOSSES[bossId];
    raidSessions[party.id]={ partyId:party.id, boss, bossHp:boss.hp, bossStatus:[], adaptedSkill:null, totalDmg:0, phase:1 };
    const embed=new EmbedBuilder()
      .setTitle(`💥 레이드 시작! — ${boss.emoji} ${boss.name}`)
      .setColor(bossId==="heian"?0x8b0000:0x4a0000)
      .setDescription([
        "```ansi",`\u001b[1;31m╔══════════════════════╗`,
        bossId==="heian"?`\u001b[1;31m║  👹 헤이안 시대 스쿠나 등장!  ║`:`\u001b[1;35m║  🐍 마허라가라 등장!  ║`,
        `\u001b[1;31m╚══════════════════════╝`,"```",
        `> **${boss.desc}**`,
        bossId==="heian"?"> ⚠️ 기존 스쿠나의 **2배** 공격력과 체력!":"> ⚠️ 첫 번째 술식에 **적응** — 해당 술식 무효화!",
        `> 💚 HP: **${boss.hp}** | 🗡️ ATK: **${boss.atk}**`,
      ].join("\n"));
    return message.reply({ embeds:[embed,raidEmbed(party,raidSessions[party.id])], components:[mkRaidButtons(player)] });
  }

  if (cmd==="코드") {
    const code=args[1]?.toLowerCase();
    if (!code) return message.reply("!코드 [코드명]");
    if (player.usedCodes.includes(code)) return message.reply("❌ 이미 사용한 코드!");
    if (CODES[code]) {
      player.crystals+=(CODES[code].crystals||0); player.usedCodes.push(code);
      await message.reply(`✅ 코드 사용! +${CODES[code].crystals||0}💎`);
      savePlayer(userId);
    } else return message.reply("❌ 유효하지 않은 코드!");
    return;
  }

  if (cmd==="퀘스트") return message.reply({ embeds:[questEmbed(player)] });

  if (cmd==="퀘보상") {
    const type=args[1], idx=parseInt(args[2])-1;
    if (type!=="일"&&type!=="주") return message.reply("❌ !퀘보상 일 [번호] 또는 !퀘보상 주 [번호]");
    initQuests(player);
    const isWeekly=type==="주";
    const list=isWeekly?player.quests.weekly:player.quests.daily;
    if (isNaN(idx)||idx<0||idx>=list.length) return message.reply(`❌ 번호 오류 (1~${list.length})`);
    const qp=list[idx];
    if (!qp.done) return message.reply("❌ 아직 완료 안됨!");
    if (qp.claimed) return message.reply("❌ 이미 수령한 보상!");
    const reward=claimQuestReward(player,qp.id,isWeekly);
    if (!reward) return message.reply("❌ 수령 실패");
    const matStr=reward.materials?Object.entries(reward.materials).map(([m,q])=>`${MATERIALS[m]?.emoji||""}**${MATERIALS[m]?.name||m}**×${q}`).join(", "):"없음";
    await message.reply(`🎁 **보상 수령!**\n> +${reward.crystals}💎 +${reward.xp}XP\n> 재료: ${matStr}`);
    savePlayer(userId); return;
  }

  if (cmd==="재료") return message.reply({ embeds:[materialsEmbed(player)] });
