import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import cover_pipeline as cover


class CoverPipelineTests(unittest.TestCase):
    def test_youtube_urls_are_canonical_and_bounded(self):
        expected = "https://www.youtube.com/watch?v=abcdefghijk"
        self.assertEqual(cover.youtube_url("https://youtu.be/abcdefghijk?t=10"), expected)
        for value in ("https://youtube.com.evil.test/watch?v=abcdefghijk", "file:///test.wav",
                      expected + "&list=PL123", "https://localhost/watch?v=abcdefghijk"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                cover.youtube_url(value)

    def test_normalize_checks_decoded_duration_and_disables_network(self):
        import soundfile as sf
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "out.wav"
            def fake_decode(args):
                self.assertIn("file,pipe", args)
                self.assertIn("-format_whitelist", args)
                sf.write(output, [0.1] * 44100 * 3, 44100)
            with patch.object(cover, "ffmpeg", side_effect=fake_decode):
                with self.assertRaisesRegex(ValueError, "entre 1 e 2"):
                    cover.normalize(Path(temp) / "input.mp3", output, 2)

    def test_youtube_download_is_really_converted_to_local_mp3_before_normalizing(self):
        import numpy as np
        import soundfile as sf
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            original = root / "fixture.wav"
            native = root / "youtube-download.m4a"
            sf.write(original, 0.2 * np.sin(2 * np.pi * 440 * np.arange(44100 * 2) / 44100), 44100)
            cover.ffmpeg(["-i", str(original), "-c:a", "aac", str(native)])
            with patch("yt_dlp.YoutubeDL") as factory:
                downloader = factory.return_value.__enter__.return_value
                downloader.extract_info.return_value = {"duration": 2}
                downloader.prepare_filename.return_value = str(native)
                result = cover.download_youtube("https://youtu.be/abcdefghijk", root, 300, 25 * 1024 * 1024)
                downloader.process_info.assert_called_once()
                self.assertTrue(factory.call_args.args[0]["noplaylist"])
            self.assertEqual(result, root / "youtube.mp3")
            self.assertGreater(result.stat().st_size, 0)
            # Real FFmpeg conversion, not a filename extension change.
            self.assertEqual(result.read_bytes()[:3], b"ID3")
            cover.normalize(result, root / "normalized.wav", 300)
            info = sf.info(root / "normalized.wav")
            self.assertEqual(info.samplerate, 44100)
            self.assertEqual(info.channels, 2)
            self.assertAlmostEqual(info.duration, 2, delta=0.1)

    def test_youtube_rejects_live_or_long_video_before_downloading_or_converting(self):
        for info in ({"duration": 301}, {"duration": 30, "is_live": True}, {"duration": None}):
            with self.subTest(info=info), tempfile.TemporaryDirectory() as temp:
                with patch("yt_dlp.YoutubeDL") as factory, patch.object(cover, "ffmpeg") as convert:
                    downloader = factory.return_value.__enter__.return_value
                    downloader.extract_info.return_value = info
                    with self.assertRaises(ValueError):
                        cover.download_youtube("https://youtu.be/abcdefghijk", Path(temp), 300, 1024)
                    downloader.process_info.assert_not_called()
                    convert.assert_not_called()

    def test_youtube_mp3_size_is_checked_after_conversion(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            native = root / "youtube-download.webm"
            native.write_bytes(b"input")
            with patch("yt_dlp.YoutubeDL") as factory, patch.object(cover, "ffmpeg") as convert:
                downloader = factory.return_value.__enter__.return_value
                downloader.extract_info.return_value = {"duration": 2}
                downloader.prepare_filename.return_value = str(native)
                convert.side_effect = lambda args: (root / "youtube.mp3").write_bytes(b"x" * 11)
                with self.assertRaisesRegex(ValueError, "MP3 local.*limite"):
                    cover.download_youtube("https://youtu.be/abcdefghijk", root, 300, 10)

    def test_mix_preserves_backing_length_and_discord_pcm_header(self):
        import numpy as np
        import soundfile as sf
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            # Different source lengths and sample rates exercise padding/resampling.
            sf.write(root / "v.wav", np.ones(22050, dtype=np.float32) * 0.8, 22050)
            sf.write(root / "i.wav", np.ones((88200, 2), dtype=np.float32) * 0.8, 44100)
            cover.mix(root / "v.wav", root / "i.wav", root / "out.wav")
            output, sr = sf.read(root / "out.wav")
            self.assertEqual(sr, 48000)
            self.assertEqual(output.shape, (96000, 2))
            self.assertLessEqual(np.max(np.abs(output)), 1)
            data = (root / "out.wav").read_bytes()
            self.assertEqual(data[36:40], b"data")
            self.assertEqual(len(data), 44 + 96000 * 4)


if __name__ == "__main__":
    unittest.main()
