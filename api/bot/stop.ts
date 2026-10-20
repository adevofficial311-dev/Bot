import { resolve } from 'path';
import fs from 'fs';
import { initializeApp, getApps } from 'firebase/app';
import { getFirestore, doc, setDoc } from 'firebase/firestore';

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
  if (isFirebaseReady && firestoreDb) {
    try {
      await setDoc(doc(firestoreDb, 'bot_config', 'runtime'), {
        active: false,
        updatedAt: Date.now()
      }, { merge: true });
    } catch (e) {}
  }

  res.setHeader('Content-Type', 'application/json');
  return res.status(200).json({
    success: true,
    message: 'Bot session stopped signal sent.',
    status: 'offline'
  });
}
