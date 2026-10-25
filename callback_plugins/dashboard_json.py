"""Emit only the dashboard's explicit public results, never Ansible arguments."""
import json
import sys
from pathlib import Path

from ansible.plugins.callback import CallbackBase
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from public_schema import clean_record

DOCUMENTATION = r"""
name: dashboard_json
type: stdout
short_description: Structured public telemetry for the local dashboard
description: Discards task arguments, credentials, tracebacks, and raw failure messages.
"""


class CallbackModule(CallbackBase):
    CALLBACK_VERSION = 2.0
    CALLBACK_TYPE = "stdout"
    CALLBACK_NAME = "dashboard_json"

    def __init__(self):
        super().__init__()
        self.nodes = {}

    def v2_runner_on_ok(self, result):
        name = result._host.get_name()
        data = result._result
        metadata = data.get("msg", {})
        if isinstance(metadata, dict) and "dashboard_metadata" in metadata:
            self.nodes[name] = {"metadata": metadata["dashboard_metadata"]}
            # Preserve inventory discovery even when a later SSH connection hangs.
            self._display.display(json.dumps({"nodes": {name: clean_record(self.nodes[name])}}, separators=(",", ":")))
        elif result._task.get_name().endswith("Dashboard public telemetry"):
            try:
                telemetry = metadata.get("dashboard_telemetry")
                if not isinstance(telemetry, dict):
                    raise ValueError()
                self.nodes.setdefault(name, {})["telemetry"] = telemetry
            except (ValueError, TypeError):
                self.nodes.setdefault(name, {})["error"] = "invalid_probe_response"

    def v2_runner_on_unreachable(self, result):
        self.nodes.setdefault(result._host.get_name(), {})["error"] = "ssh_unreachable"

    def v2_runner_on_failed(self, result, ignore_errors=False):
        self.nodes.setdefault(result._host.get_name(), {})["error"] = "probe_failed"

    def v2_playbook_on_stats(self, stats):
        self._display.display(json.dumps({"nodes": {name: clean_record(record) for name, record in self.nodes.items()}}, separators=(",", ":")))
