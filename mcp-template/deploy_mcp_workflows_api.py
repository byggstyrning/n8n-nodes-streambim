#!/usr/bin/env python3
"""
Deploy StreamBIM MCP template workflows via n8n Public API (POST/PUT /api/v1/workflows).

Requires:
  N8N_API_URL   — e.g. http://127.0.0.1:5678
  N8N_API_KEY   — Settings → API in n8n

Optional:
  STREAMBIM_CREDENTIAL_ID — replaces YOUR_STREAMBIM_CREDENTIAL_ID on StreamBIM nodes
  N8N_EXTERNAL_URL        — printed in summary links (defaults to N8N_API_URL)

Usage:
  set -a && . /path/to/ifcpipeline/.env && set +a
  python3 deploy_mcp_workflows_api.py
  python3 deploy_mcp_workflows_api.py --dry-run
  python3 deploy_mcp_workflows_api.py --activate
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from copy import deepcopy
from pathlib import Path

# Keys returned by GET /workflows/{id} that must not be sent back on PUT (varies by version).
PUT_STRIP_KEYS = frozenset(
    {
        "tags",
        "shared",
        "activeVersion",
        "versionId",
        "meta",
        "pinData",
        "createdAt",
        "updatedAt",
        "active",
    }
)


def env(name: str, default: str | None = None) -> str | None:
    v = os.environ.get(name)
    return v if v not in (None, "") else default


def api_request(
    method: str,
    base: str,
    path: str,
    api_key: str,
    body: dict | None = None,
) -> tuple[int, dict | list | str | None]:
    url = base.rstrip("/") + path
    data = None
    headers = {
        "Accept": "application/json",
        "X-N8N-API-KEY": api_key,
    }
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            raw = resp.read().decode("utf-8")
            status = resp.status
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8")
        status = e.code
        try:
            parsed = json.loads(raw) if raw else None
        except json.JSONDecodeError:
            parsed = raw
        return status, parsed

    if not raw:
        return status, None
    try:
        return status, json.loads(raw)
    except json.JSONDecodeError:
        return status, raw


def list_workflows(base: str, api_key: str) -> list[dict]:
    """Fetch all workflows (paginated)."""
    out: list[dict] = []
    cursor: str | None = None
    while True:
        q = "/api/v1/workflows?limit=100"
        if cursor:
            q += "&cursor=" + urllib.parse.quote(cursor, safe="")
        status, data = api_request("GET", base, q, api_key)
        if status != 200:
            raise RuntimeError(f"List workflows failed HTTP {status}: {data}")
        if not isinstance(data, dict) or "data" not in data:
            raise RuntimeError(f"Unexpected list response: {data!r}")
        batch = data["data"]
        out.extend(batch)
        cursor = data.get("nextCursor")
        if not cursor:
            break
    return out


def find_workflow_id_by_name(workflows: list[dict], name: str) -> str | None:
    for w in workflows:
        if w.get("name") == name:
            return w.get("id")
    return None


def strip_for_put(wf: dict) -> dict:
    """Prepare GET workflow payload for PUT."""
    body = {k: v for k, v in wf.items() if k not in PUT_STRIP_KEYS}
    return body


def post_payload_from_export(export: dict, credential_id: str | None) -> dict:
    """Body for POST /workflows (export JSON from file)."""
    nodes = deepcopy(export["nodes"])
    if credential_id:
        for node in nodes:
            creds = node.get("credentials") or {}
            sb = creds.get("streamBimApi")
            if isinstance(sb, dict) and sb.get("id") == "YOUR_STREAMBIM_CREDENTIAL_ID":
                sb["id"] = credential_id
    return {
        "name": export["name"],
        "nodes": nodes,
        "connections": export["connections"],
        "settings": export.get("settings") or {"executionOrder": "v1"},
    }


def patch_parent_tool_refs(parent_export: dict, ids: dict[str, str]) -> dict:
    """
    ids keys: list_projects, invite_user, list_topics
    """
    out = deepcopy(parent_export)
    mapping = {
        "Tool_List_Projects": ("list_projects", "StreamBIM MCP Sub: List Projects"),
        "Tool_Invite_User": ("invite_user", "StreamBIM MCP Sub: Invite User"),
        "Tool_List_Topics": ("list_topics", "StreamBIM MCP Sub: List Topics"),
    }
    for node in out["nodes"]:
        name = node.get("name")
        if name not in mapping:
            continue
        key, cached_name = mapping[name]
        wid = ids[key]
        params = node.setdefault("parameters", {})
        params["workflowId"] = {
            "__rl": True,
            "value": wid,
            "mode": "list",
            "cachedResultName": cached_name,
        }
    return out


def save_workflow(
    base: str,
    api_key: str,
    export: dict,
    credential_id: str | None,
    existing_id: str | None,
    dry_run: bool,
) -> str:
    if dry_run:
        payload = post_payload_from_export(export, credential_id)
        print(f"[dry-run] {'PUT' if existing_id else 'POST'} {export['name']!r} size={len(json.dumps(payload))}")
        return existing_id or "dry-run-id"

    if existing_id:
        status, current = api_request("GET", base, f"/api/v1/workflows/{existing_id}", api_key)
        if status != 200 or not isinstance(current, dict):
            raise RuntimeError(f"GET workflow {existing_id} failed: {status} {current}")
        fresh = post_payload_from_export(export, credential_id)
        body = strip_for_put(current)
        body["name"] = fresh["name"]
        body["nodes"] = fresh["nodes"]
        body["connections"] = fresh["connections"]
        body["settings"] = fresh["settings"]
        status, updated = api_request("PUT", base, f"/api/v1/workflows/{existing_id}", api_key, body)
        if status != 200:
            raise RuntimeError(f"PUT workflow {existing_id} failed HTTP {status}: {updated}")
        if not isinstance(updated, dict) or "id" not in updated:
            raise RuntimeError(f"Unexpected PUT response: {updated!r}")
        return updated["id"]

    payload = post_payload_from_export(export, credential_id)
    status, created = api_request("POST", base, "/api/v1/workflows", api_key, payload)
    if status != 200:
        raise RuntimeError(f"POST workflow failed HTTP {status}: {created}")
    if not isinstance(created, dict) or "id" not in created:
        raise RuntimeError(f"Unexpected POST response: {created!r}")
    return created["id"]


def activate_workflow(base: str, api_key: str, workflow_id: str, dry_run: bool) -> None:
    if dry_run:
        print(f"[dry-run] POST /api/v1/workflows/{workflow_id}/activate")
        return
    status, data = api_request("POST", base, f"/api/v1/workflows/{workflow_id}/activate", api_key, {})
    if status != 200:
        raise RuntimeError(f"Activate failed HTTP {status}: {data}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Deploy StreamBIM MCP workflows via n8n API")
    parser.add_argument("--dry-run", action="store_true", help="Print actions only")
    parser.add_argument(
        "--activate",
        action="store_true",
        help="Activate the parent workflow (StreamBIM MCP Server) after deploy",
    )
    parser.add_argument(
        "--dir",
        type=Path,
        default=Path(__file__).resolve().parent / "workflows",
        help="Directory containing template JSON files",
    )
    args = parser.parse_args()

    base = env("N8N_API_URL", "http://127.0.0.1:5678")
    api_key = env("N8N_API_KEY")
    if not api_key and not args.dry_run:
        print("error: N8N_API_KEY is not set (load ifcpipeline/.env or export it).", file=sys.stderr)
        return 1

    external = env("N8N_EXTERNAL_URL", base)
    cred_id = env("STREAMBIM_CREDENTIAL_ID")
    if not cred_id and not args.dry_run:
        print(
            "warning: STREAMBIM_CREDENTIAL_ID not set; StreamBIM nodes keep placeholder id "
            "(create credential in n8n and re-run, or set the env var).",
            file=sys.stderr,
        )

    d = args.dir
    files = {
        "list_projects": d / "streambim-sub-list-projects.json",
        "invite_user": d / "streambim-sub-invite-user.json",
        "list_topics": d / "streambim-sub-list-topics.json",
        "parent": d / "streambim-mcp-parent.json",
    }
    for key, path in files.items():
        if not path.is_file():
            print(f"error: missing {path}", file=sys.stderr)
            return 1

    exports = {k: json.loads(path.read_text(encoding="utf-8")) for k, path in files.items()}

    workflows: list[dict] = []
    if not args.dry_run:
        workflows = list_workflows(base, api_key)  # type: ignore[arg-type]

    ids: dict[str, str] = {}

    for key in ("list_projects", "invite_user", "list_topics"):
        ex = exports[key]
        existing = find_workflow_id_by_name(workflows, ex["name"]) if workflows else None
        ids[key] = save_workflow(
            base,
            api_key or "",
            ex,
            cred_id,
            existing,
            args.dry_run,
        )
        print(f"subworkflow {key}: id={ids[key]}")

    parent_patched = patch_parent_tool_refs(exports["parent"], ids)
    parent_existing = (
        find_workflow_id_by_name(workflows, parent_patched["name"]) if workflows else None
    )
    parent_id = save_workflow(
        base,
        api_key or "",
        parent_patched,
        None,
        parent_existing,
        args.dry_run,
    )
    print(f"parent: id={parent_id}")

    if args.activate:
        activate_workflow(base, api_key or "", parent_id, args.dry_run)

    ui_base = external.rstrip("/")
    print("\nEditor links:")
    print(f"  parent:   {ui_base}/workflow/{parent_id}")
    for k, sk in (
        ("list_projects", "StreamBIM MCP Sub: List Projects"),
        ("invite_user", "StreamBIM MCP Sub: Invite User"),
        ("list_topics", "StreamBIM MCP Sub: List Topics"),
    ):
        print(f"  {k}: {ui_base}/workflow/{ids[k]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
