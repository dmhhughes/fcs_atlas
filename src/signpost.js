/**
 * The signpost: a permanent side panel beside the map. It shows an "at a
 * glance" summary until a territory is chosen, then that territory's details.
 *
 * DOM rather than canvas, so it carries a real link, selectable text, and is
 * announced to screen readers.
 */

export class Signpost {
  constructor(root, associations, { onClose } = {}) {
    this.root = root;
    this.byUninum = new Map(associations.map((a) => [a.uninum, a]));
    this.currentUninum = null;

    this.root.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) onClose?.();
    });
  }

  /**
   * @param {object} a  association
   * @param {object} extra
   * @param {string} extra.gridRef   atlas square, e.g. "F7"
   * @param {string} extra.color     district colour
   * @param {object} extra.bank      the funding bank, if known
   */
  show(a, { gridRef = '', color = '#b9a8d6', bank = null } = {}) {
    if (!a) return;
    this.currentUninum = a.uninum;

    const states = a.states ?? [];
    const territory =
      a.countyCount === 1
        ? '1 county'
        : `${a.countyCount} counties` + (states.length ? ` in ${listify(states)}` : '');
    const shared = (a.sharedWith ?? []).map((u) => this.byUninum.get(u)?.name).filter(Boolean);
    const hq = [a.hq.city, a.hq.state].filter(Boolean).join(', ');

    this.root.innerHTML = `
      <article class="sign frame" style="--district:${esc(color)}">
        <button class="sign-close" type="button" data-close aria-label="Close">&times;</button>
        <p class="sign-eyebrow">
          <span class="sign-chip" aria-hidden="true"></span>
          <span>${esc(a.district)} District</span>
          ${gridRef ? `<span class="sign-ref" title="Atlas grid square">${esc(gridRef)}</span>` : ''}
        </p>
        <h2 class="sign-name">${esc(a.name)}</h2>
        <dl class="sign-facts">
          <dt>Headquarters</dt>
          <dd>${esc(hq)}${a.hq.county ? ` <span class="muted">&middot; ${esc(a.hq.county)} Co.</span>` : ''}</dd>
          <dt>Territory</dt>
          <dd>${esc(territory)}</dd>
          ${a.commodity ? `<dt>Main commodity</dt><dd>${esc(a.commodity)}</dd>` : ''}
          ${a.ceo ? `<dt>Chief executive</dt><dd>${esc(a.ceo)}</dd>` : ''}
          ${bank ? `<dt>Funding bank</dt><dd>${esc(bank.name)}</dd>` : ''}
        </dl>
        ${shared.length ? `<p class="sign-shared">Also chartered here: ${esc(listify(shared))}.</p>` : ''}
        ${a.url ? `<a class="sign-link" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">Visit ${esc(shortHost(a.url))} &rarr;</a>` : ''}
      </article>`;
  }

  /**
   * The default card, shown before any territory is chosen (and again after
   * one is closed).
   * @param {object} n
   * @param {number} n.associations
   * @param {number} n.banks
   * @param {number} n.counties
   * @param {number} n.states
   */
  showDefault({ associations, banks, counties, states } = {}) {
    this.currentUninum = null;
    const fmt = (v) => (Number.isFinite(v) ? v.toLocaleString('en-US') : '—');

    this.root.innerHTML = `
      <article class="sign frame" style="--district:var(--contour)">
        <p class="sign-eyebrow"><span>At a Glance</span></p>
        <h2 class="sign-name">Farm Credit System</h2>
        <p class="sign-copy">Hover or click a territory on the map to see who serves it.</p>
        <ul class="sign-stats">
          <li><strong>${fmt(associations)}</strong><span>Associations</span></li>
          <li><strong>${fmt(banks)}</strong><span>District banks</span></li>
          <li><strong>${fmt(counties)}</strong><span>Counties chartered</span></li>
          <li><strong>${fmt(states)}</strong><span>States &amp; territories</span></li>
        </ul>
      </article>`;
  }
}

function listify(items) {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
}

function shortHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'website';
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
