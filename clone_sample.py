from __future__ import annotations

import argparse
import inspect
import os
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent
os.environ.setdefault("HF_HOME", str(PROJECT_DIR / "models" / "huggingface"))
os.environ.setdefault("TORCH_HOME", str(PROJECT_DIR / "models" / "torch"))

import librosa
import numpy as np
import soundfile as sf
import torch
from chatterbox.mtl_tts import ChatterboxMultilingualTTS


DEFAULT_SOURCE = Path(
    r"C:\Programacao\Codex\Discord\recordings\LACOSTE_CORP-721886486638886953"
    r"\2026-08-26T21-47-20-547Z\Felipe-286185000158756867.wav"
)
DEFAULT_TEXT = (
    "Olá! Esta é uma demonstração de voz sintetizada localmente. "
    "O sistema está usando inteligência artificial para narrar este texto "
    "em português brasileiro."
)
SCRIPT_VERSION = "2026-08-26.2"


def prepare_reference(source: Path, destination: Path, sample_rate: int = 24_000) -> None:
    """Remove long silences and build a clean prompt with at most 10 seconds."""
    audio, _ = librosa.load(source, sr=sample_rate, mono=True)
    if audio.size == 0:
        raise ValueError(f"O arquivo não contém áudio: {source}")

    intervals = librosa.effects.split(audio, top_db=35)
    pause = np.zeros(int(0.08 * sample_rate), dtype=np.float32)
    target_samples = 10 * sample_rate
    parts: list[np.ndarray] = []
    total = 0

    for start, end in intervals:
        segment = audio[start:end].astype(np.float32, copy=True)
        if segment.size < int(0.15 * sample_rate):
            continue

        remaining = target_samples - total
        if remaining <= 0:
            break
        segment = segment[:remaining]

        # Short fades avoid clicks where speech regions are joined.
        fade = min(int(0.01 * sample_rate), segment.size // 2)
        if fade:
            ramp = np.linspace(0.0, 1.0, fade, dtype=np.float32)
            segment[:fade] *= ramp
            segment[-fade:] *= ramp[::-1]

        parts.append(segment)
        total += segment.size
        if total < target_samples:
            spacer = pause[: target_samples - total]
            parts.append(spacer)
            total += spacer.size

    if not parts:
        raise ValueError("Não foi possível encontrar fala utilizável na referência.")

    reference = np.concatenate(parts)[:target_samples]
    if reference.size < 3 * sample_rate:
        raise ValueError("A referência tem menos de três segundos de fala útil.")

    peak = float(np.max(np.abs(reference)))
    if peak > 0:
        reference *= (10 ** (-1.0 / 20.0)) / peak

    destination.parent.mkdir(parents=True, exist_ok=True)
    sf.write(destination, reference, sample_rate, subtype="PCM_16")


def load_model(device: str) -> ChatterboxMultilingualTTS:
    parameters = inspect.signature(ChatterboxMultilingualTTS.from_pretrained).parameters
    if "t3_model" in parameters:
        return ChatterboxMultilingualTTS.from_pretrained(device=device, t3_model="v3")
    return ChatterboxMultilingualTTS.from_pretrained(device=device)


def main() -> None:
    print(f"Clonador de voz versão {SCRIPT_VERSION}")
    parser = argparse.ArgumentParser(description="Clona uma voz com Chatterbox TTS.")
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--text", default=DEFAULT_TEXT)
    parser.add_argument("--reference", type=Path, default=Path("outputs/reference_felipe.wav"))
    parser.add_argument("--output", type=Path, default=Path("outputs/sample_felipe.wav"))
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--skip-prepare", action="store_true")
    parser.add_argument(
        "--discord-audio",
        action="store_true",
        help="Salva PCM 48 kHz estéreo, pronto para reprodução pelo bot.",
    )
    args = parser.parse_args()

    if args.prepare_only and args.skip_prepare:
        parser.error("--prepare-only e --skip-prepare não podem ser usados juntos")

    prompt_path = args.source if args.skip_prepare else args.reference
    if not args.skip_prepare:
        prepare_reference(args.source, args.reference)
        print(f"Referência preparada: {args.reference.resolve()}")
    if args.prepare_only:
        return

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"Dispositivo: {device}")

    model = load_model(device)
    with torch.inference_mode():
        audio = model.generate(
            args.text,
            language_id="pt",
            audio_prompt_path=str(prompt_path.resolve()),
            exaggeration=0.5,
            cfg_weight=0.4,
            temperature=0.8,
        )

        # Chatterbox returns an inference tensor. Keep normalization inside the
        # inference context; recent PyTorch versions reject an in-place update
        # to this tensor after leaving the context.
        audio = audio.cpu().float()
        peak = float(audio.abs().max())
        target_peak = 10 ** (-1.0 / 20.0)
        if peak > target_peak:
            audio.mul_(target_peak / peak)

    output_audio = audio.squeeze().numpy()
    output_rate = model.sr
    if args.discord_audio:
        output_audio = librosa.resample(output_audio, orig_sr=model.sr, target_sr=48_000)
        output_audio = np.column_stack((output_audio, output_audio))
        output_rate = 48_000

    args.output.parent.mkdir(parents=True, exist_ok=True)
    sf.write(args.output, output_audio, output_rate, subtype="PCM_16")
    print(f"Amostra gerada: {args.output.resolve()}")


if __name__ == "__main__":
    main()
