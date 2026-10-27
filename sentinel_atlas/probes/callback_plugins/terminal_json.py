"""Emit only sanitized terminal replies, never command arguments or failures."""
import json

from ansible.plugins.callback import CallbackBase

DOCUMENTATION = r"""
name: terminal_json
type: stdout
short_description: Structured Redis terminal output
description: Discards task arguments, credentials, tracebacks, and transport errors.
"""


class CallbackModule(CallbackBase):
    CALLBACK_VERSION = 2.0
    CALLBACK_TYPE = 'stdout'
    CALLBACK_NAME = 'terminal_json'

    def v2_runner_on_ok(self, result):
        if not result._task.get_name().endswith('Dashboard terminal result'):
            return
        value = result._result.get('msg', {}).get('terminal_result')
        if isinstance(value, dict) and type(value.get('ok')) is bool and isinstance(value.get('output'), str):
            self._display.display(json.dumps({'node': result._host.get_name(), 'result': {
                'ok': value['ok'], 'output': value['output'][:65536]}}))
