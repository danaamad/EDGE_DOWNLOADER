import json
import logging
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
import yt_dlp

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

PORT = 5000
DOWNLOAD_DIR = r"C:\Users\David Naamad\Downloads"
MAX_BODY_SIZE = 10_000
SOCKET_TIMEOUT = 15

ALLOWED_ORIGIN = None

downloads_status = {}
status_lock = threading.Lock()
download_executor = ThreadPoolExecutor(max_workers=1)


def format_size(bytes_val):
    if not bytes_val or bytes_val <= 0:
        return ""
    mb = bytes_val / (1024 * 1024)
    if mb >= 1024:
        return f"{mb / 1024:.2f} GB"
    return f"{mb:.1f} MB"


def is_valid_format_id(fid):
    allowed_presets = ("best", "worst", "1080p", "720p", "480p", "360p", "audio_only")
    if fid in allowed_presets:
        return True
    return bool(re.fullmatch(r"[\w.+-]{1,32}", fid))


def cleanup_stale_statuses():
    while True:
        time.sleep(300)
        cutoff = time.time() - 3600
        with status_lock:
            stale_keys = [
                u for u, s in downloads_status.items()
                if s.get("status") in ("finished", "error") and s.get("ts", 0) < cutoff
            ]
            for u in stale_keys:
                del downloads_status[u]


threading.Thread(target=cleanup_stale_statuses, daemon=True).start()


def progress_hook_factory(video_url):
    def hook(d):
        with status_lock:
            now = time.time()
            if d['status'] == 'downloading':
                total = d.get('total_bytes') or d.get('total_bytes_estimate') or 0
                downloaded = d.get('downloaded_bytes', 0)
                
                frag_index = d.get('fragment_index')
                frag_count = d.get('fragment_count')

                if frag_index and frag_count:
                    percent = (frag_index / frag_count) * 100
                elif total > 0:
                    percent = (downloaded / total) * 100
                else:
                    percent = 0

                speed = d.get('speed')
                eta = d.get('eta')

                downloads_status[video_url] = {
                    "status": "downloading",
                    "percent": round(percent, 1),
                    "speed": f"{speed / 1024 / 1024:.1f} MB/s" if speed else "",
                    "eta": f"{eta}s" if eta else "",
                    "ts": now
                }
            elif d['status'] == 'finished':
                downloads_status[video_url] = {
                    "status": "finished",
                    "percent": 100,
                    "speed": "",
                    "eta": "",
                    "ts": now
                }
    return hook


def run_download(url, format_id, referer):
    try:
        page_referer = referer if (referer and referer.startswith("http")) else "https://gastro.doctorsonly.co.il/"

        http_headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Referer': page_referer,
            'Origin': 'https://gastro.doctorsonly.co.il'
        }

        out_template = os.path.join(DOWNLOAD_DIR, '%(title)s [%(id)s].%(ext)s')

        ydl_opts = {
            'outtmpl': out_template,
            'progress_hooks': [progress_hook_factory(url)],
            'http_headers': http_headers,
            'socket_timeout': 30,
            'retries': 10,
            'fragment_retries': 10,
            'skip_unavailable_fragments': True,
            'overwrites': True,
            'no_warnings': True,
            'windowsfilenames': True,
            'check_formats': False,
            'merge_output_format': 'mp4'
        }

        # תצורת פורמטים חסינת תקלות (Sorting במקום Filtering קשיח)
        # שימוש ב-bv*/ba* (עם כוכבית) ולא bestvideo/bestaudio - חובה עבור
        # embeds כמו Vimeo שחושפים סטרימים עם קודק/קונטיינר לא "סטנדרטי";
        # בלי הכוכבית yt-dlp מסנן אותם מראש וזורק "Requested format is not available"
        if format_id == 'audio_only':
            ydl_opts['format'] = 'ba*/b'
            ydl_opts['postprocessors'] = [{
                'key': 'FFmpegExtractAudio',
                'preferredcodec': 'mp3',
                'preferredquality': '192',
            }]
        elif format_id in ('1080p', '720p', '480p', '360p'):
            max_height = int(format_id.replace('p', ''))
            ydl_opts['format'] = (
                f'bv*[height<={max_height}]+ba*/b[height<={max_height}]/bv*+ba*/b'
            )
            ydl_opts['format_sort'] = ['res', 'fps', 'hdr:12', 'br']
        elif format_id == 'worst':
            ydl_opts['format'] = 'wv*+wa/w'
            ydl_opts['format_sort'] = ['+res', '+br']
        elif format_id and format_id not in ('best', 'default'):
            # אם נבחר מזהה ספציפי מהרשימה הנשלפת
            ydl_opts['format'] = f"{format_id}/b/best"
        else:
            ydl_opts['format'] = 'bv*+ba*/b'
            # res חייב להיות ראשון - אחרת ie_pref (העדפת האתר) יכולה
            # לבחור סטרים "מועדף" שמוגבל ל-720p על פני סטרים באיכות גבוהה יותר
            ydl_opts['format_sort'] = ['res', 'fps', 'hdr:12', 'br']

        logging.info("[*] מתחיל טיפול בהורדה: %s (איכות: %s)", url, format_id)
        
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])

        with status_lock:
            downloads_status[url] = {
                "status": "finished",
                "percent": 100,
                "speed": "",
                "eta": "",
                "ts": time.time()
            }
        logging.info("[+] הסרטון הושלם בהצלחה: %s", url)

    except Exception as e:
        logging.error("[-] שגיאה בהורדת %s: %s", url, e)
        with status_lock:
            downloads_status[url] = {
                "status": "error",
                "error": str(e),
                "ts": time.time()
            }


class DownloadHandler(BaseHTTPRequestHandler):
    def _is_valid_origin(self):
        origin = self.headers.get("Origin", "")
        if ALLOWED_ORIGIN:
            return origin == ALLOWED_ORIGIN
        return origin.startswith("chrome-extension://")

    def _set_headers(self, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        origin = self.headers.get("Origin")
        if origin and self._is_valid_origin():
            self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def _send_json_error(self, status_code, message):
        self._set_headers(status_code)
        self.wfile.write(json.dumps({"error": message}).encode("utf-8"))

    def do_OPTIONS(self):
        self._set_headers(200)

    def do_GET(self):
        if not self._is_valid_origin():
            self.send_response(403)
            self.end_headers()
            return

        if self.path == "/status":
            with status_lock:
                current_status = dict(downloads_status)
            self._set_headers(200)
            self.wfile.write(json.dumps(current_status).encode("utf-8"))
        else:
            self._set_headers(404)

    def do_POST(self):
        if not self._is_valid_origin():
            self.send_response(403)
            self.end_headers()
            return

        try:
            content_length = int(self.headers.get("Content-Length", 0))
        except (TypeError, ValueError):
            self._send_json_error(400, "Invalid Content-Length")
            return

        if content_length <= 0 or content_length > MAX_BODY_SIZE:
            self._send_json_error(400, "Invalid request size")
            return

        try:
            raw_body = self.rfile.read(content_length)
            data = json.loads(raw_body.decode("utf-8"))
        except Exception:
            self._send_json_error(400, "Invalid JSON")
            return

        routes = {
            "/formats": self.handle_formats,
            "/download": self.handle_download
        }

        handler = routes.get(self.path)
        if handler:
            handler(data)
        else:
            self._set_headers(404)

    def handle_formats(self, data):
        url = data.get("url")
        referer = data.get("referer", "")

        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            self._send_json_error(400, "Invalid URL scheme")
            return

        try:
            ydl_opts = {
                'quiet': True,
                'no_warnings': True,
                'socket_timeout': SOCKET_TIMEOUT
            }
            if referer:
                ydl_opts['http_headers'] = {'Referer': referer}

            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)
                duration = info.get('duration', 0)
                formats = info.get('formats', [])

                parsed_formats = []
                seen = set()

                for f in reversed(formats):
                    if f.get('vcodec') == 'none' or not f.get('height'):
                        continue

                    h = f.get('height')
                    w = f.get('width')
                    ext = f.get('ext', 'mp4').upper()
                    fid = f.get('format_id')
                    tbr = f.get('tbr') or f.get('vbr') or 0

                    key = (ext, h)
                    if key in seen:
                        continue
                    seen.add(key)

                    size_bytes = f.get('filesize') or f.get('filesize_approx')
                    if not size_bytes and tbr and duration:
                        size_bytes = (tbr * 1000 / 8) * duration

                    size_str = format_size(size_bytes)
                    bitrate_str = f"{tbr:.0f} kbps" if tbr else ""

                    label_parts = [f"{ext} - {w}x{h}" if w else f"{ext} - {h}p"]
                    meta_parts = []
                    if size_str:
                        meta_parts.append(size_str)
                    if bitrate_str:
                        meta_parts.append(bitrate_str)

                    label = f"{label_parts[0]} ({', '.join(meta_parts)})" if meta_parts else label_parts[0]

                    parsed_formats.append({
                        "format_id": fid,
                        "label": label,
                        "height": h
                    })

                parsed_formats.append({
                    "format_id": "audio_only",
                    "label": "MP3 - אודיו בלבד",
                    "height": 0
                })

            self._set_headers(200)
            self.wfile.write(json.dumps({"formats": parsed_formats}).encode("utf-8"))
        except Exception:
            logging.exception("Error extracting formats for %s", url)
            self._send_json_error(500, "Internal server error")

    def handle_download(self, data):
        url = data.get("url")
        referer = data.get("referer", "")
        format_id = data.get("format_id", "best")

        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            self._send_json_error(400, "Invalid URL scheme")
            return

        if not is_valid_format_id(format_id):
            self._send_json_error(400, "Invalid format_id")
            return

        with status_lock:
            downloads_status[url] = {
                "status": "downloading",
                "percent": 0,
                "speed": "מתחיל...",
                "eta": "",
                "ts": time.time()
            }

        download_executor.submit(run_download, url, format_id, referer)
        self._set_headers(200)
        self.wfile.write(json.dumps({"status": "started"}).encode("utf-8"))


if __name__ == "__main__":
    os.makedirs(DOWNLOAD_DIR, exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", PORT), DownloadHandler)
    logging.info("Server running at http://127.0.0.1:%s", PORT)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logging.info("Shutting down server...")
        download_executor.shutdown(wait=False)
        server.server_close()