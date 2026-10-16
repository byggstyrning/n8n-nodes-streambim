# n8n-nodes-streambim

**StreamBIM** automation for [n8n](https://n8n.io/): one community node that talks to the **StreamBIM** cloud API—tenant by **region**, JSON:API gateway, IFC search, converter jobs, sync, topics, checklists, users, workflows, attachments, and documents—so you can orchestrate BIM collaboration where your projects already live.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/reference/license/) workflow automation platform.

> ### Breaking changes in v8
>
> The StreamBIM node has been bumped to `typeVersion: 8` (package `0.2.0`).
> Several per-resource field **names** and the **list pagination UI** have
> changed (raw JSON Query Parameters → `Filters` fixedCollection, custom
> `List Pagination + Page Size + Skip + Max Pages` → n8n-standard
> `Return All + Limit`). **Migration:** open each existing StreamBIM node,
> re-pick the resource/operation, and confirm filters and pagination, then
> save the workflow.

[Installation](#installation)  
[Resources (API surface)](#resources-api-surface)  
[Credentials](#credentials)  
[Compatibility](#compatibility)  
[Usage](#usage)  
[Development](#development)  
[Resources (links)](#resources-links)  
[License](#license)

---

## Installation

n8n loads third-party nodes from your **[n8n user folder](https://docs.n8n.io/hosting/configuration/user-folder/)** (often `~/.n8n` on the host, or `/home/node/.n8n` in the official Docker image). Self-hosted instances use one or both of:

| Mechanism | What it is | Official docs |
|-----------|------------|----------------|
| **Community nodes** | Packages named `n8n-nodes-*` installed from npm (or the in-app installer, which uses the same layout). | [Community nodes](https://docs.n8n.io/integrations/community-nodes/), [Manual install from npm](https://docs.n8n.io/integrations/community-nodes/installation/manual-install/) |
| **Custom nodes** | Extra directories n8n scans on startup (default subfolder **`custom`** under the user folder, or paths in **`N8N_CUSTOM_EXTENSIONS`**). | [Custom nodes location](https://docs.n8n.io/hosting/configuration/configuration-examples/custom-nodes-location/) |

### Requirements

- **Self-hosted n8n** (community and custom nodes are not supported on n8n Cloud the same way).
- Node.js **18.10+** for building from source (see `package.json` `engines`).
- A **StreamBIM** account in the correct **region** (subdomain), e.g. `https://app.streambim.com` → region `app`. Regions: [global.streambim.com/regions.json](https://global.streambim.com/regions.json).

### Install via Community Nodes (recommended)

1. Open n8n → **Settings** → **Community nodes**.
2. **Install**, enter **`n8n-nodes-streambim`**, confirm, then **reload** n8n when prompted.

This uses n8n’s supported community-node flow (see [Community nodes](https://docs.n8n.io/integrations/community-nodes/)).

### Manual install — Community Nodes (`~/.n8n/nodes`)

Use this when you install from npm yourself (e.g. queue mode or a private registry), following n8n’s guide:

1. Open a shell **as the same user / container** that runs n8n.
2. Create the nodes directory if needed and enter it (paths match the [manual install](https://docs.n8n.io/integrations/community-nodes/installation/manual-install/) docs):

   ```bash
   mkdir -p ~/.n8n/nodes
   cd ~/.n8n/nodes
   ```

3. Install the package:

   ```bash
   npm install n8n-nodes-streambim
   ```

4. Restart n8n.

### Manual install — Custom nodes directory

Use this when you ship a **built copy** of the package (your own `dist/` + `package.json`) or mount a folder from Git without publishing to npm:

1. Build the package (`pnpm install && pnpm run build`).
2. Place the **entire package folder** (with `package.json` and `dist/`) under a directory n8n treats as **custom extensions**—by default **`~/.n8n/custom/`**, or a path listed in **`N8N_CUSTOM_EXTENSIONS`** (semicolon-separated list). See [Specify location for your custom nodes](https://docs.n8n.io/hosting/configuration/configuration-examples/custom-nodes-location/).
3. Restart n8n.

---

## Resources (API surface)

This package ships **one node**:

| In n8n        | Role |
|---------------|------|
| **StreamBIM** | Single node with a **Resource** dropdown (StreamBIM product areas) and per-resource **operations**. |

**Resource** options (high level):

- **Project** — List/get projects (`/mgw/api/v3/...` JSON:API style).
- **IFC Search** — Create searches and export IFC-backed query results.
- **Converter Job** — IFC converter jobs and status (model pipeline in StreamBIM).
- **IFC File** — IFC model file assignments: list, get linked document, create, and update links between documents, buildings, and model layers (`/project-{id}/api/v1/v2/ifc-files`). See [ifc-files.md](https://github.com/jonatanjacobsson/streambim-api-docs/blob/master/api/ifc-files.md).
- **Sync** — Sync trigger, activity, configs, statuses (per-project URLs where applicable).
- **Topic** — Topics (issues) CRUD.
- **Checklist** — Checklist export and listing.
- **User** — Users, invites, groups, email settings, project members (global and project-scoped lists), deactivate project member (inactive / privilege-level 0).
- **Workflow** — Project workflows CRUD.
- **Attachment** — List (also by IFC object + building), download, upload to topic (incl. presigned upload flow). **Link Document** attaches a project document to one element (GUID) or to a property value, i.e. to every element that has it; with *Skip If Already Linked* it never adds a duplicate.
- **Building** — List/get buildings (model layers, floor plan layer, floors).
- **Floor** — List/get floors; set or clear a floor's custom floor plan document.
- **Document Alignment** — A 2D document (PDF/DWG) placed in a building: display name, two image/world control points, optional mask. List, get, create, delete (`{documentId}-{buildingId}`).
- **Relink** — Move model-layer, placement and floor-plan mappings from deleted documents to their successors after a file moved in the source CDE. See [Relink](#relink-after-a-move-in-the-source-cde).
- **Document Link** — Keep documents linked to the elements that name them: e.g. every element with `Text.Sheet Number = A-101` gets the drawing `A-101.pdf`. Links to deleted documents are removed. See [Document links by property](#document-links-by-property).
- **Document** — Documents (PDFs, drawings, IFC files), folders, download links, export JSON. **Upload** upserts a file into a folder (creates a new document or adds a revision when the filename already exists in that folder). Create/Update are for metadata-only changes without re-uploading bytes. Get Many can filter by ifc-file assignment per building (`Missing IFC File` + `IFC File Building`), by `External ID` (the sync integration's id) and by `Since`.

**Important distinction:** **Document** and **Attachment** are separate resources in StreamBIM:
- **Documents** are the main file management system — PDFs, drawings, IFC files organized in folders with revisions, labels, and permissions at the folder level.
- **Attachments** are BCF-style files attached to topics (issues), viewpoints, or comments — screenshots, annotations, supporting files for collaboration.

Operations and fields follow StreamBIM’s HTTP APIs; the node adds pagination helpers for list endpoints where relevant.

---

## Credentials

Credential type: **StreamBIM API**.

| Field | Purpose |
|--------|---------|
| **Region** | Tenant subdomain, e.g. `app`, `sweden`. Builds `https://{region}.streambim.com`. |
| **Authentication** | **Bearer token** (recommended, including MFA accounts) or **Username and password** (login per run; MFA not supported on this path). |

**Credential test**

The checker follows the same pattern as core n8n credentials (e.g. Baserow / Form.io): hidden expirable **`sessionToken`**, **`preAuthentication`** for username/password login, **`authenticate`** for `Authorization` + JSON:API headers, and a small **`test`** `GET` to `/mgw/api/v3/projects` so a bad region or token fails fast.

---

## Compatibility

- **`n8n-workflow`**: peer `*` (build targets a current 1.x workflow typings line; use an n8n release that matches your other community nodes).
- **StreamBIM**: API paths and JSON:API headers are aligned with StreamBIM’s gateway as used by this package; if StreamBIM changes major API versions, bump the node `typeVersion` and operations in-repo accordingly.

---

## Usage

1. Install the package and restart n8n.
2. Add a **StreamBIM** node from the node panel (search **StreamBIM**).
3. Create **StreamBIM API** credentials: set **Region**, then either paste a **Bearer** `idToken` from a completed login or use **Username and password** for non-MFA accounts.
4. Pick **Resource** and **Operation**; choose **Project** where a **Project Name or ID** is required (dropdown loads from the API using your credential).

**Uploading files to the document library:** use **Document → Upload**. Provide a target **Folder**, connect binary input (e.g. from Read/Write Files or an upstream node), and optionally override the filename. The node creates a new document or adds a revision automatically when the same filename already exists in that folder. To upload a file that lives elsewhere (e.g. a signed download URL from ACC or S3) without storing it in n8n, set **Source** to **URL** and give the **Source URL**, the exact **File Size** in bytes and a **Filename**: the file is streamed straight from the URL into StreamBIM storage, and the upload fails if the URL serves a different number of bytes.

**Region** must match the organization you log into in the browser.

### Relink after a move in the source CDE

When a synced file moves in the source (ACC or SharePoint move or folder rename, Interaxo workflow step change), the StreamBIM sync creates a **new** document and soft-deletes the old one. Every mapping stays on the deleted document:

- its model layer (`ifc-files` row) stays active, so conversions keep using the frozen last revision;
- its placement (`document-alignments`) stays;
- floors keep showing it as their custom floor plan.

A file **deleted** at the source (delete and upload again) can make StreamBIM hard-delete the document together with its placement.

The same happens with your own uploads. A file uploaded with **Document → Upload** and an **External ID** (the source's id, e.g. an ACC lineage URN) into a new folder leaves the older copy live, because no sync deletes it. Plan treats the older live uploads with the same External ID as moved and keeps the newest copy. Apply moves their mappings and then soft-deletes them, but only when all of their mappings were moved. Synced documents (paths under `INTERAXO`, `ACC`, `SHAREPOINT`, `STREAMBIM`) never count.

Two operations fix this:

1. **Relink → Plan**
   - **What it does:** records the current mappings, triggers the StreamBIM sync and waits for it, then lists every mapping left on a deleted or vanished document, together with the successor and the actions to move it. It changes nothing in StreamBIM.
   - **The record:** kept per project in the n8n user folder (`.n8n/streambim-relink/`). Mappings of documents that StreamBIM hard-deletes, even in a sync outside the flow, can therefore still be restored.
   - **Source inventory (optional):** input items with an id and a path, such as Interaxo Content Search or an ACC/SharePoint folder listing.
   - **`link_profile`:**
     - `by_external_id` is certain: the source kept the file id. This is the ACC lineage URN, the SharePoint driveItem id or the Interaxo file id.
     - `by_filename` is a guess after a re-upload.
     - `none` means no successor was found.
   - **`warnings`:** `tie`, `archive_folder`, `layer_conflict` or `uncalibrated_floor`.
   - **`kind`:** `ifcFile` (model layer), `drawing` (placement and floor plans), or `document` (an older upload to retire).
2. **Relink → Apply**
   - **What it does:** runs the actions of the selected items and verifies each one.
     - Model layer: new layer row first, then the old one is marked for deletion.
     - Drawing: same floor(s) first, then the placement is copied, the old one removed and the display name set.
   - **Which items:** by default only certain links without warnings (`Apply` = Certain Links Only).
   - **Conversion:** afterwards it starts one conversion per building whose model layers changed, after any conversion already running there. Drawings need no conversion.

Notes:

- **Floor PATCH replaces the whole record.** The Floor resource and Relink always send back name, height, hidden and floor bounds.
- **A sync trigger can be lost.** StreamBIM may answer OK and never sync, so Plan re-triggers after 2 minutes with no sign of a sync.
- **A sync that outlasts the timeout** is planned on the current state and marked `sync.finished: false`.

### Document links by property

**Document Link → Sync by Property** links documents to elements by a property value. It is built to run nightly from a Schedule Trigger.

| Field | Example | Meaning |
|-------|---------|---------|
| **Property** | `Text.Sheet Number` | Property set and property name. Every element that has it is included. |
| **File Extensions** | `pdf` | Document types that may be linked. Empty means any. |
| **Remove Links to Deleted Documents** | on | Removes links whose document was deleted or moved at the source. |
| **Dry Run** | on | Only reports. Turn it off to write. |

**What a run does**

1. **Finds the values.** An IFC search per building finds every element where the property exists. The elements are grouped by value.
2. **Links each value.** Each value is a StreamBIM *property-based virtual object*. A link on it shows on every element with that value, including elements added later.
3. **Finds the document.** It is the one live document whose filename without extension equals the value (case-insensitive). If two or more documents match, the value is reported as `ambiguous` and nothing is linked.
4. **Leaves existing links alone.** That includes links to other documents.
5. **Respects manual removals.** A link someone removed by hand is not created again, unless **Link Again After Manual Removal** is set.
6. **Removes dead links.** A link is removed when its document was soft-deleted or no longer exists. Each one is confirmed with a GET first. When a file moves at the source, StreamBIM soft-deletes the old document and creates a new one, so the same run links the new document and removes the old link.
7. **Follows revisions.** A link points at the document, not at a revision, so a new revision needs no change.

**Output** (option): one item per value (default), changes only, or a single summary.

- `link`: `planned` / `created` / `exists` / `removed_by_user` / `none` / `error`.
- `unlinked`: the removed links, each with a `reason` of `document_deleted` or `document_missing`.

Limits:

- Links on values that no element carries any more are not visited, because StreamBIM cannot list attachments without the value.
- The match is on the exact filename stem: `A-101 rev B.pdf` does not match `A-101`.

---

## Development

Notes for **maintainers** editing this repo—not required for a normal install (see [Installation](#installation) above).

- **Build:** `pnpm install` then `pnpm run build` (TypeScript + icons).
- **Test:** `pnpm test` compiles and runs `test/*.test.js` with Node's built-in test runner (relink planner, no network).
- **Release:** bump `version` in `package.json`, merge to `main`, then push a matching tag (`git tag v0.3.0 && git push origin v0.3.0`). The **Publish** workflow checks that the tag matches the version, then tests, builds and publishes to npm with a provenance statement through npm trusted publishing (OIDC). It needs no npm token.
- **`deploy-local.sh`:** convenience script for a **local Docker** n8n: wipes `dist/`, rebuilds, copies the package into a **custom extensions** directory on disk, and runs `docker compose restart n8n`. Adjust **`TARGET_DIR`** and **`DOCKER_COMPOSE_DIR`** in the script to match your machine; it is not part of the published npm package contract.

---

## Resources (links)

- [StreamBIM](https://streambim.com/)
- [n8n community nodes](https://docs.n8n.io/integrations/community-nodes/)
- [n8n user folder](https://docs.n8n.io/hosting/configuration/user-folder/)
- [Custom nodes location / `N8N_CUSTOM_EXTENSIONS`](https://docs.n8n.io/hosting/configuration/configuration-examples/custom-nodes-location/)

---

## Acknowledgement

Thanks to the **StreamBIM** team for the product APIs and to the **n8n** team for the community-node model (including credential `preAuthentication` / `authenticate` patterns this package follows).

---

## License

[MIT](LICENSE.md)
