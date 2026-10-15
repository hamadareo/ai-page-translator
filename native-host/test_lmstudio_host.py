import io
import json
import os
import stat
import struct
import subprocess
import tempfile
import unittest

import lmstudio_host as host

MODEL = 'qwen/qwen2.5-coder-14b'
LS = json.dumps([
    {'type': 'llm', 'modelKey': MODEL, 'displayName': 'Qwen2.5 Coder 14B'},
    {'type': 'embedding', 'modelKey': 'text-embedding-nomic-embed-text-v1.5'},
])


def frame(obj):
    data = json.dumps(obj).encode('utf-8')
    return struct.pack('=I', len(data)) + data


class FakeRunner:
    """Stands in for subprocess.run. responses: 'joined args' -> (code, stdout, stderr) or an exception."""

    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def __call__(self, argv, **kwargs):
        self.calls.append((argv, kwargs))
        out = self.responses.get(' '.join(argv[1:]), (0, '', ''))
        if isinstance(out, BaseException):
            raise out
        code, stdout, stderr = out
        return subprocess.CompletedProcess(argv, code, stdout, stderr)

    def commands(self):
        return [' '.join(argv[1:]) for argv, _ in self.calls]


def ensure(runner, **message):
    return host.handle({'cmd': 'ensure', 'model': MODEL, 'port': 1234, **message}, lms='/x/lms', runner=runner)


class MessagingTest(unittest.TestCase):
    def test_read_write_roundtrip(self):
        out = io.BytesIO()
        host.write_message(out, {'ok': True, 'text': '日本語'})
        self.assertEqual(host.read_message(io.BytesIO(out.getvalue())), {'ok': True, 'text': '日本語'})

    def test_main_replies_bad_request_on_garbage(self):
        for raw in (struct.pack('=I', 50) + b'{"cmd"', struct.pack('=I', 5) + b'nope!', b'\x01'):
            out = io.BytesIO()
            host.main(stdin=io.BytesIO(raw), stdout=out)
            reply = host.read_message(io.BytesIO(out.getvalue()))
            self.assertEqual(reply['ok'], False)
            self.assertEqual(reply['error']['kind'], 'bad_request')


class CommandTest(unittest.TestCase):
    def test_bad_command(self):
        with self.assertRaises(host.HostError) as ctx:
            host.handle({'cmd': 'rm -rf /'}, lms='/x/lms', runner=FakeRunner({}))
        self.assertEqual(ctx.exception.kind, 'bad_command')

    def test_lms_not_found(self):
        with self.assertRaises(host.HostError) as ctx:
            host.handle({'cmd': 'list'}, lms=None, runner=FakeRunner({}))
        self.assertEqual(ctx.exception.kind, 'lms_not_found')

    def test_list_only_llms(self):
        reply = host.handle({'cmd': 'list'}, lms='/x/lms', runner=FakeRunner({'ls --json': (0, LS, '')}))
        self.assertEqual(reply, {'ok': True, 'models': [{'key': MODEL, 'name': 'Qwen2.5 Coder 14B'}]})

    def test_status(self):
        runner = FakeRunner({'server status --json': (0, '{"running":false,"port":1234}', '')})
        self.assertEqual(host.handle({'cmd': 'status'}, lms='/x/lms', runner=runner), {'ok': True, 'lms': True, 'running': False, 'port': 1234})

    def test_ensure_rejects_option_like_model(self):
        for model in ('--port', 'unknown/model'):
            with self.assertRaises(host.HostError) as ctx:
                ensure(FakeRunner({'ls --json': (0, LS, '')}), model=model)
            self.assertEqual(ctx.exception.kind, 'model_not_found')

    def test_ensure_rejects_bad_port(self):
        for port in (0, 70000, '1234', True, None):
            with self.assertRaises(host.HostError) as ctx:
                ensure(FakeRunner({'ls --json': (0, LS, '')}), port=port)
            self.assertEqual(ctx.exception.kind, 'bad_request')

    def test_ensure_starts_and_loads(self):
        runner = FakeRunner({
            'ls --json': (0, LS, ''),
            'server status --json': (0, '{"running":false,"port":1234}', ''),
            'ps --json': (0, '[]', ''),
        })
        self.assertEqual(ensure(runner), {'ok': True, 'started': True, 'loaded': True})
        self.assertIn('server start --port 1234', runner.commands())
        self.assertIn(f'load {MODEL} -y', runner.commands())
        for argv, kwargs in runner.calls:
            self.assertIsInstance(argv, list)
            self.assertIs(kwargs.get('shell'), False)
            self.assertIn('timeout', kwargs)

    def test_ensure_running_and_loaded_does_nothing(self):
        runner = FakeRunner({
            'ls --json': (0, LS, ''),
            'server status --json': (0, '{"running":true,"port":1234}', ''),
            'ps --json': (0, json.dumps([{'modelKey': MODEL, 'identifier': MODEL}]), ''),
        })
        self.assertEqual(ensure(runner), {'ok': True, 'started': False, 'loaded': False})
        self.assertFalse(any(c.startswith('server start') or c.startswith('load') for c in runner.commands()))

    def test_timeout(self):
        runner = FakeRunner({
            'ls --json': (0, LS, ''),
            'server status --json': (0, '{"running":true,"port":1234}', ''),
            'ps --json': (0, '[]', ''),
            f'load {MODEL} -y': subprocess.TimeoutExpired('lms', 120),
        })
        with self.assertRaises(host.HostError) as ctx:
            ensure(runner)
        self.assertEqual(ctx.exception.kind, 'timeout')
        self.assertEqual(ctx.exception.to_dict()['step'], 'load')

    def test_load_failed_message(self):
        runner = FakeRunner({
            'ls --json': (0, LS, ''),
            'server status --json': (0, '{"running":true,"port":1234}', ''),
            'ps --json': (0, '[]', ''),
            f'load {MODEL} -y': (1, '', 'Error: not enough memory'),
        })
        with self.assertRaises(host.HostError) as ctx:
            ensure(runner)
        self.assertEqual(ctx.exception.kind, 'load_failed')
        self.assertIn('not enough memory', ctx.exception.message)

    def test_non_json_output(self):
        with self.assertRaises(host.HostError) as ctx:
            host.handle({'cmd': 'list'}, lms='/x/lms', runner=FakeRunner({'ls --json': (0, 'You have 2 models', '')}))
        self.assertEqual(ctx.exception.kind, 'lms_failed')


class FindLmsTest(unittest.TestCase):
    def test_find_lms_finds_the_lm_studio_cli_with_an_empty_path(self):
        with tempfile.TemporaryDirectory() as home:
            path = os.path.join(home, '.lmstudio', 'bin', 'lms')
            os.makedirs(os.path.dirname(path))
            with open(path, 'w') as f:
                f.write('#!/bin/sh\n')
            os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR)
            self.assertEqual(host.find_lms(home=home, which=lambda name: None), path)

    def test_find_lms_falls_back_to_path_then_none(self):
        with tempfile.TemporaryDirectory() as home:
            self.assertEqual(host.find_lms(home=home, which=lambda name: '/usr/local/bin/lms'), '/usr/local/bin/lms')
            self.assertIsNone(host.find_lms(home=home, which=lambda name: None))


if __name__ == '__main__':
    unittest.main()
