const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

// ─────────────────────────────
// Railway 안정형 설정
// ─────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

// 🔥 크래시 방지 (Railway 필수)
process.on("unhandledRejection", console.error);
process.on("uncaughtException", console.error);

// ─────────────────────────────
// 캐릭터
// ─────────────────────────────
const CHAR = {
  itadori: {
    name: "이타도리",
    hp: 1200,
    atk: 90,
    def: 70,
    energy: 100,
    skills: [
      { name: "주먹", dmg: 1.0, req: 0 },
      { name: "흑섬", dmg: 1.6, req: 20 },
      { name: "연격", dmg: 2.2, req: 50 },
    ]
  },

  gojo: {
    name: "고죠",
    hp: 2000,
    atk: 120,
    def: 100,
    energy: Infinity, // 🔥 무한 주력
    skills: [
