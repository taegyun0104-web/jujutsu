require("dotenv").config();

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

const DEV_IDS = new Set([
  "1499743296023691395",
  "1397218266505678881",
  "1499983302503956501",
]);
const isDev = (id) => DEV_IDS.has(id);

const CHARACTERS = {
  itadori: {
    name: "이타도리 유지", emoji: "🟠", grade: "C",
    atk: 70, def: 60, spd: 75, maxHp: 900,
    domain: null,
    desc: "특급주술사 후보생. 아직 성장 중인 주술사.",
    skills: [
      { name: "주먹질",  minMastery: 0,  dmg: 70,  desc: "강력한 기본 주먹 공격." },
      { name: "흑번",    minMastery: 5,  dmg: 120, desc: "저주 에너지를 실은 주먹." },
      { name: "흑번창",  minMastery: 15, dmg: 180, desc: "최대 저주 에너지 방출!" },
      { name: "발도",    minMastery: 30, dmg: 260, desc: "스쿠나의 힘을 빌린 궁극기." },
    ],
  },
  gojo: {
    name: "고조 사토루", emoji: "🔵", grade: "S",
    atk: 100, def: 95, spd: 100, maxHp: 1500,
    domain: "무량공처",
    desc: "최강의 주술사. 무량공처를 구사한다.",
    skills: [
      { name: "아오", minMastery: 0,  dmg: 110, desc: "적들을 끌어당겨서 공격한다." },
      { name: "아카",       minMastery: 5,  dmg: 170, desc: "적들을 날려서 폭발시킨다." },
      { name: "무라사키",       minMastery: 15, dmg: 250, desc: "아오와 아카를 합쳐서 발사하는 무한한 에너지." },
      { name: "무량공처", minMastery: 30, dmg: 360, desc: "무한을 지배하는 궁극술식." },
    ],
  },
  megumi: {
    name: "후시구로 메구미", emoji: "⚫", grade: "A",
    atk: 85, def: 88, spd: 82, maxHp: 1000,
    domain: "강압암예정",
    desc: "식신술을 구사하는 주술사.",
    skills: [
      { name: "옥견",       minMastery: 0,  dmg: 85,  desc: "식신 옥견을 소환한다." },
      { name: "대호",       minMastery: 5,  dmg: 140, desc: "식신 대호를 소환한다." },
      { name: "십종영이",   minMastery: 15, dmg: 200, desc: "열 가지 식신을 소환한다." },
      { name: "마허라가라", minMastery: 30, dmg: 290, desc: "최강의 식신, 마허라가라 강림." },
    ],
  },
  nobara: {
    name: "쿠기사키 노바라", emoji: "🌸", grade: "A",
    atk: 88, def: 75, spd: 85, maxHp: 950,
    domain: null,
    desc: "반전술식을 구사하는 주술사.",
    skills: [
      { name: "망치질", minMastery: 0,  dmg: 88,  desc: "저주 못을 박는다." },
      { name: "공명",   minMastery: 5,  dmg: 150, desc: "허수아비를 통해 공명 피해." },
      { name: "철정",   minMastery: 15, dmg: 210, desc: "저주 에너지 주입 못을 박는다." },
      { name: "발화",   minMastery: 30, dmg: 290, desc: "모든 못에 동시 폭발 공명." },
    ],
  },
  nanami: {
    name: "나나미 켄토", emoji: "🟡", grade: "A",
    atk: 90, def: 85, spd: 75, maxHp: 1100,
    domain: null,
    desc: "1급 주술사. 합리적 판단의 소유자.",
    skills: [
      { name: "둔기 공격", minMastery: 0,  dmg: 90,  desc: "단단한 둔기로 타격한다." },
      { name: "칠할삼분",  minMastery: 5,  dmg: 155, desc: "7:3 지점을 노린 약점 공격." },
      { name: "십수할",    minMastery: 15, dmg: 220, desc: "열 배의 저주 에너지 방출." },
      { name: "초과근무",  minMastery: 30, dmg: 310, desc: "한계를 넘어선 폭발적 강화." },
    ],
  },
  sukuna: {
    name: "료멘 스쿠나", emoji: "🔴", grade: "S",
    atk: 100, def: 90, spd: 95, maxHp: 2000,
    domain: "복마어주자",
    desc: "저주의 왕. 역대 최강의 저주된 영혼.",
    skills: [
      { name: "손톱 공격",       minMastery: 0,  dmg: 110, desc: "날카로운 손톱으로 베어낸다." },
      { name: "해체",            minMastery: 5,  dmg: 180, desc: "공간 자체를 베어낸다." },
      { name: "분해",            minMastery: 15, dmg: 260, desc: "닿는 모든 것을 분해한다." },
      { name: "개·염·천·지·개", minMastery: 30, dmg: 380, desc: "천지개벽의 궁극 영역전개." },
    ],
  },
  geto: {
    name: "게토 스구루", emoji: "🟢", grade: "S",
    atk: 88, def: 82, spd: 80, maxHp: 1300,
    domain: null,
    desc: "전 특급 주술사. 저주를 다루는 달인.",
    skills: [
      { name: "저주 방출",  minMastery: 0,  dmg: 95,  desc: "저급 저주령을 방출한다." },
      { name: "최대출력",   minMastery: 5,  dmg: 160, desc: "저주령을 전력으로 방출." },
      { name: "저주영조종", minMastery: 15, dmg: 230, desc: "수천의 저주령을 조종한다." },
      { name: "감로대법",   minMastery: 30, dmg: 320, desc: "감로대법으로 모든 저주 흡수." },
    ],
  },
  maki: {
    name: "마키 젠인", emoji: "⚪", grade: "A",
    atk: 92, def: 88, spd: 92, maxHp: 1050,
    domain: null,
    desc: "저주력이 없어도 강한 주술사.",
    skills: [
      { name: "봉술",       minMastery: 0,  dmg: 92,  desc: "저주 도구 봉으로 타격." },
      { name: "저주창",     minMastery: 5,  dmg: 155, desc: "저주 도구 창을 투척한다." },
      { name: "저주도구술", minMastery: 15, dmg: 215, desc: "다양한 저주 도구를 구사." },
      { name: "천개봉파",   minMastery: 30, dmg: 300, desc: "수천의 저주 도구 연속 공격." },
    ],
  },
  panda: {
    name: "판다", emoji: "🐼", grade: "B",
    atk: 80, def: 90, spd: 70, maxHp: 1100,
    domain: null,
    desc: "저주로 만든 특이체질의 주술사.",
    skills: [
      { name: "박치기",     minMastery: 0,  dmg: 80,  desc: "머리로 힘차게 들이받는다." },
      { name: "곰 발바닥", minMastery: 5,  dmg: 135, desc: "두꺼운 발바닥으로 내리친다." },
      { name: "팬더 변신", minMastery: 15, dmg: 195, desc: "진짜 팬더로 변신해 공격." },
      { name: "고릴라 변신", minMastery: 30, dmg: 270, desc: "고릴라 형태로 폭발적 강화." },
    ],
  },
  inumaki: {
    name: "이누마키 토게", emoji: "🟤", grade: "B",
    atk: 85, def: 70, spd: 88, maxHp: 900,
    domain: null,
    desc: "주술언어를 구사하는 세미1급 주술사.",
    skills: [
      { name: "멈춰라",   minMastery: 0,  dmg: 85,  desc: "상대의 움직임을 봉쇄한다." },
      { name: "달려라",   minMastery: 5,  dmg: 140, desc: "상대를 무작위로 달리게 한다." },
      { name: "주술언어", minMastery: 15, dmg: 200, desc: "강력한 주술 명령을 내린다." },
      { name: "폭발해라", minMastery: 30, dmg: 285, desc: "상대를 그 자리에서 폭발시킨다." },
    ],
  },
  yuta: {
    name: "오코츠 유타", emoji: "🌟", grade: "S",
    atk: 98, def: 88, spd: 92, maxHp: 1400,
    domain: "진안상애",
    desc: "특급 주술사. 리카의 저주를 다루는 최강급 주술사.",
    skills: [
      { name: "모방술식",  minMastery: 0,  dmg: 105, desc: "다른 술식을 모방해 공격한다." },
      { name: "리카 소환", minMastery: 5,  dmg: 170, desc: "저주의 여왕 리카를 소환한다." },
      { name: "순애빔",    minMastery: 15, dmg: 260, desc: "리카와의 순수한 사랑을 에너지로 발사." },
      { name: "진안상애",  minMastery: 30, dmg: 360, desc: "영역전개로 모든 것을 사랑으로 파괴." },
    ],
  },
  higuruma: {
    name: "히구루마 히로미", emoji: "⚖️", grade: "A",
    atk: 90, def: 82, spd: 78, maxHp: 1050,
    domain: "주복사사",
    desc: "전직 변호사 출신 주술사. 심판의 영역전개를 구사한다.",
    skills: [
      { name: "저주도구",    minMastery: 0,  dmg: 90,  desc: "저주 에너지를 담은 도구로 공격." },
      { name: "몰수",        minMastery: 5,  dmg: 150, desc: "상대의 술식을 몰수한다." },
      { name: "사형판결",    minMastery: 15, dmg: 220, desc: "재판 결과에 따른 강력한 제재." },
      { name: "집행인 인형", minMastery: 30, dmg: 310, desc: "집행인 인형을 소환해 즉시 처형." },
    ],
  },
};

const ENEMIES = [
  { id: "e1", name: "저급 저주령",      emoji: "👹", hp: 400,  atk: 28,  def: 10, xp: 60,  crystals: 15,  masteryXp: 1 },
  { id: "e2", name: "1급 저주령",       emoji: "👺", hp: 800,  atk: 60,  def: 30, xp: 150, crystals: 30,  masteryXp: 3 },
  { id: "e3", name: "특급 저주령",      emoji: "💀", hp: 1800, atk: 95,  def: 55, xp: 350, crystals: 70,  masteryXp: 7 },
  { id: "e4", name: "저주의 왕 (보스)", emoji: "👑", hp: 4000, atk: 140, def: 80, xp: 800, crystals: 150, masteryXp: 15 },
];

const GACHA_POOL = [
  { id: "gojo",     rate: 0.7 },
  { id: "sukuna",   rate: 0.8 },
  { id: "yuta",     rate: 1.0 },
  { id: "geto",     rate: 1.5 },
  { id: "itadori",  rate: 3.0 },
  { id: "megumi",   rate: 7   },
  { id: "nanami",   rate: 7   },
  { id: "maki",     rate: 8   },
  { id: "nobara",   rate: 8   },
  { id: "higuruma", rate: 8   },
  { id: "panda",    rate: 27  },
  { id: "inumaki",  rate: 28  },
];

const GRADE_COLOR = { S: 0xF5C842, A: 0x7C5CFC, B: 0x4ade80, C: 0x94a3b8 };
const GRADE_EMOJI = { S: "⭐⭐⭐", A: "⭐⭐", B: "⭐", C: "🔹" };
const REVERSE_CHARS = new Set(["gojo", "sukuna", "yuta"]);
const CODES = { "release": { crystals: 200 } };

const players = {};
const battles = {};

function getPlayer(userId, username = "플레이어") {
  if (!players[userId]) {
    players[userId] = {
      id: userId, name: username, crystals: 500, xp: 0,
      owned: ["itadori"], active: "itadori",
      hp: CHARACTERS["itadori"].maxHp, potion: 3,
      wins: 0, losses: 0, mastery: { itadori: 0 }, reverseOutput: 1.0,
    };
  }
  return players[userId];
}

function getMastery(player, charId) { return player.mastery?.[charId] || 0; }

function getCurrentSkill(player, charId) {
  const mastery = getMastery(player, charId);
  let current = CHARACTERS[charId].skills[0];
  for (const s of CHARACTERS[charId].skills) { if (mastery >= s.minMastery) current = s; }
  return current;
}

function getNextSkill(player, charId) {
  const mastery = getMastery(player, charId);
  return CHARACTERS[charId].skills.find(s => s.minMastery > mastery) || null;
}

function masteryBar(mastery, charId) {
  const tiers = CHARACTERS[charId].skills.map(s => s.minMastery);
  const maxTier = tiers[tiers.length - 1];
  if (mastery >= maxTier) return "`[MAX]` 모든 스킬 해금!";
  const next = tiers.find(t => t > mastery) || maxTier;
  const prev = [...tiers].reverse().find(t => t <= mastery) || 0;
  const filled = Math.round(((mastery - prev) / (next - prev)) * 10);
  return "`" + "█".repeat(Math.max(0, filled)) + "░".repeat(Math.max(0, 10 - filled)) + "`" + ` ${mastery}/${next}`;
}

function getLevel(xp) { return Math.floor(xp / 200) + 1; }
function hpBar(cur, max, len = 12) {
  const filled = Math.round((Math.max(0, cur) / max) * len);
  return "`" + "█".repeat(Math.max(0, filled)) + "░".repeat(Math.max(0, len - filled)) + "`";
}
function calcDmg(atk, def, mult = 1) {
  return Math.max(1, Math.floor((atk * (0.8 + Math.random() * 0.4) - def * 0.25) * mult));
}

function battleButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("b_attack").setLabel("⚔ 공격").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("b_skill").setLabel("🌀 술식").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("b_domain").setLabel("🌌 영역전개").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("b_reverse").setLabel("♻ 반전술식").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("b_run").setLabel("🏃 도주").setStyle(ButtonStyle.Secondary),
  );
}

function devButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("dev_heal").setLabel("HP 풀회복").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("dev_xp").setLabel("XP +1000").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("dev_mastery").setLabel("숙련도 MAX").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("dev_crystal").setLabel("💎 +9999").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("dev_kill").setLabel("적 즉사").setStyle(ButtonStyle.Danger),
  );
}

function rollGacha(count = 1) {
  const total = GACHA_POOL.reduce((s, p) => s + p.rate, 0);
  return Array.from({ length: count }, () => {
    let roll = Math.random() * total;
    for (const e of GACHA_POOL) { roll -= e.rate; if (roll <= 0) return e.id; }
    return GACHA_POOL[GACHA_POOL.length - 1].id;
  });
}

function profileEmbed(player) {
  const ch = CHARACTERS[player.active];
  const skill = getCurrentSkill(player, player.active);
  const nextSkill = getNextSkill(player, player.active);
  const mastery = getMastery(player, player.active);
  return new EmbedBuilder()
    .setTitle(`${ch.emoji} ${player.name}의 주술사 프로필`)
    .setColor(GRADE_COLOR[ch.grade])
    .addFields(
      { name: "📊 레벨/XP", value: `LV.**${getLevel(player.xp)}** | ${player.xp} XP`, inline: true },
      { name: "💎 크리스탈", value: `${player.crystals}`, inline: true },
      { name: "🏆 전적", value: `${player.wins}승 ${player.losses}패`, inline: true },
      { name: `${ch.emoji} 활성 캐릭터 [${GRADE_EMOJI[ch.grade]} ${ch.grade}급]`, value: ch.desc, inline: false },
      { name: "⚔️ 스탯", value: `공격 **${ch.atk}** | 방어 **${ch.def}** | HP **${Math.max(0,player.hp)}/${ch.maxHp}**`, inline: false },
      { name: "🔥 현재 스킬", value: `**${skill.name}** — ${skill.desc} (피해 ${skill.dmg})`, inline: false },
      { name: "📈 숙련도", value: masteryBar(mastery, player.active), inline: true },
      { name: "⬆️ 다음 스킬", value: nextSkill ? `**${nextSkill.name}** (숙련도 ${nextSkill.minMastery} 필요)` : "**MAX 달성!**", inline: true },
      { name: "🌌 영역전개", value: ch.domain || "없음", inline: true },
      { name: "❤️ HP 바", value: `${hpBar(player.hp, ch.maxHp)} ${Math.max(0,player.hp)}/${ch.maxHp}`, inline: true },
      { name: "🧪 회복약", value: `${player.potion}개`, inline: true },
      { name: "📦 보유 캐릭터", value: player.owned.map(id => `${CHARACTERS[id].emoji} ${CHARACTERS[id].name} (숙련 ${getMastery(player,id)})`).join("\n"), inline: false },
    )
    .setFooter({ text: "!캐릭터 | !스킬 | !가챠 | !전투" });
}

function skillEmbed(player) {
  const id = player.active;
  const ch = CHARACTERS[id];
  const mastery = getMastery(player, id);
  return new EmbedBuilder()
    .setTitle(`${ch.emoji} ${ch.name}의 스킬 트리`)
    .setColor(GRADE_COLOR[ch.grade])
    .setDescription(`현재 숙련도: **${mastery}** | 현재 스킬: **${getCurrentSkill(player, id).name}**\n영역전개: **${ch.domain || "없음"}**`)
    .addFields(ch.skills.map(s => ({
      name: `${mastery >= s.minMastery ? "✅" : "🔒"} ${s.name} — 피해 ${s.dmg} (숙련도 ${s.minMastery} 필요)`,
      value: s.desc, inline: false,
    })))
    .setFooter({ text: "전투 승리 시 숙련도 상승!" });
}

client.on("messageCreate", async (msg) => {
  if (!msg || msg.author.bot) return;
  const content = msg.content.trim();
  const player = getPlayer(msg.author.id, msg.author.username);

  if (content === "!도움" || content === "!help") {
    return msg.reply({ embeds: [new EmbedBuilder()
      .setTitle("⚡ 주술회전 RPG봇 — 명령어")
      .setColor(0x7c5cfc)
      .addFields(
        { name: "📋 기본", value: "`!프로필` `!도움`", inline: false },
        { name: "👤 캐릭터", value: "`!캐릭터` — 편성\n`!도감` — 전체 목록\n`!스킬` — 스킬 트리", inline: false },
        { name: "🎲 가챠", value: "`!가챠` — 1회 (150💎)\n`!가챠10` — 10회 (1350💎)", inline: false },
        { name: "⚔️ 전투", value: "`!전투` — 전투 시작\n버튼으로 공격/술식/영역전개/반전술식/도주", inline: false },
        { name: "🎁 코드", value: "`!코드 [코드]` — 보상 코드 입력", inline: false },
        { name: "📈 숙련도", value: "전투 승리 시 숙련도 상승 → 더 강한 스킬 해금!", inline: false },
      )
      .setFooter({ text: "💎 첫 시작 시 500 크리스탈 지급!" })
    ]});
  }

  if (content === "!프로필") return msg.reply({ embeds: [profileEmbed(player)] });
  if (content === "!스킬") return msg.reply({ embeds: [skillEmbed(player)] });

  if (content === "!도감") {
    return msg.reply({ embeds: [new EmbedBuilder()
      .setTitle("📖 주술회전 캐릭터 도감")
      .setColor(0x0d0d1a)
      .setDescription(Object.entries(CHARACTERS).map(([id, ch]) => {
        const owned = player.owned.includes(id);
        const mastery = getMastery(player, id);
        const skill = owned ? getCurrentSkill(player, id) : null;
        return `${owned ? ch.emoji : "🔒"} **${ch.name}** [${ch.grade}급]${owned ? ` — 숙련 ${mastery} | ${skill.name}` : " — 미획득"}`;
      }).join("\n"))
      .setFooter({ text: "!가챠로 새 캐릭터를 획득하세요!" })
    ]});
  }

  if (content === "!캐릭터") {
    if (!player.owned.length) return msg.reply("보유 캐릭터 없음! `!가챠`로 소환하세요.");
    const select = new StringSelectMenuBuilder()
      .setCustomId("select_char")
      .setPlaceholder("편성할 캐릭터 선택")
      .addOptions(player.owned.map(id => {
        const ch = CHARACTERS[id];
        const skill = getCurrentSkill(player, id);
        return { label: ch.name, description: `${ch.grade}급 | 숙련 ${getMastery(player,id)} | ${skill.name}`, value: id, emoji: ch.emoji, default: player.active === id };
      }));
    return msg.reply({ content: "👤 편성할 캐릭터를 선택하세요:", components: [new ActionRowBuilder().addComponents(select)] });
  }

  if (content === "!가챠") {
    if (player.crystals < 150) return msg.reply(`💎 크리스탈 부족! (${player.crystals}/150)`);
    player.crystals -= 150;
    const [result] = rollGacha(1);
    const ch = CHARACTERS[result];
    const isNew = !player.owned.includes(result);
    if (isNew) { player.owned.push(result); if (!player.mastery[result]) player.mastery[result] = 0; }
    else player.crystals += 50;
    return msg.reply({ embeds: [new EmbedBuilder()
      .setTitle("🎲 주술 소환 결과!")
      .setColor(GRADE_COLOR[ch.grade])
      .setDescription(`${ch.emoji} **${ch.name}** [${GRADE_EMOJI[ch.grade]} ${ch.grade}급]${isNew ? " ✨**NEW!**" : " (중복 +50💎)"}`)
      .addFields(
        { name: "설명", value: ch.desc, inline: false },
        { name: "🌌 영역전개", value: ch.domain || "없음", inline: true },
        { name: "🔥 시작 스킬", value: ch.skills[0].name, inline: true },
        { name: "💎 잔여", value: `${player.crystals}`, inline: true },
      )
      .setFooter({ text: "!캐릭터로 편성 | !스킬로 스킬 트리 확인" })
    ]});
  }

  if (content === "!가챠10") {
    if (player.crystals < 1350) return msg.reply(`💎 크리스탈 부족! (${player.crystals}/1350)`);
    player.crystals -= 1350;
    const results = rollGacha(10);
    const newOnes = [];
    let dupCrystals = 0;
    results.forEach(id => {
      if (!player.owned.includes(id)) { player.owned.push(id); if (!player.mastery[id]) player.mastery[id] = 0; newOnes.push(id); }
      else { dupCrystals += 50; player.crystals += 50; }
    });
    return msg.reply({ embeds: [new EmbedBuilder()
      .setTitle("🎲 주술 10회 소환 결과!")
      .setColor(0xF5C842)
      .setDescription(results.map(id => `${CHARACTERS[id].emoji} **${CHARACTERS[id].name}** [${CHARACTERS[id].grade}급]${newOnes.includes(id) ? " ✨NEW!" : ""}`).join("\n"))
      .addFields(
        { name: "✨ 신규", value: newOnes.length ? newOnes.map(id => CHARACTERS[id].name).join(", ") : "없음", inline: true },
        { name: "🔄 중복 보상", value: `+${dupCrystals}💎`, inline: true },
        { name: "💎 잔여", value: `${player.crystals}`, inline: true },
      )
    ]});
  }

  if (content === "!전투") {
    if (battles[msg.author.id]) return msg.reply("이미 전투 중! 버튼을 사용하세요.");
    if (player.hp <= 0) { player.hp = Math.round(CHARACTERS[player.active].maxHp * 0.5); return msg.reply("HP 0 → 절반 회복! 다시 `!전투` 입력하세요."); }
    return msg.reply({
      content: "⚔️ 상대할 적을 선택하세요:",
      components: [new ActionRowBuilder().addComponents(
        ...ENEMIES.map(e => new ButtonBuilder().setCustomId(`enemy_${e.id}`).setLabel(`${e.emoji} ${e.name}`).setStyle(ButtonStyle.Secondary))
      )],
    });
  }

  if (content.startsWith("!코드 ") || content.startsWith("!code ")) {
    const code = content.split(" ")[1]?.trim().toLowerCase();
    if (!code) return msg.reply("사용법: `!코드 코드입력`");
    if (!player.usedCodes) player.usedCodes = [];
    if (player.usedCodes.includes(code)) return msg.reply("❌ 이미 사용한 코드입니다!");
    if (!CODES[code]) return msg.reply("❌ 유효하지 않은 코드입니다!");
    const reward = CODES[code];
    player.crystals += reward.crystals || 0;
    player.usedCodes.push(code);
    return msg.reply({ embeds: [new EmbedBuilder()
      .setTitle("🎁 코드 보상!")
      .setColor(0xF5C842)
      .setDescription(`코드 **${code}** 사용 완료!\n💎 **+${reward.crystals}** 크리스탈 획득!`)
      .addFields({ name: "💎 현재 크리스탈", value: `${player.crystals}`, inline: true })
    ]});
  }

  if (content === "!dev" && isDev(msg.author.id)) {
    return msg.reply({ content: "👑 DEV PANEL", components: [devButtons()] });
  }
});

client.on("interactionCreate", async (i) => {
  if (!i.isButton() && !i.isStringSelectMenu()) return;
  const player = getPlayer(i.user.id, i.user.username);
  const battle = battles[i.user.id];

  if (i.isStringSelectMenu() && i.customId === "select_char") {
    const id = i.values[0];
    player.active = id;
    player.hp = CHARACTERS[id].maxHp;
    const ch = CHARACTERS[id];
    const skill = getCurrentSkill(player, id);
    return i.update({ content: `${ch.emoji} **${ch.name}** 편성 완료! HP 최대 회복.\n현재 스킬: **${skill.name}** (피해 ${skill.dmg})`, components: [] });
  }

  if (i.isButton() && i.customId.startsWith("enemy_")) {
    const enemyId = i.customId.replace("enemy_", "");
    const enemy = ENEMIES.find(e => e.id === enemyId);
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
          { name: `${ch.emoji} 내 HP`, value: `${hpBar(player.hp, ch.maxHp)} ${player.hp}/${ch.maxHp}`, inline: true },
          { name: `${enemy.emoji} 적 HP`, value: `${hpBar(enemy.hp, enemy.hp)} ${enemy.hp}/${enemy.hp}`, inline: true },
          { name: "🔥 현재 스킬", value: `${skill.name} — ${skill.desc}`, inline: false },
          { name: "🌌 영역전개", value: ch.domain || "없음", inline: true },
        )
        .setFooter({ text: "버튼으로 행동을 선택하세요!" })
      ],
      components: [battleButtons()],
    });
  }

  if (i.isButton() && i.customId.startsWith("dev_") && isDev(i.user.id)) {
    if (i.customId === "dev_heal") { player.hp = CHARACTERS[player.active].maxHp; return i.reply({ content: `DEV: HP 풀회복 (${player.hp})`, ephemeral: true }); }
    if (i.customId === "dev_xp") { player.xp += 1000; return i.reply({ content: `DEV: XP +1000 (합계 ${player.xp})`, ephemeral: true }); }
    if (i.customId === "dev_mastery") { player.owned.forEach(id => { player.mastery[id] = 30; }); return i.reply({ content: "DEV: 모든 캐릭터 숙련도 MAX", ephemeral: true }); }
    if (i.customId === "dev_crystal") { player.crystals += 9999; return i.reply({ content: `DEV: 💎 +9999 (합계 ${player.crystals})`, ephemeral: true }); }
    if (i.customId === "dev_kill" && battle) { battle.enemyHp = 0; return i.reply({ content: "DEV: 적 즉사", ephemeral: true }); }
    return i.reply({ content: "DEV 오류", ephemeral: true });
  }

  if (!i.isButton() || !i.customId.startsWith("b_")) return;
  if (!battle) return i.reply({ content: "전투 중이 아닙니다! `!전투`로 시작하세요.", ephemeral: true });

  const ch = CHARACTERS[player.active];
  const enemy = battle.enemy;
  const skill = getCurrentSkill(player, player.active);
  const log = [];

  if (i.customId === "b_attack") {
    const dmg = calcDmg(ch.atk, enemy.def, 1.0);
    battle.enemyHp -= dmg;
    log.push(`👊 **${ch.name}**의 공격! → **${enemy.name}**에게 **${dmg}** 피해!`);
  }
  else if (i.customId === "b_skill") {
    if (battle.skillUsed) return i.reply({ content: "술식은 전투당 1회!", ephemeral: true });
    const dmg = skill.dmg + Math.floor(Math.random() * 40);
    battle.enemyHp -= dmg;
    battle.skillUsed = true;
    log.push(`✨ **${skill.name}**! → **${enemy.name}**에게 **${dmg}** 피해!`);
  }
  else if (i.customId === "b_domain") {
    if (!ch.domain) return i.reply({ content: `${ch.name}은 영역전개가 없습니다!`, ephemeral: true });
    if (battle.domainUsed) return i.reply({ content: "영역전개는 전투당 1회!", ephemeral: true });
    const domainDmg = Math.floor(400 + ch.atk * 2 + getMastery(player, player.active) * 5);
    battle.enemyHp -= domainDmg;
    battle.domainUsed = true;
    log.push(`🌌 **${ch.domain}** 발동! → **${enemy.name}**에게 **${domainDmg}** 피해!`);
  }
  else if (i.customId === "b_reverse") {
    if (!REVERSE_CHARS.has(player.active)) return i.reply({ content: `❌ **${ch.name}**은 반전술식을 사용할 수 없습니다!`, ephemeral: true });
    const heal = Math.floor(80 * player.reverseOutput);
    player.hp = Math.min(ch.maxHp, player.hp + heal);
    player.reverseOutput = Math.min(3.0, player.reverseOutput + 0.2);
    log.push(`♻ 반전술식! HP **+${heal}** 회복 (출력 ${player.reverseOutput.toFixed(1)}배)`);
  }
  else if (i.customId === "b_run") {
    if (Math.random() < 0.6) {
      delete battles[i.user.id];
      return i.update({ content: "🏃 도주 성공!", embeds: [], components: [] });
    }
    log.push("❌ 도주 실패!");
  }

  if (battle.enemyHp > 0 && i.customId !== "b_reverse") {
    const enemyDmg = calcDmg(enemy.atk, ch.def);
    player.hp -= enemyDmg;
    log.push(`💥 **${enemy.name}**의 반격! → **${ch.name}**에게 **${enemyDmg}** 피해!`);
  }

  const playerDead = player.hp <= 0;
  const enemyDead = battle.enemyHp <= 0;

  if (enemyDead) {
    player.xp += enemy.xp;
    player.crystals += enemy.crystals;
    player.wins++;
    if (!player.mastery[player.active]) player.mastery[player.active] = 0;
    player.mastery[player.active] += enemy.masteryXp;
    const newSkill = getCurrentSkill(player, player.active);
    delete battles[i.user.id];
    log.push(`\n🏆 승리! +**${enemy.xp}** XP | +**${enemy.crystals}**💎 | 숙련도 **+${enemy.masteryXp}**`);
    log.push(`🔥 현재 스킬: **${newSkill.name}** (피해 ${newSkill.dmg})`);
  } else if (playerDead) {
    player.hp = 0;
    player.losses++;
    delete battles[i.user.id];
    log.push(`\n💀 패배... !전투로 재도전하세요.`);
  }

  const over = playerDead || enemyDead;
  return i.update({
    embeds: [new EmbedBuilder()
      .setTitle(`⚔️ ${ch.name} VS ${enemy.emoji} ${enemy.name}`)
      .setColor(playerDead ? 0xe63946 : enemyDead ? 0xF5C842 : 0x7c5cfc)
      .setDescription(log.join("\n"))
      .addFields(
        { name: `${ch.emoji} 내 HP`, value: `${hpBar(player.hp, ch.maxHp)} ${Math.max(0,player.hp)}/${ch.maxHp}`, inline: true },
        { name: `${enemy.emoji} 적 HP`, value: `${hpBar(battle.enemyHp, enemy.hp)} ${Math.max(0,battle.enemyHp)}/${enemy.hp}`, inline: true },
      )
      .setFooter({ text: over ? "전투 종료!" : `술식: ${skill.name} | 영역: ${ch.domain || "없음"}` })
    ],
    components: over ? [] : [battleButtons()],
  });
});

client.once("ready", () => {
  console.log(`✅ ${client.user.tag} 온라인!`);
  client.user.setActivity("주술회전 RPG | !도움", { type: 0 });
});

client.login(TOKEN);
