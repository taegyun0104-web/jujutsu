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
});

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

async function dbSave(userId, data) {
  await pool.query(
    `INSERT INTO players(user_id, data, updated_at) VALUES($1,$2,NOW())
     ON CONFLICT(user_id) DO UPDATE SET data=$2, updated_at=NOW()`,
    [userId, JSON.stringify(data)]
  );
}

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

// ════════════════════════════════════════════════════════
// ── 개발자 ID
// ════════════════════════════════════════════════════════
const DEV_IDS = new Set(["1284771557633425470", "1397218266505678881"]);
const isDev = (id) => DEV_IDS.has(id);

// ════════════════════════════════════════════════════════
// ── 주술회전 등급 데이터
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

// ════════════════════════════════════════════════════════
// ── 상태이상
// ════════════════════════════════════════════════════════
const STATUS_EFFECTS = {
  poison: { id: "poison", name: "독",   emoji: "☠️", desc: "매 턴 최대HP의 5% 피해", duration: 3 },
  burn:   { id: "burn",   name: "화상", emoji: "🔥", desc: "매 턴 최대HP의 8% 피해", duration: 2 },
  freeze: { id: "freeze", name: "빙결", emoji: "❄️", desc: "1턴 행동 불가",           duration: 1 },
  weaken: { id: "weaken", name: "약화", emoji: "💔", desc: "공격력 30% 감소",         duration: 2 },
  stun:   { id: "stun",   name: "기절", emoji: "⚡", desc: "1턴 행동 불가",           duration: 1 },
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
function getWeakenMult(se)   { return (se && se.some(s => s.id === "weaken")) ? 0.7 : 1; }

// ════════════════════════════════════════════════════════
// ── 스킬 이펙트 아트 (ASCII/Emoji 아트)
// ════════════════════════════════════════════════════════
const SKILL_EFFECTS = {
  // 이타도리
  "주먹질":         { art: "```\n  💥  \n ▓▓▓▓▓\n  💥  \n```", color: 0xff6b35, flavorText: "저주 에너지를 주먹에 집중시킨다!" },
  "다이버전트 주먹":{ art: "```\n ⚡💥⚡\n▓▓▓▓▓▓▓\n ⚡💥⚡\n```", color: 0xff4500, flavorText: "발산하는 저주 에너지 — 몸의 내부에서 폭발!" },
  "흑섬":           { art: "```\n🌑🌑🌑🌑🌑\n⬛ 黑 閃 ⬛\n🌑🌑🌑🌑🌑\n```", color: 0x1a0a2e, flavorText: "순간적으로 발산되는 최대 저주 에너지!" },
  "어주자":         { art: "```\n👹✨👹✨👹\n✨ 廻 夏 ✨\n👹✨👹✨👹\n```", color: 0xb5451b, flavorText: "스쿠나의 힘이 몸을 가득 채운다..." },
  // 고조
  "아오":           { art: "```\n  🔵🔵🔵  \n🔵  蒼  🔵\n  🔵🔵🔵  \n```", color: 0x0066ff, flavorText: "무한에 의한 인력 — 모든 것을 끌어당긴다" },
  "아카":           { art: "```\n  🔴🔴🔴  \n🔴  赫  🔴\n  🔴🔴🔴  \n```", color: 0xff0033, flavorText: "무한에 의한 척력 — 모든 것을 날려버린다" },
  "무라사키":       { art: "```\n🔴⚡🔵⚡🔴\n⚡  紫  ⚡\n🔵⚡🔴⚡🔵\n```", color: 0x9900ff, flavorText: "아오와 아카의 융합 — 허공을 찢는 허수!" },
  "무량공처":       { art: "```\n∞∞∞∞∞∞∞∞∞\n∞ 無 量 空 処 ∞\n∞∞∞∞∞∞∞∞∞\n```", color: 0x00ffff, flavorText: "\"나는 최강이니까\" — 무한이 세계를 지배한다" },
  // 메구미
  "옥견":           { art: "```\n  🐕🐕🐕  \n🐕  玉  🐕\n  🐕🐕🐕  \n```", color: 0x4a4a8a, flavorText: "식신 옥견 소환!" },
  "탈토":           { art: "```\n  🐯🐯🐯  \n🐯  脱  🐯\n  🐯🐯🐯  \n```", color: 0xff8800, flavorText: "식신 대호 소환 — 강력한 발톱이 적을 찢는다!" },
  "만상":           { art: "```\n🌑🐕🌑🐯🌑\n🐯 萬 象 🐕\n🌑🐯🌑🐕🌑\n```", color: 0x2d1b69, flavorText: "열 가지 식신이 일제히 소환된다!" },
  "후루베 유라유라": { art: "```\n💀✨💀✨💀\n✨ 振 魂 ✨\n💀✨💀✨💀\n```", color: 0x8b0000, flavorText: "마허라가라 강림 — 최강의 식신이 깨어난다!" },
  // 노바라
  "망치질":         { art: "```\n  🔨🔨🔨  \n⚡  釘  ⚡\n  🔨🔨🔨  \n```", color: 0xff69b4, flavorText: "저주 못을 적의 영혼에 박아넣는다!" },
  "공명":           { art: "```\n🌸💥🌸💥🌸\n💥 共 鳴 💥\n🌸💥🌸💥🌸\n```", color: 0xff1493, flavorText: "허수아비를 통한 공명 피해 — 영혼이 직접 타격된다!" },
  "철정":           { art: "```\n⚡🔨⚡🔨⚡\n🔨 鉄 釘 🔨\n⚡🔨⚡🔨⚡\n```", color: 0xdc143c, flavorText: "저주 에너지 주입 — 못이 몸 속에서 폭발한다!" },
  "발화":           { art: "```\n🔥🌸🔥🌸🔥\n🌸 発 火 🌸\n🔥🌸🔥🌸🔥\n```", color: 0xff4500, flavorText: "모든 못에 동시 폭발 공명 — 영혼이 불타오른다!" },
  // 스쿠나
  "해":             { art: "```\n  ✂️✂️✂️  \n✂️  解  ✂️\n  ✂️✂️✂️  \n```", color: 0xcc0000, flavorText: "만물을 베어내는 저주의 왕의 손톱!" },
  "팔":             { art: "```\n🌌✂️🌌✂️🌌\n✂️  捌  ✂️\n🌌✂️🌌✂️🌌\n```", color: 0x8b0000, flavorText: "공간 자체를 베어내는 절대적 술식!" },
  "푸가":           { art: "```\n💀🔥💀🔥💀\n🔥 不 雅 🔥\n💀🔥💀🔥💀\n```", color: 0x4a0000, flavorText: "닿는 모든 것을 분해한다 — 저주의 왕의 진면목!" },
  "복마어주자":     { art: "```\n👑🌑👑🌑👑\n🌑 伏 魔 御 廚 子 🌑\n👑🌑👑🌑👑\n```", color: 0x2a0000, flavorText: "천지개벽 — 저주의 왕의 궁극 영역전개!" },
  // 유타
  "모방술식":       { art: "```\n  🌟🌟🌟  \n🌟  模  🌟\n  🌟🌟🌟  \n```", color: 0xffd700, flavorText: "타인의 술식을 완벽하게 복사한다!" },
  "리카 소환":      { art: "```\n💜👸💜👸💜\n👸  里  香  👸\n💜👸💜👸💜\n```", color: 0x9400d3, flavorText: "저주의 여왕 리카 소환 — 최강의 저주된 영혼!" },
  "순애빔":         { art: "```\n💜💛💜💛💜\n💛 純 愛 砲 💛\n💜💛💜💛💜\n```", color: 0xff00ff, flavorText: "사랑의 에너지가 파괴적인 빔으로 변환된다!" },
  "진안상애":       { art: "```\n🌟💜🌟💜🌟\n💜 真 贋 相 愛 💜\n🌟💜🌟💜🌟\n```", color: 0x6600cc, flavorText: "사랑과 저주의 경계가 무너진다 — 궁극의 영역!" },
  // 기본 폴백
  "_default":       { art: "```\n  ✨✨✨  \n✨ 術 式 ✨\n  ✨✨✨  \n```", color: 0x7c5cfc, flavorText: "저주 에너지가 폭발한다!" },
};

function getSkillEffect(skillName) {
  return SKILL_EFFECTS[skillName] || SKILL_EFFECTS["_default"];
}

// ════════════════════════════════════════════════════════
// ── 캐릭터 데이터
// ════════════════════════════════════════════════════════
const CHARACTERS = {
  itadori: {
    name: "이타도리 유지", emoji: "🟠", grade: "준1급",
    atk: 70, def: 60, spd: 75, maxHp: 900, domain: null,
    desc: "특급주술사 후보생. 아직 성장 중인 주술사.",
    lore: "\"남은 건 내가 어떻게 죽느냐다.\"",
    skills: [
      { name: "주먹질",         minMastery: 0,  dmg: 70,  desc: "강력한 기본 주먹 공격." },
      { name: "다이버전트 주먹", minMastery: 5,  dmg: 120, desc: "저주 에너지를 실은 주먹.", statusApply: { target: "enemy", statusId: "stun", chance: 0.3 } },
      { name: "흑섬",            minMastery: 15, dmg: 180, desc: "최대 저주 에너지 방출!", statusApply: { target: "enemy", statusId: "weaken", chance: 0.5 } },
      { name: "어주자",          minMastery: 30, dmg: 260, desc: "스쿠나의 힘을 빌린 궁극기.", statusApply: { target: "enemy", statusId: "burn", chance: 0.7 } },
    ],
  },
  gojo: {
    name: "고조 사토루", emoji: "🔵", grade: "특급",
    atk: 100, def: 95, spd: 100, maxHp: 1500, domain: "무량공처",
    desc: "최강의 주술사. 무량공처를 구사한다.",
    lore: "\"사람들이 왜 내가 최강이라고 하는지 알아? 이 무한이 있어서야.\"",
    skills: [
      { name: "아오",     minMastery: 0,  dmg: 110, desc: "적들을 끌어당겨서 공격한다." },
      { name: "아카",     minMastery: 5,  dmg: 170, desc: "적들을 날려서 폭발시킨다.", statusApply: { target: "enemy", statusId: "burn", chance: 0.5 } },
      { name: "무라사키", minMastery: 15, dmg: 250, desc: "아오와 아카를 합쳐서 발사.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.6 } },
      { name: "무량공처", minMastery: 30, dmg: 360, desc: "무한을 지배하는 궁극술식.", statusApply: { target: "enemy", statusId: "freeze", chance: 0.8 } },
    ],
  },
  megumi: {
    name: "후시구로 메구미", emoji: "⚫", grade: "1급",
    atk: 85, def: 88, spd: 82, maxHp: 1000, domain: "강압암예정",
    desc: "식신술을 구사하는 주술사.",
    lore: "\"나는 선한 사람을 구하기 위해 싸운다.\"",
    skills: [
      { name: "옥견",           minMastery: 0,  dmg: 85,  desc: "식신 옥견을 소환한다." },
      { name: "탈토",           minMastery: 5,  dmg: 140, desc: "식신 대호를 소환한다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.4 } },
      { name: "만상",           minMastery: 15, dmg: 200, desc: "열 가지 식신을 소환한다.", statusApply: { target: "enemy", statusId: "poison", chance: 0.5 } },
      { name: "후루베 유라유라", minMastery: 30, dmg: 290, desc: "최강의 식신, 마허라가라 강림.", statusApply: { target: "enemy", statusId: "stun", chance: 0.6 } },
    ],
  },
  nobara: {
    name: "쿠기사키 노바라", emoji: "🌸", grade: "1급",
    atk: 88, def: 75, spd: 85, maxHp: 950, domain: null,
    desc: "망치를 이용해 영혼에 공격 가능한 주술사.",
    lore: "\"도쿄에 올 때부터 각오는 되어 있었어.\"",
    skills: [
      { name: "망치질", minMastery: 0,  dmg: 88,  desc: "저주 못을 박는다." },
      { name: "공명",   minMastery: 5,  dmg: 150, desc: "허수아비를 통해 공명 피해.", statusApply: { target: "enemy", statusId: "poison", chance: 0.5 } },
      { name: "철정",   minMastery: 15, dmg: 210, desc: "저주 에너지 주입 못을 박는다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.5 } },
      { name: "발화",   minMastery: 30, dmg: 290, desc: "모든 못에 동시 폭발 공명.", statusApply: { target: "enemy", statusId: "burn", chance: 0.8 } },
    ],
  },
  nanami: {
    name: "나나미 켄토", emoji: "🟡", grade: "1급",
    atk: 90, def: 85, spd: 75, maxHp: 1100, domain: null,
    desc: "1급 주술사. 합리적 판단의 소유자.",
    lore: "\"초과 근무는 사절이지만... 이건 일이 아닌 의무다.\"",
    skills: [
      { name: "둔기 공격", minMastery: 0,  dmg: 90,  desc: "단단한 둔기로 타격한다." },
      { name: "칠할삼분",  minMastery: 5,  dmg: 155, desc: "7:3 지점을 노린 약점 공격.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.6 } },
      { name: "십수할",    minMastery: 15, dmg: 220, desc: "열 배의 저주 에너지 방출." },
      { name: "초과근무",  minMastery: 30, dmg: 310, desc: "한계를 넘어선 폭발적 강화." },
    ],
  },
  sukuna: {
    name: "료멘 스쿠나", emoji: "🔴", grade: "특급",
    atk: 100, def: 90, spd: 95, maxHp: 2000, domain: "복마어주자",
    desc: "저주의 왕. 역대 최강의 저주된 영혼.",
    lore: "\"약한 놈이 강한 놈을 거스르는 건 죄악이다.\"",
    skills: [
      { name: "해",         minMastery: 0,  dmg: 110, desc: "날카로운 손톱으로 베어낸다.", statusApply: { target: "enemy", statusId: "burn", chance: 0.4 } },
      { name: "팔",         minMastery: 5,  dmg: 180, desc: "공간 자체를 베어낸다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.5 } },
      { name: "푸가",       minMastery: 15, dmg: 260, desc: "닿는 모든 것을 분해한다.", statusApply: { target: "enemy", statusId: "poison", chance: 0.7 } },
      { name: "복마어주자", minMastery: 30, dmg: 380, desc: "천지개벽의 궁극 영역전개.", statusApply: { target: "enemy", statusId: "freeze", chance: 0.9 } },
    ],
  },
  geto: {
    name: "게토 스구루", emoji: "🟢", grade: "특급",
    atk: 88, def: 82, spd: 80, maxHp: 1300, domain: null,
    desc: "전 특급 주술사. 저주를 다루는 달인.",
    lore: "\"주술사는 비주술사를 지켜야 한다 — 아니, 그래야만 했어.\"",
    skills: [
      { name: "저주 방출",  minMastery: 0,  dmg: 95,  desc: "저급 저주령을 방출한다." },
      { name: "최대출력",   minMastery: 5,  dmg: 160, desc: "저주령을 전력으로 방출.", statusApply: { target: "enemy", statusId: "poison", chance: 0.4 } },
      { name: "저주영조종", minMastery: 15, dmg: 230, desc: "수천의 저주령을 조종한다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.6 } },
      { name: "감로대법",   minMastery: 30, dmg: 320, desc: "감로대법으로 모든 저주 흡수.", statusApply: { target: "enemy", statusId: "stun", chance: 0.5 } },
    ],
  },
  maki: {
    name: "마키 젠인", emoji: "⚪", grade: "준1급",
    atk: 92, def: 88, spd: 92, maxHp: 1050, domain: null,
    desc: "저주력이 없어도 강한 주술사. HP 30% 이하 시 천여주박 각성!",
    lore: "\"젠인 가문 — 그 이름을 내가 직접 끝내주지.\"",
    awakening: { threshold: 0.30, dmgMult: 2.0, label: "천여주박 각성" },
    skills: [
      { name: "봉술",       minMastery: 0,  dmg: 92,  desc: "저주 도구 봉으로 타격." },
      { name: "저주창",     minMastery: 5,  dmg: 155, desc: "저주 도구 창을 투척한다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.4 } },
      { name: "저주도구술", minMastery: 15, dmg: 215, desc: "다양한 저주 도구를 구사.", statusApply: { target: "enemy", statusId: "burn", chance: 0.5 } },
      { name: "천개봉파",   minMastery: 30, dmg: 300, desc: "수천의 저주 도구 연속 공격.", statusApply: { target: "enemy", statusId: "stun", chance: 0.6 } },
    ],
  },
  panda: {
    name: "판다", emoji: "🐼", grade: "2급",
    atk: 80, def: 90, spd: 70, maxHp: 1100, domain: null,
    desc: "저주로 만든 특이체질의 주술사.",
    lore: "\"난 판다야. 진짜 판다.\"",
    skills: [
      { name: "박치기",      minMastery: 0,  dmg: 80,  desc: "머리로 힘차게 들이받는다.", statusApply: { target: "enemy", statusId: "stun", chance: 0.2 } },
      { name: "곰 발바닥",   minMastery: 5,  dmg: 135, desc: "두꺼운 발바닥으로 내리친다." },
      { name: "팬더 변신",   minMastery: 15, dmg: 195, desc: "진짜 팬더로 변신해 공격.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.4 } },
      { name: "고릴라 변신", minMastery: 30, dmg: 270, desc: "고릴라 형태로 폭발적 강화.", statusApply: { target: "enemy", statusId: "stun", chance: 0.5 } },
    ],
  },
  inumaki: {
    name: "이누마키 토게", emoji: "🟤", grade: "준1급",
    atk: 85, def: 70, spd: 88, maxHp: 900, domain: null,
    desc: "주술언어를 구사하는 준1급 주술사.",
    lore: "\"연어알— (그냥 따라가.)\"",
    skills: [
      { name: "멈춰라",   minMastery: 0,  dmg: 85,  desc: "상대의 움직임을 봉쇄한다.", statusApply: { target: "enemy", statusId: "freeze", chance: 0.5 } },
      { name: "달려라",   minMastery: 5,  dmg: 140, desc: "상대를 무작위로 달리게 한다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.5 } },
      { name: "주술언어", minMastery: 15, dmg: 200, desc: "강력한 주술 명령을 내린다.", statusApply: { target: "enemy", statusId: "stun", chance: 0.6 } },
      { name: "폭발해라", minMastery: 30, dmg: 285, desc: "상대를 그 자리에서 폭발시킨다.", statusApply: { target: "enemy", statusId: "burn", chance: 0.8 } },
    ],
  },
  yuta: {
    name: "오코츠 유타", emoji: "🌟", grade: "특급",
    atk: 98, def: 88, spd: 92, maxHp: 1400, domain: "진안상애",
    desc: "특급 주술사. 리카의 저주를 다루는 최강급 주술사.",
    lore: "\"리카... 나는 아직 살아야 해.\"",
    skills: [
      { name: "모방술식",  minMastery: 0,  dmg: 105, desc: "다른 술식을 모방해 공격한다." },
      { name: "리카 소환", minMastery: 5,  dmg: 170, desc: "저주의 여왕 리카를 소환한다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.5 } },
      { name: "순애빔",    minMastery: 15, dmg: 260, desc: "리카와의 순수한 사랑을 에너지로 발사.", statusApply: { target: "enemy", statusId: "burn", chance: 0.6 } },
      { name: "진안상애",  minMastery: 30, dmg: 360, desc: "영역전개로 모든 것을 사랑으로 파괴.", statusApply: { target: "enemy", statusId: "freeze", chance: 0.9 } },
    ],
  },
  higuruma: {
    name: "히구루마 히로미", emoji: "⚖️", grade: "1급",
    atk: 90, def: 82, spd: 78, maxHp: 1050, domain: "주복사사",
    desc: "전직 변호사 출신 주술사. 심판의 영역전개를 구사한다.",
    lore: "\"이 법정에서는 — 내가 판사다.\"",
    skills: [
      { name: "저주도구",    minMastery: 0,  dmg: 90,  desc: "저주 에너지를 담은 도구로 공격." },
      { name: "몰수",        minMastery: 5,  dmg: 150, desc: "상대의 술식을 몰수한다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.7 } },
      { name: "사형판결",    minMastery: 15, dmg: 220, desc: "재판 결과에 따른 강력한 제재.", statusApply: { target: "enemy", statusId: "stun", chance: 0.5 } },
      { name: "집행인 인형", minMastery: 30, dmg: 310, desc: "집행인 인형을 소환해 즉시 처형.", statusApply: { target: "enemy", statusId: "freeze", chance: 0.7 } },
    ],
  },
  jogo: {
    name: "죠고", emoji: "🌋", grade: "특급",
    atk: 94, def: 80, spd: 85, maxHp: 1350, domain: "개관철위산",
    desc: "화염을 다루는 준특급 저주령.",
    lore: "\"인간이야말로 진정한 저주다.\"",
    skills: [
      { name: "화염 분사",   minMastery: 0,  dmg: 100, desc: "강렬한 불꽃을 내뿜는다.", statusApply: { target: "enemy", statusId: "burn", chance: 0.5 } },
      { name: "용암 폭발",   minMastery: 5,  dmg: 165, desc: "발밑의 용암을 폭발시킨다.", statusApply: { target: "enemy", statusId: "burn", chance: 0.7 } },
      { name: "극번 운",     minMastery: 15, dmg: 240, desc: "하늘에서 불타는 운석을 소환한다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.5 } },
      { name: "개관철위산",  minMastery: 30, dmg: 350, desc: "화산을 소환하는 궁극 영역전개.", statusApply: { target: "enemy", statusId: "burn", chance: 1.0 } },
    ],
  },
  dagon: {
    name: "다곤", emoji: "🌊", grade: "특급",
    atk: 90, def: 85, spd: 78, maxHp: 1300, domain: "탕온평선",
    desc: "수중 저주령.",
    lore: "\"물은 모든 것을 삼킨다.\"",
    skills: [
      { name: "물고기 소환",   minMastery: 0,  dmg: 95,  desc: "날카로운 물고기 떼를 소환한다.", statusApply: { target: "enemy", statusId: "poison", chance: 0.4 } },
      { name: "해수 폭발",     minMastery: 5,  dmg: 158, desc: "강력한 해수를 압축해 발사한다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.5 } },
      { name: "조류 소용돌이", minMastery: 15, dmg: 228, desc: "거대한 물의 소용돌이로 공격한다.", statusApply: { target: "enemy", statusId: "freeze", chance: 0.4 } },
      { name: "탕온평선",      minMastery: 30, dmg: 340, desc: "무수한 물고기로 가득 찬 영역전개.", statusApply: { target: "enemy", statusId: "poison", chance: 0.9 } },
    ],
  },
  hanami: {
    name: "하나미", emoji: "🌿", grade: "특급",
    atk: 88, def: 92, spd: 75, maxHp: 1400, domain: null,
    desc: "식물 저주령. 나무뿌리와 꽃을 이용한 자연 술식을 구사한다.",
    lore: "\"자연은 인간의 적이 아니다 — 다만 인간이 자연의 적일 뿐.\"",
    skills: [
      { name: "나무뿌리 채찍", minMastery: 0,  dmg: 93,  desc: "나무뿌리를 채찍처럼 휘두른다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.3 } },
      { name: "꽃비",          minMastery: 5,  dmg: 152, desc: "독성 꽃가루를 비처럼 쏟아낸다.", statusApply: { target: "enemy", statusId: "poison", chance: 0.6 } },
      { name: "대지의 저주",   minMastery: 15, dmg: 218, desc: "대지 전체에 저주 에너지를 퍼뜨린다.", statusApply: { target: "enemy", statusId: "poison", chance: 0.7 } },
      { name: "재앙의 꽃",     minMastery: 30, dmg: 320, desc: "거대한 꽃을 소환해 모든 것을 흡수한다.", statusApply: { target: "enemy", statusId: "stun", chance: 0.6 } },
    ],
  },
  mahito: {
    name: "마히토", emoji: "🩸", grade: "특급",
    atk: 92, def: 78, spd: 88, maxHp: 1250, domain: "자폐원돈과",
    desc: "영혼을 자유자재로 변형하는 준특급 저주령.",
    lore: "\"영혼이 육체를 만드는 거야. 반대가 아니라.\"",
    skills: [
      { name: "영혼 변형",   minMastery: 0,  dmg: 98,  desc: "영혼을 변형해 직접 타격한다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.4 } },
      { name: "무위전변",    minMastery: 5,  dmg: 162, desc: "접촉한 신체를 기괴하게 변형한다.", statusApply: { target: "enemy", statusId: "stun", chance: 0.4 } },
      { name: "편사지경체",  minMastery: 15, dmg: 235, desc: "신체를 무한히 변형해 공격한다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.6 } },
      { name: "자폐원돈과",  minMastery: 30, dmg: 345, desc: "영혼과 육체의 경계를 무너뜨리는 영역.", statusApply: { target: "enemy", statusId: "freeze", chance: 0.8 } },
    ],
  },
};

// ════════════════════════════════════════════════════════
// ── 적 / 컬링 / 사멸회유 데이터
// ════════════════════════════════════════════════════════
const ENEMIES = [
  { id: "e1", name: "저급 저주령",      emoji: "👹", hp: 400,  atk: 28,  def: 10, xp: 60,  crystals: 15,  masteryXp: 1,  statusAttack: null },
  { id: "e2", name: "1급 저주령",       emoji: "👺", hp: 800,  atk: 60,  def: 30, xp: 150, crystals: 30,  masteryXp: 3,  statusAttack: { statusId: "poison", chance: 0.3 } },
  { id: "e3", name: "특급 저주령",      emoji: "💀", hp: 1800, atk: 95,  def: 55, xp: 350, crystals: 70,  masteryXp: 7,  statusAttack: { statusId: "burn",   chance: 0.4 } },
  { id: "e4", name: "저주의 왕 (보스)", emoji: "👑", hp: 4000, atk: 140, def: 80, xp: 800, crystals: 150, masteryXp: 15, statusAttack: { statusId: "weaken", chance: 0.5 } },
];

const JUJUTSU_ENEMIES = [
  { id: "j1", name: "약화된 저주령",   emoji: "💧", hp: 200,  atk: 18,  def: 5,  xp: 40,  crystals: 10,  masteryXp: 1,  points: 1, statusAttack: null,                                        desc: "⚡ 빠르지만 약함 (1포인트)" },
  { id: "j2", name: "중간급 저주령",   emoji: "🌀", hp: 450,  atk: 40,  def: 20, xp: 90,  crystals: 22,  masteryXp: 2,  points: 1, statusAttack: { statusId: "weaken", chance: 0.2 },         desc: "⚖️ 균형잡힌 몹 (1포인트)" },
  { id: "j3", name: "강화 저주령",     emoji: "🔥", hp: 320,  atk: 55,  def: 15, xp: 75,  crystals: 18,  masteryXp: 2,  points: 1, statusAttack: { statusId: "burn",   chance: 0.35 },        desc: "💥 공격적이지만 방어 낮음 (1포인트)" },
  { id: "j4", name: "특수 저주령",     emoji: "☠️", hp: 700,  atk: 65,  def: 35, xp: 150, crystals: 35,  masteryXp: 4,  points: 2, statusAttack: { statusId: "poison", chance: 0.4 },         desc: "🧪 독 공격! (2포인트)" },
  { id: "j5", name: "엘리트 저주령",   emoji: "💀", hp: 1000, atk: 80,  def: 45, xp: 220, crystals: 55,  masteryXp: 6,  points: 3, statusAttack: { statusId: "burn",   chance: 0.5 },         desc: "⚔️ 강력한 엘리트 (3포인트)" },
  { id: "j6", name: "사멸회유 수호자", emoji: "👹", hp: 1500, atk: 100, def: 60, xp: 350, crystals: 80,  masteryXp: 10, points: 5, statusAttack: { statusId: "weaken", chance: 0.6 },         desc: "🏆 최강 수호자 (5포인트)" },
];

const GACHA_POOL = [
  { id: "gojo",    rate: 0.3  }, { id: "sukuna",  rate: 0.35 }, { id: "yuta",    rate: 0.45 },
  { id: "geto",    rate: 0.9  }, { id: "jogo",    rate: 0.6  }, { id: "mahito",  rate: 0.6  },
  { id: "hanami",  rate: 0.7  }, { id: "dagon",   rate: 0.7  }, { id: "itadori", rate: 2.0  },
  { id: "megumi",  rate: 5.0  }, { id: "nanami",  rate: 5.0  }, { id: "maki",    rate: 5.5  },
  { id: "nobara",  rate: 5.5  }, { id: "higuruma",rate: 5.5  }, { id: "panda",   rate: 35.0 },
  { id: "inumaki", rate: 32.4 },
];

function rollGacha(count = 1) {
  const total = GACHA_POOL.reduce((s, p) => s + p.rate, 0);
  return Array.from({ length: count }, () => {
    let roll = Math.random() * total;
    for (const e of GACHA_POOL) { roll -= e.rate; if (roll <= 0) return e.id; }
    return GACHA_POOL[GACHA_POOL.length - 1].id;
  });
}

const REVERSE_CHARS = new Set(["gojo", "sukuna", "yuta"]);
const CODES = { "release": { crystals: 200 } };

// ════════════════════════════════════════════════════════
// ── 인메모리 세션 (전투/PvP 등)
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
    };
    savePlayer(userId);
  }
  const p = players[userId];
  let changed = false;
  if (p.name !== username && username !== "플레이어") { p.name = username; changed = true; }
  const defaults = {
    reverseOutput: 1.0, reverseCooldown: 0, mastery: {}, cullingBest: 0,
    jujutsuBest: 0, usedCodes: [], lastDaily: 0, pvpWins: 0, pvpLosses: 0,
    statusEffects: [], skillCooldown: 0, dailyStreak: 0,
  };
  for (const [k, v] of Object.entries(defaults)) {
    if (p[k] === undefined) { p[k] = v; changed = true; }
  }
  if (changed) savePlayer(userId);
  return p;
}

async function savePlayer(userId) {
  if (!players[userId]) return;
  try { await dbSave(userId, players[userId]); } catch (e) { console.error("DB 저장 오류:", e.message); }
}

function savePlayerSync(userId) {
  savePlayer(userId).catch(e => console.error("savePlayer async err:", e.message));
}

function getMastery(player, charId) { return player.mastery?.[charId] || 0; }

function getAvailableSkills(player, charId) {
  const m = getMastery(player, charId);
  return CHARACTERS[charId].skills.filter(s => m >= s.minMastery);
}

function getCurrentSkill(player, charId) {
  const skills = getAvailableSkills(player, charId);
  return skills[skills.length - 1];
}

function getNextSkill(player, charId) {
  const m = getMastery(player, charId);
  return CHARACTERS[charId].skills.find(s => s.minMastery > m) || null;
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
  return player.hp <= Math.floor(CHARACTERS["maki"].maxHp * CHARACTERS["maki"].awakening.threshold);
}

function calcDmg(atk, def, mult = 1) {
  return Math.max(1, Math.floor((atk * (0.8 + Math.random() * 0.4) - def * 0.25) * mult));
}

function calcDmgForPlayer(player, enemyDef, baseMult = 1) {
  const ch = CHARACTERS[player.active];
  let mult = baseMult * getWeakenMult(player.statusEffects);
  if (isMakiAwakened(player)) mult *= CHARACTERS["maki"].awakening.dmgMult;
  return calcDmg(ch.atk, enemyDef, mult);
}

function calcSkillDmgForPlayer(player, baseSkillDmg) {
  let dmg = baseSkillDmg + Math.floor(Math.random() * 40);
  dmg = Math.floor(dmg * getWeakenMult(player.statusEffects));
  if (isMakiAwakened(player)) dmg = Math.floor(dmg * CHARACTERS["maki"].awakening.dmgMult);
  return dmg;
}

function applySkillStatus(skill, defenderObj) {
  if (!skill.statusApply) return [];
  const { target, statusId, chance } = skill.statusApply;
  if (Math.random() > chance) return [];
  const def = STATUS_EFFECTS[statusId];
  if (target === "enemy") {
    applyStatus(defenderObj, statusId);
    return [`${def.emoji} **${def.name}** 상태이상 적용! (${def.duration}턴)`];
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

function getPartyId(userId) { return Object.keys(parties).find(pid => parties[pid].members.includes(userId)) || null; }
function getParty(userId)   { const pid = getPartyId(userId); return pid ? parties[pid] : null; }
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
// ── 컬링 게임 유틸
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
// ── 고퀄 프로필 임베드
// ════════════════════════════════════════════════════════
function profileEmbed(player) {
  const ch      = CHARACTERS[player.active];
  const skill   = getCurrentSkill(player, player.active);
  const next    = getNextSkill(player, player.active);
  const mastery = getMastery(player, player.active);
  const awakened = isMakiAwakened(player);
  const lv      = getLevel(player.xp);
  const hpPct   = Math.floor((player.hp / ch.maxHp) * 100);
  const hpEmoji = hpPct > 60 ? "💚" : hpPct > 30 ? "💛" : "❤️";

  const gradeBar = "═".repeat(28);

  const embed = new EmbedBuilder()
    .setTitle(awakened
      ? `🔥 ≪ 천여주박 각성 ≫ ${player.name}의 주술사 카드 🔥`
      : `${JJK_GRADE_EMOJI[ch.grade]} ≪ 주술사 카드 ≫ ${player.name}`)
    .setColor(awakened ? 0xFF2200 : JJK_GRADE_COLOR[ch.grade])
    .setDescription([
      `╔${gradeBar}╗`,
      `║  ${ch.emoji} **${ch.name}**  ·  ${JJK_GRADE_EMOJI[ch.grade]} **${ch.grade}**  ║`,
      `╚${gradeBar}╝`,
      `> *${ch.lore || ch.desc}*`,
    ].join("\n"))
    .addFields(
      // Row 1 — 레벨/XP/크리스탈
      {
        name: "━━━ 🏅 주술사 정보 ━━━",
        value: [
          `> 🎖️ **레벨** \`LV.${lv}\`　　**XP** \`${player.xp}\``,
          `> 💎 **크리스탈** \`${player.crystals}\`　　🧪 **회복약** \`${player.potion}개\``,
          `> 🏆 **전투** \`${player.wins}승 ${player.losses}패\`　　⚔️ **PvP** \`${player.pvpWins}승 ${player.pvpLosses}패\``,
        ].join("\n"),
        inline: false,
      },
      // Row 2 — 스탯
      {
        name: "━━━ ⚔️ 전투 스탯 ━━━",
        value: [
          `> 🗡️ **공격력** \`${ch.atk}\`　　🛡️ **방어력** \`${ch.def}\`　　💨 **속도** \`${ch.spd}\``,
          `> ${hpEmoji} **체력** \`${Math.max(0, player.hp)} / ${ch.maxHp}\`  ${hpBar(player.hp, ch.maxHp)}`,
          `> 🌌 **영역전개** \`${ch.domain || "없음"}\``,
        ].join("\n"),
        inline: false,
      },
      // Row 3 — 스킬/숙련도
      {
        name: "━━━ 🌀 술식 & 숙련도 ━━━",
        value: [
          `> 🔥 **현재 술식** \`${skill.name}\` — ${skill.desc}`,
          `> 💥 **기본 피해** \`${skill.dmg}\`${awakened ? `  →  🔥각성 \`${skill.dmg * 2}\`` : ""}`,
          `> 📈 **숙련도** ${masteryBar(mastery, player.active)}`,
          `> ⬆️ **다음 스킬** \`${next ? `${next.name} (숙련도 ${next.minMastery})` : "MAX 달성!"}\``,
        ].join("\n"),
        inline: false,
      },
      // Row 4 — 상태
      {
        name: "━━━ 🩺 현재 상태 ━━━",
        value: [
          `> 🩸 **상태이상** ${statusStr(player.statusEffects)}`,
          `> ⚡ **술식 쿨다운** ${player.skillCooldown > 0 ? `\`${player.skillCooldown}턴\`` : "\`사용 가능\`"}`,
          `> ♻️ **반전술식** ${player.reverseCooldown > 0 ? `\`${player.reverseCooldown}턴\`` : "\`사용 가능\`"}`,
        ].join("\n"),
        inline: false,
      },
      // Row 5 — 기록
      {
        name: "━━━ 📊 기록 ━━━",
        value: [
          `> 🌊 **컬링 최고** \`WAVE ${player.cullingBest}\`　　🎯 **사멸회유 최고** \`${player.jujutsuBest}포인트\``,
        ].join("\n"),
        inline: false,
      },
      // Row 6 — 보유 캐릭터
      {
        name: "━━━ 📦 보유 캐릭터 ━━━",
        value: player.owned.map(id => {
          const c = CHARACTERS[id];
          const m = getMastery(player, id);
          const cur = getCurrentSkill(player, id);
          return `> ${id === player.active ? "▶️" : "　"} ${c.emoji} **${c.name}** \`${c.grade}\` — 숙련 \`${m}\` · 술식 \`${cur.name}\``;
        }).join("\n"),
        inline: false,
      },
    )
    .setFooter({ text: "⚡ !전투  🌊 !컬링  🎯 !사멸회유  ⚔️ !결투  👥 !파티  🎲 !가챠  📅 !출석" })
    .setTimestamp();

  if (awakened) {
    embed.addFields({ name: "🔥 ≪ 천여주박 각성 ≫", value: "> **HP 30% 이하 — 마키의 잠재력이 완전 해방!**\n> 모든 데미지 **2배** 증가!", inline: false });
  }

  return embed;
}

// ════════════════════════════════════════════════════════
// ── 스킬 임베드 (고퀄)
// ════════════════════════════════════════════════════════
function skillEmbed(player) {
  const id      = player.active;
  const ch      = CHARACTERS[id];
  const mastery = getMastery(player, id);
  const awakened = isMakiAwakened(player);

  return new EmbedBuilder()
    .setTitle(`${ch.emoji} ≪ 술식 트리 ≫ ${ch.name}${awakened ? "  🔥[각성]" : ""}`)
    .setColor(awakened ? 0xFF2200 : JJK_GRADE_COLOR[ch.grade])
    .setDescription([
      `> ${ch.lore || ch.desc}`,
      ``,
      `> 📈 **숙련도** ${masteryBar(mastery, id)}`,
      `> 🌌 **영역전개** \`${ch.domain || "없음"}\``,
      awakened ? `> 🔥 **천여주박 각성 중** — 모든 데미지 **2배**!` : "",
      ``,
      `🌀 **술식 시스템** — 해금된 스킬 중 자유 선택 · 사용 후 **5턴 쿨다운**`,
      `♻️ **반전술식** — 3턴마다 사용 가능 (고조 · 스쿠나 · 유타 전용)`,
    ].filter(Boolean).join("\n"))
    .addFields(ch.skills.map((s, idx) => {
      const unlocked   = mastery >= s.minMastery;
      const fx         = getSkillEffect(s.name);
      const statusNote = s.statusApply ? ` \`${STATUS_EFFECTS[s.statusApply.statusId]?.emoji}${STATUS_EFFECTS[s.statusApply.statusId]?.name} ${Math.round(s.statusApply.chance * 100)}%\`` : "";
      const dmgDisplay = awakened ? `~~${s.dmg}~~ → **${s.dmg * 2}**🔥` : `**${s.dmg}**`;
      return {
        name: `${unlocked ? `✅ [${idx + 1}]` : "🔒"} ${s.name}  —  피해 ${dmgDisplay}${statusNote}  *(숙련 ${s.minMastery} 필요)*`,
        value: [
          `> ${s.desc}`,
          unlocked ? fx.art : "> 🔒 *숙련도를 높여 해금하세요*",
          unlocked ? `> *${fx.flavorText}*` : "",
        ].filter(Boolean).join("\n"),
        inline: false,
      };
    }))
    .setFooter({ text: "전투/컬링 승리 시 숙련도 상승!" });
}

// ════════════════════════════════════════════════════════
// ── 술식 발동 임베드 (전투 중 인라인)
// ════════════════════════════════════════════════════════
function skillActivationEmbed(player, skill, dmg, log, enemy, enemyHp, isOver, isWin) {
  const ch  = CHARACTERS[player.active];
  const fx  = getSkillEffect(skill.name);
  const awakened = isMakiAwakened(player);
  return new EmbedBuilder()
    .setTitle(`${ch.emoji} ≪ 술식 발동 ≫ ${skill.name}!`)
    .setColor(isOver ? (isWin ? 0xF5C842 : 0xe63946) : (fx.color || 0x7c5cfc))
    .setDescription([
      fx.art,
      `> *"${fx.flavorText}"*`,
      ``,
      ...log,
    ].join("\n"))
    .addFields(
      { name: `${ch.emoji} 나의 HP`, value: `${hpBar(player.hp, ch.maxHp)} \`${Math.max(0, player.hp)}/${ch.maxHp}\`${awakened ? " 🔥" : ""}`, inline: true },
      { name: `${enemy?.emoji || "👹"} 적 HP`, value: `${hpBar(enemyHp, enemy?.hp || 1)} \`${Math.max(0, enemyHp)}/${enemy?.hp || 0}\``, inline: true },
    )
    .setFooter({ text: isOver ? "전투 종료!" : `⚡술식: ${player.skillCooldown}턴 쿨다운 | ♻반전: ${player.reverseCooldown > 0 ? player.reverseCooldown + "턴" : "가능"}` });
}

// ════════════════════════════════════════════════════════
// ── 전투 임베드들
// ════════════════════════════════════════════════════════
function cullingEmbed(player, session, log = []) {
  const ch    = CHARACTERS[player.active];
  const enemy = session.currentEnemy;
  const awakened = isMakiAwakened(player);
  return new EmbedBuilder()
    .setTitle(`${awakened ? "🔥 " : ""}⚔️ 컬링 게임 — 🌊 WAVE ${session.wave}`)
    .setColor(awakened ? 0xFF2200 : session.wave >= 15 ? 0xF5C842 : session.wave >= 8 ? 0xe63946 : 0x7C5CFC)
    .setDescription(log.join("\n") || "⚔️ 새 파도가 밀려온다!")
    .addFields(
      { name: `${ch.emoji} 내 HP`, value: `${hpBar(player.hp, ch.maxHp)} \`${Math.max(0, player.hp)}/${ch.maxHp}\`${awakened ? " 🔥각성" : ""}\n상태: ${statusStr(player.statusEffects)}\n⚡술식: \`${player.skillCooldown > 0 ? player.skillCooldown + "턴" : "가능"}\` ♻반전: \`${player.reverseCooldown > 0 ? player.reverseCooldown + "턴" : "가능"}\``, inline: true },
      { name: `${enemy.emoji} ${enemy.name}`, value: `${hpBar(session.enemyHp, enemy.hp)} \`${Math.max(0, session.enemyHp)}/${enemy.hp}\`\n상태: ${statusStr(enemy.statusEffects)}`, inline: true },
      { name: "📊 현황", value: `WAVE **${session.wave}** | 처치 **${session.kills}** | **${session.totalXp}** XP / **${session.totalCrystals}**💎`, inline: false },
    )
    .setFooter({ text: `현재 스킬: ${getCurrentSkill(player, player.active).name} | 최고기록: WAVE ${player.cullingBest}` });
}

function jujutsuEmbed(player, session, log = [], choices = null) {
  const ch = CHARACTERS[player.active];
  const awakened = isMakiAwakened(player);
  const embed = new EmbedBuilder()
    .setTitle(`🎯 사멸회유 — WAVE ${session.wave} | 포인트 **${session.points}**/15`)
    .setColor(session.points >= 10 ? 0xF5C842 : session.points >= 5 ? 0xff8c00 : 0x7C5CFC)
    .setDescription(log.join("\n") || "🎯 사멸회유 진행 중! 몹을 선택해 처치하세요.")
    .addFields(
      { name: `${ch.emoji} 내 HP`, value: `${hpBar(player.hp, ch.maxHp)} \`${Math.max(0, player.hp)}/${ch.maxHp}\`${awakened ? " 🔥각성" : ""}\n상태: ${statusStr(player.statusEffects)}\n⚡술식: \`${player.skillCooldown > 0 ? player.skillCooldown + "턴" : "가능"}\` ♻반전: \`${player.reverseCooldown > 0 ? player.reverseCooldown + "턴" : "가능"}\``, inline: false },
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
  const aw1 = isMakiAwakened(p1);
  const aw2 = isMakiAwakened(p2);
  const turnName = session.turn === session.p1Id ? p1.name : p2.name;
  return new EmbedBuilder()
    .setTitle(`⚔️ PvP 결투  ${p1.name} VS ${p2.name}`)
    .setColor(0xF5C842)
    .setDescription(log.join("\n") || "⚔️ 결투 시작!")
    .addFields(
      { name: `${ch1.emoji} ${p1.name} [${ch1.grade}]${aw1 ? " 🔥" : ""}`, value: `${hpBar(session.hp1, ch1.maxHp)} \`${Math.max(0, session.hp1)}/${ch1.maxHp}\`\n상태: ${statusStr(session.status1)}\n⚡술식: \`${session.skillCd1 > 0 ? session.skillCd1 + "턴" : "가능"}\` ♻반전: \`${session.reverseCd1 > 0 ? session.reverseCd1 + "턴" : "가능"}\``, inline: true },
      { name: `${ch2.emoji} ${p2.name} [${ch2.grade}]${aw2 ? " 🔥" : ""}`, value: `${hpBar(session.hp2, ch2.maxHp)} \`${Math.max(0, session.hp2)}/${ch2.maxHp}\`\n상태: ${statusStr(session.status2)}\n⚡술식: \`${session.skillCd2 > 0 ? session.skillCd2 + "턴" : "가능"}\` ♻반전: \`${session.reverseCd2 > 0 ? session.reverseCd2 + "턴" : "가능"}\``, inline: true },
      { name: "🎯 현재 턴", value: `**${turnName}**의 차례 (라운드 ${session.round})`, inline: false },
    )
    .setFooter({ text: "술식: 5턴 쿨다운 | 반전술식: 3턴 쿨다운 (고조/스쿠나/유타 전용)" });
}

function partyCullingEmbed(party, session, log = []) {
  const enemy   = session.currentEnemy;
  const members = party.members.map(uid => {
    const p  = players[uid];
    if (!p) return "❓ 알 수 없음";
    const ch = CHARACTERS[p.active];
    const awakened = isMakiAwakened(p);
    return `${ch.emoji} **${p.name}** ${hpBar(p.hp, ch.maxHp)} \`${Math.max(0, p.hp)}/${ch.maxHp}\`${awakened ? " 🔥" : ""} | ${statusStr(p.statusEffects)}`;
  }).join("\n");
  return new EmbedBuilder()
    .setTitle(`⚔️ [파티] 컬링 게임 — 🌊 WAVE ${session.wave}`)
    .setColor(session.wave >= 15 ? 0xF5C842 : session.wave >= 8 ? 0xe63946 : 0x7C5CFC)
    .setDescription(log.join("\n") || "⚔️ 파티 컬링 게임 진행 중!")
    .addFields(
      { name: "👥 파티 HP", value: members, inline: false },
      { name: `${enemy.emoji} ${enemy.name}`, value: `${hpBar(session.enemyHp, enemy.hp)} \`${Math.max(0, session.enemyHp)}/${enemy.hp}\` (ATK ${enemy.atk})\n상태: ${statusStr(enemy.statusEffects)}`, inline: false },
      { name: "📊 현황", value: `WAVE **${session.wave}** | 처치 **${session.kills}** | **${session.totalXp}** XP / **${session.totalCrystals}**💎`, inline: false },
    )
    .setFooter({ text: "파티원 누구나 버튼을 눌러 행동할 수 있습니다!" });
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
const mkJujutsuButtons = (player) => {
  const canSkill   = !player || player.skillCooldown <= 0;
  const canReverse = !player || player.reverseCooldown <= 0;
  const hasReverse = !player || REVERSE_CHARS.has(player.active);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("j_attack") .setLabel("⚔ 공격")    .setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("j_skill")  .setLabel(`🌀 술식${canSkill ? "" : `(${player?.skillCooldown}턴)`}`).setStyle(ButtonStyle.Primary).setDisabled(!canSkill),
    new ButtonBuilder().setCustomId("j_domain") .setLabel("🌌 영역전개").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("j_reverse").setLabel(`♻ 반전${canReverse ? "" : `(${player?.reverseCooldown}턴)`}`).setStyle(ButtonStyle.Secondary).setDisabled(!canReverse || !hasReverse),
    new ButtonBuilder().setCustomId("j_escape") .setLabel("🏳 철수")    .setStyle(ButtonStyle.Secondary),
  );
};
const mkJujutsuChoiceButtons = (choices) => new ActionRowBuilder().addComponents(
  choices.map((c, i) => new ButtonBuilder().setCustomId(`jc_${i}`).setLabel(`${c.emoji} [${i+1}] ${c.name} (+${c.points}p)`).setStyle(i === 0 ? ButtonStyle.Danger : i === 1 ? ButtonStyle.Primary : ButtonStyle.Success))
);
const mkPartyCullingButtons = () => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId("pc_attack") .setLabel("⚔ 공격")       .setStyle(ButtonStyle.Danger),
  new ButtonBuilder().setCustomId("pc_skill")  .setLabel("🌀 술식")       .setStyle(ButtonStyle.Primary),
  new ButtonBuilder().setCustomId("pc_domain") .setLabel("🌌 영역전개")   .setStyle(ButtonStyle.Success),
  new ButtonBuilder().setCustomId("pc_reverse").setLabel("♻ 반전술식")    .setStyle(ButtonStyle.Secondary),
  new ButtonBuilder().setCustomId("pc_escape") .setLabel("🏳 철수(리더)") .setStyle(ButtonStyle.Secondary),
);

// ── PvP 버튼 ──
const mkPvpButtons = (battleId, session, userId) => {
  const isP1      = session.p1Id === userId;
  const skillCd   = isP1 ? session.skillCd1  : session.skillCd2;
  const reverseCd = isP1 ? session.reverseCd1 : session.reverseCd2;
  const p         = players[userId];
  const hasRev    = p && REVERSE_CHARS.has(p.active);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`pvp_attack_${battleId}`)   .setLabel("⚔ 공격")    .setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`pvp_skill_${battleId}`)    .setLabel(`🌀 술식${skillCd > 0 ? `(${skillCd}턴)` : ""}`).setStyle(ButtonStyle.Primary).setDisabled(skillCd > 0),
    new ButtonBuilder().setCustomId(`pvp_domain_${battleId}`)   .setLabel("🌌 영역전개").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`pvp_reverse_${battleId}`)  .setLabel(`♻ 반전${reverseCd > 0 ? `(${reverseCd}턴)` : ""}`).setStyle(ButtonStyle.Secondary).setDisabled(reverseCd > 0 || !hasRev),
    new ButtonBuilder().setCustomId(`pvp_surrender_${battleId}`).setLabel("🏳 항복")   .setStyle(ButtonStyle.Secondary),
  );
};

// ── 술식 선택 드롭다운 — 메인 메시지에 교체되는 컴포넌트용 ──
// ★★★ PvP 포함 모든 모드에서 i.update()로 처리하도록 통일 ★★★
function mkSkillSelectRow(player, prefix) {
  const skills = getAvailableSkills(player, player.active);
  if (!skills.length) return null;
  const options = skills.map((s, i) => {
    const statusNote = s.statusApply ? ` [${STATUS_EFFECTS[s.statusApply.statusId]?.name} ${Math.round(s.statusApply.chance * 100)}%]` : "";
    return {
      label:       `[${i + 1}] ${s.name}`.slice(0, 100),
      description: `피해 ${s.dmg}${statusNote}`.slice(0, 100),
      value:       `${prefix}_${i}`,
    };
  });
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`skill_select_${prefix}`)
      .setPlaceholder("사용할 술식 선택 (5턴 쿨다운)")
      .addOptions(options)
  );
}

// DEV 버튼
const mkDevButtons = (targetId = null) => {
  const suffix = targetId ? `_${targetId}` : "";
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`dev_heal${suffix}`)   .setLabel("HP 풀회복") .setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`dev_xp${suffix}`)     .setLabel("XP +1000") .setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`dev_mastery${suffix}`).setLabel("숙련도 MAX").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`dev_crystal${suffix}`).setLabel("💎 +9999") .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`dev_kill${suffix}`)   .setLabel("적 즉사")   .setStyle(ButtonStyle.Danger),
  );
};

// ════════════════════════════════════════════════════════
// ── 사망 처리 헬퍼
// ════════════════════════════════════════════════════════
async function handleCullingDeath(i, player, culling, log) {
  player.hp = 0; player.losses++;
  const hXp  = Math.floor(culling.totalXp / 2);
  const hCry = Math.floor(culling.totalCrystals / 2);
  player.xp       += hXp;
  player.crystals += hCry;
  if (!player.mastery[player.active]) player.mastery[player.active] = 0;
  player.mastery[player.active] += Math.floor(culling.totalMastery / 2);
  if (culling.wave - 1 > player.cullingBest) player.cullingBest = culling.wave - 1;
  player.statusEffects = []; player.skillCooldown = 0; player.reverseCooldown = 0;
  delete cullings[i.user.id];
  savePlayerSync(i.user.id);
  log.push(`\n💀 **사망!** WAVE **${culling.wave}** | 절반 보상: **+${hXp}** XP | **+${hCry}**💎`);
  return i.update({
    embeds: [new EmbedBuilder()
      .setTitle(`💀 컬링 게임 실패 — WAVE ${culling.wave}`)
      .setColor(0xe63946)
      .setDescription(log.join("\n"))
      .addFields({ name: "🌊 최고 기록", value: `WAVE **${player.cullingBest}**`, inline: true })
    ],
    components: [],
  });
}

async function handleJujutsuDeath(i, player, jujutsu, log) {
  player.hp = 0; player.losses++;
  const hXp  = Math.floor(jujutsu.totalXp / 2);
  const hCry = Math.floor(jujutsu.totalCrystals / 2);
  player.xp       += hXp;
  player.crystals += hCry;
  if (!player.mastery[player.active]) player.mastery[player.active] = 0;
  player.mastery[player.active] += Math.floor(jujutsu.totalMastery / 2);
  if (jujutsu.points > player.jujutsuBest) player.jujutsuBest = jujutsu.points;
  player.statusEffects = []; player.skillCooldown = 0; player.reverseCooldown = 0;
  delete jujutsus[i.user.id];
  savePlayerSync(i.user.id);
  log.push(`\n💀 **사망!** WAVE **${jujutsu.wave}** | **${jujutsu.points}포인트** | 절반 보상: **+${hXp}** XP | **+${hCry}**💎`);
  return i.update({
    embeds: [new EmbedBuilder()
      .setTitle(`💀 사멸회유 실패 — ${jujutsu.points}포인트`)
      .setColor(0xe63946)
      .setDescription(log.join("\n"))
      .addFields({ name: "🎯 최고 기록", value: `**${player.jujutsuBest}** 포인트`, inline: true })
    ],
    components: [],
  });
}

// ════════════════════════════════════════════════════════
// ── 메시지 핸들러
// ════════════════════════════════════════════════════════
client.on("messageCreate", async (msg) => {
  if (!msg || msg.author.bot) return;
  const content = msg.content.trim();
  const player  = getPlayer(msg.author.id, msg.author.username);

  // 도움말
  if (content === "!도움" || content === "!help") {
    return msg.reply({ embeds: [new EmbedBuilder()
      .setTitle("⚡ 주술회전 RPG봇 — 명령어 목록")
      .setColor(0x7c5cfc)
      .addFields(
        { name: "📋 기본",        value: "`!나` `!프로필` `!도움` `!출석`", inline: false },
        { name: "👤 캐릭터",     value: "`!캐릭터` 편성 | `!도감` 전체목록 | `!스킬` 스킬트리", inline: false },
        { name: "🎲 가챠",       value: "`!가챠` 1회(150💎) | `!가챠10` 10회(1350💎)", inline: false },
        { name: "⚔️ 전투",       value: "`!전투` | `!컬링` | `!사멸회유`", inline: false },
        { name: "⚔️ PvP",        value: "`!결투 @유저` | `!결투수락` | `!결투거절`", inline: false },
        { name: "👥 파티",       value: "`!파티` `!파티초대 @유저` `!파티수락` `!파티탈퇴` `!파티컬링`", inline: false },
        { name: "📊 기타",       value: "`!랭킹` | `!코드 [코드]`", inline: false },
        { name: "🌀 시스템",     value: "술식: **5턴 쿨다운** | 반전술식: **3턴**(고조/스쿠나/유타) | 마키 HP30% 이하 시 **각성(데미지 2배)**", inline: false },
      )
      .setFooter({ text: "💎 첫 시작 500 크리스탈 지급!" })
    ]});
  }

  // 프로필 (!나 또는 !프로필)
  if (content === "!프로필" || content === "!나") {
    return msg.reply({ embeds: [profileEmbed(player)] });
  }

  if (content === "!스킬") return msg.reply({ embeds: [skillEmbed(player)] });

  // 출석
  if (content === "!출석") {
    const now        = Date.now();
    const lastDaily  = player.lastDaily || 0;
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    if (lastDaily >= todayStart.getTime()) {
      const tomorrow = new Date(todayStart); tomorrow.setDate(tomorrow.getDate() + 1);
      const diffMs = tomorrow.getTime() - now;
      const h = Math.floor(diffMs / 3600000);
      const m = Math.floor((diffMs % 3600000) / 60000);
      return msg.reply(`⏰ 오늘 이미 출석했습니다!\n다음 출석까지 **${h}시간 ${m}분** 남았어요.`);
    }
    const reward = 50 + Math.floor(Math.random() * 151);
    const streak = (player.dailyStreak || 0) + 1;
    const bonus  = Math.floor(streak / 7) * 50;
    const total  = reward + bonus;
    player.crystals += total;
    player.lastDaily = now;
    player.dailyStreak = streak;
    if (player.potion < 5) player.potion = Math.min(5, player.potion + 1);
    savePlayerSync(msg.author.id);
    return msg.reply({ embeds: [new EmbedBuilder()
      .setTitle("📅 출석 체크!")
      .setColor(0x4ade80)
      .setDescription(`**${player.name}** 님, 오늘도 출석하셨습니다!\n💎 **+${total}**💎 ${bonus > 0 ? `(기본 ${reward} + 연속보너스 ${bonus})` : ""}\n🗓️ **${streak}**일 연속 출석 | 💎 현재 **${player.crystals}** | 🧪 **${player.potion}개**`)
      .setFooter({ text: "7일 연속 출석 시 보너스 +50💎!" })
    ]});
  }

  // 랭킹
  if (content === "!랭킹") {
    const all = Object.values(players);
    const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"];
    const fmt = (arr, fn) => arr.map((p, i) => `${medals[i]} **${p.name}** — ${fn(p)}`).join("\n") || "기록 없음";
    return msg.reply({ embeds: [new EmbedBuilder()
      .setTitle("📊 주술회전 RPG 랭킹")
      .setColor(0xF5C842)
      .addFields(
        { name: "⭐ XP TOP5",          value: fmt([...all].sort((a,b)=>(b.xp||0)-(a.xp||0)).slice(0,5), p=>`LV.${getLevel(p.xp)} (${p.xp} XP)`), inline: false },
        { name: "🌊 컬링 WAVE TOP5",   value: fmt([...all].sort((a,b)=>(b.cullingBest||0)-(a.cullingBest||0)).slice(0,5), p=>`WAVE **${p.cullingBest}**`), inline: false },
        { name: "⚔️ PvP 승리 TOP5",   value: fmt([...all].sort((a,b)=>(b.pvpWins||0)-(a.pvpWins||0)).slice(0,5), p=>`**${p.pvpWins}**승 ${p.pvpLosses}패`), inline: false },
        { name: "🎯 사멸회유 TOP5",    value: fmt([...all].sort((a,b)=>(b.jujutsuBest||0)-(a.jujutsuBest||0)).slice(0,5), p=>`**${p.jujutsuBest||0}**포인트`), inline: false },
      )
      .setFooter({ text: `총 ${all.length}명 등록` })
    ]});
  }

  // 도감
  if (content === "!도감") {
    return msg.reply({ embeds: [new EmbedBuilder()
      .setTitle("📖 주술회전 캐릭터 도감")
      .setColor(0x0d0d1a)
      .setDescription(Object.entries(CHARACTERS).map(([id, ch]) => {
        const owned = player.owned.includes(id);
        const m     = getMastery(player, id);
        const skill = owned ? getCurrentSkill(player, id) : null;
        return `${owned ? ch.emoji : "🔒"} **${ch.name}** [${JJK_GRADE_EMOJI[ch.grade]} ${ch.grade}]${owned ? ` — 숙련 ${m} | ${skill.name}` : " — 미획득"}`;
      }).join("\n"))
      .setFooter({ text: "!가챠로 새 캐릭터를 획득하세요!" })
    ]});
  }

  // 캐릭터 편성
  if (content === "!캐릭터") {
    if (!player.owned.length) return msg.reply("보유 캐릭터 없음! `!가챠`로 소환하세요.");
    const select = new StringSelectMenuBuilder()
      .setCustomId("select_char")
      .setPlaceholder("편성할 캐릭터 선택")
      .addOptions(player.owned.map(id => {
        const ch = CHARACTERS[id];
        const skill = getCurrentSkill(player, id);
        return { label: ch.name, description: `${ch.grade} | 숙련 ${getMastery(player, id)} | ${skill.name}`, value: id, emoji: ch.emoji, default: player.active === id };
      }));
    return msg.reply({ content: "👤 편성할 캐릭터를 선택하세요:", components: [new ActionRowBuilder().addComponents(select)] });
  }

  // 가챠
  if (content === "!가챠") {
    if (player.crystals < 150) return msg.reply(`💎 크리스탈 부족! (${player.crystals}/150)`);
    player.crystals -= 150;
    const [result] = rollGacha(1);
    const ch    = CHARACTERS[result];
    const isNew = !player.owned.includes(result);
    if (isNew) { player.owned.push(result); if (!player.mastery[result]) player.mastery[result] = 0; }
    else player.crystals += 50;
    savePlayerSync(msg.author.id);
    return msg.reply({ embeds: [new EmbedBuilder()
      .setTitle("🎲 주술 소환 결과!")
      .setColor(JJK_GRADE_COLOR[ch.grade])
      .setDescription(`${ch.emoji} **${ch.name}** [${JJK_GRADE_EMOJI[ch.grade]} ${ch.grade}]${isNew ? " ✨**NEW!**" : " (중복 +50💎)"}`)
      .addFields(
        { name: "설명", value: ch.desc, inline: false },
        { name: "🌌 영역", value: ch.domain || "없음", inline: true },
        { name: "💎 잔여", value: `${player.crystals}`, inline: true },
      )
    ]});
  }

  if (content === "!가챠10") {
    if (player.crystals < 1350) return msg.reply(`💎 크리스탈 부족! (${player.crystals}/1350)`);
    player.crystals -= 1350;
    const results = rollGacha(10);
    const newOnes = []; let dupCrystals = 0;
    results.forEach(id => {
      if (!player.owned.includes(id)) { player.owned.push(id); if (!player.mastery[id]) player.mastery[id] = 0; newOnes.push(id); }
      else { dupCrystals += 50; player.crystals += 50; }
    });
    savePlayerSync(msg.author.id);
    return msg.reply({ embeds: [new EmbedBuilder()
      .setTitle("🎲 주술 10회 소환 결과!")
      .setColor(0xF5C842)
      .setDescription(results.map(id => `${CHARACTERS[id].emoji} **${CHARACTERS[id].name}** [${CHARACTERS[id].grade}]${newOnes.includes(id) ? " ✨NEW!" : ""}`).join("\n"))
      .addFields(
        { name: "✨ 신규", value: newOnes.length ? newOnes.map(id => CHARACTERS[id].name).join(", ") : "없음", inline: true },
        { name: "🔄 중복 보상", value: `+${dupCrystals}💎`, inline: true },
        { name: "💎 잔여", value: `${player.crystals}`, inline: true },
      )
    ]});
  }

  // 전투 시작
  if (content === "!전투") {
    if (battles[msg.author.id] || cullings[msg.author.id] || jujutsus[msg.author.id] || getPvpSessionByUser(msg.author.id)) return msg.reply("이미 전투 중!");
    if (getParty(msg.author.id)?.cullingSession) return msg.reply("파티 컬링 진행 중!");
    if (player.hp <= 0) { player.hp = CHARACTERS[player.active].maxHp; savePlayerSync(msg.author.id); return msg.reply("HP 0 → **풀회복!** 다시 `!전투` 입력하세요."); }
    return msg.reply({
      content: "⚔️ 상대할 적을 선택하세요:",
      components: [new ActionRowBuilder().addComponents(
        ...ENEMIES.map(e => new ButtonBuilder().setCustomId(`enemy_${e.id}`).setLabel(`${e.emoji} ${e.name}`).setStyle(ButtonStyle.Secondary))
      )],
    });
  }

  // 컬링 시작
  if (content === "!컬링") {
    if (battles[msg.author.id] || cullings[msg.author.id] || jujutsus[msg.author.id] || getPvpSessionByUser(msg.author.id)) return msg.reply("이미 전투 중!");
    if (getParty(msg.author.id)?.cullingSession) return msg.reply("파티 컬링 진행 중!");
    if (player.hp <= 0) { player.hp = CHARACTERS[player.active].maxHp; savePlayerSync(msg.author.id); return msg.reply("HP 0 → **풀회복!** 다시 `!컬링` 입력하세요."); }
    const firstEnemy = pickCullingEnemy(1);
    cullings[msg.author.id] = { wave: 1, currentEnemy: firstEnemy, enemyHp: firstEnemy.hp, domainUsed: false, kills: 0, totalXp: 0, totalCrystals: 0, totalMastery: 0 };
    player.statusEffects = []; player.skillCooldown = 0; player.reverseCooldown = 0;
    return msg.reply({
      embeds: [cullingEmbed(player, cullings[msg.author.id], ["🌊 **컬링 게임** 시작!", `${firstEnemy.emoji} **WAVE 1** — **${firstEnemy.name}** 등장!`])],
      components: [mkCullingButtons(player)],
    });
  }

  // 사멸회유 시작
  if (content === "!사멸회유") {
    if (battles[msg.author.id] || cullings[msg.author.id] || jujutsus[msg.author.id] || getPvpSessionByUser(msg.author.id)) return msg.reply("이미 전투 중!");
    if (getParty(msg.author.id)?.cullingSession) return msg.reply("파티 컬링 진행 중!");
    if (player.hp <= 0) { player.hp = CHARACTERS[player.active].maxHp; savePlayerSync(msg.author.id); return msg.reply("HP 0 → **풀회복!** 다시 `!사멸회유` 입력하세요."); }
    const choices = generateJujutsuChoices(1);
    jujutsus[msg.author.id] = { wave: 1, points: 0, currentEnemy: null, enemyHp: 0, domainUsed: false, kills: 0, totalXp: 0, totalCrystals: 0, totalMastery: 0, pendingChoices: choices, phase: "choose" };
    player.statusEffects = []; player.skillCooldown = 0; player.reverseCooldown = 0;
    return msg.reply({
      embeds: [jujutsuEmbed(player, jujutsus[msg.author.id], ["🎯 **사멸회유** 시작! **15포인트** 달성 시 보너스 보상!"], choices)],
      components: [mkJujutsuChoiceButtons(choices)],
    });
  }

  // PvP 결투 신청
  if (content.startsWith("!결투 ") || (content === "!결투" && msg.mentions.users.size)) {
    const mentioned = msg.mentions.users.first();
    if (!mentioned) return msg.reply("사용법: `!결투 @유저`");
    if (mentioned.id === msg.author.id) return msg.reply("자기 자신에게 결투를 신청할 수 없습니다!");
    if (mentioned.bot) return msg.reply("봇에게 결투를 신청할 수 없습니다!");
    if (battles[msg.author.id] || cullings[msg.author.id] || jujutsus[msg.author.id] || getPvpSessionByUser(msg.author.id)) return msg.reply("이미 전투 중입니다!");
    if (battles[mentioned.id]  || cullings[mentioned.id]  || jujutsus[mentioned.id]  || getPvpSessionByUser(mentioned.id))  return msg.reply("상대방이 이미 전투 중입니다!");
    if (player.hp <= 0) { player.hp = CHARACTERS[player.active].maxHp; savePlayerSync(msg.author.id); return msg.reply("HP 0 → **풀회복!** 다시 결투를 신청하세요."); }
    pvpChallenges[mentioned.id] = { challengerId: msg.author.id, expiresAt: Date.now() + 60_000 };
    const ch1 = CHARACTERS[player.active];
    const target = getPlayer(mentioned.id, mentioned.username);
    const ch2 = CHARACTERS[target.active];
    return msg.reply({ content: `<@${mentioned.id}>`, embeds: [new EmbedBuilder()
      .setTitle("⚔️ PvP 결투 신청!")
      .setColor(0xe63946)
      .setDescription(`**${player.name}** (${ch1.emoji}${ch1.name} [${ch1.grade}]) 님이\n**${target.name}** (${ch2.emoji}${ch2.name} [${ch2.grade}]) 님에게 결투를 신청했습니다!\n\n\`!결투수락\` 또는 \`!결투거절\` (1분 유효)`)
    ]});
  }

  if (content === "!결투수락") {
    const challenge = pvpChallenges[msg.author.id];
    if (!challenge) return msg.reply("받은 결투 신청이 없습니다!");
    if (Date.now() > challenge.expiresAt) { delete pvpChallenges[msg.author.id]; return msg.reply("결투 신청이 만료되었습니다!"); }
    if (battles[msg.author.id] || cullings[msg.author.id] || jujutsus[msg.author.id] || getPvpSessionByUser(msg.author.id)) return msg.reply("이미 전투 중입니다!");
    const challenger = players[challenge.challengerId];
    if (!challenger) { delete pvpChallenges[msg.author.id]; return msg.reply("신청자 정보를 찾을 수 없습니다."); }
    if (challenger.hp <= 0) challenger.hp = CHARACTERS[challenger.active].maxHp;
    if (player.hp <= 0)     player.hp     = CHARACTERS[player.active].maxHp;
    challenger.statusEffects = []; player.statusEffects = [];
    const bid = String(_pvpIdSeq++);
    const ch1 = CHARACTERS[challenger.active];
    const ch2 = CHARACTERS[player.active];
    const firstTurn = ch1.spd >= ch2.spd ? challenge.challengerId : msg.author.id;
    pvpSessions[bid] = {
      id: bid,
      p1Id: challenge.challengerId, p2Id: msg.author.id,
      hp1: ch1.maxHp, hp2: ch2.maxHp,
      status1: [], status2: [],
      skillCd1: 0, skillCd2: 0,
      reverseCd1: 0, reverseCd2: 0,
      domainUsed1: false, domainUsed2: false,
      turn: firstTurn, round: 1,
      channelId: msg.channelId,
      // 술식 선택 대기 상태 없음 — 모두 인라인 처리
    };
    delete pvpChallenges[msg.author.id];
    const session = pvpSessions[bid];
    return msg.reply({
      content: `<@${challenge.challengerId}> <@${msg.author.id}>`,
      embeds: [pvpEmbed(session, [`⚔️ **PvP 결투** 시작!`, `SPD: ${ch1.name}(${ch1.spd}) vs ${ch2.name}(${ch2.spd}) → **${firstTurn === challenge.challengerId ? challenger.name : player.name}** 선공!`])],
      components: [mkPvpButtons(bid, session, firstTurn)],
    });
  }

  if (content === "!결투거절") {
    if (!pvpChallenges[msg.author.id]) return msg.reply("받은 결투 신청이 없습니다!");
    delete pvpChallenges[msg.author.id];
    return msg.reply("결투 신청을 거절했습니다.");
  }

  // 파티 명령어
  if (content === "!파티") {
    const party = getParty(msg.author.id);
    if (!party) {
      const pid = String(_partyIdSeq++);
      parties[pid] = { id: pid, leader: msg.author.id, members: [msg.author.id], cullingSession: null };
      return msg.reply(`👥 파티 **#${pid}** 생성 완료! \`!파티초대 @유저\` 로 파티원을 초대하세요.`);
    }
    const memberLines = party.members.map(uid => {
      const p = players[uid]; const ch = p ? CHARACTERS[p.active] : null;
      return p ? `${party.leader === uid ? "👑" : "👤"} **${p.name}** — ${ch.emoji} ${ch.name} [${ch.grade}]` : `❓ ${uid}`;
    }).join("\n");
    return msg.reply({ embeds: [new EmbedBuilder().setTitle(`👥 파티 #${party.id}`).setColor(0x4ade80).addFields({ name: "파티원", value: memberLines }, { name: "상태", value: party.cullingSession ? "🌊 컬링 진행 중" : "대기 중", inline: true }).setFooter({ text: "!파티탈퇴 | !파티초대 @유저 | !파티컬링" })] });
  }

  if (content.startsWith("!파티초대")) {
    const party = getParty(msg.author.id);
    if (!party) return msg.reply("파티가 없습니다!");
    if (party.leader !== msg.author.id) return msg.reply("파티 리더만 초대할 수 있습니다!");
    if (party.members.length >= 4) return msg.reply("파티 최대 인원(4명)!");
    const mentioned = msg.mentions.users.first();
    if (!mentioned || mentioned.id === msg.author.id) return msg.reply("사용법: `!파티초대 @유저`");
    if (party.members.includes(mentioned.id)) return msg.reply("이미 파티에 있는 유저입니다!");
    if (getPartyId(mentioned.id)) return msg.reply("해당 유저는 이미 다른 파티에 속해 있습니다!");
    partyInvites[mentioned.id] = { partyId: party.id, inviterId: msg.author.id, expiresAt: Date.now() + 60_000 };
    return msg.reply(`📨 <@${mentioned.id}> 에게 파티 초대를 보냈습니다! \`!파티수락\` 또는 \`!파티거절\``);
  }

  if (content === "!파티수락") {
    const invite = partyInvites[msg.author.id];
    if (!invite) return msg.reply("받은 파티 초대가 없습니다!");
    if (Date.now() > invite.expiresAt) { delete partyInvites[msg.author.id]; return msg.reply("초대가 만료되었습니다!"); }
    if (getPartyId(msg.author.id)) return msg.reply("이미 파티에 속해 있습니다!");
    const party = parties[invite.partyId];
    if (!party) { delete partyInvites[msg.author.id]; return msg.reply("파티가 존재하지 않습니다."); }
    if (party.members.length >= 4) { delete partyInvites[msg.author.id]; return msg.reply("파티가 가득 찼습니다!"); }
    party.members.push(msg.author.id);
    delete partyInvites[msg.author.id];
    return msg.reply(`👥 **${player.name}** 님이 파티 **#${party.id}** 에 합류했습니다! 현재: ${party.members.map(uid => players[uid]?.name || uid).join(", ")}`);
  }

  if (content === "!파티거절") { delete partyInvites[msg.author.id]; return msg.reply("파티 초대를 거절했습니다."); }

  if (content === "!파티탈퇴") {
    const pid = getPartyId(msg.author.id);
    if (!pid) return msg.reply("현재 파티에 속해 있지 않습니다!");
    const party = parties[pid];
    if (party.cullingSession) return msg.reply("컬링 게임 중에는 탈퇴할 수 없습니다!");
    party.members = party.members.filter(uid => uid !== msg.author.id);
    if (party.members.length === 0) { delete parties[pid]; return msg.reply("파티를 해산했습니다."); }
    if (party.leader === msg.author.id) party.leader = party.members[0];
    return msg.reply(`파티 **#${pid}** 에서 탈퇴했습니다.`);
  }

  if (content === "!파티컬링") {
    const pid = getPartyId(msg.author.id);
    if (!pid) return msg.reply("파티에 속해 있지 않습니다!");
    const party = parties[pid];
    if (party.leader !== msg.author.id) return msg.reply("파티 리더만 컬링 게임을 시작할 수 있습니다!");
    if (party.cullingSession) return msg.reply("이미 파티 컬링 게임 진행 중!");
    if (party.members.length < 2) return msg.reply("최소 2명 이상 필요합니다!");
    for (const uid of party.members) {
      if (battles[uid] || cullings[uid] || jujutsus[uid]) return msg.reply(`<@${uid}> 님이 다른 전투 중입니다!`);
    }
    for (const uid of party.members) {
      const p = players[uid]; if (!p) continue;
      if (p.hp <= 0) { p.hp = CHARACTERS[p.active].maxHp; }
      p.statusEffects = []; p.skillCooldown = 0; p.reverseCooldown = 0;
    }
    const firstEnemy = pickCullingEnemy(1);
    party.cullingSession = { wave: 1, currentEnemy: firstEnemy, enemyHp: firstEnemy.hp, domainUsed: false, kills: 0, totalXp: 0, totalCrystals: 0, totalMastery: 0 };
    return msg.reply({
      content: party.members.map(uid => `<@${uid}>`).join(" "),
      embeds: [partyCullingEmbed(party, party.cullingSession, ["🌊 **[파티] 컬링 게임** 시작!", `${firstEnemy.emoji} **WAVE 1** — **${firstEnemy.name}** 등장!`])],
      components: [mkPartyCullingButtons()],
    });
  }

  // 코드
  if (content.startsWith("!코드 ") || content.startsWith("!code ")) {
    const code = content.split(" ")[1]?.trim().toLowerCase();
    if (!code) return msg.reply("사용법: `!코드 코드입력`");
    if (player.usedCodes.includes(code)) return msg.reply("❌ 이미 사용한 코드입니다!");
    if (!CODES[code]) return msg.reply("❌ 유효하지 않은 코드입니다!");
    const reward = CODES[code];
    player.crystals += reward.crystals || 0;
    player.usedCodes.push(code);
    savePlayerSync(msg.author.id);
    return msg.reply(`🎁 코드 **${code}** 사용 완료! 💎 **+${reward.crystals}** 크리스탈 획득! (현재: **${player.crystals}**)`);
  }

  // DEV
  if (content.startsWith("!dev") && isDev(msg.author.id)) {
    const mentioned = msg.mentions.users.first();
    if (mentioned && mentioned.id !== msg.author.id) {
      const tp = getPlayer(mentioned.id, mentioned.username);
      return msg.reply({ content: `👑 DEV PANEL — 대상: **${tp.name}**`, components: [mkDevButtons(mentioned.id)] });
    }
    return msg.reply({ content: "👑 DEV PANEL", components: [mkDevButtons()] });
  }
});

// ════════════════════════════════════════════════════════
// ── 인터랙션 핸들러
// ════════════════════════════════════════════════════════
client.on("interactionCreate", async (i) => {
  if (!i.isButton() && !i.isStringSelectMenu()) return;

  const player  = getPlayer(i.user.id, i.user.username);
  const battle  = battles[i.user.id];
  const culling = cullings[i.user.id];
  const jujutsu = jujutsus[i.user.id];

  // ── 캐릭터 선택 ──
  if (i.isStringSelectMenu() && i.customId === "select_char") {
    const id = i.values[0];
    player.active = id; player.hp = CHARACTERS[id].maxHp;
    player.statusEffects = []; player.skillCooldown = 0; player.reverseCooldown = 0;
    savePlayerSync(i.user.id);
    const ch = CHARACTERS[id];
    return i.update({ content: `${ch.emoji} **${ch.name}** 편성 완료! HP 최대 회복. 등급: **${JJK_GRADE_EMOJI[ch.grade]} ${ch.grade}**`, components: [] });
  }

  // ════════════════════════════════════════════
  // ★★★ 술식 드롭다운 — 모든 모드 i.update() 처리 ★★★
  // 새 창/ephemeral reply 없이 메인 메시지 직접 교체
  // ════════════════════════════════════════════
  if (i.isStringSelectMenu() && i.customId.startsWith("skill_select_")) {
    const prefix   = i.customId.replace("skill_select_", "");
    const skillIdx = parseSkillIndex(i.values[0]);
    const skills   = getAvailableSkills(player, player.active);
    const skill    = skills[skillIdx];

    if (!skill || skillIdx < 0) return i.update({ content: "❌ 스킬 선택 오류!", components: [], embeds: [] });

    // ── 일반 전투 술식 ──
    if (prefix === "bs") {
      if (!battle) return i.update({ content: "전투가 종료되었습니다.", components: [], embeds: [] });
      if (player.skillCooldown > 0) return i.update({ content: `⚡ 술식 쿨다운 중 (${player.skillCooldown}턴)`, components: [], embeds: [] });
      const ch = CHARACTERS[player.active]; const enemy = battle.enemy; const log = [];
      { const pObj = { hp: player.hp, statusEffects: player.statusEffects || [] }; const tick = tickStatus(pObj, ch.maxHp); player.hp = pObj.hp; player.statusEffects = pObj.statusEffects; if (tick.log.length) log.push(...tick.log.map(l => `[나] ${l}`)); }
      tickCooldowns(player);
      const dmg = calcSkillDmgForPlayer(player, skill.dmg);
      battle.enemyHp -= dmg; player.skillCooldown = 5;
      log.push(`✨ **[${skillIdx + 1}번] ${skill.name}**! → **${enemy.name}**에게 **${dmg}** 피해!${isMakiAwakened(player) ? " 🔥각성!" : ""}`);
      const eObj = { statusEffects: enemy.statusEffects || [] };
      const sLog = applySkillStatus(skill, eObj);
      enemy.statusEffects = eObj.statusEffects; if (sLog.length) log.push(...sLog);
      { const eeObj = { hp: battle.enemyHp, statusEffects: enemy.statusEffects || [] }; tickStatus(eeObj, enemy.hp); battle.enemyHp = eeObj.hp; enemy.statusEffects = eeObj.statusEffects; }
      if (battle.enemyHp > 0 && !isIncapacitated(enemy.statusEffects)) {
        const edm = calcDmg(enemy.atk, ch.def); player.hp -= edm;
        log.push(`💥 **${enemy.name}**의 반격! → **${edm}** 피해!`);
        if (enemy.statusAttack && Math.random() < enemy.statusAttack.chance) { applyStatus(player, enemy.statusAttack.statusId); log.push(`${STATUS_EFFECTS[enemy.statusAttack.statusId].emoji} **${enemy.name}**의 ${STATUS_EFFECTS[enemy.statusAttack.statusId].name} 공격!`); }
      }
      const pDead = player.hp <= 0; const eDead = battle.enemyHp <= 0;
      if (eDead) { player.xp += enemy.xp; player.crystals += enemy.crystals; player.wins++; if (!player.mastery[player.active]) player.mastery[player.active] = 0; player.mastery[player.active] += enemy.masteryXp; player.statusEffects = []; delete battles[i.user.id]; savePlayerSync(i.user.id); log.push(`\n🏆 승리! +**${enemy.xp}** XP | +**${enemy.crystals}**💎 | 숙련도 **+${enemy.masteryXp}**`); }
      else if (pDead) { player.hp = 0; player.losses++; player.statusEffects = []; delete battles[i.user.id]; savePlayerSync(i.user.id); log.push(`\n💀 패배...`); }
      else savePlayerSync(i.user.id);
      const over = pDead || eDead;
      return i.update({ embeds: [skillActivationEmbed(player, skill, dmg, log, enemy, battle.enemyHp, over, eDead)], components: over ? [] : [mkBattleButtons(player)] });
    }

    // ── 컬링 술식 ──
    if (prefix === "cs") {
      if (!culling) return i.update({ content: "컬링이 종료되었습니다.", components: [], embeds: [] });
      if (player.skillCooldown > 0) return i.update({ content: `⚡ 술식 쿨다운 중 (${player.skillCooldown}턴)`, components: [], embeds: [] });
      const ch = CHARACTERS[player.active]; const enemy = culling.currentEnemy; const log = [];
      { const pObj = { hp: player.hp, statusEffects: player.statusEffects || [] }; tickStatus(pObj, ch.maxHp); player.hp = pObj.hp; player.statusEffects = pObj.statusEffects; }
      tickCooldowns(player);
      const dmg = calcSkillDmgForPlayer(player, skill.dmg);
      culling.enemyHp -= dmg; player.skillCooldown = 5;
      log.push(`✨ **[${skillIdx + 1}번] ${skill.name}**! → **${enemy.name}**에게 **${dmg}** 피해!${isMakiAwakened(player) ? " 🔥" : ""}`);
      const eObj = { statusEffects: enemy.statusEffects || [] };
      const sLog = applySkillStatus(skill, eObj);
      enemy.statusEffects = eObj.statusEffects; if (sLog.length) log.push(...sLog);
      { const eeObj = { hp: culling.enemyHp, statusEffects: enemy.statusEffects }; tickStatus(eeObj, enemy.hp); culling.enemyHp = eeObj.hp; enemy.statusEffects = eeObj.statusEffects; }
      if (culling.enemyHp > 0 && !isIncapacitated(enemy.statusEffects)) {
        const edm = calcDmg(enemy.atk, ch.def); player.hp -= edm;
        log.push(`💥 **${enemy.name}**의 반격! → **${edm}** 피해!`);
        if (enemy.statusAttack && Math.random() < enemy.statusAttack.chance) { applyStatus(player, enemy.statusAttack.statusId); log.push(`${STATUS_EFFECTS[enemy.statusAttack.statusId].emoji} **${enemy.name}**의 ${STATUS_EFFECTS[enemy.statusAttack.statusId].name} 공격!`); }
      }
      if (player.hp <= 0) return handleCullingDeath(i, player, culling, log);
      if (culling.enemyHp <= 0) {
        culling.kills++; culling.totalXp += enemy.xp; culling.totalCrystals += enemy.crystals; culling.totalMastery += enemy.masteryXp;
        log.push(`✅ **${enemy.name}** 처치! +${enemy.xp} XP | +${enemy.crystals}💎`);
        if (culling.wave > player.cullingBest) { player.cullingBest = culling.wave; log.push(`🏆 **최고기록 갱신!** WAVE ${player.cullingBest}`); }
        const nextWave = culling.wave + 1; const nextEnemy = pickCullingEnemy(nextWave);
        culling.wave = nextWave; culling.currentEnemy = nextEnemy; culling.enemyHp = nextEnemy.hp;
        log.push(`\n🌊 **WAVE ${nextWave}** 돌입! ${nextEnemy.emoji} **${nextEnemy.name}** 등장!`);
        savePlayerSync(i.user.id);
        return i.update({ embeds: [cullingEmbed(player, culling, log)], components: [mkCullingButtons(player)] });
      }
      savePlayerSync(i.user.id);
      return i.update({ embeds: [cullingEmbed(player, culling, log)], components: [mkCullingButtons(player)] });
    }

    // ── 사멸회유 술식 ──
    if (prefix === "js") {
      if (!jujutsu || jujutsu.phase !== "fight") return i.update({ content: "사멸회유 전투 중이 아닙니다.", components: [], embeds: [] });
      if (player.skillCooldown > 0) return i.update({ content: `⚡ 술식 쿨다운 중 (${player.skillCooldown}턴)`, components: [], embeds: [] });
      const ch = CHARACTERS[player.active]; const enemy = jujutsu.currentEnemy; const log = [];
      { const pObj = { hp: player.hp, statusEffects: player.statusEffects || [] }; tickStatus(pObj, ch.maxHp); player.hp = pObj.hp; player.statusEffects = pObj.statusEffects; }
      tickCooldowns(player);
      const dmg = calcSkillDmgForPlayer(player, skill.dmg);
      jujutsu.enemyHp -= dmg; player.skillCooldown = 5;
      log.push(`✨ **[${skillIdx + 1}번] ${skill.name}**! → **${enemy.name}**에게 **${dmg}** 피해!${isMakiAwakened(player) ? " 🔥" : ""}`);
      const eObj = { statusEffects: enemy.statusEffects || [] };
      const sLog = applySkillStatus(skill, eObj);
      enemy.statusEffects = eObj.statusEffects; if (sLog.length) log.push(...sLog);
      { const eeObj = { hp: jujutsu.enemyHp, statusEffects: enemy.statusEffects }; tickStatus(eeObj, enemy.hp); jujutsu.enemyHp = eeObj.hp; enemy.statusEffects = eeObj.statusEffects; }
      if (jujutsu.enemyHp > 0 && !isIncapacitated(enemy.statusEffects)) {
        const edm = calcDmg(enemy.atk, ch.def); player.hp -= edm;
        log.push(`💥 **${enemy.name}**의 반격! → **${edm}** 피해!`);
        if (enemy.statusAttack && Math.random() < enemy.statusAttack.chance) { applyStatus(player, enemy.statusAttack.statusId); log.push(`${STATUS_EFFECTS[enemy.statusAttack.statusId].emoji} **${enemy.name}**의 ${STATUS_EFFECTS[enemy.statusAttack.statusId].name} 공격!`); }
      }
      if (player.hp <= 0) return handleJujutsuDeath(i, player, jujutsu, log);
      if (jujutsu.enemyHp <= 0) {
        jujutsu.kills++; jujutsu.totalXp += enemy.xp; jujutsu.totalCrystals += enemy.crystals; jujutsu.totalMastery += enemy.masteryXp; jujutsu.points += enemy.points;
        log.push(`✅ **${enemy.name}** 처치! **+${enemy.points}포인트** (현재: ${jujutsu.points}/15)`);
        if (jujutsu.points >= 15) {
          player.crystals += 500; player.xp += 1000;
          if (jujutsu.points > player.jujutsuBest) player.jujutsuBest = jujutsu.points;
          player.statusEffects = []; player.skillCooldown = 0; player.reverseCooldown = 0;
          delete jujutsus[i.user.id]; savePlayerSync(i.user.id);
          log.push(`\n🎉 **15포인트 달성!!** +1000 XP | +500💎`);
          return i.update({ embeds: [new EmbedBuilder().setTitle("🎉 사멸회유 완료!").setColor(0xF5C842).setDescription(log.join("\n"))], components: [] });
        }
        if (jujutsu.points > player.jujutsuBest) player.jujutsuBest = jujutsu.points;
        const nextWave = jujutsu.wave + 1; const choices = generateJujutsuChoices(nextWave);
        jujutsu.wave = nextWave; jujutsu.currentEnemy = null; jujutsu.enemyHp = 0; jujutsu.pendingChoices = choices; jujutsu.phase = "choose";
        log.push(`\n🎯 **WAVE ${nextWave}** — 다음 적을 선택하세요!`);
        savePlayerSync(i.user.id);
        return i.update({ embeds: [jujutsuEmbed(player, jujutsu, log, choices)], components: [mkJujutsuChoiceButtons(choices)] });
      }
      savePlayerSync(i.user.id);
      return i.update({ embeds: [jujutsuEmbed(player, jujutsu, log)], components: [mkJujutsuButtons(player)] });
    }

    // ── PvP 술식 (prefix: "pvp_sm_<battleId>") ──
    if (prefix.startsWith("pvp_sm_")) {
      const battleId = prefix.replace("pvp_sm_", "");
      const session  = pvpSessions[battleId];
      if (!session) return i.update({ content: "PvP 세션을 찾을 수 없습니다.", components: [], embeds: [] });
      if (session.turn !== i.user.id) return i.update({ content: "상대방의 턴입니다!", components: [], embeds: [] });
      const selfInfo   = pvpSelf(session, i.user.id);
      const oppInfo    = pvpOpponent(session, i.user.id);
      const selfPlayer = players[selfInfo.id];
      const oppPlayer  = players[oppInfo.id];
      const oppCh      = CHARACTERS[oppPlayer.active];
      if (session[selfInfo.skillCdKey] > 0) return i.update({ content: `⚡ 술식 쿨다운 중`, components: [], embeds: [] });
      const myWeaken = getWeakenMult(session[selfInfo.statusKey]);
      const dmg = Math.max(1, Math.floor(calcSkillDmgForPlayer(selfPlayer, skill.dmg) * myWeaken));
      session[oppInfo.hpKey] -= dmg; session[selfInfo.skillCdKey] = 5;
      const log = [`✨ **${selfPlayer.name}**의 **[${skillIdx + 1}번] ${skill.name}**! → **${oppPlayer.name}**에게 **${dmg}** 피해!`];
      const oppSObj = { statusEffects: session[oppInfo.statusKey] };
      const sLog = applySkillStatus(skill, oppSObj);
      session[oppInfo.statusKey] = oppSObj.statusEffects; if (sLog.length) log.push(...sLog);
      const p1Dead = session.hp1 <= 0; const p2Dead = session.hp2 <= 0;
      const p1Player = players[session.p1Id]; const p2Player = players[session.p2Id];
      if (p1Dead || p2Dead) {
        const winner = p1Dead ? p2Player : p1Player; const loser = p1Dead ? p1Player : p2Player;
        winner.pvpWins++; winner.crystals += 100; loser.pvpLosses++;
        delete pvpSessions[battleId]; savePlayerSync(winner.id); savePlayerSync(loser.id);
        log.push(`\n🏆 **${winner.name}** 승리! +100💎`);
        return i.update({ embeds: [new EmbedBuilder().setTitle(`⚔️ PvP 종료 — ${winner.name} 승리!`).setColor(0xF5C842).setDescription(log.join("\n"))], components: [] });
      }
      session.turn = oppInfo.id; session.round++;
      return i.update({ embeds: [pvpEmbed(session, log)], components: [mkPvpButtons(battleId, session, oppInfo.id)] });
    }

    return i.update({ content: "❌ 알 수 없는 술식 요청", components: [], embeds: [] });
  }

  // ── DEV 버튼 ──
  if (i.isButton() && i.customId.startsWith("dev_") && isDev(i.user.id)) {
    const parts    = i.customId.split("_");
    const action   = parts[1];
    const targetId = parts.length >= 3 ? parts.slice(2).join("_") : null;
    const target   = targetId ? getPlayer(targetId) : player;
    const tname    = target.name || targetId || "unknown";
    if (action === "heal")    { target.hp = CHARACTERS[target.active].maxHp; savePlayerSync(target.id || targetId); return i.reply({ content: `DEV: **${tname}** HP 풀회복`, ephemeral: true }); }
    if (action === "xp")      { target.xp += 1000; savePlayerSync(target.id || targetId); return i.reply({ content: `DEV: **${tname}** XP +1000`, ephemeral: true }); }
    if (action === "mastery") { target.owned.forEach(id => { target.mastery[id] = 30; }); savePlayerSync(target.id || targetId); return i.reply({ content: `DEV: **${tname}** 숙련도 MAX`, ephemeral: true }); }
    if (action === "crystal") { target.crystals += 9999; savePlayerSync(target.id || targetId); return i.reply({ content: `DEV: **${tname}** 💎 +9999`, ephemeral: true }); }
    if (action === "kill") {
      const tId = targetId || i.user.id;
      if (battles[tId])  battles[tId].enemyHp = 0;
      if (cullings[tId]) cullings[tId].enemyHp = 0;
      if (jujutsus[tId]) jujutsus[tId].enemyHp = 0;
      const tParty = getParty(tId); if (tParty?.cullingSession) tParty.cullingSession.enemyHp = 0;
      const pvpS = getPvpSessionByUser(tId); if (pvpS) { if (pvpS.p1Id === tId) pvpS.hp2 = 0; else pvpS.hp1 = 0; }
      return i.reply({ content: `DEV: 적 즉사`, ephemeral: true });
    }
    return i.reply({ content: "DEV 오류", ephemeral: true });
  }

  // ══════════════════════════════════════════
  // ── PvP 버튼
  // ★★★ 술식은 드롭다운을 i.update()로 교체 — ephemeral reply 없음 ★★★
  // ══════════════════════════════════════════
  if (i.isButton() && i.customId.startsWith("pvp_")) {
    const parts    = i.customId.split("_");
    const action   = parts[1];
    const battleId = parts[2];
    const session  = pvpSessions[battleId];
    if (!session) return i.update({ content: "해당 결투를 찾을 수 없습니다.", components: [], embeds: [] });
    if (session.p1Id !== i.user.id && session.p2Id !== i.user.id) return i.reply({ content: "당신은 이 결투의 참가자가 아닙니다!", ephemeral: true });
    if (session.turn !== i.user.id) return i.reply({ content: "상대방의 턴입니다!", ephemeral: true });

    const selfInfo   = pvpSelf(session, i.user.id);
    const oppInfo    = pvpOpponent(session, i.user.id);
    const selfPlayer = players[selfInfo.id];
    const oppPlayer  = players[oppInfo.id];
    const selfCh     = CHARACTERS[selfPlayer.active];
    const oppCh      = CHARACTERS[oppPlayer.active];
    const log        = [];

    if (action === "surrender") {
      selfPlayer.pvpLosses++; oppPlayer.pvpWins++; oppPlayer.crystals += 100;
      delete pvpSessions[battleId]; savePlayerSync(selfPlayer.id); savePlayerSync(oppPlayer.id);
      return i.update({ embeds: [new EmbedBuilder().setTitle("🏳 항복").setColor(0x94a3b8).setDescription(`**${selfPlayer.name}** 항복 → **${oppPlayer.name}** 승리! +100💎`)], components: [] });
    }

    // 내 상태이상 틱
    const myObj = { hp: session[selfInfo.hpKey], statusEffects: session[selfInfo.statusKey] };
    const myTick = tickStatus(myObj, selfCh.maxHp);
    session[selfInfo.hpKey] = myObj.hp; session[selfInfo.statusKey] = myObj.statusEffects;
    if (myTick.log.length) log.push(...myTick.log.map(l => `[${selfPlayer.name}] ${l}`));
    if (session[selfInfo.skillCdKey]   > 0) session[selfInfo.skillCdKey]--;
    if (session[selfInfo.reverseCdKey] > 0) session[selfInfo.reverseCdKey]--;

    if (isIncapacitated(session[selfInfo.statusKey])) {
      log.push(`⛔ **${selfPlayer.name}**은 상태이상으로 행동할 수 없습니다!`);
      session.turn = oppInfo.id; session.round++;
      return i.update({ embeds: [pvpEmbed(session, log)], components: [mkPvpButtons(battleId, session, oppInfo.id)] });
    }

    const myWeaken = getWeakenMult(session[selfInfo.statusKey]);

    if (action === "attack") {
      const dmg = Math.max(1, Math.floor(calcDmg(selfCh.atk, oppCh.def) * myWeaken));
      session[oppInfo.hpKey] -= dmg;
      log.push(`👊 **${selfPlayer.name}**의 공격! → **${oppPlayer.name}**에게 **${dmg}** 피해!`);
    }
    else if (action === "skill") {
      // ★ 술식 선택 메뉴를 i.update()로 메인 메시지에 표시 (새 창 없음)
      if (session[selfInfo.skillCdKey] > 0) return i.reply({ content: `⚡ 술식 쿨다운 중 (${session[selfInfo.skillCdKey]}턴)`, ephemeral: true });
      const skillRow = mkSkillSelectRow(selfPlayer, `pvp_sm_${battleId}`);
      if (!skillRow) return i.reply({ content: "사용 가능한 스킬이 없습니다!", ephemeral: true });
      return i.update({
        embeds: [pvpEmbed(session, [`🌀 **${selfPlayer.name}** — 사용할 술식을 선택하세요:`])],
        components: [skillRow],
      });
    }
    else if (action === "domain") {
      if (!selfCh.domain) return i.reply({ content: `${selfCh.name}은 영역전개가 없습니다!`, ephemeral: true });
      if (session[selfInfo.domainKey]) return i.reply({ content: "영역전개는 전투당 1회!", ephemeral: true });
      const dmg = Math.floor((400 + selfCh.atk * 2 + getMastery(selfPlayer, selfPlayer.active) * 5) * myWeaken);
      session[oppInfo.hpKey] -= dmg; session[selfInfo.domainKey] = true;
      const oppSObj = { statusEffects: session[oppInfo.statusKey] }; applyStatus(oppSObj, "weaken"); session[oppInfo.statusKey] = oppSObj.statusEffects;
      log.push(`🌌 **${selfPlayer.name}**의 **${selfCh.domain}** 발동! → **${oppPlayer.name}**에게 **${dmg}** 피해! 💔약화 적용!`);
    }
    else if (action === "reverse") {
      if (!REVERSE_CHARS.has(selfPlayer.active)) return i.reply({ content: `❌ **${selfCh.name}**은 반전술식을 사용할 수 없습니다!`, ephemeral: true });
      if (session[selfInfo.reverseCdKey] > 0) return i.reply({ content: `♻ 쿨다운 중 (${session[selfInfo.reverseCdKey]}턴)`, ephemeral: true });
      const heal = Math.floor(80 * selfPlayer.reverseOutput);
      session[selfInfo.hpKey] = Math.min(selfCh.maxHp, session[selfInfo.hpKey] + heal);
      selfPlayer.reverseOutput = Math.min(3.0, selfPlayer.reverseOutput + 0.2);
      session[selfInfo.reverseCdKey] = 3;
      if (session[selfInfo.statusKey].length > 0) { const rm = session[selfInfo.statusKey].shift(); log.push(`♻ **${selfPlayer.name}** 반전술식! HP **+${heal}** | ${STATUS_EFFECTS[rm.id]?.name} 해제!`); }
      else log.push(`♻ **${selfPlayer.name}** 반전술식! HP **+${heal}** 회복`);
    }

    const p1Dead = session.hp1 <= 0; const p2Dead = session.hp2 <= 0;
    const p1Player = players[session.p1Id]; const p2Player = players[session.p2Id];
    if (p1Dead || p2Dead) {
      const winner = p1Dead ? p2Player : p1Player; const loser = p1Dead ? p1Player : p2Player;
      winner.pvpWins++; winner.crystals += 100; loser.pvpLosses++;
      delete pvpSessions[battleId]; savePlayerSync(winner.id); savePlayerSync(loser.id);
      log.push(`\n🏆 **${winner.name}** 승리! +100💎`);
      return i.update({
        embeds: [new EmbedBuilder().setTitle(`⚔️ PvP 결투 종료 — ${winner.name} 승리!`).setColor(0xF5C842).setDescription(log.join("\n"))
          .addFields(
            { name: `${CHARACTERS[p1Player.active].emoji} ${p1Player.name}`, value: `${hpBarText(Math.max(0,session.hp1), CHARACTERS[p1Player.active].maxHp)} ${Math.max(0,session.hp1)}HP`, inline: true },
            { name: `${CHARACTERS[p2Player.active].emoji} ${p2Player.name}`, value: `${hpBarText(Math.max(0,session.hp2), CHARACTERS[p2Player.active].maxHp)} ${Math.max(0,session.hp2)}HP`, inline: true },
          )
        ],
        components: [],
      });
    }
    session.turn = oppInfo.id; session.round++;
    return i.update({ embeds: [pvpEmbed(session, log)], components: [mkPvpButtons(battleId, session, oppInfo.id)] });
  }

  // ── 적 선택 (일반 전투) ──
  if (i.isButton() && i.customId.startsWith("enemy_")) {
    const enemyId = i.customId.replace("enemy_", "");
    const enemy   = ENEMIES.find(e => e.id === enemyId);
    if (!enemy) return i.reply({ content: "오류", ephemeral: true });
    const ch = CHARACTERS[player.active];
    battles[i.user.id] = { enemy: { ...enemy, statusEffects: [] }, enemyHp: enemy.hp, domainUsed: false };
    player.statusEffects = []; player.skillCooldown = 0; player.reverseCooldown = 0;
    const skill = getCurrentSkill(player, player.active);
    return i.update({
      content: "",
      embeds: [new EmbedBuilder()
        .setTitle(`⚔️ ${ch.emoji} ${ch.name} VS ${enemy.emoji} ${enemy.name}`)
        .setColor(0xe63946)
        .addFields(
          { name: `${ch.emoji} 내 HP`, value: `${hpBar(player.hp, ch.maxHp)} \`${player.hp}/${ch.maxHp}\``, inline: true },
          { name: `${enemy.emoji} 적 HP`, value: `${hpBar(enemy.hp, enemy.hp)} \`${enemy.hp}/${enemy.hp}\``, inline: true },
          { name: "🔥 현재 스킬", value: `**${skill.name}** — ${skill.desc}`, inline: false },
          { name: "🌌 영역전개", value: ch.domain || "없음", inline: true },
          { name: "🌀 술식 안내", value: "🌀 술식 버튼 → 드롭다운으로 스킬 선택 (5턴 쿨다운)\n♻ 반전술식은 3턴마다 사용 가능", inline: false },
        )
        .setFooter({ text: "버튼으로 행동을 선택하세요!" })
      ],
      components: [mkBattleButtons(player)],
    });
  }

  // ── 일반 전투 버튼 (b_) ──
  if (i.isButton() && i.customId.startsWith("b_")) {
    if (!battle) return i.reply({ content: "전투 중이 아닙니다! `!전투`로 시작하세요.", ephemeral: true });
    const ch = CHARACTERS[player.active]; const enemy = battle.enemy; const log = [];

    if (i.customId === "b_skill") {
      if (player.skillCooldown > 0) return i.reply({ content: `⚡ 술식 쿨다운 중! (${player.skillCooldown}턴)`, ephemeral: true });
      const skillRow = mkSkillSelectRow(player, "bs");
      if (!skillRow) return i.reply({ content: "사용 가능한 술식이 없습니다!", ephemeral: true });
      // ★ i.update()로 메인 메시지에 드롭다운 표시 (새 창 없음)
      return i.update({
        embeds: [new EmbedBuilder()
          .setTitle(`🌀 술식 선택 — ${ch.name}`)
          .setColor(0x7c5cfc)
          .setDescription("사용할 술식을 선택하세요. 선택 후 즉시 발동됩니다!")
          .addFields(
            { name: `${ch.emoji} 내 HP`, value: `${hpBar(player.hp, ch.maxHp)} \`${Math.max(0, player.hp)}/${ch.maxHp}\``, inline: true },
            { name: `${enemy.emoji} 적 HP`, value: `${hpBar(battle.enemyHp, enemy.hp)} \`${Math.max(0, battle.enemyHp)}/${enemy.hp}\``, inline: true },
          )
        ],
        components: [skillRow],
      });
    }

    { const pObj = { hp: player.hp, statusEffects: player.statusEffects || [] }; const tick = tickStatus(pObj, ch.maxHp); player.hp = pObj.hp; player.statusEffects = pObj.statusEffects; if (tick.log.length) log.push(...tick.log.map(l => `[나] ${l}`)); }
    tickCooldowns(player);

    if (isIncapacitated(player.statusEffects)) {
      log.push(`⛔ **${ch.name}**은 상태이상으로 행동할 수 없습니다!`);
      if (!isIncapacitated(enemy.statusEffects || [])) { const dmg = calcDmg(enemy.atk, ch.def); player.hp -= dmg; log.push(`💥 **${enemy.name}**의 반격! → **${dmg}** 피해!`); }
      savePlayerSync(i.user.id);
      if (player.hp <= 0) { player.hp = 0; player.losses++; delete battles[i.user.id]; savePlayerSync(i.user.id); log.push(`\n💀 패배...`); return i.update({ embeds: [new EmbedBuilder().setTitle("💀 전투 패배").setColor(0xe63946).setDescription(log.join("\n"))], components: [] }); }
      return i.update({ embeds: [new EmbedBuilder().setTitle(`⚔️ ${ch.name} VS ${enemy.emoji} ${enemy.name}`).setColor(0x7c5cfc).setDescription(log.join("\n")).addFields({ name: `${ch.emoji} 내 HP`, value: `${hpBar(player.hp, ch.maxHp)} \`${Math.max(0,player.hp)}/${ch.maxHp}\`\n상태: ${statusStr(player.statusEffects)}`, inline: true }, { name: `${enemy.emoji} 적 HP`, value: `${hpBar(battle.enemyHp, enemy.hp)} \`${Math.max(0,battle.enemyHp)}/${enemy.hp}\``, inline: true })], components: [mkBattleButtons(player)] });
    }

    if (i.customId === "b_attack") {
      const dmg = calcDmgForPlayer(player, enemy.def);
      battle.enemyHp -= dmg;
      log.push(`👊 **${ch.name}**의 공격! → **${enemy.name}**에게 **${dmg}** 피해!${isMakiAwakened(player) ? " 🔥" : ""}`);
    }
    else if (i.customId === "b_domain") {
      if (!ch.domain) return i.reply({ content: `${ch.name}은 영역전개가 없습니다!`, ephemeral: true });
      if (battle.domainUsed) return i.reply({ content: "영역전개는 전투당 1회!", ephemeral: true });
      const dmg = Math.floor(400 + ch.atk * 2 + getMastery(player, player.active) * 5);
      battle.enemyHp -= dmg; battle.domainUsed = true;
      if (!enemy.statusEffects) enemy.statusEffects = [];
      applyStatus(enemy, "weaken");
      log.push(`🌌 **${ch.domain}** 발동! → **${enemy.name}**에게 **${dmg}** 피해! 💔약화 적용!`);
    }
    else if (i.customId === "b_reverse") {
      if (!REVERSE_CHARS.has(player.active)) return i.reply({ content: `❌ **${ch.name}**은 반전술식을 사용할 수 없습니다!`, ephemeral: true });
      if (player.reverseCooldown > 0) return i.reply({ content: `♻ 쿨다운 중! (${player.reverseCooldown}턴)`, ephemeral: true });
      const heal = Math.floor(80 * player.reverseOutput);
      player.hp = Math.min(ch.maxHp, player.hp + heal); player.reverseOutput = Math.min(3.0, player.reverseOutput + 0.2); player.reverseCooldown = 3;
      if (player.statusEffects.length > 0) { const rm = player.statusEffects.shift(); log.push(`♻ 반전술식! HP **+${heal}** 회복 | **${STATUS_EFFECTS[rm.id]?.name}** 해제!`); }
      else log.push(`♻ 반전술식! HP **+${heal}** 회복`);
    }
    else if (i.customId === "b_run") {
      if (Math.random() < 0.6) { player.statusEffects = []; player.skillCooldown = 0; player.reverseCooldown = 0; delete battles[i.user.id]; savePlayerSync(i.user.id); return i.update({ content: "🏃 도주 성공!", embeds: [], components: [] }); }
      log.push("❌ 도주 실패!");
    }

    if (!["b_reverse", "b_run"].includes(i.customId)) {
      const eObj = { hp: battle.enemyHp, statusEffects: enemy.statusEffects || [] }; const eTick = tickStatus(eObj, enemy.hp); battle.enemyHp = eObj.hp; enemy.statusEffects = eObj.statusEffects;
      if (eTick.log.length) log.push(...eTick.log.map(l => `[${enemy.name}] ${l}`));
    }

    if (battle.enemyHp > 0 && i.customId !== "b_reverse") {
      if (!isIncapacitated(enemy.statusEffects || [])) {
        const dmg = calcDmg(enemy.atk, ch.def); player.hp -= dmg;
        log.push(`💥 **${enemy.name}**의 반격! → **${ch.name}**에게 **${dmg}** 피해!`);
        if (enemy.statusAttack && Math.random() < enemy.statusAttack.chance) { applyStatus(player, enemy.statusAttack.statusId); log.push(`${STATUS_EFFECTS[enemy.statusAttack.statusId].emoji} **${enemy.name}**의 ${STATUS_EFFECTS[enemy.statusAttack.statusId].name} 공격!`); }
        if (!battle._makiAwakened && isMakiAwakened(player)) { battle._makiAwakened = true; log.push("🔥 **천여주박 각성!!**"); }
      } else log.push(`⛔ **${enemy.name}**은 상태이상으로 반격하지 못했습니다!`);
    }

    const pDead = player.hp <= 0; const eDead = battle.enemyHp <= 0;
    if (eDead) { player.xp += enemy.xp; player.crystals += enemy.crystals; player.wins++; if (!player.mastery[player.active]) player.mastery[player.active] = 0; player.mastery[player.active] += enemy.masteryXp; player.statusEffects = []; const newSkill = getCurrentSkill(player, player.active); delete battles[i.user.id]; savePlayerSync(i.user.id); log.push(`\n🏆 승리! +**${enemy.xp}** XP | +**${enemy.crystals}**💎 | 숙련도 **+${enemy.masteryXp}**`); log.push(`🔥 현재 스킬: **${newSkill.name}**`); }
    else if (pDead) { player.hp = 0; player.losses++; player.statusEffects = []; delete battles[i.user.id]; savePlayerSync(i.user.id); log.push(`\n💀 패배...`); }
    else savePlayerSync(i.user.id);
    const over = pDead || eDead;
    return i.update({
      embeds: [new EmbedBuilder()
        .setTitle(`⚔️ ${ch.name} VS ${enemy.emoji} ${enemy.name}`)
        .setColor(pDead ? 0xe63946 : eDead ? 0xF5C842 : (isMakiAwakened(player) && !over ? 0xFF2200 : 0x7c5cfc))
        .setDescription(log.join("\n"))
        .addFields(
          { name: `${ch.emoji} 내 HP`, value: `${hpBar(player.hp, ch.maxHp)} \`${Math.max(0,player.hp)}/${ch.maxHp}\`${isMakiAwakened(player) && !over ? " 🔥" : ""}${over ? "" : "\n상태: " + statusStr(player.statusEffects)}`, inline: true },
          { name: `${enemy.emoji} 적 HP`, value: `${hpBar(battle.enemyHp, enemy.hp)} \`${Math.max(0,battle.enemyHp)}/${enemy.hp}\`${over ? "" : "\n상태: " + statusStr(enemy.statusEffects || [])}`, inline: true },
        )
        .setFooter({ text: over ? "전투 종료!" : `영역: ${ch.domain || "없음"} | ⚡술식: ${player.skillCooldown > 0 ? player.skillCooldown + "턴" : "가능"} | ♻반전: ${player.reverseCooldown > 0 ? player.reverseCooldown + "턴" : "가능"}` })
      ],
      components: over ? [] : [mkBattleButtons(player)],
    });
  }

  // ── 컬링 버튼 (c_) ──
  if (i.isButton() && i.customId.startsWith("c_")) {
    if (!culling) return i.reply({ content: "컬링 게임 진행 중이 아닙니다! `!컬링`으로 시작하세요.", ephemeral: true });
    const ch = CHARACTERS[player.active]; const log = [];

    if (i.customId === "c_escape") {
      player.xp += culling.totalXp; player.crystals += culling.totalCrystals;
      if (!player.mastery[player.active]) player.mastery[player.active] = 0;
      player.mastery[player.active] += culling.totalMastery;
      if (culling.wave - 1 > player.cullingBest) player.cullingBest = culling.wave - 1;
      player.statusEffects = []; player.skillCooldown = 0; player.reverseCooldown = 0;
      delete cullings[i.user.id]; savePlayerSync(i.user.id);
      return i.update({ embeds: [new EmbedBuilder().setTitle("🏳 컬링 게임 철수").setColor(0x7c5cfc).setDescription(`WAVE **${culling.wave}** 에서 철수!\n+**${culling.totalXp}** XP | +**${culling.totalCrystals}**💎 | 최고기록: WAVE **${player.cullingBest}**`)], components: [] });
    }

    if (i.customId === "c_skill") {
      if (player.skillCooldown > 0) return i.reply({ content: `⚡ 술식 쿨다운 중! (${player.skillCooldown}턴)`, ephemeral: true });
      const skillRow = mkSkillSelectRow(player, "cs");
      if (!skillRow) return i.reply({ content: "사용 가능한 술식이 없습니다!", ephemeral: true });
      return i.update({
        embeds: [new EmbedBuilder().setTitle(`🌀 술식 선택 — ${ch.name}`).setColor(0x7c5cfc).setDescription("사용할 술식을 선택하세요!")
          .addFields({ name: `${ch.emoji} 내 HP`, value: `${hpBar(player.hp, ch.maxHp)} \`${Math.max(0,player.hp)}/${ch.maxHp}\``, inline: true }, { name: `${culling.currentEnemy.emoji} 적 HP`, value: `${hpBar(culling.enemyHp, culling.currentEnemy.hp)} \`${Math.max(0,culling.enemyHp)}/${culling.currentEnemy.hp}\``, inline: true })
        ],
        components: [skillRow],
      });
    }

    const enemy = culling.currentEnemy;
    if (!culling._makiAwakened && isMakiAwakened(player)) { culling._makiAwakened = true; log.push("🔥 **천여주박 각성!!**"); }
    { const pObj = { hp: player.hp, statusEffects: player.statusEffects || [] }; const tick = tickStatus(pObj, ch.maxHp); player.hp = pObj.hp; player.statusEffects = pObj.statusEffects; if (tick.log.length) log.push(...tick.log.map(l => `[나] ${l}`)); }
    tickCooldowns(player);

    if (isIncapacitated(player.statusEffects)) {
      log.push(`⛔ **${ch.name}**은 상태이상으로 행동할 수 없습니다!`);
      const edm = calcDmg(enemy.atk, ch.def); player.hp -= edm; log.push(`💥 **${enemy.name}**의 반격! → **${edm}** 피해!`);
      savePlayerSync(i.user.id);
      if (player.hp <= 0) return handleCullingDeath(i, player, culling, log);
      return i.update({ embeds: [cullingEmbed(player, culling, log)], components: [mkCullingButtons(player)] });
    }

    if (i.customId === "c_attack") { const dmg = calcDmgForPlayer(player, enemy.def); culling.enemyHp -= dmg; log.push(`👊 **${ch.name}**의 공격! → **${enemy.name}**에게 **${dmg}** 피해!${isMakiAwakened(player) ? " 🔥" : ""}`); }
    else if (i.customId === "c_domain") {
      if (!ch.domain) return i.reply({ content: `${ch.name}은 영역전개가 없습니다!`, ephemeral: true });
      if (culling.domainUsed) return i.reply({ content: "영역전개는 컬링 게임당 1회!", ephemeral: true });
      const dmg = Math.floor(400 + ch.atk * 2 + getMastery(player, player.active) * 5);
      culling.enemyHp -= dmg; culling.domainUsed = true;
      if (!enemy.statusEffects) enemy.statusEffects = [];
      applyStatus(enemy, "weaken");
      log.push(`🌌 **${ch.domain}** 발동! → **${dmg}** 피해! 💔약화 적용!`);
    }
    else if (i.customId === "c_reverse") {
      if (!REVERSE_CHARS.has(player.active)) return i.reply({ content: `❌ **${ch.name}**은 반전술식을 사용할 수 없습니다!`, ephemeral: true });
      if (player.reverseCooldown > 0) return i.reply({ content: `♻ 쿨다운 중! (${player.reverseCooldown}턴)`, ephemeral: true });
      const heal = Math.floor(80 * player.reverseOutput);
      player.hp = Math.min(ch.maxHp, player.hp + heal); player.reverseOutput = Math.min(3.0, player.reverseOutput + 0.2); player.reverseCooldown = 3;
      if (player.statusEffects.length > 0) { const rm = player.statusEffects.shift(); log.push(`♻ 반전술식! HP **+${heal}** 회복 | **${STATUS_EFFECTS[rm.id]?.name}** 해제!`); }
      else log.push(`♻ 반전술식! HP **+${heal}** 회복`);
    }

    if (i.customId !== "c_reverse") {
      const eObj = { hp: culling.enemyHp, statusEffects: enemy.statusEffects || [] }; const eTick = tickStatus(eObj, enemy.hp); culling.enemyHp = eObj.hp; enemy.statusEffects = eObj.statusEffects;
      if (eTick.log.length) log.push(...eTick.log.map(l => `[${enemy.name}] ${l}`));
    }

    if (culling.enemyHp > 0 && i.customId !== "c_reverse") {
      if (!isIncapacitated(enemy.statusEffects)) {
        const dmg = calcDmg(enemy.atk, ch.def); player.hp -= dmg; log.push(`💥 **${enemy.name}**의 반격! → **${dmg}** 피해!`);
        if (enemy.statusAttack && Math.random() < enemy.statusAttack.chance) { applyStatus(player, enemy.statusAttack.statusId); log.push(`${STATUS_EFFECTS[enemy.statusAttack.statusId].emoji} **${enemy.name}**의 ${STATUS_EFFECTS[enemy.statusAttack.statusId].name} 공격!`); }
      } else log.push(`⛔ **${enemy.name}**은 상태이상으로 반격하지 못했습니다!`);
    }

    if (player.hp <= 0) return handleCullingDeath(i, player, culling, log);

    if (culling.enemyHp <= 0) {
      culling.kills++; culling.totalXp += enemy.xp; culling.totalCrystals += enemy.crystals; culling.totalMastery += enemy.masteryXp;
      log.push(`✅ **${enemy.name}** 처치! +${enemy.xp} XP | +${enemy.crystals}💎`);
      if (culling.wave > player.cullingBest) { player.cullingBest = culling.wave; log.push(`🏆 **최고기록 갱신!** WAVE ${player.cullingBest}`); }
      const nextWave = culling.wave + 1; const nextEnemy = pickCullingEnemy(nextWave);
      culling.wave = nextWave; culling.currentEnemy = nextEnemy; culling.enemyHp = nextEnemy.hp;
      log.push(`\n🌊 **WAVE ${nextWave}** 돌입! ${nextEnemy.emoji} **${nextEnemy.name}** 등장!`);
      savePlayerSync(i.user.id);
      return i.update({ embeds: [cullingEmbed(player, culling, log)], components: [mkCullingButtons(player)] });
    }
    savePlayerSync(i.user.id);
    return i.update({ embeds: [cullingEmbed(player, culling, log)], components: [mkCullingButtons(player)] });
  }

  // ── 사멸회유 적 선택 (jc_) ──
  if (i.isButton() && i.customId.startsWith("jc_")) {
    if (!jujutsu || jujutsu.phase !== "choose") return i.reply({ content: "선택할 수 없는 상태입니다.", ephemeral: true });
    const idx = parseInt(i.customId.replace("jc_", ""));
    const choice = jujutsu.pendingChoices[idx];
    if (!choice) return i.reply({ content: "선택 오류!", ephemeral: true });
    jujutsu.currentEnemy = { ...choice }; jujutsu.enemyHp = choice.hp; jujutsu.pendingChoices = null; jujutsu.phase = "fight";
    const log = [`⚔️ **${choice.emoji} ${choice.name}** 선택! HP:${choice.hp} | +${choice.points}포인트`];
    savePlayerSync(i.user.id);
    return i.update({ embeds: [jujutsuEmbed(player, jujutsu, log)], components: [mkJujutsuButtons(player)] });
  }

  // ── 사멸회유 버튼 (j_) ──
  if (i.isButton() && i.customId.startsWith("j_")) {
    if (!jujutsu) return i.reply({ content: "사멸회유 진행 중이 아닙니다! `!사멸회유`로 시작하세요.", ephemeral: true });
    if (jujutsu.phase === "choose") return i.reply({ content: "먼저 적을 선택하세요!", ephemeral: true });
    const ch = CHARACTERS[player.active]; const enemy = jujutsu.currentEnemy; const log = [];

    if (i.customId === "j_escape") {
      if (jujutsu.points > player.jujutsuBest) player.jujutsuBest = jujutsu.points;
      player.xp += jujutsu.totalXp; player.crystals += jujutsu.totalCrystals;
      if (!player.mastery[player.active]) player.mastery[player.active] = 0;
      player.mastery[player.active] += jujutsu.totalMastery;
      player.statusEffects = []; player.skillCooldown = 0; player.reverseCooldown = 0;
      delete jujutsus[i.user.id]; savePlayerSync(i.user.id);
      return i.update({ embeds: [new EmbedBuilder().setTitle("🏳 사멸회유 철수").setColor(0x7c5cfc).setDescription(`**${jujutsu.points}포인트** 획득 후 철수!\n+**${jujutsu.totalXp}** XP | +**${jujutsu.totalCrystals}**💎\n최고기록: **${player.jujutsuBest}**포인트`)], components: [] });
    }

    if (i.customId === "j_skill") {
      if (player.skillCooldown > 0) return i.reply({ content: `⚡ 술식 쿨다운 중! (${player.skillCooldown}턴)`, ephemeral: true });
      const skillRow = mkSkillSelectRow(player, "js");
      if (!skillRow) return i.reply({ content: "사용 가능한 술식이 없습니다!", ephemeral: true });
      return i.update({
        embeds: [new EmbedBuilder().setTitle(`🌀 술식 선택 — ${ch.name}`).setColor(0x7c5cfc).setDescription("사용할 술식을 선택하세요!")
          .addFields({ name: `${ch.emoji} 내 HP`, value: `${hpBar(player.hp, ch.maxHp)} \`${Math.max(0,player.hp)}/${ch.maxHp}\``, inline: true }, { name: `${enemy.emoji} 적 HP`, value: `${hpBar(jujutsu.enemyHp, enemy.hp)} \`${Math.max(0,jujutsu.enemyHp)}/${enemy.hp}\``, inline: true })
        ],
        components: [skillRow],
      });
    }

    if (!jujutsu._makiAwakened && isMakiAwakened(player)) { jujutsu._makiAwakened = true; log.push("🔥 **천여주박 각성!!**"); }
    { const pObj = { hp: player.hp, statusEffects: player.statusEffects || [] }; const tick = tickStatus(pObj, ch.maxHp); player.hp = pObj.hp; player.statusEffects = pObj.statusEffects; if (tick.log.length) log.push(...tick.log.map(l => `[나] ${l}`)); }
    tickCooldowns(player);

    if (isIncapacitated(player.statusEffects)) {
      log.push(`⛔ 상태이상으로 행동할 수 없습니다!`);
      const edm = calcDmg(enemy.atk, ch.def); player.hp -= edm; log.push(`💥 **${enemy.name}**의 반격! → **${edm}** 피해!`);
      savePlayerSync(i.user.id);
      if (player.hp <= 0) return handleJujutsuDeath(i, player, jujutsu, log);
      return i.update({ embeds: [jujutsuEmbed(player, jujutsu, log)], components: [mkJujutsuButtons(player)] });
    }

    if (i.customId === "j_attack") { const dmg = calcDmgForPlayer(player, enemy.def); jujutsu.enemyHp -= dmg; log.push(`👊 **${ch.name}**의 공격! → **${enemy.name}**에게 **${dmg}** 피해!${isMakiAwakened(player) ? " 🔥" : ""}`); }
    else if (i.customId === "j_domain") {
      if (!ch.domain) return i.reply({ content: `${ch.name}은 영역전개가 없습니다!`, ephemeral: true });
      if (jujutsu.domainUsed) return i.reply({ content: "영역전개는 사멸회유당 1회!", ephemeral: true });
      const dmg = Math.floor(400 + ch.atk * 2 + getMastery(player, player.active) * 5);
      jujutsu.enemyHp -= dmg; jujutsu.domainUsed = true;
      if (!enemy.statusEffects) enemy.statusEffects = [];
      applyStatus(enemy, "weaken"); log.push(`🌌 **${ch.domain}** 발동! → **${dmg}** 피해! 💔약화 적용!`);
    }
    else if (i.customId === "j_reverse") {
      if (!REVERSE_CHARS.has(player.active)) return i.reply({ content: `❌ **${ch.name}**은 반전술식을 사용할 수 없습니다!`, ephemeral: true });
      if (player.reverseCooldown > 0) return i.reply({ content: `♻ 쿨다운 중! (${player.reverseCooldown}턴)`, ephemeral: true });
      const heal = Math.floor(80 * player.reverseOutput);
      player.hp = Math.min(ch.maxHp, player.hp + heal); player.reverseOutput = Math.min(3.0, player.reverseOutput + 0.2); player.reverseCooldown = 3;
      if (player.statusEffects.length > 0) { const rm = player.statusEffects.shift(); log.push(`♻ 반전술식! HP **+${heal}** 회복 | **${STATUS_EFFECTS[rm.id]?.name}** 해제!`); }
      else log.push(`♻ 반전술식! HP **+${heal}** 회복`);
    }

    if (i.customId !== "j_reverse") {
      const eObj = { hp: jujutsu.enemyHp, statusEffects: enemy.statusEffects || [] }; const eTick = tickStatus(eObj, enemy.hp); jujutsu.enemyHp = eObj.hp; enemy.statusEffects = eObj.statusEffects;
      if (eTick.log.length) log.push(...eTick.log.map(l => `[${enemy.name}] ${l}`));
    }

    if (jujutsu.enemyHp > 0 && i.customId !== "j_reverse") {
      if (!isIncapacitated(enemy.statusEffects)) {
        const dmg = calcDmg(enemy.atk, ch.def); player.hp -= dmg; log.push(`💥 **${enemy.name}**의 반격! → **${dmg}** 피해!`);
        if (enemy.statusAttack && Math.random() < enemy.statusAttack.chance) { applyStatus(player, enemy.statusAttack.statusId); log.push(`${STATUS_EFFECTS[enemy.statusAttack.statusId].emoji} **${enemy.name}**의 ${STATUS_EFFECTS[enemy.statusAttack.statusId].name} 공격!`); }
      } else log.push(`⛔ **${enemy.name}**은 상태이상으로 반격하지 못했습니다!`);
    }

    if (player.hp <= 0) return handleJujutsuDeath(i, player, jujutsu, log);

    if (jujutsu.enemyHp <= 0) {
      jujutsu.kills++; jujutsu.totalXp += enemy.xp; jujutsu.totalCrystals += enemy.crystals; jujutsu.totalMastery += enemy.masteryXp; jujutsu.points += enemy.points;
      log.push(`✅ **${enemy.name}** 처치! +${enemy.xp} XP | +${enemy.crystals}💎 | **+${enemy.points}포인트** (현재: ${jujutsu.points}/15)`);
      if (jujutsu.points >= 15) {
        player.crystals += 500; player.xp += 1000;
        if (jujutsu.points > player.jujutsuBest) player.jujutsuBest = jujutsu.points;
        player.statusEffects = []; player.skillCooldown = 0; player.reverseCooldown = 0;
        delete jujutsus[i.user.id]; savePlayerSync(i.user.id);
        log.push(`\n🎉 **15포인트 달성!!** +1000 XP | +500💎 보너스!`);
        return i.update({ embeds: [new EmbedBuilder().setTitle("🎉 사멸회유 완료 — 15포인트 달성!").setColor(0xF5C842).setDescription(log.join("\n"))], components: [] });
      }
      if (jujutsu.points > player.jujutsuBest) player.jujutsuBest = jujutsu.points;
      const nextWave = jujutsu.wave + 1; const choices = generateJujutsuChoices(nextWave);
      jujutsu.wave = nextWave; jujutsu.currentEnemy = null; jujutsu.enemyHp = 0; jujutsu.pendingChoices = choices; jujutsu.phase = "choose";
      log.push(`\n🎯 **WAVE ${nextWave}** — 다음 적을 선택하세요!`);
      savePlayerSync(i.user.id);
      return i.update({ embeds: [jujutsuEmbed(player, jujutsu, log, choices)], components: [mkJujutsuChoiceButtons(choices)] });
    }
    savePlayerSync(i.user.id);
    return i.update({ embeds: [jujutsuEmbed(player, jujutsu, log)], components: [mkJujutsuButtons(player)] });
  }

  // ── 파티 컬링 버튼 (pc_) ──
  if (i.isButton() && i.customId.startsWith("pc_")) {
    const pid = getPartyId(i.user.id);
    if (!pid) return i.reply({ content: "파티에 속해 있지 않습니다!", ephemeral: true });
    const party = parties[pid];
    if (!party.cullingSession) return i.reply({ content: "파티 컬링 게임이 진행 중이 아닙니다!", ephemeral: true });
    const session = party.cullingSession;
    const ch    = CHARACTERS[player.active];
    const skill = getCurrentSkill(player, player.active);
    const log   = [];

    if (i.customId === "pc_escape") {
      if (i.user.id !== party.leader) return i.reply({ content: "파티 리더만 철수할 수 있습니다!", ephemeral: true });
      for (const uid of party.members) {
        const p = players[uid]; if (!p) continue;
        p.xp += session.totalXp; p.crystals += session.totalCrystals;
        if (!p.mastery[p.active]) p.mastery[p.active] = 0;
        p.mastery[p.active] += session.totalMastery;
        if (session.wave - 1 > p.cullingBest) p.cullingBest = session.wave - 1;
        p.statusEffects = []; p.skillCooldown = 0; p.reverseCooldown = 0;
        savePlayerSync(uid);
      }
      party.cullingSession = null;
      return i.update({ embeds: [new EmbedBuilder().setTitle("🏳 [파티] 컬링 게임 철수").setColor(0x7c5cfc).setDescription(`WAVE **${session.wave}** 에서 철수! 파티원 전원 보상 지급`)], components: [] });
    }

    const enemy = session.currentEnemy;
    if (!enemy.statusEffects) enemy.statusEffects = [];
    { const pObj = { hp: player.hp, statusEffects: player.statusEffects || [] }; const tick = tickStatus(pObj, ch.maxHp); player.hp = pObj.hp; player.statusEffects = pObj.statusEffects; if (tick.log.length) log.push(...tick.log.map(l => `[${player.name}] ${l}`)); }
    tickCooldowns(player);

    if (i.customId === "pc_attack") {
      if (isIncapacitated(player.statusEffects)) log.push(`⛔ **${player.name}**은 상태이상으로 행동할 수 없습니다!`);
      else { const dmg = calcDmgForPlayer(player, enemy.def); session.enemyHp -= dmg; log.push(`👊 **${player.name}**의 공격! → **${dmg}** 피해!${isMakiAwakened(player) ? " 🔥" : ""}`); }
    }
    else if (i.customId === "pc_skill") {
      if (isIncapacitated(player.statusEffects)) return i.reply({ content: "상태이상으로 행동할 수 없습니다!", ephemeral: true });
      if (player.skillCooldown > 0) return i.reply({ content: `⚡ 술식 쿨다운 중 (${player.skillCooldown}턴)`, ephemeral: true });
      const dmg = calcSkillDmgForPlayer(player, skill.dmg); session.enemyHp -= dmg; player.skillCooldown = 5;
      log.push(`✨ **${player.name}**의 **${skill.name}**! → **${dmg}** 피해!`);
      const eObj = { statusEffects: enemy.statusEffects }; const sLog = applySkillStatus(skill, eObj); enemy.statusEffects = eObj.statusEffects; if (sLog.length) log.push(...sLog);
    }
    else if (i.customId === "pc_domain") {
      if (isIncapacitated(player.statusEffects)) return i.reply({ content: "상태이상으로 행동할 수 없습니다!", ephemeral: true });
      if (!ch.domain) return i.reply({ content: `${ch.name}은 영역전개가 없습니다!`, ephemeral: true });
      if (session.domainUsed) return i.reply({ content: "영역전개는 파티 컬링당 1회!", ephemeral: true });
      const dmg = Math.floor(400 + ch.atk * 2 + getMastery(player, player.active) * 5);
      session.enemyHp -= dmg; session.domainUsed = true; applyStatus(enemy, "weaken");
      log.push(`🌌 **${player.name}**의 **${ch.domain}** 발동! → **${dmg}** 피해! 💔약화 적용!`);
    }
    else if (i.customId === "pc_reverse") {
      if (!REVERSE_CHARS.has(player.active)) return i.reply({ content: `❌ **${ch.name}**은 반전술식을 사용할 수 없습니다!`, ephemeral: true });
      if (player.reverseCooldown > 0) return i.reply({ content: `♻ 쿨다운 중! (${player.reverseCooldown}턴)`, ephemeral: true });
      const heal = Math.floor(80 * player.reverseOutput);
      player.hp = Math.min(ch.maxHp, player.hp + heal); player.reverseOutput = Math.min(3.0, player.reverseOutput + 0.2); player.reverseCooldown = 3;
      if (player.statusEffects.length > 0) { const rm = player.statusEffects.shift(); log.push(`♻ **${player.name}**의 반전술식! HP **+${heal}** | ${STATUS_EFFECTS[rm.id]?.name} 해제!`); }
      else log.push(`♻ **${player.name}**의 반전술식! HP **+${heal}** 회복`);
    }

    if (!["pc_reverse", "pc_escape"].includes(i.customId)) {
      const eObj = { hp: session.enemyHp, statusEffects: enemy.statusEffects }; const eTick = tickStatus(eObj, enemy.hp); session.enemyHp = eObj.hp; enemy.statusEffects = eObj.statusEffects;
      if (eTick.log.length) log.push(...eTick.log.map(l => `[${enemy.name}] ${l}`));
    }

    if (session.enemyHp > 0 && !["pc_reverse", "pc_escape"].includes(i.customId)) {
      if (!isIncapacitated(enemy.statusEffects)) {
        const alive = party.members.filter(uid => players[uid] && players[uid].hp > 0);
        if (alive.length > 0) {
          const tgt = players[alive[Math.floor(Math.random() * alive.length)]]; const tch = CHARACTERS[tgt.active];
          const dmg = calcDmg(enemy.atk, tch.def); tgt.hp -= dmg;
          log.push(`💥 **${enemy.name}**의 반격! → **${tgt.name}**에게 **${dmg}** 피해!${tgt.hp <= 0 ? ` 💀 **${tgt.name}** 전사!` : ""}`);
          if (tgt.hp < 0) tgt.hp = 0;
          if (enemy.statusAttack && Math.random() < enemy.statusAttack.chance) { applyStatus(tgt, enemy.statusAttack.statusId); log.push(`${STATUS_EFFECTS[enemy.statusAttack.statusId].emoji} **${tgt.name}**에게 상태이상 적용!`); }
        }
      } else log.push(`⛔ **${enemy.name}**은 상태이상으로 반격하지 못했습니다!`);
    }

    const allDead   = party.members.every(uid => !players[uid] || players[uid].hp <= 0);
    const enemyDead = session.enemyHp <= 0;

    if (allDead) {
      for (const uid of party.members) {
        const p = players[uid]; if (!p) continue;
        p.hp = 0; p.losses++; p.xp += Math.floor(session.totalXp / 2); p.crystals += Math.floor(session.totalCrystals / 2);
        if (!p.mastery[p.active]) p.mastery[p.active] = 0; p.mastery[p.active] += Math.floor(session.totalMastery / 2);
        if (session.wave - 1 > p.cullingBest) p.cullingBest = session.wave - 1;
        p.statusEffects = []; p.skillCooldown = 0; p.reverseCooldown = 0; savePlayerSync(uid);
      }
      party.cullingSession = null;
      log.push(`\n💀 **파티 전멸!** WAVE **${session.wave}**`);
      return i.update({ embeds: [new EmbedBuilder().setTitle(`💀 [파티] 컬링 실패 — WAVE ${session.wave}`).setColor(0xe63946).setDescription(log.join("\n"))], components: [] });
    }

    for (const uid of party.members) savePlayerSync(uid);

    if (enemyDead) {
      session.kills++; session.totalXp += enemy.xp; session.totalCrystals += enemy.crystals; session.totalMastery += enemy.masteryXp;
      log.push(`✅ **${enemy.name}** 처치! +${enemy.xp} XP | +${enemy.crystals}💎`);
      const nextWave = session.wave + 1; const nextEnemy = pickCullingEnemy(nextWave);
      session.wave = nextWave; session.currentEnemy = nextEnemy; session.enemyHp = nextEnemy.hp;
      log.push(`\n🌊 **WAVE ${nextWave}** 돌입! ${nextEnemy.emoji} **${nextEnemy.name}** 등장!`);
      return i.update({ embeds: [partyCullingEmbed(party, session, log)], components: [mkPartyCullingButtons()] });
    }
    return i.update({ embeds: [partyCullingEmbed(party, session, log)], components: [mkPartyCullingButtons()] });
  }
});

// ════════════════════════════════════════════════════════
// ── 봇 시작
// ════════════════════════════════════════════════════════
client.once("ready", async () => {
  console.log(`✅ ${client.user.tag} 온라인!`);
  try {
    await dbInit();
    players = await dbLoad();
  } catch (e) {
    console.error("DB 초기화 실패:", e.message);
    players = {};
  }
  client.user.setActivity("주술회전 RPG | !도움", { type: 0 });
  console.log("🔱 주술회전 RPG 봇 가동 완료!");
});

client.login(TOKEN);
