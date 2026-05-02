S
복사

require("dotenv").config();
const fs = require("fs");
const path = require("path");
 
// ───────── EXPRESS (Railway 헬스체크용) ─────────
const express = require("express");
const app = express();
app.get("/", (_, res) => res.send("OK"));
app.listen(process.env.PORT || 3000);
 
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} = require("discord.js");
 
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});
 
const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) { console.error("DISCORD_TOKEN 없음!"); process.exit(1); }
 
// ═══════════════════════════════════════════════
// ── 자동 저장 시스템 ──
// ═══════════════════════════════════════════════
const SAVE_FILE = path.join(__dirname, "players.json");
let isDirty = false;
 
function loadPlayers() {
  try {
    if (fs.existsSync(SAVE_FILE)) {
      const raw = fs.readFileSync(SAVE_FILE, "utf8");
      const parsed = JSON.parse(raw);
      console.log(`✅ 플레이어 데이터 로드: ${Object.keys(parsed).length}명`);
      return parsed;
    }
  } catch (e) {
    console.error("플레이어 데이터 로드 실패:", e);
    try {
      if (fs.existsSync(SAVE_FILE + ".bak")) {
        const raw = fs.readFileSync(SAVE_FILE + ".bak", "utf8");
        console.log("⚠️ 백업 파일로 복구 중...");
        return JSON.parse(raw);
      }
    } catch (e2) { console.error("백업 복구 실패:", e2); }
  }
  return {};
}
 
function savePlayers() {
  if (!isDirty) return;
  try {
    if (fs.existsSync(SAVE_FILE)) {
      fs.copyFileSync(SAVE_FILE, SAVE_FILE + ".bak");
    }
    const tmp = SAVE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(players, null, 2), "utf8");
    fs.renameSync(tmp, SAVE_FILE);
    isDirty = false;
    console.log(`💾 저장 완료 (${Object.keys(players).length}명)`);
  } catch (e) {
    console.error("저장 실패:", e);
  }
}
 
function markDirty() { isDirty = true; }
 
setInterval(savePlayers, 30_000);
 
function exitSave() { isDirty = true; savePlayers(); }
process.on("SIGINT",  () => { exitSave(); process.exit(0); });
process.on("SIGTERM", () => { exitSave(); process.exit(0); });
process.on("exit",    exitSave);
process.on("uncaughtException", (e) => { console.error("uncaughtException:", e); exitSave(); });
 
// ═══════════════════════════════════════════════
// ── 개발자 ID ──
// ═══════════════════════════════════════════════
const DEV_IDS = new Set(["1284771557633425470", "1397218266505678881"]);
const isDev = (id) => DEV_IDS.has(id);
 
// ═══════════════════════════════════════════════
// ── 주술회전 등급 ──
// ═══════════════════════════════════════════════
const JJK_GRADE_COLOR = {
  "특급": 0xF5C842, "준특급": 0xff8c00,
  "1급":  0x7C5CFC, "준1급":  0x9b72cf,
  "2급":  0x4ade80, "3급":    0x94a3b8, "4급": 0x64748b,
};
const JJK_GRADE_EMOJI = {
  "특급": "🔱", "준특급": "💠",
  "1급":  "⭐⭐", "준1급": "⭐",
  "2급":  "🔹🔹", "3급": "🔹", "4급": "◽",
};
 
// ═══════════════════════════════════════════════
// ── 캐릭터 데이터 ──
// ═══════════════════════════════════════════════
const CHARACTERS = {
  itadori: {
    name: "이타도리 유지", emoji: "🟠", grade: "준1급",
    atk: 70, def: 60, spd: 75, maxHp: 900, domain: null,
    desc: "특급주술사 후보생. 아직 성장 중인 주술사.",
    skills: [
      { name: "주먹질", minMastery: 0,  dmg: 70,  desc: "강력한 기본 주먹 공격." },
      { name: "다이버전트 주먹",   minMastery: 5,  dmg: 120, desc: "저주 에너지를 실은 주먹." },
      { name: "흑섬", minMastery: 15, dmg: 180, desc: "최대 저주 에너지 방출!" },
      { name: "해",   minMastery: 30, dmg: 260, desc: "스쿠나의 힘을 빌린 궁극기." },
    ],
  },
  gojo: {
    name: "고조 사토루", emoji: "🔵", grade: "특급",
    atk: 100, def: 95, spd: 100, maxHp: 1500, domain: "무량공처",
    desc: "최강의 주술사. 무량공처를 구사한다.",
    skills: [
      { name: "아오",     minMastery: 0,  dmg: 110, desc: "적들을 끌어당겨서 공격한다." },
      { name: "아카",     minMastery: 5,  dmg: 170, desc: "적들을 날려서 폭발시킨다." },
      { name: "무라사키", minMastery: 15, dmg: 250, desc: "아오와 아카를 합쳐서 발사." },
      { name: "무량공처", minMastery: 30, dmg: 360, desc: "무한을 지배하는 궁극술식." },
    ],
  },
  megumi: {
    name: "후시구로 메구미", emoji: "⚫", grade: "1급",
    atk: 85, def: 88, spd: 82, maxHp: 1000, domain: "강압암예정",
    desc: "식신술을 구사하는 주술사.",
    skills: [
      { name: "옥견",       minMastery: 0,  dmg: 85,  desc: "식신 옥견을 소환한다." },
      { name: "대호",       minMastery: 5,  dmg: 140, desc: "식신 대호를 소환한다." },
      { name: "십종영이",   minMastery: 15, dmg: 200, desc: "열 가지 식신을 소환한다." },
      { name: "마허라가라", minMastery: 30, dmg: 290, desc: "최강의 식신, 마허라가라 강림." },
    ],
  },
  nobara: {
    name: "쿠기사키 노바라", emoji: "🌸", grade: "1급",
    atk: 88, def: 75, spd: 85, maxHp: 950, domain: null,
    desc: "반전술식을 구사하는 주술사.",
    skills: [
      { name: "망치질", minMastery: 0,  dmg: 88,  desc: "저주 못을 박는다." },
      { name: "공명",   minMastery: 5,  dmg: 150, desc: "허수아비를 통해 공명 피해." },
      { name: "철정",   minMastery: 15, dmg: 210, desc: "저주 에너지 주입 못을 박는다." },
      { name: "발화",   minMastery: 30, dmg: 290, desc: "모든 못에 동시 폭발 공명." },
    ],
  },
  nanami: {
    name: "나나미 켄토", emoji: "🟡", grade: "1급",
    atk: 90, def: 85, spd: 75, maxHp: 1100, domain: null,
    desc: "1급 주술사. 합리적 판단의 소유자.",
    skills: [
      { name: "둔기 공격", minMastery: 0,  dmg: 90,  desc: "단단한 둔기로 타격한다." },
      { name: "칠할삼분",  minMastery: 5,  dmg: 155, desc: "7:3 지점을 노린 약점 공격." },
      { name: "십수할",    minMastery: 15, dmg: 220, desc: "열 배의 저주 에너지 방출." },
      { name: "초과근무",  minMastery: 30, dmg: 310, desc: "한계를 넘어선 폭발적 강화." },
    ],
  },
  sukuna: {
    name: "료멘 스쿠나", emoji: "🔴", grade: "특급",
    atk: 100, def: 90, spd: 95, maxHp: 2000, domain: "복마어주자",
    desc: "저주의 왕. 역대 최강의 저주된 영혼.",
    skills: [
      { name: "손톱 공격",       minMastery: 0,  dmg: 110, desc: "날카로운 손톱으로 베어낸다." },
      { name: "해체",            minMastery: 5,  dmg: 180, desc: "공간 자체를 베어낸다." },
      { name: "분해",            minMastery: 15, dmg: 260, desc: "닿는 모든 것을 분해한다." },
      { name: "개·염·천·지·개", minMastery: 30, dmg: 380, desc: "천지개벽의 궁극 영역전개." },
    ],
  },
  geto: {
    name: "게토 스구루", emoji: "🟢", grade: "특급",
    atk: 88, def: 82, spd: 80, maxHp: 1300, domain: null,
    desc: "전 특급 주술사. 저주를 다루는 달인.",
    skills: [
      { name: "저주 방출",  minMastery: 0,  dmg: 95,  desc: "저급 저주령을 방출한다." },
      { name: "최대출력",   minMastery: 5,  dmg: 160, desc: "저주령을 전력으로 방출." },
      { name: "저주영조종", minMastery: 15, dmg: 230, desc: "수천의 저주령을 조종한다." },
      { name: "감로대법",   minMastery: 30, dmg: 320, desc: "감로대법으로 모든 저주 흡수." },
    ],
  },
  // ★ 마키: 천여주박 각성 시스템 추가
  maki: {
    name: "마키 젠인", emoji: "⚪", grade: "준1급",
    atk: 92, def: 88, spd: 92, maxHp: 1050, domain: null,
    desc: "저주력이 없어도 강한 주술사. HP 30% 이하 시 천여주박 각성!",
    // 각성 임계치: maxHp의 30%
    awakening: { threshold: 0.30, dmgMult: 2.0, label: "천여주박 각성" },
    skills: [
      { name: "봉술",       minMastery: 0,  dmg: 92,  desc: "저주 도구 봉으로 타격." },
      { name: "저주창",     minMastery: 5,  dmg: 155, desc: "저주 도구 창을 투척한다." },
      { name: "저주도구술", minMastery: 15, dmg: 215, desc: "다양한 저주 도구를 구사." },
      { name: "천개봉파",   minMastery: 30, dmg: 300, desc: "수천의 저주 도구 연속 공격." },
    ],
  },
  panda: {
    name: "판다", emoji: "🐼", grade: "2급",
    atk: 80, def: 90, spd: 70, maxHp: 1100, domain: null,
    desc: "저주로 만든 특이체질의 주술사.",
    skills: [
      { name: "박치기",      minMastery: 0,  dmg: 80,  desc: "머리로 힘차게 들이받는다." },
      { name: "곰 발바닥",   minMastery: 5,  dmg: 135, desc: "두꺼운 발바닥으로 내리친다." },
      { name: "팬더 변신",   minMastery: 15, dmg: 195, desc: "진짜 팬더로 변신해 공격." },
      { name: "고릴라 변신", minMastery: 30, dmg: 270, desc: "고릴라 형태로 폭발적 강화." },
    ],
  },
  inumaki: {
    name: "이누마키 토게", emoji: "🟤", grade: "준1급",
    atk: 85, def: 70, spd: 88, maxHp: 900, domain: null,
    desc: "주술언어를 구사하는 준1급 주술사.",
    skills: [
      { name: "멈춰라",   minMastery: 0,  dmg: 85,  desc: "상대의 움직임을 봉쇄한다." },
      { name: "달려라",   minMastery: 5,  dmg: 140, desc: "상대를 무작위로 달리게 한다." },
      { name: "주술언어", minMastery: 15, dmg: 200, desc: "강력한 주술 명령을 내린다." },
      { name: "폭발해라", minMastery: 30, dmg: 285, desc: "상대를 그 자리에서 폭발시킨다." },
    ],
  },
  yuta: {
    name: "오코츠 유타", emoji: "🌟", grade: "특급",
    atk: 98, def: 88, spd: 92, maxHp: 1400, domain: "진안상애",
    desc: "특급 주술사. 리카의 저주를 다루는 최강급 주술사.",
    skills: [
      { name: "모방술식",  minMastery: 0,  dmg: 105, desc: "다른 술식을 모방해 공격한다." },
      { name: "리카 소환", minMastery: 5,  dmg: 170, desc: "저주의 여왕 리카를 소환한다." },
      { name: "순애빔",    minMastery: 15, dmg: 260, desc: "리카와의 순수한 사랑을 에너지로 발사." },
      { name: "진안상애",  minMastery: 30, dmg: 360, desc: "영역전개로 모든 것을 사랑으로 파괴." },
    ],
  },
  higuruma: {
    name: "히구루마 히로미", emoji: "⚖️", grade: "1급",
    atk: 90, def: 82, spd: 78, maxHp: 1050, domain: "주복사사",
    desc: "전직 변호사 출신 주술사. 심판의 영역전개를 구사한다.",
    skills: [
      { name: "저주도구",    minMastery: 0,  dmg: 90,  desc: "저주 에너지를 담은 도구로 공격." },
      { name: "몰수",        minMastery: 5,  dmg: 150, desc: "상대의 술식을 몰수한다." },
      { name: "사형판결",    minMastery: 15, dmg: 220, desc: "재판 결과에 따른 강력한 제재." },
      { name: "집행인 인형", minMastery: 30, dmg: 310, desc: "집행인 인형을 소환해 즉시 처형." },
    ],
  },
};
 
// ── 마키 각성 여부 체크 헬퍼 ──
function isMakiAwakened(player) {
  if (player.active !== "maki") return false;
  const ch = CHARACTERS["maki"];
  return player.hp <= Math.floor(ch.maxHp * ch.awakening.threshold);
}
 
// ── 데미지 계산 (마키 각성 배율 적용) ──
function calcDmgForPlayer(player, enemyDef, baseMult = 1) {
  const ch = CHARACTERS[player.active];
  let mult = baseMult;
  if (isMakiAwakened(player)) mult *= CHARACTERS["maki"].awakening.dmgMult;
  return calcDmg(ch.atk, enemyDef, mult);
}
 
// ── 스킬 데미지 계산 (마키 각성 배율 적용) ──
function calcSkillDmgForPlayer(player, baseSkillDmg) {
  let dmg = baseSkillDmg + Math.floor(Math.random() * 40);
  if (isMakiAwakened(player)) dmg = Math.floor(dmg * CHARACTERS["maki"].awakening.dmgMult);
  return dmg;
}
 
// ═══════════════════════════════════════════════
// ── 적 데이터 ──
// ═══════════════════════════════════════════════
const ENEMIES = [
  { id: "e1", name: "저급 저주령",      emoji: "👹", hp: 400,  atk: 28,  def: 10, xp: 60,  crystals: 15,  masteryXp: 1 },
  { id: "e2", name: "1급 저주령",       emoji: "👺", hp: 800,  atk: 60,  def: 30, xp: 150, crystals: 30,  masteryXp: 3 },
  { id: "e3", name: "특급 저주령",      emoji: "💀", hp: 1800, atk: 95,  def: 55, xp: 350, crystals: 70,  masteryXp: 7 },
  { id: "e4", name: "저주의 왕 (보스)", emoji: "👑", hp: 4000, atk: 140, def: 80, xp: 800, crystals: 150, masteryXp: 15 },
];
 
// ═══════════════════════════════════════════════
// ── 컬링 게임 (무한 WAVE) ──
// ═══════════════════════════════════════════════
function getCullingPool(wave) {
  if (wave <= 3)  return ["e1","e1","e1","e2"];
  if (wave <= 7)  return ["e1","e2","e2","e2","e3"];
  if (wave <= 14) return ["e2","e2","e3","e3","e3"];
  return ["e2","e3","e3","e4","e4"];
}
 
function pickCullingEnemy(wave) {
  const pool = getCullingPool(wave);
  const id = pool[Math.floor(Math.random() * pool.length)];
  const base = ENEMIES.find(e => e.id === id);
  const scale = 1 + (wave - 1) * 0.05;
  return {
    ...base,
    hp:       Math.floor(base.hp * scale),
    atk:      Math.floor(base.atk * scale),
    def:      Math.floor(base.def * scale),
    xp:       Math.floor(base.xp * scale),
    crystals: Math.floor(base.crystals * scale),
  };
}
 
// ═══════════════════════════════════════════════
// ── 가챠 풀 (확률 하향 — 고급 캐릭터 위주) ──
// ═══════════════════════════════════════════════
const GACHA_POOL = [
  // 특급 (기존 대비 절반 이하)
  { id: "gojo",     rate: 0.3  },  // 0.7 → 0.3
  { id: "sukuna",   rate: 0.35 },  // 0.8 → 0.35
  { id: "yuta",     rate: 0.45 },  // 1.0 → 0.45
  // 준특급
  { id: "geto",     rate: 0.9  },  // 1.5 → 0.9
  // 준1급/1급
  { id: "itadori",  rate: 2.0  },  // 3.0 → 2.0
  { id: "megumi",   rate: 5.0  },  // 7   → 5.0
  { id: "nanami",   rate: 5.0  },  // 7   → 5.0
  { id: "maki",     rate: 5.5  },  // 8   → 5.5
  { id: "nobara",   rate: 5.5  },  // 8   → 5.5
  { id: "higuruma", rate: 5.5  },  // 8   → 5.5
  // 2급 이하 (풀러로 조정)
  { id: "panda",    rate: 35   },  // 27  → 35
  { id: "inumaki",  rate: 35   },  // 28  → 35
];
 
const REVERSE_CHARS = new Set(["gojo", "sukuna", "yuta"]);
const CODES = { "release": { crystals: 200 } };
 
// ═══════════════════════════════════════════════
// ── 세션 저장소 ──
// ═══════════════════════════════════════════════
const players = loadPlayers();
const battles = {};
const cullings = {};
const parties = {};
const partyInvites = {};
let _partyIdSeq = 1;
 
// ═══════════════════════════════════════════════
// ── 플레이어 유틸 ──
// ═══════════════════════════════════════════════
function getPlayer(userId, username = "플레이어") {
  if (!players[userId]) {
    players[userId] = {
      id: userId, name: username, crystals: 500, xp: 0,
      owned: ["itadori"], active: "itadori",
      hp: CHARACTERS["itadori"].maxHp, potion: 3,
      wins: 0, losses: 0,
      mastery: { itadori: 0 },
      reverseOutput: 1.0,
      cullingBest: 0,
      usedCodes: [],
    };
    markDirty();
  }
  const p = players[userId];
  let changed = false;
  if (p.reverseOutput  === undefined) { p.reverseOutput  = 1.0; changed = true; }
  if (!p.mastery)                     { p.mastery        = {}; changed = true; }
  if (p.cullingBest    === undefined) { p.cullingBest    = 0;   changed = true; }
  if (!p.usedCodes)                   { p.usedCodes      = [];  changed = true; }
  if (changed) markDirty();
  return p;
}
 
function getMastery(player, charId)   { return player.mastery?.[charId] || 0; }
 
function getCurrentSkill(player, charId) {
  const m = getMastery(player, charId);
  let cur = CHARACTERS[charId].skills[0];
  for (const s of CHARACTERS[charId].skills) { if (m >= s.minMastery) cur = s; }
  return cur;
}
 
function getNextSkill(player, charId) {
  const m = getMastery(player, charId);
  return CHARACTERS[charId].skills.find(s => s.minMastery > m) || null;
}
 
function masteryBar(mastery, charId) {
  const tiers = CHARACTERS[charId].skills.map(s => s.minMastery);
  const max   = tiers[tiers.length - 1];
  if (mastery >= max) return "`[MAX]` 모든 스킬 해금!";
  const next  = tiers.find(t => t > mastery) || max;
  const prev  = [...tiers].reverse().find(t => t <= mastery) || 0;
  const fill  = Math.round(((mastery - prev) / (next - prev)) * 10);
  return "`" + "█".repeat(Math.max(0,fill)) + "░".repeat(Math.max(0,10-fill)) + "`" + ` ${mastery}/${next}`;
}
 
function getLevel(xp) { return Math.floor(xp / 200) + 1; }
 
function hpBar(cur, max, len = 12) {
  const fill = Math.round((Math.max(0,cur) / max) * len);
  return "`" + "█".repeat(Math.max(0,fill)) + "░".repeat(Math.max(0,len-fill)) + "`";
}
 
function calcDmg(atk, def, mult = 1) {
  return Math.max(1, Math.floor((atk * (0.8 + Math.random() * 0.4) - def * 0.25) * mult));
}
 
function rollGacha(count = 1) {
  const total = GACHA_POOL.reduce((s,p) => s + p.rate, 0);
  return Array.from({ length: count }, () => {
    let roll = Math.random() * total;
    for (const e of GACHA_POOL) { roll -= e.rate; if (roll <= 0) return e.id; }
    return GACHA_POOL[GACHA_POOL.length - 1].id;
  });
}
 
// ── 파티 유틸 ──
function getPartyId(userId) {
  return Object.keys(parties).find(pid => parties[pid].members.includes(userId)) || null;
}
function getParty(userId) {
  const pid = getPartyId(userId);
  return pid ? parties[pid] : null;
}
 
// ═══════════════════════════════════════════════
// ── 임베드 / 버튼 헬퍼 ──
// ═══════════════════════════════════════════════
function profileEmbed(player) {
  const ch      = CHARACTERS[player.active];
  const skill   = getCurrentSkill(player, player.active);
  const next    = getNextSkill(player, player.active);
  const mastery = getMastery(player, player.active);
  const awakened = isMakiAwakened(player);
  return new EmbedBuilder()
    .setTitle(`${ch.emoji} ${player.name}의 주술사 프로필${awakened ? " 🔥[천여주박 각성!]" : ""}`)
    .setColor(awakened ? 0xFF0000 : JJK_GRADE_COLOR[ch.grade])
    .addFields(
      { name: "📊 레벨/XP",       value: `LV.**${getLevel(player.xp)}** | ${player.xp} XP`, inline: true },
      { name: "💎 크리스탈",       value: `${player.crystals}`, inline: true },
      { name: "🏆 전적",           value: `${player.wins}승 ${player.losses}패`, inline: true },
      { name: `${ch.emoji} 활성 캐릭터 [${JJK_GRADE_EMOJI[ch.grade]} ${ch.grade}]`, value: ch.desc, inline: false },
      { name: "⚔️ 스탯",          value: `공격 **${ch.atk}** | 방어 **${ch.def}** | HP **${Math.max(0,player.hp)}/${ch.maxHp}**`, inline: false },
      { name: "🔥 현재 스킬",      value: `**${skill.name}** — ${skill.desc} (피해 ${skill.dmg}${awakened ? " × **2배**🔥" : ""})`, inline: false },
      { name: "📈 숙련도",         value: masteryBar(mastery, player.active), inline: true },
      { name: "⬆️ 다음 스킬",     value: next ? `**${next.name}** (숙련도 ${next.minMastery} 필요)` : "**MAX 달성!**", inline: true },
      { name: "🌌 영역전개",       value: ch.domain || "없음", inline: true },
      { name: "❤️ HP 바",         value: `${hpBar(player.hp, ch.maxHp)} ${Math.max(0,player.hp)}/${ch.maxHp}`, inline: true },
      { name: "🧪 회복약",         value: `${player.potion}개`, inline: true },
      { name: "🌊 컬링 최고 WAVE", value: `WAVE **${player.cullingBest}**`, inline: true },
      { name: "📦 보유 캐릭터",    value: player.owned.map(id => `${CHARACTERS[id].emoji} ${CHARACTERS[id].name} [${CHARACTERS[id].grade}] (숙련 ${getMastery(player,id)})`).join("\n"), inline: false },
    )
    .setFooter({ text: "!캐릭터 | !스킬 | !가챠 | !전투 | !컬링 | !파티" });
}
 
function skillEmbed(player) {
  const id      = player.active;
  const ch      = CHARACTERS[id];
  const mastery = getMastery(player, id);
  const awakened = isMakiAwakened(player);
  return new EmbedBuilder()
    .setTitle(`${ch.emoji} ${ch.name}의 스킬 트리${awakened ? " 🔥[천여주박 각성!]" : ""}`)
    .setColor(awakened ? 0xFF0000 : JJK_GRADE_COLOR[ch.grade])
    .setDescription(`숙련도: **${mastery}** | 현재 스킬: **${getCurrentSkill(player,id).name}** | 영역: **${ch.domain||"없음"}**${awakened ? "\n🔥 **천여주박 각성 중** — 모든 데미지 **2배!**" : ""}`)
    .addFields(ch.skills.map(s => ({
      name:  `${mastery >= s.minMastery ? "✅" : "🔒"} ${s.name} — 피해 ${s.dmg}${awakened ? `(→ **${s.dmg * 2}** 각성)` : ""} (숙련도 ${s.minMastery} 필요)`,
      value: s.desc, inline: false,
    })))
    .setFooter({ text: "전투/컬링 승리 시 숙련도 상승!" });
}
 
// 컬링 임베드
function cullingEmbed(player, session, log = []) {
  const ch    = CHARACTERS[player.active];
  const enemy = session.currentEnemy;
  const awakened = isMakiAwakened(player);
  return new EmbedBuilder()
    .setTitle(`⚔️ 컬링 게임 — 🌊 WAVE ${session.wave}${awakened ? " 🔥[각성!]" : ""}`)
    .setColor(awakened ? 0xFF0000 : session.wave >= 15 ? 0xF5C842 : session.wave >= 8 ? 0xe63946 : 0x7C5CFC)
    .setDescription(log.join("\n") || "⚔️ 새 파도가 밀려온다!")
    .addFields(
      { name: `${ch.emoji} 내 HP`,           value: `${hpBar(player.hp, ch.maxHp)} ${Math.max(0,player.hp)}/${ch.maxHp}${awakened ? " 🔥각성" : ""}`, inline: true },
      { name: `${enemy.emoji} ${enemy.name}`, value: `${hpBar(session.enemyHp, enemy.hp)} ${Math.max(0,session.enemyHp)}/${enemy.hp}`, inline: true },
      { name: "📊 현황",                      value: `WAVE **${session.wave}** | 처치 **${session.kills}** | **${session.totalXp}**XP / **${session.totalCrystals}**💎`, inline: false },
    )
    .setFooter({ text: `술식: ${getCurrentSkill(player,player.active).name} | 최고기록: WAVE ${player.cullingBest}` });
}
 
// 파티 컬링 임베드
function partyCullingEmbed(party, session, log = []) {
  const enemy   = session.currentEnemy;
  const members = party.members.map(uid => {
    const p  = players[uid];
    if (!p) return "❓ 알 수 없음";
    const ch = CHARACTERS[p.active];
    const awakened = isMakiAwakened(p);
    return `${ch.emoji} **${p.name}** ${hpBar(p.hp, ch.maxHp)} ${Math.max(0,p.hp)}/${ch.maxHp}${awakened ? " 🔥각성" : ""}`;
  }).join("\n");
  return new EmbedBuilder()
    .setTitle(`⚔️ [파티] 컬링 게임 — 🌊 WAVE ${session.wave}`)
    .setColor(session.wave >= 15 ? 0xF5C842 : session.wave >= 8 ? 0xe63946 : 0x7C5CFC)
    .setDescription(log.join("\n") || "⚔️ 파티 컬링 게임 진행 중!")
    .addFields(
      { name: "👥 파티 HP",                   value: members, inline: false },
      { name: `${enemy.emoji} ${enemy.name}`, value: `${hpBar(session.enemyHp, enemy.hp)} ${Math.max(0,session.enemyHp)}/${enemy.hp} (ATK ${enemy.atk})`, inline: false },
      { name: "📊 현황",                       value: `WAVE **${session.wave}** | 처치 **${session.kills}** | **${session.totalXp}**XP / **${session.totalCrystals}**💎`, inline: false },
    )
    .setFooter({ text: "파티원 누구나 버튼을 눌러 행동할 수 있습니다!" });
}
 
// 버튼 모음
const mkBattleButtons  = () => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId("b_attack") .setLabel("⚔ 공격")  .setStyle(ButtonStyle.Danger),
  new ButtonBuilder().setCustomId("b_skill")  .setLabel("🌀 술식")  .setStyle(ButtonStyle.Primary),
  new ButtonBuilder().setCustomId("b_domain") .setLabel("🌌 영역전개").setStyle(ButtonStyle.Success),
  new ButtonBuilder().setCustomId("b_reverse").setLabel("♻ 반전술식").setStyle(ButtonStyle.Secondary),
  new ButtonBuilder().setCustomId("b_run")    .setLabel("🏃 도주")  .setStyle(ButtonStyle.Secondary),
);
const mkCullingButtons  = () => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId("c_attack") .setLabel("⚔ 공격")   .setStyle(ButtonStyle.Danger),
  new ButtonBuilder().setCustomId("c_skill")  .setLabel("🌀 술식")   .setStyle(ButtonStyle.Primary),
  new ButtonBuilder().setCustomId("c_domain") .setLabel("🌌 영역전개").setStyle(ButtonStyle.Success),
  new ButtonBuilder().setCustomId("c_reverse").setLabel("♻ 반전술식").setStyle(ButtonStyle.Secondary),
  new ButtonBuilder().setCustomId("c_escape") .setLabel("🏳 철수")   .setStyle(ButtonStyle.Secondary),
);
const mkPartyCullingButtons = () => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId("pc_attack") .setLabel("⚔ 공격")   .setStyle(ButtonStyle.Danger),
  new ButtonBuilder().setCustomId("pc_skill")  .setLabel("🌀 술식")   .setStyle(ButtonStyle.Primary),
  new ButtonBuilder().setCustomId("pc_domain") .setLabel("🌌 영역전개").setStyle(ButtonStyle.Success),
  new ButtonBuilder().setCustomId("pc_reverse").setLabel("♻ 반전술식").setStyle(ButtonStyle.Secondary),
  new ButtonBuilder().setCustomId("pc_escape") .setLabel("🏳 철수(리더)").setStyle(ButtonStyle.Secondary),
);
 
// ═══════════════════════════════════════════════
// ── DEV 버튼 (대상 지정 가능) ──
// ═══════════════════════════════════════════════
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
 
// ═══════════════════════════════════════════════
// ── 메시지 핸들러 ──
// ═══════════════════════════════════════════════
client.on("messageCreate", async (msg) => {
  if (!msg || msg.author.bot) return;
  const content = msg.content.trim();
  const player  = getPlayer(msg.author.id, msg.author.username);
 
  // !도움
  if (content === "!도움" || content === "!help") {
    return msg.reply({ embeds: [new EmbedBuilder()
      .setTitle("⚡ 주술회전 RPG봇 — 명령어")
      .setColor(0x7c5cfc)
      .addFields(
        { name: "📋 기본",    value: "`!프로필` `!도움`", inline: false },
        { name: "👤 캐릭터", value: "`!캐릭터` 편성 | `!도감` 전체목록 | `!스킬` 스킬트리", inline: false },
        { name: "🎲 가챠",   value: "`!가챠` 1회(150💎) | `!가챠10` 10회(1350💎)", inline: false },
        { name: "⚔️ 일반 전투", value: "`!전투` — 적 선택 후 버튼 전투", inline: false },
        { name: "🌊 컬링 게임", value: "`!컬링` — 무한 WAVE 생존 모드\n파도마다 랜덤 몹 등장, 강도 상승!\n철수 시 누적 보상 지급 / 사망 시 절반 지급", inline: false },
        { name: "👥 파티",   value: "`!파티` 생성/정보\n`!파티초대 @유저` 초대\n`!파티수락` / `!파티거절`\n`!파티탈퇴`\n`!파티컬링` 파티 컬링 게임(최소 2명)", inline: false },
        { name: "🎁 코드",   value: "`!코드 [코드]` 보상 코드 입력", inline: false },
        { name: "📈 등급",   value: "🔱특급 > 💠준특급 > ⭐⭐1급 > ⭐준1급 > 🔹🔹2급 > 🔹3급 > ◽4급", inline: false },
        { name: "🔥 마키 각성", value: "HP 30% 이하 시 **천여주박 각성** 발동! 모든 데미지 **2배**", inline: false },
      )
      .setFooter({ text: "💎 첫 시작 시 500 크리스탈 지급!" })
    ]});
  }
 
  if (content === "!프로필") return msg.reply({ embeds: [profileEmbed(player)] });
  if (content === "!스킬")   return msg.reply({ embeds: [skillEmbed(player)] });
 
  // !도감
  if (content === "!도감") {
    return msg.reply({ embeds: [new EmbedBuilder()
      .setTitle("📖 주술회전 캐릭터 도감")
      .setColor(0x0d0d1a)
      .setDescription(Object.entries(CHARACTERS).map(([id, ch]) => {
        const owned = player.owned.includes(id);
        const m     = getMastery(player, id);
        const skill = owned ? getCurrentSkill(player, id) : null;
        const awakeNote = ch.awakening ? ` | 🔥각성 있음` : "";
        return `${owned ? ch.emoji : "🔒"} **${ch.name}** [${JJK_GRADE_EMOJI[ch.grade]} ${ch.grade}]${owned ? ` — 숙련 ${m} | ${skill.name}${awakeNote}` : " — 미획득"}`;
      }).join("\n"))
      .setFooter({ text: "!가챠로 새 캐릭터를 획득하세요!" })
    ]});
  }
 
  // !캐릭터
  if (content === "!캐릭터") {
    if (!player.owned.length) return msg.reply("보유 캐릭터 없음! `!가챠`로 소환하세요.");
    const select = new StringSelectMenuBuilder()
      .setCustomId("select_char")
      .setPlaceholder("편성할 캐릭터 선택")
      .addOptions(player.owned.map(id => {
        const ch    = CHARACTERS[id];
        const skill = getCurrentSkill(player, id);
        return { label: ch.name, description: `${ch.grade} | 숙련 ${getMastery(player,id)} | ${skill.name}`, value: id, emoji: ch.emoji, default: player.active === id };
      }));
    return msg.reply({ content: "👤 편성할 캐릭터를 선택하세요:", components: [new ActionRowBuilder().addComponents(select)] });
  }
 
  // !가챠
  if (content === "!가챠") {
    if (player.crystals < 150) return msg.reply(`💎 크리스탈 부족! (${player.crystals}/150)`);
    player.crystals -= 150;
    const [result] = rollGacha(1);
    const ch  = CHARACTERS[result];
    const isNew = !player.owned.includes(result);
    if (isNew) { player.owned.push(result); if (!player.mastery[result]) player.mastery[result] = 0; }
    else player.crystals += 50;
    markDirty();
    return msg.reply({ embeds: [new EmbedBuilder()
      .setTitle("🎲 주술 소환 결과!")
      .setColor(JJK_GRADE_COLOR[ch.grade])
      .setDescription(`${ch.emoji} **${ch.name}** [${JJK_GRADE_EMOJI[ch.grade]} ${ch.grade}]${isNew ? " ✨**NEW!**" : " (중복 +50💎)"}`)
      .addFields(
        { name: "설명", value: ch.desc, inline: false },
        { name: "🌌 영역전개", value: ch.domain || "없음", inline: true },
        { name: "🔥 시작 스킬", value: ch.skills[0].name, inline: true },
        { name: "💎 잔여", value: `${player.crystals}`, inline: true },
      )
    ]});
  }
 
  // !가챠10
  if (content === "!가챠10") {
    if (player.crystals < 1350) return msg.reply(`💎 크리스탈 부족! (${player.crystals}/1350)`);
    player.crystals -= 1350;
    const results = rollGacha(10);
    const newOnes = []; let dupCrystals = 0;
    results.forEach(id => {
      if (!player.owned.includes(id)) { player.owned.push(id); if (!player.mastery[id]) player.mastery[id] = 0; newOnes.push(id); }
      else { dupCrystals += 50; player.crystals += 50; }
    });
    markDirty();
    return msg.reply({ embeds: [new EmbedBuilder()
      .setTitle("🎲 주술 10회 소환 결과!")
      .setColor(0xF5C842)
      .setDescription(results.map(id => `${CHARACTERS[id].emoji} **${CHARACTERS[id].name}** [${CHARACTERS[id].grade}]${newOnes.includes(id) ? " ✨NEW!" : ""}`).join("\n"))
      .addFields(
        { name: "✨ 신규",     value: newOnes.length ? newOnes.map(id => CHARACTERS[id].name).join(", ") : "없음", inline: true },
        { name: "🔄 중복 보상", value: `+${dupCrystals}💎`, inline: true },
        { name: "💎 잔여",    value: `${player.crystals}`, inline: true },
      )
    ]});
  }
 
  // !전투
  if (content === "!전투") {
    if (battles[msg.author.id])  return msg.reply("이미 전투 중! 버튼을 사용하세요.");
    if (cullings[msg.author.id]) return msg.reply("컬링 게임 진행 중입니다! 먼저 철수하세요.");
    const party = getParty(msg.author.id);
    if (party?.cullingSession)   return msg.reply("파티 컬링 게임 진행 중입니다!");
    // ★ HP 0 → 풀회복
    if (player.hp <= 0) { player.hp = CHARACTERS[player.active].maxHp; markDirty(); return msg.reply("HP 0 → **풀회복!** 다시 `!전투` 입력하세요."); }
    return msg.reply({
      content: "⚔️ 상대할 적을 선택하세요:",
      components: [new ActionRowBuilder().addComponents(
        ...ENEMIES.map(e => new ButtonBuilder().setCustomId(`enemy_${e.id}`).setLabel(`${e.emoji} ${e.name}`).setStyle(ButtonStyle.Secondary))
      )],
    });
  }
 
  // !컬링
  if (content === "!컬링") {
    if (battles[msg.author.id])  return msg.reply("일반 전투 중입니다!");
    if (cullings[msg.author.id]) return msg.reply("이미 컬링 게임 진행 중입니다! 버튼을 사용하세요.");
    const party = getParty(msg.author.id);
    if (party?.cullingSession)   return msg.reply("파티 컬링 게임 진행 중입니다!");
    // ★ HP 0 → 풀회복
    if (player.hp <= 0) { player.hp = CHARACTERS[player.active].maxHp; markDirty(); return msg.reply("HP 0 → **풀회복!** 다시 `!컬링` 입력하세요."); }
 
    const firstEnemy = pickCullingEnemy(1);
    cullings[msg.author.id] = { wave: 1, currentEnemy: firstEnemy, enemyHp: firstEnemy.hp, skillUsed: false, domainUsed: false, kills: 0, totalXp: 0, totalCrystals: 0, totalMastery: 0 };
    return msg.reply({
      embeds: [cullingEmbed(player, cullings[msg.author.id], ["🌊 **컬링 게임** 시작! 파도가 밀려온다...", `${firstEnemy.emoji} **WAVE 1** — **${firstEnemy.name}** 등장!`])],
      components: [mkCullingButtons()],
    });
  }
 
  // ── 파티 명령어 ──
  if (content === "!파티") {
    const party = getParty(msg.author.id);
    if (!party) {
      const pid = String(_partyIdSeq++);
      parties[pid] = { id: pid, leader: msg.author.id, members: [msg.author.id], cullingSession: null };
      return msg.reply({ embeds: [new EmbedBuilder()
        .setTitle("👥 파티 생성!")
        .setColor(0x4ade80)
        .setDescription(`파티 **#${pid}** 생성 완료!\n\`!파티초대 @유저\` 로 파티원을 초대하세요.`)
        .addFields({ name: "👑 리더", value: player.name, inline: true })
        .setFooter({ text: "!파티컬링 으로 파티 컬링 게임 시작!" })
      ]});
    }
    const memberLines = party.members.map(uid => {
      const p  = players[uid];
      const ch = p ? CHARACTERS[p.active] : null;
      return p ? `${party.leader === uid ? "👑" : "👤"} **${p.name}** — ${ch.emoji} ${ch.name} [${ch.grade}]` : `❓ ${uid}`;
    }).join("\n");
    return msg.reply({ embeds: [new EmbedBuilder()
      .setTitle(`👥 파티 #${party.id} 정보`)
      .setColor(0x4ade80)
      .addFields(
        { name: "파티원", value: memberLines, inline: false },
        { name: "상태",   value: party.cullingSession ? "🌊 컬링 게임 진행 중" : "대기 중", inline: true },
      )
      .setFooter({ text: "!파티탈퇴 | !파티초대 @유저 | !파티컬링" })
    ]});
  }
 
  if (content.startsWith("!파티초대")) {
    const party = getParty(msg.author.id);
    if (!party)                         return msg.reply("파티가 없습니다! `!파티`로 먼저 파티를 만드세요.");
    if (party.leader !== msg.author.id) return msg.reply("파티 리더만 초대할 수 있습니다!");
    if (party.members.length >= 4)      return msg.reply("파티 최대 인원(4명)에 달했습니다!");
    const mentioned = msg.mentions.users.first();
    if (!mentioned)                     return msg.reply("사용법: `!파티초대 @유저`");
    if (mentioned.id === msg.author.id) return msg.reply("자기 자신을 초대할 수 없습니다!");
    if (party.members.includes(mentioned.id)) return msg.reply("이미 파티에 있는 유저입니다!");
    if (getPartyId(mentioned.id))       return msg.reply("해당 유저는 이미 다른 파티에 속해 있습니다!");
    partyInvites[mentioned.id] = { partyId: party.id, inviterId: msg.author.id, expiresAt: Date.now() + 60_000 };
    return msg.reply(`📨 <@${mentioned.id}> 에게 파티 초대를 보냈습니다!\n\`!파티수락\` 또는 \`!파티거절\` 을 입력하세요. (1분 유효)`);
  }
 
  if (content === "!파티수락") {
    const invite = partyInvites[msg.author.id];
    if (!invite)                        return msg.reply("받은 파티 초대가 없습니다!");
    if (Date.now() > invite.expiresAt)  { delete partyInvites[msg.author.id]; return msg.reply("초대가 만료되었습니다!"); }
    if (getPartyId(msg.author.id))      return msg.reply("이미 파티에 속해 있습니다! 먼저 `!파티탈퇴` 하세요.");
    const party = parties[invite.partyId];
    if (!party)                         { delete partyInvites[msg.author.id]; return msg.reply("파티가 존재하지 않습니다."); }
    if (party.members.length >= 4)      { delete partyInvites[msg.author.id]; return msg.reply("파티가 가득 찼습니다!"); }
    party.members.push(msg.author.id);
    delete partyInvites[msg.author.id];
    return msg.reply({ embeds: [new EmbedBuilder()
      .setTitle("👥 파티 합류!")
      .setColor(0x4ade80)
      .setDescription(`**${player.name}** 님이 파티 **#${party.id}** 에 합류했습니다!`)
      .addFields({ name: "현재 파티원", value: party.members.map(uid => players[uid]?.name || uid).join(", ") })
    ]});
  }
 
  if (content === "!파티거절") {
    if (!partyInvites[msg.author.id]) return msg.reply("받은 파티 초대가 없습니다!");
    delete partyInvites[msg.author.id];
    return msg.reply("파티 초대를 거절했습니다.");
  }
 
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
    if (!pid)                           return msg.reply("파티에 속해 있지 않습니다! `!파티` 로 파티를 만드세요.");
    const party = parties[pid];
    if (party.leader !== msg.author.id) return msg.reply("파티 리더만 컬링 게임을 시작할 수 있습니다!");
    if (party.cullingSession)           return msg.reply("이미 파티 컬링 게임 진행 중입니다!");
    if (party.members.length < 2)      return msg.reply("파티 컬링 게임은 최소 2명 이상 필요합니다!");
    for (const uid of party.members) {
      if (battles[uid])  return msg.reply(`<@${uid}> 님이 일반 전투 중입니다!`);
      if (cullings[uid]) return msg.reply(`<@${uid}> 님이 솔로 컬링 게임 중입니다!`);
    }
    for (const uid of party.members) {
      const p = players[uid];
      // ★ HP 0 → 풀회복
      if (p && p.hp <= 0) { p.hp = CHARACTERS[p.active].maxHp; markDirty(); }
    }
    const firstEnemy = pickCullingEnemy(1);
    party.cullingSession = { wave: 1, currentEnemy: firstEnemy, enemyHp: firstEnemy.hp, skillUsedBy: {}, domainUsed: false, kills: 0, totalXp: 0, totalCrystals: 0, totalMastery: 0 };
    return msg.reply({
      content: party.members.map(uid => `<@${uid}>`).join(" "),
      embeds: [partyCullingEmbed(party, party.cullingSession, ["🌊 **[파티] 컬링 게임** 시작!", `${firstEnemy.emoji} **WAVE 1** — **${firstEnemy.name}** 등장!`, "파티원 누구나 버튼을 눌러 행동할 수 있습니다!"])],
      components: [mkPartyCullingButtons()],
    });
  }
 
  // !코드
  if (content.startsWith("!코드 ") || content.startsWith("!code ")) {
    const code = content.split(" ")[1]?.trim().toLowerCase();
    if (!code) return msg.reply("사용법: `!코드 코드입력`");
    if (player.usedCodes.includes(code)) return msg.reply("❌ 이미 사용한 코드입니다!");
    if (!CODES[code])                    return msg.reply("❌ 유효하지 않은 코드입니다!");
    const reward = CODES[code];
    player.crystals += reward.crystals || 0;
    player.usedCodes.push(code);
    markDirty();
    return msg.reply({ embeds: [new EmbedBuilder()
      .setTitle("🎁 코드 보상!")
      .setColor(0xF5C842)
      .setDescription(`코드 **${code}** 사용 완료!\n💎 **+${reward.crystals}** 크리스탈 획득!`)
      .addFields({ name: "💎 현재 크리스탈", value: `${player.crystals}`, inline: true })
    ]});
  }
 
  // ── DEV 패널 ──
  // !dev          → 자기 자신에게 패널
  // !dev @유저    → 멘션된 유저에게 패널 (DEV만 가능)
  if (content.startsWith("!dev") && isDev(msg.author.id)) {
    const mentioned = msg.mentions.users.first();
    if (mentioned && mentioned.id !== msg.author.id) {
      // 대상 유저에게 적용할 패널
      const targetPlayer = getPlayer(mentioned.id, mentioned.username);
      return msg.reply({
        content: `👑 DEV PANEL — 대상: **${targetPlayer.name}** (<@${mentioned.id}>)`,
        components: [mkDevButtons(mentioned.id)],
      });
    }
    // 자기 자신에게 패널
    return msg.reply({ content: "👑 DEV PANEL", components: [mkDevButtons()] });
  }
});
 
// ═══════════════════════════════════════════════
// ── 인터랙션 핸들러 ──
// ═══════════════════════════════════════════════
client.on("interactionCreate", async (i) => {
  if (!i.isButton() && !i.isStringSelectMenu()) return;
  const player = getPlayer(i.user.id, i.user.username);
  const battle  = battles[i.user.id];
  const culling = cullings[i.user.id];
 
  // ── 캐릭터 선택 ──
  if (i.isStringSelectMenu() && i.customId === "select_char") {
    const id = i.values[0];
    player.active = id;
    player.hp     = CHARACTERS[id].maxHp;
    markDirty();
    const ch    = CHARACTERS[id];
    const skill = getCurrentSkill(player, id);
    return i.update({ content: `${ch.emoji} **${ch.name}** 편성 완료! HP 최대 회복.\n등급: **${JJK_GRADE_EMOJI[ch.grade]} ${ch.grade}** | 현재 스킬: **${skill.name}** (피해 ${skill.dmg})`, components: [] });
  }
 
  // ── 일반 전투 적 선택 ──
  if (i.isButton() && i.customId.startsWith("enemy_")) {
    const enemyId = i.customId.replace("enemy_", "");
    const enemy   = ENEMIES.find(e => e.id === enemyId);
    if (!enemy) return i.reply({ content: "오류", ephemeral: true });
    const ch = CHARACTERS[player.active];
    battles[i.user.id] = { enemy: { ...enemy }, enemyHp: enemy.hp, skillUsed: false, domainUsed: false };
    const skill = getCurrentSkill(player, player.active);
    return i.update({
      content: "",
      embeds: [new EmbedBuilder()
        .setTitle(`⚔️ ${ch.emoji} ${ch.name} VS ${enemy.emoji} ${enemy.name}`)
        .setColor(0xe63946)
        .addFields(
          { name: `${ch.emoji} 내 HP`,    value: `${hpBar(player.hp, ch.maxHp)} ${player.hp}/${ch.maxHp}`, inline: true },
          { name: `${enemy.emoji} 적 HP`, value: `${hpBar(enemy.hp, enemy.hp)} ${enemy.hp}/${enemy.hp}`,   inline: true },
          { name: "🔥 현재 스킬",          value: `${skill.name} — ${skill.desc}`, inline: false },
          { name: "🌌 영역전개",            value: ch.domain || "없음", inline: true },
        )
        .setFooter({ text: "버튼으로 행동을 선택하세요!" })
      ],
      components: [mkBattleButtons()],
    });
  }
 
  // ── DEV 버튼 (대상 포함) ──
  if (i.isButton() && i.customId.startsWith("dev_") && isDev(i.user.id)) {
    // customId 형식: dev_<action> 또는 dev_<action>_<targetUserId>
    const parts    = i.customId.split("_");
    // parts[0] = "dev", parts[1] = action, parts[2]~ = targetId (선택)
    const action   = parts[1];
    const targetId = parts.length >= 3 ? parts.slice(2).join("_") : null;
    const target   = targetId ? getPlayer(targetId) : player;
    const targetName = targetId ? (players[targetId]?.name || targetId) : player.name;
 
    if (action === "heal") {
      target.hp = CHARACTERS[target.active].maxHp;
      markDirty();
      return i.reply({ content: `DEV: **${targetName}** HP 풀회복 (${target.hp})`, ephemeral: true });
    }
    if (action === "xp") {
      target.xp += 1000;
      markDirty();
      return i.reply({ content: `DEV: **${targetName}** XP +1000 (합계 ${target.xp})`, ephemeral: true });
    }
    if (action === "mastery") {
      target.owned.forEach(id => { target.mastery[id] = 30; });
      markDirty();
      return i.reply({ content: `DEV: **${targetName}** 모든 캐릭터 숙련도 MAX`, ephemeral: true });
    }
    if (action === "crystal") {
      target.crystals += 9999;
      markDirty();
      return i.reply({ content: `DEV: **${targetName}** 💎 +9999 (합계 ${target.crystals})`, ephemeral: true });
    }
    if (action === "kill") {
      const tId = targetId || i.user.id;
      if (battles[tId])  battles[tId].enemyHp = 0;
      if (cullings[tId]) cullings[tId].enemyHp = 0;
      const tParty = getParty(tId);
      if (tParty?.cullingSession) tParty.cullingSession.enemyHp = 0;
      return i.reply({ content: `DEV: **${targetName}** 적 즉사`, ephemeral: true });
    }
    return i.reply({ content: "DEV 오류", ephemeral: true });
  }
 
  // ─────────────────────────────────────────────
  // ── 솔로 컬링 게임 버튼 (c_) ──
  // ─────────────────────────────────────────────
  if (i.isButton() && i.customId.startsWith("c_")) {
    if (!culling) return i.reply({ content: "컬링 게임 진행 중이 아닙니다! `!컬링`으로 시작하세요.", ephemeral: true });
    const ch    = CHARACTERS[player.active];
    const skill = getCurrentSkill(player, player.active);
    const log   = [];
 
    // 각성 알림 (이번 턴에 처음 각성했는지 표시용)
    const wasAwakened = culling._makiAwakened || false;
    const nowAwakened = isMakiAwakened(player);
    if (!wasAwakened && nowAwakened) {
      culling._makiAwakened = true;
      log.push("🔥 **천여주박 각성!!** 마키의 데미지가 **2배**로 증가!");
    }
 
    // 철수
    if (i.customId === "c_escape") {
      player.xp       += culling.totalXp;
      player.crystals += culling.totalCrystals;
      if (!player.mastery[player.active]) player.mastery[player.active] = 0;
      player.mastery[player.active] += culling.totalMastery;
      if (culling.wave - 1 > player.cullingBest) player.cullingBest = culling.wave - 1;
      delete cullings[i.user.id];
      markDirty();
      return i.update({
        embeds: [new EmbedBuilder()
          .setTitle("🏳 컬링 게임 철수")
          .setColor(0x7c5cfc)
          .setDescription(`WAVE **${culling.wave}** 에서 철수!\n보상: **+${culling.totalXp}** XP | **+${culling.totalCrystals}**💎 | 숙련도 **+${culling.totalMastery}**`)
          .addFields({ name: "🌊 최고 기록", value: `WAVE **${player.cullingBest}**`, inline: true })
        ],
        components: [],
      });
    }
 
    const enemy = culling.currentEnemy;
 
    if (i.customId === "c_attack") {
      const dmg = calcDmgForPlayer(player, enemy.def);
      culling.enemyHp -= dmg;
      log.push(`👊 **${ch.name}**의 공격! → **${enemy.name}**에게 **${dmg}** 피해!${nowAwakened ? " 🔥" : ""}`);
    }
    else if (i.customId === "c_skill") {
      if (culling.skillUsed) return i.reply({ content: "술식은 파도당 1회!", ephemeral: true });
      const dmg = calcSkillDmgForPlayer(player, skill.dmg);
      culling.enemyHp -= dmg; culling.skillUsed = true;
      log.push(`✨ **${skill.name}**! → **${enemy.name}**에게 **${dmg}** 피해!${nowAwakened ? " 🔥" : ""}`);
    }
    else if (i.customId === "c_domain") {
      if (!ch.domain) return i.reply({ content: `${ch.name}은 영역전개가 없습니다!`, ephemeral: true });
      if (culling.domainUsed) return i.reply({ content: "영역전개는 컬링 게임당 1회!", ephemeral: true });
      const dmg = Math.floor(400 + ch.atk * 2 + getMastery(player, player.active) * 5);
      culling.enemyHp -= dmg; culling.domainUsed = true;
      log.push(`🌌 **${ch.domain}** 발동! → **${enemy.name}**에게 **${dmg}** 피해!`);
    }
    else if (i.customId === "c_reverse") {
      if (!REVERSE_CHARS.has(player.active)) return i.reply({ content: `❌ **${ch.name}**은 반전술식을 사용할 수 없습니다!`, ephemeral: true });
      const heal = Math.floor(80 * player.reverseOutput);
      player.hp = Math.min(ch.maxHp, player.hp + heal);
      player.reverseOutput = Math.min(3.0, player.reverseOutput + 0.2);
      log.push(`♻ 반전술식! HP **+${heal}** 회복 (출력 ${player.reverseOutput.toFixed(1)}배)`);
    }
 
    if (culling.enemyHp > 0 && i.customId !== "c_reverse") {
      const dmg = calcDmg(enemy.atk, ch.def);
      player.hp -= dmg;
      log.push(`💥 **${enemy.name}**의 반격! → **${ch.name}**에게 **${dmg}** 피해!`);
    }
 
    // 각성 체크 (반격 받은 후 재확인)
    if (!culling._makiAwakened && isMakiAwakened(player)) {
      culling._makiAwakened = true;
      log.push("🔥 **천여주박 각성!!** HP가 30% 이하로 떨어졌다! 마키의 데미지가 **2배**!");
    }
 
    const dead      = player.hp <= 0;
    const enemyDead = culling.enemyHp <= 0;
 
    if (dead) {
      player.hp = 0; player.losses++;
      const hXp  = Math.floor(culling.totalXp / 2);
      const hCry = Math.floor(culling.totalCrystals / 2);
      player.xp += hXp; player.crystals += hCry;
      if (!player.mastery[player.active]) player.mastery[player.active] = 0;
      player.mastery[player.active] += Math.floor(culling.totalMastery / 2);
      if (culling.wave - 1 > player.cullingBest) player.cullingBest = culling.wave - 1;
      delete cullings[i.user.id];
      markDirty();
      log.push(`\n💀 **사망!** WAVE **${culling.wave}** 전사...\n절반 보상: **+${hXp}** XP | **+${hCry}**💎`);
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
 
    if (enemyDead) {
      culling.kills++;
      culling.totalXp       += enemy.xp;
      culling.totalCrystals += enemy.crystals;
      culling.totalMastery  += enemy.masteryXp;
      log.push(`✅ **${enemy.name}** 처치! +${enemy.xp} XP | +${enemy.crystals}💎`);
      if (culling.wave > player.cullingBest) { player.cullingBest = culling.wave; log.push(`🏆 **최고기록 갱신!** WAVE ${player.cullingBest}`); }
      const nextWave  = culling.wave + 1;
      const nextEnemy = pickCullingEnemy(nextWave);
      culling.wave = nextWave; culling.currentEnemy = nextEnemy; culling.enemyHp = nextEnemy.hp; culling.skillUsed = false;
      log.push(`\n🌊 **WAVE ${nextWave}** 돌입! ${nextEnemy.emoji} **${nextEnemy.name}** 등장! (HP ${nextEnemy.hp})`);
      markDirty();
      return i.update({ embeds: [cullingEmbed(player, culling, log)], components: [mkCullingButtons()] });
    }
 
    markDirty();
    return i.update({ embeds: [cullingEmbed(player, culling, log)], components: [mkCullingButtons()] });
  }
 
  // ─────────────────────────────────────────────
  // ── 파티 컬링 버튼 (pc_) ──
  // ─────────────────────────────────────────────
  if (i.isButton() && i.customId.startsWith("pc_")) {
    const pid = getPartyId(i.user.id);
    if (!pid) return i.reply({ content: "파티에 속해 있지 않습니다!", ephemeral: true });
    const party = parties[pid];
    if (!party.cullingSession) return i.reply({ content: "파티 컬링 게임이 진행 중이 아닙니다!", ephemeral: true });
    const session = party.cullingSession;
    const ch      = CHARACTERS[player.active];
    const skill   = getCurrentSkill(player, player.active);
    const log     = [];
 
    // 마키 각성 알림
    if (!session._makiAwakened && isMakiAwakened(player)) {
      session._makiAwakened = true;
      log.push(`🔥 **${player.name}의 천여주박 각성!!** 데미지 **2배**!`);
    }
 
    // 철수 (리더만)
    if (i.customId === "pc_escape") {
      if (i.user.id !== party.leader) return i.reply({ content: "파티 리더만 철수할 수 있습니다!", ephemeral: true });
      for (const uid of party.members) {
        const p = players[uid]; if (!p) continue;
        p.xp += session.totalXp; p.crystals += session.totalCrystals;
        if (!p.mastery[p.active]) p.mastery[p.active] = 0;
        p.mastery[p.active] += session.totalMastery;
        if (session.wave - 1 > p.cullingBest) p.cullingBest = session.wave - 1;
      }
      party.cullingSession = null; markDirty();
      return i.update({
        embeds: [new EmbedBuilder()
          .setTitle("🏳 [파티] 컬링 게임 철수")
          .setColor(0x7c5cfc)
          .setDescription(`WAVE **${session.wave}** 에서 철수!\n파티원 전원에게 **+${session.totalXp}** XP | **+${session.totalCrystals}**💎 지급`)
        ],
        components: [],
      });
    }
 
    const enemy = session.currentEnemy;
 
    if (i.customId === "pc_attack") {
      const dmg = calcDmgForPlayer(player, enemy.def);
      session.enemyHp -= dmg;
      log.push(`👊 **${player.name}**(${ch.name})의 공격! → **${dmg}** 피해!${isMakiAwakened(player) ? " 🔥" : ""}`);
    }
    else if (i.customId === "pc_skill") {
      if (session.skillUsedBy[i.user.id]) return i.reply({ content: "이번 파도에 술식을 이미 사용했습니다!", ephemeral: true });
      const dmg = calcSkillDmgForPlayer(player, skill.dmg);
      session.enemyHp -= dmg; session.skillUsedBy[i.user.id] = true;
      log.push(`✨ **${player.name}**의 **${skill.name}**! → **${dmg}** 피해!${isMakiAwakened(player) ? " 🔥" : ""}`);
    }
    else if (i.customId === "pc_domain") {
      if (!ch.domain) return i.reply({ content: `${ch.name}은 영역전개가 없습니다!`, ephemeral: true });
      if (session.domainUsed) return i.reply({ content: "영역전개는 파티 컬링 게임당 1회!", ephemeral: true });
      const dmg = Math.floor(400 + ch.atk * 2 + getMastery(player, player.active) * 5);
      session.enemyHp -= dmg; session.domainUsed = true;
      log.push(`🌌 **${player.name}**의 **${ch.domain}** 발동! → **${dmg}** 피해!`);
    }
    else if (i.customId === "pc_reverse") {
      if (!REVERSE_CHARS.has(player.active)) return i.reply({ content: `❌ **${ch.name}**은 반전술식을 사용할 수 없습니다!`, ephemeral: true });
      const heal = Math.floor(80 * player.reverseOutput);
      player.hp = Math.min(ch.maxHp, player.hp + heal);
      player.reverseOutput = Math.min(3.0, player.reverseOutput + 0.2);
      log.push(`♻ **${player.name}**의 반전술식! HP **+${heal}** 회복`);
    }
 
    if (session.enemyHp > 0 && i.customId !== "pc_reverse") {
      const alive = party.members.filter(uid => players[uid] && players[uid].hp > 0);
      if (alive.length > 0) {
        const tgt = players[alive[Math.floor(Math.random() * alive.length)]];
        const tch = CHARACTERS[tgt.active];
        const dmg = calcDmg(enemy.atk, tch.def);
        tgt.hp -= dmg;
        log.push(`💥 **${enemy.name}**의 반격! → **${tgt.name}**에게 **${dmg}** 피해!${tgt.hp <= 0 ? ` 💀 **${tgt.name}** 전사!` : ""}`);
        if (tgt.hp < 0) tgt.hp = 0;
        // 반격 후 마키 각성 체크
        if (!session._makiAwakened && isMakiAwakened(tgt)) {
          session._makiAwakened = true;
          log.push(`🔥 **${tgt.name}의 천여주박 각성!!** 데미지 **2배**!`);
        }
      }
    }
 
    const allDead   = party.members.every(uid => !players[uid] || players[uid].hp <= 0);
    const enemyDead = session.enemyHp <= 0;
 
    if (allDead) {
      for (const uid of party.members) {
        const p = players[uid]; if (!p) continue;
        p.hp = 0; p.losses++;
        p.xp       += Math.floor(session.totalXp / 2);
        p.crystals += Math.floor(session.totalCrystals / 2);
        if (!p.mastery[p.active]) p.mastery[p.active] = 0;
        p.mastery[p.active] += Math.floor(session.totalMastery / 2);
        if (session.wave - 1 > p.cullingBest) p.cullingBest = session.wave - 1;
      }
      party.cullingSession = null; markDirty();
      log.push(`\n💀 **파티 전멸!** WAVE **${session.wave}** 패배...\n절반 보상: **+${Math.floor(session.totalXp/2)}** XP | **+${Math.floor(session.totalCrystals/2)}**💎`);
      return i.update({
        embeds: [new EmbedBuilder().setTitle(`💀 [파티] 컬링 게임 실패 — WAVE ${session.wave}`).setColor(0xe63946).setDescription(log.join("\n"))],
        components: [],
      });
    }
 
    if (enemyDead) {
      session.kills++;
      session.totalXp       += enemy.xp;
      session.totalCrystals += enemy.crystals;
      session.totalMastery  += enemy.masteryXp;
      log.push(`✅ **${enemy.name}** 처치! +${enemy.xp} XP | +${enemy.crystals}💎`);
      const nextWave  = session.wave + 1;
      const nextEnemy = pickCullingEnemy(nextWave);
      session.wave = nextWave; session.currentEnemy = nextEnemy; session.enemyHp = nextEnemy.hp; session.skillUsedBy = {};
      log.push(`\n🌊 **WAVE ${nextWave}** 돌입! ${nextEnemy.emoji} **${nextEnemy.name}** 등장! (HP ${nextEnemy.hp})`);
      markDirty();
      return i.update({ embeds: [partyCullingEmbed(party, session, log)], components: [mkPartyCullingButtons()] });
    }
 
    markDirty();
    return i.update({ embeds: [partyCullingEmbed(party, session, log)], components: [mkPartyCullingButtons()] });
  }
 
  // ─────────────────────────────────────────────
  // ── 일반 전투 버튼 (b_) ──
  // ─────────────────────────────────────────────
  if (!i.isButton() || !i.customId.startsWith("b_")) return;
  if (!battle) return i.reply({ content: "전투 중이 아닙니다! `!전투`로 시작하세요.", ephemeral: true });
 
  const ch    = CHARACTERS[player.active];
  const enemy = battle.enemy;
  const skill = getCurrentSkill(player, player.active);
  const log   = [];
 
  // 마키 각성 알림
  const wasBAwakened = battle._makiAwakened || false;
  const nowBAwakened = isMakiAwakened(player);
  if (!wasBAwakened && nowBAwakened) {
    battle._makiAwakened = true;
    log.push("🔥 **천여주박 각성!!** 마키의 데미지가 **2배**로 증가!");
  }
 
  if (i.customId === "b_attack") {
    const dmg = calcDmgForPlayer(player, enemy.def);
    battle.enemyHp -= dmg;
    log.push(`👊 **${ch.name}**의 공격! → **${enemy.name}**에게 **${dmg}** 피해!${nowBAwakened ? " 🔥" : ""}`);
  }
  else if (i.customId === "b_skill") {
    if (battle.skillUsed) return i.reply({ content: "술식은 전투당 1회!", ephemeral: true });
    const dmg = calcSkillDmgForPlayer(player, skill.dmg);
    battle.enemyHp -= dmg; battle.skillUsed = true;
    log.push(`✨ **${skill.name}**! → **${enemy.name}**에게 **${dmg}** 피해!${nowBAwakened ? " 🔥" : ""}`);
  }
  else if (i.customId === "b_domain") {
    if (!ch.domain)       return i.reply({ content: `${ch.name}은 영역전개가 없습니다!`, ephemeral: true });
    if (battle.domainUsed) return i.reply({ content: "영역전개는 전투당 1회!", ephemeral: true });
    const dmg = Math.floor(400 + ch.atk * 2 + getMastery(player, player.active) * 5);
    battle.enemyHp -= dmg; battle.domainUsed = true;
    log.push(`🌌 **${ch.domain}** 발동! → **${enemy.name}**에게 **${dmg}** 피해!`);
  }
  else if (i.customId === "b_reverse") {
    if (!REVERSE_CHARS.has(player.active)) return i.reply({ content: `❌ **${ch.name}**은 반전술식을 사용할 수 없습니다!`, ephemeral: true });
    const heal = Math.floor(80 * player.reverseOutput);
    player.hp = Math.min(ch.maxHp, player.hp + heal);
    player.reverseOutput = Math.min(3.0, player.reverseOutput + 0.2);
    log.push(`♻ 반전술식! HP **+${heal}** 회복 (출력 ${player.reverseOutput.toFixed(1)}배)`);
  }
  else if (i.customId === "b_run") {
    if (Math.random() < 0.6) { delete battles[i.user.id]; markDirty(); return i.update({ content: "🏃 도주 성공!", embeds: [], components: [] }); }
    log.push("❌ 도주 실패!");
  }
 
  if (battle.enemyHp > 0 && i.customId !== "b_reverse") {
    const dmg = calcDmg(enemy.atk, ch.def);
    player.hp -= dmg;
    log.push(`💥 **${enemy.name}**의 반격! → **${ch.name}**에게 **${dmg}** 피해!`);
    // 반격 후 각성 체크
    if (!battle._makiAwakened && isMakiAwakened(player)) {
      battle._makiAwakened = true;
      log.push("🔥 **천여주박 각성!!** HP 30% 이하! 마키의 데미지가 **2배**!");
    }
  }
 
  const pDead = player.hp <= 0;
  const eDead = battle.enemyHp <= 0;
 
  if (eDead) {
    player.xp += enemy.xp; player.crystals += enemy.crystals; player.wins++;
    if (!player.mastery[player.active]) player.mastery[player.active] = 0;
    player.mastery[player.active] += enemy.masteryXp;
    const newSkill = getCurrentSkill(player, player.active);
    delete battles[i.user.id]; markDirty();
    log.push(`\n🏆 승리! +**${enemy.xp}** XP | +**${enemy.crystals}**💎 | 숙련도 **+${enemy.masteryXp}**`);
    log.push(`🔥 현재 스킬: **${newSkill.name}** (피해 ${newSkill.dmg})`);
  } else if (pDead) {
    player.hp = 0; player.losses++;
    delete battles[i.user.id]; markDirty();
    log.push(`\n💀 패배... !전투로 재도전하세요.`);
  }
 
  const over = pDead || eDead;
  return i.update({
    embeds: [new EmbedBuilder()
      .setTitle(`⚔️ ${ch.name} VS ${enemy.emoji} ${enemy.name}`)
      .setColor(pDead ? 0xe63946 : eDead ? 0xF5C842 : (isMakiAwakened(player) && !over) ? 0xFF0000 : 0x7c5cfc)
      .setDescription(log.join("\n"))
      .addFields(
        { name: `${ch.emoji} 내 HP`,    value: `${hpBar(player.hp, ch.maxHp)} ${Math.max(0,player.hp)}/${ch.maxHp}${isMakiAwakened(player) && !over ? " 🔥각성" : ""}`, inline: true },
        { name: `${enemy.emoji} 적 HP`, value: `${hpBar(battle.enemyHp, enemy.hp)} ${Math.max(0,battle.enemyHp)}/${enemy.hp}`, inline: true },
      )
      .setFooter({ text: over ? "전투 종료!" : `술식: ${skill.name} | 영역: ${ch.domain || "없음"}${isMakiAwakened(player) ? " | 🔥천여주박 각성 중" : ""}` })
    ],
    components: over ? [] : [mkBattleButtons()],
  });
});
 
client.once("ready", () => {
  console.log(`✅ ${client.user.tag} 온라인!`);
  client.user.setActivity("주술회전 RPG | !도움", { type: 0 });
});
 
client.login(TOKEN);
