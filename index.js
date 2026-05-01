const {
  Client, GatewayIntentBits, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder
} = require('discord.js');
 
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});
 
// ───────────────────────────────────────────────
// 캐릭터 데이터
// ───────────────────────────────────────────────
const CHARACTERS = {
  itadori: {
    name: '이타도리 유지', emoji: '🟠', grade: 'S',
    atk: 95, def: 80, spd: 90, maxHp: 1200,
    desc: '특급주술사 후보생. 초인적 신체능력의 소유자.',
    skills: [
      { name: '주먹질',   minMastery: 0,  dmgMult: 1.0, desc: '강력한 기본 주먹 공격.' },
      { name: '흑번',     minMastery: 10, dmgMult: 1.5, desc: '저주 에너지를 실은 주먹.' },
      { name: '흑번창',   minMastery: 30, dmgMult: 2.0, desc: '최대 저주 에너지 방출!' },
      { name: '발도',     minMastery: 60, dmgMult: 2.6, desc: '스쿠나의 힘을 빌린 궁극기.' },
    ],
  },
  gojo: {
    name: '고조 사토루', emoji: '🔵', grade: 'S',
    atk: 100, def: 95, spd: 100, maxHp: 1500,
    desc: '최강의 주술사. 무량공처를 구사한다.',
    skills: [
      { name: '술식순전',    minMastery: 0,  dmgMult: 1.0, desc: '저주 에너지 순전 강화.' },
      { name: '적',         minMastery: 10, dmgMult: 1.5, desc: '공간을 비틀어 압축한다.' },
      { name: '창',         minMastery: 30, dmgMult: 2.0, desc: '저주 에너지를 극한 팽창.' },
      { name: '무량공처',   minMastery: 60, dmgMult: 2.8, desc: '무한을 지배하는 궁극술식.' },
    ],
  },
  megumi: {
    name: '후시구로 메구미', emoji: '⚫', grade: 'A',
    atk: 85, def: 88, spd: 82, maxHp: 1000,
    desc: '식신술을 구사하는 주술사.',
    skills: [
      { name: '옥견',       minMastery: 0,  dmgMult: 1.0, desc: '식신 옥견을 소환한다.' },
      { name: '대호',       minMastery: 10, dmgMult: 1.4, desc: '식신 대호를 소환한다.' },
      { name: '십종영이',   minMastery: 30, dmgMult: 1.9, desc: '열 가지 식신을 소환한다.' },
      { name: '마허라가라', minMastery: 60, dmgMult: 2.5, desc: '최강의 식신, 마허라가라 강림.' },
    ],
  },
  nobara: {
    name: '쿠기사키 노바라', emoji: '🌸', grade: 'A',
    atk: 88, def: 75, spd: 85, maxHp: 950,
    desc: '반전술식을 구사하는 주술사.',
    skills: [
      { name: '망치질',   minMastery: 0,  dmgMult: 1.0, desc: '저주 못을 박는다.' },
      { name: '공명',     minMastery: 10, dmgMult: 1.5, desc: '허수아비를 통해 공명 피해.' },
      { name: '철정',     minMastery: 30, dmgMult: 1.9, desc: '저주 에너지 주입 못을 박는다.' },
      { name: '발화',     minMastery: 60, dmgMult: 2.4, desc: '모든 못에 동시에 폭발 공명.' },
    ],
  },
  nanami: {
    name: '나나미 켄토', emoji: '🟡', grade: 'A',
    atk: 90, def: 85, spd: 75, maxHp: 1100,
    desc: '1급 주술사. 합리적 판단의 소유자.',
    skills: [
      { name: '둔기 공격',  minMastery: 0,  dmgMult: 1.0, desc: '단단한 둔기로 타격한다.' },
      { name: '칠할삼분',  minMastery: 10, dmgMult: 1.5, desc: '7:3 지점을 노린 약점 공격.' },
      { name: '십수할',    minMastery: 30, dmgMult: 2.0, desc: '열 배의 저주 에너지 방출.' },
      { name: '초과근무',  minMastery: 60, dmgMult: 2.6, desc: '한계를 넘어선 폭발적 강화.' },
    ],
  },
  sukuna: {
    name: '료멘 스쿠나', emoji: '🔴', grade: 'S',
    atk: 100, def: 90, spd: 95, maxHp: 2000,
    desc: '저주의 왕. 역대 최강의 저주된 영혼.',
    skills: [
      { name: '손톱 공격',  minMastery: 0,  dmgMult: 1.0, desc: '날카로운 손톱으로 베어낸다.' },
      { name: '해체',       minMastery: 10, dmgMult: 1.6, desc: '공간 자체를 베어낸다.' },
      { name: '분해',       minMastery: 30, dmgMult: 2.1, desc: '닿는 모든 것을 분해한다.' },
      { name: '개·염·천·지·개',  minMastery: 60, dmgMult: 3.0, desc: '천지개벽의 궁극 영역전개.' },
    ],
  },
  geto: {
    name: '게토 스구루', emoji: '🟢', grade: 'S',
    atk: 88, def: 82, spd: 80, maxHp: 1300,
    desc: '전 특급 주술사. 저주를 다루는 달인.',
    skills: [
      { name: '저주 방출',    minMastery: 0,  dmgMult: 1.0, desc: '저급 저주령을 방출한다.' },
      { name: '최대출력',     minMastery: 10, dmgMult: 1.5, desc: '저주령을 전력으로 방출.' },
      { name: '저주영조종',   minMastery: 30, dmgMult: 2.0, desc: '수천의 저주령을 조종한다.' },
      { name: '감로대법',     minMastery: 60, dmgMult: 2.7, desc: '감로대법으로 모든 저주 흡수.' },
    ],
  },
  maki: {
    name: '마키 젠인', emoji: '⚪', grade: 'A',
    atk: 92, def: 88, spd: 92, maxHp: 1050,
    desc: '저주력이 없어도 강한 주술사.',
    skills: [
      { name: '봉술',        minMastery: 0,  dmgMult: 1.0, desc: '저주 도구 봉으로 타격.' },
      { name: '저주창',      minMastery: 10, dmgMult: 1.5, desc: '저주 도구 창을 투척한다.' },
      { name: '저주도구술',  minMastery: 30, dmgMult: 1.9, desc: '다양한 저주 도구를 구사.' },
      { name: '천개봉파',    minMastery: 60, dmgMult: 2.5, desc: '수천의 저주 도구 연속 공격.' },
    ],
  },
  panda: {
    name: '판다', emoji: '🐼', grade: 'B',
    atk: 80, def: 90, spd: 70, maxHp: 1100,
    desc: '저주로 만든 특이체질의 주술사.',
    skills: [
      { name: '박치기',     minMastery: 0,  dmgMult: 1.0, desc: '머리로 힘차게 들이받는다.' },
      { name: '곰 발바닥', minMastery: 10, dmgMult: 1.4, desc: '두꺼운 발바닥으로 내리친다.' },
      { name: '팬더 변신', minMastery: 30, dmgMult: 1.8, desc: '진짜 팬더로 변신해 공격.' },
      { name: '고릴라 변신', minMastery: 60, dmgMult: 2.3, desc: '고릴라 형태로 폭발적 강화.' },
    ],
  },
  inumaki: {
    name: '이누마키 토게', emoji: '🟤', grade: 'B',
    atk: 85, def: 70, spd: 88, maxHp: 900,
    desc: '주술언어를 구사하는 세미1급 주술사.',
    skills: [
      { name: '멈춰라',       minMastery: 0,  dmgMult: 1.0, desc: '상대의 움직임을 봉쇄한다.' },
      { name: '달려라',       minMastery: 10, dmgMult: 1.4, desc: '상대를 무작위로 달리게 한다.' },
      { name: '주술언어',     minMastery: 30, dmgMult: 1.9, desc: '강력한 주술 명령을 내린다.' },
      { name: '폭발해라',     minMastery: 60, dmgMult: 2.4, desc: '상대를 그 자리에서 폭발시킨다.' },
    ],
  },
};
 
const ENEMIES = [
  { id: 'e1', name: '저급 저주령',  emoji: '👹', hp: 400,  atk: 28, def: 10, xp: 60,  crystals: 15,  masteryXp: 5 },
  { id: 'e2', name: '1급 저주령',   emoji: '👺', hp: 800,  atk: 60, def: 30, xp: 150, crystals: 30,  masteryXp: 12 },
  { id: 'e3', name: '특급 저주령',  emoji: '💀', hp: 1800, atk: 95, def: 55, xp: 350, crystals: 70,  masteryXp: 30 },
  { id: 'e4', name: '저주의 왕 (보스)', emoji: '👑', hp: 4000, atk: 140, def: 80, xp: 800, crystals: 150, masteryXp: 70 },
];
 
const GACHA_POOL = [
  { id: 'itadori', rate: 2   },
  { id: 'gojo',    rate: 0.7 },
  { id: 'sukuna',  rate: 0.8 },
  { id: 'geto',    rate: 1.5 },
  { id: 'megumi',  rate: 8   },
  { id: 'nanami',  rate: 8   },
  { id: 'maki',    rate: 9   },
  { id: 'nobara',  rate: 9   },
  { id: 'panda',   rate: 30  },
  { id: 'inumaki', rate: 31  },
];
 
const GRADE_COLOR = { S: 0xF5C842, A: 0x7C5CFC, B: 0x4ade80 };
const GRADE_EMOJI = { S: '⭐⭐⭐', A: '⭐⭐', B: '⭐' };
 
// ───────────────────────────────────────────────
// 플레이어 DB (메모리)
// ───────────────────────────────────────────────
const players = new Map();
 
function getPlayer(userId, username) {
  if (!players.has(userId)) {
    players.set(userId, {
      id: userId,
      name: username,
      crystals: 500,
      xp: 0,
      level: 1,
      owned: ['itadori', 'megumi'],
      active: 'itadori',
      hp: CHARACTERS['itadori'].maxHp,
      potion: 3,
      wins: 0,
      losses: 0,
      mastery: { itadori: 0, megumi: 0 },
    });
  }
  return players.get(userId);
}
 
function getLevel(xp) { return Math.floor(xp / 200) + 1; }
 
function getMastery(player, charId) {
  if (!player.mastery) player.mastery = {};
  return player.mastery[charId] || 0;
}
 
function getCurrentSkill(player, charId) {
  const mastery = getMastery(player, charId);
  const skills = CHARACTERS[charId].skills;
  let current = skills[0];
  for (const s of skills) {
    if (mastery >= s.minMastery) current = s;
  }
  return current;
}
 
function getNextSkill(player, charId) {
  const mastery = getMastery(player, charId);
  const skills = CHARACTERS[charId].skills;
  return skills.find(s => s.minMastery > mastery) || null;
}
 
function masteryBar(mastery) {
  const next = [10, 30, 60, 999];
  const prev = [0, 10, 30, 60];
  let tier = 0;
  for (let i = prev.length - 1; i >= 0; i--) {
    if (mastery >= prev[i]) { tier = i; break; }
  }
  if (tier >= 3) return '`[MAX 숙련]`';
  const lo = prev[tier], hi = next[tier];
  const filled = Math.round(((mastery - lo) / (hi - lo)) * 10);
  return '`' + '█'.repeat(Math.max(0, filled)) + '░'.repeat(Math.max(0, 10 - filled)) + '`' + ` ${mastery}/${hi}`;
}
 
// ───────────────────────────────────────────────
// 가챠
// ───────────────────────────────────────────────
function rollGacha(count = 1) {
  const results = [];
  const total = GACHA_POOL.reduce((s, p) => s + p.rate, 0);
  for (let i = 0; i < count; i++) {
    let roll = Math.random() * total;
    for (const entry of GACHA_POOL) {
      roll -= entry.rate;
      if (roll <= 0) { results.push(entry.id); break; }
    }
    if (results.length < i + 1) results.push(GACHA_POOL[GACHA_POOL.length - 1].id);
  }
  return results;
}
 
// ───────────────────────────────────────────────
// 전투
// ───────────────────────────────────────────────
const activeBattles = new Map();
 
function calcDmg(atk, def, mult = 1) {
  return Math.max(1, Math.round((atk * (0.8 + Math.random() * 0.4) - def * 0.25) * mult));
}
 
function hpBar(current, max, length = 12) {
  const filled = Math.round((Math.max(0, current) / max) * length);
  return '`' + '█'.repeat(Math.max(0, filled)) + '░'.repeat(Math.max(0, length - filled)) + '`';
}
 
// ───────────────────────────────────────────────
// 임베드들
// ───────────────────────────────────────────────
function profileEmbed(player) {
  const ch = CHARACTERS[player.active];
  const skill = getCurrentSkill(player, player.active);
  const nextSkill = getNextSkill(player, player.active);
  const mastery = getMastery(player, player.active);
 
  return new EmbedBuilder()
    .setTitle(`${ch.emoji} ${player.name}의 주술사 프로필`)
    .setColor(GRADE_COLOR[ch.grade])
    .addFields(
      { name: '📊 레벨 / 경험치', value: `LV.**${getLevel(player.xp)}** | ${player.xp} XP`, inline: true },
      { name: '💎 크리스탈',      value: `${player.crystals}`, inline: true },
      { name: '🏆 전적',         value: `${player.wins}승 ${player.losses}패`, inline: true },
      { name: `${ch.emoji} 활성 캐릭터 [${GRADE_EMOJI[ch.grade]} ${ch.grade}급]`, value: ch.desc, inline: false },
      { name: '⚔️ 스탯', value: `공격 **${ch.atk}** | 방어 **${ch.def}** | 속도 **${ch.spd}** | HP **${player.hp}/${ch.maxHp}**`, inline: false },
      { name: '🔥 현재 스킬', value: `**${skill.name}** (배율 x${skill.dmgMult})\n${skill.desc}`, inline: true },
      { name: '📈 숙련도', value: masteryBar(mastery), inline: true },
      { name: '⬆️ 다음 스킬', value: nextSkill ? `**${nextSkill.name}** — 숙련도 ${nextSkill.minMastery} 필요` : '**최고 단계 달성!**', inline: false },
      { name: '❤️ HP 바', value: `${hpBar(player.hp, ch.maxHp)} ${player.hp}/${ch.maxHp}`, inline: true },
      { name: '🧪 회복약', value: `${player.potion}개`, inline: true },
      { name: '📦 보유 캐릭터', value: player.owned.map(id => `${CHARACTERS[id].emoji} ${CHARACTERS[id].name} (숙련 ${getMastery(player, id)})`).join('\n') || '없음', inline: false },
    )
    .setFooter({ text: '!캐릭터 편성 | !가챠 소환 | !전투 시작 | !스킬 확인' });
}
 
function skillEmbed(player) {
  const charId = player.active;
  const ch = CHARACTERS[charId];
  const mastery = getMastery(player, charId);
  const fields = ch.skills.map(s => {
    const unlocked = mastery >= s.minMastery;
    return {
      name: `${unlocked ? '✅' : '🔒'} ${s.name} (x${s.dmgMult}) — 숙련도 ${s.minMastery} 필요`,
      value: s.desc,
      inline: false,
    };
  });
 
  return new EmbedBuilder()
    .setTitle(`${ch.emoji} ${ch.name}의 스킬 트리`)
    .setColor(GRADE_COLOR[ch.grade])
    .setDescription(`현재 숙련도: **${mastery}** | 현재 스킬: **${getCurrentSkill(player, charId).name}**`)
    .addFields(fields)
    .setFooter({ text: '전투를 통해 숙련도를 올리세요!' });
}
 
// ───────────────────────────────────────────────
// 명령어
// ───────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  const content = message.content.trim();
  const player = getPlayer(message.author.id, message.author.username);
 
  // !도움
  if (content === '!도움' || content === '!help') {
    const embed = new EmbedBuilder()
      .setTitle('⚡ 주술회전 RPG봇 — 명령어')
      .setColor(0x7c5cfc)
      .addFields(
        { name: '📋 기본', value: '`!프로필` — 내 정보\n`!도움` — 명령어 목록', inline: false },
        { name: '👤 캐릭터', value: '`!캐릭터` — 캐릭터 선택\n`!도감` — 전체 목록\n`!스킬` — 스킬 트리 확인', inline: false },
        { name: '🎲 가챠', value: '`!가챠` — 1회 (150💎)\n`!가챠10` — 10회 (1350💎)', inline: false },
        { name: '⚔️ 전투', value: '`!전투` — 전투 시작\n`!공격` `!술식` `!회복` — 전투 중 행동', inline: false },
        { name: '📈 숙련도', value: '전투 승리 시 활성 캐릭터 숙련도 상승\n숙련도가 오르면 더 강한 스킬 해금!', inline: false },
      )
      .setFooter({ text: '💎 첫 시작 시 500 크리스탈 지급! | 전투로 숙련도를 올리세요!' });
    return message.reply({ embeds: [embed] });
  }
 
  // !프로필
  if (content === '!프로필') {
    player.level = getLevel(player.xp);
    return message.reply({ embeds: [profileEmbed(player)] });
  }
 
  // !스킬
  if (content === '!스킬') {
    return message.reply({ embeds: [skillEmbed(player)] });
  }
 
  // !도감
  if (content === '!도감') {
    const embed = new EmbedBuilder()
      .setTitle('📖 주술회전 캐릭터 도감')
      .setColor(0x0d0d1a)
      .setDescription(
        Object.entries(CHARACTERS).map(([id, ch]) => {
          const owned = player.owned.includes(id);
          const mastery = getMastery(player, id);
          const skill = owned ? getCurrentSkill(player, id) : null;
          return `${owned ? ch.emoji : '🔒'} **${ch.name}** [${ch.grade}급]${owned ? ` — 숙련 ${mastery} | 스킬: ${skill.name}` : ' — 미획득'}`;
        }).join('\n')
      )
      .setFooter({ text: '!가챠로 새 캐릭터를 획득하세요!' });
    return message.reply({ embeds: [embed] });
  }
 
  // !캐릭터
  if (content === '!캐릭터') {
    if (player.owned.length === 0) return message.reply('보유한 캐릭터가 없습니다! `!가챠`로 소환하세요.');
    const select = new StringSelectMenuBuilder()
      .setCustomId('select_char')
      .setPlaceholder('편성할 캐릭터 선택')
      .addOptions(player.owned.map(id => {
        const ch = CHARACTERS[id];
        const mastery = getMastery(player, id);
        const skill = getCurrentSkill(player, id);
        return {
          label: ch.name,
          description: `${ch.grade}급 | 숙련 ${mastery} | 현재 스킬: ${skill.name}`,
          value: id,
          emoji: ch.emoji,
          default: player.active === id,
        };
      }));
    const row = new ActionRowBuilder().addComponents(select);
    return message.reply({ content: '👤 **파티 편성** — 활성화할 캐릭터를 선택하세요:', components: [row] });
  }
 
  // !가챠
  if (content === '!가챠') {
    if (player.crystals < 150) return message.reply(`💎 크리스탈 부족! (보유: ${player.crystals} / 필요: 150)`);
    player.crystals -= 150;
    const [result] = rollGacha(1);
    const ch = CHARACTERS[result];
    const isNew = !player.owned.includes(result);
    if (isNew) { player.owned.push(result); if (!player.mastery[result]) player.mastery[result] = 0; }
    else player.crystals += 50;
 
    const embed = new EmbedBuilder()
      .setTitle('🎲 주술 소환 결과!')
      .setColor(GRADE_COLOR[ch.grade])
      .setDescription(`${ch.emoji} **${ch.name}** [${GRADE_EMOJI[ch.grade]} ${ch.grade}급]${isNew ? ' ✨ **NEW!**' : ' (중복 → +50💎)'}`)
      .addFields(
        { name: '설명', value: ch.desc, inline: false },
        { name: '⚔️ 공격', value: `${ch.atk}`, inline: true },
        { name: '🛡️ 방어', value: `${ch.def}`, inline: true },
        { name: '💨 속도', value: `${ch.spd}`, inline: true },
        { name: '🔥 시작 스킬', value: ch.skills[0].name, inline: true },
        { name: '💎 잔여', value: `${player.crystals}`, inline: true },
      )
      .setFooter({ text: '!캐릭터로 편성 | !스킬로 스킬 트리 확인!' });
    return message.reply({ embeds: [embed] });
  }
 
  if (content === '!가챠10') {
    if (player.crystals < 1350) return message.reply(`💎 크리스탈 부족! (보유: ${player.crystals} / 필요: 1350)`);
    player.crystals -= 1350;
    const results = rollGacha(10);
    const newOnes = [];
    let dupCrystals = 0;
    results.forEach(id => {
      if (!player.owned.includes(id)) {
        player.owned.push(id);
        if (!player.mastery[id]) player.mastery[id] = 0;
        newOnes.push(id);
      } else {
        dupCrystals += 50;
        player.crystals += 50;
      }
    });
 
    const lines = results.map(id => {
      const ch = CHARACTERS[id];
      return `${ch.emoji} **${ch.name}** [${ch.grade}급]${newOnes.includes(id) ? ' ✨NEW!' : ''}`;
    });
 
    const embed = new EmbedBuilder()
      .setTitle('🎲 주술 10회 소환 결과!')
      .setColor(0xF5C842)
      .setDescription(lines.join('\n'))
      .addFields(
        { name: '✨ 신규', value: newOnes.length > 0 ? newOnes.map(id => CHARACTERS[id].name).join(', ') : '없음', inline: true },
        { name: '🔄 중복 보상', value: `+${dupCrystals}💎`, inline: true },
        { name: '💎 잔여', value: `${player.crystals}`, inline: true },
      );
    return message.reply({ embeds: [embed] });
  }
 
  // !전투
  if (content === '!전투') {
    if (activeBattles.has(message.author.id)) return message.reply('이미 전투 중입니다! `!공격` `!술식` `!회복` 을 사용하세요.');
    if (player.hp <= 0) {
      player.hp = Math.round(CHARACTERS[player.active].maxHp * 0.5);
      return message.reply('HP가 0이라 절반 회복했습니다. 다시 `!전투` 입력하세요!');
    }
    const buttons = new ActionRowBuilder().addComponents(
      ...ENEMIES.map(e => new ButtonBuilder().setCustomId(`enemy_${e.id}`).setLabel(`${e.emoji} ${e.name}`).setStyle(ButtonStyle.Secondary))
    );
    return message.reply({ content: '⚔️ **전투** — 상대할 적을 선택하세요:', components: [buttons] });
  }
 
  // 전투 행동
  const battle = activeBattles.get(message.author.id);
  if (content === '!공격' || content === '!술식' || content === '!회복') {
    if (!battle) return message.reply('전투 중이 아닙니다. `!전투`로 시작하세요.');
    const ch = CHARACTERS[player.active];
    const enemy = battle.enemy;
    const log = [];
    const skill = getCurrentSkill(player, player.active);
 
    if (content === '!공격') {
      const dmg = calcDmg(ch.atk, enemy.def, 1.0);
      battle.enemyHp -= dmg;
      log.push(`👊 **${ch.name}**의 공격! → **${enemy.name}**에게 **${dmg}** 피해!`);
    } else if (content === '!술식') {
      if (battle.skillUsed) return message.reply('술식은 전투당 1회만 사용 가능합니다!');
      const dmg = calcDmg(ch.atk, enemy.def, skill.dmgMult);
      battle.skillUsed = true;
      battle.enemyHp -= dmg;
      log.push(`✨ **${ch.name}**의 **${skill.name}**! → **${enemy.name}**에게 **${dmg}** 피해! (x${skill.dmgMult})`);
    } else if (content === '!회복') {
      if (player.potion <= 0) return message.reply('회복약이 없습니다!');
      const heal = Math.round(ch.maxHp * 0.3);
      player.hp = Math.min(ch.maxHp, player.hp + heal);
      player.potion--;
      log.push(`🧪 회복약 사용! HP **+${heal}** (남은 약: ${player.potion}개)`);
    }
 
    if (battle.enemyHp > 0) {
      const enemyDmg = calcDmg(enemy.atk, ch.def);
      player.hp -= enemyDmg;
      log.push(`💥 **${enemy.name}**의 반격! → **${ch.name}**에게 **${enemyDmg}** 피해!`);
    }
 
    const playerDead = player.hp <= 0;
    const enemyDead = battle.enemyHp <= 0;
 
    if (enemyDead) {
      player.xp += enemy.xp;
      player.crystals += enemy.crystals;
      player.wins++;
      player.level = getLevel(player.xp);
      if (!player.mastery[player.active]) player.mastery[player.active] = 0;
      player.mastery[player.active] += enemy.masteryXp;
      const newSkill = getCurrentSkill(player, player.active);
      activeBattles.delete(message.author.id);
      log.push(`\n🏆 **${enemy.name}** 처치! +**${enemy.xp}** XP | +**${enemy.crystals}**💎 | 숙련도 **+${enemy.masteryXp}**`);
      log.push(`🔥 현재 스킬: **${newSkill.name}** (x${newSkill.dmgMult})`);
    } else if (playerDead) {
      player.hp = 0;
      player.losses++;
      activeBattles.delete(message.author.id);
      log.push(`\n💀 **${ch.name}** 쓰러짐... !전투로 재도전하세요.`);
    }
 
    const embed = new EmbedBuilder()
      .setTitle(`⚔️ ${ch.name} VS ${enemy.emoji} ${enemy.name}`)
      .setColor(playerDead ? 0xe63946 : enemyDead ? 0xF5C842 : 0x7c5cfc)
      .setDescription(log.join('\n'))
      .addFields(
        { name: `${ch.emoji} 내 HP`, value: `${hpBar(player.hp, ch.maxHp)} ${Math.max(0, player.hp)}/${ch.maxHp}`, inline: true },
        { name: `${enemy.emoji} 적 HP`, value: `${hpBar(battle.enemyHp, enemy.hp)} ${Math.max(0, battle.enemyHp)}/${enemy.hp}`, inline: true },
      )
      .setFooter({ text: playerDead || enemyDead ? '전투 종료!' : `!공격 | !술식 [${skill.name} x${skill.dmgMult}] (1회) | !회복` });
 
    return message.reply({ embeds: [embed] });
  }
});
 
// ───────────────────────────────────────────────
// 인터랙션
// ───────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  const player = getPlayer(interaction.user.id, interaction.user.username);
 
  if (interaction.isStringSelectMenu() && interaction.customId === 'select_char') {
    const selected = interaction.values[0];
    player.active = selected;
    player.hp = CHARACTERS[selected].maxHp;
    const ch = CHARACTERS[selected];
    const skill = getCurrentSkill(player, selected);
    await interaction.update({
      content: `${ch.emoji} **${ch.name}** [${ch.grade}급] 편성 완료! HP 최대 회복.\n현재 스킬: **${skill.name}** (x${skill.dmgMult})`,
      components: []
    });
  }
 
  if (interaction.isButton() && interaction.customId.startsWith('enemy_')) {
    const enemyId = interaction.customId.replace('enemy_', '');
    const enemy = ENEMIES.find(e => e.id === enemyId);
    if (!enemy) return;
    const ch = CHARACTERS[player.active];
    const skill = getCurrentSkill(player, player.active);
    activeBattles.set(interaction.user.id, {
      enemy: { ...enemy },
      enemyHp: enemy.hp,
      skillUsed: false,
    });
 
    const embed = new EmbedBuilder()
      .setTitle(`⚔️ 전투 시작! ${ch.emoji} ${ch.name} VS ${enemy.emoji} ${enemy.name}`)
      .setColor(0xe63946)
      .addFields(
        { name: `${ch.emoji} 내 HP`, value: `${hpBar(player.hp, ch.maxHp)} ${player.hp}/${ch.maxHp}`, inline: true },
        { name: `${enemy.emoji} 적 HP`, value: `${hpBar(enemy.hp, enemy.hp)} ${enemy.hp}/${enemy.hp}`, inline: true },
        { name: '🔥 현재 스킬', value: `${skill.name} (x${skill.dmgMult}) — ${skill.desc}`, inline: false },
      )
      .setFooter({ text: '!공격 | !술식 (1회) | !회복' });
 
    await interaction.update({ content: '', embeds: [embed], components: [] });
  }
});
 
// ───────────────────────────────────────────────
// 시작
// ───────────────────────────────────────────────
client.once('ready', () => {
  console.log(`✅ ${client.user.tag} 봇 온라인!`);
  client.user.setActivity('주술회전 RPG | !도움', { type: 0 });
});
 
const TOKEN = process.env.DISCORD_TOKEN || 'YOUR_TOKEN_HERE';
client.login(TOKEN);
