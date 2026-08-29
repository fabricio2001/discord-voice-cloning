"""Validate imports and local executables without downloading model weights."""
from pathlib import Path
import subprocess
import sys

import cover_pipeline  # Configure workspace-local caches before importing ML packages.
import demucs.pretrained
import imageio_ffmpeg
import soundfile
import torch
import torchaudio
import transformers
import yt_dlp.version

seed = Path(__file__).resolve().parent / "engines" / "seed-vc"
sys.path.insert(0, str(seed))
import inference
from modules.length_regulator import InterpolateRegulator
from modules.bigvgan.bigvgan import BigVGAN

subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-version"], check=True, capture_output=True)
print(f"Torch: {torch.__version__}; CUDA disponível: {torch.cuda.is_available()}")
if torch.cuda.is_available():
    print(f"GPU: {torch.cuda.get_device_name()}")
print(f"Seed-VC, Demucs, FFmpeg e yt-dlp ({yt_dlp.version.__version__}) importados com sucesso.")
