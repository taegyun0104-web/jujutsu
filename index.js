const {
  Client,
  GatewayIntentBits,
  EmbedBuilder
} = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

// ─────────────────────────────
// 캐릭터 데이터
// ─────────────────────────────
const CHAR = {
  gojo: {
    name: "고죠 사토루",
    grade: "S",
    maxHp: 2000,
    atk: 120,
    def: 100,
    energy: Infinity, // 🔥 무한 주력
    skills: [
      { name: "무한", req: 0, dmg: 1.2 },
      { name: "허식", req: 10, dmg: 1.8 },
      { name: "적", req: 30, dmg: 2.5 },
      { name: "무량공처", req: 60, dmg: 4.0 },
    ]
  },

  itadori: {
    name: "이타도리 유지",
    grade: "A",
    maxHp: 1200,
    atk: 90,
    def: 70,
    energy: 100,
    skills: [
      { name: "주먹", req: 0, dmg: 1 },
      { name: "흑섬", req: 15, dmg: 1.6 },
      { name: "연격", req: 35, dmg: 2.2 },
    ]
  },

  sukuna: {
    name: "스쿠나",
    grade: "S",
    maxHp: 2200,
    atk: 130,
    def: 90,
    energy: 120,
    skills: [
      { name: "참격", req: 0, dmg: 1.3 },
      { name: "해체", req: 20, dmg: 2.0 },
      { name: "영역전개", req: 60, dmg: 3.8 },
    ]
  }
};

// ─────────────────────────────
// 플레이어 DB
// ─────────────────────────────
const players = new Map();

function getPlayer(id) {
  if (!players.has(id)) {
    players.set(id, {
      hp: 1000,
      maxHp: 1000,
      energy: 100,
      char: "itadori",
      owned: ["itadori"],
      mastery: { itadori: 0 },
      crystals: 500
    });
  }
  return players.get(id);
}

// ─────────────────────────────
// 가챠
// ─────────────────────────────
function gacha() {
  const pool = ["itadori", "sukuna", "gojo"];
  return pool[Math.floor(Math.random() * pool.length)];
}

// ─────────────────────────────
// 숙련도 스킬
// ─────────────────────────────
function getSkill(charId, mastery) {
  const skills = CHAR[charId].skills;
  let current = skills[0];
  for (const s of skills) {
    if (mastery >= s.req) current = s;
  }
  return current;
}

// ─────────────────────────────
// 메시지
// ─────────────────────────────
client.on("messageCreate", (msg) => {
  if (msg.author.bot) return;

  const p = getPlayer(msg.author.id);
  const input = msg.content;

  // ───────── 프로필 ─────────
  if (input === "!프로필") {
    const c = CHAR[p.char];
    const skill = getSkill(p.char, p.mastery[p.char]);

    return msg.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle(`${c.name} 프로필`)
          .addFields(
            { name: "HP", value: `${p.hp}/${c.maxHp}` },
            { name: "주력", value: c.energy === Infinity ? "∞ (무한)" : `${p.energy}` },
            { name: "숙련도", value: `${p.mastery[p.char]}` },
            { name: "현재 스킬", value: skill.name }
          )
      ]
    });
  }

  // ───────── 가챠 ─────────
  if (input === "!가챠") {
    const result = gacha();

    if (!p.owned.includes(result)) {
      p.owned.push(result);
      p.mastery[result] = 0;
    }

    p.char = result;

    return msg.reply(`🎲 획득: ${CHAR[result].name}`);
  }

  // ───────── 숙련도 올리기 테스트 ─────────
  if (input === "!훈련") {
    p.mastery[p.char] = (p.mastery[p.char] || 0) + 10;
    return msg.reply(`🔥 숙련도 +10`);
  }

  // ───────── 공격 ─────────
  if (input === "!공격") {
    const c = CHAR[p.char];
    const mastery = p.mastery[p.char] || 0;
    const skill = getSkill(p.char, mastery);

    // 주력 소모 (고죠 제외)
    if (c.energy !== Infinity) {
      if (p.energy < 20) return msg.reply("❌ 주력 부족!");
      p.energy -= 20;
    }

    const dmg = Math.floor(c.atk * skill.dmg * (1 + mastery / 100));

    return msg.reply(
      `⚔️ ${c.name} 사용: ${skill.name}\n💥 데미지: ${dmg}\n⚡ 주력: ${c.energy === Infinity ? "∞" : p.energy}`
    );
  }

  // ───────── 주력 회복 ─────────
  if (input === "!회복") {
    const c = CHAR[p.char];

    if (c.energy === Infinity)
      return msg.reply("고죠는 주력이 무한이다.");

    p.energy = Math.min(100, p.energy + 40);
    return msg.reply(`💙 주력 회복 +40 (현재 ${p.energy})`);
  }
});

// ─────────────────────────────
// 시작
// ─────────────────────────────
client.once("ready", () => {
  console.log(`로그인 완료: ${client.user.tag}`);
});

client.login("MTQ5OTQ0OTM2MDM0MDA5NDk4Ng.GNcceq.jpyat_0O2KdsV5toeYyXOvVYcFkeit2wQbA7s8");
