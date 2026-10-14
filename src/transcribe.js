import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { getRecording, updateRecording, getSetting } from './db.js';
import { downloadRecordingAudio } from './plaud.js';
import { AUDIO_DIR, TMP_DIR, MODELS_DIR } from './config.js';
import { logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      ...options,
      env: {
        ...process.env,
        PATH: `/opt/homebrew/bin:${path.join(os.homedir(), '.local', 'bin')}:${process.env.PATH || ''}`
      }
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        if (command.includes('whisper')) logger.whisper(line);
        else if (command.includes('ffmpeg')) logger.ffmpeg(line);
        else logger.info(`[${command}] ${line}`);
      }
    });

    proc.stderr?.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        if (command.includes('whisper')) logger.whisper(line);
        else if (command.includes('ffmpeg')) logger.ffmpeg(line);
        else if (line.toLowerCase().includes('error')) logger.error(`[${command}] ${line}`);
        else logger.info(`[${command}] ${line}`);
      }
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Command ${command} failed with exit code ${code}: ${stderr || stdout}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

export async function transcribeRecording(recordingId, onProgress = null) {
  const recording = getRecording(recordingId);
  if (!recording) {
    throw new Error(`Recording ${recordingId} not found in database.`);
  }

  // 1. Ensure audio is downloaded
  let oggPath = path.join(AUDIO_DIR, `${recordingId}.ogg`);
  if (!fs.existsSync(oggPath) || fs.statSync(oggPath).size < 1000) {
    if (onProgress) onProgress('downloading', 'Downloading audio from Plaud...');
    await downloadRecordingAudio(recordingId, AUDIO_DIR);
  }

  updateRecording(recordingId, { status: 'transcribing' });
  if (onProgress) onProgress('converting', 'Converting audio to WAV...');
  logger.stage('converting', `Converting "${recording.name}" to 16kHz mono WAV via ffmpeg...`, { recordingId, recordingName: recording.name });

  const wavPath = path.join(TMP_DIR, `${recordingId}_16k.wav`);
  const outPrefix = path.join(TMP_DIR, `${recordingId}_out`);
  const jsonPath = `${outPrefix}.json`;

  try {
    // 2. Convert OGG to 16kHz mono WAV with dynamic normalization for optimal speech clarity
    await runCommand('ffmpeg', [
      '-y',
      '-i', oggPath,
      '-af', 'dynaudnorm=f=150:g=15:m=12:r=0.9',
      '-ar', '16000',
      '-ac', '1',
      '-c:a', 'pcm_s16le',
      wavPath
    ]);

    // 3. Run whisper-cli with Whisper Large v3 Turbo
    let modelPath = getSetting('whisper_model_path');
    const libraryModel = path.join(MODELS_DIR, 'ggml-large-v3-turbo.bin');
    const localProjectModel = path.join(__dirname, '..', 'models', 'whisper-large-v3-turbo.bin');
    const meetilyModel = path.join(os.homedir(), 'Library', 'Application Support', 'Meetily', 'models', 'ggml-large-v3-turbo.bin');

    if (!modelPath || !fs.existsSync(modelPath)) {
      if (fs.existsSync(libraryModel)) {
        modelPath = libraryModel;
      } else if (fs.existsSync(localProjectModel)) {
        modelPath = localProjectModel;
      } else if (fs.existsSync(meetilyModel)) {
        modelPath = meetilyModel;
      }
    }

    const threads = getSetting('whisper_threads', '6');

    if (!modelPath || !fs.existsSync(modelPath)) {
      throw new Error(`Whisper Large v3 Turbo model file not found at: ${modelPath || meetilyModel}`);
    }

    if (onProgress) onProgress('transcribing', 'Transcribing with Whisper Large v3 Turbo (Metal GPU)...');
    logger.stage('transcribing', `Transcribing "${recording.name}" with Whisper Large v3 Turbo (Metal GPU)...`, { recordingId, recordingName: recording.name });

    await runCommand('whisper-cli', [
      '-m', modelPath,
      '-f', wavPath,
      '-t', threads,
      '-oj', // output JSON
      '-of', outPrefix,
      '--flash-attn',
      '-mc', '0', // Disable context carry-over to prevent repetitive hallucinations (e.g. infinite "Thank you")
      '--suppress-nst', // Suppress non-speech tokens during silence
      '-nth', '0.65' // Strict no-speech probability threshold
    ]);

    if (!fs.existsSync(jsonPath)) {
      throw new Error(`Whisper output JSON not found at ${jsonPath}`);
    }

    const whisperData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    let segments = whisperData.transcription || [];

    // Filter repetitive hallucination loops (e.g. repeated "Thank you." or "I" during long silences)
    let cleanedSegments = [];
    let repeatCount = 0;
    let lastCleanedText = '';

    for (const seg of segments) {
      const text = (seg.text || '').trim();
      const normText = text.toLowerCase().replace(/[.,!?;:\s]/g, '');

      const isHallucinationCandidate = normText === 'thankyou' || normText === 'you' || normText === 'thanksforwatching' || normText === 'subtitlesby' || normText === 'i' || normText === 'imsorry';

      if (normText === lastCleanedText && normText.length > 0) {
        repeatCount++;
      } else {
        repeatCount = 1;
        lastCleanedText = normText;
      }

      if (isHallucinationCandidate && repeatCount > 1) {
        continue;
      }
      if (repeatCount > 3 && normText.length < 25) {
        continue;
      }

      cleanedSegments.push(seg);
    }
    segments = cleanedSegments;

    let finalSegments = segments;
    let fullText = segments
      .map((s) => {
        const time = s.timestamps ? s.timestamps.from.split(',')[0] : '';
        return `[${time}] ${s.text.trim()}`;
      })
      .join('\n');

    // 4. Run NVIDIA Nemotron-3 Diarization (Sortformer)
    const diarizationEnabled = getSetting('diarization_enabled', 'true') !== 'false';
    let diarModelPath = getSetting('diarization_model_path');
    const libraryDiarModel = path.join(MODELS_DIR, 'nemotron3_diar_v3.onnx');
    const localDiarModel = path.join(__dirname, '..', 'models', 'nemotron3_diar_v3.onnx');
    const meetilyDiarModel = path.join(os.homedir(), 'Library', 'Application Support', 'Meetily', 'models', 'diarization', 'nemotron3_diar_v3.onnx');

    if (!diarModelPath || !fs.existsSync(diarModelPath)) {
      if (fs.existsSync(libraryDiarModel)) {
        diarModelPath = libraryDiarModel;
      } else if (fs.existsSync(localDiarModel)) {
        diarModelPath = localDiarModel;
      } else if (fs.existsSync(meetilyDiarModel)) {
        diarModelPath = meetilyDiarModel;
      }
    }

    if (diarModelPath && diarModelPath.includes('app.asar')) {
      const unpackedModel = diarModelPath.replace('app.asar', 'app.asar.unpacked');
      if (fs.existsSync(unpackedModel)) diarModelPath = unpackedModel;
    }

    let effectiveDiarScript = path.join(__dirname, 'diarize.py');
    if (effectiveDiarScript.includes('app.asar')) {
      const unpackedPath = effectiveDiarScript.replace('app.asar', 'app.asar.unpacked');
      if (fs.existsSync(unpackedPath)) {
        effectiveDiarScript = unpackedPath;
      } else {
        // Extract diarize.py to real filesystem path in TMP_DIR so external Python process can read it
        const extractedPath = path.join(TMP_DIR, 'diarize.py');
        try {
          const scriptContent = fs.readFileSync(effectiveDiarScript, 'utf8');
          fs.writeFileSync(extractedPath, scriptContent, 'utf8');
          effectiveDiarScript = extractedPath;
        } catch (err) {
          console.warn('Failed to extract diarize.py to TMP_DIR:', err.message);
        }
      }
    }

    const diarOutJson = path.join(TMP_DIR, `${recordingId}_diar.json`);

    if (diarizationEnabled && fs.existsSync(effectiveDiarScript) && diarModelPath && fs.existsSync(diarModelPath)) {
      if (onProgress) onProgress('diarizing', 'Diarizing speakers with NVIDIA Nemotron-3 (Sortformer)...');
      logger.stage('diarizing', `Diarizing speakers for "${recording.name}" with NVIDIA Nemotron-3...`, { recordingId, recordingName: recording.name });
      try {
        await runCommand('uv', [
          'run',
          '--with', 'onnxruntime',
          '--with', 'numpy',
          '--with', 'soundfile',
          '--with', 'scipy',
          'python', effectiveDiarScript,
          '--audio', wavPath,
          '--model', diarModelPath,
          '--whisper-json', jsonPath,
          '--out-json', diarOutJson
        ]);

        if (fs.existsSync(diarOutJson)) {
          const diarData = JSON.parse(fs.readFileSync(diarOutJson, 'utf8'));
          if (diarData.aligned_segments && diarData.aligned_segments.length > 0) {
            finalSegments = diarData.aligned_segments;
            fullText = diarData.formatted_text || fullText;
          }
        }
      } catch (diarErr) {
        console.error('Diarization encountered an error, keeping Whisper transcript:', diarErr.message);
        logger.warn(`Diarization note: ${diarErr.message}. Preserving Whisper transcript.`, { recordingId, recordingName: recording.name });
      }
    }

    // Update DB
    updateRecording(recordingId, {
      status: 'transcribed',
      error_message: '',
      transcript_json: JSON.stringify(finalSegments),
      transcript_text: fullText,
      summary_markdown: '',
      summary_html: '',
      reasoning_text: '',
      processed_at: new Date().toISOString()
    });

    if (onProgress) onProgress('transcribed', 'Transcription and diarization complete.');
    logger.stage('transcribed', `✅ Completed transcription for "${recording.name}" (${finalSegments.length} segments, ${fullText.length} characters).`, { recordingId, recordingName: recording.name });

    return {
      success: true,
      segmentCount: finalSegments.length,
      textLength: fullText.length,
      transcriptText: fullText
    };
  } catch (err) {
    updateRecording(recordingId, {
      status: 'error',
      error_message: err.message
    });
    throw err;
  } finally {
    // Cleanup temporary wav and json files
    try {
      if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
      if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);
      const diarOutJson = path.join(TMP_DIR, `${recordingId}_diar.json`);
      if (fs.existsSync(diarOutJson)) fs.unlinkSync(diarOutJson);
    } catch (_) {}
  }
}
