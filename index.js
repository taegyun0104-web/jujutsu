require("dotenv").config();

const express = require("express");
const app = express();
app.get("/", (_, res) => res.send("OK"));
app.listen(process.env.PORT || 3000);

process.on("unhandledRejection", console.log);
process.on("uncaughtException", console.log);

if (!process.env.DISCORD_TOKEN) {
  console.log("❌ TOKEN 없음");
  process.exit(1);
}

// ─────────────────────────────
// DISCORD
// ─────────────────────────────
const {
  Client,
  GatewayIntentBits,
} = require("discord.js");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ─────────────────────────────
// MEMORY DB (Railway safe)
// ─────────────────────────────
const players = new Map();
const battles = new Map();

// ─────────────────────────────
// CHAR
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
  none: { atk: 0 },
  katana: { atk: 15 },
  spear: { atk: 25 },
};

// ─────────────────────────────
// DUNGEON
// ─────────────────────────────
const DUNGEON = {
  culling: { name: "컬링게임", xp: 120, crystal: 80 },
  shibuya: { name: "사멸회유", xp: 250, crystal: 150 },
};

// ─────────────────────────────
// PLAYER SAFE
// ─────────────────────────────
function getPlayer(id) {
  if (!players.has(id)) {
    players.set(id, {
      id,
      char: "itadori",
      hp: 1200,
      crystals: 500,
      xp: 0,
      tool: "none",
    });
  }
  return players.get(id);
}

function savePlayer(p) {
  if (!p?.id) return;
  players.set(p.id, p);
}

// ─────────────────────────────
// LEVEL + RANK
// ─────────────────────────────
function getLevel(xp) {
  return Math.floor(xp / 200) + 1;
}

function getRanking() {
  return [...players.values()]
    .sort((a, b) => (b.xp || 0) - (a.xp || 0))
    .slice(0, 10);
}

// ─────────────────────────────
// DAMAGE (흑섬 포함)
// ─────────────────────────────
function calcDamage(atk, toolAtk = 0, mult = 1) {
  let dmg = (atk + toolAtk) * mult;

  const blackFlash = Math.random() < 0.1;

  if (blackFlash) {
    dmg *= 2.5;
    return { dmg: Math.floor(dmg), blackFlash: true };
  }

  return { dmg: Math.floor(dmg), blackFlash: false };
}

// ─────────────────────────────
// MESSAGE
// ─────────────────────────────
client.on("messageCreate", async (msg) => {
  try {
    if (msg.author.bot) return;

    const p = getPlayer(msg.author.id);
    const char = CHAR[p.char];
    const tool = TOOLS[p.tool] || TOOLS.none;

    // ⚔️ 전투 시작
    if (msg.content === "!전투") {
      battles.set(msg.author.id, {
        enemy: { hp: 800 },
        cd: 0,
      });

      return msg.reply("⚔️ 전투 시작!");
    }

    const b = battles.get(msg.author.id);

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
      const rank = getRanking();

      return msg.reply(
        rank
          .map((u, i) => `${i + 1}. <@${u.id}> Lv.${getLevel(u.xp)} (${u.xp})`)
          .join("\n")
      );
    }

    // ⚔️ 던전
    if (msg.content === "!컬링게임") {
      const d = DUNGEON.culling;
      const win = Math.random() > 0.4;

      if (win) {
        p.xp += d.xp;
        p.crystals += d.crystal;
      }

      savePlayer(p);

      return msg.reply(win ? "🏆 승리" : "💀 패배");
    }

    if (msg.content === "!사멸회유") {
      const d = DUNGEON.shibuya;
      const win = Math.random() > 0.55;

      if (win) {
        p.xp += d.xp;
        p.crystals += d.crystal;
      }

      savePlayer(p);

      return msg.reply(win ? "🔥 돌파" : "☠️ 전멸");
    }

    // ─────────────────────────────
    // TURN SYSTEM (SAFE)
    // ─────────────────────────────
    if (!b) return;

    if (msg.content === "!공격") {
      const r = calcDamage(char.atk, tool.atk);

      b.enemy.hp -= r.dmg;
      b.cd--;

      return msg.reply(r.blackFlash ? `⚡ 흑섬 ${r.dmg}` : `👊 ${r.dmg}`);
    }

    if (msg.content === "!술식") {
      if (b.cd > 0) return msg.reply(`쿨타임 ${b.cd}`);

      const r = calcDamage(char.atk, tool.atk, 2);

      b.enemy.hp -= r.dmg;
      b.cd = 3;

      return msg.reply(`✨ ${r.dmg}`);
    }

    if (msg.content === "!회복") {
      if (!char.reversal) return msg.reply("불가");

      p.hp += 200;
      savePlayer(p);

      return msg.reply("💚 +200");
    }

    if (msg.content === "!도주") {
      battles.delete(msg.author.id);
      return msg.reply("🏃 도주");
    }

    // 🏆 승리 체크
    if (b.enemy.hp <= 0) {
      p.xp += 100;
      p.crystals += 80;

      battles.delete(msg.author.id);
      savePlayer(p);

      return msg.reply("🏆 승리!");
    }
  } catch (err) {
    console.log("ERROR SAFE:", err);
  }
});

// ─────────────────────────────
// READY
// ─────────────────────────────
client.once("ready", () => {
  console.log(`✅ ONLINE ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);
