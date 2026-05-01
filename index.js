const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

// ─── 데이터 ───────────────────────────────────────────────
const CHARACTERS = {
  'itadori':   { name: '이타도리 유지', emoji: '🟠', grade: 'S', atk: 95, def: 80, spd: 90, maxHp: 1200, skill: '흑번창', skillMult: 1.8, desc: '특급주술사 후보생. 초인적 신체능력.' },
  'gojo':      { name: '고조 사토루',   emoji: '🔵', grade: 'S', atk: 100, def: 95, spd: 100, maxHp: 1500, skill: '무량공처', skillMult: 2.0, desc: '최강의 주술사. 무량공처를 구사한다.' },
  'megumi':    { name: '후시구로 메구미', emoji: '⚫', grade: 'A', atk: 85, def: 88, spd: 82, maxHp: 1000, skill: '십종영이', skillMult: 1.6, desc: '식신술을 구사하는 주술사.' },
  'nobara':    { name: '쿠기사키 노바라', emoji: '🌸', grade: 'A', atk: 88, def: 75, spd: 85, maxHp: 950,  skill: '공명',    skillMult: 1.7, desc: '반전술식을 구사하는 주술사.' },
  'nanami':    { name: '나나미 켄토',   emoji: '🟡', grade: 'A', atk: 90, def: 85, spd: 75, maxHp: 1100, skill: '십수할',  skillMult: 1.65, desc: '1급 주술사. 합리적 판단의 소유자.' },
  'sukuna':    { name: '료멘 스쿠나',   emoji: '🔴', grade: 'S', atk: 100, def: 90, spd: 95, maxHp: 2000, skill: '해체·분해', skillMult: 2.2, desc: '저주의 왕. 역대 최강의 저주된 영혼.' },
  'geto':      { name: '게토 스구루',   emoji: '🟢', grade: 'S', atk: 88, def: 82, spd: 80, maxHp: 1300, skill: '저주영조종', skillMult: 1.7, desc: '전 특급 주술사. 저주를 다루는 달인.' },
  'maki':      { name: '마키 젠인',     emoji: '⚪', grade: 'A', atk: 92, def: 88, spd: 92, maxHp: 1050, skill: '저주도구술', skillMult: 1.6, desc: '저주력이 없어도 강한 주술사.' },
  'panda':     { name: '판다',          emoji: '🐼', grade: 'B', atk: 80, def: 90, spd: 70, maxHp: 1100, skill: '팬더 변신', skillMult: 1.5, desc: '저주로 만든 특이체질의 주술사.' },
  'inumaki':   { name: '이누마키 토게', emoji: '🟤', grade: 'B', atk: 85, def: 70, spd: 88, maxHp: 900,  skill: '주술언어', skillMult: 1.55, desc: '주술언어를 구사하는 세미1급 주술사.' },
};

const ENEMIES = [
  { id: 'e1', name: '저급 저주령',   emoji: '👹', hp: 400,  atk: 30, def: 15, xp: 50,  crystals: 10 },
  { id: 'e2', name: '2급 저주령',   emoji: '👺', hp: 700,  atk: 55, def: 30, xp: 120, crystals: 25 },
  { id: 'e3', name: '특급 저주령',  emoji: '💀', hp: 1500, atk: 90, def: 50, xp: 300, crystals: 60 },
];

const GACHA_POOL = [
  { id: 'itadori', rate: 2 },
  { id: 'gojo',    rate: 1 },
  { id: 'geto',    rate: 1.5 },
  { id: 'sukuna',  rate: 1.5 },
  { id: 'megumi',  rate: 8 },
  { id: 'nanami',  rate: 8 },
  { id: 'maki',    rate: 9 },
  { id: 'nobara',  rate: 9 },
  { id: 'panda',   rate: 30 },
  { id: 'inumaki', rate: 30 },
];

const GRADE_COLOR = { S: 0xF5C842, A: 0x7C5CFC, B: 0x4ade80 };
const GRADE_EMOJI = { S: '⭐⭐⭐', A: '⭐⭐', B: '⭐' };

// ─── 플레이어 DB (메모리, 재시작 시 초기화됨) ──────────────
// 실제 서버 운영 시 JSON 파일 또는 SQLite로 교체 권장
const players = new Map();

function getPlayer(userId, username) {
  if (!players.has(userId)) {
    players.set(userId, {
      id: userId,
      name: username,
      crystals: 500,
      xp: 0,
      level: 1,
      owned: ['itadori', 'megumi'], // 기본 지급
      active: 'itadori',
      hp: CHARACTERS['itadori'].maxHp,
      potion: 3,
      wins: 0,
      losses: 0,
    });
  }
  return players.get(userId);
}

function getLevel(xp) { return Math.floor(xp / 200) + 1; }

// ─── 가챠 로직 ─────────────────────────────────────────────
function rollGacha(count = 1) {
  const results = [];
  for (let i = 0; i < count; i++) {
    const total = GACHA_POOL.reduce((s, p) => s + p.rate, 0);
    let roll = Math.random() * total;
    for (const entry of GACHA_POOL) {
      roll -= entry.rate;
      if (roll <= 0) { results.push(entry.id); break; }
    }
  }
  return results;
}

// ─── 전투 로직 ─────────────────────────────────────────────
const activeBattles = new Map();

function calcDmg(atk, def, mult = 1) {
  return Math.max(1, Math.round((atk * (0.8 + Math.random() * 0.4) - def * 0.25) * mult));
}

// ─── EMBED 헬퍼 ───────────────────────────────────────────
function hpBar(current, max, length = 12) {
  const filled = Math.round((current / max) * length);
  return '█'.repeat(Math.max(0, filled)) + '░'.repeat(Math.max(0, length - filled));
}

function profileEmbed(player) {
  const ch = CHARACTERS[player.active];
  const embed = new EmbedBuilder()
    .setTitle(`${ch.emoji} ${player.name}의 프로필`)
    .setColor(GRADE_COLOR[ch.grade] || 0x7c5cfc)
    .addFields(
      { name: '📊 레벨 / XP', value: `LV.**${getLevel(player.xp)}** | ${player.xp} XP`, inline: true },
      { name: '💎 크리스탈', value: `${player.crystals}`, inline: true },
      { name: '🏆 전적', value: `${player.wins}승 ${player.losses}패`, inline: true },
      { name: `${ch.emoji} 활성 캐릭터`, value: `**${ch.name}** [${GRADE_EMOJI[ch.grade]} ${ch.grade}급]\n${ch.desc}`, inline: false },
      { name: '⚔️ 스탯', value: `공격력: **${ch.atk}** | 방어력: **${ch.def}** | 속도: **${ch.spd}**`, inline: false },
      { name: '❤️ HP', value: `${player.hp} / ${ch.maxHp}\n\`${hpBar(player.hp, ch.maxHp)}\``, inline: true },
      { name: '🧪 회복약', value: `${player.potion}개`, inline: true },
      { name: '📦 보유 캐릭터', value: player.owned.map(id => `${CHARACTERS[id].emoji} ${CHARACTERS[id].name}`).join('\n') || '없음', inline: false },
    )
    .setFooter({ text: '!캐릭터 — 파티 변경 | !가챠 — 소환 | !전투 — 전투 시작' });
  return embed;
}

// ─── 명령어 처리 ──────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  const content = message.content.trim();
  const player = getPlayer(message.author.id, message.author.username);

  // ── !도움 ──────────────────────────────────────────────
  if (content === '!도움' || content === '!help') {
    const embed = new EmbedBuilder()
      .setTitle('⚡ 주술회전 RPG봇 — 명령어')
      .setColor(0x7c5cfc)
      .addFields(
        { name: '📋 기본', value: '`!프로필` — 내 정보 확인\n`!도움` — 명령어 목록', inline: false },
        { name: '👤 캐릭터', value: '`!캐릭터` — 보유 캐릭터 목록 & 선택\n`!도감` — 전체 캐릭터 목록', inline: false },
        { name: '🎲 가챠', value: '`!가챠` — 1회 소환 (150 💎)\n`!가챠10` — 10회 소환 (1350 💎)', inline: false },
        { name: '⚔️ 전투', value: '`!전투` — 저주령과 전투 시작\n`!공격` `!술식` `!회복` — 전투 중 행동', inline: false },
      )
      .setFooter({ text: '주술회전 RPG봇 | 💎 처음 시작 시 500 크리스탈 지급!' });
    return message.reply({ embeds: [embed] });
  }

  // ── !프로필 ────────────────────────────────────────────
  if (content === '!프로필') {
    player.level = getLevel(player.xp);
    return message.reply({ embeds: [profileEmbed(player)] });
  }

  // ── !도감 ─────────────────────────────────────────────
  if (content === '!도감') {
    const embed = new EmbedBuilder()
      .setTitle('📖 주술회전 캐릭터 도감')
      .setColor(0x0d0d1a)
      .setDescription(
        Object.entries(CHARACTERS).map(([id, ch]) => {
          const owned = player.owned.includes(id);
          return `${owned ? ch.emoji : '🔒'} **${ch.name}** [${ch.grade}급] — ${owned ? `ATK ${ch.atk} | DEF ${ch.def}` : '미획득'}`;
        }).join('\n')
      )
      .setFooter({ text: '🎲 !가챠로 새 캐릭터를 획득하세요!' });
    return message.reply({ embeds: [embed] });
  }

  // ── !캐릭터 ────────────────────────────────────────────
  if (content === '!캐릭터') {
    if (player.owned.length === 0) return message.reply('보유한 캐릭터가 없습니다! `!가챠`로 소환하세요.');
    const select = new StringSelectMenuBuilder()
      .setCustomId('select_char')
      .setPlaceholder('파티에 편성할 캐릭터 선택')
      .addOptions(player.owned.map(id => ({
        label: CHARACTERS[id].name,
        description: `${CHARACTERS[id].grade}급 | ATK ${CHARACTERS[id].atk} | DEF ${CHARACTERS[id].def}`,
        value: id,
        emoji: CHARACTERS[id].emoji,
        default: player.active === id,
      })));
    const row = new ActionRowBuilder().addComponents(select);
    return message.reply({ content: '👤 **파티 편성** — 활성화할 캐릭터를 선택하세요:', components: [row] });
  }

  // ── !가챠 ─────────────────────────────────────────────
  if (content === '!가챠') {
    if (player.crystals < 150) return message.reply(`💎 크리스탈이 부족합니다! (보유: ${player.crystals} / 필요: 150)`);
    player.crystals -= 150;
    const [result] = rollGacha(1);
    const ch = CHARACTERS[result];
    const isNew = !player.owned.includes(result);
    if (isNew) player.owned.push(result);

    const embed = new EmbedBuilder()
      .setTitle('🎲 주술 소환 결과!')
      .setColor(GRADE_COLOR[ch.grade])
      .setDescription(`${ch.emoji} **${ch.name}** [${GRADE_EMOJI[ch.grade]} ${ch.grade}급]${isNew ? ' ✨**NEW!**' : ' (중복)'}`)
      .addFields(
        { name: '설명', value: ch.desc, inline: false },
        { name: '⚔️ 공격력', value: `${ch.atk}`, inline: true },
        { name: '🛡️ 방어력', value: `${ch.def}`, inline: true },
        { name: '💨 속도',   value: `${ch.spd}`, inline: true },
        { name: '✨ 술식',   value: ch.skill, inline: true },
        { name: '💎 잔여', value: `${player.crystals}`, inline: true },
      )
      .setFooter({ text: isNew ? '새 캐릭터 획득! !캐릭터로 편성하세요.' : '중복 획득 — 크리스탈 50개 보상!' });

    if (!isNew) player.crystals += 50;
    return message.reply({ embeds: [embed] });
  }

  if (content === '!가챠10') {
    if (player.crystals < 1350) return message.reply(`💎 크리스탈이 부족합니다! (보유: ${player.crystals} / 필요: 1350)`);
    player.crystals -= 1350;
    const results = rollGacha(10);
    const newOnes = [];
    let dupCrystals = 0;

    results.forEach(id => {
      if (!player.owned.includes(id)) { player.owned.push(id); newOnes.push(id); }
      else { dupCrystals += 50; player.crystals += 50; }
    });

    const lines = results.map(id => {
      const ch = CHARACTERS[id];
      return `${ch.emoji} **${ch.name}** [${ch.grade}급]${newOnes.includes(id) ? ' ✨**NEW!**' : ''}`;
    });

    const embed = new EmbedBuilder()
      .setTitle('🎲 주술 10회 소환 결과!')
      .setColor(0xF5C842)
      .setDescription(lines.join('\n'))
      .addFields(
        { name: '✨ 신규 획득', value: newOnes.length > 0 ? newOnes.map(id => CHARACTERS[id].name).join(', ') : '없음', inline: true },
        { name: '🔄 중복 보상', value: `+${dupCrystals} 💎`, inline: true },
        { name: '💎 잔여', value: `${player.crystals}`, inline: true },
      );
    return message.reply({ embeds: [embed] });
  }

  // ── !전투 ─────────────────────────────────────────────
  if (content === '!전투') {
    if (activeBattles.has(message.author.id)) return message.reply('⚔️ 이미 전투 중입니다! `!공격` `!술식` `!회복` 명령어를 사용하세요.');
    if (player.hp <= 0) {
      player.hp = Math.round(CHARACTERS[player.active].maxHp * 0.5);
      return message.reply('❤️ HP가 0이라 절반 회복 후 재도전하세요! (다시 `!전투` 입력)');
    }

    const buttons = new ActionRowBuilder().addComponents(
      ...ENEMIES.map(e => new ButtonBuilder().setCustomId(`enemy_${e.id}`).setLabel(`${e.emoji} ${e.name}`).setStyle(ButtonStyle.Secondary))
    );
    return message.reply({ content: '⚔️ **전투** — 상대할 저주령을 선택하세요:', components: [buttons] });
  }

  // ── 전투 중 행동 ────────────────────────────────────────
  const battle = activeBattles.get(message.author.id);

  if (content === '!공격' || content === '!술식' || content === '!회복') {
    if (!battle) return message.reply('현재 전투 중이 아닙니다. `!전투`로 시작하세요.');

    const ch = CHARACTERS[player.active];
    const enemy = battle.enemy;
    const log = [];

    if (content === '!공격') {
      const dmg = calcDmg(ch.atk, enemy.def);
      battle.enemyHp -= dmg;
      log.push(`👊 **${ch.name}**의 공격! → **${enemy.name}**에게 **${dmg}** 피해!`);
    } else if (content === '!술식') {
      if (battle.skillUsed) return message.reply('✨ 술식은 전투당 1회만 사용 가능합니다!');
      const dmg = calcDmg(ch.atk, enemy.def, ch.skillMult);
      battle.enemyHp -= dmg;
      battle.skillUsed = true;
      log.push(`✨ **${ch.name}**의 **${ch.skill}**! → **${enemy.name}**에게 **${dmg}** 피해! (치명타)`);
    } else if (content === '!회복') {
      if (player.potion <= 0) return message.reply('🧪 회복약이 없습니다!');
      const heal = Math.round(ch.maxHp * 0.3);
      player.hp = Math.min(ch.maxHp, player.hp + heal);
      player.potion--;
      log.push(`🧪 회복약 사용! HP **+${heal}** 회복 (남은 약: ${player.potion}개)`);
    }

    // 적 반격
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
      activeBattles.delete(message.author.id);
      log.push(`\n🏆 **${enemy.name}** 처치! +**${enemy.xp}** XP, +**${enemy.crystals}** 💎`);
    } else if (playerDead) {
      player.hp = 0;
      player.losses++;
      activeBattles.delete(message.author.id);
      log.push(`\n💀 **${ch.name}** 쓰러짐... !전투로 재도전 시 HP 일부 회복`);
    }

    const embed = new EmbedBuilder()
      .setTitle(`⚔️ 전투 | ${ch.name} VS ${enemy.emoji} ${enemy.name}`)
      .setColor(playerDead ? 0xe63946 : enemyDead ? 0xF5C842 : 0x7c5cfc)
      .setDescription(log.join('\n'))
      .addFields(
        { name: `${ch.emoji} 내 HP`, value: `${Math.max(0, player.hp)} / ${ch.maxHp}\n\`${hpBar(Math.max(0, player.hp), ch.maxHp)}\``, inline: true },
        { name: `${enemy.emoji} 적 HP`, value: `${Math.max(0, battle.enemyHp)} / ${enemy.hp}\n\`${hpBar(Math.max(0, battle.enemyHp), enemy.hp)}\``, inline: true },
      )
      .setFooter({ text: playerDead || enemyDead ? '전투 종료!' : '!공격 | !술식 (1회) | !회복' });

    return message.reply({ embeds: [embed] });
  }
});

// ─── 버튼 / 셀렉트 인터랙션 ───────────────────────────────
client.on('interactionCreate', async (interaction) => {
  const player = getPlayer(interaction.user.id, interaction.user.username);

  // 캐릭터 선택 메뉴
  if (interaction.isStringSelectMenu() && interaction.customId === 'select_char') {
    const selected = interaction.values[0];
    player.active = selected;
    player.hp = CHARACTERS[selected].maxHp;
    const ch = CHARACTERS[selected];
    await interaction.update({
      content: `${ch.emoji} **${ch.name}** [${ch.grade}급] 파티 편성 완료! HP가 최대로 회복되었습니다.`,
      components: []
    });
  }

  // 적 선택 버튼
  if (interaction.isButton() && interaction.customId.startsWith('enemy_')) {
    const enemyId = interaction.customId.replace('enemy_', '');
    const enemy = ENEMIES.find(e => e.id === enemyId);
    if (!enemy) return;

    const ch = CHARACTERS[player.active];
    activeBattles.set(interaction.user.id, {
      enemy: { ...enemy },
      enemyHp: enemy.hp,
      skillUsed: false,
    });

    const embed = new EmbedBuilder()
      .setTitle(`⚔️ 전투 시작! ${ch.emoji} ${ch.name} VS ${enemy.emoji} ${enemy.name}`)
      .setColor(0xe63946)
      .addFields(
        { name: `${ch.emoji} 내 HP`, value: `${player.hp} / ${ch.maxHp}\n\`${hpBar(player.hp, ch.maxHp)}\``, inline: true },
        { name: `${enemy.emoji} 적 HP`, value: `${enemy.hp} / ${enemy.hp}\n\`${hpBar(enemy.hp, enemy.hp)}\``, inline: true },
      )
      .setFooter({ text: '!공격 | !술식 (1회) | !회복' });

    await interaction.update({ content: '', embeds: [embed], components: [] });
  }
});

// ─── 봇 시작 ──────────────────────────────────────────────
client.once('ready', () => {
  console.log(`✅ ${client.user.tag} 봇 온라인!`);
  client.user.setActivity('주술회전 RPG | !도움', { type: 0 });
});

const TOKEN = process.env.DISCORD_TOKEN || 'YOUR_TOKEN_HERE';
client.login(TOKEN);
