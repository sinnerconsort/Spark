/**
 * Spark — Scenario Hook & First Message Generator
 * Reads the character card + user persona, generates scenario hooks
 * that can be expanded into full first messages with POV control.
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
    include_examples: false,
    use_lexicon_lore: true,
    pov: 'second',
    first_msg_length: 3,
    guide: '',
    history: ''
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

    try {
        if (power_user?.persona_description) {
            description = power_user.persona_description;
        }
    } catch (e) {}

    if (!description) {
        const el = document.querySelector('#persona_description');
        if (el) description = el.value || el.textContent || '';
    }

    return {
        name: context.name1 || 'User',
        description: (description || '').substring(0, 2000)
    };
}

function buildCharBlock(charData) {
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
    return charBlock;
}

function buildPersonaBlock(personaData) {
    let personaBlock = `Name: ${personaData.name}`;
    if (extensionSettings.include_persona && personaData.description) {
        personaBlock += `\nDescription: ${personaData.description}`;
    }
    return personaBlock;
}

function buildCustomContext() {
    // Read live from DOM so unsaved edits are captured
    const guide = ($('#spark-guide-input').val() || extensionSettings.guide || '').trim();
    const history = ($('#spark-history-input').val() || extensionSettings.history || '').trim();
    let block = '';
    if (history) {
        block += `\nHISTORY BETWEEN THESE CHARACTERS:\n${history.substring(0, 3000)}\n`;
    }
    if (guide) {
        block += `\nUSER DIRECTION:\nThe user wants scenarios that focus on or involve the following: ${guide.substring(0, 1500)}\nWeight your suggestions toward this guidance.\n`;
    }
    return block;
}

// ═══════════════════════════════════════
//  LEXICON INTEGRATION
// ═══════════════════════════════════════

/**
 * Get lore context from Lexicon if available and enabled.
 * Returns formatted block for hook prompts (background + atmospheric hints).
 */
async function getLexiconLoreBlock() {
    if (!extensionSettings.use_lexicon_lore) return '';
    if (!window.LexiconAPI?.isActive?.()) return '';

    try {
        const block = await window.LexiconAPI.getLoreContextBlock(8);
        if (!block?.trim()) return '';
        return `\nWORLD LORE & ATMOSPHERE (use this to ground scenarios in the established world):\n${block}\n`;
    } catch (e) {
        console.warn('[Spark] Lexicon lore fetch failed:', e);
        return '';
    }
}

/**
 * Get hintable entries from Lexicon for first messages that plant early seeds.
 * Returns a prompt block instructing the AI to weave atmospheric hints.
 */
async function getLexiconSeedBlock() {
    if (!extensionSettings.use_lexicon_lore) return '';
    if (!window.LexiconAPI?.isActive?.()) return '';

    try {
        const hints = await window.LexiconAPI.getHintableEntries();
        if (!hints?.length) return '';

        // Pick up to 3 hintable entries to seed into the first message
        const selected = hints.slice(0, 3);
        const seedLines = selected.map(h =>
            h.hintText
                ? `- ${h.title}: ${h.hintText}`
                : `- Something about "${h.title}" lingers in the atmosphere...`
        ).join('\n');

        return `\nNARRATIVE SEEDS (weave 1-2 of these atmospheric details naturally into the scene — hint, don't explain):\n${seedLines}\n`;
    } catch (e) {
        console.warn('[Spark] Lexicon seed fetch failed:', e);
        return '';
    }
}

// ═══════════════════════════════════════
//  PROMPT BUILDING — HOOKS
// ═══════════════════════════════════════

async function buildHookPrompt(charData, personaData) {
    const count = extensionSettings.count || 4;
    const customContext = buildCustomContext();
    const loreBlock = await getLexiconLoreBlock();

    return `You are a creative scenario generator for roleplay. Given a character and a user persona, generate exactly ${count} unique scenario hooks — brief, evocative premises for scenes between them.

Each scenario should:
- Be 1-3 sentences maximum
- Suggest a specific situation, mood, or starting conflict
- Feel like a natural intersection of these two characters
- Vary in tone across the set (dramatic, casual, mysterious, tense, playful, etc.)
- Be self-contained enough to start a conversation from
${loreBlock ? '- Draw on the world lore provided — reference locations, factions, or atmospheric details where natural\n- For atmospheric/hint entries, reference them obliquely without explaining them' : ''}

CHARACTER:
${buildCharBlock(charData)}

USER PERSONA:
${buildPersonaBlock(personaData)}
${customContext}${loreBlock}Generate exactly ${count} scenario hooks. Format each on its own line, prefixed with a number and period (e.g. "1. ..."). Output ONLY the numbered list, nothing else.`;
}

// ═══════════════════════════════════════
//  PROMPT BUILDING — FIRST MESSAGE
// ═══════════════════════════════════════

function getPovInstruction() {
    const pov = extensionSettings.pov || 'second';
    const labels = {
        first: 'first person (I/me/my)',
        second: 'second person (you/your)',
        third: 'third person (he/she/they)'
    };
    return labels[pov] || labels.second;
}

async function buildFirstMessagePrompt(hook, charData, personaData) {
    const paragraphs = extensionSettings.first_msg_length || 3;
    const povLabel = getPovInstruction();
    const customContext = buildCustomContext();
    const loreBlock = await getLexiconLoreBlock();
    const seedBlock = await getLexiconSeedBlock();

    return `You are a skilled roleplay narrator writing the opening message for a scene. You are writing AS the character, not the user.

CRITICAL RULES:
- Write ONLY as ${charData.name}. You are narrating from the character's perspective and actions.
- NEVER write actions, dialogue, thoughts, or decisions for ${personaData.name} (the user's character).
- NEVER assume how ${personaData.name} feels, reacts, or responds.
- ${personaData.name}'s actions and words are controlled exclusively by the user.
- You may reference ${personaData.name}'s presence or describe the environment around them, but do not dictate their behavior.
- Use ${povLabel} perspective when referencing ${personaData.name} in the scene.

CHARACTER:
${buildCharBlock(charData)}

USER PERSONA:
${buildPersonaBlock(personaData)}
${customContext}${loreBlock}${seedBlock}
SCENARIO TO EXPAND:
${hook}

Write an opening message of approximately ${paragraphs} paragraph${paragraphs > 1 ? 's' : ''}. Set the scene, establish the mood, and write ${charData.name}'s initial actions/dialogue. End in a way that invites ${personaData.name} to respond. Output ONLY the first message, no preamble or meta-commentary.`;
}

// ═══════════════════════════════════════
//  GENERATION — HOOKS
// ═══════════════════════════════════════

async function generateSuggestions() {
    if (isGenerating) return;

    const charData = getCharacterData();
    if (!charData) {
        showEmptyState('Select a character first');
        return;
    }

    const personaData = getPersonaData();
    const prompt = await buildHookPrompt(charData, personaData);

    isGenerating = true;
    showLoadingState('Generating scenarios...');

    try {
        const response = await generateRaw(prompt, null, false, false);

        if (!response || typeof response !== 'string') {
            throw new Error('Empty response from API');
        }

        const suggestions = parseHookResponse(response);

        if (suggestions.length === 0) {
            throw new Error('Could not parse any suggestions');
        }

        currentSuggestions = suggestions;
        renderSuggestions(suggestions, charData.name);

    } catch (err) {
        console.error('[Spark] Generation failed:', err);
        showErrorState(err.message || 'Generation failed');
    } finally {
        isGenerating = false;
    }
}

// ═══════════════════════════════════════
//  GENERATION — FIRST MESSAGE
// ═══════════════════════════════════════

async function expandToFirstMessage(hookText, cardElement) {
    if (isGenerating) return;

    const charData = getCharacterData();
    if (!charData) return;
    const personaData = getPersonaData();

    const prompt = await buildFirstMessagePrompt(hookText, charData, personaData);

    isGenerating = true;

    const expandArea = cardElement.find('.spark-expand-area');
    expandArea.html(`
        <div class="spark-status spark-expand-loading">
            <i class="fa-solid fa-spinner fa-spin"></i>
            <span>Writing first message...</span>
        </div>
    `).slideDown(150);

    cardElement.find('.spark-expand').prop('disabled', true).css('opacity', '0.4');

    try {
        const response = await generateRaw(prompt, null, false, false);

        if (!response || typeof response !== 'string') {
            throw new Error('Empty response from API');
        }

        const cleaned = response.trim();

        expandArea.html(`
            <div class="spark-first-message">
                <div class="spark-first-message-text">${escapeHtml(cleaned).replace(/\n/g, '<br>')}</div>
                <div class="spark-first-message-actions">
                    <button class="spark-fm-copy menu_button menu_button_icon" title="Copy to clipboard">
                        <i class="fa-solid fa-copy"></i> Copy
                    </button>
                    <button class="spark-fm-paste menu_button menu_button_icon" title="Paste into chat input">
                        <i class="fa-solid fa-paste"></i> Paste
                    </button>
                    <button class="spark-fm-regen menu_button menu_button_icon" title="Regenerate">
                        <i class="fa-solid fa-rotate"></i>
                    </button>
                    <button class="spark-fm-close menu_button menu_button_icon" title="Collapse">
                        <i class="fa-solid fa-chevron-up"></i>
                    </button>
                </div>
            </div>
        `);

        expandArea.find('.spark-fm-copy').on('click', (e) => {
            e.stopPropagation();
            copyToClipboard(cleaned);
        });

        expandArea.find('.spark-fm-paste').on('click', (e) => {
            e.stopPropagation();
            pasteToInput(cleaned);
        });

        expandArea.find('.spark-fm-regen').on('click', (e) => {
            e.stopPropagation();
            expandToFirstMessage(hookText, cardElement);
        });

        expandArea.find('.spark-fm-close').on('click', (e) => {
            e.stopPropagation();
            expandArea.slideUp(150);
            cardElement.find('.spark-expand').prop('disabled', false).css('opacity', '1');
        });

    } catch (err) {
        console.error('[Spark] First message generation failed:', err);
        expandArea.html(`
            <div class="spark-status spark-error">
                <i class="fa-solid fa-triangle-exclamation"></i>
                <span>${escapeHtml(err.message || 'Generation failed')}</span>
            </div>
        `);
        cardElement.find('.spark-expand').prop('disabled', false).css('opacity', '1');
    } finally {
        isGenerating = false;
    }
}

// ═══════════════════════════════════════
//  PARSING
// ═══════════════════════════════════════

function parseHookResponse(text) {
    const suggestions = [];
    const lines = text.split('\n');

    for (const line of lines) {
        const match = line.match(/^\s*\d+[\.\)]\s*(.+)/);
        if (match && match[1].trim().length > 10) {
            suggestions.push(match[1].trim());
        }
    }

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
                    <button class="spark-expand menu_button menu_button_icon" title="Expand to first message">
                        <i class="fa-solid fa-wand-magic-sparkles"></i>
                    </button>
                    <button class="spark-copy menu_button menu_button_icon" title="Copy hook">
                        <i class="fa-solid fa-copy"></i>
                    </button>
                    <button class="spark-paste menu_button menu_button_icon" title="Paste hook">
                        <i class="fa-solid fa-paste"></i>
                    </button>
                </div>
                <div class="spark-expand-area" style="display: none;"></div>
            </div>
        `);

        card.find('.spark-expand').on('click', function (e) {
            e.stopPropagation();
            expandToFirstMessage(text, card);
        });

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

    $('#spark-subtitle').text(`for ${charName}`);
}

function showLoadingState(message) {
    const container = $('#spark-suggestions');
    container.html(`
        <div class="spark-status">
            <i class="fa-solid fa-spinner fa-spin"></i>
            <span>${escapeHtml(message || 'Generating...')}</span>
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
                    <button id="spark-refresh" class="menu_button menu_button_icon" title="Generate new hooks">
                        <i class="fa-solid fa-rotate"></i>
                    </button>
                    <button id="spark-close" class="menu_button menu_button_icon" title="Close">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
            </div>
            <div class="spark-pov-bar">
                <button class="spark-pov-btn ${extensionSettings.pov === 'first' ? 'active' : ''}" data-pov="first" title="First person (I/me)">1st</button>
                <button class="spark-pov-btn ${extensionSettings.pov === 'second' ? 'active' : ''}" data-pov="second" title="Second person (you/your)">2nd</button>
                <button class="spark-pov-btn ${extensionSettings.pov === 'third' ? 'active' : ''}" data-pov="third" title="Third person (he/she/they)">3rd</button>
                <div class="spark-length-control">
                    <i class="fa-solid fa-align-left" title="First message length"></i>
                    <input type="range" id="spark-length" min="1" max="5" value="${extensionSettings.first_msg_length}" step="1" title="Paragraphs">
                    <span id="spark-length-val">${extensionSettings.first_msg_length}¶</span>
                </div>
            </div>
            <div class="spark-custom-fields">
                <div class="spark-field-toggle" id="spark-toggle-guide">
                    <i class="fa-solid fa-compass"></i>
                    <span>Guide</span>
                    <i class="fa-solid fa-chevron-down spark-chevron"></i>
                </div>
                <div class="spark-field-body" id="spark-guide-body" style="display: none;">
                    <textarea id="spark-guide-input" class="spark-textarea" placeholder="Steer generation toward a specific theme, mood, or scenario type..." rows="2">${escapeHtml(extensionSettings.guide || '')}</textarea>
                </div>
                <div class="spark-field-toggle" id="spark-toggle-history">
                    <i class="fa-solid fa-clock-rotate-left"></i>
                    <span>History</span>
                    <i class="fa-solid fa-chevron-down spark-chevron"></i>
                </div>
                <div class="spark-field-body" id="spark-history-body" style="display: none;">
                    <textarea id="spark-history-input" class="spark-textarea" placeholder="What happened before? Backstory, last session, relationship context..." rows="3">${escapeHtml(extensionSettings.history || '')}</textarea>
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

    $('.spark-pov-btn').on('click', function () {
        const pov = $(this).data('pov');
        extensionSettings.pov = pov;
        saveSettings();
        $('.spark-pov-btn').removeClass('active');
        $(this).addClass('active');
    });

    $('#spark-length').on('input', function () {
        extensionSettings.first_msg_length = parseInt($(this).val());
        $('#spark-length-val').text(extensionSettings.first_msg_length + '¶');
        saveSettings();
    });

    // Guide/History collapsible toggles
    $('#spark-toggle-guide').on('click', function () {
        $('#spark-guide-body').slideToggle(150);
        $(this).find('.spark-chevron').toggleClass('spark-chevron-open');
    });

    $('#spark-toggle-history').on('click', function () {
        $('#spark-history-body').slideToggle(150);
        $(this).find('.spark-chevron').toggleClass('spark-chevron-open');
    });

    // Save on blur so we don't spam saves while typing
    $('#spark-guide-input').on('blur', function () {
        extensionSettings.guide = $(this).val();
        saveSettings();
    });

    $('#spark-history-input').on('blur', function () {
        extensionSettings.history = $(this).val();
        saveSettings();
    });
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

    const targets = ['#form_sheld', '#sheld', '#chat', 'body'];
    let attached = false;
    for (const selector of targets) {
        const target = $(selector);
        if (target.length) {
            target.append(fab);
            target.css('overflow', 'visible');
            attached = true;
            break;
        }
    }

    if (!attached) {
        $('body').append(fab);
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

    setInterval(() => {
        if (extensionSettings.enabled && !$('#spark-fab').length) {
            createFAB();
        }
    }, 3000);
}

function togglePanel(forceState) {
    const panel = $('#spark-panel');
    if (!panel.length) return;

    const isVisible = panel.is(':visible');
    const shouldShow = forceState !== undefined ? forceState : !isVisible;

    if (shouldShow) {
        if (window.innerWidth > 1000) {
            const fab = $('#spark-fab');
            if (fab.length) {
                const fabRight = parseInt(fab.css('right')) || 20;
                const fabBottom = parseInt(fab.css('bottom')) || 80;
                panel.css({
                    right: fabRight + 'px',
                    bottom: (fabBottom + 50) + 'px'
                });
            }
        } else {
            panel.css({ right: '', left: '', bottom: '' });
        }
        panel.fadeIn(150);
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
                <hr>
                <div class="spark-settings-group">
                    <small><b>Lexicon Integration:</b></small>
                    <label class="checkbox_label">
                        <input type="checkbox" id="spark-use-lexicon" ${extensionSettings.use_lexicon_lore ? 'checked' : ''}>
                        <span>Use Lexicon lore in prompts</span>
                    </label>
                    <small style="opacity:0.6;display:block;margin-top:2px;">When Lexicon is active, hooks draw on your world lore and first messages plant narrative seeds.</small>
                </div>
            </div>
        </div>
    `;

    $('#extensions_settings2').append(settingsHtml);

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

    $('#spark-use-lexicon').on('change', function () {
        extensionSettings.use_lexicon_lore = $(this).prop('checked');
        saveSettings();
        if (this.checked && !window.LexiconAPI?.isActive?.()) {
            toastr.warning('Lexicon is not active — enable it in Extensions first', 'Spark', { timeOut: 4000 });
        }
    });
}

// ═══════════════════════════════════════
//  EVENTS
// ═══════════════════════════════════════

function registerEvents() {
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
