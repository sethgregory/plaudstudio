import express from 'express';
import cors from 'cors';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  db,
  getRecording,
  updateRecording,
  listRecordings,
  deleteRecording,
  listProjects,
  upsertProject,
  deleteProject,
  parseFolders,
  getStats,
  getAllSettings,
  setSettings,
  getSetting
} from './db.js';
import { getCurrentUser, getPlaudAuthStatus, syncAllRecordings, downloadRecordingAudio, fetchRecordingCloudData } from './plaud.js';
import { transcribeRecording } from './transcribe.js';
import { summarizeRecording, curlRequest, generateExportMarkdown, generateStandaloneHTML, enhanceMarkdownToHTML } from './summarize.js';
import { buildKnowledgeGraph, queryKnowledgeGraphWithLLM } from './knowledge.js';
import { ZipArchive } from 'archiver';
import { logger, registerSSEClient, getGlobalStatus, setIdleStatus } from './logger.js';

import { AUDIO_DIR } from './config.js';
import { getModelsStatus, downloadModel, copyModelFromSystem, MODELS_DIR } from './models.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();
const PORT = process.env.PORT || 3300;

app.use(cors());
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// Job Queue / In-memory progress tracking
const activeJobs = new Map();

function setJobProgress(id, stage, message, recordingName = '') {
  activeJobs.set(id, { stage, message, timestamp: Date.now() });
  logger.stage(stage, message, { recordingId: id, recordingName });
}

function clearJob(id) {
  activeJobs.delete(id);
  if (activeJobs.size === 0) {
    setIdleStatus();
  }
}

// ----------------- LIVE LOGS & STATUS SSE ----------------- //

app.get('/api/status', (req, res) => {
  res.json({ success: true, status: getGlobalStatus() });
});

app.get('/api/logs', (req, res) => {
  res.json({ success: true, logs: logger.getRecentLogs() });
});

app.get('/api/logs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  registerSSEClient(res);
});

app.post('/api/logs/clear', (req, res) => {
  logger.clear();
  res.json({ success: true });
});

// ----------------- PLAUD & USER ROUTES ----------------- //

app.get('/api/user', async (req, res) => {
  try {
    const user = await getCurrentUser();
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/plaud/status', async (req, res) => {
  try {
    const status = await getPlaudAuthStatus();
    res.json({ success: true, ...status });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/sync', async (req, res) => {
  try {
    const result = await syncAllRecordings();
    const stats = getStats();
    res.json({ success: true, result, stats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/stats', (req, res) => {
  try {
    res.json({ success: true, stats: getStats() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------- RECORDINGS ROUTES ----------------- //

function enrichRecordingWithAudio(recording, localFilesSet = null) {
  if (!recording) return recording;
  const audioFileName = recording.audio_file || `${recording.id}.ogg`;
  let hasAudio = false;
  if (localFilesSet) {
    hasAudio = localFilesSet.has(audioFileName) || localFilesSet.has(`${recording.id}.ogg`);
  } else {
    hasAudio = fs.existsSync(path.join(AUDIO_DIR, audioFileName)) || fs.existsSync(path.join(AUDIO_DIR, `${recording.id}.ogg`));
  }
  return {
    ...recording,
    has_local_audio: hasAudio ? 1 : 0,
    audio_file: hasAudio ? audioFileName : ''
  };
}

app.get('/api/recordings', (req, res) => {
  try {
    const { category, project_or_class, status, query, sortBy, order } = req.query;
    const recordings = listRecordings({
      category,
      project_or_class,
      status,
      query,
      sortBy,
      order
    });

    const localAudioFiles = new Set(fs.existsSync(AUDIO_DIR) ? fs.readdirSync(AUDIO_DIR) : []);

    // Attach active job status if in progress
    const items = recordings.map((r) => {
      const job = activeJobs.get(r.id);
      const enriched = enrichRecordingWithAudio(r, localAudioFiles);
      return {
        ...enriched,
        active_job: job || null
      };
    });

    res.json({ success: true, recordings: items });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/recordings/:id', (req, res) => {
  try {
    const recording = getRecording(req.params.id);
    if (!recording) {
      return res.status(404).json({ success: false, error: 'Recording not found' });
    }
    const job = activeJobs.get(recording.id);
    const enriched = enrichRecordingWithAudio(recording);
    res.json({ success: true, recording: { ...enriched, active_job: job || null } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.patch('/api/recordings/:id', (req, res) => {
  try {
    updateRecording(req.params.id, req.body);
    const updated = getRecording(req.params.id);
    res.json({ success: true, recording: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.patch('/api/recordings/:id/speakers', (req, res) => {
  try {
    const { id } = req.params;
    const { speakerNames } = req.body;
    const recording = getRecording(id);
    if (!recording) return res.status(404).json({ success: false, error: 'Recording not found' });

    let currentMapping = {};
    try {
      currentMapping = JSON.parse(recording.speaker_names || '{}');
    } catch (_) {}

    const updatedMapping = { ...currentMapping, ...(speakerNames || {}) };

    updateRecording(id, {
      speaker_names: JSON.stringify(updatedMapping)
    });

    const updated = getRecording(id);
    res.json({ success: true, recording: updated, speakerNames: updatedMapping });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/recordings/:id', (req, res) => {
  try {
    deleteRecording(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/recordings/:id/cloud-sync', async (req, res) => {
  try {
    const { id } = req.params;
    const recording = getRecording(id);
    if (!recording) return res.status(404).json({ success: false, error: 'Recording not found' });

    logger.stage('syncing', `Fetching cloud notes & transcript for "${recording.name}"...`, { recordingId: id });
    const cloudResult = await fetchRecordingCloudData(id);
    const updated = getRecording(id);

    logger.stage('ready', `Synced cloud content for "${recording.name}".`);
    res.json({
      success: true,
      recording: updated,
      cloudResult
    });
  } catch (err) {
    logger.error(`Failed to sync cloud content for recording ${req.params.id}: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------- PROCESSING PIPELINE ----------------- //

// Full automated pipeline: Download -> Transcribe -> Summarize
app.post('/api/recordings/:id/process', async (req, res) => {
  const { id } = req.params;
  const { category, customInstructions, engine } = req.body || {};

  const recording = getRecording(id);
  if (!recording) {
    return res.status(404).json({ success: false, error: 'Recording not found' });
  }

  if (activeJobs.has(id)) {
    return res.status(400).json({ success: false, error: 'Recording is already being processed' });
  }

  // Respond immediately so UI doesn't block, and run in background
  res.json({ success: true, message: 'Processing started in background' });

  (async () => {
    try {
      setJobProgress(id, 'downloading', `Downloading audio file: "${recording.name}"...`, recording.name);
      await downloadRecordingAudio(id, AUDIO_DIR);

      setJobProgress(id, 'transcribing', `Transcribing audio: "${recording.name}" via Whisper...`, recording.name);
      await transcribeRecording(id, (stage, msg) => setJobProgress(id, stage, msg, recording.name));

      const targetCategory = category || (recording.category !== 'unassigned' ? recording.category : 'lecture');
      setJobProgress(id, 'summarizing', `Creating notes for "${recording.name}"...`, recording.name);
      await summarizeRecording(id, { category: targetCategory, customInstructions, engine }, (stage, msg) =>
        setJobProgress(id, stage, msg, recording.name)
      );

      clearJob(id);
    } catch (err) {
      console.error(`Error processing recording ${id}:`, err);
      updateRecording(id, { status: 'error', error_message: err.message });
      clearJob(id);
    }
  })();
});

// Download Audio Only
app.post('/api/recordings/:id/download', async (req, res) => {
  const { id } = req.params;
  const rec = getRecording(id);
  const recName = rec ? rec.name : id;
  try {
    setJobProgress(id, 'downloading', `Downloading audio: "${recName}" from Plaud...`, recName);
    const result = await downloadRecordingAudio(id, AUDIO_DIR);
    clearJob(id);
    res.json({ success: true, result });
  } catch (err) {
    clearJob(id);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Transcribe Audio Only
app.post('/api/recordings/:id/transcribe', async (req, res) => {
  const { id } = req.params;
  const rec = getRecording(id);
  const recName = rec ? rec.name : id;
  try {
    res.json({ success: true, message: 'Transcription started' });
    (async () => {
      try {
        await transcribeRecording(id, (stage, msg) => setJobProgress(id, stage, msg, recName));
        clearJob(id);
      } catch (err) {
        clearJob(id);
        console.error(`Error transcribing recording ${id}:`, err);
        logger.error(`Error transcribing recording "${recName}": ${err.message}`, { recordingId: id, recordingName: recName });
        updateRecording(id, { status: 'error', error_message: err.message });
      }
    })();
  } catch (err) {
    clearJob(id);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Summarize Transcript Only
app.post('/api/recordings/:id/summarize', async (req, res) => {
  const { id } = req.params;
  const { category, customInstructions, engine } = req.body || {};
  const rec = getRecording(id);
  const recName = rec ? rec.name : id;
  try {
    res.json({ success: true, message: 'Summarization started' });
    (async () => {
      try {
        await summarizeRecording(id, { category, customInstructions, engine }, (stage, msg) => setJobProgress(id, stage, msg, recName));
        clearJob(id);
      } catch (err) {
        clearJob(id);
        console.error(`Error summarizing recording ${id}:`, err);
        logger.error(`Error summarizing recording "${recName}": ${err.message}`, { recordingId: id, recordingName: recName });
        updateRecording(id, { status: 'error', error_message: err.message });
      }
    })();
  } catch (err) {
    clearJob(id);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------- AUDIO STREAMING WITH HTTP RANGE ----------------- //

app.get('/api/recordings/:id/audio', (req, res) => {
  const { id } = req.params;
  const audioFile = path.join(AUDIO_DIR, `${id}.ogg`);

  if (!fs.existsSync(audioFile)) {
    return res.status(404).send('Audio file not found on disk. Download it first.');
  }

  const stat = fs.statSync(audioFile);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = end - start + 1;
    const file = fs.createReadStream(audioFile, { start, end });
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': 'audio/ogg'
    };
    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = {
      'Content-Length': fileSize,
      'Content-Type': 'audio/ogg'
    };
    res.writeHead(200, head);
    fs.createReadStream(audioFile).pipe(res);
  }
});

// ----------------- STANDALONE HTML EXPORT ----------------- //

app.get('/api/recordings/:id/export/html', (req, res) => {
  try {
    const rec = getRecording(req.params.id);
    if (!rec) return res.status(404).send('Recording not found');

    const standaloneHTML = generateStandaloneHTML(rec);
    const safeName = (rec.name || 'recording').replace(/[\\/:*?"<>|]/g, '_');
    const isDownload = req.query.download === '1' || req.query.download === 'true';

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `${isDownload ? 'attachment' : 'inline'}; filename="${encodeURIComponent(safeName)}.html"`);
    return res.send(standaloneHTML);
  } catch (err) {
    res.status(500).send(`Export failed: ${err.message}`);
  }
});

// Export single recording as Markdown (.md)
app.get('/api/recordings/:id/export/md', (req, res) => {
  try {
    const rec = getRecording(req.params.id);
    if (!rec) return res.status(404).send('Recording not found');

    const mdContent = generateExportMarkdown(rec);
    const safeName = (rec.name || 'recording').replace(/[\\/:*?"<>|]/g, '_');

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeName)}.md"`);
    res.send(mdContent);
  } catch (err) {
    res.status(500).send(`Export failed: ${err.message}`);
  }
});

// Bulk Export Archive (All summaries or scoped by folder as .zip)
app.get('/api/export/archive', async (req, res) => {
  try {
    const { folder, format = 'md' } = req.query;
    const allRecs = listRecordings();
    const filtered = allRecs.filter((r) => {
      if (folder && folder !== 'all') {
        const folders = parseFolders(r.project_or_class);
        return folders.includes(folder);
      }
      return true;
    });

    const withSummaries = filtered.filter(
      (r) => r.summary_markdown || r.plaud_summary_markdown || r.summary_html || r.plaud_summary_html
    );

    if (withSummaries.length === 0) {
      return res.status(404).json({ success: false, error: 'No recordings with summaries found to export.' });
    }

    const archive = new ZipArchive();
    const folderSlug = folder && folder !== 'all' ? folder.replace(/[^a-zA-Z0-9_-]/g, '_') : 'all_summaries';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const zipFilename = `plaud_${folderSlug}_${format}_${timestamp}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);

    archive.pipe(res);

    withSummaries.forEach((rec) => {
      const safeName = (rec.name || rec.id).replace(/[\\/:*?"<>|]/g, '_');
      const folders = parseFolders(rec.project_or_class);
      const folderSubdir = (folders[0] || 'General').replace(/[\\/:*?"<>|]/g, '_');
      const basePath = folder && folder !== 'all' ? '' : `${folderSubdir}/`;

      if (format === 'html') {
        const html = generateStandaloneHTML(rec);
        archive.append(html, { name: `${basePath}${safeName}.html` });
      } else {
        const md = generateExportMarkdown(rec);
        archive.append(md, { name: `${basePath}${safeName}.md` });
      }
    });

    await archive.finalize();
  } catch (err) {
    logger.error(`Archive export failed: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

// ----------------- KNOWLEDGE GRAPH & LLM Q&A ----------------- //

// Get Knowledge Graph nodes and edges (optionally scoped to a folder)
app.get('/api/knowledge/graph', (req, res) => {
  try {
    const { folder } = req.query;
    const allRecs = listRecordings();
    const withSummaries = allRecs.filter(r => r.summary_markdown || r.plaud_summary_markdown);
    const scoped = withSummaries.filter((r) => {
      if (folder && folder !== 'all') {
        const folders = parseFolders(r.project_or_class);
        return folders.includes(folder);
      }
      return true;
    });

    const graph = buildKnowledgeGraph(scoped);
    res.json({ success: true, ...graph });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Query Knowledge Graph & Summaries using the LLM
app.post('/api/knowledge/query', async (req, res) => {
  try {
    const { query, folder, engine } = req.body || {};
    const result = await queryKnowledgeGraphWithLLM({ query, folder, engine });
    const answerHtml = enhanceMarkdownToHTML(result.answer || '');
    res.json({ success: true, answerHtml, ...result });
  } catch (err) {
    logger.error(`Knowledge query error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});


function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ----------------- FOLDERS ROUTES ----------------- //

app.get('/api/projects', (req, res) => {
  try {
    const list = listProjects();
    res.json({ success: true, projects: list });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/projects', (req, res) => {
  try {
    const { name, color, description } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'Name is required' });
    upsertProject({ name, color, description });
    res.json({ success: true, projects: listProjects() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/projects/:name', (req, res) => {
  try {
    deleteProject(req.params.name);
    res.json({ success: true, projects: listProjects() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------- SETTINGS & MODELS ROUTES ----------------- //

app.get('/api/settings', (req, res) => {
  try {
    res.json({ success: true, settings: getAllSettings() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/settings', (req, res) => {
  try {
    setSettings(req.body);
    res.json({ success: true, settings: getAllSettings() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/models', (req, res) => {
  try {
    const models = [];
    const searchDirs = [
      path.join(os.homedir(), 'llama.cpp', 'models'),
      path.join(os.homedir(), 'Library', 'Application Support', 'Meetily', 'models', 'summary')
    ];

    for (const dir of searchDirs) {
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          if (file.endsWith('.gguf') && !file.startsWith('ggml-vocab-')) {
            const fullPath = path.join(dir, file);
            const stat = fs.statSync(fullPath);
            models.push({
              name: file,
              path: fullPath,
              sizeGB: (stat.size / (1024 * 1024 * 1024)).toFixed(2)
            });
          }
        }
      }
    }

    res.json({ success: true, models });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/remote-models', async (req, res) => {
  try {
    const apiUrl = req.query.url || getSetting('custom_api_url', 'http://localhost:8081/v1');
    const apiKey = req.query.apiKey || getSetting('custom_api_key', '');

    let cleanUrl = (apiUrl || '').trim().replace(/\/+$/, '');
    let endpoint = cleanUrl.endsWith('/models')
      ? cleanUrl
      : cleanUrl.endsWith('/v1')
      ? `${cleanUrl}/models`
      : `${cleanUrl}/v1/models`;

    const headers = {};
    if (apiKey && apiKey.trim()) {
      headers['Authorization'] = `Bearer ${apiKey.trim()}`;
    }

    let data;
    try {
      data = await curlRequest(endpoint, { method: 'GET', headers, timeout: 15 });
    } catch (err) {
      if (endpoint.startsWith('https://')) {
        const fallback = endpoint.replace('https://', 'http://');
        data = await curlRequest(fallback, { method: 'GET', headers, timeout: 15 });
      } else {
        throw err;
      }
    }

    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch (_) {}
    }

    let modelList = [];
    if (Array.isArray(data?.data)) {
      modelList = data.data.map((m) => m.id || m.name).filter(Boolean);
    } else if (Array.isArray(data?.models)) {
      modelList = data.models.map((m) => m.name || m.model || m.id).filter(Boolean);
    }

    res.json({ success: true, models: modelList, raw: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/gemini-models', async (req, res) => {
  try {
    const apiKey = (req.query.key || getSetting('gemini_api_key', '')).trim();
    if (!apiKey) {
      return res.status(400).json({ success: false, error: 'Gemini API key is required.' });
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
    const data = await curlRequest(url, { method: 'GET', timeout: 15 });

    if (data?.error) {
      return res.status(400).json({ success: false, error: data.error.message || JSON.stringify(data.error) });
    }

    if (!Array.isArray(data?.models)) {
      return res.status(500).json({ success: false, error: 'Invalid response from Google Generative Language API' });
    }

    const excludedKeywords = ['embedding', 'tts', 'image', 'banana', 'clip', 'robotics', 'lyria', 'computer-use', 'aqa'];
    const models = data.models
      .filter((m) => {
        const methods = m.supportedGenerationMethods || [];
        const isContentGen = methods.includes('generateContent');
        const id = (m.name || '').replace(/^models\//, '').toLowerCase();
        const hasExcluded = excludedKeywords.some((kw) => id.includes(kw));
        return isContentGen && !hasExcluded;
      })
      .map((m) => {
        const id = (m.name || '').replace(/^models\//, '');
        return {
          id,
          displayName: m.displayName || id,
          description: m.description || ''
        };
      });

    res.json({ success: true, models });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------- ON-DEVICE MODELS MANAGEMENT ----------------- //

app.get('/api/ondevice-models', (req, res) => {
  try {
    const models = getModelsStatus();
    res.json({ success: true, modelsDir: MODELS_DIR, models });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/ondevice-models/download', async (req, res) => {
  try {
    const { modelId } = req.body || {};
    if (!modelId) return res.status(400).json({ success: false, error: 'modelId is required' });
    const result = await downloadModel(modelId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/ondevice-models/copy', async (req, res) => {
  try {
    const { modelId } = req.body || {};
    if (!modelId) return res.status(400).json({ success: false, error: 'modelId is required' });
    const result = await copyModelFromSystem(modelId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export { app };

export function startServer(port = PORT) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && port !== 0) {
        console.warn(`Port ${port} in use, picking available port...`);
        resolve(startServer(0));
      } else {
        reject(err);
      }
    });

    server.listen(port, () => {
      const address = server.address();
      const actualPort = address && typeof address === 'object' ? address.port : port;
      console.log(`Plaud Studio app running on http://localhost:${actualPort}`);
      resolve({ server, port: actualPort });
    });
  });
}

// Start Server if run directly via Node CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startServer(PORT);
}
