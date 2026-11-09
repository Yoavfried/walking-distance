"""Build a pinned regional walking graph before packaging the function."""

import hashlib
import json
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import tarfile
from tempfile import TemporaryDirectory
from urllib.request import urlopen
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parent
ENGINE = ROOT / "engine"
PBF = "https://download.geofabrik.de/asia/israel-and-palestine-261108.osm.pbf"
PBF_SHA256 = "836dfa178d5de89d7b12e6cfe27f9b37d6de984c8c65753a7156cada44fc1f7c"


def download(url, path, sha256):
    digest = hashlib.sha256()
    with urlopen(url, timeout=90) as response, path.open("wb") as out:
        for chunk in iter(lambda: response.read(1024 * 1024), b""):
            digest.update(chunk)
            out.write(chunk)
    if digest.hexdigest() != sha256:
        raise RuntimeError("Downloaded file checksum did not match")


def clean_config(value, optional_type):
    return {
        key: clean_config(item, optional_type) if isinstance(item, dict) else item
        for key, item in value.items() if not isinstance(item, optional_type)
    }


def main():
    ENGINE.mkdir(exist_ok=True)
    tiles = ENGINE / "tiles"
    tiles.mkdir(exist_ok=True)
    with TemporaryDirectory(prefix="walking-graph-") as temp:
        temp = Path(temp)
        with urlopen("https://pypi.org/pypi/pyvalhalla/3.9.1/json", timeout=30) as response:
            release = json.load(response)
        wheel = next(item for item in release["urls"]
                     if item["filename"].endswith("cp312-abi3-manylinux_2_28_x86_64.whl"))
        download(wheel["url"], temp / "runtime.whl", wheel["digests"]["sha256"])
        with ZipFile(temp / "runtime.whl") as archive:
            for member in archive.namelist():
                if member.startswith("pyvalhalla.libs/") or member in (
                    "valhalla/bin/valhalla_build_tiles", "valhalla/bin/valhalla_service",
                    "valhalla/valhalla_build_config.py",
                ):
                    archive.extract(member, temp)
        libs = temp / "pyvalhalla.libs"
        bin_dir = temp / "valhalla/bin"
        build = bin_dir / "valhalla_build_tiles"
        service = ENGINE / "valhalla_service"
        shutil.move(str(bin_dir / "valhalla_service"), service)
        for executable in (build, service):
            executable.chmod(0o755)
        defaults = runpy.run_path(str(temp / "valhalla/valhalla_build_config.py"))
        config = clean_config(defaults["config"], defaults["Optional"])
        config["mjolnir"].update(
            tile_dir=str(tiles), tile_extract="", concurrency=2, include_driving=False,
            include_bicycle=False, include_pedestrian=True, hierarchy=False, shortcuts=False,
            admin="", timezone="", transit_dir="", traffic_extract="",
        )
        config["logging"].update(type="", color=False)
        build_config = temp / "build.json"
        build_config.write_text(json.dumps(config), encoding="utf-8")
        pbf = temp / "source.osm.pbf"
        download(PBF, pbf, PBF_SHA256)
        env = {**os.environ, "LD_LIBRARY_PATH": str(libs)}
        subprocess.run([str(build), "-c", str(build_config), str(pbf)], env=env, check=True, timeout=300)
        config["mjolnir"]["tile_dir"] = "tiles"
        config["mjolnir"]["concurrency"] = 1
        (ENGINE / "valhalla.json").write_text(json.dumps(config), encoding="utf-8")
        config["mjolnir"]["tile_dir"] = str(tiles)
        build_config.write_text(json.dumps(config), encoding="utf-8")
        req = {"locations": [{"lon": 34.7748, "lat": 32.0776}], "costing": "pedestrian",
               "contours": [{"time": 30}], "format": "geotiff"}
        sample = subprocess.check_output(
            [str(service), str(build_config), "isochrone", json.dumps(req)], env=env, timeout=10
        )
        if sample[:4] not in (b"II*\x00", b"MM\x00*"):
            raise RuntimeError("Linux build did not return a valid GeoTIFF header")
        print("Linux build check: valid GeoTIFF", flush=True)
        with tarfile.open(ENGINE / "lib.tar.gz", "w:gz", compresslevel=6) as archive:
            for path in sorted(libs.iterdir()):
                archive.add(path, arcname=path.name)
    size = sum(p.stat().st_size for p in ENGINE.rglob("*") if p.is_file())
    print("Packaged engine and graph: %d bytes" % size, flush=True)
    if size >= 240_000_000:
        raise RuntimeError("Routing bundle exceeded the preview's size budget")


if __name__ == "__main__":
    main()
