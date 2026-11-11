"""Run each sport's offline unit tests in a separate import namespace."""
from pathlib import Path
import os
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]

if __name__ == "__main__":
    env = os.environ.copy()
    env["PYTHONPATH"] = str(ROOT)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    for sport in ("mlb", "pga", "nba", "nfl"):
        print(f"\n{sport.upper()} — synthetic offline unit tests", flush=True)
        subprocess.run(
            [sys.executable, "-m", "pytest", "-q", "--disable-socket", "-p", "no:cacheprovider",
             str(ROOT / sport / "tests")],
            cwd=ROOT, env=env, check=True,
        )
