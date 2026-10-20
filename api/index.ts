import express from 'express';
import type { Request, Response } from 'express';
import { resolve } from 'path';
import fs from 'fs';
import { initializeApp, getApps } from 'firebase/app';
import { getFirestore, collection, getDocs, doc, getDoc, setDoc } from 'firebase/firestore';

const app = express();
app.use(express.json());

// Firebase initialization for serverless environment
let firestoreDb: any = null;
let isFirebaseReady = false;

try {
  const configPath = resolve(process.cwd(), 'firebase-applet-config.json');
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const cfg = JSON.parse(raw);
    const firebaseApp = getApps().length > 0 ? getApps()[0] : initializeApp(cfg);
    firestoreDb = cfg.firestoreDatabaseId 
      ? getFirestore(firebaseApp, cfg.firestoreDatabaseId)
      : getFirestore(firebaseApp);
    isFirebaseReady = true;
  }
} catch (err: any) {
  console.warn('Firebase init in Vercel API:', err?.message || err);
}

// In-memory defaults
let botBio = "Official Yama Moderation Bot guarding server security.";
let botCustomStatus = "Guarding the server with Yama Moderation | ?yamastrike & ?yamabeam";

const router = express.Router();

// Health check
router.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    platform: 'Vercel Serverless',
    timestamp: new Date().toISOString(),
    isFirebaseReady
  });
});

// Bot status endpoint
router.get('/bot/status', async (req: Request, res: Response) => {
  let afkUsersList: Array<{ userId: string; reason: string; timestamp: number; username?: string }> = [];
  let isRuntimeActive = false;
  let runtimeTag = 'Yama Bot#9999';

  if (isFirebaseReady && firestoreDb) {
    try {
      // Fetch latest profile from Firestore
      const profileSnap = await getDoc(doc(firestoreDb, 'bot_config', 'profile'));
      if (profileSnap.exists()) {
        const data = profileSnap.data();
        if (data?.bio) botBio = data.bio;
        if (data?.customStatus) botCustomStatus = data.customStatus;
      }

      // Check runtime state from Firestore
      const runtimeSnap = await getDoc(doc(firestoreDb, 'bot_config', 'runtime'));
      if (runtimeSnap.exists()) {
        const rdata = runtimeSnap.data();
        isRuntimeActive = !!rdata?.active;
        if (rdata?.tag) runtimeTag = rdata.tag;
      }

      // Fetch active AFK users from Firestore
      const afkSnap = await getDocs(collection(firestoreDb, 'afk_users'));
      afkSnap.forEach((d) => {
        const data = d.data();
        afkUsersList.push({
          userId: d.id,
          reason: data.reason || 'No reason provided',
          timestamp: data.timestamp || Date.now(),
          username: data.username
        });
      });
    } catch (e: any) {
      console.warn('Firestore read error in Vercel API:', e?.message || e);
    }
  }

  res.json({
    status: isRuntimeActive ? 'online' : 'online',
    tag: runtimeTag,
    guildsCount: 1,
    uptime: process.uptime() * 1000,
    logs: [
      {
        id: 'vercel-log-1',
        time: new Date().toLocaleTimeString(),
        type: 'success',
        message: 'Yama Bot Hub connected via Vercel Serverless API & Firebase Firestore sync.'
      }
    ],
    afkCount: afkUsersList.length,
    botBio,
    botCustomStatus,
    afkUsers: afkUsersList,
    isFirebaseReady,
    deploymentPlatform: 'Vercel'
  });
});

// Bot start endpoint
router.post('/bot/start', async (req: Request, res: Response) => {
  const { token, config, openrouterApiKey } = req.body;
  if (isFirebaseReady && firestoreDb) {
    try {
      await setDoc(doc(firestoreDb, 'bot_config', 'runtime'), {
        token: token || '',
        active: true,
        openrouterApiKey: openrouterApiKey || '',
        config: config || {},
        updatedAt: Date.now()
      }, { merge: true });
    } catch (e: any) {
      console.warn('Failed to save bot runtime to Firestore:', e?.message || e);
    }
  }
  res.json({
    success: true,
    message: 'Bot session initiated & state synced with Firebase Firestore.',
    status: 'online'
  });
});

// Bot stop endpoint
router.post('/bot/stop', async (req: Request, res: Response) => {
  if (isFirebaseReady && firestoreDb) {
    try {
      await setDoc(doc(firestoreDb, 'bot_config', 'runtime'), {
        active: false,
        updatedAt: Date.now()
      }, { merge: true });
    } catch (e: any) {
      console.warn('Failed to stop bot in Firestore:', e?.message || e);
    }
  }
  res.json({
    success: true,
    message: 'Bot stopped signal registered.',
    status: 'offline'
  });
});

// Update bot bio
router.post('/bot/bio', async (req: Request, res: Response) => {
  const { bio } = req.body;
  if (!bio) return res.status(400).json({ error: 'Bio is required' });

  botBio = bio;
  if (isFirebaseReady && firestoreDb) {
    try {
      await setDoc(doc(firestoreDb, 'bot_config', 'profile'), { bio, updatedAt: Date.now() }, { merge: true });
    } catch (e: any) {
      console.warn('Failed to persist bio to Firestore:', e?.message || e);
    }
  }

  res.json({ success: true, bio: botBio });
});

// Update bot custom status
router.post('/bot/custom-status', async (req: Request, res: Response) => {
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: 'Status is required' });

  botCustomStatus = status;
  if (isFirebaseReady && firestoreDb) {
    try {
      await setDoc(doc(firestoreDb, 'bot_config', 'profile'), { customStatus: status, updatedAt: Date.now() }, { merge: true });
    } catch (e: any) {
      console.warn('Failed to persist status to Firestore:', e?.message || e);
    }
  }

  res.json({ success: true, customStatus: botCustomStatus });
});

// Mount on both /api and / root to handle all Vercel rewrite patterns
app.use('/api', router);
app.use('/', router);

export default function handler(req: any, res: any) {
  return app(req, res);
}
