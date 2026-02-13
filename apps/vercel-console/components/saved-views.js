/**
 * Saved Views component.
 *
 * Renders a dropdown panel for managing saved board filter presets:
 * - Select a saved view to apply its filters
 * - Save the current filter state as a named preset
 * - Delete saved views
 * - Visual indicator showing which saved view (if any) is active
 * - "Reset filters" button to return to defaults
 */

import { escapeHtml } from '../lib/format.js';
import {
  addSavedView,
  deleteSavedView,
  filtersEqual,
  getDefaultFilters,
  loadSavedViews,
  pushFilterState,
} from '../lib/filter-persistence.js';

/**
 * Create the saved views component and attach it to the DOM.
 *
 * @param {object} options
 * @param {HTMLElement} options.container  - element where the component renders
 * @param {() => object} options.getFilters - returns current filter state
 * @param {(filters: object) => void} options.onApply - called when user applies a view
 * @param {() => void} options.onReset - called when user clicks reset
 * @returns {{ render: () => void, destroy: () => void }}
 */
export function createSavedViewsPanel({ container, getFilters, onApply, onReset }) {
  let dropdownOpen = false;

  function getActiveViewId() {
    const currentFilters = getFilters();
    const views = loadSavedViews();
    const match = views.find((view) => filtersEqual(view.filters, currentFilters));
    return match?.id ?? null;
  }

  function render() {
    const views = loadSavedViews();
    const activeViewId = getActiveViewId();
    const activeView = views.find((v) => v.id === activeViewId);
    const currentFilters = getFilters();
    const defaults = getDefaultFilters();
    const isDefault = filtersEqual(currentFilters, defaults);

    const activeLabel = activeView ? escapeHtml(activeView.name) : 'Saved Views';
    const indicatorClass = activeView ? ' saved-views-active' : '';

    const viewItems = views
      .map(
        (view) => `
      <li class="saved-view-item${view.id === activeViewId ? ' active' : ''}" data-view-id="${escapeHtml(view.id)}">
        <button type="button" class="saved-view-apply" data-view-id="${escapeHtml(view.id)}">
          ${escapeHtml(view.name)}
        </button>
        <button type="button" class="saved-view-delete btn-ghost" data-delete-id="${escapeHtml(view.id)}" title="Delete view">
          &times;
        </button>
      </li>`,
      )
      .join('');

    container.innerHTML = `
      <div class="saved-views-wrap">
        <button type="button" class="saved-views-trigger btn-ghost${indicatorClass}" id="savedViewsTrigger">
          ${activeLabel} &#9662;
        </button>
        <div class="saved-views-dropdown${dropdownOpen ? '' : ' hidden'}" id="savedViewsDropdown">
          <div class="saved-views-header">
            <strong>Saved Views</strong>
          </div>
          ${
            views.length === 0
              ? '<div class="saved-views-empty">No saved views yet.</div>'
              : `<ul class="saved-views-list">${viewItems}</ul>`
          }
          <div class="saved-views-actions">
            <button type="button" class="btn-primary saved-views-save" id="savedViewsSave">
              Save Current
            </button>
            <button type="button" class="btn-ghost saved-views-reset" id="savedViewsReset" ${isDefault ? 'disabled' : ''}>
              Reset Filters
            </button>
          </div>
        </div>
      </div>
    `;

    bindEvents();
  }

  function bindEvents() {
    const trigger = container.querySelector('#savedViewsTrigger');
    if (trigger) {
      trigger.addEventListener('click', (event) => {
        event.stopPropagation();
        dropdownOpen = !dropdownOpen;
        render();
      });
    }

    container.querySelectorAll('.saved-view-apply').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const viewId = button.getAttribute('data-view-id');
        if (!viewId) {
          return;
        }
        const views = loadSavedViews();
        const target = views.find((v) => v.id === viewId);
        if (target) {
          onApply({ ...target.filters });
          pushFilterState(target.filters);
          dropdownOpen = false;
          render();
        }
      });
    });

    container.querySelectorAll('.saved-view-delete').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const deleteId = button.getAttribute('data-delete-id');
        if (deleteId) {
          deleteSavedView(deleteId);
          render();
        }
      });
    });

    const saveButton = container.querySelector('#savedViewsSave');
    if (saveButton) {
      saveButton.addEventListener('click', (event) => {
        event.stopPropagation();
        const name = window.prompt('Name this view:');
        if (!name?.trim()) {
          return;
        }
        addSavedView(name.trim(), getFilters());
        render();
      });
    }

    const resetButton = container.querySelector('#savedViewsReset');
    if (resetButton) {
      resetButton.addEventListener('click', (event) => {
        event.stopPropagation();
        dropdownOpen = false;
        onReset();
        render();
      });
    }
  }

  function handleDocumentClick() {
    if (dropdownOpen) {
      dropdownOpen = false;
      render();
    }
  }

  document.addEventListener('click', handleDocumentClick);

  function destroy() {
    document.removeEventListener('click', handleDocumentClick);
    container.innerHTML = '';
  }

  return { render, destroy };
}
