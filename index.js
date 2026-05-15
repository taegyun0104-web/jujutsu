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
// 매크로 인증 시스템
// ════════════════════════════════════════════════════════
const antiBotVerify = new Map(); // userId -> { code, timestamp, pending }
const VERIFY_INTERVAL = 25;      // 25턴마다 인증 발생
const VERIFY_TIMEOUT  = 30000;   // 30초 이내 입력 필요

function shouldTriggerVerify(player) {
  const turns = (player.battleTurns || 0);
  return turns > 0 && turns % VERIFY_INTERVAL === 0;
}

function generateVerifyCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function isVerifyPending(userId) {
  const entry = antiBotVerify.get(userId);
  if (!entry) return false;
  if (Date.now() - entry.timestamp > VERIFY_TIMEOUT) {
    antiBotVerify.delete(userId);
    return false;
  }
  return entry.pending === true;
}

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
// 드롭 테이블 (주구 재료 드랍 감소 적용)
// ════════════════════════════════════════════════════════
const DROP_REDUCTION = 0.85; // 15% 감소
function applyDropReduction(entry) {
  return { ...entry, chance: entry.chance * DROP_REDUCTION };
}
const ENEMY_DROPS = {
  e1:[{mat:"저주 실",min:1,max:3,chance:0.80},{mat:"철 파편",min:1,max:2,chance:0.60},{mat:"저주 뼈",min:1,max:1,chance:0.10}].map(applyDropReduction),
  e2:[{mat:"저주 뼈",min:1,max:2,chance:0.70},{mat:"철 파편",min:2,max:4,chance:0.80},{mat:"저주 실",min:2,max:4,chance:0.50},{mat:"저주 핵",min:1,max:1,chance:0.08}].map(applyDropReduction),
  e3:[{mat:"저주 핵",min:1,max:2,chance:0.65},{mat:"영혼 정수",min:1,max:2,chance:0.55},{mat:"저주 뼈",min:2,max:4,chance:0.80},{mat:"철 파편",min:3,max:6,chance:0.90},{mat:"저주 수정",min:1,max:1,chance:0.05}].map(applyDropReduction),
  e4:[{mat:"저주 수정",min:1,max:2,chance:0.80},{mat:"용 비늘",min:1,max:2,chance:0.60},{mat:"영혼 정수",min:2,max:4,chance:0.90},{mat:"저주 핵",min:2,max:4,chance:0.90},{mat:"철 파편",min:5,max:10,chance:1.00}].map(applyDropReduction),
  e_sukuna:[{mat:"저주 수정",min:2,max:3,chance:1.00},{mat:"용 비늘",min:2,max:3,chance:1.00},{mat:"영혼 정수",min:4,max:6,chance:1.00}].map(applyDropReduction),
  raid_heian:[{mat:"저주 수정",min:3,max:5,chance:1.00},{mat:"용 비늘",min:3,max:4,chance:1.00},{mat:"영혼 정수",min:5,max:8,chance:1.00}].map(applyDropReduction),
  raid_mahoraga:[{mat:"저주 수정",min:3,max:5,chance:1.00},{mat:"용 비늘",min:4,max:6,chance:1.00},{mat:"영혼 정수",min:5,max:8,chance:1.00},{mat:"철 파편",min:10,max:20,chance:1.00}].map(applyDropReduction),
};
const JUJUTSU_DROPS = {
  j1:[{mat:"저주 실",min:1,max:2,chance:0.70},{mat:"철 파편",min:1,max:2,chance:0.60}].map(applyDropReduction),
  j2:[{mat:"저주 실",min:1,max:3,chance:0.70},{mat:"저주 뼈",min:1,max:1,chance:0.35},{mat:"철 파편",min:1,max:3,chance:0.65}].map(applyDropReduction),
  j3:[{mat:"저주 뼈",min:1,max:2,chance:0.55},{mat:"철 파편",min:1,max:3,chance:0.70}].map(applyDropReduction),
  j4:[{mat:"저주 핵",min:1,max:1,chance:0.30},{mat:"저주 뼈",min:1,max:3,chance:0.65},{mat:"영혼 정수",min:1,max:1,chance:0.20}].map(applyDropReduction),
  j5:[{mat:"저주 핵",min:1,max:2,chance:0.55},{mat:"영혼 정수",min:1,max:2,chance:0.40},{mat:"저주 수정",min:1,max:1,chance:0.08}].map(applyDropReduction),
  j6:[{mat:"저주 수정",min:1,max:1,chance:0.50},{mat:"용 비늘",min:1,max:1,chance:0.30},{mat:"영혼 정수",min:2,max:3,chance:0.80}].map(applyDropReduction),
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
    // 밸런스 조정: DoT 피해를 약간 완화 (maxHp 기준 비율 유지하되 최대치 캡 적용)
    if (se.id==="poison")       { const d=Math.min(Math.max(1,Math.floor(maxHp*0.05)),120); totalDmg+=d; log.push(`> ${def.emoji} **${def.name}** — **${d}** 피해!`); }
    if (se.id==="burn")         { const d=Math.min(Math.max(1,Math.floor(maxHp*0.07)),180); totalDmg+=d; log.push(`> ${def.emoji} **${def.name}** — **${d}** 피해!`); }
    if (se.id==="cursed_wound") { const d=Math.min(Math.max(1,Math.floor(maxHp*0.09)),220); totalDmg+=d; log.push(`> ${def.emoji} **${def.name}** — **${d}** 피해!`); }
    if (se.id==="dotBleed")     { const d=Math.min(Math.max(1,Math.floor(maxHp*0.06)),150); totalDmg+=d; log.push(`> ${def.emoji} **${def.name}** — **${d}** 피해!`); }
    se.turns--; if (se.turns<=0) expired.push(se.id);
  }
  target.statusEffects=target.statusEffects.filter(s=>s.turns>0);
  if (totalDmg>0) target.hp=Math.max(0,(target.hp||0)-totalDmg);
  return {dmg:totalDmg,expired,log};
}
function statusStr(se) { if (!se||se.length===0) return "없음"; return se.map(s=>`${STATUS_EFFECTS[s.id]?.emoji||""}${STATUS_EFFECTS[s.id]?.name||s.id}(${s.turns}턴)`).join(" "); }
function isIncapacitated(se) { return !!(se&&se.some(s=>s.id==="freeze"||s.id==="stun")); }
function isBlind(se) { return !!(se&&se.some(s=>s.id==="blind")); }
function getWeakenMult(se) {
  let m=1;
  if (se&&se.some(s=>s.id==="weaken"))        m*=0.72;
  if (se&&se.some(s=>s.id==="battleInstinct")) m*=1.35;
  if (se&&se.some(s=>s.id==="defBreak"))       m*=1.25;
  return m;
}
function getBattleInstinctEvade(se) { return !!(se&&se.some(s=>s.id==="battleInstinct")); }
function rollHit(aSe,dSe) {
  if (isBlind(aSe)&&Math.random()<0.45) return false;
  return Math.random()>(0.05+(getBattleInstinctEvade(dSe)?0.20:0));
}

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
// 주력 시스템 (Stamina)
// ════════════════════════════════════════════════════════
const STAMINA_MAX_BASE = 100;
const STAMINA_REGEN = 10;
const STAMINA_COST_SKILL = 20;
const STAMINA_COST_DOMAIN = 40;
const STAMINA_COST_REVERSE = 30;
const STAMINA_COST_MAIN = 50;
function getPlayerStamina(player) {
  return { curr: player.stamina ?? STAMINA_MAX_BASE, max: STAMINA_MAX_BASE };
}
function consumeStamina(player, cost) {
  if ((player.stamina ?? STAMINA_MAX_BASE) < cost) return false;
  player.stamina = (player.stamina ?? STAMINA_MAX_BASE) - cost;
  savePlayer(player.id);
  return true;
}
function regenStamina(player) {
  const max = STAMINA_MAX_BASE;
  player.stamina = Math.min(max, (player.stamina ?? max) + STAMINA_REGEN);
  savePlayer(player.id);
}

// ════════════════════════════════════════════════════════
// 영역전개 특수효과 정의 (무량공처 3턴 스턴, 복마어주자 지속딜 강화)
// ════════════════════════════════════════════════════════
const DOMAIN_EFFECTS = {
  "무량공처": {
    dmgMult: 3.0,
    statusId: "stun",
    statusDuration: 3,
    statusChance: 0.90,
    extraEffect: (target) => { applyStatus(target, "blind"); },
    desc: "상대방 3턴 기절 90% + 실명 부여",
    art: "```ansi\n\u001b[1;36m╔══════════════════════════════════════╗\n║  ∞  無 量 空 処  ∞  나는 최강이다  ║\n╚══════════════════════════════════════╝\n```",
  },
  "복마어주자": {
    dmgMult: 3.2,
    statusId: "cursed_wound",
    statusDuration: 3,
    statusChance: 0.90,
    extraEffect: (target) => { applyStatus(target, "weaken"); applyStatus(target, "burn"); },
    desc: "저주 상처(3턴) + 약화 + 화상 부여",
    art: "```ansi\n\u001b[1;31m╔══════════════════════════════════════╗\n║  🌑  伏 魔 御 廚 子  天 地 開 闢  🌑  ║\n╚══════════════════════════════════════╝\n```",
  },
  "자폐원돈과": {
    dmgMult: 2.6,
    statusId: "defBreak",
    statusDuration: 3,
    statusChance: 0.90,
    extraEffect: (target) => { applyStatus(target, "weaken"); },
    desc: "방어 파괴(3턴) + 약화 부여",
    art: "```ansi\n\u001b[1;31m╔══════════════════════════════════════╗\n║  🩸  自 閉 円 頓 裹  영혼 붕괴  🩸  ║\n╚══════════════════════════════════════╝\n```",
  },
  "탕온평선": {
    dmgMult: 2.6,
    statusId: "poison",
    statusDuration: 4,
    statusChance: 0.90,
    extraEffect: (target) => { applyStatus(target, "freeze"); },
    desc: "독(4턴) + 빙결 부여",
    art: "```ansi\n\u001b[1;34m╔══════════════════════════════════════╗\n║  🌊  湯 漫 平 線  광대한 바다  🌊  ║\n╚══════════════════════════════════════╝\n```",
  },
  "진안상애": {
    dmgMult: 3.0,
    statusId: "burn",
    statusDuration: 3,
    statusChance: 0.90,
    extraEffect: (target) => { applyStatus(target, "weaken"); applyStatus(target, "dotBleed"); },
    desc: "화상(3턴) + 약화 + 출혈 부여",
    art: "```ansi\n\u001b[1;35m╔══════════════════════════════════════╗\n║  💜  真 愛 相 愛  리카의 사랑  💜  ║\n╚══════════════════════════════════════╝\n```",
  },
  "개관철위산": {
    dmgMult: 2.8,
    statusId: "burn",
    statusDuration: 4,
    statusChance: 0.90,
    extraEffect: (target) => { applyStatus(target, "weaken"); },
    desc: "화상(4턴) + 약화 부여",
    art: "```ansi\n\u001b[1;31m╔══════════════════════════════════════╗\n║  🌋  蓋 棺 鐵 囲 山  화산 폭발  🌋  ║\n╚══════════════════════════════════════╝\n```",
  },
  "강압암예정": {
    dmgMult: 2.7,
    statusId: "stun",
    statusDuration: 2,
    statusChance: 0.75,
    extraEffect: (target) => { applyStatus(target, "weaken"); },
    desc: "기절 75% + 약화 부여",
    art: "```ansi\n\u001b[1;35m╔══════════════════════════════════════╗\n║  ⚫  强 壓 暗 藝 庭  마허라가 강림  ║\n╚══════════════════════════════════════╝\n```",
  },
  "주복사사": {
    dmgMult: 2.6,
    statusId: "stun",
    statusDuration: 1,
    statusChance: 0.85,
    extraEffect: (target) => { applyStatus(target, "weaken"); applyStatus(target, "blind"); },
    desc: "기절 85% + 약화 + 실명 부여",
    art: "```ansi\n\u001b[1;33m╔══════════════════════════════════════╗\n║  ⚖️  呪 腹 裁 死  사형 판결  ⚖️  ║\n╚══════════════════════════════════════╝\n```",
  },
  "질풍강운": {
    dmgMult: 3.4,
    statusId: "weaken",
    statusDuration: 3,
    statusChance: 0.90,
    extraEffect: (target) => { applyStatus(target, "burn"); },
    desc: "약화(3턴) + 화상 부여 + 높은 배율",
    art: "```ansi\n\u001b[1;32m╔══════════════════════════════════════╗\n║  🎰  疾 風 强 運  운이 터진다!  🎰  ║\n╚══════════════════════════════════════╝\n```",
  },
};

function applyDomainExpansion(attackerStats, domainName, defender, defenderIsObj=false) {
  const effect = DOMAIN_EFFECTS[domainName];
  if (!effect) {
    const dmg = Math.floor(attackerStats.atk * 2.6);
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
    skills:[{name:"주먹질",minMastery:0,dmg:95,desc:"강력한 기본 주먹.",statusApply:null},{name:"다이버전트 주먹",minMastery:5,dmg:160,desc:"저주 에너지를 실은 주먹.",statusApply:{target:"enemy",statusId:"stun",chance:0.25}},{name:"흑섬",minMastery:15,dmg:240,desc:"최대 저주 에너지 방출!",statusApply:{target:"enemy",statusId:"weaken",chance:0.40}}]},
  gojo:     { name:"고조 사토루",     emoji:"🔵",grade:"특급", atk:130,def:120,spd:110,maxHp:1800,domain:"무량공처",     desc:"최강의 주술사. 무한을 구사한다.",lore:"\"사람들이 왜 내가 최강이라고 하는지 알아?\"",
    skills:[{name:"아오",minMastery:0,dmg:145,desc:"적을 끌어당겨 공격.",statusApply:null},{name:"아카",minMastery:5,dmg:220,desc:"적을 날려 폭발시킨다.",statusApply:{target:"enemy",statusId:"burn",chance:0.45}},{name:"무라사키",minMastery:15,dmg:320,desc:"아오+아카 융합 발사.",statusApply:{target:"enemy",statusId:"weaken",chance:0.50}},{name:"무량공처",minMastery:30,dmg:480,desc:"무한을 지배하는 궁극술식.",statusApply:{target:"enemy",statusId:"freeze",chance:0.70}}]},
  megumi:   { name:"후시구로 메구미", emoji:"⚫",grade:"1급",  atk:110,def:108,spd:100,maxHp:1250,domain:"강압암예정",   desc:"식신술을 구사하는 주술사.",lore:"\"나는 선한 사람을 구하기 위해 싸운다.\"",
    skills:[{name:"옥견",minMastery:0,dmg:115,desc:"식신 옥견 소환.",statusApply:null},{name:"탈토",minMastery:5,dmg:180,desc:"식신 대호 소환.",statusApply:{target:"enemy",statusId:"weaken",chance:0.35}},{name:"만상",minMastery:15,dmg:265,desc:"열 가지 식신 소환.",statusApply:{target:"enemy",statusId:"poison",chance:0.40}},{name:"후루베 유라유라",minMastery:30,dmg:380,desc:"마허라가라 강림.",statusApply:{target:"enemy",statusId:"stun",chance:0.50}}]},
  nobara:   { name:"쿠기사키 노바라", emoji:"🌸",grade:"1급",  atk:115,def:95, spd:105,maxHp:1180,domain:null,            desc:"영혼에 직접 공격 가능한 주술사.",lore:"\"도쿄에 올 때부터 각오는 되어 있었어.\"",
    skills:[{name:"망치질",minMastery:0,dmg:118,desc:"저주 못 박기.",statusApply:null},{name:"공명",minMastery:5,dmg:195,desc:"허수아비 공명 피해.",statusApply:{target:"enemy",statusId:"poison",chance:0.45}},{name:"철정",minMastery:15,dmg:280,desc:"저주 에너지 못 박기.",statusApply:{target:"enemy",statusId:"weaken",chance:0.45}},{name:"발화",minMastery:30,dmg:390,desc:"동시 폭발 공명.",statusApply:{target:"enemy",statusId:"burn",chance:0.70}}]},
  nanami:   { name:"나나미 켄토",     emoji:"🟡",grade:"1급",  atk:118,def:108,spd:90, maxHp:1380,domain:null,            desc:"1급 주술사. 합리적 판단의 소유자.",lore:"\"초과 근무는 사절이지만... 이건 의무다.\"",
    skills:[{name:"둔기 공격",minMastery:0,dmg:120,desc:"단단한 둔기로 타격.",statusApply:null},{name:"칠할삼분",minMastery:5,dmg:200,desc:"7:3 지점 약점 공격.",statusApply:{target:"enemy",statusId:"weaken",chance:0.55}},{name:"십수할",minMastery:15,dmg:290,desc:"열 배의 저주 에너지 방출.",statusApply:null},{name:"초과근무",minMastery:30,dmg:410,desc:"한계를 넘어선 폭발 강화.",statusApply:null}]},
  sukuna:   { name:"료멘 스쿠나",     emoji:"🔴",grade:"특급", atk:140,def:115,spd:120,maxHp:2500,domain:"복마어주자",    desc:"저주의 왕. 역대 최강의 저주된 영혼.",lore:"\"약한 놈이 강한 놈을 거스르는 건 죄악이다.\"",
    skills:[{name:"해",minMastery:0,dmg:145,desc:"손톱으로 베어낸다.",statusApply:{target:"enemy",statusId:"burn",chance:0.35}},{name:"팔",minMastery:5,dmg:235,desc:"공간 자체를 베어낸다.",statusApply:{target:"enemy",statusId:"weaken",chance:0.45}},{name:"푸가",minMastery:15,dmg:345,desc:"닿는 모든 것을 분해.",statusApply:{target:"enemy",statusId:"poison",chance:0.60}},{name:"복마어주자",minMastery:30,dmg:500,desc:"궁극 영역전개.",statusApply:{target:"enemy",statusId:"freeze",chance:0.80}}]},
  geto:     { name:"게토 스구루",     emoji:"🟢",grade:"특급", atk:115,def:105,spd:100,maxHp:1600,domain:null,            desc:"전 특급 주술사. 저주 달인.",lore:"\"주술사는 비주술사를 지켜야 한다.\"",
    skills:[{name:"저주 방출",minMastery:0,dmg:125,desc:"저급 저주령 방출.",statusApply:null},{name:"최대출력",minMastery:5,dmg:210,desc:"저주령 전력 방출.",statusApply:{target:"enemy",statusId:"poison",chance:0.35}},{name:"저주영조종",minMastery:15,dmg:300,desc:"수천의 저주령 조종.",statusApply:{target:"enemy",statusId:"weaken",chance:0.50}},{name:"감로대법",minMastery:30,dmg:425,desc:"모든 저주 흡수.",statusApply:{target:"enemy",statusId:"stun",chance:0.45}}]},
  maki:     { name:"마키 젠인",       emoji:"⚪",grade:"준1급",atk:122,def:110,spd:115,maxHp:1300,domain:null,            desc:"저주력 없이도 강한 주술사. HP 30% 이하 시 천여주박 각성!",lore:"\"젠인 가문 — 그 이름을 내가 직접 끝내주지.\"",awakening:{threshold:0.30,dmgMult:2.0,label:"천여주박 각성"},
    skills:[{name:"봉술",minMastery:0,dmg:122,desc:"저주 도구 봉 타격.",statusApply:null},{name:"저주창",minMastery:5,dmg:200,desc:"저주 도구 창 투척.",statusApply:{target:"enemy",statusId:"weaken",chance:0.35}},{name:"저주도구술",minMastery:15,dmg:285,desc:"다양한 저주 도구 구사.",statusApply:{target:"enemy",statusId:"burn",chance:0.45}},{name:"천개봉파",minMastery:30,dmg:400,desc:"수천 저주 도구 연속 공격.",statusApply:{target:"enemy",statusId:"stun",chance:0.50}}]},
  panda:    { name:"판다",            emoji:"🐼",grade:"2급",  atk:105,def:118,spd:85, maxHp:1400,domain:null,            desc:"저주로 만든 특이체질 주술사.",lore:"\"난 판다야. 진짜 판다.\"",
    skills:[{name:"박치기",minMastery:0,dmg:108,desc:"머리로 힘차게 들이받기.",statusApply:{target:"enemy",statusId:"stun",chance:0.18}},{name:"곰 발바닥",minMastery:5,dmg:175,desc:"두꺼운 발바닥으로 내리치기.",statusApply:null},{name:"팬더 변신",minMastery:15,dmg:255,desc:"진짜 판다로 변신해 공격.",statusApply:{target:"enemy",statusId:"weaken",chance:0.35}},{name:"고릴라 변신",minMastery:30,dmg:360,desc:"고릴라 형태로 폭발 강화.",statusApply:{target:"enemy",statusId:"stun",chance:0.45}}]},
  inumaki:  { name:"이누마키 토게",   emoji:"🟤",grade:"준1급",atk:112,def:90, spd:110,maxHp:1120,domain:null,            desc:"주술언어를 구사하는 준1급 주술사.",lore:"\"연어알—\"",
    skills:[{name:"멈춰라",minMastery:0,dmg:115,desc:"움직임 봉쇄.",statusApply:{target:"enemy",statusId:"freeze",chance:0.45}},{name:"달려라",minMastery:5,dmg:180,desc:"무작위로 달리게 한다.",statusApply:{target:"enemy",statusId:"weaken",chance:0.45}},{name:"주술언어",minMastery:15,dmg:265,desc:"강력한 주술 명령.",statusApply:{target:"enemy",statusId:"stun",chance:0.55}},{name:"폭발해라",minMastery:30,dmg:375,desc:"그 자리에서 폭발.",statusApply:{target:"enemy",statusId:"burn",chance:0.70}}]},
  yuta:     { name:"오코츠 유타",     emoji:"🌟",grade:"특급", atk:128,def:112,spd:115,maxHp:1750,domain:"진안상애",       desc:"특급 주술사. 리카의 저주를 다루는 최강급.",lore:"\"리카... 나는 아직 살아야 해.\"",
    skills:[{name:"모방술식",minMastery:0,dmg:135,desc:"다른 술식을 모방 공격.",statusApply:null},{name:"리카 소환",minMastery:5,dmg:220,desc:"저주의 여왕 리카 소환.",statusApply:{target:"enemy",statusId:"weaken",chance:0.45}},{name:"순애빔",minMastery:15,dmg:340,desc:"리카와의 순수한 사랑을 발사.",statusApply:{target:"enemy",statusId:"burn",chance:0.55}},{name:"진안상애",minMastery:30,dmg:480,desc:"영역전개 — 사랑으로 파괴.",statusApply:{target:"enemy",statusId:"freeze",chance:0.80}}]},
  higuruma: { name:"히구루마 히로미", emoji:"⚖️",grade:"1급",  atk:118,def:105,spd:95, maxHp:1320,domain:"주복사사",       desc:"전직 변호사 출신 주술사.",lore:"\"이 법정에서는 — 내가 판사다.\"",
    skills:[{name:"저주도구",minMastery:0,dmg:120,desc:"저주 에너지 도구 공격.",statusApply:null},{name:"몰수",minMastery:5,dmg:195,desc:"상대 술식 몰수.",statusApply:{target:"enemy",statusId:"weaken",chance:0.60}},{name:"사형판결",minMastery:15,dmg:285,desc:"재판 결과에 따른 제재.",statusApply:{target:"enemy",statusId:"stun",chance:0.45}},{name:"집행인 인형",minMastery:30,dmg:410,desc:"집행인 인형 소환 즉결.",statusApply:{target:"enemy",statusId:"freeze",chance:0.60}}]},
  jogo:     { name:"죠고",            emoji:"🌋",grade:"준특급",atk:125,def:100,spd:105,maxHp:1680,domain:"개관철위산",    desc:"화염을 다루는 준특급 저주령.",lore:"\"인간이야말로 진정한 저주다.\"",
    skills:[{name:"화염 분사",minMastery:0,dmg:130,desc:"강렬한 불꽃 분출.",statusApply:{target:"enemy",statusId:"burn",chance:0.45}},{name:"용암 폭발",minMastery:5,dmg:215,desc:"발밑 용암 폭발.",statusApply:{target:"enemy",statusId:"burn",chance:0.60}},{name:"극번 운",minMastery:15,dmg:315,desc:"불타는 운석 소환.",statusApply:{target:"enemy",statusId:"weaken",chance:0.45}},{name:"개관철위산",minMastery:30,dmg:460,desc:"화산 소환 궁극 영역전개.",statusApply:{target:"enemy",statusId:"burn",chance:0.90}}]},
  dagon:    { name:"다곤",            emoji:"🌊",grade:"준특급",atk:118,def:108,spd:96, maxHp:1620,domain:"탕온평선",       desc:"수중 저주령.",lore:"\"물은 모든 것을 삼킨다.\"",
    skills:[{name:"물고기 소환",minMastery:0,dmg:125,desc:"날카로운 물고기 떼 소환.",statusApply:{target:"enemy",statusId:"poison",chance:0.35}},{name:"해수 폭발",minMastery:5,dmg:205,desc:"압축 해수 발사.",statusApply:{target:"enemy",statusId:"weaken",chance:0.45}},{name:"조류 소용돌이",minMastery:15,dmg:295,desc:"거대 물 소용돌이 공격.",statusApply:{target:"enemy",statusId:"freeze",chance:0.35}},{name:"탕온평선",minMastery:30,dmg:450,desc:"물고기로 가득한 영역전개.",statusApply:{target:"enemy",statusId:"poison",chance:0.80}}]},
  hanami:   { name:"하나미",          emoji:"🌿",grade:"준특급",atk:115,def:118,spd:93, maxHp:1750,domain:null,            desc:"식물 저주령. 자연 술식 구사.",lore:"\"자연은 인간의 적이 아니다.\"",
    skills:[{name:"나무뿌리 채찍",minMastery:0,dmg:122,desc:"나무뿌리 채찍.",statusApply:{target:"enemy",statusId:"weaken",chance:0.28}},{name:"꽃비",minMastery:5,dmg:198,desc:"독성 꽃가루 강하.",statusApply:{target:"enemy",statusId:"poison",chance:0.55}},{name:"대지의 저주",minMastery:15,dmg:285,desc:"대지에 저주 에너지 확산.",statusApply:{target:"enemy",statusId:"poison",chance:0.60}},{name:"재앙의 꽃",minMastery:30,dmg:425,desc:"거대 꽃 소환 흡수.",statusApply:{target:"enemy",statusId:"stun",chance:0.50}}]},
  mahito:   { name:"마히토",          emoji:"🩸",grade:"준특급",atk:120,def:98, spd:110,maxHp:1560,domain:"자폐원돈과",   desc:"영혼을 변형하는 준특급 저주령.",lore:"\"영혼이 육체를 만드는 거야.\"",
    skills:[{name:"영혼 변형",minMastery:0,dmg:128,desc:"영혼 변형 직접 타격.",statusApply:{target:"enemy",statusId:"weaken",chance:0.35}},{name:"무위전변",minMastery:5,dmg:212,desc:"접촉 신체 기괴하게 변형.",statusApply:{target:"enemy",statusId:"stun",chance:0.35}},{name:"편사지경체",minMastery:15,dmg:308,desc:"무한 신체 변형 공격.",statusApply:{target:"enemy",statusId:"weaken",chance:0.50}},{name:"자폐원돈과",minMastery:30,dmg:455,desc:"영혼과 육체의 경계 붕괴.",statusApply:{target:"enemy",statusId:"freeze",chance:0.70}}]},
  todo:     { name:"토도 아오이",     emoji:"💪",grade:"1급",  atk:128,def:108,spd:112,maxHp:1500,domain:null,            desc:"보조 공격술 구사 1급 주술사.",lore:"\"너의 이상형은 어떤 여자야?\"",
    skills:[{name:"부기우기",minMastery:0,dmg:130,desc:"위치 전환 + 빙결 35%.",statusApply:{target:"enemy",statusId:"freeze",chance:0.35}},{name:"브루탈 펀치",minMastery:5,dmg:215,desc:"최대 저주력 파괴적 주먹.",statusApply:{target:"enemy",statusId:"weaken",chance:0.28}},{name:"흑섬",minMastery:15,dmg:320,desc:"이타도리에게 배운 흑섬!",statusApply:{target:"enemy",statusId:"burn",chance:0.40}},{name:"전투본능",minMastery:30,dmg:200,desc:"전투본능 버프!",statusApply:{target:"self",statusId:"battleInstinct",chance:1.0}}]},
  hakari:   { name:"하카리 키리토",   emoji:"🎰",grade:"1급",  atk:125,def:105,spd:110,maxHp:1650,domain:"질풍강운",       desc:"복권 술식 사용 주술사.",lore:"\"운도 실력이다! 철저하게 즐기자!\"",
    skills:[{name:"험한 도박",minMastery:0,dmg:125,desc:"운에 맡긴 도박 공격!",statusApply:{target:"enemy",statusId:"stun",chance:0.28}},{name:"질풍열차",minMastery:5,dmg:210,desc:"열차처럼 돌진!",statusApply:{target:"enemy",statusId:"weaken",chance:0.35}},{name:"유한 소설",minMastery:15,dmg:315,desc:"불멸의 몸으로 싸운다!",statusApply:{target:"self",statusId:"battleInstinct",chance:0.55}},{name:"질풍강운",minMastery:30,dmg:480,desc:"영역전개 — 운이 터진다!",statusApply:{target:"enemy",statusId:"freeze",chance:0.65}}]},
};

// ════════════════════════════════════════════════════════
// 반전술식 가능 캐릭터 (고조/유타)
// ════════════════════════════════════════════════════════
const REVERSE_CHARS = new Set(["gojo","yuta"]);

// ════════════════════════════════════════════════════════
// 적 데이터 (밸런스 조정)
// ════════════════════════════════════════════════════════
const ENEMIES = [
  {id:"e1",name:"저급 저주령",      emoji:"👹",hp:550, atk:35, def:12, xp:75,  crystals:18, masteryXp:1, fingers:0,statusAttack:null},
  {id:"e2",name:"1급 저주령",       emoji:"👺",hp:1100,atk:75, def:38, xp:190, crystals:40, masteryXp:3, fingers:0,statusAttack:{statusId:"poison",chance:0.25}},
  {id:"e3",name:"특급 저주령",      emoji:"💀",hp:2400,atk:120,def:68, xp:440, crystals:90, masteryXp:7, fingers:1,statusAttack:{statusId:"burn",chance:0.30}},
  {id:"e4",name:"저주의 왕 (보스)", emoji:"👑",hp:5500,atk:185,def:105,xp:1000,crystals:200,masteryXp:15,fingers:3,statusAttack:{statusId:"weaken",chance:0.40}},
  {id:"e_sukuna",name:"료멘 스쿠나 〖저주의 왕〗",emoji:"🔴",hp:5500,atk:210,def:125,xp:1500,crystals:300,masteryXp:20,fingers:1,statusAttack:{statusId:"burn",chance:0.50},isSukuna:true},
];

// ════════════════════════════════════════════════════════
// 레이드 보스 (밸런스 조정)
// ════════════════════════════════════════════════════════
const RAID_BOSSES = {
  heian_sukuna:{id:"heian_sukuna",name:"平安時代 스쿠나 〖헤이안 최강〗",emoji:"👹🔴",hp:11000,atk:420,def:250,xp:3000,crystals:600,masteryXp:40,fingers:3,desc:"헤이안 시대의 스쿠나.",lore:"\"나는 그 어느 시대에도 최강이었다.\"",color:0x8b0000,statusAttack:{statusId:"burn",chance:0.60},specialAttack:{name:"복마어주자",dmg:550,statusId:"freeze",chance:0.80},dropKey:"raid_heian",phaseHp:0.5,enragedAtk:580},
  mahoraga:{id:"mahoraga",name:"八握剣 異戒神将 마허라가라",emoji:"⚙️🐉",hp:6000,atk:270,def:170,xp:2500,crystals:500,masteryXp:35,fingers:2,desc:"식신 중 최강. 모든 술식에 적응하는 능력.",lore:"\"마허라가라는 천지의 이치를 먹는다.\"",color:0x2a2a2a,statusAttack:{statusId:"weaken",chance:0.50},specialAttack:{name:"팔상천마",dmg:380,statusId:"stun",chance:0.70},dropKey:"raid_mahoraga",adaptationSkill:true,phaseHp:0.4,enragedAtk:360},
};

// ════════════════════════════════════════════════════════
// 사멸회유 적 (밸런스 조정)
// ════════════════════════════════════════════════════════
const JUJUTSU_ENEMIES = [
  {id:"j1",name:"약화된 저주령",  emoji:"💧",hp:300, atk:23, def:8, xp:55, crystals:12,masteryXp:1, points:1,fingers:0,statusAttack:null,                           desc:"⚡ 빠르지만 약함 (1포인트)"},
  {id:"j2",name:"중간급 저주령",  emoji:"🌀",hp:620, atk:52, def:26,xp:115,crystals:28,masteryXp:2, points:1,fingers:0,statusAttack:{statusId:"weaken",chance:0.18}, desc:"⚖️ 균형잡힌 몹 (1포인트)"},
  {id:"j3",name:"강화 저주령",    emoji:"🔥",hp:450, atk:72, def:20,xp:95, crystals:23,masteryXp:2, points:1,fingers:0,statusAttack:{statusId:"burn",chance:0.30},   desc:"💥 공격적이지만 방어 낮음 (1포인트)"},
  {id:"j4",name:"특수 저주령",    emoji:"☠️",hp:960, atk:85, def:45,xp:190,crystals:45,masteryXp:4, points:2,fingers:0,statusAttack:{statusId:"poison",chance:0.32}, desc:"🧪 독 공격! (2포인트)"},
  {id:"j5",name:"엘리트 저주령",  emoji:"💀",hp:1380,atk:105,def:58,xp:280,crystals:70,masteryXp:6, points:3,fingers:1,statusAttack:{statusId:"burn",chance:0.40},   desc:"⚔️ 강력한 엘리트 (3포인트)"},
  {id:"j6",name:"사멸회유 수호자",emoji:"👹",hp:2100,atk:130,def:80,xp:440,crystals:100,masteryXp:10,points:5,fingers:2,statusAttack:{statusId:"weaken",chance:0.50},desc:"🏆 최강 수호자 (5포인트)"},
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
// 플레이어 유틸 (중복 제거, stamina 기본값)
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
      battleTurns:0,
      stamina: STAMINA_MAX_BASE,
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
    domainCooldown:0, totalTurns:0, battleTurns:0,
    stamina: STAMINA_MAX_BASE,
  };
  for (const [k,v] of Object.entries(defaults)) {
    if (p[k] === undefined) { p[k] = typeof v==="object"&&v!==null ? JSON.parse(JSON.stringify(v)) : v; changed = true; }
  }
  if (!p.id) { p.id = userId; changed = true; }
  if (!p.mastery) { p.mastery = {}; changed = true; }
  if (p.active && !p.mastery[p.active]) { p.mastery[p.active] = 0; changed = true; }
  // owned 중복 제거
  if (p.owned && Array.isArray(p.owned)) {
    const unique = [...new Set(p.owned)];
    if (unique.length !== p.owned.length) { p.owned = unique; changed = true; }
  }
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
// 핵심: 장착 캐릭터 기반 스탯 계산
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
  const variance = 0.7 + Math.random() * 0.5;
  return Math.max(1, Math.floor((atk * variance - def * 0.20) * mult));
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
  let dmg = (baseSkillDmg||100) + Math.floor(Math.random()*30);
  dmg = Math.floor(dmg * getWeakenMult(player.statusEffects||[]));
  if (isMakiAwakened(player)) dmg = Math.floor(dmg * CHARACTERS["maki"].awakening.dmgMult);
  if (player.active === "itadori" || player.active === "sukuna") dmg = Math.floor(dmg * getFingerBonus(player.sukunaFingers||0).dmgMult);
  dmg = Math.floor(dmg * getKoganeBonus(player).atk);
  dmg += Math.floor((getWeaponStats(player).atk||0) * 0.4);
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
  player.battleTurns = (player.battleTurns||0) + 1;
}

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
  player.battleTurns=0;
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
      fingerMsg="\n\n🔴 **스쿠나 캐릭터 해금!** (`!캐릭터 sukuna`)";
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
// 프로필 임베드 (주력 표시 추가)
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
  const stamina = getPlayerStamina(player);
  return new EmbedBuilder()
    .setColor(awakened?0xFF2200:gradeInfo.color)
    .setTitle(awakened?`🔥 ≪ 천여주박 각성 ≫  ${player.name}`:`${gradeInfo.effect}  ${player.name}의 주술사 카드  ${gradeInfo.effect}`)
    .addFields(
      {name:"╔══ 🏅 주술사 정보 ══════════════════════╗",value:[`> ${ch.emoji} **${ch.name}**  \`[${ch.grade}]\`  ${gradeInfo.stars}`,`> 🎖️ **LV.${lv}**  ·  ${masteryBar(mastery,activeId)}`,`> 💎 **${player.crystals||0}** 크리스탈   🧪 회복약 **${player.potion||0}**개   ⚡치명타 **${crit}%**`,`> ⚔️ 일반 \`${player.wins||0}승 ${player.losses||0}패\`   🥊 PvP \`${player.pvpWins||0}승 ${player.pvpLosses||0}패\``,`> 🌊 컬링 최고: **WAVE ${player.cullingBest||0}**   🎯 사멸회유: **${player.jujutsuBest||0}pt**`,`> 💪 주력: **${stamina.curr}/${stamina.max}**`].join("\n"),inline:false},
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
// GIF 프로필 — 텍스트(fillText) 기반 (주력 추가)
// 내부: 닉네임 / 장착 캐릭터 / 크리스탈 / 회복약 / 주력
// 기존 효과(배경, 애니메이션, 파티클, 아바타 글로우, 링 회전) 완전 유지
// ════════════════════════════════════════════════════════
async function generateProfileGif(player, discordUser) {
  const activeId   = player.active || "itadori";
  const ch         = CHARACTERS[activeId] || CHARACTERS["itadori"];
  const grade      = ch.grade || "3급";
  const gradeInfo  = GACHA_RARITY[grade] || GACHA_RARITY["3급"];
  const awakened   = isMakiAwakened(player);
  const crystals   = player.crystals || 0;
  const potion     = player.potion || 0;
  const stamina    = getPlayerStamina(player);
  const displayName = (discordUser?.username || player.name || "플레이어").slice(0, 14);
  const charName    = ch.name || "이타도리 유지";

  const GRADE_RGB = {
    "특급": {r:245,g:200,b:66}, "준특급":{r:255,g:140,b:0}, "1급":{r:124,g:92,b:252},
    "준1급":{r:155,g:114,b:207}, "2급":{r:74,g:222,b:128}, "3급":{r:148,g:163,b:184},
  };
  const gc = GRADE_RGB[grade] || {r:148,g:163,b:184};

  const W = 520, H = 300;
  const encoder = new GIFEncoder(W, H);
  encoder.start();
  encoder.setRepeat(0);
  encoder.setDelay(100);
  encoder.setQuality(8);

  const chunks = [];
  const stream = encoder.createReadStream();
  stream.on("data", chunk => chunks.push(chunk));
  const streamEnd = new Promise(resolve => stream.on("end", resolve));

  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext("2d");

  let avatar = null;
  try {
    const url = discordUser?.displayAvatarURL?.({ extension:"png", size:128, forceStatic:true });
    if (url) avatar = await loadImage(url);
  } catch(e) { console.warn("[GIF] 아바타 로드 실패:", e.message); }

  const FRAMES = 24;

  for (let f = 0; f < FRAMES; f++) {
    const t   = f / FRAMES;
    const sin = Math.sin(t * Math.PI * 2);
    const pulse = (sin + 1) / 2;

    const bg = ctx.createLinearGradient(0, 0, W, H);
    if (awakened) {
      bg.addColorStop(0, `rgb(${30 + Math.floor(pulse * 20)},5,5)`);
      bg.addColorStop(1, `rgb(${60 + Math.floor(pulse * 20)},10,15)`);
    } else {
      bg.addColorStop(0, "#06061a");
      bg.addColorStop(0.5, "#0c0c26");
      bg.addColorStop(1, "#101030");
    }
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    for (let i = 0; i < 18; i++) {
      const px = (i * 47 + f * 9 + i * 13) % W;
      const py = (i * 41 + f * 7 + i * 19) % H;
      const pr = 1.2 + pulse * 1.8;
      const pa = 0.10 + pulse * 0.20;
      ctx.beginPath();
      ctx.arc(px, py, pr, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${gc.r},${gc.g},${gc.b},${pa})`;
      ctx.fill();
    }

    const glowA = 0.35 + pulse * 0.65;
    ctx.shadowColor = `rgba(${gc.r},${gc.g},${gc.b},${glowA})`;
    ctx.shadowBlur = 16;
    ctx.strokeStyle = `rgba(${gc.r},${gc.g},${gc.b},${glowA})`;
    ctx.lineWidth = 3;
    ctx.strokeRect(5, 5, W - 10, H - 10);
    ctx.shadowBlur = 0;

    ctx.fillStyle = "rgba(0,0,0,0.58)";
    ctx.fillRect(18, 18, W - 36, H - 36);
    ctx.strokeStyle = `rgba(${gc.r},${gc.g},${gc.b},0.18)`;
    ctx.lineWidth = 1;
    ctx.strokeRect(18, 18, W - 36, H - 36);

    ctx.strokeStyle = `rgba(${gc.r},${gc.g},${gc.b},0.20)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(190, 25);
    ctx.lineTo(190, H - 25);
    ctx.stroke();

    const aCX = 100, aCY = 110, aR = 62;

    ctx.save();
    ctx.shadowBlur = 20 + pulse * 14;
    ctx.shadowColor = `rgba(${gc.r},${gc.g},${gc.b},0.9)`;
    ctx.beginPath();
    ctx.arc(aCX, aCY, aR + 4, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${gc.r},${gc.g},${gc.b},${0.55 + pulse * 0.45})`;
    ctx.lineWidth = 3.5;
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.translate(aCX, aCY);
    ctx.rotate(t * Math.PI * 2 * 0.3);
    ctx.strokeStyle = `rgba(${gc.r},${gc.g},${gc.b},${0.25 + pulse * 0.15})`;
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 10]);
    ctx.beginPath();
    ctx.arc(0, 0, aR + 10, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.arc(aCX, aCY, aR, 0, Math.PI * 2);
    ctx.clip();
    if (avatar) {
      ctx.drawImage(avatar, aCX - aR, aCY - aR, aR * 2, aR * 2);
    } else {
      ctx.fillStyle = "#1a1a3a";
      ctx.fillRect(aCX - aR, aCY - aR, aR * 2, aR * 2);
      ctx.font = "bold 32px sans-serif";
      ctx.fillStyle = `rgba(${gc.r},${gc.g},${gc.b},0.9)`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("?", aCX, aCY);
    }
    ctx.restore();

    if (awakened) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(aCX, aCY, aR, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = `rgba(255,30,0,${0.15 + pulse * 0.10})`;
      ctx.fillRect(aCX - aR, aCY - aR, aR * 2, aR * 2);
      ctx.restore();
    }

    ctx.shadowBlur = 0;

    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.font = "11px sans-serif";
    ctx.fillStyle = `rgba(${gc.r},${gc.g},${gc.b},${0.55 + pulse * 0.30})`;
    ctx.fillText(gradeInfo.stars, aCX, 210);

    const RX = 208;
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";

    ctx.shadowBlur = 12 + pulse * 8;
    ctx.shadowColor = `rgba(${gc.r},${gc.g},${gc.b},1)`;
    ctx.font = "bold 22px sans-serif";
    ctx.fillStyle = `rgb(${gc.r},${gc.g},${gc.b})`;
    ctx.fillText(displayName, RX, 60);
    ctx.shadowBlur = 0;

    ctx.font = "11px sans-serif";
    ctx.fillStyle = `rgba(${gc.r},${gc.g},${gc.b},0.55)`;
    ctx.fillText(`[${grade}]`, RX, 78);

    ctx.strokeStyle = `rgba(${gc.r},${gc.g},${gc.b},0.22)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(RX, 88);
    ctx.lineTo(W - 28, 88);
    ctx.stroke();

    ctx.font = "10px sans-serif";
    ctx.fillStyle = `rgba(${gc.r},${gc.g},${gc.b},0.42)`;
    ctx.fillText("EQUIPPED CHARACTER", RX, 106);

    ctx.font = "bold 15px sans-serif";
    ctx.shadowBlur = 6 + pulse * 4;
    ctx.shadowColor = `rgba(${gc.r},${gc.g},${gc.b},0.7)`;
    ctx.fillStyle = "#e8e0ff";
    ctx.fillText(`${ch.emoji}  ${charName}`, RX, 126);
    ctx.shadowBlur = 0;

    ctx.strokeStyle = `rgba(${gc.r},${gc.g},${gc.b},0.15)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(RX, 138);
    ctx.lineTo(W - 28, 138);
    ctx.stroke();

    ctx.font = "10px sans-serif";
    ctx.fillStyle = `rgba(${gc.r},${gc.g},${gc.b},0.42)`;
    ctx.fillText("CRYSTALS", RX, 158);

    ctx.font = "bold 17px monospace";
    ctx.shadowBlur = 8 + pulse * 6;
    ctx.shadowColor = `rgba(${gc.r},${gc.g},${gc.b},0.9)`;
    ctx.fillStyle = `rgb(${gc.r},${gc.g},${gc.b})`;
    ctx.fillText(`\u{1F48E} ${crystals.toLocaleString()}`, RX, 178);
    ctx.shadowBlur = 0;

    ctx.strokeStyle = `rgba(${gc.r},${gc.g},${gc.b},0.12)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(RX, 190);
    ctx.lineTo(W - 28, 190);
    ctx.stroke();

    ctx.font = "10px sans-serif";
    ctx.fillStyle = "rgba(74,222,128,0.48)";
    ctx.fillText("POTION", RX, 210);

    ctx.font = "bold 17px monospace";
    ctx.shadowBlur = 6 + pulse * 4;
    ctx.shadowColor = `rgba(74,222,128,0.8)`;
    ctx.fillStyle = `rgba(74,222,128,${0.85 + pulse * 0.15})`;
    ctx.fillText(`\u{1F9EA} ${potion}\uAC1C`, RX, 230);
    ctx.shadowBlur = 0;

    // 주력 표시 추가
    ctx.font = "10px sans-serif";
    ctx.fillStyle = `rgba(255,215,0,0.48)`;
    ctx.fillText("STAMINA", RX, 250);
    ctx.font = "bold 15px monospace";
    ctx.shadowBlur = 6 + pulse * 4;
    ctx.shadowColor = `rgba(255,215,0,0.8)`;
    ctx.fillStyle = `rgba(255,215,0,${0.85 + pulse * 0.15})`;
    ctx.fillText(`💪 ${stamina.curr}/${stamina.max}`, RX, 268);
    ctx.shadowBlur = 0;

    if (awakened) {
      ctx.font = "bold 13px sans-serif";
      ctx.textAlign = "center";
      ctx.shadowBlur = 10 + pulse * 8;
      ctx.shadowColor = "rgba(255,50,0,1)";
      ctx.fillStyle = `rgba(255,${60 + Math.floor(pulse * 80)},0,${0.9 + pulse * 0.1})`;
      ctx.fillText("\uD83D\uDD25 \uCC9C\uC5EC\uC8FC\uBC15 \uAC01\uC131!", RX + (W - RX - 30) / 2, 282);
      ctx.shadowBlur = 0;
      ctx.textAlign = "left";
    }

    ctx.strokeStyle = `rgba(${gc.r},${gc.g},${gc.b},0.18)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(28, H - 36);
    ctx.lineTo(W - 28, H - 36);
    ctx.stroke();

    ctx.textAlign = "center";
    ctx.font = "10px sans-serif";
    ctx.fillStyle = `rgba(${gc.r},${gc.g},${gc.b},${0.20 + pulse * 0.15})`;
    ctx.fillText(`${displayName}  \u00B7  \uC8FC\uC220\uD68C\uC804 RPG`, W / 2, H - 14);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.shadowBlur = 0;

    encoder.addFrame(ctx);
  }

  encoder.finish();
  await streamEnd;
  return Buffer.concat(chunks);
}

// ════════════════════════════════════════════════════════
// 가챠 컷씬 (변경 없음)
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
  const stamina = getPlayerStamina(player);
  return new EmbedBuilder().setTitle(`${awakened?"🔥 ":""}⚔️ 컬링 게임 — 🌊 WAVE ${session.wave}`).setColor(awakened?0xFF2200:session.wave>=15?0xF5C842:session.wave>=8?0xe63946:0x7C5CFC).setDescription(log.length?log.join("\n"):"⚔️ 새 파도가 밀려온다!")
    .addFields({name:`${ch.emoji} 내 HP${awakened?" 🔥[각성]":""}`,value:`💚 \`${Math.max(0,player.hp||0)}/${stats.maxHp}\`\n🩸 상태: ${statusStr(player.statusEffects||[])}\n💪 주력: ${stamina.curr}/${stamina.max}\n⚡ 술식: \`${(player.skillCooldown||0)>0?(player.skillCooldown+"턴"):"✅"}\` ♻ 반전: \`${(player.reverseCooldown||0)>0?(player.reverseCooldown+"턴"):"✅"}\` 🌌영역: \`${(player.domainCooldown||0)>0?(player.domainCooldown+"턴"):"✅"}\``,inline:true},{name:`${enemy.emoji} ${enemy.name}`,value:`💚 \`${Math.max(0,session.enemyHp)}/${enemy.hp}\`\n🩸 상태: ${statusStr(enemy.statusEffects||[])}\n🗡️ ATK **${enemy.atk}** · 🛡️ DEF **${enemy.def}**`,inline:true},{name:"📊 현황",value:`🌊 WAVE **${session.wave}** | 처치 **${session.kills}** | 🎯 **${session.totalXp}** XP / **${session.totalCrystals}**💎\n🏆 최고: **WAVE ${player.cullingBest||0}**`,inline:false})
    .setFooter({text:`🔥 현재 스킬: ${getCurrentSkill(player,player.active)?.name||"없음"} — 흑섬 10% | 주력 소모: 스킬 20, 영역 40, 반전 30`});
}
function jujutsuEmbed(player,session,log=[],choices=null) {
  const ch=CHARACTERS[player.active]||CHARACTERS["itadori"]; const stats=getPlayerStats(player); const awakened=isMakiAwakened(player);
  const stamina = getPlayerStamina(player);
  const embed=new EmbedBuilder().setTitle(`🎯 사멸회유 — WAVE ${session.wave} | 포인트 **${session.points}**/15`).setColor(session.points>=10?0xF5C842:session.points>=5?0xff8c00:0x7C5CFC).setDescription(log.length?log.join("\n"):"🎯 사멸회유 진행 중!")
    .addFields({name:`${ch.emoji} 내 HP${awakened?" 🔥[각성]":""}`,value:`💚 \`${Math.max(0,player.hp||0)}/${stats.maxHp}\`\n🩸 상태: ${statusStr(player.statusEffects||[])}\n💪 주력: ${stamina.curr}/${stamina.max}\n⚡ 술식: \`${(player.skillCooldown||0)>0?(player.skillCooldown+"턴"):"✅"}\` 🌌영역: \`${(player.domainCooldown||0)>0?(player.domainCooldown+"턴"):"✅"}\``,inline:false});
  embed.addFields({name:"🎯 포인트 진행도",value:`${"🟦".repeat(Math.min(session.points,15))}${"⬜".repeat(Math.max(0,15-session.points))} **${session.points}/15**\n📊 누적 XP: **${session.totalXp}** / 누적 💎: **${session.totalCrystals}**`,inline:false});
  if (session.currentEnemy) { const enemy=session.currentEnemy; embed.addFields({name:`${enemy.emoji} 현재 적: ${enemy.name}`,value:`💚 \`${Math.max(0,session.enemyHp)}/${enemy.hp}\`\n🩸 상태: ${statusStr(enemy.statusEffects||[])}\n🎯 처치 시 +${enemy.points}점`,inline:false}); }
  if (choices) embed.addFields({name:"⚔️ 다음 적 선택",value:choices.map((c,i)=>`**[${i+1}]** ${c.emoji} ${c.name} — HP:\`${c.hp}\` ATK:\`${c.atk}\` | +${c.points}점\n└ ${c.desc}`).join("\n"),inline:false});
  embed.setFooter({text:`🏆 최고 기록: ${player.jujutsuBest||0}pt | 15pt 달성 시 +300💎 +500XP 보너스! | 주력 소모: 스킬 20, 영역 40, 반전 30`});
  return embed;
}
function pvpEmbed(session,log=[]) {
  const p1=players[session.p1Id],p2=players[session.p2Id];
  if (!p1||!p2) return new EmbedBuilder().setTitle("PvP 오류").setColor(0xe63946).setDescription("플레이어 정보 없음");
  const ch1=CHARACTERS[p1.active]||CHARACTERS["itadori"],ch2=CHARACTERS[p2.active]||CHARACTERS["itadori"];
  const domainCD1 = session.domainCd1||0, domainCD2 = session.domainCd2||0;
  return new EmbedBuilder().setTitle(`⚔️ PvP 결투  ${p1.name} VS ${p2.name}`).setColor(0xF5C842).setDescription(log.length?log.join("\n"):"⚔️ 결투 시작!")
    .addFields(
      {name:`${ch1.emoji} ${p1.name} [${ch1.grade}]${session.turn===session.p1Id?" ◀ **[내 턴]**":""}`,value:`💚 \`${Math.max(0,session.hp1)}/${session.maxHp1}\`\n🩸 ${statusStr(session.status1||[])}\n💪 주력: ${session.stamina1||STAMINA_MAX_BASE}/${STAMINA_MAX_BASE}\n⚡술식: ${(session.skillCd1||0)>0?`\`${session.skillCd1}턴\``:"✅"}  ♻반전: ${(session.reverseCd1||0)>0?`\`${session.reverseCd1}턴\``:"✅"}  🌌영역: ${domainCD1>0?`\`${domainCD1}턴\``:"✅"}`,inline:true},
      {name:`${ch2.emoji} ${p2.name} [${ch2.grade}]${session.turn===session.p2Id?" ◀ **[내 턴]**":""}`,value:`💚 \`${Math.max(0,session.hp2)}/${session.maxHp2}\`\n🩸 ${statusStr(session.status2||[])}\n💪 주력: ${session.stamina2||STAMINA_MAX_BASE}/${STAMINA_MAX_BASE}\n⚡술식: ${(session.skillCd2||0)>0?`\`${session.skillCd2}턴\``:"✅"}  ♻반전: ${(session.reverseCd2||0)>0?`\`${session.reverseCd2}턴\``:"✅"}  🌌영역: ${domainCD2>0?`\`${domainCD2}턴\``:"✅"}`,inline:true},
      {name:"🎯 턴 정보",value:`> **${session.turn===session.p1Id?p1.name:p2.name}** 의 차례! (Round ${session.round})`,inline:false}
    )
    .setFooter({text:"술식 5턴쿨 | 반전 3턴쿨 (고조/유타) | 영역전개 15턴쿨 | 주력 소모: 스킬 20, 영역 40, 반전 30"});
}
function raidEmbed(raidSession,log=[]) {
  const boss=RAID_BOSSES[raidSession.bossId]; if (!boss) return new EmbedBuilder().setTitle("오류");
  const enraged=raidSession.enraged;
  const memberLines=raidSession.members.map(uid=>{ const p=players[uid]; if (!p) return `> ❓`; const ch=CHARACTERS[p.active]||CHARACTERS["itadori"],stats=getPlayerStats(p); const aw=isMakiAwakened(p); const pct=Math.max(0,p.hp||0)/stats.maxHp; const icon=pct>0.6?"🟢":pct>0.3?"🟡":"🔴"; return `> ${ch.emoji} **${p.name}** ${icon} \`${Math.max(0,p.hp||0)}/${stats.maxHp}\`${aw?" 🔥[각성]":""}`; }).join("\n");
  const adaptedStr=raidSession.adaptedSkills?.length?`\n> 🔄 적응된 술식: ${raidSession.adaptedSkills.join(", ")}`:"";
  return new EmbedBuilder().setTitle(`${boss.emoji} 레이드: ${boss.name}`).setColor(enraged?0xff0000:boss.color).setDescription([enraged?"```ansi\n\u001b[1;31m║  ⚠️  ENRAGED — 분노 페이즈!  ⚠️  ║\n```":"",log.length?log.join("\n"):"⚔️ 레이드 진행 중!"].filter(Boolean).join("\n"))
    .addFields({name:`${boss.emoji} ${boss.name}`,value:`💚 \`${Math.max(0,raidSession.hp)}/${boss.hp}\`\n🗡️ ATK: **${enraged?boss.enragedAtk:boss.atk}**  |  🛡️ DEF: **${boss.def}**${adaptedStr}`,inline:false},{name:`👥 파티 (${raidSession.members.length}명)`,value:memberLines||"> 없음",inline:false})
    .setFooter({text:"레이드 — 파티원 누구나 행동 가능 | 주력 소모: 스킬 20, 영역 40"});
}
function partyCullingEmbed(party,session,log=[]) {
  const enemy=session.currentEnemy;
  const memberLines=party.members.map(uid=>{ const p=players[uid]; if (!p) return `> ❓`; const ch=CHARACTERS[p.active]||CHARACTERS["itadori"],stats=getPlayerStats(p),aw=isMakiAwakened(p); const pct=Math.max(0,p.hp||0)/stats.maxHp; const icon=pct>0.5?"🟢":pct>0.3?"🟡":"🔴"; return `> ${party.leader===uid?"👑":"👤"} **${p.name}** ${ch.emoji} ${icon} \`${Math.max(0,p.hp||0)}/${stats.maxHp}\`${aw?" 🔥":""}`; }).join("\n");
  return new EmbedBuilder().setTitle(`⚔️ [파티] 컬링 게임 — 🌊 WAVE ${session.wave}`).setColor(session.wave>=15?0xF5C842:session.wave>=8?0xe63946:0x7C5CFC).setDescription(log.length?log.join("\n"):"⚔️ 파티 컬링 진행 중!")
    .addFields({name:`👥 파티원 (${party.members.length}명)`,value:memberLines||"없음",inline:false},{name:`${enemy.emoji} ${enemy.name}`,value:`💚 \`${Math.max(0,session.enemyHp)}/${enemy.hp}\`\n🩸 상태: ${statusStr(enemy.statusEffects||[])}\n🗡️ ATK: ${enemy.atk} · 🛡️ DEF: ${enemy.def}`,inline:false},{name:"📊 현황",value:`🌊 WAVE **${session.wave}** | 처치 **${session.kills}** | 📊 **${session.totalXp}** XP / **${session.totalCrystals}**💎`,inline:false})
    .setFooter({text:"파티원 누구나 행동 가능! | 주력 소모: 스킬 20"});
}
function buildSkillEmbed(player) {
  const id=player.active||"itadori"; const ch=CHARACTERS[id]||CHARACTERS["itadori"]; const mastery=getMastery(player,id); const awakened=isMakiAwakened(player); const fingers=player.sukunaFingers||0; const mainSkill=getMainSkill(player,id);
  const domainCD = player.domainCooldown||0;
  return new EmbedBuilder().setTitle(`${ch.emoji} ≪ 술식 트리 ≫ ${ch.name}${awakened?" 🔥[각성]":""}`).setColor(awakened?0xFF2200:JJK_GRADE_COLOR[ch.grade]||0x7c5cfc)
    .setDescription([`> ${ch.lore||ch.desc}`,`> 📈 **${masteryBar(mastery,id)}**`,`> 🌌 **영역전개** \`${ch.domain||"없음"}\` — 쿨타임: ${domainCD>0?`**${domainCD}턴**`:"✅ 사용가능"} (15턴당 1번)`,id==="itadori"?`> 👹 **스쿠나 손가락** \`${fingers}/${SUKUNA_FINGER_MAX}\` — ${getFingerBonus(fingers).label}`:"",id==="sukuna"?`> 👹 **손가락 보너스**: ATK+${getFingerBonus(fingers).atkBonus} DEF+${getFingerBonus(fingers).defBonus} HP+${getFingerBonus(fingers).hpBonus}`:"",awakened?`> 🔥 **천여주박 각성 중** — 모든 데미지 **2배**!`:"",mainSkill?`> ⭐ **주력 스킬:** ${mainSkill.name} (해금됨!)`:id==="gojo"?`> ⭐ **주력 스킬:** 자폭 무라사키 (20승 필요)`:id==="sukuna"?`> ⭐ **주력 스킬:** 세계참 (손가락 10개 필요)`:""].filter(Boolean).join("\n"))
    .addFields(ch.skills.map((s,idx)=>{ const unlocked=mastery>=s.minMastery; const fx=getSkillEffect(s.name); const statusNote=s.statusApply?` \`${STATUS_EFFECTS[s.statusApply.statusId]?.emoji}${STATUS_EFFECTS[s.statusApply.statusId]?.name} ${Math.round(s.statusApply.chance*100)}%\``:""; return {name:`${unlocked?"✅":"🔒"} [${idx+1}] ${s.name}  —  피해 **${s.dmg}**${statusNote}  (숙련 ${s.minMastery})`,value:[`> ${s.desc}`,unlocked?`> ${fx.art}`:"> 🔒 잠김",unlocked?`> *${fx.flavorText}*`:""].filter(Boolean).join("\n"),inline:false}; }))
    .setFooter({text:"⚫ 흑섬: 10% 확률로 2.5배 피해 + 50💎 | 🌌 영역전개: !전투/컬링/사멸회유/레이드 모두 사용가능 | 주력 소모: 스킬 20, 영역 40, 반전 30"});
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
function mkCharSelectMenu(player, customId="char_select") {
  const owned = player.owned || ["itadori"];
  const options = owned.map(id => {
    const ch = CHARACTERS[id]; if (!ch) return null;
    const ri = GACHA_RARITY[ch.grade]||GACHA_RARITY["3급"];
    const mastery = getMastery(player, id);
    const isActive = id === player.active;
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
  if (enemy.statusAttack && Math.random() < (enemy.statusAttack.chance||0.25)) {
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
  if (boss.statusAttack && Math.random() < (boss.statusAttack.chance||0.25)) {
    applyStatus(player, boss.statusAttack.statusId);
    const sdef = STATUS_EFFECTS[boss.statusAttack.statusId];
    if (sdef) log.push(`> ${sdef.emoji} **${sdef.name}** 상태이상!`);
  }
  if (boss.specialAttack && Math.random() < 0.25) {
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
    {name:"캐릭터",     description:"캐릭터 선택 메뉴"},
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
// 인터랙션 핸들러 (수정 없음, 다만 stamina 관련 체크 추가)
// ════════════════════════════════════════════════════════
client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isStringSelectMenu() && interaction.customId === "char_select") {
      const userId = interaction.user.id;
      const player = getPlayer(userId, interaction.user.username);
      const charId = interaction.values[0];
      if (!Array.isArray(player.owned)) player.owned = ["itadori"];
      if (!player.owned.includes(charId)) {
        return interaction.reply({ content:"❌ 보유하지 않은 캐릭터입니다!", ephemeral:true });
      }
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
      player.active = charId;
      if (!player.mastery) player.mastery = {};
      if (player.mastery[charId] === undefined) player.mastery[charId] = 0;
      const stats = getPlayerStats(player);
      player.hp = stats.maxHp;
      player.statusEffects = [];
      player.skillCooldown = 0;
      player.domainCooldown = 0;
      player.reverseCooldown = 0;
      player.stamina = STAMINA_MAX_BASE;
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

    if (interaction.isButton()) {
      const { customId, user } = interaction;
      const userId = user.id;
      const player = getPlayer(userId, user.username);

      if (isVerifyPending(userId) && (customId.startsWith("b_") || customId.startsWith("c_") || customId.startsWith("j_") || customId.startsWith("r_") || customId.startsWith("pc_"))) {
        return interaction.reply({ content:"🔒 **매크로 인증 대기 중입니다!** 채팅창에 인증 코드를 입력해주세요.", ephemeral:true });
      }

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
// PvP 세션 생성 (stamina 추가)
// ════════════════════════════════════════════════════════
function createPvpSession(p1Id, p2Id) {
  const s1=getPlayerStats(players[p1Id]), s2=getPlayerStats(players[p2Id]);
  return {
    id:`pvp_${Date.now()}_${_pvpIdSeq++}`, p1Id, p2Id,
    hp1:s1.maxHp, hp2:s2.maxHp, maxHp1:s1.maxHp, maxHp2:s2.maxHp,
    status1:[], status2:[],
    stamina1: STAMINA_MAX_BASE, stamina2: STAMINA_MAX_BASE,
    skillCd1:0, skillCd2:0,
    reverseCd1:0, reverseCd2:0,
    domainCd1:0, domainCd2:0,
    turn:p1Id, round:1,
  };
}

// ════════════════════════════════════════════════════════
// 전투 액션 핸들러 (주력 소모 및 재생 추가)
// ════════════════════════════════════════════════════════
async function handleBattleAction(interaction, player, battle, customId) {
  const enemy = ENEMIES.find(e => e.id === battle.enemyId) || ENEMIES[0];
  const log = [];
  const stats = getPlayerStats(player);

  if (customId !== "b_reverse") {
    const tick = tickStatus(player, stats.maxHp);
    if (tick.log.length) log.push(...tick.log);
  }
  {
    const eTick = tickStatus(battle.enemy, battle.enemy.hp);
    if (eTick.log.length) log.push(...eTick.log.map(l => l.replace("**", "**[적]")));
  }

  if (customId === "b_run") {
    delete battles[player.id];
    player.statusEffects = [];
    player.skillCooldown = 0;
    player.domainCooldown = 0;
    player.reverseCooldown = 0;
    savePlayer(player.id);
    return interaction.update({ content:"🏃 도주했습니다!", embeds:[], components:[] });
  }

  if (customId === "b_reverse") {
    if (!REVERSE_CHARS.has(player.active)) return interaction.reply({ content:"❌ 이 캐릭터는 반전술식을 사용할 수 없습니다!", ephemeral:true });
    if ((player.reverseCooldown||0) > 0) return interaction.reply({ content:`♻️ 반전술식 쿨타임: **${player.reverseCooldown}턴** 남음!`, ephemeral:true });
    if (!consumeStamina(player, STAMINA_COST_REVERSE)) return interaction.reply({ content:`💪 주력 부족! (필요: ${STAMINA_COST_REVERSE})`, ephemeral:true });
    const healAmt = Math.floor(stats.maxHp * (player.reverseOutput||1.0) * 0.35);
    player.hp = Math.min(stats.maxHp, (player.hp||0) + healAmt);
    player.reverseCooldown = 3;
    tickCooldowns(player);
    log.push(`> ♻️ **반전술식** 발동! HP **+${healAmt}** 회복!`);
    await doEnemyAttack(player, battle.enemy, log);
    regenStamina(player);
    if ((player.hp||0) <= 0) {
      player.losses = (player.losses||0) + 1;
      player.hp = 0;
      player.statusEffects = [];
      player.skillCooldown = 0;
      player.domainCooldown = 0;
      player.reverseCooldown = 0;
      player.battleTurns = 0;
      delete battles[player.id];
      savePlayer(player.id);
      return interaction.update({ embeds:[new EmbedBuilder().setColor(0xe63946).setTitle("💀 전투 패배").setDescription(log.join("\n")+"\n\n> 💀 전투 불능! `!회복` 으로 회복하세요.")], components:[] });
    }
    savePlayer(player.id);
    if (shouldTriggerVerify(player) && !isVerifyPending(player.id)) {
      const code = generateVerifyCode();
      antiBotVerify.set(player.id, { code, timestamp:Date.now(), pending:true });
      await interaction.update({ embeds:[buildBattleEmbed(player, battle.enemy, log)], components:[] });
      return interaction.followUp({ content:`🔒 **매크로 방지 인증!** 아래 코드를 채팅창에 입력하세요 (30초 이내):\n\`\`\`\n${code}\n\`\`\``, ephemeral:true });
    }
    return interaction.update({ embeds:[buildBattleEmbed(player, battle.enemy, log)], components:mkBattleButtons(player) });
  }

  if (customId === "b_attack") {
    if (isIncapacitated(player.statusEffects||[])) {
      log.push(`> ⚡ 상태이상으로 행동 불가!`);
      tickCooldowns(player);
      await doEnemyAttack(player, battle.enemy, log);
      regenStamina(player);
      if ((player.hp||0) <= 0) {
        player.losses = (player.losses||0) + 1;
        player.hp = 0;
        player.statusEffects = [];
        player.skillCooldown = 0;
        player.domainCooldown = 0;
        player.reverseCooldown = 0;
        player.battleTurns = 0;
        delete battles[player.id];
        savePlayer(player.id);
        return interaction.update({ embeds:[new EmbedBuilder().setColor(0xe63946).setTitle("💀 전투 패배").setDescription(log.join("\n")+"\n\n> 💀 전투 불능!")], components:[] });
      }
      savePlayer(player.id);
      return interaction.update({ embeds:[buildBattleEmbed(player, battle.enemy, log)], components:mkBattleButtons(player) });
    }
    if (!rollHit(player.statusEffects||[], battle.enemy.statusEffects||[])) {
      log.push(`> 🌀 공격이 빗나갔다!`);
    } else {
      const bf = isBlackFlash();
      const { dmg, isCrit } = calcDmgForPlayer(player, battle.enemy.def, bf ? 2.5 : 1.0);
      battle.enemy.hp = Math.max(0, battle.enemy.hp - dmg);
      if (bf) { log.push(getBlackFlashArt()); log.push(`> ⚫ **흑섬 발동!!** **${dmg}** 피해! (+50💎)`); player.crystals = (player.crystals||0) + 50; }
      else log.push(`> ⚔️ 공격! **${dmg}** 피해!${isCrit?" 💥**CRITICAL!**":""}`);
      if (player.kogane?.grade === "1급" && Math.random() < 0.10) {
        const extraDmg = Math.floor(stats.atk * 0.30);
        battle.enemy.hp = Math.max(0, battle.enemy.hp - extraDmg);
        log.push(`> 🐾 **황금 발톱** 발동! 추가 **${extraDmg}** 피해!`);
      }
    }
    tickCooldowns(player);
    if (battle.enemy.hp <= 0) {
      delete battles[player.id];
      player.statusEffects = [];
      player.skillCooldown = 0;
      player.domainCooldown = 0;
      player.reverseCooldown = 0;
      const winEmbed = await processBattleWin(player, enemy);
      savePlayer(player.id);
      return interaction.update({ embeds:[winEmbed], components:[] });
    }
    await doEnemyAttack(player, battle.enemy, log);
    regenStamina(player);
    if ((player.hp||0) <= 0) {
      player.losses = (player.losses||0) + 1;
      player.hp = 0;
      player.statusEffects = [];
      player.skillCooldown = 0;
      player.domainCooldown = 0;
      player.reverseCooldown = 0;
      player.battleTurns = 0;
      delete battles[player.id];
      savePlayer(player.id);
      return interaction.update({ embeds:[new EmbedBuilder().setColor(0xe63946).setTitle("💀 전투 패배").setDescription(log.join("\n")+"\n\n> 💀 전투 불능! `!회복` 으로 회복하세요.")], components:[] });
    }
    savePlayer(player.id);
    if (shouldTriggerVerify(player) && !isVerifyPending(player.id)) {
      const code = generateVerifyCode();
      antiBotVerify.set(player.id, { code, timestamp:Date.now(), pending:true });
      await interaction.update({ embeds:[buildBattleEmbed(player, battle.enemy, log)], components:[] });
      return interaction.followUp({ content:`🔒 **매크로 방지 인증!** 아래 코드를 채팅창에 입력하세요 (30초 이내):\n\`\`\`\n${code}\n\`\`\``, ephemeral:true });
    }
    return interaction.update({ embeds:[buildBattleEmbed(player, battle.enemy, log)], components:mkBattleButtons(player) });
  }

  if (customId === "b_skill") {
    if ((player.skillCooldown||0) > 0) return interaction.reply({ content:`⚡ 술식 쿨타임: **${player.skillCooldown}턴** 남음!`, ephemeral:true });
    if (!consumeStamina(player, STAMINA_COST_SKILL)) return interaction.reply({ content:`💪 주력 부족! (필요: ${STAMINA_COST_SKILL})`, ephemeral:true });
    if (isIncapacitated(player.statusEffects||[])) {
      log.push(`> ⚡ 상태이상으로 행동 불가!`);
      tickCooldowns(player);
      await doEnemyAttack(player, battle.enemy, log);
      regenStamina(player);
      if ((player.hp||0) <= 0) {
        player.losses = (player.losses||0) + 1;
        player.hp = 0;
        player.statusEffects = [];
        player.skillCooldown = 0;
        player.domainCooldown = 0;
        player.reverseCooldown = 0;
        player.battleTurns = 0;
        delete battles[player.id];
        savePlayer(player.id);
        return interaction.update({ embeds:[new EmbedBuilder().setColor(0xe63946).setTitle("💀 전투 패배").setDescription(log.join("\n")+"\n\n> 💀 전투 불능!")], components:[] });
      }
      savePlayer(player.id);
      return interaction.update({ embeds:[buildBattleEmbed(player, battle.enemy, log)], components:mkBattleButtons(player) });
    }
    const skill = getCurrentSkill(player, player.active);
    if (!skill) return interaction.reply({ content:"❌ 사용 가능한 술식 없음", ephemeral:true });
    const fx = getSkillEffect(skill.name);
    const { dmg, isCrit } = calcSkillDmgForPlayer(player, skill.dmg);
    battle.enemy.hp = Math.max(0, battle.enemy.hp - dmg);
    log.push(fx.art);
    log.push(`> 🌀 **${skill.name}** 발동! **${dmg}** 피해!${isCrit?" 💥**CRITICAL!**":""}`);
    log.push(`> *${fx.flavorText}*`);
    const statusMsgs = applySkillStatus(skill, battle.enemy, player);
    if (statusMsgs.length) log.push(...statusMsgs);
    player.skillCooldown = 5;
    updateQuestProgress(player, "skill_use", 1);
    tickCooldowns(player);
    if (battle.enemy.hp <= 0) {
      delete battles[player.id];
      player.statusEffects = [];
      player.skillCooldown = 0;
      player.domainCooldown = 0;
      player.reverseCooldown = 0;
      const winEmbed = await processBattleWin(player, enemy);
      savePlayer(player.id);
      return interaction.update({ embeds:[winEmbed], components:[] });
    }
    await doEnemyAttack(player, battle.enemy, log);
    regenStamina(player);
    if ((player.hp||0) <= 0) {
      player.losses = (player.losses||0) + 1;
      player.hp = 0;
      player.statusEffects = [];
      player.skillCooldown = 0;
      player.domainCooldown = 0;
      player.reverseCooldown = 0;
      player.battleTurns = 0;
      delete battles[player.id];
      savePlayer(player.id);
      return interaction.update({ embeds:[new EmbedBuilder().setColor(0xe63946).setTitle("💀 전투 패배").setDescription(log.join("\n")+"\n\n> 💀 전투 불능! `!회복` 으로 회복하세요.")], components:[] });
    }
    savePlayer(player.id);
    if (shouldTriggerVerify(player) && !isVerifyPending(player.id)) {
      const code = generateVerifyCode();
      antiBotVerify.set(player.id, { code, timestamp:Date.now(), pending:true });
      await interaction.update({ embeds:[buildBattleEmbed(player, battle.enemy, log)], components:[] });
      return interaction.followUp({ content:`🔒 **매크로 방지 인증!** 아래 코드를 채팅창에 입력하세요 (30초 이내):\n\`\`\`\n${code}\n\`\`\``, ephemeral:true });
    }
    return interaction.update({ embeds:[buildBattleEmbed(player, battle.enemy, log)], components:mkBattleButtons(player) });
  }

  if (customId === "b_main") {
    const mainSkill = getMainSkill(player, player.active);
    if (!mainSkill) return interaction.reply({ content:"❌ 주력 스킬 없음", ephemeral:true });
    if (!consumeStamina(player, STAMINA_COST_MAIN)) return interaction.reply({ content:`💪 주력 부족! (필요: ${STAMINA_COST_MAIN})`, ephemeral:true });
    const fx = getSkillEffect(mainSkill.name);
    if (mainSkill.name === "자폭 무라사키") {
      const dmg = mainSkill.dmg;
      battle.enemy.hp = Math.max(0, battle.enemy.hp - dmg);
      player.hp = 1;
      log.push(fx.art);
      log.push(`> 💥 **자폭 무라사키** 발동!! **${dmg}** 피해! HP가 1로!`);
    } else {
      const { dmg, isCrit } = calcSkillDmgForPlayer(player, mainSkill.dmg);
      battle.enemy.hp = Math.max(0, battle.enemy.hp - dmg);
      log.push(fx.art);
      log.push(`> ⭐ **${mainSkill.name}** 발동!! **${dmg}** 피해!${isCrit?" 💥**CRITICAL!**":""}`);
    }
    tickCooldowns(player);
    if (battle.enemy.hp <= 0) {
      delete battles[player.id];
      player.statusEffects = [];
      player.skillCooldown = 0;
      player.domainCooldown = 0;
      player.reverseCooldown = 0;
      const winEmbed = await processBattleWin(player, enemy);
      savePlayer(player.id);
      return interaction.update({ embeds:[winEmbed], components:[] });
    }
    await doEnemyAttack(player, battle.enemy, log);
    regenStamina(player);
    if ((player.hp||0) <= 0) {
      player.losses = (player.losses||0) + 1;
      player.hp = 0;
      player.statusEffects = [];
      player.skillCooldown = 0;
      player.domainCooldown = 0;
      player.reverseCooldown = 0;
      player.battleTurns = 0;
      delete battles[player.id];
      savePlayer(player.id);
      return interaction.update({ embeds:[new EmbedBuilder().setColor(0xe63946).setTitle("💀 전투 패배").setDescription(log.join("\n")+"\n\n> 💀 전투 불능!")], components:[] });
    }
    savePlayer(player.id);
    return interaction.update({ embeds:[buildBattleEmbed(player, battle.enemy, log)], components:mkBattleButtons(player) });
  }

  if (customId === "b_domain") {
    if (!canUseDomain(player)) return interaction.reply({ content:`🌌 영역전개 쿨타임: **${player.domainCooldown}턴** 남음!`, ephemeral:true });
    const ch = CHARACTERS[player.active];
    if (!ch?.domain) return interaction.reply({ content:"❌ 이 캐릭터는 영역전개가 없습니다!", ephemeral:true });
    if (!consumeStamina(player, STAMINA_COST_DOMAIN)) return interaction.reply({ content:`💪 주력 부족! (필요: ${STAMINA_COST_DOMAIN})`, ephemeral:true });
    const domainRes = applyDomainExpansion(stats, ch.domain, battle.enemy, true);
    log.push(...domainRes.log);
    player.domainCooldown = 15;
    tickCooldowns(player);
    if (battle.enemy.hp <= 0) {
      delete battles[player.id];
      player.statusEffects = [];
      player.skillCooldown = 0;
      player.domainCooldown = 0;
      player.reverseCooldown = 0;
      const winEmbed = await processBattleWin(player, enemy);
      savePlayer(player.id);
      return interaction.update({ embeds:[winEmbed], components:[] });
    }
    await doEnemyAttack(player, battle.enemy, log);
    regenStamina(player);
    if ((player.hp||0) <= 0) {
      player.losses = (player.losses||0) + 1;
      player.hp = 0;
      player.statusEffects = [];
      player.skillCooldown = 0;
      player.domainCooldown = 0;
      player.reverseCooldown = 0;
      player.battleTurns = 0;
      delete battles[player.id];
      savePlayer(player.id);
      return interaction.update({ embeds:[new EmbedBuilder().setColor(0xe63946).setTitle("💀 전투 패배").setDescription(log.join("\n")+"\n\n> 💀 전투 불능!")], components:[] });
    }
    savePlayer(player.id);
    return interaction.update({ embeds:[buildBattleEmbed(player, battle.enemy, log)], components:mkBattleButtons(player) });
  }
}

function buildBattleEmbed(player, enemyState, log=[]) {
  const stats = getPlayerStats(player);
  const ch = CHARACTERS[player.active] || CHARACTERS["itadori"];
  const awakened = isMakiAwakened(player);
  const enemy = enemyState;
  const stamina = getPlayerStamina(player);
  return new EmbedBuilder()
    .setTitle(`${awakened?"🔥 ":""}⚔️ 전투 — ${ch.emoji} ${ch.name} VS ${enemy.emoji} ${enemy.name}`)
    .setColor(awakened ? 0xFF2200 : JJK_GRADE_COLOR[ch.grade]||0x7c5cfc)
    .setDescription(log.length ? log.join("\n") : "⚔️ 전투 진행 중!")
    .addFields(
      {name:`${ch.emoji} 내 HP${awakened?" 🔥[각성]":""}`, value:`💚 \`${Math.max(0,player.hp||0)}/${stats.maxHp}\`\n🩸 ${statusStr(player.statusEffects||[])}\n💪 주력: ${stamina.curr}/${stamina.max}\n⚡술식: \`${(player.skillCooldown||0)>0?(player.skillCooldown+"턴"):"✅"}\` ♻반전: \`${(player.reverseCooldown||0)>0?(player.reverseCooldown+"턴"):"✅"}\` 🌌영역: \`${(player.domainCooldown||0)>0?(player.domainCooldown+"턴"):"✅"}\``, inline:true},
      {name:`${enemy.emoji} ${enemy.name}`, value:`💚 \`${Math.max(0,enemy.hp)}/${enemy.maxHp||enemy.hp}\`\n🩸 ${statusStr(enemy.statusEffects||[])}\n🗡️ ATK **${enemy.atk}** · 🛡️ DEF **${enemy.def}**`, inline:true},
    )
    .setFooter({text:`⚫ 흑섬 10% | 현재 스킬: ${getCurrentSkill(player,player.active)?.name||"없음"} | 주력 소모: 스킬 20, 영역 40, 반전 30`});
}

// ════════════════════════════════════════════════════════
// 컬링 액션 핸들러 (주력 추가)
// ════════════════════════════════════════════════════════
async function handleCullingAction(interaction, player, session, customId) {
  const log = [];
  const stats = getPlayerStats(player);

  if (customId === "c_escape") {
    const pid = getPartyId(player.id);
    if (pid) delete cullings[pid];
    else delete cullings[player.id];
    player.statusEffects = [];
    player.skillCooldown = 0;
    player.domainCooldown = 0;
    player.reverseCooldown = 0;
    savePlayer(player.id);
    return interaction.update({ content:`🏳️ 컬링 게임 철수! 최고 기록: WAVE **${player.cullingBest||0}**`, embeds:[], components:[] });
  }

  const tick = tickStatus(player, stats.maxHp);
  if (tick.log.length) log.push(...tick.log);
  const eTick = tickStatus(session.currentEnemy, session.currentEnemy.hp);
  if (eTick.log.length) log.push(...eTick.log.map(l=>l+"[적]"));

  if (customId === "c_reverse") {
    if (!REVERSE_CHARS.has(player.active)) return interaction.reply({ content:"❌ 이 캐릭터는 반전술식 불가!", ephemeral:true });
    if ((player.reverseCooldown||0) > 0) return interaction.reply({ content:`♻️ 쿨타임 ${player.reverseCooldown}턴!`, ephemeral:true });
    if (!consumeStamina(player, STAMINA_COST_REVERSE)) return interaction.reply({ content:`💪 주력 부족! (필요: ${STAMINA_COST_REVERSE})`, ephemeral:true });
    const heal = Math.floor(stats.maxHp * 0.35);
    player.hp = Math.min(stats.maxHp, (player.hp||0) + heal);
    player.reverseCooldown = 3;
    log.push(`> ♻️ **반전술식** — HP **+${heal}** 회복!`);
  } else if (customId === "c_attack" || customId === "c_skill" || customId === "c_domain") {
    if (isIncapacitated(player.statusEffects||[])) {
      log.push(`> ⚡ 상태이상으로 행동 불가!`);
    } else if (customId === "c_attack") {
      if (!rollHit(player.statusEffects||[], session.currentEnemy.statusEffects||[])) {
        log.push(`> 🌀 공격 빗나감!`);
      } else {
        const bf = isBlackFlash();
        const { dmg, isCrit } = calcDmgForPlayer(player, session.currentEnemy.def, bf ? 2.5 : 1.0);
        session.enemyHp = Math.max(0, session.enemyHp - dmg);
        session.currentEnemy.hp = session.enemyHp;
        if (bf) { log.push(getBlackFlashArt()); log.push(`> ⚫ **흑섬!!** **${dmg}** 피해! (+50💎)`); player.crystals += 50; }
        else log.push(`> ⚔️ 공격! **${dmg}** 피해!${isCrit?" 💥**CRITICAL!**":""}`);
      }
    } else if (customId === "c_skill") {
      if ((player.skillCooldown||0) > 0) return interaction.reply({ content:`⚡ 쿨타임 ${player.skillCooldown}턴!`, ephemeral:true });
      if (!consumeStamina(player, STAMINA_COST_SKILL)) return interaction.reply({ content:`💪 주력 부족! (필요: ${STAMINA_COST_SKILL})`, ephemeral:true });
      const skill = getCurrentSkill(player, player.active);
      const fx = getSkillEffect(skill.name);
      const { dmg, isCrit } = calcSkillDmgForPlayer(player, skill.dmg);
      session.enemyHp = Math.max(0, session.enemyHp - dmg);
      session.currentEnemy.hp = session.enemyHp;
      log.push(fx.art);
      log.push(`> 🌀 **${skill.name}** — **${dmg}** 피해!${isCrit?" 💥**CRITICAL!**":""}`);
      const sm = applySkillStatus(skill, session.currentEnemy, player);
      if (sm.length) log.push(...sm);
      player.skillCooldown = 5;
      updateQuestProgress(player, "skill_use", 1);
    } else if (customId === "c_domain") {
      if (!canUseDomain(player)) return interaction.reply({ content:`🌌 영역전개 쿨타임 ${player.domainCooldown}턴!`, ephemeral:true });
      const ch = CHARACTERS[player.active];
      if (!ch?.domain) return interaction.reply({ content:"❌ 영역전개 없음", ephemeral:true });
      if (!consumeStamina(player, STAMINA_COST_DOMAIN)) return interaction.reply({ content:`💪 주력 부족! (필요: ${STAMINA_COST_DOMAIN})`, ephemeral:true });
      const dr = applyDomainExpansion(stats, ch.domain, session.currentEnemy, true);
      session.enemyHp = session.currentEnemy.hp;
      log.push(...dr.log);
      player.domainCooldown = 15;
    }
  }

  tickCooldowns(player);

  if (session.enemyHp <= 0) {
    const enemy = session.currentEnemy;
    const xpGain = Math.floor(enemy.xp * getKoganeBonus(player).xp);
    const crGain = Math.floor(enemy.crystals * getKoganeBonus(player).crystal);
    session.totalXp += xpGain;
    session.totalCrystals += crGain;
    session.kills++;
    session.wave++;
    updateQuestProgress(player, "culling_wave", 1);
    if (player.cullingBest < session.wave - 1) { player.cullingBest = session.wave - 1; }
    const drops = rollDrops(enemy.id||"e1");
    addMaterials(player, drops);
    log.push(`> ✅ ${enemy.emoji} **${enemy.name}** 처치! XP+**${xpGain}** 💎+**${crGain}**`);
    if (Object.keys(drops).length) log.push(`> 📦 ${formatDrops(drops)}`);
    if (!player.mastery) player.mastery = {};
    player.mastery[player.active] = (player.mastery[player.active]||0) + (enemy.masteryXp||1);
    if (Math.random() < 0.25) { player.potion = (player.potion||0) + 1; log.push(`> 🧪 회복약 +1!`); }
    const nextEnemy = pickCullingEnemy(session.wave);
    session.currentEnemy = { ...nextEnemy, hp:nextEnemy.hp, currentHp:nextEnemy.hp, statusEffects:[] };
    session.enemyHp = session.currentEnemy.hp;
    log.push(`> 🌊 **WAVE ${session.wave}** — ${session.currentEnemy.emoji} **${session.currentEnemy.name}** 등장!`);
    const waveHeal = Math.floor(stats.maxHp * 0.10);
    player.hp = Math.min(stats.maxHp, (player.hp||0) + waveHeal);
    log.push(`> 💚 웨이브 보너스 HP +${waveHeal}`);
    regenStamina(player);
    savePlayer(player.id);
    if (shouldTriggerVerify(player) && !isVerifyPending(player.id)) {
      const code = generateVerifyCode();
      antiBotVerify.set(player.id, { code, timestamp:Date.now(), pending:true });
      await interaction.update({ embeds:[cullingEmbed(player, session, log)], components:[] });
      return interaction.followUp({ content:`🔒 **매크로 방지 인증!** 코드를 채팅창에 입력 (30초):\n\`\`\`\n${code}\n\`\`\``, ephemeral:true });
    }
    return interaction.update({ embeds:[cullingEmbed(player, session, log)], components:mkCullingButtons(player) });
  }

  {
    const enemy = session.currentEnemy;
    const eTick2 = tickStatus(player, stats.maxHp);
    if (!rollHit(enemy.statusEffects||[], player.statusEffects||[])) {
      log.push(`> ↩️ **${enemy.name}**의 공격 빗나감!`);
    } else {
      const eDmg = calcDmg(enemy.atk, stats.def);
      player.hp = Math.max(0, (player.hp||0) - eDmg);
      log.push(`> 💢 **${enemy.name}** 반격! **${eDmg}** 피해!`);
      if (enemy.statusAttack && Math.random() < (enemy.statusAttack.chance||0.25)) {
        applyStatus(player, enemy.statusAttack.statusId);
        const sdef = STATUS_EFFECTS[enemy.statusAttack.statusId];
        if (sdef) log.push(`> ${sdef.emoji} **${sdef.name}** 상태이상!`);
      }
    }
  }

  if ((player.hp||0) <= 0) {
    player.hp = 0;
    player.losses = (player.losses||0) + 1;
    player.statusEffects = [];
    player.skillCooldown = 0;
    player.domainCooldown = 0;
    player.reverseCooldown = 0;
    player.xp = (player.xp||0) + session.totalXp;
    player.crystals = (player.crystals||0) + session.totalCrystals;
    player.battleTurns = 0;
    delete cullings[player.id];
    savePlayer(player.id);
    return interaction.update({ embeds:[new EmbedBuilder().setColor(0xe63946).setTitle(`💀 컬링 게임 종료 — WAVE ${session.wave - 1}`).setDescription(log.join("\n")).addFields({name:"📊 결과",value:`> 🌊 최고 웨이브: **${session.wave - 1}**\n> ⭐ XP: **+${session.totalXp}** | 💎: **+${session.totalCrystals}**\n> 🏆 최고기록: **WAVE ${player.cullingBest||0}**`})], components:[] });
  }

  regenStamina(player);
  savePlayer(player.id);
  if (shouldTriggerVerify(player) && !isVerifyPending(player.id)) {
    const code = generateVerifyCode();
    antiBotVerify.set(player.id, { code, timestamp:Date.now(), pending:true });
    await interaction.update({ embeds:[cullingEmbed(player, session, log)], components:[] });
    return interaction.followUp({ content:`🔒 **매크로 방지 인증!** 코드를 채팅창에 입력 (30초):\n\`\`\`\n${code}\n\`\`\``, ephemeral:true });
  }
  return interaction.update({ embeds:[cullingEmbed(player, session, log)], components:mkCullingButtons(player) });
}

// ════════════════════════════════════════════════════════
// 사멸회유 액션 핸들러 (주력 추가)
// ════════════════════════════════════════════════════════
async function handleJujutsuAction(interaction, player, session, customId) {
  const log = [];
  const stats = getPlayerStats(player);

  if (customId === "j_escape") {
    delete jujutsus[player.id];
    player.statusEffects = [];
    player.skillCooldown = 0;
    player.domainCooldown = 0;
    player.reverseCooldown = 0;
    savePlayer(player.id);
    return interaction.update({ content:`🏳️ 사멸회유 철수! 포인트: **${session.points}**`, embeds:[], components:[] });
  }

  const tick = tickStatus(player, stats.maxHp);
  if (tick.log.length) log.push(...tick.log);
  if (session.currentEnemy) {
    const eTick = tickStatus(session.currentEnemy, session.currentEnemy.hp);
    if (eTick.log.length) log.push(...eTick.log.map(l=>l+"[적]"));
  }

  if (customId === "j_reverse") {
    if (!REVERSE_CHARS.has(player.active)) return interaction.reply({ content:"❌ 반전술식 불가!", ephemeral:true });
    if ((player.reverseCooldown||0) > 0) return interaction.reply({ content:`♻️ 쿨타임 ${player.reverseCooldown}턴!`, ephemeral:true });
    if (!consumeStamina(player, STAMINA_COST_REVERSE)) return interaction.reply({ content:`💪 주력 부족! (필요: ${STAMINA_COST_REVERSE})`, ephemeral:true });
    const heal = Math.floor(stats.maxHp * 0.35);
    player.hp = Math.min(stats.maxHp, (player.hp||0) + heal);
    player.reverseCooldown = 3;
    log.push(`> ♻️ **반전술식** — HP **+${heal}**!`);
    tickCooldowns(player);
    regenStamina(player);
    savePlayer(player.id);
    return interaction.update({ embeds:[jujutsuEmbed(player,session,log)], components:mkJujutsuButtons(player,[]) });
  }

  if (!session.currentEnemy) {
    const choices = generateJujutsuChoices(session.wave);
    session.choices = choices;
    return interaction.update({ embeds:[jujutsuEmbed(player,session,log,choices)], components:mkJujutsuButtons(player,choices) });
  }

  if (isIncapacitated(player.statusEffects||[])) {
    log.push(`> ⚡ 상태이상으로 행동 불가!`);
    tickCooldowns(player);
  } else if (customId === "j_attack") {
    if (!rollHit(player.statusEffects||[], session.currentEnemy.statusEffects||[])) {
      log.push(`> 🌀 공격 빗나감!`);
    } else {
      const bf = isBlackFlash();
      const { dmg, isCrit } = calcDmgForPlayer(player, session.currentEnemy.def, bf ? 2.5 : 1.0);
      session.enemyHp = Math.max(0, session.enemyHp - dmg);
      session.currentEnemy.hp = session.enemyHp;
      if (bf) { log.push(getBlackFlashArt()); log.push(`> ⚫ **흑섬!!** **${dmg}** 피해!`); player.crystals += 50; }
      else log.push(`> ⚔️ 공격! **${dmg}** 피해!${isCrit?" 💥**CRITICAL!**":""}`);
    }
    tickCooldowns(player);
  } else if (customId === "j_skill") {
    if ((player.skillCooldown||0) > 0) return interaction.reply({ content:`⚡ 쿨타임 ${player.skillCooldown}턴!`, ephemeral:true });
    if (!consumeStamina(player, STAMINA_COST_SKILL)) return interaction.reply({ content:`💪 주력 부족! (필요: ${STAMINA_COST_SKILL})`, ephemeral:true });
    const skill = getCurrentSkill(player, player.active);
    const fx = getSkillEffect(skill.name);
    const { dmg, isCrit } = calcSkillDmgForPlayer(player, skill.dmg);
    session.enemyHp = Math.max(0, session.enemyHp - dmg);
    session.currentEnemy.hp = session.enemyHp;
    log.push(fx.art);
    log.push(`> 🌀 **${skill.name}** — **${dmg}** 피해!${isCrit?" 💥**CRITICAL!**":""}`);
    const sm = applySkillStatus(skill, session.currentEnemy, player);
    if (sm.length) log.push(...sm);
    player.skillCooldown = 5;
    updateQuestProgress(player, "skill_use", 1);
    tickCooldowns(player);
  } else if (customId === "j_domain") {
    if (!canUseDomain(player)) return interaction.reply({ content:`🌌 쿨타임 ${player.domainCooldown}턴!`, ephemeral:true });
    const ch = CHARACTERS[player.active];
    if (!ch?.domain) return interaction.reply({ content:"❌ 영역전개 없음", ephemeral:true });
    if (!consumeStamina(player, STAMINA_COST_DOMAIN)) return interaction.reply({ content:`💪 주력 부족! (필요: ${STAMINA_COST_DOMAIN})`, ephemeral:true });
    const dr = applyDomainExpansion(stats, ch.domain, session.currentEnemy, true);
    session.enemyHp = session.currentEnemy.hp;
    log.push(...dr.log);
    player.domainCooldown = 15;
    tickCooldowns(player);
  }

  if (session.enemyHp <= 0) {
    const enemy = session.currentEnemy;
    const xpGain = Math.floor(enemy.xp * getKoganeBonus(player).xp);
    const crGain = Math.floor(enemy.crystals * getKoganeBonus(player).crystal);
    session.totalXp += xpGain;
    session.totalCrystals += crGain;
    session.points += enemy.points||1;
    session.wave++;
    if (!player.mastery) player.mastery = {};
    player.mastery[player.active] = (player.mastery[player.active]||0) + (enemy.masteryXp||1);
    const drops = rollDrops(enemy.id||"j1", true);
    addMaterials(player, drops);
    log.push(`> ✅ **${enemy.name}** 처치! +${enemy.points}점! XP+**${xpGain}**`);
    if (Object.keys(drops).length) log.push(`> 📦 ${formatDrops(drops)}`);
    updateQuestProgress(player, "jujutsu_point", enemy.points||1);
    if ((enemy.id||"j1") === "j5"||enemy.id==="j6") updateQuestProgress(player, "boss_kill", 1);
    if (session.points >= 15) {
      player.xp = (player.xp||0) + session.totalXp + 500;
      player.crystals = (player.crystals||0) + session.totalCrystals + 300;
      if (session.points > (player.jujutsuBest||0)) player.jujutsuBest = session.points;
      player.statusEffects = [];
      player.skillCooldown = 0;
      player.domainCooldown = 0;
      player.reverseCooldown = 0;
      player.battleTurns = 0;
      delete jujutsus[player.id];
      savePlayer(player.id);
      return interaction.update({ embeds:[new EmbedBuilder().setColor(0xF5C842).setTitle("🏆 사멸회유 목표 달성!").setDescription(`> 🎉 15포인트 달성 보너스!\n> ⭐ XP **+${session.totalXp + 500}** | 💎 **+${session.totalCrystals + 300}**\n> 🏆 최고기록 갱신: **${session.points}pt**`)], components:[] });
    }
    if (session.points > (player.jujutsuBest||0)) player.jujutsuBest = session.points;
    const wHeal = Math.floor(stats.maxHp * 0.08);
    player.hp = Math.min(stats.maxHp, (player.hp||0) + wHeal);
    session.currentEnemy = null;
    session.enemyHp = 0;
    session.choices = null;
    regenStamina(player);
    savePlayer(player.id);
    const choices = generateJujutsuChoices(session.wave);
    session.choices = choices;
    return interaction.update({ embeds:[jujutsuEmbed(player,session,log,choices)], components:mkJujutsuButtons(player,choices) });
  }

  if (session.currentEnemy) {
    const enemy = session.currentEnemy;
    if (!rollHit(enemy.statusEffects||[], player.statusEffects||[])) {
      log.push(`> ↩️ **${enemy.name}** 빗나감!`);
    } else {
      const eDmg = calcDmg(enemy.atk, stats.def);
      player.hp = Math.max(0, (player.hp||0) - eDmg);
      log.push(`> 💢 **${enemy.name}** 반격! **${eDmg}** 피해!`);
      if (enemy.statusAttack && Math.random() < (enemy.statusAttack.chance||0.25)) {
        applyStatus(player, enemy.statusAttack.statusId);
        const sdef = STATUS_EFFECTS[enemy.statusAttack.statusId];
        if (sdef) log.push(`> ${sdef.emoji} **${sdef.name}** 상태이상!`);
      }
    }
  }

  if ((player.hp||0) <= 0) {
    player.hp = 0;
    player.losses = (player.losses||0) + 1;
    player.statusEffects = [];
    player.skillCooldown = 0;
    player.domainCooldown = 0;
    player.reverseCooldown = 0;
    player.xp = (player.xp||0) + session.totalXp;
    player.crystals = (player.crystals||0) + session.totalCrystals;
    if (session.points > (player.jujutsuBest||0)) player.jujutsuBest = session.points;
    player.battleTurns = 0;
    delete jujutsus[player.id];
    savePlayer(player.id);
    return interaction.update({ embeds:[new EmbedBuilder().setColor(0xe63946).setTitle(`💀 사멸회유 종료 — ${session.points}포인트`).setDescription(log.join("\n")).addFields({name:"📊 결과",value:`> 🎯 포인트: **${session.points}**\n> ⭐ XP: **+${session.totalXp}** | 💎: **+${session.totalCrystals}**\n> 🏆 최고기록: **${player.jujutsuBest||0}pt**`})], components:[] });
  }

  regenStamina(player);
  savePlayer(player.id);
  if (shouldTriggerVerify(player) && !isVerifyPending(player.id)) {
    const code = generateVerifyCode();
    antiBotVerify.set(player.id, { code, timestamp:Date.now(), pending:true });
    await interaction.update({ embeds:[jujutsuEmbed(player,session,log)], components:[] });
    return interaction.followUp({ content:`🔒 **매크로 방지 인증!** 코드를 채팅창에 입력 (30초):\n\`\`\`\n${code}\n\`\`\``, ephemeral:true });
  }
  return interaction.update({ embeds:[jujutsuEmbed(player,session,log)], components:mkJujutsuButtons(player,[]) });
}

// ════════════════════════════════════════════════════════
// PvP 액션 핸들러 (주력 추가)
// ════════════════════════════════════════════════════════
async function handlePvpAction(interaction, player, session, customId) {
  const log = [];
  const self = pvpSelf(session, player.id);
  const opp = pvpOpponent(session, player.id);
  const oppPlayer = players[opp.id];
  if (!oppPlayer) return interaction.reply({ content:"❌ 상대방 정보 없음", ephemeral:true });

  const selfStats = getPlayerStats(player);
  const oppStats = getPlayerStats(oppPlayer);

  {
    const se = session[self.statusKey] || [];
    const maxHp = session[self.hpKey + "max"] || selfStats.maxHp;
    let totalDot = 0;
    const newSe = [];
    for (const s of se) {
      const def = STATUS_EFFECTS[s.id];
      if (!def) continue;
      if (s.id === "poison")       { const d = Math.min(Math.max(1,Math.floor(selfStats.maxHp*0.05)),120); totalDot+=d; log.push(`> ☠️ **독** — **${d}** 피해!`); }
      if (s.id === "burn")         { const d = Math.min(Math.max(1,Math.floor(selfStats.maxHp*0.07)),180); totalDot+=d; log.push(`> 🔥 **화상** — **${d}** 피해!`); }
      if (s.id === "cursed_wound") { const d = Math.min(Math.max(1,Math.floor(selfStats.maxHp*0.09)),220); totalDot+=d; log.push(`> 🩸 **저주상처** — **${d}** 피해!`); }
      if (s.id === "dotBleed")     { const d = Math.min(Math.max(1,Math.floor(selfStats.maxHp*0.06)),150); totalDot+=d; log.push(`> 💧 **지속출혈** — **${d}** 피해!`); }
      s.turns--;
      if (s.turns > 0) newSe.push(s);
    }
    session[self.statusKey] = newSe;
    if (totalDot > 0) session[self.hpKey] = Math.max(0, session[self.hpKey] - totalDot);
  }

  if (customId === "pvp_surrender") {
    const oppPlayer2 = players[opp.id];
    if (oppPlayer2) {
      oppPlayer2.pvpWins = (oppPlayer2.pvpWins||0) + 1;
      oppPlayer2.crystals = (oppPlayer2.crystals||0) + 200;
      updateQuestProgress(oppPlayer2, "pvp_win", 1);
      savePlayer(opp.id);
    }
    player.pvpLosses = (player.pvpLosses||0) + 1;
    savePlayer(player.id);
    delete pvpSessions[session.id];
    return interaction.update({ embeds:[new EmbedBuilder().setColor(0xe63946).setTitle("🏳️ 항복").setDescription(`> **${player.name}** 이(가) 항복!\n> **${oppPlayer?.name||"상대"}** 승리! +200💎`)], components:[] });
  }

  if (customId === "pvp_reverse") {
    if (!REVERSE_CHARS.has(player.active)) return interaction.reply({ content:"❌ 반전술식 불가!", ephemeral:true });
    if ((session[self.reverseCdKey]||0) > 0) return interaction.reply({ content:`♻️ 쿨타임 ${session[self.reverseCdKey]}턴!`, ephemeral:true });
    if (session[self.staminaKey] < STAMINA_COST_REVERSE) return interaction.reply({ content:`💪 주력 부족! (필요: ${STAMINA_COST_REVERSE})`, ephemeral:true });
    session[self.staminaKey] -= STAMINA_COST_REVERSE;
    const heal = Math.floor(selfStats.maxHp * 0.35);
    session[self.hpKey] = Math.min(selfStats.maxHp, session[self.hpKey] + heal);
    session[self.reverseCdKey] = 3;
    log.push(`> ♻️ **${player.name}** 반전술식 — HP **+${heal}**!`);
    session.turn = opp.id;
    session.round++;
    if ((session[self.skillCdKey]||0) > 0) session[self.skillCdKey]--;
    if ((session[self.domainCdKey]||0) > 0) session[self.domainCdKey]--;
    if (session[self.reverseCdKey] > 0) session[self.reverseCdKey]--;
    session[self.staminaKey] = Math.min(STAMINA_MAX_BASE, session[self.staminaKey] + STAMINA_REGEN);
    savePlayer(player.id);
    const oppCh = interaction.channel || interaction.message?.channel;
    return interaction.update({ embeds:[pvpEmbed(session,log)], components:[] }).then(async()=>{
      if (interaction.channel) {
        await interaction.channel.send({ content:`<@${opp.id}> 당신의 차례입니다! ⚔️`, embeds:[pvpEmbed(session,log)], components:[mkPvpButtons(session,opp.id)] }).catch(()=>{});
      }
    });
  }

  if (isIncapacitated(session[self.statusKey]||[])) {
    log.push(`> ⚡ **${player.name}** 상태이상으로 행동 불가!`);
    session.turn = opp.id;
    session.round++;
    return interaction.update({ embeds:[pvpEmbed(session,log)], components:[] }).then(async()=>{
      if (interaction.channel) await interaction.channel.send({ content:`<@${opp.id}> 당신의 차례!`, embeds:[pvpEmbed(session,log)], components:[mkPvpButtons(session,opp.id)] }).catch(()=>{});
    });
  }

  if (customId === "pvp_atk") {
    if (!rollHit(session[self.statusKey]||[], session[opp.statusKey]||[])) {
      log.push(`> 🌀 **${player.name}** 공격 빗나감!`);
    } else {
      const bf = isBlackFlash();
      const oppDefVal = oppStats.def;
      const { dmg, isCrit } = calcDmgForPlayer(player, oppDefVal, bf ? 2.5 : 1.0);
      session[opp.hpKey] = Math.max(0, session[opp.hpKey] - dmg);
      if (bf) { log.push(getBlackFlashArt()); log.push(`> ⚫ **흑섬!!** **${dmg}** 피해!`); }
      else log.push(`> ⚔️ **${player.name}** 공격! **${dmg}** 피해!${isCrit?" 💥**CRITICAL!**":""}`);
    }
  } else if (customId === "pvp_skill") {
    if ((session[self.skillCdKey]||0) > 0) return interaction.reply({ content:`⚡ 쿨타임 ${session[self.skillCdKey]}턴!`, ephemeral:true });
    if (session[self.staminaKey] < STAMINA_COST_SKILL) return interaction.reply({ content:`💪 주력 부족! (필요: ${STAMINA_COST_SKILL})`, ephemeral:true });
    session[self.staminaKey] -= STAMINA_COST_SKILL;
    const skill = getCurrentSkill(player, player.active);
    const fx = getSkillEffect(skill.name);
    const { dmg, isCrit } = calcSkillDmgForPlayer(player, skill.dmg);
    session[opp.hpKey] = Math.max(0, session[opp.hpKey] - dmg);
    log.push(fx.art);
    log.push(`> 🌀 **${player.name}** — **${skill.name}** **${dmg}** 피해!${isCrit?" 💥**CRITICAL!**":""}`);
    if (skill.statusApply && skill.statusApply.target === "enemy" && Math.random() < skill.statusApply.chance) {
      const newSe = [...(session[opp.statusKey]||[])];
      const def = STATUS_EFFECTS[skill.statusApply.statusId];
      const existing = newSe.find(s=>s.id===skill.statusApply.statusId);
      if (existing) existing.turns = def?.duration||2;
      else newSe.push({id:skill.statusApply.statusId, turns:def?.duration||2});
      session[opp.statusKey] = newSe;
      if (def) log.push(`> ${def.emoji} **${def.name}** 부여! (${def.duration}턴)`);
    }
    session[self.skillCdKey] = 5;
  } else if (customId === "pvp_domain") {
    if ((session[self.domainCdKey]||0) > 0) return interaction.reply({ content:`🌌 영역전개 쿨타임 ${session[self.domainCdKey]}턴!`, ephemeral:true });
    const ch = CHARACTERS[player.active];
    if (!ch?.domain) return interaction.reply({ content:"❌ 영역전개 없음", ephemeral:true });
    if (session[self.staminaKey] < STAMINA_COST_DOMAIN) return interaction.reply({ content:`💪 주력 부족! (필요: ${STAMINA_COST_DOMAIN})`, ephemeral:true });
    session[self.staminaKey] -= STAMINA_COST_DOMAIN;
    const tempDef = { hp: session[opp.hpKey], statusEffects: session[opp.statusKey]||[] };
    const dr = applyDomainExpansion(selfStats, ch.domain, tempDef, false);
    session[opp.hpKey] = Math.max(0, session[opp.hpKey] - dr.dmg);
    session[opp.statusKey] = tempDef.statusEffects;
    log.push(...dr.log);
    session[self.domainCdKey] = 15;
  }

  if ((session[self.skillCdKey]||0) > 0 && customId !== "pvp_skill") session[self.skillCdKey]--;
  if ((session[self.reverseCdKey]||0) > 0) session[self.reverseCdKey]--;
  if ((session[self.domainCdKey]||0) > 0 && customId !== "pvp_domain") session[self.domainCdKey]--;
  session[self.staminaKey] = Math.min(STAMINA_MAX_BASE, (session[self.staminaKey]||STAMINA_MAX_BASE) + STAMINA_REGEN);
  session[opp.staminaKey] = Math.min(STAMINA_MAX_BASE, (session[opp.staminaKey]||STAMINA_MAX_BASE) + STAMINA_REGEN);

  if (session[opp.hpKey] <= 0) {
    player.pvpWins = (player.pvpWins||0) + 1;
    player.crystals = (player.crystals||0) + 300;
    player.xp = (player.xp||0) + 500;
    oppPlayer.pvpLosses = (oppPlayer.pvpLosses||0) + 1;
    updateQuestProgress(player, "pvp_win", 1);
    savePlayer(player.id);
    savePlayer(opp.id);
    delete pvpSessions[session.id];
    return interaction.update({ embeds:[new EmbedBuilder().setColor(0xF5C842).setTitle(`⚔️ PvP 결투 결과`).setDescription(log.join("\n")+`\n\n> 🏆 **${player.name}** 승리! +300💎 +500XP`)], components:[] });
  }
  if (session[self.hpKey] <= 0) {
    oppPlayer.pvpWins = (oppPlayer.pvpWins||0) + 1;
    oppPlayer.crystals = (oppPlayer.crystals||0) + 300;
    oppPlayer.xp = (oppPlayer.xp||0) + 500;
    player.pvpLosses = (player.pvpLosses||0) + 1;
    updateQuestProgress(oppPlayer, "pvp_win", 1);
    savePlayer(player.id);
    savePlayer(opp.id);
    delete pvpSessions[session.id];
    return interaction.update({ embeds:[new EmbedBuilder().setColor(0xe63946).setTitle(`⚔️ PvP 결투 결과`).setDescription(log.join("\n")+`\n\n> 💀 **${player.name}** 패배!\n> 🏆 **${oppPlayer.name}** 승리! +300💎 +500XP`)], components:[] });
  }

  session.turn = opp.id;
  session.round++;
  savePlayer(player.id);
  await interaction.update({ embeds:[pvpEmbed(session,log)], components:[] });
  if (interaction.channel) {
    await interaction.channel.send({ content:`<@${opp.id}> 당신의 차례! (Round ${session.round})`, embeds:[pvpEmbed(session,log)], components:[mkPvpButtons(session,opp.id)] }).catch(()=>{});
  }
}

// ════════════════════════════════════════════════════════
// 레이드 액션 핸들러 (주력 추가)
// ════════════════════════════════════════════════════════
async function handleRaidAction(interaction, player, raidSession, customId) {
  const log = [];
  const boss = RAID_BOSSES[raidSession.bossId];
  if (!boss) return interaction.reply({ content:"❌ 레이드 보스 없음", ephemeral:true });
  const stats = getPlayerStats(player);

  if (customId === "r_retreat") {
    raidSession.members = raidSession.members.filter(uid => uid !== player.id);
    if (raidSession.members.length === 0) {
      delete raidSessions[raidSession.id];
    }
    player.statusEffects = [];
    player.skillCooldown = 0;
    player.domainCooldown = 0;
    player.reverseCooldown = 0;
    savePlayer(player.id);
    return interaction.update({ content:`🏳️ 레이드 철수!`, embeds:[], components:[] });
  }

  const tick = tickStatus(player, stats.maxHp);
  if (tick.log.length) log.push(...tick.log.map(l=>`[${player.name}] ${l}`));

  if (boss.adaptationSkill && raidSession.adaptedSkills) {
    const skill = customId === "r_skill" ? getCurrentSkill(player, player.active) : null;
    if (skill && raidSession.adaptedSkills.includes(skill.name)) {
      log.push(`> 🔄 **마허라가라** 가 **${skill.name}** 에 이미 적응! 효과 없음!`);
      tickCooldowns(player);
      await doRaidBossAttack(player, raidSession, boss, log);
      regenStamina(player);
      if ((player.hp||0) <= 0) {
        player.hp = 0;
        player.statusEffects = [];
        log.push(`> 💀 **${player.name}** 전투 불능!`);
        raidSession.members = raidSession.members.filter(uid => uid !== player.id);
        savePlayer(player.id);
      }
      if (raidSession.hp <= 0) {
        return await processRaidWin(interaction, raidSession, boss, log);
      }
      if (raidSession.members.length === 0) {
        delete raidSessions[raidSession.id];
        return interaction.update({ embeds:[new EmbedBuilder().setColor(0xe63946).setTitle("💀 레이드 실패").setDescription(log.join("\n"))], components:[] });
      }
      return interaction.update({ embeds:[raidEmbed(raidSession,log)], components:mkRaidButtons(player) });
    }
    if (skill && !raidSession.adaptedSkills.includes(skill.name)) {
      if (Math.random() < 0.30) {
        raidSession.adaptedSkills.push(skill.name);
        log.push(`> 🔄 **마허라가라** 가 **${skill.name}** 에 적응! 앞으로 무효화!`);
      }
    }
  }

  if (isIncapacitated(player.statusEffects||[])) {
    log.push(`> ⚡ **${player.name}** 상태이상으로 행동 불가!`);
    tickCooldowns(player);
  } else if (customId === "r_attack") {
    const bf = isBlackFlash();
    const { dmg, isCrit } = calcDmgForPlayer(player, boss.def, bf ? 2.5 : 1.0);
    raidSession.hp = Math.max(0, raidSession.hp - dmg);
    if (bf) { log.push(getBlackFlashArt()); log.push(`> ⚫ **[${player.name}] 흑섬!!** **${dmg}** 피해!`); player.crystals += 50; }
    else log.push(`> ⚔️ **[${player.name}]** 공격! **${dmg}** 피해!${isCrit?" 💥**CRITICAL!**":""}`);
    tickCooldowns(player);
  } else if (customId === "r_skill") {
    if ((player.skillCooldown||0) > 0) return interaction.reply({ content:`⚡ 쿨타임 ${player.skillCooldown}턴!`, ephemeral:true });
    if (!consumeStamina(player, STAMINA_COST_SKILL)) return interaction.reply({ content:`💪 주력 부족! (필요: ${STAMINA_COST_SKILL})`, ephemeral:true });
    const skill = getCurrentSkill(player, player.active);
    const fx = getSkillEffect(skill.name);
    const { dmg, isCrit } = calcSkillDmgForPlayer(player, skill.dmg);
    raidSession.hp = Math.max(0, raidSession.hp - dmg);
    log.push(fx.art);
    log.push(`> 🌀 **[${player.name}] ${skill.name}** — **${dmg}** 피해!${isCrit?" 💥**CRITICAL!**":""}`);
    player.skillCooldown = 5;
    updateQuestProgress(player, "skill_use", 1);
    tickCooldowns(player);
  } else if (customId === "r_domain") {
    if (!canUseDomain(player)) return interaction.reply({ content:`🌌 쿨타임 ${player.domainCooldown}턴!`, ephemeral:true });
    const ch = CHARACTERS[player.active];
    if (!ch?.domain) return interaction.reply({ content:"❌ 영역전개 없음", ephemeral:true });
    if (!consumeStamina(player, STAMINA_COST_DOMAIN)) return interaction.reply({ content:`💪 주력 부족! (필요: ${STAMINA_COST_DOMAIN})`, ephemeral:true });
    const tempBoss = { hp: raidSession.hp, statusEffects: [] };
    const dr = applyDomainExpansion(stats, ch.domain, tempBoss, false);
    raidSession.hp = Math.max(0, raidSession.hp - dr.dmg);
    log.push(...dr.log);
    player.domainCooldown = 15;
    tickCooldowns(player);
  }

  if (!raidSession.enraged && raidSession.hp <= Math.floor(boss.hp * (boss.phaseHp||0.5))) {
    raidSession.enraged = true;
    log.push(`> ⚠️ **${boss.name}** 분노 페이즈 돌입! ATK **${boss.enragedAtk}** 로 강화!`);
  }

  if (raidSession.hp <= 0) {
    return await processRaidWin(interaction, raidSession, boss, log);
  }

  for (const uid of raidSession.members) {
    const p = players[uid];
    if (!p || (p.hp||0) <= 0) continue;
    await doRaidBossAttack(p, raidSession, boss, log);
    if ((p.hp||0) <= 0) {
      p.hp = 0;
      p.statusEffects = [];
      log.push(`> 💀 **${p.name}** 전투 불능!`);
    }
    savePlayer(uid);
  }

  const aliveMembers = raidSession.members.filter(uid => {
    const p = players[uid];
    return p && (p.hp||0) > 0;
  });

  if (aliveMembers.length === 0) {
    for (const uid of raidSession.members) {
      const p = players[uid];
      if (p) { p.losses = (p.losses||0) + 1; p.battleTurns = 0; savePlayer(uid); }
    }
    delete raidSessions[raidSession.id];
    return interaction.update({ embeds:[new EmbedBuilder().setColor(0xe63946).setTitle("💀 레이드 실패 — 전멸").setDescription(log.join("\n")).addFields({name:"결과",value:`> 보스 잔여 HP: **${raidSession.hp}**/${boss.hp}`})], components:[] });
  }

  regenStamina(player);
  savePlayer(player.id);
  if (shouldTriggerVerify(player) && !isVerifyPending(player.id)) {
    const code = generateVerifyCode();
    antiBotVerify.set(player.id, { code, timestamp:Date.now(), pending:true });
    await interaction.update({ embeds:[raidEmbed(raidSession,log)], components:[] });
    return interaction.followUp({ content:`🔒 **매크로 방지 인증!** 코드를 채팅창에 입력 (30초):\n\`\`\`\n${code}\n\`\`\``, ephemeral:true });
  }
  return interaction.update({ embeds:[raidEmbed(raidSession,log)], components:mkRaidButtons(player) });
}

async function processRaidWin(interaction, raidSession, boss, log) {
  const drops = rollDrops(boss.dropKey||"raid_heian");
  log.push(`> 🏆 **${boss.name}** 격파!!`);
  for (const uid of raidSession.members) {
    const p = players[uid];
    if (!p) continue;
    const kb = getKoganeBonus(p);
    const xpGain = Math.floor(boss.xp * kb.xp);
    const crGain = Math.floor(boss.crystals * kb.crystal);
    p.xp = (p.xp||0) + xpGain;
    p.crystals = (p.crystals||0) + crGain;
    if (!p.mastery) p.mastery = {};
    p.mastery[p.active] = (p.mastery[p.active]||0) + (boss.masteryXp||20);
    if (boss.fingers) {
      p.sukunaFingers = Math.min(SUKUNA_FINGER_MAX, (p.sukunaFingers||0) + boss.fingers);
      if (p.sukunaFingers >= 1 && !(p.owned||[]).includes("sukuna")) {
        if (!p.owned) p.owned = ["itadori"];
        p.owned.push("sukuna");
        if (!p.mastery["sukuna"]) p.mastery["sukuna"] = 0;
      }
    }
    addMaterials(p, drops);
    if (!p.raidClears) p.raidClears = {};
    p.raidClears[raidSession.bossId] = (p.raidClears[raidSession.bossId]||0) + 1;
    p.statusEffects = [];
    p.skillCooldown = 0;
    p.domainCooldown = 0;
    p.reverseCooldown = 0;
    p.battleTurns = 0;
    log.push(`> ${p.name}: XP+**${xpGain}** 💎+**${crGain}**`);
    savePlayer(uid);
  }
  delete raidSessions[raidSession.id];
  return interaction.update({ embeds:[new EmbedBuilder().setColor(boss.color||0xF5C842).setTitle(`🏆 레이드 클리어! — ${boss.name}`).setDescription(log.join("\n")).addFields({name:"📦 드롭",value:formatDrops(drops)||"없음"})], components:[] });
}

// ════════════════════════════════════════════════════════
// 파티 컬링 액션 핸들러 (주력 추가)
// ════════════════════════════════════════════════════════
async function handlePartyCullingAction(interaction, player, session, customId) {
  const party = getParty(player.id);
  if (!party) return interaction.reply({ content:"❌ 파티 없음", ephemeral:true });
  const log = [];
  const stats = getPlayerStats(player);

  if (customId === "pc_escape") {
    for (const uid of party.members) {
      const p = players[uid];
      if (!p) continue;
      p.statusEffects = [];
      p.skillCooldown = 0;
      p.domainCooldown = 0;
      savePlayer(uid);
    }
    delete cullings[party.id];
    return interaction.update({ content:`🏳️ 파티 컬링 철수! WAVE **${session.wave - 1}**`, embeds:[], components:[] });
  }

  const tick = tickStatus(player, stats.maxHp);
  if (tick.log.length) log.push(...tick.log.map(l=>`[${player.name}]${l}`));
  const eTick = tickStatus(session.currentEnemy, session.currentEnemy.hp);
  if (eTick.log.length) log.push(...eTick.log.map(l=>l+"[적]"));

  if (isIncapacitated(player.statusEffects||[])) {
    log.push(`> ⚡ **${player.name}** 상태이상!`);
    tickCooldowns(player);
  } else if (customId === "pc_attack") {
    const bf = isBlackFlash();
    const { dmg, isCrit } = calcDmgForPlayer(player, session.currentEnemy.def, bf ? 2.5 : 1.0);
    session.enemyHp = Math.max(0, session.enemyHp - dmg);
    session.currentEnemy.hp = session.enemyHp;
    if (bf) { log.push(getBlackFlashArt()); log.push(`> ⚫ **[${player.name}] 흑섬!!** **${dmg}** 피해!`); player.crystals += 50; }
    else log.push(`> ⚔️ **[${player.name}]** 공격! **${dmg}** 피해!${isCrit?" 💥**CRITICAL!**":""}`);
    tickCooldowns(player);
  } else if (customId === "pc_skill") {
    if ((player.skillCooldown||0) > 0) return interaction.reply({ content:`⚡ 쿨타임 ${player.skillCooldown}턴!`, ephemeral:true });
    if (!consumeStamina(player, STAMINA_COST_SKILL)) return interaction.reply({ content:`💪 주력 부족! (필요: ${STAMINA_COST_SKILL})`, ephemeral:true });
    const skill = getCurrentSkill(player, player.active);
    const fx = getSkillEffect(skill.name);
    const { dmg, isCrit } = calcSkillDmgForPlayer(player, skill.dmg);
    session.enemyHp = Math.max(0, session.enemyHp - dmg);
    session.currentEnemy.hp = session.enemyHp;
    log.push(fx.art);
    log.push(`> 🌀 **[${player.name}] ${skill.name}** — **${dmg}** 피해!${isCrit?" 💥**CRITICAL!**":""}`);
    const sm = applySkillStatus(skill, session.currentEnemy, player);
    if (sm.length) log.push(...sm);
    player.skillCooldown = 5;
    tickCooldowns(player);
  }

  if (session.enemyHp <= 0) {
    const enemy = session.currentEnemy;
    session.kills++;
    session.wave++;
    updateQuestProgress(player, "culling_wave", 1);
    const drops = rollDrops(enemy.id||"e1");
    for (const uid of party.members) {
      const p = players[uid];
      if (!p) continue;
      const kb = getKoganeBonus(p);
      const xp = Math.floor(enemy.xp * kb.xp);
      const cr = Math.floor(enemy.crystals * kb.crystal);
      p.xp = (p.xp||0) + xp;
      p.crystals = (p.crystals||0) + cr;
      if (!p.mastery) p.mastery = {};
      p.mastery[p.active] = (p.mastery[p.active]||0) + (enemy.masteryXp||1);
      if (p.cullingBest < session.wave - 1) p.cullingBest = session.wave - 1;
      addMaterials(p, drops);
      const wHeal = Math.floor(getPlayerStats(p).maxHp * 0.10);
      p.hp = Math.min(getPlayerStats(p).maxHp, (p.hp||0) + wHeal);
      p.stamina = Math.min(STAMINA_MAX_BASE, (p.stamina||STAMINA_MAX_BASE) + STAMINA_REGEN);
      savePlayer(uid);
    }
    log.push(`> ✅ **${enemy.name}** 처치! WAVE **${session.wave}** 시작!`);
    if (Object.keys(drops).length) log.push(`> 📦 ${formatDrops(drops)}`);
    const nextEnemy = pickCullingEnemy(session.wave);
    session.currentEnemy = { ...nextEnemy, hp:nextEnemy.hp, currentHp:nextEnemy.hp, statusEffects:[] };
    session.enemyHp = session.currentEnemy.hp;
    log.push(`> 🌊 **WAVE ${session.wave}** — ${session.currentEnemy.emoji} **${session.currentEnemy.name}**!`);
    return interaction.update({ embeds:[partyCullingEmbed(party,session,log)], components:mkPartyCullingButtons(player) });
  }

  for (const uid of party.members) {
    const p = players[uid];
    if (!p || (p.hp||0) <= 0) continue;
    const ps = getPlayerStats(p);
    const eDmg = calcDmg(session.currentEnemy.atk, ps.def);
    p.hp = Math.max(0, (p.hp||0) - eDmg);
    if (session.currentEnemy.statusAttack && Math.random() < 0.15) {
      applyStatus(p, session.currentEnemy.statusAttack.statusId);
    }
    log.push(`> 💢 **${session.currentEnemy.name}** → **${p.name}** **${eDmg}** 피해!`);
    savePlayer(uid);
  }

  const alive = party.members.filter(uid => (players[uid]?.hp||0) > 0);
  if (alive.length === 0) {
    for (const uid of party.members) {
      const p = players[uid];
      if (!p) continue;
      p.losses = (p.losses||0) + 1;
      p.statusEffects = [];
      p.skillCooldown = 0;
      p.domainCooldown = 0;
      p.battleTurns = 0;
      savePlayer(uid);
    }
    delete cullings[party.id];
    return interaction.update({ embeds:[new EmbedBuilder().setColor(0xe63946).setTitle(`💀 파티 컬링 종료 — WAVE ${session.wave - 1}`).setDescription(log.join("\n"))], components:[] });
  }

  regenStamina(player);
  savePlayer(player.id);
  return interaction.update({ embeds:[partyCullingEmbed(party,session,log)], components:mkPartyCullingButtons(player) });
}

function mkPartyCullingButtons(player) {
  const canSkill = (player.skillCooldown||0) <= 0;
  const skillName = getCurrentSkill(player, player.active)?.name||"술식";
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("pc_attack").setLabel("⚔️ 공격").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("pc_skill").setLabel(`🌀 ${skillName}`).setStyle(ButtonStyle.Primary).setDisabled(!canSkill),
    new ButtonBuilder().setCustomId("pc_escape").setLabel("🏳️ 철수").setStyle(ButtonStyle.Secondary),
  );
}

// ════════════════════════════════════════════════════════
// 슬래시 커맨드 처리 (주력 표시 추가)
// ════════════════════════════════════════════════════════
async function handleSlashCommand(interaction, commandName, player, userId, user) {
  if (commandName === "프로필") {
    await interaction.deferReply();
    try {
      const gifBuf = await generateProfileGif(player, user);
      const att = new AttachmentBuilder(gifBuf, { name:"profile.gif" });
      return interaction.editReply({ files:[att], embeds:[profileEmbed(player)] });
    } catch(e) {
      console.error("[프로필 GIF 오류]", e.message);
      return interaction.editReply({ embeds:[profileEmbed(player)] });
    }
  }

  if (commandName === "술식") {
    return interaction.reply({ embeds:[buildSkillEmbed(player)] });
  }

  if (commandName === "도감") {
    const owned = player.owned || ["itadori"];
    const lines = owned.map(id => {
      const ch = CHARACTERS[id]; if (!ch) return "";
      const ri = GACHA_RARITY[ch.grade]||GACHA_RARITY["3급"];
      const mastery = getMastery(player, id);
      const isActive = id === player.active;
      const tmpStats = getPlayerStats({...player, active:id});
      return `> ${isActive?"▶️ **[활성]**":"　"}${ch.emoji} **${ch.name}** \`[${ch.grade}]\` ${ri.stars}\n> 숙련 \`${mastery}\` | ATK \`${tmpStats.atk}\` DEF \`${tmpStats.def}\` HP \`${tmpStats.maxHp}\`\n> *"${ch.lore||ch.desc}"*`;
    }).filter(Boolean).join("\n\n");
    return interaction.reply({ embeds:[new EmbedBuilder().setColor(0x7c5cfc).setTitle("🎴 보유 캐릭터 도감").setDescription(lines||"> 없음").setFooter({text:`총 ${owned.length}명 보유`})] });
  }

  if (commandName === "캐릭터") {
    return interaction.reply({
      content:"🎭 장착할 캐릭터를 선택하세요:",
      components:[mkCharSelectMenu(player)],
    });
  }

  if (commandName === "전투") {
    if (battles[userId]) return interaction.reply({ content:"❌ 이미 전투 중입니다!", ephemeral:true });
    if ((player.hp||0) <= 0) return interaction.reply({ content:"💀 HP가 0입니다! `!회복` 으로 회복하세요.", ephemeral:true });
    const stats = getPlayerStats(player);
    const roll = Math.random();
    let enemy;
    if (roll < 0.03 && (player.sukunaFingers||0) >= 1) enemy = ENEMIES.find(e=>e.isSukuna);
    else if (roll < 0.10) enemy = ENEMIES.find(e=>e.id==="e4");
    else if (roll < 0.30) enemy = ENEMIES.find(e=>e.id==="e3");
    else if (roll < 0.60) enemy = ENEMIES.find(e=>e.id==="e2");
    else enemy = ENEMIES.find(e=>e.id==="e1");
    const enemyState = {
      ...enemy,
      hp: enemy.hp,
      maxHp: enemy.hp,
      statusEffects: [],
    };
    battles[userId] = { enemyId: enemy.id, enemy: enemyState };
    const ch = CHARACTERS[player.active]||CHARACTERS["itadori"];
    const ri = GACHA_RARITY[ch.grade]||GACHA_RARITY["3급"];
    const stamina = getPlayerStamina(player);
    const startEmbed = new EmbedBuilder()
      .setColor(enemy.isSukuna?0x8b0000:JJK_GRADE_COLOR[ch.grade]||0x7c5cfc)
      .setTitle(enemy.isSukuna?`⚠️ 료멘 스쿠나 출현!!`:`⚔️ 전투 시작!`)
      .setDescription([
        enemy.isSukuna?"```ansi\n\u001b[1;31m╔══════════════════════════════════════╗\n║  🔴  料 両 面 宿 儺  출현!!  🔴    ║\n╚══════════════════════════════════════╝\n```":"",
        `> ${ch.emoji} **${ch.name}** [${ch.grade}] ${ri.stars}`,
        `> 💚 HP: **${Math.max(0,player.hp)}** / **${stats.maxHp}**`,
        `> 💪 주력: **${stamina.curr}/${stamina.max}**`,
        `> VS`,
        `> ${enemy.emoji} **${enemy.name}**  HP: **${enemy.hp}** ATK: **${enemy.atk}** DEF: **${enemy.def}**`,
      ].filter(Boolean).join("\n"));
    return interaction.reply({ embeds:[startEmbed, buildBattleEmbed(player, enemyState)], components:mkBattleButtons(player) });
  }

  if (commandName === "컬링") {
    if (cullings[userId]) return interaction.reply({ content:"❌ 이미 컬링 중!", ephemeral:true });
    if ((player.hp||0) <= 0) return interaction.reply({ content:"💀 HP 0! `!회복`으로 회복하세요.", ephemeral:true });
    const firstEnemy = pickCullingEnemy(1);
    const session = {
      wave:1, kills:0, totalXp:0, totalCrystals:0,
      currentEnemy:{ ...firstEnemy, hp:firstEnemy.hp, currentHp:firstEnemy.hp, statusEffects:[] },
      enemyHp: firstEnemy.hp,
    };
    cullings[userId] = session;
    return interaction.reply({ embeds:[cullingEmbed(player,session,[`> 🌊 **WAVE 1** 시작! ${firstEnemy.emoji} **${firstEnemy.name}** 등장!`])], components:mkCullingButtons(player) });
  }

  if (commandName === "사멸회유") {
    if (jujutsus[userId]) return interaction.reply({ content:"❌ 이미 사멸회유 중!", ephemeral:true });
    if ((player.hp||0) <= 0) return interaction.reply({ content:"💀 HP 0! `!회복`으로 회복하세요.", ephemeral:true });
    const session = { wave:1, points:0, totalXp:0, totalCrystals:0, currentEnemy:null, enemyHp:0, choices:null };
    jujutsus[userId] = session;
    const choices = generateJujutsuChoices(1);
    session.choices = choices;
    return interaction.reply({ embeds:[jujutsuEmbed(player,session,[`> 🎯 사멸회유 시작! 적을 선택하세요!`],choices)], components:mkJujutsuButtons(player,choices) });
  }

  if (commandName === "가챠") {
    const count = interaction.options.getInteger("횟수");
    if (count !== 1 && count !== 10) return interaction.reply({ content:"❌ 1 또는 10을 입력하세요.", ephemeral:true });
    const cost = count === 10 ? 1500 : 160;
    if ((player.crystals||0) < cost) return interaction.reply({ content:`❌ 크리스탈 부족! 필요: **${cost}💎** / 보유: **${player.crystals}💎**`, ephemeral:true });
    player.crystals -= cost;
    updateQuestProgress(player, "gacha_pull", count);
    if (count === 1) {
      await interaction.deferReply();
      const [charId] = rollGacha(1);
      const ch = CHARACTERS[charId];
      const isNew = !(player.owned||[]).includes(charId);
      if (isNew) {
        if (!player.owned) player.owned = ["itadori"];
        player.owned.push(charId);
        if (!player.mastery) player.mastery = {};
        if (player.mastery[charId] === undefined) player.mastery[charId] = 0;
      } else {
        player.crystals += 50;
      }
      savePlayer(userId);
      await interaction.editReply({ embeds:[gachaLoadingEmbed(1)] });
      await new Promise(r=>setTimeout(r,1200));
      await interaction.editReply({ embeds:[gachaLoadingEmbed(2)] });
      await new Promise(r=>setTimeout(r,1000));
      await interaction.editReply({ embeds:[gachaRevealEmbed(ch.grade)] });
      await new Promise(r=>setTimeout(r,1200));
      return interaction.editReply({ embeds:[gachaResultEmbed(charId, isNew, player)] });
    } else {
      await interaction.deferReply();
      const results = rollGacha(10);
      const newOnes = [];
      let dupCrystals = 0;
      for (const charId of results) {
        if (!(player.owned||[]).includes(charId)) {
          if (!player.owned) player.owned = ["itadori"];
          player.owned.push(charId);
          if (!player.mastery) player.mastery = {};
          if (player.mastery[charId] === undefined) player.mastery[charId] = 0;
          newOnes.push(charId);
        } else {
          dupCrystals += 50;
        }
      }
      player.crystals += dupCrystals;
      savePlayer(userId);
      await interaction.editReply({ embeds:[gachaLoadingEmbed(1)] });
      await new Promise(r=>setTimeout(r,1200));
      await interaction.editReply({ embeds:[gachaLoadingEmbed(2)] });
      await new Promise(r=>setTimeout(r,1000));
      await interaction.editReply({ embeds:[gachaLoadingEmbed(3)] });
      await new Promise(r=>setTimeout(r,1200));
      return interaction.editReply({ embeds:[gacha10ResultEmbed(results, newOnes, dupCrystals, player)] });
    }
  }

  if (commandName === "출석") {
    const now = Date.now();
    const last = player.lastDaily||0;
    const msDay = 86400000;
    if (now - last < msDay) {
      const remain = msDay - (now - last);
      const h = Math.floor(remain/3600000), m = Math.floor((remain%3600000)/60000);
      return interaction.reply({ content:`⏳ 출석 쿨타임: **${h}시간 ${m}분** 남음!`, ephemeral:true });
    }
    const streak = (now - last < msDay * 2) ? (player.dailyStreak||0) + 1 : 1;
    player.dailyStreak = streak;
    player.lastDaily = now;
    const baseReward = 200;
    const streakBonus = Math.min(streak * 20, 300);
    const total = baseReward + streakBonus;
    player.crystals = (player.crystals||0) + total;
    player.potion = (player.potion||0) + 2;
    savePlayer(userId);
    return interaction.reply({ embeds:[new EmbedBuilder().setColor(0xF5C842).setTitle("📅 출석 체크 완료!").setDescription([`> 🗓️ 연속 출석: **${streak}일**째!`,`> 💎 **+${total}** 크리스탈 (기본 ${baseReward} + 연속 ${streakBonus})`,`> 🧪 회복약 **+2**개`,`> 💎 보유: **${player.crystals}**`].join("\n"))] });
  }

  if (commandName === "회복") {
    if ((player.potion||0) <= 0) return interaction.reply({ content:"❌ 회복약이 없습니다!", ephemeral:true });
    const stats = getPlayerStats(player);
    const before = player.hp||0;
    player.hp = stats.maxHp;
    player.potion = (player.potion||0) - 1;
    player.statusEffects = [];
    savePlayer(userId);
    return interaction.reply({ embeds:[new EmbedBuilder().setColor(0x4ade80).setTitle("🧪 회복약 사용!").setDescription(`> 💚 HP 완전 회복!\n> **${before}** → **${stats.maxHp}** (MAX)\n> 🩸 상태이상 해제!\n> 🧪 남은 회복약: **${player.potion}**개`)] });
  }

  if (commandName === "코가네가챠") {
    const cost = 200;
    if ((player.crystals||0) < cost) return interaction.reply({ content:`❌ 크리스탈 부족! **${cost}💎** 필요`, ephemeral:true });
    player.crystals -= cost;
    player.koganeGachaCount = (player.koganeGachaCount||0) + 1;
    const newGrade = rollKogane();
    const gradeOrder = ["3급","2급","1급","특급","전설"];
    const currGradeIdx = gradeOrder.indexOf(player.kogane?.grade || "");
    const newGradeIdx = gradeOrder.indexOf(newGrade);
    const isUpgrade = newGradeIdx > currGradeIdx;
    if (!player.kogane || isUpgrade) {
      player.kogane = { grade: newGrade };
    } else {
      player.crystals += 50;
    }
    savePlayer(userId);
    await interaction.deferReply();
    await interaction.editReply({ embeds:[koganeLoadingEmbed(1)] });
    await new Promise(r=>setTimeout(r,1200));
    await interaction.editReply({ embeds:[koganeLoadingEmbed(2)] });
    await new Promise(r=>setTimeout(r,1000));
    await interaction.editReply({ embeds:[koganeLoadingEmbed(3)] });
    await new Promise(r=>setTimeout(r,1000));
    return interaction.editReply({ embeds:[koganeRevealEmbed(newGrade, isUpgrade, player)] });
  }

  if (commandName === "코가네") {
    return interaction.reply({ embeds:[koganeProfileEmbed(player)] });
  }

  if (commandName === "손가락") {
    const fingers = player.sukunaFingers||0;
    const bonus = getFingerBonus(fingers);
    return interaction.reply({ embeds:[new EmbedBuilder().setColor(0x8b0000).setTitle("👹 스쿠나 손가락 현황").setDescription([`> ${bonus.label}`,`> 손가락: **${fingers}** / **${SUKUNA_FINGER_MAX}**`,`> ATK +${bonus.atkBonus}  DEF +${bonus.defBonus}  MaxHP +${bonus.hpBonus}`,`> 피해 배율: **×${bonus.dmgMult.toFixed(2)}**`,fingers<1?`> **특급 저주령** 이상을 처치하여 손가락을 획득하세요!`:"",].filter(Boolean).join("\n"))] });
  }

  if (commandName === "퀘스트") {
    return interaction.reply({ embeds:[questEmbed(player)] });
  }

  if (commandName === "재료") {
    return interaction.reply({ embeds:[materialsEmbed(player)] });
  }

  if (commandName === "주구목록") {
    return interaction.reply({ embeds:[weaponListEmbed(player)] });
  }

  if (commandName === "주구제작") {
    const weaponName = interaction.options.getString("이름");
    const weapon = getWeaponByName(weaponName);
    if (!weapon) return interaction.reply({ content:`❌ **${weaponName}** 은(는) 존재하지 않는 주구입니다.`, ephemeral:true });
    if ((player.craftedWeapons||[]).includes(weapon.id)) return interaction.reply({ content:`❌ 이미 **${weapon.name}** 을(를) 보유하고 있습니다!`, ephemeral:true });
    const mats = player.materials||{};
    for (const [mat, qty] of Object.entries(weapon.recipe)) {
      if ((mats[mat]||0) < qty) return interaction.reply({ content:`❌ 재료 부족! **${MATERIALS[mat]?.name||mat}** ${mats[mat]||0}/${qty}`, ephemeral:true });
    }
    for (const [mat, qty] of Object.entries(weapon.recipe)) {
      player.materials[mat] = (player.materials[mat]||0) - qty;
    }
    if (!player.craftedWeapons) player.craftedWeapons = [];
    player.craftedWeapons.push(weapon.id);
    updateQuestProgress(player, "weapon_craft", 1);
    savePlayer(userId);
    return interaction.reply({ embeds:[new EmbedBuilder().setColor(weapon.color||0xF5C842).setTitle(`${weapon.emoji} ${weapon.name} 제작 완료!`).setDescription([`> \`[${weapon.grade}]\` ${weapon.desc}`,`> ATK +**${weapon.atkBonus}** DEF +**${weapon.defBonus}** HP +**${weapon.hpBonus}**`,`> \`!장착 ${weapon.name}\` 으로 장착하세요!`].join("\n"))] });
  }

  if (commandName === "장착") {
    const weaponName = interaction.options.getString("이름");
    const weapon = getWeaponByName(weaponName);
    if (!weapon) return interaction.reply({ content:`❌ **${weaponName}** 은(는) 존재하지 않습니다.`, ephemeral:true });
    if (!(player.craftedWeapons||[]).includes(weapon.id)) return interaction.reply({ content:`❌ 보유하지 않은 주구입니다! \`!주구제작 ${weapon.name}\` 으로 먼저 제작하세요.`, ephemeral:true });
    player.equippedWeapon = weapon.name;
    const stats = getPlayerStats(player);
    player.hp = Math.min((player.hp||0) + weapon.hpBonus, stats.maxHp);
    savePlayer(userId);
    return interaction.reply({ embeds:[new EmbedBuilder().setColor(weapon.color||0xF5C842).setTitle(`${weapon.emoji} ${weapon.name} 장착!`).setDescription(`> ATK +**${weapon.atkBonus}** DEF +**${weapon.defBonus}** HP +**${weapon.hpBonus}**`)] });
  }

  if (commandName === "해제") {
    if (!player.equippedWeapon) return interaction.reply({ content:"❌ 장착된 주구가 없습니다.", ephemeral:true });
    const prev = player.equippedWeapon;
    player.equippedWeapon = null;
    savePlayer(userId);
    return interaction.reply({ content:`✅ **${prev}** 장착 해제!` });
  }

  if (commandName === "코드") {
    const code = interaction.options.getString("코드").toLowerCase().trim();
    const reward = CODES[code];
    if (!reward) return interaction.reply({ content:"❌ 유효하지 않은 코드입니다.", ephemeral:true });
    if ((player.usedCodes||[]).includes(code)) return interaction.reply({ content:"❌ 이미 사용한 코드입니다.", ephemeral:true });
    if (!player.usedCodes) player.usedCodes = [];
    player.usedCodes.push(code);
    player.crystals = (player.crystals||0) + (reward.crystals||0);
    savePlayer(userId);
    return interaction.reply({ embeds:[new EmbedBuilder().setColor(0xF5C842).setTitle("🎁 코드 사용 완료!").setDescription(`> 💎 **+${reward.crystals||0}** 크리스탈 획득!\n> 현재 보유: **${player.crystals}**💎`)] });
  }

  if (commandName === "결투") {
    const target = interaction.options.getUser("대상");
    if (!target) return interaction.reply({ content:"❌ 대상을 지정해주세요.", ephemeral:true });
    if (target.id === userId) return interaction.reply({ content:"❌ 자기 자신에게 도전할 수 없습니다!", ephemeral:true });
    if (target.bot) return interaction.reply({ content:"❌ 봇에게 도전할 수 없습니다!", ephemeral:true });
    if (getPvpSessionByUser(userId)||getPvpSessionByUser(target.id)) return interaction.reply({ content:"❌ 이미 PvP 중입니다!", ephemeral:true });
    if (pvpChallenges[userId]) return interaction.reply({ content:"❌ 이미 도전장을 보냈습니다!", ephemeral:true });
    const targetPlayer = getPlayer(target.id, target.username);
    pvpChallenges[userId] = { target: target.id, timestamp: Date.now() };
    const ch1 = CHARACTERS[player.active]||CHARACTERS["itadori"];
    const ch2 = CHARACTERS[targetPlayer.active]||CHARACTERS["itadori"];
    const s1 = getPlayerStats(player), s2 = getPlayerStats(targetPlayer);
    const challengeEmbed = new EmbedBuilder().setColor(0xF5C842).setTitle("⚔️ PvP 결투 도전!")
      .setDescription([`> ${ch1.emoji} **${player.name}** [${ch1.grade}] ATK **${s1.atk}** HP **${s1.maxHp}**`,`> VS`,`> ${ch2.emoji} **${targetPlayer.name}** [${ch2.grade}] ATK **${s2.atk}** HP **${s2.maxHp}**`,`\n> <@${target.id}> 도전을 수락하시겠습니까?`].join("\n"));
    const btns = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`pvp_challenge_accept_${userId}_${target.id}`).setLabel("✅ 수락").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`pvp_challenge_decline_${userId}_${target.id}`).setLabel("❌ 거절").setStyle(ButtonStyle.Danger),
    );
    return interaction.reply({ content:`<@${target.id}>`, embeds:[challengeEmbed], components:[btns] });
  }

  if (commandName === "파티생성") {
    if (getPartyId(userId)) return interaction.reply({ content:"❌ 이미 파티에 소속되어 있습니다!", ephemeral:true });
    const partyId = `party_${Date.now()}_${_partyIdSeq++}`;
    parties[partyId] = { id:partyId, leader:userId, members:[userId], createdAt:Date.now() };
    return interaction.reply({ embeds:[new EmbedBuilder().setColor(0x4ade80).setTitle("🏰 파티 생성 완료!").setDescription(`> 파티 ID: \`${partyId}\`\n> 리더: **${player.name}**\n> \`!파티초대 @유저\` 로 초대하세요!`)] });
  }

  if (commandName === "파티초대") {
    const target = interaction.options.getUser("대상");
    if (!target) return interaction.reply({ content:"❌ 대상을 지정해주세요.", ephemeral:true });
    const partyId = getPartyId(userId);
    if (!partyId) return interaction.reply({ content:"❌ 파티를 먼저 생성하세요!", ephemeral:true });
    const party = parties[partyId];
    if (party.leader !== userId) return interaction.reply({ content:"❌ 리더만 초대할 수 있습니다!", ephemeral:true });
    if (party.members.length >= 4) return interaction.reply({ content:"❌ 파티가 가득찼습니다! (최대 4명)", ephemeral:true });
    if (getPartyId(target.id)) return interaction.reply({ content:"❌ 대상이 이미 파티에 소속되어 있습니다!", ephemeral:true });
    partyInvites[target.id] = { partyId, from: userId, timestamp: Date.now() };
    const btns = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`party_invite_accept_${partyId}_${target.id}`).setLabel("✅ 수락").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`party_invite_decline_${partyId}_${target.id}`).setLabel("❌ 거절").setStyle(ButtonStyle.Danger),
    );
    return interaction.reply({ content:`<@${target.id}>`, embeds:[new EmbedBuilder().setColor(0x4ade80).setTitle("🏰 파티 초대").setDescription(`> **${player.name}** 이(가) 파티에 초대했습니다!\n> 수락하시겠습니까?`)], components:[btns] });
  }

  if (commandName === "파티나가기") {
    const partyId = getPartyId(userId);
    if (!partyId) return interaction.reply({ content:"❌ 파티에 소속되어 있지 않습니다!", ephemeral:true });
    const party = parties[partyId];
    party.members = party.members.filter(uid => uid !== userId);
    if (party.members.length === 0 || party.leader === userId) {
      delete parties[partyId];
      return interaction.reply({ content:"🏰 파티 해체됨!" });
    }
    party.leader = party.members[0];
    return interaction.reply({ content:`✅ 파티 탈퇴! (${party.members.length}명 남음)` });
  }

  if (commandName === "파티컬링") {
    const partyId = getPartyId(userId);
    if (!partyId) return interaction.reply({ content:"❌ 파티에 소속되어 있지 않습니다!", ephemeral:true });
    const party = parties[partyId];
    if (party.leader !== userId) return interaction.reply({ content:"❌ 파티 리더만 시작할 수 있습니다!", ephemeral:true });
    if (cullings[partyId]) return interaction.reply({ content:"❌ 이미 컬링 중!", ephemeral:true });
    for (const uid of party.members) {
      const p = players[uid];
      if (!p || (p.hp||0) <= 0) return interaction.reply({ content:`❌ **${p?.name||uid}** 의 HP가 0! 먼저 회복하세요.`, ephemeral:true });
    }
    const firstEnemy = pickCullingEnemy(1);
    const session = {
      wave:1, kills:0, totalXp:0, totalCrystals:0,
      currentEnemy:{ ...firstEnemy, hp:firstEnemy.hp, currentHp:firstEnemy.hp, statusEffects:[] },
      enemyHp: firstEnemy.hp,
    };
    cullings[partyId] = session;
    return interaction.reply({ embeds:[partyCullingEmbed(party,session,[`> 🌊 파티 컬링 시작! WAVE 1`])], components:[mkPartyCullingButtons(player)] });
  }

  if (commandName === "레이드") {
    const bossId = interaction.options.getString("보스");
    const boss = RAID_BOSSES[bossId];
    if (!boss) return interaction.reply({ content:`❌ 레이드 보스를 찾을 수 없습니다.\n사용 가능: \`heian_sukuna\`, \`mahoraga\``, ephemeral:true });
    if (getRaidByUser(userId)) return interaction.reply({ content:"❌ 이미 레이드 중!", ephemeral:true });
    if ((player.hp||0) <= 0) return interaction.reply({ content:"💀 HP 0! `!회복`으로 회복하세요.", ephemeral:true });
    const partyId = getPartyId(userId);
    let members;
    if (partyId) {
      const party = parties[partyId];
      members = [...party.members];
    } else {
      members = [userId];
    }
    const raidId = `raid_${Date.now()}_${_raidIdSeq++}`;
    const raidSession = {
      id: raidId, bossId, members,
      hp: boss.hp, enraged: false,
      adaptedSkills: boss.adaptationSkill ? [] : undefined,
    };
    raidSessions[raidId] = raidSession;
    const bossEmbed = new EmbedBuilder().setColor(boss.color||0x8b0000)
      .setTitle(`${boss.emoji} 레이드 시작 — ${boss.name}`)
      .setDescription([`> *"${boss.lore}"*`, `> 💚 HP: **${boss.hp}** | 🗡️ ATK: **${boss.atk}** | 🛡️ DEF: **${boss.def}**`, `> 👥 참가자: ${members.map(uid=>`<@${uid}>`).join(", ")}`].join("\n"));
    return interaction.reply({ embeds:[bossEmbed, raidEmbed(raidSession)], components:[mkRaidButtons(player)] });
  }

  if (commandName === "도움말") {
    const embed = new EmbedBuilder().setColor(0x7c5cfc).setTitle("📖 주술회전 RPG — 명령어 목록")
      .addFields(
        {name:"⚔️ 전투",value:"`/전투` — 일반 전투\n`/컬링` — 무한 웨이브\n`/사멸회유` — 적 선택 전투\n`/레이드 [보스]` — 보스 레이드",inline:true},
        {name:"🎴 캐릭터",value:"`/캐릭터` — 캐릭터 변경\n`/도감` — 보유 캐릭터\n`/술식` — 스킬 트리\n`/손가락` — 스쿠나 손가락",inline:true},
        {name:"🎲 가챠/펫",value:"`/가챠 [1/10]` — 캐릭터 소환\n`/코가네가챠` — 펫 소환\n`/코가네` — 펫 현황",inline:true},
        {name:"📦 아이템",value:"`/재료` — 재료 인벤토리\n`/주구목록` — 무기 목록\n`/주구제작 [이름]` — 제작\n`/장착 [이름]` / `/해제`",inline:true},
        {name:"📋 퀘스트/일상",value:"`/퀘스트` — 퀘스트 현황\n`/출석` — 일일 출석\n`/회복` — 회복약 사용\n`/프로필` — 프로필 카드",inline:true},
        {name:"🥊 PvP/파티",value:"`/결투 @유저` — PvP\n`/파티생성` / `/파티나가기`\n`/파티초대 @유저`\n`/파티컬링` — 파티 전투",inline:true},
        {name:"🎁 기타",value:"`/코드 [코드]` — 쿠폰\n`/도움말`",inline:true},
      )
      .setFooter({text:"⚫ 흑섬 10% | 🌌 영역전개 15턴 쿨 | ♻️ 반전 3턴 쿨 (고조/유타) | 💪 주력 소모: 스킬20, 영역40, 반전30"});
    return interaction.reply({ embeds:[embed] });
  }
}

// ════════════════════════════════════════════════════════
// 메시지 핸들러 (느낌표 명령어) - 주력 추가 및 코드 정리
// ════════════════════════════════════════════════════════
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  const userId = message.author.id;
  const content = message.content.trim();

  if (antiBotVerify.has(userId)) {
    const entry = antiBotVerify.get(userId);
    if (entry?.pending === true) {
      if (Date.now() - entry.timestamp > VERIFY_TIMEOUT) {
        antiBotVerify.delete(userId);
      } else if (content.toUpperCase() === entry.code) {
        antiBotVerify.delete(userId);
        const player = players[userId];
        if (player) {
          player.battleTurns = 0;
          savePlayer(userId);
        }
        return message.reply("✅ **인증 완료!** 전투를 계속하세요.");
      } else if (content.startsWith("!") || content.startsWith("/")) {
      } else {
        return message.reply("❌ 잘못된 코드입니다! 다시 입력해주세요.");
      }
    }
  }

  if (!content.startsWith("!")) return;
  const args = content.slice(1).trim().split(/\s+/);
  const cmd = args[0]?.toLowerCase();
  if (!cmd) return;

  const player = getPlayer(userId, message.author.username);

  if (cmd === "개발자패널" || cmd === "devpanel") {
    if (!isDev(userId)) return;
    return message.reply({ embeds:[devPanelEmbed()] });
  }

  if (cmd === "아이템지급") {
    if (!isDev(userId)) return;
    const mentionId = message.mentions.users.first()?.id;
    const targetId = mentionId || userId;
    const targetPlayer = players[targetId] || getPlayer(targetId, targetId);
    const type = args[2]?.toLowerCase();
    const amount = parseInt(args[3])||1;
    if (!type) return message.reply("사용법: `!아이템지급 @유저 [크리스탈|회복약|손가락|재료명] [수량]`");
    if (type === "크리스탈") {
      targetPlayer.crystals = (targetPlayer.crystals||0) + amount;
      savePlayer(targetId);
      return message.reply(`✅ **${targetPlayer.name}** 에게 💎 **${amount}** 크리스탈 지급!`);
    }
    if (type === "회복약") {
      targetPlayer.potion = (targetPlayer.potion||0) + amount;
      savePlayer(targetId);
      return message.reply(`✅ **${targetPlayer.name}** 에게 🧪 회복약 **${amount}**개 지급!`);
    }
    if (type === "손가락") {
      targetPlayer.sukunaFingers = Math.min(SUKUNA_FINGER_MAX, (targetPlayer.sukunaFingers||0) + amount);
      if (targetPlayer.sukunaFingers >= 1 && !(targetPlayer.owned||[]).includes("sukuna")) {
        if (!targetPlayer.owned) targetPlayer.owned = ["itadori"];
        targetPlayer.owned.push("sukuna");
        if (!targetPlayer.mastery) targetPlayer.mastery = {};
        if (targetPlayer.mastery["sukuna"] === undefined) targetPlayer.mastery["sukuna"] = 0;
      }
      savePlayer(targetId);
      return message.reply(`✅ 스쿠나 손가락 **${amount}**개 지급! (현재: ${targetPlayer.sukunaFingers}/${SUKUNA_FINGER_MAX})`);
    }
    if (MATERIALS[type] || Object.values(MATERIALS).some(m=>m.name===type)) {
      const matKey = MATERIALS[type] ? type : Object.keys(MATERIALS).find(k=>MATERIALS[k].name===type);
      if (!targetPlayer.materials) targetPlayer.materials = {};
      targetPlayer.materials[matKey] = (targetPlayer.materials[matKey]||0) + amount;
      savePlayer(targetId);
      return message.reply(`✅ **${MATERIALS[matKey].name}** ×${amount} 지급!`);
    }
    return message.reply("❌ 알 수 없는 아이템 유형");
  }

  if (cmd === "쿨다운초기화") {
    if (!isDev(userId)) return;
    const mentionId = message.mentions.users.first()?.id || userId;
    const tp = players[mentionId]||getPlayer(mentionId, mentionId);
    tp.skillCooldown = 0;
    tp.reverseCooldown = 0;
    tp.domainCooldown = 0;
    tp.statusEffects = [];
    savePlayer(mentionId);
    return message.reply(`✅ **${tp.name}** 쿨다운 초기화!`);
  }

  if (cmd === "전체저장") {
    if (!isDev(userId)) return;
    let cnt = 0;
    for (const uid of Object.keys(players)) {
      await dbSave(uid, players[uid]).catch(()=>{});
      cnt++;
    }
    return message.reply(`✅ **${cnt}**명 전체 저장 완료!`);
  }

  if (cmd === "플레이어정보") {
    if (!isDev(userId)) return;
    const mentionId = message.mentions.users.first()?.id;
    if (!mentionId) return message.reply("❌ @유저를 멘션해주세요.");
    const tp = players[mentionId];
    if (!tp) return message.reply("❌ 플레이어 데이터 없음.");
    return message.reply({ embeds:[profileEmbed(tp)] });
  }

  if (cmd === "초기화") {
    if (!isDev(userId)) return;
    const mentionId = message.mentions.users.first()?.id;
    if (!mentionId) return message.reply("❌ @유저를 멘션해주세요.");
    delete players[mentionId];
    await dbDelete(mentionId).catch(()=>{});
    return message.reply(`✅ **${mentionId}** 데이터 초기화 완료.`);
  }

  if (cmd === "프로필") {
    const msg = await message.reply("⏳ 프로필 생성 중...");
    try {
      const gifBuf = await generateProfileGif(player, message.author);
      const att = new AttachmentBuilder(gifBuf, { name:"profile.gif" });
      await msg.edit({ content:"", files:[att], embeds:[profileEmbed(player)] });
    } catch(e) {
      console.error("[프로필 GIF 오류]", e.message);
      await msg.edit({ content:"", embeds:[profileEmbed(player)] });
    }
    return;
  }

  if (cmd === "술식") {
    return message.reply({ embeds:[buildSkillEmbed(player)] });
  }

  if (cmd === "도감") {
    const owned = player.owned||["itadori"];
    const lines = owned.map(id=>{
      const ch=CHARACTERS[id]; if (!ch) return "";
      const ri=GACHA_RARITY[ch.grade]||GACHA_RARITY["3급"];
      const mastery=getMastery(player,id);
      const isActive=id===player.active;
      const tmpStats=getPlayerStats({...player,active:id});
      return `> ${isActive?"▶️ **[활성]**":"　"}${ch.emoji} **${ch.name}** \`[${ch.grade}]\` ${ri.stars}\n> 숙련 \`${mastery}\` | ATK \`${tmpStats.atk}\` DEF \`${tmpStats.def}\` HP \`${tmpStats.maxHp}\``;
    }).filter(Boolean).join("\n\n");
    return message.reply({ embeds:[new EmbedBuilder().setColor(0x7c5cfc).setTitle("🎴 보유 캐릭터 도감").setDescription(lines||"> 없음").setFooter({text:`총 ${owned.length}명 보유`})] });
  }

  if (cmd === "캐릭터") {
    const charArg = args[1]?.toLowerCase();
    if (!charArg) {
      return message.reply({
        content:"🎭 장착할 캐릭터를 선택하세요:",
        components:[mkCharSelectMenu(player)],
      });
    }
    const charId = Object.keys(CHARACTERS).find(id => id === charArg || CHARACTERS[id].name.includes(charArg));
    if (!charId) return message.reply(`❌ **${charArg}** 는 존재하지 않는 캐릭터입니다.`);
    if (!(player.owned||[]).includes(charId)) return message.reply(`❌ **${CHARACTERS[charId].name}** 을(를) 보유하고 있지 않습니다!`);
    player.active = charId;
    if (!player.mastery) player.mastery = {};
    if (player.mastery[charId] === undefined) player.mastery[charId] = 0;
    const stats = getPlayerStats(player);
    player.hp = stats.maxHp;
    player.statusEffects = [];
    player.skillCooldown = 0;
    player.domainCooldown = 0;
    player.reverseCooldown = 0;
    player.stamina = STAMINA_MAX_BASE;
    savePlayer(userId);
    const ch = CHARACTERS[charId];
    const ri = GACHA_RARITY[ch.grade]||GACHA_RARITY["3급"];
    return message.reply({ embeds:[new EmbedBuilder().setColor(ri.color).setTitle(`${ch.emoji} **${ch.name}** 장착 완료!`).setDescription(`> ${ri.stars}  ${ri.effect}\n> 💚 HP 완전 회복: **${stats.maxHp}**\n> 🗡️ ATK: **${stats.atk}**  🛡️ DEF: **${stats.def}**\n> 🌌 영역전개: \`${ch.domain||"없음"}\``)] });
  }

  if (cmd === "전투") {
    if (battles[userId]) return message.reply("❌ 이미 전투 중입니다!");
    if ((player.hp||0) <= 0) return message.reply("💀 HP가 0입니다! `!회복` 으로 회복하세요.");
    const stats = getPlayerStats(player);
    const roll = Math.random();
    let enemy;
    if (roll < 0.03 && (player.sukunaFingers||0) >= 1) enemy = ENEMIES.find(e=>e.isSukuna);
    else if (roll < 0.10) enemy = ENEMIES.find(e=>e.id==="e4");
    else if (roll < 0.30) enemy = ENEMIES.find(e=>e.id==="e3");
    else if (roll < 0.60) enemy = ENEMIES.find(e=>e.id==="e2");
    else enemy = ENEMIES.find(e=>e.id==="e1");
    const enemyState = { ...enemy, hp:enemy.hp, maxHp:enemy.hp, statusEffects:[] };
    battles[userId] = { enemyId:enemy.id, enemy:enemyState };
    const ch = CHARACTERS[player.active]||CHARACTERS["itadori"];
    const ri = GACHA_RARITY[ch.grade]||GACHA_RARITY["3급"];
    const stamina = getPlayerStamina(player);
    return message.reply({ embeds:[new EmbedBuilder().setColor(ri.color).setTitle("⚔️ 전투 시작!").setDescription(`> ${ch.emoji} **${ch.name}** VS ${enemy.emoji} **${enemy.name}**\n> 💚 내 HP: **${Math.max(0,player.hp)}**/**${stats.maxHp}**\n> 💪 주력: **${stamina.curr}/${stamina.max}**`), buildBattleEmbed(player, enemyState)], components:mkBattleButtons(player) });
  }

  if (cmd === "컬링") {
    if (cullings[userId]) return message.reply("❌ 이미 컬링 중!");
    if ((player.hp||0) <= 0) return message.reply("💀 HP 0! `!회복`으로 회복하세요.");
    const firstEnemy = pickCullingEnemy(1);
    const session = { wave:1, kills:0, totalXp:0, totalCrystals:0, currentEnemy:{...firstEnemy,hp:firstEnemy.hp,currentHp:firstEnemy.hp,statusEffects:[]}, enemyHp:firstEnemy.hp };
    cullings[userId] = session;
    return message.reply({ embeds:[cullingEmbed(player,session,[`> 🌊 **WAVE 1** 시작! ${firstEnemy.emoji} **${firstEnemy.name}** 등장!`])], components:mkCullingButtons(player) });
  }

  if (cmd === "사멸회유") {
    if (jujutsus[userId]) return message.reply("❌ 이미 사멸회유 중!");
    if ((player.hp||0) <= 0) return message.reply("💀 HP 0! `!회복`으로 회복하세요.");
    const session = { wave:1, points:0, totalXp:0, totalCrystals:0, currentEnemy:null, enemyHp:0, choices:null };
    jujutsus[userId] = session;
    const choices = generateJujutsuChoices(1);
    session.choices = choices;
    return message.reply({ embeds:[jujutsuEmbed(player,session,[`> 🎯 사멸회유 시작!`],choices)], components:mkJujutsuButtons(player,choices) });
  }

  if (cmd === "회복") {
    if ((player.potion||0) <= 0) return message.reply("❌ 회복약이 없습니다!");
    const stats = getPlayerStats(player);
    const before = player.hp||0;
    player.hp = stats.maxHp;
    player.potion = (player.potion||0) - 1;
    player.statusEffects = [];
    savePlayer(userId);
    return message.reply({ embeds:[new EmbedBuilder().setColor(0x4ade80).setTitle("🧪 회복약 사용!").setDescription(`> 💚 HP 완전 회복!\n> **${before}** → **${stats.maxHp}**\n> 🩸 상태이상 해제!\n> 🧪 남은 회복약: **${player.potion}**개`)] });
  }

  if (cmd === "출석") {
    const now = Date.now();
    const last = player.lastDaily||0;
    const msDay = 86400000;
    if (now - last < msDay) {
      const remain = msDay - (now - last);
      const h = Math.floor(remain/3600000), m = Math.floor((remain%3600000)/60000);
      return message.reply(`⏳ 출석 쿨타임: **${h}시간 ${m}분** 남음!`);
    }
    const streak = (now - last < msDay * 2) ? (player.dailyStreak||0) + 1 : 1;
    player.dailyStreak = streak;
    player.lastDaily = now;
    const total = 200 + Math.min(streak * 20, 300);
    player.crystals = (player.crystals||0) + total;
    player.potion = (player.potion||0) + 2;
    savePlayer(userId);
    return message.reply({ embeds:[new EmbedBuilder().setColor(0xF5C842).setTitle("📅 출석 완료!").setDescription(`> 🗓️ 연속: **${streak}일**\n> 💎 **+${total}** | 🧪 +2개`)] });
  }

  if (cmd === "가챠") {
    const count = parseInt(args[1])||1;
    if (count !== 1 && count !== 10) return message.reply("❌ `!가챠 1` 또는 `!가챠 10`");
    const cost = count === 10 ? 1500 : 160;
    if ((player.crystals||0) < cost) return message.reply(`❌ 크리스탈 부족! **${cost}💎** 필요 / 보유: **${player.crystals}**`);
    player.crystals -= cost;
    updateQuestProgress(player, "gacha_pull", count);
    if (count === 1) {
      const [charId] = rollGacha(1);
      const ch = CHARACTERS[charId];
      const isNew = !(player.owned||[]).includes(charId);
      if (isNew) { if (!player.owned) player.owned=["itadori"]; player.owned.push(charId); if (!player.mastery) player.mastery={}; if (player.mastery[charId]===undefined) player.mastery[charId]=0; }
      else player.crystals += 50;
      savePlayer(userId);
      const msg = await message.reply({ embeds:[gachaLoadingEmbed(1)] });
      await new Promise(r=>setTimeout(r,1200));
      await msg.edit({ embeds:[gachaLoadingEmbed(2)] });
      await new Promise(r=>setTimeout(r,1000));
      await msg.edit({ embeds:[gachaRevealEmbed(ch.grade)] });
      await new Promise(r=>setTimeout(r,1200));
      return msg.edit({ embeds:[gachaResultEmbed(charId, isNew, player)] });
    } else {
      const results = rollGacha(10);
      const newOnes = []; let dup = 0;
      for (const charId of results) {
        if (!(player.owned||[]).includes(charId)) { if (!player.owned) player.owned=["itadori"]; player.owned.push(charId); if (!player.mastery) player.mastery={}; if (player.mastery[charId]===undefined) player.mastery[charId]=0; newOnes.push(charId); }
        else { dup += 50; }
      }
      player.crystals += dup;
      savePlayer(userId);
      const msg = await message.reply({ embeds:[gachaLoadingEmbed(1)] });
      await new Promise(r=>setTimeout(r,1200));
      await msg.edit({ embeds:[gachaLoadingEmbed(2)] });
      await new Promise(r=>setTimeout(r,1000));
      await msg.edit({ embeds:[gachaLoadingEmbed(3)] });
      await new Promise(r=>setTimeout(r,1200));
      return msg.edit({ embeds:[gacha10ResultEmbed(results, newOnes, dup, player)] });
    }
  }

  if (cmd === "코가네가챠") {
    const cost = 200;
    if ((player.crystals||0) < cost) return message.reply(`❌ **${cost}💎** 필요`);
    player.crystals -= cost;
    player.koganeGachaCount = (player.koganeGachaCount||0) + 1;
    const newGrade = rollKogane();
    const gradeOrder = ["3급","2급","1급","특급","전설"];
    const isUpgrade = gradeOrder.indexOf(newGrade) > gradeOrder.indexOf(player.kogane?.grade||"");
    if (!player.kogane || isUpgrade) player.kogane = { grade: newGrade };
    else player.crystals += 50;
    savePlayer(userId);
    const msg = await message.reply({ embeds:[koganeLoadingEmbed(1)] });
    await new Promise(r=>setTimeout(r,1200));
    await msg.edit({ embeds:[koganeLoadingEmbed(2)] });
    await new Promise(r=>setTimeout(r,1000));
    await msg.edit({ embeds:[koganeLoadingEmbed(3)] });
    await new Promise(r=>setTimeout(r,1000));
    return msg.edit({ embeds:[koganeRevealEmbed(newGrade, isUpgrade, player)] });
  }

  if (cmd === "코가네") {
    return message.reply({ embeds:[koganeProfileEmbed(player)] });
  }

  if (cmd === "손가락") {
    const fingers = player.sukunaFingers||0;
    const bonus = getFingerBonus(fingers);
    return message.reply({ embeds:[new EmbedBuilder().setColor(0x8b0000).setTitle("👹 스쿠나 손가락").setDescription(`> ${bonus.label}\n> **${fingers}** / **${SUKUNA_FINGER_MAX}**\n> ATK+${bonus.atkBonus} DEF+${bonus.defBonus} HP+${bonus.hpBonus} 배율×${bonus.dmgMult.toFixed(2)}`)] });
  }

  if (cmd === "퀘스트") {
    return message.reply({ embeds:[questEmbed(player)] });
  }

  if (cmd === "퀘보상") {
    const type = args[1];
    const idx = parseInt(args[2]) - 1;
    if (!type || isNaN(idx)) return message.reply("사용법: `!퀘보상 일 [1-3]` 또는 `!퀘보상 주 [1-3]`");
    const isWeekly = type === "주";
    const list = isWeekly ? (player.quests?.weekly||[]) : (player.quests?.daily||[]);
    const qp = list[idx];
    if (!qp) return message.reply("❌ 해당 퀘스트가 없습니다.");
    if (!qp.done) return message.reply("❌ 아직 완료되지 않은 퀘스트입니다.");
    if (qp.claimed) return message.reply("❌ 이미 수령한 퀘스트입니다.");
    const reward = claimQuestReward(player, qp.id, isWeekly);
    if (!reward) return message.reply("❌ 보상 수령 실패.");
    savePlayer(userId);
    return message.reply({ embeds:[new EmbedBuilder().setColor(0x4ade80).setTitle("🎁 퀘스트 보상 수령!").setDescription(`> 💎 **+${reward.crystals||0}** | ⭐ XP **+${reward.xp||0}**\n> 📦 재료: ${reward.materials?formatDrops(reward.materials):"없음"}`)] });
  }

  if (cmd === "재료") {
    return message.reply({ embeds:[materialsEmbed(player)] });
  }

  if (cmd === "주구목록") {
    return message.reply({ embeds:[weaponListEmbed(player)] });
  }

  if (cmd === "주구제작") {
    const weaponName = args.slice(1).join(" ");
    if (!weaponName) return message.reply("사용법: `!주구제작 [무기이름]`");
    const weapon = getWeaponByName(weaponName);
    if (!weapon) return message.reply(`❌ **${weaponName}** 은(는) 존재하지 않는 주구입니다.`);
    if ((player.craftedWeapons||[]).includes(weapon.id)) return message.reply(`❌ 이미 **${weapon.name}** 보유 중!`);
    const mats = player.materials||{};
    for (const [mat, qty] of Object.entries(weapon.recipe)) {
      if ((mats[mat]||0) < qty) return message.reply(`❌ 재료 부족! **${MATERIALS[mat]?.name||mat}** ${mats[mat]||0}/${qty}`);
    }
    for (const [mat, qty] of Object.entries(weapon.recipe)) {
      player.materials[mat] = (player.materials[mat]||0) - qty;
    }
    if (!player.craftedWeapons) player.craftedWeapons = [];
    player.craftedWeapons.push(weapon.id);
    updateQuestProgress(player, "weapon_craft", 1);
    savePlayer(userId);
    return message.reply({ embeds:[new EmbedBuilder().setColor(weapon.color||0xF5C842).setTitle(`${weapon.emoji} ${weapon.name} 제작!`).setDescription(`> ATK+${weapon.atkBonus} DEF+${weapon.defBonus} HP+${weapon.hpBonus}\n> \`!장착 ${weapon.name}\``)] });
  }

  if (cmd === "장착") {
    const weaponName = args.slice(1).join(" ");
    if (!weaponName) return message.reply("사용법: `!장착 [무기이름]`");
    const weapon = getWeaponByName(weaponName);
    if (!weapon) return message.reply(`❌ **${weaponName}** 없음`);
    if (!(player.craftedWeapons||[]).includes(weapon.id)) return message.reply(`❌ 미제작! \`!주구제작 ${weapon.name}\``);
    player.equippedWeapon = weapon.name;
    const stats = getPlayerStats(player);
    player.hp = Math.min((player.hp||0) + weapon.hpBonus, stats.maxHp);
    savePlayer(userId);
    return message.reply({ embeds:[new EmbedBuilder().setColor(weapon.color||0xF5C842).setTitle(`${weapon.emoji} ${weapon.name} 장착!`).setDescription(`> ATK+${weapon.atkBonus} DEF+${weapon.defBonus} HP+${weapon.hpBonus}`)] });
  }

  if (cmd === "해제") {
    if (!player.equippedWeapon) return message.reply("❌ 장착된 주구 없음");
    const prev = player.equippedWeapon;
    player.equippedWeapon = null;
    savePlayer(userId);
    return message.reply(`✅ **${prev}** 장착 해제!`);
  }

  if (cmd === "코드") {
    const code = args[1]?.toLowerCase().trim();
    if (!code) return message.reply("사용법: `!코드 [코드명]`");
    const reward = CODES[code];
    if (!reward) return message.reply("❌ 유효하지 않은 코드입니다.");
    if ((player.usedCodes||[]).includes(code)) return message.reply("❌ 이미 사용한 코드입니다.");
    if (!player.usedCodes) player.usedCodes = [];
    player.usedCodes.push(code);
    player.crystals = (player.crystals||0) + (reward.crystals||0);
    savePlayer(userId);
    return message.reply({ embeds:[new EmbedBuilder().setColor(0xF5C842).setTitle("🎁 코드 사용!").setDescription(`> 💎 **+${reward.crystals||0}** 크리스탈!\n> 보유: **${player.crystals}**💎`)] });
  }

  if (cmd === "결투") {
    const target = message.mentions.users.first();
    if (!target) return message.reply("사용법: `!결투 @유저`");
    if (target.id === userId) return message.reply("❌ 자기 자신과 결투 불가!");
    if (target.bot) return message.reply("❌ 봇과 결투 불가!");
    if (getPvpSessionByUser(userId)||getPvpSessionByUser(target.id)) return message.reply("❌ 이미 PvP 중!");
    const targetPlayer = getPlayer(target.id, target.username);
    pvpChallenges[userId] = { target:target.id, timestamp:Date.now() };
    const ch1=CHARACTERS[player.active]||CHARACTERS["itadori"], ch2=CHARACTERS[targetPlayer.active]||CHARACTERS["itadori"];
    const s1=getPlayerStats(player), s2=getPlayerStats(targetPlayer);
    const btns = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`pvp_challenge_accept_${userId}_${target.id}`).setLabel("✅ 수락").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`pvp_challenge_decline_${userId}_${target.id}`).setLabel("❌ 거절").setStyle(ButtonStyle.Danger),
    );
    return message.reply({ content:`<@${target.id}>`, embeds:[new EmbedBuilder().setColor(0xF5C842).setTitle("⚔️ PvP 도전!").setDescription(`> ${ch1.emoji} **${player.name}** [${ch1.grade}] ATK **${s1.atk}** HP **${s1.maxHp}**\n> VS\n> ${ch2.emoji} **${targetPlayer.name}** [${ch2.grade}] ATK **${s2.atk}** HP **${s2.maxHp}**`)], components:[btns] });
  }

  if (cmd === "파티생성") {
    if (getPartyId(userId)) return message.reply("❌ 이미 파티에 소속!");
    const partyId = `party_${Date.now()}_${_partyIdSeq++}`;
    parties[partyId] = { id:partyId, leader:userId, members:[userId], createdAt:Date.now() };
    return message.reply({ embeds:[new EmbedBuilder().setColor(0x4ade80).setTitle("🏰 파티 생성!").setDescription(`> 리더: **${player.name}**\n> \`!파티초대 @유저\``)] });
  }

  if (cmd === "파티초대") {
    const target = message.mentions.users.first();
    if (!target) return message.reply("사용법: `!파티초대 @유저`");
    const partyId = getPartyId(userId);
    if (!partyId) return message.reply("❌ 파티를 먼저 생성하세요!");
    const party = parties[partyId];
    if (party.leader !== userId) return message.reply("❌ 리더만 초대 가능!");
    if (party.members.length >= 4) return message.reply("❌ 파티 가득참 (최대 4명)!");
    if (getPartyId(target.id)) return message.reply("❌ 대상이 이미 파티 소속!");
    partyInvites[target.id] = { partyId, from:userId, timestamp:Date.now() };
    const btns = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`party_invite_accept_${partyId}_${target.id}`).setLabel("✅ 수락").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`party_invite_decline_${partyId}_${target.id}`).setLabel("❌ 거절").setStyle(ButtonStyle.Danger),
    );
    return message.reply({ content:`<@${target.id}>`, embeds:[new EmbedBuilder().setColor(0x4ade80).setTitle("🏰 파티 초대!").setDescription(`> **${player.name}** 이(가) 초대했습니다!`)], components:[btns] });
  }

  if (cmd === "파티나가기") {
    const partyId = getPartyId(userId);
    if (!partyId) return message.reply("❌ 파티에 소속되지 않음!");
    const party = parties[partyId];
    party.members = party.members.filter(uid=>uid!==userId);
    if (party.members.length === 0 || party.leader === userId) { delete parties[partyId]; return message.reply("🏰 파티 해체됨!"); }
    party.leader = party.members[0];
    return message.reply(`✅ 파티 탈퇴! (${party.members.length}명 남음)`);
  }

  if (cmd === "파티컬링") {
    const partyId = getPartyId(userId);
    if (!partyId) return message.reply("❌ 파티에 소속되지 않음!");
    const party = parties[partyId];
    if (party.leader !== userId) return message.reply("❌ 리더만 시작 가능!");
    if (cullings[partyId]) return message.reply("❌ 이미 컬링 중!");
    for (const uid of party.members) {
      const p = players[uid];
      if (!p || (p.hp||0) <= 0) return message.reply(`❌ **${p?.name||uid}** HP 0!`);
    }
    const fe = pickCullingEnemy(1);
    const session = { wave:1, kills:0, totalXp:0, totalCrystals:0, currentEnemy:{...fe,hp:fe.hp,currentHp:fe.hp,statusEffects:[]}, enemyHp:fe.hp };
    cullings[partyId] = session;
    return message.reply({ embeds:[partyCullingEmbed(party,session,[`> 🌊 파티 컬링 시작!`])], components:[mkPartyCullingButtons(player)] });
  }

  if (cmd === "레이드") {
    const bossId = args[1]?.toLowerCase();
    const boss = RAID_BOSSES[bossId];
    if (!boss) return message.reply("사용법: `!레이드 heian_sukuna` 또는 `!레이드 mahoraga`");
    if (getRaidByUser(userId)) return message.reply("❌ 이미 레이드 중!");
    if ((player.hp||0) <= 0) return message.reply("💀 HP 0! `!회복`으로 회복하세요.");
    const partyId = getPartyId(userId);
    const members = partyId ? [...parties[partyId].members] : [userId];
    const raidId = `raid_${Date.now()}_${_raidIdSeq++}`;
    const raidSession = { id:raidId, bossId, members, hp:boss.hp, enraged:false, adaptedSkills:boss.adaptationSkill?[]:undefined };
    raidSessions[raidId] = raidSession;
    return message.reply({ embeds:[new EmbedBuilder().setColor(boss.color||0x8b0000).setTitle(`${boss.emoji} 레이드 시작!`).setDescription(`> **${boss.name}**\n> HP: **${boss.hp}** | ATK: **${boss.atk}** | DEF: **${boss.def}**`), raidEmbed(raidSession)], components:[mkRaidButtons(player)] });
  }

  if (cmd === "도움말") {
    const embed = new EmbedBuilder().setColor(0x7c5cfc).setTitle("📖 주술회전 RPG — 명령어 목록 (!)")
      .addFields(
        {name:"⚔️ 전투",value:"`!전투` `!컬링` `!사멸회유`\n`!레이드 [보스]`",inline:true},
        {name:"🎴 캐릭터",value:"`!캐릭터` `!도감` `!술식`\n`!손가락`",inline:true},
        {name:"🎲 가챠",value:"`!가챠 [1/10]`\n`!코가네가챠` `!코가네`",inline:true},
        {name:"📦 아이템",value:"`!재료` `!주구목록`\n`!주구제작` `!장착` `!해제`",inline:true},
        {name:"📋 퀘스트",value:"`!퀘스트`\n`!퀘보상 일/주 [번호]`",inline:true},
        {name:"일상",value:"`!출석` `!회복` `!프로필`\n`!코드 [코드]`",inline:true},
        {name:"🥊 PvP/파티",value:"`!결투 @유저`\n`!파티생성` `!파티초대` `!파티컬링` `!파티나가기`",inline:true},
      )
      .setFooter({text:"슬래시 명령어 / 도 지원합니다! | 💪 주력 소모: 스킬20, 영역40, 반전30"});
    return message.reply({ embeds:[embed] });
  }
});

// ════════════════════════════════════════════════════════
// 세션 만료 정리 (5분마다)
// ════════════════════════════════════════════════════════
setInterval(() => {
  const now = Date.now();
  for (const [uid, ch] of Object.entries(pvpChallenges)) {
    if (now - ch.timestamp > 120000) delete pvpChallenges[uid];
  }
  for (const [uid, inv] of Object.entries(partyInvites)) {
    if (now - inv.timestamp > 120000) delete partyInvites[uid];
  }
  for (const [uid, entry] of antiBotVerify.entries()) {
    if (now - entry.timestamp > VERIFY_TIMEOUT) antiBotVerify.delete(uid);
  }
}, 5 * 60 * 1000);

client.login(TOKEN);
