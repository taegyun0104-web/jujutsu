require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const {
  Client, GatewayIntentBits, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require("discord.js");

// ════════════════════════════════════════════════════════
// ── HTTP 헬스체크
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
  const req = [1, 5, 10, 15];
  return fingers >= req[skillIndex];
}

// ════════════════════════════════════════════════════════
// ── 코가네 펫 시스템
// ════════════════════════════════════════════════════════
const KOGANE_GRADES = {
  "전설": { color: 0xF5C842, emoji: "🌟", stars: "★★★★★", rate: 0.5, atkBonus: 0.25, defBonus: 0.20, hpBonus: 0.20, xpBonus: 0.30, crystalBonus: 0.25, skill: "황금 포효", passiveDesc: "ATK+25% DEF+20% HP+20%" },
  "특급": { color: 0xff8c00, emoji: "🔶", stars: "★★★★☆", rate: 2.0, atkBonus: 0.18, defBonus: 0.15, hpBonus: 0.15, xpBonus: 0.20, crystalBonus: 0.18, skill: "황금 이빨", passiveDesc: "ATK+18% DEF+15% HP+15%" },
  "1급": { color: 0x7C5CFC, emoji: "🔷", stars: "★★★☆☆", rate: 8.0, atkBonus: 0.12, defBonus: 0.10, hpBonus: 0.10, xpBonus: 0.12, crystalBonus: 0.10, skill: "황금 발톱", passiveDesc: "ATK+12% DEF+10% HP+10%" },
  "2급": { color: 0x4ade80, emoji: "🟢", stars: "★★☆☆☆", rate: 22.5, atkBonus: 0.07, defBonus: 0.06, hpBonus: 0.06, xpBonus: 0.07, crystalBonus: 0.06, skill: "황금 보호막", passiveDesc: "ATK+7% DEF+6% HP+6%" },
  "3급": { color: 0x94a3b8, emoji: "⚪", stars: "★☆☆☆☆", rate: 67.0, atkBonus: 0.03, defBonus: 0.02, hpBonus: 0.02, xpBonus: 0.03, crystalBonus: 0.02, skill: "황금 냄새", passiveDesc: "ATK+3% DEF+2% HP+2%" },
};

function rollKogane() {
  const total = Object.values(KOGANE_GRADES).reduce((s, g) => s + g.rate, 0);
  let roll = Math.random() * total;
  for (const [grade, g] of Object.entries(KOGANE_GRADES)) {
    roll -= g.rate;
    if (roll <= 0) return grade;
  }
  return "3급";
}

function getKoganeBonus(player) {
  if (!player.kogane) return { atk: 1, def: 1, hp: 1, xp: 1, crystal: 1 };
  const g = KOGANE_GRADES[player.kogane];
  if (!g) return { atk: 1, def: 1, hp: 1, xp: 1, crystal: 1 };
  return { atk: 1 + g.atkBonus, def: 1 + g.defBonus, hp: 1 + g.hpBonus, xp: 1 + g.xpBonus, crystal: 1 + g.crystalBonus };
}

// ════════════════════════════════════════════════════════
// ── 캐릭터 데이터
// ════════════════════════════════════════════════════════
const CHARACTERS = {
  itadori: { name: "이타도리 유지", emoji: "🟠", grade: "준1급", atk: 90, def: 75, spd: 85, maxHp: 1000, domain: null, desc: "스쿠나의 그릇", skills: [
    { name: "주먹질", minMastery: 0, dmg: 95, desc: "강력한 기본 공격" },
    { name: "다이버전트 주먹", minMastery: 5, dmg: 160, desc: "저주 에너지를 실은 주먹", statusApply: { target: "enemy", statusId: "stun", chance: 0.3 } },
    { name: "흑섬", minMastery: 15, dmg: 240, desc: "최대 저주 에너지 방출", statusApply: { target: "enemy", statusId: "weaken", chance: 0.5 } },
    { name: "어주자", minMastery: 30, dmg: 340, desc: "스쿠나의 힘을 빌림", statusApply: { target: "enemy", statusId: "burn", chance: 0.7 } },
    { name: "스쿠나 발현", minMastery: 50, dmg: 520, desc: "스쿠나가 몸을 장악", statusApply: { target: "enemy", statusId: "freeze", chance: 0.8 } },
  ] },
  gojo: { name: "고조 사토루", emoji: "🔵", grade: "특급", atk: 130, def: 120, spd: 110, maxHp: 1800, domain: "무량공처", desc: "최강의 주술사", skills: [
    { name: "아오", minMastery: 0, dmg: 145, desc: "인력으로 끌어당김" },
    { name: "아카", minMastery: 5, dmg: 220, desc: "척력으로 폭발", statusApply: { target: "enemy", statusId: "burn", chance: 0.5 } },
    { name: "무라사키", minMastery: 15, dmg: 320, desc: "아오+아카 합체기", statusApply: { target: "enemy", statusId: "weaken", chance: 0.6 } },
    { name: "무량공처", minMastery: 30, dmg: 480, desc: "궁극 영역전개", statusApply: { target: "enemy", statusId: "freeze", chance: 0.8 } },
  ] },
  sukuna: { name: "료멘 스쿠나", emoji: "🔴", grade: "특급", atk: 140, def: 115, spd: 120, maxHp: 2500, domain: "복마어주자", desc: "저주의 왕", skills: [
    { name: "해", minMastery: 0, dmg: 145, desc: "손톱으로 베기", statusApply: { target: "enemy", statusId: "burn", chance: 0.4 } },
    { name: "팔", minMastery: 5, dmg: 235, desc: "공간 베기", statusApply: { target: "enemy", statusId: "weaken", chance: 0.5 } },
    { name: "푸가", minMastery: 15, dmg: 345, desc: "분해 공격", statusApply: { target: "enemy", statusId: "poison", chance: 0.7 } },
    { name: "세계참", minMastery: 30, dmg: 600, desc: "세계를 베는 궁극기", statusApply: { target: "enemy", statusId: "freeze", chance: 0.9 } },
  ] },
  yuta: { name: "오코츠 유타", emoji: "🌟", grade: "특급", atk: 128, def: 112, spd: 115, maxHp: 1750, domain: "진안상애", desc: "특급 주술사", skills: [
    { name: "모방술식", minMastery: 0, dmg: 135, desc: "술식 복사" },
    { name: "리카 소환", minMastery: 5, dmg: 220, desc: "리카 소환", statusApply: { target: "enemy", statusId: "weaken", chance: 0.5 } },
    { name: "순애빔", minMastery: 15, dmg: 340, desc: "사랑의 빔", statusApply: { target: "enemy", statusId: "burn", chance: 0.6 } },
    { name: "진안상애", minMastery: 30, dmg: 480, desc: "영역전개", statusApply: { target: "enemy", statusId: "freeze", chance: 0.9 } },
  ] },
  megumi: { name: "후시구로 메구미", emoji: "⚫", grade: "1급", atk: 110, def: 108, spd: 100, maxHp: 1250, domain: "강압암예정", desc: "식신술사", skills: [
    { name: "옥견", minMastery: 0, dmg: 115, desc: "옥견 소환" },
    { name: "탈토", minMastery: 5, dmg: 180, desc: "대호 소환", statusApply: { target: "enemy", statusId: "weaken", chance: 0.4 } },
    { name: "만상", minMastery: 15, dmg: 265, desc: "열 식신 소환", statusApply: { target: "enemy", statusId: "poison", chance: 0.5 } },
    { name: "마허라가라", minMastery: 30, dmg: 380, desc: "최강 식신 강림", statusApply: { target: "enemy", statusId: "stun", chance: 0.6 } },
  ] },
  nobara: { name: "쿠기사키 노바라", emoji: "🌸", grade: "1급", atk: 115, def: 95, spd: 105, maxHp: 1180, domain: null, desc: "저주 못 사용자", skills: [
    { name: "망치질", minMastery: 0, dmg: 118, desc: "못 박기" },
    { name: "공명", minMastery: 5, dmg: 195, desc: "공명 피해", statusApply: { target: "enemy", statusId: "poison", chance: 0.5 } },
    { name: "철정", minMastery: 15, dmg: 280, desc: "저주 못", statusApply: { target: "enemy", statusId: "weaken", chance: 0.5 } },
    { name: "발화", minMastery: 30, dmg: 390, desc: "동시 폭발", statusApply: { target: "enemy", statusId: "burn", chance: 0.8 } },
  ] },
  todo: { name: "토도 아오이", emoji: "💪", grade: "1급", atk: 128, def: 108, spd: 112, maxHp: 1500, domain: null, desc: "보조공격술 사용자", skills: [
    { name: "부기우기", minMastery: 0, dmg: 130, desc: "위치 전환", statusApply: { target: "enemy", statusId: "freeze", chance: 0.4 } },
    { name: "브루탈 펀치", minMastery: 5, dmg: 215, desc: "파괴적 주먹", statusApply: { target: "enemy", statusId: "weaken", chance: 0.3 } },
    { name: "흑섬", minMastery: 15, dmg: 320, desc: "흑섬", statusApply: { target: "enemy", statusId: "burn", chance: 0.45 } },
    { name: "전투본능", minMastery: 30, dmg: 200, desc: "자기 버프", statusApply: { target: "self", statusId: "battleInstinct", chance: 1.0 } },
  ] },
  hakari: { name: "하카리 키리토", emoji: "🎰", grade: "1급", atk: 125, def: 105, spd: 110, maxHp: 1650, domain: "질풍강운", desc: "복권 술식 사용자", skills: [
    { name: "험한 도박", minMastery: 0, dmg: 125, desc: "운에 맡긴 도박", statusApply: { target: "enemy", statusId: "stun", chance: 0.3 } },
    { name: "질풍열차", minMastery: 5, dmg: 210, desc: "질풍처럼 돌진", statusApply: { target: "enemy", statusId: "weaken", chance: 0.4 } },
    { name: "유한 소설", minMastery: 15, dmg: 315, desc: "불멸의 몸", statusApply: { target: "self", statusId: "battleInstinct", chance: 0.6 } },
    { name: "질풍강운", minMastery: 30, dmg: 480, desc: "영역전개", statusApply: { target: "enemy", statusId: "freeze", chance: 0.7 } },
  ] },
  maki: { name: "마키 젠인", emoji: "⚪", grade: "준1급", atk: 122, def: 110, spd: 115, maxHp: 1300, domain: null, desc: "천여주박 각성 가능", awakening: { threshold: 0.30, dmgMult: 2.0 }, skills: [
    { name: "봉술", minMastery: 0, dmg: 122, desc: "봉으로 타격" },
    { name: "저주창", minMastery: 5, dmg: 200, desc: "창 투척", statusApply: { target: "enemy", statusId: "weaken", chance: 0.4 } },
    { name: "저주도구술", minMastery: 15, dmg: 285, desc: "도구 구사", statusApply: { target: "enemy", statusId: "burn", chance: 0.5 } },
    { name: "천개봉파", minMastery: 30, dmg: 400, desc: "연속 공격", statusApply: { target: "enemy", statusId: "stun", chance: 0.6 } },
  ] },
  nanami: { name: "나나미 켄토", emoji: "🟡", grade: "1급", atk: 118, def: 108, spd: 90, maxHp: 1380, domain: null, desc: "합리적 주술사", skills: [
    { name: "둔기 공격", minMastery: 0, dmg: 120, desc: "둔기 타격" },
    { name: "칠할삼분", minMastery: 5, dmg: 200, desc: "약점 공격", statusApply: { target: "enemy", statusId: "weaken", chance: 0.6 } },
    { name: "십수할", minMastery: 15, dmg: 290, desc: "저주 에너지 방출" },
    { name: "초과근무", minMastery: 30, dmg: 410, desc: "폭발적 강화" },
  ] },
  geto: { name: "게토 스구루", emoji: "🟢", grade: "특급", atk: 115, def: 105, spd: 100, maxHp: 1600, domain: null, desc: "저주 조종사", skills: [
    { name: "저주 방출", minMastery: 0, dmg: 125, desc: "저주령 방출" },
    { name: "최대출력", minMastery: 5, dmg: 210, desc: "전력 방출", statusApply: { target: "enemy", statusId: "poison", chance: 0.4 } },
    { name: "저주영조종", minMastery: 15, dmg: 300, desc: "수천의 저주령 조종", statusApply: { target: "enemy", statusId: "weaken", chance: 0.6 } },
    { name: "감로대법", minMastery: 30, dmg: 425, desc: "저주 흡수", statusApply: { target: "enemy", statusId: "stun", chance: 0.5 } },
  ] },
  panda: { name: "판다", emoji: "🐼", grade: "2급", atk: 105, def: 118, spd: 85, maxHp: 1400, domain: null, desc: "특이체질", skills: [
    { name: "박치기", minMastery: 0, dmg: 108, desc: "머리 박치기", statusApply: { target: "enemy", statusId: "stun", chance: 0.2 } },
    { name: "곰 발바닥", minMastery: 5, dmg: 175, desc: "발바닥 내리치기" },
    { name: "팬더 변신", minMastery: 15, dmg: 255, desc: "팬더 변신", statusApply: { target: "enemy", statusId: "weaken", chance: 0.4 } },
    { name: "고릴라 변신", minMastery: 30, dmg: 360, desc: "고릴라 변신", statusApply: { target: "enemy", statusId: "stun", chance: 0.5 } },
  ] },
  inumaki: { name: "이누마키 토게", emoji: "🟤", grade: "준1급", atk: 112, def: 90, spd: 110, maxHp: 1120, domain: null, desc: "주술언어 사용자", skills: [
    { name: "멈춰라", minMastery: 0, dmg: 115, desc: "움직임 봉쇄", statusApply: { target: "enemy", statusId: "freeze", chance: 0.5 } },
    { name: "달려라", minMastery: 5, dmg: 180, desc: "강제 이동", statusApply: { target: "enemy", statusId: "weaken", chance: 0.5 } },
    { name: "주술언어", minMastery: 15, dmg: 265, desc: "강력 명령", statusApply: { target: "enemy", statusId: "stun", chance: 0.6 } },
    { name: "폭발해라", minMastery: 30, dmg: 375, desc: "폭발 명령", statusApply: { target: "enemy", statusId: "burn", chance: 0.8 } },
  ] },
  higuruma: { name: "히구루마 히로미", emoji: "⚖️", grade: "1급", atk: 118, def: 105, spd: 95, maxHp: 1320, domain: "주복사사", desc: "전직 변호사", skills: [
    { name: "저주도구", minMastery: 0, dmg: 120, desc: "저주 도구 공격" },
    { name: "몰수", minMastery: 5, dmg: 195, desc: "술식 몰수", statusApply: { target: "enemy", statusId: "weaken", chance: 0.7 } },
    { name: "사형판결", minMastery: 15, dmg: 285, desc: "강력 제재", statusApply: { target: "enemy", statusId: "stun", chance: 0.5 } },
    { name: "집행인 인형", minMastery: 30, dmg: 410, desc: "인형 소환", statusApply: { target: "enemy", statusId: "freeze", chance: 0.7 } },
  ] },
  jogo: { name: "죠고", emoji: "🌋", grade: "특급", atk: 125, def: 100, spd: 105, maxHp: 1680, domain: "개관철위산", desc: "화염 저주령", skills: [
    { name: "화염 분사", minMastery: 0, dmg: 130, desc: "불꽃 방사", statusApply: { target: "enemy", statusId: "burn", chance: 0.5 } },
    { name: "용암 폭발", minMastery: 5, dmg: 215, desc: "용암 폭발", statusApply: { target: "enemy", statusId: "burn", chance: 0.7 } },
    { name: "극번 운", minMastery: 15, dmg: 315, desc: "운석 소환", statusApply: { target: "enemy", statusId: "weaken", chance: 0.5 } },
    { name: "개관철위산", minMastery: 30, dmg: 460, desc: "영역전개", statusApply: { target: "enemy", statusId: "burn", chance: 1.0 } },
  ] },
  mahito: { name: "마히토", emoji: "🩸", grade: "특급", atk: 120, def: 98, spd: 110, maxHp: 1560, domain: "자폐원돈과", desc: "영혼 변형 저주령", skills: [
    { name: "영혼 변형", minMastery: 0, dmg: 128, desc: "영혼 타격", statusApply: { target: "enemy", statusId: "weaken", chance: 0.4 } },
    { name: "무위전변", minMastery: 5, dmg: 212, desc: "신체 변형", statusApply: { target: "enemy", statusId: "stun", chance: 0.4 } },
    { name: "편사지경체", minMastery: 15, dmg: 308, desc: "무한 변형", statusApply: { target: "enemy", statusId: "weaken", chance: 0.6 } },
    { name: "자폐원돈과", minMastery: 30, dmg: 455, desc: "영역전개", statusApply: { target: "enemy", statusId: "freeze", chance: 0.8 } },
  ] },
  hanami: { name: "하나미", emoji: "🌿", grade: "특급", atk: 115, def: 118, spd: 93, maxHp: 1750, domain: null, desc: "식물 저주령", skills: [
    { name: "나무뿌리", minMastery: 0, dmg: 122, desc: "나무뿌리 채찍", statusApply: { target: "enemy", statusId: "weaken", chance: 0.3 } },
    { name: "꽃비", minMastery: 5, dmg: 198, desc: "독성 꽃가루", statusApply: { target: "enemy", statusId: "poison", chance: 0.6 } },
    { name: "대지의 저주", minMastery: 15, dmg: 285, desc: "대지 에너지", statusApply: { target: "enemy", statusId: "poison", chance: 0.7 } },
    { name: "재앙의 꽃", minMastery: 30, dmg: 425, desc: "거대 꽃 소환", statusApply: { target: "enemy", statusId: "stun", chance: 0.6 } },
  ] },
  dagon: { name: "다곤", emoji: "🌊", grade: "특급", atk: 118, def: 108, spd: 96, maxHp: 1620, domain: "탕온평선", desc: "수중 저주령", skills: [
    { name: "물고기 소환", minMastery: 0, dmg: 125, desc: "물고기 떼", statusApply: { target: "enemy", statusId: "poison", chance: 0.4 } },
    { name: "해수 폭발", minMastery: 5, dmg: 205, desc: "해수 압축", statusApply: { target: "enemy", statusId: "weaken", chance: 0.5 } },
    { name: "조류 소용돌이", minMastery: 15, dmg: 295, desc: "물 소용돌이", statusApply: { target: "enemy", statusId: "freeze", chance: 0.4 } },
    { name: "탕온평선", minMastery: 30, dmg: 450, desc: "영역전개", statusApply: { target: "enemy", statusId: "poison", chance: 0.9 } },
  ] },
};

// ════════════════════════════════════════════════════════
// ── 적 데이터
// ════════════════════════════════════════════════════════
const ENEMIES = [
  { id: "e1", name: "저급 저주령", emoji: "👹", hp: 550, atk: 38, def: 12, xp: 75, crystals: 18, masteryXp: 1, fingers: 0 },
  { id: "e2", name: "1급 저주령", emoji: "👺", hp: 1100, atk: 80, def: 40, xp: 190, crystals: 40, masteryXp: 3, fingers: 0, statusAttack: { statusId: "poison", chance: 0.3 } },
  { id: "e3", name: "특급 저주령", emoji: "💀", hp: 2400, atk: 128, def: 72, xp: 440, crystals: 90, masteryXp: 7, fingers: 1, statusAttack: { statusId: "burn", chance: 0.4 } },
  { id: "e4", name: "저주의 왕", emoji: "👑", hp: 5500, atk: 195, def: 110, xp: 1000, crystals: 200, masteryXp: 15, fingers: 3, statusAttack: { statusId: "weaken", chance: 0.5 } },
];

const JUJUTSU_ENEMIES = [
  { id: "j1", name: "약화된 저주령", emoji: "💧", hp: 300, atk: 25, def: 8, xp: 55, crystals: 12, points: 1 },
  { id: "j2", name: "중간급 저주령", emoji: "🌀", hp: 620, atk: 55, def: 28, xp: 115, crystals: 28, points: 1, statusAttack: { statusId: "weaken", chance: 0.2 } },
  { id: "j3", name: "강화 저주령", emoji: "🔥", hp: 450, atk: 75, def: 22, xp: 95, crystals: 23, points: 1, statusAttack: { statusId: "burn", chance: 0.35 } },
  { id: "j4", name: "특수 저주령", emoji: "☠️", hp: 960, atk: 88, def: 48, xp: 190, crystals: 45, points: 2, statusAttack: { statusId: "poison", chance: 0.4 } },
  { id: "j5", name: "엘리트 저주령", emoji: "💀", hp: 1380, atk: 108, def: 60, xp: 280, crystals: 70, points: 3, statusAttack: { statusId: "burn", chance: 0.5 } },
  { id: "j6", name: "사멸회유 수호자", emoji: "👹", hp: 2100, atk: 135, def: 82, xp: 440, crystals: 100, points: 5, statusAttack: { statusId: "weaken", chance: 0.6 } },
];

// ════════════════════════════════════════════════════════
// ── 가챠 풀
// ════════════════════════════════════════════════════════
const GACHA_POOL = [
  { id: "gojo", rate: 0.3 }, { id: "yuta", rate: 0.45 }, { id: "sukuna", rate: 0.5 },
  { id: "geto", rate: 0.9 }, { id: "jogo", rate: 0.6 }, { id: "mahito", rate: 0.6 },
  { id: "hanami", rate: 0.7 }, { id: "dagon", rate: 0.7 }, { id: "itadori", rate: 2.5 },
  { id: "megumi", rate: 6.0 }, { id: "nanami", rate: 6.0 }, { id: "maki", rate: 6.5 },
  { id: "nobara", rate: 6.5 }, { id: "higuruma", rate: 6.5 }, { id: "todo", rate: 5.0 },
  { id: "hakari", rate: 5.0 }, { id: "panda", rate: 32.0 }, { id: "inumaki", rate: 23.75 },
];

const GACHA_RARITY = {
  "특급": { stars: "★★★★★", color: 0xF5C842, effect: "✨🔱✨" },
  "준특급": { stars: "★★★★☆", color: 0xff8c00, effect: "💠💠💠" },
  "1급": { stars: "★★★☆☆", color: 0x7C5CFC, effect: "⭐⭐⭐" },
  "준1급": { stars: "★★★☆☆", color: 0x9b72cf, effect: "⭐⭐⭐" },
  "2급": { stars: "★★☆☆☆", color: 0x4ade80, effect: "🔹🔹" },
  "3급": { stars: "★☆☆☆☆", color: 0x94a3b8, effect: "◽" },
};

function rollGacha(count = 1) {
  const total = GACHA_POOL.reduce((s, p) => s + p.rate, 0);
  return Array.from({ length: count }, () => {
    let roll = Math.random() * total;
    for (const e of GACHA_POOL) { roll -= e.rate; if (roll <= 0) return e.id; }
    return GACHA_POOL[0].id;
  });
}

const REVERSE_CHARS = new Set(["gojo", "yuta", "sukuna"]);
const CODES = { "release": { crystals: 200 }, "sorryforbugs": { crystals: 1000 } };

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
// ── 플레이어 유틸 (개선됨 - 주력스킬/도전과제 추가)
// ════════════════════════════════════════════════════════
function getPlayer(userId, username = "플레이어") {
  if (!players[userId]) {
    players[userId] = {
      id: userId, name: username, crystals: 500, xp: 0,
      owned: ["itadori"], active: "itadori",
      hp: CHARACTERS["itadori"].maxHp, potion: 3,
      wins: 0, losses: 0, pvpWins: 0, pvpLosses: 0,
      mastery: { itadori: 0 },
      reverseCooldown: 0, skillCooldown: 0,
      statusEffects: [],
      cullingBest: 0, jujutsuBest: 0,
      usedCodes: [], lastDaily: 0, dailyStreak: 0,
      sukunaFingers: 0,
      kogane: null, koganeGachaCount: 0,
      mainSkill: null,
      achievements: { firstWin: false, fingerCollector: false, cullingMaster: false, jujutsuComplete: false, pvpFirstWin: false },
    };
    savePlayer(userId);
  }
  const p = players[userId];
  if (p.achievements === undefined) p.achievements = { firstWin: false, fingerCollector: false, cullingMaster: false, jujutsuComplete: false, pvpFirstWin: false };
  return p;
}

function getMastery(player, charId) { return player.mastery?.[charId] || 0; }

function getAvailableSkills(player, charId) {
  const m = getMastery(player, charId);
  let skills = CHARACTERS[charId].skills.filter(s => m >= s.minMastery);
  if (charId === "sukuna") {
    const fingers = player.sukunaFingers || 0;
    skills = skills.filter((s, idx) => isSukunaSkillUnlocked(fingers, idx));
  }
  return skills;
}

function getCurrentSkill(player, charId) {
  const skills = getAvailableSkills(player, charId);
  return skills[skills.length - 1] || CHARACTERS[charId].skills[0];
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
  return bonus;
}

function checkAchievements(player) {
  let changed = false;
  if (!player.achievements.firstWin && player.wins >= 1) { player.achievements.firstWin = true; changed = true; }
  if (!player.achievements.fingerCollector && (player.sukunaFingers || 0) >= 5) { player.achievements.fingerCollector = true; changed = true; }
  if (!player.achievements.cullingMaster && player.cullingBest >= 5) { player.achievements.cullingMaster = true; changed = true; }
  if (!player.achievements.jujutsuComplete && (player.jujutsuBest || 0) >= 15) { player.achievements.jujutsuComplete = true; changed = true; }
  if (!player.achievements.pvpFirstWin && (player.pvpWins || 0) >= 1) { player.achievements.pvpFirstWin = true; changed = true; }
  if (changed) savePlayer(player.id);
  return changed;
}

function getPlayerStats(player) {
  const ch = CHARACTERS[player.active];
  const kb = getKoganeBonus(player);
  if (player.active !== "itadori" && player.active !== "sukuna") {
    return { atk: Math.floor(ch.atk * kb.atk), def: Math.floor(ch.def * kb.def), maxHp: Math.floor(ch.maxHp * kb.hp) };
  }
  const bonus = getFingerBonus(player.sukunaFingers || 0);
  return {
    atk: Math.floor((ch.atk + bonus.atkBonus) * kb.atk),
    def: Math.floor((ch.def + bonus.defBonus) * kb.def),
    maxHp: Math.floor((ch.maxHp + bonus.hpBonus) * kb.hp),
  };
}

function getLevel(xp) { return Math.floor(xp / 200) + 1; }
function hpBar(cur, max, len = 10) {
  const pct = Math.max(0, Math.min(1, cur / max));
  const fill = Math.round(pct * len);
  const color = pct > 0.5 ? "🟩" : pct > 0.25 ? "🟨" : "🟥";
  return color.repeat(fill) + "⬛".repeat(len - fill);
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
  
  const mainSkill = getMainSkill(player, player.active);
  const currentSkill = getCurrentSkill(player, player.active);
  if (mainSkill.name === currentSkill.name) {
    const bonus = getMainSkillBonus(player);
    dmg = Math.floor(dmg * (1 + bonus / 100));
  }
  
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
  if (target === "enemy") { applyStatus(defenderObj, statusId); return [`${def.emoji} **${def.name}** 적용!`]; }
  if (target === "self" && attackerObj) { applyStatus(attackerObj, statusId); return [`${def.emoji} **${def.name}** 발동!`]; }
  return [];
}

function tickCooldowns(player) {
  if (player.reverseCooldown > 0) player.reverseCooldown--;
  if (player.skillCooldown > 0) player.skillCooldown--;
}

function getPartyId(userId) {
  return Object.keys(parties).find(pid => parties[pid]?.members?.includes(userId)) || null;
}
function getParty(userId) { const pid = getPartyId(userId); return pid ? parties[pid] : null; }

function getPvpSessionByUser(userId) { return Object.values(pvpSessions).find(s => s.p1Id === userId || s.p2Id === userId) || null; }

function pickCullingEnemy(wave) {
  let pool = ["e1", "e1", "e1", "e2"];
  if (wave > 3) pool = ["e1", "e2", "e2", "e2", "e3"];
  if (wave > 7) pool = ["e2", "e2", "e3", "e3", "e3"];
  if (wave > 14) pool = ["e2", "e3", "e3", "e4", "e4"];
  const id = pool[Math.floor(Math.random() * pool.length)];
  const base = ENEMIES.find(e => e.id === id);
  const scale = 1 + (wave - 1) * 0.05;
  return { ...base, hp: Math.floor(base.hp * scale), atk: Math.floor(base.atk * scale), def: Math.floor(base.def * scale), xp: Math.floor(base.xp * scale), crystals: Math.floor(base.crystals * scale), currentHp: Math.floor(base.hp * scale), statusEffects: [] };
}

function generateJujutsuChoices(wave) {
  let pool = ["j1", "j1", "j2", "j3"];
  if (wave > 3) pool = ["j2", "j3", "j3", "j4"];
  if (wave > 7) pool = ["j3", "j4", "j4", "j5"];
  if (wave > 12) pool = ["j4", "j5", "j5", "j6"];
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  const ids = [...new Set(shuffled)].slice(0, 3);
  return ids.map(id => {
    const base = JUJUTSU_ENEMIES.find(e => e.id === id);
    const scale = 1 + (wave - 1) * 0.04;
    return { ...base, hp: Math.floor(base.hp * scale), atk: Math.floor(base.atk * scale), def: Math.floor(base.def * scale), xp: Math.floor(base.xp * scale), crystals: Math.floor(base.crystals * scale), statusEffects: [] };
  });
}

// ════════════════════════════════════════════════════════
// ── 임베드 함수들
// ════════════════════════════════════════════════════════
function profileEmbed(player) {
  const ch = CHARACTERS[player.active];
  const stats = getPlayerStats(player);
  const skill = getCurrentSkill(player, player.active);
  const mainSkill = getMainSkill(player, player.active);
  const mainBonus = getMainSkillBonus(player);
  const mastery = getMastery(player, player.active);
  const lv = getLevel(player.xp);
  const fingers = player.sukunaFingers || 0;
  const fingerBonus = getFingerBonus(fingers);
  const awakened = isMakiAwakened(player);
  const gradeInfo = GACHA_RARITY[ch.grade] || GACHA_RARITY["3급"];
  
  const embed = new EmbedBuilder()
    .setTitle(`${gradeInfo.effect} ${player.name}의 주술사 카드 ${gradeInfo.effect}`)
    .setColor(awakened ? 0xFF2200 : gradeInfo.color)
    .setDescription([
      `**${ch.emoji} ${ch.name}** ${JJK_GRADE_LABEL[ch.grade] || `【 ${ch.grade} 】`}`,
      `> ${ch.desc}`,
      `> 🌌 영역전개: ${ch.domain || "없음"}`,
      `> 🗡️ ATK ${stats.atk} | 🛡️ DEF ${stats.def} | 💨 SPD ${ch.spd}`,
      `> 💚 HP ${hpBar(player.hp, stats.maxHp)} ${player.hp}/${stats.maxHp}`,
      awakened ? `> 🔥 **천여주박 각성 중!** DMG 2배!` : "",
      `> 👹 스쿠나 손가락: ${fingers}/${SUKUNA_FINGER_MAX} ${fingerBonus.label}`,
      `> 🐾 코가네: ${player.kogane ? `${KOGANE_GRADES[player.kogane]?.emoji} ${player.kogane}` : "없음"}`,
      ``,
      `**📈 숙련도 Lv.${mastery}**`,
      `**🌀 현재 술식:** ${skill.name} (${skill.dmg} DMG)`,
      `**⭐ 주력 스킬:** ${mainSkill.name} (+${mainBonus}% DMG)`,
      ``,
      `**💰 정보**`,
      `> 💎 ${player.crystals} | ⭐ LV.${lv} (${player.xp} XP)`,
      `> 🧪 회복약 ${player.potion}개`,
      `> ⚔️ 전적: ${player.wins}승 ${player.losses}패 | PvP: ${player.pvpWins}승 ${player.pvpLosses}패`,
      `> 🌊 컬링 최고 ${player.cullingBest}W | 🎯 사멸회유 ${player.jujutsuBest || 0}pt`,
    ].join("\n"))
    .setFooter({ text: `/전투 | /컬링 | /사멸회유 | /결투 | /파티 | /가챠 | /코가네가챠 | ${player.name}` })
    .setTimestamp();
  return embed;
}

function pokedexEmbed(player) {
  const owned = player.owned;
  const all = Object.keys(CHARACTERS);
  const ownedList = owned.map(id => {
    const c = CHARACTERS[id];
    const isActive = id === player.active ? "✅ 활성" : "🔒";
    return `> ${c.emoji} **${c.name}** \`${c.grade}\` — ${isActive}`;
  }).join("\n") || "> 없음";
  const missingList = all.filter(id => !owned.includes(id)).map(id => {
    const c = CHARACTERS[id];
    return `> ${c.emoji} **${c.name}** \`${c.grade}\` — ❌ 미획득`;
  }).join("\n") || "> 🎉 모두 획득!";
  return new EmbedBuilder()
    .setTitle("📖 주술사 도감")
    .setColor(0x7C5CFC)
    .setDescription(`**보유 (${owned.length}/${all.length})**\n${ownedList}\n\n**미획득**\n${missingList}`)
    .setFooter({ text: "/가챠로 획득!" });
}

function skillEmbed(player) {
  const ch = CHARACTERS[player.active];
  const mastery = getMastery(player, player.active);
  const fingers = player.sukunaFingers || 0;
  const mainSkillName = player.mainSkill;
  
  const fields = ch.skills.map((s, idx) => {
    let unlocked = mastery >= s.minMastery;
    if (player.active === "sukuna") unlocked = unlocked && isSukunaSkillUnlocked(fingers, idx);
    const isMain = mainSkillName === s.name;
    return {
      name: `${unlocked ? "✅" : "🔒"} ${s.name}${isMain ? " ⭐주력" : ""} (숙련 ${s.minMastery})`,
      value: `> ${s.desc} | 피해: ${s.dmg}\n> ${unlocked ? "사용 가능" : (player.active === "sukuna" ? "👹 손가락 필요" : "🔒 숙련도 필요")}`,
      inline: false,
    };
  });
  
  return new EmbedBuilder()
    .setTitle(`${ch.emoji} ${ch.name}의 술식 트리`)
    .setColor(JJK_GRADE_COLOR[ch.grade] || 0x7C5CFC)
    .setDescription(`📈 현재 숙련도: ${mastery}\n👹 손가락: ${fingers}/${SUKUNA_FINGER_MAX}\n🌟 주력 스킬 보너스: +${getMainSkillBonus(player)}%`)
    .addFields(fields)
    .setFooter({ text: "/주력설정 [스킬명] 으로 주력 스킬 변경" });
}

// ════════════════════════════════════════════════════════
// ── 버튼 팩토리
// ════════════════════════════════════════════════════════
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

// ════════════════════════════════════════════════════════
// ── 전투 핸들러
// ════════════════════════════════════════════════════════
async function handleBattleAction(interaction, player, battle, action) {
  const enemy = battle.enemy;
  
  if (action === "b_attack") {
    if (isIncapacitated(player.statusEffects)) return interaction.reply({ content: "❌ 행동 불가!", ephemeral: true });
    if (!rollHit(enemy.statusEffects)) return interaction.update({ content: "⚡ 빗나감!", components: [mkBattleButtons(player)] });
    const dmg = calcDmgForPlayer(player, enemy.def);
    enemy.currentHp = Math.max(0, enemy.currentHp - dmg);
    await interaction.update({ content: `⚔️ ${dmg} 데미지!`, components: [mkBattleButtons(player)] });
  }
  else if (action === "b_skill") {
    if (isIncapacitated(player.statusEffects)) return interaction.reply({ content: "❌ 행동 불가!", ephemeral: true });
    const skill = getCurrentSkill(player, player.active);
    if (!rollHit(enemy.statusEffects)) return interaction.update({ content: "⚡ 술식 빗나감!", components: [mkBattleButtons(player)] });
    const dmg = calcSkillDmgForPlayer(player, skill.dmg);
    enemy.currentHp = Math.max(0, enemy.currentHp - dmg);
    applySkillStatus(skill, enemy, player);
    player.skillCooldown = 5;
    await interaction.update({ content: `🌀 ${skill.name}! ${dmg} 데미지!`, components: [mkBattleButtons(player)] });
  }
  else if (action === "b_main") {
    if (isIncapacitated(player.statusEffects)) return interaction.reply({ content: "❌ 행동 불가!", ephemeral: true });
    const skill = getMainSkill(player, player.active);
    if (!rollHit(enemy.statusEffects)) return interaction.update({ content: "⚡ 주력 스킬 빗나감!", components: [mkBattleButtons(player)] });
    const dmg = calcSkillDmgForPlayer(player, skill.dmg);
    enemy.currentHp = Math.max(0, enemy.currentHp - dmg);
    applySkillStatus(skill, enemy, player);
    player.skillCooldown = 6;
    await interaction.update({ content: `⭐ 주력 스킬: ${skill.name}! ${dmg} 데미지!`, components: [mkBattleButtons(player)] });
  }
  else if (action === "b_reverse") {
    if (!REVERSE_CHARS.has(player.active)) return interaction.reply({ content: "❌ 반전술식 불가!", ephemeral: true });
    const stats = getPlayerStats(player);
    const heal = Math.floor(stats.maxHp * 0.4);
    player.hp = Math.min(stats.maxHp, player.hp + heal);
    player.reverseCooldown = 3;
    await interaction.update({ content: `♻️ ${heal} HP 회복!`, components: [mkBattleButtons(player)] });
  }
  else if (action === "b_run") {
    delete battles[interaction.user.id];
    return interaction.update({ content: "🏃 도주!", components: [] });
  }
  
  // 적의 턴
  if (enemy.currentHp > 0 && player.hp > 0) {
    if (rollHit(player.statusEffects)) {
      const dmg = calcDmg(enemy.atk, getPlayerStats(player).def);
      player.hp = Math.max(0, player.hp - dmg);
      if (enemy.statusAttack && Math.random() < (enemy.statusAttack.chance || 0.3)) {
        applyStatus(player, enemy.statusAttack.statusId);
      }
      await interaction.followUp({ content: `💥 적 공격! ${dmg} 데미지!`, ephemeral: false });
    } else {
      await interaction.followUp({ content: `⚡ 적 공격 빗나감!`, ephemeral: false });
    }
    const tick = tickStatus(player, getPlayerStats(player).maxHp);
    if (tick.dmg > 0) await interaction.followUp({ content: tick.log.join("\n"), ephemeral: false });
  }
  
  // 승리/패배 처리
  if (enemy.currentHp <= 0) {
    const xpGain = enemy.xp, crystalGain = enemy.crystals, masteryGain = enemy.masteryXp || 1;
    player.xp += xpGain; player.crystals += crystalGain;
    player.mastery[player.active] = (player.mastery[player.active] || 0) + masteryGain;
    if (enemy.fingers) player.sukunaFingers = Math.min(SUKUNA_FINGER_MAX, (player.sukunaFingers || 0) + enemy.fingers);
    player.wins++;
    checkAchievements(player);
    delete battles[interaction.user.id];
    await interaction.editReply({ content: `🏆 승리! +${xpGain} XP, +${crystalGain}💎, +${masteryGain} 숙련도`, components: [] });
  } else if (player.hp <= 0) {
    player.losses++;
    delete battles[interaction.user.id];
    await interaction.editReply({ content: `💀 패배...`, components: [] });
  }
  tickCooldowns(player);
  savePlayer(interaction.user.id);
}

// ════════════════════════════════════════════════════════
// ── 컬링 핸들러 (간소화)
// ════════════════════════════════════════════════════════
async function handleCullingAction(interaction, player, culling, action) {
  const enemy = culling.currentEnemy;
  
  if (action === "c_attack") {
    if (!rollHit(enemy.statusEffects)) return interaction.update({ content: "⚡ 빗나감!", components: [mkCullingButtons(player)] });
    const dmg = calcDmgForPlayer(player, enemy.def);
    culling.enemyHp = Math.max(0, culling.enemyHp - dmg);
    await interaction.update({ content: `⚔️ ${dmg} 데미지!`, components: [mkCullingButtons(player)] });
  }
  else if (action === "c_skill") {
    const skill = getCurrentSkill(player, player.active);
    if (!rollHit(enemy.statusEffects)) return interaction.update({ content: "⚡ 빗나감!", components: [mkCullingButtons(player)] });
    const dmg = calcSkillDmgForPlayer(player, skill.dmg);
    culling.enemyHp = Math.max(0, culling.enemyHp - dmg);
    player.skillCooldown = 5;
    await interaction.update({ content: `🌀 ${skill.name}! ${dmg} 데미지!`, components: [mkCullingButtons(player)] });
  }
  else if (action === "c_reverse") {
    if (!REVERSE_CHARS.has(player.active)) return interaction.reply({ content: "❌ 반전술식 불가!", ephemeral: true });
    const stats = getPlayerStats(player);
    const heal = Math.floor(stats.maxHp * 0.4);
    player.hp = Math.min(stats.maxHp, player.hp + heal);
    player.reverseCooldown = 3;
    await interaction.update({ content: `♻️ ${heal} HP 회복!`, components: [mkCullingButtons(player)] });
  }
  else if (action === "c_escape") {
    player.xp += culling.totalXp;
    player.crystals += culling.totalCrystals;
    delete cullings[interaction.user.id];
    return interaction.update({ content: `🏳️ 종료! +${culling.totalXp} XP, +${culling.totalCrystals}💎`, components: [] });
  }
  
  if (culling.enemyHp <= 0) {
    culling.totalXp += enemy.xp;
    culling.totalCrystals += enemy.crystals;
    player.mastery[player.active] = (player.mastery[player.active] || 0) + (enemy.masteryXp || 1);
    culling.kills++;
    culling.wave++;
    if (culling.wave > player.cullingBest) player.cullingBest = culling.wave;
    if (enemy.fingers) player.sukunaFingers = Math.min(SUKUNA_FINGER_MAX, (player.sukunaFingers || 0) + enemy.fingers);
    checkAchievements(player);
    culling.currentEnemy = pickCullingEnemy(culling.wave);
    culling.enemyHp = culling.currentEnemy.hp;
    await interaction.editReply({ content: `✅ WAVE ${culling.wave}! +${enemy.xp} XP, +${enemy.crystals}💎`, components: [mkCullingButtons(player)] });
  } else {
    if (rollHit(player.statusEffects)) {
      const dmg = calcDmg(enemy.atk, getPlayerStats(player).def);
      player.hp = Math.max(0, player.hp - dmg);
      await interaction.followUp({ content: `💥 적 공격! ${dmg} 데미지!`, ephemeral: false });
    }
    const tick = tickStatus(player, getPlayerStats(player).maxHp);
    if (tick.dmg > 0) await interaction.followUp({ content: tick.log.join("\n"), ephemeral: false });
  }
  
  if (player.hp <= 0) {
    delete cullings[interaction.user.id];
    await interaction.editReply({ content: `💀 컬링 패배...`, components: [] });
  }
  tickCooldowns(player);
  savePlayer(interaction.user.id);
}

// ════════════════════════════════════════════════════════
// ── 봇 초기화 및 명령어 등록
// ════════════════════════════════════════════════════════
client.once("ready", async () => {
  console.log(`✅ 로그인: ${client.user.tag}`);
  await dbInit();
  players = await dbLoad();
  console.log("🚀 주술회전 RPG 봇 활성화");
  
  const commands = [
    { name: "프로필", description: "내 프로필 확인" },
    { name: "도감", description: "보유 캐릭터 확인" },
    { name: "전투", description: "일반 전투" },
    { name: "술식", description: "술식 트리 확인" },
    { name: "가챠", description: "캐릭터 뽑기", options: [{ name: "횟수", type: 4, description: "1 또는 10", required: true }] },
    { name: "활성", description: "활성 캐릭터 변경", options: [{ name: "캐릭터", type: 3, description: "캐릭터 ID", required: true }] },
    { name: "출석", description: "출석 체크" },
    { name: "회복", description: "회복약 사용" },
    { name: "코가네가챠", description: "코가네 뽑기 (200💎)" },
    { name: "코가네", description: "코가네 정보" },
    { name: "손가락", description: "스쿠나 손가락 현황" },
    { name: "컬링", description: "컬링 게임" },
    { name: "사멸회유", description: "사멸회유" },
    { name: "결투", description: "PvP 결투", options: [{ name: "대상", type: 6, description: "대상", required: true }] },
    { name: "파티생성", description: "파티 생성" },
    { name: "파티초대", description: "파티 초대", options: [{ name: "대상", type: 6, description: "대상", required: true }] },
    { name: "파티나가기", description: "파티 탈퇴" },
    { name: "파티컬링", description: "파티 컬링" },
    { name: "주력설정", description: "주력 스킬 설정", options: [{ name: "스킬명", type: 3, description: "스킬 이름", required: true }] },
    { name: "도전과제", description: "도전과제 확인" },
    { name: "코드", description: "쿠폰 사용", options: [{ name: "코드", type: 3, description: "코드", required: true }] },
    { name: "도움말", description: "명령어 목록" },
  ];
  
  if (isDev(client.user.id)) {
    commands.push(
      { name: "개발자패널", description: "개발자 패널" },
      { name: "쿨다운초기화", description: "쿨다운 초기화" },
      { name: "아이템지급", description: "아이템 지급", options: [{ name: "아이템", type: 3, description: "아이템", required: true }, { name: "수량", type: 4, description: "수량" }] }
    );
  }
  
  await client.application.commands.set(commands);
  console.log("✅ 명령어 등록 완료");
});

// ════════════════════════════════════════════════════════
// ── 상호작용 처리
// ════════════════════════════════════════════════════════
client.on("interactionCreate", async (interaction) => {
  if (interaction.isButton()) {
    const userId = interaction.user.id;
    const player = getPlayer(userId, interaction.user.username);
    
    if (interaction.customId.startsWith("b_")) {
      const battle = battles[userId];
      if (!battle) return interaction.reply({ content: "⚔️ 전투 없음", ephemeral: true });
      await handleBattleAction(interaction, player, battle, interaction.customId);
    }
    else if (interaction.customId.startsWith("c_")) {
      const culling = cullings[userId];
      if (!culling) return interaction.reply({ content: "🌊 컬링 없음", ephemeral: true });
      await handleCullingAction(interaction, player, culling, interaction.customId);
    }
    else if (interaction.customId.startsWith("party_invite_accept_")) {
      const parts = interaction.customId.split("_");
      const partyId = parts[3];
      const targetId = parts[4];
      if (interaction.user.id !== targetId) return interaction.reply({ content: "❌ 본인 초대만 가능", ephemeral: true });
      const invite = partyInvites[targetId];
      if (!invite || invite.partyId !== partyId) return interaction.reply({ content: "❌ 만료됨", ephemeral: true });
      const party = parties[partyId];
      if (!party) return interaction.reply({ content: "❌ 파티 없음", ephemeral: true });
      if (party.members.length >= 4) return interaction.reply({ content: "❌ 정원 초과", ephemeral: true });
      party.members.push(targetId);
      delete partyInvites[targetId];
      await interaction.update({ content: `✅ 파티 참가! (${party.members.length}/4)`, components: [] });
    }
    else if (interaction.customId.startsWith("party_invite_decline_")) {
      const targetId = interaction.customId.split("_")[4];
      if (interaction.user.id !== targetId) return;
      delete partyInvites[targetId];
      await interaction.update({ content: `❌ 초대 거절`, components: [] });
    }
    else if (interaction.customId.startsWith("pvp_challenge_accept_")) {
      const challengerId = interaction.customId.split("_")[3];
      const challenge = pvpChallenges[challengerId];
      if (!challenge || challenge.target !== interaction.user.id) return interaction.reply({ content: "❌ 유효하지 않음", ephemeral: true });
      if (getPvpSessionByUser(interaction.user.id) || getPvpSessionByUser(challengerId)) {
        return interaction.reply({ content: "❌ 이미 PvP 중", ephemeral: true });
      }
      const p1 = players[challengerId], p2 = players[interaction.user.id];
      const s1 = getPlayerStats(p1), s2 = getPlayerStats(p2);
      const sessionId = `${_pvpIdSeq++}`;
      pvpSessions[sessionId] = {
        id: sessionId, p1Id: challengerId, p2Id: interaction.user.id,
        hp1: s1.maxHp, hp2: s2.maxHp, status1: [], status2: [],
        skillCd1: 0, skillCd2: 0, reverseCd1: 0, reverseCd2: 0,
        turn: challengerId, round: 1,
      };
      delete pvpChallenges[challengerId];
      await interaction.update({ content: `⚔️ 결투 시작!`, components: [] });
    }
    else if (interaction.customId.startsWith("pvp_challenge_decline_")) {
      delete pvpChallenges[interaction.customId.split("_")[3]];
      await interaction.update({ content: `❌ 결투 거절`, components: [] });
    }
    return;
  }
  
  if (interaction.isChatInputCommand()) {
    const userId = interaction.user.id;
    let player = getPlayer(userId, interaction.user.username);
    
    switch (interaction.commandName) {
      case "프로필": return interaction.reply({ embeds: [profileEmbed(player)] });
      case "도감": return interaction.reply({ embeds: [pokedexEmbed(player)] });
      case "술식": return interaction.reply({ embeds: [skillEmbed(player)] });
      case "전투":
        if (battles[userId]) return interaction.reply({ content: "❌ 이미 전투 중", ephemeral: true });
        battles[userId] = { enemy: { ...ENEMIES[0], currentHp: ENEMIES[0].hp } };
        return interaction.reply({ content: `⚔️ **${ENEMIES[0].name}** 등장!`, components: [mkBattleButtons(player)] });
      case "컬링":
        if (cullings[userId]) return interaction.reply({ content: "❌ 이미 컬링 중", ephemeral: true });
        cullings[userId] = { wave: 1, kills: 0, totalXp: 0, totalCrystals: 0, currentEnemy: pickCullingEnemy(1), enemyHp: pickCullingEnemy(1).hp };
        return interaction.reply({ content: `🌊 WAVE 1! ${cullings[userId].currentEnemy.name} 등장!`, components: [mkCullingButtons(player)] });
      case "가챠":
        const count = interaction.options.getInteger("횟수");
        if (count !== 1 && count !== 10) return interaction.reply({ content: "❌ 1 또는 10만 가능", ephemeral: true });
        const cost = count === 1 ? 150 : 1350;
        if (player.crystals < cost) return interaction.reply({ content: `💎 부족! 필요 ${cost}`, ephemeral: true });
        player.crystals -= cost;
        const results = rollGacha(count);
        const newOnes = results.filter(id => !player.owned.includes(id));
        const dupCrystals = (count - newOnes.length) * 50;
        newOnes.forEach(id => player.owned.push(id));
        player.crystals += dupCrystals;
        const resultMsg = results.map(id => `${CHARACTERS[id].emoji} ${CHARACTERS[id].name}${newOnes.includes(id) ? " ✨NEW✨" : " (중복)"}`).join("\n");
        await interaction.reply({ content: `🎲 **${count}연차 결과**\n${resultMsg}\n✨ 신규: ${newOnes.length}명\n💎 보상: +${dupCrystals}\n💰 잔여: ${player.crystals}💎` });
        savePlayer(userId);
        break;
      case "활성":
        const charId = interaction.options.getString("캐릭터").toLowerCase();
        if (!player.owned.includes(charId)) return interaction.reply({ content: "❌ 미보유 캐릭터", ephemeral: true });
        player.active = charId;
        player.hp = getPlayerStats(player).maxHp;
        await interaction.reply(`✅ 활성: **${CHARACTERS[charId].name}**`);
        savePlayer(userId);
        break;
      case "출석":
        const now = Date.now();
        if (player.lastDaily && now - player.lastDaily < 86400000) {
          const remain = Math.ceil((86400000 - (now - player.lastDaily)) / 3600000);
          return interaction.reply({ content: `⏰ ${remain}시간 후 가능`, ephemeral: true });
        }
        const streakBonus = Math.min(player.dailyStreak || 0, 30);
        const addCrystals = 100 + streakBonus * 5;
        player.crystals += addCrystals;
        player.lastDaily = now;
        player.dailyStreak = (player.dailyStreak || 0) + 1;
        await interaction.reply(`✅ 출석! +${addCrystals}💎 (${player.dailyStreak}일 연속)`);
        savePlayer(userId);
        break;
      case "회복":
        if (player.potion <= 0) return interaction.reply({ content: "❌ 회복약 없음", ephemeral: true });
        player.hp = getPlayerStats(player).maxHp;
        player.potion--;
        await interaction.reply(`✅ HP 회복! (남은: ${player.potion}개)`);
        savePlayer(userId);
        break;
      case "코가네가챠":
        if (player.crystals < 200) return interaction.reply({ content: "❌ 200💎 필요", ephemeral: true });
        player.crystals -= 200;
        player.koganeGachaCount = (player.koganeGachaCount || 0) + 1;
        const newGrade = rollKogane();
        const gradeOrder = ["3급", "2급", "1급", "특급", "전설"];
        const isUpgrade = !player.kogane || gradeOrder.indexOf(newGrade) > gradeOrder.indexOf(player.kogane);
        if (isUpgrade) player.kogane = newGrade;
        else player.crystals += 50;
        await interaction.reply(`🐾 코가네: **${newGrade}**${isUpgrade ? " (등급 상승!)" : " (하위 등급, +50💎)"}\n${KOGANE_GRADES[newGrade].passiveDesc}`);
        savePlayer(userId);
        break;
      case "코가네":
        if (!player.kogane) return interaction.reply("🐾 코가네 없음. `/코가네가챠`로 획득!");
        const g = KOGANE_GRADES[player.kogane];
        await interaction.reply(`🐾 **코가네 [${player.kogane}]** ${g.stars}\n${g.passiveDesc}`);
        break;
      case "손가락":
        const fingers = player.sukunaFingers || 0;
        const fb = getFingerBonus(fingers);
        await interaction.reply(`👹 **스쿠나 손가락**: ${fingers}/${SUKUNA_FINGER_MAX}\n${fb.label}\n🗡️ ATK +${fb.atkBonus} | 🛡️ DEF +${fb.defBonus} | 💚 HP +${fb.hpBonus}\n✨ 스킬 보너스: +${fb.skillBonus}%`);
        break;
      case "사멸회유":
        if (jujutsus[userId]) return interaction.reply({ content: "❌ 이미 진행 중", ephemeral: true });
        const choices = generateJujutsuChoices(1);
        jujutsus[userId] = { wave: 1, points: 0, totalXp: 0, totalCrystals: 0, choices };
        const choiceText = choices.map((c, i) => `**[${i+1}]** ${c.emoji} ${c.name} (+${c.points}pt)`).join("\n");
        await interaction.reply(`🎯 **사멸회유 WAVE 1**\n적을 선택하세요!\n${choiceText}`);
        break;
      case "결투":
        const target = interaction.options.getUser("대상");
        if (target.id === userId) return interaction.reply({ content: "❌ 자기 자신 불가", ephemeral: true });
        if (getPvpSessionByUser(userId) || getPvpSessionByUser(target.id)) return interaction.reply({ content: "❌ 이미 PvP 중", ephemeral: true });
        pvpChallenges[userId] = { target: target.id };
        await interaction.reply({ content: `${target}님, **${interaction.user.username}**님이 결투 요청!\n30초 내에 수락/거절 해주세요.`, components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`pvp_challenge_accept_${userId}`).setLabel("✅ 수락").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`pvp_challenge_decline_${userId}`).setLabel("❌ 거절").setStyle(ButtonStyle.Danger)
          )
        ] });
        setTimeout(() => { if (pvpChallenges[userId]) delete pvpChallenges[userId]; }, 30000);
        break;
      case "파티생성":
        if (getPartyId(userId)) return interaction.reply({ content: "❌ 이미 파티 있음", ephemeral: true });
        parties[`${_partyIdSeq++}`] = { id: `${_partyIdSeq-1}`, leader: userId, members: [userId] };
        await interaction.reply(`✅ 파티 생성! /파티초대 @유저 로 초대하세요.`);
        break;
      case "파티초대":
        const inviteTarget = interaction.options.getUser("대상");
        const party = getParty(userId);
        if (!party) return interaction.reply({ content: "❌ 파티 없음", ephemeral: true });
        if (party.leader !== userId) return interaction.reply({ content: "❌ 파티장만 가능", ephemeral: true });
        if (party.members.length >= 4) return interaction.reply({ content: "❌ 정원 초과", ephemeral: true });
        if (getPartyId(inviteTarget.id)) return interaction.reply({ content: "❌ 상대방이 이미 파티 있음", ephemeral: true });
        partyInvites[inviteTarget.id] = { partyId: party.id, inviter: userId };
        await interaction.reply({ content: `${inviteTarget}님 초대장 발송!`, components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`party_invite_accept_${party.id}_${inviteTarget.id}`).setLabel("✅ 수락").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`party_invite_decline_${party.id}_${inviteTarget.id}`).setLabel("❌ 거절").setStyle(ButtonStyle.Danger)
          )
        ] });
        setTimeout(() => { if (partyInvites[inviteTarget.id]) delete partyInvites[inviteTarget.id]; }, 60000);
        break;
      case "파티나가기":
        const myParty = getParty(userId);
        if (!myParty) return interaction.reply({ content: "❌ 파티 없음", ephemeral: true });
        const wasLeader = myParty.leader === userId;
        myParty.members = myParty.members.filter(id => id !== userId);
        if (myParty.members.length === 0) delete parties[myParty.id];
        else if (wasLeader) myParty.leader = myParty.members[0];
        await interaction.reply(`✅ 파티 탈퇴${wasLeader && myParty.members.length > 0 ? ` (새 파티장: ${myParty.leader})` : ""}`);
        break;
      case "파티컬링":
        const p = getParty(userId);
        if (!p) return interaction.reply({ content: "❌ 파티 없음", ephemeral: true });
        if (p.leader !== userId) return interaction.reply({ content: "❌ 파티장만 가능", ephemeral: true });
        if (cullings[p.id]) return interaction.reply({ content: "❌ 이미 진행 중", ephemeral: true });
        for (const uid of p.members) if (players[uid]?.hp <= 0) return interaction.reply({ content: "❌ 전투 불능 멤버 있음", ephemeral: true });
        cullings[p.id] = { wave: 1, kills: 0, totalXp: 0, totalCrystals: 0, currentEnemy: pickCullingEnemy(1), enemyHp: pickCullingEnemy(1).hp };
        await interaction.reply(`⚔️ **파티 컬링 시작!** WAVE 1\n${p.members.length}명 파티원 전투 시작!`);
        break;
      case "주력설정":
        const skillName = interaction.options.getString("스킬명");
        const ch = CHARACTERS[player.active];
        const sk = ch.skills.find(s => s.name === skillName);
        if (!sk) return interaction.reply({ content: "❌ 없는 스킬명", ephemeral: true });
        if (getMastery(player, player.active) < sk.minMastery) return interaction.reply({ content: `❌ 숙련도 부족 (필요: ${sk.minMastery})`, ephemeral: true });
        player.mainSkill = skillName;
        await interaction.reply(`✅ 주력 스킬: **${skillName}** (+${getMainSkillBonus(player)}% 데미지 보너스)`);
        savePlayer(userId);
        break;
      case "도전과제":
        const bonus = getMainSkillBonus(player);
        await interaction.reply({
          content: [
            `**🎯 도전과제** (주력 스킬 보너스: +${bonus}%)`,
            `${player.achievements.firstWin ? "✅" : "⬜"} 첫 승리 (${player.wins}/1) → +10%`,
            `${player.achievements.fingerCollector ? "✅" : "⬜"} 손가락 수집가 (${player.sukunaFingers || 0}/5) → +20%`,
            `${player.achievements.cullingMaster ? "✅" : "⬜"} 컬링 마스터 (${player.cullingBest}/5) → +15%`,
            `${player.achievements.jujutsuComplete ? "✅" : "⬜"} 사멸회유 완료 (${player.jujutsuBest || 0}/15) → +25%`,
            `${player.achievements.pvpFirstWin ? "✅" : "⬜"} PvP 첫 승 (${player.pvpWins || 0}/1) → +20%`,
          ].join("\n")
        });
        break;
      case "코드":
        const code = interaction.options.getString("코드").toLowerCase();
        if (player.usedCodes.includes(code)) return interaction.reply({ content: "❌ 이미 사용함", ephemeral: true });
        if (CODES[code]) {
          player.crystals += CODES[code].crystals;
          player.usedCodes.push(code);
          await interaction.reply(`✅ +${CODES[code].crystals}💎`);
          savePlayer(userId);
        } else await interaction.reply({ content: "❌ 유효하지 않은 코드", ephemeral: true });
        break;
      case "도움말":
        await interaction.reply({
          content: [
            "🔱 **주술회전 RPG 명령어** 🔱",
            "",
            "**⚔️ 전투**",
            "/전투 - 일반 전투",
            "/컬링 - 웨이브 컬링",
            "/사멸회유 - 포인트 수집",
            "/결투 @유저 - PvP",
            "",
            "**🎲 시스템**",
            "/프로필 - 내 정보",
            "/도감 - 캐릭터 목록",
            "/술식 - 스킬 트리",
            "/가챠 [1/10] - 뽑기",
            "/코가네가챠 - 펫 뽑기",
            "/활성 [캐릭터] - 변경",
            "/주력설정 [스킬명] - 주력 변경",
            "/도전과제 - 진행도 확인",
            "/출석 - 매일 보상",
            "/회복 - HP 회복",
            "/손가락 - 스쿠나 현황",
            "/코드 [코드] - 쿠폰",
            "",
            "**👥 파티**",
            "/파티생성 /파티초대 /파티나가기 /파티컬링",
          ].join("\n")
        });
        break;
      case "개발자패널":
        if (!isDev(userId)) return;
        await interaction.reply({ content: "🛠️ 개발자 패널\n/쿨다운초기화\n/아이템지급 [아이템] [수량]", ephemeral: true });
        break;
      case "쿨다운초기화":
        if (!isDev(userId)) return;
        player.skillCooldown = 0;
        player.reverseCooldown = 0;
        await interaction.reply("✅ 초기화");
        savePlayer(userId);
        break;
      case "아이템지급":
        if (!isDev(userId)) return;
        const item = interaction.options.getString("아이템");
        const amount = interaction.options.getInteger("수량") || 1;
        if (item === "크리스탈") player.crystals += amount;
        else if (item === "회복약") player.potion += amount;
        else if (item === "손가락") player.sukunaFingers = Math.min(SUKUNA_FINGER_MAX, (player.sukunaFingers || 0) + amount);
        else return interaction.reply({ content: "❌ 크리스탈/회복약/손가락", ephemeral: true });
        await interaction.reply(`✅ ${item} +${amount}`);
        savePlayer(userId);
        break;
    }
  }
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith("!")) return;
  
  const args = message.content.slice(1).trim().split(/\s+/);
  const cmd = args[0].toLowerCase();
  const userId = message.author.id;
  let player = getPlayer(userId, message.author.username);
  
  if (cmd === "프로필") return message.reply({ embeds: [profileEmbed(player)] });
  if (cmd === "도감") return message.reply({ embeds: [pokedexEmbed(player)] });
  if (cmd === "술식") return message.reply({ embeds: [skillEmbed(player)] });
  if (cmd === "전투") {
    if (battles[userId]) return message.reply("❌ 이미 전투 중");
    battles[userId] = { enemy: { ...ENEMIES[0], currentHp: ENEMIES[0].hp } };
    return message.reply({ content: `⚔️ ${ENEMIES[0].name} 등장!`, components: [mkBattleButtons(player)] });
  }
  if (cmd === "컬링") {
    if (cullings[userId]) return message.reply("❌ 이미 컬링 중");
    cullings[userId] = { wave: 1, kills: 0, totalXp: 0, totalCrystals: 0, currentEnemy: pickCullingEnemy(1), enemyHp: pickCullingEnemy(1).hp };
    return message.reply({ content: `🌊 WAVE 1! ${cullings[userId].currentEnemy.name} 등장!`, components: [mkCullingButtons(player)] });
  }
  if (cmd === "가챠") {
    const count = parseInt(args[1]) || 1;
    if (count !== 1 && count !== 10) return message.reply("❌ 1 또는 10만 가능");
    const cost = count === 1 ? 150 : 1350;
    if (player.crystals < cost) return message.reply(`💎 부족! 필요 ${cost}`);
    player.crystals -= cost;
    const results = rollGacha(count);
    const newOnes = results.filter(id => !player.owned.includes(id));
    const dupCrystals = (count - newOnes.length) * 50;
    newOnes.forEach(id => player.owned.push(id));
    player.crystals += dupCrystals;
    const resultMsg = results.map(id => `${CHARACTERS[id].emoji} ${CHARACTERS[id].name}${newOnes.includes(id) ? " ✨NEW✨" : " (중복)"}`).join("\n");
    await message.reply(`🎲 **${count}연차 결과**\n${resultMsg}\n✨ 신규: ${newOnes.length}명\n💎 보상: +${dupCrystals}\n💰 잔여: ${player.crystals}💎`);
    savePlayer(userId);
  }
  if (cmd === "활성") {
    const charId = args[1]?.toLowerCase();
    if (!charId) return message.reply("!활성 [캐릭터ID]");
    if (!player.owned.includes(charId)) return message.reply("❌ 미보유");
    player.active = charId;
    player.hp = getPlayerStats(player).maxHp;
    await message.reply(`✅ 활성: ${CHARACTERS[charId].name}`);
    savePlayer(userId);
  }
  if (cmd === "출석") {
    const now = Date.now();
    if (player.lastDaily && now - player.lastDaily < 86400000) {
      const remain = Math.ceil((86400000 - (now - player.lastDaily)) / 3600000);
      return message.reply(`⏰ ${remain}시간 후 가능`);
    }
    const streakBonus = Math.min(player.dailyStreak || 0, 30);
    const addCrystals = 100 + streakBonus * 5;
    player.crystals += addCrystals;
    player.lastDaily = now;
    player.dailyStreak = (player.dailyStreak || 0) + 1;
    await message.reply(`✅ 출석! +${addCrystals}💎 (${player.dailyStreak}일 연속)`);
    savePlayer(userId);
  }
  if (cmd === "회복") {
    if (player.potion <= 0) return message.reply("❌ 회복약 없음");
    player.hp = getPlayerStats(player).maxHp;
    player.potion--;
    await message.reply(`✅ HP 회복! (남은: ${player.potion}개)`);
    savePlayer(userId);
  }
  if (cmd === "코가네가챠") {
    if (player.crystals < 200) return message.reply("❌ 200💎 필요");
    player.crystals -= 200;
    player.koganeGachaCount = (player.koganeGachaCount || 0) + 1;
    const newGrade = rollKogane();
    const gradeOrder = ["3급", "2급", "1급", "특급", "전설"];
    const isUpgrade = !player.kogane || gradeOrder.indexOf(newGrade) > gradeOrder.indexOf(player.kogane);
    if (isUpgrade) player.kogane = newGrade;
    else player.crystals += 50;
    await message.reply(`🐾 코가네: **${newGrade}**${isUpgrade ? " (등급 상승!)" : " (하위 등급, +50💎)"}\n${KOGANE_GRADES[newGrade].passiveDesc}`);
    savePlayer(userId);
  }
  if (cmd === "코가네") {
    if (!player.kogane) return message.reply("🐾 코가네 없음. !코가네가챠로 획득!");
    const g = KOGANE_GRADES[player.kogane];
    await message.reply(`🐾 **코가네 [${player.kogane}]** ${g.stars}\n${g.passiveDesc}`);
  }
  if (cmd === "손가락") {
    const fingers = player.sukunaFingers || 0;
    const fb = getFingerBonus(fingers);
    await message.reply(`👹 스쿠나 손가락: ${fingers}/${SUKUNA_FINGER_MAX}\n${fb.label}\n🗡️ ATK +${fb.atkBonus} | 🛡️ DEF +${fb.defBonus} | 💚 HP +${fb.hpBonus}`);
  }
  if (cmd === "주력설정") {
    const skillName = args.slice(1).join(" ");
    if (!skillName) return message.reply("!주력설정 [스킬명]");
    const ch = CHARACTERS[player.active];
    const sk = ch.skills.find(s => s.name === skillName);
    if (!sk) return message.reply("❌ 없는 스킬명");
    if (getMastery(player, player.active) < sk.minMastery) return message.reply(`❌ 숙련도 부족 (필요: ${sk.minMastery})`);
    player.mainSkill = skillName;
    await message.reply(`✅ 주력 스킬: **${skillName}** (+${getMainSkillBonus(player)}% 데미지 보너스)`);
    savePlayer(userId);
  }
  if (cmd === "도전과제") {
    const bonus = getMainSkillBonus(player);
    await message.reply([
      `**🎯 도전과제** (주력 스킬 보너스: +${bonus}%)`,
      `${player.achievements.firstWin ? "✅" : "⬜"} 첫 승리 (${player.wins}/1) → +10%`,
      `${player.achievements.fingerCollector ? "✅" : "⬜"} 손가락 수집가 (${player.sukunaFingers || 0}/5) → +20%`,
      `${player.achievements.cullingMaster ? "✅" : "⬜"} 컬링 마스터 (${player.cullingBest}/5) → +15%`,
      `${player.achievements.jujutsuComplete ? "✅" : "⬜"} 사멸회유 완료 (${player.jujutsuBest || 0}/15) → +25%`,
      `${player.achievements.pvpFirstWin ? "✅" : "⬜"} PvP 첫 승 (${player.pvpWins || 0}/1) → +20%`,
    ].join("\n"));
  }
  if (cmd === "도움말") {
    await message.reply("🔱 **명령어**\n!프로필 !도감 !술식 !전투 !컬링 !가챠 !활성 !출석 !회복 !코가네가챠 !코가네 !손가락 !주력설정 !도전과제 !코드\n슬래시(/)도 가능");
  }
});

client.login(TOKEN);
