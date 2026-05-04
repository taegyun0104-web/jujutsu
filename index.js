liam933701
liam9337.
🗝️

liam933701 [마법사],  — 어제 오후 11:50
컴터로만 해서
LEPIGI — 어제 오후 11:50
컴터로ㄱ
liam933701 [마법사],  — 어제 오후 11:56
찾은
LEPIGI — 어제 오후 11:56
💀
LEPIGI — 오전 12:00
https://open.kakao.com/o/sFt16Wqh
LEPIGI님의 오픈프로필
lepigi better then lephigi
이미지
liam933701 [마법사],  — 오전 11:20
봇 계속 터지는데
help
😭
LEPIGI — 오전 11:24
gay
gimme log
liam933701 [마법사],  — 오전 11:28
Starting Container
npm warn config production Use `--omit=dev` instead.
> jjk-rpg-bot@2.1.0 start
> node index.js
TOKEN CHECK: undefined
🌐 HTTP 포트 8080

message.txt
5KB
이거 아니면 스크립트 주시면 고쳐달라 하실수 있나 클로드에게
좀 많이 걸리긴하는데🤔
LEPIGI — 오전 11:29
토큰이
없어서그럼
liam933701 [마법사],  — 오전 11:29
토큰 저거
재설해도 저러던데
LEPIGI — 오전 11:29
토큰을 코드에
넣어야지
liam933701 [마법사],  — 오전 11:29
그러면 그거
디코에서 토큰 왜 올리냐고
문자오던데
LEPIGI — 오전 11:29
코드에 넣으라고
liam933701 [마법사],  — 오전 11:29
음 넨
LEPIGI — 오전 11:29
🥀
liam933701 [마법사],  — 오전 11:31
토큰 강제 초기화된
😭
LEPIGI — 오전 11:31
아무튼 토큰을
안넣어서
작동을 안하는거
liam933701 [마법사],  — 오전 11:32
근데 전에는
그 토큰 로드하는식으로 됬었는데
LEPIGI — 오전 11:32
그땐 토큰이있었겠지
liam933701 [마법사],  — 오전 11:32
갑자기 왜 이렇대
쌰갈 또 초기화가
🥀
LEPIGI — 오전 11:39
:wiltskull:
liam933701 [마법사],  — 오전 11:39
그냥 클로드 무료 쿨탐 돌면
고쳐야겠는
😭
LEPIGI — 오전 11:41
음
고친?
게있는데
카톡됨?
liam933701 [마법사],  — 오전 11:42
저 카톡 못하는😭
학교 컴터라
LEPIGI — 오전 11:42
음ㄱㄷ
liam933701 [마법사],  — 오전 11:42
지금 딥시크로 시도해보는중
넨
LEPIGI — 오전 11:42
문서 어케 하지
liam933701 [마법사],  — 오전 11:42
음
그 구글 독스 같은거 만들어서
시트나
보내주셔요 링크
LEPIGI — 오전 11:43
require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const {
Client, GatewayIntentBits, EmbedBuilder,
ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
} = require("discord.js");

// ════════════════════════════════════════════════════════
// ── HTTP 헬스체크 (Railway)
// ════════════════════════════════════════════════════════
const app = express();
app.get("/", (, res) => res.send("🔱 주술회전 RPG 봇 가동 중"));
app.get("/health", (, res) => res.json({ status: "ok", uptime: process.uptime() }));
app.listen(process.env.PORT || 3000, () => console.log(🌐 HTTP 포트 ${process.env.PORT || 3000}`));

// ════════════════════════════════════════════════════════
// ── PostgreSQL 연결
// ════════════════════════════════════════════════════════
const pool = new Pool({
connectionString: process.env.DATABASE_URL,
ssl: process.env.DATABASE_URL?.includes("railway") ? { rejectUnauthorized: false } : false,
max: 10,
idleTimeoutMillis: 30000,
connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => console.error("PostgreSQL 풀 오류:", err.message));

async function dbInit() {
await pool.query(CREATE TABLE IF NOT EXISTS players ( user_id TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW() ));
console.log("✅ PostgreSQL 테이블 준비 완료");
}

async function dbLoad() {
const res = await pool.query("SELECT user_id, data FROM players");
const obj = {};
for (const row of res.rows) obj[row.user_id] = row.data;
console.log(✅ DB 로드:${res.rows.length}명`);
return obj;
}

const saveQueue = new Map();
const savePending = new Set();

async function dbSave(userId, data) {
const client = await pool.connect();
try {
await client.query(
INSERT INTO players(user_id, data, updated_at) VALUES($1,$2,NOW()) ON CONFLICT(user_id) DO UPDATE SET data=$2, updated_at=NOW()`,
[userId, JSON.stringify(data)]
);
} finally {
client.release();
}
}

function savePlayer(userId) {
if (!players[userId]) return;
if (saveQueue.has(userId)) clearTimeout(saveQueue.get(userId));
const timer = setTimeout(async () => {
saveQueue.delete(userId);
if (savePending.has(userId)) { savePlayer(userId); return; }
savePending.add(userId);
try {
await dbSave(userId, players[userId]);
} catch (e) {
console.error(DB 저장 오류 [${userId}]:`, e.message);
setTimeout(() => savePlayer(userId), 5000);
} finally {
savePending.delete(userId);
}
}, 300);
saveQueue.set(userId, timer);
}

async function savePlayerNow(userId) {
if (!players[userId]) return;
if (saveQueue.has(userId)) { clearTimeout(saveQueue.get(userId)); saveQueue.delete(userId); }
savePending.add(userId);
try {
await dbSave(userId, players[userId]);
} catch (e) {
console.error(즉시 저장 오류 [${userId}]:`, e.message);
setTimeout(() => savePlayer(userId), 3000);
} finally {
savePending.delete(userId);
}
}

setInterval(async () => {
const uids = Object.keys(players);
for (const uid of uids) {
if (!saveQueue.has(uid) && !savePending.has(uid)) {
try { await dbSave(uid, players[uid]); }
catch(e) { console.error(주기저장 오류 [${uid}]:`, e.message); }
}
}
}, 3 * 60 * 1000);
... (102KB 남음)

Notes_260504_134307.txt
152KB
이거 해보고 로그좀
liam933701 [마법사],  — 오전 11:43
끊어진거같은데
넨
﻿
dasil
LEPIGI
lepigi
pigㅣpigi
 
https://discord.gg/3XF5yzykS
florr.io 친목 서버
require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const {
Client, GatewayIntentBits, EmbedBuilder,
ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
} = require("discord.js");

// ════════════════════════════════════════════════════════
// ── HTTP 헬스체크 (Railway)
// ════════════════════════════════════════════════════════
const app = express();
app.get("/", (, res) => res.send("🔱 주술회전 RPG 봇 가동 중"));
app.get("/health", (, res) => res.json({ status: "ok", uptime: process.uptime() }));
app.listen(process.env.PORT || 3000, () => console.log(🌐 HTTP 포트 ${process.env.PORT || 3000}`));

// ════════════════════════════════════════════════════════
// ── PostgreSQL 연결
// ════════════════════════════════════════════════════════
const pool = new Pool({
connectionString: process.env.DATABASE_URL,
ssl: process.env.DATABASE_URL?.includes("railway") ? { rejectUnauthorized: false } : false,
max: 10,
idleTimeoutMillis: 30000,
connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => console.error("PostgreSQL 풀 오류:", err.message));

async function dbInit() {
await pool.query(CREATE TABLE IF NOT EXISTS players ( user_id TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW() ));
console.log("✅ PostgreSQL 테이블 준비 완료");
}

async function dbLoad() {
const res = await pool.query("SELECT user_id, data FROM players");
const obj = {};
for (const row of res.rows) obj[row.user_id] = row.data;
console.log(✅ DB 로드:${res.rows.length}명`);
return obj;
}

const saveQueue = new Map();
const savePending = new Set();

async function dbSave(userId, data) {
const client = await pool.connect();
try {
await client.query(
INSERT INTO players(user_id, data, updated_at) VALUES($1,$2,NOW()) ON CONFLICT(user_id) DO UPDATE SET data=$2, updated_at=NOW()`,
[userId, JSON.stringify(data)]
);
} finally {
client.release();
}
}

function savePlayer(userId) {
if (!players[userId]) return;
if (saveQueue.has(userId)) clearTimeout(saveQueue.get(userId));
const timer = setTimeout(async () => {
saveQueue.delete(userId);
if (savePending.has(userId)) { savePlayer(userId); return; }
savePending.add(userId);
try {
await dbSave(userId, players[userId]);
} catch (e) {
console.error(DB 저장 오류 [${userId}]:`, e.message);
setTimeout(() => savePlayer(userId), 5000);
} finally {
savePending.delete(userId);
}
}, 300);
saveQueue.set(userId, timer);
}

async function savePlayerNow(userId) {
if (!players[userId]) return;
if (saveQueue.has(userId)) { clearTimeout(saveQueue.get(userId)); saveQueue.delete(userId); }
savePending.add(userId);
try {
await dbSave(userId, players[userId]);
} catch (e) {
console.error(즉시 저장 오류 [${userId}]:`, e.message);
setTimeout(() => savePlayer(userId), 3000);
} finally {
savePending.delete(userId);
}
}

setInterval(async () => {
const uids = Object.keys(players);
for (const uid of uids) {
if (!saveQueue.has(uid) && !savePending.has(uid)) {
try { await dbSave(uid, players[uid]); }
catch(e) { console.error(주기저장 오류 [${uid}]:`, e.message); }
}
}
}, 3 * 60 * 1000);

// ════════════════════════════════════════════════════════
// ── Discord 클라이언트
// ════════════════════════════════════════════════════════
const client = new Client({
intents: [
GatewayIntentBits.Guilds,
GatewayIntentBits.GuildMessages,
GatewayIntentBits.MessageContent,
 ],
});
const TOKEN = process.env.TOKEN;
if (!TOKEN) { console.error("❌ DISCORD_TOKEN 없음!"); process.exit(1); }

const DEV_IDS = new Set(["1284771557633425470", "1397218266505678881"]);
const isDev = (id) => DEV_IDS.has(id);

// ════════════════════════════════════════════════════════
// ── 등급/색상 데이터
// ════════════════════════════════════════════════════════
const JJK_GRADE_COLOR = {
"특급": 0xF5C842, "준특급": 0xff8c00,
"1급": 0x7C5CFC, "준1급": 0x9b72cf,
"2급": 0x4ade80, "3급": 0x94a3b8, "4급": 0x64748b,
};
const JJK_GRADE_EMOJI = {
"특급": "🔱", "준특급": "💠",
"1급": "⭐⭐", "준1급": "⭐",
"2급": "🔹🔹", "3급": "🔹", "4급": "◽",
};
const JJK_GRADE_LABEL = {
"특급": "【 특 급 】", "준특급": "【준특급】",
"1급": "【 1 급 】", "준1급": "【준 1급】",
"2급": "【 2 급 】", "3급": "【 3 급 】", "4급": "【 4 급 】",
};

// ════════════════════════════════════════════════════════
// ── 상태이상
// ════════════════════════════════════════════════════════
const STATUS_EFFECTS = {
poison: { id: "poison", name: "독", emoji: "☠️", desc: "매 턴 최대HP의 5% 피해", duration: 3 },
burn: { id: "burn", name: "화상", emoji: "🔥", desc: "매 턴 최대HP의 8% 피해", duration: 2 },
freeze: { id: "freeze", name: "빙결", emoji: "❄️", desc: "1턴 행동 불가", duration: 1 },
weaken: { id: "weaken", name: "약화", emoji: "💔", desc: "공격력 30% 감소", duration: 2 },
stun: { id: "stun", name: "기절", emoji: "⚡", desc: "1턴 행동 불가", duration: 1 },
battleInstinct: { id: "battleInstinct", name: "전투본능", emoji: "🔥💪", desc: "공격력 40% 증가, 회피율 25% 증가", duration: 3 },
};

function applyStatus(target, statusId) {
if (!target.statusEffects) target.statusEffects = [];
const existing = target.statusEffects.find(s => s.id === statusId);
if (existing) existing.turns = STATUS_EFFECTS[statusId].duration;
else target.statusEffects.push({ id: statusId, turns: STATUS_EFFECTS[statusId].duration });
}

function tickStatus(target, maxHp) {
if (!target.statusEffects || target.statusEffects.length === 0) return { dmg: 0, expired: [], log: [] };
let totalDmg = 0;
const expired = [], log = [];
for (const se of target.statusEffects) {
const def = STATUS_EFFECTS[se.id];
if (!def) { se.turns = 0; continue; }
if (se.id === "poison") { const d = Math.max(1, Math.floor(maxHp * 0.05)); totalDmg += d; log.push(${def.emoji} ${def.name}** — **${d} 피해!); } if (se.id === "burn") { const d = Math.max(1, Math.floor(maxHp * 0.08)); totalDmg += d; log.push(``${def.emoji} **${def.name}** — **${d}** 피해!); }
se.turns--;
if (se.turns <= 0) expired.push(se.id);
}
target.statusEffects = target.statusEffects.filter(s => s.turns > 0);
if (totalDmg > 0) target.hp = Math.max(0, target.hp - totalDmg);
return { dmg: totalDmg, expired, log };
}

function statusStr(se) {
if (!se || se.length === 0) return "없음";
return se.map(s => ${STATUS_EFFECTS[s.id]?.emoji || ""}${STATUS_EFFECTS[s.id]?.name || s.id}(${s.turns}턴)`).join(" ");
}
function isIncapacitated(se) { return !!(se && se.some(s => s.id === "freeze" || s.id === "stun")); }
function getWeakenMult(se) {
let mult = 1;
if (se && se.some(s => s.id === "weaken")) mult *= 0.7;
if (se && se.some(s => s.id === "battleInstinct")) mult *= 1.4;
return mult;
}
function getBattleInstinctEvade(se) { return !!(se && se.some(s => s.id === "battleInstinct")); }

function rollHit(defenderStatusEffects) {
const baseEvade = 0.05;
const instinctBonus = getBattleInstinctEvade(defenderStatusEffects) ? 0.25 : 0;
return Math.random() > (baseEvade + instinctBonus);
}

// ════════════════════════════════════════════════════════
// ── 스쿠나 손가락 시스템
// ════════════════════════════════════════════════════════
const SUKUNA_FINGER_MAX = 20;
function getFingerBonus(fingers) {
return {
atkBonus: Math.floor(fingers * 10),
defBonus: Math.floor(fingers * 6),
hpBonus: fingers * 200,
label: fingers >= 20 ? "🔴 스쿠나 완전 각성" :
fingers >= 15 ? "🔴 스쿠나 각성 Lv.4" :
fingers >= 10 ? "🟠 스쿠나 각성 Lv.3" :
fingers >= 5 ? "🟡 스쿠나 각성 Lv.2" :
fingers >= 1 ? "🟢 스쿠나 각성 Lv.1" : "스쿠나 봉인 중",
};
}

// ════════════════════════════════════════════════════════
// ── 코가네(황금 개) 펫 시스템
// ════════════════════════════════════════════════════════
const KOGANE_GRADES = {
"전설": { color: 0xF5C842, emoji: "🌟", stars: "★★★★★", rate: 0.5,
atkBonus: 0.25, defBonus: 0.20, hpBonus: 0.20, xpBonus: 0.30, crystalBonus: 0.25,
skill: "황금 포효", skillDesc: "전투 시작 시 적에게 추가 피해 (ATK의 50%)", skillChance: 0.35,
passiveDesc: "ATK+25% DEF+20% HP+20% XP+30% 크리스탈+25%",
},
"특급": { color: 0xff8c00, emoji: "🔶", stars: "★★★★☆", rate: 2.0,
atkBonus: 0.18, defBonus: 0.15, hpBonus: 0.15, xpBonus: 0.20, crystalBonus: 0.18,
skill: "황금 이빨", skillDesc: "공격 시 15% 확률로 약화 부여", skillChance: 0.15,
passiveDesc: "ATK+18% DEF+15% HP+15% XP+20% 크리스탈+18%",
},
"1급": { color: 0x7C5CFC, emoji: "🔷", stars: "★★★☆☆", rate: 8.0,
atkBonus: 0.12, defBonus: 0.10, hpBonus: 0.10, xpBonus: 0.12, crystalBonus: 0.10,
skill: "황금 발톱", skillDesc: "공격 시 10% 확률로 추가타 (ATK의 30%)", skillChance: 0.10,
passiveDesc: "ATK+12% DEF+10% HP+10% XP+12% 크리스탈+10%",
},
"2급": { color: 0x4ade80, emoji: "🟢", stars: "★★☆☆☆", rate: 22.5,
atkBonus: 0.07, defBonus: 0.06, hpBonus: 0.06, xpBonus: 0.07, crystalBonus: 0.06,
skill: "황금 보호막", skillDesc: "HP 30% 이하 시 1회 피해 50% 감소", skillChance: 1.0,
passiveDesc: "ATK+7% DEF+6% HP+6% XP+7% 크리스탈+6%",
},
"3급": { color: 0x94a3b8, emoji: "⚪", stars: "★☆☆☆☆", rate: 67.0,
atkBonus: 0.03, defBonus: 0.02, hpBonus: 0.02, xpBonus: 0.03, crystalBonus: 0.02,
skill: "황금 냄새", skillDesc: "전투 후 크리스탈 +5% 추가 획득", skillChance: 1.0,
passiveDesc: "ATK+3% DEF+2% HP+2% XP+3% 크리스탈+2%",
},
};

const KOGANE_POOL = [
{ grade: "전설", rate: 0.5 },
{ grade: "특급", rate: 2.0 },
{ grade: "1급", rate: 8.0 },
{ grade: "2급", rate: 22.5 },
{ grade: "3급", rate: 67.0 },
];

function rollKogane() {
const total = KOGANE_POOL.reduce((s, p) => s + p.rate, 0);
let roll = Math.random() * total;
for (const e of KOGANE_POOL) { roll -= e.rate; if (roll <= 0) return e.grade; }
return "3급";
}

function getKoganeBonus(player) {
if (!player.kogane || !player.kogane.grade) return { atk: 1, def: 1, hp: 1, xp: 1, crystal: 1 };
const g = KOGANE_GRADES[player.kogane.grade];
if (!g) return { atk: 1, def: 1, hp: 1, xp: 1, crystal: 1 };
return {
atk: 1 + g.atkBonus,
def: 1 + g.defBonus,
hp: 1 + g.hpBonus,
xp: 1 + g.xpBonus,
crystal: 1 + g.crystalBonus,
};
}

// ════════════════════════════════════════════════════════
// ── 스킬 이펙트 아트
// ════════════════════════════════════════════════════════
const SKILL_EFFECTS = {
"주먹질": { art: "\n 💥 \n ▓▓▓▓▓\n 💥 \n", color: 0xff6b35, flavorText: "저주 에너지를 주먹에 집중시킨다!" },
"다이버전트 주먹": { art: "\n ⚡💥⚡\n▓▓▓▓▓▓▓\n ⚡💥⚡\n", color: 0xff4500, flavorText: "발산하는 저주 에너지 — 몸의 내부에서 폭발!" },
"흑섬": { art: "\n🌑🌑🌑🌑🌑\n⬛ 黑 閃 ⬛\n🌑🌑🌑🌑🌑\n", color: 0x1a0a2e, flavorText: "순간적으로 발산되는 최대 저주 에너지!" },
"어주자": { art: "\n👹✨👹✨👹\n✨ 廻 夏 ✨\n👹✨👹✨👹\n", color: 0xb5451b, flavorText: "스쿠나의 힘이 몸을 가득 채운다..." },
"스쿠나 발현": { art: "\n🔴👹🔴👹🔴\n👹 両 面 宿 儺 👹\n🔴👹🔴👹🔴\n", color: 0x8b0000, flavorText: "저주의 왕이 이타도리의 몸을 장악한다!" },
"아오": { art: "\n 🔵🔵🔵 \n🔵 蒼 🔵\n 🔵🔵🔵 \n", color: 0x0066ff, flavorText: "무한에 의한 인력 — 모든 것을 끌어당긴다" },
"아카": { art: "\n 🔴🔴🔴 \n🔴 赫 🔴\n 🔴🔴🔴 \n", color: 0xff0033, flavorText: "무한에 의한 척력 — 모든 것을 날려버린다" },
"무라사키": { art: "\n🔴⚡🔵⚡🔴\n⚡ 紫 ⚡\n🔵⚡🔴⚡🔵\n", color: 0x9900ff, flavorText: "아오와 아카의 융합 — 허공을 찢는 허수!" },
"무량공처": { art: "\n∞∞∞∞∞∞∞∞∞\n∞ 無 量 空 処 ∞\n∞∞∞∞∞∞∞∞∞\n", color: 0x00ffff, flavorText: ""나는 최강이니까" — 무한이 세계를 지배한다" },
"옥견": { art: "\n 🐕🐕🐕 \n🐕 玉 🐕\n 🐕🐕🐕 \n", color: 0x4a4a8a, flavorText: "식신 옥견 소환!" },
"탈토": { art: "\n 🐯🐯🐯 \n🐯 脱 🐯\n 🐯🐯🐯 \n", color: 0xff8800, flavorText: "식신 대호 소환 — 강력한 발톱이 적을 찢는다!" },
"만상": { art: "\n🌑🐕🌑🐯🌑\n🐯 萬 象 🐕\n🌑🐯🌑🐕🌑\n", color: 0x2d1b69, flavorText: "열 가지 식신이 일제히 소환된다!" },
"후루베 유라유라": { art: "\n💀✨💀✨💀\n✨ 振 魂 ✨\n💀✨💀✨💀\n", color: 0x8b0000, flavorText: "마허라가라 강림 — 최강의 식신이 깨어난다!" },
"망치질": { art: "\n 🔨🔨🔨 \n⚡ 釘 ⚡\n 🔨🔨🔨 \n", color: 0xff69b4, flavorText: "저주 못을 적의 영혼에 박아넣는다!" },
"공명": { art: "\n🌸💥🌸💥🌸\n💥 共 鳴 💥\n🌸💥🌸💥🌸\n", color: 0xff1493, flavorText: "허수아비를 통한 공명 피해 — 영혼이 직접 타격된다!" },
"철정": { art: "\n⚡🔨⚡🔨⚡\n🔨 鉄 釘 🔨\n⚡🔨⚡🔨⚡\n", color: 0xdc143c, flavorText: "저주 에너지 주입 — 못이 몸 속에서 폭발한다!" },
"발화": { art: "\n🔥🌸🔥🌸🔥\n🌸 発 火 🌸\n🔥🌸🔥🌸🔥\n", color: 0xff4500, flavorText: "모든 못에 동시 폭발 공명 — 영혼이 불타오른다!" },
"해": { art: "\n ✂️✂️✂️ \n✂️ 解 ✂️\n ✂️✂️✂️ \n", color: 0xcc0000, flavorText: "만물을 베어내는 저주의 왕의 손톱!" },
"팔": { art: "\n🌌✂️🌌✂️🌌\n✂️ 捌 ✂️\n🌌✂️🌌✂️🌌\n", color: 0x8b0000, flavorText: "공간 자체를 베어내는 절대적 술식!" },
"푸가": { art: "\n💀🔥💀🔥💀\n🔥 不 雅 🔥\n💀🔥💀🔥💀\n", color: 0x4a0000, flavorText: "닿는 모든 것을 분해한다 — 저주의 왕의 진면목!" },
"복마어주자": { art: "\n👑🌑👑🌑👑\n🌑伏魔御廚子🌑\n👑🌑👑🌑👑\n", color: 0x2a0000, flavorText: "천지개벽 — 저주의 왕의 궁극 영역전개!" },
"모방술식": { art: "\n 🌟🌟🌟 \n🌟 模 🌟\n 🌟🌟🌟 \n", color: 0xffd700, flavorText: "타인의 술식을 완벽하게 복사한다!" },
"리카 소환": { art: "\n💜👸💜👸💜\n👸 里 香 👸\n💜👸💜👸💜\n", color: 0x9400d3, flavorText: "저주의 여왕 리카 소환 — 최강의 저주된 영혼!" },
"순애빔": { art: "\n💜💛💜💛💜\n💛 純 愛 砲 💛\n💜💛💜💛💜\n", color: 0xff00ff, flavorText: "사랑의 에너지가 파괴적인 빔으로 변환된다!" },
"진안상애": { art: "\n🌟💜🌟💜🌟\n💜真贋相愛💜\n🌟💜🌟💜🌟\n", color: 0x6600cc, flavorText: "사랑과 저주의 경계가 무너진다 — 궁극의 영역!" },
"부기우기": { art: "\n🎵💪🎵💪🎵\n💪 Boogie 💪\n🎵💪🎵💪🎵\n", color: 0x1e90ff, flavorText: ""댄스홀 가수!" — 보조공격술 위치 전환! 빙결의 한기!" },
"브루탈 펀치": { art: "\n💥🔥💥🔥💥\n🔥BRUTAL🔥\n💥🔥💥🔥💥\n", color: 0xff2200, flavorText: "최대 저주력을 실은 파괴적 일격!" },
"전투본능": { art: "\n⚔️🔥⚔️🔥⚔️\n🔥戦闘本能🔥\n⚔️🔥⚔️🔥⚔️\n", color: 0xff8c00, flavorText: "전사의 본능이 각성한다! 공격력·회피 극대화!" },
"_default": { art: "\n ✨✨✨ \n✨ 術 式 ✨\n ✨✨✨ \n", color: 0x7c5cfc, flavorText: "저주 에너지가 폭발한다!" },
};
function getSkillEffect(skillName) { return SKILL_EFFECTS[skillName] || SKILL_EFFECTS["_default"]; }

// ════════════════════════════════════════════════════════
// ── 캐릭터 데이터
// ════════════════════════════════════════════════════════
const CHARACTERS = {
itadori: {
name: "이타도리 유지", emoji: "🟠", grade: "준1급",
atk: 90, def: 75, spd: 85, maxHp: 1000, domain: null,
desc: "특급주술사 후보생. 스쿠나의 손가락을 삼킨 그릇.",
lore: ""남은 건 내가 어떻게 죽느냐다."",
fingerSkills: true,
skills: [
{ name: "주먹질", minMastery: 0, dmg: 95, desc: "강력한 기본 주먹 공격." },
{ name: "다이버전트 주먹", minMastery: 5, dmg: 160, desc: "저주 에너지를 실은 주먹.", statusApply: { target: "enemy", statusId: "stun", chance: 0.3 } },
{ name: "흑섬", minMastery: 15, dmg: 240, desc: "최대 저주 에너지 방출!", statusApply: { target: "enemy", statusId: "weaken", chance: 0.5 } },
{ name: "어주자", minMastery: 30, dmg: 340, desc: "스쿠나의 힘을 빌린 궁극기.", statusApply: { target: "enemy", statusId: "burn", chance: 0.7 } },
{ name: "스쿠나 발현", minMastery: 50, dmg: 520, desc: "스쿠나가 몸을 장악! 10손가락 이상 필요.", statusApply: { target: "enemy", statusId: "freeze", chance: 0.8 } },
 ],
},
gojo: {
name: "고조 사토루", emoji: "🔵", grade: "특급",
atk: 130, def: 120, spd: 110, maxHp: 1800, domain: "무량공처",
desc: "최강의 주술사. 무량공처를 구사한다.",
lore: ""사람들이 왜 내가 최강이라고 하는지 알아? 이 무한이 있어서야."",
skills: [
{ name: "아오", minMastery: 0, dmg: 145, desc: "적들을 끌어당겨서 공격한다." },
{ name: "아카", minMastery: 5, dmg: 220, desc: "적들을 날려서 폭발시킨다.", statusApply: { target: "enemy", statusId: "burn", chance: 0.5 } },
{ name: "무라사키", minMastery: 15, dmg: 320, desc: "아오와 아카를 합쳐서 발사.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.6 } },
{ name: "무량공처", minMastery: 30, dmg: 480, desc: "무한을 지배하는 궁극술식.", statusApply: { target: "enemy", statusId: "freeze", chance: 0.8 } },
 ],
},
megumi: {
name: "후시구로 메구미", emoji: "⚫", grade: "1급",
atk: 110, def: 108, spd: 100, maxHp: 1250, domain: "강압암예정",
desc: "식신술을 구사하는 주술사.",
lore: ""나는 선한 사람을 구하기 위해 싸운다."",
skills: [
{ name: "옥견", minMastery: 0, dmg: 115, desc: "식신 옥견을 소환한다." },
{ name: "탈토", minMastery: 5, dmg: 180, desc: "식신 대호를 소환한다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.4 } },
{ name: "만상", minMastery: 15, dmg: 265, desc: "열 가지 식신을 소환한다.", statusApply: { target: "enemy", statusId: "poison", chance: 0.5 } },
{ name: "후루베 유라유라", minMastery: 30, dmg: 380, desc: "최강의 식신, 마허라가라 강림.", statusApply: { target: "enemy", statusId: "stun", chance: 0.6 } },
 ],
},
nobara: {
name: "쿠기사키 노바라", emoji: "🌸", grade: "1급",
atk: 115, def: 95, spd: 105, maxHp: 1180, domain: null,
desc: "망치를 이용해 영혼에 공격 가능한 주술사.",
lore: ""도쿄에 올 때부터 각오는 되어 있었어."",
skills: [
{ name: "망치질", minMastery: 0, dmg: 118, desc: "저주 못을 박는다." },
{ name: "공명", minMastery: 5, dmg: 195, desc: "허수아비를 통해 공명 피해.", statusApply: { target: "enemy", statusId: "poison", chance: 0.5 } },
{ name: "철정", minMastery: 15, dmg: 280, desc: "저주 에너지 주입 못을 박는다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.5 } },
{ name: "발화", minMastery: 30, dmg: 390, desc: "모든 못에 동시 폭발 공명.", statusApply: { target: "enemy", statusId: "burn", chance: 0.8 } },
 ],
},
nanami: {
name: "나나미 켄토", emoji: "🟡", grade: "1급",
atk: 118, def: 108, spd: 90, maxHp: 1380, domain: null,
desc: "1급 주술사. 합리적 판단의 소유자.",
lore: ""초과 근무는 사절이지만... 이건 일이 아닌 의무다."",
skills: [
{ name: "둔기 공격", minMastery: 0, dmg: 120, desc: "단단한 둔기로 타격한다." },
{ name: "칠할삼분", minMastery: 5, dmg: 200, desc: "7:3 지점을 노린 약점 공격.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.6 } },
{ name: "십수할", minMastery: 15, dmg: 290, desc: "열 배의 저주 에너지 방출." },
{ name: "초과근무", minMastery: 30, dmg: 410, desc: "한계를 넘어선 폭발적 강화." },
 ],
},
sukuna: {
name: "료멘 스쿠나", emoji: "🔴", grade: "특급",
atk: 140, def: 115, spd: 120, maxHp: 2500, domain: "복마어주자",
desc: "저주의 왕. 역대 최강의 저주된 영혼. [개발자 전용]",
lore: ""약한 놈이 강한 놈을 거스르는 건 죄악이다."",
skills: [
{ name: "해", minMastery: 0, dmg: 145, desc: "날카로운 손톱으로 베어낸다.", statusApply: { target: "enemy", statusId: "burn", chance: 0.4 } },
{ name: "팔", minMastery: 5, dmg: 235, desc: "공간 자체를 베어낸다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.5 } },
{ name: "푸가", minMastery: 15, dmg: 345, desc: "닿는 모든 것을 분해한다.", statusApply: { target: "enemy", statusId: "poison", chance: 0.7 } },
{ name: "복마어주자", minMastery: 30, dmg: 500, desc: "천지개벽의 궁극 영역전개.", statusApply: { target: "enemy", statusId: "freeze", chance: 0.9 } },
 ],
},
geto: {
name: "게토 스구루", emoji: "🟢", grade: "특급",
atk: 115, def: 105, spd: 100, maxHp: 1600, domain: null,
desc: "전 특급 주술사. 저주를 다루는 달인.",
lore: ""주술사는 비주술사를 지켜야 한다 — 아니, 그래야만 했어."",
skills: [
{ name: "저주 방출", minMastery: 0, dmg: 125, desc: "저급 저주령을 방출한다." },
{ name: "최대출력", minMastery: 5, dmg: 210, desc: "저주령을 전력으로 방출.", statusApply: { target: "enemy", statusId: "poison", chance: 0.4 } },
{ name: "저주영조종", minMastery: 15, dmg: 300, desc: "수천의 저주령을 조종한다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.6 } },
{ name: "감로대법", minMastery: 30, dmg: 425, desc: "감로대법으로 모든 저주 흡수.", statusApply: { target: "enemy", statusId: "stun", chance: 0.5 } },
 ],
},
maki: {
name: "마키 젠인", emoji: "⚪", grade: "준1급",
atk: 122, def: 110, spd: 115, maxHp: 1300, domain: null,
desc: "저주력이 없어도 강한 주술사. HP 30% 이하 시 천여주박 각성!",
lore: ""젠인 가문 — 그 이름을 내가 직접 끝내주지."",
awakening: { threshold: 0.30, dmgMult: 2.0, label: "천여주박 각성" },
skills: [
{ name: "봉술", minMastery: 0, dmg: 122, desc: "저주 도구 봉으로 타격." },
{ name: "저주창", minMastery: 5, dmg: 200, desc: "저주 도구 창을 투척한다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.4 } },
{ name: "저주도구술", minMastery: 15, dmg: 285, desc: "다양한 저주 도구를 구사.", statusApply: { target: "enemy", statusId: "burn", chance: 0.5 } },
{ name: "천개봉파", minMastery: 30, dmg: 400, desc: "수천의 저주 도구 연속 공격.", statusApply: { target: "enemy", statusId: "stun", chance: 0.6 } },
 ],
},
panda: {
name: "판다", emoji: "🐼", grade: "2급",
atk: 105, def: 118, spd: 85, maxHp: 1400, domain: null,
desc: "저주로 만든 특이체질의 주술사.",
lore: ""난 판다야. 진짜 판다."",
skills: [
{ name: "박치기", minMastery: 0, dmg: 108, desc: "머리로 힘차게 들이받는다.", statusApply: { target: "enemy", statusId: "stun", chance: 0.2 } },
{ name: "곰 발바닥", minMastery: 5, dmg: 175, desc: "두꺼운 발바닥으로 내리친다." },
{ name: "팬더 변신", minMastery: 15, dmg: 255, desc: "진짜 팬더로 변신해 공격.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.4 } },
{ name: "고릴라 변신", minMastery: 30, dmg: 360, desc: "고릴라 형태로 폭발적 강화.", statusApply: { target: "enemy", statusId: "stun", chance: 0.5 } },
 ],
},
inumaki: {
name: "이누마키 토게", emoji: "🟤", grade: "준1급",
atk: 112, def: 90, spd: 110, maxHp: 1120, domain: null,
desc: "주술언어를 구사하는 준1급 주술사.",
lore: ""연어알— (그냥 따라가.)"",
skills: [
{ name: "멈춰라", minMastery: 0, dmg: 115, desc: "상대의 움직임을 봉쇄한다.", statusApply: { target: "enemy", statusId: "freeze", chance: 0.5 } },
{ name: "달려라", minMastery: 5, dmg: 180, desc: "상대를 무작위로 달리게 한다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.5 } },
{ name: "주술언어", minMastery: 15, dmg: 265, desc: "강력한 주술 명령을 내린다.", statusApply: { target: "enemy", statusId: "stun", chance: 0.6 } },
{ name: "폭발해라", minMastery: 30, dmg: 375, desc: "상대를 그 자리에서 폭발시킨다.", statusApply: { target: "enemy", statusId: "burn", chance: 0.8 } },
 ],
},
yuta: {
name: "오코츠 유타", emoji: "🌟", grade: "특급",
atk: 128, def: 112, spd: 115, maxHp: 1750, domain: "진안상애",
desc: "특급 주술사. 리카의 저주를 다루는 최강급 주술사.",
lore: ""리카... 나는 아직 살아야 해."",
skills: [
{ name: "모방술식", minMastery: 0, dmg: 135, desc: "다른 술식을 모방해 공격한다." },
{ name: "리카 소환", minMastery: 5, dmg: 220, desc: "저주의 여왕 리카를 소환한다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.5 } },
{ name: "순애빔", minMastery: 15, dmg: 340, desc: "리카와의 순수한 사랑을 에너지로 발사.", statusApply: { target: "enemy", statusId: "burn", chance: 0.6 } },
{ name: "진안상애", minMastery: 30, dmg: 480, desc: "영역전개로 모든 것을 사랑으로 파괴.", statusApply: { target: "enemy", statusId: "freeze", chance: 0.9 } },
 ],
},
higuruma: {
name: "히구루마 히로미", emoji: "⚖️", grade: "1급",
atk: 118, def: 105, spd: 95, maxHp: 1320, domain: "주복사사",
desc: "전직 변호사 출신 주술사. 심판의 영역전개를 구사한다.",
lore: ""이 법정에서는 — 내가 판사다."",
skills: [
{ name: "저주도구", minMastery: 0, dmg: 120, desc: "저주 에너지를 담은 도구로 공격." },
{ name: "몰수", minMastery: 5, dmg: 195, desc: "상대의 술식을 몰수한다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.7 } },
{ name: "사형판결", minMastery: 15, dmg: 285, desc: "재판 결과에 따른 강력한 제재.", statusApply: { target: "enemy", statusId: "stun", chance: 0.5 } },
{ name: "집행인 인형", minMastery: 30, dmg: 410, desc: "집행인 인형을 소환해 즉시 처형.", statusApply: { target: "enemy", statusId: "freeze", chance: 0.7 } },
 ],
},
jogo: {
name: "죠고", emoji: "🌋", grade: "특급",
atk: 125, def: 100, spd: 105, maxHp: 1680, domain: "개관철위산",
desc: "화염을 다루는 준특급 저주령.",
lore: ""인간이야말로 진정한 저주다."",
skills: [
{ name: "화염 분사", minMastery: 0, dmg: 130, desc: "강렬한 불꽃을 내뿜는다.", statusApply: { target: "enemy", statusId: "burn", chance: 0.5 } },
{ name: "용암 폭발", minMastery: 5, dmg: 215, desc: "발밑의 용암을 폭발시킨다.", statusApply: { target: "enemy", statusId: "burn", chance: 0.7 } },
{ name: "극번 운", minMastery: 15, dmg: 315, desc: "하늘에서 불타는 운석을 소환한다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.5 } },
{ name: "개관철위산", minMastery: 30, dmg: 460, desc: "화산을 소환하는 궁극 영역전개.", statusApply: { target: "enemy", statusId: "burn", chance: 1.0 } },
 ],
},
dagon: {
name: "다곤", emoji: "🌊", grade: "특급",
atk: 118, def: 108, spd: 96, maxHp: 1620, domain: "탕온평선",
desc: "수중 저주령.",
lore: ""물은 모든 것을 삼킨다."",
skills: [
{ name: "물고기 소환", minMastery: 0, dmg: 125, desc: "날카로운 물고기 떼를 소환한다.", statusApply: { target: "enemy", statusId: "poison", chance: 0.4 } },
{ name: "해수 폭발", minMastery: 5, dmg: 205, desc: "강력한 해수를 압축해 발사한다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.5 } },
{ name: "조류 소용돌이", minMastery: 15, dmg: 295, desc: "거대한 물의 소용돌이로 공격한다.", statusApply: { target: "enemy", statusId: "freeze", chance: 0.4 } },
{ name: "탕온평선", minMastery: 30, dmg: 450, desc: "무수한 물고기로 가득 찬 영역전개.", statusApply: { target: "enemy", statusId: "poison", chance: 0.9 } },
 ],
},
hanami: {
name: "하나미", emoji: "🌿", grade: "특급",
atk: 115, def: 118, spd: 93, maxHp: 1750, domain: null,
desc: "식물 저주령. 나무뿌리와 꽃을 이용한 자연 술식을 구사한다.",
lore: ""자연은 인간의 적이 아니다 — 다만 인간이 자연의 적일 뿐."",
skills: [
{ name: "나무뿌리 채찍", minMastery: 0, dmg: 122, desc: "나무뿌리를 채찍처럼 휘두른다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.3 } },
{ name: "꽃비", minMastery: 5, dmg: 198, desc: "독성 꽃가루를 비처럼 쏟아낸다.", statusApply: { target: "enemy", statusId: "poison", chance: 0.6 } },
{ name: "대지의 저주", minMastery: 15, dmg: 285, desc: "대지 전체에 저주 에너지를 퍼뜨린다.", statusApply: { target: "enemy", statusId: "poison", chance: 0.7 } },
{ name: "재앙의 꽃", minMastery: 30, dmg: 425, desc: "거대한 꽃을 소환해 모든 것을 흡수한다.", statusApply: { target: "enemy", statusId: "stun", chance: 0.6 } },
 ],
},
mahito: {
name: "마히토", emoji: "🩸", grade: "특급",
atk: 120, def: 98, spd: 110, maxHp: 1560, domain: "자폐원돈과",
desc: "영혼을 자유자재로 변형하는 준특급 저주령.",
lore: ""영혼이 육체를 만드는 거야. 반대가 아니라."",
skills: [
{ name: "영혼 변형", minMastery: 0, dmg: 128, desc: "영혼을 변형해 직접 타격한다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.4 } },
{ name: "무위전변", minMastery: 5, dmg: 212, desc: "접촉한 신체를 기괴하게 변형한다.", statusApply: { target: "enemy", statusId: "stun", chance: 0.4 } },
{ name: "편사지경체", minMastery: 15, dmg: 308, desc: "신체를 무한히 변형해 공격한다.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.6 } },
{ name: "자폐원돈과", minMastery: 30, dmg: 455, desc: "영혼과 육체의 경계를 무너뜨리는 영역.", statusApply: { target: "enemy", statusId: "freeze", chance: 0.8 } },
 ],
},
todo: {
name: "토도 아오이", emoji: "💪", grade: "1급",
atk: 128, def: 108, spd: 112, maxHp: 1500, domain: null,
desc: "보조 공격술(부기우기)을 구사하는 1급 주술사. 親友(베프)를 중시한다.",
lore: ""너의 이상형은 어떤 여자야?" — 그리고 전설의 주먹이 날아온다.",
skills: [
{ name: "부기우기", minMastery: 0, dmg: 130, desc: "보조공격술 — 위치 전환 + 빙결 40%.", statusApply: { target: "enemy", statusId: "freeze", chance: 0.40 } },
{ name: "브루탈 펀치", minMastery: 5, dmg: 215, desc: "최대 저주력을 실은 파괴적 주먹.", statusApply: { target: "enemy", statusId: "weaken", chance: 0.30 } },
{ name: "흑섬", minMastery: 15, dmg: 320, desc: "이타도리에게 배운 흑섬 — 토도 특유 방식!", statusApply: { target: "enemy", statusId: "burn", chance: 0.45 } },
{ name: "전투본능", minMastery: 30, dmg: 200, desc: "자신에게 전투본능 버프! (ATK 40%↑, 회피 25%↑, 3턴) + 즉시 타격", statusApply: { target: "self", statusId: "battleInstinct", chance: 1.0 } },
 ],
},
};

// ════════════════════════════════════════════════════════
// ── 적 데이터
// ════════════════════════════════════════════════════════
const ENEMIES = [
{ id: "e1", name: "저급 저주령", emoji: "👹", hp: 550, atk: 38, def: 12, xp: 75, crystals: 18, masteryXp: 1, fingers: 0, statusAttack: null },
{ id: "e2", name: "1급 저주령", emoji: "👺", hp: 1100, atk: 80, def: 40, xp: 190, crystals: 40, masteryXp: 3, fingers: 0, statusAttack: { statusId: "poison", chance: 0.3 } },
{ id: "e3", name: "특급 저주령", emoji: "💀", hp: 2400, atk: 128, def: 72, xp: 440, crystals: 90, masteryXp: 7, fingers: 1, statusAttack: { statusId: "burn", chance: 0.4 } },
{ id: "e4", name: "저주의 왕 (보스)", emoji: "👑", hp: 5500, atk: 195, def: 110,xp: 1000, crystals: 200, masteryXp: 15, fingers: 3, statusAttack: { statusId: "weaken", chance: 0.5 } },
];

const JUJUTSU_ENEMIES = [
{ id: "j1", name: "약화된 저주령", emoji: "💧", hp: 300, atk: 25, def: 8, xp: 55, crystals: 12, masteryXp: 1, points: 1, fingers: 0, statusAttack: null, desc: "⚡ 빠르지만 약함 (1포인트)" },
{ id: "j2", name: "중간급 저주령", emoji: "🌀", hp: 620, atk: 55, def: 28, xp: 115, crystals: 28, masteryXp: 2, points: 1, fingers: 0, statusAttack: { statusId: "weaken", chance: 0.2 }, desc: "⚖️ 균형잡힌 몹 (1포인트)" },
{ id: "j3", name: "강화 저주령", emoji: "🔥", hp: 450, atk: 75, def: 22, xp: 95, crystals: 23, masteryXp: 2, points: 1, fingers: 0, statusAttack: { statusId: "burn", chance: 0.35 }, desc: "💥 공격적이지만 방어 낮음 (1포인트)" },
{ id: "j4", name: "특수 저주령", emoji: "☠️", hp: 960, atk: 88, def: 48, xp: 190, crystals: 45, masteryXp: 4, points: 2, fingers: 0, statusAttack: { statusId: "poison", chance: 0.4 }, desc: "🧪 독 공격! (2포인트)" },
{ id: "j5", name: "엘리트 저주령", emoji: "💀", hp: 1380, atk: 108, def: 60, xp: 280, crystals: 70, masteryXp: 6, points: 3, fingers: 1, statusAttack: { statusId: "burn", chance: 0.5 }, desc: "⚔️ 강력한 엘리트 (3포인트)" },
{ id: "j6", name: "사멸회유 수호자", emoji: "👹", hp: 2100, atk: 135, def: 82, xp: 440, crystals: 100, masteryXp: 10, points: 5, fingers: 2, statusAttack: { statusId: "weaken", chance: 0.6 }, desc: "🏆 최강 수호자 (5포인트)" },
];

// ════════════════════════════════════════════════════════
// ── 가챠 풀
// ════════════════════════════════════════════════════════
const GACHA_POOL = [
{ id: "gojo", rate: 0.3 },
{ id: "yuta", rate: 0.45 },
{ id: "geto", rate: 0.9 },
{ id: "jogo", rate: 0.6 },
{ id: "mahito", rate: 0.6 },
{ id: "hanami", rate: 0.7 },
{ id: "dagon", rate: 0.7 },
{ id: "itadori", rate: 2.5 },
{ id: "megumi", rate: 6.0 },
{ id: "nanami", rate: 6.0 },
{ id: "maki", rate: 6.5 },
{ id: "nobara", rate: 6.5 },
{ id: "higuruma", rate: 6.5 },
{ id: "todo", rate: 5.0 },
{ id: "panda", rate: 32.0 },
{ id: "inumaki", rate: 23.75 },
];

const GACHA_RARITY = {
"특급": { stars: "★★★★★", color: 0xF5C842, effect: "✨🔱✨🔱✨", flash: "LEGENDARY" },
"준특급":{ stars: "★★★★☆", color: 0xff8c00, effect: "💠💠💠💠💠", flash: "EPIC" },
"1급": { stars: "★★★☆☆", color: 0x7C5CFC, effect: "⭐⭐⭐⭐", flash: "RARE" },
"준1급": { stars: "★★★☆☆", color: 0x9b72cf, effect: "⭐⭐⭐", flash: "RARE" },
"2급": { stars: "★★☆☆☆", color: 0x4ade80, effect: "🔹🔹🔹", flash: "UNCOMMON" },
"3급": { stars: "★☆☆☆☆", color: 0x94a3b8, effect: "◽◽", flash: "COMMON" },
};

function rollGacha(count = 1) {
const total = GACHA_POOL.reduce((s, p) => s + p.rate, 0);
return Array.from({ length: count }, () => {
let roll = Math.random() * total;
for (const e of GACHA_POOL) { roll -= e.rate; if (roll <= 0) return e.id; }
return GACHA_POOL[GACHA_POOL.length - 1].id;
});
}

const REVERSE_CHARS = new Set(["gojo", "yuta"]);
const CODES = { "release": { crystals: 200 } };

// ════════════════════════════════════════════════════════
// ── 인메모리 세션
// ════════════════════════════════════════════════════════
let players = {};
const battles = {};
const cullings = {};
const jujutsus = {};
const parties = {};
const partyInvites = {};
const pvpSessions = {};
const pvpChallenges = {};
let _partyIdSeq = 1;
let _pvpIdSeq = 1;

// ════════════════════════════════════════════════════════
// ── 플레이어 유틸
// ════════════════════════════════════════════════════════
function getPlayer(userId, username = "플레이어") {
if (!players[userId]) {
players[userId] = {
id: userId, name: username, crystals: 500, xp: 0,
owned: ["itadori"], active: "itadori",
hp: CHARACTERS["itadori"].maxHp, potion: 3,
wins: 0, losses: 0,
mastery: { itadori: 0 },
reverseOutput: 1.0, reverseCooldown: 0,
cullingBest: 0, jujutsuBest: 0,
usedCodes: [], lastDaily: 0,
pvpWins: 0, pvpLosses: 0,
statusEffects: [], skillCooldown: 0,
dailyStreak: 0,
sukunaFingers: 0,
kogane: null,
koganeGachaCount: 0,
};
savePlayer(userId);
}
const p = players[userId];
let changed = false;
if (p.name !== username && username !== "플레이어") { p.name = username; changed = true; }
const defaults = {
reverseOutput: 1.0, reverseCooldown: 0, mastery: {}, cullingBest: 0,
jujutsuBest: 0, usedCodes: [], lastDaily: 0, pvpWins: 0, pvpLosses: 0,
statusEffects: [], skillCooldown: 0, dailyStreak: 0, sukunaFingers: 0,
kogane: null, koganeGachaCount: 0,
};
for (const [k, v] of Object.entries(defaults)) {
if (p[k] === undefined) { p[k] = typeof v === "object" && v !== null ? JSON.parse(JSON.stringify(v)) : v; changed = true; }
}
if (!p.id) { p.id = userId; changed = true; }
if (changed) savePlayer(userId);
return p;
}

function getMastery(player, charId) { return player.mastery?.[charId] || 0; }

function getAvailableSkills(player, charId) {
const m = getMastery(player, charId);
const skills = CHARACTERS[charId].skills.filter(s => m >= s.minMastery);
return skills.filter(s => {
if (s.name === "스쿠나 발현" && (player.sukunaFingers || 0) < 10) return false;
return true;
});
}

function getCurrentSkill(player, charId) {
const skills = getAvailableSkills(player, charId);
return skills[skills.length - 1] || CHARACTERS[charId].skills[0];
}

function getNextSkill(player, charId) {
const m = getMastery(player, charId);
return CHARACTERS[charId].skills.find(s => s.minMastery > m) || null;
}

function getPlayerStats(player) {
const ch = CHARACTERS[player.active];
const kb = getKoganeBonus(player);
if (player.active !== "itadori") return {
atk: Math.floor(ch.atk * kb.atk),
def: Math.floor(ch.def * kb.def),
maxHp: Math.floor(ch.maxHp * kb.hp),
};
const bonus = getFingerBonus(player.sukunaFingers || 0);
return {
atk: Math.floor((ch.atk + bonus.atkBonus) * kb.atk),
def: Math.floor((ch.def + bonus.defBonus) * kb.def),
maxHp: Math.floor((ch.maxHp + bonus.hpBonus) * kb.hp),
};
}

function masteryBar(mastery, charId) {
const tiers = CHARACTERS[charId].skills.map(s => s.minMastery);
const max = tiers[tiers.length - 1];
if (mastery >= max) return "[MAX] 모든 스킬 해금!";
const next = tiers.find(t => t > mastery) || max;
const prev = [...tiers].reverse().find(t => t <= mastery) || 0;
const fill = Math.round(((mastery - prev) / (next - prev)) * 10);
return "" + "█".repeat(Math.max(0, fill)) + "░".repeat(Math.max(0, 10 - fill)) + "" + ${mastery}/${next};
}

function getLevel(xp) { return Math.floor(xp / 200) + 1; }

function hpBar(cur, max, len = 10) {
const pct = Math.max(0, Math.min(1, cur / max));
const fill = Math.round(pct * len);
const color = pct > 0.5 ? "🟩" : pct > 0.25 ? "🟨" : "🟥";
return color.repeat(Math.max(0, fill)) + "⬛".repeat(Math.max(0, len - fill));
}

function hpBarText(cur, max, len = 12) {
const fill = Math.round((Math.max(0, cur) / max) * len);
return "" + "█".repeat(Math.max(0, fill)) + "░".repeat(Math.max(0, len - fill)) + "";
}

function isMakiAwakened(player) {
if (player.active !== "maki") return false;
const stats = getPlayerStats(player);
return player.hp <= Math.floor(stats.maxHp * CHARACTERS["maki"].awakening.threshold);
}

function calcDmg(atk, def, mult = 1) {
const variance = 0.70 + Math.random() * 0.60;
return Math.max(1, Math.floor((atk * variance - def * 0.22) * mult));
}

function calcDmgForPlayer(player, enemyDef, baseMult = 1) {
const stats = getPlayerStats(player);
let mult = baseMult * getWeakenMult(player.statusEffects);
if (isMakiAwakened(player)) mult *= CHARACTERS["maki"].awakening.dmgMult;
return calcDmg(stats.atk, enemyDef, mult);
}

function calcSkillDmgForPlayer(player, baseSkillDmg) {
let dmg = baseSkillDmg + Math.floor(Math.random() * 60);
dmg = Math.floor(dmg * getWeakenMult(player.statusEffects));
if (isMakiAwakened(player)) dmg = Math.floor(dmg * CHARACTERS["maki"].awakening.dmgMult);
if (player.active === "itadori") {
const bonus = getFingerBonus(player.sukunaFingers || 0);
dmg = Math.floor(dmg * (1 + bonus.atkBonus / 120));
}
const kb = getKoganeBonus(player);
dmg = Math.floor(dmg * kb.atk);
return dmg;
}

function applySkillStatus(skill, defenderObj, attackerObj = null) {
if (!skill.statusApply) return [];
const { target, statusId, chance } = skill.statusApply;
if (Math.random() > chance) return [];
const def = STATUS_EFFECTS[statusId];
if (target === "enemy") {
applyStatus(defenderObj, statusId);
return [``${def.emoji} {def.name}** 상태이상 적용! ({def.duration}턴)]; } if (target === "self" && attackerObj) { applyStatus(attackerObj, statusId); return [{def.emoji} **{def.name} 발동! (${def.duration}턴)];
}
return [];
}

function tickCooldowns(player) {
if (player.reverseCooldown > 0) player.reverseCooldown--;
if (player.skillCooldown > 0) player.skillCooldown--;
}

function parseSkillIndex(value) {
const match = value.match(/_(\d+)`$/);
if (!match) return -1;
return parseInt(match[1], 10);
}

// ════════════════════════════════════════════════════════
// ── 파티 유틸
// ════════════════════════════════════════════════════════
function getPartyId(userId) {
return Object.keys(parties).find(pid => parties[pid] && parties[pid].members && parties[pid].members.includes(userId)) || null;
}
function getParty(userId) {
const pid = getPartyId(userId);
return pid ? parties[pid] : null;
}

// ── PvP 유틸 ──
function getPvpSessionByUser(userId) { return Object.values(pvpSessions).find(s => s.p1Id === userId || s.p2Id === userId) || null; }

function pvpOpponent(session, userId) {
if (session.p1Id === userId) return { id: session.p2Id, hpKey: "hp2", statusKey: "status2", skillCdKey: "skillCd2", reverseCdKey: "reverseCd2", domainKey: "domainUsed2" };
return { id: session.p1Id, hpKey: "hp1", statusKey: "status1", skillCdKey: "skillCd1", reverseCdKey: "reverseCd1", domainKey: "domainUsed1" };
}
function pvpSelf(session, userId) {
if (session.p1Id === userId) return { id: session.p1Id, hpKey: "hp1", statusKey: "status1", skillCdKey: "skillCd1", reverseCdKey: "reverseCd1", domainKey: "domainUsed1" };
return { id: session.p2Id, hpKey: "hp2", statusKey: "status2", skillCdKey: "skillCd2", reverseCdKey: "reverseCd2", domainKey: "domainUsed2" };
}

// ════════════════════════════════════════════════════════
// ── 컬링/사멸회유 유틸
// ════════════════════════════════════════════════════════
function getCullingPool(wave) {
if (wave <= 3) return ["e1","e1","e1","e2"];
if (wave <= 7) return ["e1","e2","e2","e2","e3"];
if (wave <= 14) return ["e2","e2","e3","e3","e3"];
return ["e2","e3","e3","e4","e4"];
}

function pickCullingEnemy(wave) {
const pool = getCullingPool(wave);
const id = pool[Math.floor(Math.random() * pool.length)];
const base = ENEMIES.find(e => e.id === id);
const scale = 1 + (wave - 1) * 0.05;
return {
...base,
hp: Math.floor(base.hp * scale),
atk: Math.floor(base.atk * scale),
def: Math.floor(base.def * scale),
xp: Math.floor(base.xp * scale),
crystals: Math.floor(base.crystals * scale),
currentHp: Math.floor(base.hp * scale),
statusEffects: [],
};
}

function generateJujutsuChoices(wave) {
const pool = wave <= 3 ? ["j1","j1","j2","j3"]
: wave <= 7 ? ["j2","j3","j3","j4"]
: wave <= 12 ? ["j3","j4","j4","j5"]
: ["j4","j5","j5","j6"];
const ids = [];
for (const id of [...pool].sort(() => Math.random() - 0.5)) {
if (!ids.includes(id)) ids.push(id);
if (ids.length === 3) break;
}
while (ids.length < 3) {
const fb = pool[Math.floor(Math.random() * pool.length)];
if (!ids.includes(fb)) ids.push(fb);
}
return ids.slice(0, 3).map(id => {
const base = JUJUTSU_ENEMIES.find(e => e.id === id);
const scale = 1 + (wave - 1) * 0.04;
return { ...base, hp: Math.floor(base.hp * scale), atk: Math.floor(base.atk * scale), def: Math.floor(base.def * scale), xp: Math.floor(base.xp * scale), crystals: Math.floor(base.crystals * scale), statusEffects: [] };
});
}

// ════════════════════════════════════════════════════════
// ── 프로필 임베드
// ════════════════════════════════════════════════════════
function profileEmbed(player) {
const ch = CHARACTERS[player.active];
const stats = getPlayerStats(player);
const skill = getCurrentSkill(player, player.active);
const next = getNextSkill(player, player.active);
const mastery = getMastery(player, player.active);
const awakened = isMakiAwakened(player);
const lv = getLevel(player.xp);
const fingers = player.sukunaFingers || 0;
const fingerBonus = getFingerBonus(fingers);
const kb = getKoganeBonus(player);
const kogane = player.kogane;
const kg = kogane ? KOGANE_GRADES[kogane.grade] : null;
const gradeInfo = GACHA_RARITY[ch.grade] || GACHA_RARITY["3급"];

const hpPct = Math.max(0, player.hp) / stats.maxHp;
const xpPct = (player.xp % 200) / 200;
const hpFill = Math.round(hpPct * 15);
const xpFill = Math.round(xpPct * 15);
const hpColor = hpPct > 0.6 ? "🟢" : hpPct > 0.3 ? "🟡" : "🔴";

const gradeAccent = {
"특급": { bar: "🔱", side: "══╡ 特 級 ╞══", glow: "✦", tag: "S P E C I A L G R A D E" },
"준특급": { bar: "💠", side: "══╡準特級╞══", glow: "◈", tag: "S E M I S P E C I A L" },
"1급": { bar: "⭐", side: "══╡ 1 級 ╞══", glow: "★", tag: "G R A D E 1" },
"준1급": { bar: "⭐", side: "══╡準1級╞══", glow: "☆", tag: "S E M I G R A D E 1" },
"2급": { bar: "🔹", side: "══╡ 2 級 ╞══", glow: "◆", tag: "G R A D E 2" },
"3급": { bar: "◽", side: "══╡ 3 級 ╞══", glow: "◇", tag: "G R A D E 3" },
};
const acc = gradeAccent[ch.grade] || gradeAccent["3급"];

const skillLines = CHARACTERS[player.active].skills.map((s) => {
const unlocked = mastery >= s.minMastery;
const isCurrent = skill.name === s.name;
const fingerLock = s.name === "스쿠나 발현" && fingers < 10;
const available = unlocked && !fingerLock;
const statusNote = s.statusApply
? ｜${STATUS_EFFECTS[s.statusApply.statusId]?.emoji}${Math.round(s.statusApply.chance * 100)}%${s.statusApply.target === "self" ? "버프" : ""}: ""; const icon = !available ? "🔒" : isCurrent ? "▶" : "✓"; return`${icon}\ **{s.dmg}dmg)${statusNote};
}).join("\n");
