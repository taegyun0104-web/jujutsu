require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ComponentType } = require("discord.js");
const { createCanvas, loadImage } = require("canvas");
const GIFEncoder = require("gifencoder");
const { createWriteStream, readFileSync, unlinkSync, existsSync, mkdirSync } = require("fs");
const path = require("path");

// ════════════════════════════════════════════════════════════════════════════════
// ── HTTP 헬스체크 (Railway 배포용)
// ════════════════════════════════════════════════════════════════════════════════
const app = express();
app.get("/", (_, res) => res.send("🔱 주술회전 RPG 봇 가동 중"));
app.get("/health", (_, res) => res.json({ status: "ok", uptime: process.uptime(), memory: process.memoryUsage() }));
app.listen(process.env.PORT || 3000, () => console.log(`🌐 HTTP 포트 ${process.env.PORT || 3000}`));

// ════════════════════════════════════════════════════════════════════════════════
// ── PostgreSQL 연결 설정
// ════════════════════════════════════════════════════════════════════════════════
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway") ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on("error", (err) => console.error("PostgreSQL 풀 오류:", err.message));

// ════════════════════════════════════════════════════════════════════════════════
// ── 데이터베이스 초기화
// ════════════════════════════════════════════════════════════════════════════════
async function dbInit() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS players (
        user_id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS guilds (
        guild_id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS global_data (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log("✅ PostgreSQL 테이블 준비 완료");
  } catch (e) {
    console.log("⚠️ DB 연결 실패, 메모리 모드로 실행:", e.message);
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// ── 데이터베이스 로드 및 저장
// ════════════════════════════════════════════════════════════════════════════════
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
    await pool.query(
      `INSERT INTO players(user_id, data, updated_at) VALUES($1,$2,NOW())
       ON CONFLICT(user_id) DO UPDATE SET data=$2, updated_at=NOW()`,
      [userId, JSON.stringify(data)]
    );
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

// ════════════════════════════════════════════════════════════════════════════════
// ── Discord 클라이언트
// ════════════════════════════════════════════════════════════════════════════════
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});
const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) { console.error("❌ DISCORD_TOKEN 없음!"); process.exit(1); }

const DEV_IDS = new Set(["1284771557633425470", "1397218266505678881"]);
const isDev = (id) => DEV_IDS.has(id);

// ════════════════════════════════════════════════════════════════════════════════
// ── GIF 저장 디렉토리
// ════════════════════════════════════════════════════════════════════════════════
const GIF_DIR = path.join(__dirname, "temp_gifs");
if (!existsSync(GIF_DIR)) mkdirSync(GIF_DIR);
// ════════════════════════════════════════════════════════════════════════════════
// ── 등급/색상/라벨 데이터
// ════════════════════════════════════════════════════════════════════════════════
const JJK_GRADE_COLOR = {
  "특급": 0xF5C842,
  "준특급": 0xff8c00,
  "1급": 0x7C5CFC,
  "준1급": 0x9b72cf,
  "2급": 0x4ade80,
  "3급": 0x94a3b8,
  "4급": 0x64748b,
};

const JJK_GRADE_EMOJI = {
  "특급": "🔱",
  "준특급": "💠",
  "1급": "⭐⭐",
  "준1급": "⭐",
  "2급": "🔹🔹",
  "3급": "🔹",
  "4급": "◽",
};

const JJK_GRADE_LABEL = {
  "특급": "【 특 급 】",
  "준특급": "【준특급】",
  "1급": "【 1 급 】",
  "준1급": "【준 1급】",
  "2급": "【 2 급 】",
  "3급": "【 3 급 】",
  "4급": "【 4 급 】",
};

// ════════════════════════════════════════════════════════════════════════════════
// ── 상태이상 효과 시스템
// ════════════════════════════════════════════════════════════════════════════════
const STATUS_EFFECTS = {
  poison: { id: "poison", name: "독", emoji: "☠️", desc: "매 턴 최대HP의 5% 피해", duration: 3, damagePercent: 0.05 },
  burn: { id: "burn", name: "화상", emoji: "🔥", desc: "매 턴 최대HP의 8% 피해", duration: 2, damagePercent: 0.08 },
  freeze: { id: "freeze", name: "빙결", emoji: "❄️", desc: "1턴 행동 불가", duration: 1, cannotAct: true },
  weaken: { id: "weaken", name: "약화", emoji: "💔", desc: "공격력 30% 감소", duration: 2, damageMult: 0.7 },
  stun: { id: "stun", name: "기절", emoji: "⚡", desc: "1턴 행동 불가", duration: 1, cannotAct: true },
  battleInstinct: { id: "battleInstinct", name: "전투본능", emoji: "🔥💪", desc: "공격력 40% 증가, 회피율 25% 증가", duration: 3, damageMult: 1.4, evadeBonus: 0.25 },
  defenseUp: { id: "defenseUp", name: "방어 강화", emoji: "🛡️", desc: "방어력 30% 증가", duration: 3, defenseMult: 1.3 },
  attackUp: { id: "attackUp", name: "공격 강화", emoji: "⚔️", desc: "공격력 30% 증가", duration: 3, attackMult: 1.3 },
  regen: { id: "regen", name: "재생", emoji: "💚", desc: "매 턴 최대HP의 10% 회복", duration: 3, healPercent: 0.1 },
  curseMark: { id: "curseMark", name: "저주의 낙인", emoji: "🔴", desc: "받는 피해 20% 증가", duration: 3, damageTakenMult: 1.2 },
};

function applyStatus(target, statusId) {
  if (!target.statusEffects) target.statusEffects = [];
  const existing = target.statusEffects.find(s => s.id === statusId);
  if (existing) {
    existing.turns = STATUS_EFFECTS[statusId].duration;
  } else {
    target.statusEffects.push({ id: statusId, turns: STATUS_EFFECTS[statusId].duration });
  }
}

function removeStatus(target, statusId) {
  if (!target.statusEffects) return;
  target.statusEffects = target.statusEffects.filter(s => s.id !== statusId);
}

function tickStatus(target, maxHp) {
  if (!target.statusEffects || target.statusEffects.length === 0) return { dmg: 0, heal: 0, expired: [], log: [] };
  let totalDmg = 0;
  let totalHeal = 0;
  const expired = [];
  const log = [];
  
  for (const se of target.statusEffects) {
    const def = STATUS_EFFECTS[se.id];
    if (!def) { se.turns = 0; continue; }
    
    if (se.id === "poison") {
      const d = Math.max(1, Math.floor(maxHp * def.damagePercent));
      totalDmg += d;
      log.push(`${def.emoji} **${def.name}** — **${d}** 피해!`);
    }
    if (se.id === "burn") {
      const d = Math.max(1, Math.floor(maxHp * def.damagePercent));
      totalDmg += d;
      log.push(`${def.emoji} **${def.name}** — **${d}** 피해!`);
    }
    if (se.id === "regen") {
      const h = Math.max(1, Math.floor(maxHp * def.healPercent));
      totalHeal += h;
      log.push(`${def.emoji} **${def.name}** — **${h}** 회복!`);
    }
    
    se.turns--;
    if (se.turns <= 0) expired.push(se.id);
  }
  
  target.statusEffects = target.statusEffects.filter(s => s.turns > 0);
  if (totalDmg > 0) target.hp = Math.max(0, target.hp - totalDmg);
  if (totalHeal > 0) target.hp = Math.min(maxHp, target.hp + totalHeal);
  
  return { dmg: totalDmg, heal: totalHeal, expired, log };
}

function statusStr(se) {
  if (!se || se.length === 0) return "없음";
  return se.map(s => {
    const def = STATUS_EFFECTS[s.id];
    return def ? `${def.emoji}${def.name}(${s.turns}턴)` : s.id;
  }).join(" ");
}

function isIncapacitated(se) {
  return !!(se && se.some(s => s.id === "freeze" || s.id === "stun"));
}

function getDamageMult(se) {
  let mult = 1;
  if (se && se.some(s => s.id === "weaken")) mult *= 0.7;
  if (se && se.some(s => s.id === "battleInstinct")) mult *= 1.4;
  if (se && se.some(s => s.id === "attackUp")) mult *= 1.3;
  if (se && se.some(s => s.id === "curseMark" && s.target === "enemy")) mult *= 1.2;
  return mult;
}

function getDefenseMult(se) {
  let mult = 1;
  if (se && se.some(s => s.id === "defenseUp")) mult *= 1.3;
  return mult;
}

function getEvadeBonus(se) {
  let bonus = 0;
  if (se && se.some(s => s.id === "battleInstinct")) bonus += 0.25;
  return bonus;
}

function rollHit(defenderStatusEffects) {
  const baseEvade = 0.05;
  const evadeBonus = getEvadeBonus(defenderStatusEffects);
  return Math.random() > (baseEvade + evadeBonus);
}

// ════════════════════════════════════════════════════════════════════════════════
// ── 스쿠나 손가락 시스템
// ════════════════════════════════════════════════════════════════════════════════
const SUKUNA_FINGER_MAX = 20;

function getFingerBonus(fingers) {
  let skillBonus = 0;
  if (fingers >= 1) skillBonus = 5;
  if (fingers >= 5) skillBonus = 10;
  if (fingers >= 10) skillBonus = 20;
  if (fingers >= 15) skillBonus = 35;
  if (fingers >= 20) skillBonus = 50;
  
  return {
    atkBonus: Math.floor(fingers * 10),
    defBonus: Math.floor(fingers * 6),
    hpBonus: fingers * 200,
    skillBonus: skillBonus,
    label: fingers >= 20 ? "🔴 스쿠나 완전 각성" :
           fingers >= 15 ? "🔴 스쿠나 각성 Lv.4" :
           fingers >= 10 ? "🟠 스쿠나 각성 Lv.3" :
           fingers >= 5 ? "🟡 스쿠나 각성 Lv.2" :
           fingers >= 1 ? "🟢 스쿠나 각성 Lv.1" : "스쿠나 봉인 중",
  };
}

function isSukunaSkillUnlocked(fingers, skillIndex) {
  const requirements = [1, 5, 10, 15];
  return fingers >= requirements[skillIndex];
}

// ════════════════════════════════════════════════════════════════════════════════
// ── 코가네 (황금 개) 펫 시스템
// ════════════════════════════════════════════════════════════════════════════════
const KOGANE_GRADES = {
  "전설": {
    color: 0xF5C842,
    emoji: "🌟",
    stars: "★★★★★",
    rate: 0.5,
    atkBonus: 0.25,
    defBonus: 0.20,
    hpBonus: 0.20,
    xpBonus: 0.30,
    crystalBonus: 0.25,
    skill: "황금 포효",
    skillDesc: "전투 시작 시 적에게 추가 피해 (ATK의 50%)",
    skillChance: 0.35,
    passiveDesc: "ATK+25% DEF+20% HP+20% XP+30% 크리스탈+25%",
  },
  "특급": {
    color: 0xff8c00,
    emoji: "🔶",
    stars: "★★★★☆",
    rate: 2.0,
    atkBonus: 0.18,
    defBonus: 0.15,
    hpBonus: 0.15,
    xpBonus: 0.20,
    crystalBonus: 0.18,
    skill: "황금 이빨",
    skillDesc: "공격 시 15% 확률로 약화 부여",
    skillChance: 0.15,
    passiveDesc: "ATK+18% DEF+15% HP+15% XP+20% 크리스탈+18%",
  },
  "1급": {
    color: 0x7C5CFC,
    emoji: "🔷",
    stars: "★★★☆☆",
    rate: 8.0,
    atkBonus: 0.12,
    defBonus: 0.10,
    hpBonus: 0.10,
    xpBonus: 0.12,
    crystalBonus: 0.10,
    skill: "황금 발톱",
    skillDesc: "공격 시 10% 확률로 추가타 (ATK의 30%)",
    skillChance: 0.10,
    passiveDesc: "ATK+12% DEF+10% HP+10% XP+12% 크리스탈+10%",
  },
  "2급": {
    color: 0x4ade80,
    emoji: "🟢",
    stars: "★★☆☆☆",
    rate: 22.5,
    atkBonus: 0.07,
    defBonus: 0.06,
    hpBonus: 0.06,
    xpBonus: 0.07,
    crystalBonus: 0.06,
    skill: "황금 보호막",
    skillDesc: "HP 30% 이하 시 1회 피해 50% 감소",
    skillChance: 1.0,
    passiveDesc: "ATK+7% DEF+6% HP+6% XP+7% 크리스탈+6%",
  },
  "3급": {
    color: 0x94a3b8,
    emoji: "⚪",
    stars: "★☆☆☆☆",
    rate: 67.0,
    atkBonus: 0.03,
    defBonus: 0.02,
    hpBonus: 0.02,
    xpBonus: 0.03,
    crystalBonus: 0.02,
    skill: "황금 냄새",
    skillDesc: "전투 후 크리스탈 +5% 추가 획득",
    skillChance: 1.0,
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
  for (const e of KOGANE_POOL) {
    roll -= e.rate;
    if (roll <= 0) return e.grade;
  }
  return "3급";
}

function getKoganeBonus(player) {
  if (!player.kogane || !player.kogane.grade) {
    return { atk: 1, def: 1, hp: 1, xp: 1, crystal: 1 };
  }
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
// ════════════════════════════════════════════════════════════════════════════════
// ── 스킬 이펙트 아트
// ════════════════════════════════════════════════════════════════════════════════
const SKILL_EFFECTS = {
  "주먹질": {
    art: "```\n  💥  \n ▓▓▓▓▓\n  💥  \n```",
    color: 0xff6b35,
    flavorText: "저주 에너지를 주먹에 집중시킨다!"
  },
  "다이버전트 주먹": {
    art: "```\n ⚡💥⚡\n▓▓▓▓▓▓▓\n ⚡💥⚡\n```",
    color: 0xff4500,
    flavorText: "발산하는 저주 에너지 — 몸의 내부에서 폭발!"
  },
  "흑섬": {
    art: "```\n🌑🌑🌑🌑🌑\n⬛ 黑 閃 ⬛\n🌑🌑🌑🌑🌑\n```",
    color: 0x1a0a2e,
    flavorText: "순간적으로 발산되는 최대 저주 에너지!"
  },
  "어주자": {
    art: "```\n👹✨👹✨👹\n✨ 廻 夏 ✨\n👹✨👹✨👹\n```",
    color: 0xb5451b,
    flavorText: "스쿠나의 힘이 몸을 가득 채운다..."
  },
  "스쿠나 발현": {
    art: "```\n🔴👹🔴👹🔴\n👹 両 面 宿 儺 👹\n🔴👹🔴👹🔴\n```",
    color: 0x8b0000,
    flavorText: "저주의 왕이 이타도리의 몸을 장악한다!"
  },
  "아오": {
    art: "```\n  🔵🔵🔵  \n🔵  蒼  🔵\n  🔵🔵🔵  \n```",
    color: 0x0066ff,
    flavorText: "무한에 의한 인력 — 모든 것을 끌어당긴다"
  },
  "아카": {
    art: "```\n  🔴🔴🔴  \n🔴  赫  🔴\n  🔴🔴🔴  \n```",
    color: 0xff0033,
    flavorText: "무한에 의한 척력 — 모든 것을 날려버린다"
  },
  "무라사키": {
    art: "```\n🔴⚡🔵⚡🔴\n⚡  紫  ⚡\n🔵⚡🔴⚡🔵\n```",
    color: 0x9900ff,
    flavorText: "아오와 아카의 융합 — 허공을 찢는 허수!"
  },
  "무량공처": {
    art: "```\n∞∞∞∞∞∞∞∞∞\n∞ 無 量 空 処 ∞\n∞∞∞∞∞∞∞∞∞\n```",
    color: 0x00ffff,
    flavorText: "\"나는 최강이니까\" — 무한이 세계를 지배한다"
  },
  "자폭 무라사키": {
    art: "```\n💥🔴💥🔵💥\n💥 自爆 紫 💥\n💥🔵💥🔴💥\n```",
    color: 0xff0000,
    flavorText: "모든 힘을 쏟아붓는 자폭 공격!"
  },
  "옥견": {
    art: "```\n  🐕🐕🐕  \n🐕  玉  🐕\n  🐕🐕🐕  \n```",
    color: 0x4a4a8a,
    flavorText: "식신 옥견 소환!"
  },
  "탈토": {
    art: "```\n  🐯🐯🐯  \n🐯  脱  🐯\n  🐯🐯🐯  \n```",
    color: 0xff8800,
    flavorText: "식신 대호 소환 — 강력한 발톱이 적을 찢는다!"
  },
  "만상": {
    art: "```\n🌑🐕🌑🐯🌑\n🐯 萬 象 🐕\n🌑🐯🌑🐕🌑\n```",
    color: 0x2d1b69,
    flavorText: "열 가지 식신이 일제히 소환된다!"
  },
  "후루베 유라유라": {
    art: "```\n💀✨💀✨💀\n✨ 振 魂 ✨\n💀✨💀✨💀\n```",
    color: 0x8b0000,
    flavorText: "마허라가라 강림 — 최강의 식신이 깨어난다!"
  },
  "망치질": {
    art: "```\n  🔨🔨🔨  \n⚡  釘  ⚡\n  🔨🔨🔨  \n```",
    color: 0xff69b4,
    flavorText: "저주 못을 적의 영혼에 박아넣는다!"
  },
  "공명": {
    art: "```\n🌸💥🌸💥🌸\n💥 共 鳴 💥\n🌸💥🌸💥🌸\n```",
    color: 0xff1493,
    flavorText: "허수아비를 통한 공명 피해 — 영혼이 직접 타격된다!"
  },
  "철정": {
    art: "```\n⚡🔨⚡🔨⚡\n🔨 鉄 釘 🔨\n⚡🔨⚡🔨⚡\n```",
    color: 0xdc143c,
    flavorText: "저주 에너지 주입 — 못이 몸 속에서 폭발한다!"
  },
  "발화": {
    art: "```\n🔥🌸🔥🌸🔥\n🌸 発 火 🌸\n🔥🌸🔥🌸🔥\n```",
    color: 0xff4500,
    flavorText: "모든 못에 동시 폭발 공명 — 영혼이 불타오른다!"
  },
  "해": {
    art: "```\n  ✂️✂️✂️  \n✂️  解  ✂️\n  ✂️✂️✂️  \n```",
    color: 0xcc0000,
    flavorText: "만물을 베어내는 저주의 왕의 손톱!"
  },
  "팔": {
    art: "```\n🌌✂️🌌✂️🌌\n✂️  捌  ✂️\n🌌✂️🌌✂️🌌\n```",
    color: 0x8b0000,
    flavorText: "공간 자체를 베어내는 절대적 술식!"
  },
  "푸가": {
    art: "```\n💀🔥💀🔥💀\n🔥 不 雅 🔥\n💀🔥💀🔥💀\n```",
    color: 0x4a0000,
    flavorText: "닿는 모든 것을 분해한다 — 저주의 왕의 진면목!"
  },
  "복마어주자": {
    art: "```\n👑🌑👑🌑👑\n🌑伏魔御廚子🌑\n👑🌑👑🌑👑\n```",
    color: 0x2a0000,
    flavorText: "천지개벽 — 저주의 왕의 궁극 영역전개!"
  },
  "세계참": {
    art: "```\n🌍✂️🌍✂️🌍\n✂️ 世界斬 ✂️\n🌍✂️🌍✂️🌍\n```",
    color: 0x4a0000,
    flavorText: "세계조차 베어버린다!"
  },
  "_default": {
    art: "```\n  ✨✨✨  \n✨ 術 式 ✨\n  ✨✨✨  \n```",
    color: 0x7c5cfc,
    flavorText: "저주 에너지가 폭발한다!"
  },
};

function getSkillEffect(skillName) {
  return SKILL_EFFECTS[skillName] || SKILL_EFFECTS["_default"];
}
// ════════════════════════════════════════════════════════════════════════════════
// ── 캐릭터 데이터
// ════════════════════════════════════════════════════════════════════════════════
const CHARACTERS = {
  // ═══════════════════════════════════════════════════════════════════════════════
  // 이타도리 유지
  // ═══════════════════════════════════════════════════════════════════════════════
  itadori: {
    name: "이타도리 유지",
    emoji: "🟠",
    grade: "준1급",
    atk: 90,
    def: 75,
    spd: 85,
    maxHp: 1000,
    domain: null,
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
  
  // ═══════════════════════════════════════════════════════════════════════════════
  // 고조 사토루
  // ═══════════════════════════════════════════════════════════════════════════════
  gojo: {
    name: "고조 사토루",
    emoji: "🔵",
    grade: "특급",
    atk: 130,
    def: 120,
    spd: 110,
    maxHp: 1800,
    domain: "무량공처",
    desc: "최강의 주술사. 무량공처를 구사한다.",
    lore: "\"사람들이 왜 내가 최강이라고 하는지 알아? 이 무한이 있어서야.\"",
    skills: [
      { name: "아오", minMastery: 0, dmg: 145, desc: "적들을 끌어당겨서 공격한다." },
      { name: "아카", minMastery: 5, dmg: 220, desc: "적들을 날려서 폭발시킨다.", statusApply: { target: "enemy", statusId: "burn", chance: 0.5 } },
      { name: "무라사키", minMastery: 15, dmg: 320, desc: "아오와 아카를 합쳐서 발사.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.6 } },
      { name: "무량공처", minMastery: 30, dmg: 480, desc: "무한을 지배하는 궁극술식.", statusApply: { target: "enemy", statusId: "freeze", chance: 0.8 } },
    ],
  },
  
  // ═══════════════════════════════════════════════════════════════════════════════
  // 후시구로 메구미
  // ═══════════════════════════════════════════════════════════════════════════════
  megumi: {
    name: "후시구로 메구미",
    emoji: "⚫",
    grade: "1급",
    atk: 110,
    def: 108,
    spd: 100,
    maxHp: 1250,
    domain: "강압암예정",
    desc: "식신술을 구사하는 주술사.",
    lore: "\"나는 선한 사람을 구하기 위해 싸운다.\"",
    skills: [
      { name: "옥견", minMastery: 0, dmg: 115, desc: "식신 옥견을 소환한다." },
      { name: "탈토", minMastery: 5, dmg: 180, desc: "식신 대호를 소환한다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.4 } },
      { name: "만상", minMastery: 15, dmg: 265, desc: "열 가지 식신을 소환한다.", statusApply: { target: "enemy", statusId: "poison", chance: 0.5 } },
      { name: "후루베 유라유라", minMastery: 30, dmg: 380, desc: "최강의 식신, 마허라가라 강림.", statusApply: { target: "enemy", statusId: "stun", chance: 0.6 } },
    ],
  },
  
  // ═══════════════════════════════════════════════════════════════════════════════
  // 쿠기사키 노바라
  // ═══════════════════════════════════════════════════════════════════════════════
  nobara: {
    name: "쿠기사키 노바라",
    emoji: "🌸",
    grade: "1급",
    atk: 115,
    def: 95,
    spd: 105,
    maxHp: 1180,
    domain: null,
    desc: "망치를 이용해 영혼에 공격 가능한 주술사.",
    lore: "\"도쿄에 올 때부터 각오는 되어 있었어.\"",
    skills: [
      { name: "망치질", minMastery: 0, dmg: 118, desc: "저주 못을 박는다." },
      { name: "공명", minMastery: 5, dmg: 195, desc: "허수아비를 통해 공명 피해.", statusApply: { target: "enemy", statusId: "poison", chance: 0.5 } },
      { name: "철정", minMastery: 15, dmg: 280, desc: "저주 에너지 주입 못을 박는다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.5 } },
      { name: "발화", minMastery: 30, dmg: 390, desc: "모든 못에 동시 폭발 공명.", statusApply: { target: "enemy", statusId: "burn", chance: 0.8 } },
    ],
  },
  
  // ═══════════════════════════════════════════════════════════════════════════════
  // 나나미 켄토
  // ═══════════════════════════════════════════════════════════════════════════════
  nanami: {
    name: "나나미 켄토",
    emoji: "🟡",
    grade: "1급",
    atk: 118,
    def: 108,
    spd: 90,
    maxHp: 1380,
    domain: null,
    desc: "1급 주술사. 합리적 판단의 소유자.",
    lore: "\"초과 근무는 사절이지만... 이건 일이 아닌 의무다.\"",
    skills: [
      { name: "둔기 공격", minMastery: 0, dmg: 120, desc: "단단한 둔기로 타격한다." },
      { name: "칠할삼분", minMastery: 5, dmg: 200, desc: "7:3 지점을 노린 약점 공격.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.6 } },
      { name: "십수할", minMastery: 15, dmg: 290, desc: "열 배의 저주 에너지 방출." },
      { name: "초과근무", minMastery: 30, dmg: 410, desc: "한계를 넘어선 폭발적 강화." },
    ],
  },
  
  // ═══════════════════════════════════════════════════════════════════════════════
  // 료멘 스쿠나
  // ═══════════════════════════════════════════════════════════════════════════════
  sukuna: {
    name: "료멘 스쿠나",
    emoji: "🔴",
    grade: "특급",
    atk: 140,
    def: 115,
    spd: 120,
    maxHp: 2500,
    domain: "복마어주자",
    desc: "저주의 왕. 역대 최강의 저주된 영혼.",
    lore: "\"약한 놈이 강한 놈을 거스르는 건 죄악이다.\"",
    skills: [
      { name: "해", minMastery: 0, dmg: 145, desc: "날카로운 손톱으로 베어낸다.", statusApply: { target: "enemy", statusId: "burn", chance: 0.4 } },
      { name: "팔", minMastery: 5, dmg: 235, desc: "공간 자체를 베어낸다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.5 } },
      { name: "푸가", minMastery: 15, dmg: 345, desc: "닿는 모든 것을 분해한다.", statusApply: { target: "enemy", statusId: "poison", chance: 0.7 } },
      { name: "세계참", minMastery: 30, dmg: 600, desc: "세계조차 베어버린다!", statusApply: { target: "enemy", statusId: "freeze", chance: 0.9 } },
    ],
  },
  
  // ═══════════════════════════════════════════════════════════════════════════════
  // 게토 스구루
  // ═══════════════════════════════════════════════════════════════════════════════
  geto: {
    name: "게토 스구루",
    emoji: "🟢",
    grade: "특급",
    atk: 115,
    def: 105,
    spd: 100,
    maxHp: 1600,
    domain: null,
    desc: "전 특급 주술사. 저주를 다루는 달인.",
    lore: "\"주술사는 비주술사를 지켜야 한다 — 아니, 그래야만 했어.\"",
    skills: [
      { name: "저주 방출", minMastery: 0, dmg: 125, desc: "저급 저주령을 방출한다." },
      { name: "최대출력", minMastery: 5, dmg: 210, desc: "저주령을 전력으로 방출.", statusApply: { target: "enemy", statusId: "poison", chance: 0.4 } },
      { name: "저주영조종", minMastery: 15, dmg: 300, desc: "수천의 저주령을 조종한다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.6 } },
      { name: "감로대법", minMastery: 30, dmg: 425, desc: "감로대법으로 모든 저주 흡수.", statusApply: { target: "enemy", statusId: "stun", chance: 0.5 } },
    ],
  },
  
  // ═══════════════════════════════════════════════════════════════════════════════
  // 마키 젠인
  // ═══════════════════════════════════════════════════════════════════════════════
  maki: {
    name: "마키 젠인",
    emoji: "⚪",
    grade: "준1급",
    atk: 122,
    def: 110,
    spd: 115,
    maxHp: 1300,
    domain: null,
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
};
  // ═══════════════════════════════════════════════════════════════════════════════
  // 판다
  // ═══════════════════════════════════════════════════════════════════════════════
   panda: {
    name: "판다",
    emoji: "🐼",
    grade: "2급",
    atk: 105, def: 118, spd: 85, maxHp: 1400, domain: null,
    desc: "저주로 만든 특이체질",
    skills: [
      { name: "박치기", minMastery: 0, dmg: 108, desc: "머리 박치기" },
      { name: "곰 발바닥", minMastery: 5, dmg: 175, desc: "발바닥 내리치기" },
      { name: "팬더 변신", minMastery: 15, dmg: 255, desc: "팬더 변신" },
      { name: "고릴라 변신", minMastery: 30, dmg: 360, desc: "고릴라 변신" }
    ]
  },
  inumaki: {
    name: "이누마키 토게",
    emoji: "🟤",
    grade: "준1급",
    atk: 112, def: 90, spd: 110, maxHp: 1120, domain: null,
    desc: "주술언어 사용자",
    skills: [
      { name: "멈춰라", minMastery: 0, dmg: 115, desc: "움직임 봉쇄" },
      { name: "달려라", minMastery: 5, dmg: 180, desc: "강제 이동" },
      { name: "주술언어", minMastery: 15, dmg: 265, desc: "강력 명령" },
      { name: "폭발해라", minMastery: 30, dmg: 375, desc: "폭발 명령" }
    ]
  },
  yuta: {
    name: "오코츠 유타",
    emoji: "🌟",
    grade: "특급",
    atk: 128, def: 112, spd: 115, maxHp: 1750, domain: "진안상애",
    desc: "특급 주술사",
    skills: [
      { name: "모방술식", minMastery: 0, dmg: 135, desc: "술식 복사" },
      { name: "리카 소환", minMastery: 5, dmg: 220, desc: "리카 소환" },
      { name: "순애빔", minMastery: 15, dmg: 340, desc: "사랑의 빔" },
      { name: "진안상애", minMastery: 30, dmg: 480, desc: "영역전개" }
    ]
  },
  higuruma: {
    name: "히구루마 히로미",
    emoji: "⚖️",
    grade: "1급",
    atk: 118, def: 105, spd: 95, maxHp: 1320, domain: "주복사사",
    desc: "전직 변호사",
    skills: [
      { name: "저주도구", minMastery: 0, dmg: 120, desc: "도구 공격" },
      { name: "몰수", minMastery: 5, dmg: 195, desc: "술식 몰수" },
      { name: "사형판결", minMastery: 15, dmg: 285, desc: "강력 제재" },
      { name: "집행인 인형", minMastery: 30, dmg: 410, desc: "인형 소환" }
    ]
  },
  jogo: {
    name: "죠고",
    emoji: "🌋",
    grade: "특급",
    atk: 125, def: 100, spd: 105, maxHp: 1680, domain: "개관철위산",
    desc: "화염 저주령",
    skills: [
      { name: "화염 분사", minMastery: 0, dmg: 130, desc: "불꽃 방사" },
      { name: "용암 폭발", minMastery: 5, dmg: 215, desc: "용암 폭발" },
      { name: "극번 운", minMastery: 15, dmg: 315, desc: "운석 소환" },
      { name: "개관철위산", minMastery: 30, dmg: 460, desc: "영역전개" }
    ]
  },
  dagon: {
    name: "다곤",
    emoji: "🌊",
    grade: "특급",
    atk: 118, def: 108, spd: 96, maxHp: 1620, domain: "탕온평선",
    desc: "수중 저주령",
    skills: [
      { name: "물고기 소환", minMastery: 0, dmg: 125, desc: "물고기 떼" },
      { name: "해수 폭발", minMastery: 5, dmg: 205, desc: "해수 압축" },
      { name: "조류 소용돌이", minMastery: 15, dmg: 295, desc: "물 소용돌이" },
      { name: "탕온평선", minMastery: 30, dmg: 450, desc: "영역전개" }
    ]
  },
  hanami: {
    name: "하나미",
    emoji: "🌿",
    grade: "특급",
    atk: 115, def: 118, spd: 93, maxHp: 1750, domain: null,
    desc: "식물 저주령",
    skills: [
      { name: "나무뿌리", minMastery: 0, dmg: 122, desc: "나무뿌리 채찍" },
      { name: "꽃비", minMastery: 5, dmg: 198, desc: "독성 꽃가루" },
      { name: "대지의 저주", minMastery: 15, dmg: 285, desc: "대지 에너지" },
      { name: "재앙의 꽃", minMastery: 30, dmg: 425, desc: "거대 꽃 소환" }
    ]
  },
  mahito: {
    name: "마히토",
    emoji: "🩸",
    grade: "특급",
    atk: 120, def: 98, spd: 110, maxHp: 1560, domain: "자폐원돈과",
    desc: "영혼 변형 저주령",
    skills: [
      { name: "영혼 변형", minMastery: 0, dmg: 128, desc: "영혼 타격" },
      { name: "무위전변", minMastery: 5, dmg: 212, desc: "신체 변형" },
      { name: "편사지경체", minMastery: 15, dmg: 308, desc: "무한 변형" },
      { name: "자폐원돈과", minMastery: 30, dmg: 455, desc: "영역전개" }
    ]
  },
  todo: {
    name: "토도 아오이",
    emoji: "💪",
    grade: "1급",
    atk: 128, def: 108, spd: 112, maxHp: 1500, domain: null,
    desc: "보조공격술 사용자",
    skills: [
      { name: "부기우기", minMastery: 0, dmg: 130, desc: "위치 전환" },
      { name: "브루탈 펀치", minMastery: 5, dmg: 215, desc: "파괴적 주먹" },
      { name: "흑섬", minMastery: 15, dmg: 320, desc: "흑섬" },
      { name: "전투본능", minMastery: 30, dmg: 450, desc: "자기 버프" }
    ]
  },
  hakari: {
    name: "하카리 킨지",
    emoji: "🎰",
    grade: "1급",
    atk: 125, def: 105, spd: 110, maxHp: 1650, domain: "좌살박도",
    desc: "복권 술식 사용자",
    skills: [
      { name: "파칭코볼", minMastery: 0, dmg: 125, desc: "공으로 상대를 견제" },
      { name: "좌살박도", minMastery: 5, dmg: 210, desc: "질풍처럼 돌진해서 강력하게 타격한다" },
      { name: "셔터공격", minMastery: 15, dmg: 315, desc: "하카리의 술식인 셔터로 공격한다" },
      { name: "좌살박도", minMastery: 30, dmg: 480, desc: "영역전개" }
    ]
  },
// ════════════════════════════════════════════════════════════════════════════════
// ── 적 데이터
// ════════════════════════════════════════════════════════════════════════════════
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

// ════════════════════════════════════════════════════════════════════════════════
// ── 가챠 풀
// ════════════════════════════════════════════════════════════════════════════════
const GACHA_POOL = [
  { id: "gojo", rate: 0.3 },
  { id: "yuta", rate: 0.45 },
  { id: "sukuna", rate: 0.5 },
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
  { id: "hakari", rate: 5.0 },
  { id: "panda", rate: 32.0 },
  { id: "inumaki", rate: 23.75 },
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
    for (const e of GACHA_POOL) {
      roll -= e.rate;
      if (roll <= 0) return e.id;
    }
    return GACHA_POOL[0].id;
  });
}

const REVERSE_CHARS = new Set(["gojo", "yuta", "sukuna"]);
const CODES = {
  "release": { crystals: 200 },
  "sorryforbugs": { crystals: 1000 },
  "jjk1000": { crystals: 1000 },
  "specialgrade": { crystals: 500, fingers: 1 },
};

// ════════════════════════════════════════════════════════════════════════════════
// ── 인메모리 세션
// ════════════════════════════════════════════════════════════════════════════════
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

// ════════════════════════════════════════════════════════════════════════════════
// ── 플레이어 유틸
// ════════════════════════════════════════════════════════════════════════════════
function getPlayer(userId, username = "플레이어") {
  if (!players[userId]) {
    players[userId] = {
      id: userId,
      name: username,
      crystals: 500,
      xp: 0,
      owned: ["itadori"],
      active: "itadori",
      hp: CHARACTERS["itadori"].maxHp,
      potion: 3,
      wins: 0,
      losses: 0,
      pvpWins: 0,
      pvpLosses: 0,
      mastery: { itadori: 0 },
      reverseCooldown: 0,
      skillCooldown: 0,
      statusEffects: [],
      cullingBest: 0,
      jujutsuBest: 0,
      usedCodes: [],
      lastDaily: 0,
      dailyStreak: 0,
      sukunaFingers: 0,
      kogane: null,
      koganeGachaCount: 0,
      mainSkill: null,
      // 퀘스트 시스템
      quests: {
        daily: [],
        weekly: [],
        lastDailyReset: Date.now(),
        lastWeeklyReset: Date.now(),
      },
      // 주구 제작 시스템
      materials: {},
      tools: [],
      // 도전과제
      achievements: {
        firstWin: false,
        fingerCollector: false,
        cullingMaster: false,
        jujutsuComplete: false,
        pvpFirstWin: false,
        partyPlay: false,
        toolCrafter: false,
      },
    };
    savePlayer(userId);
  }
  
  const p = players[userId];
  if (p.achievements === undefined) {
    p.achievements = {
      firstWin: false, fingerCollector: false, cullingMaster: false,
      jujutsuComplete: false, pvpFirstWin: false, partyPlay: false, toolCrafter: false,
    };
  }
  if (p.quests === undefined) {
    p.quests = { daily: [], weekly: [], lastDailyReset: Date.now(), lastWeeklyReset: Date.now() };
  }
  if (p.materials === undefined) p.materials = {};
  if (p.tools === undefined) p.tools = [];
  
  // 닉네임 업데이트
  if (p.name !== username && username !== "플레이어") {
    p.name = username;
    savePlayer(userId);
  }
  
  return p;
}

function getMastery(player, charId) {
  return player.mastery?.[charId] || 0;
}

function getAvailableSkills(player, charId) {
  const m = getMastery(player, charId);
  let skills = CHARACTERS[charId].skills.filter(s => m >= s.minMastery);
  
  // 스쿠나: 손가락 개수에 따라 스킬 해금
  if (charId === "sukuna") {
    const fingers = player.sukunaFingers || 0;
    skills = skills.filter((s, idx) => isSukunaSkillUnlocked(fingers, idx));
  }
  return skills;
}

function getCurrentSkill(player, charId) {
  const skills = getAvailableSkills(player, charId);
  if (skills.length === 0) return CHARACTERS[charId].skills[0];
  return skills[skills.length - 1];
}

function getMainSkill(player, charId) {
  if (player.mainSkill && CHARACTERS[charId].skills.some(s => s.name === player.mainSkill)) {
    const skill = CHARACTERS[charId].skills.find(s => s.name === player.mainSkill);
    const m = getMastery(player, charId);
    if (m >= skill.minMastery) return skill;
  }
  return getCurrentSkill(player, charId);
}

function getMainSkillBonus(player) {
  let bonus = 0;
  if (player.achievements.firstWin) bonus += 10;
  if (player.achievements.fingerCollector) bonus += 20;
  if (player.achievements.cullingMaster) bonus += 15;
  if (player.achievements.jujutsuComplete) bonus += 25;
  if (player.achievements.pvpFirstWin) bonus += 20;
  if (player.achievements.partyPlay) bonus += 15;
  if (player.achievements.toolCrafter) bonus += 10;
  return bonus;
}

function checkAchievements(player) {
  let changed = false;
  if (!player.achievements.firstWin && player.wins >= 1) {
    player.achievements.firstWin = true;
    changed = true;
  }
  if (!player.achievements.fingerCollector && (player.sukunaFingers || 0) >= 5) {
    player.achievements.fingerCollector = true;
    changed = true;
  }
  if (!player.achievements.cullingMaster && player.cullingBest >= 5) {
    player.achievements.cullingMaster = true;
    changed = true;
  }
  if (!player.achievements.jujutsuComplete && (player.jujutsuBest || 0) >= 15) {
    player.achievements.jujutsuComplete = true;
    changed = true;
  }
  if (!player.achievements.pvpFirstWin && (player.pvpWins || 0) >= 1) {
    player.achievements.pvpFirstWin = true;
    changed = true;
  }
  if (changed) savePlayer(player.id);
  return changed;
}

function getPlayerStats(player) {
  const ch = CHARACTERS[player.active];
  const kb = getKoganeBonus(player);
  
  if (player.active === "itadori" || player.active === "sukuna") {
    const bonus = getFingerBonus(player.sukunaFingers || 0);
    return {
      atk: Math.floor((ch.atk + bonus.atkBonus) * kb.atk),
      def: Math.floor((ch.def + bonus.defBonus) * kb.def),
      maxHp: Math.floor((ch.maxHp + bonus.hpBonus) * kb.hp),
    };
  }
  
  return {
    atk: Math.floor(ch.atk * kb.atk),
    def: Math.floor(ch.def * kb.def),
    maxHp: Math.floor(ch.maxHp * kb.hp),
  };
}

function getLevel(xp) {
  return Math.floor(xp / 200) + 1;
}

function hpBar(cur, max, len = 10) {
  const pct = Math.max(0, Math.min(1, cur / max));
  const fill = Math.round(pct * len);
  const color = pct > 0.5 ? "🟩" : pct > 0.25 ? "🟨" : "🟥";
  return color.repeat(fill) + "⬛".repeat(len - fill);
}

function hpBarText(cur, max, len = 12) {
  const fill = Math.round((Math.max(0, cur) / max) * len);
  return "`" + "█".repeat(fill) + "░".repeat(len - fill) + "`";
}

function isMakiAwakened(player) {
  if (player.active !== "maki") return false;
  const stats = getPlayerStats(player);
  return player.hp <= Math.floor(stats.maxHp * CHARACTERS["maki"].awakening.threshold);
}

function calcDmg(atk, def, mult = 1) {
  const variance = 0.70 + Math.random() * 0.60;
  return Math.max(1, Math.floor((atk * variance - def * 0.22) * mult));
}

function calcDmgForPlayer(player, enemyDef, baseMult = 1) {
  const stats = getPlayerStats(player);
  let mult = baseMult * getDamageMult(player.statusEffects);
  if (isMakiAwakened(player)) mult *= CHARACTERS["maki"].awakening.dmgMult;
  return calcDmg(stats.atk, enemyDef, mult);
}

function calcSkillDmgForPlayer(player, baseSkillDmg) {
  let dmg = baseSkillDmg + Math.floor(Math.random() * 60);
  dmg = Math.floor(dmg * getDamageMult(player.statusEffects));
  if (isMakiAwakened(player)) dmg = Math.floor(dmg * CHARACTERS["maki"].awakening.dmgMult);
  
  // 주력 스킬 보너스
  const mainSkill = getMainSkill(player, player.active);
  const currentSkill = getCurrentSkill(player, player.active);
  if (mainSkill.name === currentSkill.name) {
    const bonus = getMainSkillBonus(player);
    dmg = Math.floor(dmg * (1 + bonus / 100));
  }
  
  // 스쿠나 손가락 보너스
  if (player.active === "sukuna") {
    const bonus = getFingerBonus(player.sukunaFingers || 0);
    dmg = Math.floor(dmg * (1 + bonus.skillBonus / 100));
  }
  if (player.active === "itadori") {
    const bonus = getFingerBonus(player.sukunaFingers || 0);
    dmg = Math.floor(dmg * (1 + bonus.atkBonus / 120));
  }
  
  const kb = getKoganeBonus(player);
  dmg = Math.floor(dmg * kb.atk);
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

function getNextSkill(player, charId) {
  const m = getMastery(player, charId);
  return CHARACTERS[charId].skills.find(s => s.minMastery > m) || null;
}
// ════════════════════════════════════════════════════════════════════════════════
// ── 퀘스트 시스템 (일일/주간)
// ════════════════════════════════════════════════════════════════════════════════
const DAILY_QUESTS = [
  { id: "daily_1", name: "일반 전투 3회 승리", target: 3, type: "battle_win", reward: { crystals: 50, xp: 100 } },
  { id: "daily_2", name: "컬링 5웨이브 클리어", target: 5, type: "culling_wave", reward: { crystals: 80, xp: 150 } },
  { id: "daily_3", name: "사멸회유 10포인트 획득", target: 10, type: "jujutsu_point", reward: { crystals: 60, xp: 120 } },
  { id: "daily_4", name: "스킬 사용 10회", target: 10, type: "skill_use", reward: { crystals: 40, xp: 80 } },
  { id: "daily_5", name: "회복약 사용 1회", target: 1, type: "potion_use", reward: { crystals: 30, masteryXp: 5 } },
  { id: "daily_6", name: "적 5마리 처치", target: 5, type: "enemy_kill", reward: { crystals: 45, xp: 90 } },
  { id: "daily_7", name: "코가네와 전투 1회", target: 1, type: "kogane_battle", reward: { crystals: 35, xp: 70 } },
];

const WEEKLY_QUESTS = [
  { id: "weekly_1", name: "일반 전투 20회 승리", target: 20, type: "battle_win", reward: { crystals: 300, xp: 500, fingers: 1 } },
  { id: "weekly_2", name: "컬링 30웨이브 클리어", target: 30, type: "culling_wave", reward: { crystals: 400, xp: 600 } },
  { id: "weekly_3", name: "사멸회유 50포인트 획득", target: 50, type: "jujutsu_point", reward: { crystals: 350, xp: 550 } },
  { id: "weekly_4", name: "PvP 5회 승리", target: 5, type: "pvp_win", reward: { crystals: 500, xp: 800 } },
  { id: "weekly_5", name: "스쿠나 손가락 3개 획득", target: 3, type: "finger_get", reward: { crystals: 600, xp: 1000 } },
  { id: "weekly_6", name: "영역전개 3회 사용", target: 3, type: "domain_use", reward: { crystals: 450, xp: 750 } },
  { id: "weekly_7", name: "주구 제작 1회", target: 1, type: "tool_craft", reward: { crystals: 400, xp: 600 } },
];

function initQuestData(player) {
  const now = Date.now();
  const DAY = 86400000;
  const WEEK = DAY * 7;
  
  if (!player.quests || player.quests.daily.length === 0) {
    player.quests = {
      daily: DAILY_QUESTS.map(q => ({ ...q, progress: 0, completed: false, claimed: false })),
      weekly: WEEKLY_QUESTS.map(q => ({ ...q, progress: 0, completed: false, claimed: false })),
      lastDailyReset: now,
      lastWeeklyReset: now,
    };
  }
  
  // 일일 퀘스트 리셋
  if (now - player.quests.lastDailyReset >= DAY) {
    player.quests.daily.forEach(q => {
      q.progress = 0;
      q.completed = false;
      q.claimed = false;
    });
    player.quests.lastDailyReset = now;
  }
  
  // 주간 퀘스트 리셋
  if (now - player.quests.lastWeeklyReset >= WEEK) {
    player.quests.weekly.forEach(q => {
      q.progress = 0;
      q.completed = false;
      q.claimed = false;
    });
    player.quests.lastWeeklyReset = now;
  }
}

function updateQuestProgress(player, type, amount = 1) {
  initQuestData(player);
  const completedQuests = [];
  
  // 일일 퀘스트 업데이트
  for (const quest of player.quests.daily) {
    if (!quest.completed && quest.type === type) {
      quest.progress += amount;
      if (quest.progress >= quest.target) {
        quest.completed = true;
        completedQuests.push({ ...quest, isDaily: true });
      }
    }
  }
  
  // 주간 퀘스트 업데이트
  for (const quest of player.quests.weekly) {
    if (!quest.completed && quest.type === type) {
      quest.progress += amount;
      if (quest.progress >= quest.target) {
        quest.completed = true;
        completedQuests.push({ ...quest, isDaily: false });
      }
    }
  }
  
  return completedQuests;
}

function claimQuestReward(player, questId, isDaily) {
  initQuestData(player);
  const questList = isDaily ? player.quests.daily : player.quests.weekly;
  const quest = questList.find(q => q.id === questId);
  
  if (!quest) return { success: false, message: "존재하지 않는 퀘스트입니다." };
  if (!quest.completed) return { success: false, message: "퀘스트를 완료하지 않았습니다!" };
  if (quest.claimed) return { success: false, message: "이미 보상을 받았습니다!" };
  
  const reward = quest.reward;
  player.crystals += reward.crystals || 0;
  player.xp += reward.xp || 0;
  if (reward.masteryXp && player.active) {
    player.mastery[player.active] = (player.mastery[player.active] || 0) + reward.masteryXp;
  }
  if (reward.fingers) {
    player.sukunaFingers = Math.min(SUKUNA_FINGER_MAX, (player.sukunaFingers || 0) + reward.fingers);
  }
  quest.claimed = true;
  
  return {
    success: true,
    message: `✅ ${quest.name} 보상 지급!`,
    reward: reward,
  };
}

function getQuestEmbed(player) {
  initQuestData(player);
  
  const dailyLines = player.quests.daily.map(q => {
    let status = "⏳";
    if (q.completed && !q.claimed) status = "🎁";
    if (q.claimed) status = "✅";
    return `${status} **${q.name}** ${q.progress}/${q.target} → +${q.reward.crystals || 0}💎 +${q.reward.xp || 0}XP`;
  }).join("\n");
  
  const weeklyLines = player.quests.weekly.map(q => {
    let status = "⏳";
    if (q.completed && !q.claimed) status = "🎁";
    if (q.claimed) status = "✅";
    const fingerText = q.reward.fingers ? ` +${q.reward.fingers}👹` : "";
    return `${status} **${q.name}** ${q.progress}/${q.target} → +${q.reward.crystals || 0}💎 +${q.reward.xp || 0}XP${fingerText}`;
  }).join("\n");
  
  return new EmbedBuilder()
    .setTitle("📋 일일/주간 퀘스트")
    .setColor(0xF5C842)
    .addFields(
      { name: "🌞 일일 퀘스트 (매일 초기화)", value: dailyLines || "없음", inline: false },
      { name: "📅 주간 퀘스트 (매주 초기화)", value: weeklyLines || "없음", inline: false },
    )
    .setFooter({ text: "/퀘스트보상 [일일/주간] [번호] 로 보상 수령" });
}
// ════════════════════════════════════════════════════════════════════════════════
// ── 주구(주술구) 제작 시스템
// ════════════════════════════════════════════════════════════════════════════════
const JUJUTSU_TOOLS = {
  "흑단 지팡이": {
    grade: "특급",
    materials: { "어두운 결정": 5, "저주의 파편": 10, "스쿠나의 손톱": 1 },
    atkBonus: 50,
    effect: "공격 시 20% 확률로 약화 부여",
    emoji: "🪄",
    desc: "전설적인 주술 도구. 어둠의 힘이 깃들어 있다.",
  },
  "옥운": {
    grade: "1급",
    materials: { "빛나는 구슬": 3, "저주의 파편": 8 },
    atkBonus: 30,
    effect: "HP 30% 이하 시 방어력 50% 증가",
    emoji: "🔮",
    desc: "옥으로 만들어진 수호의 도구.",
  },
  "저주 못": {
    grade: "2급",
    materials: { "저주의 파편": 5, "녹슨 못": 3 },
    atkBonus: 15,
    effect: "공격 시 10% 확률로 출혈",
    emoji: "📌",
    desc: "저주 에너지가 깃든 못.",
  },
  "저주 도구": {
    grade: "3급",
    materials: { "저주의 파편": 3 },
    atkBonus: 8,
    effect: "기본 공격 데미지 +8",
    emoji: "⚔️",
    desc: "일반적인 저주 도구.",
  },
  "금강저": {
    grade: "특급",
    materials: { "어두운 결정": 8, "저주의 파편": 15, "스쿠나의 손톱": 2, "금강석": 1 },
    atkBonus: 80,
    effect: "공격 시 30% 확률로 기절, 치명타 확률 15% 증가",
    emoji: "🔱",
    desc: "불교의 성물에서 유래한 최강의 주구.",
  },
  "칠지도": {
    grade: "1급",
    materials: { "빛나는 구슬": 5, "저주의 파편": 12, "칠흑의 철": 2 },
    atkBonus: 45,
    effect: "연속 공격 시 데미지 10%씩 증가 (최대 50%)",
    emoji: "🗡️",
    desc: "일곱 개의 가지가 달린 신비한 검.",
  },
};

// 재료 드랍 테이블 (주령 처치 시)
const MATERIAL_DROPS = {
  "저주의 파편": { rate: 0.6, min: 1, max: 3 },
  "어두운 결정": { rate: 0.2, min: 1, max: 1 },
  "녹슨 못": { rate: 0.3, min: 1, max: 2 },
  "빛나는 구슬": { rate: 0.1, min: 1, max: 1 },
  "스쿠나의 손톱": { rate: 0.05, min: 1, max: 1 },
  "금강석": { rate: 0.02, min: 1, max: 1 },
  "칠흑의 철": { rate: 0.08, min: 1, max: 2 },
};

// 주령 처치 시 재료 드랍
function dropMaterials(enemyGrade = "normal") {
  const drops = [];
  let multiplier = 1;
  if (enemyGrade === "boss") multiplier = 2;
  if (enemyGrade === "elite") multiplier = 1.5;
  
  for (const [material, data] of Object.entries(MATERIAL_DROPS)) {
    let rate = data.rate;
    if (material === "금강석") rate = 0.02;
    if (material === "스쿠나의 손톱") rate = 0.05;
    
    if (Math.random() < rate) {
      const amount = (data.min + Math.floor(Math.random() * (data.max - data.min + 1))) * multiplier;
      drops.push({ material, amount });
    }
  }
  return drops;
}

// 재료 추가
function addMaterials(player, drops) {
  if (!player.materials) player.materials = {};
  for (const drop of drops) {
    player.materials[drop.material] = (player.materials[drop.material] || 0) + drop.amount;
  }
}

// 주구 제작 가능 여부 확인
function canCraftTool(player, toolName) {
  const tool = JUJUTSU_TOOLS[toolName];
  if (!tool) return { success: false, message: "존재하지 않는 주구입니다." };
  if (!player.materials) player.materials = {};
  
  for (const [material, required] of Object.entries(tool.materials)) {
    const current = player.materials[material] || 0;
    if (current < required) {
      return { success: false, message: `재료 부족: ${material} ${required}개 필요 (보유: ${current})` };
    }
  }
  return { success: true };
}

// 주구 제작 실행
function craftTool(player, toolName) {
  const check = canCraftTool(player, toolName);
  if (!check.success) return check;
  
  const tool = JUJUTSU_TOOLS[toolName];
  
  // 재료 소모
  for (const [material, required] of Object.entries(tool.materials)) {
    player.materials[material] -= required;
    if (player.materials[material] <= 0) delete player.materials[material];
  }
  
  // 주구 추가 (중복 시 수량 증가)
  const existingTool = player.tools?.find(t => t.name === toolName);
  if (existingTool) {
    existingTool.count = (existingTool.count || 1) + 1;
  } else {
    if (!player.tools) player.tools = [];
    player.tools.push({ name: toolName, count: 1, equipped: false });
  }
  
  return { success: true, message: `✅ **${toolName}** 제작 완료!`, tool: tool };
}

// 주구 장착/해제
function equipTool(player, toolName) {
  if (!player.tools) player.tools = [];
  const tool = player.tools.find(t => t.name === toolName);
  if (!tool) return { success: false, message: "해당 주구를 보유하지 않았습니다." };
  
  // 기존 장착 해제
  player.tools.forEach(t => { t.equipped = false; });
  tool.equipped = true;
  player.equippedTool = toolName;
  
  return { success: true, message: `✅ **${toolName}** 장착 완료!` };
}

function unequipTool(player) {
  if (player.tools) {
    player.tools.forEach(t => { t.equipped = false; });
  }
  player.equippedTool = null;
  return { success: true, message: "주구를 해제했습니다." };
}

// 장착된 주구의 효과 적용
function getEquippedToolBonus(player) {
  if (!player.equippedTool) return null;
  const tool = JUJUTSU_TOOLS[player.equippedTool];
  if (!tool) return null;
  return tool;
}

function getToolEmbed(player) {
  const toolsList = player.tools || [];
  const equipped = player.equippedTool;
  
  const toolLines = toolsList.map(t => {
    const toolData = JUJUTSU_TOOLS[t.name];
    const equippedMark = t.equipped ? " ✅ 장착중" : "";
    return `> ${toolData.emoji} **${t.name}** x${t.count} [${toolData.grade}]${equippedMark}\n> └ ${toolData.effect}`;
  }).join("\n") || "> 보유한 주구가 없습니다.";
  
  const materialsList = Object.entries(player.materials || {})
    .map(([m, count]) => `> ${m}: ${count}개`)
    .join("\n") || "> 보유한 재료가 없습니다.";
  
  const craftableList = Object.entries(JUJUTSU_TOOLS)
    .filter(([name, tool]) => {
      const check = canCraftTool(player, name);
      return check.success;
    })
    .map(([name, tool]) => `> ${tool.emoji} **${name}** [${tool.grade}] - ${tool.effect}`)
    .join("\n") || "> 현재 제작 가능한 주구가 없습니다.";
  
  return new EmbedBuilder()
    .setTitle("🔧 주구 제작소")
    .setColor(0xF5C842)
    .addFields(
      { name: "📦 보유 주구", value: toolLines, inline: false },
      { name: "🎒 보유 재료", value: materialsList, inline: true },
      { name: "✨ 제작 가능 목록", value: craftableList, inline: false },
    )
    .setFooter({ text: "/제작 [주구명] | /장착 [주구명] | /재료확인" });
}

function getMaterialsEmbed(player) {
  const materialsList = Object.entries(player.materials || {})
    .map(([m, count]) => {
      let emoji = "📦";
      if (m === "저주의 파편") emoji = "💀";
      if (m === "어두운 결정") emoji = "⚫";
      if (m === "빛나는 구슬") emoji = "✨";
      if (m === "스쿠나의 손톱") emoji = "🖕";
      if (m === "금강석") emoji = "💎";
      return `${emoji} **${m}**: ${count}개`;
    })
    .join("\n") || "보유한 재료가 없습니다.";
  
  return new EmbedBuilder()
    .setTitle("🎒 재료 인벤토리")
    .setColor(0x7C5CFC)
    .setDescription(materialsList)
    .addFields({
      name: "📖 재료 획처",
      value: "> 저주령 처치 시 확률로 드랍됩니다.\n> 강한 적일수록 더 좋은 재료를 드랍합니다.",
      inline: false,
    })
    .setFooter({ text: "/제작 으로 주구를 만들 수 있습니다!" });
}
// ════════════════════════════════════════════════════════════════════════════════
// ── GIF 프로필 카드 생성 함수
// ════════════════════════════════════════════════════════════════════════════════
async function createJJKGifProfileCard(player, stats, ch, avatarUrl) {
  const width = 600;
  const height = 800;
  const encoder = new GIFEncoder(width, height);
  
  const tempPath = path.join(GIF_DIR, `jjk_profile_${player.id || Date.now()}.gif`);
  const stream = createWriteStream(tempPath);
  encoder.createReadStream().pipe(stream);
  
  encoder.start();
  encoder.setRepeat(0);
  encoder.setDelay(120);
  encoder.setQuality(10);
  
  for (let frame = 0; frame < 12; frame++) {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    
    // 배경 - 주술회전 어둠 테마
    const grad = ctx.createLinearGradient(0, 0, width, height);
    grad.addColorStop(0, "#0a0a1a");
    grad.addColorStop(0.5, "#1a1a2e");
    grad.addColorStop(1, "#0d0d1a");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);
    
    // 배경에 희미한 주술 원문 패턴
    ctx.font = "bold 80px 'Noto Sans KR'";
    ctx.fillStyle = "rgba(255, 255, 255, 0.03)";
    ctx.fillText("呪", 50, 200);
    ctx.fillText("術", 450, 400);
    ctx.fillText("迴", 100, 600);
    ctx.fillText("戦", 480, 750);
    
    // 움직이는 외곽 테두리
    const borderColors = ["#F5C842", "#ff8c00", "#e63946", "#7C5CFC"];
    const colorIdx = frame % borderColors.length;
    ctx.strokeStyle = borderColors[colorIdx];
    ctx.lineWidth = 6;
    ctx.strokeRect(12, 12, width - 24, height - 24);
    
    const pulse = Math.sin(frame * 0.5) * 0.3 + 0.7;
    ctx.strokeStyle = `rgba(245, 200, 66, ${pulse * 0.6})`;
    ctx.lineWidth = 2;
    ctx.strokeRect(18, 18, width - 36, height - 36);
    
    // 모서리 장식
    const cornerSize = 40;
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#F5C842";
    ctx.beginPath();
    ctx.moveTo(12, 12 + cornerSize);
    ctx.lineTo(12, 12);
    ctx.lineTo(12 + cornerSize, 12);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(width - 12, 12 + cornerSize);
    ctx.lineTo(width - 12, 12);
    ctx.lineTo(width - 12 - cornerSize, 12);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(12, height - 12 - cornerSize);
    ctx.lineTo(12, height - 12);
    ctx.lineTo(12 + cornerSize, height - 12);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(width - 12, height - 12 - cornerSize);
    ctx.lineTo(width - 12, height - 12);
    ctx.lineTo(width - 12 - cornerSize, height - 12);
    ctx.stroke();
    
    // 디스코드 프로필 이미지 (오른쪽 상단 모서리)
    const avatarSize = 80;
    const avatarX = width - avatarSize - 25;
    const avatarY = 25;
    try {
      const avatarImg = await loadImage(avatarUrl);
      ctx.save();
      ctx.beginPath();
      ctx.arc(avatarX + avatarSize/2, avatarY + avatarSize/2, avatarSize/2, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(avatarImg, avatarX, avatarY, avatarSize, avatarSize);
      ctx.restore();
      ctx.beginPath();
      ctx.arc(avatarX + avatarSize/2, avatarY + avatarSize/2, avatarSize/2 + 3, 0, Math.PI * 2);
      ctx.strokeStyle = `hsl(${frame * 30}, 80%, 60%)`;
      ctx.lineWidth = 3;
      ctx.stroke();
    } catch (e) {
      ctx.fillStyle = "#2a2a3e";
      ctx.beginPath();
      ctx.arc(avatarX + avatarSize/2, avatarY + avatarSize/2, avatarSize/2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#aaa";
      ctx.font = "40px sans-serif";
      ctx.fillText("👤", avatarX + avatarSize/4, avatarY + avatarSize/1.5);
    }
    
    // 캐릭터 정보
    ctx.font = "bold 32px 'Noto Sans KR'";
    ctx.fillStyle = "#F5C842";
    ctx.textAlign = "center";
    ctx.fillText(ch.name, width / 2, 80);
    ctx.font = "18px 'Noto Sans KR'";
    ctx.fillStyle = "#ff8c00";
    ctx.fillText(JJK_GRADE_LABEL[ch.grade] || `【 ${ch.grade} 】`, width / 2, 120);
    
    if (ch.domain) {
      ctx.font = "14px monospace";
      ctx.fillStyle = "#7C5CFC";
      ctx.fillText(`🌌 영역전개: ${ch.domain}`, width / 2, 150);
    }
    
    // HP 바
    const hpPercent = Math.max(0, player.hp) / stats.maxHp;
    const hpBarWidth = width - 100;
    const hpBarX = 50;
    const hpBarY = 190;
    ctx.fillStyle = "#330000";
    ctx.fillRect(hpBarX, hpBarY, hpBarWidth, 20);
    if (hpPercent > 0.6) ctx.fillStyle = "#4ade80";
    else if (hpPercent > 0.3) ctx.fillStyle = "#facc15";
    else ctx.fillStyle = "#ef4444";
    ctx.fillRect(hpBarX, hpBarY, hpBarWidth * hpPercent, 20);
    ctx.font = "bold 14px monospace";
    ctx.fillStyle = "#fff";
    ctx.fillText(`${Math.max(0, player.hp)}/${stats.maxHp} HP`, width / 2, hpBarY + 16);
    
    // 스탯
    ctx.font = "16px monospace";
    ctx.fillStyle = "#ddd";
    ctx.fillText(`🗡️ ATK ${stats.atk}    🛡️ DEF ${stats.def}    💨 SPD ${ch.spd}`, width / 2, 250);
    
    // 현재 술식
    const skill = getCurrentSkill(player, player.active);
    ctx.font = "bold 18px 'Noto Sans KR'";
    ctx.fillStyle = "#7C5CFC";
    ctx.fillText(`🌀 ${skill.name}`, width / 2, 300);
    ctx.font = "12px monospace";
    ctx.fillStyle = "#aaa";
    ctx.fillText(`피해 ${skill.dmg}  ·  숙련도 ${getMastery(player, player.active)}`, width / 2, 325);
    
    // 크리스탈 & XP
    ctx.font = "18px monospace";
    ctx.fillStyle = "#F5C842";
    ctx.fillText(`💎 ${player.crystals}`, width / 2 - 80, 380);
    ctx.fillStyle = "#4ade80";
    ctx.fillText(`⭐ LV.${getLevel(player.xp)}`, width / 2 + 40, 380);
    
    // XP 바
    const xpNow = player.xp % 200;
    const xpPercent = xpNow / 200;
    ctx.fillStyle = "#2a2a3e";
    ctx.fillRect(hpBarX, 400, hpBarWidth, 12);
    ctx.fillStyle = "#F5C842";
    ctx.fillRect(hpBarX, 400, hpBarWidth * xpPercent, 12);
    ctx.font = "10px monospace";
    ctx.fillStyle = "#aaa";
    ctx.fillText(`XP ${xpNow}/200`, width / 2, 412);
    
    // 상태이상
    if (player.statusEffects && player.statusEffects.length > 0) {
      ctx.font = "14px monospace";
      ctx.fillStyle = "#ff6b6b";
      let statusText = player.statusEffects.map(s => {
        const def = STATUS_EFFECTS[s.id];
        return def ? `${def.emoji} ${def.name}(${s.turns})` : s.id;
      }).join("  ");
      ctx.fillText(statusText, width / 2, 450);
    }
    
    // 하단 장식
    ctx.font = "italic 14px 'Noto Sans KR'";
    ctx.fillStyle = "rgba(245, 200, 66, 0.5)";
    ctx.fillText("🔱 JUJUTSU KAISEN · 呪術廻戦 🔱", width / 2, height - 25);
    
    // 반짝임 효과
    if (frame % 4 === 0) {
      ctx.fillStyle = `rgba(255, 200, 0, ${Math.random() * 0.1})`;
      ctx.fillRect(0, 0, width, height);
    }
    
    encoder.addFrame(ctx);
  }
  
  encoder.finish();
  await new Promise(resolve => stream.on("finish", resolve));
  const buffer = readFileSync(tempPath);
  unlinkSync(tempPath);
  return new AttachmentBuilder(buffer, { name: `jjk_profile_${player.id || Date.now()}.gif` });
}
// ════════════════════════════════════════════════════════════════════════════════
// ── 임베드 함수들 (프로필, 도감, 술식)
// ════════════════════════════════════════════════════════════════════════════════
function profileEmbed(player) {
  const ch = CHARACTERS[player.active];
  const stats = getPlayerStats(player);
  const skill = getCurrentSkill(player, player.active);
  const mainSkill = getMainSkill(player, player.active);
  const mainBonus = getMainSkillBonus(player);
  const mastery = getMastery(player, player.active);
  const next = getNextSkill(player, player.active);
  const awakened = isMakiAwakened(player);
  const lv = getLevel(player.xp);
  const hpPct = Math.max(0, player.hp) / stats.maxHp;
  const xpNow = player.xp % 200;
  const fingers = player.sukunaFingers || 0;
  const fingerBonus = getFingerBonus(fingers);
  const kb = getKoganeBonus(player);
  const kogane = player.kogane;
  const kg = kogane ? KOGANE_GRADES[kogane] : null;
  const gradeInfo = GACHA_RARITY[ch.grade] || GACHA_RARITY["3급"];
  const equippedTool = getEquippedToolBonus(player);
  
  const HP_LEN = 18;
  const hpFill = Math.round(hpPct * HP_LEN);
  const hpColor = hpPct > 0.6 ? "🟢" : hpPct > 0.3 ? "🟡" : "🔴";
  const hpBarStr = `${hpColor} \`${"█".repeat(Math.max(0, hpFill))}${"░".repeat(Math.max(0, HP_LEN - hpFill))}\` **${Math.max(0, player.hp)}**/**${stats.maxHp}**`;
  
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
    let unlocked = mastery >= s.minMastery;
    if (player.active === "sukuna") unlocked = unlocked && isSukunaSkillUnlocked(fingers, idx);
    const isCurrent = skill.name === s.name;
    const isMain = mainSkill.name === s.name;
    const icon = unlocked ? skillIcons[idx] || "◆" : "🔒";
    const curMark = isCurrent ? " ◀ 현재" : "";
    const mainMark = isMain ? " ⭐주력" : "";
    return `> ${icon} **${s.name}**${curMark}${mainMark}\n> ⠀  *${s.desc}*`;
  }).join("\n");
  
  const awakeBanner = awakened ? `\n║  🔥 ≪ 천여주박 각성 ≫ — DMG×2  ║` : "";
  const toolBanner = equippedTool ? `\n║  ${equippedTool.emoji} 장착: ${Object.keys(equippedTool)[0]} ≫ ${equippedTool.effect}  ║` : "";
  
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
    toolBanner,
    th.bot,
    "```",
  ].filter(Boolean).join("\n");
  
  const fingerBar = fingers > 0
    ? `> 👹 **스쿠나 손가락** \`${"█".repeat(fingers)}${"░".repeat(SUKUNA_FINGER_MAX - fingers)}\` **${fingers}/${SUKUNA_FINGER_MAX}** — ${fingerBonus.label}`
    : "";
  
  const koganeLine = kogane && kg
    ? `> ${kg.emoji} **코가네 [${kogane}]** — ${kg.passiveDesc}`
    : `> 🐾 코가네 없음 — \`/코가네가챠\` (200💎)`;
  
  const embed = new EmbedBuilder()
    .setTitle(awakened ? `🔥 ≪ 천여주박 각성 ≫  ${player.name}의 카드` : `${gradeInfo.effect}  ${player.name}의 주술사 카드  ${gradeInfo.effect}`)
    .setColor(awakened ? 0xFF2200 : gradeInfo.color)
    .setDescription([
      cardBlock,
      koganeLine,
      fingerBar,
    ].filter(Boolean).join("\n"))
    .addFields({
      name: "┌─ 🏅 주술사 정보 ─────────────────┐",
      value: [
        `> 🎖️ **LV.${lv}**  /  총 XP: **${player.xp}**`,
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
        kogane && kg ? `> 🐾 코가네 보너스: ATK×${kb.atk.toFixed(2)} DEF×${kb.def.toFixed(2)} HP×${kb.hp.toFixed(2)}` : "",
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
      name: "┌─ ⭐ 주력 스킬 & 도전과제 ──────────┐",
      value: [
        `> **주력 스킬:** ${mainSkill.name} (보너스 +${mainBonus}% 데미지)`,
        `> \`/주력설정 [스킬명]\` 으로 변경 가능`,
        `>`,
        `> **도전과제 진행도**`,
        `> ${player.achievements.firstWin ? "✅" : "⬜"} 첫 승리 (${player.wins}/1) — +10%`,
        `> ${player.achievements.fingerCollector ? "✅" : "⬜"} 손가락 수집가 (${fingers}/5) — +20%`,
        `> ${player.achievements.cullingMaster ? "✅" : "⬜"} 컬링 마스터 (${player.cullingBest}/5) — +15%`,
        `> ${player.achievements.jujutsuComplete ? "✅" : "⬜"} 사멸회유 완료 (${player.jujutsuBest || 0}/15) — +25%`,
        `> ${player.achievements.pvpFirstWin ? "✅" : "⬜"} PvP 첫 승 (${player.pvpWins || 0}/1) — +20%`,
      ].join("\n"),
      inline: false,
    })
    .addFields({
      name: "┌─ 🔧 주구 ─────────────────────────┐",
      value: equippedTool ? `> 장착: ${equippedTool.emoji} **${player.equippedTool}**\n> 효과: ${equippedTool.effect}` : "> 장착한 주구 없음",
      inline: false,
    })
    .addFields({
      name: "┌─ 📦 보유 캐릭터 ──────────────────┐",
      value: player.owned.map(id => {
        const c = CHARACTERS[id];
        const m = getMastery(player, id);
        const cur = getCurrentSkill(player, id);
        const ri = GACHA_RARITY[c.grade] || GACHA_RARITY["3급"];
        return `> ${id === player.active ? "▶️" : "　"} ${c.emoji} **${c.name}** \`${c.grade}\` ${ri.stars} · 숙련 \`${m}\` · \`${cur.name}\``;
      }).join("\n") || "> 없음",
      inline: false,
    })
    .setFooter({ text: `/전투 | /컬링 | /사멸회유 | /결투 | /파티 | /가챠 | /퀘스트 | /제작 | ${player.name}` })
    .setTimestamp();
  
  return embed;
}

function pokedexEmbed(player) {
  const owned = player.owned;
  const all = Object.keys(CHARACTERS);
  const ownedList = owned.map(id => {
    const c = CHARACTERS[id];
    const gradeInfo = GACHA_RARITY[c.grade] || GACHA_RARITY["3급"];
    const isActive = id === player.active ? "✅ 활성" : "🔒 비활성";
    return `> ${c.emoji} **${c.name}** \`${c.grade}\` ${gradeInfo.stars} — ${isActive}`;
  }).join("\n") || "> 없음";
  
  const missingList = all.filter(id => !owned.includes(id)).map(id => {
    const c = CHARACTERS[id];
    const gradeInfo = GACHA_RARITY[c.grade] || GACHA_RARITY["3급"];
    return `> ${c.emoji} **${c.name}** \`${c.grade}\` ${gradeInfo.stars} — ❌ 미획득`;
  }).join("\n") || "> 모두 획득! 🎉";
  
  return new EmbedBuilder()
    .setTitle("📖 주술사 도감")
    .setColor(0x7C5CFC)
    .setDescription([
      `**보유 캐릭터 (${owned.length}/${all.length})**`,
      ownedList,
      "",
      `**미획득 캐릭터**`,
      missingList,
    ].join("\n"))
    .setFooter({ text: "/가챠로 새로운 주술사를 획득하세요!" });
}

function skillEmbed(player) {
  const id = player.active;
  const ch = CHARACTERS[id];
  const mastery = getMastery(player, id);
  const awakened = isMakiAwakened(player);
  const fingers = player.sukunaFingers || 0;
  const mainSkillName = player.mainSkill;
  
  return new EmbedBuilder()
    .setTitle(`${ch.emoji} ≪ 술식 트리 ≫ ${ch.name}${awakened ? "  🔥[각성]" : ""}`)
    .setColor(awakened ? 0xFF2200 : JJK_GRADE_COLOR[ch.grade])
    .setDescription([
      `> ${ch.lore || ch.desc}`,
      `> 📈 **숙련도** ${masteryBar(mastery, id)}`,
      `> 🌌 **영역전개** \`${ch.domain || "없음"}\``,
      id === "itadori" ? `> 👹 **스쿠나 손가락** \`${fingers}/${SUKUNA_FINGER_MAX}\` — ${getFingerBonus(fingers).label}` : "",
      id === "sukuna" ? `> 👹 **스쿠나 손가락** \`${fingers}/${SUKUNA_FINGER_MAX}\` — 손가락으로 스킬 해금됨` : "",
      awakened ? `> 🔥 **천여주박 각성 중** — 모든 데미지 **2배**!` : "",
    ].filter(Boolean).join("\n"))
    .addFields(ch.skills.map((s, idx) => {
      let unlocked = mastery >= s.minMastery;
      let sukunaLock = false;
      if (id === "sukuna") {
        unlocked = unlocked && isSukunaSkillUnlocked(fingers, idx);
        sukunaLock = !isSukunaSkillUnlocked(fingers, idx);
      }
      const fingerLock = s.name === "스쿠나 발현" && fingers < 10;
      const available = unlocked && !fingerLock && !sukunaLock;
      const fx = getSkillEffect(s.name);
      const statusNote = s.statusApply ? ` \`${STATUS_EFFECTS[s.statusApply.statusId]?.emoji}${STATUS_EFFECTS[s.statusApply.statusId]?.name} ${Math.round(s.statusApply.chance * 100)}%\`` : "";
      const dmgDisplay = awakened ? `~~${s.dmg}~~ → **${s.dmg * 2}**🔥` : `**${s.dmg}**`;
      const selfBuff = s.statusApply?.target === "self" ? " 🔰자기버프" : "";
      const mainMark = (mainSkillName === s.name) ? " ⭐주력" : "";
      return {
        name: `${available ? `✅ [${idx + 1}]` : "🔒"} ${s.name}${mainMark}  —  피해 ${dmgDisplay}${statusNote}${selfBuff}  *(숙련 ${s.minMastery} 필요)*`,
        value: [
          `> ${s.desc}`,
          available ? fx.art : `> ${!unlocked ? "🔒 숙련도 부족" : (sukunaLock ? "👹 손가락 필요" : "👹 손가락 10개 이상 필요")}`,
          available ? `> *${fx.flavorText}*` : "",
        ].filter(Boolean).join("\n"),
        inline: false,
      };
    }))
    .setFooter({ text: "전투/컬링 승리 시 숙련도 상승! | 주력 스킬은 /주력설정 으로 변경" });
}

// ════════════════════════════════════════════════════════════════════════════════
// ── 버튼 팩토리
// ════════════════════════════════════════════════════════════════════════════════
function mkBattleButtons(player) {
  const canSkill = player.skillCooldown <= 0;
  const canReverse = player.reverseCooldown <= 0;
  const hasReverse = REVERSE_CHARS.has(player.active);
  const mainSkill = getMainSkill(player, player.active);
  
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("b_attack").setLabel("⚔️ 공격").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("b_skill").setLabel(`🌀 ${getCurrentSkill(player, player.active).name}`).setStyle(ButtonStyle.Primary).setDisabled(!canSkill),
    new ButtonBuilder().setCustomId("b_main").setLabel(`⭐ ${mainSkill.name}`).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("b_reverse").setLabel(`♻️ 반전`).setStyle(ButtonStyle.Secondary).setDisabled(!canReverse || !hasReverse),
    new ButtonBuilder().setCustomId("b_run").setLabel("🏃 도주").setStyle(ButtonStyle.Secondary)
  );
}

function mkCullingButtons(player) {
  const canSkill = player.skillCooldown <= 0;
  const canReverse = player.reverseCooldown <= 0;
  const hasReverse = REVERSE_CHARS.has(player.active);
  
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("c_attack").setLabel("⚔️ 공격").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("c_skill").setLabel(`🌀 ${getCurrentSkill(player, player.active).name}`).setStyle(ButtonStyle.Primary).setDisabled(!canSkill),
    new ButtonBuilder().setCustomId("c_reverse").setLabel(`♻️ 반전`).setStyle(ButtonStyle.Secondary).setDisabled(!canReverse || !hasReverse),
    new ButtonBuilder().setCustomId("c_escape").setLabel("🏳️ 철수").setStyle(ButtonStyle.Secondary)
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// ── 전투 핸들러 (간소화 버전 - 실제로는 더 길게 구현)
// ════════════════════════════════════════════════════════════════════════════════
// (실제 전투 핸들러는 파트 11에서 계속...)
// ════════════════════════════════════════════════════════════════════════════════
// ── 전투 핸들러 (일반 전투)
// ════════════════════════════════════════════════════════════════════════════════
async function handleBattleAction(interaction, player, battle, action) {
  const enemy = battle.enemy;
  
  // ==================== 공격 ====================
  if (action === "b_attack") {
    if (isIncapacitated(player.statusEffects)) {
      await interaction.reply({ content: "❌ 상태이상으로 행동할 수 없습니다!", ephemeral: true });
      return;
    }
    
    const hit = rollHit(enemy.statusEffects);
    if (!hit) {
      await interaction.update({ content: "⚡ 공격이 빗나갔다!", embeds: [], components: [mkBattleButtons(player)] });
      return;
    }
    
    let dmg = calcDmgForPlayer(player, enemy.def);
    
    // 흑섬 체크
    let isBlackFlash = false;
    if (Math.random() < 0.15) {
      isBlackFlash = true;
      dmg = Math.floor(dmg * 2);
      player.crystals += 50;
    }
    
    enemy.currentHp = Math.max(0, enemy.currentHp - dmg);
    const statusLog = [];
    if (enemy.statusAttack && Math.random() < (enemy.statusAttack.chance || 0)) {
      applyStatus(player, enemy.statusAttack.statusId);
      statusLog.push(`${STATUS_EFFECTS[enemy.statusAttack.statusId].emoji} ${enemy.statusAttack.statusId} 상태이상!`);
    }
    
    // 공격 결과 임베드
    let embed;
    if (isBlackFlash) {
      embed = new EmbedBuilder()
        .setTitle("⚫⚡ 흑섬! ⚡⚫")
        .setColor(0xff0000)
        .setDescription(`**${dmg}** 데미지! (2배 피해!)\n✨ 크리스탈 +50 추가 획득!`)
        .addFields(
          { name: "내 HP", value: `${hpBar(player.hp, getPlayerStats(player).maxHp)} ${player.hp}/${getPlayerStats(player).maxHp}`, inline: true },
          { name: "적 HP", value: `${hpBar(enemy.currentHp, enemy.hp)} ${enemy.currentHp}/${enemy.hp}`, inline: true }
        );
    } else {
      embed = new EmbedBuilder()
        .setTitle("⚔️ 일반 공격!")
        .setColor(0xff6b35)
        .setDescription([`${player.name}의 공격! **${dmg}** 데미지!`, ...statusLog].join("\n"))
        .addFields(
          { name: "내 HP", value: `${hpBar(player.hp, getPlayerStats(player).maxHp)} ${player.hp}/${getPlayerStats(player).maxHp}`, inline: true },
          { name: "적 HP", value: `${hpBar(enemy.currentHp, enemy.hp)} ${enemy.currentHp}/${enemy.hp}`, inline: true }
        );
    }
    
    await interaction.update({ embeds: [embed], components: [mkBattleButtons(player)] });
    
    // 적 처치 시 보상
    if (enemy.currentHp <= 0) {
      const xpGain = enemy.xp;
      const crystalGain = enemy.crystals;
      const masteryGain = enemy.masteryXp || 1;
      
      player.xp += xpGain;
      player.crystals += crystalGain;
      player.mastery[player.active] = (player.mastery[player.active] || 0) + masteryGain;
      player.wins++;
      
      if (enemy.fingers) {
        player.sukunaFingers = Math.min(SUKUNA_FINGER_MAX, (player.sukunaFingers || 0) + enemy.fingers);
      }
      
      // 재료 드랍
      const drops = dropMaterials(enemy.id === "e4" ? "boss" : "normal");
      if (drops.length > 0) {
        addMaterials(player, drops);
        await interaction.followUp({ content: `🎁 재료 획득! ${drops.map(d => `${d.material} x${d.amount}`).join(", ")}`, ephemeral: false });
      }
      
      // 퀘스트 진행 업데이트
      updateQuestProgress(player, "battle_win", 1);
      updateQuestProgress(player, "enemy_kill", 1);
      
      // 도전과제 체크
      checkAchievements(player);
      
      delete battles[interaction.user.id];
      const winEmbed = new EmbedBuilder()
        .setTitle("🏆 승리!")
        .setColor(0xF5C842)
        .setDescription(`**${enemy.name}** 처치!\n+${xpGain} XP, +${crystalGain}💎, +${masteryGain} 숙련도`);
      await interaction.editReply({ embeds: [winEmbed], components: [] });
      savePlayer(interaction.user.id);
      return;
    }
  }
  
  // ==================== 술식 ====================
  if (action === "b_skill") {
    if (isIncapacitated(player.statusEffects)) {
      await interaction.reply({ content: "❌ 상태이상으로 행동할 수 없습니다!", ephemeral: true });
      return;
    }
    
    const skill = getCurrentSkill(player, player.active);
    const hit = rollHit(enemy.statusEffects);
    
    if (!hit) {
      await interaction.update({ content: "⚡ 술식이 빗나갔다!", embeds: [], components: [mkBattleButtons(player)] });
      return;
    }
    
    const dmg = calcSkillDmgForPlayer(player, skill.dmg);
    enemy.currentHp = Math.max(0, enemy.currentHp - dmg);
    const statusLog = applySkillStatus(skill, enemy, player);
    player.skillCooldown = 5;
    
    // 퀘스트 진행 업데이트
    updateQuestProgress(player, "skill_use", 1);
    
    const fx = getSkillEffect(skill.name);
    const embed = new EmbedBuilder()
      .setTitle(`${skill.name}!`)
      .setColor(fx.color)
      .setDescription([fx.art, `> *"${fx.flavorText}"*`, `**${dmg}** 데미지!`, ...statusLog].join("\n"))
      .addFields(
        { name: "내 HP", value: `${hpBar(player.hp, getPlayerStats(player).maxHp)} ${player.hp}/${getPlayerStats(player).maxHp}`, inline: true },
        { name: "적 HP", value: `${hpBar(enemy.currentHp, enemy.hp)} ${enemy.currentHp}/${enemy.hp}`, inline: true }
      );
    
    await interaction.update({ embeds: [embed], components: [mkBattleButtons(player)] });
    
    // 적 처치 시 보상
    if (enemy.currentHp <= 0) {
      const xpGain = enemy.xp;
      const crystalGain = enemy.crystals;
      const masteryGain = enemy.masteryXp || 1;
      
      player.xp += xpGain;
      player.crystals += crystalGain;
      player.mastery[player.active] = (player.mastery[player.active] || 0) + masteryGain;
      player.wins++;
      
      if (enemy.fingers) {
        player.sukunaFingers = Math.min(SUKUNA_FINGER_MAX, (player.sukunaFingers || 0) + enemy.fingers);
      }
      
      const drops = dropMaterials(enemy.id === "e4" ? "boss" : "normal");
      if (drops.length > 0) {
        addMaterials(player, drops);
        await interaction.followUp({ content: `🎁 재료 획득! ${drops.map(d => `${d.material} x${d.amount}`).join(", ")}`, ephemeral: false });
      }
      
      updateQuestProgress(player, "battle_win", 1);
      updateQuestProgress(player, "enemy_kill", 1);
      checkAchievements(player);
      
      delete battles[interaction.user.id];
      const winEmbed = new EmbedBuilder()
        .setTitle("🏆 승리!")
        .setColor(0xF5C842)
        .setDescription(`**${enemy.name}** 처치!\n+${xpGain} XP, +${crystalGain}💎, +${masteryGain} 숙련도`);
      await interaction.editReply({ embeds: [winEmbed], components: [] });
      savePlayer(interaction.user.id);
      return;
    }
  }
  
  // ==================== 주력 스킬 ====================
  if (action === "b_main") {
    if (isIncapacitated(player.statusEffects)) {
      await interaction.reply({ content: "❌ 상태이상으로 행동할 수 없습니다!", ephemeral: true });
      return;
    }
    
    const skill = getMainSkill(player, player.active);
    const hit = rollHit(enemy.statusEffects);
    
    if (!hit) {
      await interaction.update({ content: "⚡ 주력 스킬이 빗나갔다!", embeds: [], components: [mkBattleButtons(player)] });
      return;
    }
    
    const dmg = calcSkillDmgForPlayer(player, skill.dmg);
    enemy.currentHp = Math.max(0, enemy.currentHp - dmg);
    const statusLog = applySkillStatus(skill, enemy, player);
    player.skillCooldown = 6;
    
    // 주력 스킬 사용 시 추가 효과
    let bonusMsg = "";
    if (skill.name === "자폭 무라사키" && player.active === "gojo") {
      player.hp = 1;
      bonusMsg = "\n💥 **자폭 효과!** 자신의 HP가 1이 되었다!";
    }
    if (skill.name === "세계참" && player.active === "sukuna") {
      bonusMsg = "\n🌍 **세계를 베었다!** 방어력 무시!";
    }
    
    const fx = getSkillEffect(skill.name);
    const embed = new EmbedBuilder()
      .setTitle(`⭐ 주력 스킬: ${skill.name}!`)
      .setColor(0xffcc00)
      .setDescription([fx.art, `> *"${fx.flavorText}"*`, `**${dmg}** 데미지!`, bonusMsg, ...statusLog].join("\n"))
      .addFields(
        { name: "내 HP", value: `${hpBar(player.hp, getPlayerStats(player).maxHp)} ${player.hp}/${getPlayerStats(player).maxHp}`, inline: true },
        { name: "적 HP", value: `${hpBar(enemy.currentHp, enemy.hp)} ${enemy.currentHp}/${enemy.hp}`, inline: true }
      );
    
    await interaction.update({ embeds: [embed], components: [mkBattleButtons(player)] });
    
    if (enemy.currentHp <= 0) {
      const xpGain = enemy.xp;
      const crystalGain = enemy.crystals;
      const masteryGain = enemy.masteryXp || 1;
      
      player.xp += xpGain;
      player.crystals += crystalGain;
      player.mastery[player.active] = (player.mastery[player.active] || 0) + masteryGain;
      player.wins++;
      
      if (enemy.fingers) {
        player.sukunaFingers = Math.min(SUKUNA_FINGER_MAX, (player.sukunaFingers || 0) + enemy.fingers);
      }
      
      const drops = dropMaterials(enemy.id === "e4" ? "boss" : "normal");
      if (drops.length > 0) {
        addMaterials(player, drops);
        await interaction.followUp({ content: `🎁 재료 획득! ${drops.map(d => `${d.material} x${d.amount}`).join(", ")}`, ephemeral: false });
      }
      
      updateQuestProgress(player, "battle_win", 1);
      updateQuestProgress(player, "enemy_kill", 1);
      checkAchievements(player);
      
      delete battles[interaction.user.id];
      const winEmbed = new EmbedBuilder()
        .setTitle("🏆 승리!")
        .setColor(0xF5C842)
        .setDescription(`**${enemy.name}** 처치!\n+${xpGain} XP, +${crystalGain}💎, +${masteryGain} 숙련도`);
      await interaction.editReply({ embeds: [winEmbed], components: [] });
      savePlayer(interaction.user.id);
      return;
    }
  }
  
  // ==================== 반전술식 ====================
  if (action === "b_reverse") {
    if (!REVERSE_CHARS.has(player.active)) {
      await interaction.reply({ content: "❌ 이 캐릭터는 반전술식을 사용할 수 없습니다!", ephemeral: true });
      return;
    }
    
    if (player.reverseCooldown > 0) {
      await interaction.reply({ content: `⏰ 반전술식이 아직 준비되지 않았습니다! (${player.reverseCooldown}턴 남음)`, ephemeral: true });
      return;
    }
    
    const stats = getPlayerStats(player);
    const healAmount = Math.floor(stats.maxHp * 0.4);
    player.hp = Math.min(stats.maxHp, player.hp + healAmount);
    player.reverseCooldown = 3;
    
    const embed = new EmbedBuilder()
      .setTitle("♻️ 반전술식!")
      .setColor(0x00ff88)
      .setDescription(`**${healAmount}** HP 회복!`)
      .addFields(
        { name: "내 HP", value: `${hpBar(player.hp, stats.maxHp)} ${player.hp}/${stats.maxHp}`, inline: true }
      );
    
    await interaction.update({ embeds: [embed], components: [mkBattleButtons(player)] });
  }
  
  // ==================== 도주 ====================
  if (action === "b_run") {
    delete battles[interaction.user.id];
    await interaction.update({ content: "🏃 전투에서 도주했습니다!", embeds: [], components: [] });
    return;
  }
  
  // ==================== 적의 턴 ====================
  if (enemy.currentHp > 0 && player.hp > 0) {
    const hit = rollHit(player.statusEffects);
    let dmg = 0;
    let statusLog = [];
    
    if (hit) {
      dmg = calcDmg(enemy.atk, getPlayerStats(player).def);
      player.hp = Math.max(0, player.hp - dmg);
      if (enemy.statusAttack && Math.random() < (enemy.statusAttack.chance || 0.3)) {
        applyStatus(player, enemy.statusAttack.statusId);
        statusLog = [`${STATUS_EFFECTS[enemy.statusAttack.statusId]?.emoji || ""} ${enemy.statusAttack.statusId} 상태이상!`];
      }
    } else {
      statusLog = ["⚡ 적의 공격이 빗나갔다!"];
    }
    
    const tick = tickStatus(player, getPlayerStats(player).maxHp);
    if (tick.dmg > 0) player.hp = Math.max(0, player.hp - tick.dmg);
    if (tick.heal > 0) player.hp = Math.min(getPlayerStats(player).maxHp, player.hp + tick.heal);
    
    const enemyEmbed = new EmbedBuilder()
      .setTitle(`${enemy.name}의 공격!`)
      .setColor(0xff4444)
      .setDescription([hit ? `**${dmg}** 데미지!` : "공격이 빗나갔다!", ...statusLog, ...tick.log].join("\n"))
      .addFields(
        { name: "내 HP", value: `${hpBar(player.hp, getPlayerStats(player).maxHp)} ${player.hp}/${getPlayerStats(player).maxHp}`, inline: true },
        { name: "적 HP", value: `${hpBar(enemy.currentHp, enemy.hp)} ${enemy.currentHp}/${enemy.hp}`, inline: true }
      );
    
    await interaction.editReply({ embeds: [enemyEmbed], components: [mkBattleButtons(player)] });
    
    if (player.hp <= 0) {
      player.losses++;
      delete battles[interaction.user.id];
      const loseEmbed = new EmbedBuilder()
        .setTitle("💀 패배...")
        .setColor(0xe63946)
        .setDescription("전투에서 패배했습니다!");
      await interaction.editReply({ embeds: [loseEmbed], components: [] });
      savePlayer(interaction.user.id);
      return;
    }
  }
  
  tickCooldowns(player);
  savePlayer(interaction.user.id);
}
// ════════════════════════════════════════════════════════════════════════════════
// ── 컬링 게임 핸들러
// ════════════════════════════════════════════════════════════════════════════════
async function handleCullingAction(interaction, player, session, action) {
  const enemy = session.currentEnemy;
  
  // ==================== 공격 ====================
  if (action === "c_attack") {
    if (isIncapacitated(player.statusEffects)) {
      await interaction.reply({ content: "❌ 상태이상으로 행동할 수 없습니다!", ephemeral: true });
      return;
    }
    
    const hit = rollHit(enemy.statusEffects);
    if (!hit) {
      await interaction.update({ content: "⚡ 공격이 빗나갔다!", components: [mkCullingButtons(player)] });
      return;
    }
    
    const dmg = calcDmgForPlayer(player, enemy.def);
    session.enemyHp = Math.max(0, session.enemyHp - dmg);
    
    await interaction.update({ content: `⚔️ ${dmg} 데미지!`, components: [mkCullingButtons(player)] });
    
    // 적 처치
    if (session.enemyHp <= 0) {
      const xpGain = Math.floor(enemy.xp);
      const crystalGain = Math.floor(enemy.crystals);
      const masteryGain = enemy.masteryXp || 1;
      
      session.totalXp += xpGain;
      session.totalCrystals += crystalGain;
      player.mastery[player.active] = (player.mastery[player.active] || 0) + masteryGain;
      session.kills++;
      session.wave++;
      
      if (session.wave > player.cullingBest) player.cullingBest = session.wave;
      if (enemy.fingers) {
        player.sukunaFingers = Math.min(SUKUNA_FINGER_MAX, (player.sukunaFingers || 0) + enemy.fingers);
      }
      
      // 재료 드랍
      const drops = dropMaterials(session.wave > 10 ? "elite" : "normal");
      if (drops.length > 0) {
        addMaterials(player, drops);
        await interaction.followUp({ content: `🎁 재료 획득! ${drops.map(d => `${d.material} x${d.amount}`).join(", ")}`, ephemeral: false });
      }
      
      // 퀘스트 업데이트
      updateQuestProgress(player, "culling_wave", 1);
      updateQuestProgress(player, "enemy_kill", 1);
      checkAchievements(player);
      
      // 다음 웨이브
      session.currentEnemy = pickCullingEnemy(session.wave);
      session.enemyHp = session.currentEnemy.hp;
      
      const waveEmbed = new EmbedBuilder()
        .setTitle(`🌊 WAVE ${session.wave} 도달!`)
        .setColor(0xF5C842)
        .setDescription(`**${enemy.name}** 처치!\n+${xpGain} XP, +${crystalGain}💎, +${masteryGain} 숙련도\n\n**${session.currentEnemy.name}** 등장!`);
      
      await interaction.editReply({ embeds: [waveEmbed], components: [mkCullingButtons(player)] });
      savePlayer(interaction.user.id);
      return;
    }
  }
  
  // ==================== 술식 ====================
  if (action === "c_skill") {
    if (isIncapacitated(player.statusEffects)) {
      await interaction.reply({ content: "❌ 상태이상으로 행동할 수 없습니다!", ephemeral: true });
      return;
    }
    
    const skill = getCurrentSkill(player, player.active);
    const hit = rollHit(enemy.statusEffects);
    
    if (!hit) {
      await interaction.update({ content: "⚡ 술식이 빗나갔다!", components: [mkCullingButtons(player)] });
      return;
    }
    
    const dmg = calcSkillDmgForPlayer(player, skill.dmg);
    session.enemyHp = Math.max(0, session.enemyHp - dmg);
    const statusLog = applySkillStatus(skill, enemy, player);
    player.skillCooldown = 5;
    
    await interaction.update({ content: `🌀 ${skill.name}! ${dmg} 데미지!`, components: [mkCullingButtons(player)] });
    
    // 퀘스트 업데이트
    updateQuestProgress(player, "skill_use", 1);
    
    if (session.enemyHp <= 0) {
      const xpGain = Math.floor(enemy.xp);
      const crystalGain = Math.floor(enemy.crystals);
      const masteryGain = enemy.masteryXp || 1;
      
      session.totalXp += xpGain;
      session.totalCrystals += crystalGain;
      player.mastery[player.active] = (player.mastery[player.active] || 0) + masteryGain;
      session.kills++;
      session.wave++;
      
      if (session.wave > player.cullingBest) player.cullingBest = session.wave;
      if (enemy.fingers) {
        player.sukunaFingers = Math.min(SUKUNA_FINGER_MAX, (player.sukunaFingers || 0) + enemy.fingers);
      }
      
      const drops = dropMaterials(session.wave > 10 ? "elite" : "normal");
      if (drops.length > 0) {
        addMaterials(player, drops);
        await interaction.followUp({ content: `🎁 재료 획득! ${drops.map(d => `${d.material} x${d.amount}`).join(", ")}`, ephemeral: false });
      }
      
      updateQuestProgress(player, "culling_wave", 1);
      updateQuestProgress(player, "enemy_kill", 1);
      checkAchievements(player);
      
      session.currentEnemy = pickCullingEnemy(session.wave);
      session.enemyHp = session.currentEnemy.hp;
      
      const waveEmbed = new EmbedBuilder()
        .setTitle(`🌊 WAVE ${session.wave} 도달!`)
        .setColor(0xF5C842)
        .setDescription(`**${enemy.name}** 처치!\n+${xpGain} XP, +${crystalGain}💎, +${masteryGain} 숙련도\n\n**${session.currentEnemy.name}** 등장!`);
      
      await interaction.editReply({ embeds: [waveEmbed], components: [mkCullingButtons(player)] });
      savePlayer(interaction.user.id);
      return;
    }
  }
  
  // ==================== 반전술식 ====================
  if (action === "c_reverse") {
    if (!REVERSE_CHARS.has(player.active)) {
      await interaction.reply({ content: "❌ 이 캐릭터는 반전술식을 사용할 수 없습니다!", ephemeral: true });
      return;
    }
    
    const stats = getPlayerStats(player);
    const healAmount = Math.floor(stats.maxHp * 0.4);
    player.hp = Math.min(stats.maxHp, player.hp + healAmount);
    player.reverseCooldown = 3;
    
    await interaction.update({ content: `♻️ ${healAmount} HP 회복!`, components: [mkCullingButtons(player)] });
  }
  
  // ==================== 철수 ====================
  if (action === "c_escape") {
    const totalXp = session.totalXp;
    const totalCrystals = session.totalCrystals;
    
    player.xp += totalXp;
    player.crystals += totalCrystals;
    
    if (session.wave > player.cullingBest) player.cullingBest = session.wave - 1;
    
    delete cullings[interaction.user.id];
    const escapeEmbed = new EmbedBuilder()
      .setTitle("🏳️ 컬링 종료")
      .setColor(0x4a5568)
      .setDescription(`WAVE ${session.wave - 1}까지 클리어!\n획득: +${totalXp} XP, +${totalCrystals}💎`);
    
    await interaction.update({ embeds: [escapeEmbed], components: [] });
    savePlayer(interaction.user.id);
    return;
  }
  
  // ==================== 적의 턴 ====================
  if (session.enemyHp > 0 && player.hp > 0) {
    const hit = rollHit(player.statusEffects);
    let dmg = 0;
    let statusLog = [];
    
    if (hit) {
      dmg = calcDmg(enemy.atk, getPlayerStats(player).def);
      player.hp = Math.max(0, player.hp - dmg);
      if (enemy.statusAttack && Math.random() < (enemy.statusAttack.chance || 0.3)) {
        applyStatus(player, enemy.statusAttack.statusId);
        statusLog = [`${STATUS_EFFECTS[enemy.statusAttack.statusId]?.emoji || ""} 상태이상!`];
      }
    } else {
      statusLog = ["⚡ 적의 공격이 빗나갔다!"];
    }
    
    const tick = tickStatus(player, getPlayerStats(player).maxHp);
    if (tick.dmg > 0) player.hp = Math.max(0, player.hp - tick.dmg);
    if (tick.heal > 0) player.hp = Math.min(getPlayerStats(player).maxHp, player.hp + tick.heal);
    
    await interaction.followUp({ content: [hit ? `💥 적 공격! ${dmg} 데미지!` : "⚡ 적 공격이 빗나갔다!", ...statusLog, ...tick.log].join("\n"), ephemeral: false });
    
    if (player.hp <= 0) {
      const totalXp = session.totalXp;
      const totalCrystals = session.totalCrystals;
      player.xp += totalXp;
      player.crystals += totalCrystals;
      
      delete cullings[interaction.user.id];
      const loseEmbed = new EmbedBuilder()
        .setTitle("💀 컬링 패배")
        .setColor(0xe63946)
        .setDescription(`WAVE ${session.wave}에서 패배했습니다.\n획득: +${totalXp} XP, +${totalCrystals}💎`);
      
      await interaction.editReply({ embeds: [loseEmbed], components: [] });
      savePlayer(interaction.user.id);
      return;
    }
  }
  
  tickCooldowns(player);
  savePlayer(interaction.user.id);
}
// ════════════════════════════════════════════════════════════════════════════════
// ── 파티 컬링 핸들러
// ════════════════════════════════════════════════════════════════════════════════
async function handlePartyCullingAction(interaction, player, session, action, party) {
  const enemy = session.currentEnemy;
  
  if (action === "pc_attack") {
    if (isIncapacitated(player.statusEffects)) {
      await interaction.reply({ content: "❌ 상태이상으로 행동할 수 없습니다!", ephemeral: true });
      return;
    }
    
    const hit = rollHit(enemy.statusEffects);
    if (!hit) {
      await interaction.update({ content: "⚡ 공격이 빗나갔다!", components: [] });
      return;
    }
    
    const dmg = calcDmgForPlayer(player, enemy.def);
    session.enemyHp = Math.max(0, session.enemyHp - dmg);
    
    await interaction.update({ content: `${player.name}의 공격! ${dmg} 데미지!`, components: [] });
    
    if (session.enemyHp <= 0) {
      const xpGain = Math.floor(enemy.xp);
      const crystalGain = Math.floor(enemy.crystals);
      
      session.totalXp += xpGain;
      session.totalCrystals += crystalGain;
      
      for (const uid of party.members) {
        const p = players[uid];
        if (p && p.hp > 0) {
          p.mastery[p.active] = (p.mastery[p.active] || 0) + (enemy.masteryXp || 1);
          if (enemy.fingers) p.sukunaFingers = Math.min(SUKUNA_FINGER_MAX, (p.sukunaFingers || 0) + enemy.fingers);
        }
      }
      
      session.kills++;
      session.wave++;
      
      if (session.wave > party.bestWave) party.bestWave = session.wave;
      
      session.currentEnemy = pickCullingEnemy(session.wave);
      session.enemyHp = session.currentEnemy.hp;
      
      await interaction.editReply({ content: `✅ **${enemy.name}** 처치! WAVE ${session.wave}!\n파티 전체 +${xpGain} XP, +${crystalGain}💎`, components: [] });
      savePlayer(interaction.user.id);
      return;
    }
  }
  
  if (action === "pc_skill") {
    if (isIncapacitated(player.statusEffects)) {
      await interaction.reply({ content: "❌ 상태이상으로 행동할 수 없습니다!", ephemeral: true });
      return;
    }
    
    const skill = getCurrentSkill(player, player.active);
    const hit = rollHit(enemy.statusEffects);
    
    if (!hit) {
      await interaction.update({ content: "⚡ 술식이 빗나갔다!", components: [] });
      return;
    }
    
    const dmg = calcSkillDmgForPlayer(player, skill.dmg);
    session.enemyHp = Math.max(0, session.enemyHp - dmg);
    player.skillCooldown = 5;
    
    await interaction.update({ content: `${player.name}의 ${skill.name}! ${dmg} 데미지!`, components: [] });
    
    if (session.enemyHp <= 0) {
      const xpGain = Math.floor(enemy.xp);
      const crystalGain = Math.floor(enemy.crystals);
      
      session.totalXp += xpGain;
      session.totalCrystals += crystalGain;
      
      for (const uid of party.members) {
        const p = players[uid];
        if (p && p.hp > 0) {
          p.mastery[p.active] = (p.mastery[p.active] || 0) + (enemy.masteryXp || 1);
          if (enemy.fingers) p.sukunaFingers = Math.min(SUKUNA_FINGER_MAX, (p.sukunaFingers || 0) + enemy.fingers);
        }
      }
      
      session.kills++;
      session.wave++;
      if (session.wave > party.bestWave) party.bestWave = session.wave;
      
      session.currentEnemy = pickCullingEnemy(session.wave);
      session.enemyHp = session.currentEnemy.hp;
      
      await interaction.editReply({ content: `✅ **${enemy.name}** 처치! WAVE ${session.wave}!\n파티 전체 +${xpGain} XP, +${crystalGain}💎`, components: [] });
      savePlayer(interaction.user.id);
      return;
    }
  }
  
  if (action === "pc_reverse") {
    if (!REVERSE_CHARS.has(player.active)) {
      await interaction.reply({ content: "❌ 반전술식 불가!", ephemeral: true });
      return;
    }
    
    const stats = getPlayerStats(player);
    const healAmount = Math.floor(stats.maxHp * 0.4);
    player.hp = Math.min(stats.maxHp, player.hp + healAmount);
    player.reverseCooldown = 3;
    
    await interaction.update({ content: `${player.name} ♻️ ${healAmount} HP 회복!`, components: [] });
  }
  
  // 적 턴 (파티원 전체 공격)
  if (session.enemyHp > 0) {
    for (const uid of party.members) {
      const p = players[uid];
      if (p && p.hp > 0) {
        const hit = rollHit(p.statusEffects);
        if (hit) {
          const dmg = calcDmg(enemy.atk, getPlayerStats(p).def);
          p.hp = Math.max(0, p.hp - dmg);
          await interaction.followUp({ content: `💥 ${p.name}가 ${dmg} 데미지를 받았다!`, ephemeral: false });
          
          if (p.hp <= 0) {
            await interaction.followUp({ content: `💀 ${p.name} 쓰러졌다!`, ephemeral: false });
          }
        } else {
          await interaction.followUp({ content: `⚡ ${p.name}는 공격을 피했다!`, ephemeral: false });
        }
      }
    }
    
    // 모든 파티원 사망 체크
    const allDead = party.members.every(uid => players[uid]?.hp <= 0);
    if (allDead) {
      const totalXp = session.totalXp;
      const totalCrystals = session.totalCrystals;
      
      for (const uid of party.members) {
        const p = players[uid];
        if (p) {
          p.xp += Math.floor(totalXp / party.members.length);
          p.crystals += Math.floor(totalCrystals / party.members.length);
        }
      }
      
      delete cullings[party.id];
      await interaction.editReply({ content: `💀 파티 전멸! WAVE ${session.wave}에서 종료.\n획득: +${Math.floor(totalXp/party.members.length)} XP, +${Math.floor(totalCrystals/party.members.length)}💎`, components: [] });
      return;
    }
  }
  
  tickCooldowns(player);
  savePlayer(interaction.user.id);
}

// ════════════════════════════════════════════════════════════════════════════════
// ── PvP 핸들러
// ════════════════════════════════════════════════════════════════════════════════
async function handlePvpAction(interaction, player, session, action, userId) {
  const self = pvpSelf(session, userId);
  const opponent = pvpOpponent(session, userId);
  const opponentPlayer = players[opponent.id];
  const selfStats = getPlayerStats(player);
  const opponentStats = getPlayerStats(opponentPlayer);
  
  if (action === "p_attack") {
    const hit = rollHit(session[opponent.statusKey]);
    if (!hit) {
      await interaction.update({ content: "⚡ 공격이 빗나갔다!", components: [mkPvpButtons(session, userId)] });
      session.turn = opponent.id;
      await interaction.followUp({ content: `${opponentPlayer.name}의 턴!`, ephemeral: false });
      return;
    }
    
    const dmg = calcDmg(selfStats.atk, opponentStats.def);
    session[opponent.hpKey] = Math.max(0, session[opponent.hpKey] - dmg);
    
    await interaction.update({ content: `⚔️ ${dmg} 데미지!`, components: [mkPvpButtons(session, userId)] });
    
    if (session[opponent.hpKey] <= 0) {
      player.pvpWins++;
      opponentPlayer.pvpLosses++;
      updateQuestProgress(player, "pvp_win", 1);
      checkAchievements(player);
      delete pvpSessions[session.id];
      await interaction.editReply({ content: `🏆 ${player.name} 승리!`, components: [] });
      savePlayer(userId);
      savePlayer(opponent.id);
      return;
    }
    
    session.turn = opponent.id;
    await interaction.followUp({ content: `${opponentPlayer.name}의 턴!`, ephemeral: false });
  }
  
  if (action === "p_skill") {
    if (session[self.skillCdKey] > 0) {
      await interaction.reply({ content: `⏰ 술식 쿨다운! (${session[self.skillCdKey]}턴 남음)`, ephemeral: true });
      return;
    }
    
    const skill = getCurrentSkill(player, player.active);
    const hit = rollHit(session[opponent.statusKey]);
    if (!hit) {
      await interaction.update({ content: "⚡ 술식이 빗나갔다!", components: [mkPvpButtons(session, userId)] });
      session.turn = opponent.id;
      return;
    }
    
    const dmg = calcSkillDmgForPlayer(player, skill.dmg);
    session[opponent.hpKey] = Math.max(0, session[opponent.hpKey] - dmg);
    const statusLog = applySkillStatus(skill, opponentPlayer, player);
    session[self.skillCdKey] = 5;
    
    await interaction.update({ content: `🌀 ${skill.name}! ${dmg} 데미지!\n${statusLog.join("\n")}`, components: [mkPvpButtons(session, userId)] });
    
    if (session[opponent.hpKey] <= 0) {
      player.pvpWins++;
      opponentPlayer.pvpLosses++;
      updateQuestProgress(player, "pvp_win", 1);
      checkAchievements(player);
      delete pvpSessions[session.id];
      await interaction.editReply({ content: `🏆 ${player.name} 승리!`, components: [] });
      savePlayer(userId);
      savePlayer(opponent.id);
      return;
    }
    
    session.turn = opponent.id;
  }
  
  if (action === "p_reverse") {
    if (!REVERSE_CHARS.has(player.active)) {
      await interaction.reply({ content: "❌ 반전술식 불가!", ephemeral: true });
      return;
    }
    if (session[self.reverseCdKey] > 0) {
      await interaction.reply({ content: `⏰ 반전술식 쿨다운!`, ephemeral: true });
      return;
    }
    
    const heal = Math.floor(selfStats.maxHp * 0.4);
    session[self.hpKey] = Math.min(selfStats.maxHp, session[self.hpKey] + heal);
    session[self.reverseCdKey] = 3;
    
    await interaction.update({ content: `♻️ ${heal} HP 회복!`, components: [mkPvpButtons(session, userId)] });
    session.turn = opponent.id;
  }
  
  if (action === "p_domain") {
    const ch = CHARACTERS[player.active];
    if (!ch.domain) {
      await interaction.reply({ content: "❌ 영역전개 없음!", ephemeral: true });
      return;
    }
    if (session[self.domainKey]) {
      await interaction.reply({ content: "❌ 이미 영역전개 사용!", ephemeral: true });
      return;
    }
    
    const dmg = Math.floor(selfStats.atk * 3 - opponentStats.def * 0.3);
    session[opponent.hpKey] = Math.max(0, session[opponent.hpKey] - dmg);
    session[self.domainKey] = true;
    updateQuestProgress(player, "domain_use", 1);
    
    await interaction.update({ content: `🌌 ${ch.domain}! ${dmg} 데미지!`, components: [mkPvpButtons(session, userId)] });
    
    if (session[opponent.hpKey] <= 0) {
      player.pvpWins++;
      opponentPlayer.pvpLosses++;
      updateQuestProgress(player, "pvp_win", 1);
      delete pvpSessions[session.id];
      await interaction.editReply({ content: `🏆 ${player.name} 승리!`, components: [] });
      savePlayer(userId);
      savePlayer(opponent.id);
      return;
    }
    
    session.turn = opponent.id;
  }
  
  if (action === "p_surrender") {
    player.pvpLosses++;
    opponentPlayer.pvpWins++;
    updateQuestProgress(opponentPlayer, "pvp_win", 1);
    delete pvpSessions[session.id];
    await interaction.update({ content: `🏳️ ${player.name} 항복! ${opponentPlayer.name} 승리!`, components: [] });
    savePlayer(userId);
    savePlayer(opponent.id);
    return;
  }
  
  savePlayer(userId);
}
// ════════════════════════════════════════════════════════════════════════════════
// ── 봇 초기화 및 명령어 등록
// ════════════════════════════════════════════════════════════════════════════════
client.once("ready", async () => {
  console.log(`✅ 로그인: ${client.user.tag}`);
  await dbInit();
  players = await dbLoad();
  console.log("🚀 주술회전 RPG 봇 활성화");
  
  // 모든 플레이어 데이터 초기화 (기존 데이터 유지)
  for (const uid of Object.keys(players)) {
    const p = players[uid];
    if (p.quests === undefined) initQuestData(p);
    if (p.materials === undefined) p.materials = {};
    if (p.tools === undefined) p.tools = [];
    if (p.achievements === undefined) p.achievements = {
      firstWin: false, fingerCollector: false, cullingMaster: false,
      jujutsuComplete: false, pvpFirstWin: false, partyPlay: false, toolCrafter: false,
    };
  }
  
  const commands = [
    { name: "프로필", description: "내 프로필을 확인합니다 (GIF)" },
    { name: "도감", description: "보유 캐릭터를 확인합니다" },
    { name: "전투", description: "일반 전투를 시작합니다" },
    { name: "술식", description: "현재 캐릭터의 술식을 확인합니다" },
    { name: "가챠", description: "캐릭터를 뽑습니다", options: [{ name: "횟수", type: 4, description: "1 또는 10", required: true }] },
    { name: "활성", description: "활성 캐릭터를 변경합니다", options: [{ name: "캐릭터", type: 3, description: "캐릭터 ID", required: true }] },
    { name: "출석", description: "매일 출석 체크를 합니다" },
    { name: "회복", description: "회복약을 사용합니다" },
    { name: "코가네가챠", description: "코가네 펫을 뽑습니다 (200💎)" },
    { name: "코가네", description: "코가네 펫 정보를 확인합니다" },
    { name: "손가락", description: "스쿠나 손가락 보유 현황을 확인합니다" },
    { name: "컬링", description: "컬링 게임을 시작합니다" },
    { name: "사멸회유", description: "사멸회유 게임을 시작합니다" },
    { name: "결투", description: "다른 유저에게 PvP 결투를 신청합니다", options: [{ name: "대상", type: 6, description: "결투할 대상", required: true }] },
    { name: "파티생성", description: "파티를 생성합니다" },
    { name: "파티초대", description: "파티에 유저를 초대합니다", options: [{ name: "대상", type: 6, description: "초대할 대상", required: true }] },
    { name: "파티나가기", description: "파티에서 나갑니다" },
    { name: "파티컬링", description: "파티 컬링을 시작합니다" },
    { name: "주력설정", description: "주력 스킬을 설정합니다", options: [{ name: "스킬명", type: 3, description: "설정할 스킬 이름", required: true }] },
    { name: "도전과제", description: "도전과제 진행도를 확인합니다" },
    { name: "퀘스트", description: "일일/주간 퀘스트를 확인합니다" },
    { name: "퀘스트보상", description: "완료한 퀘스트 보상을 받습니다", options: [{ name: "타입", type: 3, description: "일일 또는 주간", required: true }, { name: "번호", type: 4, description: "퀘스트 번호", required: true }] },
    { name: "제작", description: "주구를 제작합니다", options: [{ name: "주구명", type: 3, description: "제작할 주구 이름", required: true }] },
    { name: "장착", description: "주구를 장착합니다", options: [{ name: "주구명", type: 3, description: "장착할 주구 이름", required: true }] },
    { name: "해제", description: "주구를 해제합니다" },
    { name: "재료", description: "보유한 재료를 확인합니다" },
    { name: "코드", description: "쿠폰 코드를 사용합니다", options: [{ name: "코드", type: 3, description: "쿠폰 코드", required: true }] },
    { name: "도움말", description: "명령어 목록을 확인합니다" },
  ];
  
  if (isDev(client.user.id)) {
    commands.push(
      { name: "개발자패널", description: "[개발자] 개발자 패널" },
      { name: "쿨다운초기화", description: "[개발자] 쿨다운을 초기화합니다" },
      { name: "아이템지급", description: "[개발자] 아이템을 지급합니다", options: [{ name: "아이템", type: 3, description: "아이템 종류", required: true }, { name: "수량", type: 4, description: "수량", required: false }] }
    );
  }
  
  await client.application.commands.set(commands);
  console.log("✅ 슬래시 커맨드 등록 완료");
});
// ════════════════════════════════════════════════════════════════════════════════
// ── 인터랙션 핸들러 (버튼 및 슬래시 명령어)
// ════════════════════════════════════════════════════════════════════════════════
client.on("interactionCreate", async (interaction) => {
  // ==================== 버튼 처리 ====================
  if (interaction.isButton()) {
    const { customId, user } = interaction;
    const userId = user.id;
    const player = getPlayer(userId, user.username);
    
    // 일반 전투 버튼
    if (customId.startsWith("b_")) {
      const battle = battles[userId];
      if (!battle) return interaction.reply({ content: "⚔️ 진행 중인 전투가 없습니다.", ephemeral: true });
      await handleBattleAction(interaction, player, battle, customId);
      return;
    }
    
    // 컬링 버튼
    if (customId.startsWith("c_")) {
      const culling = cullings[userId];
      if (!culling) return interaction.reply({ content: "🌊 진행 중인 컬링이 없습니다.", ephemeral: true });
      await handleCullingAction(interaction, player, culling, customId);
      return;
    }
    
    // 파티 컬링 버튼
    if (customId.startsWith("pc_")) {
      const party = getParty(userId);
      if (!party) return interaction.reply({ content: "👥 파티에 소속되어 있지 않습니다.", ephemeral: true });
      const session = cullings[party.id];
      if (!session) return interaction.reply({ content: "🌊 진행 중인 파티 컬링이 없습니다.", ephemeral: true });
      if (players[userId].hp <= 0) return interaction.reply({ content: "💀 당신은 전투 불능 상태입니다!", ephemeral: true });
      await handlePartyCullingAction(interaction, player, session, customId, party);
      return;
    }
    
    // PvP 버튼
    if (customId.startsWith("p_")) {
      const session = getPvpSessionByUser(userId);
      if (!session) return interaction.reply({ content: "⚔️ 진행 중인 PvP가 없습니다.", ephemeral: true });
      if (session.turn !== userId) return interaction.reply({ content: "⏳ 지금은 당신의 턴이 아닙니다!", ephemeral: true });
      await handlePvpAction(interaction, player, session, customId, userId);
      return;
    }
    
    // 파티 초대 버튼
    if (customId.startsWith("party_invite_")) {
      const parts = customId.split("_");
      const partyId = parts[3];
      const targetId = parts[4];
      const action = parts[2];
      
      if (user.id !== targetId) return interaction.reply({ content: "❌ 이 초대는 당신을 위한 것이 아닙니다.", ephemeral: true });
      const invite = partyInvites[targetId];
      if (!invite || invite.partyId !== partyId) return interaction.reply({ content: "❌ 만료되었거나 유효하지 않은 초대입니다.", ephemeral: true });
      
      if (action === "accept") {
        const party = parties[partyId];
        if (!party) return interaction.reply({ content: "❌ 파티가 이미 해체되었습니다.", ephemeral: true });
        if (party.members.length >= 4) return interaction.reply({ content: "❌ 파티가 가득 찼습니다. (최대 4명)", ephemeral: true });
        if (getPartyId(targetId)) return interaction.reply({ content: "❌ 이미 다른 파티에 소속되어 있습니다.", ephemeral: true });
        
        party.members.push(targetId);
        delete partyInvites[targetId];
        await interaction.update({ content: `✅ 파티에 참가했습니다! (${party.members.length}/4)`, embeds: [], components: [] });
      } else if (action === "decline") {
        delete partyInvites[targetId];
        await interaction.update({ content: `❌ 파티 초대를 거절했습니다.`, embeds: [], components: [] });
      }
      return;
    }
    
    // PvP 도전 버튼
    if (customId.startsWith("pvp_challenge_")) {
      const parts = customId.split("_");
      const action = parts[3];
      const challengerId = parts[4];
      
      if (action === "accept") {
        const challenge = pvpChallenges[challengerId];
        if (!challenge || challenge.target !== user.id) return interaction.reply({ content: "❌ 유효하지 않은 도전입니다.", ephemeral: true });
        if (getPvpSessionByUser(user.id) || getPvpSessionByUser(challengerId)) {
          return interaction.reply({ content: "❌ 둘 중 한 명이 이미 PvP 중입니다.", ephemeral: true });
        }
        
        const p1 = players[challengerId];
        const p2 = players[user.id];
        const stats1 = getPlayerStats(p1);
        const stats2 = getPlayerStats(p2);
        const sessionId = `${_pvpIdSeq++}`;
        
        pvpSessions[sessionId] = {
          id: sessionId, p1Id: challengerId, p2Id: user.id,
          hp1: stats1.maxHp, hp2: stats2.maxHp,
          status1: [], status2: [],
          skillCd1: 0, skillCd2: 0,
          reverseCd1: 0, reverseCd2: 0,
          domainUsed1: false, domainUsed2: false,
          turn: challengerId, round: 1,
        };
        delete pvpChallenges[challengerId];
        
        const embed = new EmbedBuilder()
          .setTitle(`⚔️ PvP 결투: ${p1.name} VS ${p2.name}`)
          .setColor(0xF5C842)
          .setDescription("결투 시작!");
        
        const buttons = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("p_attack").setLabel("⚔️ 공격").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId("p_skill").setLabel("🌀 술식").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId("p_domain").setLabel("🌌 영역전개").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId("p_reverse").setLabel("♻️ 반전").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId("p_surrender").setLabel("🏳️ 항복").setStyle(ButtonStyle.Secondary)
        );
        
        await interaction.update({ embeds: [embed], components: [buttons] });
      } else if (action === "decline") {
        delete pvpChallenges[challengerId];
        await interaction.update({ content: `❌ 상대방이 결투를 거절했습니다.`, embeds: [], components: [] });
      }
      return;
    }
  }
  
  // ==================== 슬래시 명령어 처리 ====================
  if (interaction.isChatInputCommand()) {
    const { commandName, user } = interaction;
    const userId = user.id;
    let player = getPlayer(userId, user.username);
    
    // ===== 기본 명령어 =====
    if (commandName === "프로필") {
      await interaction.deferReply();
      const stats = getPlayerStats(player);
      const ch = CHARACTERS[player.active];
      const avatarUrl = user.displayAvatarURL({ extension: "png", size: 256 });
      
      try {
        const gifBuffer = await createJJKGifProfileCard(player, stats, ch, avatarUrl);
        await interaction.editReply({ content: `🔱 **${player.name}**님의 주술사 프로필`, files: [gifBuffer] });
      } catch (err) {
        console.error("GIF 생성 실패:", err);
        await interaction.editReply({ embeds: [profileEmbed(player)] });
      }
    }
    
    else if (commandName === "도감") {
      await interaction.reply({ embeds: [pokedexEmbed(player)] });
    }
    
    else if (commandName === "전투") {
      if (battles[userId]) return interaction.reply({ content: "❌ 이미 전투 중입니다!", ephemeral: true });
      const enemy = { ...ENEMIES[0], currentHp: ENEMIES[0].hp };
      battles[userId] = { enemy };
      const embed = new EmbedBuilder()
        .setTitle("⚔️ 전투 시작!")
        .setColor(0xff0000)
        .setDescription(`**${enemy.name}** 등장!`)
        .addFields(
          { name: "내 HP", value: `${player.hp}/${getPlayerStats(player).maxHp}`, inline: true },
          { name: "적 HP", value: `${enemy.currentHp}/${enemy.hp}`, inline: true }
        );
      await interaction.reply({ embeds: [embed], components: [mkBattleButtons(player)] });
    }
    
    else if (commandName === "술식") {
      await interaction.reply({ embeds: [skillEmbed(player)] });
    }
    
    else if (commandName === "가챠") {
      const count = interaction.options.getInteger("횟수");
      if (count !== 1 && count !== 10) return interaction.reply({ content: "❌ 1회 또는 10회만 가능합니다!", ephemeral: true });
      const cost = count === 1 ? 150 : 1350;
      if (player.crystals < cost) return interaction.reply({ content: `💎 크리스탈이 부족합니다! (필요: ${cost})`, ephemeral: true });
      
      player.crystals -= cost;
      const results = rollGacha(count);
      const newOnes = results.filter(id => !player.owned.includes(id));
      const dupCrystals = results.filter(id => player.owned.includes(id)).length * 50;
      
      for (const id of newOnes) player.owned.push(id);
      player.crystals += dupCrystals;
      
      const resultLines = results.map(id => {
        const c = CHARACTERS[id];
        const isNew = newOnes.includes(id);
        return `${c.emoji} **${c.name}** (${c.grade})${isNew ? " ✨NEW!✨" : " (중복)"}`;
      }).join("\n");
      
      const embed = new EmbedBuilder()
        .setTitle(count === 1 ? "🎲 가챠 결과" : "🎲 10연차 결과")
        .setColor(0xF5C842)
        .setDescription(resultLines)
        .addFields(
          { name: "✨ 신규 획득", value: newOnes.length ? newOnes.map(id => CHARACTERS[id].name).join(", ") : "없음", inline: true },
          { name: "🔄 중복 보상", value: `+${dupCrystals}💎`, inline: true },
          { name: "💎 잔여 크리스탈", value: `${player.crystals}`, inline: true }
        );
      
      await interaction.reply({ embeds: [embed] });
      savePlayer(userId);
    }
    
    else if (commandName === "활성") {
      const charId = interaction.options.getString("캐릭터").toLowerCase();
      if (!player.owned.includes(charId)) return interaction.reply({ content: "❌ 해당 캐릭터를 보유하지 않았습니다!", ephemeral: true });
      player.active = charId;
      const stats = getPlayerStats(player);
      player.hp = stats.maxHp;
      await interaction.reply({ content: `✅ 활성 캐릭터를 **${CHARACTERS[charId].name}**(으)로 변경했습니다! HP가 회복되었습니다.` });
      savePlayer(userId);
    }
    
    else if (commandName === "출석") {
      const now = Date.now();
      const last = player.lastDaily || 0;
      if (now - last < 86400000) {
        const remaining = Math.ceil((86400000 - (now - last)) / 3600000);
        return interaction.reply({ content: `⏰ 이미 출석했습니다! ${remaining}시간 후 다시 가능합니다.`, ephemeral: true });
      }
      const streakBonus = Math.min(player.dailyStreak || 0, 30);
      const totalCrystals = 100 + streakBonus * 5;
      player.crystals += totalCrystals;
      player.lastDaily = now;
      player.dailyStreak = (player.dailyStreak || 0) + 1;
      await interaction.reply({ content: `✅ 출석 체크! +${totalCrystals}💎 (연속 ${player.dailyStreak}일)` });
      savePlayer(userId);
    }
    
    else if (commandName === "회복") {
      if (player.potion <= 0) return interaction.reply({ content: "❌ 회복약이 없습니다! 전투에서 획득하세요.", ephemeral: true });
      const stats = getPlayerStats(player);
      player.hp = stats.maxHp;
      player.potion--;
      await interaction.reply({ content: `✅ HP가 가득 회복되었습니다! (남은 회복약: ${player.potion}개)` });
      savePlayer(userId);
    }
    
    // ===== 코가네 시스템 =====
    else if (commandName === "코가네가챠") {
      if (player.crystals < 200) return interaction.reply({ content: "💎 크리스탈이 부족합니다! (필요: 200)", ephemeral: true });
      player.crystals -= 200;
      player.koganeGachaCount = (player.koganeGachaCount || 0) + 1;
      const grade = rollKogane();
      const gradeOrder = ["3급", "2급", "1급", "특급", "전설"];
      const isUpgrade = !player.kogane || gradeOrder.indexOf(grade) > gradeOrder.indexOf(player.kogane);
      
      if (isUpgrade) player.kogane = grade;
      else player.crystals += 50;
      
      const g = KOGANE_GRADES[grade];
      await interaction.reply({ content: `🐾 **코가네 소환!** ${grade} 등급${isUpgrade ? " (등급 상승!)" : " (하위 등급, +50💎)"}\n${g.passiveDesc}` });
      savePlayer(userId);
    }
    
    else if (commandName === "코가네") {
      if (!player.kogane) return interaction.reply({ content: "🐾 코가네가 없습니다! `/코가네가챠`로 획득하세요!", ephemeral: true });
      const g = KOGANE_GRADES[player.kogane];
      await interaction.reply({ content: `🐾 **코가네 [${player.kogane}]** ${g.stars}\n${g.passiveDesc}\n🐕 스킬: ${g.skill}` });
    }
    
    else if (commandName === "손가락") {
      const fingers = player.sukunaFingers || 0;
      const bonus = getFingerBonus(fingers);
      await interaction.reply({ content: `👹 **스쿠나 손가락**: ${fingers}/${SUKUNA_FINGER_MAX}\n${bonus.label}\n🗡️ ATK +${bonus.atkBonus} | 🛡️ DEF +${bonus.defBonus} | 💚 HP +${bonus.hpBonus}\n✨ 스킬 보너스: +${bonus.skillBonus}%` });
    }
    
    // ===== 게임 모드 =====
    else if (commandName === "컬링") {
      if (cullings[userId]) return interaction.reply({ content: "🌊 이미 컬링 중입니다!", ephemeral: true });
      const firstEnemy = pickCullingEnemy(1);
      cullings[userId] = {
        wave: 1, kills: 0, totalXp: 0, totalCrystals: 0,
        currentEnemy: firstEnemy, enemyHp: firstEnemy.hp,
      };
      await interaction.reply({ content: `🌊 **컬링 시작!** WAVE 1\n**${firstEnemy.name}** 등장!`, components: [mkCullingButtons(player)] });
    }
    
    else if (commandName === "사멸회유") {
      if (jujutsus[userId]) return interaction.reply({ content: "🎯 이미 사멸회유 중입니다!", ephemeral: true });
      // 간소화: 일반 컬링으로 대체 (원본에는 상세 구현)
      const firstEnemy = pickCullingEnemy(1);
      jujutsus[userId] = {
        wave: 1, points: 0, totalXp: 0, totalCrystals: 0,
        currentEnemy: firstEnemy, enemyHp: firstEnemy.hp,
      };
      await interaction.reply({ content: `🎯 **사멸회유 시작!** WAVE 1\n**${firstEnemy.name}** 등장!`, components: [mkCullingButtons(player)] });
    }
    
    else if (commandName === "결투") {
      const target = interaction.options.getUser("대상");
      if (target.id === userId) return interaction.reply({ content: "❌ 자신과 결투할 수 없습니다!", ephemeral: true });
      if (getPvpSessionByUser(userId) || getPvpSessionByUser(target.id)) {
        return interaction.reply({ content: "❌ 둘 중 한 명이 이미 PvP 중입니다!", ephemeral: true });
      }
      pvpChallenges[userId] = { target: target.id };
      const embed = new EmbedBuilder()
        .setTitle("⚔️ PvP 결투 신청")
        .setColor(0xF5C842)
        .setDescription(`${target}님, ${user}님이 결투를 신청했습니다!\n30초 내에 수락/거절 해주세요.`);
      const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`pvp_challenge_accept_${userId}`).setLabel("✅ 수락").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`pvp_challenge_decline_${userId}`).setLabel("❌ 거절").setStyle(ButtonStyle.Danger)
      );
      await interaction.reply({ content: `${target}`, embeds: [embed], components: [buttons] });
      setTimeout(() => { if (pvpChallenges[userId]) delete pvpChallenges[userId]; }, 30000);
    }
    
    // ===== 파티 시스템 =====
    else if (commandName === "파티생성") {
      if (getPartyId(userId)) return interaction.reply({ content: "❌ 이미 파티에 소속되어 있습니다!", ephemeral: true });
      const partyId = `${_partyIdSeq++}`;
      parties[partyId] = { id: partyId, leader: userId, members: [userId], bestWave: 0 };
      await interaction.reply({ content: `✅ 파티가 생성되었습니다! ID: ${partyId}\n/파티초대 @유저 로 초대하세요.` });
    }
    
    else if (commandName === "파티초대") {
      const target = interaction.options.getUser("대상");
      const party = getParty(userId);
      if (!party) return interaction.reply({ content: "❌ 파티에 소속되어 있지 않습니다!", ephemeral: true });
      if (party.leader !== userId) return interaction.reply({ content: "❌ 파티장만 초대할 수 있습니다!", ephemeral: true });
      if (party.members.length >= 4) return interaction.reply({ content: "❌ 파티가 가득 찼습니다! (최대 4명)", ephemeral: true });
      if (getPartyId(target.id)) return interaction.reply({ content: "❌ 상대방이 이미 다른 파티에 소속되어 있습니다!", ephemeral: true });
      
      partyInvites[target.id] = { partyId: party.id, inviter: userId };
      const embed = new EmbedBuilder()
        .setTitle("👥 파티 초대")
        .setColor(0x4ade80)
        .setDescription(`${target}님, ${user}님이 파티에 초대했습니다!`);
      const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`party_invite_accept_${party.id}_${target.id}`).setLabel("✅ 수락").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`party_invite_decline_${party.id}_${target.id}`).setLabel("❌ 거절").setStyle(ButtonStyle.Danger)
      );
      await interaction.reply({ content: `${target}`, embeds: [embed], components: [buttons] });
      setTimeout(() => { if (partyInvites[target.id]) delete partyInvites[target.id]; }, 60000);
    }
    
    else if (commandName === "파티나가기") {
      const party = getParty(userId);
      if (!party) return interaction.reply({ content: "❌ 파티에 소속되어 있지 않습니다!", ephemeral: true });
      const isLeader = party.leader === userId;
      party.members = party.members.filter(id => id !== userId);
      if (party.members.length === 0) {
        delete parties[party.id];
        await interaction.reply({ content: "✅ 파티에서 나갔습니다. (파티가 해체되었습니다)" });
      } else {
        if (isLeader) party.leader = party.members[0];
        await interaction.reply({ content: `✅ 파티에서 나갔습니다. ${isLeader ? "새 파티장: " + party.leader : ""}` });
      }
    }
    
    else if (commandName === "파티컬링") {
      const party = getParty(userId);
      if (!party) return interaction.reply({ content: "❌ 파티에 소속되어 있지 않습니다!", ephemeral: true });
      if (party.leader !== userId) return interaction.reply({ content: "❌ 파티장만 시작할 수 있습니다!", ephemeral: true });
      if (cullings[party.id]) return interaction.reply({ content: "🌊 이미 파티 컬링 중입니다!", ephemeral: true });
      for (const uid of party.members) {
        const p = players[uid];
        if (p && p.hp <= 0) return interaction.reply({ content: `❌ ${p.name}님이 전투 불능 상태입니다!`, ephemeral: true });
      }
      const firstEnemy = pickCullingEnemy(1);
      cullings[party.id] = {
        wave: 1, kills: 0, totalXp: 0, totalCrystals: 0,
        currentEnemy: firstEnemy, enemyHp: firstEnemy.hp,
      };
      await interaction.reply({ content: `⚔️ **파티 컬링 시작!** WAVE 1\n**${firstEnemy.name}** 등장!\n파티원: ${party.members.length}명`, components: [mkCullingButtons(player)] });
    }
    
    // ===== 주력 스킬 및 도전과제 =====
    else if (commandName === "주력설정") {
      const skillName = interaction.options.getString("스킬명");
      const ch = CHARACTERS[player.active];
      const skill = ch.skills.find(s => s.name === skillName);
      if (!skill) return interaction.reply({ content: "❌ 존재하지 않는 스킬입니다!", ephemeral: true });
      const currentMastery = getMastery(player, player.active);
      if (currentMastery < skill.minMastery) {
        return interaction.reply({ content: `❌ 숙련도가 부족합니다! 필요: ${skill.minMastery} (현재: ${currentMastery})`, ephemeral: true });
      }
      player.mainSkill = skillName;
      await interaction.reply({ content: `✅ 주력 스킬을 **${skillName}**(으)로 설정했습니다!\n도전과제 완료 시 데미지가 증가합니다.` });
      savePlayer(userId);
    }
    
    else if (commandName === "도전과제") {
      const mainBonus = getMainSkillBonus(player);
      const fingers = player.sukunaFingers || 0;
      await interaction.reply({ content: [
        `**🎯 도전과제 진행도** (주력 스킬 데미지 보너스: +${mainBonus}%)`,
        `${player.achievements.firstWin ? "✅" : "⬜"} 첫 승리 (${player.wins}/1) — +10%`,
        `${player.achievements.fingerCollector ? "✅" : "⬜"} 손가락 수집가 (${fingers}/5) — +20%`,
        `${player.achievements.cullingMaster ? "✅" : "⬜"} 컬링 마스터 (${player.cullingBest}/5) — +15%`,
        `${player.achievements.jujutsuComplete ? "✅" : "⬜"} 사멸회유 완료 (${player.jujutsuBest || 0}/15) — +25%`,
        `${player.achievements.pvpFirstWin ? "✅" : "⬜"} PvP 첫 승 (${player.pvpWins || 0}/1) — +20%`,
        `${player.achievements.toolCrafter ? "✅" : "⬜"} 주구 제작자 — +10%`,
      ].join("\n") });
    }
    
    // ===== 퀘스트 시스템 =====
    else if (commandName === "퀘스트") {
      await interaction.reply({ embeds: [getQuestEmbed(player)] });
    }
    
    else if (commandName === "퀘스트보상") {
      const type = interaction.options.getString("타입");
      const number = interaction.options.getInteger("번호");
      const isDaily = type === "일일";
      const questList = isDaily ? player.quests.daily : player.quests.weekly;
      
      if (number < 1 || number > questList.length) {
        return interaction.reply({ content: "❌ 유효하지 않은 퀘스트 번호입니다!", ephemeral: true });
      }
      
      const quest = questList[number - 1];
      const result = claimQuestReward(player, quest.id, isDaily);
      await interaction.reply({ content: result.message });
      if (result.success) savePlayer(userId);
    }
    
    // ===== 주구 제작 시스템 =====
    else if (commandName === "제작") {
      const toolName = interaction.options.getString("주구명");
      const result = craftTool(player, toolName);
      if (result.success) {
        updateQuestProgress(player, "tool_craft", 1);
        checkAchievements(player);
        await interaction.reply({ content: result.message });
        savePlayer(userId);
      } else {
        await interaction.reply({ content: `❌ ${result.message}`, ephemeral: true });
      }
    }
    
    else if (commandName === "장착") {
      const toolName = interaction.options.getString("주구명");
      const result = equipTool(player, toolName);
      await interaction.reply({ content: result.message });
      if (result.success) savePlayer(userId);
    }
    
    else if (commandName === "해제") {
      const result = unequipTool(player);
      await interaction.reply({ content: result.message });
      savePlayer(userId);
    }
    
    else if (commandName === "재료") {
      await interaction.reply({ embeds: [getMaterialsEmbed(player)] });
    }
    
    // ===== 기타 =====
    else if (commandName === "코드") {
      const code = interaction.options.getString("코드").toLowerCase();
      if (player.usedCodes.includes(code)) return interaction.reply({ content: "❌ 이미 사용한 코드입니다!", ephemeral: true });
      if (CODES[code]) {
        player.crystals += CODES[code].crystals || 0;
        if (CODES[code].fingers) player.sukunaFingers = Math.min(SUKUNA_FINGER_MAX, (player.sukunaFingers || 0) + CODES[code].fingers);
        player.usedCodes.push(code);
        await interaction.reply({ content: `✅ 코드 사용 완료! +${CODES[code].crystals || 0}💎` });
        savePlayer(userId);
      } else {
        await interaction.reply({ content: "❌ 유효하지 않은 코드입니다!", ephemeral: true });
      }
    }
    
    else if (commandName === "도움말") {
      const embed = new EmbedBuilder()
        .setTitle("🔱 주술회전 RPG 봇 명령어")
        .setColor(0xF5C842)
        .setDescription([
          "**⚔️ 전투**",
          "`/전투` - 일반 전투 시작",
          "`/컬링` - 웨이브 컬링 게임",
          "`/사멸회유` - 포인트 수집 모드",
          "`/결투 @유저` - PvP 결투",
          "",
          "**👥 파티**",
          "`/파티생성` - 파티 만들기",
          "`/파티초대 @유저` - 파티 초대",
          "`/파티나가기` - 파티 탈퇴",
          "`/파티컬링` - 파티 컬링",
          "",
          "**⭐ 주력 스킬 & 도전과제**",
          "`/주력설정 [스킬명]` - 주력 스킬 변경",
          "`/도전과제` - 도전과제 진행도 확인",
          "",
          "**📋 퀘스트**",
          "`/퀘스트` - 일일/주간 퀘스트 확인",
          "`/퀘스트보상 [일일/주간] [번호]` - 보상 수령",
          "",
          "**🔧 주구 제작**",
          "`/재료` - 보유 재료 확인",
          "`/제작 [주구명]` - 주구 제작",
          "`/장착 [주구명]` - 주구 장착",
          "`/해제` - 주구 해제",
          "",
          "**🎲 시스템**",
          "`/프로필` - 내 정보 (GIF)",
          "`/도감` - 보유 캐릭터",
          "`/가챠 [1/10]` - 캐릭터 뽑기",
          "`/코가네가챠` - 펫 뽑기 (200💎)",
          "`/활성 [캐릭터]` - 주력 변경",
          "`/술식` - 스킬 트리 보기",
          "`/출석` - 매일 보상",
          "`/회복` - 회복약 사용",
          "`/손가락` - 스쿠나 손가락 현황",
          "`/코드 [코드]` - 쿠폰 사용",
        ].join("\n"))
        .setFooter({ text: "즐거운 게임 되세요!" });
      await interaction.reply({ embeds: [embed] });
    }
    
    // ===== 개발자 명령어 =====
    else if (commandName === "개발자패널" && isDev(userId)) {
      const embed = new EmbedBuilder()
        .setTitle("🛠️ 개발자 패널")
        .setColor(0xff0000)
        .setDescription([
          "**개발자 전용 명령어**",
          "`/쿨다운초기화` - 쿨다운 초기화",
          "`/아이템지급 [아이템] [수량]` - 아이템 지급",
          "`!전체저장` - 전체 저장",
          "`!플레이어정보 @유저` - 유저 정보",
        ].join("\n"));
      await interaction.reply({ embeds: [embed], ephemeral: true });
    }
    
    else if (commandName === "쿨다운초기화" && isDev(userId)) {
      player.skillCooldown = 0;
      player.reverseCooldown = 0;
      await interaction.reply({ content: "✅ 쿨다운이 초기화되었습니다!" });
      savePlayer(userId);
    }
    
    else if (commandName === "아이템지급" && isDev(userId)) {
      const item = interaction.options.getString("아이템");
      const amount = interaction.options.getInteger("수량") || 1;
      if (item === "크리스탈") player.crystals += amount;
      else if (item === "회복약") player.potion += amount;
      else if (item === "손가락") player.sukunaFingers = Math.min(SUKUNA_FINGER_MAX, (player.sukunaFingers || 0) + amount);
      else return interaction.reply({ content: "❌ 아이템: 크리스탈, 회복약, 손가락", ephemeral: true });
      await interaction.reply({ content: `✅ ${item} +${amount} 지급!` });
      savePlayer(userId);
    }
  }
});

// ════════════════════════════════════════════════════════════════════════════════
// ── 느낌표(!) 명령어 핸들러 (messageCreate)
// ════════════════════════════════════════════════════════════════════════════════
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith("!")) return;
  
  const args = message.content.slice(1).trim().split(/\s+/);
  const cmd = args[0].toLowerCase();
  const userId = message.author.id;
  let player = getPlayer(userId, message.author.username);
  
  if (cmd === "프로필") {
    const stats = getPlayerStats(player);
    const ch = CHARACTERS[player.active];
    const avatarUrl = message.author.displayAvatarURL({ extension: "png", size: 256 });
    try {
      const gifBuffer = await createJJKGifProfileCard(player, stats, ch, avatarUrl);
      await message.reply({ content: `🔱 **${player.name}**님의 주술사 프로필`, files: [gifBuffer] });
    } catch (err) {
      await message.reply({ embeds: [profileEmbed(player)] });
    }
  }
  else if (cmd === "도감") await message.reply({ embeds: [pokedexEmbed(player)] });
  else if (cmd === "술식") await message.reply({ embeds: [skillEmbed(player)] });
  else if (cmd === "전투") {
    if (battles[userId]) return message.reply("❌ 이미 전투 중입니다!");
    const enemy = { ...ENEMIES[0], currentHp: ENEMIES[0].hp };
    battles[userId] = { enemy };
    await message.reply({ content: `⚔️ **${enemy.name}** 등장!`, components: [mkBattleButtons(player)] });
  }
  else if (cmd === "가챠") {
    const count = parseInt(args[1]) || 1;
    if (count !== 1 && count !== 10) return message.reply("❌ 1회 또는 10회만 가능합니다!");
    const cost = count === 1 ? 150 : 1350;
    if (player.crystals < cost) return message.reply(`💎 크리스탈이 부족합니다! (필요: ${cost})`);
    
    player.crystals -= cost;
    const results = rollGacha(count);
    const newOnes = results.filter(id => !player.owned.includes(id));
    const dupCrystals = results.filter(id => player.owned.includes(id)).length * 50;
    
    for (const id of newOnes) player.owned.push(id);
    player.crystals += dupCrystals;
    
    const resultLines = results.map(id => {
      const c = CHARACTERS[id];
      const isNew = newOnes.includes(id);
      return `${c.emoji} **${c.name}** (${c.grade})${isNew ? " ✨NEW!✨" : " (중복)"}`;
    }).join("\n");
    
    await message.reply(`🎲 **${count}연차 결과**\n${resultLines}\n✨ 신규: ${newOnes.length}명\n🔄 중복 보상: +${dupCrystals}💎\n💎 잔여: ${player.crystals}💎`);
    savePlayer(userId);
  }
  else if (cmd === "활성") {
    const charId = args[1]?.toLowerCase();
    if (!charId) return message.reply("!활성 [캐릭터ID]");
    if (!player.owned.includes(charId)) return message.reply("❌ 해당 캐릭터를 보유하지 않았습니다!");
    player.active = charId;
    const stats = getPlayerStats(player);
    player.hp = stats.maxHp;
    await message.reply(`✅ 활성 캐릭터를 **${CHARACTERS[charId].name}**(으)로 변경했습니다! HP가 회복되었습니다.`);
    savePlayer(userId);
  }
  else if (cmd === "출석") {
    const now = Date.now();
    if (player.lastDaily && now - player.lastDaily < 86400000) {
      const remaining = Math.ceil((86400000 - (now - player.lastDaily)) / 3600000);
      return message.reply(`⏰ 이미 출석했습니다! ${remaining}시간 후 다시 가능합니다.`);
    }
    const streakBonus = Math.min(player.dailyStreak || 0, 30);
    const totalCrystals = 100 + streakBonus * 5;
    player.crystals += totalCrystals;
    player.lastDaily = now;
    player.dailyStreak = (player.dailyStreak || 0) + 1;
    await message.reply(`✅ 출석 체크! +${totalCrystals}💎 (연속 ${player.dailyStreak}일)`);
    savePlayer(userId);
  }
  else if (cmd === "회복") {
    if (player.potion <= 0) return message.reply("❌ 회복약이 없습니다!");
    const stats = getPlayerStats(player);
    player.hp = stats.maxHp;
    player.potion--;
    await message.reply(`✅ HP가 가득 회복되었습니다! (남은 회복약: ${player.potion}개)`);
    savePlayer(userId);
  }
  else if (cmd === "코가네가챠") {
    if (player.crystals < 200) return message.reply("💎 크리스탈이 부족합니다! (필요: 200)");
    player.crystals -= 200;
    player.koganeGachaCount = (player.koganeGachaCount || 0) + 1;
    const grade = rollKogane();
    const gradeOrder = ["3급", "2급", "1급", "특급", "전설"];
    const isUpgrade = !player.kogane || gradeOrder.indexOf(grade) > gradeOrder.indexOf(player.kogane);
    if (isUpgrade) player.kogane = grade;
    else player.crystals += 50;
    const g = KOGANE_GRADES[grade];
    await message.reply(`🐾 **코가네 소환!** ${grade} 등급${isUpgrade ? " (등급 상승!)" : " (하위 등급, +50💎)"}\n${g.passiveDesc}`);
    savePlayer(userId);
  }
  else if (cmd === "코가네") {
    if (!player.kogane) return message.reply("🐾 코가네가 없습니다! `!코가네가챠`로 획득하세요!");
    const g = KOGANE_GRADES[player.kogane];
    await message.reply(`🐾 **코가네 [${player.kogane}]** ${g.stars}\n${g.passiveDesc}`);
  }
  else if (cmd === "손가락") {
    const fingers = player.sukunaFingers || 0;
    const bonus = getFingerBonus(fingers);
    await message.reply(`👹 **스쿠나 손가락**: ${fingers}/${SUKUNA_FINGER_MAX}\n${bonus.label}\n🗡️ ATK +${bonus.atkBonus} | 🛡️ DEF +${bonus.defBonus} | 💚 HP +${bonus.hpBonus}`);
  }
  else if (cmd === "컬링") {
    if (cullings[userId]) return message.reply("🌊 이미 컬링 중입니다!");
    const firstEnemy = pickCullingEnemy(1);
    cullings[userId] = {
      wave: 1, kills: 0, totalXp: 0, totalCrystals: 0,
      currentEnemy: firstEnemy, enemyHp: firstEnemy.hp,
    };
    await message.reply({ content: `🌊 **컬링 시작!** WAVE 1\n**${firstEnemy.name}** 등장!`, components: [mkCullingButtons(player)] });
  }
  else if (cmd === "결투") {
    const target = message.mentions.users.first();
    if (!target) return message.reply("❌ 대상을 멘션하세요! `!결투 @유저`");
    if (target.id === userId) return message.reply("❌ 자신과 결투할 수 없습니다!");
    if (getPvpSessionByUser(userId) || getPvpSessionByUser(target.id)) {
      return message.reply("❌ 둘 중 한 명이 이미 PvP 중입니다!");
    }
    pvpChallenges[userId] = { target: target.id };
    const embed = new EmbedBuilder()
      .setTitle("⚔️ PvP 결투 신청")
      .setColor(0xF5C842)
      .setDescription(`${target}님, **${message.author.username}**님이 결투를 신청했습니다!\n30초 내에 수락/거절 해주세요.`);
    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`pvp_challenge_accept_${userId}`).setLabel("✅ 수락").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`pvp_challenge_decline_${userId}`).setLabel("❌ 거절").setStyle(ButtonStyle.Danger)
    );
    await message.reply({ content: `${target}`, embeds: [embed], components: [buttons] });
    setTimeout(() => { if (pvpChallenges[userId]) delete pvpChallenges[userId]; }, 30000);
  }
  else if (cmd === "파티생성") {
    if (getPartyId(userId)) return message.reply("❌ 이미 파티에 소속되어 있습니다!");
    const partyId = `${_partyIdSeq++}`;
    parties[partyId] = { id: partyId, leader: userId, members: [userId], bestWave: 0 };
    await message.reply(`✅ 파티가 생성되었습니다! ID: ${partyId}\n!파티초대 @유저 로 초대하세요.`);
  }
  else if (cmd === "파티초대") {
    const target = message.mentions.users.first();
    if (!target) return message.reply("❌ 대상을 멘션하세요! `!파티초대 @유저`");
    const party = getParty(userId);
    if (!party) return message.reply("❌ 파티에 소속되어 있지 않습니다!");
    if (party.leader !== userId) return message.reply("❌ 파티장만 초대할 수 있습니다!");
    if (party.members.length >= 4) return message.reply("❌ 파티가 가득 찼습니다! (최대 4명)");
    if (getPartyId(target.id)) return message.reply("❌ 상대방이 이미 다른 파티에 소속되어 있습니다!");
    
    partyInvites[target.id] = { partyId: party.id, inviter: userId };
    const embed = new EmbedBuilder()
      .setTitle("👥 파티 초대")
      .setColor(0x4ade80)
      .setDescription(`${target}님, **${message.author.username}**님이 파티에 초대했습니다!`);
    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`party_invite_accept_${party.id}_${target.id}`).setLabel("✅ 수락").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`party_invite_decline_${party.id}_${target.id}`).setLabel("❌ 거절").setStyle(ButtonStyle.Danger)
    );
    await message.reply({ content: `${target}`, embeds: [embed], components: [buttons] });
    setTimeout(() => { if (partyInvites[target.id]) delete partyInvites[target.id]; }, 60000);
  }
  else if (cmd === "파티나가기") {
    const party = getParty(userId);
    if (!party) return message.reply("❌ 파티에 소속되어 있지 않습니다!");
    const isLeader = party.leader === userId;
    party.members = party.members.filter(id => id !== userId);
    if (party.members.length === 0) {
      delete parties[party.id];
      await message.reply("✅ 파티에서 나갔습니다. (파티가 해체되었습니다)");
    } else {
      if (isLeader) party.leader = party.members[0];
      await message.reply(`✅ 파티에서 나갔습니다. ${isLeader ? "새 파티장: " + party.leader : ""}`);
    }
  }
  else if (cmd === "파티컬링") {
    const party = getParty(userId);
    if (!party) return message.reply("❌ 파티에 소속되어 있지 않습니다!");
    if (party.leader !== userId) return message.reply("❌ 파티장만 시작할 수 있습니다!");
    if (cullings[party.id]) return message.reply("🌊 이미 파티 컬링 중입니다!");
    for (const uid of party.members) {
      const p = players[uid];
      if (p && p.hp <= 0) return message.reply(`❌ ${p.name}님이 전투 불능 상태입니다!`);
    }
    const firstEnemy = pickCullingEnemy(1);
    cullings[party.id] = {
      wave: 1, kills: 0, totalXp: 0, totalCrystals: 0,
      currentEnemy: firstEnemy, enemyHp: firstEnemy.hp,
    };
    await message.reply({ content: `⚔️ **파티 컬링 시작!** WAVE 1\n**${firstEnemy.name}** 등장!\n파티원: ${party.members.length}명`, components: [mkCullingButtons(player)] });
  }
  else if (cmd === "주력설정") {
    const skillName = args.slice(1).join(" ");
    if (!skillName) return message.reply("!주력설정 [스킬명]");
    const ch = CHARACTERS[player.active];
    const skill = ch.skills.find(s => s.name === skillName);
    if (!skill) return message.reply("❌ 존재하지 않는 스킬입니다!");
    const currentMastery = getMastery(player, player.active);
    if (currentMastery < skill.minMastery) {
      return message.reply(`❌ 숙련도가 부족합니다! 필요: ${skill.minMastery} (현재: ${currentMastery})`);
    }
    player.mainSkill = skillName;
    await message.reply(`✅ 주력 스킬을 **${skillName}**(으)로 설정했습니다!`);
    savePlayer(userId);
  }
  else if (cmd === "도전과제") {
    const mainBonus = getMainSkillBonus(player);
    const fingers = player.sukunaFingers || 0;
    await message.reply([
      `**🎯 도전과제 진행도** (주력 스킬 데미지 보너스: +${mainBonus}%)`,
      `${player.achievements.firstWin ? "✅" : "⬜"} 첫 승리 (${player.wins}/1) — +10%`,
      `${player.achievements.fingerCollector ? "✅" : "⬜"} 손가락 수집가 (${fingers}/5) — +20%`,
      `${player.achievements.cullingMaster ? "✅" : "⬜"} 컬링 마스터 (${player.cullingBest}/5) — +15%`,
      `${player.achievements.jujutsuComplete ? "✅" : "⬜"} 사멸회유 완료 (${player.jujutsuBest || 0}/15) — +25%`,
      `${player.achievements.pvpFirstWin ? "✅" : "⬜"} PvP 첫 승 (${player.pvpWins || 0}/1) — +20%`,
    ].join("\n"));
  }
  else if (cmd === "퀘스트") {
    await message.reply({ embeds: [getQuestEmbed(player)] });
  }
  else if (cmd === "제작") {
    const toolName = args.slice(1).join(" ");
    if (!toolName) return message.reply("!제작 [주구명]");
    const result = craftTool(player, toolName);
    if (result.success) {
      updateQuestProgress(player, "tool_craft", 1);
      checkAchievements(player);
      await message.reply(result.message);
      savePlayer(userId);
    } else {
      await message.reply(`❌ ${result.message}`);
    }
  }
  else if (cmd === "장착") {
    const toolName = args.slice(1).join(" ");
    if (!toolName) return message.reply("!장착 [주구명]");
    const result = equipTool(player, toolName);
    await message.reply(result.message);
    if (result.success) savePlayer(userId);
  }
  else if (cmd === "해제") {
    const result = unequipTool(player);
    await message.reply(result.message);
    savePlayer(userId);
  }
  else if (cmd === "재료") {
    await message.reply({ embeds: [getMaterialsEmbed(player)] });
  }
  else if (cmd === "코드") {
    const code = args[1]?.toLowerCase();
    if (!code) return message.reply("!코드 [코드명]");
    if (player.usedCodes.includes(code)) return message.reply("❌ 이미 사용한 코드입니다!");
    if (CODES[code]) {
      player.crystals += CODES[code].crystals || 0;
      player.usedCodes.push(code);
      await message.reply(`✅ 코드 사용 완료! +${CODES[code].crystals || 0}💎`);
      savePlayer(userId);
    } else {
      await message.reply("❌ 유효하지 않은 코드입니다!");
    }
  }
  else if (cmd === "도움말") {
    await message.reply({
      content: "🔱 **명령어 목록**\n!프로필 !도감 !전투 !가챠 !활성 !출석 !회복 !코가네가챠 !코가네 !손가락 !컬링 !결투 !파티생성 !파티초대 !파티나가기 !파티컬링 !주력설정 !도전과제 !퀘스트 !제작 !장착 !해제 !재료 !코드\n슬래시(/) 명령어도 동일하게 사용 가능합니다!"
    });
  }
  else if (cmd === "전체저장" && isDev(userId)) {
    for (const uid of Object.keys(players)) await dbSave(uid, players[uid]);
    await message.reply("✅ 전체 저장 완료!");
  }
  else if (cmd === "플레이어정보" && isDev(userId)) {
    const target = message.mentions.users.first() || message.author;
    const p = players[target.id];
    if (!p) return message.reply("❌ 플레이어 정보 없음");
    await message.reply(`📊 **${p.name}**\n💎 ${p.crystals} | XP ${p.xp} | LV.${getLevel(p.xp)}\n🎭 활성: ${CHARACTERS[p.active].name}\n🐾 코가네: ${p.kogane || "없음"}\n👹 손가락: ${p.sukunaFingers || 0}\n⭐ 주력: ${p.mainSkill || "기본"}\n🎯 도전과제 보너스: +${getMainSkillBonus(p)}%`);
  }
});

// ════════════════════════════════════════════════════════════════════════════════
// ── 봇 로그인
// ════════════════════════════════════════════════════════════════════════════════
client.login(TOKEN);
npm install discord.js pg dotenv express canvas gifencoder
