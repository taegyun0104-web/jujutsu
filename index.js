// ════════════════════════════════════════════════════════
// 주술회전 RPG 봇 — PART 1 (완전 수정본 v3.0)
// ════════════════════════════════════════════════════════
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
const GACHA_RARITY = {
  "특급":  { stars:"★★★★★", color:0xF5C842, effect:"✨🔱✨🔱✨", flash:"LEGENDARY" },
  "준특급":{ stars:"★★★★☆", color:0xff8c00, effect:"💠💠💠💠💠", flash:"EPIC" },
  "1급":   { stars:"★★★☆☆", color:0x7C5CFC, effect:"⭐⭐⭐⭐",   flash:"RARE" },
  "준1급": { stars:"★★★☆☆", color:0x9b72cf, effect:"⭐⭐⭐",     flash:"RARE" },
  "2급":   { stars:"★★☆☆☆", color:0x4ade80, effect:"🔹🔹🔹",   flash:"UNCOMMON" },
  "3급":   { stars:"★☆☆☆☆", color:0x94a3b8, effect:"◽◽",       flash:"COMMON" },
};

// ════════════════════════════════════════════════════════
// ── 📦 재료 시스템
// ════════════════════════════════════════════════════════
const MATERIALS = {
  cursed_thread:  { name:"저주 실",   emoji:"🧵", desc:"저급 저주령에서 획득." },
  cursed_bone:    { name:"저주 뼈",   emoji:"🦴", desc:"1급 저주령에서 획득." },
  cursed_core:    { name:"저주 핵",   emoji:"💜", desc:"특급 저주령에서 획득." },
  cursed_crystal: { name:"저주 수정", emoji:"💎", desc:"보스에서 획득." },
  iron_fragment:  { name:"철 파편",   emoji:"⚙️", desc:"모든 적에서 획득." },
  spirit_essence: { name:"영혼 정수", emoji:"✨", desc:"특급 이상 적에서 획득." },
  dragon_scale:   { name:"용 비늘",   emoji:"🐉", desc:"보스에서 획득." },
  sukuna_finger_shard:{ name:"스쿠나 파편", emoji:"👹", desc:"스쿠나 처치 시 획득." },
};

const WEAPONS = {
  cursed_knife:  { name:"저주 단검",     emoji:"🗡️", grade:"일반",  atkBonus:15,  defBonus:0,  hpBonus:0,   desc:"저주 에너지가 깃든 단검.",                      recipe:{ cursed_thread:3, iron_fragment:5 },                           color:0x94a3b8 },
  cursed_blade:  { name:"저주 도검",     emoji:"⚔️", grade:"희귀",  atkBonus:35,  defBonus:5,  hpBonus:100, desc:"날카로운 저주 도검.",                             recipe:{ cursed_bone:4, iron_fragment:8, cursed_thread:2 },             color:0x4ade80 },
  cursed_spear:  { name:"저주 창",       emoji:"🔱", grade:"희귀",  atkBonus:45,  defBonus:0,  hpBonus:0,   desc:"원거리 공격이 가능한 저주 창.",                   recipe:{ cursed_bone:5, cursed_thread:5 },                             color:0x4ade80 },
  spirit_shield: { name:"영혼 방패",     emoji:"🛡️", grade:"고급",  atkBonus:5,   defBonus:40, hpBonus:300, desc:"영혼 정수로 만든 방어 도구.",                     recipe:{ spirit_essence:3, cursed_core:2, iron_fragment:10 },          color:0x7C5CFC },
  cursed_hammer: { name:"저주 망치",     emoji:"🔨", grade:"고급",  atkBonus:60,  defBonus:10, hpBonus:150, desc:"묵직한 저주 망치.",                               recipe:{ cursed_core:3, cursed_bone:6, iron_fragment:12 },             color:0x7C5CFC },
  dragon_sword:  { name:"용의 검",       emoji:"⚔️", grade:"전설",  atkBonus:100, defBonus:30, hpBonus:500, desc:"용 비늘로 만든 전설의 검.",                       recipe:{ dragon_scale:3, cursed_crystal:2, spirit_essence:5, cursed_core:4 }, color:0xF5C842 },
  sukuna_vessel: { name:"스쿠나의 그릇", emoji:"👹", grade:"전설",  atkBonus:80,  defBonus:20, hpBonus:800, desc:"스쿠나의 힘이 깃든 주구.",                         recipe:{ cursed_crystal:3, dragon_scale:2, cursed_core:6 },            color:0x8b0000 },
};

const ENEMY_DROPS = {
  e1: [{ mat:"cursed_thread",  min:1,max:3,chance:0.80 },{ mat:"iron_fragment",  min:1,max:2,chance:0.60 },{ mat:"cursed_bone",    min:1,max:1,chance:0.10 }],
  e2: [{ mat:"cursed_bone",    min:1,max:2,chance:0.70 },{ mat:"iron_fragment",  min:2,max:4,chance:0.80 },{ mat:"cursed_thread",  min:2,max:4,chance:0.50 },{ mat:"cursed_core",min:1,max:1,chance:0.08 }],
  e3: [{ mat:"cursed_core",    min:1,max:2,chance:0.65 },{ mat:"spirit_essence", min:1,max:2,chance:0.55 },{ mat:"cursed_bone",    min:2,max:4,chance:0.80 },{ mat:"iron_fragment",min:3,max:6,chance:0.90 },{ mat:"cursed_crystal",min:1,max:1,chance:0.05 }],
  e4: [{ mat:"cursed_crystal", min:1,max:2,chance:0.80 },{ mat:"dragon_scale",   min:1,max:2,chance:0.60 },{ mat:"spirit_essence", min:2,max:4,chance:0.90 },{ mat:"cursed_core",min:2,max:4,chance:0.90 },{ mat:"iron_fragment",min:5,max:10,chance:1.00 }],
  e_sukuna: [{ mat:"sukuna_finger_shard",min:1,max:1,chance:1.00 },{ mat:"cursed_crystal",min:2,max:3,chance:1.00 },{ mat:"dragon_scale",min:2,max:3,chance:1.00 },{ mat:"spirit_essence",min:4,max:6,chance:1.00 }],
  raid_heian: [{ mat:"cursed_crystal",min:3,max:5,chance:1.00 },{ mat:"dragon_scale",min:3,max:4,chance:1.00 },{ mat:"spirit_essence",min:5,max:8,chance:1.00 },{ mat:"sukuna_finger_shard",min:2,max:3,chance:1.00 }],
  raid_mahoraga: [{ mat:"cursed_crystal",min:3,max:5,chance:1.00 },{ mat:"dragon_scale",min:4,max:6,chance:1.00 },{ mat:"spirit_essence",min:5,max:8,chance:1.00 },{ mat:"iron_fragment",min:10,max:20,chance:1.00 }],
};
const JUJUTSU_DROPS = {
  j1:[{ mat:"cursed_thread",min:1,max:2,chance:0.70 },{ mat:"iron_fragment",min:1,max:2,chance:0.60 }],
  j2:[{ mat:"cursed_thread",min:1,max:3,chance:0.70 },{ mat:"cursed_bone",min:1,max:1,chance:0.35 },{ mat:"iron_fragment",min:1,max:3,chance:0.65 }],
  j3:[{ mat:"cursed_bone",min:1,max:2,chance:0.55 },{ mat:"iron_fragment",min:1,max:3,chance:0.70 }],
  j4:[{ mat:"cursed_core",min:1,max:1,chance:0.30 },{ mat:"cursed_bone",min:1,max:3,chance:0.65 },{ mat:"spirit_essence",min:1,max:1,chance:0.20 }],
  j5:[{ mat:"cursed_core",min:1,max:2,chance:0.55 },{ mat:"spirit_essence",min:1,max:2,chance:0.40 },{ mat:"cursed_crystal",min:1,max:1,chance:0.08 }],
  j6:[{ mat:"cursed_crystal",min:1,max:1,chance:0.50 },{ mat:"dragon_scale",min:1,max:1,chance:0.30 },{ mat:"spirit_essence",min:2,max:3,chance:0.80 }],
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
  if (!player.equippedWeapon) return { atk:0, def:0, hp:0 };
  const w = WEAPONS[player.equippedWeapon];
  if (!w) return { atk:0, def:0, hp:0 };
  return { atk:w.atkBonus, def:w.defBonus, hp:w.hpBonus };
}

// ════════════════════════════════════════════════════════
// ── 퀘스트 시스템
// ════════════════════════════════════════════════════════
const DAILY_QUESTS = [
  { id:"dq_battle3",  type:"battle_win",   target:3,  name:"오늘의 수련",   desc:"전투 3회 승리",              reward:{ crystals:80,  xp:150, materials:{ iron_fragment:3 } } },
  { id:"dq_culling5", type:"culling_wave",  target:5,  name:"컬링 특훈",    desc:"컬링 게임 5웨이브 달성",      reward:{ crystals:100, xp:200, materials:{ cursed_thread:5 } } },
  { id:"dq_jujutsu3", type:"jujutsu_point",target:3,  name:"사멸회유 임무", desc:"사멸회유 3포인트 달성",       reward:{ crystals:90,  xp:180, materials:{ cursed_bone:2 } } },
  { id:"dq_skill5",   type:"skill_use",    target:5,  name:"술식 연마",    desc:"술식 5회 사용",               reward:{ crystals:70,  xp:130, materials:{ cursed_thread:3, iron_fragment:2 } } },
  { id:"dq_gacha1",   type:"gacha_pull",   target:1,  name:"운명의 소환",  desc:"가챠 1회 소환",               reward:{ crystals:60,  xp:100, materials:{ iron_fragment:5 } } },
  { id:"dq_nokill2",  type:"boss_kill",    target:2,  name:"정예 사냥",    desc:"특급 저주령 이상 2마리 처치", reward:{ crystals:150, xp:300, materials:{ cursed_core:1 } } },
];
const WEEKLY_QUESTS = [
  { id:"wq_battle20",  type:"battle_win",   target:20, name:"주간 전사",       desc:"이번 주 전투 20회 승리",        reward:{ crystals:500, xp:1000, materials:{ cursed_core:3, spirit_essence:2 } } },
  { id:"wq_culling15", type:"culling_wave",  target:15, name:"컬링 마스터",    desc:"컬링 15웨이브 달성(합산)",      reward:{ crystals:600, xp:1200, materials:{ cursed_crystal:1, cursed_bone:8 } } },
  { id:"wq_jujutsu15", type:"jujutsu_point",target:15, name:"사멸회유 전문가", desc:"사멸회유 총 15포인트 달성",     reward:{ crystals:550, xp:1100, materials:{ spirit_essence:4, cursed_core:2 } } },
  { id:"wq_boss5",     type:"boss_kill",    target:5,  name:"보스 사냥꾼",    desc:"특급 저주령 이상 5마리 처치",   reward:{ crystals:700, xp:1400, materials:{ dragon_scale:1, cursed_crystal:1 } } },
  { id:"wq_craft1",    type:"weapon_craft", target:1,  name:"주구 장인",      desc:"주구 1개 제작",                 reward:{ crystals:400, xp:800,  materials:{ spirit_essence:3, dragon_scale:1 } } },
  { id:"wq_pvpwin3",   type:"pvp_win",      target:3,  name:"결투 챔피언",    desc:"PvP 3회 승리",                  reward:{ crystals:800, xp:1600, materials:{ cursed_crystal:2, dragon_scale:1 } } },
];

function getTodayKey() { const d=new Date(); return `${d.getUTCFullYear()}-${d.getUTCMonth()+1}-${d.getUTCDate()}`; }
function getWeekKey()  { const d=new Date(); const w=new Date(d); w.setUTCDate(d.getUTCDate()-d.getUTCDay()); return `${w.getUTCFullYear()}-${w.getUTCMonth()+1}-${w.getUTCDate()}`; }

function initQuests(player) {
  const today=getTodayKey(), week=getWeekKey();
  if (!player.quests) player.quests={};
  if (player.quests.dailyKey!==today) {
    player.quests.dailyKey=today;
    const picked=[...DAILY_QUESTS].sort(()=>Math.random()-0.5).slice(0,3);
    player.quests.daily=picked.map(q=>({ id:q.id,progress:0,done:false,claimed:false }));
  }
  if (player.quests.weekKey!==week) {
    player.quests.weekKey=week;
    const picked=[...WEEKLY_QUESTS].sort(()=>Math.random()-0.5).slice(0,3);
    player.quests.weekly=picked.map(q=>({ id:q.id,progress:0,done:false,claimed:false }));
  }
  if (!player.quests.daily)  player.quests.daily=[];
  if (!player.quests.weekly) player.quests.weekly=[];
}
function updateQuestProgress(player,type,amount=1) {
  initQuests(player);
  for (const qp of player.quests.daily) {
    if (qp.done) continue;
    const def=DAILY_QUESTS.find(q=>q.id===qp.id);
    if (!def||def.type!==type) continue;
    qp.progress=Math.min(qp.progress+amount,def.target);
    if (qp.progress>=def.target) qp.done=true;
  }
  for (const qp of player.quests.weekly) {
    if (qp.done) continue;
    const def=WEEKLY_QUESTS.find(q=>q.id===qp.id);
    if (!def||def.type!==type) continue;
    qp.progress=Math.min(qp.progress+amount,def.target);
    if (qp.progress>=def.target) qp.done=true;
  }
}
function claimQuestReward(player,questId,isWeekly=false) {
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
  poison:        { id:"poison",        name:"독",      emoji:"☠️", desc:"매 턴 최대HP의 5% 피해",       duration:3 },
  burn:          { id:"burn",          name:"화상",    emoji:"🔥", desc:"매 턴 최대HP의 8% 피해",       duration:2 },
  freeze:        { id:"freeze",        name:"빙결",    emoji:"❄️", desc:"1턴 행동 불가",                 duration:1 },
  weaken:        { id:"weaken",        name:"약화",    emoji:"💔", desc:"공격력 30% 감소",               duration:2 },
  stun:          { id:"stun",          name:"기절",    emoji:"⚡", desc:"1턴 행동 불가",                 duration:1 },
  battleInstinct:{ id:"battleInstinct",name:"전투본능",emoji:"🔥💪",desc:"공격력 40% 증가, 회피율 25% 증가",duration:3 },
  cursed_wound:  { id:"cursed_wound",  name:"저주상처",emoji:"🩸", desc:"매 턴 최대HP의 10% 피해",      duration:2 },
  blind:         { id:"blind",         name:"실명",    emoji:"🌑", desc:"명중률 50% 감소",               duration:2 },
  adaptation:    { id:"adaptation",    name:"적응",    emoji:"🔄", desc:"특정 술식 데미지 무효",         duration:99 },
};

function applyStatus(target,statusId) {
  if (!target.statusEffects) target.statusEffects=[];
  const existing=target.statusEffects.find(s=>s.id===statusId);
  if (existing) existing.turns=STATUS_EFFECTS[statusId].duration;
  else target.statusEffects.push({ id:statusId, turns:STATUS_EFFECTS[statusId].duration });
}
function tickStatus(target,maxHp) {
  if (!target.statusEffects||target.statusEffects.length===0) return { dmg:0,expired:[],log:[] };
  let totalDmg=0; const expired=[],log=[];
  for (const se of target.statusEffects) {
    const def=STATUS_EFFECTS[se.id];
    if (!def) { se.turns=0; continue; }
    if (se.id==="poison")       { const d=Math.max(1,Math.floor(maxHp*0.05)); totalDmg+=d; log.push(`> ${def.emoji} **${def.name}** — **${d}** 피해!`); }
    if (se.id==="burn")         { const d=Math.max(1,Math.floor(maxHp*0.08)); totalDmg+=d; log.push(`> ${def.emoji} **${def.name}** — **${d}** 피해!`); }
    if (se.id==="cursed_wound") { const d=Math.max(1,Math.floor(maxHp*0.10)); totalDmg+=d; log.push(`> ${def.emoji} **${def.name}** — **${d}** 피해!`); }
    se.turns--;
    if (se.turns<=0) expired.push(se.id);
  }
  target.statusEffects=target.statusEffects.filter(s=>s.turns>0);
  if (totalDmg>0) target.hp=Math.max(0,target.hp-totalDmg);
  return { dmg:totalDmg,expired,log };
}
function statusStr(se) {
  if (!se||se.length===0) return "없음";
  return se.map(s=>`${STATUS_EFFECTS[s.id]?.emoji||""}${STATUS_EFFECTS[s.id]?.name||s.id}(${s.turns}턴)`).join(" ");
}
function isIncapacitated(se) { return !!(se&&se.some(s=>s.id==="freeze"||s.id==="stun")); }
function isBlind(se) { return !!(se&&se.some(s=>s.id==="blind")); }
function getWeakenMult(se) {
  let m=1;
  if (se&&se.some(s=>s.id==="weaken")) m*=0.7;
  if (se&&se.some(s=>s.id==="battleInstinct")) m*=1.4;
  return m;
}
function getBattleInstinctEvade(se) { return !!(se&&se.some(s=>s.id==="battleInstinct")); }
function rollHit(attackerSe,defenderSe) {
  if (isBlind(attackerSe)&&Math.random()<0.50) return false;
  const baseEvade=0.05;
  const instinctBonus=getBattleInstinctEvade(defenderSe)?0.25:0;
  return Math.random()>(baseEvade+instinctBonus);
}

// ════════════════════════════════════════════════════════
// ── 흑섬
// ════════════════════════════════════════════════════════
function isBlackFlash() { return Math.random()<0.10; }
function getBlackFlashArt() {
  return [
    "```ansi",
    "\u001b[1;30m╔══════════════════════════════════════╗",
    "\u001b[1;31m║  ⚫  B L A C K   F L A S H  ⚫     ║",
    "\u001b[1;33m║     저주 에너지 순간 최대 방출!!      ║",
    "\u001b[1;30m╚══════════════════════════════════════╝",
    "```",
  ].join("\n");
}

// ════════════════════════════════════════════════════════
// ── 스쿠나 손가락
// ════════════════════════════════════════════════════════
const SUKUNA_FINGER_MAX = 20;
function getFingerBonus(fingers) {
  return {
    atkBonus:  Math.floor(fingers * 15),
    defBonus:  Math.floor(fingers * 8),
    hpBonus:   fingers * 300,
    dmgMult:   1 + fingers * 0.03,
    label: fingers>=20 ? "🔴 스쿠나 완전 각성 — 저주의 왕" :
           fingers>=15 ? "🔴 스쿠나 각성 Lv.4" :
           fingers>=10 ? "🟠 스쿠나 각성 Lv.3" :
           fingers>=5  ? "🟡 스쿠나 각성 Lv.2" :
           fingers>=1  ? "🟢 스쿠나 각성 Lv.1 — 스쿠나 해금!" : "스쿠나 봉인 중 (손가락 1개 필요)",
  };
}

// ════════════════════════════════════════════════════════
// ── 코가네 펫
// ════════════════════════════════════════════════════════
const KOGANE_GRADES = {
  "전설":{ color:0xF5C842,emoji:"🌟",stars:"★★★★★",rate:0.5,  atkBonus:0.25,defBonus:0.20,hpBonus:0.20,xpBonus:0.30,crystalBonus:0.25, skill:"황금 포효",   skillDesc:"전투 시작 시 적에게 추가 피해 (ATK의 50%)", skillChance:0.35, passiveDesc:"ATK+25% DEF+20% HP+20% XP+30% 크리스탈+25%" },
  "특급":{ color:0xff8c00,emoji:"🔶",stars:"★★★★☆",rate:2.0,  atkBonus:0.18,defBonus:0.15,hpBonus:0.15,xpBonus:0.20,crystalBonus:0.18, skill:"황금 이빨",   skillDesc:"공격 시 15% 확률로 약화 부여",              skillChance:0.15, passiveDesc:"ATK+18% DEF+15% HP+15% XP+20% 크리스탈+18%" },
  "1급": { color:0x7C5CFC,emoji:"🔷",stars:"★★★☆☆",rate:8.0,  atkBonus:0.12,defBonus:0.10,hpBonus:0.10,xpBonus:0.12,crystalBonus:0.10, skill:"황금 발톱",   skillDesc:"공격 시 10% 확률로 추가타 (ATK의 30%)",     skillChance:0.10, passiveDesc:"ATK+12% DEF+10% HP+10% XP+12% 크리스탈+10%" },
  "2급": { color:0x4ade80,emoji:"🟢",stars:"★★☆☆☆",rate:22.5, atkBonus:0.07,defBonus:0.06,hpBonus:0.06,xpBonus:0.07,crystalBonus:0.06, skill:"황금 보호막", skillDesc:"HP 30% 이하 시 1회 피해 50% 감소",          skillChance:1.0,  passiveDesc:"ATK+7% DEF+6% HP+6% XP+7% 크리스탈+6%"    },
  "3급": { color:0x94a3b8,emoji:"⚪",stars:"★☆☆☆☆",rate:67.0, atkBonus:0.03,defBonus:0.02,hpBonus:0.02,xpBonus:0.03,crystalBonus:0.02, skill:"황금 냄새",   skillDesc:"전투 후 크리스탈 +5% 추가 획득",             skillChance:1.0,  passiveDesc:"ATK+3% DEF+2% HP+2% XP+3% 크리스탈+2%"    },
};
const KOGANE_POOL=[{grade:"전설",rate:0.5},{grade:"특급",rate:2.0},{grade:"1급",rate:8.0},{grade:"2급",rate:22.5},{grade:"3급",rate:67.0}];
function rollKogane() {
  const total=KOGANE_POOL.reduce((s,p)=>s+p.rate,0); let roll=Math.random()*total;
  for (const e of KOGANE_POOL) { roll-=e.rate; if (roll<=0) return e.grade; }
  return "3급";
}
function getKoganeBonus(player) {
  if (!player.kogane?.grade) return { atk:1,def:1,hp:1,xp:1,crystal:1 };
  const g=KOGANE_GRADES[player.kogane.grade];
  if (!g) return { atk:1,def:1,hp:1,xp:1,crystal:1 };
  return { atk:1+g.atkBonus,def:1+g.defBonus,hp:1+g.hpBonus,xp:1+g.xpBonus,crystal:1+g.crystalBonus };
}

// ════════════════════════════════════════════════════════
// ── 스킬 이펙트
// ════════════════════════════════════════════════════════
const SKILL_EFFECTS = {
  "주먹질":      { art:"⚡ **[ 일 격 ]**",               color:0xff6b35, flavorText:"저주 에너지를 주먹에 집중!" },
  "다이버전트 주먹":{ art:"💥 **[ 발 산 ]**",            color:0xff4500, flavorText:"체내에서 저주 에너지 폭발!" },
  "흑섬":        { art:"⚫ **[ 黑  閃 ]**",              color:0x1a0a2e, flavorText:"순간 최대 저주 에너지 방출!" },
  "어주자":      { art:"👹 **[ 廻  夏 ]**",              color:0xb5451b, flavorText:"스쿠나의 힘이 몸을 채운다..." },
  "스쿠나 발현": { art:"🔴 **[ 両面宿儺 ]**",            color:0x8b0000, flavorText:"저주의 왕이 몸을 장악한다!" },
  "아오":        { art:"🔵 **[ 蒼 ]**",                  color:0x0066ff, flavorText:"무한의 인력 — 모든 것을 끌어당긴다" },
  "아카":        { art:"🔴 **[ 赫 ]**",                  color:0xff0033, flavorText:"무한의 척력 — 모든 것을 날려버린다!" },
  "무라사키":    { art:"🟣 **[ 紫 ]**",                  color:0x9900ff, flavorText:"아오+아카 융합 — 허공을 찢는다!" },
  "무량공처":    { art:"∞ **[ 無量空処 ]**",             color:0x00ffff, flavorText:"\"나는 최강이니까\"" },
  "자폭 무라사키":{ art:"💥 **[ 自爆 紫 ]**",            color:0xff0000, flavorText:"모든 힘을 쏟아붓는 자폭 공격!" },
  "해":          { art:"✂️ **[ 解 ]**",                  color:0xcc0000, flavorText:"만물을 베어내는 저주의 왕의 손톱!" },
  "팔":          { art:"🌌 **[ 捌 ]**",                  color:0x8b0000, flavorText:"공간 자체를 베어내는 절대술식!" },
  "푸가":        { art:"💀 **[ 不 雅 ]**",               color:0x4a0000, flavorText:"닿는 모든 것을 분해한다!" },
  "복마어주자":  { art:"👑 **[ 伏魔御廚子 ]**",          color:0x2a0000, flavorText:"천지개벽 — 저주의 왕의 궁극 영역전개!" },
  "세계참":      { art:"🌍 **[ 世界斬 ]**",              color:0x4a0000, flavorText:"세계조차 베어버린다!" },
  "부기우기":    { art:"🎵 **[ Boogie Woogie ]**",       color:0x1e90ff, flavorText:"빙결의 한기와 함께 위치 전환!" },
  "전투본능":    { art:"🔥 **[ 戦闘本能 ]**",            color:0xff8c00, flavorText:"전사의 본능이 각성한다!" },
  "험한 도박":   { art:"🎰 **[ 험 한 도 박 ]**",        color:0xffaa00, flavorText:"운에 맡긴 도박 공격!" },
  "질풍열차":    { art:"🚂 **[ 질 풍 열 차 ]**",        color:0x44aaff, flavorText:"강력한 열차처럼 돌진!" },
  "유한 소설":   { art:"📖 **[ 有限小説 ]**",            color:0x88ff88, flavorText:"불멸의 몸으로 싸운다!" },
  "질풍강운":    { art:"🎰 **[ 質風強運 ]**",            color:0xffcc00, flavorText:"영역전개 — 운이 터진다!" },
  "_default":    { art:"✨ **[ 術 式 ]**",               color:0x7c5cfc, flavorText:"저주 에너지가 폭발한다!" },
};
function getSkillEffect(n) { return SKILL_EFFECTS[n]||SKILL_EFFECTS["_default"]; }

// ════════════════════════════════════════════════════════
// ── 캐릭터 데이터
// ════════════════════════════════════════════════════════
const CHARACTERS = {
  itadori:  { name:"이타도리 유지",    emoji:"🟠", grade:"준1급", atk:90,  def:75,  spd:85,  maxHp:1000, domain:null,      desc:"특급주술사 후보생. 스쿠나의 그릇.", lore:"\"남은 건 내가 어떻게 죽느냐다.\"",   fingerSkills:true,
    awakening:null,
    skills:[
      { name:"주먹질",         minMastery:0,  dmg:95,  desc:"강력한 기본 주먹.",                              statusApply:null },
      { name:"다이버전트 주먹",minMastery:5,  dmg:160, desc:"저주 에너지를 실은 주먹.",                       statusApply:{ target:"enemy",statusId:"stun",chance:0.3 } },
      { name:"흑섬",           minMastery:15, dmg:240, desc:"최대 저주 에너지 방출!",                         statusApply:{ target:"enemy",statusId:"weaken",chance:0.5 } },
      { name:"어주자",         minMastery:30, dmg:340, desc:"스쿠나의 힘을 빌린 궁극기.",                     statusApply:{ target:"enemy",statusId:"burn",chance:0.7 } },
      { name:"스쿠나 발현",    minMastery:50, dmg:520, desc:"스쿠나가 몸을 장악! 손가락 10개 필요.",          statusApply:{ target:"enemy",statusId:"freeze",chance:0.8 } },
    ],
  },
  gojo:     { name:"고조 사토루",      emoji:"🔵", grade:"특급",  atk:130, def:120, spd:110, maxHp:1800, domain:"무량공처", desc:"최강의 주술사. 무한을 구사한다.", lore:"\"사람들이 왜 내가 최강이라고 하는지 알아?\"",
    awakening:null,
    skills:[
      { name:"아오",     minMastery:0,  dmg:145, desc:"적을 끌어당겨 공격.",          statusApply:null },
      { name:"아카",     minMastery:5,  dmg:220, desc:"적을 날려 폭발시킨다.",        statusApply:{ target:"enemy",statusId:"burn",chance:0.5 } },
      { name:"무라사키", minMastery:15, dmg:320, desc:"아오+아카 융합 발사.",          statusApply:{ target:"enemy",statusId:"weaken",chance:0.6 } },
      { name:"무량공처", minMastery:30, dmg:480, desc:"무한을 지배하는 궁극술식.",     statusApply:{ target:"enemy",statusId:"freeze",chance:0.8 } },
    ],
  },
  megumi:   { name:"후시구로 메구미",  emoji:"⚫", grade:"1급",   atk:110, def:108, spd:100, maxHp:1250, domain:"강압암예정",desc:"식신술을 구사하는 주술사.",       lore:"\"나는 선한 사람을 구하기 위해 싸운다.\"",
    awakening:null,
    skills:[
      { name:"옥견",           minMastery:0,  dmg:115, desc:"식신 옥견 소환.",          statusApply:null },
      { name:"탈토",           minMastery:5,  dmg:180, desc:"식신 대호 소환.",           statusApply:{ target:"enemy",statusId:"weaken",chance:0.4 } },
      { name:"만상",           minMastery:15, dmg:265, desc:"열 가지 식신 소환.",        statusApply:{ target:"enemy",statusId:"poison",chance:0.5 } },
      { name:"후루베 유라유라", minMastery:30, dmg:380, desc:"마허라가라 강림.",         statusApply:{ target:"enemy",statusId:"stun",chance:0.6 } },
    ],
  },
  nobara:   { name:"쿠기사키 노바라",  emoji:"🌸", grade:"1급",   atk:115, def:95,  spd:105, maxHp:1180, domain:null,      desc:"영혼에 직접 공격 가능한 주술사.", lore:"\"도쿄에 올 때부터 각오는 되어 있었어.\"",
    awakening:null,
    skills:[
      { name:"망치질", minMastery:0,  dmg:118, desc:"저주 못 박기.",                   statusApply:null },
      { name:"공명",   minMastery:5,  dmg:195, desc:"허수아비 공명 피해.",              statusApply:{ target:"enemy",statusId:"poison",chance:0.5 } },
      { name:"철정",   minMastery:15, dmg:280, desc:"저주 에너지 못 박기.",             statusApply:{ target:"enemy",statusId:"weaken",chance:0.5 } },
      { name:"발화",   minMastery:30, dmg:390, desc:"동시 폭발 공명.",                  statusApply:{ target:"enemy",statusId:"burn",chance:0.8 } },
    ],
  },
  nanami:   { name:"나나미 켄토",      emoji:"🟡", grade:"1급",   atk:118, def:108, spd:90,  maxHp:1380, domain:null,      desc:"1급 주술사. 합리적 판단의 소유자.",lore:"\"초과 근무는 사절이지만... 이건 의무다.\"",
    awakening:null,
    skills:[
      { name:"둔기 공격", minMastery:0,  dmg:120, desc:"단단한 둔기로 타격.",           statusApply:null },
      { name:"칠할삼분",  minMastery:5,  dmg:200, desc:"7:3 지점 약점 공격.",           statusApply:{ target:"enemy",statusId:"weaken",chance:0.6 } },
      { name:"십수할",    minMastery:15, dmg:290, desc:"열 배의 저주 에너지 방출.",     statusApply:null },
      { name:"초과근무",  minMastery:30, dmg:410, desc:"한계를 넘어선 폭발 강화.",      statusApply:null },
    ],
  },
  sukuna:   { name:"료멘 스쿠나",      emoji:"🔴", grade:"특급",  atk:140, def:115, spd:120, maxHp:2500, domain:"복마어주자",desc:"저주의 왕. 역대 최강의 저주된 영혼.",lore:"\"약한 놈이 강한 놈을 거스르는 건 죄악이다.\"",
    awakening:null,
    skills:[
      { name:"해",      minMastery:0,  dmg:145, desc:"손톱으로 베어낸다.",             statusApply:{ target:"enemy",statusId:"burn",chance:0.4 } },
      { name:"팔",      minMastery:5,  dmg:235, desc:"공간 자체를 베어낸다.",          statusApply:{ target:"enemy",statusId:"weaken",chance:0.5 } },
      { name:"푸가",    minMastery:15, dmg:345, desc:"닿는 모든 것을 분해.",           statusApply:{ target:"enemy",statusId:"poison",chance:0.7 } },
      { name:"복마어주자",minMastery:30,dmg:500, desc:"궁극 영역전개.",               statusApply:{ target:"enemy",statusId:"freeze",chance:0.9 } },
    ],
  },
  geto:     { name:"게토 스구루",      emoji:"🟢", grade:"특급",  atk:115, def:105, spd:100, maxHp:1600, domain:null,      desc:"전 특급 주술사. 저주 달인.",      lore:"\"주술사는 비주술사를 지켜야 한다.\"",
    awakening:null,
    skills:[
      { name:"저주 방출",   minMastery:0,  dmg:125, desc:"저급 저주령 방출.",          statusApply:null },
      { name:"최대출력",    minMastery:5,  dmg:210, desc:"저주령 전력 방출.",           statusApply:{ target:"enemy",statusId:"poison",chance:0.4 } },
      { name:"저주영조종",  minMastery:15, dmg:300, desc:"수천의 저주령 조종.",         statusApply:{ target:"enemy",statusId:"weaken",chance:0.6 } },
      { name:"감로대법",    minMastery:30, dmg:425, desc:"모든 저주 흡수.",             statusApply:{ target:"enemy",statusId:"stun",chance:0.5 } },
    ],
  },
  maki:     { name:"마키 젠인",        emoji:"⚪", grade:"준1급", atk:122, def:110, spd:115, maxHp:1300, domain:null,      desc:"저주력 없이도 강한 주술사. HP 30% 이하 시 천여주박 각성!",lore:"\"젠인 가문 — 그 이름을 내가 직접 끝내주지.\"",
    awakening:{ threshold:0.30, dmgMult:2.0, label:"천여주박 각성" },
    skills:[
      { name:"봉술",     minMastery:0,  dmg:122, desc:"저주 도구 봉 타격.",            statusApply:null },
      { name:"저주창",   minMastery:5,  dmg:200, desc:"저주 도구 창 투척.",            statusApply:{ target:"enemy",statusId:"weaken",chance:0.4 } },
      { name:"저주도구술",minMastery:15,dmg:285, desc:"다양한 저주 도구 구사.",        statusApply:{ target:"enemy",statusId:"burn",chance:0.5 } },
      { name:"천개봉파", minMastery:30, dmg:400, desc:"수천 저주 도구 연속 공격.",     statusApply:{ target:"enemy",statusId:"stun",chance:0.6 } },
    ],
  },
  panda:    { name:"판다",             emoji:"🐼", grade:"2급",   atk:105, def:118, spd:85,  maxHp:1400, domain:null,      desc:"저주로 만든 특이체질 주술사.",    lore:"\"난 판다야. 진짜 판다.\"",
    awakening:null,
    skills:[
      { name:"박치기",    minMastery:0,  dmg:108, desc:"머리로 힘차게 들이받기.",      statusApply:{ target:"enemy",statusId:"stun",chance:0.2 } },
      { name:"곰 발바닥", minMastery:5,  dmg:175, desc:"두꺼운 발바닥으로 내리치기.", statusApply:null },
      { name:"팬더 변신", minMastery:15, dmg:255, desc:"진짜 판다로 변신해 공격.",     statusApply:{ target:"enemy",statusId:"weaken",chance:0.4 } },
      { name:"고릴라 변신",minMastery:30,dmg:360, desc:"고릴라 형태로 폭발 강화.",    statusApply:{ target:"enemy",statusId:"stun",chance:0.5 } },
    ],
  },
  inumaki:  { name:"이누마키 토게",    emoji:"🟤", grade:"준1급", atk:112, def:90,  spd:110, maxHp:1120, domain:null,      desc:"주술언어를 구사하는 준1급 주술사.",lore:"\"연어알—\"",
    awakening:null,
    skills:[
      { name:"멈춰라",   minMastery:0,  dmg:115, desc:"움직임 봉쇄.",                  statusApply:{ target:"enemy",statusId:"freeze",chance:0.5 } },
      { name:"달려라",   minMastery:5,  dmg:180, desc:"무작위로 달리게 한다.",         statusApply:{ target:"enemy",statusId:"weaken",chance:0.5 } },
      { name:"주술언어", minMastery:15, dmg:265, desc:"강력한 주술 명령.",              statusApply:{ target:"enemy",statusId:"stun",chance:0.6 } },
      { name:"폭발해라", minMastery:30, dmg:375, desc:"그 자리에서 폭발.",             statusApply:{ target:"enemy",statusId:"burn",chance:0.8 } },
    ],
  },
  yuta:     { name:"오코츠 유타",      emoji:"🌟", grade:"특급",  atk:128, def:112, spd:115, maxHp:1750, domain:"진안상애", desc:"특급 주술사. 리카의 저주를 다루는 최강급.",lore:"\"리카... 나는 아직 살아야 해.\"",
    awakening:null,
    skills:[
      { name:"모방술식",  minMastery:0,  dmg:135, desc:"다른 술식을 모방 공격.",       statusApply:null },
      { name:"리카 소환", minMastery:5,  dmg:220, desc:"저주의 여왕 리카 소환.",       statusApply:{ target:"enemy",statusId:"weaken",chance:0.5 } },
      { name:"순애빔",    minMastery:15, dmg:340, desc:"리카와의 순수한 사랑을 발사.", statusApply:{ target:"enemy",statusId:"burn",chance:0.6 } },
      { name:"진안상애",  minMastery:30, dmg:480, desc:"영역전개 — 사랑으로 파괴.",   statusApply:{ target:"enemy",statusId:"freeze",chance:0.9 } },
    ],
  },
  higuruma: { name:"히구루마 히로미",  emoji:"⚖️", grade:"1급",   atk:118, def:105, spd:95,  maxHp:1320, domain:"주복사사", desc:"전직 변호사 출신 주술사.",        lore:"\"이 법정에서는 — 내가 판사다.\"",
    awakening:null,
    skills:[
      { name:"저주도구",    minMastery:0,  dmg:120, desc:"저주 에너지 도구 공격.",      statusApply:null },
      { name:"몰수",        minMastery:5,  dmg:195, desc:"상대 술식 몰수.",              statusApply:{ target:"enemy",statusId:"weaken",chance:0.7 } },
      { name:"사형판결",    minMastery:15, dmg:285, desc:"재판 결과에 따른 제재.",       statusApply:{ target:"enemy",statusId:"stun",chance:0.5 } },
      { name:"집행인 인형", minMastery:30, dmg:410, desc:"집행인 인형 소환 즉결.",      statusApply:{ target:"enemy",statusId:"freeze",chance:0.7 } },
    ],
  },
  jogo:     { name:"죠고",             emoji:"🌋", grade:"준특급", atk:125, def:100, spd:105, maxHp:1680, domain:"개관철위산",desc:"화염을 다루는 준특급 저주령.",    lore:"\"인간이야말로 진정한 저주다.\"",
    awakening:null,
    skills:[
      { name:"화염 분사",  minMastery:0,  dmg:130, desc:"강렬한 불꽃 분출.",            statusApply:{ target:"enemy",statusId:"burn",chance:0.5 } },
      { name:"용암 폭발",  minMastery:5,  dmg:215, desc:"발밑 용암 폭발.",              statusApply:{ target:"enemy",statusId:"burn",chance:0.7 } },
      { name:"극번 운",    minMastery:15, dmg:315, desc:"불타는 운석 소환.",             statusApply:{ target:"enemy",statusId:"weaken",chance:0.5 } },
      { name:"개관철위산", minMastery:30, dmg:460, desc:"화산 소환 궁극 영역전개.",     statusApply:{ target:"enemy",statusId:"burn",chance:1.0 } },
    ],
  },
  dagon:    { name:"다곤",             emoji:"🌊", grade:"준특급", atk:118, def:108, spd:96,  maxHp:1620, domain:"탕온평선", desc:"수중 저주령.",                    lore:"\"물은 모든 것을 삼킨다.\"",
    awakening:null,
    skills:[
      { name:"물고기 소환",   minMastery:0,  dmg:125, desc:"날카로운 물고기 떼 소환.",  statusApply:{ target:"enemy",statusId:"poison",chance:0.4 } },
      { name:"해수 폭발",     minMastery:5,  dmg:205, desc:"압축 해수 발사.",            statusApply:{ target:"enemy",statusId:"weaken",chance:0.5 } },
      { name:"조류 소용돌이", minMastery:15, dmg:295, desc:"거대 물 소용돌이 공격.",    statusApply:{ target:"enemy",statusId:"freeze",chance:0.4 } },
      { name:"탕온평선",      minMastery:30, dmg:450, desc:"물고기로 가득한 영역전개.", statusApply:{ target:"enemy",statusId:"poison",chance:0.9 } },
    ],
  },
  hanami:   { name:"하나미",           emoji:"🌿", grade:"준특급", atk:115, def:118, spd:93,  maxHp:1750, domain:null,      desc:"식물 저주령. 자연 술식 구사.",    lore:"\"자연은 인간의 적이 아니다.\"",
    awakening:null,
    skills:[
      { name:"나무뿌리 채찍", minMastery:0,  dmg:122, desc:"나무뿌리 채찍.",           statusApply:{ target:"enemy",statusId:"weaken",chance:0.3 } },
      { name:"꽃비",          minMastery:5,  dmg:198, desc:"독성 꽃가루 강하.",         statusApply:{ target:"enemy",statusId:"poison",chance:0.6 } },
      { name:"대지의 저주",   minMastery:15, dmg:285, desc:"대지에 저주 에너지 확산.", statusApply:{ target:"enemy",statusId:"poison",chance:0.7 } },
      { name:"재앙의 꽃",     minMastery:30, dmg:425, desc:"거대 꽃 소환 흡수.",       statusApply:{ target:"enemy",statusId:"stun",chance:0.6 } },
    ],
  },
  mahito:   { name:"마히토",           emoji:"🩸", grade:"준특급", atk:120, def:98,  spd:110, maxHp:1560, domain:"자폐원돈과",desc:"영혼을 변형하는 준특급 저주령.", lore:"\"영혼이 육체를 만드는 거야.\"",
    awakening:null,
    skills:[
      { name:"영혼 변형",   minMastery:0,  dmg:128, desc:"영혼 변형 직접 타격.",       statusApply:{ target:"enemy",statusId:"weaken",chance:0.4 } },
      { name:"무위전변",    minMastery:5,  dmg:212, desc:"접촉 신체 기괴하게 변형.",   statusApply:{ target:"enemy",statusId:"stun",chance:0.4 } },
      { name:"편사지경체",  minMastery:15, dmg:308, desc:"무한 신체 변형 공격.",       statusApply:{ target:"enemy",statusId:"weaken",chance:0.6 } },
      { name:"자폐원돈과",  minMastery:30, dmg:455, desc:"영혼과 육체의 경계 붕괴.",   statusApply:{ target:"enemy",statusId:"freeze",chance:0.8 } },
    ],
  },
  todo:     { name:"토도 아오이",      emoji:"💪", grade:"1급",   atk:128, def:108, spd:112, maxHp:1500, domain:null,      desc:"보조 공격술 구사 1급 주술사.",    lore:"\"너의 이상형은 어떤 여자야?\"",
    awakening:null,
    skills:[
      { name:"부기우기",   minMastery:0,  dmg:130, desc:"위치 전환 + 빙결 40%.",       statusApply:{ target:"enemy",statusId:"freeze",chance:0.40 } },
      { name:"브루탈 펀치",minMastery:5,  dmg:215, desc:"최대 저주력 파괴적 주먹.",   statusApply:{ target:"enemy",statusId:"weaken",chance:0.30 } },
      { name:"흑섬",       minMastery:15, dmg:320, desc:"이타도리에게 배운 흑섬!",     statusApply:{ target:"enemy",statusId:"burn",chance:0.45 } },
      { name:"전투본능",   minMastery:30, dmg:200, desc:"전투본능 버프! (ATK↑ 회피↑)",statusApply:{ target:"self",statusId:"battleInstinct",chance:1.0 } },
    ],
  },
  hakari:   { name:"하카리 키리토",    emoji:"🎰", grade:"1급",   atk:125, def:105, spd:110, maxHp:1650, domain:"질풍강운", desc:"복권 술식 사용 주술사.",          lore:"\"운도 실력이다! 철저하게 즐기자!\"",
    awakening:null,
    skills:[
      { name:"험한 도박",  minMastery:0,  dmg:125, desc:"운에 맡긴 도박 공격!",       statusApply:{ target:"enemy",statusId:"stun",chance:0.3 } },
      { name:"질풍열차",   minMastery:5,  dmg:210, desc:"열차처럼 돌진!",              statusApply:{ target:"enemy",statusId:"weaken",chance:0.4 } },
      { name:"유한 소설",  minMastery:15, dmg:315, desc:"불멸의 몸으로 싸운다!",      statusApply:{ target:"self",statusId:"battleInstinct",chance:0.6 } },
      { name:"질풍강운",   minMastery:30, dmg:480, desc:"영역전개 — 운이 터진다!",    statusApply:{ target:"enemy",statusId:"freeze",chance:0.7 } },
    ],
  },
};

// ════════════════════════════════════════════════════════
// ── 적 데이터
// ════════════════════════════════════════════════════════
const ENEMIES = [
  { id:"e1",name:"저급 저주령",      emoji:"👹",hp:550,  atk:38,  def:12,  xp:75,   crystals:18,  masteryXp:1,  fingers:0,statusAttack:null },
  { id:"e2",name:"1급 저주령",       emoji:"👺",hp:1100, atk:80,  def:40,  xp:190,  crystals:40,  masteryXp:3,  fingers:0,statusAttack:{ statusId:"poison",chance:0.3 } },
  { id:"e3",name:"특급 저주령",      emoji:"💀",hp:2400, atk:128, def:72,  xp:440,  crystals:90,  masteryXp:7,  fingers:1,statusAttack:{ statusId:"burn",chance:0.4 } },
  { id:"e4",name:"저주의 왕 (보스)", emoji:"👑",hp:5500, atk:195, def:110, xp:1000, crystals:200, masteryXp:15, fingers:3,statusAttack:{ statusId:"weaken",chance:0.5 } },
  { id:"e_sukuna",name:"료멘 스쿠나 〖저주의 왕〗",emoji:"🔴",hp:5500,atk:220,def:130,xp:1500,crystals:300,masteryXp:20,fingers:1,statusAttack:{ statusId:"burn",chance:0.6 }, isSukuna:true },
];

// ════════════════════════════════════════════════════════
// ── 레이드 보스 데이터
// ════════════════════════════════════════════════════════
const RAID_BOSSES = {
  heian_sukuna: {
    id: "heian_sukuna",
    name: "平安時代 스쿠나 〖헤이안 최강〗",
    emoji: "👹🔴",
    hp: 11000,
    atk: 440,
    def: 260,
    xp: 3000,
    crystals: 600,
    masteryXp: 40,
    fingers: 3,
    desc: "헤이안 시대의 스쿠나. 현대 스쿠나의 2배 강함.",
    lore: "\"나는 그 어느 시대에도 최강이었다.\"",
    color: 0x8b0000,
    statusAttack: { statusId:"burn", chance:0.7 },
    specialAttack: { name:"복마어주자", dmg:600, statusId:"freeze", chance:0.9 },
    dropKey: "raid_heian",
    phaseHp: 0.5,
    enragedAtk: 600,
  },
  mahoraga: {
    id: "mahoraga",
    name: "八握剣 異戒神将 마허라가라",
    emoji: "⚙️🐉",
    hp: 6000,
    atk: 280,
    def: 180,
    xp: 2500,
    crystals: 500,
    masteryXp: 35,
    fingers: 2,
    desc: "식신 중 최강. 모든 술식에 적응하는 능력.",
    lore: "\"마허라가라는 천지의 이치를 먹는다.\"",
    color: 0x2a2a2a,
    statusAttack: { statusId:"weaken", chance:0.6 },
    specialAttack: { name:"팔상천마", dmg:400, statusId:"stun", chance:0.8 },
    dropKey: "raid_mahoraga",
    adaptationSkill: true,
    adaptedSkills: [],
    phaseHp: 0.4,
    enragedAtk: 380,
  },
};

// ════════════════════════════════════════════════════════
// ── 사멸회유 적 데이터
// ════════════════════════════════════════════════════════
const JUJUTSU_ENEMIES = [
  { id:"j1",name:"약화된 저주령",   emoji:"💧",hp:300, atk:25,def:8,  xp:55, crystals:12,masteryXp:1,points:1,fingers:0,statusAttack:null,                              desc:"⚡ 빠르지만 약함 (1포인트)" },
  { id:"j2",name:"중간급 저주령",   emoji:"🌀",hp:620, atk:55,def:28, xp:115,crystals:28,masteryXp:2,points:1,fingers:0,statusAttack:{ statusId:"weaken",chance:0.2 },  desc:"⚖️ 균형잡힌 몹 (1포인트)" },
  { id:"j3",name:"강화 저주령",     emoji:"🔥",hp:450, atk:75,def:22, xp:95, crystals:23,masteryXp:2,points:1,fingers:0,statusAttack:{ statusId:"burn",chance:0.35 },   desc:"💥 공격적이지만 방어 낮음 (1포인트)" },
  { id:"j4",name:"특수 저주령",     emoji:"☠️",hp:960, atk:88,def:48, xp:190,crystals:45,masteryXp:4,points:2,fingers:0,statusAttack:{ statusId:"poison",chance:0.4 },  desc:"🧪 독 공격! (2포인트)" },
  { id:"j5",name:"엘리트 저주령",   emoji:"💀",hp:1380,atk:108,def:60,xp:280,crystals:70,masteryXp:6,points:3,fingers:1,statusAttack:{ statusId:"burn",chance:0.5 },   desc:"⚔️ 강력한 엘리트 (3포인트)" },
  { id:"j6",name:"사멸회유 수호자", emoji:"👹",hp:2100,atk:135,def:82,xp:440,crystals:100,masteryXp:10,points:5,fingers:2,statusAttack:{ statusId:"weaken",chance:0.6 },desc:"🏆 최강 수호자 (5포인트)" },
];

// ════════════════════════════════════════════════════════
// ── 가챠 풀
// ════════════════════════════════════════════════════════
const GACHA_POOL = [
  { id:"gojo",rate:0.3 },{ id:"yuta",rate:0.45 },{ id:"geto",rate:0.9 },{ id:"jogo",rate:0.6 },
  { id:"mahito",rate:0.6 },{ id:"hanami",rate:0.7 },{ id:"dagon",rate:0.7 },{ id:"itadori",rate:2.5 },
  { id:"megumi",rate:6.0 },{ id:"nanami",rate:6.0 },{ id:"maki",rate:6.5 },{ id:"nobara",rate:6.5 },
  { id:"higuruma",rate:6.5 },{ id:"todo",rate:5.0 },{ id:"panda",rate:32.0 },{ id:"inumaki",rate:23.75 },
  { id:"hakari",rate:5.0 },
];
function rollGacha(count=1) {
  const total=GACHA_POOL.reduce((s,p)=>s+p.rate,0);
  return Array.from({ length:count },()=>{
    let roll=Math.random()*total;
    for (const e of GACHA_POOL) { roll-=e.rate; if (roll<=0) return e.id; }
    return GACHA_POOL[GACHA_POOL.length-1].id;
  });
}

const REVERSE_CHARS = new Set(["gojo","yuta"]);
const CODES = { "release":{ crystals:200 },"sorryforbugs":{ crystals:1000 } };

// ════════════════════════════════════════════════════════
// ── 인메모리 세션
// ════════════════════════════════════════════════════════
let players = {};
const battles       = {};
const cullings      = {};
const jujutsus      = {};
const parties       = {};
const partyInvites  = {};
const pvpSessions   = {};
const pvpChallenges = {};
const raidSessions  = {};
let _pvpIdSeq=1, _raidIdSeq=1;

// ════════════════════════════════════════════════════════
// ── 주력 스킬
// ════════════════════════════════════════════════════════
function getMainSkill(player, charId) {
  if (charId==="gojo"&&player.mainSkillUnlocked?.gojo)
    return { name:"자폭 무라사키",dmg:640,desc:"모든 힘을 쏟아붓는 자폭 공격! 사용 후 HP 1" };
  if (charId==="sukuna"&&player.mainSkillUnlocked?.sukuna)
    return { name:"세계참",dmg:700,desc:"세계조차 베어버리는 궁극의 기술!" };
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
      mainSkillUnlocked:{ gojo:false,sukuna:false },
      materials:{}, equippedWeapon:null, craftedWeapons:[],
      quests:{}, raidClears:{},
    };
    savePlayer(userId);
  }
  const p=players[userId];
  let changed=false;
  if (p.name!==username&&username!=="플레이어") { p.name=username; changed=true; }
  const defaults={
    reverseOutput:1.0,reverseCooldown:0,mastery:{},cullingBest:0,jujutsuBest:0,
    usedCodes:[],lastDaily:0,pvpWins:0,pvpLosses:0,statusEffects:[],skillCooldown:0,
    dailyStreak:0,sukunaFingers:0,kogane:null,koganeGachaCount:0,
    mainSkillUnlocked:{ gojo:false,sukuna:false },
    materials:{},equippedWeapon:null,craftedWeapons:[],quests:{},raidClears:{},
    potion:3,
  };
  for (const [k,v] of Object.entries(defaults)) {
    if (p[k]===undefined) { p[k]=typeof v==="object"&&v!==null?JSON.parse(JSON.stringify(v)):v; changed=true; }
  }
  if (!p.id) { p.id=userId; changed=true; }
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
function getCurrentSkill(player,charId) {
  const skills=getAvailableSkills(player,charId);
  return skills[skills.length-1]||CHARACTERS[charId].skills[0];
}
function getNextSkill(player,charId) {
  const m=getMastery(player,charId);
  return CHARACTERS[charId].skills.find(s=>s.minMastery>m)||null;
}
function getPlayerStats(player) {
  const ch=CHARACTERS[player.active];
  if (!ch) return { atk:90,def:75,maxHp:1000 };
  const kb=getKoganeBonus(player);
  const ws=getWeaponStats(player);
  if (player.active!=="itadori"&&player.active!=="sukuna") return {
    atk:Math.floor(ch.atk*kb.atk)+ws.atk,
    def:Math.floor(ch.def*kb.def)+ws.def,
    maxHp:Math.floor(ch.maxHp*kb.hp)+ws.hp,
  };
  const bonus=getFingerBonus(player.sukunaFingers||0);
  return {
    atk:Math.floor((ch.atk+bonus.atkBonus)*kb.atk)+ws.atk,
    def:Math.floor((ch.def+bonus.defBonus)*kb.def)+ws.def,
    maxHp:Math.floor((ch.maxHp+bonus.hpBonus)*kb.hp)+ws.hp,
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
  if (player.active==="itadori"||player.active==="sukuna") {
    const bonus=getFingerBonus(player.sukunaFingers||0);
    mult*=bonus.dmgMult;
  }
  return calcDmg(stats.atk,enemyDef,mult);
}
function calcSkillDmgForPlayer(player,baseSkillDmg) {
  let dmg=baseSkillDmg+Math.floor(Math.random()*60);
  dmg=Math.floor(dmg*getWeakenMult(player.statusEffects));
  if (isMakiAwakened(player)) dmg=Math.floor(dmg*CHARACTERS["maki"].awakening.dmgMult);
  if (player.active==="itadori"||player.active==="sukuna") {
    const bonus=getFingerBonus(player.sukunaFingers||0);
    dmg=Math.floor(dmg*bonus.dmgMult);
  }
  const kb=getKoganeBonus(player);
  dmg=Math.floor(dmg*kb.atk);
  const ws=getWeaponStats(player);
  dmg+=Math.floor(ws.atk*0.5);
  return dmg;
}
function applySkillStatus(skill,defenderObj,attackerObj=null) {
  if (!skill.statusApply) return [];
  const { target,statusId,chance }=skill.statusApply;
  if (Math.random()>chance) return [];
  const def=STATUS_EFFECTS[statusId];
  if (target==="enemy") {
    applyStatus(defenderObj,statusId);
    return [`> ${def.emoji} **${def.name}** 상태이상 적용! (${def.duration}턴)`];
  }
  if (target==="self"&&attackerObj) {
    applyStatus(attackerObj,statusId);
    return [`> ${def.emoji} **${def.name}** 발동! (${def.duration}턴)`];
  }
  return [];
}
function tickCooldowns(player) {
  if (player.reverseCooldown>0) player.reverseCooldown--;
  if (player.skillCooldown>0) player.skillCooldown--;
}

// ════════════════════════════════════════════════════════
// ── 파티/PvP 유틸
// ════════════════════════════════════════════════════════
function getPartyId(userId) { return Object.keys(parties).find(pid=>parties[pid]?.members?.includes(userId))||null; }
function getParty(userId) { const pid=getPartyId(userId); return pid?parties[pid]:null; }
function getPvpSessionByUser(userId) { return Object.values(pvpSessions).find(s=>s.p1Id===userId||s.p2Id===userId)||null; }
function getRaidByUser(userId) { return Object.values(raidSessions).find(r=>r.members.includes(userId))||null; }

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
  const pool=getCullingPool(wave);
  const id=pool[Math.floor(Math.random()*pool.length)];
  const base=ENEMIES.find(e=>e.id===id);
  const scale=1+(wave-1)*0.05;
  return { ...base,hp:Math.floor(base.hp*scale),atk:Math.floor(base.atk*scale),def:Math.floor(base.def*scale),xp:Math.floor(base.xp*scale),crystals:Math.floor(base.crystals*scale),currentHp:Math.floor(base.hp*scale),statusEffects:[] };
}
function generateJujutsuChoices(wave) {
  const pool=wave<=3?["j1","j1","j2","j3"]:wave<=7?["j2","j3","j3","j4"]:wave<=12?["j3","j4","j4","j5"]:["j4","j5","j5","j6"];
  const ids=[];
  for (const id of [...pool].sort(()=>Math.random()-0.5)) { if (!ids.includes(id)) ids.push(id); if (ids.length===3) break; }
  while (ids.length<3) { const fb=pool[Math.floor(Math.random()*pool.length)]; if (!ids.includes(fb)) ids.push(fb); }
  return ids.slice(0,3).map(id=>{
    const base=JUJUTSU_ENEMIES.find(e=>e.id===id);
    const scale=1+(wave-1)*0.04;
    return { ...base,hp:Math.floor(base.hp*scale),atk:Math.floor(base.atk*scale),def:Math.floor(base.def*scale),xp:Math.floor(base.xp*scale),crystals:Math.floor(base.crystals*scale),statusEffects:[] };
  });
}

// ════════════════════════════════════════════════════════
// ── 전투 승리 공통 처리 (회복약 드롭 포함)
// ════════════════════════════════════════════════════════
async function processBattleWin(player, enemy) {
  const kb = getKoganeBonus(player);
  const xpGain = Math.floor((enemy.xp||50) * kb.xp);
  const crystalGain = Math.floor((enemy.crystals||10) * kb.crystal);
  player.xp += xpGain;
  player.crystals += crystalGain;
  const masteryGain = enemy.masteryXp || 1;
  player.mastery[player.active] = (player.mastery[player.active]||0) + masteryGain;
  player.wins++;

  // 회복약 드롭
  const potionChances = { e1:0.22, e2:0.32, e3:0.48, e4:0.65, e_sukuna:1.00 };
  const potionChance = potionChances[enemy.id] || 0.20;
  let potionMsg = "";
  if (Math.random() < potionChance) {
    const gain = enemy.isSukuna ? 3 : (enemy.id==="e4" ? 2 : 1);
    player.potion = (player.potion||0) + gain;
    potionMsg = `\n> 🧪 **회복약 +${gain}개** 드롭! (보유: **${player.potion}개**)`;
  }

  // 스쿠나 손가락
  let fingerMsg = "";
  if (enemy.isSukuna) {
    const gained = enemy.fingers || 1;
    const before = player.sukunaFingers || 0;
    player.sukunaFingers = Math.min(SUKUNA_FINGER_MAX, before + gained);
    if (!player.owned.includes("sukuna")) {
      player.owned.push("sukuna");
      if (!player.mastery["sukuna"]) player.mastery["sukuna"] = 0;
      fingerMsg = `\n\n🔴 **스쿠나 해금!** \`/활성\` 으로 선택하세요!\n> 손가락 ${player.sukunaFingers}개 보유!`;
    } else {
      fingerMsg = `\n\n👹 **스쿠나 손가락 +${gained}개!** (${player.sukunaFingers}/${SUKUNA_FINGER_MAX})\n> ${getFingerBonus(player.sukunaFingers).label}`;
    }
  } else if (enemy.fingers) {
    const before = player.sukunaFingers || 0;
    player.sukunaFingers = Math.min(SUKUNA_FINGER_MAX, before + enemy.fingers);
    if (player.sukunaFingers >= 1 && !player.owned.includes("sukuna")) {
      player.owned.push("sukuna");
      if (!player.mastery["sukuna"]) player.mastery["sukuna"] = 0;
      fingerMsg = `\n\n🔴 **스쿠나 해금!** \`/활성\` 으로 선택 가능!`;
    }
  }

  // 재료 드롭
  const dropKey = enemy.isSukuna ? "e_sukuna" : (enemy.id || "e1");
  const drops = rollDrops(dropKey);
  addMaterials(player, drops);

  // 주력 스킬 언락
  let unlockMsg = "";
  if (player.active==="gojo" && !player.mainSkillUnlocked?.gojo && player.wins>=20) {
    if (!player.mainSkillUnlocked) player.mainSkillUnlocked = {};
    player.mainSkillUnlocked.gojo = true;
    unlockMsg = "\n🎉 **주력 스킬 '자폭 무라사키' 해금!**";
  }
  if (player.active==="sukuna" && !player.mainSkillUnlocked?.sukuna && (player.sukunaFingers||0)>=10) {
    if (!player.mainSkillUnlocked) player.mainSkillUnlocked = {};
    player.mainSkillUnlocked.sukuna = true;
    unlockMsg = "\n🎉 **주력 스킬 '세계참' 해금!**";
  }

  updateQuestProgress(player, "battle_win", 1);
  if (["e3","e4","e_sukuna"].includes(enemy.id) || enemy.isSukuna)
    updateQuestProgress(player, "boss_kill", 1);

  const dropText = Object.keys(drops).length ? `\n\n📦 **재료 드롭:**\n${formatDrops(drops)}` : "";
  const questDone = getNewlyCompletedQuestMsg(player);

  return new EmbedBuilder()
    .setTitle(enemy.isSukuna ? "👹 스쿠나 격파!!" : "🏆 전투 승리!")
    .setColor(enemy.isSukuna ? 0x8b0000 : 0xF5C842)
    .setDescription([
      enemy.isSukuna
        ? "```ansi\n\u001b[1;31m╔══════════════════════════════════╗\n║  👹  저주의 왕을 쓰러뜨렸다!  👹 ║\n╚══════════════════════════════════╝\n```"
        : "```ansi\n\u001b[1;33m╔══════════════════════════╗\n║   ✨  V I C T O R Y  ✨   ║\n╚══════════════════════════╝\n```",
      `> **${enemy.name}** 처치!`,
      `> ⭐ XP **+${xpGain}** | 💎 **+${crystalGain}** | 📈 숙련 **+${masteryGain}**`,
      dropText, potionMsg, fingerMsg, unlockMsg, questDone,
    ].filter(Boolean).join("\n"))
    .addFields({
      name:"📊 현재 상태",
      value:`> 💚 **${Math.max(0,player.hp)}** HP | 🧪 회복약 **${player.potion}개** | 💎 **${player.crystals}**\n> ⚔️ **${player.wins}승 ${player.losses}패**`,
    })
    .setFooter({ text:`LV.${getLevel(player.xp)}` });
}

function getNewlyCompletedQuestMsg(player) {
  initQuests(player);
  const msgs=[];
  for (const qp of player.quests.daily||[]) {
    if (qp.done&&!qp.claimed) { const def=DAILY_QUESTS.find(q=>q.id===qp.id); if (def) msgs.push(`> 📋 **일일퀘 완료!** ${def.name}`); }
  }
  for (const qp of player.quests.weekly||[]) {
    if (qp.done&&!qp.claimed) { const def=WEEKLY_QUESTS.find(q=>q.id===qp.id); if (def) msgs.push(`> 📅 **주간퀘 완료!** ${def.name}`); }
  }
  return msgs.join("\n");
}

// ════════════════════════════════════════════════════════
// ── 고퀄 프로필 카드
// ════════════════════════════════════════════════════════
function profileEmbed(player) {
  const ch = CHARACTERS[player.active];
  if (!ch) return new EmbedBuilder().setTitle("오류").setDescription("캐릭터 없음");
  const stats = getPlayerStats(player);
  const mastery = getMastery(player, player.active);
  const awakened = isMakiAwakened(player);
  const lv = getLevel(player.xp);
  const xpNow = player.xp % 200;
  const hpPct = Math.max(0, player.hp) / stats.maxHp;
  const fingers = player.sukunaFingers || 0;
  const fb = getFingerBonus(fingers);
  const kb = getKoganeBonus(player);
  const kogane = player.kogane;
  const kg = kogane ? KOGANE_GRADES[kogane.grade] : null;
  const ri = GACHA_RARITY[ch.grade] || GACHA_RARITY["3급"];
  const weapon = player.equippedWeapon ? WEAPONS[player.equippedWeapon] : null;
  const ws = getWeaponStats(player);
  const curSkill = getCurrentSkill(player, player.active);
  const nxtSkill = getNextSkill(player, player.active);
  const mainSkill = getMainSkill(player, player.active);

  const makeBar = (fill, total, len=16) => {
    const n = Math.max(0, Math.round((fill/total)*len));
    return "█".repeat(n) + "░".repeat(Math.max(0, len-n));
  };
  const hpIcon = hpPct>0.6?"🟢":hpPct>0.3?"🟡":"🔴";
  const hpBarStr = `${hpIcon} \`${makeBar(player.hp, stats.maxHp)}\` **${Math.max(0,player.hp)}**/**${stats.maxHp}**`;
  const xpBarStr = `⭐ \`${makeBar(xpNow, 200)}\` ${xpNow}/200`;

  initQuests(player);
  const dailyDone = (player.quests.daily||[]).filter(q=>q.done&&!q.claimed).length;
  const weeklyDone = (player.quests.weekly||[]).filter(q=>q.done&&!q.claimed).length;
  const matSummary = Object.entries(player.materials||{}).filter(([,q])=>q>0).slice(0,8)
    .map(([id,q])=>`${MATERIALS[id]?.emoji||""}**×${q}**`).join(" ") || "없음";

  const raidClears = player.raidClears || {};
  const raidStr = Object.entries(RAID_BOSSES)
    .map(([id,b]) => `${(raidClears[id]||0)>0?"✅":"🔒"}${b.emoji}${b.name.split("〖")[0].trim()}(${raidClears[id]||0}클)`)
    .join("  ");

  const charList = player.owned.map(id => {
    const c = CHARACTERS[id];
    const m = getMastery(player, id);
    const cr = GACHA_RARITY[c.grade]||GACHA_RARITY["3급"];
    const fn = id==="sukuna" ? ` 🖕${fingers}개` : "";
    return `> ${id===player.active?"▶ **[활성]** ":"　　"}${c.emoji} **${c.name}** \`[${c.grade}]\` ${cr.stars}  숙련\`${m}\`${fn}`;
  }).join("\n");

  return new EmbedBuilder()
    .setColor(awakened ? 0xFF2200 : ri.color)
    .setTitle(
      awakened
        ? `🔥━━ 천여주박 각성 ━━🔥  ${player.name}`
        : `${ri.effect}  ${player.name} 의 주술사 카드  ${ri.effect}`
    )
    .addFields({
      name:"╔══[ 🪪 주술사 신분증 ]══════════════════╗",
      value:[
        `> ${ch.emoji} **${ch.name}**  \`[${ch.grade}]\`  ${ri.stars}`,
        `> *"${(ch.lore||ch.desc).slice(0,48)}${(ch.lore||ch.desc).length>48?"...":""}"*`,
        `> 🎖️ **Lv.${lv}**  ${xpBarStr}`,
        `> 💎 **${player.crystals}** 크리스탈  ·  🧪 회복약 **${player.potion||0}개**`,
        `> 🌌 영역전개: \`${ch.domain||"없음"}\``,
      ].join("\n"), inline:false,
    })
    .addFields({
      name:"╔══[ ⚔️ 전투 스탯 ]══════════════════════╗",
      value:[
        `> ${hpBarStr}${awakened?" 🔥**[천여주박 각성!]**":""}`,
        `> 🗡️ ATK **${stats.atk}**  ·  🛡️ DEF **${stats.def}**`,
        weapon
          ? `> ${weapon.emoji} 장착: **${weapon.name}** \`+${ws.atk}ATK +${ws.def}DEF +${ws.hp}HP\``
          : `> ⚔️ 주구 없음  (\`/주구목록\` 확인)`,
        `> 🩸 상태이상: \`${statusStr(player.statusEffects)}\``,
        kg
          ? `> 🐾 코가네 [${kogane.grade}] ${kg.emoji} \`ATK+${Math.round(kg.atkBonus*100)}% XP+${Math.round(kg.xpBonus*100)}%\``
          : `> 🐾 코가네 없음 (\`/코가네가챠\` 200💎)`,
      ].join("\n"), inline:false,
    })
    .addFields({
      name:"╔══[ 🌀 술식 트리 ]══════════════════════╗",
      value:[
        `> 📈 숙련도 ${masteryBar(mastery, player.active)}`,
        `> ✅ 현재: **${curSkill.name}** (피해 \`${curSkill.dmg}\`)`,
        nxtSkill
          ? `> 🔒 다음: **${nxtSkill.name}** (숙련 \`${nxtSkill.minMastery}\` 필요)`
          : `> ✨ **모든 스킬 해금!**`,
        mainSkill
          ? `> ⭐ 주력: **${mainSkill.name}** \`[해금됨]\``
          : player.active==="gojo" ? `> ⭐ 주력: 자폭 무라사키 \`[${player.wins}/20승]\``
          : player.active==="sukuna" ? `> ⭐ 주력: 세계참 \`[손가락 ${fingers}/10]\``
          : "",
        (player.active==="itadori"||player.active==="sukuna")
          ? `> 👹 스쿠나 손가락: **${fingers}/${SUKUNA_FINGER_MAX}** — ${fb.label}` : "",
      ].filter(Boolean).join("\n"), inline:false,
    })
    .addFields(
      {
        name:"╔══[ 📊 전적 ]══════╗",
        value:[
          `> ⚔️ 일반: **${player.wins}승** ${player.losses}패`,
          `> 🥊 PvP: **${player.pvpWins}승** ${player.pvpLosses}패`,
          `> 🌊 컬링: **WAVE ${player.cullingBest||0}**`,
          `> 🎯 사멸회유: **${player.jujutsuBest||0}pt**`,
        ].join("\n"), inline:true,
      },
      {
        name:"╔══[ 🏆 레이드 ]════╗",
        value: raidStr || "> 미도전", inline:true,
      },
      { name:"\u200b", value:"\u200b", inline:true }
    )
    .addFields(
      {
        name:"╔══[ 📦 재료 ]══════╗",
        value:`> ${matSummary}\n> \`/재료\` 상세`, inline:true,
      },
      {
        name:"╔══[ 📋 퀘스트 ]════╗",
        value:[
          `> 일일 대기: **${dailyDone}개**`,
          `> 주간 대기: **${weeklyDone}개**`,
          `> \`/퀘스트\` 확인`,
        ].join("\n"), inline:true,
      },
      { name:"\u200b", value:"\u200b", inline:true }
    )
    .addFields({
      name:"╔══[ 🎴 보유 캐릭터 ]════════════════════╗",
      value: charList||"> 없음", inline:false,
    })
    .setFooter({ text:`/전투 /컬링 /사멸회유 /결투 /레이드 /가챠 /퀘스트 | Lv.${lv} · ${ch.name}` })
    .setTimestamp();
}

// ════════════════════════════════════════════════════════
// ── 기타 임베드 함수들
// ════════════════════════════════════════════════════════
function questEmbed(player) {
  initQuests(player);
  const embed=new EmbedBuilder().setTitle("📋 퀘스트 현황").setColor(0x7C5CFC).setTimestamp();
  const dailyLines=(player.quests.daily||[]).map((qp,i)=>{
    const def=DAILY_QUESTS.find(q=>q.id===qp.id); if (!def) return "";
    const bar=`\`${"█".repeat(Math.floor(qp.progress/def.target*8))}${"░".repeat(8-Math.floor(qp.progress/def.target*8))}\``;
    const status=qp.claimed?"✅ 수령 완료":qp.done?`🎁 수령 가능 (\`/퀘보상 일일 ${i+1}\`)`:`${bar} ${qp.progress}/${def.target}`;
    const rew=`+${def.reward.crystals}💎 +${def.reward.xp}XP${def.reward.materials?` ${Object.entries(def.reward.materials).map(([m,q])=>`${MATERIALS[m]?.emoji||""}×${q}`).join(" ")}` : ""}`;
    return `> **[${i+1}] ${def.name}** — ${def.desc}\n> ${status}  |  보상: ${rew}`;
  }).filter(Boolean).join("\n\n");
  const weeklyLines=(player.quests.weekly||[]).map((qp,i)=>{
    const def=WEEKLY_QUESTS.find(q=>q.id===qp.id); if (!def) return "";
    const bar=`\`${"█".repeat(Math.floor(qp.progress/def.target*8))}${"░".repeat(8-Math.floor(qp.progress/def.target*8))}\``;
    const status=qp.claimed?"✅ 수령 완료":qp.done?`🎁 수령 가능 (\`/퀘보상 주간 ${i+1}\`)`:`${bar} ${qp.progress}/${def.target}`;
    const rew=`+${def.reward.crystals}💎 +${def.reward.xp}XP${def.reward.materials?` ${Object.entries(def.reward.materials).map(([m,q])=>`${MATERIALS[m]?.emoji||""}×${q}`).join(" ")}` : ""}`;
    return `> **[${i+1}] ${def.name}** — ${def.desc}\n> ${status}  |  보상: ${rew}`;
  }).filter(Boolean).join("\n\n");
  embed.addFields(
    { name:"📋 ── 일일 퀘스트 ──────────────────────", value:dailyLines||"> 없음", inline:false },
    { name:"📅 ── 주간 퀘스트 ──────────────────────", value:weeklyLines||"> 없음", inline:false },
  );
  embed.setFooter({ text:"/퀘보상 일일 [번호] | /퀘보상 주간 [번호]" });
  return embed;
}
function materialsEmbed(player) {
  const mats=player.materials||{};
  const lines=Object.entries(MATERIALS).map(([id,m])=>`> ${m.emoji} **${m.name}** ×${mats[id]||0}  — ${m.desc}`);
  return new EmbedBuilder().setTitle("📦 재료 인벤토리").setColor(0x7c5cfc).setDescription(lines.join("\n")).setFooter({ text:"/주구목록 — 주구 목록 및 제작 | /주구제작 [이름]" });
}
function weaponListEmbed(player) {
  const mats=player.materials||{};
  const lines=Object.entries(WEAPONS).map(([id,w])=>{
    const canCraft=Object.entries(w.recipe).every(([m,qty])=>(mats[m]||0)>=qty);
    const owned=(player.craftedWeapons||[]).includes(id);
    const equipped=player.equippedWeapon===id;
    const recipeStr=Object.entries(w.recipe).map(([m,qty])=>`${MATERIALS[m]?.emoji||""}${mats[m]||0}/${qty}`).join(" ");
    return `> ${equipped?"⚔️[장착]":owned?"✅[보유]":"🔒[미제작]"} **${w.emoji} ${w.name}** \`[${w.grade}]\`\n> ATK+${w.atkBonus} DEF+${w.defBonus} HP+${w.hpBonus}\n> 재료: ${recipeStr}  ${canCraft&&!owned?"**✨ 제작 가능!**":""}`;
  });
  return new EmbedBuilder().setTitle("⚔️ 주구 (무기) 목록").setColor(0xF5C842).setDescription(lines.join("\n\n")).setFooter({ text:"/주구제작 [무기ID] | /장착 [무기ID] | /해제" });
}

// ════════════════════════════════════════════════════════
// ── 고퀄 전투 UI 임베드
// ════════════════════════════════════════════════════════
function battleEmbed(player, enemy, log=[], title="⚔️ 전투!", color=0xff4444) {
  const stats = getPlayerStats(player);
  const ch = CHARACTERS[player.active];
  const awakened = isMakiAwakened(player);
  const hpPctP = Math.max(0, player.hp) / stats.maxHp;
  const hpPctE = Math.max(0, enemy.currentHp||enemy.hp) / enemy.hp;

  const makeHpBar = (pct, len=12) => {
    const fill = Math.round(pct*len);
    const icon = pct>0.6?"🟩":pct>0.3?"🟨":"🟥";
    return icon.repeat(Math.max(0,fill)) + "⬛".repeat(Math.max(0,len-fill));
  };

  const playerHpLine = `${makeHpBar(hpPctP)} \`${Math.max(0,player.hp)}/${stats.maxHp}\``;
  const enemyHpLine = `${makeHpBar(hpPctE)} \`${Math.max(0,enemy.currentHp||0)}/${enemy.hp}\``;

  const statusLine = player.statusEffects?.length
    ? `🩸 ${statusStr(player.statusEffects)}`
    : "🩺 상태 이상 없음";

  const cdLine = [
    player.skillCooldown>0 ? `⚡술식 \`${player.skillCooldown}턴\`` : "⚡술식 \`✅\`",
    player.reverseCooldown>0 ? `♻️반전 \`${player.reverseCooldown}턴\`` : "♻️반전 \`✅\`",
  ].join("  ·  ");

  const embed = new EmbedBuilder()
    .setTitle(`${awakened?"🔥 ":""}${title}`)
    .setColor(awakened ? 0xFF2200 : color)
    .setDescription(
      log.length
        ? "```\n" + log.map(l=>l.replace(/\*\*/g,"").replace(/>/g,"")).join("\n") + "\n```"
        : "⚔️ 전투 진행 중..."
    )
    .addFields(
      {
        name:`${ch.emoji} ${player.name} ${awakened?"🔥[각성]":""}`,
        value:[
          playerHpLine,
          statusLine,
          cdLine,
        ].join("\n"),
        inline:true,
      },
      {
        name:`${enemy.emoji} ${enemy.name}`,
        value:[
          enemyHpLine,
          enemy.statusEffects?.length ? `🩸 ${statusStr(enemy.statusEffects)}` : "🩺 상태 없음",
          `🗡️ ATK **${enemy.atk}** · 🛡️ DEF **${enemy.def}**`,
        ].join("\n"),
        inline:true,
      },
      {
        name:"📊 현황",
        value:`> ⚔️ 현재 스킬: **${getCurrentSkill(player,player.active).name}** · 💎 **${player.crystals}** · 🧪 **${player.potion||0}개**`,
        inline:false,
      }
    )
    .setFooter({ text:`LV.${getLevel(player.xp)} · 흑섬 10% 확률 발동!` });

  return embed;
}

function cullingEmbed(player,session,log=[]) {
  const ch=CHARACTERS[player.active];
  const stats=getPlayerStats(player);
  const enemy=session.currentEnemy;
  const awakened=isMakiAwakened(player);
  const hpPctP = Math.max(0,player.hp)/stats.maxHp;
  const hpPctE = Math.max(0,session.enemyHp)/enemy.hp;
  const makeBar = (pct,len=10) => {
    const fill=Math.round(pct*len);
    const icon=pct>0.5?"🟩":pct>0.25?"🟨":"🟥";
    return icon.repeat(Math.max(0,fill))+"⬛".repeat(Math.max(0,len-fill));
  };
  return new EmbedBuilder()
    .setTitle(`${awakened?"🔥 ":""}⚔️ 컬링 게임 — 🌊 WAVE ${session.wave}`)
    .setColor(awakened?0xFF2200:session.wave>=15?0xF5C842:session.wave>=8?0xe63946:0x7C5CFC)
    .setDescription(log.length?log.join("\n"):"⚔️ 새 파도가 밀려온다!")
    .addFields(
      {
        name:`${ch.emoji} 내 HP${awakened?" 🔥[각성]":""}`,
        value:[
          `${makeBar(hpPctP)} \`${Math.max(0,player.hp)}/${stats.maxHp}\``,
          `🩸 상태: ${statusStr(player.statusEffects)}`,
          `⚡술식: \`${player.skillCooldown>0?player.skillCooldown+"턴":"✅"}\` · ♻️반전: \`${player.reverseCooldown>0?player.reverseCooldown+"턴":"✅"}\``,
        ].join("\n"), inline:true,
      },
      {
        name:`${enemy.emoji} ${enemy.name}`,
        value:[
          `${makeBar(hpPctE)} \`${Math.max(0,session.enemyHp)}/${enemy.hp}\``,
          `🩸 상태: ${statusStr(enemy.statusEffects||[])}`,
          `🗡️ ATK **${enemy.atk}** · 🛡️ DEF **${enemy.def}**`,
        ].join("\n"), inline:true,
      },
      {
        name:"📊 현황",
        value:`🌊 WAVE **${session.wave}** | 처치 **${session.kills}** | **${session.totalXp}** XP / **${session.totalCrystals}**💎 | 최고: **WAVE ${player.cullingBest}**`,
        inline:false,
      },
    )
    .setFooter({ text:`현재 스킬: ${getCurrentSkill(player,player.active).name}` });
}

function jujutsuEmbed(player,session,log=[],choices=null) {
  const ch=CHARACTERS[player.active];
  const stats=getPlayerStats(player);
  const awakened=isMakiAwakened(player);
  const hpPctP = Math.max(0,player.hp)/stats.maxHp;
  const makeBar = (pct,len=10) => {
    const fill=Math.round(pct*len);
    const icon=pct>0.5?"🟩":pct>0.25?"🟨":"🟥";
    return icon.repeat(Math.max(0,fill))+"⬛".repeat(Math.max(0,len-fill));
  };
  const embed=new EmbedBuilder()
    .setTitle(`🎯 사멸회유 — WAVE ${session.wave} | 포인트 **${session.points}**/15`)
    .setColor(session.points>=10?0xF5C842:session.points>=5?0xff8c00:0x7C5CFC)
    .setDescription(log.length?log.join("\n"):"🎯 사멸회유 진행 중!")
    .addFields({
      name:`${ch.emoji} 내 HP${awakened?" 🔥[각성]":""}`,
      value:[
        `${makeBar(hpPctP)} \`${Math.max(0,player.hp)}/${stats.maxHp}\``,
        `🩸 상태: ${statusStr(player.statusEffects)}`,
        `⚡술식: \`${player.skillCooldown>0?player.skillCooldown+"턴":"✅"}\``,
      ].join("\n"), inline:false,
    });
  embed.addFields({
    name:"🎯 포인트",
    value:`${"🟦".repeat(Math.min(session.points,15))}${"⬜".repeat(Math.max(0,15-session.points))} **${session.points}/15**\n**${session.totalXp}** XP / **${session.totalCrystals}**💎`,
    inline:false,
  });
  if (session.currentEnemy) {
    const enemy=session.currentEnemy;
    const hpPctE=Math.max(0,session.enemyHp)/enemy.hp;
    embed.addFields({
      name:`${enemy.emoji} 현재 적: ${enemy.name}`,
      value:[
        `${makeBar(hpPctE)} \`${Math.max(0,session.enemyHp)}/${enemy.hp}\``,
        `🩸 상태: ${statusStr(enemy.statusEffects||[])}`,
        `+${enemy.points}점`,
      ].join("\n"), inline:false,
    });
  }
  if (choices) embed.addFields({
    name:"⚔️ 다음 적 선택",
    value:choices.map((c,i)=>`**[${i+1}]** ${c.emoji} ${c.name} — HP:\`${c.hp}\` ATK:\`${c.atk}\` | +${c.points}점\n└ ${c.desc}`).join("\n"),
    inline:false,
  });
  embed.setFooter({ text:`최고: ${player.jujutsuBest}pt | 15pt 달성 시 +300💎 +500XP 보너스!` });
  return embed;
}

function pvpEmbed(session, extraLog=[]) {
  const p1 = players[session.p1Id];
  const p2 = players[session.p2Id];
  if (!p1||!p2) return new EmbedBuilder().setTitle("PvP 오류").setColor(0xe63946).setDescription("플레이어 정보 없음");
  const ch1 = CHARACTERS[p1.active];
  const ch2 = CHARACTERS[p2.active];
  const s1 = { maxHp: session.maxHp1 };
  const s2 = { maxHp: session.maxHp2 };
  const makeBar = (hp, maxHp, len=10) => {
    const pct = Math.max(0,hp)/maxHp;
    const fill = Math.round(pct*len);
    const icon = pct>0.5?"🟩":pct>0.25?"🟨":"🟥";
    return icon.repeat(Math.max(0,fill))+"⬛".repeat(Math.max(0,len-fill));
  };
  const allLog = [...(session.log||[]), ...extraLog].slice(-6);
  const turnName = session.turn===session.p1Id ? p1.name : p2.name;
  return new EmbedBuilder()
    .setColor(0xF5C842)
    .setTitle(`⚔️ PvP 결투  Round ${session.round}`)
    .setDescription(allLog.join("\n")||"⚔️ 결투 시작!")
    .addFields(
      {
        name:`${ch1.emoji} ${p1.name}${session.turn===session.p1Id?" ◀ **[내 턴]**":""}`,
        value:[
          `${makeBar(session.hp1,session.maxHp1)} \`${Math.max(0,session.hp1)}/${session.maxHp1}\``,
          `🩸 ${statusStr(session.status1)}`,
          `⚡술식: ${session.skillCd1>0?`\`${session.skillCd1}턴\``:"✅"}  ♻반전: ${session.reverseCd1>0?`\`${session.reverseCd1}턴\``:"✅"}`,
          `🌌 영역전개: ${session.domainUsed1?"**✖사용완료**":"**✅사용가능**"}`,
        ].join("\n"), inline:true,
      },
      {
        name:`${ch2.emoji} ${p2.name}${session.turn===session.p2Id?" ◀ **[내 턴]**":""}`,
        value:[
          `${makeBar(session.hp2,session.maxHp2)} \`${Math.max(0,session.hp2)}/${session.maxHp2}\``,
          `🩸 ${statusStr(session.status2)}`,
          `⚡술식: ${session.skillCd2>0?`\`${session.skillCd2}턴\``:"✅"}  ♻반전: ${session.reverseCd2>0?`\`${session.reverseCd2}턴\``:"✅"}`,
          `🌌 영역전개: ${session.domainUsed2?"**✖사용완료**":"**✅사용가능**"}`,
        ].join("\n"), inline:true,
      },
      {
        name:"🎯 턴",
        value:`> **${turnName}** 의 차례! (Round ${session.round})`,
        inline:false,
      }
    )
    .setFooter({ text:"술식 5턴쿨 | 반전 3턴쿨 | 영역전개 1회 한정 | 회피 5%" });
}

function raidEmbed(raidSession,log=[]) {
  const boss=RAID_BOSSES[raidSession.bossId];
  const makeBar=(hp,maxHp,len=16)=>{
    const pct=Math.max(0,hp)/maxHp, fill=Math.round(pct*len);
    const icon=pct>0.5?"🟩":pct>0.25?"🟨":"🟥";
    return icon.repeat(Math.max(0,fill))+"⬛".repeat(Math.max(0,len-fill));
  };
  const enraged=raidSession.enraged;
  const memberLines=raidSession.members.map(uid=>{
    const p=players[uid]; if (!p) return `> ❓`;
    const ch=CHARACTERS[p.active],stats=getPlayerStats(p);
    const aw=isMakiAwakened(p);
    const pct=Math.max(0,p.hp)/stats.maxHp;
    const icon=pct>0.6?"🟢":pct>0.3?"🟡":"🔴";
    return `> ${ch.emoji} **${p.name}** ${icon} \`${Math.max(0,p.hp)}/${stats.maxHp}\`${aw?" 🔥[각성]":""}`;
  }).join("\n");
  const adaptedStr=raidSession.adaptedSkills?.length
    ?`\n> 🔄 적응된 술식: ${raidSession.adaptedSkills.join(", ")}`
    :"";
  return new EmbedBuilder()
    .setTitle(`${boss.emoji} 레이드: ${boss.name}`)
    .setColor(enraged?0xff0000:boss.color)
    .setDescription([
      enraged?"```ansi\n\u001b[1;31m⚠️  ENRAGED — 분노 페이즈!  ATK 급증!  ⚠️\n```":"",
      log.length?log.join("\n"):"⚔️ 레이드 진행 중!",
    ].filter(Boolean).join("\n"))
    .addFields(
      {
        name:`${boss.emoji} ${boss.name}`,
        value:`${makeBar(raidSession.hp,boss.hp)} \`${Math.max(0,raidSession.hp)}/${boss.hp}\`\n🗡️ ATK: **${enraged?boss.enragedAtk:boss.atk}**  |  🛡️ DEF: **${boss.def}**${adaptedStr}`,
        inline:false,
      },
      { name:`👥 파티 (${raidSession.members.length}명)`,value:memberLines||"> 없음",inline:false },
    )
    .setFooter({ text:"레이드 — 파티원 누구나 행동 가능!" });
}

function partyCullingEmbed(party,session,log=[]) {
  const enemy=session.currentEnemy;
  const makeBar=(hp,maxHp,len=8)=>{
    const pct=Math.max(0,hp)/maxHp, fill=Math.round(pct*len);
    const icon=pct>0.5?"🟩":pct>0.25?"🟨":"🟥";
    return icon.repeat(Math.max(0,fill))+"⬛".repeat(Math.max(0,len-fill));
  };
  const memberLines=party.members.map(uid=>{
    const p=players[uid]; if (!p) return `> ❓`;
    const ch=CHARACTERS[p.active],stats=getPlayerStats(p),aw=isMakiAwakened(p);
    const pct=Math.max(0,p.hp)/stats.maxHp;
    const icon=pct>0.5?"🟢":pct>0.25?"🟡":"🔴";
    return `> ${party.leader===uid?"👑":"👤"} **${p.name}** ${ch.emoji} ${icon} \`${Math.max(0,p.hp)}/${stats.maxHp}\`${aw?" 🔥":""}`;
  }).join("\n");
  return new EmbedBuilder()
    .setTitle(`⚔️ [파티] 컬링 게임 — 🌊 WAVE ${session.wave}`)
    .setColor(session.wave>=15?0xF5C842:session.wave>=8?0xe63946:0x7C5CFC)
    .setDescription(log.length?log.join("\n"):"⚔️ 파티 컬링 진행 중!")
    .addFields(
      { name:`👥 파티원 (${party.members.length}명)`,value:memberLines||"없음",inline:false },
      {
        name:`${enemy.emoji} ${enemy.name}`,
        value:[
          `${makeBar(Math.max(0,session.enemyHp),enemy.hp)} \`${Math.max(0,session.enemyHp)}/${enemy.hp}\``,
          `🩸 상태: ${statusStr(enemy.statusEffects||[])}`,
        ].join("\n"), inline:false,
      },
      { name:"📊 현황",value:`WAVE **${session.wave}** | 처치 **${session.kills}** | **${session.totalXp}** XP / **${session.totalCrystals}**💎`,inline:false },
    )
    .setFooter({ text:"파티원 누구나 행동 가능! | 전원 사망 시 종료" });
}

function partyInfoEmbed(party) {
  const leader = players[party.leader];
  const lines = party.members.map((uid, i) => {
    const p = players[uid];
    if (!p) return `> ${i+1}. ❓ 알 수 없음`;
    const ch = CHARACTERS[p.active];
    const st = getPlayerStats(p);
    return `> ${uid===party.leader?"👑":"　"} **${p.name}** ${ch.emoji} \`${ch.name}\` [${ch.grade}] HP **${Math.max(0,p.hp)}**/${st.maxHp}`;
  }).join("\n");
  return new EmbedBuilder()
    .setColor(0x4ade80)
    .setTitle(`👥 파티 — ${leader?.name||"??"}의 파티`)
    .setDescription(lines||"> 없음")
    .addFields({ name:"파티 현황", value:`> ${party.members.length}/4명 | \`/파티컬링\`, \`/레이드\` 시작 가능` })
    .setFooter({ text:"파티장이 컬링/레이드 시작 | /파티초대 @유저" });
}

// ════════════════════════════════════════════════════════
// ── 가챠 임베드 (코가네 컷씬 포함)
// ════════════════════════════════════════════════════════
function gachaLoadingEmbed(stage=1) {
  const frames=[
    { title:"🔮 주술 소환 의식 — 준비",color:0x0a0a1e,
      desc:"```ansi\n\u001b[2;30m╔════════════════════════════╗\n║  ？    ？    ？    ？       ║\n║  저주 에너지 수렴 중...     ║\n╚════════════════════════════╝\n```" },
    { title:"⚡ 저주 에너지 최대 수렴!!",color:0x1a0533,
      desc:"```ansi\n\u001b[1;35m╔════════════════════════════╗\n║  ⚡  ✦  ？？？  ⚡          ║\n║  임계점 도달!! 소환 임박!!  ║\n╚════════════════════════════╝\n```" },
  ];
  const f=frames[stage-1]||frames[0];
  return new EmbedBuilder().setTitle(f.title).setColor(f.color).setDescription(f.desc);
}
function gachaRevealEmbed(grade) {
  const info=GACHA_RARITY[grade]||GACHA_RARITY["3급"];
  return new EmbedBuilder()
    .setTitle(`${info.effect} ${grade} 등급의 기운이 느껴진다!`)
    .setColor(info.color)
    .setDescription(`> *${info.stars}  —  ${info.flash}!*`);
}
function gachaResultEmbed(charId,isNew,player) {
  const ch=CHARACTERS[charId],info=GACHA_RARITY[ch.grade]||GACHA_RARITY["3급"];
  return new EmbedBuilder()
    .setTitle(isNew?`${info.effect} ✨ NEW! — ${ch.name} 획득!`:`${info.effect} 중복 — ${ch.name} (+50💎)`)
    .setColor(isNew?info.color:0x4a5568)
    .setDescription(`> *"${ch.lore||ch.desc}"*`)
    .addFields(
      { name:"🌌 영역전개",value:ch.domain||"없음",inline:true },
      { name:"⚔️ 등급",value:`${info.stars} \`[${ch.grade}]\``,inline:true },
      { name:"📖 설명",value:ch.desc,inline:false },
    )
    .setFooter({ text:`💎 잔여: ${player.crystals}` });
}
function gacha10ResultEmbed(results,newOnes,dupCrystals,player) {
  const sorted=[...results].sort((a,b)=>{
    const o=["특급","준특급","1급","준1급","2급","3급"];
    return o.indexOf(CHARACTERS[a].grade)-o.indexOf(CHARACTERS[b].grade);
  });
  const lines=sorted.map(id=>{
    const ch=CHARACTERS[id],info=GACHA_RARITY[ch.grade]||GACHA_RARITY["3급"],isN=newOnes.includes(id);
    return `${ch.emoji} ${info.stars} **${ch.name}** \`[${ch.grade}]\`${isN?" **✨NEW!**":""}`;
  });
  const legendaries=results.filter(id=>CHARACTERS[id].grade==="특급");
  return new EmbedBuilder()
    .setTitle(legendaries.length>0?`🔱 ⚡ 10연차 — 특급 등급 획득!! ⚡ 🔱`:`🎲 10회 주술 소환 결과`)
    .setColor(legendaries.length>0?0xF5C842:0x7c5cfc)
    .setDescription(lines.join("\n"))
    .addFields(
      { name:"✨ 신규 획득",value:newOnes.length?newOnes.map(id=>`${CHARACTERS[id].emoji} ${CHARACTERS[id].name}`).join(", "):"없음",inline:true },
      { name:"🔄 중복 보상",value:`**+${dupCrystals}** 💎`,inline:true },
      { name:"💎 잔여",value:`**${player.crystals}**`,inline:true },
    );
}

// ── 코가네 가챠 컷씬 임베드 (3단계 연출)
function koganeLoadingEmbed(stage=1) {
  const frames = [
    {
      title:"🐾 코가네 소환 의식...",
      color:0x2a1500,
      desc:"```ansi\n\u001b[2;33m╔══════════════════════════════╗\n║  🐾  황금 개의 기운이...     ║\n║      소환 에너지 수렴 중...   ║\n╚══════════════════════════════╝\n```\n> *어둠 속에서 황금빛이 어른거린다...*"
    },
    {
      title:"✨ 황금빛 기운 폭발!!",
      color:0xF5A800,
      desc:"```ansi\n\u001b[1;33m╔══════════════════════════════╗\n║  ✨  황금빛이 폭발한다!!  ✨  ║\n║  🐾  ？？？  🐾              ║\n╚══════════════════════════════╝\n```\n> *강렬한 황금빛과 함께 코가네가 나타난다!!*"
    },
    {
      title:"🌟 코가네 소환 완료!",
      color:0xFFD700,
      desc:"```ansi\n\u001b[1;33m╔══════════════════════════════════╗\n║  🌟  KOGANE  SUMMONED!!  🌟      ║\n║      황금 개 코가네 출현!!       ║\n╚══════════════════════════════════╝\n```"
    },
  ];
  return new EmbedBuilder().setTitle(frames[stage-1].title).setColor(frames[stage-1].color).setDescription(frames[stage-1].desc);
}
function koganeRevealEmbed(grade, isUpgrade, player) {
  const kg = KOGANE_GRADES[grade];
  const prevGrade = player.kogane?.grade;
  return new EmbedBuilder()
    .setColor(kg.color)
    .setTitle(
      isUpgrade
        ? `${kg.emoji} 코가네 등급 상승!! [${prevGrade||"없음"} → ${grade}]`
        : `${kg.emoji} 코가네 소환! [${grade}] ${kg.stars}`
    )
    .setDescription([
      isUpgrade
        ? "```ansi\n\u001b[1;33m╔══════════════════════════════╗\n║  🆙  GRADE  UP!!  🆙         ║\n╚══════════════════════════════╝\n```"
        : "",
      `> ${kg.stars}`,
      `> **패시브:** ${kg.passiveDesc}`,
      `> **스킬:** **${kg.skill}** — ${kg.skillDesc}`,
      !isUpgrade ? `> 🔄 중복 — **+50**💎 환급됨` : "",
      `> 총 소환: **${player.koganeGachaCount}회**`,
      `> 남은 크리스탈: **${player.crystals}**💎`,
    ].filter(Boolean).join("\n"))
    .addFields(
      { name:"📊 스탯 보너스",value:`🗡️ ATK +${Math.round(kg.atkBonus*100)}%\n🛡️ DEF +${Math.round(kg.defBonus*100)}%\n💚 HP +${Math.round(kg.hpBonus*100)}%`,inline:true },
      { name:"📈 보상 보너스",value:`⭐ XP +${Math.round(kg.xpBonus*100)}%\n💎 크리스탈 +${Math.round(kg.crystalBonus*100)}%`,inline:true },
    );
}
function koganeProfileEmbed(player) {
  const kogane=player.kogane;
  if (!kogane) return new EmbedBuilder().setTitle("🐾 코가네 — 황금 개 펫").setColor(0x4a5568)
    .setDescription("> **코가네**가 없습니다!\n> `/코가네가챠` 로 소환하세요! (200💎)")
    .setFooter({ text:"/코가네가챠 (200💎)" });
  const kg=KOGANE_GRADES[kogane.grade];
  return new EmbedBuilder().setTitle(`${kg.emoji} 코가네 [${kogane.grade}] ${kg.stars}`).setColor(kg.color)
    .setDescription([`> **패시브:** ${kg.passiveDesc}`,`> **스킬:** ${kg.skill} — ${kg.skillDesc}`].join("\n"))
    .addFields(
      { name:"📊 스탯 보너스",value:`🗡️ ATK +${Math.round(kg.atkBonus*100)}%\n🛡️ DEF +${Math.round(kg.defBonus*100)}%\n💚 HP +${Math.round(kg.hpBonus*100)}%`,inline:true },
      { name:"📈 보상 보너스",value:`⭐ XP +${Math.round(kg.xpBonus*100)}%\n💎 크리스탈 +${Math.round(kg.crystalBonus*100)}%`,inline:true },
    ).setFooter({ text:`총 소환 횟수: ${player.koganeGachaCount||0}회` });
}

// ════════════════════════════════════════════════════════
// ── 버튼 팩토리 (통일된 customId)
// ════════════════════════════════════════════════════════
function mkBattleButtons(player) {
  const canSkill = !player || player.skillCooldown <= 0;
  const canReverse = !player || player.reverseCooldown <= 0;
  const hasReverse = !player || REVERSE_CHARS.has(player.active);
  const mainSkill = player ? getMainSkill(player, player.active) : null;
  const skillName = player ? getCurrentSkill(player, player.active).name.slice(0,8) : "술식";
  const buttons = [
    new ButtonBuilder().setCustomId("bat_attack").setLabel("⚔️ 공격").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("bat_skill").setLabel(`🌀 ${skillName}`).setStyle(ButtonStyle.Primary).setDisabled(!canSkill),
  ];
  if (mainSkill) buttons.push(new ButtonBuilder().setCustomId("bat_main").setLabel(`⭐ ${mainSkill.name.slice(0,8)}`).setStyle(ButtonStyle.Success));
  buttons.push(
    new ButtonBuilder().setCustomId("bat_reverse").setLabel(`♻️ 반전${canReverse?"":"(✖)"}`).setStyle(ButtonStyle.Secondary).setDisabled(!canReverse||!hasReverse),
    new ButtonBuilder().setCustomId("bat_run").setLabel("🏃 도주").setStyle(ButtonStyle.Secondary),
  );
  return new ActionRowBuilder().addComponents(buttons);
}
function mkCullingButtons(player) {
  const canSkill = !player || player.skillCooldown <= 0;
  const canReverse = !player || player.reverseCooldown <= 0;
  const hasReverse = !player || REVERSE_CHARS.has(player.active);
  const skillName = player ? getCurrentSkill(player, player.active).name.slice(0,8) : "술식";
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("cul_attack").setLabel("⚔️ 공격").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("cul_skill").setLabel(`🌀 ${skillName}`).setStyle(ButtonStyle.Primary).setDisabled(!canSkill),
    new ButtonBuilder().setCustomId("cul_reverse").setLabel(`♻️ 반전${canReverse?"":"(✖)"}`).setStyle(ButtonStyle.Secondary).setDisabled(!canReverse||!hasReverse),
    new ButtonBuilder().setCustomId("cul_escape").setLabel("🏳️ 철수").setStyle(ButtonStyle.Secondary),
  );
}
function mkJujutsuButtons(player, choices) {
  const canSkill = !player || player.skillCooldown <= 0;
  const canReverse = !player || player.reverseCooldown <= 0;
  const hasReverse = !player || REVERSE_CHARS.has(player.active);
  const skillName = player ? getCurrentSkill(player, player.active).name.slice(0,8) : "술식";
  const rows = [];
  if (choices && choices.length) {
    const choiceRow = new ActionRowBuilder();
    for (let i = 0; i < Math.min(choices.length, 3); i++) {
      choiceRow.addComponents(new ButtonBuilder().setCustomId(`juj_choice_${i}`).setLabel(`⚔️ ${choices[i].name.slice(0,10)}`).setStyle(ButtonStyle.Primary));
    }
    rows.push(choiceRow);
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("juj_attack").setLabel("⚔️ 공격").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("juj_skill").setLabel(`🌀 ${skillName}`).setStyle(ButtonStyle.Primary).setDisabled(!canSkill),
    new ButtonBuilder().setCustomId("juj_reverse").setLabel(`♻️ 반전${canReverse?"":"(✖)"}`).setStyle(ButtonStyle.Secondary).setDisabled(!canReverse||!hasReverse),
    new ButtonBuilder().setCustomId("juj_escape").setLabel("🏳️ 철수").setStyle(ButtonStyle.Secondary),
  ));
  return rows;
}
function mkPvpButtons(session, userId) {
  const isP1 = session.p1Id === userId;
  const skillCd = isP1 ? session.skillCd1 : session.skillCd2;
  const reverseCd = isP1 ? session.reverseCd1 : session.reverseCd2;
  const domainUsed = isP1 ? session.domainUsed1 : session.domainUsed2;
  const p = players[userId];
  const hasReverse = REVERSE_CHARS.has(p?.active);
  const ch = p ? CHARACTERS[p.active] : null;
  const skillName = p ? getCurrentSkill(p, p.active).name.slice(0,8) : "술식";
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("pvp_atk").setLabel("⚔️ 공격").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("pvp_skill").setLabel(`🌀 ${skillName}`).setStyle(ButtonStyle.Primary).setDisabled(skillCd > 0),
    new ButtonBuilder().setCustomId("pvp_domain").setLabel("🌌 영역전개").setStyle(ButtonStyle.Success).setDisabled(domainUsed || !ch?.domain),
    new ButtonBuilder().setCustomId("pvp_reverse").setLabel(`♻️ 반전${reverseCd>0?`(${reverseCd}턴)`:""}`).setStyle(ButtonStyle.Secondary).setDisabled(reverseCd > 0 || !hasReverse),
    new ButtonBuilder().setCustomId("pvp_surrender").setLabel("🏳 항복").setStyle(ButtonStyle.Secondary),
  );
}
function mkRaidButtons(player) {
  const canSkill = !player || player.skillCooldown <= 0;
  const skillName = player ? getCurrentSkill(player, player.active).name.slice(0,8) : "술식";
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("rad_attack").setLabel("⚔️ 공격").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("rad_skill").setLabel(`🌀 ${skillName}`).setStyle(ButtonStyle.Primary).setDisabled(!canSkill),
    new ButtonBuilder().setCustomId("rad_retreat").setLabel("🏳️ 철수").setStyle(ButtonStyle.Secondary),
  );
}

// ════════════════════════════════════════════════════════
// ── 캐릭터 선택 셀렉트 메뉴
// ════════════════════════════════════════════════════════
function mkCharSelectMenu(player, customId="char_select") {
  const options = player.owned.map(id => {
    const ch = CHARACTERS[id];
    const ri = GACHA_RARITY[ch.grade] || GACHA_RARITY["3급"];
    const m = getMastery(player, id);
    // stats for this character
    const tempPlayer = { ...player, active: id };
    const s = getPlayerStats(tempPlayer);
    const fn = id==="sukuna" ? ` (손가락 ${player.sukunaFingers||0}개)` : "";
    return {
      label: `${id===player.active?"▶ ":""}${ch.name} [${ch.grade}]${fn}`.slice(0,100),
      description: `${ri.stars} · 숙련 ${m} · ATK ${s.atk} · HP ${s.maxHp}`.slice(0,100),
      value: id,
      default: id === player.active,
    };
  });
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder("✨ 캐릭터를 이름으로 선택하세요...")
      .addOptions(options)
  );
}

// ════════════════════════════════════════════════════════
// ── 술식 임베드
// ════════════════════════════════════════════════════════
function buildSkillEmbed(player) {
  const id=player.active;
  const ch=CHARACTERS[id];
  if (!ch) return new EmbedBuilder().setTitle("오류").setDescription("캐릭터 없음");
  const mastery=getMastery(player,id);
  const awakened=isMakiAwakened(player);
  const fingers=player.sukunaFingers||0;
  const mainSkill=getMainSkill(player,id);
  return new EmbedBuilder()
    .setTitle(`${ch.emoji} ≪ 술식 트리 ≫ ${ch.name}${awakened?" 🔥[각성]":""}`)
    .setColor(awakened?0xFF2200:JJK_GRADE_COLOR[ch.grade]||0x7c5cfc)
    .setDescription([
      `> ${ch.lore||ch.desc}`,
      `> 📈 **숙련도** ${masteryBar(mastery,id)}`,
      `> 🌌 **영역전개** \`${ch.domain||"없음"}\``,
      id==="itadori"?`> 👹 **스쿠나 손가락** \`${fingers}/${SUKUNA_FINGER_MAX}\` — ${getFingerBonus(fingers).label}`:"",
      id==="sukuna"?`> 👹 **손가락 보너스**: ATK+${getFingerBonus(fingers).atkBonus} DEF+${getFingerBonus(fingers).defBonus} HP+${getFingerBonus(fingers).hpBonus} DMG×${getFingerBonus(fingers).dmgMult.toFixed(2)}`:"",
      awakened?`> 🔥 **천여주박 각성 중** — 모든 데미지 **2배**!`:"",
      mainSkill?`> ⭐ **주력 스킬:** ${mainSkill.name} (해금됨!)`:id==="gojo"?`> ⭐ **주력 스킬:** 자폭 무라사키 (20승 필요)`:id==="sukuna"?`> ⭐ **주력 스킬:** 세계참 (손가락 10개 필요)`:"",
    ].filter(Boolean).join("\n"))
    .addFields(ch.skills.map((s,idx)=>{
      const unlocked=mastery>=s.minMastery;
      const fingerLock=s.name==="스쿠나 발현"&&fingers<10;
      const available=unlocked&&!fingerLock;
      const fx=getSkillEffect(s.name);
      const statusNote=s.statusApply?` \`${STATUS_EFFECTS[s.statusApply.statusId]?.emoji}${STATUS_EFFECTS[s.statusApply.statusId]?.name} ${Math.round(s.statusApply.chance*100)}%\``:"";;
      return {
        name:`${available?"✅":"🔒"} [${idx+1}] ${s.name}  —  피해 **${s.dmg}**${statusNote}  (숙련 ${s.minMastery})`,
        value:[`> ${s.desc}`, available?`> ${fx.art}`:"> 🔒 잠김"].join("\n"),
        inline:false,
      };
    }))
    .setFooter({ text:"흑섬 10% 확률 발동! | 전투 승리 시 숙련도 상승" });
}

// ════════════════════════════════════════════════════════
// ── 적 반격 공통
// ════════════════════════════════════════════════════════
async function doEnemyAttack(player, enemy, log) {
  const stats = getPlayerStats(player);
  const tick = tickStatus(player, stats.maxHp);
  if (tick.log.length) log.push(...tick.log);
  const enemyHit = rollHit(enemy.statusEffects||[], player.statusEffects);
  if (!enemyHit) { log.push(`> ↩️ **${enemy.name}**의 공격이 빗나갔다!`); return; }
  const eDmg = calcDmg(enemy.atk, stats.def);
  player.hp = Math.max(0, player.hp - eDmg);
  log.push(`> 💢 **${enemy.name}** 반격! **${eDmg}** 피해!`);
  if (enemy.statusAttack && Math.random() < (enemy.statusAttack.chance||0.3)) {
    applyStatus(player, enemy.statusAttack.statusId);
    const sdef = STATUS_EFFECTS[enemy.statusAttack.statusId];
    log.push(`> ${sdef.emoji} **${sdef.name}** 상태이상!`);
  }
}

// ════════════════════════════════════════════════════════
// ── 전투 핸들러 (bat_*)
// ════════════════════════════════════════════════════════
async function handleBattleAction(interaction, player, battle, action) {
  const enemy = battle.enemy;
  const stats = getPlayerStats(player);
  const log = [];

  if (action === "bat_run") {
    delete battles[interaction.user.id];
    return interaction.update({ content:"🏃 전투에서 도주했습니다!", embeds:[], components:[] });
  }
  if (action === "bat_reverse") {
    if (!REVERSE_CHARS.has(player.active))
      return interaction.reply({ content:"❌ 이 캐릭터는 반전술식 불가!", ephemeral:true });
    if (player.reverseCooldown > 0)
      return interaction.reply({ content:`❌ 반전술식 쿨다운: **${player.reverseCooldown}턴** 남음!`, ephemeral:true });
    const healAmount = Math.floor(stats.maxHp * 0.4);
    player.hp = Math.min(stats.maxHp, player.hp + healAmount);
    player.reverseCooldown = 3;
    player.statusEffects = (player.statusEffects||[]).filter(s=>s.id==="battleInstinct");
    tickCooldowns(player); savePlayer(interaction.user.id);
    log.push(`> ♻️ **반전술식!** **${healAmount}** HP 회복! 상태이상 해제!`);
    const embed = battleEmbed(player, enemy, log, "♻️ 반전술식!", 0x00ff88);
    return interaction.update({ embeds:[embed], components:[mkBattleButtons(player)] });
  }

  if (isIncapacitated(player.statusEffects)) {
    // 상태이상 턴 소모
    for (const se of player.statusEffects) se.turns = Math.max(0, se.turns-1);
    player.statusEffects = player.statusEffects.filter(s=>s.turns>0);
    log.push(`> ❄️ 상태이상으로 **행동 불가!**`);
    await doEnemyAttack(player, enemy, log);
    if (player.hp <= 0) {
      player.losses++; delete battles[interaction.user.id];
      savePlayer(interaction.user.id);
      const defeatEmbed = new EmbedBuilder().setTitle("💀 패배...").setColor(0xe63946)
        .setDescription("```ansi\n\u001b[1;31m╔═══════════════════════╗\n║  💀  D E F E A T  💀  ║\n╚═══════════════════════╝\n```\n> `/회복` 으로 HP를 회복하세요.");
      return interaction.update({ embeds:[battleEmbed(player,enemy,log),defeatEmbed], components:[] });
    }
    tickCooldowns(player); savePlayer(interaction.user.id);
    return interaction.update({ embeds:[battleEmbed(player,enemy,log,"⚠️ 행동 불가!",0x888888)], components:[mkBattleButtons(player)] });
  }

  let dmg=0, isBlack=false, skillName="", actionTitle="⚔️ 공격!", actionColor=0xff6b35;

  if (action === "bat_attack") {
    const hit = rollHit(player.statusEffects, enemy.statusEffects||[]);
    if (!hit) { log.push("> ⚡ 공격이 **빗나갔다!**"); }
    else {
      dmg = calcDmgForPlayer(player, enemy.def);
      isBlack = isBlackFlash();
      if (isBlack) {
        dmg = Math.floor(dmg*2.5); player.crystals += 50;
        log.push(getBlackFlashArt());
        log.push(`> 💥 **흑섬 발동!!** **${dmg}** 피해! (×2.5) +50💎`);
        actionTitle="⚫ 흑 섬!!"; actionColor=0x0a0a0a;
      } else {
        log.push(`> ⚔️ **${player.name}**의 공격! **${dmg}** 피해!`);
      }
      enemy.currentHp = Math.max(0, enemy.currentHp - dmg);
    }
  } else if (action === "bat_skill") {
    if (player.skillCooldown > 0)
      return interaction.reply({ content:`❌ 술식 쿨다운: **${player.skillCooldown}턴** 남음!`, ephemeral:true });
    const skill = getCurrentSkill(player, player.active);
    skillName = skill.name;
    const hit = rollHit(player.statusEffects, enemy.statusEffects||[]);
    if (!hit) { log.push(`> ⚡ **${skill.name}**이 빗나갔다!`); }
    else {
      dmg = calcSkillDmgForPlayer(player, skill.dmg);
      isBlack = isBlackFlash();
      if (isBlack) { dmg = Math.floor(dmg*2.5); player.crystals += 50; }
      const statusLog = applySkillStatus(skill, enemy, player);
      enemy.currentHp = Math.max(0, enemy.currentHp - dmg);
      const fx = getSkillEffect(skill.name);
      log.push(fx.art);
      log.push(`> *"${fx.flavorText}"*`);
      if (isBlack) log.push(`> ⚫ **흑섬!!** **${dmg}** 피해! (×2.5) +50💎`);
      else log.push(`> 💥 **${skill.name}** — **${dmg}** 피해!`);
      log.push(...statusLog);
      actionTitle=`🌀 ${skill.name}!`; actionColor=fx.color;
      updateQuestProgress(player, "skill_use", 1);
    }
    player.skillCooldown = 5;
  } else if (action === "bat_main") {
    const mainSkill = getMainSkill(player, player.active);
    if (!mainSkill) return interaction.reply({ content:"❌ 주력 스킬 미획득!", ephemeral:true });
    const hit = rollHit(player.statusEffects, enemy.statusEffects||[]);
    if (!hit) { log.push(`> ⚡ 주력 스킬이 빗나갔다!`); }
    else {
      dmg = calcSkillDmgForPlayer(player, mainSkill.dmg);
      isBlack = isBlackFlash();
      if (isBlack) { dmg = Math.floor(dmg*2.5); player.crystals += 50; }
      enemy.currentHp = Math.max(0, enemy.currentHp - dmg);
      const fx = getSkillEffect(mainSkill.name);
      log.push(fx.art);
      log.push(`> *"${fx.flavorText}"*`);
      if (isBlack) log.push(`> ⚫ **흑섬!!** **${dmg}** 피해! (×2.5)`);
      else log.push(`> ⭐ **${mainSkill.name}** — **${dmg}** 피해!`);
      if (mainSkill.name==="자폭 무라사키") { player.hp=1; log.push(`> 💥 **자폭 효과!** 자신의 HP → **1**!`); }
      actionTitle=`⭐ ${mainSkill.name}!`; actionColor=0xffd700;
    }
    player.skillCooldown = 6;
  }

  // 승리 체크
  if (enemy.currentHp <= 0) {
    delete battles[interaction.user.id];
    const winEmbed = await processBattleWin(player, enemy);
    savePlayer(interaction.user.id);
    return interaction.update({ embeds:[battleEmbed(player,enemy,log,actionTitle,actionColor), winEmbed], components:[] });
  }

  // 적 반격
  await doEnemyAttack(player, enemy, log);

  // 패배 체크
  if (player.hp <= 0) {
    player.losses++; delete battles[interaction.user.id];
    const defeatEmbed = new EmbedBuilder().setTitle("💀 패배...").setColor(0xe63946)
      .setDescription("```ansi\n\u001b[1;31m╔═══════════════════════╗\n║  💀  D E F E A T  💀  ║\n╚═══════════════════════╝\n```\n> 저주령에게 쓰러졌습니다...\n> `/회복` 으로 HP를 회복하세요.");
    savePlayer(interaction.user.id);
    return interaction.update({ embeds:[battleEmbed(player,enemy,log,actionTitle,actionColor), defeatEmbed], components:[] });
  }

  tickCooldowns(player); savePlayer(interaction.user.id);
  return interaction.update({ embeds:[battleEmbed(player,enemy,log,actionTitle,actionColor)], components:[mkBattleButtons(player)] });
}

// ════════════════════════════════════════════════════════
// ── 컬링 핸들러 (cul_*)
// ════════════════════════════════════════════════════════
async function handleCullingAction(interaction, player, culling, action) {
  const enemy = culling.currentEnemy;
  const stats = getPlayerStats(player);
  const log = [];

  if (action === "cul_escape") {
    if (culling.wave > (player.cullingBest||0)) player.cullingBest = culling.wave;
    delete cullings[interaction.user.id];
    savePlayer(interaction.user.id);
    return interaction.update({ content:`🏳️ 컬링 종료! 최고 기록: WAVE **${player.cullingBest}**`, embeds:[], components:[] });
  }
  if (action === "cul_reverse") {
    if (!REVERSE_CHARS.has(player.active))
      return interaction.reply({ content:"❌ 반전술식 불가!", ephemeral:true });
    if (player.reverseCooldown > 0)
      return interaction.reply({ content:`❌ 반전술식 쿨다운: **${player.reverseCooldown}턴** 남음!`, ephemeral:true });
    const heal = Math.floor(stats.maxHp*0.4);
    player.hp = Math.min(stats.maxHp, player.hp+heal);
    player.reverseCooldown = 3;
    player.statusEffects = (player.statusEffects||[]).filter(s=>s.id==="battleInstinct");
    log.push(`> ♻️ **${heal}** HP 회복! 상태이상 해제!`);
    tickCooldowns(player); savePlayer(interaction.user.id);
    return interaction.update({ embeds:[cullingEmbed(player,culling,log)], components:[mkCullingButtons(player)] });
  }

  if (isIncapacitated(player.statusEffects)) {
    for (const se of player.statusEffects) se.turns = Math.max(0, se.turns-1);
    player.statusEffects = player.statusEffects.filter(s=>s.turns>0);
    log.push(`> ❄️ 상태이상으로 **행동 불가!**`);
    await doEnemyAttack(player, enemy, log);
    if (player.hp <= 0) {
      if (culling.wave > (player.cullingBest||0)) player.cullingBest = culling.wave;
      delete cullings[interaction.user.id];
      savePlayer(interaction.user.id);
      return interaction.update({ embeds:[new EmbedBuilder().setTitle("💀 컬링 종료!").setColor(0xe63946)
        .setDescription(`> WAVE **${culling.wave}** 에서 쓰러졌습니다!\n> 최고기록: WAVE **${player.cullingBest}**`)], components:[] });
    }
    tickCooldowns(player); savePlayer(interaction.user.id);
    return interaction.update({ embeds:[cullingEmbed(player,culling,log)], components:[mkCullingButtons(player)] });
  }

  const hit = rollHit(player.statusEffects, enemy.statusEffects||[]);
  let dmg = 0;
  if (!hit) { log.push(`> ⚡ 공격이 빗나갔다!`); }
  else if (action === "cul_skill") {
    if (player.skillCooldown > 0)
      return interaction.reply({ content:`❌ 술식 쿨다운: **${player.skillCooldown}턴**`, ephemeral:true });
    const skill = getCurrentSkill(player, player.active);
    dmg = calcSkillDmgForPlayer(player, skill.dmg);
    const isBlack = isBlackFlash();
    if (isBlack) { dmg = Math.floor(dmg*2.5); player.crystals += 50; }
    const statusLog = applySkillStatus(skill, enemy, player);
    const fx = getSkillEffect(skill.name);
    log.push(fx.art);
    if (isBlack) log.push(`> ⚫ **흑섬!** **${dmg}** 피해! +50💎`);
    else log.push(`> 🌀 **${skill.name}** — **${dmg}** 피해!`);
    log.push(...statusLog);
    player.skillCooldown = 5;
    updateQuestProgress(player, "skill_use", 1);
  } else {
    dmg = calcDmgForPlayer(player, enemy.def);
    const isBlack = isBlackFlash();
    if (isBlack) { dmg = Math.floor(dmg*2.5); player.crystals += 50; log.push(`> ⚫ **흑섬!** **${dmg}** 피해! +50💎`); }
    else log.push(`> ⚔️ 공격! **${dmg}** 피해!`);
  }
  culling.enemyHp = Math.max(0, culling.enemyHp - dmg);

  if (culling.enemyHp <= 0) {
    const kb = getKoganeBonus(player);
    const xp = Math.floor(enemy.xp*kb.xp), cr = Math.floor(enemy.crystals*kb.crystal);
    culling.totalXp += xp; culling.totalCrystals += cr; culling.kills++;
    player.xp += xp; player.crystals += cr;
    player.mastery[player.active] = (player.mastery[player.active]||0) + (enemy.masteryXp||1);
    if (enemy.fingers) player.sukunaFingers = Math.min(SUKUNA_FINGER_MAX,(player.sukunaFingers||0)+enemy.fingers);
    const drops = rollDrops(enemy.id);
    addMaterials(player, drops);
    updateQuestProgress(player, "battle_win", 1);
    if (enemy.id==="e3"||enemy.id==="e4") updateQuestProgress(player, "boss_kill", 1);
    log.push(`> ✅ **${enemy.name}** 처치! +${xp}XP +${cr}💎`);
    if (Object.keys(drops).length) log.push(`> 📦 ${formatDrops(drops)}`);
    culling.wave++;
    updateQuestProgress(player, "culling_wave", 1);
    if (culling.wave > (player.cullingBest||0)) player.cullingBest = culling.wave;
    const nextEnemy = pickCullingEnemy(culling.wave);
    culling.currentEnemy = nextEnemy; culling.enemyHp = nextEnemy.hp;
    log.push(`> 🌊 **WAVE ${culling.wave}** — **${nextEnemy.name}** 등장!`);
  } else {
    await doEnemyAttack(player, enemy, log);
    if (player.hp <= 0) {
      if (culling.wave > (player.cullingBest||0)) player.cullingBest = culling.wave;
      delete cullings[interaction.user.id];
      savePlayer(interaction.user.id);
      return interaction.update({ embeds:[new EmbedBuilder().setTitle("💀 컬링 종료!").setColor(0xe63946)
        .setDescription(`> WAVE **${culling.wave}** 에서 쓰러졌습니다!\n> 총 XP: **${culling.totalXp}** | 총 💎: **${culling.totalCrystals}**\n> 최고기록: WAVE **${player.cullingBest}**`)], components:[] });
    }
  }
  tickCooldowns(player); savePlayer(interaction.user.id);
  return interaction.update({ embeds:[cullingEmbed(player,culling,log)], components:[mkCullingButtons(player)] });
}

// ════════════════════════════════════════════════════════
// ── 사멸회유 핸들러 (juj_*)
// ════════════════════════════════════════════════════════
async function handleJujutsuAction(interaction, player, jujutsu, action) {
  const stats = getPlayerStats(player);
  const log = [];

  if (action === "juj_escape") {
    if (jujutsu.points > (player.jujutsuBest||0)) player.jujutsuBest = jujutsu.points;
    delete jujutsus[interaction.user.id];
    savePlayer(interaction.user.id);
    return interaction.update({ content:`🏳️ 사멸회유 종료! 최고 기록: **${player.jujutsuBest}pt**`, embeds:[], components:[] });
  }

  const enemy = jujutsu.currentEnemy;
  if (!enemy) return interaction.reply({ content:"❌ 적을 먼저 선택하세요!", ephemeral:true });

  if (action === "juj_reverse") {
    if (!REVERSE_CHARS.has(player.active))
      return interaction.reply({ content:"❌ 반전술식 불가!", ephemeral:true });
    if (player.reverseCooldown > 0)
      return interaction.reply({ content:`❌ 반전술식 쿨다운: **${player.reverseCooldown}턴** 남음!`, ephemeral:true });
    const heal = Math.floor(stats.maxHp*0.4);
    player.hp = Math.min(stats.maxHp, player.hp+heal);
    player.reverseCooldown = 3;
    player.statusEffects = (player.statusEffects||[]).filter(s=>s.id==="battleInstinct");
    log.push(`> ♻️ **${heal}** HP 회복! 상태이상 해제!`);
    tickCooldowns(player); savePlayer(interaction.user.id);
    return interaction.update({ embeds:[jujutsuEmbed(player,jujutsu,log)], components:mkJujutsuButtons(player,[]) });
  }

  if (isIncapacitated(player.statusEffects)) {
    for (const se of player.statusEffects) se.turns = Math.max(0, se.turns-1);
    player.statusEffects = player.statusEffects.filter(s=>s.turns>0);
    log.push(`> ❄️ 상태이상으로 **행동 불가!**`);
    await doEnemyAttack(player, enemy, log);
    if (player.hp <= 0) {
      if (jujutsu.points > (player.jujutsuBest||0)) player.jujutsuBest = jujutsu.points;
      delete jujutsus[interaction.user.id];
      savePlayer(interaction.user.id);
      return interaction.update({ embeds:[new EmbedBuilder().setTitle("💀 사멸회유 종료!").setColor(0xe63946).setDescription(`> **${jujutsu.points}포인트** 획득!\n> 최고: **${player.jujutsuBest}pt**`)], components:[] });
    }
    tickCooldowns(player); savePlayer(interaction.user.id);
    return interaction.update({ embeds:[jujutsuEmbed(player,jujutsu,log)], components:mkJujutsuButtons(player,[]) });
  }

  const hit = rollHit(player.statusEffects, enemy.statusEffects||[]);
  let dmg = 0;
  if (!hit) { log.push(`> ⚡ 공격이 빗나갔다!`); }
  else if (action === "juj_skill") {
    if (player.skillCooldown > 0)
      return interaction.reply({ content:`❌ 술식 쿨다운: **${player.skillCooldown}턴**`, ephemeral:true });
    const skill = getCurrentSkill(player, player.active);
    dmg = calcSkillDmgForPlayer(player, skill.dmg);
    const isBlack = isBlackFlash();
    if (isBlack) { dmg = Math.floor(dmg*2.5); player.crystals += 50; }
    const statusLog = applySkillStatus(skill, enemy, player);
    const fx = getSkillEffect(skill.name);
    log.push(fx.art);
    if (isBlack) log.push(`> ⚫ **흑섬!** **${dmg}** 피해! +50💎`);
    else log.push(`> 🌀 **${skill.name}** — **${dmg}** 피해!`);
    log.push(...statusLog);
    player.skillCooldown = 5;
    updateQuestProgress(player, "skill_use", 1);
  } else {
    dmg = calcDmgForPlayer(player, enemy.def);
    const isBlack = isBlackFlash();
    if (isBlack) { dmg = Math.floor(dmg*2.5); player.crystals += 50; log.push(`> ⚫ **흑섬!** **${dmg}** 피해! +50💎`); }
    else log.push(`> ⚔️ 공격! **${dmg}** 피해!`);
  }
  jujutsu.enemyHp = Math.max(0, jujutsu.enemyHp - dmg);

  if (jujutsu.enemyHp <= 0) {
    const kb = getKoganeBonus(player);
    const xp = Math.floor(enemy.xp*kb.xp), cr = Math.floor(enemy.crystals*kb.crystal);
    jujutsu.totalXp += xp; jujutsu.totalCrystals += cr;
    jujutsu.points += enemy.points||1;
    player.xp += xp; player.crystals += cr;
    player.mastery[player.active] = (player.mastery[player.active]||0) + (enemy.masteryXp||1);
    const drops = rollDrops(enemy.id, true);
    addMaterials(player, drops);
    updateQuestProgress(player, "battle_win", 1);
    updateQuestProgress(player, "jujutsu_point", enemy.points||1);
    if (enemy.id==="j5"||enemy.id==="j6") updateQuestProgress(player, "boss_kill", 1);
    log.push(`> ✅ **${enemy.name}** 처치! +${xp}XP +${cr}💎 +${enemy.points}점`);
    if (Object.keys(drops).length) log.push(`> 📦 ${formatDrops(drops)}`);

    if (jujutsu.points >= 15) {
      player.crystals += 300; player.xp += 500;
      if (jujutsu.points > (player.jujutsuBest||0)) player.jujutsuBest = jujutsu.points;
      delete jujutsus[interaction.user.id];
      savePlayer(interaction.user.id);
      return interaction.update({ embeds:[new EmbedBuilder().setTitle("🏆 사멸회유 클리어!").setColor(0xF5C842)
        .setDescription(`> 15포인트 달성! **+300💎 +500XP** 보너스!\n${getNewlyCompletedQuestMsg(player)}`)], components:[] });
    }
    jujutsu.wave++; jujutsu.currentEnemy = null; jujutsu.enemyHp = 0;
    const choices = generateJujutsuChoices(jujutsu.wave);
    jujutsu.choices = choices;
    tickCooldowns(player); savePlayer(interaction.user.id);
    return interaction.update({ embeds:[jujutsuEmbed(player,jujutsu,log,choices)], components:mkJujutsuButtons(player,choices) });
  }

  await doEnemyAttack(player, enemy, log);
  if (player.hp <= 0) {
    if (jujutsu.points > (player.jujutsuBest||0)) player.jujutsuBest = jujutsu.points;
    delete jujutsus[interaction.user.id];
    savePlayer(interaction.user.id);
    return interaction.update({ embeds:[new EmbedBuilder().setTitle("💀 사멸회유 종료!").setColor(0xe63946).setDescription(`> **${jujutsu.points}포인트** 획득!\n> 최고: **${player.jujutsuBest}pt**`)], components:[] });
  }
  tickCooldowns(player); savePlayer(interaction.user.id);
  return interaction.update({ embeds:[jujutsuEmbed(player,jujutsu,log)], components:mkJujutsuButtons(player,[]) });
}

// ════════════════════════════════════════════════════════
// ── PvP 핸들러 (pvp_*)
// ════════════════════════════════════════════════════════
function createPvpSession(p1Id, p2Id) {
  const s1 = getPlayerStats(players[p1Id]);
  const s2 = getPlayerStats(players[p2Id]);
  const sessionId = `pvp_${_pvpIdSeq++}`;
  return {
    id: sessionId, p1Id, p2Id,
    hp1: s1.maxHp, hp2: s2.maxHp,
    maxHp1: s1.maxHp, maxHp2: s2.maxHp,
    status1: [], status2: [],
    skillCd1: 0, skillCd2: 0,
    reverseCd1: 0, reverseCd2: 0,
    domainUsed1: false, domainUsed2: false,
    turn: p1Id, round: 1, log: [],
  };
}

async function handlePvpAction(interaction, player, session, action) {
  const isP1 = session.p1Id === player.id;
  const myHpKey = isP1 ? "hp1" : "hp2";
  const opHpKey = isP1 ? "hp2" : "hp1";
  const myStatusKey = isP1 ? "status1" : "status2";
  const opStatusKey = isP1 ? "status2" : "status1";
  const mySkillCdKey = isP1 ? "skillCd1" : "skillCd2";
  const myRevCdKey = isP1 ? "reverseCd1" : "reverseCd2";
  const myDomainKey = isP1 ? "domainUsed1" : "domainUsed2";
  const myMaxHpKey = isP1 ? "maxHp1" : "maxHp2";

  const opp = players[isP1 ? session.p2Id : session.p1Id];
  if (!opp) return interaction.reply({ content:"❌ 상대방 정보 없음!", ephemeral:true });
  const myStats = getPlayerStats(player);
  const log = [];

  if (action === "pvp_surrender") {
    player.pvpLosses++; opp.pvpWins++;
    updateQuestProgress(opp, "pvp_win", 1);
    const sid = Object.keys(pvpSessions).find(k=>pvpSessions[k]===session);
    if (sid) delete pvpSessions[sid];
    savePlayer(player.id); savePlayer(opp.id);
    return interaction.update({
      embeds:[new EmbedBuilder().setTitle(`🏳 ${player.name} 항복 — ${opp.name} 승리!`).setColor(0xe63946)
        .setDescription(`> PvP: **${opp.pvpWins}승 ${opp.pvpLosses}패**`)],
      components:[],
    });
  }

  if (isIncapacitated(session[myStatusKey])) {
    for (const se of (session[myStatusKey]||[])) se.turns = Math.max(0, se.turns-1);
    session[myStatusKey] = (session[myStatusKey]||[]).filter(s=>s.turns>0);
    log.push(`> ❄️ **${player.name}** 행동 불가!`);
  } else {
    if (action === "pvp_atk") {
      const hit = rollHit(session[myStatusKey], session[opStatusKey]);
      if (!hit) { log.push(`> ⚡ **${player.name}**의 공격이 빗나갔다!`); }
      else {
        const opStats = getPlayerStats(opp);
        let dmg = calcDmg(myStats.atk * getWeakenMult(session[myStatusKey]), opStats.def);
        const bf = isBlackFlash();
        if (bf) {
          dmg = Math.floor(dmg*2.5); player.crystals += 50;
          log.push(getBlackFlashArt());
          log.push(`> 💥 **흑섬!!** **${dmg}** 피해! (×2.5) +50💎`);
        } else {
          log.push(`> ⚔️ **${player.name}** 공격! **${dmg}** 피해!`);
        }
        session[opHpKey] = Math.max(0, session[opHpKey] - dmg);
      }
    } else if (action === "pvp_skill") {
      if (session[mySkillCdKey] > 0)
        return interaction.reply({ content:`❌ 술식 쿨다운 **${session[mySkillCdKey]}턴** 남음!`, ephemeral:true });
      const skill = getCurrentSkill(player, player.active);
      const hit = rollHit(session[myStatusKey], session[opStatusKey]);
      if (!hit) { log.push(`> ⚡ **${skill.name}**이 빗나갔다!`); }
      else {
        let dmg = calcSkillDmgForPlayer(player, skill.dmg);
        const bf = isBlackFlash();
        const fx = getSkillEffect(skill.name);
        log.push(fx.art);
        log.push(`> *"${fx.flavorText}"*`);
        if (bf) {
          dmg = Math.floor(dmg*2.5); player.crystals += 50;
          log.push(`> ⚫ **흑섬!!** **${dmg}** 피해! (×2.5) +50💎`);
        } else {
          log.push(`> 🌀 **${skill.name}** — **${dmg}** 피해!`);
        }
        session[opHpKey] = Math.max(0, session[opHpKey] - dmg);
        if (skill.statusApply && Math.random() < skill.statusApply.chance) {
          if (skill.statusApply.target === "enemy") {
            if (!session[opStatusKey]) session[opStatusKey] = [];
            applyStatus({ statusEffects: session[opStatusKey] }, skill.statusApply.statusId);
            const sdef = STATUS_EFFECTS[skill.statusApply.statusId];
            log.push(`> ${sdef.emoji} **${sdef.name}** 상태이상 부여!`);
          } else if (skill.statusApply.target === "self") {
            if (!session[myStatusKey]) session[myStatusKey] = [];
            applyStatus({ statusEffects: session[myStatusKey] }, skill.statusApply.statusId);
            const sdef = STATUS_EFFECTS[skill.statusApply.statusId];
            log.push(`> ${sdef.emoji} **${sdef.name}** 발동!`);
          }
        }
      }
      session[mySkillCdKey] = 5;
      updateQuestProgress(player, "skill_use", 1);
    } else if (action === "pvp_domain") {
      if (session[myDomainKey])
        return interaction.reply({ content:"❌ 영역전개는 **1회**만 사용 가능!", ephemeral:true });
      const ch = CHARACTERS[player.active];
      if (!ch.domain)
        return interaction.reply({ content:"❌ 이 캐릭터는 영역전개가 없습니다!", ephemeral:true });
      const dmg = Math.floor(myStats.atk * 3.0);
      session[opHpKey] = Math.max(0, session[opHpKey] - dmg);
      session[myDomainKey] = true;
      log.push(`\`\`\`ansi\n\u001b[1;35m╔══════════════════════════════╗\n║  🌌  영역전개 발동!!  🌌       ║\n╚══════════════════════════════╝\n\`\`\``);
      log.push(`> 🌌 **${ch.domain}** — **${dmg}** 피해! *(1회 한정)*`);
    } else if (action === "pvp_reverse") {
      if (!REVERSE_CHARS.has(player.active))
        return interaction.reply({ content:"❌ 이 캐릭터는 반전술식을 사용할 수 없습니다!", ephemeral:true });
      if (session[myRevCdKey] > 0)
        return interaction.reply({ content:`❌ 반전술식 쿨다운 **${session[myRevCdKey]}턴** 남음!`, ephemeral:true });
      const heal = Math.floor(session[myMaxHpKey] * 0.40);
      session[myHpKey] = Math.min(session[myMaxHpKey], session[myHpKey] + heal);
      session[myRevCdKey] = 3;
      session[myStatusKey] = (session[myStatusKey]||[]).filter(s=>s.id==="battleInstinct");
      log.push(`> ♻️ **${player.name}** 반전술식! **${heal}** HP 회복 + 상태이상 해제!`);
    }
  }

  // 상태이상 도트 데미지
  {
    let dot = 0;
    for (const se of (session[myStatusKey]||[])) {
      if (se.id==="poison")       { const d=Math.max(1,Math.floor(session[myMaxHpKey]*0.05)); dot+=d; log.push(`> ☠️ **독** — **${d}** 피해`); }
      else if (se.id==="burn")    { const d=Math.max(1,Math.floor(session[myMaxHpKey]*0.08)); dot+=d; log.push(`> 🔥 **화상** — **${d}** 피해`); }
      else if (se.id==="cursed_wound") { const d=Math.max(1,Math.floor(session[myMaxHpKey]*0.10)); dot+=d; log.push(`> 🩸 **저주상처** — **${d}** 피해`); }
      se.turns--;
    }
    session[myStatusKey] = (session[myStatusKey]||[]).filter(s=>s.turns>0);
    session[myHpKey] = Math.max(0, (session[myHpKey]||0) - dot);
  }

  // 승패 판정
  const myDead = (session[myHpKey]||0) <= 0;
  const opDead = (session[opHpKey]||0) <= 0;
  if (myDead || opDead) {
    const winner = opDead ? player : opp;
    const loser = opDead ? opp : player;
    winner.pvpWins++; loser.pvpLosses++;
    updateQuestProgress(winner, "pvp_win", 1);
    const sid = Object.keys(pvpSessions).find(k=>pvpSessions[k]===session);
    if (sid) delete pvpSessions[sid];
    savePlayer(player.id); savePlayer(opp.id);
    session.log = [...(session.log||[]), ...log];
    return interaction.update({
      embeds:[pvpEmbed(session,[]), new EmbedBuilder().setTitle(`🏆 ${winner.name} 승리!`).setColor(0xF5C842)
        .setDescription(`> **${winner.name}** 이(가) **${loser.name}** 을(를) 격파!\n> PvP: **${winner.pvpWins}승 ${winner.pvpLosses}패**`)],
      components:[],
    });
  }

  // 쿨다운 & 턴 교체
  if ((session[mySkillCdKey]||0) > 0) session[mySkillCdKey]--;
  if ((session[myRevCdKey]||0) > 0) session[myRevCdKey]--;
  session.turn = isP1 ? session.p2Id : session.p1Id;
  session.round = (session.round||1) + 1;
  session.log = [...(session.log||[]), ...log].slice(-8);

  savePlayer(player.id);
  return interaction.update({
    embeds:[pvpEmbed(session,[])],
    components:[mkPvpButtons(session, session.turn)],
  });
}

// ════════════════════════════════════════════════════════
// ── 레이드 핸들러 (rad_*)
// ════════════════════════════════════════════════════════
async function doRaidBossAttack(player, raidSession, boss, log) {
  const stats = getPlayerStats(player);
  const bossAtk = raidSession.enraged ? boss.enragedAtk : boss.atk;
  const dmg = calcDmg(bossAtk, stats.def);
  player.hp = Math.max(0, player.hp - dmg);
  log.push(`> 💢 **${boss.name}** 반격! **${dmg}** 피해!`);
  if (boss.statusAttack && Math.random() < (boss.statusAttack.chance||0.3)) {
    applyStatus(player, boss.statusAttack.statusId);
    const sdef = STATUS_EFFECTS[boss.statusAttack.statusId];
    log.push(`> ${sdef.emoji} **${sdef.name}** 상태이상! (${sdef.duration}턴)`);
  }
  if (boss.specialAttack && Math.random() < 0.30) {
    const spDmg = boss.specialAttack.dmg;
    player.hp = Math.max(0, player.hp - spDmg);
    applyStatus(player, boss.specialAttack.statusId);
    const sdef = STATUS_EFFECTS[boss.specialAttack.statusId];
    log.push(`> 🔥 **[특수기] ${boss.specialAttack.name}** — **${spDmg}** 추가 피해! ${sdef.emoji} 상태이상!`);
  }
}

async function handleRaidAction(interaction, player, raidSession, action) {
  const boss = RAID_BOSSES[raidSession.bossId];
  const log = [];

  if (action === "rad_retreat") {
    raidSession.members = raidSession.members.filter(id=>id!==player.id);
    if (raidSession.members.length === 0) {
      const sid = Object.keys(raidSessions).find(k=>raidSessions[k]===raidSession);
      if (sid) delete raidSessions[sid];
    }
    savePlayer(player.id);
    return interaction.update({ content:"🏳️ 레이드에서 철수했습니다.", embeds:[], components:[] });
  }

  if (isIncapacitated(player.statusEffects)) {
    for (const se of player.statusEffects) se.turns = Math.max(0, se.turns-1);
    player.statusEffects = player.statusEffects.filter(s=>s.turns>0);
    log.push(`> ❄️ **${player.name}** 행동 불가!`);
    await doRaidBossAttack(player, raidSession, boss, log);
    tickCooldowns(player); savePlayer(player.id);
    return interaction.update({ embeds:[raidEmbed(raidSession,log)], components:[mkRaidButtons(player)] });
  }

  let dmg = 0;
  if (action === "rad_attack") {
    const hit = rollHit(player.statusEffects, []);
    if (!hit) { log.push(`> ⚡ **${player.name}** 공격 빗나감!`); }
    else {
      dmg = calcDmgForPlayer(player, boss.def);
      const bf = isBlackFlash();
      if (bf) {
        dmg = Math.floor(dmg*2.5); player.crystals += 50;
        log.push(getBlackFlashArt());
        log.push(`> 💥 **${player.name}** 흑섬! **${dmg}** 피해! (×2.5) +50💎`);
      } else {
        log.push(`> ⚔️ **${player.name}** 공격! **${dmg}** 피해!`);
      }
    }
  } else if (action === "rad_skill") {
    if (player.skillCooldown > 0)
      return interaction.reply({ content:`❌ 술식 쿨다운 **${player.skillCooldown}턴** 남음!`, ephemeral:true });
    const skill = getCurrentSkill(player, player.active);
    if (boss.adaptationSkill && (raidSession.adaptedSkills||[]).includes(skill.name)) {
      log.push(`> 🔄 **마허라가라**가 **${skill.name}**에 적응! 피해 **무효**!`);
      player.skillCooldown = 5;
      tickCooldowns(player); savePlayer(player.id);
      await doRaidBossAttack(player, raidSession, boss, log);
      return interaction.update({ embeds:[raidEmbed(raidSession,log)], components:[mkRaidButtons(player)] });
    }
    dmg = calcSkillDmgForPlayer(player, skill.dmg);
    const bf = isBlackFlash();
    const fx = getSkillEffect(skill.name);
    log.push(fx.art);
    log.push(`> *"${fx.flavorText}"*`);
    if (bf) {
      dmg = Math.floor(dmg*2.5); player.crystals += 50;
      log.push(`> ⚫ **${player.name}** 흑섬! **${dmg}** 피해! (×2.5)`);
    } else {
      log.push(`> 🌀 **${player.name}**: **${skill.name}** — **${dmg}** 피해!`);
    }
    if (boss.adaptationSkill) {
      if (!raidSession.adaptedSkills) raidSession.adaptedSkills = [];
      if (!raidSession.adaptedSkills.includes(skill.name)) {
        raidSession.adaptedSkills.push(skill.name);
        log.push(`> 🔄 **마허라가라**가 **${skill.name}**에 **적응 시작!** 다음부터 무효!`);
      }
    }
    player.skillCooldown = 5;
    updateQuestProgress(player, "skill_use", 1);
  }

  raidSession.hp = Math.max(0, raidSession.hp - dmg);

  if (!raidSession.enraged && raidSession.hp < boss.hp * boss.phaseHp) {
    raidSession.enraged = true;
    log.push(`\`\`\`ansi\n\u001b[1;31m⚠  분노 페이즈 돌입!!  ATK ${boss.enragedAtk} 으로 상승!  ⚠\n\`\`\``);
  }

  if (raidSession.hp <= 0) {
    const drops = rollDrops(boss.dropKey);
    for (const uid of raidSession.members) {
      const p = players[uid]; if (!p) continue;
      const kb = getKoganeBonus(p);
      p.xp += Math.floor(boss.xp*kb.xp);
      p.crystals += Math.floor(boss.crystals*kb.crystal);
      p.mastery[p.active] = (p.mastery[p.active]||0) + boss.masteryXp;
      if (boss.fingers) p.sukunaFingers = Math.min(SUKUNA_FINGER_MAX,(p.sukunaFingers||0)+boss.fingers);
      p.potion = (p.potion||0) + 3;
      addMaterials(p, drops);
      if (!p.raidClears) p.raidClears = {};
      p.raidClears[raidSession.bossId] = (p.raidClears[raidSession.bossId]||0) + 1;
      updateQuestProgress(p, "boss_kill", 1);
      savePlayer(uid);
    }
    const sid = Object.keys(raidSessions).find(k=>raidSessions[k]===raidSession);
    if (sid) delete raidSessions[sid];
    return interaction.update({
      embeds:[new EmbedBuilder().setTitle("🏆 레이드 클리어!").setColor(0xF5C842)
        .setDescription([
          "```ansi\n\u001b[1;33m╔══════════════════════════════╗\n║  🏆  RAID  CLEAR!!  🏆       ║\n╚══════════════════════════════╝\n```",
          `> **${boss.name}** 격파!`,
          `> +${boss.xp}XP · +${boss.crystals}💎 · +${boss.masteryXp}숙련 · 🧪회복약+3`,
          boss.fingers ? `> 👹 스쿠나 손가락 +${boss.fingers}개!` : "",
          `> 📦 재료: ${formatDrops(drops)}`,
        ].filter(Boolean).join("\n"))],
      components:[],
    });
  }

  await doRaidBossAttack(player, raidSession, boss, log);
  if (player.hp <= 0) {
    raidSession.members = raidSession.members.filter(id=>id!==player.id);
    log.push(`> 💀 **${player.name}** 전투 불능! 레이드 이탈.`);
    if (raidSession.members.length === 0) {
      const sid = Object.keys(raidSessions).find(k=>raidSessions[k]===raidSession);
      if (sid) delete raidSessions[sid];
      savePlayer(player.id);
      return interaction.update({ embeds:[new EmbedBuilder().setTitle("💀 레이드 실패").setColor(0xe63946).setDescription("> 파티원 전원 전투 불능...")], components:[] });
    }
  }
  tickCooldowns(player); savePlayer(player.id);
  return interaction.update({ embeds:[raidEmbed(raidSession,log)], components:[mkRaidButtons(player)] });
}

// ════════════════════════════════════════════════════════
// ── 파티 컬링 핸들러 (pc_*)
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
  if (isIncapacitated(player.statusEffects))
    return interaction.reply({ content:"❌ 상태이상!", ephemeral:true });

  const hit = rollHit(player.statusEffects, enemy.statusEffects||[]);
  let dmg = 0;
  if (!hit) { log.push(`> ⚡ **${player.name}**의 공격이 빗나갔다!`); }
  else if (action === "pc_skill") {
    if (player.skillCooldown > 0) return interaction.reply({ content:"❌ 술식 쿨다운!", ephemeral:true });
    const skill = getCurrentSkill(player, player.active);
    dmg = calcSkillDmgForPlayer(player, skill.dmg);
    const isBlack = isBlackFlash();
    if (isBlack) { dmg = Math.floor(dmg*2.5); log.push(`> ⚫ **${player.name}** 흑섬! **${dmg}** 피해!`); }
    else { log.push(`> 🌀 **${player.name}**: ${skill.name} — **${dmg}** 피해!`); }
    player.skillCooldown = 5;
  } else {
    dmg = calcDmgForPlayer(player, enemy.def);
    const isBlack = isBlackFlash();
    if (isBlack) { dmg = Math.floor(dmg*2.5); log.push(`> ⚫ **${player.name}** 흑섬! **${dmg}** 피해!`); }
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
    const tgt = party.members[Math.floor(Math.random()*party.members.length)];
    const p2 = players[tgt];
    if (p2) {
      const eDmg = calcDmg(enemy.atk, getPlayerStats(p2).def);
      p2.hp = Math.max(0, p2.hp - eDmg);
      log.push(`> 💢 **${enemy.name}** → **${p2.name}** **${eDmg}** 피해!`);
      if (p2.hp <= 0) log.push(`> 💀 **${p2.name}** 전투 불능!`);
    }
    if (party.members.every(uid=>(players[uid]?.hp||0)<=0)) {
      delete cullings[party.id];
      return interaction.update({ content:"💀 파티 전원 쓰러짐! 컬링 종료!", embeds:[], components:[] });
    }
  }
  tickCooldowns(player); savePlayer(player.id);
  return interaction.update({ embeds:[partyCullingEmbed(party,session,log)], components:[mkCullingButtons(player)] });
}

// ════════════════════════════════════════════════════════
// ── 슬래시 커맨드 처리 함수
// ════════════════════════════════════════════════════════
async function handleSlashCommand(interaction, commandName, player, userId, user) {

  if (commandName === "프로필") return interaction.reply({ embeds:[profileEmbed(player)] });

  if (commandName === "전투") {
    if (battles[userId]) return interaction.reply({ content:"❌ 이미 전투 중!", ephemeral:true });
    const roll = Math.random();
    let eBase;
    if      (roll < 0.05) eBase = ENEMIES.find(e=>e.id==="e_sukuna");
    else if (roll < 0.45) eBase = ENEMIES.find(e=>e.id==="e1");
    else if (roll < 0.78) eBase = ENEMIES.find(e=>e.id==="e2");
    else if (roll < 0.95) eBase = ENEMIES.find(e=>e.id==="e3");
    else                  eBase = ENEMIES.find(e=>e.id==="e4");

    const enemy = { ...eBase, currentHp: eBase.hp, statusEffects: [] };
    battles[userId] = { enemy };
    const stats = getPlayerStats(player);
    const isSukuna = eBase.isSukuna || eBase.id==="e_sukuna";

    const startEmbed = new EmbedBuilder()
      .setTitle(isSukuna ? "🔴 료멘 스쿠나 출현!" : `⚔️ ${enemy.emoji} ${enemy.name} 출현!`)
      .setColor(isSukuna ? 0x8b0000 : 0xff4444)
      .setDescription([
        isSukuna ? "```ansi\n\u001b[1;31m╔══════════════════════════════════════╗\n║  🔴  料理面宿儺 — 저주의 왕 출현!  🔴  ║\n╚══════════════════════════════════════╝\n```" : "",
        `> ${enemy.emoji} **${enemy.name}**`,
        `> 💚 HP **${enemy.hp}** · 🗡️ ATK **${enemy.atk}** · 🛡️ DEF **${enemy.def}**`,
        `> \n> ${CHARACTERS[player.active].emoji} **${player.name}** HP **${player.hp}**/**${stats.maxHp}** · 🧪 **${player.potion||0}개**`,
      ].filter(Boolean).join("\n"))
      .addFields({
        name:"⚡ 현재 스킬",
        value:`\`${getCurrentSkill(player,player.active).name}\` — 쿨다운: ${player.skillCooldown>0?`**${player.skillCooldown}턴**`:"**✅ 사용 가능**"} · 반전: ${REVERSE_CHARS.has(player.active)?(player.reverseCooldown>0?`**${player.reverseCooldown}턴**`:"**✅**"):"**불가**"}`,
      })
      .setFooter({ text:"흑섬 10% 확률 | 술식 5턴 쿨 | 영역전개: PvP 전용" });

    return interaction.reply({ embeds:[startEmbed], components:[mkBattleButtons(player)] });
  }

  if (commandName === "술식") return interaction.reply({ embeds:[buildSkillEmbed(player)] });

  if (commandName === "가챠") {
    const count = interaction.options.getInteger("횟수");
    if (count!==1 && count!==10) return interaction.reply({ content:"❌ 1 또는 10만 가능!", ephemeral:true });
    const cost = count===1 ? 150 : 1350;
    if (player.crystals < cost) return interaction.reply({ content:`💎 크리스탈 부족! (필요: **${cost}**)`, ephemeral:true });
    player.crystals -= cost;
    updateQuestProgress(player, "gacha_pull", 1);

    await interaction.reply({ embeds:[gachaLoadingEmbed(1)] });
    await new Promise(r=>setTimeout(r,2000));
    await interaction.editReply({ embeds:[gachaLoadingEmbed(2)] });
    await new Promise(r=>setTimeout(r,2000));

    if (count === 1) {
      const result = rollGacha(1)[0];
      const isNew = !player.owned.includes(result);
      if (isNew) { player.owned.push(result); if (!player.mastery[result]) player.mastery[result]=0; }
      else player.crystals += 50;
      await interaction.editReply({ embeds:[gachaRevealEmbed(CHARACTERS[result].grade), gachaResultEmbed(result,isNew,player)] });
    } else {
      const results = rollGacha(10);
      const dupCrystals = results.filter(id=>player.owned.includes(id)).length * 50;
      const newOnes = results.filter(id=>!player.owned.includes(id));
      for (const id of newOnes) { player.owned.push(id); if (!player.mastery[id]) player.mastery[id]=0; }
      player.crystals += dupCrystals;
      await interaction.editReply({ embeds:[gacha10ResultEmbed(results,newOnes,dupCrystals,player)] });
    }
    savePlayer(userId);
  }

  if (commandName === "활성") {
    if (!player.owned.length) return interaction.reply({ content:"❌ 보유 캐릭터 없음!", ephemeral:true });
    const ownedDesc = player.owned.map(id => {
      const ch = CHARACTERS[id];
      const ri = GACHA_RARITY[ch.grade]||GACHA_RARITY["3급"];
      const st = getPlayerStats({ ...player, active:id });
      const fn = id==="sukuna" ? ` 🖕${player.sukunaFingers||0}개` : "";
      return `> ${id===player.active?"▶️**[활성]** ":"　　"}${ch.emoji} **${ch.name}** \`[${ch.grade}]\` ${ri.stars}  ATK\`${st.atk}\` HP\`${st.maxHp}\`${fn}`;
    }).join("\n");
    return interaction.reply({
      embeds:[new EmbedBuilder().setColor(0x7C5CFC).setTitle("🎭 캐릭터 선택")
        .setDescription(ownedDesc)
        .setFooter({ text:"아래 메뉴에서 캐릭터를 이름으로 선택하세요!" })],
      components:[mkCharSelectMenu(player, "char_select")],
    });
  }

  if (commandName === "출석") {
    const now = Date.now();
    if (now-(player.lastDaily||0) < 86400000) {
      const h = Math.ceil((86400000-(now-player.lastDaily))/3600000);
      return interaction.reply({ content:`⏰ **${h}시간** 후 가능`, ephemeral:true });
    }
    const streak = Math.min(player.dailyStreak||0, 30);
    const cr = 100 + streak*5;
    player.crystals += cr; player.lastDaily = now; player.dailyStreak = (player.dailyStreak||0)+1;
    savePlayer(userId);
    return interaction.reply({ embeds:[new EmbedBuilder().setColor(0xF5C842).setTitle("✅ 출석 체크!")
      .setDescription(`> 💎 **+${cr}** 크리스탈!\n> 🔥 연속 **${player.dailyStreak}일** 출석\n> 현재: **${player.crystals}**💎`)] });
  }

  if (commandName === "회복") {
    if ((player.potion||0) <= 0) return interaction.reply({ content:"❌ 회복약 없음!\n> 전투 승리 시 드롭됩니다.", ephemeral:true });
    const stats = getPlayerStats(player);
    player.hp = stats.maxHp; player.potion--;
    savePlayer(userId);
    return interaction.reply({ embeds:[new EmbedBuilder().setColor(0x4ade80).setTitle("🧪 회복 완료!")
      .setDescription(`> 💚 HP **${stats.maxHp}** 완전 회복!\n> 남은 회복약: **${player.potion}개**`)] });
  }

  if (commandName === "코가네가챠") {
    if (player.crystals < 200) return interaction.reply({ content:"💎 부족! 필요: **200**", ephemeral:true });
    player.crystals -= 200;
    player.koganeGachaCount = (player.koganeGachaCount||0)+1;

    // 코가네 컷씬 3단계
    await interaction.reply({ embeds:[koganeLoadingEmbed(1)] });
    await new Promise(r=>setTimeout(r,1800));
    await interaction.editReply({ embeds:[koganeLoadingEmbed(2)] });
    await new Promise(r=>setTimeout(r,1800));
    await interaction.editReply({ embeds:[koganeLoadingEmbed(3)] });
    await new Promise(r=>setTimeout(r,1500));

    const grade = rollKogane();
    const gradeOrder = ["3급","2급","1급","특급","전설"];
    const isUpgrade = !player.kogane || gradeOrder.indexOf(grade) > gradeOrder.indexOf(player.kogane.grade);
    if (isUpgrade) player.kogane = { grade };
    else player.crystals += 50;
    savePlayer(userId);

    await interaction.editReply({ embeds:[koganeRevealEmbed(grade, isUpgrade, player)] });
  }

  if (commandName === "코가네") return interaction.reply({ embeds:[koganeProfileEmbed(player)] });

  if (commandName === "손가락") {
    const fingers = player.sukunaFingers||0;
    const fb = getFingerBonus(fingers);
    const bar = "█".repeat(fingers) + "░".repeat(SUKUNA_FINGER_MAX-fingers);
    return interaction.reply({ embeds:[new EmbedBuilder().setColor(0x8b0000).setTitle("👹 스쿠나 손가락")
      .setDescription([
        `\`\`\`\n[${bar}]\n${fingers} / ${SUKUNA_FINGER_MAX} 개\n\`\`\``,
        `> **${fb.label}**`,
        `> 🗡️ ATK +${fb.atkBonus} · 🛡️ DEF +${fb.defBonus} · 💚 HP +${fb.hpBonus} · 💥 DMG ×${fb.dmgMult.toFixed(2)}`,
        fingers===0 ? `> 💡 전투에서 스쿠나를 처치하면 손가락 획득!\n> 손가락 **1개**로 스쿠나 즉시 해금!` : player.owned.includes("sukuna") ? `> 🔴 스쿠나 해금됨 — \`/활성\` 으로 선택!` : "",
      ].filter(Boolean).join("\n"))] });
  }

  if (commandName === "컬링") {
    if (cullings[userId]) return interaction.reply({ content:"🌊 이미 컬링 중!", ephemeral:true });
    const first = pickCullingEnemy(1);
    cullings[userId] = { wave:1, kills:0, totalXp:0, totalCrystals:0, currentEnemy:first, enemyHp:first.hp };
    return interaction.reply({ embeds:[cullingEmbed(player,cullings[userId])], components:[mkCullingButtons(player)] });
  }

  if (commandName === "사멸회유") {
    if (jujutsus[userId]) return interaction.reply({ content:"🎯 이미 사멸회유 중!", ephemeral:true });
    const choices = generateJujutsuChoices(1);
    jujutsus[userId] = { wave:1, points:0, totalXp:0, totalCrystals:0, choices, currentEnemy:null, enemyHp:0 };
    return interaction.reply({ embeds:[jujutsuEmbed(player,jujutsus[userId],[],choices)], components:mkJujutsuButtons(player,choices) });
  }

  if (commandName === "결투") {
    const target = interaction.options.getUser("대상");
    if (!target) return interaction.reply({ content:"❌ 대상을 지정하세요!", ephemeral:true });
    if (target.id===userId) return interaction.reply({ content:"❌ 자신과 결투 불가!", ephemeral:true });
    if (getPvpSessionByUser(userId)) return interaction.reply({ content:"❌ 이미 PvP 진행 중!", ephemeral:true });
    if (getPvpSessionByUser(target.id)) return interaction.reply({ content:"❌ 상대방 PvP 중!", ephemeral:true });
    if (!players[target.id]) return interaction.reply({ content:"❌ 상대방이 아직 게임을 시작하지 않았습니다!", ephemeral:true });
    pvpChallenges[userId] = { target: target.id };
    const p2 = players[target.id];
    const ch1=CHARACTERS[player.active], ch2=CHARACTERS[p2.active];
    const s1=getPlayerStats(player), s2=getPlayerStats(p2);
    const embed = new EmbedBuilder().setColor(0xF5C842).setTitle("⚔️ PvP 결투 신청!")
      .setDescription([
        `${target}, **${user.username}** 님이 결투를 신청했습니다!`,
        `> ${ch1.emoji} **${ch1.name}** \`[${ch1.grade}]\` — HP **${s1.maxHp}** ATK **${s1.atk}**`,
        `> VS`,
        `> ${ch2.emoji} **${ch2.name}** \`[${ch2.grade}]\` — HP **${s2.maxHp}** ATK **${s2.atk}**`,
      ].join("\n")).setFooter({ text:"30초 내 수락/거절" });
    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`pvp_challenge_accept_${userId}`).setLabel("✅ 수락").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`pvp_challenge_decline_${userId}`).setLabel("❌ 거절").setStyle(ButtonStyle.Danger),
    );
    await interaction.reply({ content:`${target}`, embeds:[embed], components:[buttons] });
    setTimeout(()=>{ if (pvpChallenges[userId]) delete pvpChallenges[userId]; }, 30000);
  }

  if (commandName === "파티생성") {
    if (getPartyId(userId)) return interaction.reply({ content:"❌ 이미 파티 소속!", ephemeral:true });
    const partyId = `party_${Date.now()}`;
    parties[partyId] = { id:partyId, leader:userId, members:[userId] };
    return interaction.reply({ embeds:[partyInfoEmbed(parties[partyId])] });
  }

  if (commandName === "파티초대") {
    const target = interaction.options.getUser("대상");
    if (!target) return interaction.reply({ content:"❌ 대상을 지정하세요!", ephemeral:true });
    const party = getParty(userId);
    if (!party) return interaction.reply({ content:"❌ 파티 없음! `/파티생성`으로 생성하세요.", ephemeral:true });
    if (party.leader!==userId) return interaction.reply({ content:"❌ 파티장만 초대 가능!", ephemeral:true });
    if (party.members.length>=4) return interaction.reply({ content:"❌ 파티 가득참! (최대 4명)", ephemeral:true });
    if (getPartyId(target.id)) return interaction.reply({ content:"❌ 상대방이 이미 파티 소속!", ephemeral:true });
    partyInvites[target.id] = { partyId:party.id, inviter:userId };
    const embed = new EmbedBuilder().setColor(0x4ade80).setTitle("👥 파티 초대")
      .setDescription([
        `${target}, **${user.username}** 님의 파티에 초대받았습니다!`,
        `> 현재 파티원: **${party.members.length}/4명**`,
      ].join("\n")).setFooter({ text:"60초 내 수락/거절" });
    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`party_invite_accept_${party.id}_${target.id}`).setLabel("✅ 수락").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`party_invite_decline_${party.id}_${target.id}`).setLabel("❌ 거절").setStyle(ButtonStyle.Danger),
    );
    await interaction.reply({ content:`${target}`, embeds:[embed], components:[buttons] });
    setTimeout(()=>{ if (partyInvites[target.id]) delete partyInvites[target.id]; }, 60000);
  }

  if (commandName === "파티나가기") {
    const party = getParty(userId);
    if (!party) return interaction.reply({ content:"❌ 파티 없음!", ephemeral:true });
    const isLeader = party.leader===userId;
    party.members = party.members.filter(id=>id!==userId);
    if (!party.members.length) { delete parties[party.id]; return interaction.reply({ content:"✅ 파티 탈퇴 (파티 해체됨)" }); }
    if (isLeader) party.leader = party.members[0];
    return interaction.reply({ embeds:[partyInfoEmbed(party)] });
  }

  if (commandName === "파티정보") {
    const party = getParty(userId);
    if (!party) return interaction.reply({ content:"❌ 파티에 소속되어 있지 않습니다!", ephemeral:true });
    return interaction.reply({ embeds:[partyInfoEmbed(party)] });
  }

  if (commandName === "파티컬링") {
    const party = getParty(userId);
    if (!party) return interaction.reply({ content:"❌ 파티 없음!", ephemeral:true });
    if (party.leader!==userId) return interaction.reply({ content:"❌ 파티장만 시작!", ephemeral:true });
    if (cullings[party.id]) return interaction.reply({ content:"🌊 이미 파티 컬링 중!", ephemeral:true });
    const first = pickCullingEnemy(1);
    cullings[party.id] = { wave:1, kills:0, totalXp:0, totalCrystals:0, currentEnemy:first, enemyHp:first.hp };
    return interaction.reply({ embeds:[partyCullingEmbed(party,cullings[party.id])], components:[mkCullingButtons(player)] });
  }

  if (commandName === "레이드") {
    const bossId = interaction.options.getString("보스").toLowerCase();
    if (!RAID_BOSSES[bossId]) return interaction.reply({ content:"❌ 보스 없음!\n> `heian_sukuna` (헤이안 스쿠나)\n> `mahoraga` (마허라가라)", ephemeral:true });
    if (getRaidByUser(userId)) return interaction.reply({ content:"❌ 이미 레이드 진행 중!", ephemeral:true });
    const party = getParty(userId);
    const members = party ? [...party.members] : [userId];
    const boss = RAID_BOSSES[bossId];
    const raidId = `raid_${_raidIdSeq++}`;
    raidSessions[raidId] = { id:raidId, bossId, hp:boss.hp, enraged:false, members:[...members], adaptedSkills:[] };
    for (const uid of members) {
      const p = players[uid];
      if (p && p.hp<=0) { const st=getPlayerStats(p); p.hp=Math.floor(st.maxHp*0.5); savePlayer(uid); }
    }
    const memberLines = members.map(uid=>{
      const p=players[uid]; if (!p) return "> ❓";
      const ch=CHARACTERS[p.active],st=getPlayerStats(p);
      return `> ${ch.emoji} **${p.name}** \`${ch.name}\` HP ${Math.max(0,p.hp)}/${st.maxHp}`;
    }).join("\n");
    const introEmbed = new EmbedBuilder().setColor(boss.color)
      .setTitle(`⚔️ 레이드 시작: ${boss.name}`)
      .setDescription([
        "```ansi\n\u001b[1;31m╔══════════════════════════════════╗\n║  ⚔️  RAID BATTLE START!  ⚔️       ║\n╚══════════════════════════════════╝\n```",
        `> *"${boss.lore}"*`,
        `> 💚 HP **${boss.hp}** · 🗡️ ATK **${boss.atk}** · 🛡️ DEF **${boss.def}**`,
        bossId==="mahoraga" ? `> ⚠️ **마허라가라**: 맞은 술식에 적응 → 다음부터 **무효화!**` : "",
        bossId==="heian_sukuna" ? `> ⚠️ **헤이안 스쿠나**: HP ${boss.phaseHp*100}% 이하 → **분노 페이즈** (ATK ${boss.enragedAtk})` : "",
      ].filter(Boolean).join("\n"))
      .addFields({ name:`👥 참여 (${members.length}명)`, value:memberLines });
    return interaction.reply({ embeds:[introEmbed,raidEmbed(raidSessions[raidId])], components:[mkRaidButtons(player)] });
  }

  if (commandName === "코드") {
    const code = interaction.options.getString("코드").toLowerCase();
    if (player.usedCodes.includes(code)) return interaction.reply({ content:"❌ 이미 사용한 코드!", ephemeral:true });
    if (!CODES[code]) return interaction.reply({ content:"❌ 유효하지 않은 코드!", ephemeral:true });
    player.crystals += (CODES[code].crystals||0);
    player.usedCodes.push(code);
    savePlayer(userId);
    return interaction.reply({ content:`✅ 코드 적용! +**${CODES[code].crystals||0}**💎` });
  }

  if (commandName === "퀘스트") return interaction.reply({ embeds:[questEmbed(player)] });

  if (commandName === "퀘보상") {
    const type = interaction.options.getString("종류");
    const num = (interaction.options.getInteger("번호")||1) - 1;
    const isW = type==="주간";
    initQuests(player);
    const list = isW ? player.quests?.weekly : player.quests?.daily;
    const qid = list?.[num]?.id;
    if (!qid) return interaction.reply({ content:"❌ 잘못된 번호!", ephemeral:true });
    const reward = claimQuestReward(player, qid, isW);
    if (!reward) return interaction.reply({ content:"❌ 수령 불가! (미완료 또는 이미 수령)", ephemeral:true });
    savePlayer(userId);
    const matStr = reward.materials
      ? Object.entries(reward.materials).map(([m,q])=>`${MATERIALS[m]?.emoji||""}×${q}`).join(" ")
      : "";
    return interaction.reply({ embeds:[new EmbedBuilder().setColor(0xF5C842).setTitle("🎁 퀘스트 보상 수령!")
      .setDescription(`> +**${reward.crystals||0}**💎 · +**${reward.xp||0}**XP ${matStr}\n> 현재: **${player.crystals}**💎`)] });
  }

  if (commandName === "재료") return interaction.reply({ embeds:[materialsEmbed(player)] });
  if (commandName === "주구목록") return interaction.reply({ embeds:[weaponListEmbed(player)] });

  if (commandName === "주구제작") {
    const wid = interaction.options.getString("이름").toLowerCase().replace(/ /g,"_");
    const w = WEAPONS[wid];
    if (!w) return interaction.reply({ content:`❌ 없는 주구! 가능: ${Object.keys(WEAPONS).join(", ")}`, ephemeral:true });
    if ((player.craftedWeapons||[]).includes(wid)) return interaction.reply({ content:"❌ 이미 제작한 주구!", ephemeral:true });
    const mats = player.materials||{};
    for (const [mat,qty] of Object.entries(w.recipe)) {
      if ((mats[mat]||0) < qty) {
        const m = MATERIALS[mat];
        return interaction.reply({ content:`❌ 재료 부족! ${m.emoji}**${m.name}** ${mats[mat]||0}/${qty}`, ephemeral:true });
      }
    }
    for (const [mat,qty] of Object.entries(w.recipe)) mats[mat] -= qty;
    if (!player.craftedWeapons) player.craftedWeapons = [];
    player.craftedWeapons.push(wid);
    updateQuestProgress(player, "weapon_craft", 1);
    savePlayer(userId);
    return interaction.reply({ embeds:[new EmbedBuilder().setColor(w.color)
      .setTitle(`${w.emoji} ${w.name} 제작 완료!`)
      .setDescription([`> 등급: **${w.grade}**`,`> ATK+${w.atkBonus} DEF+${w.defBonus} HP+${w.hpBonus}`,`> ${w.desc}`,`> \`/장착\` 으로 장착하세요!`].join("\n"))] });
  }

  if (commandName === "장착") {
    const wid = interaction.options.getString("이름").toLowerCase().replace(/ /g,"_");
    if (!(player.craftedWeapons||[]).includes(wid)) return interaction.reply({ content:"❌ 제작하지 않은 주구!", ephemeral:true });
    player.equippedWeapon = wid;
    const w = WEAPONS[wid];
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
    return interaction.reply({ embeds:[new EmbedBuilder().setColor(0xF5C842).setTitle("🔱 주술회전 RPG — 명령어 목록")
      .setDescription([
        "**⚔️ 전투**",
        "> `/전투` `!전투` — 일반 전투 (5% 스쿠나 등장!)",
        "> `/컬링` `!컬링` — 웨이브 컬링",
        "> `/사멸회유` `!사멸회유` — 포인트 수집",
        "> `/결투 @유저` `!결투 @유저` — PvP",
        "",
        "**🔥 레이드**",
        "> `/레이드 heian_sukuna` — 헤이안 스쿠나",
        "> `/레이드 mahoraga` — 마허라가라",
        "",
        "**🎭 캐릭터**",
        "> `/활성` `!활성` — 캐릭터 선택 (이름 표시!)",
        "> `/가챠 1|10` `!가챠 1|10` — 소환",
        "> `/손가락` — 스쿠나 손가락",
        "",
        "**👥 파티**",
        "> `/파티생성` `/파티초대` `/파티나가기` `/파티정보` `/파티컬링`",
        "",
        "**⚔️ 주구**",
        "> `/재료` `/주구목록` `/주구제작 [ID]` `/장착 [ID]` `/해제`",
        "",
        "**📋 기타**",
        "> `/프로필` `/술식` `/출석` `/회복` `/퀘스트` `/퀘보상` `/코가네가챠` `/코가네` `/코드`",
        "",
        "**⭐ 특수 기믹**",
        "> ⚫ 흑섬: **10%** 확률 → 피해 **×2.5** +50💎",
        "> 👹 스쿠나: 처치 시 손가락 획득 → **1개**로 즉시 해금!",
        "> 🧪 회복약: 전투 승리 시 **22~100%** 확률 드롭!",
        "> 🌌 영역전개: **PvP 전용** 1회 한정!",
        "> 🔄 마허라가라: 맞은 술식 **다음 턴부터 면역**!
        
// PART 2 는 별도 파일로 계속됩니다 (!명령어 핸들러 + client.login)
module.exports = { client, players, battles, cullings, jujutsus, parties, partyInvites, pvpSessions, pvpChallenges, raidSessions };
// ════════════════════════════════════════════════════════
// 주술회전 RPG 봇 — PART 2 완전 수정본
// ※ index.js 에서 PART 1 의 마지막 두 줄:
//      client.login(...)  ← 삭제
//      module.exports = { ... }  ← 삭제
//    한 뒤 이 파일 전체를 이어붙이세요.
// ════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════
// ── 1. processBattleWin 교체 (회복약 드롭 포함)
// ════════════════════════════════════════════════════════
async function processBattleWin(player, enemy) {
  const kb = getKoganeBonus(player);
  const xpGain      = Math.floor((enemy.xp       || 50) * kb.xp);
  const crystalGain = Math.floor((enemy.crystals || 10) * kb.crystal);
  player.xp       += xpGain;
  player.crystals += crystalGain;
  const masteryGain = enemy.masteryXp || 1;
  player.mastery[player.active] = (player.mastery[player.active] || 0) + masteryGain;
  player.wins++;

  // ── 회복약 드롭
  const potionChances = { e1:0.22, e2:0.32, e3:0.48, e4:0.65, e_sukuna:1.00 };
  const potionChance  = potionChances[enemy.id] || 0.20;
  let potionMsg = "";
  if (Math.random() < potionChance) {
    const gain = enemy.isSukuna ? 3 : (enemy.id === "e4" ? 2 : 1);
    player.potion = (player.potion || 0) + gain;
    potionMsg = `\n> 🧪 **회복약 +${gain}개** 드롭! (보유: **${player.potion}개**)`;
  }

  // ── 스쿠나 손가락
  let fingerMsg = "";
  if (enemy.isSukuna) {
    const gained = enemy.fingers || 1;
    const before = player.sukunaFingers || 0;
    player.sukunaFingers = Math.min(SUKUNA_FINGER_MAX, before + gained);
    if (!player.owned.includes("sukuna")) {
      player.owned.push("sukuna");
      if (!player.mastery["sukuna"]) player.mastery["sukuna"] = 0;
      fingerMsg = `\n\n🔴 **스쿠나 해금!** 손가락 ${player.sukunaFingers}개!\n> \`/활성\` 또는 \`!활성\`으로 선택하세요!`;
    } else {
      fingerMsg = `\n\n👹 **스쿠나 손가락 +${gained}개!** (${player.sukunaFingers}/${SUKUNA_FINGER_MAX})\n> ${getFingerBonus(player.sukunaFingers).label}`;
    }
  } else if (enemy.fingers) {
    const before = player.sukunaFingers || 0;
    player.sukunaFingers = Math.min(SUKUNA_FINGER_MAX, before + enemy.fingers);
    if (player.sukunaFingers >= 1 && !player.owned.includes("sukuna")) {
      player.owned.push("sukuna");
      if (!player.mastery["sukuna"]) player.mastery["sukuna"] = 0;
      fingerMsg = `\n\n🔴 **스쿠나 해금!** \`/활성\` 으로 선택 가능!`;
    }
  }

  // ── 재료 드롭
  const dropKey = enemy.isSukuna ? "e_sukuna" : (enemy.id || "e1");
  const drops   = rollDrops(dropKey);
  addMaterials(player, drops);

  // ── 주력 스킬 언락
  let unlockMsg = "";
  if (player.active === "gojo" && !player.mainSkillUnlocked?.gojo && player.wins >= 20) {
    if (!player.mainSkillUnlocked) player.mainSkillUnlocked = {};
    player.mainSkillUnlocked.gojo = true;
    unlockMsg = "\n🎉 **주력 스킬 '자폭 무라사키' 해금!**";
  }
  if (player.active === "sukuna" && !player.mainSkillUnlocked?.sukuna && (player.sukunaFingers || 0) >= 10) {
    if (!player.mainSkillUnlocked) player.mainSkillUnlocked = {};
    player.mainSkillUnlocked.sukuna = true;
    unlockMsg = "\n🎉 **주력 스킬 '세계참' 해금!**";
  }

  updateQuestProgress(player, "battle_win", 1);
  if (["e3","e4","e_sukuna"].includes(enemy.id) || enemy.isSukuna)
    updateQuestProgress(player, "boss_kill", 1);

  const dropText  = Object.keys(drops).length ? `\n\n📦 **재료 드롭:**\n${formatDrops(drops)}` : "";
  const questDone = getNewlyCompletedQuestMsg(player);

  return new EmbedBuilder()
    .setTitle(enemy.isSukuna ? "👹 스쿠나 격파!!" : "🏆 전투 승리!")
    .setColor(enemy.isSukuna ? 0x8b0000 : 0xF5C842)
    .setDescription([
      enemy.isSukuna
        ? "```ansi\n\u001b[1;31m╔══════════════════════════════════╗\n║  👹  저주의 왕을 쓰러뜨렸다!  👹 ║\n╚══════════════════════════════════╝\n```"
        : "```ansi\n\u001b[1;33m╔══════════════════════════╗\n║   ✨  V I C T O R Y  ✨   ║\n╚══════════════════════════╝\n```",
      `> **${enemy.name}** 처치!`,
      `> ⭐ XP **+${xpGain}** | 💎 **+${crystalGain}** | 📈 숙련 **+${masteryGain}**`,
      dropText, potionMsg, fingerMsg, unlockMsg, questDone,
    ].filter(Boolean).join("\n"))
    .addFields({
      name: "📊 현재 상태",
      value: `> 💚 **${Math.max(0,player.hp)}** HP | 🧪 회복약 **${player.potion}개** | 💎 **${player.crystals}**\n> ⚔️ **${player.wins}승 ${player.losses}패**`,
    })
    .setFooter({ text: `LV.${getLevel(player.xp)}` });
}

// ════════════════════════════════════════════════════════
// ── 2. 고퀄 프로필 카드
// ════════════════════════════════════════════════════════
function profileEmbed(player) {
  const ch       = CHARACTERS[player.active];
  const stats    = getPlayerStats(player);
  const mastery  = getMastery(player, player.active);
  const awakened = isMakiAwakened(player);
  const lv       = getLevel(player.xp);
  const xpNow    = player.xp % 200;
  const hpPct    = Math.max(0, player.hp) / stats.maxHp;
  const fingers  = player.sukunaFingers || 0;
  const fb       = getFingerBonus(fingers);
  const kb       = getKoganeBonus(player);
  const kogane   = player.kogane;
  const kg       = kogane ? KOGANE_GRADES[kogane.grade] : null;
  const ri       = GACHA_RARITY[ch.grade] || GACHA_RARITY["3급"];
  const weapon   = player.equippedWeapon ? WEAPONS[player.equippedWeapon] : null;
  const ws       = getWeaponStats(player);
  const curSkill = getCurrentSkill(player, player.active);
  const nxtSkill = getNextSkill(player, player.active);
  const mainSkill= getMainSkill(player, player.active);

  const makeBar = (fill, total, len=16) => {
    const n = Math.max(0, Math.round((fill/total)*len));
    return "█".repeat(n) + "░".repeat(Math.max(0,len-n));
  };

  const hpIcon = hpPct>0.6?"🟢":hpPct>0.3?"🟡":"🔴";
  const hpBar  = `${hpIcon} \`${makeBar(player.hp,stats.maxHp)}\` **${Math.max(0,player.hp)}**/**${stats.maxHp}**`;
  const xpBar  = `⭐ \`${makeBar(xpNow,200)}\` ${xpNow}/200`;

  initQuests(player);
  const dailyDone  = (player.quests.daily  ||[]).filter(q=>q.done&&!q.claimed).length;
  const weeklyDone = (player.quests.weekly ||[]).filter(q=>q.done&&!q.claimed).length;

  const matSummary = Object.entries(player.materials||{})
    .filter(([,q])=>q>0).slice(0,8)
    .map(([id,q])=>`${MATERIALS[id]?.emoji||""}**×${q}**`).join(" ") || "없음";

  const raidClears = player.raidClears || {};
  const raidStr = Object.entries(RAID_BOSSES)
    .map(([id,b]) => `${(raidClears[id]||0)>0?"✅":"🔒"}${b.emoji}${b.name.split("〖")[0].trim()}(${raidClears[id]||0}클)`)
    .join("  ");

  const charList = player.owned.map(id => {
    const c  = CHARACTERS[id];
    const m  = getMastery(player,id);
    const cr = GACHA_RARITY[c.grade]||GACHA_RARITY["3급"];
    const fn = id==="sukuna" ? ` 🖕${fingers}개` : "";
    return `> ${id===player.active?"▶ **[활성]** ":"　　"}${c.emoji} **${c.name}** \`[${c.grade}]\` ${cr.stars} 숙련\`${m}\`${fn}`;
  }).join("\n");

  return new EmbedBuilder()
    .setColor(awakened ? 0xFF2200 : ri.color)
    .setTitle(
      awakened
        ? `🔥━━ 천여주박 각성 ━━🔥  ${player.name}`
        : `${ri.effect}  ${player.name} 의 주술사 카드  ${ri.effect}`
    )
    .addFields({
      name:"╔══[ 🪪 주술사 신분증 ]══════════════════╗",
      value:[
        `> ${ch.emoji} **${ch.name}**  \`[${ch.grade}]\`  ${ri.stars}`,
        `> *"${(ch.lore||ch.desc).slice(0,48)}${(ch.lore||ch.desc).length>48?"...":""}"*`,
        `> 🎖️ **Lv.${lv}**  ${xpBar}`,
        `> 💎 **${player.crystals}** 크리스탈  ·  🧪 회복약 **${player.potion}개**`,
        `> 🌌 영역전개: \`${ch.domain||"없음"}\``,
      ].join("\n"), inline:false,
    })
    .addFields({
      name:"╔══[ ⚔️ 전투 스탯 ]══════════════════════╗",
      value:[
        `> ${hpBar}${awakened?" 🔥**[천여주박 각성!]**":""}`,
        `> 🗡️ ATK **${stats.atk}**  ·  🛡️ DEF **${stats.def}**  ·  ⚡ SPD **${ch.spd}**`,
        weapon
          ? `> ${weapon.emoji} 장착: **${weapon.name}** \`+${ws.atk}ATK +${ws.def}DEF +${ws.hp}HP\``
          : `> ⚔️ 주구 없음  (\`/주구목록\` 확인)`,
        `> 🩸 상태이상: \`${statusStr(player.statusEffects)}\``,
        kg
          ? `> 🐾 코가네 [${kogane.grade}] ${kg.emoji} \`ATK+${Math.round(kg.atkBonus*100)}% DEF+${Math.round(kg.defBonus*100)}% XP+${Math.round(kg.xpBonus*100)}%\``
          : `> 🐾 코가네 없음 (\`/코가네가챠\` 200💎)`,
      ].join("\n"), inline:false,
    })
    .addFields({
      name:"╔══[ 🌀 술식 트리 ]══════════════════════╗",
      value:[
        `> 📈 숙련도 ${masteryBar(mastery,player.active)}`,
        `> ✅ 현재: **${curSkill.name}** (피해 \`${curSkill.dmg}\`)`,
        nxtSkill
          ? `> 🔒 다음: **${nxtSkill.name}** (숙련 \`${nxtSkill.minMastery}\` 필요)`
          : `> ✨ **모든 스킬 해금!**`,
        mainSkill
          ? `> ⭐ 주력: **${mainSkill.name}** \`[해금됨]\``
          : player.active==="gojo"  ? `> ⭐ 주력: 자폭 무라사키 \`[${player.wins}/20승]\``
          : player.active==="sukuna"? `> ⭐ 주력: 세계참 \`[손가락 ${fingers}/10]\``
          : "",
        (player.active==="itadori"||player.active==="sukuna")
          ? `> 👹 스쿠나 손가락: **${fingers}/${SUKUNA_FINGER_MAX}** — ${fb.label}` : "",
      ].filter(Boolean).join("\n"), inline:false,
    })
    .addFields(
      {
        name:"╔══[ 📊 전적 ]══════╗",
        value:[
          `> ⚔️ 일반: **${player.wins}승** ${player.losses}패`,
          `> 🥊 PvP: **${player.pvpWins}승** ${player.pvpLosses}패`,
          `> 🌊 컬링: **WAVE ${player.cullingBest||0}**`,
          `> 🎯 사멸회유: **${player.jujutsuBest||0}pt**`,
        ].join("\n"), inline:true,
      },
      {
        name:"╔══[ 🏆 레이드 ]═══╗",
        value: raidStr || "> 미도전", inline:true,
      },
      { name:"\u200b", value:"\u200b", inline:true }
    )
    .addFields(
      {
        name:"╔══[ 📦 재료 ]══════╗",
        value:`> ${matSummary}\n> \`/재료\` 상세`, inline:true,
      },
      {
        name:"╔══[ 📋 퀘스트 ]════╗",
        value:[
          `> 일일 대기: **${dailyDone}개**`,
          `> 주간 대기: **${weeklyDone}개**`,
          `> \`/퀘스트\` 확인`,
        ].join("\n"), inline:true,
      },
      { name:"\u200b", value:"\u200b", inline:true }
    )
    .addFields({
      name:"╔══[ 🎴 보유 캐릭터 ]══════════════════════╗",
      value: charList||"> 없음", inline:false,
    })
    .setFooter({ text:`/전투 /컬링 /사멸회유 /결투 /레이드 /가챠 /퀘스트 | Lv.${lv} · ${ch.name}` })
    .setTimestamp();
}

// ════════════════════════════════════════════════════════
// ── 3. 캐릭터 선택 Select Menu (이름 표시)
// ════════════════════════════════════════════════════════
function mkCharSelectMenu(player, customId = "char_select") {
  const options = player.owned.map(id => {
    const ch = CHARACTERS[id];
    const ri = GACHA_RARITY[ch.grade] || GACHA_RARITY["3급"];
    const m  = getMastery(player, id);
    const s  = getPlayerStats({ ...player, active: id });
    const fn = id === "sukuna" ? ` 🖕${player.sukunaFingers||0}개` : "";
    return {
      label      : `${id===player.active?"▶ ":""}${ch.name} [${ch.grade}]${fn}`,
      description: `${ri.stars} · 숙련 ${m} · ATK ${s.atk} · HP ${s.maxHp}`,
      value      : id,
      default    : id === player.active,
    };
  });
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder("✨ 캐릭터를 이름으로 선택하세요...")
      .addOptions(options)
  );
}

// ════════════════════════════════════════════════════════
// ── 4. PvP 시스템 완전 재작성
//       버그: Part1 customId=p_xxx, Part2 customId=pvp_xxx 혼재
//       → 통일: customId = "pvp_atk" | "pvp_skill" | "pvp_domain" | "pvp_reverse" | "pvp_surrender"
// ════════════════════════════════════════════════════════
function createPvpSession(p1Id, p2Id) {
  const s1 = getPlayerStats(players[p1Id]);
  const s2 = getPlayerStats(players[p2Id]);
  return {
    id: `pvp_${Date.now()}`,
    p1Id, p2Id,
    hp1: s1.maxHp, hp2: s2.maxHp,
    maxHp1: s1.maxHp, maxHp2: s2.maxHp,
    status1: [], status2: [],
    skillCd1: 0, skillCd2: 0,
    reverseCd1: 0, reverseCd2: 0,
    domainUsed1: false, domainUsed2: false,
    turn: p1Id, round: 1, log: [],
  };
}

function pvpEmbed(session, extraLog = []) {
  const p1  = players[session.p1Id];
  const p2  = players[session.p2Id];
  if (!p1 || !p2) return new EmbedBuilder().setTitle("PvP 오류").setColor(0xe63946);
  const ch1 = CHARACTERS[p1.active];
  const ch2 = CHARACTERS[p2.active];
  const BAR = 10;
  const barLine = (hp, maxHp) => {
    const pct  = Math.max(0,hp) / maxHp;
    const icon = pct>0.5?"🟩":pct>0.25?"🟨":"🟥";
    const fill = Math.round(pct*BAR);
    return icon.repeat(Math.max(0,fill)) + "⬛".repeat(Math.max(0,BAR-fill));
  };

  const allLog    = [...(session.log||[]), ...extraLog].slice(-6);
  const turnName  = session.turn === session.p1Id ? p1.name : p2.name;

  return new EmbedBuilder()
    .setColor(0xF5C842)
    .setTitle(`⚔️ PvP 결투  Round ${session.round}`)
    .setDescription(allLog.join("\n") || "⚔️ 결투 시작!")
    .addFields(
      {
        name : `${ch1.emoji} ${p1.name}${session.turn===session.p1Id?" ◀ [내 턴]":""}`,
        value: [
          `\`${barLine(session.hp1,session.maxHp1)}\` **${Math.max(0,session.hp1)}**/${session.maxHp1}`,
          `상태: \`${statusStr(session.status1)}\``,
          `⚡술식: ${session.skillCd1>0?`**${session.skillCd1}턴**`:"✅"}  ♻반전: ${session.reverseCd1>0?`**${session.reverseCd1}턴**`:"✅"}`,
          `🌌 영역전개: ${session.domainUsed1?"✖사용완료":"✅사용가능"}`,
        ].join("\n"),
        inline: true,
      },
      {
        name : `${ch2.emoji} ${p2.name}${session.turn===session.p2Id?" ◀ [내 턴]":""}`,
        value: [
          `\`${barLine(session.hp2,session.maxHp2)}\` **${Math.max(0,session.hp2)}**/${session.maxHp2}`,
          `상태: \`${statusStr(session.status2)}\``,
          `⚡술식: ${session.skillCd2>0?`**${session.skillCd2}턴**`:"✅"}  ♻반전: ${session.reverseCd2>0?`**${session.reverseCd2}턴**`:"✅"}`,
          `🌌 영역전개: ${session.domainUsed2?"✖사용완료":"✅사용가능"}`,
        ].join("\n"),
        inline: true,
      },
      {
        name : "🎯 턴",
        value: `> **${turnName}** 의 차례! (Round ${session.round})`,
        inline: false,
      }
    )
    .setFooter({ text:"술식 5턴쿨 | 반전 3턴쿨 | 영역전개 1회 | 회피 5%" });
}

// ── PvP 버튼: customId 통일 → "pvp_atk", "pvp_skill", "pvp_domain", "pvp_reverse", "pvp_surrender"
function mkPvpButtons(session, userId) {
  const isP1       = session.p1Id === userId;
  const skillCd    = isP1 ? session.skillCd1    : session.skillCd2;
  const reverseCd  = isP1 ? session.reverseCd1  : session.reverseCd2;
  const domainUsed = isP1 ? session.domainUsed1 : session.domainUsed2;
  const p          = players[userId];
  const hasReverse = REVERSE_CHARS.has(p?.active);
  const ch         = p ? CHARACTERS[p.active] : null;
  const skillName  = p ? getCurrentSkill(p, p.active).name.slice(0,8) : "술식";

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("pvp_atk").setLabel("⚔️ 공격").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("pvp_skill").setLabel(`🌀 ${skillName}`).setStyle(ButtonStyle.Primary).setDisabled(skillCd > 0),
    new ButtonBuilder().setCustomId("pvp_domain").setLabel("🌌 영역전개").setStyle(ButtonStyle.Success).setDisabled(domainUsed || !ch?.domain),
    new ButtonBuilder().setCustomId("pvp_reverse").setLabel(`♻️ 반전${reverseCd>0?`(${reverseCd}턴)`:""}`).setStyle(ButtonStyle.Secondary).setDisabled(reverseCd > 0 || !hasReverse),
    new ButtonBuilder().setCustomId("pvp_surrender").setLabel("🏳 항복").setStyle(ButtonStyle.Secondary),
  );
}

async function handlePvpAction(interaction, player, session, action) {
  const isP1         = session.p1Id === player.id;
  const myHpKey      = isP1 ? "hp1"         : "hp2";
  const opHpKey      = isP1 ? "hp2"         : "hp1";
  const myStatusKey  = isP1 ? "status1"     : "status2";
  const opStatusKey  = isP1 ? "status2"     : "status1";
  const mySkillCdKey = isP1 ? "skillCd1"    : "skillCd2";
  const myRevCdKey   = isP1 ? "reverseCd1"  : "reverseCd2";
  const myDomainKey  = isP1 ? "domainUsed1" : "domainUsed2";
  const myMaxHpKey   = isP1 ? "maxHp1"      : "maxHp2";

  const opp     = players[isP1 ? session.p2Id : session.p1Id];
  if (!opp) return interaction.reply({ content:"❌ 상대방 정보 없음!", ephemeral:true });
  const myStats = getPlayerStats(player);
  const log     = [];

  // ── 항복
  if (action === "pvp_surrender") {
    player.pvpLosses++; opp.pvpWins++;
    updateQuestProgress(opp, "pvp_win", 1);
    const sid = Object.keys(pvpSessions).find(k => pvpSessions[k] === session);
    if (sid) delete pvpSessions[sid];
    savePlayer(player.id); savePlayer(opp.id);
    return interaction.update({
      embeds:[pvpEmbed(session, log), new EmbedBuilder().setTitle(`🏳 ${player.name} 항복 — ${opp.name} 승리!`).setColor(0xe63946)
        .setDescription(`> **${opp.name}** 의 승리!\n> PvP: **${opp.pvpWins}승 ${opp.pvpLosses}패**`)],
      components:[],
    });
  }

  // ── 행동 처리
  if (isIncapacitated(session[myStatusKey])) {
    // 상태이상으로 행동 불가 — 틱 소모 후 턴 넘김
    for (const se of session[myStatusKey]) se.turns = Math.max(0, se.turns-1);
    session[myStatusKey] = session[myStatusKey].filter(s => s.turns > 0);
    log.push(`> ❄️ **${player.name}** 행동 불가! (상태이상 지속)`);
  } else {

    // ── 공격
    if (action === "pvp_atk") {
      const hit = rollHit(session[myStatusKey], session[opStatusKey]);
      if (!hit) {
        log.push(`> ⚡ **${player.name}**의 공격이 빗나갔다!`);
      } else {
        const opStats = getPlayerStats(opp);
        let dmg = calcDmg(myStats.atk * getWeakenMult(session[myStatusKey]), opStats.def);
        const bf  = isBlackFlash();
        if (bf) {
          dmg = Math.floor(dmg*2.5); player.crystals += 50;
          log.push(getBlackFlashArt());
          log.push(`> 💥 **흑섬!!** **${dmg}** 피해! (×2.5) +50💎`);
        } else {
          log.push(`> ⚔️ **${player.name}** 공격! **${dmg}** 피해!`);
        }
        session[opHpKey] = Math.max(0, session[opHpKey] - dmg);
      }
    }

    // ── 술식
    else if (action === "pvp_skill") {
      if (session[mySkillCdKey] > 0)
        return interaction.reply({ content:`❌ 술식 쿨다운 **${session[mySkillCdKey]}턴** 남음!`, ephemeral:true });
      const skill = getCurrentSkill(player, player.active);
      const hit   = rollHit(session[myStatusKey], session[opStatusKey]);
      if (!hit) {
        log.push(`> ⚡ **${player.name}**의 **${skill.name}**이 빗나갔다!`);
      } else {
        const opStats = getPlayerStats(opp);
        let dmg = calcSkillDmgForPlayer(player, skill.dmg);
        const bf  = isBlackFlash();
        const fx  = getSkillEffect(skill.name);
        log.push(fx.art);
        log.push(`> *"${fx.flavorText}"*`);
        if (bf) {
          dmg = Math.floor(dmg*2.5); player.crystals += 50;
          log.push(`> ⚫ **흑섬!!** **${dmg}** 피해! (×2.5) +50💎`);
        } else {
          log.push(`> 🌀 **${skill.name}** — **${dmg}** 피해!`);
        }
        session[opHpKey] = Math.max(0, session[opHpKey] - dmg);
        // 상태이상 부여
        if (skill.statusApply && Math.random() < skill.statusApply.chance && skill.statusApply.target === "enemy") {
          if (!session[opStatusKey]) session[opStatusKey] = [];
          applyStatus({ statusEffects: session[opStatusKey] }, skill.statusApply.statusId);
          const sdef = STATUS_EFFECTS[skill.statusApply.statusId];
          log.push(`> ${sdef.emoji} **${sdef.name}** 상태이상 부여! (${sdef.duration}턴)`);
        }
        // 자기 버프 스킬
        if (skill.statusApply && skill.statusApply.target === "self" && Math.random() < skill.statusApply.chance) {
          applyStatus({ statusEffects: session[myStatusKey] }, skill.statusApply.statusId);
          const sdef = STATUS_EFFECTS[skill.statusApply.statusId];
          log.push(`> ${sdef.emoji} **${sdef.name}** 발동! (${sdef.duration}턴)`);
        }
      }
      session[mySkillCdKey] = 5;
      updateQuestProgress(player, "skill_use", 1);
    }

    // ── 영역전개
    else if (action === "pvp_domain") {
      if (session[myDomainKey])
        return interaction.reply({ content:"❌ 영역전개는 **1회**만 사용 가능!", ephemeral:true });
      const ch = CHARACTERS[player.active];
      if (!ch.domain)
        return interaction.reply({ content:"❌ 이 캐릭터는 영역전개가 없습니다!", ephemeral:true });
      const dmg = Math.floor(myStats.atk * 3.0);
      session[opHpKey] = Math.max(0, session[opHpKey] - dmg);
      session[myDomainKey] = true;
      log.push(`\`\`\`ansi\n\u001b[1;35m╔══════════════════════════════╗\n║  🌌  영역전개 발동!!  🌌       ║\n╚══════════════════════════════╝\n\`\`\``);
      log.push(`> 🌌 **${ch.domain}** — **${dmg}** 피해! *(1회 한정)*`);
    }

    // ── 반전술식
    else if (action === "pvp_reverse") {
      if (!REVERSE_CHARS.has(player.active))
        return interaction.reply({ content:"❌ 이 캐릭터는 반전술식을 사용할 수 없습니다!", ephemeral:true });
      if (session[myRevCdKey] > 0)
        return interaction.reply({ content:`❌ 반전술식 쿨다운 **${session[myRevCdKey]}턴** 남음!`, ephemeral:true });
      const heal = Math.floor(session[myMaxHpKey] * 0.40);
      session[myHpKey] = Math.min(session[myMaxHpKey], session[myHpKey] + heal);
      session[myRevCdKey] = 3;
      session[myStatusKey] = (session[myStatusKey]||[]).filter(s => s.id === "battleInstinct");
      log.push(`> ♻️ **${player.name}** 반전술식! **${heal}** HP 회복 + 상태이상 해제!`);
    }
  }

  // ── 상태이상 도트 데미지 (내 턴)
  {
    let dot = 0;
    for (const se of (session[myStatusKey]||[])) {
      const def = STATUS_EFFECTS[se.id];
      if (!def) continue;
      if      (se.id === "poison")       { const d = Math.max(1,Math.floor(session[myMaxHpKey]*0.05)); dot+=d; log.push(`> ☠️ **독** — **${d}** 피해`); }
      else if (se.id === "burn")         { const d = Math.max(1,Math.floor(session[myMaxHpKey]*0.08)); dot+=d; log.push(`> 🔥 **화상** — **${d}** 피해`); }
      else if (se.id === "cursed_wound") { const d = Math.max(1,Math.floor(session[myMaxHpKey]*0.10)); dot+=d; log.push(`> 🩸 **저주상처** — **${d}** 피해`); }
    }
    session[myHpKey] = Math.max(0, (session[myHpKey]||0) - dot);
  }

  // ── 승패 판정
  const myDead = (session[myHpKey]||0) <= 0;
  const opDead = (session[opHpKey]||0) <= 0;
  if (myDead || opDead) {
    const winner = opDead ? player : opp;
    const loser  = opDead ? opp   : player;
    winner.pvpWins++; loser.pvpLosses++;
    updateQuestProgress(winner, "pvp_win", 1);
    const sid = Object.keys(pvpSessions).find(k => pvpSessions[k] === session);
    if (sid) delete pvpSessions[sid];
    savePlayer(player.id); savePlayer(opp.id);
    const winEmbed = new EmbedBuilder().setTitle(`🏆 ${winner.name} 승리!`).setColor(0xF5C842)
      .setDescription(`> **${winner.name}** 이(가) **${loser.name}** 을(를) 격파!\n> PvP: **${winner.pvpWins}승 ${winner.pvpLosses}패**`);
    session.log = [...(session.log||[]), ...log];
    return interaction.update({ embeds:[pvpEmbed(session,[]), winEmbed], components:[] });
  }

  // ── 쿨다운 감소 & 턴 교체
  if ((session[mySkillCdKey]||0)   > 0) session[mySkillCdKey]--;
  if ((session[myRevCdKey]||0)     > 0) session[myRevCdKey]--;
  session.turn  = isP1 ? session.p2Id : session.p1Id;
  session.round = (session.round||1) + 1;
  session.log   = [...(session.log||[]), ...log].slice(-8);

  savePlayer(player.id);
  return interaction.update({
    embeds    : [pvpEmbed(session, [])],
    components: [mkPvpButtons(session, session.turn)],
  });
}

// ════════════════════════════════════════════════════════
// ── 5. 파티 정보 임베드
// ════════════════════════════════════════════════════════
function partyInfoEmbed(party) {
  const leader = players[party.leader];
  const lines  = party.members.map((uid, i) => {
    const p = players[uid];
    if (!p) return `> ${i+1}. ❓ 알 수 없음`;
    const ch = CHARACTERS[p.active];
    const st = getPlayerStats(p);
    return `> ${uid===party.leader?"👑":"　"} **${p.name}** ${ch.emoji} \`${ch.name}\` [${ch.grade}] HP **${Math.max(0,p.hp)}**/${st.maxHp}`;
  }).join("\n");
  return new EmbedBuilder()
    .setColor(0x4ade80)
    .setTitle(`👥 파티 — ${leader?.name||"??"}의 파티`)
    .setDescription(lines || "> 없음")
    .addFields({ name:"파티 현황", value:`> ${party.members.length}/4명 | \`/파티컬링\`, \`/레이드\` 시작 가능` })
    .setFooter({ text:"파티장이 컬링/레이드 시작 | /파티초대 @유저" });
}

// ════════════════════════════════════════════════════════
// ── 6. 레이드 핸들러 & 보스 반격 (doRaidBossAttack 교체)
// ════════════════════════════════════════════════════════
async function handleRaidAction(interaction, player, raidSession, action) {
  const boss  = RAID_BOSSES[raidSession.bossId];
  const stats = getPlayerStats(player);
  const log   = [];

  if (action === "r_retreat") {
    raidSession.members = raidSession.members.filter(id => id !== player.id);
    if (raidSession.members.length === 0) {
      const sid = Object.keys(raidSessions).find(k => raidSessions[k] === raidSession);
      if (sid) delete raidSessions[sid];
    }
    savePlayer(player.id);
    return interaction.update({ content:"🏳️ 레이드에서 철수했습니다.", embeds:[], components:[] });
  }

  if (isIncapacitated(player.statusEffects))
    return interaction.reply({ content:"❌ 상태이상으로 행동 불가!", ephemeral:true });

  let dmg = 0;
  if (action === "r_attack") {
    const hit = rollHit(player.statusEffects, []);
    if (!hit) { log.push(`> ⚡ **${player.name}** 공격 빗나감!`); }
    else {
      dmg = calcDmgForPlayer(player, boss.def);
      const bf = isBlackFlash();
      if (bf) {
        dmg = Math.floor(dmg*2.5); player.crystals += 50;
        log.push(getBlackFlashArt());
        log.push(`> 💥 **${player.name}** 흑섬! **${dmg}** 피해! (×2.5) +50💎`);
      } else {
        log.push(`> ⚔️ **${player.name}** 공격! **${dmg}** 피해!`);
      }
    }
  } else if (action === "r_skill") {
    if (player.skillCooldown > 0)
      return interaction.reply({ content:`❌ 술식 쿨다운 **${player.skillCooldown}턴** 남음!`, ephemeral:true });
    const skill = getCurrentSkill(player, player.active);

    // 마허라가라 적응 체크
    if (boss.adaptationSkill && (raidSession.adaptedSkills||[]).includes(skill.name)) {
      log.push(`> 🔄 **마허라가라**가 **${skill.name}**에 적응! 피해 **무효**!`);
      log.push(`> ⚠️ 다른 술식을 사용하세요!`);
      player.skillCooldown = 5;
      tickCooldowns(player); savePlayer(player.id);
      await doRaidBossAttack(player, raidSession, boss, log);
      return interaction.update({ embeds:[raidEmbed(raidSession, log)], components:[mkRaidButtons(player)] });
    }

    dmg = calcSkillDmgForPlayer(player, skill.dmg);
    const bf = isBlackFlash();
    const fx = getSkillEffect(skill.name);
    log.push(fx.art);
    log.push(`> *"${fx.flavorText}"*`);
    if (bf) {
      dmg = Math.floor(dmg*2.5); player.crystals += 50;
      log.push(`> ⚫ **${player.name}** 흑섬! **${dmg}** 피해! (×2.5)`);
    } else {
      log.push(`> 🌀 **${player.name}**: **${skill.name}** — **${dmg}** 피해!`);
    }

    if (boss.adaptationSkill) {
      if (!raidSession.adaptedSkills) raidSession.adaptedSkills = [];
      if (!raidSession.adaptedSkills.includes(skill.name)) {
        raidSession.adaptedSkills.push(skill.name);
        log.push(`> 🔄 **마허라가라**가 **${skill.name}**에 **적응 시작!** 다음부터 무효!`);
      }
    }
    player.skillCooldown = 5;
    updateQuestProgress(player, "skill_use", 1);
  }

  raidSession.hp = Math.max(0, raidSession.hp - dmg);

  // 분노 페이즈
  if (!raidSession.enraged && raidSession.hp < boss.hp * boss.phaseHp) {
    raidSession.enraged = true;
    log.push(`\`\`\`ansi\n\u001b[1;31m⚠  분노 페이즈 돌입!!  ATK ${boss.enragedAtk} 으로 상승!  ⚠\n\`\`\``);
  }

  // 레이드 클리어
  if (raidSession.hp <= 0) {
    const drops = rollDrops(boss.dropKey);
    for (const uid of raidSession.members) {
      const p = players[uid]; if (!p) continue;
      const kb = getKoganeBonus(p);
      p.xp       += Math.floor(boss.xp * kb.xp);
      p.crystals += Math.floor(boss.crystals * kb.crystal);
      p.mastery[p.active] = (p.mastery[p.active]||0) + boss.masteryXp;
      if (boss.fingers) p.sukunaFingers = Math.min(SUKUNA_FINGER_MAX,(p.sukunaFingers||0)+boss.fingers);
      p.potion = (p.potion||0) + 3;
      addMaterials(p, drops);
      if (!p.raidClears) p.raidClears = {};
      p.raidClears[raidSession.bossId] = (p.raidClears[raidSession.bossId]||0) + 1;
      updateQuestProgress(p, "boss_kill", 1);
      savePlayer(uid);
    }
    const sid = Object.keys(raidSessions).find(k => raidSessions[k] === raidSession);
    if (sid) delete raidSessions[sid];
    return interaction.update({
      embeds:[new EmbedBuilder().setTitle("🏆 레이드 클리어!").setColor(0xF5C842)
        .setDescription([
          "```ansi\n\u001b[1;33m╔══════════════════════════════╗\n║  🏆  RAID  CLEAR!!  🏆       ║\n╚══════════════════════════════╝\n```",
          `> **${boss.name}** 격파!`,
          `> +${boss.xp}XP · +${boss.crystals}💎 · +${boss.masteryXp}숙련 · 🧪회복약+3`,
          boss.fingers ? `> 👹 스쿠나 손가락 +${boss.fingers}개!` : "",
          `> 📦 재료: ${formatDrops(drops)}`,
        ].filter(Boolean).join("\n"))],
      components:[],
    });
  }

  // 보스 반격
  await doRaidBossAttack(player, raidSession, boss, log);
  if (player.hp <= 0) {
    raidSession.members = raidSession.members.filter(id => id !== player.id);
    log.push(`> 💀 **${player.name}** 전투 불능! 레이드 이탈.`);
    if (raidSession.members.length === 0) {
      const sid = Object.keys(raidSessions).find(k => raidSessions[k] === raidSession);
      if (sid) delete raidSessions[sid];
      savePlayer(player.id);
      return interaction.update({
        embeds:[new EmbedBuilder().setTitle("💀 레이드 실패").setColor(0xe63946)
          .setDescription("> 파티원 전원 전투 불능...")],
        components:[],
      });
    }
  }
  tickCooldowns(player); savePlayer(player.id);
  return interaction.update({ embeds:[raidEmbed(raidSession, log)], components:[mkRaidButtons(player)] });
}

async function doRaidBossAttack(player, raidSession, boss, log) {
  const stats   = getPlayerStats(player);
  const bossAtk = raidSession.enraged ? boss.enragedAtk : boss.atk;
  const dmg     = calcDmg(bossAtk, stats.def);
  player.hp = Math.max(0, player.hp - dmg);
  log.push(`> 💢 **${boss.name}** 반격! **${dmg}** 피해!`);
  if (boss.statusAttack && Math.random() < (boss.statusAttack.chance||0.3)) {
    applyStatus(player, boss.statusAttack.statusId);
    const sdef = STATUS_EFFECTS[boss.statusAttack.statusId];
    log.push(`> ${sdef.emoji} **${sdef.name}** 상태이상! (${sdef.duration}턴)`);
  }
  if (boss.specialAttack && Math.random() < 0.30) {
    const spDmg = boss.specialAttack.dmg;
    player.hp = Math.max(0, player.hp - spDmg);
    applyStatus(player, boss.specialAttack.statusId);
    const sdef = STATUS_EFFECTS[boss.specialAttack.statusId];
    log.push(`> 🔥 **[특수기] ${boss.specialAttack.name}** — **${spDmg}** 추가 피해! ${sdef.emoji} 상태이상!`);
  }
}

// ════════════════════════════════════════════════════════
// ── 7. interactionCreate (단일 등록 — Part1 핸들러 완전 교체)
// ════════════════════════════════════════════════════════
client.removeAllListeners("interactionCreate"); // Part1 핸들러 제거

client.on("interactionCreate", async (interaction) => {

  // ── Select Menu
  if (interaction.isStringSelectMenu()) {
    const userId = interaction.user.id;
    const player = getPlayer(userId, interaction.user.username);
    if (interaction.customId === "char_select" || interaction.customId === "char_select_battle") {
      const charId = interaction.values[0];
      if (!player.owned.includes(charId))
        return interaction.reply({ content:"❌ 미보유 캐릭터!", ephemeral:true });
      player.active = charId;
      const stats = getPlayerStats(player);
      player.hp   = stats.maxHp;
      savePlayer(userId);
      const ch = CHARACTERS[charId];
      const ri = GACHA_RARITY[ch.grade] || GACHA_RARITY["3급"];
      return interaction.update({
        content: null,
        embeds:[new EmbedBuilder()
          .setColor(ri.color)
          .setTitle(`${ch.emoji} ${ch.name} [${ch.grade}] 활성화!`)
          .setDescription([
            `> ${ri.stars} ${ri.effect}`,
            `> *"${ch.lore||ch.desc}"*`,
            `> 💚 HP 완전 회복: **${stats.maxHp}**`,
            `> 🌀 현재 스킬: **${getCurrentSkill(player,charId).name}**`,
            `> 🌌 영역전개: \`${ch.domain||"없음"}\``,
          ].join("\n"))],
        components:[],
      });
    }
  }

  // ── Button
  if (interaction.isButton()) {
    const userId   = interaction.user.id;
    const player   = getPlayer(userId, interaction.user.username);
    const { customId } = interaction;

    // 일반 전투 버튼 (b_)
    if (customId.startsWith("b_")) {
      const battle = battles[userId];
      if (!battle) return interaction.reply({ content:"❌ 진행 중인 전투 없음!", ephemeral:true });
      return handleBattleAction(interaction, player, battle, customId);
    }

    // 컬링 버튼 (c_)
    if (customId.startsWith("c_")) {
      const culling = cullings[userId];
      if (!culling) return interaction.reply({ content:"❌ 진행 중인 컬링 없음!", ephemeral:true });
      return handleCullingAction(interaction, player, culling, customId);
    }

    // 사멸회유 버튼 (j_)
    if (customId.startsWith("j_")) {
      const jujutsu = jujutsus[userId];
      if (!jujutsu) return interaction.reply({ content:"❌ 진행 중인 사멸회유 없음!", ephemeral:true });
      if (customId === "j_escape") {
        if (jujutsu.points > (player.jujutsuBest||0)) player.jujutsuBest = jujutsu.points;
        delete jujutsus[userId]; savePlayer(userId);
        return interaction.update({ content:`🏳 사멸회유 종료! 최고 기록: **${player.jujutsuBest}pt**`, embeds:[], components:[] });
      }
      if (customId.startsWith("j_choice_")) {
        const idx = parseInt(customId.split("_")[2]);
        if (jujutsu.choices?.[idx]) {
          jujutsu.currentEnemy = JSON.parse(JSON.stringify(jujutsu.choices[idx]));
          jujutsu.enemyHp      = jujutsu.currentEnemy.hp;
          jujutsu.choices      = null;
          return interaction.update({ embeds:[jujutsuEmbed(player, jujutsu)], components:[mkJujutsuButtons(player, [])[0]] });
        }
        return interaction.reply({ content:"❌ 잘못된 선택", ephemeral:true });
      }
      return handleJujutsuAction(interaction, player, jujutsu, customId);
    }

    // PvP 도전 수락/거절 버튼 (pvp_challenge_)
    if (customId.startsWith("pvp_challenge_")) {
      // 형식: pvp_challenge_accept_{challengerId}  또는  pvp_challenge_decline_{challengerId}
      const withoutPrefix = customId.slice("pvp_challenge_".length); // "accept_12345" 또는 "decline_12345"
      const underIdx      = withoutPrefix.indexOf("_");
      const act           = withoutPrefix.slice(0, underIdx);          // "accept" or "decline"
      const challengerId  = withoutPrefix.slice(underIdx + 1);         // "12345"

      if (act === "accept") {
        if (userId !== pvpChallenges[challengerId]?.target)
          return interaction.reply({ content:"❌ 당신에게 온 도전이 아닙니다!", ephemeral:true });
        if (getPvpSessionByUser(challengerId) || getPvpSessionByUser(userId))
          return interaction.reply({ content:"❌ 이미 PvP 진행 중!", ephemeral:true });
        const p1 = players[challengerId], p2 = players[userId];
        if (!p1||!p2) return interaction.reply({ content:"❌ 플레이어 정보 없음!", ephemeral:true });
        const session = createPvpSession(challengerId, userId);
        pvpSessions[session.id] = session;
        delete pvpChallenges[challengerId];
        const ch1 = CHARACTERS[p1.active], ch2 = CHARACTERS[p2.active];
        const startEmbed = new EmbedBuilder().setColor(0xF5C842).setTitle("⚔️ PvP 결투 시작!")
          .setDescription([
            "```ansi\n\u001b[1;33m╔══════════════════════════════════╗\n║  ⚔️  PvP BATTLE START!  ⚔️        ║\n╚══════════════════════════════════╝\n```",
            `> ${ch1.emoji} **${ch1.name}** \`[${ch1.grade}]\` HP **${session.maxHp1}** ATK **${getPlayerStats(p1).atk}**`,
            `> VS`,
            `> ${ch2.emoji} **${ch2.name}** \`[${ch2.grade}]\` HP **${session.maxHp2}** ATK **${getPlayerStats(p2).atk}**`,
            `> \n> 먼저 행동: **${p1.name}**`,
          ].join("\n"));
        return interaction.update({
          embeds    : [startEmbed, pvpEmbed(session)],
          components: [mkPvpButtons(session, challengerId)],
        });
      } else {
        delete pvpChallenges[challengerId];
        return interaction.update({ content:"❌ 결투 거절됨.", embeds:[], components:[] });
      }
    }

    // PvP 전투 액션 버튼 (pvp_atk, pvp_skill, pvp_domain, pvp_reverse, pvp_surrender)
    if (customId.startsWith("pvp_")) {
      const session = getPvpSessionByUser(userId);
      if (!session) return interaction.reply({ content:"❌ 진행 중인 PvP 없음!", ephemeral:true });
      if (session.turn !== userId) return interaction.reply({ content:"⏳ **당신의 턴이 아닙니다!**", ephemeral:true });
      return handlePvpAction(interaction, player, session, customId);
    }

    // 레이드 버튼 (r_)
    if (customId.startsWith("r_")) {
      const raidSession = getRaidByUser(userId);
      if (!raidSession) return interaction.reply({ content:"❌ 진행 중인 레이드 없음!", ephemeral:true });
      if (player.hp <= 0) return interaction.reply({ content:"💀 전투 불능! `/회복` 또는 `!회복`으로 회복하세요.", ephemeral:true });
      return handleRaidAction(interaction, player, raidSession, customId);
    }

    // 파티 컬링 버튼 (pc_)
    if (customId.startsWith("pc_")) {
      const party = getParty(userId);
      if (!party) return interaction.reply({ content:"❌ 파티 없음!", ephemeral:true });
      const session = cullings[party.id];
      if (!session) return interaction.reply({ content:"❌ 진행 중인 파티 컬링 없음!", ephemeral:true });
      if (player.hp <= 0) return interaction.reply({ content:"💀 전투 불능!", ephemeral:true });
      return handlePartyCullingAction(interaction, player, session, customId);
    }

    // 파티 초대 수락/거절 (party_invite_)
    if (customId.startsWith("party_invite_")) {
      // 형식: party_invite_accept_{partyId}_{targetId}  또는  party_invite_decline_...
      const parts    = customId.split("_");
      // party(0) invite(1) act(2) partyId(3) targetId(4)
      const act      = parts[2];
      const partyId  = parts[3];
      const targetId = parts[4];
      if (userId !== targetId)
        return interaction.reply({ content:"❌ 당신에게 온 초대가 아닙니다!", ephemeral:true });
      const invite = partyInvites[targetId];
      if (!invite || invite.partyId !== partyId)
        return interaction.reply({ content:"❌ 만료된 초대!", ephemeral:true });
      if (act === "accept") {
        const party = parties[partyId];
        if (!party) return interaction.reply({ content:"❌ 파티가 해체됨!", ephemeral:true });
        if (party.members.length >= 4) return interaction.reply({ content:"❌ 파티 가득참! (4명 한도)", ephemeral:true });
        if (getPartyId(targetId)) return interaction.reply({ content:"❌ 이미 다른 파티 소속!", ephemeral:true });
        party.members.push(targetId);
        delete partyInvites[targetId];
        return interaction.update({ embeds:[partyInfoEmbed(party)], components:[] });
      } else {
        delete partyInvites[targetId];
        return interaction.update({ content:"❌ 파티 초대 거절.", embeds:[], components:[] });
      }
    }
  }

  // ── Slash Command
  if (interaction.isChatInputCommand()) {
    const { commandName, user } = interaction;
    const userId = user.id;
    const player = getPlayer(userId, user.username);
    await handleSlashCommand(interaction, commandName, player, userId, user);
  }
});

// ════════════════════════════════════════════════════════
// ── 8. 슬래시 커맨드 핸들러 (단일 정의)
// ════════════════════════════════════════════════════════
async function handleSlashCommand(interaction, commandName, player, userId, user) {

  if (commandName === "프로필") {
    return interaction.reply({ embeds:[profileEmbed(player)] });
  }

  if (commandName === "전투") {
    if (battles[userId]) return interaction.reply({ content:"❌ 이미 전투 중!", ephemeral:true });
    const roll = Math.random();
    let eBase;
    if      (roll < 0.05) eBase = ENEMIES.find(e => e.id === "e_sukuna");
    else if (roll < 0.45) eBase = ENEMIES.find(e => e.id === "e1");
    else if (roll < 0.78) eBase = ENEMIES.find(e => e.id === "e2");
    else if (roll < 0.95) eBase = ENEMIES.find(e => e.id === "e3");
    else                  eBase = ENEMIES.find(e => e.id === "e4");

    const enemy = { ...eBase, currentHp: eBase.hp, statusEffects: [] };
    battles[userId] = { enemy };
    const stats = getPlayerStats(player);

    const isSukuna = eBase.isSukuna || eBase.id === "e_sukuna";
    let desc = "";
    if (isSukuna) {
      desc = "```ansi\n\u001b[1;31m╔══════════════════════════════════════╗\n║  🔴  料理面宿儺 — 저주의 왕 출현!  🔴  ║\n╚══════════════════════════════════════╝\n```";
    }

    const startEmbed = new EmbedBuilder()
      .setTitle(isSukuna ? "🔴 료멘 스쿠나 출현!" : `⚔️ ${enemy.emoji} ${enemy.name} 출현!`)
      .setColor(isSukuna ? 0x8b0000 : 0xff4444)
      .setDescription([
        desc,
        `> 💚 HP **${enemy.hp}** · 🗡️ ATK **${enemy.atk}** · 🛡️ DEF **${enemy.def}**`,
        `> \n> ${CHARACTERS[player.active].emoji} **${player.name}** HP **${player.hp}**/**${stats.maxHp}** · 🧪 **${player.potion}개**`,
      ].filter(Boolean).join("\n"))
      .addFields({
        name:"⚡ 현재 스킬",
        value:`> \`${getCurrentSkill(player,player.active).name}\` (숙련 ${getMastery(player,player.active)}) · 쿨다운: ${player.skillCooldown>0?`**${player.skillCooldown}턴**`:"**✅ 사용 가능**"}`,
      })
      .setFooter({ text:"흑섬 10% 확률 | 술식 5턴 쿨다운 | 영역전개: /전투 중 없음 (PvP 전용)" });

    return interaction.reply({ embeds:[startEmbed], components:[mkBattleButtons(player)] });
  }

  if (commandName === "술식") return interaction.reply({ embeds:[buildSkillEmbed(player)] });

  if (commandName === "가챠") {
    const count = interaction.options.getInteger("횟수");
    if (count!==1 && count!==10) return interaction.reply({ content:"❌ 1 또는 10만 가능!", ephemeral:true });
    const cost = count === 1 ? 150 : 1350;
    if (player.crystals < cost) return interaction.reply({ content:`💎 크리스탈 부족! (필요: **${cost}**)`, ephemeral:true });
    player.crystals -= cost;
    updateQuestProgress(player, "gacha_pull", 1);

    await interaction.reply({ embeds:[gachaLoadingEmbed(1)] });
    await new Promise(r => setTimeout(r, 2000));
    await interaction.editReply({ embeds:[gachaLoadingEmbed(2)] });
    await new Promise(r => setTimeout(r, 2000));

    if (count === 1) {
      const result = rollGacha(1)[0];
      const isNew  = !player.owned.includes(result);
      if (isNew) { player.owned.push(result); if (!player.mastery[result]) player.mastery[result] = 0; }
      else player.crystals += 50;
      await interaction.editReply({ embeds:[gachaRevealEmbed(CHARACTERS[result].grade), gachaResultEmbed(result, isNew, player)] });
    } else {
      const results     = rollGacha(10);
      const dupCrystals = results.filter(id => player.owned.includes(id)).length * 50;
      const newOnes     = results.filter(id => !player.owned.includes(id));
      for (const id of newOnes) { player.owned.push(id); if (!player.mastery[id]) player.mastery[id] = 0; }
      player.crystals += dupCrystals;
      await interaction.editReply({ embeds:[gacha10ResultEmbed(results, newOnes, dupCrystals, player)] });
    }
    savePlayer(userId);
  }

  if (commandName === "활성") {
    if (!player.owned.length) return interaction.reply({ content:"❌ 보유 캐릭터 없음!", ephemeral:true });
    const ownedDesc = player.owned.map(id => {
      const ch = CHARACTERS[id];
      const ri = GACHA_RARITY[ch.grade]||GACHA_RARITY["3급"];
      const st = getPlayerStats({ ...player, active:id });
      const fn = id==="sukuna" ? ` 🖕${player.sukunaFingers||0}개` : "";
      return `> ${id===player.active?"▶️**[활성]** ":"　　"}${ch.emoji} **${ch.name}** \`[${ch.grade}]\` ${ri.stars}  ATK\`${st.atk}\` HP\`${st.maxHp}\`${fn}`;
    }).join("\n");
    return interaction.reply({
      embeds:[new EmbedBuilder().setColor(0x7C5CFC).setTitle("🎭 캐릭터 선택")
        .setDescription(ownedDesc)
        .setFooter({ text:"아래 메뉴에서 캐릭터를 선택하세요!" })],
      components:[mkCharSelectMenu(player, "char_select")],
    });
  }

  if (commandName === "출석") {
    const now = Date.now();
    if (now - (player.lastDaily||0) < 86400000) {
      const h = Math.ceil((86400000-(now-player.lastDaily))/3600000);
      return interaction.reply({ content:`⏰ **${h}시간** 후 가능`, ephemeral:true });
    }
    const streak = Math.min(player.dailyStreak||0, 30);
    const cr     = 100 + streak*5;
    player.crystals += cr; player.lastDaily = now; player.dailyStreak = (player.dailyStreak||0)+1;
    savePlayer(userId);
    return interaction.reply({ embeds:[new EmbedBuilder().setColor(0xF5C842).setTitle("✅ 출석 체크!")
      .setDescription(`> 💎 **+${cr}** 크리스탈!\n> 🔥 연속 **${player.dailyStreak}일** 출석\n> 현재 크리스탈: **${player.crystals}**`)] });
  }

  if (commandName === "회복") {
    if ((player.potion||0) <= 0)
      return interaction.reply({ content:"❌ 회복약 없음!\n> 전투 승리 시 드롭됩니다.", ephemeral:true });
    const stats = getPlayerStats(player);
    player.hp = stats.maxHp; player.potion--;
    savePlayer(userId);
    return interaction.reply({ embeds:[new EmbedBuilder().setColor(0x4ade80).setTitle("🧪 회복 완료!")
      .setDescription(`> 💚 HP **${stats.maxHp}** 완전 회복!\n> 남은 회복약: **${player.potion}개**`)] });
  }

  if (commandName === "코가네가챠") {
    if (player.crystals < 200) return interaction.reply({ content:"💎 부족! 필요: **200**", ephemeral:true });
    player.crystals -= 200;
    player.koganeGachaCount = (player.koganeGachaCount||0)+1;
    const grade = rollKogane();
    const gradeOrder = ["3급","2급","1급","특급","전설"];
    const isUpgrade  = !player.kogane || gradeOrder.indexOf(grade) > gradeOrder.indexOf(player.kogane.grade);
    if (isUpgrade) player.kogane = { grade };
    else player.crystals += 50;
    savePlayer(userId);
    const kg = KOGANE_GRADES[grade];
    return interaction.reply({ embeds:[new EmbedBuilder().setColor(kg.color)
      .setTitle(`🐾 코가네 소환! [${grade}] ${kg.emoji} ${kg.stars}`)
      .setDescription([
        isUpgrade ? `> ✨ **등급 상승!** → \`[${grade}]\`` : `> 🔄 중복 — +50💎 환급`,
        `> **패시브:** ${kg.passiveDesc}`,
        `> **스킬:** ${kg.skill} — ${kg.skillDesc}`,
        `> 총 소환: **${player.koganeGachaCount}회**`,
      ].join("\n"))] });
  }

  if (commandName === "코가네") return interaction.reply({ embeds:[koganeProfileEmbed(player)] });

  if (commandName === "손가락") {
    const fingers = player.sukunaFingers || 0;
    const fb  = getFingerBonus(fingers);
    const bar = "█".repeat(fingers) + "░".repeat(SUKUNA_FINGER_MAX - fingers);
    return interaction.reply({ embeds:[new EmbedBuilder().setColor(0x8b0000).setTitle("👹 스쿠나 손가락")
      .setDescription([
        `\`\`\`\n[${bar}]\n${fingers} / ${SUKUNA_FINGER_MAX} 개\n\`\`\``,
        `> **${fb.label}**`,
        `> 🗡️ ATK +${fb.atkBonus} · 🛡️ DEF +${fb.defBonus} · 💚 HP +${fb.hpBonus} · 💥 DMG ×${fb.dmgMult.toFixed(2)}`,
        fingers === 0
          ? `> 💡 전투에서 스쿠나를 처치하면 손가락 획득!\n> 손가락 **1개**로 스쿠나 즉시 해금!`
          : player.owned.includes("sukuna")
            ? `> 🔴 스쿠나 해금됨 — \`/활성\` 으로 선택!`
            : "",
      ].filter(Boolean).join("\n"))] });
  }

  if (commandName === "컬링") {
    if (cullings[userId]) return interaction.reply({ content:"🌊 이미 컬링 중!", ephemeral:true });
    const first = pickCullingEnemy(1);
    cullings[userId] = { wave:1, kills:0, totalXp:0, totalCrystals:0, currentEnemy:first, enemyHp:first.hp };
    return interaction.reply({ embeds:[cullingEmbed(player, cullings[userId])], components:[mkCullingButtons(player)] });
  }

  if (commandName === "사멸회유") {
    if (jujutsus[userId]) return interaction.reply({ content:"🎯 이미 사멸회유 중!", ephemeral:true });
    const choices = generateJujutsuChoices(1);
    jujutsus[userId] = { wave:1, points:0, totalXp:0, totalCrystals:0, choices, currentEnemy:null, enemyHp:0 };
    return interaction.reply({ embeds:[jujutsuEmbed(player, jujutsus[userId], [], choices)], components:mkJujutsuButtons(player, choices) });
  }

  if (commandName === "결투") {
    const target = interaction.options.getUser("대상");
    if (target.id === userId) return interaction.reply({ content:"❌ 자신과 결투 불가!", ephemeral:true });
    if (getPvpSessionByUser(userId)) return interaction.reply({ content:"❌ 이미 PvP 진행 중!", ephemeral:true });
    if (getPvpSessionByUser(target.id)) return interaction.reply({ content:"❌ 상대방 PvP 중!", ephemeral:true });
    if (!players[target.id]) return interaction.reply({ content:"❌ 상대방이 아직 게임을 시작하지 않았습니다!", ephemeral:true });

    pvpChallenges[userId] = { target: target.id };
    const p2  = players[target.id];
    const ch1 = CHARACTERS[player.active], ch2 = CHARACTERS[p2.active];
    const s1  = getPlayerStats(player), s2  = getPlayerStats(p2);

    const embed = new EmbedBuilder().setColor(0xF5C842).setTitle("⚔️ PvP 결투 신청!")
      .setDescription([
        `${target}, **${user.username}** 님이 결투를 신청했습니다!`,
        `> ${ch1.emoji} **${ch1.name}** \`[${ch1.grade}]\` — HP **${s1.maxHp}** ATK **${s1.atk}**`,
        `> VS`,
        `> ${ch2.emoji} **${ch2.name}** \`[${ch2.grade}]\` — HP **${s2.maxHp}** ATK **${s2.atk}**`,
      ].join("\n")).setFooter({ text:"30초 내 수락/거절" });

    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`pvp_challenge_accept_${userId}`).setLabel("✅ 수락").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`pvp_challenge_decline_${userId}`).setLabel("❌ 거절").setStyle(ButtonStyle.Danger),
    );
    await interaction.reply({ content:`${target}`, embeds:[embed], components:[buttons] });
    setTimeout(() => { if (pvpChallenges[userId]) delete pvpChallenges[userId]; }, 30000);
  }

  if (commandName === "파티생성") {
    if (getPartyId(userId)) return interaction.reply({ content:"❌ 이미 파티 소속!", ephemeral:true });
    const partyId = `party_${Date.now()}`;
    parties[partyId] = { id:partyId, leader:userId, members:[userId] };
    return interaction.reply({ embeds:[partyInfoEmbed(parties[partyId])] });
  }

  if (commandName === "파티초대") {
    const target = interaction.options.getUser("대상");
    const party  = getParty(userId);
    if (!party) return interaction.reply({ content:"❌ 파티 없음! `/파티생성`으로 생성하세요.", ephemeral:true });
    if (party.leader !== userId) return interaction.reply({ content:"❌ 파티장만 초대 가능!", ephemeral:true });
    if (party.members.length >= 4) return interaction.reply({ content:"❌ 파티 가득참! (최대 4명)", ephemeral:true });
    if (getPartyId(target.id)) return interaction.reply({ content:"❌ 상대방이 이미 파티 소속!", ephemeral:true });

    partyInvites[target.id] = { partyId:party.id, inviter:userId };
    const embed = new EmbedBuilder().setColor(0x4ade80).setTitle("👥 파티 초대")
      .setDescription([
        `${target}, **${user.username}** 님의 파티에 초대받았습니다!`,
        `> 현재 파티원: **${party.members.length}/4명**`,
        `> 파티장: **${players[party.leader]?.name||"??"}**`,
      ].join("\n")).setFooter({ text:"60초 내 수락/거절" });
    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`party_invite_accept_${party.id}_${target.id}`).setLabel("✅ 수락").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`party_invite_decline_${party.id}_${target.id}`).setLabel("❌ 거절").setStyle(ButtonStyle.Danger),
    );
    await interaction.reply({ content:`${target}`, embeds:[embed], components:[buttons] });
    setTimeout(() => { if (partyInvites[target.id]) delete partyInvites[target.id]; }, 60000);
  }

  if (commandName === "파티나가기") {
    const party = getParty(userId);
    if (!party) return interaction.reply({ content:"❌ 파티 없음!", ephemeral:true });
    const isLeader = party.leader === userId;
    party.members  = party.members.filter(id => id !== userId);
    if (!party.members.length) { delete parties[party.id]; return interaction.reply({ content:"✅ 파티 탈퇴 (파티 해체됨)" }); }
    if (isLeader) party.leader = party.members[0];
    return interaction.reply({ embeds:[partyInfoEmbed(party)] });
  }

  if (commandName === "파티정보") {
    const party = getParty(userId);
    if (!party) return interaction.reply({ content:"❌ 파티에 소속되어 있지 않습니다!", ephemeral:true });
    return interaction.reply({ embeds:[partyInfoEmbed(party)] });
  }

  if (commandName === "파티컬링") {
    const party = getParty(userId);
    if (!party) return interaction.reply({ content:"❌ 파티 없음!", ephemeral:true });
    if (party.leader !== userId) return interaction.reply({ content:"❌ 파티장만 시작!", ephemeral:true });
    if (cullings[party.id]) return interaction.reply({ content:"🌊 이미 파티 컬링 중!", ephemeral:true });
    const first = pickCullingEnemy(1);
    cullings[party.id] = { wave:1, kills:0, totalXp:0, totalCrystals:0, currentEnemy:first, enemyHp:first.hp };
    return interaction.reply({ embeds:[partyCullingEmbed(party, cullings[party.id])], components:[mkCullingButtons(player)] });
  }

  if (commandName === "레이드") {
    const bossId = interaction.options.getString("보스").toLowerCase();
    if (!RAID_BOSSES[bossId]) return interaction.reply({
      content:"❌ 보스 없음!\n> `heian_sukuna` (헤이안 스쿠나)\n> `mahoraga` (마허라가라)",
      ephemeral:true,
    });
    if (getRaidByUser(userId)) return interaction.reply({ content:"❌ 이미 레이드 진행 중!", ephemeral:true });
    const party   = getParty(userId);
    const members = party ? [...party.members] : [userId];
    const boss    = RAID_BOSSES[bossId];
    const raidId  = `raid_${Date.now()}`;

    raidSessions[raidId] = { id:raidId, bossId, hp:boss.hp, enraged:false, members:[...members], adaptedSkills:[] };
    for (const uid of members) {
      const p = players[uid];
      if (p && p.hp <= 0) { const st = getPlayerStats(p); p.hp = Math.floor(st.maxHp*0.5); savePlayer(uid); }
    }

    const memberLines = members.map(uid => {
      const p = players[uid]; if (!p) return "> ❓";
      const ch = CHARACTERS[p.active], st = getPlayerStats(p);
      return `> ${ch.emoji} **${p.name}** \`${ch.name}\` HP ${Math.max(0,p.hp)}/${st.maxHp}`;
    }).join("\n");

    const introEmbed = new EmbedBuilder().setColor(boss.color)
      .setTitle(`⚔️ 레이드 시작: ${boss.name}`)
      .setDescription([
        "```ansi\n\u001b[1;31m╔══════════════════════════════════╗\n║  ⚔️  RAID BATTLE START!  ⚔️       ║\n╚══════════════════════════════════╝\n```",
        `> *"${boss.lore}"*`,
        `> 💚 HP **${boss.hp}** · 🗡️ ATK **${boss.atk}** · 🛡️ DEF **${boss.def}**`,
        bossId==="mahoraga" ? `> ⚠️ **마허라가라**: 맞은 술식에 적응 → 다음부터 **무효화!**` : "",
        bossId==="heian_sukuna" ? `> ⚠️ **헤이안 스쿠나**: HP ${boss.phaseHp*100}% 이하 → **분노 페이즈** (ATK ${boss.enragedAtk})` : "",
      ].filter(Boolean).join("\n"))
      .addFields({ name:`👥 참여 (${members.length}명)`, value: memberLines });

    return interaction.reply({ embeds:[introEmbed, raidEmbed(raidSessions[raidId])], components:[mkRaidButtons(player)] });
  }

  if (commandName === "코드") {
    const code  = interaction.options.getString("코드").toLowerCase();
    if (player.usedCodes.includes(code)) return interaction.reply({ content:"❌ 이미 사용한 코드!", ephemeral:true });
    const CODES = { "release":{ crystals:200 }, "sorryforbugs":{ crystals:1000 } };
    if (!CODES[code]) return interaction.reply({ content:"❌ 유효하지 않은 코드!", ephemeral:true });
    player.crystals += (CODES[code].crystals||0);
    player.usedCodes.push(code);
    savePlayer(userId);
    return interaction.reply({ content:`✅ 코드 적용! +**${CODES[code].crystals||0}**💎` });
  }

  if (commandName === "퀘스트") return interaction.reply({ embeds:[questEmbed(player)] });

  // ── 퀘보상 (버그 수정: 핸들러 추가)
  if (commandName === "퀘보상") {
    const type = interaction.options.getString("종류"); // "일일" or "주간"
    const num  = interaction.options.getInteger("번호") - 1;
    const isW  = type === "주간";
    initQuests(player);
    const list = isW ? player.quests?.weekly : player.quests?.daily;
    const qid  = list?.[num]?.id;
    if (!qid) return interaction.reply({ content:"❌ 잘못된 번호!", ephemeral:true });
    const reward = claimQuestReward(player, qid, isW);
    if (!reward) return interaction.reply({ content:"❌ 수령 불가! (미완료 또는 이미 수령)", ephemeral:true });
    savePlayer(userId);
    const matStr = reward.materials
      ? Object.entries(reward.materials).map(([m,q])=>`${MATERIALS[m]?.emoji||""}×${q}`).join(" ")
      : "";
    return interaction.reply({ embeds:[new EmbedBuilder().setColor(0xF5C842).setTitle("🎁 퀘스트 보상 수령!")
      .setDescription(`> +**${reward.crystals||0}**💎 · +**${reward.xp||0}**XP ${matStr}\n> 현재: **${player.crystals}**💎`)] });
  }

  if (commandName === "재료")    return interaction.reply({ embeds:[materialsEmbed(player)] });
  if (commandName === "주구목록") return interaction.reply({ embeds:[weaponListEmbed(player)] });

  if (commandName === "주구제작") {
    const wid = interaction.options.getString("이름").toLowerCase().replace(/ /g,"_");
    const w   = WEAPONS[wid];
    if (!w) return interaction.reply({ content:`❌ 없는 주구! 가능: ${Object.keys(WEAPONS).join(", ")}`, ephemeral:true });
    if ((player.craftedWeapons||[]).includes(wid)) return interaction.reply({ content:"❌ 이미 제작한 주구!", ephemeral:true });
    const mats = player.materials||{};
    for (const [mat,qty] of Object.entries(w.recipe)) {
      if ((mats[mat]||0) < qty) {
        const m = MATERIALS[mat];
        return interaction.reply({ content:`❌ 재료 부족! ${m.emoji}**${m.name}** ${mats[mat]||0}/${qty}`, ephemeral:true });
      }
    }
    for (const [mat,qty] of Object.entries(w.recipe)) mats[mat] -= qty;
    if (!player.craftedWeapons) player.craftedWeapons = [];
    player.craftedWeapons.push(wid);
    updateQuestProgress(player, "weapon_craft", 1);
    savePlayer(userId);
    return interaction.reply({ embeds:[new EmbedBuilder().setColor(w.color)
      .setTitle(`${w.emoji} ${w.name} 제작 완료!`)
      .setDescription([`> 등급: **${w.grade}**`, `> ATK+${w.atkBonus} DEF+${w.defBonus} HP+${w.hpBonus}`, `> ${w.desc}`, `> \`/장착\` 으로 장착하세요!`].join("\n"))] });
  }

  if (commandName === "장착") {
    const wid = interaction.options.getString("이름").toLowerCase().replace(/ /g,"_");
    if (!(player.craftedWeapons||[]).includes(wid)) return interaction.reply({ content:"❌ 제작하지 않은 주구!", ephemeral:true });
    player.equippedWeapon = wid;
    const w = WEAPONS[wid];
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
    return interaction.reply({ embeds:[new EmbedBuilder().setColor(0xF5C842).setTitle("🔱 주술회전 RPG — 명령어 목록")
      .setDescription([
        "**⚔️ 전투**",
        "> `/전투` `!전투` — 일반 전투 (5% 스쿠나 등장!)",
        "> `/컬링` `!컬링` — 웨이브 컬링",
        "> `/사멸회유` `!사멸회유` — 포인트 수집",
        "> `/결투 @유저` `!결투 @유저` — PvP",
        "",
        "**🔥 레이드**",
        "> `/레이드 heian_sukuna` — 헤이안 스쿠나 (2배 강함)",
        "> `/레이드 mahoraga` — 마허라가라 (술식 적응)",
        "",
        "**🎭 캐릭터**",
        "> `/활성` `!활성` — 캐릭터 선택 (이름으로 표시)",
        "> `/가챠 1|10` `!가챠 1|10` — 소환 (150/1350💎)",
        "> `/손가락` `!손가락` — 스쿠나 손가락",
        "",
        "**👥 파티**",
        "> `/파티생성` `/파티초대 @유저` `/파티나가기` `/파티정보` `/파티컬링`",
        "",
        "**⚔️ 주구**",
        "> `/재료` `/주구목록` `/주구제작 [ID]` `/장착 [ID]` `/해제`",
        "",
        "**📋 기타**",
        "> `/프로필` `/술식` `/출석` `/회복` `/퀘스트` `/퀘보상` `/코가네가챠` `/코드`",
        "",
        "**⭐ 특수 기믹**",
        "> ⚫ 흑섬: **10%** 확률 → 피해 **×2.5** +50💎",
        "> 👹 스쿠나: 전투 처치 시 손가락 획득 → **1개**로 즉시 해금!",
        "> 🧪 회복약: 전투 승리 시 **22~100%** 확률 드롭!",
        "> 🌌 영역전개: **PvP 전용** 1회 한정 강력 기술!",
        "> 🔄 마허라가라: 맞은 술식 **다음 턴부터 면역**!",
      ].join("\n")).setFooter({ text:"🔱 주술회전 RPG | 저주 에너지를 최대로!" })] });
  }
}

// ════════════════════════════════════════════════════════
// ── 9. !명령어 핸들러 (messageCreate — 단일 등록)
// ════════════════════════════════════════════════════════
client.removeAllListeners("messageCreate"); // Part1 핸들러 제거

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith("!")) return;

  const args   = message.content.slice(1).trim().split(/\s+/);
  const cmd    = args[0].toLowerCase();
  const userId = message.author.id;
  const player = getPlayer(userId, message.author.username);
  const reply  = (opts) => typeof opts === "string" ? message.reply({ content:opts }) : message.reply(opts);

  // ── 개발자 전용
  if (cmd === "주는" && isDev(userId)) {
    const target = message.mentions.users.first();
    const amount = parseInt(args[2]) || 0;
    const type   = args[3] || "crystals";
    const tp     = target ? getPlayer(target.id, target.username) : player;
    if      (type==="crystals"||type==="💎") tp.crystals += amount;
    else if (type==="hp")     { const st=getPlayerStats(tp); tp.hp = Math.min(tp.hp+amount, st.maxHp); }
    else if (type==="xp")     { tp.xp += amount; }
    else if (type==="손가락") {
      tp.sukunaFingers = Math.min(SUKUNA_FINGER_MAX,(tp.sukunaFingers||0)+amount);
      if (tp.sukunaFingers>=1 && !tp.owned.includes("sukuna")) { tp.owned.push("sukuna"); if (!tp.mastery["sukuna"]) tp.mastery["sukuna"]=0; }
    }
    else if (type==="포션"||type==="회복약") tp.potion = (tp.potion||0)+amount;
    savePlayer(tp.id);
    return reply(`✅ **${tp.name}** 에게 ${amount} ${type} 지급!`);
  }
  if (cmd === "디버그" && isDev(userId)) {
    return reply(`플레이어: ${Object.keys(players).length}명\n전투: ${Object.keys(battles).length} | 컬링: ${Object.keys(cullings).length} | PvP: ${Object.keys(pvpSessions).length} | 레이드: ${Object.keys(raidSessions).length}`);
  }
  if (cmd === "퀘초기화" && isDev(userId)) {
    player.quests = {}; savePlayer(userId);
    return reply("✅ 퀘스트 초기화됨");
  }

  // ── 일반 명령어 별칭 매핑
  const ALIAS = {
    "프로필":    ["프로필","profile"],
    "전투":      ["전투","battle"],
    "술식":      ["술식","skill"],
    "가챠":      ["가챠","gacha"],
    "활성":      ["활성","select"],
    "출석":      ["출석","daily"],
    "회복":      ["회복","heal"],
    "코가네가챠":["코가네가챠"],
    "코가네":    ["코가네"],
    "손가락":    ["손가락","finger"],
    "컬링":      ["컬링","culling"],
    "사멸회유":  ["사멸회유"],
    "결투":      ["결투","pvp","duel"],
    "파티생성":  ["파티생성"],
    "파티초대":  ["파티초대"],
    "파티나가기":["파티나가기","파티탈퇴"],
    "파티정보":  ["파티정보"],
    "파티컬링":  ["파티컬링"],
    "레이드":    ["레이드","raid"],
    "코드":      ["코드","code"],
    "퀘스트":    ["퀘스트","quest"],
    "퀘보상":    ["퀘보상"],
    "재료":      ["재료"],
    "주구목록":  ["주구목록"],
    "주구제작":  ["주구제작"],
    "장착":      ["장착"],
    "해제":      ["해제"],
    "도움말":    ["도움말","help","?"],
  };

  let matched = null;
  for (const [key, aliases] of Object.entries(ALIAS)) {
    if (aliases.includes(cmd)) { matched = key; break; }
  }
  if (!matched) return;

  // fakeInteraction — 슬래시 커맨드 핸들러 재사용
  const fakeInteraction = {
    user: { id:userId, username:message.author.username },
    options: {
      getInteger: (name) => {
        if (name==="횟수") return parseInt(args[1]) || 1;
        if (name==="번호") return parseInt(args[2]) || 1;
        return null;
      },
      getString: (name) => {
        if (name==="보스")  return (args[1]||"").toLowerCase();
        if (name==="이름")  return args[1]||"";
        if (name==="코드")  return args[1]||"";
        // 퀘보상: !퀘보상 일 1  또는  !퀘보상 주 1
        if (name==="종류") {
          const t = (args[1]||"").replace("간","");
          return (t==="주" || t==="주간") ? "주간" : "일일";
        }
        return args[1]||"";
      },
      getUser: (name) => {
        if (name==="대상") return message.mentions.users.first()||null;
        return null;
      },
    },
    reply  : (opts) => reply(opts),
    editReply: (opts) => reply(opts),
    update : (opts) => reply(opts),
    isChatInputCommand: () => true,
  };

  try {
    await handleSlashCommand(fakeInteraction, matched, player, userId, message.author);
  } catch (e) {
    console.error("!명령어 오류:", e.message);
    reply("❌ 오류가 발생했습니다. 다시 시도해주세요.");
  }
});

// ════════════════════════════════════════════════════════
// ── 10. ready 이벤트 (단일 등록 — Part1 핸들러 교체)
// ════════════════════════════════════════════════════════
client.removeAllListeners("ready"); // Part1 ready 제거

client.once("ready", async () => {
  console.log(`✅ 로그인: ${client.user.tag}`);
  await dbInit();
  players = await dbLoad();
  console.log("🚀 주술회전 RPG 봇 가동!");

  const commands = [
    { name:"프로필",     description:"내 프로필 카드 확인" },
    { name:"전투",       description:"일반 전투 시작" },
    { name:"술식",       description:"현재 캐릭터 술식 확인" },
    { name:"가챠",       description:"캐릭터 소환", options:[{ name:"횟수",type:4,description:"1 또는 10",required:true }] },
    { name:"활성",       description:"캐릭터 선택 (이름으로 표시)" },
    { name:"출석",       description:"매일 출석 체크" },
    { name:"회복",       description:"회복약 사용" },
    { name:"코가네가챠", description:"코가네 펫 소환 (200💎)" },
    { name:"코가네",     description:"코가네 펫 정보" },
    { name:"손가락",     description:"스쿠나 손가락 현황" },
    { name:"컬링",       description:"컬링 게임 시작" },
    { name:"사멸회유",   description:"사멸회유 시작" },
    { name:"결투",       description:"PvP 결투 신청", options:[{ name:"대상",type:6,description:"상대방",required:true }] },
    { name:"파티생성",   description:"파티 생성" },
    { name:"파티초대",   description:"파티 초대", options:[{ name:"대상",type:6,description:"초대할 유저",required:true }] },
    { name:"파티나가기", description:"파티 탈퇴" },
    { name:"파티정보",   description:"파티 현황 확인" },
    { name:"파티컬링",   description:"파티 컬링 시작" },
    { name:"레이드",     description:"레이드 시작", options:[{ name:"보스",type:3,description:"heian_sukuna 또는 mahoraga",required:true }] },
    { name:"코드",       description:"쿠폰 코드 사용", options:[{ name:"코드",type:3,description:"코드",required:true }] },
    { name:"퀘스트",     description:"퀘스트 현황" },
    {
      name:"퀘보상", description:"퀘스트 보상 수령",
      options:[
        { name:"종류",type:3,description:"일일 또는 주간",required:true,
          choices:[{name:"일일",value:"일일"},{name:"주간",value:"주간"}] },
        { name:"번호",type:4,description:"1~3",required:true,min_value:1,max_value:3 },
      ],
    },
    { name:"재료",       description:"재료 인벤토리" },
    { name:"주구목록",   description:"주구 목록 및 제작 현황" },
    { name:"주구제작",   description:"주구 제작", options:[{ name:"이름",type:3,description:"주구 ID",required:true }] },
    { name:"장착",       description:"주구 장착", options:[{ name:"이름",type:3,description:"주구 ID",required:true }] },
    { name:"해제",       description:"주구 해제" },
    { name:"도움말",     description:"명령어 목록" },
  ];

  await client.application.commands.set(commands);
  console.log("✅ 슬래시 커맨드 등록 완료");
});

// ════════════════════════════════════════════════════════
// ── 11. 봇 로그인 & 에러 처리
// ════════════════════════════════════════════════════════
client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error("❌ 로그인 실패:", err.message);
  process.exit(1);
});

process.on("unhandledRejection", (err) => console.error("미처리 오류:", err?.message||err));
process.on("uncaughtException",  (err) => console.error("미처리 예외:", err?.message||err));
