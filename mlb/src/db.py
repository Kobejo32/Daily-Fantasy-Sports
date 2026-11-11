"""Supabase client helper."""
import os

_client = None

def get_sb():
    global _client
    if _client is None:
        url = os.getenv('SUPABASE_URL', '')
        key = os.getenv('SUPABASE_SERVICE_KEY', '')
        if not url or not key:
            raise RuntimeError('Set SUPABASE_URL and SUPABASE_SERVICE_KEY for this optional integration.')
        from supabase import create_client
        _client = create_client(url, key)
    return _client
