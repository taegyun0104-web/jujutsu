require("dotenv").config();

const fs = require("fs");
const express = require("express");
const app = express();
app.get("/", (_, res) => res.send("OK"));
app.listen(process.env.PORT || 3000);

// ─────────────────────
// SAFE GUARD (CRASH PREVENT)
// ─────────────────────
process.on("uncaughtException", (e) => console.log("ERR:", e));
process.on("unhandledRejection", (e) => console.log("PROMISE:", e));

// ─────────────────────
// DISCORD IMPORT
// ─────────────────────
const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

// ─────────────────────
// ⚠️ TOKEN SAFE CHECK (중복 실행 방지 핵심)
// ─────────────────────
const TOKEN = process.env.DISCORD_TOKEN;

if (!TOKEN) {
  console.log("❌ TOKEN 없음");
  process.exit(1);
}

let alreadyLoggedIn = false;

// ─────────────────────
// BOT
// ─────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ─────────────────────
// SAVE SYSTEM
// ─────────────────────
const SAVE_FILE = "./db.json";

function loadDB() {
  try {
    return JSON.parse(fs.readFileSync(SAVE_FILE));
  } catch {
    return { players: {} };
  }
}

function saveDB() {
  fs.writeFileSync(SAVE_FILE, JSON.stringify(DB, null, 2));
}

let DB = loadDB();
if (!DB.players) DB.players = {};

// ─────────────────────
// DEV
// ─────────────────────
const DEV_IDS = new Set(["1499743296023691395"]);
const isDev = (id) => DEV_IDS.has(id);

// ─────────────────────
// CHAR
// ─────────────────────
const CHARACTERS = {
  gojo: { name: "고죠", reversal: true, domain: "무량공처", skills: ["허식무라사키"] },
  sukuna: { name: "스쿠나", reversal: false, domain: "복마어주자", skills: ["참격"] },
  itadori: { name: "이타도리", reversal: false, domain: null, skills: ["돌진"] },
};

// ─────────────────────
// PLAYER
// ─────────────────────
function getPlayer(id) {
  if (!DB.players[id]) {
    DB.players[id] = {
      id,
      char: "itadori",
      hp: 1200,
      maxHp: 1200,
      xp: 0,

      party: ["itadori"],

      reversalOutput: 1,
      cursedTool: false,

      skillsCooldown: {},
      domainCooldown: 0,
      domainActive: false,
      domainPower: 0,
    };

    saveDB();
  }

  const p = DB.players[id];
  p.skillsCooldown ??= {};
  return p;
}

// ─────────────────────
// DAMAGE
// ─────────────────────
function dmg(a) {
  const bf = Math.random() < 0.1;
  return { d: bf ? a * 2.5 : a };
}

// ─────────────────────
// BUTTON UI
// ─────────────────────
function ui() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("attack").setLabel("⚔ 공격").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("skill").setLabel("🌀 술식").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("domain").setLabel("🌌 영역").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("run").setLabel("🏃 도주").setStyle(ButtonStyle.Secondary)
  );
}

// ─────────────────────
// MESSAGE
// ─────────────────────
client.on("messageCreate", async (msg) => {
  if (!msg || msg.author.bot) return;

  const p = getPlayer(msg.author.id);

  if (msg.content === "!전투") {
    return msg.reply({
      content: "⚔️ 전투 시작",
      components: [ui()],
    });
  }

  if (msg.content === "!랭킹") {
    const list = Object.values(DB.players)
      .sort((a, b) => b.xp - a.xp)
      .slice(0, 5);

    return msg.reply(list.map((u, i) => `${i + 1}. <@${u.id}> ${u.xp}`).join("\n"));
  }
});

// ─────────────────────
// BUTTON SYSTEM
// ─────────────────────
client.on("interactionCreate", async (i) => {
  if (!i.isButton()) return;

  const p = getPlayer(i.user.id);

  // ⚔ ATTACK
  if (i.customId === "attack") {
    const r = dmg(100);
    return i.reply(`⚔️ ${r.d}`);
  }

  // 🌀 SKILL
  if (i.customId === "skill") {
    const c = CHARACTERS[p.char];
    const skill = c.skills[Math.floor(Math.random() * c.skills.length)];

    if (p.skillsCooldown[skill] > Date.now()) {
      return i.reply("쿨타임");
    }

    p.skillsCooldown[skill] = Date.now() + 5000;

    return i.reply(`🌀 ${skill}`);
  }

  // 🌌 DOMAIN
  if (i.customId === "domain") {
    const c = CHARACTERS[p.char];
    if (!c.domain) return i.reply("❌ 없음");

    if (p.domainCooldown > Date.now()) return i.reply("쿨타임");

    p.domainCooldown = Date.now() + 20000;
    p.domainActive = true;
    p.domainPower = p.reversalOutput * 100;

    return i.reply(`🌌 ${c.domain}`);
  }

  // 🏃 RUN
  if (i.customId === "run") {
    return i.reply("🏃 도주 성공");
  }
});

// ─────────────────────
// LOGIN (CRASH FIX 핵심)
// ─────────────────────
if (!alreadyLoggedIn) {
  alreadyLoggedIn = true;

  client.login(TOKEN).then(() => {
    console.log("ONLINE:", client.user.tag);
  });
}
