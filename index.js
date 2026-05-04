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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      user_id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log("✅ PostgreSQL 테이블 준비 완료");
}

async function dbLoad() {
  const res = await pool.query("SELECT user_id, data FROM players");
  const obj = {};
  for (const row of res.rows) obj[row.user_id] = row.data;
  console.log(`✅ DB 로드: ${res.rows.length}명`);
  return obj;
}

const saveQueue   = new Map();
const savePending = new Set();

async function dbSave(userId, data) {
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
      catch(e) { console.error(`주기저장 오류 [${uid}]:`, e.message); }
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
  poison: { id: "poison", name: "독",   emoji: "☠️", desc: "매 턴 최대HP의 5% 피해", duration: 3 },
  burn:   { id: "burn",   name: "화상", emoji: "🔥", desc: "매 턴 최대HP의 8% 피해", duration: 2 },
  freeze: { id: "freeze", name: "빙결", emoji: "❄️", desc: "1턴 행동 불가",           duration: 1 },
  weaken: { id: "weaken", name: "약화", emoji: "💔", desc: "공격력 30% 감소",         duration: 2 },
  stun:   { id: "stun",   name: "기절", emoji: "⚡", desc: "1턴 행동 불가",           duration: 1 },
  battleInstinct: { id: "battleInstinct", name: "전투본능", emoji: "🔥💪", desc: "공격력 40% 증가, 회피율 25% 증가", duration: 3 },
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
    se.turns--;
    if (se.turns <= 0) expired.push(se.id);
  }
  target.statusEffects = target.statusEffects.filter(s => s.turns > 0);
  if (totalDmg > 0) target.hp = Math.max(0, target.hp - totalDmg);
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
  return mult;
}
function getBattleInstinctEvade(se) { return !!(se && se.some(s => s.id === "battleInstinct")); }

function rollHit(defenderStatusEffects) {
  const baseEvade = 0.05;
  const instinctBonus = getBattleInstinctEvade(defenderStatusEffects) ? 0.25 : 0;
  return Math.random() > (baseEvade + instinctBonus);
}

// ════════════════════════════════════════════════════════
// ── 스쿠나 손가락 시스템
// ════════════════════════════════════════════════════════
const SUKUNA_FINGER_MAX = 20;
function getFingerBonus(fingers) {
  return {
    atkBonus:  Math.floor(fingers * 10),
    defBonus:  Math.floor(fingers * 6),
    hpBonus:   fingers * 200,
    label: fingers >= 20 ? "🔴 스쿠나 완전 각성" :
           fingers >= 15 ? "🔴 스쿠나 각성 Lv.4" :
           fingers >= 10 ? "🟠 스쿠나 각성 Lv.3" :
           fingers >= 5  ? "🟡 스쿠나 각성 Lv.2" :
           fingers >= 1  ? "🟢 스쿠나 각성 Lv.1" : "스쿠나 봉인 중",
  };
}

// ════════════════════════════════════════════════════════
// ── 코가네(황금 개) 펫 시스템
// ════════════════════════════════════════════════════════
const KOGANE_GRADES = {
  "전설": { color: 0xF5C842, emoji: "🌟", stars: "★★★★★", rate: 0.5,
    atkBonus: 0.25, defBonus: 0.20, hpBonus: 0.20, xpBonus: 0.30, crystalBonus: 0.25,
    skill: "황금 포효", skillDesc: "전투 시작 시 적에게 추가 피해 (ATK의 50%)", skillChance: 0.35,
    passiveDesc: "ATK+25% DEF+20% HP+20% XP+30% 크리스탈+25%",
  },
  "특급": { color: 0xff8c00, emoji: "🔶", stars: "★★★★☆", rate: 2.0,
    atkBonus: 0.18, defBonus: 0.15, hpBonus: 0.15, xpBonus: 0.20, crystalBonus: 0.18,
    skill: "황금 이빨", skillDesc: "공격 시 15% 확률로 약화 부여", skillChance: 0.15,
    passiveDesc: "ATK+18% DEF+15% HP+15% XP+20% 크리스탈+18%",
  },
  "1급": { color: 0x7C5CFC, emoji: "🔷", stars: "★★★☆☆", rate: 8.0,
    atkBonus: 0.12, defBonus: 0.10, hpBonus: 0.10, xpBonus: 0.12, crystalBonus: 0.10,
    skill: "황금 발톱", skillDesc: "공격 시 10% 확률로 추가타 (ATK의 30%)", skillChance: 0.10,
    passiveDesc: "ATK+12% DEF+10% HP+10% XP+12% 크리스탈+10%",
  },
  "2급": { color: 0x4ade80, emoji: "🟢", stars: "★★☆☆☆", rate: 22.5,
    atkBonus: 0.07, defBonus: 0.06, hpBonus: 0.06, xpBonus: 0.07, crystalBonus: 0.06,
    skill: "황금 보호막", skillDesc: "HP 30% 이하 시 1회 피해 50% 감소", skillChance: 1.0,
    passiveDesc: "ATK+7% DEF+6% HP+6% XP+7% 크리스탈+6%",
  },
  "3급": { color: 0x94a3b8, emoji: "⚪", stars: "★☆☆☆☆", rate: 67.0,
    atkBonus: 0.03, defBonus: 0.02, hpBonus: 0.02, xpBonus: 0.03, crystalBonus: 0.02,
    skill: "황금 냄새", skillDesc: "전투 후 크리스탈 +5% 추가 획득", skillChance: 1.0,
    passiveDesc: "ATK+3% DEF+2% HP+2% XP+3% 크리스탈+2%",
  },
};

const KOGANE_POOL = [
  { grade: "전설", rate: 0.5 },
  { grade: "특급", rate: 2.0 },
  { grade: "1급",  rate: 8.0 },
  { grade: "2급",  rate: 22.5 },
  { grade: "3급",  rate: 67.0 },
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
    hp:  1 + g.hpBonus,
    xp:  1 + g.xpBonus,
    crystal: 1 + g.crystalBonus,
  };
}

// ════════════════════════════════════════════════════════
// ── 스킬 이펙트 아트
// ════════════════════════════════════════════════════════
const SKILL_EFFECTS = {
  "주먹질":          { art: "```\n  💥  \n ▓▓▓▓▓\n  💥  \n```", color: 0xff6b35, flavorText: "저주 에너지를 주먹에 집중시킨다!" },
  "다이버전트 주먹": { art: "```\n ⚡💥⚡\n▓▓▓▓▓▓▓\n ⚡💥⚡\n```", color: 0xff4500, flavorText: "발산하는 저주 에너지 — 몸의 내부에서 폭발!" },
  "흑섬":            { art: "```\n🌑🌑🌑🌑🌑\n⬛ 黑 閃 ⬛\n🌑🌑🌑🌑🌑\n```", color: 0x1a0a2e, flavorText: "순간적으로 발산되는 최대 저주 에너지!" },
  "어주자":          { art: "```\n👹✨👹✨👹\n✨ 廻 夏 ✨\n👹✨👹✨👹\n```", color: 0xb5451b, flavorText: "스쿠나의 힘이 몸을 가득 채운다..." },
  "스쿠나 발현":     { art: "```\n🔴👹🔴👹🔴\n👹 両 面 宿 儺 👹\n🔴👹🔴👹🔴\n```", color: 0x8b0000, flavorText: "저주의 왕이 이타도리의 몸을 장악한다!" },
  "아오":            { art: "```\n  🔵🔵🔵  \n🔵  蒼  🔵\n  🔵🔵🔵  \n```", color: 0x0066ff, flavorText: "무한에 의한 인력 — 모든 것을 끌어당긴다" },
  "아카":            { art: "```\n  🔴🔴🔴  \n🔴  赫  🔴\n  🔴🔴🔴  \n```", color: 0xff0033, flavorText: "무한에 의한 척력 — 모든 것을 날려버린다" },
  "무라사키":        { art: "```\n🔴⚡🔵⚡🔴\n⚡  紫  ⚡\n🔵⚡🔴⚡🔵\n```", color: 0x9900ff, flavorText: "아오와 아카의 융합 — 허공을 찢는 허수!" },
  "무량공처":        { art: "```\n∞∞∞∞∞∞∞∞∞\n∞ 無 量 空 処 ∞\n∞∞∞∞∞∞∞∞∞\n```", color: 0x00ffff, flavorText: "\"나는 최강이니까\" — 무한이 세계를 지배한다" },
  "옥견":            { art: "```\n  🐕🐕🐕  \n🐕  玉  🐕\n  🐕🐕🐕  \n```", color: 0x4a4a8a, flavorText: "식신 옥견 소환!" },
  "탈토":            { art: "```\n  🐯🐯🐯  \n🐯  脱  🐯\n  🐯🐯🐯  \n```", color: 0xff8800, flavorText: "식신 대호 소환 — 강력한 발톱이 적을 찢는다!" },
  "만상":            { art: "```\n🌑🐕🌑🐯🌑\n🐯 萬 象 🐕\n🌑🐯🌑🐕🌑\n```", color: 0x2d1b69, flavorText: "열 가지 식신이 일제히 소환된다!" },
  "후루베 유라유라": { art: "```\n💀✨💀✨💀\n✨ 振 魂 ✨\n💀✨💀✨💀\n```", color: 0x8b0000, flavorText: "마허라가라 강림 — 최강의 식신이 깨어난다!" },
  "망치질":          { art: "```\n  🔨🔨🔨  \n⚡  釘  ⚡\n  🔨🔨🔨  \n```", color: 0xff69b4, flavorText: "저주 못을 적의 영혼에 박아넣는다!" },
  "공명":            { art: "```\n🌸💥🌸💥🌸\n💥 共 鳴 💥\n🌸💥🌸💥🌸\n```", color: 0xff1493, flavorText: "허수아비를 통한 공명 피해 — 영혼이 직접 타격된다!" },
  "철정":            { art: "```\n⚡🔨⚡🔨⚡\n🔨 鉄 釘 🔨\n⚡🔨⚡🔨⚡\n```", color: 0xdc143c, flavorText: "저주 에너지 주입 — 못이 몸 속에서 폭발한다!" },
  "발화":            { art: "```\n🔥🌸🔥🌸🔥\n🌸 発 火 🌸\n🔥🌸🔥🌸🔥\n```", color: 0xff4500, flavorText: "모든 못에 동시 폭발 공명 — 영혼이 불타오른다!" },
  "해":              { art: "```\n  ✂️✂️✂️  \n✂️  解  ✂️\n  ✂️✂️✂️  \n```", color: 0xcc0000, flavorText: "만물을 베어내는 저주의 왕의 손톱!" },
  "팔":              { art: "```\n🌌✂️🌌✂️🌌\n✂️  捌  ✂️\n🌌✂️🌌✂️🌌\n```", color: 0x8b0000, flavorText: "공간 자체를 베어내는 절대적 술식!" },
  "푸가":            { art: "```\n💀🔥💀🔥💀\n🔥 不 雅 🔥\n💀🔥💀🔥💀\n```", color: 0x4a0000, flavorText: "닿는 모든 것을 분해한다 — 저주의 왕의 진면목!" },
  "복마어주자":      { art: "```\n👑🌑👑🌑👑\n🌑伏魔御廚子🌑\n👑🌑👑🌑👑\n```", color: 0x2a0000, flavorText: "천지개벽 — 저주의 왕의 궁극 영역전개!" },
  "모방술식":        { art: "```\n  🌟🌟🌟  \n🌟  模  🌟\n  🌟🌟🌟  \n```", color: 0xffd700, flavorText: "타인의 술식을 완벽하게 복사한다!" },
  "리카 소환":       { art: "```\n💜👸💜👸💜\n👸  里  香  👸\n💜👸💜👸💜\n```", color: 0x9400d3, flavorText: "저주의 여왕 리카 소환 — 최강의 저주된 영혼!" },
  "순애빔":          { art: "```\n💜💛💜💛💜\n💛 純 愛 砲 💛\n💜💛💜💛💜\n```", color: 0xff00ff, flavorText: "사랑의 에너지가 파괴적인 빔으로 변환된다!" },
  "진안상애":        { art: "```\n🌟💜🌟💜🌟\n💜真贋相愛💜\n🌟💜🌟💜🌟\n```", color: 0x6600cc, flavorText: "사랑과 저주의 경계가 무너진다 — 궁극의 영역!" },
  "부기우기":        { art: "```\n🎵💪🎵💪🎵\n💪 Boogie 💪\n🎵💪🎵💪🎵\n```", color: 0x1e90ff, flavorText: "\"댄스홀 가수!\" — 보조공격술 위치 전환! 빙결의 한기!" },
  "브루탈 펀치":     { art: "```\n💥🔥💥🔥💥\n🔥BRUTAL🔥\n💥🔥💥🔥💥\n```", color: 0xff2200, flavorText: "최대 저주력을 실은 파괴적 일격!" },
  "전투본능":        { art: "```\n⚔️🔥⚔️🔥⚔️\n🔥戦闘本能🔥\n⚔️🔥⚔️🔥⚔️\n```", color: 0xff8c00, flavorText: "전사의 본능이 각성한다! 공격력·회피 극대화!" },
  "_default":        { art: "```\n  ✨✨✨  \n✨ 術 式 ✨\n  ✨✨✨  \n```", color: 0x7c5cfc, flavorText: "저주 에너지가 폭발한다!" },
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
      { name: "주먹질",         minMastery: 0,  dmg: 95,  desc: "강력한 기본 주먹 공격." },
      { name: "다이버전트 주먹", minMastery: 5,  dmg: 160, desc: "저주 에너지를 실은 주먹.", statusApply: { target: "enemy", statusId: "stun",   chance: 0.3 } },
      { name: "흑섬",           minMastery: 15, dmg: 240, desc: "최대 저주 에너지 방출!",   statusApply: { target: "enemy", statusId: "weaken", chance: 0.5 } },
      { name: "어주자",         minMastery: 30, dmg: 340, desc: "스쿠나의 힘을 빌린 궁극기.", statusApply: { target: "enemy", statusId: "burn",   chance: 0.7 } },
      { name: "스쿠나 발현",    minMastery: 50, dmg: 520, desc: "스쿠나가 몸을 장악! 10손가락 이상 필요.", statusApply: { target: "enemy", statusId: "freeze", chance: 0.8 } },
    ],
  },
  gojo: {
    name: "고조 사토루", emoji: "🔵", grade: "특급",
    atk: 130, def: 120, spd: 110, maxHp: 1800, domain: "무량공처",
    desc: "최강의 주술사. 무량공처를 구사한다.",
    lore: "\"사람들이 왜 내가 최강이라고 하는지 알아? 이 무한이 있어서야.\"",
    skills: [
      { name: "아오",     minMastery: 0,  dmg: 145, desc: "적들을 끌어당겨서 공격한다." },
      { name: "아카",     minMastery: 5,  dmg: 220, desc: "적들을 날려서 폭발시킨다.",     statusApply: { target: "enemy", statusId: "burn",   chance: 0.5 } },
      { name: "무라사키", minMastery: 15, dmg: 320, desc: "아오와 아카를 합쳐서 발사.",     statusApply: { target: "enemy", statusId: "weaken", chance: 0.6 } },
      { name: "무량공처", minMastery: 30, dmg: 480, desc: "무한을 지배하는 궁극술식.",      statusApply: { target: "enemy", statusId: "freeze", chance: 0.8 } },
    ],
  },
  megumi: {
    name: "후시구로 메구미", emoji: "⚫", grade: "1급",
    atk: 110, def: 108, spd: 100, maxHp: 1250, domain: "강압암예정",
    desc: "식신술을 구사하는 주술사.",
    lore: "\"나는 선한 사람을 구하기 위해 싸운다.\"",
    skills: [
      { name: "옥견",           minMastery: 0,  dmg: 115, desc: "식신 옥견을 소환한다." },
      { name: "탈토",           minMastery: 5,  dmg: 180, desc: "식신 대호를 소환한다.",     statusApply: { target: "enemy", statusId: "weaken", chance: 0.4 } },
      { name: "만상",           minMastery: 15, dmg: 265, desc: "열 가지 식신을 소환한다.",   statusApply: { target: "enemy", statusId: "poison", chance: 0.5 } },
      { name: "후루베 유라유라", minMastery: 30, dmg: 380, desc: "최강의 식신, 마허라가라 강림.", statusApply: { target: "enemy", statusId: "stun",   chance: 0.6 } },
    ],
  },
  nobara: {
    name: "쿠기사키 노바라", emoji: "🌸", grade: "1급",
    atk: 115, def: 95, spd: 105, maxHp: 1180, domain: null,
    desc: "망치를 이용해 영혼에 공격 가능한 주술사.",
    lore: "\"도쿄에 올 때부터 각오는 되어 있었어.\"",
    skills: [
      { name: "망치질", minMastery: 0,  dmg: 118, desc: "저주 못을 박는다." },
      { name: "공명",   minMastery: 5,  dmg: 195, desc: "허수아비를 통해 공명 피해.", statusApply: { target: "enemy", statusId: "poison", chance: 0.5 } },
      { name: "철정",   minMastery: 15, dmg: 280, desc: "저주 에너지 주입 못을 박는다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.5 } },
      { name: "발화",   minMastery: 30, dmg: 390, desc: "모든 못에 동시 폭발 공명.",  statusApply: { target: "enemy", statusId: "burn",   chance: 0.8 } },
    ],
  },
  nanami: {
    name: "나나미 켄토", emoji: "🟡", grade: "1급",
    atk: 118, def: 108, spd: 90, maxHp: 1380, domain: null,
    desc: "1급 주술사. 합리적 판단의 소유자.",
    lore: "\"초과 근무는 사절이지만... 이건 일이 아닌 의무다.\"",
    skills: [
      { name: "둔기 공격", minMastery: 0,  dmg: 120, desc: "단단한 둔기로 타격한다." },
      { name: "칠할삼분",  minMastery: 5,  dmg: 200, desc: "7:3 지점을 노린 약점 공격.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.6 } },
      { name: "십수할",    minMastery: 15, dmg: 290, desc: "열 배의 저주 에너지 방출." },
      { name: "초과근무",  minMastery: 30, dmg: 410, desc: "한계를 넘어선 폭발적 강화." },
    ],
  },
  sukuna: {
    name: "료멘 스쿠나", emoji: "🔴", grade: "특급",
    atk: 140, def: 115, spd: 120, maxHp: 2500, domain: "복마어주자",
    desc: "저주의 왕. 역대 최강의 저주된 영혼. [개발자 전용]",
    lore: "\"약한 놈이 강한 놈을 거스르는 건 죄악이다.\"",
    skills: [
      { name: "해",        minMastery: 0,  dmg: 145, desc: "날카로운 손톱으로 베어낸다.", statusApply: { target: "enemy", statusId: "burn",   chance: 0.4 } },
      { name: "팔",        minMastery: 5,  dmg: 235, desc: "공간 자체를 베어낸다.",       statusApply: { target: "enemy", statusId: "weaken", chance: 0.5 } },
      { name: "푸가",      minMastery: 15, dmg: 345, desc: "닿는 모든 것을 분해한다.",    statusApply: { target: "enemy", statusId: "poison", chance: 0.7 } },
      { name: "복마어주자", minMastery: 30, dmg: 500, desc: "천지개벽의 궁극 영역전개.",  statusApply: { target: "enemy", statusId: "freeze", chance: 0.9 } },
    ],
  },
  geto: {
    name: "게토 스구루", emoji: "🟢", grade: "특급",
    atk: 115, def: 105, spd: 100, maxHp: 1600, domain: null,
    desc: "전 특급 주술사. 저주를 다루는 달인.",
    lore: "\"주술사는 비주술사를 지켜야 한다 — 아니, 그래야만 했어.\"",
    skills: [
      { name: "저주 방출",  minMastery: 0,  dmg: 125, desc: "저급 저주령을 방출한다." },
      { name: "최대출력",   minMastery: 5,  dmg: 210, desc: "저주령을 전력으로 방출.",    statusApply: { target: "enemy", statusId: "poison", chance: 0.4 } },
      { name: "저주영조종", minMastery: 15, dmg: 300, desc: "수천의 저주령을 조종한다.",   statusApply: { target: "enemy", statusId: "weaken", chance: 0.6 } },
      { name: "감로대법",   minMastery: 30, dmg: 425, desc: "감로대법으로 모든 저주 흡수.", statusApply: { target: "enemy", statusId: "stun",   chance: 0.5 } },
    ],
  },
  maki: {
    name: "마키 젠인", emoji: "⚪", grade: "준1급",
    atk: 122, def: 110, spd: 115, maxHp: 1300, domain: null,
    desc: "저주력이 없어도 강한 주술사. HP 30% 이하 시 천여주박 각성!",
    lore: "\"젠인 가문 — 그 이름을 내가 직접 끝내주지.\"",
    awakening: { threshold: 0.30, dmgMult: 2.0, label: "천여주박 각성" },
    skills: [
      { name: "봉술",       minMastery: 0,  dmg: 122, desc: "저주 도구 봉으로 타격." },
      { name: "저주창",     minMastery: 5,  dmg: 200, desc: "저주 도구 창을 투척한다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.4 } },
      { name: "저주도구술", minMastery: 15, dmg: 285, desc: "다양한 저주 도구를 구사.",  statusApply: { target: "enemy", statusId: "burn",   chance: 0.5 } },
      { name: "천개봉파",   minMastery: 30, dmg: 400, desc: "수천의 저주 도구 연속 공격.", statusApply: { target: "enemy", statusId: "stun",  chance: 0.6 } },
    ],
  },
  panda: {
    name: "판다", emoji: "🐼", grade: "2급",
    atk: 105, def: 118, spd: 85, maxHp: 1400, domain: null,
    desc: "저주로 만든 특이체질의 주술사.",
    lore: "\"난 판다야. 진짜 판다.\"",
    skills: [
      { name: "박치기",     minMastery: 0,  dmg: 108, desc: "머리로 힘차게 들이받는다.", statusApply: { target: "enemy", statusId: "stun",   chance: 0.2 } },
      { name: "곰 발바닥",  minMastery: 5,  dmg: 175, desc: "두꺼운 발바닥으로 내리친다." },
      { name: "팬더 변신",  minMastery: 15, dmg: 255, desc: "진짜 팬더로 변신해 공격.",   statusApply: { target: "enemy", statusId: "weaken", chance: 0.4 } },
      { name: "고릴라 변신", minMastery: 30, dmg: 360, desc: "고릴라 형태로 폭발적 강화.", statusApply: { target: "enemy", statusId: "stun",  chance: 0.5 } },
    ],
  },
  inumaki: {
    name: "이누마키 토게", emoji: "🟤", grade: "준1급",
    atk: 112, def: 90, spd: 110, maxHp: 1120, domain: null,
    desc: "주술언어를 구사하는 준1급 주술사.",
    lore: "\"연어알— (그냥 따라가.)\"",
    skills: [
      { name: "멈춰라",   minMastery: 0,  dmg: 115, desc: "상대의 움직임을 봉쇄한다.", statusApply: { target: "enemy", statusId: "freeze", chance: 0.5 } },
      { name: "달려라",   minMastery: 5,  dmg: 180, desc: "상대를 무작위로 달리게 한다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.5 } },
      { name: "주술언어", minMastery: 15, dmg: 265, desc: "강력한 주술 명령을 내린다.", statusApply: { target: "enemy", statusId: "stun",   chance: 0.6 } },
      { name: "폭발해라", minMastery: 30, dmg: 375, desc: "상대를 그 자리에서 폭발시킨다.", statusApply: { target: "enemy", statusId: "burn", chance: 0.8 } },
    ],
  },
  yuta: {
    name: "오코츠 유타", emoji: "🌟", grade: "특급",
    atk: 128, def: 112, spd: 115, maxHp: 1750, domain: "진안상애",
    desc: "특급 주술사. 리카의 저주를 다루는 최강급 주술사.",
    lore: "\"리카... 나는 아직 살아야 해.\"",
    skills: [
      { name: "모방술식",  minMastery: 0,  dmg: 135, desc: "다른 술식을 모방해 공격한다." },
      { name: "리카 소환", minMastery: 5,  dmg: 220, desc: "저주의 여왕 리카를 소환한다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.5 } },
      { name: "순애빔",    minMastery: 15, dmg: 340, desc: "리카와의 순수한 사랑을 에너지로 발사.", statusApply: { target: "enemy", statusId: "burn", chance: 0.6 } },
      { name: "진안상애",  minMastery: 30, dmg: 480, desc: "영역전개로 모든 것을 사랑으로 파괴.", statusApply: { target: "enemy", statusId: "freeze", chance: 0.9 } },
    ],
  },
  higuruma: {
    name: "히구루마 히로미", emoji: "⚖️", grade: "1급",
    atk: 118, def: 105, spd: 95, maxHp: 1320, domain: "주복사사",
    desc: "전직 변호사 출신 주술사. 심판의 영역전개를 구사한다.",
    lore: "\"이 법정에서는 — 내가 판사다.\"",
    skills: [
      { name: "저주도구",    minMastery: 0,  dmg: 120, desc: "저주 에너지를 담은 도구로 공격." },
      { name: "몰수",        minMastery: 5,  dmg: 195, desc: "상대의 술식을 몰수한다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.7 } },
      { name: "사형판결",    minMastery: 15, dmg: 285, desc: "재판 결과에 따른 강력한 제재.", statusApply: { target: "enemy", statusId: "stun",   chance: 0.5 } },
      { name: "집행인 인형", minMastery: 30, dmg: 410, desc: "집행인 인형을 소환해 즉시 처형.", statusApply: { target: "enemy", statusId: "freeze", chance: 0.7 } },
    ],
  },
  jogo: {
    name: "죠고", emoji: "🌋", grade: "특급",
    atk: 125, def: 100, spd: 105, maxHp: 1680, domain: "개관철위산",
    desc: "화염을 다루는 준특급 저주령.",
    lore: "\"인간이야말로 진정한 저주다.\"",
    skills: [
      { name: "화염 분사", minMastery: 0,  dmg: 130, desc: "강렬한 불꽃을 내뿜는다.", statusApply: { target: "enemy", statusId: "burn",   chance: 0.5 } },
      { name: "용암 폭발", minMastery: 5,  dmg: 215, desc: "발밑의 용암을 폭발시킨다.", statusApply: { target: "enemy", statusId: "burn",   chance: 0.7 } },
      { name: "극번 운",   minMastery: 15, dmg: 315, desc: "하늘에서 불타는 운석을 소환한다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.5 } },
      { name: "개관철위산", minMastery: 30, dmg: 460, desc: "화산을 소환하는 궁극 영역전개.", statusApply: { target: "enemy", statusId: "burn",   chance: 1.0 } },
    ],
  },
  dagon: {
    name: "다곤", emoji: "🌊", grade: "특급",
    atk: 118, def: 108, spd: 96, maxHp: 1620, domain: "탕온평선",
    desc: "수중 저주령.",
    lore: "\"물은 모든 것을 삼킨다.\"",
    skills: [
      { name: "물고기 소환",   minMastery: 0,  dmg: 125, desc: "날카로운 물고기 떼를 소환한다.", statusApply: { target: "enemy", statusId: "poison", chance: 0.4 } },
      { name: "해수 폭발",     minMastery: 5,  dmg: 205, desc: "강력한 해수를 압축해 발사한다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.5 } },
      { name: "조류 소용돌이", minMastery: 15, dmg: 295, desc: "거대한 물의 소용돌이로 공격한다.", statusApply: { target: "enemy", statusId: "freeze", chance: 0.4 } },
      { name: "탕온평선",      minMastery: 30, dmg: 450, desc: "무수한 물고기로 가득 찬 영역전개.", statusApply: { target: "enemy", statusId: "poison", chance: 0.9 } },
    ],
  },
  hanami: {
    name: "하나미", emoji: "🌿", grade: "특급",
    atk: 115, def: 118, spd: 93, maxHp: 1750, domain: null,
    desc: "식물 저주령. 나무뿌리와 꽃을 이용한 자연 술식을 구사한다.",
    lore: "\"자연은 인간의 적이 아니다 — 다만 인간이 자연의 적일 뿐.\"",
    skills: [
      { name: "나무뿌리 채찍", minMastery: 0,  dmg: 122, desc: "나무뿌리를 채찍처럼 휘두른다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.3 } },
      { name: "꽃비",          minMastery: 5,  dmg: 198, desc: "독성 꽃가루를 비처럼 쏟아낸다.", statusApply: { target: "enemy", statusId: "poison", chance: 0.6 } },
      { name: "대지의 저주",   minMastery: 15, dmg: 285, desc: "대지 전체에 저주 에너지를 퍼뜨린다.", statusApply: { target: "enemy", statusId: "poison", chance: 0.7 } },
      { name: "재앙의 꽃",     minMastery: 30, dmg: 425, desc: "거대한 꽃을 소환해 모든 것을 흡수한다.", statusApply: { target: "enemy", statusId: "stun",  chance: 0.6 } },
    ],
  },
  mahito: {
    name: "마히토", emoji: "🩸", grade: "특급",
    atk: 120, def: 98, spd: 110, maxHp: 1560, domain: "자폐원돈과",
    desc: "영혼을 자유자재로 변형하는 준특급 저주령.",
    lore: "\"영혼이 육체를 만드는 거야. 반대가 아니라.\"",
    skills: [
      { name: "영혼 변형",  minMastery: 0,  dmg: 128, desc: "영혼을 변형해 직접 타격한다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.4 } },
      { name: "무위전변",   minMastery: 5,  dmg: 212, desc: "접촉한 신체를 기괴하게 변형한다.", statusApply: { target: "enemy", statusId: "stun",   chance: 0.4 } },
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
      { name: "부기우기",    minMastery: 0,  dmg: 130, desc: "보조공격술 — 위치 전환 + 빙결 40%.", statusApply: { target: "enemy", statusId: "freeze", chance: 0.40 } },
      { name: "브루탈 펀치", minMastery: 5,  dmg: 215, desc: "최대 저주력을 실은 파괴적 주먹.",     statusApply: { target: "enemy", statusId: "weaken", chance: 0.30 } },
      { name: "흑섬",        minMastery: 15, dmg: 320, desc: "이타도리에게 배운 흑섬 — 토도 특유 방식!", statusApply: { target: "enemy", statusId: "burn",   chance: 0.45 } },
      { name: "전투본능",    minMastery: 30, dmg: 200, desc: "자신에게 전투본능 버프! (ATK 40%↑, 회피 25%↑, 3턴) + 즉시 타격", statusApply: { target: "self", statusId: "battleInstinct", chance: 1.0 } },
    ],
  },
};

// ════════════════════════════════════════════════════════
// ── 적 데이터
// ════════════════════════════════════════════════════════
const ENEMIES = [
  { id: "e1", name: "저급 저주령",      emoji: "👹", hp: 550,   atk: 38,  def: 12, xp: 75,   crystals: 18,  masteryXp: 1,  fingers: 0, statusAttack: null },
  { id: "e2", name: "1급 저주령",       emoji: "👺", hp: 1100,  atk: 80,  def: 40, xp: 190,  crystals: 40,  masteryXp: 3,  fingers: 0, statusAttack: { statusId: "poison", chance: 0.3 } },
  { id: "e3", name: "특급 저주령",      emoji: "💀", hp: 2400,  atk: 128, def: 72, xp: 440,  crystals: 90,  masteryXp: 7,  fingers: 1, statusAttack: { statusId: "burn",   chance: 0.4 } },
  { id: "e4", name: "저주의 왕 (보스)", emoji: "👑", hp: 5500,  atk: 195, def: 110,xp: 1000, crystals: 200, masteryXp: 15, fingers: 3, statusAttack: { statusId: "weaken", chance: 0.5 } },
];

const JUJUTSU_ENEMIES = [
  { id: "j1", name: "약화된 저주령",   emoji: "💧", hp: 300,  atk: 25,  def: 8,  xp: 55,  crystals: 12,  masteryXp: 1,  points: 1, fingers: 0, statusAttack: null,                                desc: "⚡ 빠르지만 약함 (1포인트)" },
  { id: "j2", name: "중간급 저주령",   emoji: "🌀", hp: 620,  atk: 55,  def: 28, xp: 115, crystals: 28,  masteryXp: 2,  points: 1, fingers: 0, statusAttack: { statusId: "weaken", chance: 0.2 }, desc: "⚖️ 균형잡힌 몹 (1포인트)" },
  { id: "j3", name: "강화 저주령",     emoji: "🔥", hp: 450,  atk: 75,  def: 22, xp: 95,  crystals: 23,  masteryXp: 2,  points: 1, fingers: 0, statusAttack: { statusId: "burn",   chance: 0.35 }, desc: "💥 공격적이지만 방어 낮음 (1포인트)" },
  { id: "j4", name: "특수 저주령",     emoji: "☠️", hp: 960,  atk: 88,  def: 48, xp: 190, crystals: 45,  masteryXp: 4,  points: 2, fingers: 0, statusAttack: { statusId: "poison", chance: 0.4 }, desc: "🧪 독 공격! (2포인트)" },
  { id: "j5", name: "엘리트 저주령",   emoji: "💀", hp: 1380, atk: 108, def: 60, xp: 280, crystals: 70,  masteryXp: 6,  points: 3, fingers: 1, statusAttack: { statusId: "burn",   chance: 0.5 }, desc: "⚔️ 강력한 엘리트 (3포인트)" },
  { id: "j6", name: "사멸회유 수호자", emoji: "👹", hp: 2100, atk: 135, def: 82, xp: 440, crystals: 100, masteryXp: 10, points: 5, fingers: 2, statusAttack: { statusId: "weaken", chance: 0.6 }, desc: "🏆 최강 수호자 (5포인트)" },
];

// ════════════════════════════════════════════════════════
// ── 가챠 풀
// ════════════════════════════════════════════════════════
const GACHA_POOL = [
  { id: "gojo",     rate: 0.3  },
  { id: "yuta",     rate: 0.45 },
  { id: "geto",     rate: 0.9  },
  { id: "jogo",     rate: 0.6  },
  { id: "mahito",   rate: 0.6  },
  { id: "hanami",   rate: 0.7  },
  { id: "dagon",    rate: 0.7  },
  { id: "itadori",  rate: 2.5  },
  { id: "megumi",   rate: 6.0  },
  { id: "nanami",   rate: 6.0  },
  { id: "maki",     rate: 6.5  },
  { id: "nobara",   rate: 6.5  },
  { id: "higuruma", rate: 6.5  },
  { id: "todo",     rate: 5.0  },
  { id: "panda",    rate: 32.0 },
  { id: "inumaki",  rate: 23.75 },
];

const GACHA_RARITY = {
  "특급":  { stars: "★★★★★", color: 0xF5C842, effect: "✨🔱✨🔱✨", flash: "LEGENDARY" },
  "준특급":{ stars: "★★★★☆", color: 0xff8c00, effect: "💠💠💠💠💠", flash: "EPIC" },
  "1급":   { stars: "★★★☆☆", color: 0x7C5CFC, effect: "⭐⭐⭐⭐",    flash: "RARE" },
  "준1급": { stars: "★★★☆☆", color: 0x9b72cf, effect: "⭐⭐⭐",      flash: "RARE" },
  "2급":   { stars: "★★☆☆☆", color: 0x4ade80, effect: "🔹🔹🔹",    flash: "UNCOMMON" },
  "3급":   { stars: "★☆☆☆☆", color: 0x94a3b8, effect: "◽◽",        flash: "COMMON" },
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
const CODES = { "release": { crystals: 200 } };

// ════════════════════════════════════════════════════════
// ── 인메모리 세션
// ════════════════════════════════════════════════════════
let players       = {};
const battles       = {};
const cullings      = {};
const jujutsus      = {};
const parties       = {};
const partyInvites  = {};
const pvpSessions   = {};
const pvpChallenges = {};
let _partyIdSeq = 1;
let _pvpIdSeq   = 1;

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
    kogane: null, koganeGachaCount: 0,
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
  const kb = getKoganeBonus(player);
  if (player.active !== "itadori") return {
    atk:   Math.floor(ch.atk * kb.atk),
    def:   Math.floor(ch.def * kb.def),
    maxHp: Math.floor(ch.maxHp * kb.hp),
  };
  const bonus = getFingerBonus(player.sukunaFingers || 0);
  return {
    atk:   Math.floor((ch.atk + bonus.atkBonus) * kb.atk),
    def:   Math.floor((ch.def + bonus.defBonus) * kb.def),
    maxHp: Math.floor((ch.maxHp + bonus.hpBonus) * kb.hp),
  };
}

function masteryBar(mastery, charId) {
  const tiers = CHARACTERS[charId].skills.map(s => s.minMastery);
  const max   = tiers[tiers.length - 1];
  if (mastery >= max) return "`[MAX]` 모든 스킬 해금!";
  const next = tiers.find(t => t > mastery) || max;
  const prev = [...tiers].reverse().find(t => t <= mastery) || 0;
  const fill = Math.round(((mastery - prev) / (next - prev)) * 10);
  return "`" + "█".repeat(Math.max(0, fill)) + "░".repeat(Math.max(0, 10 - fill)) + "`" + ` ${mastery}/${next}`;
}

function getLevel(xp) { return Math.floor(xp / 200) + 1; }

function hpBar(cur, max, len = 10) {
  const pct  = Math.max(0, Math.min(1, cur / max));
  const fill = Math.round(pct * len);
  const color = pct > 0.5 ? "🟩" : pct > 0.25 ? "🟨" : "🟥";
  return color.repeat(Math.max(0, fill)) + "⬛".repeat(Math.max(0, len - fill));
}

function hpBarText(cur, max, len = 12) {
  const fill = Math.round((Math.max(0, cur) / max) * len);
  return "`" + "█".repeat(Math.max(0, fill)) + "░".repeat(Math.max(0, len - fill)) + "`";
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
  let mult = baseMult * getWeakenMult(player.statusEffects);
  if (isMakiAwakened(player)) mult *= CHARACTERS["maki"].awakening.dmgMult;
  return calcDmg(stats.atk, enemyDef, mult);
}

function calcSkillDmgForPlayer(player, baseSkillDmg) {
  let dmg = baseSkillDmg + Math.floor(Math.random() * 60);
  dmg = Math.floor(dmg * getWeakenMult(player.statusEffects));
  if (isMakiAwakened(player)) dmg = Math.floor(dmg * CHARACTERS["maki"].awakening.dmgMult);
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
  if (player.skillCooldown   > 0) player.skillCooldown--;
}

function parseSkillIndex(value) {
  const match = value.match(/_(\d+)$/);
  if (!match) return -1;
  return parseInt(match[1], 10);
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

// ── PvP 유틸 ──
function getPvpSessionByUser(userId) { return Object.values(pvpSessions).find(s => s.p1Id === userId || s.p2Id === userId) || null; }

function pvpOpponent(session, userId) {
  if (session.p1Id === userId) return { id: session.p2Id, hpKey: "hp2", statusKey: "status2", skillCdKey: "skillCd2", reverseCdKey: "reverseCd2", domainKey: "domainUsed2" };
  return { id: session.p1Id, hpKey: "hp1", statusKey: "status1", skillCdKey: "skillCd1", reverseCdKey: "reverseCd1", domainKey: "domainUsed1" };
}
function pvpSelf(session, userId) {
  if (session.p1Id === userId) return { id: session.p1Id, hpKey: "hp1", statusKey: "status1", skillCdKey: "skillCd1", reverseCdKey: "reverseCd1", domainKey: "domainUsed1" };
  return { id: session.p2Id, hpKey: "hp2", statusKey: "status2", skillCdKey: "skillCd2", reverseCdKey: "reverseCd2", domainKey: "domainUsed2" };
}

// ════════════════════════════════════════════════════════
// ── 컬링/사멸회유 유틸
// ════════════════════════════════════════════════════════
function getCullingPool(wave) {
  if (wave <= 3)  return ["e1","e1","e1","e2"];
  if (wave <= 7)  return ["e1","e2","e2","e2","e3"];
  if (wave <= 14) return ["e2","e2","e3","e3","e3"];
  return ["e2","e3","e3","e4","e4"];
}

function pickCullingEnemy(wave) {
  const pool  = getCullingPool(wave);
  const id    = pool[Math.floor(Math.random() * pool.length)];
  const base  = ENEMIES.find(e => e.id === id);
  const scale = 1 + (wave - 1) * 0.05;
  return {
    ...base,
    hp:            Math.floor(base.hp * scale),
    atk:           Math.floor(base.atk * scale),
    def:           Math.floor(base.def * scale),
    xp:            Math.floor(base.xp * scale),
    crystals:      Math.floor(base.crystals * scale),
    currentHp:     Math.floor(base.hp * scale),
    statusEffects: [],
  };
}

function generateJujutsuChoices(wave) {
  const pool = wave <= 3  ? ["j1","j1","j2","j3"]
             : wave <= 7  ? ["j2","j3","j3","j4"]
             : wave <= 12 ? ["j3","j4","j4","j5"]
             : ["j4","j5","j5","j6"];
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
    const base  = JUJUTSU_ENEMIES.find(e => e.id === id);
    const scale = 1 + (wave - 1) * 0.04;
    return { ...base, hp: Math.floor(base.hp * scale), atk: Math.floor(base.atk * scale), def: Math.floor(base.def * scale), xp: Math.floor(base.xp * scale), crystals: Math.floor(base.crystals * scale), statusEffects: [] };
  });
}

// ════════════════════════════════════════════════════════
// ── 임베드 함수들
// ════════════════════════════════════════════════════════
function profileEmbed(player) {
  const ch       = CHARACTERS[player.active];
  const stats    = getPlayerStats(player);
  const skill    = getCurrentSkill(player, player.active);
  const next     = getNextSkill(player, player.active);
  const mastery  = getMastery(player, player.active);
  const awakened = isMakiAwakened(player);
  const lv       = getLevel(player.xp);
  const hpPct    = Math.max(0, player.hp) / stats.maxHp;
  const xpNow    = player.xp % 200;
  const fingers  = player.sukunaFingers || 0;
  const fingerBonus = getFingerBonus(fingers);
  const kb       = getKoganeBonus(player);
  const kogane   = player.kogane;
  const kg       = kogane ? KOGANE_GRADES[kogane.grade] : null;
  const gradeInfo = GACHA_RARITY[ch.grade] || GACHA_RARITY["3급"];

  const HP_LEN = 18;
  const hpFill = Math.round(hpPct * HP_LEN);
  const hpColor = hpPct > 0.6 ? "🟢" : hpPct > 0.3 ? "🟡" : "🔴";
  const hpBarStr = `${hpColor} \`${"█".repeat(Math.max(0,hpFill))}${"░".repeat(Math.max(0,HP_LEN-hpFill))}\` **${Math.max(0,player.hp)}**/**${stats.maxHp}**`;

  const XP_LEN = 18;
  const xpFill = Math.round((xpNow / 200) * XP_LEN);
  const xpBarStr = `📊 \`${"▰".repeat(Math.max(0,xpFill))}${"▱".repeat(Math.max(0,XP_LEN-xpFill))}\` **${xpNow}**/200`;

  const themes = {
    "특급":  { top: "╔══════ 🔱 SPECIAL GRADE 🔱 ══════╗", mid: "╠════════════════════════════════╣", bot: "╚════════════════════════════════╝", badge: "[ L E G E N D A R Y ]" },
    "준특급":{ top: "╔══════ 💠 SEMI-SPECIAL 💠 ════════╗", mid: "╠════════════════════════════════╣", bot: "╚════════════════════════════════╝", badge: "[ E P I C ]" },
    "1급":   { top: "╔══════ ⭐ GRADE-1 ⭐ ══════════════╗", mid: "╠════════════════════════════════╣", bot: "╚════════════════════════════════╝", badge: "[ R A R E ]" },
    "준1급": { top: "╔══════ ⭐ SEMI GRADE-1 ⭐ ══════════╗", mid: "╠════════════════════════════════╣", bot: "╚════════════════════════════════╝", badge: "[ R A R E ]" },
    "2급":   { top: "╔══════ 🔹 GRADE-2 🔹 ══════════════╗", mid: "╠════════════════════════════════╣", bot: "╚════════════════════════════════╝", badge: "[ U N C O M M O N ]" },
    "3급":   { top: "╔══════ ◽ GRADE-3 ◽ ══════════════╗",  mid: "╠════════════════════════════════╣", bot: "╚════════════════════════════════╝", badge: "[ C O M M O N ]" },
  };
  const th = themes[ch.grade] || themes["3급"];

  const skillIcons = ["∞","↗","✳","⊕","⬡","◈"];
  const skillListLines = CHARACTERS[player.active].skills.map((s, idx) => {
    const unlocked = mastery >= s.minMastery;
    const isCurrent = skill.name === s.name;
    const fingerLock = s.name === "스쿠나 발현" && fingers < 10;
    const ok = unlocked && !fingerLock;
    const icon = ok ? skillIcons[idx] || "◆" : "🔒";
    const statusNote = s.statusApply ? ` [${STATUS_EFFECTS[s.statusApply.statusId]?.emoji}${Math.round(s.statusApply.chance*100)}%]` : "";
    const curMark = isCurrent ? " ◀ 현재" : "";
    return `> ${icon} **${s.name}**${statusNote}${curMark}\n> ⠀  *${s.desc}*`;
  }).join("\n");

  const awakeBanner = awakened ? `\n║  🔥 ≪ 천여주박 각성 ≫ — DMG×2  ║` : "";
  const cardBlock = [
    "```",
    th.top,
    `║  ${ch.emoji}  ${ch.name.padEnd(26)}  ║`,
    `║  ${gradeInfo.stars}  ${th.badge.padEnd(22)}  ║`,
    `║  ${(ch.lore || ch.desc).slice(0,34).padEnd(34)}  ║`,
    th.mid,
    `║  🗡 ATK ${String(stats.atk).padEnd(6)} 🛡 DEF ${String(stats.def).padEnd(6)} 💨 SPD ${String(ch.spd).padEnd(4)}  ║`,
    `║  🌌 영역: ${(ch.domain||"없음").padEnd(24)}  ║`,
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

  const embed = new EmbedBuilder()
    .setTitle(awakened
      ? `🔥 ≪ 천여주박 각성 ≫  ${player.name}의 카드`
      : `${gradeInfo.effect}  ${player.name}의 주술사 카드  ${gradeInfo.effect}`)
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
    .setFooter({ text: `!전투 !컬링 !사멸회유 !결투 !파티 !가챠 !코가네가챠 !출석 !손가락 | ${player.name}` })
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
  const stars = g.stars;
  return new EmbedBuilder()
    .setTitle(`${g.emoji} 코가네 — [${kogane.grade}] ${stars}`)
    .setColor(g.color)
    .setDescription([
      "```",
      `╔══════════════════════════════════╗`,
      `║  ${g.emoji}  코가네  [${kogane.grade}]  ${stars}  ║`,
      `║  황금 개 — 나의 충실한 파트너   ║`,
      `╚══════════════════════════════════╝`,
      "```",
      `> **패시브 보너스:** ${g.passiveDesc}`,
      `> **전투 스킬:** 🐾 **${g.skill}** — ${g.skillDesc}`,
      `> **발동 확률:** ${Math.round(g.skillChance * 100)}%`,
    ].join("\n"))
    .addFields(
      { name: "📊 스탯 보너스", value: `> 🗡️ ATK **+${Math.round(g.atkBonus*100)}%**\n> 🛡️ DEF **+${Math.round(g.defBonus*100)}%**\n> 💚 HP **+${Math.round(g.hpBonus*100)}%**`, inline: true },
      { name: "📈 보상 보너스", value: `> ⭐ XP **+${Math.round(g.xpBonus*100)}%**\n> 💎 크리스탈 **+${Math.round(g.crystalBonus*100)}%**`, inline: true },
      { name: "🎲 가챠 횟수", value: `> 총 **${player.koganeGachaCount || 0}**회 소환`, inline: true },
    )
    .setFooter({ text: "!코가네가챠 (200💎) — 더 좋은 등급 획득 시 자동 교체" });
}

function koganeGachaEmbed(grade, isUpgrade, player) {
  const g = KOGANE_GRADES[grade];
  const gradeOrder = ["3급","2급","1급","특급","전설"];
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
      !isUpgrade || !upgraded ? `\n> ⚠️ 기존 코가네보다 낮은 등급 — **교체되지 않았습니다.**\n> 💎 **+50** 보상 크리스탈 지급!` : "",
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
  const ch   = CHARACTERS[charId];
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
      `║  ${info.stars}  ${JJK_GRADE_LABEL[ch.grade].padEnd(20)}  ║`,
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
    const order = ["특급","준특급","1급","준1급","2급","3급","4급"];
    return order.indexOf(CHARACTERS[a].grade) - order.indexOf(CHARACTERS[b].grade);
  });
  const lines = sorted.map(id => {
    const ch = CHARACTERS[id];
    const info = GACHA_RARITY[ch.grade] || GACHA_RARITY["3급"];
    const isN  = newOnes.includes(id);
    return `${ch.emoji} ${info.stars} **${ch.name}** \`[${ch.grade}]\`${isN ? " **✨NEW!**" : ""}`;
  });
  const legendaries = results.filter(id => CHARACTERS[id].grade === "특급");
  return new EmbedBuilder()
    .setTitle(legendaries.length > 0 ? `🔱 ⚡⚡ 10연차 — 전설 등급 획득!! ⚡⚡ 🔱` : `🎲 10회 주술 소환 결과`)
    .setColor(legendaries.length > 0 ? 0xF5C842 : 0x7c5cfc)
    .setDescription(lines.join("\n"))
    .addFields(
      { name: "✨ 신규 획득", value: newOnes.length ? newOnes.map(id => `${CHARACTERS[id].emoji} ${CHARACTERS[id].name}`).join(", ") : "없음", inline: true },
      { name: "🔄 중복 보상", value: `**+${dupCrystals}** 💎`, inline: true },
      { name: "💎 잔여 크리스탈", value: `**${player.crystals}**`, inline: true },
    )
    .setFooter({ text: "!가챠 1회(150💎) | !가챠10 10회(1350💎) | 스쿠나는 가챠 풀에 없음" });
}

function skillEmbed(player) {
  const id       = player.active;
  const ch       = CHARACTERS[id];
  const mastery  = getMastery(player, id);
  const awakened = isMakiAwakened(player);
  const fingers  = player.sukunaFingers || 0;
  return new EmbedBuilder()
    .setTitle(`${ch.emoji} ≪ 술식 트리 ≫ ${ch.name}${awakened ? "  🔥[각성]" : ""}`)
    .setColor(awakened ? 0xFF2200 : JJK_GRADE_COLOR[ch.grade])
    .setDescription([
      `> ${ch.lore || ch.desc}`,
      `> 📈 **숙련도** ${masteryBar(mastery, id)}`,
      `> 🌌 **영역전개** \`${ch.domain || "없음"}\``,
      id === "itadori" ? `> 👹 **스쿠나 손가락** \`${fingers}/${SUKUNA_FINGER_MAX}\` — ${getFingerBonus(fingers).label}` : "",
      awakened ? `> 🔥 **천여주박 각성 중** — 모든 데미지 **2배**!` : "",
    ].filter(Boolean).join("\n"))
    .addFields(ch.skills.map((s, idx) => {
      const unlocked   = mastery >= s.minMastery;
      const fingerLock = s.name === "스쿠나 발현" && fingers < 10;
      const available  = unlocked && !fingerLock;
      const fx         = getSkillEffect(s.name);
      const statusNote = s.statusApply ? ` \`${STATUS_EFFECTS[s.statusApply.statusId]?.emoji}${STATUS_EFFECTS[s.statusApply.statusId]?.name} ${Math.round(s.statusApply.chance * 100)}%\`` : "";
      const dmgDisplay = awakened ? `~~${s.dmg}~~ → **${s.dmg * 2}**🔥` : `**${s.dmg}**`;
      const selfBuff   = s.statusApply?.target === "self" ? " 🔰자기버프" : "";
      return {
        name: `${available ? `✅ [${idx + 1}]` : "🔒"} ${s.name}  —  피해 ${dmgDisplay}${statusNote}${selfBuff}  *(숙련 ${s.minMastery} 필요)*`,
        value: [
          `> ${s.desc}`,
          available ? fx.art : `> ${!unlocked ? "🔒 숙련도 부족" : "👹 손가락 10개 이상 필요"}`,
          available ? `> *${fx.flavorText}*` : "",
        ].filter(Boolean).join("\n"),
        inline: false,
      };
    }))
    .setFooter({ text: "전투/컬링 승리 시 숙련도 상승! | 전투본능은 자기 버프 스킬" });
}

function skillActivationEmbed(player, skill, dmg, log, enemy, enemyHp, isOver, isWin) {
  const ch  = CHARACTERS[player.active];
  const fx  = getSkillEffect(skill.name);
  const stats = getPlayerStats(player);
  const awakened = isMakiAwakened(player);
  return new EmbedBuilder()
    .setTitle(`${ch.emoji} ≪ 술식 발동 ≫ ${skill.name}!`)
    .setColor(isOver ? (isWin ? 0xF5C842 : 0xe63946) : (fx.color || 0x7c5cfc))
    .setDescription([fx.art, `> *"${fx.flavorText}"*`, ``, ...log].join("\n"))
    .addFields(
      { name: `${ch.emoji} 나의 HP`, value: `${hpBar(player.hp, stats.maxHp)} \`${Math.max(0, player.hp)}/${stats.maxHp}\`${awakened ? " 🔥" : ""}`, inline: true },
      { name: `${enemy?.emoji || "👹"} 적 HP`, value: `${hpBar(enemyHp, enemy?.hp || 1)} \`${Math.max(0, enemyHp)}/${enemy?.hp || 0}\``, inline: true },
    )
    .setFooter({ text: isOver ? "전투 종료!" : `⚡술식: ${player.skillCooldown}턴 | ♻반전: ${player.reverseCooldown > 0 ? player.reverseCooldown + "턴" : "가능"}` });
}

function cullingEmbed(player, session, log = []) {
  const ch    = CHARACTERS[player.active];
  const stats = getPlayerStats(player);
  const enemy = session.currentEnemy;
  const awakened = isMakiAwakened(player);
  return new EmbedBuilder()
    .setTitle(`${awakened ? "🔥 " : ""}⚔️ 컬링 게임 — 🌊 WAVE ${session.wave}`)
    .setColor(awakened ? 0xFF2200 : session.wave >= 15 ? 0xF5C842 : session.wave >= 8 ? 0xe63946 : 0x7C5CFC)
    .setDescription(log.join("\n") || "⚔️ 새 파도가 밀려온다!")
    .addFields(
      { name: `${ch.emoji} 내 HP`, value: `${hpBar(player.hp, stats.maxHp)} \`${Math.max(0, player.hp)}/${stats.maxHp}\`${awakened ? " 🔥각성" : ""}\n상태: ${statusStr(player.statusEffects)}\n⚡술식: \`${player.skillCooldown > 0 ? player.skillCooldown + "턴" : "가능"}\` ♻반전: \`${player.reverseCooldown > 0 ? player.reverseCooldown + "턴" : "가능"}\``, inline: true },
      { name: `${enemy.emoji} ${enemy.name}`, value: `${hpBar(session.enemyHp, enemy.hp)} \`${Math.max(0, session.enemyHp)}/${enemy.hp}\`\n상태: ${statusStr(enemy.statusEffects)}`, inline: true },
      { name: "📊 현황", value: `WAVE **${session.wave}** | 처치 **${session.kills}** | **${session.totalXp}** XP / **${session.totalCrystals}**💎`, inline: false },
    )
    .setFooter({ text: `현재 스킬: ${getCurrentSkill(player, player.active).name} | 최고기록: WAVE ${player.cullingBest}` });
}

function jujutsuEmbed(player, session, log = [], choices = null) {
  const ch = CHARACTERS[player.active];
  const stats = getPlayerStats(player);
  const awakened = isMakiAwakened(player);
  const embed = new EmbedBuilder()
    .setTitle(`🎯 사멸회유 — WAVE ${session.wave} | 포인트 **${session.points}**/15`)
    .setColor(session.points >= 10 ? 0xF5C842 : session.points >= 5 ? 0xff8c00 : 0x7C5CFC)
    .setDescription(log.join("\n") || "🎯 사멸회유 진행 중! 몹을 선택해 처치하세요.")
    .addFields(
      { name: `${ch.emoji} 내 HP`, value: `${hpBar(player.hp, stats.maxHp)} \`${Math.max(0, player.hp)}/${stats.maxHp}\`${awakened ? " 🔥각성" : ""}\n상태: ${statusStr(player.statusEffects)}\n⚡술식: \`${player.skillCooldown > 0 ? player.skillCooldown + "턴" : "가능"}\` ♻반전: \`${player.reverseCooldown > 0 ? player.reverseCooldown + "턴" : "가능"}\``, inline: false },
      { name: "🎯 포인트", value: `${"🟦".repeat(Math.min(session.points, 15))}${"⬜".repeat(Math.max(0, 15 - session.points))} **${session.points}/15**\n**${session.totalXp}** XP / **${session.totalCrystals}**💎`, inline: false },
    );
  if (session.currentEnemy) {
    const enemy = session.currentEnemy;
    embed.addFields({ name: `${enemy.emoji} 현재 적: ${enemy.name}`, value: `${hpBar(session.enemyHp, enemy.hp)} \`${Math.max(0, session.enemyHp)}/${enemy.hp}\`\n상태: ${statusStr(enemy.statusEffects)}\n포인트: +${enemy.points}점`, inline: false });
  }
  if (choices) embed.addFields({ name: "⚔️ 다음 적 선택", value: choices.map((c, i) => `**[${i+1}]** ${c.emoji} ${c.name} — HP:\`${c.hp}\` ATK:\`${c.atk}\` | +${c.points}점\n└ ${c.desc}`).join("\n"), inline: false });
  embed.setFooter({ text: `최고기록: ${player.jujutsuBest}포인트 | 15포인트 달성 시 보너스!` });
  return embed;
}

function pvpEmbed(session, log = []) {
  const p1  = players[session.p1Id];
  const p2  = players[session.p2Id];
  const ch1 = CHARACTERS[p1.active];
  const ch2 = CHARACTERS[p2.active];
  const s1  = getPlayerStats(p1);
  const s2  = getPlayerStats(p2);
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
  const enemy = session.currentEnemy;
  const memberLines = party.members.map(uid => {
    const p = players[uid];
    if (!p) return `> ❓ 알 수 없음 (${uid})`;
    const ch = CHARACTERS[p.active];
    const stats = getPlayerStats(p);
    const awakened = isMakiAwakened(p);
    const isLeader = party.leader === uid;
    const hpPct = Math.max(0, p.hp) / stats.maxHp;
    const hpIcon = hpPct > 0.5 ? "🟢" : hpPct > 0.25 ? "🟡" : "🔴";
    return `> ${isLeader ? "👑" : "👤"} **${p.name}** ${ch.emoji} ${hpIcon} \`${Math.max(0,p.hp)}/${stats.maxHp}\`${awakened ? " 🔥" : ""} | ${statusStr(p.statusEffects)} | ⚡${p.skillCooldown > 0 ? p.skillCooldown+"턴" : "가능"}`;
  }).join("\n");

  return new EmbedBuilder()
    .setTitle(`⚔️ [파티] 컬링 게임 — 🌊 WAVE ${session.wave}`)
    .setColor(session.wave >= 15 ? 0xF5C842 : session.wave >= 8 ? 0xe63946 : 0x7C5CFC)
    .setDescription(log.join("\n") || "⚔️ 파티 컬링 게임 진행 중!")
    .addFields(
      { name: `👥 파티원 (${party.members.length}명)`, value: memberLines || "없음", inline: false },
      { name: `${enemy.emoji} ${enemy.name}`, value: `${hpBar(Math.max(0,session.enemyHp), enemy.hp)} \`${Math.max(0, session.enemyHp)}/${enemy.hp}\` (ATK ${enemy.atk})\n상태: ${statusStr(enemy.statusEffects || [])}`, inline: false },
      { name: "📊 현황", value: `WAVE **${session.wave}** | 처치 **${session.kills}** | **${session.totalXp}** XP / **${session.totalCrystals}**💎`, inline: false },
    )
    .setFooter({ text: "파티원 누구나 버튼을 눌러 행동할 수 있습니다! | 파티원 전원 사망 시 종료" });
}

// ════════════════════════════════════════════════════════
// ── 버튼 팩토리
// ════════════════════════════════════════════════════════
const mkBattleButtons = (player) => {
  const canSkill   = !player || player.skillCooldown <= 0;
  const canReverse = !player || player.reverseCooldown <= 0;
  const hasReverse = !player || REVERSE_CHARS.has(player.active);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("b_attack") .setLabel("⚔ 공격")    .setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("b_skill")  .setLabel(`🌀 술식${canSkill ? "" : `(${player?.skillCooldown}턴)`}`).setStyle(ButtonStyle.Primary).setDisabled(!canSkill),
    new ButtonBuilder().setCustomId("b_domain") .setLabel("🌌 영역전개").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("b_reverse").setLabel(`♻ 반전${canReverse ? "" : `(${player?.reverseCooldown}턴)`}`).setStyle(ButtonStyle.Secondary).setDisabled(!canReverse || !hasReverse),
    new ButtonBuilder().setCustomId("b_run")    .setLabel("🏃 도주")    .setStyle(ButtonStyle.Secondary),
  );
};

const mkCullingButtons = (player) => {
  const canSkill   = !player || player.skillCooldown <= 0;
  const canReverse = !player || player.reverseCooldown <= 0;
  const hasReverse = !player || REVERSE_CHARS.has(player.active);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("c_attack") .setLabel("⚔ 공격")    .setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("c_skill")  .setLabel(`🌀 술식${canSkill ? "" : `(${player?.skillCooldown}턴)`}`).setStyle(ButtonStyle.Primary).setDisabled(!canSkill),
    new ButtonBuilder().setCustomId("c_domain") .setLabel("🌌 영역전개").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("c_reverse").setLabel(`♻ 반전${canReverse ? "" : `(${player?.reverseCooldown}턴)`}`).setStyle(ButtonStyle.Secondary).setDisabled(!canReverse || !hasReverse),
    new ButtonBuilder().setCustomId("c_escape") .setLabel("🏳 철수")    .setStyle(ButtonStyle.Secondary),
  );
};

const mkJujutsuButtons = (player, choices) => {
  const row = new ActionRowBuilder();
  for (let i = 0; i < Math.min(choices.length, 3); i++) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`j_choice_${i}`)
        .setLabel(`⚔️ ${choices[i].name}`)
        .setStyle(ButtonStyle.Primary)
    );
  }
  const canSkill = !player || player.skillCooldown <= 0;
  const canReverse = !player || player.reverseCooldown <= 0;
  const hasReverse = !player || REVERSE_CHARS.has(player.active);
  return [
    row,
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("j_attack") .setLabel("⚔ 공격").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("j_skill")  .setLabel(`🌀 술식${canSkill ? "" : `(${player?.skillCooldown}턴)`}`).setStyle(ButtonStyle.Primary).setDisabled(!canSkill),
      new ButtonBuilder().setCustomId("j_domain") .setLabel("🌌 영역전개").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("j_reverse").setLabel(`♻ 반전${canReverse ? "" : `(${player?.reverseCooldown}턴)`}`).setStyle(ButtonStyle.Secondary).setDisabled(!canReverse || !hasReverse),
      new ButtonBuilder().setCustomId("j_escape") .setLabel("🏳 철수").setStyle(ButtonStyle.Secondary),
    )
  ];
};

const mkPvpButtons = (session, userId) => {
  const self = pvpSelf(session, userId);
  const canSkill = self.skillCdKey ? session[self.skillCdKey] <= 0 : true;
  const canReverse = self.reverseCdKey ? session[self.reverseCdKey] <= 0 : true;
  const player = players[userId];
  const hasReverse = REVERSE_CHARS.has(player?.active);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("p_attack") .setLabel("⚔ 공격").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("p_skill")  .setLabel(`🌀 술식${canSkill ? "" : "(\u2716)"}`).setStyle(ButtonStyle.Primary).setDisabled(!canSkill),
    new ButtonBuilder().setCustomId("p_domain") .setLabel("🌌 영역전개").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("p_reverse").setLabel(`♻ 반전${canReverse ? "" : "(\u2716)"}`).setStyle(ButtonStyle.Secondary).setDisabled(!canReverse || !hasReverse),
    new ButtonBuilder().setCustomId("p_surrender").setLabel("🏳 항복").setStyle(ButtonStyle.Secondary),
  );
};

// ════════════════════════════════════════════════════════
// ── 전투 핸들러 (일반 전투)
// ════════════════════════════════════════════════════════
async function handleBattleAction(interaction, player, battle, action) {
  // 일반 전투 로직 (원본에서 복사)
}

// ════════════════════════════════════════════════════════
// ── 컬링 핸들러
// ════════════════════════════════════════════════════════
async function handleCullingAction(interaction, player, culling, action) {
  // 컬링 전투 로직 (원본에서 복사)
}

// ════════════════════════════════════════════════════════
// ── 사멸회유 핸들러
// ════════════════════════════════════════════════════════
async function handleJujutsuAction(interaction, player, jujutsu, action) {
  // 사멸회유 전투 로직 (원본에서 복사)
}

// ════════════════════════════════════════════════════════
// ── PvP 핸들러
// ════════════════════════════════════════════════════════
async function handlePvpAction(interaction, player, session, action) {
  // PvP 전투 로직 (원본에서 복사)
}

// ════════════════════════════════════════════════════════
// ── 파티 컬링 핸들러
// ════════════════════════════════════════════════════════
async function handlePartyCullingAction(interaction, player, session, action) {
  // 파티 컬링 로직 (원본에서 복사)
}

// ════════════════════════════════════════════════════════
// ── 버튼 및 상호작용 핸들러
// ════════════════════════════════════════════════════════
client.once("ready", async () => {
  console.log(`✅ 로그인: ${client.user.tag}`);
  await dbInit();
  players = await dbLoad();
  console.log("🚀 주술회전 RPG 봇 활성화");
  
  // 슬래시 커맨드 등록
  const commands = [
    { name: "프로필", description: "내 프로필을 확인합니다" },
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
    { name: "코드", description: "쿠폰 코드를 사용합니다", options: [{ name: "코드", type: 3, description: "쿠폰 코드", required: true }] },
    { name: "도움말", description: "명령어 목록을 확인합니다" },
  ];
  
  if (isDev(client.user.id)) {
    commands.push(
      { name: "쿨다운초기화", description: "[개발자] 쿨다운을 초기화합니다" },
      { name: "아이템지급", description: "[개발자] 아이템을 지급합니다", options: [{ name: "아이템", type: 3, description: "아이템 종류", required: true }, { name: "수량", type: 4, description: "수량", required: false }] }
    );
  }
  
  await client.application.commands.set(commands);
  console.log("✅ 슬래시 커맨드 등록 완료");
});

client.on("interactionCreate", async (interaction) => {
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
    
    // 사멸회유 버튼
    if (customId.startsWith("j_")) {
      const jujutsu = jujutsus[userId];
      if (!jujutsu) return interaction.reply({ content: "🎯 진행 중인 사멸회유가 없습니다.", ephemeral: true });
      
      if (customId === "j_escape") {
        delete jujutsus[userId];
        await interaction.update({ content: "🏳 사멸회유를 종료했습니다.", embeds: [], components: [] });
        return;
      }
      
      if (customId === "j_attack" || customId === "j_skill" || customId === "j_domain" || customId === "j_reverse") {
        await handleJujutsuAction(interaction, player, jujutsu, customId);
        return;
      }
      
      if (customId.startsWith("j_choice_")) {
        const idx = parseInt(customId.split("_")[2]);
        if (jujutsu.choices && jujutsu.choices[idx]) {
          jujutsu.currentEnemy = JSON.parse(JSON.stringify(jujutsu.choices[idx]));
          jujutsu.enemyHp = jujutsu.currentEnemy.hp;
          jujutsu.choices = null;
          const embed = jujutsuEmbed(player, jujutsu);
          await interaction.update({ embeds: [embed], components: mkJujutsuButtons(player, [])[1] ? [mkJujutsuButtons(player, [])[1]] : [] });
        } else {
          await interaction.reply({ content: "❌ 잘못된 선택입니다.", ephemeral: true });
        }
        return;
      }
    }
    
    // 파티 초대 버튼
    if (customId.startsWith("party_invite_")) {
      const parts = customId.split("_");
      const partyId = parts[3];
      const targetId = parts[4];
      
      if (user.id !== targetId) return interaction.reply({ content: "❌ 이 초대는 당신을 위한 것이 아닙니다.", ephemeral: true });
      
      const invite = partyInvites[targetId];
      if (!invite || invite.partyId !== partyId) return interaction.reply({ content: "❌ 만료되었거나 유효하지 않은 초대입니다.", ephemeral: true });
      
      if (customId.includes("accept")) {
        const party = parties[partyId];
        if (!party) return interaction.reply({ content: "❌ 파티가 이미 해체되었습니다.", ephemeral: true });
        if (party.members.length >= 4) return interaction.reply({ content: "❌ 파티가 가득 찼습니다. (최대 4명)", ephemeral: true });
        if (getPartyId(targetId)) return interaction.reply({ content: "❌ 이미 다른 파티에 소속되어 있습니다.", ephemeral: true });
        
        party.members.push(targetId);
        delete partyInvites[targetId];
        
        await interaction.update({ content: `✅ 파티에 참가했습니다! (${party.members.length}/4)`, embeds: [], components: [] });
      } else if (customId.includes("decline")) {
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
        
        const embed = pvpEmbed(pvpSessions[sessionId]);
        const buttons = mkPvpButtons(pvpSessions[sessionId], challengerId);
        await interaction.update({ embeds: [embed], components: [buttons] });
      } else if (action === "decline") {
        delete pvpChallenges[challengerId];
        await interaction.update({ content: `❌ 상대방이 결투를 거절했습니다.`, embeds: [], components: [] });
      }
      return;
    }
    
    // PvP 전투 버튼
    if (customId.startsWith("p_")) {
      const session = getPvpSessionByUser(userId);
      if (!session) return interaction.reply({ content: "⚔️ 진행 중인 PvP가 없습니다.", ephemeral: true });
      if (session.turn !== userId) return interaction.reply({ content: "⏳ 지금은 당신의 턴이 아닙니다!", ephemeral: true });
      await handlePvpAction(interaction, player, session, customId);
      return;
    }
    
    // 파티 컬링 버튼
    if (customId.startsWith("pc_")) {
      const party = getParty(userId);
      if (!party) return interaction.reply({ content: "👥 파티에 소속되어 있지 않습니다.", ephemeral: true });
      const session = cullings[party.id];
      if (!session) return interaction.reply({ content: "🌊 진행 중인 파티 컬링이 없습니다.", ephemeral: true });
      if (players[userId].hp <= 0) return interaction.reply({ content: "💀 당신은 전투 불능 상태입니다!", ephemeral: true });
      await handlePartyCullingAction(interaction, player, session, customId);
      return;
    }
  }
  
  // 슬래시 커맨드 처리
  if (interaction.isChatInputCommand()) {
    const { commandName, user } = interaction;
    const userId = user.id;
    const player = getPlayer(userId, user.username);
    
    // 각 명령어 처리 (원본 참고)
    if (commandName === "프로필") {
      await interaction.reply({ embeds: [profileEmbed(player)] });
    } else if (commandName === "도움말") {
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
          "**🎲 시스템**",
          "`/프로필` - 내 정보",
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
    } else {
      await interaction.reply({ content: "⏳ 준비 중인 명령어입니다!", ephemeral: true });
    }
  }
});

client.login(TOKEN);
