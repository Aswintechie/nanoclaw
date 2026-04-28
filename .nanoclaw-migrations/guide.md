# NanoClaw Migration Guide

Generated: 2026-04-28
Base: `eba94b7` (last shared commit with `upstream/main`)
HEAD at generation: `c892eea`
Upstream HEAD: `f8c3d02` (v2.0.14)
Local version: 1.2.53 → upgrading to 2.0.14 (major bump, channels architecture refactor)

## Migration Plan

This is a v1 → v2 migration. The local fork's slack channel comes from a sibling fork (`qwibitai/nanoclaw-slack`) that uses `@slack/bolt` Socket Mode directly. v2 has refactored channels into a `chat-adapter` plug-in architecture, so the qwibitai-slack fork is being **dropped** in favor of v2's first-class `add-slack` skill.

Order of operations in the worktree:
1. **Worktree starts at clean `upstream/main`** (v2.0.14). No skill branch merges needed — the 31 skill dirs in `.claude/skills/` are already inherited from upstream.
2. **Install v2 Slack** via `/add-slack` skill (fetches `upstream/channels` branch, copies adapter, installs `@chat-adapter/slack`). User will need to re-authenticate (existing tokens may not transfer).
3. **Reapply TT device mounts** in v2's `src/container-runner.ts` (different injection point — mounts are now `VolumeMount[]` and `--device` args go before the volumes loop).
4. **Reapply sudo entrypoint** in v2's `container/Dockerfile`. v2 spawns via `--entrypoint bash -c 'exec bun run /app/src/index.ts'`, so we need a custom entrypoint script and update the spawn to use it.
5. **Reapply model pin** as a v2 settings.json entry (v2 reads model from `data/v2-sessions/<agent-group-id>/.claude-shared/settings.json`, not from code).

Risk areas:
- Slack channel swap: existing slack tokens may need re-auth on v2; existing `groups/slack_main` directory naming may not match v2's `data/v2-sessions/` layout.
- v2's container Dockerfile uses Bun and a different layout; sudo customization must adapt.
- Existing `data/sessions/` (v1) vs new `data/v2-sessions/` (v2) — data migration may be needed (separate concern, NOT in this guide).

## Applied Skills

None from `upstream/skill/*` branches. v2's `add-slack` will be applied as a fresh skill in the worktree.

**Custom skills:** None. The 31 skill dirs in `.claude/skills/` are inherited from upstream and require no special handling.

## Skill Interactions

None — only one customization-touching skill (`add-slack`) is being applied.

## Customizations

### 1. Tenstorrent device + hugepages mounts in container spawn

**Intent:** Container needs access to the Tenstorrent accelerator at `/dev/tenstorrent/0` and 1GB hugepages at `/dev/hugepages-1G` for tt-metal workloads inside the agent. Mounts are existence-gated so the container still spawns on machines without the device.

**Files:** `src/container-runner.ts`

**v1 implementation (for reference):**
```typescript
// In v1's spawn-args building section, before the volume mounts loop:
const ttDevice = '/dev/tenstorrent/0';
if (fs.existsSync(ttDevice)) {
  args.push('--device', ttDevice);
}
const hugepages = '/dev/hugepages-1G';
if (fs.existsSync(hugepages)) {
  args.push('-v', `${hugepages}:${hugepages}`);
}
```

**How to apply on v2:**

In `src/container-runner.ts`, locate the spawn args building section. The v2 layout (around line 454-480) is:

```typescript
// Host gateway
args.push(...hostGatewayArgs());

// User mapping
const hostUid = process.getuid?.();
const hostGid = process.getgid?.();
if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
  args.push('--user', `${hostUid}:${hostGid}`);
  args.push('-e', 'HOME=/home/node');
}

// Volume mounts
for (const mount of mounts) { ... }
```

Insert the TT-device block **between the User mapping and Volume mounts sections** (i.e., right before `// Volume mounts`):

```typescript
// Tenstorrent device + hugepages (existence-gated for non-TT machines)
const ttDevice = '/dev/tenstorrent/0';
if (fs.existsSync(ttDevice)) {
  args.push('--device', ttDevice);
}
const hugepagesPath = '/dev/hugepages-1G';
if (fs.existsSync(hugepagesPath)) {
  args.push('-v', `${hugepagesPath}:${hugepagesPath}`);
}
```

Make sure `fs` is imported at the top of the file (likely already is — check).

### 2. Sudo + writable passwd/shadow + UID-mapping entrypoint in Dockerfile

**Intent:** When the container runs under the host's UID (not 0 and not 1000 — see `--user` block in `src/container-runner.ts`), that UID isn't in `/etc/passwd`. `sudo` and many other tools fail without a passwd entry. Solution: ship sudo with `NOPASSWD:ALL`, make passwd/shadow writable, and have the entrypoint append a passwd row at runtime if the UID is unmapped. This is needed for tt-metal builds inside the container which require sudo for various device operations.

**Files:** `container/Dockerfile`, plus a new entrypoint script and a tweak to `src/container-runner.ts` spawn args (because v2 uses an inline `bash -c` entrypoint by default).

**v1 implementation (for reference):**
- `sudo` added to apt-get install
- `chmod 666 /etc/passwd /etc/shadow` after install
- `NOPASSWD:ALL` sudoers file at `/etc/sudoers.d/all`
- Inline entrypoint script that appends `agent:x:$(id -u):$(id -g)::/home/node:/bin/bash` to `/etc/passwd` if `id -un` fails

**How to apply on v2:**

v2's Dockerfile has a different layout (uses Bun, separate package install, etc.) and v2 spawns containers with `--entrypoint bash` and `-c 'exec bun run /app/src/index.ts'`. We need to:

1. **In `container/Dockerfile`**, add to the apt-get install list (in the existing `apt-get install -y --no-install-recommends` block):
   ```
   sudo \
   ```

2. **After the apt-get install block**, add:
   ```dockerfile
   # Make passwd/shadow writable so the entrypoint can append host UID rows at runtime
   RUN chmod 666 /etc/passwd /etc/shadow

   # Passwordless sudo for any user (container is already isolated)
   RUN echo 'ALL ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/all && chmod 0440 /etc/sudoers.d/all
   ```

3. **Create a wrapper entrypoint script** `container/entrypoint.sh` (new file):
   ```bash
   #!/bin/bash
   set -e
   # If running as an unmapped UID, add it to /etc/passwd so sudo and other
   # tools that look up the user can work.
   if ! id -un 2>/dev/null; then
     echo "agent:x:$(id -u):$(id -g)::/home/node:/bin/bash" >> /etc/passwd
     echo "agent:!:19999::::::" >> /etc/shadow
   fi
   exec bun run /app/src/index.ts
   ```

   In the Dockerfile, copy and chmod it:
   ```dockerfile
   COPY entrypoint.sh /usr/local/bin/nanoclaw-entrypoint.sh
   RUN chmod +x /usr/local/bin/nanoclaw-entrypoint.sh
   ```

4. **In `src/container-runner.ts`**, change the entrypoint spawn args. v2 currently does:
   ```typescript
   args.push('--entrypoint', 'bash');
   ...
   args.push(imageTag);
   args.push('-c', 'exec bun run /app/src/index.ts');
   ```

   Replace with:
   ```typescript
   args.push('--entrypoint', '/usr/local/bin/nanoclaw-entrypoint.sh');
   ...
   args.push(imageTag);
   // Note: drop the `'-c', 'exec bun run /app/src/index.ts'` line — entrypoint script handles it
   ```

### 3. Pin agent model to claude-opus-4-6

**Intent:** Always use Claude Opus 4.6 with the 1M context extension for the agent. v1 hardcoded this in `container/agent-runner/src/index.ts:441`. v2 has refactored model selection to read from a settings.json file inside the container.

**Files:** `data/v2-sessions/<agent-group-id>/.claude-shared/settings.json` (per-agent-group, configured after first spawn)

**v1 implementation (for reference):**
```typescript
// container/agent-runner/src/index.ts:441
{
  ...,
  model: 'claude-opus-4-6',
  ...
}
```

**How to apply on v2:**

Per the v2 docs (`docs/ollama.md`), the Claude Code CLI reads its model from `~/.claude/settings.json` inside the container, which v2 bind-mounts from `data/v2-sessions/<agent-group-id>/.claude-shared/settings.json`.

After the first agent spawn in v2 (which auto-creates the directory), edit:
```
data/v2-sessions/<agent-group-id>/.claude-shared/settings.json
```

Add or set:
```json
{
  "model": "claude-opus-4-6",
  ...
}
```

Note: this is per-agent-group. If multiple groups exist, repeat for each. Alternative: add a default to the v2 init template if one exists (check `src/init-group-filesystem.ts` or similar in the v2 worktree before manually editing).

### 4. Slack channel — drop qwibitai/nanoclaw-slack, install via v2's `/add-slack` skill

**Intent:** Replace the v1 `@slack/bolt` direct integration (sourced from the `qwibitai/nanoclaw-slack` fork) with v2's `@chat-adapter/slack` integration via the `add-slack` skill. The v1 implementation worked but is incompatible with v2's channels architecture.

**Files:** Multiple — handled by the skill.

**How to apply on v2:**

In the worktree, run the `/add-slack` skill (or follow its SKILL.md manually):

1. Fetch the channels branch:
   ```bash
   git fetch origin channels    # the skill says origin; in our setup use upstream
   ```
   Adapt: `git fetch upstream channels`

2. Follow the skill's instructions to copy the slack adapter and install `@chat-adapter/slack`.

3. **Re-authenticate Slack** — existing tokens (in `data/sessions/slack_main/` v1 layout) likely need to be re-set up because v2 stores them differently. The skill should walk through this.

4. **Group naming:** v1 used `groups/slack_main` (with `groups/telegram_main` symlinked from it). v2 uses `data/v2-sessions/<agent-group-id>/`. Group identity will need to be re-registered. Existing CLAUDE.md content from `groups/telegram_main/CLAUDE.md` should be copied to the new v2 location after first registration. **THIS IS USER DATA — DO NOT TOUCH AUTOMATICALLY**, just remind the user to copy it manually.

## Things explicitly NOT migrating

- The custom slack `src/channels/slack.ts` (297 lines, `@slack/bolt`) — replaced by v2 chat-adapter slack.
- The `package.json` deps `@slack/bolt`, `@slack/types` — replaced by `@chat-adapter/slack`.
- Inherited skill SKILL.md files — already in upstream, will appear automatically.
- Fork-sync GitHub Actions tweaks (commits like `a1c3adf`, `e130976`, `b38f389`, etc.) — these were CI-only, not user customizations of NanoClaw functionality. v2's CI is different; if needed they can be redone after.

## Post-upgrade reminders

- Copy `groups/telegram_main/CLAUDE.md` into the new v2 group dir once the slack channel is re-registered (this is the tt-metal team rules + sweep validation knowledge — losing it would be bad).
- Move scheduled task `task-1774626652557-9a6uuo` (the daily Teams summary at `0 7 * * *`) into v2's task store if format differs.
- Verify `data/sessions/slack_main/.claude` (v1 cache) is either copied or deleted; v2 uses `data/v2-sessions/<group-id>/.claude-shared/`.
- The current `groups/slack_main → telegram_main` symlink workaround is v1-specific; v2 group identity is database-driven, no symlink trick needed.
