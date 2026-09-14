/**
 * The signpost: details for the chosen territory, pinned top-right of the map.
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
      if (e.target.closest('[data-close]')) {
        this.hide();
        onClose?.();
      }
    });
  }

  /**
   * @param {object} a  association
   * @param {object} extra
   * @param {string} extra.gridRef   atlas square, e.g. "F7"
   * @param {string} extra.color     district colour
   * @param {object} extra.bank      the funding bank, if known
   * @param {boolean} extra.isNew    first time this territory has been found
   */
  show(a, { gridRef = '', color = '#b9a8d6', bank = null, isNew = false } = {}) {
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
      <article class="sign" style="--district:${esc(color)}">
        <button class="sign-close" type="button" data-close aria-label="Close">&times;</button>
        <p class="sign-eyebrow">
          <span class="sign-chip" aria-hidden="true"></span>
          <span>${esc(a.district)} District</span>
          ${gridRef ? `<span class="sign-ref" title="Atlas grid square">${esc(gridRef)}</span>` : ''}
        </p>
        <h2 class="sign-name">${esc(a.name)}</h2>
        ${isNew ? '<p class="sign-new">&#9733; New discovery</p>' : ''}
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
    this.root.hidden = false;
  }

  hide() {
    this.root.hidden = true;
    this.currentUninum = null;
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
