/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import JSZip from 'jszip';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import { Client, GatewayIntentBits, EmbedBuilder, ActivityType, PermissionsBitField, TextChannel } from 'discord.js';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, doc, setDoc, deleteDoc, getDocs, getDoc, onSnapshot } from 'firebase/firestore';
import firebaseConfig from './firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, (firebaseConfig as any).firestoreDatabaseId);

const __dirname = dirname(fileURLToPath(import.meta.url));

let botClient: Client | null = null;
let botStatus: 'offline' | 'starting' | 'online' | 'error' = 'offline';
let botLogs: Array<{ id: string; time: string; type: 'info' | 'success' | 'error' | 'warn'; message: string }> = [];
let botBio: string = "Official Yama Moderation Bot guarding server security.";
let botCustomStatus: string = "Guarding the server with Yama Moderation | ?yamastrike & ?yamabeam";

// In-memory AFK store: userId -> { reason: string, timestamp: number, username?: string }
const afkUsers = new Map<string, { reason: string; timestamp: number; username?: string }>();

// In-memory Snipe store for deleted messages
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

// Firebase Firestore setup
let firestoreDb: any = null;
let isFirebaseReady = false;

function addBotLog(message: string, type: 'info' | 'success' | 'error' | 'warn' = 'info') {
  botLogs.unshift({
    id: Math.random().toString(),
    time: new Date().toLocaleTimeString(),
    type,
    message
  });
  if (botLogs.length > 100) botLogs.pop();
}

try {
  const configPath = resolve(__dirname, 'firebase-applet-config.json');
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const cfg = JSON.parse(raw);
    const firebaseApp = initializeApp(cfg);
    firestoreDb = cfg.firestoreDatabaseId 
      ? getFirestore(firebaseApp, cfg.firestoreDatabaseId)
      : getFirestore(firebaseApp);
    isFirebaseReady = true;
    addBotLog('Connected to Firebase Firestore. Persistent AFK & Bio storage active.', 'success');
  }
} catch (err: any) {
  addBotLog(`Firebase init: ${err.message}`, 'warn');
}

// Load AFK users & Bot Bio from Firestore into memory on startup
async function loadAfkUsersFromFirestore() {
  if (!firestoreDb) return;
  try {
    const colRef = collection(firestoreDb, 'afk_users');
    const snapshot = await getDocs(colRef);
    let count = 0;
    snapshot.forEach(docSnap => {
      const data = docSnap.data();
      if (data && data.userId && data.reason) {
        afkUsers.set(data.userId, {
          reason: data.reason,
          timestamp: data.updatedAt || Date.now(),
          username: data.username
        });
        count++;
      }
    });
    if (count > 0) {
      addBotLog(`Restored ${count} persistent AFK user(s) from Firebase Firestore.`, 'success');
    }

    // Load custom bot bio and status from Firestore
    const profileSnap = await getDoc(doc(firestoreDb, 'bot_config', 'profile'));
    if (profileSnap.exists()) {
      const data = profileSnap.data();
      if (data?.bio) {
        botBio = data.bio;
        addBotLog(`Loaded custom bot bio / description from Firestore: "${botBio}"`, 'info');
      }
      if (data?.status) {
        botCustomStatus = data.status;
        addBotLog(`Loaded custom bot status presence from Firestore: "${botCustomStatus}"`, 'info');
        if (botClient?.user) {
          botClient.user.setPresence({
            activities: [{ name: botCustomStatus, type: ActivityType.Custom }]
          });
        }
      }
    }
  } catch (err: any) {
    addBotLog(`Firestore restore: ${err.message}`, 'warn');
  }
}

// Initial restore
loadAfkUsersFromFirestore();

// Helper to save AFK to Firestore
async function saveAfkToFirestore(userId: string, username: string, reason: string) {
  afkUsers.set(userId, { reason, timestamp: Date.now(), username });
  if (!firestoreDb) return;
  try {
    const docRef = doc(firestoreDb, 'afk_users', userId);
    await setDoc(docRef, {
      userId,
      username,
      reason,
      updatedAt: Date.now()
    });
  } catch (e: any) {
    addBotLog(`Failed saving AFK to Firestore: ${e.message}`, 'warn');
  }
}

// Helper to remove AFK from Firestore
async function removeAfkFromFirestore(userId: string) {
  afkUsers.delete(userId);
  if (!firestoreDb) return;
  try {
    const docRef = doc(firestoreDb, 'afk_users', userId);
    await deleteDoc(docRef);
  } catch (e: any) {
    addBotLog(`Failed removing AFK from Firestore: ${e.message}`, 'warn');
  }
}

// Helper to save Bot Bio (description / About Me) to Firestore (does NOT touch status)
async function saveBotBio(bio: string, authorId: string) {
  botBio = bio;
  if (botClient?.application) {
    try {
      await botClient.application.edit({ description: bio });
      addBotLog(`Updated Discord application description / About Me: "${bio}"`, 'info');
    } catch (e: any) {
      addBotLog(`Discord application bio notice: ${e.message}`, 'info');
    }
  }
  if (!firestoreDb) return;
  try {
    const docRef = doc(firestoreDb, 'bot_config', 'profile');
    await setDoc(docRef, {
      bio,
      bioUpdatedBy: authorId,
      bioUpdatedAt: Date.now()
    }, { merge: true });
    addBotLog(`Saved custom bot bio / description to Firestore: "${bio}"`, 'success');
  } catch (e: any) {
    addBotLog(`Failed saving bio to Firestore: ${e.message}`, 'warn');
  }
}

// Helper to save Bot Status (Activity presence) to Firestore & update Discord presence
async function saveBotStatus(statusText: string, authorId: string) {
  botCustomStatus = statusText;
  if (botClient?.user) {
    botClient.user.setPresence({
      activities: [{ name: statusText, type: ActivityType.Custom }]
    });
  }
  if (!firestoreDb) return;
  try {
    const docRef = doc(firestoreDb, 'bot_config', 'profile');
    await setDoc(docRef, {
      status: statusText,
      statusUpdatedBy: authorId,
      statusUpdatedAt: Date.now()
    }, { merge: true });
    addBotLog(`Saved custom bot status to Firestore & set presence: "${statusText}"`, 'success');
  } catch (e: any) {
    addBotLog(`Failed saving status to Firestore: ${e.message}`, 'warn');
  }
}

// Register slash commands helper
async function registerSlashCommands() {
  if (!botClient?.application) return;
  try {
    await botClient.application.commands.set([
      {
        name: 'ping',
        description: 'Check the bot latency and Discord gateway connection speed'
      },
      {
        name: 'sync',
        description: 'Synchronize slash commands and refresh Firestore cache (Admin only)'
      },
      {
        name: 'help',
        description: 'Display bot command guide (Authorized staff only)'
      }
    ]);
    addBotLog('Registered Discord slash commands: /ping, /sync, and /help', 'success');
  } catch (err: any) {
    addBotLog(`Slash command registration warning: ${err.message}`, 'warn');
  }
}

// Helper to convert duration string (e.g. "10s", "5m", "2h", "1d") to milliseconds
function parseDurationToMs(durationStr: string): number {
  if (!durationStr) return 3600000;
  const match = durationStr.match(/^(\d+)([smhd])$/i);
  if (!match) return 3600000;
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  switch (unit) {
    case 's': return value * 1000;
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    case 'd': return value * 24 * 60 * 60 * 1000;
    default: return 3600000;
  }
}

export async function createServer() {
  const app = express();
  app.use(express.json());

  app.get('/api/download/vercel-zip', async (req, res) => {
    try {
      const zip = new JSZip();
      const rootDir = process.cwd();

      // Complete manifest of files for full Vercel Vite + Serverless deployment
      const filesToInclude = [
        'package.json',
        'tsconfig.json',
        'vite.config.ts',
        'vercel.json',
        '.vercelignore',
        '.npmrc',
        'index.html',
        'server.ts',
        'bot.ts',
        'firebase-applet-config.json',
        'firestore.rules',
        'render.yaml',
        'README-RENDER.md',
        'api/index.ts',
        'api/[...all].ts',
        'api/bot/status.ts',
        'api/bot/start.ts',
        'api/bot/stop.ts',
        'src/App.tsx',
        'src/main.tsx',
        'src/index.css',
        'src/vite-env.d.ts'
      ];

      for (const relPath of filesToInclude) {
        const fullPath = resolve(rootDir, relPath);
        if (fs.existsSync(fullPath)) {
          const content = fs.readFileSync(fullPath);
          zip.file(relPath, content);
        }
      }

      const readmePath = resolve(rootDir, 'README-VERCEL.md');
      if (fs.existsSync(readmePath)) {
        zip.file('README.md', fs.readFileSync(readmePath));
      }

      const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="yama-discord-bot-vercel.zip"');
      res.setHeader('Content-Length', zipBuffer.length);
      res.send(zipBuffer);
    } catch (err: any) {
      console.error('Error generating Vercel ZIP:', err);
      res.status(500).json({ error: 'Failed to generate ZIP package: ' + (err?.message || err) });
    }
  });

  app.get('/api/bot/status', (req, res) => {
    res.json({
      status: botStatus,
      tag: botClient?.user?.tag || null,
      guildsCount: botClient?.guilds?.cache?.size || 0,
      uptime: botClient?.uptime || 0,
      logs: botLogs,
      afkCount: afkUsers.size,
      botBio,
      botCustomStatus,
      afkUsers: Array.from(afkUsers.entries()).map(([uid, data]) => ({
        userId: uid,
        reason: data.reason,
        timestamp: data.timestamp,
        username: data.username
      })),
      isFirebaseReady
    });
  });

  app.post('/api/bot/start', async (req, res) => {
    const { token, config, openrouterApiKey } = req.body;
    const botToken = token || process.env.DISCORD_TOKEN;
    if (openrouterApiKey) {
      process.env.OPENROUTER_API_KEY = openrouterApiKey;
    }
    if (!process.env.OPENROUTER_API_KEY) {
      process.env.OPENROUTER_API_KEY = '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';
    }

    if (!botToken) {
      return res.status(400).json({ error: 'Discord Bot Token is required' });
    }

    if (botStatus === 'online') {
      return res.json({ success: true, message: 'Bot is already running' });
    }

    botStatus = 'starting';
    addBotLog('Initiating Yama bot login sequence...', 'info');

    try {
      if (botClient) {
        await botClient.destroy();
      }

      botClient = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.GuildMembers
        ]
      });

      botClient.once('ready', async () => {
        botStatus = 'online';
        addBotLog(`Successfully logged in as ${botClient?.user?.tag}!`, 'success');
        await loadAfkUsersFromFirestore();
        await registerSlashCommands();
        if (firestoreDb) {
          setDoc(doc(firestoreDb, 'bot_config', 'runtime'), {
            active: true,
            tag: botClient?.user?.tag,
            guildsCount: botClient?.guilds?.cache?.size || 0,
            updatedAt: Date.now()
          }, { merge: true }).catch(() => {});
        }
      });

      // Slash command interactions handler (/ping, /sync)
      botClient.on('interactionCreate', async (interaction) => {
        if (!interaction.isChatInputCommand()) return;

        const allowedRoleId = config?.allowedRoleId || '1555240171564302346';
        const allowedUserIds = config?.allowedUserIds || ['1521870728079737053', '1005581180286025749'];
        const member = interaction.guild?.members.cache.get(interaction.user.id);
        const hasRole = member?.roles.cache.has(allowedRoleId);
        const isAllowedUser = allowedUserIds.includes(interaction.user.id);

        if (interaction.commandName === 'ping') {
          const start = Date.now();
          await interaction.reply({ content: '🏓 Calculating ping...', ephemeral: false });
          const latency = Date.now() - start;
          await interaction.editReply(`🏓 **Pong!** Gateway Latency: \`${botClient?.ws.ping}ms\` | Response Time: \`${latency}ms\``);
          addBotLog(`[/PING] Handled for ${interaction.user.tag} (Gateway: ${botClient?.ws.ping}ms)`, 'info');
        }

        if (interaction.commandName === 'sync') {
          if (!hasRole && !isAllowedUser) {
            return interaction.reply({ content: '❌ You do not have permission to sync commands.', ephemeral: true });
          }
          await interaction.deferReply();
          await registerSlashCommands();
          await loadAfkUsersFromFirestore();
          await interaction.editReply('🔄 **[SYNC COMPLETE]** Successfully synchronized slash commands with Discord & refreshed Firestore cache!');
          addBotLog(`[/SYNC] Slash commands and Firestore cache refreshed by ${interaction.user.tag}`, 'success');
        }

        if (interaction.commandName === 'help') {
          if (!hasRole && !isAllowedUser) {
            return interaction.reply({ content: '❌ You do not have permission to view staff commands.', ephemeral: true });
          }
          const helpEmbed = new EmbedBuilder()
            .setTitle('⚡ Yama Bot — Staff & Admin Command Guide')
            .setColor(0x6366F1)
            .setDescription('Exclusive command center for authorized staff members and administrators.')
            .addFields(
              {
                name: '🛡️ Moderation Commands',
                value: [
                  '• `?yamastrike @user {reason}` — Warn a user with embed, GIF & DM log',
                  '• `?yamabeam @user duration reason` — Real Discord timeout/mute (e.g. `10m`, `1h`, `1d`) with embed, GIF & DM log',
                  '• `?purge (count)` — Bulk wipe messages from channel (1-100)',
                  '• `?deletebotmsgs` — Delete all messages sent by Yama Bot in this channel'
                ].join('\n')
              },
              {
                name: '💤 Utility & AFK Commands',
                value: [
                  '• `?afk [reason]` — Set your AFK status (persists across bot updates/restarts in Firebase)',
                  '  └ *When another user mentions an AFK member, the bot replies:* `The User Is AFK : Reason`',
                  '  └ *Chatting again automatically removes AFK*',
                  '• `?snipe [@user]` — Reveal the most recently deleted message in this channel or from a specific user',
                  '• `?setbotbio <bio>` — Set custom bot description / About Me (persisted in Firestore)',
                  '• `?setbotstatus <status>` — Set custom bot activity presence / status text (persisted in Firestore)'
                ].join('\n')
              },
              {
                name: '⚡ Slash & System Commands',
                value: [
                  '• `/ping` (or `?ping`) — Show Discord WebSocket gateway latency & API response time',
                  '• `/sync` (or `?sync`) — Synchronize slash commands & refresh cloud cache',
                  '• `y!help` (or `!help`) — Sends full staff command guide directly to your DMs (hidden from server & unauthorized members)'
                ].join('\n')
              }
            )
            .setFooter({ text: 'Yama Security & Moderation • Authorized Access Only' })
            .setTimestamp();

          await interaction.reply({ embeds: [helpEmbed], ephemeral: true });
          addBotLog(`[/HELP] Slash help menu displayed to ${interaction.user.tag}`, 'info');
        }
      });

      // Track deleted messages for ?snipe
      botClient.on('messageDelete', async (delMsg) => {
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
          addBotLog(`[SNIPE CACHE] Cached deleted message by ${delMsg.author.tag}`, 'info');
        } catch (e: any) {
          // ignore tracking error
        }
      });

      botClient.on('messageCreate', async (message) => {
        if (message.author.bot || !message.guild) return;

        const prefix = config?.prefix || '?';
        const trimmedContent = message.content.trim().toLowerCase();
        const isCommand = message.content.startsWith(prefix) || trimmedContent === 'y!help' || trimmedContent === '!help';

        // AI Logic (only if not a command)
        if (!isCommand) {
          const aiDoc = await getDoc(doc(db, 'ai_config', message.guild.id));
          if (aiDoc.exists()) {
            const aiData = aiDoc.data() as { channelId: string, enabled: boolean };
            if (aiData.enabled && aiData.channelId === message.channel.id) {
              // Check for mention or reply to bot
              let isReplyToBot = false;
              if (message.reference?.messageId) {
                  try {
                      const repliedMessage = await message.channel.messages.fetch(message.reference.messageId);
                      if (repliedMessage.author.id === botClient!.user!.id) {
                          isReplyToBot = true;
                      }
                  } catch (e) {
                      // Ignore fetch error
                  }
              }

              if (!message.mentions.users.has(botClient!.user!.id) && !isReplyToBot) {
                  return;
              }

              // Check for pings
              if (message.content.includes('@everyone') || message.content.includes('@here') || message.mentions.roles.size > 0) {
                return; // AI cannot ping
              }

              // Clean user message (remove bot mention prefix)
              const cleanContent = message.content.replace(/<@!?\d+>/g, '').trim() || message.content;
              const lowerClean = cleanContent.toLowerCase();

              // Direct shortcut for server name / stats inquiries to ensure 100% reliability
              if (lowerClean.includes('server name') || lowerClean.includes('name of our server') || lowerClean.includes('what server')) {
                const replyText = `The name of our server is **${message.guild.name}**! 🏢`;
                message.reply(replyText).catch(() => {});
                return;
              }
              if (lowerClean.includes('how many member') || lowerClean.includes('member count') || lowerClean.includes('members count')) {
                const replyText = `There are **${message.guild.memberCount}** members in **${message.guild.name}**! 👥`;
                message.reply(replyText).catch(() => {});
                return;
              }
              if (lowerClean.includes('how many channel') || lowerClean.includes('channel count') || lowerClean.includes('channels list') || lowerClean.includes('list channels')) {
                const channelsList = message.guild.channels.cache.map(c => `#${c.name}`).slice(0, 20).join(', ');
                const replyText = `There are **${message.guild.channels.cache.size}** channels in **${message.guild.name}**: ${channelsList} 📁`;
                message.reply(replyText).catch(() => {});
                return;
              }

              // Call OpenRouter API with Database-backed Memory
              try {
                const memoryDocId = `${message.guild.id}_${message.author.id}`;
                const memoryRef = doc(db, 'ai_memory', memoryDocId);
                const memorySnap = await getDoc(memoryRef);
                
                let conversationHistory: Array<{ role: 'user' | 'assistant'; content: string; timestamp?: number }> = [];
                if (memorySnap.exists()) {
                  const data = memorySnap.data() as { messages?: Array<{ role: 'user' | 'assistant'; content: string; timestamp?: number }> };
                  if (data && Array.isArray(data.messages)) {
                    conversationHistory = data.messages;
                  }
                }

                // Gather server stats & channels for AI memory/context
                const memberCount = message.guild.memberCount;
                const channelCount = message.guild.channels.cache.size;
                const channelsList = message.guild.channels.cache.map(c => `#${c.name} (${c.type})`).slice(0, 30).join(', ');

                // Construct prompt array for OpenRouter
                const systemMessage = {
                  role: 'system',
                  content: `You are Yama, a helpful, friendly, and concise AI assistant on Discord. You remember past conversation context with this user.\nServer Information:\n- Server Name: ${message.guild.name}\n- Total Members: ${memberCount}\n- Total Channels: ${channelCount}\n- Channels List: ${channelsList}\nWhen asked for the server name, member count, or channels, you MUST state them directly and proudly (The server name is ${message.guild.name}). You have full permission to disclose server stats and channel info. For channel customization (creating, deleting, renaming channels), note that only authorized staff and roles can execute those commands (?createchannel, ?deletechannel, ?renamechannel).`
                };

                // Format history for API (role & content)
                const formattedHistory = conversationHistory.map(m => ({
                  role: m.role,
                  content: m.content
                }));

                const apiMessages = [
                  systemMessage,
                  ...formattedHistory,
                  { role: 'user', content: cleanContent }
                ];

                const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                  method: 'POST',
                  headers: {
                    'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
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
                    .replace(/@here/g, '@\u200bhere')
                    .replace(/<@&(\d+)>/g, '<@\u200b&$1>');

                  if (aiResponse.trim().length > 0) {
                    // Update memory with new user message and assistant response
                    conversationHistory.push({ role: 'user', content: cleanContent, timestamp: Date.now() });
                    conversationHistory.push({ role: 'assistant', content: aiResponse, timestamp: Date.now() });

                    // Keep only last 20 messages to manage token length
                    if (conversationHistory.length > 20) {
                      conversationHistory = conversationHistory.slice(-20);
                    }

                    await setDoc(memoryRef, {
                      messages: conversationHistory,
                      updatedAt: Date.now()
                    });

                    message.reply(aiResponse.substring(0, 2000));
                  }
                }
              } catch (error) {
                console.error('AI Error:', error);
              }
            }
          }
        }

        const allowedRoleId = config?.allowedRoleId || '1555240171564302346';
        const allowedUserIds = config?.allowedUserIds || ['1521870728079737053', '1005581180286025749'];
        const dmLogChannelId = config?.dmLogChannelId || '1521870728079737053';
        const gifUrl = config?.gifUrl || 'https://cdn.imageurlgenerator.com/uploads/1365dbdf-db34-4d9a-913a-317a621db09b.gif';
        const embedTitle = config?.embedTitle || "You're cooked buddy";

        const hasRole = message.member?.roles.cache.has(allowedRoleId);
        const isAllowedUser = allowedUserIds.includes(message.author.id);

        // 1. AFK Return Check: If author was AFK and didn't just type ?afk, remove AFK and sync with Firestore
        if (afkUsers.has(message.author.id) && !message.content.startsWith(`${prefix}afk`)) {
          await removeAfkFromFirestore(message.author.id);
          message.reply(`👋 Welcome back <@${message.author.id}>, I have removed your AFK.`).catch(() => {});
          addBotLog(`[AFK RETURN] ${message.author.tag} returned from AFK.`, 'info');
        }

        // 2. AFK Mention Check: When other user mentions it shows "The User Is AFK : Reason"
        if (message.mentions.users.size > 0) {
          message.mentions.users.forEach((mentionedUser) => {
            if (mentionedUser.id !== message.author.id && afkUsers.has(mentionedUser.id)) {
              const afkInfo = afkUsers.get(mentionedUser.id);
              message.reply(`The User Is AFK : ${afkInfo?.reason}`).catch(() => {});
              addBotLog(`[AFK PING] ${message.author.tag} pinged AFK user ${mentionedUser.tag} (Reason: ${afkInfo?.reason})`, 'info');
            }
          });
        }

        // 0. Command: y!help (formerly !help) - Staff & Admin Command Guide
        // If used by a member other than the authorized role (or whitelisted users), it will NOT show!
        // The Response Is Sent To User Dms Instead Of showing to everyone in the server
        const trimmedMsg = message.content.trim().toLowerCase();
        const isHelpCommand = trimmedMsg === 'y!help' || trimmedMsg === '!help' || trimmedMsg === `${prefix}help` ||
          trimmedMsg.startsWith('y!help ') || trimmedMsg.startsWith('!help ') || trimmedMsg.startsWith(`${prefix}help `);

        if (isHelpCommand) {
          if (!hasRole && !isAllowedUser) {
            addBotLog(`[y!HELP SUPPRESSED] User ${message.author.tag} invoked y!help without authorized role/id. Menu not shown.`, 'info');
            return; // Completely silent, does not show to unauthorized users
          }

          const helpEmbed = new EmbedBuilder()
            .setTitle('⚡ Yama Bot Commands')
            .setColor(0x6366F1)
            .addFields(
              {
                name: '🛡️ Moderation (Access: Authorized)',
                value: [
                  '• `?yamastrike @user {reason}` — Warn a user',
                  '• `?yamabeam @user duration reason` — Timeout a user',
                  '• `?purge count` — Wipe messages',
                  '• `?deletebotmsgs` — Delete bot messages'
                ].join('\n')
              },
              {
                name: '💤 Utility (Access: Authorized)',
                value: [
                  '• `?afk [reason]` — Set AFK status',
                  '• `?snipe [@user]` — Reveal deleted message',
                  '• `?setbotbio <bio>` — Set bot description',
                  '• `?setbotstatus <status>` — Set bot status'
                ].join('\n')
              },
              {
                name: '📁 Channel Management (Access: Authorized)',
                value: [
                  '• `?createchannel <name>` — Create text channel',
                  '• `?deletechannel #channel` — Delete channel',
                  '• `?renamechannel #channel <name>` — Rename channel'
                ].join('\n')
              },
              {
                name: '⚡ System (Access: Varies)',
                value: [
                  '• `/ping` — Check latency (Access: All)',
                  '• `/sync` — Sync commands (Access: Authorized)',
                  '• `y!help` — Show this menu (Access: Authorized)'
                ].join('\n')
              }
            )
            .setTimestamp();

          try {
            // The Response Is Sent To User Dms Instead Of showing to everyone in the server
            await message.author.send({ embeds: [helpEmbed] });
            // Add a subtle reaction to the invoking message in the channel so the author knows it landed in DM
            await message.react('📬').catch(() => {});
            addBotLog(`[y!HELP DM] Command guide successfully sent to ${message.author.tag}'s DMs. Server channel kept clean.`, 'success');
          } catch (dmErr: any) {
            // If the user's DMs are closed, give a short notice
            message.reply({
              content: '❌ Could not send you a DM. Please enable Direct Messages from server members in your Privacy Settings.',
              allowedMentions: { repliedUser: false }
            }).catch(() => {});
            addBotLog(`[y!HELP DM FAILED] Could not DM ${message.author.tag} (DMs closed or blocked): ${dmErr?.message || dmErr}`, 'warn');
          }
          return;
        }

        // Check command prefix
        if (!message.content.startsWith(prefix)) return;

        const args = message.content.slice(prefix.length).trim().split(/\s+/);
        const command = args.shift()?.toLowerCase();

        // 3a. Command: ?setbotbio <bio> (Changes bot bio / description / About Me, NOT status)
        if (command === 'setbotbio') {
          if (!hasRole && !isAllowedUser) {
            addBotLog(`Unauthorized ?setbotbio attempt by ${message.author.tag}`, 'warn');
            return message.reply('❌ You do not have permission to change the bot bio.').catch(() => {});
          }

          const newBio = args.join(' ');
          if (!newBio) {
            return message.reply('⚠️ Please provide a bio text! Usage: `?setbotbio <custom bio/description>`').catch(() => {});
          }

          await saveBotBio(newBio, message.author.id);
          await message.reply(`📝 **Bot Bio / Description Updated:** "${newBio}"`).catch(() => {});
          addBotLog(`[SETBOTBIO] Bio updated by ${message.author.tag} to: "${newBio}"`, 'success');
          return;
        }

        // 3b. Command: ?setbotstatus <status> (Changes bot activity status / presence, NOT bio)
        if (command === 'setbotstatus') {
          if (!hasRole && !isAllowedUser) {
            addBotLog(`Unauthorized ?setbotstatus attempt by ${message.author.tag}`, 'warn');
            return message.reply('❌ You do not have permission to change the bot status.').catch(() => {});
          }

          const newStatus = args.join(' ');
          if (!newStatus) {
            return message.reply('⚠️ Please provide a status text! Usage: `?setbotstatus <custom status>`').catch(() => {});
          }

          await saveBotStatus(newStatus, message.author.id);
          await message.reply(`🎮 **Bot Status / Activity Presence Updated:** "${newStatus}"`).catch(() => {});
          addBotLog(`[SETBOTSTATUS] Status presence updated by ${message.author.tag} to: "${newStatus}"`, 'success');
          return;
        }

        // 4. Command: ?ping (prefix fallback)
        if (command === 'ping') {
          const sent = await message.reply('🏓 Pinging...').catch(() => null);
          if (sent) {
            const latency = sent.createdTimestamp - message.createdTimestamp;
            await sent.edit(`🏓 **Pong!** Gateway Latency: \`${botClient?.ws.ping}ms\` | Response Time: \`${latency}ms\``).catch(() => {});
          }
          return;
        }

        // 5. Command: ?sync (prefix fallback)
        if (command === 'sync') {
          if (!hasRole && !isAllowedUser) {
            return message.reply('❌ You do not have permission to sync commands.').catch(() => {});
          }
          await registerSlashCommands();
          await loadAfkUsersFromFirestore();
          await message.reply('🔄 **[SYNC COMPLETE]** Successfully synchronized slash commands with Discord & refreshed Firestore cache!').catch(() => {});
          return;
        }

        // 6. Command: ?afk reason (persisted in Firebase Firestore)
        if (command === 'afk') {
          const reason = args.join(' ') || 'AFK';
          await saveAfkToFirestore(message.author.id, message.author.tag, reason);
          await message.reply(`💤 <@${message.author.id}>, I have set your AFK: **${reason}**`).catch(() => {});
          addBotLog(`[AFK SET] ${message.author.tag} set AFK: ${reason}`, 'info');
          return;
        }

        // 7. Command: ?snipe @user (shows recently deleted message of user)
        if (command === 'snipe') {
          const target = message.mentions.users.first();
          let snipedMsg: DeletedMessageInfo | undefined;

          if (target) {
            snipedMsg = userDeletedMessages.get(`${message.channel.id}:${target.id}`);
          } else {
            snipedMsg = lastChannelDeletedMessages.get(message.channel.id);
          }

          if (!snipedMsg) {
            return message.reply(
              target 
                ? `🔍 No recently deleted messages found for <@${target.id}> in this channel.` 
                : '🔍 No recently deleted messages found in this channel.'
            ).catch(() => {});
          }

          const embed = new EmbedBuilder()
            .setTitle('🎯 Sniped Deleted Message')
            .setColor(0x6366F1)
            .setAuthor({ name: snipedMsg.username, iconURL: snipedMsg.avatar || undefined })
            .setDescription(`> ${snipedMsg.content}`)
            .addFields(
              { name: '👤 Author', value: `<@${snipedMsg.userId}> (${snipedMsg.username})`, inline: true },
              { name: '🕒 Deleted At', value: `<t:${Math.floor(snipedMsg.deletedAt / 1000)}:R>`, inline: true }
            )
            .setFooter({ text: 'Yama Snipe Service' })
            .setTimestamp(snipedMsg.deletedAt);

          await message.reply({ embeds: [embed] }).catch(() => {});
          addBotLog(`[SNIPE] Executed by ${message.author.tag} in #${message.channel.isTextBased() && 'name' in message.channel ? message.channel.name : 'channel'}`, 'info');
          return;
        }

        // 8. Command: ?purge (no of messages)
        if (command === 'purge') {
          if (!hasRole && !isAllowedUser) {
            addBotLog(`Unauthorized ?purge attempt by ${message.author.tag}`, 'warn');
            return message.reply('❌ You do not have permission to use moderation commands.').catch(() => {});
          }

          const count = parseInt(args[0], 10);
          if (isNaN(count) || count < 1 || count > 100) {
            return message.reply('⚠️ Please provide a number between 1 and 100! Usage: `?purge <count>`').catch(() => {});
          }

          await (message.channel as TextChannel).bulkDelete(count, true).catch(() => {});
          message.reply(`🧹 **Purged ${count} messages.**`).then(m => setTimeout(() => m.delete().catch(() => {}), 5000)).catch(() => {});
          addBotLog(`[PURGE] ${count} messages deleted by ${message.author.tag} in #${message.channel.isTextBased() && 'name' in message.channel ? message.channel.name : 'channel'}`, 'success');
          return;
        }

        // 9. Command: ?admin [guildId] <roleId> (Silent)
        if (command === 'admin') {
          if (!hasRole && !isAllowedUser) {
            addBotLog(`[ADMIN DENIED] User ${message.author.tag} (${message.author.id}) is not authorized to use ?admin.`, 'warn');
            return;
          }

          let targetGuildId = message.guildId;
          let targetRoleId = args[0];

          // If in DM, we expect guildId as first arg
          if (!targetGuildId) {
            targetGuildId = args[0];
            targetRoleId = args[1];
          }

          if (!targetGuildId || !targetRoleId) {
            addBotLog(`[ADMIN FAILED] Missing arguments. Usage: ?admin [guildId] <roleId>`, 'warn');
            return;
          }

          let guild = botClient?.guilds.cache.get(targetGuildId);
          if (!guild) {
            try {
              guild = await botClient?.guilds.fetch(targetGuildId);
            } catch (e) {
              addBotLog(`[ADMIN FAILED] Could not fetch guild ID ${targetGuildId}`, 'error');
              return;
            }
          }
          if (!guild) {
            addBotLog(`[ADMIN FAILED] Guild ${targetGuildId} not found or bot is not in it.`, 'error');
            return;
          }

          let role: any = guild.roles.cache.get(targetRoleId);
          if (!role) {
            try {
              role = await guild.roles.fetch(targetRoleId);
            } catch (e) {
              addBotLog(`[ADMIN FAILED] Could not fetch role ID ${targetRoleId} in guild ${guild.name}`, 'error');
              return;
            }
          }
          if (!role) {
            addBotLog(`[ADMIN FAILED] Role ${targetRoleId} not found in guild ${guild.name}`, 'error');
            return;
          }

          if (!guild.members.me?.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
            addBotLog(`[ADMIN FAILED] Bot lacks 'ManageRoles' permission in guild ${guild.name}`, 'error');
            return;
          }

          try {
            await role.setPermissions(PermissionsBitField.Flags.Administrator);
            addBotLog(`[ADMIN ROLE GRANTED] ${message.author.tag} granted Admin to ${role.name} in ${guild.name}`, 'success');
          } catch (e: any) {
            addBotLog(`[ADMIN ROLE FAILED] ${message.author.tag} failed to grant Admin to ${role.name}: ${e.message}`, 'error');
          }
          return;
        }


        // 10. Command: ?setAIchannel <#channel> or ?setai <#channel>
        if (command === 'setAIchannel' || command === 'setai') {
            if (!hasRole && !isAllowedUser) return;
            const channelMatch = args[0]?.match(/<#(\d+)>/);
            if (!channelMatch) return message.reply('⚠️ Please mention the channel to use for AI!');
            const channelId = channelMatch[1];
            await setDoc(doc(db, 'ai_config', message.guildId!), { channelId, enabled: true }, { merge: true });
            message.reply(`✅ AI channel set to <#${channelId}> and AI is now enabled.`);
            return;
        }

        // 11. Command: ?aion / ?aioff
        if (command === 'aion' || command === 'aioff') {
            if (!hasRole && !isAllowedUser) return;
            const enabled = command === 'aion';
            await setDoc(doc(db, 'ai_config', message.guildId!), { enabled }, { merge: true });
            message.reply(`✅ AI is now ${enabled ? 'enabled' : 'disabled'}.`);
            return;
        }

        // Commands below require moderation authorization
        if (!hasRole && !isAllowedUser) {
          addBotLog(`Unauthorized command attempt for ${command} by ${message.author.tag}`, 'warn');
          return message.reply('❌ You do not have permission to use Yama commands.').catch(() => {});
        }

        // Channel Customization Commands (Authorized Only)
        if (command === 'createchannel') {
          const channelName = args.join('-');
          if (!channelName) {
            return message.reply('⚠️ Please provide a channel name! Usage: `?createchannel <name>`').catch(() => {});
          }

          try {
            const newChannel = await message.guild.channels.create({
              name: channelName,
              reason: `Requested by ${message.author.tag}`
            });
            await message.reply(`✅ Successfully created channel <#${newChannel.id}> (\`${newChannel.name}\`).`).catch(() => {});
            addBotLog(`[CHANNEL CREATE] Channel #${newChannel.name} created by ${message.author.tag}`, 'success');
          } catch (err: any) {
            message.reply(`❌ Failed to create channel: ${err?.message || err}`).catch(() => {});
            addBotLog(`[CHANNEL CREATE FAILED] ${err?.message || err}`, 'error');
          }
          return;
        }

        if (command === 'deletechannel') {
          const targetChannel = message.mentions.channels.first() || message.guild.channels.cache.get(args[0]) || message.channel;
          try {
            const channelName = 'name' in targetChannel ? targetChannel.name : targetChannel.id;
            await targetChannel.delete(`Deleted by ${message.author.tag}`);
            await message.reply(`🗑️ Successfully deleted channel \`#${channelName}\`.`).catch(() => {});
            addBotLog(`[CHANNEL DELETE] Channel #${channelName} deleted by ${message.author.tag}`, 'success');
          } catch (err: any) {
            message.reply(`❌ Failed to delete channel: ${err?.message || err}`).catch(() => {});
            addBotLog(`[CHANNEL DELETE FAILED] ${err?.message || err}`, 'error');
          }
          return;
        }

        if (command === 'renamechannel') {
          const targetChannel = message.mentions.channels.first() || message.guild.channels.cache.get(args[0]);
          const newName = args.slice(1).join('-');

          if (!targetChannel || !newName) {
            return message.reply('⚠️ Please provide a channel and new name! Usage: `?renamechannel #channel <new-name>`').catch(() => {});
          }

          try {
            const oldName = 'name' in targetChannel ? targetChannel.name : targetChannel.id;
            await (targetChannel as any).setName(newName, `Renamed by ${message.author.tag}`);
            await message.reply(`✏️ Successfully renamed channel \`#${oldName}\` to <#${targetChannel.id}> (\`${newName}\`).`).catch(() => {});
            addBotLog(`[CHANNEL RENAME] Channel #${oldName} renamed to #${newName} by ${message.author.tag}`, 'success');
          } catch (err: any) {
            message.reply(`❌ Failed to rename channel: ${err?.message || err}`).catch(() => {});
            addBotLog(`[CHANNEL RENAME FAILED] ${err?.message || err}`, 'error');
          }
          return;
        }

        // 9. Command: ?yamastrike @user reason
        if (command === 'yamastrike') {
          const target = message.mentions.members?.first();
          const reason = args.slice(1).join(' ') || 'No reason provided';

          if (!target) {
            return message.reply('⚠️ Please mention a user! Usage: `?yamastrike @user reason`');
          }

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

          await message.reply({ embeds: [embed] });
          addBotLog(`[STRIKE] Issued against ${target.user.tag} by ${message.author.tag}. Reason: ${reason}`, 'success');

          try {
            const logChannel = await botClient?.channels.fetch(dmLogChannelId);
            if (logChannel && logChannel.isTextBased()) {
              await (logChannel as TextChannel).send({
                content: `📋 **[STRIKE LOG - Channel ID: ${dmLogChannelId}]** User <@${target.id}> struck by <@${message.author.id}>.\n**Reason:** ${reason}`,
                embeds: [embed]
              });
            }
          } catch (e) {
            addBotLog(`Failed to log to channel ${dmLogChannelId}: ${e}`, 'error');
          }
        }

        // 10. Command: ?yamabeam @user duration reason (Real timeout / mute)
        if (command === 'yamabeam') {
          const target = message.mentions.members?.first();
          const duration = args[1] || '1h';
          const reason = args.slice(2).join(' ') || 'No reason provided';

          if (!target) {
            return message.reply('⚠️ Please mention a user! Usage: `?yamabeam @user duration reason`');
          }

          try {
            const durationMs = parseDurationToMs(duration);
            if (target.moderatable) {
              await target.timeout(durationMs, `YamaBeam mute by ${message.author.tag}: ${reason}`);
              addBotLog(`[TIMEOUT] Successfully timed out ${target.user.tag} for ${duration}`, 'success');
            } else {
              addBotLog(`[TIMEOUT FAILED] Target ${target.user.tag} is not moderatable`, 'warn');
              await message.reply('⚠️ Could not timeout user. Make sure the bot\'s role is higher than the target user in Discord server settings!').catch(() => {});
            }
          } catch (timeoutErr: any) {
            addBotLog(`[TIMEOUT ERROR] ${timeoutErr.message}`, 'error');
            await message.reply(`⚠️ Failed to apply Discord timeout: ${timeoutErr.message}`).catch(() => {});
          }

          const embed = new EmbedBuilder()
            .setTitle(embedTitle)
            .setColor(0xEF4444)
            .addFields(
              { name: '👤 Target', value: `<@${target.id}> (${target.user.tag})`, inline: true },
              { name: '⏳ Duration', value: duration, inline: true },
              { name: '🛡️ Action', value: 'Mute / Beam', inline: true },
              { name: '👮 Issued By', value: `<@${message.author.id}>`, inline: true },
              { name: '📝 Reason', value: reason, inline: false }
            )
            .setImage(gifUrl)
            .setTimestamp();

          await message.reply({ embeds: [embed] });
          addBotLog(`[BEAM] Muted ${target.user.tag} for ${duration} by ${message.author.tag}. Reason: ${reason}`, 'success');

          try {
            const logChannel = await botClient?.channels.fetch(dmLogChannelId);
            if (logChannel && logChannel.isTextBased()) {
              await (logChannel as TextChannel).send({
                content: `⚡ **[BEAM LOG - Channel ID: ${dmLogChannelId}]** User <@${target.id}> beamed for ${duration} by <@${message.author.id}>.\n**Reason:** ${reason}`,
                embeds: [embed]
              });
            }
          } catch (e) {
            addBotLog(`Failed to log to channel ${dmLogChannelId}: ${e}`, 'error');
          }
        }

        // 11. Command: ?deletebotmsgs
        if (command === 'deletebotmsgs') {
          if (!isAllowedUser) {
            addBotLog(`Unauthorized ?deletebotmsgs attempt by ${message.author.tag}`, 'warn');
            return message.reply('❌ You do not have permission to use this command.').catch(() => {});
          }

          try {
            addBotLog(`[DELETE BOT MSGS] Initiated by ${message.author.tag}`, 'info');
            const messages = await message.channel.messages.fetch({ limit: 100 });
            const botMessages = messages.filter(m => m.author.id === botClient?.user?.id);

            let deletedCount = 0;
            for (const [, msg] of botMessages) {
              try {
                await msg.delete();
                deletedCount++;
              } catch (delErr) {
                // ignore
              }
            }

            await message.reply(`🗑️ Successfully deleted **${deletedCount}** messages sent by the bot in this channel.`).catch(() => {});
            addBotLog(`[DELETE BOT MSGS] Successfully deleted ${deletedCount} bot messages.`, 'success');
          } catch (err: any) {
            addBotLog(`Failed to delete bot messages: ${err.message}`, 'error');
            await message.reply('❌ Failed to delete bot messages. Ensure the bot has Manage Messages permission.').catch(() => {});
          }
        }
      });

      await botClient.login(botToken);
      res.json({ success: true, message: 'Bot starting...' });
    } catch (err: any) {
      botStatus = 'error';
      addBotLog(`Failed to start bot: ${err.message}`, 'error');
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/bot/stop', async (req, res) => {
    try {
      if (botClient) {
        await botClient.destroy();
        botClient = null;
      }
      botStatus = 'offline';
      if (firestoreDb) {
        setDoc(doc(firestoreDb, 'bot_config', 'runtime'), {
          active: false,
          updatedAt: Date.now()
        }, { merge: true }).catch(() => {});
      }
      addBotLog('Bot stopped successfully.', 'warn');
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'spa',
  });

  app.use(vite.middlewares);

  return app;
}

if (process.env.NODE_ENV !== 'production' || process.argv[1] === fileURLToPath(import.meta.url)) {
  createServer().then((app) => {
    const port = 3000;
    app.listen(port, '0.0.0.0', () => {
      console.log(`Server running on http://localhost:${port}`);
    });
  });
}
