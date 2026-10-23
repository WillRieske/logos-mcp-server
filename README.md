# Logos Bible Software MCP Server + Socratic Bible Study Agent

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that connects [Claude Code](https://docs.anthropic.com/en/docs/claude-code) to [Logos Bible Software](https://www.logos.com/), plus a custom Socratic Bible study agent that uses these tools for guided theological dialogue.

This project started from Rob Pecoraro's [robrawks/LogosBibleSoftwareMCP](https://github.com/robrawks/LogosBibleSoftwareMCP).

## What This Does

- **27 MCP tools** that let Claude read Bible text, search Scripture, navigate Logos, access your notes, highlights, favorites and clippings (without the clipped book text), check reading plans and per-book progress, browse your reading history and passage lists, explore word studies and factbook entries, search your library catalog, find which of your books cover a passage, open commentaries and lexicons, run cross-resource searches, check what Logos is showing, and diagnose environment issues
- **A Socratic Bible Study agent** that guides you through Scripture using questions (not lectures), welcoming any denominational background, with four questioning layers: Observation, Interpretation, Correlation, and Application
- **A QA Tool Tester agent** that systematically exercises all tools and produces a pass/fail/skip report

## Prerequisites

| Requirement | Details |
|-------------|---------|
| **macOS or Windows** | macOS uses the `open` command and AppleScript; Windows uses the registered `logos4:` protocol handler and `tasklist`. On Windows, window titles and open tabs, focus restore and word-study typing use small PowerShell helpers (Windows PowerShell 5.1, built in); both Logos and Verbum are detected |
| **Logos Bible Software** | macOS: `/Applications/Logos.app` (tested with v48); Windows: standard install under `%LOCALAPPDATA%\Logos` (tested with v54) |
| **Node.js** | v18+ (v23+ recommended for native `fetch` support) |
| **Claude Code** | Anthropic's CLI tool ([install guide](https://docs.anthropic.com/en/docs/claude-code)) |
| **Biblia API Key** | Free key from [bibliaapi.com](https://bibliaapi.com/) |
| **Xcode Command Line Tools** | On macOS, `clang` is required to compile the window-list helper used by `get_logos_state` (install: `xcode-select --install`) |
| **macOS permissions** | Screen Recording permission for your terminal app (System Settings → Privacy & Security → Screen Recording) lets `get_logos_state` read Logos's window titles; Automation/Accessibility permission is prompted on first AppleScript use (detecting whether Logos is running) |

## Setup

### 1. Clone the repo

```bash
git clone https://github.com/WillRieske/logos-mcp-server.git
cd logos-mcp-server
```

### 2. Install dependencies and build

```bash
cd logos-mcp-server
npm install
npm run build
cd ..
```

### 3. Get a Biblia API key

1. Go to [bibliaapi.com](https://bibliaapi.com/)
2. Sign up for a free account
3. Copy your API key

### 4. Create `.mcp.json` in the project root

```json
{
  "mcpServers": {
    "logos": {
      "command": "node",
      "args": ["logos-mcp-server/dist/index.js"],
      "env": {
        "BIBLIA_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

### 5. Create `.env` in the project root (optional, for development)

```
BIBLIA_API_KEY=your_api_key_here
```

### 6. Verify it works

```bash
claude
```

Once Claude Code starts, type `/mcp` to check that the "logos" server appears with 27 tools.

## Using with Claude Desktop or Cowork

The same server can be used with Claude Desktop or other MCP clients. Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "logos": {
      "command": "node",
      "args": ["/Users/you/logos-mcp-server/logos-mcp-server/dist/index.js"],
      "env": {
        "BIBLIA_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

Use an **absolute path** in `args` — relative paths only resolve when the client is launched from the repo root, which is not guaranteed for desktop apps. The same absolute-path rule applies to any MCP client (Claude Code's `.mcp.json` works with relative paths only because it is loaded from the project root).

## Available Tools

### Bible Text & Reading
Tools for retrieving, reading, and comparing Bible text

| Tool | What it does |
|------|-------------|
| `get_bible_text` | Retrieves passage text (LEB default; also KJV, ASV, DARBY, YLT, WEB) |
| `get_passage_context` | Gets a passage with surrounding verses for context |
| `compare_passages` | Compares two Bible references for overlap, subset, or ordering |
| `get_available_bibles` | Lists all Bible versions available for text retrieval |

### Navigation & UI
Tools that open things in the Logos desktop app

| Tool | What it does |
|------|-------------|
| `navigate_passage` | Opens a passage in the Logos UI (in your most-used Bible, or one you name), and confirms it opened |
| `open_word_study` | Runs Bible Word Study for a word: on Windows it opens an empty study and types the word into it (moves the real keyboard for a few seconds — see [Word Study](#word-study)); elsewhere it opens the study empty for you to type into |
| `open_factbook` | Opens a Factbook entry for a person, place, event, or topic; confirms it opened; lists the choices (labels and IDs, not Logos's descriptions) when a name matches several entries |
| `open_resource` | Opens a specific commentary, lexicon, or other resource in Logos at a passage, and confirms it opened |
| `open_guide` | Opens a Passage Guide or Exegetical Guide for a passage, or a Topic Guide for a topic, and confirms it opened |
| `get_logos_state` | Checks whether Logos is running and lists its open window titles (macOS and Windows) and, on Windows, its open tabs |

**How opens are confirmed.** `navigate_passage`, `open_resource`, `open_guide`, `open_factbook` and `search_all` watch Logos's own history (`history.db`) after sending the link. The reply says the item opened, that Logos was already showing it, or that Logos did not confirm it (usually because Logos is busy). On a Logos version without `history.db`, they report that the link was sent, as before.

**Focus restore (Windows).** Logos jumps to the front whenever it is sent a link. On Windows the server then gives the foreground back to the window you were in (it waits about 0.7 s for Logos to finish, then re-asserts for up to 1 s). It leaves focus alone when you were already in Logos. Set `LOGOS_RESTORE_FOCUS=false` (or `0`/`no`/`off`) in the `env` block to keep Logos in front instead (the default is on). `diagnose` shows the current mode.

### Search & Discovery
Tools for searching Bible text and library resources

| Tool | What it does |
|------|-------------|
| `search_bible` | Searches Bible text for words, phrases, or topics |
| `get_cross_references` | Finds related passages by extracting key terms |
| `scan_references` | Finds Bible references embedded in arbitrary text |
| `search_all` | Runs a search across ALL resources in your library (not just Bible text) in Logos's Search panel, and confirms it opened |

### Library & Resources
Tools for browsing your owned library catalog

| Tool | What it does |
|------|-------------|
| `get_library_catalog` | Searches your owned resources (commentaries, lexicons, etc.) by type, author, or keyword |
| `get_resource_types` | Shows a summary of resource types and counts in your library |
| `find_passage_resources` | Lists the commentaries, study Bibles and other books you own that cover a passage (filter by kind and commentary purpose) |

**Opening your commentaries on a passage.** Ask "open my exegetical commentaries on John 5:14": the assistant calls `find_passage_resources` (`passage: "John 5:14"`, `kind: "commentary"`, `purpose: "exegetical"`) and then `open_resource` for each book you choose. Results are ordered commentaries first, then by how often you open each book — not by your Passage Guide prioritization list, which Logos keeps on Faithlife's servers rather than on disk.

### Personal Study Data
Tools for accessing your notes, highlights, favorites, reading plans and history

| Tool | What it does |
|------|-------------|
| `get_user_notes` | Reads your study notes from Logos |
| `get_user_highlights` | Reads your highlights: style, resource, the passage covered, and date |
| `get_clippings` | Reads your saved clippings: titles, sources, collections, tags and your notes (not the clipped text) |
| `get_favorites` | Lists your saved favorites/bookmarks |
| `get_reading_progress` | Shows your reading plans: sessions read, next reading, days behind schedule |
| `get_resource_reading_progress` | Shows how far you've read in each book (percent, last read) |
| `get_reading_history` | Lists what you've opened in Logos recently, newest first |
| `get_passage_lists` | Lists your saved passage lists and their passages |

### Study Workflows
Tools for structured study paths

| Tool | What it does |
|------|-------------|
| `get_study_workflows` | Lists the study workflow templates by title, and your active instances with their progress (not the template steps) |

### System & Diagnostics
Tools for troubleshooting and verifying your setup

| Tool | What it does |
|------|-------------|
| `diagnose` | Checks Logos data paths, database availability, and API configuration |

### Structured output

Every tool that reads your Logos data (notes, highlights, clippings, favorites, reading plans and progress, history, passage lists, workflows, library catalog, resource types, passage resources) accepts `format: "json"`. JSON mode returns the underlying records, minus any Logos book content — readable *and* raw Logos references, ISO dates, resource IDs and titles — for building reading plans or feeding other tools, and allows a `limit` of up to 1,000. A store your Logos version doesn't have comes back as `null`.

## Using the Socratic Bible Study Agent

Start Claude Code in the project directory, then:

```
/agent socratic-bible-study
```

The agent will ask what you want to study and guide you through Scripture using the Socratic method. It's tradition-neutral -- it works with any denominational background and presents multiple perspectives where Christians disagree. It guides you through four layers:

1. **Observation** - "What does the text say?"
2. **Interpretation** - "What does the text mean?"
3. **Correlation** - "How does this relate to the rest of Scripture?"
4. **Application** - "What does this mean for us?"

### Example session starters

- "Let's study Romans 8:28-30"
- "I want to do a word study on 'justification'"
- "What does the Bible teach about grace?"
- "Walk me through Psalm 23"

## Project Structure

```
logos-mcp-server/                      # repo root
├── .claude/
│   └── agents/
│       ├── socratic-bible-study.md    # Socratic agent definition
│       └── tool-tester.md            # QA agent for testing all 27 tools
├── .mcp.json                          # MCP server config (you create this)
├── .env                               # API key (you create this)
├── logos-mcp-server/
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── index.ts                   # MCP server entry point (27 tools)
│   │   ├── cli.ts                     # Diagnose CLI entry point
│   │   ├── config.ts                  # Paths, link style, API config, constants
│   │   ├── types.ts                   # Shared TypeScript types
│   │   ├── services/
│   │   │   ├── reference-parser.ts    # Bible reference normalization
│   │   │   ├── logos-books.ts         # Logos book numbers and raw references
│   │   │   ├── biblia-api.ts          # Biblia.com REST API client
│   │   │   ├── logos-urls.ts          # Links the UI tools send to Logos
│   │   │   ├── logos-app.ts           # Launching links (with focus restore); is Logos running
│   │   │   ├── knowledge-lookup.ts    # Factbook names -> knowledge-base IDs
│   │   │   ├── db.ts                  # Shared read-only SQLite helpers
│   │   │   ├── sqlite-reader.ts       # Read-only Logos SQLite access
│   │   │   ├── study-data.ts          # Reading plans, progress, history, passage lists
│   │   │   ├── catalog-reader.ts      # Library catalog search and passage coverage (catalog.db)
│   │   │   ├── open-confirm.ts        # Every link: send it, confirm it in Logos's history
│   │   │   ├── powershell.ts          # Runs the Windows helper scripts
│   │   │   ├── ui-driver.ts           # Input driver interface for word-study typing
│   │   │   ├── ui-driver-windows.ts   # Windows driver (PowerShell, SendInput, UI Automation)
│   │   │   ├── input-consent.ts       # Consent for the input watcher
│   │   │   ├── word-study.ts          # open_word_study on Windows: open, type the word, press Enter, confirm by history
│   │   │   ├── word-study-tool.ts     # open_word_study: consent, then the run, then the consent note
│   │   │   └── logos-window-state.ts  # Window titles and tabs (macOS and Windows)
│   │   └── utils/                     # clippings.ts, output.ts, strip-markup.ts, tool-text.ts, ui-lock.ts (one UI operation at a time)
│   ├── tests/                         # Vitest suite; helpers/ builds fixture databases and runs the server over stdio
│   └── dist/                          # Built output (after npm run build)
```

Run the tests with `cd logos-mcp-server && npm test`. They use fixture databases, so they don't need Logos or a Biblia API key.

## How It Works

The MCP server integrates with Logos through four channels:

- **Biblia API** - Retrieves Bible text and search results via the free REST API from Faithlife (same company as Logos)
- **URL schemes** - Opens passages, resources, guides and Factbook entries in the Logos app using `logosres:` and `logos4:` links (via `open` on macOS, the registered protocol handler on Windows); see [Logos Link Style](#logos-link-style)
- **SQLite databases** - Reads your personal data (notes, highlights, favorites, workflows, reading plans and progress, history, passage lists), the library catalog and its passage coverage, and Logos's history to confirm opens, directly from the Logos local database files (read-only access, never modifies your data)
- **Simulated input** - `open_word_study` types the word into Bible Word Study (see [Word Study](#word-study))

## Logos Data Path

The server auto-detects your Logos data by scanning for the per-install instance directory:

```
macOS:    ~/Library/Application Support/Logos4/Documents/<instance-id>/
Windows:  %LOCALAPPDATA%\Logos\Documents\<instance-id>\
```

Each Logos install uses a randomly named instance directory (e.g. `a3wo155q.w14`); detection prefers the directory containing `LibraryCatalog/catalog.db`, so there is no fixed path to configure. If your Logos data lives at a non-standard path, the `LOGOS_DATA_DIR` and `LOGOS_CATALOG_DIR` environment variables remain available as manual overrides (set them in `.mcp.json`). The library catalog lives under `Data/` (not `Documents/`) — set `LOGOS_CATALOG_DIR` if your catalog path differs:

```json
{
  "mcpServers": {
    "logos": {
      "command": "node",
      "args": ["logos-mcp-server/dist/index.js"],
      "env": {
        "BIBLIA_API_KEY": "your_key",
        "LOGOS_DATA_DIR": "/path/to/your/Logos4/Documents/xxxx.w14",
        "LOGOS_CATALOG_DIR": "/path/to/your/Logos4/Data/xxxx.w14"
      }
    }
  }
}
```

## Logos Link Style

Logos 54 ignores the `logos4:///…?…` query-string links older versions accepted, so by default the server sends the link formats verified on Logos 54. Set `LOGOS_LINK_STYLE` in the `env` block of `.mcp.json` to choose:

| Value | Links sent | Use when |
|---|---|---|
| `current` (default) | `logosres:<resource>;ref=…` for passages and resources; `logos4:Guide;t=<title>;ref=…`, `logos4:Factbook;ref=<id>` and `logos4:Search;kind=AllSearch;q=…;syntax=v2` | Current Logos (verified on Logos 54, Windows) |
| `legacy` | The `logos4:///Bible/…`, `logos4:///Guide?t=…&ref=…`, `logos4:///Factbook?ref=…`, `logos4:///WordStudy?word=…` and `logos4:///Search?kind=AllSearch&syntax=v2&q=…` URLs used before | Older Logos versions where the current formats open nothing (reported to work on macOS Logos 48) |

```json
"env": {
  "BIBLIA_API_KEY": "your_key",
  "LOGOS_LINK_STYLE": "legacy"
}
```

Factbook entries and Topic Guides are opened by knowledge-base ID (e.g. `bk.#Moses`). With `current`, the server looks names up in Logos's own index, `Data/<instance-id>/AutoComplete/AutoComplete.db`, which Logos builds the first time it runs. With `legacy`, Factbook links take the topic name as before, so `open_factbook` refuses a `kb_id`.

### Logos book numbers

Logos numbers Bible books its own way in stored references: Genesis–Malachi are 1–39, the deuterocanon 40–60, and Matthew–Revelation 61–87 (so `bible.66.8.28` is Romans 8:28). Notes and highlights are labeled with that numbering; references in the 40–60 range are shown as the raw Logos string.

## Word Study

Logos 54 ignores a word placed in a link, so `open_word_study` on Windows opens an empty Bible Word Study (its word box is already focused with the previous word selected), types the word, and presses Enter. Example: *"Run a word study on hope."* or, for Greek and Hebrew, `g:agape` / `h:hesed`.

It checks that Logos is the front window before every key and that the focus is in a text box before typing, stops the moment you use the mouse or keyboard or switch windows (instantly with the input watcher, `LOGOS_INPUT_LISTENER`; otherwise on its next check), never uses the mouse or the clipboard, and puts your window back afterwards (`LOGOS_RESTORE_FOCUS`). It then reads Logos's history and reports what Logos recorded for the study; if that differs from the word asked for, or no study is recorded, the reply says so rather than claiming success. It takes a few seconds: leave the PC alone until it finishes.

**Noticing you instantly (`LOGOS_INPUT_LISTENER`).** The input watcher only notices *that* input happened (never which key or where), only while it types, and is removed afterwards. The first word study asks your permission once through your MCP client and remembers the answer in the server's `settings.json` (`%LOCALAPPDATA%\logos-mcp\settings.json`). Set `LOGOS_INPUT_LISTENER` to `on` or `off` in the `env` block to decide without being asked (`ask` is the default). If your client can't ask, word study runs without the watcher and says how to turn it on. If your answer can't be saved, the reply notes it and you are asked again next time.

**Packaged hosts.** Inside the Claude desktop app (an MSIX-packaged app), Windows redirects that `settings.json` to `%LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Local\logos-mcp\settings.json`. `diagnose` prints both paths. Setting `LOGOS_INPUT_LISTENER` in the `env` block always works.

## Troubleshooting

**Quick diagnostic check** - Run `cd logos-mcp-server && npm run diagnose` to verify all data paths, databases, and API configuration before launching Claude Code.

**"BIBLIA_API_KEY is not set"** - Get a free key at [bibliaapi.com](https://bibliaapi.com/) and add it to the `env` block in `.mcp.json`. Bible-text tools need it, but Logos-local tools (notes, highlights, clippings, library catalog) work without it.

**"Database not found"** - Logos isn't installed, or your data is at a non-standard path. Locate your databases (macOS: `find ~/Library/Application\ Support/Logos4 -name "*.db" -maxdepth 5`; Windows PowerShell: `Get-ChildItem $env:LOCALAPPDATA\Logos -Recurse -Filter *.db`) and set `LOGOS_DATA_DIR`.

**Tools don't appear in `/mcp`** - Restart Claude Code. The MCP server is loaded at startup from `.mcp.json`.

**Logos doesn't open passages** - Make sure Logos Bible Software is running before using the navigation tools. On an older Logos version, try `LOGOS_LINK_STYLE=legacy` (see [Logos Link Style](#logos-link-style)). If a tool replies that "Logos did not confirm opening it", Logos is probably busy (still starting or indexing): a link can then start a second `Logos.exe` that opens nothing — wait until Logos responds, end the extra process, and try again.

**"Logos's lookup table was not found"** - `open_factbook` and Topic Guides find entries in `AutoComplete.db`, which Logos builds when it first runs. Open Logos once and let it finish starting, or pass a knowledge-base ID such as `bk.#Moses` directly.

**Book content is encrypted in local resource files** — the server doesn't read book text: Logos's terms don't permit passing it to an AI. Use Logos's own Study Assistant for summaries.

## Limitations

- **Word study** - no Logos 54 link carries the word (13 formats tried), so `open_word_study` types it into an empty study, on Windows only. On macOS and other platforms it opens the study empty and asks you to type the word; with `LOGOS_LINK_STYLE=legacy` it sends the legacy link. See [Word Study](#word-study).
- **Sermon Starter Guide** - opens via link, but without the requested theme: Logos ignores the subject in the link.

## License

MIT
