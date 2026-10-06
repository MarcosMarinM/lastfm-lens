/*!
 * Last.fm Lens — scrobble cleanup analysis engine
 * ----------------------------------------------------------------------------
 * Reads a CSV of scrobbles (lastfmstats.com format or similar) and reports what
 * is probably worth tidying up in Last.fm: duplicate artists, combined artist
 * names, inconsistent track titles, missing or clashing albums, duplicate
 * scrobbles and long-tail oddities.
 *
 * Design principle: the engine PROPOSES, it never asserts. Every finding carries
 *   - points (0-100): how strongly it looks like the same item / a mistake
 *   - signals: the specific clues that fired, in plain English
 *   - impact: how many scrobbles would change if you accept the proposal
 *   - evidence: the tracks and counts behind the suspicion
 *
 * It edits nothing. It only informs.
 *
 * No models, no network, no dependencies: plain deterministic functions, so the
 * same CSV always produces exactly the same report.
 *
 * Runs in Node (`require('./engine.js')`) and in the browser
 * (`window.LastfmLens`).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LastfmLens = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = '1.1.0';

  /* ==========================================================================
   * 1. Configurable rules
   * ========================================================================== */

  var RULES = {
    // How to pick the "good" (canonical) value out of a group of variants:
    //   'score'    = recency + frequency + most complete name (default)
    //   'recent'   = whichever has the most recent scrobble wins
    //   'frequent' = whichever has the most scrobbles wins
    canonical: 'score',

    // Confidence thresholds, on the 0-100 points scale
    highThreshold: 60,
    mediumThreshold: 40,
    // Findings below this are not listed (they are counted in the summary).
    // 'high' gives the smallest report; 'low' includes everything.
    minimumConfidence: 'medium',

    // Minimum evidence: an artist duplicate is only proposed if the two names
    // share at least one track, unless the names are identical bar formatting.
    requireSharedTrack: true,

    // Artist names that are nearly the same: a typo or a rename (“Jana Burčeska”
    // against “Jana Burcheska”, “Marlena” against “Maléna”). Compared character by
    // character, but narrowly, because looking similar is weak evidence. The
    // default 0.875 reads “one character in eight, at most”: short names have to
    // be nearly identical, long ones may differ by two characters. Lowering it
    // brings in pairs like “Martija” / “Martina”, which are usually two different
    // artists — that is the pair the old prefix rule used to produce.
    similarArtistNameThreshold: 0.875,
    maxSimilarArtistDistance: 2,
    minArtistLengthForSimilarCompare: 5,

    // “Cris Lora” against “Cristina Lora”: the same number of words, every word
    // equal except one, and that one is the beginning of the other. The short form
    // has to be at least minAbbreviationLength characters and the added part at
    // least minAbbreviationExtension, which is what keeps out “Voyage” /
    // “Voyager” (one letter apart, and usually two different acts).
    minAbbreviationLength: 4,
    minAbbreviationExtension: 2,

    // Duplicates: two scrobbles of the same artist+track closer than this
    duplicateWindowMs: 60 * 1000,
    duplicateCertainWindowMs: 15 * 1000,

    // Session mixing: a scrobble of A and one of B closer than this = same sitting
    sessionWindowMs: 10 * 60 * 1000,

    // Fewest affected scrobbles before an album clash is worth listing
    minAlbumImpact: 3,

    // Long tail
    maxScrobblesForRareArtist: 2, // a "rare artist" has <= this many scrobbles
    minScrobblesForTypoCompare: 20, // only compare against artists with >= this
    maxTypoDistance: 2, // edit distance before suspecting a typo

    // Album name variants that differ only in formatting: at most this many are
    // listed. Anything past the cap is counted in the summary (summary.trimmed),
    // never dropped in silence.
    maxAlbumNameVariants: 60,

    // Track titles written almost the same ("Patata" / "Patataa" / "Papata").
    // Deliberately narrow: same artist, same first letter, and the rarer
    // spelling has to be genuinely rare, or half the library would pair up.
    maxTitleTypoDistance: 1, // differ by at most this many characters...
    maxTitleTypoDistanceWithAlbum: 2, // ...or this many when they share an album
    maxScrobblesForRareTitle: 3, // the suspect spelling has <= this many scrobbles
    minTitleLengthForTypoCompare: 4, // never compare titles shorter than this

    // Presentation
    maxEvidence: 14, // most evidence items per finding
    maxTableRows: 400
  };

  var TYPE_LABELS = {
    duplicate_artists: 'Duplicate artists',
    combined_artists: 'Combined artists',
    title_variants: 'Inconsistent track titles',
    artist_in_title: 'Artist repeated in title',
    albums: 'Albums',
    duplicate_scrobbles: 'Duplicate scrobbles',
    long_tail: 'Long tail and oddities'
  };

  var TYPE_ORDER = [
    'duplicate_artists',
    'combined_artists',
    'title_variants',
    'artist_in_title',
    'albums',
    'duplicate_scrobbles',
    'long_tail'
  ];

  /**
   * Human label for every sub-case a section can emit. The key matches the
   * `subtype` carried by a finding.
   *
   * The order of these keys is only a stable tie-breaker: the report lists the
   * groups inside a section by how promising their best finding is, so a sub-case
   * that reaches 75/100 never appears below one that only reaches 52/100.
   */
  var SUBTYPE_LABELS = {
    duplicate_artists: {
      identical: 'Identical names bar formatting',
      containment: 'One name contained in the other',
      group: 'Several forms of the same artist',
      similar_with_tracks: 'Very similar names that share tracks',
      similar_names: 'Very similar names with no shared track'
    },
    combined_artists: {
      '': 'Name joining several artists'
    },
    title_variants: {
      case_only: 'Capitalisation only',
      formatting: 'Formatting only',
      qualifier_formatting: 'Qualifier written differently',
      featuring: 'Featuring credit in one form only',
      typo: 'Probably a typo in the title',
      platform_badge: 'Titles carrying a platform badge',
      version_marker: 'Probably a different version (live, remix…)',
      one_qualified: 'With and without a qualifier',
      different_qualifiers: 'Different qualifiers'
    },
    artist_in_title: {
      '': 'Artist repeated inside the title'
    },
    albums: {
      missing: 'No album (another scrobble has one)',
      name_variants: 'Album name written in several ways',
      case_only: 'Capitalisation only',
      clash: 'Several albums for the same title'
    },
    duplicate_scrobbles: {
      '': 'Consecutive repeats of the same track'
    },
    long_tail: {
      possible_typo: 'Probably a typo in the artist name',
      hygiene: 'Formatting details inside tags',
      empty: 'Scrobbles with no album',
      rare_artists: 'Artists with two scrobbles or fewer'
    }
  };

  var ACTIONS = {
    rename_artist: {
      label: 'Rename artist',
      how: function (f) {
        return (
          'In Last.fm open one of the scrobbles of “' + f.current + '”, edit the Artist field and ' +
          'type “' + f.proposed + '”. Last.fm will offer to apply the change to all ' +
          num(f.impact) + ' scrobbles. It is retroactive and cannot be undone: check it first.'
        );
      }
    },
    split_combined: {
      label: 'Review combined artist',
      how: function (f) {
        return (
          'Those ' + num(f.impact) + ' scrobbles sit under a name that joins several artists. If “' +
          f.current + '” is not the right name (a real duo, say), leave it alone. If it is, edit the ' +
          'Artist field to “' + f.proposed + '” and, if you want to keep the featuring credit, add it ' +
          'to the track title in brackets.'
        );
      }
    },
    rename_track: {
      label: 'Merge track title',
      how: function (f) {
        return (
          'In Last.fm, edit the Track field of a scrobble with “' + f.current + '” and set it to “' +
          f.proposed + '”. The change applies to the ' + num(f.impact) +
          ' scrobbles of that artist+track combination.'
        );
      }
    },
    strip_artist_from_title: {
      label: 'Remove artist from title',
      how: function (f) {
        return (
          'The scrobble already has the artist in its Artist field and the title repeats it. ' +
          'Edit the Track field to “' + f.proposed + '”.'
        );
      }
    },
    fill_album: {
      label: 'Fill in album',
      how: function (f) {
        return (
          num(f.impact) + ' scrobbles of “' + f.current + '” have no album while others of the same ' +
          'track do. Edit the Album field to “' + f.proposed + '”.'
        );
      }
    },
    merge_album: {
      label: 'Merge album name',
      how: function (f) {
        return (
          'The same album is spelled in several ways (' + num(f.impact) + ' scrobbles). Edit the Album ' +
          'field to whichever form you prefer; the most used one is usually the right one.'
        );
      }
    },
    review_album: {
      label: 'Review album',
      // Advisory: it may be perfectly correct (a single and an album are two
      // different releases), so it does not count as work to do.
      advisory: true,
      how: function (f) {
        return (
          'The same title appears across ' + num(f.impact) + ' scrobbles split between these albums. ' +
          'If one is the single and the other is the album, that is correct and there is nothing to fix.'
        );
      }
    },
    review_capitalisation: {
      label: 'Review capitalisation',
      // Advisory: the same name with different capitals, so nothing is damaged and
      // nothing is lost. It is tidying, not a fix, and does not count as work.
      advisory: true,
      how: function (f) {
        return (
          'Optional tidying: “' + f.current + '” and “' + f.proposed + '” are the same name written ' +
          'with different capitals. If you want them identical, edit the field to “' + f.proposed +
          '” and let Last.fm apply it to the ' + num(f.impact) + ' scrobble(s). If you do not care, leave ' +
          'them: nothing is broken.'
        );
      }
    },
    delete_duplicate: {
      label: 'Delete duplicate',
      how: function (f) {
        return (
          'This looks like a scrobble repeated by accident. In Last.fm open the scrobble and use the ' +
          'menu (⋯) to delete it. There is no bulk edit here: it is one at a time.'
        );
      }
    },
    review_artist: {
      label: 'Review artist name',
      // Advisory: the names look alike but share no track, so this may well be
      // two different artists.
      advisory: true,
      how: function (f) {
        return (
          'Listen to or look up “' + f.current + '” and “' + f.proposed + '” before touching anything: the ' +
          'names are alike but the scrobbles share no track, which is exactly what two different artists ' +
          'with similar names look like. If they are the same, open a scrobble of “' + f.current +
          '”, edit the Artist field to “' + f.proposed + '” and let Last.fm apply it to the ' +
          num(f.impact) + ' scrobble(s).'
        );
      }
    },
    review_track: {
      label: 'Review track title',
      // Advisory: the qualifier probably marks a different recording, so merging
      // is a decision to make rather than a merge to do.
      advisory: true,
      how: function (f) {
        return (
          'Compare the ' + num(f.impact) + ' scrobble(s) behind this finding before changing anything: a ' +
          'qualifier such as live, remix, acoustic or version usually marks a DIFFERENT recording, and ' +
          'merging it would lose that distinction. If the qualifier is a tagging mistake, edit the Track ' +
          'field to “' + f.proposed + '”; if the recording really is different, leave both as they are.'
        );
      }
    },
    review: {
      label: 'Review',
      advisory: true,
      how: function () {
        return 'No automatic action: this one needs your judgement.';
      }
    }
  };

  /* ==========================================================================
   * 2. Text, number and date helpers
   * ========================================================================== */

  var RE_SPACES = /\s+/g;
  var RE_NON_ALPHANUMERIC = /[^\p{L}\p{N}]+/gu;

  /** Strips accents and diacritics without destroying non-Latin scripts. */
  function stripAccents(s) {
    try {
      return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    } catch (e) {
      return s;
    }
  }

  /**
   * Cleans a tag for storage and display: dashes and "exotic" spaces are unified,
   * invisible characters dropped, runs of spaces collapsed.
   *
   * Quote characters are deliberately NOT folded here (`’` is not turned into
   * `'`). Last.fm keeps them apart, so “Loin d’ici” and “Loin d'ici” are two
   * different track entries; folding them at read time left a single spelling to
   * compare and made exactly the variant this report exists to find invisible.
   * The comparison keys (`key`, `artistKey`, `strictTitleKey`) throw punctuation
   * away, so they still treat the two as equal where that is the right call.
   */
  function normaliseText(s) {
    if (s == null) return '';
    return String(s)
      .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
      .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
      .replace(/[\u200B-\u200F\u2028\u2029\uFEFF\uFFFD]/g, '')
      .replace(RE_SPACES, ' ')
      .trim();
  }

  // The quote characters Last.fm keeps apart and that a report has to notice:
  // the straight ones plus their typographic twins. The modifier-letter set
  // (U+02B9 prime, U+02BB ʻokina, U+02BC apostrophe, U+02BD–U+02BF) is included
  // because those are apostrophes in use even though Unicode files them as
  // letters, which is why the punctuation-stripping pass in key() misses them.
  var RE_SINGLE_QUOTES = /[\u2018\u2019\u201B\u2032\u02B9\u02BB\u02BC\u02BD\u02BE\u02BF`\u00B4]/g;
  var RE_DOUBLE_QUOTES = /[\u201C\u201D\u2033\u00AB\u00BB]/g;

  /**
   * Folds the typographic quotes to their straight forms. Used only by the “is
   * this nothing but typography?” tests (album and title formatting), never to
   * store a value: the straight and curly spellings have to stay distinguishable
   * so the report can propose unifying them.
   */
  function foldQuotes(s) {
    return String(s == null ? '' : s).replace(RE_SINGLE_QUOTES, "'").replace(RE_DOUBLE_QUOTES, '"');
  }

  /** Comparison key: no accents, lower case, no punctuation. */
  function key(s) {
    var h = stripAccents(normaliseText(s)).toLowerCase();
    h = h
      .replace(RE_SINGLE_QUOTES, ' ')
      .replace(RE_NON_ALPHANUMERIC, ' ')
      .replace(RE_SPACES, ' ')
      .trim();
    return h;
  }

  var RE_FEAT = /\b(feat|featuring|ft|con)\b\.?/g;
  function stripFeat(s) {
    return s.replace(RE_FEAT, ' ').replace(RE_SPACES, ' ').trim();
  }

  /** Splits "Track (X) - Y" into a base plus its qualifiers. */
  function titleParts(t) {
    var h = normaliseText(t);
    var qualifiers = [];
    var base = h.replace(/[\(\[\{]([^\)\]\}]*)[\)\]\}]/g, function (match, inner) {
      var q = key(inner);
      if (q) qualifiers.push(q);
      return ' ';
    });
    var m;
    var guard = 0;
    while (guard++ < 5) {
      m = base.match(/\s+-\s+(.{2,})$/);
      if (!m) break;
      var q2 = key(m[1]);
      if (!q2) break;
      qualifiers.push(q2);
      base = base.slice(0, m.index);
    }
    return { base: base.replace(RE_SPACES, ' ').trim(), qualifiers: qualifiers.filter(Boolean) };
  }

  /** Strict title key: formatting only. */
  function strictTitleKey(t) {
    return key(t);
  }

  /** Loose title key: also drops the featuring credit and any qualifiers. */
  function looseTitleKey(t) {
    return key(stripFeat(titleParts(t).base)) || key(t);
  }

  /*
   * Platform badges: the junk a video page adds to a title, so that “Song” becomes
   * “Song (Official Video)”. Every word of the qualifier has to belong to the
   * vocabulary and at least one core word has to be there, because a qualifier that
   * merely CONTAINS one of these words is usually a real credit: “from the Prime
   * Video original movie”, “Eurovision official version” and “Official Song UEFA
   * Euro 2016” are all credits, not badges.
   */
  var BADGE_WORDS = {
    official: 1, oficial: 1, audio: 1, video: 1, lyric: 1, lyrics: 1, letra: 1,
    letras: 1, visual: 1, visuals: 1, visualizer: 1, visualiser: 1, clip: 1,
    music: 1, full: 1, mv: 1, hd: 1, hq: 1, '4k': 1, '8k': 1
  };
  var BADGE_CORE = {
    official: 1, oficial: 1, audio: 1, video: 1, lyric: 1, lyrics: 1, letra: 1,
    letras: 1, visual: 1, visuals: 1, visualizer: 1, visualiser: 1, mv: 1, hd: 1,
    hq: 1, '4k': 1, '8k': 1
  };

  /**
   * True when a qualifier is nothing but a platform badge: “Official Video”,
   * “Audio”, “Lyric Video”, “Video Oficial”, “4K”… It receives the already
   * normalised qualifier, so accents, case and punctuation are gone by then.
   */
  function isPlatformBadge(qualifierKey) {
    var words = String(qualifierKey || '').split(' ').filter(Boolean);
    if (!words.length) return false;
    var core = false;
    for (var i = 0; i < words.length; i++) {
      if (!BADGE_WORDS[words[i]]) return false;
      if (BADGE_CORE[words[i]]) core = true;
    }
    return core;
  }

  /** The title with its platform badges removed, and nothing else touched. */
  function stripPlatformBadges(raw) {
    var out = normaliseText(raw).replace(/[\(\[]([^\)\]]*)[\)\]]/g, function (match, inner) {
      return isPlatformBadge(key(inner)) ? ' ' : match;
    });
    for (var i = 0; i < 5; i++) {
      var m = out.match(/\s+-\s+(.{2,})$/);
      if (!m || !isPlatformBadge(key(m[1]))) break;
      out = out.slice(0, m.index);
    }
    return normaliseText(out);
  }

  /** Words that point to a DIFFERENT recording, not just different formatting. */
  var RE_DIFFERENT_VERSION = new RegExp(
    '\\b(live|en vivo|directo|acoustic|acustico|acustica|remix|remaster|remastered|' +
      'remasterizado|instrumental|karaoke|cover|version|edicion|edit|extended|reprise|' +
      'demo|mono|stereo|radio edit|soundtrack|banda sonora|orchestral|orquesta|' +
      'esc version|eurovision|junior|dancebreak|spanglish|spanish|english|italiano)\\b'
  );

  function qualifiersOf(t) {
    return titleParts(t).qualifiers.join(' | ');
  }

  /** Artist key: no featuring credit, no brackets, no leading article. */
  function artistKey(a) {
    var h = normaliseText(a);
    h = h.replace(/[\(\[\{][^\)\]\}]*[\)\]\}]/g, ' ');
    h = stripFeat(h);
    var k = key(h);
    k = k.replace(/^(the|los|las|el|la|le|les|il|lo)\s+/, '');
    return k || key(a);
  }

  // Separators that really do join several artists. "and" and "x" are left out
  // on purpose: they split genuine names ("Nina and the Wild").
  var COMBINED_SEPARATORS = /,|;|\s+&\s+|\s+y\s+|\s+vs\.?\s+|\s+feat\.?\s+|\s+featuring\s+|\s+with\s+|\s+\|\s+/gi;

  /** Splits an artist string that joins several artists. [] if it looks single. */
  function splitArtist(a) {
    var parts = normaliseText(a)
      .split(COMBINED_SEPARATORS)
      .map(function (p) {
        return p.replace(/^[\s\-]+|[\s\-]+$/g, '').replace(/^[\(\[\{]|[\)\]\}]$/g, '').trim();
      })
      .filter(function (p) {
        return key(p).length > 0;
      });
    return parts.length > 1 ? parts : [];
  }

  function num(n) {
    try {
      return Number(n).toLocaleString('en-GB');
    } catch (e) {
      return String(n);
    }
  }

  function pct(x) {
    return Math.round(x * 100) + '%';
  }

  var DATE_FORMAT = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  var DATE_TIME_FORMAT = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });

  function shortDate(ms) {
    if (ms == null || !isFinite(ms)) return '—';
    return DATE_FORMAT.format(new Date(ms));
  }
  function dateTime(ms) {
    if (ms == null || !isFinite(ms)) return '—';
    return DATE_TIME_FORMAT.format(new Date(ms));
  }
  function humanDuration(ms) {
    if (ms == null || !isFinite(ms)) return '—';
    var s = Math.round(ms / 1000);
    if (s < 60) return s + ' sec';
    var m = s / 60;
    if (m < 60) return (m < 10 ? m.toFixed(1) : Math.round(m)) + ' min';
    var h = m / 60;
    if (h < 24) return (h < 10 ? h.toFixed(1) : Math.round(h)) + ' h';
    var d = h / 24;
    if (d < 60) return (d < 10 ? d.toFixed(1) : Math.round(d)) + ' days';
    return Math.round(d / 30.44) + ' months';
  }

  /** Bounded Levenshtein distance (returns max+1 once it is exceeded). */
  function editDistance(a, b, max) {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > max) return max + 1;
    var row = new Array(b.length + 1);
    for (var j = 0; j <= b.length; j++) row[j] = j;
    for (var i = 1; i <= a.length; i++) {
      var previous = row[0];
      row[0] = i;
      var best = row[0];
      for (var k = 1; k <= b.length; k++) {
        var temp = row[k];
        var cost = a.charCodeAt(i - 1) === b.charCodeAt(k - 1) ? 0 : 1;
        row[k] = Math.min(row[k] + 1, row[k - 1] + 1, previous + cost);
        if (row[k] < best) best = row[k];
        previous = temp;
      }
      if (best > max) return max + 1;
    }
    return row[b.length];
  }

  /* ==========================================================================
   * 3. Reading the CSV
   * ========================================================================== */

  /**
   * Full CSV parser: configurable delimiter, double quotes, escaped quotes ("")
   * and line breaks inside a quoted field.
   */
  function parseCSV(text, delimiter) {
    delimiter = delimiter || ',';
    var rows = [];
    var row = [];
    var field = '';
    var i = 0;
    var n = text.length;
    var inQuotes = false;
    while (i < n) {
      var c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          inQuotes = false;
          i++;
          continue;
        }
        field += c;
        i++;
        continue;
      }
      if (c === '"') {
        inQuotes = true;
        i++;
        continue;
      }
      if (c === '\r') {
        i++;
        continue;
      }
      if (c === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
        i++;
        continue;
      }
      if (c === delimiter) {
        row.push(field);
        field = '';
        i++;
        continue;
      }
      field += c;
      i++;
    }
    if (field !== '' || row.length) {
      row.push(field);
      rows.push(row);
    }
    return rows;
  }

  function detectDelimiter(text) {
    var sample = text.slice(0, 20000).split('\n').slice(0, 20).join('\n');
    var candidates = [';', ',', '\t', '|'];
    var best = ';';
    var bestCount = -1;
    for (var i = 0; i < candidates.length; i++) {
      var d = candidates[i];
      var count = 0;
      var inQuotes = false;
      for (var j = 0; j < sample.length; j++) {
        var c = sample[j];
        if (c === '"') inQuotes = !inQuotes;
        else if (c === d && !inQuotes) count++;
      }
      if (count > bestCount) {
        bestCount = count;
        best = d;
      }
    }
    return best;
  }

  function looksLikeTimestamp(v) {
    var s = String(v).trim();
    if (!/^\d{9,14}$/.test(s)) return false;
    var n = Number(s);
    return n > 100000000 && n < 4102444800000;
  }

  function looksLikeISODate(v) {
    return /^\d{4}-\d{2}-\d{2}([ T]|$)/.test(String(v).trim());
  }

  /** epoch (seconds or milliseconds) or ISO date → milliseconds. */
  function parseDate(v) {
    var s = String(v == null ? '' : v).trim();
    if (!s) return NaN;
    if (/^\d{9,14}$/.test(s)) {
      var n = Number(s);
      return n < 1e11 ? n * 1000 : n; // below 1e11 means seconds
    }
    if (looksLikeISODate(s)) {
      var t = Date.parse(s.replace(' ', 'T'));
      return isNaN(t) ? NaN : t;
    }
    var t2 = Date.parse(s);
    return isNaN(t2) ? NaN : t2;
  }

  function guessColumns(headers, rows) {
    var col = { artist: -1, album: -1, albumId: -1, track: -1, date: -1 };
    var normalised = headers.map(function (h) {
      return key(h);
    });
    var used = {};
    // Header aliases are kept in several languages on purpose: this part reads
    // whatever the export happens to be, it is not part of the report wording.
    function find(re, exclude) {
      for (var i = 0; i < normalised.length; i++) {
        if (used[i]) continue;
        if (exclude && exclude.test(normalised[i])) continue;
        if (re.test(normalised[i])) return i;
      }
      return -1;
    }
    col.albumId = find(/album.*(id|mbid|identificador)/);
    if (col.albumId >= 0) used[col.albumId] = true;
    col.artist = find(/^(artist|artista|artist name|nombre del artista)$/);
    if (col.artist < 0) col.artist = find(/^(artist|artista)/, /album/);
    if (col.artist < 0) col.artist = find(/artist/, /album/);
    if (col.artist >= 0) used[col.artist] = true;
    col.album = find(/album/, /album.*(id|mbid|artist)/);
    if (col.album >= 0) used[col.album] = true;
    col.track = find(/^(track|track name|title|titulo|song|name|nombre)$/);
    if (col.track < 0) col.track = find(/track|title|song|titulo|canci/);
    if (col.track >= 0) used[col.track] = true;
    col.date = find(/^(date|fecha|uts|timestamp|played at|played_at|time)$/);
    if (col.date < 0) col.date = find(/date|fecha|uts|timestamp|time|when/);

    // Content check: the date column has to look like dates
    var sampleRows = rows.slice(0, 30);
    var validCount = function (index) {
      if (index < 0) return 0;
      var ok = 0;
      for (var i = 0; i < sampleRows.length; i++) {
        if (looksLikeTimestamp(sampleRows[i][index]) || looksLikeISODate(sampleRows[i][index])) ok++;
      }
      return ok;
    };
    if (col.date < 0 || validCount(col.date) < sampleRows.length / 2) {
      for (var c = 0; c < headers.length; c++) {
        if (validCount(c) >= sampleRows.length / 2 && c !== col.artist && c !== col.track && c !== col.album) {
          col.date = c;
          break;
        }
      }
    }
    return col;
  }

  /**
   * Reads a CSV of scrobbles.
   * @returns {{scrobbles: Array, headers: string[], columns: Object, warnings: string[]}}
   */
  function readCSV(text, fileName) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    var delimiter = detectDelimiter(text);
    var rows = parseCSV(text, delimiter);
    var warnings = [];
    if (!rows.length) return { scrobbles: [], headers: [], columns: {}, warnings: ['The file is empty.'] };

    var headers = rows[0].map(function (h) {
      return normaliseText(h);
    });
    var body = rows.slice(1);

    // Is the first row a header or data?
    var hasHeader = !looksLikeTimestamp(headers[headers.length - 1]) && body.length > 0;
    var columns = guessColumns(headers, body);
    if (!hasHeader) {
      columns = { artist: 0, album: 1, albumId: -1, track: 3, date: 4 };
      body = rows;
      headers = ['(no header)'];
      if (body[0] && body[0].length > 4 && !looksLikeTimestamp(body[0][4])) {
        columns = { artist: 0, album: 1, albumId: -1, track: 2, date: 3 };
      }
    }

    if (columns.artist < 0 || columns.track < 0) {
      warnings.push(
        'I could not identify the artist and track columns. Assuming the usual order ' +
          '(Artist;Album;AlbumId;Track;Date).'
      );
      columns = { artist: 0, album: 1, albumId: 2, track: 3, date: 4 };
    }
    if (columns.date < 0) {
      warnings.push('No date column found: time-based checks are switched off.');
    }

    var fieldAt = function (row, index) {
      if (index < 0 || !row) return '';
      var v = row[index];
      return v == null ? '' : normaliseText(v);
    };

    var scrobbles = [];
    var withoutDate = 0;
    for (var i = 0; i < body.length; i++) {
      var row2 = body[i];
      if (!row2 || (row2.length === 1 && row2[0] === '')) continue;
      var ts = columns.date >= 0 ? parseDate(row2[columns.date]) : NaN;
      if (isNaN(ts)) withoutDate++;
      scrobbles.push({
        i: scrobbles.length,
        artist: fieldAt(row2, columns.artist),
        album: fieldAt(row2, columns.album),
        albumId: fieldAt(row2, columns.albumId),
        title: fieldAt(row2, columns.track),
        ts: ts,
        source: fileName || ''
      });
    }
    if (withoutDate) warnings.push(num(withoutDate) + ' rows have no recognisable date.');
    scrobbles.sort(function (a, b) {
      var av = isNaN(a.ts) ? Infinity : a.ts;
      var bv = isNaN(b.ts) ? Infinity : b.ts;
      return av - bv;
    });
    scrobbles.forEach(function (s, index) {
      s.i = index;
    });
    return { scrobbles: scrobbles, headers: headers, columns: columns, warnings: warnings };
  }

  /* ==========================================================================
   * 4. Index
   * ========================================================================== */

  function buildIndex(scrobbles) {
    var artists = new Map(); // name -> {name, n, key, tracks: Map, timestamps: [], first, last, parts}
    // Album spellings are grouped per ARTIST, never across artists: an album page is a
    // (artist, album) pair, so “SARAH” by Sarah Toscano and “Sarah” by the duplicate
    // artist “Sarah” are two different albums, not two spellings of one. Merging them
    // would tell you to rewrite one artist's album into another artist's.
    var albumNames = new Map(); // artist + album key -> { artist, spellings: Map(raw -> n) }

    for (var i = 0; i < scrobbles.length; i++) {
      var s = scrobbles[i];
      if (!s.artist && !s.title) continue;
      var artist = artists.get(s.artist);
      if (!artist) {
        artist = {
          name: s.artist,
          n: 0,
          key: artistKey(s.artist),
          tracks: new Map(),
          timestamps: [],
          first: NaN,
          last: NaN,
          parts: splitArtist(s.artist)
        };
        artists.set(s.artist, artist);
      }
      artist.n++;
      if (!isNaN(s.ts)) {
        artist.timestamps.push(s.ts);
        if (isNaN(artist.first) || s.ts < artist.first) artist.first = s.ts;
        if (isNaN(artist.last) || s.ts > artist.last) artist.last = s.ts;
      }
      var trackKey = s.__key != null ? s.__key : (s.__key = looseTitleKey(s.title));
      var track = artist.tracks.get(trackKey);
      if (!track) {
        track = { key: trackKey, titles: new Map(), n: 0, albums: new Map() };
        artist.tracks.set(trackKey, track);
      }
      track.n++;
      track.titles.set(s.title, (track.titles.get(s.title) || 0) + 1);
      if (s.album) track.albums.set(s.album, (track.albums.get(s.album) || 0) + 1);

      if (s.album) {
        var albumKey = s.artist + '\u0000' + key(s.album);
        var entry = albumNames.get(albumKey);
        if (!entry) {
          entry = { artist: s.artist, spellings: new Map() };
          albumNames.set(albumKey, entry);
        }
        entry.spellings.set(s.album, (entry.spellings.get(s.album) || 0) + 1);
      }
    }
    var list = Array.from(artists.values());
    list.sort(function (x, y) {
      return y.n - x.n || (x.name < y.name ? -1 : 1);
    });
    return { artists: artists, list: list, albumNames: albumNames };
  }

  /* ==========================================================================
   * 5. Scoring and finding helpers
   * ========================================================================== */

  function confidence(points) {
    if (points >= RULES.highThreshold) return 'high';
    if (points >= RULES.mediumThreshold) return 'medium';
    return 'low';
  }

  function findingId(type, current, proposed) {
    return type + '|' + current + '|' + proposed;
  }

  /** Picks the canonical value of a group of variants, per RULES.canonical. */
  function chooseCanonical(variants) {
    if (RULES.canonical === 'recent') {
      return variants.slice().sort(function (a, b) { return (b.last || 0) - (a.last || 0); })[0];
    }
    if (RULES.canonical === 'frequent') {
      return variants.slice().sort(function (a, b) { return b.n - a.n; })[0];
    }
    // 'score': recency, measured against the group itself, so the most recent form
    // takes its two points and the oldest none. Scoring every dated variant the
    // same made recency inert, and the default silently ranked on frequency alone.
    var newest = -Infinity;
    var oldest = Infinity;
    variants.forEach(function (v) {
      if (!v.last) return;
      if (v.last > newest) newest = v.last;
      if (v.last < oldest) oldest = v.last;
    });
    var span = newest - oldest;
    var ordered = variants.slice().sort(function (a, b) {
      return canonicalScore(b, newest, span) - canonicalScore(a, newest, span);
    });
    return ordered[0];
  }

  function canonicalScore(v, newest, span) {
    var p = 0;
    if (v.last) p += span > 0 ? 2 * (1 - (newest - v.last) / span) : 2; // recency, weighted highest
    p += Math.min(1, Math.log10(1 + v.n) / 2) * 1.5; // frequency
    p += Math.min(1, (v.value || '').length / 24) * 0.5; // more complete name
    return p;
  }

  /**
   * A complete proposal for keeping one variant as the target instead of the
   * default canonical one: the same shape the finding itself carries
   * (`current` → `proposed`, `impact`), so the interface can swap to it and the
   * exports stay correct whatever is chosen. `targetFor` turns one of the
   * discarded variants into the scrobble to edit, so the Last.fm links follow the
   * swap the way the action line does.
   */
  function swapOption(target, variants, reason, targetFor) {
    var others = variants.filter(function (v) { return v.value !== target.value; });
    return {
      value: target.value,
      reason: reason,
      current: others.map(function (v) { return v.value; }).join('  /  '),
      proposed: target.value,
      impact: others.reduce(function (acc, v) { return acc + v.n; }, 0),
      targets: targetFor ? others.map(targetFor) : []
    };
  }

  function signal(text, level) {
    return { text: text, level: level || 'info' };
  }

  /** Human label for a finding's sub-case, or '' when it has none. */
  function subtypeLabel(type, subtype) {
    var map = SUBTYPE_LABELS[type];
    return (map && map[subtype || '']) || '';
  }

  /**
   * A scrobble to open in Last.fm: the artist, plus the track or the album whose
   * page carries the Edit control. `targets` on a finding are the values it asks
   * you to change, in the order the card names them (the "from" side of a rename,
   * never the proposal).
   */
  function editTarget(artist, track, album) {
    var t = { artist: artist || '' };
    if (track) t.track = track;
    if (album) t.album = album;
    return t;
  }

  /** Human label for a target, matching the way the report names artists/tracks. */
  function targetLabel(t) {
    if (!t) return '';
    if (t.track) return t.artist + ' — ' + t.track;
    if (t.album) return t.artist + ' — ' + t.album;
    return t.artist;
  }

  /**
   * One URL path segment the way Last.fm writes it: spaces become “+”, and the
   * characters encodeURIComponent leaves bare but that are not URL-safe in a path
   * (`! ' ( ) *`) are percent-encoded too, so a title such as “Song (Live)” reads
   * as `Song+%28Live%29` rather than being left half-encoded.
   */
  function lastfmSegment(value) {
    return encodeURIComponent(String(value == null ? '' : value))
      .replace(/[!'()*]/g, function (c) { return '%' + c.charCodeAt(0).toString(16).toUpperCase(); })
      .replace(/%20/g, '+');
  }

  /**
   * The Last.fm page for a target: an artist’s library, an album page, or a
   * track’s page — `/music/<artist>/_/<track>`, where `_` is Last.fm’s stand-in
   * for “whatever album”. This is the page the Edit control lives on.
   * Returns '' when there is no username or no artist to point at.
   */
  function lastfmUrl(username, target) {
    if (!username || !target || !target.artist) return '';
    var url =
      'https://www.last.fm/user/' + lastfmSegment(username) + '/library/music/' + lastfmSegment(target.artist);
    if (target.track) return url + '/_/' + lastfmSegment(target.track);
    if (target.album) return url + '/' + lastfmSegment(target.album);
    return url;
  }

  function newFinding(options) {
    var f = {
      id: findingId(options.type + ':' + (options.subtype || ''), options.current || '', options.proposed || ''),
      type: options.type,
      typeLabel: TYPE_LABELS[options.type] || options.type,
      subtype: options.subtype || '',
      title: options.title,
      points: Math.max(0, Math.min(100, Math.round(options.points))),
      impact: options.impact || 0,
      action: options.action,
      actionLabel: (ACTIONS[options.action] || {}).label || options.action,
      current: options.current || '',
      proposed: options.proposed || '',
      alternatives: options.alternatives || [],
      signals: options.signals || [],
      explanation: options.explanation || '',
      evidence: options.evidence || null,
      table: options.table || null,
      warning: options.warning || '',
      informational: !!options.informational,
      // The scrobbles to open in Last.fm (see editTarget). Empty for findings
      // that summarise many values and point at no single page.
      targets: options.targets || []
    };
    f.confidence = confidence(f.points);
    var action = ACTIONS[f.action];
    // An advisory finding ("this may well be correct, ignore it") is not work:
    // the interface and the summary both use this to tell them apart.
    f.actionable = !(action && action.advisory);
    f.howTo = action ? action.how(f) : '';
    return f;
  }

  /* ==========================================================================
   * 6. Detectors
   * ========================================================================== */

  /* --- 6.1 Duplicate artists ------------------------------------------------- */

  function detectMergePairs(index, stats) {
    var candidates = [];
    var list = index.list;
    var seen = new Set();

    function addPair(a, b, relation) {
      var shorter = a.key.length <= b.key.length ? a : b;
      var longer = shorter === a ? b : a;
      if (shorter.n < 1) return;
      var shared = 0;
      shorter.tracks.forEach(function (track, k) {
        if (longer.tracks.has(k)) shared++;
      });
      // One strict rule: either they share a track, or the names are identical
      // bar formatting. A name that merely looks similar never qualifies.
      if (RULES.requireSharedTrack && relation !== 'identical' && shared === 0) {
        if (stats) stats.artistPairsWithoutSharedTrack++;
        return;
      }
      var minTracks = Math.min(shorter.tracks.size, longer.tracks.size) || 1;
      // The entry with FEWER TRACKS is the one fully covered by the other, which is
      // not always the one with the shorter name: “Ana” is shorter than
      // “Ana Bruno” yet has 90 tracks against its 1, so naming the shorter one
      // there produced sentences that were simply untrue.
      var fewer = shorter.tracks.size <= longer.tracks.size ? shorter : longer;
      var more = fewer === shorter ? longer : shorter;
      var mixing = countTemporalMix(shorter.timestamps, longer.timestamps);
      var signals = [];
      var points = 0;

      var coverage = (shared + 0.5) / (minTracks + 1);
      points += 40 * coverage;
      points += 15 * (Math.min(shared, 20) / 20);
      points += relation === 'identical' ? 20 : 15;
      points += 15 * (Math.min(mixing, 10) / 10);
      points += 10 * (Math.min(minTracks, 8) / 8);

      if (relation === 'identical') {
        signals.push(signal('The two names are identical bar capitalisation, accents or punctuation', 'strong'));
      } else {
        signals.push(signal('One name contains the other word for word', 'strong'));
      }
      signals.push(
        signal(
          'They share ' + num(shared) + ' track(s) out of ' + num(minTracks) + ' possible (' +
            pct(shared / minTracks) + ')',
          'strong'
        )
      );
      if (shared === minTracks && shared > 0) {
        signals.push(
          signal(
            'EVERY track under “' + fewer.name + '” also appears under “' + more.name + '”',
            'alarm'
          )
        );
      }
      if (mixing > 0) {
        signals.push(
          signal(
            mixing + ' scrobble(s) of one fall within 10 minutes of scrobbles of the other (same sitting)',
            'strong'
          )
        );
      }
      if (minTracks < 3) {
        signals.push(
          signal(
            'Small sample: “' + fewer.name + '” only has ' + num(minTracks) + ' different track(s)',
            'note'
          )
        );
      }
      var overlap = overlapWindow(shorter, longer);
      if (overlap) signals.push(signal('Their dates overlap: ' + overlap, 'medium'));

      candidates.push({
        type: 'duplicate_artists',
        __a: shorter.name,
        __b: longer.name,
        coverage: minTracks ? shared / minTracks : 0,
        relation: relation,
        shared: shared,
        minTracks: minTracks,
        points: points,
        signals: signals,
        mixing: mixing,
        evidence: { title: 'Tracks present under more than one form', items: sharedTrackEvidence(shorter, longer) }
      });
    }

    // (a) the same normalised name
    var byKey = new Map();
    list.forEach(function (a) {
      if (!a.key) return;
      var group = byKey.get(a.key);
      if (!group) {
        group = [];
        byKey.set(a.key, group);
      }
      group.push(a);
    });
    byKey.forEach(function (group) {
      for (var x = 0; x < group.length; x++) {
        for (var y = x + 1; y < group.length; y++) {
          if (group[x].name !== group[y].name) addPair(group[x], group[y], 'identical');
        }
      }
    });

    // (b) containment, word for word. Artists are indexed by each word of their
    // name so that only pairs that could match are compared, instead of every
    // pair against every other pair (unworkable with thousands of artists).
    var eligible = list.filter(function (a) {
      return a.key && !(a.parts && a.parts.length > 1);
    });
    var byWord = new Map();
    function indexInto(map, k, value) {
      var group = map.get(k);
      if (!group) {
        group = [];
        map.set(k, group);
      }
      group.push(value);
    }
    function wordsOf(k) {
      return k.split(' ').filter(function (w) {
        return w.length >= 2;
      });
    }
    eligible.forEach(function (b) {
      wordsOf(b.key).forEach(function (w) {
        indexInto(byWord, w, b);
      });
    });
    eligible.forEach(function (a) {
      var candidates2 = new Set();
      wordsOf(a.key).forEach(function (w) {
        (byWord.get(w) || []).forEach(function (b) {
          if (b !== a) candidates2.add(b);
        });
      });
      candidates2.forEach(function (b) {
        if (!b.key || a.key === b.key) return; // exact equality is covered in (a)
        // Containment only. The old "starts the same" rule produced nonsense
        // such as “Clara Bell” ~ “Claudia Belmonte”.
        if (!containsWord(b.key, a.key) && !containsWord(a.key, b.key)) return;
        var pairKey = a.name < b.name ? a.name + '\u0000' + b.name : b.name + '\u0000' + a.name;
        if (seen.has(pairKey)) return;
        seen.add(pairKey);
        addPair(a, b, 'containment');
      });
    });
    return candidates;
  }

  function containsWord(haystack, needle) {
    if (!needle || needle === haystack) return false;
    if (haystack.length <= needle.length) return false;
    var at = haystack.indexOf(needle);
    while (at >= 0) {
      var startsWord = at === 0 || haystack[at - 1] === ' ';
      var endsWord = at + needle.length === haystack.length || haystack[at + needle.length] === ' ';
      if (startsWord && endsWord) return true;
      at = haystack.indexOf(needle, at + 1);
    }
    return false;
  }

  /** Scrobbles of one artist that have a scrobble of the other within the session window. */
  function countTemporalMix(timestampsA, timestampsB) {
    if (!timestampsA.length || !timestampsB.length) return 0;
    var a = timestampsA.length <= timestampsB.length ? timestampsA : timestampsB;
    var b = a === timestampsA ? timestampsB : timestampsA;
    var count = 0;
    var j = 0;
    for (var i = 0; i < a.length; i++) {
      var t = a[i];
      while (j < b.length && b[j] < t - RULES.sessionWindowMs) j++;
      if (j < b.length && Math.abs(b[j] - t) <= RULES.sessionWindowMs) count++;
    }
    return count;
  }

  function overlapWindow(a, b) {
    if (isNaN(a.first) || isNaN(b.first)) return '';
    var start = Math.max(a.first, b.first);
    var end = Math.min(a.last, b.last);
    if (end <= start) return '';
    return 'both have scrobbles between ' + shortDate(start) + ' and ' + shortDate(end);
  }

  function sharedTrackEvidence(shorter, longer) {
    var items = [];
    shorter.tracks.forEach(function (track, k) {
      var other = longer.tracks.get(k);
      if (other) {
        items.push({
          a: mostFrequent(track.titles),
          b: num(track.n) + ' + ' + num(other.n) + ' scrobbles',
          n: track.n + other.n
        });
      }
    });
    items.sort(function (x, y) {
      return y.n - x.n;
    });
    return items;
  }

  function mostFrequent(map) {
    var best = null;
    var max = -1;
    map.forEach(function (v, k) {
      if (v > max) {
        max = v;
        best = k;
      }
    });
    return best;
  }

  function variantOf(name, data) {
    return {
      value: name,
      n: data.n,
      first: data.first,
      last: data.last
    };
  }

  /** A pair is only grouped with another one when the evidence is genuinely good. */
  function isStrongUnion(pair) {
    if (pair.relation === 'identical') return true;
    if (pair.relation !== 'containment') return false;
    return pair.shared >= 1 && pair.coverage >= 0.6 && pair.minTracks >= 2;
  }

  /**
   * Turns suspicious artist pairs into findings. Strong pairs are grouped into
   * connected components, so several names of the same artist become one finding.
   */
  function buildMergeFindings(pairs, index) {
    if (!pairs.length) return [];
    var parent = Object.create(null);
    function root(x) {
      if (parent[x] == null) parent[x] = x;
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
      }
      return x;
    }
    function join(a, b) {
      var ra = root(a);
      var rb = root(b);
      if (ra !== rb) parent[rb] = ra;
    }
    pairs.forEach(function (pair) {
      root(pair.__a);
      root(pair.__b);
      if (isStrongUnion(pair)) join(pair.__a, pair.__b);
    });

    var components = new Map();
    pairs.forEach(function (pair) {
      var r = root(pair.__a);
      var group = components.get(r);
      if (!group) {
        group = { pairs: [], names: new Set() };
        components.set(r, group);
      }
      group.pairs.push(pair);
      group.names.add(pair.__a);
      group.names.add(pair.__b);
    });

    var findings = [];
    var namesInGroups = new Set();
    var groups = [];
    components.forEach(function (group) {
      var strongPairs = group.pairs.filter(isStrongUnion);
      var names = Array.from(group.names);
      if (strongPairs.length > 1 && names.length > 1) {
        groups.push({ names: names, pairs: group.pairs });
        names.forEach(function (name) {
          namesInGroups.add(name);
        });
      }
    });

    groups.forEach(function (group) {
      findings.push(buildMergeFinding(group.names, group.pairs, index));
    });

    // Pairs that ended up in no group become their own finding. All of them
    // arrive here sharing at least one track, or with identical names.
    var seenPairs = new Set();
    pairs.forEach(function (pair) {
      var pairKey = pair.__a < pair.__b ? pair.__a + '\u0000' + pair.__b : pair.__b + '\u0000' + pair.__a;
      if (seenPairs.has(pairKey)) return;
      seenPairs.add(pairKey);
      if (namesInGroups.has(pair.__a) || namesInGroups.has(pair.__b)) return;
      findings.push(buildMergeFinding([pair.__a, pair.__b], [pair], index));
    });
    return findings.filter(Boolean);
  }

  function buildMergeFinding(names, pairs, index) {
    var variants = names
      .map(function (name) {
        var data = index.artists.get(name);
        return data ? variantOf(name, data) : null;
      })
      .filter(Boolean);
    if (variants.length < 2) return null;
    var canonical = chooseCanonical(variants);
    var target = canonical.value;
    // If the winning form is itself a combined name (“Ana, Bruno”), the other
    // forms should not be merged into it: they go straight to the artist that
    // name stands for (“Ana”), exactly as the combined-name detector proposes.
    // Otherwise the report would contradict itself, telling you to rename to the
    // very name it is asking you to get rid of somewhere else.
    var redirect = combinedResolution(canonical.value, index);
    if (redirect && !variants.some(function (v) { return v.value === redirect.base.artist.name; })) {
      target = redirect.base.artist.name;
    } else {
      redirect = null;
    }
    var frequent = variants.slice().sort(function (a, b) { return b.n - a.n; })[0];
    var recent = variants.slice().sort(function (a, b) { return (b.last || 0) - (a.last || 0); })[0];
    var impact = variants.reduce(function (acc, v) {
      return v.value === target ? acc : acc + v.n;
    }, 0);
    if (!impact) return null;
    var points = Math.max.apply(null, pairs.map(function (p) { return p.points; }));
    var signals = [];
    var alreadyAdded = new Set();
    pairs.forEach(function (pair) {
      pair.signals.forEach(function (s) {
        if (alreadyAdded.has(s.text) || signals.length >= 9) return;
        alreadyAdded.add(s.text);
        signals.push(s);
      });
    });
    if (redirect) {
      signals.push(
        signal(
          '“' + canonical.value + '” is itself a combined name whose first artist is “' + target +
            '”, so every form here is renamed straight to “' + target + '”',
          'strong'
        )
      );
    } else if (recent && recent.value !== canonical.value) {
      signals.push(
        signal(
          'Careful: the most recent scrobble is under “' + recent.value + '” (' + shortDate(recent.last) +
            ') while the most frequent form is “' + frequent.value + '” (' + num(frequent.n) + ' scrobbles)',
          'note'
        )
      );
    } else if (recent) {
      signals.push(signal('They agree: “' + canonical.value + '” is both the most frequent and the most recent', 'medium'));
    }
    var items = [];
    var seenItems = new Set();
    pairs.forEach(function (pair) {
      var list = (pair.evidence && pair.evidence.items) || [];
      list.forEach(function (item) {
        if (seenItems.has(item.a) || items.length >= RULES.maxEvidence) return;
        seenItems.add(item.a);
        items.push(item);
      });
    });
    var alternatives = variants
      .filter(function (v) { return v.value !== target; })
      .map(function (v) {
        var option = swapOption(
          v,
          variants,
          num(v.n) + ' scrobbles · ' + shortDate(v.first) + ' → ' + shortDate(v.last) +
            (v.value === frequent.value ? ' · the most frequent' : '') +
            (recent && v.value === recent.value ? ' · the most recent' : ''),
          function (variant) { return editTarget(variant.value); }
        );
        var others = variants.filter(function (x) { return x.value !== v.value; });
        option.title = others.length === 1
          ? '“' + others[0].value + '” → “' + v.value + '”'
          : others.length + ' forms of the same artist → “' + v.value + '”';
        return option;
      });
    var nonCanonical = variants.filter(function (v) { return v.value !== target; });
    var finding = newFinding({
      type: 'duplicate_artists',
      subtype: pairs.length > 1 ? 'group' : pairs[0].relation,
      title:
        nonCanonical.length === 1
          ? '“' + nonCanonical[0].value + '” → “' + target + '”'
          : nonCanonical.length + ' forms of the same artist → “' + target + '”',
      points: points,
      impact: impact,
      action: 'rename_artist',
      current: nonCanonical.map(function (v) { return v.value; }).join('  /  '),
      proposed: target,
      signals: signals,
      explanation: mergeExplanation(variants, target, frequent, recent, pairs),
      evidence: items.length ? { title: 'Tracks present under more than one form', items: items } : null,
      alternatives: alternatives
    });
    finding.variants = variants
      .slice()
      .sort(function (a, b) { return b.n - a.n; })
      .map(function (v) {
        return {
          value: v.value,
          n: v.n,
          first: v.first,
          last: v.last,
          canonical: v.value === target
        };
      });
    finding.__artists = nonCanonical.map(function (v) { return v.value; });
    finding.targets = nonCanonical.map(function (v) { return editTarget(v.value); });
    return finding;
  }

  function mergeExplanation(variants, target, frequent, recent, pairs) {
    var parts = [];
    var maxShared = Math.max.apply(null, pairs.map(function (p) { return p.shared; }));
    var maxCoverage = Math.max.apply(
      null,
      pairs.map(function (p) { return p.minTracks ? p.shared / p.minTracks : 0; })
    );
    var total = variants.reduce(function (a, v) { return a + v.n; }, 0);
    parts.push(
      'Your library has ' + variants.length + ' name(s) pointing at the same artist: ' +
      variants.map(function (v) { return '“' + v.value + '” (' + num(v.n) + ' scrobbles)'; }).join(', ') +
      '.'
    );
    if (maxShared > 0) {
      parts.push(
        'The strongest clue is that they share tracks: up to ' + num(maxShared) + ' in common' +
        (maxCoverage >= 1
          ? ', that is, EVERY track under the smaller entry also appears under the other one'
          : '') +
        '.'
      );
    }
    parts.push(
      'That proves nothing on its own (they could be two different artists covering the same songs), ' +
      'but if they are the same, you are splitting across ' + variants.length + ' entries what should be ' +
      'a single one: ' + num(total) + ' scrobbles in total.'
    );
    var kept = variants.filter(function (v) { return v.value === target; });
    parts.push(
      'Proposal: keep “' + target + '”' +
      (kept.length ? '' : ' (which is not one of the forms above)') +
      ' and rename ' + num(variants.length - kept.length) + ' name(s), which would touch ' +
      num(variants.reduce(function (a, v) { return v.value === target ? a : a + v.n; }, 0)) +
      ' scrobbles.'
    );
    return parts.join(' ');
  }

  /* --- 6.1b Artist names that are almost the same --------------------------- */

  /**
   * Names that are nearly identical but invisible to the rules above: “Jana
   * Burčeska” against “Jana Burcheska”, “Marlena” against “Maléna”. The name is
   * neither identical once normalised nor contained in the other, so nothing used
   * to look at them at all.
   *
   * Two outcomes, and the difference matters:
   *   - they share a track: that is the engine's strong proof, so it is a rename
   *     to do (`similar_with_tracks`);
   *   - they share no track: alike is weak evidence, so it is only a question,
   *     marked advisory and never counted as work to do (`similar_names`).
   */
  function detectSimilarArtistNames(index) {
    var out = [];
    var byInitial = new Map();
    index.list.forEach(function (artist) {
      if (!artist.key || artist.key.length < RULES.minArtistLengthForSimilarCompare) return;
      // Combined names are the combined-artist detector's business.
      if (artist.parts && artist.parts.length > 1) return;
      var initial = artist.key.slice(0, 1);
      var bucket = byInitial.get(initial);
      if (!bucket) {
        bucket = [];
        byInitial.set(initial, bucket);
      }
      bucket.push(artist);
    });
    byInitial.forEach(function (bucket) {
      for (var x = 0; x < bucket.length; x++) {
        for (var y = x + 1; y < bucket.length; y++) {
          var a = bucket[x];
          var b = bucket[y];
          if (a.key === b.key) continue; // the identical-name rule already covers it
          if (containsWord(a.key, b.key) || containsWord(b.key, a.key)) continue; // containment covers it
          var alike = alikeArtistKeys(a.key, b.key);
          if (!alike) continue;
          var similarity = alike.strength;

          var shared = 0;
          a.tracks.forEach(function (track, k) {
            if (b.tracks.has(k)) shared++;
          });
          var mixing = countTemporalMix(a.timestamps, b.timestamps);
          var rename = sequentialRename(a, b);
          var canonical = chooseCanonical([variantOf(a.name, a), variantOf(b.name, b)]);
          var suspect = canonical.value === a.name ? b : a;
          var target = canonical.value;
          var alikePhrase = alikeSentence(alike, similarity);
          var signals = [
            signal(
              cap(alikePhrase),
              alike.kind === 'abbreviation' || similarity >= 0.9 ? 'strong' : 'medium'
            )
          ];
          if (shared) signals.push(signal('They share ' + num(shared) + ' track(s)', 'strong'));
          if (mixing) {
            signals.push(
              signal(
                mixing + ' scrobble(s) of one fall within 10 minutes of scrobbles of the other (same sitting)',
                'strong'
              )
            );
          }
          if (rename) {
            signals.push(
              signal(
                '“' + rename.from + '” stops on ' + shortDate(rename.end) + ' and “' + rename.to +
                  '” starts on ' + shortDate(rename.start) + ': that is what a rename looks like',
                'strong'
              )
            );
          }
          signals.push(
            signal('“' + a.name + '” has ' + num(a.n) + ' scrobble(s) and “' + b.name + '” has ' + num(b.n), 'info')
          );

          var subtype;
          var action;
          var points;
          var warning = '';
          var explanation;
          if (shared) {
            subtype = 'similar_with_tracks';
            action = 'rename_artist';
            var minTracks = Math.min(a.tracks.size, b.tracks.size) || 1;
            var coverage = (shared + 0.5) / (minTracks + 1);
            points =
              18 + 30 * coverage + 12 * (Math.min(shared, 20) / 20) +
              12 * (Math.min(mixing, 10) / 10) + 12 * similarity + (rename ? 6 : 0);
            if (shared === minTracks && shared > 0) {
              points += 12;
              signals.push(
                signal(
                  'EVERY track under “' + suspect.name + '” also appears under “' + target + '”',
                  'alarm'
                )
              );
            }
            explanation =
              'Your library has “' + a.name + '” (' + num(a.n) + ' scrobbles) and “' + b.name + '” (' +
              num(b.n) + ' scrobbles), and ' + alikePhrase + '. They share ' + num(shared) +
              ' track(s), so this is very probably the same artist written twice. Renaming “' +
              suspect.name + '” would touch ' + num(suspect.n) + ' scrobble(s).';
          } else {
            subtype = 'similar_names';
            action = 'review_artist';
            points =
              22 + 26 * similarity + 10 * (Math.min(mixing, 10) / 10) + (rename ? 8 : 0);
            warning =
              'A similar name can be a different artist, and these two share no track at all, so this is ' +
              'only a question. The engine cannot tell a misspelling from two artists with similar names.';
            explanation =
              'Your library has “' + a.name + '” (' + num(a.n) + ' scrobble(s)) and “' + b.name + '” (' +
              num(b.n) + ' scrobble(s)), and ' + alikePhrase + ', but they share no track. That is what a ' +
              'misspelling or a rename looks like — and also what two different artists with similar names ' +
              'look like. If they are the same, the rarer form is usually the mistake.';
          }
          var finding = newFinding({
            type: 'duplicate_artists',
            subtype: subtype,
            title: '“' + suspect.name + '” → ' + '“' + target + '”' + (shared ? '' : '?'),
            points: points,
            impact: suspect.n,
            action: action,
            current: suspect.name,
            proposed: target,
            signals: signals,
            warning: warning,
            explanation: explanation,
            evidence: shared
              ? {
                  title: 'Tracks present under both names',
                  items: sharedTrackEvidence(
                    a.tracks.size <= b.tracks.size ? a : b,
                    a.tracks.size <= b.tracks.size ? b : a
                  )
                }
              : {
                  title: 'The two names',
                  items: [
                    {
                      a: '“' + a.name + '”',
                      b: num(a.n) + ' scrobble(s) · ' + shortDate(a.first) + ' → ' + shortDate(a.last)
                    },
                    {
                      a: '“' + b.name + '”',
                      b: num(b.n) + ' scrobble(s) · ' + shortDate(b.first) + ' → ' + shortDate(b.last)
                    },
                    { a: 'Tracks in common', b: num(shared) }
                  ]
                }
          });
          finding.__artists = [suspect.name];
          finding.targets = [editTarget(suspect.name)];
          out.push(finding);
        }
      }
    });
    return out;
  }

  /**
   * How two artist keys are alike, or null when they are not alike enough:
   *
   *   { kind: 'ratio', strength, distance }              “Burčeska” / “Burcheska”
   *   { kind: 'abbreviation', strength, short, long }    “Cris Lora” / “Cristina Lora”
   *
   * The abbreviation case is the word-level one: the same number of words, every
   * word equal except one, and that one is the beginning of the other. Requiring
   * the *other* words to be identical is what keeps out *Clara Bell* / *Claudia
   * Belmonte*, where two words differ at once.
   */
  function alikeArtistKeys(aKey, bKey) {
    var shorter = aKey.length <= bKey.length ? aKey : bKey;
    var longer = shorter === aKey ? bKey : aKey;
    if (longer.length - shorter.length <= RULES.maxSimilarArtistDistance) {
      var distance = editDistance(shorter, longer, RULES.maxSimilarArtistDistance);
      if (distance > 0 && distance <= RULES.maxSimilarArtistDistance) {
        var similarity = 1 - distance / longer.length;
        if (similarity >= RULES.similarArtistNameThreshold) {
          return { kind: 'ratio', strength: similarity, distance: distance };
        }
      }
    }
    var abbreviation = abbreviationPair(aKey, bKey);
    if (abbreviation) {
      return {
        kind: 'abbreviation',
        strength: 0.9 + 0.1 * (abbreviation.short.length / abbreviation.long.length),
        short: abbreviation.short,
        long: abbreviation.long
      };
    }
    return null;
  }

  /**
   * “Cris Lora” against “Cristina Lora”: same number of words, one word is the
   * beginning of the other and every other word matches. A nickname, in other
   * words. [] when that is not the shape of the two names.
   */
  function abbreviationPair(aKey, bKey) {
    var a = aKey.split(' ');
    var b = bKey.split(' ');
    if (a.length !== b.length) return null;
    var differing = -1;
    for (var i = 0; i < a.length; i++) {
      if (a[i] === b[i]) continue;
      if (differing >= 0) return null; // more than one word differs: not this case
      differing = i;
    }
    if (differing < 0) return null; // identical, another rule covers it
    var short = a[differing].length <= b[differing].length ? a[differing] : b[differing];
    var long = short === a[differing] ? b[differing] : a[differing];
    if (short.length < RULES.minAbbreviationLength) return null;
    if (long.indexOf(short) !== 0) return null; // not the beginning of the other
    if (long.length - short.length < RULES.minAbbreviationExtension) return null;
    return { short: short, long: long };
  }

  /** Plain-English description of how two names are alike, lower case. */
  function alikeSentence(alike, strength) {
    if (alike.kind === 'abbreviation') {
      return (
        '“' + alike.short + '” is the beginning of “' + alike.long +
        '”, with every other word of the two names matching'
      );
    }
    return (
      'the two names are ' + pct(strength) + ' alike character by character (' + num(alike.distance) +
      ' character(s) apart)'
    );
  }

  function cap(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  /**
   * A name that stops being used exactly when the other starts: that is what a
   * rename looks like from the outside. [] when their dates overlap or are unknown.
   */
  function sequentialRename(a, b) {
    if (isNaN(a.first) || isNaN(b.first)) return null;
    var older;
    var newer;
    if (a.last <= b.first) {
      older = a;
      newer = b;
    } else if (b.last <= a.first) {
      older = b;
      newer = a;
    } else {
      return null;
    }
    return { from: older.name, to: newer.name, end: older.last, start: newer.first };
  }

  /* --- 6.2 Artist repeated inside the track title ---------------------------- */

  /**
   * A title that starts by repeating the artist name (“Nina — Nina - Amame”) carries
   * the real title after the separator. Returns that leftover, or null when the
   * title does not repeat the artist.
   *
   * The badge detector calls this too, so that the two can never both claim the same
   * title: a title repeating the artist belongs to this detector alone.
   */
  function titleRepeatsArtist(artistName, rawTitle) {
    if (!artistName || !rawTitle) return null;
    var aKey = artistKey(artistName);
    if (aKey.length < 3) return null;
    var title = normaliseText(rawTitle);
    if (key(title).indexOf(aKey + ' ') !== 0) return null;
    var rest = title.slice(artistName.length);
    if (!/^\s*[-–—:]\s*\S/.test(rest)) return null;
    return normaliseText(rest.replace(/^\s*[-–—:]\s*/, '')) || null;
  }

  function detectArtistInTitle(scrobbles) {
    var groups = new Map();
    for (var i = 0; i < scrobbles.length; i++) {
      var s = scrobbles[i];
      var cleaned = titleRepeatsArtist(s.artist, s.title);
      if (!cleaned) continue;
      // The leftover often ends with a platform badge as well (“Nina - Amame
      // (Official Video)”), and the badge detector deliberately leaves these titles
      // to this one. So this is where the whole fix belongs: strip the artist name
      // AND the badge, instead of leaving two cards proposing half a fix each.
      var debadged = stripPlatformBadges(cleaned);
      var hadBadge = !!debadged && debadged !== cleaned;
      if (hadBadge) cleaned = debadged;
      var groupKey = s.artist + '\u0000' + s.title;
      var group = groups.get(groupKey);
      if (!group) {
        group = { artist: s.artist, current: s.title, proposed: cleaned, n: 0, hadBadge: hadBadge };
        groups.set(groupKey, group);
      }
      group.n++;
    }
    var out = [];
    groups.forEach(function (group) {
      var points = 62 + Math.min(20, Math.log10(1 + group.n) * 12);
      if (group.n > 5) points += 6;
      var finding = newFinding({
        type: 'artist_in_title',
        title: 'Title repeats the artist: “' + group.current + '”',
        points: points,
        impact: group.n,
        action: 'strip_artist_from_title',
        current: group.artist + ' — ' + group.current,
        proposed: group.proposed,
        signals: [
          signal('The title starts with the artist name and repeats it', 'strong'),
          group.hadBadge
            ? signal('It also ends with a platform badge (“Official Video”, “Audio”…)', 'strong')
            : null,
          signal(num(group.n) + ' scrobble(s) with this form', 'medium')
        ].filter(Boolean),
        explanation:
          'The Artist field already says “' + group.artist + '”, yet the title repeats it. That is typical ' +
          'of a badly tagged file or a scrobble taken from a video page. Proposal: leave the title as “' +
          group.proposed + '”.' +
          (group.hadBadge
            ? ' The tail with the platform badge (“Official Video”, “Audio”…) goes away with it: that is ' +
              'what a video page adds to the upload, not the name of the track.'
            : ''),
        evidence: { title: 'Full form', items: [{ a: group.current, b: num(group.n) + ' scrobbles' }] }
      });
      finding.__variants = [[group.artist, group.current]];
      finding.targets = [editTarget(group.artist, group.current)];
      out.push(finding);
    });
    return out;
  }

  /* --- 6.3 Combined artist names -------------------------------------------- */

  /**
   * How a combined name (“A, B and C”) should be read. Returns null when the name
   * does not join several artists, or when none of them exists separately.
   *
   *   artist    the record of the name itself
   *   parts     the artists the name joins, in the order they are written
   *   bases     those that exist on their own in this library
   *   base      the proposal: the FIRST of them, not the most scrobbled one
   *   siblings  the same name written differently (“Ana Bruno” for “Ana, Bruno”)
   *
   * The duplicate-name detector uses the very same function, so the two can never
   * propose different targets for the same artist.
   */
  function combinedResolution(name, index) {
    var artist = index.artists.get(name);
    if (!artist || !artist.parts || artist.parts.length < 2) return null;
    var bases = [];
    artist.parts.forEach(function (part) {
      var partKey = artistKey(part);
      for (var i = 0; i < index.list.length; i++) {
        var other = index.list[i];
        if (other.name === name) continue;
        if (other.key === partKey) {
          bases.push({ part: part, artist: other });
          return;
        }
      }
    });
    if (!bases.length) return null; // no standalone base: probably a real group
    var base = bases[0];
    // Guard against false positives: a base with a single scrobble is likely a
    // coincidence, and if the combined name is far more frequent than the base,
    // the duplicate is more likely the base, not the other way round.
    if (base.artist.n < 2) return null;
    if (base.artist.n < 0.05 * artist.n) return null;
    // The same name without its separator (“Ana Bruno”) is the same artist, only
    // written differently, so it is swept up by this finding instead of becoming
    // a finding of its own pointing somewhere else.
    var siblings = [];
    index.list.forEach(function (other) {
      if (other.name !== name && other.key === artist.key) siblings.push(other);
    });
    return { artist: artist, parts: artist.parts, bases: bases, base: base, siblings: siblings };
  }

  function detectCombinedArtists(index) {
    var out = [];
    index.list.forEach(function (artist) {
      var resolution = combinedResolution(artist.name, index);
      if (!resolution) return;
      var group = { name: artist.name, n: artist.n, parts: resolution.parts };
      var existingBases = resolution.bases;
      var base = resolution.base;
      var siblings = resolution.siblings;
      var siblingNames = siblings.map(function (sb) { return sb.name; });
      var impact = siblings.reduce(function (acc, sb) { return acc + sb.n; }, group.n);
      var isFirst = artistKey(group.parts[0]) === base.artist.key;

      var rest = group.parts.filter(function (p) {
        return p !== base.part;
      });
      var points = 55;
      var warning = '';
      var signals = [
        signal('The name joins several artists separated by “' + visibleSeparator(group.name) + '”', 'medium')
      ];
      signals.push(signal('“' + base.artist.name + '” exists on its own with ' + num(base.artist.n) + ' scrobbles', 'strong'));
      if (!isFirst) {
        points -= 8;
        warning =
          'The name starts with “' + group.parts[0] + '”, but you do not have that artist on its own, so ' +
          'the proposal uses the first artist of the name that does exist in your library: “' +
          base.artist.name + '”. If the main artist was “' + group.parts[0] + '”, check the name before ' +
          'applying it.';
        signals.push(
          signal('The first artist of the name (“' + group.parts[0] + '”) does not exist separately in your library', 'note')
        );
      }
      if (existingBases.length > 1) {
        points -= 6;
        signals.push(
          signal(
            'Other artists in this name that also exist separately: ' +
              existingBases
                .slice(1)
                .map(function (b) { return '“' + b.artist.name + '” (' + num(b.artist.n) + ')'; })
                .join(', '),
            'info'
          )
        );
      }
      if (group.n <= 5) {
        points += 12;
        signals.push(signal('Only ' + num(group.n) + ' scrobble(s) under the combined name', 'medium'));
      }
      if (base.artist.n >= 20) points += 8;
      if (datesNearby(index.artists.get(group.name), base.artist)) {
        points += 8;
        signals.push(signal('The combined scrobbles fall close in time to the base artist’s scrobbles', 'medium'));
      }
      var sharedTitles = 0;
      var examples = [];
      var combined = index.artists.get(group.name);
      if (combined) {
        combined.tracks.forEach(function (track, k) {
          if (base.artist.tracks.has(k)) {
            sharedTitles++;
            if (examples.length < RULES.maxEvidence) {
              examples.push({ a: mostFrequent(track.titles), b: 'also under “' + base.artist.name + '”' });
            }
          }
        });
      }
      if (sharedTitles) {
        points += 12;
        signals.push(
          signal('There are ' + num(sharedTitles) + ' track(s) you also have under “' + base.artist.name + '”', 'strong')
        );
      }
      if (siblingNames.length) {
        points += 4;
        signals.push(
          signal(
            'The same name also appears as ' +
              siblingNames.map(function (sb) { return '“' + sb + '”'; }).join(', ') +
              ' (' + num(impact - group.n) + ' scrobble(s)), with the separator as the only difference',
            'strong'
          )
        );
      }
      var finding = newFinding({
        type: 'combined_artists',
        title: '“' + group.name + '” → “' + base.artist.name + '”',
        points: points,
        impact: impact,
        action: 'split_combined',
        current: [group.name].concat(siblingNames).join('  /  '),
        proposed: base.artist.name,
        signals: signals,
        warning: warning,
        explanation:
          'You have ' + num(impact) + ' scrobble(s) under “' + group.name + '”' +
          (siblingNames.length ? ' (and its variant ' + siblingNames.join(', ') + ')' : '') +
          ', which appears to join ' +
          num(group.parts.length) + ' artists. As “' + base.artist.name + '” does exist on its own in your ' +
          'library (' + num(base.artist.n) + ' scrobbles), the likeliest reading is that these scrobbles ' +
          'should sit under “' + base.artist.name + '” and that the rest (' + rest.join(', ') + ') is a ' +
          'featuring credit that belongs in the title, not in the artist field. BUT if “' + group.name +
          '” is a real group (a duo, say), leave it as it is.',
        evidence: examples.length
          ? { title: 'Tracks you also have under the base artist', items: examples }
          : null,
        alternatives: rest.map(function (r) {
          return {
            value: r,
            reason: 'part of the combined name',
            current: [group.name].concat(siblingNames).join('  /  '),
            proposed: r,
            impact: impact,
            title: '“' + group.name + '” → “' + r + '”'
          };
        })
      });
      if (siblingNames.length) {
        finding.variantsTitle = 'Forms of this artist name';
        finding.variants = [group]
          .map(function (g) {
            return { value: g.name, n: g.n, first: artist.first, last: artist.last, canonical: false };
          })
          .concat(
            siblings.map(function (sb) {
              return { value: sb.name, n: sb.n, first: sb.first, last: sb.last, canonical: false };
            })
          );
      }
      finding.__artists = [group.name].concat(siblingNames);
      finding.targets = [group.name].concat(siblingNames).map(function (name) { return editTarget(name); });
      out.push(finding);
    });
    return out;
  }

  function visibleSeparator(name) {
    if (/,/.test(name)) return ',';
    if (/\s&\s/.test(name)) return ' &';
    return 'several';
  }

  function datesNearby(a, b) {
    if (!a || !b) return false;
    var day = 24 * 3600 * 1000;
    return Math.abs((a.last || 0) - (b.first || 0)) < 7 * day || countTemporalMix(a.timestamps, b.timestamps) > 0;
  }

  /* --- 6.4 Inconsistent track titles ---------------------------------------- */

  function detectTitleVariants(scrobbles) {
    var byArtist = new Map(); // artist -> Map(loose key -> Map(raw title -> n))
    for (var i = 0; i < scrobbles.length; i++) {
      var s = scrobbles[i];
      var k = s.__key != null ? s.__key : (s.__key = looseTitleKey(s.title));
      if (!k) continue;
      var tracks = byArtist.get(s.artist);
      if (!tracks) {
        tracks = new Map();
        byArtist.set(s.artist, tracks);
      }
      var spellings = tracks.get(k);
      if (!spellings) {
        spellings = new Map();
        tracks.set(k, spellings);
      }
      spellings.set(s.title, (spellings.get(s.title) || 0) + 1);
    }
    var out = [];
    byArtist.forEach(function (tracks, artist) {
      tracks.forEach(function (spellings) {
        if (spellings.size < 2) return;
        var allSpellings = [];
        spellings.forEach(function (n, raw) {
          var qualifiers = qualifiersOf(raw);
          allSpellings.push({
            value: raw,
            n: n,
            strict: strictTitleKey(raw),
            qualifiers: qualifiers,
            differentVersion: RE_DIFFERENT_VERSION.test(key(raw)),
            platformBadge: qualifiers.split(' | ').some(isPlatformBadge)
          });
        });
        // A spelling that is nothing but a platform badge (“(Official Video)”,
        // “- Audio”) is not a title variant: the badge detector owns those and
        // proposes to strip the badge. Keeping them out of this comparison means a
        // track is never reported twice, and that “Song” against
        // “Song (Official Video)” no longer reads as an ordinary with/without
        // qualifier case.
        var variants = allSpellings.filter(function (v) {
          return !v.platformBadge;
        });
        if (variants.length < 2) return;
        var strictKeys = new Set(variants.map(function (v) { return v.strict; }));
        var qualifiers = new Set(variants.map(function (v) { return v.qualifiers || ''; }));
        var withoutQualifier = variants.filter(function (v) { return !v.qualifiers; });
        var withQualifier = variants.filter(function (v) { return v.qualifiers; });
        // Is the featuring credit the only difference?
        var signatures = new Set(
          variants.map(function (v) {
            var parts = titleParts(v.value);
            var others = parts.qualifiers.filter(function (q) {
              return !/^\s*(feat|featuring|ft|with|con)\b/.test(q);
            });
            return key(parts.base) + '|' + others.join(',');
          })
        );
        var featuringOnly =
          signatures.size === 1 &&
          variants.some(function (v) {
            return /\b(feat|featuring|ft|with)\b/.test(key(v.value));
          });
        var points;
        var signals = [];
        var warning = '';
        var subtype;
        var action = 'rename_track';
        var caseOnly = false;
        if (featuringOnly && strictKeys.size > 1) {
          subtype = 'featuring';
          points = 55;
          signals.push(
            signal('Same title, but one form carries the featuring credit in brackets and the other does not', 'strong')
          );
          warning =
            'In Last.fm the featuring credit usually stays in the title ONLY if the main artist does not ' +
            'already carry it. Pick one of the two forms and apply it to all of them.';
        } else if (strictKeys.size === 1) {
          // The forms are the same title bar capitalisation, accents, quotes or spaces.
          // Which of those it is matters, so they are split apart: a wrong accent or a
          // broken quote is damaged tagging, while a difference of capitalisation alone
          // changes nothing about the track and carries no information. That second kind
          // gets its own sub-case and does not count as work to do.
          caseOnly = new Set(variants.map(function (v) { return v.value.toLowerCase(); })).size === 1;
          if (caseOnly) {
            subtype = 'case_only';
            action = 'review_capitalisation';
            points = 44;
            signals.push(signal('The forms differ only in capitalisation', 'strong'));
          } else {
            subtype = 'formatting';
            points = 85;
            signals.push(signal('Written identically except for accents, quotes or spaces', 'strong'));
          }
        } else if (qualifiers.size === 1 && withQualifier.length === variants.length) {
          subtype = 'qualifier_formatting';
          points = 78;
          signals.push(signal('Same qualifier, but in brackets in one form and after a dash in the other', 'strong'));
        } else if (withoutQualifier.length && withQualifier.length) {
          signals.push(signal('One form carries no qualifier and the other does', 'medium'));
          if (withQualifier.some(function (v) { return v.differentVersion; })) {
            // “Patata” against “Patata (live)”. The qualifier claims a different
            // recording, so this is not a merge to do but a decision to make: it
            // gets its own sub-case, away from the ordinary title variants, and it
            // does not count as work to do.
            subtype = 'version_marker';
            action = 'review_track';
            points = 40;
            signals.push(
              signal('The other form says it is a different recording: “' + qualifierList(withQualifier) + '”', 'strong')
            );
            warning =
              'Careful: that qualifier (live, remix, acoustic, version…) usually means a DIFFERENT ' +
              'recording. Do not merge without checking.';
          } else {
            subtype = 'one_qualified';
            points = 52;
          }
        } else {
          subtype = 'different_qualifiers';
          action = 'review_track';
          points = 38;
          signals.push(signal('The qualifiers differ from one another', 'weak'));
          warning = 'These may well be different versions. Check them one by one before merging.';
        }
        var ordered = variants.slice().sort(function (x, y) { return y.n - x.n; });
        var canonical = chooseCanonical(ordered);
        // With a version marker the plain form is the safer proposal: the qualified
        // one explicitly claims to be a different recording, so renaming the plain
        // scrobbles into it would invent a credit they never had. Choosing on
        // recency or on name length picked “Amarcord - Acoustic Version” as the
        // target and told you to turn “Amarcord” into it.
        if (subtype === 'version_marker' && withoutQualifier.length) {
          canonical = withoutQualifier.slice().sort(function (x, y) { return y.n - x.n; })[0];
        }
        var impact = variants.reduce(function (acc, v) {
          return v.value === canonical.value ? acc : acc + v.n;
        }, 0);
        if (!impact) return;
        var examples = ordered.map(function (v) {
          return { a: v.value, b: num(v.n) + ' scrobble(s)' };
        });
        var finding = newFinding({
          type: 'title_variants',
          subtype: subtype,
          title: '“' + artist + '” — ' + variants.length + ' forms of the same title',
          points: points + Math.min(8, Math.log10(1 + impact) * 6),
          impact: impact,
          action: action,
          current: variants
            .filter(function (v) { return v.value !== canonical.value; })
            .map(function (v) { return v.value; })
            .join('  /  '),
          proposed: canonical.value,
          signals: signals,
          warning: warning,
          explanation:
            'Under “' + artist + '” you have ' + variants.length + ' different forms of the same title. ' +
            'The proposal is to keep “' + canonical.value + '” (' + num(canonical.n) + ' scrobbles) and ' +
            'change ' + num(impact) + ' scrobble(s) of the other forms.' +
            (caseOnly
              ? ' Capitalisation is the only difference, so nothing here is damaged and nothing is lost: ' +
                'unifying them is tidiness, not a fix, which is why it is not counted as work to do. ' +
                'Whether Last.fm draws a line between two spellings that differ only in capitalisation is ' +
                'not something this file can tell you.'
              : ''),
          evidence: { title: 'Forms found', items: examples },
          alternatives: ordered
            .filter(function (v) { return v.value !== canonical.value; })
            .slice(0, 3)
            .map(function (v) {
              return swapOption(v, variants, num(v.n) + ' scrobbles', function (variant) {
                return editTarget(artist, variant.value);
              });
            })
        });
        finding.__variants = variants
          .filter(function (v) { return v.value !== canonical.value; })
          .map(function (v) { return [artist, v.value]; });
        finding.targets = variants
          .filter(function (v) { return v.value !== canonical.value; })
          .map(function (v) { return editTarget(artist, v.value); });
        out.push(finding);
      });
    });
    return out;
  }

  /**
   * Titles written almost identically under the same artist: "Patata" against
   * "Patataa" or "Papata". The comparison is deliberately narrow, because with
   * short titles almost any two of them are one character apart:
   *   - same artist, and both titles start with the same letter;
   *   - the rarer form has at most RULES.maxScrobblesForRareTitle scrobbles (and
   *     there is a difference in volume: with a tie there is no way to tell which
   *     one is the typo);
   *   - within RULES.maxTitleTypoDistance characters, or
   *     maxTitleTypoDistanceWithAlbum when both forms share an album;
   *   - titles that differ only in their digits are never compared ("Track 1"
   *     against "Track 2" is two different songs);
   *   - titles carrying a version marker (live, remix, acoustic…) are skipped.
   */
  function detectTitleTypos(index) {
    var out = [];
    index.list.forEach(function (artist) {
      var keys = Array.from(artist.tracks.keys()).filter(function (k) {
        return k.length >= RULES.minTitleLengthForTypoCompare;
      });
      if (keys.length < 2) return;
      var byInitial = new Map();
      keys.forEach(function (k) {
        var initial = k.slice(0, 1);
        var bucket = byInitial.get(initial);
        if (!bucket) {
          bucket = [];
          byInitial.set(initial, bucket);
        }
        bucket.push(k);
      });
      byInitial.forEach(function (bucket) {
        for (var x = 0; x < bucket.length; x++) {
          for (var y = x + 1; y < bucket.length; y++) {
            var aKey = bucket[x];
            var bKey = bucket[y];
            if (Math.abs(aKey.length - bKey.length) > RULES.maxTitleTypoDistanceWithAlbum) continue;
            // “Lugar I” against “Lugar II”, “Track 1” against “Track 2”: two
            // different songs, not a typo.
            if (sameModuloOrdinals(aKey, bKey)) continue;
            // “Tequila & Lemon (Instrumental)” against “Tequila & Lemon” looks one
            // character apart once the qualifier is stripped: it is a different
            // recording, and the rest of the engine treats it as one.
            if (
              RE_DIFFERENT_VERSION.test(aKey) ||
              RE_DIFFERENT_VERSION.test(bKey) ||
              trackHasVersionMarker(artist.tracks.get(aKey)) ||
              trackHasVersionMarker(artist.tracks.get(bKey))
            ) {
              continue;
            }
            var a = artist.tracks.get(aKey);
            var b = artist.tracks.get(bKey);
            var rarer = a.n <= b.n ? a : b;
            var commoner = rarer === a ? b : a;
            if (rarer.n >= commoner.n) continue; // a tie: no way to pick a suspect
            if (rarer.n > RULES.maxScrobblesForRareTitle) continue;
            var sharedAlbum = firstSharedKey(rarer.albums, commoner.albums);
            var limit = sharedAlbum ? RULES.maxTitleTypoDistanceWithAlbum : RULES.maxTitleTypoDistance;
            var distance = editDistance(aKey, bKey, limit);
            if (distance > limit) continue;
            var rareForm = mostFrequent(rarer.titles);
            var commonForm = mostFrequent(commoner.titles);
            var points = 38;
            points += distance === 1 ? 14 : 7;
            if (sharedAlbum) points += 16;
            if (rarer.n === 1 && sharedAlbum) points += 6;
            var signals = [
              signal(
                'The two titles are ' + num(distance) + ' character(s) apart: “' + rareForm + '” against “' +
                  commonForm + '”',
                distance === 1 ? 'strong' : 'medium'
              )
            ];
            if (sharedAlbum) {
              signals.push(signal('Both forms are scrobbled under the album “' + sharedAlbum + '”', 'strong'));
            }
            signals.push(signal('The rarer form only has ' + num(rarer.n) + ' scrobble(s)', 'medium'));
            signals.push(
              signal('Only titles starting with the same letter are compared: this check is deliberately narrow', 'note')
            );
            var finding = newFinding({
              type: 'title_variants',
              subtype: 'typo',
              title: 'Probably a typo: “' + rareForm + '” → “' + commonForm + '”',
              points: points,
              impact: rarer.n,
              action: 'rename_track',
              current: rareForm,
              proposed: commonForm,
              signals: signals,
              warning:
                'A similar name can be a different song. If “' + rareForm + '” is a different recording, leave ' +
                'it alone: the engine only sees the spelling, and “' + commonForm + '” has ' + num(commoner.n) +
                ' scrobble(s).',
              explanation:
                'Under “' + artist.name + '” this title appears both as “' + commonForm + '” (' +
                num(commoner.n) + ' scrobbles) and as “' + rareForm + '” (' + num(rarer.n) + '), ' +
                num(distance) + ' character(s) apart' + (sharedAlbum ? ', on the same album' : '') +
                '. One of the two is very probably a typo, and the rarer one is the likelier candidate.',
              evidence: {
                title: 'The two forms',
                items: [
                  { a: rareForm, b: num(rarer.n) + ' scrobble(s) · the rarer form' },
                  { a: commonForm, b: num(commoner.n) + ' scrobble(s) · the proposed form' }
                ]
              }
            });
            finding.__variants = [[artist.name, rareForm]];
            finding.targets = [editTarget(artist.name, rareForm)];
            out.push(finding);
          }
        }
      });
    });
    return out;
  }

  /** The qualifiers found across a set of title variants, as a readable list. */
  function qualifierList(variants) {
    var seen = [];
    variants.forEach(function (v) {
      if (v.qualifiers && seen.indexOf(v.qualifiers) < 0) seen.push(v.qualifiers);
    });
    return seen.join(' · ');
  }

  function firstSharedKey(mapA, mapB) {
    var found = null;
    mapA.forEach(function (count, name) {
      if (found != null) return;
      if (mapB.has(name)) found = name;
    });
    return found;
  }

  var RE_ROMAN =
    /^(i|ii|iii|iv|v|vi|vii|viii|ix|x|xi|xii|xiii|xiv|xv|xvi|xvii|xviii|xix|xx)$/;

  /** The key with digits and roman numerals removed, for comparing sequences. */
  function ordinalStripped(k) {
    return k
      .replace(/[0-9]+/g, ' ')
      .split(' ')
      .filter(function (w) {
        return w && !RE_ROMAN.test(w);
      })
      .join(' ');
  }

  /**
   * True when two titles are the same once their numbering is dropped: “Lugar I”
   * and “Lugar II” are two different songs, so they must never pair up.
   */
  function sameModuloOrdinals(aKey, bKey) {
    return ordinalStripped(aKey) === ordinalStripped(bKey);
  }

  /**
   * True when any spelling of a track carries a version marker (live, remix,
   * instrumental…). The loose key drops the qualifier, so the raw titles are the
   * only place that marker can still be seen.
   */
  function trackHasVersionMarker(track) {
    if (!track) return false;
    var found = false;
    track.titles.forEach(function (count, raw) {
      if (!found && RE_DIFFERENT_VERSION.test(key(raw))) found = true;
    });
    return found;
  }

  /* --- 6.4b Titles carrying a platform badge --------------------------------- */

  /**
   * “Song (Official Video)”, “Song - Audio”, “Song (Lyric Video)”: the title a
   * video page carries, not the one the track has. It is worth saying out loud
   * because it points at where the scrobble came from — YouTube or Vevo, not a
   * music player — and because it is invisible when EVERY scrobble of a track
   * carries the badge, since then there is no clean spelling to compare against.
   *
   * The proposal is the badge-free title: the clean spelling you already have if
   * there is one, or the same title with only the badge removed if there is not.
   */
  function detectPlatformBadges(index) {
    var out = [];
    index.list.forEach(function (artist) {
      artist.tracks.forEach(function (track) {
        var badges = [];
        var plain = [];
        track.titles.forEach(function (n, raw) {
          // “Nina - Amame (Official Video)” repeats the artist as well, and the
          // “Artist repeated in title” detector strips the prefix AND the badge in
          // one card. Claiming it here too would mean two cards and two half fixes.
          if (titleRepeatsArtist(artist.name, raw)) return;
          var qualifiers = qualifiersOf(raw);
          var bad = qualifiers.split(' | ').filter(isPlatformBadge);
          if (bad.length) badges.push({ value: raw, n: n, badges: bad });
          else plain.push({ value: raw, n: n });
        });
        if (!badges.length) return;
        plain.sort(function (a, b) { return b.n - a.n; });
        var plainNames = new Set(plain.map(function (p) { return p.value; }));
        // The proposal is always “the same title with the badge taken off”, never
        // “the most scrobbled clean form”: the second one can ask for more than the
        // badge (turning “Song (Visual)” into “Song (feat. X)” reads as adding a
        // credit), and unifying spellings is the other sub-case’s job anyway.
        var buckets = new Map(); // stripped title -> { target, forms, n }
        badges.forEach(function (b) {
          var target = stripPlatformBadges(b.value);
          if (!target || target === b.value) return;
          var bucket = buckets.get(target);
          if (!bucket) {
            bucket = { target: target, forms: [], n: 0 };
            buckets.set(target, bucket);
          }
          bucket.forms.push(b);
          bucket.n += b.n;
        });
        buckets.forEach(function (bucket) {
          bucket.forms.sort(function (a, b) { return b.n - a.n; });
          var impact = bucket.n;
          var hasClean = plainNames.has(bucket.target);
          var points = 55 + Math.min(12, Math.log10(1 + impact) * 9) + (hasClean ? 0 : 6);
          var signals = [
            signal(
              'The title carries a platform badge: ' +
                bucket.forms[0].badges.map(function (b) { return '“' + b + '”'; }).join(', '),
              'strong'
            )
          ];
          if (hasClean) {
            signals.push(
              signal('You also have the clean title under the same artist: “' + bucket.target + '”', 'strong')
            );
          } else {
            signals.push(signal('No scrobble of this track has the clean title', 'note'));
          }
          signals.push(signal(num(impact) + ' scrobble(s) carry the badge', 'medium'));
          var finding = newFinding({
            type: 'title_variants',
            subtype: 'platform_badge',
            title:
              bucket.forms.length === 1
                ? 'Scrobbled from a video page: “' + bucket.forms[0].value + '”'
                : bucket.forms.length + ' video-page forms of “' + bucket.target + '”',
            points: points,
            impact: impact,
            action: 'rename_track',
            current: bucket.forms.map(function (b) { return b.value; }).join('  /  '),
            proposed: bucket.target,
            signals: signals,
            warning:
              'A title ending in “(Official Video)”, “(Official Audio)” or “(Lyric Video)” is usually a sign ' +
              'that the scrobble came from a video page (YouTube, Vevo) rather than from your music player, ' +
              'and Last.fm stored the video’s title as the track name. Stripping the badge gives the track its ' +
              'real name, but if you scrobbled the video on purpose, leave it alone.',
            explanation:
              'Under “' + artist.name + '” the title appears as “' + bucket.forms[0].value + '”, which adds ' +
              'something a video page says about the upload (that it is the official video, the audio, the ' +
              'lyrics…) rather than something that belongs to the song. ' +
              (hasClean
                ? 'You also have the clean form “' + bucket.target + '”, so these ' + num(impact) +
                  ' scrobble(s) are simply the same track tagged twice.'
                : 'No scrobble of this track carries the clean title, so all ' + num(impact) +
                  ' of them would be renamed at once.'),
            evidence: {
              title: 'Forms found',
              items: bucket.forms
                .map(function (b) {
                  return { a: b.value, b: num(b.n) + ' scrobble(s) · with a badge' };
                })
                .concat(
                  plain.map(function (p) {
                    return { a: p.value, b: num(p.n) + ' scrobble(s)' };
                  })
                )
            }
          });
          finding.__variants = bucket.forms.map(function (b) { return [artist.name, b.value]; });
          finding.targets = bucket.forms.map(function (b) { return editTarget(artist.name, b.value); });
          out.push(finding);
        });
      });
    });
    return out;
  }

  /* --- 6.5 Albums ------------------------------------------------------------ */

  function detectAlbumIssues(scrobbles, index, stats) {
    var out = [];
    // (a) fillable missing albums and (b) album clashes
    var byCombo = new Map();
    for (var i = 0; i < scrobbles.length; i++) {
      var s = scrobbles[i];
      var trackKey = s.__key != null ? s.__key : (s.__key = looseTitleKey(s.title));
      var comboKey = s.artist + '\u0000' + trackKey;
      var group = byCombo.get(comboKey);
      if (!group) {
        group = { artist: s.artist, trackKey: trackKey, titles: new Map(), albums: new Map(), missing: 0, n: 0 };
        byCombo.set(comboKey, group);
      }
      group.n++;
      group.titles.set(s.title, (group.titles.get(s.title) || 0) + 1);
      if (s.album) group.albums.set(s.album, (group.albums.get(s.album) || 0) + 1);
      else group.missing++;
    }
    byCombo.forEach(function (group) {
      var title = mostFrequent(group.titles);
      if (group.missing > 0 && group.albums.size > 0) {
        var bestAlbum = mostFrequent(group.albums);
        var bestCount = group.albums.get(bestAlbum);
        var sameAsTitle = key(bestAlbum) === looseTitleKey(title);
        var points = 78 + (group.missing >= 3 ? 8 : 0) + (bestCount / (group.n - group.missing) >= 0.8 ? 6 : 0);
        if (sameAsTitle) points = 52;
        var missingFinding = newFinding({
          type: 'albums',
          subtype: 'missing',
          title: 'No album: “' + group.artist + ' — ' + title + '”',
          points: points,
          impact: group.missing,
          action: 'fill_album',
          current: title,
          proposed: bestAlbum,
          warning: sameAsTitle
            ? 'The album that would be filled in (“' + bestAlbum + '”) is named AFTER the track. That is ' +
              'usually a wrong automatic tag from the importer rather than the real album: check which album ' +
              'it really came from before touching anything.'
            : '',
          signals: [
            signal(num(group.missing) + ' scrobble(s) of this track have no album', 'strong'),
            signal('Another ' + num(group.n - group.missing) + ' do have “' + bestAlbum + '”', sameAsTitle ? 'medium' : 'strong'),
            sameAsTitle ? signal('The album “' + bestAlbum + '” matches the track title', 'note') : null
          ].filter(Boolean),
          explanation:
            'The same track appears with and without an album under “' + group.artist + '”. ' +
            (sameAsTitle
              ? 'The album that some scrobbles carry is named after the track, so it is probably a wrong tag: ' +
                'filling the empty ones with it would spread the mistake.'
              : 'As the album “' + bestAlbum + '” is already there on ' + num(bestCount) + ' scrobble(s), the ' +
                'sensible move is to fill in the ' + num(group.missing) + ' that are empty.'),
          evidence: {
            title: 'Albums seen for this track',
            items: Array.from(group.albums.entries())
              .sort(function (x, y) { return y[1] - x[1]; })
              .map(function (e) { return { a: e[0], b: num(e[1]) + ' scrobble(s)' }; })
              .concat([{ a: '(no album)', b: num(group.missing) + ' scrobble(s)' }])
          }
        });
        missingFinding.__emptyAlbums = [[group.artist, group.trackKey]];
        missingFinding.targets = [editTarget(group.artist, title)];
        out.push(missingFinding);
      }
      if (group.albums.size > 1) {
        var ranked = Array.from(group.albums.entries()).sort(function (x, y) { return y[1] - x[1]; });
        var canonical = { value: ranked[0][0], n: ranked[0][1] };
        var impact = group.n - canonical.n - group.missing;
        // The "single vs album" case is legitimate and very common: only list it
        // when there is enough volume to be worth a look.
        if (impact < RULES.minAlbumImpact) {
          if (stats) stats.albumClashesBelowThreshold++;
          return;
        }
        var points2 = 48 + Math.min(10, Math.log10(1 + impact) * 6);
        var canonicalLooksLikeTitle = key(canonical.value) === looseTitleKey(title);
        if (canonicalLooksLikeTitle) points2 = Math.min(points2, 44);
        var anyAlbumEqualsTitle = Array.from(group.albums.keys()).some(function (a) {
          return key(a) === looseTitleKey(title);
        });
        var clash = newFinding({
          type: 'albums',
          subtype: 'clash',
          title: 'Several albums: “' + group.artist + ' — ' + title + '”',
          points: points2,
          impact: Math.max(impact, 0),
          action: 'review_album',
          current: title,
          proposed: canonical.value,
          warning: anyAlbumEqualsTitle
            ? 'One of the albums is named after the track, and that pattern is usually a wrong automatic tag. ' +
              'Check which album it really belongs to.'
            : '',
          signals: [
            signal('The same title appears with ' + num(group.albums.size) + ' different albums', 'medium'),
            signal('The most used is “' + canonical.value + '” (' + num(canonical.n) + ' scrobbles)', 'medium'),
            anyAlbumEqualsTitle ? signal('One album matches the track title', 'note') : null
          ].filter(Boolean),
          explanation:
            'This may be correct (the single and the album are different things) or just a slip. If you want ' +
            'to merge them, “' + canonical.value + '” is the most frequent. If not, ignore this finding.',
          evidence: {
            title: 'Albums seen',
            items: ranked.map(function (e) { return { a: e[0], b: num(e[1]) + ' scrobble(s)' }; })
          }
        });
        clash.__albums = ranked
          .filter(function (e) { return e[0] !== canonical.value; })
          .map(function (e) { return [group.artist, group.trackKey, e[0]]; });
        clash.targets = [editTarget(group.artist, title)];
        out.push(clash);
      }
    });

    // (c) album name variants (formatting differences only), one artist at a time
    var cosmetic = [];
    index.albumNames.forEach(function (entry) {
      var spellings = entry.spellings;
      if (spellings.size < 2) return;
      var ranked = Array.from(spellings.entries()).sort(function (x, y) { return y[1] - x[1]; });
      // Only when the difference is capitalisation/accents/spaces/quotes. Quotes
      // are folded here rather than in normaliseText, so a straight apostrophe
      // against a curly one is seen as a spelling of the same album instead of
      // being silently collapsed into a single value at read time.
      var flattened = new Set(ranked.map(function (e) { return stripAccents(foldQuotes(e[0])).toLowerCase(); }));
      if (flattened.size !== 1) return;
      var canonical = ranked[0][0];
      var impact = ranked.reduce(function (acc, e) { return e[0] === canonical ? acc : acc + e[1]; }, 0);
      if (!impact) return;
      var otherForms = ranked
        .filter(function (e) { return e[0] !== canonical; })
        .map(function (e) { return e[0]; });
      var evidence = {
        title: 'Forms found',
        items: ranked.map(function (e) { return { a: e[0], b: num(e[1]) + ' scrobble(s)' }; })
      };
      var sameArtist = signal(
        'Both spellings are scrobbled under the same artist (“' + entry.artist + '”)',
        'strong'
      );
      var affected = otherForms.map(function (form) { return [entry.artist, form]; });
      // Capitalisation alone: the same album name either way, nothing damaged. It gets
      // its own sub-case and does not count as work, the same way a title that differs
      // only in capitalisation is treated. A wrong accent or a missing space, on the
      // other hand, is a tagging mistake and keeps the high score. The two shapes are
      // spelled out separately on purpose: `check-docs` reads this file to make sure
      // every sub-case and action is documented, and it cannot see through a ternary.
      if (new Set(ranked.map(function (e) { return e[0].toLowerCase(); })).size === 1) {
        var cosmeticFinding = newFinding({
          type: 'albums',
          subtype: 'case_only',
          action: 'review_capitalisation',
          title: 'Album written with different capitalisation: “' + entry.artist + ' — ' + canonical + '”',
          points: 44 + Math.min(8, Math.log10(1 + impact) * 6),
          impact: impact,
          current: otherForms.join('  /  '),
          proposed: canonical,
          signals: [signal('The spellings differ only in capitalisation', 'strong'), sameArtist],
          explanation:
            'This album appears under “' + entry.artist + '” with ' + ranked.length + ' spellings that differ ' +
            'only in capitalisation, so one album is written twice in this library. Nothing is damaged and ' +
            'nothing is lost either way: unifying them is tidiness, not a fix, which is why it is not counted ' +
            'as work to do. If you do want them together, “' + canonical + '” is the form with the most ' +
            'scrobbles.',
          evidence: evidence
        });
        cosmeticFinding.__albumsGlobal = affected;
        cosmeticFinding.targets = otherForms.map(function (form) {
          return editTarget(entry.artist, null, form);
        });
        cosmetic.push(cosmeticFinding);
        return;
      }
      var finding = newFinding({
        type: 'albums',
        subtype: 'name_variants',
        action: 'merge_album',
        title: 'Album with ' + ranked.length + ' forms: “' + entry.artist + ' — ' + canonical + '”',
        points: 74 + Math.min(10, Math.log10(1 + impact) * 8),
        impact: impact,
        current: otherForms.join('  /  '),
        proposed: canonical,
        signals: [
          signal('The same album written with different capitalisation, accents, quotes or spacing', 'strong'),
          sameArtist
        ],
        // No claim about how Last.fm's catalogue treats capitalisation: the CSV
        // cannot tell us. What it does show is that this same artist carries the
        // name twice, which is what the card asks to fix.
        explanation:
          'This album appears under “' + entry.artist + '” with ' + ranked.length + ' spellings that differ ' +
          'in capitalisation, accents, quotes or spacing, so one album is written twice in this library. The ' +
          'proposal keeps “' + canonical + '”, the form with the most scrobbles; nothing changes in Last.fm ' +
          'until you edit those scrobbles yourself.',
        evidence: evidence
      });
      finding.__albumsGlobal = affected;
      finding.targets = otherForms.map(function (form) { return editTarget(entry.artist, null, form); });
      cosmetic.push(finding);
    });
    cosmetic.sort(function (a, b) { return b.impact - a.impact; });
    if (stats && cosmetic.length > RULES.maxAlbumNameVariants) {
      stats.albumNameVariantsBeyondCap += cosmetic.length - RULES.maxAlbumNameVariants;
    }
    return out.concat(cosmetic.slice(0, RULES.maxAlbumNameVariants));
  }

  /* --- 6.6 Duplicate scrobbles ---------------------------------------------- */

  function detectDuplicateScrobbles(scrobbles) {
    var out = [];
    for (var i = 0; i < scrobbles.length; i++) {
      var s = scrobbles[i];
      var run = [s];
      var j = i + 1;
      var trackKey = s.__key != null ? s.__key : (s.__key = looseTitleKey(s.title));
      while (
        j < scrobbles.length &&
        scrobbles[j].artist === s.artist &&
        (scrobbles[j].__key != null ? scrobbles[j].__key : (scrobbles[j].__key = looseTitleKey(scrobbles[j].title))) === trackKey &&
        isFinite(scrobbles[j].ts) &&
        isFinite(s.ts) &&
        scrobbles[j].ts - run[run.length - 1].ts <= RULES.duplicateWindowMs
      ) {
        run.push(scrobbles[j]);
        j++;
      }
      if (run.length > 1) {
        var gaps = [];
        for (var k = 1; k < run.length; k++) gaps.push(run[k].ts - run[k - 1].ts);
        var smallestGap = Math.min.apply(null, gaps);
        var points = smallestGap <= RULES.duplicateCertainWindowMs ? 92 : 74;
        var extra = run.length - 1;
        var finding = newFinding({
          type: 'duplicate_scrobbles',
          title: run.length + ' times in a row: “' + s.artist + ' — ' + s.title + '”',
          points: points,
          impact: extra,
          action: 'delete_duplicate',
          current: run.length + ' consecutive scrobbles',
          proposed: 'keep 1',
          signals: [
            signal(
              'Same artist and track ' + run.length + ' times, ' + humanDuration(smallestGap) + ' apart at the closest',
              points >= 90 ? 'strong' : 'medium'
            ),
            signal('Timestamps: ' + run.map(function (x) { return dateTime(x.ts); }).join(' · '), 'info')
          ],
          explanation:
            'Repetitions less than ' + humanDuration(smallestGap) + ' apart. If you do not remember playing it ' +
            'twice in a row, ' + num(extra) + ' scrobble(s) too many. Careful: if you were looping it on ' +
            'purpose, delete nothing.',
          evidence: {
            title: 'Scrobbles',
            items: run.map(function (x, index) {
              return {
                a: dateTime(x.ts),
                b: (x.album || '(no album)') + (index === 0 ? ' ← keep' : '')
              };
            })
          }
        });
        finding.__duplicateIndexes = run.slice(1).map(function (x) { return x.i; });
        finding.targets = [editTarget(s.artist, s.title)];
        out.push(finding);
        // Resume the outer scan after the whole run, so a run of N is reported
        // once instead of once per starting position (N-1 overlapping findings).
        i = j - 1;
      }
    }
    return out;
  }

  /* --- 6.7 Long tail -------------------------------------------------------- */

  function detectLongTail(scrobbles, index) {
    var out = [];

    /* (a) likely typos, measured against frequent artists */
    var frequent = index.list.filter(function (a) {
      return a.n >= RULES.minScrobblesForTypoCompare;
    });
    var byInitial = new Map();
    var byFirstWord = new Map();
    frequent.forEach(function (a) {
      if (!a.key) return;
      var initial = a.key.slice(0, 1);
      var group = byInitial.get(initial);
      if (!group) {
        group = [];
        byInitial.set(initial, group);
      }
      group.push(a);
      var word = a.key.split(' ')[0];
      if (word.length >= 2) {
        var wordGroup = byFirstWord.get(word);
        if (!wordGroup) {
          wordGroup = [];
          byFirstWord.set(word, wordGroup);
        }
        wordGroup.push(a);
      }
    });
    var rare = index.list.filter(function (a) {
      return a.n <= RULES.maxScrobblesForRareArtist;
    });
    rare.forEach(function (r) {
      if (!r.key) return;
      var candidates = new Set(
        (byInitial.get(r.key.slice(0, 1)) || []).concat(byFirstWord.get(r.key.split(' ')[0]) || [])
      );
      var best = null;
      var bestDistance = 99;
      candidates.forEach(function (c) {
        if (c.name === r.name || c.key === r.key) return;
        var max = c.key.length > 10 ? RULES.maxTypoDistance + 1 : RULES.maxTypoDistance;
        var d = editDistance(r.key, c.key, max);
        if (d < bestDistance) {
          bestDistance = d;
          best = c;
        }
      });
      var shared = 0;
      if (best) {
        r.tracks.forEach(function (track, k) {
          if (best.tracks.has(k)) shared++;
        });
      }
      var containment = best && containsWord(best.key, r.key);
      if (!best || (bestDistance > RULES.maxTypoDistance && !containment)) return;
      var garbled = /[^\p{L}\p{N}\s'&.,\-]/u.test(r.name);
      // Same rule as for duplicates: no shared track (and no clearly garbled
      // name) means no proposal.
      if (RULES.requireSharedTrack && shared === 0 && !garbled) return;
      // Name similarity on its own is weak evidence: nearly all the weight comes
      // from shared tracks and from being close in time.
      var points = 25;
      var signals = [];
      if (containment) {
        points += 20;
        signals.push(signal('The name is part of the name of “' + best.name + '”', 'strong'));
      } else if (bestDistance === 1) {
        points += 15;
        signals.push(signal('It differs by 1 character from “' + best.name + '”', 'strong'));
      } else {
        points += 8;
        signals.push(signal('It differs by ' + bestDistance + ' characters from “' + best.name + '”', 'medium'));
      }
      if (shared) {
        points += 20;
        signals.push(signal('Shares ' + num(shared) + ' track(s) with “' + best.name + '”', 'strong'));
      }
      var mixing = countTemporalMix(r.timestamps, best.timestamps);
      if (mixing) {
        points += 15;
        signals.push(
          signal(mixing + ' scrobble(s) fall within 10 min of scrobbles of “' + best.name + '”', 'strong')
        );
      }
      if (r.key.length <= 4 && bestDistance > 0 && !containment) {
        points -= 10;
        signals.push(signal('The name is very short: in four letters, one character apart can be someone else', 'note'));
      }
      if (garbled) {
        points += 20;
        signals.push(
          signal('The name holds garbled or unusual characters (“ĹĄ”, “Ⴟ”…), typical of an encoding problem', 'strong')
        );
      }
      signals.push(signal('“' + r.name + '” only has ' + num(r.n) + ' scrobble(s)', 'note'));
      var finding = newFinding({
        type: 'long_tail',
        subtype: 'possible_typo',
        title: 'Is “' + r.name + '” really “' + best.name + '”?',
        points: points,
        impact: r.n,
        action: 'rename_artist',
        current: r.name,
        proposed: best.name,
        signals: signals,
        explanation:
          '“' + r.name + '” appears only ' + num(r.n) + ' time(s) in your library and its name resembles ' +
          '“' + best.name + '” (' + num(best.n) + ' scrobbles). ' +
          (shared
            ? 'They also share a track, so it is very probably the same artist misspelled.'
            : 'They share no tracks, so it could be a different artist: check it.'),
        evidence: {
          title: 'Comparison',
          items: [
            { a: '“' + r.name + '”', b: num(r.n) + ' scrobble(s), ' + shortDate(r.first) + ' → ' + shortDate(r.last) },
            { a: '“' + best.name + '”', b: num(best.n) + ' scrobble(s), ' + shortDate(best.first) + ' → ' + shortDate(best.last) },
            { a: 'Tracks in common', b: num(shared) }
          ]
        }
      });
      finding.__artists = [r.name];
      finding.targets = [editTarget(r.name)];
      out.push(finding);
    });

    /* (b) messy text and empty fields */
    var issues = {};
    function note(issue, example) {
      if (!issues[issue]) issues[issue] = { n: 0, examples: new Set() };
      issues[issue].n++;
      if (issues[issue].examples.size < 8) issues[issue].examples.add(example);
    }
    var GENERIC =
      /^(unknown artist|unknown|various artists|artista desconocido|va|vv\.?aa\.?|desconocido)$/i;
    var FIELDS = [['artist', 'artist'], ['title', 'title'], ['album', 'album']];
    for (var q = 0; q < scrobbles.length; q++) {
      var s2 = scrobbles[q];
      FIELDS.forEach(function (pair) {
        var fieldName = pair[0];
        var value = s2[pair[1]];
        if (!value) return;
        if (value !== value.trim()) note('leading or trailing spaces in the ' + fieldName, value);
        if (/\s{2,}/.test(value)) note('double spaces in the ' + fieldName, value);
        if (/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/.test(value)) {
          note('unusual (non-breaking) spaces in the ' + fieldName, value.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, '␣'));
        }
        if (/[\u200B-\u200F\uFEFF]/.test(value)) note('invisible characters in the ' + fieldName, value);
        if (/[\uFFFD]/.test(value)) note('unreadable characters in the ' + fieldName, value);
        if (fieldName === 'artist' && GENERIC.test(value)) note('generic artist name', value);
      });
      if (!s2.title) note('scrobbles with no title', '(empty)');
      if (!s2.artist) note('scrobbles with no artist', '(empty)');
      if (!s2.album) note('scrobbles with no album', '(empty)');
    }
    var dirty = Object.keys(issues)
      .map(function (k) {
        return { k: k, n: issues[k].n, examples: Array.from(issues[k].examples) };
      })
      .sort(function (a, b) { return b.n - a.n; });
    var textIssues = dirty.filter(function (x) { return x.k !== 'scrobbles with no album'; });
    var emptyIssues = dirty.filter(function (x) { return x.k === 'scrobbles with no album'; });
    if (textIssues.length) {
      out.push(
        newFinding({
          type: 'long_tail',
          subtype: 'hygiene',
          informational: true,
          title: 'Messy text: ' + num(textIssues.reduce(function (a, x) { return a + x.n; }, 0)) + ' scrobbles with formatting details',
          points: 70,
          impact: textIssues.reduce(function (a, x) { return a + x.n; }, 0),
          action: 'review',
          current: 'various tags',
          proposed: '(normalise)',
          signals: textIssues.slice(0, 6).map(function (x) {
            return signal(num(x.n) + ' × ' + x.k, 'medium');
          }),
          explanation:
            'Formatting details inside tags: stray spaces, invisible or garbled characters, generic artist ' +
            'names or empty fields. Last.fm treats these as separate entities. Tedious but safe to fix, ' +
            'because the correct value is obvious.',
          table: {
            headers: ['Problem', 'Scrobbles', 'Examples'],
            rows: textIssues.map(function (x) {
              return [x.k, num(x.n), x.examples.join(' · ')];
            })
          }
        })
      );
    }
    if (emptyIssues.length) {
      var emptyCount = emptyIssues.reduce(function (a, x) { return a + x.n; }, 0);
      var fillable = out.filter(function (f) {
        return f.type === 'albums' && f.subtype === 'missing';
      }).length;
      out.push(
        newFinding({
          type: 'long_tail',
          subtype: 'empty',
          informational: true,
          title: num(emptyCount) + ' scrobbles with no album',
          points: 45,
          impact: 0,
          action: 'review',
          current: num(emptyCount) + ' scrobbles with no album',
          proposed: '(only if you know which one)',
          signals: [
            signal(num(emptyCount) + ' scrobbles carry no album in the CSV', 'medium'),
            signal('This is information, not a mistake: plenty of albums are legitimately blank (singles, radio rips, mixes)', 'info')
          ],
          explanation:
            'An empty album is not a mistake by itself: Last.fm leaves it blank when the scrobble carries no ' +
            'album. Filling it in only makes sense if you know which release each track came from. ' +
            (fillable
              ? 'The ' + num(fillable) + ' cases where there is a clear answer are in “Albums → No album”, ' +
                'with the track and the album that already appears on other scrobbles of the same title.'
              : 'There is no case here with a clear answer: no empty track has an album on its other scrobbles.'),
          table: {
            headers: ['Artist', 'Track', 'Scrobbles with no album'],
            rows: emptyAlbumTable(scrobbles),
            note: 'Only the top 40 artists by volume. The actionable cases are in the albums section.'
          }
        })
      );
    }

    function emptyAlbumTable(list) {
      var counts = new Map();
      list.forEach(function (s) {
        if (s.album) return;
        var k = s.artist + '\u0000' + (s.title || '(no title)');
        var group = counts.get(k);
        if (!group) {
          group = { artist: s.artist, title: s.title, n: 0 };
          counts.set(k, group);
        }
        group.n++;
      });
      return Array.from(counts.values())
        .sort(function (a, b) { return b.n - a.n; })
        .slice(0, 40)
        .map(function (group) { return [group.artist, group.title, num(group.n)]; });
    }

    /* (c) a list of very rare artists, for manual review */
    if (rare.length) {
      out.push(
        newFinding({
          type: 'long_tail',
          subtype: 'rare_artists',
          informational: true,
          title: num(rare.length) + ' artists with ' + RULES.maxScrobblesForRareArtist + ' scrobble(s) or fewer',
          points: 0,
          impact: 0,
          action: 'review',
          current: num(rare.length) + ' artists',
          proposed: '(review by hand)',
          signals: [signal('Informational list: this is where misspellings usually hide', 'info')],
          explanation:
            'Artists you have played ' + RULES.maxScrobblesForRareArtist + ' times or fewer. They are not ' +
            'mistakes in themselves, but this is the list where the junk tends to sit (typos, odd tags, ' +
            'imports). Any with a “is this really…?” finding above have already been analysed.',
          table: {
            headers: ['Artist', 'Scrobbles', 'First', 'Last'],
            rows: rare.slice(0, RULES.maxTableRows).map(function (a) {
              return [a.name, num(a.n), shortDate(a.first), shortDate(a.last)];
            }),
            note:
              rare.length > RULES.maxTableRows
                ? 'Showing ' + RULES.maxTableRows + ' of ' + num(rare.length) + '.'
                : ''
          }
        })
      );
    }
    return out;
  }

  /* ==========================================================================
   * 7. Full analysis
   * ========================================================================== */

  function analyse(scrobbles, options) {
    options = options || {};
    var originals = Object.assign({}, RULES);
    var overrides = Object.assign({}, RULES, options.rules || {});
    Object.keys(overrides).forEach(function (k) {
      RULES[k] = overrides[k];
    });
    var started = Date.now();
    try {
      return analyseWith(scrobbles, options, started);
    } finally {
      // Restore the shared RULES exactly: values back, and any key an override
      // introduced removed, so it cannot leak into the next analyse() call.
      Object.keys(originals).forEach(function (k) {
        RULES[k] = originals[k];
      });
      Object.keys(RULES).forEach(function (k) {
        if (!(k in originals)) delete RULES[k];
      });
    }
  }

  function analyseWith(scrobbles, options, started) {
    var index = buildIndex(scrobbles);
    var findings = [];
    // Everything the detectors decide not to report is counted here, so that the
    // summary can say what was left out instead of dropping it in silence.
    var stats = {
      artistPairsWithoutSharedTrack: 0,
      albumClashesBelowThreshold: 0,
      albumNameVariantsBeyondCap: 0
    };

    var combinedFindings = detectCombinedArtists(index);
    // A name already covered by a combined-name finding must not produce a second
    // card proposing the same rename (“Ana Bruno” next to “Ana, Bruno → Ana”).
    var absorbed = new Map();
    var coveredByStronger = 0;
    combinedFindings.forEach(function (f) {
      (f.__artists || []).forEach(function (name) {
        absorbed.set(name, f.proposed);
      });
    });
    var mergeFindings = buildMergeFindings(detectMergePairs(index, stats), index).filter(function (f) {
      if (!f.__artists || !f.__artists.length) return true;
      var covered = f.__artists.every(function (name) {
        return absorbed.get(name) === f.proposed;
      });
      if (covered) coveredByStronger++;
      return !covered;
    });

    // A similar-name pair that a combined-name finding already resolves the same
    // way must not appear twice, exactly like the other duplicate findings.
    var similarFindings = detectSimilarArtistNames(index).filter(function (f) {
      if (!f.__artists || !f.__artists.length) return true;
      var covered = f.__artists.every(function (name) {
        return absorbed.get(name) === f.proposed;
      });
      if (covered) coveredByStronger++;
      return !covered;
    });

    findings = findings.concat(mergeFindings);
    findings = findings.concat(similarFindings);
    findings = findings.concat(combinedFindings);
    findings = findings.concat(detectTitleVariants(scrobbles));
    findings = findings.concat(detectPlatformBadges(index));
    findings = findings.concat(detectTitleTypos(index));
    findings = findings.concat(detectArtistInTitle(scrobbles));
    findings = findings.concat(detectAlbumIssues(scrobbles, index, stats));
    findings = findings.concat(detectDuplicateScrobbles(scrobbles));
    findings = findings.concat(detectLongTail(scrobbles, index));

    // Final confidence filter: the very weak ones are not listed, but counted.
    var minimumPoints =
      RULES.minimumConfidence === 'high' ? RULES.highThreshold : RULES.minimumConfidence === 'low' ? 0 : RULES.mediumThreshold;
    var omitted = findings.filter(function (f) {
      return !f.informational && f.points < minimumPoints;
    }).length;
    findings = findings.filter(function (f) {
      return f.informational || f.points >= minimumPoints;
    });

    // Order: type (per TYPE_ORDER), then impact, then points
    findings.sort(function (a, b) {
      var ta = TYPE_ORDER.indexOf(a.type);
      var tb = TYPE_ORDER.indexOf(b.type);
      if (ta !== tb) return ta - tb;
      var ca = a.confidence === 'high' ? 0 : a.confidence === 'medium' ? 1 : 2;
      var cb = b.confidence === 'high' ? 0 : b.confidence === 'medium' ? 1 : 2;
      if (ca !== cb) return ca - cb;
      return b.impact - a.impact || b.points - a.points;
    });

    // Ids have to be unique: two different findings may share type/current/proposed
    // and must not overwrite each other's decision in the interface.
    findings.forEach(function (f, ix) {
      f.id = f.id + '#' + ix;
    });

    // True union of affected scrobbles: each scrobble touched by any finding is
    // marked once, so nothing is counted twice.
    var artistSet = new Set();
    var variantSet = new Set();
    var emptyAlbumSet = new Set();
    var albumSet = new Set();
    var albumGlobalSet = new Set();
    var duplicateSet = new Set();
    findings.forEach(function (f) {
      if (f.__artists) f.__artists.forEach(function (a) { artistSet.add(a); });
      if (f.__variants) {
        f.__variants.forEach(function (pair) {
          variantSet.add(pair[0] + '\u0000' + pair[1]);
        });
      }
      if (f.__emptyAlbums) f.__emptyAlbums.forEach(function (pair) { emptyAlbumSet.add(pair[0] + '\u0000' + pair[1]); });
      if (f.__albums) f.__albums.forEach(function (t) { albumSet.add(t.join('\u0000')); });
      if (f.__albumsGlobal) {
        f.__albumsGlobal.forEach(function (a) { albumGlobalSet.add(a[0] + '\u0000' + key(a[1])); });
      }
      if (f.__duplicateIndexes) f.__duplicateIndexes.forEach(function (i) { duplicateSet.add(i); });
    });

    var withDate = 0;
    var from = Infinity;
    var to = -Infinity;
    var trackSet = new Set();
    var albumNameSet = new Set();
    var affectedScrobbles = 0;
    for (var j = 0; j < scrobbles.length; j++) {
      var s = scrobbles[j];
      if (!isNaN(s.ts)) {
        withDate++;
        if (s.ts < from) from = s.ts;
        if (s.ts > to) to = s.ts;
      }
      var loose = s.__key != null ? s.__key : (s.__key = looseTitleKey(s.title));
      trackSet.add(s.artist + '\u0000' + loose);
      if (s.album) albumNameSet.add(key(s.album));
      var affected =
        (s.artist && artistSet.has(s.artist)) ||
        variantSet.has(s.artist + '\u0000' + s.title) ||
        (s.album === '' && emptyAlbumSet.has(s.artist + '\u0000' + loose)) ||
        (s.album !== '' && albumSet.has(s.artist + '\u0000' + loose + '\u0000' + s.album)) ||
        (s.album !== '' && albumGlobalSet.has(s.artist + '\u0000' + key(s.album))) ||
        duplicateSet.has(s.i);
      if (affected) affectedScrobbles++;
    }

    var byType = {};
    findings.forEach(function (f) {
      var bucket = byType[f.type] || (byType[f.type] = {
        type: f.type,
        label: TYPE_LABELS[f.type],
        findings: 0,
        impact: 0,
        high: 0,
        medium: 0,
        low: 0,
        actionable: 0
      });
      bucket.findings++;
      bucket.impact += f.impact;
      if (f.actionable) bucket.actionable++;
      bucket[f.confidence === 'high' ? 'high' : f.confidence === 'medium' ? 'medium' : 'low']++;
    });
    var typesSummary = TYPE_ORDER.filter(function (t) {
      return byType[t];
    }).map(function (t) {
      return byType[t];
    });

    // Internal filtering fields are never exported.
    findings.forEach(function (f) {
      delete f.__artists;
      delete f.__variants;
      delete f.__emptyAlbums;
      delete f.__albums;
      delete f.__albumsGlobal;
      delete f.__duplicateIndexes;
    });

    return {
      version: VERSION,
      meta: {
        source: (scrobbles[0] && scrobbles[0].source) || options.source || '(unnamed)',
        analysedAt: Date.now(),
        scrobbles: scrobbles.length,
        withDate: withDate,
        artists: index.list.length,
        tracks: trackSet.size,
        albums: albumNameSet.size,
        from: isFinite(from) ? from : null,
        to: isFinite(to) ? to : null,
        milliseconds: Date.now() - started,
        rules: Object.assign({}, RULES),
        warnings: options.warnings || []
      },
      summary: {
        byType: typesSummary,
        findings: findings.length,
        affectedScrobbles: affectedScrobbles,
        actions: findings.filter(function (f) {
          return f.actionable;
        }).length,
        highConfidenceActions: findings.filter(function (f) {
          return f.actionable && f.confidence === 'high';
        }).length,
        omitted: omitted,
        coveredByStronger: coveredByStronger,
        // Checks the detectors made and did not list, with a reason each.
        trimmed: {
          artistPairsWithoutSharedTrack: stats.artistPairsWithoutSharedTrack,
          albumClashesBelowThreshold: stats.albumClashesBelowThreshold,
          albumNameVariantsBeyondCap: stats.albumNameVariantsBeyondCap
        },
        minimumConfidence: RULES.minimumConfidence
      },
      findings: findings
    };
  }

  /* ==========================================================================
   * 8. Exporters
   * ========================================================================== */

  function toJSON(report) {
    return JSON.stringify(report, null, 2);
  }

  function csvField(v) {
    var s = v == null ? '' : String(v);
    if (/[";\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  /**
   * The proposal actually in force for a finding: its default one, or the
   * alternative the interface recorded for it. Exports go through this, so a
   * chosen alternative (the dash form instead of the bracket one, say) reaches
   * actions.csv and the to-do list instead of the default.
   */
  function activeProposal(finding, choice) {
    if (choice && choice !== finding.proposed && finding.alternatives) {
      for (var i = 0; i < finding.alternatives.length; i++) {
        var alt = finding.alternatives[i];
        if (alt.value === choice && alt.proposed != null) return alt;
      }
    }
    return finding;
  }

  /**
   * The finding as it reads once a choice is taken into account: the default
   * proposal, or the chosen alternative, with `howTo` regenerated from it so the
   * instructions never describe a swap the export is not asking for. The interface
   * and every export go through this, so they cannot disagree.
   */
  function proposalOf(finding, choice) {
    var active = activeProposal(finding, choice);
    var view = {
      current: active.current,
      proposed: active.proposed,
      impact: active.impact != null ? active.impact : finding.impact,
      title: active.title || finding.title,
      // Which scrobbles to open in Last.fm: the default targets, or the ones the
      // chosen alternative carries (see swapOption). A chosen option without its
      // own targets — the combined-artist parts, whose "from" side never changes —
      // falls back to the finding's.
      targets: (active.targets && active.targets.length ? active.targets : finding.targets) || []
    };
    var action = ACTIONS[finding.action];
    view.howTo = action
      ? action.how(Object.assign({}, finding, {
          current: view.current, proposed: view.proposed, impact: view.impact
        }))
      : finding.howTo;
    return view;
  }

  /**
   * Markdown links for a finding's targets, or [] when no username was given to
   * point at. Used by the to-do list and the Markdown report, so the pages you
   * edit in Last.fm are one click away.
   */
  function targetLinks(username, targets) {
    if (!username || !targets || !targets.length) return [];
    return targets
      .map(function (t) {
        var url = lastfmUrl(username, t);
        return url ? '[' + targetLabel(t) + '](' + url + ')' : null;
      })
      .filter(Boolean);
  }

  /**
   * Action list, one row per finding, with an empty `decision` column so you can
   * mark accept/reject while you work through it.
   */
  function toCSV(report, options) {
    options = options || {};
    var decisions = options.decisions || {};
    var choices = options.choices || {};
    var header = [
      'type', 'subtype', 'confidence', 'points', 'action', 'actionable', 'impact_scrobbles',
      'current_value', 'proposed_value', 'alternatives', 'signals', 'decision', 'evidence'
    ];
    var rows = [header.join(';')];
    report.findings.forEach(function (f) {
      var decision = decisions[f.id] || 'pending';
      // Discarded findings are dropped from the export by the interface, which is
      // the only place that knows about them; the CLI keeps every row.
      if (options.omitDiscarded && decision === 'discard') return;
      var view = proposalOf(f, choices[f.id]);
      var evidence = '';
      if (f.evidence && f.evidence.items) {
        evidence = f.evidence.items
          .map(function (item) {
            return item.a + ' → ' + item.b;
          })
          .join(' | ');
      } else if (f.table) {
        evidence = f.table.rows.length + ' row(s): see the report';
      }
      rows.push(
        [
          f.type, f.subtype, f.confidence, f.points, f.action, f.actionable ? 'yes' : 'no', view.impact,
          view.current, view.proposed,
          f.alternatives.map(function (a) { return a.value + ' (' + a.reason + ')'; }).join(' | '),
          f.signals.map(function (s) { return s.text; }).join(' | '),
          decision, evidence
        ].map(csvField).join(';')
      );
    });
    return rows.join('\n');
  }

  /**
   * The accepted findings as a plain checklist to tick off while editing Last.fm.
   * This is what the Accept button is for: the report is for reading, this is the
   * working document.
   */
  function toWorklist(report, decisions, choices, options) {
    decisions = decisions || {};
    choices = choices || {};
    options = options || {};
    var username = options.username || '';
    var accepted = report.findings.filter(function (f) {
      return decisions[f.id] === 'accept';
    });
    var lines = [];
    lines.push('# Last.fm Lens — to-do list');
    lines.push('');
    lines.push('**Source:** ' + report.meta.source + '  ');
    lines.push(
      '**Accepted:** ' + num(accepted.length) + ' of ' + num(report.summary.findings) +
        ' findings · **scrobbles to touch:** ' +
        num(accepted.reduce(function (acc, f) { return acc + proposalOf(f, choices[f.id]).impact; }, 0))
    );
    lines.push('');
    if (!accepted.length) {
      lines.push(
        'Nothing accepted yet. In the report, press **Accept** on the findings you want to work on and ' +
          'download this list again.'
      );
      return lines.join('\n');
    }
    lines.push(
      'Work through these in Last.fm. Artist, track and album edits are **retroactive**: Last.fm offers to ' +
        'apply the change to every scrobble of that combination, so look twice before confirming. Deleting a ' +
        'duplicate scrobble is one at a time, from the scrobble’s (⋯) menu.'
    );
    lines.push('');
    var byType = {};
    accepted.forEach(function (f) {
      (byType[f.type] = byType[f.type] || []).push(f);
    });
    TYPE_ORDER.forEach(function (type) {
      var list = byType[type];
      if (!list || !list.length) return;
      lines.push('## ' + TYPE_LABELS[type]);
      lines.push('');
      list.sort(function (a, b) {
        return b.impact - a.impact || b.points - a.points;
      });
      list.forEach(function (f) {
        var view = proposalOf(f, choices[f.id]);
        lines.push('- [ ] ' + view.title);
        lines.push(
          '  - **' + f.actionLabel + '**' +
            (view.current ? ' — `' + view.current + '` → `' + view.proposed + '`' : '') +
            ' · ' + num(view.impact) + ' scrobble(s) · ' + f.confidence + ' ' + f.points + '/100'
        );
        if (view.howTo) lines.push('  - ' + view.howTo);
        var links = targetLinks(username, view.targets);
        if (links.length) lines.push('  - Open in Last.fm: ' + links.join(' · '));
      });
      lines.push('');
    });
    return lines.join('\n');
  }

  function toMarkdown(report, options) {
    options = options || {};
    var username = options.username || '';
    var m = report.meta;
    var lines = [];
    lines.push('# Last.fm Lens — scrobble cleanup report');
    lines.push('');
    lines.push('**Source:** ' + m.source + '  ');
    lines.push('**Analysed:** ' + dateTime(m.analysedAt) + '  ');
    lines.push('**Period:** ' + shortDate(m.from) + ' → ' + shortDate(m.to) + '  ');
    lines.push(
      '**Volume:** ' + num(m.scrobbles) + ' scrobbles · ' + num(m.artists) + ' artists · ' + num(m.tracks) +
        ' tracks · ' + num(m.albums) + ' albums'
    );
    lines.push('');
    lines.push('> This report edits nothing. Every finding is a **scored suspicion**, with the clues behind it and the concrete evidence. You decide.');
    lines.push('');
    lines.push('## Summary');
    lines.push('');
    lines.push('| Type | Findings | High | Medium | Low | Affected scrobbles |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: |');
    report.summary.byType.forEach(function (t) {
      lines.push(
        '| ' + t.label + ' | ' + num(t.findings) + ' | ' + num(t.high) + ' | ' + num(t.medium) + ' | ' +
          num(t.low) + ' | ' + num(t.impact) + ' |'
      );
    });
    lines.push('');
    lines.push(
      'Total: **' + num(report.summary.findings) + ' findings**, of which **' + num(report.summary.actions) +
        ' carry an action** and **' + num(report.summary.affectedScrobbles) + ' scrobbles are affected** (' +
        Math.round((100 * report.summary.affectedScrobbles) / (m.scrobbles || 1)) + '%).'
    );
    lines.push('');
    lines.push('**Rules applied** (they live in `RULES`, inside `src/engine.js`):');
    lines.push('');
    lines.push(
      '- An artist duplicate is only proposed if the two names **share at least one track**, or if the names ' +
        'are identical bar capitalisation/accents/punctuation. Looking similar never qualifies on its own.'
    );
    lines.push(
      '- A combined artist (“A, B”) is only flagged if the first artist of the name exists separately in this library.'
    );
    lines.push(
      '- An album clash is only listed from ' + num(report.meta.rules.minAlbumImpact) + ' affected scrobbles upwards.'
    );
    if (report.summary.omitted) {
      lines.push(
        '- **' + num(report.summary.omitted) + ' findings were omitted** for being low confidence (possible typos ' +
          'with no track in common, name similarities with no evidence). To see them, set ' +
          '`minimumConfidence: \'low\'` in `RULES`.'
      );
    }
    if (report.summary.coveredByStronger) {
      lines.push(
        '- **' + num(report.summary.coveredByStronger) + ' duplicate-name finding(s) are not listed separately**: a ' +
          'combined-name finding already proposes the same rename (for instance “Ana Bruno” next to ' +
          '“Ana, Bruno → Ana”).'
      );
    }
    var trimmed = report.summary.trimmed || {};
    var trimmedTotal =
      (trimmed.artistPairsWithoutSharedTrack || 0) +
      (trimmed.albumClashesBelowThreshold || 0) +
      (trimmed.albumNameVariantsBeyondCap || 0);
    if (trimmedTotal) {
      lines.push('- **' + num(trimmedTotal) + ' check(s) were deliberately not listed**, and are counted here so ' +
        'nothing disappears quietly:');
      if (trimmed.artistPairsWithoutSharedTrack) {
        lines.push(
          '  - ' + num(trimmed.artistPairsWithoutSharedTrack) + ' artist-name pair(s) that share no track ' +
            '(looking similar is not evidence).'
        );
      }
      if (trimmed.albumClashesBelowThreshold) {
        lines.push(
          '  - ' + num(trimmed.albumClashesBelowThreshold) + ' album clash(es) below ' +
            num(report.meta.rules.minAlbumImpact) + ' affected scrobbles.'
        );
      }
      if (trimmed.albumNameVariantsBeyondCap) {
        lines.push(
          '  - ' + num(trimmed.albumNameVariantsBeyondCap) + ' album-name variant(s) past the ' +
            num(report.meta.rules.maxAlbumNameVariants) + ' listed (raise `RULES.maxAlbumNameVariants` to see them).'
        );
      }
    }
    lines.push('');
    lines.push(
      'This report is produced by **code alone** (normalised key comparison and sets of tracks), with no ' +
        'language models and no external services: the same CSV always produces exactly the same report.'
    );
    lines.push('');

    var byType = {};
    report.findings.forEach(function (f) {
      (byType[f.type] = byType[f.type] || []).push(f);
    });
    var sectionNumber = 0;
    TYPE_ORDER.forEach(function (type) {
      var findings = byType[type];
      if (!findings || !findings.length) return;
      sectionNumber++;
      var impact = findings.reduce(function (a, f) { return a + f.impact; }, 0);
      lines.push(
        '## ' + sectionNumber + '. ' + TYPE_LABELS[type] + ' — ' + num(findings.length) + ' finding(s), ' +
          num(impact) + ' scrobbles'
      );
      lines.push('');
      findings.forEach(function (f, ix) {
        lines.push('### ' + sectionNumber + '.' + (ix + 1) + ' ' + f.title);
        lines.push('');
        lines.push('- **Confidence:** ' + f.confidence.toUpperCase() + ' (' + f.points + '/100)');
        lines.push('- **Impact:** ' + num(f.impact) + ' scrobble(s)');
        lines.push(
          '- **Action:** ' + f.actionLabel +
            (f.actionable ? '' : ' (advisory: it may well be correct, ignore it)') +
            (f.current ? ' — `' + f.current + '` → `' + f.proposed + '`' : '')
        );
        if (subtypeLabel(f.type, f.subtype)) {
          lines.push('- **Kind:** ' + subtypeLabel(f.type, f.subtype));
        }
        if (f.signals.length) {
          lines.push('- **Signals:**');
          f.signals.forEach(function (s) {
            lines.push('  - [' + s.level + '] ' + s.text);
          });
        }
        if (f.explanation) {
          lines.push('');
          lines.push(f.explanation);
        }
        if (f.warning) {
          lines.push('');
          lines.push('⚠️ ' + f.warning);
        }
        if (f.variants && f.variants.length) {
          lines.push('');
          lines.push('| Form | Scrobbles | First | Last |');
          lines.push('| --- | ---: | --- | --- |');
          f.variants.forEach(function (v) {
            lines.push(
              '| ' + v.value + (v.canonical ? ' **← proposed**' : '') + ' | ' + num(v.n) + ' | ' +
                shortDate(v.first) + ' | ' + shortDate(v.last) + ' |'
            );
          });
        }
        if (f.evidence && f.evidence.items && f.evidence.items.length) {
          lines.push('');
          lines.push('**' + f.evidence.title + '**');
          lines.push('');
          f.evidence.items.slice(0, RULES.maxEvidence).forEach(function (item) {
            lines.push('- ' + item.a + ' — ' + item.b);
          });
          if (f.evidence.items.length > RULES.maxEvidence) {
            lines.push('- … and ' + num(f.evidence.items.length - RULES.maxEvidence) + ' more');
          }
        }
        if (f.table) {
          lines.push('');
          lines.push('| ' + f.table.headers.join(' | ') + ' |');
          lines.push('|' + f.table.headers.map(function () { return ' --- '; }).join('|') + '|');
          f.table.rows.slice(0, 60).forEach(function (row) {
            lines.push('| ' + row.map(function (c) { return String(c == null ? '' : c).replace(/\|/g, '\\|'); }).join(' | ') + ' |');
          });
          if (f.table.rows.length > 60) {
            lines.push('| … | | | |');
            lines.push('');
            lines.push('_(' + num(f.table.rows.length) + ' rows in total; the rest are in the HTML report)_');
          }
          if (f.table.note) {
            lines.push('');
            lines.push('_' + f.table.note + '_');
          }
        }
        if (f.alternatives && f.alternatives.length) {
          lines.push('');
          lines.push(
            '**Alternatives:** ' +
              f.alternatives.map(function (a) { return a.value + ' (' + a.reason + ')'; }).join(' · ')
          );
        }
        if (f.howTo) {
          lines.push('');
          lines.push('**How to do it in Last.fm:** ' + f.howTo);
        }
        var links = targetLinks(username, f.targets);
        if (links.length) {
          lines.push('');
          lines.push('**Open in Last.fm:** ' + links.join(' · '));
        }
        lines.push('');
      });
    });
    if (m.warnings && m.warnings.length) {
      lines.push('## Reading warnings');
      lines.push('');
      m.warnings.forEach(function (w) {
        lines.push('- ' + w);
      });
      lines.push('');
    }
    lines.push('---');
    lines.push('');
    lines.push('_Produced by Last.fm Lens ' + VERSION + ' (src/engine.js). Rules used: `' + JSON.stringify(m.rules) + '`_');
    return lines.join('\n');
  }

  return {
    VERSION: VERSION,
    RULES: RULES,
    TYPE_LABELS: TYPE_LABELS,
    TYPE_ORDER: TYPE_ORDER,
    SUBTYPE_LABELS: SUBTYPE_LABELS,
    ACTIONS: ACTIONS,
    subtypeLabel: subtypeLabel,
    proposalOf: proposalOf,
    parseCSV: parseCSV,
    readCSV: readCSV,
    analyse: analyse,
    toMarkdown: toMarkdown,
    toWorklist: toWorklist,
    toCSV: toCSV,
    toJSON: toJSON,
    util: {
      lastfmUrl: lastfmUrl,
      targetLabel: targetLabel,
      key: key,
      artistKey: artistKey,
      looseTitleKey: looseTitleKey,
      strictTitleKey: strictTitleKey,
      normaliseText: normaliseText,
      shortDate: shortDate,
      dateTime: dateTime,
      num: num,
      humanDuration: humanDuration,
      confidence: confidence
    }
  };
});
