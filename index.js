require("dotenv").config();

const express = require("express");
const app = express();
app.get("/", (req, res) => res.send("Bot Alive"));
app.listen(3000);

process.on("unhandledRejection", console.log);
process.on("uncaughtException", console.log);

if (!process.env.DISCORD_TOKEN) {
  console.log("❌ DISCORD_TOKEN 없음");
  process.exit(1);
}

// ─────────────────────────────
// DISCORD
// ─────────────────────────────
const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

// ─────────────────────────────
// SQLITE
// ─────────────────────────────
const Database = require("better-sqlite3");
const db = new Database("data.db");

db.prepare(`
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  char TEXT,
  hp INTEGER,
  crystals INTEGER,
  xp INTEGER DEFAULT 0,
  tool TEXT DEFAULT 'none'
)
`).run();

// ─────────────────────────────
// CLIENT
// ─────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ─────────────────────────────
// CHARACTER
// ─────────────────────────────
const CHAR = {
  itadori: { name: "이타도리", atk: 85, hp: 1200, reversal: false },
  gojo: { name: "고죠", atk: 120, hp: 2000, reversal: true },
  sukuna: { name: "스쿠나", atk: 130, hp: 2200, reversal: false },
};

// ─────────────────────────────
// TOOLS (주구)
// ─────────────────────────────
const TOOLS = {
  none: { name: "맨손", atk: 0 },
  katana: { name: "주술도", atk: 15 },
  spear: { name: "저주창", atk: 25 },
};

// ─────────────────────────────
// DUNGEON
// ─────────────────────────────
const DUNGEONS = {
  culling: { name: "컬링게임", xp: 120, crystal: 80 },
  shibuya: { name: "사멸회유", xp: 250, crystal: 150 },
};

// ─────────────────────────────
// PLAYER
// ─────────────────────────────
function getPlayer(id) {
  let p = db.prepare("SELECT * FROM players WHERE id=?").get(id);

  if (!p) {
    db.prepare(
      "INSERT INTO players (id, char, hp, crystals, xp, tool) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(id, "itadori", 1200, 500, 0, "none");

    p = db.prepare("SELECT * FROM players WHERE id=?").get(id);
  }

  return p;
}

function savePlayer(p) {
  db.prepare(
    "UPDATE players SET char=?, hp=?, crystals=?, xp=?, tool=? WHERE id=?"
  ).run(p.char, p.hp, p.crystals, p.xp, p.tool, p.id);
}

// ─────────────────────────────
// LEVEL + RANKING
// ─────────────────────────────
function getLevel(xp) {
  return Math.floor(xp / 200) + 1;
}

function getRanking() {
  return db.prepare(`
    SELECT id, xp FROM players
    ORDER BY xp DESC
    LIMIT 10
  `).all();
}

// ─────────────────────────────
// BLACK FLASH
// ─────────────────────────────
function calcDamage(char, atk, mult = 1) {
  let dmg = (atk + (TOOLS[getPlayer(char.id || "").tool] || TOOLS.none).atk) * mult;

  const blackFlash = Math.random() < 0.12;

  if (blackFlash) {
    dmg *= 2.5;
    return { dmg: Math.floor(dmg), blackFlash: true };
  }

  return { dmg: Math.floor(dmg), blackFlash: false };
}

// ─────────────────────────────
// TURN SYSTEM
// ─────────────────────────────
const battles = new Map();

// ─────────────────────────────
// MESSAGE
// ─────────────────────────────
client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;

  let p = getPlayer(msg.author.id);
  const char = CHAR[p.char];

  // ⚔️ 전투 시작
  if (msg.content === "!전투") {
    battles.set(msg.author.id, {
      enemy: { hp: 800, atk: 60 },
      skillCD: 0,
      turn: 1,
    });

    return msg.reply("⚔️ 턴제 전투 시작!");
  }

  // 🎲 가챠
  if (msg.content === "!가챠") {
    const pool = ["itadori", "gojo", "sukuna"];
    const r = pool[Math.floor(Math.random() * pool.length)];

    p.char = r;
    p.hp = CHAR[r].hp;

    savePlayer(p);

    return msg.reply(`🎲 ${CHAR[r].name} 획득!`);
  }

  // 🏆 랭킹
  if (msg.content === "!랭킹") {
    const data = getRanking();

    return msg.reply(
      data
        .map((u, i) => `${i + 1}. <@${u.id}> Lv.${getLevel(u.xp)} (${u.xp})`)
        .join("\n")
    );
  }

  // ⚔️ 던전
  if (msg.content === "!컬링게임") {
    const d = DUNGEONS.culling;
    const win = Math.random() > 0.4;

    if (win) {
      p.xp += d.xp;
      p.crystals += d.crystal;
    }

    savePlayer(p);

    return msg.reply(win ? "🏆 승리" : "💀 패배");
  }

  if (msg.content === "!사멸회유") {
    const d = DUNGEONS.shibuya;
    const win = Math.random() > 0.55;

    if (win) {
      p.xp += d.xp;
      p.crystals += d.crystal;
    }

    savePlayer(p);

    return msg.reply(win ? "🔥 돌파" : "☠️ 전멸");
  }

  // ─────────────────────────────
  // TURN ACTIONS
  // ─────────────────────────────
  const b = battles.get(msg.author.id);
  if (!b) return;

  const tool = TOOLS[p.tool];

  if (msg.content === "!공격") {
    const dmg = Math.floor(char.atk + tool.atk);
    b.enemy.hp -= dmg;

    b.skillCD--;
    b.turn++;

    return msg.reply(`👊 ${dmg} 피해 (턴 ${b.turn})`);
  }

  if (msg.content === "!술식") {
    if (b.skillCD > 0)
      return msg.reply(`❌ 쿨타임 ${b.skillCD}`);

    const dmg = Math.floor(char.atk * 2);

    b.enemy.hp -= dmg;
    b.skillCD = 3;

    return msg.reply(`✨ 술식 ${dmg}`);
  }

  if (msg.content === "!회복") {
    if (!char.reversal) return msg.reply("❌ 불가");

    p.hp += 200;
    return msg.reply("💚 회복");
  }

  if (msg.content === "!도주") {
    battles.delete(msg.author.id);
    return msg.reply("🏃 도주");
  }

  // 승리 체크
  if (b.enemy.hp <= 0) {
    p.xp += 100;
    p.crystals += 80;

    battles.delete(msg.author.id);
    savePlayer(p);

    return msg.reply("🏆 승리!");
  }
});

// ─────────────────────────────
// READY
// ─────────────────────────────
client.once("ready", () => {
  console.log(`✅ ONLINE ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);
