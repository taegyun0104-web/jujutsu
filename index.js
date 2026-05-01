require("dotenv").config();

const express = require("express");
const app = express();
app.get("/", (_, res) => res.send("OK"));
app.listen(process.env.PORT || 3000);

const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) process.exit(1);

// ───────── DB ─────────
const DB = {
  players: {},
  battles: {},
};

// ───────── CHAR ─────────
const CHAR = {
  gojo: {
    name: "고죠",
    domain: "무량공처",
    skills: ["허식무라사키", "무한"],
  },
  sukuna: {
    name: "스쿠나",
    domain: "복마어주자",
    skills: ["참격"],
  },
  itadori: {
    name: "이타도리",
    domain: null,
    skills: ["돌진"],
  },
};

// ───────── PLAYER ─────────
function getPlayer(id) {
  if (!DB.players[id]) {
    DB.players[id] = {
      id,
      char: "itadori",
      hp: 1200,
      xp: 0,

      cursedTool: false,

      // 🧠 숙련도
      skillMastery: {
        돌진: 0,
      },

      // ♻ 반전술식
      reverseOutput: 1,

      skillsCooldown: {},
    };
  }

  return DB.players[id];
}

// ───────── DAMAGE ─────────
const dmg = (x) => Math.floor(x + Math.random() * 60);

// ───────── SKILL SYSTEM ─────────
// 숙련도에 따라 새 술식 해금
function getUnlockedSkills(p) {
  const base = CHAR[p.char].skills;

  const mastery = p.skillMastery || {};

  const extra = [];

  // 예시 확장 시스템
  if ((mastery["돌진"] || 0) >= 3) extra.push("고속돌진");
  if ((mastery["돌진"] || 0) >= 5) extra.push("연속돌진");

  return [...base, ...extra];
}

// ───────── UI ─────────
function battleUI(p) {
  const skills = getUnlockedSkills(p);

  const skillLabel = skills.length
    ? `🌀 술식(${skills.length})`
    : "🌀 술식";

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("attack").setLabel("⚔ 공격").setStyle(ButtonStyle.Danger),

    new ButtonBuilder().setCustomId("skill").setLabel(skillLabel).setStyle(ButtonStyle.Primary),

    new ButtonBuilder().setCustomId("domain").setLabel("🌌 영역").setStyle(ButtonStyle.Success),

    new ButtonBuilder().setCustomId("reverse").setLabel("♻ 반전술식").setStyle(ButtonStyle.Secondary),

    new ButtonBuilder().setCustomId("run").setLabel("🏃 도주").setStyle(ButtonStyle.Secondary)
  );
}

// ───────── START BATTLE ─────────
client.on("messageCreate", (msg) => {
  if (!msg || msg.author.bot) return;

  const p = getPlayer(msg.author.id);

  if (msg.content === "!전투") {
    DB.battles[msg.author.id] = {
      enemyHp: 1200,
    };

    return msg.reply({
      content: "⚔️ 전투 시작",
      components: [battleUI(p)],
    });
  }
});

// ───────── BUTTON ─────────
client.on("interactionCreate", async (i) => {
  if (!i.isButton()) return;

  const p = getPlayer(i.user.id);
  const battle = DB.battles[i.user.id];

  if (!battle) return i.reply({ content: "전투 없음", ephemeral: true });

  const c = CHAR[p.char];

  // ⚔ 공격
  if (i.customId === "attack") {
    let d = dmg(100);

    // 숙련도 증가
    p.skillMastery["돌진"] = (p.skillMastery["돌진"] || 0) + 1;

    battle.enemyHp -= d;

    return i.reply(`⚔️ -${d}`);
  }

  // 🌀 술식 (숙련도 기반 확장 포함)
  if (i.customId === "skill") {
    const skills = getUnlockedSkills(p);
    const skill = skills[Math.floor(Math.random() * skills.length)];

    let d = 120;

    if (skill === "허식무라사키") d = 300;
    if (skill === "고속돌진") d = 180;
    if (skill === "연속돌진") d = 220;

    battle.enemyHp -= d;

    // 숙련도 상승
    p.skillMastery["돌진"] = (p.skillMastery["돌진"] || 0) + 1;

    return i.reply(`🌀 ${skill} -${d}`);
  }

  // 🌌 영역전개
  if (i.customId === "domain") {
    if (!c.domain) return i.reply("❌ 없음");

    const d = 400 + (p.skillMastery["돌진"] || 0) * 10;

    battle.enemyHp -= d;

    return i.reply(`🌌 ${c.domain} -${d}`);
  }

  // ♻ 반전술식 (회복 + 출력 증가)
  if (i.customId === "reverse") {
    const heal = 100 * p.reverseOutput;

    p.hp += heal;
    if (p.hp > 1200) p.hp = 1200;

    // 사용할수록 출력 증가
    p.reverseOutput += 0.2;

    return i.reply(`♻ 반전술식 +${Math.floor(heal)} (출력 ${p.reverseOutput.toFixed(1)})`);
  }

  // 🏃 도주
  if (i.customId === "run") {
    const ok = Math.random() < 0.7;

    if (ok) {
      delete DB.battles[i.user.id];
      return i.reply("🏃 도주 성공");
    }

    return i.reply("❌ 실패");
  }
});

// ───────── LOGIN ─────────
client.login(TOKEN);
