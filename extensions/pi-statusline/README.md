# pi-statusline

Pi extension that replaces the footer with a compact, theme-aware status line.

Package name:

```text
@pdobranov/pi-statusline
```

Pi entrypoint:

```text
./index.ts
```

The footer is split into a left-aligned activity/status area and a right-aligned
model/context area. Each section is rendered as a colored block using Pi's
active TUI theme. The left/right placement and ordering are configurable in
`pi-statusline.json`.

The implementation is split into small modules:

```text
index.ts         extension lifecycle and commands
footer.ts        footer rendering, session usage, git state
config.ts        global/project configuration loading
openai-usage.ts optional OpenAI subscription usage integration
```

## v0.1 scope decision

OpenAI subscription usage will remain in v0.1, but it must be isolated,
documented, and explicitly opt-in before publishing. The statusline now only
starts subscription timers/API requests when the `subscription` section is shown
and `openaiSubscription.enabled` is `true`.

## Configuration

Configuration is loaded from these paths:

```text
<agentDir>/pi-statusline.json                  global configuration
<cwd>/<CONFIG_DIR_NAME>/pi-statusline.json     optional project override
```

In the standard Pi distribution these are normally:

```text
~/.pi/agent/pi-statusline.json
<cwd>/.pi/pi-statusline.json
```

Precedence is defaults, then global configuration, then project configuration.
Files may contain only the fields they need to override. The project file is
read only when `ctx.isProjectTrusted()` is true; otherwise it is ignored. This
prevents a globally installed extension from honoring repository-controlled
configuration before trust is established.

Copy `config.example.json` to either path as a starting point.

Default config:

```json
{
  "left": ["cwd", "git", "session", "status"],
  "right": ["context", "model"],
  "openaiSubscription": {
    "enabled": false,
    "showResetTimes": false
  }
}
```

Available section names:

```text
cwd
git
session
subscription
status
context
model
```

The arrays control both placement and order. To move a section, move its name
between `left` and `right`. To hide a section, remove it from both arrays.

OpenAI subscription usage is disabled by default. To opt in, include
`subscription` in `left` or `right` and set `openaiSubscription.enabled` to
`true`. Set `openaiSubscription.showResetTimes` to `true` to append relative
reset times for each displayed window.

Examples:

```json
{
  "left": ["cwd", "git", "subscription"],
  "right": ["session", "context", "model"],
  "openaiSubscription": {
    "enabled": true,
    "showResetTimes": true
  }
}
```

```json
{
  "left": ["cwd", "git"],
  "right": ["subscription", "context", "model"],
  "openaiSubscription": {
    "enabled": true,
    "showResetTimes": true
  }
}
```

After editing either config file, reload the layout with:

```text
/pi-statusline refresh
```

This refreshes the statusline config and redraws the footer without a full
`/reload`.

## Footer sections

### 1. Current directory

Example:

```text
pi ~/p/pi-playground
```

Shows the current working directory using a fish-style path abbreviation:

- `$HOME` is collapsed to `~`.
- Parent directories are shortened to their first character.
- The final directory name is kept in full.

Shown when `cwd` is present in `left` or `right`.

### 2. Git state

Example:

```text
git main a1b2c3d + ahead 1 behind 3
```

Shows repository state when the current directory is inside a git repository:

- branch name from pi's footer data or from `git status`
- short commit SHA
- dirty working-tree indicator as `+`
- ahead/behind counts compared with upstream

The block is green when clean and amber when there are dirty files. Git data is
refreshed asynchronously so rendering stays responsive.

### 3. Session usage

Example:

```text
in 12.4k out 3.1k R8.0k W1.2k $0.042
```

Shows accumulated usage for the current pi session:

- assistant message usage
- nested tool usage when tools report it
- compaction and branch-summary usage
- cache read/write tokens when present
- estimated total cost

The `R... W...` cache portion is hidden until cache usage exists. This section
is hidden until usage exists.

### 4. OpenAI subscription limits

Example:

```text
OpenAI 5h-28% | 7d-89%
```

Shows ChatGPT/OpenAI subscription rate-limit windows after explicit opt-in and
when an OpenAI/Codex OAuth subscription is detected. Both
`openaiSubscription.enabled: true` and a visible `subscription` section are
required. The percentage shown is **remaining quota**, not used quota.

Data source:

```text
https://chatgpt.com/backend-api/wham/usage
```

The implementation is adapted from `vendor/pi-extensions/packages/pi-powerline`.

What it shows:

- hourly/short-window remaining percentage when available
- weekly/long-window remaining percentage when available
- up to three prioritized windows
- short windows are shown before weekly windows

Color behavior:

- green: healthy quota
- amber: low quota, stale data, or fetch warning
- red: critically low quota

Refresh behavior:

- on session start
- every 60 seconds
- after each turn
- when the model changes

Credential lookup:

1. Environment variables:

   ```text
   OPENAI_CODEX_OAUTH_TOKEN
   OPENAI_CODEX_ACCESS_TOKEN
   CODEX_OAUTH_TOKEN
   CODEX_ACCESS_TOKEN
   ```

2. Optional account id overrides:

   ```text
   OPENAI_CODEX_ACCOUNT_ID
   CHATGPT_ACCOUNT_ID
   ```

3. Pi OAuth credentials for the active model/provider.
4. Local Codex auth files such as `~/.codex/auth.json` for account id lookup.

Possible fallback displays:

- `OpenAI ...` — usage is loading
- `OpenAI no OAuth` — no OAuth token was found
- `OpenAI HTTP NNN` — endpoint returned an HTTP error
- `OpenAI fetch failed` — network, timeout, or parsing failure

By default, normal display omits reset times to keep the footer compact. With
`openaiSubscription.showResetTimes: true`, each displayed window includes a
relative reset time, for example:

```text
OpenAI 5h-28% reset 2h14m | 7d-89% reset 4d5h
```

### 5. Extension statuses

Example:

```text
indexing docs
```

Shows status text published by other extensions through `ctx.ui.setStatus()`.

Behavior:

- statuses are sorted by extension/status key
- ANSI/control characters are stripped
- at most three status blocks are shown
- hidden when no extensions have active statuses

### 6. Context usage

Example:

```text
ctx 42% ###----- 52k/128k
```

Shows current context-window usage for the active model:

- percentage used
- simple text progress bar
- used tokens / context window tokens when available

Color behavior:

- cyan: normal
- amber: 70% or higher
- red: 90% or higher

Hidden when no context-window size is known.

### 7. Model and thinking level

Example:

```text
openai/gpt-5 high
```

Shows the active model:

- model id
- provider prefix when multiple providers are available
- current thinking level when pi exposes one

Shown when `model` is present in `left` or `right`.

## Rendering notes

The status line intentionally avoids separator glyphs; color blocks provide the
visual grouping.

When there is not enough terminal width:

- the right side is preserved first
- the left side is truncated with `...`
- colors come from the active Pi theme
- ANSI colors are disabled when `NO_COLOR` is set, `FORCE_COLOR=0`, or
  `TERM=dumb`
