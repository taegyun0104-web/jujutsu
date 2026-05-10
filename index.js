// ════════════════════════════════════════════════════════
// 주술회전 RPG 봇 — PART 1 완전 수정본
// 수정: GIF 프로필 완전 동기화, !활성 복구, 영역전개 쿨타임,
//       영역별 특수효과, 버그 전면 수정
// ════════════════════════════════════════════════════════
require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const {
  Client, GatewayIntentBits, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  AttachmentBuilder,
} = require("discord.js");
const { createCanvas, loadImage } = require("canvas");
const GIFEncoder = require("gifencoder");

const app = express();
app.get("/", (_, res) => res.send("🔱 주술회전 RPG 봇 가동 중"));
app.get("/health", (_, res) => res.json({ status: "ok", uptime: process.uptime() }));
app.listen(process.env.PORT || 3000, () => console.log(`🌐 HTTP 포트 ${process.env.PORT || 3000}`));

// ════════════════════════════════════════════════════════
// PostgreSQL
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
async function dbDelete(userId) {
  try { await pool.query("DELETE FROM players WHERE user_id = $1", [userId]); }
  catch (e) { console.error(`DB 삭제 오류 [${userId}]:`, e.message); }
}
const saveQueue = new Map();
const savePending = new Set();
async function dbSave(userId, data) {
  try {
    const c = await pool.connect();
    try {
      await c.query(
        `INSERT INTO players(user_id,data,updated_at) VALUES($1,$2,NOW()) ON CONFLICT(user_id) DO UPDATE SET data=$2,updated_at=NOW()`,
        [userId, JSON.stringify(data)]
      );
    } finally { c.release(); }
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
setInterval(async () => {
  for (const uid of Object.keys(players)) {
    if (!saveQueue.has(uid) && !savePending.has(uid)) {
      try { await dbSave(uid, players[uid]); } catch {}
    }
  }
}, 3 * 60 * 1000);

// ════════════════════════════════════════════════════════
// Discord 클라이언트
// ════════════════════════════════════════════════════════
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});
const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) { console.error("❌ DISCORD_TOKEN 없음!"); process.exit(1); }

const DEV_IDS = new Set(["1284771557633425470", "1397218266505678881"]);
const isDev = (id) => DEV_IDS.has(id);

// ════════════════════════════════════════════════════════
// 등급/색상
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
// 재료 시스템
// ════════════════════════════════════════════════════════
const MATERIALS = {
  "저주 실":   { name:"저주 실",   emoji:"🧵", desc:"저급 저주령에서 획득" },
  "저주 뼈":   { name:"저주 뼈",   emoji:"🦴", desc:"1급 저주령에서 획득" },
  "저주 핵":   { name:"저주 핵",   emoji:"💜", desc:"특급 저주령에서 획득" },
  "저주 수정": { name:"저주 수정", emoji:"💎", desc:"보스에서 획득" },
  "철 파편":   { name:"철 파편",   emoji:"⚙️", desc:"모든 적에서 획득" },
  "영혼 정수": { name:"영혼 정수", emoji:"✨", desc:"특급 이상 적에서 획득" },
  "용 비늘":   { name:"용 비늘",   emoji:"🐉", desc:"보스에서 획득" },
};

// ════════════════════════════════════════════════════════
// 주구 시스템
// ════════════════════════════════════════════════════════
const WEAPONS = {
  "저주 단검":      { id:"cursed_knife",   name:"저주 단검",      emoji:"🗡️",  grade:"일반", atkBonus:15,  defBonus:0,  hpBonus:0,   desc:"저주 에너지가 깃든 단검.",     recipe:{"저주 실":3,"철 파편":5},                              color:0x94a3b8 },
  "저주 도검":      { id:"cursed_blade",   name:"저주 도검",      emoji:"⚔️",  grade:"희귀", atkBonus:35,  defBonus:5,  hpBonus:100, desc:"날카로운 저주 도검.",           recipe:{"저주 뼈":4,"철 파편":8,"저주 실":2},                  color:0x4ade80 },
  "저주 창":        { id:"cursed_spear",   name:"저주 창",        emoji:"🔱",  grade:"희귀", atkBonus:45,  defBonus:0,  hpBonus:0,   desc:"원거리 공격이 가능한 저주 창.", recipe:{"저주 뼈":5,"저주 실":5},                              color:0x4ade80 },
  "영혼 방패":      { id:"spirit_shield",  name:"영혼 방패",      emoji:"🛡️",  grade:"고급", atkBonus:5,   defBonus:40, hpBonus:300, desc:"영혼 정수로 만든 방어 도구.",   recipe:{"영혼 정수":3,"저주 핵":2,"철 파편":10},               color:0x7C5CFC },
  "저주 망치":      { id:"cursed_hammer",  name:"저주 망치",      emoji:"🔨",  grade:"고급", atkBonus:60,  defBonus:10, hpBonus:150, desc:"묵직한 저주 망치.",             recipe:{"저주 핵":3,"저주 뼈":6,"철 파편":12},                 color:0x7C5CFC },
  "용의 검":        { id:"dragon_sword",   name:"용의 검",        emoji:"🐉⚔️",grade:"전설", atkBonus:100, defBonus:30, hpBonus:500, desc:"용 비늘로 만든 전설의 검.",     recipe:{"용 비늘":3,"저주 수정":2,"영혼 정수":5,"저주 핵":4}, color:0xF5C842 },
  "스쿠나의 그릇":  { id:"sukuna_vessel",  name:"스쿠나의 그릇",  emoji:"👹",  grade:"전설", atkBonus:80,  defBonus:20, hpBonus:800, desc:"스쿠나의 힘이 깃든 주구.",      recipe:{"저주 수정":3,"용 비늘":2,"저주 핵":6},                color:0x8b0000 },
};
function getWeaponByName(name) { return WEAPONS[name] || Object.values(WEAPONS).find(w => w.id === name); }
function getWeaponStats(player) {
  if (!player.equippedWeapon) return { atk:0, def:0, hp:0 };
  const w = getWeaponByName(player.equippedWeapon);
  return w ? { atk:w.atkBonus||0, def:w.defBonus||0, hp:w.hpBonus||0 } : { atk:0, def:0, hp:0 };
}

// ════════════════════════════════════════════════════════
// 드롭 테이블
// ════════════════════════════════════════════════════════
const ENEMY_DROPS = {
  e1:[{mat:"저주 실",min:1,max:3,chance:0.80},{mat:"철 파편",min:1,max:2,chance:0.60},{mat:"저주 뼈",min:1,max:1,chance:0.10}],
  e2:[{mat:"저주 뼈",min:1,max:2,chance:0.70},{mat:"철 파편",min:2,max:4,chance:0.80},{mat:"저주 실",min:2,max:4,chance:0.50},{mat:"저주 핵",min:1,max:1,chance:0.08}],
  e3:[{mat:"저주 핵",min:1,max:2,chance:0.65},{mat:"영혼 정수",min:1,max:2,chance:0.55},{mat:"저주 뼈",min:2,max:4,chance:0.80},{mat:"철 파편",min:3,max:6,chance:0.90},{mat:"저주 수정",min:1,max:1,chance:0.05}],
  e4:[{mat:"저주 수정",min:1,max:2,chance:0.80},{mat:"용 비늘",min:1,max:2,chance:0.60},{mat:"영혼 정수",min:2,max:4,chance:0.90},{mat:"저주 핵",min:2,max:4,chance:0.90},{mat:"철 파편",min:5,max:10,chance:1.00}],
  e_sukuna:[{mat:"저주 수정",min:2,max:3,chance:1.00},{mat:"용 비늘",min:2,max:3,chance:1.00},{mat:"영혼 정수",min:4,max:6,chance:1.00}],
  raid_heian:[{mat:"저주 수정",min:3,max:5,chance:1.00},{mat:"용 비늘",min:3,max:4,chance:1.00},{mat:"영혼 정수",min:5,max:8,chance:1.00}],
  raid_mahoraga:[{mat:"저주 수정",min:3,max:5,chance:1.00},{mat:"용 비늘",min:4,max:6,chance:1.00},{mat:"영혼 정수",min:5,max:8,chance:1.00},{mat:"철 파편",min:10,max:20,chance:1.00}],
};
const JUJUTSU_DROPS = {
  j1:[{mat:"저주 실",min:1,max:2,chance:0.70},{mat:"철 파편",min:1,max:2,chance:0.60}],
  j2:[{mat:"저주 실",min:1,max:3,chance:0.70},{mat:"저주 뼈",min:1,max:1,chance:0.35},{mat:"철 파편",min:1,max:3,chance:0.65}],
  j3:[{mat:"저주 뼈",min:1,max:2,chance:0.55},{mat:"철 파편",min:1,max:3,chance:0.70}],
  j4:[{mat:"저주 핵",min:1,max:1,chance:0.30},{mat:"저주 뼈",min:1,max:3,chance:0.65},{mat:"영혼 정수",min:1,max:1,chance:0.20}],
  j5:[{mat:"저주 핵",min:1,max:2,chance:0.55},{mat:"영혼 정수",min:1,max:2,chance:0.40},{mat:"저주 수정",min:1,max:1,chance:0.08}],
  j6:[{mat:"저주 수정",min:1,max:1,chance:0.50},{mat:"용 비늘",min:1,max:1,chance:0.30},{mat:"영혼 정수",min:2,max:3,chance:0.80}],
};
function rollDrops(enemyId, isJujutsu=false) {
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
    if (m) parts.push(`${m.emoji} **${m.name}** ×${qty}`);
  }
  return parts.length ? parts.join("  ") : "없음";
}

// ════════════════════════════════════════════════════════
// 퀘스트 시스템
// ════════════════════════════════════════════════════════
const DAILY_QUESTS = [
  { id:"dq_battle3",  type:"battle_win",   target:3,  name:"오늘의 수련",   desc:"전투 3회 승리",              reward:{ crystals:80,  xp:150, materials:{"철 파편":3} } },
  { id:"dq_culling5", type:"culling_wave",  target:5,  name:"컬링 특훈",    desc:"컬링 게임 5웨이브 달성",      reward:{ crystals:100, xp:200, materials:{"저주 실":5} } },
  { id:"dq_jujutsu3", type:"jujutsu_point",target:3,  name:"사멸회유 임무", desc:"사멸회유 3포인트 달성",       reward:{ crystals:90,  xp:180, materials:{"저주 뼈":2} } },
  { id:"dq_skill5",   type:"skill_use",    target:5,  name:"술식 연마",    desc:"술식 5회 사용",               reward:{ crystals:70,  xp:130, materials:{"저주 실":3,"철 파편":2} } },
  { id:"dq_gacha1",   type:"gacha_pull",   target:1,  name:"운명의 소환",  desc:"가챠 1회 소환",               reward:{ crystals:60,  xp:100, materials:{"철 파편":5} } },
  { id:"dq_nokill2",  type:"boss_kill",    target:2,  name:"정예 사냥",    desc:"특급 저주령 이상 2마리 처치", reward:{ crystals:150, xp:300, materials:{"저주 핵":1} } },
];
const WEEKLY_QUESTS = [
  { id:"wq_battle20",  type:"battle_win",   target:20, name:"주간 전사",       desc:"이번 주 전투 20회 승리",       reward:{ crystals:500, xp:1000, materials:{"저주 핵":3,"영혼 정수":2} } },
  { id:"wq_culling15", type:"culling_wave",  target:15, name:"컬링 마스터",    desc:"컬링 15웨이브 달성(합산)",     reward:{ crystals:600, xp:1200, materials:{"저주 수정":1,"저주 뼈":8} } },
  { id:"wq_jujutsu15", type:"jujutsu_point",target:15, name:"사멸회유 전문가", desc:"사멸회유 총 15포인트 달성",    reward:{ crystals:550, xp:1100, materials:{"영혼 정수":4,"저주 핵":2} } },
  { id:"wq_boss5",     type:"boss_kill",    target:5,  name:"보스 사냥꾼",    desc:"특급 저주령 이상 5마리 처치",  reward:{ crystals:700, xp:1400, materials:{"용 비늘":1,"저주 수정":1} } },
  { id:"wq_craft1",    type:"weapon_craft", target:1,  name:"주구 장인",      desc:"주구 1개 제작",                reward:{ crystals:400, xp:800,  materials:{"영혼 정수":3,"용 비늘":1} } },
  { id:"wq_pvpwin3",   type:"pvp_win",      target:3,  name:"결투 챔피언",    desc:"PvP 3회 승리",                 reward:{ crystals:800, xp:1600, materials:{"저주 수정":2,"용 비늘":1} } },
];
function getTodayKey() { const d=new Date(); return `${d.getUTCFullYear()}-${d.getUTCMonth()+1}-${d.getUTCDate()}`; }
function getWeekKey()  { const d=new Date(); const w=new Date(d); w.setUTCDate(d.getUTCDate()-d.getUTCDay()); return `${w.getUTCFullYear()}-${w.getUTCMonth()+1}-${w.getUTCDate()}`; }
function initQuests(player) {
  const today=getTodayKey(), week=getWeekKey();
  if (!player.quests) player.quests={};
  if (player.quests.dailyKey!==today) { player.quests.dailyKey=today; const picked=[...DAILY_QUESTS].sort(()=>Math.random()-0.5).slice(0,3); player.quests.daily=picked.map(q=>({id:q.id,progress:0,done:false,claimed:false})); }
  if (player.quests.weekKey!==week)  { player.quests.weekKey=week;  const picked=[...WEEKLY_QUESTS].sort(()=>Math.random()-0.5).slice(0,3); player.quests.weekly=picked.map(q=>({id:q.id,progress:0,done:false,claimed:false})); }
  if (!player.quests.daily)  player.quests.daily=[];
  if (!player.quests.weekly) player.quests.weekly=[];
}
function updateQuestProgress(player,type,amount=1) {
  initQuests(player);
  for (const qp of player.quests.daily)  { if (qp.done) continue; const def=DAILY_QUESTS.find(q=>q.id===qp.id);  if (!def||def.type!==type) continue; qp.progress=Math.min(qp.progress+amount,def.target);  if (qp.progress>=def.target)  qp.done=true; }
  for (const qp of player.quests.weekly) { if (qp.done) continue; const def=WEEKLY_QUESTS.find(q=>q.id===qp.id); if (!def||def.type!==type) continue; qp.progress=Math.min(qp.progress+amount,def.target); if (qp.progress>=def.target) qp.done=true; }
}
function claimQuestReward(player,questId,isWeekly=false) {
  initQuests(player);
  const list=isWeekly?player.quests.weekly:player.quests.daily;
  const allDefs=isWeekly?WEEKLY_QUESTS:DAILY_QUESTS;
  const qp=list.find(q=>q.id===questId); if (!qp||!qp.done||qp.claimed) return null;
  const def=allDefs.find(q=>q.id===questId); if (!def) return null;
  qp.claimed=true; player.crystals+=(def.reward.crystals||0); player.xp+=(def.reward.xp||0);
  if (def.reward.materials) addMaterials(player,def.reward.materials);
  return def.reward;
}

// ════════════════════════════════════════════════════════
// 상태이상
// ════════════════════════════════════════════════════════
const STATUS_EFFECTS = {
  poison:        { id:"poison",        name:"독",      emoji:"☠️", desc:"매 턴 최대HP의 5% 피해",  duration:3 },
  burn:          { id:"burn",          name:"화상",    emoji:"🔥", desc:"매 턴 최대HP의 8% 피해",  duration:2 },
  freeze:        { id:"freeze",        name:"빙결",    emoji:"❄️", desc:"1턴 행동 불가",            duration:1 },
  weaken:        { id:"weaken",        name:"약화",    emoji:"💔", desc:"공격력 30% 감소",          duration:2 },
  stun:          { id:"stun",          name:"기절",    emoji:"⚡", desc:"1턴 행동 불가",            duration:1 },
  battleInstinct:{ id:"battleInstinct",name:"전투본능",emoji:"🔥💪",desc:"공격력 40% 증가",        duration:3 },
  cursed_wound:  { id:"cursed_wound",  name:"저주상처",emoji:"🩸", desc:"매 턴 최대HP의 10% 피해", duration:2 },
  blind:         { id:"blind",         name:"실명",    emoji:"🌑", desc:"명중률 50% 감소",          duration:2 },
  adaptation:    { id:"adaptation",    name:"적응",    emoji:"🔄", desc:"특정 술식 데미지 무효",    duration:99 },
  defBreak:      { id:"defBreak",      name:"방어파괴",emoji:"🛡️💥",desc:"방어력 50% 감소",       duration:3 },
  dotBleed:      { id:"dotBleed",      name:"지속출혈",emoji:"💧", desc:"매 턴 최대HP의 7% 피해",  duration:4 },
};
function applyStatus(target,statusId) {
  if (!target.statusEffects) target.statusEffects=[];
  const existing=target.statusEffects.find(s=>s.id===statusId);
  if (existing) existing.turns=STATUS_EFFECTS[statusId]?.duration||2;
  else target.statusEffects.push({id:statusId,turns:STATUS_EFFECTS[statusId]?.duration||2});
}
function tickStatus(target,maxHp) {
  if (!target.statusEffects||target.statusEffects.length===0) return {dmg:0,expired:[],log:[]};
  let totalDmg=0; const expired=[],log=[];
  for (const se of target.statusEffects) {
    const def=STATUS_EFFECTS[se.id]; if (!def) { se.turns=0; continue; }
    if (se.id==="poison")       { const d=Math.max(1,Math.floor(maxHp*0.05)); totalDmg+=d; log.push(`> ${def.emoji} **${def.name}** — **${d}** 피해!`); }
    if (se.id==="burn")         { const d=Math.max(1,Math.floor(maxHp*0.08)); totalDmg+=d; log.push(`> ${def.emoji} **${def.name}** — **${d}** 피해!`); }
    if (se.id==="cursed_wound") { const d=Math.max(1,Math.floor(maxHp*0.10)); totalDmg+=d; log.push(`> ${def.emoji} **${def.name}** — **${d}** 피해!`); }
    if (se.id==="dotBleed")     { const d=Math.max(1,Math.floor(maxHp*0.07)); totalDmg+=d; log.push(`> ${def.emoji} **${def.name}** — **${d}** 피해!`); }
    se.turns--; if (se.turns<=0) expired.push(se.id);
  }
  target.statusEffects=target.statusEffects.filter(s=>s.turns>0);
  if (totalDmg>0) target.hp=Math.max(0,(target.hp||0)-totalDmg);
  return {dmg:totalDmg,expired,log};
}
function statusStr(se) { if (!se||se.length===0) return "없음"; return se.map(s=>`${STATUS_EFFECTS[s.id]?.emoji||""}${STATUS_EFFECTS[s.id]?.name||s.id}(${s.turns}턴)`).join(" "); }
function isIncapacitated(se) { return !!(se&&se.some(s=>s.id==="freeze"||s.id==="stun")); }
function isBlind(se) { return !!(se&&se.some(s=>s.id==="blind")); }
function getWeakenMult(se) { let m=1; if (se&&se.some(s=>s.id==="weaken")) m*=0.7; if (se&&se.some(s=>s.id==="battleInstinct")) m*=1.4; if (se&&se.some(s=>s.id==="defBreak")) m*=1.3; return m; }
function getBattleInstinctEvade(se) { return !!(se&&se.some(s=>s.id==="battleInstinct")); }
function rollHit(aSe,dSe) { if (isBlind(aSe)&&Math.random()<0.50) return false; return Math.random()>(0.05+(getBattleInstinctEvade(dSe)?0.25:0)); }

// ════════════════════════════════════════════════════════
// 흑섬
// ════════════════════════════════════════════════════════
function isBlackFlash() { return Math.random()<0.10; }
function getBlackFlashArt() { return "```ansi\n\u001b[1;30m╔══════════════════════════════════════╗\n\u001b[1;31m║  ⚫  B L A C K   F L A S H  ⚫     ║\n\u001b[1;33m║     저주 에너지 순간 최대 방출!!      ║\n\u001b[1;30m╚══════════════════════════════════════╝\n```"; }

// ════════════════════════════════════════════════════════
// 스쿠나 손가락
// ════════════════════════════════════════════════════════
const SUKUNA_FINGER_MAX = 20;
function getFingerBonus(fingers) {
  const f = fingers||0;
  return {
    atkBonus:Math.floor(f*15), defBonus:Math.floor(f*8), hpBonus:f*300, dmgMult:1+f*0.03,
    label: f>=20?"🔴 스쿠나 완전 각성 — 저주의 왕":f>=15?"🔴 스쿠나 각성 Lv.4":f>=10?"🟠 스쿠나 각성 Lv.3":f>=5?"🟡 스쿠나 각성 Lv.2":f>=1?"🟢 스쿠나 각성 Lv.1 — 스쿠나 해금!":"스쿠나 봉인 중 (손가락 1개 필요)",
  };
}

// ════════════════════════════════════════════════════════
// 코가네 펫
// ════════════════════════════════════════════════════════
const KOGANE_GRADES = {
  "전설":{ color:0xF5C842,emoji:"🌟",stars:"★★★★★",rate:0.5,  atkBonus:0.25,defBonus:0.20,hpBonus:0.20,xpBonus:0.30,crystalBonus:0.25,skill:"황금 포효",   skillDesc:"전투 시작 시 적에게 추가 피해 (ATK의 50%)",skillChance:0.35,passiveDesc:"ATK+25% DEF+20% HP+20% XP+30% 크리스탈+25%" },
  "특급":{ color:0xff8c00,emoji:"🔶",stars:"★★★★☆",rate:2.0,  atkBonus:0.18,defBonus:0.15,hpBonus:0.15,xpBonus:0.20,crystalBonus:0.18,skill:"황금 이빨",   skillDesc:"공격 시 15% 확률로 약화 부여",             skillChance:0.15,passiveDesc:"ATK+18% DEF+15% HP+15% XP+20% 크리스탈+18%" },
  "1급": { color:0x7C5CFC,emoji:"🔷",stars:"★★★☆☆",rate:8.0,  atkBonus:0.12,defBonus:0.10,hpBonus:0.10,xpBonus:0.12,crystalBonus:0.10,skill:"황금 발톱",   skillDesc:"공격 시 10% 확률로 추가타 (ATK의 30%)",    skillChance:0.10,passiveDesc:"ATK+12% DEF+10% HP+10% XP+12% 크리스탈+10%" },
  "2급": { color:0x4ade80,emoji:"🟢",stars:"★★☆☆☆",rate:22.5, atkBonus:0.07,defBonus:0.06,hpBonus:0.06,xpBonus:0.07,crystalBonus:0.06,skill:"황금 보호막",skillDesc:"HP 30% 이하 시 1회 피해 50% 감소",         skillChance:1.0, passiveDesc:"ATK+7% DEF+6% HP+6% XP+7% 크리스탈+6%"    },
  "3급": { color:0x94a3b8,emoji:"⚪",stars:"★☆☆☆☆",rate:67.0, atkBonus:0.03,defBonus:0.02,hpBonus:0.02,xpBonus:0.03,crystalBonus:0.02,skill:"황금 냄새",   skillDesc:"전투 후 크리스탈 +5% 추가 획득",           skillChance:1.0, passiveDesc:"ATK+3% DEF+2% HP+2% XP+3% 크리스탈+2%"    },
};
const KOGANE_POOL=[{grade:"전설",rate:0.5},{grade:"특급",rate:2.0},{grade:"1급",rate:8.0},{grade:"2급",rate:22.5},{grade:"3급",rate:67.0}];
function rollKogane() { const total=KOGANE_POOL.reduce((s,p)=>s+p.rate,0); let roll=Math.random()*total; for (const e of KOGANE_POOL) { roll-=e.rate; if (roll<=0) return e.grade; } return "3급"; }
function getKoganeBonus(player) {
  if (!player.kogane?.grade) return {atk:1,def:1,hp:1,xp:1,crystal:1};
  const g=KOGANE_GRADES[player.kogane.grade];
  return g ? {atk:1+g.atkBonus,def:1+g.defBonus,hp:1+g.hpBonus,xp:1+g.xpBonus,crystal:1+g.crystalBonus} : {atk:1,def:1,hp:1,xp:1,crystal:1};
}

// ════════════════════════════════════════════════════════
// 스킬 이펙트
// ════════════════════════════════════════════════════════
const SKILL_EFFECTS = {
  "주먹질":        { art:"```ansi\n\u001b[1;31m    💥    \n\u001b[1;33m   ▓▓▓   \n\u001b[1;31m    💥    \n```", color:0xff6b35, flavorText:"💪 저주 에너지를 주먹에 집중시킨다!" },
  "다이버전트 주먹":{ art:"```ansi\n\u001b[1;31m ⚡💥⚡\n\u001b[1;33m▓▓▓▓▓▓▓\n\u001b[1;31m ⚡💥⚡\n```", color:0xff4500, flavorText:"💥 체내에서 저주 에너지가 폭발한다!" },
  "흑섬":          { art:"```ansi\n\u001b[1;30m🌑🌑🌑🌑🌑\n\u001b[1;31m⬛ 黑 閃 ⬛\n\u001b[1;30m🌑🌑🌑🌑🌑\n```", color:0x1a0a2e, flavorText:"⚫ 순간적으로 발산되는 최대 저주 에너지!" },
  "아오":          { art:"```ansi\n\u001b[1;34m  🔵🔵🔵  \n\u001b[1;36m🔵  蒼  🔵\n\u001b[1;34m  🔵🔵🔵  \n```", color:0x0066ff, flavorText:"🌀 무한의 인력 — 모든 것을 끌어당긴다" },
  "아카":          { art:"```ansi\n\u001b[1;31m  🔴🔴🔴  \n\u001b[1;33m🔴  赫  🔴\n\u001b[1;31m  🔴🔴🔴  \n```", color:0xff0033, flavorText:"💢 무한의 척력 — 모든 것을 날려버린다!" },
  "무라사키":      { art:"```ansi\n\u001b[1;35m⚡  紫  ⚡\n```", color:0x9900ff, flavorText:"🟣 아오와 아카의 융합 — 허공을 찢는 허수!" },
  "무량공처":      { art:"```ansi\n\u001b[1;36m∞∞∞∞∞∞∞∞∞\n\u001b[1;37m∞ 無量空処 ∞\n\u001b[1;36m∞∞∞∞∞∞∞∞∞\n```", color:0x00ffff, flavorText:"🌌 나는 최강이니까" },
  "자폭 무라사키": { art:"```ansi\n\u001b[1;31m💥 自爆 紫 💥\n```", color:0xff0000, flavorText:"💀 모든 힘을 쏟아붓는 자폭 공격! HP 1" },
  "해":            { art:"```ansi\n\u001b[1;31m✂️  解  ✂️\n```", color:0xcc0000, flavorText:"✂️ 만물을 베어내는 저주의 왕의 손톱!" },
  "팔":            { art:"```ansi\n\u001b[1;31m✂️  捌  ✂️\n```", color:0x8b0000, flavorText:"🌌 공간 자체를 베어내는 절대술식!" },
  "푸가":          { art:"```ansi\n\u001b[1;33m🔥 不 雅 🔥\n```", color:0x4a0000, flavorText:"🔥 닿는 모든 것을 분해한다!" },
  "복마어주자":    { art:"```ansi\n\u001b[1;33m🌑伏魔御廚子🌑\n```", color:0x2a0000, flavorText:"👑 천지개벽 — 저주의 왕의 궁극 영역전개!" },
  "세계참":        { art:"```ansi\n\u001b[1;31m✂️ 世界斬 ✂️\n```", color:0x4a0000, flavorText:"🌍 세계조차 베어버린다!" },
  "부기우기":      { art:"```ansi\n\u001b[1;32m💪 Boogie 💪\n```", color:0x1e90ff, flavorText:"🎵 위치 전환! 빙결!" },
  "전투본능":      { art:"```ansi\n\u001b[1;33m🔥戦闘本能🔥\n```", color:0xff8c00, flavorText:"⚔️ 전사의 본능이 각성한다!" },
  "강압암예정":    { art:"```ansi\n\u001b[1;35m⚫ 强壓暗藝庭 ⚫\n```", color:0x2d0059, flavorText:"🌑 마허라가라 강림의 전조..." },
  "탕온평선":      { art:"```ansi\n\u001b[1;34m🌊 湯漫平線 🌊\n```", color:0x003366, flavorText:"🌊 광대한 바다가 모든 것을 삼킨다!" },
  "자폐원돈과":    { art:"```ansi\n\u001b[1;31m🩸 自閉円頓裹 🩸\n```", color:0x4a0000, flavorText:"💀 영혼의 경계가 무너진다..." },
  "진안상애":      { art:"```ansi\n\u001b[1;35m💜 真愛相愛 💜\n```", color:0x6600aa, flavorText:"💜 리카의 사랑이 모든 것을 파괴한다!" },
  "개관철위산":    { art:"```ansi\n\u001b[1;31m🌋 蓋棺鐵囲山 🌋\n```", color:0x8b2500, flavorText:"🌋 화산이 폭발한다! 모든 것이 불탄다!" },
  "주복사사":      { art:"```ansi\n\u001b[1;33m⚖️ 呪腹裁死 ⚖️\n```", color:0x4a3500, flavorText:"⚖️ 법정의 판결이 내려진다!" },
  "질풍강운":      { art:"```ansi\n\u001b[1;32m🎰 疾風强運 🎰\n```", color:0x00aa44, flavorText:"🎰 운이 터진다! 불멸의 도박사!" },
  "_default":      { art:"```ansi\n\u001b[1;35m✨ 術 式 ✨\n```", color:0x7c5cfc, flavorText:"🌀 저주 에너지가 폭발한다!" },
};
function getSkillEffect(n) { return SKILL_EFFECTS[n]||SKILL_EFFECTS["_default"]; }

// ════════════════════════════════════════════════════════
// 영역전개 특수효과 정의
// ════════════════════════════════════════════════════════
const DOMAIN_EFFECTS = {
  "무량공처": {
    dmgMult: 3.2,
    statusId: "stun",
    statusDuration: 2,
    statusChance: 1.0,
    extraEffect: (target) => { applyStatus(target, "blind"); },
    desc: "상대방 2턴 기절 + 실명 부여",
    art: "```ansi\n\u001b[1;36m╔══════════════════════════════════════╗\n║  ∞  無 量 空 処  ∞  나는 최강이다  ║\n╚══════════════════════════════════════╝\n```",
  },
  "복마어주자": {
    dmgMult: 3.5,
    statusId: "cursed_wound",
    statusDuration: 3,
    statusChance: 1.0,
    extraEffect: (target) => { applyStatus(target, "weaken"); applyStatus(target, "burn"); },
    desc: "저주 상처(3턴) + 약화 + 화상 부여",
    art: "```ansi\n\u001b[1;31m╔══════════════════════════════════════╗\n║  🌑  伏 魔 御 廚 子  天 地 開 闢  🌑  ║\n╚══════════════════════════════════════╝\n```",
  },
  "자폐원돈과": {
    dmgMult: 2.8,
    statusId: "defBreak",
    statusDuration: 3,
    statusChance: 1.0,
    extraEffect: (target) => { applyStatus(target, "weaken"); },
    desc: "방어 파괴(3턴) + 약화 부여",
    art: "```ansi\n\u001b[1;31m╔══════════════════════════════════════╗\n║  🩸  自 閉 円 頓 裹  영혼 붕괴  🩸  ║\n╚══════════════════════════════════════╝\n```",
  },
  "탕온평선": {
    dmgMult: 2.8,
    statusId: "poison",
    statusDuration: 4,
    statusChance: 1.0,
    extraEffect: (target) => { applyStatus(target, "freeze"); },
    desc: "독(4턴) + 빙결 부여",
    art: "```ansi\n\u001b[1;34m╔══════════════════════════════════════╗\n║  🌊  湯 漫 平 線  광대한 바다  🌊  ║\n╚══════════════════════════════════════╝\n```",
  },
  "진안상애": {
    dmgMult: 3.3,
    statusId: "burn",
    statusDuration: 3,
    statusChance: 1.0,
    extraEffect: (target) => { applyStatus(target, "weaken"); applyStatus(target, "dotBleed"); },
    desc: "화상(3턴) + 약화 + 출혈 부여",
    art: "```ansi\n\u001b[1;35m╔══════════════════════════════════════╗\n║  💜  真 愛 相 愛  리카의 사랑  💜  ║\n╚══════════════════════════════════════╝\n```",
  },
  "개관철위산": {
    dmgMult: 3.0,
    statusId: "burn",
    statusDuration: 4,
    statusChance: 1.0,
    extraEffect: (target) => { applyStatus(target, "weaken"); },
    desc: "화상(4턴) + 약화 부여",
    art: "```ansi\n\u001b[1;31m╔══════════════════════════════════════╗\n║  🌋  蓋 棺 鐵 囲 山  화산 폭발  🌋  ║\n╚══════════════════════════════════════╝\n```",
  },
  "강압암예정": {
    dmgMult: 2.9,
    statusId: "stun",
    statusDuration: 2,
    statusChance: 0.8,
    extraEffect: (target) => { applyStatus(target, "weaken"); },
    desc: "기절 80% + 약화 부여",
    art: "```ansi\n\u001b[1;35m╔══════════════════════════════════════╗\n║  ⚫  强 壓 暗 藝 庭  마허라가 강림  ║\n╚══════════════════════════════════════╝\n```",
  },
  "주복사사": {
    dmgMult: 2.8,
    statusId: "stun",
    statusDuration: 1,
    statusChance: 0.9,
    extraEffect: (target) => { applyStatus(target, "weaken"); applyStatus(target, "blind"); },
    desc: "기절 90% + 약화 + 실명 부여",
    art: "```ansi\n\u001b[1;33m╔══════════════════════════════════════╗\n║  ⚖️  呪 腹 裁 死  사형 판결  ⚖️  ║\n╚══════════════════════════════════════╝\n```",
  },
  "질풍강운": {
    dmgMult: 3.8,
    statusId: "weaken",
    statusDuration: 3,
    statusChance: 1.0,
    extraEffect: (target) => { applyStatus(target, "burn"); },
    desc: "약화(3턴) + 화상 부여 + 최고 배율",
    art: "```ansi\n\u001b[1;32m╔══════════════════════════════════════╗\n║  🎰  疾 風 强 運  운이 터진다!  🎰  ║\n╚══════════════════════════════════════╝\n```",
  },
};

// 영역전개 사용 처리 함수
function applyDomainExpansion(attackerStats, domainName, defender, defenderIsObj=false) {
  const effect = DOMAIN_EFFECTS[domainName];
  if (!effect) {
    // 기본 영역전개 (정의되지 않은 경우)
    const dmg = Math.floor(attackerStats.atk * 2.8);
    if (defenderIsObj) {
      defender.hp = Math.max(0, (defender.hp||0) - dmg);
    }
    return { dmg, log: [`🌌 **${domainName}** — **${dmg}** 피해!`], art:"" };
  }
  const dmg = Math.floor(attackerStats.atk * effect.dmgMult);
  const log = [];
  log.push(effect.art);
  log.push(`> 🌌 **영역전개: ${domainName}** — **${dmg}** 피해!`);
  log.push(`> 📖 효과: ${effect.desc}`);
  if (Math.random() < effect.statusChance) {
    applyStatus(defender, effect.statusId);
    const sdef = STATUS_EFFECTS[effect.statusId];
    log.push(`> ${sdef?.emoji||""} **${sdef?.name||effect.statusId}** 부여! (${sdef?.duration||2}턴)`);
  }
  if (effect.extraEffect) effect.extraEffect(defender);
  if (defenderIsObj) {
    defender.hp = Math.max(0, (defender.hp||0) - dmg);
  }
  return { dmg, log, art: effect.art };
}

// ════════════════════════════════════════════════════════
// 캐릭터 데이터
// ════════════════════════════════════════════════════════
const CHARACTERS = {
  itadori:  { name:"이타도리 유지",   emoji:"🟠",grade:"준1급",atk:90, def:75, spd:85, maxHp:1000,domain:null,          desc:"특급주술사 후보생. 스쿠나의 그릇.",lore:"\"남은 건 내가 어떻게 죽느냐다.\"",fingerSkills:true,
    skills:[{name:"주먹질",minMastery:0,dmg:95,desc:"강력한 기본 주먹.",statusApply:null},{name:"다이버전트 주먹",minMastery:5,dmg:160,desc:"저주 에너지를 실은 주먹.",statusApply:{target:"enemy",statusId:"stun",chance:0.3}},{name:"흑섬",minMastery:15,dmg:240,desc:"최대 저주 에너지 방출!",statusApply:{target:"enemy",statusId:"weaken",chance:0.5}}]},
  gojo:     { name:"고조 사토루",     emoji:"🔵",grade:"특급", atk:130,def:120,spd:110,maxHp:1800,domain:"무량공처",     desc:"최강의 주술사. 무한을 구사한다.",lore:"\"사람들이 왜 내가 최강이라고 하는지 알아?\"",
    skills:[{name:"아오",minMastery:0,dmg:145,desc:"적을 끌어당겨 공격.",statusApply:null},{name:"아카",minMastery:5,dmg:220,desc:"적을 날려 폭발시킨다.",statusApply:{target:"enemy",statusId:"burn",chance:0.5}},{name:"무라사키",minMastery:15,dmg:320,desc:"아오+아카 융합 발사.",statusApply:{target:"enemy",statusId:"weaken",chance:0.6}},{name:"무량공처",minMastery:30,dmg:480,desc:"무한을 지배하는 궁극술식.",statusApply:{target:"enemy",statusId:"freeze",chance:0.8}}]},
  megumi:   { name:"후시구로 메구미", emoji:"⚫",grade:"1급",  atk:110,def:108,spd:100,maxHp:1250,domain:"강압암예정",   desc:"식신술을 구사하는 주술사.",lore:"\"나는 선한 사람을 구하기 위해 싸운다.\"",
    skills:[{name:"옥견",minMastery:0,dmg:115,desc:"식신 옥견 소환.",statusApply:null},{name:"탈토",minMastery:5,dmg:180,desc:"식신 대호 소환.",statusApply:{target:"enemy",statusId:"weaken",chance:0.4}},{name:"만상",minMastery:15,dmg:265,desc:"열 가지 식신 소환.",statusApply:{target:"enemy",statusId:"poison",chance:0.5}},{name:"후루베 유라유라",minMastery:30,dmg:380,desc:"마허라가라 강림.",statusApply:{target:"enemy",statusId:"stun",chance:0.6}}]},
  nobara:   { name:"쿠기사키 노바라", emoji:"🌸",grade:"1급",  atk:115,def:95, spd:105,maxHp:1180,domain:null,            desc:"영혼에 직접 공격 가능한 주술사.",lore:"\"도쿄에 올 때부터 각오는 되어 있었어.\"",
    skills:[{name:"망치질",minMastery:0,dmg:118,desc:"저주 못 박기.",statusApply:null},{name:"공명",minMastery:5,dmg:195,desc:"허수아비 공명 피해.",statusApply:{target:"enemy",statusId:"poison",chance:0.5}},{name:"철정",minMastery:15,dmg:280,desc:"저주 에너지 못 박기.",statusApply:{target:"enemy",statusId:"weaken",chance:0.5}},{name:"발화",minMastery:30,dmg:390,desc:"동시 폭발 공명.",statusApply:{target:"enemy",statusId:"burn",chance:0.8}}]},
  nanami:   { name:"나나미 켄토",     emoji:"🟡",grade:"1급",  atk:118,def:108,spd:90, maxHp:1380,domain:null,            desc:"1급 주술사. 합리적 판단의 소유자.",lore:"\"초과 근무는 사절이지만... 이건 의무다.\"",
    skills:[{name:"둔기 공격",minMastery:0,dmg:120,desc:"단단한 둔기로 타격.",statusApply:null},{name:"칠할삼분",minMastery:5,dmg:200,desc:"7:3 지점 약점 공격.",statusApply:{target:"enemy",statusId:"weaken",chance:0.6}},{name:"십수할",minMastery:15,dmg:290,desc:"열 배의 저주 에너지 방출.",statusApply:null},{name:"초과근무",minMastery:30,dmg:410,desc:"한계를 넘어선 폭발 강화.",statusApply:null}]},
  sukuna:   { name:"료멘 스쿠나",     emoji:"🔴",grade:"특급", atk:140,def:115,spd:120,maxHp:2500,domain:"복마어주자",    desc:"저주의 왕. 역대 최강의 저주된 영혼.",lore:"\"약한 놈이 강한 놈을 거스르는 건 죄악이다.\"",
    skills:[{name:"해",minMastery:0,dmg:145,desc:"손톱으로 베어낸다.",statusApply:{target:"enemy",statusId:"burn",chance:0.4}},{name:"팔",minMastery:5,dmg:235,desc:"공간 자체를 베어낸다.",statusApply:{target:"enemy",statusId:"weaken",chance:0.5}},{name:"푸가",minMastery:15,dmg:345,desc:"닿는 모든 것을 분해.",statusApply:{target:"enemy",statusId:"poison",chance:0.7}},{name:"복마어주자",minMastery:30,dmg:500,desc:"궁극 영역전개.",statusApply:{target:"enemy",statusId:"freeze",chance:0.9}}]},
  geto:     { name:"게토 스구루",     emoji:"🟢",grade:"특급", atk:115,def:105,spd:100,maxHp:1600,domain:null,            desc:"전 특급 주술사. 저주 달인.",lore:"\"주술사는 비주술사를 지켜야 한다.\"",
    skills:[{name:"저주 방출",minMastery:0,dmg:125,desc:"저급 저주령 방출.",statusApply:null},{name:"최대출력",minMastery:5,dmg:210,desc:"저주령 전력 방출.",statusApply:{target:"enemy",statusId:"poison",chance:0.4}},{name:"저주영조종",minMastery:15,dmg:300,desc:"수천의 저주령 조종.",statusApply:{target:"enemy",statusId:"weaken",chance:0.6}},{name:"감로대법",minMastery:30,dmg:425,desc:"모든 저주 흡수.",statusApply:{target:"enemy",statusId:"stun",chance:0.5}}]},
  maki:     { name:"마키 젠인",       emoji:"⚪",grade:"준1급",atk:122,def:110,spd:115,maxHp:1300,domain:null,            desc:"저주력 없이도 강한 주술사. HP 30% 이하 시 천여주박 각성!",lore:"\"젠인 가문 — 그 이름을 내가 직접 끝내주지.\"",awakening:{threshold:0.30,dmgMult:2.0,label:"천여주박 각성"},
    skills:[{name:"봉술",minMastery:0,dmg:122,desc:"저주 도구 봉 타격.",statusApply:null},{name:"저주창",minMastery:5,dmg:200,desc:"저주 도구 창 투척.",statusApply:{target:"enemy",statusId:"weaken",chance:0.4}},{name:"저주도구술",minMastery:15,dmg:285,desc:"다양한 저주 도구 구사.",statusApply:{target:"enemy",statusId:"burn",chance:0.5}},{name:"천개봉파",minMastery:30,dmg:400,desc:"수천 저주 도구 연속 공격.",statusApply:{target:"enemy",statusId:"stun",chance:0.6}}]},
  panda:    { name:"판다",            emoji:"🐼",grade:"2급",  atk:105,def:118,spd:85, maxHp:1400,domain:null,            desc:"저주로 만든 특이체질 주술사.",lore:"\"난 판다야. 진짜 판다.\"",
    skills:[{name:"박치기",minMastery:0,dmg:108,desc:"머리로 힘차게 들이받기.",statusApply:{target:"enemy",statusId:"stun",chance:0.2}},{name:"곰 발바닥",minMastery:5,dmg:175,desc:"두꺼운 발바닥으로 내리치기.",statusApply:null},{name:"팬더 변신",minMastery:15,dmg:255,desc:"진짜 판다로 변신해 공격.",statusApply:{target:"enemy",statusId:"weaken",chance:0.4}},{name:"고릴라 변신",minMastery:30,dmg:360,desc:"고릴라 형태로 폭발 강화.",statusApply:{target:"enemy",statusId:"stun",chance:0.5}}]},
  inumaki:  { name:"이누마키 토게",   emoji:"🟤",grade:"준1급",atk:112,def:90, spd:110,maxHp:1120,domain:null,            desc:"주술언어를 구사하는 준1급 주술사.",lore:"\"연어알—\"",
    skills:[{name:"멈춰라",minMastery:0,dmg:115,desc:"움직임 봉쇄.",statusApply:{target:"enemy",statusId:"freeze",chance:0.5}},{name:"달려라",minMastery:5,dmg:180,desc:"무작위로 달리게 한다.",statusApply:{target:"enemy",statusId:"weaken",chance:0.5}},{name:"주술언어",minMastery:15,dmg:265,desc:"강력한 주술 명령.",statusApply:{target:"enemy",statusId:"stun",chance:0.6}},{name:"폭발해라",minMastery:30,dmg:375,desc:"그 자리에서 폭발.",statusApply:{target:"enemy",statusId:"burn",chance:0.8}}]},
  yuta:     { name:"오코츠 유타",     emoji:"🌟",grade:"특급", atk:128,def:112,spd:115,maxHp:1750,domain:"진안상애",       desc:"특급 주술사. 리카의 저주를 다루는 최강급.",lore:"\"리카... 나는 아직 살아야 해.\"",
    skills:[{name:"모방술식",minMastery:0,dmg:135,desc:"다른 술식을 모방 공격.",statusApply:null},{name:"리카 소환",minMastery:5,dmg:220,desc:"저주의 여왕 리카 소환.",statusApply:{target:"enemy",statusId:"weaken",chance:0.5}},{name:"순애빔",minMastery:15,dmg:340,desc:"리카와의 순수한 사랑을 발사.",statusApply:{target:"enemy",statusId:"burn",chance:0.6}},{name:"진안상애",minMastery:30,dmg:480,desc:"영역전개 — 사랑으로 파괴.",statusApply:{target:"enemy",statusId:"freeze",chance:0.9}}]},
  higuruma: { name:"히구루마 히로미", emoji:"⚖️",grade:"1급",  atk:118,def:105,spd:95, maxHp:1320,domain:"주복사사",       desc:"전직 변호사 출신 주술사.",lore:"\"이 법정에서는 — 내가 판사다.\"",
    skills:[{name:"저주도구",minMastery:0,dmg:120,desc:"저주 에너지 도구 공격.",statusApply:null},{name:"몰수",minMastery:5,dmg:195,desc:"상대 술식 몰수.",statusApply:{target:"enemy",statusId:"weaken",chance:0.7}},{name:"사형판결",minMastery:15,dmg:285,desc:"재판 결과에 따른 제재.",statusApply:{target:"enemy",statusId:"stun",chance:0.5}},{name:"집행인 인형",minMastery:30,dmg:410,desc:"집행인 인형 소환 즉결.",statusApply:{target:"enemy",statusId:"freeze",chance:0.7}}]},
  jogo:     { name:"죠고",            emoji:"🌋",grade:"준특급",atk:125,def:100,spd:105,maxHp:1680,domain:"개관철위산",    desc:"화염을 다루는 준특급 저주령.",lore:"\"인간이야말로 진정한 저주다.\"",
    skills:[{name:"화염 분사",minMastery:0,dmg:130,desc:"강렬한 불꽃 분출.",statusApply:{target:"enemy",statusId:"burn",chance:0.5}},{name:"용암 폭발",minMastery:5,dmg:215,desc:"발밑 용암 폭발.",statusApply:{target:"enemy",statusId:"burn",chance:0.7}},{name:"극번 운",minMastery:15,dmg:315,desc:"불타는 운석 소환.",statusApply:{target:"enemy",statusId:"weaken",chance:0.5}},{name:"개관철위산",minMastery:30,dmg:460,desc:"화산 소환 궁극 영역전개.",statusApply:{target:"enemy",statusId:"burn",chance:1.0}}]},
  dagon:    { name:"다곤",            emoji:"🌊",grade:"준특급",atk:118,def:108,spd:96, maxHp:1620,domain:"탕온평선",       desc:"수중 저주령.",lore:"\"물은 모든 것을 삼킨다.\"",
    skills:[{name:"물고기 소환",minMastery:0,dmg:125,desc:"날카로운 물고기 떼 소환.",statusApply:{target:"enemy",statusId:"poison",chance:0.4}},{name:"해수 폭발",minMastery:5,dmg:205,desc:"압축 해수 발사.",statusApply:{target:"enemy",statusId:"weaken",chance:0.5}},{name:"조류 소용돌이",minMastery:15,dmg:295,desc:"거대 물 소용돌이 공격.",statusApply:{target:"enemy",statusId:"freeze",chance:0.4}},{name:"탕온평선",minMastery:30,dmg:450,desc:"물고기로 가득한 영역전개.",statusApply:{target:"enemy",statusId:"poison",chance:0.9}}]},
  hanami:   { name:"하나미",          emoji:"🌿",grade:"준특급",atk:115,def:118,spd:93, maxHp:1750,domain:null,            desc:"식물 저주령. 자연 술식 구사.",lore:"\"자연은 인간의 적이 아니다.\"",
    skills:[{name:"나무뿌리 채찍",minMastery:0,dmg:122,desc:"나무뿌리 채찍.",statusApply:{target:"enemy",statusId:"weaken",chance:0.3}},{name:"꽃비",minMastery:5,dmg:198,desc:"독성 꽃가루 강하.",statusApply:{target:"enemy",statusId:"poison",chance:0.6}},{name:"대지의 저주",minMastery:15,dmg:285,desc:"대지에 저주 에너지 확산.",statusApply:{target:"enemy",statusId:"poison",chance:0.7}},{name:"재앙의 꽃",minMastery:30,dmg:425,desc:"거대 꽃 소환 흡수.",statusApply:{target:"enemy",statusId:"stun",chance:0.6}}]},
  mahito:   { name:"마히토",          emoji:"🩸",grade:"준특급",atk:120,def:98, spd:110,maxHp:1560,domain:"자폐원돈과",   desc:"영혼을 변형하는 준특급 저주령.",lore:"\"영혼이 육체를 만드는 거야.\"",
    skills:[{name:"영혼 변형",minMastery:0,dmg:128,desc:"영혼 변형 직접 타격.",statusApply:{target:"enemy",statusId:"weaken",chance:0.4}},{name:"무위전변",minMastery:5,dmg:212,desc:"접촉 신체 기괴하게 변형.",statusApply:{target:"enemy",statusId:"stun",chance:0.4}},{name:"편사지경체",minMastery:15,dmg:308,desc:"무한 신체 변형 공격.",statusApply:{target:"enemy",statusId:"weaken",chance:0.6}},{name:"자폐원돈과",minMastery:30,dmg:455,desc:"영혼과 육체의 경계 붕괴.",statusApply:{target:"enemy",statusId:"freeze",chance:0.8}}]},
  todo:     { name:"토도 아오이",     emoji:"💪",grade:"1급",  atk:128,def:108,spd:112,maxHp:1500,domain:null,            desc:"보조 공격술 구사 1급 주술사.",lore:"\"너의 이상형은 어떤 여자야?\"",
    skills:[{name:"부기우기",minMastery:0,dmg:130,desc:"위치 전환 + 빙결 40%.",statusApply:{target:"enemy",statusId:"freeze",chance:0.40}},{name:"브루탈 펀치",minMastery:5,dmg:215,desc:"최대 저주력 파괴적 주먹.",statusApply:{target:"enemy",statusId:"weaken",chance:0.30}},{name:"흑섬",minMastery:15,dmg:320,desc:"이타도리에게 배운 흑섬!",statusApply:{target:"enemy",statusId:"burn",chance:0.45}},{name:"전투본능",minMastery:30,dmg:200,desc:"전투본능 버프!",statusApply:{target:"self",statusId:"battleInstinct",chance:1.0}}]},
  hakari:   { name:"하카리 키리토",   emoji:"🎰",grade:"1급",  atk:125,def:105,spd:110,maxHp:1650,domain:"질풍강운",       desc:"복권 술식 사용 주술사.",lore:"\"운도 실력이다! 철저하게 즐기자!\"",
    skills:[{name:"험한 도박",minMastery:0,dmg:125,desc:"운에 맡긴 도박 공격!",statusApply:{target:"enemy",statusId:"stun",chance:0.3}},{name:"질풍열차",minMastery:5,dmg:210,desc:"열차처럼 돌진!",statusApply:{target:"enemy",statusId:"weaken",chance:0.4}},{name:"유한 소설",minMastery:15,dmg:315,desc:"불멸의 몸으로 싸운다!",statusApply:{target:"self",statusId:"battleInstinct",chance:0.6}},{name:"질풍강운",minMastery:30,dmg:480,desc:"영역전개 — 운이 터진다!",statusApply:{target:"enemy",statusId:"freeze",chance:0.7}}]},
};

// ════════════════════════════════════════════════════════
// 반전술식 가능 캐릭터 (고조/유타)
// ════════════════════════════════════════════════════════
const REVERSE_CHARS = new Set(["gojo","yuta"]);

// ════════════════════════════════════════════════════════
// 적 데이터
// ════════════════════════════════════════════════════════
const ENEMIES = [
  {id:"e1",name:"저급 저주령",      emoji:"👹",hp:550, atk:38, def:12, xp:75,  crystals:18, masteryXp:1, fingers:0,statusAttack:null},
  {id:"e2",name:"1급 저주령",       emoji:"👺",hp:1100,atk:80, def:40, xp:190, crystals:40, masteryXp:3, fingers:0,statusAttack:{statusId:"poison",chance:0.3}},
  {id:"e3",name:"특급 저주령",      emoji:"💀",hp:2400,atk:128,def:72, xp:440, crystals:90, masteryXp:7, fingers:1,statusAttack:{statusId:"burn",chance:0.4}},
  {id:"e4",name:"저주의 왕 (보스)", emoji:"👑",hp:5500,atk:195,def:110,xp:1000,crystals:200,masteryXp:15,fingers:3,statusAttack:{statusId:"weaken",chance:0.5}},
  {id:"e_sukuna",name:"료멘 스쿠나 〖저주의 왕〗",emoji:"🔴",hp:5500,atk:220,def:130,xp:1500,crystals:300,masteryXp:20,fingers:1,statusAttack:{statusId:"burn",chance:0.6},isSukuna:true},
];

// ════════════════════════════════════════════════════════
// 레이드 보스
// ════════════════════════════════════════════════════════
const RAID_BOSSES = {
  heian_sukuna:{id:"heian_sukuna",name:"平安時代 스쿠나 〖헤이안 최강〗",emoji:"👹🔴",hp:11000,atk:440,def:260,xp:3000,crystals:600,masteryXp:40,fingers:3,desc:"헤이안 시대의 스쿠나.",lore:"\"나는 그 어느 시대에도 최강이었다.\"",color:0x8b0000,statusAttack:{statusId:"burn",chance:0.7},specialAttack:{name:"복마어주자",dmg:600,statusId:"freeze",chance:0.9},dropKey:"raid_heian",phaseHp:0.5,enragedAtk:600},
  mahoraga:{id:"mahoraga",name:"八握剣 異戒神将 마허라가라",emoji:"⚙️🐉",hp:6000,atk:280,def:180,xp:2500,crystals:500,masteryXp:35,fingers:2,desc:"식신 중 최강. 모든 술식에 적응하는 능력.",lore:"\"마허라가라는 천지의 이치를 먹는다.\"",color:0x2a2a2a,statusAttack:{statusId:"weaken",chance:0.6},specialAttack:{name:"팔상천마",dmg:400,statusId:"stun",chance:0.8},dropKey:"raid_mahoraga",adaptationSkill:true,phaseHp:0.4,enragedAtk:380},
};

// ════════════════════════════════════════════════════════
// 사멸회유 적
// ════════════════════════════════════════════════════════
const JUJUTSU_ENEMIES = [
  {id:"j1",name:"약화된 저주령",  emoji:"💧",hp:300, atk:25, def:8, xp:55, crystals:12,masteryXp:1, points:1,fingers:0,statusAttack:null,                           desc:"⚡ 빠르지만 약함 (1포인트)"},
  {id:"j2",name:"중간급 저주령",  emoji:"🌀",hp:620, atk:55, def:28,xp:115,crystals:28,masteryXp:2, points:1,fingers:0,statusAttack:{statusId:"weaken",chance:0.2}, desc:"⚖️ 균형잡힌 몹 (1포인트)"},
  {id:"j3",name:"강화 저주령",    emoji:"🔥",hp:450, atk:75, def:22,xp:95, crystals:23,masteryXp:2, points:1,fingers:0,statusAttack:{statusId:"burn",chance:0.35},  desc:"💥 공격적이지만 방어 낮음 (1포인트)"},
  {id:"j4",name:"특수 저주령",    emoji:"☠️",hp:960, atk:88, def:48,xp:190,crystals:45,masteryXp:4, points:2,fingers:0,statusAttack:{statusId:"poison",chance:0.4}, desc:"🧪 독 공격! (2포인트)"},
  {id:"j5",name:"엘리트 저주령",  emoji:"💀",hp:1380,atk:108,def:60,xp:280,crystals:70,masteryXp:6, points:3,fingers:1,statusAttack:{statusId:"burn",chance:0.5},   desc:"⚔️ 강력한 엘리트 (3포인트)"},
  {id:"j6",name:"사멸회유 수호자",emoji:"👹",hp:2100,atk:135,def:82,xp:440,crystals:100,masteryXp:10,points:5,fingers:2,statusAttack:{statusId:"weaken",chance:0.6},desc:"🏆 최강 수호자 (5포인트)"},
];

// ════════════════════════════════════════════════════════
// 가챠 풀
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

const CODES = {"release":{crystals:200},"sorryforbugs":{crystals:1000}};

// ════════════════════════════════════════════════════════
// 세션 저장소
// ════════════════════════════════════════════════════════
let players = {};
const battles={}, cullings={}, jujutsus={}, parties={}, partyInvites={}, pvpSessions={}, pvpChallenges={}, raidSessions={};
let _partyIdSeq=1, _pvpIdSeq=1, _raidIdSeq=1;

// ════════════════════════════════════════════════════════
// 주력 스킬
// ════════════════════════════════════════════════════════
function getMainSkill(player, charId) {
  if (charId==="gojo"&&player.mainSkillUnlocked?.gojo) return {name:"자폭 무라사키",dmg:640,desc:"모든 힘을 쏟아붓는 자폭 공격! 사용 후 HP 1"};
  if (charId==="sukuna"&&player.mainSkillUnlocked?.sukuna) return {name:"세계참",dmg:700,desc:"세계조차 베어버리는 궁극의 기술!"};
  return null;
}

// ════════════════════════════════════════════════════════
// 플레이어 유틸
// ════════════════════════════════════════════════════════
function getPlayer(userId, username="플레이어") {
  if (!players[userId]) {
    players[userId] = {
      id:userId, name:username, crystals:500, xp:0,
      owned:["itadori"], active:"itadori",
      hp:CHARACTERS["itadori"].maxHp, potion:3,
      wins:0, losses:0, mastery:{itadori:0},
      reverseOutput:1.0, reverseCooldown:0,
      cullingBest:0, jujutsuBest:0,
      usedCodes:[], lastDaily:0,
      pvpWins:0, pvpLosses:0,
      statusEffects:[], skillCooldown:0,
      dailyStreak:0, sukunaFingers:0,
      kogane:null, koganeGachaCount:0,
      mainSkillUnlocked:{gojo:false,sukuna:false},
      materials:{}, equippedWeapon:null, craftedWeapons:[],
      quests:{}, raidClears:{}, crit:5,
      domainCooldown:0, totalTurns:0,
    };
    savePlayer(userId);
  }
  const p = players[userId];
  let changed = false;
  if (p.name !== username && username !== "플레이어") { p.name = username; changed = true; }
  const defaults = {
    reverseOutput:1.0, reverseCooldown:0, mastery:{}, cullingBest:0, jujutsuBest:0,
    usedCodes:[], lastDaily:0, pvpWins:0, pvpLosses:0, statusEffects:[], skillCooldown:0,
    dailyStreak:0, sukunaFingers:0, kogane:null, koganeGachaCount:0,
    mainSkillUnlocked:{gojo:false,sukuna:false},
    materials:{}, equippedWeapon:null, craftedWeapons:[], quests:{}, raidClears:{}, crit:5,
    domainCooldown:0, totalTurns:0,
  };
  for (const [k,v] of Object.entries(defaults)) {
    if (p[k] === undefined) { p[k] = typeof v==="object"&&v!==null ? JSON.parse(JSON.stringify(v)) : v; changed = true; }
  }
  if (!p.id) { p.id = userId; changed = true; }
  if (!p.mastery) { p.mastery = {}; changed = true; }
  if (p.active && !p.mastery[p.active]) { p.mastery[p.active] = 0; changed = true; }
  if (changed) savePlayer(userId);
  return p;
}

function getMastery(player,charId) { return player.mastery?.[charId]||0; }
function getAvailableSkills(player,charId) {
  const m = getMastery(player, charId);
  const ch = CHARACTERS[charId];
  if (!ch) return [];
  return ch.skills.filter(s => s.minMastery <= m);
}
function getCurrentSkill(player,charId) {
  const skills = getAvailableSkills(player, charId);
  return skills[skills.length-1] || CHARACTERS[charId]?.skills[0];
}
function getNextSkill(player,charId) {
  const m = getMastery(player, charId);
  return CHARACTERS[charId]?.skills.find(s => s.minMastery > m) || null;
}

// ════════════════════════════════════════════════════════
// 핵심: 장착 캐릭터 기반 스탯 계산 (전투/PvP/프로필 통일)
// ════════════════════════════════════════════════════════
function getPlayerStats(player) {
  const activeId = player.active || "itadori";
  const ch = CHARACTERS[activeId];
  if (!ch) return { atk:50, def:30, maxHp:1000 };
  const kb = getKoganeBonus(player);
  const ws = getWeaponStats(player);
  const fingers = player.sukunaFingers || 0;

  if (activeId === "itadori" || activeId === "sukuna") {
    const bonus = getFingerBonus(fingers);
    return {
      atk:  Math.floor((ch.atk  + bonus.atkBonus) * kb.atk) + ws.atk,
      def:  Math.floor((ch.def  + bonus.defBonus) * kb.def) + ws.def,
      maxHp:Math.floor((ch.maxHp+ bonus.hpBonus)  * kb.hp)  + ws.hp,
    };
  }
  return {
    atk:  Math.floor(ch.atk   * kb.atk) + ws.atk,
    def:  Math.floor(ch.def   * kb.def) + ws.def,
    maxHp:Math.floor(ch.maxHp * kb.hp)  + ws.hp,
  };
}

function masteryBar(mastery, charId) {
  const ch = CHARACTERS[charId];
  if (!ch) return `숙련도: ${mastery}`;
  const tiers = ch.skills.map(s => s.minMastery);
  const max = tiers[tiers.length-1];
  if (mastery >= max) return `숙련도: ${mastery} [MAX]`;
  const next = tiers.find(t => t > mastery) || max;
  return `숙련도: ${mastery} / ${next}`;
}
function getLevel(xp) { return Math.floor((xp||0)/200)+1; }
function isMakiAwakened(player) {
  if (player.active !== "maki") return false;
  const stats = getPlayerStats(player);
  return (player.hp||0) <= Math.floor(stats.maxHp * CHARACTERS["maki"].awakening.threshold);
}
function calcDmg(atk, def, mult=1) {
  const variance = 0.70 + Math.random() * 0.60;
  return Math.max(1, Math.floor((atk * variance - def * 0.22) * mult));
}
function calcDmgForPlayer(player, enemyDef, baseMult=1) {
  const stats = getPlayerStats(player);
  let mult = baseMult * getWeakenMult(player.statusEffects||[]);
  if (isMakiAwakened(player)) mult *= CHARACTERS["maki"].awakening.dmgMult;
  if (player.active === "itadori" || player.active === "sukuna") mult *= getFingerBonus(player.sukunaFingers||0).dmgMult;
  const critChance = (player.crit||5) / 100;
  const isCrit = Math.random() < critChance;
  if (isCrit) mult *= 1.5;
  return { dmg: calcDmg(stats.atk, enemyDef||0, mult), isCrit };
}
function calcSkillDmgForPlayer(player, baseSkillDmg) {
  let dmg = (baseSkillDmg||100) + Math.floor(Math.random()*60);
  dmg = Math.floor(dmg * getWeakenMult(player.statusEffects||[]));
  if (isMakiAwakened(player)) dmg = Math.floor(dmg * CHARACTERS["maki"].awakening.dmgMult);
  if (player.active === "itadori" || player.active === "sukuna") dmg = Math.floor(dmg * getFingerBonus(player.sukunaFingers||0).dmgMult);
  dmg = Math.floor(dmg * getKoganeBonus(player).atk);
  dmg += Math.floor((getWeaponStats(player).atk||0) * 0.5);
  const isCrit = Math.random() < (player.crit||5)/100;
  if (isCrit) dmg = Math.floor(dmg * 1.5);
  return { dmg, isCrit };
}
function applySkillStatus(skill, defenderObj, attackerObj=null) {
  if (!skill.statusApply) return [];
  const {target, statusId, chance} = skill.statusApply;
  if (Math.random() > chance) return [];
  const def = STATUS_EFFECTS[statusId];
  if (!def) return [];
  if (target === "enemy") { applyStatus(defenderObj, statusId); return [`${def.emoji} **${def.name}** 상태이상 적용! (${def.duration}턴)`]; }
  if (target === "self" && attackerObj) { applyStatus(attackerObj, statusId); return [`${def.emoji} **${def.name}** 발동! (${def.duration}턴)`]; }
  return [];
}
function tickCooldowns(player) {
  if (player.reverseCooldown>0) player.reverseCooldown--;
  if (player.skillCooldown>0) player.skillCooldown--;
  if (player.domainCooldown>0) player.domainCooldown--;
  player.totalTurns = (player.totalTurns||0) + 1;
}

// 영역전개 사용 가능 여부 (15턴당 1번)
function canUseDomain(player) {
  return (player.domainCooldown||0) <= 0;
}

// ════════════════════════════════════════════════════════
// 파티/PvP 유틸
// ════════════════════════════════════════════════════════
function getPartyId(userId) { return Object.keys(parties).find(pid=>parties[pid]?.members?.includes(userId))||null; }
function getParty(userId) { const pid=getPartyId(userId); return pid?parties[pid]:null; }
function getPvpSessionByUser(userId) { return Object.values(pvpSessions).find(s=>s.p1Id===userId||s.p2Id===userId)||null; }
function pvpOpponent(session,userId) { return session.p1Id===userId ? {id:session.p2Id,hpKey:"hp2",statusKey:"status2",skillCdKey:"skillCd2",reverseCdKey:"reverseCd2",domainCdKey:"domainCd2"} : {id:session.p1Id,hpKey:"hp1",statusKey:"status1",skillCdKey:"skillCd1",reverseCdKey:"reverseCd1",domainCdKey:"domainCd1"}; }
function pvpSelf(session,userId)     { return session.p1Id===userId ? {id:session.p1Id,hpKey:"hp1",statusKey:"status1",skillCdKey:"skillCd1",reverseCdKey:"reverseCd1",domainCdKey:"domainCd1"} : {id:session.p2Id,hpKey:"hp2",statusKey:"status2",skillCdKey:"skillCd2",reverseCdKey:"reverseCd2",domainCdKey:"domainCd2"}; }
function getRaidByUser(userId) { return Object.values(raidSessions).find(r=>r.members.includes(userId))||null; }

// ════════════════════════════════════════════════════════
// 컬링/사멸회유 유틸
// ════════════════════════════════════════════════════════
function getCullingPool(wave) {
  if (wave<=3) return ["e1","e1","e1","e2"];
  if (wave<=7) return ["e1","e2","e2","e2","e3"];
  if (wave<=14) return ["e2","e2","e3","e3","e3"];
  return ["e2","e3","e3","e4","e4"];
}
function pickCullingEnemy(wave) {
  const pool=getCullingPool(wave); const id=pool[Math.floor(Math.random()*pool.length)];
  const base=ENEMIES.find(e=>e.id===id); const scale=1+(wave-1)*0.05;
  return {...base,hp:Math.floor(base.hp*scale),atk:Math.floor(base.atk*scale),def:Math.floor(base.def*scale),xp:Math.floor(base.xp*scale),crystals:Math.floor(base.crystals*scale),currentHp:Math.floor(base.hp*scale),statusEffects:[]};
}
function generateJujutsuChoices(wave) {
  const pool=wave<=3?["j1","j1","j2","j3"]:wave<=7?["j2","j3","j3","j4"]:wave<=12?["j3","j4","j4","j5"]:["j4","j5","j5","j6"];
  const ids=[]; for (const id of [...pool].sort(()=>Math.random()-0.5)) { if (!ids.includes(id)) ids.push(id); if (ids.length===3) break; }
  while (ids.length<3) { const fb=pool[Math.floor(Math.random()*pool.length)]; if (!ids.includes(fb)) ids.push(fb); }
  return ids.slice(0,3).map(id=>{ const base=JUJUTSU_ENEMIES.find(e=>e.id===id); const scale=1+(wave-1)*0.04; return {...base,hp:Math.floor(base.hp*scale),atk:Math.floor(base.atk*scale),def:Math.floor(base.def*scale),xp:Math.floor(base.xp*scale),crystals:Math.floor(base.crystals*scale),statusEffects:[]}; });
}

// ════════════════════════════════════════════════════════
// 전투 승리 공통 처리
// ════════════════════════════════════════════════════════
async function processBattleWin(player, enemy) {
  const kb=getKoganeBonus(player);
  const xpGain=Math.floor((enemy.xp||1)*kb.xp); const crystalGain=Math.floor((enemy.crystals||0)*kb.crystal);
  player.xp=(player.xp||0)+xpGain; player.crystals=(player.crystals||0)+crystalGain;
  const masteryGain=enemy.masteryXp||1;
  if (!player.mastery) player.mastery={};
  player.mastery[player.active]=(player.mastery[player.active]||0)+masteryGain;
  player.wins=(player.wins||0)+1;
  const potionChances={e1:0.35,e2:0.45,e3:0.60,e4:0.80,e_sukuna:1.00};
  let potionMsg="";
  if (Math.random()<(potionChances[enemy.id]||0.25)) {
    const gain=enemy.isSukuna?3:(enemy.id==="e4"?2:1);
    player.potion=(player.potion||0)+gain;
    potionMsg=`\n> 🧪 **회복약 +${gain}개** 드롭! (보유: **${player.potion}개**)`;
  }
  let fingerMsg="";
  if (enemy.isSukuna) {
    const gained=enemy.fingers||1; const before=player.sukunaFingers||0;
    player.sukunaFingers=Math.min(SUKUNA_FINGER_MAX,before+gained);
    if (before===0&&player.sukunaFingers>=1&&!(player.owned||[]).includes("sukuna")) {
      if (!player.owned) player.owned=["itadori"];
      player.owned.push("sukuna");
      if (!player.mastery["sukuna"]) player.mastery["sukuna"]=0;
      fingerMsg="\n\n🔴 **스쿠나 캐릭터 해금!** (`!활성`)";
    } else if (player.sukunaFingers>=1&&before<player.sukunaFingers) {
      fingerMsg=`\n\n👹 **스쿠나 손가락 +${gained}개!** (${player.sukunaFingers}/${SUKUNA_FINGER_MAX})`;
    }
  } else if (enemy.fingers) {
    player.sukunaFingers=Math.min(SUKUNA_FINGER_MAX,(player.sukunaFingers||0)+enemy.fingers);
    if (player.sukunaFingers>=1&&!(player.owned||[]).includes("sukuna")) {
      if (!player.owned) player.owned=["itadori"];
      player.owned.push("sukuna");
      if (!player.mastery["sukuna"]) player.mastery["sukuna"]=0;
      fingerMsg="\n\n🔴 **스쿠나 캐릭터 해금!**";
    }
  }
  const drops=rollDrops(enemy.isSukuna?"e_sukuna":(enemy.id||"e1")); addMaterials(player,drops);
  let unlockMsg="";
  if (player.active==="gojo"&&!player.mainSkillUnlocked?.gojo&&(player.wins||0)>=20) {
    if (!player.mainSkillUnlocked) player.mainSkillUnlocked={};
    player.mainSkillUnlocked.gojo=true; unlockMsg="\n🎉 **고조 주력 스킬 '자폭 무라사키' 획득!**";
  }
  if (player.active==="sukuna"&&!player.mainSkillUnlocked?.sukuna&&(player.sukunaFingers||0)>=10) {
    if (!player.mainSkillUnlocked) player.mainSkillUnlocked={};
    player.mainSkillUnlocked.sukuna=true; unlockMsg="\n🎉 **스쿠나 주력 스킬 '세계참' 획득!**";
  }
  updateQuestProgress(player,"battle_win",1);
  if (enemy.id==="e3"||enemy.id==="e4"||enemy.isSukuna) updateQuestProgress(player,"boss_kill",1);
  const dropText=Object.keys(drops).length>0?`\n\n📦 **재료 드롭:**\n${formatDrops(drops)}`:"";
  const questDone=getNewlyCompletedQuestMsg(player);
  return new EmbedBuilder()
    .setTitle(enemy.isSukuna?"👹 스쿠나 격파!!":"🏆 전투 승리!")
    .setColor(enemy.isSukuna?0x8b0000:0xF5C842)
    .setDescription([enemy.isSukuna?"```ansi\n\u001b[1;31m╔═══════════════════════════════╗\n║  👹  스쿠나를 쓰러뜨렸다!  👹  ║\n╚═══════════════════════════════╝\n```":"```ansi\n\u001b[1;33m╔═══════════════════════════════╗\n║       ✨  VICTORY  ✨         ║\n╚═══════════════════════════════╝\n```",`> **${enemy.name}** 처치!`,`> ⭐ XP **+${xpGain}** | 💎 **+${crystalGain}** | 📈 숙련 **+${masteryGain}**`,dropText,potionMsg,fingerMsg,unlockMsg,questDone].filter(Boolean).join("\n"))
    .addFields({name:"📊 현재 상태",value:`> 💚 HP: **${Math.max(0,player.hp||0)}** | 💎 **${player.crystals}** | 🧪 **${player.potion||0}개**\n> ⚔️ 전적: **${player.wins}승 ${player.losses||0}패**`})
    .setFooter({text:`LV.${getLevel(player.xp||0)}`});
}

function getNewlyCompletedQuestMsg(player) {
  initQuests(player); const msgs=[];
  for (const qp of player.quests.daily||[])  { if (qp.done&&!qp.claimed) { const def=DAILY_QUESTS.find(q=>q.id===qp.id);  if (def) msgs.push(`> 📋 **일일퀘 완료!** ${def.name}`); } }
  for (const qp of player.quests.weekly||[]) { if (qp.done&&!qp.claimed) { const def=WEEKLY_QUESTS.find(q=>q.id===qp.id); if (def) msgs.push(`> 📅 **주간퀘 완료!** ${def.name}`); } }
  return msgs.join("\n");
}

// ════════════════════════════════════════════════════════
// 프로필 임베드
// ════════════════════════════════════════════════════════
function profileEmbed(player) {
  const activeId = player.active || "itadori";
  const ch=CHARACTERS[activeId]; if (!ch) return new EmbedBuilder().setTitle("오류").setDescription("캐릭터 없음");
  const stats=getPlayerStats(player);
  const mastery=getMastery(player,activeId);
  const awakened=isMakiAwakened(player);
  const lv=getLevel(player.xp||0);
  const fingers=player.sukunaFingers||0;
  const fingerBonus=getFingerBonus(fingers);
  const kogane=player.kogane; const kg=kogane?KOGANE_GRADES[kogane.grade]:null;
  const gradeInfo=GACHA_RARITY[ch.grade]||GACHA_RARITY["3급"];
  const weapon=player.equippedWeapon?getWeaponByName(player.equippedWeapon):null;
  const ws=getWeaponStats(player);
  const crit=player.crit||5;
  const matSummary=Object.entries(player.materials||{}).filter(([,qty])=>qty>0).map(([id,qty])=>`${MATERIALS[id]?.emoji||""}${qty}`).join("  ")||"없음";
  initQuests(player);
  const dailyDone=(player.quests.daily||[]).filter(q=>q.done&&!q.claimed).length;
  const weeklyDone=(player.quests.weekly||[]).filter(q=>q.done&&!q.claimed).length;
  const currentSkill=getCurrentSkill(player,activeId);
  const nextSkill=getNextSkill(player,activeId);
  const mainSkill=getMainSkill(player,activeId);
  const raidStr=Object.keys(RAID_BOSSES).map(id=>{ const boss=RAID_BOSSES[id]; const count=(player.raidClears||{})[id]||0; return `${count>0?"✅":"🔒"} ${boss.emoji} ${boss.name.split("〖")[0].trim()} (${count}클)`; }).join("\n");
  const domainCD = player.domainCooldown||0;
  return new EmbedBuilder()
    .setColor(awakened?0xFF2200:gradeInfo.color)
    .setTitle(awakened?`🔥 ≪ 천여주박 각성 ≫  ${player.name}`:`${gradeInfo.effect}  ${player.name}의 주술사 카드  ${gradeInfo.effect}`)
    .addFields(
      {name:"╔══ 🏅 주술사 정보 ══════════════════════╗",value:[`> ${ch.emoji} **${ch.name}**  \`[${ch.grade}]\`  ${gradeInfo.stars}`,`> 🎖️ **LV.${lv}**  ·  ${masteryBar(mastery,activeId)}`,`> 💎 **${player.crystals||0}** 크리스탈   🧪 회복약 **${player.potion||0}**개   ⚡치명타 **${crit}%**`,`> ⚔️ 일반 \`${player.wins||0}승 ${player.losses||0}패\`   🥊 PvP \`${player.pvpWins||0}승 ${player.pvpLosses||0}패\``,`> 🌊 컬링 최고: **WAVE ${player.cullingBest||0}**   🎯 사멸회유: **${player.jujutsuBest||0}pt**`].join("\n"),inline:false},
      {name:"╔══ 💚 전투 스탯 (장착 캐릭터 기준) ══════╗",value:[`> 💚 HP: **${Math.max(0,player.hp||0)}** / **${stats.maxHp}**${awakened?" 🔥**[각성]**":""}`,`> 🗡️ ATK **${stats.atk}**  ·  🛡️ DEF **${stats.def}**  ·  💚 MaxHP **${stats.maxHp}**`,weapon?`> ${weapon.emoji} **[장착]** ${weapon.name} (ATK+${ws.atk} DEF+${ws.def} HP+${ws.hp})`:`> ⚔️ 장착 주구: **없음**`,`> 🩸 상태이상: **${statusStr(player.statusEffects||[])}**`,`> ⚡ 술식 CD: ${(player.skillCooldown||0)>0?`**${player.skillCooldown}턴**`:"✅"}   ♻ 반전 CD: ${(player.reverseCooldown||0)>0?`**${player.reverseCooldown}턴**`:"✅"}   🌌 영역 CD: ${domainCD>0?`**${domainCD}턴**`:"✅"}`,kg?`> 🐾 코가네 [${kogane.grade}] ${kg.emoji}: ${kg.passiveDesc}`:`> 🐾 코가네: **없음**`].filter(Boolean).join("\n"),inline:false},
      {name:"╔══ 🌀 술식 ══════════════════════════════╗",value:[`> **현재 스킬:** ${currentSkill?.name||"없음"} (피해: \`${currentSkill?.dmg||0}\`)`,nextSkill?`> **다음 스킬:** ${nextSkill.name} (숙련 \`${nextSkill.minMastery}\` 필요)`:"> ✨ 모든 스킬 해금!",ch.domain?`> 🌌 **영역전개:** ${ch.domain} (15턴 쿨타임)`:"> 🌌 영역전개: 없음",mainSkill?`> ⭐ **주력 스킬:** ${mainSkill.name} (해금됨)`:"",activeId==="itadori"?`> 👹 스쿠나 손가락: **${fingers}/${SUKUNA_FINGER_MAX}**  —  ${fingerBonus.label}`:""].filter(Boolean).join("\n"),inline:false},
      {name:"╔══ ⚔️ 레이드 현황 ════════════════════════╗",value:raidStr||"> 레이드 미도전",inline:false},
      {name:"╔══ 📦 재료 인벤토리 ══════════════════════╗",value:`> ${matSummary}`,inline:false},
      {name:"╔══ 📋 퀘스트 ════════════════════════════╗",value:`> 📋 일일 수령 대기: **${dailyDone}**개   📅 주간 수령 대기: **${weeklyDone}**개\n> \`!퀘스트\` 로 확인 및 보상 수령`,inline:false},
      {name:"╔══ 🎴 보유 캐릭터 ════════════════════════╗",value:(player.owned||[]).map(id=>{ const c=CHARACTERS[id]; if (!c) return ""; const m=getMastery(player,id); const ri=GACHA_RARITY[c.grade]||GACHA_RARITY["3급"]; return `> ${id===activeId?"▶️ **[활성]**":"　"}${c.emoji} **${c.name}** \`[${c.grade}]\` ${ri.stars}  숙련 \`${m}\``; }).join("\n")||"> 없음",inline:false},
    )
    .setFooter({text:`!전투 !컬링 !사멸회유 !레이드 !가챠 !퀘스트 | LV.${lv} · ${ch.name}`})
    .setTimestamp();
}

// ════════════════════════════════════════════════════════
// GIF 프로필 — 실제 DB 데이터 완전 동기화
// ════════════════════════════════════════════════════════
async function generateProfileGif(player, discordUser) {
  // ── 실제 DB에서 모든 값 추출 (undefined/null 방지)
  const activeId   = player.active || "itadori";
  const ch         = CHARACTERS[activeId] || CHARACTERS["itadori"];
  const stats      = getPlayerStats(player);          // 장착 캐릭터 기준 스탯

  const lv         = getLevel(player.xp || 0);
  const xpNow      = (player.xp || 0) % 200;
  const xpMax      = 200;                              // 레벨당 200 xp
  const crit       = player.crit || 5;
  const crystals   = player.crystals || 0;
  const potion     = player.potion || 0;
  const hp         = Math.max(0, player.hp || 0);
  const maxHp      = stats.maxHp || 1000;
  const atk        = stats.atk || 0;
  const def        = stats.def || 0;
  const fingers    = player.sukunaFingers || 0;
  const charName   = ch.name || "알 수 없음";
  const charEmoji  = ch.emoji || "❓";
  const grade      = ch.grade || "3급";
  const gradeInfo  = GACHA_RARITY[grade] || GACHA_RARITY["3급"];
  const wins       = player.wins || 0;
  const losses     = player.losses || 0;
  const pvpWins    = player.pvpWins || 0;
  const pvpLosses  = player.pvpLosses || 0;
  const mastery    = getMastery(player, activeId);
  const domainName = ch.domain || "없음";
  const domainCD   = player.domainCooldown || 0;
  const skillCD    = player.skillCooldown || 0;
  const revCD      = player.reverseCooldown || 0;
  const weapon     = player.equippedWeapon || "없음";
  const kogane     = player.kogane ? `[${player.kogane.grade}] 코가네` : "없음";
  const awakened   = isMakiAwakened(player);
  const cullingBest= player.cullingBest || 0;
  const jujutsuBest= player.jujutsuBest || 0;
  const displayName = (discordUser?.username || player.name || "플레이어").slice(0,14);

  // 등급별 RGB 테마
  const GRADE_RGB = {
    "특급": {r:245,g:200,b:66}, "준특급":{r:255,g:140,b:0}, "1급":{r:124,g:92,b:252},
    "준1급":{r:155,g:114,b:207}, "2급":{r:74,g:222,b:128}, "3급":{r:148,g:163,b:184},
  };
  const gc = GRADE_RGB[grade] || {r:148,g:163,b:184};

  const W=740, H=460;
  const encoder = new GIFEncoder(W, H);
  encoder.start();
  encoder.setRepeat(0);
  encoder.setDelay(100);
  encoder.setQuality(8);

  const chunks=[];
  const stream = encoder.createReadStream();
  stream.on("data", chunk => chunks.push(chunk));
  const streamEnd = new Promise(resolve => stream.on("end", resolve));

  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext("2d");

  // 아바타 미리 로드
  let avatar = null;
  try {
    const url = discordUser?.displayAvatarURL?.({ extension:"png", size:128, forceStatic:true });
    if (url) avatar = await loadImage(url);
  } catch(e) { console.warn("[GIF] 아바타 로드 실패:", e.message); }

  const FRAMES = 24;

  for (let f = 0; f < FRAMES; f++) {
    const t   = f / FRAMES;
    const sin = Math.sin(t * Math.PI * 2);
    const pulse = (sin + 1) / 2; // 0~1

    // ── 배경
    const bg = ctx.createLinearGradient(0,0,W,H);
    if (awakened) {
      bg.addColorStop(0, `rgb(${30+Math.floor(pulse*20)},5,5)`);
      bg.addColorStop(1, `rgb(${60+Math.floor(pulse*20)},10,15)`);
    } else {
      bg.addColorStop(0, "#06061a");
      bg.addColorStop(0.5, "#0c0c26");
      bg.addColorStop(1, "#101030");
    }
    ctx.fillStyle = bg;
    ctx.fillRect(0,0,W,H);

    // ── 배경 파티클
    for (let i=0; i<22; i++) {
      const px = (i*47 + f*9 + i*13) % W;
      const py = (i*41 + f*7 + i*19) % H;
      const pr = 1.2 + pulse*1.8;
      const pa = 0.10 + pulse*0.20;
      ctx.beginPath();
      ctx.arc(px, py, pr, 0, Math.PI*2);
      ctx.fillStyle = `rgba(${gc.r},${gc.g},${gc.b},${pa})`;
      ctx.fill();
    }

    // ── 외부 테두리 글로우
    const glowA = 0.35 + pulse * 0.65;
    ctx.shadowColor = `rgba(${gc.r},${gc.g},${gc.b},${glowA})`;
    ctx.shadowBlur = 16;
    ctx.strokeStyle = `rgba(${gc.r},${gc.g},${gc.b},${glowA})`;
    ctx.lineWidth = 3;
    ctx.strokeRect(5,5,W-10,H-10);
    ctx.shadowBlur = 0;

    // ── 내부 패널
    ctx.fillStyle = "rgba(0,0,0,0.58)";
    ctx.fillRect(18,18,W-36,H-36);
    ctx.strokeStyle = `rgba(${gc.r},${gc.g},${gc.b},0.18)`;
    ctx.lineWidth = 1;
    ctx.strokeRect(18,18,W-36,H-36);

    // ── 세로 구분선 (좌측 패널 / 우측 패널)
    ctx.strokeStyle = `rgba(${gc.r},${gc.g},${gc.b},0.20)`;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(215,25); ctx.lineTo(215,H-25); ctx.stroke();

    // ─────────────────────────────────────────
    // 좌측 패널 — 아바타 + 기본 정보
    // ─────────────────────────────────────────
    const aCX=115, aCY=105, aR=68;

    // 아바타 글로우 링
    ctx.save();
    ctx.shadowBlur = 20+pulse*14;
    ctx.shadowColor = `rgba(${gc.r},${gc.g},${gc.b},0.9)`;
    ctx.beginPath(); ctx.arc(aCX,aCY,aR+4,0,Math.PI*2);
    ctx.strokeStyle = `rgba(${gc.r},${gc.g},${gc.b},${0.55+pulse*0.45})`;
    ctx.lineWidth = 3.5; ctx.stroke();
    ctx.restore();

    // 회전 장식 링
    ctx.save();
    ctx.translate(aCX, aCY);
    ctx.rotate(t * Math.PI * 2 * 0.3);
    ctx.strokeStyle = `rgba(${gc.r},${gc.g},${gc.b},${0.25+pulse*0.15})`;
    ctx.lineWidth = 1;
    ctx.setLineDash([6,10]);
    ctx.beginPath(); ctx.arc(0,0,aR+10,0,Math.PI*2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // 아바타 클립
    ctx.save();
    ctx.beginPath(); ctx.arc(aCX,aCY,aR,0,Math.PI*2); ctx.clip();
    if (avatar) {
      ctx.drawImage(avatar, aCX-aR, aCY-aR, aR*2, aR*2);
    } else {
      ctx.fillStyle = "#1a1a3a";
      ctx.fillRect(aCX-aR,aCY-aR,aR*2,aR*2);
      ctx.font = "bold 36px sans-serif";
      ctx.fillStyle = `rgba(${gc.r},${gc.g},${gc.b},0.9)`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("?", aCX, aCY);
    }
    ctx.restore();

    // 각성 오버레이
    if (awakened) {
      ctx.save();
      ctx.beginPath(); ctx.arc(aCX,aCY,aR,0,Math.PI*2); ctx.clip();
      ctx.fillStyle = `rgba(255,30,0,${0.15+pulse*0.10})`;
      ctx.fillRect(aCX-aR,aCY-aR,aR*2,aR*2);
      ctx.restore();
    }

    ctx.shadowBlur = 0;
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "center";

    // 닉네임 — 실제 discordUser 닉네임
    ctx.font = "bold 14px sans-serif";
    ctx.shadowBlur = 8+pulse*5;
    ctx.shadowColor = `rgba(${gc.r},${gc.g},${gc.b},1)`;
    ctx.fillStyle = `rgb(${gc.r},${gc.g},${gc.b})`;
    ctx.fillText(displayName, aCX, 195);

    // 등급 + 별
    ctx.shadowBlur = 0;
    ctx.font = "11px sans-serif";
    ctx.fillStyle = `rgba(${gc.r},${gc.g},${gc.b},0.75)`;
    ctx.fillText(`[${grade}] ${gradeInfo.stars}`, aCX, 210);

    // 전적
    ctx.font = "11px sans-serif";
    ctx.fillStyle = "#9999bb";
    ctx.fillText(`${wins}승 ${losses}패  |  PvP ${pvpWins}승`, aCX, 225);

    // 컬링/사멸회유
    ctx.font = "10px sans-serif";
    ctx.fillStyle = "#7777aa";
    ctx.fillText(`🌊${cullingBest}W  🎯${jujutsuBest}pt`, aCX, 240);

    // 각성 표시
    if (awakened) {
      ctx.font = "bold 11px sans-serif";
      ctx.fillStyle = `rgba(255,${60+Math.floor(pulse*80)},0,${0.9+pulse*0.1})`;
      ctx.fillText("🔥 천여주박 각성!", aCX, 258);
    }

    ctx.shadowBlur = 0;
    ctx.textAlign = "left";

    // ─────────────────────────────────────────
    // 우측 패널 — 실제 DB 데이터 표시
    // ─────────────────────────────────────────
    const PX = 228;
    let PY = 38;

    // 섹션 헤더
    function drawSection(label) {
      PY += 4;
      ctx.font = "bold 11px monospace";
      const ga = 0.55 + pulse*0.35;
      ctx.fillStyle = `rgba(${gc.r},${gc.g},${gc.b},${ga})`;
      ctx.fillText(`─── ${label} ───`, PX, PY);
      PY += 15;
    }

    // 데이터 행: 라벨 + 값
    function drawRow(label, value, valueColor) {
      ctx.font = "11px monospace";
      ctx.fillStyle = "#7788aa";
      ctx.fillText(label, PX, PY);
      ctx.font = "bold 12px monospace";
      ctx.fillStyle = valueColor || "#e0e0ff";
      ctx.fillText(String(value ?? "없음"), PX + 140, PY);
      PY += 18;
    }

    // 두 값을 같은 줄에
    function drawRowDouble(l1,v1,l2,v2,c1,c2) {
      ctx.font = "11px monospace";
      ctx.fillStyle = "#7788aa";
      ctx.fillText(l1, PX, PY);
      ctx.font = "bold 12px monospace";
      ctx.fillStyle = c1||"#e0e0ff";
      ctx.fillText(String(v1??"0"), PX+100, PY);
      ctx.font = "11px monospace";
      ctx.fillStyle = "#7788aa";
      ctx.fillText(l2, PX+230, PY);
      ctx.font = "bold 12px monospace";
      ctx.fillStyle = c2||"#e0e0ff";
      ctx.fillText(String(v2??"0"), PX+330, PY);
      PY += 18;
    }

    // ── 캐릭터 섹션
    drawSection("캐릭터");
    const charDisplayStr = `${charName} [${grade}]`;
    ctx.font = "bold 12px monospace";
    ctx.fillStyle = `rgb(${gc.r},${gc.g},${gc.b})`;
    ctx.fillText(charDisplayStr.slice(0,22), PX, PY);
    PY += 18;
    drawRow("레벨", `LV. ${lv}`, "#ffd966");
    drawRow("EXP", `${xpNow} / ${xpMax}`, "#88ffcc");
    drawRow("숙련도", `${mastery}${mastery>=30?" [MAX]":""}`, "#aaffee");

    // ── 전투 스탯 섹션
    drawSection("전투 스탯");
    const hpPct = maxHp > 0 ? hp/maxHp : 0;
    const hpColor = hpPct>0.5 ? "#66ff88" : hpPct>0.25 ? "#ffdd44" : "#ff5555";
    drawRow("HP", `${hp} / ${maxHp}`, hpColor);
    drawRowDouble("ATK", atk, "DEF", def, "#ffaaaa", "#aaccff");
    drawRow("치명타", `${crit}%`, "#ffcc44");

    // ── 자원 섹션
    drawSection("자원");
    drawRow("크리스탈 💎", `${crystals.toLocaleString()}`, "#ccaaff");
    drawRow("회복약 🧪", `${potion}개`, "#aaffaa");
    if (activeId==="itadori"||activeId==="sukuna") {
      drawRow("스쿠나 손가락", `${fingers} / ${SUKUNA_FINGER_MAX}`, "#ff8888");
    }

    // ── 쿨타임 섹션
    drawSection("쿨타임 현황");
    drawRow("술식", skillCD>0?`${skillCD}턴`:"✅ 사용가능", skillCD>0?"#ff8866":"#88ff88");
    drawRow("반전술식", revCD>0?`${revCD}턴`:(REVERSE_CHARS.has(activeId)?"✅ 사용가능":"사용불가"), revCD>0?"#ff8866":REVERSE_CHARS.has(activeId)?"#88ff88":"#666688");
    drawRow("영역전개", domainCD>0?`${domainCD}턴`:(domainName!=="없음"?"✅ 사용가능":"없음"), domainCD>0?"#ff8866":domainName!=="없음"?"#88ff88":"#666688");

    // ── 장착 섹션
    drawSection("장착 정보");
    const weaponDisplay = weapon==="없음"?"없음":weapon.slice(0,12);
    drawRow("주구", weaponDisplay, "#ffdd88");
    drawRow("코가네 펫", kogane, "#ffcc44");
    drawRow("영역전개", domainName.slice(0,14), `rgb(${gc.r},${gc.g},${gc.b})`);

    // ── 하단 워터마크
    ctx.textAlign = "center";
    ctx.font = "10px sans-serif";
    ctx.fillStyle = `rgba(${gc.r},${gc.g},${gc.b},${0.18+pulse*0.12})`;
    ctx.fillText("주술회전 RPG  |  !전투 !컬링 !가챠", W/2, H-8);
    ctx.textAlign = "left";

    encoder.addFrame(ctx);
  }

  encoder.finish();
  await streamEnd;
  return Buffer.concat(chunks);
}

// ════════════════════════════════════════════════════════
// 가챠 컷씬
// ════════════════════════════════════════════════════════
function gachaLoadingEmbed(stage=1) {
  const frames=[
    {title:"🔮 주술 소환 의식 — 저주 에너지 수렴",color:0x0a0a1e,desc:"```ansi\n\u001b[2;30m╔══════════════════════════════════════╗\n║  ？    ？    ？    ？    ？       ║\n║      저주 에너지가 수렴하기 시작한다...   ║\n╚══════════════════════════════════════╝\n```\n> *어둠 속에서 무언가가 움직이기 시작한다...*"},
    {title:"⚡ 저주 에너지 임계점 돌파!",color:0x1a0533,desc:"```ansi\n\u001b[1;35m╔══════════════════════════════════════╗\n║  ⚡  ✦  ？？？  ⚡  ✦  ？？？      ║\n║      주술 에너지가 임계점에 도달한다!     ║\n╚══════════════════════════════════════╝\n```\n> *주변 공간이 강렬한 에너지로 일렁인다...*"},
    {title:"🌟 소환 개시! 저주력 최대 방출!",color:0x2a0a5a,desc:"```ansi\n\u001b[1;36m╔══════════════════════════════════════╗\n║  🌟  S U M M O N   S T A R T  🌟   ║\n║      저주력이 최대로 폭발한다!!       ║\n╚══════════════════════════════════════╝\n```\n> *눈부신 섬광과 함께 새로운 주술사가 모습을 드러낸다...*"},
  ];
  const f=frames[stage-1]||frames[0];
  return new EmbedBuilder().setTitle(f.title).setColor(f.color).setDescription(f.desc);
}
function gachaRevealEmbed(grade) {
  const info=GACHA_RARITY[grade]||GACHA_RARITY["3급"];
  const specialFrames={"특급":"```ansi\n\u001b[1;33m╔══════════════════════════════════════╗\n║  ✨🔱✨  L E G E N D A R Y  ✨🔱✨  ║\n║        특급 주술사 소환!!              ║\n╚══════════════════════════════════════╝\n```","준특급":"```ansi\n\u001b[1;31m╔══════════════════════════════════════╗\n║  💠💠💠    E P I C    💠💠💠        ║\n║          준특급 등급 소환!              ║\n╚══════════════════════════════════════╝\n```","1급":"```ansi\n\u001b[1;35m╔══════════════════════════════════════╗\n║  ⭐⭐⭐    R A R E    ⭐⭐⭐         ║\n║           1급 주술사 소환!             ║\n╚══════════════════════════════════════╝\n```"};
  const art=specialFrames[grade]||`\`\`\`ansi\n\u001b[1;32m╔══════════════════════════════════════╗\n║           ${grade} 주술사 소환!            ║\n╚══════════════════════════════════════╝\n\`\`\``;
  return new EmbedBuilder().setTitle(`${info.effect} ${grade} 등급의 기운이 느껴진다!`).setColor(info.color).setDescription(art+`\n> *${info.stars}  —  ${info.flash}!*`);
}
function gachaResultEmbed(charId, isNew, player) {
  const ch=CHARACTERS[charId]; if (!ch) return new EmbedBuilder().setTitle("오류");
  const info=GACHA_RARITY[ch.grade]||GACHA_RARITY["3급"];
  return new EmbedBuilder().setTitle(isNew?`${info.effect} ✨ NEW! — ${ch.name} 획득!`:`${info.effect} 중복 — ${ch.name} (+50💎)`).setColor(isNew?info.color:0x4a5568).setDescription(`> *"${ch.lore||ch.desc}"*`).addFields({name:"🌌 영역전개",value:ch.domain||"없음",inline:true},{name:"⚔️ 등급",value:`${info.stars} \`[${ch.grade}]\``,inline:true},{name:"📖 설명",value:ch.desc,inline:false}).setFooter({text:`💎 잔여: ${player.crystals||0}`});
}
function gacha10ResultEmbed(results, newOnes, dupCrystals, player) {
  const sorted=[...results].sort((a,b)=>{const o=["특급","준특급","1급","준1급","2급","3급"];return o.indexOf(CHARACTERS[a]?.grade)-o.indexOf(CHARACTERS[b]?.grade);});
  const lines=sorted.map(id=>{ const ch=CHARACTERS[id]; if (!ch) return ""; const info=GACHA_RARITY[ch.grade]||GACHA_RARITY["3급"]; const isN=newOnes.includes(id); return `${ch.emoji} ${info.stars} **${ch.name}** \`[${ch.grade}]\`${isN?" **✨NEW!**":""}`; });
  const legendaries=results.filter(id=>CHARACTERS[id]?.grade==="특급");
  const header=legendaries.length>0?"```ansi\n\u001b[1;33m╔══════════════════════════════════════╗\n║  🔱  특급 등급 획득!!  🔱             ║\n╚══════════════════════════════════════╝\n```":"```ansi\n\u001b[1;34m╔══════════════════════════════════════╗\n║  🎲  10연차 소환 결과  🎲             ║\n╚══════════════════════════════════════╝\n```";
  return new EmbedBuilder().setTitle(legendaries.length>0?`🔱 ⚡ 10연차 — 특급 등급 획득!!`:`🎲 10회 주술 소환 결과`).setColor(legendaries.length>0?0xF5C842:0x7c5cfc).setDescription(header+lines.join("\n")).addFields({name:"✨ 신규 획득",value:newOnes.length?newOnes.map(id=>`${CHARACTERS[id]?.emoji||""} ${CHARACTERS[id]?.name||id}`).join(", "):"없음",inline:true},{name:"🔄 중복 보상",value:`**+${dupCrystals}** 💎`,inline:true},{name:"💎 잔여",value:`**${player.crystals||0}**`,inline:true});
}

function koganeLoadingEmbed(stage=1) {
  const frames=[{title:"🐾 코가네 소환 의식",color:0x2a1500,desc:"```ansi\n\u001b[2;33m╔══════════════════════════════════════╗\n║  🐾  황금 개의 기운이 느껴진다...     ║\n╚══════════════════════════════════════╝\n```"},{title:"✨ 황금빛 기운 폭발!",color:0xF5A800,desc:"```ansi\n\u001b[1;33m╔══════════════════════════════════════╗\n║  ✨  황금빛이 폭발한다!!  ✨         ║\n╚══════════════════════════════════════╝\n```"},{title:"🌟 코가네 소환 완료!",color:0xFFD700,desc:"```ansi\n\u001b[1;33m╔══════════════════════════════════════╗\n║  🌟  K O G A N E   S U M M O N E D  🌟  ║\n╚══════════════════════════════════════╝\n```"}];
  return new EmbedBuilder().setTitle(frames[stage-1].title).setColor(frames[stage-1].color).setDescription(frames[stage-1].desc);
}
function koganeRevealEmbed(grade, isUpgrade, player) {
  const kg=KOGANE_GRADES[grade]; if (!kg) return new EmbedBuilder().setTitle("오류");
  const prevGrade=player.kogane?.grade;
  return new EmbedBuilder().setColor(kg.color).setTitle(isUpgrade?`${kg.emoji} 코가네 등급 상승!! ${prevGrade?`[${prevGrade} → ${grade}]`:`[${grade}]`}`:`${kg.emoji} 코가네 소환! [${grade}] ${kg.stars}`).setDescription([isUpgrade?"```ansi\n\u001b[1;33m║  🆙  GRADE  UP!!  코가네 각성!  🆙  ║\n```":"```ansi\n\u001b[1;33m║  🐾  KOGANE  SUMMONED!  🐾         ║\n```",`> 🌟 **${grade} 등급** ${kg.stars}`,`> 📖 **패시브:** ${kg.passiveDesc}`,!isUpgrade?`> 🔄 중복 — **+50**💎`:`> ✨ 등급 상승!`,`> 💎 남은 크리스탈: **${player.crystals||0}**💎`].filter(Boolean).join("\n")).addFields({name:"📊 스탯 보너스",value:`ATK +${Math.round(kg.atkBonus*100)}%\nDEF +${Math.round(kg.defBonus*100)}%\nHP +${Math.round(kg.hpBonus*100)}%`,inline:true},{name:"📈 보상 보너스",value:`XP +${Math.round(kg.xpBonus*100)}%\n크리스탈 +${Math.round(kg.crystalBonus*100)}%`,inline:true});
}
function koganeProfileEmbed(player) {
  const kogane=player.kogane;
  if (!kogane) return new EmbedBuilder().setTitle("🐾 코가네 — 황금 개 펫").setColor(0x4a5568).setDescription("> **코가네**가 없습니다!\n> `!코가네가챠` 로 소환하세요! (200💎)").setFooter({text:"!코가네가챠 (200💎)"});
  const kg=KOGANE_GRADES[kogane.grade]; if (!kg) return new EmbedBuilder().setTitle("오류");
  return new EmbedBuilder().setTitle(`${kg.emoji} 코가네 [${kogane.grade}] ${kg.stars}`).setColor(kg.color).setDescription([`> **패시브:** ${kg.passiveDesc}`,`> **스킬:** ${kg.skill} — ${kg.skillDesc}`].join("\n")).addFields({name:"📊 스탯 보너스",value:`ATK +${Math.round(kg.atkBonus*100)}%\nDEF +${Math.round(kg.defBonus*100)}%\nHP +${Math.round(kg.hpBonus*100)}%`,inline:true},{name:"📈 보상 보너스",value:`XP +${Math.round(kg.xpBonus*100)}%\n크리스탈 +${Math.round(kg.crystalBonus*100)}%`,inline:true}).setFooter({text:`총 소환 횟수: ${player.koganeGachaCount||0}회`});
}

function questEmbed(player) {
  initQuests(player);
  const embed=new EmbedBuilder().setTitle("📋 퀘스트 현황").setColor(0x7C5CFC).setTimestamp();
  const dailyLines=(player.quests.daily||[]).map((qp,i)=>{ const def=DAILY_QUESTS.find(q=>q.id===qp.id); if (!def) return ""; const bar=`\`${"█".repeat(Math.floor(qp.progress/def.target*8))}${"░".repeat(8-Math.floor(qp.progress/def.target*8))}\``; const status=qp.claimed?"✅ 수령 완료":qp.done?`🎁 수령 가능 (\`!퀘보상 일 ${i+1}\`)`:`${bar} ${qp.progress}/${def.target}`; const rew=`+${def.reward.crystals}💎 +${def.reward.xp}XP`; return `> **[${i+1}] ${def.name}** — ${def.desc}\n> ${status}  |  보상: ${rew}`; }).filter(Boolean).join("\n\n");
  const weeklyLines=(player.quests.weekly||[]).map((qp,i)=>{ const def=WEEKLY_QUESTS.find(q=>q.id===qp.id); if (!def) return ""; const bar=`\`${"█".repeat(Math.floor(qp.progress/def.target*8))}${"░".repeat(8-Math.floor(qp.progress/def.target*8))}\``; const status=qp.claimed?"✅ 수령 완료":qp.done?`🎁 수령 가능 (\`!퀘보상 주 ${i+1}\`)`:`${bar} ${qp.progress}/${def.target}`; const rew=`+${def.reward.crystals}💎 +${def.reward.xp}XP`; return `> **[${i+1}] ${def.name}** — ${def.desc}\n> ${status}  |  보상: ${rew}`; }).filter(Boolean).join("\n\n");
  embed.addFields({name:"📋 ── 일일 퀘스트",value:dailyLines||"> 없음",inline:false},{name:"📅 ── 주간 퀘스트",value:weeklyLines||"> 없음",inline:false});
  embed.setFooter({text:"!퀘보상 일 [번호] | !퀘보상 주 [번호]"});
  return embed;
}
function materialsEmbed(player) {
  const mats=player.materials||{};
  const lines=Object.entries(MATERIALS).map(([id,m])=>`> ${m.emoji} **${m.name}** ×${mats[id]||0}  — ${m.desc}`);
  return new EmbedBuilder().setTitle("📦 재료 인벤토리").setColor(0x7c5cfc).setDescription(lines.join("\n")).setFooter({text:"!주구목록 — 주구 목록 및 제작 | !주구제작 [이름]"});
}
function weaponListEmbed(player) {
  const mats=player.materials||{};
  const lines=Object.entries(WEAPONS).map(([name,w])=>{ const canCraft=Object.entries(w.recipe).every(([m,qty])=>(mats[m]||0)>=qty); const owned=(player.craftedWeapons||[]).includes(w.id); const equipped=player.equippedWeapon===name; const recipeStr=Object.entries(w.recipe).map(([m,qty])=>`${MATERIALS[m]?.emoji||""}${mats[m]||0}/${qty}`).join(" "); return `> ${equipped?"⚔️[장착]":owned?"✅[보유]":"🔒[미제작]"} **${w.emoji} ${name}** \`[${w.grade}]\`\n> ATK+${w.atkBonus} DEF+${w.defBonus} HP+${w.hpBonus}\n> 재료: ${recipeStr}  ${canCraft&&!owned?"**✨ 제작 가능!**":""}`;});
  return new EmbedBuilder().setTitle("⚔️ 주구 (무기) 목록").setColor(0xF5C842).setDescription(lines.join("\n\n")).setFooter({text:"!주구제작 [무기이름] | !장착 [무기이름] | !해제"});
}
function cullingEmbed(player,session,log=[]) {
  const ch=CHARACTERS[player.active]||CHARACTERS["itadori"]; const stats=getPlayerStats(player); const enemy=session.currentEnemy; const awakened=isMakiAwakened(player);
  return new EmbedBuilder().setTitle(`${awakened?"🔥 ":""}⚔️ 컬링 게임 — 🌊 WAVE ${session.wave}`).setColor(awakened?0xFF2200:session.wave>=15?0xF5C842:session.wave>=8?0xe63946:0x7C5CFC).setDescription(log.length?log.join("\n"):"⚔️ 새 파도가 밀려온다!")
    .addFields({name:`${ch.emoji} 내 HP${awakened?" 🔥[각성]":""}`,value:`💚 \`${Math.max(0,player.hp||0)}/${stats.maxHp}\`\n🩸 상태: ${statusStr(player.statusEffects||[])}\n⚡ 술식: \`${(player.skillCooldown||0)>0?(player.skillCooldown+"턴"):"✅"}\` ♻ 반전: \`${(player.reverseCooldown||0)>0?(player.reverseCooldown+"턴"):"✅"}\` 🌌영역: \`${(player.domainCooldown||0)>0?(player.domainCooldown+"턴"):"✅"}\``,inline:true},{name:`${enemy.emoji} ${enemy.name}`,value:`💚 \`${Math.max(0,session.enemyHp)}/${enemy.hp}\`\n🩸 상태: ${statusStr(enemy.statusEffects||[])}\n🗡️ ATK **${enemy.atk}** · 🛡️ DEF **${enemy.def}**`,inline:true},{name:"📊 현황",value:`🌊 WAVE **${session.wave}** | 처치 **${session.kills}** | 🎯 **${session.totalXp}** XP / **${session.totalCrystals}**💎\n🏆 최고: **WAVE ${player.cullingBest||0}**`,inline:false})
    .setFooter({text:`🔥 현재 스킬: ${getCurrentSkill(player,player.active)?.name||"없음"} — 흑섬 10%`});
}
function jujutsuEmbed(player,session,log=[],choices=null) {
  const ch=CHARACTERS[player.active]||CHARACTERS["itadori"]; const stats=getPlayerStats(player); const awakened=isMakiAwakened(player);
  const embed=new EmbedBuilder().setTitle(`🎯 사멸회유 — WAVE ${session.wave} | 포인트 **${session.points}**/15`).setColor(session.points>=10?0xF5C842:session.points>=5?0xff8c00:0x7C5CFC).setDescription(log.length?log.join("\n"):"🎯 사멸회유 진행 중!")
    .addFields({name:`${ch.emoji} 내 HP${awakened?" 🔥[각성]":""}`,value:`💚 \`${Math.max(0,player.hp||0)}/${stats.maxHp}\`\n🩸 상태: ${statusStr(player.statusEffects||[])}\n⚡ 술식: \`${(player.skillCooldown||0)>0?(player.skillCooldown+"턴"):"✅"}\` 🌌영역: \`${(player.domainCooldown||0)>0?(player.domainCooldown+"턴"):"✅"}\``,inline:false});
  embed.addFields({name:"🎯 포인트 진행도",value:`${"🟦".repeat(Math.min(session.points,15))}${"⬜".repeat(Math.max(0,15-session.points))} **${session.points}/15**\n📊 누적 XP: **${session.totalXp}** / 누적 💎: **${session.totalCrystals}**`,inline:false});
  if (session.currentEnemy) { const enemy=session.currentEnemy; embed.addFields({name:`${enemy.emoji} 현재 적: ${enemy.name}`,value:`💚 \`${Math.max(0,session.enemyHp)}/${enemy.hp}\`\n🩸 상태: ${statusStr(enemy.statusEffects||[])}\n🎯 처치 시 +${enemy.points}점`,inline:false}); }
  if (choices) embed.addFields({name:"⚔️ 다음 적 선택",value:choices.map((c,i)=>`**[${i+1}]** ${c.emoji} ${c.name} — HP:\`${c.hp}\` ATK:\`${c.atk}\` | +${c.points}점\n└ ${c.desc}`).join("\n"),inline:false});
  embed.setFooter({text:`🏆 최고 기록: ${player.jujutsuBest||0}pt | 15pt 달성 시 +300💎 +500XP 보너스!`});
  return embed;
}
function pvpEmbed(session,log=[]) {
  const p1=players[session.p1Id],p2=players[session.p2Id];
  if (!p1||!p2) return new EmbedBuilder().setTitle("PvP 오류").setColor(0xe63946).setDescription("플레이어 정보 없음");
  const ch1=CHARACTERS[p1.active]||CHARACTERS["itadori"],ch2=CHARACTERS[p2.active]||CHARACTERS["itadori"];
  const domainCD1 = session.domainCd1||0, domainCD2 = session.domainCd2||0;
  return new EmbedBuilder().setTitle(`⚔️ PvP 결투  ${p1.name} VS ${p2.name}`).setColor(0xF5C842).setDescription(log.length?log.join("\n"):"⚔️ 결투 시작!")
    .addFields(
      {name:`${ch1.emoji} ${p1.name} [${ch1.grade}]${session.turn===session.p1Id?" ◀ **[내 턴]**":""}`,value:`💚 \`${Math.max(0,session.hp1)}/${session.maxHp1}\`\n🩸 ${statusStr(session.status1||[])}\n⚡술식: ${(session.skillCd1||0)>0?`\`${session.skillCd1}턴\``:"✅"}  ♻반전: ${(session.reverseCd1||0)>0?`\`${session.reverseCd1}턴\``:"✅"}  🌌영역: ${domainCD1>0?`\`${domainCD1}턴\``:"✅"}`,inline:true},
      {name:`${ch2.emoji} ${p2.name} [${ch2.grade}]${session.turn===session.p2Id?" ◀ **[내 턴]**":""}`,value:`💚 \`${Math.max(0,session.hp2)}/${session.maxHp2}\`\n🩸 ${statusStr(session.status2||[])}\n⚡술식: ${(session.skillCd2||0)>0?`\`${session.skillCd2}턴\``:"✅"}  ♻반전: ${(session.reverseCd2||0)>0?`\`${session.reverseCd2}턴\``:"✅"}  🌌영역: ${domainCD2>0?`\`${domainCD2}턴\``:"✅"}`,inline:true},
      {name:"🎯 턴 정보",value:`> **${session.turn===session.p1Id?p1.name:p2.name}** 의 차례! (Round ${session.round})`,inline:false}
    )
    .setFooter({text:"술식 5턴쿨 | 반전 3턴쿨 (고조/유타) | 영역전개 15턴쿨"});
}
function raidEmbed(raidSession,log=[]) {
  const boss=RAID_BOSSES[raidSession.bossId]; if (!boss) return new EmbedBuilder().setTitle("오류");
  const enraged=raidSession.enraged;
  const memberLines=raidSession.members.map(uid=>{ const p=players[uid]; if (!p) return `> ❓`; const ch=CHARACTERS[p.active]||CHARACTERS["itadori"],stats=getPlayerStats(p); const aw=isMakiAwakened(p); const pct=Math.max(0,p.hp||0)/stats.maxHp; const icon=pct>0.6?"🟢":pct>0.3?"🟡":"🔴"; return `> ${ch.emoji} **${p.name}** ${icon} \`${Math.max(0,p.hp||0)}/${stats.maxHp}\`${aw?" 🔥[각성]":""}`; }).join("\n");
  const adaptedStr=raidSession.adaptedSkills?.length?`\n> 🔄 적응된 술식: ${raidSession.adaptedSkills.join(", ")}`:"";
  return new EmbedBuilder().setTitle(`${boss.emoji} 레이드: ${boss.name}`).setColor(enraged?0xff0000:boss.color).setDescription([enraged?"```ansi\n\u001b[1;31m║  ⚠️  ENRAGED — 분노 페이즈!  ⚠️  ║\n```":"",log.length?log.join("\n"):"⚔️ 레이드 진행 중!"].filter(Boolean).join("\n"))
    .addFields({name:`${boss.emoji} ${boss.name}`,value:`💚 \`${Math.max(0,raidSession.hp)}/${boss.hp}\`\n🗡️ ATK: **${enraged?boss.enragedAtk:boss.atk}**  |  🛡️ DEF: **${boss.def}**${adaptedStr}`,inline:false},{name:`👥 파티 (${raidSession.members.length}명)`,value:memberLines||"> 없음",inline:false})
    .setFooter({text:"레이드 — 파티원 누구나 행동 가능"});
}
function partyCullingEmbed(party,session,log=[]) {
  const enemy=session.currentEnemy;
  const memberLines=party.members.map(uid=>{ const p=players[uid]; if (!p) return `> ❓`; const ch=CHARACTERS[p.active]||CHARACTERS["itadori"],stats=getPlayerStats(p),aw=isMakiAwakened(p); const pct=Math.max(0,p.hp||0)/stats.maxHp; const icon=pct>0.5?"🟢":pct>0.3?"🟡":"🔴"; return `> ${party.leader===uid?"👑":"👤"} **${p.name}** ${ch.emoji} ${icon} \`${Math.max(0,p.hp||0)}/${stats.maxHp}\`${aw?" 🔥":""}`; }).join("\n");
  return new EmbedBuilder().setTitle(`⚔️ [파티] 컬링 게임 — 🌊 WAVE ${session.wave}`).setColor(session.wave>=15?0xF5C842:session.wave>=8?0xe63946:0x7C5CFC).setDescription(log.length?log.join("\n"):"⚔️ 파티 컬링 진행 중!")
    .addFields({name:`👥 파티원 (${party.members.length}명)`,value:memberLines||"없음",inline:false},{name:`${enemy.emoji} ${enemy.name}`,value:`💚 \`${Math.max(0,session.enemyHp)}/${enemy.hp}\`\n🩸 상태: ${statusStr(enemy.statusEffects||[])}\n🗡️ ATK: ${enemy.atk} · 🛡️ DEF: ${enemy.def}`,inline:false},{name:"📊 현황",value:`🌊 WAVE **${session.wave}** | 처치 **${session.kills}** | 📊 **${session.totalXp}** XP / **${session.totalCrystals}**💎`,inline:false})
    .setFooter({text:"파티원 누구나 행동 가능!"});
}
function buildSkillEmbed(player) {
  const id=player.active||"itadori"; const ch=CHARACTERS[id]||CHARACTERS["itadori"]; const mastery=getMastery(player,id); const awakened=isMakiAwakened(player); const fingers=player.sukunaFingers||0; const mainSkill=getMainSkill(player,id);
  const domainCD = player.domainCooldown||0;
  return new EmbedBuilder().setTitle(`${ch.emoji} ≪ 술식 트리 ≫ ${ch.name}${awakened?" 🔥[각성]":""}`).setColor(awakened?0xFF2200:JJK_GRADE_COLOR[ch.grade]||0x7c5cfc)
    .setDescription([`> ${ch.lore||ch.desc}`,`> 📈 **${masteryBar(mastery,id)}**`,`> 🌌 **영역전개** \`${ch.domain||"없음"}\` — 쿨타임: ${domainCD>0?`**${domainCD}턴**`:"✅ 사용가능"} (15턴당 1번)`,id==="itadori"?`> 👹 **스쿠나 손가락** \`${fingers}/${SUKUNA_FINGER_MAX}\` — ${getFingerBonus(fingers).label}`:"",id==="sukuna"?`> 👹 **손가락 보너스**: ATK+${getFingerBonus(fingers).atkBonus} DEF+${getFingerBonus(fingers).defBonus} HP+${getFingerBonus(fingers).hpBonus}`:"",awakened?`> 🔥 **천여주박 각성 중** — 모든 데미지 **2배**!`:"",mainSkill?`> ⭐ **주력 스킬:** ${mainSkill.name} (해금됨!)`:id==="gojo"?`> ⭐ **주력 스킬:** 자폭 무라사키 (20승 필요)`:id==="sukuna"?`> ⭐ **주력 스킬:** 세계참 (손가락 10개 필요)`:""].filter(Boolean).join("\n"))
    .addFields(ch.skills.map((s,idx)=>{ const unlocked=mastery>=s.minMastery; const fx=getSkillEffect(s.name); const statusNote=s.statusApply?` \`${STATUS_EFFECTS[s.statusApply.statusId]?.emoji}${STATUS_EFFECTS[s.statusApply.statusId]?.name} ${Math.round(s.statusApply.chance*100)}%\``:""; return {name:`${unlocked?"✅":"🔒"} [${idx+1}] ${s.name}  —  피해 **${s.dmg}**${statusNote}  (숙련 ${s.minMastery})`,value:[`> ${s.desc}`,unlocked?`> ${fx.art}`:"> 🔒 잠김",unlocked?`> *${fx.flavorText}*`:""].filter(Boolean).join("\n"),inline:false}; }))
    .setFooter({text:"⚫ 흑섬: 10% 확률로 2.5배 피해 + 50💎 | 🌌 영역전개: !전투/컬링/사멸회유/레이드 모두 사용가능"});
}

// ════════════════════════════════════════════════════════
// 버튼 팩토리
// ════════════════════════════════════════════════════════
function mkBattleButtons(player) {
  const canSkill=(player.skillCooldown||0)<=0;
  const canReverse=(player.reverseCooldown||0)<=0;
  const hasReverse=REVERSE_CHARS.has(player.active||"itadori");
  const canDomain=canUseDomain(player)&&!!(CHARACTERS[player.active||"itadori"]?.domain);
  const mainSkill=getMainSkill(player,player.active||"itadori");
  const skillName=getCurrentSkill(player,player.active||"itadori")?.name||"술식";
  const buttons=[
    new ButtonBuilder().setCustomId("b_attack").setLabel("⚔️ 공격").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("b_skill").setLabel(`🌀 ${skillName}`).setStyle(ButtonStyle.Primary).setDisabled(!canSkill),
  ];
  if (mainSkill) buttons.push(new ButtonBuilder().setCustomId("b_main").setLabel(`⭐ ${mainSkill.name}`).setStyle(ButtonStyle.Success));
  buttons.push(
    new ButtonBuilder().setCustomId("b_domain").setLabel("🌌 영역전개").setStyle(ButtonStyle.Success).setDisabled(!canDomain),
    new ButtonBuilder().setCustomId("b_reverse").setLabel("♻️ 반전").setStyle(ButtonStyle.Secondary).setDisabled(!canReverse||!hasReverse),
  );
  const row1 = new ActionRowBuilder().addComponents(buttons.slice(0,5));
  const row2 = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("b_run").setLabel("🏃 도주").setStyle(ButtonStyle.Secondary));
  return buttons.length>=5 ? [row1,row2] : [new ActionRowBuilder().addComponents(...buttons, new ButtonBuilder().setCustomId("b_run").setLabel("🏃 도주").setStyle(ButtonStyle.Secondary))];
}
function mkCullingButtons(player) {
  const canSkill=(player.skillCooldown||0)<=0;
  const canReverse=(player.reverseCooldown||0)<=0;
  const hasReverse=REVERSE_CHARS.has(player.active||"itadori");
  const canDomain=canUseDomain(player)&&!!(CHARACTERS[player.active||"itadori"]?.domain);
  const skillName=getCurrentSkill(player,player.active||"itadori")?.name||"술식";
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("c_attack").setLabel("⚔️ 공격").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("c_skill").setLabel(`🌀 ${skillName}`).setStyle(ButtonStyle.Primary).setDisabled(!canSkill),
    new ButtonBuilder().setCustomId("c_domain").setLabel("🌌 영역전개").setStyle(ButtonStyle.Success).setDisabled(!canDomain),
    new ButtonBuilder().setCustomId("c_reverse").setLabel("♻️ 반전").setStyle(ButtonStyle.Secondary).setDisabled(!canReverse||!hasReverse),
    new ButtonBuilder().setCustomId("c_escape").setLabel("🏳️ 철수").setStyle(ButtonStyle.Secondary),
  );
}
function mkJujutsuButtons(player,choices) {
  const canSkill=(player.skillCooldown||0)<=0;
  const canReverse=(player.reverseCooldown||0)<=0;
  const hasReverse=REVERSE_CHARS.has(player.active||"itadori");
  const canDomain=canUseDomain(player)&&!!(CHARACTERS[player.active||"itadori"]?.domain);
  const skillName=getCurrentSkill(player,player.active||"itadori")?.name||"술식";
  const choiceRow=new ActionRowBuilder();
  for (let i=0;i<Math.min((choices||[]).length,3);i++) choiceRow.addComponents(new ButtonBuilder().setCustomId(`j_choice_${i}`).setLabel(`⚔️ ${choices[i].name}`).setStyle(ButtonStyle.Primary));
  const actionRow=new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("j_attack").setLabel("⚔️ 공격").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("j_skill").setLabel(`🌀 ${skillName}`).setStyle(ButtonStyle.Primary).setDisabled(!canSkill),
    new ButtonBuilder().setCustomId("j_domain").setLabel("🌌 영역전개").setStyle(ButtonStyle.Success).setDisabled(!canDomain),
    new ButtonBuilder().setCustomId("j_reverse").setLabel("♻️ 반전").setStyle(ButtonStyle.Secondary).setDisabled(!canReverse||!hasReverse),
    new ButtonBuilder().setCustomId("j_escape").setLabel("🏳️ 철수").setStyle(ButtonStyle.Secondary),
  );
  return choices&&choices.length?[choiceRow,actionRow]:[actionRow];
}
function mkPvpButtons(session,userId) {
  const self=pvpSelf(session,userId);
  const canSkill=(session[self.skillCdKey]||0)<=0;
  const canReverse=(session[self.reverseCdKey]||0)<=0;
  const player=players[userId];
  const hasReverse=REVERSE_CHARS.has(player?.active||"itadori");
  const canDomain=(session[self.domainCdKey]||0)<=0&&!!(CHARACTERS[player?.active||"itadori"]?.domain);
  const skillName=player?getCurrentSkill(player,player.active)?.name||"술식":"술식";
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("pvp_atk").setLabel("⚔️ 공격").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("pvp_skill").setLabel(`🌀 ${skillName}`).setStyle(ButtonStyle.Primary).setDisabled(!canSkill),
    new ButtonBuilder().setCustomId("pvp_domain").setLabel("🌌 영역전개").setStyle(ButtonStyle.Success).setDisabled(!canDomain),
    new ButtonBuilder().setCustomId("pvp_reverse").setLabel(`♻️ 반전`).setStyle(ButtonStyle.Secondary).setDisabled(!canReverse||!hasReverse),
    new ButtonBuilder().setCustomId("pvp_surrender").setLabel("🏳️ 항복").setStyle(ButtonStyle.Secondary),
  );
}
function mkRaidButtons(player) {
  const canSkill=(player.skillCooldown||0)<=0;
  const canDomain=canUseDomain(player)&&!!(CHARACTERS[player.active||"itadori"]?.domain);
  const skillName=getCurrentSkill(player,player.active||"itadori")?.name||"술식";
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("r_attack").setLabel("⚔️ 공격").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("r_skill").setLabel(`🌀 ${skillName}`).setStyle(ButtonStyle.Primary).setDisabled(!canSkill),
    new ButtonBuilder().setCustomId("r_domain").setLabel("🌌 영역전개").setStyle(ButtonStyle.Success).setDisabled(!canDomain),
    new ButtonBuilder().setCustomId("r_retreat").setLabel("🏳️ 철수").setStyle(ButtonStyle.Secondary),
  );
}

// ── 캐릭터 선택 드롭다운 (완전 수정: 실제 스탯 표시 + customId 통일)
function mkCharSelectMenu(player, customId="char_select") {
  const owned = player.owned || ["itadori"];
  const options = owned.map(id => {
    const ch = CHARACTERS[id]; if (!ch) return null;
    const ri = GACHA_RARITY[ch.grade]||GACHA_RARITY["3급"];
    const mastery = getMastery(player, id);
    const isActive = id === player.active;
    // 실제 스탯 계산 (임시로 해당 캐릭터 장착 상태로)
    const tmpPlayer = {...player, active:id};
    const tmpStats = getPlayerStats(tmpPlayer);
    const fingerNote = id==="sukuna" ? ` | 손가락 ${player.sukunaFingers||0}개` : "";
    const domainNote = ch.domain ? ` | 영역:${ch.domain}` : "";
    return {
      label: `${ch.name} [${ch.grade}]${fingerNote}`.slice(0,100),
      description: `${ri.stars} | ATK ${tmpStats.atk} | DEF ${tmpStats.def} | HP ${tmpStats.maxHp} | 숙련 ${mastery}${domainNote}`.slice(0,100),
      value: id,
      default: isActive,
    };
  }).filter(Boolean);

  if (options.length === 0) {
    options.push({ label:"이타도리 유지 [준1급]", description:"기본 캐릭터", value:"itadori", default:true });
  }

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder("🎭 장착할 캐릭터를 선택하세요...")
      .addOptions(options)
  );
}

// ════════════════════════════════════════════════════════
// 적 반격
// ════════════════════════════════════════════════════════
async function doEnemyAttack(player, enemy, log) {
  const stats = getPlayerStats(player);
  const tick = tickStatus(player, stats.maxHp);
  if (tick.log.length) log.push(...tick.log);
  if (!rollHit(enemy.statusEffects||[], player.statusEffects||[])) { log.push(`> ↩️ **${enemy.name}**의 공격이 빗나갔다!`); return; }
  const eDmg = calcDmg(enemy.atk, stats.def);
  player.hp = Math.max(0, (player.hp||0) - eDmg);
  log.push(`> 💢 **${enemy.name}** 의 반격! **${eDmg}** 피해!`);
  if (enemy.statusAttack && Math.random() < (enemy.statusAttack.chance||0.3)) {
    applyStatus(player, enemy.statusAttack.statusId);
    const sdef = STATUS_EFFECTS[enemy.statusAttack.statusId];
    if (sdef) log.push(`> ${sdef.emoji} **${sdef.name}** 상태이상!`);
  }
}
async function doRaidBossAttack(player, raidSession, boss, log) {
  const stats = getPlayerStats(player);
  const bossAtk = raidSession.enraged ? boss.enragedAtk : boss.atk;
  const eDmg = calcDmg(bossAtk, stats.def);
  player.hp = Math.max(0, (player.hp||0) - eDmg);
  log.push(`> 💢 **${boss.name}** 의 공격! **${eDmg}** 피해!`);
  if (boss.statusAttack && Math.random() < (boss.statusAttack.chance||0.3)) {
    applyStatus(player, boss.statusAttack.statusId);
    const sdef = STATUS_EFFECTS[boss.statusAttack.statusId];
    if (sdef) log.push(`> ${sdef.emoji} **${sdef.name}** 상태이상!`);
  }
  if (boss.specialAttack && Math.random() < 0.30) {
    const spDmg = boss.specialAttack.dmg;
    player.hp = Math.max(0, (player.hp||0) - spDmg);
    if (boss.specialAttack.statusId) applyStatus(player, boss.specialAttack.statusId);
    log.push(`> 🔥 **[특수기] ${boss.specialAttack.name}** — **${spDmg}** 추가 피해!`);
  }
}

// ════════════════════════════════════════════════════════
// 개발자 패널 임베드
// ════════════════════════════════════════════════════════
function devPanelEmbed() {
  const totalPlayers = Object.keys(players).length;
  const topPlayers = Object.values(players).sort((a,b)=>(b.xp||0)-(a.xp||0)).slice(0,5).map((p,i)=>`> **${i+1}.** ${p.name||"??"} (LV.${getLevel(p.xp||0)}) — ${(p.xp||0).toLocaleString()}XP`);
  const totalCrystals = Object.values(players).reduce((s,p)=>s+(p.crystals||0),0);
  return new EmbedBuilder().setColor(0xFF0000).setTitle("🔧 개발자 패널").setDescription("```ansi\n\u001b[1;31m╔══════════════════════════════════╗\n║  🔧  DEV  PANEL  —  ADMIN ONLY  ║\n╚══════════════════════════════════╝\n```")
    .addFields(
      {name:"📊 서버 현황",value:[`> 👥 총 플레이어: **${totalPlayers}**명`,`> ⚔️ 전투: **${Object.keys(battles).length}**`,`> 🌊 컬링: **${Object.keys(cullings).length}**`,`> 🥊 PvP: **${Object.keys(pvpSessions).length}**`,`> 🔥 레이드: **${Object.keys(raidSessions).length}**`,`> 💎 총 크리스탈: **${totalCrystals.toLocaleString()}**`].join("\n"),inline:false},
      {name:"🏆 XP 랭킹 TOP 5",value:topPlayers.join("\n")||"> 없음",inline:false},
      {name:"🛠️ 개발자 명령어",value:[`> \`!아이템지급 [@유저] [크리스탈|회복약|손가락|재료명] [수량]\``,`> \`!쿨다운초기화\``,`> \`!전체저장\``,`> \`!플레이어정보 @유저\``].join("\n"),inline:false}
    ).setFooter({text:`${new Date().toLocaleString("ko-KR")}`}).setTimestamp();
}

// ════════════════════════════════════════════════════════
// Discord 준비 + 슬래시 커맨드 등록
// ════════════════════════════════════════════════════════
client.once("ready", async () => {
  console.log(`✅ 로그인: ${client.user.tag}`);
  await dbInit();
  players = await dbLoad();
  console.log("🚀 주술회전 RPG 봇 활성화");

  const commands = [
    {name:"프로필",     description:"내 프로필 카드 확인"},
    {name:"전투",       description:"일반 전투 시작"},
    {name:"술식",       description:"현재 캐릭터 술식 확인"},
    {name:"가챠",       description:"캐릭터 뽑기", options:[{name:"횟수",type:4,description:"1 또는 10",required:true}]},
    {name:"활성",       description:"캐릭터 선택 메뉴"},
    {name:"도감",       description:"보유 캐릭터 목록"},
    {name:"출석",       description:"매일 출석 체크"},
    {name:"회복",       description:"회복약 사용"},
    {name:"코가네가챠", description:"코가네 펫 뽑기 (200💎)"},
    {name:"코가네",     description:"코가네 펫 정보"},
    {name:"손가락",     description:"스쿠나 손가락 현황"},
    {name:"컬링",       description:"컬링 게임 시작"},
    {name:"사멸회유",   description:"사멸회유 게임 시작"},
    {name:"결투",       description:"PvP 결투 신청", options:[{name:"대상",type:6,description:"결투할 대상",required:true}]},
    {name:"파티생성",   description:"파티 생성"},
    {name:"파티초대",   description:"파티 초대", options:[{name:"대상",type:6,description:"초대할 대상",required:true}]},
    {name:"파티나가기", description:"파티 탈퇴"},
    {name:"파티컬링",   description:"파티 컬링 시작"},
    {name:"레이드",     description:"레이드 시작", options:[{name:"보스",type:3,description:"heian_sukuna 또는 mahoraga",required:true}]},
    {name:"코드",       description:"쿠폰 코드 사용", options:[{name:"코드",type:3,description:"쿠폰 코드",required:true}]},
    {name:"퀘스트",     description:"퀘스트 현황 확인"},
    {name:"재료",       description:"재료 인벤토리 확인"},
    {name:"주구목록",   description:"주구(무기) 목록"},
    {name:"주구제작",   description:"주구 제작", options:[{name:"이름",type:3,description:"무기 이름",required:true}]},
    {name:"장착",       description:"주구 장착", options:[{name:"이름",type:3,description:"무기 이름",required:true}]},
    {name:"해제",       description:"주구 해제"},
    {name:"도움말",     description:"명령어 목록"},
  ];
  try { await client.application.commands.set(commands); console.log("✅ 슬래시 커맨드 등록 완료"); }
  catch(e) { console.error("슬래시 커맨드 등록 실패:", e.message); }
});

// ════════════════════════════════════════════════════════
// 인터랙션 핸들러 (캐릭터 선택 드롭다운 — 완전 수정)
// ════════════════════════════════════════════════════════
client.on("interactionCreate", async (interaction) => {
  try {
    // ── 캐릭터 선택 드롭다운 (char_select)
    if (interaction.isStringSelectMenu() && interaction.customId === "char_select") {
      const userId = interaction.user.id;
      const player = getPlayer(userId, interaction.user.username);
      const charId = interaction.values[0];

      // 보유 확인
      if (!(player.owned||[]).includes(charId)) {
        return interaction.reply({ content:"❌ 보유하지 않은 캐릭터입니다!", ephemeral:true });
      }
      // 기존과 같으면 그냥 안내
      if (player.active === charId) {
        const ch = CHARACTERS[charId];
        const stats = getPlayerStats(player);
        return interaction.update({
          content: null,
          embeds: [new EmbedBuilder().setColor(0x7c5cfc)
            .setTitle(`${ch.emoji} 이미 ${ch.name} 이(가) 장착되어 있습니다.`)
            .setDescription(`> 💚 HP: **${Math.max(0,player.hp||0)}** / **${stats.maxHp}**\n> 🗡️ ATK: **${stats.atk}**  🛡️ DEF: **${stats.def}**`)],
          components:[],
        });
      }

      // 캐릭터 변경
      player.active = charId;
      if (!player.mastery) player.mastery = {};
      if (!player.mastery[charId]) player.mastery[charId] = 0;

      // 장착 캐릭터 기준 스탯으로 HP 완전 회복
      const stats = getPlayerStats(player);
      player.hp = stats.maxHp;

      // 상태이상 초기화 (캐릭터 변경 시)
      player.statusEffects = [];
      player.skillCooldown = 0;
      player.domainCooldown = 0;

      savePlayer(userId);

      const ch = CHARACTERS[charId];
      const ri = GACHA_RARITY[ch.grade]||GACHA_RARITY["3급"];
      const mastery = getMastery(player, charId);
      const currentSkill = getCurrentSkill(player, charId);
      const fingers = player.sukunaFingers||0;

      const descLines = [
        `> ${ri.stars} ${ri.effect}`,
        `> *"${ch.lore||ch.desc}"*`,
        `> 💚 HP 완전 회복: **${stats.maxHp}**`,
        `> 🗡️ ATK: **${stats.atk}**  ·  🛡️ DEF: **${stats.def}**`,
        `> 🌌 영역전개: \`${ch.domain||"없음"}\``,
        `> 🌀 현재 스킬: **${currentSkill?.name||"없음"}** (피해: ${currentSkill?.dmg||0})`,
        `> 📈 숙련도: **${mastery}**`,
        charId==="itadori"||charId==="sukuna"?`> 👹 스쿠나 손가락: **${fingers}/${SUKUNA_FINGER_MAX}** — ${getFingerBonus(fingers).label}`:"",
      ].filter(Boolean).join("\n");

      return interaction.update({
        content: null,
        embeds: [new EmbedBuilder()
          .setColor(ri.color)
          .setTitle(`${ch.emoji} **${ch.name}** [${ch.grade}] 장착 완료!`)
          .setDescription(descLines)
        ],
        components: [],
      });
    }

    // ── 버튼 처리
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
          if (!isNaN(idx) && jujutsu.choices?.[idx]) {
            jujutsu.currentEnemy = JSON.parse(JSON.stringify(jujutsu.choices[idx]));
            jujutsu.enemyHp = jujutsu.currentEnemy.hp;
            jujutsu.choices = null;
            return interaction.update({ embeds:[jujutsuEmbed(player,jujutsu)], components:mkJujutsuButtons(player,[]) });
          }
          return interaction.reply({ content:"❌ 잘못된 선택", ephemeral:true });
        }
        return handleJujutsuAction(interaction, player, jujutsu, customId);
      }
      if (customId.startsWith("pvp_")) {
        const session = getPvpSessionByUser(userId);
        if (!session) return interaction.reply({ content:"❌ 진행 중인 PvP 없음", ephemeral:true });
        if (session.turn !== userId) return interaction.reply({ content:"⏳ 당신의 턴이 아닙니다!", ephemeral:true });
        return handlePvpAction(interaction, player, session, customId);
      }
      if (customId.startsWith("r_")) {
        const raidSession = getRaidByUser(userId);
        if (!raidSession) return interaction.reply({ content:"❌ 진행 중인 레이드 없음", ephemeral:true });
        if ((player.hp||0) <= 0) return interaction.reply({ content:"💀 전투 불능 상태! `!회복` 으로 회복하세요.", ephemeral:true });
        return handleRaidAction(interaction, player, raidSession, customId);
      }
      if (customId.startsWith("pc_")) {
        const party = getParty(userId);
        if (!party) return interaction.reply({ content:"❌ 파티 없음", ephemeral:true });
        const session = cullings[party.id];
        if (!session) return interaction.reply({ content:"❌ 진행 중인 파티 컬링 없음", ephemeral:true });
        if ((player.hp||0) <= 0) return interaction.reply({ content:"💀 전투 불능 상태!", ephemeral:true });
        return handlePartyCullingAction(interaction, player, session, customId);
      }
      if (customId.startsWith("party_invite_")) {
        const parts = customId.split("_"); const partyId = parts[3], targetId = parts[4];
        if (user.id !== targetId) return interaction.reply({ content:"❌ 당신을 위한 초대가 아닙니다.", ephemeral:true });
        const invite = partyInvites[targetId];
        if (!invite || invite.partyId !== partyId) return interaction.reply({ content:"❌ 만료된 초대", ephemeral:true });
        if (customId.includes("accept")) {
          const party = parties[partyId];
          if (!party) return interaction.reply({ content:"❌ 파티가 해체됨", ephemeral:true });
          if (party.members.length >= 4) return interaction.reply({ content:"❌ 파티 가득참", ephemeral:true });
          if (getPartyId(targetId)) return interaction.reply({ content:"❌ 이미 파티에 소속됨", ephemeral:true });
          party.members.push(targetId); delete partyInvites[targetId];
          return interaction.update({ content:`✅ 파티 참가! (${party.members.length}/4명)`, embeds:[], components:[] });
        } else {
          delete partyInvites[targetId];
          return interaction.update({ content:"❌ 초대 거절", embeds:[], components:[] });
        }
      }
      if (customId.startsWith("pvp_challenge_")) {
        const parts = customId.split("_"); const act = parts[3], challengerId = parts[4];
        if (act === "accept") {
          const challenge = pvpChallenges[challengerId];
          if (!challenge || challenge.target !== user.id) return interaction.reply({ content:"❌ 유효하지 않은 도전", ephemeral:true });
          if (getPvpSessionByUser(user.id)||getPvpSessionByUser(challengerId)) return interaction.reply({ content:"❌ 이미 PvP 중", ephemeral:true });
          const p1=players[challengerId], p2=players[user.id];
          if (!p1||!p2) return interaction.reply({ content:"❌ 플레이어 정보 없음", ephemeral:true });
          const session = createPvpSession(challengerId, user.id);
          pvpSessions[session.id] = session; delete pvpChallenges[challengerId];
          const ch1=CHARACTERS[p1.active]||CHARACTERS["itadori"], ch2=CHARACTERS[p2.active]||CHARACTERS["itadori"];
          const s1=getPlayerStats(p1), s2=getPlayerStats(p2);
          const startEmbed = new EmbedBuilder().setColor(0xF5C842).setTitle("⚔️ PvP 결투 시작!")
            .setDescription([`\`\`\`ansi\n\u001b[1;33m╔══════════════════════════════════╗\n║  ⚔️  PvP BATTLE START!  ⚔️        ║\n╚══════════════════════════════════╝\n\`\`\``,`> ${ch1.emoji} **${ch1.name}** [${ch1.grade}]  HP **${session.maxHp1}** ATK **${s1.atk}**`,`> VS`,`> ${ch2.emoji} **${ch2.name}** [${ch2.grade}]  HP **${session.maxHp2}** ATK **${s2.atk}**`,`> 먼저 행동: **${p1.name}**`].join("\n"));
          return interaction.update({ embeds:[startEmbed, pvpEmbed(session)], components:[mkPvpButtons(session, challengerId)] });
        } else {
          delete pvpChallenges[challengerId];
          return interaction.update({ content:"❌ 결투 거절됨.", embeds:[], components:[] });
        }
      }
    }

    // ── 슬래시 커맨드
    if (interaction.isChatInputCommand()) {
      const { commandName, user } = interaction;
      const userId = user.id;
      const player = getPlayer(userId, user.username);
      await handleSlashCommand(interaction, commandName, player, userId, user);
    }
  } catch(err) {
    console.error("인터랙션 오류:", err);
    try {
      const msg = { content:"❌ 오류가 발생했습니다. 잠시 후 다시 시도해주세요.", ephemeral:true };
      if (interaction.replied || interaction.deferred) await interaction.followUp(msg).catch(()=>{});
      else await interaction.reply(msg).catch(()=>{});
    } catch {}
  }
});

// ════════════════════════════════════════════════════════
// PvP 세션 생성 (도메인 쿨타임 포함)
// ════════════════════════════════════════════════════════
function createPvpSession(p1Id, p2Id) {
  const s1=getPlayerStats(players[p1Id]), s2=getPlayerStats(players[p2Id]);
  return {
    id:`pvp_${Date.now()}`, p1Id, p2Id,
    hp1:s1.maxHp, hp2:s2.maxHp, maxHp1:s1.maxHp, maxHp2:s2.maxHp,
    status1:[], status2:[],
    skillCd1:0, skillCd2:0,
    reverseCd1:0, reverseCd2:0,
    domainCd1:0, domainCd2:0,
    turn:p1Id, round:1,
  };
}

// ════════════════════════════════════════════════════════
// PART 1 끝 — PART 2 (전투/컬링/사멸회유/PvP/레이드/명령어 핸들러)와 합쳐서 사용
// ════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════
// 주술회전 RPG 봇 — PART 2 완전 수정본
// PART 1 구조 완전 유지 + 전투/PvP/파티/도감/가챠 RPG 완성
// ════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════
// 전투 행동 핸들러 (고퀄화)
// ════════════════════════════════════════════════════════
async function handleBattleAction(interaction, player, battle, customId) {
  const stats = getPlayerStats(player);
  const enemy = battle.enemy;
  const log = [];
  let ended = false;

  // 기절/빙결 처리
  if (isIncapacitated(player.statusEffects)) {
    const se = player.statusEffects.find(s => s.id === "freeze" || s.id === "stun");
    const def = STATUS_EFFECTS[se.id];
    log.push(`> ${def.emoji} **[${def.name}]** 상태로 행동 불가!`);
    se.turns--;
    if (se.turns <= 0) player.statusEffects = player.statusEffects.filter(s => s.id !== se.id);
    await doEnemyAttack(player, enemy, log);
    tickCooldowns(player);
    savePlayer(player.id);
    if ((player.hp || 0) <= 0) {
      ended = true;
      player.losses = (player.losses || 0) + 1;
      delete battles[player.id];
      savePlayer(player.id);
      return interaction.update({
        embeds: [new EmbedBuilder().setColor(0xe63946).setTitle("💀 전투 패배").setDescription(log.join("\n") + `\n\n> 💀 **${player.name}** 전투 불능!`)],
        components: [],
      });
    }
    return interaction.update({
      embeds: [buildBattleEmbed(player, battle, log)],
      components: mkBattleButtons(player),
    });
  }

  if (customId === "b_run") {
    delete battles[player.id];
    savePlayer(player.id);
    return interaction.update({ content: "🏃 전투에서 도주했습니다.", embeds: [], components: [] });
  }

  // ── 공격
  if (customId === "b_attack") {
    const hitRoll = rollHit(player.statusEffects, enemy.statusEffects || []);
    if (!hitRoll) {
      log.push(`> 💨 **공격 빗나감!** (실명/회피)`)
    } else {
      const { dmg, isCrit } = calcDmgForPlayer(player, enemy.def);
      const bf = isBlackFlash();
      const finalDmg = bf ? Math.floor(dmg * 2.5) : dmg;
      enemy.hp = Math.max(0, (enemy.hp || 0) - finalDmg);
      if (bf) {
        log.push(getBlackFlashArt());
        log.push(`> ⚫ **[흑섬 발동!]** ${player.name}의 저주 에너지 최대 방출! **${finalDmg}** 피해!`);
        player.crystals = (player.crystals || 0) + 50;
        log.push(`> 💎 흑섬 보너스 **+50**💎`);
        updateQuestProgress(player, "skill_use", 1);
      } else if (isCrit) {
        log.push(`> ⚡ **[치명타!]** ${player.name}의 공격이 급소를 꿰뚫는다! **${finalDmg}** 피해!`);
      } else {
        log.push(`> ⚔️ **${player.name}** 공격! **${finalDmg}** 피해!`);
      }
    }
  }

  // ── 술식
  else if (customId === "b_skill") {
    if ((player.skillCooldown || 0) > 0) return interaction.reply({ content: `⏳ 술식 쿨타임 **${player.skillCooldown}**턴 남음!`, ephemeral: true });
    const skill = getCurrentSkill(player, player.active);
    if (!skill) return interaction.reply({ content: "❌ 사용 가능한 술식 없음", ephemeral: true });
    const fx = getSkillEffect(skill.name);
    const { dmg, isCrit } = calcSkillDmgForPlayer(player, skill.dmg);
    const bf = isBlackFlash();
    const finalDmg = bf ? Math.floor(dmg * 2.5) : dmg;
    enemy.hp = Math.max(0, (enemy.hp || 0) - finalDmg);
    log.push(fx.art);
    log.push(`> 🌀 **[술식: ${skill.name}]** ${fx.flavorText}`);
    if (bf) {
      log.push(getBlackFlashArt());
      log.push(`> ⚫ **[흑섬 × 술식!]** **${finalDmg}** 피해!`);
      player.crystals = (player.crystals || 0) + 50;
    } else if (isCrit) {
      log.push(`> ⚡ **[치명타!]** **${finalDmg}** 피해!`);
    } else {
      log.push(`> 💥 **${finalDmg}** 피해!`);
    }
    const statusMsgs = applySkillStatus(skill, enemy, player);
    if (statusMsgs.length) log.push(...statusMsgs.map(s => `> ${s}`));
    player.skillCooldown = 5;
    updateQuestProgress(player, "skill_use", 1);
  }

  // ── 주력 스킬
  else if (customId === "b_main") {
    const mainSkill = getMainSkill(player, player.active);
    if (!mainSkill) return interaction.reply({ content: "❌ 주력 스킬 없음", ephemeral: true });
    const fx = getSkillEffect(mainSkill.name);
    let finalDmg = mainSkill.dmg + Math.floor(Math.random() * 100);
    finalDmg = Math.floor(finalDmg * getKoganeBonus(player).atk);
    if (player.active === "itadori" || player.active === "sukuna") finalDmg = Math.floor(finalDmg * getFingerBonus(player.sukunaFingers || 0).dmgMult);
    enemy.hp = Math.max(0, (enemy.hp || 0) - finalDmg);
    log.push(fx.art);
    log.push(`> ⭐ **[주력 스킬: ${mainSkill.name}]** ${fx.flavorText}`);
    log.push(`> 💥 **${finalDmg}** 피해!`);
    if (mainSkill.name === "자폭 무라사키") {
      player.hp = 1;
      log.push(`> ⚠️ **자폭!** HP가 **1**로 감소!`);
    }
    updateQuestProgress(player, "skill_use", 1);
  }

  // ── 영역전개
  else if (customId === "b_domain") {
    const ch = CHARACTERS[player.active];
    if (!ch?.domain) return interaction.reply({ content: "❌ 영역전개 없음", ephemeral: true });
    if (!canUseDomain(player)) return interaction.reply({ content: `⏳ 영역전개 쿨타임 **${player.domainCooldown}**턴 남음!`, ephemeral: true });
    const result = applyDomainExpansion(stats, ch.domain, enemy, false);
    enemy.hp = Math.max(0, (enemy.hp || 0) - result.dmg);
    log.push(...result.log);
    player.domainCooldown = 15;
    updateQuestProgress(player, "skill_use", 1);
  }

  // ── 반전술식
  else if (customId === "b_reverse") {
    if (!REVERSE_CHARS.has(player.active)) return interaction.reply({ content: "❌ 반전술식 사용 불가", ephemeral: true });
    if ((player.reverseCooldown || 0) > 0) return interaction.reply({ content: `⏳ 반전 쿨타임 **${player.reverseCooldown}**턴 남음!`, ephemeral: true });
    const healAmt = Math.floor(stats.maxHp * (0.30 + (player.reverseOutput || 1.0) * 0.10));
    player.hp = Math.min(stats.maxHp, (player.hp || 0) + healAmt);
    player.statusEffects = (player.statusEffects || []).filter(s => s.id !== "poison" && s.id !== "burn" && s.id !== "cursed_wound" && s.id !== "dotBleed");
    log.push(`> ♻️ **[반전술식]** HP **+${healAmt}** 회복! 독/화상 해제!`);
    player.reverseCooldown = 3;
  }

  // 적 HP 체크
  if ((enemy.hp || 0) <= 0) {
    ended = true;
    delete battles[player.id];
    const winEmbed = await processBattleWin(player, enemy);
    winEmbed.setDescription((winEmbed.data.description || "") + "\n\n" + log.join("\n"));
    savePlayer(player.id);
    return interaction.update({ embeds: [winEmbed], components: [] });
  }

  // 적 반격
  if (!ended) {
    await doEnemyAttack(player, enemy, log);
    // 적 상태이상 틱
    const eTick = tickStatus(enemy, enemy.hp);
    if (eTick.log.length) log.push(...eTick.log);
  }

  tickCooldowns(player);
  savePlayer(player.id);

  // 플레이어 사망
  if ((player.hp || 0) <= 0) {
    delete battles[player.id];
    player.losses = (player.losses || 0) + 1;
    savePlayer(player.id);
    return interaction.update({
      embeds: [new EmbedBuilder().setColor(0xe63946).setTitle("💀 전투 패배")
        .setDescription(log.join("\n") + `\n\n> 💀 **${player.name}** 전투 불능!\n> 🧪 \`/회복\` 으로 회복하세요.`)
        .addFields({ name: "📊 전적", value: `> ⚔️ ${player.wins || 0}승 **${player.losses}패**`, inline: false })],
      components: [],
    });
  }

  return interaction.update({
    embeds: [buildBattleEmbed(player, battle, log)],
    components: mkBattleButtons(player),
  });
}

function buildBattleEmbed(player, battle, log = []) {
  const ch = CHARACTERS[player.active] || CHARACTERS["itadori"];
  const stats = getPlayerStats(player);
  const enemy = battle.enemy;
  const awakened = isMakiAwakened(player);
  const hpPct = Math.max(0, player.hp || 0) / stats.maxHp;
  const hpBar = buildHpBar(hpPct, 10);
  const eHpPct = Math.max(0, enemy.hp || 0) / (battle.enemy.maxHp || enemy.hp || 1);
  const eHpBar = buildHpBar(eHpPct, 10);
  const domainCD = player.domainCooldown || 0;
  return new EmbedBuilder()
    .setColor(awakened ? 0xFF2200 : JJK_GRADE_COLOR[ch.grade] || 0x7C5CFC)
    .setTitle(`${awakened ? "🔥 " : ""}⚔️ 전투 — ${ch.emoji} ${ch.name} vs ${enemy.emoji} ${enemy.name}`)
    .setDescription(log.length ? log.join("\n") : "⚔️ 전투 시작!")
    .addFields(
      { name: `${ch.emoji} ${player.name}${awakened ? " 🔥[각성]" : ""}`, value: [`> 💚 ${hpBar} \`${Math.max(0, player.hp || 0)}/${stats.maxHp}\``, `> 🩸 상태: ${statusStr(player.statusEffects || [])}`, `> ⚡ 술식: \`${(player.skillCooldown || 0) > 0 ? player.skillCooldown + "턴" : "✅"}\`  ♻ 반전: \`${(player.reverseCooldown || 0) > 0 ? player.reverseCooldown + "턴" : "✅"}\`  🌌 영역: \`${domainCD > 0 ? domainCD + "턴" : "✅"}\``].join("\n"), inline: true },
      { name: `${enemy.emoji} ${enemy.name}`, value: [`> 💚 ${eHpBar} \`${Math.max(0, enemy.hp || 0)}/${battle.enemy.maxHp || enemy.hp}\``, `> 🩸 상태: ${statusStr(enemy.statusEffects || [])}`, `> 🗡️ ATK **${enemy.atk}** · 🛡️ DEF **${enemy.def}**`].join("\n"), inline: true },
    )
    .setFooter({ text: `현재 스킬: ${getCurrentSkill(player, player.active)?.name || "없음"} | 흑섬 10% | 치명타 ${player.crit || 5}%` });
}

function buildHpBar(pct, len = 10) {
  const filled = Math.round(Math.max(0, Math.min(1, pct)) * len);
  const color = pct > 0.6 ? "🟩" : pct > 0.3 ? "🟨" : "🟥";
  return color.repeat(filled) + "⬛".repeat(len - filled);
}

// ════════════════════════════════════════════════════════
// 컬링 행동 핸들러
// ════════════════════════════════════════════════════════
async function handleCullingAction(interaction, player, session, customId) {
  const stats = getPlayerStats(player);
  const enemy = session.currentEnemy;
  const log = [];

  if (customId === "c_escape") {
    const xp = session.totalXp, crystals = session.totalCrystals;
    const kb = getKoganeBonus(player);
    const xpGain = Math.floor(xp * kb.xp), crystalGain = Math.floor(crystals * kb.crystal);
    player.xp = (player.xp || 0) + xpGain;
    player.crystals = (player.crystals || 0) + crystalGain;
    if (session.wave > (player.cullingBest || 0)) player.cullingBest = session.wave;
    delete cullings[player.id];
    savePlayer(player.id);
    return interaction.update({
      embeds: [new EmbedBuilder().setColor(0x7C5CFC).setTitle("🏳️ 컬링 게임 종료")
        .setDescription(`> 🌊 **WAVE ${session.wave}** 에서 철수\n> ⭐ XP **+${xpGain}** | 💎 **+${crystalGain}**\n> 🏆 최고 기록: **WAVE ${player.cullingBest}**`)],
      components: [],
    });
  }

  if (isIncapacitated(player.statusEffects)) {
    const se = player.statusEffects.find(s => s.id === "freeze" || s.id === "stun");
    const def = STATUS_EFFECTS[se.id];
    log.push(`> ${def.emoji} **[${def.name}]** 행동 불가!`);
    se.turns--;
    if (se.turns <= 0) player.statusEffects = player.statusEffects.filter(s => s.id !== se.id);
    await doCullingEnemyAttack(player, session, log);
    tickCooldowns(player);
    savePlayer(player.id);
    if ((player.hp || 0) <= 0) return endCulling(interaction, player, session, true, log);
    return interaction.update({ embeds: [cullingEmbed(player, session, log)], components: [mkCullingButtons(player)] });
  }

  if (customId === "c_attack") {
    const hitRoll = rollHit(player.statusEffects, enemy.statusEffects || []);
    if (!hitRoll) {
      log.push(`> 💨 **공격 빗나감!**`);
    } else {
      const { dmg, isCrit } = calcDmgForPlayer(player, enemy.def);
      const bf = isBlackFlash();
      const finalDmg = bf ? Math.floor(dmg * 2.5) : dmg;
      session.enemyHp = Math.max(0, (session.enemyHp || 0) - finalDmg);
      if (bf) {
        log.push(getBlackFlashArt());
        log.push(`> ⚫ **[흑섬!]** **${finalDmg}** 피해! (+50💎)`);
        player.crystals = (player.crystals || 0) + 50;
      } else if (isCrit) {
        log.push(`> ⚡ **[치명타!]** **${finalDmg}** 피해!`);
      } else {
        log.push(`> ⚔️ 공격! **${finalDmg}** 피해!`);
      }
    }
  } else if (customId === "c_skill") {
    if ((player.skillCooldown || 0) > 0) return interaction.reply({ content: `⏳ 쿨타임 ${player.skillCooldown}턴`, ephemeral: true });
    const skill = getCurrentSkill(player, player.active);
    if (!skill) return interaction.reply({ content: "❌ 술식 없음", ephemeral: true });
    const fx = getSkillEffect(skill.name);
    const { dmg, isCrit } = calcSkillDmgForPlayer(player, skill.dmg);
    const bf = isBlackFlash();
    const finalDmg = bf ? Math.floor(dmg * 2.5) : dmg;
    session.enemyHp = Math.max(0, (session.enemyHp || 0) - finalDmg);
    log.push(fx.art);
    log.push(`> 🌀 **[${skill.name}]** ${fx.flavorText}`);
    if (bf) { log.push(getBlackFlashArt()); log.push(`> ⚫ **[흑섬×술식!]** **${finalDmg}** 피해!`); player.crystals = (player.crystals || 0) + 50; }
    else if (isCrit) log.push(`> ⚡ **[치명타!]** **${finalDmg}** 피해!`);
    else log.push(`> 💥 **${finalDmg}** 피해!`);
    const sm = applySkillStatus(skill, enemy, player);
    if (sm.length) log.push(...sm.map(s => `> ${s}`));
    player.skillCooldown = 5;
    updateQuestProgress(player, "skill_use", 1);
  } else if (customId === "c_domain") {
    const ch = CHARACTERS[player.active];
    if (!ch?.domain) return interaction.reply({ content: "❌ 영역전개 없음", ephemeral: true });
    if (!canUseDomain(player)) return interaction.reply({ content: `⏳ 영역전개 쿨타임 ${player.domainCooldown}턴`, ephemeral: true });
    const result = applyDomainExpansion(stats, ch.domain, enemy, false);
    session.enemyHp = Math.max(0, (session.enemyHp || 0) - result.dmg);
    enemy.statusEffects = enemy.statusEffects || [];
    log.push(...result.log);
    player.domainCooldown = 15;
    updateQuestProgress(player, "skill_use", 1);
  } else if (customId === "c_reverse") {
    if (!REVERSE_CHARS.has(player.active)) return interaction.reply({ content: "❌ 반전술식 불가", ephemeral: true });
    if ((player.reverseCooldown || 0) > 0) return interaction.reply({ content: `⏳ 반전 쿨타임 ${player.reverseCooldown}턴`, ephemeral: true });
    const healAmt = Math.floor(stats.maxHp * 0.35);
    player.hp = Math.min(stats.maxHp, (player.hp || 0) + healAmt);
    player.statusEffects = (player.statusEffects || []).filter(s => !["poison","burn","cursed_wound","dotBleed"].includes(s.id));
    log.push(`> ♻️ **[반전술식]** HP **+${healAmt}** 회복!`);
    player.reverseCooldown = 3;
  }

  // 적 처치 체크
  if ((session.enemyHp || 0) <= 0) {
    const drops = rollDrops(enemy.id || "e1");
    addMaterials(player, drops);
    session.kills = (session.kills || 0) + 1;
    session.totalXp += (enemy.xp || 0);
    session.totalCrystals += (enemy.crystals || 0);
    if (enemy.fingers) player.sukunaFingers = Math.min(SUKUNA_FINGER_MAX, (player.sukunaFingers || 0) + enemy.fingers);
    const masteryGain = enemy.masteryXp || 1;
    if (!player.mastery) player.mastery = {};
    player.mastery[player.active] = (player.mastery[player.active] || 0) + masteryGain;
    updateQuestProgress(player, "culling_wave", 1);
    if (enemy.id === "e3" || enemy.id === "e4") updateQuestProgress(player, "boss_kill", 1);
    log.push(`> ✅ **${enemy.name}** 처치! 🌊 WAVE **${session.wave + 1}** 진행!`);
    if (Object.keys(drops).length) log.push(`> 📦 ${formatDrops(drops)}`);
    session.wave++;
    const newEnemy = pickCullingEnemy(session.wave);
    session.currentEnemy = newEnemy;
    session.enemyHp = newEnemy.hp;
    const potChance = { e1: 0.25, e2: 0.35, e3: 0.50, e4: 0.65 };
    if (Math.random() < (potChance[enemy.id] || 0.20)) {
      player.potion = (player.potion || 0) + 1;
      log.push(`> 🧪 **회복약 +1!** (${player.potion}개)`);
    }
  } else {
    await doCullingEnemyAttack(player, session, log);
    const eTick = tickStatus(session.currentEnemy, session.currentEnemy.hp);
    if (eTick.log.length) log.push(...eTick.log);
    session.enemyHp = session.currentEnemy.hp;
  }

  tickCooldowns(player);
  savePlayer(player.id);

  if ((player.hp || 0) <= 0) return endCulling(interaction, player, session, true, log);

  return interaction.update({
    embeds: [cullingEmbed(player, session, log)],
    components: [mkCullingButtons(player)],
  });
}

async function doCullingEnemyAttack(player, session, log) {
  const stats = getPlayerStats(player);
  const enemy = session.currentEnemy;
  if (!rollHit(enemy.statusEffects || [], player.statusEffects || [])) {
    log.push(`> 💨 **${enemy.name}**의 공격이 빗나갔다!`);
    return;
  }
  const tick = tickStatus(player, stats.maxHp);
  if (tick.log.length) log.push(...tick.log);
  const eDmg = calcDmg(enemy.atk, stats.def);
  player.hp = Math.max(0, (player.hp || 0) - eDmg);
  log.push(`> 💢 **${enemy.name}** 반격! **${eDmg}** 피해!`);
  if (enemy.statusAttack && Math.random() < (enemy.statusAttack.chance || 0.3)) {
    applyStatus(player, enemy.statusAttack.statusId);
    const sdef = STATUS_EFFECTS[enemy.statusAttack.statusId];
    if (sdef) log.push(`> ${sdef.emoji} **${sdef.name}** 상태이상!`);
  }
}

async function endCulling(interaction, player, session, died, log) {
  const kb = getKoganeBonus(player);
  const xpGain = Math.floor(session.totalXp * kb.xp);
  const crystalGain = Math.floor(session.totalCrystals * kb.crystal);
  player.xp = (player.xp || 0) + xpGain;
  player.crystals = (player.crystals || 0) + crystalGain;
  if (session.wave > (player.cullingBest || 0)) player.cullingBest = session.wave;
  if (died) { player.losses = (player.losses || 0) + 1; player.hp = 0; }
  delete cullings[player.id];
  updateQuestProgress(player, "culling_wave", 0);
  const questDone = getNewlyCompletedQuestMsg(player);
  savePlayer(player.id);
  return interaction.update({
    embeds: [new EmbedBuilder()
      .setColor(died ? 0xe63946 : 0xF5C842)
      .setTitle(died ? "💀 컬링 게임 종료 (전투 불능)" : "🏆 컬링 게임 종료")
      .setDescription([
        ...log.slice(-6),
        ``,
        `> 🌊 최종 WAVE: **${session.wave}**  |  처치: **${session.kills}**마리`,
        `> ⭐ XP **+${xpGain}** | 💎 **+${crystalGain}**`,
        `> 🏆 최고 기록: **WAVE ${player.cullingBest}**`,
        questDone,
      ].filter(Boolean).join("\n"))],
    components: [],
  });
}

// ════════════════════════════════════════════════════════
// 사멸회유 행동 핸들러
// ════════════════════════════════════════════════════════
async function handleJujutsuAction(interaction, player, session, customId) {
  const stats = getPlayerStats(player);
  const enemy = session.currentEnemy;
  const log = [];

  if (!enemy) {
    const choices = generateJujutsuChoices(session.wave);
    session.choices = choices;
    return interaction.update({
      embeds: [jujutsuEmbed(player, session, ["> ⚔️ 다음 적을 선택하세요!"], choices)],
      components: mkJujutsuButtons(player, choices),
    });
  }

  if (isIncapacitated(player.statusEffects)) {
    const se = player.statusEffects.find(s => s.id === "freeze" || s.id === "stun");
    const def = STATUS_EFFECTS[se.id];
    log.push(`> ${def.emoji} **[${def.name}]** 행동 불가!`);
    se.turns--;
    if (se.turns <= 0) player.statusEffects = player.statusEffects.filter(s => s.id !== se.id);
    await doJujutsuEnemyAttack(player, session, log);
    tickCooldowns(player);
    savePlayer(player.id);
    if ((player.hp || 0) <= 0) return endJujutsu(interaction, player, session, true, log);
    return interaction.update({ embeds: [jujutsuEmbed(player, session, log)], components: mkJujutsuButtons(player, []) });
  }

  if (customId === "j_attack") {
    const hitRoll = rollHit(player.statusEffects, enemy.statusEffects || []);
    if (!hitRoll) {
      log.push(`> 💨 **공격 빗나감!**`);
    } else {
      const { dmg, isCrit } = calcDmgForPlayer(player, enemy.def);
      const bf = isBlackFlash();
      const finalDmg = bf ? Math.floor(dmg * 2.5) : dmg;
      session.enemyHp = Math.max(0, (session.enemyHp || 0) - finalDmg);
      if (bf) { log.push(getBlackFlashArt()); log.push(`> ⚫ **[흑섬!]** **${finalDmg}** 피해! (+50💎)`); player.crystals = (player.crystals || 0) + 50; }
      else if (isCrit) log.push(`> ⚡ **[치명타!]** **${finalDmg}** 피해!`);
      else log.push(`> ⚔️ 공격! **${finalDmg}** 피해!`);
    }
  } else if (customId === "j_skill") {
    if ((player.skillCooldown || 0) > 0) return interaction.reply({ content: `⏳ 쿨타임 ${player.skillCooldown}턴`, ephemeral: true });
    const skill = getCurrentSkill(player, player.active);
    if (!skill) return interaction.reply({ content: "❌ 술식 없음", ephemeral: true });
    const fx = getSkillEffect(skill.name);
    const { dmg, isCrit } = calcSkillDmgForPlayer(player, skill.dmg);
    const bf = isBlackFlash();
    const finalDmg = bf ? Math.floor(dmg * 2.5) : dmg;
    session.enemyHp = Math.max(0, (session.enemyHp || 0) - finalDmg);
    log.push(fx.art);
    log.push(`> 🌀 **[${skill.name}]** ${fx.flavorText}`);
    if (bf) { log.push(getBlackFlashArt()); log.push(`> ⚫ **[흑섬×술식!]** **${finalDmg}** 피해!`); player.crystals = (player.crystals || 0) + 50; }
    else if (isCrit) log.push(`> ⚡ **[치명타!]** **${finalDmg}** 피해!`);
    else log.push(`> 💥 **${finalDmg}** 피해!`);
    const sm = applySkillStatus(skill, enemy, player);
    if (sm.length) log.push(...sm.map(s => `> ${s}`));
    player.skillCooldown = 5;
    updateQuestProgress(player, "skill_use", 1);
  } else if (customId === "j_domain") {
    const ch = CHARACTERS[player.active];
    if (!ch?.domain) return interaction.reply({ content: "❌ 영역전개 없음", ephemeral: true });
    if (!canUseDomain(player)) return interaction.reply({ content: `⏳ 영역전개 쿨타임 ${player.domainCooldown}턴`, ephemeral: true });
    const result = applyDomainExpansion(stats, ch.domain, enemy, false);
    session.enemyHp = Math.max(0, (session.enemyHp || 0) - result.dmg);
    enemy.statusEffects = enemy.statusEffects || [];
    log.push(...result.log);
    player.domainCooldown = 15;
    updateQuestProgress(player, "skill_use", 1);
  } else if (customId === "j_reverse") {
    if (!REVERSE_CHARS.has(player.active)) return interaction.reply({ content: "❌ 반전술식 불가", ephemeral: true });
    if ((player.reverseCooldown || 0) > 0) return interaction.reply({ content: `⏳ 반전 쿨타임 ${player.reverseCooldown}턴`, ephemeral: true });
    const healAmt = Math.floor(stats.maxHp * 0.35);
    player.hp = Math.min(stats.maxHp, (player.hp || 0) + healAmt);
    player.statusEffects = (player.statusEffects || []).filter(s => !["poison","burn","cursed_wound","dotBleed"].includes(s.id));
    log.push(`> ♻️ **[반전술식]** HP **+${healAmt}** 회복!`);
    player.reverseCooldown = 3;
  }

  // 적 처치 체크
  if ((session.enemyHp || 0) <= 0) {
    const drops = rollDrops(enemy.id || "j1", true);
    addMaterials(player, drops);
    session.points = (session.points || 0) + (enemy.points || 1);
    session.totalXp += (enemy.xp || 0);
    session.totalCrystals += (enemy.crystals || 0);
    if (enemy.fingers) player.sukunaFingers = Math.min(SUKUNA_FINGER_MAX, (player.sukunaFingers || 0) + enemy.fingers);
    const masteryGain = enemy.masteryXp || 1;
    if (!player.mastery) player.mastery = {};
    player.mastery[player.active] = (player.mastery[player.active] || 0) + masteryGain;
    updateQuestProgress(player, "jujutsu_point", enemy.points || 1);
    log.push(`> ✅ **${enemy.name}** 처치! +**${enemy.points}pt** (총 **${session.points}pt**/15)`);
    if (Object.keys(drops).length) log.push(`> 📦 ${formatDrops(drops)}`);

    if (session.points >= 15) {
      // 목표 달성!
      return endJujutsu(interaction, player, session, false, log);
    }

    session.wave++;
    session.currentEnemy = null;
    session.enemyHp = 0;
    const choices = generateJujutsuChoices(session.wave);
    session.choices = choices;
    tickCooldowns(player);
    savePlayer(player.id);
    return interaction.update({
      embeds: [jujutsuEmbed(player, session, log, choices)],
      components: mkJujutsuButtons(player, choices),
    });
  } else {
    await doJujutsuEnemyAttack(player, session, log);
    const eTick = tickStatus(session.currentEnemy, session.currentEnemy.hp);
    if (eTick.log.length) log.push(...eTick.log);
    session.enemyHp = session.currentEnemy.hp;
  }

  tickCooldowns(player);
  savePlayer(player.id);

  if ((player.hp || 0) <= 0) return endJujutsu(interaction, player, session, true, log);

  return interaction.update({
    embeds: [jujutsuEmbed(player, session, log)],
    components: mkJujutsuButtons(player, []),
  });
}

async function doJujutsuEnemyAttack(player, session, log) {
  const stats = getPlayerStats(player);
  const enemy = session.currentEnemy;
  if (!enemy) return;
  if (!rollHit(enemy.statusEffects || [], player.statusEffects || [])) {
    log.push(`> 💨 **${enemy.name}** 공격 빗나감!`); return;
  }
  const tick = tickStatus(player, stats.maxHp);
  if (tick.log.length) log.push(...tick.log);
  const eDmg = calcDmg(enemy.atk, stats.def);
  player.hp = Math.max(0, (player.hp || 0) - eDmg);
  log.push(`> 💢 **${enemy.name}** 반격! **${eDmg}** 피해!`);
  if (enemy.statusAttack && Math.random() < (enemy.statusAttack.chance || 0.3)) {
    applyStatus(player, enemy.statusAttack.statusId);
    const sdef = STATUS_EFFECTS[enemy.statusAttack.statusId];
    if (sdef) log.push(`> ${sdef.emoji} **${sdef.name}** 상태이상!`);
  }
}

async function endJujutsu(interaction, player, session, died, log) {
  const kb = getKoganeBonus(player);
  const xpGain = Math.floor(session.totalXp * kb.xp);
  let crystalGain = Math.floor(session.totalCrystals * kb.crystal);
  let bonusMsg = "";
  if (session.points >= 15 && !died) {
    crystalGain += 300; player.xp = (player.xp || 0) + 500;
    bonusMsg = "\n> 🎉 **15pt 달성 보너스!** +300💎 +500XP";
  }
  player.xp = (player.xp || 0) + xpGain;
  player.crystals = (player.crystals || 0) + crystalGain;
  if (session.points > (player.jujutsuBest || 0)) player.jujutsuBest = session.points;
  if (died) { player.losses = (player.losses || 0) + 1; player.hp = 0; }
  delete jujutsus[player.id];
  const questDone = getNewlyCompletedQuestMsg(player);
  savePlayer(player.id);
  return interaction.update({
    embeds: [new EmbedBuilder()
      .setColor(died ? 0xe63946 : session.points >= 15 ? 0xF5C842 : 0x7C5CFC)
      .setTitle(died ? "💀 사멸회유 종료 (전투 불능)" : session.points >= 15 ? "🏆 사멸회유 완료!" : "🏳️ 사멸회유 종료")
      .setDescription([
        ...log.slice(-5),
        ``,
        `> 🎯 최종 포인트: **${session.points}pt**`,
        `> ⭐ XP **+${xpGain}** | 💎 **+${crystalGain}**`,
        bonusMsg,
        `> 🏆 최고 기록: **${player.jujutsuBest}pt**`,
        questDone,
      ].filter(Boolean).join("\n"))],
    components: [],
  });
}

// ════════════════════════════════════════════════════════
// PvP 행동 핸들러 (완전 안정화)
// ════════════════════════════════════════════════════════
async function handlePvpAction(interaction, player, session, customId) {
  if (session.turn !== player.id) return interaction.reply({ content: "⏳ 당신의 턴이 아닙니다!", ephemeral: true });

  const selfInfo = pvpSelf(session, player.id);
  const oppInfo = pvpOpponent(session, player.id);
  const oppPlayer = players[oppInfo.id];
  if (!oppPlayer) {
    delete pvpSessions[session.id];
    return interaction.update({ content: "❌ 상대방 정보 없음. PvP 취소.", embeds: [], components: [] });
  }

  const selfStats = getPlayerStats(player);
  const oppStats = getPlayerStats(oppPlayer);
  const log = [];

  // 자신의 HP = session의 hp 값 사용 (실시간 동기화)
  const selfHp = session[selfInfo.hpKey];
  const oppHp = session[oppInfo.hpKey];

  // 상태이상 tick (자신)
  const selfStatus = session[selfInfo.statusKey] || [];
  const oppStatus = session[oppInfo.statusKey] || [];

  if (customId === "pvp_surrender") {
    pvpEndSession(session, oppInfo.id, player.id, "항복");
    player.pvpLosses = (player.pvpLosses || 0) + 1;
    oppPlayer.pvpWins = (oppPlayer.pvpWins || 0) + 1;
    oppPlayer.crystals = (oppPlayer.crystals || 0) + 100;
    savePlayer(player.id); savePlayer(oppPlayer.id);
    return interaction.update({
      embeds: [new EmbedBuilder().setColor(0xe63946).setTitle("🏳️ PvP 항복")
        .setDescription(`> **${player.name}** 이(가) 항복!\n> **${oppPlayer.name}** 승리! (+100💎)`)],
      components: [],
    });
  }

  // 기절/빙결 체크
  if (isIncapacitated(selfStatus)) {
    const se = selfStatus.find(s => s.id === "freeze" || s.id === "stun");
    const def = STATUS_EFFECTS[se.id];
    log.push(`> ${def.emoji} **[${def.name}]** ${player.name} 행동 불가!`);
    se.turns--;
    if (se.turns <= 0) session[selfInfo.statusKey] = selfStatus.filter(s => s.id !== se.id);
    session.turn = oppInfo.id;
    session.round = (session.round || 1) + 1;
    pvpTickCooldowns(session);
    savePlayer(player.id);
    return interaction.update({ embeds: [pvpEmbed(session, log)], components: [mkPvpButtons(session, oppInfo.id)] });
  }

  let dmg = 0;

  if (customId === "pvp_atk") {
    const hitRoll = rollHit(selfStatus, oppStatus);
    if (!hitRoll) {
      log.push(`> 💨 **${player.name}**의 공격 빗나감!`);
    } else {
      const { dmg: d, isCrit } = calcDmgForPlayer(player, oppStats.def);
      const bf = isBlackFlash();
      dmg = bf ? Math.floor(d * 2.5) : d;
      if (bf) { log.push(getBlackFlashArt()); log.push(`> ⚫ **[흑섬!]** ${player.name} → ${oppPlayer.name} **${dmg}** 피해!`); player.crystals = (player.crystals || 0) + 50; }
      else if (isCrit) log.push(`> ⚡ **[치명타!]** ${player.name} → ${oppPlayer.name} **${dmg}** 피해!`);
      else log.push(`> ⚔️ **${player.name}** 공격 → **${dmg}** 피해!`);
      session[oppInfo.hpKey] = Math.max(0, oppHp - dmg);
    }
  } else if (customId === "pvp_skill") {
    const cd = session[selfInfo.skillCdKey] || 0;
    if (cd > 0) return interaction.reply({ content: `⏳ 술식 쿨타임 ${cd}턴`, ephemeral: true });
    const skill = getCurrentSkill(player, player.active);
    if (!skill) return interaction.reply({ content: "❌ 술식 없음", ephemeral: true });
    const fx = getSkillEffect(skill.name);
    const { dmg: d, isCrit } = calcSkillDmgForPlayer(player, skill.dmg);
    const bf = isBlackFlash();
    dmg = bf ? Math.floor(d * 2.5) : d;
    log.push(fx.art);
    log.push(`> 🌀 **[${skill.name}]** ${fx.flavorText}`);
    if (bf) { log.push(getBlackFlashArt()); log.push(`> ⚫ **[흑섬×술식!]** **${dmg}** 피해!`); player.crystals = (player.crystals || 0) + 50; }
    else if (isCrit) log.push(`> ⚡ **[치명타!]** **${dmg}** 피해!`);
    else log.push(`> 💥 **${dmg}** 피해!`);
    const fakeOppObj = { statusEffects: session[oppInfo.statusKey] || [] };
    const sm = applySkillStatus(skill, fakeOppObj, player);
    session[oppInfo.statusKey] = fakeOppObj.statusEffects;
    if (sm.length) log.push(...sm.map(s => `> ${s}`));
    session[selfInfo.skillCdKey] = 5;
    session[oppInfo.hpKey] = Math.max(0, oppHp - dmg);
    updateQuestProgress(player, "skill_use", 1);
  } else if (customId === "pvp_domain") {
    const cd = session[selfInfo.domainCdKey] || 0;
    if (cd > 0) return interaction.reply({ content: `⏳ 영역전개 쿨타임 ${cd}턴`, ephemeral: true });
    const ch = CHARACTERS[player.active];
    if (!ch?.domain) return interaction.reply({ content: "❌ 영역전개 없음", ephemeral: true });
    const fakeOppObj = { statusEffects: session[oppInfo.statusKey] || [], hp: session[oppInfo.hpKey] || 0 };
    const result = applyDomainExpansion(selfStats, ch.domain, fakeOppObj, true);
    session[oppInfo.statusKey] = fakeOppObj.statusEffects;
    session[oppInfo.hpKey] = fakeOppObj.hp;
    log.push(...result.log);
    session[selfInfo.domainCdKey] = 15;
    updateQuestProgress(player, "skill_use", 1);
  } else if (customId === "pvp_reverse") {
    if (!REVERSE_CHARS.has(player.active)) return interaction.reply({ content: "❌ 반전술식 불가", ephemeral: true });
    const cd = session[selfInfo.reverseCdKey] || 0;
    if (cd > 0) return interaction.reply({ content: `⏳ 반전 쿨타임 ${cd}턴`, ephemeral: true });
    const healAmt = Math.floor(selfStats.maxHp * 0.30);
    session[selfInfo.hpKey] = Math.min(session[selfInfo.hpKey === "hp1" ? "maxHp1" : "maxHp2"], (session[selfInfo.hpKey] || 0) + healAmt);
    const cleaned = (session[selfInfo.statusKey] || []).filter(s => !["poison","burn","cursed_wound","dotBleed"].includes(s.id));
    session[selfInfo.statusKey] = cleaned;
    log.push(`> ♻️ **[반전술식]** ${player.name} HP **+${healAmt}** 회복!`);
    session[selfInfo.reverseCdKey] = 3;
  }

  // 상태이상 DoT tick (자신)
  const selfTickResult = pvpTickStatus(session, selfInfo, selfStats.maxHp);
  if (selfTickResult.log.length) log.push(...selfTickResult.log);

  // 승패 체크
  if (session[oppInfo.hpKey] <= 0) {
    const winner = player, loser = oppPlayer;
    winner.pvpWins = (winner.pvpWins || 0) + 1;
    loser.pvpLosses = (loser.pvpLosses || 0) + 1;
    const xpGain = 300, crystalGain = 150;
    winner.xp = (winner.xp || 0) + xpGain;
    winner.crystals = (winner.crystals || 0) + crystalGain;
    updateQuestProgress(winner, "pvp_win", 1);
    pvpEndSession(session, winner.id, loser.id, "KO");
    savePlayer(winner.id); savePlayer(loser.id);
    const ch1 = CHARACTERS[winner.active] || CHARACTERS["itadori"];
    return interaction.update({
      embeds: [new EmbedBuilder().setColor(0xF5C842).setTitle("⚔️ PvP 결투 종료!")
        .setDescription([
          log.join("\n"),
          ``,
          `\`\`\`ansi\n\u001b[1;33m╔══════════════════════════════════╗\n║  🏆  ${winner.name.slice(0,14).padEnd(14)}  WINS!  🏆  ║\n╚══════════════════════════════════╝\n\`\`\``,
          `> 🏆 **${winner.name}** 승리! (+${xpGain}XP +${crystalGain}💎)`,
          `> 💀 **${loser.name}** 패배!`,
          `> 📊 ${winner.name}: ${winner.pvpWins}승 ${winner.pvpLosses || 0}패`,
        ].filter(Boolean).join("\n"))],
      components: [],
    });
  }

  if (session[selfInfo.hpKey] <= 0) {
    const winner = oppPlayer, loser = player;
    winner.pvpWins = (winner.pvpWins || 0) + 1;
    loser.pvpLosses = (loser.pvpLosses || 0) + 1;
    const xpGain = 300, crystalGain = 150;
    winner.xp = (winner.xp || 0) + xpGain;
    winner.crystals = (winner.crystals || 0) + crystalGain;
    updateQuestProgress(winner, "pvp_win", 1);
    pvpEndSession(session, winner.id, loser.id, "KO");
    savePlayer(winner.id); savePlayer(loser.id);
    return interaction.update({
      embeds: [new EmbedBuilder().setColor(0xe63946).setTitle("⚔️ PvP 결투 종료!")
        .setDescription([
          log.join("\n"),
          ``,
          `> 🏆 **${winner.name}** 승리! (+${xpGain}XP +${crystalGain}💎)`,
          `> 💀 **${loser.name}** 패배!`,
        ].filter(Boolean).join("\n"))],
      components: [],
    });
  }

  // 턴 교환
  session.turn = oppInfo.id;
  session.round = (session.round || 1) + 1;
  pvpTickCooldowns(session);
  savePlayer(player.id);

  return interaction.update({
    embeds: [pvpEmbed(session, log)],
    components: [mkPvpButtons(session, oppInfo.id)],
  });
}

function pvpTickCooldowns(session) {
  if (session.skillCd1 > 0) session.skillCd1--;
  if (session.skillCd2 > 0) session.skillCd2--;
  if (session.reverseCd1 > 0) session.reverseCd1--;
  if (session.reverseCd2 > 0) session.reverseCd2--;
  if (session.domainCd1 > 0) session.domainCd1--;
  if (session.domainCd2 > 0) session.domainCd2--;
}

function pvpTickStatus(session, selfInfo, maxHp) {
  const status = session[selfInfo.statusKey] || [];
  if (!status.length) return { log: [] };
  let totalDmg = 0;
  const log = [];
  for (const se of status) {
    const def = STATUS_EFFECTS[se.id];
    if (!def) { se.turns = 0; continue; }
    if (se.id === "poison") { const d = Math.max(1, Math.floor(maxHp * 0.05)); totalDmg += d; log.push(`> ${def.emoji} **${def.name}** — **${d}** 피해!`); }
    if (se.id === "burn") { const d = Math.max(1, Math.floor(maxHp * 0.08)); totalDmg += d; log.push(`> ${def.emoji} **${def.name}** — **${d}** 피해!`); }
    if (se.id === "cursed_wound") { const d = Math.max(1, Math.floor(maxHp * 0.10)); totalDmg += d; log.push(`> ${def.emoji} **${def.name}** — **${d}** 피해!`); }
    if (se.id === "dotBleed") { const d = Math.max(1, Math.floor(maxHp * 0.07)); totalDmg += d; log.push(`> ${def.emoji} **${def.name}** — **${d}** 피해!`); }
    se.turns--;
  }
  session[selfInfo.statusKey] = status.filter(s => s.turns > 0);
  if (totalDmg > 0) session[selfInfo.hpKey] = Math.max(0, (session[selfInfo.hpKey] || 0) - totalDmg);
  return { log };
}

function pvpEndSession(session, winnerId, loserId, reason) {
  delete pvpSessions[session.id];
}

// ════════════════════════════════════════════════════════
// 레이드 행동 핸들러
// ════════════════════════════════════════════════════════
async function handleRaidAction(interaction, player, raidSession, customId) {
  const stats = getPlayerStats(player);
  const boss = RAID_BOSSES[raidSession.bossId];
  if (!boss) return interaction.reply({ content: "❌ 레이드 보스 정보 없음", ephemeral: true });
  const log = [];

  if (customId === "r_retreat") {
    raidSession.members = raidSession.members.filter(id => id !== player.id);
    if (raidSession.members.length === 0) delete raidSessions[raidSession.id];
    savePlayer(player.id);
    return interaction.update({ content: "🏳️ 레이드에서 철수했습니다.", embeds: [], components: [] });
  }

  if (isIncapacitated(player.statusEffects)) {
    const se = player.statusEffects.find(s => s.id === "freeze" || s.id === "stun");
    const def = STATUS_EFFECTS[se.id];
    log.push(`> ${def.emoji} **[${def.name}]** ${player.name} 행동 불가!`);
    se.turns--;
    if (se.turns <= 0) player.statusEffects = player.statusEffects.filter(s => s.id !== se.id);
    savePlayer(player.id);
    return interaction.update({ embeds: [raidEmbed(raidSession, log)], components: [mkRaidButtons(player)] });
  }

  // 마허라가라 적응 시스템
  if (boss.adaptationSkill && commandId === "r_skill") {
    const skill = getCurrentSkill(player, player.active);
    if (skill && raidSession.adaptedSkills?.includes(skill.name)) {
      log.push(`> 🔄 **[적응]** 마허라가라가 **${skill.name}**에 이미 적응! 데미지 무효!`);
      await doRaidBossAttack(player, raidSession, boss, log);
      tickCooldowns(player);
      savePlayer(player.id);
      if ((player.hp || 0) <= 0) return handleRaidPlayerDeath(interaction, player, raidSession, log);
      return interaction.update({ embeds: [raidEmbed(raidSession, log)], components: [mkRaidButtons(player)] });
    }
  }

  if (customId === "r_attack") {
    const hitRoll = rollHit(player.statusEffects, []);
    if (!hitRoll) {
      log.push(`> 💨 **${player.name}** 공격 빗나감!`);
    } else {
      const { dmg, isCrit } = calcDmgForPlayer(player, boss.def);
      const bf = isBlackFlash();
      const finalDmg = bf ? Math.floor(dmg * 2.5) : dmg;
      raidSession.hp = Math.max(0, raidSession.hp - finalDmg);
      if (bf) { log.push(getBlackFlashArt()); log.push(`> ⚫ **[흑섬!]** ${player.name} — **${finalDmg}** 피해!`); player.crystals = (player.crystals || 0) + 50; }
      else if (isCrit) log.push(`> ⚡ **[치명타!]** ${player.name} — **${finalDmg}** 피해!`);
      else log.push(`> ⚔️ **${player.name}** 공격! **${finalDmg}** 피해!`);
    }
  } else if (customId === "r_skill") {
    if ((player.skillCooldown || 0) > 0) return interaction.reply({ content: `⏳ 술식 쿨타임 ${player.skillCooldown}턴`, ephemeral: true });
    const skill = getCurrentSkill(player, player.active);
    if (!skill) return interaction.reply({ content: "❌ 술식 없음", ephemeral: true });
    const fx = getSkillEffect(skill.name);
    const { dmg, isCrit } = calcSkillDmgForPlayer(player, skill.dmg);
    const bf = isBlackFlash();
    const finalDmg = bf ? Math.floor(dmg * 2.5) : dmg;
    raidSession.hp = Math.max(0, raidSession.hp - finalDmg);
    log.push(fx.art);
    log.push(`> 🌀 **[${skill.name}]** ${fx.flavorText}`);
    if (bf) { log.push(getBlackFlashArt()); log.push(`> ⚫ **[흑섬×술식!]** **${finalDmg}** 피해!`); player.crystals = (player.crystals || 0) + 50; }
    else if (isCrit) log.push(`> ⚡ **[치명타!]** **${finalDmg}** 피해!`);
    else log.push(`> 💥 **${finalDmg}** 피해!`);
    player.skillCooldown = 5;
    // 마허라가라 적응 등록
    if (boss.adaptationSkill) {
      if (!raidSession.adaptedSkills) raidSession.adaptedSkills = [];
      if (!raidSession.adaptedSkills.includes(skill.name)) raidSession.adaptedSkills.push(skill.name);
    }
    updateQuestProgress(player, "skill_use", 1);
  } else if (customId === "r_domain") {
    if (!canUseDomain(player)) return interaction.reply({ content: `⏳ 영역전개 쿨타임 ${player.domainCooldown}턴`, ephemeral: true });
    const ch = CHARACTERS[player.active];
    if (!ch?.domain) return interaction.reply({ content: "❌ 영역전개 없음", ephemeral: true });
    const fakeTarget = { statusEffects: [], hp: raidSession.hp };
    const result = applyDomainExpansion(stats, ch.domain, fakeTarget, true);
    raidSession.hp = fakeTarget.hp;
    log.push(...result.log);
    player.domainCooldown = 15;
    updateQuestProgress(player, "skill_use", 1);
  }

  // 엔레이지 체크 (HP 40% 이하)
  if (!raidSession.enraged && raidSession.hp <= Math.floor(boss.hp * (boss.phaseHp || 0.5))) {
    raidSession.enraged = true;
    log.push(`> ⚠️ **[분노 페이즈!]** ${boss.name} 공격력 대폭 상승!`);
  }

  // 레이드 클리어
  if (raidSession.hp <= 0) {
    delete raidSessions[raidSession.id];
    const drops = rollDrops(boss.dropKey || "raid_heian");
    const xpGain = boss.xp || 2500;
    const crystalGain = boss.crystals || 500;
    for (const uid of raidSession.members) {
      const p = players[uid];
      if (!p) continue;
      const kb = getKoganeBonus(p);
      p.xp = (p.xp || 0) + Math.floor(xpGain * kb.xp);
      p.crystals = (p.crystals || 0) + Math.floor(crystalGain * kb.crystal);
      addMaterials(p, drops);
      if (!p.mastery) p.mastery = {};
      p.mastery[p.active] = (p.mastery[p.active] || 0) + (boss.masteryXp || 35);
      p.sukunaFingers = Math.min(SUKUNA_FINGER_MAX, (p.sukunaFingers || 0) + (boss.fingers || 2));
      if (!p.raidClears) p.raidClears = {};
      p.raidClears[raidSession.bossId] = (p.raidClears[raidSession.bossId] || 0) + 1;
      updateQuestProgress(p, "boss_kill", 1);
      savePlayer(uid);
    }
    const questDone = getNewlyCompletedQuestMsg(player);
    return interaction.update({
      embeds: [new EmbedBuilder().setColor(0xF5C842).setTitle(`🏆 레이드 클리어! ${boss.name} 격파!`)
        .setDescription([
          `\`\`\`ansi\n\u001b[1;33m╔══════════════════════════════════╗\n║  🔱  RAID  CLEAR!  🔱            ║\n╚══════════════════════════════════╝\n\`\`\``,
          `> ⭐ 전원 XP **+${xpGain}** | 💎 **+${crystalGain}**`,
          `> 📦 재료: ${formatDrops(drops)}`,
          `> 👹 스쿠나 손가락 **+${boss.fingers || 2}개** 지급!`,
          questDone,
        ].filter(Boolean).join("\n"))],
      components: [],
    });
  }

  // 보스 반격 (참여 파티원 전체 공격)
  for (const uid of raidSession.members) {
    const p = players[uid];
    if (!p || (p.hp || 0) <= 0) continue;
    await doRaidBossAttack(p, raidSession, boss, log);
    savePlayer(uid);
  }

  tickCooldowns(player);
  savePlayer(player.id);

  if ((player.hp || 0) <= 0) return handleRaidPlayerDeath(interaction, player, raidSession, log);

  return interaction.update({ embeds: [raidEmbed(raidSession, log)], components: [mkRaidButtons(player)] });
}

async function handleRaidPlayerDeath(interaction, player, raidSession, log) {
  player.losses = (player.losses || 0) + 1;
  savePlayer(player.id);
  const aliveMembers = raidSession.members.filter(uid => (players[uid]?.hp || 0) > 0);
  if (aliveMembers.length === 0) {
    delete raidSessions[raidSession.id];
    return interaction.update({
      embeds: [new EmbedBuilder().setColor(0xe63946).setTitle("💀 레이드 전멸!")
        .setDescription([...log.slice(-4), `> 💀 **파티 전원 전투 불능!** 레이드 실패.`].join("\n"))],
      components: [],
    });
  }
  return interaction.update({
    embeds: [raidEmbed(raidSession, [...log, `> 💀 **${player.name}** 전투 불능! 파티원이 계속 싸운다!`])],
    components: [mkRaidButtons(player)],
  });
}

// ════════════════════════════════════════════════════════
// 파티 컬링 행동 핸들러
// ════════════════════════════════════════════════════════
async function handlePartyCullingAction(interaction, player, session, customId) {
  const party = getParty(player.id);
  if (!party) return interaction.reply({ content: "❌ 파티 없음", ephemeral: true });
  const stats = getPlayerStats(player);
  const enemy = session.currentEnemy;
  const log = [];

  if (customId === "pc_escape") {
    const kb = getKoganeBonus(player);
    const xpGain = Math.floor(session.totalXp / party.members.length * kb.xp);
    const crystalGain = Math.floor(session.totalCrystals / party.members.length * kb.crystal);
    player.xp = (player.xp || 0) + xpGain;
    player.crystals = (player.crystals || 0) + crystalGain;
    if (session.wave > (player.cullingBest || 0)) player.cullingBest = session.wave;
    delete cullings[party.id];
    savePlayer(player.id);
    return interaction.update({ content: `🏳️ 파티 컬링 종료. ⭐+${xpGain} 💎+${crystalGain}`, embeds: [], components: [] });
  }

  if (customId === "pc_attack") {
    const { dmg, isCrit } = calcDmgForPlayer(player, enemy.def);
    const bf = isBlackFlash();
    const finalDmg = bf ? Math.floor(dmg * 2.5) : dmg;
    session.enemyHp = Math.max(0, (session.enemyHp || 0) - finalDmg);
    if (bf) { log.push(getBlackFlashArt()); log.push(`> ⚫ **[흑섬!]** ${player.name} — **${finalDmg}** 피해!`); player.crystals = (player.crystals || 0) + 50; }
    else if (isCrit) log.push(`> ⚡ **[치명타!]** ${player.name} — **${finalDmg}** 피해!`);
    else log.push(`> ⚔️ **${player.name}** 공격! **${finalDmg}** 피해!`);
  } else if (customId === "pc_skill") {
    if ((player.skillCooldown || 0) > 0) return interaction.reply({ content: `⏳ 쿨타임 ${player.skillCooldown}턴`, ephemeral: true });
    const skill = getCurrentSkill(player, player.active);
    if (!skill) return interaction.reply({ content: "❌ 술식 없음", ephemeral: true });
    const fx = getSkillEffect(skill.name);
    const { dmg, isCrit } = calcSkillDmgForPlayer(player, skill.dmg);
    const bf = isBlackFlash();
    const finalDmg = bf ? Math.floor(dmg * 2.5) : dmg;
    session.enemyHp = Math.max(0, (session.enemyHp || 0) - finalDmg);
    log.push(fx.art);
    log.push(`> 🌀 **[${skill.name}]** ${fx.flavorText}`);
    if (bf) { log.push(getBlackFlashArt()); log.push(`> ⚫ **[흑섬×술식!]** **${finalDmg}** 피해!`); player.crystals = (player.crystals || 0) + 50; }
    else if (isCrit) log.push(`> ⚡ **[치명타!]** **${finalDmg}** 피해!`);
    else log.push(`> 💥 **${finalDmg}** 피해!`);
    player.skillCooldown = 5;
  }

  if ((session.enemyHp || 0) <= 0) {
    const drops = rollDrops(enemy.id || "e1");
    session.kills = (session.kills || 0) + 1;
    session.totalXp += (enemy.xp || 0);
    session.totalCrystals += (enemy.crystals || 0);
    log.push(`> ✅ **${enemy.name}** 처치! 🌊 WAVE **${session.wave + 1}**!`);
    for (const uid of party.members) {
      const p = players[uid]; if (!p) continue;
      addMaterials(p, drops);
      if (!p.mastery) p.mastery = {};
      p.mastery[p.active] = (p.mastery[p.active] || 0) + (enemy.masteryXp || 1);
      updateQuestProgress(p, "culling_wave", 1);
      savePlayer(uid);
    }
    session.wave++;
    const newEnemy = pickCullingEnemy(session.wave);
    session.currentEnemy = newEnemy;
    session.enemyHp = newEnemy.hp;
  } else {
    // 보스가 파티원 전체를 공격
    for (const uid of party.members) {
      const p = players[uid]; if (!p || (p.hp || 0) <= 0) continue;
      const pStats = getPlayerStats(p);
      const eDmg = calcDmg(enemy.atk, pStats.def);
      p.hp = Math.max(0, (p.hp || 0) - eDmg);
      savePlayer(uid);
    }
    log.push(`> 💢 **${enemy.name}** 파티 전체 공격!`);
  }

  tickCooldowns(player);
  savePlayer(player.id);

  if ((player.hp || 0) <= 0) {
    log.push(`> 💀 **${player.name}** 전투 불능!`);
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("pc_attack").setLabel("⚔️ 공격").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("pc_skill").setLabel(`🌀 ${getCurrentSkill(player, player.active)?.name || "술식"}`).setStyle(ButtonStyle.Primary).setDisabled((player.skillCooldown || 0) > 0),
    new ButtonBuilder().setCustomId("pc_escape").setLabel("🏳️ 철수").setStyle(ButtonStyle.Secondary),
  );

  return interaction.update({ embeds: [partyCullingEmbed(party, session, log)], components: [row] });
}

// ════════════════════════════════════════════════════════
// 슬래시 커맨드 핸들러
// ════════════════════════════════════════════════════════
async function handleSlashCommand(interaction, commandName, player, userId, user) {
  switch (commandName) {

    // ── 프로필
    case "프로필": {
      await interaction.deferReply();
      try {
        const gifBuf = await generateProfileGif(player, user);
        const attachment = new AttachmentBuilder(gifBuf, { name: "profile.gif" });
        const embed = profileEmbed(player);
        embed.setImage("attachment://profile.gif");
        await interaction.editReply({ embeds: [embed], files: [attachment] });
      } catch (e) {
        console.error("[프로필 GIF 오류]", e.message);
        await interaction.editReply({ embeds: [profileEmbed(player)] });
      }
      break;
    }

    // ── 전투
    case "전투": {
      if (battles[userId]) return interaction.reply({ content: "⚔️ 이미 전투 중!", ephemeral: true });
      if ((player.hp || 0) <= 0) return interaction.reply({ content: "💀 HP가 없습니다. `/회복` 으로 회복하세요!", ephemeral: true });
      if (getPvpSessionByUser(userId)) return interaction.reply({ content: "❌ PvP 중에는 전투 불가!", ephemeral: true });

      const stats = getPlayerStats(player);
      const enemyPool = player.sukunaFingers >= 10
        ? ["e1","e2","e3","e4","e_sukuna"]
        : ["e1","e1","e2","e2","e3","e3","e4"];
      const weights = player.sukunaFingers >= 10
        ? [20, 25, 25, 20, 10]
        : [25, 30, 25, 15, 5];
      const totalW = weights.reduce((a,b)=>a+b,0);
      let roll = Math.random() * totalW;
      let enemyId = "e1";
      for (let i = 0; i < enemyPool.length; i++) {
        roll -= weights[i] || (totalW / enemyPool.length);
        if (roll <= 0) { enemyId = enemyPool[i]; break; }
      }

      const baseEnemy = ENEMIES.find(e => e.id === enemyId) || ENEMIES[0];
      const lv = getLevel(player.xp || 0);
      const scale = 1 + (lv - 1) * 0.03;
      const enemy = {
        ...baseEnemy,
        hp: Math.floor(baseEnemy.hp * scale),
        atk: Math.floor(baseEnemy.atk * scale),
        def: Math.floor(baseEnemy.def * scale),
        maxHp: Math.floor(baseEnemy.hp * scale),
        statusEffects: [],
      };

      battles[userId] = { enemy };

      const ch = CHARACTERS[player.active] || CHARACTERS["itadori"];
      const ri = GACHA_RARITY[ch.grade] || GACHA_RARITY["3급"];
      const embed = new EmbedBuilder()
        .setColor(JJK_GRADE_COLOR[ch.grade] || 0x7C5CFC)
        .setTitle(`⚔️ 전투 시작! ${ch.emoji} ${ch.name} vs ${enemy.emoji} ${enemy.name}`)
        .setDescription([
          `\`\`\`ansi\n\u001b[1;33m╔══════════════════════════════════════╗\n║  ⚔️  B A T T L E   S T A R T  ⚔️    ║\n╚══════════════════════════════════════╝\n\`\`\``,
          `> ${ch.emoji} **${ch.name}** \`[${ch.grade}]\` ${ri.stars}`,
          `> 💚 HP **${Math.max(0,player.hp||0)}/${stats.maxHp}** · 🗡️ ATK **${stats.atk}** · 🛡️ DEF **${stats.def}**`,
          `> ${enemy.emoji} **${enemy.name}** — HP **${enemy.hp}** ATK **${enemy.atk}** DEF **${enemy.def}**`,
        ].join("\n"))
        .addFields(
          { name: "⚡ 쿨타임", value: `술식: ${(player.skillCooldown||0)>0?player.skillCooldown+"턴":"✅"} | 반전: ${(player.reverseCooldown||0)>0?player.reverseCooldown+"턴":"✅"} | 영역: ${(player.domainCooldown||0)>0?player.domainCooldown+"턴":"✅"}`, inline: false },
        );

      return interaction.reply({ embeds: [embed], components: mkBattleButtons(player) });
    }

    // ── 술식
    case "술식": {
      return interaction.reply({ embeds: [buildSkillEmbed(player)] });
    }

    // ── 회복
    case "회복": {
      const stats = getPlayerStats(player);
      if ((player.hp || 0) >= stats.maxHp) return interaction.reply({ content: "💚 HP가 이미 최대입니다!", ephemeral: true });
      if ((player.potion || 0) <= 0) return interaction.reply({ content: "🧪 회복약이 없습니다!", ephemeral: true });
      const healAmt = Math.floor(stats.maxHp * 0.50);
      player.hp = Math.min(stats.maxHp, (player.hp || 0) + healAmt);
      player.potion--;
      player.statusEffects = (player.statusEffects || []).filter(s => !["poison","burn","cursed_wound","dotBleed"].includes(s.id));
      savePlayer(userId);
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0x4ade80).setTitle("🧪 회복약 사용!")
          .setDescription(`> 💚 HP **+${healAmt}** → **${player.hp}/${stats.maxHp}**\n> 🧪 남은 회복약: **${player.potion}개**\n> 🩸 독/화상/저주 해제!`)]
      });
    }

    // ── 가챠
    case "가챠": {
      const count = interaction.options.getInteger("횟수") || 1;
      if (count !== 1 && count !== 10) return interaction.reply({ content: "❌ 횟수는 1 또는 10만 가능!", ephemeral: true });
      const cost = count === 10 ? 1000 : 100;
      if ((player.crystals || 0) < cost) return interaction.reply({ content: `❌ 크리스탈 부족! **${cost}💎** 필요 (보유: **${player.crystals||0}💎**)`, ephemeral: true });

      player.crystals -= cost;
      await interaction.deferReply();

      if (count === 1) {
        // 단일 가챠 컷씬
        await interaction.editReply({ embeds: [gachaLoadingEmbed(1)] });
        await new Promise(r => setTimeout(r, 800));
        const [charId] = rollGacha(1);
        const ch = CHARACTERS[charId];
        if (!ch) { await interaction.editReply({ content: "❌ 가챠 오류", embeds: [] }); return; }
        await interaction.editReply({ embeds: [gachaRevealEmbed(ch.grade)] });
        await new Promise(r => setTimeout(r, 700));
        const isNew = !(player.owned || []).includes(charId);
        if (isNew) {
          if (!player.owned) player.owned = ["itadori"];
          player.owned.push(charId);
          if (!player.mastery) player.mastery = {};
          if (!player.mastery[charId]) player.mastery[charId] = 0;
        } else {
          player.crystals += 50;
        }
        updateQuestProgress(player, "gacha_pull", 1);
        savePlayer(userId);
        return interaction.editReply({ embeds: [gachaResultEmbed(charId, isNew, player)] });

      } else {
        // 10연차
        await interaction.editReply({ embeds: [gachaLoadingEmbed(2)] });
        await new Promise(r => setTimeout(r, 600));
        const results = rollGacha(10);
        // 10연차 보장: 1급 이상 1개
        const hasRareUp = results.some(id => {
          const g = CHARACTERS[id]?.grade;
          return g === "특급" || g === "준특급" || g === "1급" || g === "준1급";
        });
        if (!hasRareUp) {
          const rarePool = GACHA_POOL.filter(p => {
            const g = CHARACTERS[p.id]?.grade;
            return g === "1급" || g === "준1급";
          });
          if (rarePool.length) results[9] = rarePool[Math.floor(Math.random() * rarePool.length)].id;
        }
        const newOnes = [];
        let dupCrystals = 0;
        for (const id of results) {
          const isNew = !(player.owned || []).includes(id);
          if (isNew) {
            if (!player.owned) player.owned = ["itadori"];
            player.owned.push(id);
            if (!player.mastery) player.mastery = {};
            if (!player.mastery[id]) player.mastery[id] = 0;
            newOnes.push(id);
          } else {
            dupCrystals += 50;
          }
        }
        player.crystals += dupCrystals;
        updateQuestProgress(player, "gacha_pull", 10);
        savePlayer(userId);
        return interaction.editReply({ embeds: [gacha10ResultEmbed(results, newOnes, dupCrystals, player)] });
      }
    }

    // ── 활성 (캐릭터 선택)
    case "활성": {
      if (!(player.owned || []).length || player.owned.every(id => !CHARACTERS[id])) {
        return interaction.reply({ content: "❌ 보유한 캐릭터가 없습니다.", ephemeral: true });
      }
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0x7C5CFC)
          .setTitle("🎭 캐릭터 선택")
          .setDescription("> 아래 메뉴에서 장착할 캐릭터를 선택하세요.\n> 선택 시 HP 완전 회복 + 상태이상 초기화됩니다.")
          .addFields({ name: "현재 장착", value: `> ${CHARACTERS[player.active]?.emoji || ""} **${CHARACTERS[player.active]?.name || "없음"}**`, inline: false })],
        components: [mkCharSelectMenu(player, "char_select")],
      });
    }

    // ── 도감 (고퀄화)
    case "도감": {
      const allChars = Object.entries(CHARACTERS);
      const ownedSet = new Set(player.owned || []);
      const gradeOrder = ["특급","준특급","1급","준1급","2급","3급"];
      const sorted = allChars.sort(([,a],[,b]) => gradeOrder.indexOf(a.grade) - gradeOrder.indexOf(b.grade));
      const lines = sorted.map(([id, ch]) => {
        const ri = GACHA_RARITY[ch.grade] || GACHA_RARITY["3급"];
        const owned = ownedSet.has(id);
        const isActive = player.active === id;
        const mastery = owned ? getMastery(player, id) : 0;
        const tmpStats = owned ? (() => { const tp = {...player, active:id}; return getPlayerStats(tp); })() : null;
        if (owned) {
          const awk = id === "maki" ? " 🔥[각성가능]" : "";
          const domain = ch.domain ? ` | 🌌 ${ch.domain}` : "";
          return `> ${isActive ? "▶️ **[장착]**" : "　"} ${ch.emoji} **${ch.name}** \`[${ch.grade}]\` ${ri.stars}\n> 　└ ATK **${tmpStats.atk}** · DEF **${tmpStats.def}** · HP **${tmpStats.maxHp}** · 숙련 **${mastery}**${domain}${awk}`;
        } else {
          return `> 🔒 ${ch.emoji} ~~${ch.name}~~ \`[${ch.grade}]\` ${ri.stars}  *미보유*`;
        }
      }).join("\n\n");
      const ownedCount = ownedSet.size;
      const totalCount = allChars.length;
      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0x7C5CFC)
          .setTitle(`📖 캐릭터 도감  (${ownedCount}/${totalCount})`)
          .setDescription(lines || "> 캐릭터 없음")
          .addFields({ name: "📊 컬렉션 현황", value: `> 보유: **${ownedCount}** / 전체: **${totalCount}**\n> 달성률: **${Math.floor(ownedCount/totalCount*100)}%**`, inline: false })
          .setFooter({ text: "▶️ 장착 중 | 🔒 미보유 | /활성 으로 교체" })],
      });
    }

    // ── 출석
    case "출석": {
      const now = Date.now();
      const last = player.lastDaily || 0;
      const diffH = (now - last) / (1000 * 60 * 60);
      if (diffH < 20) {
        const nextMs = last + 20 * 60 * 60 * 1000 - now;
        const h = Math.floor(nextMs / 3600000), m = Math.floor((nextMs % 3600000) / 60000);
        return interaction.reply({ content: `⏰ 출석은 **${h}시간 ${m}분** 후 가능합니다!`, ephemeral: true });
      }
      const streak = diffH < 48 ? (player.dailyStreak || 0) + 1 : 1;
      player.dailyStreak = streak;
      player.lastDaily = now;
      const base = 100;
      const streakBonus = Math.min(streak * 20, 200);
      const total = base + streakBonus;
      player.crystals = (player.crystals || 0) + total;
      player.potion = (player.potion || 0) + 1;
      const xpBonus = 100 + streak * 10;
      player.xp = (player.xp || 0) + xpBonus;
      savePlayer(userId);
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0xF5C842).setTitle("☀️ 출석 체크!")
          .setDescription([
            `> 🔥 **연속 출석 ${streak}일차!**`,
            `> 💎 **+${total}** 크리스탈 (기본 ${base} + 연속보너스 ${streakBonus})`,
            `> 🧪 회복약 **+1개**`,
            `> ⭐ XP **+${xpBonus}**`,
            `> 💎 총 크리스탈: **${player.crystals}**`,
          ].join("\n"))],
      });
    }

    // ── 코가네 가챠
    case "코가네가챠": {
      const cost = 200;
      if ((player.crystals || 0) < cost) return interaction.reply({ content: `❌ 크리스탈 부족! **${cost}💎** 필요 (보유: **${player.crystals||0}💎**)`, ephemeral: true });
      player.crystals -= cost;
      player.koganeGachaCount = (player.koganeGachaCount || 0) + 1;
      await interaction.deferReply();
      await interaction.editReply({ embeds: [koganeLoadingEmbed(1)] });
      await new Promise(r => setTimeout(r, 700));
      await interaction.editReply({ embeds: [koganeLoadingEmbed(2)] });
      await new Promise(r => setTimeout(r, 600));
      const newGrade = rollKogane();
      const prevGrade = player.kogane?.grade;
      const gradeOrder = ["3급","2급","1급","특급","전설"];
      const prevIdx = gradeOrder.indexOf(prevGrade || "3급");
      const newIdx = gradeOrder.indexOf(newGrade);
      const isUpgrade = newIdx > prevIdx;
      if (!player.kogane || isUpgrade) {
        player.kogane = { grade: newGrade, obtainedAt: Date.now() };
      } else {
        player.crystals += 50;
      }
      savePlayer(userId);
      return interaction.editReply({ embeds: [koganeRevealEmbed(newGrade, isUpgrade, player)] });
    }

    // ── 코가네
    case "코가네": {
      return interaction.reply({ embeds: [koganeProfileEmbed(player)] });
    }

    // ── 손가락
    case "손가락": {
      const fingers = player.sukunaFingers || 0;
      const bonus = getFingerBonus(fingers);
      const bar = "🟥".repeat(Math.floor(fingers / 2)) + "⬛".repeat(Math.max(0, 10 - Math.floor(fingers / 2)));
      const hasSukuna = (player.owned || []).includes("sukuna");
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(fingers >= 10 ? 0x8b0000 : 0xff8c00)
          .setTitle(`👹 스쿠나 손가락 현황 (${fingers}/${SUKUNA_FINGER_MAX})`)
          .setDescription([
            `> ${bar}`,
            `> ${bonus.label}`,
            `> 🗡️ ATK **+${bonus.atkBonus}** · 🛡️ DEF **+${bonus.defBonus}** · 💚 HP **+${bonus.hpBonus}**`,
            `> ⚡ 데미지 배율: **×${bonus.dmgMult.toFixed(2)}**`,
            hasSukuna ? `> 🔴 **스쿠나 캐릭터 해금됨!** (손가락 20개로 완전 각성)` : `> 🔒 **손가락 1개 이상 시 스쿠나 해금!**`,
          ].join("\n"))],
      });
    }

    // ── 컬링
    case "컬링": {
      if (cullings[userId]) return interaction.reply({ content: "🌊 이미 컬링 게임 중!", ephemeral: true });
      if ((player.hp || 0) <= 0) return interaction.reply({ content: "💀 HP가 없습니다. `/회복` 후 시작하세요!", ephemeral: true });
      const enemy = pickCullingEnemy(1);
      cullings[userId] = { wave: 1, kills: 0, totalXp: 0, totalCrystals: 0, currentEnemy: enemy, enemyHp: enemy.hp };
      return interaction.reply({ embeds: [cullingEmbed(player, cullings[userId])], components: [mkCullingButtons(player)] });
    }

    // ── 사멸회유
    case "사멸회유": {
      if (jujutsus[userId]) return interaction.reply({ content: "🎯 이미 사멸회유 중!", ephemeral: true });
      if ((player.hp || 0) <= 0) return interaction.reply({ content: "💀 HP가 없습니다. `/회복` 후 시작하세요!", ephemeral: true });
      const choices = generateJujutsuChoices(1);
      jujutsus[userId] = { wave: 1, points: 0, totalXp: 0, totalCrystals: 0, currentEnemy: null, enemyHp: 0, choices };
      return interaction.reply({ embeds: [jujutsuEmbed(player, jujutsus[userId], [], choices)], components: mkJujutsuButtons(player, choices) });
    }

    // ── 결투 (PvP)
    case "결투": {
      const target = interaction.options.getUser("대상");
      if (!target) return interaction.reply({ content: "❌ 대상을 지정하세요!", ephemeral: true });
      if (target.id === userId) return interaction.reply({ content: "❌ 자기 자신에게 결투 신청 불가!", ephemeral: true });
      if (getPvpSessionByUser(userId)) return interaction.reply({ content: "❌ 이미 PvP 중!", ephemeral: true });
      if (getPvpSessionByUser(target.id)) return interaction.reply({ content: "❌ 상대방이 이미 PvP 중!", ephemeral: true });
      if (battles[userId] || cullings[userId] || jujutsus[userId]) return interaction.reply({ content: "❌ 다른 전투 중에는 PvP 불가!", ephemeral: true });
      const targetPlayer = players[target.id];
      if (!targetPlayer) return interaction.reply({ content: "❌ 상대방이 게임을 시작하지 않았습니다.", ephemeral: true });

      pvpChallenges[userId] = { target: target.id, timestamp: Date.now() };
      const ch1 = CHARACTERS[player.active] || CHARACTERS["itadori"];
      const ch2 = CHARACTERS[targetPlayer.active] || CHARACTERS["itadori"];
      const s1 = getPlayerStats(player), s2 = getPlayerStats(targetPlayer);
      const embed = new EmbedBuilder().setColor(0xF5C842).setTitle("⚔️ PvP 결투 신청!")
        .setDescription([
          `> **${player.name}** 이(가) **${target.username}** 에게 결투를 신청했습니다!`,
          `> ${ch1.emoji} **${ch1.name}** [${ch1.grade}] — ATK **${s1.atk}** DEF **${s1.def}** HP **${s1.maxHp}**`,
          `> ⚔️ vs`,
          `> ${ch2.emoji} **${ch2.name}** [${ch2.grade}] — ATK **${s2.atk}** DEF **${s2.def}** HP **${s2.maxHp}**`,
          `> ${target} 수락하시겠습니까?`,
        ].join("\n"));
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`pvp_challenge_accept_${userId}_${target.id}`).setLabel("✅ 수락").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`pvp_challenge_reject_${userId}_${target.id}`).setLabel("❌ 거절").setStyle(ButtonStyle.Danger),
      );
      return interaction.reply({ embeds: [embed], components: [row] });
    }

    // ── 파티 생성
    case "파티생성": {
      if (getPartyId(userId)) return interaction.reply({ content: "❌ 이미 파티에 속해 있습니다! `/파티나가기` 먼저 실행하세요.", ephemeral: true });
      const partyId = `party_${_partyIdSeq++}`;
      parties[partyId] = { id: partyId, leader: userId, members: [userId], createdAt: Date.now() };
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0x4ade80).setTitle("👥 파티 생성!")
          .setDescription([`> 파티장: **${player.name}**`, `> 파티 ID: \`${partyId}\``, `> 인원: **1/4**명`, `> \`/파티초대 @유저\` 로 초대하세요.`].join("\n"))],
      });
    }

    // ── 파티 초대
    case "파티초대": {
      const target = interaction.options.getUser("대상");
      if (!target) return interaction.reply({ content: "❌ 대상 필요", ephemeral: true });
      const party = getParty(userId);
      if (!party) return interaction.reply({ content: "❌ 파티가 없습니다. `/파티생성` 먼저!", ephemeral: true });
      if (party.leader !== userId) return interaction.reply({ content: "❌ 파티장만 초대 가능!", ephemeral: true });
      if (party.members.length >= 4) return interaction.reply({ content: "❌ 파티가 가득찼습니다! (최대 4명)", ephemeral: true });
      if (party.members.includes(target.id)) return interaction.reply({ content: "❌ 이미 파티원!", ephemeral: true });
      if (getPartyId(target.id)) return interaction.reply({ content: "❌ 상대방이 이미 다른 파티 소속!", ephemeral: true });
      partyInvites[target.id] = { partyId: party.id, inviterId: userId, timestamp: Date.now() };
      const targetPlayer = getPlayer(target.id, target.username);
      const embed = new EmbedBuilder().setColor(0x4ade80).setTitle("👥 파티 초대!")
        .setDescription(`> **${player.name}**이(가) **${target.username}**을(를) 파티에 초대했습니다!\n> ${target} 수락하시겠습니까?`);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`party_invite_accept_${party.id}_${target.id}`).setLabel("✅ 수락").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`party_invite_reject_${party.id}_${target.id}`).setLabel("❌ 거절").setStyle(ButtonStyle.Danger),
      );
      return interaction.reply({ embeds: [embed], components: [row] });
    }

    // ── 파티 나가기
    case "파티나가기": {
      const partyId = getPartyId(userId);
      if (!partyId) return interaction.reply({ content: "❌ 파티에 속해 있지 않습니다.", ephemeral: true });
      const party = parties[partyId];
      if (!party) return interaction.reply({ content: "❌ 파티 없음", ephemeral: true });
      party.members = party.members.filter(id => id !== userId);
      if (party.members.length === 0 || party.leader === userId) {
        delete parties[partyId];
        delete cullings[partyId];
        return interaction.reply({ content: "✅ 파티를 해체했습니다.", embeds: [], components: [] });
      }
      party.leader = party.members[0];
      return interaction.reply({ content: `✅ 파티를 나갔습니다. (남은 인원: ${party.members.length}명)`, embeds: [], components: [] });
    }

    // ── 파티 컬링
    case "파티컬링": {
      const party = getParty(userId);
      if (!party) return interaction.reply({ content: "❌ 파티가 없습니다. `/파티생성` 먼저!", ephemeral: true });
      if (party.leader !== userId) return interaction.reply({ content: "❌ 파티장만 시작 가능!", ephemeral: true });
      if (cullings[party.id]) return interaction.reply({ content: "❌ 이미 파티 컬링 중!", ephemeral: true });
      for (const uid of party.members) {
        const p = players[uid]; if (!p) continue;
        if ((p.hp || 0) <= 0) return interaction.reply({ content: `❌ **${p.name}**의 HP가 없습니다! 먼저 회복하세요.`, ephemeral: true });
      }
      const enemy = pickCullingEnemy(1);
      const session = { wave: 1, kills: 0, totalXp: 0, totalCrystals: 0, currentEnemy: enemy, enemyHp: enemy.hp };
      cullings[party.id] = session;
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("pc_attack").setLabel("⚔️ 공격").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("pc_skill").setLabel(`🌀 ${getCurrentSkill(player, player.active)?.name || "술식"}`).setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("pc_escape").setLabel("🏳️ 철수").setStyle(ButtonStyle.Secondary),
      );
      return interaction.reply({ embeds: [partyCullingEmbed(party, session)], components: [row] });
    }

    // ── 레이드
    case "레이드": {
      const bossKey = interaction.options.getString("보스");
      if (!RAID_BOSSES[bossKey]) return interaction.reply({ content: `❌ 존재하지 않는 보스! \`heian_sukuna\` 또는 \`mahoraga\``, ephemeral: true });
      if (getRaidByUser(userId)) return interaction.reply({ content: "❌ 이미 레이드 중!", ephemeral: true });
      if ((player.hp || 0) <= 0) return interaction.reply({ content: "💀 HP가 없습니다. `/회복` 먼저!", ephemeral: true });
      const boss = RAID_BOSSES[bossKey];
      const raidId = `raid_${_raidIdSeq++}`;
      const party = getParty(userId);
      const members = party ? [...party.members] : [userId];
      raidSessions[raidId] = { id: raidId, bossId: bossKey, hp: boss.hp, maxHp: boss.hp, members, enraged: false, adaptedSkills: [], createdAt: Date.now() };
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(boss.color).setTitle(`🔥 레이드 시작! ${boss.emoji} ${boss.name}`)
          .setDescription([`> *"${boss.lore}"*`, `> 💚 HP **${boss.hp}** | 🗡️ ATK **${boss.atk}** | 🛡️ DEF **${boss.def}**`, `> 👥 파티: **${members.length}명**`, `> ⚠️ HP **${Math.floor(boss.phaseHp*100)}%** 이하 분노 페이즈!`].join("\n"))
          .addFields({ name: "📖 특수 능력", value: `> ${boss.desc}`, inline: false })],
        components: [mkRaidButtons(player)],
      });
    }

    // ── 코드
    case "코드": {
      const code = interaction.options.getString("코드")?.toLowerCase().trim();
      if (!code) return interaction.reply({ content: "❌ 코드를 입력하세요.", ephemeral: true });
      if ((player.usedCodes || []).includes(code)) return interaction.reply({ content: "❌ 이미 사용한 코드입니다.", ephemeral: true });
      const reward = CODES[code];
      if (!reward) return interaction.reply({ content: "❌ 유효하지 않은 코드입니다.", ephemeral: true });
      if (!player.usedCodes) player.usedCodes = [];
      player.usedCodes.push(code);
      if (reward.crystals) player.crystals = (player.crystals || 0) + reward.crystals;
      savePlayer(userId);
      return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xF5C842).setTitle("🎁 코드 보상 수령!")
        .setDescription(`> 💎 **+${reward.crystals || 0}** 크리스탈 지급!\n> 💎 총 보유: **${player.crystals}**`)] });
    }

    // ── 퀘스트
    case "퀘스트": {
      initQuests(player);
      return interaction.reply({ embeds: [questEmbed(player)] });
    }

    // ── 재료
    case "재료": {
      return interaction.reply({ embeds: [materialsEmbed(player)] });
    }

    // ── 주구 목록
    case "주구목록": {
      return interaction.reply({ embeds: [weaponListEmbed(player)] });
    }

    // ── 주구 제작
    case "주구제작": {
      const weaponName = interaction.options.getString("이름");
      const weapon = getWeaponByName(weaponName);
      if (!weapon) return interaction.reply({ content: `❌ **${weaponName}** — 존재하지 않는 주구입니다.\n> \`/주구목록\` 으로 확인하세요.`, ephemeral: true });
      if ((player.craftedWeapons || []).includes(weapon.id)) return interaction.reply({ content: `❌ **${weapon.name}** 이미 제작된 주구입니다.`, ephemeral: true });
      const mats = player.materials || {};
      for (const [mat, qty] of Object.entries(weapon.recipe)) {
        if ((mats[mat] || 0) < qty) return interaction.reply({ content: `❌ 재료 부족! **${MATERIALS[mat]?.name || mat}** ${mats[mat]||0}/${qty}\n> \`/재료\` 에서 확인하세요.`, ephemeral: true });
      }
      for (const [mat, qty] of Object.entries(weapon.recipe)) player.materials[mat] = (player.materials[mat] || 0) - qty;
      if (!player.craftedWeapons) player.craftedWeapons = [];
      player.craftedWeapons.push(weapon.id);
      updateQuestProgress(player, "weapon_craft", 1);
      savePlayer(userId);
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(weapon.color || 0x7C5CFC).setTitle(`${weapon.emoji} 주구 제작 완료! ${weapon.name}`)
          .setDescription([`> **등급:** ${weapon.grade}`, `> 🗡️ ATK **+${weapon.atkBonus}** · 🛡️ DEF **+${weapon.defBonus}** · 💚 HP **+${weapon.hpBonus}**`, `> 📖 ${weapon.desc}`, `> \`/장착 ${weapon.name}\` 으로 장착하세요!`].join("\n"))],
      });
    }

    // ── 장착
    case "장착": {
      const weaponName = interaction.options.getString("이름");
      const weapon = getWeaponByName(weaponName);
      if (!weapon) return interaction.reply({ content: `❌ **${weaponName}** — 주구 없음`, ephemeral: true });
      if (!(player.craftedWeapons || []).includes(weapon.id)) return interaction.reply({ content: `❌ **${weapon.name}** 먼저 제작해야 합니다.`, ephemeral: true });
      player.equippedWeapon = weapon.name;
      const stats = getPlayerStats(player);
      player.hp = Math.min((player.hp || 0) + weapon.hpBonus, stats.maxHp);
      savePlayer(userId);
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(weapon.color || 0x4ade80).setTitle(`${weapon.emoji} ${weapon.name} 장착!`)
          .setDescription([`> ATK **+${weapon.atkBonus}** · DEF **+${weapon.defBonus}** · HP **+${weapon.hpBonus}**`, `> 💚 현재 HP: **${player.hp}/${stats.maxHp}**`].join("\n"))],
      });
    }

    // ── 해제
    case "해제": {
      if (!player.equippedWeapon) return interaction.reply({ content: "❌ 장착된 주구 없음", ephemeral: true });
      const prev = player.equippedWeapon;
      player.equippedWeapon = null;
      savePlayer(userId);
      return interaction.reply({ content: `✅ **${prev}** 장착 해제!` });
    }

    // ── 도움말
    case "도움말": {
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0x7C5CFC).setTitle("📖 주술회전 RPG 명령어")
          .setDescription("> 모든 명령어는 슬래시(/) 사용")
          .addFields(
            { name: "⚔️ 전투", value: "> `/전투` — 일반 전투\n> `/컬링` — 컬링 게임\n> `/사멸회유` — 사멸회유\n> `/레이드 보스:` — 레이드\n> `/결투 대상:` — PvP", inline: true },
            { name: "🎴 캐릭터", value: "> `/가챠 횟수:` — 소환 (1/10)\n> `/활성` — 캐릭터 교체\n> `/도감` — 캐릭터 목록\n> `/술식` — 스킬 트리\n> `/손가락` — 스쿠나 손가락", inline: true },
            { name: "🐾 펫", value: "> `/코가네가챠` — 코가네 소환 (200💎)\n> `/코가네` — 코가네 정보", inline: true },
            { name: "🏅 성장", value: "> `/출석` — 매일 보상\n> `/퀘스트` — 퀘스트 현황\n> `/프로필` — 내 정보", inline: true },
            { name: "⚔️ 주구", value: "> `/주구목록` — 무기 목록\n> `/주구제작 이름:` — 제작\n> `/장착 이름:` — 장착\n> `/해제` — 해제\n> `/재료` — 재료 인벤토리", inline: true },
            { name: "👥 파티", value: "> `/파티생성` — 파티 생성\n> `/파티초대 대상:` — 초대\n> `/파티나가기` — 탈퇴\n> `/파티컬링` — 파티 컬링", inline: true },
            { name: "🎁 기타", value: "> `/회복` — 회복약 사용\n> `/코드 코드:` — 쿠폰 코드", inline: true },
          )],
      });
    }

    default:
      return interaction.reply({ content: "❓ 알 수 없는 명령어입니다.", ephemeral: true });
  }
}

// ════════════════════════════════════════════════════════
// 레거시 메시지 명령어 (! 접두사 — 개발자 + 퀘보상)
// ════════════════════════════════════════════════════════
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  const content = message.content.trim();
  const userId = message.author.id;
  const player = getPlayer(userId, message.author.username);

  // ── 퀘보상
  if (content.startsWith("!퀘보상")) {
    const parts = content.split(" ");
    const type = parts[1]; // "일" or "주"
    const num = parseInt(parts[2]) - 1;
    if (isNaN(num) || (type !== "일" && type !== "주")) {
      return message.reply("사용법: `!퀘보상 일 [번호]` 또는 `!퀘보상 주 [번호]`");
    }
    initQuests(player);
    const isWeekly = type === "주";
    const list = isWeekly ? player.quests.weekly : player.quests.daily;
    const allDefs = isWeekly ? WEEKLY_QUESTS : DAILY_QUESTS;
    if (!list || !list[num]) return message.reply("❌ 해당 퀘스트 없음");
    const qp = list[num];
    const def = allDefs.find(q => q.id === qp.id);
    if (!def) return message.reply("❌ 퀘스트 정의 없음");
    if (!qp.done) return message.reply(`❌ 아직 완료되지 않았습니다. 진행도: **${qp.progress}/${def.target}**`);
    if (qp.claimed) return message.reply("❌ 이미 보상을 수령했습니다.");
    const reward = claimQuestReward(player, qp.id, isWeekly);
    if (!reward) return message.reply("❌ 보상 수령 실패");
    savePlayer(userId);
    const matStr = Object.keys(reward.materials || {}).length ? `\n> 📦 ${formatDrops(reward.materials)}` : "";
    return message.reply({
      embeds: [new EmbedBuilder().setColor(0xF5C842).setTitle("🎁 퀘스트 보상 수령!")
        .setDescription([`> 📋 **${def.name}** 완료!`, `> 💎 **+${reward.crystals || 0}** | ⭐ **+${reward.xp || 0}** XP`, matStr].filter(Boolean).join("\n"))],
    });
  }

  // ── 개발자 명령어
  if (!isDev(userId)) return;

  if (content === "!개발자" || content === "!dev") {
    return message.reply({ embeds: [devPanelEmbed()] });
  }

  if (content.startsWith("!아이템지급")) {
    const args = content.split(" ");
    const mention = message.mentions.users.first();
    if (!mention) return message.reply("사용법: `!아이템지급 @유저 [크리스탈|회복약|손가락|재료명] [수량]`");
    const targetPlayer = getPlayer(mention.id, mention.username);
    const item = args[2];
    const qty = parseInt(args[3]) || 1;
    if (!item) return message.reply("아이템명을 입력하세요.");
    if (item === "크리스탈") { targetPlayer.crystals = (targetPlayer.crystals || 0) + qty; }
    else if (item === "회복약") { targetPlayer.potion = (targetPlayer.potion || 0) + qty; }
    else if (item === "손가락") { targetPlayer.sukunaFingers = Math.min(SUKUNA_FINGER_MAX, (targetPlayer.sukunaFingers || 0) + qty); }
    else if (MATERIALS[item]) { addMaterials(targetPlayer, { [item]: qty }); }
    else return message.reply(`❌ 알 수 없는 아이템: **${item}**`);
    savePlayer(mention.id);
    return message.reply(`✅ **${mention.username}** 에게 **${item} ×${qty}** 지급!`);
  }

  if (content === "!쿨다운초기화") {
    player.skillCooldown = 0;
    player.reverseCooldown = 0;
    player.domainCooldown = 0;
    savePlayer(userId);
    return message.reply("✅ 쿨타임 초기화!");
  }

  if (content === "!전체저장") {
    let count = 0;
    for (const uid of Object.keys(players)) {
      try { await dbSave(uid, players[uid]); count++; } catch {}
    }
    return message.reply(`✅ **${count}**명 저장 완료!`);
  }

  if (content.startsWith("!플레이어정보")) {
    const mention = message.mentions.users.first();
    if (!mention) return message.reply("대상을 멘션하세요.");
    const tp = players[mention.id];
    if (!tp) return message.reply("❌ 플레이어 데이터 없음");
    return message.reply({
      embeds: [new EmbedBuilder().setColor(0x7C5CFC).setTitle(`🔧 ${mention.username} 플레이어 정보`)
        .addFields(
          { name: "기본", value: `LV.${getLevel(tp.xp||0)} | XP: ${tp.xp||0} | 💎: ${tp.crystals||0} | 🧪: ${tp.potion||0}`, inline: false },
          { name: "전적", value: `일반: ${tp.wins||0}승 ${tp.losses||0}패 | PvP: ${tp.pvpWins||0}승 ${tp.pvpLosses||0}패`, inline: false },
          { name: "캐릭터", value: `장착: ${tp.active||"없음"} | 보유: ${(tp.owned||[]).join(", ")||"없음"}`, inline: false },
          { name: "기타", value: `손가락: ${tp.sukunaFingers||0}/${SUKUNA_FINGER_MAX} | 코가네: ${tp.kogane?.grade||"없음"}`, inline: false },
        )],
    });
  }

  if (content.startsWith("!크리스탈지급")) {
    const args = content.split(" ");
    const mention = message.mentions.users.first();
    const qty = parseInt(args[2]) || 1000;
    if (!mention) return message.reply("@유저 멘션 필요");
    const tp = getPlayer(mention.id, mention.username);
    tp.crystals = (tp.crystals || 0) + qty;
    savePlayer(mention.id);
    return message.reply(`✅ **${mention.username}** 에게 **${qty}💎** 지급!`);
  }

  if (content.startsWith("!활성복구")) {
    const mention = message.mentions.users.first();
    if (!mention) return message.reply("@유저 멘션 필요");
    const tp = players[mention.id];
    if (!tp) return message.reply("❌ 플레이어 없음");
    const charArg = content.split(" ")[2];
    const charId = charArg && CHARACTERS[charArg] ? charArg : "itadori";
    if (!tp.owned) tp.owned = ["itadori"];
    if (!tp.owned.includes(charId)) tp.owned.push(charId);
    tp.active = charId;
    if (!tp.mastery) tp.mastery = {};
    if (!tp.mastery[charId]) tp.mastery[charId] = 0;
    const stats = getPlayerStats(tp);
    tp.hp = stats.maxHp;
    savePlayer(mention.id);
    return message.reply(`✅ **${mention.username}** 활성 캐릭터를 **${CHARACTERS[charId].name}** 으로 복구!`);
  }

  if (content.startsWith("!레이드강제종료")) {
    const mention = message.mentions.users.first();
    if (!mention) return message.reply("@유저 멘션 필요");
    const rs = getRaidByUser(mention.id);
    if (!rs) return message.reply("❌ 진행중인 레이드 없음");
    delete raidSessions[rs.id];
    return message.reply(`✅ **${mention.username}** 의 레이드 강제 종료!`);
  }

  if (content.startsWith("!전투강제종료")) {
    const mention = message.mentions.users.first();
    if (!mention) return message.reply("@유저 멘션 필요");
    delete battles[mention.id];
    delete cullings[mention.id];
    delete jujutsus[mention.id];
    return message.reply(`✅ **${mention.username}** 의 모든 전투 강제 종료!`);
  }
});

// ════════════════════════════════════════════════════════
// PvP 챌린지 만료 처리 (60초)
// ════════════════════════════════════════════════════════
setInterval(() => {
  const now = Date.now();
  for (const [uid, challenge] of Object.entries(pvpChallenges)) {
    if (now - challenge.timestamp > 60000) delete pvpChallenges[uid];
  }
  for (const [uid, invite] of Object.entries(partyInvites)) {
    if (now - invite.timestamp > 60000) delete partyInvites[uid];
  }
}, 10000);

// ════════════════════════════════════════════════════════
// 전투 세션 타임아웃 처리 (5분)
// ════════════════════════════════════════════════════════
setInterval(() => {
  const now = Date.now();
  // 오래된 전투 세션 정리 (세션에 타임스탬프가 없으면 스킵)
  for (const [uid, session] of Object.entries(battles)) {
    if (session.startedAt && now - session.startedAt > 5 * 60 * 1000) {
      delete battles[uid];
    }
  }
}, 60000);

// ════════════════════════════════════════════════════════
// Discord 로그인
// ════════════════════════════════════════════════════════
client.login(TOKEN).catch(err => {
  console.error("❌ Discord 로그인 실패:", err.message);
  process.exit(1);
});

process.on("unhandledRejection", (err) => {
  console.error("Unhandled Rejection:", err?.message || err);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err?.message || err);
});
