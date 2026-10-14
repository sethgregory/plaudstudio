// Plaud Studio Centralized Logger & Real-Time Event Stream

import { EventEmitter } from 'node:events';

class LogEmitter extends EventEmitter {}
export const logEvents = new EventEmitter();
logEvents.setMaxListeners(100);

const MAX_LOGS = 600;
const logHistory = [];
let logCounter = 0;

// Active stage tracking for status bar
let currentGlobalStatus = {
  state: 'idle', // 'idle' | 'busy'
  stage: '', // 'downloading' | 'converting' | 'transcribing' | 'diarizing' | 'summarizing' | 'syncing'
  stageLabel: 'Ready',
  message: 'Plaud Studio is ready',
  recordingId: null,
  recordingName: '',
  startedAt: null,
  activeCount: 0
};

export function getGlobalStatus() {
  return currentGlobalStatus;
}

export function updateGlobalStatus({ state, stage, stageLabel, message, recordingId, recordingName }) {
  currentGlobalStatus = {
    state: state ?? currentGlobalStatus.state,
    stage: stage ?? currentGlobalStatus.stage,
    stageLabel: stageLabel ?? currentGlobalStatus.stageLabel,
    message: message ?? currentGlobalStatus.message,
    recordingId: recordingId ?? currentGlobalStatus.recordingId,
    recordingName: recordingName ?? currentGlobalStatus.recordingName,
    startedAt: state === 'busy' ? (currentGlobalStatus.startedAt || new Date().toISOString()) : null,
    activeCount: state === 'busy' ? Math.max(1, currentGlobalStatus.activeCount) : 0
  };

  broadcastSSE('status', currentGlobalStatus);
}

export function setIdleStatus(message = 'Plaud Studio is ready') {
  currentGlobalStatus = {
    state: 'idle',
    stage: '',
    stageLabel: 'Idle',
    message,
    recordingId: null,
    recordingName: '',
    startedAt: null,
    activeCount: 0
  };

  broadcastSSE('status', currentGlobalStatus);
}

export function addLogEntry(level, message, meta = {}) {
  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) + '.' + String(now.getMilliseconds()).padStart(3, '0');

  const entry = {
    id: ++logCounter,
    timestamp: now.toISOString(),
    timeStr,
    level, // 'info', 'stage', 'warn', 'error', 'whisper', 'llm', 'ffmpeg'
    message: typeof message === 'string' ? message : JSON.stringify(message),
    stage: meta.stage || '',
    recordingId: meta.recordingId || '',
    recordingName: meta.recordingName || ''
  };

  logHistory.push(entry);
  if (logHistory.length > MAX_LOGS) {
    logHistory.shift();
  }

  broadcastSSE('log', entry);
  return entry;
}

// SSE Connection Management
const sseClients = new Set();

export function registerSSEClient(res) {
  sseClients.add(res);

  // Send initial state: recent logs and current status
  const initPayload = {
    type: 'init',
    status: currentGlobalStatus,
    logs: logHistory
  };
  res.write(`data: ${JSON.stringify(initPayload)}\n\n`);

  res.on('close', () => {
    sseClients.delete(res);
  });
}

export function broadcastSSE(type, data) {
  const payload = `data: ${JSON.stringify({ type, data })}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch (_) {
      sseClients.delete(client);
    }
  }
}

export const logger = {
  info(msg, meta) {
    const formatted = `[INFO] ${msg}`;
    console.log(formatted);
    return addLogEntry('info', msg, meta);
  },
  stage(stage, msg, meta = {}) {
    const stageIcons = {
      downloading: '⬇️ Downloading',
      converting: '🔄 Converting',
      transcribing: '🎙️ Transcribing',
      diarizing: '👥 Diarizing',
      summarizing: '🧠 Summarizing',
      syncing: '🔄 Syncing',
      ready: '✅ Ready',
      error: '⚠️ Error'
    };
    const stageLabel = stageIcons[stage] || stage.toUpperCase();

    updateGlobalStatus({
      state: stage === 'ready' || stage === 'idle' ? 'idle' : 'busy',
      stage,
      stageLabel,
      message: msg,
      recordingId: meta.recordingId,
      recordingName: meta.recordingName
    });

    const formatted = `[STAGE:${stage.toUpperCase()}] ${msg}`;
    console.log(formatted);
    return addLogEntry('stage', msg, { ...meta, stage });
  },
  whisper(msg, meta) {
    const formatted = `[WHISPER] ${msg}`;
    console.log(formatted);
    return addLogEntry('whisper', msg, meta);
  },
  llm(msg, meta) {
    const formatted = `[LLM] ${msg}`;
    console.log(formatted);
    return addLogEntry('llm', msg, meta);
  },
  ffmpeg(msg, meta) {
    const formatted = `[FFMPEG] ${msg}`;
    console.log(formatted);
    return addLogEntry('ffmpeg', msg, meta);
  },
  warn(msg, meta) {
    const formatted = `[WARN] ${msg}`;
    console.warn(formatted);
    return addLogEntry('warn', msg, meta);
  },
  error(msg, meta) {
    const formatted = `[ERROR] ${msg}`;
    console.error(formatted);
    return addLogEntry('error', msg, meta);
  },
  getRecentLogs() {
    return [...logHistory];
  },
  clear() {
    logHistory.length = 0;
    broadcastSSE('clear', {});
  }
};
