require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const {
  Client, GatewayIntentBits, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
} = require("discord.js");

// ════════════════════════════════════════════════════════
// ── HTTP 헬스체크 (Railway)
// ════════════════════════════════════════════════════════
const app = express();
app.get("/", (_, res) => res.send("🔱 주술회전 RPG 봇 가동 중"));
app.get("/health", (_, res) => res.json({ status: "ok", uptime: process.uptime() }));
app.listen(process.env.PORT || 3000, () => console.log(`🌐 HTTP 포트 ${process.env.PORT || 3000}`));

// ════════════════════════════════════════════════════════
// ── PostgreSQL 연결
// ════════════════════════════════════════════════════════
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway") ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => console.error("PostgreSQL 풀 오류:", err.message));

async function dbInit() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS players (
        user_id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log("✅ PostgreSQL 테이블 준비 완료");
  } catch (e) {
    console.log("⚠️ DB 연결 실패, 메모리 모드로 실행");
  }
}

async function dbLoad() {
  try {
    const res = await pool.query("SELECT user_id, data FROM players");
    const obj = {};
    for (const row of res.rows) obj[row.user_id] = row.data;
    console.log(`✅ DB 로드: ${res.rows.length}명`);
    return obj;
  } catch (e) {
    console.log("⚠️ DB 로드 실패, 빈 데이터로 시작");
    return {};
  }
}

const saveQueue = new Map();
const savePending = new Set();

async function dbSave(userId, data) {
  try {
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO players(user_id, data, updated_at) VALUES($1,$2,NOW())
         ON CONFLICT(user_id) DO UPDATE SET data=$2, updated_at=NOW()`,
        [userId, JSON.stringify(data)]
      );
    } finally {
      client.release();
    }
  } catch (e) {
    console.error(`DB 저장 오류 [${userId}]:`, e.message);
  }
}

function savePlayer(userId) {
  if (!players[userId]) return;
  if (saveQueue.has(userId)) clearTimeout(saveQueue.get(userId));
  const timer = setTimeout(async () => {
    saveQueue.delete(userId);
    if (savePending.has(userId)) { savePlayer(userId); return; }
    savePending.add(userId);
    try {
      await dbSave(userId, players[userId]);
    } catch (e) {
      console.error(`DB 저장 오류 [${userId}]:`, e.message);
      setTimeout(() => savePlayer(userId), 5000);
    } finally {
      savePending.delete(userId);
    }
  }, 300);
  saveQueue.set(userId, timer);
}

async function savePlayerNow(userId) {
  if (!players[userId]) return;
  if (saveQueue.has(userId)) { clearTimeout(saveQueue.get(userId)); saveQueue.delete(userId); }
  savePending.add(userId);
  try {
    await dbSave(userId, players[userId]);
  } catch (e) {
    console.error(`즉시 저장 오류 [${userId}]:`, e.message);
    setTimeout(() => savePlayer(userId), 3000);
  } finally {
    savePending.delete(userId);
  }
}

setInterval(async () => {
  const uids = Object.keys(players);
  for (const uid of uids) {
    if (!saveQueue.has(uid) && !savePending.has(uid)) {
      try { await dbSave(uid, players[uid]); }
      catch (e) { console.error(`주기저장 오류 [${uid}]:`, e.message); }
    }
  }
}, 3 * 60 * 1000);

// ════════════════════════════════════════════════════════
// ── Discord 클라이언트
// ════════════════════════════════════════════════════════
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});
const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) { console.error("❌ DISCORD_TOKEN 없음!"); process.exit(1); }

const DEV_IDS = new Set(["1284771557633425470", "1397218266505678881"]);
const isDev = (id) => DEV_IDS.has(id);

// ════════════════════════════════════════════════════════
// ── 등급/색상 데이터
// ════════════════════════════════════════════════════════
const JJK_GRADE_COLOR = {
  "특급": 0xF5C842, "준특급": 0xff8c00,
  "1급": 0x7C5CFC, "준1급": 0x9b72cf,
  "2급": 0x4ade80, "3급": 0x94a3b8, "4급": 0x64748b,
};
const JJK_GRADE_EMOJI = {
  "특급": "🔱", "준특급": "💠",
  "1급": "⭐⭐", "준1급": "⭐",
  "2급": "🔹🔹", "3급": "🔹", "4급": "◽",
};
const JJK_GRADE_LABEL = {
  "특급": "【 특 급 】", "준특급": "【준특급】",
  "1급": "【 1 급 】", "준1급": "【준 1급】",
  "2급": "【 2 급 】", "3급": "【 3 급 】", "4급": "【 4 급 】",
};

// ════════════════════════════════════════════════════════
// ── 상태이상
// ════════════════════════════════════════════════════════
const STATUS_EFFECTS = {
  poison: { id: "poison", name: "독", emoji: "☠️", desc: "매 턴 최대HP의 5% 피해", duration: 3 },
  burn: { id: "burn", name: "화상", emoji: "🔥", desc: "매 턴 최대HP의 8% 피해", duration: 2 },
  freeze: { id: "freeze", name: "빙결", emoji: "❄️", desc: "1턴 행동 불가", duration: 1 },
  weaken: { id: "weaken", name: "약화", emoji: "💔", desc: "공격력 30% 감소", duration: 2 },
  stun: { id: "stun", name: "기절", emoji: "⚡", desc: "1턴 행동 불가", duration: 1 },
  battleInstinct: { id: "battleInstinct", name: "전투본능", emoji: "🔥💪", desc: "공격력 40% 증가, 회피율 25% 증가", duration: 3 },
  // ── 새 상태이상: 타락
  corruption: { id: "corruption", name: "타락", emoji: "🖤", desc: "매 턴 ATK+5% 누적, 최대HP 감소 위험", duration: 5 },
  cursedArmor: { id: "cursedArmor", name: "저주갑옷", emoji: "🔰", desc: "DEF+20%, 하지만 회복 불가", duration: 3 },
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
    if (se.id === "burn") { const d = Math.max(1, Math.floor(maxHp * 0.08)); totalDmg += d; log.push(`${def.emoji} **${def.name}** — **${d}** 피해!`); }
    if (se.id === "corruption") { const d = Math.max(1, Math.floor(maxHp * 0.03)); totalDmg += d; log.push(`${def.emoji} **${def.name}** — **${d}** 타락 피해!`); }
    se.turns--;
    if (se.turns <= 0) expired.push(se.id);
  }
  target.statusEffects = target.statusEffects.filter(s => s.turns > 0);
  if (totalDmg > 0) target.hp = Math.max(0, (target.hp || 0) - totalDmg);
  return { dmg: totalDmg, expired, log };
}

function statusStr(se) {
  if (!se || se.length === 0) return "없음";
  return se.map(s => `${STATUS_EFFECTS[s.id]?.emoji || ""}${STATUS_EFFECTS[s.id]?.name || s.id}(${s.turns}턴)`).join(" ");
}
function isIncapacitated(se) { return !!(se && se.some(s => s.id === "freeze" || s.id === "stun")); }
function getWeakenMult(se) {
  let mult = 1;
  if (se && se.some(s => s.id === "weaken")) mult *= 0.7;
  if (se && se.some(s => s.id === "battleInstinct")) mult *= 1.4;
  // 타락 스택: 최대 25% 추가 공격
  const corruptSe = se && se.find(s => s.id === "corruption");
  if (corruptSe) mult *= (1 + (5 - corruptSe.turns) * 0.05);
  return mult;
}
function getDefMult(se) {
  let mult = 1;
  if (se && se.some(s => s.id === "cursedArmor")) mult *= 1.2;
  return mult;
}
function getBattleInstinctEvade(se) { return !!(se && se.some(s => s.id === "battleInstinct")); }

function rollHit(defenderStatusEffects) {
  const baseEvade = 0.05;
  const instinctBonus = getBattleInstinctEvade(defenderStatusEffects) ? 0.25 : 0;
  return Math.random() > (baseEvade + instinctBonus);
}

// ════════════════════════════════════════════════════════
// ── 흑섬 크리티컬 타이밍 시스템
// ════════════════════════════════════════════════════════
// 흑섬은 연속 성공 스택으로 발동 확률 증가
function checkBlazeOfBlack(player) {
  const stack = player.blazeStack || 0;
  // 기본 5% + 스택당 3% (최대 30%)
  const chance = Math.min(0.30, 0.05 + stack * 0.03);
  if (Math.random() < chance) {
    player.blazeStack = 0; // 발동 시 초기화
    return true;
  }
  player.blazeStack = Math.min(10, stack + 1); // 스택 증가
  return false;
}

// ════════════════════════════════════════════════════════
// ── 스쿠나 손가락 시스템
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
          fingers >= 5 ? "🟡 스쿠나 각성 Lv.2" :
            fingers >= 1 ? "🟢 스쿠나 각성 Lv.1" : "스쿠나 봉인 중",
  };
}

// ════════════════════════════════════════════════════════
// ── 코가네(황금 개) 펫 시스템
// ════════════════════════════════════════════════════════
const KOGANE_GRADES = {
  "전설": {
    color: 0xF5C842, emoji: "🌟", stars: "★★★★★", rate: 0.5,
    atkBonus: 0.25, defBonus: 0.20, hpBonus: 0.20, xpBonus: 0.30, crystalBonus: 0.25,
    skill: "황금 포효", skillDesc: "전투 시작 시 적에게 추가 피해 (ATK의 50%)", skillChance: 0.35,
    passiveDesc: "ATK+25% DEF+20% HP+20% XP+30% 크리스탈+25%",
  },
  "특급": {
    color: 0xff8c00, emoji: "🔶", stars: "★★★★☆", rate: 2.0,
    atkBonus: 0.18, defBonus: 0.15, hpBonus: 0.15, xpBonus: 0.20, crystalBonus: 0.18,
    skill: "황금 이빨", skillDesc: "공격 시 15% 확률로 약화 부여", skillChance: 0.15,
    passiveDesc: "ATK+18% DEF+15% HP+15% XP+20% 크리스탈+18%",
  },
  "1급": {
    color: 0x7C5CFC, emoji: "🔷", stars: "★★★☆☆", rate: 8.0,
    atkBonus: 0.12, defBonus: 0.10, hpBonus: 0.10, xpBonus: 0.12, crystalBonus: 0.10,
    skill: "황금 발톱", skillDesc: "공격 시 10% 확률로 추가타 (ATK의 30%)", skillChance: 0.10,
    passiveDesc: "ATK+12% DEF+10% HP+10% XP+12% 크리스탈+10%",
  },
  "2급": {
    color: 0x4ade80, emoji: "🟢", stars: "★★☆☆☆", rate: 22.5,
    atkBonus: 0.07, defBonus: 0.06, hpBonus: 0.06, xpBonus: 0.07, crystalBonus: 0.06,
    skill: "황금 보호막", skillDesc: "HP 30% 이하 시 1회 피해 50% 감소", skillChance: 1.0,
    passiveDesc: "ATK+7% DEF+6% HP+6% XP+7% 크리스탈+6%",
  },
  "3급": {
    color: 0x94a3b8, emoji: "⚪", stars: "★☆☆☆☆", rate: 67.0,
    atkBonus: 0.03, defBonus: 0.02, hpBonus: 0.02, xpBonus: 0.03, crystalBonus: 0.02,
    skill: "황금 냄새", skillDesc: "전투 후 크리스탈 +5% 추가 획득", skillChance: 1.0,
    passiveDesc: "ATK+3% DEF+2% HP+2% XP+3% 크리스탈+2%",
  },
};

const KOGANE_POOL = [
  { grade: "전설", rate: 0.5 },
  { grade: "특급", rate: 2.0 },
  { grade: "1급", rate: 8.0 },
  { grade: "2급", rate: 22.5 },
  { grade: "3급", rate: 67.0 },
];

function rollKogane() {
  const total = KOGANE_POOL.reduce((s, p) => s + p.rate, 0);
  let roll = Math.random() * total;
  for (const e of KOGANE_POOL) { roll -= e.rate; if (roll <= 0) return e.grade; }
  return "3급";
}

function getKoganeBonus(player) {
  if (!player.kogane || !player.kogane.grade) return { atk: 1, def: 1, hp: 1, xp: 1, crystal: 1 };
  const g = KOGANE_GRADES[player.kogane.grade];
  if (!g) return { atk: 1, def: 1, hp: 1, xp: 1, crystal: 1 };
  return {
    atk: 1 + g.atkBonus,
    def: 1 + g.defBonus,
    hp: 1 + g.hpBonus,
    xp: 1 + g.xpBonus,
    crystal: 1 + g.crystalBonus,
  };
}

// ════════════════════════════════════════════════════════
// ── 저주 축적 (타락) 시스템
// ════════════════════════════════════════════════════════
const CORRUPTION_MAX = 100;
function addCorruption(player, amount) {
  player.corruption = Math.min(CORRUPTION_MAX, (player.corruption || 0) + amount);
  // 타락 50 이상: 자동으로 타락 상태이상 부여
  if (player.corruption >= 50 && !player.statusEffects.find(s => s.id === "corruption")) {
    applyStatus(player, "corruption");
  }
  // 타락 100: 페널티
  if (player.corruption >= CORRUPTION_MAX) {
    player.corruption = 0;
    const maxHp = getPlayerStats(player).maxHp;
    player.hp = Math.max(1, Math.floor(player.hp * 0.5));
    return { triggered: true, msg: "💀 **저주 과부하!** HP가 절반으로 감소했습니다!" };
  }
  return { triggered: false, msg: null };
}

function getCorruptionLabel(corruption) {
  if (corruption >= 80) return "🔴 위험";
  if (corruption >= 50) return "🟠 경계";
  if (corruption >= 25) return "🟡 축적";
  return "🟢 안전";
}

// ════════════════════════════════════════════════════════
// ── 주구(장비) 제작 시스템
// ════════════════════════════════════════════════════════
const EQUIPMENT_BLUEPRINTS = {
  "저주의 반지": {
    id: "저주의 반지", emoji: "💍", slot: "accessory",
    atkBonus: 15, defBonus: 0, hpBonus: 0,
    desc: "저주 에너지를 담은 반지. ATK +15",
    materials: { "저주 결정": 3, "철 파편": 2 },
    grade: "2급",
  },
  "강화 부적": {
    id: "강화 부적", emoji: "📿", slot: "accessory",
    atkBonus: 5, defBonus: 10, hpBonus: 200,
    desc: "방어력을 높이는 부적. DEF +10, HP +200",
    materials: { "저주 결정": 2, "마력 실": 3 },
    grade: "2급",
  },
  "스쿠나의 문신": {
    id: "스쿠나의 문신", emoji: "🔴", slot: "body",
    atkBonus: 30, defBonus: 5, hpBonus: 300,
    desc: "스쿠나의 힘을 담은 문신. ATK +30, DEF +5, HP +300",
    materials: { "저주 결정": 5, "스쿠나 파편": 2, "마력 실": 3 },
    grade: "1급",
  },
  "고조의 안대": {
    id: "고조의 안대", emoji: "🩹", slot: "head",
    atkBonus: 20, defBonus: 20, hpBonus: 500,
    desc: "무한을 차단하는 안대. 모든 스탯 강화",
    materials: { "저주 결정": 8, "마력 실": 5, "빛의 결정": 2 },
    grade: "준1급",
  },
  "저주 도구 세트": {
    id: "저주 도구 세트", emoji: "⚔️", slot: "weapon",
    atkBonus: 40, defBonus: 0, hpBonus: 0,
    desc: "강력한 저주 도구 세트. ATK +40",
    materials: { "저주 결정": 6, "철 파편": 5, "스쿠나 파편": 1 },
    grade: "준1급",
  },
  "육안봉인 면": {
    id: "육안봉인 면", emoji: "🎭", slot: "face",
    atkBonus: 50, defBonus: 30, hpBonus: 800,
    desc: "특급 주술사 전용 봉인 면. 최강급 강화",
    materials: { "저주 결정": 15, "스쿠나 파편": 5, "빛의 결정": 5, "마력 실": 8 },
    grade: "특급",
  },
};

const MATERIALS = ["저주 결정", "철 파편", "마력 실", "스쿠나 파편", "빛의 결정"];
const MATERIAL_DROP_TABLE = {
  "저급 저주령": { "저주 결정": 0.4, "철 파편": 0.3 },
  "1급 저주령": { "저주 결정": 0.6, "철 파편": 0.4, "마력 실": 0.3 },
  "특급 저주령": { "저주 결정": 0.8, "마력 실": 0.5, "스쿠나 파편": 0.2 },
  "저주의 왕 (보스)": { "저주 결정": 1.0, "스쿠나 파편": 0.5, "빛의 결정": 0.3, "마력 실": 0.6 },
};
// 사멸회유 전용 재료 드롭
const JUJUTSU_MATERIAL_DROP = {
  "약화된 저주령": { "저주 결정": 0.3 },
  "중간급 저주령": { "저주 결정": 0.5, "철 파편": 0.3 },
  "강화 저주령": { "저주 결정": 0.5, "철 파편": 0.4 },
  "특수 저주령": { "저주 결정": 0.6, "마력 실": 0.3 },
  "엘리트 저주령": { "저주 결정": 0.7, "마력 실": 0.5, "스쿠나 파편": 0.15 },
  "사멸회유 수호자": { "저주 결정": 1.0, "마력 실": 0.6, "스쿠나 파편": 0.35, "빛의 결정": 0.2 },
};

function rollMaterialDrops(enemyName, table) {
  const drops = {};
  const dropTable = table[enemyName] || {};
  for (const [mat, chance] of Object.entries(dropTable)) {
    if (Math.random() < chance) {
      drops[mat] = (drops[mat] || 0) + 1;
    }
  }
  return drops;
}

function addMaterials(player, drops) {
  if (!player.materials) player.materials = {};
  for (const [mat, qty] of Object.entries(drops)) {
    player.materials[mat] = (player.materials[mat] || 0) + qty;
  }
}

function getMaterialStr(materials) {
  if (!materials || Object.keys(materials).length === 0) return "없음";
  return Object.entries(materials).map(([k, v]) => `${k} x${v}`).join(", ");
}

function hasMaterials(player, required) {
  if (!player.materials) return false;
  for (const [mat, qty] of Object.entries(required)) {
    if ((player.materials[mat] || 0) < qty) return false;
  }
  return true;
}

function consumeMaterials(player, required) {
  for (const [mat, qty] of Object.entries(required)) {
    player.materials[mat] -= qty;
    if (player.materials[mat] <= 0) delete player.materials[mat];
  }
}

function getEquipmentBonus(player) {
  if (!player.equipment) return { atk: 0, def: 0, hp: 0 };
  let atk = 0, def = 0, hp = 0;
  for (const itemId of Object.values(player.equipment)) {
    if (!itemId) continue;
    const bp = EQUIPMENT_BLUEPRINTS[itemId];
    if (bp) { atk += bp.atkBonus; def += bp.defBonus; hp += bp.hpBonus; }
  }
  return { atk, def, hp };
}

// ════════════════════════════════════════════════════════
// ── 주술고 임무 (일일/주간 퀘스트)
// ════════════════════════════════════════════════════════
const DAILY_QUESTS = [
  { id: "dq1", name: "저주령 처치 3회", type: "kill", target: 3, rewardCrystals: 80, rewardXp: 150, desc: "저주령을 3마리 처치하세요." },
  { id: "dq2", name: "컬링 WAVE 5 달성", type: "culling_wave", target: 5, rewardCrystals: 120, rewardXp: 200, desc: "컬링 게임에서 WAVE 5를 달성하세요." },
  { id: "dq3", name: "사멸회유 5포인트", type: "jujutsu_points", target: 5, rewardCrystals: 100, rewardXp: 180, desc: "사멸회유에서 5포인트를 획득하세요." },
  { id: "dq4", name: "술식 3회 사용", type: "skill_use", target: 3, rewardCrystals: 60, rewardXp: 120, desc: "전투에서 술식을 3번 사용하세요." },
  { id: "dq5", name: "재료 5개 수집", type: "material_collect", target: 5, rewardCrystals: 90, rewardXp: 160, desc: "재료를 5개 수집하세요." },
];

const WEEKLY_QUESTS = [
  { id: "wq1", name: "[주간] 저주령 20회 처치", type: "kill", target: 20, rewardCrystals: 500, rewardXp: 800, rewardMaterials: { "저주 결정": 5 }, desc: "저주령을 20마리 처치하세요." },
  { id: "wq2", name: "[주간] 컬링 WAVE 15 달성", type: "culling_wave", target: 15, rewardCrystals: 700, rewardXp: 1000, rewardMaterials: { "스쿠나 파편": 2 }, desc: "컬링 게임에서 WAVE 15를 달성하세요." },
  { id: "wq3", name: "[주간] PvP 3회 승리", type: "pvp_win", target: 3, rewardCrystals: 600, rewardXp: 900, rewardMaterials: { "빛의 결정": 1 }, desc: "PvP에서 3번 승리하세요." },
  { id: "wq4", name: "[주간] 장비 1개 제작", type: "craft", target: 1, rewardCrystals: 400, rewardXp: 700, rewardMaterials: { "마력 실": 3 }, desc: "장비를 1개 제작하세요." },
];

function getTodayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function getWeekKey() {
  const d = new Date();
  const start = new Date(d);
  start.setDate(d.getDate() - d.getDay());
  return `${start.getFullYear()}-${start.getMonth() + 1}-${start.getDate()}`;
}

function initDailyQuests(player) {
  const today = getTodayKey();
  if (!player.questData) player.questData = {};
  if (player.questData.dailyKey !== today) {
    // 3개 랜덤 선택
    const shuffled = [...DAILY_QUESTS].sort(() => Math.random() - 0.5).slice(0, 3);
    player.questData.dailyKey = today;
    player.questData.daily = shuffled.map(q => ({ ...q, progress: 0, completed: false, claimed: false }));
  }
}

function initWeeklyQuests(player) {
  const week = getWeekKey();
  if (!player.questData) player.questData = {};
  if (player.questData.weeklyKey !== week) {
    player.questData.weeklyKey = week;
    player.questData.weekly = WEEKLY_QUESTS.map(q => ({ ...q, progress: 0, completed: false, claimed: false }));
  }
}

function updateQuestProgress(player, type, amount = 1) {
  if (!player.questData) return;
  const allQuests = [
    ...(player.questData.daily || []),
    ...(player.questData.weekly || []),
  ];
  for (const q of allQuests) {
    if (q.type === type && !q.completed) {
      q.progress = Math.min(q.target, (q.progress || 0) + amount);
      if (q.progress >= q.target) q.completed = true;
    }
  }
}

// ════════════════════════════════════════════════════════
// ── 레이드 시스템
// ════════════════════════════════════════════════════════
const RAID_BOSSES = [
  {
    id: "rb1", name: "죠고 (레이드)", emoji: "🌋", grade: "준특급",
    hp: 50000, atk: 180, def: 90, xp: 2000, crystals: 500,
    statusAttack: { statusId: "burn", chance: 0.6 },
    desc: "화염을 다루는 준특급 저주령 레이드 보스!",
    materialReward: { "저주 결정": 8, "스쿠나 파편": 3, "빛의 결정": 2 },
    minParty: 2,
  },
  {
    id: "rb2", name: "마히토 (레이드)", emoji: "🩸", grade: "준특급",
    hp: 65000, atk: 200, def: 100, xp: 2800, crystals: 700,
    statusAttack: { statusId: "weaken", chance: 0.7 },
    desc: "영혼을 변형하는 준특급 저주령 레이드 보스!",
    materialReward: { "저주 결정": 10, "마력 실": 6, "빛의 결정": 3 },
    minParty: 2,
  },
  {
    id: "rb3", name: "스쿠나 완전체 (레이드)", emoji: "👑", grade: "특급",
    hp: 120000, atk: 280, def: 150, xp: 5000, crystals: 1500,
    statusAttack: { statusId: "poison", chance: 0.8 },
    desc: "저주의 왕 스쿠나 완전체! 최강의 레이드 보스!",
    materialReward: { "저주 결정": 20, "스쿠나 파편": 10, "빛의 결정": 8, "마력 실": 10 },
    minParty: 3,
  },
];

// 서버별 레이드 세션 (guildId → session)
const raidSessions = {};

function createRaidSession(guildId, bossId, leaderId) {
  const boss = RAID_BOSSES.find(b => b.id === bossId);
  if (!boss) return null;
  raidSessions[guildId] = {
    id: guildId,
    boss: { ...boss },
    bossHp: boss.hp,
    leaderId,
    participants: [leaderId],
    damageLog: { [leaderId]: 0 }, // 딜 기여도
    statusEffects: [],
    started: false,
    startTime: Date.now(),
  };
  return raidSessions[guildId];
}

// ════════════════════════════════════════════════════════
// ── 술식 각성/진화 시스템
// ════════════════════════════════════════════════════════
const SKILL_AWAKENING = {
  // charId: { skillName: { awakened: false, cost: { crystals, masteryRequired }, newSkillName, newDmg, newDesc, newStatus } }
  itadori: {
    "흑섬": {
      awakenedName: "흑섬 · 개화",
      masteryRequired: 40,
      crystalCost: 300,
      dmgMult: 1.5,
      newDesc: "흑섬이 개화! 피해 1.5배, 연소 확률 60%",
      newStatus: { target: "enemy", statusId: "burn", chance: 0.6 },
    },
    "다이버전트 주먹": {
      awakenedName: "다이버전트 주먹 · 극",
      masteryRequired: 20,
      crystalCost: 200,
      dmgMult: 1.4,
      newDesc: "극한의 저주력 집중. 피해 1.4배, 기절 50%",
      newStatus: { target: "enemy", statusId: "stun", chance: 0.5 },
    },
  },
  gojo: {
    "무량공처": {
      awakenedName: "무량공처 · 무한",
      masteryRequired: 50,
      crystalCost: 500,
      dmgMult: 1.6,
      newDesc: "무한의 완전 제어. 피해 1.6배, 빙결 확률 90%",
      newStatus: { target: "enemy", statusId: "freeze", chance: 0.9 },
    },
    "무라사키": {
      awakenedName: "무라사키 · 완전체",
      masteryRequired: 25,
      crystalCost: 300,
      dmgMult: 1.4,
      newDesc: "완전한 허수 발현. 피해 1.4배, 약화 80%",
      newStatus: { target: "enemy", statusId: "weaken", chance: 0.8 },
    },
  },
  megumi: {
    "후루베 유라유라": {
      awakenedName: "마허라가라 완전 강림",
      masteryRequired: 50,
      crystalCost: 400,
      dmgMult: 1.5,
      newDesc: "마허라가라 완전 강림! 피해 1.5배, 기절 80%",
      newStatus: { target: "enemy", statusId: "stun", chance: 0.8 },
    },
  },
  nobara: {
    "발화": {
      awakenedName: "발화 · 극열",
      masteryRequired: 45,
      crystalCost: 350,
      dmgMult: 1.5,
      newDesc: "모든 못 동시 폭발 극대화. 피해 1.5배, 화상 100%",
      newStatus: { target: "enemy", statusId: "burn", chance: 1.0 },
    },
  },
  todo: {
    "전투본능": {
      awakenedName: "전투본능 · 극한",
      masteryRequired: 40,
      crystalCost: 300,
      dmgMult: 1.3,
      newDesc: "전투본능 극한 발현! 버프 강화 + 피해 증가",
      newStatus: { target: "self", statusId: "battleInstinct", chance: 1.0 },
    },
  },
  hakari: {
    "질풍강운": {
      awakenedName: "질풍강운 · 대당첨",
      masteryRequired: 50,
      crystalCost: 450,
      dmgMult: 1.6,
      newDesc: "대당첨 발현! 피해 1.6배, 빙결 90%",
      newStatus: { target: "enemy", statusId: "freeze", chance: 0.9 },
    },
  },
  nanami: {
    "초과근무": {
      awakenedName: "초과근무 · 한계돌파",
      masteryRequired: 45,
      crystalCost: 350,
      dmgMult: 1.5,
      newDesc: "한계를 완전히 초월! 피해 1.5배",
      newStatus: null,
    },
  },
};

function getAwakenedSkill(player, charId, skillName) {
  const awakData = SKILL_AWAKENING[charId];
  if (!awakData || !awakData[skillName]) return null;
  const key = `${charId}_${skillName}`;
  if (!player.skillAwakenings) return null;
  return player.skillAwakenings[key] ? awakData[skillName] : null;
}

function isSkillAwakened(player, charId, skillName) {
  if (!player.skillAwakenings) return false;
  return !!player.skillAwakenings[`${charId}_${skillName}`];
}

// ════════════════════════════════════════════════════════
// ── 스킬 이펙트 아트
// ════════════════════════════════════════════════════════
const SKILL_EFFECTS = {
  "주먹질": { art: "```\n  💥  \n ▓▓▓▓▓\n  💥  \n```", color: 0xff6b35, flavorText: "저주 에너지를 주먹에 집중시킨다!" },
  "다이버전트 주먹": { art: "```\n ⚡💥⚡\n▓▓▓▓▓▓▓\n ⚡💥⚡\n```", color: 0xff4500, flavorText: "발산하는 저주 에너지 — 몸의 내부에서 폭발!" },
  "다이버전트 주먹 · 극": { art: "```\n⚡💥⚡💥⚡\n▓▓극한▓▓▓\n⚡💥⚡💥⚡\n```", color: 0xff2200, flavorText: "극한의 저주 에너지 폭발!" },
  "흑섬": { art: "```\n🌑🌑🌑🌑🌑\n⬛ 黑 閃 ⬛\n🌑🌑🌑🌑🌑\n```", color: 0x1a0a2e, flavorText: "순간적으로 발산되는 최대 저주 에너지!" },
  "흑섬 · 개화": { art: "```\n🌑🌸🌑🌸🌑\n🌸黑閃·開花🌸\n🌑🌸🌑🌸🌑\n```", color: 0x8b0a4e, flavorText: "흑섬이 개화한다 — 최극의 저주 폭발!" },
  "어주자": { art: "```\n👹✨👹✨👹\n✨ 廻 夏 ✨\n👹✨👹✨👹\n```", color: 0xb5451b, flavorText: "스쿠나의 힘이 몸을 가득 채운다..." },
  "스쿠나 발현": { art: "```\n🔴👹🔴👹🔴\n👹 両 面 宿 儺 👹\n🔴👹🔴👹🔴\n```", color: 0x8b0000, flavorText: "저주의 왕이 이타도리의 몸을 장악한다!" },
  "아오": { art: "```\n  🔵🔵🔵  \n🔵  蒼  🔵\n  🔵🔵🔵  \n```", color: 0x0066ff, flavorText: "무한에 의한 인력 — 모든 것을 끌어당긴다" },
  "아카": { art: "```\n  🔴🔴🔴  \n🔴  赫  🔴\n  🔴🔴🔴  \n```", color: 0xff0033, flavorText: "무한에 의한 척력 — 모든 것을 날려버린다" },
  "무라사키": { art: "```\n🔴⚡🔵⚡🔴\n⚡  紫  ⚡\n🔵⚡🔴⚡🔵\n```", color: 0x9900ff, flavorText: "아오와 아카의 융합 — 허공을 찢는 허수!" },
  "무라사키 · 완전체": { art: "```\n🔴🌟🔵🌟🔴\n🌟紫·完全體🌟\n🔵🌟🔴🌟🔵\n```", color: 0xcc00ff, flavorText: "완전한 허수 발현 — 공간이 붕괴한다!" },
  "무량공처": { art: "```\n∞∞∞∞∞∞∞∞∞\n∞ 無 量 空 処 ∞\n∞∞∞∞∞∞∞∞∞\n```", color: 0x00ffff, flavorText: "\"나는 최강이니까\" — 무한이 세계를 지배한다" },
  "무량공처 · 무한": { art: "```\n∞🌟∞🌟∞🌟∞\n🌟無量空処·無限🌟\n∞🌟∞🌟∞🌟∞\n```", color: 0x00ffff, flavorText: "무한의 완전 제어 — 세계가 멈춘다!" },
  "옥견": { art: "```\n  🐕🐕🐕  \n🐕  玉  🐕\n  🐕🐕🐕  \n```", color: 0x4a4a8a, flavorText: "식신 옥견 소환!" },
  "탈토": { art: "```\n  🐯🐯🐯  \n🐯  脱  🐯\n  🐯🐯🐯  \n```", color: 0xff8800, flavorText: "식신 대호 소환 — 강력한 발톱이 적을 찢는다!" },
  "만상": { art: "```\n🌑🐕🌑🐯🌑\n🐯 萬 象 🐕\n🌑🐯🌑🐕🌑\n```", color: 0x2d1b69, flavorText: "열 가지 식신이 일제히 소환된다!" },
  "후루베 유라유라": { art: "```\n💀✨💀✨💀\n✨ 振 魂 ✨\n💀✨💀✨💀\n```", color: 0x8b0000, flavorText: "마허라가라 강림 — 최강의 식신이 깨어난다!" },
  "마허라가라 완전 강림": { art: "```\n💀🌟💀🌟💀\n🌟摩虎羅·完全🌟\n💀🌟💀🌟💀\n```", color: 0xff0066, flavorText: "마허라가라 완전 강림 — 신이 지상에 내려선다!" },
  "망치질": { art: "```\n  🔨🔨🔨  \n⚡  釘  ⚡\n  🔨🔨🔨  \n```", color: 0xff69b4, flavorText: "저주 못을 적의 영혼에 박아넣는다!" },
  "공명": { art: "```\n🌸💥🌸💥🌸\n💥 共 鳴 💥\n🌸💥🌸💥🌸\n```", color: 0xff1493, flavorText: "허수아비를 통한 공명 피해 — 영혼이 직접 타격된다!" },
  "철정": { art: "```\n⚡🔨⚡🔨⚡\n🔨 鉄 釘 🔨\n⚡🔨⚡🔨⚡\n```", color: 0xdc143c, flavorText: "저주 에너지 주입 — 못이 몸 속에서 폭발한다!" },
  "발화": { art: "```\n🔥🌸🔥🌸🔥\n🌸 発 火 🌸\n🔥🌸🔥🌸🔥\n```", color: 0xff4500, flavorText: "모든 못에 동시 폭발 공명 — 영혼이 불타오른다!" },
  "발화 · 극열": { art: "```\n🔥💀🔥💀🔥\n💀発火·極熱💀\n🔥💀🔥💀🔥\n```", color: 0xff1100, flavorText: "극열의 폭발 — 영혼이 재가 된다!" },
  "해": { art: "```\n  ✂️✂️✂️  \n✂️  解  ✂️\n  ✂️✂️✂️  \n```", color: 0xcc0000, flavorText: "만물을 베어내는 저주의 왕의 손톱!" },
  "팔": { art: "```\n🌌✂️🌌✂️🌌\n✂️  捌  ✂️\n🌌✂️🌌✂️🌌\n```", color: 0x8b0000, flavorText: "공간 자체를 베어내는 절대적 술식!" },
  "푸가": { art: "```\n💀🔥💀🔥💀\n🔥 不 雅 🔥\n💀🔥💀🔥💀\n```", color: 0x4a0000, flavorText: "닿는 모든 것을 분해한다 — 저주의 왕의 진면목!" },
  "복마어주자": { art: "```\n👑🌑👑🌑👑\n🌑伏魔御廚子🌑\n👑🌑👑🌑👑\n```", color: 0x2a0000, flavorText: "천지개벽 — 저주의 왕의 궁극 영역전개!" },
  "모방술식": { art: "```\n  🌟🌟🌟  \n🌟  模  🌟\n  🌟🌟🌟  \n```", color: 0xffd700, flavorText: "타인의 술식을 완벽하게 복사한다!" },
  "리카 소환": { art: "```\n💜👸💜👸💜\n👸  里  香  👸\n💜👸💜👸💜\n```", color: 0x9400d3, flavorText: "저주의 여왕 리카 소환 — 최강의 저주된 영혼!" },
  "순애빔": { art: "```\n💜💛💜💛💜\n💛 純 愛 砲 💛\n💜💛💜💛💜\n```", color: 0xff00ff, flavorText: "사랑의 에너지가 파괴적인 빔으로 변환된다!" },
  "진안상애": { art: "```\n🌟💜🌟💜🌟\n💜真贋相愛💜\n🌟💜🌟💜🌟\n```", color: 0x6600cc, flavorText: "사랑과 저주의 경계가 무너진다 — 궁극의 영역!" },
  "부기우기": { art: "```\n🎵💪🎵💪🎵\n💪 Boogie 💪\n🎵💪🎵💪🎵\n```", color: 0x1e90ff, flavorText: "\"댄스홀 가수!\" — 보조공격술 위치 전환! 빙결의 한기!" },
  "브루탈 펀치": { art: "```\n💥🔥💥🔥💥\n🔥BRUTAL🔥\n💥🔥💥🔥💥\n```", color: 0xff2200, flavorText: "최대 저주력을 실은 파괴적 일격!" },
  "전투본능": { art: "```\n⚔️🔥⚔️🔥⚔️\n🔥戦闘本能🔥\n⚔️🔥⚔️🔥⚔️\n```", color: 0xff8c00, flavorText: "전사의 본능이 각성한다! 공격력·회피 극대화!" },
  "전투본능 · 극한": { art: "```\n⚔️🌟⚔️🌟⚔️\n🌟戦闘本能·極🌟\n⚔️🌟⚔️🌟⚔️\n```", color: 0xffaa00, flavorText: "극한의 전투본능 발현 — 인간의 한계를 초월!" },
  "둔기 공격": { art: "```\n  🔨🔨🔨  \n💼  NA  💼\n  🔨🔨🔨  \n```", color: 0xcc8800, flavorText: "단단한 둔기로 정확한 타격!" },
  "칠할삼분": { art: "```\n7️⃣3️⃣7️⃣3️⃣7️⃣\n  7  :  3  \n7️⃣3️⃣7️⃣3️⃣7️⃣\n```", color: 0xff6600, flavorText: "7:3의 비율 — 약점을 정확히 관통한다!" },
  "십수할": { art: "```\n💢💢💢💢💢\n  十 數 割  \n💢💢💢💢💢\n```", color: 0xcc3300, flavorText: "열 배의 저주 에너지를 한계까지 방출!" },
  "초과근무": { art: "```\n⏰💥⏰💥⏰\n💥 殘 業 💥\n⏰💥⏰💥⏰\n```", color: 0xff0000, flavorText: "\"초과 근무는 사절이지만... 이건 일이 아니다.\"" },
  "초과근무 · 한계돌파": { art: "```\n⏰🌟⏰🌟⏰\n🌟殘業·突破🌟\n⏰🌟⏰🌟⏰\n```", color: 0xff3300, flavorText: "한계를 완전히 초월 — 나나미의 진짜 힘!" },
  "저주 방출": { art: "```\n🌊🌊🌊🌊🌊\n  呪 靈   \n🌊🌊🌊🌊🌊\n```", color: 0x44aa44, flavorText: "저주 에너지를 고압으로 방출한다!" },
  "최대출력": { art: "```\n⚡⚡⚡⚡⚡\n  MAX OUT  \n⚡⚡⚡⚡⚡\n```", color: 0xffaa00, flavorText: "저주력을 한계까지 증폭! 최대 출력!" },
  "저주영조종": { art: "```\n👹🌀👹🌀👹\n🌀 操 靈 🌀\n👹🌀👹🌀👹\n```", color: 0x88ff88, flavorText: "수천의 저주령을 자유자재로 조종한다!" },
  "감로대법": { art: "```\n💀🍂💀🍂💀\n🍂 甘 露 🍂\n💀🍂💀🍂💀\n```", color: 0x66cc66, flavorText: "모든 저주를 흡수하는 감로대법!" },
  "봉술": { art: "```\n🏮🏮🏮🏮🏮\n  杖 術   \n🏮🏮🏮🏮🏮\n```", color: 0xdd88ff, flavorText: "저주 도구 봉으로 정확하게 타격!" },
  "저주창": { art: "```\n🗡️🗡️🗡️🗡️🗡️\n  呪 槍   \n🗡️🗡️🗡️🗡️🗡️\n```", color: 0xff77aa, flavorText: "저주 도구 창을 투척!" },
  "저주도구술": { art: "```\n⚔️🔱⚔️🔱⚔️\n  呪 具   \n⚔️🔱⚔️🔱⚔️\n```", color: 0xffaaff, flavorText: "다양한 저주 도구를 자유자재로 구사!" },
  "천개봉파": { art: "```\n💥💥💥💥💥\n  天 開    \n💥💥💥💥💥\n```", color: 0xff44ff, flavorText: "수천의 저주 도구 연속 공격!" },
  "박치기": { art: "```\n  🐼💥  \n ▓▓▓▓▓\n  💥🐼  \n```", color: 0x886622, flavorText: "머리로 힘차게 들이받는다!" },
  "곰 발바닥": { art: "```\n🐾🐾🐾🐾🐾\n  熊 掌   \n🐾🐾🐾🐾🐾\n```", color: 0xaa8844, flavorText: "두꺼운 발바닥으로 내리친다!" },
  "팬더 변신": { art: "```\n🐼✨🐼✨🐼\n✨ 熊 變 ✨\n🐼✨🐼✨🐼\n```", color: 0xccaa66, flavorText: "진짜 팬더로 변신해 공격!" },
  "고릴라 변신": { art: "```\n🦍💥🦍💥🦍\n💥 猩 變 💥\n🦍💥🦍💥🦍\n```", color: 0xaa6644, flavorText: "고릴라 형태로 폭발적 강화!" },
  "멈춰라": { art: "```\n✋✋✋✋✋\n  STOP!  \n✋✋✋✋✋\n```", color: 0x66ccff, flavorText: "\"멈춰라!\" — 강력한 주술언어!" },
  "달려라": { art: "```\n🏃💨🏃💨🏃\n  RUN!   \n🏃💨🏃💨🏃\n```", color: 0x88ddff, flavorText: "\"달려라!\" — 적을 혼란에 빠뜨린다!" },
  "주술언어": { art: "```\n🔊🔊🔊🔊🔊\n  呪 言   \n🔊🔊🔊🔊🔊\n```", color: 0xaaffff, flavorText: "강력한 주술 명령을 내린다!" },
  "폭발해라": { art: "```\n💥💥💥💥💥\n  EXPLODE  \n💥💥💥💥💥\n```", color: 0xff8888, flavorText: "\"폭발해라!\" — 적을 그 자리에서 폭발시킨다!" },
  "저주도구": { art: "```\n⚖️⚖️⚖️⚖️⚖️\n  呪 具   \n⚖️⚖️⚖️⚖️⚖️\n```", color: 0xccaaff, flavorText: "저주 에너지를 담은 도구로 공격!" },
  "몰수": { art: "```\n⚖️❌⚖️❌⚖️\n  沒 收   \n⚖️❌⚖️❌⚖️\n```", color: 0xffaa88, flavorText: "상대의 술식을 몰수한다!" },
  "사형판결": { art: "```\n⚖️💀⚖️💀⚖️\n  死 刑   \n⚖️💀⚖️💀⚖️\n```", color: 0xff6644, flavorText: "재판 결과에 따른 강력한 제재!" },
  "집행인 인형": { art: "```\n🔪👤🔪👤🔪\n  執 行   \n🔪👤🔪👤🔪\n```", color: 0xcc3333, flavorText: "집행인 인형을 소환해 즉시 처형!" },
  "화염 분사": { art: "```\n🔥🔥🔥🔥🔥\n  火 炎   \n🔥🔥🔥🔥🔥\n```", color: 0xff4400, flavorText: "강렬한 불꽃을 내뿜는다!" },
  "용암 폭발": { art: "```\n🌋🌋🌋🌋🌋\n  熔 岩   \n🌋🌋🌋🌋🌋\n```", color: 0xff6600, flavorText: "발밑의 용암을 폭발시킨다!" },
  "극번 운": { art: "```\n☄️☄️☄️☄️☄️\n  極 番   \n☄️☄️☄️☄️☄️\n```", color: 0xffaa00, flavorText: "하늘에서 불타는 운석을 소환한다!" },
  "개관철위산": { art: "```\n🗻🔥🗻🔥🗻\n  蓋 棺   \n🗻🔥🗻🔥🗻\n```", color: 0xff2200, flavorText: "화산을 소환하는 궁극 영역전개!" },
  "물고기 소환": { art: "```\n🐟🐠🐟🐠🐟\n  魚 群   \n🐟🐠🐟🐠🐟\n```", color: 0x3366ff, flavorText: "날카로운 물고기 떼를 소환한다!" },
  "해수 폭발": { art: "```\n🌊💥🌊💥🌊\n  海 水   \n🌊💥🌊💥🌊\n```", color: 0x2288ff, flavorText: "강력한 해수를 압축해 발사한다!" },
  "조류 소용돌이": { art: "```\n🌀🌀🌀🌀🌀\n  渦 流   \n🌀🌀🌀🌀🌀\n```", color: 0x44aaff, flavorText: "거대한 물의 소용돌이로 공격한다!" },
  "탕온평선": { art: "```\n🌊🐟🌊🐟🌊\n  蕩 蘊   \n🌊🐟🌊🐟🌊\n```", color: 0x44ccff, flavorText: "무수한 물고기로 가득 찬 영역전개!" },
  "나무뿌리 채찍": { art: "```\n🌿🌿🌿🌿🌿\n  樹 根   \n🌿🌿🌿🌿🌿\n```", color: 0x44aa44, flavorText: "나무뿌리를 채찍처럼 휘두른다!" },
  "꽃비": { art: "```\n🌸🌸🌸🌸🌸\n  花 雨   \n🌸🌸🌸🌸🌸\n```", color: 0xff88cc, flavorText: "독성 꽃가루를 비처럼 쏟아낸다!" },
  "대지의 저주": { art: "```\n🌍🌍🌍🌍🌍\n  大 地   \n🌍🌍🌍🌍🌍\n```", color: 0x88cc66, flavorText: "대지 전체에 저주 에너지를 퍼뜨린다!" },
  "재앙의 꽃": { art: "```\n🌺💀🌺💀🌺\n  災 花   \n🌺💀🌺💀🌺\n```", color: 0xff66aa, flavorText: "거대한 꽃을 소환해 모든 것을 흡수한다!" },
  "영혼 변형": { art: "```\n💀🌀💀🌀💀\n  魂 変   \n💀🌀💀🌀💀\n```", color: 0xaa44aa, flavorText: "영혼을 변형해 직접 타격한다!" },
  "무위전변": { art: "```\n🔄🔄🔄🔄🔄\n  無 爲   \n🔄🔄🔄🔄🔄\n```", color: 0xcc66cc, flavorText: "접촉한 신체를 기괴하게 변형한다!" },
  "편사지경체": { art: "```\n🌀🌀🌀🌀🌀\n  遍 殺   \n🌀🌀🌀🌀🌀\n```", color: 0xdd88dd, flavorText: "신체를 무한히 변형해 공격한다!" },
  "자폐원돈과": { art: "```\n💀🌀💀🌀💀\n  自 閉   \n💀🌀💀🌀💀\n```", color: 0xeeaaee, flavorText: "영혼과 육체의 경계를 무너뜨리는 영역!" },
  "험한 도박": { art: "```\n🎰🎲🎰🎲🎰\n  賭 博   \n🎰🎲🎰🎲🎰\n```", color: 0xffcc00, flavorText: "운에 맡긴 도박 — 운이 좋으면 대박!" },
  "질풍열차": { art: "```\n🚂💨🚂💨🚂\n  列 車   \n🚂💨🚂💨🚂\n```", color: 0x3399ff, flavorText: "강력한 열차처럼 돌진!" },
  "유한 소설": { art: "```\n📖🔥📖🔥📖\n  不 滅   \n📖🔥📖🔥📖\n```", color: 0xff9900, flavorText: "불멸의 몸으로 싸운다!" },
  "질풍강운": { art: "```\n🎰🌪️🎰🌪️🎰\n  強 運   \n🎰🌪️🎰🌪️🎰\n```", color: 0xffdd00, flavorText: "운이 터진다 — 대당첨 영역전개!" },
  "질풍강운 · 대당첨": { art: "```\n🎰🌟🎰🌟🎰\n🌟強運·大當籤🌟\n🎰🌟🎰🌟🎰\n```", color: 0xffee00, flavorText: "대당첨 발현 — 모든 것이 유리하게 흐른다!" },
  "_default": { art: "```\n  ✨✨✨  \n✨ 術 式 ✨\n  ✨✨✨  \n```", color: 0x7c5cfc, flavorText: "저주 에너지가 폭발한다!" },
};
function getSkillEffect(skillName) { return SKILL_EFFECTS[skillName] || SKILL_EFFECTS["_default"]; }

// ════════════════════════════════════════════════════════
// ── 캐릭터 데이터
// ════════════════════════════════════════════════════════
const CHARACTERS = {
  itadori: {
    name: "이타도리 유지", emoji: "🟠", grade: "준1급",
    atk: 90, def: 75, spd: 85, maxHp: 1000, domain: null,
    desc: "특급주술사 후보생. 스쿠나의 손가락을 삼킨 그릇.",
    lore: "\"남은 건 내가 어떻게 죽느냐다.\"",
    fingerSkills: true,
    skills: [
      { name: "주먹질", minMastery: 0, dmg: 95, desc: "강력한 기본 주먹 공격." },
      { name: "다이버전트 주먹", minMastery: 5, dmg: 160, desc: "저주 에너지를 실은 주먹.", statusApply: { target: "enemy", statusId: "stun", chance: 0.3 } },
      { name: "흑섬", minMastery: 15, dmg: 240, desc: "최대 저주 에너지 방출!", statusApply: { target: "enemy", statusId: "weaken", chance: 0.5 } },
      { name: "어주자", minMastery: 30, dmg: 340, desc: "스쿠나의 힘을 빌린 궁극기.", statusApply: { target: "enemy", statusId: "burn", chance: 0.7 } },
      { name: "스쿠나 발현", minMastery: 50, dmg: 520, desc: "스쿠나가 몸을 장악! 10손가락 이상 필요.", statusApply: { target: "enemy", statusId: "freeze", chance: 0.8 } },
    ],
  },
  gojo: {
    name: "고조 사토루", emoji: "🔵", grade: "특급",
    atk: 130, def: 120, spd: 110, maxHp: 1800, domain: "무량공처",
    desc: "최강의 주술사. 무량공처를 구사한다.",
    lore: "\"사람들이 왜 내가 최강이라고 하는지 알아? 이 무한이 있어서야.\"",
    skills: [
      { name: "아오", minMastery: 0, dmg: 145, desc: "적들을 끌어당겨서 공격한다." },
      { name: "아카", minMastery: 5, dmg: 220, desc: "적들을 날려서 폭발시킨다.", statusApply: { target: "enemy", statusId: "burn", chance: 0.5 } },
      { name: "무라사키", minMastery: 15, dmg: 320, desc: "아오와 아카를 합쳐서 발사.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.6 } },
      { name: "무량공처", minMastery: 30, dmg: 480, desc: "무한을 지배하는 궁극술식.", statusApply: { target: "enemy", statusId: "freeze", chance: 0.8 } },
    ],
  },
  megumi: {
    name: "후시구로 메구미", emoji: "⚫", grade: "1급",
    atk: 110, def: 108, spd: 100, maxHp: 1250, domain: "강압암예정",
    desc: "식신술을 구사하는 주술사.",
    lore: "\"나는 선한 사람을 구하기 위해 싸운다.\"",
    skills: [
      { name: "옥견", minMastery: 0, dmg: 115, desc: "식신 옥견을 소환한다." },
      { name: "탈토", minMastery: 5, dmg: 180, desc: "식신 대호를 소환한다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.4 } },
      { name: "만상", minMastery: 15, dmg: 265, desc: "열 가지 식신을 소환한다.", statusApply: { target: "enemy", statusId: "poison", chance: 0.5 } },
      { name: "후루베 유라유라", minMastery: 30, dmg: 380, desc: "최강의 식신, 마허라가라 강림.", statusApply: { target: "enemy", statusId: "stun", chance: 0.6 } },
    ],
  },
  nobara: {
    name: "쿠기사키 노바라", emoji: "🌸", grade: "1급",
    atk: 115, def: 95, spd: 105, maxHp: 1180, domain: null,
    desc: "망치를 이용해 영혼에 공격 가능한 주술사.",
    lore: "\"도쿄에 올 때부터 각오는 되어 있었어.\"",
    skills: [
      { name: "망치질", minMastery: 0, dmg: 118, desc: "저주 못을 박는다." },
      { name: "공명", minMastery: 5, dmg: 195, desc: "허수아비를 통해 공명 피해.", statusApply: { target: "enemy", statusId: "poison", chance: 0.5 } },
      { name: "철정", minMastery: 15, dmg: 280, desc: "저주 에너지 주입 못을 박는다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.5 } },
      { name: "발화", minMastery: 30, dmg: 390, desc: "모든 못에 동시 폭발 공명.", statusApply: { target: "enemy", statusId: "burn", chance: 0.8 } },
    ],
  },
  nanami: {
    name: "나나미 켄토", emoji: "🟡", grade: "1급",
    atk: 118, def: 108, spd: 90, maxHp: 1380, domain: null,
    desc: "1급 주술사. 합리적 판단의 소유자.",
    lore: "\"초과 근무는 사절이지만... 이건 일이 아닌 의무다.\"",
    skills: [
      { name: "둔기 공격", minMastery: 0, dmg: 120, desc: "단단한 둔기로 타격한다." },
      { name: "칠할삼분", minMastery: 5, dmg: 200, desc: "7:3 지점을 노린 약점 공격.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.6 } },
      { name: "십수할", minMastery: 15, dmg: 290, desc: "열 배의 저주 에너지 방출." },
      { name: "초과근무", minMastery: 30, dmg: 410, desc: "한계를 넘어선 폭발적 강화." },
    ],
  },
  sukuna: {
    name: "료멘 스쿠나", emoji: "🔴", grade: "특급",
    atk: 140, def: 115, spd: 120, maxHp: 2500, domain: "복마어주자",
    desc: "저주의 왕. 역대 최강의 저주된 영혼. [개발자 전용]",
    lore: "\"약한 놈이 강한 놈을 거스르는 건 죄악이다.\"",
    skills: [
      { name: "해", minMastery: 0, dmg: 145, desc: "날카로운 손톱으로 베어낸다.", statusApply: { target: "enemy", statusId: "burn", chance: 0.4 } },
      { name: "팔", minMastery: 5, dmg: 235, desc: "공간 자체를 베어낸다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.5 } },
      { name: "푸가", minMastery: 15, dmg: 345, desc: "닿는 모든 것을 분해한다.", statusApply: { target: "enemy", statusId: "poison", chance: 0.7 } },
      { name: "복마어주자", minMastery: 30, dmg: 500, desc: "천지개벽의 궁극 영역전개.", statusApply: { target: "enemy", statusId: "freeze", chance: 0.9 } },
    ],
  },
  geto: {
    name: "게토 스구루", emoji: "🟢", grade: "특급",
    atk: 115, def: 105, spd: 100, maxHp: 1600, domain: null,
    desc: "전 특급 주술사. 저주를 다루는 달인.",
    lore: "\"주술사는 비주술사를 지켜야 한다 — 아니, 그래야만 했어.\"",
    skills: [
      { name: "저주 방출", minMastery: 0, dmg: 125, desc: "저급 저주령을 방출한다." },
      { name: "최대출력", minMastery: 5, dmg: 210, desc: "저주령을 전력으로 방출.", statusApply: { target: "enemy", statusId: "poison", chance: 0.4 } },
      { name: "저주영조종", minMastery: 15, dmg: 300, desc: "수천의 저주령을 조종한다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.6 } },
      { name: "감로대법", minMastery: 30, dmg: 425, desc: "감로대법으로 모든 저주 흡수.", statusApply: { target: "enemy", statusId: "stun", chance: 0.5 } },
    ],
  },
  maki: {
    name: "마키 젠인", emoji: "⚪", grade: "준1급",
    atk: 122, def: 110, spd: 115, maxHp: 1300, domain: null,
    desc: "저주력이 없어도 강한 주술사. HP 30% 이하 시 천여주박 각성!",
    lore: "\"젠인 가문 — 그 이름을 내가 직접 끝내주지.\"",
    awakening: { threshold: 0.30, dmgMult: 2.0, label: "천여주박 각성" },
    skills: [
      { name: "봉술", minMastery: 0, dmg: 122, desc: "저주 도구 봉으로 타격." },
      { name: "저주창", minMastery: 5, dmg: 200, desc: "저주 도구 창을 투척한다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.4 } },
      { name: "저주도구술", minMastery: 15, dmg: 285, desc: "다양한 저주 도구를 구사.", statusApply: { target: "enemy", statusId: "burn", chance: 0.5 } },
      { name: "천개봉파", minMastery: 30, dmg: 400, desc: "수천의 저주 도구 연속 공격.", statusApply: { target: "enemy", statusId: "stun", chance: 0.6 } },
    ],
  },
  panda: {
    name: "판다", emoji: "🐼", grade: "2급",
    atk: 105, def: 118, spd: 85, maxHp: 1400, domain: null,
    desc: "저주로 만든 특이체질의 주술사.",
    lore: "\"난 판다야. 진짜 판다.\"",
    skills: [
      { name: "박치기", minMastery: 0, dmg: 108, desc: "머리로 힘차게 들이받는다.", statusApply: { target: "enemy", statusId: "stun", chance: 0.2 } },
      { name: "곰 발바닥", minMastery: 5, dmg: 175, desc: "두꺼운 발바닥으로 내리친다." },
      { name: "팬더 변신", minMastery: 15, dmg: 255, desc: "진짜 팬더로 변신해 공격.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.4 } },
      { name: "고릴라 변신", minMastery: 30, dmg: 360, desc: "고릴라 형태로 폭발적 강화.", statusApply: { target: "enemy", statusId: "stun", chance: 0.5 } },
    ],
  },
  inumaki: {
    name: "이누마키 토게", emoji: "🟤", grade: "준1급",
    atk: 112, def: 90, spd: 110, maxHp: 1120, domain: null,
    desc: "주술언어를 구사하는 준1급 주술사.",
    lore: "\"연어알— (그냥 따라가.)\"",
    skills: [
      { name: "멈춰라", minMastery: 0, dmg: 115, desc: "상대의 움직임을 봉쇄한다.", statusApply: { target: "enemy", statusId: "freeze", chance: 0.5 } },
      { name: "달려라", minMastery: 5, dmg: 180, desc: "상대를 무작위로 달리게 한다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.5 } },
      { name: "주술언어", minMastery: 15, dmg: 265, desc: "강력한 주술 명령을 내린다.", statusApply: { target: "enemy", statusId: "stun", chance: 0.6 } },
      { name: "폭발해라", minMastery: 30, dmg: 375, desc: "상대를 그 자리에서 폭발시킨다.", statusApply: { target: "enemy", statusId: "burn", chance: 0.8 } },
    ],
  },
  yuta: {
    name: "오코츠 유타", emoji: "🌟", grade: "특급",
    atk: 128, def: 112, spd: 115, maxHp: 1750, domain: "진안상애",
    desc: "특급 주술사. 리카의 저주를 다루는 최강급 주술사.",
    lore: "\"리카... 나는 아직 살아야 해.\"",
    skills: [
      { name: "모방술식", minMastery: 0, dmg: 135, desc: "다른 술식을 모방해 공격한다." },
      { name: "리카 소환", minMastery: 5, dmg: 220, desc: "저주의 여왕 리카를 소환한다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.5 } },
      { name: "순애빔", minMastery: 15, dmg: 340, desc: "리카와의 순수한 사랑을 에너지로 발사.", statusApply: { target: "enemy", statusId: "burn", chance: 0.6 } },
      { name: "진안상애", minMastery: 30, dmg: 480, desc: "영역전개로 모든 것을 사랑으로 파괴.", statusApply: { target: "enemy", statusId: "freeze", chance: 0.9 } },
    ],
  },
  higuruma: {
    name: "히구루마 히로미", emoji: "⚖️", grade: "1급",
    atk: 118, def: 105, spd: 95, maxHp: 1320, domain: "주복사사",
    desc: "전직 변호사 출신 주술사. 심판의 영역전개를 구사한다.",
    lore: "\"이 법정에서는 — 내가 판사다.\"",
    skills: [
      { name: "저주도구", minMastery: 0, dmg: 120, desc: "저주 에너지를 담은 도구로 공격." },
      { name: "몰수", minMastery: 5, dmg: 195, desc: "상대의 술식을 몰수한다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.7 } },
      { name: "사형판결", minMastery: 15, dmg: 285, desc: "재판 결과에 따른 강력한 제재.", statusApply: { target: "enemy", statusId: "stun", chance: 0.5 } },
      { name: "집행인 인형", minMastery: 30, dmg: 410, desc: "집행인 인형을 소환해 즉시 처형.", statusApply: { target: "enemy", statusId: "freeze", chance: 0.7 } },
    ],
  },
  jogo: {
    name: "죠고", emoji: "🌋", grade: "특급",
    atk: 125, def: 100, spd: 105, maxHp: 1680, domain: "개관철위산",
    desc: "화염을 다루는 준특급 저주령.",
    lore: "\"인간이야말로 진정한 저주다.\"",
    skills: [
      { name: "화염 분사", minMastery: 0, dmg: 130, desc: "강렬한 불꽃을 내뿜는다.", statusApply: { target: "enemy", statusId: "burn", chance: 0.5 } },
      { name: "용암 폭발", minMastery: 5, dmg: 215, desc: "발밑의 용암을 폭발시킨다.", statusApply: { target: "enemy", statusId: "burn", chance: 0.7 } },
      { name: "극번 운", minMastery: 15, dmg: 315, desc: "하늘에서 불타는 운석을 소환한다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.5 } },
      { name: "개관철위산", minMastery: 30, dmg: 460, desc: "화산을 소환하는 궁극 영역전개.", statusApply: { target: "enemy", statusId: "burn", chance: 1.0 } },
    ],
  },
  dagon: {
    name: "다곤", emoji: "🌊", grade: "특급",
    atk: 118, def: 108, spd: 96, maxHp: 1620, domain: "탕온평선",
    desc: "수중 저주령.",
    lore: "\"물은 모든 것을 삼킨다.\"",
    skills: [
      { name: "물고기 소환", minMastery: 0, dmg: 125, desc: "날카로운 물고기 떼를 소환한다.", statusApply: { target: "enemy", statusId: "poison", chance: 0.4 } },
      { name: "해수 폭발", minMastery: 5, dmg: 205, desc: "강력한 해수를 압축해 발사한다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.5 } },
      { name: "조류 소용돌이", minMastery: 15, dmg: 295, desc: "거대한 물의 소용돌이로 공격한다.", statusApply: { target: "enemy", statusId: "freeze", chance: 0.4 } },
      { name: "탕온평선", minMastery: 30, dmg: 450, desc: "무수한 물고기로 가득 찬 영역전개.", statusApply: { target: "enemy", statusId: "poison", chance: 0.9 } },
    ],
  },
  hanami: {
    name: "하나미", emoji: "🌿", grade: "특급",
    atk: 115, def: 118, spd: 93, maxHp: 1750, domain: null,
    desc: "식물 저주령. 나무뿌리와 꽃을 이용한 자연 술식을 구사한다.",
    lore: "\"자연은 인간의 적이 아니다 — 다만 인간이 자연의 적일 뿐.\"",
    skills: [
      { name: "나무뿌리 채찍", minMastery: 0, dmg: 122, desc: "나무뿌리를 채찍처럼 휘두른다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.3 } },
      { name: "꽃비", minMastery: 5, dmg: 198, desc: "독성 꽃가루를 비처럼 쏟아낸다.", statusApply: { target: "enemy", statusId: "poison", chance: 0.6 } },
      { name: "대지의 저주", minMastery: 15, dmg: 285, desc: "대지 전체에 저주 에너지를 퍼뜨린다.", statusApply: { target: "enemy", statusId: "poison", chance: 0.7 } },
      { name: "재앙의 꽃", minMastery: 30, dmg: 425, desc: "거대한 꽃을 소환해 모든 것을 흡수한다.", statusApply: { target: "enemy", statusId: "stun", chance: 0.6 } },
    ],
  },
  mahito: {
    name: "마히토", emoji: "🩸", grade: "특급",
    atk: 120, def: 98, spd: 110, maxHp: 1560, domain: "자폐원돈과",
    desc: "영혼을 자유자재로 변형하는 준특급 저주령.",
    lore: "\"영혼이 육체를 만드는 거야. 반대가 아니라.\"",
    skills: [
      { name: "영혼 변형", minMastery: 0, dmg: 128, desc: "영혼을 변형해 직접 타격한다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.4 } },
      { name: "무위전변", minMastery: 5, dmg: 212, desc: "접촉한 신체를 기괴하게 변형한다.", statusApply: { target: "enemy", statusId: "stun", chance: 0.4 } },
      { name: "편사지경체", minMastery: 15, dmg: 308, desc: "신체를 무한히 변형해 공격한다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.6 } },
      { name: "자폐원돈과", minMastery: 30, dmg: 455, desc: "영혼과 육체의 경계를 무너뜨리는 영역.", statusApply: { target: "enemy", statusId: "freeze", chance: 0.8 } },
    ],
  },
  todo: {
    name: "토도 아오이", emoji: "💪", grade: "1급",
    atk: 128, def: 108, spd: 112, maxHp: 1500, domain: null,
    desc: "보조 공격술(부기우기)을 구사하는 1급 주술사. 親友(베프)를 중시한다.",
    lore: "\"너의 이상형은 어떤 여자야?\" — 그리고 전설의 주먹이 날아온다.",
    skills: [
      { name: "부기우기", minMastery: 0, dmg: 130, desc: "보조공격술 — 위치 전환 + 빙결 40%.", statusApply: { target: "enemy", statusId: "freeze", chance: 0.40 } },
      { name: "브루탈 펀치", minMastery: 5, dmg: 215, desc: "최대 저주력을 실은 파괴적 주먹.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.30 } },
      { name: "흑섬", minMastery: 15, dmg: 320, desc: "이타도리에게 배운 흑섬 — 토도 특유 방식!", statusApply: { target: "enemy", statusId: "burn", chance: 0.45 } },
      { name: "전투본능", minMastery: 30, dmg: 200, desc: "자신에게 전투본능 버프! (ATK 40%↑, 회피 25%↑, 3턴) + 즉시 타격", statusApply: { target: "self", statusId: "battleInstinct", chance: 1.0 } },
    ],
  },
  hakari: {
    name: "하카리 키리토", emoji: "🎰", grade: "준1급",
    atk: 125, def: 100, spd: 108, maxHp: 1650, domain: "질풍강운",
    desc: "복권 술식을 사용하는 주술사.",
    lore: "\"운도 실력이다! 철저하게 즐기자!\"",
    skills: [
      { name: "험한 도박", minMastery: 0, dmg: 125, desc: "운에 맡긴 도박 공격!", statusApply: { target: "enemy", statusId: "stun", chance: 0.3 } },
      { name: "질풍열차", minMastery: 5, dmg: 210, desc: "강력한 열차처럼 돌진!", statusApply: { target: "enemy", statusId: "weaken", chance: 0.4 } },
      { name: "유한 소설", minMastery: 15, dmg: 320, desc: "불멸의 몸으로 싸운다!", statusApply: { target: "self", statusId: "battleInstinct", chance: 0.6 } },
      { name: "질풍강운", minMastery: 30, dmg: 480, desc: "영역전개 — 운이 터진다!", statusApply: { target: "enemy", statusId: "freeze", chance: 0.7 } },
    ],
  },
};

// ════════════════════════════════════════════════════════
// ── 적 데이터
// ════════════════════════════════════════════════════════
const ENEMIES = [
  { id: "e1", name: "저급 저주령", emoji: "👹", hp: 550, atk: 38, def: 12, xp: 75, crystals: 18, masteryXp: 1, fingers: 0, statusAttack: null },
  { id: "e2", name: "1급 저주령", emoji: "👺", hp: 1100, atk: 80, def: 40, xp: 190, crystals: 40, masteryXp: 3, fingers: 0, statusAttack: { statusId: "poison", chance: 0.3 } },
  { id: "e3", name: "특급 저주령", emoji: "💀", hp: 2400, atk: 128, def: 72, xp: 440, crystals: 90, masteryXp: 7, fingers: 1, statusAttack: { statusId: "burn", chance: 0.4 } },
  { id: "e4", name: "저주의 왕 (보스)", emoji: "👑", hp: 5500, atk: 195, def: 110, xp: 1000, crystals: 200, masteryXp: 15, fingers: 3, statusAttack: { statusId: "weaken", chance: 0.5 } },
];

const JUJUTSU_ENEMIES = [
  { id: "j1", name: "약화된 저주령", emoji: "💧", hp: 300, atk: 25, def: 8, xp: 55, crystals: 12, masteryXp: 1, points: 1, fingers: 0, statusAttack: null, desc: "⚡ 빠르지만 약함 (1포인트)" },
  { id: "j2", name: "중간급 저주령", emoji: "🌀", hp: 620, atk: 55, def: 28, xp: 115, crystals: 28, masteryXp: 2, points: 1, fingers: 0, statusAttack: { statusId: "weaken", chance: 0.2 }, desc: "⚖️ 균형잡힌 몹 (1포인트)" },
  { id: "j3", name: "강화 저주령", emoji: "🔥", hp: 450, atk: 75, def: 22, xp: 95, crystals: 23, masteryXp: 2, points: 1, fingers: 0, statusAttack: { statusId: "burn", chance: 0.35 }, desc: "💥 공격적이지만 방어 낮음 (1포인트)" },
  { id: "j4", name: "특수 저주령", emoji: "☠️", hp: 960, atk: 88, def: 48, xp: 190, crystals: 45, masteryXp: 4, points: 2, fingers: 0, statusAttack: { statusId: "poison", chance: 0.4 }, desc: "🧪 독 공격! (2포인트)" },
  { id: "j5", name: "엘리트 저주령", emoji: "💀", hp: 1380, atk: 108, def: 60, xp: 280, crystals: 70, masteryXp: 6, points: 3, fingers: 1, statusAttack: { statusId: "burn", chance: 0.5 }, desc: "⚔️ 강력한 엘리트 (3포인트)" },
  { id: "j6", name: "사멸회유 수호자", emoji: "👹", hp: 2100, atk: 135, def: 82, xp: 440, crystals: 100, masteryXp: 10, points: 5, fingers: 2, statusAttack: { statusId: "weaken", chance: 0.6 }, desc: "🏆 최강 수호자 (5포인트)" },
];

// ════════════════════════════════════════════════════════
// ── 가챠 풀
// ════════════════════════════════════════════════════════
const GACHA_POOL = [
  { id: "gojo", rate: 0.3 },
  { id: "yuta", rate: 0.45 },
  { id: "geto", rate: 0.9 },
  { id: "jogo", rate: 0.6 },
  { id: "mahito", rate: 0.6 },
  { id: "hanami", rate: 0.7 },
  { id: "dagon", rate: 0.7 },
  { id: "itadori", rate: 2.5 },
  { id: "megumi", rate: 6.0 },
  { id: "nanami", rate: 6.0 },
  { id: "maki", rate: 6.5 },
  { id: "nobara", rate: 6.5 },
  { id: "higuruma", rate: 6.5 },
  { id: "todo", rate: 5.0 },
  { id: "panda", rate: 32.0 },
  { id: "inumaki", rate: 23.75 },
  { id: "hakari", rate: 5.0 },
];

const GACHA_RARITY = {
  "특급": { stars: "★★★★★", color: 0xF5C842, effect: "✨🔱✨🔱✨", flash: "LEGENDARY" },
  "준특급": { stars: "★★★★☆", color: 0xff8c00, effect: "💠💠💠💠💠", flash: "EPIC" },
  "1급": { stars: "★★★☆☆", color: 0x7C5CFC, effect: "⭐⭐⭐⭐", flash: "RARE" },
  "준1급": { stars: "★★★☆☆", color: 0x9b72cf, effect: "⭐⭐⭐", flash: "RARE" },
  "2급": { stars: "★★☆☆☆", color: 0x4ade80, effect: "🔹🔹🔹", flash: "UNCOMMON" },
  "3급": { stars: "★☆☆☆☆", color: 0x94a3b8, effect: "◽◽", flash: "COMMON" },
};

function rollGacha(count = 1) {
  const total = GACHA_POOL.reduce((s, p) => s + p.rate, 0);
  return Array.from({ length: count }, () => {
    let roll = Math.random() * total;
    for (const e of GACHA_POOL) { roll -= e.rate; if (roll <= 0) return e.id; }
    return GACHA_POOL[GACHA_POOL.length - 1].id;
  });
}

const REVERSE_CHARS = new Set(["gojo", "yuta"]);
const CODES = {
  "release": { crystals: 200 },
  "sorryforbugs": { crystals: 1000 },
  "newupdate": { crystals: 500 },
};

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
// ── 플레이어 유틸
// ════════════════════════════════════════════════════════
function getPlayer(userId, username = "플레이어") {
  if (!players[userId]) {
    players[userId] = {
      id: userId, name: username, crystals: 500, xp: 0,
      owned: ["itadori"], active: "itadori",
      hp: CHARACTERS["itadori"].maxHp, potion: 3,
      wins: 0, losses: 0,
      mastery: { itadori: 0 },
      reverseOutput: 1.0, reverseCooldown: 0,
      cullingBest: 0, jujutsuBest: 0,
      usedCodes: [], lastDaily: 0,
      pvpWins: 0, pvpLosses: 0,
      statusEffects: [], skillCooldown: 0,
      dailyStreak: 0,
      sukunaFingers: 0,
      kogane: null,
      koganeGachaCount: 0,
      materials: {},
      equipment: {},
      skillAwakenings: {},
      corruption: 0,
      blazeStack: 0,
      questData: null,
    };
    savePlayer(userId);
  }
  const p = players[userId];
  let changed = false;
  if (p.name !== username && username !== "플레이어") { p.name = username; changed = true; }
  const defaults = {
    reverseOutput: 1.0, reverseCooldown: 0, mastery: {}, cullingBest: 0,
    jujutsuBest: 0, usedCodes: [], lastDaily: 0, pvpWins: 0, pvpLosses: 0,
    statusEffects: [], skillCooldown: 0, dailyStreak: 0, sukunaFingers: 0,
    kogane: null, koganeGachaCount: 0, materials: {}, equipment: {}, skillAwakenings: {},
    corruption: 0, blazeStack: 0, questData: null,
  };
  for (const [k, v] of Object.entries(defaults)) {
    if (p[k] === undefined) { p[k] = typeof v === "object" && v !== null ? JSON.parse(JSON.stringify(v)) : v; changed = true; }
  }
  if (!p.id) { p.id = userId; changed = true; }
  if (changed) savePlayer(userId);
  return p;
}

function getMastery(player, charId) { return player.mastery?.[charId] || 0; }

function getAvailableSkills(player, charId) {
  const m = getMastery(player, charId);
  const skills = CHARACTERS[charId].skills.filter(s => m >= s.minMastery);
  return skills.filter(s => {
    if (s.name === "스쿠나 발현" && (player.sukunaFingers || 0) < 10) return false;
    return true;
  });
}

function getCurrentSkill(player, charId) {
  const skills = getAvailableSkills(player, charId);
  return skills[skills.length - 1] || CHARACTERS[charId].skills[0];
}

function getNextSkill(player, charId) {
  const m = getMastery(player, charId);
  return CHARACTERS[charId].skills.find(s => s.minMastery > m) || null;
}

function getPlayerStats(player) {
  const ch = CHARACTERS[player.active];
  if (!ch) return { atk: 50, def: 30, maxHp: 500 };
  const kb = getKoganeBonus(player);
  const eqBonus = getEquipmentBonus(player);
  const baseAtk = ch.atk + eqBonus.atk;
  const baseDef = ch.def + eqBonus.def;
  const baseHp = ch.maxHp + eqBonus.hp;
  if (player.active !== "itadori") return {
    atk: Math.floor(baseAtk * kb.atk),
    def: Math.floor(baseDef * kb.def * getDefMult(player.statusEffects)),
    maxHp: Math.floor(baseHp * kb.hp),
    spd: ch.spd,
  };
  const bonus = getFingerBonus(player.sukunaFingers || 0);
  return {
    atk: Math.floor((baseAtk + bonus.atkBonus) * kb.atk),
    def: Math.floor((baseDef + bonus.defBonus) * kb.def * getDefMult(player.statusEffects)),
    maxHp: Math.floor((baseHp + bonus.hpBonus) * kb.hp),
    spd: ch.spd,
  };
}

function masteryBar(mastery, charId) {
  const tiers = CHARACTERS[charId].skills.map(s => s.minMastery);
  const max = tiers[tiers.length - 1];
  if (mastery >= max) return "`[MAX]` 모든 스킬 해금!";
  const next = tiers.find(t => t > mastery) || max;
  const prev = [...tiers].reverse().find(t => t <= mastery) || 0;
  const fill = Math.round(((mastery - prev) / (next - prev)) * 10);
  return "`" + "█".repeat(Math.max(0, fill)) + "░".repeat(Math.max(0, 10 - fill)) + "`" + ` ${mastery}/${next}`;
}

function getLevel(xp) { return Math.floor(xp / 200) + 1; }

function hpBar(cur, max, len = 10) {
  const pct = Math.max(0, Math.min(1, (cur || 0) / Math.max(1, max)));
  const fill = Math.round(pct * len);
  const color = pct > 0.5 ? "🟩" : pct > 0.25 ? "🟨" : "🟥";
  return color.repeat(Math.max(0, fill)) + "⬛".repeat(Math.max(0, len - fill));
}

function hpBarText(cur, max, len = 12) {
  const fill = Math.round((Math.max(0, cur || 0) / Math.max(1, max)) * len);
  return "`" + "█".repeat(Math.max(0, fill)) + "░".repeat(Math.max(0, len - fill)) + "`";
}

function isMakiAwakened(player) {
  if (player.active !== "maki") return false;
  const stats = getPlayerStats(player);
  return (player.hp || 0) <= Math.floor(stats.maxHp * CHARACTERS["maki"].awakening.threshold);
}

function calcDmg(atk, def, mult = 1) {
  const variance = 0.70 + Math.random() * 0.60;
  return Math.max(1, Math.floor((atk * variance - def * 0.22) * mult));
}

function calcDmgForPlayer(player, enemyDef, baseMult = 1) {
  const stats = getPlayerStats(player);
  let mult = baseMult * getWeakenMult(player.statusEffects);
  if (isMakiAwakened(player)) mult *= CHARACTERS["maki"].awakening.dmgMult;
  return calcDmg(stats.atk, enemyDef, mult);
}

function calcSkillDmgForPlayer(player, baseSkillDmg, skillName = "") {
  let dmg = baseSkillDmg + Math.floor(Math.random() * 60);
  dmg = Math.floor(dmg * getWeakenMult(player.statusEffects));
  if (isMakiAwakened(player)) dmg = Math.floor(dmg * CHARACTERS["maki"].awakening.dmgMult);
  if (player.active === "itadori") {
    const bonus = getFingerBonus(player.sukunaFingers || 0);
    dmg = Math.floor(dmg * (1 + bonus.atkBonus / 120));
  }
  const kb = getKoganeBonus(player);
  dmg = Math.floor(dmg * kb.atk);

  // 각성 스킬 배율 적용
  if (skillName && player.active) {
    const awakData = SKILL_AWAKENING[player.active];
    if (awakData && awakData[skillName] && isSkillAwakened(player, player.active, skillName)) {
      dmg = Math.floor(dmg * awakData[skillName].dmgMult);
    }
  }

  // 흑섬 크리티컬 체크
  let blazeBonus = 0;
  let blazeMsg = null;
  if (checkBlazeOfBlack(player)) {
    blazeBonus = Math.floor(dmg * 0.5);
    dmg += blazeBonus;
    blazeMsg = `⚡ **흑섬 크리티컬!** +${blazeBonus} 추가 피해! (스택 초기화)`;
  }

  return { dmg, blazeMsg };
}

function applySkillStatus(skill, defenderObj, attackerObj = null) {
  if (!skill || !skill.statusApply) return [];
  const { target, statusId, chance } = skill.statusApply;
  if (Math.random() > chance) return [];
  const def = STATUS_EFFECTS[statusId];
  if (!def) return [];
  if (target === "enemy") {
    if (!defenderObj.statusEffects) defenderObj.statusEffects = [];
    applyStatus(defenderObj, statusId);
    return [`${def.emoji} **${def.name}** 상태이상 적용! (${def.duration}턴)`];
  }
  if (target === "self" && attackerObj) {
    applyStatus(attackerObj, statusId);
    return [`${def.emoji} **${def.name}** 발동! (${def.duration}턴)`];
  }
  return [];
}

// 각성된 스킬의 상태이상 적용
function applyAwakenedSkillStatus(player, charId, skillName, defenderObj, attackerObj = null) {
  const awakData = SKILL_AWAKENING[charId];
  if (!awakData || !awakData[skillName]) return [];
  if (!isSkillAwakened(player, charId, skillName)) return [];
  const newStatus = awakData[skillName].newStatus;
  if (!newStatus) return [];
  const fakeSkill = { statusApply: newStatus };
  return applySkillStatus(fakeSkill, defenderObj, attackerObj);
}

function tickCooldowns(player) {
  if (player.reverseCooldown > 0) player.reverseCooldown--;
  if (player.skillCooldown > 0) player.skillCooldown--;
}

// ════════════════════════════════════════════════════════
// ── 파티 유틸
// ════════════════════════════════════════════════════════
function getPartyId(userId) {
  return Object.keys(parties).find(pid => parties[pid] && parties[pid].members && parties[pid].members.includes(userId)) || null;
}
function getParty(userId) {
  const pid = getPartyId(userId);
  return pid ? parties[pid] : null;
}

function getPvpSessionByUser(userId) { return Object.values(pvpSessions).find(s => s.p1Id === userId || s.p2Id === userId) || null; }

function pvpOpponent(session, userId) {
  if (session.p1Id === userId) return { id: session.p2Id, hpKey: "hp2", statusKey: "status2", skillCdKey: "skillCd2", reverseCdKey: "reverseCd2", domainKey: "domainUsed2" };
  return { id: session.p1Id, hpKey: "hp1", statusKey: "status1", skillCdKey: "skillCd1", reverseCdKey: "reverseCd1", domainKey: "domainUsed1" };
}
function pvpSelf(session, userId) {
  if (session.p1Id === userId) return { id: session.p1Id, hpKey: "hp1", statusKey: "status1", skillCdKey: "skillCd1", reverseCdKey: "reverseCd1", domainKey: "domainUsed1" };
  return { id: session.p2Id, hpKey: "hp2", statusKey: "status2", skillCdKey: "skillCd2", reverseCdKey: "reverseCd2", domainKey: "domainUsed2" };
}

function getCullingPool(wave) {
  if (wave <= 3) return ["e1", "e1", "e1", "e2"];
  if (wave <= 7) return ["e1", "e2", "e2", "e2", "e3"];
  if (wave <= 14) return ["e2", "e2", "e3", "e3", "e3"];
  return ["e2", "e3", "e3", "e4", "e4"];
}

function pickCullingEnemy(wave) {
  const pool = getCullingPool(wave);
  const id = pool[Math.floor(Math.random() * pool.length)];
  const base = ENEMIES.find(e => e.id === id);
  if (!base) return { ...ENEMIES[0], currentHp: ENEMIES[0].hp, statusEffects: [] };
  const scale = 1 + (wave - 1) * 0.05;
  return {
    ...base,
    hp: Math.floor(base.hp * scale),
    atk: Math.floor(base.atk * scale),
    def: Math.floor(base.def * scale),
    xp: Math.floor(base.xp * scale),
    crystals: Math.floor(base.crystals * scale),
    currentHp: Math.floor(base.hp * scale),
    statusEffects: [],
  };
}

function generateJujutsuChoices(wave) {
  const pool = wave <= 3 ? ["j1", "j1", "j2", "j3"]
    : wave <= 7 ? ["j2", "j3", "j3", "j4"]
      : wave <= 12 ? ["j3", "j4", "j4", "j5"]
        : ["j4", "j5", "j5", "j6"];
  const ids = [];
  for (const id of [...pool].sort(() => Math.random() - 0.5)) {
    if (!ids.includes(id)) ids.push(id);
    if (ids.length === 3) break;
  }
  while (ids.length < 3) {
    const fb = pool[Math.floor(Math.random() * pool.length)];
    if (!ids.includes(fb)) ids.push(fb);
  }
  return ids.slice(0, 3).map(id => {
    const base = JUJUTSU_ENEMIES.find(e => e.id === id);
    if (!base) return JUJUTSU_ENEMIES[0];
    const scale = 1 + (wave - 1) * 0.04;
    return { ...base, hp: Math.floor(base.hp * scale), atk: Math.floor(base.atk * scale), def: Math.floor(base.def * scale), xp: Math.floor(base.xp * scale), crystals: Math.floor(base.crystals * scale), statusEffects: [] };
  });
}

// ════════════════════════════════════════════════════════
// ── 임베드 함수들
// ════════════════════════════════════════════════════════
function profileEmbed(player) {
  const ch = CHARACTERS[player.active];
  if (!ch) return new EmbedBuilder().setTitle("오류").setDescription("캐릭터 데이터 없음");
  const stats = getPlayerStats(player);
  const skill = getCurrentSkill(player, player.active);
  const next = getNextSkill(player, player.active);
  const mastery = getMastery(player, player.active);
  const awakened = isMakiAwakened(player);
  const lv = getLevel(player.xp);
  const hpPct = Math.max(0, player.hp || 0) / Math.max(1, stats.maxHp);
  const xpNow = (player.xp || 0) % 200;
  const fingers = player.sukunaFingers || 0;
  const fingerBonus = getFingerBonus(fingers);
  const kb = getKoganeBonus(player);
  const kogane = player.kogane;
  const kg = kogane ? KOGANE_GRADES[kogane.grade] : null;
  const gradeInfo = GACHA_RARITY[ch.grade] || GACHA_RARITY["3급"];
  const eqBonus = getEquipmentBonus(player);
  const corruption = player.corruption || 0;

  const HP_LEN = 18;
  const hpFill = Math.round(hpPct * HP_LEN);
  const hpColor = hpPct > 0.6 ? "🟢" : hpPct > 0.3 ? "🟡" : "🔴";
  const hpBarStr = `${hpColor} \`${"█".repeat(Math.max(0, hpFill))}${"░".repeat(Math.max(0, HP_LEN - hpFill))}\` **${Math.max(0, player.hp || 0)}**/**${stats.maxHp}**`;

  const XP_LEN = 18;
  const xpFill = Math.round((xpNow / 200) * XP_LEN);
  const xpBarStr = `📊 \`${"▰".repeat(Math.max(0, xpFill))}${"▱".repeat(Math.max(0, XP_LEN - xpFill))}\` **${xpNow}**/200`;

  const themes = {
    "특급": { top: "╔══════ 🔱 SPECIAL GRADE 🔱 ══════╗", mid: "╠════════════════════════════════╣", bot: "╚════════════════════════════════╝", badge: "[ L E G E N D A R Y ]" },
    "준특급": { top: "╔══════ 💠 SEMI-SPECIAL 💠 ════════╗", mid: "╠════════════════════════════════╣", bot: "╚════════════════════════════════╝", badge: "[ E P I C ]" },
    "1급": { top: "╔══════ ⭐ GRADE-1 ⭐ ══════════════╗", mid: "╠════════════════════════════════╣", bot: "╚════════════════════════════════╝", badge: "[ R A R E ]" },
    "준1급": { top: "╔══════ ⭐ SEMI GRADE-1 ⭐ ══════════╗", mid: "╠════════════════════════════════╣", bot: "╚════════════════════════════════╝", badge: "[ R A R E ]" },
    "2급": { top: "╔══════ 🔹 GRADE-2 🔹 ══════════════╗", mid: "╠════════════════════════════════╣", bot: "╚════════════════════════════════╝", badge: "[ U N C O M M O N ]" },
    "3급": { top: "╔══════ ◽ GRADE-3 ◽ ══════════════╗", mid: "╠════════════════════════════════╣", bot: "╚════════════════════════════════╝", badge: "[ C O M M O N ]" },
  };
  const th = themes[ch.grade] || themes["3급"];

  const skillIcons = ["∞", "↗", "✳", "⊕", "⬡", "◈"];
  const skillListLines = CHARACTERS[player.active].skills.map((s, idx) => {
    const unlocked = mastery >= s.minMastery;
    const isCurrent = skill.name === s.name;
    const fingerLock = s.name === "스쿠나 발현" && fingers < 10;
    const ok = unlocked && !fingerLock;
    const icon = ok ? skillIcons[idx] || "◆" : "🔒";
    const statusNote = s.statusApply ? ` [${STATUS_EFFECTS[s.statusApply.statusId]?.emoji}${Math.round(s.statusApply.chance * 100)}%]` : "";
    const curMark = isCurrent ? " ◀ 현재" : "";
    const awokenMark = isSkillAwakened(player, player.active, s.name) ? " ✨각성" : "";
    return `> ${icon} **${s.name}**${statusNote}${curMark}${awokenMark}\n> ⠀  *${s.desc}*`;
  }).join("\n");

  const awakeBanner = awakened ? `\n║  🔥 ≪ 천여주박 각성 ≫ — DMG×2  ║` : "";
  const cardBlock = [
    "```",
    th.top,
    `║  ${ch.emoji}  ${ch.name.padEnd(26)}  ║`,
    `║  ${gradeInfo.stars}  ${th.badge.padEnd(22)}  ║`,
    `║  ${(ch.lore || ch.desc).slice(0, 34).padEnd(34)}  ║`,
    th.mid,
    `║  🗡 ATK ${String(stats.atk).padEnd(6)} 🛡 DEF ${String(stats.def).padEnd(6)} 💨 SPD ${String(ch.spd).padEnd(4)}  ║`,
    `║  🌌 영역: ${(ch.domain || "없음").padEnd(24)}  ║`,
    awakeBanner,
    th.bot,
    "```",
  ].filter(Boolean).join("\n");

  const fingerBar = fingers > 0
    ? `> 👹 **스쿠나 손가락** \`${"█".repeat(fingers)}${"░".repeat(SUKUNA_FINGER_MAX - fingers)}\` **${fingers}/${SUKUNA_FINGER_MAX}** — ${fingerBonus.label}`
    : "";

  const koganeLine = kogane && kg
    ? `> ${kg.emoji} **코가네 [${kogane.grade}]** — ${kg.passiveDesc}`
    : `> 🐾 코가네 없음 — \`!코가네가챠\` (200💎)`;

  const eqLine = Object.keys(player.equipment || {}).length > 0
    ? `> ⚔️ **장비** ATK+${eqBonus.atk} DEF+${eqBonus.def} HP+${eqBonus.hp}`
    : `> ⚔️ 장비 없음 — \`!장비제작\`으로 제작`;

  const corruptLine = `> 🖤 **타락** ${getCorruptionLabel(corruption)} \`${corruption}/${CORRUPTION_MAX}\``;
  const blazeLine = `> ⚡ **흑섬 스택** \`${player.blazeStack || 0}\`/10 (${Math.min(30, 5 + (player.blazeStack || 0) * 3)}% 크리 확률)`;

  const embed = new EmbedBuilder()
    .setTitle(awakened
      ? `🔥 ≪ 천여주박 각성 ≫  ${player.name}의 카드`
      : `${gradeInfo.effect}  ${player.name}의 주술사 카드  ${gradeInfo.effect}`)
    .setColor(awakened ? 0xFF2200 : gradeInfo.color)
    .setDescription([cardBlock, koganeLine, fingerBar, eqLine].filter(Boolean).join("\n"))
    .addFields({
      name: "┌─ 🏅 주술사 정보 ─────────────────┐",
      value: [
        `> 🎖️ **LV.${lv}**  /  총 XP: **${player.xp || 0}**`,
        `> ${xpBarStr}`,
        `> 💎 **${player.crystals}** 크리스탈   🧪 회복약 **${player.potion}개**`,
        `> ⚔️ 일반 \`${player.wins}승 ${player.losses}패\`   /   PvP \`${player.pvpWins}승 ${player.pvpLosses}패\``,
        `> 🌊 컬링 최고 WAVE: **${player.cullingBest}**   🎯 사멸회유: **${player.jujutsuBest}pt**`,
      ].join("\n"),
      inline: false,
    })
    .addFields({
      name: "┌─ 💚 전투 상태 ───────────────────┐",
      value: [
        `> ${hpBarStr}`,
        `> 🩸 상태이상: **${statusStr(player.statusEffects)}**`,
        `> ⚡ 술식 CD: ${player.skillCooldown > 0 ? `**${player.skillCooldown}턴**` : "✅ 즉시 가능"}   ♻ 반전 CD: ${player.reverseCooldown > 0 ? `**${player.reverseCooldown}턴**` : "✅ 즉시 가능"}`,
        corruptLine,
        blazeLine,
        kogane && kg ? `> 🐾 코가네: ATK×${kb.atk.toFixed(2)} DEF×${kb.def.toFixed(2)} HP×${kb.hp.toFixed(2)}` : "",
      ].filter(Boolean).join("\n"),
      inline: false,
    })
    .addFields({
      name: "┌─ 🌀 SKILLS ───────────────────────┐",
      value: [
        skillListLines,
        `> 📈 숙련도: ${masteryBar(mastery, player.active)}`,
        next ? `> ⬆️ 다음 해금: **${next.name}** *(숙련 ${next.minMastery} 필요)*` : `> 🏆 **모든 스킬 해금 완료!**`,
      ].join("\n"),
      inline: false,
    })
    .addFields({
      name: "┌─ 📦 보유 캐릭터 ──────────────────┐",
      value: player.owned.map(id => {
        const c = CHARACTERS[id];
        if (!c) return "";
        const m = getMastery(player, id);
        const cur = getCurrentSkill(player, id);
        const ri = GACHA_RARITY[c.grade] || GACHA_RARITY["3급"];
        return `> ${id === player.active ? "▶️" : "　"} ${c.emoji} **${c.name}** \`${c.grade}\` ${ri.stars} · 숙련 \`${m}\` · \`${cur.name}\``;
      }).filter(Boolean).join("\n") || "> 없음",
      inline: false,
    })
    .setFooter({ text: `!전투 !컬링 !사멸회유 !결투 !파티 !가챠 !코가네가챠 !출석 !손가락 !임무 !레이드 | ${player.name}` })
    .setTimestamp();

  return embed;
}

function koganeProfileEmbed(player) {
  const kogane = player.kogane;
  if (!kogane) {
    return new EmbedBuilder()
      .setTitle("🐾 코가네 — 황금 개 펫")
      .setColor(0x4a5568)
      .setDescription([
        "```",
        "╔══════════════════════════════╗",
        "║    🐾  코가네 미획득  🐾     ║",
        "╚══════════════════════════════╝",
        "```",
        "> **코가네**는 황금 개 펫으로, 전투를 보조합니다!",
        "> 💎 **200 크리스탈** 로 `!코가네가챠` 를 사용해 소환하세요.",
        "> 등급: 🌟전설 / 🔶특급 / 🔷1급 / 🟢2급 / ⚪3급",
      ].join("\n"))
      .setFooter({ text: "!코가네가챠 (200💎)" });
  }
  const g = KOGANE_GRADES[kogane.grade];
  return new EmbedBuilder()
    .setTitle(`${g.emoji} 코가네 — [${kogane.grade}] ${g.stars}`)
    .setColor(g.color)
    .setDescription([
      "```",
      `╔══════════════════════════════════╗`,
      `║  ${g.emoji}  코가네  [${kogane.grade}]  ${g.stars}  ║`,
      `║  황금 개 — 나의 충실한 파트너   ║`,
      `╚══════════════════════════════════╝`,
      "```",
      `> **패시브 보너스:** ${g.passiveDesc}`,
      `> **전투 스킬:** 🐾 **${g.skill}** — ${g.skillDesc}`,
      `> **발동 확률:** ${Math.round(g.skillChance * 100)}%`,
    ].join("\n"))
    .addFields(
      { name: "📊 스탯 보너스", value: `> 🗡️ ATK **+${Math.round(g.atkBonus * 100)}%**\n> 🛡️ DEF **+${Math.round(g.defBonus * 100)}%**\n> 💚 HP **+${Math.round(g.hpBonus * 100)}%**`, inline: true },
      { name: "📈 보상 보너스", value: `> ⭐ XP **+${Math.round(g.xpBonus * 100)}%**\n> 💎 크리스탈 **+${Math.round(g.crystalBonus * 100)}%**`, inline: true },
      { name: "🎲 가챠 횟수", value: `> 총 **${player.koganeGachaCount || 0}**회 소환`, inline: true },
    )
    .setFooter({ text: "!코가네가챠 (200💎) — 더 좋은 등급 획득 시 자동 교체" });
}

function koganeGachaEmbed(grade, isUpgrade, player) {
  const g = KOGANE_GRADES[grade];
  const gradeOrder = ["3급", "2급", "1급", "특급", "전설"];
  const oldGrade = player.kogane?.grade;
  const upgraded = isUpgrade && oldGrade && gradeOrder.indexOf(grade) > gradeOrder.indexOf(oldGrade);
  return new EmbedBuilder()
    .setTitle(upgraded ? `${g.emoji} 코가네 등급 상승! ${oldGrade} → ${grade}!` : `${g.emoji} 코가네 소환! [${grade}]`)
    .setColor(g.color)
    .setDescription([
      "```",
      `╔════════════════════════════════════╗`,
      upgraded
        ? `║  ⬆️  등급 상승!!  ${oldGrade} → ${grade}  ⬆️  ║`
        : `║  ${g.emoji}  코가네 [${grade}]  ${g.stars}  ║`,
      `║  🐾  황금 개 코가네 소환 완료!    ║`,
      `╚════════════════════════════════════╝`,
      "```",
      `> **패시브:** ${g.passiveDesc}`,
      `> **스킬:** ${g.skill} — ${g.skillDesc}`,
      !upgraded && oldGrade ? `\n> ⚠️ 기존 코가네보다 낮은 등급 — **교체되지 않았습니다.**\n> 💎 **+50** 보상 크리스탈 지급!` : "",
    ].filter(Boolean).join("\n"))
    .setFooter({ text: `총 소환 횟수: ${player.koganeGachaCount}회 | 잔여 크리스탈: ${player.crystals}` });
}

function gachaLoadingEmbed(stage = 1) {
  const frames = [
    {
      title: "🔮 주술 소환 의식 — 준비",
      color: 0x0a0a1e,
      desc: [
        "```ansi",
        "\u001b[2;30m╔══════════════════════════════════════╗",
        "\u001b[2;34m║       ？    ？    ？    ？    ？      ║",
        "\u001b[2;30m╚══════════════════════════════════════╝",
        "```",
        "> *저주 에너지가 수렴하기 시작한다...*",
        "> `◆` 술식 증폭 중...",
      ].join("\n"),
    },
    {
      title: "⚡ 저주 에너지 최대 수렴 중...",
      color: 0x1a0533,
      desc: [
        "```ansi",
        "\u001b[1;35m╔══════════════════════════════════════╗",
        "\u001b[1;35m║  ⚡        ⚡        ⚡        ⚡  ║",
        "\u001b[1;33m║       ✦        ✦        ✦       ║",
        "\u001b[1;35m║  ⚡        ？？？        ⚡     ║",
        "\u001b[1;35m╚══════════════════════════════════════╝",
        "```",
        "> *주술 에너지가 임계점에 도달한다...*",
      ].join("\n"),
    },
  ];
  const f = frames[stage - 1] || frames[0];
  return new EmbedBuilder().setTitle(f.title).setColor(f.color).setDescription(f.desc);
}

function gachaRevealEmbed(grade) {
  const info = GACHA_RARITY[grade] || GACHA_RARITY["3급"];
  const revealArt = {
    "특급": "```ansi\n\u001b[1;33m╔═══════════════════════════════════════╗\n\u001b[1;33m║  ⚡ ⚡ ⚡  L E G E N D A R Y  ⚡ ⚡ ⚡  ║\n\u001b[1;31m║    ★ ★ ★ ★ ★    ???    ★ ★ ★ ★ ★    ║\n\u001b[1;33m╚═══════════════════════════════════════╝\n```",
    "준특급": "```ansi\n\u001b[1;34m╔══════════════════════════════════════╗\n\u001b[1;34m║  💠 💠 💠   E P I C   💠 💠 💠   ║\n\u001b[1;34m║    ★ ★ ★ ★      ???      ★ ★ ★ ★    ║\n\u001b[1;34m╚══════════════════════════════════════╝\n```",
    "1급": "```ansi\n\u001b[1;35m╔══════════════════════════════════╗\n\u001b[1;35m║  ★ ★ ★   R A R E   ★ ★ ★     ║\n\u001b[1;37m║         ???                      ║\n\u001b[1;35m╚══════════════════════════════════╝\n```",
  };
  const art = revealArt[grade] || "```\n??? 등장!\n```";
  return new EmbedBuilder()
    .setTitle(`${info.effect} ${grade} 등급의 기운이 느껴진다!`)
    .setColor(info.color)
    .setDescription(art + `\n> *${info.stars}  —  ${info.flash}!*`);
}

function gachaResultEmbed(charId, isNew, player) {
  const ch = CHARACTERS[charId];
  const info = GACHA_RARITY[ch.grade] || GACHA_RARITY["3급"];
  const skill = getCurrentSkill(player, charId);
  return new EmbedBuilder()
    .setTitle(isNew
      ? `${info.effect} ✨ NEW! — ${ch.name} 획득!`
      : `${info.effect} 중복 — ${ch.name} (+50💎 보상)`)
    .setColor(isNew ? info.color : 0x4a5568)
    .setDescription([
      "```",
      `╔══════════════════════════════════╗`,
      `║  ${ch.emoji}  ${ch.name.padEnd(26)}  ║`,
      `║  ${info.stars}  ${JJK_GRADE_LABEL[ch.grade] ? JJK_GRADE_LABEL[ch.grade].padEnd(20) : ""}  ║`,
      `╚══════════════════════════════════╝`,
      "```",
      `> *"${ch.lore || ch.desc}"*`,
    ].join("\n"))
    .addFields(
      { name: "🌌 영역전개", value: ch.domain || "없음", inline: true },
      { name: "🔥 초기 술식", value: `\`${skill.name}\`  (피해 ${skill.dmg})`, inline: true },
      { name: "📖 설명", value: ch.desc, inline: false },
    )
    .setFooter({ text: `💎 잔여 크리스탈: ${player.crystals}  ·  !가챠10 으로 10연차!` });
}

function gacha10ResultEmbed(results, newOnes, dupCrystals, player) {
  const sorted = [...results].sort((a, b) => {
    const order = ["특급", "준특급", "1급", "준1급", "2급", "3급", "4급"];
    return order.indexOf(CHARACTERS[a]?.grade) - order.indexOf(CHARACTERS[b]?.grade);
  });
  const lines = sorted.map(id => {
    const ch = CHARACTERS[id];
    if (!ch) return "";
    const info = GACHA_RARITY[ch.grade] || GACHA_RARITY["3급"];
    const isN = newOnes.includes(id);
    return `${ch.emoji} ${info.stars} **${ch.name}** \`[${ch.grade}]\`${isN ? " **✨NEW!**" : ""}`;
  }).filter(Boolean);
  const legendaries = results.filter(id => CHARACTERS[id]?.grade === "특급");
  return new EmbedBuilder()
    .setTitle(legendaries.length > 0 ? `🔱 ⚡⚡ 10연차 — 전설 등급 획득!! ⚡⚡ 🔱` : `🎲 10회 주술 소환 결과`)
    .setColor(legendaries.length > 0 ? 0xF5C842 : 0x7c5cfc)
    .setDescription(lines.join("\n"))
    .addFields(
      { name: "✨ 신규 획득", value: newOnes.length ? newOnes.map(id => `${CHARACTERS[id]?.emoji || ""} ${CHARACTERS[id]?.name || id}`).join(", ") : "없음", inline: true },
      { name: "🔄 중복 보상", value: `**+${dupCrystals}** 💎`, inline: true },
      { name: "💎 잔여 크리스탈", value: `**${player.crystals}**`, inline: true },
    )
    .setFooter({ text: "!가챠 1회(150💎) | !가챠10 10회(1350💎) | 스쿠나는 가챠 풀에 없음" });
}

function skillEmbed(player) {
  const id = player.active;
  const ch = CHARACTERS[id];
  if (!ch) return new EmbedBuilder().setTitle("오류").setDescription("캐릭터 없음");
  const mastery = getMastery(player, id);
  const awakened = isMakiAwakened(player);
  const fingers = player.sukunaFingers || 0;
  return new EmbedBuilder()
    .setTitle(`${ch.emoji} ≪ 술식 트리 ≫ ${ch.name}${awakened ? "  🔥[각성]" : ""}`)
    .setColor(awakened ? 0xFF2200 : JJK_GRADE_COLOR[ch.grade])
    .setDescription([
      `> ${ch.lore || ch.desc}`,
      `> 📈 **숙련도** ${masteryBar(mastery, id)}`,
      `> 🌌 **영역전개** \`${ch.domain || "없음"}\``,
      id === "itadori" ? `> 👹 **스쿠나 손가락** \`${fingers}/${SUKUNA_FINGER_MAX}\` — ${getFingerBonus(fingers).label}` : "",
      awakened ? `> 🔥 **천여주박 각성 중** — 모든 데미지 **2배**!` : "",
      `> ⚡ **흑섬 스택** \`${player.blazeStack || 0}\`/10 — 크리 확률 \`${Math.min(30, 5 + (player.blazeStack || 0) * 3)}%\``,
    ].filter(Boolean).join("\n"))
    .addFields(ch.skills.map((s, idx) => {
      const unlocked = mastery >= s.minMastery;
      const fingerLock = s.name === "스쿠나 발현" && fingers < 10;
      const available = unlocked && !fingerLock;
      const fx = getSkillEffect(s.name);
      const statusNote = s.statusApply ? ` \`${STATUS_EFFECTS[s.statusApply.statusId]?.emoji}${STATUS_EFFECTS[s.statusApply.statusId]?.name} ${Math.round(s.statusApply.chance * 100)}%\`` : "";
      const dmgDisplay = awakened ? `~~${s.dmg}~~ → **${s.dmg * 2}**🔥` : `**${s.dmg}**`;
      const selfBuff = s.statusApply?.target === "self" ? " 🔰자기버프" : "";
      const awokenInfo = SKILL_AWAKENING[id]?.[s.name];
      const isAwoken = isSkillAwakened(player, id, s.name);
      const awakenNote = awokenInfo ? (isAwoken ? ` ✨**[각성완료]** ×${awokenInfo.dmgMult}` : ` *(각성 가능: 숙련${awokenInfo.masteryRequired} 필요, ${awokenInfo.crystalCost}💎)*`) : "";
      return {
        name: `${available ? `✅ [${idx + 1}]` : "🔒"} ${isAwoken ? awokenInfo.awakenedName : s.name}  —  피해 ${dmgDisplay}${statusNote}${selfBuff}${awakenNote}  *(숙련 ${s.minMastery} 필요)*`,
        value: [
          `> ${isAwoken ? awokenInfo.newDesc : s.desc}`,
          available ? fx.art : `> ${!unlocked ? "🔒 숙련도 부족" : "👹 손가락 10개 이상 필요"}`,
          available ? `> *${fx.flavorText}*` : "",
        ].filter(Boolean).join("\n"),
        inline: false,
      };
    }))
    .setFooter({ text: "전투/컬링 승리 시 숙련도 상승! | !술식각성 [스킬명] 으로 각성" });
}

function cullingEmbed(player, session, log = []) {
  const ch = CHARACTERS[player.active];
  if (!ch || !session || !session.currentEnemy) return new EmbedBuilder().setTitle("오류").setDescription("세션 없음");
  const stats = getPlayerStats(player);
  const enemy = session.currentEnemy;
  const awakened = isMakiAwakened(player);
  return new EmbedBuilder()
    .setTitle(`${awakened ? "🔥 " : ""}⚔️ 컬링 게임 — 🌊 WAVE ${session.wave}`)
    .setColor(awakened ? 0xFF2200 : session.wave >= 15 ? 0xF5C842 : session.wave >= 8 ? 0xe63946 : 0x7C5CFC)
    .setDescription(log.join("\n") || "⚔️ 새 파도가 밀려온다!")
    .addFields(
      { name: `${ch.emoji} 내 HP`, value: `${hpBar(player.hp || 0, stats.maxHp)} \`${Math.max(0, player.hp || 0)}/${stats.maxHp}\`${awakened ? " 🔥각성" : ""}\n상태: ${statusStr(player.statusEffects)}\n⚡술식: \`${player.skillCooldown > 0 ? player.skillCooldown + "턴" : "가능"}\` ♻반전: \`${player.reverseCooldown > 0 ? player.reverseCooldown + "턴" : "가능"}\`\n⚡흑섬스택: \`${player.blazeStack || 0}\`/10`, inline: true },
      { name: `${enemy.emoji} ${enemy.name}`, value: `${hpBar(session.enemyHp || 0, enemy.hp)} \`${Math.max(0, session.enemyHp || 0)}/${enemy.hp}\`\n상태: ${statusStr(enemy.statusEffects || [])}`, inline: true },
      { name: "📊 현황", value: `WAVE **${session.wave}** | 처치 **${session.kills}** | **${session.totalXp}** XP / **${session.totalCrystals}**💎\n🖤 타락: **${player.corruption || 0}/${CORRUPTION_MAX}** ${getCorruptionLabel(player.corruption || 0)}`, inline: false },
    )
    .setFooter({ text: `현재 스킬: ${getCurrentSkill(player, player.active).name} | 최고기록: WAVE ${player.cullingBest}` });
}

function jujutsuEmbed(player, session, log = [], choices = null) {
  const ch = CHARACTERS[player.active];
  if (!ch || !session) return new EmbedBuilder().setTitle("오류").setDescription("세션 없음");
  const stats = getPlayerStats(player);
  const awakened = isMakiAwakened(player);
  const embed = new EmbedBuilder()
    .setTitle(`🎯 사멸회유 — WAVE ${session.wave} | 포인트 **${session.points}**/15`)
    .setColor(session.points >= 10 ? 0xF5C842 : session.points >= 5 ? 0xff8c00 : 0x7C5CFC)
    .setDescription(log.join("\n") || "🎯 사멸회유 진행 중! 몹을 선택해 처치하세요.")
    .addFields(
      { name: `${ch.emoji} 내 HP`, value: `${hpBar(player.hp || 0, stats.maxHp)} \`${Math.max(0, player.hp || 0)}/${stats.maxHp}\`${awakened ? " 🔥각성" : ""}\n상태: ${statusStr(player.statusEffects)}\n⚡술식: \`${player.skillCooldown > 0 ? player.skillCooldown + "턴" : "가능"}\` ♻반전: \`${player.reverseCooldown > 0 ? player.reverseCooldown + "턴" : "가능"}\``, inline: false },
      { name: "🎯 포인트", value: `${"🟦".repeat(Math.min(session.points, 15))}${"⬜".repeat(Math.max(0, 15 - session.points))} **${session.points}/15**\n**${session.totalXp}** XP / **${session.totalCrystals}**💎`, inline: false },
    );
  if (session.currentEnemy) {
    const enemy = session.currentEnemy;
    embed.addFields({ name: `${enemy.emoji} 현재 적: ${enemy.name}`, value: `${hpBar(session.enemyHp || 0, enemy.hp)} \`${Math.max(0, session.enemyHp || 0)}/${enemy.hp}\`\n상태: ${statusStr(enemy.statusEffects || [])}\n포인트: +${enemy.points}점`, inline: false });
  }
  if (choices && choices.length > 0) embed.addFields({ name: "⚔️ 다음 적 선택", value: choices.map((c, i) => `**[${i + 1}]** ${c.emoji} ${c.name} — HP:\`${c.hp}\` ATK:\`${c.atk}\` | +${c.points}점\n└ ${c.desc}`).join("\n"), inline: false });
  embed.setFooter({ text: `최고기록: ${player.jujutsuBest}포인트 | 15포인트 달성 시 보너스!` });
  return embed;
}

function pvpEmbed(session, log = []) {
  if (!session || !players[session.p1Id] || !players[session.p2Id]) return new EmbedBuilder().setTitle("PvP 오류").setDescription("세션 없음");
  const p1 = players[session.p1Id];
  const p2 = players[session.p2Id];
  const ch1 = CHARACTERS[p1.active];
  const ch2 = CHARACTERS[p2.active];
  const s1 = getPlayerStats(p1);
  const s2 = getPlayerStats(p2);
  const aw1 = isMakiAwakened(p1);
  const aw2 = isMakiAwakened(p2);
  const turnName = session.turn === session.p1Id ? p1.name : p2.name;
  return new EmbedBuilder()
    .setTitle(`⚔️ PvP 결투  ${p1.name} VS ${p2.name}`)
    .setColor(0xF5C842)
    .setDescription(log.join("\n") || "⚔️ 결투 시작!")
    .addFields(
      { name: `${ch1.emoji} ${p1.name} [${ch1.grade}]${aw1 ? " 🔥" : ""}`, value: `${hpBar(session.hp1, s1.maxHp)} \`${Math.max(0, session.hp1)}/${s1.maxHp}\`\n상태: ${statusStr(session.status1)}\n⚡술식: \`${session.skillCd1 > 0 ? session.skillCd1 + "턴" : "가능"}\` ♻반전: \`${session.reverseCd1 > 0 ? session.reverseCd1 + "턴" : "가능"}\``, inline: true },
      { name: `${ch2.emoji} ${p2.name} [${ch2.grade}]${aw2 ? " 🔥" : ""}`, value: `${hpBar(session.hp2, s2.maxHp)} \`${Math.max(0, session.hp2)}/${s2.maxHp}\`\n상태: ${statusStr(session.status2)}\n⚡술식: \`${session.skillCd2 > 0 ? session.skillCd2 + "턴" : "가능"}\` ♻반전: \`${session.reverseCd2 > 0 ? session.reverseCd2 + "턴" : "가능"}\``, inline: true },
      { name: "🎯 현재 턴", value: `**${turnName}**의 차례 (라운드 ${session.round})`, inline: false },
    )
    .setFooter({ text: "술식: 5턴 쿨다운 | 반전술식: 3턴 쿨다운 (고조/유타 전용) | 회피율 5%" });
}

function partyCullingEmbed(party, session, log = []) {
  if (!party || !session || !session.currentEnemy) return new EmbedBuilder().setTitle("오류").setDescription("파티 세션 없음");
  const enemy = session.currentEnemy;
  const memberLines = party.members.map(uid => {
    const p = players[uid];
    if (!p) return `> ❓ 알 수 없음 (${uid})`;
    const ch = CHARACTERS[p.active];
    if (!ch) return `> ❓ ${p.name} (캐릭터 없음)`;
    const stats = getPlayerStats(p);
    const awakened = isMakiAwakened(p);
    const isLeader = party.leader === uid;
    const hpPct = Math.max(0, p.hp || 0) / Math.max(1, stats.maxHp);
    const hpIcon = hpPct > 0.5 ? "🟢" : hpPct > 0.25 ? "🟡" : "🔴";
    return `> ${isLeader ? "👑" : "👤"} **${p.name}** ${ch.emoji} ${hpIcon} \`${Math.max(0, p.hp || 0)}/${stats.maxHp}\`${awakened ? " 🔥" : ""} | ${statusStr(p.statusEffects)} | ⚡${p.skillCooldown > 0 ? p.skillCooldown + "턴" : "가능"}`;
  }).join("\n");
  return new EmbedBuilder()
    .setTitle(`⚔️ [파티] 컬링 게임 — 🌊 WAVE ${session.wave}`)
    .setColor(session.wave >= 15 ? 0xF5C842 : session.wave >= 8 ? 0xe63946 : 0x7C5CFC)
    .setDescription(log.join("\n") || "⚔️ 파티 컬링 게임 진행 중!")
    .addFields(
      { name: `👥 파티원 (${party.members.length}명)`, value: memberLines || "없음", inline: false },
      { name: `${enemy.emoji} ${enemy.name}`, value: `${hpBar(Math.max(0, session.enemyHp || 0), enemy.hp)} \`${Math.max(0, session.enemyHp || 0)}/${enemy.hp}\` (ATK ${enemy.atk})\n상태: ${statusStr(enemy.statusEffects || [])}`, inline: false },
      { name: "📊 현황", value: `WAVE **${session.wave}** | 처치 **${session.kills}** | **${session.totalXp}** XP / **${session.totalCrystals}**💎`, inline: false },
    )
    .setFooter({ text: "파티원 누구나 버튼을 눌러 행동할 수 있습니다! | 파티원 전원 사망 시 종료" });
}

function raidEmbed(session, log = []) {
  if (!session) return new EmbedBuilder().setTitle("레이드 없음").setDescription("진행 중인 레이드가 없습니다.");
  const boss = session.boss;
  const bossHpPct = Math.max(0, session.bossHp / boss.hp);
  const topDealers = Object.entries(session.damageLog || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([uid, dmg], i) => `> ${["🥇","🥈","🥉","4️⃣","5️⃣"][i]} **${players[uid]?.name || uid}**: ${dmg.toLocaleString()} 피해`);
  return new EmbedBuilder()
    .setTitle(`🔥 ≪ 특급 레이드 ≫ ${boss.emoji} ${boss.name}`)
    .setColor(session.bossHp / boss.hp < 0.3 ? 0xff0000 : 0xF5C842)
    .setDescription(log.join("\n") || `${boss.emoji} 레이드 보스 등장! 협력해서 쓰러뜨려라!`)
    .addFields(
      { name: `${boss.emoji} 보스 HP`, value: `${hpBar(session.bossHp, boss.hp, 20)} \`${session.bossHp.toLocaleString()}/${boss.hp.toLocaleString()}\`\n상태: ${statusStr(session.statusEffects || [])}`, inline: false },
      { name: `👥 참가자 (${session.participants.length}명)`, value: session.participants.map(uid => {
        const p = players[uid];
        if (!p) return "> ❓ 알 수 없음";
        const ch = CHARACTERS[p.active];
        const stats = getPlayerStats(p);
        return `> **${p.name}** ${ch?.emoji || ""} \`${Math.max(0, p.hp || 0)}/${stats.maxHp}\` HP | 딜: ${(session.damageLog[uid] || 0).toLocaleString()}`;
      }).join("\n") || "> 없음", inline: false },
      { name: "📊 딜 기여도 TOP5", value: topDealers.join("\n") || "> 아직 없음", inline: false },
    )
    .setFooter({ text: `!레이드참가 로 참가 | !레이드공격 으로 공격 | 보스: ATK ${boss.atk} DEF ${boss.def}` });
}

function questEmbed(player) {
  initDailyQuests(player);
  initWeeklyQuests(player);
  const daily = player.questData?.daily || [];
  const weekly = player.questData?.weekly || [];

  const dailyLines = daily.map(q => {
    const bar = `\`${"█".repeat(Math.floor((q.progress / q.target) * 8))}${"░".repeat(Math.max(0, 8 - Math.floor((q.progress / q.target) * 8)))}\``;
    const status = q.claimed ? "✅완료" : q.completed ? "🎁수령가능" : `${bar} ${q.progress}/${q.target}`;
    return `> ${status} **${q.name}**\n> 보상: ${q.rewardCrystals}💎 ${q.rewardXp}XP`;
  }).join("\n");

  const weeklyLines = weekly.map(q => {
    const bar = `\`${"█".repeat(Math.floor((q.progress / q.target) * 8))}${"░".repeat(Math.max(0, 8 - Math.floor((q.progress / q.target) * 8)))}\``;
    const status = q.claimed ? "✅완료" : q.completed ? "🎁수령가능" : `${bar} ${q.progress}/${q.target}`;
    const matReward = q.rewardMaterials ? ` + ${Object.entries(q.rewardMaterials).map(([k,v]) => `${k} x${v}`).join(",")}` : "";
    return `> ${status} **${q.name}**\n> 보상: ${q.rewardCrystals}💎 ${q.rewardXp}XP${matReward}`;
  }).join("\n");

  return new EmbedBuilder()
    .setTitle("📋 주술고 임무 — 일일/주간 퀘스트")
    .setColor(0x4ade80)
    .addFields(
      { name: "🌅 일일 임무", value: dailyLines || "> 없음", inline: false },
      { name: "📅 주간 임무", value: weeklyLines || "> 없음", inline: false },
    )
    .setFooter({ text: "!임무수령 으로 완료된 임무 보상 받기 | 매일 자정 초기화" });
}

function craftEmbed(player) {
  const matStr = getMaterialStr(player.materials);
  const blueprintLines = Object.values(EQUIPMENT_BLUEPRINTS).map(bp => {
    const canCraft = hasMaterials(player, bp.materials);
    const matRequired = Object.entries(bp.materials).map(([k, v]) => `${k} x${v}`).join(", ");
    const owned = Object.values(player.equipment || {}).includes(bp.id);
    return `> ${canCraft ? "✅" : "❌"} **${bp.emoji} ${bp.id}** \`[${bp.grade}]\`${owned ? " (장착중)" : ""}\n> ATK+${bp.atkBonus} DEF+${bp.defBonus} HP+${bp.hpBonus} | ${bp.desc}\n> 재료: ${matRequired}`;
  }).join("\n\n");

  return new EmbedBuilder()
    .setTitle("⚔️ 주구(장비) 제작소")
    .setColor(0x7C5CFC)
    .setDescription([
      `> 📦 보유 재료: ${matStr}`,
      "",
      "**제작 가능 목록:**",
      blueprintLines,
    ].join("\n"))
    .setFooter({ text: "!제작 [장비명] 으로 제작 | 재료는 전투에서 드롭" });
}

// ════════════════════════════════════════════════════════
// ── 버튼 팩토리
// ════════════════════════════════════════════════════════
const mkBattleButtons = (player) => {
  const canSkill = !player || player.skillCooldown <= 0;
  const canReverse = !player || player.reverseCooldown <= 0;
  const hasReverse = !player || REVERSE_CHARS.has(player.active);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("b_attack").setLabel("⚔ 공격").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("b_skill").setLabel(`🌀 술식${canSkill ? "" : `(${player?.skillCooldown}턴)`}`).setStyle(ButtonStyle.Primary).setDisabled(!canSkill),
    new ButtonBuilder().setCustomId("b_domain").setLabel("🌌 영역전개").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("b_reverse").setLabel(`♻ 반전${canReverse ? "" : `(${player?.reverseCooldown}턴)`}`).setStyle(ButtonStyle.Secondary).setDisabled(!canReverse || !hasReverse),
    new ButtonBuilder().setCustomId("b_run").setLabel("🏃 도주").setStyle(ButtonStyle.Secondary),
  );
};

const mkCullingButtons = (player) => {
  const canSkill = !player || player.skillCooldown <= 0;
  const canReverse = !player || player.reverseCooldown <= 0;
  const hasReverse = !player || REVERSE_CHARS.has(player.active);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("c_attack").setLabel("⚔ 공격").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("c_skill").setLabel(`🌀 술식${canSkill ? "" : `(${player?.skillCooldown}턴)`}`).setStyle(ButtonStyle.Primary).setDisabled(!canSkill),
    new ButtonBuilder().setCustomId("c_domain").setLabel("🌌 영역전개").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("c_reverse").setLabel(`♻ 반전${canReverse ? "" : `(${player?.reverseCooldown}턴)`}`).setStyle(ButtonStyle.Secondary).setDisabled(!canReverse || !hasReverse),
    new ButtonBuilder().setCustomId("c_escape").setLabel("🏳 철수").setStyle(ButtonStyle.Secondary),
  );
};

const mkJujutsuButtons = (player, choices) => {
  const rows = [];
  if (choices && choices.length > 0) {
    const choiceRow = new ActionRowBuilder();
    for (let i = 0; i < Math.min(choices.length, 3); i++) {
      choiceRow.addComponents(
        new ButtonBuilder()
          .setCustomId(`j_choice_${i}`)
          .setLabel(`⚔️ ${choices[i].name.slice(0, 20)}`)
          .setStyle(ButtonStyle.Primary)
      );
    }
    rows.push(choiceRow);
  }
  const canSkill = !player || player.skillCooldown <= 0;
  const canReverse = !player || player.reverseCooldown <= 0;
  const hasReverse = !player || REVERSE_CHARS.has(player.active);
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("j_attack").setLabel("⚔ 공격").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("j_skill").setLabel(`🌀 술식${canSkill ? "" : `(${player?.skillCooldown}턴)`}`).setStyle(ButtonStyle.Primary).setDisabled(!canSkill),
    new ButtonBuilder().setCustomId("j_domain").setLabel("🌌 영역전개").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("j_reverse").setLabel(`♻ 반전${canReverse ? "" : `(${player?.reverseCooldown}턴)`}`).setStyle(ButtonStyle.Secondary).setDisabled(!canReverse || !hasReverse),
    new ButtonBuilder().setCustomId("j_escape").setLabel("🏳 철수").setStyle(ButtonStyle.Secondary),
  ));
  return rows;
};

const mkPvpButtons = (session, userId) => {
  const self = pvpSelf(session, userId);
  const canSkill = self.skillCdKey ? session[self.skillCdKey] <= 0 : true;
  const canReverse = self.reverseCdKey ? session[self.reverseCdKey] <= 0 : true;
  const player = players[userId];
  const hasReverse = REVERSE_CHARS.has(player?.active);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("p_attack").setLabel("⚔ 공격").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("p_skill").setLabel(`🌀 술식${canSkill ? "" : "(\u2716)"}`).setStyle(ButtonStyle.Primary).setDisabled(!canSkill),
    new ButtonBuilder().setCustomId("p_domain").setLabel("🌌 영역전개").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("p_reverse").setLabel(`♻ 반전${canReverse ? "" : "(\u2716)"}`).setStyle(ButtonStyle.Secondary).setDisabled(!canReverse || !hasReverse),
    new ButtonBuilder().setCustomId("p_surrender").setLabel("🏳 항복").setStyle(ButtonStyle.Secondary),
  );
};

const mkRaidButtons = () => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId("raid_attack").setLabel("⚔ 공격").setStyle(ButtonStyle.Danger),
  new ButtonBuilder().setCustomId("raid_skill").setLabel("🌀 술식").setStyle(ButtonStyle.Primary),
  new ButtonBuilder().setCustomId("raid_domain").setLabel("🌌 영역전개").setStyle(ButtonStyle.Success),
  new ButtonBuilder().setCustomId("raid_leave").setLabel("🚪 퇴장").setStyle(ButtonStyle.Secondary),
);
cat >> /home/claude/index.js << 'PART2_EOF'

// ════════════════════════════════════════════════════════
// ── 임베드 함수들
// ════════════════════════════════════════════════════════
function profileEmbed(player) {
  const ch = CHARACTERS[player.active];
  if (!ch) return new EmbedBuilder().setTitle("오류").setDescription("캐릭터 데이터 없음");
  const stats = getPlayerStats(player);
  const skill = getCurrentSkill(player, player.active);
  const next = getNextSkill(player, player.active);
  const mastery = getMastery(player, player.active);
  const awakened = isMakiAwakened(player);
  const lv = getLevel(player.xp);
  const hpPct = Math.max(0, player.hp || 0) / Math.max(1, stats.maxHp);
  const xpNow = (player.xp || 0) % 200;
  const fingers = player.sukunaFingers || 0;
  const fingerBonus = getFingerBonus(fingers);
  const kb = getKoganeBonus(player);
  const kogane = player.kogane;
  const kg = kogane ? KOGANE_GRADES[kogane.grade] : null;
  const gradeInfo = GACHA_RARITY[ch.grade] || GACHA_RARITY["3급"];
  const eqBonus = getEquipmentBonus(player);
  const corruption = player.corruption || 0;

  const HP_LEN = 18;
  const hpFill = Math.round(hpPct * HP_LEN);
  const hpColor = hpPct > 0.6 ? "🟢" : hpPct > 0.3 ? "🟡" : "🔴";
  const hpBarStr = `${hpColor} \`${"█".repeat(Math.max(0, hpFill))}${"░".repeat(Math.max(0, HP_LEN - hpFill))}\` **${Math.max(0, player.hp || 0)}**/**${stats.maxHp}**`;

  const XP_LEN = 18;
  const xpFill = Math.round((xpNow / 200) * XP_LEN);
  const xpBarStr = `📊 \`${"▰".repeat(Math.max(0, xpFill))}${"▱".repeat(Math.max(0, XP_LEN - xpFill))}\` **${xpNow}**/200`;

  const themes = {
    "특급": { top: "╔══════ 🔱 SPECIAL GRADE 🔱 ══════╗", mid: "╠════════════════════════════════╣", bot: "╚════════════════════════════════╝", badge: "[ L E G E N D A R Y ]" },
    "준특급": { top: "╔══════ 💠 SEMI-SPECIAL 💠 ════════╗", mid: "╠════════════════════════════════╣", bot: "╚════════════════════════════════╝", badge: "[ E P I C ]" },
    "1급": { top: "╔══════ ⭐ GRADE-1 ⭐ ══════════════╗", mid: "╠════════════════════════════════╣", bot: "╚════════════════════════════════╝", badge: "[ R A R E ]" },
    "준1급": { top: "╔══════ ⭐ SEMI GRADE-1 ⭐ ══════════╗", mid: "╠════════════════════════════════╣", bot: "╚════════════════════════════════╝", badge: "[ R A R E ]" },
    "2급": { top: "╔══════ 🔹 GRADE-2 🔹 ══════════════╗", mid: "╠════════════════════════════════╣", bot: "╚════════════════════════════════╝", badge: "[ U N C O M M O N ]" },
    "3급": { top: "╔══════ ◽ GRADE-3 ◽ ══════════════╗", mid: "╠════════════════════════════════╣", bot: "╚════════════════════════════════╝", badge: "[ C O M M O N ]" },
  };
  const th = themes[ch.grade] || themes["3급"];

  const skillIcons = ["∞", "↗", "✳", "⊕", "⬡", "◈"];
  const skillListLines = CHARACTERS[player.active].skills.map((s, idx) => {
    const unlocked = mastery >= s.minMastery;
    const isCurrent = skill.name === s.name;
    const fingerLock = s.name === "스쿠나 발현" && fingers < 10;
    const ok = unlocked && !fingerLock;
    const icon = ok ? skillIcons[idx] || "◆" : "🔒";
    const statusNote = s.statusApply ? ` [${STATUS_EFFECTS[s.statusApply.statusId]?.emoji}${Math.round(s.statusApply.chance * 100)}%]` : "";
    const curMark = isCurrent ? " ◀ 현재" : "";
    const awokenMark = isSkillAwakened(player, player.active, s.name) ? " ✨각성" : "";
    return `> ${icon} **${s.name}**${statusNote}${curMark}${awokenMark}\n> ⠀  *${s.desc}*`;
  }).join("\n");

  const awakeBanner = awakened ? `\n║  🔥 ≪ 천여주박 각성 ≫ — DMG×2  ║` : "";
  const cardBlock = [
    "```",
    th.top,
    `║  ${ch.emoji}  ${ch.name.padEnd(26)}  ║`,
    `║  ${gradeInfo.stars}  ${th.badge.padEnd(22)}  ║`,
    `║  ${(ch.lore || ch.desc).slice(0, 34).padEnd(34)}  ║`,
    th.mid,
    `║  🗡 ATK ${String(stats.atk).padEnd(6)} 🛡 DEF ${String(stats.def).padEnd(6)} 💨 SPD ${String(ch.spd).padEnd(4)}  ║`,
    `║  🌌 영역: ${(ch.domain || "없음").padEnd(24)}  ║`,
    awakeBanner,
    th.bot,
    "```",
  ].filter(Boolean).join("\n");

  const fingerBar = fingers > 0
    ? `> 👹 **스쿠나 손가락** \`${"█".repeat(fingers)}${"░".repeat(SUKUNA_FINGER_MAX - fingers)}\` **${fingers}/${SUKUNA_FINGER_MAX}** — ${fingerBonus.label}`
    : "";

  const koganeLine = kogane && kg
    ? `> ${kg.emoji} **코가네 [${kogane.grade}]** — ${kg.passiveDesc}`
    : `> 🐾 코가네 없음 — \`!코가네가챠\` (200💎)`;

  const eqLine = Object.keys(player.equipment || {}).length > 0
    ? `> ⚔️ **장비** ATK+${eqBonus.atk} DEF+${eqBonus.def} HP+${eqBonus.hp}`
    : `> ⚔️ 장비 없음 — \`!장비제작\`으로 제작`;

  const corruptLine = `> 🖤 **타락** ${getCorruptionLabel(corruption)} \`${corruption}/${CORRUPTION_MAX}\``;
  const blazeLine = `> ⚡ **흑섬 스택** \`${player.blazeStack || 0}\`/10 (${Math.min(30, 5 + (player.blazeStack || 0) * 3)}% 크리 확률)`;

  const embed = new EmbedBuilder()
    .setTitle(awakened
      ? `🔥 ≪ 천여주박 각성 ≫  ${player.name}의 카드`
      : `${gradeInfo.effect}  ${player.name}의 주술사 카드  ${gradeInfo.effect}`)
    .setColor(awakened ? 0xFF2200 : gradeInfo.color)
    .setDescription([cardBlock, koganeLine, fingerBar, eqLine].filter(Boolean).join("\n"))
    .addFields({
      name: "┌─ 🏅 주술사 정보 ─────────────────┐",
      value: [
        `> 🎖️ **LV.${lv}**  /  총 XP: **${player.xp || 0}**`,
        `> ${xpBarStr}`,
        `> 💎 **${player.crystals}** 크리스탈   🧪 회복약 **${player.potion}개**`,
        `> ⚔️ 일반 \`${player.wins}승 ${player.losses}패\`   /   PvP \`${player.pvpWins}승 ${player.pvpLosses}패\``,
        `> 🌊 컬링 최고 WAVE: **${player.cullingBest}**   🎯 사멸회유: **${player.jujutsuBest}pt**`,
      ].join("\n"),
      inline: false,
    })
    .addFields({
      name: "┌─ 💚 전투 상태 ───────────────────┐",
      value: [
        `> ${hpBarStr}`,
        `> 🩸 상태이상: **${statusStr(player.statusEffects)}**`,
        `> ⚡ 술식 CD: ${player.skillCooldown > 0 ? `**${player.skillCooldown}턴**` : "✅ 즉시 가능"}   ♻ 반전 CD: ${player.reverseCooldown > 0 ? `**${player.reverseCooldown}턴**` : "✅ 즉시 가능"}`,
        corruptLine,
        blazeLine,
        kogane && kg ? `> 🐾 코가네: ATK×${kb.atk.toFixed(2)} DEF×${kb.def.toFixed(2)} HP×${kb.hp.toFixed(2)}` : "",
      ].filter(Boolean).join("\n"),
      inline: false,
    })
    .addFields({
      name: "┌─ 🌀 SKILLS ───────────────────────┐",
      value: [
        skillListLines,
        `> 📈 숙련도: ${masteryBar(mastery, player.active)}`,
        next ? `> ⬆️ 다음 해금: **${next.name}** *(숙련 ${next.minMastery} 필요)*` : `> 🏆 **모든 스킬 해금 완료!**`,
      ].join("\n"),
      inline: false,
    })
    .addFields({
      name: "┌─ 📦 보유 캐릭터 ──────────────────┐",
      value: player.owned.map(id => {
        const c = CHARACTERS[id];
        if (!c) return "";
        const m = getMastery(player, id);
        const cur = getCurrentSkill(player, id);
        const ri = GACHA_RARITY[c.grade] || GACHA_RARITY["3급"];
        return `> ${id === player.active ? "▶️" : "　"} ${c.emoji} **${c.name}** \`${c.grade}\` ${ri.stars} · 숙련 \`${m}\` · \`${cur.name}\``;
      }).filter(Boolean).join("\n") || "> 없음",
      inline: false,
    })
    .setFooter({ text: `!전투 !컬링 !사멸회유 !결투 !파티 !가챠 !코가네가챠 !출석 !손가락 !임무 !레이드 | ${player.name}` })
    .setTimestamp();

  return embed;
}

function koganeProfileEmbed(player) {
  const kogane = player.kogane;
  if (!kogane) {
    return new EmbedBuilder()
      .setTitle("🐾 코가네 — 황금 개 펫")
      .setColor(0x4a5568)
      .setDescription([
        "```",
        "╔══════════════════════════════╗",
        "║    🐾  코가네 미획득  🐾     ║",
        "╚══════════════════════════════╝",
        "```",
        "> **코가네**는 황금 개 펫으로, 전투를 보조합니다!",
        "> 💎 **200 크리스탈** 로 `!코가네가챠` 를 사용해 소환하세요.",
        "> 등급: 🌟전설 / 🔶특급 / 🔷1급 / 🟢2급 / ⚪3급",
      ].join("\n"))
      .setFooter({ text: "!코가네가챠 (200💎)" });
  }
  const g = KOGANE_GRADES[kogane.grade];
  return new EmbedBuilder()
    .setTitle(`${g.emoji} 코가네 — [${kogane.grade}] ${g.stars}`)
    .setColor(g.color)
    .setDescription([
      "```",
      `╔══════════════════════════════════╗`,
      `║  ${g.emoji}  코가네  [${kogane.grade}]  ${g.stars}  ║`,
      `║  황금 개 — 나의 충실한 파트너   ║`,
      `╚══════════════════════════════════╝`,
      "```",
      `> **패시브 보너스:** ${g.passiveDesc}`,
      `> **전투 스킬:** 🐾 **${g.skill}** — ${g.skillDesc}`,
      `> **발동 확률:** ${Math.round(g.skillChance * 100)}%`,
    ].join("\n"))
    .addFields(
      { name: "📊 스탯 보너스", value: `> 🗡️ ATK **+${Math.round(g.atkBonus * 100)}%**\n> 🛡️ DEF **+${Math.round(g.defBonus * 100)}%**\n> 💚 HP **+${Math.round(g.hpBonus * 100)}%**`, inline: true },
      { name: "📈 보상 보너스", value: `> ⭐ XP **+${Math.round(g.xpBonus * 100)}%**\n> 💎 크리스탈 **+${Math.round(g.crystalBonus * 100)}%**`, inline: true },
      { name: "🎲 가챠 횟수", value: `> 총 **${player.koganeGachaCount || 0}**회 소환`, inline: true },
    )
    .setFooter({ text: "!코가네가챠 (200💎) — 더 좋은 등급 획득 시 자동 교체" });
}

function koganeGachaEmbed(grade, isUpgrade, player) {
  const g = KOGANE_GRADES[grade];
  const gradeOrder = ["3급", "2급", "1급", "특급", "전설"];
  const oldGrade = player.kogane?.grade;
  const upgraded = isUpgrade && oldGrade && gradeOrder.indexOf(grade) > gradeOrder.indexOf(oldGrade);
  return new EmbedBuilder()
    .setTitle(upgraded ? `${g.emoji} 코가네 등급 상승! ${oldGrade} → ${grade}!` : `${g.emoji} 코가네 소환! [${grade}]`)
    .setColor(g.color)
    .setDescription([
      "```",
      `╔════════════════════════════════════╗`,
      upgraded
        ? `║  ⬆️  등급 상승!!  ${oldGrade} → ${grade}  ⬆️  ║`
        : `║  ${g.emoji}  코가네 [${grade}]  ${g.stars}  ║`,
      `║  🐾  황금 개 코가네 소환 완료!    ║`,
      `╚════════════════════════════════════╝`,
      "```",
      `> **패시브:** ${g.passiveDesc}`,
      `> **스킬:** ${g.skill} — ${g.skillDesc}`,
      !upgraded && oldGrade ? `\n> ⚠️ 기존 코가네보다 낮은 등급 — **교체되지 않았습니다.**\n> 💎 **+50** 보상 크리스탈 지급!` : "",
    ].filter(Boolean).join("\n"))
    .setFooter({ text: `총 소환 횟수: ${player.koganeGachaCount}회 | 잔여 크리스탈: ${player.crystals}` });
}

function gachaLoadingEmbed(stage = 1) {
  const frames = [
    {
      title: "🔮 주술 소환 의식 — 준비",
      color: 0x0a0a1e,
      desc: [
        "```ansi",
        "\u001b[2;30m╔══════════════════════════════════════╗",
        "\u001b[2;34m║       ？    ？    ？    ？    ？      ║",
        "\u001b[2;30m╚══════════════════════════════════════╝",
        "```",
        "> *저주 에너지가 수렴하기 시작한다...*",
        "> `◆` 술식 증폭 중...",
      ].join("\n"),
    },
    {
      title: "⚡ 저주 에너지 최대 수렴 중...",
      color: 0x1a0533,
      desc: [
        "```ansi",
        "\u001b[1;35m╔══════════════════════════════════════╗",
        "\u001b[1;35m║  ⚡        ⚡        ⚡        ⚡  ║",
        "\u001b[1;33m║       ✦        ✦        ✦       ║",
        "\u001b[1;35m║  ⚡        ？？？        ⚡     ║",
        "\u001b[1;35m╚══════════════════════════════════════╝",
        "```",
        "> *주술 에너지가 임계점에 도달한다...*",
      ].join("\n"),
    },
  ];
  const f = frames[stage - 1] || frames[0];
  return new EmbedBuilder().setTitle(f.title).setColor(f.color).setDescription(f.desc);
}

function gachaRevealEmbed(grade) {
  const info = GACHA_RARITY[grade] || GACHA_RARITY["3급"];
  const revealArt = {
    "특급": "```ansi\n\u001b[1;33m╔═══════════════════════════════════════╗\n\u001b[1;33m║  ⚡ ⚡ ⚡  L E G E N D A R Y  ⚡ ⚡ ⚡  ║\n\u001b[1;31m║    ★ ★ ★ ★ ★    ???    ★ ★ ★ ★ ★    ║\n\u001b[1;33m╚═══════════════════════════════════════╝\n```",
    "준특급": "```ansi\n\u001b[1;34m╔══════════════════════════════════════╗\n\u001b[1;34m║  💠 💠 💠   E P I C   💠 💠 💠   ║\n\u001b[1;34m║    ★ ★ ★ ★      ???      ★ ★ ★ ★    ║\n\u001b[1;34m╚══════════════════════════════════════╝\n```",
    "1급": "```ansi\n\u001b[1;35m╔══════════════════════════════════╗\n\u001b[1;35m║  ★ ★ ★   R A R E   ★ ★ ★     ║\n\u001b[1;37m║         ???                      ║\n\u001b[1;35m╚══════════════════════════════════╝\n```",
  };
  const art = revealArt[grade] || "```\n??? 등장!\n```";
  return new EmbedBuilder()
    .setTitle(`${info.effect} ${grade} 등급의 기운이 느껴진다!`)
    .setColor(info.color)
    .setDescription(art + `\n> *${info.stars}  —  ${info.flash}!*`);
}

function gachaResultEmbed(charId, isNew, player) {
  const ch = CHARACTERS[charId];
  const info = GACHA_RARITY[ch.grade] || GACHA_RARITY["3급"];
  const skill = getCurrentSkill(player, charId);
  return new EmbedBuilder()
    .setTitle(isNew
      ? `${info.effect} ✨ NEW! — ${ch.name} 획득!`
      : `${info.effect} 중복 — ${ch.name} (+50💎 보상)`)
    .setColor(isNew ? info.color : 0x4a5568)
    .setDescription([
      "```",
      `╔══════════════════════════════════╗`,
      `║  ${ch.emoji}  ${ch.name.padEnd(26)}  ║`,
      `║  ${info.stars}  ${JJK_GRADE_LABEL[ch.grade] ? JJK_GRADE_LABEL[ch.grade].padEnd(20) : ""}  ║`,
      `╚══════════════════════════════════╝`,
      "```",
      `> *"${ch.lore || ch.desc}"*`,
    ].join("\n"))
    .addFields(
      { name: "🌌 영역전개", value: ch.domain || "없음", inline: true },
      { name: "🔥 초기 술식", value: `\`${skill.name}\`  (피해 ${skill.dmg})`, inline: true },
      { name: "📖 설명", value: ch.desc, inline: false },
    )
    .setFooter({ text: `💎 잔여 크리스탈: ${player.crystals}  ·  !가챠10 으로 10연차!` });
}

function gacha10ResultEmbed(results, newOnes, dupCrystals, player) {
  const sorted = [...results].sort((a, b) => {
    const order = ["특급", "준특급", "1급", "준1급", "2급", "3급", "4급"];
    return order.indexOf(CHARACTERS[a]?.grade) - order.indexOf(CHARACTERS[b]?.grade);
  });
  const lines = sorted.map(id => {
    const ch = CHARACTERS[id];
    if (!ch) return "";
    const info = GACHA_RARITY[ch.grade] || GACHA_RARITY["3급"];
    const isN = newOnes.includes(id);
    return `${ch.emoji} ${info.stars} **${ch.name}** \`[${ch.grade}]\`${isN ? " **✨NEW!**" : ""}`;
  }).filter(Boolean);
  const legendaries = results.filter(id => CHARACTERS[id]?.grade === "특급");
  return new EmbedBuilder()
    .setTitle(legendaries.length > 0 ? `🔱 ⚡⚡ 10연차 — 전설 등급 획득!! ⚡⚡ 🔱` : `🎲 10회 주술 소환 결과`)
    .setColor(legendaries.length > 0 ? 0xF5C842 : 0x7c5cfc)
    .setDescription(lines.join("\n"))
    .addFields(
      { name: "✨ 신규 획득", value: newOnes.length ? newOnes.map(id => `${CHARACTERS[id]?.emoji || ""} ${CHARACTERS[id]?.name || id}`).join(", ") : "없음", inline: true },
      { name: "🔄 중복 보상", value: `**+${dupCrystals}** 💎`, inline: true },
      { name: "💎 잔여 크리스탈", value: `**${player.crystals}**`, inline: true },
    )
    .setFooter({ text: "!가챠 1회(150💎) | !가챠10 10회(1350💎) | 스쿠나는 가챠 풀에 없음" });
}

function skillEmbed(player) {
  const id = player.active;
  const ch = CHARACTERS[id];
  if (!ch) return new EmbedBuilder().setTitle("오류").setDescription("캐릭터 없음");
  const mastery = getMastery(player, id);
  const awakened = isMakiAwakened(player);
  const fingers = player.sukunaFingers || 0;
  return new EmbedBuilder()
    .setTitle(`${ch.emoji} ≪ 술식 트리 ≫ ${ch.name}${awakened ? "  🔥[각성]" : ""}`)
    .setColor(awakened ? 0xFF2200 : JJK_GRADE_COLOR[ch.grade])
    .setDescription([
      `> ${ch.lore || ch.desc}`,
      `> 📈 **숙련도** ${masteryBar(mastery, id)}`,
      `> 🌌 **영역전개** \`${ch.domain || "없음"}\``,
      id === "itadori" ? `> 👹 **스쿠나 손가락** \`${fingers}/${SUKUNA_FINGER_MAX}\` — ${getFingerBonus(fingers).label}` : "",
      awakened ? `> 🔥 **천여주박 각성 중** — 모든 데미지 **2배**!` : "",
      `> ⚡ **흑섬 스택** \`${player.blazeStack || 0}\`/10 — 크리 확률 \`${Math.min(30, 5 + (player.blazeStack || 0) * 3)}%\``,
    ].filter(Boolean).join("\n"))
    .addFields(ch.skills.map((s, idx) => {
      const unlocked = mastery >= s.minMastery;
      const fingerLock = s.name === "스쿠나 발현" && fingers < 10;
      const available = unlocked && !fingerLock;
      const fx = getSkillEffect(s.name);
      const statusNote = s.statusApply ? ` \`${STATUS_EFFECTS[s.statusApply.statusId]?.emoji}${STATUS_EFFECTS[s.statusApply.statusId]?.name} ${Math.round(s.statusApply.chance * 100)}%\`` : "";
      const dmgDisplay = awakened ? `~~${s.dmg}~~ → **${s.dmg * 2}**🔥` : `**${s.dmg}**`;
      const selfBuff = s.statusApply?.target === "self" ? " 🔰자기버프" : "";
      const awokenInfo = SKILL_AWAKENING[id]?.[s.name];
      const isAwoken = isSkillAwakened(player, id, s.name);
      const awakenNote = awokenInfo ? (isAwoken ? ` ✨**[각성완료]** ×${awokenInfo.dmgMult}` : ` *(각성 가능: 숙련${awokenInfo.masteryRequired} 필요, ${awokenInfo.crystalCost}💎)*`) : "";
      return {
        name: `${available ? `✅ [${idx + 1}]` : "🔒"} ${isAwoken ? awokenInfo.awakenedName : s.name}  —  피해 ${dmgDisplay}${statusNote}${selfBuff}${awakenNote}  *(숙련 ${s.minMastery} 필요)*`,
        value: [
          `> ${isAwoken ? awokenInfo.newDesc : s.desc}`,
          available ? fx.art : `> ${!unlocked ? "🔒 숙련도 부족" : "👹 손가락 10개 이상 필요"}`,
          available ? `> *${fx.flavorText}*` : "",
        ].filter(Boolean).join("\n"),
        inline: false,
      };
    }))
    .setFooter({ text: "전투/컬링 승리 시 숙련도 상승! | !술식각성 [스킬명] 으로 각성" });
}

function cullingEmbed(player, session, log = []) {
  const ch = CHARACTERS[player.active];
  if (!ch || !session || !session.currentEnemy) return new EmbedBuilder().setTitle("오류").setDescription("세션 없음");
  const stats = getPlayerStats(player);
  const enemy = session.currentEnemy;
  const awakened = isMakiAwakened(player);
  return new EmbedBuilder()
    .setTitle(`${awakened ? "🔥 " : ""}⚔️ 컬링 게임 — 🌊 WAVE ${session.wave}`)
    .setColor(awakened ? 0xFF2200 : session.wave >= 15 ? 0xF5C842 : session.wave >= 8 ? 0xe63946 : 0x7C5CFC)
    .setDescription(log.join("\n") || "⚔️ 새 파도가 밀려온다!")
    .addFields(
      { name: `${ch.emoji} 내 HP`, value: `${hpBar(player.hp || 0, stats.maxHp)} \`${Math.max(0, player.hp || 0)}/${stats.maxHp}\`${awakened ? " 🔥각성" : ""}\n상태: ${statusStr(player.statusEffects)}\n⚡술식: \`${player.skillCooldown > 0 ? player.skillCooldown + "턴" : "가능"}\` ♻반전: \`${player.reverseCooldown > 0 ? player.reverseCooldown + "턴" : "가능"}\`\n⚡흑섬스택: \`${player.blazeStack || 0}\`/10`, inline: true },
      { name: `${enemy.emoji} ${enemy.name}`, value: `${hpBar(session.enemyHp || 0, enemy.hp)} \`${Math.max(0, session.enemyHp || 0)}/${enemy.hp}\`\n상태: ${statusStr(enemy.statusEffects || [])}`, inline: true },
      { name: "📊 현황", value: `WAVE **${session.wave}** | 처치 **${session.kills}** | **${session.totalXp}** XP / **${session.totalCrystals}**💎\n🖤 타락: **${player.corruption || 0}/${CORRUPTION_MAX}** ${getCorruptionLabel(player.corruption || 0)}`, inline: false },
    )
    .setFooter({ text: `현재 스킬: ${getCurrentSkill(player, player.active).name} | 최고기록: WAVE ${player.cullingBest}` });
}

function jujutsuEmbed(player, session, log = [], choices = null) {
  const ch = CHARACTERS[player.active];
  if (!ch || !session) return new EmbedBuilder().setTitle("오류").setDescription("세션 없음");
  const stats = getPlayerStats(player);
  const awakened = isMakiAwakened(player);
  const embed = new EmbedBuilder()
    .setTitle(`🎯 사멸회유 — WAVE ${session.wave} | 포인트 **${session.points}**/15`)
    .setColor(session.points >= 10 ? 0xF5C842 : session.points >= 5 ? 0xff8c00 : 0x7C5CFC)
    .setDescription(log.join("\n") || "🎯 사멸회유 진행 중! 몹을 선택해 처치하세요.")
    .addFields(
      { name: `${ch.emoji} 내 HP`, value: `${hpBar(player.hp || 0, stats.maxHp)} \`${Math.max(0, player.hp || 0)}/${stats.maxHp}\`${awakened ? " 🔥각성" : ""}\n상태: ${statusStr(player.statusEffects)}\n⚡술식: \`${player.skillCooldown > 0 ? player.skillCooldown + "턴" : "가능"}\` ♻반전: \`${player.reverseCooldown > 0 ? player.reverseCooldown + "턴" : "가능"}\``, inline: false },
      { name: "🎯 포인트", value: `${"🟦".repeat(Math.min(session.points, 15))}${"⬜".repeat(Math.max(0, 15 - session.points))} **${session.points}/15**\n**${session.totalXp}** XP / **${session.totalCrystals}**💎`, inline: false },
    );
  if (session.currentEnemy) {
    const enemy = session.currentEnemy;
    embed.addFields({ name: `${enemy.emoji} 현재 적: ${enemy.name}`, value: `${hpBar(session.enemyHp || 0, enemy.hp)} \`${Math.max(0, session.enemyHp || 0)}/${enemy.hp}\`\n상태: ${statusStr(enemy.statusEffects || [])}\n포인트: +${enemy.points}점`, inline: false });
  }
  if (choices && choices.length > 0) embed.addFields({ name: "⚔️ 다음 적 선택", value: choices.map((c, i) => `**[${i + 1}]** ${c.emoji} ${c.name} — HP:\`${c.hp}\` ATK:\`${c.atk}\` | +${c.points}점\n└ ${c.desc}`).join("\n"), inline: false });
  embed.setFooter({ text: `최고기록: ${player.jujutsuBest}포인트 | 15포인트 달성 시 보너스!` });
  return embed;
}

function pvpEmbed(session, log = []) {
  if (!session || !players[session.p1Id] || !players[session.p2Id]) return new EmbedBuilder().setTitle("PvP 오류").setDescription("세션 없음");
  const p1 = players[session.p1Id];
  const p2 = players[session.p2Id];
  const ch1 = CHARACTERS[p1.active];
  const ch2 = CHARACTERS[p2.active];
  const s1 = getPlayerStats(p1);
  const s2 = getPlayerStats(p2);
  const aw1 = isMakiAwakened(p1);
  const aw2 = isMakiAwakened(p2);
  const turnName = session.turn === session.p1Id ? p1.name : p2.name;
  return new EmbedBuilder()
    .setTitle(`⚔️ PvP 결투  ${p1.name} VS ${p2.name}`)
    .setColor(0xF5C842)
    .setDescription(log.join("\n") || "⚔️ 결투 시작!")
    .addFields(
      { name: `${ch1.emoji} ${p1.name} [${ch1.grade}]${aw1 ? " 🔥" : ""}`, value: `${hpBar(session.hp1, s1.maxHp)} \`${Math.max(0, session.hp1)}/${s1.maxHp}\`\n상태: ${statusStr(session.status1)}\n⚡술식: \`${session.skillCd1 > 0 ? session.skillCd1 + "턴" : "가능"}\` ♻반전: \`${session.reverseCd1 > 0 ? session.reverseCd1 + "턴" : "가능"}\``, inline: true },
      { name: `${ch2.emoji} ${p2.name} [${ch2.grade}]${aw2 ? " 🔥" : ""}`, value: `${hpBar(session.hp2, s2.maxHp)} \`${Math.max(0, session.hp2)}/${s2.maxHp}\`\n상태: ${statusStr(session.status2)}\n⚡술식: \`${session.skillCd2 > 0 ? session.skillCd2 + "턴" : "가능"}\` ♻반전: \`${session.reverseCd2 > 0 ? session.reverseCd2 + "턴" : "가능"}\``, inline: true },
      { name: "🎯 현재 턴", value: `**${turnName}**의 차례 (라운드 ${session.round})`, inline: false },
    )
    .setFooter({ text: "술식: 5턴 쿨다운 | 반전술식: 3턴 쿨다운 (고조/유타 전용) | 회피율 5%" });
}

function partyCullingEmbed(party, session, log = []) {
  if (!party || !session || !session.currentEnemy) return new EmbedBuilder().setTitle("오류").setDescription("파티 세션 없음");
  const enemy = session.currentEnemy;
  const memberLines = party.members.map(uid => {
    const p = players[uid];
    if (!p) return `> ❓ 알 수 없음 (${uid})`;
    const ch = CHARACTERS[p.active];
    if (!ch) return `> ❓ ${p.name} (캐릭터 없음)`;
    const stats = getPlayerStats(p);
    const awakened = isMakiAwakened(p);
    const isLeader = party.leader === uid;
    const hpPct = Math.max(0, p.hp || 0) / Math.max(1, stats.maxHp);
    const hpIcon = hpPct > 0.5 ? "🟢" : hpPct > 0.25 ? "🟡" : "🔴";
    return `> ${isLeader ? "👑" : "👤"} **${p.name}** ${ch.emoji} ${hpIcon} \`${Math.max(0, p.hp || 0)}/${stats.maxHp}\`${awakened ? " 🔥" : ""} | ${statusStr(p.statusEffects)} | ⚡${p.skillCooldown > 0 ? p.skillCooldown + "턴" : "가능"}`;
  }).join("\n");
  return new EmbedBuilder()
    .setTitle(`⚔️ [파티] 컬링 게임 — 🌊 WAVE ${session.wave}`)
    .setColor(session.wave >= 15 ? 0xF5C842 : session.wave >= 8 ? 0xe63946 : 0x7C5CFC)
    .setDescription(log.join("\n") || "⚔️ 파티 컬링 게임 진행 중!")
    .addFields(
      { name: `👥 파티원 (${party.members.length}명)`, value: memberLines || "없음", inline: false },
      { name: `${enemy.emoji} ${enemy.name}`, value: `${hpBar(Math.max(0, session.enemyHp || 0), enemy.hp)} \`${Math.max(0, session.enemyHp || 0)}/${enemy.hp}\` (ATK ${enemy.atk})\n상태: ${statusStr(enemy.statusEffects || [])}`, inline: false },
      { name: "📊 현황", value: `WAVE **${session.wave}** | 처치 **${session.kills}** | **${session.totalXp}** XP / **${session.totalCrystals}**💎`, inline: false },
    )
    .setFooter({ text: "파티원 누구나 버튼을 눌러 행동할 수 있습니다! | 파티원 전원 사망 시 종료" });
}

function raidEmbed(session, log = []) {
  if (!session) return new EmbedBuilder().setTitle("레이드 없음").setDescription("진행 중인 레이드가 없습니다.");
  const boss = session.boss;
  const bossHpPct = Math.max(0, session.bossHp / boss.hp);
  const topDealers = Object.entries(session.damageLog || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([uid, dmg], i) => `> ${["🥇","🥈","🥉","4️⃣","5️⃣"][i]} **${players[uid]?.name || uid}**: ${dmg.toLocaleString()} 피해`);
  return new EmbedBuilder()
    .setTitle(`🔥 ≪ 특급 레이드 ≫ ${boss.emoji} ${boss.name}`)
    .setColor(session.bossHp / boss.hp < 0.3 ? 0xff0000 : 0xF5C842)
    .setDescription(log.join("\n") || `${boss.emoji} 레이드 보스 등장! 협력해서 쓰러뜨려라!`)
    .addFields(
      { name: `${boss.emoji} 보스 HP`, value: `${hpBar(session.bossHp, boss.hp, 20)} \`${session.bossHp.toLocaleString()}/${boss.hp.toLocaleString()}\`\n상태: ${statusStr(session.statusEffects || [])}`, inline: false },
      { name: `👥 참가자 (${session.participants.length}명)`, value: session.participants.map(uid => {
        const p = players[uid];
        if (!p) return "> ❓ 알 수 없음";
        const ch = CHARACTERS[p.active];
        const stats = getPlayerStats(p);
        return `> **${p.name}** ${ch?.emoji || ""} \`${Math.max(0, p.hp || 0)}/${stats.maxHp}\` HP | 딜: ${(session.damageLog[uid] || 0).toLocaleString()}`;
      }).join("\n") || "> 없음", inline: false },
      { name: "📊 딜 기여도 TOP5", value: topDealers.join("\n") || "> 아직 없음", inline: false },
    )
    .setFooter({ text: `!레이드참가 로 참가 | !레이드공격 으로 공격 | 보스: ATK ${boss.atk} DEF ${boss.def}` });
}

function questEmbed(player) {
  initDailyQuests(player);
  initWeeklyQuests(player);
  const daily = player.questData?.daily || [];
  const weekly = player.questData?.weekly || [];

  const dailyLines = daily.map(q => {
    const bar = `\`${"█".repeat(Math.floor((q.progress / q.target) * 8))}${"░".repeat(Math.max(0, 8 - Math.floor((q.progress / q.target) * 8)))}\``;
    const status = q.claimed ? "✅완료" : q.completed ? "🎁수령가능" : `${bar} ${q.progress}/${q.target}`;
    return `> ${status} **${q.name}**\n> 보상: ${q.rewardCrystals}💎 ${q.rewardXp}XP`;
  }).join("\n");

  const weeklyLines = weekly.map(q => {
    const bar = `\`${"█".repeat(Math.floor((q.progress / q.target) * 8))}${"░".repeat(Math.max(0, 8 - Math.floor((q.progress / q.target) * 8)))}\``;
    const status = q.claimed ? "✅완료" : q.completed ? "🎁수령가능" : `${bar} ${q.progress}/${q.target}`;
    const matReward = q.rewardMaterials ? ` + ${Object.entries(q.rewardMaterials).map(([k,v]) => `${k} x${v}`).join(",")}` : "";
    return `> ${status} **${q.name}**\n> 보상: ${q.rewardCrystals}💎 ${q.rewardXp}XP${matReward}`;
  }).join("\n");

  return new EmbedBuilder()
    .setTitle("📋 주술고 임무 — 일일/주간 퀘스트")
    .setColor(0x4ade80)
    .addFields(
      { name: "🌅 일일 임무", value: dailyLines || "> 없음", inline: false },
      { name: "📅 주간 임무", value: weeklyLines || "> 없음", inline: false },
    )
    .setFooter({ text: "!임무수령 으로 완료된 임무 보상 받기 | 매일 자정 초기화" });
}

function craftEmbed(player) {
  const matStr = getMaterialStr(player.materials);
  const blueprintLines = Object.values(EQUIPMENT_BLUEPRINTS).map(bp => {
    const canCraft = hasMaterials(player, bp.materials);
    const matRequired = Object.entries(bp.materials).map(([k, v]) => `${k} x${v}`).join(", ");
    const owned = Object.values(player.equipment || {}).includes(bp.id);
    return `> ${canCraft ? "✅" : "❌"} **${bp.emoji} ${bp.id}** \`[${bp.grade}]\`${owned ? " (장착중)" : ""}\n> ATK+${bp.atkBonus} DEF+${bp.defBonus} HP+${bp.hpBonus} | ${bp.desc}\n> 재료: ${matRequired}`;
  }).join("\n\n");

  return new EmbedBuilder()
    .setTitle("⚔️ 주구(장비) 제작소")
    .setColor(0x7C5CFC)
    .setDescription([
      `> 📦 보유 재료: ${matStr}`,
      "",
      "**제작 가능 목록:**",
      blueprintLines,
    ].join("\n"))
    .setFooter({ text: "!제작 [장비명] 으로 제작 | 재료는 전투에서 드롭" });
}

// ════════════════════════════════════════════════════════
// ── 버튼 팩토리
// ════════════════════════════════════════════════════════
const mkBattleButtons = (player) => {
  const canSkill = !player || player.skillCooldown <= 0;
  const canReverse = !player || player.reverseCooldown <= 0;
  const hasReverse = !player || REVERSE_CHARS.has(player.active);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("b_attack").setLabel("⚔ 공격").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("b_skill").setLabel(`🌀 술식${canSkill ? "" : `(${player?.skillCooldown}턴)`}`).setStyle(ButtonStyle.Primary).setDisabled(!canSkill),
    new ButtonBuilder().setCustomId("b_domain").setLabel("🌌 영역전개").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("b_reverse").setLabel(`♻ 반전${canReverse ? "" : `(${player?.reverseCooldown}턴)`}`).setStyle(ButtonStyle.Secondary).setDisabled(!canReverse || !hasReverse),
    new ButtonBuilder().setCustomId("b_run").setLabel("🏃 도주").setStyle(ButtonStyle.Secondary),
  );
};

const mkCullingButtons = (player) => {
  const canSkill = !player || player.skillCooldown <= 0;
  const canReverse = !player || player.reverseCooldown <= 0;
  const hasReverse = !player || REVERSE_CHARS.has(player.active);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("c_attack").setLabel("⚔ 공격").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("c_skill").setLabel(`🌀 술식${canSkill ? "" : `(${player?.skillCooldown}턴)`}`).setStyle(ButtonStyle.Primary).setDisabled(!canSkill),
    new ButtonBuilder().setCustomId("c_domain").setLabel("🌌 영역전개").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("c_reverse").setLabel(`♻ 반전${canReverse ? "" : `(${player?.reverseCooldown}턴)`}`).setStyle(ButtonStyle.Secondary).setDisabled(!canReverse || !hasReverse),
    new ButtonBuilder().setCustomId("c_escape").setLabel("🏳 철수").setStyle(ButtonStyle.Secondary),
  );
};

const mkJujutsuButtons = (player, choices) => {
  const rows = [];
  if (choices && choices.length > 0) {
    const choiceRow = new ActionRowBuilder();
    for (let i = 0; i < Math.min(choices.length, 3); i++) {
      choiceRow.addComponents(
        new ButtonBuilder()
          .setCustomId(`j_choice_${i}`)
          .setLabel(`⚔️ ${choices[i].name.slice(0, 20)}`)
          .setStyle(ButtonStyle.Primary)
      );
    }
    rows.push(choiceRow);
  }
  const canSkill = !player || player.skillCooldown <= 0;
  const canReverse = !player || player.reverseCooldown <= 0;
  const hasReverse = !player || REVERSE_CHARS.has(player.active);
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("j_attack").setLabel("⚔ 공격").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("j_skill").setLabel(`🌀 술식${canSkill ? "" : `(${player?.skillCooldown}턴)`}`).setStyle(ButtonStyle.Primary).setDisabled(!canSkill),
    new ButtonBuilder().setCustomId("j_domain").setLabel("🌌 영역전개").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("j_reverse").setLabel(`♻ 반전${canReverse ? "" : `(${player?.reverseCooldown}턴)`}`).setStyle(ButtonStyle.Secondary).setDisabled(!canReverse || !hasReverse),
    new ButtonBuilder().setCustomId("j_escape").setLabel("🏳 철수").setStyle(ButtonStyle.Secondary),
  ));
  return rows;
};

const mkPvpButtons = (session, userId) => {
  const self = pvpSelf(session, userId);
  const canSkill = self.skillCdKey ? session[self.skillCdKey] <= 0 : true;
  const canReverse = self.reverseCdKey ? session[self.reverseCdKey] <= 0 : true;
  const player = players[userId];
  const hasReverse = REVERSE_CHARS.has(player?.active);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("p_attack").setLabel("⚔ 공격").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("p_skill").setLabel(`🌀 술식${canSkill ? "" : "(\u2716)"}`).setStyle(ButtonStyle.Primary).setDisabled(!canSkill),
    new ButtonBuilder().setCustomId("p_domain").setLabel("🌌 영역전개").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("p_reverse").setLabel(`♻ 반전${canReverse ? "" : "(\u2716)"}`).setStyle(ButtonStyle.Secondary).setDisabled(!canReverse || !hasReverse),
    new ButtonBuilder().setCustomId("p_surrender").setLabel("🏳 항복").setStyle(ButtonStyle.Secondary),
  );
};

const mkRaidButtons = () => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId("raid_attack").setLabel("⚔ 공격").setStyle(ButtonStyle.Danger),
  new ButtonBuilder().setCustomId("raid_skill").setLabel("🌀 술식").setStyle(ButtonStyle.Primary),
  new ButtonBuilder().setCustomId("raid_domain").setLabel("🌌 영역전개").setStyle(ButtonStyle.Success),
  new ButtonBuilder().setCustomId("raid_leave").setLabel("🚪 퇴장").setStyle(ButtonStyle.Secondary),
);
