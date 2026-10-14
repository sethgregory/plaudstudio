import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { upsertPlaudRecording, updateRecording, getRecording } from './db.js';
import { logger } from './logger.js';
import { enhanceMarkdownToHTML } from './summarize.js';

const TOKEN_PATH = path.join(os.homedir(), '.plaud', 'tokens-mcp.json');
const API_BASE = 'https://platform.plaud.ai/developer/api';

function getStoredTokens() {
  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error(`Plaud token file not found at ${TOKEN_PATH}. Please run Plaud login first.`);
  }
  return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
}

async function refreshAccessToken(refreshToken) {
  const refreshUrl = `${API_BASE}/oauth/third-party/access-token/refresh`;
  const res = await fetch(refreshUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json'
    },
    body: new URLSearchParams({ refresh_token: refreshToken })
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${errorBody}`);
  }

  const data = await res.json();
  const current = getStoredTokens();
  const updatedTokens = {
    ...current,
    access_token: data.access_token,
    refresh_token: data.refresh_token || refreshToken,
    token_type: data.token_type || 'Bearer',
    expires_at: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined
  };

  fs.writeFileSync(TOKEN_PATH, JSON.stringify(updatedTokens, null, 2));
  return updatedTokens.access_token;
}

export async function getValidAccessToken() {
  const tokens = getStoredTokens();
  // Refresh if expired or expiring within 60 seconds
  if (tokens.expires_at && Date.now() > tokens.expires_at - 60000) {
    return await refreshAccessToken(tokens.refresh_token);
  }
  return tokens.access_token;
}

async function plaudFetch(endpoint, options = {}) {
  let token = await getValidAccessToken();
  const url = endpoint.startsWith('http') ? endpoint : `${API_BASE}${endpoint}`;

  let res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
      ...(options.headers || {})
    }
  });

  // If 401 Unauthorized, attempt refresh once
  if (res.status === 401) {
    const tokens = getStoredTokens();
    if (tokens.refresh_token) {
      token = await refreshAccessToken(tokens.refresh_token);
      res = await fetch(url, {
        ...options,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
          ...(options.headers || {})
        }
      });
    }
  }

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Plaud API error (${res.status} ${res.statusText}): ${errText}`);
  }

  return await res.json();
}

export async function getCurrentUser() {
  return await plaudFetch('/open/third-party/users/current');
}

export async function listFiles(page = 1, pageSize = 50) {
  const params = new URLSearchParams({
    page: String(page),
    page_size: String(pageSize)
  });
  return await plaudFetch(`/open/third-party/files/?${params.toString()}`);
}

export async function getFile(fileId) {
  return await plaudFetch(`/open/third-party/files/${encodeURIComponent(fileId)}`);
}

function formatMsToTimestamp(ms) {
  if (typeof ms !== 'number' || isNaN(ms) || ms < 0) ms = 0;
  const totalSeconds = Math.floor(ms / 1000);
  const milliseconds = Math.floor(ms % 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(milliseconds, 3)}`;
}

async function fetchBlockText(block) {
  if (!block) return '';
  if (typeof block.data_content === 'string' && block.data_content.trim().length > 0) {
    return block.data_content;
  }
  if (typeof block.data_link === 'string' && block.data_link.startsWith('http')) {
    try {
      const res = await fetch(block.data_link);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      console.warn(`Failed to fetch data_link for block ${block.data_type || ''}:`, err.message);
      return '';
    }
  }
  return '';
}

export async function fetchRecordingCloudData(fileId, fileDetail = null) {
  try {
    const detail = fileDetail || (await getFile(fileId));
    if (!detail) return { hasTranscript: false, hasSummary: false };

    const currentRec = getRecording(fileId) || {};
    let normalizedSegments = null;
    let fullTranscriptText = '';

    // 1. Process Transcript from source_list
    const sourceList = detail.source_list || [];
    const transBlock = sourceList.find((s) => s.data_type === 'transaction') ||
                       sourceList.find((s) => s.data_type === 'transaction_polish');

    if (transBlock) {
      const transRaw = await fetchBlockText(transBlock);
      if (transRaw) {
        try {
          const parsed = JSON.parse(transRaw);
          if (Array.isArray(parsed) && parsed.length > 0) {
            normalizedSegments = parsed.map((s) => {
              const startMs = typeof s.start_time === 'number' ? s.start_time : 0;
              const endMs = typeof s.end_time === 'number' ? s.end_time : startMs + 1000;
              return {
                offsets: { from: startMs, to: endMs },
                timestamps: { from: formatMsToTimestamp(startMs), to: formatMsToTimestamp(endMs) },
                speaker: s.speaker || s.original_speaker || 'Speaker',
                text: (s.content || s.text || '').trim()
              };
            });
            fullTranscriptText = normalizedSegments
              .map((s) => `[${s.timestamps.from.split(',')[0]}] ${s.speaker}: ${s.text}`)
              .join('\n\n');
          }
        } catch (e) {
          console.warn(`Could not parse cloud transcript JSON for ${fileId}:`, e.message);
        }
      }
    }

    // 2. Process Summary from note_list
    const noteList = detail.note_list || [];
    const summaryBlock = noteList.find((n) => n.data_type === 'auto_sum_note') ||
                        noteList.find((n) => n.data_type?.includes('note') || n.data_type?.includes('summary')) ||
                        noteList[0];

    let summaryMarkdown = '';
    let summaryHtml = '';

    if (summaryBlock) {
      summaryMarkdown = await fetchBlockText(summaryBlock);
      if (summaryMarkdown) {
        summaryHtml = enhanceMarkdownToHTML(summaryMarkdown);
      }
    }

    // 3. Update Database Record
    const updates = {};
    let updatedAny = false;

    if (normalizedSegments && normalizedSegments.length > 0) {
      updates.plaud_transcript_json = JSON.stringify(normalizedSegments);
      // If local Whisper transcript is missing, adopt the Plaud cloud transcript
      if (!currentRec.transcript_json || currentRec.transcript_json === '[]' || !currentRec.transcript_text) {
        updates.transcript_json = JSON.stringify(normalizedSegments);
        updates.transcript_text = fullTranscriptText;
        if (currentRec.status === 'available' || currentRec.status === 'downloading' || currentRec.status === 'audio_ready') {
          updates.status = 'transcribed';
        }
      }
      updates.has_plaud_cloud_content = 1;
      updatedAny = true;
    }

    if (summaryMarkdown) {
      updates.plaud_summary_markdown = summaryMarkdown;
      updates.plaud_summary_html = summaryHtml;
      updates.has_plaud_cloud_content = 1;
      // If recording status is not already ready and has transcript, mark ready
      if (currentRec.status !== 'ready' && (updates.transcript_json || currentRec.transcript_json)) {
        updates.status = 'ready';
      }
      updatedAny = true;
    }

    if (updatedAny) {
      updateRecording(fileId, updates);
    }

    return {
      hasTranscript: Boolean(normalizedSegments && normalizedSegments.length > 0),
      hasSummary: Boolean(summaryMarkdown),
      segmentsCount: normalizedSegments?.length || 0,
      summaryLength: summaryMarkdown?.length || 0
    };
  } catch (err) {
    console.error(`Error in fetchRecordingCloudData for ${fileId}:`, err.message);
    return { hasTranscript: false, hasSummary: false, error: err.message };
  }
}

export async function syncAllRecordings() {
  let page = 1;
  const pageSize = 100;
  let totalFetched = 0;
  const fetchedFiles = [];
  let hasMore = true;

  logger.stage('syncing', 'Syncing recordings from Plaud Cloud API...');

  while (hasMore) {
    logger.info(`Fetching page ${page} from Plaud API...`);
    const resp = await listFiles(page, pageSize);
    const files = resp.data || [];
    if (files.length === 0) break;

    for (const file of files) {
      upsertPlaudRecording(file);
      fetchedFiles.push(file);
      totalFetched++;
    }

    if (files.length < pageSize) {
      hasMore = false;
    } else {
      page++;
    }
  }

  // Pass 2: Check and pull down remote cloud transcripts & summaries
  logger.stage('syncing', `Checking cloud transcripts & summaries for ${fetchedFiles.length} recordings...`);
  let cloudTranscriptsCount = 0;
  let cloudSummariesCount = 0;

  // Process in concurrent batches of 6
  const BATCH_SIZE = 6;
  for (let i = 0; i < fetchedFiles.length; i += BATCH_SIZE) {
    const chunk = fetchedFiles.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      chunk.map(async (file) => {
        try {
          return await fetchRecordingCloudData(file.id);
        } catch (_) {
          return null;
        }
      })
    );

    for (const r of results) {
      if (r?.hasTranscript) cloudTranscriptsCount++;
      if (r?.hasSummary) cloudSummariesCount++;
    }

    const completed = Math.min(i + BATCH_SIZE, fetchedFiles.length);
    logger.stage('syncing', `Synced ${completed}/${fetchedFiles.length} recordings (${cloudSummariesCount} Plaud summaries, ${cloudTranscriptsCount} transcripts)...`);
  }

  logger.stage('ready', `✅ Synced ${totalFetched} recordings (${cloudSummariesCount} Plaud cloud summaries & ${cloudTranscriptsCount} transcripts retrieved).`);
  return {
    totalSynced: totalFetched,
    cloudSummaries: cloudSummariesCount,
    cloudTranscripts: cloudTranscriptsCount
  };
}

export async function downloadRecordingAudio(fileId, targetDirectory) {
  if (!fs.existsSync(targetDirectory)) {
    fs.mkdirSync(targetDirectory, { recursive: true });
  }

  const filePath = path.join(targetDirectory, `${fileId}.ogg`);

  const current = getRecording(fileId);
  const nextStatus = (current?.status === 'ready' || current?.summary_html || current?.plaud_summary_html)
    ? 'ready'
    : (current?.status === 'transcribed' || current?.transcript_json)
      ? 'transcribed'
      : 'audio_ready';

  // If file already exists and has size, return existing path
  if (fs.existsSync(filePath)) {
    const stats = fs.statSync(filePath);
    if (stats.size > 1000) {
      updateRecording(fileId, {
        audio_file: `${fileId}.ogg`,
        status: nextStatus
      });
      logger.info(`Using cached audio file for ${fileId} (${(stats.size / 1024 / 1024).toFixed(1)} MB)`);
      return { path: filePath, cached: true, size: stats.size };
    }
  }

  updateRecording(fileId, { status: 'downloading' });
  logger.stage('downloading', `Downloading audio stream for ${fileId} from Plaud S3...`, { recordingId: fileId });

  // Get file record to receive fresh presigned url
  const fileDetail = await getFile(fileId);
  const audioUrl = fileDetail.presigned_url;
  if (!audioUrl) {
    throw new Error(`Recording ${fileId} has no audio download URL.`);
  }

  const res = await fetch(audioUrl);
  if (!res.ok) {
    throw new Error(`Failed to download audio stream from S3: ${res.status} ${res.statusText}`);
  }

  const fileStream = fs.createWriteStream(filePath);
  await finished(Readable.fromWeb(res.body).pipe(fileStream));

  const stats = fs.statSync(filePath);
  updateRecording(fileId, {
    audio_file: `${fileId}.ogg`,
    audio_url: audioUrl,
    status: nextStatus
  });

  logger.stage('ready', `✅ Audio download complete for ${fileId} (${(stats.size / 1024 / 1024).toFixed(1)} MB).`, { recordingId: fileId });
  return { path: filePath, cached: false, size: stats.size };
}
