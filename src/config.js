import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure macOS GUI apps launched from Finder/Dock have access to Homebrew & user binaries
export function ensureEnvironmentPaths() {
  const candidateDirs = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), 'bin')
  ];
  const currentPath = process.env.PATH || '';
  const toAdd = candidateDirs.filter(
    (dir) => !currentPath.includes(dir) && fs.existsSync(dir)
  );
  if (toAdd.length > 0) {
    process.env.PATH = `${toAdd.join(':')}:${currentPath}`;
  }
}

ensureEnvironmentPaths();

// Unified standard storage location for all Plaud Studio state
export const APP_SUPPORT_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'Plaud Studio');
export const DATA_DIR = process.env.PLAUD_DATA_DIR || path.join(APP_SUPPORT_DIR, 'data');
export const MODELS_DIR = path.join(APP_SUPPORT_DIR, 'models');
export const DB_PATH = path.join(DATA_DIR, 'plaud_app.db');
export const AUDIO_DIR = path.join(DATA_DIR, 'audio');
export const TMP_DIR = path.join(DATA_DIR, 'tmp');

// Ensure all required directories exist
if (!fs.existsSync(APP_SUPPORT_DIR)) fs.mkdirSync(APP_SUPPORT_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(MODELS_DIR)) fs.mkdirSync(MODELS_DIR, { recursive: true });
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
