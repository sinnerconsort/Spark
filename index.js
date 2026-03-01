/**
 * Spark — Scenario Hook Generator
 * Reads the character card + user persona, generates quick scenario premises.
 * Works before/outside of active chats.
 */
import {
    getContext,
    extension_settings
} from '../../../extensions.js';

import {
    eventSource,
    event_types,
    saveSettingsDebounced,
    generateRaw
} from '../../../../script.js';

import { power_user } from '../../../power-user.js';

const extensionName = 'Spark';
const DEBUG = false;

// ─── Default Settings ───
const defaultSettings = {
    enabled: true,
    count: 4,
    include_description: true,
    include_scenario: true,
    include_personality: true,
    include_persona: true,
    include_examples: false
};

let extensionSettings = { ...defaultSettings };
let isGenerating = false;
let currentSuggestions = [];

// ═══════════════════════════════════════
//  SETTINGS
// ═══════════════════════════════════════

function loadSettings() {
    const context = getContext();
    if (!context.extensionSettings[extensionName]) {
        context.extensionSettings[extensionName] = { ...defaultSettings };
    }
    extensionSettings = context.extensionSettings[extensionName];
    // Backfill any missing keys
    for (const [key, val] of Object.entries(defaultSettings)) {
        if (extensionSettings[key] === undefined) extensionSettings[key] = val;
    }
}

function saveSettings() {
    const context = getContext();
    context.extensionSettings[extensionName] = extensionSettings;
    saveSettingsDebounced();
}

// ═══════════════════════════════════════
//  DATA EXTRACTION
// ═══════════════════════════════════════

function getCharacterData() {
    const context = getContext();
    const charId = context.characterId;
    if (charId === undefined || charId === null) return null;
    const char = context.characters?.[charId];
    if (!char) return null;

    return {
        name: char.name || 'Unknown',
        description: (char.data?.description || char.description || '').substring(0, 3000),
        personality: (char.data?.personality || char.personality || '').substring(0, 1500),
        scenario: (char.data?.scenario || char.scenario || '').substring(0, 1500),
        first_mes: (char.data?.first_mes || char.first_mes || '').substring(0, 1000),
        mes_example: (char.data?.mes_example || char.mes_example || '').substring(0, 1500)
    };
}

function getPersonaData() {
    const context = getContext();
    let description = '';

    // Try multiple sources for persona description
    try {
        if (power_user?.persona_description) {
            description = power_user.persona_description;
        }
    } catch (e) { /* power_user not available */ }

    // Fallback: try DOM
    if (!description) {
        const el = document.querySelector('#persona_description');
        if (el) description = el.value || el.textContent || '';
    }

    return {
        name: context.name1 || 'User',
        description: (description || '').substring(0, 2000)
    };
}

// ═══════════════════════════════════════
//  PROMPT BUILDING
// ═══════════════════════════════════════

function buildPrompt(charData, personaData) {
    const count = extensionSettings.count || 4;

    let charBlock = `Name: ${charData.name}`;
    if (extensionSettings.include_description && charData.description) {
        charBlock += `\nDescription: ${charData.description}`;
    }
    if (extensionSettings.include_personality && charData.personality) {
        charBlock += `\nPersonality: ${charData.personality}`;
    }
    if (extensionSettings.include_scenario && charData.scenario) {
        charBlock += `\nScenario: ${charData.scenario}`;
    }
    if (extensionSettings.include_examples && charData.mes_example) {
        charBlock += `\nExample dialogue:\n${charData.mes_example}`;
    }

    let personaBlock = `Name: ${personaData.name}`;
    if (extensionSettings.include_persona && personaData.description) {
        personaBlock += `\nDescription: ${personaData.description}`;
    }

    return `You are a creative scenario generator for roleplay. Given a character and a user persona, generate exactly ${count} unique scenario hooks — brief, evocative premises for scenes between them.

Each scenario should:
- Be 1-3 sentences maximum
- Suggest a specific situation, mood, or starting conflict
- Feel like a natural intersection of these two characters
- Vary in tone across the set (dramatic, casual, mysterious, tense, playful, etc.)
- Be self-contained enough to start a conversation from

CHARACTER:
${charBlock}

USER PERSONA:
${personaBlock}

Generate exactly ${count} scenario hooks. Format each on its own line, prefixed with a number and period (e.g. "1. ..."). Output ONLY the numbered list, nothing else.`;
}

// ═══════════════════════════════════════
//  GENERATION
// ═══════════════════════════════════════

async function generateSuggestions() {
    if (isGenerating) return;

    const charData = getCharacterData();
    if (!charData) {
        showEmptyState('Select a character first');
        return;
    }

    const personaData = getPersonaData();
    const prompt = buildPrompt(charData, personaData);

    isGenerating = true;
    showLoadingState();

    try {
        if (DEBUG) toastr.info('Generating scenarios...', 'Spark');

        const response = await generateRaw(prompt, null, false, false);

        if (!response || typeof response !== 'string') {
            throw new Error('Empty response from API');
        }

        const suggestions = parseResponse(response);

        if (suggestions.length === 0) {
            throw new Error('Could not parse any suggestions');
        }

        currentSuggestions = suggestions;
        renderSuggestions(suggestions, charData.name);

    } catch (err) {
        console.error('[Spark] Generation failed:', err);
        showErrorState(err.message || 'Generation failed');
        if (DEBUG) toastr.error(err.message, 'Spark Error');
    } finally {
        isGenerating = false;
    }
}

// ═══════════════════════════════════════
//  PARSING
// ═══════════════════════════════════════

function parseResponse(text) {
    const suggestions = [];
    // Match numbered lines: "1. text", "2. text", etc.
    const lines = text.split('\n');

    for (const line of lines) {
        const match = line.match(/^\s*\d+[\.\)]\s*(.+)/);
        if (match && match[1].trim().length > 10) {
            suggestions.push(match[1].trim());
        }
    }

    // Fallback: if no numbered lines found, split by double newlines
    if (suggestions.length === 0) {
        const blocks = text.split(/\n{2,}/).map(b => b.trim()).filter(b => b.length > 10);
        suggestions.push(...blocks);
    }

    return suggestions;
}

// ═══════════════════════════════════════
//  UI RENDERING
// ═══════════════════════════════════════

function renderSuggestions(suggestions, charName) {
    const container = $('#spark-suggestions');
    container.empty();

    suggestions.forEach((text, i) => {
        const card = $(`
            <div class="spark-card" data-index="${i}">
                <div class="spark-card-text">${escapeHtml(text)}</div>
                <div class="spark-card-actions">
                    <button class="spark-copy menu_button menu_button_icon" title="Copy to clipboard">
                        <i class="fa-solid fa-copy"></i>
                    </button>
                    <button class="spark-paste menu_button menu_button_icon" title="Paste into chat input">
                        <i class="fa-solid fa-paste"></i>
                    </button>
                </div>
            </div>
        `);

        card.find('.spark-copy').on('click', function (e) {
            e.stopPropagation();
            copyToClipboard(text);
        });

        card.find('.spark-paste').on('click', function (e) {
            e.stopPropagation();
            pasteToInput(text);
        });

        container.append(card);
    });

    // Update header subtitle
    $('#spark-subtitle').text(`for ${charName}`);
}

function showLoadingState() {
    const container = $('#spark-suggestions');
    container.html(`
        <div class="spark-status">
            <i class="fa-solid fa-spinner fa-spin"></i>
            <span>Generating scenarios...</span>
        </div>
    `);
    $('#spark-subtitle').text('thinking...');
}

function showEmptyState(message) {
    const container = $('#spark-suggestions');
    container.html(`
        <div class="spark-status">
            <i class="fa-solid fa-bolt"></i>
            <span>${escapeHtml(message)}</span>
        </div>
    `);
    $('#spark-subtitle').text('');
}

function showErrorState(message) {
    const container = $('#spark-suggestions');
    container.html(`
        <div class="spark-status spark-error">
            <i class="fa-solid fa-triangle-exclamation"></i>
            <span>${escapeHtml(message)}</span>
        </div>
    `);
    $('#spark-subtitle').text('error');
}

// ═══════════════════════════════════════
//  ACTIONS
// ═══════════════════════════════════════

function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
        toastr.success('Copied!', 'Spark', { timeOut: 1500 });
    }).catch(() => {
        // Fallback
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        toastr.success('Copied!', 'Spark', { timeOut: 1500 });
    });
}

function pasteToInput(text) {
    const textarea = $('#send_textarea');
    if (!textarea.length) {
        toastr.warning('No chat input found — open a chat first', 'Spark');
        return;
    }
    textarea.val(text);
    textarea.trigger('input');
    // Resize
    const el = textarea[0];
    if (el) {
        el.style.height = 'auto';
        el.style.height = el.scrollHeight + 'px';
        el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    toastr.success('Pasted to input!', 'Spark', { timeOut: 1500 });
}

// ═══════════════════════════════════════
//  UI CREATION
// ═══════════════════════════════════════

function createPanel() {
    if ($('#spark-panel').length) return;

    const panelHtml = `
        <div id="spark-panel" class="spark-panel" style="display: none;">
            <div class="spark-header">
                <div class="spark-title-row">
                    <span class="spark-title">⚡ Spark</span>
                    <span id="spark-subtitle" class="spark-subtitle"></span>
                </div>
                <div class="spark-header-actions">
                    <button id="spark-refresh" class="menu_button menu_button_icon" title="Generate new scenarios">
                        <i class="fa-solid fa-rotate"></i>
                    </button>
                    <button id="spark-close" class="menu_button menu_button_icon" title="Close">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
            </div>
            <div id="spark-suggestions" class="spark-suggestions">
                <div class="spark-status">
                    <i class="fa-solid fa-bolt"></i>
                    <span>Select a character and hit refresh</span>
                </div>
            </div>
        </div>
    `;

    // Attach to same parent as FAB
    const targets = ['#form_sheld', '#sheld', '#chat', 'body'];
    for (const selector of targets) {
        const target = $(selector);
        if (target.length) {
            target.append(panelHtml);
            break;
        }
    }

    $('#spark-close').on('click', () => togglePanel(false));
    $('#spark-refresh').on('click', generateSuggestions);
}

function createFAB() {
    if ($('#spark-fab').length) return;

    try { localStorage.removeItem('spark-fab-pos'); } catch(e) {}

    const fab = $('<button>', {
        id: 'spark-fab',
        title: 'Spark — Scenario Ideas',
        html: '<i class="fa-solid fa-bolt" style="color:#f0c040;pointer-events:none;"></i>'
    }).css({
        position: 'fixed',
        bottom: '75px',
        right: '15px',
        width: '44px',
        height: '44px',
        borderRadius: '50%',
        border: '1px solid var(--SmartThemeBorderColor, #555)',
        background: 'var(--SmartThemeBlurTintColor, #1a1a2e)',
        color: '#ccc',
        fontSize: '18px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        zIndex: '31000',
        boxShadow: '0 2px 12px rgba(0,0,0,0.4)',
        padding: '0',
        margin: '0',
        pointerEvents: 'auto',
        overflow: 'visible'
    });

    // Try multiple attachment points — use whichever exists
    const targets = ['#form_sheld', '#sheld', '#chat', 'body'];
    let attached = false;
    for (const selector of targets) {
        const target = $(selector);
        if (target.length) {
            target.append(fab);
            // Force overflow visible on parent so FAB isn't clipped
            target.css('overflow', 'visible');
            console.log(`[Spark] FAB attached to ${selector}`);
            attached = true;
            break;
        }
    }

    if (!attached) {
        $('body').append(fab);
        console.log('[Spark] FAB fallback to body');
    }

    let isDragging = false;
    let wasDragged = false;
    let startX, startY, startRight, startBottom;

    fab.on('click', (e) => {
        if (wasDragged) {
            wasDragged = false;
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        togglePanel();
    });

    fab[0].addEventListener('touchstart', (e) => {
        isDragging = true;
        wasDragged = false;
        const touch = e.touches[0];
        startX = touch.clientX;
        startY = touch.clientY;
        const rect = fab[0].getBoundingClientRect();
        startRight = window.innerWidth - rect.right;
        startBottom = window.innerHeight - rect.bottom;
    }, { passive: true });

    fab[0].addEventListener('touchmove', (e) => {
        if (!isDragging) return;
        const touch = e.touches[0];
        const dx = touch.clientX - startX;
        const dy = touch.clientY - startY;
        if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
            wasDragged = true;
            e.preventDefault();
            const newRight = Math.max(4, startRight - dx);
            const newBottom = Math.max(4, startBottom - dy);
            fab.css({ right: newRight + 'px', bottom: newBottom + 'px' });
        }
    }, { passive: false });

    fab[0].addEventListener('touchend', () => {
        isDragging = false;
        try {
            localStorage.setItem('spark-fab-pos', JSON.stringify({
                right: parseInt(fab.css('right')),
                bottom: parseInt(fab.css('bottom'))
            }));
        } catch (e) {}
    }, { passive: true });

    // Watchdog
    setInterval(() => {
        if (extensionSettings.enabled && !$('#spark-fab').length) {
            console.log('[Spark] FAB was removed, re-creating...');
            createFAB();
        }
    }, 3000);
}

function togglePanel(forceState) {
    const panel = $('#spark-panel');
    if (!panel.length) {
        toastr.error('Panel not found in DOM!', 'Spark Debug');
        return;
    }

    const isVisible = panel.is(':visible');
    const shouldShow = forceState !== undefined ? forceState : !isVisible;

    if (shouldShow) {
        // Position panel above FAB
        const fab = $('#spark-fab');
        if (fab.length) {
            const fabRight = parseInt(fab.css('right')) || 20;
            const fabBottom = parseInt(fab.css('bottom')) || 80;
            panel.css({
                right: fabRight + 'px',
                bottom: (fabBottom + 50) + 'px'
            });
        }
        panel.fadeIn(150);
        // Auto-generate if empty and character is selected
        if (currentSuggestions.length === 0 && getCharacterData()) {
            generateSuggestions();
        }
    } else {
        panel.fadeOut(150);
    }
}

function addSettingsPanel() {
    const settingsHtml = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>⚡ Spark</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label">
                    <input type="checkbox" id="spark-enabled" ${extensionSettings.enabled ? 'checked' : ''}>
                    <span>Enable</span>
                </label>
                <hr>
                <label for="spark-count"><small>Scenarios per generation</small></label>
                <input type="range" id="spark-count" min="2" max="6" value="${extensionSettings.count}" step="1">
                <span id="spark-count-val">${extensionSettings.count}</span>
                <hr>
                <div class="spark-settings-group">
                    <small><b>Include in prompt:</b></small>
                    <label class="checkbox_label">
                        <input type="checkbox" id="spark-inc-desc" ${extensionSettings.include_description ? 'checked' : ''}>
                        <span>Character description</span>
                    </label>
                    <label class="checkbox_label">
                        <input type="checkbox" id="spark-inc-personality" ${extensionSettings.include_personality ? 'checked' : ''}>
                        <span>Character personality</span>
                    </label>
                    <label class="checkbox_label">
                        <input type="checkbox" id="spark-inc-scenario" ${extensionSettings.include_scenario ? 'checked' : ''}>
                        <span>Character scenario</span>
                    </label>
                    <label class="checkbox_label">
                        <input type="checkbox" id="spark-inc-examples" ${extensionSettings.include_examples ? 'checked' : ''}>
                        <span>Example messages</span>
                    </label>
                    <label class="checkbox_label">
                        <input type="checkbox" id="spark-inc-persona" ${extensionSettings.include_persona ? 'checked' : ''}>
                        <span>User persona</span>
                    </label>
                </div>
            </div>
        </div>
    `;

    $('#extensions_settings2').append(settingsHtml);

    // Wire up settings
    $('#spark-enabled').on('change', function () {
        extensionSettings.enabled = $(this).prop('checked');
        saveSettings();
        if (extensionSettings.enabled) {
            createFAB();
            createPanel();
        } else {
            $('#spark-fab').remove();
            $('#spark-panel').remove();
        }
    });

    $('#spark-count').on('input', function () {
        extensionSettings.count = parseInt($(this).val());
        $('#spark-count-val').text(extensionSettings.count);
        saveSettings();
    });

    const checkboxMap = {
        'spark-inc-desc': 'include_description',
        'spark-inc-personality': 'include_personality',
        'spark-inc-scenario': 'include_scenario',
        'spark-inc-examples': 'include_examples',
        'spark-inc-persona': 'include_persona'
    };

    for (const [id, key] of Object.entries(checkboxMap)) {
        $(`#${id}`).on('change', function () {
            extensionSettings[key] = $(this).prop('checked');
            saveSettings();
        });
    }
}

// ═══════════════════════════════════════
//  EVENTS
// ═══════════════════════════════════════

function registerEvents() {
    // Clear suggestions when character changes so it auto-refreshes on next open
    eventSource.on(event_types.CHAT_CHANGED, () => {
        currentSuggestions = [];
        if ($('#spark-panel').is(':visible')) {
            const charData = getCharacterData();
            if (charData) {
                generateSuggestions();
            } else {
                showEmptyState('Select a character first');
            }
        }
    });
}

// ═══════════════════════════════════════
//  UTILS
// ═══════════════════════════════════════

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ═══════════════════════════════════════
//  INIT
// ═══════════════════════════════════════

jQuery(async () => {
    try {
        console.log('[Spark] Initializing...');
        loadSettings();
        addSettingsPanel();

        if (extensionSettings.enabled) {
            createFAB();
            createPanel();
            registerEvents();
        }

        console.log('[Spark] ⚡ Ready');
    } catch (error) {
        console.error('[Spark] Init failed:', error);
        toastr.error('Spark failed to initialize', 'Spark');
    }
});
