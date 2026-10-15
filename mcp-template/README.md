# StreamBIM MCP via n8n

Expose [StreamBIM](https://streambim.com) operations to MCP clients (Cursor, Claude Desktop, etc.) **through n8n**, using the community package **`n8n-nodes-streambim`** and n8n’s built-in **Model Context Protocol** support—not a separate MCP process.

## Prerequisites

1. **n8n** with **AI/LangChain** nodes (MCP Server Trigger and Call n8n Sub-Workflow Tool ship with `@n8n/n8n-nodes-langchain`).
2. This repo’s **`n8n-nodes-streambim`** installed on the n8n instance ([deploy locally](../deploy-local.sh) or npm install).
3. A **StreamBIM API** credential in n8n (region subdomain, Bearer `idToken` or username/password per [authentication](https://github.com/jonatanjacobsson/n8n-nodes-streambim) / [StreamBIM API auth](../../streambim-api-docs-master/api/authentication.md)).

## Architecture (recommended)

| Piece | Role |
|--------|------|
| **MCP Server Trigger** | Exposes an HTTP **SSE** or **streamable HTTP** MCP endpoint (not stdio). Connects **only** to **tool** outputs ([docs](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-langchain.mcptrigger/)). |
| **Call n8n Sub-Workflow Tool** | Each tool calls a **subworkflow** that starts with an **Execute Workflow trigger** and contains the **StreamBIM** node ([docs](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolworkflow/)). |
| **StreamBIM** node | Performs API calls; assign the **StreamBIM API** credential on each subworkflow. |

Optional alternative: **[Instance-level MCP](https://docs.n8n.io/advanced-ai/accessing-n8n-mcp-server/)** (Settings → Instance-level MCP) exposes whole workflows to MCP clients with OAuth2 or an access token—useful if you prefer “run this workflow” instead of fine-grained tools.

## Transport and clients

- The MCP Server Trigger uses **SSE** or **streamable HTTP**, **not** stdio.
- **Claude Desktop / Cursor** often use **`npx mcp-remote <MCP_URL>`** with **Bearer** auth to bridge to the SSE URL ([MCP Server Trigger docs](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-langchain.mcptrigger/) — “Integrating with Claude Desktop”).
- **Instance-level MCP** uses HTTP to `/mcp-server/http` with a **personal MCP access token** ([docs](https://docs.n8n.io/advanced-ai/accessing-n8n-mcp-server/)).

Example (conceptual — replace URL and token):

```json
{
  "mcpServers": {
    "n8n-streambim-mcp": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://YOUR_N8N_HOST/mcp/sse/STREAMBIM_PATH",
        "--header",
        "Authorization: Bearer YOUR_MCP_BEARER_TOKEN"
      ]
    }
  }
}
```

Use the **Test** or **Production** URL exactly as shown on the MCP Server Trigger node after you publish the workflow.

## Hosting and reverse proxies

- **Queue mode / multiple webhooks:** Route all **`/mcp*`** traffic to **one** webhook worker so SSE/streamable connections stay sticky ([limitations](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-langchain.mcptrigger/)).
- **nginx:** Disable buffering and gzip on the MCP location; see the same docs (“Running the MCP Server Trigger node with a reverse proxy”).

## Importing the template workflows

Files in [`workflows/`](workflows/):

| File | Purpose |
|------|---------|
| `streambim-sub-list-projects.json` | Subworkflow: **Project → Get Many** (optional JSON query string). |
| `streambim-sub-invite-user.json` | Subworkflow: **User → Invite User** (email + project). |
| `streambim-sub-list-topics.json` | Subworkflow: **Topic → Get Many** (project + optional query JSON). |
| `streambim-mcp-parent.json` | Parent: **MCP Server Trigger** + three **Call n8n Sub-Workflow Tool** nodes (wire workflow IDs after import). |

### Steps

1. Import the three **`streambim-sub-*.json`** workflows. Note each **workflow ID** (from the URL or workflow settings).
2. Import **`streambim-mcp-parent.json`**.
3. Open the parent workflow. For **each** Call n8n Sub-Workflow Tool node, set **Workflow** to the matching imported subworkflow and map **Workflow inputs** if prompted (names must match the Execute Workflow trigger inputs).
4. Create **HTTP Bearer Auth** (or Header Auth) credentials for **MCP clients** and attach them to the **MCP Server Trigger** (this secures the MCP endpoint—not StreamBIM; StreamBIM uses the credential on the StreamBIM node in each subworkflow).
5. On each **StreamBIM** node in the subworkflows, assign your **StreamBIM API** credential (replace any placeholder).
6. Replace placeholder **`YOUR_PROJECT_ID`** in subworkflows with a real project ID, or pass `projectId` from the tool each time.
7. **Activate** the parent workflow and use the **Production MCP URL** in your MCP client.

## Placeholders

- **`YOUR_PROJECT_ID`**: Default project ID in subworkflows—replace with a real StreamBIM project id or override via tool inputs where expressions allow.
- **Credential IDs** in JSON may not match your instance; re-select credentials in the UI after import.

## API reference

- [StreamBIM API docs (local)](../../streambim-api-docs-master/README.md)
- [n8n MCP Server Trigger](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-langchain.mcptrigger/)
- [n8n instance MCP](https://docs.n8n.io/advanced-ai/accessing-n8n-mcp-server/)

## Extending

Duplicate a subworkflow and change the StreamBIM **Resource** / **Operation**, or add more **Call n8n Sub-Workflow Tool** nodes to the parent. Keep subworkflows small and test them with **Execute workflow** before exposing them as tools.
