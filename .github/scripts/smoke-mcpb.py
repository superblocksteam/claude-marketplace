import json
import os
from pathlib import Path, PurePosixPath
import select
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile

if len(sys.argv) != 2:
    raise SystemExit("Usage: python3 smoke-mcpb.py <bundle.mcpb>")

node = shutil.which("node")
if not node:
    raise SystemExit("Node.js 24 or newer is required.")

with tempfile.TemporaryDirectory(prefix="superblocks-mcpb-smoke-") as temporary:
    root = Path(temporary)
    runtime = root / "runtime"
    home = root / "home"
    home.mkdir()
    with zipfile.ZipFile(sys.argv[1]) as bundle:
        entries = bundle.infolist()
        if len(entries) > 5000 or sum(entry.file_size for entry in entries) > 200_000_000:
            raise SystemExit("MCPB exceeds the release entry or size budget.")
        for entry in entries:
            path = PurePosixPath(entry.filename)
            if path.is_absolute() or ".." in path.parts or ((entry.external_attr >> 16) & 0o170000) == 0o120000:
                raise SystemExit("MCPB contains an unsafe path or symlink.")
        bundle.extractall(runtime)
    manifest = json.loads((runtime / "manifest.json").read_text())
    config = manifest["server"]["mcp_config"]
    if config["command"] != "node":
        raise SystemExit("Expected a Node.js MCP server.")
    blocked = root / "bin"
    blocked.mkdir()
    for name in ("npm", "npx"):
        executable = blocked / name
        executable.write_text("#!/bin/sh\nexit 97\n")
        executable.chmod(0o755)
    env = {
        **config.get("env", {}),
        "HOME": str(home),
        "PATH": os.pathsep.join([str(blocked), str(Path(node).parent), "/usr/bin", "/bin"]),
        "SUPERBLOCKS_SERVER_URL": "http://127.0.0.1:1",
        "OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:1",
    }
    args = [node, *(arg.replace("${__dirname}", str(runtime)) for arg in config["args"])]
    log_path = root / "stderr.log"
    started = time.monotonic()
    with log_path.open("w") as log:
        process = subprocess.Popen(args, cwd=home, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, bufsize=0)
        buffered = bytearray()

        def send(message):
            process.stdin.write((json.dumps(message) + "\n").encode())
            process.stdin.flush()

        def receive(request_id):
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                if b"\n" not in buffered:
                    ready, _, _ = select.select([process.stdout], [], [], max(0, deadline - time.monotonic()))
                    if not ready:
                        break
                    chunk = os.read(process.stdout.fileno(), 65536)
                    if not chunk:
                        raise RuntimeError("MCP process exited before replying: " + log_path.read_text()[-4000:])
                    buffered.extend(chunk)
                    if b"\n" not in buffered:
                        continue
                line, _, remaining = buffered.partition(b"\n")
                buffered[:] = remaining
                message = json.loads(line)
                if message.get("id") == request_id:
                    if "error" in message:
                        raise RuntimeError(json.dumps(message["error"]))
                    return message["result"]
            raise RuntimeError("MCP response timed out: " + log_path.read_text()[-4000:])

        try:
            send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "mcpb-release-smoke", "version": "1.0.0"}}})
            server = receive(1)["serverInfo"]
            send({"jsonrpc": "2.0", "method": "notifications/initialized"})
            send({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
            tools = receive(2)["tools"]
            if not any(tool["name"].lower() == "login" for tool in tools):
                raise RuntimeError("Login tool is missing from the credentialless MCP server.")
            ready_seconds = round(time.monotonic() - started, 3)
        finally:
            if process.poll() is None:
                process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
                raise RuntimeError("MCP server did not stop after SIGTERM.")
    if process.returncode != 0:
        raise RuntimeError(f"MCP server exited with {process.returncode}: " + log_path.read_text()[-4000:])
    print(json.dumps({"cliVersion": manifest["version"], "entries": len(entries), "server": server, "toolCount": len(tools), "loginAvailable": True, "toolsReadySeconds": ready_seconds, "home": "empty", "packageManagers": "blocked"}))
