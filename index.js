// ════════════════════════════════════════════════════════
// 주술회전 RPG 봇 — 최종 완성본 (모든 기능 포함)
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
  "저주 실":   { name:"저주 실",   emoji:"🧵", desc:"저급 저주령에서 획득" },
  "저주 뼈":   { name:"저주 뼈",   emoji:"🦴", desc:"1급 저주령에서 획득" },
  "저주 핵":   { name:"저주 핵",   emoji:"💜", desc:"특급 저주령에서 획득" },
  "저주 수정": { name:"저주 수정", emoji:"💎", desc:"보스에서 획득" },
  "철 파편":   { name:"철 파편",   emoji:"⚙️", desc:"모든 적에서 획득" },
  "영혼 정수": { name:"영혼 정수", emoji:"✨", desc:"특급 이상 적에서 획득" },
  "용 비늘":   { name:"용 비늘",   emoji:"🐉", desc:"보스에서 획득" },
};

// ════════════════════════════════════════════════════════
// ── 주구 시스템
// ════════════════════════════════════════════════════════
const WEAPONS = {
  "저주 단검": { id:"cursed_knife", name:"저주 단검", emoji:"🗡️", grade:"일반", atkBonus:15, defBonus:0, hpBonus:0, recipe:{"저주 실":3,"철 파편":5}, color:0x94a3b8 },
  "저주 도검": { id:"cursed_blade", name:"저주 도검", emoji:"⚔️", grade:"희귀", atkBonus:35, defBonus:5, hpBonus:100, recipe:{"저주 뼈":4,"철 파편":8,"저주 실":2}, color:0x4ade80 },
  "저주 창": { id:"cursed_spear", name:"저주 창", emoji:"🔱", grade:"희귀", atkBonus:45, defBonus:0, hpBonus:0, recipe:{"저주 뼈":5,"저주 실":5}, color:0x4ade80 },
  "영혼 방패": { id:"spirit_shield", name:"영혼 방패", emoji:"🛡️", grade:"고급", atkBonus:5, defBonus:40, hpBonus:300, recipe:{"영혼 정수":3,"저주 핵":2,"철 파편":10}, color:0x7C5CFC },
  "저주 망치": { id:"cursed_hammer", name:"저주 망치", emoji:"🔨", grade:"고급", atkBonus:60, defBonus:10, hpBonus:150, recipe:{"저주 핵":3,"저주 뼈":6,"철 파편":12}, color:0x7C5CFC },
  "용의 검": { id:"dragon_sword", name:"용의 검", emoji:"🐉⚔️", grade:"전설", atkBonus:100, defBonus:30, hpBonus:500, recipe:{"용 비늘":3,"저주 수정":2,"영혼 정수":5,"저주 핵":4}, color:0xF5C842 },
  "스쿠나의 그릇": { id:"sukuna_vessel", name:"스쿠나의 그릇", emoji:"👹", grade:"전설", atkBonus:80, defBonus:20, hpBonus:800, recipe:{"저주 수정":3,"용 비늘":2,"저주 핵":6}, color:0x8b0000 },
};

function getWeaponByName(name) {
  return WEAPONS[name] || Object.values(WEAPONS).find(w => w.id === name);
}
function getWeaponStats(player) {
  if (!player.equippedWeapon) return { atk:0, def:0, hp:0 };
  const w = getWeaponByName(player.equippedWeapon);
  if (!w) return { atk:0, def:0, hp:0 };
  return { atk:w.atkBonus, def:w.defBonus, hp:w.hpBonus };
}

// ════════════════════════════════════════════════════════
// ── 적 드롭 테이블
// ════════════════════════════════════════════════════════
const ENEMY_DROPS = {
  e1: [{ mat:"저주 실",min:1,max:3,chance:0.80 },{ mat:"철 파편",min:1,max:2,chance:0.60 },{ mat:"저주 뼈",min:1,max:1,chance:0.10 }],
  e2: [{ mat:"저주 뼈",min:1,max:2,chance:0.70 },{ mat:"철 파편",min:2,max:4,chance:0.80 },{ mat:"저주 실",min:2,max:4,chance:0.50 },{ mat:"저주 핵",min:1,max:1,chance:0.08 }],
  e3: [{ mat:"저주 핵",min:1,max:2,chance:0.65 },{ mat:"영혼 정수",min:1,max:2,chance:0.55 },{ mat:"저주 뼈",min:2,max:4,chance:0.80 },{ mat:"철 파편",min:3,max:6,chance:0.90 },{ mat:"저주 수정",min:1,max:1,chance:0.05 }],
  e4: [{ mat:"저주 수정",min:1,max:2,chance:0.80 },{ mat:"용 비늘",min:1,max:2,chance:0.60 },{ mat:"영혼 정수",min:2,max:4,chance:0.90 },{ mat:"저주 핵",min:2,max:4,chance:0.90 },{ mat:"철 파편",min:5,max:10,chance:1.00 }],
  e_sukuna: [{ mat:"저주 수정",min:2,max:3,chance:1.00 },{ mat:"용 비늘",min:2,max:3,chance:1.00 },{ mat:"영혼 정수",min:4,max:6,chance:1.00 }],
  raid_heian: [{ mat:"저주 수정",min:3,max:5,chance:1.00 },{ mat:"용 비늘",min:3,max:4,chance:1.00 },{ mat:"영혼 정수",min:5,max:8,chance:1.00 }],
  raid_mahoraga: [{ mat:"저주 수정",min:3,max:5,chance:1.00 },{ mat:"용 비늘",min:4,max:6,chance:1.00 },{ mat:"영혼 정수",min:5,max:8,chance:1.00 },{ mat:"철 파편",min:10,max:20,chance:1.00 }],
};

function rollDrops(enemyId, isJujutsu=false) {
  const table = isJujutsu ? {} : ENEMY_DROPS[enemyId];
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

// ════════════════════════════════════════════════════════
// ── 퀘스트 시스템
// ════════════════════════════════════════════════════════
const DAILY_QUESTS = [
  { id:"dq_battle3", type:"battle_win", target:3, name:"오늘의 수련", desc:"전투 3회 승리", reward:{ crystals:80, xp:150, materials:{"철 파편":3} } },
  { id:"dq_culling5", type:"culling_wave", target:5, name:"컬링 특훈", desc:"컬링 5웨이브", reward:{ crystals:100, xp:200, materials:{"저주 실":5} } },
  { id:"dq_skill5", type:"skill_use", target:5, name:"술식 연마", desc:"술식 5회 사용", reward:{ crystals:70, xp:130, materials:{"저주 실":3} } },
  { id:"dq_gacha1", type:"gacha_pull", target:1, name:"운명의 소환", desc:"가챠 1회", reward:{ crystals:60, xp:100, materials:{"철 파편":5} } },
];
const WEEKLY_QUESTS = [
  { id:"wq_battle20", type:"battle_win", target:20, name:"주간 전사", desc:"20승", reward:{ crystals:500, xp:1000, materials:{"저주 핵":3} } },
  { id:"wq_boss5", type:"boss_kill", target:5, name:"보스 사냥꾼", desc:"보스 5마리", reward:{ crystals:700, xp:1400, materials:{"용 비늘":1} } },
];

function getTodayKey() { const d=new Date(); return `${d.getUTCFullYear()}-${d.getUTCMonth()+1}-${d.getUTCDate()}`; }

function initQuests(player) {
  const today=getTodayKey();
  if (!player.quests) player.quests={};
  if (player.quests.dailyKey!==today) {
    player.quests.dailyKey=today;
    player.quests.daily=[...DAILY_QUESTS].sort(()=>Math.random()-0.5).slice(0,3).map(q=>({ id:q.id, progress:0, done:false, claimed:false }));
  }
  if (!player.quests.daily) player.quests.daily=[];
}

function updateQuestProgress(player, type, amount=1) {
  initQuests(player);
  for (const qp of player.quests.daily) {
    if (qp.done) continue;
    const def=DAILY_QUESTS.find(q=>q.id===qp.id);
    if (def && def.type===type) {
      qp.progress = Math.min(qp.progress+amount, def.target);
      if (qp.progress >= def.target) qp.done = true;
    }
  }
}

// ════════════════════════════════════════════════════════
// ── 상태이상 시스템
// ════════════════════════════════════════════════════════
const STATUS_EFFECTS = {
  poison: { id:"poison", name:"독", emoji:"☠️", desc:"매 턴 최대HP 5% 피해", duration:3 },
  burn: { id:"burn", name:"화상", emoji:"🔥", desc:"매 턴 최대HP 8% 피해", duration:2 },
  freeze: { id:"freeze", name:"빙결", emoji:"❄️", desc:"1턴 행동 불가", duration:1 },
  stun: { id:"stun", name:"기절", emoji:"⚡", desc:"1턴 행동 불가", duration:1 },
  weaken: { id:"weaken", name:"약화", emoji:"💔", desc:"공격력 30% 감소", duration:2 },
  battleInstinct: { id:"battleInstinct", name:"전투본능", emoji:"🔥💪", desc:"공격력 40% 증가", duration:3 },
  domain_stun: { id:"domain_stun", name:"영역봉쇄", emoji:"🌌", desc:"영역전개로 행동 불가", duration:2 },
};

function applyStatus(target, statusId) {
  if (!target.statusEffects) target.statusEffects = [];
  const existing = target.statusEffects.find(s => s.id === statusId);
  if (existing) existing.turns = STATUS_EFFECTS[statusId].duration;
  else target.statusEffects.push({ id: statusId, turns: STATUS_EFFECTS[statusId].duration });
}

function tickStatus(target, maxHp) {
  if (!target.statusEffects || target.statusEffects.length === 0) return { dmg: 0, log: [] };
  let totalDmg = 0;
  const log = [];
  for (const se of target.statusEffects) {
    const def = STATUS_EFFECTS[se.id];
    if (!def) continue;
    if (se.id === "poison") { const d = Math.max(1, Math.floor(maxHp * 0.05)); totalDmg += d; log.push(`☠️ 독 피해! **${d}**`); }
    if (se.id === "burn") { const d = Math.max(1, Math.floor(maxHp * 0.08)); totalDmg += d; log.push(`🔥 화상 피해! **${d}**`); }
    se.turns--;
  }
  target.statusEffects = target.statusEffects.filter(s => s.turns > 0);
  if (totalDmg > 0) target.hp = Math.max(0, target.hp - totalDmg);
  return { dmg: totalDmg, log };
}

function isIncapacitated(statusEffects) {
  return statusEffects?.some(s => s.id === "freeze" || s.id === "stun" || s.id === "domain_stun") || false;
}

function getWeakenMult(statusEffects) {
  if (statusEffects?.some(s => s.id === "weaken")) return 0.7;
  if (statusEffects?.some(s => s.id === "battleInstinct")) return 1.4;
  return 1;
}

// ════════════════════════════════════════════════════════
// ── 흑섬 (고퀄 애니메이션 - 3가지 랜덤)
// ════════════════════════════════════════════════════════
function isBlackFlash() { return Math.random() < 0.10; }

const BLACK_FLASH_ARTS = [
  "```ansi\n\u001b[1;30m╔══════════════════════════════════════╗\n\u001b[1;31m║  ⚫  B L A C K   F L A S H  ⚫     ║\n\u001b[1;33m║     저주 에너지 순간 최대 방출!!      ║\n\u001b[1;30m╚══════════════════════════════════════╝\n```",
  "```ansi\n\u001b[1;33m╔══════════════════════════════════════╗\n\u001b[1;31m║   《  黒 閃 — BLACK FLASH 》       ║\n\u001b[1;37m║      순간 최대 저주력 폭발!! ×2.5배!!  ║\n\u001b[1;33m╚══════════════════════════════════════╝\n```",
  "```ansi\n\u001b[1;30m╔══════════════════════════════════════════╗\n\u001b[1;31m║  ██████╗ ██╗      █████╗  ██████╗██╗  ██╗    ║\n\u001b[1;33m║  ██╔══██╗██║     ██╔══██╗██╔════╝██║ ██╔╝    ║\n\u001b[1;31m║  ██████╔╝██║     ███████║██║     █████╔╝     ║\n\u001b[1;33m║  ██╔══██╗██║     ██╔══██║██║     ██╔═██╗     ║\n\u001b[1;31m║  ██████╔╝███████╗██║  ██║╚██████╗██║  ██╗    ║\n\u001b[1;33m║  ╚═════╝ ╚══════╝╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝    ║\n\u001b[1;30m╚══════════════════════════════════════════╝\n```",
];

function getBlackFlashArt() {
  return BLACK_FLASH_ARTS[Math.floor(Math.random() * BLACK_FLASH_ARTS.length)];
}

// ════════════════════════════════════════════════════════
// ── 스쿠나 손가락
// ════════════════════════════════════════════════════════
const SUKUNA_FINGER_MAX = 20;
function getFingerBonus(fingers) {
  return {
    atkBonus: Math.floor(fingers * 15),
    defBonus: Math.floor(fingers * 8),
    hpBonus: fingers * 300,
    dmgMult: 1 + fingers * 0.03,
    label: fingers >= 20 ? "🔴 스쿠나 완전 각성" : fingers >= 10 ? "🔴 스쿠나 각성 Lv.3" : fingers >= 5 ? "🟠 스쿠나 각성 Lv.2" : fingers >= 1 ? "🟢 스쿠나 각성 Lv.1" : "스쿠나 봉인 중",
  };
}

// ════════════════════════════════════════════════════════
// ── 코가네 펫
// ════════════════════════════════════════════════════════
const KOGANE_GRADES = {
  "전설": { color:0xF5C842, emoji:"🌟", stars:"★★★★★", rate:0.5, atkBonus:0.25, defBonus:0.20, hpBonus:0.20, xpBonus:0.30, crystalBonus:0.25 },
  "특급": { color:0xff8c00, emoji:"🔶", stars:"★★★★☆", rate:2.0, atkBonus:0.18, defBonus:0.15, hpBonus:0.15, xpBonus:0.20, crystalBonus:0.18 },
  "1급": { color:0x7C5CFC, emoji:"🔷", stars:"★★★☆☆", rate:8.0, atkBonus:0.12, defBonus:0.10, hpBonus:0.10, xpBonus:0.12, crystalBonus:0.10 },
  "2급": { color:0x4ade80, emoji:"🟢", stars:"★★☆☆☆", rate:22.5, atkBonus:0.07, defBonus:0.06, hpBonus:0.06, xpBonus:0.07, crystalBonus:0.06 },
  "3급": { color:0x94a3b8, emoji:"⚪", stars:"★☆☆☆☆", rate:67.0, atkBonus:0.03, defBonus:0.02, hpBonus:0.02, xpBonus:0.03, crystalBonus:0.02 },
};

function rollKogane() {
  const pool = [{grade:"전설",rate:0.5},{grade:"특급",rate:2.0},{grade:"1급",rate:8.0},{grade:"2급",rate:22.5},{grade:"3급",rate:67.0}];
  const total = pool.reduce((s,p)=>s+p.rate,0);
  let roll = Math.random() * total;
  for (const e of pool) { roll -= e.rate; if (roll <= 0) return e.grade; }
  return "3급";
}

function getKoganeBonus(player) {
  if (!player.kogane?.grade) return { atk:1, def:1, hp:1, xp:1, crystal:1 };
  const g = KOGANE_GRADES[player.kogane.grade];
  return { atk:1+g.atkBonus, def:1+g.defBonus, hp:1+g.hpBonus, xp:1+g.xpBonus, crystal:1+g.crystalBonus };
}

// ════════════════════════════════════════════════════════
// ── 스킬 이펙트
// ════════════════════════════════════════════════════════
const SKILL_EFFECTS = {
  "주먹질": { art:"```ansi\n\u001b[1;31m    💥    \n\u001b[1;33m   ▓▓▓   \n\u001b[1;31m    💥    \n```", color:0xff6b35, flavorText:"💪 저주 에너지를 주먹에 집중시킨다!", emoji:"👊" },
  "다이버전트 주먹": { art:"```ansi\n\u001b[1;31m ⚡💥⚡\n\u001b[1;33m▓▓▓▓▓▓▓\n\u001b[1;31m ⚡💥⚡\n```", color:0xff4500, flavorText:"💥 체내에서 저주 에너지가 폭발한다!", emoji:"💥" },
  "어주자": { art:"```ansi\n\u001b[1;31m👹✨👹✨👹\n\u001b[1;33m✨ 廻 夏 ✨\n\u001b[1;31m👹✨👹✨👹\n```", color:0xb5451b, flavorText:"👹 스쿠나의 힘이 몸을 가득 채운다...", emoji:"👹" },
  "스쿠나 발현": { art:"```ansi\n\u001b[1;31m🔴👹🔴👹🔴\n\u001b[1;33m👹 両面宿儺 👹\n\u001b[1;31m🔴👹🔴👹🔴\n```", color:0x8b0000, flavorText:"🔴 저주의 왕이 이타도리의 몸을 장악한다!", emoji:"🔴" },
  "아오": { art:"```ansi\n\u001b[1;34m  🔵🔵🔵  \n\u001b[1;36m🔵  蒼  🔵\n\u001b[1;34m  🔵🔵🔵  \n```", color:0x0066ff, flavorText:"🌀 무한의 인력 — 모든 것을 끌어당긴다", emoji:"🌀" },
  "아카": { art:"```ansi\n\u001b[1;31m  🔴🔴🔴  \n\u001b[1;33m🔴  赫  🔴\n\u001b[1;31m  🔴🔴🔴  \n```", color:0xff0033, flavorText:"💢 무한의 척력 — 모든 것을 날려버린다!", emoji:"💢" },
  "무라사키": { art:"```ansi\n\u001b[1;31m🔴\u001b[1;34m⚡\u001b[1;35m🔵\n\u001b[1;35m⚡  紫  ⚡\n\u001b[1;34m🔵\u001b[1;31m⚡\u001b[1;35m🔴\n```", color:0x9900ff, flavorText:"🟣 아오와 아카의 융합 — 허공을 찢는 허수!", emoji:"🟣" },
  "무량공처": { art:"```ansi\n\u001b[1;36m∞∞∞∞∞∞∞∞∞\n\u001b[1;37m∞ 無量空処 ∞\n\u001b[1;36m∞∞∞∞∞∞∞∞∞\n```", color:0x00ffff, flavorText:"🌌 무한이 세계를 지배한다!", emoji:"🌌" },
  "자폭 무라사키": { art:"```ansi\n\u001b[1;31m💥🔴💥🔵💥\n\u001b[1;31m💥 自爆 紫 💥\n\u001b[1;34m💥🔵💥🔴💥\n```", color:0xff0000, flavorText:"💀 모든 힘을 쏟아붓는 자폭 공격! HP 1", emoji:"💀" },
  "해": { art:"```ansi\n\u001b[1;31m  ✂️✂️✂️  \n\u001b[1;31m✂️  解  ✂️\n\u001b[1;31m  ✂️✂️✂️  \n```", color:0xcc0000, flavorText:"✂️ 만물을 베어내는 저주의 왕의 손톱!", emoji:"✂️" },
  "팔": { art:"```ansi\n\u001b[1;35m🌌✂️🌌✂️🌌\n\u001b[1;31m✂️  捌  ✂️\n\u001b[1;35m🌌✂️🌌✂️🌌\n```", color:0x8b0000, flavorText:"🌌 공간 자체를 베어내는 절대술식!", emoji:"🌌" },
  "푸가": { art:"```ansi\n\u001b[1;31m💀🔥💀🔥💀\n\u001b[1;33m🔥 不 雅 🔥\n\u001b[1;31m💀🔥💀🔥💀\n```", color:0x4a0000, flavorText:"🔥 닿는 모든 것을 분해한다!", emoji:"🔥" },
  "복마어주자": { art:"```ansi\n\u001b[1;31m👑🌑👑🌑👑\n\u001b[1;33m🌑伏魔御廚子🌑\n\u001b[1;31m👑🌑👑🌑👑\n```", color:0x2a0000, flavorText:"👑 천지개벽 — 저주의 왕의 궁극 영역!", emoji:"👑" },
  "세계참": { art:"```ansi\n\u001b[1;35m🌍✂️🌍✂️🌍\n\u001b[1;31m✂️ 世界斬 ✂️\n\u001b[1;35m🌍✂️🌍✂️🌍\n```", color:0x4a0000, flavorText:"🌍 세계조차 베어버린다!", emoji:"🌍" },
  "부기우기": { art:"```ansi\n\u001b[1;34m🎵💪🎵💪🎵\n\u001b[1;32m💪 Boogie 💪\n\u001b[1;34m🎵💪🎵💪🎵\n```", color:0x1e90ff, flavorText:"🎵 위치 전환! 빙결!", emoji:"🎵" },
  "전투본능": { art:"```ansi\n\u001b[1;31m⚔️🔥⚔️🔥⚔️\n\u001b[1;33m🔥戦闘本能🔥\n\u001b[1;31m⚔️🔥⚔️🔥⚔️\n```", color:0xff8c00, flavorText:"⚔️ 전사의 본능이 각성한다!", emoji:"⚔️" },
  "험한 도박": { art:"```ansi\n\u001b[1;33m🎰🎰🎰🎰🎰\n\u001b[1;31m  険 賭 博  \n\u001b[1;33m🎰🎰🎰🎰🎰\n```", color:0xffaa00, flavorText:"🎲 운에 맡긴 도박 공격!", emoji:"🎲" },
  "질풍열차": { art:"```ansi\n\u001b[1;34m🚂💨🚂💨🚂\n\u001b[1;36m  疾 風 列  \n\u001b[1;34m🚂💨🚂💨🚂\n```", color:0x44aaff, flavorText:"🚂 강력한 열차처럼 돌진!", emoji:"🚂" },
  "유한 소설": { art:"```ansi\n\u001b[1;32m📖✨📖✨📖\n\u001b[1;33m✨ 有限小説 ✨\n\u001b[1;32m📖✨📖✨📖\n```", color:0x88ff88, flavorText:"📖 불멸의 몸으로 싸운다!", emoji:"📖" },
  "질풍강운": { art:"```ansi\n\u001b[1;33m🎰🌪️🎰🌪️🎰\n\u001b[1;31m🌪️ 質風強運 🌪️\n\u001b[1;33m🎰🌪️🎰🌪️🎰\n```", color:0xffcc00, flavorText:"🎰 영역전개 — 운이 터진다!", emoji:"🎰" },
  "_default": { art:"```ansi\n\u001b[1;35m  ✨✨✨  \n\u001b[1;35m✨ 術 式 ✨\n\u001b[1;35m  ✨✨✨  \n```", color:0x7c5cfc, flavorText:"🌀 저주 에너지가 폭발!", emoji:"🌀" },
};
function getSkillEffect(n) { return SKILL_EFFECTS[n] || SKILL_EFFECTS["_default"]; }

// ════════════════════════════════════════════════════════
// ── 영역전개 효과 (각자 특색적인 능력)
// ════════════════════════════════════════════════════════
const DOMAIN_EFFECTS = {
  "무량공처": { 
    dmgMult: 3.5, status: "domain_stun", duration: 2, self: false,
    effect: (attacker, defender, atkStats) => {
      const dmg = Math.floor(atkStats.atk * 3.5);
      applyStatus(defender, "domain_stun");
      defender.statusEffects.find(s=>s.id==="domain_stun").turns = 2;
      return { dmg, log:[`> 🌌 **무량공처** 발동! **${dmg}** 피해 + **2턴 행동봉쇄**!`] };
    }
  },
  "복마어주자": { 
    dmgMult: 4.0, status: "burn", duration: 3, self: false,
    effect: (attacker, defender, atkStats) => {
      const dmg = Math.floor(atkStats.atk * 4.0);
      applyStatus(defender, "burn");
      defender.statusEffects.find(s=>s.id==="burn").turns = 3;
      return { dmg, log:[`> 👹 **복마어주자** 발동! **${dmg}** 피해 + **3턴 화상**!`] };
    }
  },
  "질풍강운": { 
    dmgMult: 3.0, status: "battleInstinct", duration: 2, self: true,
    effect: (attacker, defender, atkStats) => {
      const mult = 2 + Math.random() * 4;
      const dmg = Math.floor(atkStats.atk * mult);
      applyStatus(attacker, "battleInstinct");
      attacker.statusEffects.find(s=>s.id==="battleInstinct").turns = 2;
      return { dmg, log:[`> 🎰 **질풍강운** 발동! 배율 **×${mult.toFixed(1)}** — **${dmg}** 피해 + 자신 **2턴 전투본능**!`] };
    }
  },
  "진안상애": { 
    dmgMult: 3.2, status: "weaken", duration: 2, self: true,
    effect: (attacker, defender, atkStats, atkMaxHp) => {
      const dmg = Math.floor(atkStats.atk * 3.2);
      const heal = Math.floor(atkMaxHp * 0.3);
      applyStatus(defender, "weaken");
      defender.statusEffects.find(s=>s.id==="weaken").turns = 2;
      return { dmg, heal, log:[`> 💗 **진안상애** 발동! **${dmg}** 피해 + 💔**2턴 약화** + 자신 **+${heal} HP** 회복!`] };
    }
  },
  "개관철위산": { 
    dmgMult: 3.6, status: "burn", duration: 3, self: false,
    effect: (attacker, defender, atkStats) => {
      const dmg = Math.floor(atkStats.atk * 3.6);
      applyStatus(defender, "burn");
      defender.statusEffects.find(s=>s.id==="burn").turns = 3;
      return { dmg, log:[`> 🌋 **개관철위산** 발동! **${dmg}** 피해 + **3턴 화상**!`] };
    }
  },
  "탕온평선": { 
    dmgMult: 3.0, status: "poison", duration: 3, self: false,
    effect: (attacker, defender, atkStats) => {
      const dmg = Math.floor(atkStats.atk * 3.0);
      applyStatus(defender, "poison");
      defender.statusEffects.find(s=>s.id==="poison").turns = 3;
      applyStatus(defender, "freeze");
      return { dmg, log:[`> 🌊 **탕온평선** 발동! **${dmg}** 피해 + ☠️**3턴 독** + ❄️**빙결**!`] };
    }
  },
  "자폐원돈과": { 
    dmgMult: 3.8, status: "cursed_wound", duration: 2, self: true,
    effect: (attacker, defender, atkStats, atkMaxHp) => {
      const dmg = Math.floor(atkStats.atk * 3.8);
      const selfDmg = Math.floor(atkMaxHp * 0.15);
      applyStatus(defender, "cursed_wound");
      defender.statusEffects.find(s=>s.id==="cursed_wound").turns = 2;
      return { dmg, selfDmg, log:[`> 🩸 **자폐원돈과** 발동! **${dmg}** 피해 + 🩸**2턴 저주상처**! (자신 **${selfDmg}** 반동)`] };
    }
  },
  "강압암예정": { 
    dmgMult: 2.8, status: "stun", duration: 2, self: true,
    effect: (attacker, defender, atkStats) => {
      const dmg = Math.floor(atkStats.atk * 2.8);
      applyStatus(defender, "stun");
      defender.statusEffects.find(s=>s.id==="stun").turns = 2;
      applyStatus(attacker, "battleInstinct");
      return { dmg, log:[`> ⚫ **강압암예정** 발동! **${dmg}** 피해 + ⚡**2턴 기절** + 자신 🔥💪**전투본능**!`] };
    }
  },
  "주복사사": { 
    dmgMult: 3.0, status: "weaken", duration: 3, self: false,
    effect: (attacker, defender, atkStats) => {
      const dmg = Math.floor(atkStats.atk * 3.0);
      applyStatus(defender, "weaken");
      defender.statusEffects.find(s=>s.id==="weaken").turns = 3;
      applyStatus(defender, "stun");
      return { dmg, log:[`> ⚖️ **주복사사** 발동! **${dmg}** 피해 + 💔**3턴 약화** + ⚡**기절**!`] };
    }
  },
};

function getDomainEffect(domainName) {
  return DOMAIN_EFFECTS[domainName] || { 
    effect: (attacker, defender, atkStats) => {
      const dmg = Math.floor(atkStats.atk * 3.0);
      return { dmg, log:[`> 🌌 **${domainName}** 발동! **${dmg}** 피해!`] };
    }
  };
}

// ════════════════════════════════════════════════════════
// ── 캐릭터 데이터
// ════════════════════════════════════════════════════════
const CHARACTERS = {
  itadori: { name:"이타도리 유지", emoji:"🟠", grade:"준1급", atk:90, def:75, maxHp:1000, domain:null, desc:"스쿠나의 그릇", fingerSkills:true,
    skills: [
      { name:"주먹질", minMastery:0, dmg:95, desc:"강력한 기본 주먹", statusApply:null },
      { name:"다이버전트 주먹", minMastery:5, dmg:160, desc:"저주 에너지를 실은 주먹", statusApply:{ target:"enemy",statusId:"stun",chance:0.3 } },
      { name:"흑섬", minMastery:15, dmg:240, desc:"최대 저주 에너지 방출!", statusApply:{ target:"enemy",statusId:"weaken",chance:0.5 } },
      { name:"어주자", minMastery:30, dmg:340, desc:"스쿠나의 힘을 빌린 궁극기", statusApply:{ target:"enemy",statusId:"burn",chance:0.7 } },
      { name:"스쿠나 발현", minMastery:50, dmg:520, desc:"스쿠나가 몸을 장악! 손가락 10개 필요", statusApply:{ target:"enemy",statusId:"freeze",chance:0.8 } },
    ] },
  gojo: { name:"고조 사토루", emoji:"🔵", grade:"특급", atk:130, def:120, maxHp:1800, domain:"무량공처", desc:"최강의 주술사",
    skills: [
      { name:"아오", minMastery:0, dmg:145, desc:"적을 끌어당겨 공격", statusApply:null },
      { name:"아카", minMastery:5, dmg:220, desc:"적을 날려 폭발", statusApply:{ target:"enemy",statusId:"burn",chance:0.5 } },
      { name:"무라사키", minMastery:15, dmg:320, desc:"아오+아카 융합", statusApply:{ target:"enemy",statusId:"weaken",chance:0.6 } },
      { name:"무량공처", minMastery:30, dmg:480, desc:"무한을 지배하는 궁극술식", statusApply:{ target:"enemy",statusId:"freeze",chance:0.8 } },
    ] },
  sukuna: { name:"료멘 스쿠나", emoji:"🔴", grade:"특급", atk:150, def:125, maxHp:2800, domain:"복마어주자", desc:"저주의 왕",
    skills: [
      { name:"해", minMastery:0, dmg:155, desc:"손톱으로 베어낸다", statusApply:{ target:"enemy",statusId:"burn",chance:0.4 } },
      { name:"팔", minMastery:5, dmg:245, desc:"공간 자체를 베어낸다", statusApply:{ target:"enemy",statusId:"weaken",chance:0.5 } },
      { name:"푸가", minMastery:15, dmg:360, desc:"닿는 모든 것을 분해", statusApply:{ target:"enemy",statusId:"poison",chance:0.7 } },
      { name:"복마어주자", minMastery:30, dmg:520, desc:"궁극 영역전개", statusApply:{ target:"enemy",statusId:"freeze",chance:0.9 } },
    ] },
  hakari: { name:"하카리 키리토", emoji:"🎰", grade:"1급", atk:125, def:105, maxHp:1650, domain:"질풍강운", desc:"복권 술식 사용자",
    skills: [
      { name:"험한 도박", minMastery:0, dmg:125, desc:"운에 맡긴 도박 공격", statusApply:{ target:"enemy",statusId:"stun",chance:0.3 } },
      { name:"질풍열차", minMastery:5, dmg:210, desc:"열차처럼 돌진", statusApply:{ target:"enemy",statusId:"weaken",chance:0.4 } },
      { name:"유한 소설", minMastery:15, dmg:315, desc:"불멸의 몸으로 싸운다", statusApply:{ target:"self",statusId:"battleInstinct",chance:0.6 } },
      { name:"질풍강운", minMastery:30, dmg:480, desc:"영역전개 — 운이 터진다", statusApply:{ target:"enemy",statusId:"freeze",chance:0.7 } },
    ] },
  yuta: { name:"오코츠 유타", emoji:"🌟", grade:"특급", atk:128, def:112, maxHp:1750, domain:"진안상애", desc:"리카의 저주를 다루는 주술사",
    skills: [
      { name:"모방술식", minMastery:0, dmg:135, desc:"다른 술식을 모방", statusApply:null },
      { name:"리카 소환", minMastery:5, dmg:220, desc:"저주의 여왕 리카 소환", statusApply:{ target:"enemy",statusId:"weaken",chance:0.5 } },
      { name:"순애빔", minMastery:15, dmg:340, desc:"리카와의 순수한 사랑", statusApply:{ target:"enemy",statusId:"burn",chance:0.6 } },
      { name:"진안상애", minMastery:30, dmg:480, desc:"영역전개 — 사랑으로 파괴", statusApply:{ target:"enemy",statusId:"freeze",chance:0.9 } },
    ] },
  jogo: { name:"죠고", emoji:"🌋", grade:"준특급", atk:125, def:100, maxHp:1680, domain:"개관철위산", desc:"화염 저주령",
    skills: [
      { name:"화염 분사", minMastery:0, dmg:130, desc:"강렬한 불꽃 분출", statusApply:{ target:"enemy",statusId:"burn",chance:0.5 } },
      { name:"용암 폭발", minMastery:5, dmg:215, desc:"발밑 용암 폭발", statusApply:{ target:"enemy",statusId:"burn",chance:0.7 } },
      { name:"극번 운", minMastery:15, dmg:315, desc:"불타는 운석 소환", statusApply:{ target:"enemy",statusId:"weaken",chance:0.5 } },
      { name:"개관철위산", minMastery:30, dmg:460, desc:"화산 소환 궁극 영역전개", statusApply:{ target:"enemy",statusId:"burn",chance:1.0 } },
    ] },
  dagon: { name:"다곤", emoji:"🌊", grade:"준특급", atk:118, def:108, maxHp:1620, domain:"탕온평선", desc:"수중 저주령",
    skills: [
      { name:"물고기 소환", minMastery:0, dmg:125, desc:"날카로운 물고기 떼 소환", statusApply:{ target:"enemy",statusId:"poison",chance:0.4 } },
      { name:"해수 폭발", minMastery:5, dmg:205, desc:"압축 해수 발사", statusApply:{ target:"enemy",statusId:"weaken",chance:0.5 } },
      { name:"조류 소용돌이", minMastery:15, dmg:295, desc:"거대 물 소용돌이 공격", statusApply:{ target:"enemy",statusId:"freeze",chance:0.4 } },
      { name:"탕온평선", minMastery:30, dmg:450, desc:"물고기로 가득한 영역전개", statusApply:{ target:"enemy",statusId:"poison",chance:0.9 } },
    ] },
  mahito: { name:"마히토", emoji:"🩸", grade:"준특급", atk:120, def:98, maxHp:1560, domain:"자폐원돈과", desc:"영혼 변형 저주령",
    skills: [
      { name:"영혼 변형", minMastery:0, dmg:128, desc:"영혼 변형 직접 타격", statusApply:{ target:"enemy",statusId:"weaken",chance:0.4 } },
      { name:"무위전변", minMastery:5, dmg:212, desc:"접촉 신체 기괴하게 변형", statusApply:{ target:"enemy",statusId:"stun",chance:0.4 } },
      { name:"편사지경체", minMastery:15, dmg:308, desc:"무한 신체 변형 공격", statusApply:{ target:"enemy",statusId:"weaken",chance:0.6 } },
      { name:"자폐원돈과", minMastery:30, dmg:455, desc:"영혼과 육체의 경계 붕괴", statusApply:{ target:"enemy",statusId:"freeze",chance:0.8 } },
    ] },
  megumi: { name:"후시구로 메구미", emoji:"⚫", grade:"1급", atk:110, def:108, maxHp:1250, domain:"강압암예정", desc:"식신술사",
    skills: [
      { name:"옥견", minMastery:0, dmg:115, desc:"식신 옥견 소환", statusApply:null },
      { name:"탈토", minMastery:5, dmg:180, desc:"식신 대호 소환", statusApply:{ target:"enemy",statusId:"weaken",chance:0.4 } },
      { name:"만상", minMastery:15, dmg:265, desc:"열 가지 식신 소환", statusApply:{ target:"enemy",statusId:"poison",chance:0.5 } },
      { name:"강압암예정", minMastery:30, dmg:380, desc:"영역전개", statusApply:{ target:"enemy",statusId:"stun",chance:0.6 } },
    ] },
  higuruma: { name:"히구루마 히로미", emoji:"⚖️", grade:"1급", atk:118, def:105, maxHp:1320, domain:"주복사사", desc:"전직 변호사",
    skills: [
      { name:"저주도구", minMastery:0, dmg:120, desc:"저주 에너지 도구 공격", statusApply:null },
      { name:"몰수", minMastery:5, dmg:195, desc:"상대 술식 몰수", statusApply:{ target:"enemy",statusId:"weaken",chance:0.7 } },
      { name:"사형판결", minMastery:15, dmg:285, desc:"재판 결과에 따른 제재", statusApply:{ target:"enemy",statusId:"stun",chance:0.5 } },
      { name:"주복사사", minMastery:30, dmg:410, desc:"영역전개 — 법정", statusApply:{ target:"enemy",statusId:"freeze",chance:0.7 } },
    ] },
  todo: { name:"토도 아오이", emoji:"💪", grade:"1급", atk:128, def:108, maxHp:1500, domain:null, desc:"보조 공격술사",
    skills: [
      { name:"부기우기", minMastery:0, dmg:130, desc:"위치 전환", statusApply:{ target:"enemy",statusId:"freeze",chance:0.4 } },
      { name:"브루탈 펀치", minMastery:5, dmg:215, desc:"파괴적 주먹", statusApply:{ target:"enemy",statusId:"weaken",chance:0.3 } },
      { name:"흑섬", minMastery:15, dmg:320, desc:"이타도리에게 배운 흑섬!", statusApply:{ target:"enemy",statusId:"burn",chance:0.45 } },
      { name:"전투본능", minMastery:30, dmg:200, desc:"전투본능 버프", statusApply:{ target:"self",statusId:"battleInstinct",chance:1.0 } },
    ] },
};

// ════════════════════════════════════════════════════════
// ── 반전술식 가능 캐릭터 (고조, 유타, 스쿠나, 하카리)
// ════════════════════════════════════════════════════════
const REVERSE_CHARS = new Set(["gojo", "yuta", "sukuna", "hakari"]);

// ════════════════════════════════════════════════════════
// ── 적 데이터
// ════════════════════════════════════════════════════════
const ENEMIES = [
  { id:"e1", name:"저급 저주령", emoji:"👹", hp:550, atk:38, def:12, xp:75, crystals:18, masteryXp:1, fingers:0, statusAttack:null },
  { id:"e2", name:"1급 저주령", emoji:"👺", hp:1100, atk:80, def:40, xp:190, crystals:40, masteryXp:3, fingers:0, statusAttack:{ statusId:"poison", chance:0.3 } },
  { id:"e3", name:"특급 저주령", emoji:"💀", hp:2400, atk:128, def:72, xp:440, crystals:90, masteryXp:7, fingers:1, statusAttack:{ statusId:"burn", chance:0.4 } },
  { id:"e4", name:"저주의 왕 (보스)", emoji:"👑", hp:5500, atk:195, def:110, xp:1000, crystals:200, masteryXp:15, fingers:3, statusAttack:{ statusId:"weaken", chance:0.5 } },
  { id:"e_sukuna", name:"료멘 스쿠나", emoji:"🔴", hp:5500, atk:220, def:130, xp:1500, crystals:300, masteryXp:20, fingers:1, statusAttack:{ statusId:"burn", chance:0.6 }, isSukuna:true },
];

// ════════════════════════════════════════════════════════
// ── 레이드 보스 (버프됨)
// ════════════════════════════════════════════════════════
const RAID_BOSSES = {
  heian_sukuna: {
    id: "heian_sukuna", name: "平安時代 스쿠나 〖헤이안 최강〗", emoji: "👹🔴",
    hp: 15000, atk: 550, def: 300, xp: 4000, crystals: 800, masteryXp: 50, fingers: 4,
    desc: "헤이안 시대의 스쿠나. 현대 스쿠나의 2배 강함.",
    lore: "\"나는 그 어느 시대에도 최강이었다.\"",
    color: 0x8b0000, statusAttack: { statusId:"burn", chance:0.8 },
    specialAttack: { name:"복마어주자", dmg:750, statusId:"freeze", chance:0.9 },
    dropKey: "raid_heian", phaseHp: 0.5, enragedAtk: 800,
  },
  mahoraga: {
    id: "mahoraga", name: "八握剣 異戒神将 마허라가라", emoji: "⚙️🐉",
    hp: 9000, atk: 380, def: 250, xp: 3500, crystals: 700, masteryXp: 45, fingers: 3,
    desc: "식신 중 최강. 모든 술식에 적응하는 능력.",
    lore: "\"마허라가라는 천지의 이치를 먹는다.\"",
    color: 0x2a2a2a, statusAttack: { statusId:"weaken", chance:0.7 },
    specialAttack: { name:"팔상천마", dmg:550, statusId:"stun", chance:0.8 },
    dropKey: "raid_mahoraga", adaptationSkill: true, phaseHp: 0.4, enragedAtk: 520,
  },
};

// ════════════════════════════════════════════════════════
// ── 가챠 풀
// ════════════════════════════════════════════════════════
const GACHA_POOL = [
  { id:"gojo", rate:0.3 }, { id:"yuta", rate:0.45 }, { id:"sukuna", rate:0.15 },
  { id:"itadori", rate:2.5 }, { id:"hakari", rate:5.0 }, { id:"jogo", rate:0.6 },
  { id:"mahito", rate:0.6 }, { id:"dagon", rate:0.7 }, { id:"megumi", rate:6.0 },
  { id:"higuruma", rate:6.5 }, { id:"todo", rate:5.0 }, { id:"nanami", rate:6.0 },
];
function rollGacha(count=1) {
  const total = GACHA_POOL.reduce((s,p)=>s+p.rate,0);
  return Array.from({ length:count }, () => {
    let roll = Math.random() * total;
    for (const e of GACHA_POOL) { roll -= e.rate; if (roll <= 0) return e.id; }
    return GACHA_POOL[0].id;
  });
}

const CODES = { "release":{ crystals:200 }, "sorryforbugs":{ crystals:1000 } };

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
const raidSessions = {};
let _partyIdSeq = 1, _pvpIdSeq = 1, _raidIdSeq = 1;

// ════════════════════════════════════════════════════════
// ── 플레이어 유틸
// ════════════════════════════════════════════════════════
function getPlayer(userId, username = "플레이어") {
  if (!players[userId]) {
    players[userId] = {
      id: userId, name: username, crystals: 500, xp: 0,
      owned: ["itadori"], active: "itadori",
      hp: CHARACTERS["itadori"].maxHp, potion: 3,
      wins: 0, losses: 0, mastery: { itadori: 0 },
      reverseCooldown: 0, domainCooldown: 0, skillCooldown: 0,
      statusEffects: [], selectedSkillIndex: 0,
      sukunaFingers: 0, kogane: null, koganeGachaCount: 0,
      materials: {}, equippedWeapon: null, craftedWeapons: [],
      quests: {}, raidClears: {},
      lastDaily: 0, dailyStreak: 0,
      usedCodes: [], cullingBest: 0, jujutsuBest: 0,
      pvpWins: 0, pvpLosses: 0, mainSkillUnlocked: {},
    };
    savePlayer(userId);
  }
  return players[userId];
}

function getMastery(player, charId) { return player.mastery?.[charId] || 0; }

function getAvailableSkills(player, charId) {
  const m = getMastery(player, charId);
  const ch = CHARACTERS[charId];
  if (!ch) return [];
  return ch.skills.filter(s => {
    if (s.minMastery > m) return false;
    if (s.name === "스쿠나 발현" && (player.sukunaFingers || 0) < 10) return false;
    return true;
  });
}

function getCurrentSkill(player, charId) {
  const available = getAvailableSkills(player, charId);
  if (available.length === 0) return CHARACTERS[charId]?.skills[0];
  const idx = player.selectedSkillIndex ?? (available.length - 1);
  return available[Math.min(idx, available.length - 1)];
}

function getPlayerStats(player) {
  const ch = CHARACTERS[player.active];
  const kb = getKoganeBonus(player);
  const ws = getWeaponStats(player);
  if (!ch) return { atk: 10, def: 10, maxHp: 100 };
  if (player.active !== "itadori" && player.active !== "sukuna") {
    return {
      atk: Math.floor(ch.atk * kb.atk) + ws.atk,
      def: Math.floor(ch.def * kb.def) + ws.def,
      maxHp: Math.floor(ch.maxHp * kb.hp) + ws.hp,
    };
  }
  const bonus = getFingerBonus(player.sukunaFingers || 0);
  return {
    atk: Math.floor((ch.atk + bonus.atkBonus) * kb.atk) + ws.atk,
    def: Math.floor((ch.def + bonus.defBonus) * kb.def) + ws.def,
    maxHp: Math.floor((ch.maxHp + bonus.hpBonus) * kb.hp) + ws.hp,
  };
}

function getLevel(xp) { return Math.floor(xp / 200) + 1; }

function hpBar(cur, max, len = 10) {
  const pct = Math.max(0, Math.min(1, cur / max));
  const fill = Math.round(pct * len);
  const color = pct > 0.5 ? "🟩" : pct > 0.25 ? "🟨" : "🟥";
  return color.repeat(fill) + "⬛".repeat(len - fill);
}

function statusStr(statusEffects) {
  if (!statusEffects || statusEffects.length === 0) return "없음";
  return statusEffects.map(s => `${STATUS_EFFECTS[s.id]?.emoji || ""}${STATUS_EFFECTS[s.id]?.name || s.id}(${s.turns}턴)`).join(" ");
}

function calcDmg(atk, def, mult = 1) {
  const variance = 0.70 + Math.random() * 0.60;
  return Math.max(1, Math.floor((atk * variance - def * 0.22) * mult));
}

function calcDmgForPlayer(player, enemyDef, baseMult = 1) {
  const stats = getPlayerStats(player);
  let mult = baseMult * getWeakenMult(player.statusEffects);
  if (player.active === "itadori" || player.active === "sukuna") {
    const bonus = getFingerBonus(player.sukunaFingers || 0);
    mult *= bonus.dmgMult;
  }
  return calcDmg(stats.atk, enemyDef, mult);
}

function calcSkillDmgForPlayer(player, baseSkillDmg) {
  let dmg = baseSkillDmg + Math.floor(Math.random() * 60);
  dmg = Math.floor(dmg * getWeakenMult(player.statusEffects));
  if (player.active === "itadori" || player.active === "sukuna") {
    const bonus = getFingerBonus(player.sukunaFingers || 0);
    dmg = Math.floor(dmg * bonus.dmgMult);
  }
  const kb = getKoganeBonus(player);
  dmg = Math.floor(dmg * kb.atk);
  const ws = getWeaponStats(player);
  dmg += Math.floor(ws.atk * 0.5);
  return dmg;
}

function applySkillStatus(skill, defenderObj, attackerObj = null) {
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
  if (player.domainCooldown > 0) player.domainCooldown--;
}

function rollHit(attackerSe, defenderSe) {
  const baseEvade = 0.05;
  return Math.random() > baseEvade;
}

// ════════════════════════════════════════════════════════
// ── 전투 관련 함수들
// ════════════════════════════════════════════════════════
function pickCullingEnemy(wave) {
  let pool;
  if (wave <= 3) pool = ["e1", "e1", "e1", "e2"];
  else if (wave <= 7) pool = ["e1", "e2", "e2", "e2", "e3"];
  else if (wave <= 14) pool = ["e2", "e2", "e3", "e3", "e3"];
  else pool = ["e2", "e3", "e3", "e4", "e4"];
  const id = pool[Math.floor(Math.random() * pool.length)];
  const base = ENEMIES.find(e => e.id === id);
  const scale = 1 + (wave - 1) * 0.05;
  return {
    ...base,
    hp: Math.floor(base.hp * scale),
    atk: Math.floor(base.atk * scale),
    def: Math.floor(base.def * scale),
    xp: Math.floor(base.xp * scale),
    crystals: Math.floor(base.crystals * scale),
    currentHp: Math.floor(base.hp * scale),
    statusEffects: []
  };
}

async function processBattleWin(player, enemy) {
  const kb = getKoganeBonus(player);
  const xpGain = Math.floor((enemy.xp || 1) * kb.xp);
  const crystalGain = Math.floor((enemy.crystals || 0) * kb.crystal);
  player.xp += xpGain;
  player.crystals += crystalGain;
  player.mastery[player.active] = (player.mastery[player.active] || 0) + (enemy.masteryXp || 1);
  player.wins++;
  
  const potionChance = enemy.isSukuna ? 1.0 : enemy.id === "e4" ? 0.8 : enemy.id === "e3" ? 0.6 : 0.35;
  if (Math.random() < potionChance) {
    const gain = enemy.isSukuna ? 3 : (enemy.id === "e4" ? 2 : 1);
    player.potion = (player.potion || 0) + gain;
  }
  
  if (enemy.isSukuna) {
    const gained = enemy.fingers || 1;
    const before = player.sukunaFingers || 0;
    player.sukunaFingers = Math.min(SUKUNA_FINGER_MAX, before + gained);
    if (before === 0 && player.sukunaFingers >= 1 && !player.owned.includes("sukuna")) {
      player.owned.push("sukuna");
      if (!player.mastery["sukuna"]) player.mastery["sukuna"] = 0;
    }
  } else if (enemy.fingers) {
    player.sukunaFingers = Math.min(SUKUNA_FINGER_MAX, (player.sukunaFingers || 0) + enemy.fingers);
    if (player.sukunaFingers >= 1 && !player.owned.includes("sukuna")) {
      player.owned.push("sukuna");
      if (!player.mastery["sukuna"]) player.mastery["sukuna"] = 0;
    }
  }
  
  const drops = rollDrops(enemy.isSukuna ? "e_sukuna" : (enemy.id || "e1"));
  addMaterials(player, drops);
  updateQuestProgress(player, "battle_win", 1);
  
  return new EmbedBuilder()
    .setTitle(enemy.isSukuna ? "👹 스쿠나 격파!!" : "🏆 전투 승리!")
    .setColor(enemy.isSukuna ? 0x8b0000 : 0xF5C842)
    .setDescription(`> **${enemy.name}** 처치!\n> ⭐ XP **+${xpGain}** | 💎 **+${crystalGain}**`);
}

// ════════════════════════════════════════════════════════
// ── 프로필 임베드
// ════════════════════════════════════════════════════════
function profileEmbed(player) {
  const ch = CHARACTERS[player.active];
  const stats = getPlayerStats(player);
  const mastery = getMastery(player, player.active);
  const lv = getLevel(player.xp);
  const gradeInfo = GACHA_RARITY[ch.grade] || GACHA_RARITY["3급"];
  const currentSkill = getCurrentSkill(player, player.active);
  const kogane = player.kogane;
  const kg = kogane ? KOGANE_GRADES[kogane.grade] : null;
  const weapon = player.equippedWeapon ? getWeaponByName(player.equippedWeapon) : null;
  const fingers = player.sukunaFingers || 0;
  
  return new EmbedBuilder()
    .setColor(gradeInfo.color)
    .setTitle(`${gradeInfo.effect} ${player.name}의 주술사 카드`)
    .addFields(
      { name: "🏅 주술사 정보", value: `> ${ch.emoji} **${ch.name}** \`[${ch.grade}]\`\n> 🎖️ LV.${lv} · 📖 숙련도 ${mastery}\n> 💎 ${player.crystals}💎 · 🧪 회복약 ${player.potion}개\n> 👹 손가락: ${fingers}/${SUKUNA_FINGER_MAX}`, inline: false },
      { name: "💚 전투 스탯", value: `> ${hpBar(player.hp, stats.maxHp)} \`${player.hp}/${stats.maxHp}\`\n> 🗡️ ATK ${stats.atk} · 🛡️ DEF ${stats.def}\n> ⚡ 술식 CD: ${player.skillCooldown}턴 · ♻️ 반전 CD: ${player.reverseCooldown}턴 · 🌌 영역 CD: ${player.domainCooldown}턴`, inline: false },
      { name: "🌀 술식", value: `> **현재 스킬:** ${currentSkill.name} (피해: ${currentSkill.dmg})\n> 🌌 영역전개: ${ch.domain || "없음"}`, inline: false },
      { name: "🎴 보유 캐릭터", value: player.owned.map(id => `${id === player.active ? "▶️" : "　"} ${CHARACTERS[id]?.emoji} ${CHARACTERS[id]?.name}`).join("\n") || "없음", inline: false }
    );
}

// ════════════════════════════════════════════════════════
// ── 가챠 컷씬
// ════════════════════════════════════════════════════════
function gachaLoadingEmbed(stage) {
  const frames = {
    1: { title: "🔮 주술 소환 의식", color: 0x0a0a1e, desc: "```ansi\n\u001b[2;30m저주 에너지가 수렴하기 시작한다...\n```" },
    2: { title: "⚡ 저주 에너지 임계점", color: 0x1a0533, desc: "```ansi\n\u001b[1;35m저주력이 임계점에 도달했다!\n```" },
    3: { title: "🌟 소환 개시!", color: 0x2a0a5a, desc: "```ansi\n\u001b[1;36m🌟🌟🌟 S U M M O N 🌟🌟🌟\n```" },
  };
  const f = frames[stage];
  return new EmbedBuilder().setTitle(f.title).setColor(f.color).setDescription(f.desc);
}

function gachaRevealEmbed(grade) {
  const info = GACHA_RARITY[grade] || GACHA_RARITY["3급"];
  return new EmbedBuilder().setTitle(`${info.effect} ${grade} 등급!`).setColor(info.color).setDescription(`\`\`\`ansi\n\u001b[1;33m✨✨✨ ${grade} 주술사 소환! ✨✨✨\n\`\`\``);
}

function gachaResultEmbed(charId, isNew, player) {
  const ch = CHARACTERS[charId];
  const info = GACHA_RARITY[ch.grade] || GACHA_RARITY["3급"];
  return new EmbedBuilder()
    .setTitle(isNew ? `✨ NEW! ${ch.name} 획득!` : `🔄 중복 — ${ch.name} (+50💎)`)
    .setColor(isNew ? info.color : 0x4a5568)
    .setDescription(`> *"${ch.desc}"*`)
    .setFooter({ text: `💎 잔여: ${player.crystals}` });
}

function gacha10ResultEmbed(results, newOnes, dupCrystals, player) {
  const lines = results.map(id => {
    const ch = CHARACTERS[id];
    const info = GACHA_RARITY[ch.grade] || GACHA_RARITY["3급"];
    const isN = newOnes.includes(id);
    return `${ch.emoji} ${info.stars} **${ch.name}**${isN ? " ✨NEW!" : ""}`;
  });
  return new EmbedBuilder()
    .setTitle("🎲 10회 주술 소환 결과")
    .setColor(0x7c5cfc)
    .setDescription(lines.join("\n"))
    .addFields(
      { name: "✨ 신규", value: newOnes.length ? newOnes.map(id => CHARACTERS[id].name).join(", ") : "없음", inline: true },
      { name: "🔄 중복 보상", value: `+${dupCrystals}💎`, inline: true }
    );
}

// ════════════════════════════════════════════════════════
// ── 코가네 가챠 컷씬
// ════════════════════════════════════════════════════════
function koganeLoadingEmbed(stage) {
  const frames = {
    1: { title: "🐾 코가네 소환 의식", color: 0x2a1500, desc: "```ansi\n\u001b[2;33m황금빛 기운이 감지된다...\n```" },
    2: { title: "✨ 황금빛 폭발!", color: 0xF5A800, desc: "```ansi\n\u001b[1;33m황금빛이 폭발한다!!\n```" },
    3: { title: "🌟 코가네 소환 완료!", color: 0xFFD700, desc: "```ansi\n\u001b[1;33m🌟🌟🌟 코가네 출현! 🌟🌟🌟\n```" },
  };
  return new EmbedBuilder().setTitle(frames[stage].title).setColor(frames[stage].color).setDescription(frames[stage].desc);
}

function koganeRevealEmbed(grade, isUpgrade, player) {
  const kg = KOGANE_GRADES[grade];
  const prevGrade = player.kogane?.grade;
  return new EmbedBuilder()
    .setColor(kg.color)
    .setTitle(isUpgrade ? `${kg.emoji} 코가네 등급 상승! [${prevGrade} → ${grade}]` : `${kg.emoji} 코가네 소환! [${grade}]`)
    .setDescription([
      `> 🌟 **${grade} 등급** ${kg.stars}`,
      `> 📊 ATK +${Math.round(kg.atkBonus * 100)}% · DEF +${Math.round(kg.defBonus * 100)}% · HP +${Math.round(kg.hpBonus * 100)}%`,
      `> ⭐ XP +${Math.round(kg.xpBonus * 100)}% · 💎 크리스탈 +${Math.round(kg.crystalBonus * 100)}%`,
      !isUpgrade ? `> 🔄 중복 소환 — **+50**💎 환급` : "",
      `> 💎 잔여: **${player.crystals}**💎`,
    ].filter(Boolean).join("\n"));
}

function kogane10ResultEmbed(results, best, refund, player) {
  const lines = results.map(g => `${KOGANE_GRADES[g].emoji} **${g}**`).join(" · ");
  return new EmbedBuilder()
    .setTitle("🐾 코가네 10회 연속 소환 결과")
    .setColor(0xFFD700)
    .setDescription([
      "```ansi\n\u001b[1;33m╔══════════════════════════════════════╗\n║  🐾  10연차 코가네 소환 결과!  🐾    ║\n╚══════════════════════════════════════╝\n```",
      lines,
      `\n✨ **최고 등급: ${best}**`,
      `💰 환급: **+${refund}**💎`,
      `💎 최종 잔여: **${player.crystals}**💎`,
    ].join("\n"));
}

function koganeProfileEmbed(player) {
  if (!player.kogane) {
    return new EmbedBuilder().setTitle("🐾 코가네").setColor(0x4a5568).setDescription("> 코가네가 없습니다!\n> `!코가네가챠` 로 소환하세요! (200💎)\n> `!코가네가챠10` 으로 10회 연속 소환! (2000💎)");
  }
  const kg = KOGANE_GRADES[player.kogane.grade];
  return new EmbedBuilder()
    .setTitle(`${kg.emoji} 코가네 [${player.kogane.grade}] ${kg.stars}`)
    .setColor(kg.color)
    .setDescription(`> 📊 ATK +${kg.atkBonus*100}% · DEF +${kg.defBonus*100}% · HP +${kg.hpBonus*100}%\n> ⭐ XP +${kg.xpBonus*100}% · 💎 크리스탈 +${kg.crystalBonus*100}%`);
}

// ════════════════════════════════════════════════════════
// ── 전투 임베드들
// ════════════════════════════════════════════════════════
function cullingEmbed(player, session, log = []) {
  const stats = getPlayerStats(player);
  const enemy = session.currentEnemy;
  return new EmbedBuilder()
    .setTitle(`⚔️ 컬링 게임 — 🌊 WAVE ${session.wave}`)
    .setColor(0x7C5CFC)
    .setDescription(log.length ? log.join("\n") : "⚔️ 새 파도가 밀려온다!")
    .addFields(
      { name: `내 HP`, value: `${hpBar(player.hp, stats.maxHp)} \`${player.hp}/${stats.maxHp}\``, inline: true },
      { name: `${enemy.emoji} ${enemy.name}`, value: `${hpBar(session.enemyHp, enemy.hp)} \`${session.enemyHp}/${enemy.hp}\``, inline: true }
    );
}

function partyCullingEmbed(party, session, log = []) {
  const enemy = session.currentEnemy;
  return new EmbedBuilder()
    .setTitle(`⚔️ [파티] 컬링 게임 — 🌊 WAVE ${session.wave}`)
    .setColor(0x7C5CFC)
    .setDescription(log.length ? log.join("\n") : "⚔️ 진행 중!")
    .addFields(
      { name: `👥 파티원 (${party.members.length}명)`, value: party.members.map(uid => `> ${players[uid]?.name}`).join("\n") || "없음", inline: false },
      { name: `${enemy.emoji} ${enemy.name}`, value: `${hpBar(session.enemyHp, enemy.hp)} \`${session.enemyHp}/${enemy.hp}\``, inline: true }
    );
}

function jujutsuEmbed(player, session, log = [], choices = null) {
  const stats = getPlayerStats(player);
  return new EmbedBuilder()
    .setTitle(`🎯 사멸회유 — WAVE ${session.wave} | 포인트 ${session.points}/15`)
    .setColor(0x7C5CFC)
    .setDescription(log.length ? log.join("\n") : "🎯 진행 중!")
    .addFields({ name: `내 HP`, value: `${hpBar(player.hp, stats.maxHp)} \`${player.hp}/${stats.maxHp}\``, inline: false });
}

function pvpEmbed(session, log = []) {
  const p1 = players[session.p1Id];
  const p2 = players[session.p2Id];
  return new EmbedBuilder()
    .setTitle(`⚔️ PvP 결투 — ${p1?.name || "?"} VS ${p2?.name || "?"}`)
    .setColor(0xF5C842)
    .setDescription(log.length ? log.join("\n") : "⚔️ 결투 시작!")
    .addFields(
      { name: `${p1?.name || "플레이어1"}`, value: `HP: ${session.hp1}/${session.maxHp1}\n술식 CD: ${session.skillCd1}턴 · 반전 CD: ${session.reverseCd1}턴 · 영역 CD: ${session.domainCd1}턴`, inline: true },
      { name: `${p2?.name || "플레이어2"}`, value: `HP: ${session.hp2}/${session.maxHp2}\n술식 CD: ${session.skillCd2}턴 · 반전 CD: ${session.reverseCd2}턴 · 영역 CD: ${session.domainCd2}턴`, inline: true }
    );
}

function raidEmbed(raidSession, log = []) {
  const boss = RAID_BOSSES[raidSession.bossId];
  return new EmbedBuilder()
    .setTitle(`${boss.emoji} 레이드: ${boss.name}`)
    .setColor(boss.color)
    .setDescription(log.length ? log.join("\n") : "⚔️ 레이드 진행 중!");
}

function buildSkillEmbed(player) {
  const ch = CHARACTERS[player.active];
  const skills = getAvailableSkills(player, player.active);
  const skillText = skills.map((s, i) => `${i + 1}. ${s.name} (피해 ${s.dmg})`).join("\n");
  return new EmbedBuilder()
    .setTitle(`${ch.emoji} ${ch.name}의 술식`)
    .setColor(0x7c5cfc)
    .setDescription(`📈 숙련도: ${getMastery(player, player.active)}\n🌌 영역전개: ${ch.domain || "없음"}\n\n**사용 가능한 술식**\n${skillText}\n\n\`!스킬선택 [번호]\` 로 스킬 변경 가능`);
}

// ════════════════════════════════════════════════════════
// ── 버튼 팩토리 (영역전개 버튼 포함)
// ════════════════════════════════════════════════════════
function mkBattleButtons(player) {
  const canSkill = player.skillCooldown <= 0;
  const canReverse = player.reverseCooldown <= 0 && REVERSE_CHARS.has(player.active);
  const canDomain = player.domainCooldown <= 0 && CHARACTERS[player.active]?.domain;
  const currentSkill = getCurrentSkill(player, player.active);
  
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("b_attack").setLabel("⚔️ 공격").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("b_skill").setLabel(`🌀 ${currentSkill.name}`).setStyle(ButtonStyle.Primary).setDisabled(!canSkill),
    new ButtonBuilder().setCustomId("b_reverse").setLabel("♻️ 반전술식 (3턴쿨)").setStyle(ButtonStyle.Secondary).setDisabled(!canReverse),
    new ButtonBuilder().setCustomId("b_domain").setLabel("🌌 영역전개 (15턴쿨)").setStyle(ButtonStyle.Success).setDisabled(!canDomain),
    new ButtonBuilder().setCustomId("b_run").setLabel("🏃 도주").setStyle(ButtonStyle.Secondary)
  )];
}

function mkCullingButtons(player) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("c_attack").setLabel("⚔️ 공격").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("c_skill").setLabel("🌀 술식").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("c_reverse").setLabel("♻️ 반전 (3턴쿨)").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("c_domain").setLabel("🌌 영역전개 (15턴쿨)").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("c_escape").setLabel("🏳️ 철수").setStyle(ButtonStyle.Secondary)
  )];
}

function mkJujutsuButtons(player, choices) {
  const rows = [];
  if (choices && choices.length) {
    const choiceRow = new ActionRowBuilder();
    for (let i = 0; i < Math.min(choices.length, 3); i++) {
      choiceRow.addComponents(new ButtonBuilder().setCustomId(`j_choice_${i}`).setLabel(`⚔️ ${choices[i].name}`).setStyle(ButtonStyle.Primary));
    }
    rows.push(choiceRow);
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("j_attack").setLabel("⚔️ 공격").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("j_skill").setLabel("🌀 술식").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("j_reverse").setLabel("♻️ 반전 (3턴쿨)").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("j_domain").setLabel("🌌 영역전개 (15턴쿨)").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("j_escape").setLabel("🏳️ 철수").setStyle(ButtonStyle.Secondary)
  ));
  return rows;
}

function mkPvpButtons(session, userId) {
  const player = players[userId];
  const canReverse = (userId === session.p1Id ? session.reverseCd1 : session.reverseCd2) <= 0 && REVERSE_CHARS.has(player?.active);
  const canDomain = (userId === session.p1Id ? session.domainCd1 : session.domainCd2) <= 0 && CHARACTERS[player?.active]?.domain;
  
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("pvp_atk").setLabel("⚔️ 공격").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("pvp_skill").setLabel("🌀 술식").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("pvp_domain").setLabel("🌌 영역전개 (15턴쿨)").setStyle(ButtonStyle.Success).setDisabled(!canDomain),
    new ButtonBuilder().setCustomId("pvp_reverse").setLabel("♻️ 반전 (3턴쿨)").setStyle(ButtonStyle.Secondary).setDisabled(!canReverse),
    new ButtonBuilder().setCustomId("pvp_surrender").setLabel("🏳️ 항복").setStyle(ButtonStyle.Secondary)
  )];
}

function mkRaidButtons(player) {
  const canDomain = player.domainCooldown <= 0 && CHARACTERS[player.active]?.domain;
  
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("r_attack").setLabel("⚔️ 공격").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("r_skill").setLabel("🌀 술식").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("r_domain").setLabel("🌌 영역전개 (15턴쿨)").setStyle(ButtonStyle.Success).setDisabled(!canDomain),
    new ButtonBuilder().setCustomId("r_retreat").setLabel("🏳️ 철수").setStyle(ButtonStyle.Secondary)
  )];
}

function mkCharSelectMenu(player, customId) {
  const options = player.owned.map(id => {
    const ch = CHARACTERS[id];
    return {
      label: ch.name,
      description: `${ch.grade} | 숙련: ${getMastery(player, id)}${ch.domain ? ` | 영역: ${ch.domain}` : ""}`,
      value: id,
      default: id === player.active
    };
  });
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder("🎭 캐릭터 선택 (이름으로 표시)...").addOptions(options)
  );
}

// ════════════════════════════════════════════════════════
// ── 전투 핸들러
// ════════════════════════════════════════════════════════
async function handleBattleAction(interaction, player, battle, action) {
  const enemy = battle.enemy;
  const stats = getPlayerStats(player);
  const log = [];

  if (action === "b_run") {
    delete battles[interaction.user.id];
    return interaction.update({ content: "🏃 도주!", embeds: [], components: [] });
  }

  if (action === "b_reverse") {
    if (!REVERSE_CHARS.has(player.active)) return interaction.reply({ content: "❌ 반전술식 불가!", ephemeral: true });
    if (player.reverseCooldown > 0) return interaction.reply({ content: `❌ 반전술식 쿨다운 ${player.reverseCooldown}턴 (3턴마다 사용 가능)`, ephemeral: true });
    const heal = Math.floor(stats.maxHp * 0.4);
    player.hp = Math.min(stats.maxHp, player.hp + heal);
    player.reverseCooldown = 3;
    player.statusEffects = player.statusEffects.filter(s => s.id === "battleInstinct");
    log.push(`♻️ 반전술식! ${heal} HP 회복! (쿨다운 3턴)`);
  }
  else if (action === "b_domain") {
    const ch = CHARACTERS[player.active];
    if (!ch.domain) return interaction.reply({ content: "❌ 영역전개 없음!", ephemeral: true });
    if (player.domainCooldown > 0) return interaction.reply({ content: `❌ 영역전개 쿨다운 ${player.domainCooldown}턴 (15턴마다 사용 가능)`, ephemeral: true });
    const effect = getDomainEffect(ch.domain);
    const result = effect.effect(player, enemy, stats, stats.maxHp);
    enemy.currentHp = Math.max(0, enemy.currentHp - (result.dmg || 0));
    if (result.heal) player.hp = Math.min(stats.maxHp, player.hp + result.heal);
    if (result.selfDmg) player.hp = Math.max(0, player.hp - result.selfDmg);
    log.push(...(result.log || []));
    player.domainCooldown = 15;
  }
  else if (action === "b_skill") {
    if (player.skillCooldown > 0) return interaction.reply({ content: `❌ 술식 쿨다운 ${player.skillCooldown}턴`, ephemeral: true });
    const skill = getCurrentSkill(player, player.active);
    let dmg = calcSkillDmgForPlayer(player, skill.dmg);
    const isBlack = isBlackFlash();
    if (isBlack) { dmg = Math.floor(dmg * 2.5); player.crystals += 50; log.push(getBlackFlashArt()); }
    const statusLog = applySkillStatus(skill, enemy, player);
    enemy.currentHp = Math.max(0, enemy.currentHp - dmg);
    log.push(`🌀 ${skill.name}: ${dmg} 피해!`);
    log.push(...statusLog);
    player.skillCooldown = 5;
    updateQuestProgress(player, "skill_use", 1);
  }
  else if (action === "b_attack") {
    let dmg = calcDmgForPlayer(player, enemy.def);
    const isBlack = isBlackFlash();
    if (isBlack) { dmg = Math.floor(dmg * 2.5); player.crystals += 50; log.push(getBlackFlashArt()); }
    enemy.currentHp = Math.max(0, enemy.currentHp - dmg);
    log.push(`⚔️ 공격! ${dmg} 피해!`);
  }

  if (enemy.currentHp <= 0) {
    delete battles[interaction.user.id];
    const winEmbed = await processBattleWin(player, enemy);
    tickCooldowns(player);
    savePlayer(interaction.user.id);
    return interaction.update({ embeds: [new EmbedBuilder().setDescription(log.join("\n")), winEmbed], components: [] });
  }

  const eDmg = calcDmg(enemy.atk, stats.def);
  player.hp = Math.max(0, player.hp - eDmg);
  log.push(`💢 ${enemy.name} 반격! ${eDmg} 피해!`);
  
  tickCooldowns(player);
  
  if (player.hp <= 0) {
    player.losses++;
    delete battles[interaction.user.id];
    savePlayer(interaction.user.id);
    return interaction.update({ embeds: [new EmbedBuilder().setDescription(log.join("\n")), new EmbedBuilder().setTitle("💀 패배!").setColor(0xe63946)], components: [] });
  }

  savePlayer(interaction.user.id);
  const embed = new EmbedBuilder().setDescription(log.join("\n")).addFields(
    { name: "내 HP", value: `${hpBar(player.hp, stats.maxHp)} ${player.hp}/${stats.maxHp}`, inline: true },
    { name: `${enemy.name} HP`, value: `${hpBar(enemy.currentHp, enemy.hp)} ${enemy.currentHp}/${enemy.hp}`, inline: true }
  );
  return interaction.update({ embeds: [embed], components: mkBattleButtons(player) });
}

// ════════════════════════════════════════════════════════
// ── 컬링 핸들러
// ════════════════════════════════════════════════════════
async function handleCullingAction(interaction, player, culling, action) {
  const enemy = culling.currentEnemy;
  const stats = getPlayerStats(player);
  const log = [];

  if (action === "c_escape") {
    delete cullings[interaction.user.id];
    return interaction.update({ content: "🏳️ 컬링 종료!", embeds: [], components: [] });
  }

  if (action === "c_reverse") {
    if (!REVERSE_CHARS.has(player.active)) return interaction.reply({ content: "❌ 반전술식 불가!", ephemeral: true });
    if (player.reverseCooldown > 0) return interaction.reply({ content: `❌ 반전술식 쿨다운 ${player.reverseCooldown}턴 (3턴마다 사용 가능)`, ephemeral: true });
    const heal = Math.floor(stats.maxHp * 0.4);
    player.hp = Math.min(stats.maxHp, player.hp + heal);
    player.reverseCooldown = 3;
    player.statusEffects = player.statusEffects.filter(s => s.id === "battleInstinct");
    log.push(`♻️ 반전술식! ${heal} HP 회복! (쿨다운 3턴)`);
  }
  else if (action === "c_domain") {
    const ch = CHARACTERS[player.active];
    if (!ch.domain) return interaction.reply({ content: "❌ 영역전개 없음!", ephemeral: true });
    if (player.domainCooldown > 0) return interaction.reply({ content: `❌ 영역전개 쿨다운 ${player.domainCooldown}턴 (15턴마다 사용 가능)`, ephemeral: true });
    const effect = getDomainEffect(ch.domain);
    const result = effect.effect(player, enemy, stats, stats.maxHp);
    culling.enemyHp = Math.max(0, culling.enemyHp - (result.dmg || 0));
    if (result.heal) player.hp = Math.min(stats.maxHp, player.hp + result.heal);
    if (result.selfDmg) player.hp = Math.max(0, player.hp - result.selfDmg);
    log.push(...(result.log || []));
    player.domainCooldown = 15;
  }
  else if (action === "c_skill") {
    if (player.skillCooldown > 0) return interaction.reply({ content: `❌ 술식 쿨다운 ${player.skillCooldown}턴`, ephemeral: true });
    const skill = getCurrentSkill(player, player.active);
    let dmg = calcSkillDmgForPlayer(player, skill.dmg);
    const isBlack = isBlackFlash();
    if (isBlack) { dmg = Math.floor(dmg * 2.5); player.crystals += 50; log.push(getBlackFlashArt()); }
    const statusLog = applySkillStatus(skill, enemy, player);
    culling.enemyHp = Math.max(0, culling.enemyHp - dmg);
    log.push(`🌀 ${skill.name}: ${dmg} 피해!`);
    log.push(...statusLog);
    player.skillCooldown = 5;
    updateQuestProgress(player, "skill_use", 1);
  }
  else if (action === "c_attack") {
    let dmg = calcDmgForPlayer(player, enemy.def);
    const isBlack = isBlackFlash();
    if (isBlack) { dmg = Math.floor(dmg * 2.5); player.crystals += 50; log.push(getBlackFlashArt()); }
    culling.enemyHp = Math.max(0, culling.enemyHp - dmg);
    log.push(`⚔️ 공격! ${dmg} 피해!`);
  }

  if (culling.enemyHp <= 0) {
    const xp = Math.floor(enemy.xp);
    const cr = Math.floor(enemy.crystals);
    culling.kills++;
    player.xp += xp;
    player.crystals += cr;
    culling.wave++;
    const next = pickCullingEnemy(culling.wave);
    culling.currentEnemy = next;
    culling.enemyHp = next.hp;
    log.push(`✅ 처치! WAVE ${culling.wave} — ${next.name} 등장!`);
  } else {
    const eDmg = calcDmg(enemy.atk, stats.def);
    player.hp = Math.max(0, player.hp - eDmg);
    log.push(`💢 ${enemy.name} 반격! ${eDmg} 피해!`);
    if (player.hp <= 0) {
      delete cullings[interaction.user.id];
      savePlayer(interaction.user.id);
      return interaction.update({ embeds: [new EmbedBuilder().setTitle("💀 컬링 종료!").setColor(0xe63946)], components: [] });
    }
  }

  tickCooldowns(player);
  savePlayer(interaction.user.id);
  return interaction.update({ embeds: [cullingEmbed(player, culling, log)], components: mkCullingButtons(player) });
}

// ════════════════════════════════════════════════════════
// ── 사멸회유 핸들러
// ════════════════════════════════════════════════════════
async function handleJujutsuAction(interaction, player, jujutsu, action) {
  const stats = getPlayerStats(player);
  const log = [];

  if (action === "j_escape") {
    delete jujutsus[interaction.user.id];
    return interaction.update({ content: "🏳️ 종료!", embeds: [], components: [] });
  }

  if (action === "j_reverse") {
    if (!REVERSE_CHARS.has(player.active)) return interaction.reply({ content: "❌ 반전술식 불가!", ephemeral: true });
    if (player.reverseCooldown > 0) return interaction.reply({ content: `❌ 반전술식 쿨다운 ${player.reverseCooldown}턴 (3턴마다 사용 가능)`, ephemeral: true });
    const heal = Math.floor(stats.maxHp * 0.4);
    player.hp = Math.min(stats.maxHp, player.hp + heal);
    player.reverseCooldown = 3;
    player.statusEffects = player.statusEffects.filter(s => s.id === "battleInstinct");
    log.push(`♻️ 반전술식! ${heal} HP 회복!`);
  }
  else if (action === "j_domain") {
    const ch = CHARACTERS[player.active];
    if (!ch.domain) return interaction.reply({ content: "❌ 영역전개 없음!", ephemeral: true });
    if (player.domainCooldown > 0) return interaction.reply({ content: `❌ 영역전개 쿨다운 ${player.domainCooldown}턴 (15턴마다 사용 가능)`, ephemeral: true });
    if (jujutsu.currentEnemy) {
      const effect = getDomainEffect(ch.domain);
      const result = effect.effect(player, jujutsu.currentEnemy, stats, stats.maxHp);
      jujutsu.enemyHp = Math.max(0, jujutsu.enemyHp - (result.dmg || 0));
      if (result.heal) player.hp = Math.min(stats.maxHp, player.hp + result.heal);
      log.push(...(result.log || []));
    }
    player.domainCooldown = 15;
  }
  else if (action === "j_skill") {
    if (player.skillCooldown > 0) return interaction.reply({ content: `❌ 술식 쿨다운 ${player.skillCooldown}턴`, ephemeral: true });
    const skill = getCurrentSkill(player, player.active);
    let dmg = calcSkillDmgForPlayer(player, skill.dmg);
    const isBlack = isBlackFlash();
    if (isBlack) { dmg = Math.floor(dmg * 2.5); player.crystals += 50; log.push(getBlackFlashArt()); }
    const statusLog = applySkillStatus(skill, jujutsu.currentEnemy, player);
    jujutsu.enemyHp = Math.max(0, jujutsu.enemyHp - dmg);
    log.push(`🌀 ${skill.name}: ${dmg} 피해!`);
    log.push(...statusLog);
    player.skillCooldown = 5;
    updateQuestProgress(player, "skill_use", 1);
  }
  else if (action === "j_attack") {
    let dmg = calcDmgForPlayer(player, jujutsu.currentEnemy.def);
    const isBlack = isBlackFlash();
    if (isBlack) { dmg = Math.floor(dmg * 2.5); player.crystals += 50; log.push(getBlackFlashArt()); }
    jujutsu.enemyHp = Math.max(0, jujutsu.enemyHp - dmg);
    log.push(`⚔️ 공격! ${dmg} 피해!`);
  }

  if (jujutsu.currentEnemy && jujutsu.enemyHp <= 0) {
    jujutsu.currentEnemy = null;
    jujutsu.enemyHp = 0;
  }

  tickCooldowns(player);
  savePlayer(interaction.user.id);
  return interaction.update({ embeds: [new EmbedBuilder().setDescription(log.join("\n"))], components: [] });
}

// ════════════════════════════════════════════════════════
// ── PvP 핸들러
// ════════════════════════════════════════════════════════
function pvpSelf(session, userId) {
  if (session.p1Id === userId) return { skillCd: session.skillCd1, reverseCd: session.reverseCd1, domainCd: session.domainCd1 };
  return { skillCd: session.skillCd2, reverseCd: session.reverseCd2, domainCd: session.domainCd2 };
}

async function handlePvpAction(interaction, player, session, action) {
  const stats = getPlayerStats(player);
  const log = [];

  if (action === "pvp_surrender") {
    const winner = session.p1Id === player.id ? session.p2Id : session.p1Id;
    players[winner].pvpWins++;
    player.pvpLosses++;
    const sid = Object.keys(pvpSessions).find(k => pvpSessions[k] === session);
    if (sid) delete pvpSessions[sid];
    savePlayer(winner);
    savePlayer(player.id);
    return interaction.update({ embeds: [new EmbedBuilder().setTitle(`🏳️ ${player.name} 항복! ${players[winner].name} 승리!`).setColor(0xe63946)], components: [] });
  }

  if (action === "pvp_reverse") {
    if (!REVERSE_CHARS.has(player.active)) return interaction.reply({ content: "❌ 반전술식 불가!", ephemeral: true });
    const self = pvpSelf(session, player.id);
    if (self.reverseCd > 0) return interaction.reply({ content: `❌ 반전술식 쿨다운 ${self.reverseCd}턴 (3턴마다 사용 가능)`, ephemeral: true });
    const heal = Math.floor(stats.maxHp * 0.4);
    if (session.p1Id === player.id) session.hp1 = Math.min(session.maxHp1, session.hp1 + heal);
    else session.hp2 = Math.min(session.maxHp2, session.hp2 + heal);
    if (session.p1Id === player.id) session.reverseCd1 = 3;
    else session.reverseCd2 = 3;
    log.push(`♻️ 반전술식! ${heal} HP 회복! (쿨다운 3턴)`);
  }
  else if (action === "pvp_domain") {
    const ch = CHARACTERS[player.active];
    if (!ch.domain) return interaction.reply({ content: "❌ 영역전개 없음!", ephemeral: true });
    const self = pvpSelf(session, player.id);
    if (self.domainCd > 0) return interaction.reply({ content: `❌ 영역전개 쿨다운 ${self.domainCd}턴 (15턴마다 사용 가능)`, ephemeral: true });
    const effect = getDomainEffect(ch.domain);
    const defender = session.p1Id === player.id ? 
      { hp: session.hp2, statusEffects: session.status2, def: getPlayerStats(players[session.p2Id]).def } :
      { hp: session.hp1, statusEffects: session.status1, def: getPlayerStats(players[session.p1Id]).def };
    const result = effect.effect(player, defender, stats, stats.maxHp);
    if (session.p1Id === player.id) session.hp2 = Math.max(0, session.hp2 - (result.dmg || 0));
    else session.hp1 = Math.max(0, session.hp1 - (result.dmg || 0));
    log.push(...(result.log || []));
    if (session.p1Id === player.id) session.domainCd1 = 15;
    else session.domainCd2 = 15;
  }
  else if (action === "pvp_skill") {
    const self = pvpSelf(session, player.id);
    if (self.skillCd > 0) return interaction.reply({ content: `❌ 술식 쿨다운 ${self.skillCd}턴`, ephemeral: true });
    const skill = getCurrentSkill(player, player.active);
    let dmg = calcSkillDmgForPlayer(player, skill.dmg);
    const isBlack = isBlackFlash();
    if (isBlack) { dmg = Math.floor(dmg * 2.5); log.push(getBlackFlashArt()); }
    const statusLog = applySkillStatus(skill, 
      session.p1Id === player.id ? { statusEffects: session.status2 } : { statusEffects: session.status1 }, 
      player);
    if (session.p1Id === player.id) session.hp2 = Math.max(0, session.hp2 - dmg);
    else session.hp1 = Math.max(0, session.hp1 - dmg);
    log.push(`🌀 ${skill.name}: ${dmg} 피해!`);
    log.push(...statusLog);
    if (session.p1Id === player.id) session.skillCd1 = 5;
    else session.skillCd2 = 5;
    updateQuestProgress(player, "skill_use", 1);
  }
  else if (action === "pvp_atk") {
    let dmg = calcDmgForPlayer(player, (session.p1Id === player.id ? getPlayerStats(players[session.p2Id]).def : getPlayerStats(players[session.p1Id]).def));
    const isBlack = isBlackFlash();
    if (isBlack) { dmg = Math.floor(dmg * 2.5); log.push(getBlackFlashArt()); }
    if (session.p1Id === player.id) session.hp2 = Math.max(0, session.hp2 - dmg);
    else session.hp1 = Math.max(0, session.hp1 - dmg);
    log.push(`⚔️ 공격! ${dmg} 피해!`);
  }

  // 쿨다운 감소 및 턴 전환
  if (session.p1Id === player.id) {
    if (session.skillCd1 > 0) session.skillCd1--;
    if (session.reverseCd1 > 0) session.reverseCd1--;
    if (session.domainCd1 > 0) session.domainCd1--;
  } else {
    if (session.skillCd2 > 0) session.skillCd2--;
    if (session.reverseCd2 > 0) session.reverseCd2--;
    if (session.domainCd2 > 0) session.domainCd2--;
  }
  session.turn = session.p1Id === player.id ? session.p2Id : session.p1Id;

  if (session.hp1 <= 0 || session.hp2 <= 0) {
    const winner = session.hp1 <= 0 ? players[session.p2Id] : players[session.p1Id];
    const loser = session.hp1 <= 0 ? players[session.p1Id] : players[session.p2Id];
    winner.pvpWins++;
    loser.pvpLosses++;
    updateQuestProgress(winner, "pvp_win", 1);
    const sid = Object.keys(pvpSessions).find(k => pvpSessions[k] === session);
    if (sid) delete pvpSessions[sid];
    savePlayer(winner.id);
    savePlayer(loser.id);
    return interaction.update({ embeds: [new EmbedBuilder().setTitle(`🏆 ${winner.name} 승리!`).setColor(0xF5C842)], components: [] });
  }

  const embed = new EmbedBuilder()
    .setTitle(`⚔️ PvP 결투 - ${players[session.p1Id].name} VS ${players[session.p2Id].name}`)
    .setDescription(log.join("\n"))
    .addFields(
      { name: `${players[session.p1Id].name}`, value: `HP: ${session.hp1}/${session.maxHp1}\n⚡술식: ${session.skillCd1}턴 · ♻️반전: ${session.reverseCd1}턴 · 🌌영역: ${session.domainCd1}턴`, inline: true },
      { name: `${players[session.p2Id].name}`, value: `HP: ${session.hp2}/${session.maxHp2}\n⚡술식: ${session.skillCd2}턴 · ♻️반전: ${session.reverseCd2}턴 · 🌌영역: ${session.domainCd2}턴`, inline: true }
    );
  return interaction.update({ embeds: [embed], components: mkPvpButtons(session, session.turn) });
}

// ════════════════════════════════════════════════════════
// ── 레이드 핸들러
// ════════════════════════════════════════════════════════
async function handleRaidAction(interaction, player, raidSession, action) {
  const boss = RAID_BOSSES[raidSession.bossId];
  const stats = getPlayerStats(player);
  const log = [];

  if (action === "r_retreat") {
    raidSession.members = raidSession.members.filter(id => id !== player.id);
    if (raidSession.members.length === 0) delete raidSessions[raidSession.id];
    savePlayer(player.id);
    return interaction.update({ content: "🏳️ 철수!", embeds: [], components: [] });
  }

  if (action === "r_reverse") {
    if (!REVERSE_CHARS.has(player.active)) return interaction.reply({ content: "❌ 반전술식 불가!", ephemeral: true });
    if (player.reverseCooldown > 0) return interaction.reply({ content: `❌ 반전술식 쿨다운 ${player.reverseCooldown}턴 (3턴마다 사용 가능)`, ephemeral: true });
    const heal = Math.floor(stats.maxHp * 0.4);
    player.hp = Math.min(stats.maxHp, player.hp + heal);
    player.reverseCooldown = 3;
    player.statusEffects = player.statusEffects.filter(s => s.id === "battleInstinct");
    log.push(`♻️ 반전술식! ${heal} HP 회복! (쿨다운 3턴)`);
  }
  else if (action === "r_domain") {
    const ch = CHARACTERS[player.active];
    if (!ch.domain) return interaction.reply({ content: "❌ 영역전개 없음!", ephemeral: true });
    if (player.domainCooldown > 0) return interaction.reply({ content: `❌ 영역전개 쿨다운 ${player.domainCooldown}턴 (15턴마다 사용 가능)`, ephemeral: true });
    const effect = getDomainEffect(ch.domain);
    const result = effect.effect(player, { hp: raidSession.hp, statusEffects: [] }, stats, stats.maxHp);
    raidSession.hp = Math.max(0, raidSession.hp - (result.dmg || 0));
    if (result.heal) player.hp = Math.min(stats.maxHp, player.hp + result.heal);
    if (result.selfDmg) player.hp = Math.max(0, player.hp - result.selfDmg);
    log.push(...(result.log || []));
    player.domainCooldown = 15;
  }
  else if (action === "r_skill") {
    if (player.skillCooldown > 0) return interaction.reply({ content: `❌ 술식 쿨다운 ${player.skillCooldown}턴`, ephemeral: true });
    const skill = getCurrentSkill(player, player.active);
    let dmg = calcSkillDmgForPlayer(player, skill.dmg);
    const isBlack = isBlackFlash();
    if (isBlack) { dmg = Math.floor(dmg * 2.5); player.crystals += 50; log.push(getBlackFlashArt()); }
    const statusLog = applySkillStatus(skill, { statusEffects: [] }, player);
    raidSession.hp = Math.max(0, raidSession.hp - dmg);
    log.push(`🌀 ${skill.name}: ${dmg} 피해!`);
    log.push(...statusLog);
    player.skillCooldown = 5;
    updateQuestProgress(player, "skill_use", 1);
  }
  else if (action === "r_attack") {
    let dmg = calcDmgForPlayer(player, boss.def);
    const isBlack = isBlackFlash();
    if (isBlack) { dmg = Math.floor(dmg * 2.5); player.crystals += 50; log.push(getBlackFlashArt()); }
    raidSession.hp = Math.max(0, raidSession.hp - dmg);
    log.push(`⚔️ ${player.name} 공격! ${dmg} 피해!`);
  }

  if (!raidSession.enraged && raidSession.hp < boss.hp * boss.phaseHp) {
    raidSession.enraged = true;
    log.push(`\`\`\`ansi\n\u001b[1;31m⚠ 분노 페이즈 돌입!! ATK ${boss.enragedAtk} 으로 상승! ⚠\n\`\`\``);
  }

  if (raidSession.hp <= 0) {
    const drops = rollDrops(boss.dropKey);
    for (const uid of raidSession.members) {
      const p = players[uid];
      if (p) {
        p.xp += boss.xp;
        p.crystals += boss.crystals;
        if (boss.fingers) p.sukunaFingers = Math.min(SUKUNA_FINGER_MAX, (p.sukunaFingers || 0) + boss.fingers);
        p.potion += 3;
        addMaterials(p, drops);
        if (!p.raidClears) p.raidClears = {};
        p.raidClears[raidSession.bossId] = (p.raidClears[raidSession.bossId] || 0) + 1;
        updateQuestProgress(p, "boss_kill", 1);
        savePlayer(uid);
      }
    }
    delete raidSessions[raidSession.id];
    const winEmbed = new EmbedBuilder().setTitle("🏆 레이드 클리어!").setColor(0xF5C842)
      .setDescription(`> ${boss.name} 격파!\n> 보상: +${boss.xp}XP +${boss.crystals}💎 +${boss.masteryXp}숙련 +3🧪`);
    return interaction.update({ embeds: [winEmbed], components: [] });
  }

  const eDmg = calcDmg(raidSession.enraged ? boss.enragedAtk : boss.atk, stats.def);
  player.hp = Math.max(0, player.hp - eDmg);
  log.push(`💢 ${boss.name} 공격! ${eDmg} 피해!`);
  
  if (player.hp <= 0) {
    raidSession.members = raidSession.members.filter(id => id !== player.id);
    log.push(`💀 ${player.name} 전투 불능!`);
    if (raidSession.members.length === 0) {
      delete raidSessions[raidSession.id];
      return interaction.update({ embeds: [new EmbedBuilder().setTitle("💀 레이드 실패").setColor(0xe63946)], components: [] });
    }
  }
  
  tickCooldowns(player);
  savePlayer(player.id);
  return interaction.update({ embeds: [raidEmbed(raidSession, log)], components: mkRaidButtons(player) });
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
    return interaction.update({ content: "🏳️ 파티 컬링 종료!", embeds: [], components: [] });
  }

  if (action === "pc_reverse") {
    if (!REVERSE_CHARS.has(player.active)) return interaction.reply({ content: "❌ 반전술식 불가!", ephemeral: true });
    if (player.reverseCooldown > 0) return interaction.reply({ content: `❌ 반전술식 쿨다운 ${player.reverseCooldown}턴`, ephemeral: true });
    const stats = getPlayerStats(player);
    const heal = Math.floor(stats.maxHp * 0.4);
    player.hp = Math.min(stats.maxHp, player.hp + heal);
    player.reverseCooldown = 3;
    player.statusEffects = player.statusEffects.filter(s => s.id === "battleInstinct");
    log.push(`♻️ 반전술식! ${heal} HP 회복!`);
  }
  else if (action === "pc_domain") {
    const ch = CHARACTERS[player.active];
    if (!ch.domain) return interaction.reply({ content: "❌ 영역전개 없음!", ephemeral: true });
    if (player.domainCooldown > 0) return interaction.reply({ content: `❌ 영역전개 쿨다운 ${player.domainCooldown}턴`, ephemeral: true });
    const stats = getPlayerStats(player);
    const effect = getDomainEffect(ch.domain);
    const result = effect.effect(player, enemy, stats, stats.maxHp);
    session.enemyHp = Math.max(0, session.enemyHp - (result.dmg || 0));
    if (result.heal) player.hp = Math.min(stats.maxHp, player.hp + result.heal);
    if (result.selfDmg) player.hp = Math.max(0, player.hp - result.selfDmg);
    log.push(...(result.log || []));
    player.domainCooldown = 15;
  }
  else if (action === "pc_skill") {
    if (player.skillCooldown > 0) return interaction.reply({ content: "❌ 술식 쿨다운!", ephemeral: true });
    const skill = getCurrentSkill(player, player.active);
    let dmg = calcSkillDmgForPlayer(player, skill.dmg);
    const isBlack = isBlackFlash();
    if (isBlack) { dmg = Math.floor(dmg * 2.5); player.crystals += 50; log.push(getBlackFlashArt()); }
    const statusLog = applySkillStatus(skill, enemy, player);
    session.enemyHp = Math.max(0, session.enemyHp - dmg);
    log.push(`🌀 ${skill.name}: ${dmg} 피해!`);
    log.push(...statusLog);
    player.skillCooldown = 5;
    updateQuestProgress(player, "skill_use", 1);
  }
  else if (action === "pc_attack") {
    let dmg = calcDmgForPlayer(player, enemy.def);
    const isBlack = isBlackFlash();
    if (isBlack) { dmg = Math.floor(dmg * 2.5); player.crystals += 50; log.push(getBlackFlashArt()); }
    session.enemyHp = Math.max(0, session.enemyHp - dmg);
    log.push(`⚔️ 공격! ${dmg} 피해!`);
  }

  if (session.enemyHp <= 0) {
    for (const uid of party.members) {
      const p = players[uid];
      if (p) {
        p.xp += Math.floor(enemy.xp / party.members.length);
        p.crystals += Math.floor(enemy.crystals / party.members.length);
        const drops = rollDrops(enemy.id);
        addMaterials(p, drops);
        updateQuestProgress(p, "battle_win", 1);
        savePlayer(uid);
      }
    }
    session.wave++;
    const next = pickCullingEnemy(session.wave);
    session.currentEnemy = next;
    session.enemyHp = next.hp;
    log.push(`✅ WAVE ${session.wave} — ${next.name} 등장!`);
  } else {
    const target = party.members[Math.floor(Math.random() * party.members.length)];
    const targetPlayer = players[target];
    if (targetPlayer) {
      const eDmg = calcDmg(enemy.atk, getPlayerStats(targetPlayer).def);
      targetPlayer.hp = Math.max(0, targetPlayer.hp - eDmg);
      log.push(`💢 ${enemy.name} → ${targetPlayer.name} ${eDmg} 피해!`);
      if (targetPlayer.hp <= 0) log.push(`💀 ${targetPlayer.name} 전투 불능!`);
      savePlayer(target);
    }
    if (party.members.every(uid => (players[uid]?.hp || 0) <= 0)) {
      delete cullings[party.id];
      return interaction.update({ content: "💀 파티 전멸!", embeds: [], components: [] });
    }
  }

  tickCooldowns(player);
  savePlayer(player.id);
  return interaction.update({ embeds: [partyCullingEmbed(party, session, log)], components: mkCullingButtons(player) });
}

// ════════════════════════════════════════════════════════
// ── 파티/PvP 유틸
// ════════════════════════════════════════════════════════
function getPartyId(userId) {
  return Object.keys(parties).find(pid => parties[pid]?.members?.includes(userId)) || null;
}
function getParty(userId) {
  const pid = getPartyId(userId);
  return pid ? parties[pid] : null;
}
function getPvpSessionByUser(userId) {
  return Object.values(pvpSessions).find(s => s.p1Id === userId || s.p2Id === userId) || null;
}
function getRaidByUser(userId) {
  return Object.values(raidSessions).find(r => r.members.includes(userId)) || null;
}
function generateJujutsuChoices(wave) { 
  return [{ id:"j1", name:"저주령", emoji:"👹", hp:500, atk:50, def:20, points:1, desc:"기본 적" }]; 
}

// ════════════════════════════════════════════════════════
// ── 메인 (Discord 준비 & 슬래시 커맨드)
// ════════════════════════════════════════════════════════
client.once("ready", async () => {
  console.log(`✅ 로그인: ${client.user.tag}`);
  await dbInit();
  players = await dbLoad();
  console.log("🚀 주술회전 RPG 봇 활성화");

  const commands = [
    { name: "프로필", description: "내 프로필 확인" },
    { name: "전투", description: "일반 전투 시작" },
    { name: "술식", description: "술식 확인" },
    { name: "스킬선택", description: "사용할 술식 번호 선택", options: [{ name: "번호", type: 4, description: "1~최대", required: true }] },
    { name: "가챠", description: "캐릭터 뽑기", options: [{ name: "횟수", type: 4, description: "1 또는 10", required: true }] },
    { name: "활성", description: "캐릭터 변경" },
    { name: "도감", description: "보유 캐릭터 목록" },
    { name: "출석", description: "매일 출석 체크" },
    { name: "회복", description: "회복약 사용" },
    { name: "코가네가챠", description: "코가네 뽑기 (200💎)" },
    { name: "코가네", description: "코가네 정보" },
    { name: "손가락", description: "스쿠나 손가락 현황" },
    { name: "컬링", description: "컬링 게임 시작" },
    { name: "사멸회유", description: "사멸회유 게임 시작" },
    { name: "결투", description: "PvP 결투 신청", options: [{ name: "대상", type: 6, required: true }] },
    { name: "파티생성", description: "파티 생성" },
    { name: "파티초대", description: "파티 초대", options: [{ name: "대상", type: 6, required: true }] },
    { name: "파티나가기", description: "파티 탈퇴" },
    { name: "파티컬링", description: "파티 컬링 시작" },
    { name: "레이드", description: "레이드 시작", options: [{ name: "보스", type: 3, description: "heian_sukuna 또는 mahoraga", required: true }] },
    { name: "코드", description: "쿠폰 코드 사용", options: [{ name: "코드", type: 3, required: true }] },
    { name: "퀘스트", description: "퀘스트 현황 확인" },
    { name: "재료", description: "재료 인벤토리 확인" },
    { name: "주구목록", description: "주구 목록 확인" },
    { name: "주구제작", description: "주구 제작", options: [{ name: "이름", type: 3, required: true }] },
    { name: "장착", description: "주구 장착", options: [{ name: "이름", type: 3, required: true }] },
    { name: "해제", description: "주구 해제" },
    { name: "도움말", description: "명령어 목록" },
    { name: "개발자패널", description: "개발자 전용 패널" },
  ];
  await client.application.commands.set(commands);
  console.log("✅ 슬래시 커맨드 등록 완료");
});

// ════════════════════════════════════════════════════════
// ── 인터랙션 핸들러
// ════════════════════════════════════════════════════════
client.on("interactionCreate", async (interaction) => {
  // 셀렉트 메뉴 (캐릭터 선택)
  if (interaction.isStringSelectMenu() && interaction.customId === "char_select") {
    const player = getPlayer(interaction.user.id, interaction.user.username);
    const charId = interaction.values[0];
    if (!player.owned.includes(charId)) return interaction.reply({ content: "❌ 미보유!", ephemeral: true });
    player.active = charId;
    const stats = getPlayerStats(player);
    player.hp = stats.maxHp;
    savePlayer(interaction.user.id);
    const ch = CHARACTERS[charId];
    return interaction.update({ embeds: [new EmbedBuilder().setTitle(`✅ ${ch.name} 활성화!`).setDescription(`🌌 영역전개: ${ch.domain || "없음"}`)], components: [] });
  }

  // 버튼 처리
  if (interaction.isButton()) {
    const player = getPlayer(interaction.user.id, interaction.user.username);
    if (interaction.customId.startsWith("b_")) {
      const battle = battles[interaction.user.id];
      if (!battle) return interaction.reply({ content: "❌ 전투 없음", ephemeral: true });
      return handleBattleAction(interaction, player, battle, interaction.customId);
    }
    if (interaction.customId.startsWith("c_")) {
      const culling = cullings[interaction.user.id];
      if (!culling) return interaction.reply({ content: "❌ 컬링 없음", ephemeral: true });
      return handleCullingAction(interaction, player, culling, interaction.customId);
    }
    if (interaction.customId.startsWith("j_")) {
      const jujutsu = jujutsus[interaction.user.id];
      if (!jujutsu) return interaction.reply({ content: "❌ 사멸회유 없음", ephemeral: true });
      if (interaction.customId === "j_escape") {
        delete jujutsus[interaction.user.id];
        return interaction.update({ content: "🏳 종료", embeds: [], components: [] });
      }
      if (interaction.customId.startsWith("j_choice_")) {
        const idx = parseInt(interaction.customId.split("_")[2]);
        if (jujutsu.choices?.[idx]) {
          jujutsu.currentEnemy = JSON.parse(JSON.stringify(jujutsu.choices[idx]));
          jujutsu.enemyHp = jujutsu.currentEnemy.hp;
          jujutsu.choices = null;
          return interaction.update({ embeds: [jujutsuEmbed(player, jujutsu)], components: mkJujutsuButtons(player, []) });
        }
        return interaction.reply({ content: "❌ 잘못된 선택", ephemeral: true });
      }
      return handleJujutsuAction(interaction, player, jujutsu, interaction.customId);
    }
    if (interaction.customId.startsWith("pvp_")) {
      const session = getPvpSessionByUser(interaction.user.id);
      if (!session) return interaction.reply({ content: "❌ PvP 없음", ephemeral: true });
      if (session.turn !== interaction.user.id) return interaction.reply({ content: "⏳ 당신의 턴이 아닙니다!", ephemeral: true });
      return handlePvpAction(interaction, player, session, interaction.customId);
    }
    if (interaction.customId.startsWith("r_")) {
      const raid = getRaidByUser(interaction.user.id);
      if (!raid) return interaction.reply({ content: "❌ 레이드 없음", ephemeral: true });
      if (player.hp <= 0) return interaction.reply({ content: "💀 전투 불능! `/회복` 으로 회복하세요.", ephemeral: true });
      return handleRaidAction(interaction, player, raid, interaction.customId);
    }
    if (interaction.customId.startsWith("pc_")) {
      const party = getParty(interaction.user.id);
      if (!party) return interaction.reply({ content: "❌ 파티 없음", ephemeral: true });
      const session = cullings[party.id];
      if (!session) return interaction.reply({ content: "❌ 파티 컬링 없음", ephemeral: true });
      if (player.hp <= 0) return interaction.reply({ content: "💀 전투 불능!", ephemeral: true });
      return handlePartyCullingAction(interaction, player, session, interaction.customId);
    }
    if (interaction.customId.startsWith("party_invite_")) {
      const parts = interaction.customId.split("_");
      const partyId = parts[3];
      if (interaction.customId.includes("accept")) {
        const party = parties[partyId];
        if (!party) return interaction.reply({ content: "❌ 파티 없음", ephemeral: true });
        if (party.members.length >= 4) return interaction.reply({ content: "❌ 가득참", ephemeral: true });
        if (getPartyId(interaction.user.id)) return interaction.reply({ content: "❌ 이미 파티 소속", ephemeral: true });
        party.members.push(interaction.user.id);
        delete partyInvites[interaction.user.id];
        return interaction.update({ content: `✅ 파티 참가! (${party.members.length}/4명)`, embeds: [], components: [] });
      } else {
        delete partyInvites[interaction.user.id];
        return interaction.update({ content: "❌ 거절", embeds: [], components: [] });
      }
    }
    if (interaction.customId.startsWith("pvp_challenge_")) {
      const parts = interaction.customId.split("_");
      const challengerId = parts[4];
      if (interaction.customId.includes("accept")) {
        const p1 = players[challengerId];
        const p2 = players[interaction.user.id];
        if (!p1 || !p2) return interaction.reply({ content: "❌ 오류", ephemeral: true });
        if (getPvpSessionByUser(challengerId) || getPvpSessionByUser(interaction.user.id)) {
          return interaction.reply({ content: "❌ 이미 PvP 중", ephemeral: true });
        }
        const session = { 
          id: `pvp_${Date.now()}`, p1Id: challengerId, p2Id: interaction.user.id, 
          hp1: getPlayerStats(p1).maxHp, hp2: getPlayerStats(p2).maxHp,
          maxHp1: getPlayerStats(p1).maxHp, maxHp2: getPlayerStats(p2).maxHp,
          status1: [], status2: [], skillCd1: 0, skillCd2: 0, reverseCd1: 0, reverseCd2: 0, domainCd1: 0, domainCd2: 0,
          turn: challengerId 
        };
        pvpSessions[session.id] = session;
        delete pvpChallenges[challengerId];
        return interaction.update({ embeds: [new EmbedBuilder().setTitle("⚔️ PvP 시작!")], components: mkPvpButtons(session, challengerId) });
      } else {
        delete pvpChallenges[challengerId];
        return interaction.update({ content: "❌ 거절", embeds: [], components: [] });
      }
    }
  }

  // 슬래시 커맨드
  if (interaction.isChatInputCommand()) {
    const { commandName, user } = interaction;
    const userId = user.id;
    const player = getPlayer(userId, user.username);
    
    if (commandName === "프로필") return interaction.reply({ embeds: [profileEmbed(player)] });
    if (commandName === "전투") {
      if (battles[userId]) return interaction.reply({ content: "❌ 이미 전투 중!", ephemeral: true });
      const eBase = Math.random() < 0.05 ? ENEMIES.find(e => e.id === "e_sukuna") : ENEMIES[Math.floor(Math.random() * 3)];
      const enemy = { ...eBase, currentHp: eBase.hp, statusEffects: [] };
      battles[userId] = { enemy };
      return interaction.reply({ embeds: [new EmbedBuilder().setTitle(eBase.isSukuna ? "🔴 스쿠나 출현!" : "⚔️ 전투!").setDescription(`**${enemy.emoji} ${enemy.name}** 등장!`)], components: mkBattleButtons(player) });
    }
    if (commandName === "술식") return interaction.reply({ embeds: [buildSkillEmbed(player)] });
    if (commandName === "스킬선택") {
      const num = interaction.options.getInteger("번호");
      const available = getAvailableSkills(player, player.active);
      if (num < 1 || num > available.length) return interaction.reply({ content: `❌ 1~${available.length} 사이`, ephemeral: true });
      player.selectedSkillIndex = num - 1;
      savePlayer(userId);
      return interaction.reply({ content: `✅ ${available[num-1].name}(으)로 변경됨`, ephemeral: true });
    }
    if (commandName === "가챠") {
      const count = interaction.options.getInteger("횟수");
      if (count !== 1 && count !== 10) return interaction.reply({ content: "❌ 1 또는 10", ephemeral: true });
      const cost = count === 1 ? 150 : 1350;
      if (player.crystals < cost) return interaction.reply({ content: `💎 부족! 필요: ${cost}`, ephemeral: true });
      player.crystals -= cost;
      await interaction.reply({ embeds: [gachaLoadingEmbed(1)] });
      await new Promise(r => setTimeout(r, 1500));
      await interaction.editReply({ embeds: [gachaLoadingEmbed(2)] });
      await new Promise(r => setTimeout(r, 1500));
      await interaction.editReply({ embeds: [gachaLoadingEmbed(3)] });
      await new Promise(r => setTimeout(r, 1500));
      if (count === 1) {
        const result = rollGacha(1)[0];
        const isNew = !player.owned.includes(result);
        if (isNew) { player.owned.push(result); player.mastery[result] = 0; }
        else player.crystals += 50;
        await interaction.editReply({ embeds: [gachaRevealEmbed(CHARACTERS[result].grade), gachaResultEmbed(result, isNew, player)] });
      } else {
        const results = rollGacha(10);
        const dup = results.filter(id => player.owned.includes(id)).length * 50;
        const newOnes = results.filter(id => !player.owned.includes(id));
        for (const id of newOnes) { player.owned.push(id); player.mastery[id] = 0; }
        player.crystals += dup;
        await interaction.editReply({ embeds: [gacha10ResultEmbed(results, newOnes, dup, player)] });
      }
      savePlayer(userId);
    }
    if (commandName === "코가네가챠") {
      if (player.crystals < 200) return interaction.reply({ content: "💎 부족! (200💎 필요)", ephemeral: true });
      player.crystals -= 200;
      player.koganeGachaCount++;
      await interaction.reply({ embeds: [koganeLoadingEmbed(1)] });
      await new Promise(r => setTimeout(r, 1500));
      await interaction.editReply({ embeds: [koganeLoadingEmbed(2)] });
      await new Promise(r => setTimeout(r, 1500));
      await interaction.editReply({ embeds: [koganeLoadingEmbed(3)] });
      await new Promise(r => setTimeout(r, 1500));
      const grade = rollKogane();
      const gradeOrder = ["3급", "2급", "1급", "특급", "전설"];
      const isUpgrade = !player.kogane || gradeOrder.indexOf(grade) > gradeOrder.indexOf(player.kogane.grade);
      if (isUpgrade) player.kogane = { grade };
      else player.crystals += 50;
      savePlayer(userId);
      await interaction.editReply({ embeds: [koganeRevealEmbed(grade, isUpgrade, player)] });
    }
    if (commandName === "코가네") return interaction.reply({ embeds: [koganeProfileEmbed(player)] });
    if (commandName === "활성") {
      if (player.owned.length === 0) return interaction.reply({ content: "❌ 없음", ephemeral: true });
      return interaction.reply({ content: "🎭 캐릭터 선택 (이름으로 표시):", components: [mkCharSelectMenu(player, "char_select")] });
    }
    if (commandName === "도감") {
      const list = player.owned.map(id => {
        const c = CHARACTERS[id];
        const m = getMastery(player, id);
        const isActive = id === player.active;
        const domain = c.domain ? ` | 영역: ${c.domain}` : "";
        return `${isActive ? "▶️ **[활성]**" : "　"} ${c.emoji} **${c.name}** \`${c.grade}\` (숙련: ${m})${domain}`;
      }).join("\n");
      return interaction.reply({ embeds: [new EmbedBuilder().setTitle(`📖 도감 (${player.owned.length}/${Object.keys(CHARACTERS).length})`).setColor(0x7C5CFC).setDescription(list || "없음")] });
    }
    if (commandName === "출석") {
      const now = Date.now();
      if (now - (player.lastDaily || 0) < 86400000) return interaction.reply({ content: "⏰ 아직", ephemeral: true });
      const bonus = 100 + Math.min(player.dailyStreak || 0, 30) * 5;
      player.crystals += bonus;
      player.lastDaily = now;
      player.dailyStreak = (player.dailyStreak || 0) + 1;
      savePlayer(userId);
      return interaction.reply({ content: `✅ +${bonus}💎 (${player.dailyStreak}일 연속)` });
    }
    if (commandName === "회복") {
      if (player.potion <= 0) return interaction.reply({ content: "❌ 없음", ephemeral: true });
      const stats = getPlayerStats(player);
      player.hp = stats.maxHp;
      player.potion--;
      savePlayer(userId);
      return interaction.reply({ content: `💚 회복! 남은: ${player.potion}개` });
    }
    if (commandName === "손가락") {
      const f = player.sukunaFingers || 0;
      return interaction.reply({ content: `👹 스쿠나 손가락: ${f}/${SUKUNA_FINGER_MAX}\n${getFingerBonus(f).label}` });
    }
    if (commandName === "컬링") {
      if (cullings[userId]) return interaction.reply({ content: "🌊 이미 진행 중", ephemeral: true });
      const first = pickCullingEnemy(1);
      cullings[userId] = { wave: 1, kills: 0, totalXp: 0, totalCrystals: 0, currentEnemy: first, enemyHp: first.hp };
      return interaction.reply({ embeds: [cullingEmbed(player, cullings[userId])], components: mkCullingButtons(player) });
    }
    if (commandName === "사멸회유") {
      if (jujutsus[userId]) return interaction.reply({ content: "🎯 이미 진행 중", ephemeral: true });
      const choices = generateJujutsuChoices(1);
      jujutsus[userId] = { wave: 1, points: 0, totalXp: 0, totalCrystals: 0, choices, currentEnemy: null, enemyHp: 0 };
      return interaction.reply({ embeds: [jujutsuEmbed(player, jujutsus[userId], [], choices)], components: mkJujutsuButtons(player, choices) });
    }
    if (commandName === "결투") {
      const target = interaction.options.getUser("대상");
      if (target.id === userId) return interaction.reply({ content: "❌ 자신과 불가", ephemeral: true });
      if (getPvpSessionByUser(userId) || getPvpSessionByUser(target.id)) return interaction.reply({ content: "❌ 이미 PvP 중", ephemeral: true });
      if (!players[target.id]) return interaction.reply({ content: "❌ 상대방이 게임을 시작하지 않음", ephemeral: true });
      pvpChallenges[userId] = { target: target.id };
      const challenger = player;
      const ch1 = CHARACTERS[challenger.active];
      const chTarget = CHARACTERS[players[target.id].active];
      const s1 = getPlayerStats(challenger);
      const s2 = getPlayerStats(players[target.id]);
      const embed = new EmbedBuilder().setTitle("⚔️ PvP 결투 신청").setColor(0xF5C842)
        .setDescription([
          `${target}님, **${user.username}**님이 결투를 신청했습니다!`,
          `> 도전자: ${ch1.emoji} **${ch1.name}** \`[${ch1.grade}]\` | HP: ${s1.maxHp} ATK: ${s1.atk}`,
          `> 상대방: ${chTarget.emoji} **${chTarget.name}** \`[${chTarget.grade}]\` | HP: ${s2.maxHp} ATK: ${s2.atk}`,
        ].join("\n")).setFooter({ text: "30초 내 수락/거절" });
      const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`pvp_challenge_accept_${userId}`).setLabel("✅ 수락").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`pvp_challenge_decline_${userId}`).setLabel("❌ 거절").setStyle(ButtonStyle.Danger)
      );
      await interaction.reply({ content: `${target}`, embeds: [embed], components: [buttons] });
      setTimeout(() => { if (pvpChallenges[userId]) delete pvpChallenges[userId]; }, 30000);
    }
    if (commandName === "파티생성") {
      if (getPartyId(userId)) return interaction.reply({ content: "❌ 이미 파티 있음", ephemeral: true });
      parties[`${_partyIdSeq++}`] = { id: `${_partyIdSeq-1}`, leader: userId, members: [userId] };
      return interaction.reply({ content: "✅ 파티 생성! (1/4명)" });
    }
    if (commandName === "파티초대") {
      const target = interaction.options.getUser("대상");
      const party = getParty(userId);
      if (!party) return interaction.reply({ content: "❌ 파티 없음", ephemeral: true });
      if (party.leader !== userId) return interaction.reply({ content: "❌ 파티장만 가능", ephemeral: true });
      if (party.members.length >= 4) return interaction.reply({ content: "❌ 가득참", ephemeral: true });
      if (getPartyId(target.id)) return interaction.reply({ content: "❌ 대상이 이미 파티 소속", ephemeral: true });
      partyInvites[target.id] = { partyId: party.id };
      const btn = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`party_invite_accept_${party.id}`).setLabel("✅ 수락").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`party_invite_decline_${party.id}`).setLabel("❌ 거절").setStyle(ButtonStyle.Danger)
      );
      await interaction.reply({ content: `${target}`, components: [btn] });
      setTimeout(() => delete partyInvites[target.id], 60000);
    }
    if (commandName === "파티나가기") {
      const party = getParty(userId);
      if (!party) return interaction.reply({ content: "❌ 파티 없음", ephemeral: true });
      party.members = party.members.filter(id => id !== userId);
      if (party.members.length === 0) delete parties[party.id];
      else if (party.leader === userId) party.leader = party.members[0];
      return interaction.reply({ content: "✅ 파티 탈퇴" });
    }
    if (commandName === "파티컬링") {
      const party = getParty(userId);
      if (!party) return interaction.reply({ content: "❌ 파티 없음", ephemeral: true });
      if (party.leader !== userId) return interaction.reply({ content: "❌ 파티장만 가능", ephemeral: true });
      if (cullings[party.id]) return interaction.reply({ content: "🌊 이미 진행", ephemeral: true });
      const first = pickCullingEnemy(1);
      cullings[party.id] = { wave: 1, kills: 0, totalXp: 0, totalCrystals: 0, currentEnemy: first, enemyHp: first.hp };
      return interaction.reply({ embeds: [partyCullingEmbed(party, cullings[party.id])], components: mkCullingButtons(player) });
    }
    if (commandName === "레이드") {
      const bossId = interaction.options.getString("보스").toLowerCase();
      if (!RAID_BOSSES[bossId]) return interaction.reply({ content: "❌ heian_sukuna 또는 mahoraga", ephemeral: true });
      if (getRaidByUser(userId)) return interaction.reply({ content: "❌ 이미 레이드 중", ephemeral: true });
      const party = getParty(userId);
      const members = party ? [...party.members] : [userId];
      const boss = RAID_BOSSES[bossId];
      const raidId = `raid_${_raidIdSeq++}`;
      raidSessions[raidId] = { 
        id: raidId, bossId, hp: boss.hp, members, enraged: false, 
        adaptedSkills: [] 
      };
      for (const uid of members) {
        const p = players[uid];
        if (p && p.hp <= 0) {
          const stats = getPlayerStats(p);
          p.hp = Math.floor(stats.maxHp * 0.5);
          savePlayer(uid);
        }
      }
      return interaction.reply({ embeds: [new EmbedBuilder().setTitle(`🔥 레이드: ${boss.name}`).setColor(boss.color).setDescription(`💚 HP: ${boss.hp} | 🗡️ ATK: ${boss.atk} | 🛡️ DEF: ${boss.def}\n👥 참여: ${members.length}명`), raidEmbed(raidSessions[raidId])], components: mkRaidButtons(player) });
    }
    if (commandName === "코드") {
      const code = interaction.options.getString("코드").toLowerCase();
      if (player.usedCodes.includes(code)) return interaction.reply({ content: "❌ 사용함", ephemeral: true });
      if (CODES[code]) {
        player.crystals += CODES[code].crystals;
        player.usedCodes.push(code);
        savePlayer(userId);
        return interaction.reply({ content: `✅ +${CODES[code].crystals}💎` });
      }
      return interaction.reply({ content: "❌ 유효하지 않음", ephemeral: true });
    }
    if (commandName === "퀘스트") return interaction.reply({ embeds: [new EmbedBuilder().setTitle("📋 퀘스트").setColor(0x7C5CFC).setDescription("준비중")] });
    if (commandName === "재료") {
      const mats = player.materials || {};
      const text = Object.entries(MATERIALS).map(([k, v]) => `${v.emoji} ${k}: ${mats[k] || 0}`).join("\n");
      return interaction.reply({ embeds: [new EmbedBuilder().setTitle("📦 재료").setDescription(text || "없음")] });
    }
    if (commandName === "주구목록") {
      const text = Object.values(WEAPONS).map(w => `${w.emoji} ${w.name} (ATK+${w.atkBonus})`).join("\n");
      return interaction.reply({ embeds: [new EmbedBuilder().setTitle("⚔️ 주구 목록").setDescription(text)] });
    }
    if (commandName === "주구제작") {
      const name = interaction.options.getString("이름");
      const w = getWeaponByName(name);
      if (!w) return interaction.reply({ content: "❌ 없음", ephemeral: true });
      if ((player.craftedWeapons || []).includes(w.id)) return interaction.reply({ content: "❌ 이미 제작함", ephemeral: true });
      const mats = player.materials || {};
      for (const [mat, qty] of Object.entries(w.recipe)) {
        if ((mats[mat] || 0) < qty) return interaction.reply({ content: `❌ ${mat} 부족`, ephemeral: true });
      }
      for (const [mat, qty] of Object.entries(w.recipe)) mats[mat] -= qty;
      if (!player.craftedWeapons) player.craftedWeapons = [];
      player.craftedWeapons.push(w.id);
      updateQuestProgress(player, "weapon_craft", 1);
      savePlayer(userId);
      return interaction.reply({ content: `✅ ${w.name} 제작 완료!` });
    }
    if (commandName === "장착") {
      const name = interaction.options.getString("이름");
      const w = getWeaponByName(name);
      if (!w) return interaction.reply({ content: "❌ 없음", ephemeral: true });
      if (!(player.craftedWeapons || []).includes(w.id)) return interaction.reply({ content: "❌ 미제작", ephemeral: true });
      player.equippedWeapon = w.name;
      savePlayer(userId);
      return interaction.reply({ content: `✅ ${w.name} 장착! ATK+${w.atkBonus}` });
    }
    if (commandName === "해제") {
      player.equippedWeapon = null;
      savePlayer(userId);
      return interaction.reply({ content: "✅ 해제됨" });
    }
    if (commandName === "도움말") {
      return interaction.reply({ embeds: [new EmbedBuilder().setTitle("🔱 주술회전 RPG 명령어").setColor(0xF5C842).setDescription(
        "**⚔️ 전투**\n`/전투` `/컬링` `/사멸회유` `/레이드` `/결투`\n\n**🎭 캐릭터**\n`/활성` `/도감` `/가챠` `/술식` `/손가락` `/스킬선택`\n\n**🐾 펫**\n`/코가네가챠` `/코가네`\n\n**⚔️ 주구**\n`/재료` `/주구목록` `/주구제작` `/장착` `/해제`\n\n**👥 파티**\n`/파티생성` `/파티초대` `/파티나가기` `/파티컬링`\n\n**📋 기타**\n`/프로필` `/출석` `/회복` `/코드` `/도움말` `/개발자패널`\n\n!코가네가챠10 - 코가네 10연차\n\n⭐ **흑섬**: 10% 확률 → 2.5배 +50💎\n🌌 **영역전개**: 15턴 쿨다운 (전투/컬링/레이드/PvP 모두 가능)\n♻️ **반전술식**: 3턴 쿨다운 (고조/유타/스쿠나/하카리)"
      )] });
    }
    if (commandName === "개발자패널" && isDev(userId)) {
      return interaction.reply({ embeds: [new EmbedBuilder().setTitle("🛠️ 개발자 패널").setColor(0xFF0000).setDescription(
        "**개발자 전용 명령어**\n" +
        "> `!쿨다운초기화` - 모든 쿨다운 초기화\n" +
        "> `!아이템지급 [아이템] [수량]` - 아이템 지급\n" +
        "> `!전체저장` - 전체 플레이어 데이터 저장\n" +
        "> `!플레이어정보 [@유저]` - 플레이어 정보 확인\n\n" +
        "**사용 가능한 아이템**\n" +
        "> 크리스탈, 회복약, 손가락, 저주 실, 저주 뼈, 저주 핵, 저주 수정, 철 파편, 영혼 정수, 용 비늘"
      )], ephemeral: true });
    }
  }
});

// ════════════════════════════════════════════════════════
// ── ! 명령어 핸들러
// ════════════════════════════════════════════════════════
client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.content.startsWith("!")) return;
  const args = message.content.slice(1).trim().split(/\s+/);
  const cmd = args[0].toLowerCase();
  const player = getPlayer(message.author.id, message.author.username);

  // !전투
  if (cmd === "전투") {
    if (battles[message.author.id]) return message.reply("❌ 이미 전투 중!");
    const eBase = Math.random() < 0.05 ? ENEMIES.find(e => e.id === "e_sukuna") : ENEMIES[Math.floor(Math.random() * 3)];
    const enemy = { ...eBase, currentHp: eBase.hp, statusEffects: [] };
    battles[message.author.id] = { enemy };
    return message.reply({ embeds: [new EmbedBuilder().setTitle(eBase.isSukuna ? "🔴 스쿠나 출현!" : "⚔️ 전투!").setDescription(`**${enemy.emoji} ${enemy.name}** 등장!`)], components: mkBattleButtons(player) });
  }
  
  // !컬링
  if (cmd === "컬링") {
    if (cullings[message.author.id]) return message.reply("🌊 이미 진행 중!");
    const first = pickCullingEnemy(1);
    cullings[message.author.id] = { wave: 1, kills: 0, totalXp: 0, totalCrystals: 0, currentEnemy: first, enemyHp: first.hp };
    return message.reply({ embeds: [cullingEmbed(player, cullings[message.author.id])], components: mkCullingButtons(player) });
  }
  
  // !사멸회유
  if (cmd === "사멸회유") {
    if (jujutsus[message.author.id]) return message.reply("🎯 이미 진행 중!");
    const choices = generateJujutsuChoices(1);
    jujutsus[message.author.id] = { wave: 1, points: 0, totalXp: 0, totalCrystals: 0, choices, currentEnemy: null, enemyHp: 0 };
    return message.reply({ embeds: [jujutsuEmbed(player, jujutsus[message.author.id], [], choices)], components: mkJujutsuButtons(player, choices) });
  }
  
  // !가챠 / !가챠10
  if (cmd === "가챠" || cmd === "가챠10") {
    const count = cmd === "가챠10" ? 10 : (parseInt(args[1]) || 1);
    if (count !== 1 && count !== 10) return message.reply("❌ 1 또는 10");
    const cost = count === 1 ? 150 : 1350;
    if (player.crystals < cost) return message.reply(`💎 부족! 필요: ${cost}`);
    player.crystals -= cost;
    const loading = await message.reply({ embeds: [gachaLoadingEmbed(1)] });
    await new Promise(r => setTimeout(r, 1500));
    await loading.edit({ embeds: [gachaLoadingEmbed(2)] });
    await new Promise(r => setTimeout(r, 1500));
    await loading.edit({ embeds: [gachaLoadingEmbed(3)] });
    await new Promise(r => setTimeout(r, 1500));
    if (count === 1) {
      const result = rollGacha(1)[0];
      const isNew = !player.owned.includes(result);
      if (isNew) { player.owned.push(result); player.mastery[result] = 0; }
      else player.crystals += 50;
      await loading.edit({ embeds: [gachaRevealEmbed(CHARACTERS[result].grade), gachaResultEmbed(result, isNew, player)] });
    } else {
      const results = rollGacha(10);
      const dup = results.filter(id => player.owned.includes(id)).length * 50;
      const newOnes = results.filter(id => !player.owned.includes(id));
      for (const id of newOnes) { player.owned.push(id); player.mastery[id] = 0; }
      player.crystals += dup;
      await loading.edit({ embeds: [gacha10ResultEmbed(results, newOnes, dup, player)] });
    }
    savePlayer(message.author.id);
  }
  
  // !코가네가챠10 (10회 뽑기)
  if (cmd === "코가네가챠10" || cmd === "코가네10회") {
    if (player.crystals < 2000) return message.reply(`💎 부족! 2000💎 필요 (현재: ${player.crystals})`);
    player.crystals -= 2000;
    player.koganeGachaCount = (player.koganeGachaCount || 0) + 10;
    const loading = await message.reply({ embeds: [koganeLoadingEmbed(1)] });
    await new Promise(r => setTimeout(r, 1500));
    await loading.edit({ embeds: [koganeLoadingEmbed(2)] });
    await new Promise(r => setTimeout(r, 1500));
    await loading.edit({ embeds: [koganeLoadingEmbed(3)] });
    await new Promise(r => setTimeout(r, 1500));
    const results = [];
    for (let i = 0; i < 10; i++) results.push(rollKogane());
    const gradeOrder = ["3급", "2급", "1급", "특급", "전설"];
    let best = player.kogane?.grade || "3급";
    let refund = 0;
    for (const g of results) {
      if (gradeOrder.indexOf(g) > gradeOrder.indexOf(best)) best = g;
      else refund += 50;
    }
    if (best !== (player.kogane?.grade || "3급")) player.kogane = { grade: best };
    player.crystals += refund;
    savePlayer(message.author.id);
    await loading.edit({ embeds: [kogane10ResultEmbed(results, best, refund, player)] });
  }
  
  // !활성
  if (cmd === "활성") {
    if (player.owned.length === 0) return message.reply("❌ 없음");
    return message.reply({ content: "🎭 캐릭터 선택 (이름으로 표시):", components: [mkCharSelectMenu(player, "char_select")] });
  }
  
  // !도감
  if (cmd === "도감") {
    const list = player.owned.map(id => {
      const c = CHARACTERS[id];
      const m = getMastery(player, id);
      const isActive = id === player.active;
      const domain = c.domain ? ` | 영역: ${c.domain}` : "";
      return `${isActive ? "▶️ **[활성]**" : "　"} ${c.emoji} **${c.name}** \`${c.grade}\` (숙련: ${m})${domain}`;
    }).join("\n");
    return message.reply({ embeds: [new EmbedBuilder().setTitle(`📖 도감 (${player.owned.length}/${Object.keys(CHARACTERS).length})`).setColor(0x7C5CFC).setDescription(list || "없음")] });
  }
  
  // !스킬선택
  if (cmd === "스킬선택") {
    const num = parseInt(args[1]);
    const available = getAvailableSkills(player, player.active);
    if (isNaN(num) || num < 1 || num > available.length) return message.reply(`❌ 1~${available.length} 사이 입력`);
    player.selectedSkillIndex = num - 1;
    savePlayer(message.author.id);
    return message.reply(`✅ **${available[num-1].name}**(으)로 변경됨!`);
  }
  
  // !출석
  if (cmd === "출석") {
    const now = Date.now();
    if (now - (player.lastDaily || 0) < 86400000) return message.reply("⏰ 아직");
    const bonus = 100 + Math.min(player.dailyStreak || 0, 30) * 5;
    player.crystals += bonus;
    player.lastDaily = now;
    player.dailyStreak = (player.dailyStreak || 0) + 1;
    savePlayer(message.author.id);
    return message.reply(`✅ +${bonus}💎 (${player.dailyStreak}일 연속)`);
  }
  
  // !회복
  if (cmd === "회복") {
    if (player.potion <= 0) return message.reply("❌ 없음");
    const stats = getPlayerStats(player);
    player.hp = stats.maxHp;
    player.potion--;
    savePlayer(message.author.id);
    return message.reply(`💚 회복! 남은: ${player.potion}개`);
  }
  
  // !손가락
  if (cmd === "손가락") {
    const f = player.sukunaFingers || 0;
    return message.reply(`👹 스쿠나 손가락: ${f}/${SUKUNA_FINGER_MAX}\n${getFingerBonus(f).label}`);
  }
  
  // !재료
  if (cmd === "재료") {
    const mats = player.materials || {};
    const text = Object.entries(MATERIALS).map(([k, v]) => `${v.emoji} ${k}: ${mats[k] || 0}`).join("\n");
    return message.reply({ embeds: [new EmbedBuilder().setTitle("📦 재료").setDescription(text)] });
  }
  
  // !주구목록
  if (cmd === "주구목록") {
    const text = Object.values(WEAPONS).map(w => `${w.emoji} ${w.name} (ATK+${w.atkBonus})`).join("\n");
    return message.reply({ embeds: [new EmbedBuilder().setTitle("⚔️ 주구 목록").setDescription(text)] });
  }
  
  // !주구제작
  if (cmd === "주구제작") {
    const name = args.slice(1).join(" ");
    const w = getWeaponByName(name);
    if (!w) return message.reply("❌ 없음");
    const mats = player.materials || {};
    for (const [mat, qty] of Object.entries(w.recipe)) {
      if ((mats[mat] || 0) < qty) return message.reply(`❌ ${mat} 부족`);
    }
    for (const [mat, qty] of Object.entries(w.recipe)) mats[mat] -= qty;
    if (!player.craftedWeapons) player.craftedWeapons = [];
    player.craftedWeapons.push(w.id);
    updateQuestProgress(player, "weapon_craft", 1);
    savePlayer(message.author.id);
    return message.reply(`✅ ${w.name} 제작 완료!`);
  }
  
  // !장착
  if (cmd === "장착") {
    const name = args.slice(1).join(" ");
    const w = getWeaponByName(name);
    if (!w) return message.reply("❌ 없음");
    if (!(player.craftedWeapons || []).includes(w.id)) return message.reply("❌ 미제작");
    player.equippedWeapon = w.name;
    savePlayer(message.author.id);
    return message.reply(`✅ ${w.name} 장착! ATK+${w.atkBonus}`);
  }
  
  // !해제
  if (cmd === "해제") {
    player.equippedWeapon = null;
    savePlayer(message.author.id);
    return message.reply("✅ 해제됨");
  }
  
  // !코드
  if (cmd === "코드") {
    const code = args[1]?.toLowerCase();
    if (!code) return message.reply("!코드 [코드명]");
    if (player.usedCodes.includes(code)) return message.reply("❌ 사용함");
    if (CODES[code]) {
      player.crystals += CODES[code].crystals;
      player.usedCodes.push(code);
      savePlayer(message.author.id);
      return message.reply(`✅ +${CODES[code].crystals}💎`);
    }
    return message.reply("❌ 유효하지 않음");
  }
  
  // !도움말
  if (cmd === "도움말") {
    return message.reply([
      "🔱 **주술회전 RPG 명령어**",
      "",
      "⚔️ `!전투` - 일반 전투 (5% 확률 스쿠나)",
      "⚔️ `!컬링` - 컬링 게임",
      "⚔️ `!레이드 [보스]` - 레이드",
      "",
      "🎭 `!활성` - 캐릭터 변경 (이름으로 표시)",
      "🎭 `!도감` - 보유 캐릭터 목록",
      "🎭 `!가챠` / `!가챠10` - 캐릭터 소환",
      "🎭 `!술식` - 술식 확인",
      "🎭 `!스킬선택 [번호]` - 사용할 술식 변경",
      "🎭 `!손가락` - 스쿠나 손가락",
      "",
      "🐾 `!코가네가챠` - 1회 (200💎)",
      "🐾 `!코가네가챠10` - 10회 (2000💎)",
      "",
      "⚔️ `!재료` / `!주구목록`",
      "⚔️ `!주구제작 [이름]` / `!장착 [이름]` / `!해제`",
      "",
      "📋 `!출석` / `!회복` / `!코드`",
      "",
      "⭐ 흑섬: 10% 확률 → 2.5배 +50💎",
      "🌌 영역전개: 15턴 쿨다운 (전투/컬링/레이드/PvP 모두 가능)",
      "♻️ 반전술식: 3턴 쿨다운 (고조/유타/스쿠나/하카리)",
    ].join("\n"));
  }
  
  // ════════════════════════════════════════════════════════
  // ── 개발자 패널 명령어
  // ════════════════════════════════════════════════════════
  if (isDev(message.author.id)) {
    if (cmd === "쿨다운초기화") {
      player.skillCooldown = 0;
      player.reverseCooldown = 0;
      player.domainCooldown = 0;
      savePlayer(message.author.id);
      return message.reply("✅ 모든 쿨다운이 초기화되었습니다!");
    }
    
    if (cmd === "아이템지급") {
      const item = args[1];
      const amount = parseInt(args[2]) || 1;
      if (item === "크리스탈") player.crystals += amount;
      else if (item === "회복약") player.potion += amount;
      else if (item === "손가락") player.sukunaFingers = Math.min(SUKUNA_FINGER_MAX, (player.sukunaFingers || 0) + amount);
      else if (MATERIALS[item]) {
        if (!player.materials) player.materials = {};
        player.materials[item] = (player.materials[item] || 0) + amount;
      } else {
        return message.reply("❌ 아이템: 크리스탈, 회복약, 손가락, 저주 실, 저주 뼈, 저주 핵, 저주 수정, 철 파편, 영혼 정수, 용 비늘");
      }
      savePlayer(message.author.id);
      return message.reply(`✅ ${item} +${amount} 지급되었습니다!`);
    }
    
    if (cmd === "전체저장") {
      let count = 0;
      for (const uid of Object.keys(players)) {
        await dbSave(uid, players[uid]);
        count++;
      }
      return message.reply(`✅ ${count}명의 플레이어 데이터가 저장되었습니다!`);
    }
    
    if (cmd === "플레이어정보") {
      const target = message.mentions.users.first() || message.author;
      const p = players[target.id];
      if (!p) return message.reply("❌ 플레이어 정보 없음");
      const matSummary = Object.entries(p.materials || {}).filter(([, q]) => q > 0).map(([id, q]) => `${MATERIALS[id]?.emoji || ""}${q}`).join(" ") || "없음";
      return message.reply(`📊 **${p.name}**\n💎 ${p.crystals} 💎 | XP ${p.xp} | LV.${getLevel(p.xp)}\n🎭 ${CHARACTERS[p.active]?.name || p.active}\n⚔️ 전적: ${p.wins}승 ${p.losses}패\n🧪 회복약: ${p.potion}개\n👹 손가락: ${p.sukunaFingers || 0}개\n📦 재료: ${matSummary}\n⚔️ 장착: ${p.equippedWeapon || "없음"}\n🌌 영역CD: ${p.domainCooldown || 0}턴 | ♻️ 반전CD: ${p.reverseCooldown || 0}턴 | 🌀 술식CD: ${p.skillCooldown || 0}턴`);
    }
  }
});

client.login(TOKEN);
