'use strict';

/**
 * STAK Management — Final
 * Node.js + discord.js v14 + PostgreSQL
 *
 * Core persistent data lives in PostgreSQL and is independent from index.js.
 * Set DATABASE_URL in the environment. The bot runs its own lightweight schema migration.
 */

const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  SlashCommandBuilder,
  REST,
  Routes,
  AuditLogEvent,
  Collection,
} = require('discord.js');
const { Pool } = require('pg');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const DATABASE_URL = process.env.DATABASE_URL;
const LEGACY_JSON = path.join(__dirname, 'stak-data.json');

if (!TOKEN || !CLIENT_ID || !GUILD_ID || !DATABASE_URL) {
  console.error('Missing DISCORD_TOKEN, CLIENT_ID, GUILD_ID or DATABASE_URL.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildWebhooks,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember, Partials.User],
});

const DEFAULT_SETTINGS = {
  logging: {
    modChannelId: null,
    auditChannelId: null,
    communityChannelId: null,
    events: {
      mod_kick: true,
      mod_ban: true,
      mod_unban: true,
      mod_timeout: true,
      mod_warning: true,
      message_delete: true,
      message_bulk_delete: true,
      message_edit: true,
      member_join: true,
      member_leave: true,
      voice: true,
      voice_mute_deaf: true,
      streaming: true,
      role_change: true,
      nickname_change: true,
      audit_all: true,
    },
  },
  roles: { communityMemberRoleId: null, botRoleId: null },
  honeypot: { enabled: false, channelId: null, logChannelId: null, inviteChannelId: null, softbans: 0 },
  booster: {
    enabled: false,
    channelId: null,
    messages: [
      'Thank you for boosting the server, {user}. Your support means a lot to STAK!',
      '{user} just boosted the server. Thank you for supporting STAK!',
      'A new boost has arrived from {user}. We appreciate your support!'
    ],
  },
  giveaway: { allowedRoleIds: [] },
  youtube: {
    template: '**{channel}** just uploaded a new video!\n\n**{title}**\n{url}',
    defaultPingRoleId: null,
  },
  security: {
    antiSpam: { enabled: true, maxMessages: 6, intervalMs: 7000, action: 'timeout', timeoutMs: 300000 },
    inviteProtection: { enabled: true, action: 'delete' },
    antiRaid: { enabled: true, joinLimit: 8, windowMs: 15000, action: 'kick' },
    antiNuke: {
      enabled: true,
      windowMs: 15000,
      channelDeleteLimit: 3,
      channelCreateLimit: 6,
      roleDeleteLimit: 3,
      roleCreateLimit: 6,
      banLimit: 4,
      webhookLimit: 4,
      action: 'ban',
    },
  },
  staff: { maxDutyHours: 12 },
};

const AUTO_BACKUP_DEBOUNCE_MS = 10 * 60 * 1000;
const STAFF_MAX_DUTY_MS = 12 * 60 * 60 * 1000;
const YOUTUBE_POLL_MS = 120000;
const MEMORY_LIMITS = { recentMessagesPerChannelBackup: 100 };

let autoBackupTimers = new Map();
let securityBuckets = new Map();
let antiRaidJoins = new Map();
let youtubeTimer = null;
let ready = false;
let interactionDrafts = new Map();

function deepMerge(base, extra) {
  if (!extra || typeof extra !== 'object') return structuredClone(base);
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(extra)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

async function q(text, params = []) {
  return pool.query(text, params);
}

async function one(text, params = []) {
  const result = await q(text, params);
  return result.rows[0] || null;
}

async function migrate() {
  await q(`
    CREATE TABLE IF NOT EXISTS stak_settings (
      guild_id TEXT PRIMARY KEY,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS stak_staff (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS stak_players (
      id BIGSERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      username TEXT NOT NULL,
      user_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS stak_players_guild_username_idx ON stak_players(guild_id, LOWER(username));
    CREATE INDEX IF NOT EXISTS stak_players_guild_user_id_idx ON stak_players(guild_id, user_id);
    CREATE TABLE IF NOT EXISTS stak_cases (
      id BIGSERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      player_id BIGINT NOT NULL REFERENCES stak_players(id) ON DELETE CASCADE,
      case_number BIGINT NOT NULL,
      game_server TEXT NOT NULL,
      reason TEXT NOT NULL,
      evidence TEXT,
      case_type TEXT NOT NULL,
      duration TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      expires_at TIMESTAMPTZ,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_edited_by TEXT,
      last_edited_at TIMESTAMPTZ
    );
    CREATE UNIQUE INDEX IF NOT EXISTS stak_cases_guild_number_idx ON stak_cases(guild_id, case_number);
    CREATE TABLE IF NOT EXISTS stak_case_history (
      id BIGSERIAL PRIMARY KEY,
      case_id BIGINT NOT NULL REFERENCES stak_cases(id) ON DELETE CASCADE,
      editor_id TEXT NOT NULL,
      edited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      old_data JSONB,
      new_data JSONB
    );
    CREATE TABLE IF NOT EXISTS stak_backups (
      id BIGSERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      label TEXT,
      snapshot JSONB NOT NULL,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS stak_backups_guild_kind_idx ON stak_backups(guild_id, kind, created_at DESC);
    CREATE TABLE IF NOT EXISTS stak_messages (
      id BIGSERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      author_id TEXT,
      author_tag TEXT,
      content TEXT,
      created_at TIMESTAMPTZ,
      edited_at TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ,
      attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
      UNIQUE(guild_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS stak_messages_guild_channel_idx ON stak_messages(guild_id, channel_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS stak_giveaways (
      id BIGSERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT,
      prize TEXT NOT NULL,
      winners INTEGER NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL,
      description TEXT,
      requirements TEXT,
      entrants JSONB NOT NULL DEFAULT '[]'::jsonb,
      ended BOOLEAN NOT NULL DEFAULT FALSE,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS stak_youtube_channels (
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      youtube_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      discord_channel_id TEXT NOT NULL,
      ping_role_id TEXT,
      last_video_id TEXT,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      PRIMARY KEY (guild_id, channel_id)
    );
  `);

  const settings = await one('SELECT data FROM stak_settings WHERE guild_id=$1', [GUILD_ID]);
  if (!settings) {
    let legacy = {};
    if (fs.existsSync(LEGACY_JSON)) {
      try { legacy = JSON.parse(fs.readFileSync(LEGACY_JSON, 'utf8')); } catch {}
    }
    const merged = deepMerge(DEFAULT_SETTINGS, legacy.config || {});
    await q('INSERT INTO stak_settings(guild_id,data) VALUES($1,$2)', [GUILD_ID, merged]);
    await migrateLegacyStaff(legacy.staff || {});
    await migrateLegacyPlayers(legacy.players || legacy.playerRecords || {});
  }
}

async function migrateLegacyStaff(staff) {
  if (!staff || typeof staff !== 'object') return;
  for (const [userId, data] of Object.entries(staff)) {
    await q(`INSERT INTO stak_staff(guild_id,user_id,username,data)
             VALUES($1,$2,$2,$3) ON CONFLICT(guild_id,user_id) DO NOTHING`, [GUILD_ID, userId, data]);
  }
}

async function migrateLegacyPlayers(players) {
  if (!players || typeof players !== 'object') return;
  const list = Array.isArray(players) ? players : Object.values(players);
  for (const p of list) {
    if (!p || !p.username) continue;
    const player = await one(`INSERT INTO stak_players(guild_id,username,user_id,created_by)
      VALUES($1,$2,$3,$4) RETURNING id`, [GUILD_ID, String(p.username), p.userId || p.discordId || null, p.createdBy || 'legacy']);
    for (const c of p.cases || []) {
      const caseNumber = Number(c.caseNumber || c.number || 0) || await nextCaseNumber();
      await q(`INSERT INTO stak_cases(guild_id,player_id,case_number,game_server,reason,evidence,case_type,duration,status,expires_at,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`, [
        GUILD_ID, player.id, caseNumber, c.game || c.server || 'Unknown', c.reason || 'Legacy case', c.evidence || null,
        String(c.type || 'Note').toLowerCase(), c.duration || null, c.status || 'active', c.expiresAt ? new Date(c.expiresAt) : null, c.createdBy || p.createdBy || 'legacy'
      ]);
    }
  }
}

async function getSettings() {
  const row = await one('SELECT data FROM stak_settings WHERE guild_id=$1', [GUILD_ID]);
  const data = deepMerge(DEFAULT_SETTINGS, row?.data || {});
  if (!row) await saveSettings(data);
  return data;
}

async function saveSettings(data) {
  await q(`INSERT INTO stak_settings(guild_id,data,updated_at) VALUES($1,$2,NOW())
    ON CONFLICT(guild_id) DO UPDATE SET data=EXCLUDED.data, updated_at=NOW()`, [GUILD_ID, data]);
}

async function patchSettings(patch) {
  const settings = await getSettings();
  const merged = deepMerge(settings, patch);
  await saveSettings(merged);
  return merged;
}

function isAdmin(memberOrInteraction) {
  const member = memberOrInteraction.member;
  return Boolean(member?.permissions?.has(PermissionFlagsBits.Administrator));
}

function isOwner(interaction) {
  return interaction.guild?.ownerId === interaction.user.id;
}

async function isProtected(member) {
  if (!member || !member.roles) return false;
  const settings = await getSettings();
  if (settings.roles.botRoleId && member.roles.cache.has(settings.roles.botRoleId)) return true;
  return false;
}

async function canAutomod(member) {
  if (!member) return false;
  if (member.user?.id === client.user.id) return false;
  if (member.permissions?.has(PermissionFlagsBits.Administrator)) return false;
  if (await isProtected(member)) return false;
  return true;
}

function truncate(text, max = 1024) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0m';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return [d ? `${d}d` : '', h ? `${h}h` : '', m ? `${m}m` : ''].filter(Boolean).join(' ') || '<1m';
}

function randomId(prefix = 'stak') {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function parseDuration(label) {
  const map = {
    'Permanent': null,
    '1 Day': 1,
    '3 Days': 3,
    '7 Days': 7,
    '14 Days': 14,
    '30 Days': 30,
    '90 Days': 90,
    '180 Days': 180,
    '1 Year': 365,
  };
  if (!(label in map)) return undefined;
  if (map[label] === null) return null;
  return new Date(Date.now() + map[label] * 86400000);
}

async function sendLog(type, title, description, fields = []) {
  try {
    const settings = await getSettings();
    let channelId = null;
    if (type === 'mod') channelId = settings.logging.modChannelId;
    if (type === 'audit') channelId = settings.logging.auditChannelId;
    if (type === 'community') channelId = settings.logging.communityChannelId;
    if (!channelId) return;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased()) return;
    const embed = new EmbedBuilder().setTitle(title).setDescription(description || '').setTimestamp();
    if (fields.length) embed.addFields(fields.map(f => ({ name: truncate(f.name, 256), value: truncate(f.value, 1024), inline: f.inline ?? false })));
    await channel.send({ embeds: [embed] });
  } catch (error) {
    console.error('sendLog:', error.message);
  }
}

function eventEnabled(settings, key) {
  return settings.logging.events?.[key] !== false;
}

async function markBackupRelevantChange(reason) {
  if (!ready) return;
  const existing = autoBackupTimers.get(GUILD_ID);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(async () => {
    autoBackupTimers.delete(GUILD_ID);
    try {
      await createBackup(client.guilds.cache.get(GUILD_ID), 'automatic', `Automatic backup after ${reason}`);
    } catch (error) {
      console.error('Automatic backup failed:', error);
    }
  }, AUTO_BACKUP_DEBOUNCE_MS);
  autoBackupTimers.set(GUILD_ID, timer);
}

async function createBackup(guild, kind = 'manual', label = null, actorId = null) {
  if (!guild) throw new Error('Guild unavailable.');
  const channels = [];
  for (const channel of guild.channels.cache.values()) {
    if (!channel.isGuildBased()) continue;
    channels.push({
      id: channel.id,
      name: channel.name,
      type: channel.type,
      parentId: channel.parentId,
      position: channel.rawPosition,
      topic: 'topic' in channel ? channel.topic : null,
      nsfw: 'nsfw' in channel ? channel.nsfw : false,
      rateLimitPerUser: 'rateLimitPerUser' in channel ? channel.rateLimitPerUser : 0,
      bitrate: 'bitrate' in channel ? channel.bitrate : null,
      userLimit: 'userLimit' in channel ? channel.userLimit : null,
      permissionOverwrites: channel.permissionOverwrites?.cache.map(o => ({ id: o.id, type: o.type, allow: o.allow.bitfield.toString(), deny: o.deny.bitfield.toString() })) || [],
    });
  }
  const roles = guild.roles.cache.map(r => ({ id: r.id, name: r.name, color: r.color, hoist: r.hoist, position: r.position, mentionable: r.mentionable, managed: r.managed, permissions: r.permissions.bitfield.toString() }));
  const emojis = guild.emojis.cache.map(e => ({ id: e.id, name: e.name, url: e.url, animated: e.animated, managed: e.managed }));
  const stickers = guild.stickers.cache.map(s => ({ id: s.id, name: s.name, description: s.description, tags: s.tags, format: s.format, url: s.url }));
  const bans = await guild.bans.fetch().catch(() => new Collection());
  const bannedUsers = bans.map(b => ({ id: b.user.id, tag: b.user.tag, reason: b.reason }));
  const members = [];
  try {
    await guild.members.fetch();
    for (const member of guild.members.cache.values()) {
      members.push({ id: member.id, roles: member.roles.cache.filter(r => r.id !== guild.id && !r.managed).map(r => r.id), nickname: member.nickname || null });
    }
  } catch (error) {
    console.warn('Member backup fetch failed:', error.message);
  }
  const recentMessages = [];
  for (const channel of guild.channels.cache.values()) {
    if (!channel.isTextBased() || channel.isDMBased()) continue;
    try {
      const messages = await channel.messages.fetch({ limit: MEMORY_LIMITS.recentMessagesPerChannelBackup });
      recentMessages.push(...messages.map(m => ({
        messageId: m.id, channelId: channel.id, authorId: m.author?.id || null, authorTag: m.author?.tag || null,
        content: m.content || '', createdAt: m.createdAt, editedAt: m.editedAt,
        attachments: [...m.attachments.values()].map(a => ({ name: a.name, url: a.url, size: a.size, contentType: a.contentType })),
      })));
    } catch {}
  }
  const snapshot = {
    version: 2,
    createdAt: new Date().toISOString(),
    guild: {
      id: guild.id, name: guild.name, description: guild.description, verificationLevel: guild.verificationLevel,
      defaultMessageNotifications: guild.defaultMessageNotifications, explicitContentFilter: guild.explicitContentFilter,
      afkChannelId: guild.afkChannelId, afkTimeout: guild.afkTimeout, systemChannelId: guild.systemChannelId,
      rulesChannelId: guild.rulesChannelId, publicUpdatesChannelId: guild.publicUpdatesChannelId,
    },
    roles, channels, emojis, stickers, bannedUsers, members, recentMessages,
    limitations: ['Discord does not allow bots to recreate historical messages as their original authors or preserve original message IDs/timestamps. Recent messages are archived as data for reference/recovery.'],
  };
  const row = await one(`INSERT INTO stak_backups(guild_id,kind,label,snapshot,created_by)
    VALUES($1,$2,$3,$4,$5) RETURNING id,created_at`, [guild.id, kind, label, snapshot, actorId]);
  if (kind === 'automatic') {
    await q(`DELETE FROM stak_backups WHERE guild_id=$1 AND kind='automatic' AND id<>$2`, [guild.id, row.id]);
  }
  return row;
}

async function listBackups(limit = 10) {
  return (await q(`SELECT id,kind,label,created_by,created_at FROM stak_backups WHERE guild_id=$1 ORDER BY created_at DESC LIMIT $2`, [GUILD_ID, limit])).rows;
}

async function getBackup(id) {
  return one('SELECT * FROM stak_backups WHERE guild_id=$1 AND id=$2', [GUILD_ID, id]);
}

async function restoreBackup(guild, backup) {
  const s = backup.snapshot;
  if (!s) throw new Error('Backup snapshot is empty.');
  const roleMap = new Map();
  const existingRoles = guild.roles.cache;
  for (const role of s.roles || []) {
    if (role.managed || role.id === guild.id) continue;
    let target = existingRoles.get(role.id) || existingRoles.find(r => r.name === role.name);
    if (!target) {
      try { target = await guild.roles.create({ name: role.name, color: role.color, hoist: role.hoist, mentionable: role.mentionable, permissions: BigInt(role.permissions) }); } catch {}
    } else {
      try { await target.edit({ name: role.name, color: role.color, hoist: role.hoist, mentionable: role.mentionable, permissions: BigInt(role.permissions) }); } catch {}
    }
    if (target) roleMap.set(role.id, target.id);
  }
  const channelMap = new Map();
  const existingChannels = guild.channels.cache;
  const categories = (s.channels || []).filter(c => c.type === ChannelType.GuildCategory);
  for (const c of categories) {
    let target = existingChannels.get(c.id) || existingChannels.find(x => x.type === c.type && x.name === c.name);
    if (!target) { try { target = await guild.channels.create({ name: c.name, type: c.type, position: c.position }); } catch {} }
    if (target) channelMap.set(c.id, target.id);
  }
  for (const c of (s.channels || []).filter(x => x.type !== ChannelType.GuildCategory)) {
    let target = existingChannels.get(c.id) || existingChannels.find(x => x.type === c.type && x.name === c.name);
    const parentId = c.parentId ? (channelMap.get(c.parentId) || null) : null;
    const payload = { name: c.name, type: c.type, parent: parentId, topic: c.topic ?? undefined, nsfw: c.nsfw, rateLimitPerUser: c.rateLimitPerUser };
    if (!target) { try { target = await guild.channels.create(payload); } catch {} }
    else { try { await target.edit(payload); } catch {} }
    if (target) channelMap.set(c.id, target.id);
  }
  for (const member of s.members || []) {
    const live = await guild.members.fetch(member.id).catch(() => null);
    if (!live) continue;
    const mapped = (member.roles || []).map(id => roleMap.get(id)).filter(Boolean);
    try { await live.roles.set(mapped); } catch {}
  }
  for (const banned of s.bannedUsers || []) {
    if (!guild.bans.cache.has(banned.id)) await guild.members.ban(banned.id, { reason: `Restored from STAK backup ${backup.id}` }).catch(() => null);
  }
}

async function archiveMessage(message, deleted = false) {
  if (!message.guild) return;
  const attachments = [...(message.attachments?.values?.() || [])].map(a => ({ name: a.name, url: a.url, size: a.size, contentType: a.contentType }));
  await q(`INSERT INTO stak_messages(guild_id,message_id,channel_id,author_id,author_tag,content,created_at,edited_at,deleted_at,attachments)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT(guild_id,message_id) DO UPDATE SET content=EXCLUDED.content, edited_at=EXCLUDED.edited_at, deleted_at=EXCLUDED.deleted_at, attachments=EXCLUDED.attachments`, [
    message.guild.id, message.id, message.channelId, message.author?.id || null, message.author?.tag || null,
    message.content || '', message.createdAt || new Date(), message.editedAt || null, deleted ? new Date() : null, attachments
  ]).catch(() => {});
}

async function nextCaseNumber() {
  const row = await one('SELECT COALESCE(MAX(case_number),0)+1 AS next FROM stak_cases WHERE guild_id=$1', [GUILD_ID]);
  return Number(row.next);
}

async function getPlayer(id) {
  return one('SELECT * FROM stak_players WHERE guild_id=$1 AND id=$2', [GUILD_ID, id]);
}

async function searchPlayers(search) {
  if (!search) return (await q('SELECT * FROM stak_players WHERE guild_id=$1 ORDER BY updated_at DESC LIMIT 25', [GUILD_ID])).rows;
  return (await q(`SELECT * FROM stak_players WHERE guild_id=$1 AND (LOWER(username) LIKE LOWER($2) OR user_id=$3) ORDER BY updated_at DESC LIMIT 25`, [GUILD_ID, `%${search}%`, search])).rows;
}

async function createPlayer(username, userId, creator) {
  return one(`INSERT INTO stak_players(guild_id,username,user_id,created_by) VALUES($1,$2,$3,$4) RETURNING *`, [GUILD_ID, username, userId || null, creator]);
}

async function updatePlayer(id, username, userId) {
  return one(`UPDATE stak_players SET username=$1,user_id=$2,updated_at=NOW() WHERE guild_id=$3 AND id=$4 RETURNING *`, [username, userId || null, GUILD_ID, id]);
}

async function createCase(playerId, input, creator) {
  const number = await nextCaseNumber();
  const expires = input.duration ? parseDuration(input.duration) : undefined;
  return one(`INSERT INTO stak_cases(guild_id,player_id,case_number,game_server,reason,evidence,case_type,duration,status,expires_at,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [
    GUILD_ID, playerId, number, input.gameServer, input.reason, input.evidence || null, input.caseType.toLowerCase(), input.duration || null,
    'active', expires === null ? null : (expires || null), creator
  ]);
}

async function getCases(playerId) {
  await expireCases();
  return (await q('SELECT * FROM stak_cases WHERE guild_id=$1 AND player_id=$2 ORDER BY created_at DESC', [GUILD_ID, playerId])).rows;
}

async function getCase(id) {
  await expireCases();
  return one('SELECT * FROM stak_cases WHERE guild_id=$1 AND id=$2', [GUILD_ID, id]);
}

async function editCase(id, data, editorId, admin) {
  const current = await getCase(id);
  if (!current) throw new Error('Case not found.');
  if (!admin && current.created_by !== editorId) throw new Error('You may only edit cases you created.');
  const next = {
    game_server: data.gameServer ?? current.game_server,
    reason: data.reason ?? current.reason,
    evidence: data.evidence ?? current.evidence,
  };
  await q(`INSERT INTO stak_case_history(case_id,editor_id,old_data,new_data) VALUES($1,$2,$3,$4)`, [id, editorId, current, next]);
  return one(`UPDATE stak_cases SET game_server=$1,reason=$2,evidence=$3,updated_at=NOW(),last_edited_by=$4,last_edited_at=NOW() WHERE guild_id=$5 AND id=$6 RETURNING *`, [next.game_server, next.reason, next.evidence, editorId, GUILD_ID, id]);
}

async function expireCases() {
  await q(`UPDATE stak_cases SET status='expired',updated_at=NOW() WHERE guild_id=$1 AND status='active' AND expires_at IS NOT NULL AND expires_at<=NOW()`, [GUILD_ID]);
}

async function getStaff(userId, username = null) {
  let row = await one('SELECT * FROM stak_staff WHERE guild_id=$1 AND user_id=$2', [GUILD_ID, userId]);
  if (!row) {
    row = await one(`INSERT INTO stak_staff(guild_id,user_id,username,data) VALUES($1,$2,$3,$4) RETURNING *`, [GUILD_ID, userId, username || userId, {
      inDuty: false, onBreak: false, shiftStart: null, dutyStartedAt: null, totalTime: 0, shifts: 0, daily: {}, weekly: {}, monthly: {}
    }]);
  }
  return row;
}

async function setStaffData(userId, username, data) {
  await q(`INSERT INTO stak_staff(guild_id,user_id,username,data) VALUES($1,$2,$3,$4)
    ON CONFLICT(guild_id,user_id) DO UPDATE SET username=EXCLUDED.username,data=EXCLUDED.data`, [GUILD_ID, userId, username || userId, data]);
}

function addShiftTime(data) {
  if (!data.inDuty || data.onBreak || !data.shiftStart) return 0;
  const elapsed = Date.now() - Number(data.shiftStart);
  if (elapsed <= 0) return 0;
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const month = now.toISOString().slice(0, 7);
  const week = `${now.getUTCFullYear()}-W${String(getISOWeek(now)).padStart(2, '0')}`;
  data.daily ||= {}; data.monthly ||= {}; data.weekly ||= {};
  data.daily[day] = Number(data.daily[day] || 0) + elapsed;
  data.monthly[month] = Number(data.monthly[month] || 0) + elapsed;
  data.weekly[week] = Number(data.weekly[week] || 0) + elapsed;
  data.totalTime = Number(data.totalTime || 0) + elapsed;
  data.shiftStart = Date.now();
  return elapsed;
}

function getISOWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

async function enforceStaffAutoLogout() {
  const rows = (await q('SELECT * FROM stak_staff WHERE guild_id=$1', [GUILD_ID])).rows;
  for (const row of rows) {
    const data = row.data || {};
    if (!data.inDuty || !data.dutyStartedAt) continue;
    if (Date.now() - Number(data.dutyStartedAt) < STAFF_MAX_DUTY_MS) continue;
    addShiftTime(data);
    data.inDuty = false; data.onBreak = false; data.shiftStart = null; data.dutyStartedAt = null;
    await setStaffData(row.user_id, row.username, data);
  }
}

async function staffOverviewEmbed() {
  const rows = (await q('SELECT * FROM stak_staff WHERE guild_id=$1 ORDER BY username', [GUILD_ID])).rows;
  const active = rows.filter(r => r.data?.inDuty && !r.data?.onBreak);
  const text = active.length ? active.map(r => `• <@${r.user_id}> — ${fmtDuration(Date.now() - Number(r.data.shiftStart || Date.now()))}`).join('\n') : 'No staff members are currently In Duty.';
  return new EmbedBuilder().setTitle('Staff Overview').setDescription(text).setTimestamp();
}

function managementEmbed() {
  return new EmbedBuilder()
    .setTitle('STAK Management')
    .setDescription('Central administration panel for logging, security, backups, automation, staff and case management.')
    .addFields(
      { name: 'Logging', value: 'Configure Mod Logs, Audit Logs, Community Logs and event switches.', inline: true },
      { name: 'Security', value: 'Anti-Raid, Anti-Nuke, Anti-Spam and Discord Invite Protection.', inline: true },
      { name: 'Automation', value: 'Honeypot, Booster Messages, YouTube and Community Member role.', inline: true },
      { name: 'Records', value: 'Player Records, Cases and persistent Staff data.', inline: true },
      { name: 'Backups', value: 'Manual snapshots, automatic 10-minute debounce backups and restore.', inline: true },
      { name: 'Giveaways', value: 'Simple persistent giveaways with role access control.', inline: true },
    );
}

function managementRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('mgmt_logging').setLabel('Logging').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('mgmt_security').setLabel('Security').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('mgmt_automation').setLabel('Automation').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('mgmt_backup').setLabel('Backups').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('mgmt_records').setLabel('Records').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('mgmt_staff').setLabel('Staff').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('mgmt_giveaway').setLabel('Giveaway').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('mgmt_roles').setLabel('Roles').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('mgmt_youtube').setLabel('YouTube').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('mgmt_honeypot').setLabel('Honeypot').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

const commands = [
  new SlashCommandBuilder().setName('management').setDescription('Open the STAK Management dashboard.').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('staffpanel').setDescription('Open the staff dashboard.'),
  new SlashCommandBuilder().setName('casepanel').setDescription('Open Player Records and Case Management.'),
  new SlashCommandBuilder().setName('backup').setDescription('Manage server backups.').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('create').setDescription('Create a manual full backup.'))
    .addSubcommand(s => s.setName('list').setDescription('List backups.'))
    .addSubcommand(s => s.setName('restore').setDescription('Restore a backup.').addIntegerOption(o => o.setName('id').setDescription('Backup ID').setRequired(true))),
  new SlashCommandBuilder().setName('giveaway').setDescription('Create a giveaway.'),
  new SlashCommandBuilder().setName('giveaway-access').setDescription('Configure giveaway creator roles.').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('honeypot').setDescription('Configure the honeypot.').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('youtube').setDescription('Manage YouTube notifications.').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('staff-logout-all').setDescription('Log all staff members out of duty.').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands.map(c => c.toJSON()) });
}

function modalInput(id, label, style = TextInputStyle.Short, required = true, value = '') {
  return new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required).setValue(value).setMaxLength(style === TextInputStyle.Paragraph ? 4000 : 1000));
}

function openCaseCreateModal(interaction, playerId) {
  const modal = new ModalBuilder().setCustomId(`case_create:${playerId}`).setTitle('Create Case');
  modal.addComponents(
    modalInput('game_server', 'Game / Server'),
    modalInput('reason', 'Reason', TextInputStyle.Paragraph),
    modalInput('evidence', 'Evidence', TextInputStyle.Paragraph, false),
    modalInput('case_type', 'Case Type (Warning/Ban/Kick/Note)'),
    modalInput('duration', 'Duration (Permanent / 1 Day / 3 Days / 7 Days / 14 Days / 30 Days / 90 Days / 180 Days / 1 Year)', TextInputStyle.Short, false),
  );
  return interaction.showModal(modal);
}

async function openPlayerPicker(interaction, action = 'view') {
  const players = await searchPlayers('');
  if (!players.length) return interaction.reply({ content: 'No Player Records exist yet.', ephemeral: true });
  const options = players.slice(0, 25).map(p => ({ label: truncate(p.username, 100), value: String(p.id), description: p.user_id ? `User ID: ${p.user_id}` : `Record #${p.id}` }));
  const menu = new StringSelectMenuBuilder().setCustomId(`player_pick:${action}`).setPlaceholder('Select a Player Record').addOptions(options);
  return interaction.reply({ content: 'Select a Player Record:', components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
}

function playerEmbed(player, cases = []) {
  const caseText = cases.length ? cases.slice(0, 10).map(c => `**#${c.case_number}** • ${c.case_type.toUpperCase()} • ${c.status}${c.duration ? ` • ${c.duration}` : ''} • <t:${Math.floor(new Date(c.created_at).getTime()/1000)}:R>`).join('\n') : 'No cases recorded.';
  return new EmbedBuilder().setTitle(`Player Record — ${player.username}`).addFields(
    { name: 'Record ID', value: String(player.id), inline: true },
    { name: 'User ID', value: player.user_id || 'Not provided', inline: true },
    { name: 'Created', value: `<t:${Math.floor(new Date(player.created_at).getTime()/1000)}:F>`, inline: true },
    { name: 'Case History', value: caseText },
  );
}

async function showCasePanel(interaction) {
  const embed = new EmbedBuilder().setTitle('Player Records & Case Management').setDescription('Create, search, view and edit Player Records and Cases. Staff can edit only Cases they created; Administrators can edit all Cases and delete Player Records.');
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('case_create_player').setLabel('Create Player Record').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('case_search_player').setLabel('Search Player').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('case_view_player').setLabel('View Cases').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('case_edit_player').setLabel('Edit Player Record').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('case_delete_player').setLabel('Delete Record').setStyle(ButtonStyle.Danger),
  );
  return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
}

async function createGiveaway(interaction) {
  const modal = new ModalBuilder().setCustomId('giveaway_create').setTitle('Create Giveaway');
  modal.addComponents(
    modalInput('prize', 'Prize'),
    modalInput('winners', 'Number of Winners'),
    modalInput('duration', 'Duration (e.g. 1h, 30m, 2d)'),
    modalInput('description', 'Description', TextInputStyle.Paragraph, false),
    modalInput('requirements', 'Requirements', TextInputStyle.Paragraph, false),
  );
  return interaction.showModal(modal);
}

function parseHumanDuration(input) {
  const m = String(input).trim().match(/^(\d+)\s*(s|m|h|d|w)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const factor = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 }[m[2].toLowerCase()];
  return n * factor;
}

async function finishGiveaway(id) {
  const g = await one('SELECT * FROM stak_giveaways WHERE guild_id=$1 AND id=$2 AND ended=FALSE', [GUILD_ID, id]);
  if (!g) return;
  const channel = await client.channels.fetch(g.channel_id).catch(() => null);
  const entrants = Array.isArray(g.entrants) ? g.entrants : [];
  const winners = [];
  const poolEntries = [...new Set(entrants)];
  while (winners.length < Math.min(g.winners, poolEntries.length)) {
    const index = Math.floor(Math.random() * poolEntries.length);
    winners.push(poolEntries.splice(index, 1)[0]);
  }
  await q('UPDATE stak_giveaways SET ended=TRUE WHERE guild_id=$1 AND id=$2', [GUILD_ID, id]);
  if (channel?.isTextBased()) {
    const mentions = winners.length ? winners.map(id => `<@${id}>`).join(', ') : 'No valid winners.';
    await channel.send({ content: `Giveaway ended: **${g.prize}**\nWinners: ${mentions}` });
  }
}

async function scheduleGiveawayTimers() {
  const rows = (await q('SELECT id,ends_at FROM stak_giveaways WHERE guild_id=$1 AND ended=FALSE', [GUILD_ID])).rows;
  for (const row of rows) {
    const delay = Math.max(0, new Date(row.ends_at).getTime() - Date.now());
    setTimeout(() => finishGiveaway(row.id).catch(console.error), Math.min(delay, 2147483647));
  }
}

async function youtubeRows() {
  return (await q('SELECT * FROM stak_youtube_channels WHERE guild_id=$1 AND enabled=TRUE', [GUILD_ID])).rows;
}

async function fetchYouTubeFeed(channelId) {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`YouTube feed HTTP ${res.status}`);
  return res.text();
}

function parseFeed(xml) {
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => m[1]);
  return entries.map(entry => {
    const id = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1];
    const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, '') || 'New video';
    const url = id ? `https://www.youtube.com/watch?v=${id}` : null;
    const published = entry.match(/<published>([^<]+)<\/published>/)?.[1] || null;
    return { id, title, url, published };
  }).filter(x => x.id);
}

async function pollYouTube() {
  for (const row of await youtubeRows()) {
    try {
      const entries = parseFeed(await fetchYouTubeFeed(row.youtube_id));
      if (!entries.length) continue;
      const newest = entries[0];
      if (!row.last_video_id) {
        await q('UPDATE stak_youtube_channels SET last_video_id=$1 WHERE guild_id=$2 AND channel_id=$3', [newest.id, GUILD_ID, row.channel_id]);
        continue;
      }
      const unseen = [];
      for (const entry of entries) {
        if (entry.id === row.last_video_id) break;
        unseen.push(entry);
      }
      for (const video of unseen.reverse()) {
        const target = await client.channels.fetch(row.discord_channel_id).catch(() => null);
        if (!target?.isTextBased()) continue;
        const settings = await getSettings();
        const ping = row.ping_role_id || settings.youtube.defaultPingRoleId;
        const content = settings.youtube.template.replaceAll('{channel}', row.display_name).replaceAll('{title}', video.title).replaceAll('{url}', video.url || '');
        const embed = new EmbedBuilder().setTitle(video.title).setAuthor({ name: row.display_name }).setURL(video.url).setDescription(content).setThumbnail(`https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`).setTimestamp(video.published ? new Date(video.published) : new Date());
        await target.send({ content: ping ? `<@&${ping}>` : undefined, embeds: [embed], allowedMentions: ping ? { roles: [ping] } : { parse: [] } });
      }
      await q('UPDATE stak_youtube_channels SET last_video_id=$1 WHERE guild_id=$2 AND channel_id=$3', [newest.id, GUILD_ID, row.channel_id]);
    } catch (error) {
      console.error('YouTube poll:', row.youtube_id, error.message);
    }
  }
}

function inviteUrl(message) {
  return `https://discord.com/channels/${message.guild.id}/${message.channel.id}`;
}

async function handleHoneypot(message) {
  const settings = await getSettings();
  if (!settings.honeypot.enabled || settings.honeypot.channelId !== message.channelId) return false;
  if (!(await canAutomod(message.member))) return true;
  const inviteChannel = await client.channels.fetch(settings.honeypot.inviteChannelId || message.channelId).catch(() => null);
  let invite = inviteUrl(message);
  if (inviteChannel?.isTextBased()) {
    try { const inv = await inviteChannel.createInvite({ maxAge: 86400, maxUses: 1, unique: true, reason: 'STAK Honeypot rejoin invite' }); invite = inv.url; } catch {}
  }
  try { await message.author.send(`You triggered the STAK honeypot. If this was accidental, you can rejoin using this invite: ${invite}`); } catch {}
  await message.delete().catch(() => {});
  try { await message.guild.members.ban(message.author.id, { deleteMessageSeconds: 86400, reason: 'STAK Honeypot softban' }); } catch {}
  await message.guild.members.unban(message.author.id, 'STAK Honeypot softban release').catch(() => {});
  settings.honeypot.softbans = Number(settings.honeypot.softbans || 0) + 1;
  await saveSettings(settings);
  await sendLog('mod', 'Honeypot Softban', `<@${message.author.id}> was softbanned for sending a message in the honeypot.`, [{ name: 'Softbans', value: String(settings.honeypot.softbans) }]);
  await refreshHoneypotPanel(message.guild);
  return true;
}

async function refreshHoneypotPanel(guild) {
  const settings = await getSettings();
  if (!settings.honeypot.channelId) return;
  const channel = await client.channels.fetch(settings.honeypot.channelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  const embed = new EmbedBuilder().setTitle('DO NOT SEND MESSAGES IN THIS CHANNEL').setDescription('This channel is dedicated to identifying spam and automated accounts. Any message sent here may trigger an automatic soft ban.').addFields({ name: 'Softbans', value: String(settings.honeypot.softbans || 0), inline: true }).setTimestamp();
  if (settings.honeypot.panelMessageId) {
    const message = await channel.messages.fetch(settings.honeypot.panelMessageId).catch(() => null);
    if (message) return message.edit({ embeds: [embed] }).catch(() => {});
  }
  const sent = await channel.send({ embeds: [embed] }).catch(() => null);
  if (sent) { settings.honeypot.panelMessageId = sent.id; await saveSettings(settings); }
}

async function securityAction(member, action, reason) {
  if (!(await canAutomod(member))) return false;
  try {
    if (action === 'ban') { await member.ban({ deleteMessageSeconds: 86400, reason }); return true; }
    if (action === 'kick') { await member.kick(reason); return true; }
    if (action === 'timeout') { await member.timeout(300000, reason); return true; }
  } catch (error) { console.error('securityAction:', error.message); }
  return false;
}

function bucketKey(kind, id) { return `${kind}:${id}`; }
function recordBucket(kind, id, windowMs) {
  const key = bucketKey(kind, id);
  const now = Date.now();
  const arr = securityBuckets.get(key) || [];
  const fresh = arr.filter(t => now - t < windowMs);
  fresh.push(now);
  securityBuckets.set(key, fresh);
  return fresh.length;
}

async function antiSpam(message) {
  const settings = await getSettings();
  if (!settings.security.antiSpam.enabled || !message.member || !(await canAutomod(message.member))) return;
  const count = recordBucket('spam', message.author.id, settings.security.antiSpam.intervalMs);
  if (count < settings.security.antiSpam.maxMessages) return;
  await message.delete().catch(() => {});
  const action = settings.security.antiSpam.action;
  await securityAction(message.member, action, 'STAK Anti-Spam');
  await sendLog('mod', 'Anti-Spam Action', `<@${message.author.id}> triggered Anti-Spam.`, [{ name: 'Action', value: action }]);
  securityBuckets.delete(bucketKey('spam', message.author.id));
}

async function inviteProtection(message) {
  const settings = await getSettings();
  if (!settings.security.inviteProtection.enabled || !message.content) return false;
  if (!(await canAutomod(message.member))) return false;
  const regex = /(discord\.gg\/|discord(?:app)?\.com\/invite\/)[^\s]+/i;
  if (!regex.test(message.content)) return false;
  await message.delete().catch(() => {});
  if (settings.security.inviteProtection.action !== 'delete') await securityAction(message.member, settings.security.inviteProtection.action, 'STAK Discord Invite Protection');
  await sendLog('mod', 'Discord Invite Blocked', `<@${message.author.id}> posted a Discord invite.`, [{ name: 'Action', value: settings.security.inviteProtection.action }]);
  return true;
}

async function antiRaid(member) {
  const settings = await getSettings();
  if (!settings.security.antiRaid.enabled || !(await canAutomod(member))) return;
  const now = Date.now();
  const arr = antiRaidJoins.get(GUILD_ID) || [];
  const fresh = arr.filter(t => now - t < settings.security.antiRaid.windowMs);
  fresh.push(now);
  antiRaidJoins.set(GUILD_ID, fresh);
  if (fresh.length < settings.security.antiRaid.joinLimit) return;
  await securityAction(member, settings.security.antiRaid.action, 'STAK Anti-Raid: join spike');
  await sendLog('mod', 'Anti-Raid Triggered', `<@${member.id}> was acted on during a join spike.`, [{ name: 'Join count', value: String(fresh.length) }]);
}

async function antiNuke(entry, guild) {
  const settings = await getSettings();
  if (!settings.security.antiNuke.enabled || !entry.executorId) return;
  const executor = await guild.members.fetch(entry.executorId).catch(() => null);
  if (!executor || !(await canAutomod(executor))) return;
  const map = {
    [AuditLogEvent.ChannelDelete]: ['channelDelete', settings.security.antiNuke.channelDeleteLimit],
    [AuditLogEvent.ChannelCreate]: ['channelCreate', settings.security.antiNuke.channelCreateLimit],
    [AuditLogEvent.RoleDelete]: ['roleDelete', settings.security.antiNuke.roleDeleteLimit],
    [AuditLogEvent.RoleCreate]: ['roleCreate', settings.security.antiNuke.roleCreateLimit],
    [AuditLogEvent.MemberBanAdd]: ['ban', settings.security.antiNuke.banLimit],
    [AuditLogEvent.WebhookCreate]: ['webhook', settings.security.antiNuke.webhookLimit],
  };
  const config = map[entry.action];
  if (!config) return;
  const count = recordBucket(`nuke:${config[0]}`, entry.executorId, settings.security.antiNuke.windowMs);
  if (count < config[1]) return;
  await securityAction(executor, settings.security.antiNuke.action, `STAK Anti-Nuke: ${config[0]} threshold exceeded`);
  await sendLog('mod', 'Anti-Nuke Action', `<@${entry.executorId}> exceeded the Anti-Nuke threshold.`, [{ name: 'Event', value: config[0] }, { name: 'Action', value: settings.security.antiNuke.action }]);
  securityBuckets.delete(bucketKey(`nuke:${config[0]}`, entry.executorId));
}

async function handleVoiceUpdate(oldState, newState) {
  const settings = await getSettings();
  if (!eventEnabled(settings, 'voice')) return;
  if (!oldState.channelId && newState.channelId) await sendLog('community', 'Voice Join', `<@${newState.id}> joined <#${newState.channelId}>.`);
  else if (oldState.channelId && !newState.channelId) await sendLog('community', 'Voice Leave', `<@${newState.id}> left <#${oldState.channelId}>.`);
  else if (oldState.channelId !== newState.channelId) await sendLog('community', 'Voice Move', `<@${newState.id}> moved from <#${oldState.channelId}> to <#${newState.channelId}>.`);
  if (eventEnabled(settings, 'voice_mute_deaf')) {
    if (oldState.selfMute !== newState.selfMute) await sendLog('community', newState.selfMute ? 'Self Mute' : 'Self Unmute', `<@${newState.id}> ${newState.selfMute ? 'muted' : 'unmuted'} themselves.`);
    if (oldState.selfDeaf !== newState.selfDeaf) await sendLog('community', newState.selfDeaf ? 'Self Deafen' : 'Self Undeafen', `<@${newState.id}> ${newState.selfDeaf ? 'deafened' : 'undeafened'} themselves.`);
    if (oldState.serverMute !== newState.serverMute) await sendLog('community', newState.serverMute ? 'Server Mute' : 'Server Unmute', `<@${newState.id}> was ${newState.serverMute ? 'server muted' : 'server unmuted'}.`);
    if (oldState.serverDeaf !== newState.serverDeaf) await sendLog('community', newState.serverDeaf ? 'Server Deafen' : 'Server Undeafen', `<@${newState.id}> was ${newState.serverDeaf ? 'server deafened' : 'server undeafened'}.`);
  }
}

async function handlePresence(oldPresence, newPresence) {
  const settings = await getSettings();
  if (!eventEnabled(settings, 'streaming')) return;
  const oldStream = oldPresence?.activities?.find(a => a.type === 1);
  const newStream = newPresence?.activities?.find(a => a.type === 1);
  if (!oldStream && newStream) await sendLog('community', 'Streaming Started', `<@${newPresence.userId}> started streaming${newStream.name ? `: **${newStream.name}**` : ''}.`);
  if (oldStream && !newStream) await sendLog('community', 'Streaming Ended', `<@${newPresence.userId}> stopped streaming.`);
}

client.once('ready', async () => {
  try {
    await migrate();
    await registerCommands();
    await scheduleGiveawayTimers();
    ready = true;
    console.log(`STAK Management ready as ${client.user.tag}`);
    if (!youtubeTimer) youtubeTimer = setInterval(() => pollYouTube().catch(console.error), YOUTUBE_POLL_MS);
    setInterval(() => enforceStaffAutoLogout().catch(console.error), 60000);
    await refreshHoneypotPanel(client.guilds.cache.get(GUILD_ID));
    await pollYouTube().catch(console.error);
  } catch (error) {
    console.error('Startup failed:', error);
    process.exit(1);
  }
});

client.on('messageCreate', async message => {
  if (!message.guild || message.author.bot) return;
  await archiveMessage(message);
  if (await handleHoneypot(message)) return;
  if (await inviteProtection(message)) return;
  await antiSpam(message);
});

client.on('messageUpdate', async (oldMessage, newMessage) => {
  if (!newMessage.guild || newMessage.author?.bot) return;
  await archiveMessage(newMessage);
  const settings = await getSettings();
  if (eventEnabled(settings, 'message_edit')) await sendLog('community', 'Message Edited', `<@${newMessage.author?.id || 'unknown'}> edited a message in <#${newMessage.channelId}>.`, [{ name: 'Before', value: truncate(oldMessage.content || '[unavailable]') }, { name: 'After', value: truncate(newMessage.content || '[empty]') }]);
});

client.on('messageDelete', async message => {
  if (!message.guild) return;
  await archiveMessage(message, true);
  const settings = await getSettings();
  if (eventEnabled(settings, 'message_delete')) await sendLog('community', 'Message Deleted', `A message was deleted in <#${message.channelId}>.`, [{ name: 'Author', value: message.author ? `<@${message.author.id}>` : 'Unknown' }, { name: 'Content', value: truncate(message.content || '[unavailable]') }]);
  await markBackupRelevantChange('message deletion');
});

client.on('messageDeleteBulk', async (messages, channel) => {
  const settings = await getSettings();
  if (eventEnabled(settings, 'message_bulk_delete')) await sendLog('community', 'Bulk Message Delete', `${messages.size} messages were deleted in <#${channel.id}>.`);
  await markBackupRelevantChange('bulk message deletion');
});

client.on('guildMemberAdd', async member => {
  const settings = await getSettings();
  if (settings.roles.communityMemberRoleId) await member.roles.add(settings.roles.communityMemberRoleId).catch(() => {});
  if (eventEnabled(settings, 'member_join')) await sendLog('community', 'Member Joined', `<@${member.id}> joined the server.`);
  await antiRaid(member);
  await markBackupRelevantChange('member join');
});

client.on('guildMemberRemove', async member => {
  const settings = await getSettings();
  if (eventEnabled(settings, 'member_leave')) await sendLog('community', 'Member Left', `${member.user ? `<@${member.id}>` : member.id} left the server.`);
  await markBackupRelevantChange('member leave');
});

client.on('guildMemberUpdate', async (oldMember, newMember) => {
  const settings = await getSettings();
  if (eventEnabled(settings, 'role_change')) {
    const added = newMember.roles.cache.filter(r => !oldMember.roles.cache.has(r.id)).map(r => r.name);
    const removed = oldMember.roles.cache.filter(r => !newMember.roles.cache.has(r.id)).map(r => r.name);
    if (added.length || removed.length) await sendLog('community', 'Member Roles Updated', `<@${newMember.id}> had role changes.`, [{ name: 'Added', value: added.join(', ') || 'None' }, { name: 'Removed', value: removed.join(', ') || 'None' }]);
  }
  if (eventEnabled(settings, 'nickname_change') && oldMember.nickname !== newMember.nickname) await sendLog('community', 'Nickname Changed', `<@${newMember.id}> changed nickname.`, [{ name: 'Before', value: oldMember.nickname || 'None' }, { name: 'After', value: newMember.nickname || 'None' }]);
  await markBackupRelevantChange('member update');
});

client.on('guildMemberUpdate', async (oldMember, newMember) => {
  if (!oldMember.premiumSince && newMember.premiumSince) {
    const settings = await getSettings();
    if (settings.booster.enabled && settings.booster.channelId) {
      const channel = await client.channels.fetch(settings.booster.channelId).catch(() => null);
      if (channel?.isTextBased()) {
        const messages = settings.booster.messages?.length ? settings.booster.messages : ['Thank you for boosting the server, {user}!'];
        const text = messages[Math.floor(Math.random() * messages.length)].replaceAll('{user}', `<@${newMember.id}>`);
        await channel.send({ content: text });
      }
    }
  }
});

client.on('voiceStateUpdate', (oldState, newState) => handleVoiceUpdate(oldState, newState).catch(console.error));
client.on('presenceUpdate', (oldPresence, newPresence) => handlePresence(oldPresence, newPresence).catch(console.error));

client.on('guildBanAdd', async ban => {
  const settings = await getSettings();
  if (eventEnabled(settings, 'mod_ban')) await sendLog('mod', 'Member Banned', `<@${ban.user.id}> was banned.`);
  await markBackupRelevantChange('ban');
});
client.on('guildBanRemove', async ban => {
  const settings = await getSettings();
  if (eventEnabled(settings, 'mod_unban')) await sendLog('mod', 'Member Unbanned', `<@${ban.user.id}> was unbanned.`);
  await markBackupRelevantChange('unban');
});

client.on('guildAuditLogEntryCreate', async (entry, guild) => {
  const settings = await getSettings();
  if (eventEnabled(settings, 'audit_all')) {
    const actionName = String(entry.action).replaceAll('_', ' ');
    if (entry.action === AuditLogEvent.MemberKick && eventEnabled(settings, 'mod_kick')) await sendLog('mod','Member Kicked',`${entry.targetId ? `<@${entry.targetId}>` : 'A member'} was kicked by ${entry.executorId ? `<@${entry.executorId}>` : 'Unknown'}.`);
    if (entry.action === AuditLogEvent.MemberBanAdd && eventEnabled(settings, 'mod_ban')) await sendLog('mod','Member Banned',`${entry.targetId ? `<@${entry.targetId}>` : 'A member'} was banned by ${entry.executorId ? `<@${entry.executorId}>` : 'Unknown'}.`);
    if (entry.action === AuditLogEvent.MemberUpdate && eventEnabled(settings, 'mod_timeout')) {
      const timeoutChange = (entry.changes || []).find(c => c.key === 'communication_disabled_until');
      if (timeoutChange) await sendLog('mod', timeoutChange.new ? 'Member Timed Out' : 'Timeout Removed', `${entry.targetId ? `<@${entry.targetId}>` : 'A member'} had a timeout ${timeoutChange.new ? 'applied' : 'removed'} by ${entry.executorId ? `<@${entry.executorId}>` : 'Unknown'}.`);
    }
    await sendLog('audit', 'Audit Log Event', `**${actionName}** was recorded in the Discord Audit Log.`, [
      { name: 'Executor', value: entry.executorId ? `<@${entry.executorId}>` : 'Unknown' },
      { name: 'Target', value: entry.targetId || 'Unknown' },
      { name: 'Reason', value: entry.reason || 'No reason provided' },
    ]);
  }
  await antiNuke(entry, guild);
  const relevant = [AuditLogEvent.ChannelCreate, AuditLogEvent.ChannelDelete, AuditLogEvent.ChannelUpdate, AuditLogEvent.RoleCreate, AuditLogEvent.RoleDelete, AuditLogEvent.RoleUpdate, AuditLogEvent.MemberRoleUpdate, AuditLogEvent.MemberBanAdd, AuditLogEvent.MemberKick, AuditLogEvent.WebhookCreate, AuditLogEvent.WebhookDelete, AuditLogEvent.WebhookUpdate, AuditLogEvent.GuildUpdate, AuditLogEvent.EmojiCreate, AuditLogEvent.EmojiDelete, AuditLogEvent.EmojiUpdate, AuditLogEvent.StickerCreate, AuditLogEvent.StickerDelete, AuditLogEvent.StickerUpdate];
  if (relevant.includes(entry.action)) await markBackupRelevantChange(`audit event ${entry.action}`);
});

client.on('channelCreate', () => markBackupRelevantChange('channel create').catch(console.error));
client.on('channelDelete', () => markBackupRelevantChange('channel delete').catch(console.error));
client.on('channelUpdate', () => markBackupRelevantChange('channel update').catch(console.error));
client.on('roleCreate', () => markBackupRelevantChange('role create').catch(console.error));
client.on('roleDelete', () => markBackupRelevantChange('role delete').catch(console.error));
client.on('roleUpdate', () => markBackupRelevantChange('role update').catch(console.error));
client.on('emojiCreate', () => markBackupRelevantChange('emoji create').catch(console.error));
client.on('emojiDelete', () => markBackupRelevantChange('emoji delete').catch(console.error));
client.on('emojiUpdate', () => markBackupRelevantChange('emoji update').catch(console.error));
client.on('inviteCreate', () => markBackupRelevantChange('invite create').catch(console.error));
client.on('inviteDelete', () => markBackupRelevantChange('invite delete').catch(console.error));
client.on('guildUpdate', () => markBackupRelevantChange('server update').catch(console.error));

client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'management') {
        if (!isAdmin(interaction)) return interaction.reply({ content: 'Administrator permission required.', ephemeral: true });
        return interaction.reply({ embeds: [managementEmbed()], components: managementRows(), ephemeral: true });
      }
      if (interaction.commandName === 'staffpanel') {
        const embed = await staffOverviewEmbed();
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('staff_in').setLabel('Go In Duty').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('staff_break').setLabel('Break').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('staff_out').setLabel('Go Out Duty').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('staff_feedback').setLabel('Private Feedback').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('staff_refresh').setLabel('Refresh').setStyle(ButtonStyle.Secondary),
        );
        return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
      }
      if (interaction.commandName === 'casepanel') return showCasePanel(interaction);
      if (interaction.commandName === 'backup') {
        if (!isAdmin(interaction)) return interaction.reply({ content: 'Administrator permission required.', ephemeral: true });
        const sub = interaction.options.getSubcommand();
        if (sub === 'create') {
          await interaction.deferReply({ ephemeral: true });
          const row = await createBackup(interaction.guild, 'manual', 'Manual backup', interaction.user.id);
          return interaction.editReply(`Manual backup **#${row.id}** created successfully.`);
        }
        if (sub === 'list') {
          const rows = await listBackups();
          const text = rows.length ? rows.map(r => `**#${r.id}** • ${r.kind} • ${r.label || 'No label'} • <t:${Math.floor(new Date(r.created_at).getTime()/1000)}:R>`).join('\n') : 'No backups found.';
          return interaction.reply({ embeds: [new EmbedBuilder().setTitle('STAK Backups').setDescription(text)], ephemeral: true });
        }
        if (sub === 'restore') {
          await interaction.deferReply({ ephemeral: true });
          const backup = await getBackup(interaction.options.getInteger('id', true));
          if (!backup) return interaction.editReply('Backup not found.');
          await restoreBackup(interaction.guild, backup);
          return interaction.editReply(`Backup **#${backup.id}** restored. Discord API limitations mean historical messages cannot be recreated as their original authors.`);
        }
      }
      if (interaction.commandName === 'giveaway') {
        const settings = await getSettings();
        const allowed = isAdmin(interaction) || settings.giveaway.allowedRoleIds.some(id => interaction.member.roles.cache.has(id));
        if (!allowed) return interaction.reply({ content: 'You are not allowed to create giveaways.', ephemeral: true });
        return createGiveaway(interaction);
      }
      if (interaction.commandName === 'staff-logout-all') {
        if (!isAdmin(interaction)) return interaction.reply({ content: 'Administrator permission required.', ephemeral: true });
        const rows = (await q('SELECT * FROM stak_staff WHERE guild_id=$1', [GUILD_ID])).rows;
        for (const row of rows) { const d = row.data || {}; if (d.inDuty && !d.onBreak) addShiftTime(d); d.inDuty=false; d.onBreak=false; d.shiftStart=null; d.dutyStartedAt=null; await setStaffData(row.user_id,row.username,d); }
        return interaction.reply({ content: 'All staff members have been logged out of duty.', ephemeral: true });
      }
      if (interaction.commandName === 'giveaway-access') {
        const menu = new RoleSelectMenuBuilder().setCustomId('giveaway_access_roles').setPlaceholder('Select allowed giveaway creator roles').setMinValues(0).setMaxValues(10);
        return interaction.reply({ content: 'Select all roles that may create giveaways. Administrators always have access.', components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
      }
      if (interaction.commandName === 'youtube') {
        const modal = new ModalBuilder().setCustomId('youtube_add').setTitle('Add YouTube Channel');
        modal.addComponents(modalInput('youtube_id','YouTube Channel ID'), modalInput('display_name','YouTube Display Name'), modalInput('discord_channel_id','Discord Target Channel ID'), modalInput('ping_role_id','Optional Ping Role ID',TextInputStyle.Short,false));
        return interaction.showModal(modal);
      }
      if (interaction.commandName === 'honeypot') {
        const settings = await getSettings();
        const modal = new ModalBuilder().setCustomId('honeypot_config').setTitle('Honeypot Configuration');
        modal.addComponents(modalInput('channel_id','Honeypot Channel ID',TextInputStyle.Short,true,settings.honeypot.channelId || ''), modalInput('log_channel_id','Log Channel ID',TextInputStyle.Short,false,settings.honeypot.logChannelId || ''), modalInput('invite_channel_id','Invite Channel ID',TextInputStyle.Short,false,settings.honeypot.inviteChannelId || ''));
        return interaction.showModal(modal);
      }
    }

    if (interaction.isButton()) {
      if (interaction.customId === 'mgmt_logging') {
        const embed = new EmbedBuilder().setTitle('Logging Configuration').setDescription('Choose the channel for each log category. Event toggles are stored in PostgreSQL and survive code updates.');
        const rows = [
          new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('set_mod_log').setChannelTypes(ChannelType.GuildText).setPlaceholder('Set Mod Logs Channel')),
          new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('set_audit_log').setChannelTypes(ChannelType.GuildText).setPlaceholder('Set Audit Logs Channel')),
          new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('set_community_log').setChannelTypes(ChannelType.GuildText).setPlaceholder('Set Community Logs Channel')),
          new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('logging_events').setLabel('Edit Event Toggles').setStyle(ButtonStyle.Secondary)),
        ];
        return interaction.reply({ embeds: [embed], components: rows, ephemeral: true });
      }
      if (interaction.customId === 'logging_events') {
        const s = await getSettings();
        const disabled = Object.entries(s.logging.events || {}).filter(([,v]) => v === false).map(([k]) => k).join(', ');
        const modal = new ModalBuilder().setCustomId('logging_events_modal').setTitle('Logging Event Toggles');
        modal.addComponents(modalInput('disabled','Disabled event keys (comma-separated)',TextInputStyle.Paragraph,false,disabled));
        return interaction.showModal(modal);
      }
      if (interaction.customId === 'mgmt_security') {
        const s = await getSettings();
        const embed = new EmbedBuilder().setTitle('Security').setDescription(`Anti-Raid: **${s.security.antiRaid.enabled ? 'Enabled' : 'Disabled'}**\nAnti-Nuke: **${s.security.antiNuke.enabled ? 'Enabled' : 'Disabled'}**\nAnti-Spam: **${s.security.antiSpam.enabled ? 'Enabled' : 'Disabled'}**\nDiscord Invite Protection: **${s.security.inviteProtection.enabled ? 'Enabled' : 'Disabled'}**\n\nProtected Bot Role: ${s.roles.botRoleId ? `<@&${s.roles.botRoleId}>` : 'Not configured'}`);
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('security_toggle_all').setLabel('Toggle Protection').setStyle(ButtonStyle.Danger));
        return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
      }
      if (interaction.customId === 'security_toggle_all') {
        if (!isAdmin(interaction)) return interaction.reply({ content: 'Administrator permission required.', ephemeral: true });
        const s = await getSettings(); const next = !s.security.antiSpam.enabled;
        s.security.antiSpam.enabled = next; s.security.inviteProtection.enabled = next; s.security.antiRaid.enabled = next; s.security.antiNuke.enabled = next; await saveSettings(s);
        return interaction.update({ content: `STAK automated security is now **${next ? 'enabled' : 'disabled'}**.`, embeds: [], components: [] });
      }
      if (interaction.customId === 'mgmt_automation') {
        const row = new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('set_booster_channel').setChannelTypes(ChannelType.GuildText).setPlaceholder('Set Booster Message Channel'));
        return interaction.reply({ content: 'Configure the Booster Message channel. A test message is sent immediately after setting it.', components: [row], ephemeral: true });
      }
      if (interaction.customId === 'mgmt_backup') {
        const rows = await listBackups();
        const text = rows.length ? rows.map(r => `**#${r.id}** • ${r.kind} • ${r.label || 'No label'} • <t:${Math.floor(new Date(r.created_at).getTime()/1000)}:R>`).join('\n') : 'No backups found.';
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('backup_now').setLabel('Create Backup Now').setStyle(ButtonStyle.Success));
        return interaction.reply({ embeds: [new EmbedBuilder().setTitle('Backup Management').setDescription(text)], components: [row], ephemeral: true });
      }
      if (interaction.customId === 'backup_now') {
        if (!isAdmin(interaction)) return interaction.reply({ content: 'Administrator permission required.', ephemeral: true });
        await interaction.deferUpdate();
        const b = await createBackup(interaction.guild, 'manual', 'Manual dashboard backup', interaction.user.id);
        return interaction.followUp({ content: `Backup **#${b.id}** created.`, ephemeral: true });
      }
      if (interaction.customId === 'mgmt_records') return showCasePanel(interaction);
      if (interaction.customId === 'mgmt_staff') return interaction.reply({ content: 'Use `/staffpanel` for staff duty and feedback, and `/staff-logout-all` for administrator logout-all.', ephemeral: true });
      if (interaction.customId === 'mgmt_giveaway') return interaction.reply({ content: 'Use `/giveaway` to create a giveaway. Allowed creator roles are stored in PostgreSQL.', ephemeral: true });
      if (interaction.customId === 'mgmt_roles') {
        const row = new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('set_community_role').setPlaceholder('Set Community Member Role').setMinValues(1).setMaxValues(1));
        const row2 = new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('set_bot_role').setPlaceholder('Set Protected Bot Role').setMinValues(1).setMaxValues(1));
        return interaction.reply({ content: 'Configure the Community Member role and the protected Bot Role. The protected role exempts members from STAK automated moderation.', components: [row,row2], ephemeral: true });
      }
      if (interaction.customId === 'mgmt_youtube') return interaction.reply({ content: 'YouTube channel entries are stored persistently in PostgreSQL. Use `/youtube` as the configuration entry point.', ephemeral: true });
      if (interaction.customId === 'mgmt_honeypot') {
        const row = new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('set_honeypot_channel').setChannelTypes(ChannelType.GuildText).setPlaceholder('Set Honeypot Channel'));
        const row2 = new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('set_honeypot_log').setChannelTypes(ChannelType.GuildText).setPlaceholder('Set Honeypot Log Channel'));
        return interaction.reply({ content: 'Configure the Honeypot channel and log channel.', components: [row,row2], ephemeral: true });
      }
      if (interaction.customId === 'staff_in' || interaction.customId === 'staff_break' || interaction.customId === 'staff_out') {
        const row = await getStaff(interaction.user.id, interaction.user.tag); const d = row.data || {};
        if (interaction.customId === 'staff_in' && !d.inDuty) { d.inDuty=true; d.onBreak=false; d.shiftStart=Date.now(); d.dutyStartedAt=Date.now(); d.shifts=Number(d.shifts||0)+1; }
        if (interaction.customId === 'staff_break' && d.inDuty) { addShiftTime(d); d.onBreak=true; }
        if (interaction.customId === 'staff_out' && d.inDuty) { if (!d.onBreak) addShiftTime(d); d.inDuty=false; d.onBreak=false; d.shiftStart=null; d.dutyStartedAt=null; }
        await setStaffData(interaction.user.id, interaction.user.tag, d);
        return interaction.update({ embeds: [await staffOverviewEmbed()] });
      }
      if (interaction.customId === 'staff_refresh') return interaction.update({ embeds: [await staffOverviewEmbed()] });
      if (interaction.customId === 'staff_feedback') {
        const modal = new ModalBuilder().setCustomId('staff_feedback_modal').setTitle('Private Feedback');
        modal.addComponents(modalInput('feedback', 'Your feedback', TextInputStyle.Paragraph));
        return interaction.showModal(modal);
      }
      if (interaction.customId === 'case_create_player') {
        const modal = new ModalBuilder().setCustomId('player_create').setTitle('Create Player Record');
        modal.addComponents(modalInput('username','Username'), modalInput('user_id','User ID',TextInputStyle.Short,false));
        return interaction.showModal(modal);
      }
      if (interaction.customId === 'case_search_player') {
        const modal = new ModalBuilder().setCustomId('player_search').setTitle('Search Player');
        modal.addComponents(modalInput('search','Username or User ID',TextInputStyle.Short,false));
        return interaction.showModal(modal);
      }
      if (interaction.customId === 'case_view_player') return openPlayerPicker(interaction,'view');
      if (interaction.customId === 'case_edit_player') return openPlayerPicker(interaction,'edit');
      if (interaction.customId === 'case_delete_player') return openPlayerPicker(interaction,'delete');
    }

    if (interaction.isChannelSelectMenu()) {
      const id = interaction.values[0];
      if (interaction.customId === 'set_mod_log') await patchSettings({ logging: { modChannelId: id } });
      if (interaction.customId === 'set_audit_log') await patchSettings({ logging: { auditChannelId: id } });
      if (interaction.customId === 'set_community_log') await patchSettings({ logging: { communityChannelId: id } });
      if (interaction.customId === 'set_honeypot_channel') { await patchSettings({ honeypot: { enabled: true, channelId: id } }); await refreshHoneypotPanel(interaction.guild); }
      if (interaction.customId === 'set_honeypot_log') await patchSettings({ honeypot: { logChannelId: id } });
      if (interaction.customId === 'set_booster_channel') { const settings = await patchSettings({ booster: { enabled: true, channelId: id } }); const channel = await client.channels.fetch(id).catch(() => null); if (channel?.isTextBased()) await channel.send({ content: 'STAK Booster Messages are configured successfully. This is the automatic setup test message.' }); }
      return interaction.reply({ content: 'Configuration saved.', ephemeral: true });
    }

    if (interaction.isRoleSelectMenu()) {
      if (interaction.customId === 'giveaway_access_roles') {
        await patchSettings({ giveaway: { allowedRoleIds: interaction.values } });
        return interaction.reply({ content: 'Giveaway creator roles saved.', ephemeral: true });
      }
      const id = interaction.values[0];
      if (interaction.customId === 'set_community_role') await patchSettings({ roles: { communityMemberRoleId: id } });
      if (interaction.customId === 'set_bot_role') await patchSettings({ roles: { botRoleId: id } });
      return interaction.reply({ content: 'Role configuration saved.', ephemeral: true });
    }

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId.startsWith('case_edit_select:')) {
        const caseId = Number(interaction.values[0]);
        const c = await getCase(caseId);
        if (!c) return interaction.update({ content: 'Case not found.', components: [] });
        if (!isAdmin(interaction) && c.created_by !== interaction.user.id) return interaction.update({ content: 'You may only edit Cases you created.', components: [] });
        const modal = new ModalBuilder().setCustomId(`case_edit_modal:${caseId}`).setTitle(`Edit Case #${c.case_number}`);
        modal.addComponents(modalInput('game_server','Game / Server',TextInputStyle.Short,true,c.game_server), modalInput('reason','Reason',TextInputStyle.Paragraph,true,c.reason), modalInput('evidence','Evidence',TextInputStyle.Paragraph,false,c.evidence || ''));
        return interaction.showModal(modal);
      }
      if (interaction.customId.startsWith('player_pick:')) {
        const action = interaction.customId.split(':')[1];
        const player = await getPlayer(Number(interaction.values[0]));
        if (!player) return interaction.update({ content: 'Player Record not found.', components: [] });
        if (action === 'delete') {
          if (!isAdmin(interaction)) return interaction.update({ content: 'Administrator permission required to delete Player Records.', components: [] });
          await q('DELETE FROM stak_players WHERE guild_id=$1 AND id=$2', [GUILD_ID, player.id]);
          return interaction.update({ content: `Player Record **#${player.id}** deleted.`, components: [] });
        }
        const cases = await getCases(player.id);
        const buttons = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`player_add_case:${player.id}`).setLabel('Add Case').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`player_edit:${player.id}`).setLabel('Edit Player Record').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`case_edit_picker:${player.id}`).setLabel('Edit Case').setStyle(ButtonStyle.Secondary),
        );
        return interaction.update({ embeds: [playerEmbed(player,cases)], components: [buttons] });
      }
      if (interaction.customId.startsWith('giveaway_join:')) {
        const id = Number(interaction.customId.split(':')[1]);
        const g = await one('SELECT * FROM stak_giveaways WHERE guild_id=$1 AND id=$2 AND ended=FALSE', [GUILD_ID,id]);
        if (!g) return interaction.reply({ content: 'This giveaway has ended.', ephemeral: true });
      }
    }

    if (interaction.isButton() && interaction.customId.startsWith('player_add_case:')) return openCaseCreateModal(interaction, Number(interaction.customId.split(':')[1]));
    if (interaction.isButton() && interaction.customId.startsWith('case_edit_picker:')) {
      const playerId = Number(interaction.customId.split(':')[1]);
      const cases = await getCases(playerId);
      if (!cases.length) return interaction.reply({ content: 'This Player Record has no Cases yet.', ephemeral: true });
      const menu = new StringSelectMenuBuilder().setCustomId(`case_edit_select:${playerId}`).setPlaceholder('Select a Case to Edit').addOptions(cases.slice(0,25).map(c => ({ label: `#${c.case_number} — ${c.case_type.toUpperCase()}`, value: String(c.id), description: truncate(c.reason, 100) })));
      return interaction.reply({ content: 'Select the Case you want to edit:', components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
    }
    if (interaction.isButton() && interaction.customId.startsWith('player_edit:')) {
      const id = Number(interaction.customId.split(':')[1]); const player = await getPlayer(id); if (!player) return interaction.reply({content:'Player Record not found.',ephemeral:true});
      const modal = new ModalBuilder().setCustomId(`player_edit_modal:${id}`).setTitle('Edit Player Record');
      modal.addComponents(modalInput('username','Username',TextInputStyle.Short,true,player.username), modalInput('user_id','User ID',TextInputStyle.Short,false,player.user_id || ''));
      return interaction.showModal(modal);
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'player_create') {
        const player = await createPlayer(interaction.fields.getTextInputValue('username').trim(), interaction.fields.getTextInputValue('user_id').trim(), interaction.user.id);
        const embed = playerEmbed(player, []);
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`player_add_case:${player.id}`).setLabel('Create Case').setStyle(ButtonStyle.Success));
        return interaction.reply({ content: 'Player Record created. You can add the first case immediately.', embeds: [embed], components: [row], ephemeral: true });
      }
      if (interaction.customId === 'player_search') {
        const rows = await searchPlayers(interaction.fields.getTextInputValue('search').trim());
        if (!rows.length) return interaction.reply({ content: 'No matching Player Records found.', ephemeral: true });
        return interaction.reply({ embeds: [new EmbedBuilder().setTitle('Player Search').setDescription(rows.map(p => `**#${p.id}** — ${p.username}${p.user_id ? ` • ${p.user_id}` : ''}`).join('\n'))], ephemeral: true });
      }
      if (interaction.customId === 'logging_events_modal') {
        const settings = await getSettings();
        const disabled = interaction.fields.getTextInputValue('disabled').split(',').map(x => x.trim()).filter(Boolean);
        for (const key of Object.keys(settings.logging.events)) settings.logging.events[key] = !disabled.includes(key);
        await saveSettings(settings);
        return interaction.reply({ content: 'Logging event toggles saved.', ephemeral: true });
      }
      if (interaction.customId === 'staff_feedback_modal') {
        const settings = await getSettings(); const channelId = settings.logging.modChannelId;
        if (channelId) await sendLog('mod','Private Staff Feedback',`Feedback from <@${interaction.user.id}>.`,[{name:'Feedback',value:truncate(interaction.fields.getTextInputValue('feedback'),1024)}]);
        return interaction.reply({ content: 'Your feedback has been submitted privately.', ephemeral: true });
      }
      if (interaction.customId === 'youtube_add') {
        const youtubeId = interaction.fields.getTextInputValue('youtube_id').trim();
        const displayName = interaction.fields.getTextInputValue('display_name').trim();
        const discordChannelId = interaction.fields.getTextInputValue('discord_channel_id').trim();
        const pingRoleId = interaction.fields.getTextInputValue('ping_role_id').trim() || null;
        if (!/^[A-Za-z0-9_-]{10,}$/.test(youtubeId)) return interaction.reply({ content: 'The YouTube Channel ID looks invalid.', ephemeral: true });
        await q(`INSERT INTO stak_youtube_channels(guild_id,channel_id,youtube_id,display_name,discord_channel_id,ping_role_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(guild_id,channel_id) DO UPDATE SET youtube_id=EXCLUDED.youtube_id,display_name=EXCLUDED.display_name,discord_channel_id=EXCLUDED.discord_channel_id,ping_role_id=EXCLUDED.ping_role_id,enabled=TRUE`, [GUILD_ID, randomId('yt'), youtubeId, displayName, discordChannelId, pingRoleId]);
        return interaction.reply({ content: 'YouTube notification channel saved.', ephemeral: true });
      }
      if (interaction.customId === 'honeypot_config') {
        const settings = await getSettings();
        settings.honeypot.enabled = true;
        settings.honeypot.channelId = interaction.fields.getTextInputValue('channel_id').trim();
        settings.honeypot.logChannelId = interaction.fields.getTextInputValue('log_channel_id').trim() || null;
        settings.honeypot.inviteChannelId = interaction.fields.getTextInputValue('invite_channel_id').trim() || settings.honeypot.channelId;
        await saveSettings(settings);
        await refreshHoneypotPanel(interaction.guild);
        return interaction.reply({ content: 'Honeypot configuration saved and panel refreshed.', ephemeral: true });
      }
      if (interaction.customId === 'giveaway_create') {
        const settings = await getSettings();
        const allowed = isAdmin(interaction) || settings.giveaway.allowedRoleIds.some(id => interaction.member.roles.cache.has(id));
        if (!allowed) return interaction.reply({content:'You are not allowed to create giveaways.',ephemeral:true});
        const prize = interaction.fields.getTextInputValue('prize').trim(); const winners = Number(interaction.fields.getTextInputValue('winners')); const duration = parseHumanDuration(interaction.fields.getTextInputValue('duration')); const description = interaction.fields.getTextInputValue('description') || ''; const requirements = interaction.fields.getTextInputValue('requirements') || '';
        if (!prize || !Number.isInteger(winners) || winners < 1 || !duration || duration < 1000) return interaction.reply({content:'Invalid giveaway values.',ephemeral:true});
        const ends = new Date(Date.now()+duration);
        const row = await one(`INSERT INTO stak_giveaways(guild_id,channel_id,prize,winners,ends_at,description,requirements,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [GUILD_ID,interaction.channelId,prize,winners,ends,description,requirements,interaction.user.id]);
        const embed = new EmbedBuilder().setTitle('Giveaway').setDescription(description || 'Join the giveaway using the button below.').addFields({name:'Prize',value:prize,inline:true},{name:'Winners',value:String(winners),inline:true},{name:'Ends',value:`<t:${Math.floor(ends.getTime()/1000)}:R>`,inline:true},{name:'Requirements',value:requirements || 'None'}).setFooter({text:`Giveaway #${row.id}`});
        const button = new ButtonBuilder().setCustomId(`giveaway_join:${row.id}`).setLabel('Enter Giveaway').setStyle(ButtonStyle.Success);
        const sent = await interaction.channel.send({embeds:[embed],components:[new ActionRowBuilder().addComponents(button)]});
        await q('UPDATE stak_giveaways SET message_id=$1 WHERE id=$2',[sent.id,row.id]);
        setTimeout(()=>finishGiveaway(row.id).catch(console.error), Math.min(duration,2147483647));
        return interaction.reply({content:`Giveaway #${row.id} created.`,ephemeral:true});
      }
      if (interaction.customId.startsWith('case_create:')) {
        const playerId = Number(interaction.customId.split(':')[1]); const player = await getPlayer(playerId); if (!player) return interaction.reply({content:'Player Record not found.',ephemeral:true});
        const gameServer = interaction.fields.getTextInputValue('game_server').trim(); const reason = interaction.fields.getTextInputValue('reason').trim(); const evidence = interaction.fields.getTextInputValue('evidence').trim(); const caseType = interaction.fields.getTextInputValue('case_type').trim(); const duration = interaction.fields.getTextInputValue('duration').trim();
        if (!['Warning','Ban','Kick','Note'].map(x=>x.toLowerCase()).includes(caseType.toLowerCase())) return interaction.reply({content:'Invalid Case Type. Use Warning, Ban, Kick or Note.',ephemeral:true});
        const normalized = caseType[0].toUpperCase()+caseType.slice(1).toLowerCase();
        if ((normalized === 'Warning' || normalized === 'Ban') && !(duration === 'Permanent' || parseDuration(duration))) {
          return interaction.reply({content:'Warning and Ban cases require a valid duration.',ephemeral:true});
        }
        const c = await createCase(player.id,{gameServer,reason,evidence,caseType:normalized,duration:normalized === 'Kick' || normalized === 'Note' ? null : duration},interaction.user.id);
        const cases = await getCases(player.id);
        await sendLog('mod','Case Created',`Case #${c.case_number} created for **${player.username}**.`,[{name:'Type',value:normalized},{name:'Reason',value:truncate(reason)}]);
        return interaction.reply({content:`Case **#${c.case_number}** added successfully.`,embeds:[playerEmbed(player,cases)],ephemeral:true});
      }
      if (interaction.customId.startsWith('case_edit_modal:')) {
        const id = Number(interaction.customId.split(':')[1]);
        const updated = await editCase(id, { gameServer: interaction.fields.getTextInputValue('game_server').trim(), reason: interaction.fields.getTextInputValue('reason').trim(), evidence: interaction.fields.getTextInputValue('evidence').trim() }, interaction.user.id, isAdmin(interaction));
        const player = await getPlayer(updated.player_id);
        return interaction.reply({ content: `Case **#${updated.case_number}** updated successfully.`, embeds: [playerEmbed(player, await getCases(player.id))], ephemeral: true });
      }
      if (interaction.customId.startsWith('player_edit_modal:')) {
        const id = Number(interaction.customId.split(':')[1]); const player = await getPlayer(id); if (!player) return interaction.reply({content:'Player Record not found.',ephemeral:true});
        const updated = await updatePlayer(id,interaction.fields.getTextInputValue('username').trim(),interaction.fields.getTextInputValue('user_id').trim());
        return interaction.reply({content:`Player Record **#${updated.id}** updated.`,embeds:[playerEmbed(updated,await getCases(updated.id))],ephemeral:true});
      }
    }

    if (interaction.isButton() && interaction.customId.startsWith('giveaway_join:')) {
      const id = Number(interaction.customId.split(':')[1]); const g = await one('SELECT * FROM stak_giveaways WHERE guild_id=$1 AND id=$2 AND ended=FALSE',[GUILD_ID,id]);
      if (!g || new Date(g.ends_at).getTime() <= Date.now()) return interaction.reply({content:'This giveaway has ended.',ephemeral:true});
      const entrants = Array.isArray(g.entrants) ? g.entrants : [];
      if (entrants.includes(interaction.user.id)) return interaction.reply({content:'You are already entered.',ephemeral:true});
      entrants.push(interaction.user.id); await q('UPDATE stak_giveaways SET entrants=$1 WHERE id=$2',[entrants,id]);
      return interaction.reply({content:'You have entered the giveaway.',ephemeral:true});
    }
  } catch (error) {
    console.error('Interaction error:', error);
    if (interaction.replied || interaction.deferred) await interaction.followUp({ content: 'An internal error occurred. Check the bot console for details.', ephemeral: true }).catch(() => {});
    else await interaction.reply({ content: 'An internal error occurred. Check the bot console for details.', ephemeral: true }).catch(() => {});
  }
});

process.on('SIGINT', async () => { await pool.end().catch(() => {}); client.destroy(); process.exit(0); });
process.on('SIGTERM', async () => { await pool.end().catch(() => {}); client.destroy(); process.exit(0); });
process.on('unhandledRejection', error => console.error('Unhandled rejection:', error));
process.on('uncaughtException', error => console.error('Uncaught exception:', error));

client.login(TOKEN).catch(error => { console.error('Discord login failed:', error); process.exit(1); });
