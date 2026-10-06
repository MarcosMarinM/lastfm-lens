# Last.fm Lens

A magnifier for tidying up scrobbles. Feed it a Last.fm scrobble CSV and it produces a report of
everything worth looking at before you start editing: duplicate artists, combined artist names,
inconsistent track titles (including likely typos), artist names repeated inside titles, missing or
clashing albums, duplicate scrobbles and long-tail oddities.

It never edits anything. Every finding is a **scored suspicion (0–100)** with the clues that fired,
the number of scrobbles affected and the concrete evidence, so you decide.

## What is in this folder

| Path | What it is |
|---|---|
| `index.html` | **The tool**, built and committed so GitHub Pages can serve it at <https://marcosmarinm.github.io/lastfm-lens/>. One file, ~175 KB, no dependencies. Anyone drops their own CSV into it; the analysis runs on their machine and nothing is uploaded. |
| `lastfm-report.html` | **Your report**, self-contained: filters, search, Accept/Discard decisions, a to-do list and the other downloads. Personal, so it is **git-ignored**. |
| `README.md` | This file. |
| `lastfmstats-MarcosMarinM.csv` | The input file. Untouched, and git-ignored. |
| `src/engine.js` | The analysis engine. All the rules live here. |
| `src/template.html` | The interface (HTML + CSS + UI code). |
| `src/build.js` | Packs the engine into the template → a single HTML file. |
| `src/cli.js` | Command line: CSV in, report out. |
| `src/check-docs.js` | Documentation self-check: fails if a finding type or sub-case is undocumented. |
| `test/engine.test.js` | The test suite. Node's own runner and assertions, no dependencies. |
| `package.json` | Scripts only, no dependencies: `npm test`, `npm run build`, `npm run report`. |

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
# 0. the documentation self-check (both commands below run it too, and stop if it fails)
node src/check-docs.js

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

## Tests

The engine has a test suite, run with Node's own runner (no dependencies, no test framework):

```bash
npm test            # or: node --test
```

It drives the engine the way `cli.js` and the report page do — a CSV in, a report out — and locks the
behaviours this file promises: a run of repeated scrobbles is one finding and not one per starting
position, the canonical form is chosen as described (recency weighted highest), `RULES` overrides are
restored after every call, and the report is deterministic. `npm run check-docs` runs the documentation
check on its own; `cli.js` and `build.js` also run it before writing anything.

## Is it code or AI?

Code, entirely. `src/engine.js` has no model, no API and no network calls: just deterministic
functions — normalised keys, sets of tracks, counts and a bounded edit distance. Every rule can be
read and changed.

## How the findings are scored

Points 0–100, plus the signals that fired, the impact in scrobbles and the evidence. Confidence
bands: **high** from `60` points, **medium** from `40`, **low** below that (`RULES.highThreshold`
and `RULES.mediumThreshold`).

Five rules keep the noise down:

1. **Sharing a track is the strong proof.** An artist rename is only proposed as *work to do* when the
   two names share at least one track, or when they are identical bar capitalisation, accents or
   punctuation. Looking similar is not proof on its own, and the old “they start with the same letters”
   rule was deleted because it produced pairs like *Clara Bell* / *Claudia Belmonte*. What replaced it
   is measured rather than guessed: two names that are alike — at least
   `RULES.similarArtistNameThreshold` alike character by character (87.5% by default, so one character
   in eight), or one an abbreviation of the other (`Cris Lora` / `Cristina Lora`) — are still looked at,
   but a pair with **no track in common is only ever an advisory question**, never a rename to do. When
   they do share tracks, it is a real finding.
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

`RULES.minimumConfidence` (`high` | `medium` | `low`) decides which findings are reported. Nothing
is ever dropped in silence: everything a detector checks and chooses not to list is counted in the
summary, under `summary.trimmed`, and shown at the top of the report. There are four of them:

| Left out | Why | Knob |
|---|---|---|
| Artist-name pairs that share no track | Looking similar is not evidence | `RULES.requireSharedTrack` |
| Album clashes below the minimum impact | The single versus album case is usually legitimate | `RULES.minAlbumImpact` |
| Album-name variants past the cap | It was truncated silently before; now it is counted | `RULES.maxAlbumNameVariants` |
| Findings under the minimum confidence | Keeps the report readable | `RULES.minimumConfidence` |

## Every finding type and sub-case

This is the full list of what the engine can emit, and it is enforced:
`src/check-docs.js` fails if a section or sub-case is missing from this file or from the “How it
works” panel inside the report. Sub-cases are the labels shown on each card.

Inside a section the findings are grouped by sub-case, and the groups are ordered by their strongest
finding, so a sub-case that reaches 75/100 never appears below one that only reaches 52/100. Within a
group the order is confidence, then impact, then points. The other two sort modes in the report
(`Biggest impact first`, `Highest confidence first`) drop the grouping and give a single flat list.

| Section | Sub-case (what fired it) | Proposal | Counts as work? |
|---|---|---|---|
| Duplicate artists | Identical names bar formatting | Rename artist | yes |
| Duplicate artists | One name contained in the other | Rename artist | yes |
| Duplicate artists | Several forms of the same artist | Rename artist | yes |
| Duplicate artists | Very similar names that share tracks | Rename artist | yes |
| Duplicate artists | Very similar names with no shared track | Review artist name | **no, advisory** |
| Combined artists | Name joining several artists | Review combined artist | yes |
| Inconsistent track titles | Formatting only | Merge track title | yes |
| Inconsistent track titles | Capitalisation only | Review capitalisation | **no, advisory** |
| Inconsistent track titles | Qualifier written differently | Merge track title | yes |
| Inconsistent track titles | Featuring credit in one form only | Merge track title | yes |
| Inconsistent track titles | Probably a typo in the title | Merge track title | yes |
| Inconsistent track titles | Titles carrying a platform badge | Merge track title | yes |
| Inconsistent track titles | Probably a different version (live, remix…) | Review track title | **no, advisory** |
| Inconsistent track titles | With and without a qualifier | Merge track title | yes |
| Inconsistent track titles | Different qualifiers | Review track title | **no, advisory** |
| Artist repeated in title | Artist repeated inside the title | Remove artist from title | yes |
| Albums | No album (another scrobble has one) | Fill in album | yes |
| Albums | Album name written in several ways | Merge album name | yes |
| Albums | Capitalisation only | Review capitalisation | **no, advisory** |
| Albums | Several albums for the same title | Review album | **no, advisory** |
| Duplicate scrobbles | Consecutive repeats of the same track | Delete duplicate | yes |
| Long tail and oddities | Probably a typo in the artist name | Rename artist | yes |
| Long tail and oddities | Formatting details inside tags | Review | **no, advisory** |
| Long tail and oddities | Scrobbles with no album | Review | **no, advisory** |
| Long tail and oddities | Artists with two scrobbles or fewer | Review | **no, advisory** |

An **advisory** finding says “this may well be correct, ignore it”: a single and an album are two
different releases, and an artist with two scrobbles is not a mistake. They are labelled on the card
and the report's “Actionable only” filter hides them, so the count of things to do stays honest.

### Very similar names

The one place where the engine looks at how alike two names are. Two names that differ only by an
underscore, a double space or a comma (`Senza_Cri` against `Senza Cri`) need no threshold at all: they
are identical as far as the normalisation is concerned. What this adds is the near-miss: `Jana
Burčeska` against `Jana Burcheska`, `Marlena` against `Maléna`, `Santanna` against `Santana`. Without
it a misspelling with more than a couple of scrobbles stayed invisible, because the long-tail rule
only looks at artists with two scrobbles or fewer.

The comparison is deliberately narrow, because being alike is weak evidence. Two names qualify when
they are alike in one of two shapes:

- **character by character**: at least `RULES.similarArtistNameThreshold` alike (0.875 by default, so
  one character in eight: short names have to be nearly identical, long ones may differ by two
  characters), and at most `RULES.maxSimilarArtistDistance` characters apart;
- **an abbreviation**: the same number of words, every word equal except one, and that one is the
  beginning of the other — `Cris Lora` against `Cristina Lora`, `Caterina Lumina` against `Cate
  Lumina`. The short word must be at least `RULES.minAbbreviationLength` characters and the added part
  at least `RULES.minAbbreviationExtension`, which is what keeps out `Voyage` / `Voyager` (a single
  letter apart, and usually two different acts). Requiring every *other* word to be identical is what
  keeps out `Clara Bell` / `Claudia Belmonte`, where two words differ at once.

On top of that, in both shapes: the names must start with the same letter and be at least
`RULES.minArtistLengthForSimilarCompare` characters long; names that contain one another are left to
the containment rule, and names identical once normalised to the identical-name rule; combined names
(`A, B y C`) are left to the combined-artist rule.

What you get then depends entirely on the tracks:

| They share… | What you get |
|---|---|
| one or more tracks | A rename **to do**, with the tracks in common as evidence: `Jana Burcheska` → `Jana Burčeska`. |
| no track at all | An **advisory** question, “is this really the same artist?”. It never counts as work to do and “Actionable only” hides it. |

Lowering the threshold to `0.85` pulls in pairs like *Martija* / *Martina* and *Voyager* / *Voyage*,
which are usually two different artists. That trade-off is what the `0.875` default is there to make:
with it, the pairs that surface on a real library are the misspellings, not the lookalikes.

### Probably a typo in the title

The one rule that looks at spelling rather than at formatting, because “Patata” against “Patataa” or
“Papata” are different keys and nothing else in the engine would pair them. It is deliberately
narrow, to stay on the right side of false positives:

- same artist, and both titles start with the same letter;
- every title shorter than `RULES.minTitleLengthForTypoCompare` is skipped;
- the rarer spelling is the suspect, so it must have at most `RULES.maxScrobblesForRareTitle`
  scrobbles, and the two forms must differ in volume (with a tie there is no suspect);
- the titles must be within `RULES.maxTitleTypoDistance` characters of each other, or
  `RULES.maxTitleTypoDistanceWithAlbum` when both are scrobbled under the same album;
- titles that differ only by their numbering are never paired: “Lugar I” and “Lugar II”, “Track 1”
  and “Track 2” are different songs, not typos;
- a title carrying a version marker (`live`, `remix`, `acoustic`, `instrumental`…) is skipped, so
  “Tequila & Lemon (Instrumental)” is not merged into “Tequila & Lemon”.

The card still warns you: it only sees the spelling, and a similar name can be a different song.

### Album name variants

“Tutta Vita” against “TUTTA VITA”, “Gira, il mondo gira” against “Gira, Il Mondo Gira”: the same album
written twice, and the proposal is to keep the spelling with the most scrobbles.

The important part is what this rule does **not** do: it never looks across artists. An album is an
(artist, album) pair, so “Amnesia” by one artist and “AMNESIA” by another are two different albums, not
two spellings of one — merging them would tell you to rewrite one artist's album into another artist's.
On the library this change was measured against, a global grouping found 68 cosmetic album-name groups
and **63 of them were cross-artist**, which is why the numbers here dropped from a long list to the
handful that are real. Same-named albums by different artists are everywhere (*All In* by three artists,
*Amnesia* by two), so a finding that points at one of them is worse than no finding at all.

When the two spellings belong to two spellings of the *same* artist (`Sarah` against `Sarah Toscano`,
say), this rule stays quiet on purpose: renaming the artist is the duplicate-artist section's job, and
the album cannot be merged before that happens.

### Capitalisation only

“A Me” against “A me”, “TUTTA VITA” against “Tutta Vita”: the same name written twice, and the only
difference is which letters are capitals.

That is deliberately **not** treated as a fix, because it is not damage. An accent that went wrong
(`guardare giů` for `guardare giù`, `PIŮ CALDA` for `PIÙ CALDA`), a quote that broke (`tutto allâ€™aria`)
or a space that moved is a tagging mistake, and those keep the high score: they are the “Formatting
only” cards. Capitalisation changes nothing about the song or the album, so these findings:

- get their own sub-case and their own group, apart from the fixes above;
- are **advisory**: left out of the action count, and hidden by “Actionable only”;
- score in the medium band, so they never sit above real work in the flat sort modes;
- say so on the card. Whether Last.fm draws a line between two spellings that differ only in
  capitalisation is not something a CSV can tell you, so the card does not claim it either way. If you
  like the library tidy, Accept them into the to-do list; if not, Discard them and they stay quiet.

### Straight and curly apostrophes

`Loin d'ici` and `Loin d’ici` look the same on the page, but Last.fm keeps them apart: they are two
different track entries, and the same goes for an artist (`Guns N' Roses`) or an album. The report
treats them as a “Formatting only” case — a rename to do — and proposes keeping one spelling.

That works because the engine no longer folds the two when it reads the CSV. It used to turn `’` into
`'` on the way in, which left a single spelling to compare and made exactly this variant invisible, the
one case the report exists to catch. The comparison keys (`key`, `artistKey`, `strictTitleKey`) still
throw punctuation away, so the two are read as the same thing wherever that is the right call.

The characters covered are the straight apostrophe plus `’` `‘` `‛` `′` (prime), the backtick and the
acute accent, and the modifier-letter apostrophes `ʼ` `ʻ` `ʾ` `ʿ` — Unicode files those as letters, so
they would slip past a plain punctuation strip. An album whose only difference is the apostrophe is a
“name variant” for the same reason, and the check that treats two album spellings as one now folds the
quotes before deciding.

### Titles carrying a platform badge

“Song (Official Video)”, “Song (Official Audio)”, “Song (Lyric Video)”, “Song (Video Oficial)”, “Song
(Audio)”: the title a video page carries, not the one the track has. It gets its own sub-case because
it is the only signal the engine has about **where a scrobble came from** — a video platform (YouTube,
Vevo) rather than a music player — and because it stays invisible when *every* scrobble of a track
carries the badge, since then there is no clean spelling to compare it against.

The check is strict on purpose: **the whole qualifier has to be the badge**, and at least one core word
(`official`, `oficial`, `audio`, `video`, `lyric`, `lyrics`, `letra`, `visual`, `visualizer`, `mv`, `hd`,
`4k`…) has to be there. A qualifier that merely *contains* one of those words is usually a real credit,
and those are left alone: `from the Prime Video Original Movie`, `Eurovision Official Version`, `Andrew
Maze Official & Skyshot Remix`, `Baby 3 Official Soundtrack`, `Official Song UEFA Euro 2016`.

Two properties of the card are worth knowing:

- the proposal only ever **removes the badge**; it never turns “Song (Visual)” into “Song (feat. X)”.
  Unifying spellings is the job of the other sub-cases, and this one stays local so it cannot ask for
  more than it says;
- a title that repeats the artist *and* carries a badge (“Ana - Song (Official Video)”) is not reported
  here at all: the “Artist repeated in title” finding strips the prefix and the badge in a single card,
  instead of two cards proposing half a fix each.

`(Visual)` and `(Visual Video)` are badges too. `Beggin' (9D Audio)` is not: the qualifier has a word
outside the badge vocabulary, so it is read as the credit it probably is.

### Probably a different version

A qualifier such as `live`, `remix`, `acoustic` or `version` says the recording is not the same one, so
“Patata” against “Patata (live)” is not a title variant to merge: it is a decision to make. These
findings used to sit mixed in with the ordinary “with and without a qualifier” cases, which made the
count of things to do look bigger than the work really is. Now:

- they get their own sub-case and their own group in the report, so “Patata” against “Patata (live)”
  never appears among the plain “Patata” against “Patata” cases;
- they are **advisory**, so they are left out of the action count and hidden by “Actionable only”;
- the proposal now prefers the **plain** form as the target. Choosing on recency or on name length used
  to pick “Amarcord - Acoustic Version” and tell you to turn “Amarcord” into it, which would invent a
  credit those scrobbles never had. The card now reads “Amarcord - Acoustic Version → Amarcord”, and
  that is still only a suggestion: if the plain scrobbles are the mistagged ones, the engine cannot
  know;
- the “different qualifiers” case (`live` against `remix`, say) is advisory for the same reason.

The words that trigger this live in `RE_DIFFERENT_VERSION` in `src/engine.js`: live, en vivo, directo,
acoustic, remix, remaster, instrumental, karaoke, cover, version, demo, mono/stereo, radio edit,
soundtrack, banda sonora, orchestral and a few more.

### A version written two ways is not a different version

Within one title the spellings are first sorted into **versions** by their qualifier: the plain title is
one version, `(Dancebreak Edit)` is another, `(Live)` a third. That matters because a version can itself
be written two ways — `SloMo (Eurovision's Dancebreak Edit)` and `SloMo - Eurovision's Dancebreak Edit`
are the *same* recording, not two of them. So:

- the two written forms of one version are a **rename to do** among themselves (`Qualifier written
  differently`): keep one and apply it to the other;
- only then are the versions compared with one spelling each, and that comparison is the **advisory**
  one (`Probably a different version`). Plain `SloMo` is never lumped in with the edit.

Before this split the whole group was treated as one finding, which proposed renaming both written forms
of the edit into plain `SloMo` — the exact thing the section exists to warn against.

## Reading the report

The page is one list, and every control exists to cut it down:

| Control | What it does |
|---|---|
| **Section** chips | Each section is a switch: click its chip to take that section out of the list (*Duplicate scrobbles*, say), click it again to put it back, and **Everything** switches them all back on. A section that is off is dimmed and struck through. The number on each chip is how many findings are in it. This is the only way to leave a section out in the two flat sort modes, where the sections are not drawn at all; there the heading also names the sections that are off and offers a **Show them** button, so the dimmed chip is not the only clue. The choice is remembered per report, next to your Accept / Discard marks. |
| **Confidence** chips | High, medium and low. Combine one with the section switches to see, say, only the high-confidence album findings (switch the other sections off). |
| **Search** | Looks at everything a finding mentions, not just its title: the signals, the evidence tables, the artist and album names in them. Searching `Senza_Cri` finds it even when it only appears inside a table. |
| **Sort** | *Grouped by category* keeps the sections and their sub-cases, ordering the groups inside a section by their strongest finding (within a group it is confidence, then impact, then points). *Biggest impact first* and *Highest confidence first* drop the grouping and give one flat list. |
| **Density** | *auto* shows a group as one line per finding when it holds more than 25; *one line each* forces that everywhere; *every card open* expands everything. A compact line carries its own ✓ / ✗, so a finding can be decided without opening it. |
| **Actionable only** | Hides the advisory findings, the ones that may well be correct. |
| **Last.fm user** | The account the **Open in Last.fm** links are built from, read from `lastfmstats-yourname.csv` and editable if the file name does not give it. It is remembered across reports and never sent anywhere. |
| **Downloads & help** | The to-do list, the report in Markdown, the actions CSV, the JSON, Print / PDF and a reset for all of your decisions. |

The line above the list always says what you are looking at: how many findings are visible, how many
are actionable in total, and how many you have accepted or discarded. If a combination of filters
leaves nothing on screen, the message offers to clear them.

Printing switches to *every card open* first, so a printed page carries the contents rather than just
the one-line list.

## Making the changes in Last.fm

Each card carries an **Open in Last.fm** link for the value it asks you to change — the artist, the
album or the track — so you land on the page where the Edit control lives instead of searching for the
scrobble yourself. The links are built from your username, taken from the file name
(`lastfmstats-yourname.csv`); if the file was renamed, type it in the panel at the top of the report
(it is remembered, and it is never sent anywhere — the links only open Last.fm in a new tab). The
**to-do list** and the **Markdown report** carry the same links when a username is set.

Artist, track and album edits are retroactive: Last.fm offers to apply them to every scrobble of that
combination, and renaming an artist affects the whole entry. It is a bulk change — look twice.
Deleting a duplicate scrobble is done one at a time, from the (⋯) menu.

### What the Accept and Discard buttons actually do

They are the only two buttons that ask for a decision, and neither of them touches your Last.fm
account:

| Button | What it changes |
|---|---|
| **Accept** | Marks the finding as to do: it gets a green edge and appears in the **to-do list**, which you download with “Download to-do list”. That is the point of the button — the report is for reading, the to-do list is the working document you tick off while editing. |
| **Discard** | Says “this is fine, or wrong”: the card fades out, stops being listed, and its row is dropped from `actions.csv`. |
| **Back to pending** | Undoes either of the two. |

Decisions are kept per report in the browser's local storage, so they survive a reload and do not leak
into the report of another CSV. `actions.csv` carries them in its `decision` column
(`accept` / `discard` / `pending`). The Markdown and JSON downloads do **not** carry them: those are
the report, not your working list.

**Choosing which form to keep.** When a card proposes a rename but more than one spelling could be the
target (the bracket form or the dash one, two spellings of an artist), it lists them under **Keep
instead** next to the proposal. Click one and the whole card follows it — the proposal line, the number
of scrobbles the change touches and the Last.fm instructions — and so do the to-do list and
`actions.csv`, which is what you work from. The default is always the first button; your pick is kept
with the decisions, next to them in local storage, and cleared by **Reset all decisions**.

## Privacy

The report page runs entirely in your browser. No server, no upload, no requests. The CSV never leaves
your machine unless you share the report yourself.
