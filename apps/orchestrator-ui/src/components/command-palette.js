import { escapeHtml } from '../lib/format.js';

export function createCommandPalette(dom, callbacks) {
  const state = {
    open: false,
    items: [],
    activeIndex: 0,
  };

  function render() {
    const query = String(dom.paletteInput.value ?? '').trim().toLowerCase();
    const filtered = state.items.filter((item) =>
      [item.title, item.subtitle || ''].join(' ').toLowerCase().includes(query),
    );

    if (state.activeIndex >= filtered.length) {
      state.activeIndex = 0;
    }

    dom.paletteList.innerHTML =
      filtered.length === 0
        ? '<li class="palette-item"><strong>No commands</strong></li>'
        : filtered
            .map(
              (item, index) => `
            <li class="palette-item" data-index="${index}" data-active="${index === state.activeIndex}">
              <strong>${escapeHtml(item.title)}</strong>
              <small>${escapeHtml(item.subtitle || '')}</small>
            </li>
          `,
            )
            .join('');

    dom.paletteList.querySelectorAll('.palette-item[data-index]').forEach((node) => {
      node.addEventListener('click', () => {
        const index = Number(node.getAttribute('data-index'));
        const target = filtered[index];
        if (target) {
          target.run();
          close();
        }
      });
    });

    return filtered;
  }

  function open(items) {
    state.items = items;
    state.activeIndex = 0;
    state.open = true;
    dom.palette.hidden = false;
    dom.paletteInput.value = '';
    render();
    dom.paletteInput.focus();
  }

  function close() {
    state.open = false;
    dom.palette.hidden = true;
  }

  function handleKeyDown(event) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (state.open) {
        close();
      } else {
        open(callbacks.getItems());
      }
      return;
    }

    if (!state.open) {
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }

    const filtered = render();

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      state.activeIndex = Math.min(filtered.length - 1, state.activeIndex + 1);
      render();
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      state.activeIndex = Math.max(0, state.activeIndex - 1);
      render();
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      const selected = filtered[state.activeIndex];
      if (selected) {
        selected.run();
        close();
      }
    }
  }

  dom.paletteInput.addEventListener('input', () => {
    render();
  });

  dom.palette.addEventListener('click', (event) => {
    if (event.target === dom.palette) {
      close();
    }
  });

  document.addEventListener('keydown', handleKeyDown);

  return {
    open,
    close,
  };
}
