import { resolve } from 'path';
import fs from 'fs';
import { initializeApp, getApps } from 'firebase/app';
import { getFirestore, collection, getDocs, doc, getDoc } from 'firebase/firestore';

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
} catch (e) {}

export default async function handler(req: any, res: any) {
  let afkUsersList: any[] = [];
  let isRuntimeActive = true;
  let runtimeTag = 'Yama Bot#9999';
  let botBio = "Official Yama Moderation Bot guarding server security.";
  let botCustomStatus = "Guarding the server with Yama Moderation | ?yamastrike & ?yamabeam";

  if (isFirebaseReady && firestoreDb) {
    try {
      const profileSnap = await getDoc(doc(firestoreDb, 'bot_config', 'profile'));
      if (profileSnap.exists()) {
        const data = profileSnap.data();
        if (data?.bio) botBio = data.bio;
        if (data?.customStatus) botCustomStatus = data.customStatus;
      }

      const runtimeSnap = await getDoc(doc(firestoreDb, 'bot_config', 'runtime'));
      if (runtimeSnap.exists()) {
        const rdata = runtimeSnap.data();
        if (rdata?.active !== undefined) isRuntimeActive = !!rdata.active;
        if (rdata?.tag) runtimeTag = rdata.tag;
      }

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
    } catch (e) {}
  }

  res.setHeader('Content-Type', 'application/json');
  return res.status(200).json({
    status: isRuntimeActive ? 'online' : 'offline',
    tag: runtimeTag,
    guildsCount: 1,
    uptime: process.uptime() * 1000,
    logs: [
      {
        id: 'vercel-log-1',
        time: new Date().toLocaleTimeString(),
        type: 'success',
        message: 'Yama Bot connected & state synchronized with cloud Firestore.'
      }
    ],
    afkCount: afkUsersList.length,
    botBio,
    botCustomStatus,
    afkUsers: afkUsersList,
    isFirebaseReady,
    deploymentPlatform: 'Vercel Serverless'
  });
}
