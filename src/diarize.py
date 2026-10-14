#!/usr/bin/env python3
"""
NVIDIA Nemotron-3 Diarization (Sortformer v3) Runner
Performs multi-speaker diarization on audio and aligns with Whisper transcription.
"""

import sys
import os
import math
import json
import time
import argparse
import numpy as np
import soundfile as sf
import onnxruntime as ort

N_FFT = 512
WIN_LENGTH = 400
HOP_LENGTH = 160
N_MELS = 128
PREEMPH = 0.97
LOG_ZERO_GUARD = 5.9604645e-8
SAMPLE_RATE = 16000
NUM_SPEAKERS = 8
SUBSAMPLING = 8
UPSAMPLE_FACTOR = 8
FRAME_DURATION = 0.08  # 80ms

F_SP = 200.0 / 3.0
LOG_STEP = 0.06875177742094912

def hz_to_mel(hz):
    return hz / F_SP if hz < 1000.0 else 15.0 + math.log(hz / 1000.0) / LOG_STEP

def mel_to_hz(mel):
    return mel * F_SP if mel < 15.0 else 1000.0 * math.exp((mel - 15.0) * LOG_STEP)

def create_mel_filterbank():
    max_mel = hz_to_mel(SAMPLE_RATE / 2.0)
    points = [mel_to_hz(max_mel * i / (N_MELS + 1)) for i in range(N_MELS + 2)]
    mel_basis = np.zeros((N_MELS, N_FFT // 2 + 1), dtype=np.float32)
    for m in range(N_MELS):
        norm = 2.0 / (points[m + 2] - points[m])
        for k in range(N_FFT // 2 + 1):
            hz = k * SAMPLE_RATE / N_FFT
            lower = (hz - points[m]) / (points[m + 1] - points[m])
            upper = (points[m + 2] - hz) / (points[m + 2] - points[m + 1])
            mel_basis[m, k] = max(0.0, min(lower, upper)) * norm
    return mel_basis

MEL_BASIS = create_mel_filterbank()

_n = WIN_LENGTH - 1
_hann = 0.5 - 0.5 * np.cos(2.0 * np.pi * np.arange(WIN_LENGTH) / _n)
FFT_WINDOW = np.zeros(N_FFT, dtype=np.float32)
_win_offset = (N_FFT - WIN_LENGTH) // 2
FFT_WINDOW[_win_offset : _win_offset + WIN_LENGTH] = _hann

def extract_mel_features(audio):
    pre = np.empty_like(audio)
    pre[0] = audio[0]
    pre[1:] = audio[1:] - PREEMPH * audio[:-1]

    pad = N_FFT // 2
    padded = np.pad(pre, (pad, pad), mode='constant')
    num_frames = (len(padded) - N_FFT) // HOP_LENGTH + 1

    from numpy.lib.stride_tricks import as_strided
    frames = as_strided(padded, shape=(num_frames, N_FFT), strides=(padded.strides[0] * HOP_LENGTH, padded.strides[0]))
    windowed = frames * FFT_WINDOW
    spec = np.fft.rfft(windowed, n=N_FFT, axis=-1)
    power_spec = (np.abs(spec) ** 2).astype(np.float32)
    mel_spec = np.dot(power_spec, MEL_BASIS.T)
    log_mel = np.log(mel_spec + LOG_ZERO_GUARD)
    return np.expand_dims(log_mel.astype(np.float32), axis=0)

class SortformerDiarizer:
    def __init__(self, model_path):
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = 6
        opts.inter_op_num_threads = 1
        self.session = ort.InferenceSession(model_path, opts, providers=['CPUExecutionProvider'])
        
        meta = self.session.get_modelmeta().custom_metadata_map
        self.chunk_len = int(meta.get('chunk_len', 340))
        self.fifo_len = int(meta.get('fifo_len', 40))
        self.spkcache_len = int(meta.get('spkcache_len', 264))
        self.right_context = int(meta.get('right_context', 40))
        self.spkcache_update_period = int(meta.get('spkcache_update_period', 300))
        
        raw_sil = meta.get('learnable_sil_emb', '')
        if raw_sil:
            self.sil_emb = np.array([float(x.strip()) for x in raw_sil.split(',') if x.strip()], dtype=np.float32)
        else:
            self.sil_emb = np.zeros(512, dtype=np.float32)

        self.reset()

    def reset(self):
        self.spkcache = np.zeros((1, 0, 512), dtype=np.float32)
        self.spkcache_preds = None
        self.fifo = np.zeros((1, 0, 512), dtype=np.float32)
        self.fifo_preds = np.zeros((1, 0, NUM_SPEAKERS), dtype=np.float32)

    def process(self, features):
        total_frames = features.shape[1]
        chunk_stride = self.chunk_len * SUBSAMPLING
        feed_size = (self.chunk_len + self.right_context) * SUBSAMPLING
        num_chunks = math.ceil(total_frames / chunk_stride)

        all_chunk_preds = []

        for chunk_idx in range(num_chunks):
            start = chunk_idx * chunk_stride
            end = min(start + feed_size, total_frames)
            current_len = end - start

            chunk = features[:, start:end, :]
            pad_len = math.ceil(current_len / SUBSAMPLING) * SUBSAMPLING
            if pad_len > current_len:
                chunk = np.pad(chunk, ((0, 0), (0, pad_len - current_len), (0, 0)))

            chunk_preds_hires = self._streaming_update(chunk, current_len)
            all_chunk_preds.append(chunk_preds_hires)

        if not all_chunk_preds:
            return np.zeros((0, NUM_SPEAKERS), dtype=np.float32)

        full_preds = np.concatenate(all_chunk_preds, axis=0)
        if full_preds.shape[0] > total_frames:
            full_preds = full_preds[:total_frames, :]
        return full_preds

    def _streaming_update(self, chunk_feat, current_len):
        spkcache_len = self.spkcache.shape[1]
        fifo_len = self.fifo.shape[1]

        inputs = {
            'chunk': chunk_feat,
            'chunk_lengths': np.array([current_len], dtype=np.int64),
            'spkcache': self.spkcache,
            'spkcache_lengths': np.array([spkcache_len], dtype=np.int64),
            'fifo': self.fifo,
            'fifo_lengths': np.array([fifo_len], dtype=np.int64),
        }

        outputs = self.session.run(None, inputs)
        preds_diar = outputs[0]
        preds_hires = outputs[1]
        new_embs = outputs[2]

        valid_frames = math.ceil(current_len / SUBSAMPLING)
        keep = min(self.chunk_len, valid_frames)

        fifo_preds = preds_diar[:, spkcache_len : spkcache_len + fifo_len, :] if fifo_len > 0 else np.zeros((1, 0, NUM_SPEAKERS), dtype=np.float32)
        chunk_preds = preds_diar[:, spkcache_len + fifo_len : spkcache_len + fifo_len + keep, :]
        chunk_embs = new_embs[:, :keep, :]

        hires_start = (spkcache_len + fifo_len) * UPSAMPLE_FACTOR
        chunk_preds_hires = preds_hires[0, hires_start : hires_start + keep * UPSAMPLE_FACTOR, :]

        self.fifo = np.concatenate([self.fifo, chunk_embs], axis=1) if fifo_len > 0 else chunk_embs
        if fifo_len > 0:
            self.fifo_preds = np.concatenate([fifo_preds, chunk_preds], axis=1)
        else:
            self.fifo_preds = chunk_preds

        fifo_len_after = self.fifo.shape[1]

        if fifo_len_after > self.fifo_len:
            pop_out_len = max(self.spkcache_update_period, max(0, keep + fifo_len - self.fifo_len))
            pop_out_len = min(pop_out_len, fifo_len_after)

            pop_out_embs = self.fifo[:, :pop_out_len, :]
            pop_out_preds = self.fifo_preds[:, :pop_out_len, :]

            self.fifo = self.fifo[:, pop_out_len:, :]
            self.fifo_preds = self.fifo_preds[:, pop_out_len:, :]

            if self.spkcache.shape[1] > 0:
                self.spkcache = np.concatenate([self.spkcache, pop_out_embs], axis=1)
            else:
                self.spkcache = pop_out_embs

            if self.spkcache_preds is not None:
                self.spkcache_preds = np.concatenate([self.spkcache_preds, pop_out_preds], axis=1)

            if self.spkcache.shape[1] > self.spkcache_len:
                if self.spkcache_preds is None:
                    initial_cache_preds = preds_diar[:, :spkcache_len, :]
                    self.spkcache_preds = np.concatenate([initial_cache_preds, pop_out_preds], axis=1)
                self._compress_spkcache()

        return chunk_preds_hires

    def _compress_spkcache(self):
        if self.spkcache_preds is None:
            return

        n_frames = self.spkcache.shape[1]
        per_spk = self.spkcache_len // NUM_SPEAKERS
        if per_spk <= 1:
            self.spkcache = self.spkcache[:, :self.spkcache_len, :]
            if self.spkcache_preds is not None:
                self.spkcache_preds = self.spkcache_preds[:, :self.spkcache_len, :]
            return

        spkcache_len_per_spk = per_spk - 1
        strong_boost_per_spk = int(spkcache_len_per_spk * 0.75)
        weak_boost_per_spk = int(spkcache_len_per_spk * 1.5)
        min_pos_scores_per_spk = int(spkcache_len_per_spk * 0.5)

        preds_2d = self.spkcache_preds[0]
        scores = self._get_log_pred_scores(preds_2d)
        scores = self._disable_low_scores(preds_2d, scores, min_pos_scores_per_spk)

        for t in range(min(self.spkcache_len, n_frames), n_frames):
            scores[t, :] += 0.05

        scores = self._boost_topk(scores, strong_boost_per_spk, 2.0)
        scores = self._boost_topk(scores, weak_boost_per_spk, 1.0)

        padded = np.full((n_frames + 1, NUM_SPEAKERS), -np.inf, dtype=np.float32)
        padded[:n_frames, :] = scores
        padded[n_frames, :] = np.inf
        scores = padded

        topk_indices, is_disabled = self._get_topk_indices(scores, n_frames)
        new_embs, new_preds = self._gather_spkcache(topk_indices, is_disabled)
        self.spkcache = new_embs
        self.spkcache_preds = new_preds

    def _get_log_pred_scores(self, preds):
        p_clamped = np.clip(preds, 0.25, None)
        p_inv_clamped = np.clip(1.0 - preds, 0.25, None)
        log_p = np.log(p_clamped)
        log_1_p = np.log(p_inv_clamped)
        log_1_p_sum = np.sum(log_1_p, axis=1, keepdims=True)
        return log_p - log_1_p + log_1_p_sum - math.log(0.5)

    def _disable_low_scores(self, preds, scores, min_pos_scores):
        pos_count = np.sum(scores > 0.0, axis=0)
        for s in range(NUM_SPEAKERS):
            mask_non_speech = preds[:, s] <= 0.5
            mask_low_overlap = (scores[:, s] <= 0.0) & (pos_count[s] >= min_pos_scores)
            scores[mask_non_speech | mask_low_overlap, s] = -np.inf
        return scores

    def _boost_topk(self, scores, k, scale):
        for s in range(NUM_SPEAKERS):
            order = np.argsort(-scores[:, s])
            top_k = order[:k]
            valid = scores[top_k, s] != -np.inf
            scores[top_k[valid], s] -= scale * math.log(0.5)
        return scores

    def _get_topk_indices(self, scores, n_frames_no_sil):
        n_frames = scores.shape[0]
        flat_scores = []
        for s in range(NUM_SPEAKERS):
            for t in range(n_frames):
                flat_idx = s * n_frames + t
                flat_scores.append((flat_idx, scores[t, s]))

        flat_scores.sort(key=lambda x: x[1], reverse=True)
        topk = flat_scores[:self.spkcache_len]

        MAX_INDEX = 99999
        flat_indices = [MAX_INDEX if score == -np.inf else idx for idx, score in topk]
        flat_indices.sort()

        is_disabled = []
        frame_indices = []
        for idx in flat_indices:
            if idx == MAX_INDEX:
                is_disabled.append(True)
                frame_indices.append(0)
            else:
                f_idx = idx % n_frames
                if f_idx >= n_frames_no_sil:
                    is_disabled.append(True)
                    frame_indices.append(0)
                else:
                    is_disabled.append(False)
                    frame_indices.append(f_idx)

        return frame_indices, is_disabled

    def _gather_spkcache(self, indices, is_disabled):
        new_embs = np.zeros((1, self.spkcache_len, 512), dtype=np.float32)
        new_preds = np.zeros((1, self.spkcache_len, NUM_SPEAKERS), dtype=np.float32)
        cache_preds = self.spkcache_preds[0]

        for i, (idx, disabled) in enumerate(zip(indices, is_disabled)):
            if i >= self.spkcache_len:
                break
            if disabled:
                new_embs[0, i, :] = self.sil_emb
            elif idx < self.spkcache.shape[1]:
                new_embs[0, i, :] = self.spkcache[0, idx, :]
                new_preds[0, i, :] = cache_preds[idx, :]

        return new_embs, new_preds

def median_filter(preds, window=11):
    if window <= 1:
        return preds
    from scipy.ndimage import median_filter as sc_med_filter
    return sc_med_filter(preds, size=(window, 1), mode='reflect')

def binarize(preds, onset=0.5, offset=0.5, min_duration_on=0.2, min_duration_off=0.2, pad_onset=0.0, pad_offset=0.0):
    num_frames = preds.shape[0]
    frame_sec = FRAME_DURATION / UPSAMPLE_FACTOR
    segments = []

    for spk in range(NUM_SPEAKERS):
        runs = []
        in_seg = False
        seg_start = 0

        for t in range(num_frames):
            p = preds[t, spk]
            if p > onset:
                active = True
            elif p < offset:
                active = False
            else:
                active = in_seg

            if active and not in_seg:
                seg_start = t
            elif not active and in_seg:
                runs.append((seg_start, t))
            in_seg = active

        if in_seg:
            runs.append((seg_start, num_frames))

        temp = []
        for s_f, e_f in runs:
            start_sec = max(0.0, s_f * frame_sec - pad_onset)
            end_sec = e_f * frame_sec + pad_offset
            if end_sec - start_sec >= min_duration_on:
                temp.append({'speaker': spk, 'start': round(start_sec, 3), 'end': round(end_sec, 3)})

        if min_duration_off > 0 and len(temp) > 1:
            merged = [temp[0]]
            for seg in temp[1:]:
                last = merged[-1]
                if seg['start'] - last['end'] < min_duration_off:
                    last['end'] = max(last['end'], seg['end'])
                else:
                    merged.append(seg)
            segments.extend(merged)
        else:
            segments.extend(temp)

    segments.sort(key=lambda s: (s['start'], s['speaker']))
    return segments

def align_whisper_with_diarization(whisper_segments, diar_intervals):
    aligned = []
    last_speaker = 1

    for w in whisper_segments:
        w_start = w.get('offsets', {}).get('from', 0) / 1000.0
        w_end = w.get('offsets', {}).get('to', 0) / 1000.0
        
        # Calculate overlap duration with each speaker
        spk_overlap = {}
        for d in diar_intervals:
            overlap = max(0.0, min(w_end, d['end']) - max(w_start, d['start']))
            if overlap > 0:
                spk = d['speaker'] + 1
                spk_overlap[spk] = spk_overlap.get(spk, 0.0) + overlap

        if spk_overlap:
            assigned_spk = max(spk_overlap.items(), key=lambda x: x[1])[0]
            last_speaker = assigned_spk
        else:
            assigned_spk = last_speaker

        aligned_item = dict(w)
        aligned_item['speaker'] = f'Speaker {assigned_spk}'
        aligned_item['speaker_id'] = assigned_spk - 1
        aligned.append(aligned_item)

    return aligned

def build_formatted_text(aligned_segments):
    lines = []
    current_speaker = None
    current_text_parts = []
    current_start_time = None

    for seg in aligned_segments:
        spk = seg.get('speaker', 'Speaker 1')
        time_str = seg.get('timestamps', {}).get('from', '').split(',')[0]
        text = seg.get('text', '').strip()
        if not text:
            continue

        if spk != current_speaker:
            if current_speaker is not None and current_text_parts:
                lines.append(f"[{current_start_time}] {current_speaker}: {' '.join(current_text_parts)}")
            current_speaker = spk
            current_start_time = time_str
            current_text_parts = [text]
        else:
            current_text_parts.append(text)

    if current_speaker is not None and current_text_parts:
        lines.append(f"[{current_start_time}] {current_speaker}: {' '.join(current_text_parts)}")

    return '\n\n'.join(lines)

def main():
    parser = argparse.ArgumentParser(description='NVIDIA Nemotron-3 Diarizer')
    parser.add_argument('--audio', required=True, help='Path to 16kHz WAV or audio file')
    parser.add_argument('--model', default='models/nemotron3_diar_v3.onnx', help='Path to ONNX model')
    parser.add_argument('--whisper-json', default=None, help='Path to whisper-cli output JSON')
    parser.add_argument('--out-json', default=None, help='Path to write output JSON')
    parser.add_argument('--onset', type=float, default=0.5)
    parser.add_argument('--offset', type=float, default=0.5)
    parser.add_argument('--min-on', type=float, default=0.2)
    parser.add_argument('--min-off', type=float, default=0.2)
    parser.add_argument('--median-window', type=int, default=11)

    args = parser.parse_args()

    if not os.path.exists(args.audio):
        print(f"Error: audio file not found: {args.audio}", file=sys.stderr)
        sys.exit(1)

    model_path = args.model
    if not os.path.exists(model_path):
        meetily_path = os.path.expanduser('~/Library/Application Support/Meetily/models/diarization/nemotron3_diar_v3.onnx')
        if os.path.exists(meetily_path):
            model_path = meetily_path
        else:
            print(f"Error: model file not found at {model_path}", file=sys.stderr)
            sys.exit(1)

    audio, sr = sf.read(args.audio)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)

    if sr != SAMPLE_RATE:
        from scipy.signal import resample_poly
        from math import gcd
        g = gcd(sr, SAMPLE_RATE)
        audio = resample_poly(audio, SAMPLE_RATE // g, sr // g)
        sr = SAMPLE_RATE

    audio_duration = len(audio) / SAMPLE_RATE

    # Feature extraction
    t0 = time.time()
    feats = extract_mel_features(audio)
    t_feat = time.time() - t0

    # ONNX Inference
    t0 = time.time()
    diarizer = SortformerDiarizer(model_path)
    raw_preds = diarizer.process(feats)
    t_inf = time.time() - t0

    # Post-process
    filtered = median_filter(raw_preds, window=args.median_window)
    diar_intervals = binarize(
        filtered,
        onset=args.onset,
        offset=args.offset,
        min_duration_on=args.min_on,
        min_duration_off=args.min_off
    )

    detected_speakers = sorted(list(set(d['speaker'] + 1 for d in diar_intervals)))
    speaker_labels = [f"Speaker {s}" for s in detected_speakers]

    result = {
        'audio_duration': round(audio_duration, 2),
        'inference_time': round(t_inf, 2),
        'real_time_factor': round(t_inf / max(1.0, audio_duration), 3),
        'speaker_count': len(detected_speakers),
        'speakers': speaker_labels,
        'diarization_intervals': diar_intervals,
    }

    if args.whisper_json and os.path.exists(args.whisper_json):
        with open(args.whisper_json, 'r', encoding='utf-8') as f:
            whisper_data = json.load(f)
        w_segs = whisper_data.get('transcription', [])
        aligned_segments = align_whisper_with_diarization(w_segs, diar_intervals)
        formatted_text = build_formatted_text(aligned_segments)
        
        result['aligned_segments'] = aligned_segments
        result['formatted_text'] = formatted_text

    output_str = json.dumps(result, indent=2)

    if args.out_json:
        with open(args.out_json, 'w', encoding='utf-8') as f:
            f.write(output_str)
        print(f"Diarization written to {args.out_json}")
    else:
        print(output_str)

if __name__ == '__main__':
    main()
