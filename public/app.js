// Plaud Studio Client Application

let allRecordings = [];
let allProjects = [];
let libraryFolderCounts = {};
let currentFilter = { project_or_class: 'all', status: 'all' };
let currentSearch = '';
let currentSort = 'start_at:DESC';
let currentView = 'timeline'; // 'timeline' or 'grouped'
let activeRecordingId = null;
let pollTimer = null;
let hadActiveJobs = false;

// Live Logging & Global Status
let logEntries = [];
let logFilter = 'all';
let logAutoScroll = true;
let isLogsDrawerOpen = false;
let logEventSource = null;
let currentGlobalStatus = {
  state: 'idle',
  stage: '',
  stageLabel: 'Ready',
  message: 'Plaud Studio is ready',
  recordingId: null,
  recordingName: ''
};

// Audio player state
const audioPlayer = document.getElementById('global-audio-player');
let currentTranscriptSegments = [];
let currentRecordingSpeakerMap = {};

function parseFolders(val) {
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

// ---------------- Initialization ---------------- //

async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    const data = await res.json();
    if (data.success && data.settings) {
      const s = data.settings;
      const provEl = document.getElementById('setting-llm-provider');
      if (provEl && s.llm_provider) provEl.value = s.llm_provider;
      const urlEl = document.getElementById('setting-api-url');
      if (urlEl && s.custom_api_url) urlEl.value = s.custom_api_url;
      const keyEl = document.getElementById('setting-api-key');
      if (keyEl && s.custom_api_key) keyEl.value = s.custom_api_key;
      const modelEl = document.getElementById('setting-api-model');
      if (modelEl && s.custom_api_model) modelEl.value = s.custom_api_model;
      const gemKeyEl = document.getElementById('setting-gemini-key');
      if (gemKeyEl && s.gemini_api_key) gemKeyEl.value = s.gemini_api_key;
      const gemModelEl = document.getElementById('setting-gemini-model');
      if (gemModelEl && s.gemini_model) gemModelEl.value = s.gemini_model;
      const whisperEl = document.getElementById('setting-whisper-model');
      if (whisperEl && s.whisper_model_path) whisperEl.value = s.whisper_model_path;
      const diarCheck = document.getElementById('setting-diarization-enabled');
      if (diarCheck && s.diarization_enabled !== undefined) diarCheck.checked = s.diarization_enabled !== 'false';

      // Engine status pill in status bar
      const enginePill = document.getElementById('status-engine-pill');
      if (enginePill) {
        let provName = 'Gemini';
        if (s.llm_provider === 'local_llama') provName = 'Local LLM';
        else if (s.llm_provider === 'custom_api') provName = s.custom_api_model || 'Custom API';
        enginePill.textContent = `⚡ Whisper Metal • ${provName}`;
      }
    }
  } catch (_) {}
}

function initApp() {
  try { initEventListeners(); } catch (e) { console.error('initEventListeners error:', e); }
  try { loadUser(); } catch (e) { console.error('loadUser error:', e); }
  try { loadProjects(); } catch (e) { console.error('loadProjects error:', e); }
  try { loadSettings(); } catch (e) { console.error('loadSettings error:', e); }
  try { loadRecordings(); } catch (e) { console.error('loadRecordings error:', e); }
  try { loadStats(); } catch (e) { console.error('loadStats error:', e); }
  try { startPolling(); } catch (e) { console.error('startPolling error:', e); }
  try { initLogStream(); } catch (e) { console.error('initLogStream error:', e); }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

function initEventListeners() {
  // Sync buttons
  document.getElementById('btn-sync').addEventListener('click', triggerSync);
  document.getElementById('btn-sync-top').addEventListener('click', triggerSync);

  // Knowledge & Archive Export Modals
  const btnOpenKnowledge = document.getElementById('btn-open-knowledge');
  if (btnOpenKnowledge) btnOpenKnowledge.addEventListener('click', () => openKnowledgeModal());
  const btnOpenArchive = document.getElementById('btn-open-archive-export');
  if (btnOpenArchive) btnOpenArchive.addEventListener('click', () => openArchiveExportModal());

  // Search and Sort
  document.getElementById('search-input').addEventListener('input', (e) => {
    currentSearch = e.target.value.toLowerCase();
    renderRecordings();
  });

  document.getElementById('sort-select').addEventListener('change', (e) => {
    currentSort = e.target.value;
    loadRecordings();
  });

  // View toggle
  document.querySelectorAll('.view-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.view-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      currentView = tab.dataset.view;
      renderRecordings();
    });
  });

  // Sidebar Status & Storage filters
  document.querySelectorAll('#sidebar .nav-item[data-filter-type="status"]').forEach((item) => {
    item.addEventListener('click', () => {
      document.querySelectorAll('#sidebar .nav-item').forEach((i) => i.classList.remove('active'));
      item.classList.add('active');

      const fVal = item.dataset.filterVal;
      currentFilter = { project_or_class: 'all', status: fVal };
      loadRecordings();
    });
  });

  // Folder creation & picker
  const btnAddFolder = document.getElementById('btn-add-folder');
  if (btnAddFolder) btnAddFolder.addEventListener('click', openProjectModal);
  const btnCancelProj = document.getElementById('btn-cancel-project');
  if (btnCancelProj) btnCancelProj.addEventListener('click', closeProjectModal);
  const btnSaveProj = document.getElementById('btn-save-project');
  if (btnSaveProj) btnSaveProj.addEventListener('click', saveProject);

  const btnAddRecFolder = document.getElementById('btn-add-recording-folder');
  if (btnAddRecFolder) btnAddRecFolder.addEventListener('click', toggleFolderPickerMenu);

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.folder-picker-wrapper')) {
      const menu = document.getElementById('folder-picker-menu');
      if (menu) menu.style.display = 'none';
    }
  });

  document.getElementById('btn-close-reader').addEventListener('click', closeReaderModal);
  const btnExportMd = document.getElementById('btn-export-md');
  if (btnExportMd) btnExportMd.addEventListener('click', exportMarkdown);
  const btnExportHtml = document.getElementById('btn-export-html');
  if (btnExportHtml) btnExportHtml.addEventListener('click', exportStandaloneHTML);
  document.getElementById('btn-resummarize').addEventListener('click', openSummarizeModal);
  const btnRetranscribe = document.getElementById('btn-retranscribe');
  if (btnRetranscribe) btnRetranscribe.addEventListener('click', triggerRetranscribeCurrent);
  const btnPullCloud = document.getElementById('btn-pull-cloud');
  if (btnPullCloud) btnPullCloud.addEventListener('click', pullCloudDataForCurrent);

  // Modal Title Editing
  const editTitleBtn = document.getElementById('btn-edit-modal-title');
  const modalTitleEl = document.getElementById('modal-title');
  const titleEditBox = document.getElementById('modal-title-edit-box');
  const titleInput = document.getElementById('modal-title-input');
  const saveTitleBtn = document.getElementById('btn-save-modal-title');
  const cancelTitleBtn = document.getElementById('btn-cancel-modal-title');
  const suggestTitleBtn = document.getElementById('btn-suggest-title');

  function openModalTitleEditor() {
    if (!activeRecordingId) return;
    titleInput.value = modalTitleEl.textContent;
    const container = modalTitleEl.closest('.reader-title-container');
    if (container) container.style.display = 'none';
    titleEditBox.style.display = 'flex';
    titleInput.focus();
    titleInput.select();
  }

  function closeModalTitleEditor() {
    titleEditBox.style.display = 'none';
    const container = modalTitleEl.closest('.reader-title-container');
    if (container) container.style.display = 'flex';
  }

  if (editTitleBtn) editTitleBtn.addEventListener('click', openModalTitleEditor);
  if (modalTitleEl) modalTitleEl.addEventListener('click', openModalTitleEditor);

  if (saveTitleBtn) {
    saveTitleBtn.addEventListener('click', async () => {
      const val = titleInput.value.trim();
      if (val && activeRecordingId) {
        await updateRecordingTitle(activeRecordingId, val);
      }
      closeModalTitleEditor();
    });
  }

  if (cancelTitleBtn) {
    cancelTitleBtn.addEventListener('click', closeModalTitleEditor);
  }

  if (titleInput) {
    titleInput.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        const val = titleInput.value.trim();
        if (val && activeRecordingId) {
          await updateRecordingTitle(activeRecordingId, val);
        }
        closeModalTitleEditor();
      } else if (e.key === 'Escape') {
        closeModalTitleEditor();
      }
    });
  }

  if (suggestTitleBtn) {
    suggestTitleBtn.addEventListener('click', async () => {
      const suggested = suggestTitleBtn.dataset.suggested;
      if (suggested && activeRecordingId) {
        await updateRecordingTitle(activeRecordingId, suggested);
      }
    });
  }

  // Reader Tabs
  document.querySelectorAll('.reader-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      selectReaderTab(tab.dataset.tab);
    });
  });

  // Audio Player Controls
  setupAudioPlayer();

  // Settings Modal
  document.getElementById('btn-open-settings').addEventListener('click', openSettingsModal);
  document.getElementById('btn-close-settings').addEventListener('click', closeSettingsModal);
  document.getElementById('btn-cancel-settings').addEventListener('click', closeSettingsModal);
  document.getElementById('btn-save-settings').addEventListener('click', saveSettings);
  document.getElementById('setting-llm-provider').addEventListener('change', toggleSettingsProviderFields);

  // Settings Tabs
  document.querySelectorAll('.settings-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      selectSettingsTab(tab.dataset.tab);
    });
  });
  const fetchRemoteBtn = document.getElementById('btn-fetch-remote-models');
  if (fetchRemoteBtn) {
    fetchRemoteBtn.addEventListener('click', fetchRemoteModels);
  }
  const remoteDropdown = document.getElementById('setting-remote-models-dropdown');
  if (remoteDropdown) {
    remoteDropdown.addEventListener('change', () => {
      if (remoteDropdown.value) {
        document.getElementById('setting-api-model').value = remoteDropdown.value;
      }
    });
  }

  // Gemini model fetching
  const fetchGeminiBtn = document.getElementById('btn-fetch-gemini-models');
  if (fetchGeminiBtn) {
    fetchGeminiBtn.addEventListener('click', () => fetchGeminiModels());
  }
  const geminiKeyInput = document.getElementById('setting-gemini-key');
  let geminiDebounceTimer = null;
  if (geminiKeyInput) {
    geminiKeyInput.addEventListener('input', () => {
      clearTimeout(geminiDebounceTimer);
      const val = geminiKeyInput.value.trim();
      if (val.length >= 20) {
        geminiDebounceTimer = setTimeout(() => fetchGeminiModels(), 600);
      }
    });
    geminiKeyInput.addEventListener('change', () => {
      if (geminiKeyInput.value.trim().length >= 20) {
        fetchGeminiModels();
      }
    });
  }

  // Summarize Modal
  document.getElementById('btn-cancel-summarize').addEventListener('click', closeSummarizeModal);
  document.getElementById('btn-start-summarize').addEventListener('click', startCustomSummarize);

  // Personal Notes save
  document.getElementById('btn-save-notes').addEventListener('click', saveUserNotes);

  // Transcript live search
  document.getElementById('transcript-search-input').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll('.transcript-segment').forEach((el) => {
      const txt = el.querySelector('.segment-text').textContent.toLowerCase();
      el.style.display = txt.includes(q) ? 'flex' : 'none';
    });
  });

  // AI Reasoning toggle
  document.getElementById('btn-toggle-reasoning').addEventListener('click', () => {
    const content = document.getElementById('modal-reasoning-body');
    const arrow = document.getElementById('reasoning-arrow');
    if (content.style.display === 'block') {
      content.style.display = 'none';
      arrow.textContent = '▼';
    } else {
      content.style.display = 'block';
      arrow.textContent = '▲';
    }
  });

  // Logs Drawer & Status Bar
  const btnToggleLogs = document.getElementById('btn-toggle-logs');
  if (btnToggleLogs) btnToggleLogs.addEventListener('click', () => toggleLogsDrawer());

  const btnCloseLogs = document.getElementById('btn-close-logs');
  if (btnCloseLogs) btnCloseLogs.addEventListener('click', () => toggleLogsDrawer(false));

  const btnCopyLogs = document.getElementById('btn-copy-logs');
  if (btnCopyLogs) btnCopyLogs.addEventListener('click', copyLogsToClipboard);

  const btnClearLogs = document.getElementById('btn-clear-logs');
  if (btnClearLogs) btnClearLogs.addEventListener('click', clearLogs);

  const logsFilterSelect = document.getElementById('logs-filter-select');
  if (logsFilterSelect) {
    logsFilterSelect.addEventListener('change', (e) => {
      logFilter = e.target.value;
      renderLogConsole();
    });
  }

  const logsAutoScrollBox = document.getElementById('logs-autoscroll');
  if (logsAutoScrollBox) {
    logsAutoScrollBox.addEventListener('change', (e) => {
      logAutoScroll = e.target.checked;
      if (logAutoScroll) {
        const c = document.getElementById('logs-console');
        if (c) c.scrollTop = c.scrollHeight;
      }
    });
  }

  const statusBarLeft = document.querySelector('.status-bar-left');
  if (statusBarLeft) {
    statusBarLeft.style.cursor = 'pointer';
    statusBarLeft.title = 'Click to view live console logs';
    statusBarLeft.addEventListener('click', () => toggleLogsDrawer());
  }

  // Keyboard shortcut: Escape closes logs drawer
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isLogsDrawerOpen) {
      const hasOpenModal = document.querySelector('.modal-overlay.open');
      if (!hasOpenModal) {
        toggleLogsDrawer(false);
      }
    }
  });

  // Initialize Knowledge Graph and Archive Export features
  initArchiveExport();
  initKnowledgeModal();
}

// ---------------- Data Fetching ---------------- //

async function loadUser() {
  try {
    const res = await fetch('/api/user');
    const data = await res.json();
    if (data.success && data.user) {
      document.getElementById('user-name').textContent = data.user.nickname || data.user.email || 'Plaud User';
      if (data.user.avatar) {
        document.getElementById('user-avatar').innerHTML = `<img src="${data.user.avatar}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`;
      }
    }
  } catch (err) {
    document.getElementById('user-name').textContent = 'Plaud Account';
  }
}

async function loadStats() {
  try {
    const res = await fetch('/api/stats');
    const data = await res.json();
    if (data.success) {
      const s = data.stats;
      libraryFolderCounts = s.folderCounts || {};

      const elHours = document.getElementById('stat-hours');
      const elTotal = document.getElementById('stat-total');
      const elTrans = document.getElementById('stat-transcribed');
      const elSumm = document.getElementById('stat-summarized');
      if (elHours) elHours.textContent = `${s.totalHours}h`;
      if (elTotal) elTotal.textContent = s.total;
      if (elTrans) elTrans.textContent = s.totalTranscribed ?? s.transcribed;
      if (elSumm) elSumm.textContent = s.summarized;

      const elAll = document.getElementById('count-all');
      const elLocal = document.getElementById('count-local');
      const elReady = document.getElementById('count-ready');
      const elTranscribed = document.getElementById('count-transcribed');
      const elAudioReady = document.getElementById('count-audio-ready');
      const elCloud = document.getElementById('count-cloud');

      if (elAll) elAll.textContent = s.total;
      if (elLocal) elLocal.textContent = s.local;
      if (elReady) elReady.textContent = s.ready;
      if (elTranscribed) elTranscribed.textContent = s.transcribed;
      if (elAudioReady) elAudioReady.textContent = s.audioReady;
      if (elCloud) elCloud.textContent = s.cloud;

      renderSidebarProjects();
    }
  } catch (_) {}
}

async function loadProjects() {
  try {
    const res = await fetch('/api/projects');
    const data = await res.json();
    if (data.success) {
      allProjects = data.projects;
      renderSidebarProjects();
    }
  } catch (_) {}
}

function renderSidebarProjects() {
  const foldersList = document.getElementById('folders-list');
  if (!foldersList) return;
  foldersList.innerHTML = '';

  if (allProjects.length === 0) {
    foldersList.innerHTML = `<li style="font-size:0.8rem;color:var(--text-dim);padding:0.25rem 0.75rem;">No folders added yet.</li>`;
    return;
  }

  for (const f of allProjects) {
    const count = libraryFolderCounts[f.name] ?? 0;
    const isActive = currentFilter.project_or_class === f.name;

    const li = document.createElement('li');
    li.className = `nav-item ${isActive ? 'active' : ''}`;
    li.innerHTML = `
      <div class="nav-item-left">
        <span class="tag-dot" style="background:${f.color || '#38bdf8'};"></span>
        <span>${escapeHTML(f.name)}</span>
      </div>
      <div style="display:flex;align-items:center;gap:0.4rem;">
        <span class="nav-pill">${count}</span>
        <button class="btn-icon btn-delete-folder" title="Delete folder ${escapeHTML(f.name)}" style="padding:2px 6px;font-size:0.8rem;cursor:pointer;">✕</button>
      </div>
    `;

    li.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      document.querySelectorAll('#sidebar .nav-item').forEach((i) => i.classList.remove('active'));
      li.classList.add('active');
      currentFilter = { project_or_class: f.name, status: 'all' };
      loadRecordings();
    });

    const delBtn = li.querySelector('.btn-delete-folder');
    if (delBtn) {
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (confirm(`Delete folder "${f.name}"? Any recordings in this folder will simply have their tag removed.`)) {
          await deleteFolder(f.name);
        }
      });
    }

    foldersList.appendChild(li);
  }
}

async function deleteFolder(name) {
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(name)}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      allProjects = data.projects;
      if (currentFilter.project_or_class === name) {
        currentFilter.project_or_class = 'all';
        document.querySelectorAll('#sidebar .nav-item').forEach((i) => i.classList.remove('active'));
        document.querySelector('#sidebar .nav-item[data-filter-val="all"]')?.classList.add('active');
      }
      renderSidebarProjects();
      await loadRecordings();
      await loadStats();
    }
  } catch (err) {
    alert(`Failed to delete folder: ${err.message}`);
  }
}

async function loadRecordings() {
  try {
    const [sortBy, order] = currentSort.split(':');
    const params = new URLSearchParams({
      sortBy: sortBy || 'start_at',
      order: order || 'DESC'
    });

    if (currentFilter.project_or_class !== 'all') params.set('project_or_class', currentFilter.project_or_class);
    if (currentFilter.status !== 'all') params.set('status', currentFilter.status);

    const res = await fetch(`/api/recordings?${params.toString()}`);
    const data = await res.json();
    if (data.success) {
      allRecordings = data.recordings;
      renderRecordings();
    }
  } catch (err) {
    console.error('Failed to load recordings:', err);
  }
}

async function triggerSync() {
  const btn = document.getElementById('btn-sync');
  const btnTop = document.getElementById('btn-sync-top');
  btn.style.animation = 'spin 1s infinite linear';
  btnTop.innerHTML = '<span>⏳</span> Syncing...';

  try {
    const res = await fetch('/api/sync', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      await loadRecordings();
      await loadStats();
    } else {
      if (data.error && (data.error.includes('tokens-mcp.json') || data.error.includes('Plaud login'))) {
        alert('☁️ Plaud Credentials Needed\n\nNo Plaud token file was found at ~/.plaud/tokens-mcp.json.\n\nPlease run this command in your Terminal to authenticate via Plaud MCP:\n\n  npx -y @plaud-ai/mcp install\n\nOnce authorized, click "Sync Plaud" again.');
      } else {
        alert(`Sync failed: ${data.error || 'Unknown error'}`);
      }
    }
  } catch (err) {
    alert(`Sync failed: ${err.message}`);
  } finally {
    btn.style.animation = '';
    btnTop.innerHTML = '<span>🔄</span> Sync Plaud';
  }
}

// ---------------- Render Recordings ---------------- //

function renderRecordings() {
  const container = document.getElementById('recordings-list');
  container.innerHTML = '';

  let list = allRecordings;

  // Filter by search query if set
  if (currentSearch.trim()) {
    list = list.filter((r) => {
      const matchName = (r.name || '').toLowerCase().includes(currentSearch);
      const matchOrigName = (r.original_name || '').toLowerCase().includes(currentSearch);
      const matchTag = parseFolders(r.project_or_class).some((f) => f.toLowerCase().includes(currentSearch));
      const matchTranscript = (r.transcript_text || '').toLowerCase().includes(currentSearch);
      const matchSummary = (r.summary_markdown || '').toLowerCase().includes(currentSearch);
      const matchPlaudSummary = (r.plaud_summary_markdown || '').toLowerCase().includes(currentSearch);
      return matchName || matchOrigName || matchTag || matchTranscript || matchSummary || matchPlaudSummary;
    });
  }

  if (list.length === 0) {
    container.innerHTML = `
      <div style="text-align:center;padding:4rem 2rem;color:var(--text-muted);">
        <div style="font-size:2.5rem;margin-bottom:0.75rem;">🔍</div>
        <h3>No recordings found</h3>
        <p style="margin-top:0.4rem;font-size:0.9rem;">Try adjusting your search terms or filter selection, or sync from Plaud.</p>
      </div>
    `;
    return;
  }

  if (currentView === 'grouped') {
    renderGroupedByProject(container, list);
  } else {
    renderChronologicalTimeline(container, list);
  }
}

function renderChronologicalTimeline(container, list) {
  // Group by Date bucket (e.g. Month & Year or Today/Yesterday)
  const buckets = {};
  for (const r of list) {
    const d = new Date(r.start_at || r.created_at);
    const bucketKey = d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    if (!buckets[bucketKey]) buckets[bucketKey] = [];
    buckets[bucketKey].push(r);
  }

  for (const [bucketTitle, items] of Object.entries(buckets)) {
    const groupDiv = document.createElement('div');
    groupDiv.className = 'recordings-group';

    const header = document.createElement('div');
    header.className = 'group-header';
    header.innerHTML = `
      <div class="group-title">
        <span>📅</span> ${bucketTitle}
      </div>
      <span style="font-size:0.85rem;color:var(--text-muted);">${items.length} recording${items.length === 1 ? '' : 's'}</span>
    `;

    const grid = document.createElement('div');
    grid.className = 'cards-grid';

    for (const rec of items) {
      grid.appendChild(createRecordingCard(rec));
    }

    groupDiv.appendChild(header);
    groupDiv.appendChild(grid);
    container.appendChild(groupDiv);
  }
}

function renderGroupedByProject(container, list) {
  // Group by folders
  const groups = {};
  for (const r of list) {
    const folders = parseFolders(r.project_or_class);
    if (folders.length === 0) {
      if (!groups['Unassigned']) groups['Unassigned'] = [];
      groups['Unassigned'].push(r);
    } else {
      for (const f of folders) {
        if (!groups[f]) groups[f] = [];
        groups[f].push(r);
      }
    }
  }

  for (const [groupName, items] of Object.entries(groups)) {
    const groupDiv = document.createElement('div');
    groupDiv.className = 'recordings-group';

    const p = allProjects.find((proj) => proj.name === groupName);
    const color = p?.color || '#818cf8';

    const header = document.createElement('div');
    header.className = 'group-header';
    header.innerHTML = `
      <div class="group-title" style="display:flex;align-items:center;gap:0.5rem;">
        <span>${groupName === 'Unassigned' ? '📂' : '🏷️'}</span>
        ${p ? `<span class="tag-dot" style="background:${color};width:8px;height:8px;border-radius:50%;display:inline-block;"></span>` : ''}
        <span>${escapeHTML(groupName)}</span>
      </div>
      <span style="font-size:0.85rem;color:var(--text-muted);">${items.length} recording${items.length === 1 ? '' : 's'}</span>
    `;

    const grid = document.createElement('div');
    grid.className = 'cards-grid';

    for (const rec of items) {
      grid.appendChild(createRecordingCard(rec));
    }

    groupDiv.appendChild(header);
    groupDiv.appendChild(grid);
    container.appendChild(groupDiv);
  }
}

function createRecordingCard(rec) {
  const card = document.createElement('div');
  const hasLocalAudio = Boolean(rec.has_local_audio || rec.audio_file);

  card.className = `rec-card ${hasLocalAudio ? 'rec-card-local' : 'rec-card-cloud'}`;
  card.dataset.id = rec.id;

  const d = new Date(rec.start_at || rec.created_at);
  const dateStr = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const timeStr = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const durationMin = (rec.duration / 60000).toFixed(1);

  // Status badge styling
  let statusBadgeClass = 'status-available';
  let statusText = 'Cloud Only';
  if (rec.active_job) {
    statusBadgeClass = 'status-processing';
    const stage = (rec.active_job.stage || '').toLowerCase();
    const stageLabels = {
      downloading: 'Downloading',
      converting: 'Converting',
      transcribing: 'Transcribing',
      diarizing: 'Diarizing',
      summarizing: 'Summarizing',
      syncing: 'Syncing'
    };
    statusText = stageLabels[stage] || 'Processing';
  } else if (rec.status === 'ready') {
    statusBadgeClass = 'status-ready';
    statusText = 'Ready';
  } else if (rec.status === 'transcribed') {
    statusBadgeClass = 'status-transcribed';
    statusText = 'Transcribed';
  } else if (hasLocalAudio || rec.status === 'audio_ready') {
    statusBadgeClass = 'status-audio';
    statusText = 'Audio Ready';
  } else if (rec.status === 'error') {
    statusBadgeClass = 'status-error';
    statusText = 'Error';
  }

  // Storage badge
  const storageBadgeHTML = hasLocalAudio
    ? `<span class="storage-badge storage-local" title="Audio is saved locally on this Mac">💻 Audio on Mac</span>`
    : `<span class="storage-badge storage-cloud" title="Audio is stored in Plaud Cloud - not on local disk yet">☁️ Cloud Audio</span>`;

  const folders = parseFolders(rec.project_or_class);
  const folderBadgesHTML = folders.map((f) => {
    const p = allProjects.find((proj) => proj.name === f);
    const color = p?.color || '#38bdf8';
    return `<span class="tag-badge tag-folder-badge" style="background:${color}22; color:${color}; border:1px solid ${color}55;">📁 ${escapeHTML(f)}</span>`;
  }).join('');

  let speakerCount = 0;
  try {
    const segs = JSON.parse(rec.transcript_json || '[]');
    const spkSet = new Set(segs.map(s => s.speaker).filter(Boolean));
    speakerCount = spkSet.size;
  } catch (_) {}

  // Action Buttons: Play if local, Download if cloud
  const leftAudioBtn = hasLocalAudio
    ? `<button class="btn btn-sm btn-play-audio" title="Play Local Audio">▶ Play</button>`
    : `<button class="btn btn-sm btn-download-card" title="Audio is in Plaud Cloud. Click to download to Mac.">⬇️ Download</button>`;

  const hasNotes = Boolean(rec.status === 'ready' || rec.summary_html || rec.plaud_summary_html);
  const notesBtn = `<button class="btn btn-sm btn-view-notes">${hasNotes ? '📖 Notes' : 'Details'}</button>`;

  let rightActionBtn = '';
  if (rec.active_job) {
    rightActionBtn = `<button class="btn btn-sm btn-primary btn-process-card" disabled title="${escapeHTML(rec.active_job?.message || '')}">⏳ Processing...</button>`;
  } else if (rec.status === 'ready' && hasLocalAudio) {
    rightActionBtn = `<button class="btn btn-sm btn-view-notes btn-ready-tag" style="color:var(--success);border-color:rgba(52,211,153,0.3);background:rgba(52,211,153,0.08);">✓ Ready</button>`;
  } else if (rec.status === 'transcribed') {
    rightActionBtn = `<button class="btn btn-sm btn-primary btn-process-card" title="Generate AI Lesson Notes & Summary">✨ Summarize</button>`;
  } else {
    rightActionBtn = `<button class="btn btn-sm btn-primary btn-process-card" title="Download audio, transcribe with Whisper, and summarize">⚡ Process</button>`;
  }

  const actionsHTML = `
    <div class="card-actions-left">
      ${leftAudioBtn}
      ${notesBtn}
    </div>
    <div class="card-actions-right">
      ${rightActionBtn}
    </div>
  `;

  card.innerHTML = `
    <div class="card-top">
      <div class="card-title-wrap">
        <div class="card-title" title="${escapeHTML(rec.name)}">${escapeHTML(rec.name)}</div>
      </div>
      <span class="status-badge ${statusBadgeClass}">${statusText}</span>
    </div>

    <div class="card-tags">
      ${storageBadgeHTML}
      ${rec.has_plaud_cloud_content || rec.plaud_summary_html || rec.plaud_transcript_json ? `<span class="tag-badge" style="background:rgba(168, 85, 247, 0.15); color: #c084fc; border:1px solid rgba(168,85,247,0.3);" title="Contains transcript or summary from Plaud Cloud">☁️ Plaud Cloud</span>` : ''}
      ${folderBadgesHTML}
      ${speakerCount > 0 ? `<span class="tag-badge" style="background:rgba(56, 189, 248, 0.15); color: #38bdf8; border:1px solid rgba(56,189,248,0.3);">👥 ${speakerCount} speaker${speakerCount > 1 ? 's' : ''}</span>` : ''}
    </div>

    <div class="card-meta">
      <span>📅 ${dateStr} • ${timeStr}</span>
      <span>⏱️ ${durationMin} min</span>
    </div>

    <div class="card-actions">
      ${actionsHTML}
    </div>
  `;

  // Click card to open reader
  card.addEventListener('click', (e) => {
    if (e.target.closest('button') || e.target.closest('input')) return;
    openReader(rec.id);
  });

  // Action button clicks
  const viewNotesBtn = card.querySelector('.btn-view-notes');
  if (viewNotesBtn) viewNotesBtn.addEventListener('click', () => openReader(rec.id));

  const playBtn = card.querySelector('.btn-play-audio');
  if (playBtn) {
    playBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openReader(rec.id);
      playRecordingAudio(rec.id);
    });
  }

  const downloadBtn = card.querySelector('.btn-download-card');
  if (downloadBtn) {
    downloadBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      downloadBtn.disabled = true;
      downloadBtn.textContent = '⏳ Downloading...';
      try {
        const res = await fetch(`/api/recordings/${rec.id}/download`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          await loadRecordings();
          await loadStats();
        } else {
          alert(`Download failed: ${data.error || 'Unknown error'}`);
          downloadBtn.disabled = false;
          downloadBtn.textContent = '⬇️ Download';
        }
      } catch (err) {
        alert(`Download failed: ${err.message}`);
        downloadBtn.disabled = false;
        downloadBtn.textContent = '⬇️ Download';
      }
    });
  }

  const processBtn = card.querySelector('.btn-process-card');
  if (processBtn) {
    processBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      processBtn.disabled = true;
      processBtn.textContent = '⏳ Processing...';
      try {
        await fetch(`/api/recordings/${rec.id}/process`, { method: 'POST' });
        await loadRecordings();
        await loadStats();
      } catch (err) {
        alert(`Failed to start processing: ${err.message}`);
        processBtn.disabled = false;
        processBtn.textContent = '⚡ Process';
      }
    });
  }

  return card;
}

// ---------------- Title Editing Helpers ---------------- //

async function updateRecordingTitle(recordingId, newTitle) {
  if (!newTitle || !newTitle.trim()) return;
  const trimmed = newTitle.trim();
  try {
    const res = await fetch(`/api/recordings/${recordingId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: trimmed, is_custom_name: 1 })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    // Update in-memory allRecordings array
    const found = allRecordings.find((r) => r.id === recordingId);
    if (found) {
      if (!found.original_name) found.original_name = found.name;
      found.name = trimmed;
      found.is_custom_name = 1;
    }

    // Update Reader Modal title if currently open for this recording
    if (activeRecordingId === recordingId) {
      const modalTitle = document.getElementById('modal-title');
      if (modalTitle) modalTitle.textContent = trimmed;
      const origEl = document.getElementById('modal-original-title');
      if (origEl && found?.original_name && found.original_name !== trimmed) {
        origEl.textContent = `Original Plaud Title: ${found.original_name}`;
        origEl.style.display = 'block';
      }
      const suggestBtn = document.getElementById('btn-suggest-title');
      if (suggestBtn) suggestBtn.style.display = 'none';
    }

    renderRecordings();
    loadStats();
  } catch (err) {
    alert(`Failed to update title: ${err.message}`);
  }
}

function extractTitleFromSummary(markdown) {
  if (!markdown) return null;
  const match = markdown.match(/^#\s+(?:🎓|💼|📝)?\s*(?:Lesson Notes:\s*|Meeting Minutes:\s*|Summary:\s*)?([^\n\r]+)/m);
  if (match && match[1]) {
    let t = match[1].trim().replace(/^\[|\]$/g, '').trim();
    t = t.replace(/\*+/g, '').trim();
    if (t.length > 3 && t.length < 120) return t;
  }
  return null;
}

function selectReaderTab(tabName) {
  document.querySelectorAll('.reader-tab').forEach((t) => {
    if (t.dataset.tab === tabName) {
      t.classList.add('active');
    } else {
      t.classList.remove('active');
    }
  });
  const summaryPane = document.getElementById('tab-content-summary');
  if (summaryPane) summaryPane.style.display = tabName === 'summary' ? 'block' : 'none';
  const plaudSummaryPane = document.getElementById('tab-content-plaud-summary');
  if (plaudSummaryPane) plaudSummaryPane.style.display = tabName === 'plaud-summary' ? 'block' : 'none';
  const transcriptPane = document.getElementById('tab-content-transcript');
  if (transcriptPane) transcriptPane.style.display = tabName === 'transcript' ? 'block' : 'none';
  const notesPane = document.getElementById('tab-content-notes');
  if (notesPane) notesPane.style.display = tabName === 'notes' ? 'block' : 'none';
}

// ---------------- Reader Modal ---------------- //

async function openReader(recordingId, preserveTab = false) {
  activeRecordingId = recordingId;
  const overlay = document.getElementById('reader-modal-overlay');
  overlay.classList.add('open');

  let currentActiveTab = null;
  if (preserveTab) {
    const activeTabEl = document.querySelector('.reader-tab.active');
    if (activeTabEl) currentActiveTab = activeTabEl.dataset.tab;
  }

  try {
    const res = await fetch(`/api/recordings/${recordingId}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    const rec = data.recording;

    // Header info
    document.getElementById('modal-title').textContent = rec.name;
    const origTitleEl = document.getElementById('modal-original-title');
    if (origTitleEl) {
      if (rec.original_name && rec.original_name !== rec.name) {
        origTitleEl.textContent = `Original Plaud Title: ${rec.original_name}`;
        origTitleEl.style.display = 'block';
      } else {
        origTitleEl.style.display = 'none';
      }
    }
    const titleEditBox = document.getElementById('modal-title-edit-box');
    if (titleEditBox) titleEditBox.style.display = 'none';
    const titleContainer = document.querySelector('.reader-title-container');
    if (titleContainer) titleContainer.style.display = 'flex';

    // Suggest title from AI summary if available
    const suggestedTitle = extractTitleFromSummary(rec.summary_markdown);
    const suggestBtn = document.getElementById('btn-suggest-title');
    if (suggestBtn) {
      if (suggestedTitle && suggestedTitle.toLowerCase() !== rec.name.toLowerCase()) {
        suggestBtn.dataset.suggested = suggestedTitle;
        const shortSuggested = suggestedTitle.length > 25 ? suggestedTitle.substring(0, 22) + '...' : suggestedTitle;
        suggestBtn.textContent = `✨ Use: "${shortSuggested}"`;
        suggestBtn.style.display = 'inline-block';
      } else {
        suggestBtn.style.display = 'none';
      }
    }

    const d = new Date(rec.start_at || rec.created_at);
    document.getElementById('modal-date').textContent = `📅 ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    document.getElementById('modal-duration').textContent = `⏱️ ${(rec.duration / 60000).toFixed(1)} min`;

    const hasLocalAudio = Boolean(rec.has_local_audio || rec.audio_file);

    const storageBadge = document.getElementById('modal-storage-badge');
    if (storageBadge) {
      storageBadge.className = `storage-badge ${hasLocalAudio ? 'storage-local' : 'storage-cloud'}`;
      storageBadge.innerHTML = hasLocalAudio ? '💻 Audio on Mac' : '☁️ Cloud Audio';
    }

    const cloudBanner = document.getElementById('modal-cloud-banner');
    if (cloudBanner) {
      cloudBanner.style.display = !hasLocalAudio ? 'flex' : 'none';
      const btnModalCloudProcess = document.getElementById('btn-modal-cloud-process');
      if (btnModalCloudProcess) {
        btnModalCloudProcess.onclick = async () => {
          btnModalCloudProcess.disabled = true;
          btnModalCloudProcess.textContent = '⏳ Processing...';
          try {
            await fetch(`/api/recordings/${rec.id}/process`, { method: 'POST' });
            await loadRecordings();
            await loadStats();
            openReader(rec.id, true);
          } catch (err) {
            alert(`Failed: ${err.message}`);
          }
        };
      }
      const btnModalCloudDownload = document.getElementById('btn-modal-cloud-download');
      if (btnModalCloudDownload) {
        btnModalCloudDownload.onclick = async () => {
          btnModalCloudDownload.disabled = true;
          btnModalCloudDownload.textContent = '⏳ Downloading...';
          try {
            const res = await fetch(`/api/recordings/${rec.id}/download`, { method: 'POST' });
            const data = await res.json();
            if (data.success) {
              await loadRecordings();
              await loadStats();
              openReader(rec.id, true);
            } else {
              alert(`Download failed: ${data.error}`);
              btnModalCloudDownload.disabled = false;
              btnModalCloudDownload.textContent = '⬇️ Download Audio';
            }
          } catch (err) {
            alert(`Download failed: ${err.message}`);
            btnModalCloudDownload.disabled = false;
            btnModalCloudDownload.textContent = '⬇️ Download Audio';
          }
        };
      }
    }

    const folders = parseFolders(rec.project_or_class);
    updateReaderFolderBadges(folders);

    const statusBadge = document.getElementById('modal-status-badge');
    if (statusBadge) {
      let stClass = 'status-available';
      let stText = 'Cloud Only';
      if (rec.status === 'ready') {
        stClass = 'status-ready';
        stText = 'Ready';
      } else if (rec.status === 'transcribed') {
        stClass = 'status-transcribed';
        stText = 'Transcribed';
      } else if (hasLocalAudio || rec.status === 'audio_ready') {
        stClass = 'status-audio';
        stText = 'Audio Ready';
      }
      statusBadge.textContent = stText;
      statusBadge.className = `status-badge ${stClass}`;
    }

    const btnRetranscribe = document.getElementById('btn-retranscribe');
    if (btnRetranscribe) {
      const isTranscribing = rec.status === 'transcribing' || (rec.active_job && rec.active_job.stage === 'transcribing');
      btnRetranscribe.disabled = isTranscribing;
      btnRetranscribe.innerHTML = isTranscribing ? '<span>⏳</span> Transcribing...' : '<span>🎙️</span> Re-Transcribe';
    }

    const btnResummarize = document.getElementById('btn-resummarize');
    if (btnResummarize) {
      const isSummarizing = rec.status === 'summarizing' || (rec.active_job && rec.active_job.stage === 'summarizing');
      btnResummarize.disabled = isSummarizing;
      btnResummarize.innerHTML = isSummarizing ? '<span>⏳</span> Summarizing...' : '<span>✨</span> Re-Summarize';
    }

    // Summary Body
    const summaryBody = document.getElementById('modal-summary-body');
    if (rec.summary_html) {
      summaryBody.innerHTML = rec.summary_html;
    } else if (rec.transcript_text) {
      summaryBody.innerHTML = `
        <div style="text-align:center;padding:3rem 1rem;color:var(--text-muted);">
          <h3>Transcript is ready, but no summary has been generated yet.</h3>
          <p style="margin:1rem 0;">Click below to generate structured lesson notes & minutes:</p>
          <button class="btn btn-primary" onclick="openSummarizeModal()">✨ Generate AI Summary</button>
        </div>
      `;
    } else {
      summaryBody.innerHTML = `
        <div style="text-align:center;padding:3rem 1rem;color:var(--text-muted);">
          <h3>This recording has not been processed yet.</h3>
          <p style="margin:1rem 0;">Click "Download & Process" to pull down audio from Plaud, transcribe it, and create lesson notes.</p>
          <button class="btn btn-primary" onclick="triggerProcessCurrent()">⚡ Process Recording</button>
        </div>
      `;
    }

    // Plaud Cloud Summary Body
    const plaudSummaryTabBtn = document.getElementById('tab-btn-plaud-summary');
    const plaudSummaryBody = document.getElementById('modal-plaud-summary-body');
    const hasPlaudSummary = Boolean(rec.plaud_summary_html);
    if (plaudSummaryTabBtn) {
      plaudSummaryTabBtn.style.display = hasPlaudSummary ? 'inline-block' : 'none';
    }
    if (plaudSummaryBody) {
      if (hasPlaudSummary) {
        plaudSummaryBody.innerHTML = rec.plaud_summary_html;
      } else {
        plaudSummaryBody.innerHTML = `
          <div style="text-align:center;padding:3rem 1rem;color:var(--text-muted);">
            <h3>No Plaud Cloud Summary</h3>
            <p style="margin:1rem 0;">No summary was found on the remote Plaud server for this recording.</p>
            <button class="btn btn-sm btn-primary" onclick="pullCloudDataForCurrent()">☁️ Check Plaud Cloud</button>
          </div>
        `;
      }
    }

    // AI Reasoning Box
    const reasoningBox = document.getElementById('modal-reasoning-container');
    const reasoningContent = document.getElementById('modal-reasoning-body');
    if (rec.reasoning_text) {
      reasoningBox.style.display = 'block';
      reasoningContent.textContent = rec.reasoning_text;
    } else {
      reasoningBox.style.display = 'none';
    }

    // Parse speaker mapping
    try {
      currentRecordingSpeakerMap = JSON.parse(rec.speaker_names || '{}');
    } catch (_) {
      currentRecordingSpeakerMap = {};
    }

    // Transcript List
    renderTranscriptList(rec.transcript_json, rec);

    // Personal Notes
    document.getElementById('modal-user-notes').value = rec.user_notes || '';

    // Metadata Table
    const metaTable = document.getElementById('modal-metadata-table');
    metaTable.innerHTML = `
      <div><strong>Recording ID:</strong> ${rec.id}</div>
      ${rec.original_name && rec.original_name !== rec.name ? `<div><strong>Original Plaud Title:</strong> ${escapeHTML(rec.original_name)}</div>` : ''}
      <div><strong>Original Plaud Date:</strong> ${rec.start_at}</div>
      <div><strong>Serial Number:</strong> ${rec.serial_number || 'N/A'}</div>
      <div><strong>Audio File:</strong> ${rec.audio_file ? rec.audio_file : 'Not downloaded yet'}</div>
      <div><strong>Status:</strong> ${rec.status}</div>
    `;

    // Load Audio Source
    loadAudioTrack(rec.id);

    // Select default active tab
    let chosenTab = 'summary';
    if (preserveTab && currentActiveTab) {
      if (currentActiveTab === 'plaud-summary' && hasPlaudSummary) {
        chosenTab = 'plaud-summary';
      } else if (currentActiveTab !== 'plaud-summary') {
        chosenTab = currentActiveTab;
      }
    } else {
      if (rec.summary_html) {
        chosenTab = 'summary';
      } else if (hasPlaudSummary) {
        chosenTab = 'plaud-summary';
      } else if (rec.transcript_text || (rec.transcript_json && rec.transcript_json !== '[]')) {
        chosenTab = 'transcript';
      } else {
        chosenTab = 'summary';
      }
    }
    selectReaderTab(chosenTab);
  } catch (err) {
    alert(`Failed to load recording: ${err.message}`);
  }
}

function updateReaderFolderBadges(folders) {
  const container = document.getElementById('modal-folder-tags');
  if (!container) return;
  container.innerHTML = '';

  folders.forEach((f) => {
    const p = allProjects.find((proj) => proj.name === f);
    const color = p?.color || '#38bdf8';
    const badge = document.createElement('span');
    badge.className = 'tag-badge tag-folder-badge';
    badge.style.background = `${color}22`;
    badge.style.color = color;
    badge.style.border = `1px solid ${color}55`;
    badge.innerHTML = `
      <span>📁 ${escapeHTML(f)}</span>
      <button class="tag-remove-btn" title="Remove folder ${escapeHTML(f)}" data-folder="${escapeHTML(f)}">✕</button>
    `;

    const remBtn = badge.querySelector('.tag-remove-btn');
    if (remBtn) {
      remBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (activeRecordingId) {
          await removeRecordingFromFolder(activeRecordingId, f);
        }
      });
    }

    container.appendChild(badge);
  });
}

function toggleFolderPickerMenu() {
  const menu = document.getElementById('folder-picker-menu');
  if (!menu || !activeRecordingId) return;

  if (menu.style.display === 'block') {
    menu.style.display = 'none';
    return;
  }

  const rec = allRecordings.find((r) => r.id === activeRecordingId);
  const assignedFolders = parseFolders(rec ? rec.project_or_class : '');
  const unassigned = allProjects.filter((p) => !assignedFolders.includes(p.name));

  menu.innerHTML = '';
  if (unassigned.length === 0) {
    menu.innerHTML = `<div class="folder-picker-empty">${allProjects.length === 0 ? 'No folders created yet.' : 'All folders already assigned.'}</div>`;
  } else {
    unassigned.forEach((p) => {
      const item = document.createElement('div');
      item.className = 'folder-picker-item';
      item.innerHTML = `
        <span class="tag-dot" style="background:${p.color || '#38bdf8'};width:8px;height:8px;border-radius:50%;display:inline-block;"></span>
        <span>${escapeHTML(p.name)}</span>
      `;
      item.addEventListener('click', async (e) => {
        e.stopPropagation();
        menu.style.display = 'none';
        await addRecordingToFolder(activeRecordingId, p.name);
      });
      menu.appendChild(item);
    });
  }

  const createItem = document.createElement('div');
  createItem.className = 'folder-picker-create';
  createItem.innerHTML = `<span>+</span> <span>Create New Folder</span>`;
  createItem.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.style.display = 'none';
    openProjectModal();
  });
  menu.appendChild(createItem);

  menu.style.display = 'block';
}

async function addRecordingToFolder(recordingId, folderName) {
  const rec = allRecordings.find((r) => r.id === recordingId);
  const currentFolders = parseFolders(rec ? rec.project_or_class : '');
  if (currentFolders.includes(folderName)) return;

  const newFolders = [...currentFolders, folderName];
  try {
    const res = await fetch(`/api/recordings/${recordingId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_or_class: newFolders })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    if (rec) rec.project_or_class = JSON.stringify(newFolders);
    renderRecordings();
    renderSidebarProjects();
    if (activeRecordingId === recordingId) {
      updateReaderFolderBadges(newFolders);
    }
  } catch (err) {
    alert(`Failed to add folder: ${err.message}`);
  }
}

async function removeRecordingFromFolder(recordingId, folderName) {
  const rec = allRecordings.find((r) => r.id === recordingId);
  const currentFolders = parseFolders(rec ? rec.project_or_class : '');
  const newFolders = currentFolders.filter((f) => f !== folderName);

  try {
    const res = await fetch(`/api/recordings/${recordingId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_or_class: newFolders })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    if (rec) rec.project_or_class = newFolders.length > 0 ? JSON.stringify(newFolders) : '';
    renderRecordings();
    renderSidebarProjects();
    if (activeRecordingId === recordingId) {
      updateReaderFolderBadges(newFolders);
    }
  } catch (err) {
    alert(`Failed to remove folder: ${err.message}`);
  }
}

function closeReaderModal() {
  document.getElementById('reader-modal-overlay').classList.remove('open');
  const titleEditBox = document.getElementById('modal-title-edit-box');
  if (titleEditBox) titleEditBox.style.display = 'none';
  const titleContainer = document.querySelector('.reader-title-container');
  if (titleContainer) titleContainer.style.display = 'flex';
  const pickerMenu = document.getElementById('folder-picker-menu');
  if (pickerMenu) pickerMenu.style.display = 'none';
  audioPlayer.pause();
  activeRecordingId = null;
}

// ---------------- Transcript Interactive Player ---------------- //

const SPEAKER_COLORS = [
  '#38bdf8', // Sky blue
  '#a855f7', // Purple
  '#10b981', // Emerald
  '#f59e0b', // Amber
  '#ec4899', // Pink
  '#06b6d4', // Cyan
  '#84cc16', // Lime
  '#f97316'  // Orange
];

function getSpeakerColor(speakerId) {
  const idx = Math.abs(Number(speakerId) || 0) % SPEAKER_COLORS.length;
  return SPEAKER_COLORS[idx];
}

function renderTranscriptList(transcriptJson, rec) {
  const container = document.getElementById('modal-transcript-list');
  container.innerHTML = '';
  currentTranscriptSegments = [];

  if (!transcriptJson) {
    container.innerHTML = `<p style="color:var(--text-muted);text-align:center;padding:2rem;">No transcript available. Transcribe this recording first.</p>`;
    return;
  }

  let segments = [];
  try {
    segments = typeof transcriptJson === 'string' ? JSON.parse(transcriptJson) : transcriptJson;
  } catch (_) {
    segments = [];
  }

  currentTranscriptSegments = segments;

  if (segments.length === 0) {
    container.innerHTML = `<p style="color:var(--text-muted);text-align:center;padding:2rem;">Transcript is empty.</p>`;
    return;
  }

  segments.forEach((seg, index) => {
    const div = document.createElement('div');
    div.className = 'transcript-segment';
    div.dataset.index = index;

    // Convert timestamps or offsets to seconds
    let startTimeSec = 0;
    if (seg.offsets && typeof seg.offsets.from === 'number') {
      startTimeSec = seg.offsets.from / 1000;
    } else if (seg.timestamps && seg.timestamps.from) {
      startTimeSec = parseTimestampToSeconds(seg.timestamps.from);
    }

    div.dataset.startSec = startTimeSec;

    const timeLabel = seg.timestamps ? seg.timestamps.from.split(',')[0] : formatSeconds(startTimeSec);

    const spkRaw = seg.speaker || '';
    let spkBadgeHTML = '';
    if (spkRaw) {
      const spkName = currentRecordingSpeakerMap[spkRaw] || spkRaw;
      const spkId = typeof seg.speaker_id === 'number' ? seg.speaker_id : (parseInt(spkRaw.replace(/\D/g, '')) - 1 || 0);
      const color = getSpeakerColor(spkId);
      spkBadgeHTML = `
        <button class="speaker-badge-btn" data-raw-speaker="${escapeHTML(spkRaw)}" style="background:${color}18; color:${color}; border:1px solid ${color}40;" title="Click to rename this speaker across the entire recording">
          <span>👤 ${escapeHTML(spkName)}</span>
          <span class="speaker-edit-hint">✎</span>
        </button>
      `;
    }

    div.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:0.35rem;width:100%;">
        <div class="segment-header">
          <span class="segment-time">[${timeLabel}]</span>
          ${spkBadgeHTML}
        </div>
        <div class="segment-text">${escapeHTML(seg.text)}</div>
      </div>
    `;

    // Click to seek audio
    div.addEventListener('click', (e) => {
      if (e.target.closest('.speaker-badge-btn')) return;
      const rec = allRecordings.find((r) => r.id === activeRecordingId);
      const hasLocal = rec ? Boolean(rec.has_local_audio || rec.audio_file) : false;
      if (!hasLocal) {
        if (confirm(`Audio for "${rec ? rec.name : 'this recording'}" is stored in the Plaud Cloud and not yet downloaded to your Mac. Download audio now to listen and seek?`)) {
          downloadAudioForCurrent();
        }
        return;
      }
      audioPlayer.currentTime = startTimeSec;
      audioPlayer.play();
      highlightActiveSegment(startTimeSec);
    });

    const spkBtn = div.querySelector('.speaker-badge-btn');
    if (spkBtn) {
      spkBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const rawSpk = spkBtn.dataset.rawSpeaker;
        const curName = currentRecordingSpeakerMap[rawSpk] || rawSpk;
        const newName = prompt(`Rename "${curName}" across this entire recording to:`, curName);
        if (newName && newName.trim() && newName.trim() !== curName) {
          await renameSpeaker(activeRecordingId, rawSpk, newName.trim());
        }
      });
    }

    container.appendChild(div);
  });
}

async function renameSpeaker(recordingId, rawSpk, newName) {
  try {
    const res = await fetch(`/api/recordings/${recordingId}/speakers`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ speakerNames: { [rawSpk]: newName } })
    });
    const data = await res.json();
    if (data.success) {
      currentRecordingSpeakerMap = data.speakerNames || {};
      document.querySelectorAll(`.speaker-badge-btn[data-raw-speaker="${rawSpk}"] span:first-child`).forEach((el) => {
        el.textContent = `👤 ${newName}`;
      });
      loadRecordings();
    }
  } catch (err) {
    alert(`Failed to rename speaker: ${err.message}`);
  }
}

function parseTimestampToSeconds(ts) {
  // Format: "00:01:23,456"
  const parts = ts.replace(',', '.').split(':');
  if (parts.length === 3) {
    return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
  }
  return 0;
}

function formatSeconds(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
}

// ---------------- Audio Player Setup ---------------- //

function setupAudioPlayer() {
  const playBtn = document.getElementById('btn-audio-play');
  const playIcon = document.getElementById('play-icon');
  const currentTimeEl = document.getElementById('audio-current-time');
  const totalTimeEl = document.getElementById('audio-total-time');
  const progressFill = document.getElementById('audio-progress-fill');
  const progressContainer = document.getElementById('audio-progress-bar-container');

  playBtn.addEventListener('click', () => {
    const rec = allRecordings.find((r) => r.id === activeRecordingId);
    const hasLocal = rec ? Boolean(rec.has_local_audio || rec.audio_file) : false;
    if (!hasLocal) {
      if (activeRecordingId) playRecordingAudio(activeRecordingId);
      return;
    }
    if (audioPlayer.paused) {
      audioPlayer.play();
    } else {
      audioPlayer.pause();
    }
  });

  audioPlayer.addEventListener('play', () => {
    playIcon.textContent = '⏸';
  });

  audioPlayer.addEventListener('pause', () => {
    playIcon.textContent = '▶';
  });

  audioPlayer.addEventListener('timeupdate', () => {
    const cur = audioPlayer.currentTime;
    const dur = audioPlayer.duration || 1;
    currentTimeEl.textContent = formatSeconds(cur);
    progressFill.style.width = `${(cur / dur) * 100}%`;
    highlightActiveSegment(cur);
  });

  audioPlayer.addEventListener('loadedmetadata', () => {
    totalTimeEl.textContent = formatSeconds(audioPlayer.duration || 0);
  });

  // Skip buttons
  document.getElementById('btn-audio-back').addEventListener('click', () => {
    if (!audioPlayer.src) return;
    audioPlayer.currentTime = Math.max(0, audioPlayer.currentTime - 15);
  });

  document.getElementById('btn-audio-forward').addEventListener('click', () => {
    if (!audioPlayer.src) return;
    audioPlayer.currentTime = Math.min(audioPlayer.duration || 0, audioPlayer.currentTime + 15);
  });

  // Progress click seek
  progressContainer.addEventListener('click', (e) => {
    if (!audioPlayer.src || !audioPlayer.duration) {
      if (activeRecordingId) playRecordingAudio(activeRecordingId);
      return;
    }
    const rect = progressContainer.getBoundingClientRect();
    const pos = (e.clientX - rect.left) / rect.width;
    audioPlayer.currentTime = pos * audioPlayer.duration;
  });

  // Rate buttons
  document.querySelectorAll('.rate-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.rate-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      audioPlayer.playbackRate = parseFloat(btn.dataset.rate);
    });
  });
}

function loadAudioTrack(recordingId) {
  const rec = allRecordings.find((r) => r.id === recordingId);
  const playBtn = document.getElementById('btn-audio-play');
  const totalTimeEl = document.getElementById('audio-total-time');
  const hasLocal = rec ? Boolean(rec.has_local_audio || rec.audio_file) : false;

  if (!hasLocal) {
    audioPlayer.src = '';
    if (playBtn) {
      playBtn.disabled = false;
      playBtn.title = 'Audio in Cloud. Click to download to Mac.';
      playBtn.innerHTML = '<span id="play-icon">⬇️</span>';
    }
    if (totalTimeEl) totalTimeEl.textContent = 'Cloud Audio';
  } else {
    audioPlayer.src = `/api/recordings/${recordingId}/audio`;
    if (playBtn) {
      playBtn.disabled = false;
      playBtn.title = 'Play / Pause';
      playBtn.innerHTML = '<span id="play-icon">▶</span>';
    }
  }
}

async function downloadAudioForCurrent() {
  if (!activeRecordingId) return;
  const cloudDownloadBtn = document.getElementById('btn-modal-cloud-download');
  if (cloudDownloadBtn) {
    cloudDownloadBtn.disabled = true;
    cloudDownloadBtn.textContent = '⏳ Downloading...';
  }
  const playBtn = document.getElementById('btn-audio-play');
  if (playBtn) {
    playBtn.disabled = true;
    playBtn.innerHTML = '<span>⏳</span>';
  }
  try {
    const res = await fetch(`/api/recordings/${activeRecordingId}/download`, { method: 'POST' });
    const data = await res.json();
    if (!data.success) {
      throw new Error(data.error || 'Download failed');
    }
    await loadRecordings();
    await loadStats();
    await openReader(activeRecordingId, true);
    playRecordingAudio(activeRecordingId);
  } catch (err) {
    alert(`Failed to download audio: ${err.message}`);
    if (cloudDownloadBtn) {
      cloudDownloadBtn.disabled = false;
      cloudDownloadBtn.textContent = '⬇️ Download Audio';
    }
    if (playBtn) {
      playBtn.disabled = false;
      playBtn.innerHTML = '<span>⬇️</span>';
    }
  }
}

function playRecordingAudio(recordingId) {
  const rec = allRecordings.find((r) => r.id === recordingId);
  const hasLocal = rec ? Boolean(rec.has_local_audio || rec.audio_file) : false;
  if (!hasLocal) {
    if (confirm(`Audio for "${rec ? rec.name : 'this recording'}" is stored in the Plaud Cloud and not yet downloaded to your Mac. Download it now to listen and seek?`)) {
      downloadAudioForCurrent();
    }
    return;
  }
  loadAudioTrack(recordingId);
  audioPlayer.play().catch(() => {});
}

function highlightActiveSegment(currentTimeSec) {
  const segments = document.querySelectorAll('.transcript-segment');
  let activeFound = false;

  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    const segStart = parseFloat(seg.dataset.startSec);
    if (!activeFound && currentTimeSec >= segStart) {
      seg.classList.add('active-playing');
      activeFound = true;
    } else {
      seg.classList.remove('active-playing');
    }
  }
}

// ---------------- Process Pipeline Actions ---------------- //

window.triggerProcessCurrent = async function () {
  if (!activeRecordingId) return;
  try {
    await fetch(`/api/recordings/${activeRecordingId}/process`, { method: 'POST' });
    closeReaderModal();
    loadRecordings();
  } catch (err) {
    alert(`Failed to start processing: ${err.message}`);
  }
};

function exportStandaloneHTML() {
  if (!activeRecordingId) return;
  window.open(`/api/recordings/${activeRecordingId}/export/html?download=1`, '_blank');
}

function exportMarkdown() {
  if (!activeRecordingId) return;
  window.open(`/api/recordings/${activeRecordingId}/export/md`, '_blank');
}

async function pullCloudDataForCurrent() {
  if (!activeRecordingId) return;
  const btn = document.getElementById('btn-pull-cloud');
  const origHtml = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span>⏳</span> Pulling...';
  }
  try {
    const res = await fetch(`/api/recordings/${activeRecordingId}/cloud-sync`, { method: 'POST' });
    const data = await res.json();
    if (!data.success) {
      throw new Error(data.error || 'Failed to pull cloud data');
    }
    await loadRecordings();
    await loadStats();
    await openReader(activeRecordingId, true);
    if (data.synced) {
      const parts = [];
      if (data.synced.transcript) parts.push('transcript');
      if (data.synced.summary) parts.push('summary');
      if (parts.length > 0) {
        alert(`Successfully imported Plaud Cloud ${parts.join(' and ')}!`);
      } else {
        alert('Checked Plaud Cloud: no remote transcript or summary found for this recording.');
      }
    }
  } catch (err) {
    alert(`Failed to pull cloud data: ${err.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origHtml || '<span>☁️</span> Pull Cloud Data';
    }
  }
}

async function triggerRetranscribeCurrent() {
  if (!activeRecordingId) return;
  if (!confirm('Re-run Whisper speech-to-text and speaker diarization on this recording? This will re-transcribe the audio and replace the existing transcript.')) {
    return;
  }
  const btn = document.getElementById('btn-retranscribe');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span>⏳</span> Transcribing...';
  }
  try {
    const res = await fetch(`/api/recordings/${activeRecordingId}/transcribe`, { method: 'POST' });
    const data = await res.json();
    if (!data.success) {
      alert(`Transcription failed: ${data.error}`);
    } else {
      hadActiveJobs = true;
      loadRecordings();
      loadStats();
    }
  } catch (err) {
    alert(`Failed to trigger re-transcription: ${err.message}`);
  }
}

// ---------------- Re-Summarize Dialog ---------------- //

function openSummarizeModal() {
  document.getElementById('summarize-modal-overlay').classList.add('open');
}

function closeSummarizeModal() {
  document.getElementById('summarize-modal-overlay').classList.remove('open');
}

async function startCustomSummarize() {
  if (!activeRecordingId) return;
  const category = document.getElementById('resummarize-category').value;
  const customInstructions = document.getElementById('resummarize-instructions').value;
  const engine = document.getElementById('resummarize-engine')?.value || 'default';

  closeSummarizeModal();

  try {
    await fetch(`/api/recordings/${activeRecordingId}/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category, customInstructions, engine })
    });
    // Refresh modal after starting
    setTimeout(() => openReader(activeRecordingId), 500);
    loadRecordings();
  } catch (err) {
    alert(`Failed to trigger summarization: ${err.message}`);
  }
}

// ---------------- Personal Notes ---------------- //

async function saveUserNotes() {
  if (!activeRecordingId) return;
  const notes = document.getElementById('modal-user-notes').value;
  try {
    await fetch(`/api/recordings/${activeRecordingId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_notes: notes })
    });
    alert('Personal notes saved!');
  } catch (err) {
    alert(`Failed to save notes: ${err.message}`);
  }
}

// ---------------- Folder Modal ---------------- //

function openProjectModal() {
  document.getElementById('project-modal-name').value = '';
  document.getElementById('project-modal-desc').value = '';
  document.getElementById('project-modal-overlay').classList.add('open');
  setTimeout(() => {
    document.getElementById('project-modal-name').focus();
  }, 100);
}

function closeProjectModal() {
  document.getElementById('project-modal-overlay').classList.remove('open');
}

async function saveProject() {
  const name = document.getElementById('project-modal-name').value.trim();
  const color = document.getElementById('project-modal-color').value;
  const description = document.getElementById('project-modal-desc').value.trim();

  if (!name) {
    alert('Please enter a folder name');
    return;
  }

  try {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color, description })
    });
    const data = await res.json();
    if (data.success) {
      allProjects = data.projects;
      renderSidebarProjects();
      await loadRecordings();
      closeProjectModal();
      if (activeRecordingId) {
        const rec = allRecordings.find((r) => r.id === activeRecordingId);
        updateReaderFolderBadges(parseFolders(rec?.project_or_class));
      }
    }
  } catch (err) {
    alert(`Failed to save folder: ${err.message}`);
  }
}

// ---------------- Settings Modal ---------------- //

async function fetchRemoteModels() {
  const url = document.getElementById('setting-api-url').value.trim();
  const apiKey = document.getElementById('setting-api-key').value.trim();
  const statusEl = document.getElementById('remote-models-status');
  const dropdown = document.getElementById('setting-remote-models-dropdown');
  const btn = document.getElementById('btn-fetch-remote-models');

  if (!url) {
    if (statusEl) {
      statusEl.textContent = '⚠️ Please enter an API URL first.';
      statusEl.style.color = '#f59e0b';
    }
    return;
  }

  btn.disabled = true;
  btn.textContent = '⏳ Fetching...';
  if (statusEl) {
    statusEl.textContent = 'Connecting to server...';
    statusEl.style.color = 'var(--text-muted)';
  }

  try {
    const res = await fetch(`/api/remote-models?url=${encodeURIComponent(url)}&apiKey=${encodeURIComponent(apiKey)}`);
    const data = await res.json();
    if (data.success && data.models && data.models.length > 0) {
      dropdown.innerHTML = '<option value="">-- Detected Models on Server --</option>';
      data.models.forEach((m) => {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        dropdown.appendChild(opt);
      });
      dropdown.style.display = 'block';
      if (statusEl) {
        statusEl.textContent = `✅ Connected! Found ${data.models.length} model(s).`;
        statusEl.style.color = '#10b981';
      }
      const currentModel = document.getElementById('setting-api-model').value.trim();
      if (!currentModel || !data.models.includes(currentModel)) {
        document.getElementById('setting-api-model').value = data.models[0];
        dropdown.value = data.models[0];
      } else {
        dropdown.value = currentModel;
      }
    } else {
      if (statusEl) {
        statusEl.textContent = data.error ? `⚠️ Server error: ${data.error}` : '⚠️ No models returned by endpoint.';
        statusEl.style.color = '#f59e0b';
      }
    }
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = `❌ Connection failed: ${err.message}`;
      statusEl.style.color = '#ef4444';
    }
  } finally {
    btn.disabled = false;
    btn.textContent = '⚡ Fetch Models';
  }
}

async function fetchGeminiModels(keyOverride = null) {
  const keyInput = document.getElementById('setting-gemini-key');
  const key = (keyOverride !== null ? keyOverride : (keyInput ? keyInput.value : '')).trim();
  const select = document.getElementById('setting-gemini-model');
  const statusEl = document.getElementById('gemini-models-status');
  const btn = document.getElementById('btn-fetch-gemini-models');

  if (!key) {
    if (statusEl) {
      statusEl.textContent = 'Enter a valid Gemini API key to load models.';
      statusEl.style.color = 'var(--text-muted)';
    }
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Loading...';
  }
  if (statusEl) {
    statusEl.textContent = 'Connecting to Google AI Studio...';
    statusEl.style.color = 'var(--text-muted)';
  }

  try {
    const res = await fetch(`/api/gemini-models?key=${encodeURIComponent(key)}`);
    const data = await res.json();
    if (data.success && Array.isArray(data.models) && data.models.length > 0) {
      const currentSelected = select ? select.value : '';
      if (select) {
        select.innerHTML = '';
        data.models.forEach((m) => {
          const opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = `${m.displayName} (${m.id})`;
          select.appendChild(opt);
        });

        if (currentSelected && data.models.some((m) => m.id === currentSelected)) {
          select.value = currentSelected;
        } else if (data.models.some((m) => m.id === 'gemini-3-flash-preview')) {
          select.value = 'gemini-3-flash-preview';
        }
      }

      if (statusEl) {
        statusEl.textContent = `✅ Connected! Loaded ${data.models.length} available models.`;
        statusEl.style.color = '#10b981';
      }
    } else {
      if (statusEl) {
        statusEl.textContent = data.error ? `⚠️ ${data.error}` : '⚠️ No models returned.';
        statusEl.style.color = '#f59e0b';
      }
    }
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = `❌ ${err.message}`;
      statusEl.style.color = '#ef4444';
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '⚡ Refresh Models';
    }
  }
}

async function openSettingsModal() {
  try {
    // Load models
    const modelsRes = await fetch('/api/models');
    const modelsData = await modelsRes.json();
    const modelSelect = document.getElementById('setting-local-model');
    modelSelect.innerHTML = '';
    if (modelsData.models) {
      modelsData.models.forEach((m) => {
        const opt = document.createElement('option');
        opt.value = m.path;
        opt.textContent = `${m.name} (${m.sizeGB} GB)`;
        modelSelect.appendChild(opt);
      });
    }

    // Load settings
    const res = await fetch('/api/settings');
    const data = await res.json();
    if (data.success) {
      const s = data.settings;
      document.getElementById('setting-llm-provider').value = s.llm_provider || 'custom_api';
      if (s.local_model_path) modelSelect.value = s.local_model_path;
      document.getElementById('setting-api-url').value = s.custom_api_url || '';
      document.getElementById('setting-api-key').value = s.custom_api_key || '';
      document.getElementById('setting-api-model').value = s.custom_api_model || '';
      document.getElementById('setting-gemini-key').value = s.gemini_api_key || '';
      if (document.getElementById('setting-gemini-model')) {
        document.getElementById('setting-gemini-model').value = s.gemini_model || 'gemini-3-flash-preview';
      }
      if (s.gemini_api_key) {
        fetchGeminiModels(s.gemini_api_key);
      }
      const diarCheck = document.getElementById('setting-diarization-enabled');
      if (diarCheck) diarCheck.checked = s.diarization_enabled !== 'false';
      toggleSettingsProviderFields();
    }

    // Load Plaud MCP Credentials & Account status
    await loadPlaudAuthStatus();

    // Load On-Device Models
    await loadModelsManager();

    // Ensure active tab pane is displayed
    const activeTab = document.querySelector('.settings-tab.active');
    selectSettingsTab(activeTab ? activeTab.dataset.tab : 'ai');

    document.getElementById('settings-modal-overlay').classList.add('open');
  } catch (err) {
    alert(`Failed to open settings: ${err.message}`);
  }
}

function selectSettingsTab(tabName) {
  document.querySelectorAll('.settings-tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === tabName);
  });
  document.querySelectorAll('.settings-tab-pane').forEach((p) => {
    p.style.display = p.dataset.tab === tabName ? 'flex' : 'none';
  });
}

function closeSettingsModal() {
  if (modelsManagerPollTimer) {
    clearInterval(modelsManagerPollTimer);
    modelsManagerPollTimer = null;
  }
  document.getElementById('settings-modal-overlay').classList.remove('open');
}

function toggleSettingsProviderFields() {
  const provider = document.getElementById('setting-llm-provider').value;
  document.getElementById('setting-group-local-model').style.display = provider === 'local_llama' ? 'flex' : 'none';
  document.getElementById('setting-group-api').style.display = provider === 'custom_api' ? 'flex' : 'none';
  document.getElementById('setting-group-gemini').style.display = provider === 'gemini' ? 'flex' : 'none';
}

async function saveSettings() {
  const diarCheck = document.getElementById('setting-diarization-enabled');
  const payload = {
    llm_provider: document.getElementById('setting-llm-provider').value,
    local_model_path: document.getElementById('setting-local-model')?.value || '',
    custom_api_url: document.getElementById('setting-api-url').value,
    custom_api_key: document.getElementById('setting-api-key').value,
    custom_api_model: document.getElementById('setting-api-model').value,
    gemini_api_key: document.getElementById('setting-gemini-key').value,
    gemini_model: document.getElementById('setting-gemini-model')?.value || 'gemini-3-flash-preview',
    diarization_enabled: diarCheck && diarCheck.checked ? 'true' : 'false'
  };

  try {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    closeSettingsModal();
    alert('Settings saved successfully!');
  } catch (err) {
    alert(`Failed to save settings: ${err.message}`);
  }
}

// ---------------- Plaud MCP & Account Credentials ---------------- //

async function loadPlaudAuthStatus() {
  const container = document.getElementById('plaud-auth-status-container');
  if (!container) return;
  try {
    const res = await fetch('/api/plaud/status');
    const data = await res.json();
    if (data.connected && data.user) {
      const u = data.user;
      const displayName = u.nickname || u.email || 'Authenticated User';
      const email = u.email ? `<span style="color:var(--text-muted);margin-left:0.4rem;">(${escapeHTML(u.email)})</span>` : '';
      container.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;">
          <div style="display:flex;align-items:center;gap:0.5rem;">
            <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#10b981;"></span>
            <span>Connected as <strong>${escapeHTML(displayName)}</strong>${email}</span>
          </div>
          <span class="badge" style="background:rgba(16,185,129,0.15);color:#10b981;font-size:0.75rem;padding:0.2rem 0.5rem;border-radius:4px;">OAuth Active</span>
        </div>
        <div style="margin-top:0.4rem;font-size:0.78rem;color:var(--text-muted);">
          Credentials managed via <code>~/.plaud/tokens-mcp.json</code>. Tokens refresh automatically when expired.
        </div>
      `;
    } else {
      const errMsg = data.error || 'No active credentials found.';
      container.innerHTML = `
        <div style="display:flex;align-items:center;gap:0.5rem;color:#f59e0b;font-weight:600;">
          <span>⚠️</span> Plaud Account Not Connected
        </div>
        <div style="margin-top:0.35rem;font-size:0.8rem;color:var(--text-muted);">
          ${escapeHTML(errMsg)}
        </div>
        <div style="margin-top:0.6rem;background:rgba(0,0,0,0.3);padding:0.5rem 0.75rem;border-radius:6px;">
          <div style="font-size:0.78rem;color:var(--text-muted);margin-bottom:0.25rem;">Run this one-time command in Terminal to log in via Plaud MCP:</div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:0.5rem;">
            <code style="font-size:0.82rem;color:#38bdf8;user-select:all;">npx -y @plaud-ai/mcp install</code>
            <button type="button" class="btn" style="padding:0.15rem 0.5rem;font-size:0.75rem;" onclick="navigator.clipboard.writeText('npx -y @plaud-ai/mcp install'); alert('Copied setup command to clipboard!');">Copy</button>
          </div>
        </div>
      `;
    }
  } catch (err) {
    container.innerHTML = `<div style="color:var(--danger);font-size:0.8rem;">Error checking status: ${escapeHTML(err.message)}</div>`;
  }
}

// ---------------- On-Device Models Manager ---------------- //

let modelsManagerPollTimer = null;

async function loadModelsManager() {
  const container = document.getElementById('models-manager-list');
  const dirLabel = document.getElementById('models-storage-dir-label');
  if (!container) return;

  try {
    const res = await fetch('/api/ondevice-models');
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    if (dirLabel && data.modelsDir) {
      dirLabel.textContent = data.modelsDir;
      dirLabel.title = `Models stored in: ${data.modelsDir}`;
    }

    container.innerHTML = '';
    let hasDownloading = false;

    data.models.forEach((m) => {
      const card = document.createElement('div');
      card.className = 'model-manager-card';

      let statusBadge = '';
      if (m.isInstalled) {
        statusBadge = `<span class="model-card-status-badge model-card-status-installed">✓ Installed in Library (${m.installedSize})</span>`;
      } else if (m.foundSystemPath) {
        statusBadge = `<span class="model-card-status-badge model-card-status-system">📁 Found in Meetily</span>`;
      } else {
        statusBadge = `<span class="model-card-status-badge model-card-status-missing">⬇️ Not Installed</span>`;
      }

      let actionsHTML = '';
      if (m.downloading) {
        hasDownloading = true;
        const prog = m.downloadProgress || { percent: 0, downloaded: 0, total: 0 };
        actionsHTML = `
          <div style="width:100%;">
            <div style="display:flex;justify-content:space-between;align-items:center;font-size:0.75rem;color:var(--text-muted);margin-bottom:0.25rem;">
              <span>⏳ Downloading...</span>
              <span>${prog.percent}% (${formatBytes(prog.downloaded)} / ${formatBytes(prog.total)})</span>
            </div>
            <div class="model-download-bar-wrap">
              <div class="model-download-bar-fill" style="width:${prog.percent}%;"></div>
            </div>
          </div>
        `;
      } else if (m.isInstalled) {
        actionsHTML = `
          <div class="model-card-path" title="${escapeHTML(m.destination)}">📂 ${escapeHTML(m.destination)}</div>
          <div style="display:flex;gap:0.4rem;align-items:center;">
            <span style="font-size:0.78rem;color:var(--success);font-weight:500;">✓ Active</span>
            <button type="button" class="btn btn-sm" onclick="downloadOnDeviceModel('${m.id}')" title="Re-download model file directly from Hugging Face">🔄 Re-download</button>
          </div>
        `;
      } else if (m.foundSystemPath) {
        actionsHTML = `
          <div class="model-card-path" title="Detected on system: ${escapeHTML(m.foundSystemPath)}">💡 Found: ${escapeHTML(m.foundSystemPath)}</div>
          <div style="display:flex;gap:0.4rem;align-items:center;">
            <button type="button" class="btn btn-sm btn-primary" onclick="copyOnDeviceModel('${m.id}')" title="Copy from Meetily into Plaud Studio Library directory without internet download">📁 Copy to Library (Instant)</button>
            <button type="button" class="btn btn-sm" onclick="downloadOnDeviceModel('${m.id}')" title="Download fresh from Hugging Face">⬇️ Download (${m.sizeStr})</button>
          </div>
        `;
      } else {
        actionsHTML = `
          <div class="model-card-path" title="Target: ${escapeHTML(m.destination)}">Target: ${escapeHTML(m.destination)}</div>
          <button type="button" class="btn btn-sm btn-primary" onclick="downloadOnDeviceModel('${m.id}')">⬇️ Download (${m.sizeStr})</button>
        `;
      }

      card.innerHTML = `
        <div class="model-card-header">
          <div>
            <div class="model-card-title">
              <span>${m.category.includes('Transcription') ? '🎙️' : '👥'}</span>
              ${escapeHTML(m.name)}
              <span style="font-size:0.75rem;font-weight:normal;color:var(--text-muted);">(${m.sizeStr})</span>
            </div>
            <div class="model-card-subtitle">${escapeHTML(m.description)}</div>
          </div>
          ${statusBadge}
        </div>
        <div class="model-card-actions">
          ${actionsHTML}
        </div>
      `;

      container.appendChild(card);
    });

    if (hasDownloading) {
      if (!modelsManagerPollTimer) {
        modelsManagerPollTimer = setInterval(loadModelsManager, 1000);
      }
    } else if (modelsManagerPollTimer) {
      clearInterval(modelsManagerPollTimer);
      modelsManagerPollTimer = null;
    }
  } catch (err) {
    container.innerHTML = `<div style="color:var(--danger);font-size:0.8rem;padding:0.5rem;">Failed to load models: ${escapeHTML(err.message)}</div>`;
  }
}

window.downloadOnDeviceModel = async function (modelId) {
  try {
    const res = await fetch('/api/ondevice-models/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    await loadModelsManager();
    if (!modelsManagerPollTimer) {
      modelsManagerPollTimer = setInterval(loadModelsManager, 1000);
    }
  } catch (err) {
    alert(`Download failed: ${err.message}`);
  }
};

window.copyOnDeviceModel = async function (modelId) {
  try {
    const res = await fetch('/api/ondevice-models/copy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    await loadModelsManager();
  } catch (err) {
    alert(`Copy failed: ${err.message}`);
  }
};

// ---------------- Live Logs & Status Bar ---------------- //

function initLogStream() {
  if (logEventSource) {
    try { logEventSource.close(); } catch (_) {}
    logEventSource = null;
  }

  const streamDot = document.getElementById('logs-stream-dot');

  try {
    logEventSource = new EventSource('/api/logs/stream');
  } catch (err) {
    console.warn('Failed to start EventSource stream:', err);
    return;
  }

  logEventSource.onopen = () => {
    if (streamDot) streamDot.classList.remove('disconnected');
  };

  logEventSource.onerror = () => {
    if (streamDot) streamDot.classList.add('disconnected');
  };

  logEventSource.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.type === 'init') {
        if (payload.status) updateStatusBar(payload.status);
        if (Array.isArray(payload.logs)) {
          logEntries = payload.logs;
          renderLogConsole();
        }
      } else if (payload.type === 'status') {
        const wasBusy = currentGlobalStatus.state === 'busy';
        updateStatusBar(payload.data);
        if (wasBusy && payload.data?.state === 'idle') {
          loadRecordings();
          loadStats();
          if (activeRecordingId) {
            const rec = allRecordings.find((r) => r.id === activeRecordingId);
            if (rec) openReader(activeRecordingId);
          }
        }
      } else if (payload.type === 'log') {
        appendLogEntry(payload.data);
      } else if (payload.type === 'clear') {
        logEntries = [];
        renderLogConsole();
      }
    } catch (e) {
      console.error('Error processing log SSE event:', e);
    }
  };
}

function updateStatusBar(status) {
  if (!status) return;
  currentGlobalStatus = { ...currentGlobalStatus, ...status };

  const dot = document.getElementById('status-indicator-dot');
  const badge = document.getElementById('status-stage-badge');
  const text = document.getElementById('status-message-text');

  const isBusy = currentGlobalStatus.state === 'busy';
  const stage = (currentGlobalStatus.stage || '').toLowerCase();

  // Status Indicator Dot
  if (dot) {
    dot.className = 'status-indicator-dot';
    if (stage === 'error') {
      dot.classList.add('error');
    } else if (isBusy) {
      dot.classList.add('pulsing');
    }
  }

  // Stage Badge
  if (badge) {
    badge.className = `status-stage-badge stage-${stage || (isBusy ? 'converting' : 'ready')}`;
    const label = currentGlobalStatus.stageLabel || (isBusy ? stage.toUpperCase() : 'READY');
    const cleanLabel = label.replace(/[^\w\s-]/g, '').trim() || (isBusy ? 'ACTIVE' : 'READY');
    badge.textContent = cleanLabel;
  }

  // Message Text
  if (text) {
    let msg = currentGlobalStatus.message || (isBusy ? 'Processing...' : 'Plaud Studio is ready');
    if (currentGlobalStatus.recordingName && !msg.includes(currentGlobalStatus.recordingName)) {
      msg = `${currentGlobalStatus.recordingName}: ${msg}`;
    }
    text.textContent = msg;
    text.title = msg;
  }
}

function shouldShowEntry(entry, filter) {
  if (filter === 'all') return true;
  if (filter === 'warn-error') return entry.level === 'warn' || entry.level === 'error';
  if (filter === 'stage') return entry.level === 'stage';
  if (filter === 'whisper') return entry.level === 'whisper';
  if (filter === 'llm') return entry.level === 'llm';
  if (filter === 'ffmpeg') return entry.level === 'ffmpeg';
  return true;
}

function createLogEntryElement(entry) {
  const row = document.createElement('div');
  row.className = 'log-entry';
  row.dataset.level = entry.level || 'info';

  const timeEl = document.createElement('span');
  timeEl.className = 'log-entry-time';
  timeEl.textContent = entry.timeStr || (entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : '');

  const tagEl = document.createElement('span');
  tagEl.className = `log-tag log-tag-${entry.level || 'info'}`;
  tagEl.textContent = (entry.level || 'INFO').toUpperCase();

  const msgEl = document.createElement('span');
  msgEl.className = `log-entry-msg ${entry.level ? entry.level + '-msg' : ''}`;
  msgEl.textContent = entry.message || '';

  row.appendChild(timeEl);
  row.appendChild(tagEl);
  row.appendChild(msgEl);
  return row;
}

function renderLogConsole() {
  const consoleEl = document.getElementById('logs-console');
  const countBadge = document.getElementById('logs-count-badge');
  if (!consoleEl) return;

  consoleEl.innerHTML = '';
  const filtered = logEntries.filter((e) => shouldShowEntry(e, logFilter));

  filtered.forEach((entry) => {
    consoleEl.appendChild(createLogEntryElement(entry));
  });

  if (countBadge) {
    countBadge.textContent = `${logEntries.length} line${logEntries.length === 1 ? '' : 's'}`;
  }

  if (logAutoScroll) {
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }
}

function appendLogEntry(entry) {
  logEntries.push(entry);
  if (logEntries.length > 600) {
    logEntries.shift();
  }

  const countBadge = document.getElementById('logs-count-badge');
  if (countBadge) {
    countBadge.textContent = `${logEntries.length} line${logEntries.length === 1 ? '' : 's'}`;
  }

  if (shouldShowEntry(entry, logFilter)) {
    const consoleEl = document.getElementById('logs-console');
    if (consoleEl) {
      consoleEl.appendChild(createLogEntryElement(entry));
      if (logAutoScroll) {
        consoleEl.scrollTop = consoleEl.scrollHeight;
      }
    }
  }

  // Update badge if drawer is closed
  if (!isLogsDrawerOpen) {
    const btnBadge = document.getElementById('status-logs-badge');
    if (btnBadge && (entry.level === 'stage' || entry.level === 'error')) {
      btnBadge.style.display = 'inline-block';
      btnBadge.textContent = '!';
    }
  }
}

function toggleLogsDrawer(force) {
  const drawer = document.getElementById('logs-drawer');
  const btn = document.getElementById('btn-toggle-logs');
  const btnBadge = document.getElementById('status-logs-badge');
  if (!drawer) return;

  const willOpen = typeof force === 'boolean' ? force : (drawer.style.display === 'none' || !isLogsDrawerOpen);
  if (willOpen) {
    drawer.style.display = 'flex';
    if (btn) btn.classList.add('active');
    if (btnBadge) btnBadge.style.display = 'none';
    isLogsDrawerOpen = true;
    renderLogConsole();
  } else {
    drawer.style.display = 'none';
    if (btn) btn.classList.remove('active');
    isLogsDrawerOpen = false;
  }
}

async function copyLogsToClipboard() {
  const btn = document.getElementById('btn-copy-logs');
  const lines = logEntries
    .filter((e) => shouldShowEntry(e, logFilter))
    .map((e) => `[${e.timeStr || e.timestamp}] [${(e.level || 'INFO').toUpperCase()}] ${e.message}`)
    .join('\n');
  try {
    await navigator.clipboard.writeText(lines);
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = '✓ Copied!';
      setTimeout(() => { btn.textContent = orig; }, 1500);
    }
  } catch (err) {
    alert('Failed to copy logs to clipboard: ' + err.message);
  }
}

async function clearLogs() {
  try {
    await fetch('/api/logs/clear', { method: 'POST' });
    logEntries = [];
    renderLogConsole();
  } catch (err) {
    console.error('Failed to clear logs:', err);
  }
}

// ---------------- Background Polling ---------------- //

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    // Check if any recording is in active job state
    const hasActive = allRecordings.some((r) => r.active_job || ['downloading', 'transcribing', 'summarizing'].includes(r.status));
    if (hasActive || hadActiveJobs) {
      hadActiveJobs = hasActive;
      await loadRecordings();
      await loadStats();
      if (activeRecordingId) {
        // Refresh reader modal if it's currently open
        const overlay = document.getElementById('reader-modal-overlay');
        if (overlay && overlay.classList.contains('open')) {
          const rec = allRecordings.find((r) => r.id === activeRecordingId);
          if (rec && ['ready', 'transcribed'].includes(rec.status) && !rec.active_job) {
            openReader(activeRecordingId);
          }
        }
      }
    }
  }, 3000);
}

// ---------------- Archive Export ---------------- //

function openArchiveExportModal(selectedFolder = '') {
  const overlay = document.getElementById('archive-export-modal-overlay');
  if (!overlay) return;

  const currentVal = selectedFolder || (currentFilter && currentFilter.project_or_class !== 'all' ? currentFilter.project_or_class : '');
  const folderSelect = document.getElementById('archive-export-folder');
  if (folderSelect) {
    let opts = '<option value="">🌐 All Folders &amp; Recordings</option>';
    allProjects.forEach((p) => {
      opts += `<option value="${escapeHTML(p.name)}" ${p.name === currentVal ? 'selected' : ''}>📁 ${escapeHTML(p.name)}</option>`;
    });
    folderSelect.innerHTML = opts;
  }

  updateArchiveCount();
  overlay.classList.add('open');
}

function closeArchiveExportModal() {
  const overlay = document.getElementById('archive-export-modal-overlay');
  if (overlay) overlay.classList.remove('open');
}

function updateArchiveCount() {
  const folderSelect = document.getElementById('archive-export-folder');
  const targetFolder = folderSelect ? folderSelect.value : '';
  const countText = document.getElementById('archive-count-text');
  if (!countText) return;

  const eligibleRecs = allRecordings.filter((r) => {
    const hasSummary = Boolean(r.summary_markdown || r.plaud_summary_markdown || r.summary_html || r.plaud_summary_html);
    if (!hasSummary) return false;
    if (!targetFolder) return true;
    const folders = parseFolders(r.project_or_class);
    return folders.includes(targetFolder);
  });

  const scopeLabel = targetFolder ? `in folder "${escapeHTML(targetFolder)}"` : 'across all folders';
  countText.textContent = `${eligibleRecs.length} recording summary ${eligibleRecs.length === 1 ? 'file' : 'files'} ${scopeLabel} will be packaged.`;
}

function downloadArchive() {
  const folderSelect = document.getElementById('archive-export-folder');
  const targetFolder = folderSelect ? folderSelect.value : '';
  const formatRadio = document.querySelector('input[name="export-format"]:checked');
  const format = formatRadio ? formatRadio.value : 'md';

  const btn = document.getElementById('btn-download-archive');
  if (btn) {
    const origHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span>⏳</span> Preparing ZIP...';
    setTimeout(() => {
      btn.disabled = false;
      btn.innerHTML = origHtml;
      closeArchiveExportModal();
    }, 2500);
  }

  let url = `/api/export/archive?format=${encodeURIComponent(format)}`;
  if (targetFolder) {
    url += `&folder=${encodeURIComponent(targetFolder)}`;
  }
  window.location.href = url;
}

function initArchiveExport() {
  const btnClose = document.getElementById('btn-close-archive-export');
  if (btnClose) btnClose.addEventListener('click', closeArchiveExportModal);

  const btnCancel = document.getElementById('btn-cancel-archive-export');
  if (btnCancel) btnCancel.addEventListener('click', closeArchiveExportModal);

  const folderSelect = document.getElementById('archive-export-folder');
  if (folderSelect) folderSelect.addEventListener('change', updateArchiveCount);

  const btnDownload = document.getElementById('btn-download-archive');
  if (btnDownload) btnDownload.addEventListener('click', downloadArchive);

  // Format card selection styling
  document.querySelectorAll('.format-card').forEach((card) => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.format-card').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
      const radio = card.querySelector('input[type="radio"]');
      if (radio) radio.checked = true;
    });
  });
}

// ---------------- Knowledge Graph & Multi-Summary Q&A ---------------- //

let knowledgeGraphData = null;
let currentKnowledgeAnswer = '';
let activeKnowledgeFolder = '';

function openKnowledgeModal(initialFolder = '') {
  const overlay = document.getElementById('knowledge-modal-overlay');
  if (!overlay) return;

  activeKnowledgeFolder = initialFolder || (currentFilter && currentFilter.project_or_class !== 'all' ? currentFilter.project_or_class : '');
  const folderSelect = document.getElementById('knowledge-folder-select');
  if (folderSelect) {
    let opts = '<option value="">🌐 All Summaries &amp; Folders</option>';
    allProjects.forEach((p) => {
      opts += `<option value="${escapeHTML(p.name)}" ${p.name === activeKnowledgeFolder ? 'selected' : ''}>📁 ${escapeHTML(p.name)}</option>`;
    });
    folderSelect.innerHTML = opts;
  }

  overlay.classList.add('open');
  loadKnowledgeGraphData();
}

function closeKnowledgeModal() {
  const overlay = document.getElementById('knowledge-modal-overlay');
  if (overlay) overlay.classList.remove('open');
}

async function loadKnowledgeGraphData() {
  const statPill = document.getElementById('knowledge-stat-pill');
  if (statPill) statPill.textContent = 'Loading graph...';

  try {
    let url = '/api/knowledge/graph';
    if (activeKnowledgeFolder) {
      url += `?folder=${encodeURIComponent(activeKnowledgeFolder)}`;
    }
    const res = await fetch(url);
    const data = await res.json();
    if (data.success) {
      knowledgeGraphData = data;
      const { stats } = data;
      if (statPill) {
        statPill.textContent = `${stats.totalRecordings} summaries • ${stats.totalConcepts} concepts • ${stats.totalEdges} links`;
      }
      renderGraphCards();
    }
  } catch (err) {
    console.error('Failed to load knowledge graph:', err);
    if (statPill) statPill.textContent = 'Graph unavailable';
  }
}

function switchKnowledgeTab(tabName) {
  document.querySelectorAll('.knowledge-tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  document.querySelectorAll('.knowledge-tab-pane').forEach((pane) => {
    pane.style.display = 'none';
  });
  const activePane = document.getElementById(`pane-knowledge-${tabName}`);
  if (activePane) {
    activePane.style.display = 'flex';
  }
}

async function askKnowledgeGraph(customQuery = '') {
  const queryInput = document.getElementById('qa-query-input');
  const query = (customQuery || (queryInput ? queryInput.value : '')).trim();
  if (!query) {
    if (queryInput) queryInput.focus();
    return;
  }

  if (queryInput && customQuery) {
    queryInput.value = customQuery;
  }

  // Ensure Ask tab is visible
  switchKnowledgeTab('ask');

  const emptyState = document.getElementById('qa-empty-state');
  const loadingState = document.getElementById('qa-loading-state');
  const resultsContainer = document.getElementById('qa-results-container');
  const askBtn = document.getElementById('btn-ask-knowledge');

  if (emptyState) emptyState.style.display = 'none';
  if (resultsContainer) resultsContainer.style.display = 'none';
  if (loadingState) loadingState.style.display = 'flex';
  if (askBtn) askBtn.disabled = true;

  try {
    const res = await fetch('/api/knowledge/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        folder: activeKnowledgeFolder
      })
    });

    const data = await res.json();
    if (!data.success) {
      throw new Error(data.error || 'Failed to query knowledge graph');
    }

    currentKnowledgeAnswer = data.answer || '';

    // Render Answer Markdown HTML
    const answerMarkdownEl = document.getElementById('qa-answer-markdown');
    if (answerMarkdownEl) {
      answerMarkdownEl.innerHTML = data.answerHtml || `<p>${escapeHTML(data.answer)}</p>`;
    }

    // Scope Badge
    const scopeBadge = document.getElementById('qa-result-scope');
    if (scopeBadge) {
      scopeBadge.textContent = data.stats?.scope || 'All Folders';
    }

    // Render Citations / Sources
    const sourcesCount = document.getElementById('qa-sources-count');
    const sourcesList = document.getElementById('qa-sources-list');
    const cited = data.citedRecordings || [];

    if (sourcesCount) sourcesCount.textContent = cited.length;
    if (sourcesList) {
      if (cited.length === 0) {
        sourcesList.innerHTML = '<div style="color:var(--text-dim);font-size:0.85rem;">No direct lecture citations.</div>';
      } else {
        sourcesList.innerHTML = cited.map((r) => {
          const d = r.date ? new Date(r.date) : null;
          const dateStr = d ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
          return `
            <div class="qa-source-card" data-rec-id="${escapeHTML(r.id)}" title="Click to open lesson notes">
              <div class="qa-source-header">
                <span class="qa-source-name">${escapeHTML(r.name)}</span>
                <span class="qa-source-folder">📁 ${escapeHTML(r.folder)}</span>
              </div>
              <div style="display:flex;justify-content:space-between;align-items:center;margin-top:0.25rem;">
                <span class="qa-source-date">${dateStr}</span>
                <span style="font-size:0.75rem;color:var(--primary);">Open Notes →</span>
              </div>
            </div>
          `;
        }).join('');

        sourcesList.querySelectorAll('.qa-source-card').forEach((card) => {
          card.addEventListener('click', () => {
            const recId = card.dataset.recId;
            if (recId) {
              closeKnowledgeModal();
              openReader(recId);
            }
          });
        });
      }
    }

    // Render Related Concepts
    const conceptsSection = document.getElementById('qa-concepts-section');
    const conceptsList = document.getElementById('qa-concepts-list');
    const matched = data.matchedConcepts || [];

    if (matched.length > 0 && conceptsSection && conceptsList) {
      conceptsSection.style.display = 'flex';
      conceptsList.innerHTML = matched.map((c) => {
        return `<span class="concept-badge" data-concept="${escapeHTML(c.label || c.name)}"># ${escapeHTML(c.label || c.name)}</span>`;
      }).join('');

      conceptsList.querySelectorAll('.concept-badge').forEach((badge) => {
        badge.addEventListener('click', () => {
          const conceptName = badge.dataset.concept;
          if (conceptName) {
            askKnowledgeGraph(`Explain the concept "${conceptName}" and how it connects to other topics across lectures.`);
          }
        });
      });
    } else if (conceptsSection) {
      conceptsSection.style.display = 'none';
    }

    if (resultsContainer) resultsContainer.style.display = 'flex';
  } catch (err) {
    alert(`Failed to query knowledge graph: ${err.message}`);
    if (emptyState) emptyState.style.display = 'block';
  } finally {
    if (loadingState) loadingState.style.display = 'none';
    if (askBtn) askBtn.disabled = false;
  }
}

function renderGraphCards(filterQuery = '') {
  const grid = document.getElementById('graph-cards-grid');
  const summaryEl = document.getElementById('graph-stats-summary');
  if (!grid || !knowledgeGraphData) return;

  const q = (filterQuery || '').toLowerCase().trim();
  const nodes = knowledgeGraphData.nodes || [];

  // Filter for concepts, topics, decisions, actions
  let filtered = nodes.filter((n) => ['concept', 'topic', 'decision', 'action'].includes(n.type));
  if (q) {
    filtered = filtered.filter((n) => {
      const label = (n.label || '').toLowerCase();
      const def = (n.definition || '').toLowerCase();
      const ctx = (n.context || '').toLowerCase();
      return label.includes(q) || def.includes(q) || ctx.includes(q);
    });
  }

  if (summaryEl) {
    summaryEl.textContent = `Showing ${filtered.length} extracted concepts & entities`;
  }

  if (filtered.length === 0) {
    grid.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 2.5rem; color: var(--text-muted);">
        <p>No concepts found matching "${escapeHTML(q)}".</p>
      </div>
    `;
    return;
  }

  const typeBadges = {
    concept: 'badge-concept',
    topic: 'badge-topic',
    decision: 'badge-decision',
    action: 'badge-action'
  };

  grid.innerHTML = filtered.map((n) => {
    const badgeClass = typeBadges[n.type] || 'badge-concept';
    const recTitles = Array.isArray(n.recordingTitles) ? n.recordingTitles : [];
    const recIds = Array.isArray(n.recordingIds) ? n.recordingIds : [];

    const linksHtml = recIds.map((id, idx) => {
      const title = recTitles[idx] || 'Recording';
      return `<button class="graph-card-link-btn" data-rec-id="${escapeHTML(id)}" title="${escapeHTML(title)}">📖 ${escapeHTML(title)}</button>`;
    }).slice(0, 3).join('');

    return `
      <div class="graph-card">
        <div class="graph-card-header">
          <div class="graph-card-title">${escapeHTML(n.label)}</div>
          <span class="graph-card-badge ${badgeClass}">${escapeHTML(n.type)}</span>
        </div>
        ${n.definition ? `<div class="graph-card-def">${escapeHTML(n.definition)}</div>` : ''}
        ${n.context && n.context !== n.definition ? `<div class="graph-card-context">${escapeHTML(n.context)}</div>` : ''}
        <div class="graph-card-links">
          ${linksHtml}
          <button class="graph-card-ask-btn" data-label="${escapeHTML(n.label)}" title="Ask AI about this entity">Ask Studio ✨</button>
        </div>
      </div>
    `;
  }).join('');

  grid.querySelectorAll('.graph-card-link-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.recId;
      if (id) {
        closeKnowledgeModal();
        openReader(id);
      }
    });
  });

  grid.querySelectorAll('.graph-card-ask-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const label = btn.dataset.label;
      if (label) {
        askKnowledgeGraph(`Explain the significance of "${label}" and how it connects to other topics across lectures.`);
      }
    });
  });
}

function initKnowledgeModal() {
  const btnClose = document.getElementById('btn-close-knowledge');
  if (btnClose) btnClose.addEventListener('click', closeKnowledgeModal);

  const folderSelect = document.getElementById('knowledge-folder-select');
  if (folderSelect) {
    folderSelect.addEventListener('change', (e) => {
      activeKnowledgeFolder = e.target.value;
      loadKnowledgeGraphData();
    });
  }

  // Tabs
  document.querySelectorAll('.knowledge-tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      switchKnowledgeTab(btn.dataset.tab);
    });
  });

  // Prompt chips
  document.querySelectorAll('.prompt-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const prompt = chip.dataset.prompt;
      if (prompt) {
        askKnowledgeGraph(prompt);
      }
    });
  });

  // Ask Button & Enter key
  const btnAsk = document.getElementById('btn-ask-knowledge');
  if (btnAsk) {
    btnAsk.addEventListener('click', () => askKnowledgeGraph());
  }

  const queryInput = document.getElementById('qa-query-input');
  if (queryInput) {
    queryInput.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        askKnowledgeGraph();
      }
    });
  }

  // Copy Answer
  const btnCopy = document.getElementById('btn-copy-answer');
  if (btnCopy) {
    btnCopy.addEventListener('click', async () => {
      if (!currentKnowledgeAnswer) return;
      try {
        await navigator.clipboard.writeText(currentKnowledgeAnswer);
        const orig = btnCopy.textContent;
        btnCopy.textContent = '✓ Copied!';
        setTimeout(() => { btnCopy.textContent = orig; }, 1500);
      } catch (err) {
        alert('Failed to copy: ' + err.message);
      }
    });
  }

  // Graph Search
  const graphSearch = document.getElementById('graph-search-input');
  const graphClear = document.getElementById('btn-clear-graph-search');
  if (graphSearch) {
    graphSearch.addEventListener('input', (e) => {
      const val = e.target.value;
      if (graphClear) graphClear.style.display = val ? 'block' : 'none';
      renderGraphCards(val);
    });
  }

  if (graphClear && graphSearch) {
    graphClear.addEventListener('click', () => {
      graphSearch.value = '';
      graphClear.style.display = 'none';
      renderGraphCards('');
    });
  }
}

// ---------------- Utility ---------------- //

function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
