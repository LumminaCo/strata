"""Measure a fresh Strata process using a restored editor and a local PostgreSQL fixture."""

import argparse
import ctypes
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import uuid

import psutil

ROOT = Path(__file__).resolve().parent.parent
MIGRATION = ROOT / "crates/strata-store/src/migrations/001.sql"
QUERY = """
SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS database_clock,
       i AS row_id, 'strata' AS label, i % 7 = 0 AS selected
FROM generate_series(1, 100000) AS i;
""".strip()


def seed_workspace(home, port, database, user):
    connection_id, tab_id = str(uuid.uuid4()), str(uuid.uuid4())
    (home / "config.toml").write_text(
        f"""version = 1

[[connection]]
id = "{connection_id}"
name = "Performance fixture"
kind = "postgres"
env = "dev"
host = "127.0.0.1"
port = {port}
database = {json.dumps(database)}
user = {json.dumps(user)}
secret = "env:STRATA_BENCHMARK_PG_PASSWORD"
read_only = true
tls = {{ mode = "disable" }}
""",
        encoding="utf-8",
    )
    workspace = {
        "tabs": [{"id": tab_id, "connectionId": connection_id, "text": QUERY}],
        "activeTab": tab_id,
    }
    with sqlite3.connect(home / "strata.db") as db:
        db.executescript(MIGRATION.read_text(encoding="utf-8"))
        db.execute("PRAGMA user_version = 1")
        db.execute("INSERT INTO workspace (id, payload) VALUES (1, ?)", (json.dumps(workspace),))


def postgres(bin_dir, *command, **kwargs):
    executable, *args = command
    suffix = ".exe" if sys.platform == "win32" else ""
    subprocess.run([str(bin_dir / (executable + suffix)), *args], check=True, timeout=60, **kwargs)


def start_fixture(bin_dir, root):
    cluster = root / "postgres"
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    with (root / "fixture.log").open("w+") as log:
        try:
            postgres(bin_dir, "initdb", "-D", str(cluster), "-U", "strata", "--auth=trust",
                     stdout=log, stderr=subprocess.STDOUT)
            postgres(bin_dir, "pg_ctl", "-D", str(cluster), "-l", str(root / "postgres.log"),
                     "-o", f"-h 127.0.0.1 -p {port}", "-w", "start",
                     stdout=log, stderr=subprocess.STDOUT)
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            log.seek(0)
            print(log.read(), file=sys.stderr)
            raise
    return port, cluster


def webkit_processes():
    return {
        item.pid for item in psutil.process_iter(["name", "username"])
        if "webkit." in (item.info["name"] or "").lower()
        and item.info["username"] == psutil.Process().username()
    }


def mac_footprint(pid):
    # RUSAGE_INFO_V0 contains a 16-byte UUID followed by ten uint64_t fields.
    class RusageInfo(ctypes.Structure):
        _fields_ = [
            ("uuid", ctypes.c_uint8 * 16),
            ("before_footprint", ctypes.c_uint64 * 7),
            ("footprint", ctypes.c_uint64),
            ("after_footprint", ctypes.c_uint64 * 2),
        ]

    data = RusageInfo()
    libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    if libproc.proc_pid_rusage(pid, 0, ctypes.byref(data)) != 0:
        raise OSError(ctypes.get_errno(), f"Could not measure PID {pid}")
    return data.footprint


def memory_sample(pid, prior_webkit):
    processes = [psutil.Process(pid)]
    processes.extend(processes[0].children(recursive=True))
    if sys.platform == "darwin":
        descendants = {process.pid for process in processes}
        webkit = webkit_processes() - prior_webkit
        if not webkit:
            raise RuntimeError("No WebKit processes were observed. Run on an otherwise idle desktop.")
        pids = descendants | webkit
        return "physical footprint", sum(mac_footprint(pid) for pid in pids), len(pids)
    if sys.platform == "win32":
        if not any("webview2" in process.name().lower() for process in processes[1:]):
            raise RuntimeError("No WebView2 processes were observed.")
        return "unique working set", sum(process.memory_full_info().uss for process in processes), len(processes)
    return "RSS", sum(process.memory_info().rss for process in processes), len(processes)


def wait_for(process, events_file, event):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        for line in events_file.read_text(encoding="utf-8").splitlines():
            try:
                sample = json.loads(line)
            except json.JSONDecodeError:
                continue
            if sample["event"] == "error":
                raise RuntimeError(sample["message"])
            if sample["event"] == event:
                return sample
        if process.poll() is not None:
            raise RuntimeError(f"Strata exited with status {process.returncode}")
        time.sleep(0.01)
    raise RuntimeError(f"Strata did not report {event}")


def measure(binary, home, args):
    home.mkdir()
    seed_workspace(home, args.port, args.database, args.user)
    events_file = home / "events.jsonl"
    events_file.touch()
    prior_webkit = webkit_processes() if sys.platform == "darwin" else set()
    env = dict(os.environ, STRATA_HOME=str(home), STRATA_BENCHMARK_LOG=str(events_file))
    if sys.platform == "win32":
        env["WEBVIEW2_USER_DATA_FOLDER"] = str(home / "webview")
    if sys.platform.startswith("linux"):
        env.update(GDK_BACKEND="x11", WEBKIT_DISABLE_DMABUF_RENDERER="1")

    with (home / "desktop.log").open("w+") as log:
        start = time.monotonic()
        process = subprocess.Popen([str(binary)], env=env, stdout=log, stderr=subprocess.STDOUT)
        try:
            editor = wait_for(process, events_file, "editor")
            startup = round((time.monotonic() - start) * 1_000)
            wait_for(process, events_file, "connected")
            time.sleep(2)
            metric, memory, count = memory_sample(process.pid, prior_webkit)
            first = wait_for(process, events_file, "firstRow")
            scroll = wait_for(process, events_file, "scroll")
        except Exception:
            log.seek(0)
            print(log.read(), file=sys.stderr)
            raise
        finally:
            if process.poll() is None:
                process.terminate()
            process.wait(timeout=15)

    return {
        "platform": sys.platform,
        "editor_ms": startup,
        "document_ready_ms": editor.get("documentReadyMs"),
        "navigation_to_editor_ms": editor.get("navigationToEditorMs"),
        "first_row_ms": first["ms"],
        "memory_metric": metric,
        "memory_bytes": memory,
        "processes": count,
        "scroll_median_ms": round(scroll["medianMs"], 2),
        "scroll_p95_ms": round(scroll["p95Ms"], 2),
        "scroll_max_ms": round(scroll["maxMs"], 2),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--trials", type=int, default=3)
    parser.add_argument("--pg-bin", type=Path, help="Start a disposable local PostgreSQL cluster")
    parser.add_argument("--port", type=int, default=15432)
    parser.add_argument("--database", default="pagila")
    parser.add_argument("--user", default="postgres")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="strata-benchmark-") as directory:
        root = Path(directory)
        cluster = None
        if args.pg_bin:
            args.port, cluster = start_fixture(args.pg_bin, root)
            args.database, args.user = "postgres", "strata"
            os.environ["STRATA_BENCHMARK_PG_PASSWORD"] = "local-benchmark"
        try:
            for index in range(args.trials):
                sample = measure(args.binary.resolve(strict=True), root / str(index), args)
                print(json.dumps(sample), flush=True)
        finally:
            if cluster:
                postgres(args.pg_bin, "pg_ctl", "-D", str(cluster), "-m", "fast", "-w", "stop",
                         stdout=sys.stderr)


if __name__ == "__main__":
    main()
