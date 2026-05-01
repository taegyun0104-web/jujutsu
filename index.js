require("dotenv").config();

const express = require("express");
const app = express();
app.get("/", (_, res) => res.send("OK"));
app.listen(process.env.PORT || 3000);

// ─────────────────────────
// SAFE MODE
// ─────────────────────────
process.on("unhandledRejection", console.log);
process.on("uncaughtException", console.log);

const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

// ─────────────────────────
// DEV
// ─────────────────────────
const DEV_IDS = new Set(["1499743296023691395"]);
const isDev = (id) => DEV_IDS.has(id);

// ─────────────────────────
// BOT
// ─────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

if (!process.env.DISCORD_TOKEN) {
  console.log("NO TOKEN");
  process.exit(1);
}

// ─────────────────────────
// CHARACTERS
// ─────────────────────────
const CHARACTERS = {
  gojo: {
    name: "고죠",
    reversal: true,
    domain: "무량공처",
    skills: ["순간이동", "허식무라사키", "무한방어"],
  },

  sukuna: {
    name: "스쿠나",
    reversal: false,
    domain: "복마어주자",
    skills: ["해체", "분해", "참격"],
  },

  itadori: {
    name: "이타도리",
    reversal: false,
    domain: null,
    skills: ["돌진", "연타"],
  },
};

// ─────────────────────────
// DB
// ─────────────────────────
const DB = {
  players: new Map(),
  battles: new Map(),
  pvp: new Map(),
  dungeon: new Map(),
};

// ─────────────────────────
// PLAYER
// ─────────────────────────
function getPlayer(id) {
  if (!DB.players.has(id)) {
    DB.players.set(id, {
      id,
      char: "itadori",
      hp: 1200,
      maxHp: 1200,
      xp: 0,
      crystals: 500,

      party: ["itadori"],

      reversalOutput: 1,
      cursedTool: false,

      skillsCooldown: {},
      domainCooldown: 0,
      domainActive: false,
      domainPower: 0,
    });
  }
  return DB.players.get(id);
}

// ─────────────────────────
// DAMAGE
// ─────────────────────────
function dmg(atk) {
  const blackFlash = Math.random() < 0.1;
  let d = atk;
  if (blackFlash) d *= 2.5;
  return { d: Math.floor(d), blackFlash };
}

// ─────────────────────────
// BUTTON UI
// ─────────────────────────
function battleUI() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("attack").setLabel("⚔ 공격").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("skill").setLabel("🌀 술식").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("domain").setLabel("🌌 영역").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("run").setLabel("🏃 도주").setStyle(ButtonStyle.Secondary)
  );
}

// ─────────────────────────
// MESSAGE
// ─────────────────────────
client.on("messageCreate", async (msg) => {
  try {
    if (!msg || msg.author.bot) return;

    const p = getPlayer(msg.author.id);

    // ───── DEV ─────
    if (msg.content === "!dev" && isDev(msg.author.id)) {
      return msg.reply("👑 DEV ON");
    }

    if (msg.content === "!dev heal" && isDev(msg.author.id)) {
      p.hp = p.maxHp;
      return msg.reply("FULL HEAL");
    }

    if (msg.content === "!dev xp" && isDev(msg.author.id)) {
      p.xp += 1000;
      return msg.reply("XP +1000");
    }

    // ───── RANK ─────
    if (msg.content === "!랭킹") {
      const list = [...DB.players.values()]
        .sort((a, b) => b.xp - a.xp)
        .slice(0, 5);

      return msg.reply(list.map((u, i) => `${i + 1}. <@${u.id}> ${u.xp}`).join("\n"));
    }

    // ───── CURSE TOOL ─────
    if (msg.content === "!주구") {
      p.cursedTool = true;
      return msg.reply("🧿 주구 장착");
    }

    // ───── DUNGEON ─────
    if (msg.content === "!컬링게임") {
      DB.dungeon.set(msg.author.id, { stage: 1, hp: 1000 });
      return msg.reply("🎮 컬링게임 시작");
    }

    // ───── BATTLE START ─────
    if (msg.content === "!전투") {
      DB.battles.set(msg.author.id, {
        enemy: { hp: 1200 },
        party: p.party,
        turn: 0,
      });

      return msg.reply({
        content: "⚔️ 전투 시작",
        components: [battleUI()],
      });
    }

    // ───── PVP ─────
    if (msg.content.startsWith("!pvp")) {
      const target = msg.mentions.users.first();
      if (!target) return msg.reply("멘션 필요");

      DB.pvp.set(msg.author.id, {
        enemy: target.id,
        hp: { [msg.author.id]: 1200, [target.id]: 1200 },
      });

      return msg.reply("⚔️ PvP 시작");
    }
  } catch (e) {
    console.log(e);
  }
});

// ─────────────────────────
// BUTTON SYSTEM
// ─────────────────────────
client.on("interactionCreate", async (i) => {
  if (!i.isButton()) return;

  const p = getPlayer(i.user.id);
  const b = DB.battles.get(i.user.id);
  const pv = DB.pvp.get(i.user.id);

  // ───── ATTACK ─────
  if (i.customId === "attack") {
    const r = dmg(100);
    if (b) {
      b.enemy.hp -= r.d;
      b.turn = (b.turn + 1) % b.party.length;
      return i.reply(`⚔️ ${r.d}`);
    }

    if (pv) {
      pv.hp[pv.enemy] -= r.d;
      return i.reply(`⚔️ PvP ${r.d}`);
    }
  }

  // ───── SKILL ─────
  if (i.customId === "skill") {
    const c = CHARACTERS[p.char];
    const skill = c.skills[Math.floor(Math.random() * c.skills.length)];

    if (p.skillsCooldown[skill] > Date.now()) {
      return i.reply("쿨타임");
    }

    p.skillsCooldown[skill] = Date.now() + 5000;

    let d = 120;
    if (skill === "허식무라사키") d = 300;

    return i.reply(`🌀 ${skill} ${d}`);
  }

  // ───── DOMAIN + CLASH ─────
  if (i.customId === "domain") {
    const c = CHARACTERS[p.char];
    if (!c.domain) return i.reply("❌ 없음");

    if (p.domainCooldown > Date.now()) {
      return i.reply("쿨타임");
    }

    p.domainCooldown = Date.now() + 20000;
    p.domainActive = true;
    p.domainPower = p.reversalOutput * 100;

    const enemyPvP = DB.pvp.get(i.user.id);

    if (enemyPvP) {
      const enemy = DB.players.get(enemyPvP.enemy);

      if (enemy?.domainActive) {
        const win = p.domainPower > enemy.domainPower;

        if (win) {
          enemy.hp -= 500;
          return i.reply("🌌 충돌 승리");
        } else {
          p.hp -= 500;
          return i.reply("💥 충돌 패배");
        }
      }
    }

    return i.reply(`🌌 ${c.domain}`);
  }

  // ───── RUN ─────
  if (i.customId === "run") {
    if (isDev(i.user.id)) {
      DB.battles.delete(i.user.id);
      return i.reply("DEV 도주");
    }

    const success = Math.random() < 0.7;

    if (success) {
      DB.battles.delete(i.user.id);
      return i.reply("🏃 도주 성공");
    } else {
      return i.reply("실패");
    }
  }
});

// ─────────────────────────
// READY
// ─────────────────────────
client.once("ready", () => {
  console.log("ONLINE", client.user.tag);
});

client.login(process.env.DISCORD_TOKEN);
