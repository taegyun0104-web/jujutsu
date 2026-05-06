const express = require("express");
const { Pool } = require("pg");
const {
  Client, GatewayIntentBits, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
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
// ── 재료 & 주구 시스템
// ════════════════════════════════════════════════════════
const MATERIALS = {
  cursed_thread:  { name:"저주 실",   emoji:"🧵", desc:"저급 저주령에서 획득." },
  cursed_bone:    { name:"저주 뼈",   emoji:"🦴", desc:"1급 저주령에서 획득." },
  cursed_core:    { name:"저주 핵",   emoji:"💜", desc:"특급 저주령에서 획득." },
  cursed_crystal: { name:"저주 수정", emoji:"💎", desc:"보스에서 획득." },
  iron_fragment:  { name:"철 파편",   emoji:"⚙️", desc:"모든 적에서 획득." },
  spirit_essence: { name:"영혼 정수", emoji:"✨", desc:"특급 이상 적에서 획득." },
  dragon_scale:   { name:"용 비늘",   emoji:"🐉", desc:"보스에서 획득." },
};
const WEAPONS = {
  cursed_knife:  { name:"저주 단검",     emoji:"🗡️", grade:"일반", atkBonus:15, defBonus:0,  hpBonus:0,   desc:"저주 에너지가 깃든 단검.", recipe:{cursed_thread:3,iron_fragment:5},             color:0x94a3b8 },
  cursed_blade:  { name:"저주 도검",     emoji:"⚔️", grade:"희귀", atkBonus:35, defBonus:5,  hpBonus:100, desc:"날카로운 저주 도검.",       recipe:{cursed_bone:4,iron_fragment:8,cursed_thread:2},color:0x4ade80 },
  cursed_spear:  { name:"저주 창",       emoji:"🔱", grade:"희귀", atkBonus:45, defBonus:0,  hpBonus:0,   desc:"원거리 공격이 가능한 창.",   recipe:{cursed_bone:5,cursed_thread:5},               color:0x4ade80 },
  spirit_shield: { name:"영혼 방패",     emoji:"🛡️", grade:"고급", atkBonus:5,  defBonus:40, hpBonus:300, desc:"영혼 정수로 만든 방패.",     recipe:{spirit_essence:3,cursed_core:2,iron_fragment:10},color:0x7C5CFC },
  cursed_hammer: { name:"저주 망치",     emoji:"🔨", grade:"고급", atkBonus:60, defBonus:10, hpBonus:150, desc:"묵직한 저주 망치.",          recipe:{cursed_core:3,cursed_bone:6,iron_fragment:12},color:0x7C5CFC },
  dragon_sword:  { name:"용의 검",       emoji:"🐉⚔️",grade:"전설",atkBonus:100,defBonus:30, hpBonus:500, desc:"용 비늘로 만든 전설의 검.",  recipe:{dragon_scale:3,cursed_crystal:2,spirit_essence:5,cursed_core:4},color:0xF5C842 },
  sukuna_vessel: { name:"스쿠나의 그릇", emoji:"👹", grade:"전설", atkBonus:80, defBonus:20, hpBonus:800, desc:"스쿠나의 힘이 깃든 주구.",   recipe:{cursed_crystal:3,dragon_scale:2,cursed_core:6},color:0x8b0000 },
};
const ENEMY_DROPS = {
  e1:[{mat:"cursed_thread",min:1,max:3,chance:0.80},{mat:"iron_fragment",min:1,max:2,chance:0.60},{mat:"cursed_bone",min:1,max:1,chance:0.10}],
  e2:[{mat:"cursed_bone",min:1,max:2,chance:0.70},{mat:"iron_fragment",min:2,max:4,chance:0.80},{mat:"cursed_thread",min:2,max:4,chance:0.50},{mat:"cursed_core",min:1,max:1,chance:0.08}],
  e3:[{mat:"cursed_core",min:1,max:2,chance:0.65},{mat:"spirit_essence",min:1,max:2,chance:0.55},{mat:"cursed_bone",min:2,max:4,chance:0.80},{mat:"iron_fragment",min:3,max:6,chance:0.90},{mat:"cursed_crystal",min:1,max:1,chance:0.05}],
  e4:[{mat:"cursed_crystal",min:1,max:2,chance:0.80},{mat:"dragon_scale",min:1,max:2,chance:0.60},{mat:"spirit_essence",min:2,max:4,chance:0.90},{mat:"cursed_core",min:2,max:4,chance:0.90},{mat:"iron_fragment",min:5,max:10,chance:1.00}],
};
const JUJUTSU_DROPS = {
  j1:[{mat:"cursed_thread",min:1,max:2,chance:0.70},{mat:"iron_fragment",min:1,max:2,chance:0.60}],
  j2:[{mat:"cursed_thread",min:1,max:3,chance:0.70},{mat:"cursed_bone",min:1,max:1,chance:0.35},{mat:"iron_fragment",min:1,max:3,chance:0.65}],
  j3:[{mat:"cursed_bone",min:1,max:2,chance:0.55},{mat:"iron_fragment",min:1,max:3,chance:0.70}],
  j4:[{mat:"cursed_core",min:1,max:1,chance:0.30},{mat:"cursed_bone",min:1,max:3,chance:0.65},{mat:"spirit_essence",min:1,max:1,chance:0.20}],
  j5:[{mat:"cursed_core",min:1,max:2,chance:0.55},{mat:"spirit_essence",min:1,max:2,chance:0.40},{mat:"cursed_crystal",min:1,max:1,chance:0.08}],
  j6:[{mat:"cursed_crystal",min:1,max:1,chance:0.50},{mat:"dragon_scale",min:1,max:1,chance:0.30},{mat:"spirit_essence",min:2,max:3,chance:0.80}],
};
function rollDrops(enemyId, isJujutsu=false) {
  const table = isJujutsu ? JUJUTSU_DROPS[enemyId] : ENEMY_DROPS[enemyId];
  if (!table) return {};
  const result = {};
  for (const entry of table) {
    if (Math.random() < entry.chance) {
      const qty = entry.min + Math.floor(Math.random()*(entry.max-entry.min+1));
      result[entry.mat] = (result[entry.mat]||0)+qty;
    }
  }
  return result;
}
function addMaterials(player, drops) {
  if (!player.materials) player.materials = {};
  for (const [mat,qty] of Object.entries(drops)) player.materials[mat]=(player.materials[mat]||0)+qty;
}
function formatDrops(drops) {
  const parts=[];
  for (const [mat,qty] of Object.entries(drops)) { const m=MATERIALS[mat]; if(m) parts.push(`${m.emoji}**${m.name}**×${qty}`); }
  return parts.length ? parts.join(" ") : "없음";
}
function getWeaponStats(player) {
  if (!player.equippedWeapon) return {atk:0,def:0,hp:0};
  const w=WEAPONS[player.equippedWeapon]; if(!w) return {atk:0,def:0,hp:0};
  return {atk:w.atkBonus,def:w.defBonus,hp:w.hpBonus};
}

// ════════════════════════════════════════════════════════
// ── 📋 퀘스트 시스템
// ════════════════════════════════════════════════════════
const DAILY_QUESTS = [
  {id:"dq_battle3", type:"battle_win",   target:3, name:"오늘의 수련",   desc:"전투 3회 승리",           reward:{crystals:80, xp:150,materials:{iron_fragment:3}}},
  {id:"dq_culling5",type:"culling_wave", target:5, name:"컬링 특훈",     desc:"컬링 5웨이브 달성",       reward:{crystals:100,xp:200,materials:{cursed_thread:5}}},
  {id:"dq_jujutsu3",type:"jujutsu_point",target:3,name:"사멸회유 임무", desc:"사멸회유 3포인트",        reward:{crystals:90, xp:180,materials:{cursed_bone:2}}},
  {id:"dq_skill5",  type:"skill_use",    target:5, name:"술식 연마",     desc:"술식 5회 사용",           reward:{crystals:70, xp:130,materials:{cursed_thread:3,iron_fragment:2}}},
  {id:"dq_gacha1",  type:"gacha_pull",   target:1, name:"운명의 소환",   desc:"가챠 1회 소환",           reward:{crystals:60, xp:100,materials:{iron_fragment:5}}},
  {id:"dq_nokill2", type:"boss_kill",    target:2, name:"정예 사냥",     desc:"특급 저주령 이상 2마리",  reward:{crystals:150,xp:300,materials:{cursed_core:1}}},
];
const WEEKLY_QUESTS = [
  {id:"wq_battle20", type:"battle_win",   target:20,name:"주간 전사",      desc:"전투 20회 승리",          reward:{crystals:500, xp:1000,materials:{cursed_core:3,spirit_essence:2}}},
  {id:"wq_culling15",type:"culling_wave", target:15,name:"컬링 마스터",    desc:"컬링 15웨이브 달성",      reward:{crystals:600, xp:1200,materials:{cursed_crystal:1,cursed_bone:8}}},
  {id:"wq_jujutsu15",type:"jujutsu_point",target:15,name:"사멸회유 전문가",desc:"사멸회유 15포인트",       reward:{crystals:550, xp:1100,materials:{spirit_essence:4,cursed_core:2}}},
  {id:"wq_boss5",    type:"boss_kill",    target:5, name:"보스 사냥꾼",    desc:"특급 이상 5마리",         reward:{crystals:700, xp:1400,materials:{dragon_scale:1,cursed_crystal:1}}},
  {id:"wq_craft1",   type:"weapon_craft", target:1, name:"주구 장인",      desc:"주구 1개 제작",           reward:{crystals:400, xp:800, materials:{spirit_essence:3,dragon_scale:1}}},
  {id:"wq_pvpwin3",  type:"pvp_win",      target:3, name:"결투 챔피언",    desc:"PvP 3회 승리",            reward:{crystals:800, xp:1600,materials:{cursed_crystal:2,dragon_scale:1}}},
];
function getTodayKey() { const d=new Date(); return `${d.getUTCFullYear()}-${d.getUTCMonth()+1}-${d.getUTCDate()}`; }
function getWeekKey() { const d=new Date(); const w=new Date(d); w.setUTCDate(d.getUTCDate()-d.getUTCDay()); return `${w.getUTCFullYear()}-${w.getUTCMonth()+1}-${w.getUTCDate()}`; }
function initQuests(player) {
  const today=getTodayKey(), week=getWeekKey();
  if (!player.quests) player.quests={};
  if (player.quests.dailyKey!==today) { player.quests.dailyKey=today; const p=[...DAILY_QUESTS].sort(()=>Math.random()-0.5).slice(0,3); player.quests.daily=p.map(q=>({id:q.id,progress:0,done:false,claimed:false})); }
  if (player.quests.weekKey!==week)   { player.quests.weekKey=week;   const p=[...WEEKLY_QUESTS].sort(()=>Math.random()-0.5).slice(0,3);player.quests.weekly=p.map(q=>({id:q.id,progress:0,done:false,claimed:false})); }
  if (!player.quests.daily)  player.quests.daily=[];
  if (!player.quests.weekly) player.quests.weekly=[];
}
function updateQuestProgress(player, type, amount=1) {
  initQuests(player);
  for (const qp of player.quests.daily) { if(qp.done) continue; const def=DAILY_QUESTS.find(q=>q.id===qp.id); if(!def||def.type!==type) continue; qp.progress=Math.min(qp.progress+amount,def.target); if(qp.progress>=def.target) qp.done=true; }
  for (const qp of player.quests.weekly){ if(qp.done) continue; const def=WEEKLY_QUESTS.find(q=>q.id===qp.id); if(!def||def.type!==type) continue; qp.progress=Math.min(qp.progress+amount,def.target); if(qp.progress>=def.target) qp.done=true; }
}
function claimQuestReward(player, questId, isWeekly=false) {
  initQuests(player);
  const list=isWeekly?player.quests.weekly:player.quests.daily;
  const allDefs=isWeekly?WEEKLY_QUESTS:DAILY_QUESTS;
  const qp=list.find(q=>q.id===questId); if(!qp||!qp.done||qp.claimed) return null;
  const def=allDefs.find(q=>q.id===questId); if(!def) return null;
  qp.claimed=true;
  player.crystals+=def.reward.crystals||0; player.xp+=def.reward.xp||0;
  if(def.reward.materials) addMaterials(player,def.reward.materials);
  return def.reward;
}

// ════════════════════════════════════════════════════════
// ── 🏆 주력 퀘스트 시스템 (완전 리메이크)
// ── 캐릭터별 고유 퀘스트 체인으로 주력 스킬 해금
// ════════════════════════════════════════════════════════
const MAIN_SKILL_QUESTS = {
  itadori: {
    skillName: "세계참(世界斬)",
    skillDesc: "스쿠나의 궁극기 — 세계를 베어버린다! 최강의 공격력.",
    skillDmg: 700,
    chain: [
      { step:0, name:"🩸 그릇의 각성",   desc:"스쿠나 손가락 5개 삼키기",              type:"sukuna_fingers",  target:5,  story:"\"남은 건 내가 어떻게 죽느냐다.\" 손가락이 늘수록 스쿠나의 목소리가 선명해진다.", reward:{crystals:300,xp:500} },
      { step:1, name:"💀 공존의 대가",   desc:"특급 저주령 5마리 처치",                type:"boss_kill",       target:5,  story:"스쿠나가 몸을 빌려 싸우기 시작한다. \"네 몸은 내 것이다.\"", reward:{crystals:500,xp:800} },
      { step:2, name:"👑 세계참 각성",   desc:"PvP 3회 승리 (손가락 10개 이상 필요)",  type:"pvp_win",         target:3,  story:"\"세계참 — 세계조차 베어버리겠다.\" 이타도리와 스쿠나의 의지가 하나로 합쳐진다.", reward:{crystals:1000,xp:2000}, prereqFingers:10 },
    ],
  },
  gojo: {
    skillName: "자폭 무라사키(紫)",
    skillDesc: "전 재산 방출 — HP가 1이 되지만 압도적 파괴력!",
    skillDmg: 640,
    chain: [
      { step:0, name:"🔵 무한의 경지",   desc:"전투 20회 승리",       type:"battle_win",      target:20, story:"\"아오와 아카를 동시에 다루면...\" 고조는 위험한 실험을 시작한다.", reward:{crystals:400,xp:600} },
      { step:1, name:"🔴 극한 집중",    desc:"컬링 WAVE 10 달성",    type:"culling_wave_max", target:10, story:"수백의 저주령을 처리하며 무라사키 완성에 필요한 극한의 집중력을 익힌다.", reward:{crystals:600,xp:1000} },
      { step:2, name:"💥 자폭 무라사키",desc:"PvP 특급 상대 2회 승리",type:"pvp_win_sp",       target:2,  story:"\"전 재산을 쏟아붓는다. 이게 내 최강이다.\" HP 1 — 대신 세계를 소멸시킨다.", reward:{crystals:1200,xp:2500} },
    ],
  },
  sukuna: {
    skillName: "복마어주자 진형(伏魔御廚子)",
    skillDesc: "천지개벽의 영역전개 — 이 영역 안에서 신이 된다.",
    skillDmg: 750,
    chain: [
      { step:0, name:"✂️ 해(解) 완성",  desc:"술식 30회 사용",       type:"skill_use",       target:30, story:"\"닥치고 배워라. 해(解)는 만물을 베는 기본이다.\"", reward:{crystals:300,xp:500} },
      { step:1, name:"🌌 팔(捌) 개방",  desc:"보스 10마리 처치",     type:"boss_kill",       target:10, story:"공간 자체를 베어내는 팔(捌) — 저주의 왕의 서명.", reward:{crystals:600,xp:1000} },
      { step:2, name:"👑 천지개벽",    desc:"사멸회유 클리어 2회",   type:"jujutsu_clear",   target:2,  story:"\"이 영역 안에서는 내가 신이다.\" 이타도리의 육체를 완전히 지배하는 순간.", reward:{crystals:1500,xp:3000} },
    ],
  },
  megumi: {
    skillName: "마허라가라 강림",
    skillDesc: "최강의 식신이 완전한 형태로 강림한다.",
    skillDmg: 520,
    chain: [
      { step:0, name:"🐺 식신의 주인", desc:"전투 15회 승리",         type:"battle_win",      target:15, story:"\"식신은 나의 분신이다.\" 열 가지 식신을 하나씩 각성시킨다.", reward:{crystals:300,xp:500} },
      { step:1, name:"🌑 강압암예정",  desc:"컬링 WAVE 12 달성",     type:"culling_wave_max", target:12, story:"영역전개 강압암예정(嵌合暗翳庭) — 이 영역 안에서 모든 식신이 각성한다.", reward:{crystals:500,xp:900} },
      { step:2, name:"🌟 마허라가라",  desc:"PvP 3회 승리",           type:"pvp_win",         target:3,  story:"\"후루베 유라유라토 후루베!\" 최강의 식신이 완전한 형태로 소환된다.", reward:{crystals:1200,xp:2500} },
    ],
  },
  nanami: {
    skillName: "무제한 초과근무",
    skillDesc: "한계를 넘어선 폭발적 강화 — 쿨다운 없이 3회 연속 술식!",
    skillDmg: 480,
    chain: [
      { step:0, name:"🟡 의무의 무게",  desc:"전투 25회 승리",        type:"battle_win",      target:25, story:"\"초과근무는 사절. 하지만 이건 의무다.\" 나나미는 묵묵히 저주령을 쓰러뜨린다.", reward:{crystals:350,xp:600} },
      { step:1, name:"⚖️ 칠할삼분 극의",desc:"사멸회유 포인트 20",   type:"jujutsu_point",   target:20, story:"7:3 지점 — 어떤 존재든 약점이 있다. 나나미의 분석이 극에 달한다.", reward:{crystals:600,xp:1000} },
      { step:2, name:"🔥 무제한 초과", desc:"컬링 WAVE 15 달성",      type:"culling_wave_max", target:15, story:"\"한계 따위 — 없다.\" 나나미가 처음으로 자신의 모든 저주 에너지를 해방시킨다.", reward:{crystals:1200,xp:2500} },
    ],
  },
  yuta: {
    skillName: "진안상애 완전해방",
    skillDesc: "리카 완전해방 — 저주의 여왕이 전력으로 싸운다.",
    skillDmg: 600,
    chain: [
      { step:0, name:"💜 사랑의 저주",  desc:"전투 20회 승리",        type:"battle_win",      target:20, story:"\"리카, 나는 아직 살아야 해.\" 유타는 리카의 힘을 점점 능숙하게 다룬다.", reward:{crystals:400,xp:700} },
      { step:1, name:"♾️ 모방의 완성",  desc:"술식 40회 사용",        type:"skill_use",       target:40, story:"모방술식(模倣術式) 극의 — 어떤 술식이든 단 한 번에 완벽히 재현한다.", reward:{crystals:600,xp:1000} },
      { step:2, name:"👑 진안상애 해방",desc:"PvP 특급 상대 2회 승리",type:"pvp_win_sp",       target:2,  story:"\"리카, 해방돼줘 — 전부!\" 영역 안에서 저주의 여왕이 완전히 해방된다.", reward:{crystals:1200,xp:2500} },
    ],
  },
};

// 주력 퀘스트 진행도 가져오기 / 초기화
function getMQProgress(player, charId) {
  if (!player.mqProgress) player.mqProgress = {};
  if (!player.mqProgress[charId]) player.mqProgress[charId] = { step:0, progress:0, completed:[] };
  return player.mqProgress[charId];
}
function getCurrentMQ(player, charId) {
  const chain = MAIN_SKILL_QUESTS[charId]?.chain;
  if (!chain) return null;
  const prog = getMQProgress(player, charId);
  if (prog.step >= chain.length) return null;
  return chain[prog.step];
}
function updateMQProgress(player, type, amount=1, extraInfo={}) {
  const charId = player.active;
  const mq = MAIN_SKILL_QUESTS[charId];
  if (!mq) return;
  const quest = getCurrentMQ(player, charId);
  if (!quest) return;
  const prog = getMQProgress(player, charId);

  // 손가락 선결 조건 체크
  if (quest.prereqFingers && (player.sukunaFingers||0) < quest.prereqFingers) return;

  const matches = (qt, t) => {
    if (qt === t) return true;
    if (qt === "pvp_win_sp" && t === "pvp_win_sp") return true;
    if (qt === "culling_wave_max" && t === "culling_wave_max") return true;
    if (qt === "jujutsu_clear" && t === "jujutsu_clear") return true;
    if (qt === "sukuna_fingers" && t === "sukuna_fingers") return true;
    return false;
  };
  if (!matches(quest.type, type)) return;
  prog.progress = Math.min((prog.progress||0)+amount, quest.target);
}
function tryCompleteMQ(player) {
  const charId = player.active;
  const mq = MAIN_SKILL_QUESTS[charId];
  if (!mq) return null;
  const quest = getCurrentMQ(player, charId);
  if (!quest) return null;
  const prog = getMQProgress(player, charId);
  if ((prog.progress||0) < quest.target) return null;

  // 완료 처리
  prog.step++;
  prog.progress = 0;
  prog.completed.push(quest.step);
  player.crystals += quest.reward?.crystals||0;
  player.xp       += quest.reward?.xp||0;

  // 마지막 단계면 주력 스킬 해금
  const chain = mq.chain;
  if (prog.step >= chain.length) {
    if (!player.mainSkillUnlocked) player.mainSkillUnlocked = {};
    player.mainSkillUnlocked[charId] = true;
  }
  return quest;
}

// ════════════════════════════════════════════════════════
// ── 스쿠나 손가락 시스템 (리메이크)
// ── 손가락 1개 이상 → 스쿠나 즉시 획득
// ── 손가락 수에 따라 단계적 강화
// ════════════════════════════════════════════════════════
const SUKUNA_FINGER_MAX = 20;
const SUKUNA_STAGES = [
  { min:0,  label:"봉인 중",               color:"⬛", atkBonus:0,   defBonus:0,  hpBonus:0,    dmgMult:1.00, desc:"스쿠나가 잠들어 있다." },
  { min:1,  label:"Lv.1 — 봉인 해제",      color:"🟩", atkBonus:15,  defBonus:10, hpBonus:300,  dmgMult:1.05, desc:"스쿠나가 이타도리 안에서 눈을 떴다." },
  { min:3,  label:"Lv.2 — 기억 회복",      color:"🟨", atkBonus:30,  defBonus:20, hpBonus:600,  dmgMult:1.12, desc:"스쿠나의 기억과 힘이 조금씩 되살아난다." },
  { min:5,  label:"Lv.3 — 해(解) 각성",    color:"🟧", atkBonus:50,  defBonus:35, hpBonus:1000, dmgMult:1.20, desc:"저주의 왕의 손톱이 공간을 베기 시작한다." },
  { min:8,  label:"Lv.4 — 팔(捌) 개방",    color:"🟥", atkBonus:80,  defBonus:55, hpBonus:1600, dmgMult:1.30, desc:"공간 자체를 찢어버리는 팔(捌)이 해방된다." },
  { min:10, label:"Lv.5 — 지배 각성",      color:"🔴", atkBonus:100, defBonus:70, hpBonus:2000, dmgMult:1.40, desc:"이타도리의 몸에 대한 지배력이 극적으로 커진다." },
  { min:15, label:"Lv.6 — 복마어주자",     color:"🟣", atkBonus:130, defBonus:90, hpBonus:2800, dmgMult:1.55, desc:"천지개벽 영역전개가 가능해진다." },
  { min:20, label:"Lv.MAX — 저주의 왕",    color:"🔱", atkBonus:160, defBonus:110,hpBonus:3500, dmgMult:1.70, desc:"양면숙나(両面宿儺) — 역사상 최강의 주술사." },
];
function getFingerStage(fingers) {
  let s = SUKUNA_STAGES[0];
  for (const st of SUKUNA_STAGES) { if (fingers >= st.min) s = st; }
  return s;
}
function getFingerBonus(fingers) {
  const s = getFingerStage(fingers);
  return { atkBonus:s.atkBonus, defBonus:s.defBonus, hpBonus:s.hpBonus, dmgMult:s.dmgMult, label:s.label, color:s.color, desc:s.desc };
}
// 손가락 획득 시 스쿠나 즉시 해금
function checkSukunaUnlock(player) {
  const fingers = player.sukunaFingers||0;
  if (fingers >= 1 && !player.owned.includes("sukuna")) {
    player.owned.push("sukuna");
    if (!player.mastery) player.mastery = {};
    if (!player.mastery.sukuna) player.mastery.sukuna = 0;
    return true; // 새로 해금됨
  }
  return false;
}

// ════════════════════════════════════════════════════════
// ── 코가네 펫
// ════════════════════════════════════════════════════════
const KOGANE_GRADES = {
  "전설":{ color:0xF5C842,emoji:"🌟",stars:"★★★★★",rate:0.5, atkBonus:0.25,defBonus:0.20,hpBonus:0.20,xpBonus:0.30,crystalBonus:0.25,skill:"황금 포효",skillDesc:"전투 시작 시 ATK 50% 추가 피해",skillChance:0.35,passiveDesc:"ATK+25% DEF+20% HP+20% XP+30% 크리스탈+25%"},
  "특급":{ color:0xff8c00,emoji:"🔶",stars:"★★★★☆",rate:2.0, atkBonus:0.18,defBonus:0.15,hpBonus:0.15,xpBonus:0.20,crystalBonus:0.18,skill:"황금 이빨",skillDesc:"공격 시 15% 확률로 약화",skillChance:0.15,passiveDesc:"ATK+18% DEF+15% HP+15% XP+20% 크리스탈+18%"},
  "1급": { color:0x7C5CFC,emoji:"🔷",stars:"★★★☆☆",rate:8.0, atkBonus:0.12,defBonus:0.10,hpBonus:0.10,xpBonus:0.12,crystalBonus:0.10,skill:"황금 발톱",skillDesc:"공격 시 10% 확률로 추가타",skillChance:0.10,passiveDesc:"ATK+12% DEF+10% HP+10% XP+12% 크리스탈+10%"},
  "2급": { color:0x4ade80,emoji:"🟢",stars:"★★☆☆☆",rate:22.5,atkBonus:0.07,defBonus:0.06,hpBonus:0.06,xpBonus:0.07,crystalBonus:0.06,skill:"황금 보호막",skillDesc:"HP 30% 이하 시 피해 50% 감소",skillChance:1.0, passiveDesc:"ATK+7% DEF+6% HP+6% XP+7% 크리스탈+6%"},
  "3급": { color:0x94a3b8,emoji:"⚪",stars:"★☆☆☆☆",rate:67.0,atkBonus:0.03,defBonus:0.02,hpBonus:0.02,xpBonus:0.03,crystalBonus:0.02,skill:"황금 냄새",skillDesc:"전투 후 크리스탈 +5%",skillChance:1.0, passiveDesc:"ATK+3% DEF+2% HP+2% XP+3% 크리스탈+2%"},
};
const KOGANE_POOL = [{grade:"전설",rate:0.5},{grade:"특급",rate:2.0},{grade:"1급",rate:8.0},{grade:"2급",rate:22.5},{grade:"3급",rate:67.0}];
function rollKogane() {
  const total=KOGANE_POOL.reduce((s,p)=>s+p.rate,0); let roll=Math.random()*total;
  for (const e of KOGANE_POOL) { roll-=e.rate; if(roll<=0) return e.grade; }
  return "3급";
}
function getKoganeBonus(player) {
  if (!player.kogane?.grade) return {atk:1,def:1,hp:1,xp:1,crystal:1};
  const g=KOGANE_GRADES[player.kogane.grade]; if(!g) return {atk:1,def:1,hp:1,xp:1,crystal:1};
  return {atk:1+g.atkBonus,def:1+g.defBonus,hp:1+g.hpBonus,xp:1+g.xpBonus,crystal:1+g.crystalBonus};
}

// ════════════════════════════════════════════════════════
// ── 상태이상
// ════════════════════════════════════════════════════════
const STATUS_EFFECTS = {
  poison:        {id:"poison",        name:"독",      emoji:"☠️",  desc:"매 턴 최대HP의 5% 피해",         duration:3},
  burn:          {id:"burn",          name:"화상",    emoji:"🔥",  desc:"매 턴 최대HP의 8% 피해",         duration:2},
  freeze:        {id:"freeze",        name:"빙결",    emoji:"❄️",  desc:"1턴 행동 불가",                  duration:1},
  weaken:        {id:"weaken",        name:"약화",    emoji:"💔",  desc:"공격력 30% 감소",                duration:2},
  stun:          {id:"stun",          name:"기절",    emoji:"⚡",  desc:"1턴 행동 불가",                  duration:1},
  battleInstinct:{id:"battleInstinct",name:"전투본능",emoji:"🔥💪",desc:"공격력 40%↑ 회피율 25%↑",       duration:3},
  cursed_wound:  {id:"cursed_wound",  name:"저주상처",emoji:"🩸",  desc:"매 턴 최대HP의 10% 피해",        duration:2},
  blind:         {id:"blind",         name:"실명",    emoji:"🌑",  desc:"명중률 50% 감소",                duration:2},
};
function applyStatus(target, statusId) {
  if (!target.statusEffects) target.statusEffects=[];
  const existing=target.statusEffects.find(s=>s.id===statusId);
  if (existing) existing.turns=STATUS_EFFECTS[statusId].duration;
  else target.statusEffects.push({id:statusId,turns:STATUS_EFFECTS[statusId].duration});
}
function tickStatus(target, maxHp) {
  if (!target.statusEffects||target.statusEffects.length===0) return {dmg:0,expired:[],log:[]};
  let totalDmg=0; const expired=[],log=[];
  for (const se of target.statusEffects) {
    const def=STATUS_EFFECTS[se.id]; if(!def){se.turns=0;continue;}
    if(se.id==="poison")       {const d=Math.max(1,Math.floor(maxHp*0.05));totalDmg+=d;log.push(`${def.emoji}**${def.name}** — **${d}** 피해!`);}
    if(se.id==="burn")         {const d=Math.max(1,Math.floor(maxHp*0.08));totalDmg+=d;log.push(`${def.emoji}**${def.name}** — **${d}** 피해!`);}
    if(se.id==="cursed_wound") {const d=Math.max(1,Math.floor(maxHp*0.10));totalDmg+=d;log.push(`${def.emoji}**${def.name}** — **${d}** 피해!`);}
    se.turns--;
    if(se.turns<=0) expired.push(se.id);
  }
  target.statusEffects=target.statusEffects.filter(s=>s.turns>0);
  if(totalDmg>0) target.hp=Math.max(0,target.hp-totalDmg);
  return {dmg:totalDmg,expired,log};
}
function statusStr(se) {
  if (!se||se.length===0) return "없음";
  return se.map(s=>`${STATUS_EFFECTS[s.id]?.emoji||""}${STATUS_EFFECTS[s.id]?.name||s.id}(${s.turns}턴)`).join(" ");
}
function isIncapacitated(se) { return !!(se&&se.some(s=>s.id==="freeze"||s.id==="stun")); }
function isBlind(se)          { return !!(se&&se.some(s=>s.id==="blind")); }
function getWeakenMult(se)    { let m=1; if(se&&se.some(s=>s.id==="weaken"))m*=0.7; if(se&&se.some(s=>s.id==="battleInstinct"))m*=1.4; return m; }
function getBattleInstinctEvade(se) { return !!(se&&se.some(s=>s.id==="battleInstinct")); }
function rollHit(aSe,dSe) {
  if(isBlind(aSe)&&Math.random()<0.50) return false;
  return Math.random()>(0.05+(getBattleInstinctEvade(dSe)?0.25:0));
}

// ════════════════════════════════════════════════════════
// ── 흑섬 / 스킬 이펙트 (완전 복구 + 고퀄)
// ════════════════════════════════════════════════════════
function isBlackFlash() { return Math.random()<0.10; }
function getBlackFlashArt() {
  return [
    "```ansi",
    "\u001b[1;30m╔══════════════════════════════════════════╗",
    "\u001b[1;31m║  ██████╗ ██╗      █████╗  ██████╗██╗  ██╗║",
    "\u001b[1;31m║  ██╔══██╗██║     ██╔══██╗██╔════╝██║ ██╔╝║",
    "\u001b[1;33m║  ██████╔╝██║     ███████║██║     █████╔╝ ║",
    "\u001b[1;33m║  ██╔══██╗██║     ██╔══██║██║     ██╔═██╗ ║",
    "\u001b[1;31m║  ██████╔╝███████╗██║  ██║╚██████╗██║  ██╗║",
    "\u001b[1;31m║  ╚═════╝ ╚══════╝╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝║",
    "\u001b[1;30m╠══════════════════════════════════════════╣",
    "\u001b[1;33m║        ⚫  B L A C K   F L A S H  ⚫       ║",
    "\u001b[1;31m║       저주 에너지 순간 최대 방출!! ×2.5    ║",
    "\u001b[1;30m╚══════════════════════════════════════════╝",
    "```",
  ].join("\n");
}

// 고퀄 스킬 이펙트 (ANSI 아트 포함)
const SKILL_EFFECTS = {
  "주먹질": {
    art: ["```ansi","\u001b[1;31m    ╔═══════╗","\u001b[1;31m    ║  💥 💥 ║","\u001b[1;33m    ║ ▓▓▓▓▓ ║","\u001b[1;31m    ║  💥 💥 ║","\u001b[1;31m    ╚═══════╝","```"].join("\n"),
    color:0xff6b35, flavorText:"저주 에너지를 주먹에 집중시킨다!"
  },
  "다이버전트 주먹": {
    art: ["```ansi","\u001b[1;31m ⚡\u001b[1;33m💥\u001b[1;31m⚡\u001b[1;33m💥\u001b[1;31m⚡","\u001b[1;33m▓▓▓\u001b[1;31m【発散】\u001b[1;33m▓▓▓","\u001b[1;31m ⚡\u001b[1;33m💥\u001b[1;31m⚡\u001b[1;33m💥\u001b[1;31m⚡","```"].join("\n"),
    color:0xff4500, flavorText:"발산하는 저주 에너지 — 몸의 내부에서 폭발!"
  },
  "흑섬": {
    art: ["```ansi","\u001b[1;30m🌑🌑🌑🌑🌑🌑🌑","\u001b[1;35m⬛\u001b[1;31m 黒 \u001b[1;35m閃 \u001b[1;31m⬛","\u001b[1;30m🌑🌑🌑🌑🌑🌑🌑","```"].join("\n"),
    color:0x1a0a2e, flavorText:"순간적으로 발산되는 최대 저주 에너지!"
  },
  "어주자": {
    art: ["```ansi","\u001b[1;31m👹\u001b[1;33m✨\u001b[1;31m👹\u001b[1;33m✨\u001b[1;31m👹","\u001b[1;33m✨\u001b[1;31m 廻 夏 \u001b[1;33m✨","\u001b[1;31m👹\u001b[1;33m✨\u001b[1;31m👹\u001b[1;33m✨\u001b[1;31m👹","```"].join("\n"),
    color:0xb5451b, flavorText:"스쿠나의 힘이 몸을 가득 채운다..."
  },
  "스쿠나 발현": {
    art: ["```ansi","\u001b[1;31m🔴\u001b[1;33m👹\u001b[1;31m🔴\u001b[1;33m👹\u001b[1;31m🔴","\u001b[1;33m👹\u001b[1;31m 両面宿儺 \u001b[1;33m👹","\u001b[1;31m🔴\u001b[1;33m👹\u001b[1;31m🔴\u001b[1;33m👹\u001b[1;31m🔴","```"].join("\n"),
    color:0x8b0000, flavorText:"저주의 왕이 이타도리의 몸을 장악한다!"
  },
  "아오": {
    art: ["```ansi","\u001b[1;34m  🔵🔵🔵  ","\u001b[1;36m🔵\u001b[1;34m  蒼  \u001b[1;36m🔵","\u001b[1;34m  🔵🔵🔵  ","```"].join("\n"),
    color:0x0066ff, flavorText:"무한에 의한 인력 — 모든 것을 끌어당긴다"
  },
  "아카": {
    art: ["```ansi","\u001b[1;31m  🔴🔴🔴  ","\u001b[1;33m🔴\u001b[1;31m  赫  \u001b[1;33m🔴","\u001b[1;31m  🔴🔴🔴  ","```"].join("\n"),
    color:0xff0033, flavorText:"무한에 의한 척력 — 모든 것을 날려버린다"
  },
  "무라사키": {
    art: ["```ansi","\u001b[1;31m🔴\u001b[1;34m⚡\u001b[1;35m🔵\u001b[1;34m⚡\u001b[1;31m🔴","\u001b[1;35m⚡\u001b[1;31m  紫  \u001b[1;35m⚡","\u001b[1;34m🔵\u001b[1;31m⚡\u001b[1;35m🔴\u001b[1;31m⚡\u001b[1;34m🔵","```"].join("\n"),
    color:0x9900ff, flavorText:"아오와 아카의 융합 — 허공을 찢는 허수!"
  },
  "무량공처": {
    art: ["```ansi","\u001b[1;36m∞∞∞∞∞∞∞∞∞","\u001b[1;37m∞\u001b[1;36m 無量空処 \u001b[1;37m∞","\u001b[1;36m∞∞∞∞∞∞∞∞∞","```"].join("\n"),
    color:0x00ffff, flavorText:"\"나는 최강이니까\" — 무한이 세계를 지배한다"
  },
  "자폭 무라사키": {
    art: ["```ansi","\u001b[1;31m💥🔴\u001b[1;34m💥🔵\u001b[1;31m💥","\u001b[1;31m💥\u001b[1;35m 自爆 紫 \u001b[1;31m💥","\u001b[1;34m💥🔵\u001b[1;31m💥🔴\u001b[1;34m💥","```"].join("\n"),
    color:0xff0000, flavorText:"모든 힘을 쏟아붓는 자폭 공격!"
  },
  "해": {
    art: ["```ansi","\u001b[1;31m  ✂️✂️✂️  ","\u001b[1;31m✂️\u001b[1;33m  解  \u001b[1;31m✂️","\u001b[1;31m  ✂️✂️✂️  ","```"].join("\n"),
    color:0xcc0000, flavorText:"만물을 베어내는 저주의 왕의 손톱!"
  },
  "팔": {
    art: ["```ansi","\u001b[1;35m🌌\u001b[1;31m✂️\u001b[1;35m🌌\u001b[1;31m✂️\u001b[1;35m🌌","\u001b[1;31m✂️\u001b[1;33m  捌  \u001b[1;31m✂️","\u001b[1;35m🌌\u001b[1;31m✂️\u001b[1;35m🌌\u001b[1;31m✂️\u001b[1;35m🌌","```"].join("\n"),
    color:0x8b0000, flavorText:"공간 자체를 베어내는 절대적 술식!"
  },
  "푸가": {
    art: ["```ansi","\u001b[1;31m💀🔥\u001b[1;33m💀🔥\u001b[1;31m💀","\u001b[1;31m🔥\u001b[1;33m 不 雅 \u001b[1;31m🔥","\u001b[1;33m💀🔥\u001b[1;31m💀🔥\u001b[1;33m💀","```"].join("\n"),
    color:0x4a0000, flavorText:"닿는 모든 것을 분해한다!"
  },
  "복마어주자": {
    art: ["```ansi","\u001b[1;31m👑🌑\u001b[1;33m👑\u001b[1;31m🌑👑","\u001b[1;31m🌑\u001b[1;33m伏魔御廚子\u001b[1;31m🌑","\u001b[1;33m👑\u001b[1;31m🌑👑\u001b[1;33m🌑\u001b[1;31m👑","```"].join("\n"),
    color:0x2a0000, flavorText:"천지개벽 — 저주의 왕의 궁극 영역전개!"
  },
  "복마어주자 진형": {
    art: ["```ansi","\u001b[1;31m╔════════════════════╗","\u001b[1;33m║  👑 伏魔御廚子 👑  ║","\u001b[1;31m║   천 지 개 벽 !    ║","\u001b[1;31m╚════════════════════╝","```"].join("\n"),
    color:0x1a0000, flavorText:"이 영역 안에서는 내가 신이다!"
  },
  "세계참": {
    art: ["```ansi","\u001b[1;35m🌍\u001b[1;31m✂️\u001b[1;35m🌍\u001b[1;31m✂️\u001b[1;35m🌍","\u001b[1;31m✂️\u001b[1;33m 世界斬 \u001b[1;31m✂️","\u001b[1;35m🌍\u001b[1;31m✂️\u001b[1;35m🌍\u001b[1;31m✂️\u001b[1;35m🌍","```"].join("\n"),
    color:0x4a0000, flavorText:"세계조차 베어버린다!"
  },
  "부기우기": {
    art: ["```ansi","\u001b[1;34m🎵\u001b[1;32m💪\u001b[1;34m🎵\u001b[1;32m💪\u001b[1;34m🎵","\u001b[1;32m💪\u001b[1;34m Boogie \u001b[1;32m💪","\u001b[1;34m🎵\u001b[1;32m💪\u001b[1;34m🎵\u001b[1;32m💪\u001b[1;34m🎵","```"].join("\n"),
    color:0x1e90ff, flavorText:"\"댄스홀 가수!\" — 위치 전환! 빙결!"
  },
  "전투본능": {
    art: ["```ansi","\u001b[1;31m⚔️🔥\u001b[1;33m⚔️🔥\u001b[1;31m⚔️","\u001b[1;31m🔥\u001b[1;33m戦闘本能\u001b[1;31m🔥","\u001b[1;33m⚔️🔥\u001b[1;31m⚔️🔥\u001b[1;33m⚔️","```"].join("\n"),
    color:0xff8c00, flavorText:"전사의 본능이 각성한다! 공격력·회피 극대화!"
  },
  "험한 도박": {
    art: ["```ansi","\u001b[1;33m🎰🎰🎰🎰🎰","\u001b[1;31m  険 賭 博  ","\u001b[1;33m🎰🎰🎰🎰🎰","```"].join("\n"),
    color:0xffaa00, flavorText:"운에 맡긴 도박 공격!"
  },
  "질풍열차": {
    art: ["```ansi","\u001b[1;34m🚂💨🚂💨🚂","\u001b[1;36m  疾 風 列  ","\u001b[1;34m🚂💨🚂💨🚂","```"].join("\n"),
    color:0x44aaff, flavorText:"강력한 열차처럼 돌진!"
  },
  "유한 소설": {
    art: ["```ansi","\u001b[1;32m📖✨📖✨📖","\u001b[1;33m✨\u001b[1;32m 有限小説 \u001b[1;33m✨","\u001b[1;32m📖✨📖✨📖","```"].join("\n"),
    color:0x88ff88, flavorText:"불멸의 몸으로 싸운다!"
  },
  "질풍강운": {
    art: ["```ansi","\u001b[1;33m🎰🌪️\u001b[1;31m🎰🌪️\u001b[1;33m🎰","\u001b[1;31m🌪️\u001b[1;33m 疾風強運 \u001b[1;31m🌪️","\u001b[1;33m🎰🌪️\u001b[1;31m🎰🌪️\u001b[1;33m🎰","```"].join("\n"),
    color:0xffcc00, flavorText:"영역전개 — 운이 터진다!"
  },
  "마허라가라 강림": {
    art: ["```ansi","\u001b[1;30m╔════════════════════╗","\u001b[1;35m║  🌟 摩虎羅 강림 🌟  ║","\u001b[1;33m║   최강의 식신 해방!  ║","\u001b[1;30m╚════════════════════╝","```"].join("\n"),
    color:0x7C5CFC, flavorText:"후루베 유라유라토 후루베!"
  },
  "무제한 초과근무": {
    art: ["```ansi","\u001b[1;33m╔════════════════════╗","\u001b[1;33m║  🟡 超過勤務 解放  ║","\u001b[1;31m║   한계 따위 없다!   ║","\u001b[1;33m╚════════════════════╝","```"].join("\n"),
    color:0xF5C842, flavorText:"한계를 넘어선 폭발적 강화!"
  },
  "진안상애 완전해방": {
    art: ["```ansi","\u001b[1;35m╔════════════════════╗","\u001b[1;35m║  💜 真愛相愛 解放  ║","\u001b[1;33m║  리카, 전부 해방!   ║","\u001b[1;35m╚════════════════════╝","```"].join("\n"),
    color:0xff69b4, flavorText:"리카, 해방돼줘 — 전부!"
  },
  "_default": {
    art: ["```ansi","\u001b[1;35m  ✨✨✨  ","\u001b[1;35m✨\u001b[1;33m 術 式 \u001b[1;35m✨","\u001b[1;35m  ✨✨✨  ","```"].join("\n"),
    color:0x7c5cfc, flavorText:"저주 에너지가 폭발한다!"
  },
};
function getSkillEffect(name) { return SKILL_EFFECTS[name]||SKILL_EFFECTS["_default"]; }

// ════════════════════════════════════════════════════════
// ── 캐릭터 데이터
// ════════════════════════════════════════════════════════
const CHARACTERS = {
  itadori:{name:"이타도리 유지",emoji:"🟠",grade:"준1급",atk:90,def:75,spd:85,maxHp:1000,domain:null,desc:"특급주술사 후보생. 스쿠나의 손가락을 삼킨 그릇.",lore:"\"남은 건 내가 어떻게 죽느냐다.\"",fingerSkills:true,
    skills:[
      {name:"주먹질",         minMastery:0,  dmg:95,  desc:"강력한 기본 주먹 공격."},
      {name:"다이버전트 주먹",minMastery:5,  dmg:160, desc:"저주 에너지를 실은 주먹.",statusApply:{target:"enemy",statusId:"stun",chance:0.3}},
      {name:"흑섬",           minMastery:15, dmg:240, desc:"최대 저주 에너지 방출!",statusApply:{target:"enemy",statusId:"weaken",chance:0.5}},
      {name:"어주자",         minMastery:30, dmg:340, desc:"스쿠나의 힘을 빌린 궁극기.",statusApply:{target:"enemy",statusId:"burn",chance:0.7}},
      {name:"스쿠나 발현",    minMastery:50, dmg:520, desc:"스쿠나가 몸을 장악! 10손가락 이상 필요.",statusApply:{target:"enemy",statusId:"freeze",chance:0.8}},
    ]},
  gojo:{name:"고조 사토루",emoji:"🔵",grade:"특급",atk:130,def:120,spd:110,maxHp:1800,domain:"무량공처",desc:"최강의 주술사. 무량공처를 구사한다.",lore:"\"사람들이 왜 내가 최강이라고 하는지 알아?\"",
    skills:[
      {name:"아오",    minMastery:0,  dmg:145,desc:"적들을 끌어당겨 공격."},
      {name:"아카",    minMastery:5,  dmg:220,desc:"적들을 날려 폭발.",statusApply:{target:"enemy",statusId:"burn",chance:0.5}},
      {name:"무라사키",minMastery:15, dmg:320,desc:"아오와 아카 융합.",statusApply:{target:"enemy",statusId:"weaken",chance:0.6}},
      {name:"무량공처",minMastery:30, dmg:480,desc:"무한을 지배하는 궁극술식.",statusApply:{target:"enemy",statusId:"freeze",chance:0.8}},
    ]},
  megumi:{name:"후시구로 메구미",emoji:"⚫",grade:"1급",atk:110,def:108,spd:100,maxHp:1250,domain:"강압암예정",desc:"식신술을 구사하는 주술사.",lore:"\"나는 선한 사람을 구하기 위해 싸운다.\"",
    skills:[
      {name:"옥견",           minMastery:0,  dmg:115,desc:"식신 옥견 소환."},
      {name:"탈토",           minMastery:5,  dmg:180,desc:"식신 대호 소환.",statusApply:{target:"enemy",statusId:"weaken",chance:0.4}},
      {name:"만상",           minMastery:15, dmg:265,desc:"열 가지 식신 소환.",statusApply:{target:"enemy",statusId:"poison",chance:0.5}},
      {name:"후루베 유라유라", minMastery:30, dmg:380,desc:"최강의 식신 마허라가라 강림.",statusApply:{target:"enemy",statusId:"stun",chance:0.6}},
    ]},
  nobara:{name:"쿠기사키 노바라",emoji:"🌸",grade:"1급",atk:115,def:95,spd:105,maxHp:1180,domain:null,desc:"영혼에 공격 가능한 주술사.",lore:"\"도쿄에 올 때부터 각오는 되어 있었어.\"",
    skills:[
      {name:"망치질",minMastery:0, dmg:118,desc:"저주 못을 박는다."},
      {name:"공명",  minMastery:5, dmg:195,desc:"허수아비를 통해 공명 피해.",statusApply:{target:"enemy",statusId:"poison",chance:0.5}},
      {name:"철정",  minMastery:15,dmg:280,desc:"저주 에너지 주입 못.",statusApply:{target:"enemy",statusId:"weaken",chance:0.5}},
      {name:"발화",  minMastery:30,dmg:390,desc:"모든 못에 동시 폭발.",statusApply:{target:"enemy",statusId:"burn",chance:0.8}},
    ]},
  nanami:{name:"나나미 켄토",emoji:"🟡",grade:"1급",atk:118,def:108,spd:90,maxHp:1380,domain:null,desc:"1급 주술사. 합리적 판단의 소유자.",lore:"\"초과 근무는 사절이지만... 이건 의무다.\"",
    skills:[
      {name:"둔기 공격",minMastery:0, dmg:120,desc:"단단한 둔기로 타격."},
      {name:"칠할삼분", minMastery:5, dmg:200,desc:"7:3 지점을 노린 약점 공격.",statusApply:{target:"enemy",statusId:"weaken",chance:0.6}},
      {name:"십수할",   minMastery:15,dmg:290,desc:"열 배의 저주 에너지 방출."},
      {name:"초과근무",  minMastery:30,dmg:410,desc:"한계를 넘어선 폭발적 강화."},
    ]},
  sukuna:{name:"료멘 스쿠나",emoji:"🔴",grade:"특급",atk:140,def:115,spd:120,maxHp:2500,domain:"복마어주자",desc:"저주의 왕. 역대 최강의 저주된 영혼.",lore:"\"약한 놈이 강한 놈을 거스르는 건 죄악이다.\"",
    skills:[
      {name:"해",      minMastery:0, dmg:145,desc:"날카로운 손톱으로 베어낸다.",statusApply:{target:"enemy",statusId:"burn",chance:0.4}},
      {name:"팔",      minMastery:5, dmg:235,desc:"공간 자체를 베어낸다.",statusApply:{target:"enemy",statusId:"weaken",chance:0.5}},
      {name:"푸가",    minMastery:15,dmg:345,desc:"닿는 모든 것을 분해.",statusApply:{target:"enemy",statusId:"poison",chance:0.7}},
      {name:"복마어주자",minMastery:30,dmg:500,desc:"천지개벽의 궁극 영역전개.",statusApply:{target:"enemy",statusId:"freeze",chance:0.9}},
    ]},
  geto:{name:"게토 스구루",emoji:"🟢",grade:"특급",atk:115,def:105,spd:100,maxHp:1600,domain:null,desc:"전 특급 주술사. 저주를 다루는 달인.",lore:"\"주술사는 비주술사를 지켜야 한다.\"",
    skills:[
      {name:"저주 방출",  minMastery:0, dmg:125,desc:"저급 저주령을 방출."},
      {name:"최대출력",   minMastery:5, dmg:210,desc:"저주령을 전력 방출.",statusApply:{target:"enemy",statusId:"poison",chance:0.4}},
      {name:"저주영조종", minMastery:15,dmg:300,desc:"수천의 저주령 조종.",statusApply:{target:"enemy",statusId:"weaken",chance:0.6}},
      {name:"감로대법",   minMastery:30,dmg:425,desc:"모든 저주 흡수.",statusApply:{target:"enemy",statusId:"stun",chance:0.5}},
    ]},
  maki:{name:"마키 젠인",emoji:"⚪",grade:"준1급",atk:122,def:110,spd:115,maxHp:1300,domain:null,desc:"저주력 없이도 강한 주술사. HP 30% 이하 천여주박 각성!",lore:"\"젠인 가문 — 내가 직접 끝내주지.\"",awakening:{threshold:0.30,dmgMult:2.0,label:"천여주박 각성"},
    skills:[
      {name:"봉술",    minMastery:0, dmg:122,desc:"저주 도구 봉으로 타격."},
      {name:"저주창",  minMastery:5, dmg:200,desc:"저주 도구 창 투척.",statusApply:{target:"enemy",statusId:"weaken",chance:0.4}},
      {name:"저주도구술",minMastery:15,dmg:285,desc:"다양한 저주 도구 구사.",statusApply:{target:"enemy",statusId:"burn",chance:0.5}},
      {name:"천개봉파", minMastery:30,dmg:400,desc:"수천의 저주 도구 연속 공격.",statusApply:{target:"enemy",statusId:"stun",chance:0.6}},
    ]},
  panda:{name:"판다",emoji:"🐼",grade:"2급",atk:105,def:118,spd:85,maxHp:1400,domain:null,desc:"저주로 만든 특이체질의 주술사.",lore:"\"난 판다야. 진짜 판다.\"",
    skills:[
      {name:"박치기",    minMastery:0, dmg:108,desc:"머리로 들이받는다.",statusApply:{target:"enemy",statusId:"stun",chance:0.2}},
      {name:"곰 발바닥", minMastery:5, dmg:175,desc:"두꺼운 발바닥으로 내리친다."},
      {name:"팬더 변신", minMastery:15,dmg:255,desc:"진짜 팬더로 변신해 공격.",statusApply:{target:"enemy",statusId:"weaken",chance:0.4}},
      {name:"고릴라 변신",minMastery:30,dmg:360,desc:"고릴라 형태로 폭발적 강화.",statusApply:{target:"enemy",statusId:"stun",chance:0.5}},
    ]},
  inumaki:{name:"이누마키 토게",emoji:"🟤",grade:"준1급",atk:112,def:90,spd:110,maxHp:1120,domain:null,desc:"주술언어를 구사하는 준1급 주술사.",lore:"\"연어알—\"",
    skills:[
      {name:"멈춰라",  minMastery:0, dmg:115,desc:"상대의 움직임 봉쇄.",statusApply:{target:"enemy",statusId:"freeze",chance:0.5}},
      {name:"달려라",  minMastery:5, dmg:180,desc:"상대를 무작위로 달리게.",statusApply:{target:"enemy",statusId:"weaken",chance:0.5}},
      {name:"주술언어",minMastery:15,dmg:265,desc:"강력한 주술 명령.",statusApply:{target:"enemy",statusId:"stun",chance:0.6}},
      {name:"폭발해라",minMastery:30,dmg:375,desc:"그 자리에서 폭발.",statusApply:{target:"enemy",statusId:"burn",chance:0.8}},
    ]},
  yuta:{name:"오코츠 유타",emoji:"🌟",grade:"특급",atk:128,def:112,spd:115,maxHp:1750,domain:"진안상애",desc:"특급 주술사. 리카의 저주를 다루는 최강급.",lore:"\"리카... 나는 아직 살아야 해.\"",
    skills:[
      {name:"모방술식",minMastery:0, dmg:135,desc:"다른 술식을 모방."},
      {name:"리카 소환",minMastery:5, dmg:220,desc:"저주의 여왕 리카를 소환.",statusApply:{target:"enemy",statusId:"weaken",chance:0.5}},
      {name:"순애빔",  minMastery:15,dmg:340,desc:"리카와의 사랑을 에너지로 발사.",statusApply:{target:"enemy",statusId:"burn",chance:0.6}},
      {name:"진안상애",minMastery:30,dmg:480,desc:"사랑으로 모든 것을 파괴.",statusApply:{target:"enemy",statusId:"freeze",chance:0.9}},
    ]},
  higuruma:{name:"히구루마 히로미",emoji:"⚖️",grade:"1급",atk:118,def:105,spd:95,maxHp:1320,domain:"주복사사",desc:"전직 변호사 출신 주술사.",lore:"\"이 법정에서는 — 내가 판사다.\"",
    skills:[
      {name:"저주도구",   minMastery:0, dmg:120,desc:"저주 에너지를 담은 도구."},
      {name:"몰수",       minMastery:5, dmg:195,desc:"상대의 술식 몰수.",statusApply:{target:"enemy",statusId:"weaken",chance:0.7}},
      {name:"사형판결",   minMastery:15,dmg:285,desc:"강력한 재판 제재.",statusApply:{target:"enemy",statusId:"stun",chance:0.5}},
      {name:"집행인 인형",minMastery:30,dmg:410,desc:"집행인 인형 소환 처형.",statusApply:{target:"enemy",statusId:"freeze",chance:0.7}},
    ]},
  jogo:{name:"죠고",emoji:"🌋",grade:"특급",atk:125,def:100,spd:105,maxHp:1680,domain:"개관철위산",desc:"화염을 다루는 준특급 저주령.",lore:"\"인간이야말로 진정한 저주다.\"",
    skills:[
      {name:"화염 분사",minMastery:0, dmg:130,desc:"강렬한 불꽃.",statusApply:{target:"enemy",statusId:"burn",chance:0.5}},
      {name:"용암 폭발",minMastery:5, dmg:215,desc:"발밑 용암 폭발.",statusApply:{target:"enemy",statusId:"burn",chance:0.7}},
      {name:"극번 운",  minMastery:15,dmg:315,desc:"하늘에서 불타는 운석.",statusApply:{target:"enemy",statusId:"weaken",chance:0.5}},
      {name:"개관철위산",minMastery:30,dmg:460,desc:"화산 소환 궁극 영역전개.",statusApply:{target:"enemy",statusId:"burn",chance:1.0}},
    ]},
  dagon:{name:"다곤",emoji:"🌊",grade:"특급",atk:118,def:108,spd:96,maxHp:1620,domain:"탕온평선",desc:"수중 저주령.",lore:"\"물은 모든 것을 삼킨다.\"",
    skills:[
      {name:"물고기 소환",  minMastery:0, dmg:125,desc:"날카로운 물고기 떼.",statusApply:{target:"enemy",statusId:"poison",chance:0.4}},
      {name:"해수 폭발",    minMastery:5, dmg:205,desc:"강력한 해수 압축 발사.",statusApply:{target:"enemy",statusId:"weaken",chance:0.5}},
      {name:"조류 소용돌이",minMastery:15,dmg:295,desc:"거대한 물의 소용돌이.",statusApply:{target:"enemy",statusId:"freeze",chance:0.4}},
      {name:"탕온평선",     minMastery:30,dmg:450,desc:"무수한 물고기의 영역.",statusApply:{target:"enemy",statusId:"poison",chance:0.9}},
    ]},
  hanami:{name:"하나미",emoji:"🌿",grade:"특급",atk:115,def:118,spd:93,maxHp:1750,domain:null,desc:"식물 저주령.",lore:"\"자연은 인간의 적이 아니다.\"",
    skills:[
      {name:"나무뿌리 채찍",minMastery:0, dmg:122,desc:"나무뿌리 채찍.",statusApply:{target:"enemy",statusId:"weaken",chance:0.3}},
      {name:"꽃비",         minMastery:5, dmg:198,desc:"독성 꽃가루.",statusApply:{target:"enemy",statusId:"poison",chance:0.6}},
      {name:"대지의 저주",  minMastery:15,dmg:285,desc:"저주 에너지를 퍼뜨린다.",statusApply:{target:"enemy",statusId:"poison",chance:0.7}},
      {name:"재앙의 꽃",    minMastery:30,dmg:425,desc:"거대한 꽃으로 흡수.",statusApply:{target:"enemy",statusId:"stun",chance:0.6}},
    ]},
  mahito:{name:"마히토",emoji:"🩸",grade:"특급",atk:120,def:98,spd:110,maxHp:1560,domain:"자폐원돈과",desc:"영혼을 변형하는 준특급 저주령.",lore:"\"영혼이 육체를 만드는 거야.\"",
    skills:[
      {name:"영혼 변형",  minMastery:0, dmg:128,desc:"영혼을 변형해 타격.",statusApply:{target:"enemy",statusId:"weaken",chance:0.4}},
      {name:"무위전변",   minMastery:5, dmg:212,desc:"신체를 기괴하게 변형.",statusApply:{target:"enemy",statusId:"stun",chance:0.4}},
      {name:"편사지경체", minMastery:15,dmg:308,desc:"신체를 무한히 변형.",statusApply:{target:"enemy",statusId:"weaken",chance:0.6}},
      {name:"자폐원돈과", minMastery:30,dmg:455,desc:"영혼과 육체의 경계 파괴.",statusApply:{target:"enemy",statusId:"freeze",chance:0.8}},
    ]},
  todo:{name:"토도 아오이",emoji:"💪",grade:"1급",atk:128,def:108,spd:112,maxHp:1500,domain:null,desc:"보조 공격술(부기우기)을 구사하는 1급 주술사.",lore:"\"너의 이상형은 어떤 여자야?\"",
    skills:[
      {name:"부기우기",   minMastery:0, dmg:130,desc:"위치 전환 + 빙결 40%.",statusApply:{target:"enemy",statusId:"freeze",chance:0.40}},
      {name:"브루탈 펀치",minMastery:5, dmg:215,desc:"파괴적 주먹.",statusApply:{target:"enemy",statusId:"weaken",chance:0.30}},
      {name:"흑섬",       minMastery:15,dmg:320,desc:"이타도리에게 배운 흑섬!",statusApply:{target:"enemy",statusId:"burn",chance:0.45}},
      {name:"전투본능",   minMastery:30,dmg:200,desc:"자신에게 ATK 40%↑ 버프!",statusApply:{target:"self",statusId:"battleInstinct",chance:1.0}},
    ]},
  hakari:{name:"하카리 키리토",emoji:"🎰",grade:"1급",atk:125,def:105,spd:110,maxHp:1650,domain:"질풍강운",desc:"복권 술식을 사용하는 주술사.",lore:"\"운도 실력이다! 철저하게 즐기자!\"",
    skills:[
      {name:"험한 도박",minMastery:0, dmg:125,desc:"운에 맡긴 도박 공격!",statusApply:{target:"enemy",statusId:"stun",chance:0.3}},
      {name:"질풍열차", minMastery:5, dmg:210,desc:"강력한 열차처럼 돌진!",statusApply:{target:"enemy",statusId:"weaken",chance:0.4}},
      {name:"유한 소설",minMastery:15,dmg:315,desc:"불멸의 몸으로 싸운다!",statusApply:{target:"self",statusId:"battleInstinct",chance:0.6}},
      {name:"질풍강운", minMastery:30,dmg:480,desc:"영역전개 — 운이 터진다!",statusApply:{target:"enemy",statusId:"freeze",chance:0.7}},
    ]},
};

// ════════════════════════════════════════════════════════
// ── 적 데이터
// ════════════════════════════════════════════════════════
const ENEMIES = [
  {id:"e1",name:"저급 저주령",   emoji:"👹",hp:550, atk:38, def:12, xp:75, crystals:18, masteryXp:1, fingers:0,statusAttack:null},
  {id:"e2",name:"1급 저주령",    emoji:"👺",hp:1100,atk:80, def:40, xp:190,crystals:40, masteryXp:3, fingers:0,statusAttack:{statusId:"poison",chance:0.3}},
  {id:"e3",name:"특급 저주령",   emoji:"💀",hp:2400,atk:128,def:72, xp:440,crystals:90, masteryXp:7, fingers:1,statusAttack:{statusId:"burn",chance:0.4}},
  {id:"e4",name:"저주의 왕 보스",emoji:"👑",hp:5500,atk:195,def:110,xp:1000,crystals:200,masteryXp:15,fingers:3,statusAttack:{statusId:"weaken",chance:0.5}},
];
const JUJUTSU_ENEMIES = [
  {id:"j1",name:"약화된 저주령",  emoji:"💧",hp:300, atk:25,def:8,  xp:55, crystals:12, masteryXp:1,points:1,fingers:0,statusAttack:null,desc:"⚡ 빠르지만 약함 (1포인트)"},
  {id:"j2",name:"중간급 저주령",  emoji:"🌀",hp:620, atk:55,def:28, xp:115,crystals:28, masteryXp:2,points:1,fingers:0,statusAttack:{statusId:"weaken",chance:0.2},desc:"⚖️ 균형잡힌 몹 (1포인트)"},
  {id:"j3",name:"강화 저주령",    emoji:"🔥",hp:450, atk:75,def:22, xp:95, crystals:23, masteryXp:2,points:1,fingers:0,statusAttack:{statusId:"burn",chance:0.35},desc:"💥 공격적 (1포인트)"},
  {id:"j4",name:"특수 저주령",    emoji:"☠️",hp:960, atk:88,def:48, xp:190,crystals:45, masteryXp:4,points:2,fingers:0,statusAttack:{statusId:"poison",chance:0.4},desc:"🧪 독 공격 (2포인트)"},
  {id:"j5",name:"엘리트 저주령",  emoji:"💀",hp:1380,atk:108,def:60,xp:280,crystals:70, masteryXp:6,points:3,fingers:1,statusAttack:{statusId:"burn",chance:0.5},desc:"⚔️ 강력한 엘리트 (3포인트)"},
  {id:"j6",name:"사멸회유 수호자",emoji:"👹",hp:2100,atk:135,def:82,xp:440,crystals:100,masteryXp:10,points:5,fingers:2,statusAttack:{statusId:"weaken",chance:0.6},desc:"🏆 최강 수호자 (5포인트)"},
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
    for(const e of GACHA_POOL){roll-=e.rate;if(roll<=0)return e.id;}
    return GACHA_POOL[GACHA_POOL.length-1].id;
  });
}
const REVERSE_CHARS = new Set(["gojo","yuta"]);
const CODES = {"release":{crystals:200},"sorryforbugs":{crystals:1000}};

// ════════════════════════════════════════════════════════
// ── 인메모리 세션
// ════════════════════════════════════════════════════════
let players = {};
const battles={}, cullings={}, jujutsus={}, parties={}, partyInvites={}, pvpSessions={}, pvpChallenges={};
let _partyIdSeq=1, _pvpIdSeq=1;

// ════════════════════════════════════════════════════════
// ── 주력 스킬 조회 (주력 퀘스트 완료 후 해금)
// ════════════════════════════════════════════════════════
function getMainSkill(player, charId) {
  if (!player.mainSkillUnlocked?.[charId]) return null;
  const mq = MAIN_SKILL_QUESTS[charId];
  if (!mq) return null;
  return { name: mq.skillName, dmg: mq.skillDmg, desc: mq.skillDesc };
}

// ════════════════════════════════════════════════════════
// ── 플레이어 유틸
// ════════════════════════════════════════════════════════
function getPlayer(userId, username="플레이어") {
  if (!players[userId]) {
    players[userId]={id:userId,name:username,crystals:500,xp:0,owned:["itadori"],active:"itadori",hp:CHARACTERS["itadori"].maxHp,potion:3,wins:0,losses:0,mastery:{itadori:0},reverseOutput:1.0,reverseCooldown:0,cullingBest:0,jujutsuBest:0,usedCodes:[],lastDaily:0,pvpWins:0,pvpLosses:0,statusEffects:[],skillCooldown:0,dailyStreak:0,sukunaFingers:0,kogane:null,koganeGachaCount:0,mainSkillUnlocked:{},materials:{},equippedWeapon:null,craftedWeapons:[],quests:{},mqProgress:{},jujutsuClears:0};
    savePlayer(userId);
  }
  const p=players[userId];
  let changed=false;
  if(p.name!==username&&username!=="플레이어"){p.name=username;changed=true;}
  const defaults={reverseOutput:1.0,reverseCooldown:0,mastery:{},cullingBest:0,jujutsuBest:0,usedCodes:[],lastDaily:0,pvpWins:0,pvpLosses:0,statusEffects:[],skillCooldown:0,dailyStreak:0,sukunaFingers:0,kogane:null,koganeGachaCount:0,mainSkillUnlocked:{},materials:{},equippedWeapon:null,craftedWeapons:[],quests:{},mqProgress:{},jujutsuClears:0};
  for(const[k,v] of Object.entries(defaults)){if(p[k]===undefined){p[k]=typeof v==="object"&&v!==null?JSON.parse(JSON.stringify(v)):v;changed=true;}}
  if(!p.id){p.id=userId;changed=true;}
  if(changed) savePlayer(userId);
  return p;
}
function getMastery(player,charId){return player.mastery?.[charId]||0;}
function getAvailableSkills(player,charId){
  const m=getMastery(player,charId);
  return CHARACTERS[charId].skills.filter(s=>{
    if(m<s.minMastery) return false;
    if(s.name==="스쿠나 발현"&&(player.sukunaFingers||0)<10) return false;
    return true;
  });
}
function getCurrentSkill(player,charId){const skills=getAvailableSkills(player,charId);return skills[skills.length-1]||CHARACTERS[charId].skills[0];}
function getNextSkill(player,charId){const m=getMastery(player,charId);return CHARACTERS[charId].skills.find(s=>s.minMastery>m)||null;}
function getPlayerStats(player){
  const ch=CHARACTERS[player.active];
  const kb=getKoganeBonus(player);
  const ws=getWeaponStats(player);
  if(player.active!=="itadori") return{atk:Math.floor(ch.atk*kb.atk)+ws.atk,def:Math.floor(ch.def*kb.def)+ws.def,maxHp:Math.floor(ch.maxHp*kb.hp)+ws.hp};
  const bonus=getFingerBonus(player.sukunaFingers||0);
  // 이타도리: 손가락 수에 따라 스탯 성장
  return{
    atk:Math.floor((ch.atk+bonus.atkBonus)*kb.atk)+ws.atk,
    def:Math.floor((ch.def+bonus.defBonus)*kb.def)+ws.def,
    maxHp:Math.floor((ch.maxHp+bonus.hpBonus)*kb.hp)+ws.hp,
  };
}
function masteryBar(mastery,charId){
  const tiers=CHARACTERS[charId].skills.map(s=>s.minMastery);
  const max=tiers[tiers.length-1];
  if(mastery>=max) return "`[MAX]` 모든 스킬 해금!";
  const next=tiers.find(t=>t>mastery)||max;
  const prev=[...tiers].reverse().find(t=>t<=mastery)||0;
  const fill=Math.round(((mastery-prev)/(next-prev))*10);
  return "`"+"█".repeat(Math.max(0,fill))+"░".repeat(Math.max(0,10-fill))+"`"+` ${mastery}/${next}`;
}
function getLevel(xp){return Math.floor(xp/200)+1;}
function hpBar(cur,max,len=10){
  const pct=Math.max(0,Math.min(1,cur/max));
  const fill=Math.round(pct*len);
  const color=pct>0.5?"🟩":pct>0.25?"🟨":"🟥";
  return color.repeat(Math.max(0,fill))+"⬛".repeat(Math.max(0,len-fill));
}
function isMakiAwakened(player){
  if(player.active!=="maki") return false;
  const stats=getPlayerStats(player);
  return player.hp<=Math.floor(stats.maxHp*CHARACTERS["maki"].awakening.threshold);
}
function calcDmg(atk,def,mult=1){return Math.max(1,Math.floor((atk*(0.70+Math.random()*0.60)-def*0.22)*mult));}
function calcDmgForPlayer(player,enemyDef,baseMult=1){
  const stats=getPlayerStats(player);
  let mult=baseMult*getWeakenMult(player.statusEffects);
  if(isMakiAwakened(player)) mult*=CHARACTERS["maki"].awakening.dmgMult;
  // 이타도리: 손가락 dmgMult 적용
  if(player.active==="itadori"){const b=getFingerBonus(player.sukunaFingers||0);mult*=b.dmgMult;}
  return calcDmg(stats.atk,enemyDef,mult);
}
function calcSkillDmgForPlayer(player,baseSkillDmg){
  let dmg=baseSkillDmg+Math.floor(Math.random()*60);
  dmg=Math.floor(dmg*getWeakenMult(player.statusEffects));
  if(isMakiAwakened(player)) dmg=Math.floor(dmg*CHARACTERS["maki"].awakening.dmgMult);
  if(player.active==="itadori"){const b=getFingerBonus(player.sukunaFingers||0);dmg=Math.floor(dmg*b.dmgMult);}
  const kb=getKoganeBonus(player);
  dmg=Math.floor(dmg*kb.atk);
  const ws=getWeaponStats(player);
  dmg+=Math.floor(ws.atk*0.5);
  return dmg;
}
function applySkillStatus(skill,defenderObj,attackerObj=null){
  if(!skill.statusApply) return[];
  const{target,statusId,chance}=skill.statusApply;
  if(Math.random()>chance) return[];
  const def=STATUS_EFFECTS[statusId];
  if(target==="enemy"){applyStatus(defenderObj,statusId);return[`${def.emoji}**${def.name}** 상태이상 (${def.duration}턴)`];}
  if(target==="self"&&attackerObj){applyStatus(attackerObj,statusId);return[`${def.emoji}**${def.name}** 발동! (${def.duration}턴)`];}
  return[];
}
function tickCooldowns(player){if(player.reverseCooldown>0)player.reverseCooldown--;if(player.skillCooldown>0)player.skillCooldown--;}

// ════════════════════════════════════════════════════════
// ── 파티/PvP 유틸
// ════════════════════════════════════════════════════════
function getPartyId(userId){return Object.keys(parties).find(pid=>parties[pid]?.members?.includes(userId))||null;}
function getParty(userId){const pid=getPartyId(userId);return pid?parties[pid]:null;}
function getPvpSessionByUser(userId){return Object.values(pvpSessions).find(s=>s.p1Id===userId||s.p2Id===userId)||null;}
function pvpOpponent(session,userId){
  if(session.p1Id===userId) return{id:session.p2Id,hpKey:"hp2",statusKey:"status2",skillCdKey:"skillCd2",reverseCdKey:"reverseCd2"};
  return{id:session.p1Id,hpKey:"hp1",statusKey:"status1",skillCdKey:"skillCd1",reverseCdKey:"reverseCd1"};
}
function pvpSelf(session,userId){
  if(session.p1Id===userId) return{id:session.p1Id,hpKey:"hp1",statusKey:"status1",skillCdKey:"skillCd1",reverseCdKey:"reverseCd1"};
  return{id:session.p2Id,hpKey:"hp2",statusKey:"status2",skillCdKey:"skillCd2",reverseCdKey:"reverseCd2"};
}

// ════════════════════════════════════════════════════════
// ── 컬링/사멸회유 유틸
// ════════════════════════════════════════════════════════
function getCullingPool(wave){
  if(wave<=3) return["e1","e1","e1","e2"];
  if(wave<=7) return["e1","e2","e2","e2","e3"];
  if(wave<=14)return["e2","e2","e3","e3","e3"];
  return["e2","e3","e3","e4","e4"];
}
function pickCullingEnemy(wave){
  const pool=getCullingPool(wave);
  const id=pool[Math.floor(Math.random()*pool.length)];
  const base=ENEMIES.find(e=>e.id===id);
  const scale=1+(wave-1)*0.05;
  return{...base,hp:Math.floor(base.hp*scale),atk:Math.floor(base.atk*scale),def:Math.floor(base.def*scale),xp:Math.floor(base.xp*scale),crystals:Math.floor(base.crystals*scale),currentHp:Math.floor(base.hp*scale),statusEffects:[]};
}
function generateJujutsuChoices(wave){
  const pool=wave<=3?["j1","j1","j2","j3"]:wave<=7?["j2","j3","j3","j4"]:wave<=12?["j3","j4","j4","j5"]:["j4","j5","j5","j6"];
  const ids=[];
  for(const id of [...pool].sort(()=>Math.random()-0.5)){if(!ids.includes(id))ids.push(id);if(ids.length===3)break;}
  while(ids.length<3){const fb=pool[Math.floor(Math.random()*pool.length)];if(!ids.includes(fb))ids.push(fb);}
  return ids.slice(0,3).map(id=>{
    const base=JUJUTSU_ENEMIES.find(e=>e.id===id);
    const scale=1+(wave-1)*0.04;
    return{...base,hp:Math.floor(base.hp*scale),atk:Math.floor(base.atk*scale),def:Math.floor(base.def*scale),xp:Math.floor(base.xp*scale),crystals:Math.floor(base.crystals*scale),statusEffects:[]};
  });
}

// ════════════════════════════════════════════════════════
// ── 전투 승리 공통 처리
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

  // 손가락 획득
  let sukunaUnlocked=false;
  if(enemy.fingers){
    player.sukunaFingers=Math.min(SUKUNA_FINGER_MAX,(player.sukunaFingers||0)+enemy.fingers);
    sukunaUnlocked=checkSukunaUnlock(player);
    // 주력 퀘스트 손가락 타입 업데이트
    if(player.active==="itadori"){
      updateMQProgress(player,"sukuna_fingers",enemy.fingers);
      tryCompleteMQ(player);
    }
  }

  updateQuestProgress(player,"battle_win",1);
  updateMQProgress(player,"battle_win",1);
  const mqCompleted=tryCompleteMQ(player);

  if(enemy.id==="e3"||enemy.id==="e4"){
    updateQuestProgress(player,"boss_kill",1);
    updateMQProgress(player,"boss_kill",1);
    tryCompleteMQ(player);
  }

  const dropText=Object.keys(drops).length?`\n📦 **재료:** ${formatDrops(drops)}`:"";
  const questMsg=getNewlyCompletedQuestMsg(player);
  const mqMsg=mqCompleted?`\n> 🏆 **주력 퀘스트 완료!** \`${mqCompleted.name}\` — +${mqCompleted.reward?.crystals||0}💎`:"";
  const sukunaMsg=sukunaUnlocked?`\n> 👹 **스쿠나 캐릭터 해금!** \`!활성 sukuna\` 로 사용 가능!`:"";

  return new EmbedBuilder()
    .setTitle("🏆 전투 승리!")
    .setColor(0xF5C842)
    .setDescription([
      "```ansi",
      "\u001b[1;33m╔═══════════════════════════════╗",
      "\u001b[1;33m║   ✨  V I C T O R Y  ✨       ║",
      "\u001b[1;33m╚═══════════════════════════════╝",
      "```",
      `> **${enemy.name}** 처치!`,
      `> ⭐ XP **+${xpGain}** | 💎 **+${crystalGain}** | 📈 숙련 **+${masteryGain}**`,
      dropText, mqMsg, sukunaMsg, questMsg,
    ].filter(Boolean).join("\n"))
    .addFields({name:"📊 현재",value:`> 💚 HP: **${Math.max(0,player.hp)}** | 💎 **${player.crystals}** | ⚔️ **${player.wins}**승`,inline:false})
    .setFooter({text:`LV.${getLevel(player.xp)} | !주력퀘스트 로 주력 퀘스트 확인`});
}
function getNewlyCompletedQuestMsg(player){
  initQuests(player);
  const msgs=[];
  for(const qp of player.quests.daily||[]){if(qp.done&&!qp.claimed){const def=DAILY_QUESTS.find(q=>q.id===qp.id);if(def)msgs.push(`> 📋 **일일퀘 완료!** ${def.name}`);}}
  for(const qp of player.quests.weekly||[]){if(qp.done&&!qp.claimed){const def=WEEKLY_QUESTS.find(q=>q.id===qp.id);if(def)msgs.push(`> 📅 **주간퀘 완료!** ${def.name}`);}}
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
  const hpPct=Math.max(0,player.hp)/stats.maxHp;
  const xpNow=player.xp%200;
  const fingers=player.sukunaFingers||0;
  const gradeInfo=GACHA_RARITY[ch.grade]||GACHA_RARITY["3급"];
  const kb=getKoganeBonus(player);
  const weapon=player.equippedWeapon?WEAPONS[player.equippedWeapon]:null;
  const ws=getWeaponStats(player);
  const mainSkill=getMainSkill(player,player.active);

  // HP 바 (18칸)
  const HP_LEN=18;
  const hpFill=Math.round(hpPct*HP_LEN);
  const hpColor=hpPct>0.6?"🟢":hpPct>0.3?"🟡":"🔴";
  const hpBarStr=`${hpColor} \`${"█".repeat(Math.max(0,hpFill))}${"░".repeat(Math.max(0,HP_LEN-hpFill))}\` **${Math.max(0,player.hp)}**/**${stats.maxHp}**`;

  // XP 바
  const XP_LEN=18;
  const xpFill=Math.round((xpNow/200)*XP_LEN);
  const xpBarStr=`📊 \`${"▰".repeat(Math.max(0,xpFill))}${"▱".repeat(Math.max(0,XP_LEN-xpFill))}\` **${xpNow}**/200`;

  // 손가락 바 (이타도리 전용)
  const fingerStage=getFingerStage(fingers);
  const fingerBarLen=10;
  const fingerFill=Math.floor((fingers/SUKUNA_FINGER_MAX)*fingerBarLen);
  const fingerBarStr=fingers>0?`${fingerStage.color} \`${"▮".repeat(fingerFill)}${"▯".repeat(fingerBarLen-fingerFill)}\` **${fingers}/${SUKUNA_FINGER_MAX}** — ${fingerStage.label}`:"⬛ `░░░░░░░░░░` 0/20 봉인 중";

  // 주력 퀘스트 현황
  const mq=MAIN_SKILL_QUESTS[player.active];
  const mqProg=mq?getMQProgress(player,player.active):null;
  const currentMQ=mq?getCurrentMQ(player,player.active):null;
  let mqStatus="없음";
  if(mq){
    if(mainSkill) mqStatus=`✅ **${mainSkill.name}** 해금됨!`;
    else if(currentMQ) mqStatus=`🔷 [${(mqProg?.step||0)+1}/${mq.chain.length}] **${currentMQ.name}** — ${currentMQ.desc} (${mqProg?.progress||0}/${currentMQ.target})`;
    else mqStatus=`⏳ 진행 중...`;
  }

  // 재료 요약
  const matSummary=Object.entries(player.materials||{}).filter(([,q])=>q>0).map(([id,q])=>`${MATERIALS[id]?.emoji||""}${q}`).join(" ")||"없음";

  // 퀘스트 요약
  initQuests(player);
  const dailyDone=(player.quests.daily||[]).filter(q=>q.done&&!q.claimed).length;
  const weeklyDone=(player.quests.weekly||[]).filter(q=>q.done&&!q.claimed).length;

  // 캐릭터 카드 헤더 (ANSI)
  const gradeColor = ch.grade==="특급"?"\u001b[1;33m":ch.grade==="준특급"?"\u001b[1;31m":ch.grade==="1급"?"\u001b[1;35m":"\u001b[1;32m";
  const cardHeader=[
    "```ansi",
    `${gradeColor}╔══════════════════════════════════════╗`,
    `${gradeColor}║  ${ch.emoji}  ${ch.name.padEnd(16)}  ${gradeInfo.stars}  ║`,
    `${gradeColor}║  ${JJK_GRADE_LABEL[ch.grade]||"【 ? 급 】"}  LV.${String(lv).padStart(3,"0")}  ║`,
    awakened?`\u001b[1;31m║       🔥 천여주박 각성 중! 🔥       ║`:`${gradeColor}║  "${(ch.lore||ch.desc).slice(0,28)}"  ║`,
    `${gradeColor}╚══════════════════════════════════════╝`,
    "```",
  ].join("\n");

  const embed=new EmbedBuilder()
    .setTitle(awakened?`🔥 ≪ 천여주박 각성 ≫ ${player.name}의 주술사 카드`:`${gradeInfo.effect} ${player.name}의 주술사 카드 ${gradeInfo.effect}`)
    .setColor(awakened?0xFF2200:gradeInfo.color)
    .setDescription(cardHeader)
    .addFields(
      {
        name:"┌─ 🏅 주술사 정보 ────────────────────┐",
        value:[
          `> ${xpBarStr}`,
          `> 💎 **${player.crystals}** 크리스탈   🧪 회복약 **${player.potion}**개`,
          `> ⚔️ 일반 \`${player.wins}승 ${player.losses}패\`   🥊 PvP \`${player.pvpWins}승 ${player.pvpLosses}패\``,
          `> 🌊 컬링 최고 **WAVE ${player.cullingBest}**  |  🎯 사멸회유 **${player.jujutsuBest}pt**`,
        ].join("\n"),inline:false
      },
      {
        name:"┌─ 💚 전투 상태 ──────────────────────┐",
        value:[
          `> ${hpBarStr}`,
          `> 🗡️ ATK **${stats.atk}**  🛡️ DEF **${stats.def}**  💚 MaxHP **${stats.maxHp}**`,
          weapon?`> ${weapon.emoji} **${weapon.name}** (ATK+${ws.atk} DEF+${ws.def} HP+${ws.hp})`:`> ⚔️ 장착 주구 없음`,
          `> 🩸 상태이상: **${statusStr(player.statusEffects)}**`,
          player.active==="itadori"?`> 👹 **스쿠나 손가락:** ${fingerBarStr}`:"",
        ].filter(Boolean).join("\n"),inline:false
      },
      {
        name:"┌─ ⭐ 주력 스킬 퀘스트 ───────────────┐",
        value:`> ${mqStatus}\n> \`!주력퀘스트\` 로 상세 확인`,inline:false
      },
      {
        name:"┌─ 📦 재료 & 퀘스트 ─────────────────┐",
        value:[
          `> 📦 ${matSummary}`,
          `> 📋 일일 수령가능 **${dailyDone}**개  📅 주간 수령가능 **${weeklyDone}**개`,
        ].join("\n"),inline:false
      },
      {
        name:"┌─ 📖 보유 캐릭터 ───────────────────┐",
        value:player.owned.map(id=>{
          const c=CHARACTERS[id];const ri=GACHA_RARITY[c.grade]||GACHA_RARITY["3급"];const m=getMastery(player,id);
          return `> ${id===player.active?"▶️":"　"} ${c.emoji} **${c.name}** \`${c.grade}\` ${ri.stars} · 숙련 \`${m}\``;
        }).join("\n")||"> 없음",inline:false
      },
    )
    .setFooter({text:`!전투 !컬링 !사멸회유 !결투 !가챠 !퀘스트 !주력퀘스트 !재료 !주구목록`})
    .setTimestamp();

  // 캐릭터별 썸네일 색 (Discord는 image만 지원 — 여기선 색상으로 대체)
  // 실제 GIF URL이 있다면 embed.setThumbnail(GIF_URL[charId]) 로 추가 가능
  return embed;
}

// ════════════════════════════════════════════════════════
// ── 주력 퀘스트 임베드
// ════════════════════════════════════════════════════════
function mainQuestEmbed(player) {
  const charId=player.active;
  const mq=MAIN_SKILL_QUESTS[charId];
  if(!mq){
    return new EmbedBuilder().setTitle("⭐ 주력 퀘스트").setColor(0x7C5CFC)
      .setDescription(`> **${CHARACTERS[charId].name}**은 주력 퀘스트가 없습니다.\n> 주력 퀘스트 보유 캐릭터: ${Object.keys(MAIN_SKILL_QUESTS).map(id=>CHARACTERS[id].name).join(", ")}`);
  }
  const prog=getMQProgress(player,charId);
  const mainSkill=getMainSkill(player,charId);
  const gradeInfo=GACHA_RARITY[CHARACTERS[charId].grade]||GACHA_RARITY["3급"];

  const embed=new EmbedBuilder()
    .setTitle(`${gradeInfo.effect} ${CHARACTERS[charId].name}의 주력 퀘스트`)
    .setColor(gradeInfo.color);

  // 목표 스킬 표시
  const targetDesc=mainSkill
    ? `✅ **주력 스킬 해금 완료!**\n> ${mq.skillName}\n> ${mq.skillDesc}\n> 💥 기본 피해: **${mq.skillDmg}**`
    : `🔒 **목표 스킬:** ${mq.skillName}\n> ${mq.skillDesc}\n> 💥 기본 피해: **${mq.skillDmg}**`;
  embed.setDescription(targetDesc);

  // 체인 진행도
  const chainLines=mq.chain.map((q,i)=>{
    const done=(prog.completed||[]).includes(q.step);
    const current=!done&&prog.step===q.step;
    const progress=current?(prog.progress||0):done?q.target:0;
    const pct=Math.min(progress/q.target,1);
    const barFill=Math.round(pct*8);
    const bar="`"+"█".repeat(barFill)+"░".repeat(8-barFill)+"`";
    const icon=done?"✅":current?"🔷":"⬜";
    const prereqNote=q.prereqFingers?` (손가락 ${q.prereqFingers}개 이상 필요)`:"";
    return[
      `${icon} **[${i+1}단계] ${q.name}**${prereqNote}`,
      `> ${q.desc}`,
      `> ${current?bar+" "+progress+"/"+q.target:done?"완료":q.step>prog.step?"잠김":""}`,
      `> *${q.story}*`,
      done?"":`> 보상: +${q.reward?.crystals||0}💎 +${q.reward?.xp||0}XP`,
    ].filter(Boolean).join("\n");
  }).join("\n\n");

  embed.addFields({name:"── 퀘스트 체인 ──────────────────────",value:chainLines||"없음",inline:false});
  embed.setFooter({text:`현재 활성 캐릭터: ${CHARACTERS[charId].name} | !활성 [ID] 로 캐릭터 변경`});
  return embed;
}

// ════════════════════════════════════════════════════════
// ── 가챠 임베드 (고퀄 리메이크)
// ════════════════════════════════════════════════════════
function buildGachaLoadEmbed(stage) {
  const frames=[
    {
      title:"🔮 저주 소환 — 에너지 수렴 중...",
      color:0x0a0a1e,
      desc:[
        "```ansi",
        "\u001b[2;30m╔═══════════════════════════════════╗",
        "\u001b[2;34m║    ？      ？      ？      ？     ║",
        "\u001b[2;35m║    ░░░    ░░░    ░░░    ░░░     ║",
        "\u001b[2;30m╚═══════════════════════════════════╝",
        "```",
        "> *저주 에너지가 서서히 수렴하기 시작한다...*",
      ].join("\n"),
    },
    {
      title:"⚡ 저주 에너지 임계점 돌파!",
      color:0x1a0533,
      desc:[
        "```ansi",
        "\u001b[1;35m╔═══════════════════════════════════╗",
        "\u001b[1;31m║  ⚡  ✦  ？？？？  ✦  ⚡         ║",
        "\u001b[1;33m║     >>> 최대 저주력 도달 <<<      ║",
        "\u001b[1;35m╚═══════════════════════════════════╝",
        "```",
        "> *주술 에너지가 임계점을 넘어선다...*",
      ].join("\n"),
    },
  ];
  const f=frames[(stage-1)%frames.length]||frames[0];
  return new EmbedBuilder().setTitle(f.title).setColor(f.color).setDescription(f.desc);
}

function buildGachaRevealEmbed(grade, charId, isNew, player) {
  const ch=CHARACTERS[charId];
  const info=GACHA_RARITY[grade]||GACHA_RARITY["3급"];
  const isLegend=grade==="특급";
  const isEpic=grade==="준특급";

  // 고퀄 등급별 연출 ANSI 아트
  const arts={
    "특급":[
      "```ansi",
      "\u001b[1;33m╔══════════════════════════════════════╗",
      "\u001b[1;33m║  ✨ ✨ ✨  L E G E N D A R Y  ✨ ✨ ✨  ║",
      "\u001b[1;31m║  🔱  특급  🔱  RANK: SPECIAL GRADE  ║",
      "\u001b[1;33m╚══════════════════════════════════════╝",
      "```",
    ].join("\n"),
    "준특급":[
      "```ansi",
      "\u001b[1;31m╔══════════════════════════════════════╗",
      "\u001b[1;31m║  💠 💠 💠    E P I C    💠 💠 💠    ║",
      "\u001b[1;33m║          준특급 등급 소환!            ║",
      "\u001b[1;31m╚══════════════════════════════════════╝",
      "```",
    ].join("\n"),
    "1급":[
      "```ansi",
      "\u001b[1;35m╔══════════════════════════════════════╗",
      "\u001b[1;35m║  ⭐ ⭐ ⭐  R A R E  ⭐ ⭐ ⭐         ║",
      "\u001b[1;35m║          1급 등급 소환!              ║",
      "\u001b[1;35m╚══════════════════════════════════════╝",
      "```",
    ].join("\n"),
    "_default":[
      "```ansi",
      "\u001b[1;32m╔══════════════════════════════════════╗",
      "\u001b[1;32m║         주술사가 소환되었다!          ║",
      "\u001b[1;32m╚══════════════════════════════════════╝",
      "```",
    ].join("\n"),
  };
  const art=arts[grade]||arts["_default"];

  const embed=new EmbedBuilder()
    .setTitle(isNew?`${info.effect} ✨ NEW! — ${ch.name} 획득!`:`${info.effect} 중복 — ${ch.name} (+50💎)`)
    .setColor(isNew?info.color:0x4a5568)
    .setDescription([
      art,
      `> ${ch.emoji} **${ch.name}** \`[${ch.grade}]\` ${info.stars}`,
      `> *"${ch.lore||ch.desc}"*`,
      `> 🌌 영역전개: **${ch.domain||"없음"}**`,
      `> ${ch.desc}`,
      isNew?"":"> 💎 중복 보상 +50 크리스탈!",
    ].filter(Boolean).join("\n"))
    .addFields({name:"💎 잔여 크리스탈",value:`**${player.crystals}**`,inline:true},{name:"📖 등급",value:info.stars,inline:true});

  return embed;
}

function buildGacha10ResultEmbed(results, newOnes, dupCrystals, player) {
  const sorted=[...results].sort((a,b)=>{
    const o=["특급","준특급","1급","준1급","2급","3급","4급"];
    return o.indexOf(CHARACTERS[a].grade)-o.indexOf(CHARACTERS[b].grade);
  });
  const lines=sorted.map(id=>{
    const ch=CHARACTERS[id];const info=GACHA_RARITY[ch.grade]||GACHA_RARITY["3급"];const isN=newOnes.includes(id);
    return `${ch.emoji} ${info.stars} **${ch.name}** \`[${ch.grade}]\`${isN?" **✨ NEW!**":""}`;
  });
  const legendaries=results.filter(id=>CHARACTERS[id].grade==="특급");
  const header=legendaries.length>0?[
    "```ansi",
    "\u001b[1;33m╔══════════════════════════════════════╗",
    "\u001b[1;33m║  🔱  특급 등급 획득!!  🔱             ║",
    "\u001b[1;31m║     L E G E N D A R Y  !!            ║",
    "\u001b[1;33m╚══════════════════════════════════════╝",
    "```",
  ].join("\n"):[
    "```ansi",
    "\u001b[1;34m╔══════════════════════════════════════╗",
    "\u001b[1;34m║      🎲  10회 주술 소환 결과  🎲      ║",
    "\u001b[1;34m╚══════════════════════════════════════╝",
    "```",
  ].join("\n");

  return new EmbedBuilder()
    .setTitle(legendaries.length>0?"🔱 ⚡ 10연차 — 전설 등급 획득!! ⚡ 🔱":"🎲 10회 주술 소환 결과")
    .setColor(legendaries.length>0?0xF5C842:0x7c5cfc)
    .setDescription(header+"\n"+lines.join("\n"))
    .addFields(
      {name:"✨ 신규 획득",value:newOnes.length?newOnes.map(id=>`${CHARACTERS[id].emoji} ${CHARACTERS[id].name}`).join(", "):"없음",inline:true},
      {name:"🔄 중복 보상",value:`**+${dupCrystals}** 💎`,inline:true},
      {name:"💎 잔여",value:`**${player.crystals}**`,inline:true},
    );
}

// ════════════════════════════════════════════════════════
// ── 코가네 가챠 임베드 (고퀄 리메이크)
// ════════════════════════════════════════════════════════
function buildKoganeGachaEmbed(grade, isUpgrade, player) {
  const g=KOGANE_GRADES[grade];
  const arts={
    "전설":["```ansi","\u001b[1;33m╔══════════════════════════════════════╗","\u001b[1;33m║  🌟 🌟 🌟  전설의 코가네!  🌟 🌟 🌟  ║","\u001b[1;33m║       L E G E N D A R Y  PET!       ║","\u001b[1;33m╚══════════════════════════════════════╝","```"].join("\n"),
    "특급": ["```ansi","\u001b[1;31m╔══════════════════════════════════════╗","\u001b[1;31m║  🔶 🔶 🔶  특급 코가네!  🔶 🔶 🔶  ║","\u001b[1;31m╚══════════════════════════════════════╝","```"].join("\n"),
    "1급":  ["```ansi","\u001b[1;35m╔══════════════════════════════════════╗","\u001b[1;35m║  🔷 🔷  1급 코가네!  🔷 🔷           ║","\u001b[1;35m╚══════════════════════════════════════╝","```"].join("\n"),
    "_":    ["```ansi","\u001b[1;32m╔══════════════════════════════════════╗","\u001b[1;32m║     🐾  코가네가 소환되었다!  🐾     ║","\u001b[1;32m╚══════════════════════════════════════╝","```"].join("\n"),
  };
  const art=arts[grade]||arts["_"];
  return new EmbedBuilder()
    .setTitle(isUpgrade?`${g.emoji} 코가네 [${grade}] ${g.stars} — 새로운 펫!`:`${g.emoji} 코가네 [${grade}] — 중복 (+50💎)`)
    .setColor(isUpgrade?g.color:0x4a5568)
    .setDescription([
      art,
      `> **패시브:** ${g.passiveDesc}`,
      `> **스킬:** ${g.skill} — ${g.skillDesc}`,
      isUpgrade?"":"> 💎 이미 더 높은 등급 보유. 중복 보상 +50!",
    ].filter(Boolean).join("\n"))
    .addFields(
      {name:"🗡️ 스탯 보너스",value:`ATK+${Math.round(g.atkBonus*100)}% DEF+${Math.round(g.defBonus*100)}% HP+${Math.round(g.hpBonus*100)}%`,inline:true},
      {name:"📈 보상 보너스",value:`XP+${Math.round(g.xpBonus*100)}% 💎+${Math.round(g.crystalBonus*100)}%`,inline:true},
      {name:"💎 잔여",value:`**${player.crystals}**`,inline:true},
    )
    .setFooter({text:`총 소환 횟수: ${player.koganeGachaCount||0}회`});
}
function koganeProfileEmbed(player) {
  const kogane=player.kogane;
  if(!kogane) return new EmbedBuilder().setTitle("🐾 코가네 — 황금 개 펫").setColor(0x4a5568).setDescription("> **코가네**가 없습니다! `!코가네가챠` (200💎)").setFooter({text:"!코가네가챠 (200💎)"});
  const g=KOGANE_GRADES[kogane.grade];
  return new EmbedBuilder().setTitle(`${g.emoji} 코가네 [${kogane.grade}] ${g.stars}`).setColor(g.color)
    .setDescription([`> **패시브:** ${g.passiveDesc}`,`> **스킬:** ${g.skill} — ${g.skillDesc}`].join("\n"))
    .addFields(
      {name:"📊 스탯 보너스",value:`> 🗡️ ATK +${Math.round(g.atkBonus*100)}%\n> 🛡️ DEF +${Math.round(g.defBonus*100)}%\n> 💚 HP +${Math.round(g.hpBonus*100)}%`,inline:true},
      {name:"📈 보상 보너스",value:`> ⭐ XP +${Math.round(g.xpBonus*100)}%\n> 💎 크리스탈 +${Math.round(g.crystalBonus*100)}%`,inline:true},
    ).setFooter({text:`총 소환 횟수: ${player.koganeGachaCount||0}회`});
}

// ════════════════════════════════════════════════════════
// ── 기타 임베드들
// ════════════════════════════════════════════════════════
function questEmbed(player) {
  initQuests(player);
  const embed=new EmbedBuilder().setTitle("📋 퀘스트 현황").setColor(0x7C5CFC).setTimestamp();
  const dailyLines=(player.quests.daily||[]).map(qp=>{
    const def=DAILY_QUESTS.find(q=>q.id===qp.id); if(!def) return "";
    const bar=`\`${"█".repeat(Math.floor(qp.progress/def.target*8))}${"░".repeat(8-Math.floor(qp.progress/def.target*8))}\``;
    const status=qp.claimed?"✅ 수령 완료":qp.done?"🎁 수령 가능 (`!퀘보상 일`)":bar+` ${qp.progress}/${def.target}`;
    const rew=`+${def.reward.crystals}💎 +${def.reward.xp}XP${def.reward.materials?` ${Object.entries(def.reward.materials).map(([m,q])=>`${MATERIALS[m]?.emoji||""}×${q}`).join(" ")}` : ""}`;
    return `> **${def.name}** — ${def.desc}\n> ${status}\n> 보상: ${rew}`;
  }).filter(Boolean).join("\n\n");
  const weeklyLines=(player.quests.weekly||[]).map(qp=>{
    const def=WEEKLY_QUESTS.find(q=>q.id===qp.id); if(!def) return "";
    const bar=`\`${"█".repeat(Math.floor(qp.progress/def.target*8))}${"░".repeat(8-Math.floor(qp.progress/def.target*8))}\``;
    const status=qp.claimed?"✅ 수령 완료":qp.done?"🎁 수령 가능 (`!퀘보상 주`)":bar+` ${qp.progress}/${def.target}`;
    const rew=`+${def.reward.crystals}💎 +${def.reward.xp}XP${def.reward.materials?` ${Object.entries(def.reward.materials).map(([m,q])=>`${MATERIALS[m]?.emoji||""}×${q}`).join(" ")}` : ""}`;
    return `> **${def.name}** — ${def.desc}\n> ${status}\n> 보상: ${rew}`;
  }).filter(Boolean).join("\n\n");
  embed.addFields(
    {name:"📋 ─── 일일 퀘스트",value:dailyLines||"> 없음",inline:false},
    {name:"📅 ─── 주간 퀘스트",value:weeklyLines||"> 없음",inline:false},
  );
  embed.setFooter({text:"!퀘보상 일 [번호] | !퀘보상 주 [번호] 로 보상 수령"});
  return embed;
}
function materialsEmbed(player) {
  const mats=player.materials||{};
  const lines=Object.entries(MATERIALS).map(([id,m])=>`> ${m.emoji} **${m.name}** ×${mats[id]||0}  — ${m.desc}`);
  return new EmbedBuilder().setTitle("📦 재료 인벤토리").setColor(0x7c5cfc).setDescription(lines.join("\n")).setFooter({text:"!주구목록 — 주구 목록 및 제작"});
}
function weaponListEmbed(player) {
  const mats=player.materials||{};
  const lines=Object.entries(WEAPONS).map(([id,w])=>{
    const canCraft=Object.entries(w.recipe).every(([m,q])=>(mats[m]||0)>=q);
    const owned=(player.craftedWeapons||[]).includes(id);
    const equipped=player.equippedWeapon===id;
    const recipeStr=Object.entries(w.recipe).map(([m,q])=>{const have=mats[m]||0;return `${MATERIALS[m]?.emoji||""}${have}/${q}`;}).join(" ");
    return `> ${equipped?"⚔️":owned?"✅":"🔒"} **${w.emoji} ${w.name}** \`[${w.grade}]\`\n> ATK+${w.atkBonus} DEF+${w.defBonus} HP+${w.hpBonus}\n> 재료: ${recipeStr}  ${canCraft&&!owned?"**✨ 제작 가능!**":owned?"(보유중)":""}`;
  });
  return new EmbedBuilder().setTitle("⚔️ 주구 목록").setColor(0xF5C842).setDescription(lines.join("\n\n")).setFooter({text:"!주구제작 [무기ID] | !장착 [무기ID] | !해제"});
}
function cullingEmbed(player, session, log=[]) {
  const ch=CHARACTERS[player.active]; const stats=getPlayerStats(player); const enemy=session.currentEnemy; const awakened=isMakiAwakened(player);
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
  const ch=CHARACTERS[player.active]; const stats=getPlayerStats(player); const awakened=isMakiAwakened(player);
  const embed=new EmbedBuilder()
    .setTitle(`🎯 사멸회유 — WAVE ${session.wave} | 포인트 **${session.points}**/15`)
    .setColor(session.points>=10?0xF5C842:session.points>=5?0xff8c00:0x7C5CFC)
    .setDescription(log.join("\n")||"🎯 사멸회유 진행 중!")
    .addFields(
      {name:`${ch.emoji} 내 HP`,value:`${hpBar(player.hp,stats.maxHp)} \`${Math.max(0,player.hp)}/${stats.maxHp}\`${awakened?" 🔥각성":""}\n상태: ${statusStr(player.statusEffects)}\n⚡술식: \`${player.skillCooldown>0?player.skillCooldown+"턴":"가능"}\``,inline:false},
      {name:"🎯 포인트",value:`${"🟦".repeat(Math.min(session.points,15))}${"⬜".repeat(Math.max(0,15-session.points))} **${session.points}/15**`,inline:false},
    );
  if(session.currentEnemy){const enemy=session.currentEnemy;embed.addFields({name:`${enemy.emoji} ${enemy.name}`,value:`${hpBar(session.enemyHp,enemy.hp)} \`${Math.max(0,session.enemyHp)}/${enemy.hp}\`\n포인트: +${enemy.points}점`,inline:false});}
  if(choices) embed.addFields({name:"⚔️ 다음 적 선택",value:choices.map((c,i)=>`**[${i+1}]** ${c.emoji} ${c.name} — HP:\`${c.hp}\` ATK:\`${c.atk}\` | +${c.points}점\n└ ${c.desc}`).join("\n"),inline:false});
  embed.setFooter({text:`최고기록: ${player.jujutsuBest}포인트`});
  return embed;
}
function pvpEmbed(session, log=[]) {
  const p1=players[session.p1Id],p2=players[session.p2Id];
  const ch1=CHARACTERS[p1.active],ch2=CHARACTERS[p2.active];
  const s1=getPlayerStats(p1),s2=getPlayerStats(p2);
  return new EmbedBuilder()
    .setTitle(`⚔️ PvP  ${p1.name} VS ${p2.name}`)
    .setColor(0xF5C842)
    .setDescription(log.join("\n")||"⚔️ 결투 시작!")
    .addFields(
      {name:`${ch1.emoji} ${p1.name}`,value:`${hpBar(session.hp1,s1.maxHp)} \`${Math.max(0,session.hp1)}/${s1.maxHp}\`\n상태: ${statusStr(session.status1)}\n⚡술식: \`${session.skillCd1>0?session.skillCd1+"턴":"가능"}\``,inline:true},
      {name:`${ch2.emoji} ${p2.name}`,value:`${hpBar(session.hp2,s2.maxHp)} \`${Math.max(0,session.hp2)}/${s2.maxHp}\`\n상태: ${statusStr(session.status2)}\n⚡술식: \`${session.skillCd2>0?session.skillCd2+"턴":"가능"}\``,inline:true},
      {name:"🎯 현재 턴",value:`**${session.turn===session.p1Id?p1.name:p2.name}**의 차례 (라운드 ${session.round})`,inline:false},
    )
    .setFooter({text:"술식 5턴 쿨다운 | 반전술식 3턴 쿨다운 | 회피율 5%"});
}
function partyCullingEmbed(party, session, log=[]) {
  const enemy=session.currentEnemy;
  const memberLines=party.members.map(uid=>{const p=players[uid];if(!p)return`> ❓ (${uid})`;const ch=CHARACTERS[p.active],stats=getPlayerStats(p),aw=isMakiAwakened(p);const hpPct=Math.max(0,p.hp)/stats.maxHp;const hpIcon=hpPct>0.5?"🟢":hpPct>0.25?"🟡":"🔴";return`> ${party.leader===uid?"👑":"👤"} **${p.name}** ${ch.emoji} ${hpIcon} \`${Math.max(0,p.hp)}/${stats.maxHp}\`${aw?" 🔥":""} | ${statusStr(p.statusEffects)}`;}).join("\n");
  return new EmbedBuilder()
    .setTitle(`⚔️ [파티] 컬링 — 🌊 WAVE ${session.wave}`)
    .setColor(session.wave>=15?0xF5C842:0x7C5CFC)
    .setDescription(log.join("\n")||"⚔️ 파티 컬링 진행 중!")
    .addFields(
      {name:`👥 파티원 (${party.members.length}명)`,value:memberLines||"없음",inline:false},
      {name:`${enemy.emoji} ${enemy.name}`,value:`${hpBar(Math.max(0,session.enemyHp),enemy.hp)} \`${Math.max(0,session.enemyHp)}/${enemy.hp}\`\n상태: ${statusStr(enemy.statusEffects||[])}`,inline:false},
      {name:"📊 현황",value:`WAVE **${session.wave}** | 처치 **${session.kills}** | **${session.totalXp}** XP / **${session.totalCrystals}**💎`,inline:false},
    );
}

// ════════════════════════════════════════════════════════
// ── 버튼 팩토리
// ════════════════════════════════════════════════════════
const mkBattleButtons=(player)=>{
  const canSkill=!player||player.skillCooldown<=0;
  const canReverse=!player||player.reverseCooldown<=0;
  const hasReverse=!player||REVERSE_CHARS.has(player.active);
  const mainSkill=getMainSkill(player,player.active);
  const buttons=[
    new ButtonBuilder().setCustomId("b_attack").setLabel("⚔️ 공격").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("b_skill").setLabel(`🌀 ${getCurrentSkill(player,player.active).name}`).setStyle(ButtonStyle.Primary).setDisabled(!canSkill),
  ];
  if(mainSkill) buttons.push(new ButtonBuilder().setCustomId("b_main").setLabel(`⭐ ${mainSkill.name}`).setStyle(ButtonStyle.Success));
  buttons.push(
    new ButtonBuilder().setCustomId("b_reverse").setLabel("♻️ 반전").setStyle(ButtonStyle.Secondary).setDisabled(!canReverse||!hasReverse),
    new ButtonBuilder().setCustomId("b_run").setLabel("🏃 도주").setStyle(ButtonStyle.Secondary),
  );
  return new ActionRowBuilder().addComponents(buttons);
};
const mkCullingButtons=(player)=>{
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
const mkJujutsuButtons=(player,choices)=>{
  const row=new ActionRowBuilder();
  for(let i=0;i<Math.min(choices.length,3);i++) row.addComponents(new ButtonBuilder().setCustomId(`j_choice_${i}`).setLabel(`⚔️ ${choices[i].name}`).setStyle(ButtonStyle.Primary));
  const canSkill=!player||player.skillCooldown<=0;
  const canReverse=!player||player.reverseCooldown<=0;
  const hasReverse=!player||REVERSE_CHARS.has(player.active);
  return[row,new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("j_attack").setLabel("⚔️ 공격").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("j_skill").setLabel(`🌀 ${getCurrentSkill(player,player.active).name}`).setStyle(ButtonStyle.Primary).setDisabled(!canSkill),
    new ButtonBuilder().setCustomId("j_reverse").setLabel("♻️ 반전").setStyle(ButtonStyle.Secondary).setDisabled(!canReverse||!hasReverse),
    new ButtonBuilder().setCustomId("j_escape").setLabel("🏳️ 철수").setStyle(ButtonStyle.Secondary),
  )];
};
const mkPvpButtons=(session,userId)=>{
  const self=pvpSelf(session,userId);
  const canSkill=session[self.skillCdKey]<=0;
  const canReverse=session[self.reverseCdKey]<=0;
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
// ── 적 반격 (공통)
// ════════════════════════════════════════════════════════
async function doEnemyAttack(player, enemy, log) {
  const stats=getPlayerStats(player);
  const tick=tickStatus(player,stats.maxHp);
  if(tick.log.length) log.push(...tick.log);
  const enemyHit=rollHit(enemy.statusEffects||[],player.statusEffects);
  if(!enemyHit){log.push(`> ↩️ **${enemy.name}**의 공격이 빗나갔다!`);return;}
  const eDmg=calcDmg(enemy.atk,stats.def);
  player.hp=Math.max(0,player.hp-eDmg);
  log.push(`> 💢 **${enemy.name}** 반격! **${eDmg}** 피해!`);
  if(enemy.statusAttack&&Math.random()<(enemy.statusAttack.chance||0.3)){
    applyStatus(player,enemy.statusAttack.statusId);
    const sdef=STATUS_EFFECTS[enemy.statusAttack.statusId];
    log.push(`> ${sdef.emoji}**${sdef.name}** 상태이상!`);
  }
}

// ════════════════════════════════════════════════════════
// ── 전투 핸들러
// ════════════════════════════════════════════════════════
async function handleBattleAction(interaction, player, battle, action) {
  const enemy=battle.enemy;

  if(action==="b_attack") {
    if(isIncapacitated(player.statusEffects)) return interaction.reply({content:"❌ 상태이상으로 행동 불가!",ephemeral:true});
    const hit=rollHit(player.statusEffects,enemy.statusEffects);
    const log=[];let dmg=0,isBlack=false;
    if(!hit){log.push("⚡ 공격이 **빗나갔다!**");}
    else{
      dmg=calcDmgForPlayer(player,enemy.def); isBlack=isBlackFlash();
      if(isBlack){dmg=Math.floor(dmg*2.5);player.crystals+=50;log.push(getBlackFlashArt());log.push(`\u001b[1;31m💥 **흑섬 발동!!** **${dmg}** 피해! (×2.5) +50💎`);}
      else{log.push(`> ⚔️ ${player.name}의 공격! **${dmg}** 피해!`);}
      enemy.currentHp=Math.max(0,enemy.currentHp-dmg);
    }
    const stats=getPlayerStats(player);
    const embed=new EmbedBuilder().setTitle(isBlack?"⚫ 흑 섬 ⚫":"⚔️ 공격!").setColor(isBlack?0x0a0a0a:0xff6b35)
      .setDescription(log.join("\n"))
      .addFields(
        {name:`${CHARACTERS[player.active].emoji} 내 HP`,value:`${hpBar(player.hp,stats.maxHp)} \`${Math.max(0,player.hp)}/${stats.maxHp}\``,inline:true},
        {name:`${enemy.emoji} ${enemy.name}`,value:`${hpBar(enemy.currentHp,enemy.hp)} \`${Math.max(0,enemy.currentHp)}/${enemy.hp}\``,inline:true},
      );
    if(enemy.currentHp<=0){delete battles[interaction.user.id];const winEmbed=await processBattleWin(player,enemy);savePlayer(interaction.user.id);return interaction.update({embeds:[embed,winEmbed],components:[]});}
    await doEnemyAttack(player,enemy,log);
    embed.setDescription(log.join("\n"));
    embed.spliceFields(0,2,
      {name:`${CHARACTERS[player.active].emoji} 내 HP`,value:`${hpBar(player.hp,stats.maxHp)} \`${Math.max(0,player.hp)}/${stats.maxHp}\`\n상태: ${statusStr(player.statusEffects)}`,inline:true},
      {name:`${enemy.emoji} ${enemy.name}`,value:`${hpBar(enemy.currentHp,enemy.hp)} \`${Math.max(0,enemy.currentHp)}/${enemy.hp}\`\n상태: ${statusStr(enemy.statusEffects||[])}`,inline:true},
    );
    tickCooldowns(player);
    if(player.hp<=0){player.losses++;delete battles[interaction.user.id];savePlayer(interaction.user.id);const def=new EmbedBuilder().setTitle("💀 패배...").setColor(0xe63946).setDescription("```ansi\n\u001b[1;31m╔════════════════╗\n\u001b[1;31m║  💀 D E F E A T ║\n\u001b[1;31m╚════════════════╝\n```\n> `!회복` 으로 HP를 회복하세요.");return interaction.update({embeds:[embed,def],components:[]});}
    savePlayer(interaction.user.id);
    return interaction.update({embeds:[embed],components:[mkBattleButtons(player)]});
  }

  if(action==="b_skill") {
    if(isIncapacitated(player.statusEffects)) return interaction.reply({content:"❌ 상태이상으로 행동 불가!",ephemeral:true});
    if(player.skillCooldown>0) return interaction.reply({content:`❌ 술식 쿨다운: ${player.skillCooldown}턴!`,ephemeral:true});
    const skill=getCurrentSkill(player,player.active);
    const hit=rollHit(player.statusEffects,enemy.statusEffects);
    const log=[];
    if(!hit){log.push("⚡ 술식이 **빗나갔다!**");}
    else{
      let dmg=calcSkillDmgForPlayer(player,skill.dmg);
      const isBlack=isBlackFlash();
      if(isBlack){dmg=Math.floor(dmg*2.5);player.crystals+=50;}
      const statusLog=applySkillStatus(skill,enemy,player);
      enemy.currentHp=Math.max(0,enemy.currentHp-dmg);
      const fx=getSkillEffect(skill.name);
      log.push(fx.art);
      log.push(`> *"${fx.flavorText}"*`);
      if(isBlack) log.push(`⚫ **흑섬 발동!!** **${dmg}** 피해! (×2.5) +50💎`);
      else log.push(`> 💥 **${skill.name}** — **${dmg}** 피해!`);
      log.push(...statusLog);
      updateQuestProgress(player,"skill_use",1);
      updateMQProgress(player,"skill_use",1);
      tryCompleteMQ(player);
    }
    player.skillCooldown=5;
    const stats=getPlayerStats(player);
    const fx=getSkillEffect(skill.name);
    const embed=new EmbedBuilder().setTitle(`🌀 ${skill.name}!`).setColor(fx.color)
      .setDescription(log.join("\n"))
      .addFields(
        {name:`${CHARACTERS[player.active].emoji} 내 HP`,value:`${hpBar(player.hp,stats.maxHp)} \`${Math.max(0,player.hp)}/${stats.maxHp}\``,inline:true},
        {name:`${enemy.emoji} ${enemy.name}`,value:`${hpBar(enemy.currentHp,enemy.hp)} \`${Math.max(0,enemy.currentHp)}/${enemy.hp}\``,inline:true},
      );
    if(enemy.currentHp<=0){delete battles[interaction.user.id];const winEmbed=await processBattleWin(player,enemy);savePlayer(interaction.user.id);return interaction.update({embeds:[embed,winEmbed],components:[]});}
    await doEnemyAttack(player,enemy,log);
    embed.setDescription(log.join("\n"));
    embed.spliceFields(0,2,
      {name:`${CHARACTERS[player.active].emoji} 내 HP`,value:`${hpBar(player.hp,stats.maxHp)} \`${Math.max(0,player.hp)}/${stats.maxHp}\`\n상태: ${statusStr(player.statusEffects)}`,inline:true},
      {name:`${enemy.emoji} ${enemy.name}`,value:`${hpBar(enemy.currentHp,enemy.hp)} \`${Math.max(0,enemy.currentHp)}/${enemy.hp}\`\n상태: ${statusStr(enemy.statusEffects||[])}`,inline:true},
    );
    tickCooldowns(player);
    if(player.hp<=0){player.losses++;delete battles[interaction.user.id];savePlayer(interaction.user.id);return interaction.update({embeds:[embed,new EmbedBuilder().setTitle("💀 패배...").setColor(0xe63946).setDescription("> `!회복` 으로 HP 회복")],components:[]});}
    savePlayer(interaction.user.id);
    return interaction.update({embeds:[embed],components:[mkBattleButtons(player)]});
  }

  if(action==="b_main") {
    const mainSkill=getMainSkill(player,player.active);
    if(!mainSkill) return interaction.reply({content:"❌ 주력 스킬 미해금! `!주력퀘스트` 확인",ephemeral:true});
    if(isIncapacitated(player.statusEffects)) return interaction.reply({content:"❌ 상태이상!",ephemeral:true});
    const hit=rollHit(player.statusEffects,enemy.statusEffects);
    const log=[];
    if(!hit){log.push("⚡ 주력 스킬이 **빗나갔다!**");}
    else{
      let dmg=calcSkillDmgForPlayer(player,mainSkill.dmg);
      const isBlack=isBlackFlash();
      if(isBlack){dmg=Math.floor(dmg*2.5);player.crystals+=50;}
      enemy.currentHp=Math.max(0,enemy.currentHp-dmg);
      const fx=getSkillEffect(mainSkill.name);
      log.push(fx.art);
      log.push(`> *"${fx.flavorText}"*`);
      if(isBlack) log.push(`⚫ **흑섬!** **${dmg}** 피해! (×2.5)`);
      else log.push(`> ⭐ **${mainSkill.name}** — **${dmg}** 피해!`);
      // 자폭 무라사키 특수 효과
      if(mainSkill.name==="자폭 무라사키(紫)"){player.hp=1;log.push("> 💥 **자폭 효과!** HP가 1이 되었다!");}
    }
    player.skillCooldown=6;
    const stats=getPlayerStats(player);
    const embed=new EmbedBuilder().setTitle(`⭐ ${mainSkill.name}!`).setColor(0xffcc00)
      .setDescription(log.join("\n"))
      .addFields(
        {name:"내 HP",value:`${hpBar(player.hp,stats.maxHp)} \`${Math.max(0,player.hp)}/${stats.maxHp}\``,inline:true},
        {name:`${enemy.emoji} ${enemy.name}`,value:`${hpBar(enemy.currentHp,enemy.hp)} \`${Math.max(0,enemy.currentHp)}/${enemy.hp}\``,inline:true},
      );
    if(enemy.currentHp<=0){delete battles[interaction.user.id];const winEmbed=await processBattleWin(player,enemy);savePlayer(interaction.user.id);return interaction.update({embeds:[embed,winEmbed],components:[]});}
    await doEnemyAttack(player,enemy,log);
    tickCooldowns(player);
    if(player.hp<=0){player.losses++;delete battles[interaction.user.id];savePlayer(interaction.user.id);return interaction.update({embeds:[embed,new EmbedBuilder().setTitle("💀 패배...").setColor(0xe63946).setDescription("> `!회복`")],components:[]});}
    savePlayer(interaction.user.id);
    return interaction.update({embeds:[embed],components:[mkBattleButtons(player)]});
  }

  if(action==="b_reverse") {
    if(!REVERSE_CHARS.has(player.active)) return interaction.reply({content:"❌ 이 캐릭터는 반전술식 불가!",ephemeral:true});
    const stats=getPlayerStats(player);
    const heal=Math.floor(stats.maxHp*0.4);
    player.hp=Math.min(stats.maxHp,player.hp+heal);
    player.reverseCooldown=3;
    player.statusEffects=player.statusEffects.filter(s=>s.id==="battleInstinct");
    tickCooldowns(player); savePlayer(interaction.user.id);
    const embed=new EmbedBuilder().setTitle("♻️ 반전술식!").setColor(0x00ff88)
      .setDescription(`> 💚 **${heal}** HP 회복!\n> 🧹 상태이상 해제!`)
      .addFields({name:"내 HP",value:`${hpBar(player.hp,stats.maxHp)} \`${player.hp}/${stats.maxHp}\``,inline:true});
    return interaction.update({embeds:[embed],components:[mkBattleButtons(player)]});
  }

  if(action==="b_run"){delete battles[interaction.user.id];return interaction.update({content:"🏃 전투에서 도주했습니다!",embeds:[],components:[]});}
}

// ════════════════════════════════════════════════════════
// ── 컬링 핸들러
// ════════════════════════════════════════════════════════
async function handleCullingAction(interaction, player, culling, action) {
  const enemy=culling.currentEnemy; const stats=getPlayerStats(player); const log=[];
  if(action==="c_escape"){
    if(culling.wave>(player.cullingBest||0)) player.cullingBest=culling.wave;
    delete cullings[interaction.user.id]; savePlayer(interaction.user.id);
    return interaction.update({content:`🏳️ 컬링 종료! 최고기록: WAVE **${player.cullingBest}**`,embeds:[],components:[]});
  }
  if(action==="c_reverse"){
    if(!REVERSE_CHARS.has(player.active)) return interaction.reply({content:"❌ 반전술식 불가!",ephemeral:true});
    const heal=Math.floor(stats.maxHp*0.4); player.hp=Math.min(stats.maxHp,player.hp+heal); player.reverseCooldown=3;
    player.statusEffects=player.statusEffects.filter(s=>s.id==="battleInstinct");
    log.push(`> ♻️ **${heal}** HP 회복!`);
  } else if(action==="c_attack"||action==="c_skill"){
    if(isIncapacitated(player.statusEffects)) return interaction.reply({content:"❌ 상태이상으로 행동 불가!",ephemeral:true});
    const hit=rollHit(player.statusEffects,enemy.statusEffects);
    let dmg=0,isBlack=false;
    if(!hit){log.push("⚡ 공격이 **빗나갔다!**");}
    else if(action==="c_skill"){
      if(player.skillCooldown>0) return interaction.reply({content:`❌ 술식 쿨다운: ${player.skillCooldown}턴`,ephemeral:true});
      const skill=getCurrentSkill(player,player.active);
      dmg=calcSkillDmgForPlayer(player,skill.dmg); isBlack=isBlackFlash();
      if(isBlack){dmg=Math.floor(dmg*2.5);player.crystals+=50;}
      const statusLog=applySkillStatus(skill,enemy,player);
      const fx=getSkillEffect(skill.name);
      log.push(fx.art);
      log.push(`> *"${fx.flavorText}"*`);
      if(isBlack) log.push(`⚫ **흑섬!** **${dmg}** 피해! (×2.5) +50💎`);
      else log.push(`> 🌀 **${skill.name}** — **${dmg}** 피해!`);
      log.push(...statusLog);
      player.skillCooldown=5;
      updateQuestProgress(player,"skill_use",1);
      updateMQProgress(player,"skill_use",1); tryCompleteMQ(player);
    } else{
      dmg=calcDmgForPlayer(player,enemy.def); isBlack=isBlackFlash();
      if(isBlack){dmg=Math.floor(dmg*2.5);player.crystals+=50;log.push(`⚫ **흑섬!** **${dmg}** 피해!`);}
      else log.push(`> ⚔️ 공격! **${dmg}** 피해!`);
    }
    culling.enemyHp=Math.max(0,culling.enemyHp-dmg);
    if(culling.enemyHp<=0){
      const kb=getKoganeBonus(player);
      const xp=Math.floor(enemy.xp*kb.xp),cr=Math.floor(enemy.crystals*kb.crystal);
      culling.totalXp+=xp; culling.totalCrystals+=cr; culling.kills++;
      player.xp+=xp; player.crystals+=cr;
      player.mastery[player.active]=(player.mastery[player.active]||0)+(enemy.masteryXp||1);
      if(enemy.fingers){player.sukunaFingers=Math.min(SUKUNA_FINGER_MAX,(player.sukunaFingers||0)+enemy.fingers);const unlocked=checkSukunaUnlock(player);if(unlocked)log.push(`> 👹 **스쿠나 캐릭터 해금!** (\`!활성 sukuna\`)`);}
      const drops=rollDrops(enemy.id); addMaterials(player,drops);
      updateQuestProgress(player,"battle_win",1); updateMQProgress(player,"battle_win",1);
      if(enemy.id==="e3"||enemy.id==="e4"){updateQuestProgress(player,"boss_kill",1);updateMQProgress(player,"boss_kill",1);}
      tryCompleteMQ(player);
      culling.wave++;
      updateQuestProgress(player,"culling_wave",1);
      // 컬링 최고 WAVE 주력퀘 업데이트
      if(culling.wave>(player.cullingBest||0)){player.cullingBest=culling.wave;}
      updateMQProgress(player,"culling_wave_max",1,{wave:culling.wave});
      // culling_wave_max: 현재 웨이브가 목표에 달했는지 직접 체크
      const mqC=getCurrentMQ(player,player.active);
      if(mqC&&mqC.type==="culling_wave_max"){const p=getMQProgress(player,player.active);if(culling.wave>=mqC.target&&p.progress<mqC.target){p.progress=mqC.target;}tryCompleteMQ(player);}
      const next=pickCullingEnemy(culling.wave);
      culling.currentEnemy=next; culling.enemyHp=next.hp;
      log.push(`> ✅ 처치! +${xp}XP +${cr}💎`);
      if(Object.keys(drops).length) log.push(`> 📦 ${formatDrops(drops)}`);
      log.push(`> 🌊 **WAVE ${culling.wave}** — **${next.name}** 등장!`);
    } else{
      await doEnemyAttack(player,enemy,log);
      if(player.hp<=0){
        if(culling.wave>(player.cullingBest||0)) player.cullingBest=culling.wave;
        delete cullings[interaction.user.id]; savePlayer(interaction.user.id);
        return interaction.update({embeds:[new EmbedBuilder().setTitle("💀 컬링 종료!").setColor(0xe63946).setDescription(`> WAVE **${culling.wave}** 에서 쓰러짐!\n> 최고기록: WAVE **${player.cullingBest}**`)],components:[]});
      }
    }
  }
  tickCooldowns(player); savePlayer(interaction.user.id);
  return interaction.update({embeds:[cullingEmbed(player,culling,log)],components:[mkCullingButtons(player)]});
}

// ════════════════════════════════════════════════════════
// ── 사멸회유 핸들러
// ════════════════════════════════════════════════════════
async function handleJujutsuAction(interaction, player, jujutsu, action) {
  const stats=getPlayerStats(player); const log=[];
  if(action==="j_escape"){
    if(jujutsu.points>(player.jujutsuBest||0)) player.jujutsuBest=jujutsu.points;
    delete jujutsus[interaction.user.id]; savePlayer(interaction.user.id);
    return interaction.update({content:`🏳️ 사멸회유 종료! 최고기록: **${player.jujutsuBest}pt**`,embeds:[],components:[]});
  }
  const enemy=jujutsu.currentEnemy;
  if(!enemy) return interaction.reply({content:"❌ 적을 먼저 선택하세요!",ephemeral:true});
  if(action==="j_reverse"){
    if(!REVERSE_CHARS.has(player.active)) return interaction.reply({content:"❌ 반전술식 불가!",ephemeral:true});
    const heal=Math.floor(stats.maxHp*0.4); player.hp=Math.min(stats.maxHp,player.hp+heal);
    player.reverseCooldown=3; player.statusEffects=player.statusEffects.filter(s=>s.id==="battleInstinct");
    log.push(`> ♻️ **${heal}** HP 회복!`);
  } else{
    if(isIncapacitated(player.statusEffects)) return interaction.reply({content:"❌ 상태이상으로 행동 불가!",ephemeral:true});
    const hit=rollHit(player.statusEffects,enemy.statusEffects); let dmg=0;
    if(!hit){log.push("⚡ 공격이 **빗나갔다!**");}
    else if(action==="j_skill"){
      if(player.skillCooldown>0) return interaction.reply({content:`❌ 술식 쿨다운: ${player.skillCooldown}턴`,ephemeral:true});
      const skill=getCurrentSkill(player,player.active);
      dmg=calcSkillDmgForPlayer(player,skill.dmg); const isBlack=isBlackFlash();
      if(isBlack){dmg=Math.floor(dmg*2.5);player.crystals+=50;}
      const statusLog=applySkillStatus(skill,enemy,player);
      const fx=getSkillEffect(skill.name);
      log.push(fx.art); log.push(`> *"${fx.flavorText}"*`);
      if(isBlack) log.push(`⚫ **흑섬!** **${dmg}** 피해! +50💎`);
      else log.push(`> 🌀 **${skill.name}** — **${dmg}** 피해!`);
      log.push(...statusLog); player.skillCooldown=5;
      updateQuestProgress(player,"skill_use",1); updateMQProgress(player,"skill_use",1); tryCompleteMQ(player);
    } else{
      dmg=calcDmgForPlayer(player,enemy.def); const isBlack=isBlackFlash();
      if(isBlack){dmg=Math.floor(dmg*2.5);player.crystals+=50;log.push(`⚫ **흑섬!** **${dmg}** 피해!`);}
      else log.push(`> ⚔️ 공격! **${dmg}** 피해!`);
    }
    jujutsu.enemyHp=Math.max(0,jujutsu.enemyHp-dmg);
    if(jujutsu.enemyHp<=0){
      const kb=getKoganeBonus(player); const xp=Math.floor(enemy.xp*kb.xp),cr=Math.floor(enemy.crystals*kb.crystal);
      jujutsu.totalXp+=xp; jujutsu.totalCrystals+=cr; jujutsu.points+=enemy.points||1;
      player.xp+=xp; player.crystals+=cr;
      player.mastery[player.active]=(player.mastery[player.active]||0)+(enemy.masteryXp||1);
      const drops=rollDrops(enemy.id,true); addMaterials(player,drops);
      updateQuestProgress(player,"battle_win",1); updateQuestProgress(player,"jujutsu_point",enemy.points||1);
      updateMQProgress(player,"jujutsu_point",enemy.points||1); tryCompleteMQ(player);
      if(enemy.id==="j5"||enemy.id==="j6"){updateQuestProgress(player,"boss_kill",1);updateMQProgress(player,"boss_kill",1);tryCompleteMQ(player);}
      log.push(`> ✅ **${enemy.name}** 처치! +${xp}XP +${cr}💎 +${enemy.points}점`);
      if(Object.keys(drops).length) log.push(`> 📦 ${formatDrops(drops)}`);
      if(jujutsu.points>=15){
        player.crystals+=300; player.xp+=500;
        if(jujutsu.points>(player.jujutsuBest||0)) player.jujutsuBest=jujutsu.points;
        // 사멸회유 클리어 카운트 & 주력퀘 업데이트
        player.jujutsuClears=(player.jujutsuClears||0)+1;
        updateMQProgress(player,"jujutsu_clear",1); tryCompleteMQ(player);
        delete jujutsus[interaction.user.id];
        const over=new EmbedBuilder().setTitle("🏆 사멸회유 클리어!").setColor(0xF5C842)
          .setDescription(["```ansi","\u001b[1;33m╔════════════════╗\n║   CLEAR!! 🏆   ║\n╚════════════════╝","```",`> 15포인트 달성! **+300💎 +500XP** 보너스!`,getNewlyCompletedQuestMsg(player)].filter(Boolean).join("\n"));
        savePlayer(interaction.user.id);
        return interaction.update({embeds:[over],components:[]});
      }
      jujutsu.wave++; jujutsu.currentEnemy=null; jujutsu.enemyHp=0;
      const choices=generateJujutsuChoices(jujutsu.wave); jujutsu.choices=choices;
      const embed=jujutsuEmbed(player,jujutsu,log,choices);
      tickCooldowns(player); savePlayer(interaction.user.id);
      return interaction.update({embeds:[embed],components:mkJujutsuButtons(player,choices)});
    }
    await doEnemyAttack(player,enemy,log);
    if(player.hp<=0){
      if(jujutsu.points>(player.jujutsuBest||0)) player.jujutsuBest=jujutsu.points;
      delete jujutsus[interaction.user.id]; savePlayer(interaction.user.id);
      return interaction.update({embeds:[new EmbedBuilder().setTitle("💀 사멸회유 종료!").setColor(0xe63946).setDescription(`> **${jujutsu.points}포인트** 획득!`)],components:[]});
    }
  }
  tickCooldowns(player); savePlayer(interaction.user.id);
  const embed=jujutsuEmbed(player,jujutsu,log);
  const rows=mkJujutsuButtons(player,[]);
  return interaction.update({embeds:[embed],components:[rows[1]]});
}

// ════════════════════════════════════════════════════════
// ── PvP 핸들러
// ════════════════════════════════════════════════════════
async function handlePvpAction(interaction, player, session, action) {
  const selfKeys=pvpSelf(session,player.id); const oppKeys=pvpOpponent(session,player.id);
  const opp=players[oppKeys.id]; const selfStats=getPlayerStats(player); const oppStats=getPlayerStats(opp);
  const log=[];
  if(action==="p_surrender"){
    player.pvpLosses++; opp.pvpWins++;
    updateQuestProgress(opp,"pvp_win",1); updateMQProgress(opp,"pvp_win",1); tryCompleteMQ(opp);
    // pvp_win_sp 체크: 특급 이상 상대 여부
    if(["특급","준특급"].includes(CHARACTERS[player.active].grade)){updateMQProgress(opp,"pvp_win_sp",1);tryCompleteMQ(opp);}
    const sid=Object.keys(pvpSessions).find(k=>pvpSessions[k]===session); if(sid) delete pvpSessions[sid];
    savePlayer(player.id); savePlayer(opp.id);
    return interaction.update({content:`🏳️ **${player.name}** 항복! **${opp.name}** 승리!`,embeds:[],components:[]});
  }
  if(action==="p_attack"){
    const hit=rollHit(player.statusEffects,session[oppKeys.statusKey]);
    if(!hit){log.push("⚡ 공격이 빗나갔다!");}
    else{
      let dmg=calcDmg(selfStats.atk*getWeakenMult(player.statusEffects),oppStats.def);
      const isBlack=isBlackFlash();
      if(isBlack){dmg=Math.floor(dmg*2.5);log.push(`⚫ **흑섬!** **${dmg}** 피해! (×2.5)`);}
      else log.push(`⚔️ **${player.name}**의 공격! **${dmg}** 피해!`);
      session[oppKeys.hpKey]=Math.max(0,session[oppKeys.hpKey]-dmg);
    }
  } else if(action==="p_skill"){
    if(session[selfKeys.skillCdKey]>0) return interaction.reply({content:"❌ 술식 쿨다운!",ephemeral:true});
    const skill=getCurrentSkill(player,player.active); const hit=rollHit(player.statusEffects,session[oppKeys.statusKey]);
    if(!hit){log.push("⚡ 술식이 빗나갔다!");}
    else{
      let dmg=calcSkillDmgForPlayer(player,skill.dmg); const isBlack=isBlackFlash();
      if(isBlack){dmg=Math.floor(dmg*2.5);log.push(`⚫ **흑섬!** **${dmg}** 피해!`);}
      else{const fx=getSkillEffect(skill.name);log.push(fx.art);log.push(`🌀 **${skill.name}** — **${dmg}** 피해!`);}
      if(skill.statusApply&&Math.random()<skill.statusApply.chance&&skill.statusApply.target==="enemy"){applyStatus({statusEffects:session[oppKeys.statusKey]},skill.statusApply.statusId);log.push(`${STATUS_EFFECTS[skill.statusApply.statusId]?.emoji} 상태이상!`);}
      session[oppKeys.hpKey]=Math.max(0,session[oppKeys.hpKey]-dmg);
    }
    session[selfKeys.skillCdKey]=5;
    updateQuestProgress(player,"skill_use",1); updateMQProgress(player,"skill_use",1); tryCompleteMQ(player);
  } else if(action==="p_domain"){
    const ch=CHARACTERS[player.active]; if(!ch.domain) return interaction.reply({content:"❌ 영역전개 없음!",ephemeral:true});
    const dmg=Math.floor(selfStats.atk*2.8); session[oppKeys.hpKey]=Math.max(0,session[oppKeys.hpKey]-dmg);
    log.push(`🌌 **${ch.domain}** — **${dmg}** 피해!`);
  } else if(action==="p_reverse"){
    if(!REVERSE_CHARS.has(player.active)) return interaction.reply({content:"❌ 반전술식 불가!",ephemeral:true});
    if(session[selfKeys.reverseCdKey]>0) return interaction.reply({content:"❌ 반전 쿨다운!",ephemeral:true});
    const heal=Math.floor(selfStats.maxHp*0.4); session[selfKeys.hpKey]=Math.min(selfStats.maxHp,session[selfKeys.hpKey]+heal);
    session[selfKeys.reverseCdKey]=3; log.push(`♻️ **${heal}** HP 회복!`);
  }
  if(session[oppKeys.hpKey]<=0){
    player.pvpWins++; opp.pvpLosses++;
    updateQuestProgress(player,"pvp_win",1); updateMQProgress(player,"pvp_win",1);
    if(["특급","준특급"].includes(CHARACTERS[opp.active].grade)){updateMQProgress(player,"pvp_win_sp",1);}
    tryCompleteMQ(player);
    const sid=Object.keys(pvpSessions).find(k=>pvpSessions[k]===session); if(sid) delete pvpSessions[sid];
    savePlayer(player.id); savePlayer(opp.id);
    const winEmbed=new EmbedBuilder().setTitle(`🏆 ${player.name} 승리!`).setColor(0xF5C842)
      .setDescription(`> **${player.name}** 이 **${opp.name}** 을 격파!\n> PvP 전적: **${player.pvpWins}**승 **${player.pvpLosses}**패`);
    return interaction.update({embeds:[pvpEmbed(session,log),winEmbed],components:[]});
  }
  session.round++; session.turn=oppKeys.id;
  if(session[selfKeys.skillCdKey]>0) session[selfKeys.skillCdKey]--;
  if(session[selfKeys.reverseCdKey]>0) session[selfKeys.reverseCdKey]--;
  await interaction.update({embeds:[pvpEmbed(session,log)],components:[mkPvpButtons(session,oppKeys.id)]});
}

// ════════════════════════════════════════════════════════
// ── 파티 컬링 핸들러
// ════════════════════════════════════════════════════════
async function handlePartyCullingAction(interaction, player, session, action) {
  const party=getParty(player.id); if(!party) return;
  const enemy=session.current
  const party=getParty(player.id); if(!party) return;
  const enemy=session.currentEnemy;
  const log=[];
  
  if(action==="pc_escape"){
    if(session.wave>(player.cullingBest||0)) player.cullingBest=session.wave;
    // 파티의 다른 멤버들도 종료
    for(const uid of party.members){
      if(cullings[uid]) delete cullings[uid];
    }
    if(parties[party.id]) delete parties[party.id];
    savePlayer(player.id);
    return interaction.update({content:`🏳️ 파티 컬링 종료! 최고기록: WAVE **${player.cullingBest}**`,embeds:[],components:[]});
  }
  
  if(action==="pc_reverse"){
    if(!REVERSE_CHARS.has(player.active)) return interaction.reply({content:"❌ 반전술식 불가!",ephemeral:true});
    const stats=getPlayerStats(player);
    const heal=Math.floor(stats.maxHp*0.4);
    player.hp=Math.min(stats.maxHp,player.hp+heal);
    player.reverseCooldown=3;
    player.statusEffects=player.statusEffects.filter(s=>s.id==="battleInstinct");
    log.push(`> ♻️ **${player.name}** — ${heal} HP 회복!`);
  } else if(action==="pc_attack"||action==="pc_skill"){
    if(isIncapacitated(player.statusEffects)) return interaction.reply({content:"❌ 상태이상으로 행동 불가!",ephemeral:true});
    const hit=rollHit(player.statusEffects,enemy.statusEffects);
    let dmg=0,isBlack=false;
    if(!hit){
      log.push(`> ⚡ **${player.name}**의 공격이 빗나갔다!`);
    } else if(action==="pc_skill"){
      if(player.skillCooldown>0) return interaction.reply({content:`❌ 술식 쿨다운: ${player.skillCooldown}턴`,ephemeral:true});
      const skill=getCurrentSkill(player,player.active);
      dmg=calcSkillDmgForPlayer(player,skill.dmg);
      isBlack=isBlackFlash();
      if(isBlack){dmg=Math.floor(dmg*2.5);player.crystals+=50;}
      const statusLog=applySkillStatus(skill,enemy,player);
      const fx=getSkillEffect(skill.name);
      log.push(fx.art);
      if(isBlack) log.push(`> ⚫ **${player.name} 흑섬!** ${dmg} 피해!`);
      else log.push(`> 🌀 **${player.name}** — ${skill.name}! ${dmg} 피해!`);
      log.push(...statusLog);
      player.skillCooldown=5;
      updateQuestProgress(player,"skill_use",1);
      updateMQProgress(player,"skill_use",1);
      tryCompleteMQ(player);
    } else {
      dmg=calcDmgForPlayer(player,enemy.def);
      isBlack=isBlackFlash();
      if(isBlack){dmg=Math.floor(dmg*2.5);player.crystals+=50;log.push(`> ⚫ **${player.name} 흑섬!** ${dmg} 피해!`);}
      else log.push(`> ⚔️ **${player.name}** 공격! ${dmg} 피해!`);
    }
    session.enemyHp=Math.max(0,session.enemyHp-dmg);
    
    if(session.enemyHp<=0){
      const kb=getKoganeBonus(player);
      const xp=Math.floor(enemy.xp*kb.xp), cr=Math.floor(enemy.crystals*kb.crystal);
      session.totalXp+=xp; session.totalCrystals+=cr; session.kills++;
      player.xp+=xp; player.crystals+=cr;
      player.mastery[player.active]=(player.mastery[player.active]||0)+(enemy.masteryXp||1);
      if(enemy.fingers){
        player.sukunaFingers=Math.min(SUKUNA_FINGER_MAX,(player.sukunaFingers||0)+enemy.fingers);
        const unlocked=checkSukunaUnlock(player);
        if(unlocked) log.push(`> 👹 **${player.name}** — 스쿠나 해금!`);
      }
      const drops=rollDrops(enemy.id);
      addMaterials(player,drops);
      updateQuestProgress(player,"battle_win",1);
      updateMQProgress(player,"battle_win",1);
      if(enemy.id==="e3"||enemy.id==="e4"){
        updateQuestProgress(player,"boss_kill",1);
        updateMQProgress(player,"boss_kill",1);
      }
      tryCompleteMQ(player);
      
      session.wave++;
      updateQuestProgress(player,"culling_wave",1);
      if(session.wave>(player.cullingBest||0)) player.cullingBest=session.wave;
      updateMQProgress(player,"culling_wave_max",1);
      const mqC=getCurrentMQ(player,player.active);
      if(mqC&&mqC.type==="culling_wave_max"){
        const p=getMQProgress(player,player.active);
        if(session.wave>=mqC.target&&p.progress<mqC.target) p.progress=mqC.target;
        tryCompleteMQ(player);
      }
      
      const next=pickCullingEnemy(session.wave);
      session.currentEnemy=next;
      session.enemyHp=next.hp;
      log.push(`> ✅ **${enemy.name}** 처치! +${xp}XP +${cr}💎`);
      if(Object.keys(drops).length) log.push(`> 📦 ${formatDrops(drops)}`);
      log.push(`> 🌊 **WAVE ${session.wave}** — ${next.name} 등장!`);
      
      // 파티 전체 저장
      for(const uid of party.members) savePlayer(uid);
      return interaction.update({
        embeds:[partyCullingEmbed(party, session, log)],
        components:[mkCullingButtons(player)]
      });
    } else {
      // 적 반격 (파티 전체 중 무작위)
      const targets = party.members.filter(uid => players[uid] && players[uid].hp > 0);
      if(targets.length > 0){
        const targetId = targets[Math.floor(Math.random() * targets.length)];
        const targetPlayer = players[targetId];
        const targetStats = getPlayerStats(targetPlayer);
        const tick=tickStatus(targetPlayer, targetStats.maxHp);
        if(tick.log.length) log.push(...tick.log.map(l=>`> **${targetPlayer.name}**: ${l}`));
        
        const enemyHit=rollHit(enemy.statusEffects||[], targetPlayer.statusEffects);
        if(!enemyHit){
          log.push(`> ↩️ **${enemy.name}**의 공격이 **${targetPlayer.name}**에게 빗나갔다!`);
        } else {
          const eDmg=calcDmg(enemy.atk, targetStats.def);
          targetPlayer.hp=Math.max(0, targetPlayer.hp - eDmg);
          log.push(`> 💢 **${enemy.name}** 반격 → **${targetPlayer.name}** ${eDmg} 피해!`);
          if(enemy.statusAttack && Math.random() < (enemy.statusAttack.chance||0.3)){
            applyStatus(targetPlayer, enemy.statusAttack.statusId);
            const sdef=STATUS_EFFECTS[enemy.statusAttack.statusId];
            log.push(`> ${sdef.emoji}**${targetPlayer.name}** ${sdef.name} 상태이상!`);
          }
        }
        
        if(targetPlayer.hp <= 0){
          log.push(`> 💀 **${targetPlayer.name}** 쓰러짐!`);
        }
      }
      
      // 파티 전멸 체크
      const alive = party.members.filter(uid => players[uid] && players[uid].hp > 0);
      if(alive.length === 0){
        if(session.wave > (player.cullingBest||0)) player.cullingBest = session.wave;
        for(const uid of party.members) savePlayer(uid);
        if(parties[party.id]) delete parties[party.id];
        return interaction.update({
          embeds:[new EmbedBuilder().setTitle("💀 파티 컬링 전멸!").setColor(0xe63946)
            .setDescription(`> WAVE **${session.wave}** 에서 전멸!\n> 최고기록: WAVE **${player.cullingBest}**`)],
          components:[]
        });
      }
    }
  }
  
  tickCooldowns(player);
  savePlayer(player.id);
  for(const uid of party.members) if(uid !== player.id) savePlayer(uid);
  
  return interaction.update({
    embeds:[partyCullingEmbed(party, session, log)],
    components:[mkCullingButtons(player)]
  });
}

// ════════════════════════════════════════════════════════
// ── 슬래시 커맨드 등록
// ════════════════════════════════════════════════════════
client.once("ready", async () => {
  console.log(`✅ ${client.user.tag} 로그인 완료!`);
  
  // DB 로드
  const loaded = await dbLoad();
  players = loaded;
  
  // 슬래시 커맨드 등록
  const commands = [
    { name: "프로필", description: "내 주술사 프로필 확인" },
    { name: "전투", description: "일반 전투 시작" },
    { name: "컬링", description: "컬링 게임 시작 (웨이브 도전)" },
    { name: "사멸회유", description: "사멸회유 시작 (포인트 수집)" },
    { name: "가챠", description: "주술사 가챠 (1회 / 10회)", options: [{ name: "회수", type: 4, description: "1 또는 10", required: true }] },
    { name: "코가네가챠", description: "코가네 펫 가챠 (200💎)" },
    { name: "코가네", description: "내 코가네 펫 정보" },
    { name: "활성", description: "활성 캐릭터 변경", options: [{ name: "캐릭터id", type: 3, description: "itadori, gojo, megumi 등", required: true }] },
    { name: "목록", description: "보유 캐릭터 목록" },
    { name: "일일보상", description: "일일 출석 보상" },
    { name: "회복", description: "회복약 사용 (HP 100% 회복)" },
    { name: "구매", description: "회복약 구매 (50💎)", options: [{ name: "개수", type: 4, description: "구매할 포션 개수", required: true }] },
    { name: "랭킹", description: "전투 승수 랭킹" },
    { name: "초기화", description: "모든 데이터 초기화 (⚠️ 주의)" },
    { name: "코드", description: "쿠폰 코드 사용", options: [{ name: "코드", type: 3, description: "쿠폰 코드", required: true }] },
    { name: "퀘스트", description: "일일/주간 퀘스트 확인" },
    { name: "퀘보상", description: "퀘스트 보상 수령", options: [{ name: "타입", type: 3, description: "일 or 주", required: true }, { name: "번호", type: 4, description: "퀘스트 번호 (1~3)", required: true }] },
    { name: "주력퀘스트", description: "주력 스킬 퀘스트 확인" },
    { name: "재료", description: "재료 인벤토리 확인" },
    { name: "주구목록", description: "제작 가능한 주구 목록" },
    { name: "주구제작", description: "주구 제작", options: [{ name: "무기id", type: 3, description: "무기 ID", required: true }] },
    { name: "장착", description: "주구 장착", options: [{ name: "무기id", type: 3, description: "무기 ID", required: true }] },
    { name: "해제", description: "주구 장착 해제" },
  ];
  
  try {
    await client.application.commands.set(commands);
    console.log(`✅ 슬래시 커맨드 ${commands.length}개 등록`);
  } catch(e) { console.error("커맨드 등록 실패:", e); }
});

// ════════════════════════════════════════════════════════
// ── 슬래시 커맨드 핸들러
// ════════════════════════════════════════════════════════
client.on("interactionCreate", async (interaction) => {
  if(interaction.isButton()) return handleButton(interaction);
  if(!interaction.isCommand()) return;
  
  const userId = interaction.user.id;
  const player = getPlayer(userId, interaction.user.username);
  
  switch(interaction.commandName){
    case "프로필":
      await interaction.reply({ embeds: [profileEmbed(player)] });
      break;
      
    case "전투":
      if(battles[userId]) return interaction.reply({ content: "❌ 이미 전투 중!", ephemeral: true });
      const enemy = ENEMIES[Math.floor(Math.random() * ENEMIES.length)];
      battles[userId] = { enemy: { ...enemy, currentHp: enemy.hp, statusEffects: [] } };
      const embed = new EmbedBuilder()
        .setTitle(`⚔️ ${enemy.name} 등장!`)
        .setColor(0xff6b35)
        .setDescription(`> ${enemy.emoji} HP: ${enemy.hp} | ATK: ${enemy.atk} | DEF: ${enemy.def}`)
        .addFields({ name: "내 HP", value: `${hpBar(player.hp, getPlayerStats(player).maxHp)}`, inline: true });
      await interaction.reply({ embeds: [embed], components: [mkBattleButtons(player)] });
      break;
      
    case "컬링":
      if(cullings[userId]) return interaction.reply({ content: "❌ 이미 컬링 중!", ephemeral: true });
      const startWave = 1;
      const firstEnemy = pickCullingEnemy(startWave);
      cullings[userId] = {
        wave: startWave, kills: 0, totalXp: 0, totalCrystals: 0,
        currentEnemy: firstEnemy, enemyHp: firstEnemy.hp
      };
      await interaction.reply({ embeds: [cullingEmbed(player, cullings[userId])], components: [mkCullingButtons(player)] });
      break;
      
    case "사멸회유":
      if(jujutsus[userId]) return interaction.reply({ content: "❌ 이미 사멸회유 중!", ephemeral: true });
      const choices = generateJujutsuChoices(1);
      jujutsus[userId] = {
        wave: 1, points: 0, totalXp: 0, totalCrystals: 0,
        choices: choices, currentEnemy: null, enemyHp: 0
      };
      await interaction.reply({ embeds: [jujutsuEmbed(player, jujutsus[userId], [], choices)], components: mkJujutsuButtons(player, choices) });
      break;
      
    case "가챠":
      const count = interaction.options.getInteger("회수");
      if(count !== 1 && count !== 10) return interaction.reply({ content: "1회 또는 10회만 가능!", ephemeral: true });
      const cost = count === 1 ? 200 : 1800;
      if(player.crystals < cost) return interaction.reply({ content: `❌ 크리스탈 부족! (${cost} 필요)`, ephemeral: true });
      
      player.crystals -= cost;
      const results = rollGacha(count);
      const newOnes = [];
      let dupCrystals = 0;
      
      // 먼저 예열 임베드 전송
      await interaction.reply({ embeds: [buildGachaLoadEmbed(1)] });
      
      for(const charId of results){
        if(!player.owned.includes(charId)){
          player.owned.push(charId);
          newOnes.push(charId);
          if(!player.mastery[charId]) player.mastery[charId] = 0;
        } else {
          dupCrystals += 50;
          player.crystals += 50;
        }
      }
      
      await new Promise(r => setTimeout(r, 1500));
      if(count === 1){
        const charId = results[0];
        const grade = CHARACTERS[charId].grade;
        const isNew = newOnes.includes(charId);
        await interaction.editReply({ embeds: [buildGachaRevealEmbed(grade, charId, isNew, player)] });
      } else {
        await interaction.editReply({ embeds: [buildGacha10ResultEmbed(results, newOnes, dupCrystals, player)] });
      }
      savePlayer(userId);
      break;
      
    case "코가네가챠":
      if(player.crystals < 200) return interaction.reply({ content: "❌ 크리스탈 부족! (200 필요)", ephemeral: true });
      player.crystals -= 200;
      player.koganeGachaCount = (player.koganeGachaCount || 0) + 1;
      const grade = rollKogane();
      const isUpgrade = !player.kogane || KOGANE_GRADES[grade].rate < KOGANE_GRADES[player.kogane.grade]?.rate;
      if(isUpgrade) player.kogane = { grade: grade };
      else player.crystals += 50;
      savePlayer(userId);
      await interaction.reply({ embeds: [buildKoganeGachaEmbed(grade, isUpgrade, player)] });
      break;
      
    case "코가네":
      await interaction.reply({ embeds: [koganeProfileEmbed(player)] });
      break;
      
    case "활성":
      const charId = interaction.options.getString("캐릭터id").toLowerCase();
      if(!player.owned.includes(charId)) return interaction.reply({ content: "❌ 보유하지 않은 캐릭터!", ephemeral: true });
      player.active = charId;
      player.hp = getPlayerStats(player).maxHp;
      savePlayer(userId);
      await interaction.reply(`✅ 활성 캐릭터 변경: **${CHARACTERS[charId].name}**`);
      break;
      
    case "목록":
      const ownedList = player.owned.map(id => {
        const c = CHARACTERS[id];
        return `${c.emoji} **${c.name}** \`${c.grade}\`${id === player.active ? " (활성)" : ""}`;
      }).join("\n");
      await interaction.reply({ embeds: [new EmbedBuilder().setTitle("📖 보유 캐릭터").setColor(0x7C5CFC).setDescription(ownedList)] });
      break;
      
    case "일일보상":
      const today = getTodayKey();
      if(player.lastDaily === today) return interaction.reply({ content: "❌ 이미 오늘 보상 받음!", ephemeral: true });
      player.lastDaily = today;
      player.dailyStreak = (player.dailyStreak || 0) + 1;
      const streakBonus = Math.min(player.dailyStreak, 7) * 50;
      player.crystals += 200 + streakBonus;
      player.xp += 100;
      await interaction.reply(`✅ 일일보상! +200💎 +100XP\n🔥 연속 ${player.dailyStreak}일 (+${streakBonus}💎)`);
      savePlayer(userId);
      break;
      
    case "회복":
      if(player.potion <= 0) return interaction.reply({ content: "❌ 회복약 없음! `!구매`", ephemeral: true });
      const maxHp = getPlayerStats(player).maxHp;
      player.hp = maxHp;
      player.potion--;
      savePlayer(userId);
      await interaction.reply(`💚 HP 완전 회복! 남은 포션: **${player.potion}**개`);
      break;
      
    case "구매":
      const amount = interaction.options.getInteger("개수");
      const totalCost = amount * 50;
      if(totalCost <= 0) return interaction.reply({ content: "1개 이상 입력", ephemeral: true });
      if(player.crystals < totalCost) return interaction.reply({ content: `❌ 크리스탈 부족! (${totalCost} 필요)`, ephemeral: true });
      player.crystals -= totalCost;
      player.potion += amount;
      savePlayer(userId);
      await interaction.reply(`✅ 포션 ${amount}개 구매! +${amount}개 (총 ${player.potion}개)`);
      break;
      
    case "랭킹":
      const sorted = Object.values(players).sort((a,b) => b.wins - a.wins).slice(0,10);
      const rankList = sorted.map((p,i) => `${i+1}. **${p.name}** — ${p.wins}승 ${p.pvpWins}PvP승`).join("\n");
      await interaction.reply({ embeds: [new EmbedBuilder().setTitle("🏆 전투 승수 랭킹").setColor(0xF5C842).setDescription(rankList || "데이터 없음")] });
      break;
      
    case "초기화":
      if(!isDev(userId)) return interaction.reply({ content: "❌ 개발자 전용!", ephemeral: true });
      delete players[userId];
      savePlayer(userId);
      await interaction.reply("✅ 데이터 초기화 완료! 다시 시작하세요.");
      break;
      
    case "코드":
      const code = interaction.options.getString("코드").toLowerCase();
      if(player.usedCodes.includes(code)) return interaction.reply({ content: "이미 사용한 코드!", ephemeral: true });
      const reward = CODES[code];
      if(!reward) return interaction.reply({ content: "유효하지 않은 코드!", ephemeral: true });
      player.usedCodes.push(code);
      player.crystals += reward.crystals || 0;
      player.xp += reward.xp || 0;
      savePlayer(userId);
      await interaction.reply(`✅ 코드 사용! +${reward.crystals||0}💎 +${reward.xp||0}XP`);
      break;
      
    case "퀘스트":
      await interaction.reply({ embeds: [questEmbed(player)] });
      break;
      
    case "퀘보상":
      const type = interaction.options.getString("타입");
      const idx = interaction.options.getInteger("번호") - 1;
      if(idx < 0 || idx > 2) return interaction.reply({ content: "번호는 1~3", ephemeral: true });
      const isWeekly = type === "주";
      const list = isWeekly ? player.quests.weekly : player.quests.daily;
      if(!list || !list[idx]) return interaction.reply({ content: "존재하지 않는 퀘스트", ephemeral: true });
      const qp = list[idx];
      if(!qp.done || qp.claimed) return interaction.reply({ content: "완료되지 않았거나 이미 수령함", ephemeral: true });
      const rewardData = claimQuestReward(player, qp.id, isWeekly);
      if(!rewardData) return interaction.reply({ content: "오류 발생", ephemeral: true });
      savePlayer(userId);
      await interaction.reply(`✅ 보상 수령! +${rewardData.crystals||0}💎 +${rewardData.xp||0}XP`);
      break;
      
    case "주력퀘스트":
      await interaction.reply({ embeds: [mainQuestEmbed(player)] });
      break;
      
    case "재료":
      await interaction.reply({ embeds: [materialsEmbed(player)] });
      break;
      
    case "주구목록":
      await interaction.reply({ embeds: [weaponListEmbed(player)] });
      break;
      
    case "주구제작":
      const weaponId = interaction.options.getString("무기id");
      const weapon = WEAPONS[weaponId];
      if(!weapon) return interaction.reply({ content: "존재하지 않는 주구!", ephemeral: true });
      if(player.craftedWeapons?.includes(weaponId)) return interaction.reply({ content: "이미 제작한 주구!", ephemeral: true });
      const materials = player.materials || {};
      for(const [mat, qty] of Object.entries(weapon.recipe)){
        if((materials[mat]||0) < qty) return interaction.reply({ content: `재료 부족: ${MATERIALS[mat]?.emoji} ${MATERIALS[mat]?.name} ${qty}개 필요`, ephemeral: true });
      }
      for(const [mat, qty] of Object.entries(weapon.recipe)){
        materials[mat] -= qty;
      }
      if(!player.craftedWeapons) player.craftedWeapons = [];
      player.craftedWeapons.push(weaponId);
      savePlayer(userId);
      await interaction.reply(`✅ **${weapon.name}** 제작 완료! \`!장착 ${weaponId}\` 로 장착 가능`);
      break;
      
    case "장착":
      const equipId = interaction.options.getString("무기id");
      if(!player.craftedWeapons?.includes(equipId)) return interaction.reply({ content: "보유하지 않은 주구!", ephemeral: true });
      player.equippedWeapon = equipId;
      savePlayer(userId);
      await interaction.reply(`⚔️ **${WEAPONS[equipId].name}** 장착 완료!`);
      break;
      
    case "해제":
      player.equippedWeapon = null;
      savePlayer(userId);
      await interaction.reply("⚔️ 주구 장착 해제!");
      break;
  }
});

// ════════════════════════════════════════════════════════
// ── 버튼 핸들러
// ════════════════════════════════════════════════════════
async function handleButton(interaction) {
  const userId = interaction.user.id;
  const player = getPlayer(userId, interaction.user.username);
  const customId = interaction.customId;
  
  // 일반 전투
  if(battles[userId] && customId.startsWith("b_")){
    await handleBattleAction(interaction, player, battles[userId], customId);
    return;
  }
  
  // 컬링
  if(cullings[userId] && customId.startsWith("c_")){
    await handleCullingAction(interaction, player, cullings[userId], customId);
    return;
  }
  
  // 사멸회유
  if(jujutsus[userId]){
    if(customId === "j_attack" || customId === "j_skill" || customId === "j_reverse" || customId === "j_escape"){
      await handleJujutsuAction(interaction, player, jujutsus[userId], customId);
      return;
    }
    if(customId.startsWith("j_choice_")){
      const idx = parseInt(customId.split("_")[2]);
      const jujutsu = jujutsus[userId];
      if(!jujutsu.choices || !jujutsu.choices[idx]) return interaction.reply({ content: "잘못된 선택", ephemeral: true });
      const chosen = { ...jujutsu.choices[idx], currentHp: jujutsu.choices[idx].hp, statusEffects: [] };
      jujutsu.currentEnemy = chosen;
      jujutsu.enemyHp = chosen.hp;
      jujutsu.choices = null;
      await interaction.update({ embeds: [jujutsuEmbed(player, jujutsu, [`⚔️ **${chosen.name}** 선택!`])], components: [mkJujutsuButtons(player, [])[1]] });
      return;
    }
  }
  
  // PvP
  if(pvpSessions[userId] && customId.startsWith("p_")){
    const session = getPvpSessionByUser(userId);
    if(session) await handlePvpAction(interaction, player, session, customId);
    return;
  }
  
  await interaction.reply({ content: "진행 중인 전투가 없습니다.", ephemeral: true });
}

// ════════════════════════════════════════════════════════
// ── 자동 저장 인터벌
// ════════════════════════════════════════════════════════
setInterval(async () => {
  for(const uid of Object.keys(players)){
    if(!saveQueue.has(uid) && !savePending.has(uid)){
      try { await dbSave(uid, players[uid]); }
      catch(e) {}
    }
  }
  console.log(`💾 자동 저장 완료 (${Object.keys(players).length}명)`);
}, 5 * 60 * 1000);

// ════════════════════════════════════════════════════════
// ── 서버 시작
// ════════════════════════════════════════════════════════
dbInit().then(() => {
  client.login(TOKEN).catch(e => {
    console.error("디스코드 로그인 실패:", e);
    process.exit(1);
  });
});

// ════════════════════════════════════════════════════════
// ── 누락된 상수 추가
// ════════════════════════════════════════════════════════
const JJK_GRADE_LABEL = {
  "특급": "🔱 S P E C I A L",
  "준특급": "💠 S E M I - S P",
  "1급": "⭐ G R A D E  1",
  "준1급": "⭐ S E M I - 1",
  "2급": "🔹 G R A D E  2",
  "3급": "◽ G R A D E  3",
  "4급": "⬜ G R A D E  4",
};
