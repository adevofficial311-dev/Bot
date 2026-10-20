/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { 
  Bot, Shield, Terminal, Power, Settings, Download, 
  Activity, Database, Check, Copy, RefreshCw, RadioTower,
  Play, Square, BookOpen, ExternalLink
} from 'lucide-react';

interface AuditLog {
  id: string;
  time: string;
  type: 'info' | 'success' | 'error' | 'warn';
  message: string;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'control' | 'logs' | 'config' | 'commands' | 'vercel'>('control');
  
  // Bot Hosting State
  const [botToken, setBotToken] = useState('');
  const [openRouterKey, setOpenRouterKey] = useState('');
  const [botStatus, setBotStatus] = useState<'offline' | 'starting' | 'online' | 'error'>('offline');
  const [botTag, setBotTag] = useState<string | null>(null);
  const [serverLogs, setServerLogs] = useState<AuditLog[]>([]);
  const [isFirebaseReady, setIsFirebaseReady] = useState(true);
  const [botBio, setBotBio] = useState<string>("Official Yama Moderation Bot guarding server security.");
  const [botCustomStatus, setBotCustomStatus] = useState<string>("Guarding the server with Yama Moderation | ?yamastrike & ?yamabeam");
  const [guildsCount, setGuildsCount] = useState<number>(0);
  const [afkCount, setAfkCount] = useState<number>(0);
  const [isExportingZip, setIsExportingZip] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);

  // Configuration state
  const [config, setConfig] = useState({
    allowedRoleId: '1555240171564302346',
    allowedUserIds: '1521870728079737053, 1005581180286025749',
    dmLogChannelId: '1521870728079737053',
    gifUrl: 'https://cdn.imageurlgenerator.com/uploads/1365dbdf-db34-4d9a-913a-317a621db09b.gif',
    embedTitle: "You're cooked buddy",
    prefix: '?'
  });
  const [configSaved, setConfigSaved] = useState(false);

  async function safeFetchJson(url: string, options?: RequestInit) {
    try {
      const res = await fetch(url, options);
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const data = await res.json();
        return { ok: res.ok, status: res.status, data };
      }
      const text = await res.text();
      return { ok: res.ok, status: res.status, errorText: text };
    } catch (err: any) {
      return { ok: false, status: 0, errorText: err.message };
    }
  }

  // Poll server status
  useEffect(() => {
    const fetchStatus = async () => {
      const result = await safeFetchJson('/api/bot/status');
      if (result.ok && result.data) {
        const data = result.data;
        setBotStatus(data.status || 'offline');
        setBotTag(data.tag || null);
        if (data.botBio) setBotBio(data.botBio);
        if (data.botCustomStatus) setBotCustomStatus(data.botCustomStatus);
        if (data.logs) setServerLogs(data.logs);
        if (data.guildsCount !== undefined) setGuildsCount(data.guildsCount);
        if (data.afkCount !== undefined) setAfkCount(data.afkCount);
        if (data.isFirebaseReady !== undefined) setIsFirebaseReady(data.isFirebaseReady);
      }
    };
    fetchStatus();
    const interval = setInterval(fetchStatus, 3000);
    return () => clearInterval(interval);
  }, []);

  const handleStartBot = async () => {
    try {
      setBotStatus('starting');
      const result = await safeFetchJson('/api/bot/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          token: botToken, 
          config: {
            ...config,
            allowedUserIds: config.allowedUserIds.split(',').map(s => s.trim()).filter(Boolean)
          },
          openrouterApiKey: openRouterKey
        })
      });
      if (!result.ok) {
        const errorMsg = result.data?.error || (result.status === 404 ? 'API route not ready or not found (404). Please ensure the latest Vercel deployment has finished.' : (result.errorText ? result.errorText.slice(0, 150) : 'Failed to start bot'));
        alert(errorMsg);
        setBotStatus('error');
      } else {
        setBotStatus('online');
      }
    } catch (err: any) {
      alert(err.message);
      setBotStatus('error');
    }
  };

  const handleStopBot = async () => {
    try {
      await safeFetchJson('/api/bot/stop', { method: 'POST' });
      setBotStatus('offline');
      setBotTag(null);
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleDownloadZip = async () => {
    try {
      setIsExportingZip(true);
      const res = await fetch('/api/download/vercel-zip');
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'yama-discord-bot-render.zip';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } else {
        const JSZip = (await import('jszip')).default;
        const zip = new JSZip();
        const [pkg, tsconfig, renderYaml, readmeRender, botTs, serverTs] = await Promise.all([
          fetch('/package.json').then(r => r.text()).catch(() => '{}'),
          fetch('/tsconfig.json').then(r => r.text()).catch(() => '{}'),
          fetch('/render.yaml').then(r => r.text()).catch(() => ''),
          fetch('/README-RENDER.md').then(r => r.text()).catch(() => ''),
          fetch('/bot.ts').then(r => r.text()).catch(() => ''),
          fetch('/server.ts').then(r => r.text()).catch(() => '')
        ]);
        zip.file('package.json', pkg);
        zip.file('tsconfig.json', tsconfig);
        if (renderYaml) zip.file('render.yaml', renderYaml);
        if (readmeRender) {
          zip.file('README-RENDER.md', readmeRender);
          zip.file('README.md', readmeRender);
        }
        if (botTs) zip.file('bot.ts', botTs);
        if (serverTs) zip.file('server.ts', serverTs);
        const content = await zip.generateAsync({ type: 'blob' });
        const url = URL.createObjectURL(content);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'yama-discord-bot-render.zip';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    } catch (err: any) {
      alert('Failed to download ZIP: ' + err.message);
    } finally {
      setIsExportingZip(false);
    }
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedCmd(id);
    setTimeout(() => setCopiedCmd(null), 2000);
  };

  return (
    <div className="min-h-screen bg-[#090d16] text-slate-100 flex flex-col font-sans selection:bg-indigo-500/30">
      
      {/* Top Navbar */}
      <header className="border-b border-slate-800/80 bg-[#0f172a]/90 backdrop-blur sticky top-0 z-40 px-4 sm:px-6 py-3 flex items-center justify-between shadow-lg">
        <div className="flex items-center space-x-3">
          <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center shadow-md shadow-indigo-600/30">
            <Bot className="w-5 h-5 text-white" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <h1 className="text-sm sm:text-base font-bold text-white tracking-tight">Yama Bot Control Center</h1>
              <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-bold rounded-full ${
                botStatus === 'online' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' :
                botStatus === 'starting' ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30 animate-pulse' :
                'bg-slate-800 text-slate-400 border border-slate-700'
              }`}>
                <span className={`w-1.5 h-1.5 rounded-full mr-1.5 ${
                  botStatus === 'online' ? 'bg-emerald-400' :
                  botStatus === 'starting' ? 'bg-amber-400' :
                  'bg-slate-500'
                }`} />
                {botStatus.toUpperCase()}
              </span>
            </div>
            <p className="text-[11px] text-slate-400 hidden sm:block">
              {botTag ? `Connected as ${botTag}` : 'Simplified Discord Bot Hosting for Vercel'}
            </p>
          </div>
        </div>

        {/* Desktop Tabs */}
        <div className="hidden md:flex items-center space-x-1 bg-[#1e293b]/60 p-1 rounded-xl border border-slate-800">
          <button
            onClick={() => setActiveTab('control')}
            className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              activeTab === 'control' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'
            }`}
          >
            <Power className="w-3.5 h-3.5" />
            <span>Host & Control</span>
          </button>
          <button
            onClick={() => setActiveTab('logs')}
            className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              activeTab === 'logs' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'
            }`}
          >
            <Terminal className="w-3.5 h-3.5" />
            <span>Live Logs ({serverLogs.length})</span>
          </button>
          <button
            onClick={() => setActiveTab('config')}
            className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              activeTab === 'config' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'
            }`}
          >
            <Settings className="w-3.5 h-3.5" />
            <span>Settings</span>
          </button>
          <button
            onClick={() => setActiveTab('commands')}
            className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              activeTab === 'commands' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'
            }`}
          >
            <BookOpen className="w-3.5 h-3.5" />
            <span>Commands</span>
          </button>
          <button
            onClick={() => setActiveTab('vercel')}
            className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              activeTab === 'vercel' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'
            }`}
          >
            <Download className="w-3.5 h-3.5" />
            <span>Vercel Deploy</span>
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-5xl w-full mx-auto p-4 sm:p-6 pb-20 md:pb-8">
        
        {/* ================= TAB 1: HOST & CONTROL ================= */}
        {activeTab === 'control' && (
          <div className="space-y-6">
            
            {/* Quick Stats Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
              <div className="bg-[#0f172a] border border-slate-800 rounded-xl p-4">
                <span className="text-xs text-slate-400 block mb-1">Bot Status</span>
                <span className={`text-base font-bold capitalize ${botStatus === 'online' ? 'text-emerald-400' : 'text-slate-300'}`}>
                  {botStatus}
                </span>
                <span className="text-[10px] text-slate-500 block mt-0.5 truncate">{botTag || 'No active session'}</span>
              </div>
              <div className="bg-[#0f172a] border border-slate-800 rounded-xl p-4">
                <span className="text-xs text-slate-400 block mb-1">Connected Guilds</span>
                <span className="text-base font-bold text-white">{guildsCount} Servers</span>
                <span className="text-[10px] text-slate-500 block mt-0.5">Discord Gateway</span>
              </div>
              <div className="bg-[#0f172a] border border-slate-800 rounded-xl p-4">
                <span className="text-xs text-slate-400 block mb-1">Firestore Cloud</span>
                <span className="text-base font-bold text-amber-400 flex items-center gap-1.5">
                  <Database className="w-3.5 h-3.5" />
                  <span>{isFirebaseReady ? 'Connected' : 'Offline'}</span>
                </span>
                <span className="text-[10px] text-slate-500 block mt-0.5">AFK & Profile Sync</span>
              </div>
              <div className="bg-[#0f172a] border border-slate-800 rounded-xl p-4">
                <span className="text-xs text-slate-400 block mb-1">Active AFK Users</span>
                <span className="text-base font-bold text-indigo-400">{afkCount} Tracked</span>
                <span className="text-[10px] text-slate-500 block mt-0.5">Persistent across restarts</span>
              </div>
            </div>

            {/* Host Control Box */}
            <div className="bg-[#0f172a] border border-slate-800 rounded-2xl p-5 sm:p-6 shadow-xl">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-base font-bold text-white flex items-center gap-2">
                    <Power className="w-4 h-4 text-indigo-400" />
                    <span>Bot Launcher & Credentials</span>
                  </h2>
                  <p className="text-xs text-slate-400">Launch the bot directly using your Discord bot token.</p>
                </div>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                    Discord Bot Token
                  </label>
                  <input
                    type="password"
                    value={botToken}
                    onChange={(e) => setBotToken(e.target.value)}
                    placeholder="MTA... Paste token from Discord Developer Portal"
                    className="w-full bg-[#1e293b]/60 border border-slate-700 rounded-xl px-3.5 py-2.5 text-xs text-slate-200 font-mono focus:outline-none focus:border-indigo-500"
                  />
                  <p className="text-[11px] text-slate-500 mt-1">If hosted on Vercel or VPS, you can also define <code>DISCORD_TOKEN</code> in your environment variables.</p>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                    OpenRouter API Key (Optional for AI Chat)
                  </label>
                  <input
                    type="password"
                    value={openRouterKey}
                    onChange={(e) => setOpenRouterKey(e.target.value)}
                    placeholder="sk-or-v1-... (Leave blank to use pre-configured key)"
                    className="w-full bg-[#1e293b]/60 border border-slate-700 rounded-xl px-3.5 py-2.5 text-xs text-slate-200 font-mono focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div className="flex flex-col sm:flex-row items-center gap-3 pt-2">
                  {botStatus === 'online' || botStatus === 'starting' ? (
                    <button
                      onClick={handleStopBot}
                      className="w-full sm:w-auto px-6 py-2.5 bg-rose-600 hover:bg-rose-500 text-white font-semibold text-xs rounded-xl flex items-center justify-center space-x-2 transition-all shadow-md shadow-rose-600/20"
                    >
                      <Square className="w-3.5 h-3.5 fill-current" />
                      <span>Stop Bot Session</span>
                    </button>
                  ) : (
                    <button
                      onClick={handleStartBot}
                      className="w-full sm:w-auto px-6 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs rounded-xl flex items-center justify-center space-x-2 transition-all shadow-md shadow-emerald-600/20"
                    >
                      <Play className="w-3.5 h-3.5 fill-current" />
                      <span>Launch Bot Now</span>
                    </button>
                  )}

                  <div className="text-xs text-slate-400 sm:ml-auto">
                    Presence: <span className="text-slate-300 font-medium">"{botCustomStatus}"</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Standalone Runner Guide */}
            <div className="bg-[#0f172a] border border-slate-800 rounded-2xl p-5 shadow-xl">
              <h3 className="text-sm font-bold text-white mb-2 flex items-center gap-2">
                <Terminal className="w-4 h-4 text-emerald-400" />
                <span>Running Bot 24/7 as Standalone File</span>
              </h3>
              <p className="text-xs text-slate-400 mb-3">
                You can run the pure bot without any web interface by executing <code>bot.ts</code> directly:
              </p>
              <div className="bg-[#090d16] p-3 rounded-xl border border-slate-800 flex items-center justify-between font-mono text-xs text-indigo-300">
                <code>npx tsx bot.ts</code>
                <button
                  onClick={() => copyToClipboard('npx tsx bot.ts', 'run-cmd')}
                  className="p-1 hover:text-white rounded"
                >
                  {copiedCmd === 'run-cmd' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>

          </div>
        )}

        {/* ================= TAB 2: LIVE LOGS ================= */}
        {activeTab === 'logs' && (
          <div className="space-y-4">
            <div className="bg-[#0f172a] border border-slate-800 rounded-2xl p-5 shadow-xl">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-indigo-400" />
                  <h2 className="text-sm font-bold text-white">Live Event Console</h2>
                  <span className="text-xs text-slate-500">({serverLogs.length} events)</span>
                </div>
                <button
                  onClick={() => setServerLogs([])}
                  className="text-xs text-slate-400 hover:text-rose-400 transition-colors"
                >
                  Clear Console
                </button>
              </div>

              <div className="bg-[#090d16] border border-slate-850 rounded-xl p-4 font-mono text-xs space-y-2 h-[500px] overflow-y-auto">
                {serverLogs.length === 0 ? (
                  <div className="text-slate-600 text-center py-24">No events logged yet. Active commands, moderation strikes, and AI conversations will stream here live.</div>
                ) : (
                  serverLogs.map(l => (
                    <div key={l.id} className="flex items-start space-x-2 leading-relaxed">
                      <span className="text-slate-500 select-none">[{l.time}]</span>
                      <span className={
                        l.type === 'success' ? 'text-emerald-400 font-semibold' :
                        l.type === 'error' ? 'text-rose-400 font-semibold' :
                        l.type === 'warn' ? 'text-amber-400' : 'text-slate-300'
                      }>
                        {l.message}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {/* ================= TAB 3: CONFIGURATION ================= */}
        {activeTab === 'config' && (
          <div className="bg-[#0f172a] border border-slate-800 rounded-2xl p-5 sm:p-6 shadow-xl space-y-4">
            <div className="flex items-center justify-between mb-2">
              <div>
                <h2 className="text-base font-bold text-white flex items-center gap-2">
                  <Settings className="w-4 h-4 text-indigo-400" />
                  <span>Bot Settings & Permissions</span>
                </h2>
                <p className="text-xs text-slate-400">Configure role permissions, authorized users, and moderation embed options.</p>
              </div>
              {configSaved && (
                <span className="text-xs text-emerald-400 font-semibold flex items-center gap-1">
                  <Check className="w-3.5 h-3.5" /> Saved
                </span>
              )}
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
                  Command Prefix
                </label>
                <input
                  type="text"
                  value={config.prefix}
                  onChange={(e) => setConfig({ ...config, prefix: e.target.value })}
                  className="w-full sm:w-32 bg-[#1e293b]/60 border border-slate-700 rounded-xl px-3.5 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
                  Authorized Staff/Admin Role ID
                </label>
                <input
                  type="text"
                  value={config.allowedRoleId}
                  onChange={(e) => setConfig({ ...config, allowedRoleId: e.target.value })}
                  className="w-full bg-[#1e293b]/60 border border-slate-700 rounded-xl px-3.5 py-2 text-xs text-slate-200 font-mono focus:outline-none focus:border-indigo-500"
                />
                <p className="text-[11px] text-slate-500 mt-1">Users with this Discord role ID have permission to use ?yamastrike, ?yamabeam, ?purge, ?createchannel, etc.</p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
                  Whitelisted User IDs (Comma Separated)
                </label>
                <input
                  type="text"
                  value={config.allowedUserIds}
                  onChange={(e) => setConfig({ ...config, allowedUserIds: e.target.value })}
                  className="w-full bg-[#1e293b]/60 border border-slate-700 rounded-xl px-3.5 py-2 text-xs text-slate-200 font-mono focus:outline-none focus:border-indigo-500"
                />
                <p className="text-[11px] text-slate-500 mt-1">Specific master Discord user IDs allowed to run authorized commands regardless of roles.</p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
                  DM Log Channel ID
                </label>
                <input
                  type="text"
                  value={config.dmLogChannelId}
                  onChange={(e) => setConfig({ ...config, dmLogChannelId: e.target.value })}
                  className="w-full bg-[#1e293b]/60 border border-slate-700 rounded-xl px-3.5 py-2 text-xs text-slate-200 font-mono focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
                    Strike/Beam Embed Title
                  </label>
                  <input
                    type="text"
                    value={config.embedTitle}
                    onChange={(e) => setConfig({ ...config, embedTitle: e.target.value })}
                    className="w-full bg-[#1e293b]/60 border border-slate-700 rounded-xl px-3.5 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
                    Embed GIF URL
                  </label>
                  <input
                    type="text"
                    value={config.gifUrl}
                    onChange={(e) => setConfig({ ...config, gifUrl: e.target.value })}
                    className="w-full bg-[#1e293b]/60 border border-slate-700 rounded-xl px-3.5 py-2 text-xs text-slate-200 font-mono text-[11px] focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              <button
                onClick={() => {
                  setConfigSaved(true);
                  setTimeout(() => setConfigSaved(false), 2500);
                }}
                className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs rounded-xl transition-all shadow-md shadow-indigo-600/20"
              >
                Save Settings
              </button>
            </div>
          </div>
        )}

        {/* ================= TAB 4: COMMANDS GUIDE ================= */}
        {activeTab === 'commands' && (
          <div className="space-y-4">
            <div className="bg-[#0f172a] border border-slate-800 rounded-2xl p-5 sm:p-6 shadow-xl">
              <h2 className="text-base font-bold text-white mb-1 flex items-center gap-2">
                <Shield className="w-4 h-4 text-indigo-400" />
                <span>Command Cheat Sheet</span>
              </h2>
              <p className="text-xs text-slate-400 mb-6">Complete reference of moderation, channel management, and utility commands.</p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                
                {/* Moderation */}
                <div className="bg-[#1e293b]/40 border border-slate-800 rounded-xl p-4 space-y-2.5">
                  <span className="text-xs font-bold text-amber-400 uppercase tracking-wider block">🛡️ Moderation (Authorized Only)</span>
                  <div className="text-xs space-y-1.5 font-mono">
                    <p className="text-slate-300"><code className="text-amber-300">?yamastrike @user reason</code> — Strike/warn user</p>
                    <p className="text-slate-300"><code className="text-rose-400">?yamabeam @user 1h reason</code> — Real timeout mute</p>
                    <p className="text-slate-300"><code className="text-indigo-300">?purge count</code> — Wipe messages (1-100)</p>
                    <p className="text-slate-300"><code className="text-slate-400">?deletebotmsgs</code> — Clear bot messages in channel</p>
                    <p className="text-slate-300"><code className="text-red-400">?admin &lt;roleId&gt;</code> — Grant Administrator permissions</p>
                  </div>
                </div>

                {/* Channel Management */}
                <div className="bg-[#1e293b]/40 border border-slate-800 rounded-xl p-4 space-y-2.5">
                  <span className="text-xs font-bold text-indigo-400 uppercase tracking-wider block">📁 Channel Management (Authorized Only)</span>
                  <div className="text-xs space-y-1.5 font-mono">
                    <p className="text-slate-300"><code className="text-indigo-300">?createchannel name</code> — Create text channel</p>
                    <p className="text-slate-300"><code className="text-rose-400">?deletechannel #channel</code> — Delete channel</p>
                    <p className="text-slate-300"><code className="text-emerald-400">?renamechannel #channel new-name</code> — Rename channel</p>
                  </div>
                </div>

                {/* Utility */}
                <div className="bg-[#1e293b]/40 border border-slate-800 rounded-xl p-4 space-y-2.5">
                  <span className="text-xs font-bold text-blue-400 uppercase tracking-wider block">💤 Utility & AFK (Everyone)</span>
                  <div className="text-xs space-y-1.5 font-mono">
                    <p className="text-slate-300"><code className="text-blue-300">?afk [reason]</code> — Set AFK status</p>
                    <p className="text-slate-300"><code className="text-indigo-300">?snipe [@user]</code> — Reveal last deleted message</p>
                    <p className="text-slate-300"><code className="text-teal-300">?setbotbio &lt;bio&gt;</code> — Set bot description (Staff)</p>
                    <p className="text-slate-300"><code className="text-amber-300">?setbotstatus &lt;status&gt;</code> — Set bot presence (Staff)</p>
                  </div>
                </div>

                {/* AI Assistant */}
                <div className="bg-[#1e293b]/40 border border-slate-800 rounded-xl p-4 space-y-2.5">
                  <span className="text-xs font-bold text-emerald-400 uppercase tracking-wider block">🤖 AI Assistant & Memory</span>
                  <div className="text-xs space-y-1.5 font-mono">
                    <p className="text-slate-300"><code className="text-emerald-300">@Yama Hi!</code> — Chat with database memory</p>
                    <p className="text-slate-300"><code className="text-cyan-300">@Yama What's our server name?</code> — Direct server stats</p>
                    <p className="text-slate-300"><code className="text-slate-400">y!help</code> — Sends private command guide to DMs</p>
                    <p className="text-slate-300"><code className="text-purple-400">/ping</code> &amp; <code className="text-purple-400">/sync</code> — Slash commands</p>
                  </div>
                </div>

              </div>
            </div>
          </div>
        )}

        {/* ================= TAB 5: RENDER DEPLOY ================= */}
        {activeTab === 'vercel' && (
          <div className="bg-[#0f172a] border border-slate-800 rounded-2xl p-6 sm:p-8 shadow-xl space-y-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400">
                <Download className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-base sm:text-lg font-bold text-white">Render 24/7 Deployment Package</h2>
                <p className="text-xs text-slate-400">Pre-configured ZIP with `render.yaml` for 24/7 continuous web dashboard & bot hosting on Render.</p>
              </div>
            </div>

            <div className="bg-[#090d16] p-5 rounded-xl border border-slate-800 space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-white mb-1">Download Render Package</h3>
                <p className="text-xs text-slate-400">Includes <code>render.yaml</code>, <code>server.ts</code>, <code>bot.ts</code>, and web dashboard.</p>
              </div>

              <button
                onClick={handleDownloadZip}
                disabled={isExportingZip}
                className="w-full sm:w-auto px-6 py-3 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-semibold text-xs rounded-xl flex items-center justify-center space-x-2 transition-all shadow-md shadow-indigo-600/20"
              >
                <Download className="w-4 h-4" />
                <span>{isExportingZip ? 'Generating Package...' : 'Download yama-discord-bot-render.zip'}</span>
              </button>
            </div>

            <div className="border-t border-slate-800 pt-4 space-y-3">
              <h4 className="text-xs font-bold text-white uppercase tracking-wider mb-2">How 24/7 Render Hosting Works:</h4>
              <p className="text-xs text-slate-300 leading-relaxed">
                Unlike Vercel (which goes to sleep), <strong>Render runs a continuous Node.js server 24/7</strong>. Both your Web Dashboard and your 24/7 Discord bot run simultaneously on Render! When you close your browser, your bot stays online.
              </p>
              <ol className="text-xs text-slate-300 space-y-2 list-decimal list-inside leading-relaxed">
                <li>Download the ZIP above and push it to your GitHub repository.</li>
                <li>Go to <a href="https://render.com" target="_blank" rel="noreferrer" className="text-indigo-400 underline">Render.com</a> and click <strong>New &gt; Web Service</strong>, connecting your repository. Render automatically detects <code className="text-indigo-300">render.yaml</code>.</li>
                <li>In Render Environment Settings, add your <code className="text-indigo-300">DISCORD_TOKEN</code> and <code className="text-indigo-300">OPENROUTER_API_KEY</code>.</li>
                <li>Click <strong>Deploy Service</strong> — your bot and web dashboard will run 24/7!</li>
              </ol>
            </div>
          </div>
        )}

      </main>

      {/* Mobile Bottom Navigation Bar */}
      <nav aria-label="Mobile Navigation" className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-[#0f172a]/95 backdrop-blur border-t border-slate-800 px-2 py-2 flex items-center justify-around shadow-2xl">
        <button
          onClick={() => setActiveTab('control')}
          className={`flex flex-col items-center p-2 rounded-xl text-[10px] font-semibold transition-colors ${activeTab === 'control' ? 'text-indigo-400 bg-indigo-500/10' : 'text-slate-400'}`}
        >
          <Power className="w-4 h-4 mb-0.5" />
          <span>Host</span>
        </button>
        <button
          onClick={() => setActiveTab('logs')}
          className={`flex flex-col items-center p-2 rounded-xl text-[10px] font-semibold transition-colors ${activeTab === 'logs' ? 'text-indigo-400 bg-indigo-500/10' : 'text-slate-400'}`}
        >
          <Terminal className="w-4 h-4 mb-0.5" />
          <span>Logs</span>
        </button>
        <button
          onClick={() => setActiveTab('config')}
          className={`flex flex-col items-center p-2 rounded-xl text-[10px] font-semibold transition-colors ${activeTab === 'config' ? 'text-indigo-400 bg-indigo-500/10' : 'text-slate-400'}`}
        >
          <Settings className="w-4 h-4 mb-0.5" />
          <span>Config</span>
        </button>
        <button
          onClick={() => setActiveTab('commands')}
          className={`flex flex-col items-center p-2 rounded-xl text-[10px] font-semibold transition-colors ${activeTab === 'commands' ? 'text-indigo-400 bg-indigo-500/10' : 'text-slate-400'}`}
        >
          <BookOpen className="w-4 h-4 mb-0.5" />
          <span>Cmds</span>
        </button>
        <button
          onClick={() => setActiveTab('vercel')}
          className={`flex flex-col items-center p-2 rounded-xl text-[10px] font-semibold transition-colors ${activeTab === 'vercel' ? 'text-indigo-400 bg-indigo-500/10' : 'text-slate-400'}`}
        >
          <Download className="w-4 h-4 mb-0.5" />
          <span>Deploy</span>
        </button>
      </nav>

      {/* Footer */}
      <footer className="border-t border-slate-800/60 py-3 px-6 text-center text-xs text-slate-500 mb-14 md:mb-0">
        Yama Discord Bot Hub • Clean Vercel Ready
      </footer>
    </div>
  );
}
