import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { MODELS_DIR } from './config.js';
export { MODELS_DIR };
import { setSettings, getSetting } from './db.js';
import { logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const MODEL_CATALOG = [
  {
    id: 'whisper-large-v3-turbo',
    name: 'Whisper Large v3 Turbo',
    category: 'Transcription (ASR)',
    filename: 'ggml-large-v3-turbo.bin',
    sizeBytes: 1624555275,
    sizeStr: '1.51 GB',
    description: 'High-speed, state-of-the-art speech-to-text with Apple Silicon Metal GPU acceleration (~100x real-time).',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin',
    destination: path.join(MODELS_DIR, 'ggml-large-v3-turbo.bin'),
    systemLocations: [
      path.join(os.homedir(), 'Library', 'Application Support', 'Meetily', 'models', 'ggml-large-v3-turbo.bin'),
      path.join(__dirname, '..', 'models', 'whisper-large-v3-turbo.bin'),
      path.join(__dirname, '..', 'models', 'ggml-large-v3-turbo.bin')
    ],
    settingKey: 'whisper_model_path'
  },
  {
    id: 'nemotron3-diarization',
    name: 'NVIDIA Nemotron-3 Diarization (Sortformer v3)',
    category: 'Speaker Diarization',
    filename: 'nemotron3_diar_v3.onnx',
    sizeBytes: 400506656,
    sizeStr: '382 MB',
    description: 'Sortformer v3 neural network for multi-speaker recognition and accurate speaker turn labeling.',
    url: 'https://huggingface.co/altunenes/parakeet-rs/resolve/4d2a8bc71f5c896ec40faa59732e6716295edaf2/nemotron-3-diarization/nemotron3_diar_v3.onnx',
    destination: path.join(MODELS_DIR, 'nemotron3_diar_v3.onnx'),
    systemLocations: [
      path.join(os.homedir(), 'Library', 'Application Support', 'Meetily', 'models', 'diarization', 'nemotron3_diar_v3.onnx'),
      path.join(__dirname, '..', 'models', 'nemotron3_diar_v3.onnx')
    ],
    settingKey: 'diarization_model_path'
  }
];

// Active downloads tracking in memory: { [modelId]: { status, downloaded, total, percent, error } }
const activeDownloads = {};

export function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function getModelsStatus() {
  return MODEL_CATALOG.map((m) => {
    const isInstalled = fs.existsSync(m.destination) && fs.statSync(m.destination).size > 1000000;
    let installedSize = '';
    if (isInstalled) {
      installedSize = formatBytes(fs.statSync(m.destination).size);
    }

    // Check system fallback locations (e.g. Meetily)
    let foundSystemPath = null;
    let foundSystemSize = '';
    for (const p of m.systemLocations) {
      if (fs.existsSync(p) && fs.statSync(p).size > 1000000) {
        foundSystemPath = p;
        foundSystemSize = formatBytes(fs.statSync(p).size);
        break;
      }
    }

    const currentSetting = getSetting(m.settingKey, '');
    const isCurrentlyActiveInSetting = currentSetting === m.destination;

    const dl = activeDownloads[m.id] || null;

    return {
      id: m.id,
      name: m.name,
      category: m.category,
      filename: m.filename,
      sizeStr: m.sizeStr,
      description: m.description,
      destination: m.destination,
      modelsDir: MODELS_DIR,
      isInstalled,
      installedSize,
      foundSystemPath,
      foundSystemSize,
      isCurrentlyActiveInSetting,
      currentSetting,
      downloading: dl ? dl.status === 'downloading' : false,
      downloadProgress: dl || null
    };
  });
}

export async function copyModelFromSystem(modelId) {
  const model = MODEL_CATALOG.find((m) => m.id === modelId);
  if (!model) throw new Error(`Model ${modelId} not found in catalog.`);

  let sourcePath = null;
  for (const p of model.systemLocations) {
    if (fs.existsSync(p) && fs.statSync(p).size > 1000000) {
      sourcePath = p;
      break;
    }
  }

  if (!sourcePath) {
    throw new Error(`Model ${model.name} was not found on your system to copy.`);
  }

  if (!fs.existsSync(MODELS_DIR)) {
    fs.mkdirSync(MODELS_DIR, { recursive: true });
  }

  logger.info(`Copying ${model.name} from "${sourcePath}" to "${model.destination}"...`);
  fs.copyFileSync(sourcePath, model.destination);

  // Update setting in database
  setSettings({ [model.settingKey]: model.destination });
  logger.info(`✅ Installed ${model.name} in Plaud Studio Library: ${model.destination}`);

  return {
    success: true,
    destination: model.destination,
    message: `${model.name} copied to Plaud Studio Library successfully.`
  };
}

export async function downloadModel(modelId, onProgress = null) {
  const model = MODEL_CATALOG.find((m) => m.id === modelId);
  if (!model) throw new Error(`Model ${modelId} not found in catalog.`);

  if (activeDownloads[modelId] && activeDownloads[modelId].status === 'downloading') {
    return { success: true, message: 'Download already in progress' };
  }

  if (!fs.existsSync(MODELS_DIR)) {
    fs.mkdirSync(MODELS_DIR, { recursive: true });
  }

  const partPath = `${model.destination}.part`;

  activeDownloads[modelId] = {
    status: 'downloading',
    downloaded: 0,
    total: model.sizeBytes,
    percent: 0,
    startedAt: Date.now()
  };

  logger.info(`Starting download of ${model.name} (${model.sizeStr}) from ${model.url}...`);

  (async () => {
    try {
      const res = await fetch(model.url, { redirect: 'follow' });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      const totalHeader = res.headers.get('content-length');
      const totalBytes = totalHeader ? parseInt(totalHeader, 10) : model.sizeBytes;
      activeDownloads[modelId].total = totalBytes;

      const fileStream = fs.createWriteStream(partPath);
      let downloadedBytes = 0;
      let lastReport = Date.now();

      for await (const chunk of res.body) {
        downloadedBytes += chunk.length;
        fileStream.write(chunk);

        const now = Date.now();
        if (now - lastReport > 250) {
          lastReport = now;
          const percent = totalBytes ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)) : 0;
          activeDownloads[modelId].downloaded = downloadedBytes;
          activeDownloads[modelId].percent = percent;
          if (onProgress) onProgress(downloadedBytes, totalBytes, percent);
        }
      }

      await new Promise((resolve) => fileStream.end(resolve));

      // Atomic rename once fully downloaded
      fs.renameSync(partPath, model.destination);

      activeDownloads[modelId] = {
        status: 'completed',
        downloaded: totalBytes,
        total: totalBytes,
        percent: 100,
        completedAt: Date.now()
      };

      // Automatically register in SQLite settings
      setSettings({ [model.settingKey]: model.destination });
      logger.info(`✅ Successfully downloaded and activated ${model.name} in Plaud Studio Library!`);
    } catch (err) {
      console.error(`Failed to download model ${modelId}:`, err);
      logger.error(`Download failed for ${model.name}: ${err.message}`);
      activeDownloads[modelId] = {
        status: 'error',
        error: err.message
      };
      try {
        if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
      } catch (_) {}
    }
  })();

  return {
    success: true,
    message: `Download started for ${model.name}`
  };
}
