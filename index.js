require("dotenv").config();

const express = require("express");
const app = express();

app.get("/", (_, res) => res.send("OK"));
app.listen(process.env.PORT || 3000);

// ───────── SAFE GLOBAL CRASH PREVENT ─────────
process.on("uncaughtException", console.log);
process.on("unhandledRejection", console.log);

const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

// ───────── BOT ─────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) process.exit(1);

// ───────── DEV IDS ─────────
const DEV_IDS = new Set([
  "1499743296023691395",
  "1397218266505678881"
]);

const isDev = (id) => DEV_IDS.has(id);

// ───────── DB ─────────
const DB = {
  players: {},
  battles: {},
};

// ───────── CHAR ─────────
const CHAR = {
  gojo: { name: "고죠", domain: "무량공처", skills: ["허식무라사키"] },
  sukuna: { name: "스쿠나", domain: "복마어주자", skills: ["참격"] },
  itadori: { name: "이타도리", domain: null, skills: ["돌진"] },
};

// ───────── PLAYER SAFE INIT ─────────
function getPlayer(id) {
  if (!DB.players[id]) {
    DB.players[id] = {
      id,
      char: "itadori",
      hp: 1200,
      xp: 0,
      cursedTool: false,
      reverseOutput: 1,
      skillMastery: { 돌진: 0 },
    };
  }

  const p = DB.players[id];

  // 🔒 안전 보정 (크래시 방지 핵심)
  p.skillMastery ??= {};
  p.hp ??= 1200;
  p.reverseOutput ??= 1;

  return p;
}

// ───────── DAMAGE ─────────
const dmg = (x) => Math.floor(x + Math.random() * 60);

// ───────── SKILL SYSTEM ─────────
function getSkills(p) {
  const base = CHAR[p.char]?.skills || ["돌진"];
  const m = p.skillMastery?.돌진 || 0;

  const extra = [];
  if (m >= 3) extra.push("고속돌진");
  if (m >= 5) extra.push("연속돌진");

  return [...base, ...extra];
}

// ───────── UI ─────────
function battleUI() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("attack").setLabel("⚔ 공격").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("skill").setLabel("🌀 술식").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("domain").setLabel("🌌 영역").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("reverse").setLabel("♻ 반전술식").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("run").setLabel("🏃 도주").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("devpanel").setLabel("👑 DEV").setStyle(ButtonStyle.Secondary)
  );
}

function devUI() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("dev_heal").setLabel("힐").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("dev_xp").setLabel("XP+").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("dev_kill").setLabel("즉사").setStyle(ButtonStyle.Danger)
  );
}

// ───────── MESSAGE ─────────
client.on("messageCreate", (msg) => {
  if (!msg || msg.author.bot) return;

  const p = getPlayer(msg.author.id);

  // ⚔ 전투 시작
  if (msg.content === "!전투") {
    DB.battles[msg.author.id] = { enemyHp: 1200 };
    return msg.reply({ content: "⚔️ 전투 시작", components: [battleUI()] });
  }

  // 👑 DEV PANEL
  if (msg.content === "!dev" && isDev(msg.author.id)) {
    return msg.reply({ content: "👑 DEV PANEL", components: [devUI()] });
  }
});

// ───────── BUTTON ─────────
client.on("interactionCreate", async (i) => {
  try {
    if (!i.isButton()) return;
    if (i.replied || i.deferred) return;

    const p = getPlayer(i.user.id);
    const battle = DB.battles[i.user.id];

    // ───── DEV ─────
    if (i.customId === "dev_heal" && isDev(i.user.id)) {
      p.hp = 1200;
      return i.reply({ content: "DEV HEAL", ephemeral: true });
    }

    if (i.customId === "dev_xp" && isDev(i.user.id)) {
      p.xp += 1000;
      return i.reply({ content: "XP +1000", ephemeral: true });
    }

    if (i.customId === "dev_kill" && isDev(i.user.id)) {
      if (battle) battle.enemyHp = 0;
      return i.reply({ content: "ENEMY DEAD", ephemeral: true });
    }

    if (!battle) {
      return i.reply({ content: "전투 없음", ephemeral: true });
    }

    const c = CHAR[p.char];

    // ⚔ ATTACK
    if (i.customId === "attack") {
      let d = dmg(100);
      if (p.cursedTool) d *= 1.3;

      battle.enemyHp -= d;

      return i.reply(`⚔️ -${Math.floor(d)}`);
    }

    // 🌀 SKILL
    if (i.customId === "skill") {
      const skills = getSkills(p);
      const skill = skills[Math.floor(Math.random() * skills.length)];

      let d = 120;
      if (skill === "허식무라사키") d = 300;
      if (skill === "고속돌진") d = 180;
      if (skill === "연속돌진") d = 240;

      battle.enemyHp -= d;

      p.skillMastery["돌진"] = (p.skillMastery["돌진"] || 0) + 1;

      return i.reply(`🌀 ${skill} -${d}`);
    }

    // 🌌 DOMAIN
    if (i.customId === "domain") {
      if (!c?.domain) return i.reply("❌ 없음");

      const power = p.hp + (p.skillMastery["돌진"] || 0) * 10;

      battle.enemyHp -= 400 + power * 0.2;

      return i.reply(`🌌 ${c.domain}`);
    }

    // ♻ REVERSE TECHNIQUE
    if (i.customId === "reverse") {
      const heal = 100 * (p.reverseOutput || 1);

      p.hp = Math.min(1200, (p.hp || 0) + heal);
      p.reverseOutput = (p.reverseOutput || 1) + 0.2;

      return i.reply(`♻ +${Math.floor(heal)} (출력 ${p.reverseOutput.toFixed(1)})`);
    }

    // 🏃 RUN
    if (i.customId === "run") {
      if (Math.random() < 0.7) {
        delete DB.battles[i.user.id];
        return i.reply("🏃 도주 성공");
      }
      return i.reply("❌ 실패");
    }

    // 👑 DEV PANEL OPEN
    if (i.customId === "devpanel" && isDev(i.user.id)) {
      return i.reply({ content: "DEV OPENED", components: [devUI()], ephemeral: true });
    }

  } catch (e) {
    console.log("INTERACTION ERROR:", e);
  }
});

// ───────── LOGIN ─────────
client.login(TOKEN);
