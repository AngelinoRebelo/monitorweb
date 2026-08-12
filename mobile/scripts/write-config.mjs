#!/usr/bin/env node
/**
 * Gera capacitor.config.json para produção (Play/teste com Railway)
 * ou local (emulador → host machine).
 *
 * Uso:
 *   node scripts/write-config.mjs prod
 *   node scripts/write-config.mjs local
 *   MONITORWEB_URL=https://meu-tunnel.exemplo node scripts/write-config.mjs local
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const mode = (process.argv[2] || 'prod').toLowerCase();

const PROD_URL = 'https://monitorweb-production.up.railway.app';
/** 10.0.2.2 = localhost da máquina host vista pelo emulador Android */
const LOCAL_URL = process.env.MONITORWEB_URL || 'http://10.0.2.2:3000';

const isLocal = mode === 'local' || mode === 'dev' || mode === 'test';
const url = isLocal ? LOCAL_URL : process.env.MONITORWEB_URL || PROD_URL;

const config = {
  appId: 'br.com.monitorweb.app',
  appName: 'MonitorWeb',
  webDir: 'www',
  android: {
    allowMixedContent: isLocal,
  },
  server: {
    url,
    cleartext: isLocal || url.startsWith('http://'),
    androidScheme: 'https',
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      backgroundColor: '#0b1c16',
      showSpinner: false,
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#0b1c16',
    },
  },
};

const out = path.join(root, 'capacitor.config.json');
fs.writeFileSync(out, JSON.stringify(config, null, 2) + '\n');
console.log(`Wrote ${out}`);
console.log(`  mode: ${isLocal ? 'local/test' : 'prod'}`);
console.log(`  url:  ${url}`);
