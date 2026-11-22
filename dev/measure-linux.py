"""Measure Linux startup to a visible window and session-free process memory under Xvfb."""

import argparse
import os
import subprocess
import tempfile
import time


def total_rss(root_pid):
    processes = [tuple(map(int, row.split())) for row in
                 subprocess.check_output(["ps", "-eo", "pid=,ppid=,rss="], text=True).splitlines()]
    descendants = {root_pid}
    while True:
        children = {pid for pid, parent, _ in processes if parent in descendants}
        if children <= descendants:
            return sum(rss for pid, _, rss in processes if pid in descendants)
        descendants.update(children)


def measure(binary):
    with tempfile.TemporaryDirectory(prefix="strata-measure-") as home:
        environment = dict(os.environ, STRATA_HOME=home, GDK_BACKEND="x11", WEBKIT_DISABLE_DMABUF_RENDERER="1")
        started = time.monotonic()
        process = subprocess.Popen([binary], env=environment, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL)
        try:
            while time.monotonic() - started < 12:
                if process.poll() is not None:
                    raise RuntimeError(f"Strata exited with status {process.returncode}")
                visible = subprocess.run(
                    ["xdotool", "search", "--onlyvisible", "--pid", str(process.pid), "--name", "^Strata$"],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
                ).returncode == 0
                if visible:
                    elapsed = (time.monotonic() - started) * 1000
                    time.sleep(1)
                    return elapsed, total_rss(process.pid) / 1024
                time.sleep(0.025)
            raise RuntimeError("Strata did not open a window")
        finally:
            if process.poll() is None:
                process.terminate()
            process.wait(timeout=10)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", help="Absolute path to the Strata executable or AppImage")
    parser.add_argument("--trials", type=int, default=3)
    options = parser.parse_args()
    for _ in range(options.trials):
        milliseconds, memory = measure(options.binary)
        print(f"Visible window {milliseconds:.0f} ms, session-free RSS {memory:.1f} MiB")


if __name__ == "__main__":
    main()
