# Last.fm Lens

A magnifier for tidying up scrobbles. Feed it a Last.fm scrobble CSV and it produces a report of
everything worth looking at before you start editing: duplicate artists, combined artist names,
inconsistent track titles, missing or clashing albums, duplicate scrobbles and long-tail oddities.

It never edits anything. Every finding is a **scored suspicion (0–100)** with the clues that fired,
the number of scrobbles affected and the concrete evidence, so you decide.

## What is in this folder

| Path | What it is |
|---|---|
| `index.html` | **The tool**, built and committed so GitHub Pages can serve it at <https://marcosmarinm.github.io/lastfm-lens/>. One file, ~130 KB, no dependencies. Anyone drops their own CSV into it; the analysis runs on their machine and nothing is uploaded. |
| `lastfm-report.html` | **Your report**, self-contained: filters, search, Accept/Discard decisions, downloads. Personal, so it is **git-ignored**. |
| `README.md` | This file. |
| `lastfmstats-MarcosMarinM.csv` | The input file. Untouched, and git-ignored. |
| `src/engine.js` | The analysis engine. All the rules live here. |
| `src/template.html` | The interface (HTML + CSS + UI code). |
| `src/build.js` | Packs the engine into the template → a single HTML file. |
| `src/cli.js` | Command line: CSV in, report out. |

The `.md`, `.csv` and `.json` versions of a report are **not** kept in the folder, because the report
page can produce them itself with the buttons at the top (and the CLI regenerates them on demand). Your
scrobbles (`.csv`) and your report are never committed: they are in `.gitignore`.

## The published site

<https://marcosmarinm.github.io/lastfm-lens/> is `index.html`, served from the root of `main`. It is the
empty tool: **no data of anyone's is inside it**. To publish a change, rebuild and push:

```bash
node src/build.js      # rewrites index.html
git commit -am "Rebuild the tool"
git push
```

## How any of this is generated

Nothing is hand-written or produced by a language model. Three commands, all deterministic:

```bash
# 1. the report (HTML + Markdown + actions CSV) and the empty tool
node src/cli.js lastfmstats-MarcosMarinM.csv lastfm-report

# 2. only the empty tool that the site serves
node src/build.js

# 3. any other CSV: the output prefix is optional (defaults to lastfm-report)
node src/cli.js someone-else.csv their-report
```

`src/cli.js` reads the CSV, runs `src/engine.js` and writes `<prefix>.html`, `<prefix>.csv` and
`<prefix>.md` to this folder, plus a fresh `index.html`. Build steps are `engine.js` inlined
into `template.html` by `build.js`; no bundler, no dependencies, no network.

The same CSV always produces exactly the same report.

## Is it code or AI?

Code, entirely. `src/engine.js` has no model, no API and no network calls: just deterministic
functions — normalised keys, sets of tracks, counts and a bounded edit distance. Every rule can be
read and changed.

## How the findings are scored

Points 0–100, plus the signals that fired, the impact in scrobbles and the evidence. Confidence
bands: **high** ≥ 70, **medium** ≥ 45, **low** below that.

Four rules keep the noise down:

1. **Sharing a track is the strong proof.** Two artist names are only proposed as duplicates if they
   share at least one track, or if the names are identical bar capitalisation, accents or
   punctuation. Looking similar is not evidence — the old “they start with the same letters” rule was
   deleted, because it produced pairs like *Clara Bell* / *Claudia Belmonte*.
   If **every** track of one name also sits under the other, that is flagged as an alarm: almost
   certainly the same artist split across two entries.
2. **The long tail does not shout.** A one-scrobble typo also needs a shared track or to fall in the
   same listening session before it can rise above *low*.
3. **Combined names resolve to the first artist.** `Ana, Bruno Salas y Cata` → `Ana`, because
   `Ana` exists separately. If the first artist does not exist, the first one that does is used, with
   a warning that it may not be the main artist. Names such as `Nina & Cata` are only flagged when
   the base artist also exists on its own. The same name written without its separator
   (`Ana Bruno`) is swept into the same finding, because it is the same artist spelled differently.
4. **Nothing is ever merged into a combined name.** If the most frequent form of a duplicate pair is
   itself a combined name, the others are not renamed into it: they go straight to the artist it
   stands for. So `Ana Bruno` points at `Ana` and never at `Ana, Bruno`, and each artist yields one
   card rather than two proposing the same rename. Anything folded away this way is counted in the
   summary (`coveredByStronger`), so nothing disappears quietly.
5. **Warnings where the data can mislead.** e.g. an album whose name matches the track title is a
   classic bad auto-tag, so it scores lower and says so, instead of proposing you spread the error.

The “correct” value when two candidates are possible is chosen by `RULES.canonical`
(`score` by default: most recent + most frequent + most complete; `recent` and `frequent` are the
other two). All three are shown on the card, and if one of them contradicts the choice, the card
warns you.

`RULES.minimumConfidence` (`high` | `medium` | `low`) decides which findings are reported;
everything omitted is counted in the summary, so you always know what was left out.

## Making the changes in Last.fm

Artist, track and album edits are retroactive: Last.fm offers to apply them to every scrobble of that
combination, and renaming an artist affects the whole entry. It is a bulk change — look twice.
Marking a finding **Accept** or **Discard** in the report only affects the actions CSV you download.
Deleting a duplicate scrobble is done one at a time, from the (⋯) menu.

## Privacy

The report page runs entirely in your browser. No server, no upload, no requests. The CSV never leaves
your machine unless you share the report yourself.
