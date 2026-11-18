"""Copy podcast feeds that block web apps into the site, so Podplayer can read them same-origin.

Run by .github/workflows/pages.yml. Feeds come from mirror/feeds.txt plus open GitHub issues
titled "mirror: <feed url>" opened by the repo owner. Writes <out>/mirror/<key>.xml and
<out>/mirror/index.json ({feed url: {file, fetched}}). The key must match feedKey() in js/net.js.
"""
import hashlib
import json
import os
import re
import sys
import time
import urllib.request

OUT = sys.argv[1] if len(sys.argv) > 1 else '_site'
REPO = os.environ.get('GITHUB_REPOSITORY', '')
TOKEN = os.environ.get('GITHUB_TOKEN', '')
OWNER = REPO.split('/')[0] if REPO else ''
UA = 'Podplayer feed mirror (+https://github.com/robrice/podplayer)'
MAX_BYTES = 20_000_000


def feed_key(url):
    return hashlib.sha256(url.encode()).hexdigest()[:20]


def gh(path, method='GET', body=None):
    req = urllib.request.Request(f'https://api.github.com/repos/{REPO}{path}', method=method,
                                 data=json.dumps(body).encode() if body else None,
                                 headers={'Authorization': f'Bearer {TOKEN}', 'Accept': 'application/vnd.github+json',
                                          'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r) if r.status != 204 else None


def requested_feeds():
    """Feeds from the list file and from the owner's open 'mirror:' issues -> {url: issue or None}."""
    feeds = {}
    path = os.path.join(os.path.dirname(__file__), '..', 'mirror', 'feeds.txt')
    if os.path.exists(path):
        for line in open(path):
            line = line.strip()
            if line and not line.startswith('#'):
                feeds[line] = None
    if REPO and TOKEN:
        for issue in gh('/issues?state=open&per_page=100'):
            m = re.match(r'\s*mirror:\s*(https?://\S+)', issue['title'], re.I)
            if m and issue['user']['login'] == OWNER and 'pull_request' not in issue:
                feeds[m.group(1)] = issue
    return feeds


def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/rss+xml, application/xml, text/xml, */*'})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError('feed too large')
    if not re.search(rb'<(rss|feed)[\s>]', data[:5000], re.I):
        raise ValueError('not a podcast feed')
    return data


def main():
    os.makedirs(os.path.join(OUT, 'mirror'), exist_ok=True)
    index = {}
    for url, issue in requested_feeds().items():
        try:
            data = fetch(url)
        except Exception as e:  # keep going; report on the issue
            print(f'FAIL {url}: {e}')
            if issue and not has_label(issue, 'mirror-failed'):
                comment(issue, f"Couldn't fetch this feed: {e}. It will keep retrying every 30 minutes.")
                add_label(issue, 'mirror-failed')
            continue
        key = feed_key(url)
        open(os.path.join(OUT, 'mirror', f'{key}.xml'), 'wb').write(data)
        index[url] = {'file': f'{key}.xml', 'fetched': int(time.time())}
        print(f'ok   {url} ({len(data)} bytes)')
        if issue and not has_label(issue, 'mirrored'):
            comment(issue, 'Mirrored. Podplayer can load this show now; it refreshes every 30 minutes. Keep this issue open to keep it mirrored, close it to stop.')
            add_label(issue, 'mirrored')
    json.dump(index, open(os.path.join(OUT, 'mirror', 'index.json'), 'w'), indent=0)
    print(f'{len(index)} feeds mirrored')


def has_label(issue, name):
    return any(l['name'] == name for l in issue.get('labels', []))


def add_label(issue, name):
    try:
        gh(f"/issues/{issue['number']}/labels", 'POST', {'labels': [name]})
    except Exception as e:
        print('label failed', e)


def comment(issue, text):
    try:
        gh(f"/issues/{issue['number']}/comments", 'POST', {'body': text})
    except Exception as e:
        print('comment failed', e)


if __name__ == '__main__':
    main()
