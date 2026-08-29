"""Local AI covers: bounded input -> Demucs -> Seed-VC singing -> MP3/PCM.

Only load official model weights. No user-supplied Python/checkpoints are accepted.
"""
from __future__ import annotations

import argparse
import gc
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
os.environ.setdefault("HF_HOME", str(ROOT / "models" / "cover-huggingface"))
os.environ.setdefault("TORCH_HOME", str(ROOT / "models" / "cover-torch"))
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ.setdefault("MPLCONFIGDIR", str(ROOT / ".tmp" / "cover-matplotlib"))


def progress(stage: str) -> None:
    print("COVER_PROGRESS " + json.dumps({"stage": stage}, ensure_ascii=False), flush=True)


def youtube_url(value: str) -> str:
    url = urlparse(value)
    if url.scheme != "https" or url.username or url.password or url.port not in (None, 443):
        raise ValueError("Use um link HTTPS de um vídeo do YouTube.")
    query = parse_qs(url.query)
    if "list" in query:
        raise ValueError("Playlists não são aceitas; envie apenas o link do vídeo.")
    if url.hostname == "youtu.be":
        video_id = url.path.removeprefix("/")
    elif url.hostname in ("youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"):
        if url.path == "/watch":
            video_id = query.get("v", [""])[0]
        else:
            match = re.fullmatch(r"/(?:shorts|embed)/([A-Za-z0-9_-]{11})", url.path)
            video_id = match.group(1) if match else ""
    else:
        video_id = ""
    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
        raise ValueError("Link do YouTube inválido ou não suportado.")
    return "https://www.youtube.com/watch?v=" + video_id


def download_youtube(url: str, directory: Path, max_seconds: int, max_bytes: int) -> Path:
    from yt_dlp import YoutubeDL

    url = youtube_url(url)
    directory.mkdir(parents=True, exist_ok=True)
    progress("Baixando o áudio do YouTube para arquivo local")

    def check_info(info, *, incomplete=False):
        duration = info.get("duration")
        if info.get("is_live") or info.get("live_status") in ("is_live", "is_upcoming", "post_live"):
            return "Transmissões ao vivo não são aceitas."
        if duration is not None and (not math.isfinite(duration) or duration > max_seconds):
            return f"O vídeo excede o limite de {max_seconds} segundos."
        if not incomplete and (duration is None or duration <= 0):
            return "Não foi possível verificar a duração do vídeo."
        return None

    def check_download(data):
        if data.get("downloaded_bytes", 0) > max_bytes:
            raise ValueError("O download excedeu o tamanho permitido.")

    options = {
        "format": "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio",
        # Keep the native download separate even if the source already is MP3.
        "outtmpl": str(directory / "youtube-download.%(ext)s"),
        "noplaylist": True, "playlistend": 1, "max_filesize": max_bytes,
        "match_filter": check_info, "progress_hooks": [check_download],
        "socket_timeout": 20, "retries": 2, "fragment_retries": 2,
        "quiet": True, "noprogress": True, "restrictfilenames": True,
        "cachedir": str(ROOT / ".tmp" / "yt-dlp"),
        "js_runtimes": {"node": {}},
        "extractor_args": {"youtube": {"player_client": ["default"]}},
    }
    with YoutubeDL(options) as downloader:
        info = downloader.extract_info(url, download=False)
        if not info or info.get("_type") in ("playlist", "multi_video"):
            raise ValueError("Envie um único vídeo, não uma playlist.")
        reason = check_info(info)
        if reason:
            raise ValueError(reason)
        downloader.process_info(info)
        downloaded = Path(downloader.prepare_filename(info))
    if not downloaded.is_file() or not 0 < downloaded.stat().st_size <= max_bytes:
        raise ValueError("Não foi possível baixar o áudio dentro do limite de tamanho.")

    # YouTube normally serves M4A/WebM, not MP3. Convert the completed local
    # download using the bundled FFmpeg; no remote URL reaches the audio models.
    progress("Convertendo o download para MP3 local")
    mp3 = directory / "youtube.mp3"
    ffmpeg(["-protocol_whitelist", "file,pipe", "-format_whitelist", "mp3,wav,flac,ogg,aac,mov,matroska,webm",
            "-i", str(downloaded), "-map", "0:a:0", "-vn", "-t", str(max_seconds + 1),
            "-ar", "44100", "-ac", "2", "-c:a", "libmp3lame", "-b:a", "192k", str(mp3)])
    if not mp3.is_file() or not 0 < mp3.stat().st_size <= max_bytes:
        raise ValueError("O MP3 local está vazio ou excede o limite de tamanho.")
    progress("MP3 local pronto; validando antes de processar a voz")
    return mp3


def ffmpeg(arguments: list[str], timeout: int = 180) -> None:
    import imageio_ffmpeg
    result = subprocess.run(
        [imageio_ffmpeg.get_ffmpeg_exe(), "-nostdin", "-hide_banner", "-loglevel", "error", "-y", *arguments],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    if result.returncode:
        raise ValueError("Falha ao decodificar/exportar áudio: " + result.stderr[-1200:])


def normalize(source: Path, output: Path, max_seconds: int) -> None:
    import soundfile as sf
    # No network protocols or playlist/concat demuxers for user uploads.
    ffmpeg(["-protocol_whitelist", "file,pipe", "-format_whitelist", "mp3,wav,flac,ogg,aac,mov,matroska,webm",
            "-i", str(source), "-map", "0:a:0", "-vn", "-t", str(max_seconds + 1),
            "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", str(output)])
    info = sf.info(output)
    if info.duration < 1 or info.duration > max_seconds:
        raise ValueError(f"O áudio deve ter entre 1 e {max_seconds} segundos.")


def separate(source: Path, directory: Path) -> tuple[Path, Path]:
    import numpy as np
    import soundfile as sf
    import torch
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    model = get_model("htdemucs")
    model.eval()
    device = "cuda" if torch.cuda.is_available() else "cpu"
    wave, sr = sf.read(source, dtype="float32", always_2d=True)
    if sr != model.samplerate:
        raise ValueError("Taxa de amostragem inesperada para Demucs.")
    tensor = torch.from_numpy(wave.T.copy())
    ref = tensor.mean(0)
    mean, std = ref.mean(), ref.std()
    if not torch.isfinite(std) or std < 1e-6:
        raise ValueError("O arquivo não contém áudio utilizável.")
    with torch.no_grad():
        stems = apply_model(model, ((tensor - mean) / std)[None], device=device,
                            shifts=0, split=True, overlap=0.25, progress=True, num_workers=0)[0]
        stems = (stems * std + mean).cpu().numpy()
    vocal_index = model.sources.index("vocals")
    vocals = stems[vocal_index].T
    instrumental = np.delete(stems, vocal_index, axis=0).sum(axis=0).T
    vocal_path, instrumental_path = directory / "vocals.wav", directory / "instrumental.wav"
    sf.write(vocal_path, vocals, sr, subtype="FLOAT")
    sf.write(instrumental_path, instrumental, sr, subtype="FLOAT")
    del model, stems, tensor
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    return vocal_path, instrumental_path


def convert(vocals: Path, reference: Path, directory: Path, seed_dir: Path, steps: int) -> Path:
    import torch
    sys.path.insert(0, str(seed_dir))
    previous = Path.cwd()
    try:
        os.chdir(seed_dir)  # upstream uses relative config/checkpoint paths
        import inference
        inference.main(argparse.Namespace(
            source=str(vocals), target=str(reference), output=str(directory),
            diffusion_steps=steps, length_adjust=1.0, inference_cfg_rate=0.7,
            f0_condition=True, auto_f0_adjust=False, semi_tone_shift=0,
            checkpoint=None, config=None, fp16=torch.cuda.is_available(),
        ))
    finally:
        os.chdir(previous)
    files = list(directory.glob("vc_*.wav"))
    if len(files) != 1:
        raise ValueError("O Seed-VC não produziu o vocal esperado.")
    return files[0]


def mix(converted: Path, instrumental: Path, output: Path) -> None:
    import librosa
    import numpy as np
    import soundfile as sf
    backing, sr = sf.read(instrumental, dtype="float32", always_2d=True)
    vocal, _ = librosa.load(converted, sr=sr, mono=True)
    if not np.isfinite(vocal).all() or not np.isfinite(backing).all():
        raise ValueError("O modelo gerou amostras inválidas; tente outra referência de voz.")
    vocal = np.pad(vocal, (0, max(0, len(backing) - len(vocal))))[:len(backing)]
    mixed = backing + vocal[:, None]
    target_length = round(len(mixed) * 48000 / sr)
    mixed = librosa.resample(mixed, orig_sr=sr, target_sr=48000, axis=0)
    mixed = librosa.util.fix_length(mixed, size=target_length, axis=0)
    peak = float(np.max(np.abs(mixed)))
    if peak > 0.95:
        mixed *= 0.95 / peak
    # libsndfile PCM_16 produces the 44-byte header expected by playWav.
    sf.write(output, mixed, 48000, subtype="PCM_16")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--input", type=Path)
    source.add_argument("--youtube")
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--seed-dir", type=Path, default=ROOT / "engines" / "seed-vc")
    parser.add_argument("--max-seconds", type=int, default=300)
    parser.add_argument("--max-bytes", type=int, default=25 * 1024 * 1024)
    parser.add_argument("--steps", type=int, default=30)
    args = parser.parse_args()
    if not 1 <= args.max_seconds <= 600 or not 1 <= args.max_bytes <= 100 * 1024 * 1024:
        parser.error("Limites de entrada inválidos.")
    if not 1 <= args.steps <= 50:
        parser.error("Etapas de difusão devem estar entre 1 e 50.")
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    reference, seed_dir = args.reference.resolve(), args.seed_dir.resolve()
    if not reference.is_file() or not (seed_dir / "inference.py").is_file():
        raise ValueError("Referência ou instalação Seed-VC não encontrada. Execute instalar-cover.ps1.")
    progress("Obtendo o áudio")
    source_path = download_youtube(args.youtube, output, args.max_seconds, args.max_bytes) if args.youtube else args.input.resolve()
    if source_path.stat().st_size > args.max_bytes:
        raise ValueError("Arquivo acima do limite de tamanho.")
    normalized = output / "source.wav"
    progress("Validando o áudio")
    normalize(source_path, normalized, args.max_seconds)
    progress("Separando voz e instrumental")
    vocals, instrumental = separate(normalized, output)
    progress("Convertendo a voz com Seed-VC")
    converted = convert(vocals, reference, output / "converted", seed_dir, args.steps)
    progress("Mixando e exportando")
    mix(converted, instrumental, output / "cover.wav")
    ffmpeg(["-i", str(output / "cover.wav"), "-c:a", "libmp3lame", "-b:a", "128k",
            "-metadata", "title=Cover gerado por IA", str(output / "cover.mp3")])
    progress("Concluído")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("COVER_ERROR " + str(error), file=sys.stderr, flush=True)
        raise
