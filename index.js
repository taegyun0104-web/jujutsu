require("dotenv").config();

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

process.on("unhandledRejection", console.error);
process.on("uncaughtException", console.error);

// ─────────────────────────────
// DEV SYSTEM
// ─────────────────────────────
const DEV_ID = process.env.DEV_ID;
const isDev = (id) => id === DEV_ID;

// ─────────────────────────────
// CHARACTER
// ─────────────────────────────
const CHAR = {
  itadori: {
    name: "이타도리 유지",
    atk: 90,
    hp: 1200,
    reversal: false,
  },

  gojo: {
    name: "고죠 사토루",
    atk: 120,
    hp: 2000,
    reversal: true,
  },

  sukuna: {
    name: "료멘 스쿠나",
    atk: 130,
    hp: 2200,
    reversal: false,
  },
};

// ─────────────────────────────
// DB
// ─────────────────────────────
const players = new Map();
const battles = new Map();
const pvpBattles = new Map();

// ─────────────────────────────
// PLAYER
// ─────────────────────────────
function getPlayer(id) {
  if (!players.has(id)) {
    players.set(id, {
      char: "itadori",
      hp: 1200,
      owned: ["itadori"],
      crystals: 500,
    });
  }
  return players.get(id);
}

// ─────────────────────────────
// 🔥 DAMAGE SYSTEM (흑섬)
// ─────────────────────────────
function calcDamage(char, atk, mult = 1) {
  let dmg = atk * mult;

  // ⚡ 흑섬 확률
  const isBlackFlash = Math.random() < 0.12;

  if (isBlackFlash) {
    dmg *= 2.5;
    return {
      dmg: Math.floor(dmg),
      blackFlash: true,
    };
  }

  return {
    dmg: Math.floor(dmg),
    blackFlash: false,
  };
}

// ─────────────────────────────
// MESSAGE
// ─────────────────────────────
client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;

  const p = getPlayer(msg.author.id);

  // 🎲 가챠
  if (msg.content === "!가챠") {
    const pool = ["itadori", "gojo", "sukuna"];
    const r = pool[Math.floor(Math.random() * pool.length)];

    if (!p.owned.includes(r)) p.owned.push(r);
    p.char = r;

    return msg.reply(`🎲 ${CHAR[r].name} 획득!`);
  }

  // ⚔️ 전투 시작
  if (msg.content === "!전투") {
    const enemy = { hp: 800, atk: 60 };

    battles.set(msg.author.id, {
      enemy,
      eHp: enemy.hp,
    });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("atk").setLabel("공격").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("skill").setLabel("스킬").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("heal").setLabel("반전술식").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("run").setLabel("도주").setStyle(ButtonStyle.Secondary)
    );

    return msg.reply({ content: "⚔️ 전투 시작!", components: [row] });
  }

  // 🏃 도주
  if (msg.content === "!도주") {
    if (battles.has(msg.author.id)) {
      battles.delete(msg.author.id);
      return msg.reply("🏃 전투 도주!");
    }

    if (pvpBattles.has(msg.author.id)) {
      const battle = pvpBattles.get(msg.author.id);
      const enemy = battle.p1 === msg.author.id ? battle.p2 : battle.p1;

      pvpBattles.delete(battle.p1);
      pvpBattles.delete(battle.p2);

      return msg.reply("🏃 PvP 도주 (패배 처리)");
    }

    return msg.reply("❌ 전투 중 아님");
  }

  // ⚔️ PvP
  if (msg.content === "!pvp") {
    const id = msg.author.id;

    const battle = {
      p1: id,
      p2: "enemy",
      turn: id,
      hp: { [id]: 1000, enemy: 1000 },
    };

    pvpBattles.set(id, battle);

    return msg.reply("⚔️ PvP 시작!");
  }

  // ⚔️ PvP 액션
  if (["!공격", "!스킬", "!반전술식"].includes(msg.content)) {
    const battle = pvpBattles.get(msg.author.id);
    if (!battle) return;

    const char = CHAR[p.char];
    const enemyId = battle.p1 === msg.author.id ? battle.p2 : battle.p1;

    let result;

    if (msg.content === "!공격") {
      result = calcDamage(char, char.atk, 1);
      battle.hp[enemyId] -= result.dmg;
    }

    if (msg.content === "!스킬") {
      result = calcDamage(char, char.atk, 1.6);
      battle.hp[enemyId] -= result.dmg;
    }

    if (msg.content === "!반전술식") {
      if (!char.reversal)
        return msg.reply("❌ 반전술식 불가");

      battle.hp[msg.author.id] += 300;
      return msg.reply("💚 반전술식 +300");
    }

    if (result?.blackFlash) {
      return msg.reply(`⚡🔥 흑섬! ${result.dmg}`);
    }

    return msg.reply(`⚔️ ${result.dmg}`);
  }

  // 🛠 DEV
  if (msg.content === "!dev") {
    if (!isDev(msg.author.id)) return;
    return msg.reply("🛠 DEV ON");
  }
});

// ─────────────────────────────
// BUTTON
// ─────────────────────────────
client.on("interactionCreate", async (i) => {
  const p = getPlayer(i.user.id);
  const battle = battles.get(i.user.id);

  if (!battle) return;

  const char = CHAR[p.char];

  if (i.customId === "atk") {
    const r = calcDamage(char, char.atk);
    battle.eHp -= r.dmg;

    return i.reply(
      r.blackFlash
        ? `⚡🔥 흑섬 ${r.dmg}`
        : `👊 ${r.dmg}`
    );
  }

  if (i.customId === "skill") {
    const r = calcDamage(char, char.atk, 1.5);
    battle.eHp -= r.dmg;

    return i.reply(
      r.blackFlash
        ? `⚡🔥 흑섬 스킬 ${r.dmg}`
        : `✨ ${r.dmg}`
    );
  }

  if (i.customId === "heal") {
    if (!char.reversal)
      return i.reply("❌ 반전술식 불가");

    p.hp += 200;
    return i.reply("💚 반전술식 +200");
  }

  if (i.customId === "run") {
    battles.delete(i.user.id);
    return i.reply("🏃 도주");
  }
});

// ─────────────────────────────
// READY
// ─────────────────────────────
client.once("ready", () => {
  console.log(`✅ ONLINE ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);
