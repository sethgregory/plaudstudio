import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { DB_PATH, MODELS_DIR } from './config.js';

export const db = new DatabaseSync(DB_PATH);

// Initialize schema
db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS recordings (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    original_name TEXT DEFAULT '',
    is_custom_name INTEGER DEFAULT 0,
    start_at TEXT,
    created_at TEXT,
    duration INTEGER DEFAULT 0,
    serial_number TEXT,
    category TEXT DEFAULT 'unassigned',
    project_or_class TEXT DEFAULT '',
    status TEXT DEFAULT 'available',
    error_message TEXT DEFAULT '',
    audio_file TEXT DEFAULT '',
    audio_url TEXT DEFAULT '',
    transcript_text TEXT DEFAULT '',
    transcript_json TEXT DEFAULT '',
    plaud_transcript_json TEXT DEFAULT '',
    plaud_summary_markdown TEXT DEFAULT '',
    plaud_summary_html TEXT DEFAULT '',
    has_plaud_cloud_content INTEGER DEFAULT 0,
    summary_markdown TEXT DEFAULT '',
    summary_html TEXT DEFAULT '',
    summary_type TEXT DEFAULT '',
    reasoning_text TEXT DEFAULT '',
    speaker_names TEXT DEFAULT '{}',
    user_notes TEXT DEFAULT '',
    synced_at TEXT,
    processed_at TEXT,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS projects (
    name TEXT PRIMARY KEY,
    type TEXT DEFAULT 'folder',
    color TEXT DEFAULT '#3b82f6',
    description TEXT DEFAULT '',
    created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Safe migrations
try {
  db.exec("ALTER TABLE recordings ADD COLUMN original_name TEXT DEFAULT ''");
} catch (_) {}

try {
  db.exec("ALTER TABLE recordings ADD COLUMN is_custom_name INTEGER DEFAULT 0");
} catch (_) {}

try {
  db.exec("UPDATE recordings SET original_name = name WHERE original_name IS NULL OR original_name = ''");
} catch (_) {}

try {
  db.exec("ALTER TABLE recordings ADD COLUMN speaker_names TEXT DEFAULT '{}'");
} catch (_) {}

try {
  db.exec("ALTER TABLE recordings ADD COLUMN plaud_transcript_json TEXT DEFAULT ''");
} catch (_) {}

try {
  db.exec("ALTER TABLE recordings ADD COLUMN plaud_summary_markdown TEXT DEFAULT ''");
} catch (_) {}

try {
  db.exec("ALTER TABLE recordings ADD COLUMN plaud_summary_html TEXT DEFAULT ''");
} catch (_) {}

try {
  db.exec("ALTER TABLE recordings ADD COLUMN has_plaud_cloud_content INTEGER DEFAULT 0");
} catch (_) {}

try {
  db.exec("UPDATE projects SET type = 'folder' WHERE type != 'folder'");
} catch (_) {}

try {
  const plainRows = db.prepare("SELECT id, project_or_class FROM recordings WHERE project_or_class != '' AND project_or_class IS NOT NULL").all();
  for (const r of plainRows) {
    if (!r.project_or_class.startsWith('[')) {
      db.prepare("UPDATE recordings SET project_or_class = ? WHERE id = ?").run(
        JSON.stringify([r.project_or_class]),
        r.id
      );
    }
  }
} catch (_) {}

// Seed default settings
const defaultSettings = {
  whisper_model_path: path.join(MODELS_DIR, 'ggml-large-v3-turbo.bin'),
  whisper_threads: '6',
  diarization_enabled: 'true',
  diarization_model_path: path.join(MODELS_DIR, 'nemotron3_diar_v3.onnx'),
  llm_provider: 'gemini',
  local_model_path: path.join(MODELS_DIR, 'Qwen3.5-4B-Q4_K_M.gguf'),
  custom_api_url: 'http://localhost:8081/v1',
  custom_api_key: '',
  custom_api_model: '',
  gemini_api_key: '',
  gemini_model: 'gemini-2.5-flash',
  default_category: 'lecture'
};

const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSettingStmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');

for (const [key, value] of Object.entries(defaultSettings)) {
  const existing = getSettingStmt.get(key);
  if (!existing) {
    setSettingStmt.run(key, value);
  }
}

// Model & Recording Helper Functions
export function getSetting(key, fallback = '') {
  const row = getSettingStmt.get(key);
  return row ? row.value : fallback;
}

export function getAllSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const r of rows) {
    settings[r.key] = r.value;
  }
  return settings;
}

export function setSettings(settingsObj) {
  for (const [key, val] of Object.entries(settingsObj)) {
    setSettingStmt.run(key, String(val ?? ''));
  }
}

export function upsertPlaudRecording(file) {
  const existing = db.prepare('SELECT id, name, original_name, is_custom_name, category, project_or_class, status, audio_file, transcript_json, summary_html FROM recordings WHERE id = ?').get(file.id);
  const now = new Date().toISOString();
  const plaudName = file.name || 'Untitled Recording';

  if (existing) {
    // Keep user's custom title if renamed locally, and preserve original Plaud title
    const hasCustomTitle = existing.is_custom_name === 1 || (existing.name && existing.name !== plaudName);
    const finalName = hasCustomTitle ? existing.name : plaudName;
    const originalTitle = plaudName || existing.original_name || existing.name;

    const stmt = db.prepare(`
      UPDATE recordings
      SET name = ?, original_name = ?, is_custom_name = ?, start_at = ?, duration = ?, serial_number = ?, synced_at = ?, updated_at = ?
      WHERE id = ?
    `);
    stmt.run(
      finalName,
      originalTitle,
      hasCustomTitle ? 1 : 0,
      file.start_at || file.created_at || now,
      file.duration || 0,
      file.serial_number || '',
      now,
      now,
      file.id
    );
  } else {
    // Determine initial category recommendation
    let category = 'unassigned';
    const lowerName = plaudName.toLowerCase();
    if (lowerName.includes('lecture') || lowerName.includes('class') || lowerName.includes('lesson')) {
      category = 'lecture';
    } else if (lowerName.includes('meeting') || lowerName.includes('sync') || lowerName.includes('standup') || lowerName.includes('1:1')) {
      category = 'meeting';
    }

    const stmt = db.prepare(`
      INSERT INTO recordings (
        id, name, original_name, is_custom_name, start_at, created_at, duration, serial_number, category, status, synced_at, updated_at
      ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, 'available', ?, ?)
    `);
    stmt.run(
      file.id,
      plaudName,
      plaudName,
      file.start_at || file.created_at || now,
      file.created_at || now,
      file.duration || 0,
      file.serial_number || '',
      category,
      now,
      now
    );
  }
}

export function getRecording(id) {
  return db.prepare('SELECT * FROM recordings WHERE id = ?').get(id);
}

export function parseFolders(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val.filter(Boolean);
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed.filter(Boolean);
      } catch (_) {}
    }
    return [trimmed];
  }
  return [];
}

export function updateRecording(id, fields) {
  const allowed = [
    'name', 'original_name', 'is_custom_name', 'category', 'project_or_class', 'status', 'error_message',
    'audio_file', 'audio_url', 'transcript_text', 'transcript_json',
    'plaud_transcript_json', 'plaud_summary_markdown', 'plaud_summary_html', 'has_plaud_cloud_content',
    'summary_markdown', 'summary_html', 'summary_type', 'reasoning_text',
    'speaker_names', 'user_notes', 'processed_at'
  ];

  const existing = getRecording(id);
  if (fields.name && existing) {
    if (!existing.original_name) {
      fields.original_name = existing.name;
    }
    if (fields.is_custom_name === undefined) {
      fields.is_custom_name = fields.name !== (existing.original_name || existing.name) ? 1 : existing.is_custom_name;
    }
  }

  const updates = [];
  const values = [];

  for (const [key, val] of Object.entries(fields)) {
    if (allowed.includes(key)) {
      updates.push(`${key} = ?`);
      if (key === 'project_or_class') {
        const folders = parseFolders(val);
        values.push(folders.length > 0 ? JSON.stringify(folders) : '');
      } else {
        values.push(val);
      }
    }
  }

  if (updates.length === 0) return;

  updates.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  const sql = `UPDATE recordings SET ${updates.join(', ')} WHERE id = ?`;
  db.prepare(sql).run(...values);
}

export function listRecordings({
  category,
  project_or_class,
  status,
  query,
  sortBy = 'start_at',
  order = 'DESC'
} = {}) {
  let where = [];
  let params = [];

  if (category && category !== 'all') {
    if (category === 'unassigned') {
      where.push("(category = 'unassigned' OR category = '' OR category IS NULL)");
    } else {
      where.push('category = ?');
      params.push(category);
    }
  }

  if (project_or_class && project_or_class !== 'all') {
    if (project_or_class === 'none') {
      where.push("(project_or_class = '' OR project_or_class IS NULL OR project_or_class = '[]')");
    } else {
      where.push("(project_or_class = ? OR project_or_class LIKE ?)");
      params.push(project_or_class, `%"${project_or_class}"%`);
    }
  }

  if (status && status !== 'all') {
    if (status === 'local') {
      where.push("(audio_file != '' AND audio_file IS NOT NULL)");
    } else if (status === 'cloud' || status === 'available') {
      where.push("(audio_file = '' OR audio_file IS NULL)");
    } else if (status === 'audio_ready' || status === 'local_audio') {
      where.push("(audio_file != '' AND (transcript_text = '' OR transcript_text IS NULL) AND status != 'ready')");
    } else if (status === 'ready') {
      where.push("status = 'ready'");
    } else if (status === 'transcribed') {
      where.push("status = 'transcribed'");
    } else {
      where.push('status = ?');
      params.push(status);
    }
  }

  if (query && query.trim()) {
    const q = `%${query.trim()}%`;
    where.push('(name LIKE ? OR project_or_class LIKE ? OR transcript_text LIKE ? OR summary_markdown LIKE ?)');
    params.push(q, q, q, q);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const validSortColumns = ['start_at', 'created_at', 'name', 'duration', 'updated_at'];
  const sortCol = validSortColumns.includes(sortBy) ? sortBy : 'start_at';
  const sortDir = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const sql = `SELECT * FROM recordings ${whereClause} ORDER BY ${sortCol} ${sortDir}`;
  return db.prepare(sql).all(...params);
}

export function deleteRecording(id) {
  db.prepare('DELETE FROM recordings WHERE id = ?').run(id);
}

export function listProjects() {
  return db.prepare('SELECT * FROM projects ORDER BY name ASC').all();
}

export function upsertProject({ name, color = '#3b82f6', description = '' }) {
  if (!name || !name.trim()) return null;
  const cleanName = name.trim();
  const existing = db.prepare('SELECT name FROM projects WHERE name = ?').get(cleanName);
  const now = new Date().toISOString();

  if (existing) {
    db.prepare('UPDATE projects SET type = ?, color = ?, description = ? WHERE name = ?')
      .run('folder', color, description, cleanName);
  } else {
    db.prepare('INSERT INTO projects (name, type, color, description, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(cleanName, 'folder', color, description, now);
  }
  return cleanName;
}

export function deleteProject(name) {
  db.prepare('DELETE FROM projects WHERE name = ?').run(name);
  // Remove folder from any recordings tagged with it
  const rows = db.prepare("SELECT id, project_or_class FROM recordings WHERE project_or_class LIKE ? OR project_or_class = ?")
    .all(`%"${name}"%`, name);
  for (const row of rows) {
    const folders = parseFolders(row.project_or_class).filter(f => f !== name);
    const newVal = folders.length > 0 ? JSON.stringify(folders) : '';
    db.prepare('UPDATE recordings SET project_or_class = ? WHERE id = ?').run(newVal, row.id);
  }
}

export function getStats() {
  const total = db.prepare('SELECT count(*) as count FROM recordings').get().count;
  const ready = db.prepare("SELECT count(*) as count FROM recordings WHERE status = 'ready'").get().count;
  const transcribed = db.prepare("SELECT count(*) as count FROM recordings WHERE status = 'transcribed'").get().count;
  const audioReady = db.prepare("SELECT count(*) as count FROM recordings WHERE audio_file != '' AND (transcript_text = '' OR transcript_text IS NULL) AND status != 'ready'").get().count;
  const cloud = db.prepare("SELECT count(*) as count FROM recordings WHERE audio_file = '' OR audio_file IS NULL").get().count;
  const local = db.prepare("SELECT count(*) as count FROM recordings WHERE audio_file != '' AND audio_file IS NOT NULL").get().count;

  const downloaded = local;
  const totalTranscribed = db.prepare("SELECT count(*) as count FROM recordings WHERE transcript_text != ''").get().count;
  const summarized = db.prepare("SELECT count(*) as count FROM recordings WHERE summary_html != ''").get().count;
  const cloudContent = db.prepare("SELECT count(*) as count FROM recordings WHERE has_plaud_cloud_content = 1 OR plaud_summary_html != '' OR plaud_transcript_json != ''").get().count;
  const totalDuration = db.prepare('SELECT coalesce(sum(duration), 0) as duration FROM recordings').get().duration;

  // Compute accurate global folder counts across all recordings
  const rows = db.prepare("SELECT project_or_class FROM recordings WHERE project_or_class != '' AND project_or_class IS NOT NULL").all();
  const folderCounts = {};
  for (const row of rows) {
    const folders = parseFolders(row.project_or_class);
    for (const f of folders) {
      folderCounts[f] = (folderCounts[f] || 0) + 1;
    }
  }

  return {
    total,
    ready,
    transcribed,
    audioReady,
    cloud,
    local,
    downloaded,
    totalTranscribed,
    summarized,
    cloudContent,
    totalDurationMs: totalDuration,
    totalHours: (totalDuration / (1000 * 60 * 60)).toFixed(1),
    folderCounts
  };
}
