"""Scoped, authenticated MCP services for the NV Chat pilot.

Run separate instances for workspace, docker and comfy. User code is executed
only by the workspace service, under a different UID from its supervisor.
"""
from __future__ import annotations

import base64
import argparse
import contextlib
import ctypes
import difflib
import fcntl
import hashlib
import hmac
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path, PurePosixPath
import re
import resource
import signal
import socket
import sqlite3
import stat
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import urlencode, urlsplit
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
import uuid

MAX_FILE = 256 * 1024
MAX_REQUEST = 1024 * 1024
MAX_GIT_OUTPUT = 128 * 1024
RUN_UID, RUN_GID = 10001, 1000
DENIED_PARTS = {'.git', '.ssh', '.config', '.nv-chat'}
SAFE_DOTFILES = {'.gitignore', '.dockerignore', '.editorconfig', '.gitattributes'}
GIT_COMMON_ARGS = [
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false',
    '-c', 'core.pager=cat',
    '-c', 'credential.helper=',
    '-c', 'fetch.recurseSubmodules=false',
    '-c', 'submodule.recurse=false',
]
GIT_TOKEN_FILES = {
    'github': '/run/secrets/github.token',
    'gitlab': '/run/secrets/gitlab.token',
}


def protected_workspace_part(part):
    if part in DENIED_PARTS or part.startswith(('.env', '.nv-chat-')):
        return True
    if os.environ.get('WORKSPACE_PERSONAL_FILES') != 'true':
        return False
    # A personal home includes browser profiles, agent credentials and private
    # recovery copies. This file-only deployment excludes those areas and has
    # no configured command runner. Never permit links to bypass these rules.
    lower = part.lower()
    return ((part.startswith('.') and part not in SAFE_DOTFILES)
            or lower in {'snap', 'vpn-workspaces', 'runtime.env', 'id_rsa', 'id_ed25519',
                         'credentials', 'credentials.json', 'secrets', 'secrets.json'}
            or 'recovery' in lower or 'backup' in lower
            or lower.endswith(('.env', '.pem', '.key', '.p12', '.pfx')))
PROTOCOL_VERSIONS = ('2025-11-25', '2025-06-18', '2025-03-26')
MAX_RUN_FILE = 8 * 1024 * 1024


class ToolError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def private_bytes(filename, limit=MAX_REQUEST):
    if not isinstance(filename, (str, Path)) or not Path(filename).is_absolute():
        raise ValueError('A private absolute configuration file is required')
    try:
        fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > limit:
                raise ValueError()
            body = handle.read(limit + 1)
            if not body or len(body) > limit:
                raise ValueError()
            return body
    except (OSError, ValueError):
        raise ValueError('A valid private configuration file is required') from None


def private_json(filename):
    try:
        return json.loads(private_bytes(filename))
    except (ValueError, UnicodeError):
        raise ValueError('Private configuration is invalid') from None


def validate_relative(name, allow_root=False):
    if not isinstance(name, str) or len(name) > 512 or '\\' in name or '\x00' in name:
        raise ToolError('invalid_path', 'Use a relative workspace path')
    if allow_root and name in ('', '.'):
        return ()
    parts = name.split('/')
    if any(p in ('', '.', '..') or protected_workspace_part(p) for p in parts):
        raise ToolError('invalid_path', 'That path is outside the allowed workspace files')
    return tuple(parts)


@contextlib.contextmanager
def directory_fd(root, parts=()):
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd
    except (NotADirectoryError, OSError) as exc:
        if isinstance(exc, ToolError):
            raise
        raise ToolError('invalid_path', 'Path is unavailable or contains a symlink') from None
    finally:
        os.close(fd)


def read_file(root, name, missing_ok=False):
    parts = validate_relative(name)
    with directory_fd(root, parts[:-1]) as parent:
        try:
            fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        except FileNotFoundError:
            if missing_ok:
                return None
            raise ToolError('not_found', 'Workspace file not found') from None
        except OSError:
            raise ToolError('invalid_path', 'File is unavailable or is a symlink') from None
        with os.fdopen(fd, 'rb') as handle:
            info = os.fstat(handle.fileno())
            if os.environ.get('WORKSPACE_PERSONAL_FILES') == 'true' and info.st_nlink != 1:
                raise ToolError('invalid_path', 'Hard-linked files are unavailable in personal workspaces')
            if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_FILE:
                raise ToolError('file_limit', 'Only regular text files up to 256 KiB are supported')
            try:
                body = handle.read(MAX_FILE + 1)
                if len(body) > MAX_FILE:
                    raise ToolError('file_limit', 'Only regular text files up to 256 KiB are supported')
                return body.decode('utf-8')
            except UnicodeDecodeError:
                raise ToolError('file_type', 'Only UTF-8 text files are supported') from None


def digest(content):
    return hashlib.sha256(content.encode()).hexdigest() if content is not None else 'missing'


def verify_token(header, secret, audience, now=None):
    now = time.time() if now is None else now
    try:
        if not isinstance(header, str) or len(header) > 8192:
            raise ValueError()
        scheme, token = header.split(' ', 1)
        payload, signature = token.split('.')
        expected = base64.urlsafe_b64encode(hmac.new(secret, payload.encode(), hashlib.sha256).digest()).rstrip(b'=').decode()
        if scheme != 'Bearer' or not hmac.compare_digest(signature, expected):
            raise ValueError()
        claims = json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)))
        if claims['iss'] != 'nv-chat' or claims['aud'] != audience:
            raise ValueError()
        if not isinstance(claims, dict) or not isinstance(claims['exp'], (int, float)) or isinstance(claims['exp'], bool):
            raise ValueError()
        if not now < claims['exp'] <= now + 125 or not isinstance(claims['email'], str):
            raise ValueError()
        uuid.UUID(claims['sub'])
        claims['email'] = claims['email'].strip().lower()
        if not re.fullmatch(r'[^\s@]+@[^\s@]+', claims['email']):
            raise ValueError()
        return claims
    except (ValueError, KeyError, TypeError, AttributeError):
        raise ToolError('unauthorized', 'A valid service credential is required') from None


class State:
    def __init__(self, root):
        Path(root).mkdir(mode=0o700, parents=True, exist_ok=True)
        # Named volumes copy the image's UID1000 ownership for Comfy. A root
        # supervisor must own its state before applying 0700, so user code
        # cannot rewrite pending patches or generation ownership records.
        with directory_fd(root) as root_fd:
            if os.geteuid() == 0:
                os.fchown(root_fd, 0, 0)
            os.fchmod(root_fd, 0o700)
            self.lock_fd = os.open('service.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=root_fd)
            try:
                if not stat.S_ISREG(os.fstat(self.lock_fd).st_mode):
                    raise ValueError('State lock must be a regular file')
                if os.geteuid() == 0:
                    os.fchown(self.lock_fd, 0, 0)
                os.fchmod(self.lock_fd, 0o600)
                fcntl.flock(self.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except (OSError, ValueError):
                os.close(self.lock_fd)
                raise ValueError('Tool state is in use or unavailable; stop the existing adapter before reconciliation') from None
            fd = os.open('state.sqlite', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=root_fd)
            try:
                if not stat.S_ISREG(os.fstat(fd).st_mode):
                    raise ValueError('State database must be a regular file')
                if os.geteuid() == 0:
                    os.fchown(fd, 0, 0)
                os.fchmod(fd, 0o600)
            finally:
                os.close(fd)
        self.db = sqlite3.connect(str(Path(root) / 'state.sqlite'), check_same_thread=False)
        self.lock = threading.RLock()
        self.db.execute('CREATE TABLE IF NOT EXISTS objects (id TEXT NOT NULL, owner TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(id,owner,kind))')
        # Upgrade the initial pilot schema without allowing one account's
        # idempotency key to overwrite another account's object.
        columns = self.db.execute('PRAGMA table_info(objects)').fetchall()
        if [row[1] for row in columns if row[5]] == ['id']:
            self.db.execute('ALTER TABLE objects RENAME TO objects_old')
            self.db.execute('CREATE TABLE objects (id TEXT NOT NULL, owner TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(id,owner,kind))')
            self.db.execute('INSERT INTO objects SELECT * FROM objects_old')
            self.db.execute('DROP TABLE objects_old')
        self.db.commit()

    def close(self):
        self.db.close()
        if self.lock_fd is not None:
            os.close(self.lock_fd)
            self.lock_fd = None

    def put(self, key, owner, kind, body):
        self.put_many([(key, owner, kind, body)])

    def put_many(self, values):
        with self.lock:
            with self.db:
                self.db.executemany('INSERT OR REPLACE INTO objects VALUES (?,?,?,?)',
                                    [(key, owner, kind, json.dumps(body)) for key, owner, kind, body in values])

    def delete(self, key, owner, kind):
        with self.lock, self.db:
            self.db.execute('DELETE FROM objects WHERE id=? AND owner=? AND kind=?', (key, owner, kind))

    def get(self, key, owner, kind):
        with self.lock:
            row = self.db.execute('SELECT body FROM objects WHERE id=? AND owner=? AND kind=?', (key, owner, kind)).fetchone()
        if row is None:
            raise ToolError('not_found', 'This resource is unavailable to your account')
        return json.loads(row[0])


class DockerConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect('/var/run/docker.sock')


def docker_request(method, path):
    conn = DockerConnection('localhost', timeout=30)
    try:
        conn.request(method, path)
        response = conn.getresponse()
        body = response.read(MAX_REQUEST)
        if response.status not in (200, 201, 204, 304):
            raise ToolError('docker_unavailable', 'The assigned container operation could not complete')
        return json.loads(body) if body else {}
    finally:
        conn.close()


def workspace_exec(command):
    # This is a fresh isolated Python interpreter, never a threaded preexec_fn.
    # Popen already dropped credentials using its C-level user/group options.
    if os.geteuid() != RUN_UID or os.getegid() != RUN_GID or os.getgroups():
        raise RuntimeError('Workspace execution requires its isolated identity')
    apply_workspace_limits()
    os.execvpe(command[0], command, os.environ)


def apply_workspace_limits():
    if ctypes.CDLL(None, use_errno=True).prctl(38, 1, 0, 0, 0) != 0:
        raise RuntimeError('Cannot set no_new_privs')
    for name, limit in ((resource.RLIMIT_CPU, 30), (resource.RLIMIT_FSIZE, MAX_RUN_FILE),
                        (resource.RLIMIT_NPROC, 32), (resource.RLIMIT_NOFILE, 128),
                        (resource.RLIMIT_AS, 1024 * 1024 * 1024), (resource.RLIMIT_CORE, 0)):
        resource.setrlimit(name, (limit, limit))


def stop_workspace_processes():
    # This service has its own PID namespace and serializes checks. Kill the
    # dedicated execution UID, including children that escaped the process group.
    for _ in range(5):
        found = False
        for entry in Path('/proc').iterdir():
            if not entry.name.isdecimal():
                continue
            try:
                status = (entry / 'status').read_text()
                uid = re.search(r'^Uid:\s+(\d+)', status, re.MULTILINE)
                if uid and int(uid[1]) == RUN_UID:
                    os.kill(int(entry.name), signal.SIGKILL)
                    found = True
            except (FileNotFoundError, ProcessLookupError):
                continue
        if not found:
            return
        time.sleep(0.02)


def canonical_git_remote(remote):
    """Accept only the two assigned Git forges and return HTTPS credentials routing."""
    if not isinstance(remote, str) or len(remote) > 1024 or any(c in remote for c in '\r\n\0'):
        raise ToolError('git_remote_denied', 'The repository remote is unsupported')
    patterns = (
        ('github', 'github.com', r'(?:git@github\.com:|ssh://git@github\.com/|https://github\.com/)([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+?)(?:\.git)?'),
        ('gitlab', 'gitlab-master.nvidia.com', r'(?:ssh://(?:git@)?gitlab-master\.nvidia\.com(?::12051)?/|https://gitlab-master\.nvidia\.com/)([A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+?)(?:\.git)?'),
    )
    for provider, host, pattern in patterns:
        match = re.fullmatch(pattern, remote)
        if match:
            repository = match.group(1)
            if repository.endswith('.git'):
                repository = repository[:-4]
            return provider, f'https://{host}/{repository}.git'
    raise ToolError('git_remote_denied', 'Only assigned GitHub and NVIDIA GitLab remotes are allowed')


def git_token_configured(provider):
    filename = GIT_TOKEN_FILES[provider]
    try:
        info = os.stat(filename, follow_symlinks=False)
        return stat.S_ISREG(info.st_mode) and info.st_size >= 16 and not info.st_mode & 0o077
    except OSError:
        return False


def git_environment(provider=None):
    env = {
        'GIT_CONFIG_GLOBAL': '/dev/null',
        'GIT_CONFIG_NOSYSTEM': '1',
        'GIT_EDITOR': 'true',
        'GIT_PAGER': 'cat',
        'GIT_SEQUENCE_EDITOR': 'true',
        'GIT_TERMINAL_PROMPT': '0',
        'HOME': '/tmp',
        'LANG': 'C.UTF-8',
        'PATH': '/usr/local/bin:/usr/bin:/bin',
    }
    if provider:
        env.update(GIT_ASKPASS='/app/git-askpass.py', GIT_CREDENTIAL_PROVIDER=provider)
    return env


def git_output(process):
    stdout = process.stdout[-MAX_GIT_OUTPUT:]
    stderr = process.stderr[-MAX_GIT_OUTPUT:]
    return {
        'exitCode': process.returncode,
        'stderr': stderr,
        'stderrTruncated': len(process.stderr) > MAX_GIT_OUTPUT,
        'stdout': stdout,
        'stdoutTruncated': len(process.stdout) > MAX_GIT_OUTPUT,
    }


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Service:
    def __init__(self, kind, service_id, policy_path, secret_path, workspace='/workspace', state_root='/data'):
        if kind not in ('workspace', 'docker', 'comfy'):
            raise ValueError('Unknown tool-service kind')
        self.kind, self.service_id = kind, service_id
        self.policy_path, self.secret_path = policy_path, secret_path
        self.workspace = workspace
        self.state = State(state_root)
        self.operation_lock = threading.RLock()
        try:
            self._policy()
        except Exception:
            self.state.close()
            raise

    def _policy(self):
        policy = private_json(self.policy_path)
        if not isinstance(policy, dict) or set(policy) != {'users'}:
            raise ValueError('Tool policy must contain a users map')
        users = policy.get('users', {})
        if not isinstance(users, dict) or (self.kind == 'workspace' and len(users) > 1):
            raise ValueError('A workspace instance may belong to only one account')
        expected = {'workspace': 'tests', 'docker': 'containers', 'comfy': 'workflows'}[self.kind]
        for email, grants in users.items():
            if not isinstance(email, str) or email != email.strip().lower() or not re.fullmatch(r'[^\s@]+@[^\s@]+', email):
                raise ValueError('Tool policy identity is invalid')
            if not isinstance(grants, dict) or set(grants) - {expected}:
                raise ValueError('Tool policy grants are invalid')
            values = grants.get(expected, [] if expected == 'workflows' else {})
            if expected == 'workflows':
                if not isinstance(values, list) or any(not isinstance(v, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', v) for v in values):
                    raise ValueError('Workflow assignments are invalid')
            elif not isinstance(values, dict) or any(not isinstance(k, str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,128}', k) for k in values):
                raise ValueError('Resource assignments are invalid')
            elif expected == 'containers' and any(not isinstance(v, str) or not re.fullmatch(r'[a-f0-9]{64}', v) for v in values.values()):
                raise ValueError('Container assignments require complete IDs')
            elif expected == 'tests' and any(not isinstance(v, list) or not v or len(v) > 128 or any(not isinstance(arg, str) or not arg or '\x00' in arg or len(arg) > 4096 for arg in v) for v in values.values()):
                raise ValueError('Check assignments require explicit command arguments')
        return users

    def principal(self, header):
        secret = private_bytes(self.secret_path, 4096).strip()
        if len(secret) < 32:
            raise ValueError('Service credential must contain at least 32 bytes')
        user = verify_token(header, secret, self.service_id)
        if user['email'] not in self._policy():
            raise ToolError('forbidden', 'Your account has no access to this tool service')
        return user

    def call(self, user, name, args):
        with self.operation_lock:
            # Recheck after waiting for an earlier operation, not before the lock.
            policy = self._policy().get(user['email'])
            if policy is None:
                raise ToolError('forbidden', 'Tool access has been revoked')
            selected = next((tool for tool in self.tools(user) if tool['name'] == name), None)
            if selected is None:
                raise ToolError('forbidden', 'This tool is not available on this service')
            if not isinstance(args, dict):
                raise ToolError('invalid_arguments', 'Tool arguments must be an object')
            schema = selected['inputSchema']
            extra = {'_requestId'} if name == 'generate_image' else set()
            if set(args) - set(schema['properties']) - extra or set(schema['required']) - set(args):
                raise ToolError('invalid_arguments', 'Tool arguments do not match the advertised schema')
            for key, value in args.items():
                if not isinstance(value, str):
                    raise ToolError('invalid_arguments', 'Tool arguments must be strings')
                field = schema['properties'].get(key, {})
                if 'enum' in field and value not in field['enum']:
                    raise ToolError('forbidden', 'Choose an assigned resource')
            if name == 'generate_image' and not re.fullmatch(r'[A-Za-z0-9_.:-]{1,128}', args.get('_requestId', '')):
                raise ToolError('invalid_arguments', 'A stable application request ID is required')
            result = getattr(self, name)(user, policy, args)
        return {'ok': True, **result}

    def workspace_list(self, user, policy, args):
        parts = validate_relative(args.get('path', '.'), allow_root=True)
        with directory_fd(self.workspace, parts) as fd:
            with os.scandir(fd) as entries:
                files = []
                for entry in entries:
                    if protected_workspace_part(entry.name):
                        continue
                    files.append({'name': entry.name, 'type': 'symlink' if entry.is_symlink() else 'directory' if entry.is_dir(follow_symlinks=False) else 'file'})
                    if len(files) >= 500:
                        break
        return {'path': args.get('path', '.'), 'entries': sorted(files, key=lambda e: e['name']), 'limit': 500}

    def workspace_read(self, user, policy, args):
        return {'path': args['path'], 'content': read_file(self.workspace, args['path']), 'truncated': False}

    def workspace_propose_patch(self, user, policy, args):
        new = args['content']
        if not isinstance(new, str) or len(new.encode()) > MAX_FILE:
            raise ToolError('file_limit', 'Replacement must be UTF-8 text up to 256 KiB')
        old = read_file(self.workspace, args['path'], missing_ok=True)
        patch = ''.join(difflib.unified_diff((old or '').splitlines(keepends=True), new.splitlines(keepends=True), fromfile=args['path'], tofile=args['path']))
        key = str(uuid.uuid4())
        self.state.put(key, user['email'], 'proposal', {'path': args['path'], 'before': digest(old), 'content': new, 'diff': patch, 'applied': False})
        return {'proposalId': key, 'path': args['path'], 'diff': patch}

    def workspace_apply_patch(self, user, policy, args):
        key = args['proposalId']
        proposal = self.state.get(key, user['email'], 'proposal')
        if proposal['applied']:
            return {'proposalId': key, 'path': proposal['path'], 'applied': True, 'diff': proposal['diff']}
        if digest(read_file(self.workspace, proposal['path'], missing_ok=True)) != proposal['before']:
            raise ToolError('conflict', 'The file changed after this proposal; request a fresh diff')
        parts = validate_relative(proposal['path'])
        with directory_fd(self.workspace, parts[:-1]) as parent:
            temporary = '.nv-chat-' + str(uuid.uuid4()) + '.tmp'
            fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600, dir_fd=parent)
            try:
                with os.fdopen(fd, 'wb') as handle:
                    handle.write(proposal['content'].encode())
                    handle.flush()
                    os.fsync(handle.fileno())
                    if os.geteuid() == 0:
                        os.fchown(handle.fileno(), RUN_UID, RUN_GID)
                    os.fchmod(handle.fileno(), 0o660)
                os.replace(temporary, parts[-1], src_dir_fd=parent, dst_dir_fd=parent)
                os.fsync(parent)
            finally:
                with contextlib.suppress(FileNotFoundError):
                    os.unlink(temporary, dir_fd=parent)
        proposal['applied'] = True
        self.state.put(key, user['email'], 'proposal', proposal)
        return {'proposalId': key, 'path': proposal['path'], 'applied': True, 'diff': proposal['diff']}

    @contextlib.contextmanager
    def _git_repository(self, name):
        parts = validate_relative(name)
        with directory_fd(self.workspace, parts) as fd:
            try:
                git_dir = os.stat('.git', dir_fd=fd, follow_symlinks=False)
            except OSError:
                raise ToolError('git_repository_required', 'Choose a Git repository in the assigned workspace') from None
            if not stat.S_ISDIR(git_dir.st_mode):
                raise ToolError('git_repository_required', 'Linked worktrees are unavailable in this workspace')
            yield f'/proc/self/fd/{fd}'

    def _git_run(self, repository, arguments, provider=None, timeout=120, check=True):
        with self._git_repository(repository) as cwd:
            try:
                process = subprocess.run(
                    ['git', *GIT_COMMON_ARGS, *arguments],
                    cwd=cwd,
                    env=git_environment(provider),
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    timeout=timeout,
                    check=False,
                )
            except (OSError, subprocess.SubprocessError):
                raise ToolError('git_unavailable', 'The Git operation could not run') from None
        result = git_output(process)
        if check and process.returncode != 0:
            message = (process.stderr or process.stdout or 'Git operation failed').strip()
            raise ToolError('git_failed', message[-4096:])
        return result

    def _git_remote(self, repository):
        result = self._git_run(repository, ['remote', 'get-url', 'origin'])
        remote = result['stdout'].strip()
        provider, https_remote = canonical_git_remote(remote)
        return provider, https_remote

    def git_auth_status(self, user, policy, args):
        return {
            'github': {'configured': git_token_configured('github')},
            'gitlab': {'configured': git_token_configured('gitlab')},
        }

    def git_repo_info(self, user, policy, args):
        repository = args['repo']
        branch = self._git_run(repository, ['branch', '--show-current'])['stdout'].strip()
        name = self._git_run(repository, ['config', '--get', 'user.name'], check=False)['stdout'].strip()
        email = self._git_run(repository, ['config', '--get', 'user.email'], check=False)['stdout'].strip()
        provider, remote = self._git_remote(repository)
        return {
            'branch': branch,
            'identity': {'email': email or None, 'name': name or None},
            'provider': provider,
            'remote': remote,
            'repo': repository,
        }

    def git_remote_check(self, user, policy, args):
        provider, remote = self._git_remote(args['repo'])
        result = self._git_run(
            args['repo'], ['ls-remote', '--heads', remote],
            provider=provider, timeout=120,
        )
        branches = sum(1 for line in result['stdout'].splitlines() if line.strip())
        return {
            'branchCount': branches,
            'provider': provider,
            'reachable': True,
            'repo': args['repo'],
        }

    def git_status(self, user, policy, args):
        result = self._git_run(args['repo'], ['status', '--short', '--branch', '--untracked-files=all'])
        return {'repo': args['repo'], **result}

    def git_diff(self, user, policy, args):
        staged = args.get('staged', 'false')
        if staged not in ('true', 'false'):
            raise ToolError('invalid_arguments', 'staged must be true or false')
        command = ['diff', '--no-ext-diff', '--stat', '--patch']
        if staged == 'true':
            command.append('--cached')
        result = self._git_run(args['repo'], command)
        return {'repo': args['repo'], 'staged': staged == 'true', **result}

    def git_log(self, user, policy, args):
        result = self._git_run(args['repo'], [
            'log', '-n', '12', '--date=iso-strict',
            '--pretty=format:%h%x09%ad%x09%an%x09%s',
        ])
        return {'repo': args['repo'], **result}

    def git_clone(self, user, policy, args):
        destination_parts = validate_relative(args['destination'])
        provider, remote = canonical_git_remote(args['repository'])
        if not git_token_configured(provider):
            # Public GitHub repositories may still clone anonymously. GitLab
            # failures return a clear auth diagnostic without prompting.
            pass
        with directory_fd(self.workspace, destination_parts[:-1]) as parent:
            try:
                os.stat(destination_parts[-1], dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                raise ToolError('destination_exists', 'The clone destination already exists')
            try:
                process = subprocess.run(
                    ['git', *GIT_COMMON_ARGS, 'clone', '--', remote, destination_parts[-1]],
                    cwd=f'/proc/self/fd/{parent}',
                    env=git_environment(provider),
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    timeout=300,
                    check=False,
                )
            except (OSError, subprocess.SubprocessError):
                raise ToolError('git_unavailable', 'The repository clone could not run') from None
        result = git_output(process)
        if process.returncode != 0:
            raise ToolError('git_failed', (process.stderr or process.stdout or 'Clone failed').strip()[-4096:])
        return {'destination': args['destination'], 'provider': provider, **result}

    def git_fetch(self, user, policy, args):
        provider, remote = self._git_remote(args['repo'])
        result = self._git_run(args['repo'], [
            'fetch', '--no-tags', '--prune', remote,
            '+refs/heads/*:refs/remotes/origin/*',
        ], provider=provider, timeout=300)
        return {'provider': provider, 'repo': args['repo'], **result}

    def git_pull(self, user, policy, args):
        branch = self._git_run(args['repo'], ['branch', '--show-current'])['stdout'].strip()
        if not branch:
            raise ToolError('git_branch_required', 'Check out a branch before pulling')
        provider, remote = self._git_remote(args['repo'])
        fetched = self._git_run(args['repo'], [
            'fetch', '--no-tags', remote, f'refs/heads/{branch}',
        ], provider=provider, timeout=300)
        merged = self._git_run(args['repo'], ['merge', '--ff-only', 'FETCH_HEAD'])
        return {
            'branch': branch,
            'fetch': fetched,
            'merge': merged,
            'provider': provider,
            'repo': args['repo'],
        }

    def git_create_branch(self, user, policy, args):
        branch = args['branch']
        if (not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/-]{0,127}', branch)
                or '..' in branch or '@{' in branch or branch.endswith(('/', '.'))):
            raise ToolError('invalid_branch', 'Choose a valid Git branch name')
        checked = self._git_run(args['repo'], ['check-ref-format', '--branch', branch], check=False)
        if checked['exitCode'] != 0:
            raise ToolError('invalid_branch', 'Choose a valid Git branch name')
        result = self._git_run(args['repo'], ['switch', '-c', branch])
        return {'branch': branch, 'repo': args['repo'], **result}

    def git_stage(self, user, policy, args):
        validate_relative(args['path'])
        result = self._git_run(args['repo'], ['add', '--', args['path']])
        return {'path': args['path'], 'repo': args['repo'], **result}

    def git_set_identity(self, user, policy, args):
        name, email = args['name'].strip(), args['email'].strip()
        if not name or len(name) > 128 or '\n' in name or '\r' in name:
            raise ToolError('invalid_identity', 'Choose a valid commit author name')
        if len(email) > 254 or not re.fullmatch(r'[^\s@]+@[^\s@]+', email):
            raise ToolError('invalid_identity', 'Choose a valid commit author email')
        self._git_run(args['repo'], ['config', '--local', 'user.name', name])
        self._git_run(args['repo'], ['config', '--local', 'user.email', email])
        return {'email': email, 'name': name, 'repo': args['repo']}

    def git_commit(self, user, policy, args):
        message = args['message'].strip()
        if not message or len(message) > 2000 or '\x00' in message:
            raise ToolError('invalid_commit_message', 'Choose a commit message up to 2000 characters')
        name = self._git_run(args['repo'], ['config', '--get', 'user.name'], check=False)['stdout'].strip()
        email = self._git_run(args['repo'], ['config', '--get', 'user.email'], check=False)['stdout'].strip()
        if not name or not email:
            raise ToolError('git_identity_missing', 'Set the repository commit identity before committing')
        result = self._git_run(args['repo'], ['commit', '--no-verify', '-m', message])
        commit = self._git_run(args['repo'], ['rev-parse', 'HEAD'])['stdout'].strip()
        return {'commit': commit, 'repo': args['repo'], **result}

    def git_push(self, user, policy, args):
        branch = self._git_run(args['repo'], ['branch', '--show-current'])['stdout'].strip()
        if not branch:
            raise ToolError('git_branch_required', 'Check out a branch before pushing')
        provider, remote = self._git_remote(args['repo'])
        if not git_token_configured(provider):
            raise ToolError('git_auth_required', f'{provider} credentials are not configured for this workspace')
        result = self._git_run(args['repo'], [
            'push', remote, f'HEAD:refs/heads/{branch}',
        ], provider=provider, timeout=300)
        return {'branch': branch, 'provider': provider, 'repo': args['repo'], **result}

    def workspace_test(self, user, policy, args):
        if os.environ.get('WORKSPACE_PERSONAL_FILES') == 'true':
            raise ToolError('forbidden', 'Command execution is disabled for personal file workspaces')
        command = policy.get('tests', {}).get(args['check'])
        if not isinstance(command, list) or not command or not all(isinstance(v, str) for v in command):
            raise ToolError('forbidden', 'Choose an administrator-configured workspace check')
        if os.geteuid() != 0:
            raise ToolError('runner_unavailable', 'The isolated test runner is not available in this deployment')
        env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/tmp', 'LANG': 'C.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1'}
        with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
            wrapper = [sys.executable, '-I', str(Path(__file__).resolve()), '--workspace-exec', json.dumps(command)]
            try:
                process = subprocess.Popen(wrapper, cwd=self.workspace, env=env, stdin=subprocess.DEVNULL,
                                           stdout=stdout, stderr=stderr, start_new_session=True,
                                           user=RUN_UID, group=RUN_GID, extra_groups=[], umask=0o007)
            except (OSError, subprocess.SubprocessError):
                raise ToolError('runner_unavailable', 'The isolated test runner is not available in this deployment') from None
            status = 'completed'
            try:
                process.wait(timeout=60)
            except subprocess.TimeoutExpired:
                status = 'timed-out'
            finally:
                stop_workspace_processes()
                process.wait(timeout=5)
            stdout.seek(0)
            stderr.seek(0)
            return {'status': status, 'exitCode': process.returncode,
                    'stdout': stdout.read(32768).decode(errors='replace'), 'stderr': stderr.read(32768).decode(errors='replace'),
                    'stdoutTruncated': os.fstat(stdout.fileno()).st_size > 32768,
                    'stderrTruncated': os.fstat(stderr.fileno()).st_size > 32768}

    def _container(self, policy, alias):
        value = policy.get('containers', {}).get(alias)
        if not isinstance(value, str) or re.fullmatch(r'[a-f0-9]{64}', value) is None:
            raise ToolError('forbidden', 'That container is not assigned to your account')
        return value

    def docker_status(self, user, policy, args):
        aliases = [args['service']] if args.get('service') else list(policy.get('containers', {}))
        results = []
        for alias in aliases:
            container_id = self._container(policy, alias)
            info = docker_request('GET', '/containers/' + container_id + '/json')
            results.append({'id': alias, 'name': info.get('Name', '').lstrip('/'), 'state': info.get('State', {}).get('Status', 'unknown')})
        return {'containers': results}

    def docker_start(self, user, policy, args):
        docker_request('POST', '/containers/' + self._container(policy, args['service']) + '/start')
        return {'operation': 'start', **self.docker_status(user, policy, args)}

    def docker_stop(self, user, policy, args):
        docker_request('POST', '/containers/' + self._container(policy, args['service']) + '/stop?t=15')
        return {'operation': 'stop', **self.docker_status(user, policy, args)}

    def _comfy(self, path, payload=None, binary=False):
        base = os.environ.get('COMFY_URL', '').rstrip('/')
        url = urlsplit(base)
        if url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password or url.query or url.fragment:
            raise ToolError('not_configured', 'Image generation is not configured')
        headers = {'Content-Type': 'application/json'}
        key_file = os.environ.get('COMFY_API_KEY_FILE')
        if key_file:
            key = private_bytes(key_file, 16384).strip().decode()
            if not key or '\n' in key or '\r' in key:
                raise ValueError('Generation credential is invalid')
            headers['Authorization'] = 'Bearer ' + key
        request = Request(base + path, data=json.dumps(payload).encode() if payload is not None else None, headers=headers)
        # No redirects and no inherited proxy: credentials go only to the
        # administrator-configured Comfy endpoint.
        opener = build_opener(ProxyHandler({}), NoRedirect())
        try:
            with opener.open(request, timeout=20) as response:
                body = response.read(20 * 1024 * 1024 + 1)
                if len(body) > 20 * 1024 * 1024:
                    raise ToolError('artifact_limit', 'Generated output exceeds the download limit')
                return body if binary else json.loads(body)
        except HTTPError as error:
            rejected = path == '/prompt' and payload is not None and error.code in (400, 422)
            error.close()
            if rejected:
                raise ToolError('generation_rejected', 'The configured image workflow was rejected') from None
            raise ToolError('generation_unavailable', 'The generation service could not complete this request') from None
        except (OSError, URLError, ValueError):
            raise ToolError('generation_unavailable', 'The generation service could not complete this request') from None

    def generate_image(self, user, policy, args):
        template_id = args['workflow']
        if template_id not in policy.get('workflows', []) or re.fullmatch(r'[a-zA-Z0-9_-]+', template_id) is None:
            raise ToolError('forbidden', 'Choose an assigned image workflow')
        if not isinstance(args['prompt'], str) or not args['prompt'].strip() or len(args['prompt']) > 4000:
            raise ToolError('invalid_prompt', 'Use a prompt up to 4000 characters')
        request_id = args['_requestId']
        fingerprint = digest(json.dumps([template_id, args['prompt']], separators=(',', ':')))
        try:
            submission = self.state.get(request_id, user['email'], 'submission')
        except ToolError:
            submission = None
        if submission:
            if submission['fingerprint'] != fingerprint:
                raise ToolError('idempotency_conflict', 'This request ID already belongs to a different generation request')
            job = self.state.get(submission['jobId'], user['email'], 'generation')
            return {'jobId': submission['jobId'], 'status': job['status']}

        try:
            active = self.state.get('active', self.service_id, 'queue')
        except ToolError:
            active = None
        if active:
            current = self._generation_status(active['owner'], active['jobId'])
            if current['status'] not in ('completed', 'failed'):
                raise ToolError('generation_busy', 'This generation service is processing a job; wait for it to finish')

        spec = private_json(str(Path(os.environ['COMFY_WORKFLOWS_DIR']) / (template_id + '.json')))
        if not isinstance(spec, dict) or set(spec) != {'workflow', 'promptNodeIds'}:
            raise ToolError('invalid_workflow', 'The configured image workflow is invalid')
        workflow, prompt_nodes = spec['workflow'], spec['promptNodeIds']
        if (not isinstance(workflow, dict) or not workflow or not isinstance(prompt_nodes, list) or not prompt_nodes
                or any(not isinstance(node, str) for node in prompt_nodes) or len(set(prompt_nodes)) != len(prompt_nodes)):
            raise ToolError('invalid_workflow', 'The configured image workflow is invalid')
        for node in prompt_nodes:
            value = workflow.get(node)
            if not isinstance(value, dict) or value.get('class_type') != 'CLIPTextEncode' or not isinstance(value.get('inputs'), dict):
                raise ToolError('invalid_workflow', 'The configured prompt node is unsupported')
            value['inputs']['text'] = args['prompt']

        job_id = str(uuid.uuid4())
        # Reserve BEFORE contacting Comfy. A lost response must never result in
        # a second generation on retry, including after a service restart.
        job = {'promptId': None, 'artifacts': [], 'status': 'submission-unknown'}
        self.state.put_many([
            (job_id, user['email'], 'generation', job),
            (request_id, user['email'], 'submission', {'jobId': job_id, 'fingerprint': fingerprint}),
            ('active', self.service_id, 'queue', {'jobId': job_id, 'owner': user['email']}),
        ])
        try:
            response = self._comfy('/prompt', {'prompt': workflow, 'client_id': job_id})
        except ToolError as error:
            if error.code == 'generation_rejected':
                job['status'] = 'failed'
                self.state.put(job_id, user['email'], 'generation', job)
                self.state.delete('active', self.service_id, 'queue')
                raise
            return {'jobId': job_id, 'status': 'submission-unknown'}
        if not isinstance(response, dict) or not isinstance(response.get('prompt_id'), str):
            return {'jobId': job_id, 'status': 'submission-unknown'}
        try:
            prompt_id = str(uuid.UUID(response['prompt_id']))
        except ValueError:
            return {'jobId': job_id, 'status': 'submission-unknown'}
        # Comfy may return node_errors for unexecuted branches while accepting
        # other outputs. A successful prompt_id still owns the active slot.
        job.update(promptId=prompt_id, status='queued')
        self.state.put(job_id, user['email'], 'generation', job)
        return {'jobId': job_id, 'status': 'queued'}

    def generation_status(self, user, policy, args):
        return self._generation_status(user['email'], args['jobId'])

    def _generation_status(self, owner, job_id):
        job = self.state.get(job_id, owner, 'generation')
        if job['status'] in ('completed', 'failed', 'submission-unknown'):
            return {'jobId': job_id, 'status': job['status'], 'artifacts': self._public_artifacts(job)}
        history = self._comfy('/history/' + job['promptId'])
        if not isinstance(history, dict):
            raise ToolError('generation_unavailable', 'The generation service returned an invalid status')
        item = history.get(job['promptId'])
        if not item:
            return {'jobId': job_id, 'status': 'running', 'artifacts': []}
        if not isinstance(item, dict) or not isinstance(item.get('outputs', {}), dict):
            raise ToolError('generation_unavailable', 'The generation service returned an invalid status')
        failed = item.get('status', {}).get('status_str') == 'error'
        completed = item.get('status', {}).get('completed') is True
        if not failed and not completed:
            return {'jobId': job_id, 'status': 'running', 'artifacts': []}
        artifacts = []
        for output in item.get('outputs', {}).values():
            if not isinstance(output, dict):
                continue
            for image in output.get('images', []):
                if not isinstance(image, dict):
                    continue
                filename, subfolder = image.get('filename', ''), image.get('subfolder', '')
                if not isinstance(filename, str) or not isinstance(subfolder, str):
                    continue
                suffix = Path(filename).suffix.lower()
                if Path(filename).name != filename or suffix not in ('.png', '.jpg', '.jpeg', '.webp') or image.get('type') != 'output':
                    continue
                try:
                    validate_relative(filename)
                    validate_relative(subfolder, allow_root=True)
                except ToolError:
                    continue
                artifacts.append({'filename': filename, 'subfolder': subfolder, 'type': 'output',
                                  'mediaType': 'image/png' if suffix == '.png' else 'image/webp' if suffix == '.webp' else 'image/jpeg'})
                if len(artifacts) >= 16:
                    break
            if len(artifacts) >= 16:
                break
        job.update(artifacts=artifacts, status='failed' if failed else 'completed')
        self.state.put(job_id, owner, 'generation', job)
        try:
            active = self.state.get('active', self.service_id, 'queue')
            if active == {'jobId': job_id, 'owner': owner}:
                self.state.delete('active', self.service_id, 'queue')
        except ToolError:
            pass
        return {'jobId': job_id, 'status': job['status'], 'artifacts': self._public_artifacts(job)}

    @staticmethod
    def _public_artifacts(job):
        return [{'index': i, 'filename': item['filename'], 'mediaType': item['mediaType']} for i, item in enumerate(job['artifacts'])]

    def artifact(self, user, job_id, index):
        if user['email'] not in self._policy():
            raise ToolError('forbidden', 'Tool access has been revoked')
        job = self.state.get(job_id, user['email'], 'generation')
        if index < 0 or index >= len(job['artifacts']):
            raise ToolError('not_found', 'Generated file not found')
        artifact = job['artifacts'][index]
        query = urlencode({k: artifact[k] for k in ('filename', 'subfolder', 'type')})
        return self._comfy('/view?' + query, binary=True), artifact['mediaType']

    def tools(self, user=None):
        names = {
            'workspace': [
                ('workspace_list', {'path': 'string'}, []),
                ('workspace_read', {'path': 'string'}, ['path']),
                ('workspace_propose_patch', {'path': 'string', 'content': 'string'}, ['path', 'content']),
                ('workspace_apply_patch', {'proposalId': 'string'}, ['proposalId']),
                ('git_auth_status', {}, []),
                ('git_repo_info', {'repo': 'string'}, ['repo']),
                ('git_remote_check', {'repo': 'string'}, ['repo']),
                ('git_status', {'repo': 'string'}, ['repo']),
                ('git_diff', {'repo': 'string', 'staged': 'string'}, ['repo']),
                ('git_log', {'repo': 'string'}, ['repo']),
                ('git_clone', {'repository': 'string', 'destination': 'string'}, ['repository', 'destination']),
                ('git_fetch', {'repo': 'string'}, ['repo']),
                ('git_pull', {'repo': 'string'}, ['repo']),
                ('git_create_branch', {'repo': 'string', 'branch': 'string'}, ['repo', 'branch']),
                ('git_stage', {'repo': 'string', 'path': 'string'}, ['repo', 'path']),
                ('git_set_identity', {'repo': 'string', 'name': 'string', 'email': 'string'}, ['repo', 'name', 'email']),
                ('git_commit', {'repo': 'string', 'message': 'string'}, ['repo', 'message']),
                ('git_push', {'repo': 'string'}, ['repo']),
                ('workspace_test', {'check': 'string'}, ['check']),
            ],
            'docker': [('docker_status', {'service': 'string'}, []), ('docker_start', {'service': 'string'}, ['service']), ('docker_stop', {'service': 'string'}, ['service'])],
            'comfy': [('generate_image', {'workflow': 'string', 'prompt': 'string'}, ['workflow', 'prompt']), ('generation_status', {'jobId': 'string'}, ['jobId'])],
        }[self.kind]
        tools = [{'name': name, 'description': name.replace('_', ' ') + ' within your assigned resources',
                 'inputSchema': {'type': 'object', 'properties': {k: {'type': t} for k, t in fields.items()}, 'required': required, 'additionalProperties': False}}
                for name, fields, required in names]
        if user is None:
            return tools
        policy = self._policy().get(user['email'])
        if policy is None:
            raise ToolError('forbidden', 'Tool access has been revoked')
        fields = {'workspace_test': ('check', 'tests'), 'generate_image': ('workflow', 'workflows'),
                  'docker_status': ('service', 'containers'), 'docker_start': ('service', 'containers'),
                  'docker_stop': ('service', 'containers')}
        visible = []
        for tool in tools:
            if tool['name'] == 'workspace_test' and os.environ.get('WORKSPACE_PERSONAL_FILES') == 'true':
                continue
            if tool['name'] in fields:
                field, setting = fields[tool['name']]
                values = sorted(policy.get(setting, []))
                if not values:
                    continue
                tool['inputSchema']['properties'][field]['enum'] = values
            visible.append(tool)
        return visible



class Handler(BaseHTTPRequestHandler):
    server_version = 'NVChatTools/1'

    def setup(self):
        super().setup()
        self.connection.settimeout(20)

    def log_message(self, *args):
        pass  # Never log bearer tokens, request bodies, or filesystem paths.

    def send_json(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == '/health':
            return self.send_json(200, {'status': 'ok', 'service': self.server.service.kind})
        try:
            if self.headers.get('Origin'):
                return self.send_json(403, {'error': 'browser_access_denied'})
            user = self.server.service.principal(self.headers.get('Authorization', ''))
            match = re.fullmatch(r'/artifacts/([a-f0-9-]{36})/(\d+)', self.path)
            if not match or self.server.service.kind != 'comfy':
                return self.send_json(405, {'error': 'Use POST /mcp'})
            body, content_type = self.server.service.artifact(user, match[1], int(match[2]))
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            self.wfile.write(body)
        except ToolError as exc:
            self.send_json(401 if exc.code == 'unauthorized' else 403, {'error': exc.code})
        except Exception:
            self.send_json(503, {'error': 'service_unavailable'})

    def do_POST(self):
        request_id = None
        try:
            if self.path != '/mcp':
                return self.send_json(404, {'error': 'not_found'})
            if self.headers.get('Origin'):
                return self.send_json(403, {'error': 'browser_access_denied'})
            user = self.server.service.principal(self.headers.get('Authorization', ''))
            if self.headers.get_content_type() != 'application/json' or self.headers.get('Transfer-Encoding'):
                return self.send_json(415, {'error': 'content_type'})
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= MAX_REQUEST:
                return self.send_json(413, {'error': 'request_size'})
            message = json.loads(self.rfile.read(size))
            if not isinstance(message, dict) or message.get('jsonrpc') != '2.0':
                raise ValueError()
            request_id = message.get('id')
            method = message['method']
            if not isinstance(method, str) or (request_id is not None and (isinstance(request_id, bool) or not isinstance(request_id, (str, int)))):
                raise ValueError()
            if 'params' in message and not isinstance(message['params'], dict):
                raise ValueError()
            if method.startswith('notifications/'):
                if 'id' in message:
                    raise ValueError()
                self.send_response(202)
                self.end_headers()
                return
            if 'id' not in message:
                raise ValueError()
            version_header = self.headers.get('MCP-Protocol-Version')
            # New SDKs probe server/discover before their legacy handshake.
            # Method-not-found permits that fallback without advertising a
            # modern protocol this minimal stateless service does not implement.
            if method not in ('initialize', 'server/discover') and version_header and version_header not in PROTOCOL_VERSIONS:
                return self.send_json(400, {'error': 'unsupported_protocol_version'})
            if method == 'initialize':
                params = message.get('params', {})
                version = params.get('protocolVersion')
                if not isinstance(version, str) or not isinstance(params.get('capabilities'), dict) or not isinstance(params.get('clientInfo'), dict):
                    raise ValueError()
                version = version if version in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0]
                result = {'protocolVersion': version, 'capabilities': {'tools': {'listChanged': False}}, 'serverInfo': {'name': self.server.service.service_id, 'version': '1.0.0'}}
            elif method == 'ping':
                result = {}
            elif method == 'tools/list':
                result = {'tools': self.server.service.tools(user)}
            elif method == 'tools/call':
                params = message['params']
                try:
                    value = self.server.service.call(user, params['name'], params.get('arguments', {}))
                    result = {'content': [{'type': 'text', 'text': json.dumps(value)}], 'structuredContent': value}
                except ToolError as exc:
                    value = {'ok': False, 'error': {'code': exc.code, 'message': str(exc)}}
                    result = {'isError': True, 'content': [{'type': 'text', 'text': json.dumps(value)}], 'structuredContent': value}
            else:
                return self.send_json(200, {'jsonrpc': '2.0', 'id': request_id, 'error': {'code': -32601, 'message': 'Method not found'}})
            self.send_json(200, {'jsonrpc': '2.0', 'id': request_id, 'result': result})
        except ToolError as exc:
            self.send_json(401 if exc.code == 'unauthorized' else 403, {'error': exc.code})
        except (ValueError, TypeError, KeyError):
            self.send_json(400, {'jsonrpc': '2.0', 'id': request_id, 'error': {'code': -32602, 'message': 'Invalid request'}})
        except Exception:
            self.send_json(503, {'error': 'service_unavailable'})


def reconcile_generation(service, job_id, prompt_id=None, mark_failed=False):
    """Offline operator action, never advertised or callable as an MCP tool."""
    if service.kind != 'comfy' or (prompt_id is None) == (not mark_failed):
        raise ValueError('Choose an existing prompt ID or a confirmed failed submission')
    job_id = str(uuid.UUID(job_id))
    if prompt_id is not None:
        prompt_id = str(uuid.UUID(prompt_id))
    active = service.state.get('active', service.service_id, 'queue')
    if active['jobId'] != job_id:
        raise ValueError('Only the active uncertain submission can be reconciled')
    job = service.state.get(job_id, active['owner'], 'generation')
    if job['status'] != 'submission-unknown':
        raise ValueError('Only an uncertain submission can be reconciled')
    job.update(promptId=prompt_id, status='failed' if mark_failed else 'queued')
    service.state.put(job_id, active['owner'], 'generation', job)
    if mark_failed:
        service.state.delete('active', service.service_id, 'queue')
    return job['status']


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--workspace-exec':
        workspace_exec(json.loads(sys.argv[2]))
        raise SystemExit(1)
    os.umask(0o077)
    service = Service(os.environ['TOOLS_SERVICE_KIND'], os.environ['TOOLS_SERVICE_ID'],
                      os.environ['TOOLS_POLICY_FILE'], os.environ['TOOLS_SHARED_SECRET_FILE'])
    if len(sys.argv) > 1:
        parser = argparse.ArgumentParser(description='Reconcile an uncertain generation while the adapter service is stopped.')
        parser.add_argument('--reconcile-generation', required=True, metavar='JOB_UUID')
        result = parser.add_mutually_exclusive_group(required=True)
        result.add_argument('--prompt-id', metavar='COMFY_PROMPT_UUID')
        result.add_argument('--mark-failed', action='store_true')
        args = parser.parse_args()
        status = reconcile_generation(service, args.reconcile_generation, args.prompt_id, args.mark_failed)
        print('Generation reconciled:', status)
        raise SystemExit(0)
    server = ThreadingHTTPServer(('0.0.0.0', 8080), Handler)
    server.service = service
    server.serve_forever()
