# mlb/tests/conftest.py
import os, sys
# Put mlb/ on sys.path so tests can import `configs`, `src`, etc.
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
