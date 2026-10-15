#!/usr/bin/env python3
"""Chrome Native Messaging host: lets AI Page Translator start LM Studio and load a model.

Accepts exactly three commands (status, list, ensure) and runs the LM Studio CLI `lms`
with an argument list (never through a shell).
"""
import json
import os
import shutil
import struct
import subprocess
import sys

TIMEOUTS = {'start': 60, 'load': 120, 'default': 15}
COMMANDS = ('status', 'list', 'ensure')


class HostError(Exception):
    def __init__(self, kind, message='', **extra):
        super().__init__(message or kind)
        self.kind = kind
        self.message = message
        self.extra = extra

    def to_dict(self):
        return {'kind': self.kind, 'message': self.message, **self.extra}


def find_lms(home=None, which=shutil.which):
    home = home or os.path.expanduser('~')
    candidate = os.path.join(home, '.lmstudio', 'bin', 'lms')
    if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
        return candidate
    return which('lms')


def read_message(stream):
    header = stream.read(4)
    if len(header) < 4:
        raise HostError('bad_request', 'missing length header')
    (length,) = struct.unpack('=I', header)
    body = stream.read(length)
    if len(body) < length:
        raise HostError('bad_request', 'message shorter than its header')
    try:
        return json.loads(body.decode('utf-8'))
    except ValueError:
        raise HostError('bad_request', 'invalid JSON')


def write_message(stream, message):
    data = json.dumps(message, ensure_ascii=False).encode('utf-8')
    stream.write(struct.pack('=I', len(data)))
    stream.write(data)
    stream.flush()


def run(lms, args, runner, step='default'):
    try:
        return runner([lms, *args], capture_output=True, text=True, timeout=TIMEOUTS[step], shell=False)
    except subprocess.TimeoutExpired:
        raise HostError('timeout', f'lms {" ".join(args)} timed out', step=step)


def run_json(lms, args, runner):
    result = run(lms, args, runner)
    if result.returncode != 0:
        raise HostError('lms_failed', (result.stderr or result.stdout or '')[:300])
    try:
        return json.loads(result.stdout)
    except ValueError:
        raise HostError('lms_failed', 'unexpected output from lms: ' + (result.stdout or '')[:100])


def llm_models(lms, runner):
    return [m for m in run_json(lms, ['ls', '--json'], runner) if m.get('type') == 'llm']


def handle(message, lms, runner=subprocess.run):
    if not isinstance(message, dict):
        raise HostError('bad_request', 'message must be an object')
    cmd = message.get('cmd')
    if cmd not in COMMANDS:
        raise HostError('bad_command', str(cmd)[:50])
    if lms is None:
        raise HostError('lms_not_found')

    if cmd == 'status':
        status = run_json(lms, ['server', 'status', '--json'], runner)
        return {'ok': True, 'lms': True, 'running': bool(status.get('running')), 'port': status.get('port')}

    if cmd == 'list':
        models = llm_models(lms, runner)
        return {'ok': True, 'models': [{'key': m['modelKey'], 'name': m.get('displayName') or m['modelKey']} for m in models]}

    model = message.get('model')
    port = message.get('port')
    if not isinstance(model, str) or not model:
        raise HostError('bad_request', 'model is required')
    if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
        raise HostError('bad_request', 'port must be an integer between 1 and 65535')
    if model not in {m['modelKey'] for m in llm_models(lms, runner)}:
        raise HostError('model_not_found', model)

    started = False
    status = run_json(lms, ['server', 'status', '--json'], runner)
    if status.get('running') and status.get('port') not in (None, port):
        # 別のポートで動いているサーバーは止めない。設定の食い違いとして知らせる
        raise HostError('port_mismatch', '', running_port=status.get('port'), wanted_port=port)
    if not status.get('running'):
        result = run(lms, ['server', 'start', '--port', str(port)], runner, step='start')
        if result.returncode != 0:
            raise HostError('start_failed', (result.stderr or result.stdout or '')[:300])
        started = True

    loaded_now = False
    loaded = run_json(lms, ['ps', '--json'], runner)
    if model not in {m.get('modelKey') for m in loaded} | {m.get('identifier') for m in loaded}:
        result = run(lms, ['load', model, '-y'], runner, step='load')
        if result.returncode != 0:
            raise HostError('load_failed', (result.stderr or result.stdout or '')[:300])
        loaded_now = True
    return {'ok': True, 'started': started, 'loaded': loaded_now}


def main(stdin=None, stdout=None):
    stdin = stdin or sys.stdin.buffer
    stdout = stdout or sys.stdout.buffer
    try:
        reply = handle(read_message(stdin), lms=find_lms())
    except HostError as err:
        reply = {'ok': False, 'error': err.to_dict()}
    except Exception as err:  # never crash: Chrome would only see "native host has exited"
        reply = {'ok': False, 'error': {'kind': 'internal', 'message': str(err)[:300]}}
    write_message(stdout, reply)


if __name__ == '__main__':
    main()
