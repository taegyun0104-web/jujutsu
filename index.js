require("dotenv").config();

const express = require("express");
const app = express();
app.get("/", (_, res) => res.send("Bot Alive"));
app.listen(3000);

process.on("unhandledRejection", console.log);
process.on("uncaughtException", console.log);

// ─────────────────────────────
// DISCORD
// ─────────────────────────────
const {
  Client,
  GatewayIntentBits,
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
// DATA
// ─────────────────────────────
const CHAR = {
  itadori: { name: "이타도리", atk: 85, hp: 1200, reversal: false },
  gojo: { name: "고죠", atk: 120, hp: 2000, reversal: true },
  sukuna: { name: "스쿠나", atk: 130, hp: 2200, reversal: false },
};

const TOOLS = {
  none: { atk: 0 },
  katana: { atk: 15 },
  spear: { atk: 25 },
};

const battles = new Map();

// ─────────────────────────────
// SAFE PLAYER
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
  if (!p?.id) return;

  db.prepare(`
    UPDATE players
    SET char=?, hp=?, crystals=?, xp=?, tool=?
    WHERE id=?
  `).run(p.char, p.hp, p.crystals, p.xp, p.tool, p.id);
}

// ─────────────────────────────
// SAFE DAMAGE (CRASH FIX 핵심)
// ─────────────────────────────
function calcDamage(char, atk, toolAtk = 0, mult = 1) {
  try {
    let dmg = (atk + (toolAtk || 0)) * mult;

    const blackFlash = Math.random() < 0.12;

    if (blackFlash) {
      dmg *= 2.5;
      return { dmg: Math.floor(dmg), blackFlash: true };
    }

    return { dmg: Math.floor(dmg), blackFlash: false };
  } catch (e) {
    console.log("damage error:", e);
    return { dmg: 1, blackFlash: false };
  }
}

// ─────────────────────────────
// MESSAGE
// ─────────────────────────────
client.on("messageCreate", async (msg) => {
  try {
    if (msg.author.bot) return;

    let p = getPlayer(msg.author.id);
    const char = CHAR[p.char];
    const tool = TOOLS[p.tool] || TOOLS.none;

    // ⚔️ 전투 시작
    if (msg.content === "!전투") {
      battles.set(msg.author.id, {
        enemy: { hp: 800 },
        cd: 0,
        turn: 1,
      });

      return msg.reply("⚔️ 전투 시작!");
    }

    const b = battles.get(msg.author.id);

    // 🎯 전투 없으면 여기서 종료 (CRASH 방지 핵심)
    if (!b) return;

    // 👊 공격
    if (msg.content === "!공격") {
      const r = calcDamage(char, char.atk, tool.atk);

      b.enemy.hp -= r.dmg;
      b.cd--;

      b.turn++;

      return msg.reply(
        r.blackFlash ? `⚡ 흑섬 ${r.dmg}` : `👊 ${r.dmg}`
      );
    }

    // ✨ 술식
    if (msg.content === "!술식") {
      if (b.cd > 0) return msg.reply(`쿨타임 ${b.cd}`);

      const r = calcDamage(char, char.atk, tool.atk, 2);

      b.enemy.hp -= r.dmg;
      b.cd = 3;

      return msg.reply(`✨ ${r.dmg}`);
    }

    // 💚 회복
    if (msg.content === "!회복") {
      if (!char.reversal) return msg.reply("불가");

      p.hp = (p.hp || char.hp) + 200;
      savePlayer(p);

      return msg.reply("💚 +200");
    }

    // 🏃 도주
    if (msg.content === "!도주") {
      battles.delete(msg.author.id);
      return msg.reply("도주 완료");
    }

    // 🏆 승리 체크 (NULL 방지)
    if (b?.enemy?.hp <= 0) {
      p.xp += 100;
      p.crystals += 80;

      battles.delete(msg.author.id);
      savePlayer(p);

      return msg.reply("승리!");
    }
  } catch (err) {
    console.log("MESSAGE ERROR:", err);
  }
});

// ─────────────────────────────
// READY
// ─────────────────────────────
client.once("ready", () => {
  console.log("✅ ONLINE");
});

client.login(process.env.DISCORD_TOKEN);
