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
// ── 스킬 이펙트 아트 (생략 - 원본과 동일)
// ════════════════════════════════════════════════════════
const SKILL_EFFECTS = { /* 원본과 동일하게 유지 */ };
function getSkillEffect(skillName) { return SKILL_EFFECTS[skillName] || SKILL_EFFECTS["_default"]; }

// ════════════════════════════════════════════════════════
// ── 캐릭터 데이터 (생략 - 원본과 동일)
// ════════════════════════════════════════════════════════
const CHARACTERS = { /* 원본과 동일하게 유지 */ };

// ════════════════════════════════════════════════════════
// ── 적 데이터 (생략 - 원본과 동일)
// ════════════════════════════════════════════════════════
const ENEMIES = [ /* 원본과 동일 */ ];
const JUJUTSU_ENEMIES = [ /* 원본과 동일 */ ];

// ════════════════════════════════════════════════════════
// ── 가챠 풀 (생략 - 원본과 동일)
// ════════════════════════════════════════════════════════
const GACHA_POOL = [ /* 원본과 동일 */ ];
const GACHA_RARITY = { /* 원본과 동일 */ };

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
// ── 플레이어 유틸 (생략 - 원본과 동일)
// ════════════════════════════════════════════════════════
function getPlayer(userId, username = "플레이어") { /* 원본과 동일 */ }
function getMastery(player, charId) { return player.mastery?.[charId] || 0; }
function getAvailableSkills(player, charId) { /* 원본과 동일 */ }
function getCurrentSkill(player, charId) { /* 원본과 동일 */ }
function getNextSkill(player, charId) { /* 원본과 동일 */ }
function getPlayerStats(player) { /* 원본과 동일 */ }
function masteryBar(mastery, charId) { /* 원본과 동일 */ }
function getLevel(xp) { return Math.floor(xp / 200) + 1; }
function hpBar(cur, max, len = 10) { /* 원본과 동일 */ }
function hpBarText(cur, max, len = 12) { /* 원본과 동일 */ }
function isMakiAwakened(player) { /* 원본과 동일 */ }
function calcDmg(atk, def, mult = 1) { /* 원본과 동일 */ }
function calcDmgForPlayer(player, enemyDef, baseMult = 1) { /* 원본과 동일 */ }
function calcSkillDmgForPlayer(player, baseSkillDmg) { /* 원본과 동일 */ }
function applySkillStatus(skill, defenderObj, attackerObj = null) { /* 원본과 동일 */ }
function tickCooldowns(player) { /* 원본과 동일 */ }
function parseSkillIndex(value) { /* 원본과 동일 */ }

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
// ── 컬링/사멸회유 유틸 (생략 - 원본과 동일)
// ════════════════════════════════════════════════════════
function getCullingPool(wave) { /* 원본과 동일 */ }
function pickCullingEnemy(wave) { /* 원본과 동일 */ }
function generateJujutsuChoices(wave) { /* 원본과 동일 */ }

// ════════════════════════════════════════════════════════
// ── 임베드 함수들 (생략 - 원본과 동일)
// ════════════════════════════════════════════════════════
function profileEmbed(player) { /* 원본과 동일 */ }
function koganeProfileEmbed(player) { /* 원본과 동일 */ }
function koganeGachaEmbed(grade, isUpgrade, player) { /* 원본과 동일 */ }
function gachaLoadingEmbed(stage = 1) { /* 원본과 동일 */ }
function gachaRevealEmbed(grade) { /* 원본과 동일 */ }
function gachaResultEmbed(charId, isNew, player) { /* 원본과 동일 */ }
function gacha10ResultEmbed(results, newOnes, dupCrystals, player) { /* 원본과 동일 */ }
function skillEmbed(player) { /* 원본과 동일 */ }
function skillActivationEmbed(player, skill, dmg, log, enemy, enemyHp, isOver, isWin) { /* 원본과 동일 */ }
function cullingEmbed(player, session, log = []) { /* 원본과 동일 */ }
function jujutsuEmbed(player, session, log = [], choices = null) { /* 원본과 동일 */ }
function pvpEmbed(session, log = []) { /* 원본과 동일 */ }
function partyCullingEmbed(party, session, log = []) { /* 원본과 동일 */ }

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
// ── 전투 핸들러 (일반, 컬링, 사멸회유, 파티, PvP)
// ════════════════════════════════════════════════════════
// [전투 핸들러 함수들은 원본과 동일하게 유지]
// handleBattleAction, handleCullingAction, handleJujutsuAction, 
// handlePartyCullingAction, handlePvpAction 함수들...

// ════════════════════════════════════════════════════════
// ── Discord 봇 명령어 및 상호작용
// ════════════════════════════════════════════════════════
client.once("ready", async () => {
  console.log(`✅ 로그인: ${client.user.tag}`);
  await dbInit();
  players = await dbLoad();
  console.log("🚀 주술회전 RPG 봇 활성화");
});

client.on("interactionCreate", async (interaction) => {
  if (interaction.isButton()) await handleButton(interaction);
  else if (interaction.isChatInputCommand()) await handleCommand(interaction);
  else if (interaction.isStringSelectMenu()) await handleSelectMenu(interaction);
});

async function handleButton(interaction) {
  const { customId, user } = interaction;
  const userId = user.id;
  const player = getPlayer(userId, user.username);

  // ── 일반 전투 버튼 ──
  if (customId.startsWith("b_")) {
    const battle = battles[userId];
    if (!battle) return interaction.reply({ content: "⚔️ 진행 중인 전투가 없습니다.", ephemeral: true });
    await handleBattleAction(interaction, player, battle);
    return;
  }

  // ── 컬링 버튼 ──
  if (customId.startsWith("c_")) {
    const culling = cullings[userId];
    if (!culling) return interaction.reply({ content: "🌊 진행 중인 컬링이 없습니다.", ephemeral: true });
    await handleCullingAction(interaction, player, culling);
    return;
  }

  // ── 사멸회유 버튼 ──
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
        await interaction.update({ embeds: [embed], components: mkJujutsuButtons(player, []) });
      } else {
        await interaction.reply({ content: "❌ 잘못된 선택입니다.", ephemeral: true });
      }
      return;
    }
  }

  // ── 파티 초대 버튼 ──
  if (customId.startsWith("party_invite_")) {
    const [_, __, partyId, targetId] = customId.split("_");
    if (userId !== targetId) return interaction.reply({ content: "❌ 이 초대는 당신을 위한 것이 아닙니다.", ephemeral: true });
    const invite = partyInvites[targetId];
    if (!invite || invite.partyId !== partyId) return interaction.reply({ content: "❌ 만료되었거나 유효하지 않은 초대입니다.", ephemeral: true });
    
    if (customId.includes("accept")) {
      const party = parties[partyId];
      if (!party) return interaction.reply({ content: "❌ 파티가 이미 해체되었습니다.", ephemeral: true });
      if (party.members.length >= 4) return interaction.reply({ content: "❌ 파티가 가득 찼습니다. (최대 4명)", ephemeral: true });
      if (getPartyId(targetId)) return interaction.reply({ content: "❌ 이미 다른 파티에 소속되어 있습니다.", ephemeral: true });
      
      party.members.push(targetId);
      delete partyInvites[targetId];
      
      const partyChannel = await client.channels.fetch(interaction.channelId).catch(() => null);
      if (partyChannel) {
        await partyChannel.send(`✅ **${user.username}**님이 파티에 참가했습니다! (${party.members.length}/4)`);
      }
      await interaction.update({ content: `✅ 파티에 참가했습니다!`, embeds: [], components: [] });
    } else if (customId.includes("decline")) {
      delete partyInvites[targetId];
      await interaction.update({ content: `❌ 파티 초대를 거절했습니다.`, embeds: [], components: [] });
    }
    return;
  }

  // ── PvP 도전/수락 버튼 ──
  if (customId.startsWith("pvp_challenge_")) {
    const parts = customId.split("_");
    const action = parts[2];
    const targetId = parts[3];
    
    if (action === "accept") {
      const challenge = pvpChallenges[targetId];
      if (!challenge || challenge.target !== userId) return interaction.reply({ content: "❌ 유효하지 않은 도전입니다.", ephemeral: true });
      if (getPvpSessionByUser(userId) || getPvpSessionByUser(targetId)) {
        return interaction.reply({ content: "❌ 둘 중 한 명이 이미 PvP 중입니다.", ephemeral: true });
      }
      
      const p1 = players[targetId];
      const p2 = players[userId];
      const stats1 = getPlayerStats(p1);
      const stats2 = getPlayerStats(p2);
      
      const sessionId = `${_pvpIdSeq++}`;
      pvpSessions[sessionId] = {
        id: sessionId, p1Id: targetId, p2Id: userId,
        hp1: stats1.maxHp, hp2: stats2.maxHp,
        status1: [], status2: [],
        skillCd1: 0, skillCd2: 0,
        reverseCd1: 0, reverseCd2: 0,
        domainUsed1: false, domainUsed2: false,
        turn: targetId, round: 1,
      };
      delete pvpChallenges[targetId];
      
      const embed = pvpEmbed(pvpSessions[sessionId]);
      const buttons = mkPvpButtons(pvpSessions[sessionId], targetId);
      await interaction.update({ embeds: [embed], components: [buttons] });
      await interaction.followUp({ content: `<@${targetId}> VS <@${userId}> 결투 시작!`, ephemeral: false });
    } else if (action === "decline") {
      delete pvpChallenges[targetId];
      await interaction.update({ content: `❌ 상대방이 결투를 거절했습니다.`, embeds: [], components: [] });
    }
    return;
  }

  // ── PvP 전투 버튼 ──
  if (customId.startsWith("p_")) {
    const session = getPvpSessionByUser(userId);
    if (!session) return interaction.reply({ content: "⚔️ 진행 중인 PvP가 없습니다.", ephemeral: true });
    if (session.turn !== userId) return interaction.reply({ content: "⏳ 지금은 당신의 턴이 아닙니다!", ephemeral: true });
    await handlePvpAction(interaction, players[userId], session, customId);
    return;
  }

  // ── 파티 컬링 버튼 ──
  if (customId.startsWith("pc_")) {
    const party = getParty(userId);
    if (!party) return interaction.reply({ content: "👥 파티에 소속되어 있지 않습니다.", ephemeral: true });
    const session = cullings[party.id];
    if (!session) return interaction.reply({ content: "🌊 진행 중인 파티 컬링이 없습니다.", ephemeral: true });
    if (session.waitingForAction && session.waitingForAction !== userId) {
      return interaction.reply({ content: `⏳ 현재 **${players[session.waitingForAction]?.name}**님이 행동 중입니다.`, ephemeral: true });
    }
    if (players[userId].hp <= 0) return interaction.reply({ content: "💀 당신은 전투 불능 상태입니다!", ephemeral: true });
    await handlePartyCullingAction(interaction, players[userId], session, customId);
    return;
  }
}

async function handleSelectMenu(interaction) {
  const { customId, values, user } = interaction;
  const userId = user.id;
  const player = getPlayer(userId, user.username);

  // ── 술식 선택 메뉴 ──
  if (customId === "skill_select") {
    const battle = battles[userId] || cullings[userId] || jujutsus[userId];
    if (!battle) return interaction.reply({ content: "⚔️ 진행 중인 전투가 없습니다.", ephemeral: true });
    
    const skillIndex = parseInt(values[0].split("_")[1]);
    const skills = getAvailableSkills(player, player.active);
    if (skillIndex >= skills.length) return interaction.reply({ content: "❌ 유효하지 않은 스킬입니다.", ephemeral: true });
    
    battle.selectedSkill = skills[skillIndex];
    await interaction.update({ content: `🌀 **${battle.selectedSkill.name}**(으)로 준비 완료! 공격 버튼을 눌러주세요.`, components: [] });
    return;
  }
}

async function handleCommand(interaction) {
  const { commandName, user } = interaction;
  const userId = user.id;
  const player = getPlayer(userId, user.username);

  // ── 프로필 ──
  if (commandName === "프로필" || commandName === "profile") {
    await interaction.reply({ embeds: [profileEmbed(player)] });
    return;
  }

  // ── 전투 시작 ──
  if (commandName === "전투" || commandName === "battle") {
    if (battles[userId]) return interaction.reply("⚔️ 이미 전투 중입니다!");
    if (player.hp <= 0) {
      player.hp = getPlayerStats(player).maxHp;
      return interaction.reply("💀 사망 상태였습니다. HP가 회복되었습니다! 다시 시도해주세요.");
    }
    
    const enemy = JSON.parse(JSON.stringify(ENEMIES[Math.floor(Math.random() * ENEMIES.length)]));
    enemy.currentHp = enemy.hp;
    enemy.statusEffects = [];
    
    battles[userId] = {
      enemy: enemy,
      enemyHp: enemy.hp,
      log: [],
      turn: "player",
      selectedSkill: getCurrentSkill(player, player.active),
    };
    
    const embed = new EmbedBuilder()
      .setTitle(`⚔️ ${enemy.name} ${enemy.emoji} 과 전투 시작!`)
      .setColor(0xe63946)
      .setDescription(`**${player.name}** VS **${enemy.name}**\n${enemy.desc || "강력한 저주령!"}`);
    await interaction.reply({ embeds: [embed], components: [mkBattleButtons(player)] });
    return;
  }

  // ── 술식 트리 ──
  if (commandName === "술식" || commandName === "skill") {
    await interaction.reply({ embeds: [skillEmbed(player)] });
    return;
  }

  // ── 가챠 ──
  if (commandName === "가챠" || commandName === "gacha") {
    const count = interaction.options.getInteger("횟수") || 1;
    if (count !== 1 && count !== 10) return interaction.reply("❌ 1회 또는 10회만 가능합니다!");
    
    const cost = count === 1 ? 150 : 1350;
    if (player.crystals < cost) return interaction.reply(`💎 크리스탈이 부족합니다! (필요: ${cost})`);
    
    player.crystals -= cost;
    if (count === 1) {
      await interaction.reply({ embeds: [gachaLoadingEmbed(1)] });
      await new Promise(r => setTimeout(r, 1500));
      await interaction.editReply({ embeds: [gachaLoadingEmbed(2)] });
      await new Promise(r => setTimeout(r, 1500));
      
      const results = rollGacha(1);
      const charId = results[0];
      const isNew = !player.owned.includes(charId);
      if (isNew) player.owned.push(charId);
      else player.crystals += 50;
      
      const grade = CHARACTERS[charId].grade;
      await interaction.editReply({ embeds: [gachaRevealEmbed(grade)] });
      await new Promise(r => setTimeout(r, 1500));
      await interaction.editReply({ embeds: [gachaResultEmbed(charId, isNew, player)] });
    } else {
      await interaction.reply({ embeds: [gachaLoadingEmbed(1)] });
      await new Promise(r => setTimeout(r, 1500));
      
      const results = rollGacha(10);
      const newOnes = [];
      let dupCrystals = 0;
      
      for (const charId of results) {
        if (!player.owned.includes(charId)) {
          player.owned.push(charId);
          newOnes.push(charId);
        } else {
          dupCrystals += 50;
        }
      }
      player.crystals += dupCrystals;
      
      await interaction.editReply({ embeds: [gacha10ResultEmbed(results, newOnes, dupCrystals, player)] });
    }
    savePlayer(userId);
    return;
  }

  // ── 활성 캐릭터 변경 ──
  if (commandName === "활성" || commandName === "active") {
    const charId = interaction.options.getString("캐릭터");
    if (!player.owned.includes(charId)) return interaction.reply("❌ 해당 캐릭터를 보유하지 않았습니다!");
    player.active = charId;
    player.hp = getPlayerStats(player).maxHp;
    player.statusEffects = [];
    savePlayer(userId);
    await interaction.reply(`✅ 활성 캐릭터를 **${CHARACTERS[charId].name}**(으)로 변경했습니다!`);
    return;
  }

  // ── 출석 체크 ──
  if (commandName === "출석" || commandName === "daily") {
    const now = Date.now();
    const last = player.lastDaily || 0;
    const hoursDiff = (now - last) / (1000 * 60 * 60);
    
    if (hoursDiff < 24) {
      const remain = 24 - hoursDiff;
      return interaction.reply(`⏰ 이미 출석하셨습니다! ${Math.floor(remain)}시간 ${Math.floor((remain % 1) * 60)}분 후 다시 가능합니다.`);
    }
    
    let reward = 100;
    let streakBonus = 0;
    
    if (hoursDiff < 48) {
      player.dailyStreak = (player.dailyStreak || 0) + 1;
    } else {
      player.dailyStreak = 1;
    }
    
    if (player.dailyStreak >= 7) streakBonus = 100;
    else if (player.dailyStreak >= 3) streakBonus = 50;
    
    const total = reward + streakBonus;
    player.crystals += total;
    player.lastDaily = now;
    
    savePlayer(userId);
    await interaction.reply(`✅ 출석 체크! **${total}** 크리스탈 획득! (연속 ${player.dailyStreak}일)`);
    return;
  }

  // ── 회복약 사용 ──
  if (commandName === "회복" || commandName === "potion") {
    if (player.potion <= 0) return interaction.reply("🧪 회복약이 없습니다! 전투에서 획득하세요.");
    const stats = getPlayerStats(player);
    if (player.hp >= stats.maxHp) return interaction.reply("❤️ 이미 HP가 가득 찼습니다!");
    
    player.hp = Math.min(stats.maxHp, player.hp + Math.floor(stats.maxHp * 0.4));
    player.potion--;
    savePlayer(userId);
    await interaction.reply(`🧪 회복약 사용! HP가 회복되었습니다.\n현재 HP: ${player.hp}/${stats.maxHp} (남은 회복약: ${player.potion}개)`);
    return;
  }

  // ── 코가네 가챠 ──
  if (commandName === "코가네가챠" || commandName === "kogane") {
    if (player.crystals < 200) return interaction.reply("💎 크리스탈이 부족합니다! (필요: 200)");
    
    player.crystals -= 200;
    player.koganeGachaCount = (player.koganeGachaCount || 0) + 1;
    
    const grade = rollKogane();
    const isUpgrade = !player.kogane;
    const gradeOrder = ["3급","2급","1급","특급","전설"];
    const isBetter = player.kogane && gradeOrder.indexOf(grade) > gradeOrder.indexOf(player.kogane.grade);
    
    if (!player.kogane || isBetter) {
      player.kogane = { grade: grade, obtainedAt: Date.now() };
    } else {
      player.crystals += 50;
    }
    
    savePlayer(userId);
    await interaction.reply({ embeds: [koganeGachaEmbed(grade, isUpgrade || isBetter, player)] });
    return;
  }

  // ── 코가네 정보 ──
  if (commandName === "코가네" || commandName === "koganeinfo") {
    await interaction.reply({ embeds: [koganeProfileEmbed(player)] });
    return;
  }

  // ── 쿨다운 초기화 (개발자 전용) ──
  if (commandName === "쿨다운초기화" && isDev(userId)) {
    player.skillCooldown = 0;
    player.reverseCooldown = 0;
    if (player.statusEffects) player.statusEffects = [];
    savePlayer(userId);
    await interaction.reply("✅ 모든 쿨다운과 상태이상이 초기화되었습니다.");
    return;
  }

  // ── 아이템 지급 (개발자 전용) ──
  if (commandName === "아이템지급" && isDev(userId)) {
    const item = interaction.options.getString("아이템");
    const amount = interaction.options.getInteger("수량") || 1;
    
    if (item === "크리스탈") player.crystals += amount;
    else if (item === "회복약") player.potion += amount;
    else if (item === "손가락") player.sukunaFingers = Math.min(SUKUNA_FINGER_MAX, (player.sukunaFingers || 0) + amount);
    else return interaction.reply("❌ 잘못된 아이템입니다. (크리스탈, 회복약, 손가락)");
    
    savePlayer(userId);
    await interaction.reply(`✅ ${item} ${amount}개 지급 완료!`);
    return;
  }

  // ── 스쿠나 손가락 정보 ──
  if (commandName === "손가락" || commandName === "fingers") {
    const fingers = player.sukunaFingers || 0;
    const bonus = getFingerBonus(fingers);
    const nextBonus = getFingerBonus(fingers + 1);
    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle("👹 스쿠나 손가락")
        .setColor(0x8b0000)
        .setDescription(`**보유 손가락:** ${fingers}/${SUKUNA_FINGER_MAX}\n**현재 단계:** ${bonus.label}\n**효과:** ATK +${bonus.atkBonus} | DEF +${bonus.defBonus} | HP +${bonus.hpBonus}`)
        .setFooter({ text: fingers < SUKUNA_FINGER_MAX ? `다음 손가락 시 ATK +${nextBonus.atkBonus - bonus.atkBonus} | DEF +${nextBonus.defBonus - bonus.defBonus} | HP +${nextBonus.hpBonus - bonus.hpBonus}` : "최대치 도달!") })
    ]);
    return;
  }

  // ── 컬링 게임 ──
  if (commandName === "컬링" || commandName === "culling") {
    if (cullings[userId]) return interaction.reply("🌊 이미 컬링 중입니다!");
    if (player.hp <= 0) {
      player.hp = getPlayerStats(player).maxHp;
      return interaction.reply("💀 사망 상태였습니다. HP가 회복되었습니다! 다시 시도해주세요.");
    }
    
    const firstEnemy = pickCullingEnemy(1);
    firstEnemy.currentHp = firstEnemy.hp;
    cullings[userId] = {
      wave: 1, kills: 0, totalXp: 0, totalCrystals: 0,
      currentEnemy: firstEnemy, enemyHp: firstEnemy.hp,
      log: [], turn: "player", selectedSkill: getCurrentSkill(player, player.active),
    };
    
    const embed = cullingEmbed(player, cullings[userId]);
    await interaction.reply({ embeds: [embed], components: [mkCullingButtons(player)] });
    return;
  }

  // ── 사멸회유 ──
  if (commandName === "사멸회유" || commandName === "jujutsu") {
    if (jujutsus[userId]) return interaction.reply("🎯 이미 사멸회유 중입니다!");
    if (player.hp <= 0) {
      player.hp = getPlayerStats(player).maxHp;
      return interaction.reply("💀 사망 상태였습니다. HP가 회복되었습니다! 다시 시도해주세요.");
    }
    
    const choices = generateJujutsuChoices(1);
    jujutsus[userId] = {
      wave: 1, points: 0, totalXp: 0, totalCrystals: 0,
      choices: choices, currentEnemy: null, enemyHp: 0,
      log: [], turn: "player", selectedSkill: getCurrentSkill(player, player.active),
    };
    
    const embed = jujutsuEmbed(player, jujutsus[userId], [], choices);
    const [row1, row2] = mkJujutsuButtons(player, choices);
    await interaction.reply({ embeds: [embed], components: [row1, row2] });
    return;
  }

  // ── 결투 (PvP) ──
  if (commandName === "결투" || commandName === "pvp") {
    const target = interaction.options.getUser("대상");
    if (!target || target.id === userId) return interaction.reply("❌ 다른 유저를 지정해주세요!");
    if (target.bot) return interaction.reply("❌ 봇과는 결투할 수 없습니다!");
    
    const targetPlayer = getPlayer(target.id, target.username);
    if (!targetPlayer) return interaction.reply("❌ 대상 플레이어 데이터가 없습니다!");
    
    if (getPvpSessionByUser(userId) || getPvpSessionByUser(target.id)) {
      return interaction.reply("❌ 둘 중 한 명이 이미 PvP 중입니다!");
    }
    
    pvpChallenges[userId] = { target: target.id, timestamp: Date.now() };
    
    const embed = new EmbedBuilder()
      .setTitle("⚔️ PvP 결투 도전!")
      .setColor(0xF5C842)
      .setDescription(`${user.username}님이 ${target.username}님에게 결투를 신청합니다!`)
      .addFields(
        { name: `${CHARACTERS[player.active].emoji} ${player.name}`, value: `레벨 ${getLevel(player.xp)} · ${CHARACTERS[player.active].grade}`, inline: true },
        { name: `${CHARACTERS[targetPlayer.active].emoji} ${targetPlayer.name}`, value: `레벨 ${getLevel(targetPlayer.xp)} · ${CHARACTERS[targetPlayer.active].grade}`, inline: true }
      );
    
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`pvp_challenge_accept_${userId}`).setLabel("✅ 수락").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`pvp_challenge_decline_${userId}`).setLabel("❌ 거절").setStyle(ButtonStyle.Danger)
    );
    
    await interaction.reply({ content: `<@${target.id}>`, embeds: [embed], components: [row] });
    return;
  }

  // ── 파티 생성 ──
  if (commandName === "파티생성" || commandName === "partycreate") {
    if (getPartyId(userId)) return interaction.reply("👥 이미 파티에 소속되어 있습니다!");
    
    const partyId = `${_partyIdSeq++}`;
    parties[partyId] = {
      id: partyId, leader: userId, members: [userId],
      createdAt: Date.now(),
    };
    
    await interaction.reply(`✅ 파티가 생성되었습니다! (파티 ID: \`${partyId}\`)\n\`!파티초대 @유저\` 로 초대하세요.`);
    return;
  }

  // ── 파티 초대 ──
  if (commandName === "파티초대" || commandName === "partyinvite") {
    const target = interaction.options.getUser("대상");
    if (!target || target.id === userId) return interaction.reply("❌ 다른 유저를 지정해주세요!");
    if (target.bot) return interaction.reply("❌ 봇은 초대할 수 없습니다!");
    
    const party = getParty(userId);
    if (!party) return interaction.reply("👥 파티에 소속되어 있지 않습니다!");
    if (party.leader !== userId) return interaction.reply("👑 파티장만 초대할 수 있습니다!");
    if (party.members.length >= 4) return interaction.reply("❌ 파티가 가득 찼습니다! (최대 4명)");
    if (getPartyId(target.id)) return interaction.reply("❌ 대상이 이미 다른 파티에 소속되어 있습니다!");
    
    partyInvites[target.id] = { partyId: party.id, inviter: userId, timestamp: Date.now() };
    
    const embed = new EmbedBuilder()
      .setTitle("👥 파티 초대")
      .setColor(0x4ade80)
      .setDescription(`${user.username}님이 당신을 파티에 초대했습니다! (${party.members.length}/4)`)
      .setFooter({ text: "초대는 2분 후 만료됩니다." });
    
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`party_invite_accept_${party.id}_${target.id}`).setLabel("✅ 수락").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`party_invite_decline_${party.id}_${target.id}`).setLabel("❌ 거절").setStyle(ButtonStyle.Danger)
    );
    
    await interaction.reply({ content: `<@${target.id}>`, embeds: [embed], components: [row] });
    return;
  }

  // ── 파티 나가기 ──
  if (commandName === "파티나가기" || commandName === "partyleave") {
    const party = getParty(userId);
    if (!party) return interaction.reply("👥 파티에 소속되어 있지 않습니다!");
    
    const index = party.members.indexOf(userId);
    if (index !== -1) party.members.splice(index, 1);
    
    if (party.members.length === 0) {
      delete parties[party.id];
      if (cullings[party.id]) delete cullings[party.id];
      await interaction.reply("✅ 파티를 떠났습니다. (파티가 해체되었습니다)");
    } else {
      if (party.leader === userId) party.leader = party.members[0];
      await interaction.reply(`✅ 파티를 떠났습니다. (남은 인원: ${party.members.length})`);
    }
    return;
  }

  // ── 파티 컬링 ──
  if (commandName === "파티컬링" || commandName === "partyculling") {
    const party = getParty(userId);
    if (!party) return interaction.reply("👥 파티에 소속되어 있지 않습니다!");
    if (party.leader !== userId) return interaction.reply("👑 파티장만 컬링을 시작할 수 있습니다!");
    
    if (cullings[party.id]) return interaction.reply("🌊 이미 파티 컬링 중입니다!");
    
    const aliveMembers = party.members.filter(uid => players[uid] && players[uid].hp > 0);
    if (aliveMembers.length === 0) return interaction.reply("💀 모든 파티원이 사망했습니다! 회복 후 다시 시도하세요.");
    
    const firstEnemy = pickCullingEnemy(1);
    firstEnemy.currentHp = firstEnemy.hp;
    cullings[party.id] = {
      partyId: party.id, wave: 1, kills: 0, totalXp: 0, totalCrystals: 0,
      currentEnemy: firstEnemy, enemyHp: firstEnemy.hp,
      log: [], turn: "player", selectedSkill: null,
      waitingForAction: party.members[0], actionTaken: false,
    };
    
    const embed = partyCullingEmbed(party, cullings[party.id]);
    await interaction.reply({ embeds: [embed], components: [mkCullingButtons(players[party.members[0]])] });
    return;
  }

  // ── 코드 사용 ──
  if (commandName === "코드" || commandName === "code") {
    const code = interaction.options.getString("코드").toLowerCase();
    if (player.usedCodes.includes(code)) return interaction.reply("❌ 이미 사용한 코드입니다!");
    
    const reward = CODES[code];
    if (!reward) return interaction.reply("❌ 유효하지 않은 코드입니다!");
    
    player.crystals += reward.crystals;
    player.usedCodes.push(code);
    savePlayer(userId);
    await interaction.reply(`✅ 코드 사용! **${reward.crystals}** 크리스탈 획득!`);
    return;
  }

  // ── 도움말 ──
  if (commandName === "도움말" || commandName === "help") {
    const embed = new EmbedBuilder()
      .setTitle("🔱 주술회전 RPG 봇 명령어")
      .setColor(0xF5C842)
      .setDescription([
        "**⚔️ 전투**",
        "`!전투` - 일반 전투 시작",
        "`!컬링` - 웨이브 컬링 게임",
        "`!사멸회유` - 포인트 수집 모드",
        "`!결투 @유저` - PvP 결투",
        "",
        "**👥 파티**",
        "`!파티생성` - 파티 만들기",
        "`!파티초대 @유저` - 파티 초대",
        "`!파티나가기` - 파티 탈퇴",
        "`!파티컬링` - 파티 컬링",
        "",
        "**🎲 시스템**",
        "`!프로필` - 내 정보",
        "`!가챠 [1/10]` - 캐릭터 뽑기",
        "`!코가네가챠` - 펫 뽑기 (200💎)",
        "`!활성 [캐릭터]` - 주력 변경",
        "`!술식` - 스킬 트리 보기",
        "`!출석` - 매일 보상",
        "`!회복` - 회복약 사용",
        "`!손가락` - 스쿠나 손가락 현황",
        "`!코드 [코드]` - 쿠폰 사용",
        "",
        "**👑 개발자 전용**",
        "`!쿨다운초기화` - 쿨다운 리셋",
        "`!아이템지급 [아이템] [수량]` - 아이템 지급"
      ].join("\n"))
      .setFooter({ text: "모든 명령어는 ! 또는 / 로 사용 가능합니다" });
    await interaction.reply({ embeds: [embed] });
    return;
  }

  await interaction.reply({ content: "❌ 알 수 없는 명령어입니다. `!도움말`을 확인하세요.", ephemeral: true });
}

client.login(TOKEN);

// 전투 핸들러 함수들 (원본과 동일 - 생략)
// handleBattleAction, handleCullingAction, handleJujutsuAction,
// handlePartyCullingAction, handlePvpAction 함수들...
