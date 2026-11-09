"""Fixed pedestrian routing endpoint. Keep the deployment protected by Vercel."""

import fcntl
import json
import math
import os
from pathlib import Path
import subprocess
import tarfile

ENGINE = Path(__file__).resolve().parents[1] / "engine"
LIBS = Path("/tmp/walking-valhalla-3.9.1")
ENV = {"PATH": os.defpath, "LD_LIBRARY_PATH": str(LIBS)}
TIFF_SIGNATURES = (b"II*\x00", b"MM\x00*")


def prepare_runtime():
    LIBS.mkdir(exist_ok=True)
    ready = LIBS / ".complete"
    if ready.exists():
        return
    with (LIBS / ".lock").open("ab") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if not ready.exists():
            with tarfile.open(ENGINE / "lib.tar.gz") as archive:
                archive.extractall(LIBS, filter="data")
            ready.touch()


def reply(start_response, status, body, kind="text/plain"):
    start_response(status, [
        ("Content-Type", kind), ("Content-Length", str(len(body))),
        ("Cache-Control", "no-store"), ("X-Content-Type-Options", "nosniff"),
    ])
    return [body]


def app(environ, start_response):
    if environ["PATH_INFO"] != "/api/grid":
        return reply(start_response, "404 Not Found", b"Not found")
    if environ["REQUEST_METHOD"] != "POST":
        return reply(start_response, "405 Method Not Allowed", b"Use POST")
    try:
        length = int(environ.get("CONTENT_LENGTH") or 0)
        if not 0 < length <= 256:
            raise ValueError()
        data = json.loads(environ["wsgi.input"].read(length))
        lon, lat = data["lon"], data["lat"]
        if any(type(v) not in (int, float) or not math.isfinite(v) for v in (lon, lat)):
            raise ValueError()
        if not (34.16 <= lon <= 35.92 and 29.45 <= lat <= 33.36):
            raise ValueError()
    except (ValueError, TypeError, KeyError, OverflowError):
        return reply(start_response, "400 Bad Request", b"Expected a point inside the map")
    req = {"locations": [{"lon": lon, "lat": lat}], "costing": "pedestrian",
           "contours": [{"time": 30}], "format": "geotiff"}
    try:
        prepare_runtime()
        output = subprocess.run(
            [str(ENGINE / "valhalla_service"), str(ENGINE / "valhalla.json"), "isochrone", json.dumps(req)],
            env=ENV, cwd=ENGINE, capture_output=True, timeout=8,
        )
    except (OSError, tarfile.TarError, subprocess.TimeoutExpired):
        return reply(start_response, "502 Bad Gateway", b"Routing engine unavailable")
    if output.returncode or output.stdout[:4] not in TIFF_SIGNATURES:
        return reply(start_response, "422 Unprocessable Entity", b"No walking grid")
    return reply(start_response, "200 OK", output.stdout, "image/tiff")
