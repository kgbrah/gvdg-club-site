// "Add to UDisc" — Option B for getting a GVDG live-scored round into a personal UDisc history.
//
// UDisc has NO public/partner API and no round import (verified). The only safe, ToS-clean path is to
// deep-link the player into a NEW scorecard for the exact course and show their hole-by-hole scores to
// tap in. This is assisted manual entry, NOT auto-sync — the UI says so plainly.
//
// Shared across pages with separate stylesheets, so it attaches a global and injects its own styles.
(function (global) {
  'use strict';
  var doc = global.document;

  // Reverse-engineered, undocumented applink — isolated here so a UDisc change is a one-line patch.
  // Needs UDisc's internal NUMERIC course id (not the udisc.com slug). Returns null if absent/non-numeric.
  function deepLink(courseId) {
    var id = courseId == null ? '' : String(courseId).trim();
    return /^\d{1,20}$/.test(id) ? 'https://app.udisc.com/applink/create-scorecard/' + id : null;
  }

  function parseCard(scorecard) {
    var arr = Array.isArray(scorecard) ? scorecard : null;
    if (!arr && typeof scorecard === 'string' && scorecard) {
      try { arr = JSON.parse(scorecard); } catch (e) { arr = null; }
    }
    if (!Array.isArray(arr)) return [];
    return arr.filter(function (h) { return h && typeof h.strokes === 'number' && typeof h.hole === 'number'; });
  }

  function fmtToPar(n) { return n === 0 ? 'E' : (n > 0 ? '+' + n : String(n)); }

  function ensureStyles() {
    if (!doc || doc.getElementById('udisc-export-styles')) return;
    var s = doc.createElement('style');
    s.id = 'udisc-export-styles';
    s.textContent = [
      '.udisc-export{margin:.4rem 0;border:1px solid var(--border-color,#ccc);border-radius:.5rem;padding:.4rem .6rem;background:var(--bg-tertiary,#f4f4f9);}',
      '.udisc-export>summary{cursor:pointer;font-weight:600;color:var(--primary,#FF6B35);list-style:none;}',
      '.udisc-export>summary::-webkit-details-marker{display:none;}',
      '.udisc-export-note{font-size:.8rem;color:var(--text-muted,#666);margin:.5rem 0;}',
      '.udisc-export-strip{display:flex;flex-wrap:wrap;gap:.3rem;margin:.4rem 0;}',
      '.udisc-hole{display:inline-flex;flex-direction:column;align-items:center;min-width:2.1rem;padding:.2rem .25rem;border-radius:.35rem;background:var(--bg-secondary,#fff);border:1px solid var(--border-color,#ddd);font-size:.8rem;line-height:1.2;}',
      '.udisc-hole b{font-size:.62rem;color:var(--text-muted,#888);font-weight:600;}',
      '.udisc-hole span{font-size:1rem;font-weight:700;color:var(--text-primary,#1a1a2e);}',
      '.udisc-export-total{font-size:.8rem;color:var(--text-secondary,#444);margin:.3rem 0 .5rem;}',
      '.udisc-export-btn{display:inline-block;padding:.45rem .9rem;border-radius:.5rem;background:var(--primary,#FF6B35);color:#fff;font-weight:700;text-decoration:none;}',
      '.udisc-export-section{margin-top:1rem;}'
    ].join('');
    (doc.head || doc.documentElement).appendChild(s);
  }

  // Build a <details> "Add to UDisc" disclosure for ONE player's round. Returns null when there's
  // nothing actionable (no numeric course id, or no per-hole scores were stored).
  function build(opts) {
    opts = opts || {};
    if (!doc) return null;
    var link = deepLink(opts.courseId);
    var card = parseCard(opts.scorecard);
    if (!link || !card.length) return null;
    ensureStyles();

    var d = doc.createElement('details');
    d.className = 'udisc-export';

    var sum = doc.createElement('summary');
    sum.textContent = opts.label ? ('⛳ ' + opts.label) : '⛳ Add to UDisc';
    d.appendChild(sum);

    var note = doc.createElement('p');
    note.className = 'udisc-export-note';
    note.textContent = 'UDisc has no round import. Tap “Open in UDisc” to start a scorecard on this course, then enter these scores:';
    d.appendChild(note);

    var strip = doc.createElement('div');
    strip.className = 'udisc-export-strip';
    var total = 0, toPar = 0;
    card.forEach(function (h) {
      total += h.strokes;
      toPar += h.strokes - (typeof h.par === 'number' ? h.par : 0);
      var cell = doc.createElement('span');
      cell.className = 'udisc-hole';
      cell.title = 'Hole ' + h.hole + (typeof h.par === 'number' ? ' · par ' + h.par : '');
      var hn = doc.createElement('b'); hn.textContent = 'H' + h.hole;
      var sc = doc.createElement('span'); sc.textContent = String(h.strokes);
      cell.appendChild(hn); cell.appendChild(sc);
      strip.appendChild(cell);
    });
    d.appendChild(strip);

    var tot = doc.createElement('p');
    tot.className = 'udisc-export-total';
    tot.textContent = 'Total ' + total + ' (' + fmtToPar(toPar) + ') · ' + card.length + ' holes';
    d.appendChild(tot);

    var a = doc.createElement('a');
    a.className = 'udisc-export-btn';
    a.href = link;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = 'Open in UDisc ↗';
    d.appendChild(a);

    return d;
  }

  global.UDiscExport = { deepLink: deepLink, build: build };
})(typeof window !== 'undefined' ? window : this);
